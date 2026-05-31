/**
 * Event Link — 합동 종목 연결 (실업+대학 동시 진행 전광판)
 *
 * server.js 에서 추출됨 (2단계 모듈 분리).
 * 의존성: db, isOperationKey, opLog, generateJointScoreboardKey
 *
 * 라우트:
 *   GET    /api/event-links?competition_id=N
 *   POST   /api/event-links
 *   POST   /api/event-links/auto-match    (⚠️ /:id 보다 먼저)
 *   DELETE /api/event-links/:id
 */
module.exports = function mountEventLinkRoutes(app, deps) {
    const { db, isOperationKey, opLog, generateJointScoreboardKey } = deps;
    if (!app || !db || !isOperationKey || !opLog || !generateJointScoreboardKey) {
        throw new Error('[event_links.js] mount requires { db, isOperationKey, opLog, generateJointScoreboardKey }');
    }

    app.get('/api/event-links', async (req, res) => {
        const { competition_id } = req.query;
        if (!competition_id) return res.status(400).json({ error: 'competition_id 필수' });
        const links = await db.all(`
            SELECT el.*,
                   ea.name as event_a_name, ea.gender as event_a_gender, ea.category as event_a_category,
                   ca.name as comp_a_name, ca.federation as comp_a_federation,
                   eb.name as event_b_name, eb.gender as event_b_gender, eb.category as event_b_category,
                   cb.name as comp_b_name, cb.federation as comp_b_federation
            FROM event_link el
            JOIN event ea ON ea.id = el.event_id_a
            JOIN competition ca ON ca.id = ea.competition_id
            JOIN event eb ON eb.id = el.event_id_b
            JOIN competition cb ON cb.id = eb.competition_id
            WHERE ea.competition_id = ? OR eb.competition_id = ?
            ORDER BY ea.name, ea.gender
        `, competition_id, competition_id);
        res.json(links);
    });

    app.post('/api/event-links', async (req, res) => {
        const { admin_key, event_id_a, event_id_b } = req.body;
        if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
        if (!event_id_a || !event_id_b) return res.status(400).json({ error: 'event_id_a, event_id_b 필수' });
        if (event_id_a === event_id_b) return res.status(400).json({ error: '같은 종목끼리 연결할 수 없습니다.' });

        const evA = await db.get('SELECT * FROM event WHERE id=?', event_id_a);
        const evB = await db.get('SELECT * FROM event WHERE id=?', event_id_b);
        if (!evA || !evB) return res.status(404).json({ error: '종목을 찾을 수 없습니다.' });

        try {
            const [idA, idB] = event_id_a < event_id_b ? [event_id_a, event_id_b] : [event_id_b, event_id_a];
            await db.run('INSERT OR IGNORE INTO event_link (event_id_a, event_id_b) VALUES (?, ?)', idA, idB);

            const compA = await db.get('SELECT name, federation FROM competition WHERE id=?', evA.competition_id);
            const compB = await db.get('SELECT name, federation FROM competition WHERE id=?', evB.competition_id);
            opLog(`합동 종목 연결: ${evA.name}(${compA?.federation || compA?.name}) ↔ ${evB.name}(${compB?.federation || compB?.name})`, 'admin', 'admin');

            const jointKey = await generateJointScoreboardKey(evA, db);
            const link = await db.get('SELECT id FROM event_link WHERE event_id_a=? AND event_id_b=?', idA, idB);
            if (link) {
                await db.run('UPDATE event_link SET joint_scoreboard_key=? WHERE id=?', jointKey, link.id);
            }
            res.json({ success: true, joint_scoreboard_key: jointKey });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ⚠️ auto-match 는 /:id 보다 먼저
    app.post('/api/event-links/auto-match', async (req, res) => {
        const { admin_key, competition_id_a, competition_id_b } = req.body;
        if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
        if (!competition_id_a || !competition_id_b) return res.status(400).json({ error: 'competition_id_a, competition_id_b 필수' });

        const eventsA = await db.all('SELECT * FROM event WHERE competition_id=? AND parent_event_id IS NULL', competition_id_a);
        const eventsB = await db.all('SELECT * FROM event WHERE competition_id=? AND parent_event_id IS NULL', competition_id_b);

        let linked = 0;
        const matches = [];
        for (const a of eventsA) {
            const b = eventsB.find(e => e.name === a.name && e.gender === a.gender && e.round_type === a.round_type);
            if (b) {
                const [idA, idB] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
                const existing = await db.get('SELECT id FROM event_link WHERE event_id_a=? AND event_id_b=?', idA, idB);
                if (!existing) {
                    const jointKey = await generateJointScoreboardKey(a, db);
                    await db.run('INSERT INTO event_link (event_id_a, event_id_b, joint_scoreboard_key) VALUES (?, ?, ?)', idA, idB, jointKey);
                    linked++;
                }
                matches.push({ event_name: a.name, gender: a.gender, event_id_a: a.id, event_id_b: b.id });
            }
        }
        opLog(`합동 종목 자동 매칭: ${linked}개 연결 (대회 ${competition_id_a} ↔ ${competition_id_b})`, 'admin', 'admin');
        res.json({ success: true, linked, matches });
    });

    app.delete('/api/event-links/:id', async (req, res) => {
        const { admin_key } = req.body;
        if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
        await db.run('DELETE FROM event_link WHERE id=?', req.params.id);
        res.json({ success: true });
    });
};
