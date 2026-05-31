/**
 * Auth Adapter Middleware (Phase 1)
 *
 * req.user 통일 객체를 만든다. JWT 우선, 없으면 레거시 키.
 *
 * 사용법 (Phase 2 이후 점진 적용):
 *   app.use(attachUser({ db, legacyResolvers }));
 *
 * legacyResolvers (server.js의 기존 헬퍼들을 그대로 받음):
 *   {
 *     isAdminKey:        (key) => bool,
 *     isOperationKey:    (key) => bool,
 *     isRecordOfficerKey:(key) => bool,
 *     isAdminOrManager:  (key) => bool,
 *     getJudgeName:      (key) => string,
 *     getKeyRole:        (key) => 'admin'|'operation'|'record_officer'|...,
 *   }
 *
 * ⚠️ Phase 1 에서는 server.js 에 미사용. 미들웨어 정의만.
 *    Phase 2 에서 로그인 API 와 함께 점진 적용.
 *
 * req.user 형태:
 *   {
 *     id:              <user_id> or null,    // 레거시 키 사용 시 null
 *     username:        'admin' / judge_name / null,
 *     role:            'admin'|'manager'|'record_officer'|'operator'|'viewer',
 *     organization_id: <id> or null,
 *     authSource:      'jwt' | 'legacy_key' | null,
 *     rawKey:          undefined or 레거시 키 (디버그용)
 *   }
 *   req.user 가 없으면 비로그인.
 */
const { verifyAccess } = require('./jwt');

/**
 * 요청에서 Access Token 추출:
 *   1. Authorization: Bearer <token>
 *   2. Cookie: access_token=<token>
 */
function extractAccessToken(req) {
    const auth = req.headers['authorization'] || '';
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m) return m[1].trim();
    if (req.cookies && req.cookies.access_token) return req.cookies.access_token;
    return null;
}

/**
 * 요청에서 레거시 키 추출 (?key=, body.admin_key, body.operation_key, x-admin-key)
 */
function extractLegacyKey(req) {
    return (req.query && (req.query.key || req.query.admin_key || req.query.operation_key))
        || (req.body && (req.body.admin_key || req.body.operation_key || req.body.key))
        || req.headers['x-admin-key']
        || req.headers['x-operation-key']
        || '';
}

/**
 * 미들웨어 팩토리: req.user 를 채운다 (실패해도 next() 호출 — 일부 API 는 비로그인 허용).
 *
 * 보호 라우트는 별도로 requireAuth() / requireRole() 를 추가로 붙임.
 */
function attachUser({ db, legacyResolvers }) {
    if (!db) throw new Error('attachUser requires db');
    return async function attachUserMw(req, res, next) {
        try {
            // 1) JWT 시도
            const token = extractAccessToken(req);
            if (token) {
                const payload = await verifyAccess(db, token);
                if (payload && payload.sub) {
                    req.user = {
                        id: payload.sub,
                        username: payload.username || null,
                        role: payload.role || 'viewer',
                        organization_id: payload.organization_id || null,
                        authSource: 'jwt'
                    };
                    return next();
                }
            }
            // 2) 레거시 키 fallback
            const lk = extractLegacyKey(req);
            if (lk && legacyResolvers) {
                const role = (legacyResolvers.getKeyRole && legacyResolvers.getKeyRole(lk)) || null;
                if (role) {
                    req.user = {
                        id: null,
                        username: legacyResolvers.getJudgeName ? legacyResolvers.getJudgeName(lk) : null,
                        role,
                        organization_id: null,
                        authSource: 'legacy_key'
                    };
                    return next();
                }
            }
            // 비로그인
            req.user = null;
            next();
        } catch (e) {
            console.error('[attachUser]', e);
            req.user = null;
            next();
        }
    };
}

/**
 * 보호용 미들웨어: 로그인 필수.
 */
function requireAuth(req, res, next) {
    if (!req.user) {
        return res.status(401).json({ error: 'authentication required' });
    }
    next();
}

/**
 * 역할 검사. 사용 예: requireRole('admin'), requireRole(['admin','manager'])
 */
function requireRole(roles) {
    const allowed = Array.isArray(roles) ? roles : [roles];
    return function roleMw(req, res, next) {
        if (!req.user) return res.status(401).json({ error: 'authentication required' });
        if (!allowed.includes(req.user.role)) {
            return res.status(403).json({ error: `role required: ${allowed.join(' or ')}` });
        }
        next();
    };
}

module.exports = {
    extractAccessToken,
    extractLegacyKey,
    attachUser,
    requireAuth,
    requireRole,
};
