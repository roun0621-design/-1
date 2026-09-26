'use strict';
/**
 * 관리자 키·운영키·사이트 설정(키 변경/조회, 운영키 발급·재발급·삭제·수정, 등록 심판, site-config) — server.js 에서 이동 (2026-09-22, Phase 4 분해). 동작은 인라인 시절과 같다.
 *   deps: ACCESS_KEYS, ADMIN_ID, OPKEY_BCRYPT_COST, _opKeyHint, _opKeyIsHash, _opKeyLookup, _opKeyPrefix, _refreshDbSecurityWarnings, _reloadOpKeyCacheAsync, bcrypt, crypto, db, getConfigKey, getJudgeName, isAdminKey, isDefaultOperationKey, isOperationKey, opLog, setConfigKey, setDefaultOperationKey
 */
module.exports = function mountAdminKeysRoutes(app, deps) {
    const { ACCESS_KEYS, ADMIN_ID, OPKEY_BCRYPT_COST, _opKeyHint, _opKeyIsHash, _opKeyLookup, _opKeyPrefix, _refreshDbSecurityWarnings, _reloadOpKeyCacheAsync, bcrypt, crypto, db, getConfigKey, getJudgeName, isAdminKey, isDefaultOperationKey, isOperationKey, opLog, setConfigKey, setDefaultOperationKey } = deps;
    for (const k of ["ACCESS_KEYS","ADMIN_ID","OPKEY_BCRYPT_COST","_opKeyHint","_opKeyIsHash","_opKeyLookup","_opKeyPrefix","_refreshDbSecurityWarnings","_reloadOpKeyCacheAsync","bcrypt","crypto","db","getConfigKey","getJudgeName","isAdminKey","isDefaultOperationKey","isOperationKey","opLog","setConfigKey","setDefaultOperationKey"]) if (deps[k] === undefined) throw new Error('[admin_keys.js] mount requires deps.' + k);

    // ============================================================
    // ADMIN: KEY MANAGEMENT (supports multi-key with judge names)
    // ============================================================
    app.post('/api/admin/change-keys', (req, res) => {
        const { admin_key, new_operation_key, new_admin_key, new_admin_id, new_record_officer_key } = req.body;
        if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        // (2026-09) 짧은 값은 조용히 무시하던 것을 명시적 오류로. 최소 길이: 관리자 8 · 운영/기록위원 6, 흔한 값 금지
        const { _WEAK } = require('../securityCheck');
        const weak = v => _WEAK.has(String(v).toLowerCase());
        if (new_admin_key && (String(new_admin_key).length < 8 || weak(new_admin_key))) return res.status(400).json({ error: '관리자 키는 8자 이상이고 흔한 값(1234, admin 등)이 아니어야 합니다.' });
        if (new_operation_key && (String(new_operation_key).length < 6 || weak(new_operation_key))) return res.status(400).json({ error: '운영키는 6자 이상이고 흔한 값(1234 등)이 아니어야 합니다.' });
        if (typeof new_record_officer_key === 'string' && new_record_officer_key.trim() !== '' && (new_record_officer_key.trim().length < 6 || weak(new_record_officer_key.trim()))) return res.status(400).json({ error: '기록위원 키는 6자 이상이고 흔한 값이 아니어야 합니다.' });
        const changed = [];
        if (new_operation_key) { setDefaultOperationKey(new_operation_key); changed.push('운영키'); }
        if (new_admin_key) { ACCESS_KEYS.admin = new_admin_key; changed.push('관리자 키'); }  // setter hashes automatically
        if (new_admin_id && new_admin_id.trim()) { setConfigKey('admin_id', new_admin_id.trim()); changed.push('관리자 ID'); }
        // Phase C 확장: 기록위원 키. 빈 문자열 명시 시 비활성
        if (typeof new_record_officer_key === 'string') { ACCESS_KEYS.recordOfficer = new_record_officer_key.trim(); changed.push(new_record_officer_key.trim() ? '기록위원 키' : '기록위원 키 비활성'); }
        if (changed.length) { try { opLog(`접근 키 변경: ${changed.join(', ')}`, 'security', getJudgeName(admin_key), null); } catch (e) {} _refreshDbSecurityWarnings(); }
        res.json({
            success: true,
            operation_key: new_operation_key || null,          // 새로 정한 키는 이번 응답에서 한 번만 보여준다
            operation_key_hint: getConfigKey('operation_key_hint', ''),
            admin_id: ADMIN_ID(),
            record_officer_key: ACCESS_KEYS.recordOfficer,
            record_officer_active: !!ACCESS_KEYS.recordOfficer,
        });
    });
    app.get('/api/admin/current-keys', (req, res) => {
        if (!isAdminKey(req.query.key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        res.json({
            operation: _opKeyIsHash(ACCESS_KEYS.operation) ? null : ACCESS_KEYS.operation,     // 해시 저장 뒤에는 평문을 보여줄 수 없다
            operation_hint: getConfigKey('operation_key_hint', _opKeyIsHash(ACCESS_KEYS.operation) ? '' : _opKeyHint(ACCESS_KEYS.operation)),
            admin_id: ADMIN_ID(),
            record_officer_key: ACCESS_KEYS.recordOfficer,
            record_officer_active: !!ACCESS_KEYS.recordOfficer,
        });
    });
    // Public endpoint: get registered judge/operator names (for callroom completion dropdown)
    app.get('/api/registered-judges', async (req, res) => {
        const judges = await db.all('SELECT judge_name FROM operation_key WHERE active=1 ORDER BY judge_name');
        res.json(judges.map(j => j.judge_name));
    });

    // Multi-key CRUD
    app.get('/api/admin/operation-keys', async (req, res) => {
        if (!isAdminKey(req.query.key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        res.json((await db.all('SELECT id, judge_name, key_value, key_hint, role, can_manage, active, created_at FROM operation_key ORDER BY created_at DESC')).map(r => ({ ...r, key_value: undefined, key_hint: r.key_hint || (_opKeyIsHash(r.key_value) ? '••••' : _opKeyHint(r.key_value)) })));
    });
    app.post('/api/admin/operation-keys', async (req, res) => {
        const { admin_key, judge_name, key_value, can_manage } = req.body;
        if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        if (!judge_name || !key_value || key_value.length < 4) return res.status(400).json({ error: '심판명과 키(4자 이상)를 입력하세요.' });
        try {
            if (_opKeyLookup(String(key_value)) || isDefaultOperationKey(String(key_value))) return res.status(400).json({ error: '이미 쓰이는 키입니다. 다른 키를 정하세요.' });
            const info = await db.run('INSERT INTO operation_key (judge_name, key_value, key_prefix, key_hint, can_manage) VALUES (?, ?, ?, ?, ?)', judge_name, bcrypt.hashSync(String(key_value), OPKEY_BCRYPT_COST), _opKeyPrefix(key_value), _opKeyHint(key_value), can_manage ? 1 : 0);
            await _reloadOpKeyCacheAsync();
            opLog(`운영키 생성: ${judge_name}${can_manage ? ' (관리권한)' : ''}`, 'admin', 'admin');
            const row = await db.get('SELECT id, judge_name, key_hint, role, can_manage, active, created_at FROM operation_key WHERE id=?', info.lastInsertRowid);
            res.json({ ...row, key_value: String(key_value), show_once: true });      // 평문은 이번 응답에서만
        } catch (e) { res.status(400).json({ error: '키 생성에 실패했습니다: ' + e.message }); }
    });
    // 재발급 — 심판이 키를 잊었을 때. 새 키를 만들어 한 번 보여주고 옛 키는 즉시 무효
    app.post('/api/admin/operation-keys/:id/reissue', async (req, res) => {
        const { admin_key } = req.body;
        if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        const key = await db.get('SELECT * FROM operation_key WHERE id=?', req.params.id);
        if (!key) return res.status(404).json({ error: 'Not found' });
        const plain = crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, 'x').slice(0, 8).toLowerCase();
        await db.run('UPDATE operation_key SET key_value=?, key_prefix=?, key_hint=?, active=1 WHERE id=?', bcrypt.hashSync(plain, OPKEY_BCRYPT_COST), _opKeyPrefix(plain), _opKeyHint(plain), key.id);
        await _reloadOpKeyCacheAsync();
        opLog(`운영키 재발급: ${key.judge_name}`, 'admin', 'admin');
        res.json({ success: true, id: key.id, judge_name: key.judge_name, key_value: plain, key_hint: _opKeyHint(plain), show_once: true });
    });
    app.delete('/api/admin/operation-keys/:id', async (req, res) => {
        const { admin_key } = req.body;
        if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        const key = await db.get('SELECT * FROM operation_key WHERE id=?', req.params.id);
        if (!key) return res.status(404).json({ error: 'Not found' });
        await db.run('DELETE FROM operation_key WHERE id=?', req.params.id);
        await _reloadOpKeyCacheAsync();
        opLog(`운영키 삭제: ${key.judge_name}`, 'admin', 'admin');
        res.json({ success: true });
    });

    // ============================================================
    // SITE CONFIG (editable install guide, manual, about texts & links)
    // ============================================================
    app.get('/api/site-config', async (req, res) => {
        // Public: returns all site_* config keys
        const rows = await db.all("SELECT key, value FROM system_config WHERE key LIKE 'site_%'");
        const config = {};
        rows.forEach(r => { config[r.key] = r.value; });
        res.json(config);
    });
    app.post('/api/admin/site-config', async (req, res) => {
        const { admin_key, configs } = req.body;
        if (!isOperationKey(admin_key)) return res.status(403).json({ error: '운영키가 필요합니다.' });
        if (!configs || typeof configs !== 'object') return res.status(400).json({ error: 'configs object required' });
        await db.transaction(async () => {
            for (const [k, v] of Object.entries(configs)) {
                if (k.startsWith('site_')) await db.run('INSERT INTO system_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, String(v));
            }
        })();
        opLog('사이트 설정 업데이트', 'admin', 'admin');
        res.json({ success: true });
    });
    app.patch('/api/admin/operation-keys/:id', async (req, res) => {
        const { admin_key, active, can_manage } = req.body;
        if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        const key = await db.get('SELECT * FROM operation_key WHERE id=?', req.params.id);
        if (!key) return res.status(404).json({ error: 'Not found' });
        const newActive = active !== undefined ? (active ? 1 : 0) : key.active;
        const newCanManage = can_manage !== undefined ? (can_manage ? 1 : 0) : key.can_manage;
        await db.run('UPDATE operation_key SET active=?, can_manage=? WHERE id=?', newActive, newCanManage, req.params.id);
        await _reloadOpKeyCacheAsync();
        const updated = await db.get('SELECT * FROM operation_key WHERE id=?', req.params.id);
        if (can_manage !== undefined) {
            opLog(`${key.judge_name} 심판 권한 변경: ${newCanManage ? '관리자' : '운영'}`, 'admin', 'admin');
        }
        res.json(updated);
    });


    return {  };
};
