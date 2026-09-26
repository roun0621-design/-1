'use strict';
/**
 * 라운드 생성·종목 삭제·세부종목·레인(결승/준결승 생성, 레인 배정 조회, 종목 삭제(되돌리기 스냅샷), 세부종목 CRUD·정렬·선수 동기화, 레인 일괄 수정/배정, 전체 결과) — server.js 에서 이동 (2026-09-22, Phase 4 분해). 동작은 인라인 시절과 같다.
 *   deps: _placeInSourceHeat, _undo, autoLinkDisplayTimetable, broadcastSSE, db, generateScoreboardKey, getLanePattern, isAdminKey, isOperationKey, isShortTrackEvent, opLog, orderByBibSql, waAssignLanesBulk, waSeededDistribution
 */
module.exports = function mountRoundsRoutes(app, deps) {
    const { _placeInSourceHeat, _undo, autoLinkDisplayTimetable, broadcastSSE, db, generateScoreboardKey, getLanePattern, isAdminKey, isOperationKey, isShortTrackEvent, opLog, orderByBibSql, waAssignLanesBulk, waSeededDistribution } = deps;
    for (const k of ["_placeInSourceHeat","_undo","autoLinkDisplayTimetable","broadcastSSE","db","generateScoreboardKey","getLanePattern","isAdminKey","isOperationKey","isShortTrackEvent","opLog","orderByBibSql","waAssignLanesBulk","waSeededDistribution"]) if (deps[k] === undefined) throw new Error('[rounds.js] mount requires deps.' + k);



    app.post('/api/events/:id/create-final', async (req, res) => {
        const event = await db.get('SELECT * FROM event WHERE id=?', req.params.id);
        if (!event) return res.status(404).json({ error: 'Event not found' });
        const existingFinal = await db.get("SELECT id FROM event WHERE name=? AND gender=? AND category=? AND round_type='final' AND competition_id=? AND parent_event_id IS NULL AND id!=?", event.name, event.gender, event.category, event.competition_id, event.id);
        if (existingFinal) return res.status(400).json({ error: '이미 결승이 존재합니다.' });
        const qualified = await db.all(`SELECT event_entry_id, qualification_type FROM qualification_selection WHERE event_id=? AND selected=1 AND approved=1`, event.id);
        if (qualified.length === 0) return res.status(400).json({ error: 'No approved qualifiers' });

        const isShortTrack_ = isShortTrackEvent(event.name);
        // For finals, check if we need multiple heats (>8 athletes for ≤800m)
        const { group_count: finalGroupCount } = req.body;
        const numHeats = finalGroupCount || 1;

        const info = await db.run(`INSERT INTO event (competition_id,name,category,gender,round_type,round_status) VALUES (?,?,?,?,'final','heats_generated')`, event.competition_id, event.name, event.category, event.gender);
        const finalEventId = info.lastInsertRowid;

        // Build athlete data for WA seeding — with best performance for sorting
        const qualSels = await Promise.all(qualified.map(async q => {
            const origEntry = await db.get('SELECT * FROM event_entry WHERE id=?', q.event_entry_id);
            if (!origEntry) return { event_entry_id: q.event_entry_id, athlete_id: null, qualification_type: q.qualification_type || '', perf: Infinity };
            // Get best performance across all heats of the source event
            let bestPerf = Infinity;
            const heats = await db.all('SELECT id FROM heat WHERE event_id=?', event.id);
            for (const h of heats) {
                const entryInHeat = await db.get('SELECT id FROM heat_entry WHERE heat_id=? AND event_entry_id=?', h.id, q.event_entry_id);
                if (!entryInHeat) continue;
                if (event.category === 'track' || event.category === 'relay' || event.category === 'road') {
                    const r = await db.get('SELECT MIN(time_seconds) AS best FROM result WHERE heat_id=? AND event_entry_id=? AND time_seconds > 0', h.id, q.event_entry_id);
                    if (r && r.best != null && r.best < bestPerf) bestPerf = r.best;
                } else if (event.category === 'field_distance') {
                    const r = await db.get('SELECT MAX(distance_meters) AS best FROM result WHERE heat_id=? AND event_entry_id=? AND distance_meters > 0', h.id, q.event_entry_id);
                    if (r && r.best) bestPerf = -r.best; // negate so ascending sort = best first
                } else if (event.category === 'field_height') {
                    const r = await db.get("SELECT MAX(bar_height) AS best FROM height_attempt WHERE heat_id=? AND event_entry_id=? AND result_mark='O'", h.id, q.event_entry_id);
                    if (r && r.best) bestPerf = -r.best;
                }
            }
            return { event_entry_id: q.event_entry_id, athlete_id: origEntry.athlete_id, qualification_type: q.qualification_type || '', perf: bestPerf, place: await _placeInSourceHeat(event, q.event_entry_id) };
        }));

        // WA seeding: Q (순위 진출) first by performance, then q (기록 진출) by performance
        // A q athlete cannot outrank a Q athlete even with a better record
        //   (TR 20.3.2: Q 안에서는 조 순위가 먼저 — 조 1위들 기록순, 조 2위들 기록순 … — lib/seeding.js)
        {
            const ordered = require('../seeding').seedOrder(qualSels);
            qualSels.length = 0; qualSels.push(...ordered);
        }

        // Fetch the newly created final event for scoreboard key generation
        const finalEvent = await db.get('SELECT * FROM event WHERE id=?', finalEventId);

        if (numHeats === 1) {
            const heatInfo = await db.run('INSERT INTO heat (event_id,heat_number) VALUES (?,1)', finalEventId);
            // Auto-generate scoreboard_key
            const sbKey = await generateScoreboardKey(finalEvent, 1, db, numHeats);
            await db.run('UPDATE heat SET scoreboard_key=? WHERE id=?', sbKey, heatInfo.lastInsertRowid);
            // WA lane assignment for single heat with pattern-based random shuffle
            const lanes = waAssignLanesBulk(qualSels, qualSels.length, isShortTrack_, event.name);
            for (let idx = 0; idx < qualSels.length; idx++) {
                const ath = qualSels[idx];
                const newEntry = await db.run("INSERT INTO event_entry (event_id,athlete_id,status) VALUES (?,?,'registered')", finalEventId, ath.athlete_id);
                await db.run('INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES (?,?,?)', heatInfo.lastInsertRowid, newEntry.lastInsertRowid, lanes[idx]);
            }
        } else {
            // Multi-heat final with WA seeding
            const seeded = await waSeededDistribution(event, qualSels, numHeats, db);
            for (let g = 0; g < numHeats; g++) {
                const heatInfo = await db.run('INSERT INTO heat (event_id,heat_number) VALUES (?,?)', finalEventId, g + 1);
                // Auto-generate scoreboard_key
                const sbKey = await generateScoreboardKey(finalEvent, g + 1, db, numHeats);
                await db.run('UPDATE heat SET scoreboard_key=? WHERE id=?', sbKey, heatInfo.lastInsertRowid);
                const groupAthletes = seeded[g] || [];
                // Sort within group by performance for correct WA lane assignment
                groupAthletes.sort((a, b) => (a.seedRank || 0) - (b.seedRank || 0) || a.perf - b.perf);   // 시드 순서 유지 (레인 그룹 추첨 기준)
                const lanes = waAssignLanesBulk(groupAthletes, groupAthletes.length, isShortTrack_, event.name);
                for (let idx = 0; idx < groupAthletes.length; idx++) {
                    const ath = groupAthletes[idx];
                    const newEntry = await db.run("INSERT INTO event_entry (event_id,athlete_id,status) VALUES (?,?,'registered')", finalEventId, ath.athlete_id);
                    await db.run('INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES (?,?,?)', heatInfo.lastInsertRowid, newEntry.lastInsertRowid, lanes[idx]);
                }
            }
        }
        opLog(`${event.name} ${event.gender === 'M' ? '남자' : '여자'} 결승 라운드 생성 (${qualified.length}명 진출)`, 'round', 'system', event.competition_id);
        // SSE broadcast so dashboard/results pages pick up the new final event
        broadcastSSE('event_status_changed', { event_id: finalEventId, round_status: 'heats_generated' });
        // 시간표 자동 재매칭 (결승 라운드가 새로 생겼으므로 시간표의 "결승" 행과 연결 가능)
        try { await autoLinkDisplayTimetable(event.competition_id); } catch(autoErr) { console.warn('[autoLink after final] ', autoErr.message); }
        res.json({ success: true, final_event_id: finalEventId, count: qualified.length });
    });

    // GET /api/events/:id/lane-assignments — Return lane assignments with WA rule explanations
    app.get('/api/events/:id/lane-assignments', async (req, res) => {
        const event = await db.get('SELECT * FROM event WHERE id=?', req.params.id);
        if (!event) return res.status(404).json({ error: 'Event not found' });

        const heats = await db.all('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number', event.id);
        if (heats.length === 0) return res.json({ heats: [] });

        const isShortTrack = isShortTrackEvent(event.name);
        const pattern = getLanePattern(event.name);
        const patternLabel = pattern === 'A' ? '100m/허들 패턴' : pattern === 'B' ? '200m 패턴' : pattern === 'C' ? '400m/800m/릴레이 패턴' : '기본 배정';

        // Lane group descriptions by pattern
        const groupDescs = {};
        if (pattern === 'A') {
            groupDescs[3] = '시드 1~4위 그룹 (레인 3,4,5,6)';
            groupDescs[4] = '시드 1~4위 그룹 (레인 3,4,5,6)';
            groupDescs[5] = '시드 1~4위 그룹 (레인 3,4,5,6)';
            groupDescs[6] = '시드 1~4위 그룹 (레인 3,4,5,6)';
            groupDescs[2] = '시드 5~6위 그룹 (레인 2,7)';
            groupDescs[7] = '시드 5~6위 그룹 (레인 2,7)';
            groupDescs[1] = '시드 7~8위 그룹 (레인 1,8)';
            groupDescs[8] = '시드 7~8위 그룹 (레인 1,8)';
        } else if (pattern === 'B') {
            groupDescs[5] = '시드 1~3위 그룹 (레인 5,6,7)';
            groupDescs[6] = '시드 1~3위 그룹 (레인 5,6,7)';
            groupDescs[7] = '시드 1~3위 그룹 (레인 5,6,7)';
            groupDescs[3] = '시드 4~6위 그룹 (레인 3,4,8)';
            groupDescs[4] = '시드 4~6위 그룹 (레인 3,4,8)';
            groupDescs[8] = '시드 4~6위 그룹 (레인 3,4,8)';
            groupDescs[1] = '시드 7~8위 그룹 (레인 1,2)';
            groupDescs[2] = '시드 7~8위 그룹 (레인 1,2)';
        } else if (pattern === 'C') {
            groupDescs[4] = '시드 1~4위 그룹 (레인 4,5,6,7)';
            groupDescs[5] = '시드 1~4위 그룹 (레인 4,5,6,7)';
            groupDescs[6] = '시드 1~4위 그룹 (레인 4,5,6,7)';
            groupDescs[7] = '시드 1~4위 그룹 (레인 4,5,6,7)';
            groupDescs[3] = '시드 5~6위 그룹 (레인 3,8)';
            groupDescs[8] = '시드 5~6위 그룹 (레인 3,8)';
            groupDescs[1] = '시드 7~8위 그룹 (레인 1,2)';
            groupDescs[2] = '시드 7~8위 그룹 (레인 1,2)';
        }

        const result = await Promise.all(heats.map(async heat => {
            const entries = await db.all(`
                SELECT he.id AS heat_entry_id, he.event_entry_id, he.lane_number,
                       ee.athlete_id, a.name, a.bib_number, a.team
                FROM heat_entry he
                JOIN event_entry ee ON ee.id = he.event_entry_id
                JOIN athlete a ON a.id = ee.athlete_id
                WHERE he.heat_id = ?
                ORDER BY he.lane_number
            `, heat.id);

            // Build seed rank by looking at source event results
            // Find source event (preliminary/semifinal) that led to this event
            const sourceEvent = await db.all("SELECT id FROM event WHERE name=? AND gender=? AND category=? AND competition_id=? AND round_type IN ('preliminary','semifinal') AND id!=?", event.name, event.gender, event.category, event.competition_id, event.id);

            // Get qualification info for each athlete
            const athleteDetails = await Promise.all(entries.map(async e => {
                let qualType = '';
                let seedRank = null;
                let bestPerf = null;
                let bestPerfDisplay = '';
                let reason = '';

                // Find qualification info
                for (const src of sourceEvent) {
                    const q = await db.get('SELECT qualification_type FROM qualification_selection WHERE event_id=? AND event_entry_id=? AND selected=1 AND approved=1', src.id, e.event_entry_id);
                    if (!q) {
                        // Find by athlete_id instead (new event_entry in final)
                        const origEntry = await db.get('SELECT id FROM event_entry WHERE event_id=? AND athlete_id=?', src.id, e.athlete_id);
                        if (origEntry) {
                            const q2 = await db.get('SELECT qualification_type FROM qualification_selection WHERE event_id=? AND event_entry_id=? AND selected=1 AND approved=1', src.id, origEntry.id);
                            if (q2) qualType = q2.qualification_type || '';
                        }
                    } else {
                        qualType = q.qualification_type || '';
                    }
                }

                const laneNum = e.lane_number;
                const groupReason = groupDescs[laneNum] || '';
                const qualLabel = qualType === 'Q' ? '순위 진출(Q)' : qualType === 'q' ? '기록 진출(q)' : '';

                if (isShortTrack && pattern) {
                    reason = `WA ${patternLabel}: ${groupReason}${qualLabel ? ' / ' + qualLabel : ''} → 그룹 내 랜덤 배정으로 레인 ${laneNum}`;
                } else {
                    reason = `순서 배정: 레인 ${laneNum}`;
                }

                return {
                    heat_entry_id: e.heat_entry_id,
                    event_entry_id: e.event_entry_id,
                    athlete_id: e.athlete_id,
                    name: e.name,
                    bib_number: e.bib_number,
                    team: e.team,
                    lane_number: laneNum,
                    qualification_type: qualType,
                    reason: reason
                };
            }));

            return {
                heat_id: heat.id,
                heat_number: heat.heat_number,
                heat_name: heat.heat_name || `Heat ${heat.heat_number}`,
                entries: athleteDetails
            };
        }));

        res.json({
            event_id: event.id,
            event_name: event.name,
            pattern: pattern,
            pattern_label: patternLabel,
            is_short_track: isShortTrack,
            heats: result
        });
    });

    app.post('/api/events/:id/create-semifinal', async (req, res) => {
        const event = await db.get('SELECT * FROM event WHERE id=?', req.params.id);
        if (!event) return res.status(404).json({ error: 'Event not found' });
        const existingSemi = await db.get("SELECT id FROM event WHERE name=? AND gender=? AND category=? AND round_type='semifinal' AND competition_id=? AND parent_event_id IS NULL", event.name, event.gender, event.category, event.competition_id);
        if (existingSemi) return res.status(400).json({ error: '이미 준결승이 존재합니다.' });
        const { group_count, selections } = req.body;
        if (!group_count || group_count < 1) return res.status(400).json({ error: 'group_count required' });
        if (!selections || selections.length === 0) return res.status(400).json({ error: 'No selections' });
        const qualifiedSels = selections.filter(s => s.selected);
        const qualifiedIds = qualifiedSels.map(s => s.event_entry_id);
        if (qualifiedIds.length === 0) return res.status(400).json({ error: 'No qualified athletes' });

        // WA Rule: max 8 athletes per heat for events ≤800m
        const isShortTrack = isShortTrackEvent(event.name);
        if (isShortTrack) {
            const maxPerHeat = 8;
            const requiredHeats = Math.ceil(qualifiedIds.length / maxPerHeat);
            if (group_count < requiredHeats) {
                return res.status(400).json({ error: `800m 이하 종목은 조당 최대 8명입니다. 최소 ${requiredHeats}개 조가 필요합니다.` });
            }
        }

        let semiEventId;
        await db.transaction(async () => {
            for (const sel of qualifiedSels) {
                await db.run(`INSERT INTO qualification_selection (event_id,event_entry_id,selected,approved,approved_by,qualification_type) VALUES (?,?,1,1,'admin',?)
                    ON CONFLICT(event_id,event_entry_id) DO UPDATE SET selected=1,approved=1,qualification_type=excluded.qualification_type`, event.id, sel.event_entry_id, sel.qualification_type || '');
            }
            const info = await db.run(`INSERT INTO event (competition_id,name,category,gender,round_type,round_status) VALUES (?,?,?,?,'semifinal','heats_generated')`, event.competition_id, event.name, event.category, event.gender);
            semiEventId = info.lastInsertRowid;

            // Fetch the newly created semi event for scoreboard key generation
            const semiEvent = await db.get('SELECT * FROM event WHERE id=?', semiEventId);

            // WA serpentine seeding: sort athletes by performance, distribute in zigzag
            const seeded = await waSeededDistribution(event, qualifiedSels, group_count, db);
            for (let g = 0; g < group_count; g++) {
                const heatInfo = await db.run('INSERT INTO heat (event_id,heat_number) VALUES (?,?)', semiEventId, g + 1);
                // Auto-generate scoreboard_key
                const sbKey = await generateScoreboardKey(semiEvent, g + 1, db, group_count);
                await db.run('UPDATE heat SET scoreboard_key=? WHERE id=?', sbKey, heatInfo.lastInsertRowid);
                const groupAthletes = seeded[g] || [];
                // Sort within group by performance for correct WA lane assignment
                groupAthletes.sort((a, b) => (a.seedRank || 0) - (b.seedRank || 0) || a.perf - b.perf);   // 시드 순서 유지 (레인 그룹 추첨 기준)
                const lanes = waAssignLanesBulk(groupAthletes, groupAthletes.length, isShortTrack, event.name);
                for (let idx = 0; idx < groupAthletes.length; idx++) {
                    const ath = groupAthletes[idx];
                    const newEntry = await db.run("INSERT INTO event_entry (event_id,athlete_id,status) VALUES (?,?,'registered')", semiEventId, ath.athlete_id);
                    await db.run('INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES (?,?,?)', heatInfo.lastInsertRowid, newEntry.lastInsertRowid, lanes[idx]);
                }
            }
        })();
        opLog(`${event.name} 준결승 생성 (${qualifiedIds.length}명, ${group_count}개 조)`, 'round', 'system', event.competition_id);
        // SSE broadcast so dashboard/results pages pick up the new semifinal event
        broadcastSSE('event_status_changed', { event_id: semiEventId, round_status: 'heats_generated' });
        // 시간표 자동 재매칭 (준결승 라운드가 새로 생겼으므로 시간표의 "준결승" 행과 연결 가능)
        try { await autoLinkDisplayTimetable(event.competition_id); } catch(autoErr) { console.warn('[autoLink after semifinal] ', autoErr.message); }
        res.json({ success: true, semi_event_id: semiEventId, count: qualifiedIds.length });
    });
    app.delete('/api/events/:id', async (req, res) => {
        const { admin_key } = req.body;
        if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        const event = await db.get('SELECT * FROM event WHERE id=?', req.params.id);
        if (!event) return res.status(404).json({ error: 'Event not found' });
        // FIX: 노출용(display) 모드 대회는 자동 결승 생성 로직이 없으므로 예선 삭제 허용
        // 운영용(operation) 대회에서만 예선 삭제 보호 가드 적용
        const _comp = await db.get('SELECT mode FROM competition WHERE id=?', event.competition_id);
        const _isDisplayMode = _comp && _comp.mode === 'display';
        if (!_isDisplayMode && event.round_type === 'preliminary' && !event.parent_event_id) {
            return res.status(400).json({ error: '예선은 삭제할 수 없습니다.' });
        }
        const undoId = await _undoSnapshotEvent(event, 'admin');
        await db.transaction(async () => {
            const heats = await db.all('SELECT id FROM heat WHERE event_id=?', event.id);
            for (const h of heats) {
                await db.run('DELETE FROM result WHERE heat_id=?', h.id);
                await db.run('DELETE FROM height_attempt WHERE heat_id=?', h.id);
                await db.run('DELETE FROM heat_entry WHERE heat_id=?', h.id);
            }
            await db.run('DELETE FROM heat WHERE event_id=?', event.id);
            await db.run('DELETE FROM relay_member WHERE event_entry_id IN (SELECT id FROM event_entry WHERE event_id=?)', event.id);
            await db.run('DELETE FROM event_entry WHERE event_id=?', event.id);
            await db.run('DELETE FROM qualification_selection WHERE event_id=?', event.id);
            await db.run('DELETE FROM event WHERE id=?', event.id);
        })();
        res.json({ success: true, undo_id: undoId });
    });

    // 종목 삭제 전 스냅샷 (세부종목 포함) — 24시간 안에 되돌릴 수 있게 (lib/undo.js)
    async function _undoSnapshotEvent(event, role) {
        try {
            const ids = [event.id, ...(await db.all('SELECT id FROM event WHERE parent_event_id=?', event.id)).map(x => x.id)];
            const ph = ids.map(() => '?').join(',');
            const gL = event.gender === 'M' ? '남자' : event.gender === 'F' ? '여자' : '혼성';
            const snap = await _undo.snapshot(db, {
                competition_id: event.competition_id, kind: 'event_delete', role,
                label: `종목 삭제: ${gL} ${event.name}${event.division ? ' ' + event.division : ''}`,
                tables: [
                    { table: 'event', where: `id IN (${ph})`, params: ids },
                    { table: 'heat', where: `event_id IN (${ph})`, params: ids },
                    { table: 'event_entry', where: `event_id IN (${ph})`, params: ids },
                    { table: 'heat_entry', where: `heat_id IN (SELECT id FROM heat WHERE event_id IN (${ph}))`, params: ids },
                    { table: 'result', where: `heat_id IN (SELECT id FROM heat WHERE event_id IN (${ph}))`, params: ids },
                    { table: 'height_attempt', where: `heat_id IN (SELECT id FROM heat WHERE event_id IN (${ph}))`, params: ids },
                    { table: 'relay_member', where: `event_entry_id IN (SELECT id FROM event_entry WHERE event_id IN (${ph}))`, params: ids },
                    { table: 'combined_score', where: `event_entry_id IN (SELECT id FROM event_entry WHERE event_id IN (${ph}))`, params: ids },
                    { table: 'qualification_selection', where: `event_id IN (${ph})`, params: ids },
                ],
            });
            return snap ? snap.id : null;
        } catch (e) { console.error('[undo] event snapshot:', e.message); return null; }
    }

    // ============================================================
    // COMBINED (10종/7종) SUB-EVENT CRUD
    // ============================================================

    // GET /api/events/:id/sub-events — List sub-events of a combined parent
    app.get('/api/events/:id/sub-events', async (req, res) => {
        const parent = await db.get('SELECT * FROM event WHERE id=?', req.params.id);
        if (!parent) return res.status(404).json({ error: 'Event not found' });
        if (parent.category !== 'combined') return res.status(400).json({ error: '혼성경기(combined)만 세부종목을 가질 수 있습니다.' });
        const subs = await db.all('SELECT * FROM event WHERE parent_event_id=? ORDER BY sort_order, id', parent.id);
        // Enrich with entry_count and heat_count — PG-safe batch query
        if (subs.length > 0) {
            const ids = subs.map(s => s.id);
            const ph = ids.map(() => '?').join(',');
            const entryCounts = await db.all(`SELECT event_id, COUNT(*) as cnt FROM event_entry WHERE event_id IN (${ph}) GROUP BY event_id`, ...ids);
            const heatCounts = await db.all(`SELECT event_id, COUNT(*) as cnt FROM heat WHERE event_id IN (${ph}) GROUP BY event_id`, ...ids);
            const entryMap = new Map(entryCounts.map(c => [c.event_id, Number(c.cnt)]));
            const heatMap = new Map(heatCounts.map(c => [c.event_id, Number(c.cnt)]));
            subs.forEach(s => {
                s.entry_count = entryMap.get(s.id) || 0;
                s.heat_count = heatMap.get(s.id) || 0;
            });
        }
        res.json(subs);
    });

    // POST /api/events/:id/sub-events — Add a sub-event to a combined parent
    app.post('/api/events/:id/sub-events', async (req, res) => {
        const { admin_key, name, category } = req.body;
        if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        const parent = await db.get('SELECT * FROM event WHERE id=?', req.params.id);
        if (!parent) return res.status(404).json({ error: 'Event not found' });
        if (parent.category !== 'combined') return res.status(400).json({ error: '혼성경기만 세부종목을 추가할 수 있습니다.' });
        if (!name || !category) return res.status(400).json({ error: '종목명과 카테고리는 필수입니다.' });

        const validCats = ['track', 'field_distance', 'field_height'];
        if (!validCats.includes(category)) return res.status(400).json({ error: '세부종목 카테고리는 track, field_distance, field_height 중 하나여야 합니다.' });

        // Determine prefix from parent name
        const prefix = parent.name.includes('10종') ? '[10종]' : parent.name.includes('7종') ? '[7종]' : `[${parent.name}]`;
        const subName = name.startsWith('[') ? name : `${prefix} ${name}`;

        // Get next sort_order
        const maxSort = await db.get('SELECT MAX(sort_order) AS m FROM event WHERE parent_event_id=?', parent.id);
        const nextSort = (maxSort?.m || 0) + 1;

        let subEventId;
        await db.transaction(async () => {
            const info = await db.run('INSERT INTO event (competition_id,name,category,gender,round_type,round_status,parent_event_id,sort_order) VALUES (?,?,?,?,?,?,?,?)', parent.competition_id, subName, category, parent.gender, 'final', 'heats_generated', parent.id, nextSort);
            subEventId = info.lastInsertRowid;

            // Copy athletes from parent
            const parentEntries = await db.all('SELECT id, athlete_id FROM event_entry WHERE event_id=?', parent.id);
            for (const pe of parentEntries) {
                await db.run('INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?, ?, ?)', subEventId, pe.athlete_id, 'registered');
            }

            // Create 1 heat and assign all athletes
            const heatInfo = await db.run('INSERT INTO heat (event_id, heat_number) VALUES (?, 1)', subEventId);
            const subEntries = await db.all('SELECT id FROM event_entry WHERE event_id=?', subEventId);
            for (let idx = 0; idx < subEntries.length; idx++) {
                const se = subEntries[idx];
                await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?, ?, ?)', heatInfo.lastInsertRowid, se.id, idx + 1);
            }
        })();

        opLog(`세부종목 추가: ${subName} (부모: ${parent.name})`, 'event', 'admin', parent.competition_id);
        const created = await db.get('SELECT * FROM event WHERE id=?', subEventId);
        res.json({ success: true, sub_event: created });
    });

    // PUT /api/events/:id/sub-events/:subId — Update a sub-event (name, category, sort_order)
    app.put('/api/events/:id/sub-events/:subId', async (req, res) => {
        const { admin_key, name, category, sort_order } = req.body;
        if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        const parent = await db.get('SELECT * FROM event WHERE id=?', req.params.id);
        if (!parent) return res.status(404).json({ error: 'Parent event not found' });
        const sub = await db.get('SELECT * FROM event WHERE id=? AND parent_event_id=?', req.params.subId, parent.id);
        if (!sub) return res.status(404).json({ error: 'Sub-event not found' });

        const updates = [];
        const params = [];
        if (name !== undefined) {
            const prefix = parent.name.includes('10종') ? '[10종]' : parent.name.includes('7종') ? '[7종]' : `[${parent.name}]`;
            const subName = name.startsWith('[') ? name : `${prefix} ${name}`;
            updates.push('name=?');
            params.push(subName);
        }
        if (category !== undefined) {
            const validCats = ['track', 'field_distance', 'field_height'];
            if (!validCats.includes(category)) return res.status(400).json({ error: '유효하지 않은 카테고리' });
            updates.push('category=?');
            params.push(category);
        }
        if (sort_order !== undefined) {
            updates.push('sort_order=?');
            params.push(sort_order);
        }
        if (updates.length === 0) return res.status(400).json({ error: '수정할 항목이 없습니다.' });

        params.push(sub.id);
        await db.run(`UPDATE event SET ${updates.join(',')} WHERE id=?`, ...params);
        const updated = await db.get('SELECT * FROM event WHERE id=?', sub.id);
        res.json({ success: true, sub_event: updated });
    });

    // DELETE /api/events/:parentId/sub-events/:subId — Delete a sub-event
    app.delete('/api/events/:id/sub-events/:subId', async (req, res) => {
        const { admin_key } = req.body;
        if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        const parent = await db.get('SELECT * FROM event WHERE id=?', req.params.id);
        if (!parent) return res.status(404).json({ error: 'Parent event not found' });
        const sub = await db.get('SELECT * FROM event WHERE id=? AND parent_event_id=?', req.params.subId, parent.id);
        if (!sub) return res.status(404).json({ error: 'Sub-event not found' });

        await db.transaction(async () => {
            const heats = await db.all('SELECT id FROM heat WHERE event_id=?', sub.id);
            for (const h of heats) {
                await db.run('DELETE FROM result WHERE heat_id=?', h.id);
                await db.run('DELETE FROM height_attempt WHERE heat_id=?', h.id);
                await db.run('DELETE FROM heat_entry WHERE heat_id=?', h.id);
            }
            await db.run('DELETE FROM heat WHERE event_id=?', sub.id);
            await db.run('DELETE FROM event_entry WHERE event_id=?', sub.id);
            // sub_event_order는 sort_order rank (1-base, ORDER BY sort_order, id 기준)
            const subOrderRow = await db.get(
                'SELECT COUNT(*) as cnt FROM event WHERE parent_event_id=? AND (sort_order < ? OR (sort_order = ? AND id <= ?))',
                parent.id, sub.sort_order, sub.sort_order, sub.id
            );
            const subOrderRank = (subOrderRow && subOrderRow.cnt) || 0;
            if (subOrderRank > 0) {
                await db.run('DELETE FROM combined_score WHERE sub_event_order=? AND event_entry_id IN (SELECT id FROM event_entry WHERE event_id=?)', subOrderRank, parent.id);
            }
            await db.run('DELETE FROM event WHERE id=?', sub.id);
        })();
        opLog(`세부종목 삭제: ${sub.name} (부모: ${parent.name})`, 'event', 'admin', parent.competition_id);
        res.json({ success: true });
    });

    // POST /api/events/:id/sub-events/reorder — Reorder sub-events
    app.post('/api/events/:id/sub-events/reorder', async (req, res) => {
        const { admin_key, order } = req.body; // order = [subEventId, subEventId, ...]
        if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        if (!order || !Array.isArray(order)) return res.status(400).json({ error: 'order 배열이 필요합니다.' });
        const parent = await db.get('SELECT * FROM event WHERE id=?', req.params.id);
        if (!parent) return res.status(404).json({ error: 'Parent event not found' });

        await db.transaction(async () => {
            for (let idx = 0; idx < order.length; idx++) {
                await db.run('UPDATE event SET sort_order=? WHERE id=? AND parent_event_id=?', idx + 1, order[idx], parent.id);
            }
        })();
        res.json({ success: true });
    });

    // POST /api/events/:id/sub-events/sync-athletes — Sync parent athletes to all sub-events
    app.post('/api/events/:id/sub-events/sync-athletes', async (req, res) => {
        const { admin_key } = req.body;
        if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        const parent = await db.get('SELECT * FROM event WHERE id=?', req.params.id);
        if (!parent) return res.status(404).json({ error: 'Parent event not found' });

        const parentAthleteRows = await db.all('SELECT athlete_id FROM event_entry WHERE event_id=?', parent.id);
        const parentAthletes = parentAthleteRows.map(e => e.athlete_id);
        const subs = await db.all('SELECT id FROM event WHERE parent_event_id=?', parent.id);
        let addedCount = 0;

        await db.transaction(async () => {
            for (const sub of subs) {
                const existingAthleteRows = await db.all('SELECT athlete_id FROM event_entry WHERE event_id=?', sub.id);
                const existingAthletes = new Set(existingAthleteRows.map(e => e.athlete_id));
                for (const athId of parentAthletes) {
                    if (!existingAthletes.has(athId)) {
                        const info = await db.run('INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?, ?, ?)', sub.id, athId, 'registered');
                        // Add to existing heat (heat 1)
                        const heat = await db.get('SELECT id FROM heat WHERE event_id=? ORDER BY heat_number LIMIT 1', sub.id);
                        if (heat) {
                            const laneCountRow = await db.get('SELECT COUNT(*) AS c FROM heat_entry WHERE heat_id=?', heat.id);
                            const laneCount = (laneCountRow && laneCountRow.c) || 0;
                            await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?, ?, ?)', heat.id, info.lastInsertRowid, laneCount + 1);
                        }
                        addedCount++;
                    }
                }
            }
        })();

        res.json({ success: true, added: addedCount, sub_event_count: subs.length });
    });

    // POST /api/lanes/bulk-update — Update lane assignments by heat_entry_id
    app.post('/api/lanes/bulk-update', async (req, res) => {
        const { assignments } = req.body;
        if (!assignments || !Array.isArray(assignments)) return res.status(400).json({ error: 'assignments array required' });

        try {
            await db.transaction(async () => {
                for (const a of assignments) {
                    if (!a.heat_entry_id || !a.lane_number) continue;
                    await db.run('UPDATE heat_entry SET lane_number = ? WHERE id = ?', a.lane_number, a.heat_entry_id);
                }
            })();
            res.json({ success: true, updated: assignments.length });
        } catch (err) {
            res.status(500).json({ error: '레인 업데이트 실패: ' + err.message });
        }
    });

    app.post('/api/lanes/assign', async (req, res) => {
        const { heat_id, assignments } = req.body;
        if (!heat_id || !assignments) return res.status(400).json({ error: 'Missing fields' });
        await db.transaction(async () => {
            for (const a of assignments) {
                await db.run('UPDATE heat_entry SET lane_number=? WHERE heat_id=? AND event_entry_id=?', a.lane_number, heat_id, a.event_entry_id);
            }
        })();
        res.json({ success: true });
    });

    // Update heat entries — batch move athletes between heats and update lane numbers
    app.post('/api/admin/heats/update-entries', async (req, res) => {
        const { heat_id, entries, admin_key } = req.body;
        if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
        if (!heat_id || !entries) return res.status(400).json({ error: 'Missing fields' });
        await db.transaction(async () => {
            for (const e of entries) {
                await db.run('UPDATE heat_entry SET lane_number=? WHERE heat_id=? AND event_entry_id=?', e.lane_number, heat_id, e.event_entry_id);
            }
        })();
        res.json({ success: true });
    });

    // Update sub_group (A/B) for a heat entry
    app.post('/api/admin/heat-entry/set-group', async (req, res) => {
        const { heat_entry_id, event_entry_id, heat_id, sub_group, admin_key } = req.body;
        if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
        const g = sub_group ? String(sub_group).toUpperCase() : null;
        if (heat_entry_id) {
            await db.run('UPDATE heat_entry SET sub_group=? WHERE id=?', g, heat_entry_id);
        } else if (heat_id && event_entry_id) {
            await db.run('UPDATE heat_entry SET sub_group=? WHERE heat_id=? AND event_entry_id=?', g, heat_id, event_entry_id);
        } else {
            return res.status(400).json({ error: 'heat_entry_id or (heat_id + event_entry_id) required' });
        }
        res.json({ success: true, sub_group: g });
    });

    // ============================================================
    // ROUND STATUS
    // ============================================================
    app.get('/api/round-status', async (req, res) => {
        const compId = req.query.competition_id;
        let q = 'SELECT * FROM event WHERE parent_event_id IS NULL';
        const p = [];
        if (compId) { q += ' AND competition_id=?'; p.push(compId); }
        q += ' ORDER BY sort_order, id';
        const events = await db.all(q, ...p);
        const result = await Promise.all(events.map(async e => {
            const heats = await db.all('SELECT id FROM heat WHERE event_id=?', e.id);
            let totalEntries = 0, totalResults = 0;
            for (const h of heats) {
                const entRow = await db.get('SELECT COUNT(*) AS c FROM heat_entry WHERE heat_id=?', h.id);
                totalEntries += (entRow && entRow.c) || 0;
                const resRow = await db.get('SELECT COUNT(DISTINCT event_entry_id) AS c FROM result WHERE heat_id=?', h.id);
                totalResults += (resRow && resRow.c) || 0;
            }
            return { ...e, heat_count: heats.length, total_entries: totalEntries, total_results: totalResults };
        }));
        res.json(result);
    });

    // ============================================================
    // FULL RESULTS EXPORT
    // ============================================================
    app.get('/api/events/:id/full-results', async (req, res) => {
        const event = await db.get('SELECT * FROM event WHERE id=?', req.params.id);
        if (!event) return res.status(404).json({ error: 'Event not found' });
        const heats = await db.all('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number', event.id);
        const quals = await db.all('SELECT * FROM qualification_selection WHERE event_id=? AND selected=1', event.id);
        const result = await Promise.all(heats.map(async h => {
            const entries = await db.all(`SELECT he.lane_number, he.sub_group, ee.id AS event_entry_id, ee.status, ee.manual_rank,
                   a.name, a.bib_number, a.team, a.name_alt, COALESCE(NULLIF(ee.personal_best,''), a.personal_best) AS personal_best, COALESCE(NULLIF(ee.season_best,''), a.season_best) AS season_best FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id
                   JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=? ORDER BY he.lane_number ASC, ${orderByBibSql('a.bib_number')}`, h.id);
            if (event.category === 'field_height') {
                return { ...h, entries, height_attempts: await db.all('SELECT * FROM height_attempt WHERE heat_id=? ORDER BY bar_height, event_entry_id, attempt_number', h.id) };
            }
            return { ...h, entries, results: await db.all('SELECT * FROM result WHERE heat_id=? ORDER BY event_entry_id, attempt_number', h.id) };
        }));
        // 명단이 아직 없는 조는 뺀다 (국제대회: 공식 일정엔 4조였다가 2조로 줄어드는 등) — 명단 있는 조가 하나라도 있을 때만
        const filled = result.filter(h => (h.entries || []).length > 0);
        res.json({ event, heats: filled.length ? filled : result, qualifications: quals });
    });

    return { _undoSnapshotEvent };
};
