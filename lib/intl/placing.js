'use strict';
/**
 * 순위·진출 판정 (2026-09-24)
 *   placesInHeats(db, heatIds)                조 안 순위 Map('heatId:entryId' → place) — 트랙·도로·계주 시간 오름차순, 필드·종합 내림차순, 상태코드 제외, 동기록 같은 등수
 *   spotStatus(db, compId, spot, events)      관심 국가(KOR) 선수의 종목별 상태 → Map(eventId → { kind, label, short, count, places, rows })
 *     kind: 'qualified' (다음 라운드 진출) | 'out' (탈락) | 'final' (결승 종료 — 최종 순위) | 'status' (DNF·DQ 만) | null
 *   qualRuleKo(text)                          "First 3 in each heat (Q) and next 2 fastest (q) advance to Final" → "각 조 3위까지(Q) + 기록 상위 2(q) 결승 진출"
 */
async function placesInHeats(db, heatIds) {
    const out = new Map();
    if (!heatIds.length) return out;
    const R = require('../../public/lib/ranking');
    const hph = heatIds.map(() => '?').join(',');
    const cat = new Map();
    for (const h of await db.all(`SELECT h.id, e.category FROM heat h JOIN event e ON e.id=h.event_id WHERE h.id IN (${hph})`, ...heatIds)) cat.set(Number(h.id), h.category);
    const best = new Map();   // 'heat:entry' → { time, dist, status }
    const upd = (hid, eid, t, d, st) => {
        const k = hid + ':' + eid, c = best.get(k) || { heat_id: hid, entry_id: eid, time: null, dist: null, status: null };
        if (st) c.status = st;
        if (t != null && (c.time == null || t < c.time)) c.time = t;
        if (d != null && (c.dist == null || d > c.dist)) c.dist = d;
        best.set(k, c);
    };
    for (const r of await db.all(`SELECT heat_id, event_entry_id, time_seconds, distance_meters, status_code FROM result WHERE heat_id IN (${hph})`, ...heatIds)) upd(Number(r.heat_id), Number(r.event_entry_id), r.time_seconds, r.distance_meters, r.status_code);
    for (const r of await db.all(`SELECT heat_id, event_entry_id, MAX(bar_height) AS h FROM height_attempt WHERE heat_id IN (${hph}) AND result_mark='O' GROUP BY heat_id, event_entry_id`, ...heatIds)) upd(Number(r.heat_id), Number(r.event_entry_id), null, r.h, null);
    const byHeat = new Map();
    for (const b of best.values()) { if (!byHeat.has(b.heat_id)) byHeat.set(b.heat_id, []); byHeat.get(b.heat_id).push(b); }
    for (const [hid, rows] of byHeat) {
        const field = /^field/.test(cat.get(hid) || '') || cat.get(hid) === 'combined';   // 필드·종합(점수)은 클수록 좋다
        const val = b => field ? b.dist : b.time;
        const cmp = R.withStatusLast((a, b) => {
            const va = val(a), vb = val(b);
            if (va == null && vb == null) return 0; if (va == null) return 1; if (vb == null) return -1;
            return field ? vb - va : va - vb;
        });
        rows.forEach(b => { b.status_code = b.status; });
        rows.sort(cmp);
        let place = 0;
        rows.forEach((b, i) => {
            if (b.status || val(b) == null) return;
            if (i === 0 || cmp(rows[i - 1], b) !== 0) place = i + 1;    // 동기록은 같은 등수
            out.set(b.heat_id + ':' + b.entry_id, place);
        });
    }
    return out;
}


// 비고('GR q' · 'NR PB Q' …)에서 화면에 붙일 기록 태그 하나 — 우선순위 WR > AR > GR > NR > PB > SB
function recordTag(remark) { const t = String(remark || '').split(/\s+/); for (const k of ['WR', 'AR', 'GR', 'NR', 'PB', 'SB']) if (t.includes(k)) return k; return null; }
function qualRuleKo(text) {
    const t = String(text || '').trim(); if (!t) return '';
    const m = t.match(/First (\d+) in each heat \(Q\)(?: and next (\d+) fastest \(q\))? advance to (Final|Semi-?final)/i);
    if (!m) return t;
    const to = /semi/i.test(m[3]) ? '준결승' : '결승';
    return `각 조 ${m[1]}위까지(Q)${m[2] ? ` + 기록 상위 ${m[2]}(q)` : ''} ${to} 진출`;
}
const ROUND_NEXT = { preliminary: 'semifinal', semifinal: 'final' };
const ROUND_KO = { preliminary: '예선', semifinal: '준결승', final: '결승' };
async function spotStatus(db, compId, spot, events) {
    const out = new Map();
    if (!spot || !events.length) return out;
    const ids = events.map(e => Number(e.id)), ph = ids.map(() => '?').join(',');
    // 관심 국가 선수의 결과 (조 번호·레인·비고 Q/q·상태)
    const rows = await db.all(`SELECT ee.event_id, ee.id AS entry_id, a.id AS athlete_id, a.name, a.name_alt, a.barcode, h.id AS heat_id, h.heat_number, he.lane_number,
            r.time_seconds, r.distance_meters, r.status_code, r.remark
        FROM event_entry ee JOIN athlete a ON a.id=ee.athlete_id JOIN event e ON e.id=ee.event_id
        LEFT JOIN heat_entry he ON he.event_entry_id=ee.id LEFT JOIN heat h ON h.id=he.heat_id
        LEFT JOIN result r ON r.event_entry_id=ee.id AND r.heat_id=h.id AND r.attempt_number IS NULL
        WHERE ee.event_id IN (${ph}) AND a.team=?`, ...ids, spot);
    // 필드(시도별)·높이 결과는 attempt 행 → 최고만
    const bestAtt = await db.all(`SELECT r.event_entry_id, r.heat_id, MIN(r.time_seconds) AS t, MAX(r.distance_meters) AS d FROM result r JOIN event_entry ee ON ee.id=r.event_entry_id JOIN athlete a ON a.id=ee.athlete_id
        WHERE ee.event_id IN (${ph}) AND a.team=? AND r.attempt_number IS NOT NULL GROUP BY r.event_entry_id, r.heat_id`, ...ids, spot);
    const hj = await db.all(`SELECT ha.event_entry_id, ha.heat_id, MAX(ha.bar_height) AS d FROM height_attempt ha JOIN event_entry ee ON ee.id=ha.event_entry_id JOIN athlete a ON a.id=ee.athlete_id
        WHERE ee.event_id IN (${ph}) AND a.team=? AND ha.result_mark='O' GROUP BY ha.event_entry_id, ha.heat_id`, ...ids, spot);
    for (const r of rows) {
        if (r.time_seconds == null && r.distance_meters == null) {
            const bA = bestAtt.find(x => Number(x.event_entry_id) === Number(r.entry_id) && Number(x.heat_id) === Number(r.heat_id));
            const bH = hj.find(x => Number(x.event_entry_id) === Number(r.entry_id) && Number(x.heat_id) === Number(r.heat_id));
            if (bA) { r.time_seconds = bA.t; r.distance_meters = bA.d && bA.d > 0 ? bA.d : null; }
            if (bH) r.distance_meters = bH.d;
        }
    }
    const heatIds = [...new Set(rows.map(r => r.heat_id).filter(Boolean))];
    const placeOf = await placesInHeats(db, heatIds);
    const baseOf = e => String(e.external_key || '').split('#')[0] || null;
    // 다음 라운드 판단은 대회의 모든 라운드로 — 넘어온 events 는 한국 선수 출전이 있는 라운드뿐이라(준결승은 스타트 리스트 전엔 출전이 없다) '결승 진출'로 잘못 나왔다 (2026-09-24)
    const allRounds = await db.all('SELECT id, external_key, round_type FROM event WHERE competition_id=?', compId);
    for (const e of events) {
        const my = rows.filter(r => Number(r.event_id) === Number(e.id));
        if (!my.length) continue;
        const done = e.round_status === 'completed';
        const withRes = my.filter(r => r.time_seconds != null || r.distance_meters != null || r.status_code);
        if (!withRes.length) continue;
        const list = withRes.map(r => ({ entry_id: r.entry_id, name: r.name, name_alt: r.name_alt, is_team: /^RELAY_/.test(String(r.barcode || '')), heat_number: r.heat_number, lane: r.lane_number,
            place: placeOf.get(r.heat_id + ':' + r.entry_id) || null, mark: r.time_seconds != null ? r.time_seconds : r.distance_meters, is_time: r.time_seconds != null,
            status_code: r.status_code || null, qual: (String(r.remark || '').match(/\b(Q|q)\b/) || [null])[0], tag: recordTag(r.remark) }));
        const roundKo = ROUND_KO[e.round_type] || '';
        if (e.parent_event_id) {   // 7종·10종 세부종목: 조 순위일 뿐 — 메달·진출 칩 없음 (부모 종목 카드가 종합 순위를 말한다)
            out.set(Number(e.id), { kind: 'sub', label: '', short: '', places: [], count: 0, rows: list });
            continue;
        }
        if (e.round_type === 'final') {
            if (!done) continue;
            const places = list.filter(x => !x.status_code && x.place).map(x => x.place).sort((p, q) => p - q);
            const st = list.filter(x => x.status_code).map(x => x.status_code);
            const label = places.length ? places.slice(0, 2).map(p => p + '위').join(' · ') + (places.length > 2 ? ` 외 ${places.length - 2}` : '') : (st[0] || '');
            out.set(Number(e.id), { kind: 'final', label, short: label, places, count: places.length, rows: list });
        } else {
            // 다음 라운드가 있나 (같은 종목 키의 준결승/결승)
            const base = baseOf(e);
            const hasSemi = allRounds.some(x => baseOf(x) === base && x.round_type === 'semifinal');
            const next = e.round_type === 'preliminary' && hasSemi ? '준결승' : '결승';
            const q = list.filter(x => x.qual);
            if (q.length) out.set(Number(e.id), { kind: 'qualified', label: `${next} 진출${q.length > 1 ? ' · ' + q.length : ''}`, short: `${next} 진출`, count: q.length, rows: list, next });
            else if (done) out.set(Number(e.id), { kind: 'out', label: `${roundKo} 탈락`, short: `${roundKo} 탈락`, count: list.length, rows: list, next });
        }
    }
    return out;
}

module.exports = { placesInHeats, spotStatus, qualRuleKo, recordTag };
