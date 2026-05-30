/**
 * Vitest configuration — PACE RISE
 *
 * 목적:
 *  - 핵심 API 회귀 테스트를 안전하게 격리된 환경에서 실행
 *  - server.js 의 listen 을 자동으로 건너뛰고 (require.main 가드), app 인스턴스만 가져옴
 *  - 운영 DB 와 충돌하지 않도록 환경변수로 분리
 *
 * 실행:
 *  npm test               — 1회 실행
 *  npm run test:watch     — watch 모드
 *  npm run test:coverage  — 커버리지 리포트
 */
module.exports = {
    test: {
        // 노드 환경
        environment: 'node',

        // 테스트 파일 위치
        include: ['tests/**/*.test.js'],

        // describe/it/expect 등을 import 없이 글로벌로 사용 (Vitest 4 권장)
        // 우리 코드베이스가 CommonJS 라서 require('vitest') 가 막혀있음 → globals 로 우회
        globals: true,

        // 직렬 실행 (DB 충돌 방지)
        fileParallelism: false,
        pool: 'forks',
        poolOptions: {
            forks: {
                singleFork: true,
            },
        },

        // 글로벌 setup (테스트 환경 변수 주입)
        globalSetup: './tests/setup/global-setup.js',

        // 각 테스트 파일 시작 전 실행
        setupFiles: ['./tests/setup/test-env.js'],

        // 타임아웃
        testTimeout: 15000,
        hookTimeout: 15000,

        // 출력
        reporters: ['default'],

        // 커버리지 (선택)
        coverage: {
            provider: 'v8',
            reporter: ['text', 'html'],
            include: ['server.js', 'lib/**/*.js'],
            exclude: ['tests/**', 'node_modules/**', 'public/**'],
        },
    },
};
