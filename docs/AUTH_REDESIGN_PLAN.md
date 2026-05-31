# 인증·세션 시스템 재설계 계획 (Auth Redesign Plan)

> 작성일: 2026-05-30
> 우선순위: 🔴 P0 (출시 전 필수)
> 예상 작업: 4단계, 총 약 2주

---

## 1. 현황 (As-Is)

### 1.1 인증 방식
- **암호 보관**: `system_config` 테이블에 키:값으로 저장
  - `admin_pw`: bcrypt 해시
  - `operation_key`: 평문 (DB 내부)
  - `record_officer_key`: 평문 (DB 내부)
- **클라이언트 전달**: URL `?key=xxx` 또는 폼 `admin_key=xxx`
- **세션**: 없음. 매 요청마다 키 재검증
- **운영자 다중 키**: `operation_key` 테이블에 `judge_name + plain_key + can_manage` 저장

### 1.2 핵심 함수 (server.js)
| 함수 | 위치 | 역할 |
|---|---|---|
| `isAdminKey(key)` | L1254 | bcrypt 검증 |
| `isOperationKey(key)` | L1236 | admin_pw OR ops 기본키 OR 운영자키 캐시 |
| `isRecordOfficerKey(key)` | L1265 | 기록위원 키 |
| `isAdminOrManager(key)` | L1258 | admin OR can_manage=1 운영자 |
| `isRecordOfficerOrAdmin(key)` | L1272 | admin OR 기록위원 |
| `getJudgeName(key)` | L1276 | 키 → 표시 이름 |
| `getKeyRole(key)` | L1283 | 키 → 역할 문자열 |

### 1.3 위험 요소
1. **URL key 노출**: `?key=xxx` 가 액세스 로그, 리퍼러, 브라우저 히스토리에 남음
2. **평문 운영키**: operation_key 가 DB에 평문 저장 (admin_pw 만 bcrypt)
3. **세션 만료 없음**: 한 번 발급된 키는 회수 전까지 영구 유효
4. **다중 로그인 제어 불가**: 키 회수만 가능, 활성 세션 강제 종료 불가
5. **2FA/IP 제한 없음**
6. **감사 로그 부족**: opLog만 있음, 로그인 이벤트 없음

---

## 2. 목표 (To-Be)

### 2.1 새 모델
- **계정 기반**: `user` 테이블 (organization_id, username, password_hash, role, ...)
- **세션**: JWT (Access Token 1h + Refresh Token 30d, HttpOnly Cookie)
- **권한**: role 기반 (`admin` / `manager` / `record_officer` / `operator` / `viewer`)
- **로그인 이벤트 감사**: `login_audit` 테이블

### 2.2 100% 호환성 유지 정책
**기존 키 인증은 그대로 동작합니다.** 신규 JWT가 추가될 뿐.
- 동일 라우트가 두 가지 인증을 모두 받음:
  1. 신규: `Authorization: Bearer <JWT>` 헤더 또는 HttpOnly 쿠키
  2. 레거시: `?key=xxx` 또는 body `admin_key=xxx`
- 라우트 핸들러는 `req.user` 객체를 통해 통일된 권한 정보 사용
- 6개월 후 레거시 deprecation 경고 → 12개월 후 제거

---

## 3. 단계별 계획

### Phase 1 — 토대 (이번 커밋, ~2일)
**목표**: 코드/DB 추가만, 기존 동작 0 변경

- [x] **DB 마이그레이션**: `user`, `session_refresh`, `login_audit` 테이블 추가
  - 기존 admin_pw 를 자동으로 user 테이블에 'admin' 계정으로 시드
  - SQLite + PostgreSQL 양쪽 지원
- [x] **JWT 헬퍼**: `lib/auth/jwt.js` (signAccess, signRefresh, verify)
- [x] **인증 어댑터 미들웨어**: `lib/auth/middleware.js`
  - `req.user = { id, username, role, organization_id }` 통일
  - JWT 우선 → 없으면 레거시 키 fallback
- [x] **환경 변수**: `JWT_SECRET` (없으면 자동 생성 1회 저장)
- 결과: 기능 변화 0, 호출 가능한 신규 모듈만 추가

### Phase 2 — 로그인/리프레시 API (~3일)
- `POST /api/auth/login` (username + password → JWT 쿠키 발급)
- `POST /api/auth/refresh` (refresh token 으로 access token 재발급)
- `POST /api/auth/logout` (서버 측 토큰 무효화)
- `GET  /api/auth/me` (현재 사용자 정보)
- **레거시 호환**: 기존 admin_pw 로 로그인 시도하면 자동으로 user('admin') 매핑

### Phase 3 — UI 통합 (~3일)
- admin.html 로그인 UI 추가 (기존 `?key=` 입력칸 옆에 "계정 로그인" 옵션)
- common.js: fetch wrapper 가 자동으로 JWT 헤더 추가
- 로그인 성공 후 키 입력 화면 우회
- 로그아웃 버튼

### Phase 4 — 마이그레이션 + 강화 (~4일)
- 기존 operation_key 데이터를 user 테이블로 자동 이관 (각 judge_name 당 1 계정)
- 사용자 생성/삭제/비밀번호 변경 UI (관리자만)
- 2FA (TOTP) 옵션
- 로그인 시도 실패 잠금 (5회 실패 → 15분)
- IP 화이트리스트 (옵션)

### Phase 5 — 레거시 정리 (~6개월 후)
- `?key=` deprecation 헤더 응답
- 모든 클라이언트가 JWT 전환되었는지 확인 후 레거시 인증 제거

---

## 4. 기술 결정

### 4.1 토큰 저장 방식
**선택: HttpOnly Cookie + Bearer 헤더 둘 다 지원**
- 웹: HttpOnly Secure SameSite=Lax 쿠키 → XSS 안전
- 모바일/외부 API: Authorization Bearer 헤더
- CSRF 대비: SameSite=Lax + state token

### 4.2 토큰 수명
| 토큰 | 수명 | 저장 위치 |
|---|---|---|
| Access Token | 1시간 | HttpOnly Cookie OR Authorization 헤더 |
| Refresh Token | 30일 | HttpOnly Cookie (path=/api/auth/refresh) |

### 4.3 비밀번호 정책
- bcrypt cost 10 (기존과 동일)
- 최소 8자, 영문+숫자 혼용 권장 (강제 X — UX 균형)

### 4.4 라이브러리 선택
- **jsonwebtoken** (사실상 표준)
- **cookie-parser** (이미 express 5 에 내장 가능)
- 신규 의존성 최소화

---

## 5. DB 스키마 (Phase 1)

```sql
-- users 계정 테이블
CREATE TABLE IF NOT EXISTS app_user (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id INTEGER,                          -- 멀티테넌시 대비 (NULL = 글로벌)
    username       TEXT    NOT NULL UNIQUE,
    password_hash  TEXT    NOT NULL,
    display_name   TEXT,
    email          TEXT,
    role           TEXT    NOT NULL DEFAULT 'viewer', -- admin/manager/record_officer/operator/viewer
    active         INTEGER NOT NULL DEFAULT 1,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until   TEXT,                              -- ISO datetime
    last_login_at  TEXT,
    last_login_ip  TEXT,
    created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Refresh Token 저장 (revoke 가능하게)
CREATE TABLE IF NOT EXISTS session_refresh (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    token_hash  TEXT    NOT NULL,                     -- SHA-256 of refresh token
    user_agent  TEXT,
    ip          TEXT,
    expires_at  TEXT    NOT NULL,
    revoked_at  TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE
);

-- 로그인 감사 로그
CREATE TABLE IF NOT EXISTS login_audit (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER,                              -- 실패 시 NULL
    username    TEXT,                                 -- 시도한 username
    success     INTEGER NOT NULL,
    failure_reason TEXT,
    ip          TEXT,
    user_agent  TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

PostgreSQL용은 `INTEGER PRIMARY KEY AUTOINCREMENT` → `BIGSERIAL PRIMARY KEY`, `datetime('now')` → `NOW()` 로 자동 변환.

---

## 6. 위험 분석

| 위험 | 발생 시점 | 대응 |
|---|---|---|
| JWT_SECRET 유출 | Phase 1 이후 | 환경변수 .env 또는 자동 생성 후 DB 보관 |
| 레거시 키 계속 통하여 보안 강도 차이 | Phase 5 전까지 | 기록위원·관리자는 우선적으로 계정 강제 사용 |
| 쿠키와 헤더 동시 사용 시 우선순위 혼란 | Phase 2 | Bearer 헤더 > 쿠키 순으로 명시 |
| 토큰 폐기 후에도 캐시된 응답 | Phase 2 | 로그아웃 시 SW 캐시 invalidate |
| 마이그레이션 중 비밀번호 분실 | Phase 4 | admin pw 백업 + reset 토큰 발급 메커니즘 |

---

## 7. 진척 추적

| Phase | 상태 | 커밋 |
|---|---|---|
| 1. 토대 | 🔄 진행 중 | — |
| 2. API | ⏳ 대기 | — |
| 3. UI | ⏳ 대기 | — |
| 4. 마이그레이션 | ⏳ 대기 | — |
| 5. 정리 | ⏳ 6개월 후 | — |
