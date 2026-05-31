/**
 * Auth Routes (B-1차 / Phase 2 — 로그인 API)
 *
 * 신규 로그인 API. 기존 ?key= 인증과 별개로 동작하며,
 * 차후 Phase 3 에서 UI 가 이 API 를 사용하게 됨.
 *
 * 외부 의존성: db, authLimiter, bcrypt
 *
 * 라우트 (5개):
 *   POST   /api/auth/login            { username, password } → access(JWT) + refresh(opaque)
 *   POST   /api/auth/refresh          쿠키/body 의 refresh → 새 access (+ refresh rotate)
 *   POST   /api/auth/logout           refresh 회수, 쿠키 삭제
 *   GET    /api/auth/me               현재 JWT 사용자 정보
 *   POST   /api/auth/change-password  { current, next } 본인 비번 변경 (refresh 전부 회수)
 *
 * ⚠️ 기존 /api/auth/verify 는 server.js 에 그대로 둠 (legacy key 검증용 — 호환)
 */
const jwtHelpers = require('../auth/jwt');

const ACCESS_COOKIE  = 'pr_access';
const REFRESH_COOKIE = 'pr_refresh';

/** 쿠키 옵션 (운영 환경에서 secure) */
function cookieOpts(maxAgeMs) {
    return {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: maxAgeMs,
    };
}

/** 클라이언트 IP/UA 추출 (proxy 안전) */
function reqMeta(req) {
    const xf = req.headers['x-forwarded-for'];
    const ip = (xf ? String(xf).split(',')[0].trim() : req.ip) || null;
    const ua = req.headers['user-agent'] || null;
    return { ip, ua };
}

/** login_audit 기록 (실패해도 무시) */
async function audit(db, { userId, username, success, reason, ip, ua }) {
    try {
        await db.run(
            `INSERT INTO login_audit (user_id, username, success, failure_reason, ip, user_agent)
             VALUES (?, ?, ?, ?, ?, ?)`,
            userId || null, username || null, success ? 1 : 0, reason || null, ip, ua
        );
    } catch (e) { /* 무시 */ }
}

/** Bearer 헤더 또는 쿠키에서 access token 추출 */
function getAccessToken(req) {
    const h = req.headers['authorization'];
    if (h && h.startsWith('Bearer ')) return h.slice(7);
    if (req.cookies && req.cookies[ACCESS_COOKIE]) return req.cookies[ACCESS_COOKIE];
    return null;
}

/** body 또는 쿠키에서 refresh token 추출 */
function getRefreshToken(req) {
    if (req.body && req.body.refresh_token) return req.body.refresh_token;
    if (req.cookies && req.cookies[REFRESH_COOKIE]) return req.cookies[REFRESH_COOKIE];
    return null;
}

module.exports = function mountAuthRoutes(app, deps) {
    const { db, authLimiter, bcrypt } = deps;
    if (!app || !db || !authLimiter || !bcrypt) {
        throw new Error('[auth.js] mount requires { db, authLimiter, bcrypt }');
    }

    // -----------------------------------------------------------
    // POST /api/auth/login
    // -----------------------------------------------------------
    app.post('/api/auth/login', authLimiter, async (req, res) => {
        const { username, password } = req.body || {};
        const { ip, ua } = reqMeta(req);
        if (!username || !password) {
            await audit(db, { username, success: false, reason: 'missing_fields', ip, ua });
            return res.status(400).json({ error: '아이디와 비밀번호가 필요합니다.' });
        }
        try {
            const user = await db.get(
                `SELECT id, username, password_hash, display_name, role, organization_id,
                        active, failed_attempts, locked_until
                 FROM app_user WHERE username = ?`,
                String(username).trim()
            );
            if (!user) {
                await audit(db, { username, success: false, reason: 'not_found', ip, ua });
                return res.status(401).json({ error: '아이디 또는 비밀번호가 잘못되었습니다.' });
            }
            if (!user.active) {
                await audit(db, { userId: user.id, username, success: false, reason: 'inactive', ip, ua });
                return res.status(403).json({ error: '비활성화된 계정입니다.' });
            }
            // 잠금 체크
            if (user.locked_until && user.locked_until > new Date().toISOString()) {
                await audit(db, { userId: user.id, username, success: false, reason: 'locked', ip, ua });
                return res.status(429).json({ error: '계정이 일시 잠금되었습니다. 잠시 후 다시 시도하세요.' });
            }
            const ok = bcrypt.compareSync(password, user.password_hash || '');
            if (!ok) {
                const nf = (user.failed_attempts || 0) + 1;
                let lockedUntil = null;
                if (nf >= 5) {
                    // 10분 잠금
                    lockedUntil = new Date(Date.now() + 10 * 60 * 1000).toISOString();
                }
                try {
                    await db.run(
                        `UPDATE app_user SET failed_attempts=?, locked_until=? WHERE id=?`,
                        nf, lockedUntil, user.id
                    );
                } catch(_) {}
                await audit(db, { userId: user.id, username, success: false, reason: 'bad_password', ip, ua });
                return res.status(401).json({ error: '아이디 또는 비밀번호가 잘못되었습니다.' });
            }

            // 성공 — 카운터 리셋 + last_login
            try {
                await db.run(
                    `UPDATE app_user SET failed_attempts=0, locked_until=NULL,
                                          last_login_at=?, last_login_ip=? WHERE id=?`,
                    new Date().toISOString(), ip, user.id
                );
            } catch(_) {}

            // 토큰 발급
            const access = await jwtHelpers.signAccess(db, {
                sub: user.id,
                username: user.username,
                role: user.role,
                organization_id: user.organization_id || null,
            });
            const { token: refresh, tokenHash, expiresAt } = await jwtHelpers.signRefresh(db, user.id);
            await db.run(
                `INSERT INTO session_refresh (user_id, token_hash, user_agent, ip, expires_at)
                 VALUES (?, ?, ?, ?, ?)`,
                user.id, tokenHash, ua, ip, expiresAt
            );

            // HttpOnly 쿠키 (대안: Bearer 헤더로도 사용 가능)
            res.cookie(ACCESS_COOKIE, access, cookieOpts(60 * 60 * 1000)); // 1h
            res.cookie(REFRESH_COOKIE, refresh, cookieOpts(30 * 24 * 3600 * 1000)); // 30d

            await audit(db, { userId: user.id, username: user.username, success: true, ip, ua });

            return res.json({
                ok: true,
                user: {
                    id: user.id,
                    username: user.username,
                    display_name: user.display_name || user.username,
                    role: user.role,
                    organization_id: user.organization_id || null,
                },
                access_token: access,
                refresh_token: refresh,
                expires_in: 3600,
            });
        } catch (e) {
            console.error('[auth] /login error:', e);
            return res.status(500).json({ error: '서버 오류' });
        }
    });

    // -----------------------------------------------------------
    // POST /api/auth/refresh — 토큰 갱신 (rotation)
    // -----------------------------------------------------------
    app.post('/api/auth/refresh', authLimiter, async (req, res) => {
        const raw = getRefreshToken(req);
        if (!raw) return res.status(401).json({ error: 'refresh token 누락' });
        try {
            const session = await jwtHelpers.verifyRefresh(db, raw);
            if (!session) {
                res.clearCookie(ACCESS_COOKIE, { path: '/' });
                res.clearCookie(REFRESH_COOKIE, { path: '/' });
                return res.status(401).json({ error: '유효하지 않거나 만료된 refresh token' });
            }
            // Rotation: 기존 refresh 회수 + 신규 발급
            await jwtHelpers.revokeRefresh(db, raw);
            const { ip, ua } = reqMeta(req);

            const access = await jwtHelpers.signAccess(db, {
                sub: session.userId,
                username: session.username,
                role: session.role,
                organization_id: session.organization_id || null,
            });
            const { token: newRefresh, tokenHash, expiresAt } = await jwtHelpers.signRefresh(db, session.userId);
            await db.run(
                `INSERT INTO session_refresh (user_id, token_hash, user_agent, ip, expires_at)
                 VALUES (?, ?, ?, ?, ?)`,
                session.userId, tokenHash, ua, ip, expiresAt
            );

            res.cookie(ACCESS_COOKIE, access, cookieOpts(60 * 60 * 1000));
            res.cookie(REFRESH_COOKIE, newRefresh, cookieOpts(30 * 24 * 3600 * 1000));

            return res.json({
                ok: true,
                access_token: access,
                refresh_token: newRefresh,
                expires_in: 3600,
            });
        } catch (e) {
            console.error('[auth] /refresh error:', e);
            return res.status(500).json({ error: '서버 오류' });
        }
    });

    // -----------------------------------------------------------
    // POST /api/auth/logout
    // -----------------------------------------------------------
    app.post('/api/auth/logout', async (req, res) => {
        try {
            const raw = getRefreshToken(req);
            if (raw) {
                try { await jwtHelpers.revokeRefresh(db, raw); } catch(_) {}
            }
        } catch(_) {}
        res.clearCookie(ACCESS_COOKIE, { path: '/' });
        res.clearCookie(REFRESH_COOKIE, { path: '/' });
        return res.json({ ok: true });
    });

    // -----------------------------------------------------------
    // GET /api/auth/me — 현재 사용자 (JWT 필요)
    // -----------------------------------------------------------
    app.get('/api/auth/me', async (req, res) => {
        const token = getAccessToken(req);
        const payload = await jwtHelpers.verifyAccess(db, token);
        if (!payload) return res.status(401).json({ error: '인증되지 않은 요청' });
        try {
            const u = await db.get(
                `SELECT id, username, display_name, email, role, organization_id, active,
                        last_login_at, last_login_ip, created_at
                 FROM app_user WHERE id = ?`,
                payload.sub
            );
            if (!u || !u.active) return res.status(401).json({ error: '계정 비활성/삭제됨' });
            return res.json({ ok: true, user: u });
        } catch (e) {
            console.error('[auth] /me error:', e);
            return res.status(500).json({ error: '서버 오류' });
        }
    });

    // -----------------------------------------------------------
    // POST /api/auth/change-password — 본인 비번 변경
    // -----------------------------------------------------------
    app.post('/api/auth/change-password', authLimiter, async (req, res) => {
        const token = getAccessToken(req);
        const payload = await jwtHelpers.verifyAccess(db, token);
        if (!payload) return res.status(401).json({ error: '인증되지 않은 요청' });
        const { current, next } = req.body || {};
        if (!current || !next) return res.status(400).json({ error: 'current/next 필요' });
        if (String(next).length < 6) return res.status(400).json({ error: '새 비밀번호는 6자 이상이어야 합니다.' });
        try {
            const u = await db.get(`SELECT id, password_hash FROM app_user WHERE id=? AND active=1`, payload.sub);
            if (!u) return res.status(401).json({ error: '계정 없음' });
            if (!bcrypt.compareSync(current, u.password_hash || '')) {
                return res.status(401).json({ error: '현재 비밀번호가 일치하지 않습니다.' });
            }
            const newHash = bcrypt.hashSync(String(next), 10);
            await db.run(
                `UPDATE app_user SET password_hash=?, updated_at=? WHERE id=?`,
                newHash, new Date().toISOString(), u.id
            );
            // 모든 refresh 세션 회수 (보안)
            await jwtHelpers.revokeAllForUser(db, u.id);
            res.clearCookie(ACCESS_COOKIE, { path: '/' });
            res.clearCookie(REFRESH_COOKIE, { path: '/' });
            return res.json({ ok: true, message: '비밀번호가 변경되었습니다. 다시 로그인해 주세요.' });
        } catch (e) {
            console.error('[auth] /change-password error:', e);
            return res.status(500).json({ error: '서버 오류' });
        }
    });
};
