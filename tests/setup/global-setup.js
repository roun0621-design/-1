/**
 * Vitest globalSetup — 테스트 시작 전에 1회 실행
 *
 * 역할:
 *  - 운영 DB 와 완전히 분리된 임시 SQLite DB 경로를 환경변수에 주입
 *  - 테스트 종료 후 임시 DB 정리
 *
 * 왜 필요한가:
 *  - server.js / lib/db.js / db/init.js 가 SQLITE_PATH 환경변수를 읽도록 패치됨
 *  - 이렇게 격리해야 운영 데이터 (4 competitions, 688 athletes...) 가 절대 손상되지 않음
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

module.exports = async function () {
    // 1) 운영 격리: 매 테스트 실행마다 fresh 임시 디렉토리 사용
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pacerise-test-'));
    const testDbPath = path.join(tmpDir, 'test_competition.db');

    process.env.SQLITE_PATH = testDbPath;
    process.env.DB_BACKEND = 'sqlite';      // 명시적 강제 (postgres 환경 충돌 방지)
    process.env.NODE_ENV = 'test';
    process.env.PORT = '0';                  // supertest 가 ephemeral 포트 사용

    // 2) 운영 키 충돌 방지 — 테스트 전용 키
    process.env.ADMIN_ID = process.env.ADMIN_ID || 'admin';
    process.env.ADMIN_PW = process.env.ADMIN_PW || 'testadmin1234';
    process.env.OPERATION_KEY = process.env.OPERATION_KEY || 'testopkey';

    // 디버깅용 로그 (테스트 출력에 1회만 보임)
    console.log(`[test] SQLITE_PATH = ${testDbPath}`);

    // 종료 시 정리
    return async () => {
        try {
            // tmpDir 전체 삭제
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch (e) {
            // 실패해도 무시 (OS 가 /tmp 청소함)
        }
    };
};
