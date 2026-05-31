/**
 * JWT Helpers (Phase 1)
 *
 * Access Token: 1시간 — 일반 API 호출용
 * Refresh Token: 30일 — DB에 hash 저장, revoke 가능
 *
 * Secret: process.env.JWT_SECRET 또는 system_config 에 자동 생성/저장
 *
 * ⚠️ Phase 1 단계에서는 정의만 됨. 실제 사용은 Phase 2 (로그인 API).
 */
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const ACCESS_TTL  = '1h';
const REFRESH_TTL_SEC = 30 * 24 * 3600; // 30일

let _cachedSecret = null;

/**
 * JWT secret 가져오기/생성.
 * 우선순위: env.JWT_SECRET > system_config('jwt_secret') > 자동 생성 후 저장
 */
async function getOrCreateSecret(db) {
    if (_cachedSecret) return _cachedSecret;
    if (process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32) {
        _cachedSecret = process.env.JWT_SECRET;
        return _cachedSecret;
    }
    // DB 에서 조회
    try {
        const row = await db.get(`SELECT value FROM system_config WHERE key='jwt_secret'`);
        if (row && row.value && row.value.length >= 32) {
            _cachedSecret = row.value;
            return _cachedSecret;
        }
    } catch (e) {}
    // 자동 생성 (1회만)
    const newSecret = crypto.randomBytes(48).toString('base64'); // 64 chars
    try {
        await db.run(
            `INSERT INTO system_config (key, value) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
            'jwt_secret', newSecret
        );
    } catch (e) {
        // ON CONFLICT 미지원 백엔드 → 수동 upsert
        try { await db.run(`UPDATE system_config SET value=? WHERE key='jwt_secret'`, newSecret); } catch(_) {}
        try { await db.run(`INSERT INTO system_config (key, value) VALUES ('jwt_secret', ?)`, newSecret); } catch(_) {}
    }
    _cachedSecret = newSecret;
    console.log('[auth] jwt_secret 자동 생성 및 system_config 에 저장됨');
    return _cachedSecret;
}

/**
 * Access Token 발급 (1시간)
 * payload: { sub: user_id, username, role, organization_id }
 */
async function signAccess(db, payload) {
    const secret = await getOrCreateSecret(db);
    return jwt.sign(payload, secret, {
        expiresIn: ACCESS_TTL,
        issuer: 'pacerise',
        audience: 'pacerise-api'
    });
}

/**
 * Refresh Token 발급 (30일).
 * 반환: { token, tokenHash, expiresAt }  ─ tokenHash 를 DB에 저장.
 */
async function signRefresh(db, userId) {
    const raw = crypto.randomBytes(48).toString('base64url'); // opaque, not JWT
    const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
    const expiresAt = new Date(Date.now() + REFRESH_TTL_SEC * 1000).toISOString();
    return { token: raw, tokenHash, expiresAt };
}

/**
 * Access Token 검증.
 * 실패 시 null 반환 (에러 던지지 않음 — 호출자가 처리하기 쉽게).
 */
async function verifyAccess(db, token) {
    if (!token) return null;
    try {
        const secret = await getOrCreateSecret(db);
        return jwt.verify(token, secret, {
            issuer: 'pacerise',
            audience: 'pacerise-api'
        });
    } catch (e) {
        return null;
    }
}

/**
 * Refresh Token 검증: hash 일치 + 만료 안 됨 + 회수 안 됨.
 * 반환: user row OR null
 */
async function verifyRefresh(db, rawToken) {
    if (!rawToken) return null;
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const row = await db.get(
        `SELECT sr.*, u.id AS uid, u.username, u.role, u.organization_id, u.active
         FROM session_refresh sr
         JOIN app_user u ON u.id = sr.user_id
         WHERE sr.token_hash = ?`,
        tokenHash
    );
    if (!row) return null;
    if (row.revoked_at) return null;
    if (row.expires_at && row.expires_at < new Date().toISOString()) return null;
    if (!row.active) return null;
    return {
        userId: row.uid,
        username: row.username,
        role: row.role,
        organization_id: row.organization_id,
        sessionId: row.id
    };
}

/**
 * Refresh Token 회수 (로그아웃 시)
 */
async function revokeRefresh(db, rawToken) {
    if (!rawToken) return false;
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const nowFn = db.isAsync ? 'NOW()' : "datetime('now')";
    const r = await db.run(
        `UPDATE session_refresh SET revoked_at=${nowFn} WHERE token_hash=? AND revoked_at IS NULL`,
        tokenHash
    );
    return !!r;
}

/**
 * 한 사용자의 모든 refresh 세션 회수 (관리자가 강제 로그아웃 시키거나, 비번 변경 시)
 */
async function revokeAllForUser(db, userId) {
    const nowFn = db.isAsync ? 'NOW()' : "datetime('now')";
    return db.run(
        `UPDATE session_refresh SET revoked_at=${nowFn} WHERE user_id=? AND revoked_at IS NULL`,
        userId
    );
}

module.exports = {
    ACCESS_TTL,
    REFRESH_TTL_SEC,
    getOrCreateSecret,
    signAccess,
    signRefresh,
    verifyAccess,
    verifyRefresh,
    revokeRefresh,
    revokeAllForUser,
};
