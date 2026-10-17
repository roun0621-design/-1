'use strict';
/**
 * lib/fieldCardVision.js — 필드 수기 기록카드 사진 → Claude(비전) 전사 → 기록카드 xlsx 행
 *
 * 관리자 페이지에 카드 사진을 드롭하면 서버가 Claude API 에 사진과 전사 규칙을 보내고,
 * JSON 스키마로 강제한 응답(카드 → 선수 → 시기별 셀)을 받아 기존 xlsx 양식과 같은 시트로 바꾼다.
 * 그 뒤는 lib/fieldCardImport.js 파서 → 종목·선수 매칭 → 검산 → 저장 경로를 그대로 탄다.
 * (xlsx 를 사람이 만들어 올리는 경로와 완전히 같은 데이터가 되므로, 전사 결과를 xlsx 로 내려받아
 *  고친 뒤 다시 올리는 수정 경로도 그대로 쓸 수 있다.)
 *
 * 환경변수
 *   ANTHROPIC_API_KEY               필수. 없으면 isConfigured() = false → 라우트가 503 (xlsx 업로드는 영향 없음)
 *   FIELD_CARD_MODEL                기본 claude-opus-5
 *   FIELD_CARD_TRANSCRIBE_FIXTURE   NODE_ENV=test 전용. API 대신 이 JSON 파일({cards:[...]})을 응답으로 사용
 *
 * 비용 감각: 사진 1장 ≤ 4,784 입력 토큰 + 규칙 ≈ 1,500 + 출력 ≈ 1,000~2,500 토큰 → 카드 1장에 100원 안팎
 */
const fs = require('fs');
const XLSX = require('xlsx');
const fc = require('./fieldCardImport');

const DEFAULT_MODEL = 'claude-opus-5';
const MAX_LONG_EDGE = 2576;                    // Opus 5 / Sonnet 5 고해상도 비전 한도 (긴 변 px)
const MAX_IMAGE_BYTES = 4.5 * 1024 * 1024;     // API 이미지 한도 5MB 아래로
const MAX_IMAGES = 4;
const SUPPORTED_MEDIA = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const EXT_MEDIA = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
// 표시용 대략 단가 (USD / 1M tokens) — 정확한 청구는 콘솔 기준
const PRICE_PER_M = { 'claude-opus-5': [5, 25], 'claude-sonnet-5': [2, 10], 'claude-fable-5-1': [10, 50], 'claude-opus-4-8': [5, 25], 'claude-haiku-4-5': [1, 5] };

// ─────────────────────────────────────────────────────────────
// 출력 스키마 (구조화 출력) — 모든 object 는 additionalProperties:false + 전 필드 required
// ─────────────────────────────────────────────────────────────
const STR = { type: 'string' };
const STR_ARR = { type: 'array', items: { type: 'string' } };
const ATHLETE_SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['order', 'bib', 'name', 'team', 'attempts', 'winds', 'marks', 'best', 'rank', 'status', 'remark', 'uncertain'],
    properties: {
        order: { ...STR, description: 'ORDER(순서) 칸. 없으면 ""' },
        bib: { ...STR, description: 'BIB(배번) 숫자만' },
        name: { ...STR, description: '선수명' },
        team: { ...STR, description: '소속' },
        attempts: { ...STR_ARR, description: 'distance 카드: 1차~6차 순서대로 정확히 6개. 기록 "36.20" / 파울 "X" / 패스 "-" / 시도 없음 "". height·wind 카드는 빈 배열' },
        winds: { ...STR_ARR, description: 'wind 카드(또는 기록카드 안에 풍속 열이 있을 때): 1차~6차 순서대로 6개. 부호는 칸 앞에 인쇄된 + 와 - 중 동그라미 친 쪽. "+0.8" "-0.9" "0.0". 파울·패스·시도 없음은 "". 해당 없으면 빈 배열' },
        marks: { ...STR_ARR, description: 'height 카드: bar_heights 와 같은 순서·개수. "O" "XO" "XXO" "XXX" "-" "X-" "XX-", 시도 없음 "". distance·wind 카드는 빈 배열' },
        best: { ...STR, description: '카드에 적힌 최고기록(MARK of all trials / 최고기록). 없으면 ""' },
        rank: { ...STR, description: '카드에 적힌 순위(POS). 없으면 ""' },
        status: { type: 'string', enum: ['', 'DNS', 'DNF', 'DQ', 'NM'], description: '기록구분 표시가 있을 때만. 없으면 ""' },
        remark: { ...STR, description: '비고(DETAIL) 칸. 없으면 ""' },
        uncertain: { ...STR_ARR, description: '판독이 불확실한 칸 이름. 예: "3차", "5차풍속", "1.65", "배번". 없으면 빈 배열' },
    },
};
const CARD_SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['kind', 'division', 'event', 'round', 'heat', 'bar_heights', 'athletes', 'notes'],
    properties: {
        kind: { type: 'string', enum: ['distance', 'height', 'wind'], description: 'distance=투척·멀리뛰기·세단뛰기 기록카드, height=높이뛰기·장대높이뛰기 기록카드, wind=풍속 카드(WIND VELOCITY CARD)' },
        division: { ...STR, description: '성별 + 부. 예 "여자 일반부", "남자 고등부"' },
        event: { ...STR, description: '한글 종목명: 창던지기 / 포환던지기 / 원반던지기 / 해머던지기 / 멀리뛰기 / 세단뛰기 / 높이뛰기 / 장대높이뛰기. 혼성경기면 "10종 포환던지기" 처럼 앞에 붙임' },
        round: { type: 'string', enum: ['결승', '예선', '준결승'] },
        heat: { ...STR, description: '조 번호. 표시가 없으면 "1"' },
        bar_heights: { ...STR_ARR, description: 'height 카드: 열 헤더의 바 높이를 왼쪽부터 순서대로 "1.55" 형식(미터). 다른 카드는 빈 배열' },
        athletes: { type: 'array', items: ATHLETE_SCHEMA },
        notes: { ...STR, description: '카드 전체에 대한 특이사항. 없으면 ""' },
    },
};
const TRANSCRIPTION_SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['cards'],
    properties: { cards: { type: 'array', items: CARD_SCHEMA } },
};

const SYSTEM_PROMPT = `당신은 육상 필드경기 수기 기록카드를 전사하는 기록원입니다. 사진에 적힌 내용을 있는 그대로 JSON으로 옮깁니다.

규칙
- 사진 한 장이 카드 한 장입니다. 기록카드는 kind "distance"(투척·멀리뛰기·세단뛰기) 또는 "height"(높이뛰기·장대높이뛰기), 풍속 카드(FIELD EVENTS WIND VELOCITY CARD)는 kind "wind"로 각각 별도 카드로 출력합니다.
- 카드 상단 체크박스에서 종목(Shot Put/Discus/Hammer/Javelin/Long Jump/Triple Jump/High Jump/Pole Vault), 성별(Women/Men), 부(Elementary/Middle/High School/University/Senior → 초등부/중등부/고등부/대학부/일반부), 라운드(Final → 결승, Qualification → 예선), 혼성경기(5종/7종/10종)를 읽어 한글로 적습니다. division 은 "여자 일반부" 형식입니다.
- 선수 행마다 ORDER(순서), BIB(배번), 선수명, 소속을 옮깁니다. 완전히 빈 행은 출력하지 않습니다.
- distance 카드: 1차~6차 시기 칸을 순서대로 6개. 숫자는 소수 둘째 자리까지("36.20"), 파울은 "X", 패스는 "-", 빈칸은 "". "MARK of Three trials"(1~3차 최고)와 "1st~3rd POS / after trial ORDER"(3차 후 순위·순서) 열은 옮기지 않습니다. best 에는 "MARK of all trials"(1~6차 최고기록), rank 에는 POS(순위)를 적습니다.
- wind 카드: 1차~6차 풍속을 순서대로 6개, 부호 포함("+0.8", "-0.9", "0.0"). 파울·패스 시기나 빈칸은 "". "after three trial ORDER" 열은 옮기지 않습니다.
- 풍속 부호 읽는 법: 각 풍속 칸 앞에는 "+" 와 "-" 두 기호가 인쇄되어 있고, 심판이 그중 하나에 손으로 동그라미를 칩니다. 동그라미 친 기호가 부호입니다. 동그라미가 기호를 가려 잘 안 보여도 동그라미가 어느 쪽에 있는지로 판단하고, 손으로 직접 쓴 부호가 있으면 그것을 우선합니다. 어느 쪽인지 확신이 없으면 "+" 로 적고 uncertain 에 "N차풍속" 을 넣습니다. 0.0 은 부호 없이 "0.0" 으로 적습니다.
- height 카드: 열 헤더의 바 높이를 bar_heights 에 순서대로 적고, 각 선수의 marks 에 같은 순서로 그 높이의 시도 결과(O, XO, XXO, XXX, 패스 "-", X-, XX-, 시도 없음 "")를 적습니다. best 에는 카드의 최고 기록(MARK), rank 에는 POS를 적습니다.
- status: DNS(결장), DNF, DQ(실격), NM(기록 없음/NH) 표시가 있을 때만 적고, 없으면 "".
- 동그라미, 밑줄, 사선 같은 표시는 무시하고 숫자·기호만 옮깁니다. 값을 추정하거나 계산해서 채우지 않습니다.
- 판독이 불확실한 칸은 가장 가까운 값을 적고 uncertain 에 그 칸 이름을 넣습니다(예: "3차", "5차풍속", "1.65", "배번").
- 손글씨 숫자 오독에 주의합니다: 1/7, 4/9, 0/6, 3/8, 5/6. 소수점 위치도 확인합니다.`;

// ─────────────────────────────────────────────────────────────
// 클라이언트
// ─────────────────────────────────────────────────────────────
let _client = null;
function isConfigured() { return !!(process.env.ANTHROPIC_API_KEY && String(process.env.ANTHROPIC_API_KEY).trim()); }
function getClient() {
    if (_client) return _client;
    const Anthropic = require('@anthropic-ai/sdk');
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 5 * 60 * 1000, maxRetries: 2 });
    return _client;
}
function estimateCostUsd(model, usage) {
    const p = PRICE_PER_M[model] || PRICE_PER_M[DEFAULT_MODEL];
    if (!usage) return null;
    const inTok = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) * 0.1 + (usage.cache_creation_input_tokens || 0) * 1.25;
    return Math.round(((inTok * p[0]) + ((usage.output_tokens || 0) * p[1])) / 1e6 * 1000) / 1000;
}

// ─────────────────────────────────────────────────────────────
// 이미지 준비 — 형식 확인 + 긴 변 2576px / 4.5MB 초과 시 canvas 로 축소(JPEG)
// ─────────────────────────────────────────────────────────────
async function prepareImage(buffer, mimetype, name) {
    let mt = String(mimetype || '').toLowerCase();
    if (mt === 'image/jpg') mt = 'image/jpeg';
    if (!SUPPORTED_MEDIA.has(mt)) {
        const ext = String(name || '').toLowerCase().split('.').pop();
        if (!EXT_MEDIA[ext]) throw Object.assign(new Error(`지원하지 않는 이미지 형식: ${mimetype || ext || '알 수 없음'} (JPEG/PNG/WebP 만 가능, HEIC 는 JPEG 로 변환해 주세요)`), { code: 'BAD_IMAGE' });
        mt = EXT_MEDIA[ext];
    }
    try {
        const { loadImage, createCanvas } = require('canvas');
        const img = await loadImage(buffer);
        const long = Math.max(img.width, img.height);
        if (long > MAX_LONG_EDGE || buffer.length > MAX_IMAGE_BYTES) {
            const scale = Math.min(1, MAX_LONG_EDGE / long);
            const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
            const cv = createCanvas(w, h);
            cv.getContext('2d').drawImage(img, 0, 0, w, h);
            let q = 0.9, out = cv.toBuffer('image/jpeg', { quality: q });
            while (out.length > MAX_IMAGE_BYTES && q > 0.5) { q = Math.round((q - 0.1) * 10) / 10; out = cv.toBuffer('image/jpeg', { quality: q }); }
            return { data: out.toString('base64'), media_type: 'image/jpeg', width: w, height: h, bytes: out.length, resized: true };
        }
        return { data: buffer.toString('base64'), media_type: mt, width: img.width, height: img.height, bytes: buffer.length, resized: false };
    } catch (e) {
        if (e && e.code === 'BAD_IMAGE') throw e;
        if (buffer.length > MAX_IMAGE_BYTES) throw Object.assign(new Error(`이미지가 5MB 를 넘는데 축소하지 못했습니다 (${e.message})`), { code: 'BAD_IMAGE' });
        // canvas 가 못 읽는 형식(webp 등)은 크기만 맞으면 그대로 전송
        return { data: buffer.toString('base64'), media_type: mt, width: null, height: null, bytes: buffer.length, resized: false };
    }
}

// ─────────────────────────────────────────────────────────────
// 전사 호출
// ─────────────────────────────────────────────────────────────
async function callClaude(client, { model, content }) {
    const base = {
        model, max_tokens: 16000, system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content }],
        output_config: { format: { type: 'json_schema', schema: TRANSCRIPTION_SCHEMA } },
    };
    try {
        // 서버측 폴백: 안전 분류기가 거부하면 같은 요청을 대체 모델로 자동 재실행 (Opus 5 권장 설정)
        return await client.beta.messages.create({ ...base, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
    } catch (err) {
        // 조직에서 폴백 베타를 못 쓰는 경우 등 fallbacks 관련 400 → 폴백 없이 1회 재시도
        if (err && err.status === 400 && /fallback/i.test(String(err.message || ''))) {
            return await client.beta.messages.create(base);
        }
        throw err;
    }
}

/**
 * 사진 → 카드 JSON.
 * @param {{ images: Array<{buffer:Buffer, mimetype:string, name?:string}>, hint?: string, client?: object, model?: string }} opts
 * @returns {Promise<{ cards: Array, model: string, usage: object, cost_usd: number|null, images: Array, fixture?: boolean }>}
 */
async function transcribeCards({ images, hint = '', client = null, model = null }) {
    if (!images || !images.length) throw Object.assign(new Error('사진이 없습니다'), { code: 'BAD_IMAGE' });
    if (images.length > MAX_IMAGES) throw Object.assign(new Error(`사진은 한 번에 ${MAX_IMAGES}장까지 올릴 수 있습니다`), { code: 'BAD_IMAGE' });
    if (process.env.NODE_ENV === 'test' && process.env.FIELD_CARD_TRANSCRIBE_FIXTURE) {
        const fx = JSON.parse(fs.readFileSync(process.env.FIELD_CARD_TRANSCRIBE_FIXTURE, 'utf8'));
        const usage = fx.usage || { input_tokens: 0, output_tokens: 0 };
        return { cards: fx.cards || [], model: 'fixture', usage, cost_usd: 0, fixture: true,
                 images: images.map(i => ({ name: i.name || '', bytes: i.buffer.length, resized: false })) };
    }
    if (!client && !isConfigured()) throw Object.assign(new Error('ANTHROPIC_API_KEY 가 서버에 설정되지 않았습니다 (.env)'), { code: 'NOT_CONFIGURED' });
    // 테스트 실행 중 실수로 유료 API 를 호출하지 않도록 차단 (실제 호출 검증은 FIELD_CARD_ALLOW_REAL_API=1 로 명시)
    if (!client && process.env.NODE_ENV === 'test' && process.env.FIELD_CARD_ALLOW_REAL_API !== '1') {
        throw Object.assign(new Error('테스트 환경에서는 실제 AI 호출이 차단됩니다 (FIELD_CARD_TRANSCRIBE_FIXTURE 또는 FIELD_CARD_ALLOW_REAL_API=1)'), { code: 'NOT_CONFIGURED' });
    }

    const prepared = [];
    for (const im of images) prepared.push({ ...(await prepareImage(im.buffer, im.mimetype, im.name)), name: im.name || '' });
    const content = [];
    prepared.forEach((p, i) => {
        content.push({ type: 'text', text: `[사진 ${i + 1}]` });
        content.push({ type: 'image', source: { type: 'base64', media_type: p.media_type, data: p.data } });
    });
    content.push({ type: 'text', text: `위 ${prepared.length}장의 기록카드 사진을 규칙대로 JSON으로 전사하세요.${hint ? ` 참고 정보: ${hint}` : ''}` });

    const useModel = model || process.env.FIELD_CARD_MODEL || DEFAULT_MODEL;
    const resp = await callClaude(client || getClient(), { model: useModel, content });

    if (resp.stop_reason === 'refusal') {
        const cat = resp.stop_details && resp.stop_details.category ? ` (${resp.stop_details.category})` : '';
        throw Object.assign(new Error(`AI 가 전사를 거부했습니다${cat}`), { code: 'REFUSAL' });
    }
    if (resp.stop_reason === 'max_tokens') throw Object.assign(new Error('AI 응답이 잘렸습니다 — 사진 수를 줄여 다시 시도하세요'), { code: 'TRUNCATED' });
    const text = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { throw Object.assign(new Error('AI 응답을 JSON 으로 읽지 못했습니다'), { code: 'BAD_JSON' }); }
    const usage = resp.usage ? {
        input_tokens: resp.usage.input_tokens || 0, output_tokens: resp.usage.output_tokens || 0,
        cache_read_input_tokens: resp.usage.cache_read_input_tokens || 0, cache_creation_input_tokens: resp.usage.cache_creation_input_tokens || 0,
    } : null;
    return {
        cards: Array.isArray(parsed.cards) ? parsed.cards : [],
        model: resp.model || useModel, usage, cost_usd: estimateCostUsd(resp.model || useModel, usage),
        request_id: resp._request_id || null,
        images: prepared.map(p => ({ name: p.name, media_type: p.media_type, width: p.width, height: p.height, bytes: p.bytes, resized: p.resized })),
    };
}

// ─────────────────────────────────────────────────────────────
// 카드 JSON → xlsx 시트 (기존 양식과 동일) → 파서가 그대로 읽음
// ─────────────────────────────────────────────────────────────
function _pad6(arr) { const a = Array.isArray(arr) ? arr.map(v => (v == null ? '' : String(v))) : []; while (a.length < 6) a.push(''); return a.slice(0, 6); }
function _s(v) { return v == null ? '' : String(v); }

/** 카드 1장 정규화: 문자열화, attempts/winds 6칸, marks 는 bar_heights 길이, status 화이트리스트 */
function normalizeCard(card) {
    const c = card && typeof card === 'object' ? card : {};
    const kind = ['distance', 'height', 'wind'].includes(c.kind) ? c.kind : 'distance';
    const bar_heights = kind === 'height' ? (Array.isArray(c.bar_heights) ? c.bar_heights : []).map(h => _s(h).trim()).filter(Boolean) : [];
    const athletes = (Array.isArray(c.athletes) ? c.athletes : []).slice(0, 80).map(a => {
        a = a && typeof a === 'object' ? a : {};
        const status = ['', 'DNS', 'DNF', 'DQ', 'NM'].includes(_s(a.status).toUpperCase()) ? _s(a.status).toUpperCase() : '';
        return {
            order: _s(a.order).trim(), bib: _s(a.bib).trim(), name: _s(a.name).trim(), team: _s(a.team).trim(),
            attempts: kind === 'height' ? [] : _pad6(a.attempts), winds: kind === 'height' ? [] : _pad6(a.winds),
            marks: kind === 'height' ? bar_heights.map((h, i) => _s((Array.isArray(a.marks) ? a.marks : [])[i]).trim()) : [],
            best: _s(a.best).trim(), rank: _s(a.rank).trim(), status, remark: _s(a.remark).trim(),
            uncertain: (Array.isArray(a.uncertain) ? a.uncertain : []).map(x => _s(x).trim()).filter(Boolean),
        };
    });
    return { kind, division: _s(c.division).trim(), event: _s(c.event).trim(), round: _s(c.round).trim() || '결승', heat: _s(c.heat).trim() || '1', bar_heights, athletes, notes: _s(c.notes).trim() };
}

/**
 * 조(heat)가 정해진 업로드용: 여러 장의 카드를 기록카드 1장으로 합친다.
 * 기록카드(distance/height)가 기준이고, 풍속 카드의 풍속은 배번 → 순서 → 성명 순으로 같은 선수 행에 붙인다.
 * @returns {{ card: object|null, notes: string[] }}
 */
function mergeCardsForHeat(cards) {
    const all = (Array.isArray(cards) ? cards : []).map(normalizeCard);
    const records = all.filter(c => c.kind !== 'wind');
    const winds = all.filter(c => c.kind === 'wind');
    const notes = [];
    if (!records.length) return { card: null, notes: winds.length ? ['풍속 카드만 인식됨'] : [] };
    const base = records[0];
    if (records.length > 1) {
        // 같은 조의 기록카드가 여러 장(다중 촬영 등)이면 선수 행을 이어 붙이되 중복 배번은 첫 장 우선
        const seen = new Set(base.athletes.map(a => fc.normBib(a.bib)).filter(Boolean));
        for (const extra of records.slice(1)) {
            for (const a of extra.athletes) { const nb = fc.normBib(a.bib); if (nb && seen.has(nb)) continue; if (nb) seen.add(nb); base.athletes.push(a); }
        }
        notes.push(`기록카드 ${records.length}장을 한 조로 합침`);
    }
    for (const w of winds) {
        for (const wa of w.athletes) {
            const nb = fc.normBib(wa.bib);
            let t = nb ? base.athletes.find(a => fc.normBib(a.bib) === nb) : null;
            if (!t && wa.order) t = base.athletes.find(a => a.order === wa.order);
            if (!t && wa.name) { const nn = fc.normName(wa.name); t = base.athletes.find(a => fc.normName(a.name) === nn); }
            if (!t) { notes.push(`풍속 카드의 ${wa.bib || wa.order || wa.name || '?'} 선수를 기록카드에서 찾지 못함`); continue; }
            t.winds = _pad6(wa.winds);
            for (const u of wa.uncertain) if (!t.uncertain.includes(u)) t.uncertain.push(u);
        }
    }
    for (const c of all) if (c.notes) notes.push(c.notes);
    return { card: base, notes };
}

/** @returns {Array<{name:string, aoa:Array<Array>}>} */
function cardsToSheets(cards) {
    const sheets = [];
    const distRows = [], windRows = [];
    let hIdx = 0;
    for (const c of cards || []) {
        const common = (a) => [_s(c.division), _s(c.event), _s(c.round) || '결승', _s(c.heat) || '1', _s(a.order), _s(a.bib), _s(a.name), _s(a.team)];
        const athletes = Array.isArray(c.athletes) ? c.athletes : [];
        if (c.kind === 'distance') {
            for (const a of athletes) {
                distRows.push([...common(a), ..._pad6(a.attempts), _s(a.best), _s(a.rank), _s(a.status), _s(a.remark)]);
                if (Array.isArray(a.winds) && a.winds.some(w => _s(w).trim())) windRows.push([...common(a), ..._pad6(a.winds)]);
            }
        } else if (c.kind === 'wind') {
            for (const a of athletes) windRows.push([...common(a), ..._pad6(a.winds)]);
        } else if (c.kind === 'height') {
            const heights = (Array.isArray(c.bar_heights) ? c.bar_heights : []).map(h => _s(h).trim()).filter(Boolean);
            const aoa = [[...fc.COMMON_HEADERS, ...heights, ...fc.TAIL_HEADERS]];
            for (const a of athletes) {
                const marks = heights.map((h, i) => _s((a.marks || [])[i]));
                aoa.push([...common(a), ...marks, _s(a.best), _s(a.rank), _s(a.status), _s(a.remark)]);
            }
            sheets.push({ name: `높이${++hIdx}`, aoa });
        }
    }
    if (distRows.length) sheets.unshift({ name: '기록', aoa: [[...fc.COMMON_HEADERS, ...fc.ATTEMPT_HEADERS, ...fc.TAIL_HEADERS], ...distRows] });
    if (windRows.length) sheets.push({ name: '풍속', aoa: [[...fc.COMMON_HEADERS, ...fc.WIND_HEADERS], ...windRows] });
    return sheets;
}
function cardsToWorkbookBuffer(sheetsOrCards) {
    const sheets = Array.isArray(sheetsOrCards) && sheetsOrCards.length && sheetsOrCards[0] && sheetsOrCards[0].aoa ? sheetsOrCards : cardsToSheets(sheetsOrCards);
    const wb = XLSX.utils.book_new();
    for (const s of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s.aoa), s.name);
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
/** 불확실 셀 → 미리보기 경고용 주석 [{ event, heat, division, bib, order, name, cells }] */
function cardsToAnnotations(cards) {
    const out = [];
    for (const c of cards || []) {
        for (const a of (Array.isArray(c.athletes) ? c.athletes : [])) {
            const cells = (Array.isArray(a.uncertain) ? a.uncertain : []).map(x => _s(x).trim()).filter(Boolean);
            if (!cells.length) continue;
            out.push({ division: _s(c.division), event: _s(c.event), heat: parseInt(_s(c.heat), 10) || 1, bib: _s(a.bib), order: parseInt(_s(a.order), 10) || null, name: _s(a.name), cells });
        }
    }
    return out;
}

module.exports = {
    DEFAULT_MODEL, MAX_IMAGES, MAX_LONG_EDGE, TRANSCRIPTION_SCHEMA, SYSTEM_PROMPT,
    isConfigured, getClient, prepareImage, transcribeCards, estimateCostUsd,
    cardsToSheets, cardsToWorkbookBuffer, cardsToAnnotations, normalizeCard, mergeCardsForHeat,
};
