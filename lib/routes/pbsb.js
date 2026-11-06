'use strict';
/**
 * PB/SB 자동 누적 라우트 (C4, 2026-10-09) — lib/pbsb.js
 *   POST /api/events/:id/marks/update               이 종목 결과로 출전 PB/SB 갱신 (종목 완료 때 자동으로도 돈다)
 *   POST /api/competitions/:id/marks/carry-over     같은 조직의 지난 대회에서 선수·종목이 같은 PB/SB 를 빈 엔트리에 채움
 */
const PBSB = require('../pbsb');
module.exports = function mountPbsbRoutes(app, deps) {
    const { db, isOperationKey, opLog } = deps;
    if (!app || !db || !isOperationKey || !opLog) throw new Error('[pbsb.js] mount requires { db, isOperationKey, opLog }');
    const keyOf = req => (req.body && (req.body.admin_key || req.body.operation_key)) || req.headers['x-admin-key'] || (req.query && req.query.key) || '';

    app.post('/api/events/:id/marks/update', async (req, res) => {
        try {
            if (!isOperationKey(keyOf(req))) return res.status(403).json({ error: '인증 키가 필요합니다.' });
            const event = await db.get('SELECT * FROM event WHERE id=?', req.params.id);
            if (!event) return res.status(404).json({ error: '종목을 찾을 수 없습니다.' });
            const r = await PBSB.updateEntryMarks(db, event);
            res.json({ success: true, ...r });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
    app.post('/api/competitions/:id/marks/carry-over', async (req, res) => {
        try {
            if (!isOperationKey(keyOf(req))) return res.status(403).json({ error: '인증 키가 필요합니다.' });
            const comp = await db.get('SELECT * FROM competition WHERE id=?', req.params.id);
            if (!comp) return res.status(404).json({ error: '대회를 찾을 수 없습니다.' });
            const r = await PBSB.carryOverMarks(db, comp);
            opLog(`이전 대회 기록 불러오기: 엔트리 ${r.entries}건 (PB ${r.pb} · SB ${r.sb})`, 'admin', 'admin', comp.id);
            res.json({ success: true, ...r });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
};
