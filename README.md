# Pace Rise Competition OS

육상 대회 운영 관리 시스템 (Korean track-and-field competition management).

## Quick Start

```bash
npm install
npm start
# http://localhost:3000
```

## Tests

```bash
npm test              # 1회 실행
npm run test:watch    # 파일 변경 감지
npm run test:coverage # 커버리지 리포트
```

테스트는 **운영 DB와 완전히 분리된 임시 SQLite**를 사용합니다
(`tests/setup/global-setup.js` 의 `SQLITE_PATH` 주입).

### CI 설정 (선택)

`docs/ci.yml.template` 을 `.github/workflows/ci.yml` 로 복사하면
GitHub Actions 에서 모든 push/PR 마다 자동 테스트가 실행됩니다.
(GitHub App 권한 제약으로 자동 푸시 불가 → 수동 복사 필요)

```bash
mkdir -p .github/workflows
cp docs/ci.yml.template .github/workflows/ci.yml
git add .github && git commit -m "ci: enable automated tests" && git push
```

## 문서

- `docs/COMMERCIALIZATION_AUDIT_2026-05-30.md` — 상용화 준비도 종합 검토
- `docs/SYSTEM_MAP.md` — 시스템 구조 지도
- `AUDIT_REPORT.md` — 이전 운영 감사 (May 2026)
