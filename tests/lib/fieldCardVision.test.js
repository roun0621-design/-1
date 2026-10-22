/**
 * lib/fieldCardVision.js — 사진 → Claude 전사 모듈 단위 테스트 (실제 API 호출 없음, 가짜 클라이언트 주입)
 *
 * 고정하는 것:
 *  - 이미지 준비: 지원 형식 검사, 긴 변 2576px 초과 시 JPEG 축소
 *  - 요청 형태: 기본 모델, 구조화 출력(json_schema), 서버측 폴백 + 베타 헤더, 이미지 블록, 힌트
 *  - 폴백 관련 400 → 폴백 없이 1회 재시도 / refusal·max_tokens·JSON 오류 → 코드 있는 오류
 *  - 픽스처 모드(NODE_ENV=test + FIELD_CARD_TRANSCRIBE_FIXTURE) / 테스트 환경 실호출 차단
 *  - 카드 JSON → 기록/풍속/높이 시트 → 기존 파서로 다시 읽힘, 불확실 셀 주석
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCanvas } = require('canvas');
const vision = require('../../lib/fieldCardVision');
const fc = require('../../lib/fieldCardImport');

function pngOf(w, h) {
    const cv = createCanvas(w, h); const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ctx.fillStyle = '#000'; ctx.fillRect(5, 5, Math.floor(w / 2), Math.floor(h / 2));
    return cv.toBuffer('image/png');
}
const CARDS = { cards: [{
    kind: 'distance', division: '여자 일반부', event: '창던지기', round: '결승', heat: '1', bar_heights: [], notes: '',
    athletes: [
        { order: '1', bib: '53', name: '이금희', team: '부천시청', attempts: ['36.20', '33.43', '35.68', '34.70', '38.03', '33.60'], winds: [], marks: [], best: '38.03', rank: '2', status: '', remark: '', uncertain: ['3차'] },
        { order: '6', bib: '57', name: '박보경', team: '성남시청', attempts: ['46.24', '50.45', 'X', '53.20', '50.19', 'X'], winds: [], marks: [], best: '53.20', rank: '1', status: '', remark: '', uncertain: [] },
    ],
}] };
const okResponse = (obj = CARDS) => ({ stop_reason: 'end_turn', model: 'claude-opus-5', content: [{ type: 'text', text: JSON.stringify(obj) }], usage: { input_tokens: 1200, output_tokens: 300 } });
const fakeClient = (handler) => ({ beta: { messages: { create: handler } } });
const oneImage = () => [{ buffer: pngOf(120, 80), mimetype: 'image/png', name: 'card.png' }];

describe('prepareImage', () => {
    it('작은 PNG 는 그대로, 큰 이미지는 긴 변 2576px JPEG 로 축소', async () => {
        const small = await vision.prepareImage(pngOf(200, 100), 'image/png', 'a.png');
        expect(small.media_type).toBe('image/png');
        expect(small.resized).toBe(false);
        expect(small.width).toBe(200);
        const big = await vision.prepareImage(pngOf(4000, 3000), 'image/png', 'b.png');
        expect(big.resized).toBe(true);
        expect(big.media_type).toBe('image/jpeg');
        expect(Math.max(big.width, big.height)).toBe(2576);
        expect(Buffer.from(big.data, 'base64').length).toBe(big.bytes);
    });
    it('mimetype 이 비어도 확장자로 판정, 지원하지 않는 형식은 BAD_IMAGE', async () => {
        const byExt = await vision.prepareImage(pngOf(50, 50), '', 'x.PNG');
        expect(byExt.media_type).toBe('image/png');
        await expect(vision.prepareImage(Buffer.from('x'), 'image/heic', 'a.heic')).rejects.toMatchObject({ code: 'BAD_IMAGE' });
    });
});

describe('transcribeCards — 가짜 클라이언트', () => {
    it('요청 형태: 기본 모델·구조화 출력·서버측 폴백·이미지 블록·힌트, 응답 파싱·비용', async () => {
        let captured = null;
        const client = fakeClient(async (params) => { captured = params; return okResponse(); });
        const t = await vision.transcribeCards({ images: oneImage(), hint: '여자 창던지기 결승', client });
        expect(captured.model).toBe('claude-opus-5');
        expect(captured.max_tokens).toBe(16000);
        expect(captured.system).toBe(vision.SYSTEM_PROMPT);
        expect(captured.output_config.format.type).toBe('json_schema');
        expect(captured.output_config.format.schema).toBe(vision.TRANSCRIPTION_SCHEMA);
        expect(captured.fallbacks).toBe('default');
        expect(captured.betas).toEqual(['server-side-fallback-2026-07-01']);
        expect(captured.thinking).toBeUndefined();          // Opus 5: 생략 = adaptive
        const content = captured.messages[0].content;
        expect(content.filter(b => b.type === 'image').length).toBe(1);
        expect(content.find(b => b.type === 'image').source).toMatchObject({ type: 'base64', media_type: 'image/png' });
        expect(content[content.length - 1].text).toContain('여자 창던지기 결승');
        expect(t.cards.length).toBe(1);
        expect(t.model).toBe('claude-opus-5');
        expect(t.usage.input_tokens).toBe(1200);
        expect(t.cost_usd).toBe(Math.round((1200 * 5 + 300 * 25) / 1e6 * 1000) / 1000);   // 소수 셋째 자리 반올림
        expect(t.images[0]).toMatchObject({ name: 'card.png', media_type: 'image/png', resized: false });
    });
    it('FIELD_CARD_MODEL / 인자 model 로 모델 교체', async () => {
        let captured = null;
        const client = fakeClient(async (params) => { captured = params; return okResponse(); });
        await vision.transcribeCards({ images: oneImage(), client, model: 'claude-sonnet-5' });
        expect(captured.model).toBe('claude-sonnet-5');
    });
    it('폴백 관련 400 이면 폴백 없이 1회 재시도', async () => {
        let n = 0;
        const client = fakeClient(async (params) => {
            n++;
            if (params.fallbacks) { const e = new Error('fallbacks is not available for this organization'); e.status = 400; throw e; }
            expect(params.betas).toBeUndefined();
            return okResponse();
        });
        const t = await vision.transcribeCards({ images: oneImage(), client });
        expect(n).toBe(2);
        expect(t.cards.length).toBe(1);
    });
    it('다른 400 은 그대로 throw', async () => {
        const client = fakeClient(async () => { const e = new Error('invalid_request'); e.status = 400; throw e; });
        await expect(vision.transcribeCards({ images: oneImage(), client })).rejects.toMatchObject({ status: 400 });
    });
    it('refusal / max_tokens / 잘못된 JSON 은 코드 있는 오류', async () => {
        const refuse = fakeClient(async () => ({ stop_reason: 'refusal', stop_details: { category: 'x' }, content: [], usage: {} }));
        await expect(vision.transcribeCards({ images: oneImage(), client: refuse })).rejects.toMatchObject({ code: 'REFUSAL' });
        const trunc = fakeClient(async () => ({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{' }], usage: {} }));
        await expect(vision.transcribeCards({ images: oneImage(), client: trunc })).rejects.toMatchObject({ code: 'TRUNCATED' });
        const bad = fakeClient(async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }], usage: {} }));
        await expect(vision.transcribeCards({ images: oneImage(), client: bad })).rejects.toMatchObject({ code: 'BAD_JSON' });
    });
    it('사진 0장 / 5장 은 BAD_IMAGE', async () => {
        await expect(vision.transcribeCards({ images: [], client: fakeClient(async () => okResponse()) })).rejects.toMatchObject({ code: 'BAD_IMAGE' });
        const five = Array.from({ length: 5 }, () => oneImage()[0]);
        await expect(vision.transcribeCards({ images: five, client: fakeClient(async () => okResponse()) })).rejects.toMatchObject({ code: 'BAD_IMAGE' });
    });
    it('테스트 환경에서는 실제 클라이언트 호출이 차단된다 (키가 있어도)', async () => {
        const saved = process.env.ANTHROPIC_API_KEY;
        process.env.ANTHROPIC_API_KEY = 'sk-ant-test-dummy';
        delete process.env.FIELD_CARD_TRANSCRIBE_FIXTURE;
        try {
            await expect(vision.transcribeCards({ images: oneImage() })).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
        } finally { if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved; }
    });
    it('픽스처 모드: API 없이 파일 내용을 반환', async () => {
        const fx = path.join(os.tmpdir(), `fc_fixture_${Date.now()}.json`);
        fs.writeFileSync(fx, JSON.stringify({ cards: CARDS.cards, usage: { input_tokens: 1, output_tokens: 2 } }));
        process.env.FIELD_CARD_TRANSCRIBE_FIXTURE = fx;
        try {
            const t = await vision.transcribeCards({ images: oneImage() });
            expect(t.fixture).toBe(true);
            expect(t.model).toBe('fixture');
            expect(t.cards.length).toBe(1);
        } finally { delete process.env.FIELD_CARD_TRANSCRIBE_FIXTURE; fs.unlinkSync(fx); }
    });
});

describe('cardsToSheets / cardsToWorkbookBuffer / cardsToAnnotations', () => {
    it('distance(풍속 포함) + height 카드 → 기록/풍속/높이 시트, 파서로 그대로 읽힘', () => {
        const cards = [
            { kind: 'distance', division: '여자 일반부', event: '멀리뛰기', round: '결승', heat: '1', bar_heights: [], notes: '', athletes: [
                { order: '1', bib: '63', name: '임지현', team: 'A', attempts: ['5.94', 'X', '6.05', '5.88', '-', ''], winds: ['+0.8', '', '+1.2', '0.0', '', ''], marks: [], best: '6.05', rank: '1', status: '', remark: '', uncertain: [] },
                { order: '2', bib: '119', name: '무기록', team: 'B', attempts: ['X', 'X', 'X'], winds: [], marks: [], best: '', rank: '', status: 'NM', remark: '', uncertain: ['2차'] },
            ] },
            { kind: 'wind', division: '여자 일반부', event: '멀리뛰기', round: '결승', heat: '1', bar_heights: [], notes: '', athletes: [
                { order: '2', bib: '119', name: '무기록', team: 'B', attempts: [], winds: ['+0.1', '+0.2', '+0.3', '', '', ''], marks: [], best: '', rank: '', status: '', remark: '', uncertain: [] },
            ] },
            { kind: 'height', division: '남자 고등부', event: '높이뛰기', round: '결승', heat: '1', bar_heights: ['1.55', '1.60', '1.65'], notes: '바 1.65 에서 종료', athletes: [
                { order: '1', bib: '34', name: '박준호', team: 'T', attempts: [], winds: [], marks: ['-', 'O', 'XXX'], best: '1.60', rank: '1', status: '', remark: '', uncertain: ['1.65'] },
            ] },
        ];
        const sheets = vision.cardsToSheets(cards);
        expect(sheets.map(s => s.name)).toEqual(['기록', '높이1', '풍속']);
        expect(sheets[0].aoa[0]).toEqual([...fc.COMMON_HEADERS, ...fc.ATTEMPT_HEADERS, ...fc.TAIL_HEADERS]);
        expect(sheets[0].aoa[1].slice(8, 14)).toEqual(['5.94', 'X', '6.05', '5.88', '-', '']);
        expect(sheets[2].aoa.length).toBe(3);                         // 헤더 + 임지현(inline winds) + 무기록(wind 카드)
        expect(sheets[1].aoa[0].slice(8, 11)).toEqual(['1.55', '1.60', '1.65']);

        const buf = vision.cardsToWorkbookBuffer(cards);
        const { groups } = fc.parseFieldCardWorkbook(buf);
        expect(groups.length).toBe(2);
        const lj = groups.find(g => g.eventName === '멀리뛰기');
        fc.computeGroup(lj, { needsWind: true });
        const r63 = lj.rows.find(r => r.bib === '63');
        expect(r63.attempts[1].wind).toBe(0.8);
        expect(r63.attempts[2].wind).toBeNull();
        expect(r63.computed).toMatchObject({ best: 6.05, rank: 1 });
        const r119 = lj.rows.find(r => r.bib === '119');
        expect(r119.status.code).toBe('NM');
        expect(r119.attempts[1].kind).toBe('foul');
        expect(r119.issues.some(i => /파울·패스 시기의 풍속/.test(i.msg))).toBe(true);   // wind 카드의 파울 시기 풍속 무시
        const hj = groups.find(g => g.eventName === '높이뛰기');
        fc.computeGroup(hj);
        expect(hj.heights).toEqual([1.55, 1.6, 1.65]);
        expect(hj.rows[0].computed).toMatchObject({ best: 1.6, rank: 1 });

        const ann = vision.cardsToAnnotations(cards);
        expect(ann).toEqual([
            { division: '여자 일반부', event: '멀리뛰기', heat: 1, bib: '119', order: 2, name: '무기록', cells: ['2차'] },
            { division: '남자 고등부', event: '높이뛰기', heat: 1, bib: '34', order: 1, name: '박준호', cells: ['1.65'] },
        ]);
        // 시트 배열을 넘겨도 동일
        expect(Buffer.isBuffer(vision.cardsToWorkbookBuffer(sheets))).toBe(true);
    });
    it('카드가 없으면 시트도 없다', () => {
        expect(vision.cardsToSheets([])).toEqual([]);
        expect(vision.cardsToSheets([{ kind: 'wind', athletes: [] }])).toEqual([]);
    });
});
