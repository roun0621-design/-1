/**
 * Vitest setupFiles — 각 테스트 파일 시작 시 실행
 *
 * 역할:
 *  - 로그 노이즈 감소 (server.js 부팅 로그가 너무 많음)
 *  - 글로벌 helper 등록 (있다면)
 */

// server.js 가 console.log 로 시작 배너를 출력하는데, 테스트에서는 시끄러우니 잠시 무음 처리
// 단, 실패 시 디버깅이 필요하므로 TEST_VERBOSE=1 로 켤 수 있게 함
if (!process.env.TEST_VERBOSE) {
    const origLog = console.log;
    const origInfo = console.info;
    console.log = (...args) => {
        const first = args[0];
        // [DB], [PG cache], Pace Rise... 같은 배너만 음소거
        if (typeof first === 'string' && /^(\[DB\]|\[PG|\[migrate|\s*Pace Rise|\s*http:|\s*WebSocket|\s*DB)/.test(first)) {
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
