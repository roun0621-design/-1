#!/usr/bin/env node
/**
 * 관리자 비밀번호 재설정 스크립트 (CLI)
 *
 * 사용법:
 *   node scripts/reset-admin-password.js <username> <newPassword>
 *
 * 예시:
 *   node scripts/reset-admin-password.js ROUNKIM "MyNewP@ssw0rd!"
 *
 * 동작:
 *   - app_user 와 system_config('admin_pw') 양쪽 모두 bcrypt 해시로 업데이트
 *   - 기존 모든 refresh 세션 회수 (보안)
 *   - 운영 중인 서버에 영향 없음 (DB만 수정)
 */
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'db', 'competition.db');

function usage() {
    console.error('Usage: node scripts/reset-admin-password.js <username> <newPassword>');
    console.error('');
    console.error('Examples:');
    console.error('  node scripts/reset-admin-password.js ROUNKIM "MyNewP@ss"');
    console.error('  node scripts/reset-admin-password.js admin changeme');
    process.exit(1);
}

const [, , username, newPassword] = process.argv;
if (!username || !newPassword) usage();
if (newPassword.length < 6) {
    console.error('❌ 새 비밀번호는 6자 이상이어야 합니다.');
    process.exit(2);
}

const db = new Database(DB_PATH);
const hash = bcrypt.hashSync(newPassword, 10);

try {
    // 1) app_user 업데이트 (있으면)
    const user = db.prepare(`SELECT id, username, role FROM app_user WHERE username = ?`).get(username);
    if (user) {
        db.prepare(`UPDATE app_user SET password_hash=?, failed_attempts=0, locked_until=NULL, updated_at=? WHERE id=?`)
          .run(hash, new Date().toISOString(), user.id);
        console.log(`✅ app_user("${username}") 비밀번호 업데이트 (id=${user.id}, role=${user.role})`);

        // 모든 refresh 세션 회수
        try {
            const r = db.prepare(`UPDATE session_refresh SET revoked_at=datetime('now') WHERE user_id=? AND revoked_at IS NULL`).run(user.id);
            if (r.changes) console.log(`✅ ${r.changes}개 refresh 세션 회수`);
        } catch(_) {}
    } else {
        // 사용자가 없으면 새로 만든다 (admin role 로)
        const r = db.prepare(`INSERT INTO app_user (username, password_hash, display_name, role, active) VALUES (?,?,?,?,?)`)
                    .run(username, hash, username, 'admin', 1);
        console.log(`✅ app_user("${username}") 신규 생성 (id=${r.lastInsertRowid}, role=admin)`);
    }

    // 2) system_config('admin_pw') 도 같이 업데이트 (legacy 호환)
    //    단, username이 system_config('admin_id') 와 일치할 때만
    const adminIdCfg = db.prepare(`SELECT value FROM system_config WHERE key='admin_id'`).get();
    const adminId = adminIdCfg && adminIdCfg.value ? String(adminIdCfg.value).trim() : null;
    if (adminId && adminId === username) {
        const exists = db.prepare(`SELECT value FROM system_config WHERE key='admin_pw'`).get();
        if (exists) {
            db.prepare(`UPDATE system_config SET value=? WHERE key='admin_pw'`).run(hash);
        } else {
            db.prepare(`INSERT INTO system_config (key, value) VALUES ('admin_pw', ?)`).run(hash);
        }
        console.log(`✅ system_config('admin_pw') 도 동기화 (legacy ?key= 인증 호환)`);
    } else if (adminId) {
        console.log(`ℹ️  system_config('admin_id')='${adminId}' 와 다른 사용자이므로 system_config 는 건드리지 않음`);
    }

    console.log('');
    console.log('━'.repeat(60));
    console.log(`완료: "${username}" 으로 비밀번호 "${newPassword.replace(/./g, '*')}" 사용 가능`);
    console.log('━'.repeat(60));
} catch (e) {
    console.error('❌ 오류:', e.message);
    process.exit(3);
} finally {
    db.close();
}
