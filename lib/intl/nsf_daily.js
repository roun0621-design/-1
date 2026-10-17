'use strict';
/**
 * 전국체전 데일리 조편성 — 대한육상연맹이 매일 저녁 내는 '참가선수명단' PDF → 동기화된(provider nsf) 대회의 종목·조에 레인/순서 반영 (2026-10-17 사용자 요청)
 *
 * PDF 글자(pdf-parse)는 칸이 붙어 나온다:
 *     -31-                               ← 쪽 번호
 *     ▣ 100m (4-2)                        ← 종목 (괄호 = 진출 규정 → 예선 / '결승' / '결승 A,B' / 없음), '100m(10종)' = 종합경기 세부종목
 *     1조레인번호성명소속                   ← 조 머리글 ('순번호성명소속' = 필드·장거리, 'A순 번호 성명 소속' = 같은 조의 A·B 그룹)
 *     2207박태현강원특별자치도              ← 레인 2 · 번호 207 · 성명 · 소속(시도 정식 이름). 어디서 끊을지는 시도 이름(뒤)과 레인/순서가 이어진다는 것(앞)으로 정한다
 *     7   183정지성   경기도               ← 띄어진 행도 있다
 *     5   630 / 비웨사다니엘가사마 / 경기도  ← 긴 이름은 줄이 바뀐다
 *     남자고등학교부                        ← 부 표시는 그 쪽 내용 '뒤'에 나온다 (쪽 머리글이 마지막에 찍힘)
 * 계주: 레인이 있는 행이 팀 첫 주자, 같은 시도가 이어지는 행이 나머지 주자.
 *
 * 반영: 종목 = 이름·성별·라운드·부(고등학교부→18세이하부, 대학교부→대학부)로 찾고, 조 = 번호가 같은 기존 조(NSF external_key 유지) — 없으면 새로 만든다.
 *       선수 = 같은 종목 출전자 중 이름·시도가 같은 사람(사이트가 이름을 '김**' 로 가린 선수는 시도·글자수로 맞춰 실명으로 바꾼다),
 *       없으면 새로 만든다. 배번은 연맹 번호로 바꾼다(결과 사이트 result.kaaf.or.kr 도 같은 번호). 결과가 있는 종목은 force 없이는 건드리지 않는다.
 */
const N = require('./nsf');

const SIDO = { '서울특별시': '서울', '부산광역시': '부산', '대구광역시': '대구', '인천광역시': '인천', '광주광역시': '광주', '대전광역시': '대전', '울산광역시': '울산', '세종특별자치시': '세종',
    '경기도': '경기', '강원특별자치도': '강원', '강원도': '강원', '충청북도': '충북', '충청남도': '충남', '전북특별자치도': '전북', '전라북도': '전북', '전라남도': '전남', '경상북도': '경북', '경상남도': '경남', '제주특별자치도': '제주', '제주도': '제주' };
const SIDO_FULL = Object.keys(SIDO).sort((a, b) => b.length - a.length);
const SIDO_SHORT = [...new Set(Object.values(SIDO))];
const DIVISION = { '고등학교부': '18세이하부', '고등부': '18세이하부', '18세이하부': '18세이하부', '대학교부': '대학부', '대학부': '대학부', '일반부': '일반부', '실업부': '일반부', '중학교부': '중학부', '중등부': '중학부' };
const HEADER_RE = /^(남자|여자|혼성)?\s*(고등학교부|고등부|18세이하부|대학교부|대학부|일반부|실업부|중학교부|중등부)$/;
const norm = v => String(v == null ? '' : v).replace(/[\s　]+/g, ' ').trim();

/** 시도 정식 이름/약칭 → 약칭 ('울산광역시' → '울산') */
function sidoOf(team) { const t = norm(team).replace(/\s/g, ''); return SIDO[t] || t; }
/** '박태현강원특별자치도' → { name, team } (소속은 시도 이름으로 끝난다) */
function splitNameTeam(rest) {
    const r = String(rest || '').replace(/\s/g, '');
    for (const full of SIDO_FULL) if (r.endsWith(full) && r.length > full.length) return { name: r.slice(0, -full.length), team: full };
    for (const s of SIDO_SHORT) if (r.endsWith(s) && r.length > s.length + 1) return { name: r.slice(0, -s.length), team: s };
    return null;
}

function newSection(title) {
    let t = norm(title), m, roundRaw = '', combined = null;
    for (let i = 0; i < 2; i++) {
        if (!(m = t.match(/^(.*?)\s*\(([^()]*)\)\s*$/))) break;
        const inner = m[2].trim();
        if (/^(10종|7종|5종)$/.test(inner)) combined = inner; else roundRaw = inner;
        t = m[1].trim();
    }
    let name = t.replace(/\s/g, '');
    if (/^(혼성)?4[xX×]\d+m?R/i.test(name)) name = name.replace(/^혼성/, '').replace(/[x×]/g, 'X').replace(/\(mixed\)$/i, '(Mixed)');
    name = N.normEventName(name);
    const code = /^\d+-\d+(\+\d+)?$/.test(roundRaw) ? roundRaw : '';
    const round = combined ? 'final' : (code || /예선/.test(roundRaw)) ? 'preliminary' : /준결/.test(roundRaw) ? 'semifinal' : 'final';
    return { title: norm(title), name, combined, round, code, roundRaw, isRelay: /mR(\(Mixed\))?$/.test(name), gender: null, division: null, heats: new Map(), issues: [] };
}
const heatOf = (sec, no) => { if (!sec.heats.has(no)) sec.heats.set(no, []); return sec.heats.get(no); };

/** PDF 글자 → { sections:[{ name, combined, round, gender, division, heats: Map(조 → [{lane, bib, name, team, sido, group, members}]) }], issues } */
function parseDailyText(text) {
    const lines = String(text || '').split(/\r?\n/).map(norm).filter(Boolean);
    const sections = [], issues = [];
    let page = [], cur = null, heat = 1, group = null, prevLane = null, lastTeamRow = null, pending = null;
    const flushPage = (g, div) => { for (const s of page) { if (s.gender == null) { s.gender = g; s.division = div; } } page = []; };
    const pushRow = (row) => {
        if (cur.isRelay) {
            if (row.lane != null || !lastTeamRow || (row.team && sidoOf(row.team) !== lastTeamRow.sido)) { row.members = [{ bib: row.bib, name: row.name }]; heatOf(cur, heat).push(row); lastTeamRow = row; }
            else { lastTeamRow.members.push({ bib: row.bib, name: row.name }); }
        } else heatOf(cur, heat).push(row);
        if (row.lane != null) prevLane = row.lane;
    };
    for (const l of lines) {
        let m;
        if (/^-\d+-$/.test(l)) continue;
        if ((m = l.match(HEADER_RE))) { flushPage(m[1] === '남자' ? 'M' : m[1] === '여자' ? 'F' : 'X', DIVISION[m[2]] || m[2]); continue; }
        if (l.startsWith('▣')) { cur = newSection(l.replace(/^▣\s*/, '')); sections.push(cur); page.push(cur); heat = 1; group = null; prevLane = null; lastTeamRow = null; pending = null; continue; }
        if (!cur) continue;
        if ((m = l.match(/^(\d+)\s*조\s*(레인|순서?)\s*번호/))) { heat = parseInt(m[1], 10); group = null; prevLane = null; lastTeamRow = null; pending = null; continue; }
        if ((m = l.match(/^([A-Z])\s*(레인|순서?)\s*번호/))) { group = m[1]; lastTeamRow = null; pending = null; continue; }   // 'A순' — 같은 조의 그룹, 순서는 이어진다
        if (/^(레인|순서?)\s*번호\s*성명/.test(l)) { prevLane = null; pending = null; continue; }
        if (pending && !/^\d/.test(l)) {
            // 줄 바뀐 긴 이름/소속
            if (!pending.name) { const sp = splitNameTeam(l); if (sp) { pending.name = sp.name; pending.team = sp.team; } else pending.name = l.replace(/\s/g, ''); }
            else if (!pending.team) pending.team = l.replace(/\s/g, '');
            if (pending.name && pending.team) { pending.sido = sidoOf(pending.team); pushRow(pending); pending = null; }
            continue;
        }
        if (!/^\d/.test(l)) { if (!/^(총|합계|참가|선수|명단)/.test(l)) cur.issues.push(`해석 못 한 줄: ${l}`); continue; }
        if (/^\d{1,2}$/.test(l)) { prevLane = parseInt(l, 10); continue; }      // 빈 레인 (번호만 찍힘)
        let row = null;
        if ((m = l.match(/^(\d+)\s+(\d+)\s*(\S*)\s*(\S*)$/))) {
            // 띄어진 행: 레인 번호 성명 소속 ("7 183정지성 경기도", "5 630")
            row = { lane: parseInt(m[1], 10), bib: m[2], name: m[3], team: m[4], group };
            if (row.name && !row.team) { const sp = splitNameTeam(row.name); if (sp) { row.name = sp.name; row.team = sp.team; } }
        } else if ((m = l.match(/^(\d+)\s*(\D.*)$/))) {
            const digits = m[1], rest = m[2].replace(/\s/g, '');
            const sp = splitNameTeam(rest);
            const name = sp ? sp.name : rest, team = sp ? sp.team : (cur.isRelay && lastTeamRow ? lastTeamRow.team : '');
            if (cur.isRelay && lastTeamRow && (!sp || sidoOf(team) === lastTeamRow.sido) && (!sp || digits.length >= 1)) {
                // 계주 나머지 주자: 레인 없이 번호만 (같은 시도가 이어짐)
                row = { lane: null, bib: digits, name, team, group };
            } else {
                // 레인/순서 + 번호: 번호는 0 으로 시작하지 않고, 레인/순서는 앞 행에서 이어진다
                const cands = [];
                for (const ln of [1, 2]) { if (digits.length <= ln || digits[ln] === '0') continue; const lane = parseInt(digits.slice(0, ln), 10); if (lane < 1 || lane > 60) continue; cands.push({ lane, bib: digits.slice(ln) }); }
                let pick = null;
                if (prevLane != null) pick = cands.find(c => c.lane === prevLane + 1) || cands.filter(c => c.lane > prevLane).sort((a, b) => a.lane - b.lane)[0];
                else pick = cands.find(c => c.lane === 1) || cands.find(c => c.lane <= 9) || cands[0];
                if (!pick) pick = cands[0];
                if (!pick) { cur.issues.push(`해석 못 한 줄: ${l}`); continue; }
                row = { lane: pick.lane, bib: pick.bib, name, team, group };
            }
        } else { cur.issues.push(`해석 못 한 줄: ${l}`); continue; }
        if (!row.name || !row.team) { pending = row; continue; }
        row.sido = sidoOf(row.team);
        pushRow(row);
    }
    if (pending && pending.name) { pending.sido = sidoOf(pending.team || ''); pushRow(pending); }
    for (const s of page) if (s.gender == null) issues.push(`부 표시를 찾지 못한 종목: ${s.title}`);
    for (const s of sections) issues.push(...s.issues.map(x => `[${s.title}] ${x}`));
    // 쪽이 넘어가며 같은 종목이 다시 시작된 구간(마라톤 순 32~)은 한 종목으로 합친다
    const merged = [], byKey = new Map();
    for (const s of sections) {
        const k = `${s.gender}|${s.division}|${s.combined || ''}|${s.name}|${s.round}`;
        const prev = byKey.get(k);
        if (!prev) { byKey.set(k, s); merged.push(s); continue; }
        for (const [no, rows] of s.heats) heatOf(prev, no).push(...rows);
    }
    return { sections: merged, issues };
}

async function pdfToText(buffer) {
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(buffer);
    if (!data.text || !/▣/.test(data.text)) {
        const e = new Error(data.text && data.text.trim().length > 50 ? 'PDF 에서 ▣ 종목 머리글을 찾지 못했습니다. 연맹 참가선수명단 PDF 가 맞는지 확인하세요.' : 'PDF 에서 글자를 읽을 수 없습니다(스캔한 그림 PDF).');
        e.userFacing = true; throw e;
    }
    return data.text;
}

// ── 우리 구조와 맞추기 (KAAF 결과 동기화도 같은 함수를 쓴다) ──
const divKey = d => String(d || '').split('·').map(x => x.replace(/부$/, '')).filter(Boolean);
/** 종목 찾기: 이름·성별·라운드(·부). 부는 정확히 → 느슨하게('대학·일반부' 안에 '일반부') → 부 없는 단일 후보 */
async function findEvent(db, compId, { name, combined, round, gender, division, isRelay }) {
    let cands;
    if (combined) cands = await db.all("SELECT e.* FROM event e JOIN event p ON p.id=e.parent_event_id WHERE e.competition_id=? AND e.name=? AND p.name=? AND e.gender=?", compId, `[${combined}] ${name}`, `${combined}경기`, gender);
    else cands = await db.all('SELECT * FROM event WHERE competition_id=? AND name=? AND gender=? AND round_type=? AND parent_event_id IS NULL', compId, name, gender, round);
    if (!cands.length && isRelay && gender !== 'X') cands = await db.all('SELECT * FROM event WHERE competition_id=? AND name=? AND gender=? AND round_type=? AND parent_event_id IS NULL', compId, name, 'X', round);
    if (!cands.length && !combined && round === 'final') {
        // 데일리가 '결승' 이라 했는데 우리 구조엔 예선만 있는 경우(사이트 일정에 결승이 아직 없음): 1라운드 하나뿐이면 그것
        const any = await db.all('SELECT * FROM event WHERE competition_id=? AND name=? AND gender=? AND parent_event_id IS NULL', compId, name, gender);
        const byDiv = any.filter(e => (e.division || '') === (division || '')); if (byDiv.length === 1) return byDiv[0];
    }
    if (!cands.length) return null;
    const want = divKey(division);
    const exact = cands.filter(e => (e.division || '') === (division || '')); if (exact.length === 1) return exact[0];
    const loose = cands.filter(e => want.some(w => divKey(e.division).includes(w))); if (loose.length === 1) return loose[0];
    const none = cands.filter(e => !e.division); if (none.length === 1 && cands.length === 1) return none[0];
    return null;
}
const maskRe = name => { const s = String(name || ''); if (!/\*/.test(s)) return null; return new RegExp('^' + s.replace(/\s\(.*\)$/, '').split('').map(ch => ch === '*' ? '.' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('') + '$'); };
/**
 * 선수 찾기 (이름·시도·배번) — 같은 종목 출전자 우선, 가린 이름('김**') 맞추기, 연맹 배번, 그래도 없으면 만든다
 * ev: { id, external_key, gender } / p: { name, sido, bib } → athlete id
 */
async function matchAthlete(db, compId, ev, p, stats, opts = {}) {
    const base = String(ev.external_key || '').split('#')[0];
    const bib = String(p.bib || '').replace(/^0+/, '');
    const inEvent = base ? await db.all(`SELECT a.* FROM athlete a WHERE a.competition_id=? AND a.team=? AND EXISTS (SELECT 1 FROM event_entry ee JOIN event e ON e.id=ee.event_id WHERE ee.athlete_id=a.id AND (e.external_key=? OR e.external_key LIKE ?))`, compId, p.sido, base, base + '#%') : [];
    const pick = (list) => list.find(a => a.name === p.name) || list.find(a => a.name.replace(/\s\(.*\)$/, '') === p.name);
    let a = pick(inEvent);
    if (!a) a = pick(await db.all('SELECT * FROM athlete WHERE competition_id=? AND team=? AND name LIKE ?', compId, p.sido, p.name + '%'));
    if (!a) {
        // 가린 이름: 같은 시도·같은 종목 출전자 중 글자 수·앞글자가 맞는 한 사람
        const masked = inEvent.filter(x => { const re = maskRe(x.name); return re && re.test(p.name); });
        if (masked.length === 1) { a = masked[0]; stats.unmasked = (stats.unmasked || 0) + 1; if (!opts.readOnly) { try { await db.run('UPDATE athlete SET name=? WHERE id=?', p.name, a.id); } catch (e) { /* 동명이인 */ } } }
    }
    if (!a && bib) {
        const byBib = await db.all('SELECT * FROM athlete WHERE competition_id=? AND bib_number=? AND team=?', compId, bib, p.sido);
        if (byBib.length === 1 && (byBib[0].name === p.name || maskRe(byBib[0].name))) a = byBib[0];
    }
    if (!a && bib) { const byBibName = await db.get('SELECT * FROM athlete WHERE competition_id=? AND bib_number=? AND name=?', compId, bib, p.name); if (byBibName) a = byBibName; }
    if (a) {
        if (bib && String(a.bib_number || '') !== bib) { stats.bib_updated = (stats.bib_updated || 0) + 1; if (!opts.readOnly) await db.run('UPDATE athlete SET bib_number=? WHERE id=?', bib, a.id); }
        return a.id;
    }
    if (opts.readOnly) return null;
    const gender = ev.gender === 'F' ? 'F' : 'M';
    const names = [p.name, `${p.name} (${bib || p.sido})`];
    for (const name of names) {
        try { const r = await db.run('INSERT INTO athlete (competition_id, name, bib_number, team, barcode, gender, federation) VALUES (?,?,?,?,?,?,?)', compId, name, bib || null, p.sido, `NSFD:${p.sido}:${bib || p.name}`, gender, ''); stats.created = (stats.created || 0) + 1; return r.lastInsertRowid; }
        catch (e) { if (!/UNIQUE|duplicate|23505/i.test(String(e.message || e.code))) throw e; }
    }
    return null;
}
async function ensureEntry(db, eventId, athleteId) {
    const cur = await db.get('SELECT id FROM event_entry WHERE event_id=? AND athlete_id=?', eventId, athleteId);
    if (cur) return cur.id;
    const r = await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'registered')", eventId, athleteId);
    return r.lastInsertRowid;
}
async function findOrCreateHeat(db, eventId, heatNo, stats) {
    const h = await db.get('SELECT * FROM heat WHERE event_id=? AND heat_number=?', eventId, heatNo);
    if (h) return h;
    const r = await db.run('INSERT INTO heat (event_id, heat_number) VALUES (?,?)', eventId, heatNo);
    if (stats) stats.heats_created = (stats.heats_created || 0) + 1;
    return { id: r.lastInsertRowid, event_id: eventId, heat_number: heatNo };
}
async function relayTeamId(db, compId, sido, gender) {
    const barcode = `RELAY_NSF:${sido}:${gender}`;
    const cur = await db.get('SELECT id FROM athlete WHERE competition_id=? AND barcode=?', compId, barcode);
    if (cur) return cur.id;
    const r = await db.run('INSERT INTO athlete (competition_id, name, bib_number, team, barcode, gender, federation) VALUES (?,?,NULL,?,?,?,?)', compId, gender === 'X' ? `${sido} 혼성` : sido, sido, barcode, gender === 'X' ? 'M' : gender, sido);
    return r.lastInsertRowid;
}

/**
 * 조편성 반영. opts.apply=false 면 미리보기(DB 안 바꿈). opts.force 면 결과가 있는 종목도 다시 짠다.
 * → { sections:[{ title, label, event, status, heats, entries, unmatched }], stats, issues }
 */
async function applyDailyLanes(db, comp, parsed, opts = {}) {
    const apply = opts.apply !== false;
    const G_KO = { M: '남자', F: '여자', X: '혼성' };
    const report = { sections: [], stats: { events: 0, heats: 0, entries: 0, heats_created: 0, created: 0, unmasked: 0, bib_updated: 0, skipped: 0 }, issues: [...parsed.issues] };
    const body = async () => {
        for (const sec of parsed.sections) {
            const label = `${G_KO[sec.gender] || ''} ${sec.division || ''} ${sec.combined ? `[${sec.combined}] ` : ''}${sec.name} ${sec.round === 'preliminary' ? '예선' : sec.round === 'semifinal' ? '준결승' : '결승'}`.replace(/\s+/g, ' ').trim();
            const out = { title: sec.title, label, event: null, status: '', heats: 0, entries: 0, unmatched: [] };
            report.sections.push(out);
            if (!sec.gender) { out.status = '부 표시 없음'; report.stats.skipped++; continue; }
            const ev = await findEvent(db, comp.id, sec);
            if (!ev) { out.status = '종목을 찾지 못함'; report.stats.skipped++; continue; }
            out.event = { id: ev.id, name: ev.name, division: ev.division, round_type: ev.round_type };
            const heats = await db.all('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number', ev.id);
            let resultCount = 0;
            for (const h of heats) { const r = await db.get('SELECT COUNT(*) c FROM result WHERE heat_id=?', h.id); resultCount += Number(r.c || 0); const ha = await db.get('SELECT COUNT(*) c FROM height_attempt WHERE heat_id=?', h.id); resultCount += Number(ha.c || 0); }
            if (resultCount > 0 && !opts.force) { out.status = `결과가 있어 건너뜀(${resultCount}건)`; report.stats.skipped++; continue; }
            const stats = report.stats;
            for (const [heatNo, rows] of [...sec.heats].sort((a, b) => a[0] - b[0])) {
                const h = apply ? await findOrCreateHeat(db, ev.id, heatNo, stats) : (heats.find(x => x.heat_number === heatNo) || null);
                if (!h && !apply) stats.heats_created++;
                out.heats++; stats.heats++;
                if (apply) await db.run('DELETE FROM heat_entry WHERE heat_id=?', h.id);
                let order = 0;
                for (const row of rows) {
                    order++;
                    let athleteId = null;
                    if (sec.isRelay) {
                        athleteId = apply ? await relayTeamId(db, comp.id, row.sido, ev.gender) : (await db.get('SELECT id FROM athlete WHERE competition_id=? AND barcode=?', comp.id, `RELAY_NSF:${row.sido}:${ev.gender}`) || {}).id || null;
                        if (!athleteId) { out.unmatched.push(`${row.sido} 팀`); if (!apply) continue; }
                    } else {
                        athleteId = await matchAthlete(db, comp.id, ev, row, stats, { readOnly: !apply });
                        if (!athleteId) { out.unmatched.push(`${row.bib} ${row.name} ${row.sido}${apply ? ' (만들지 못함)' : ' (새로 만듦)'}`); if (!apply) { stats.created++; out.entries++; stats.entries++; continue; } continue; }
                    }
                    out.entries++; stats.entries++;
                    if (!apply) continue;
                    const entryId = await ensureEntry(db, ev.id, athleteId);
                    if (ev.parent_event_id) await ensureEntry(db, ev.parent_event_id, athleteId);
                    await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number, sub_group) VALUES (?,?,?,?)', h.id, entryId, row.lane != null ? row.lane : order, row.group || null);
                    if (sec.isRelay) {
                        let leg = 0;
                        for (const mem of row.members || []) {
                            leg++;
                            const mid = await matchAthlete(db, comp.id, ev, { name: mem.name, sido: row.sido, bib: mem.bib }, stats, {});
                            if (!mid) continue;
                            const cur = await db.get('SELECT 1 AS x FROM relay_member WHERE event_entry_id=? AND athlete_id=?', entryId, mid);
                            if (cur) await db.run('UPDATE relay_member SET leg_order=? WHERE event_entry_id=? AND athlete_id=?', leg, entryId, mid);
                            else await db.run('INSERT INTO relay_member (event_entry_id, athlete_id, leg_order) VALUES (?,?,?)', entryId, mid, leg);
                        }
                    }
                }
            }
            if (apply) await db.run("UPDATE event SET round_status='heats_generated' WHERE id=? AND round_status='created'", ev.id);
            out.status = apply ? '반영' : '반영 예정';
            report.stats.events++;
        }
    };
    if (apply && typeof db.transaction === 'function') await db.transaction(body)(); else await body();
    return report;
}

module.exports = { SIDO, DIVISION, sidoOf, splitNameTeam, parseDailyText, pdfToText, findEvent, matchAthlete, ensureEntry, findOrCreateHeat, relayTeamId, applyDailyLanes };
