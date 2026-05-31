/**
 * Competition Series — CRUD routes
 *
 * server.js 에서 추출됨 (2단계 모듈 분리).
 * 의존성: db, isAdminKey, opLog
 *
 * 라우트:
 *   GET    /api/competition-series
 *   POST   /api/competition-series
 *   PUT    /api/competition-series/:id
 *   DELETE /api/competition-series/:id  (soft delete: active=0)
 */
module.exports = function mountCompetitionSeriesRoutes(app, deps) {
    const { db, isAdminKey, opLog } = deps;
    if (!app || !db || !isAdminKey || !opLog) {
        throw new Error('[competition_series.js] mount requires { db, isAdminKey, opLog }');
    }

    app.get('/api/competition-series', async (req, res) => {
        try {
            const rows = await db.all(`
                SELECT s.*,
                    (SELECT COUNT(*) FROM competition c WHERE c.series_id = s.id) AS comp_count,
                    (SELECT COUNT(*) FROM event_record er WHERE er.series_id = s.id) AS record_count
                FROM competition_series s
                WHERE s.active = 1
                ORDER BY s.name
            `);
            res.json(rows);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/competition-series', async (req, res) => {
        try {
            const { admin_key, name, federation, description } = req.body;
            if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
            if (!name || !name.trim()) return res.status(400).json({ error: '시리즈명 필수' });
            try {
                const info = await db.run(
                    'INSERT INTO competition_series (name, federation, description) VALUES (?, ?, ?)',
                    name.trim(), (federation || '').trim(), (description || '').trim()
                );
                const row = await db.get('SELECT * FROM competition_series WHERE id=?', info.lastInsertRowid);
                opLog(`대회 시리즈 생성: ${name}`, 'admin', 'admin');
                res.json(row);
            } catch (e) {
                if (/UNIQUE|duplicate/i.test(e.message)) return res.status(400).json({ error: '같은 이름의 시리즈가 이미 존재합니다.' });
                throw e;
            }
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.put('/api/competition-series/:id', async (req, res) => {
        try {
            const { admin_key, name, federation, description } = req.body;
            if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
            const old = await db.get('SELECT * FROM competition_series WHERE id=?', req.params.id);
            if (!old) return res.status(404).json({ error: 'Not found' });
            const nowExpr = db.isAsync ? 'NOW()' : `datetime('now')`;
            await db.run(
                `UPDATE competition_series SET name=?, federation=?, description=?, updated_at=${nowExpr} WHERE id=?`,
                (name ?? old.name).trim(), (federation ?? old.federation ?? '').trim(),
                (description ?? old.description ?? '').trim(),
                req.params.id
            );
            res.json(await db.get('SELECT * FROM competition_series WHERE id=?', req.params.id));
        } catch (err) {
            if (/UNIQUE|duplicate/i.test(err.message)) return res.status(400).json({ error: '같은 이름의 시리즈가 이미 존재합니다.' });
            res.status(500).json({ error: err.message });
        }
    });

    app.delete('/api/competition-series/:id', async (req, res) => {
        try {
            const { admin_key } = req.body || {};
            if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
            const series = await db.get('SELECT * FROM competition_series WHERE id=?', req.params.id);
            if (!series) return res.status(404).json({ error: 'Not found' });
            // Soft delete: 연결된 대회/기록이 있어도 cascade 안 함. active=0 처리.
            const linkedComps = await db.get('SELECT COUNT(*)::int AS c FROM competition WHERE series_id=?', req.params.id)
                .catch(async () => await db.get('SELECT COUNT(*) AS c FROM competition WHERE series_id=?', req.params.id));
            const linkedRecs = await db.get('SELECT COUNT(*)::int AS c FROM event_record WHERE series_id=?', req.params.id)
                .catch(async () => await db.get('SELECT COUNT(*) AS c FROM event_record WHERE series_id=?', req.params.id));
            await db.run('UPDATE competition_series SET active=0 WHERE id=?', req.params.id);
            opLog(`대회 시리즈 비활성화: ${series.name} (연결 대회 ${linkedComps?.c || 0}개, 기록 ${linkedRecs?.c || 0}개 유지)`, 'admin', 'admin');
            res.json({ success: true, linked_competitions: linkedComps?.c || 0, linked_records: linkedRecs?.c || 0 });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
};
