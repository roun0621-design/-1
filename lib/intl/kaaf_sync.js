'use strict';
/**
 * 대한육상연맹 실시간 결과(result.kaaf.or.kr) → 전국체전(provider nsf) 대회의 조·기록 (2026-10-17)
 *   competition.sync_source.results = { provider: 'kaaf', to_cd: 'E010031092', year: '2026', url }
 *   nsf_sync.runOnce 가 results.provider 가 'kaaf' 면 meet.sports.or.kr 결과 대신 이걸 돌린다 (구조·엔트리·일정 상태는 그대로 NSF).
 *
 *   종목표 한 번(GET) → 행마다 우리 종목(이름·성별·부·라운드)을 찾고,
 *     '경기완료' 인데 아직 안 읽은 행 / 경기 시각 창(시작 2시간 전~6시간 뒤) 안의 행 / opts.all → 결과표(POST) 읽어 반영
 *   트랙·계주·로드: 레인·기록·풍속(조)·상태(기권 DNF·불참 DNS·실격 DQ)·비고(통과·대회신)
 *   거리: 시기별 기록(X=0 파울, -=-1 패스)      높이: height_attempt(높이·시기·O/X/PASS, 점프오프 제외) + 최고 기록·순위
 *   종합 총점표: combined_score(세부종목 순서 = 표 머리글 순서 = WA 순서, 점수는 사이트 값) + 총점      세부종목표: 세부종목 조 기록 + 점수 계산(calc)
 *   선수는 nsf_daily.matchAthlete(이름·시도·연맹 배번) — 데일리 PDF 를 먼저 올려 두면 배번·레인이 이미 맞다.
 */
const K = require('./kaaf');
const N = require('./nsf');
const D = require('./nsf_daily');
const nowIso = () => new Date().toISOString();

function configured(source) { return !!(source && source.results && source.results.provider === 'kaaf' && source.results.to_cd); }
async function loadState(db, compId) { try { return JSON.parse(((await db.get('SELECT sync_state FROM competition WHERE id=?', compId)) || {}).sync_state || '{}') || {}; } catch (e) { return {}; } }
async function saveState(db, compId, patch) {
    const st = await loadState(db, compId); Object.assign(st, patch);
    await db.run('UPDATE competition SET sync_state=? WHERE id=?', JSON.stringify(st), compId); return st;
}

/** 종목표 행 → 우리 종목 (없으면 null) */
async function eventOfRow(db, compId, row) {
    const { gender, division } = K.divisionOfLabel(row.division);
    const { name, combined } = K.eventOfLabel(row.event);
    const round = K.ROUND[row.round_cd] || 'final';
    if (/종경기$/.test(name) && !combined) {
        // 종합경기 총점표 → 부모 종목
        const cands = await db.all("SELECT * FROM event WHERE competition_id=? AND name=? AND gender=? AND category='combined' AND parent_event_id IS NULL", compId, name, gender);
        const want = String(division).replace(/부$/, '');
        return cands.find(e => (e.division || '') === division) || cands.find(e => String(e.division || '').split('·').map(x => x.replace(/부$/, '')).includes(want)) || (cands.length === 1 ? cands[0] : null);
    }
    return D.findEvent(db, compId, { name, combined, round, gender, division, isRelay: /mR(\(Mixed\))?$/.test(name) });
}

async function upsertResult(db, heatId, entryId, attempt, timeSec, dist, status, remark, wind) {
    const nowFn = db.isAsync ? 'NOW()' : "datetime('now')";
    const cur = attempt == null ? await db.get('SELECT id FROM result WHERE heat_id=? AND event_entry_id=? AND attempt_number IS NULL', heatId, entryId)
        : await db.get('SELECT id FROM result WHERE heat_id=? AND event_entry_id=? AND attempt_number=?', heatId, entryId, attempt);
    if (cur) await db.run(`UPDATE result SET time_seconds=?, distance_meters=?, status_code=?, remark=?, wind=?, updated_at=${nowFn} WHERE id=?`, timeSec, dist, status || '', remark || '', wind, cur.id);
    else await db.run('INSERT INTO result (heat_id, event_entry_id, attempt_number, time_seconds, distance_meters, status_code, remark, wind) VALUES (?,?,?,?,?,?,?,?)', heatId, entryId, attempt == null ? null : attempt, timeSec, dist, status || '', remark || '', wind);
}
const num = v => { const n = parseFloat(String(v || '').replace(/,/g, '')); return isFinite(n) ? n : null; };
const windOf = v => { const n = parseFloat(String(v || '').replace(/[^\d.+-]/g, '')); return isFinite(n) ? n : null; };
const remarkOf = row => [row.record, /^(통과|Q|q)$/i.test(row.remark || '') ? 'Q' : ''].filter(Boolean).join(' ');
const CAT_OF_SUB = n => /뛰기|던지기/.test(n) ? (/높이/.test(n) ? 'field_height' : 'field_distance') : 'track';

/** 결과표 한 장을 우리 조에 쓴다 → { written, heats } */
async function applyPage(db, comp, ev, page, opts, stats) {
    const isCombinedTotal = ev.category === 'combined' && !ev.parent_event_id;
    let written = 0; const touched = [];
    for (const heat of page.heats) {
        if (!heat.rows.length) continue;
        const h = await D.findOrCreateHeat(db, ev.id, heat.heatNo, stats);
        touched.push(h);
        let order = 0;
        for (const row of heat.rows) {
            order++;
            const sido = D.sidoOf(row.team);
            let athleteId;
            if (ev.category === 'relay') athleteId = await D.relayTeamId(db, comp.id, sido, ev.gender);
            else athleteId = await D.matchAthlete(db, comp.id, ev, { name: row.name, sido, bib: row.bib }, stats);
            if (!athleteId) continue;
            const entryId = await D.ensureEntry(db, ev.id, athleteId);
            if (ev.parent_event_id) await D.ensureEntry(db, ev.parent_event_id, athleteId);
            const lane = row.lane || row.order || order;
            const he = await db.get('SELECT id, lane_number FROM heat_entry WHERE heat_id=? AND event_entry_id=?', h.id, entryId);
            if (!he) await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?,?,?)', h.id, entryId, lane);
            else if (ev.category !== 'relay' && row.lane && he.lane_number !== row.lane) await db.run('UPDATE heat_entry SET lane_number=? WHERE id=?', row.lane, he.id);
            const status = K.statusOf(row.mark, row.remark);
            const remark = remarkOf(row);
            if (isCombinedTotal) {
                const total = num(row.total);
                if (status) await upsertResult(db, h.id, entryId, null, null, null, status, remark, null);
                else if (total != null && total > 0) await upsertResult(db, h.id, entryId, null, null, total, '', remark, null);
                else continue;
                if (row.rank) await db.run('UPDATE event_entry SET manual_rank=? WHERE id=?', row.rank, entryId);
                let i = 0;
                for (const sub of row.subs || []) {
                    i++;
                    if (!sub.points && !sub.mark) continue;
                    const pts = parseInt(sub.points, 10) || 0;
                    const subStatus = K.statusOf(sub.mark, '');
                    const raw = subStatus ? null : N.markToNumber(sub.mark, CAT_OF_SUB(sub.name));
                    await db.run(`INSERT INTO combined_score (event_entry_id, sub_event_name, sub_event_order, raw_record, wa_points, status_code) VALUES (?,?,?,?,?,?)
                        ON CONFLICT(event_entry_id, sub_event_order) DO UPDATE SET raw_record=excluded.raw_record, wa_points=excluded.wa_points, sub_event_name=excluded.sub_event_name, status_code=excluded.status_code`, entryId, sub.name, i, raw, pts, subStatus || '');
                }
                written++; continue;
            }
            if (heat.kind === 'height') {
                await db.run('DELETE FROM height_attempt WHERE heat_id=? AND event_entry_id=?', h.id, entryId);
                for (const hh of row.heights || []) {
                    if (hh.jumpoff) continue;
                    const marks = String(hh.marks || '').trim();
                    if (!marks) continue;
                    if (marks === '-' || /^(PASS|P)$/i.test(marks)) { await db.run('INSERT INTO height_attempt (heat_id, event_entry_id, bar_height, attempt_number, result_mark) VALUES (?,?,?,?,?)', h.id, entryId, hh.height, 1, 'PASS'); continue; }
                    let n = 0;
                    for (const ch of marks.toUpperCase()) { if (ch !== 'O' && ch !== 'X') continue; n++; if (n > 3) break; await db.run('INSERT INTO height_attempt (heat_id, event_entry_id, bar_height, attempt_number, result_mark) VALUES (?,?,?,?,?)', h.id, entryId, hh.height, n, ch); }
                }
                const best = status ? null : num(row.mark);
                if (status || best != null) { await upsertResult(db, h.id, entryId, null, null, best, status, remark, null); written++; }
                if (row.rank) await db.run('UPDATE event_entry SET manual_rank=? WHERE id=?', row.rank, entryId);
                continue;
            }
            if (heat.kind === 'distance') {
                let any = false, i = 0;
                for (const a of row.attempts || []) {
                    i++;
                    const v = String(a || '').trim();
                    if (!v) { await db.run('DELETE FROM result WHERE heat_id=? AND event_entry_id=? AND attempt_number=?', h.id, entryId, i); continue; }
                    const d = v.toUpperCase() === 'X' ? 0 : v === '-' ? -1 : num(v);
                    if (d == null) continue;
                    await upsertResult(db, h.id, entryId, i, null, d, '', '', windOf(row.wind)); any = true;
                }
                if (status) { await upsertResult(db, h.id, entryId, null, null, null, status, remark, null); any = true; }
                else if (remark) { const cur = await db.get('SELECT id FROM result WHERE heat_id=? AND event_entry_id=? AND attempt_number IS NULL', h.id, entryId); if (cur) await db.run('UPDATE result SET remark=? WHERE id=?', remark, cur.id); }
                if (row.rank) await db.run('UPDATE event_entry SET manual_rank=? WHERE id=?', row.rank, entryId);
                if (any) written++;
                continue;
            }
            // 트랙·계주·로드
            const t = status ? null : N.markToNumber(row.mark, 'track');
            if (!status && t == null) { await db.run('DELETE FROM result WHERE heat_id=? AND event_entry_id=? AND attempt_number IS NULL', h.id, entryId); continue; }
            await upsertResult(db, h.id, entryId, null, t, null, status, remark, windOf(row.wind));
            written++;
            if (ev.parent_event_id && opts.calc && typeof opts.calc.calcWAPoints === 'function' && t != null) {
                try {
                    const parent = await db.get('SELECT * FROM event WHERE id=?', ev.parent_event_id);
                    const parentEntryId = await D.ensureEntry(db, ev.parent_event_id, athleteId);
                    const subs = await db.all('SELECT id FROM event WHERE parent_event_id=? ORDER BY sort_order, id', ev.parent_event_id);
                    const idx = subs.findIndex(s => Number(s.id) === Number(ev.id)); const sorder = idx >= 0 ? idx + 1 : 1;
                    const keys = typeof opts.calc.waKeysFor === 'function' ? opts.calc.waKeysFor(parent) : [];
                    const pts = opts.calc.calcWAPoints(keys[sorder - 1], t);
                    await db.run(`INSERT INTO combined_score (event_entry_id, sub_event_name, sub_event_order, raw_record, wa_points, status_code) VALUES (?,?,?,?,?,?)
                        ON CONFLICT(event_entry_id, sub_event_order) DO UPDATE SET raw_record=excluded.raw_record, wa_points=excluded.wa_points, sub_event_name=excluded.sub_event_name, status_code=excluded.status_code`,
                        parentEntryId, String(ev.name || '').replace(/^\[.*?\]\s*/, ''), sorder, t, pts, '');
                } catch (e) { /* 종합표 실패는 세부종목 결과를 막지 않는다 */ }
            }
        }
        // 조 풍속 (트랙): 첫 행의 값
        if (heat.kind === 'track' && (ev.category === 'track' || ev.category === 'relay')) { const w = windOf((heat.rows.find(r => r.wind) || {}).wind); if (w != null) await db.run('UPDATE heat SET wind=? WHERE id=?', w, h.id); }
    }
    // 필드 세부종목(거리·높이) → 종합표 점수 (세부종목표가 왔을 때)
    if (ev.parent_event_id && opts.calc && typeof opts.calc.calcWAPoints === 'function' && page.heats.some(h => h.kind !== 'track')) {
        try {
            const parent = await db.get('SELECT * FROM event WHERE id=?', ev.parent_event_id);
            const subs = await db.all('SELECT id FROM event WHERE parent_event_id=? ORDER BY sort_order, id', ev.parent_event_id);
            const idx = subs.findIndex(s => Number(s.id) === Number(ev.id)); const sorder = idx >= 0 ? idx + 1 : 1;
            const keys = typeof opts.calc.waKeysFor === 'function' ? opts.calc.waKeysFor(parent) : [];
            for (const h of touched) {
                const rows = await db.all(`SELECT ee.athlete_id, MAX(CASE WHEN r.attempt_number IS NULL THEN r.distance_meters END) AS best_null, MAX(CASE WHEN r.attempt_number IS NOT NULL AND r.distance_meters > 0 THEN r.distance_meters END) AS best_att
                    FROM result r JOIN event_entry ee ON ee.id=r.event_entry_id WHERE r.heat_id=? GROUP BY ee.athlete_id`, h.id);
                for (const r of rows) {
                    const best = r.best_null != null ? r.best_null : r.best_att; if (best == null) continue;
                    const parentEntryId = await D.ensureEntry(db, ev.parent_event_id, r.athlete_id);
                    const pts = opts.calc.calcWAPoints(keys[sorder - 1], best);
                    await db.run(`INSERT INTO combined_score (event_entry_id, sub_event_name, sub_event_order, raw_record, wa_points, status_code) VALUES (?,?,?,?,?,?)
                        ON CONFLICT(event_entry_id, sub_event_order) DO UPDATE SET raw_record=excluded.raw_record, wa_points=excluded.wa_points, sub_event_name=excluded.sub_event_name, status_code=excluded.status_code`,
                        parentEntryId, String(ev.name || '').replace(/^\[.*?\]\s*/, ''), sorder, best, pts, '');
                }
            }
        } catch (e) { /* ignore */ }
    }
    return { written, heats: touched };
}

/** 종목표 → 창 안/완료 행의 결과표 읽어 반영 */
async function syncResults(db, comp, opts = {}) {
    const source = opts.source; const src = source.results;
    const fetchFn = opts.kaafFetch || K.fetchLive;
    const st = await loadState(db, comp.id);
    const seen = st.kaaf || {};
    const stats = { table_rows: 0, checked: 0, updated: 0, results: 0, completed: 0, unmatched: [], errors: [] };
    let rows;
    try { rows = K.parseEventTable(await fetchFn(src, 'table')); } catch (e) { stats.errors.push('종목표: ' + e.message); await saveState(db, comp.id, { kaaf_at: nowIso(), kaaf_stats: stats }); return stats; }
    stats.table_rows = rows.length;
    const now = Date.now();
    for (const row of rows) {
        const prev = seen[row.key] || {};
        const done = row.state === '경기완료';
        const ev = await eventOfRow(db, comp.id, row);
        if (!ev) { if (!prev.unmatched) stats.unmatched.push(`${row.division} ${row.event} ${row.round}`); seen[row.key] = { ...prev, state: row.state, unmatched: true }; continue; }
        let due = !!opts.all;
        if (!due && done && prev.state !== '경기완료') due = true;
        if (!due && !done) {
            const hs = await db.all('SELECT scheduled_at FROM heat WHERE event_id=?', ev.id);
            due = hs.some(h => { const t = Date.parse(h.scheduled_at || ''); return isFinite(t) && now - t <= 6 * 3600000 && t - now <= 2 * 3600000; });
            if (due && prev.at && now - Date.parse(prev.at) < 90000) due = false;   // 진행 중인 종목은 90초마다
        }
        if (!due) continue;
        let html; try { html = await fetchFn(src, 'result', row); } catch (e) { stats.errors.push(`${row.key}: ${e.message}`); continue; }
        stats.checked++;
        let page; try { page = K.parseResultPage(html); } catch (e) { stats.errors.push(`${row.key}: 해석 실패 ${e.message}`); continue; }
        const hasRows = page.heats.some(h => h.rows.length);
        if (!hasRows) { seen[row.key] = { state: row.state, at: nowIso() }; continue; }
        let res;
        try { res = await applyPage(db, comp, ev, page, opts, stats); } catch (e) { stats.errors.push(`${row.key}: 반영 실패 ${e.message}`); continue; }
        seen[row.key] = { state: row.state, at: nowIso(), written: res.written };
        if (!res.written) continue;
        stats.updated++; stats.results += res.written;
        const flags = st.heat_flags || {};
        if (done) {
            for (const h of res.heats) flags[String(h.id)] = 'done';
            st.heat_flags = flags;
            await db.run("UPDATE event SET round_status='completed' WHERE id=? AND round_status<>'completed'", ev.id);
            let parentDone = false;
            if (ev.parent_event_id) { const subs = await db.all('SELECT id, round_status FROM event WHERE parent_event_id=?', ev.parent_event_id); if (subs.every(s => s.round_status === 'completed')) parentDone = true; }
            if (ev.category === 'combined' && !ev.parent_event_id) { await db.run("UPDATE event SET round_status='completed' WHERE id=?", ev.id); }
            stats.completed++;
            if (opts.onApplied) { try { await opts.onApplied({ event_id: ev.id, heat_id: res.heats[0] && res.heats[0].id, written: res.written, completed: true, official: true, parent_event_id: ev.parent_event_id || null, parent_completed: parentDone }); } catch (e) {} }
        } else {
            await db.run("UPDATE event SET round_status='in_progress' WHERE id=? AND round_status IN ('created','heats_generated')", ev.id);
            if (ev.parent_event_id) await db.run("UPDATE event SET round_status='in_progress' WHERE id=? AND round_status IN ('created','heats_generated')", ev.parent_event_id);
            if (opts.onApplied) { try { await opts.onApplied({ event_id: ev.id, heat_id: res.heats[0] && res.heats[0].id, written: res.written, completed: false, official: false, parent_event_id: ev.parent_event_id || null }); } catch (e) {} }
        }
    }
    await saveState(db, comp.id, { kaaf: seen, kaaf_at: nowIso(), kaaf_stats: { table_rows: stats.table_rows, checked: stats.checked, updated: stats.updated, results: stats.results, completed: stats.completed, unmatched: stats.unmatched.slice(0, 30), errors: stats.errors.slice(0, 20) }, heat_flags: st.heat_flags || {}, results_at: nowIso(), results: { checked: stats.checked, updated: stats.updated, results: stats.results, startlists: 0 } });
    return stats;
}

module.exports = { configured, eventOfRow, applyPage, syncResults };
