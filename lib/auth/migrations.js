/**
 * Auth System Migrations (Phase 1)
 *
 * 멱등성 보장: 여러 번 호출되어도 안전.
 * SQLite + PostgreSQL 양쪽 지원.
 *
 * 사용법:
 *   const { runAuthMigrations } = require('./lib/auth/migrations');
 *   await runAuthMigrations(db);
 *
 * ⚠️ 기존 동작에 0 영향:
 *  - 새 테이블만 추가 (app_user, session_refresh, login_audit)
 *  - 기존 system_config/operation_key 등은 그대로 둠
 *  - 시드: 기존 admin_pw 해시를 그대로 가져와 app_user('admin') 1개 생성
 */
const bcrypt = require('bcryptjs');

async function runAuthMigrations(db) {
    const isPg = !!db.isAsync;
    const nowFn = isPg ? 'NOW()' : "datetime('now')";
    const pk = isPg ? 'BIGSERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
    const intDef = (def) => isPg ? `INTEGER NOT NULL DEFAULT ${def}` : `INTEGER NOT NULL DEFAULT ${def}`;
    const txt = 'TEXT';

    // 1) app_user — 계정
    try {
        await db.exec(`CREATE TABLE IF NOT EXISTS app_user (
            id               ${pk},
            organization_id  INTEGER,
            username         ${txt} NOT NULL UNIQUE,
            password_hash    ${txt} NOT NULL,
            display_name     ${txt},
            email            ${txt},
            role             ${txt} NOT NULL DEFAULT 'viewer',
            active           ${intDef(1)},
            failed_attempts  ${intDef(0)},
            locked_until     ${txt},
            last_login_at    ${txt},
            last_login_ip    ${txt},
            created_at       ${txt} NOT NULL DEFAULT (${nowFn}),
            updated_at       ${txt} NOT NULL DEFAULT (${nowFn})
        )`);
    } catch (e) {
        console.warn('[auth-mig] app_user create skipped:', e.message);
    }

    // 2) session_refresh — Refresh Token 저장 (revoke 가능)
    try {
        await db.exec(`CREATE TABLE IF NOT EXISTS session_refresh (
            id          ${pk},
            user_id     INTEGER NOT NULL,
            token_hash  ${txt} NOT NULL,
            user_agent  ${txt},
            ip          ${txt},
            expires_at  ${txt} NOT NULL,
            revoked_at  ${txt},
            created_at  ${txt} NOT NULL DEFAULT (${nowFn})
        )`);
    } catch (e) {
        console.warn('[auth-mig] session_refresh create skipped:', e.message);
    }

    // 3) login_audit — 로그인 감사
    try {
        await db.exec(`CREATE TABLE IF NOT EXISTS login_audit (
            id              ${pk},
            user_id         INTEGER,
            username        ${txt},
            success         INTEGER NOT NULL,
            failure_reason  ${txt},
            ip              ${txt},
            user_agent      ${txt},
            created_at      ${txt} NOT NULL DEFAULT (${nowFn})
        )`);
    } catch (e) {
        console.warn('[auth-mig] login_audit create skipped:', e.message);
    }

    // 인덱스 — 성능
    try { await db.exec(`CREATE INDEX IF NOT EXISTS ix_session_refresh_user ON session_refresh(user_id)`); } catch(e) {}
    try { await db.exec(`CREATE INDEX IF NOT EXISTS ix_session_refresh_hash ON session_refresh(token_hash)`); } catch(e) {}
    try { await db.exec(`CREATE INDEX IF NOT EXISTS ix_login_audit_user ON login_audit(user_id)`); } catch(e) {}
    try { await db.exec(`CREATE INDEX IF NOT EXISTS ix_login_audit_created ON login_audit(created_at)`); } catch(e) {}

    // 4) Seed: admin 계정이 없으면 system_config('admin_pw') 해시를 그대로 가져와 생성
    try {
        const existing = await db.get(`SELECT id FROM app_user WHERE username='admin'`);
        if (!existing) {
            // 기존 admin_pw 해시 가져오기
            const cfg = await db.get(`SELECT value FROM system_config WHERE key='admin_pw'`);
            let hash;
            if (cfg && cfg.value && cfg.value.startsWith('$2')) {
                // 이미 bcrypt 해시 → 그대로 사용 (사용자 비번 변경 없이 호환)
                hash = cfg.value;
            } else {
                // 폴백: 환경변수 또는 'changeme'
                const plain = process.env.ADMIN_PW || 'changeme';
                hash = bcrypt.hashSync(plain, 10);
            }
            await db.run(
                `INSERT INTO app_user (username, password_hash, display_name, role, active) VALUES (?,?,?,?,?)`,
                'admin', hash, '관리자', 'admin', 1
            );
            console.log('[auth-mig] seeded app_user("admin")');
        }
    } catch (e) {
        console.warn('[auth-mig] admin seed skipped:', e.message);
    }

    return { ok: true };
}

module.exports = { runAuthMigrations };
