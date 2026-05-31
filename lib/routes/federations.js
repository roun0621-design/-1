/**
 * Federation List — CRUD routes
 *
 * server.js 에서 추출됨 (2단계 모듈 분리).
 * 외부 의존성: db, isAdminKey, opLog 만 사용.
 *
 * 사용법:
 *   const federationsRoutes = require('./lib/routes/federations');
 *   federationsRoutes(app, { db, isAdminKey, opLog });
 *
 * 라우트:
 *   GET    /api/federations
 *   POST   /api/federations
 *   PUT    /api/federations/:id
 *   DELETE /api/federations/:id
 *   PUT    /api/federations/reorder    (주의: '/:id' 와 충돌 방지 위해 등록 순서 중요 → 별도 등록)
 */
module.exports = function mountFederationRoutes(app, deps) {
    const { db, isAdminKey, opLog } = deps;
    if (!app || !db || !isAdminKey || !opLog) {
        throw new Error('[federations.js] mount requires { db, isAdminKey, opLog }');
    }

    app.get('/api/federations', async (req, res) => {
        const rows = await db.all('SELECT * FROM federation_list ORDER BY sort_order, code');
        res.json(rows);
    });

    app.post('/api/federations', async (req, res) => {
        const { admin_key, code, name, badge_bg, badge_color, gender_label_m, gender_label_f, gender_label_x } = req.body;
        if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        if (!code || !code.trim()) return res.status(400).json({ error: '연맹 코드는 필수입니다.' });
        try {
            const maxOrderRow = await db.get('SELECT MAX(sort_order) as m FROM federation_list');
            const maxOrder = (maxOrderRow && maxOrderRow.m) || 0;
            const info = await db.run(
                'INSERT INTO federation_list (code, name, badge_bg, badge_color, sort_order, gender_label_m, gender_label_f, gender_label_x) VALUES (?,?,?,?,?,?,?,?)',
                code.trim().toUpperCase(), name || '', badge_bg || '#e3f2fd', badge_color || '#1565c0',
                maxOrder + 1, gender_label_m || '', gender_label_f || '', gender_label_x || ''
            );
            opLog(`연맹 추가: ${code}`, 'admin', 'admin');
            res.json({ id: info.lastInsertRowid, success: true });
        } catch (e) {
            if (e.message.includes('UNIQUE')) return res.status(400).json({ error: '이미 존재하는 연맹 코드입니다.' });
            res.status(500).json({ error: e.message });
        }
    });

    // ⚠️ /reorder 는 /:id 보다 먼저 등록되어야 Express 가 정확히 매칭함
    app.put('/api/federations/reorder', async (req, res) => {
        const { admin_key, order } = req.body;
        if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        if (!Array.isArray(order)) return res.status(400).json({ error: 'order array required' });
        await db.transaction(async () => {
            for (let i = 0; i < order.length; i++) {
                await db.run('UPDATE federation_list SET sort_order=? WHERE id=?', i + 1, order[i]);
            }
        })();
        res.json({ success: true });
    });

    app.put('/api/federations/:id', async (req, res) => {
        const { admin_key, code, name, badge_bg, badge_color, sort_order, gender_label_m, gender_label_f, gender_label_x } = req.body;
        if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        const old = await db.get('SELECT * FROM federation_list WHERE id=?', req.params.id);
        if (!old) return res.status(404).json({ error: 'Not found' });
        try {
            await db.run(
                'UPDATE federation_list SET code=?, name=?, badge_bg=?, badge_color=?, sort_order=?, gender_label_m=?, gender_label_f=?, gender_label_x=? WHERE id=?',
                code || old.code, name ?? old.name, badge_bg || old.badge_bg, badge_color || old.badge_color,
                sort_order ?? old.sort_order,
                gender_label_m ?? old.gender_label_m ?? '',
                gender_label_f ?? old.gender_label_f ?? '',
                gender_label_x ?? old.gender_label_x ?? '',
                old.id
            );
            opLog(`연맹 수정: ${code || old.code}`, 'admin', 'admin');
            res.json({ success: true });
        } catch (e) {
            if (e.message.includes('UNIQUE')) return res.status(400).json({ error: '이미 존재하는 연맹 코드입니다.' });
            res.status(500).json({ error: e.message });
        }
    });

    app.delete('/api/federations/:id', async (req, res) => {
        const { admin_key } = req.body;
        if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        const old = await db.get('SELECT * FROM federation_list WHERE id=?', req.params.id);
        if (!old) return res.status(404).json({ error: 'Not found' });
        await db.run('DELETE FROM federation_list WHERE id=?', old.id);
        opLog(`연맹 삭제: ${old.code}`, 'admin', 'admin');
        res.json({ success: true });
    });
};
