/**
 * [연동] ID카드(AD카드) → 소집실 스캔 (Phase 3-⑤)
 *   예전 카드의 바코드는 '|||||' 글자로 그린 모양뿐이라 스캔이 되지 않았다. 이제 Code 128 로 실제 값을 찍는다.
 *   카드에 찍힌 값으로 소집 출석이 되는지, 계주 팀(가상 선수)이 카드로 나오지 않는지, 필터가 동작하는지 확인한다.
 */
const request = require('supertest');
const pdfParse = require('pdf-parse');
const code128 = require('../../lib/code128');
let app, db; const fx = {}; const OP = 'testopkey';

const binaryParser = (res, cb) => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); };
const cardPdf = async (qs = '') => {
    const r = await request(app).get(`/api/documents/ad-card/${fx.comp}${qs}`).buffer(true).parse(binaryParser);
    return { status: r.status, parsed: r.status === 200 ? await pdfParse(r.body) : null };
};

beforeAll(async () => {
    const mod = require('../../server.js'); app = mod.app; db = mod.db;
    fx.comp = (await db.run("INSERT INTO competition (name, start_date, end_date, venue, status) VALUES (?,?,?,?, 'active')", 'ADCARD_' + Date.now(), '2026-01-01', '2099-12-31', 'x')).lastInsertRowid;
    const mkEvent = async (name, g, cat, round) => { const ev = (await db.run("INSERT INTO event (competition_id, name, category, gender, round_type, round_status) VALUES (?,?,?,?,?, 'heats_generated')", fx.comp, name, cat, g, round)).lastInsertRowid; const h = (await db.run('INSERT INTO heat (event_id, heat_number) VALUES (?,1)', ev)).lastInsertRowid; return { ev, h }; };
    const mkAth = async (name, bib, g, team, barcode, evs) => {
        const a = (await db.run('INSERT INTO athlete (competition_id, name, bib_number, team, gender, barcode) VALUES (?,?,?,?,?,?)', fx.comp, name, bib, team, g, barcode || '')).lastInsertRowid;
        const ees = [];
        for (const ev of evs) { const ee = (await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'registered')", ev.ev, a)).lastInsertRowid; await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?,?,4)', ev.h, ee); ees.push(ee); }
        return { a, ees };
    };
    fx.f100p = await mkEvent('100m', 'F', 'track', 'preliminary'); fx.f100f = await mkEvent('100m', 'F', 'track', 'final');
    fx.m100 = await mkEvent('100m', 'M', 'track', 'final'); fx.relay = await mkEvent('4x100mR', 'M', 'relay', 'final');
    fx.woman = await mkAth('KIMWOMAN', '31', 'F', 'ALPHA', '', [fx.f100p, fx.f100f]);      // 예선+결승 → 카드에는 '100m' 한 줄
    fx.man = await mkAth('LEEMAN', '31', 'M', 'BETA', '', [fx.m100]);                        // 여자와 같은 배번
    fx.tagged = await mkAth('PARKTAG', '40', 'M', 'BETA', 'PR-0040', [fx.m100]);             // 등록된 바코드가 있으면 그 값
    fx.team = await mkAth('BETA', 'BETA', 'M', 'BETA', 'RELAY_BETA', [fx.relay]);            // 계주 팀(가상 선수)
});

describe('Code 128', () => {
    it('무늬 표: 107개, 모두 11모듈(정지는 13), 중복 없음', () => {
        expect(code128.PATTERNS.length).toBe(107);
        expect(new Set(code128.PATTERNS).size).toBe(107);
        const sum = p => [...p].reduce((a, b) => a + Number(b), 0);
        expect(code128.PATTERNS.slice(0, 106).every(p => sum(p) === 11)).toBe(true);
        expect(sum(code128.PATTERNS[106])).toBe(13);
    });
    it('체크섬: (104 + Σ 값×자리) mod 103 — "PJJ123C" 는 879 mod 103 = 55 (ZXing 디코더로도 교차 확인함)', () => {
        const cw = code128.codewords('PJJ123C');
        expect(cw[0]).toBe(104); expect(cw[cw.length - 2]).toBe(55); expect(cw[cw.length - 1]).toBe(106);
    });
    it('한글 등 표현 못 하는 값은 null — 호출부가 배번으로 대체한다', () => {
        expect(code128.encode('선수1')).toBe(null);
        expect(code128.encode('')).toBe(null);
        expect(code128.encode('W31').length).toBe(6 * 5 + 7);      // 시작+3글자+체크 = 5×6, 정지 7
    });
});

describe('ID카드 PDF', () => {
    it('선수만 카드로 — 계주 팀은 빠지고, 같은 종목의 예선·결승은 한 줄', async () => {
        const { status, parsed } = await cardPdf();
        expect(status).toBe(200);
        expect(parsed.text).toContain('KIMWOMAN'); expect(parsed.text).toContain('LEEMAN'); expect(parsed.text).toContain('PARKTAG');
        expect(parsed.text).not.toContain('RELAY_BETA');
        expect(parsed.text).not.toContain('4x100mR');
        expect(parsed.numpages).toBe(1);                              // 3명 → 4장/쪽 한 쪽
        expect((parsed.text.match(/100m/g) || []).length).toBe(3);    // 여자 선수의 예선·결승이 두 줄로 찍히지 않는다
    });
    it('바코드 값: 등록 바코드 우선, 없으면 배번 — 여자는 W 접두', async () => {
        const { parsed } = await cardPdf();
        expect(parsed.text).toContain('W31'); expect(parsed.text).toContain('PR-0040');
        expect((await cardPdf('?barcode=0')).parsed.text).not.toContain('W31');
    });
    it('필터: 팀 · 성별 · 선수 지정 (추가 등록·재발급)', async () => {
        const t = (await cardPdf('?team=BETA')).parsed.text;
        expect(t).toContain('LEEMAN'); expect(t).not.toContain('KIMWOMAN');
        const g = (await cardPdf('?gender=F')).parsed.text;
        expect(g).toContain('KIMWOMAN'); expect(g).not.toContain('LEEMAN');
        const one = (await cardPdf(`?athlete_ids=${fx.tagged.a}`)).parsed.text;
        expect(one).toContain('PARKTAG'); expect(one).not.toContain('LEEMAN');
        expect((await cardPdf('?team=NOPE')).status).toBe(404);
    });
    it('배번 지정(?bibs=): 접두 없는 31 은 남녀 모두, W31 은 여자만 · ?per_page 로 장수 변경', async () => {
        const both = (await cardPdf('?bibs=31')).parsed.text;
        expect(both).toContain('KIMWOMAN'); expect(both).toContain('LEEMAN'); expect(both).not.toContain('PARKTAG');
        const w = (await cardPdf('?bibs=W31, 040')).parsed.text;
        expect(w).toContain('KIMWOMAN'); expect(w).toContain('PARKTAG'); expect(w).not.toContain('LEEMAN');
        expect((await cardPdf('?per_page=1')).parsed.numpages).toBe(3);      // 3명 → 1장/쪽 = 3쪽
    });
});

describe('카드에 찍힌 값으로 소집 출석', () => {
    const checkin = (barcode, event_id) => request(app).post('/api/callroom/checkin').set('x-admin-key', OP).send({ barcode, event_id });
    const status = async ee => (await db.get('SELECT status FROM event_entry WHERE id=?', ee)).status;
    it('여자 카드(W31) → 여자 선수, 남자 카드(31) → 남자 선수', async () => {
        expect((await checkin('W31', fx.f100p.ev)).body.athlete.name).toBe('KIMWOMAN');
        expect((await checkin('31', fx.m100.ev)).body.athlete.name).toBe('LEEMAN');
        expect(await status(fx.woman.ees[0])).toBe('checked_in'); expect(await status(fx.man.ees[0])).toBe('checked_in');
    });
    it('등록 바코드(PR-0040)', async () => {
        const r = await checkin('PR-0040', fx.m100.ev);
        expect(r.status).toBe(200); expect(r.body.athlete.name).toBe('PARKTAG');
    });
});
