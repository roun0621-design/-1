'use strict';
/**
 * 전국체육대회 동기화 — meet.sports.or.kr 일정·엔트리·결과 → 우리 대회 구조 (2026-10-17)
 *   competition.sync_source = { provider: 'nsf', base: 'https://meet.sports.or.kr', champ: 'NSF2026', classes: ['A1','B1','C1'] }
 *   lib/intl/sync.js 의 runOnce/setupStructure/syncEntries/syncResults 가 provider 가 'nsf' 면 여기로 넘긴다.
 *
 *   구조: 종목(detailClassCd) → 라운드마다 event 한 행 (external_key 'A10301#preliminary' / '#final'), 종합경기는 부모 'A10317' + 세부종목 'A10317#A10001'(sort_order 는 WA 순서),
 *         조 = heat(external_key 'A10301/A11001', scheduled_at = 시작 시각만), 시간표는 시작 시각만(종료 시각은 쓰지 않는다 — 사용자 결정 2026-10-17).
 *   부(kind): 남자/여자 × 18세이하·대학·일반 → gender M/F + division '18세이하부' … , 성별 없는 부(혼성계주 18세이하부/대학부/일반부) → gender X.
 *         같은 종목 명단에 두 부(대학부+일반부)가 섞여 있으면 division 을 '대학·일반부' 로 표시한다.
 *   엔트리: 사이트 명단은 종목 단위(조별 아님) → 첫 라운드에 출전만 넣고, 조 배정은 조별 스타트리스트/결과가 나올 때 붙인다.
 *   선수: barcode 'NSF:'+ID_NO, team = 시도, federation = 소속(학교·팀), bib = 종목 선수번호. 계주 팀 = 시도당 한 행('RELAY_NSF:시도:성별'), 주자는 relay_member.
 *   결과: 조별 결과 HTML(순위·시도·선수명·소속·학년·기록·신기록/비고) → result(기록·상태·비고). 조 종료는 일정표 상태 '종료' 또는 전원 기록.
 */
const N = require('./nsf');
const nowIso = () => new Date().toISOString();
const G_KO = { M: '남자', F: '여자', X: '혼성' };
const ROUND_LABEL = { preliminary: '예선', semifinal: '준결승', final: '결승' };
const WA_ORDER = {
    '10종경기': ['100m', '멀리뛰기', '포환던지기', '높이뛰기', '400m', '110mH', '원반던지기', '장대높이뛰기', '창던지기', '1500m'],
    '7종경기': ['100mH', '높이뛰기', '포환던지기', '200m', '멀리뛰기', '창던지기', '800m'],
    '5종경기': ['100m', '포환던지기', '110mH', '높이뛰기', '800m'],
};
const KIND_GENDER_BY_CODE = { '03': 'M', '04': 'M', '05': 'M', '08': 'F', '09': 'F', '10': 'F' };
const KIND_NAME_BY_CODE = { '03': '18세이하부', '04': '대학부', '05': '일반부', '08': '18세이하부', '09': '대학부', '10': '일반부', '13': '18세이하부', '14': '대학부', '15': '일반부' };

function parseSource(comp) { try { const s = JSON.parse(comp.sync_source || 'null'); return s && s.provider === 'nsf' ? s : null; } catch (e) { return null; } }
async function saveState(db, compId, patch) {
    const row = await db.get('SELECT sync_state FROM competition WHERE id=?', compId);
    let st = {}; try { st = JSON.parse((row && row.sync_state) || '{}') || {}; } catch (e) { st = {}; }
    Object.assign(st, patch);
    await db.run('UPDATE competition SET sync_state=? WHERE id=?', JSON.stringify(st), compId);
    return st;
}
async function loadState(db, compId) { try { return JSON.parse(((await db.get('SELECT sync_state FROM competition WHERE id=?', compId)) || {}).sync_state || '{}') || {}; } catch (e) { return {}; } }

/** 일정 전부 읽기 → { dates, rows, events } */
async function loadSchedule(source, fetchFn) {
    const classes = Array.isArray(source.classes) && source.classes.length ? source.classes : N.CLASSES;
    const dates = new Set(); const rows = [];
    for (const cls of classes) {
        let ds = []; try { ds = await fetchFn(source, 'dates', { cls }); } catch (e) { continue; }
        for (const d of ds) { dates.add(d); const html = await fetchFn(source, 'schedule', { cls, date: d }); rows.push(...N.parseScheduleRows(html, cls)); }
    }
    return { dates: [...dates].sort(), rows, events: N.buildStructure(rows) };
}

/** 종목·조·시간표 만들기 (멱등) */
async function setupStructure(db, comp, opts = {}) {
    const source = opts.source || parseSource(comp);
    if (!source) throw new Error('sync_source 가 없습니다');
    const fetchFn = opts.fetch || N.fetchLive;
    const { dates, rows, events } = await loadSchedule(source, fetchFn);
    const stats = { events: 0, rounds: 0, sub_events: 0, heats: 0, timetable: 0 };
    const dayOf = date => { const i = dates.indexOf(String(date).replace(/-/g, '')); return i >= 0 ? i + 1 : 1; };
    const upsertEvent = async ({ external_key, name, category, gender, round_type, parent_event_id, sort_order, division }) => {
        const cur = await db.get('SELECT id FROM event WHERE competition_id=? AND external_key=?', comp.id, external_key);
        const code = require('../eventCatalog').codeOf(name);
        if (cur) { await db.run('UPDATE event SET name=?, category=?, sort_order=?, round_type=?, code=?, division=COALESCE(NULLIF(division, \'\'), ?) WHERE id=?', name, category, sort_order, round_type, code, division || '', cur.id); return cur.id; }
        const r = await db.run("INSERT INTO event (competition_id, name, category, sort_order, gender, round_type, round_status, parent_event_id, division, external_key, code) VALUES (?,?,?,?,?,?,'created',?,?,?,?)",
            comp.id, name, category, sort_order, gender, round_type, parent_event_id || null, division || '', external_key, code);
        return r.lastInsertRowid;
    };
    const upsertHeat = async (eventId, unit) => {
        const cur = await db.get('SELECT id FROM heat WHERE external_key=? AND event_id=?', unit.key, eventId);
        if (cur) { await db.run('UPDATE heat SET heat_number=?, scheduled_at=? WHERE id=?', unit.heatNo, unit.iso, cur.id); return cur.id; }
        const dup = await db.get('SELECT id FROM heat WHERE event_id=? AND heat_number=?', eventId, unit.heatNo);
        if (dup) { await db.run('UPDATE heat SET external_key=?, scheduled_at=? WHERE id=?', unit.key, unit.iso, dup.id); return dup.id; }
        const r = await db.run('INSERT INTO heat (event_id, heat_number, external_key, scheduled_at) VALUES (?,?,?,?)', eventId, unit.heatNo, unit.key, unit.iso);
        stats.heats++; return r.lastInsertRowid;
    };
    const ttTouched = new Set();
    const upsertTimetable = async (day, section, time, eventName, category, round, note, eventId, date) => {
        const cur = await db.get('SELECT id FROM timetable WHERE competition_id=? AND day=? AND section=? AND time=? AND event_name=? AND category=? AND round=?', comp.id, day, section, time, eventName, category, round);
        if (cur) { await db.run('UPDATE timetable SET note=?, event_id=?, scheduled_date=? WHERE id=?', note, eventId, date, cur.id); ttTouched.add(Number(cur.id)); return; }
        const r = await db.run('INSERT INTO timetable (competition_id, day, section, time, event_name, category, round, note, sort_order, event_id, scheduled_date) VALUES (?,?,?,?,?,?,?,?,?,?,?)', comp.id, day, section, time, eventName, category, round, note, 0, eventId, date);
        ttTouched.add(Number(r.lastInsertRowid)); stats.timetable++;
    };
    let sort = 0;
    for (const ev of events) {
        sort += 10;
        const section = ev.category === 'road' ? 'road' : (ev.category === 'track' || ev.category === 'relay' || ev.category === 'combined') ? 'track' : 'field';
        // 종목 이름은 정식명('100m'), 부는 division 칸 — 노출용 대회(종별선수권 등)와 같은 모델: 대시보드가 제목 옆 부 알약·부 필터로 나눈다 (2026-10-17 사용자 요청)
        const fullName = ev.name;
        const ttName = `${ev.name} ${ev.division}`.trim();
        if (ev.category === 'combined') {
            const parentId = await upsertEvent({ external_key: ev.key, name: fullName, category: 'combined', gender: ev.gender, round_type: 'final', sort_order: sort, division: ev.division });
            stats.events++;
            const waOrder = WA_ORDER[ev.name] || [];
            for (const se of ev.subEvents) {
                const idx = waOrder.indexOf(se.name); const order = idx >= 0 ? idx + 1 : 50 + se.order;   // 점수 키(waKeysFor)는 sort_order 순서를 쓴다 → WA 순서로
                const subId = await upsertEvent({ external_key: `${ev.key}#${se.units[0].rh}`, name: `[${ev.name.replace('경기', '')}] ${se.name}`, category: se.category, gender: ev.gender, round_type: 'final', parent_event_id: parentId, sort_order: order, division: ev.division });
                stats.sub_events++;
                for (const u of se.units) await upsertHeat(subId, { ...u, heatNo: 1 });
                const first = se.units[0];
                await upsertTimetable(dayOf(first.date), section, first.time, `${ev.name} ${se.name} ${ev.division}`.trim(), G_KO[ev.gender], '결승', '', parentId, first.date);
            }
            continue;
        }
        const rounds = ev.rounds.length ? ev.rounds : [{ type: 'final', units: [] }];
        for (const r of rounds) {
            const evId = await upsertEvent({ external_key: `${ev.key}#${r.type}`, name: fullName, category: ev.category, gender: ev.gender, round_type: r.type, sort_order: sort, division: ev.division });
            if (r.type === 'final' && rounds.length === 1) stats.events++; else stats.rounds++;
            for (const u of r.units) await upsertHeat(evId, u);
            const first = r.units[0];
            if (first) await upsertTimetable(dayOf(first.date), section, first.time, ttName, G_KO[ev.gender], ROUND_LABEL[r.type], r.units.length > 1 ? `${r.units.length}조` : '', evId, first.date);
        }
    }
    if (ttTouched.size) { for (const o of await db.all('SELECT id FROM timetable WHERE competition_id=? AND event_id IS NOT NULL', comp.id)) if (!ttTouched.has(Number(o.id))) { await db.run('DELETE FROM timetable WHERE id=?', o.id); stats.timetable_removed = (stats.timetable_removed || 0) + 1; } }
    // 조별 상태('종료')는 결과 판정에 쓴다
    const unitStatus = {}; for (const r of rows) unitStatus[`${r.dc}/${r.rh}`] = r.status;
    await saveState(db, comp.id, { structure_at: nowIso(), days: dates, units: rows.length, structure: stats, unit_status: unitStatus });
    return { stats, days: dates, events: events.length };
}

// ── 선수·팀·출전 ──
// 사람 키 = ATH_NO('MAT073100001', 선수 등록 번호) — ID_NO 는 종목 신청 번호라 같은 선수도 종목(특히 혼성계주)마다 다르다 (2026-10-17 확인: 245명이 ID_NO 둘 이상)
function personKey(p) { return 'NSF:' + (p.athNo || p.id); }
/** 옛 키(ID_NO)로 만들어진 선수 행이 있으면 사람 키 행으로 합친다(출전·계주 주자 옮기고 삭제) */
async function mergeAthlete(db, fromId, toId) {
    if (!fromId || !toId || Number(fromId) === Number(toId)) return;
    for (const en of await db.all('SELECT id, event_id FROM event_entry WHERE athlete_id=?', fromId)) {
        const dup = await db.get('SELECT id FROM event_entry WHERE event_id=? AND athlete_id=?', en.event_id, toId);
        if (dup) { await db.run('DELETE FROM relay_member WHERE event_entry_id=?', en.id); await db.run('DELETE FROM heat_entry WHERE event_entry_id=?', en.id); await db.run('DELETE FROM result WHERE event_entry_id=?', en.id); await db.run('DELETE FROM event_entry WHERE id=?', en.id); }
        else await db.run('UPDATE event_entry SET athlete_id=? WHERE id=?', toId, en.id);
    }
    for (const rm of await db.all('SELECT event_entry_id FROM relay_member WHERE athlete_id=?', fromId)) {
        const dup = await db.get('SELECT 1 AS x FROM relay_member WHERE event_entry_id=? AND athlete_id=?', rm.event_entry_id, toId);
        if (dup) await db.run('DELETE FROM relay_member WHERE event_entry_id=? AND athlete_id=?', rm.event_entry_id, fromId);
        else await db.run('UPDATE relay_member SET athlete_id=? WHERE event_entry_id=? AND athlete_id=?', toId, rm.event_entry_id, fromId);
    }
    await db.run('DELETE FROM athlete WHERE id=?', fromId);
}
async function upsertAthlete(db, compId, p, gender) {
    const barcode = personKey(p);
    const grade = /^[1-6]$/.test(p.grade) ? parseInt(p.grade, 10) : null;
    let cur = await db.get('SELECT id FROM athlete WHERE competition_id=? AND barcode=?', compId, barcode);
    // 옛 키(ID_NO)로 만든 행 정리: 사람 키 행이 없으면 키만 바꾸고, 있으면 합친다
    if (p.athNo && p.id) {
        const legacy = await db.get('SELECT id FROM athlete WHERE competition_id=? AND barcode=?', compId, 'NSF:' + p.id);
        if (legacy && !cur) { await db.run('UPDATE athlete SET barcode=? WHERE id=?', barcode, legacy.id); cur = legacy; }
        else if (legacy && cur && Number(legacy.id) !== Number(cur.id)) await mergeAthlete(db, legacy.id, cur.id);
    }
    if (cur) {
        // 이름이 '(소속)'·'(번호)' 로 구분된 행이면 원래 이름으로 되돌려 본다(같은 사람 중복이 합쳐져 자리가 비었을 때)
        const row = await db.get('SELECT name FROM athlete WHERE id=?', cur.id);
        if (row && row.name !== p.name && /\s\(.+\)$/.test(row.name)) { try { await db.run('UPDATE athlete SET name=? WHERE id=?', p.name, cur.id); } catch (e) { /* 동명이인이면 그대로 */ } }
        await db.run("UPDATE athlete SET team=?, federation=?, grade=?, bib_number=COALESCE(NULLIF(bib_number,''), ?) WHERE id=?", p.sido, p.team, grade, p.bib || null, cur.id); return cur.id;
    }
    const names = [p.name, `${p.name} (${p.team})`, `${p.name} (${p.id})`];
    for (const name of names) {
        try { const r = await db.run('INSERT INTO athlete (competition_id, name, bib_number, team, barcode, gender, federation, grade) VALUES (?,?,?,?,?,?,?,?)', compId, name, p.bib || null, p.sido, barcode, gender, p.team, grade); return r.lastInsertRowid; }
        catch (e) { if (!/UNIQUE|duplicate|23505/i.test(String(e.message || e.code))) throw e; }
    }
    throw new Error('선수 추가 실패(이름 중복): ' + p.name);
}
function teamBarcode(sido, gender) { return `RELAY_NSF:${sido}:${gender}`; }
async function upsertTeam(db, compId, sido, gender) {
    const barcode = teamBarcode(sido, gender);
    const cur = await db.get('SELECT id FROM athlete WHERE competition_id=? AND barcode=?', compId, barcode);
    if (cur) return cur.id;
    // 선수 UNIQUE(이름·팀·성별) — 혼성 계주 팀은 남자 팀(같은 시도·성별 M)과 이름이 겹치지 않게 '시도 혼성'
    const r = await db.run('INSERT INTO athlete (competition_id, name, bib_number, team, barcode, gender, federation) VALUES (?,?,NULL,?,?,?,?)', compId, gender === 'X' ? `${sido} 혼성` : sido, sido, barcode, gender === 'X' ? 'M' : gender, sido);
    return r.lastInsertRowid;
}
async function ensureEntry(db, eventId, athleteId) {
    const cur = await db.get('SELECT id FROM event_entry WHERE event_id=? AND athlete_id=?', eventId, athleteId);
    if (cur) return cur.id;
    const r = await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'registered')", eventId, athleteId);
    return r.lastInsertRowid;
}

/** 종목별 명단 → 첫 라운드 출전 (계주: 시도 팀 + 주자) */
async function syncEntries(db, comp, opts = {}) {
    const source = opts.source || parseSource(comp);
    const fetchFn = opts.fetch || N.fetchLive;
    const events = await db.all("SELECT * FROM event WHERE competition_id=? AND external_key IS NOT NULL AND parent_event_id IS NULL", comp.id);
    const firstRound = new Map();
    for (const e of events) {
        const base = String(e.external_key).split('#')[0];
        const rank = { preliminary: 0, semifinal: 1, final: 2 }[e.round_type] ?? 2;
        const cur = firstRound.get(base); if (!cur || rank < cur.rank) firstRound.set(base, { event: e, rank });
    }
    const stats = { events: 0, athletes: 0, entries: 0, teams: 0, members: 0, mixed: [] };
    for (const [dc, { event }] of firstRound) {
        const heat = await db.get('SELECT h.external_key FROM heat h JOIN event e ON e.id=h.event_id WHERE e.competition_id=? AND (e.id=? OR e.parent_event_id=?) ORDER BY h.scheduled_at, h.external_key LIMIT 1', comp.id, event.id, event.id);
        const rh = heat ? String(heat.external_key).split('/')[1] : 'A19000';
        let json; try { json = await fetchFn(source, 'entrants', { dc, rh }); } catch (e) { continue; }
        const { players } = N.parseEntrants(json);
        if (!players.length) continue;
        stats.events++;
        // 두 부가 섞인 종목(대학부+일반부) → 부 라벨
        const kinds = [...new Set(players.map(p => p.kind).filter(Boolean))];
        if (kinds.length > 1) { const label = kinds.map(k => KIND_NAME_BY_CODE[k] || k).join('·').replace(/부·/g, '·'); await db.run("UPDATE event SET division=? WHERE competition_id=? AND (external_key=? OR external_key LIKE ?)", label, comp.id, dc, dc + '#%'); stats.mixed.push(`${event.name}: ${label}`); }
        if (event.category === 'relay') {
            const bySido = new Map();
            for (const p of players) { if (!bySido.has(p.sido)) bySido.set(p.sido, []); bySido.get(p.sido).push(p); }
            for (const [sido, members] of bySido) {
                const teamId = await upsertTeam(db, comp.id, sido, event.gender);
                const entryId = await ensureEntry(db, event.id, teamId); stats.teams++;
                for (const m of members) {
                    const aid = await upsertAthlete(db, comp.id, m, KIND_GENDER_BY_CODE[m.kind] || (event.gender === 'F' ? 'F' : 'M'));
                    await db.run('INSERT OR IGNORE INTO relay_member (event_entry_id, athlete_id, leg_order) VALUES (?,?,NULL)', entryId, aid); stats.members++;
                }
            }
        } else {
            for (const p of players) {
                const id = await upsertAthlete(db, comp.id, p, KIND_GENDER_BY_CODE[p.kind] || event.gender);
                stats.athletes++; await ensureEntry(db, event.id, id); stats.entries++;
            }
        }
    }
    await saveState(db, comp.id, { entries_at: nowIso(), entries: stats });
    return stats;
}

// ── 결과 ──
async function findAthlete(db, comp, event, row) {
    if (event.category === 'relay') { const t = await db.get('SELECT id FROM athlete WHERE competition_id=? AND barcode=?', comp.id, teamBarcode(row.sido || row.name, event.gender)); return t ? t.id : await upsertTeam(db, comp.id, row.sido || row.name, event.gender); }
    const base = String(event.external_key || '').split('#')[0];
    // 같은 종목(어느 라운드든)에 출전한 선수 중 이름·시도가 같은 사람
    let a = await db.get(`SELECT a.id FROM athlete a WHERE a.competition_id=? AND a.name=? AND a.team=? AND a.barcode LIKE 'NSF:%' AND EXISTS (
        SELECT 1 FROM event_entry ee JOIN event e ON e.id=ee.event_id WHERE ee.athlete_id=a.id AND (e.external_key LIKE ? OR e.external_key=?))`, comp.id, row.name, row.sido, base + '#%', base);
    if (!a) a = await db.get("SELECT id FROM athlete WHERE competition_id=? AND name=? AND team=? AND barcode LIKE 'NSF:%'", comp.id, row.name, row.sido);
    if (a) return a.id;
    // 명단에 없던 선수(교체 등)
    return upsertAthlete(db, comp.id, { id: `X${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`, athNo: '', name: row.name, sido: row.sido, team: row.team, grade: row.grade, bib: '' }, event.gender === 'X' ? 'M' : event.gender);
}
async function upsertResult(db, heatId, entryId, timeSec, dist, status, remark) {
    const cur = await db.get('SELECT id FROM result WHERE heat_id=? AND event_entry_id=? AND attempt_number IS NULL', heatId, entryId);
    const nowFn = db.isAsync ? 'NOW()' : "datetime('now')";
    if (cur) await db.run(`UPDATE result SET time_seconds=?, distance_meters=?, status_code=?, remark=?, updated_at=${nowFn} WHERE id=?`, timeSec, dist, status || null, remark || '', cur.id);
    else await db.run('INSERT INTO result (heat_id, event_entry_id, attempt_number, time_seconds, distance_meters, status_code, remark) VALUES (?,?,NULL,?,?,?,?)', heatId, entryId, timeSec, dist, status || null, remark || '');
}

/** 조별 결과·스타트리스트 → 조 배정·기록. 읽는 창: 시작 2시간 전 ~ 12시간 뒤 (opts.all 이면 전부) */
async function syncResults(db, comp, opts = {}) {
    const source = opts.source || parseSource(comp);
    const fetchFn = opts.fetch || N.fetchLive;
    const heats = await db.all(`SELECT h.*, e.id AS ev_id, e.name AS ev_name, e.category, e.round_status, e.gender, e.parent_event_id, e.external_key AS ev_key FROM heat h JOIN event e ON e.id=h.event_id WHERE e.competition_id=? AND h.external_key IS NOT NULL ORDER BY h.scheduled_at`, comp.id);
    const now = Date.now();
    const st = await loadState(db, comp.id);
    const unitStatus = st.unit_status || {};
    const stats = { checked: 0, updated: 0, results: 0, startlists: 0, errors: [] };
    for (const h of heats) {
        const t = Date.parse(h.scheduled_at || '');
        if (!opts.all && isFinite(t)) { if (now - t > 12 * 3600000 || t - now > 2 * 3600000) continue; }
        const [dc, rh] = String(h.external_key).split('/');
        let html; try { html = await fetchFn(source, 'detail', { cls: dc.slice(0, 2), dc, rh, pg: h.category === 'relay' ? 'T' : 'I', confirm: unitStatus[h.external_key] === '종료' ? 'Y' : 'N' }); } catch (e) { stats.errors.push(`${h.external_key}: ${e.message}`); continue; }
        stats.checked++;
        const d = N.parseDetail(html);
        const event = { id: h.ev_id, category: h.category, gender: h.gender, external_key: h.ev_key, parent_event_id: h.parent_event_id };
        // 스타트리스트가 조 단위면(종목 전체 명단보다 적으면) 조 배정으로 쓴다
        if (d.startlist.length && !d.results.length) {
            // 사이트의 스타트리스트가 종목 전체 명단(첫 라운드 출전 수와 같음)이면 조 배정이 아니다 — 결승(출전 0)에 전체 명단을 넣는 일이 없게 첫 라운드 기준으로 비교
            const base = String(h.ev_key || '').split('#')[0];
            const total = await db.get(`SELECT MAX(n) c FROM (SELECT COUNT(*) n FROM event_entry ee JOIN event e ON e.id=ee.event_id WHERE e.competition_id=? AND (e.external_key=? OR e.external_key LIKE ?) GROUP BY e.id)`, comp.id, base, base + '#%');
            if (Number(total && total.c || 0) > 0 && d.startlist.length < Number(total.c)) {
                let lane = 0;
                for (const row of d.startlist) { const aid = await findAthlete(db, comp, event, row); const entryId = await ensureEntry(db, h.ev_id, aid); const he = await db.get('SELECT id FROM heat_entry WHERE heat_id=? AND event_entry_id=?', h.id, entryId); lane++; if (!he) await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?,?,?)', h.id, entryId, row.lane || lane); }
                stats.startlists++;
            }
            continue;
        }
        if (!d.results.length) continue;
        let written = 0, order = 0;
        for (const row of d.results) {
            order++;
            const aid = await findAthlete(db, comp, event, row);
            const entryId = await ensureEntry(db, h.ev_id, aid);
            const he = await db.get('SELECT id FROM heat_entry WHERE heat_id=? AND event_entry_id=?', h.id, entryId);
            if (!he) await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?,?,?)', h.id, entryId, row.lane || order);
            const status = N.statusOf(row.mark, row.remark);
            const num = status ? null : N.markToNumber(row.mark, h.category);
            if (!status && num == null) { await db.run('DELETE FROM result WHERE heat_id=? AND event_entry_id=? AND attempt_number IS NULL', h.id, entryId); continue; }
            const remark = String(row.remark || '').replace(/^(DQ|DNS|DNF|NM)$/i, '');
            if (h.category === 'track' || h.category === 'relay' || h.category === 'road') await upsertResult(db, h.id, entryId, num, null, status, remark);
            else await upsertResult(db, h.id, entryId, null, num, status, remark);
            if (row.rank && h.category === 'field_height') await db.run('UPDATE event_entry SET manual_rank=? WHERE id=?', row.rank, entryId);
            written++;
            // 종합경기 세부종목 → 부모 종합표
            if (h.parent_event_id && opts.calc && typeof opts.calc.calcWAPoints === 'function') {
                try {
                    const parent = await db.get('SELECT * FROM event WHERE id=?', h.parent_event_id);
                    const parentEntryId = await ensureEntry(db, h.parent_event_id, aid);
                    const subs = await db.all('SELECT id FROM event WHERE parent_event_id=? ORDER BY sort_order, id', h.parent_event_id);
                    const idx = subs.findIndex(s => Number(s.id) === Number(h.ev_id)); const sorder = idx >= 0 ? idx + 1 : 1;
                    const keys = typeof opts.calc.waKeysFor === 'function' ? opts.calc.waKeysFor(parent) : [];
                    const pts = status || num == null ? 0 : opts.calc.calcWAPoints(keys[sorder - 1], num);
                    await db.run(`INSERT INTO combined_score (event_entry_id, sub_event_name, sub_event_order, raw_record, wa_points, status_code) VALUES (?,?,?,?,?,?)
                        ON CONFLICT(event_entry_id, sub_event_order) DO UPDATE SET raw_record=excluded.raw_record, wa_points=excluded.wa_points, sub_event_name=excluded.sub_event_name, status_code=excluded.status_code`,
                        parentEntryId, String(h.ev_name || '').replace(/^\[.*?\]\s*/, ''), sorder, status ? null : num, pts, status || '');
                } catch (e) { /* 종합표 실패는 세부종목 결과를 막지 않는다 */ }
            }
        }
        if (d.wind != null && (h.category === 'track' || h.category === 'relay')) await db.run('UPDATE heat SET wind=? WHERE id=?', d.wind, h.id);
        if (written) {
            stats.updated++; stats.results += written;
            if (h.round_status !== 'completed') { await db.run("UPDATE event SET round_status='in_progress' WHERE id=? AND round_status IN ('created','heats_generated')", h.ev_id); if (h.parent_event_id) await db.run("UPDATE event SET round_status='in_progress' WHERE id=? AND round_status IN ('created','heats_generated')", h.parent_event_id); }
            // 조 종료: 일정표 '종료' 또는 (트랙·계주·로드) 전원 기록/상태
            const allIn = ['track', 'relay', 'road'].includes(h.category) && d.results.every(r => r.mark || N.statusOf(r.mark, r.remark));
            const flags = st.heat_flags || {};
            if (unitStatus[h.external_key] === '종료' || d.finished && allIn) {
                flags[String(h.id)] = 'done'; st.heat_flags = flags; await saveState(db, comp.id, { heat_flags: flags });
                const sibs = await db.all('SELECT id FROM heat WHERE event_id=?', h.ev_id);
                let completed = false;
                if (sibs.every(x => flags[String(x.id)] === 'done') && h.round_status !== 'completed') {
                    await db.run("UPDATE event SET round_status='completed' WHERE id=? AND round_status<>'completed'", h.ev_id);
                    if (h.parent_event_id) { const subs = await db.all('SELECT id, round_status FROM event WHERE parent_event_id=?', h.parent_event_id); if (subs.every(s => s.round_status === 'completed' || s.id === h.ev_id)) { await db.run("UPDATE event SET round_status='completed' WHERE id=?", h.parent_event_id); completed = true; } }
                    else completed = true;
                }
                if (opts.onApplied) { try { await opts.onApplied({ event_id: h.parent_event_id && completed ? h.parent_event_id : h.ev_id, heat_id: h.id, written, completed, official: true, parent_event_id: h.parent_event_id || null }); } catch (e) {} }
            } else if (opts.onApplied) { try { await opts.onApplied({ event_id: h.ev_id, heat_id: h.id, written, completed: false, official: false, parent_event_id: h.parent_event_id || null }); } catch (e) {} }
        }
    }
    await saveState(db, comp.id, { results_at: nowIso(), results: { checked: stats.checked, updated: stats.updated, results: stats.results, startlists: stats.startlists }, errors: stats.errors.slice(0, 20) });
    return stats;
}

/** 일정표 상태(미종료/종료)만 다시 읽기 — 10분마다 */
async function refreshUnitStatus(db, comp, source, fetchFn) {
    const { rows } = await loadSchedule(source, fetchFn);
    const unitStatus = {}; for (const r of rows) unitStatus[`${r.dc}/${r.rh}`] = r.status;
    await saveState(db, comp.id, { unit_status: unitStatus, status_at: nowIso() });
    return unitStatus;
}

function shiftYmd(ymd, n) { const d = new Date(String(ymd).slice(0, 10) + 'T00:00:00Z'); if (!isFinite(d)) return String(ymd); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
async function runOnce(db, comp, opts = {}) {
    const source = opts.source || parseSource(comp);
    if (!source) return { skipped: 'no-source' };
    const st = await loadState(db, comp.id);
    const out = {};
    const TZ = require('../tz');
    const today = TZ.todayIn(TZ.compTz(comp));
    const inPeriod = (!comp.start_date || today >= shiftYmd(comp.start_date, -1)) && (!comp.end_date || today <= shiftYmd(comp.end_date, 1));
    const age = k => st[k] ? Date.now() - Date.parse(st[k]) : Infinity;
    if (!st.structure_at || opts.force === 'structure' || (inPeriod && age('structure_at') > 30 * 60000)) out.structure = await setupStructure(db, comp, { ...opts, source });
    else if (inPeriod && age('status_at') > 10 * 60000 && age('structure_at') > 10 * 60000) { try { await refreshUnitStatus(db, comp, source, opts.fetch || N.fetchLive); } catch (e) {} }
    if (age('entries_at') > (inPeriod ? 1 : 12) * 3600000 || opts.force === 'entries') out.entries = await syncEntries(db, comp, { ...opts, source });
    out.results = await syncResults(db, comp, { ...opts, source });
    return out;
}

module.exports = { parseSource, loadSchedule, setupStructure, syncEntries, syncResults, refreshUnitStatus, runOnce, WA_ORDER };
