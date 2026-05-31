/**
 * Admin User Management Routes (B-5 / Phase 3)
 *
 * 관리자 전용 사용자 계정 CRUD + 세션 회수.
 * - JWT 인증 + role='admin' 필수
 * - 관리자만 계정 생성 가능 (셀프 회원가입 없음 — 사용자 정책에 부합)
 *
 * 외부 의존성:
 *   { db, bcrypt, jwtHelpers }
 *
 * 라우트 (6개):
 *   GET    /api/admin/users                 사용자 목록
 *   GET    /api/admin/users/:id             단일 사용자
 *   POST   /api/admin/users                 사용자 생성 { username, password, display_name?, email?, role }
 *   PUT    /api/admin/users/:id             사용자 수정 { display_name?, email?, role?, active?, password? }
 *   DELETE /api/admin/users/:id             사용자 비활성화 (soft delete — 실제 row 보존)
 *   POST   /api/admin/users/:id/revoke-sessions   해당 사용자의 refresh 세션 전부 회수
 *
 * 정책:
 *   - 자기 자신 role/active 변경 금지 (락아웃 방지)
 *   - 마지막 admin 비활성/role 변경 금지 (시스템 락아웃 방지)
 *   - username 변경 불가 (단순화)
 *   - 비밀번호는 PUT 시에만 hash → 변경 (선택사항)
 */
const ALLOWED_ROLES = ['admin', 'manager', 'record_officer', 'operator', 'viewer'];

/** Bearer 헤더 또는 쿠키에서 access token 추출 */
function getAccessToken(req) {
    const h = req.headers['authorization'];
    if (h && h.startsWith('Bearer ')) return h.slice(7);
    if (req.cookies && req.cookies.pr_access) return req.cookies.pr_access;
    if (req.cookies && req.cookies.access_token) return req.cookies.access_token;
    return null;
}

module.exports = function mountAdminUsersRoutes(app, deps) {
    const { db, bcrypt, jwtHelpers } = deps;
    if (!app || !db || !bcrypt || !jwtHelpers) {
        throw new Error('[admin_users.js] mount requires { db, bcrypt, jwtHelpers }');
    }

    /**
     * 관리자 가드: JWT 검증 + role='admin' 체크.
     * 실패 시 401/403 응답 후 false 반환. 통과 시 user 객체 반환.
     */
    async function requireAdmin(req, res) {
        const token = getAccessToken(req);
        const payload = await jwtHelpers.verifyAccess(db, token);
        if (!payload) {
            res.status(401).json({ error: '인증되지 않은 요청 (JWT 필요)' });
            return null;
        }
        try {
            const u = await db.get(
                `SELECT id, username, role, active FROM app_user WHERE id = ?`,
                payload.sub
            );
            if (!u || !u.active) {
                res.status(401).json({ error: '계정 비활성/삭제됨' });
                return null;
            }
            if (u.role !== 'admin') {
                res.status(403).json({ error: '관리자 권한이 필요합니다.' });
                return null;
            }
            return u;
        } catch (e) {
            console.error('[admin_users] requireAdmin err:', e);
            res.status(500).json({ error: '서버 오류' });
            return null;
        }
    }

    /** 현재 활성 admin 수 */
    async function countActiveAdmins() {
        const r = await db.get(
            `SELECT COUNT(*) AS c FROM app_user WHERE role='admin' AND active=1`
        );
        return r ? Number(r.c || 0) : 0;
    }

    // -----------------------------------------------------------
    // GET /api/admin/users — 목록
    // -----------------------------------------------------------
    app.get('/api/admin/users', async (req, res) => {
        const me = await requireAdmin(req, res);
        if (!me) return;
        try {
            const rows = await db.all(
                `SELECT id, username, display_name, email, role, organization_id,
                        active, failed_attempts, locked_until,
                        last_login_at, last_login_ip, created_at, updated_at
                 FROM app_user
                 ORDER BY id ASC`
            );
            return res.json({ ok: true, users: rows || [] });
        } catch (e) {
            console.error('[admin_users] list err:', e);
            return res.status(500).json({ error: '서버 오류' });
        }
    });

    // -----------------------------------------------------------
    // GET /api/admin/users/:id
    // -----------------------------------------------------------
    app.get('/api/admin/users/:id', async (req, res) => {
        const me = await requireAdmin(req, res);
        if (!me) return;
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
        try {
            const u = await db.get(
                `SELECT id, username, display_name, email, role, organization_id,
                        active, failed_attempts, locked_until,
                        last_login_at, last_login_ip, created_at, updated_at
                 FROM app_user WHERE id = ?`, id
            );
            if (!u) return res.status(404).json({ error: 'not found' });
            return res.json({ ok: true, user: u });
        } catch (e) {
            console.error('[admin_users] get err:', e);
            return res.status(500).json({ error: '서버 오류' });
        }
    });

    // -----------------------------------------------------------
    // POST /api/admin/users — 생성
    // -----------------------------------------------------------
    app.post('/api/admin/users', async (req, res) => {
        const me = await requireAdmin(req, res);
        if (!me) return;
        const { username, password, display_name, email, role } = req.body || {};
        if (!username || !password) {
            return res.status(400).json({ error: 'username, password 가 필요합니다.' });
        }
        const uname = String(username).trim();
        if (!/^[A-Za-z0-9_.\-]{3,32}$/.test(uname)) {
            return res.status(400).json({ error: 'username 은 3-32자, 영문/숫자/._- 만 허용됩니다.' });
        }
        if (String(password).length < 6) {
            return res.status(400).json({ error: '비밀번호는 6자 이상이어야 합니다.' });
        }
        const finalRole = (role && ALLOWED_ROLES.includes(role)) ? role : 'viewer';

        try {
            // username 중복 체크
            const dup = await db.get(`SELECT id FROM app_user WHERE username = ?`, uname);
            if (dup) return res.status(409).json({ error: '이미 존재하는 username 입니다.' });

            const hash = bcrypt.hashSync(String(password), 10);
            const dispName = (display_name && String(display_name).trim()) || uname;
            const em = (email && String(email).trim()) || null;

            await db.run(
                `INSERT INTO app_user (username, password_hash, display_name, email, role, active)
                 VALUES (?, ?, ?, ?, ?, 1)`,
                uname, hash, dispName, em, finalRole
            );
            const created = await db.get(
                `SELECT id, username, display_name, email, role, active, created_at
                 FROM app_user WHERE username = ?`, uname
            );
            return res.status(201).json({ ok: true, user: created });
        } catch (e) {
            console.error('[admin_users] create err:', e);
            return res.status(500).json({ error: '서버 오류' });
        }
    });

    // -----------------------------------------------------------
    // PUT /api/admin/users/:id — 수정
    // -----------------------------------------------------------
    app.put('/api/admin/users/:id', async (req, res) => {
        const me = await requireAdmin(req, res);
        if (!me) return;
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });

        const { display_name, email, role, active, password } = req.body || {};

        try {
            const target = await db.get(
                `SELECT id, username, role, active FROM app_user WHERE id = ?`, id
            );
            if (!target) return res.status(404).json({ error: 'not found' });

            // 자기 자신 role/active 변경 금지
            if (target.id === me.id) {
                if (role !== undefined && role !== target.role) {
                    return res.status(400).json({ error: '자기 자신의 role 은 변경할 수 없습니다.' });
                }
                if (active !== undefined && Number(active) !== Number(target.active)) {
                    return res.status(400).json({ error: '자기 자신을 비활성화할 수 없습니다.' });
                }
            }

            // 마지막 활성 admin 보호
            if (target.role === 'admin' && target.active) {
                const willLoseAdmin =
                    (role !== undefined && role !== 'admin') ||
                    (active !== undefined && Number(active) === 0);
                if (willLoseAdmin) {
                    const cnt = await countActiveAdmins();
                    if (cnt <= 1) {
                        return res.status(400).json({
                            error: '마지막 활성 관리자는 비활성/권한변경할 수 없습니다.'
                        });
                    }
                }
            }

            const updates = [];
            const params = [];
            if (display_name !== undefined) {
                updates.push('display_name=?');
                params.push(String(display_name).trim() || null);
            }
            if (email !== undefined) {
                updates.push('email=?');
                params.push((email && String(email).trim()) || null);
            }
            if (role !== undefined) {
                if (!ALLOWED_ROLES.includes(role)) {
                    return res.status(400).json({ error: '허용되지 않은 role' });
                }
                updates.push('role=?');
                params.push(role);
            }
            if (active !== undefined) {
                updates.push('active=?');
                params.push(Number(active) ? 1 : 0);
            }
            if (password !== undefined && password !== null && password !== '') {
                if (String(password).length < 6) {
                    return res.status(400).json({ error: '비밀번호는 6자 이상이어야 합니다.' });
                }
                updates.push('password_hash=?');
                params.push(bcrypt.hashSync(String(password), 10));
                // 비번 변경 시 failed_attempts/locked_until 도 리셋
                updates.push('failed_attempts=0');
                updates.push('locked_until=NULL');
            }

            if (updates.length === 0) {
                return res.status(400).json({ error: '변경할 항목이 없습니다.' });
            }

            updates.push('updated_at=?');
            params.push(new Date().toISOString());
            params.push(id);

            await db.run(
                `UPDATE app_user SET ${updates.join(', ')} WHERE id=?`,
                ...params
            );

            // 비번/role/active 변경 시 모든 refresh 세션 회수 (강제 재로그인)
            if (password !== undefined || role !== undefined || active !== undefined) {
                try { await jwtHelpers.revokeAllForUser(db, id); } catch(_) {}
            }

            const updated = await db.get(
                `SELECT id, username, display_name, email, role, active, updated_at
                 FROM app_user WHERE id = ?`, id
            );
            return res.json({ ok: true, user: updated });
        } catch (e) {
            console.error('[admin_users] update err:', e);
            return res.status(500).json({ error: '서버 오류' });
        }
    });

    // -----------------------------------------------------------
    // DELETE /api/admin/users/:id — soft delete (비활성화)
    // -----------------------------------------------------------
    app.delete('/api/admin/users/:id', async (req, res) => {
        const me = await requireAdmin(req, res);
        if (!me) return;
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });

        try {
            const target = await db.get(
                `SELECT id, username, role, active FROM app_user WHERE id = ?`, id
            );
            if (!target) return res.status(404).json({ error: 'not found' });
            if (target.id === me.id) {
                return res.status(400).json({ error: '자기 자신을 삭제할 수 없습니다.' });
            }
            // 마지막 활성 admin 보호
            if (target.role === 'admin' && target.active) {
                const cnt = await countActiveAdmins();
                if (cnt <= 1) {
                    return res.status(400).json({ error: '마지막 활성 관리자는 삭제할 수 없습니다.' });
                }
            }

            await db.run(
                `UPDATE app_user SET active=0, updated_at=? WHERE id=?`,
                new Date().toISOString(), id
            );
            try { await jwtHelpers.revokeAllForUser(db, id); } catch(_) {}
            return res.json({ ok: true, message: '계정이 비활성화되었습니다.' });
        } catch (e) {
            console.error('[admin_users] delete err:', e);
            return res.status(500).json({ error: '서버 오류' });
        }
    });

    // -----------------------------------------------------------
    // POST /api/admin/users/:id/revoke-sessions
    // -----------------------------------------------------------
    app.post('/api/admin/users/:id/revoke-sessions', async (req, res) => {
        const me = await requireAdmin(req, res);
        if (!me) return;
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
        try {
            const target = await db.get(`SELECT id FROM app_user WHERE id = ?`, id);
            if (!target) return res.status(404).json({ error: 'not found' });
            await jwtHelpers.revokeAllForUser(db, id);
            return res.json({ ok: true, message: '해당 사용자의 모든 세션이 회수되었습니다.' });
        } catch (e) {
            console.error('[admin_users] revoke err:', e);
            return res.status(500).json({ error: '서버 오류' });
        }
    });
};
