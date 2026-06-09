/**
 * Qualifications (예선 통과자 선발) routes
 *
 * server.js 에서 추출됨 (2단계 모듈 분리).
 *
 * 외부 의존성:
 *   db, isOperationKey
 *
 * 라우트 (3개):
 *   GET    /api/qualifications          종목별 선발 현황 (공개 — dashboard/results 조회용)
 *   POST   /api/qualifications/save     선발 저장 (운영키 필요)
 *   POST   /api/qualifications/approve  선발 승인 (운영키 필요)
 */
module.exports = function mountQualificationsRoutes(app, deps) {
    const { db, isOperationKey } = deps;
    if (!app || !db || !isOperationKey) {
        throw new Error('[qualifications.js] mount requires { db, isOperationKey }');
    }

    app.get('/api/qualifications', async (req, res) => {
        if (!req.query.event_id) return res.status(400).json({ error: 'event_id required' });
        res.json(await db.all(`SELECT qs.*, a.name, a.bib_number, a.team FROM qualification_selection qs
            JOIN event_entry ee ON ee.id=qs.event_entry_id JOIN athlete a ON a.id=ee.athlete_id WHERE qs.event_id=?`, req.query.event_id));
    });

    app.post('/api/qualifications/save', async (req, res) => {
        const key = req.body.admin_key || req.headers['x-admin-key'] || '';
        if (!isOperationKey(key)) return res.status(403).json({ error: '인증 필요' });
        const { event_id, selections } = req.body;
        if (!event_id || !selections) return res.status(400).json({ error: 'Missing fields' });
        await db.transaction(async () => {
            for (const s of selections) {
                await db.run(`INSERT INTO qualification_selection (event_id,event_entry_id,selected,qualification_type) VALUES (?,?,?,?)
                    ON CONFLICT(event_id,event_entry_id) DO UPDATE SET selected=excluded.selected, qualification_type=excluded.qualification_type, updated_at=${db.isAsync ? 'NOW()' : "datetime('now')"}`,
                    event_id, s.event_entry_id, s.selected ? 1 : 0, s.qualification_type || '');
            }
        })();
        res.json({ success: true });
    });

    app.post('/api/qualifications/approve', async (req, res) => {
        const key = req.body.admin_key || req.headers['x-admin-key'] || '';
        if (!isOperationKey(key)) return res.status(403).json({ error: '인증 필요' });
        const { event_id } = req.body;
        if (!event_id) return res.status(400).json({ error: 'event_id required' });
        const _nowFQ = db.isAsync ? 'NOW()' : "datetime('now')";
        await db.run(`UPDATE qualification_selection SET approved=1,approved_by='admin',updated_at=${_nowFQ} WHERE event_id=? AND selected=1`, event_id);
        res.json({ success: true });
    });
};
