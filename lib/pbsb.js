'use strict';
/**
 * PB/SB 자동 누적 (C4, 2026-10-09)
 *   종목이 완료되면 그 종목의 각 출전(event_entry)에 대해 이번 대회 최고 기록을 뽑아 엔트리 PB(personal_best)·SB(season_best) 보다 좋으면 갱신한다.
 *   새 대회를 만들면 같은 조직 안의 지난 대회에서 같은 선수(이름 + 생년월일, 생년월일이 없으면 이름 + 소속)·같은 종목(사전 코드)의 PB/SB 를 끌어온다.
 *   풍속 규제 종목(100·200·100H·110H·LJ·TJ)은 +2.0 m/s 초과 기록은 PB/SB 로 치지 않는다. DQ/DNS/DNF 등 상태 코드가 있는 결과도 제외.
 *   PB 는 종목별 기록이므로 event_entry 에 둔다(athlete.personal_best 는 화면 표시용 보조 — 선수가 한 종목만 뛰면 같이 맞춘다).
 */
const { parseRecordValue } = require('./recordCompare');
const EventCatalog = require('./eventCatalog');

const WIND_LIMIT = 2.0;
const LOWER = new Set(['track', 'relay', 'road']);

function fmtTime(s) {
    if (s == null || !isFinite(s)) return '';
    const dp = 2;
    if (s >= 3600) { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s - h * 3600 - m * 60; return `${h}:${String(m).padStart(2, '0')}:${r < 10 ? '0' : ''}${r.toFixed(dp)}`; }
    if (s >= 60) { const m = Math.floor(s / 60), r = s - m * 60; return `${m}:${r < 10 ? '0' : ''}${r.toFixed(dp)}`; }
    return s.toFixed(dp);
}
function fmtMark(event, num) { return LOWER.has(event.category) ? fmtTime(num) : Number(num).toFixed(2); }
function isBetter(event, a, b) { if (a == null) return false; if (b == null) return true; return LOWER.has(event.category) ? a < b - 1e-9 : a > b + 1e-9; }
function codeOfEvent(event) { return event.code || EventCatalog.codeOf(event.name); }
function yearOf(comp) { return String(comp && comp.start_date || '').slice(0, 4); }

/** 이 종목에서 출전별 최고 기록 { event_entry_id → num } (풍속 초과·상태 코드 제외) */
async function bestMarksInEvent(db, event) {
    const out = new Map();
    const windy = EventCatalog.isWindAffected(codeOfEvent(event));
    if (LOWER.has(event.category)) {
        const rows = await db.all(`SELECT r.event_entry_id, r.time_seconds, r.status_code, r.wind AS r_wind, h.wind AS h_wind
                                   FROM result r JOIN heat h ON h.id=r.heat_id WHERE h.event_id=? AND r.time_seconds > 0`, event.id);
        for (const r of rows) {
            if (r.status_code && String(r.status_code).trim()) continue;
            if (windy) { const w = (typeof r.r_wind === 'number' && isFinite(r.r_wind)) ? r.r_wind : (r.h_wind != null && r.h_wind !== '' ? parseFloat(r.h_wind) : null); if (w != null && isFinite(w) && w > WIND_LIMIT) continue; }
            const cur = out.get(r.event_entry_id); if (cur == null || r.time_seconds < cur) out.set(r.event_entry_id, r.time_seconds);
        }
    } else if (event.category === 'field_distance') {
        const rows = await db.all(`SELECT r.event_entry_id, r.distance_meters, r.status_code, r.wind AS r_wind, h.wind AS h_wind
                                   FROM result r JOIN heat h ON h.id=r.heat_id WHERE h.event_id=? AND r.distance_meters > 0`, event.id);
        for (const r of rows) {
            if (r.status_code && String(r.status_code).trim()) continue;
            if (windy) { const w = (typeof r.r_wind === 'number' && isFinite(r.r_wind)) ? r.r_wind : (r.h_wind != null && r.h_wind !== '' ? parseFloat(r.h_wind) : null); if (w != null && isFinite(w) && w > WIND_LIMIT) continue; }
            const cur = out.get(r.event_entry_id); if (cur == null || r.distance_meters > cur) out.set(r.event_entry_id, r.distance_meters);
        }
    } else if (event.category === 'field_height') {
        const rows = await db.all(`SELECT ha.event_entry_id, MAX(ha.bar_height) AS best FROM height_attempt ha JOIN heat h ON h.id=ha.heat_id
                                   WHERE h.event_id=? AND ha.result_mark='O' GROUP BY ha.event_entry_id`, event.id);
        for (const r of rows) if (r.best > 0) out.set(r.event_entry_id, r.best);
    }
    return out;
}

/** 종목 완료 시: 출전별 PB/SB 갱신. 반환 { pb, sb } 갱신 건수 */
async function updateEntryMarks(db, event) {
    if (!event || event.category === 'combined') return { pb: 0, sb: 0 };
    const comp = await db.get('SELECT id, start_date FROM competition WHERE id=?', event.competition_id);
    const year = yearOf(comp);
    const best = await bestMarksInEvent(db, event);
    let pb = 0, sb = 0;
    const nowExpr = db.isAsync ? 'NOW()' : "datetime('now')";
    for (const [entryId, num] of best) {
        const ee = await db.get(`SELECT ee.id, ee.athlete_id, ee.personal_best, ee.season_best, a.personal_best AS a_pb, a.season_best AS a_sb
                                 FROM event_entry ee JOIN athlete a ON a.id=ee.athlete_id WHERE ee.id=?`, entryId);
        if (!ee) continue;
        const text = fmtMark(event, num);
        const curPb = parseRecordValue(ee.personal_best || ee.a_pb || ''), curSb = parseRecordValue(ee.season_best || ee.a_sb || '');
        const sets = [];
        if (isBetter(event, num, curPb == null || !isFinite(curPb) ? null : curPb)) { sets.push(['personal_best', text]); pb++; }
        if (year && isBetter(event, num, curSb == null || !isFinite(curSb) ? null : curSb)) { sets.push(['season_best', text]); sb++; }
        if (!sets.length) continue;
        await db.run(`UPDATE event_entry SET ${sets.map(([c]) => `${c}=?`).join(', ')} WHERE id=?`, ...sets.map(([, v]) => v), ee.id);
        // 선수가 이 대회에서 이 종목 하나만 뛰면 선수 행의 표시용 PB/SB 도 맞춘다
        const cnt = await db.get('SELECT COUNT(*) AS c FROM event_entry ee JOIN event e ON e.id=ee.event_id WHERE ee.athlete_id=? AND e.parent_event_id IS NULL', ee.athlete_id);
        if (cnt && Number(cnt.c) === 1) await db.run(`UPDATE athlete SET ${sets.map(([c]) => `${c}=?`).join(', ')} WHERE id=?`, ...sets.map(([, v]) => v), ee.athlete_id);
    }
    return { pb, sb };
}

/** 새 대회: 같은 조직의 지난 대회에서 같은 선수·같은 종목의 PB/SB 를 비어 있는 엔트리에 채운다. 반환 { entries, pb, sb } */
async function carryOverMarks(db, competition) {
    const org = Number(competition.organization_id || 1);
    const year = yearOf(competition);
    const entries = await db.all(`SELECT ee.id, ee.personal_best, ee.season_best, e.id AS event_id, e.name AS event_name, e.code, e.gender, e.category,
                                         a.name, a.team, a.gender AS a_gender, a.date_of_birth, a.personal_best AS a_pb, a.season_best AS a_sb
                                  FROM event_entry ee JOIN event e ON e.id=ee.event_id JOIN athlete a ON a.id=ee.athlete_id
                                  WHERE e.competition_id=? AND e.parent_event_id IS NULL AND e.category<>'relay' AND e.category<>'combined'`, competition.id);
    let pb = 0, sb = 0, touched = 0;
    for (const ee of entries) {
        const havePb = (ee.personal_best || ee.a_pb || '').trim(), haveSb = (ee.season_best || ee.a_sb || '').trim();
        if (havePb && haveSb) continue;
        const code = ee.code || EventCatalog.codeOf(ee.event_name); if (!code) continue;
        // 같은 조직·이전 대회·같은 선수·같은 종목 코드
        const prev = await db.all(`SELECT ee2.personal_best, ee2.season_best, c.start_date, a2.personal_best AS a_pb, a2.season_best AS a_sb, e2.name AS event_name, e2.code
                                   FROM event_entry ee2 JOIN event e2 ON e2.id=ee2.event_id JOIN competition c ON c.id=e2.competition_id JOIN athlete a2 ON a2.id=ee2.athlete_id
                                   WHERE c.organization_id=? AND c.id<>? AND c.start_date < ? AND e2.parent_event_id IS NULL AND a2.name=? AND a2.gender=?
                                     AND ((? <> '' AND a2.date_of_birth = ?) OR (? = '' AND a2.team = ?))
                                   ORDER BY c.start_date DESC`, org, competition.id, competition.start_date, ee.name, ee.a_gender, ee.date_of_birth || '', ee.date_of_birth || '', ee.date_of_birth || '', ee.team || '');
        const lower = LOWER.has(ee.category);
        let bestPb = null, bestPbText = '', bestSb = null, bestSbText = '';
        for (const p of prev) {
            // 종목 코드가 같은 엔트리만 (e2.code 가 없을 수 있어 JS 에서 거른다)
            if ((p.code || EventCatalog.codeOf(p.event_name)) !== code) continue;
            const cand = [[p.personal_best || p.a_pb, 'pb'], [p.season_best || p.a_sb, 'sb']];
            for (const [v, kind] of cand) {
                const n = parseRecordValue(v); if (n == null || !isFinite(n) || n <= 0) continue;
                if (kind === 'pb' || String(p.start_date).slice(0, 4) === year) {
                    if (bestPb == null || (lower ? n < bestPb : n > bestPb)) { bestPb = n; bestPbText = String(v); }
                    if (String(p.start_date).slice(0, 4) === year && (bestSb == null || (lower ? n < bestSb : n > bestSb))) { bestSb = n; bestSbText = String(v); }
                }
            }
        }
        const sets = [];
        if (!havePb && bestPbText) { sets.push(['personal_best', bestPbText]); pb++; }
        if (!haveSb && bestSbText) { sets.push(['season_best', bestSbText]); sb++; }
        if (!sets.length) continue;
        await db.run(`UPDATE event_entry SET ${sets.map(([c]) => `${c}=?`).join(', ')} WHERE id=?`, ...sets.map(([, v]) => v), ee.id);
        touched++;
    }
    return { entries: touched, pb, sb };
}

module.exports = { updateEntryMarks, carryOverMarks, bestMarksInEvent, fmtMark, fmtTime };
