/**
 * Joint Groups (합동 종목 그룹 — 다중 대회 N:N) routes
 *
 * server.js 에서 추출됨 (2단계 모듈 분리 — 8차).
 * 외부 의존성: db, isOperationKey, opLog
 *
 * 라우트 (9개):
 *   GET    /api/joint-groups                          competition_id 의 그룹 목록 (event JOIN)
 *   POST   /api/joint-groups                          신규 그룹 생성 (member 동시 등록)
 *   PUT    /api/joint-groups/:id                      그룹 이름/상태 수정
 *   DELETE /api/joint-groups/:id                      그룹 삭제 (member CASCADE)
 *   POST   /api/joint-groups/:id/members              member 추가 (event_id 단건/배열)
 *   DELETE /api/joint-groups/:groupId/members/:eventId  단일 member 제거
 *   POST   /api/joint-groups/auto-create              competition_id 기반 자동 그룹 생성
 *   GET    /api/joint-groups/by-event/:eventId        event_id 가 속한 그룹 1건
 *   GET    /api/joint-groups/:id/entries              그룹의 모든 entry (athlete×event JOIN)
 *
 * ⚠️ /auto-create, /by-event/:eventId 는 /:id 보다 먼저 등록되어야 충돌 없음 (Express 매칭 순서).
 * 실제 코드도 정적 경로(`/auto-create`)와 prefix 경로(`/by-event/...`)가 먼저 등록되어 있음.
 */
module.exports = function mountJointGroupsRoutes(app, deps) {
    const { db, isOperationKey, opLog } = deps;
    if (!app || !db || !isOperationKey || !opLog) {
        throw new Error('[joint_groups.js] mount requires { db, isOperationKey, opLog }');
    }

/**
 * GET /api/joint-groups?competition_id=N
 * List all joint groups that contain events from the given competition
 */
app.get('/api/joint-groups', async (req, res) => {
    const { competition_id } = req.query;
    if (!competition_id) return res.status(400).json({ error: 'competition_id 필수' });
    const groups = await db.all(`
        SELECT DISTINCT jg.* FROM joint_group jg
        JOIN joint_group_member jgm ON jgm.joint_group_id = jg.id
        WHERE jgm.competition_id = ?
        ORDER BY jg.id
    `, competition_id);
    // For each group, fetch members
    const result = await Promise.all(groups.map(async g => {
        const members = await db.all(`
            SELECT jgm.*, e.name as event_name, e.gender, e.round_type, e.category,
                   c.name as comp_name, c.federation
            FROM joint_group_member jgm
            JOIN event e ON e.id = jgm.event_id
            JOIN competition c ON c.id = jgm.competition_id
            WHERE jgm.joint_group_id = ?
            ORDER BY jgm.sort_order
        `, g.id);
        return { ...g, members };
    }));
    res.json(result);
});

/**
 * POST /api/joint-groups
 * Create a new joint group with selected events (multi-select)
 * Body: { admin_key, name, event_ids: [id1, id2, ...] }
 */
app.post('/api/joint-groups', async (req, res) => {
    const { admin_key, name, event_ids } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    if (!event_ids || !Array.isArray(event_ids) || event_ids.length < 2) {
        return res.status(400).json({ error: '최소 2개 이상의 종목을 선택하세요.' });
    }
    // Verify all events exist
    const events = [];
    for (const id of event_ids) {
        const e = await db.get('SELECT e.*, c.name as comp_name, c.federation FROM event e JOIN competition c ON c.id=e.competition_id WHERE e.id=?', id);
        if (e) events.push(e);
    }
    if (events.length < 2) return res.status(400).json({ error: '유효한 종목이 2개 미만입니다.' });

    // Auto-generate scoreboard key
    const genderLabel = { M: '남자', F: '여자', X: '혼성' }[events[0].gender] || '';
    const roundLabel = { preliminary: '예선', semifinal: '준결승', final: '결승' }[events[0].round_type] || '';
    const autoKey = `합동 ${genderLabel} ${events[0].name} ${roundLabel}`.trim();
    const groupName = name || events[0].name;

    let groupId;
    await db.transaction(async () => {
        const info = await db.run('INSERT INTO joint_group (name, joint_scoreboard_key) VALUES (?, ?)', groupName, autoKey);
        groupId = info.lastInsertRowid;
        for (let idx = 0; idx < events.length; idx++) {
            const evt = events[idx];
            await db.run('INSERT OR IGNORE INTO joint_group_member (joint_group_id, event_id, competition_id, sort_order) VALUES (?, ?, ?, ?)', groupId, evt.id, evt.competition_id, idx);
        }
        // Also maintain backward-compat event_link for scoreboard (pair-wise)
        for (let i = 0; i < events.length; i++) {
            for (let j = i + 1; j < events.length; j++) {
                const [idA, idB] = events[i].id < events[j].id ? [events[i].id, events[j].id] : [events[j].id, events[i].id];
                await db.run('INSERT OR IGNORE INTO event_link (event_id_a, event_id_b, joint_scoreboard_key) VALUES (?, ?, ?)', idA, idB, autoKey);
            }
        }
    })();

    const feds = events.map(e => e.federation || e.comp_name).join('+');
    opLog(`합동 그룹 생성: ${groupName} (${feds}, ${events.length}개 종목)`, 'admin', 'admin');
    const created = await db.get('SELECT * FROM joint_group WHERE id=?', groupId);
    res.json({ success: true, group: created });
});

/**
 * PUT /api/joint-groups/:id
 * Update a joint group (name, scoreboard key)
 * Body: { admin_key, name?, joint_scoreboard_key? }
 */
app.put('/api/joint-groups/:id', async (req, res) => {
    const { admin_key, name, joint_scoreboard_key } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    const g = await db.get('SELECT * FROM joint_group WHERE id=?', req.params.id);
    if (!g) return res.status(404).json({ error: 'Joint group not found' });

    const updates = [], params = [];
    if (name !== undefined) { updates.push('name=?'); params.push(name); }
    if (joint_scoreboard_key !== undefined) {
        updates.push('joint_scoreboard_key=?');
        params.push(joint_scoreboard_key);
        // Also update event_link backward compat keys
        const members = await db.all('SELECT event_id FROM joint_group_member WHERE joint_group_id=?', g.id);
        const ids = members.map(m => m.event_id);
        for (let i = 0; i < ids.length; i++) {
            for (let j = i + 1; j < ids.length; j++) {
                const [idA, idB] = ids[i] < ids[j] ? [ids[i], ids[j]] : [ids[j], ids[i]];
                await db.run('UPDATE event_link SET joint_scoreboard_key=? WHERE event_id_a=? AND event_id_b=?', joint_scoreboard_key, idA, idB);
            }
        }
    }
    if (updates.length === 0) return res.status(400).json({ error: '수정할 항목이 없습니다.' });
    params.push(g.id);
    await db.run(`UPDATE joint_group SET ${updates.join(',')} WHERE id=?`, ...params);
    res.json({ success: true });
});

/**
 * DELETE /api/joint-groups/:id
 * Delete a joint group and its members
 */
app.delete('/api/joint-groups/:id', async (req, res) => {
    const { admin_key } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    const g = await db.get('SELECT * FROM joint_group WHERE id=?', req.params.id);
    if (!g) return res.status(404).json({ error: 'Joint group not found' });

    await db.transaction(async () => {
        // Remove backward-compat event_link entries
        const members = await db.all('SELECT event_id FROM joint_group_member WHERE joint_group_id=?', g.id);
        const ids = members.map(m => m.event_id);
        for (let i = 0; i < ids.length; i++) {
            for (let j = i + 1; j < ids.length; j++) {
                const [idA, idB] = ids[i] < ids[j] ? [ids[i], ids[j]] : [ids[j], ids[i]];
                await db.run('DELETE FROM event_link WHERE event_id_a=? AND event_id_b=?', idA, idB);
            }
        }
        await db.run('DELETE FROM joint_group_member WHERE joint_group_id=?', g.id);
        await db.run('DELETE FROM joint_group WHERE id=?', g.id);
    })();
    opLog(`합동 그룹 삭제: ${g.name}`, 'admin', 'admin');
    res.json({ success: true });
});

/**
 * POST /api/joint-groups/:id/members
 * Add events to an existing joint group
 * Body: { admin_key, event_ids: [id1, id2, ...] }
 */
app.post('/api/joint-groups/:id/members', async (req, res) => {
    const { admin_key, event_ids } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    const g = await db.get('SELECT * FROM joint_group WHERE id=?', req.params.id);
    if (!g) return res.status(404).json({ error: 'Joint group not found' });
    if (!event_ids || !Array.isArray(event_ids) || event_ids.length === 0) return res.status(400).json({ error: 'event_ids 필수' });

    const maxSort = await db.get('SELECT MAX(sort_order) AS m FROM joint_group_member WHERE joint_group_id=?', g.id);
    let nextSort = (maxSort?.m || 0) + 1;
    const existingMemberRows = await db.all('SELECT event_id FROM joint_group_member WHERE joint_group_id=?', g.id);
    const existingMembers = existingMemberRows.map(m => m.event_id);

    let added = 0;
    await db.transaction(async () => {
        for (const eid of event_ids) {
            const evt = await db.get('SELECT * FROM event WHERE id=?', eid);
            if (!evt) continue;
            if (existingMembers.includes(eid)) continue;
            await db.run('INSERT OR IGNORE INTO joint_group_member (joint_group_id, event_id, competition_id, sort_order) VALUES (?, ?, ?, ?)', g.id, eid, evt.competition_id, nextSort++);
            // Add event_link pairs with all existing members
            for (const existId of existingMembers) {
                const [idA, idB] = eid < existId ? [eid, existId] : [existId, eid];
                await db.run('INSERT OR IGNORE INTO event_link (event_id_a, event_id_b, joint_scoreboard_key) VALUES (?, ?, ?)', idA, idB, g.joint_scoreboard_key || '');
            }
            existingMembers.push(eid);
            added++;
        }
    })();
    res.json({ success: true, added });
});

/**
 * DELETE /api/joint-groups/:groupId/members/:eventId
 * Remove a single event from a joint group
 */
app.delete('/api/joint-groups/:groupId/members/:eventId', async (req, res) => {
    const { admin_key } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    const gId = parseInt(req.params.groupId), eId = parseInt(req.params.eventId);
    await db.transaction(async () => {
        await db.run('DELETE FROM joint_group_member WHERE joint_group_id=? AND event_id=?', gId, eId);
        // Remove event_link pairs involving this event within the group
        const remainingRows = await db.all('SELECT event_id FROM joint_group_member WHERE joint_group_id=?', gId);
        const remaining = remainingRows.map(m => m.event_id);
        // Remove links between this event and any remaining group member
        // (careful: only remove if no other group links them)
        for (const rId of remaining) {
            const [idA, idB] = eId < rId ? [eId, rId] : [rId, eId];
            // Check if any other group still links these two
            const otherLink = await db.get(`SELECT 1 FROM joint_group_member jgm1
                JOIN joint_group_member jgm2 ON jgm2.joint_group_id=jgm1.joint_group_id AND jgm2.event_id=?
                WHERE jgm1.event_id=? AND jgm1.joint_group_id != ?`, idA, idB, gId);
            if (!otherLink) {
                await db.run('DELETE FROM event_link WHERE event_id_a=? AND event_id_b=?', idA, idB);
            }
        }
        // If group now has < 2 members, delete the whole group
        const countRow = await db.get('SELECT COUNT(*) AS c FROM joint_group_member WHERE joint_group_id=?', gId);
        const count = (countRow && countRow.c) || 0;
        if (count < 2) {
            await db.run('DELETE FROM joint_group_member WHERE joint_group_id=?', gId);
            await db.run('DELETE FROM joint_group WHERE id=?', gId);
        }
    })();
    res.json({ success: true });
});

/**
 * POST /api/joint-groups/auto-create
 * Auto-create joint groups for competitions by matching event names
 * Body: { admin_key, competition_ids: [id1, id2, ...] }
 */
app.post('/api/joint-groups/auto-create', async (req, res) => {
    const { admin_key, competition_ids } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    if (!competition_ids || competition_ids.length < 2) return res.status(400).json({ error: '최소 2개 대회를 선택하세요.' });

    // Get all events for each competition
    const compEvents = {};
    for (const cid of competition_ids) {
        compEvents[cid] = await db.all('SELECT e.*, c.name as comp_name, c.federation FROM event e JOIN competition c ON c.id=e.competition_id WHERE e.competition_id=? AND e.parent_event_id IS NULL', cid);
    }

    // Group events by name+gender+round_type across competitions
    const eventMap = {};
    for (const cid of competition_ids) {
        for (const evt of compEvents[cid]) {
            const key = `${evt.name}|${evt.gender}|${evt.round_type}`;
            if (!eventMap[key]) eventMap[key] = [];
            eventMap[key].push(evt);
        }
    }

    let created = 0;
    await db.transaction(async () => {
        for (const [key, events] of Object.entries(eventMap)) {
            if (events.length < 2) continue;
            // Check if already grouped
            const eventIds = events.map(e => e.id);
            const existing = await db.get(`SELECT jg.id FROM joint_group jg
                JOIN joint_group_member jgm ON jgm.joint_group_id=jg.id
                WHERE jgm.event_id IN (${eventIds.map(() => '?').join(',')})
                GROUP BY jg.id HAVING COUNT(*)>=2`, ...eventIds);
            if (existing) continue;

            const genderLabel = { M: '남자', F: '여자', X: '혼성' }[events[0].gender] || '';
            const roundLabel = { preliminary: '예선', semifinal: '준결승', final: '결승' }[events[0].round_type] || '';
            const jointKey = `합동 ${genderLabel} ${events[0].name} ${roundLabel}`.trim();

            const gInfo = await db.run('INSERT INTO joint_group (name, joint_scoreboard_key) VALUES (?, ?)', events[0].name, jointKey);
            for (let idx = 0; idx < events.length; idx++) {
                const evt = events[idx];
                await db.run('INSERT OR IGNORE INTO joint_group_member (joint_group_id, event_id, competition_id, sort_order) VALUES (?, ?, ?, ?)', gInfo.lastInsertRowid, evt.id, evt.competition_id, idx);
            }
            // backward-compat event_link
            for (let i = 0; i < events.length; i++) {
                for (let j = i + 1; j < events.length; j++) {
                    const [idA, idB] = events[i].id < events[j].id ? [events[i].id, events[j].id] : [events[j].id, events[i].id];
                    await db.run('INSERT OR IGNORE INTO event_link (event_id_a, event_id_b, joint_scoreboard_key) VALUES (?, ?, ?)', idA, idB, jointKey);
                }
            }
            created++;
        }
    })();

    opLog(`합동 그룹 자동 생성: ${created}개 그룹 (대회 ${competition_ids.join(', ')})`, 'admin', 'admin');
    res.json({ success: true, created });
});

/**
 * GET /api/joint-groups/by-event/:eventId
 * Get joint group info for a specific event (for callroom/record pages)
 */
app.get('/api/joint-groups/by-event/:eventId', async (req, res) => {
    const eventId = parseInt(req.params.eventId);
    const membership = await db.all(`
        SELECT jg.*, jgm.sort_order FROM joint_group jg
        JOIN joint_group_member jgm ON jgm.joint_group_id = jg.id
        WHERE jgm.event_id = ?
    `, eventId);
    if (membership.length === 0) return res.json(null);

    // Return all groups this event belongs to, with all their members
    const result = await Promise.all(membership.map(async g => {
        const members = await db.all(`
            SELECT jgm.*, e.name as event_name, e.gender, e.round_type, e.category,
                   c.name as comp_name, c.federation
            FROM joint_group_member jgm
            JOIN event e ON e.id = jgm.event_id
            JOIN competition c ON c.id = jgm.competition_id
            WHERE jgm.joint_group_id = ?
            ORDER BY jgm.sort_order
        `, g.id);
        return { ...g, members };
    }));
    res.json(result);
});

/**
 * GET /api/joint-groups/:id/entries
 * Get combined entries from all events in a joint group (for callroom view)
 */
app.get('/api/joint-groups/:id/entries', async (req, res) => {
    const gId = parseInt(req.params.id);
    const g = await db.get('SELECT * FROM joint_group WHERE id=?', gId);
    if (!g) return res.status(404).json({ error: 'Joint group not found' });

    const rawMembers = await db.all(`
        SELECT jgm.*, e.name as event_name, e.category, e.gender, e.round_type,
               c.name as comp_name, c.federation
        FROM joint_group_member jgm
        JOIN event e ON e.id = jgm.event_id
        JOIN competition c ON c.id = jgm.competition_id
        WHERE jgm.joint_group_id = ?
        ORDER BY jgm.sort_order
    `, gId);

    // Dedupe members by (competition_id, event_name, gender, round_type)
    // — 조편성 재업로드 등으로 같은 대회에 동일 종목이 여러 번 등록된 경우 1개만 사용
    const seenKey = new Set();
    const members = [];
    for (const m of rawMembers) {
        const k = `${m.competition_id}|${m.event_name}|${m.gender}|${m.round_type}`;
        if (seenKey.has(k)) continue;
        seenKey.add(k);
        members.push(m);
    }

    const allEntries = [];
    const seenEntry = new Set();   // dedupe by event_entry_id
    const seenAthHeat = new Set(); // dedupe by (athlete_id, source_event_key) — 안전장치
    for (const m of members) {
        const heat = await db.get('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number LIMIT 1', m.event_id);
        if (!heat) continue;
        const entries = await db.all(`
            SELECT he.lane_number, he.sub_group, ee.id as event_entry_id, ee.status, ee.event_id,
                   a.id as athlete_id, a.name, a.bib_number, a.team, a.gender, a.barcode
            FROM heat_entry he
            JOIN event_entry ee ON ee.id = he.event_entry_id
            JOIN athlete a ON a.id = ee.athlete_id
            WHERE he.heat_id = ?
            ORDER BY he.lane_number
        `, heat.id);
        entries.forEach(e => {
            if (seenEntry.has(e.event_entry_id)) return;
            const athKey = `${e.athlete_id}|${m.competition_id}|${m.event_name}|${m.gender}|${m.round_type}`;
            if (seenAthHeat.has(athKey)) return;
            seenEntry.add(e.event_entry_id);
            seenAthHeat.add(athKey);
            allEntries.push({
                ...e,
                heat_id: heat.id,
                federation: m.federation || m.comp_name,
                competition_id: m.competition_id,
                comp_name: m.comp_name,
                source_event_id: m.event_id,
            });
        });
    }
    res.json({ group: g, members, entries: allEntries });
});

// ============================================================
// EVENT DUPLICATE DIAGNOSTICS / CLEANUP — 중복 종목 진단·병합
// ============================================================

/**
 * GET /api/admin/event-duplicates?competition_id=N
 * 한 대회 안에서 같은 (normalized_name, gender, round_type)을 가진
 * parent_event 중복을 찾아서 그룹별로 반환.
 * 각 그룹의 첫 번째 id는 'keep', 나머지는 'duplicates'.
 * 함께 묶임 entry/heat/result 개수를 보여줘 사용자가 안전성 판단 가능.
 */
};
