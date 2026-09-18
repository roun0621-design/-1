/**
 * Vitest setupFiles — 각 테스트 파일 시작 시 실행
 *
 * 역할:
 *  - 테스트 파일마다 **자기만의 임시 DB** 를 쓰게 한다 (2026-09 Phase 4, 이슈 #3)
 *      전에는 전체 실행이 임시 DB 하나를 공유해 실행 순서(vitest 는 소요시간순)에 따라 한 파일이 넣은 전역 데이터(NR/DR 기록 등)가
 *      다른 파일을 깨뜨릴 수 있었다. vitest 는 파일마다 모듈을 새로 불러오므로 여기서 경로만 바꾸면 server.js 가 새 DB 를 만든다.
 *  - 로그 노이즈 감소 (server.js 부팅 로그가 너무 많음)
 */
{
    const fs = require('fs'), path = require('path'), os = require('os');
    const base = process.env.SQLITE_PATH ? path.dirname(process.env.SQLITE_PATH) : os.tmpdir();   // global-setup 이 만든 임시 폴더 안
    const file = (process.env.VITEST_TEST_FILE || (typeof expect !== 'undefined' && expect.getState && expect.getState().testPath) || '').split('/').pop() || 'file';
    const dir = fs.mkdtempSync(path.join(base, file.replace(/[^A-Za-z0-9_.-]/g, '_') + '-'));
    process.env.SQLITE_PATH = path.join(dir, 'test_competition.db');
    process.env.DB_BACKEND = 'sqlite';
}

// server.js 가 console.log 로 시작 배너를 출력하는데, 테스트에서는 시끄러우니 잠시 무음 처리
// 단, 실패 시 디버깅이 필요하므로 TEST_VERBOSE=1 로 켤 수 있게 함
if (!process.env.TEST_VERBOSE) {
    const origLog = console.log;
    const origInfo = console.info;
    console.log = (...args) => {
        const first = args[0];
        // [DB], [PG cache], Pace Rise... 같은 배너만 음소거
        if (typeof first === 'string' && /^(\[DB\]|\[DB Migration\]|\[PG|\[migrate|\s*Pace Rise|\s*http:|\s*WebSocket|\s*DB)/.test(first)) {
            return;
        }
        origLog(...args);
    };
    console.info = (...args) => {
        // info 도 동일 정책
        const first = args[0];
        if (typeof first === 'string' && /^\[/.test(first)) return;
        origInfo(...args);
    };
}
