'use strict';
/**
 * 국제대회 동기화 — 공식 결과 API(Bornan) → 우리 대회 구조·엔트리·결과 (2026-09)
 *
 *   competition.sync_source = { provider: 'bornan', base: 'https://back.results.asiangames2026.org', champ: 'AG2026', disc: 'ATH', lang: 'en',
 *                               referer: 'https://results.asiangames2026.org/', spotlight: 'KOR' }
 *
 *   setupStructure(db, comp, opts)  — 일정 → 종목(라운드·세부종목)·조(유닛)·시간표. 몇 번 돌려도 같은 결과(external_key 로 찾는다)
 *   syncEntries(db, comp, opts)     — 종목별 엔트리 → 선수(국가 = 소속)·출전·계주 팀/주자. 처음 라운드(또는 직결 결승)에 넣는다
 *   syncResults(db, comp, opts)     — 조별 결과/스타트리스트 → 레인·기록·상태코드·풍속·순위. 형식을 모르는 조는 sync_state.unknown 에 모양을 남긴다
 *   runOnce(db, comp, opts)         — 위 셋 중 필요한 것: 구조가 없으면 setup, 엔트리는 하루 한 번, 결과는 경기 중 매번
 *
 *   외부 키: event.external_key = 'W.100M--------------' (+ '#SFNL' 라운드, '#100H' 세부종목) · heat.external_key = 유닛 키 · athlete.barcode = 'BN:'+Reg (계주 팀은 국가·성별당 한 행 'RELAY_BN:KOR:M')
 *   opts.fetch(source, tail) 로 API 를 바꿔 끼울 수 있다(테스트는 픽스처).
 */
const B = require('./bornan');

const ROUND_LABEL = { preliminary: '예선', semifinal: '준결승', final: '결승' };
const nowIso = () => new Date().toISOString();

function parseSource(comp) {
    try { const s = JSON.parse(comp.sync_source || 'null'); return s && s.base && s.champ ? s : null; } catch (e) { return null; }
}
async function saveState(db, compId, patch) {
    const row = await db.get('SELECT sync_state FROM competition WHERE id=?', compId);
    let st = {}; try { st = JSON.parse((row && row.sync_state) || '{}') || {}; } catch (e) { st = {}; }
    Object.assign(st, patch);
    await db.run('UPDATE competition SET sync_state=? WHERE id=?', JSON.stringify(st), compId);
    return st;
}
function hhmm(iso) { const m = String(iso || '').match(/T(\d\d):(\d\d)/); return m ? `${m[1]}:${m[2]}` : ''; }
function ymd(iso) { return String(iso || '').slice(0, 10); }
const G_KO = { M: '남자', F: '여자', X: '혼성' };

async function loadSchedule(source, fetchFn) {
    const days = await fetchFn(source, 'schedule/days') || [];
    const units = [];
    for (const d of days) { const u = await fetchFn(source, 'schedule/daily/' + d.raw); if (Array.isArray(u)) units.push(...u); }
    return { days: days.map(d => d.raw), units };
}

/** 종목·조·시간표 만들기 (멱등) */
async function setupStructure(db, comp, opts = {}) {
    const source = opts.source || parseSource(comp);
    if (!source) throw new Error('sync_source 가 없습니다');
    const fetchFn = opts.fetch || B.fetchJson;
    const { days, units } = await loadSchedule(source, fetchFn);
    const sched = B.parseSchedule(units);
    const stats = { events: 0, rounds: 0, sub_events: 0, heats: 0, timetable: 0 };
    const dayOf = iso => { const i = days.indexOf(ymd(iso)); return i >= 0 ? i + 1 : 1; };

    const upsertEvent = async ({ external_key, name, category, gender, round_type, parent_event_id, sort_order, division }) => {
        const cur = await db.get('SELECT id FROM event WHERE competition_id=? AND external_key=?', comp.id, external_key);
        if (cur) { await db.run('UPDATE event SET name=?, category=?, sort_order=? WHERE id=?', name, category, sort_order, cur.id); return cur.id; }
        const r = await db.run("INSERT INTO event (competition_id, name, category, sort_order, gender, round_type, round_status, parent_event_id, division, external_key) VALUES (?,?,?,?,?,?,'created',?,?,?)",
            comp.id, name, category, sort_order, gender, round_type, parent_event_id || null, division || '', external_key);
        return r.lastInsertRowid;
    };
    const upsertHeat = async (eventId, unit, heatNo) => {
        const cur = await db.get('SELECT id FROM heat WHERE external_key=? AND event_id=?', unit.key, eventId);
        if (cur) { await db.run('UPDATE heat SET heat_number=?, scheduled_at=? WHERE id=?', heatNo, unit.time, cur.id); return cur.id; }
        const dup = await db.get('SELECT id FROM heat WHERE event_id=? AND heat_number=?', eventId, heatNo);
        if (dup) { await db.run('UPDATE heat SET external_key=?, scheduled_at=? WHERE id=?', unit.key, unit.time, dup.id); return dup.id; }
        const r = await db.run('INSERT INTO heat (event_id, heat_number, external_key, scheduled_at) VALUES (?,?,?,?)', eventId, heatNo, unit.key, unit.time);
        stats.heats++; return r.lastInsertRowid;
    };
    const upsertTimetable = async (day, section, time, eventName, category, round, note, eventId, date) => {
        const cur = await db.get('SELECT id FROM timetable WHERE competition_id=? AND day=? AND section=? AND time=? AND event_name=? AND category=? AND round=?', comp.id, day, section, time, eventName, category, round);
        if (cur) { await db.run('UPDATE timetable SET note=?, event_id=?, scheduled_date=? WHERE id=?', note, eventId, date, cur.id); return; }
        await db.run('INSERT INTO timetable (competition_id, day, section, time, event_name, category, round, note, sort_order, event_id, scheduled_date) VALUES (?,?,?,?,?,?,?,?,?,?,?)', comp.id, day, section, time, eventName, category, round, note, 0, eventId, date);
        stats.timetable++;
    };

    let sort = 0;
    for (const ev of sched.events) {
        sort += 10;
        const section = ev.category === 'track' || ev.category === 'relay' ? 'track' : ev.category === 'road' ? 'road' : 'field';
        if (ev.category === 'combined') {
            const parentId = await upsertEvent({ external_key: ev.key, name: ev.name, category: 'combined', gender: ev.gender, round_type: 'final', sort_order: sort });
            stats.events++;
            for (const se of ev.subEvents) {
                const subId = await upsertEvent({ external_key: `${ev.key}#${se.phase}`, name: se.name, category: se.category, gender: ev.gender, round_type: 'final', parent_event_id: parentId, sort_order: se.order });
                stats.sub_events++;
                let n = 0; for (const u of se.units) await upsertHeat(subId, u, ++n);
                const first = se.units[0];
                await upsertTimetable(dayOf(first.time), section, hhmm(first.time), `${ev.name} ${se.name}`, G_KO[ev.gender], '결승', se.units.length > 1 ? `${se.units.length}조` : '', parentId, ymd(first.time));
            }
            continue;
        }
        const rounds = ev.rounds.length ? ev.rounds : [{ phase: 'FNL-', round_type: 'final', units: [] }];
        for (const r of rounds) {
            const key = r.round_type === 'final' && rounds.length === 1 ? ev.key : `${ev.key}#${r.phase}`;
            const evId = await upsertEvent({ external_key: key, name: ev.name, category: ev.category, gender: ev.gender, round_type: r.round_type, sort_order: sort });
            if (r.round_type === 'final' && rounds.length === 1) stats.events++; else stats.rounds++;
            let n = 0; for (const u of r.units) await upsertHeat(evId, u, ++n);
            const first = r.units[0];
            if (first) await upsertTimetable(dayOf(first.time), section, hhmm(first.time), ev.name, G_KO[ev.gender], ROUND_LABEL[r.round_type], r.units.length > 1 ? `${r.units.length}조` : '', evId, ymd(first.time));
        }
    }
    // 시상식은 시간표 비고로
    for (const c of sched.ceremonies) {
        const ev = sched.events.find(e => e.key === c.event); if (!ev) continue;
        await upsertTimetable(dayOf(c.time), 'ceremony', hhmm(c.time), `${ev.name} 시상식`, G_KO[ev.gender], '', '', null, ymd(c.time));
    }
    await saveState(db, comp.id, { structure_at: nowIso(), days, units: units.length, structure: stats });
    return { stats, days, events: sched.events.length };
}

/** 선수(국가=소속) upsert. 국제대회는 같은 대회 안에서 Reg 로 식별 */
async function upsertAthlete(db, compId, a, gender) {
    const barcode = 'BN:' + a.reg;
    const cur = await db.get('SELECT id, name_alt FROM athlete WHERE competition_id=? AND barcode=?', compId, barcode);
    // 이미 있는 선수는 이름을 건드리지 않는다 — 한글 이름을 넣어 둔 선수(name_alt 에 영문 보관), 생년으로 구분해 둔 동명이인 모두 보존
    if (cur) { await db.run('UPDATE athlete SET team=?, federation=?, date_of_birth=? WHERE id=?', a.org, a.org, a.birth || '', cur.id); return cur.id; }
    // 같은 이름·국가·성별의 다른 선수(인도 'Pooja'·'Seema' 같은 외자 이름) → 선수 UNIQUE 를 피하려고 생년으로 구분
    const names = [a.name, `${a.name} (${String(a.birth || '').slice(0, 4) || a.reg})`, `${a.name} (${a.reg})`];
    for (const name of names) {
        try {
            const r = await db.run("INSERT INTO athlete (competition_id, name, bib_number, team, barcode, gender, federation, date_of_birth) VALUES (?,?,NULL,?,?,?,?,?)", compId, name, a.org, barcode, gender, a.org, a.birth || '');
            return r.lastInsertRowid;
        } catch (e) { if (!/UNIQUE|duplicate|23505/i.test(String(e.message || e.code))) throw e; }
    }
    throw new Error('선수 추가 실패(이름 중복): ' + a.name);
}
// 계주 팀은 국가·성별당 한 행(국내 대회의 '팀' 행과 같은 모델) — 4x100·4x400·혼성이 같은 행을 쓰고 주자는 출전(event_entry)마다 다르다
function teamBarcode(org, gender) { return `RELAY_BN:${org}:${gender === 'F' ? 'F' : 'M'}`; }
async function upsertTeam(db, compId, t) {
    const gender = t.gender === 'F' ? 'F' : 'M';
    const barcode = teamBarcode(t.org, gender);
    const cur = await db.get('SELECT id FROM athlete WHERE competition_id=? AND barcode=?', compId, barcode);
    if (cur) return cur.id;
    const r = await db.run("INSERT INTO athlete (competition_id, name, bib_number, team, barcode, gender, federation) VALUES (?,?,NULL,?,?,?,?)", compId, t.orgDesc || t.name, t.org, barcode, gender, t.org);
    return r.lastInsertRowid;
}
async function ensureEntry(db, eventId, athleteId) {
    const cur = await db.get('SELECT id FROM event_entry WHERE event_id=? AND athlete_id=?', eventId, athleteId);
    if (cur) return cur.id;
    const r = await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'registered')", eventId, athleteId);
    return r.lastInsertRowid;
}

/** 종목별 엔트리 → 첫 라운드에 출전 등록 (+ 계주 팀·주자) */
async function syncEntries(db, comp, opts = {}) {
    const source = opts.source || parseSource(comp);
    const fetchFn = opts.fetch || B.fetchJson;
    const events = await db.all("SELECT * FROM event WHERE competition_id=? AND external_key IS NOT NULL AND parent_event_id IS NULL", comp.id);
    // 종목 키(라운드 접미 없이) → 첫 라운드 종목
    const firstRound = new Map();
    for (const e of events) {
        const base = String(e.external_key).split('#')[0];
        const cur = firstRound.get(base);
        const rank = { preliminary: 0, semifinal: 1, final: 2 }[e.round_type] ?? 2;
        if (!cur || rank < cur.rank) firstRound.set(base, { event: e, rank });
    }
    const stats = { events: 0, athletes: 0, entries: 0, teams: 0, members: 0, spotlight: 0 };
    const spotlight = String(source.spotlight || '').toUpperCase();
    for (const [base, { event }] of firstRound) {
        const json = await fetchFn(source, 'entries/event/' + encodeURIComponent(base));
        if (!json) continue;
        const { athletes, teams } = B.parseEventEntries(json);
        stats.events++;
        for (const a of athletes) {
            const id = await upsertAthlete(db, comp.id, a, a.gender);
            stats.athletes++;
            if (event.category !== 'relay') { await ensureEntry(db, event.id, id); stats.entries++; if (spotlight && a.org === spotlight) stats.spotlight++; }
        }
        if (event.category === 'relay') {
            for (const t of teams) {
                const teamId = await upsertTeam(db, comp.id, t);
                const entryId = await ensureEntry(db, event.id, teamId); stats.teams++;
                for (const m of t.members) {
                    const aid = await upsertAthlete(db, comp.id, { reg: m.reg, name: m.name, org: t.org, birth: m.birth }, t.gender === 'X' ? 'M' : t.gender);
                    await db.run('INSERT OR IGNORE INTO relay_member (event_entry_id, athlete_id, leg_order) VALUES (?,?,?)', entryId, aid, m.order >= 1 && m.order <= 4 ? m.order : null);
                    stats.members++;
                }
                if (spotlight && t.org === spotlight) stats.spotlight++;
            }
        }
    }
    await saveState(db, comp.id, { entries_at: nowIso(), entries: stats });
    return stats;
}

/**
 * 조별 결과 → 레인·기록. 시작 전 조는 결과가 null. 결과가 있으면 그 조의 선수를 출전(해당 라운드)·조편성에 넣고 기록을 쓴다.
 *   unknownShape: 참가자 배열을 못 찾은 조 → 모양 요약을 sync_state.unknown 에 남긴다 (첫 결과가 나오면 parseResults 를 맞춘다)
 */
async function syncResults(db, comp, opts = {}) {
    const source = opts.source || parseSource(comp);
    const fetchFn = opts.fetch || B.fetchJson;
    const heats = await db.all(`SELECT h.*, e.id AS ev_id, e.category, e.round_status, e.gender FROM heat h JOIN event e ON e.id=h.event_id WHERE e.competition_id=? AND h.external_key IS NOT NULL ORDER BY h.scheduled_at`, comp.id);
    const now = Date.now();
    const windowMs = (opts.windowHours || 6) * 3600000;
    const stats = { checked: 0, updated: 0, results: 0, unknown: [] };
    const only = opts.onlyKeys ? new Set(opts.onlyKeys) : null;
    for (const h of heats) {
        if (only && !only.has(h.external_key)) continue;
        // 경기 시각 기준 [-6시간, +1시간] 창 안의 조만 읽는다 (매분 도는 스케줄러가 대회 전체를 다시 읽지 않게). opts.all 이면 전부(수동 '지금 동기화')
        const t = Date.parse(h.scheduled_at || '');
        if (!opts.all && !only && isFinite(t) && (t - now > 3600000 || now - t > windowMs)) continue;
        let json; try { json = await fetchFn(source, 'results/' + encodeURIComponent(h.external_key)); } catch (e) { stats.unknown.push({ key: h.external_key, error: e.message }); continue; }
        stats.checked++;
        if (!json) continue;
        const parsed = B.parseResults(json);
        if (!parsed.rows.length) { stats.unknown.push({ key: h.external_key, shape: parsed.note.slice(0, 400) }); continue; }
        const n = await applyUnitResults(db, comp, h, parsed, opts);
        stats.updated++; stats.results += n;
    }
    await saveState(db, comp.id, { results_at: nowIso(), results: { checked: stats.checked, updated: stats.updated, results: stats.results }, unknown: stats.unknown.slice(0, 20) });
    return stats;
}

/** 한 조의 결과 행을 우리 표에 (레인·기록·상태·풍속·순위 표시는 공용 규칙이 계산) */
async function applyUnitResults(db, comp, heat, parsed, opts = {}) {
    let written = 0;
    const isRelay = heat.category === 'relay';
    const bestByEntry = new Map();
    for (const row of parsed.rows) {
        if (!row.reg) continue;
        const barcode = isRelay ? teamBarcode(row.org || String(row.reg).slice(-5, -2), heat.gender) : 'BN:' + row.reg;
        let ath = await db.get('SELECT id FROM athlete WHERE competition_id=? AND barcode=?', comp.id, barcode);
        if (!ath) {
            // 엔트리에 없던 선수(교체 등): 이름·국가로 만든다
            const id = isRelay ? await upsertTeam(db, comp.id, { reg: row.reg, name: row.name, org: row.org, orgDesc: row.name, gender: heat.gender })
                : await upsertAthlete(db, comp.id, { reg: row.reg, name: row.name, org: row.org, birth: '' }, heat.gender === 'X' ? 'M' : heat.gender);
            ath = { id };
        }
        const entryId = await ensureEntry(db, heat.ev_id, ath.id);
        const he = await db.get('SELECT id FROM heat_entry WHERE heat_id=? AND event_entry_id=?', heat.id, entryId);
        if (!he) await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?,?,?)', heat.id, entryId, row.lane);
        else if (row.lane != null) await db.run('UPDATE heat_entry SET lane_number=? WHERE id=?', row.lane, he.id);
        const hasMark = row.mark || row.status;
        if (!hasMark) continue;
        const num = row.status ? null : B.markToNumber(row.mark, heat.category);
        const remark = [row.record, row.qual].filter(Boolean).join(' ');
        if (heat.category === 'field_height') {
            // 높이: 시기표는 API 가 따로 주므로 여기서는 최고 높이만 (result.distance_meters 로 보관 → 화면은 attempt 없이 best 표시)
            await upsertResult(db, heat.id, entryId, null, num, row.status, remark, null);
        } else if (heat.category === 'field_distance') {
            await upsertResult(db, heat.id, entryId, null, num, row.status, remark, row.wind);
        } else if (heat.category === 'combined') {
            await upsertResult(db, heat.id, entryId, null, num, row.status, remark, null);
        } else {
            await upsertResult(db, heat.id, entryId, num, null, row.status, remark, null);
        }
        written++; bestByEntry.set(entryId, num);
    }
    if (parsed.wind != null && (heat.category === 'track' || heat.category === 'relay')) {
        const w = parseFloat(parsed.wind); if (isFinite(w)) await db.run('UPDATE heat SET wind=? WHERE id=?', w, heat.id);
    }
    if (written && heat.round_status !== 'completed') {
        await db.run("UPDATE event SET round_status='in_progress' WHERE id=? AND round_status IN ('created','heats_generated')", heat.ev_id);
    }
    if (opts.onApplied) { try { await opts.onApplied({ event_id: heat.ev_id, heat_id: heat.id, written }); } catch (e) {} }
    return written;
}
async function upsertResult(db, heatId, entryId, timeSec, dist, status, remark, wind) {
    const cur = await db.get('SELECT id FROM result WHERE heat_id=? AND event_entry_id=? AND attempt_number IS NULL', heatId, entryId);
    const nowFn = db.isAsync ? 'NOW()' : "datetime('now')";
    if (cur) await db.run(`UPDATE result SET time_seconds=?, distance_meters=?, status_code=?, remark=?, wind=?, updated_at=${nowFn} WHERE id=?`, timeSec, dist, status || null, remark || '', wind, cur.id);
    else await db.run('INSERT INTO result (heat_id, event_entry_id, attempt_number, time_seconds, distance_meters, status_code, remark, wind) VALUES (?,?,NULL,?,?,?,?,?)', heatId, entryId, timeSec, dist, status || null, remark || '', wind);
}

/** 한 번 돌리기: 구조 없으면 만들고, 엔트리는 12시간마다, 결과는 매번 */
async function runOnce(db, comp, opts = {}) {
    const source = opts.source || parseSource(comp);
    if (!source) return { skipped: 'no-source' };
    let st = {}; try { st = JSON.parse(comp.sync_state || '{}') || {}; } catch (e) {}
    const out = {};
    if (!st.structure_at || opts.force === 'structure') out.structure = await setupStructure(db, comp, { ...opts, source });
    const entriesAge = st.entries_at ? Date.now() - Date.parse(st.entries_at) : Infinity;
    if (entriesAge > 12 * 3600000 || opts.force === 'entries') out.entries = await syncEntries(db, comp, { ...opts, source });
    out.results = await syncResults(db, comp, { ...opts, source });
    return out;
}

/**
 * 선수 보조 정보 넣기 (한글 이름 · PB · SB) — 사용자가 만든 표 [{ name|영문이름|reg, name_ko|한글이름, pb|PB, sb|SB }]
 *   영문 이름(대소문자·공백 무시) 또는 Reg 로 찾는다. 한글 이름을 주면 name=한글, name_alt=영문(원래 이름).
 */
async function applyAthleteInfo(db, compId, rows) {
    const norm = v => String(v || '').toLowerCase().replace(/[\s.,'-]/g, '');
    const all = await db.all("SELECT id, name, name_alt, barcode FROM athlete WHERE competition_id=? AND barcode LIKE 'BN:%'", compId);
    const byName = new Map(); for (const a of all) { byName.set(norm(a.name), a); if (a.name_alt) byName.set(norm(a.name_alt), a); }
    const byReg = new Map(all.map(a => [String(a.barcode).slice(3), a]));
    const stats = { matched: 0, unmatched: [] };
    for (const r of rows || []) {
        const get = (...ks) => { for (const k of ks) { if (r[k] != null && String(r[k]).trim() !== '') return String(r[k]).trim(); } return ''; };
        const reg = get('reg', 'Reg', 'id'); const en = get('name', '영문이름', '영문', 'name_en', 'english');
        const ko = get('name_ko', '한글이름', '한글', '이름'); const pb = get('pb', 'PB', '개인최고', '개인 최고'); const sb = get('sb', 'SB', '시즌최고', '시즌 최고');
        const a = (reg && byReg.get(reg)) || (en && byName.get(norm(en)));
        if (!a) { stats.unmatched.push(en || reg || JSON.stringify(r)); continue; }
        const nameAlt = ko ? (a.name_alt || a.name) : a.name_alt;
        await db.run('UPDATE athlete SET name=?, name_alt=?, personal_best=COALESCE(NULLIF(?, \'\'), personal_best), season_best=COALESCE(NULLIF(?, \'\'), season_best) WHERE id=?', ko || a.name, nameAlt || '', pb, sb, a.id);
        stats.matched++;
    }
    return stats;
}

module.exports = { parseSource, setupStructure, syncEntries, syncResults, applyUnitResults, runOnce, saveState, applyAthleteInfo };
