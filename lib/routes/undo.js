'use strict';
/**
 * 되돌리기 API (2026-09 Phase 6) — lib/undo.js 스냅샷을 목록·복원
 *   GET  /api/undo?competition_id=   24시간 안에 되돌릴 수 있는 작업 (운영키)
 *   POST /api/undo/:id/restore       되살리기 — 스냅샷을 만든 권한(admin 이면 관리자만), 종료된 대회는 관리자만
 */
const undo = require('../undo');

module.exports = function mountUndoRoutes(app, deps) {
    const { db, isAdminKey, isOperationKey, getJudgeName, isCompetitionEnded, broadcastSSE, opLog } = deps;
    const keyOf = req => String(req.headers['x-admin-key'] || (req.body && (req.body.admin_key || req.body.operation_key)) || req.query.key || '');

    app.get('/api/undo', async (req, res) => {
        try {
            if (!isOperationKey(keyOf(req))) return res.status(403).json({ error: '인증 키가 필요합니다.' });
            const compId = parseInt(req.query.competition_id, 10);
            if (!compId) return res.status(400).json({ error: 'competition_id 필수' });
            res.json(await undo.list(db, compId));
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/undo/:id/restore', async (req, res) => {
        try {
            const key = keyOf(req);
            if (!isOperationKey(key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
            const snap = await undo.get(db, req.params.id);
            if (!snap) return res.status(404).json({ error: '되돌릴 작업을 찾을 수 없습니다.' });
            if (snap.role === 'admin' && !isAdminKey(key)) return res.status(403).json({ error: '관리자가 지운 것은 관리자만 되돌릴 수 있습니다.' });
            if (snap.competition_id && await isCompetitionEnded(snap.competition_id) && !isAdminKey(key)) return res.status(403).json({ error: '종료된 대회는 관리자만 되돌릴 수 있습니다.' });
            const r = await undo.restore(db, snap.id);
            // 기록 초기화는 종목 상태(진행 중·완료)도 돌려놓는다
            if (r.kind === 'results_reset' && r.meta && r.meta.event_id && r.meta.round_status) {
                await db.run('UPDATE event SET round_status=? WHERE id=?', r.meta.round_status, r.meta.event_id);
            }
            // 화면 갱신: 종목이 있으면 그 종목, 없으면 대회 전체
            const evIds = new Set();
            if (r.meta && r.meta.event_id) evIds.add(Number(r.meta.event_id));
            for (const { table, rows } of r.data) if (table === 'event') rows.forEach(x => evIds.add(Number(x.id)));
            for (const id of evIds) { broadcastSSE('result_update', { event_id: id }); broadcastSSE('event_status_changed', { event_id: id }); }
            broadcastSSE('undo_restored', { competition_id: r.competition_id, kind: r.kind, event_ids: [...evIds] });
            const who = getJudgeName(key) || (isAdminKey(key) ? 'admin' : 'operation');
            opLog(`↩ 되돌리기: ${r.label} (${Object.entries(r.restored).map(([t, n]) => `${t} ${n}`).join(', ')})`, 'admin', who, r.competition_id);
            res.json({ success: true, restored: r.restored, kind: r.kind, label: r.label, event_ids: [...evIds] });
        } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
    });
};
