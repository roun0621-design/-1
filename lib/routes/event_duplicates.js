'use strict';
/**
 * 종목 중복 진단·정리·병합 — server.js 에서 이동 (2026-09-22, Phase 4 분해). 동작은 인라인 시절과 같다.
 *   deps: db, isAdminKey, opLog
 */
module.exports = function mountEventDuplicatesRoutes(app, deps) {
    const { db, isAdminKey, opLog } = deps;
    for (const k of ["db","isAdminKey","opLog"]) if (deps[k] === undefined) throw new Error('[event_duplicates.js] mount requires deps.' + k);

    app.get('/api/admin/event-duplicates', async (req, res) => {
        if (!isAdminKey(req.query.admin_key || req.headers['x-admin-key'])) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        const competition_id = parseInt(req.query.competition_id);
        if (!competition_id) return res.status(400).json({ error: 'competition_id 필요' });
        try {
            const events = await db.all(
                'SELECT id, name, category, gender, round_type, round_status FROM event WHERE competition_id=? AND parent_event_id IS NULL ORDER BY id',
                competition_id
            );
            const _norm = s => String(s || '').replace(/[,\s]+/g, '').toLowerCase();
            const groups = new Map();
            for (const e of events) {
                const k = `${_norm(e.name)}|${e.gender}|${e.round_type || ''}`;
                if (!groups.has(k)) groups.set(k, []);
                groups.get(k).push(e);
            }
            const result = [];
            for (const [key, list] of groups) {
                if (list.length < 2) continue;
                // For each event in the group, count attached data
                const enriched = [];
                for (const e of list) {
                    const heatCnt = (await db.get('SELECT COUNT(*) AS c FROM heat WHERE event_id=?', e.id))?.c || 0;
                    const entryCnt = (await db.get('SELECT COUNT(*) AS c FROM event_entry WHERE event_id=?', e.id))?.c || 0;
                    const resultCnt = (await db.get('SELECT COUNT(*) AS c FROM result r JOIN heat h ON h.id=r.heat_id WHERE h.event_id=?', e.id))?.c || 0;
                    const inJointCnt = (await db.get('SELECT COUNT(*) AS c FROM joint_group_member WHERE event_id=?', e.id))?.c || 0;
                    enriched.push({ ...e, heat_count: heatCnt, entry_count: entryCnt, result_count: resultCnt, joint_member_count: inJointCnt });
                }
                // Sort: prefer the one with most data (results > entries > heats > lowest id)
                enriched.sort((a, b) =>
                    (b.result_count - a.result_count) ||
                    (b.entry_count - a.entry_count) ||
                    (b.heat_count - a.heat_count) ||
                    (a.id - b.id)
                );
                result.push({
                    key,
                    name: list[0].name,
                    gender: list[0].gender,
                    round_type: list[0].round_type,
                    keep: enriched[0],         // 보존 대상
                    duplicates: enriched.slice(1),  // 삭제 대상 (사용자 확인 필요)
                });
            }
            res.json({ competition_id, duplicate_groups: result, total_dup_events: result.reduce((s,g) => s + g.duplicates.length, 0) });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    /**
     * POST /api/admin/event-duplicates/cleanup
     * Body: { admin_key, competition_id, dry_run?: bool, only_empty?: bool }
     * 중복 종목 중 데이터가 비어있는 것(empty) 또는 명시적으로 안전한 것만 삭제.
     * dry_run=true 이면 삭제는 안 하고 어떤 것들이 삭제될지 목록만 반환.
     * only_empty=true (default) 이면 entry/result/heat이 전부 0인 중복만 삭제 (가장 안전).
     */
    app.post('/api/admin/event-duplicates/cleanup', async (req, res) => {
        if (!isAdminKey(req.body.admin_key || req.headers['x-admin-key'])) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        const competition_id = parseInt(req.body.competition_id);
        if (!competition_id) return res.status(400).json({ error: 'competition_id 필요' });
        const dryRun = req.body.dry_run === true || req.body.dry_run === 'true';
        const onlyEmpty = req.body.only_empty !== false && req.body.only_empty !== 'false';  // default true

        try {
            // Reuse diagnostic
            const events = await db.all(
                'SELECT id, name, category, gender, round_type FROM event WHERE competition_id=? AND parent_event_id IS NULL ORDER BY id',
                competition_id
            );
            const _norm = s => String(s || '').replace(/[,\s]+/g, '').toLowerCase();
            const groups = new Map();
            for (const e of events) {
                const k = `${_norm(e.name)}|${e.gender}|${e.round_type || ''}`;
                if (!groups.has(k)) groups.set(k, []);
                groups.get(k).push(e);
            }

            const candidates = [];   // events that will/would be deleted
            const skipped = [];      // events skipped (had data, not safe to delete)

            for (const [key, list] of groups) {
                if (list.length < 2) continue;
                const enriched = [];
                for (const e of list) {
                    const heatCnt = (await db.get('SELECT COUNT(*) AS c FROM heat WHERE event_id=?', e.id))?.c || 0;
                    const entryCnt = (await db.get('SELECT COUNT(*) AS c FROM event_entry WHERE event_id=?', e.id))?.c || 0;
                    const resultCnt = (await db.get('SELECT COUNT(*) AS c FROM result r JOIN heat h ON h.id=r.heat_id WHERE h.event_id=?', e.id))?.c || 0;
                    enriched.push({ ...e, heat_count: heatCnt, entry_count: entryCnt, result_count: resultCnt });
                }
                // keep best (most data); delete others IF empty
                enriched.sort((a, b) =>
                    (b.result_count - a.result_count) ||
                    (b.entry_count - a.entry_count) ||
                    (b.heat_count - a.heat_count) ||
                    (a.id - b.id)
                );
                const keep = enriched[0];
                for (const dup of enriched.slice(1)) {
                    const isEmpty = dup.heat_count === 0 && dup.entry_count === 0 && dup.result_count === 0;
                    if (onlyEmpty && !isEmpty) {
                        skipped.push({ ...dup, reason: 'has data (heat/entry/result)' });
                        continue;
                    }
                    candidates.push({ ...dup, keep_id: keep.id });
                }
            }

            if (dryRun) {
                return res.json({ dry_run: true, would_delete: candidates, skipped, total: candidates.length });
            }

            // Actually delete
            let deleted = 0;
            await db.transaction(async () => {
                for (const c of candidates) {
                    // Re-point joint_group_member rows to the kept event (de-dupe later if same group)
                    await db.run('UPDATE OR IGNORE joint_group_member SET event_id=? WHERE event_id=?', c.keep_id, c.id);
                    // Remove the joint_group_member rows that conflicted (same group already had keep_id)
                    await db.run('DELETE FROM joint_group_member WHERE event_id=?', c.id);
                    // Clean up child rows (these should all be 0 if onlyEmpty=true, defensive otherwise)
                    const heats = await db.all('SELECT id FROM heat WHERE event_id=?', c.id);
                    for (const h of heats) {
                        await db.run('DELETE FROM result WHERE heat_id=?', h.id);
                        await db.run('DELETE FROM height_attempt WHERE heat_id=?', h.id);
                        await db.run('DELETE FROM heat_entry WHERE heat_id=?', h.id);
                    }
                    await db.run('DELETE FROM heat WHERE event_id=?', c.id);
                    await db.run('DELETE FROM event_entry WHERE event_id=?', c.id);
                    await db.run('DELETE FROM event_link WHERE event_id_a=? OR event_id_b=?', c.id, c.id);
                    await db.run('DELETE FROM event WHERE id=?', c.id);
                    deleted++;
                }
            })();
            opLog(`중복 종목 정리: ${deleted}개 종목 삭제 (대회 ${competition_id})`, 'admin', 'admin');
            res.json({ dry_run: false, deleted, skipped, total: candidates.length });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    /**
     * POST /api/admin/event-duplicates/merge
     * Body: { admin_key, keep_id, dup_id, dry_run? }
     *
     * 두 중복 종목을 안전하게 병합. dup 의 모든 데이터를 keep 으로 이전한 뒤 dup 삭제.
     *
     * 처리 순서 (트랜잭션):
     *  1. dup 의 entry 중, 같은 athlete 가 keep 에도 있는지 검사 — 있으면 dup 측만 삭제 (keep 우선)
     *  2. dup 의 남은 entry 를 keep 으로 event_id 이전 (UPDATE event_entry SET event_id=keep_id)
     *  3. dup 의 heat 을 keep 으로 이전. heat_number 충돌하면 keep 의 max+1 로 재번호
     *  4. dup 의 joint_group_member 를 keep 으로 이전, UNIQUE 충돌 시 dup 측 삭제
     *  5. dup 의 event_link / event_video 등 메타 정리
     *  6. dup 삭제
     *
     * dry_run=true 면 어떤 일이 일어날지 카운트만 반환 (실제 변경 X).
     */
    app.post('/api/admin/event-duplicates/merge', async (req, res) => {
        if (!isAdminKey(req.body.admin_key || req.headers['x-admin-key'])) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        const keep_id = parseInt(req.body.keep_id);
        const dup_id = parseInt(req.body.dup_id);
        const dryRun = req.body.dry_run === true || req.body.dry_run === 'true';
        if (!keep_id || !dup_id) return res.status(400).json({ error: 'keep_id, dup_id 필요' });
        if (keep_id === dup_id) return res.status(400).json({ error: 'keep_id 와 dup_id 가 동일' });

        try {
            const keep = await db.get('SELECT * FROM event WHERE id=?', keep_id);
            const dup = await db.get('SELECT * FROM event WHERE id=?', dup_id);
            if (!keep || !dup) return res.status(404).json({ error: '종목을 찾을 수 없음' });
            if (keep.competition_id !== dup.competition_id) return res.status(400).json({ error: '두 종목이 다른 대회에 속함 — 머지 불가' });

            // 1. dup 의 entry 분석
            const keepAthIds = new Set((await db.all('SELECT athlete_id FROM event_entry WHERE event_id=?', keep_id)).map(r => r.athlete_id));
            const dupEntries = await db.all('SELECT id, athlete_id FROM event_entry WHERE event_id=?', dup_id);
            const conflictEntries = dupEntries.filter(e => keepAthIds.has(e.athlete_id));
            const moveEntries = dupEntries.filter(e => !keepAthIds.has(e.athlete_id));

            // 2. heat 분석
            const dupHeats = await db.all('SELECT id, heat_number FROM heat WHERE event_id=?', dup_id);
            const keepMaxHeat = (await db.get('SELECT COALESCE(MAX(heat_number), 0) AS m FROM heat WHERE event_id=?', keep_id))?.m || 0;

            // 3. joint_group_member 분석
            const dupJgm = await db.all('SELECT id, joint_group_id FROM joint_group_member WHERE event_id=?', dup_id);
            const keepJgmGroups = new Set((await db.all('SELECT joint_group_id FROM joint_group_member WHERE event_id=?', keep_id)).map(r => r.joint_group_id));
            const conflictJgm = dupJgm.filter(j => keepJgmGroups.has(j.joint_group_id));
            const moveJgm = dupJgm.filter(j => !keepJgmGroups.has(j.joint_group_id));

            const summary = {
                keep_id, dup_id,
                keep_event: { name: keep.name, gender: keep.gender, round_type: keep.round_type },
                dup_event:  { name: dup.name,  gender: dup.gender,  round_type: dup.round_type },
                entries: {
                    will_move:   moveEntries.length,
                    will_delete: conflictEntries.length,
                    reason: conflictEntries.length > 0 ? '같은 선수가 양쪽에 있으면 keep 측을 유지하고 dup 측 삭제' : ''
                },
                heats: {
                    will_move: dupHeats.length,
                    renumber_from: keepMaxHeat + 1,
                    detail: dupHeats.map(h => ({ old_heat_number: h.heat_number, new_heat_number: keepMaxHeat + h.heat_number }))
                },
                joint_members: {
                    will_move:   moveJgm.length,
                    will_delete: conflictJgm.length,
                }
            };

            if (dryRun) return res.json({ dry_run: true, summary });

            await db.transaction(async () => {
                // 1) 충돌 entry → 삭제 (keep 측 유지)
                for (const e of conflictEntries) {
                    // heat_entry 도 함께 정리
                    await db.run('DELETE FROM heat_entry WHERE event_entry_id=?', e.id);
                    await db.run('DELETE FROM event_entry WHERE id=?', e.id);
                }
                // 2) 남은 entry → keep 으로 이전
                for (const e of moveEntries) {
                    await db.run('UPDATE event_entry SET event_id=? WHERE id=?', keep_id, e.id);
                }
                // 3) heat → 재번호 후 keep 으로 이전. heat_entry 는 heat_id 만 따라가므로 자동 OK.
                for (const h of dupHeats) {
                    const newNum = keepMaxHeat + h.heat_number;
                    await db.run('UPDATE heat SET event_id=?, heat_number=? WHERE id=?', keep_id, newNum, h.id);
                }
                // 4) joint_group_member → 이전 / 충돌 시 삭제
                for (const j of moveJgm) {
                    await db.run('UPDATE joint_group_member SET event_id=? WHERE id=?', keep_id, j.id);
                }
                for (const j of conflictJgm) {
                    await db.run('DELETE FROM joint_group_member WHERE id=?', j.id);
                }
                // 5) event_link 의 dup 측 참조를 keep 으로 (있으면)
                await db.run('UPDATE OR IGNORE event_link SET event_id_a=? WHERE event_id_a=?', keep_id, dup_id);
                await db.run('UPDATE OR IGNORE event_link SET event_id_b=? WHERE event_id_b=?', keep_id, dup_id);
                await db.run('DELETE FROM event_link WHERE event_id_a=? OR event_id_b=?', dup_id, dup_id);
                // 6) timetable 의 dup 참조도 keep 으로 (모두 끊지 말고 이전)
                await db.run('UPDATE timetable SET event_id=? WHERE event_id=?', keep_id, dup_id);
                // 7) dup 본체 삭제
                await db.run('DELETE FROM event WHERE id=?', dup_id);
            })();

            opLog(`중복 종목 병합: dup=${dup_id} → keep=${keep_id} (${keep.name} ${keep.gender})`, 'admin', 'admin', keep.competition_id);
            res.json({ dry_run: false, merged: true, summary });
        } catch (e) {
            console.error('[event-duplicates/merge] failed:', e);
            res.status(500).json({ error: e.message });
        }
    });


    return {  };
};
