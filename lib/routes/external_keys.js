'use strict';
/**
 * 외부 API 키 관리(발급·목록·폐기·호출 로그) — server.js 에서 이동 (2026-09-22, Phase 4 분해). 동작은 인라인 시절과 같다.
 *   deps: _generateApiKey, _hashApiKey, _keyPrefix, db, isAdminKey
 */
module.exports = function mountExternalKeysRoutes(app, deps) {
    const { _generateApiKey, _hashApiKey, _keyPrefix, db, isAdminKey } = deps;
    for (const k of ["_generateApiKey","_hashApiKey","_keyPrefix","db","isAdminKey"]) if (deps[k] === undefined) throw new Error('[external_keys.js] mount requires deps.' + k);

    // ── 외부 API 키 관리(관리자 전용) ──
    //   POST   /api/admin/external-keys           발급
    //   GET    /api/admin/external-keys           목록
    //   POST   /api/admin/external-keys/:id/revoke 회수
    //   GET    /api/admin/external-keys/logs      로그 조회
    app.post('/api/admin/external-keys', async (req, res) => {
        const { admin_key, label, allowed_competition_id, rate_limit_per_min, expires_at } = req.body || {};
        if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 권한 필요' });

        const lbl = (label || '').toString().trim().slice(0, 200);
        if (!lbl) return res.status(400).json({ error: 'label은 필수입니다.' });

        let allowedComp = null;
        if (allowed_competition_id) {
            const cid = parseInt(allowed_competition_id);
            if (!Number.isFinite(cid) || cid <= 0) return res.status(400).json({ error: 'allowed_competition_id가 올바르지 않습니다.' });
            const c = await db.get('SELECT id, mode FROM competition WHERE id=?', cid);
            if (!c) return res.status(400).json({ error: '해당 대회가 존재하지 않습니다.' });
            allowedComp = cid;
        }

        let rate = parseInt(rate_limit_per_min);
        if (!Number.isFinite(rate) || rate <= 0) rate = 60;
        if (rate > 600) rate = 600;

        let expiresAt = null;
        if (expires_at) {
            const s = String(expires_at).trim();
            if (s) {
                // 간단 검증(YYYY-MM-DD 또는 YYYY-MM-DD HH:MM:SS)
                if (!/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/.test(s)) {
                    return res.status(400).json({ error: 'expires_at 형식 오류 (YYYY-MM-DD 또는 YYYY-MM-DD HH:MM:SS).' });
                }
                expiresAt = s.length === 10 ? (s + ' 23:59:59') : s;
            }
        }

        const plain = _generateApiKey();
        const hash = _hashApiKey(plain);
        const prefix = _keyPrefix(plain);

        const info = await db.run(`
            INSERT INTO external_api_key (key_hash, key_prefix, label, allowed_competition_id, rate_limit_per_min, expires_at, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, hash, prefix, lbl, allowedComp, rate, expiresAt, 'admin');

        return res.json({
            ok: true,
            message: 'API 키가 발급되었습니다. 이 키는 다시 표시되지 않으니 안전한 곳에 보관하세요.',
            id: info.lastInsertRowid,
            api_key: plain,             // ← 발급 시 1회만 반환
            key_prefix: prefix,
            label: lbl,
            allowed_competition_id: allowedComp,
            rate_limit_per_min: rate,
            expires_at: expiresAt
        });
    });

    app.get('/api/admin/external-keys', async (req, res) => {
        const adminKey = req.query.admin_key || req.headers['x-admin-key'];
        if (!isAdminKey(adminKey)) return res.status(403).json({ error: '관리자 권한 필요' });

        const rows = await db.all(`
            SELECT k.id, k.key_prefix, k.label, k.allowed_competition_id, k.rate_limit_per_min,
                   k.expires_at, k.revoked_at, k.last_used_at, k.total_calls, k.created_at,
                   c.name AS competition_name
            FROM external_api_key k
            LEFT JOIN competition c ON c.id = k.allowed_competition_id
            ORDER BY k.id DESC
        `);

        return res.json({ ok: true, items: rows });
    });

    app.post('/api/admin/external-keys/:id/revoke', async (req, res) => {
        const { admin_key } = req.body || {};
        if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 권한 필요' });
        const id = parseInt(req.params.id);
        if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id 오류' });

        const _nowFEA = db.isAsync ? 'NOW()' : "datetime('now')";
        const r = await db.run(`UPDATE external_api_key SET revoked_at = ${_nowFEA} WHERE id = ? AND revoked_at IS NULL`, id);
        if (r.changes === 0) return res.status(404).json({ error: '해당 키 없음 또는 이미 회수됨' });
        return res.json({ ok: true, id, revoked_at: new Date().toISOString() });
    });

    app.get('/api/admin/external-keys/logs', async (req, res) => {
        const adminKey = req.query.admin_key || req.headers['x-admin-key'];
        if (!isAdminKey(adminKey)) return res.status(403).json({ error: '관리자 권한 필요' });

        let limit = parseInt(req.query.limit || '100', 10);
        if (!Number.isFinite(limit) || limit <= 0) limit = 100;
        if (limit > 500) limit = 500;
        const apiKeyId = req.query.api_key_id ? parseInt(req.query.api_key_id) : null;

        let sql = `
            SELECT l.id, l.api_key_id, l.key_prefix, l.endpoint, l.method,
                   l.request_ip, l.user_agent, l.competition_id, l.event_id,
                   l.response_status, l.response_code, l.duration_ms, l.created_at,
                   k.label AS key_label
            FROM external_api_log l
            LEFT JOIN external_api_key k ON k.id = l.api_key_id
        `;
        const params = [];
        if (apiKeyId) { sql += ' WHERE l.api_key_id = ?'; params.push(apiKeyId); }
        sql += ' ORDER BY l.id DESC LIMIT ?';
        params.push(limit);

        const rows = await db.all(sql, ...params);
        return res.json({ ok: true, count: rows.length, items: rows });
    });

    return {  };
};
