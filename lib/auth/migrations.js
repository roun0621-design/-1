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
    // ⚠️ 호환성: PG는 DEFAULT 표현식에 괄호 사용 시 일부 환경에서 파싱 실패 가능.
    //   PG → CURRENT_TIMESTAMP (괄호 없이) / SQLite → (datetime('now')) (괄호 필수)
    const nowDef = isPg ? 'CURRENT_TIMESTAMP' : "(datetime('now'))";
    const pk = isPg ? 'BIGSERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
    const intDef = (def) => `INTEGER NOT NULL DEFAULT ${def}`;
    const txt = 'TEXT';

    // 1) app_user — 계정
    //   ※ 에러를 더 이상 삼키지 않음. 테이블 생성 실패는 fatal — 로그인 자체가 불가능해지므로.
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
        created_at       ${txt} NOT NULL DEFAULT ${nowDef},
        updated_at       ${txt} NOT NULL DEFAULT ${nowDef}
    )`);

    // 2) session_refresh — Refresh Token 저장 (revoke 가능)
    await db.exec(`CREATE TABLE IF NOT EXISTS session_refresh (
        id          ${pk},
        user_id     INTEGER NOT NULL,
        token_hash  ${txt} NOT NULL,
        user_agent  ${txt},
        ip          ${txt},
        expires_at  ${txt} NOT NULL,
        revoked_at  ${txt},
        created_at  ${txt} NOT NULL DEFAULT ${nowDef}
    )`);

    // 3) login_audit — 로그인 감사
    await db.exec(`CREATE TABLE IF NOT EXISTS login_audit (
        id              ${pk},
        user_id         INTEGER,
        username        ${txt},
        success         INTEGER NOT NULL,
        failure_reason  ${txt},
        ip              ${txt},
        user_agent      ${txt},
        created_at      ${txt} NOT NULL DEFAULT ${nowDef}
    )`);

    // 인덱스 — 성능
    try { await db.exec(`CREATE INDEX IF NOT EXISTS ix_session_refresh_user ON session_refresh(user_id)`); } catch(e) {}
    try { await db.exec(`CREATE INDEX IF NOT EXISTS ix_session_refresh_hash ON session_refresh(token_hash)`); } catch(e) {}
    try { await db.exec(`CREATE INDEX IF NOT EXISTS ix_login_audit_user ON login_audit(user_id)`); } catch(e) {}
    try { await db.exec(`CREATE INDEX IF NOT EXISTS ix_login_audit_created ON login_audit(created_at)`); } catch(e) {}

    // 4) Seed: legacy system_config('admin_id') + ('admin_pw') 를 app_user 에 동기화
    //   기존 system_config 의 admin_id 가 실제 관리자 사용자명이므로 그것을 username 으로 사용.
    //   admin_pw 의 bcrypt 해시를 그대로 가져와 password_hash 로 사용 → 사용자 비번 변경 없이 호환.
    try {
        // 기존 admin_id 값 읽기 (없으면 'admin' 폴백)
        const idCfg = await db.get(`SELECT value FROM system_config WHERE key='admin_id'`);
        const adminUsername = (idCfg && idCfg.value && String(idCfg.value).trim())
            ? String(idCfg.value).trim()
            : 'admin';

        // 기존 admin_pw bcrypt 해시
        const pwCfg = await db.get(`SELECT value FROM system_config WHERE key='admin_pw'`);
        let hash;
        if (pwCfg && pwCfg.value && pwCfg.value.startsWith('$2')) {
            hash = pwCfg.value;
        } else {
            const plain = process.env.ADMIN_PW || 'changeme';
            hash = bcrypt.hashSync(plain, 10);
        }

        // 이전 버그로 잘못 만들어졌을 수 있는 username='admin' row 가 있고,
        // 실제 admin_id 가 다른 값(ex: 'ROUNKIM')이면 잘못된 row 제거
        if (adminUsername !== 'admin') {
            const wrongRow = await db.get(`SELECT id FROM app_user WHERE username='admin'`);
            const correctRow = await db.get(`SELECT id FROM app_user WHERE username=?`, adminUsername);
            if (wrongRow && !correctRow) {
                // 잘못된 row 의 username 을 올바른 값으로 교정 (id 보존 — 차후 외래키 안전)
                await db.run(
                    `UPDATE app_user SET username=?, password_hash=?, role='admin', active=1, updated_at=? WHERE id=?`,
                    adminUsername, hash, new Date().toISOString(), wrongRow.id
                );
                console.log(`[auth-mig] corrected app_user.username 'admin' → '${adminUsername}' (id=${wrongRow.id})`);
            } else if (wrongRow && correctRow) {
                // 둘 다 있는 경우 — 잘못된 'admin' row 삭제
                await db.run(`DELETE FROM app_user WHERE id=?`, wrongRow.id);
                console.log(`[auth-mig] removed stale app_user('admin') id=${wrongRow.id} (correct row exists as '${adminUsername}')`);
            }
        }

        // 정상 username 으로 row 존재 확인 — 없으면 생성, 있으면 해시 동기화
        const existing = await db.get(`SELECT id, password_hash FROM app_user WHERE username=?`, adminUsername);
        if (!existing) {
            await db.run(
                `INSERT INTO app_user (username, password_hash, display_name, role, active) VALUES (?,?,?,?,?)`,
                adminUsername, hash, '관리자', 'admin', 1
            );
            console.log(`[auth-mig] seeded app_user("${adminUsername}")`);
        } else if (existing.password_hash !== hash) {
            // admin_pw 가 system_config 에서 바뀌었을 수 있음 → 자동 동기화
            await db.run(
                `UPDATE app_user SET password_hash=?, updated_at=? WHERE id=?`,
                hash, new Date().toISOString(), existing.id
            );
            console.log(`[auth-mig] re-synced password for app_user("${adminUsername}") from system_config.admin_pw`);
        }
    } catch (e) {
        console.warn('[auth-mig] admin seed skipped:', e.message);
    }

    return { ok: true };
}

module.exports = { runAuthMigrations };
