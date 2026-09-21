/**
 * Pace Rise Competition OS — Express Server v5
 * Multi-competition, 3-tier auth (viewer/judge/admin)
 * v5: WebSocket scoreboard, PDF documents, broadcast overlay, security enhancements
 */
require('dotenv').config();

// ─────────────────────────────────────────────────────────────────────────────
// [Deploy 하드닝 — 2026-05] 필수 npm 패키지 self-check
//   - 프로덕션에서 `npm install --omit=dev` 누락으로 502 가 났던 적이 있음
//     (cookie-parser, jsonwebtoken, bcryptjs 미설치)
//   - require() 가 실패하면 PM2 가 crash loop 에 빠지고 원인을 알기 힘듦
//   - 부팅 시 명시적으로 모든 필수 모듈을 체크하고, 누락된 게 있으면
//     명확한 한 줄 에러로 종료 (PM2 logs 첫 줄에 바로 보이도록)
// ─────────────────────────────────────────────────────────────────────────────
(function selfCheckRequiredModules() {
    const required = [
        'express', 'compression', 'multer', 'xlsx', 'helmet', 'ws',
        'pdfkit', 'canvas', 'express-rate-limit',
        // Auth Phase 1+2 핵심
        'bcryptjs', 'jsonwebtoken', 'cookie-parser',
        // DB
        'better-sqlite3', 'pg',
        // dotenv 는 위에서 이미 로드됨
    ];
    const missing = [];
    for (const name of required) {
        try { require.resolve(name); }
        catch (_) { missing.push(name); }
    }
    if (missing.length) {
        const msg = `[FATAL] 필수 npm 패키지 누락: ${missing.join(', ')}\n` +
                    `        해결: npm ci --omit=dev  (또는 npm install --omit=dev ${missing.join(' ')})\n` +
                    `        프로덕션에선 ${process.cwd()} 에서 실행하세요.`;
        console.error('\n' + '='.repeat(70));
        console.error(msg);
        console.error('='.repeat(70) + '\n');
        process.exit(1);
    }
})();
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const compression = require('compression');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx');
const helmet = require('helmet');
const { generateFullRecordExcel } = require('./lib/fullRecordExcel');
const { generateFullRecordPdf } = require('./lib/fullRecordPdf');
const { generateCertificatePdf, generateCertificateBatch, renderRankLabel } = require('./lib/certificatePdf');
const SMS = require('./lib/smsSender');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const { initDatabase, DB_PATH } = require('./db/init');
const { getDb } = require('./lib/db');
const { detectRecordBreaks, detectCombinedRecordBreaks, normalizeEventName: normalizeEventNameServer } = require('./lib/recordCompare');
const WebSocket = require('ws');
const PDFDocument = require('pdfkit');
const code128 = require('./lib/code128');
const timingParse = require('./lib/timingParse');   // .lif/.txt/xlsx 공통: 시간·상태·라운드·성별 해석
const { createCanvas, registerFont } = require('canvas');
const http = require('http');
const crypto = require('crypto');
const cron = require('node-cron');

// Ensure upload temp directory exists (fixes deployment upload failures)
const fs = require('fs');
const { execSync } = require('child_process');
const UPLOAD_TMP = '/tmp/uploads/';
if (!fs.existsSync(UPLOAD_TMP)) fs.mkdirSync(UPLOAD_TMP, { recursive: true });
const _multerUpload = multer({ dest: UPLOAD_TMP, limits: { fileSize: 10 * 1024 * 1024 } });
// multer 는 req.body 를 새로 만들기 때문에, JWT 브리지(_applyJwtBridge)가 넣어둔 admin_key 가 사라진다 →
// 파싱이 끝난 뒤 한 번 더 주입한다. (호출부 25곳은 그대로 upload.single/array 사용)
const upload = {};
for (const m of ['single', 'array', 'fields', 'any', 'none']) {
    upload[m] = (...a) => { const mw = _multerUpload[m](...a); return (req, res, next) => mw(req, res, (err) => {
        if (err) return next(err);
        _applyJwtBridge(req);
        // 쓰기 가드(멀티파트): 본문이 파싱된 지금에서야 키를 볼 수 있다. 업로드 라우트는 전부 운영/관리 기능.
        if (!_hasValidWriteKey(req)) {
            for (const f of [].concat(req.file || [], req.files || [])) { try { fs.unlinkSync(f.path); } catch (e) {} }
            return res.status(403).json({ error: '인증 키가 필요합니다. (운영키 또는 관리자 로그인)' });
        }
        // 종료 잠금(멀티파트): competition_id 가 폼 필드로 오므로 여기서 검사한다
        _blockedByCompEnd(req, res).then(blocked => {
            if (!blocked) return next();
            for (const f of [].concat(req.file || [], req.files || [])) { try { fs.unlinkSync(f.path); } catch (e) {} }
        }).catch(() => next());
    }); };
}

// ---- KST (한국표준시, UTC+9) Helper ----
function kstNow() {
    const d = new Date();
    d.setHours(d.getHours() + 9);
    return d.toISOString().replace('T', ' ').substring(0, 19);
}

// ─── DB 타임스탬프 → ms epoch 파서 ───────────────────────────────
// SQLite datetime('now')         → "2026-05-27 09:01:00"           (UTC, 공백, TZ 없음)
// PG NOW()::text                 → "2026-05-27 09:01:00.123456+00" (UTC, 공백, +00)
// 표준 ISO                       → "2026-05-27T09:01:00Z" / +00:00
// pg 드라이버 timestamp(tz)      → Date 객체
// 모든 형식에서 ms epoch 을 반환. 파싱 불가 시 NaN.
function parseDbTimestampMs(v) {
    if (v == null) return NaN;
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'number') return v;
    if (typeof v !== 'string') return NaN;
    let s = v.trim();
    if (!s) return NaN;
    // 0) 시간대 표기가 없는 값(SQLite datetime('now') = UTC)은 UTC 로 읽는다.
    //    예전엔 new Date('2026-09-18 06:40:00') 이 '현지 시각'으로 읽혀 9시간 앞선 값이 됐고, 오프라인 충돌 판정(서버가 더 최신인가)이
    //    9시간 안에서는 절대 참이 되지 않아 옛 오프라인 값이 최신 수정을 덮었다.
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) {
        const ms0 = new Date(s.replace(' ', 'T') + 'Z').getTime();
        if (Number.isFinite(ms0)) return ms0;
    }
    // 1) 그대로 파싱 시도 (Node 20+ 은 PG 공백/+00 형식도 받음)
    let ms = new Date(s).getTime();
    if (Number.isFinite(ms)) return ms;
    // 2) 공백 → T 치환
    if (s.includes(' ') && !s.includes('T')) s = s.replace(' ', 'T');
    ms = new Date(s).getTime();
    if (Number.isFinite(ms)) return ms;
    // 3) "+00" / "-00" → "+00:00" 보정 (구버전 Node 대응)
    const s2 = s.replace(/([+-])(\d{2})$/, '$1$2:00');
    ms = new Date(s2).getTime();
    if (Number.isFinite(ms)) return ms;
    // 4) TZ 표기가 전혀 없으면 UTC 로 간주
    if (!/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s2)) {
        ms = new Date(s2 + 'Z').getTime();
        if (Number.isFinite(ms)) return ms;
    }
    return NaN;
}

// ---- Auto Backup System ----
const backupS3 = require('./lib/backupS3');   // 오프사이트(S3) 복제 — 미설정 시 no-op
const BACKUP_DIR = path.join(__dirname, 'backups');
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
const BACKUP_MAX_DAYS = 7;

/**
 * 로컬 일관성 백업 + 오프사이트(S3) 업로드.
 *   - SQLite: better-sqlite3 의 .backup() 온라인 백업 API 사용 → WAL 까지 병합된
 *     "단일 .db 파일"로 떨어진다. (기존 copyFileSync 3-파일 방식은 .db/-wal 복사 사이에
 *     체크포인트가 끼면 깨질 수 있어 폐기)
 *   - PostgreSQL(db.isAsync): 파일 백업이 무의미 → 건너뜀(RDS 자동 백업이 담당).
 *   - 백업 직후 S3 로 fire-and-forget 업로드 → 인스턴스 소실 시에도 백업 보존.
 */
async function performBackup(tag = 'daily') {
    try {
        if (db.isAsync) {
            // PG 모드: 파일 스냅샷 무의미. (RDS 자동 백업/스냅샷으로 대체)
            return null;
        }
        const ts = kstNow().replace(/[: ]/g, '-');
        const backupFile = path.join(BACKUP_DIR, `backup_${tag}_${ts}.db`);

        // 일관성 보장 온라인 백업: WAL 병합된 단일 파일 생성
        if (db.raw && typeof db.raw.backup === 'function') {
            await db.raw.backup(backupFile);
        } else {
            // 폴백(부팅 초기 등 raw 핸들 미가용): 기존 파일 복사 방식
            fs.copyFileSync(DB_PATH, backupFile);
            if (fs.existsSync(DB_PATH + '-wal')) fs.copyFileSync(DB_PATH + '-wal', backupFile + '-wal');
            if (fs.existsSync(DB_PATH + '-shm')) fs.copyFileSync(DB_PATH + '-shm', backupFile + '-shm');
        }
        console.log(`[Backup] ${tag} 백업 완료: ${path.basename(backupFile)}`);
        cleanOldBackups();

        // 오프사이트 업로드(설정 시에만 동작). 실패해도 로컬 백업 흐름은 막지 않음.
        backupS3.uploadBackup(backupFile, tag).catch(e => console.error('[Backup] S3 업로드 오류:', e.message));

        return backupFile;
    } catch (e) {
        console.error('[Backup] 백업 실패:', e.message);
        return null;
    }
}

function cleanOldBackups() {
    try {
        const cutoff = Date.now() - BACKUP_MAX_DAYS * 24 * 60 * 60 * 1000;
        fs.readdirSync(BACKUP_DIR)
            .filter(f => f.startsWith('backup_') && f.endsWith('.db'))
            .filter(f => !/^backup_final/.test(f))      // 대회 종료 스냅샷(final<대회id>)은 영구 보관 — 7일 뒤 그 대회의 마지막 상태가 사라지지 않게
            .forEach(f => {
                const fpath = path.join(BACKUP_DIR, f);
                if (fs.statSync(fpath).mtimeMs < cutoff) {
                    fs.unlinkSync(fpath);
                    // WAL/SHM 정리
                    try { fs.unlinkSync(fpath + '-wal'); } catch(e) {}
                    try { fs.unlinkSync(fpath + '-shm'); } catch(e) {}
                    console.log(`[Backup] 오래된 백업 삭제: ${f}`);
                }
            });
    } catch (e) {}
}

// ─── 자동 백업 스케줄러 ──────────────────────────────────────────
// 기존엔 node-cron 만 사용 → "missed execution" 으로 daily 백업이 한 건도 안 쌓이는 문제 발생.
// 해결: setInterval 기반의 견고한 watchdog 으로 보강.
//   - 매 5분마다 백업 디렉토리를 검사해서
//     * 마지막 hourly 백업 후 ≥ 60분 경과 → hourly 백업 (활성 대회 무관, 무조건 실행)
//     * 마지막 daily 백업 후 ≥ 24시간 경과 → daily 백업
//   - cron 도 그대로 유지해서 정시 트리거 유지, 단 cron 이 놓쳐도 watchdog 이 복구.
// 백업은 단순 파일 복사라 빠르고 블로킹 위험 없음.
function _lastBackupAgeMs(tag) {
    try {
        const files = fs.readdirSync(BACKUP_DIR)
            .filter(f => f.startsWith(`backup_${tag}_`) && f.endsWith('.db'))
            .map(f => ({ f, m: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
            .sort((a, b) => b.m - a.m);
        if (files.length === 0) return Infinity;
        return Date.now() - files[0].m;
    } catch(e) { return Infinity; }
}

// 테스트처럼 require 로 불러온 경우엔 스케줄러를 돌리지 않는다 (임시 DB 의 백업이 backups/ 에 쌓여 watchdog 판단을 흐렸다)
const _BACKUP_SCHEDULER_ON = require.main === module;

// 매일 새벽 3시 (KST = UTC+9 → UTC 18시) 정시 daily 백업
if (_BACKUP_SCHEDULER_ON) cron.schedule('0 18 * * *', () => performBackup('daily'));

// 매 시각 정시 hourly 백업
if (_BACKUP_SCHEDULER_ON) cron.schedule('0 * * * *', () => performBackup('hourly'));

// 5분마다 watchdog — cron 이 놓친 백업을 자동 복구
if (_BACKUP_SCHEDULER_ON) setInterval(() => {
    try {
        // daily: 마지막 daily 백업 후 24시간 이상 지났으면 즉시 실행
        if (_lastBackupAgeMs('daily') >= 24 * 60 * 60 * 1000) {
            console.log('[Backup Watchdog] daily 백업 누락 감지 → 즉시 실행');
            performBackup('daily');
        }
        // hourly: 마지막 hourly 백업 후 65분 이상 지났으면 즉시 실행 (정시 +5분 grace)
        if (_lastBackupAgeMs('hourly') >= 65 * 60 * 1000) {
            console.log('[Backup Watchdog] hourly 백업 누락 감지 → 즉시 실행');
            performBackup('hourly');
        }
    } catch(e) { console.error('[Backup Watchdog] 오류:', e.message); }
}, 5 * 60 * 1000);

// 서버 시작 시 1회 백업 + 시작 직후 hourly/daily 가 비어있으면 즉시 생성
if (_BACKUP_SCHEDULER_ON) setTimeout(() => {
    performBackup('startup');
    // 시작 시점에 daily/hourly 가 너무 오래된 상태면 즉시 부트스트랩
    if (_lastBackupAgeMs('daily') >= 24 * 60 * 60 * 1000) performBackup('daily');
    if (_lastBackupAgeMs('hourly') >= 60 * 60 * 1000) performBackup('hourly');
}, 5000);

const app = express();
const PORT = process.env.PORT || 3000;
// 프록시(nginx 등) 뒤에서 req.ip 가 실제 클라이언트 IP 가 되도록. 미설정이면 모든 요청이 프록시 IP 하나로 잡혀
// 레이트리밋이 전 사용자 공용이 되고, X-Forwarded-For 를 직접 읽으면 클라이언트가 IP 를 조작할 수 있다.
//   TRUST_PROXY: 홉 수(기본 1) | 'false'(프록시 없음) | 'true' | 서브넷 문자열
{
    const tp = process.env.TRUST_PROXY;
    app.set('trust proxy', tp == null || tp === '' ? 1 : (tp === 'false' ? false : tp === 'true' ? true : (/^\d+$/.test(tp) ? parseInt(tp, 10) : tp)));
}

// 부팅 작업(인증 테이블·마이그레이션·시드·PG 캐시)이 끝나기 전의 요청은 기다린다
app.use((req, res, next) => { if (_bootDone) return next(); _bootReady.then(() => { _bootDone = true; next(); }, () => { _bootDone = true; next(); }); });
let _bootDone = false;
// ---- Security Middleware ----
app.use(helmet({
    contentSecurityPolicy: false,   // CSP는 프론트엔드 inline script 때문에 비활성
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false,  // YouTube 등 외부 리소스 임베드 허용
    // YouTube iframe 임베드를 위해 X-Frame-Options 완화
    frameguard: false,
    referrerPolicy: { policy: 'no-referrer-when-downgrade' },  // YouTube 임베드 호환
}));
app.use(rateLimit({
    windowMs: 60 * 1000,   // 1분
    max: parseInt(process.env.RATE_LIMIT_MAX || '3000', 10),  // IP당 분당 한도(기본 3000, 부하측정 시 env로 상향)
    message: { error: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.' }
}));
// 인증 API는 더 엄격하게 제한 (무차별 대입 방지)
const authLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: parseInt(process.env.AUTH_RATE_LIMIT_MAX || '30', 10),   // 1분에 30회 (테스트는 한 IP 에서 로그인이 몰리므로 global-setup 이 상향)
    message: { error: '로그인 시도가 너무 많습니다. 1분 후 다시 시도하세요.' }
});

app.use(compression());
app.use(express.json());
// AUTH Phase 2: JWT 쿠키 파싱 (HttpOnly access_token / refresh_token)
try { app.use(require('cookie-parser')()); } catch (e) { console.warn('[auth] cookie-parser 미설치:', e.message); }

// ─── JWT → 레거시 키 브리지 (2026-09 인증 정리) ─────────────────────────────
//   라우트 ~90곳이 isAdminKey(req.query.key / body.admin_key / x-admin-key) 로 권한을 검사한다.
//   관리자가 JWT(쿠키 pr_access 또는 Authorization: Bearer)로 로그인했으면, 요청마다 1회용 내부 토큰을 만들어
//   그 자리들에 넣어 준다 → 브라우저가 관리자 비밀번호를 보관·전송할 필요가 없어진다.
//   · 토큰은 'jwtb:' + 난수, 서버 메모리에만 있고 응답이 끝나면 폐기 (밖으로 나가지 않음)
//   · 쿠키로 인증된 변경 요청은 Origin 이 같은 호스트일 때만 브리지 (CSRF 방지)
//   · viewer 역할은 브리지하지 않음
const _bridgeTokens = new Map(); // token → { role, name, userId }
function _bridgeOf(key) { return (typeof key === 'string' && key.startsWith('jwtb:')) ? (_bridgeTokens.get(key) || null) : null; }
function _applyJwtBridge(req) {
    const t = req && req._bridgeToken;
    if (!t) return;
    req.headers['x-admin-key'] = t;
    if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) req.body.admin_key = t;
    // Express 5 의 req.query 는 매번 다시 파싱하는 getter → 인스턴스 속성으로 덮어써야 값이 유지된다
    const qv = Object.assign({}, req.query, { key: t, admin_key: t });
    Object.defineProperty(req, 'query', { value: qv, writable: true, configurable: true, enumerable: true });
}
app.use(async (req, res, next) => {
    try {
        if (!req.path.startsWith('/api/') || req.path.startsWith('/api/auth/')) return next();
        const auth = req.headers['authorization'] || '';
        const bm = auth.match(/^Bearer\s+(.+)$/i);
        const cookieTok = req.cookies && req.cookies.pr_access;
        const tok = bm ? bm[1].trim() : cookieTok;
        if (!tok) return next();
        // 쿠키 인증 + 변경 요청 → Origin 확인 (헤더 Bearer 는 교차 사이트에서 자동 첨부되지 않으므로 제외)
        if (!bm && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
            const origin = req.headers.origin;
            if (origin) { let h = ''; try { h = new URL(origin).host; } catch (e) {} if (h !== req.headers.host) return next(); }
        }
        const payload = await require('./lib/auth/jwt').verifyAccess(db, tok);
        if (!payload || !payload.role || payload.role === 'viewer') return next();
        const t = 'jwtb:' + crypto.randomBytes(18).toString('hex');
        _bridgeTokens.set(t, { role: payload.role, name: payload.username || 'user', userId: payload.sub });
        req._bridgeToken = t;
        req.user = req.user || { id: payload.sub, username: payload.username, role: payload.role, source: 'jwt' };
        res.on('close', () => _bridgeTokens.delete(t));
        _applyJwtBridge(req);
    } catch (e) { /* 브리지 실패는 무인증과 동일 */ }
    next();
});

// ─── 쓰기 가드 (2026-09) ─────────────────────────────────────────────────
//   점검에서 변경 라우트 40개가 키 검사 없이 열려 있었다: 기록 입력(/api/results/upsert — 진행 중 종목은 누구나 기록을 쓸 수 있었음),
//   기록 초기화, 결승/준결승 생성, 레인 변경, 소집 처리, 풍속, 진출자 선정, 릴레이 주자, .lif/.txt 가져오기 등.
//   → /api 의 모든 POST/PUT/PATCH/DELETE 는 유효한 키(운영키·관리자·기록위원 또는 JWT 세션)를 요구한다.
//   라우트별 세부 권한(관리자 전용 등)은 기존 검사가 그대로 추가로 적용된다.
//   클라이언트 api() 는 저장된 키를 쓰기 요청에 자동으로 실어 보내므로 로그인한 심판·운영진은 영향이 없다.
const WRITE_GUARD_PUBLIC = [
    /^\/api\/auth\//,                          // 로그인·갱신·로그아웃·키 확인
    /^\/api\/admin\/verify$/,
    /^\/api\/push\/(register|unregister|interests)$/,   // 관람객 푸시 구독
    /^\/api\/event\/[^/]+\/(record|send-cert)$/,       // 공개 기록 페이지(슬러그) — 자체 키 검사
    /^\/api\/external\//,                      // 외부 연동 — 자체 API 키(externalApiAuth)
];
function _writeKeyOf(req) {
    return (req.body && typeof req.body === 'object' && (req.body.admin_key || req.body.operation_key || req.body.key))
        || req.headers['x-admin-key'] || (req.query && (req.query.admin_key || req.query.key)) || '';
}
function _hasValidWriteKey(req) {
    const k = String(_writeKeyOf(req) || '');
    return !!k && (isOperationKey(k) || isAdminOrManager(k) || isRecordOfficerKey(k));
}
app.use((req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) || !req.path.startsWith('/api/')) return next();
    if (WRITE_GUARD_PUBLIC.some(re => re.test(req.path))) return next();
    // multipart 는 아직 본문이 없다 → multer 래퍼(upload.*)가 파싱 직후 같은 검사를 한다
    if (/^multipart\/form-data/i.test(req.headers['content-type'] || '')) return next();
    if (_hasValidWriteKey(req)) return next();
    return res.status(403).json({ error: '인증 키가 필요합니다. (운영키 또는 관리자 로그인)' });
});

// ------------------------------------------------------------
// 글로벌 쓰기 가드 미들웨어 — 종료된 대회는 운영자/녹화관 쓰기 금지
// (관리자 키는 통과, 읽기 메서드 GET/HEAD/OPTIONS는 통과)
// competition_id 추출 우선순위:
//   1) URL :compId 또는 req.params.id (단, /api/competitions/:id 같이 직접 참조 라우트)
//   2) req.body.competition_id / req.query.competition_id
//   3) 본문/쿼리의 event_id → event.competition_id lookup
//   4) 본문의 athlete_id → athlete.competition_id lookup
//   5) 본문의 heat_id → heat→event→competition lookup
//   6) 본문의 event_entry_id → event_entry→event lookup
// 추출 못 하면 통과 (라우트별 가드에 위임)
// ------------------------------------------------------------
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// 종료 가드 면제 경로 (관리자가 종료 자체를 푸는 라우트, 인증/로그 등)
const COMP_END_GUARD_EXEMPT = [
    /^\/api\/admin\/competitions\/\d+\/(close|reopen)$/,
    /^\/api\/judge\/login$/,
    /^\/api\/judge\/logout$/,
    /^\/api\/admin\/login$/,
    /^\/api\/operation-log/,
    /^\/api\/audit-log/,
    /^\/api\/push\//,   // 푸시 토큰 등록/해제는 대회 데이터 수정이 아님 — 종료 대회에서도 허용
    /^\/api\/certificates?\//,   // 상장·기록증 발급은 대회 데이터를 바꾸지 않는다 — 시상은 종료 뒤에도 이어진다
    /^\/api\/auth\//,
];
async function _extractCompetitionIdFromRequest(req) {
    try {
        // URL 직접 매칭 — /api/competitions/:id, /api/admin/competitions/:id/*
        const mDirect = req.path.match(/^\/api(?:\/admin)?\/competitions\/(\d+)/);
        if (mDirect) return parseInt(mDirect[1]);

        const b = req.body || {};
        const q = req.query || {};

        // URL 의 id — 이 미들웨어는 라우트 매칭 전이라 req.params 가 비어 있다. 경로에서 직접 읽는다.
        //   (예전엔 /api/heats/:id/wind, /api/events/:id/complete, /api/event-entries/:id/memo 처럼 본문에 id 가 없는 요청은 잠금을 그냥 통과했다)
        const mPath = req.path.match(/^\/api\/(events|heats|event-entries|heat-entries|athletes|results|height-attempts|joint-groups|relay-members|pacing|wa-correct)\/(\d+)(?:\/|$)/);
        if (mPath) {
            const id = parseInt(mPath[2]);
            const SQL = {
                'events': 'SELECT competition_id FROM event WHERE id=?',
                'heats': 'SELECT e.competition_id AS competition_id FROM heat h JOIN event e ON e.id=h.event_id WHERE h.id=?',
                'event-entries': 'SELECT e.competition_id AS competition_id FROM event_entry ee JOIN event e ON e.id=ee.event_id WHERE ee.id=?',
                'heat-entries': 'SELECT e.competition_id AS competition_id FROM heat_entry he JOIN heat h ON h.id=he.heat_id JOIN event e ON e.id=h.event_id WHERE he.id=?',
                'athletes': 'SELECT competition_id FROM athlete WHERE id=?',
                'results': 'SELECT e.competition_id AS competition_id FROM result r JOIN heat h ON h.id=r.heat_id JOIN event e ON e.id=h.event_id WHERE r.id=?',
                'height-attempts': 'SELECT e.competition_id AS competition_id FROM height_attempt ha JOIN heat h ON h.id=ha.heat_id JOIN event e ON e.id=h.event_id WHERE ha.id=?',
                'joint-groups': 'SELECT competition_id FROM joint_group WHERE id=?',
            }[mPath[1]];
            if (SQL) { try { const r = await db.get(SQL, id); if (r && r.competition_id) return r.competition_id; } catch (e) { /* 테이블/열이 없으면 아래 단계로 */ } }
        }

        // 직접 competition_id
        const direct = b.competition_id || q.competition_id || b.comp_id || q.comp_id;
        if (direct) return parseInt(direct);

        // URL의 :compId/:competitionId 파라미터
        if (req.params && (req.params.compId || req.params.competitionId)) {
            return parseInt(req.params.compId || req.params.competitionId);
        }

        // event_id → event.competition_id
        const eventId = b.event_id || q.event_id;
        if (eventId) {
            const ev = await db.get('SELECT competition_id FROM event WHERE id=?', eventId);
            if (ev) return ev.competition_id;
        }
        // heat_id → heat→event
        const heatId = b.heat_id || q.heat_id;
        if (heatId) {
            const h = await db.get('SELECT e.competition_id AS competition_id FROM heat h JOIN event e ON e.id=h.event_id WHERE h.id=?', heatId);
            if (h) return h.competition_id;
        }
        // event_entry_id → event_entry→event
        const entryId = b.event_entry_id || q.event_entry_id;
        if (entryId) {
            const ee = await db.get('SELECT e.competition_id AS competition_id FROM event_entry ee JOIN event e ON e.id=ee.event_id WHERE ee.id=?', entryId);
            if (ee) return ee.competition_id;
        }
        // heat_entry_id → heat_entry→heat→event
        if (b.heat_entry_id) {
            const he = await db.get('SELECT e.competition_id AS competition_id FROM heat_entry he JOIN heat h ON h.id=he.heat_id JOIN event e ON e.id=h.event_id WHERE he.id=?', b.heat_entry_id);
            if (he) return he.competition_id;
        }
        // items: [{event_id}] (외부 API 일괄 연결) → 첫 항목 기준
        if (Array.isArray(b.items) && b.items.length && b.items[0] && b.items[0].event_id) {
            const ev = await db.get('SELECT competition_id FROM event WHERE id=?', b.items[0].event_id);
            if (ev) return ev.competition_id;
        }
        // event_ids: [..] (소집 일괄 처리 등) → 첫 종목 기준
        if (Array.isArray(b.event_ids) && b.event_ids.length) {
            const ev = await db.get('SELECT competition_id FROM event WHERE id=?', b.event_ids[0]);
            if (ev) return ev.competition_id;
        }
        // athlete_id → athlete.competition_id
        const athId = b.athlete_id || q.athlete_id;
        if (athId) {
            const a = await db.get('SELECT competition_id FROM athlete WHERE id=?', athId);
            if (a) return a.competition_id;
        }
    } catch (e) { /* 추출 실패는 통과시킴 */ }
    return null;
}
// 종료 잠금 판정 — 막아야 하면 응답을 보내고 true. (전역 미들웨어 + multer 래퍼가 함께 쓴다: 멀티파트는 파싱 뒤에야 본문을 볼 수 있다)
async function _blockedByCompEnd(req, res) {
    for (const re of COMP_END_GUARD_EXEMPT) if (re.test(req.path)) return false;
    // 키: 본문·헤더(x-admin-key)·쿼리 — 예전엔 헤더를 보지 않아 헤더로만 키를 보내는 관리자 요청이 종료 후 막혔다
    const key = _writeKeyOf(req);
    if (key && isAdminKey(key)) return false;
    const compId = await _extractCompetitionIdFromRequest(req);
    if (!compId) return false; // 추출 못 하면 통과 (라우트별 가드에 위임)
    try {
        if (await isCompetitionEnded(compId)) {
            res.status(403).json({ error: '대회가 종료되었습니다. 관리자 권한으로만 수정할 수 있습니다.', competition_ended: true, competition_id: compId });
            return true;
        }
    } catch (e) { /* 가드 실패 시 통과 (가용성 우선) */ }
    return false;
}
app.use(async (req, res, next) => {
    if (!WRITE_METHODS.has(req.method)) return next();
    if (!req.path.startsWith('/api/')) return next();
    if (/^multipart\/form-data/i.test(req.headers['content-type'] || '')) return next();   // multer 래퍼에서 검사
    if (await _blockedByCompEnd(req, res)) return;
    next();
});

// Block results.html access — redirect to dashboard
app.get('/results.html', (req, res) => {
    const comp = req.query.comp ? `?comp=${req.query.comp}` : '';
    res.redirect(`/dashboard.html${comp}`);
});

// 행사(event) 간편 기록입력 — /e/<slug>/입력 (또는 /record) → 전용 입력 페이지
//   ※ /e/:slug (대시보드)보다 먼저 등록할 필요는 없으나(세그먼트 수가 달라 충돌 없음) 가독성상 위에 둠
app.get('/e/:slug/:page', (req, res, next) => {
    let p = req.params.page;
    try { p = decodeURIComponent(p); } catch (e) {}
    if (p === '입력' || p === 'record') return sendStampedHtml(res, 'event-record.html');
    return next();
});

// 행사(event) 화이트라벨 — /e/<brand-slug> → 대시보드(클라이언트가 slug로 브랜딩 적용)
app.get('/e/:slug', (req, res) => {
    sendStampedHtml(res, 'dashboard.html');
});

// 행사 브랜드 이미지 업로드 (로고/워터마크) — 관리자
app.post('/api/admin/competitions/:id/brand-image', upload.single('image'), async (req, res) => {
    try {
        if (!isAdminKey(req.body && req.body.admin_key)) return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
        if (!req.file) return res.status(400).json({ error: '파일이 업로드되지 않았습니다.' });
        const position = req.body.position;
        if (!['logo', 'watermark'].includes(position)) return res.status(400).json({ error: 'position(logo|watermark) 필요' });
        const comp = await db.get('SELECT * FROM competition WHERE id=?', req.params.id);
        if (!comp) return res.status(404).json({ error: '대회를 찾을 수 없습니다.' });
        const destDir = path.join(__dirname, 'public', 'uploads', 'brand');
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
        for (const oe of ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']) {
            const op = path.join(destDir, `brand_${position}_${comp.id}${oe}`);
            try { if (fs.existsSync(op)) fs.unlinkSync(op); } catch (e) {}
        }
        const ext = (path.extname(req.file.originalname) || '.png').toLowerCase();
        const filename = `brand_${position}_${comp.id}${ext}`;
        fs.copyFileSync(req.file.path, path.join(destDir, filename));
        try { fs.unlinkSync(req.file.path); } catch (_) {}
        const publicUrl = `/uploads/brand/${filename}`;
        const col = position === 'logo' ? 'brand_logo_path' : 'brand_watermark_path';
        await db.run(`UPDATE competition SET ${col}=? WHERE id=?`, publicUrl, comp.id);
        res.json({ success: true, url: publicUrl + '?v=' + Date.now(), path: publicUrl });
    } catch (e) { console.error('[BRAND][upload]', e); res.status(500).json({ error: e.message }); }
});

// TWA(안드로이드 앱) Digital Asset Links — /.well-known/* 는 dotfile 이라 기본 static 이
// 무시하므로 별도 마운트로 서빙. (assetlinks.json 채우면 앱에서 주소창 숨김 검증됨)
app.use('/.well-known', express.static(path.join(__dirname, 'public', '.well-known')));

// ─── iOS 앱(WKWebView) 대응: App Store 심사 가이드 2.3.10 ────────────────────
//   iOS 래퍼는 User-Agent 에 "PWAShell" 표식을 붙인다(WebView.swift). 그 요청에는
//   Android/타 스토어 안내를 서버에서 아예 제거하고 서빙한다(안드로이드 웹 사용자는 그대로).
//   index.html 의 <!--PWASHELL-STRIP--> ~ <!--/PWASHELL-STRIP--> 구간을 제거.
function isIOSAppShell(req) {
    return /PWAShell/i.test(req.headers['user-agent'] || '');
}
// 캐시 버전 자동화: HTML 의 ?v= 와 sw.js 의 CACHE_NAME 을 파일 해시로 바꿔 내보낸다 (손으로 올리던 번호는 이제 의미 없음)
const assetVersion = require('./lib/assetVersion').create(path.join(__dirname, 'public'));
function sendStampedHtml(res, file, next) {
    fs.readFile(path.join(__dirname, 'public', file), 'utf8', (err, html) => {
        if (err) return next ? next() : res.status(404).end();
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.type('html').send(assetVersion.stampHtml(html));
    });
}
app.get('/sw.js', (req, res, next) => {
    fs.readFile(path.join(__dirname, 'public', 'sw.js'), 'utf8', (err, js) => {
        if (err) return next();
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.type('application/javascript').send(assetVersion.stampSw(js));
    });
});
app.get(/^\/(?:[A-Za-z0-9_-]+\.html)?$/, (req, res, next) => {
    const file = req.path === '/' ? 'index.html' : req.path.slice(1);
    if (file === 'open.html') return next();      // 아래 iOS 우회 라우트가 처리
    const p = path.join(__dirname, 'public', file);
    fs.readFile(p, 'utf8', (err, html) => {
        if (err) return next();
        let out = html;
        if (file === 'index.html' && isIOSAppShell(req)) out = out.replace(/<!--PWASHELL-STRIP-->[\s\S]*?<!--\/PWASHELL-STRIP-->/g, '');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.type('html').send(assetVersion.stampHtml(out));
    });
});
// open.html 은 Android intent 리다이렉트 전용 → iOS 앱에서는 홈으로 우회
app.get('/open.html', (req, res, next) => {
    if (isIOSAppShell(req)) return res.redirect('/');
    next();
});

app.use(express.static(path.join(__dirname, 'public'), {
    etag: false,
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.js') || filePath.endsWith('.css') || filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        }
    }
}));

// Serve favicon from icons
app.get('/favicon.ico', (req, res) => res.sendFile(path.join(__dirname, 'public', 'favicon.ico')));

// ─── Health check — scripts/deploy.sh 및 nginx/외부 모니터링 용도 ──────────
//   정상: 200 + 상태 JSON
//   서버는 살아있지만 auth 마이그 실패: 200 (legacy 로그인은 정상 동작하므로)
//   완전 장애: Express 자체가 응답 못 함 → connection refused / 502
// ---- 보안 자가점검 (부팅 1회, 경고만) ----
try {
    const { runSecuritySelfCheck } = require('./lib/securityCheck');
    global.__securityWarnings = runSecuritySelfCheck();
    if (global.__securityWarnings.length) {
        console.warn(`\n[보안 자가점검] ⚠️  약한 설정 ${global.__securityWarnings.length}건 감지:`);
        global.__securityWarnings.forEach(m => console.warn('  - ' + m));
        console.warn('  → 운영 환경이면 .env 의 해당 값을 강하게 바꾸고 재시작하세요.\n');
    } else {
        console.log('[보안 자가점검] ✅ 기본 자격증명 점검 통과');
    }
} catch (e) {
    global.__securityWarnings = [];
    console.warn('[보안 자가점검] 실행 실패:', e.message);
}

// .env 가 아니라 '실제 적용 중인' 자격증명(DB system_config)을 점검 — 관리 화면에서 약한 값으로 바꿔도 잡힌다
function _refreshDbSecurityWarnings() {
    setTimeout(() => {
        try {
            const { _WEAK } = require('./lib/securityCheck');
            const w = [];
            const op = ACCESS_KEYS.operation;
            const opWeak = _opKeyIsHash(op) ? getConfigKey('operation_key_weak', '0') === '1' : (!op || String(op).length < 6 || _WEAK.has(String(op).toLowerCase()));
            if (opWeak) w.push('운영키(기본키)가 약함 — 6자 미만이거나 흔한 값. 관리자 → 접근 키에서 변경하세요');
            const h = ACCESS_KEYS.adminHash;
            if (h) for (const c of _WEAK) { if (bcrypt.compareSync(c, h)) { w.push(`관리자 키가 흔한 값("${c}")입니다 — 즉시 변경하세요`); break; } }
            global.__dbSecurityWarnings = w;
            if (w.length) { console.warn('[보안 자가점검·DB] ⚠️  ' + w.join(' / ')); }
        } catch (e) { global.__dbSecurityWarnings = []; }
    }, 0);
}
setTimeout(_refreshDbSecurityWarnings, 1500); // ACCESS_KEYS 초기화 이후
app.get('/api/admin/security-status', (req, res) => {
    const k = req.headers['x-admin-key'] || req.query.key;
    if (!isAdminKey(String(k || ''))) return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
    res.json({ warnings: [...(global.__dbSecurityWarnings || []), ...(global.__securityWarnings || []).filter(m => /JWT_SECRET|ADMIN_ID/.test(m))] });
});

app.get('/api/health', async (req, res) => {
    const mem = process.memoryUsage();
    const base = {
        backend: db.isAsync ? 'postgres' : 'sqlite',
        security_warnings: (global.__securityWarnings || []).length + (global.__dbSecurityWarnings || []).length,
        authMig: global.__authMigOk ? 'ok' : (global.__authMigError ? 'failed' : 'pending'),
        authMigError: global.__authMigError || null,
        uptime_sec: Math.floor(process.uptime()),
        node: process.version,
        rss_mb: Math.round(mem.rss / 1048576),
        heap_used_mb: Math.round(mem.heapUsed / 1048576),
        ts: new Date().toISOString(),
    };
    // 실제 DB 연결 확인 — 가벼운 SELECT 1 (SQLite/PG 양쪽 호환).
    // DB 가 죽으면 503 을 반환해 모니터/배포 헬스체크가 장애를 감지하게 한다.
    try {
        await db.get('SELECT 1 AS ok');
        res.json({ ok: true, db: 'up', ...base });
    } catch (e) {
        res.status(503).json({ ok: false, db: 'down', dbError: e.message, ...base });
    }
});

// /open — Android intent:// 중간 리다이렉트 페이지 (카카오톡/인스타 인앱브라우저 대응)
app.get('/open', (req, res) => {
    if (isIOSAppShell(req)) return res.redirect('/');   // 2.3.10: iOS 앱엔 Android 리다이렉트 페이지 노출 금지
    res.sendFile(path.join(__dirname, 'public', 'open.html'));
});

// DB 어댑터 사용 (lib/db.js).
// 기존 better-sqlite3 인터페이스 100% 호환 — db.prepare/.get/.all/.run/.exec/.transaction/.pragma 모두 정상 동작.
// 환경변수 DB_BACKEND=sqlite (기본) / postgres (예정)로 백엔드 전환 가능.
const db = getDb();

// ---- Access Keys (persisted in DB via system_config table) ----
// Ensure tables exist
// ──────────────────────────────────────────────────────────────────
// SQLite-only 부트 마이그레이션 블록 (Phase 2-G-9)
// PG 모드(db.isAsync=true)에서는 db/schema.pg.sql 이 모든 테이블/컬럼/인덱스를
// 이미 정의하므로 이 블록 전체를 건너뛴다. SQLite 부트 시에만 멱등 마이그레이션 실행.
// ──────────────────────────────────────────────────────────────────
// 부팅 시 비동기로 도는 시드·마이그레이션들 — 요청을 받기 전에 끝나야 한다 (_pgBootAsync 가 기다린다)
const _bootTasks = [];

if (!db.isAsync) {
try { db.exec(`CREATE TABLE IF NOT EXISTS operation_key (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    judge_name TEXT NOT NULL,
    key_value TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL DEFAULT 'operation' CHECK(role IN ('operation','admin')),
    can_manage INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`); } catch(e) {}
try { db.exec(`CREATE TABLE IF NOT EXISTS system_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
)`); } catch(e) {}
// Add can_manage column if missing (migration)
try { db.exec(`ALTER TABLE operation_key ADD COLUMN can_manage INTEGER NOT NULL DEFAULT 0`); } catch(e) {}
// (2026-09 결정) 운영키는 해시로 저장한다: key_value = bcrypt 해시, key_prefix = 앞 3자(후보 좁히기), key_hint = 화면 표시용 'abc••••'
try { db.exec(`ALTER TABLE operation_key ADD COLUMN key_prefix TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE operation_key ADD COLUMN key_hint TEXT DEFAULT ''`); } catch(e) {}
// Event Records table (종목별 기록 관리)
try { db.exec(`CREATE TABLE IF NOT EXISTS event_record (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gender TEXT NOT NULL CHECK(gender IN ('M','F')),
    event_name TEXT NOT NULL,
    record_type TEXT NOT NULL CHECK(record_type IN ('national','division','competition')),
    record_value TEXT NOT NULL DEFAULT '',
    holder_name TEXT NOT NULL DEFAULT '',
    holder_team TEXT NOT NULL DEFAULT '',
    record_year TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(gender, event_name, record_type)
)`); } catch(e) {}
// Add remark + status_code to result table if missing
try { db.exec(`ALTER TABLE result ADD COLUMN remark TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE result ADD COLUMN status_code TEXT DEFAULT ''`); } catch(e) {}
// Add wind columns (migration)
try { db.exec(`ALTER TABLE result ADD COLUMN wind REAL DEFAULT NULL`); } catch(e) {}
try { db.exec(`ALTER TABLE heat ADD COLUMN wind REAL DEFAULT NULL`); } catch(e) {}
// 오프라인 재전송 충돌 판정용 — 풍속·소집 상태가 마지막으로 바뀐 시각 (2026-09)
try { db.exec(`ALTER TABLE heat ADD COLUMN wind_updated_at TEXT DEFAULT NULL`); } catch(e) {}
try { db.exec(`ALTER TABLE event_entry ADD COLUMN status_updated_at TEXT DEFAULT NULL`); } catch(e) {}
// 오프라인 충돌 감지용 — height_attempt 에 updated_at 추가 (result 는 이미 보유)
try { db.exec(`ALTER TABLE height_attempt ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'))`); } catch(e) {}
// 혼성경기 종합기록지의 DNS/DNF/DQ/NM 표시용 — combined_score 에 status_code 추가
try { db.exec(`ALTER TABLE combined_score ADD COLUMN status_code TEXT DEFAULT ''`); } catch(e) {}
// Phase C 후속: record_breaking_log에 풍속 컬럼 추가 (NR/DR/CR 감지 시점의 풍속 보존)
try { db.exec(`ALTER TABLE record_breaking_log ADD COLUMN wind REAL DEFAULT NULL`); } catch(e) {}

// ============================================================
// 상장(Certificate) 시스템 — 양식 저장 + 발행 로그
// ============================================================
try { db.exec(`CREATE TABLE IF NOT EXISTS certificate_template (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    competition_id INTEGER,             -- NULL=전역 기본 양식 (모든 대회에서 사용 가능)
    name TEXT NOT NULL,                  -- '시상용 기본', '완주증', '단체상' 등
    kind TEXT NOT NULL DEFAULT 'award',  -- 'award'(시상장) | 'finisher'(완주증) | 'team'(단체상)
    title_text TEXT NOT NULL DEFAULT '상  장',
    body_template TEXT NOT NULL,         -- 본문 (변수: {comp_name} {event_name} {rank_label} {athlete_name} {team} {record} {date} 등)
    rank_label_style TEXT NOT NULL DEFAULT 'ordinal',  -- 'ordinal'(우승/준우승/3위) | 'numeric'(1위/2위/3위) | 'mixed'(우승만 한자 나머지 숫자)
    signer_org TEXT NOT NULL DEFAULT '',
    signer_title TEXT NOT NULL DEFAULT '회장',
    signer_name TEXT NOT NULL DEFAULT '',
    logo_left_path TEXT NOT NULL DEFAULT '',
    logo_right_path TEXT NOT NULL DEFAULT '',
    seal_image_path TEXT NOT NULL DEFAULT '',
    paper_orientation TEXT NOT NULL DEFAULT 'portrait',  -- 'portrait' | 'landscape'
    show_record_value INTEGER NOT NULL DEFAULT 1,
    show_athlete_team INTEGER NOT NULL DEFAULT 1,
    show_date INTEGER NOT NULL DEFAULT 1,
    background_color TEXT NOT NULL DEFAULT '#fffdf6',
    border_style TEXT NOT NULL DEFAULT 'double-gold',    -- 'double-gold' | 'single' | 'none'
    font_family TEXT NOT NULL DEFAULT 'NanumSquare',
    is_default INTEGER NOT NULL DEFAULT 0,                -- 기본 양식 1개만 ON
    sort_order INTEGER NOT NULL DEFAULT 0,
    watermark_image_path TEXT NOT NULL DEFAULT '',        -- 중앙 워터마크 이미지(비우면 없음)
    watermark_opacity REAL NOT NULL DEFAULT 0.07,         -- 0.02~0.5
    watermark_scale REAL NOT NULL DEFAULT 0.45,           -- 페이지폭 대비 0.1~0.9
    border_color TEXT NOT NULL DEFAULT '#b8945a',         -- 테두리/포인트 색
    panel_color TEXT NOT NULL DEFAULT '#faf8f2',          -- 기록증 기록 패널 배경색
    text_color TEXT NOT NULL DEFAULT '#1a1a1a',           -- 본문 글씨 색(제목·이름·본문·날짜·발급자)
    label_color TEXT NOT NULL DEFAULT '#8a7f6a',          -- 보조 글씨 색(대회명·메타·패널 라벨)
    accent_color TEXT NOT NULL DEFAULT '#7a3a00',         -- 강조 색(기록값·종목 강조)
    panel_opacity REAL NOT NULL DEFAULT 1.0,              -- 기록 패널 투명도(0.2~1.0, 낮추면 뒤 워터마크가 비침)
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`); } catch(e) { console.error('[DB] certificate_template create error:', e.message); }
// 기존 SQLite DB 대비 멱등 컬럼 추가 (워터마크/색상)
try { db.exec(`ALTER TABLE certificate_template ADD COLUMN watermark_image_path TEXT NOT NULL DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE certificate_template ADD COLUMN watermark_opacity REAL NOT NULL DEFAULT 0.07`); } catch(e) {}
try { db.exec(`ALTER TABLE certificate_template ADD COLUMN watermark_scale REAL NOT NULL DEFAULT 0.45`); } catch(e) {}
try { db.exec(`ALTER TABLE certificate_template ADD COLUMN border_color TEXT NOT NULL DEFAULT '#b8945a'`); } catch(e) {}
try { db.exec(`ALTER TABLE certificate_template ADD COLUMN panel_color TEXT NOT NULL DEFAULT '#faf8f2'`); } catch(e) {}
try { db.exec(`ALTER TABLE certificate_template ADD COLUMN text_color TEXT NOT NULL DEFAULT '#1a1a1a'`); } catch(e) {}
try { db.exec(`ALTER TABLE certificate_template ADD COLUMN label_color TEXT NOT NULL DEFAULT '#8a7f6a'`); } catch(e) {}
try { db.exec(`ALTER TABLE certificate_template ADD COLUMN accent_color TEXT NOT NULL DEFAULT '#7a3a00'`); } catch(e) {}
try { db.exec(`ALTER TABLE certificate_template ADD COLUMN panel_opacity REAL NOT NULL DEFAULT 1.0`); } catch(e) {}

try { db.exec(`CREATE TABLE IF NOT EXISTS certificate_issue_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    competition_id INTEGER NOT NULL,
    template_id INTEGER NOT NULL,
    event_id INTEGER,                    -- NULL=종합/혼성
    athlete_id INTEGER NOT NULL,
    rank_value INTEGER,                  -- NULL=완주증 등
    record_value TEXT NOT NULL DEFAULT '',
    issued_at TEXT NOT NULL DEFAULT (datetime('now')),
    issued_by TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT ''
)`); } catch(e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_cert_log_comp ON certificate_issue_log(competition_id, issued_at DESC)`); } catch(e) {}

// athlete.phone 컬럼 추가 (SMS 발송용)
try { db.exec(`ALTER TABLE athlete ADD COLUMN phone TEXT NOT NULL DEFAULT ''`); } catch(e) { /* already exists */ }

// ========== SMS System (Aligo + Simulation) ==========
try { db.exec(`CREATE TABLE IF NOT EXISTS sms_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    provider TEXT NOT NULL DEFAULT 'aligo',
    api_key TEXT NOT NULL DEFAULT '',
    user_id TEXT NOT NULL DEFAULT '',
    sender_number TEXT NOT NULL DEFAULT '',
    sender_name TEXT NOT NULL DEFAULT '',
    sim_mode INTEGER NOT NULL DEFAULT 1,     -- 1=시뮬레이션 모드 (실제 발송 안함)
    default_template TEXT NOT NULL DEFAULT '안녕하세요 {athlete_name}님,\n{competition_name} {event_name} 결과:\n{rank_label} {record_value}\n상장 다운로드: {cert_url}',
    monthly_quota INTEGER NOT NULL DEFAULT 0,
    sent_this_month INTEGER NOT NULL DEFAULT 0,
    last_reset_month TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`); } catch(e) { console.error('[DB] sms_config error:', e.message); }

// 단일 row 보장
try { db.exec(`INSERT OR IGNORE INTO sms_config (id) VALUES (1)`); } catch(e) {}

try { db.exec(`CREATE TABLE IF NOT EXISTS sms_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    competition_id INTEGER,
    athlete_id INTEGER,
    event_id INTEGER,
    heat_number INTEGER,
    phone_number TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',  -- pending|sent|failed|simulated
    provider TEXT NOT NULL DEFAULT 'aligo',
    provider_msg_id TEXT NOT NULL DEFAULT '',
    error_message TEXT NOT NULL DEFAULT '',
    cost INTEGER NOT NULL DEFAULT 0,         -- 원
    sent_at TEXT NOT NULL DEFAULT (datetime('now')),
    triggered_by TEXT NOT NULL DEFAULT ''    -- e.g. 'manual', 'cert_batch'
)`); } catch(e) { console.error('[DB] sms_log error:', e.message); }
// 기존 sms_log 에 event_id/heat_number 없으면 추가 (SQLite 멱등 마이그레이션 — 종목·조별 발송현황용)
try { db.exec(`ALTER TABLE sms_log ADD COLUMN event_id INTEGER`); } catch(e) {}
try { db.exec(`ALTER TABLE sms_log ADD COLUMN heat_number INTEGER`); } catch(e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_sms_log_comp ON sms_log(competition_id, sent_at DESC)`); } catch(e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_sms_log_athlete ON sms_log(athlete_id, sent_at DESC)`); } catch(e) {}
// ========== END SMS Schema ==========

// ========== Push(FCM 웹푸시) 토큰 ==========
try { db.exec(`CREATE TABLE IF NOT EXISTS push_token (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL UNIQUE,
    audience TEXT NOT NULL DEFAULT 'public',   -- 'public' | 'staff'
    competition_id INTEGER,
    user_agent TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`); } catch(e) { console.error('[DB] push_token error:', e.message); }
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_push_token_active ON push_token(active, audience)`); } catch(e) {}
// 관심 종목(즐겨찾기) — fav_key = '성별|종목명' (예: 'M|100m')
try { db.exec(`CREATE TABLE IF NOT EXISTS push_interest (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL,
    competition_id INTEGER,
    fav_key TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`); } catch(e) { console.error('[DB] push_interest error:', e.message); }
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_push_interest_lookup ON push_interest(competition_id, fav_key)`); } catch(e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_push_interest_token ON push_interest(token)`); } catch(e) {}
// ========== END Push Schema ==========

// ========== AUTH Phase 1: app_user / session_refresh / login_audit ==========
// (실제 호출은 SQLite-only 블록 종료 후 — 양쪽 백엔드에서 모두 실행되어야 함)
// 이 위치에서는 글로벌 상태 플래그만 선언.
global.__authMigError = null;
global.__authMigOk = false;


// Migrate existing numeric wind values to "N.N m/s" text format for scoreboard compatibility
// (SQLite 부팅 전용 마이그레이션 — PG 백엔드에서는 별도 마이그레이션 스크립트로 처리)
if (!db.isAsync) {
    try {
        const numericWindHeats = db.raw.prepare("SELECT id, wind FROM heat WHERE wind IS NOT NULL AND CAST(wind AS TEXT) NOT LIKE '% m/s'").all();
        if (numericWindHeats.length > 0) {
            const upd = db.raw.prepare('UPDATE heat SET wind=? WHERE id=?');
            const tx = db.raw.transaction(() => {
                for (const h of numericWindHeats) {
                    const v = parseFloat(h.wind);
                    if (!isNaN(v)) upd.run(v.toFixed(1) + ' m/s', h.id);
                }
            });
            tx();
            console.log(`[DB Migration] heat.wind: ${numericWindHeats.length}건 → "N.N m/s" 형식으로 변환`);
        }
    } catch(e) { console.error('[DB Migration] wind format migration error:', e.message); }
}

// (2026-09) 이 시드는 예전에 SQLite 전용 블록 안에 들어 있어 PG 에서는 기본 상장 양식이 생성되지 않았다 → 블록 밖으로 이동
// 기본 상장 템플릿 시드 (최초 1회) — 시상장 + 완주증
// SQLite/PostgreSQL 양쪽에서 동작하도록 통합 db API 사용 (비동기)
_bootTasks.push((async () => {
    try {
        const cntRow = await db.get('SELECT COUNT(*) AS c FROM certificate_template');
        const cnt = cntRow ? Number(cntRow.c) : 0;
        if (cnt === 0) {
            const now = new Date().toISOString();
            const INS_SQL = `INSERT INTO certificate_template (
                competition_id, name, kind, title_text, body_template, rank_label_style,
                signer_org, signer_title, signer_name,
                paper_orientation, show_record_value, show_athlete_team, show_date,
                background_color, border_style, font_family, is_default, sort_order,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            // 1) 기본 시상장 (ordinal: 우승/준우승/3위)
            await db.run(INS_SQL, null, '기본 시상장 (우승/준우승)', 'award', '상  장',
                '위 선수는 {competition_name}\n{event_name} 종목에서 {rank_label}을 차지하여\n그 우수한 성적을 인정하여 이 상장을 수여합니다.',
                'ordinal', '', '회장', '',
                'portrait', 1, 1, 1, '#fffdf6', 'double-gold', 'NanumSquare', 1, 1, now, now);
            // 2) 숫자형 시상장 (1위/2위/3위)
            await db.run(INS_SQL, null, '기본 시상장 (1위/2위/3위)', 'award', '상  장',
                '위 선수는 {competition_name}\n{event_name} 종목에서 {rank_label}을 차지하여\n그 우수한 성적을 인정하여 이 상장을 수여합니다.',
                'numeric', '', '회장', '',
                'portrait', 1, 1, 1, '#fffdf6', 'double-gold', 'NanumSquare', 0, 2, now, now);
            // 3) 완주증 (마스터즈 등 — 등수 없음)
            await db.run(INS_SQL, null, '완주증 (마스터즈용)', 'finisher', '완 주 증',
                '위 선수는 {competition_name} {event_name} 종목에 출전하여\n끝까지 완주하였기에 그 노력과 의지를 높이 평가하여\n이 증서를 수여합니다.',
                'ordinal', '', '회장', '',
                'portrait', 1, 1, 1, '#fffdf6', 'classic', 'NanumSquare', 0, 3, now, now);
            // 4) 단체상
            await db.run(INS_SQL, null, '단체상', 'team', '단 체 상',
                '위 단체는 {competition_name}에서 {rank_label}을 차지하여\n그 우수한 성적을 인정하여 이 상장을 수여합니다.',
                'ordinal', '', '회장', '',
                'portrait', 0, 0, 1, '#fffdf6', 'double-gold', 'NanumSquare', 0, 4, now, now);
            console.log('[DB] certificate_template seeded (4 templates)');
        }
    } catch(e) { console.error('[DB] certificate_template seed error:', e.message); }
})());
// Add heat_name to heat (custom display name, e.g. "준결1조", "A조")
try { db.exec(`ALTER TABLE heat ADD COLUMN heat_name TEXT DEFAULT NULL`); } catch(e) {}
// Add scoreboard_key to heat (전광판 매칭키, e.g. "남자실업부 100m 예선 1조")
try { db.exec(`ALTER TABLE heat ADD COLUMN scoreboard_key TEXT DEFAULT NULL`); } catch(e) {}
// Add sub_group to heat_entry (A/B group for 5000m/10000m etc.)
try { db.exec(`ALTER TABLE heat_entry ADD COLUMN sub_group TEXT DEFAULT NULL`); } catch(e) {}
// Add qualification_type to qualification_selection (Q or q)
try { db.exec(`ALTER TABLE qualification_selection ADD COLUMN qualification_type TEXT DEFAULT ''`); } catch(e) {}
// Add federation column to athlete (KTFL=실업, KUAF=대학)
try { db.exec(`ALTER TABLE athlete ADD COLUMN federation TEXT DEFAULT ''`); } catch(e) {}
// Add personal_best and date_of_birth columns to athlete (for PDF templates)
try { db.exec(`ALTER TABLE athlete ADD COLUMN personal_best TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE athlete ADD COLUMN date_of_birth TEXT DEFAULT ''`); } catch(e) {}
// Add callroom_memo to event_entry (소집실 메모)
try { db.exec(`ALTER TABLE event_entry ADD COLUMN callroom_memo TEXT DEFAULT ''`); } catch(e) {}
// Add manual_rank to event_entry (수직도약 순위결정전 등 동기록 시 수동 순위)
try { db.exec(`ALTER TABLE event_entry ADD COLUMN manual_rank INTEGER`); } catch(e) {}
// Add callroom_event_memo to event (소집실 종목 메모 — 인쇄 시 제목 하단에 표시)
try { db.exec(`ALTER TABLE event ADD COLUMN callroom_event_memo TEXT DEFAULT ''`); } catch(e) {}
// Add federation column to competition (KTFL=실업, KUAF=대학, ''=없음)
try { db.exec(`ALTER TABLE competition ADD COLUMN federation TEXT DEFAULT ''`); } catch(e) {}
// Add division_type column for E1 부(Division) hierarchy
// Values: '' (없음), 'pro' (실업부), 'univ' (대학부), 'high' (고등부), 'middle' (중등부), 'general' (일반부)
try { db.exec(`ALTER TABLE competition ADD COLUMN division_type TEXT DEFAULT ''`); } catch(e) {}
// Add video_url columns (migration)
try { db.exec(`ALTER TABLE competition ADD COLUMN video_url TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE event ADD COLUMN video_url TEXT DEFAULT ''`); } catch(e) {}
// Migrate old 'PASS' marks to '-' in height_attempt
try { db.exec(`UPDATE height_attempt SET result_mark='-' WHERE result_mark='PASS'`); } catch(e) {}
// Migration: Allow NULL bib_number and remove strict UNIQUE constraint
// (SQLite treats NULL as distinct in UNIQUE, so NULL bibs won't conflict)
// PG 모드에서는 schema.pg.sql이 이미 nullable 상태로 정의되어 있으므로 SQLite 전용.
if (!db.isAsync) try {
    const tableInfo = db.raw.prepare("PRAGMA table_info(athlete)").all();
    const bibCol = tableInfo.find(c => c.name === 'bib_number');
    if (bibCol && bibCol.notnull === 1) {
        // bib_number is currently NOT NULL — need to recreate table
        // Temporarily disable FK for table rebuild
        db.pragma('foreign_keys = OFF');
        db.exec(`DROP TABLE IF EXISTS athlete_new`);
        db.exec(`
            CREATE TABLE athlete_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                competition_id INTEGER NOT NULL REFERENCES competition(id),
                name TEXT NOT NULL,
                bib_number TEXT DEFAULT NULL,
                team TEXT NOT NULL DEFAULT '',
                barcode TEXT,
                gender TEXT NOT NULL CHECK(gender IN ('M','F')),
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                federation TEXT DEFAULT ''
            );
            INSERT INTO athlete_new (id, competition_id, name, bib_number, team, barcode, gender, created_at, federation)
                SELECT id, competition_id, name, CASE WHEN bib_number = '' THEN NULL ELSE bib_number END,
                    team, barcode, gender, created_at,
                    COALESCE(federation, '') FROM athlete;
            DROP TABLE athlete;
            ALTER TABLE athlete_new RENAME TO athlete;
        `);
        db.pragma('foreign_keys = ON');
        console.log('[Migration] athlete table: bib_number now allows NULL');
    } else {
        // Also convert empty strings to NULL for consistency
        db.exec(`UPDATE athlete SET bib_number = NULL WHERE bib_number = ''`);
    }
} catch(e) {
    console.error('[Migration] bib_number nullable:', e.message);
    try { db.pragma('foreign_keys = ON'); } catch(e2) {}
}
// Event Link table — 합동 종목 연결 (실업+대학 동시 진행 전광판)
try { db.exec(`CREATE TABLE IF NOT EXISTS event_link (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id_a INTEGER NOT NULL REFERENCES event(id) ON DELETE CASCADE,
    event_id_b INTEGER NOT NULL REFERENCES event(id) ON DELETE CASCADE,
    link_type TEXT NOT NULL DEFAULT 'joint_scoreboard',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(event_id_a, event_id_b)
)`); } catch(e) {}
// Add joint_scoreboard_key column to event_link (migration for existing DBs)
try { db.exec(`ALTER TABLE event_link ADD COLUMN joint_scoreboard_key TEXT DEFAULT NULL`); } catch(e) {}
// Backfill joint_scoreboard_key for existing links that don't have one
// (SQLite 전용 — 상위 if (!db.isAsync) 블록 내부이므로 db.raw 사용)
try {
    const linksNoKey = db.raw.prepare(`SELECT el.*, ea.name, ea.gender, ea.round_type, ea.competition_id
        FROM event_link el JOIN event ea ON ea.id = el.event_id_a
        WHERE el.joint_scoreboard_key IS NULL`).all();
    const updStmt = db.raw.prepare('UPDATE event_link SET joint_scoreboard_key=? WHERE id=?');
    for (const link of linksNoKey) {
        const genderLabel = { M: '남자', F: '여자', X: '혼성' }[link.gender] || '';
        const roundLabel = { preliminary: '예선', semifinal: '준결승', final: '결승' }[link.round_type] || link.round_type;
        const key = `합동 ${genderLabel} ${link.name} ${roundLabel}`;
        updStmt.run(key, link.id);
    }
    if (linksNoKey.length > 0) console.log(`[Migration] Backfilled ${linksNoKey.length} joint scoreboard keys`);
} catch(e) { console.error('[Migration] joint key backfill error:', e.message); }

// Joint Group tables — 합동 종목 그룹 (다중 대회 연결)
try { db.exec(`CREATE TABLE IF NOT EXISTS joint_group (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL DEFAULT '',
    joint_scoreboard_key TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`); } catch(e) {}
try { db.exec(`CREATE TABLE IF NOT EXISTS joint_group_member (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    joint_group_id INTEGER NOT NULL REFERENCES joint_group(id) ON DELETE CASCADE,
    event_id INTEGER NOT NULL REFERENCES event(id) ON DELETE CASCADE,
    competition_id INTEGER NOT NULL REFERENCES competition(id),
    sort_order INTEGER NOT NULL DEFAULT 0,
    UNIQUE(joint_group_id, event_id)
)`); } catch(e) {}

// Migration: convert existing event_link rows to joint_group (one-time)
// (SQLite 부팅 전용 마이그레이션 — PG 백엔드에서는 별도 마이그레이션 스크립트로 처리)
if (!db.isAsync) {
    try {
        const existingLinks = db.raw.prepare(`SELECT el.*, ea.name as event_name, ea.gender, ea.round_type, ea.competition_id as comp_a_id,
                eb.competition_id as comp_b_id
            FROM event_link el JOIN event ea ON ea.id=el.event_id_a JOIN event eb ON eb.id=el.event_id_b`).all();
        const migrateStmt = db.raw.prepare('SELECT COUNT(*) AS c FROM joint_group');
        const groupCount = migrateStmt.get().c;
        if (existingLinks.length > 0 && groupCount === 0) {
            const tx = db.raw.transaction(() => {
                for (const link of existingLinks) {
                    const key = link.joint_scoreboard_key || `합동 ${link.event_name}`;
                    const gInfo = db.raw.prepare('INSERT INTO joint_group (name, joint_scoreboard_key) VALUES (?, ?)').run(link.event_name, key);
                    db.raw.prepare('INSERT OR IGNORE INTO joint_group_member (joint_group_id, event_id, competition_id, sort_order) VALUES (?, ?, ?, 0)').run(gInfo.lastInsertRowid, link.event_id_a, link.comp_a_id);
                    db.raw.prepare('INSERT OR IGNORE INTO joint_group_member (joint_group_id, event_id, competition_id, sort_order) VALUES (?, ?, ?, 1)').run(gInfo.lastInsertRowid, link.event_id_b, link.comp_b_id);
                }
            });
            tx();
            console.log(`[Migration] Converted ${existingLinks.length} event_links to joint_groups`);
        }
    } catch(e) { console.error('[Migration] joint_group migration error:', e.message); }
}

// Pacing Light tables migration (ensure they exist in older DBs)
try { db.exec(`CREATE TABLE IF NOT EXISTS pacing_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    competition_id INTEGER NOT NULL REFERENCES competition(id),
    event_name TEXT NOT NULL,
    notice TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(competition_id, event_name)
)`); } catch(e) {}
try { db.exec(`CREATE TABLE IF NOT EXISTS pacing_color (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pacing_config_id INTEGER NOT NULL REFERENCES pacing_config(id) ON DELETE CASCADE,
    color_key TEXT NOT NULL CHECK(color_key IN ('green','red','white','blue')),
    sort_order INTEGER NOT NULL DEFAULT 0,
    remark TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(pacing_config_id, color_key)
)`); } catch(e) {}
try { db.exec(`CREATE TABLE IF NOT EXISTS pacing_segment (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pacing_color_id INTEGER NOT NULL REFERENCES pacing_color(id) ON DELETE CASCADE,
    segment_order INTEGER NOT NULL,
    distance_meters INTEGER NOT NULL,
    lap_seconds REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(pacing_color_id, segment_order)
)`); } catch(e) {}

// Federation list table (dynamic federation management)
try { db.exec(`CREATE TABLE IF NOT EXISTS federation_list (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    badge_bg TEXT NOT NULL DEFAULT '#e3f2fd',
    badge_color TEXT NOT NULL DEFAULT '#1565c0',
    sort_order INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`); } catch(e) {}
// 연맹 숨김: 1이면 홈·운영 화면의 대회 목록에서 그 연맹 대회 전체가 빠짐 (관리자 페이지에서만 보임)
try { db.exec(`ALTER TABLE federation_list ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0`); } catch(e) {}
// Add gender label columns to federation_list (전광판 성별 매핑)
try { db.exec(`ALTER TABLE federation_list ADD COLUMN gender_label_m TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE federation_list ADD COLUMN gender_label_f TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE federation_list ADD COLUMN gender_label_x TEXT DEFAULT ''`); } catch(e) {}
// Seed default federations if table is empty (SQLite 전용 — 상위 가드 블록 내부)
try {
    const fedCount = db.raw.prepare('SELECT COUNT(*) as cnt FROM federation_list').get().cnt;
    if (fedCount === 0) {
        db.exec(`INSERT INTO federation_list (code, name, badge_bg, badge_color, sort_order) VALUES
            ('KTFL', '한국실업육상연맹', '#e3f2fd', '#1565c0', 1),
            ('KUAF', '한국대학육상연맹', '#fce4ec', '#c62828', 2)`);
    }
} catch(e) {}

// Home popup tables (CMS for home page popups)
try { db.exec(`CREATE TABLE IF NOT EXISTS home_popup (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    popup_type TEXT NOT NULL DEFAULT 'public' CHECK(popup_type IN ('public','admin')),
    title TEXT NOT NULL DEFAULT '',
    subtitle TEXT NOT NULL DEFAULT '',
    intro_text TEXT NOT NULL DEFAULT '',
    bottom_btn_text TEXT NOT NULL DEFAULT '',
    bottom_btn_desc TEXT NOT NULL DEFAULT '',
    bottom_btn_link TEXT NOT NULL DEFAULT '',
    bottom_btn_active INTEGER NOT NULL DEFAULT 1,
    is_active INTEGER NOT NULL DEFAULT 1,
    show_from TEXT DEFAULT NULL,
    show_until TEXT DEFAULT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`); } catch(e) {}
// Add sort_order column to home_popup if missing (migration)
try { db.exec(`ALTER TABLE home_popup ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`); } catch(e) {}
// Add competition_id to home_popup (NULL = 공통/전체 노출, 특정 id = 그 대회 전용) — 대회별 팝업
try { db.exec(`ALTER TABLE home_popup ADD COLUMN competition_id INTEGER DEFAULT NULL`); } catch(e) {}
try { db.exec(`CREATE TABLE IF NOT EXISTS home_popup_section (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    popup_id INTEGER NOT NULL REFERENCES home_popup(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    link_btn_text TEXT NOT NULL DEFAULT '',
    link_btn_url TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`); } catch(e) {}

// ---- Performance: Database Indexes (AFTER all migrations) ----
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_event_competition ON event(competition_id)`); } catch(e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_event_parent ON event(parent_event_id)`); } catch(e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_event_comp_gender ON event(competition_id, gender)`); } catch(e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_athlete_competition ON athlete(competition_id)`); } catch(e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_athlete_comp_bib ON athlete(competition_id, bib_number)`); } catch(e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_athlete_comp_name ON athlete(competition_id, name)`); } catch(e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_event_entry_event ON event_entry(event_id)`); } catch(e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_event_entry_athlete ON event_entry(athlete_id)`); } catch(e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_heat_event ON heat(event_id)`); } catch(e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_heat_entry_heat ON heat_entry(heat_id)`); } catch(e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_heat_entry_event_entry ON heat_entry(event_entry_id)`); } catch(e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_result_heat ON result(heat_id)`); } catch(e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_result_event_entry ON result(event_entry_id)`); } catch(e) {}
// (2026-09) 트랙 기록(attempt_number IS NULL)의 중복 방지.
//   UNIQUE(heat_id, event_entry_id, attempt_number) 는 NULL 을 서로 다른 값으로 보기 때문에 트랙 기록에는 효력이 없었다 →
//   더블탭·가져오기와 수기 입력의 동시 요청이 같은 선수의 행을 2개 만들 수 있었고, 그러면 화면은 옛 행을 보여주고 수정은 새 행에 들어갔다.
//   기존 중복은 가장 최근 행(수정이 들어가던 행)만 남기고 정리한 뒤 부분 유니크 인덱스를 건다.
if (!db.isAsync) {
    try {
        const dup = db.raw.prepare(`SELECT COUNT(*) AS c FROM result WHERE attempt_number IS NULL AND id NOT IN (SELECT MAX(id) FROM result WHERE attempt_number IS NULL GROUP BY heat_id, event_entry_id)`).get();
        if (dup && dup.c > 0) {
            db.exec(`DELETE FROM result WHERE attempt_number IS NULL AND id NOT IN (SELECT MAX(id) FROM result WHERE attempt_number IS NULL GROUP BY heat_id, event_entry_id)`);
            console.warn(`[DB Migration] 트랙 기록 중복 ${dup.c}행 정리 (선수·조당 최신 1행 유지)`);
        }
        db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_result_no_attempt ON result(heat_id, event_entry_id) WHERE attempt_number IS NULL`);
    } catch (e) { console.warn('[DB Migration] ux_result_no_attempt 생성 실패:', e.message); }
}
// (2026-09) 계주 종목명 표기 통일: 저장값에 '4X100mR'(대문자 X)와 '4×800mR'(곱셈 기호)가 섞여 있었다 → 모두 '4X…mR'.
//   종목명이 들어간 전광판 키(heat.scoreboard_key)도 함께 바꾼다. 같은 대회에 두 표기가 모두 있으면(유니크 충돌) 그 행은 건너뛴다.
if (!db.isAsync) {
    try {
        const rows = db.raw.prepare("SELECT id, name FROM event WHERE name LIKE '%4×%'").all();
        let done = 0;
        for (const r of rows) {
            const to = r.name.replace(/4×/g, '4X');
            try {
                db.raw.prepare('UPDATE event SET name=? WHERE id=?').run(to, r.id);
                db.raw.prepare("UPDATE heat SET scoreboard_key=REPLACE(scoreboard_key, ?, ?) WHERE event_id=? AND scoreboard_key LIKE '%4×%'").run(r.name, to, r.id);
                done++;
            } catch (e) { console.warn(`[DB Migration] 계주 표기 통일 건너뜀 (event ${r.id} ${r.name}): ${e.message}`); }
        }
        if (done) console.log(`[DB Migration] 계주 종목명 표기 통일: ${done}건 (4× → 4X)`);
    } catch (e) { console.warn('[DB Migration] 계주 표기 통일 실패:', e.message); }
}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_height_attempt_heat ON height_attempt(heat_id)`); } catch(e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_combined_score_entry ON combined_score(event_entry_id)`); } catch(e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_relay_member_entry ON relay_member(event_entry_id)`); } catch(e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_log_comp ON audit_log(competition_id)`); } catch(e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_operation_log_comp ON operation_log(competition_id)`); } catch(e) {}
// Migration: audit_log에 IP/UA 컬럼 추가
try { db.exec(`ALTER TABLE audit_log ADD COLUMN ip_address TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE audit_log ADD COLUMN user_agent TEXT`); } catch(e) {}

// ============================================================
// 🔒 재업로드 중복 방지 — DB 레벨 UNIQUE 인덱스
// ============================================================
// 정책: 같은 대회 안에서 (종목명+성별+라운드) 조합은 단 하나만 존재.
//       sub-event(parent_event_id 있음)는 부모마다 같은 이름 가능하므로 partial index 사용.
//
// 주의: 기존 데이터에 이미 중복이 있으면 CREATE UNIQUE INDEX 가 실패하므로
//       try/catch 로 감싸고, 실패 시 startup log 에 경고만 출력. (사용자가 중복 정리 후 재시작하면 됨)
try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_event_top_level ON event(competition_id, name, gender, round_type) WHERE parent_event_id IS NULL`);
    console.log('[DB Migration] ux_event_top_level UNIQUE 인덱스 생성/확인');
} catch(e) {
    console.warn('[DB Migration] ux_event_top_level 생성 실패 — 기존 중복 종목이 있을 수 있음:', e.message);
    console.warn('  → 관리자: /api/admin/event-duplicates/cleanup 으로 정리 후 서버 재시작 필요');
}

// athlete 중복 방지: 같은 대회 안에서 (이름+소속+성별) 조합은 단 하나만 존재
// 동명이인이라도 소속이 다르거나 성별이 다르면 OK. 같은 소속·성별의 동명이인은 매우 드물고 운영 혼선 방지.
try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_athlete_per_competition ON athlete(competition_id, name, team, gender)`);
    console.log('[DB Migration] ux_athlete_per_competition UNIQUE 인덱스 생성/확인');
} catch(e) {
    console.warn('[DB Migration] ux_athlete_per_competition 생성 실패 — 기존 중복 선수가 있을 수 있음:', e.message);
}

// event_entry 는 이미 sqlite_autoindex_event_entry_1 (UNIQUE event_id, athlete_id) 존재
// — 스키마 정의에서 UNIQUE 제약. 별도 인덱스 불필요.

// ---- Display-mode (노출용) migrations ----
// competition.mode: 'operation' (운영용) | 'display' (노출용) | 'event' (행사용 화이트라벨)
try { db.exec(`ALTER TABLE competition ADD COLUMN mode TEXT NOT NULL DEFAULT 'operation'`); } catch(e) {}
// 행사(event) 화이트라벨: /e/<slug> 경로 + 브랜드 로고·워터마크·포인트색
try { db.exec(`ALTER TABLE competition ADD COLUMN event_slug TEXT NOT NULL DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE competition ADD COLUMN brand_logo_path TEXT NOT NULL DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE competition ADD COLUMN brand_watermark_path TEXT NOT NULL DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE competition ADD COLUMN brand_color_point TEXT NOT NULL DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE competition ADD COLUMN brand_color_accent TEXT NOT NULL DEFAULT ''`); } catch(e) {}
// 행사모드 노출 override: 'auto' 또는 쉼표목록(genders: 'M,F' / rounds: 'preliminary,final')
try { db.exec(`ALTER TABLE competition ADD COLUMN event_show_genders TEXT NOT NULL DEFAULT 'auto'`); } catch(e) {}
try { db.exec(`ALTER TABLE competition ADD COLUMN event_show_rounds TEXT NOT NULL DEFAULT 'auto'`); } catch(e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_competition_event_slug ON competition(event_slug)`); } catch(e) {}
// competition.home_visibility: 홈 노출 강제 설정 — 'auto'(±3일 윈도우) | 'pinned'(항상 상단 고정) | 'hidden'(홈에서 숨김)
try { db.exec(`ALTER TABLE competition ADD COLUMN home_visibility TEXT NOT NULL DEFAULT 'auto'`); } catch(e) {}
// competition.manual_status_lock: 관리자가 '대회 재개'로 수동 상태변경한 경우 1 — 날짜 기반 자동 상태갱신(active→completed)을 막아 재잠금을 방지
try { db.exec(`ALTER TABLE competition ADD COLUMN manual_status_lock INTEGER NOT NULL DEFAULT 0`); } catch(e) {}
// event.division: 중등부/고등부/대학부/일반부/국제/U20
try { db.exec(`ALTER TABLE event ADD COLUMN division TEXT NOT NULL DEFAULT ''`); } catch(e) {}
// event.result_url: 외부 결과 링크 URL (노출용 대회에서 사용)
try { db.exec(`ALTER TABLE event ADD COLUMN result_url TEXT DEFAULT ''`); } catch(e) {}
// Display roster table — 노출용 대회 명단 저장
try { db.exec(`CREATE TABLE IF NOT EXISTS display_roster (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    competition_id INTEGER NOT NULL REFERENCES competition(id),
    day INTEGER NOT NULL DEFAULT 1,
    event_name TEXT NOT NULL DEFAULT '',
    round TEXT NOT NULL DEFAULT '',
    division TEXT NOT NULL DEFAULT '',
    gender TEXT NOT NULL DEFAULT '',
    bib_number TEXT DEFAULT '',
    athlete_name TEXT NOT NULL DEFAULT '',
    team TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    event_id INTEGER DEFAULT NULL,
    heat INTEGER DEFAULT NULL,
    lane INTEGER DEFAULT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`); } catch(e) {}
// Add heat/lane columns if missing (for existing DBs)
try { db.exec(`ALTER TABLE display_roster ADD COLUMN heat INTEGER DEFAULT NULL`); } catch(e) {}
try { db.exec(`ALTER TABLE display_roster ADD COLUMN lane INTEGER DEFAULT NULL`); } catch(e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_display_roster_comp ON display_roster(competition_id)`); } catch(e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_display_roster_event ON display_roster(competition_id, event_id)`); } catch(e) {}

// ─────────────────────────────────────────────────────────────────
// EXTERNAL API KEY 시스템 (대한육상연맹 결과 URL 자동 수집용)
// ─────────────────────────────────────────────────────────────────
// external_api_key: 외부 시스템(OpenClaw 등)에서 PACE RISE에 결과 URL 등을
//   안전하게 등록하기 위한 API 키 저장 테이블
//
//   - key_hash: bcrypt 해시된 키 (평문은 발급 시점에만 보여줌, DB에 저장 X)
//   - key_prefix: 사용자가 키 식별 가능하도록 앞 8자리만 평문 저장 (예: "pkr_a1b2c3d4...")
//   - label: 키 용도 라벨 (예: "OpenClaw - 정선 2026")
//   - allowed_competition_id: NULL이면 모든 노출용 대회 허용, 값이 있으면 해당 대회만
//   - rate_limit_per_min: 분당 호출 제한
//   - expires_at: 만료 일시 (NULL이면 무기한)
//   - revoked_at: 회수 일시 (NULL이면 활성)
//   - last_used_at, total_calls: 사용 통계
try { db.exec(`CREATE TABLE IF NOT EXISTS external_api_key (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key_hash TEXT NOT NULL,
    key_prefix TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    allowed_competition_id INTEGER DEFAULT NULL REFERENCES competition(id) ON DELETE SET NULL,
    rate_limit_per_min INTEGER NOT NULL DEFAULT 60,
    expires_at TEXT DEFAULT NULL,
    revoked_at TEXT DEFAULT NULL,
    last_used_at TEXT DEFAULT NULL,
    total_calls INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by TEXT NOT NULL DEFAULT 'admin'
)`); } catch(e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_extkey_prefix ON external_api_key(key_prefix)`); } catch(e) {}

// external_api_log: 모든 외부 API 호출 기록 (성공/실패 모두)
try { db.exec(`CREATE TABLE IF NOT EXISTS external_api_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    api_key_id INTEGER DEFAULT NULL REFERENCES external_api_key(id) ON DELETE SET NULL,
    key_prefix TEXT DEFAULT '',
    endpoint TEXT NOT NULL DEFAULT '',
    method TEXT NOT NULL DEFAULT 'POST',
    request_ip TEXT DEFAULT '',
    user_agent TEXT DEFAULT '',
    competition_id INTEGER DEFAULT NULL,
    event_id INTEGER DEFAULT NULL,
    request_body TEXT DEFAULT '',
    response_status INTEGER NOT NULL DEFAULT 0,
    response_code TEXT DEFAULT '',
    duration_ms INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`); } catch(e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_extlog_keyid ON external_api_log(api_key_id, created_at)`); } catch(e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_extlog_created ON external_api_log(created_at)`); } catch(e) {}

// ─── Records Management v4 (NR/DR/CR 통합 모델) — SQLite 마이그레이션 ───
// division_master, competition_series, record_breaking_log: 새 테이블 (멱등 CREATE)
// event_record: 스키마 전체 교체 (구 데이터 0건 가정, 백업 후 drop)
try { db.exec(`CREATE TABLE IF NOT EXISTS division_master (
    code TEXT PRIMARY KEY,
    label_ko TEXT NOT NULL,
    gender TEXT NOT NULL CHECK(gender IN ('M','F','X')),
    school_level TEXT NOT NULL CHECK(school_level IN ('OPEN','ELEM','MID','HIGH','UNIV','GEN','MIXED')),
    sort_order INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`); } catch(e) {}
try { db.exec(`CREATE TABLE IF NOT EXISTS competition_series (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    federation TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`); } catch(e) {}
// event_record 스키마 전환: 구 스키마(division_code 컬럼 없음) 감지 시 백업 후 재생성
try {
    const cols = db.raw.prepare("PRAGMA table_info(event_record)").all();
    const hasNew = cols.some(c => c.name === 'division_code');
    if (cols.length > 0 && !hasNew) {
        const cnt = db.raw.prepare('SELECT COUNT(*) AS c FROM event_record').get();
        if (cnt && cnt.c > 0) {
            db.exec(`CREATE TABLE IF NOT EXISTS event_record_legacy_backup AS SELECT * FROM event_record`);
            console.log(`[DB Migration v4] event_record 구 데이터 ${cnt.c}건 → event_record_legacy_backup 으로 백업`);
        }
        db.exec(`DROP TABLE event_record`);
        console.log('[DB Migration v4] event_record 구 스키마 drop, 신 스키마로 재생성');
    }
} catch(e) {}
try { db.exec(`CREATE TABLE IF NOT EXISTS event_record (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    record_type TEXT NOT NULL CHECK(record_type IN ('national','division','competition')),
    event_name TEXT NOT NULL,
    gender TEXT NOT NULL CHECK(gender IN ('M','F','X')),
    division_code TEXT REFERENCES division_master(code),
    series_id INTEGER REFERENCES competition_series(id),
    record_value TEXT NOT NULL DEFAULT '',
    record_value_num REAL,
    holder_name TEXT NOT NULL DEFAULT '',
    holder_team TEXT NOT NULL DEFAULT '',
    record_year TEXT NOT NULL DEFAULT '',
    record_date TEXT NOT NULL DEFAULT '',
    venue TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    approved INTEGER NOT NULL DEFAULT 1,
    approved_at TEXT,
    approved_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(record_type, event_name, gender, division_code, series_id)
)`); } catch(e) {}
try { db.exec(`CREATE TABLE IF NOT EXISTS record_breaking_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    competition_id INTEGER NOT NULL REFERENCES competition(id),
    event_id INTEGER REFERENCES event(id),
    event_entry_id INTEGER REFERENCES event_entry(id),
    record_type TEXT NOT NULL CHECK(record_type IN ('national','division','competition')),
    event_name TEXT NOT NULL,
    gender TEXT NOT NULL,
    division_code TEXT,
    series_id INTEGER,
    previous_record_id INTEGER REFERENCES event_record(id),
    previous_value TEXT NOT NULL DEFAULT '',
    new_value TEXT NOT NULL DEFAULT '',
    new_value_num REAL,
    athlete_name TEXT NOT NULL DEFAULT '',
    athlete_team TEXT NOT NULL DEFAULT '',
    bib_number TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
    detected_at TEXT NOT NULL DEFAULT (datetime('now')),
    reviewed_at TEXT,
    reviewed_by TEXT,
    review_note TEXT NOT NULL DEFAULT ''
)`); } catch(e) {}
// competition.series_id: 대회 ↔ 시리즈 연결
try { db.exec(`ALTER TABLE competition ADD COLUMN series_id INTEGER REFERENCES competition_series(id)`); } catch(e) {}
// division_master 시드 13행 (멱등)
try {
    const seedRows = [
        ['M_ELEM','남자초등부','M','ELEM',10],
        ['M_MID','남자중학부','M','MID',20],
        ['M_HIGH','남자고등부','M','HIGH',30],
        ['M_UNIV','남자대학부','M','UNIV',40],
        ['M_GEN','남자일반부','M','GEN',50],
        ['M_OPEN','남자공개부','M','OPEN',60],
        ['F_ELEM','여자초등부','F','ELEM',110],
        ['F_MID','여자중학부','F','MID',120],
        ['F_HIGH','여자고등부','F','HIGH',130],
        ['F_UNIV','여자대학부','F','UNIV',140],
        ['F_GEN','여자일반부','F','GEN',150],
        ['F_OPEN','여자공개부','F','OPEN',160],
        ['MIXED','통합부','X','MIXED',900],
    ];
    const ins = db.raw.prepare(`INSERT OR IGNORE INTO division_master (code,label_ko,gender,school_level,sort_order) VALUES (?,?,?,?,?)`);
    const tx = db.raw.transaction(() => { for (const r of seedRows) ins.run(...r); });
    tx();
} catch(e) { console.error('[DB Migration v4] division_master seed error:', e.message); }
// Indexes for record-related queries
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_event_record_lookup ON event_record(event_name, gender, record_type)`); } catch(e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_event_record_division ON event_record(division_code, event_name, gender)`); } catch(e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_event_record_series ON event_record(series_id, event_name, gender)`); } catch(e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_record_breaking_status ON record_breaking_log(status, detected_at)`); } catch(e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_record_breaking_comp ON record_breaking_log(competition_id, status)`); } catch(e) {}

} // end if (!db.isAsync) — SQLite-only 부트 마이그레이션 블록 종료

// ========== AUTH Phase 1: app_user / session_refresh / login_audit ==========
// ⚠️ 이 블록은 SQLite + PostgreSQL 양쪽 모두에서 실행되어야 한다.
// (이전 버그: SQLite-only 블록 안쪽에 있어서 PG 모드에서 통째로 스킵되었음
//   → JWT 로그인 시 'relation "app_user" does not exist' 42P01)
//
// 실패 처리:
//   - 부팅 자체는 막지 않음 (legacy 로그인은 여전히 동작해야 하므로)
//   - 글로벌 플래그 global.__authMigOk / __authMigError 로 상태 보관
//   - 진단/복구는 /api/_diag/auth-state, /api/_diag/auth-init 으로 가능
_bootTasks.push((async () => {
    try {
        const { runAuthMigrations } = require('./lib/auth/migrations');
        await runAuthMigrations(db);
        global.__authMigOk = true;
        console.log('[auth-mig] OK — app_user/session_refresh/login_audit ready (backend=' + (db.isAsync ? 'postgres' : 'sqlite') + ')');
    } catch (e) {
        global.__authMigError = String(e && e.message || e);
        // PG의 경우 e.code / e.detail / e.query 도 함께 남김 — 진단 편의
        const extras = [];
        if (e && e.code) extras.push(`code=${e.code}`);
        if (e && e.detail) extras.push(`detail=${e.detail}`);
        console.error('[auth-mig] FATAL — JWT 로그인이 불가능한 상태입니다:', e.message, extras.join(' '));
        if (e && e.query) console.error('[auth-mig] failing query:', String(e.query).substring(0, 500));
    }
})());

// ─── Records Management v4 — PostgreSQL 마이그레이션 (비동기, idempotent) ───
// PG 모드에서는 schema.pg.sql 을 운영자가 한 번 실행하지만, 새 테이블/컬럼이
// 누락된 기존 DB에 대비해 boot 시 멱등 마이그레이션을 시도한다.
if (db.isAsync) {
    _bootTasks.push((async () => {
        try {
            await db.run(`CREATE TABLE IF NOT EXISTS division_master (
                code TEXT PRIMARY KEY,
                label_ko TEXT NOT NULL,
                gender TEXT NOT NULL CHECK(gender IN ('M','F','X')),
                school_level TEXT NOT NULL CHECK(school_level IN ('OPEN','ELEM','MID','HIGH','UNIV','GEN','MIXED')),
                sort_order BIGINT NOT NULL DEFAULT 0,
                active BIGINT NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT NOW()
            )`);
            await db.run(`CREATE TABLE IF NOT EXISTS competition_series (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                federation TEXT NOT NULL DEFAULT '',
                description TEXT NOT NULL DEFAULT '',
                active BIGINT NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT NOW(),
                updated_at TEXT NOT NULL DEFAULT NOW()
            )`);
            // event_record 스키마 전환 (구 스키마 감지: division_code 컬럼 없음)
            const hasNew = await db.get(`SELECT 1 FROM information_schema.columns
                WHERE table_schema = current_schema() AND table_name = 'event_record' AND column_name = 'division_code'`);
            if (!hasNew) {
                const cnt = await db.get(`SELECT COUNT(*)::int AS c FROM event_record`).catch(() => null);
                if (cnt && cnt.c > 0) {
                    await db.run(`CREATE TABLE IF NOT EXISTS event_record_legacy_backup AS SELECT * FROM event_record`);
                    console.log(`[DB Migration v4 PG] event_record 구 데이터 ${cnt.c}건 → event_record_legacy_backup 으로 백업`);
                }
                await db.run(`DROP TABLE IF EXISTS event_record CASCADE`);
                console.log('[DB Migration v4 PG] event_record 구 스키마 drop');
            }
            await db.run(`CREATE TABLE IF NOT EXISTS event_record (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                record_type TEXT NOT NULL CHECK(record_type IN ('national','division','competition')),
                event_name TEXT NOT NULL,
                gender TEXT NOT NULL CHECK(gender IN ('M','F','X')),
                division_code TEXT,
                series_id BIGINT,
                record_value TEXT NOT NULL DEFAULT '',
                record_value_num DOUBLE PRECISION,
                holder_name TEXT NOT NULL DEFAULT '',
                holder_team TEXT NOT NULL DEFAULT '',
                record_year TEXT NOT NULL DEFAULT '',
                record_date TEXT NOT NULL DEFAULT '',
                venue TEXT NOT NULL DEFAULT '',
                note TEXT NOT NULL DEFAULT '',
                approved BIGINT NOT NULL DEFAULT 1,
                approved_at TEXT,
                approved_by TEXT,
                created_at TEXT NOT NULL DEFAULT NOW(),
                updated_at TEXT NOT NULL DEFAULT NOW(),
                CONSTRAINT event_record_unique_v4 UNIQUE (record_type, event_name, gender, division_code, series_id)
            )`);
            await db.run(`CREATE TABLE IF NOT EXISTS record_breaking_log (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                competition_id BIGINT NOT NULL,
                event_id BIGINT,
                event_entry_id BIGINT,
                record_type TEXT NOT NULL CHECK(record_type IN ('national','division','competition')),
                event_name TEXT NOT NULL,
                gender TEXT NOT NULL,
                division_code TEXT,
                series_id BIGINT,
                previous_record_id BIGINT,
                previous_value TEXT NOT NULL DEFAULT '',
                new_value TEXT NOT NULL DEFAULT '',
                new_value_num DOUBLE PRECISION,
                athlete_name TEXT NOT NULL DEFAULT '',
                athlete_team TEXT NOT NULL DEFAULT '',
                bib_number TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
                detected_at TEXT NOT NULL DEFAULT NOW(),
                reviewed_at TEXT,
                reviewed_by TEXT,
                review_note TEXT NOT NULL DEFAULT ''
            )`);
            // competition.series_id 추가 (멱등)
            try { await db.run(`ALTER TABLE competition ADD COLUMN IF NOT EXISTS series_id BIGINT`); } catch(e) {}
            // competition.manual_status_lock 추가 (멱등) — '대회 재개' 수동 상태변경 보호 플래그
            try { await db.run(`ALTER TABLE competition ADD COLUMN IF NOT EXISTS manual_status_lock INTEGER NOT NULL DEFAULT 0`); } catch(e) {}
            // home_popup.competition_id 추가 (멱등) — 대회별 공지 팝업 (NULL=공통). schema.pg.sql 누락분 보정
            try { await db.run(`ALTER TABLE home_popup ADD COLUMN IF NOT EXISTS competition_id BIGINT`); } catch(e) {}
            // Seed division_master (13 rows, idempotent)
            const seedRows = [
                ['M_ELEM','남자초등부','M','ELEM',10],['M_MID','남자중학부','M','MID',20],
                ['M_HIGH','남자고등부','M','HIGH',30],['M_UNIV','남자대학부','M','UNIV',40],
                ['M_GEN','남자일반부','M','GEN',50],['M_OPEN','남자공개부','M','OPEN',60],
                ['F_ELEM','여자초등부','F','ELEM',110],['F_MID','여자중학부','F','MID',120],
                ['F_HIGH','여자고등부','F','HIGH',130],['F_UNIV','여자대학부','F','UNIV',140],
                ['F_GEN','여자일반부','F','GEN',150],['F_OPEN','여자공개부','F','OPEN',160],
                ['MIXED','통합부','X','MIXED',900],
            ];
            let seedOk = 0, seedFail = 0, firstErr = null;
            for (const r of seedRows) {
                try {
                    await db.run(`INSERT INTO division_master (code,label_ko,gender,school_level,sort_order) VALUES (?,?,?,?,?) ON CONFLICT (code) DO NOTHING`, ...r);
                    seedOk++;
                } catch(e) { seedFail++; if (!firstErr) firstErr = e.message; }
            }
            const dmCnt = await db.get('SELECT COUNT(*)::int AS c FROM division_master').catch(() => ({ c: -1 }));
            console.log(`[DB Migration v4 PG] division_master seed: ${seedOk} ok, ${seedFail} fail, total rows=${dmCnt.c}` + (firstErr ? ` (first error: ${firstErr})` : ''));
            // Indexes
            try { await db.run(`CREATE INDEX IF NOT EXISTS idx_event_record_lookup ON event_record(event_name, gender, record_type)`); } catch(e) {}
            try { await db.run(`CREATE INDEX IF NOT EXISTS idx_event_record_division ON event_record(division_code, event_name, gender)`); } catch(e) {}
            try { await db.run(`CREATE INDEX IF NOT EXISTS idx_event_record_series ON event_record(series_id, event_name, gender)`); } catch(e) {}
            try { await db.run(`CREATE INDEX IF NOT EXISTS idx_record_breaking_status ON record_breaking_log(status, detected_at)`); } catch(e) {}
            try { await db.run(`CREATE INDEX IF NOT EXISTS idx_record_breaking_comp ON record_breaking_log(competition_id, status)`); } catch(e) {}
            console.log('[DB Migration v4 PG] records management tables ready');

            // ============================================================
            // 상장(Certificate) + 문자(SMS) 시스템 — PG 멱등 생성
            // (SQLite 부트 블록 server.js:467~545 의 PG 포팅. schema.pg.sql 누락 대비)
            // ============================================================
            try { await db.run(`CREATE TABLE IF NOT EXISTS certificate_template (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                competition_id BIGINT,
                name TEXT NOT NULL,
                kind TEXT NOT NULL DEFAULT 'award',
                title_text TEXT NOT NULL DEFAULT '상  장',
                body_template TEXT NOT NULL,
                rank_label_style TEXT NOT NULL DEFAULT 'ordinal',
                signer_org TEXT NOT NULL DEFAULT '',
                signer_title TEXT NOT NULL DEFAULT '회장',
                signer_name TEXT NOT NULL DEFAULT '',
                logo_left_path TEXT NOT NULL DEFAULT '',
                logo_right_path TEXT NOT NULL DEFAULT '',
                seal_image_path TEXT NOT NULL DEFAULT '',
                paper_orientation TEXT NOT NULL DEFAULT 'portrait',
                show_record_value BIGINT NOT NULL DEFAULT 1,
                show_athlete_team BIGINT NOT NULL DEFAULT 1,
                show_date BIGINT NOT NULL DEFAULT 1,
                background_color TEXT NOT NULL DEFAULT '#fffdf6',
                border_style TEXT NOT NULL DEFAULT 'double-gold',
                font_family TEXT NOT NULL DEFAULT 'NanumSquare',
                is_default BIGINT NOT NULL DEFAULT 0,
                sort_order BIGINT NOT NULL DEFAULT 0,
                watermark_image_path TEXT NOT NULL DEFAULT '',
                watermark_opacity DOUBLE PRECISION NOT NULL DEFAULT 0.07,
                watermark_scale DOUBLE PRECISION NOT NULL DEFAULT 0.45,
                border_color TEXT NOT NULL DEFAULT '#b8945a',
                panel_color TEXT NOT NULL DEFAULT '#faf8f2',
                text_color TEXT NOT NULL DEFAULT '#1a1a1a',
                label_color TEXT NOT NULL DEFAULT '#8a7f6a',
                accent_color TEXT NOT NULL DEFAULT '#7a3a00',
                panel_opacity DOUBLE PRECISION NOT NULL DEFAULT 1.0,
                created_at TEXT NOT NULL DEFAULT NOW(),
                updated_at TEXT NOT NULL DEFAULT NOW()
            )`); } catch(e) { console.error('[PG migration] certificate_template error:', e.message); }

            try { await db.run(`CREATE TABLE IF NOT EXISTS certificate_issue_log (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                competition_id BIGINT NOT NULL,
                template_id BIGINT NOT NULL,
                event_id BIGINT,
                athlete_id BIGINT NOT NULL,
                rank_value BIGINT,
                record_value TEXT NOT NULL DEFAULT '',
                issued_at TEXT NOT NULL DEFAULT NOW(),
                issued_by TEXT NOT NULL DEFAULT '',
                note TEXT NOT NULL DEFAULT ''
            )`); } catch(e) { console.error('[PG migration] certificate_issue_log error:', e.message); }
            try { await db.run(`CREATE INDEX IF NOT EXISTS idx_cert_log_comp ON certificate_issue_log(competition_id, issued_at DESC)`); } catch(e) {}

            try { await db.run(`CREATE TABLE IF NOT EXISTS sms_config (
                id BIGINT PRIMARY KEY CHECK (id = 1),
                provider TEXT NOT NULL DEFAULT 'aligo',
                api_key TEXT NOT NULL DEFAULT '',
                user_id TEXT NOT NULL DEFAULT '',
                sender_number TEXT NOT NULL DEFAULT '',
                sender_name TEXT NOT NULL DEFAULT '',
                sim_mode BIGINT NOT NULL DEFAULT 1,
                default_template TEXT NOT NULL DEFAULT '안녕하세요 {athlete_name}님,\n{competition_name} {event_name} 결과:\n{rank_label} {record_value}\n상장 다운로드: {cert_url}',
                monthly_quota BIGINT NOT NULL DEFAULT 0,
                sent_this_month BIGINT NOT NULL DEFAULT 0,
                last_reset_month TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT NOW()
            )`); } catch(e) { console.error('[PG migration] sms_config error:', e.message); }
            // 단일 row 보장
            try { await db.run(`INSERT INTO sms_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING`); } catch(e) {}

            try { await db.run(`CREATE TABLE IF NOT EXISTS sms_log (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                competition_id BIGINT,
                athlete_id BIGINT,
                event_id BIGINT,
                heat_number BIGINT,
                phone_number TEXT NOT NULL,
                message TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                provider TEXT NOT NULL DEFAULT 'aligo',
                provider_msg_id TEXT NOT NULL DEFAULT '',
                error_message TEXT NOT NULL DEFAULT '',
                cost BIGINT NOT NULL DEFAULT 0,
                sent_at TEXT NOT NULL DEFAULT NOW(),
                triggered_by TEXT NOT NULL DEFAULT ''
            )`); } catch(e) { console.error('[PG migration] sms_log error:', e.message); }
            // sms_log.event_id/heat_number 추가 (멱등) — 종목·조별 발송현황용. schema.pg.sql 누락분 보정
            try { await db.run(`ALTER TABLE sms_log ADD COLUMN IF NOT EXISTS event_id BIGINT`); } catch(e) {}
            try { await db.run(`ALTER TABLE sms_log ADD COLUMN IF NOT EXISTS heat_number BIGINT`); } catch(e) {}
            try { await db.run(`CREATE INDEX IF NOT EXISTS idx_sms_log_comp ON sms_log(competition_id, sent_at DESC)`); } catch(e) {}
            try { await db.run(`CREATE INDEX IF NOT EXISTS idx_sms_log_athlete ON sms_log(athlete_id, sent_at DESC)`); } catch(e) {}

            try { await db.run(`CREATE TABLE IF NOT EXISTS push_token (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                token TEXT NOT NULL UNIQUE,
                audience TEXT NOT NULL DEFAULT 'public',
                competition_id BIGINT,
                user_agent TEXT NOT NULL DEFAULT '',
                active BIGINT NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT NOW(),
                updated_at TEXT NOT NULL DEFAULT NOW()
            )`); } catch(e) { console.error('[PG migration] push_token error:', e.message); }
            try { await db.run(`CREATE INDEX IF NOT EXISTS idx_push_token_active ON push_token(active, audience)`); } catch(e) {}
            try { await db.run(`CREATE TABLE IF NOT EXISTS push_interest (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                token TEXT NOT NULL,
                competition_id BIGINT,
                fav_key TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT NOW()
            )`); } catch(e) { console.error('[PG migration] push_interest error:', e.message); }
            try { await db.run(`CREATE INDEX IF NOT EXISTS idx_push_interest_lookup ON push_interest(competition_id, fav_key)`); } catch(e) {}
            try { await db.run(`CREATE INDEX IF NOT EXISTS idx_push_interest_token ON push_interest(token)`); } catch(e) {}
            console.log('[DB Migration v4 PG] certificate/sms/push tables ready');
        } catch (e) {
            console.error('[DB Migration v4 PG] error:', e.message);
        }

        // ─── 운영 PG 호환 멱등 컬럼 마이그레이션 (혼성/필드 NM·DNF 표시 핵심) ───
        // 배경: schema.pg.sql 은 새로 배포할 때만 실행됨. 기존 운영 PG DB에는
        //       result/combined_score/height_attempt 등에 새 컬럼이 누락돼 있을 수 있다.
        //       /api/combined-scores/sync 의 UPSERT 가 status_code 컬럼 부재로 500 을 내는
        //       문제가 보고됨 → 부팅 시 idempotent 하게 ADD COLUMN 시도.
        // PostgreSQL 9.6+ : ADD COLUMN IF NOT EXISTS 지원. 안전을 위해 try/catch 로 래핑.
        const pgIdempotentAddCol = async (table, col, def) => {
            try {
                await db.run(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "${col}" ${def}`);
            } catch (e) {
                console.warn(`[PG migration] ${table}.${col} skipped: ${e.message}`);
            }
        };
        try {
            // combined_score: 종합기록지 NM/DNF/DNS/DQ 표시용 (← 사용자 보고 핵심 누락 컬럼)
            await pgIdempotentAddCol('combined_score', 'status_code', `TEXT DEFAULT ''`);
            // result: 트랙 종목 NM/DNF/DNS/DQ + 풍속 + remark
            await pgIdempotentAddCol('result', 'status_code', `TEXT DEFAULT ''`);
            await pgIdempotentAddCol('result', 'remark', `TEXT DEFAULT ''`);
            await pgIdempotentAddCol('result', 'wind', `DOUBLE PRECISION DEFAULT NULL`);
            // heat: 풍속 + heat_name + scoreboard_key
            await pgIdempotentAddCol('heat', 'wind', `DOUBLE PRECISION DEFAULT NULL`);
            await pgIdempotentAddCol('heat', 'heat_name', `TEXT DEFAULT NULL`);
            await pgIdempotentAddCol('heat', 'scoreboard_key', `TEXT DEFAULT NULL`);
            // height_attempt: 오프라인 충돌 감지용 updated_at
            await pgIdempotentAddCol('height_attempt', 'updated_at', `TEXT NOT NULL DEFAULT NOW()`);
            // heat_entry: sub_group
            await pgIdempotentAddCol('heat_entry', 'sub_group', `TEXT DEFAULT NULL`);
            // event_entry: callroom_memo
            await pgIdempotentAddCol('event_entry', 'callroom_memo', `TEXT DEFAULT ''`);
            await pgIdempotentAddCol('event_entry', 'manual_rank', `INTEGER`);
            // event: callroom_event_memo, video_url
            await pgIdempotentAddCol('event', 'callroom_event_memo', `TEXT DEFAULT ''`);
            await pgIdempotentAddCol('event', 'video_url', `TEXT DEFAULT ''`);
            // competition: federation, division_type, video_url
            await pgIdempotentAddCol('competition', 'federation', `TEXT DEFAULT ''`);
            await pgIdempotentAddCol('competition', 'division_type', `TEXT DEFAULT ''`);
            await pgIdempotentAddCol('competition', 'video_url', `TEXT DEFAULT ''`);
            // competition: 행사(event) 화이트라벨 — slug + 브랜드 로고/워터마크/색
            await pgIdempotentAddCol('competition', 'event_slug', `TEXT NOT NULL DEFAULT ''`);
            await pgIdempotentAddCol('competition', 'brand_logo_path', `TEXT NOT NULL DEFAULT ''`);
            await pgIdempotentAddCol('competition', 'brand_watermark_path', `TEXT NOT NULL DEFAULT ''`);
            await pgIdempotentAddCol('competition', 'brand_color_point', `TEXT NOT NULL DEFAULT ''`);
            await pgIdempotentAddCol('competition', 'brand_color_accent', `TEXT NOT NULL DEFAULT ''`);
            await pgIdempotentAddCol('competition', 'event_show_genders', `TEXT NOT NULL DEFAULT 'auto'`);
            await pgIdempotentAddCol('competition', 'event_show_rounds', `TEXT NOT NULL DEFAULT 'auto'`);
            try { await db.run(`CREATE INDEX IF NOT EXISTS idx_competition_event_slug ON competition(event_slug)`); } catch(e) {}
            // competition: 홈 노출 강제 설정 (auto | pinned | hidden)
            await pgIdempotentAddCol('competition', 'home_visibility', `TEXT NOT NULL DEFAULT 'auto'`);
            // federation_list: 연맹 숨김 (홈·운영 화면 목록에서 소속 대회 전체 제외)
            await pgIdempotentAddCol('federation_list', 'hidden', `BIGINT NOT NULL DEFAULT 0`);
            // athlete: federation, personal_best, date_of_birth, phone(SMS 발송용)
            await pgIdempotentAddCol('athlete', 'federation', `TEXT DEFAULT ''`);
            await pgIdempotentAddCol('athlete', 'personal_best', `TEXT DEFAULT ''`);
            await pgIdempotentAddCol('athlete', 'date_of_birth', `TEXT DEFAULT ''`);
            await pgIdempotentAddCol('athlete', 'phone', `TEXT NOT NULL DEFAULT ''`);
            // certificate_template: 워터마크 (중앙 로고 이미지)
            await pgIdempotentAddCol('certificate_template', 'watermark_image_path', `TEXT NOT NULL DEFAULT ''`);
            await pgIdempotentAddCol('certificate_template', 'watermark_opacity', `DOUBLE PRECISION NOT NULL DEFAULT 0.07`);
            await pgIdempotentAddCol('certificate_template', 'watermark_scale', `DOUBLE PRECISION NOT NULL DEFAULT 0.45`);
            await pgIdempotentAddCol('certificate_template', 'border_color', `TEXT NOT NULL DEFAULT '#b8945a'`);
            await pgIdempotentAddCol('certificate_template', 'panel_color', `TEXT NOT NULL DEFAULT '#faf8f2'`);
            await pgIdempotentAddCol('certificate_template', 'text_color', `TEXT NOT NULL DEFAULT '#1a1a1a'`);
            await pgIdempotentAddCol('certificate_template', 'label_color', `TEXT NOT NULL DEFAULT '#8a7f6a'`);
            await pgIdempotentAddCol('certificate_template', 'accent_color', `TEXT NOT NULL DEFAULT '#7a3a00'`);
            await pgIdempotentAddCol('certificate_template', 'panel_opacity', `DOUBLE PRECISION NOT NULL DEFAULT 1.0`);
            // qualification_selection: qualification_type
            await pgIdempotentAddCol('qualification_selection', 'qualification_type', `TEXT DEFAULT ''`);
            // record_breaking_log: wind
            await pgIdempotentAddCol('record_breaking_log', 'wind', `DOUBLE PRECISION DEFAULT NULL`);
            // event_link: joint_scoreboard_key
            await pgIdempotentAddCol('event_link', 'joint_scoreboard_key', `TEXT DEFAULT NULL`);
            // operation_key: can_manage
            await pgIdempotentAddCol('operation_key', 'can_manage', `BIGINT NOT NULL DEFAULT 0`);
            await pgIdempotentAddCol('operation_key', 'key_prefix', `TEXT DEFAULT ''`);
            await pgIdempotentAddCol('operation_key', 'key_hint', `TEXT DEFAULT ''`);
            await pgIdempotentAddCol('doc_template', 'comprehensive', `TEXT DEFAULT '{}'`);
            await pgIdempotentAddCol('heat', 'wind_updated_at', `TEXT DEFAULT NULL`);
            await pgIdempotentAddCol('event_entry', 'status_updated_at', `TEXT DEFAULT NULL`);
            console.log('[PG migration] idempotent column migrations complete (combined_score.status_code 등)');
        } catch (e) {
            console.error('[PG migration] idempotent column migrations error:', e.message);
        }
    })());
}

// ─── system_config 메모리 캐시 (Phase 2-G-2-extra-3b-1) ───────────────
// 목적: getConfigKey/setConfigKey 를 sync 유지하되 DB query는 제거.
//   - ACCESS_KEYS proxy / ADMIN_ID() 가 매 request마다 DB 히트하던 문제 해결
//   - boot 시 1회 sync 로드(SQLite) 또는 비동기 로드(PG)
//   - setConfigKey 는 캐시 + DB write (SQLite raw sync / PG async — 별도 PG boot 스크립트에서 처리)
const _configCache = new Map();
function _loadConfigCacheSync() {
    if (db.isAsync) return; // PG: _loadConfigCacheAsync 가 별도 처리
    try {
        const rows = db.raw.prepare('SELECT key, value FROM system_config').all();
        for (const r of rows) _configCache.set(r.key, r.value);
    } catch (e) {
        console.error('[config-cache] sync load failed:', e.message);
    }
}
async function _loadConfigCacheAsync() {
    try {
        const rows = await db.all('SELECT key, value FROM system_config');
        _configCache.clear();
        for (const r of rows) _configCache.set(r.key, r.value);
    } catch (e) {
        console.error('[config-cache] async load failed:', e.message);
    }
}
function getConfigKey(k, def) {
    if (_configCache.has(k)) return _configCache.get(k);
    return def;
}
function setConfigKey(k, v) {
    _configCache.set(k, v);
    if (!db.isAsync) {
        // SQLite: sync write via raw API
        db.raw.prepare('INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)').run(k, v);
    } else {
        // PG: fire-and-forget async write — 캐시는 즉시 갱신, DB는 백그라운드
        db.run('INSERT INTO system_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value', k, v)
            .catch(e => console.error('[setConfigKey] async write failed:', e.message));
    }
}
// 캐시 로드 (SQLite boot 시점)
if (!db.isAsync) {
    _loadConfigCacheSync();
}
// Initialize default admin account if not in system_config (bcrypt hashed)
if (!db.isAsync && !db.raw.prepare("SELECT 1 FROM system_config WHERE key='admin_id'").get()) {
    setConfigKey('admin_id', process.env.ADMIN_ID || 'admin');
    setConfigKey('admin_pw', bcrypt.hashSync(process.env.ADMIN_PW || 'changeme', 10));
}
// Migrate: if existing admin_pw is plaintext (not bcrypt hash), hash it
if (!db.isAsync) {
    const existingPw = getConfigKey('admin_pw', '');
    if (existingPw && !existingPw.startsWith('$2a$') && !existingPw.startsWith('$2b$')) {
        setConfigKey('admin_pw', bcrypt.hashSync(existingPw, 10));
    }
}
// Legacy compat: also store operation key in DB
if (!db.isAsync && !db.raw.prepare("SELECT 1 FROM system_config WHERE key='operation_key'").get()) {
    setConfigKey('operation_key', process.env.OPERATION_KEY || '1234');
}
// 기록위원 전용 키 (Phase C 확장): 신기록 승인/거부만 전담하는 운영 역할.
// - 빈 문자열이면 비활성 (admin만 승인 가능)
// - 설정 시 4자 이상 임의 문자열. admin/operation과 별개.
if (!db.isAsync && !db.raw.prepare("SELECT 1 FROM system_config WHERE key='record_officer_key'").get()) {
    setConfigKey('record_officer_key', process.env.RECORD_OFFICER_KEY || '');
}

const ACCESS_KEYS = {
    get operation() { return getConfigKey('operation_key', '1234'); },
    set operation(v) { setConfigKey('operation_key', v); },
    get adminHash() { return getConfigKey('admin_pw', ''); },
    set admin(v) { setConfigKey('admin_pw', bcrypt.hashSync(v, 10)); },
    get recordOfficer() { return getConfigKey('record_officer_key', ''); },
    set recordOfficer(v) { setConfigKey('record_officer_key', v || ''); },
};
const ADMIN_ID = () => getConfigKey('admin_id', 'admin');

// ─── operation_key 메모리 캐시 ───────────────────────────────────────
// (2026-09 결정) 키는 bcrypt 해시로 저장한다. 요청마다 해시를 비교하면 느리므로(기록 입력 경로) 한 번 확인된 평문 키는
//   메모리에 기억해 둔다(_opKeyVerified). 캐시를 다시 읽으면(발급·삭제·1분 주기) 기억도 지운다.
//   캐시 형태: _opKeyRows = [{ id, key_value(해시), key_prefix, key_hint, judge_name, can_manage, active }]
const OPKEY_BCRYPT_COST = 8;          // 심판 키는 짧은 편이라 10 보다 낮춰 첫 확인을 빠르게 (약 15ms)
const _opKeyPrefix = k => String(k || '').slice(0, 3);
const _opKeyHint = k => { const t = String(k || ''); return t.length <= 2 ? '••••' : t.slice(0, 2) + '•'.repeat(Math.max(4, t.length - 2)); };
const _opKeyIsHash = v => /^\$2[aby]\$/.test(String(v || ''));
let _opKeyRows = [];
const _opKeyVerified = new Map();     // 평문 키 → row
const _opKeyCache = { has: k => !!_opKeyLookup(k), get: k => _opKeyLookup(k), get size() { return _opKeyRows.length; } };
function _opKeySetRows(rows) { _opKeyRows = rows; _opKeyVerified.clear(); }
function _opKeyLookup(key) {
    if (!key || typeof key !== 'string') return null;
    const hit = _opKeyVerified.get(key); if (hit) return hit;
    const pre = _opKeyPrefix(key);
    for (const r of _opKeyRows) {
        if (!r.active) continue;
        if (_opKeyIsHash(r.key_value)) {
            if (r.key_prefix && r.key_prefix !== pre) continue;
            try { if (bcrypt.compareSync(key, r.key_value)) { _opKeyVerified.set(key, r); return r; } } catch (e) {}
        } else if (r.key_value === key) { _opKeyVerified.set(key, r); return r; }     // 아직 해시되지 않은 옛 행
    }
    return null;
}
function _loadOpKeyCacheSync() {
    if (db.isAsync) return;
    try { _opKeySetRows(db.raw.prepare('SELECT id, key_value, key_prefix, key_hint, judge_name, can_manage, active FROM operation_key WHERE active=1').all()); }
    catch (e) { console.error('[opkey-cache] sync load failed:', e.message); }
}
async function _reloadOpKeyCacheAsync() {
    try { _opKeySetRows(await db.all('SELECT id, key_value, key_prefix, key_hint, judge_name, can_manage, active FROM operation_key WHERE active=1')); }
    catch (e) { console.error('[opkey-cache] async reload failed:', e.message); }
}
// 부팅 마이그레이션: 평문으로 남아 있는 키를 해시로 (원본은 key_hint 에 앞 2자만 남긴다)
async function _migrateOpKeysToHash() {
    try {
        const rows = await db.all('SELECT id, key_value FROM operation_key');
        let n = 0;
        for (const r of rows) {
            if (_opKeyIsHash(r.key_value)) continue;
            await db.run('UPDATE operation_key SET key_value=?, key_prefix=?, key_hint=? WHERE id=?', bcrypt.hashSync(String(r.key_value), OPKEY_BCRYPT_COST), _opKeyPrefix(r.key_value), _opKeyHint(r.key_value), r.id);
            n++;
        }
        if (n) console.log(`[opkey] 운영키 ${n}개를 해시로 저장 (평문 제거)`);
    } catch (e) { console.error('[opkey] 해시 마이그레이션 실패:', e.message); }
}
if (!db.isAsync) _loadOpKeyCacheSync();
_bootTasks.push(_migrateOpKeysToHash().then(() => _reloadOpKeyCacheAsync()));
// 다른 인스턴스·DB 직접 수정으로 폐기된 운영키가 재시작 전까지 살아있지 않도록 1분마다 다시 읽는다
setInterval(() => { _reloadOpKeyCacheAsync().catch(() => {}); }, 60 * 1000).unref();

// 기본 운영키(system_config.operation_key) — 역시 해시로 저장. 설정 시 평문은 한 번만 돌려준다
const _defaultOpVerified = { key: null };
function isDefaultOperationKey(key) {
    const stored = ACCESS_KEYS.operation;
    if (!stored || !key) return false;
    if (!_opKeyIsHash(stored)) return key === stored;                       // 아직 해시되지 않은 값
    if (_defaultOpVerified.key === key) return true;
    try { if (bcrypt.compareSync(key, stored)) { _defaultOpVerified.key = key; return true; } } catch (e) {}
    return false;
}
function setDefaultOperationKey(plain) {
    const p = String(plain || '');
    const { _WEAK } = require('./lib/securityCheck');
    setConfigKey('operation_key', bcrypt.hashSync(p, OPKEY_BCRYPT_COST));
    setConfigKey('operation_key_hint', _opKeyHint(p));
    setConfigKey('operation_key_weak', (p.length < 6 || _WEAK.has(p.toLowerCase())) ? '1' : '0');
    _defaultOpVerified.key = null;
}
// 부팅: 평문으로 저장돼 있던 기본 운영키를 해시로 (SQLite 는 여기서, PG 는 _pgBootAsync 에서)
if (!db.isAsync) { const _op = ACCESS_KEYS.operation; if (_op && !_opKeyIsHash(_op)) setDefaultOperationKey(_op); }

function isOperationKey(key) {
    if (!key) return false;
    const _b = _bridgeOf(key); if (_b) return ['admin', 'manager', 'operator'].includes(_b.role);
    if (typeof key === 'string' && key.startsWith('jwtb:')) return false; // 만료/위조 브리지 토큰
    if (isDefaultOperationKey(key)) return true;
    if (bcrypt.compareSync(key, ACCESS_KEYS.adminHash)) return true;
    return _opKeyCache.has(key);
}

// ─── ORDER BY bib_number 헬퍼 (PG/SQLite 호환) ─────────────────────────
// bib_number 는 TEXT 컬럼이고 "100.0", "" 등 비정상 값을 포함할 수 있음.
// SQLite의 CAST(... AS INTEGER) 는 lenient하지만 PG는 strict → invalid syntax.
// 컬럼명만 받아서 백엔드별 안전한 ORDER BY 식을 반환.
function orderByBibSql(colExpr = 'bib_number') {
    if (db.isAsync) {
        // PG: 비숫자 문자 제거 후 NUMERIC 캐스팅, NULL/빈문자는 마지막
        return `CAST(NULLIF(regexp_replace(COALESCE(${colExpr},''), '[^0-9.]', '', 'g'), '') AS NUMERIC) NULLS LAST`;
    }
    return `CAST(${colExpr} AS INTEGER)`;
}
function isAdminKey(key) {
    if (!key) return false;
    const _b = _bridgeOf(key); if (_b) return _b.role === 'admin';
    if (typeof key === 'string' && key.startsWith('jwtb:')) return false; // 만료/위조 브리지 토큰
    return bcrypt.compareSync(key, ACCESS_KEYS.adminHash);
}
function isAdminOrManager(key) {
    const _b = _bridgeOf(key); if (_b) return _b.role === 'admin' || _b.role === 'manager';
    if (isAdminKey(key)) return true;
    const r = _opKeyCache.get(key);
    return !!(r && r.can_manage);
}
// Phase C 확장: 기록위원 전용 키 — 신기록 승인/거부 권한.
//   ACCESS_KEYS.recordOfficer 가 비어있으면 항상 false (비활성).
function isRecordOfficerKey(key) {
    if (!key) return false;
    const _b = _bridgeOf(key); if (_b) return _b.role === 'record_officer';
    const stored = ACCESS_KEYS.recordOfficer;
    if (!stored) return false; // 비활성 상태
    return key === stored;
}
// 신기록 관련 운영 권한: 관리자 OR 기록위원
function isRecordOfficerOrAdmin(key) {
    if (isAdminKey(key)) return true;
    return isRecordOfficerKey(key);
}
function getJudgeName(key) {
    const _b = _bridgeOf(key); if (_b) return _b.role === 'admin' ? '관리자' : _b.name;
    if (isAdminKey(key)) return '관리자';
    if (isRecordOfficerKey(key)) return '기록위원';
    if (isDefaultOperationKey(key)) return '운영(기본키)';
    const r = _opKeyCache.get(key);
    return r ? r.judge_name : 'unknown';
}
function getKeyRole(key) {
    const _b = _bridgeOf(key);
    if (_b) return ({ admin: 'admin', manager: 'admin', operator: 'operation', record_officer: 'record_officer' })[_b.role] || null;
    if (isAdminKey(key)) return 'admin';
    if (isRecordOfficerKey(key)) return 'record_officer';
    const r = _opKeyCache.get(key);
    if (r) return r.can_manage ? 'admin' : 'operation';
    if (isDefaultOperationKey(key)) return 'operation';
    return null;
}

// Check if competition has ended (for post-competition lock)
// 우선순위:
//   1) status === 'completed'  → 종료 (관리자가 명시적으로 종료한 경우)
//   2) status === 'active'     → 진행중 (관리자가 reopen 한 경우, 자동 만료 무시)
//   3) status === 'upcoming'   → 진행전 (자동 만료 검사 안 함)
//   4) end_date < today        → 자동 만료 (status 미지정 시의 폴백)
async function isCompetitionEnded(competitionId) {
    if (!competitionId) return false;
    const comp = await db.get('SELECT status, end_date FROM competition WHERE id=?', competitionId);
    if (!comp) return false;
    if (comp.status === 'completed') return true;
    if (comp.status === 'active' || comp.status === 'upcoming') return false;
    const today = kstNow().slice(0, 10);
    if (comp.end_date && comp.end_date < today) return true;
    return false;
}

// Check if action should be blocked for non-admin after competition ends
async function requireAdminAfterCompEnd(competitionId, adminKey, res) {
    if ((await isCompetitionEnded(competitionId)) && !isAdminKey(adminKey)) {
        res.status(403).json({ error: '대회가 종료되었습니다. 관리자 권한으로만 수정할 수 있습니다.' });
        return true; // blocked
    }
    return false; // allowed
}

async function verifyJudgeLogin(judgeName, key) {
    // ─────────────────────────────────────────────────────────────
    // [보안 정책 — 2026-05] 관리자 자격증명 분리
    //   - admin_id(ADMIN_ID()) + admin_pw 조합은 운영진·심판 폼에서 절대 통과 금지
    //   - 관리자 로그인은 반드시 /login.html 의 "관리자·매니저(NEW)" 탭 → /api/auth/login (JWT) 으로
    //   - 이유: 관리자 키는 시스템 전체 권한을 가지므로 legacy judge_name+key 폼과 분리해야 안전
    // 관리자 자격증명이 입력된 경우엔 즉시 reject (operation_key 테이블 조회조차 하지 않음)
    // ─────────────────────────────────────────────────────────────
    try {
        if (judgeName === ADMIN_ID() || (ACCESS_KEYS && ACCESS_KEYS.adminHash && bcrypt.compareSync(String(key || ''), ACCESS_KEYS.adminHash))) {
            // admin id 가 들어왔거나, admin password 가 입력된 경우 — 운영진 로그인 거부
            // (정상 admin 은 /api/auth/login 으로 가야 함)
            return null;
        }
    } catch(_) { /* compareSync 실패 시 그냥 진행 */ }

    // Judge login: judge_name + key_value 둘 다 일치해야 통과
    const cands = await db.all('SELECT * FROM operation_key WHERE judge_name=? AND active=1', judgeName);
    const dbKey = cands.find(r => _opKeyIsHash(r.key_value) ? (r.key_prefix === _opKeyPrefix(key) || !r.key_prefix) && bcrypt.compareSync(String(key || ''), r.key_value) : r.key_value === key);
    if (dbKey) { _opKeyVerified.set(key, dbKey); return { role: dbKey.can_manage ? 'admin' : 'operation', judge_name: dbKey.judge_name }; }
    return null;
}

// ---- SSE + WebSocket broadcast ----
let sseClients = [];
function broadcastSSE(eventType, data) {
    const msg = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    sseClients = sseClients.filter(c => {
        try { c.write(msg); return true; }
        catch { return false; }
    });
    // Also forward to WebSocket scoreboard clients — 구독한 대회의 것만 (예전엔 모든 대회의 모든 변경을 모든 오버레이에 보내
    // 오버레이마다 8번의 DB 조회를 되풀이하게 했다). 대회를 알 수 없는 이벤트는 전체 전송(예전과 같음).
    if (typeof wsClients !== 'undefined' && ['result_update', 'wind_update', 'height_update', 'event_status_changed', 'event_completed', 'heat_update', 'entry_status', 'callroom_complete'].includes(eventType)) {
        _wsForward(eventType, data).catch(() => {});
    }
}
const _wsCompCache = new Map();      // 'e:<event_id>' | 'h:<heat_id>' → competition_id
async function _wsCompOf(data) {
    if (!data) return null;
    if (data.competition_id) return Number(data.competition_id);
    const key = data.event_id ? 'e:' + data.event_id : data.heat_id ? 'h:' + data.heat_id : null;
    if (!key) return null;
    if (_wsCompCache.has(key)) return _wsCompCache.get(key);
    let comp = null;
    try {
        const row = data.event_id ? await db.get('SELECT competition_id FROM event WHERE id=?', data.event_id)
            : await db.get('SELECT e.competition_id FROM heat h JOIN event e ON e.id=h.event_id WHERE h.id=?', data.heat_id);
        comp = row ? row.competition_id : null;
    } catch (e) { comp = null; }
    if (_wsCompCache.size > 5000) _wsCompCache.clear();
    _wsCompCache.set(key, comp);
    return comp;
}
async function _wsForward(eventType, data) {
    const comp = await _wsCompOf(data);
    const wsMsg = JSON.stringify({ type: 'scoreboard_' + eventType, data: comp ? { ...data, competition_id: comp } : data, timestamp: Date.now() });
    wsClients.forEach(ws => {
        if (ws.readyState !== 1) return;                       // WebSocket.OPEN
        if (comp && ws._compId && String(ws._compId) !== String(comp)) return;
        try { ws.send(wsMsg); } catch (e) {}
    });
}

// ---- WA Scoring ----
const WA_TABLES = {
    M_100m:{A:25.4347,B:18,C:1.81,type:'track'},M_long_jump:{A:0.14354,B:220,C:1.40,type:'field_cm'},
    M_shot_put:{A:51.39,B:1.5,C:1.05,type:'field_m'},M_high_jump:{A:0.8465,B:75,C:1.42,type:'field_cm'},
    M_400m:{A:1.53775,B:82,C:1.81,type:'track'},M_110m_hurdles:{A:5.74352,B:28.5,C:1.92,type:'track'},
    M_discus:{A:12.91,B:4,C:1.1,type:'field_m'},M_pole_vault:{A:0.2797,B:100,C:1.35,type:'field_cm'},
    M_javelin:{A:10.14,B:7,C:1.08,type:'field_m'},M_1500m:{A:0.03768,B:480,C:1.85,type:'track'},
    F_200m:{A:4.99087,B:42.5,C:1.81,type:'track'},F_100m_hurdles:{A:9.23076,B:26.7,C:1.835,type:'track'},
    F_high_jump:{A:1.84523,B:75,C:1.348,type:'field_cm'},F_shot_put:{A:56.0211,B:1.5,C:1.05,type:'field_m'},
    F_long_jump:{A:0.188807,B:210,C:1.41,type:'field_cm'},F_javelin:{A:15.9803,B:3.8,C:1.04,type:'field_m'},
    F_800m:{A:0.11193,B:254,C:1.88,type:'track'},
};
const DECATHLON_KEYS = ['M_100m','M_long_jump','M_shot_put','M_high_jump','M_400m','M_110m_hurdles','M_discus','M_pole_vault','M_javelin','M_1500m'];
const HEPTATHLON_KEYS = ['F_100m_hurdles','F_high_jump','F_shot_put','F_200m','F_long_jump','F_javelin','F_800m'];
function calcWAPoints(key, rawRecord) {
    const t = WA_TABLES[key];
    if (!t || rawRecord == null || rawRecord <= 0) return 0;
    let val;
    if (t.type === 'track') { val = t.B - rawRecord; if (val <= 0) return 0; return Math.floor(t.A * Math.pow(val, t.C)); }
    else if (t.type === 'field_cm') { val = rawRecord * 100 - t.B; if (val <= 0) return 0; return Math.floor(t.A * Math.pow(val, t.C)); }
    else { val = rawRecord - t.B; if (val <= 0) return 0; return Math.floor(t.A * Math.pow(val, t.C)); }
}

// ---- Audit & OpLog (Phase 2-G-2-extra-3c-1: SQLite sync raw / PG fire-and-forget) ----
// 호출부는 모두 fire-and-forget 패턴(return 값 무시). caller 67건 무변경 유지.
// SQLite: db.raw.prepare(...).run() 으로 sync write — 트랜잭션 보장은 caller route 책임 외부.
// PG: db.run(...).catch() — INSERT 실패는 로깅만 (감사 로그 누락이 비즈니스 로직을 막지 않도록).
const AUDIT_INSERT_SQL = `INSERT INTO audit_log (competition_id,table_name,record_id,action,old_values,new_values,performed_by,created_at,ip_address,user_agent) VALUES (?,?,?,?,?,?,?,?,?,?)`;
const OPLOG_INSERT_SQL = `INSERT INTO operation_log (competition_id,message,category,performed_by,created_at) VALUES (?,?,?,?,?)`;
function audit(table, id, action, oldV, newV, by = 'operator', compId = null, req = null) {
    const ts = kstNow();
    const ip = req ? (req.ip || req.socket?.remoteAddress || null) : null; // trust proxy 설정을 따르는 req.ip 사용 (XFF 직접 파싱 금지)
    const ua = req ? (req.headers['user-agent'] || '').substring(0, 256) : null;
    const oldJson = oldV ? JSON.stringify(oldV) : null;
    const newJson = newV ? JSON.stringify(newV) : null;
    if (!db.isAsync) {
        try {
            db.raw.prepare(AUDIT_INSERT_SQL).run(compId, table, id, action, oldJson, newJson, by, ts, ip, ua);
        } catch (e) { console.error('[audit] sync write failed:', e.message); }
    } else {
        db.run(AUDIT_INSERT_SQL, compId, table, id, action, oldJson, newJson, by, ts, ip, ua)
            .catch(e => console.error('[audit] async write failed:', e.message));
    }
}
function opLog(message, category = 'general', performedBy = 'system', compId = null) {
    const ts = kstNow();
    if (!db.isAsync) {
        try {
            db.raw.prepare(OPLOG_INSERT_SQL).run(compId, message, category, performedBy, ts);
        } catch (e) { console.error('[opLog] sync write failed:', e.message); }
    } else {
        db.run(OPLOG_INSERT_SQL, compId, message, category, performedBy, ts)
            .catch(e => console.error('[opLog] async write failed:', e.message));
    }
    broadcastSSE('operation_log', { message, category, performed_by: performedBy, created_at: ts });
}

// Federation event mapping
const FED_EVENT_MAP = {
    '100m':{name:'100m',category:'track'},'200m':{name:'200m',category:'track'},'400m':{name:'400m',category:'track'},
    '800m':{name:'800m',category:'track'},'1000m':{name:'1000m',category:'track'},'1500m':{name:'1500m',category:'track'},'5000m':{name:'5000m',category:'track'},
    '5000mW':{name:'5000mW',category:'track'},'10000m':{name:'10,000m',category:'track'},
    '10000mW':{name:'10,000mW',category:'track'},'10,000mW':{name:'10,000mW',category:'track'},
    '100mH':{name:'100mH',category:'track'},
    '110mH':{name:'110mH',category:'track'},'400mH':{name:'400mH',category:'track'},
    '3000mSC':{name:'3000mSC',category:'track'},'3000m장애물':{name:'3000mSC',category:'track'},
    '멀리뛰기':{name:'멀리뛰기',category:'field_distance'},'세단뛰기':{name:'세단뛰기',category:'field_distance'},
    '포환던지기':{name:'포환던지기',category:'field_distance'},'원반던지기':{name:'원반던지기',category:'field_distance'},
    '해머던지기':{name:'해머던지기',category:'field_distance'},'창던지기':{name:'창던지기',category:'field_distance'},
    '높이뛰기':{name:'높이뛰기',category:'field_height'},'장대높이뛰기':{name:'장대높이뛰기',category:'field_height'},
    '10종경기':{name:'10종경기',category:'combined'},'7종경기':{name:'7종경기',category:'combined'},
    '5종경기':{name:'5종경기',category:'combined'},'펜타슬론':{name:'5종경기',category:'combined'},'Pentathlon':{name:'5종경기',category:'combined'},
    // Road race events
    '마라톤':{name:'마라톤',category:'road'},'하프마라톤':{name:'하프마라톤',category:'road'},
    '10K':{name:'10K',category:'road'},'10k':{name:'10K',category:'road'},
    '10km':{name:'10K',category:'road'},'10Km':{name:'10K',category:'road'},'10KM':{name:'10K',category:'road'},
    '5K':{name:'5K',category:'road'},'5k':{name:'5K',category:'road'},
    '5km':{name:'5K',category:'road'},'5Km':{name:'5K',category:'road'},'5KM':{name:'5K',category:'road'},
    '20KmW':{name:'20KmW',category:'road'},'35kmW':{name:'35kmW',category:'road'},
};

/**
 * Smart event name resolver: handles complex names like "10K 국제 남자부", "10K 국내 여자부"
 * Returns { name, category, suffix } or null if not found.
 * "suffix" preserves qualifiers like 국제/국내 for sub-event distinction.
 */
function resolveFedEventName(rawName) {
    const trimmed = String(rawName || '').trim();
    if (!trimmed) return null;

    // 1) Direct exact match
    if (FED_EVENT_MAP[trimmed]) return { ...FED_EVENT_MAP[trimmed], suffix: '' };

    // 2) Strip gender suffix (남자부/여자부/남자/여자/남/여) and try again
    // Also strip category qualifiers (국제/국내/일반/대학/고등/중등/초등 etc.) after base event
    // Pattern: "<base event> [qualifier] [gender suffix]"
    const genderSuffixRe = /\s*(남자부|여자부|남자|여자|남|여)\s*$/;
    const qualifierRe = /\s+(국제|국내|일반|대학|고등|중등|초등|실업|엘리트|마스터|시니어|주니어|유스|U20|U18|U16)\s*/g;

    let cleaned = trimmed.replace(genderSuffixRe, '').trim();
    let suffix = '';

    // Extract qualifiers for suffix
    const qualifiers = [];
    let qMatch;
    const qRe = /(국제|국내|일반|대학|고등|중등|초등|실업|엘리트|마스터|시니어|주니어|유스|U20|U18|U16)/g;
    while ((qMatch = qRe.exec(cleaned)) !== null) qualifiers.push(qMatch[1]);
    suffix = qualifiers.join(' ');

    // Remove qualifiers to get base event name
    const baseName = cleaned.replace(qualifierRe, ' ').trim();

    if (FED_EVENT_MAP[baseName]) return { ...FED_EVENT_MAP[baseName], suffix };

    // 3) Try common variations
    const variations = [
        baseName.replace(/,/g, ''),         // "10,000m" -> "10000m"
        baseName.replace(/\s/g, ''),         // remove spaces
        baseName.toLowerCase(),
        baseName.replace(/(\d)(\d{3})(m)/i, '$1,$2$3'), // "10000m" -> "10,000m"
    ];
    for (const v of variations) {
        if (FED_EVENT_MAP[v]) return { ...FED_EVENT_MAP[v], suffix };
    }

    return null;
}
// 연맹 명단 엑셀의 종목1/종목2 열 위치 — 헤더명으로 탐색, 없으면 레거시 고정 위치(E·F열).
//   배포 양식(PACERISE_upload_template.xlsx)은 E열이 휴대폰이라 고정 인덱스로 읽으면 종목이 누락되던 문제 방지.
function fedEventColIdx(headers) {
    const hn = (headers || []).map(h => String(h || '').replace(/\s+/g, '').toLowerCase());
    const i1 = hn.findIndex(h => /^(종목1|종목|event1|event)$/.test(h));
    const i2 = hn.findIndex(h => /^(종목2|event2)$/.test(h));
    if (i1 >= 0) return [i1, i2 >= 0 ? i2 : -1];
    return [4, 5];
}
const FED_RELAY_MAP = {
    '400mR':{name:'4X100mR',category:'relay'},'1600mR':{name:'4X400mR',category:'relay'},
    'Mixed':{name:'4X400mR(Mixed)',category:'relay',gender:'X'},
    '4 x 1500mR':{name:'4X1500mR',category:'relay'},'4 x 800mR':{name:'4X800mR',category:'relay'},
    '4x100mR':{name:'4X100mR',category:'relay'},'4x400mR':{name:'4X400mR',category:'relay'},
    '4x800mR':{name:'4X800mR',category:'relay'},'4x1500mR':{name:'4X1500mR',category:'relay'},
    '4X100mR':{name:'4X100mR',category:'relay'},'4X400mR':{name:'4X400mR',category:'relay'},
    '4X800mR':{name:'4X800mR',category:'relay'},
    '4X1500mR':{name:'4X1500mR',category:'relay'},'4×800mR':{name:'4X800mR',category:'relay'},'4×1500mR':{name:'4X1500mR',category:'relay'},
    '4×100mR':{name:'4X100mR',category:'relay'},'4×400mR':{name:'4X400mR',category:'relay'},
    '4x400mR(Mixed)':{name:'4X400mR(Mixed)',category:'relay',gender:'X'},
    '4X400mR(Mixed)':{name:'4X400mR(Mixed)',category:'relay',gender:'X'},
};

// ============================================================
// WA SEEDING & LANE ASSIGNMENT HELPERS
// ============================================================
function isShortTrackEvent(eventName) {
    if (!eventName) return false;
    const n = eventName.toLowerCase();
    // Events ≤800m where lane assignment applies and max 8 per heat
    if (n.includes('100m') || n.includes('200m') || n.includes('400m') || n.includes('800m')) return true;
    if (n.includes('릴레이') || n.includes('relay')) return true;
    return false;
}

// 출신 조 안에서의 순위 (트랙: 유효 기록 중 몇 번째로 빠른가). 시드 순서(TR 20.3.2)에 필요. 필드는 null.
async function _placeInSourceHeat(event, eventEntryId) {
    if (!['track', 'relay', 'road'].includes(event.category)) return null;
    const row = await db.get(`SELECT r.heat_id, MIN(r.time_seconds) AS t FROM result r JOIN heat h ON h.id=r.heat_id
        WHERE h.event_id=? AND r.event_entry_id=? AND r.time_seconds>0 AND (r.status_code IS NULL OR r.status_code='') GROUP BY r.heat_id ORDER BY t LIMIT 1`, event.id, eventEntryId);
    if (!row || row.t == null) return null;
    const faster = await db.get(`SELECT COUNT(DISTINCT event_entry_id) AS c FROM result WHERE heat_id=? AND time_seconds>0 AND time_seconds<? AND (status_code IS NULL OR status_code='')`, row.heat_id, row.t);
    return ((faster && faster.c) || 0) + 1;
}

// WA Rule 20.4 - Serpentine (zigzag) distribution by performance
// Athletes sorted by record, distributed across heats in snake order
// Same-team athletes separated when possible
// Same-heat-of-origin athletes separated when possible (WA Rule 20.4.3)
async function waSeededDistribution(event, qualifiedSels, groupCount, db) {
    // Get best performance for each qualified athlete + source heat info
    const athletePerf = [];
    for (const sel of qualifiedSels) {
        const origEntry = await db.get('SELECT * FROM event_entry WHERE id=?', sel.event_entry_id);
        if (!origEntry) {
            athletePerf.push({ ...sel, athlete_id: null, team: '', perf: Infinity, sourceHeat: null });
            continue;
        }
        const athlete = await db.get('SELECT * FROM athlete WHERE id=?', origEntry.athlete_id);
        // Get best result from all heats of the source event + track source heat
        let bestPerf = Infinity;
        let sourceHeat = null;
        const heats = await db.all('SELECT id, heat_number FROM heat WHERE event_id=?', event.id);
        for (const h of heats) {
            const entryInHeat = await db.get('SELECT * FROM heat_entry WHERE heat_id=? AND event_entry_id=?', h.id, sel.event_entry_id);
            if (!entryInHeat) continue;
            if (!sourceHeat) sourceHeat = h.heat_number; // track which heat the athlete came from
            if (event.category === 'track' || event.category === 'relay' || event.category === 'road') {
                const r = await db.get('SELECT MIN(time_seconds) AS best FROM result WHERE heat_id=? AND event_entry_id=? AND time_seconds > 0', h.id, sel.event_entry_id);
                if (r && r.best && r.best < bestPerf) { bestPerf = r.best; sourceHeat = h.heat_number; }
            } else if (event.category === 'field_distance') {
                const r = await db.get('SELECT MAX(distance_meters) AS best FROM result WHERE heat_id=? AND event_entry_id=? AND distance_meters > 0', h.id, sel.event_entry_id);
                if (r && r.best) { bestPerf = -r.best; sourceHeat = h.heat_number; }
            } else if (event.category === 'field_height') {
                const r = await db.get("SELECT MAX(bar_height) AS best FROM height_attempt WHERE heat_id=? AND event_entry_id=? AND result_mark='O'", h.id, sel.event_entry_id);
                if (r && r.best) { bestPerf = -r.best; sourceHeat = h.heat_number; }
            }
        }
        athletePerf.push({ ...sel, athlete_id: origEntry.athlete_id, team: athlete ? athlete.team : '', perf: bestPerf, sourceHeat, place: await _placeInSourceHeat(event, sel.event_entry_id) });
    }

    // WA seeding: Q (순위 진출) first by performance, then q (기록 진출) by performance
    // A q athlete cannot outrank a Q athlete even with a better record
    //   (TR 20.3.2: Q 안에서는 조 순위가 먼저 — 조 1위들 기록순, 조 2위들 기록순 … — lib/seeding.js)
    {
        const ordered = require('./lib/seeding').seedOrder(athletePerf);
        athletePerf.length = 0; athletePerf.push(...ordered);
    }

    // Serpentine distribution: row 1 L→R, row 2 R→L, etc.
    const groups = Array.from({ length: groupCount }, () => []);
    athletePerf.forEach((ath, idx) => {
        const row = Math.floor(idx / groupCount);
        const col = idx % groupCount;
        const groupIdx = row % 2 === 0 ? col : (groupCount - 1 - col);
        groups[groupIdx].push(ath);
    });

    // Attempt same-team AND same-source-heat separation (swap athletes between groups)
    for (let pass = 0; pass < 5; pass++) {
        for (let g = 0; g < groupCount; g++) {
            // Build conflict map: team conflicts + source heat conflicts
            const conflicts = [];
            const teamMap = {};
            const heatMap = {};
            groups[g].forEach((a, i) => {
                if (a.team) {
                    if (!teamMap[a.team]) teamMap[a.team] = [];
                    teamMap[a.team].push(i);
                }
                if (a.sourceHeat != null) {
                    const hk = String(a.sourceHeat);
                    if (!heatMap[hk]) heatMap[hk] = [];
                    heatMap[hk].push(i);
                }
            });
            // Collect indices that need swapping (team duplicates)
            for (const [team, indices] of Object.entries(teamMap)) {
                if (indices.length <= 1 || !team) continue;
                for (let k = 1; k < indices.length; k++) conflicts.push({ idx: indices[k], key: 'team', val: team });
            }
            // Collect indices that need swapping (same source heat, if heats > 1)
            for (const [hk, indices] of Object.entries(heatMap)) {
                if (indices.length <= 1) continue;
                // Only try to separate if there are enough groups
                for (let k = 1; k < indices.length; k++) conflicts.push({ idx: indices[k], key: 'heat', val: hk });
            }
            // Try to resolve conflicts via swap
            for (const conflict of conflicts) {
                const swapIdx = conflict.idx;
                const ath = groups[g][swapIdx];
                for (let g2 = 0; g2 < groupCount; g2++) {
                    if (g2 === g) continue;
                    // Check if g2 has the same conflict
                    const hasConflict = conflict.key === 'team'
                        ? groups[g2].some(a => a.team === conflict.val)
                        : groups[g2].some(a => String(a.sourceHeat) === conflict.val);
                    if (hasConflict) continue;
                    // Find a swap target in g2 that won't create new conflicts in g
                    const swapTarget = groups[g2].findIndex(a => {
                        const wouldConflictTeam = a.team && groups[g].some(b => b !== ath && b.team === a.team);
                        const wouldConflictHeat = a.sourceHeat != null && groups[g].some(b => b !== ath && String(b.sourceHeat) === String(a.sourceHeat));
                        return !wouldConflictTeam && !wouldConflictHeat;
                    });
                    if (swapTarget >= 0) {
                        [groups[g][swapIdx], groups[g2][swapTarget]] = [groups[g2][swapTarget], groups[g][swapIdx]];
                        break;
                    }
                }
            }
        }
    }

    return groups;
}

// WA Rule 20.5 - Lane assignment within a heat
// Three patterns depending on event type
function shuffleArray(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function getLanePattern(eventName) {
    if (!eventName) return null;
    const n = eventName.replace(/\s+/g, '').toUpperCase();
    // Strip combined-event prefix like [10종] or [7종]
    const base = n.replace(/^\[.*?\]/, '');

    // Pattern C: 400m, 800m, 400mH, relay (check first — relay names contain '100m' / '400m')
    if (/^4[X×]/i.test(base) || base.includes('릴레이') || base.includes('RELAY')) return 'C';
    if (/^400M/i.test(base) || /^800M/i.test(base)) return 'C';

    // Pattern B: 200m
    if (/^200M/i.test(base)) return 'B';

    // Pattern A: 100m, 80m, 100mH, 110mH (straight-line sprints & hurdles)
    if (/^100M/i.test(base) || /^80M/i.test(base) || /^110M/i.test(base)) return 'A';

    return null; // not a lane-assigned event (field, distance, etc.)
}

function waAssignLane(seedIdx, totalInHeat, isShortTrack, eventName) {
    if (!isShortTrack || totalInHeat <= 0) return seedIdx + 1;

    const pattern = getLanePattern(eventName);

    if (pattern === 'A') {
        // Pattern A: 100m, 80m, 100mh, 110mh
        // Ranks 1-4 → random lanes 3,4,5,6; Ranks 5-6 → random lanes 2,7; Ranks 7-8 → random lanes 1,8
        const groups = [
            { ranks: [0,1,2,3], lanes: [3,4,5,6] },
            { ranks: [4,5],     lanes: [2,7] },
            { ranks: [6,7],     lanes: [1,8] },
        ];
        // Find which group this seed belongs to
        for (const g of groups) {
            const idx = g.ranks.indexOf(seedIdx);
            if (idx !== -1) {
                // Deterministic but shuffled per group: use precomputed shuffle
                // We shuffle the lane pool once — caller should use bulk assignment
                return g.lanes[idx % g.lanes.length];
            }
        }
        return seedIdx + 1;
    }

    if (pattern === 'B') {
        // Pattern B: 200m
        // Ranks 1-3 → random lanes 5,6,7; Ranks 4-6 → random lanes 3,4,8; Ranks 7-8 → random lanes 1,2
        const groups = [
            { ranks: [0,1,2],   lanes: [5,6,7] },
            { ranks: [3,4,5],   lanes: [3,4,8] },
            { ranks: [6,7],     lanes: [1,2] },
        ];
        for (const g of groups) {
            const idx = g.ranks.indexOf(seedIdx);
            if (idx !== -1) return g.lanes[idx % g.lanes.length];
        }
        return seedIdx + 1;
    }

    if (pattern === 'C') {
        // Pattern C: 400m, 800m, 400mh, 4x100r, 4x400r
        // Ranks 1-4 → random lanes 4,5,6,7; Ranks 5-6 → random lanes 3,8; Ranks 7-8 → random lanes 1,2
        const groups = [
            { ranks: [0,1,2,3], lanes: [4,5,6,7] },
            { ranks: [4,5],     lanes: [3,8] },
            { ranks: [6,7],     lanes: [1,2] },
        ];
        for (const g of groups) {
            const idx = g.ranks.indexOf(seedIdx);
            if (idx !== -1) return g.lanes[idx % g.lanes.length];
        }
        return seedIdx + 1;
    }

    // Fallback: center-out (original logic)
    const laneOrder = [4, 5, 3, 6, 2, 7, 1, 8];
    const maxLanes = Math.min(totalInHeat, 8);
    if (seedIdx < maxLanes) return laneOrder[seedIdx];
    return seedIdx + 1;
}

// Bulk lane assignment with random shuffle within groups
function waAssignLanesBulk(athletes, totalInHeat, isShortTrack, eventName) {
    if (!isShortTrack || totalInHeat <= 0) {
        return athletes.map((_, idx) => idx + 1);
    }

    const pattern = getLanePattern(eventName);
    let groups;

    if (pattern === 'A') {
        groups = [
            { ranks: [0,1,2,3], lanes: [3,4,5,6] },
            { ranks: [4,5],     lanes: [2,7] },
            { ranks: [6,7],     lanes: [1,8] },
        ];
    } else if (pattern === 'B') {
        groups = [
            { ranks: [0,1,2],   lanes: [5,6,7] },
            { ranks: [3,4,5],   lanes: [3,4,8] },
            { ranks: [6,7],     lanes: [1,2] },
        ];
    } else if (pattern === 'C') {
        groups = [
            { ranks: [0,1,2,3], lanes: [4,5,6,7] },
            { ranks: [4,5],     lanes: [3,8] },
            { ranks: [6,7],     lanes: [1,2] },
        ];
    } else {
        // Fallback
        const laneOrder = [4, 5, 3, 6, 2, 7, 1, 8];
        return athletes.map((_, idx) => idx < 8 ? laneOrder[idx] : idx + 1);
    }

    const laneMap = new Array(athletes.length).fill(0);
    for (const g of groups) {
        const shuffledLanes = shuffleArray(g.lanes);
        let laneIdx = 0;
        for (const rank of g.ranks) {
            if (rank < athletes.length && laneIdx < shuffledLanes.length) {
                laneMap[rank] = shuffledLanes[laneIdx++];
            }
        }
    }
    // Fill any unassigned (>8 athletes)
    for (let i = 0; i < laneMap.length; i++) {
        if (laneMap[i] === 0) laneMap[i] = i + 1;
    }
    return laneMap;
}

// WA Regulation Validator — check and auto-correct heat/lane assignments
async function validateWAHeatLanes(eventId, db) {
    const event = await db.get('SELECT * FROM event WHERE id=?', eventId);
    if (!event) return { valid: true, issues: [], corrections: 0 };
    const isShort = isShortTrackEvent(event.name);
    const heats = await db.all('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number', eventId);
    const issues = [];
    let corrections = 0;

    for (const heat of heats) {
        const entries = await db.all(`SELECT he.*, ee.athlete_id, a.name, a.team
            FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id
            JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=? ORDER BY he.lane_number`, heat.id);

        // Rule 1: Short track (≤800m) — max 8 athletes per heat
        if (isShort && entries.length > 8) {
            issues.push({ heat: heat.heat_number, type: 'max_per_heat', message: `Heat ${heat.heat_number}: ${entries.length}명 (최대 8명 초과)` });
        }

        // Rule 2: Short track — lanes must be 1-8
        if (isShort) {
            const invalidLanes = entries.filter(e => e.lane_number < 1 || e.lane_number > 8);
            if (invalidLanes.length > 0) {
                issues.push({ heat: heat.heat_number, type: 'invalid_lane', message: `Heat ${heat.heat_number}: 유효하지 않은 레인 번호` });
            }
            // Rule 3: No duplicate lanes in the same heat
            const laneSet = new Set();
            const dupes = [];
            entries.forEach(e => {
                if (laneSet.has(e.lane_number)) dupes.push(e.lane_number);
                laneSet.add(e.lane_number);
            });
            if (dupes.length > 0) {
                issues.push({ heat: heat.heat_number, type: 'duplicate_lane', message: `Heat ${heat.heat_number}: 중복 레인 ${dupes.join(',')}` });
            }
        }

        // Rule 4: Same team athletes should be separated across heats when possible
        if (heats.length > 1) {
            const teamCounts = {};
            entries.forEach(e => {
                if (e.team) {
                    teamCounts[e.team] = (teamCounts[e.team] || 0) + 1;
                }
            });
            for (const [team, count] of Object.entries(teamCounts)) {
                if (count > 1) {
                    issues.push({ heat: heat.heat_number, type: 'same_team', message: `Heat ${heat.heat_number}: ${team} 소속 ${count}명 (동일 팀 분리 권장)`, severity: 'warning' });
                }
            }
        }
    }

    return { valid: issues.filter(i => i.severity !== 'warning').length === 0, issues, corrections };
}

// Generate scoreboard_key for a heat
// Format: "남자실업부 100m 결승" (single heat) or "여자 200m 준결승 2조" (multi heat)
async function generateScoreboardKey(event, heatNumber, db, totalHeats) {
    const genderLabel = { M: '남자', F: '여자', X: '혼성' }[event.gender] || '';
    const roundLabel = { preliminary: '예선', semifinal: '준결승', final: '결승' }[event.round_type] || event.round_type;
    let federationLabel = '';
    if (event.competition_id) {
        const comp = await db.get('SELECT federation, division_type FROM competition WHERE id=?', event.competition_id);
        if (comp) {
            if (comp.federation === 'KTFL' || comp.division_type === 'pro') federationLabel = '실업부';
            else if (comp.federation === 'KUAF' || comp.division_type === 'univ') federationLabel = '대학부';
            else if (comp.division_type === 'high') federationLabel = '고등부';
            else if (comp.division_type === 'middle') federationLabel = '중등부';
            else if (comp.division_type === 'general') federationLabel = '일반부';
        }
    }
    // Single heat → no "N조" suffix
    if (totalHeats === 1) {
        return `${genderLabel}${federationLabel} ${event.name} ${roundLabel}`;
    }
    return `${genderLabel}${federationLabel} ${event.name} ${roundLabel} ${heatNumber}조`;
}

// Generate joint scoreboard key for linked events
// Format: "합동 남자 100m 결승" or "합동 여자 200m 예선 1조"
async function generateJointScoreboardKey(event, db) {
    const genderLabel = { M: '남자', F: '여자', X: '혼성' }[event.gender] || '';
    const roundLabel = { preliminary: '예선', semifinal: '준결승', final: '결승' }[event.round_type] || event.round_type;
    // Count heats for this event to decide whether to add heat numbers
    const heats = await db.get('SELECT COUNT(*) as cnt FROM heat WHERE event_id=?', event.id);
    const heatCount = heats ? heats.cnt : 0;
    if (heatCount <= 1) {
        return `합동 ${genderLabel} ${event.name} ${roundLabel}`;
    }
    // Multiple heats — return base key; individual heat keys will be: "합동 남자 100m 예선 1조", etc.
    return `합동 ${genderLabel} ${event.name} ${roundLabel}`;
}

// Generate per-heat joint scoreboard keys and store them
async function generateJointHeatKeys(eventIdA, eventIdB, db) {
    const evA = await db.get('SELECT * FROM event WHERE id=?', eventIdA);
    if (!evA) return null;
    const baseKey = await generateJointScoreboardKey(evA, db);

    // Find all heats for both events, pair them by heat_number
    const heatsA = await db.all('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number', eventIdA);
    const heatsB = await db.all('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number', eventIdB);
    const maxHeats = Math.max(heatsA.length, heatsB.length);

    if (maxHeats <= 1) {
        return baseKey; // Single heat, no heat number suffix
    }
    // Multiple heats — key will include heat numbers
    return baseKey;
}

// Get joint scoreboard data for a given event_id (used by lookup fallback)
async function getJointScoreboardData(eventId, dbRef) {
    const links = await dbRef.all(`
        SELECT event_id_a, event_id_b FROM event_link
        WHERE event_id_a = ? OR event_id_b = ?
    `, eventId, eventId);

    const eventIds = new Set([parseInt(eventId)]);
    for (const l of links) { eventIds.add(l.event_id_a); eventIds.add(l.event_id_b); }

    const allEntries = [];
    let primaryEvt = null;
    for (const eid of eventIds) {
        const evt = await dbRef.get('SELECT e.*, c.name as comp_name, c.federation FROM event e JOIN competition c ON c.id=e.competition_id WHERE e.id=?', eid);
        if (!evt) continue;
        if (eid === parseInt(eventId) || !primaryEvt) primaryEvt = evt;

        const heat = await dbRef.get('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number DESC LIMIT 1', eid);
        if (!heat) continue;

        const entries = await dbRef.all(`
            SELECT he.lane_number, he.sub_group, ee.id as event_entry_id, ee.status,
                   a.name, a.bib_number, a.team, a.gender, a.federation as athlete_federation
            FROM heat_entry he
            JOIN event_entry ee ON ee.id = he.event_entry_id
            JOIN athlete a ON a.id = ee.athlete_id
            WHERE he.heat_id = ?
            ORDER BY he.lane_number
        `, heat.id);

        const results = await dbRef.all('SELECT * FROM result WHERE heat_id=?', heat.id);
        const fedLabel = evt.federation || evt.comp_name;

        for (const e of entries) {
            const r = results.find(r => r.event_entry_id === e.event_entry_id);
            allEntries.push({
                ...e,
                record: r ? (r.time_seconds || r.distance_meters || null) : null,
                status_code: r ? r.status_code : null,
                federation: fedLabel,
                competition_id: evt.competition_id,
                event_id: eid,
                heat_id: heat.id,
                wind: heat.wind,
            });
        }
    }

    if (!primaryEvt) return null;
    return {
        event: primaryEvt,
        linked_event_ids: [...eventIds],
        entries: allEntries,
    };
}

// Auto-correct WA violations: reassign lanes using WA lane preference
async function autoCorrectWALanes(eventId, db) {
    const event = await db.get('SELECT * FROM event WHERE id=?', eventId);
    if (!event) return { corrections: 0, issues: [] };
    const isShort = isShortTrackEvent(event.name);
    const heats = await db.all('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number', eventId);
    let corrections = 0;
    const issues = [];

    await db.transaction(async () => {
        for (const heat of heats) {
            const entries = await db.all(`SELECT he.*, ee.athlete_id FROM heat_entry he
                JOIN event_entry ee ON ee.id=he.event_entry_id WHERE he.heat_id=? ORDER BY he.lane_number`, heat.id);

            if (isShort) {
                // Check for duplicate lanes or invalid lanes
                const laneSet = new Set();
                let needsReassign = false;
                entries.forEach(e => {
                    if (e.lane_number < 1 || e.lane_number > 8 || laneSet.has(e.lane_number)) needsReassign = true;
                    laneSet.add(e.lane_number);
                });

                if (needsReassign && entries.length <= 8) {
                    // Reassign using WA lane preference order with pattern-based shuffle
                    const lanes = waAssignLanesBulk(entries, entries.length, true, event.name);
                    for (let idx = 0; idx < entries.length; idx++) {
                        const e = entries[idx];
                        const newLane = lanes[idx];
                        if (newLane !== e.lane_number) {
                            await db.run('UPDATE heat_entry SET lane_number=? WHERE id=?', newLane, e.id);
                            corrections++;
                        }
                    }
                    issues.push({ heat: heat.heat_number, type: 'corrected', message: `Heat ${heat.heat_number}: WA 레인 규정에 따라 자동 수정됨` });
                }
            }
        }
    })();

    return { corrections, issues };
}

// ============================================================
// AUTH — judge_name + key login (rate limited)
// ============================================================
// AUTH Phase 2: 신규 JWT 로그인 API (/api/auth/login, /refresh, /logout, /me, /change-password)
// 기존 /api/auth/verify 는 그대로 둠 (legacy ?key= 호환)
require('./lib/routes/auth')(app, { db, authLimiter, bcrypt });

// AUTH Phase 3 (B-5): 관리자 전용 사용자 관리 API
// GET/POST/PUT/DELETE /api/admin/users + revoke-sessions
require('./lib/routes/admin_users')(app, { db, bcrypt, jwtHelpers: require('./lib/auth/jwt') });

// (2026-09) /api/_diag/* 진단 라우트 제거 — jwt_secret·admin_pw 값 미리보기를 응답했고 ?adminKey= 쿼리 인증을 허용했음.
//   필요 시 서버 셸에서 직접 확인: sqlite3 db/competition.db "select id,username,role,active from app_user"

// ─── 레거시 키 로그인 보호 (2026-09): 실패 누적 잠금 + login_audit 기록 ───
//   JWT 계정은 5회 실패→10분 잠금이 있었지만 키 로그인 경로는 분당 한도뿐이었다.
//   IP+심판명 단위로 10분 안에 10회 실패하면 10분 잠금. 성공/실패 모두 login_audit 에 남긴다(username=심판명, 사유 legacy_*).
const _legacyFails = new Map(); // id → { n, first, until }
function _legacyId(req, name) { return `${req.ip || ''}|${String(name || '').trim().toLowerCase()}`; }
function _legacyLockedFor(id) { const r = _legacyFails.get(id); return (r && r.until && r.until > Date.now()) ? Math.ceil((r.until - Date.now()) / 1000) : 0; }
function _legacyFail(id) {
    const now = Date.now(); let r = _legacyFails.get(id);
    if (!r || now - r.first > 10 * 60 * 1000) r = { n: 0, first: now, until: 0 };
    r.n++; if (r.n >= 10) r.until = now + 10 * 60 * 1000;
    _legacyFails.set(id, r);
    if (_legacyFails.size > 5000) for (const [k, v] of _legacyFails) if (now - v.first > 20 * 60 * 1000) _legacyFails.delete(k);
}
async function _legacyAudit(req, name, success, reason) {
    try { await db.run('INSERT INTO login_audit (user_id, username, success, failure_reason, ip, user_agent) VALUES (?,?,?,?,?,?)', null, String(name || '(key-only)').slice(0, 64), success ? 1 : 0, reason, req.ip || null, req.headers['user-agent'] || null); } catch (e) {}
}
app.post('/api/auth/verify', authLimiter, async (req, res) => {
    const { key, judge_name } = req.body;
    const lid = _legacyId(req, judge_name);
    const wait = _legacyLockedFor(lid);
    if (wait) { await _legacyAudit(req, judge_name, false, 'legacy_locked'); return res.status(429).json({ error: `로그인 시도가 너무 많습니다. ${Math.ceil(wait / 60)}분 후 다시 시도하세요.` }); }
    // New: judge_name + key login
    if (judge_name && key) {
        const result = await verifyJudgeLogin(judge_name, key);
        if (result) { _legacyFails.delete(lid); await _legacyAudit(req, judge_name, true, 'legacy_judge'); return res.json({ success: true, role: result.role, label: result.role === 'admin' ? '관리자' : '운영', judge_name: result.judge_name }); }
        _legacyFail(lid); await _legacyAudit(req, judge_name, false, 'legacy_bad_key');
        return res.status(403).json({ error: '심판명 또는 운영키가 일치하지 않습니다.' });
    }
    // Legacy: key-only (저장된 운영키의 역할 확인용). 관리자 비밀번호는 이 경로로 통과시키지 않는다 —
    //   "관리자는 /login.html 관리자 탭(JWT)으로만" 정책(verifyJudgeLogin)과 맞춤.
    if (key) {
        if (!_bridgeOf(key) && isAdminKey(key)) { await _legacyAudit(req, null, false, 'legacy_admin_pw_rejected'); return res.status(403).json({ error: '관리자는 로그인 화면의 관리자 탭에서 로그인하세요.' }); }
        if (isOperationKey(key)) {
            const jn = getJudgeName(key);
            _legacyFails.delete(lid);
            return res.json({ success: true, role: getKeyRole(key) || 'operation', label: '운영', judge_name: jn });
        }
        _legacyFail(lid); await _legacyAudit(req, null, false, 'legacy_bad_key');
    }
    res.status(403).json({ error: '유효하지 않은 키입니다.' });
});
app.post('/api/admin/verify', authLimiter, async (req, res) => {
    const { admin_key } = req.body;
    const lid = _legacyId(req, '(admin-verify)');
    const wait = _legacyLockedFor(lid);
    if (wait) return res.status(429).json({ error: `시도가 너무 많습니다. ${Math.ceil(wait / 60)}분 후 다시 시도하세요.` });
    if (isOperationKey(admin_key) || isAdminKey(admin_key)) {
        const jn = getJudgeName(admin_key);
        _legacyFails.delete(lid);
        return res.json({ success: true, judge_name: jn });
    }
    _legacyFail(lid); await _legacyAudit(req, '(admin-verify)', false, 'legacy_bad_key');
    res.status(403).json({ error: 'Invalid admin key' });
});
// /api/staff/verify removed — was never called from any client.
// Use /api/admin/verify (admin/operation key verification) instead.

// ============================================================
// COMPETITIONS CRUD — lib/routes/competitions.js 로 추출
// ============================================================
require("./lib/routes/competitions")(app, {
    db, isAdminKey, isOperationKey, isAdminOrManager, opLog, broadcastSSE, kstNow, performBackup
});


// Competition info (public — for viewer)
app.get('/api/competition-info', async (req, res) => {
    const compId = req.query.competition_id;
    function pick(c) {
        return {
            id: c.id,
            name: c.name,
            dates: `${c.start_date} ~ ${c.end_date}`,
            venue: c.venue,
            video_url: c.video_url || '',
            federation: c.federation || '',
            series_id: c.series_id || null   // Phase C: CR 매칭용
        };
    }
    if (compId) {
        const c = await db.get('SELECT * FROM competition WHERE id=?', compId);
        if (c) return res.json(pick(c));
    }
    const c = await db.get('SELECT * FROM competition ORDER BY start_date DESC LIMIT 1');
    if (c) return res.json(pick(c));
    res.json({ id: null, name: '', dates: '', venue: '', video_url: '', federation: '', series_id: null });
});

// ============================================================
// FEDERATION LIST — CRUD  (lib/routes/federations.js 로 추출됨)
// ============================================================
require('./lib/routes/federations')(app, { db, isAdminKey, opLog });

// ============================================================
// HOME POPUP — CMS  (lib/routes/home_popups.js 로 추출됨)
// ============================================================
require('./lib/routes/home_popups')(app, { db, isAdminKey, opLog });



// ============================================================
// EVENTS — scoped to competition
// ============================================================
// Heat allocations view — shows all heats/lanes for an event (used in manual edit UI)
app.get('/api/events/:id/heat-allocations', async (req, res) => {
    const event = await db.get('SELECT * FROM event WHERE id=?', req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    const heats = await db.all('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number', event.id);
    const result = await Promise.all(heats.map(async h => {
        const entries = await db.all(`SELECT he.lane_number, he.sub_group, he.id AS heat_entry_id, ee.id AS event_entry_id, ee.status,
               a.id AS athlete_id, a.name, a.bib_number, a.team, a.gender
        FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id
        JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=? ORDER BY he.lane_number ASC, ${orderByBibSql('a.bib_number')}`, h.id);
        return { ...h, entries };
    }));
    res.json({ event, heats: result });
});
app.get('/api/events', async (req, res) => {
    const { gender, category, competition_id } = req.query;
    let q = 'SELECT * FROM event WHERE 1=1';
    const p = [];
    if (competition_id) { q += ' AND competition_id=?'; p.push(competition_id); }
    if (gender) { q += ' AND gender=?'; p.push(gender); }
    if (category) { q += ' AND category=?'; p.push(category); }
    q += ' ORDER BY sort_order, id';
    const events = await db.all(q, ...p);
    // Attach heat_count so dashboard can show roster button for events with heats
    // (PG-safe: 단일 GROUP BY 쿼리로 일괄 조회, 이전 N+1 sync prepare 제거)
    if (events.length > 0) {
        const ids = events.map(e => e.id);
        const placeholders = ids.map(() => '?').join(',');
        const counts = await db.all(`SELECT event_id, COUNT(*) AS cnt FROM heat WHERE event_id IN (${placeholders}) GROUP BY event_id`, ...ids);
        const countMap = new Map(counts.map(c => [c.event_id, Number(c.cnt)]));
        events.forEach(e => { e.heat_count = countMap.get(e.id) || 0; });
    }
    res.json(events);
});
app.get('/api/events/:id', async (req, res) => {
    const e = await db.get('SELECT * FROM event WHERE id=?', req.params.id);
    if (!e) return res.status(404).json({ error: 'Not found' });
    res.json(e);
});
app.get('/api/events/:id/entries', async (req, res) => {
    res.json(await db.all(`
        SELECT ee.id AS event_entry_id, ee.status, ee.event_id,
               a.id AS athlete_id, a.name, a.bib_number, a.team, a.gender
        FROM event_entry ee JOIN athlete a ON a.id=ee.athlete_id
        WHERE ee.event_id=? ORDER BY ${orderByBibSql('a.bib_number')}
    `, req.params.id));
});

// ============================================================
// HEATS
// ============================================================
app.get('/api/heats', async (req, res) => {
    if (!req.query.event_id) return res.status(400).json({ error: 'event_id required' });
    res.json(await db.all('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number', req.query.event_id));
});
app.get('/api/heats/:id/entries', async (req, res) => {
    const statusFilter = req.query.status;
    let query = `SELECT he.id AS heat_entry_id, he.lane_number, he.sub_group,
               ee.id AS event_entry_id, ee.status, ee.callroom_memo, ee.manual_rank,
               a.id AS athlete_id, a.name, a.bib_number, a.team, a.gender, a.barcode
        FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id
        JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=?`;
    const params = [req.params.id];
    if (statusFilter) { query += ` AND ee.status=?`; params.push(statusFilter); }
    query += ` ORDER BY he.lane_number ASC, ${orderByBibSql('a.bib_number')}`;
    res.json(await db.all(query, ...params));
});

// ============================================================
// RESULTS
// ============================================================
// RESULTS 라우트들은 lib/routes/results.js 로 추출됨 (10차)
const _resultsRoutes = require('./lib/routes/results')(app, { db, isAdminKey, isOperationKey, opLog, broadcastSSE, calcWAPoints, requireAdminAfterCompEnd, audit, parseDbTimestampMs, DECATHLON_KEYS, HEPTATHLON_KEYS });
// ============================================================
app.post('/api/heats/:id/wind', async (req, res) => {
    const { wind, offline_input_at } = req.body;
    const heat = await db.get('SELECT * FROM heat WHERE id=?', req.params.id);
    if (!heat) return res.status(404).json({ error: 'Heat not found' });
    // 오프라인 재전송: 그 사이 다른 기기가 풍속을 바꿨으면 옛 값으로 덮지 않는다 (기록 입력과 같은 규칙)
    if (offline_input_at && heat.wind_updated_at) {
        const serverMs = parseDbTimestampMs(heat.wind_updated_at), offMs = Number(offline_input_at);
        if (Number.isFinite(serverMs) && Number.isFinite(offMs) && serverMs > offMs) {
            return res.status(409).json({ error: 'CONFLICT_NEWER_ON_SERVER', message: '운영진이 그 사이에 풍속을 갱신했습니다. 오프라인 입력값은 적용되지 않았습니다.', server_value: { wind: heat.wind, updated_at: heat.wind_updated_at }, rejected_offline_value: { wind, offline_input_at } });
        }
    }
    // Store as "N.N m/s" text format for scoreboard system compatibility
    let windValue = null;
    if (wind != null && wind !== '') {
        const v = parseFloat(wind);
        if (!isNaN(v)) windValue = v.toFixed(1) + ' m/s';
    }
    await db.run(`UPDATE heat SET wind=?, wind_updated_at=${db.isAsync ? 'NOW()' : "datetime('now')"} WHERE id=?`, windValue, heat.id);
    broadcastSSE('wind_update', { heat_id: heat.id, wind: windValue });
    // 풍속이 바뀌면 이 조의 신기록 판정을 다시 (추풍이면 대기 중 감지 제거, 허용 풍속이면 재감지)
    let recheck = null;
    try { recheck = await _resultsRoutes.reevaluateHeatRecords(heat.id); } catch (e) { console.error('[wind] 신기록 재판정 실패:', e && e.message); }
    res.json({ success: true, wind: windValue, record_recheck: recheck });
});
app.get('/api/heats/:id/wind', async (req, res) => {
    const heat = await db.get('SELECT * FROM heat WHERE id=?', req.params.id);
    if (!heat) return res.status(404).json({ error: 'Heat not found' });
    res.json({ heat_id: heat.id, wind: heat.wind });
});

// Rename heat (custom display name)
app.post('/api/heats/:id/rename', async (req, res) => {
    const key = req.body.admin_key || req.headers['x-admin-key'] || '';
    if (!isOperationKey(key)) return res.status(403).json({ error: '인증 필요' });
    const heat = await db.get('SELECT * FROM heat WHERE id=?', parseInt(req.params.id));
    if (!heat) return res.status(404).json({ error: 'Heat not found' });
    const heat_name = req.body.heat_name != null ? String(req.body.heat_name).trim() || null : null;

    // Also update scoreboard_key if provided in request, or regenerate from heat_name
    let scoreboard_key = heat.scoreboard_key; // keep existing by default
    if (req.body.scoreboard_key !== undefined) {
        // Explicit scoreboard_key override
        scoreboard_key = req.body.scoreboard_key ? String(req.body.scoreboard_key).trim() : null;
    } else if (heat_name && heat.scoreboard_key) {
        // Auto-update: replace the heat number suffix in scoreboard_key
        // e.g., scoreboard_key "남자실업부 100m 예선 1조" + heat_name "예선 3조" → "남자실업부 100m 예선 3조"
        // Extract heat number from heat_name if it contains "N조"
        const heatNameMatch = heat_name.match(/(\d+)\s*조/);
        if (heatNameMatch) {
            scoreboard_key = heat.scoreboard_key.replace(/\d+조$/, heatNameMatch[1] + '조');
        }
    }

    await db.run('UPDATE heat SET heat_name=?, scoreboard_key=? WHERE id=?', heat_name, scoreboard_key, heat.id);
    broadcastSSE('heat_update', { heat_id: heat.id, event_id: heat.event_id, heat_name, scoreboard_key });
    res.json({ success: true, heat_id: heat.id, heat_name, scoreboard_key });
});

// Update scoreboard_key directly
app.post('/api/heats/:id/scoreboard-key', async (req, res) => {
    const key = req.body.admin_key || req.headers['x-admin-key'] || '';
    if (!isOperationKey(key)) return res.status(403).json({ error: '인증 필요' });
    const heat = await db.get('SELECT * FROM heat WHERE id=?', parseInt(req.params.id));
    if (!heat) return res.status(404).json({ error: 'Heat not found' });
    const scoreboard_key = req.body.scoreboard_key != null ? String(req.body.scoreboard_key).trim() || null : null;
    await db.run('UPDATE heat SET scoreboard_key=? WHERE id=?', scoreboard_key, heat.id);
    broadcastSSE('heat_update', { heat_id: heat.id, event_id: heat.event_id, scoreboard_key });
    res.json({ success: true, heat_id: heat.id, scoreboard_key });
});

// ============================================================
// LIVE RESULTS API — for dashboard real-time view
// ============================================================
app.get('/api/events/:id/live-results', async (req, res) => {
    const event = await db.get('SELECT * FROM event WHERE id=?', req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    const heats = await db.all('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number', event.id);
    // Also load qualifications if available
    const quals = await db.all('SELECT * FROM qualification_selection WHERE event_id=? AND selected=1', event.id);
    const result = await Promise.all(heats.map(async h => {
        const entries = await db.all(`SELECT he.lane_number, he.sub_group, ee.id AS event_entry_id, ee.status, ee.manual_rank,
               a.name, a.bib_number, a.team FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id
               JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=? ORDER BY he.lane_number ASC, ${orderByBibSql('a.bib_number')}`, h.id);
        if (event.category === 'field_height') {
            return { ...h, entries, height_attempts: await db.all('SELECT * FROM height_attempt WHERE heat_id=? ORDER BY bar_height, event_entry_id, attempt_number', h.id) };
        }
        return { ...h, entries, results: await db.all('SELECT * FROM result WHERE heat_id=? ORDER BY event_entry_id, attempt_number', h.id) };
    }));
    res.json({ event, heats: result, qualifications: quals });
});

// ============================================================
// HEIGHT ATTEMPTS
// ============================================================
app.get('/api/height-attempts', async (req, res) => {
    if (!req.query.heat_id) return res.status(400).json({ error: 'heat_id required' });
    res.json(await db.all(`
        SELECT ha.*, a.name, a.bib_number, a.team
        FROM height_attempt ha JOIN event_entry ee ON ee.id=ha.event_entry_id
        JOIN athlete a ON a.id=ee.athlete_id
        WHERE ha.heat_id=? ORDER BY ha.bar_height, ha.event_entry_id, ha.attempt_number
    `, req.query.heat_id));
});
app.post('/api/height-attempts/save', async (req, res) => {
    const { heat_id, event_entry_id, bar_height, attempt_number, result_mark, admin_key, offline_input_at } = req.body;
    if (!heat_id || !event_entry_id || !bar_height || !attempt_number)
        return res.status(400).json({ error: 'heat_id, event_entry_id, bar_height, attempt_number required' });

    // Check if event is completed — require admin_key
    const _hHeat = await db.get('SELECT * FROM heat WHERE id=?', heat_id);
    if (_hHeat) {
        const _hEvt = await db.get('SELECT * FROM event WHERE id=?', _hHeat.event_id);
        // Post-competition lock
        if (_hEvt && await requireAdminAfterCompEnd(_hEvt.competition_id, admin_key, res)) return;
        if (_hEvt && _hEvt.round_status === 'completed' && !isAdminKey(admin_key) && !isOperationKey(admin_key))
            return res.status(403).json({ error: '완료된 경기의 기록 수정은 관리자 키가 필요합니다.' });
    }

    // Empty mark = delete the attempt (toggle back to empty)
    if (!result_mark || result_mark === '') {
        const existing = await db.get('SELECT * FROM height_attempt WHERE heat_id=? AND event_entry_id=? AND bar_height=? AND attempt_number=?', heat_id, event_entry_id, bar_height, attempt_number);
        if (existing) {
            await db.run('DELETE FROM height_attempt WHERE id=?', existing.id);
            broadcastSSE('height_update', { heat_id, event_entry_id, bar_height });
        }
        return res.json({ success: true, deleted: true });
    }

    // Normalize: accept both '-' and 'PASS' as pass mark, store as 'PASS' (DB constraint)
    let normalizedMark = result_mark;
    if (normalizedMark === '-') normalizedMark = 'PASS';
    // Auto-update round_status to in_progress when first height attempt is saved
    const heat = await db.get('SELECT * FROM heat WHERE id=?', heat_id);
    if (heat) {
        const event = await db.get('SELECT * FROM event WHERE id=?', heat.event_id);
        if (event && (event.round_status === 'heats_generated' || event.round_status === 'created')) {
            await db.run("UPDATE event SET round_status='in_progress' WHERE id=?", event.id);
            broadcastSSE('event_status_changed', { event_id: event.id, round_status: 'in_progress' });
            const gL = event.gender === 'M' ? '남자' : event.gender === 'F' ? '여자' : '혼성';
            const roundL = { preliminary: '예선', semifinal: '준결승', final: '결승' }[event.round_type] || event.round_type;
            opLog(`${event.name} ${roundL} ${gL} 기록 입력 시작 (자동 진행중 전환)`, 'record', 'system', event.competition_id);
        }
        // Also update parent combined event status if this is a sub-event
        if (event && event.parent_event_id) {
            const parentEvt = await db.get('SELECT * FROM event WHERE id=?', event.parent_event_id);
            if (parentEvt && parentEvt.category === 'combined' && (parentEvt.round_status === 'heats_generated' || parentEvt.round_status === 'created')) {
                await db.run("UPDATE event SET round_status='in_progress' WHERE id=?", parentEvt.id);
                broadcastSSE('event_status_changed', { event_id: parentEvt.id, round_status: 'in_progress' });
                opLog(`${parentEvt.name} 기록 입력 시작 (세부종목 자동 진행중 전환)`, 'record', 'system', parentEvt.competition_id);
            }
        }
    }
    try {
        const existing = await db.get('SELECT * FROM height_attempt WHERE heat_id=? AND event_entry_id=? AND bar_height=? AND attempt_number=?', heat_id, event_entry_id, bar_height, attempt_number);
        if (existing) {
            // ─── 오프라인 동기화 충돌 감지 ─────────────────────────
            // PG/SQLite 양쪽 timestamp 텍스트 형식을 모두 안전하게 파싱 (parseDbTimestampMs)
            if (offline_input_at && existing.updated_at) {
                const serverUpdatedMs = parseDbTimestampMs(existing.updated_at);
                const offlineMs = Number(offline_input_at);
                if (Number.isFinite(serverUpdatedMs) && Number.isFinite(offlineMs) && serverUpdatedMs > offlineMs) {
                    return res.status(409).json({
                        error: 'CONFLICT_NEWER_ON_SERVER',
                        message: '운영진이 그 사이에 기록을 갱신했습니다. 오프라인 입력값은 적용되지 않았습니다.',
                        server_value: { result_mark: existing.result_mark, updated_at: existing.updated_at },
                        rejected_offline_value: { result_mark, bar_height, attempt_number, offline_input_at }
                    });
                }
            }
            const _nowFH = db.isAsync ? 'NOW()' : "datetime('now')";
            await db.run(`UPDATE height_attempt SET result_mark=?,updated_at=${_nowFH} WHERE id=?`, normalizedMark, existing.id);
            const upd = await db.get('SELECT * FROM height_attempt WHERE id=?', existing.id);
            broadcastSSE('height_update', { heat_id, event_entry_id, bar_height });
            res.json(upd);
        } else {
            const info = await db.run('INSERT INTO height_attempt (heat_id,event_entry_id,bar_height,attempt_number,result_mark) VALUES (?,?,?,?,?)', heat_id, event_entry_id, bar_height, attempt_number, normalizedMark);
            const ins = await db.get('SELECT * FROM height_attempt WHERE id=?', info.lastInsertRowid);
            broadcastSSE('height_update', { heat_id, event_entry_id, bar_height });
            res.json(ins);
        }
    } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// Delete all height attempts for a specific bar_height in a heat
app.post('/api/height-attempts/delete-bar', async (req, res) => {
    const { heat_id, bar_height, admin_key } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    if (!heat_id || bar_height == null) return res.status(400).json({ error: 'heat_id and bar_height required' });
    // Check if event is completed — require admin_key
    const _dbHeat = await db.get('SELECT * FROM heat WHERE id=?', heat_id);
    if (_dbHeat) {
        const _dbEvt = await db.get('SELECT * FROM event WHERE id=?', _dbHeat.event_id);
        if (_dbEvt && _dbEvt.round_status === 'completed' && !isAdminKey(admin_key) && !isOperationKey(admin_key))
            return res.status(403).json({ error: '완료된 경기의 기록 삭제는 관리자 키가 필요합니다.' });
    }
    const deleted = await db.run('DELETE FROM height_attempt WHERE heat_id=? AND bar_height=?', heat_id, parseFloat(bar_height));
    broadcastSSE('height_update', { heat_id, bar_height });
    res.json({ success: true, deleted: deleted.changes });
});

// ============================================================
// COMBINED SCORES — lib/routes/combined_scores.js 로 추출
// ============================================================
require("./lib/routes/combined_scores")(app, {
    db, isAdminKey, isOperationKey, opLog, broadcastSSE,
    // WA 점수 계산용 상수/함수 — combined_scores.js 의 /sync /repair 가 필요로 함.
    // 누락 시 ReferenceError: DECATHLON_KEYS is not defined 로 500 떨어짐 (2026-06 fix)
    DECATHLON_KEYS, HEPTATHLON_KEYS, WA_TABLES, calcWAPoints,
    // 종료된 대회 혼성점수 잠금 — 누락 시 try/catch에 삼켜져 잠금이 무력화됨 (2026-06 fix)
    requireAdminAfterCompEnd
});

// ============================================================
// CALLROOM
// ============================================================
app.get('/api/barcode/:code', async (req, res) => {
    const raw = req.params.code.trim();
    // ?competition_id= 를 주면 그 대회 선수만 본다 — 대회가 여러 개면 같은 배번이 다른 대회 선수로 잡히기 때문
    const _scope = req.query.competition_id ? Number(req.query.competition_id) : null;
    const _one = (col, v, extra = '') => _scope ? db.get(`SELECT * FROM athlete WHERE ${col}=?${extra} AND competition_id=?`, v, _scope) : db.get(`SELECT * FROM athlete WHERE ${col}=?${extra}`, v);

    // W/w prefix → female athlete by bib
    const wMatch = raw.match(/^[Ww][-]?(\d+)$/);
    if (wMatch) {
        const bibNum = wMatch[1].replace(/^0+/, '') || '0';
        const a = await _one('bib_number', bibNum, " AND gender='F'");
        if (!a) return res.status(404).json({ error: 'Barcode not found' });
        return res.json(a);
    }

    // Normal barcode normalization
    const variants = [raw];
    let numPart = null;
    const pr2026Match = raw.match(/^PR2026(\d+)$/i);
    const prMatch = raw.match(/^PR[-]?0*(\d+)$/i);
    if (pr2026Match) numPart = pr2026Match[1];
    else if (prMatch) numPart = prMatch[1];
    else if (/^\d+$/.test(raw)) numPart = raw.replace(/^0+/, '') || '0';
    if (numPart) {
        variants.push(`PR-${numPart}`, `PR${numPart}`, `PR${numPart.padStart(4, '0')}`, numPart);
    }
    let a = null;
    for (const v of variants) {
        a = await _one('barcode', v);
        if (a) break;
    }
    if (!a) {
        for (const v of variants) {
            a = await _one('bib_number', v);
            if (a) break;
        }
    }
    if (!a) return res.status(404).json({ error: 'Barcode not found' });
    res.json(a);
});
app.patch('/api/event-entries/:id/status', async (req, res) => {
    const { status, admin_key, offline_input_at } = req.body;
    if (!['registered', 'checked_in', 'no_show'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const entry = await db.get('SELECT * FROM event_entry WHERE id=?', req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not found' });
    // Post-competition lock
    const _evt = await db.get('SELECT competition_id FROM event WHERE id=?', entry.event_id);
    if (_evt && await requireAdminAfterCompEnd(_evt.competition_id, admin_key, res)) return;
    // 오프라인 재전송: 그 사이 다른 기기(소집실 PC 등)가 상태를 바꿨으면 옛 값으로 덮지 않는다
    if (offline_input_at && entry.status_updated_at) {
        const serverMs = parseDbTimestampMs(entry.status_updated_at), offMs = Number(offline_input_at);
        if (Number.isFinite(serverMs) && Number.isFinite(offMs) && serverMs > offMs) {
            return res.status(409).json({ error: 'CONFLICT_NEWER_ON_SERVER', message: '그 사이에 다른 기기에서 소집 상태를 바꿨습니다. 오프라인 입력값은 적용되지 않았습니다.', server_value: { status: entry.status, updated_at: entry.status_updated_at }, rejected_offline_value: { status, offline_input_at } });
        }
    }
    await db.run(`UPDATE event_entry SET status=?, status_updated_at=${db.isAsync ? 'NOW()' : "datetime('now')"} WHERE id=?`, status, req.params.id);
    await syncCombinedSubEventCheckin(entry.event_id, entry.athlete_id, status);
    const _he = await db.get('SELECT heat_id FROM heat_entry WHERE event_entry_id=?', entry.id);
    broadcastSSE('entry_status', { event_entry_id: entry.id, status, event_id: entry.event_id, heat_id: _he ? _he.heat_id : null });
    res.json(await db.get('SELECT * FROM event_entry WHERE id=?', req.params.id));
});
// Save callroom memo
app.patch('/api/event-entries/:id/memo', async (req, res) => {
    const { memo } = req.body;
    const entry = await db.get('SELECT * FROM event_entry WHERE id=?', req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not found' });
    await db.run('UPDATE event_entry SET callroom_memo=? WHERE id=?', memo || '', req.params.id);
    res.json({ success: true });
});
// Save manual rank (수직도약 순위결정전 등 동기록 시 직접 입력한 순위)
app.patch('/api/event-entries/:id/manual-rank', async (req, res) => {
    const { manual_rank, admin_key } = req.body;
    const entry = await db.get('SELECT * FROM event_entry WHERE id=?', req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not found' });
    const _evt = await db.get('SELECT competition_id FROM event WHERE id=?', entry.event_id);
    if (_evt && await requireAdminAfterCompEnd(_evt.competition_id, admin_key, res)) return;
    let mr = (manual_rank === null || manual_rank === '' || manual_rank === undefined) ? null : parseInt(manual_rank);
    if (mr != null && (isNaN(mr) || mr < 1)) mr = null;
    await db.run('UPDATE event_entry SET manual_rank=? WHERE id=?', mr, req.params.id);
    broadcastSSE('result_update', { event_id: entry.event_id });
    res.json({ success: true, manual_rank: mr });
});
// Get/Save event-level callroom memo (소집실 종목 메모 — 인쇄 시 제목 하단)
app.get('/api/events/:id/callroom-memo', async (req, res) => {
    const evt = await db.get('SELECT callroom_event_memo FROM event WHERE id=?', req.params.id);
    if (!evt) return res.status(404).json({ error: 'Event not found' });
    res.json({ memo: evt.callroom_event_memo || '' });
});
app.patch('/api/events/:id/callroom-memo', async (req, res) => {
    const { memo } = req.body;
    const evt = await db.get('SELECT id FROM event WHERE id=?', req.params.id);
    if (!evt) return res.status(404).json({ error: 'Event not found' });
    await db.run('UPDATE event SET callroom_event_memo=? WHERE id=?', memo || '', req.params.id);
    res.json({ success: true, memo: memo || '' });
});
// ============================================================
// 소집(콜룸) 출석·완료 · 경기 완료 — lib/routes/callroom.js 로 추출 (2026-09)
// ============================================================
const { syncCombinedSubEventCheckin } = require('./lib/routes/callroom')(app, { db, isOperationKey, isAdminKey, opLog, broadcastSSE, audit, notifyEventInterest: (...a) => notifyEventInterest(...a) });
// ============================================================
// QUALIFICATIONS — lib/routes/qualifications.js 로 추출
// ============================================================
require('./lib/routes/qualifications')(app, { db });


app.post('/api/events/:id/create-final', async (req, res) => {
    const event = await db.get('SELECT * FROM event WHERE id=?', req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    const existingFinal = await db.get("SELECT id FROM event WHERE name=? AND gender=? AND category=? AND round_type='final' AND competition_id=? AND parent_event_id IS NULL AND id!=?", event.name, event.gender, event.category, event.competition_id, event.id);
    if (existingFinal) return res.status(400).json({ error: '이미 결승이 존재합니다.' });
    const qualified = await db.all(`SELECT event_entry_id, qualification_type FROM qualification_selection WHERE event_id=? AND selected=1 AND approved=1`, event.id);
    if (qualified.length === 0) return res.status(400).json({ error: 'No approved qualifiers' });

    const isShortTrack_ = isShortTrackEvent(event.name);
    // For finals, check if we need multiple heats (>8 athletes for ≤800m)
    const { group_count: finalGroupCount } = req.body;
    const numHeats = finalGroupCount || 1;

    const info = await db.run(`INSERT INTO event (competition_id,name,category,gender,round_type,round_status) VALUES (?,?,?,?,'final','heats_generated')`, event.competition_id, event.name, event.category, event.gender);
    const finalEventId = info.lastInsertRowid;

    // Build athlete data for WA seeding — with best performance for sorting
    const qualSels = await Promise.all(qualified.map(async q => {
        const origEntry = await db.get('SELECT * FROM event_entry WHERE id=?', q.event_entry_id);
        if (!origEntry) return { event_entry_id: q.event_entry_id, athlete_id: null, qualification_type: q.qualification_type || '', perf: Infinity };
        // Get best performance across all heats of the source event
        let bestPerf = Infinity;
        const heats = await db.all('SELECT id FROM heat WHERE event_id=?', event.id);
        for (const h of heats) {
            const entryInHeat = await db.get('SELECT id FROM heat_entry WHERE heat_id=? AND event_entry_id=?', h.id, q.event_entry_id);
            if (!entryInHeat) continue;
            if (event.category === 'track' || event.category === 'relay' || event.category === 'road') {
                const r = await db.get('SELECT MIN(time_seconds) AS best FROM result WHERE heat_id=? AND event_entry_id=? AND time_seconds > 0', h.id, q.event_entry_id);
                if (r && r.best != null && r.best < bestPerf) bestPerf = r.best;
            } else if (event.category === 'field_distance') {
                const r = await db.get('SELECT MAX(distance_meters) AS best FROM result WHERE heat_id=? AND event_entry_id=? AND distance_meters > 0', h.id, q.event_entry_id);
                if (r && r.best) bestPerf = -r.best; // negate so ascending sort = best first
            } else if (event.category === 'field_height') {
                const r = await db.get("SELECT MAX(bar_height) AS best FROM height_attempt WHERE heat_id=? AND event_entry_id=? AND result_mark='O'", h.id, q.event_entry_id);
                if (r && r.best) bestPerf = -r.best;
            }
        }
        return { event_entry_id: q.event_entry_id, athlete_id: origEntry.athlete_id, qualification_type: q.qualification_type || '', perf: bestPerf, place: await _placeInSourceHeat(event, q.event_entry_id) };
    }));

    // WA seeding: Q (순위 진출) first by performance, then q (기록 진출) by performance
    // A q athlete cannot outrank a Q athlete even with a better record
    //   (TR 20.3.2: Q 안에서는 조 순위가 먼저 — 조 1위들 기록순, 조 2위들 기록순 … — lib/seeding.js)
    {
        const ordered = require('./lib/seeding').seedOrder(qualSels);
        qualSels.length = 0; qualSels.push(...ordered);
    }

    // Fetch the newly created final event for scoreboard key generation
    const finalEvent = await db.get('SELECT * FROM event WHERE id=?', finalEventId);

    if (numHeats === 1) {
        const heatInfo = await db.run('INSERT INTO heat (event_id,heat_number) VALUES (?,1)', finalEventId);
        // Auto-generate scoreboard_key
        const sbKey = await generateScoreboardKey(finalEvent, 1, db, numHeats);
        await db.run('UPDATE heat SET scoreboard_key=? WHERE id=?', sbKey, heatInfo.lastInsertRowid);
        // WA lane assignment for single heat with pattern-based random shuffle
        const lanes = waAssignLanesBulk(qualSels, qualSels.length, isShortTrack_, event.name);
        for (let idx = 0; idx < qualSels.length; idx++) {
            const ath = qualSels[idx];
            const newEntry = await db.run("INSERT INTO event_entry (event_id,athlete_id,status) VALUES (?,?,'registered')", finalEventId, ath.athlete_id);
            await db.run('INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES (?,?,?)', heatInfo.lastInsertRowid, newEntry.lastInsertRowid, lanes[idx]);
        }
    } else {
        // Multi-heat final with WA seeding
        const seeded = await waSeededDistribution(event, qualSels, numHeats, db);
        for (let g = 0; g < numHeats; g++) {
            const heatInfo = await db.run('INSERT INTO heat (event_id,heat_number) VALUES (?,?)', finalEventId, g + 1);
            // Auto-generate scoreboard_key
            const sbKey = await generateScoreboardKey(finalEvent, g + 1, db, numHeats);
            await db.run('UPDATE heat SET scoreboard_key=? WHERE id=?', sbKey, heatInfo.lastInsertRowid);
            const groupAthletes = seeded[g] || [];
            // Sort within group by performance for correct WA lane assignment
            groupAthletes.sort((a, b) => (a.seedRank || 0) - (b.seedRank || 0) || a.perf - b.perf);   // 시드 순서 유지 (레인 그룹 추첨 기준)
            const lanes = waAssignLanesBulk(groupAthletes, groupAthletes.length, isShortTrack_, event.name);
            for (let idx = 0; idx < groupAthletes.length; idx++) {
                const ath = groupAthletes[idx];
                const newEntry = await db.run("INSERT INTO event_entry (event_id,athlete_id,status) VALUES (?,?,'registered')", finalEventId, ath.athlete_id);
                await db.run('INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES (?,?,?)', heatInfo.lastInsertRowid, newEntry.lastInsertRowid, lanes[idx]);
            }
        }
    }
    opLog(`${event.name} ${event.gender === 'M' ? '남자' : '여자'} 결승 라운드 생성 (${qualified.length}명 진출)`, 'round', 'system', event.competition_id);
    // SSE broadcast so dashboard/results pages pick up the new final event
    broadcastSSE('event_status_changed', { event_id: finalEventId, round_status: 'heats_generated' });
    // 시간표 자동 재매칭 (결승 라운드가 새로 생겼으므로 시간표의 "결승" 행과 연결 가능)
    try { await autoLinkDisplayTimetable(event.competition_id); } catch(autoErr) { console.warn('[autoLink after final] ', autoErr.message); }
    res.json({ success: true, final_event_id: finalEventId, count: qualified.length });
});

// GET /api/events/:id/lane-assignments — Return lane assignments with WA rule explanations
app.get('/api/events/:id/lane-assignments', async (req, res) => {
    const event = await db.get('SELECT * FROM event WHERE id=?', req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const heats = await db.all('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number', event.id);
    if (heats.length === 0) return res.json({ heats: [] });

    const isShortTrack = isShortTrackEvent(event.name);
    const pattern = getLanePattern(event.name);
    const patternLabel = pattern === 'A' ? '100m/허들 패턴' : pattern === 'B' ? '200m 패턴' : pattern === 'C' ? '400m/800m/릴레이 패턴' : '기본 배정';

    // Lane group descriptions by pattern
    const groupDescs = {};
    if (pattern === 'A') {
        groupDescs[3] = '시드 1~4위 그룹 (레인 3,4,5,6)';
        groupDescs[4] = '시드 1~4위 그룹 (레인 3,4,5,6)';
        groupDescs[5] = '시드 1~4위 그룹 (레인 3,4,5,6)';
        groupDescs[6] = '시드 1~4위 그룹 (레인 3,4,5,6)';
        groupDescs[2] = '시드 5~6위 그룹 (레인 2,7)';
        groupDescs[7] = '시드 5~6위 그룹 (레인 2,7)';
        groupDescs[1] = '시드 7~8위 그룹 (레인 1,8)';
        groupDescs[8] = '시드 7~8위 그룹 (레인 1,8)';
    } else if (pattern === 'B') {
        groupDescs[5] = '시드 1~3위 그룹 (레인 5,6,7)';
        groupDescs[6] = '시드 1~3위 그룹 (레인 5,6,7)';
        groupDescs[7] = '시드 1~3위 그룹 (레인 5,6,7)';
        groupDescs[3] = '시드 4~6위 그룹 (레인 3,4,8)';
        groupDescs[4] = '시드 4~6위 그룹 (레인 3,4,8)';
        groupDescs[8] = '시드 4~6위 그룹 (레인 3,4,8)';
        groupDescs[1] = '시드 7~8위 그룹 (레인 1,2)';
        groupDescs[2] = '시드 7~8위 그룹 (레인 1,2)';
    } else if (pattern === 'C') {
        groupDescs[4] = '시드 1~4위 그룹 (레인 4,5,6,7)';
        groupDescs[5] = '시드 1~4위 그룹 (레인 4,5,6,7)';
        groupDescs[6] = '시드 1~4위 그룹 (레인 4,5,6,7)';
        groupDescs[7] = '시드 1~4위 그룹 (레인 4,5,6,7)';
        groupDescs[3] = '시드 5~6위 그룹 (레인 3,8)';
        groupDescs[8] = '시드 5~6위 그룹 (레인 3,8)';
        groupDescs[1] = '시드 7~8위 그룹 (레인 1,2)';
        groupDescs[2] = '시드 7~8위 그룹 (레인 1,2)';
    }

    const result = await Promise.all(heats.map(async heat => {
        const entries = await db.all(`
            SELECT he.id AS heat_entry_id, he.event_entry_id, he.lane_number,
                   ee.athlete_id, a.name, a.bib_number, a.team
            FROM heat_entry he
            JOIN event_entry ee ON ee.id = he.event_entry_id
            JOIN athlete a ON a.id = ee.athlete_id
            WHERE he.heat_id = ?
            ORDER BY he.lane_number
        `, heat.id);

        // Build seed rank by looking at source event results
        // Find source event (preliminary/semifinal) that led to this event
        const sourceEvent = await db.all("SELECT id FROM event WHERE name=? AND gender=? AND category=? AND competition_id=? AND round_type IN ('preliminary','semifinal') AND id!=?", event.name, event.gender, event.category, event.competition_id, event.id);

        // Get qualification info for each athlete
        const athleteDetails = await Promise.all(entries.map(async e => {
            let qualType = '';
            let seedRank = null;
            let bestPerf = null;
            let bestPerfDisplay = '';
            let reason = '';

            // Find qualification info
            for (const src of sourceEvent) {
                const q = await db.get('SELECT qualification_type FROM qualification_selection WHERE event_id=? AND event_entry_id=? AND selected=1 AND approved=1', src.id, e.event_entry_id);
                if (!q) {
                    // Find by athlete_id instead (new event_entry in final)
                    const origEntry = await db.get('SELECT id FROM event_entry WHERE event_id=? AND athlete_id=?', src.id, e.athlete_id);
                    if (origEntry) {
                        const q2 = await db.get('SELECT qualification_type FROM qualification_selection WHERE event_id=? AND event_entry_id=? AND selected=1 AND approved=1', src.id, origEntry.id);
                        if (q2) qualType = q2.qualification_type || '';
                    }
                } else {
                    qualType = q.qualification_type || '';
                }
            }

            const laneNum = e.lane_number;
            const groupReason = groupDescs[laneNum] || '';
            const qualLabel = qualType === 'Q' ? '순위 진출(Q)' : qualType === 'q' ? '기록 진출(q)' : '';

            if (isShortTrack && pattern) {
                reason = `WA ${patternLabel}: ${groupReason}${qualLabel ? ' / ' + qualLabel : ''} → 그룹 내 랜덤 배정으로 레인 ${laneNum}`;
            } else {
                reason = `순서 배정: 레인 ${laneNum}`;
            }

            return {
                heat_entry_id: e.heat_entry_id,
                event_entry_id: e.event_entry_id,
                athlete_id: e.athlete_id,
                name: e.name,
                bib_number: e.bib_number,
                team: e.team,
                lane_number: laneNum,
                qualification_type: qualType,
                reason: reason
            };
        }));

        return {
            heat_id: heat.id,
            heat_number: heat.heat_number,
            heat_name: heat.heat_name || `Heat ${heat.heat_number}`,
            entries: athleteDetails
        };
    }));

    res.json({
        event_id: event.id,
        event_name: event.name,
        pattern: pattern,
        pattern_label: patternLabel,
        is_short_track: isShortTrack,
        heats: result
    });
});

app.post('/api/events/:id/create-semifinal', async (req, res) => {
    const event = await db.get('SELECT * FROM event WHERE id=?', req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    const existingSemi = await db.get("SELECT id FROM event WHERE name=? AND gender=? AND category=? AND round_type='semifinal' AND competition_id=? AND parent_event_id IS NULL", event.name, event.gender, event.category, event.competition_id);
    if (existingSemi) return res.status(400).json({ error: '이미 준결승이 존재합니다.' });
    const { group_count, selections } = req.body;
    if (!group_count || group_count < 1) return res.status(400).json({ error: 'group_count required' });
    if (!selections || selections.length === 0) return res.status(400).json({ error: 'No selections' });
    const qualifiedSels = selections.filter(s => s.selected);
    const qualifiedIds = qualifiedSels.map(s => s.event_entry_id);
    if (qualifiedIds.length === 0) return res.status(400).json({ error: 'No qualified athletes' });

    // WA Rule: max 8 athletes per heat for events ≤800m
    const isShortTrack = isShortTrackEvent(event.name);
    if (isShortTrack) {
        const maxPerHeat = 8;
        const requiredHeats = Math.ceil(qualifiedIds.length / maxPerHeat);
        if (group_count < requiredHeats) {
            return res.status(400).json({ error: `800m 이하 종목은 조당 최대 8명입니다. 최소 ${requiredHeats}개 조가 필요합니다.` });
        }
    }

    let semiEventId;
    await db.transaction(async () => {
        for (const sel of qualifiedSels) {
            await db.run(`INSERT INTO qualification_selection (event_id,event_entry_id,selected,approved,approved_by,qualification_type) VALUES (?,?,1,1,'admin',?)
                ON CONFLICT(event_id,event_entry_id) DO UPDATE SET selected=1,approved=1,qualification_type=excluded.qualification_type`, event.id, sel.event_entry_id, sel.qualification_type || '');
        }
        const info = await db.run(`INSERT INTO event (competition_id,name,category,gender,round_type,round_status) VALUES (?,?,?,?,'semifinal','heats_generated')`, event.competition_id, event.name, event.category, event.gender);
        semiEventId = info.lastInsertRowid;

        // Fetch the newly created semi event for scoreboard key generation
        const semiEvent = await db.get('SELECT * FROM event WHERE id=?', semiEventId);

        // WA serpentine seeding: sort athletes by performance, distribute in zigzag
        const seeded = await waSeededDistribution(event, qualifiedSels, group_count, db);
        for (let g = 0; g < group_count; g++) {
            const heatInfo = await db.run('INSERT INTO heat (event_id,heat_number) VALUES (?,?)', semiEventId, g + 1);
            // Auto-generate scoreboard_key
            const sbKey = await generateScoreboardKey(semiEvent, g + 1, db, group_count);
            await db.run('UPDATE heat SET scoreboard_key=? WHERE id=?', sbKey, heatInfo.lastInsertRowid);
            const groupAthletes = seeded[g] || [];
            // Sort within group by performance for correct WA lane assignment
            groupAthletes.sort((a, b) => (a.seedRank || 0) - (b.seedRank || 0) || a.perf - b.perf);   // 시드 순서 유지 (레인 그룹 추첨 기준)
            const lanes = waAssignLanesBulk(groupAthletes, groupAthletes.length, isShortTrack, event.name);
            for (let idx = 0; idx < groupAthletes.length; idx++) {
                const ath = groupAthletes[idx];
                const newEntry = await db.run("INSERT INTO event_entry (event_id,athlete_id,status) VALUES (?,?,'registered')", semiEventId, ath.athlete_id);
                await db.run('INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES (?,?,?)', heatInfo.lastInsertRowid, newEntry.lastInsertRowid, lanes[idx]);
            }
        }
    })();
    opLog(`${event.name} 준결승 생성 (${qualifiedIds.length}명, ${group_count}개 조)`, 'round', 'system', event.competition_id);
    // SSE broadcast so dashboard/results pages pick up the new semifinal event
    broadcastSSE('event_status_changed', { event_id: semiEventId, round_status: 'heats_generated' });
    // 시간표 자동 재매칭 (준결승 라운드가 새로 생겼으므로 시간표의 "준결승" 행과 연결 가능)
    try { await autoLinkDisplayTimetable(event.competition_id); } catch(autoErr) { console.warn('[autoLink after semifinal] ', autoErr.message); }
    res.json({ success: true, semi_event_id: semiEventId, count: qualifiedIds.length });
});
app.delete('/api/events/:id', async (req, res) => {
    const { admin_key } = req.body;
    if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    const event = await db.get('SELECT * FROM event WHERE id=?', req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    // FIX: 노출용(display) 모드 대회는 자동 결승 생성 로직이 없으므로 예선 삭제 허용
    // 운영용(operation) 대회에서만 예선 삭제 보호 가드 적용
    const _comp = await db.get('SELECT mode FROM competition WHERE id=?', event.competition_id);
    const _isDisplayMode = _comp && _comp.mode === 'display';
    if (!_isDisplayMode && event.round_type === 'preliminary' && !event.parent_event_id) {
        return res.status(400).json({ error: '예선은 삭제할 수 없습니다.' });
    }
    await db.transaction(async () => {
        const heats = await db.all('SELECT id FROM heat WHERE event_id=?', event.id);
        for (const h of heats) {
            await db.run('DELETE FROM result WHERE heat_id=?', h.id);
            await db.run('DELETE FROM height_attempt WHERE heat_id=?', h.id);
            await db.run('DELETE FROM heat_entry WHERE heat_id=?', h.id);
        }
        await db.run('DELETE FROM heat WHERE event_id=?', event.id);
        await db.run('DELETE FROM relay_member WHERE event_entry_id IN (SELECT id FROM event_entry WHERE event_id=?)', event.id);
        await db.run('DELETE FROM event_entry WHERE event_id=?', event.id);
        await db.run('DELETE FROM qualification_selection WHERE event_id=?', event.id);
        await db.run('DELETE FROM event WHERE id=?', event.id);
    })();
    res.json({ success: true });
});

// ============================================================
// COMBINED (10종/7종) SUB-EVENT CRUD
// ============================================================

// GET /api/events/:id/sub-events — List sub-events of a combined parent
app.get('/api/events/:id/sub-events', async (req, res) => {
    const parent = await db.get('SELECT * FROM event WHERE id=?', req.params.id);
    if (!parent) return res.status(404).json({ error: 'Event not found' });
    if (parent.category !== 'combined') return res.status(400).json({ error: '혼성경기(combined)만 세부종목을 가질 수 있습니다.' });
    const subs = await db.all('SELECT * FROM event WHERE parent_event_id=? ORDER BY sort_order, id', parent.id);
    // Enrich with entry_count and heat_count — PG-safe batch query
    if (subs.length > 0) {
        const ids = subs.map(s => s.id);
        const ph = ids.map(() => '?').join(',');
        const entryCounts = await db.all(`SELECT event_id, COUNT(*) as cnt FROM event_entry WHERE event_id IN (${ph}) GROUP BY event_id`, ...ids);
        const heatCounts = await db.all(`SELECT event_id, COUNT(*) as cnt FROM heat WHERE event_id IN (${ph}) GROUP BY event_id`, ...ids);
        const entryMap = new Map(entryCounts.map(c => [c.event_id, Number(c.cnt)]));
        const heatMap = new Map(heatCounts.map(c => [c.event_id, Number(c.cnt)]));
        subs.forEach(s => {
            s.entry_count = entryMap.get(s.id) || 0;
            s.heat_count = heatMap.get(s.id) || 0;
        });
    }
    res.json(subs);
});

// POST /api/events/:id/sub-events — Add a sub-event to a combined parent
app.post('/api/events/:id/sub-events', async (req, res) => {
    const { admin_key, name, category } = req.body;
    if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    const parent = await db.get('SELECT * FROM event WHERE id=?', req.params.id);
    if (!parent) return res.status(404).json({ error: 'Event not found' });
    if (parent.category !== 'combined') return res.status(400).json({ error: '혼성경기만 세부종목을 추가할 수 있습니다.' });
    if (!name || !category) return res.status(400).json({ error: '종목명과 카테고리는 필수입니다.' });

    const validCats = ['track', 'field_distance', 'field_height'];
    if (!validCats.includes(category)) return res.status(400).json({ error: '세부종목 카테고리는 track, field_distance, field_height 중 하나여야 합니다.' });

    // Determine prefix from parent name
    const prefix = parent.name.includes('10종') ? '[10종]' : parent.name.includes('7종') ? '[7종]' : `[${parent.name}]`;
    const subName = name.startsWith('[') ? name : `${prefix} ${name}`;

    // Get next sort_order
    const maxSort = await db.get('SELECT MAX(sort_order) AS m FROM event WHERE parent_event_id=?', parent.id);
    const nextSort = (maxSort?.m || 0) + 1;

    let subEventId;
    await db.transaction(async () => {
        const info = await db.run('INSERT INTO event (competition_id,name,category,gender,round_type,round_status,parent_event_id,sort_order) VALUES (?,?,?,?,?,?,?,?)', parent.competition_id, subName, category, parent.gender, 'final', 'heats_generated', parent.id, nextSort);
        subEventId = info.lastInsertRowid;

        // Copy athletes from parent
        const parentEntries = await db.all('SELECT id, athlete_id FROM event_entry WHERE event_id=?', parent.id);
        for (const pe of parentEntries) {
            await db.run('INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?, ?, ?)', subEventId, pe.athlete_id, 'registered');
        }

        // Create 1 heat and assign all athletes
        const heatInfo = await db.run('INSERT INTO heat (event_id, heat_number) VALUES (?, 1)', subEventId);
        const subEntries = await db.all('SELECT id FROM event_entry WHERE event_id=?', subEventId);
        for (let idx = 0; idx < subEntries.length; idx++) {
            const se = subEntries[idx];
            await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?, ?, ?)', heatInfo.lastInsertRowid, se.id, idx + 1);
        }
    })();

    opLog(`세부종목 추가: ${subName} (부모: ${parent.name})`, 'event', 'admin', parent.competition_id);
    const created = await db.get('SELECT * FROM event WHERE id=?', subEventId);
    res.json({ success: true, sub_event: created });
});

// PUT /api/events/:id/sub-events/:subId — Update a sub-event (name, category, sort_order)
app.put('/api/events/:id/sub-events/:subId', async (req, res) => {
    const { admin_key, name, category, sort_order } = req.body;
    if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    const parent = await db.get('SELECT * FROM event WHERE id=?', req.params.id);
    if (!parent) return res.status(404).json({ error: 'Parent event not found' });
    const sub = await db.get('SELECT * FROM event WHERE id=? AND parent_event_id=?', req.params.subId, parent.id);
    if (!sub) return res.status(404).json({ error: 'Sub-event not found' });

    const updates = [];
    const params = [];
    if (name !== undefined) {
        const prefix = parent.name.includes('10종') ? '[10종]' : parent.name.includes('7종') ? '[7종]' : `[${parent.name}]`;
        const subName = name.startsWith('[') ? name : `${prefix} ${name}`;
        updates.push('name=?');
        params.push(subName);
    }
    if (category !== undefined) {
        const validCats = ['track', 'field_distance', 'field_height'];
        if (!validCats.includes(category)) return res.status(400).json({ error: '유효하지 않은 카테고리' });
        updates.push('category=?');
        params.push(category);
    }
    if (sort_order !== undefined) {
        updates.push('sort_order=?');
        params.push(sort_order);
    }
    if (updates.length === 0) return res.status(400).json({ error: '수정할 항목이 없습니다.' });

    params.push(sub.id);
    await db.run(`UPDATE event SET ${updates.join(',')} WHERE id=?`, ...params);
    const updated = await db.get('SELECT * FROM event WHERE id=?', sub.id);
    res.json({ success: true, sub_event: updated });
});

// DELETE /api/events/:parentId/sub-events/:subId — Delete a sub-event
app.delete('/api/events/:id/sub-events/:subId', async (req, res) => {
    const { admin_key } = req.body;
    if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    const parent = await db.get('SELECT * FROM event WHERE id=?', req.params.id);
    if (!parent) return res.status(404).json({ error: 'Parent event not found' });
    const sub = await db.get('SELECT * FROM event WHERE id=? AND parent_event_id=?', req.params.subId, parent.id);
    if (!sub) return res.status(404).json({ error: 'Sub-event not found' });

    await db.transaction(async () => {
        const heats = await db.all('SELECT id FROM heat WHERE event_id=?', sub.id);
        for (const h of heats) {
            await db.run('DELETE FROM result WHERE heat_id=?', h.id);
            await db.run('DELETE FROM height_attempt WHERE heat_id=?', h.id);
            await db.run('DELETE FROM heat_entry WHERE heat_id=?', h.id);
        }
        await db.run('DELETE FROM heat WHERE event_id=?', sub.id);
        await db.run('DELETE FROM event_entry WHERE event_id=?', sub.id);
        // sub_event_order는 sort_order rank (1-base, ORDER BY sort_order, id 기준)
        const subOrderRow = await db.get(
            'SELECT COUNT(*) as cnt FROM event WHERE parent_event_id=? AND (sort_order < ? OR (sort_order = ? AND id <= ?))',
            parent.id, sub.sort_order, sub.sort_order, sub.id
        );
        const subOrderRank = (subOrderRow && subOrderRow.cnt) || 0;
        if (subOrderRank > 0) {
            await db.run('DELETE FROM combined_score WHERE sub_event_order=? AND event_entry_id IN (SELECT id FROM event_entry WHERE event_id=?)', subOrderRank, parent.id);
        }
        await db.run('DELETE FROM event WHERE id=?', sub.id);
    })();
    opLog(`세부종목 삭제: ${sub.name} (부모: ${parent.name})`, 'event', 'admin', parent.competition_id);
    res.json({ success: true });
});

// POST /api/events/:id/sub-events/reorder — Reorder sub-events
app.post('/api/events/:id/sub-events/reorder', async (req, res) => {
    const { admin_key, order } = req.body; // order = [subEventId, subEventId, ...]
    if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    if (!order || !Array.isArray(order)) return res.status(400).json({ error: 'order 배열이 필요합니다.' });
    const parent = await db.get('SELECT * FROM event WHERE id=?', req.params.id);
    if (!parent) return res.status(404).json({ error: 'Parent event not found' });

    await db.transaction(async () => {
        for (let idx = 0; idx < order.length; idx++) {
            await db.run('UPDATE event SET sort_order=? WHERE id=? AND parent_event_id=?', idx + 1, order[idx], parent.id);
        }
    })();
    res.json({ success: true });
});

// POST /api/events/:id/sub-events/sync-athletes — Sync parent athletes to all sub-events
app.post('/api/events/:id/sub-events/sync-athletes', async (req, res) => {
    const { admin_key } = req.body;
    if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    const parent = await db.get('SELECT * FROM event WHERE id=?', req.params.id);
    if (!parent) return res.status(404).json({ error: 'Parent event not found' });

    const parentAthleteRows = await db.all('SELECT athlete_id FROM event_entry WHERE event_id=?', parent.id);
    const parentAthletes = parentAthleteRows.map(e => e.athlete_id);
    const subs = await db.all('SELECT id FROM event WHERE parent_event_id=?', parent.id);
    let addedCount = 0;

    await db.transaction(async () => {
        for (const sub of subs) {
            const existingAthleteRows = await db.all('SELECT athlete_id FROM event_entry WHERE event_id=?', sub.id);
            const existingAthletes = new Set(existingAthleteRows.map(e => e.athlete_id));
            for (const athId of parentAthletes) {
                if (!existingAthletes.has(athId)) {
                    const info = await db.run('INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?, ?, ?)', sub.id, athId, 'registered');
                    // Add to existing heat (heat 1)
                    const heat = await db.get('SELECT id FROM heat WHERE event_id=? ORDER BY heat_number LIMIT 1', sub.id);
                    if (heat) {
                        const laneCountRow = await db.get('SELECT COUNT(*) AS c FROM heat_entry WHERE heat_id=?', heat.id);
                        const laneCount = (laneCountRow && laneCountRow.c) || 0;
                        await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?, ?, ?)', heat.id, info.lastInsertRowid, laneCount + 1);
                    }
                    addedCount++;
                }
            }
        }
    })();

    res.json({ success: true, added: addedCount, sub_event_count: subs.length });
});

// POST /api/lanes/bulk-update — Update lane assignments by heat_entry_id
app.post('/api/lanes/bulk-update', async (req, res) => {
    const { assignments } = req.body;
    if (!assignments || !Array.isArray(assignments)) return res.status(400).json({ error: 'assignments array required' });

    try {
        await db.transaction(async () => {
            for (const a of assignments) {
                if (!a.heat_entry_id || !a.lane_number) continue;
                await db.run('UPDATE heat_entry SET lane_number = ? WHERE id = ?', a.lane_number, a.heat_entry_id);
            }
        })();
        res.json({ success: true, updated: assignments.length });
    } catch (err) {
        res.status(500).json({ error: '레인 업데이트 실패: ' + err.message });
    }
});

app.post('/api/lanes/assign', async (req, res) => {
    const { heat_id, assignments } = req.body;
    if (!heat_id || !assignments) return res.status(400).json({ error: 'Missing fields' });
    await db.transaction(async () => {
        for (const a of assignments) {
            await db.run('UPDATE heat_entry SET lane_number=? WHERE heat_id=? AND event_entry_id=?', a.lane_number, heat_id, a.event_entry_id);
        }
    })();
    res.json({ success: true });
});

// Update heat entries — batch move athletes between heats and update lane numbers
app.post('/api/admin/heats/update-entries', async (req, res) => {
    const { heat_id, entries, admin_key } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    if (!heat_id || !entries) return res.status(400).json({ error: 'Missing fields' });
    await db.transaction(async () => {
        for (const e of entries) {
            await db.run('UPDATE heat_entry SET lane_number=? WHERE heat_id=? AND event_entry_id=?', e.lane_number, heat_id, e.event_entry_id);
        }
    })();
    res.json({ success: true });
});

// Update sub_group (A/B) for a heat entry
app.post('/api/admin/heat-entry/set-group', async (req, res) => {
    const { heat_entry_id, event_entry_id, heat_id, sub_group, admin_key } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    const g = sub_group ? String(sub_group).toUpperCase() : null;
    if (heat_entry_id) {
        await db.run('UPDATE heat_entry SET sub_group=? WHERE id=?', g, heat_entry_id);
    } else if (heat_id && event_entry_id) {
        await db.run('UPDATE heat_entry SET sub_group=? WHERE heat_id=? AND event_entry_id=?', g, heat_id, event_entry_id);
    } else {
        return res.status(400).json({ error: 'heat_entry_id or (heat_id + event_entry_id) required' });
    }
    res.json({ success: true, sub_group: g });
});

// ============================================================
// ROUND STATUS
// ============================================================
app.get('/api/round-status', async (req, res) => {
    const compId = req.query.competition_id;
    let q = 'SELECT * FROM event WHERE parent_event_id IS NULL';
    const p = [];
    if (compId) { q += ' AND competition_id=?'; p.push(compId); }
    q += ' ORDER BY sort_order, id';
    const events = await db.all(q, ...p);
    const result = await Promise.all(events.map(async e => {
        const heats = await db.all('SELECT id FROM heat WHERE event_id=?', e.id);
        let totalEntries = 0, totalResults = 0;
        for (const h of heats) {
            const entRow = await db.get('SELECT COUNT(*) AS c FROM heat_entry WHERE heat_id=?', h.id);
            totalEntries += (entRow && entRow.c) || 0;
            const resRow = await db.get('SELECT COUNT(DISTINCT event_entry_id) AS c FROM result WHERE heat_id=?', h.id);
            totalResults += (resRow && resRow.c) || 0;
        }
        return { ...e, heat_count: heats.length, total_entries: totalEntries, total_results: totalResults };
    }));
    res.json(result);
});

// ============================================================
// FULL RESULTS EXPORT
// ============================================================
app.get('/api/events/:id/full-results', async (req, res) => {
    const event = await db.get('SELECT * FROM event WHERE id=?', req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    const heats = await db.all('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number', event.id);
    const quals = await db.all('SELECT * FROM qualification_selection WHERE event_id=? AND selected=1', event.id);
    const result = await Promise.all(heats.map(async h => {
        const entries = await db.all(`SELECT he.lane_number, he.sub_group, ee.id AS event_entry_id, ee.status, ee.manual_rank,
               a.name, a.bib_number, a.team FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id
               JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=? ORDER BY he.lane_number ASC, ${orderByBibSql('a.bib_number')}`, h.id);
        if (event.category === 'field_height') {
            return { ...h, entries, height_attempts: await db.all('SELECT * FROM height_attempt WHERE heat_id=? ORDER BY bar_height, event_entry_id, attempt_number', h.id) };
        }
        return { ...h, entries, results: await db.all('SELECT * FROM result WHERE heat_id=? ORDER BY event_entry_id, attempt_number', h.id) };
    }));
    res.json({ event, heats: result, qualifications: quals });
});

// ============================================================
// LOGS
// ============================================================
app.get('/api/audit-log', async (req, res) => {
    const compId = req.query.competition_id;
    if (compId) return res.json(await db.all('SELECT * FROM audit_log WHERE competition_id=? ORDER BY created_at DESC LIMIT 30', compId));
    res.json(await db.all('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 30'));
});
app.get('/api/operation-log', async (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const compId = req.query.competition_id;
    if (compId) return res.json(await db.all('SELECT * FROM operation_log WHERE competition_id=? ORDER BY created_at DESC LIMIT ?', compId, limit));
    res.json(await db.all('SELECT * FROM operation_log ORDER BY created_at DESC LIMIT ?', limit));
});

// ============================================================
// HEAT ENTRY — add athlete to heat (for post-heat-creation additions)
// ============================================================
app.post('/api/heat-entries/add', async (req, res) => {
    const { heat_id, athlete_id, event_id } = req.body;
    if (!heat_id || !athlete_id || !event_id) return res.status(400).json({ error: 'heat_id, athlete_id, event_id required' });
    // Validate heat belongs to the correct event
    const heat = await db.get('SELECT * FROM heat WHERE id=?', heat_id);
    if (!heat) return res.status(404).json({ error: 'Heat not found' });
    if (heat.event_id !== parseInt(event_id)) return res.status(400).json({ error: '조가 해당 종목에 속하지 않습니다.' });
    // Ensure event_entry exists (or create)
    let entry = await db.get('SELECT * FROM event_entry WHERE event_id=? AND athlete_id=?', event_id, athlete_id);
    if (!entry) {
        const info = await db.run('INSERT INTO event_entry (event_id, athlete_id) VALUES (?, ?)', event_id, athlete_id);
        entry = await db.get('SELECT * FROM event_entry WHERE id=?', info.lastInsertRowid);
    }
    // Check if already in heat
    const existing = await db.get('SELECT * FROM heat_entry WHERE heat_id=? AND event_entry_id=?', heat_id, entry.id);
    if (existing) return res.json({ success: true, already: true, entry });
    // Add to heat with next lane number
    const maxLaneRow = await db.get('SELECT MAX(lane_number) AS mx FROM heat_entry WHERE heat_id=?', heat_id);
    const maxLane = (maxLaneRow && maxLaneRow.mx) || 0;
    await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?, ?, ?)', heat_id, entry.id, maxLane + 1);
    broadcastSSE('entry_status', { event_entry_id: entry.id, status: entry.status });
    res.json({ success: true, entry });
});

// RELAY MEMBERS 라우트들은 lib/routes/relay_members.js 로 추출됨
require('./lib/routes/relay_members')(app, { db, orderByBibSql });

// ============================================================
// SSE
// ============================================================
app.get('/api/sse', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
    res.write('event: connected\ndata: {}\n\n');
    sseClients.push(res);
    // Keep-alive heartbeat every 30s to prevent proxy timeouts
    const heartbeat = setInterval(() => { try { res.write(':heartbeat\n\n'); } catch(e) { clearInterval(heartbeat); } }, 30000);
    req.on('close', () => { clearInterval(heartbeat); sseClients = sseClients.filter(c => c !== res); });
});

// ============================================================
// PUBLIC VIEWER
// ============================================================
app.get('/api/public/events', async (req, res) => {
    const compId = req.query.competition_id;
    // 대회를 지정해야 한다 — 예전엔 없으면 모든 대회의 모든 종목을 한 번에 내보냈다 (호출부 없음)
    if (!compId) return res.status(400).json({ error: 'competition_id 필요' });
    res.json(await db.all("SELECT * FROM event WHERE competition_id=? AND parent_event_id IS NULL ORDER BY sort_order, id", compId));
});
app.get('/api/public/callroom-status', async (req, res) => {
    const logs = await db.all("SELECT * FROM audit_log WHERE table_name='event' AND new_values LIKE '%callroom_complete%' ORDER BY created_at DESC LIMIT 50");
    const completedIds = new Set();
    logs.forEach(l => { try { const nv = JSON.parse(l.new_values); if (nv && nv.action === 'callroom_complete') completedIds.add(l.record_id); } catch {} });
    res.json({ completed_event_ids: Array.from(completedIds) });
});

// Public callroom monitor — 종목별 소집 현황 요약 (인증 불필요)
app.get('/api/public/callroom-summary', async (req, res) => {
    const compId = req.query.competition_id;
    if (!compId) return res.status(400).json({ error: 'competition_id 필요' });

    const events = await db.all("SELECT * FROM event WHERE competition_id=? AND parent_event_id IS NULL ORDER BY sort_order, id", compId);

    const result = await Promise.all(events.map(async evt => {
        const heats = await db.all('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number', evt.id);
        let totalEntries = 0, checkedIn = 0, noShow = 0;
        const heatDetails = await Promise.all(heats.map(async h => {
            const entries = await db.all(`
                SELECT ee.status, a.name, a.bib_number, a.team, he.lane_number, he.sub_group
                FROM heat_entry he
                JOIN event_entry ee ON ee.id = he.event_entry_id
                JOIN athlete a ON a.id = ee.athlete_id
                WHERE he.heat_id = ?
                ORDER BY he.lane_number
            `, h.id);
            const hCIn = entries.filter(e => e.status === 'checked_in').length;
            const hNS = entries.filter(e => e.status === 'no_show').length;
            totalEntries += entries.length;
            checkedIn += hCIn;
            noShow += hNS;
            return {
                heat_id: h.id,
                heat_number: h.heat_number,
                total: entries.length,
                checked_in: hCIn,
                no_show: hNS,
                pending: entries.length - hCIn - hNS,
                entries: entries.map(e => ({
                    name: e.name, bib: e.bib_number, team: e.team,
                    lane: e.lane_number, group: e.sub_group, status: e.status
                }))
            };
        }));
        return {
            event_id: evt.id,
            name: evt.name,
            gender: evt.gender,
            category: evt.category,
            round_type: evt.round_type,
            round_status: evt.round_status,
            total: totalEntries,
            checked_in: checkedIn,
            no_show: noShow,
            pending: totalEntries - checkedIn - noShow,
            heats: heatDetails
        };
    }));
    res.json(result);
});

// ============================================================
// ADMIN: KEY MANAGEMENT (supports multi-key with judge names)
// ============================================================
app.post('/api/admin/change-keys', (req, res) => {
    const { admin_key, new_operation_key, new_admin_key, new_admin_id, new_record_officer_key } = req.body;
    if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    // (2026-09) 짧은 값은 조용히 무시하던 것을 명시적 오류로. 최소 길이: 관리자 8 · 운영/기록위원 6, 흔한 값 금지
    const { _WEAK } = require('./lib/securityCheck');
    const weak = v => _WEAK.has(String(v).toLowerCase());
    if (new_admin_key && (String(new_admin_key).length < 8 || weak(new_admin_key))) return res.status(400).json({ error: '관리자 키는 8자 이상이고 흔한 값(1234, admin 등)이 아니어야 합니다.' });
    if (new_operation_key && (String(new_operation_key).length < 6 || weak(new_operation_key))) return res.status(400).json({ error: '운영키는 6자 이상이고 흔한 값(1234 등)이 아니어야 합니다.' });
    if (typeof new_record_officer_key === 'string' && new_record_officer_key.trim() !== '' && (new_record_officer_key.trim().length < 6 || weak(new_record_officer_key.trim()))) return res.status(400).json({ error: '기록위원 키는 6자 이상이고 흔한 값이 아니어야 합니다.' });
    const changed = [];
    if (new_operation_key) { setDefaultOperationKey(new_operation_key); changed.push('운영키'); }
    if (new_admin_key) { ACCESS_KEYS.admin = new_admin_key; changed.push('관리자 키'); }  // setter hashes automatically
    if (new_admin_id && new_admin_id.trim()) { setConfigKey('admin_id', new_admin_id.trim()); changed.push('관리자 ID'); }
    // Phase C 확장: 기록위원 키. 빈 문자열 명시 시 비활성
    if (typeof new_record_officer_key === 'string') { ACCESS_KEYS.recordOfficer = new_record_officer_key.trim(); changed.push(new_record_officer_key.trim() ? '기록위원 키' : '기록위원 키 비활성'); }
    if (changed.length) { try { opLog(`접근 키 변경: ${changed.join(', ')}`, 'security', getJudgeName(admin_key), null); } catch (e) {} _refreshDbSecurityWarnings(); }
    res.json({
        success: true,
        operation_key: new_operation_key || null,          // 새로 정한 키는 이번 응답에서 한 번만 보여준다
        operation_key_hint: getConfigKey('operation_key_hint', ''),
        admin_id: ADMIN_ID(),
        record_officer_key: ACCESS_KEYS.recordOfficer,
        record_officer_active: !!ACCESS_KEYS.recordOfficer,
    });
});
app.get('/api/admin/current-keys', (req, res) => {
    if (!isAdminKey(req.query.key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    res.json({
        operation: _opKeyIsHash(ACCESS_KEYS.operation) ? null : ACCESS_KEYS.operation,     // 해시 저장 뒤에는 평문을 보여줄 수 없다
        operation_hint: getConfigKey('operation_key_hint', _opKeyIsHash(ACCESS_KEYS.operation) ? '' : _opKeyHint(ACCESS_KEYS.operation)),
        admin_id: ADMIN_ID(),
        record_officer_key: ACCESS_KEYS.recordOfficer,
        record_officer_active: !!ACCESS_KEYS.recordOfficer,
    });
});
// Public endpoint: get registered judge/operator names (for callroom completion dropdown)
app.get('/api/registered-judges', async (req, res) => {
    const judges = await db.all('SELECT judge_name FROM operation_key WHERE active=1 ORDER BY judge_name');
    res.json(judges.map(j => j.judge_name));
});

// Multi-key CRUD
app.get('/api/admin/operation-keys', async (req, res) => {
    if (!isAdminKey(req.query.key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    res.json((await db.all('SELECT id, judge_name, key_value, key_hint, role, can_manage, active, created_at FROM operation_key ORDER BY created_at DESC')).map(r => ({ ...r, key_value: undefined, key_hint: r.key_hint || (_opKeyIsHash(r.key_value) ? '••••' : _opKeyHint(r.key_value)) })));
});
app.post('/api/admin/operation-keys', async (req, res) => {
    const { admin_key, judge_name, key_value, can_manage } = req.body;
    if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    if (!judge_name || !key_value || key_value.length < 4) return res.status(400).json({ error: '심판명과 키(4자 이상)를 입력하세요.' });
    try {
        if (_opKeyLookup(String(key_value)) || isDefaultOperationKey(String(key_value))) return res.status(400).json({ error: '이미 쓰이는 키입니다. 다른 키를 정하세요.' });
        const info = await db.run('INSERT INTO operation_key (judge_name, key_value, key_prefix, key_hint, can_manage) VALUES (?, ?, ?, ?, ?)', judge_name, bcrypt.hashSync(String(key_value), OPKEY_BCRYPT_COST), _opKeyPrefix(key_value), _opKeyHint(key_value), can_manage ? 1 : 0);
        await _reloadOpKeyCacheAsync();
        opLog(`운영키 생성: ${judge_name}${can_manage ? ' (관리권한)' : ''}`, 'admin', 'admin');
        const row = await db.get('SELECT id, judge_name, key_hint, role, can_manage, active, created_at FROM operation_key WHERE id=?', info.lastInsertRowid);
        res.json({ ...row, key_value: String(key_value), show_once: true });      // 평문은 이번 응답에서만
    } catch (e) { res.status(400).json({ error: '키 생성에 실패했습니다: ' + e.message }); }
});
// 재발급 — 심판이 키를 잊었을 때. 새 키를 만들어 한 번 보여주고 옛 키는 즉시 무효
app.post('/api/admin/operation-keys/:id/reissue', async (req, res) => {
    const { admin_key } = req.body;
    if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    const key = await db.get('SELECT * FROM operation_key WHERE id=?', req.params.id);
    if (!key) return res.status(404).json({ error: 'Not found' });
    const plain = crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, 'x').slice(0, 8).toLowerCase();
    await db.run('UPDATE operation_key SET key_value=?, key_prefix=?, key_hint=?, active=1 WHERE id=?', bcrypt.hashSync(plain, OPKEY_BCRYPT_COST), _opKeyPrefix(plain), _opKeyHint(plain), key.id);
    await _reloadOpKeyCacheAsync();
    opLog(`운영키 재발급: ${key.judge_name}`, 'admin', 'admin');
    res.json({ success: true, id: key.id, judge_name: key.judge_name, key_value: plain, key_hint: _opKeyHint(plain), show_once: true });
});
app.delete('/api/admin/operation-keys/:id', async (req, res) => {
    const { admin_key } = req.body;
    if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    const key = await db.get('SELECT * FROM operation_key WHERE id=?', req.params.id);
    if (!key) return res.status(404).json({ error: 'Not found' });
    await db.run('DELETE FROM operation_key WHERE id=?', req.params.id);
    await _reloadOpKeyCacheAsync();
    opLog(`운영키 삭제: ${key.judge_name}`, 'admin', 'admin');
    res.json({ success: true });
});

// ============================================================
// SITE CONFIG (editable install guide, manual, about texts & links)
// ============================================================
app.get('/api/site-config', async (req, res) => {
    // Public: returns all site_* config keys
    const rows = await db.all("SELECT key, value FROM system_config WHERE key LIKE 'site_%'");
    const config = {};
    rows.forEach(r => { config[r.key] = r.value; });
    res.json(config);
});
app.post('/api/admin/site-config', async (req, res) => {
    const { admin_key, configs } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '운영키가 필요합니다.' });
    if (!configs || typeof configs !== 'object') return res.status(400).json({ error: 'configs object required' });
    await db.transaction(async () => {
        for (const [k, v] of Object.entries(configs)) {
            if (k.startsWith('site_')) await db.run('INSERT INTO system_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, String(v));
        }
    })();
    opLog('사이트 설정 업데이트', 'admin', 'admin');
    res.json({ success: true });
});
app.patch('/api/admin/operation-keys/:id', async (req, res) => {
    const { admin_key, active, can_manage } = req.body;
    if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    const key = await db.get('SELECT * FROM operation_key WHERE id=?', req.params.id);
    if (!key) return res.status(404).json({ error: 'Not found' });
    const newActive = active !== undefined ? (active ? 1 : 0) : key.active;
    const newCanManage = can_manage !== undefined ? (can_manage ? 1 : 0) : key.can_manage;
    await db.run('UPDATE operation_key SET active=?, can_manage=? WHERE id=?', newActive, newCanManage, req.params.id);
    await _reloadOpKeyCacheAsync();
    const updated = await db.get('SELECT * FROM operation_key WHERE id=?', req.params.id);
    if (can_manage !== undefined) {
        opLog(`${key.judge_name} 심판 권한 변경: ${newCanManage ? '관리자' : '운영'}`, 'admin', 'admin');
    }
    res.json(updated);
});

// ============================================================
// PUBLIC: Athletes by competition (callroom / record use)
// ============================================================
app.get('/api/athletes', async (req, res) => {
    const compId = req.query.competition_id;
    if (!compId) return res.status(400).json({ error: 'competition_id 필요' });
    res.json(await db.all(`SELECT * FROM athlete WHERE competition_id=? ORDER BY ${orderByBibSql()}, id`, compId));
});

// Athlete entries — list events an athlete is entered in
app.get('/api/athletes/:id/entries', async (req, res) => {
    const athleteId = req.params.id;
    try {
        const rows = await db.all(`
            SELECT ee.id as event_entry_id, ee.event_id, ee.status,
                   e.name as event_name, e.round_type, e.category, e.gender,
                   he.heat_id, he.lane_number,
                   h.heat_number
            FROM event_entry ee
            JOIN event e ON e.id = ee.event_id
            LEFT JOIN heat_entry he ON he.event_entry_id = ee.id
            LEFT JOIN heat h ON h.id = he.heat_id
            WHERE ee.athlete_id = ?
            ORDER BY e.sort_order, e.name
        `, athleteId);
        res.json(rows);
    } catch (e) { res.json([]); }
});

// ============================================================
// ADMIN: ATHLETE CRUD (scoped to competition)
// ============================================================
app.get('/api/admin/athletes', async (req, res) => {
    if (!isAdminKey(req.query.key) && !isOperationKey(req.query.key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    const compId = req.query.competition_id;
    if (compId) return res.json(await db.all(`SELECT * FROM athlete WHERE competition_id=? ORDER BY ${orderByBibSql()}`, compId));
    res.json(await db.all(`SELECT * FROM athlete ORDER BY ${orderByBibSql()}`));
});
// 전화번호 정규화 (CRUD 공용)
function _normalizeAthletePhone(p) {
    if (p === undefined || p === null) return '';
    let s = String(p).trim();
    if (!s) return '';
    s = s.replace(/[^0-9+]/g, '');
    if (s.startsWith('+82')) s = '0' + s.slice(3);
    else if (s.startsWith('82') && s.length >= 11) s = '0' + s.slice(2);
    if (/^1\d{9}$/.test(s)) s = '0' + s;
    return s;
}

app.post('/api/admin/athletes', async (req, res) => {
    const { admin_key, competition_id, name, bib_number, team, gender, barcode, phone } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    if (!name || !gender || !competition_id) return res.status(400).json({ error: '필수 항목이 누락되었습니다 (이름, 성별, 대회ID).' });
    try {
        const bib = bib_number ? String(bib_number).trim() : null;
        const bc = barcode || '';
        const ph = _normalizeAthletePhone(phone);
        const info = await db.run('INSERT INTO athlete (competition_id,name,bib_number,team,barcode,gender,phone) VALUES (?,?,?,?,?,?,?)', competition_id, name, bib, team || '', bc, gender, ph);
        res.json(await db.get('SELECT * FROM athlete WHERE id=?', info.lastInsertRowid));
    } catch (e) { res.status(400).json({ error: '등록 오류: ' + e.message }); }
});
app.put('/api/admin/athletes/:id', async (req, res) => {
    const { admin_key, name, bib_number, team, gender, barcode, phone } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    const old = await db.get('SELECT * FROM athlete WHERE id=?', req.params.id);
    if (!old) return res.status(404).json({ error: 'Not found' });
    try {
        const newBib = bib_number !== undefined ? (bib_number ? String(bib_number).trim() : null) : old.bib_number;
        const newPhone = phone !== undefined ? _normalizeAthletePhone(phone) : (old.phone || '');
        await db.run('UPDATE athlete SET name=?,bib_number=?,team=?,gender=?,barcode=?,phone=? WHERE id=?', name || old.name, newBib, team ?? old.team, gender || old.gender, barcode ?? old.barcode, newPhone, old.id);
        res.json(await db.get('SELECT * FROM athlete WHERE id=?', old.id));
    } catch (e) { res.status(400).json({ error: '수정 오류: ' + e.message }); }
});
app.delete('/api/admin/athletes/:id', async (req, res) => {
    const { admin_key } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    const ath = await db.get('SELECT * FROM athlete WHERE id=?', req.params.id);
    if (!ath) return res.status(404).json({ error: 'Not found' });
    await db.transaction(async () => {
        const entries = await db.all('SELECT id FROM event_entry WHERE athlete_id=?', ath.id);
        for (const e of entries) {
            await db.run('DELETE FROM result WHERE event_entry_id=?', e.id);
            await db.run('DELETE FROM height_attempt WHERE event_entry_id=?', e.id);
            await db.run('DELETE FROM heat_entry WHERE event_entry_id=?', e.id);
            await db.run('DELETE FROM combined_score WHERE event_entry_id=?', e.id);
            await db.run('DELETE FROM qualification_selection WHERE event_entry_id=?', e.id);
        }
        await db.run('DELETE FROM relay_member WHERE event_entry_id IN (SELECT id FROM event_entry WHERE athlete_id=?)', ath.id);
        await db.run('DELETE FROM event_entry WHERE athlete_id=?', ath.id);
        await db.run('DELETE FROM athlete WHERE id=?', ath.id);
    })();
    res.json({ success: true });
});

// ---- Athlete ↔ Event Assignment ----
app.get('/api/admin/athletes/:id/events', async (req, res) => {
    if (!isAdminKey(req.query.key) && !isOperationKey(req.query.key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    res.json(await db.all(`
        SELECT ee.id AS event_entry_id, ee.event_id, ee.status, e.name AS event_name, e.category, e.gender, e.round_type
        FROM event_entry ee JOIN event e ON e.id=ee.event_id
        WHERE ee.athlete_id=? ORDER BY e.sort_order, e.id
    `, req.params.id));
});
app.post('/api/admin/athletes/:id/events', async (req, res) => {
    const { admin_key, event_id } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    const ath = await db.get('SELECT * FROM athlete WHERE id=?', req.params.id);
    if (!ath) return res.status(404).json({ error: 'Athlete not found' });
    const evt = await db.get('SELECT * FROM event WHERE id=?', event_id);
    if (!evt) return res.status(404).json({ error: 'Event not found' });

    // For relay events: add athlete as relay_member to existing team, don't create new team
    if (evt.category === 'relay') {
        // Find existing team entry for this athlete's team
        const teamName = ath.team || ath.name;
        const existingTeamEntry = await db.get(`
            SELECT ee.id FROM event_entry ee
            JOIN athlete a ON a.id = ee.athlete_id
            WHERE ee.event_id = ? AND a.name = ?
        `, event_id, teamName);

        if (existingTeamEntry) {
            // Add as relay member to existing team
            const existingMember = await db.get('SELECT id FROM relay_member WHERE event_entry_id=? AND athlete_id=?', existingTeamEntry.id, ath.id);
            if (existingMember) return res.status(409).json({ error: '이미 등록된 릴레이 멤버입니다.' });
            const maxLegRow = await db.get('SELECT MAX(leg_order) AS mx FROM relay_member WHERE event_entry_id=?', existingTeamEntry.id);
            const maxLeg = (maxLegRow && maxLegRow.mx) || 0;
            await db.run('INSERT OR IGNORE INTO relay_member (event_entry_id, athlete_id, leg_order) VALUES (?,?,?)', existingTeamEntry.id, ath.id, maxLeg + 1);
            return res.json({ success: true, event_entry_id: existingTeamEntry.id, added_as: 'relay_member' });
        }
        // No existing team → create a dummy team athlete and add this athlete as relay_member
        const rGender = evt.gender === 'X' ? 'M' : evt.gender;
        let teamAthlete = await db.get('SELECT * FROM athlete WHERE competition_id=? AND name=? AND bib_number=?', evt.competition_id, teamName, teamName);
        if (!teamAthlete) {
            const teamInfo = await db.run('INSERT INTO athlete (competition_id,name,bib_number,team,barcode,gender) VALUES (?,?,?,?,?,?)', evt.competition_id, teamName, teamName, teamName, `RELAY_${teamName}`, rGender);
            teamAthlete = await db.get('SELECT * FROM athlete WHERE id=?', teamInfo.lastInsertRowid);
        }
        // Create event_entry for the team
        let teamEntry = await db.get('SELECT id FROM event_entry WHERE event_id=? AND athlete_id=?', event_id, teamAthlete.id);
        if (!teamEntry) {
            const teInfo = await db.run("INSERT INTO event_entry (event_id,athlete_id,status) VALUES (?,?,'registered')", event_id, teamAthlete.id);
            teamEntry = { id: teInfo.lastInsertRowid };
            // Assign to first heat
            let heat = await db.get('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number LIMIT 1', event_id);
            if (!heat) {
                const hInfo = await db.run('INSERT INTO heat (event_id, heat_number) VALUES (?, 1)', event_id);
                heat = { id: hInfo.lastInsertRowid };
            }
            const maxLaneRow = await db.get('SELECT MAX(lane_number) AS mx FROM heat_entry WHERE heat_id=?', heat.id);
            const maxLane = (maxLaneRow && maxLaneRow.mx) || 0;
            await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?, ?, ?)', heat.id, teamEntry.id, maxLane + 1);
        }
        // Add the athlete as relay member
        await db.run('INSERT OR IGNORE INTO relay_member (event_entry_id, athlete_id, leg_order) VALUES (?,?,?)', teamEntry.id, ath.id, 1);
        return res.json({ success: true, event_entry_id: teamEntry.id, added_as: 'relay_member_new_team' });
    }

    const exists = await db.get('SELECT id FROM event_entry WHERE event_id=? AND athlete_id=?', event_id, ath.id);
    if (exists) return res.status(409).json({ error: '이미 등록된 종목입니다.' });

    await db.transaction(async () => {
        // 1. Create event_entry
        const info = await db.run("INSERT INTO event_entry (event_id,athlete_id,status) VALUES (?,?,'registered')", event_id, ath.id);
        const entryId = info.lastInsertRowid;

        // 2. Auto-assign to first heat (create heat if none exists)
        let heat = await db.get('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number LIMIT 1', event_id);
        if (!heat) {
            const hInfo = await db.run('INSERT INTO heat (event_id, heat_number) VALUES (?, 1)', event_id);
            heat = { id: hInfo.lastInsertRowid };
        }
        // Determine next lane number
        const maxLaneRow = await db.get('SELECT MAX(lane_number) AS mx FROM heat_entry WHERE heat_id=?', heat.id);
        const maxLane = (maxLaneRow && maxLaneRow.mx) || 0;
        await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?, ?, ?)', heat.id, entryId, maxLane + 1);

        audit('event_entry', entryId, 'INSERT', null, { event_id, athlete_id: ath.id }, 'admin', evt.competition_id, req);
        broadcastSSE('entry_status', { event_entry_id: entryId, status: 'registered' });
    })();

    const eeRow = await db.get('SELECT id FROM event_entry WHERE event_id=? AND athlete_id=?', event_id, ath.id);
    res.json({ success: true, event_entry_id: eeRow ? eeRow.id : null });
});
app.delete('/api/admin/athletes/:athleteId/events/:entryId', async (req, res) => {
    const { admin_key } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    const entry = await db.get('SELECT * FROM event_entry WHERE id=?', req.params.entryId);
    if (!entry) return res.status(404).json({ error: 'Entry not found' });
    await db.transaction(async () => {
        await db.run('DELETE FROM result WHERE event_entry_id=?', entry.id);
        await db.run('DELETE FROM height_attempt WHERE event_entry_id=?', entry.id);
        await db.run('DELETE FROM heat_entry WHERE event_entry_id=?', entry.id);
        await db.run('DELETE FROM combined_score WHERE event_entry_id=?', entry.id);
        await db.run('DELETE FROM qualification_selection WHERE event_entry_id=?', entry.id);
        await db.run('DELETE FROM relay_member WHERE event_entry_id=?', entry.id);
        await db.run('DELETE FROM event_entry WHERE id=?', entry.id);
    })();
    res.json({ success: true });
});

// ============================================================
// ADMIN: EVENT CRUD
// ============================================================
app.get('/api/admin/events', async (req, res) => {
    if (!isAdminKey(req.query.key) && !isOperationKey(req.query.key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    const compId = req.query.competition_id;
    if (compId) return res.json(await db.all('SELECT * FROM event WHERE competition_id=? ORDER BY sort_order, id', compId));
    res.json(await db.all('SELECT * FROM event ORDER BY sort_order, id'));
});
// Standard athletics event order (WA + KAAF) - reusable
// Order: Sprints(100~400) → Middle(800~1500) → Long(3000~10000) → Hurdles → SC → Walks(track) → Road → Jumps → Throws → Combined → Relays
const STANDARD_EVENT_ORDER = [
    // Sprints
    '100m','200m','400m',
    // Middle distance
    '800m','1500m','1마일','Mile',
    // Long distance
    '3000m','5000m','10000m',
    // Hurdles
    '100mH','110mH','400mH',
    // Steeplechase
    '2000mSC','3000mSC',
    // Track walks
    '3000mW','5000mW','10000mW',
    // Road walks
    '20kmW','35kmW','50kmW',
    // Road running
    '하프마라톤','마라톤',
    // Vertical jumps
    '높이뛰기','장대높이뛰기',
    // Horizontal jumps
    '멀리뛰기','세단뛰기',
    // Throws
    '포환던지기','원반던지기','해머던지기','창던지기',
    // Combined
    '5종경기','7종경기','10종경기',
    // Relays
    '4x100mR','4x400mR','4x400mR(혼성)','4x800mR','4x1500mR',
];
// Normalize event name for robust matching (whitespace removed, lowercase, unified relay/walk/hurdle/SC/marathon tokens)
function _normEvtName(s) {
    if (!s) return '';
    let t = String(s).trim().toLowerCase();
    // Unify relay multiplication signs and remove spaces
    t = t.replace(/[×x✕✖＊*]/g, 'x');
    t = t.replace(/\s+/g, '');
    t = t.replace(/,/g, '');
    // Relay normalization: "4x100m릴레이" / "4x100r" → "4x100mr"
    t = t.replace(/(\d+)x(\d+)m?릴레이/g, '$1x$2mr');
    t = t.replace(/(\d+)x(\d+)r(?![a-z0-9])/g, '$1x$2mr');
    // Mixed relay
    t = t.replace(/mixed/g, '혼성');
    t = t.replace(/\(mix\)/g, '(혼성)');
    // If "혼성" appears before a relay token, convert to suffix form: "혼성4x400mr" → "4x400mr(혼성)"
    t = t.replace(/혼성(\d+x\d+mr)/g, '$1(혼성)');
    // Walk normalization: "20km경보" / "20킬로경보" → "20kmw"
    t = t.replace(/(\d+)\s*km\s*(?:경보|w)\b/gi, '$1kmw');
    t = t.replace(/(\d+)\s*m\s*(?:경보|w)\b/gi, '$1mw');
    t = t.replace(/(\d+)킬로경보/g, '$1kmw');
    t = t.replace(/경보/g, 'w');
    // Hurdles: "100m허들" → "100mh"
    t = t.replace(/(\d+)m?허들/g, '$1mh');
    t = t.replace(/허들/g, 'h');
    // Steeplechase: "3000m장애물" → "3000msc"
    t = t.replace(/(\d+)m?장애물/g, '$1msc');
    t = t.replace(/장애물/g, 'sc');
    // Marathon variants
    t = t.replace(/하프\s*마라톤/g, '하프마라톤');
    t = t.replace(/halfmarathon/g, '하프마라톤');
    t = t.replace(/marathon/g, '마라톤');
    return t;
}
function getStandardSortOrder(eventName) {
    if (!eventName) return 9990;
    const normTarget = _normEvtName(eventName);
    // 1) Exact match (after normalization)
    let idx = STANDARD_EVENT_ORDER.findIndex(s => _normEvtName(s) === normTarget);
    if (idx >= 0) return (idx + 1) * 10;
    // 2) Pattern-based fallback by category keyword
    //    Use regex to avoid the "100m matches 100mH" trap
    const patterns = [
        // Track walks
        { re: /^(\d+)mw$/, get: m => `${m[1]}mw` },
        // Road walks
        { re: /^(\d+)kmw$/, get: m => `${m[1]}kmw` },
        // Hurdles
        { re: /^(\d+)mh$/, get: m => `${m[1]}mh` },
        // Steeplechase
        { re: /^(\d+)msc$/, get: m => `${m[1]}msc` },
        // Relays
        { re: /^(\d+)x(\d+)mr(\(혼성\))?$/, get: m => `${m[1]}x${m[2]}mr${m[3]||''}` },
        // Plain track distance
        { re: /^(\d+)m$/, get: m => `${m[1]}m` },
    ];
    for (const p of patterns) {
        const mt = normTarget.match(p.re);
        if (!mt) continue;
        const probe = p.get(mt);
        const j = STANDARD_EVENT_ORDER.findIndex(s => _normEvtName(s) === probe);
        if (j >= 0) return (j + 1) * 10;
    }
    // 3) Substring fallback - but exclude track-distance vs hurdle/walk/SC confusion
    //    Only allow substring match if normalized target does NOT contain extra suffixes
    const safeForSubstr = !/[hwc]|sc|mr/.test(normTarget) || /^(\d+)(m|km)/.test(normTarget) === false;
    if (safeForSubstr) {
        idx = STANDARD_EVENT_ORDER.findIndex(s => {
            const ns = _normEvtName(s);
            return ns.length >= 2 && (normTarget.includes(ns) || ns.includes(normTarget));
        });
        if (idx >= 0) return (idx + 1) * 10;
    }
    return 9990;
}
async function autoSortCompetitionEvents(competitionId) {
    const events = await db.all('SELECT * FROM event WHERE competition_id=? AND parent_event_id IS NULL', competitionId);
    await db.transaction(async () => {
        for (const evt of events) {
            const order = getStandardSortOrder(evt.name);
            await db.run('UPDATE event SET sort_order=? WHERE id=?', order, evt.id);
            await db.run('UPDATE event SET sort_order=? WHERE parent_event_id=?', order, evt.id);
        }
    })();
}

app.post('/api/admin/events', async (req, res) => {
    const { admin_key, competition_id, name, category, gender, round_type, sort_order, division, video_url, result_url } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    if (!name || !category || !gender || !competition_id) return res.status(400).json({ error: '필수 항목이 누락되었습니다.' });
    try {
        const autoOrder = sort_order || getStandardSortOrder(name);
        const info = await db.run('INSERT INTO event (competition_id,name,category,gender,round_type,round_status,sort_order,division,video_url,result_url) VALUES (?,?,?,?,?,?,?,?,?,?)', competition_id, name, category, gender, round_type || 'final', 'created', autoOrder, division || '', video_url || '', result_url || '');
        const evt = await db.get('SELECT * FROM event WHERE id=?', info.lastInsertRowid);
        await db.run('INSERT INTO heat (event_id,heat_number) VALUES (?,1)', evt.id);
        // 시간표 자동 재매칭 (새 종목이 생겼으므로 시간표의 매칭되지 않은 행과 연결 가능)
        try { await autoLinkDisplayTimetable(competition_id); } catch(autoErr) { console.warn('[autoLink after event create] ', autoErr.message); }
        res.json(evt);
    } catch (e) { res.status(400).json({ error: '추가 오류: ' + e.message }); }
});
app.put('/api/admin/events/:id', async (req, res) => {
    const { admin_key, name, category, gender, round_type, sort_order, round_status, video_url, division, result_url } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    const old = await db.get('SELECT * FROM event WHERE id=?', req.params.id);
    if (!old) return res.status(404).json({ error: 'Not found' });
    await db.run('UPDATE event SET name=?,category=?,gender=?,round_type=?,sort_order=?,round_status=?,video_url=?,division=?,result_url=? WHERE id=?', name || old.name, category || old.category, gender || old.gender, round_type || old.round_type, sort_order ?? old.sort_order, round_status || old.round_status, video_url ?? old.video_url ?? '', division ?? old.division ?? '', result_url ?? old.result_url ?? '', old.id);
    // 종목 이름/성별/라운드가 바뀌었을 가능성이 있으므로 시간표 재매칭 시도 (단 수동 매칭은 보호)
    if (name !== old.name || gender !== old.gender || round_type !== old.round_type) {
        try { await autoLinkDisplayTimetable(old.competition_id); } catch(autoErr) { console.warn('[autoLink after event update] ', autoErr.message); }
    }
    res.json(await db.get('SELECT * FROM event WHERE id=?', old.id));
});

// Event video URL (accessible by operation key holders)
app.put('/api/events/:id/video-url', async (req, res) => {
    const { key, video_url } = req.body;
    if (!isOperationKey(key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    const evt = await db.get('SELECT * FROM event WHERE id=?', req.params.id);
    if (!evt) return res.status(404).json({ error: 'Not found' });
    await db.run('UPDATE event SET video_url=? WHERE id=?', video_url || '', evt.id);
    res.json({ ok: true, video_url: video_url || '' });
});
app.get('/api/events/:id/video-url', async (req, res) => {
    const evt = await db.get('SELECT video_url FROM event WHERE id=?', req.params.id);
    if (!evt) return res.status(404).json({ error: 'Not found' });
    res.json({ video_url: evt.video_url || '' });
});

// Auto-sort events by standard athletics order (WA + KAAF)
// Allow operation key as well so on-site staff can trigger this without master admin key
app.post('/api/admin/events/auto-sort', async (req, res) => {
    const { admin_key, competition_id } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    if (!competition_id) return res.status(400).json({ error: 'competition_id 필요' });
    await autoSortCompetitionEvents(competition_id);
    const row = await db.get('SELECT COUNT(*) as cnt FROM event WHERE competition_id=? AND parent_event_id IS NULL', competition_id);
    const count = row ? row.cnt : 0;
    res.json({ success: true, message: `${count}개 종목 자동정렬 완료 (WA 표준 순서)` });
});

app.delete('/api/admin/events/:id', async (req, res) => {
    const { admin_key } = req.body;
    if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    const event = await db.get('SELECT * FROM event WHERE id=?', req.params.id);
    if (!event) return res.status(404).json({ error: 'Not found' });
    await db.transaction(async () => {
        const subs = await db.all('SELECT id FROM event WHERE parent_event_id=?', event.id);
        for (const sub of subs) {
            const subHeats = await db.all('SELECT id FROM heat WHERE event_id=?', sub.id);
            for (const h of subHeats) { await db.run('DELETE FROM result WHERE heat_id=?', h.id); await db.run('DELETE FROM height_attempt WHERE heat_id=?', h.id); await db.run('DELETE FROM heat_entry WHERE heat_id=?', h.id); }
            await db.run('DELETE FROM heat WHERE event_id=?', sub.id); await db.run('DELETE FROM relay_member WHERE event_entry_id IN (SELECT id FROM event_entry WHERE event_id=?)', sub.id); await db.run('DELETE FROM event_entry WHERE event_id=?', sub.id); await db.run('DELETE FROM event WHERE id=?', sub.id);
        }
        const heats = await db.all('SELECT id FROM heat WHERE event_id=?', event.id);
        for (const h of heats) { await db.run('DELETE FROM result WHERE heat_id=?', h.id); await db.run('DELETE FROM height_attempt WHERE heat_id=?', h.id); await db.run('DELETE FROM heat_entry WHERE heat_id=?', h.id); }
        await db.run('DELETE FROM heat WHERE event_id=?', event.id);
        await db.run('DELETE FROM relay_member WHERE event_entry_id IN (SELECT id FROM event_entry WHERE event_id=?)', event.id);
        await db.run('DELETE FROM combined_score WHERE event_entry_id IN (SELECT id FROM event_entry WHERE event_id=?)', event.id);
        await db.run('DELETE FROM qualification_selection WHERE event_id=?', event.id);
        await db.run('DELETE FROM event_entry WHERE event_id=?', event.id);
        await db.run('DELETE FROM event WHERE id=?', event.id);
    })();
    res.json({ success: true });
});

// ============================================================
// ADMIN: HEAT MANAGEMENT (merge, add, delete, move athlete)
// ============================================================
app.post('/api/admin/events/:id/add-heat', async (req, res) => {
    const { admin_key } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    const event = await db.get('SELECT * FROM event WHERE id=?', req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    const maxHeat = await db.get('SELECT MAX(heat_number) AS mx FROM heat WHERE event_id=?', event.id);
    const nextNum = (maxHeat.mx || 0) + 1;
    const info = await db.run('INSERT INTO heat (event_id, heat_number) VALUES (?, ?)', event.id, nextNum);
    res.json({ success: true, heat_id: info.lastInsertRowid, heat_number: nextNum });
});
app.delete('/api/admin/heats/:id', async (req, res) => {
    const { admin_key } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    const heat = await db.get('SELECT * FROM heat WHERE id=?', req.params.id);
    if (!heat) return res.status(404).json({ error: 'Heat not found' });
    await db.transaction(async () => {
        await db.run('DELETE FROM result WHERE heat_id=?', heat.id);
        await db.run('DELETE FROM height_attempt WHERE heat_id=?', heat.id);
        await db.run('DELETE FROM heat_entry WHERE heat_id=?', heat.id);
        await db.run('DELETE FROM heat WHERE id=?', heat.id);
    })();
    res.json({ success: true });
});
// Remove athlete from heat (without deleting event_entry — just unlink from heat)
app.post('/api/admin/heats/:id/remove-entry', async (req, res) => {
    const { admin_key, event_entry_id, delete_event_entry, force } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    const heat = await db.get('SELECT * FROM heat WHERE id=?', req.params.id);
    if (!heat) return res.status(404).json({ error: 'Heat not found' });
    const he = await db.get('SELECT * FROM heat_entry WHERE heat_id=? AND event_entry_id=?', req.params.id, event_entry_id);
    if (!he) return res.status(404).json({ error: '해당 선수가 이 조에 없습니다.' });

    // delete_event_entry=true 인 경우 결과 데이터 존재 여부 체크
    let removedResultCount = 0;
    if (delete_event_entry) {
        const r1 = await db.get('SELECT COUNT(*) AS n FROM result WHERE event_entry_id=?', event_entry_id);
        const r2 = await db.get('SELECT COUNT(*) AS n FROM height_attempt WHERE event_entry_id=?', event_entry_id);
        const r3 = await db.get('SELECT COUNT(*) AS n FROM combined_score WHERE event_entry_id=?', event_entry_id);
        removedResultCount = (r1?.n || 0) + (r2?.n || 0) + (r3?.n || 0);
        if (removedResultCount > 0 && !force) {
            return res.status(409).json({
                error: '기록 데이터가 존재합니다',
                detail: `이 선수에 ${removedResultCount}건의 기록이 저장되어 있습니다. 강제로 삭제하려면 force=true 와 함께 다시 요청하세요.`,
                result_count: removedResultCount,
                needs_force: true,
            });
        }
    }

    await db.transaction(async () => {
        // Remove from heat
        await db.run('DELETE FROM heat_entry WHERE heat_id=? AND event_entry_id=?', req.params.id, event_entry_id);
        // Optionally also delete the event_entry (full removal from event)
        if (delete_event_entry) {
            await db.run('DELETE FROM result WHERE event_entry_id=?', event_entry_id);
            await db.run('DELETE FROM height_attempt WHERE event_entry_id=?', event_entry_id);
            await db.run('DELETE FROM combined_score WHERE event_entry_id=?', event_entry_id);
            await db.run('DELETE FROM qualification_selection WHERE event_entry_id=?', event_entry_id);
            await db.run('DELETE FROM relay_member WHERE event_entry_id=?', event_entry_id);
            await db.run('DELETE FROM event_entry WHERE id=?', event_entry_id);
        }
    })();
    broadcastSSE('entry_status', { event_entry_id, status: 'removed' });
    res.json({ success: true, removed_results: removedResultCount });
});
app.post('/api/admin/heats/:id/move-entry', async (req, res) => {
    const { admin_key, event_entry_id, target_heat_id, lane_number } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    await db.transaction(async () => {
        // Remove from current heat
        await db.run('DELETE FROM heat_entry WHERE heat_id=? AND event_entry_id=?', req.params.id, event_entry_id);
        // Add to target heat
        await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?, ?, ?) ON CONFLICT(heat_id, event_entry_id) DO UPDATE SET lane_number=excluded.lane_number', target_heat_id, event_entry_id, lane_number || null);
    })();
    res.json({ success: true });
});
// Force event status change (admin override)
app.post('/api/admin/events/:id/force-status', async (req, res) => {
    const { admin_key, round_status, round_type } = req.body;
    if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    const event = await db.get('SELECT * FROM event WHERE id=?', req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    const updates = [];
    const params = [];
    if (round_status) { updates.push('round_status=?'); params.push(round_status); }
    if (round_type) { updates.push('round_type=?'); params.push(round_type); }
    if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });
    params.push(event.id);
    await db.run(`UPDATE event SET ${updates.join(',')} WHERE id=?`, ...params);
    opLog(`${event.name} 강제 상태변경: ${round_status || ''} ${round_type || ''}`, 'admin', 'admin', event.competition_id);
    broadcastSSE('event_reverted', { event_id: event.id });
    res.json({ success: true, event: await db.get('SELECT * FROM event WHERE id=?', event.id) });
});

// ============================================================
// ADMIN: DB RESET (per competition)
// ============================================================
app.post('/api/admin/reset-db', async (req, res) => {
    const { admin_key, competition_id } = req.body;
    if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    if (!competition_id) return res.status(400).json({ error: 'competition_id required' });
    await db.transaction(async () => {
        const events = await db.all('SELECT id FROM event WHERE competition_id=?', competition_id);
        for (const evt of events) {
            const heats = await db.all('SELECT id FROM heat WHERE event_id=?', evt.id);
            for (const h of heats) { await db.run('DELETE FROM result WHERE heat_id=?', h.id); await db.run('DELETE FROM height_attempt WHERE heat_id=?', h.id); await db.run('DELETE FROM heat_entry WHERE heat_id=?', h.id); }
            await db.run('DELETE FROM heat WHERE event_id=?', evt.id);
            await db.run('DELETE FROM relay_member WHERE event_entry_id IN (SELECT id FROM event_entry WHERE event_id=?)', evt.id);
            await db.run('DELETE FROM combined_score WHERE event_entry_id IN (SELECT id FROM event_entry WHERE event_id=?)', evt.id);
            await db.run('DELETE FROM qualification_selection WHERE event_id=?', evt.id);
            await db.run('DELETE FROM event_entry WHERE event_id=?', evt.id);
        }
        await db.run('DELETE FROM event WHERE competition_id=?', competition_id);
        await db.run('DELETE FROM athlete WHERE competition_id=?', competition_id);
    })();
    res.json({ success: true, message: '해당 대회 데이터가 초기화되었습니다.' });
});

// ============================================================
// ADMIN: BACKUP
// ============================================================
app.get('/api/admin/backup', async (req, res) => {
    if (!isOperationKey(req.query.key)) return res.status(403).json({ error: '운영키가 필요합니다.' });
    const format = req.query.format || 'json';
    const compId = req.query.competition_id;
    const tables = ['competition','event','athlete','event_entry','heat','heat_entry','result','height_attempt','combined_score','qualification_selection','relay_member','audit_log','operation_log'];
    const backup = {};
    for (const t of tables) {
        try {
            if (compId && t !== 'operation_log' && t !== 'audit_log') {
                // Scoped backup: filter by competition_id where possible
                if (t === 'competition') backup[t] = await db.all('SELECT * FROM competition WHERE id=?', compId);
                else if (t === 'event') backup[t] = await db.all('SELECT * FROM event WHERE competition_id=?', compId);
                else if (t === 'athlete') backup[t] = await db.all('SELECT * FROM athlete WHERE competition_id=?', compId);
                else if (t === 'event_entry') backup[t] = await db.all('SELECT ee.* FROM event_entry ee JOIN event e ON ee.event_id=e.id WHERE e.competition_id=?', compId);
                else if (t === 'heat') backup[t] = await db.all('SELECT h.* FROM heat h JOIN event e ON h.event_id=e.id WHERE e.competition_id=?', compId);
                else if (t === 'heat_entry') backup[t] = await db.all('SELECT he.* FROM heat_entry he JOIN heat h ON he.heat_id=h.id JOIN event e ON h.event_id=e.id WHERE e.competition_id=?', compId);
                else if (t === 'result') backup[t] = await db.all('SELECT r.* FROM result r JOIN heat h ON r.heat_id=h.id JOIN event e ON h.event_id=e.id WHERE e.competition_id=?', compId);
                else if (t === 'height_attempt') backup[t] = await db.all('SELECT ha.* FROM height_attempt ha JOIN heat h ON ha.heat_id=h.id JOIN event e ON h.event_id=e.id WHERE e.competition_id=?', compId);
                else if (t === 'combined_score') backup[t] = await db.all('SELECT cs.* FROM combined_score cs JOIN event_entry ee ON cs.event_entry_id=ee.id JOIN event e ON ee.event_id=e.id WHERE e.competition_id=?', compId);
                else if (t === 'qualification_selection') backup[t] = await db.all('SELECT qs.* FROM qualification_selection qs JOIN event e ON qs.event_id=e.id WHERE e.competition_id=?', compId);
                else if (t === 'relay_member') backup[t] = await db.all('SELECT rm.* FROM relay_member rm JOIN event_entry ee ON rm.event_entry_id=ee.id JOIN event e ON ee.event_id=e.id WHERE e.competition_id=?', compId);
                else backup[t] = await db.all(`SELECT * FROM ${t}`);
            } else {
                backup[t] = await db.all(`SELECT * FROM ${t}`);
            }
        } catch(e) { backup[t] = []; }
    }
    backup._timestamp = new Date().toISOString();

    if (format === 'xlsx') {
        // Excel format: each table as a sheet
        const wb = XLSX.utils.book_new();
        for (const [name, rows] of Object.entries(backup)) {
            if (name === '_timestamp' || !Array.isArray(rows) || rows.length === 0) continue;
            const ws = XLSX.utils.json_to_sheet(rows);
            XLSX.utils.book_append_sheet(wb, ws, name.substring(0, 31));
        }
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="pace-rise-backup-${new Date().toISOString().slice(0,10)}.xlsx"`);
        return res.send(buf);
    }

    // Default JSON
    res.setHeader('Content-Disposition', `attachment; filename="pace-rise-backup-${new Date().toISOString().slice(0,10)}.json"`);
    res.json(backup);
});

// ─── 파일 백업 (.db dump) 상태 조회 & 수동 트리거 ───────────────────────────
// performBackup() 로 만들어진 backups/*.db 들의 현황을 조회/관리.
// daily/hourly/startup/live/manual 태그별 통계, 최근 백업 목록, 다음 예정 시각 등.

app.get('/api/admin/db-backup/status', (req, res) => {
    if (!isOperationKey(req.query.key)) return res.status(403).json({ error: '운영키가 필요합니다.' });
    try {
        const files = fs.readdirSync(BACKUP_DIR)
            .filter(f => f.startsWith('backup_') && f.endsWith('.db'))
            .map(f => {
                const fpath = path.join(BACKUP_DIR, f);
                const st = fs.statSync(fpath);
                const m = f.match(/^backup_([^_]+)_(.+)\.db$/);
                return {
                    name: f, tag: m ? m[1] : 'unknown',
                    size: st.size, mtime: st.mtime,
                    ageMs: Date.now() - st.mtimeMs
                };
            })
            .sort((a, b) => b.mtime - a.mtime);

        const tagStats = {};
        for (const f of files) {
            if (!tagStats[f.tag]) tagStats[f.tag] = { count: 0, totalSize: 0, latest: null };
            tagStats[f.tag].count++;
            tagStats[f.tag].totalSize += f.size;
            if (!tagStats[f.tag].latest || f.mtime > new Date(tagStats[f.tag].latest)) {
                tagStats[f.tag].latest = f.mtime;
            }
        }

        res.json({
            total_count: files.length,
            total_size_bytes: files.reduce((s, f) => s + f.size, 0),
            backup_dir: BACKUP_DIR,
            max_retention_days: BACKUP_MAX_DAYS,
            offsite_s3: backupS3.isConfigured(),      // false 면 서버 디스크가 유일한 사본
            final_snapshots: files.filter(f => /^final/.test(f.tag)).map(f => f.name),
            by_tag: tagStats,
            recent_10: files.slice(0, 10).map(f => ({
                name: f.name, tag: f.tag,
                size_kb: Math.round(f.size / 1024),
                mtime: f.mtime,
                age_minutes: Math.round(f.ageMs / 60000)
            })),
            health: {
                daily_age_hours: tagStats.daily ? Math.round((Date.now() - new Date(tagStats.daily.latest)) / 3600000) : null,
                hourly_age_minutes: tagStats.hourly ? Math.round((Date.now() - new Date(tagStats.hourly.latest)) / 60000) : null,
                daily_ok: tagStats.daily && (Date.now() - new Date(tagStats.daily.latest)) < 25 * 60 * 60 * 1000,
                hourly_ok: tagStats.hourly && (Date.now() - new Date(tagStats.hourly.latest)) < 70 * 60 * 1000
            }
        });
    } catch (e) {
        res.status(500).json({ error: '백업 상태 조회 실패: ' + e.message });
    }
});

app.post('/api/admin/db-backup/trigger', async (req, res) => {
    if (!isOperationKey(req.body.admin_key)) return res.status(403).json({ error: '운영키가 필요합니다.' });
    const tag = (req.body.tag || 'manual').replace(/[^a-z0-9]/gi, '').slice(0, 20) || 'manual';
    if (db.isAsync) return res.status(400).json({ error: 'PostgreSQL 모드에서는 파일 백업을 쓰지 않습니다 — RDS 자동 백업·스냅샷을 이용하세요.' });
    const file = await performBackup(tag);      // async — await 가 없어 path.basename(Promise) 로 항상 500 이었다
    if (!file) return res.status(500).json({ error: '백업 생성 실패' });
    res.json({ success: true, file: path.basename(file), tag });
});

// ============================================================
// 통백업 / 통복원 (Full Snapshot Backup & Restore)
// ------------------------------------------------------------
// ZIP 안에 DB(competition.db + WAL/SHM) + public/uploads/ 전체 + manifest.json 을 묶음.
// 복원은 매우 위험하므로:
//   - 관리자 키 필수
//   - 복원 직전 현재 상태를 자동으로 백업 (rollback 용)
//   - 복원 후 서버 재시작이 권장됨 (DB 핸들 새로 열기 위해)
// PostgreSQL 백엔드는 이 기능 미지원 (SQLite 파일 기반 전제)
// ============================================================

// 풀백업 전용 multer (큰 파일 허용, 최대 200MB)
const _fullBackupUpload = multer({
    dest: UPLOAD_TMP,
    limits: { fileSize: 200 * 1024 * 1024 }
});

// 풀백업에 포함할 자산 디렉토리들 (DB 외부에 저장된 사용자 데이터)
const _FULL_BACKUP_ASSET_DIRS = [
    { src: path.join(__dirname, 'public', 'uploads'), zipPrefix: 'public/uploads' },
    { src: path.join(__dirname, 'uploads'),           zipPrefix: 'uploads' },
];

// GET /api/admin/full-backup/download
// 통백업 ZIP 다운로드 — SQLite 파일 + 업로드 자산 + manifest.json
app.get('/api/admin/full-backup/download', (req, res) => {
    if (db.isAsync) {
        return res.status(400).json({ error: '통백업/복원은 SQLite 백엔드 전용입니다. PostgreSQL 환경에선 외부 도구(pg_dump)를 사용하세요.' });
    }
    if (!isAdminKey(req.query.key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    try {
        const AdmZip = require('adm-zip');
        const zip = new AdmZip();
        const manifest = {
            type: 'pace-rise-full-backup',
            version: 1,
            created_at: new Date().toISOString(),
            db_backend: 'sqlite',
            files: [],
        };

        // 1) DB 파일들 — 일관성 확보를 위해 WAL 체크포인트 후 복사
        try { db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch(_) {}
        const dbBase = path.basename(DB_PATH);
        if (fs.existsSync(DB_PATH)) {
            const buf = fs.readFileSync(DB_PATH);
            zip.addFile(`db/${dbBase}`, buf);
            manifest.files.push({ path: `db/${dbBase}`, size: buf.length, kind: 'sqlite-main' });
        }
        for (const ext of ['-wal', '-shm']) {
            const p = DB_PATH + ext;
            if (fs.existsSync(p)) {
                const buf = fs.readFileSync(p);
                zip.addFile(`db/${dbBase}${ext}`, buf);
                manifest.files.push({ path: `db/${dbBase}${ext}`, size: buf.length, kind: 'sqlite' + ext });
            }
        }

        // 2) 자산 디렉토리들 — 재귀적으로 추가
        function _walk(dir, basePath, zipPrefix) {
            if (!fs.existsSync(dir)) return;
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const ent of entries) {
                if (ent.name.startsWith('.')) continue; // .gitkeep 등 제외
                const full = path.join(dir, ent.name);
                const rel = path.relative(basePath, full).replace(/\\/g, '/');
                const zipPath = `${zipPrefix}/${rel}`;
                if (ent.isDirectory()) {
                    _walk(full, basePath, zipPrefix);
                } else if (ent.isFile()) {
                    try {
                        const buf = fs.readFileSync(full);
                        zip.addFile(zipPath, buf);
                        manifest.files.push({ path: zipPath, size: buf.length, kind: 'asset' });
                    } catch(_) {}
                }
            }
        }
        for (const asset of _FULL_BACKUP_ASSET_DIRS) {
            _walk(asset.src, asset.src, asset.zipPrefix);
        }

        // 3) manifest.json 마지막에 추가
        const totalAssetSize = manifest.files.filter(f => f.kind === 'asset').reduce((s, f) => s + f.size, 0);
        manifest.summary = {
            total_files: manifest.files.length,
            db_files: manifest.files.filter(f => f.kind.startsWith('sqlite')).length,
            asset_files: manifest.files.filter(f => f.kind === 'asset').length,
            total_asset_bytes: totalAssetSize,
        };
        zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));

        const zipBuf = zip.toBuffer();
        const ts = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="pace-rise-full-backup-${ts}.zip"`);
        res.send(zipBuf);
    } catch (e) {
        console.error('[FullBackup] 다운로드 실패:', e);
        res.status(500).json({ error: '통백업 생성 실패: ' + e.message });
    }
});

// POST /api/admin/full-backup/preview
// ZIP 업로드 → manifest 파싱 + 무결성 검사 (실제 복원은 하지 않음)
app.post('/api/admin/full-backup/preview', _fullBackupUpload.single('file'), (req, res) => {
    _applyJwtBridge(req); // multer 가 req.body 를 새로 만들므로 JWT 브리지 재주입
    if (db.isAsync) {
        try { if (req.file) fs.unlinkSync(req.file.path); } catch(_) {}
        return res.status(400).json({ error: '통백업/복원은 SQLite 백엔드 전용입니다.' });
    }
    if (!isAdminKey(req.body.admin_key)) {
        try { if (req.file) fs.unlinkSync(req.file.path); } catch(_) {}
        return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    }
    if (!req.file) return res.status(400).json({ error: 'ZIP 파일이 필요합니다.' });
    try {
        const AdmZip = require('adm-zip');
        const zip = new AdmZip(req.file.path);
        const entries = zip.getEntries();
        const manifestEntry = entries.find(e => e.entryName === 'manifest.json');
        if (!manifestEntry) {
            return res.status(400).json({ error: 'manifest.json이 없습니다. 올바른 PACE RISE 통백업 ZIP이 아닙니다.' });
        }
        const manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
        if (manifest.type !== 'pace-rise-full-backup') {
            return res.status(400).json({ error: '백업 타입 불일치: ' + manifest.type });
        }
        // DB 파일 존재 여부
        const dbBase = path.basename(DB_PATH);
        const hasDb = entries.some(e => e.entryName === `db/${dbBase}`);
        if (!hasDb) {
            return res.status(400).json({ error: `DB 파일이 없습니다 (db/${dbBase}).` });
        }
        // 자산 카운트
        const assetCount = entries.filter(e => !e.entryName.startsWith('db/') && e.entryName !== 'manifest.json').length;
        res.json({
            ok: true,
            manifest: {
                version: manifest.version,
                created_at: manifest.created_at,
                db_backend: manifest.db_backend,
                summary: manifest.summary,
            },
            zip_size: fs.statSync(req.file.path).size,
            db_present: hasDb,
            entries_count: entries.length,
            asset_count: assetCount,
            tmp_path: req.file.path, // 다음 단계 apply에서 재사용 (file_id 처럼)
        });
    } catch (e) {
        try { if (req.file) fs.unlinkSync(req.file.path); } catch(_) {}
        res.status(500).json({ error: '백업 ZIP 분석 실패: ' + e.message });
    }
});

// POST /api/admin/full-backup/restore
// ZIP 업로드 → 즉시 복원. 매우 위험.
// confirm='RESTORE'를 명시적으로 받음. 복원 직전 자동 안전 백업 수행.
app.post('/api/admin/full-backup/restore', _fullBackupUpload.single('file'), async (req, res) => {
    _applyJwtBridge(req); // multer 가 req.body 를 새로 만들므로 JWT 브리지 재주입
    if (db.isAsync) {
        try { if (req.file) fs.unlinkSync(req.file.path); } catch(_) {}
        return res.status(400).json({ error: '통백업/복원은 SQLite 백엔드 전용입니다.' });
    }
    if (!isAdminKey(req.body.admin_key)) {
        try { if (req.file) fs.unlinkSync(req.file.path); } catch(_) {}
        return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    }
    if (req.body.confirm !== 'RESTORE') {
        try { if (req.file) fs.unlinkSync(req.file.path); } catch(_) {}
        return res.status(400).json({ error: '복원 확인 문자열이 일치하지 않습니다. confirm=RESTORE 필요.' });
    }
    if (!req.file) return res.status(400).json({ error: 'ZIP 파일이 필요합니다.' });

    const zipPath = req.file.path;
    try {
        const AdmZip = require('adm-zip');
        const zip = new AdmZip(zipPath);
        const entries = zip.getEntries();
        const manifestEntry = entries.find(e => e.entryName === 'manifest.json');
        if (!manifestEntry) throw new Error('manifest.json이 없습니다.');
        const manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
        if (manifest.type !== 'pace-rise-full-backup') throw new Error('백업 타입 불일치');
        const dbBase = path.basename(DB_PATH);
        const dbEntry = entries.find(e => e.entryName === `db/${dbBase}`);
        if (!dbEntry) throw new Error(`DB 파일이 없습니다: db/${dbBase}`);

        // ── Step 1: 현재 상태 안전 백업 (rollback 용) ──
        let rollbackFile = null;
        try {
            try { db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch(_) {}
            rollbackFile = await performBackup('prerestore');   // await 누락 → 복원이 백업 완료 전에 시작될 수 있었다
            console.log('[FullRestore] 복원 전 자동 백업:', rollbackFile);
        } catch (e) {
            console.warn('[FullRestore] 자동 백업 실패(무시):', e.message);
        }

        // ── Step 2: SQLite 연결을 닫고 파일 교체 ──
        // better-sqlite3는 close() 후 다시 열기 어려우므로, DB 파일을 덮어쓴 후 서버 재시작 안내.
        // 단, 같은 프로세스에서 이어 쓰기 위해 db.raw.close() → 새 인스턴스 교체는 위험하므로
        // 본 라우트는 "파일 교체 + 재시작 권장" 모델로 동작.
        try { db.raw.close(); } catch(_) {}

        // 기존 WAL/SHM 정리 (서로 다른 백업에서 온 wal과 main이 섞이면 손상 위험)
        for (const ext of ['-wal', '-shm']) {
            try { if (fs.existsSync(DB_PATH + ext)) fs.unlinkSync(DB_PATH + ext); } catch(_) {}
        }

        // ── Step 3: 새 DB 파일 쓰기 ──
        fs.writeFileSync(DB_PATH, dbEntry.getData());
        // 백업에 포함된 wal/shm은 동일 시점의 main과 짝이 맞을 때만 의미가 있음.
        // PRAGMA wal_checkpoint(TRUNCATE)로 백업할 때 wal을 비웠으므로 보통 wal은 비어있거나 없음.
        // 복원 시에도 wal은 비워둔 채 새 인스턴스가 다시 만들도록 함.

        // ── Step 4: 자산 디렉토리 복원 ──
        // 기존 자산을 모두 삭제하지는 않음 (운영 안전). 백업 내 파일만 덮어씀.
        let restoredAssets = 0;
        for (const ent of entries) {
            if (ent.entryName === 'manifest.json') continue;
            if (ent.entryName.startsWith('db/')) continue;
            if (ent.isDirectory) continue;
            // 보안: zip-slip 방지 — 절대경로/상위 디렉토리 참조 금지
            if (/(^|\/)\.\.(\/|$)/.test(ent.entryName) || ent.entryName.startsWith('/')) continue;
            // 자산 경로 매핑: public/uploads/* → /home/user/webapp/public/uploads/*
            //                 uploads/*        → /home/user/webapp/uploads/*
            let outPath = null;
            for (const asset of _FULL_BACKUP_ASSET_DIRS) {
                if (ent.entryName.startsWith(asset.zipPrefix + '/')) {
                    const rel = ent.entryName.substring(asset.zipPrefix.length + 1);
                    outPath = path.join(asset.src, rel);
                    break;
                }
            }
            if (!outPath) continue;
            try {
                fs.mkdirSync(path.dirname(outPath), { recursive: true });
                fs.writeFileSync(outPath, ent.getData());
                restoredAssets++;
            } catch (e) {
                console.warn('[FullRestore] 자산 쓰기 실패:', outPath, e.message);
            }
        }

        try { fs.unlinkSync(zipPath); } catch(_) {}

        // 응답 후 서버 종료 — PM2가 자동 재시작하여 새 DB 핸들로 부팅
        res.json({
            ok: true,
            message: '복원 완료. 서버가 자동 재시작됩니다.',
            restored_assets: restoredAssets,
            rollback_file: rollbackFile ? path.basename(rollbackFile) : null,
            manifest_created_at: manifest.created_at,
        });

        // 응답 전송 후 1.5초 뒤 graceful exit → PM2가 재시작
        setTimeout(() => {
            console.log('[FullRestore] 복원 완료, 서버 재시작 (PM2 auto-restart 기대)');
            process.exit(0);
        }, 1500);
    } catch (e) {
        try { fs.unlinkSync(zipPath); } catch(_) {}
        console.error('[FullRestore] 실패:', e);
        res.status(500).json({ error: '복원 실패: ' + e.message });
    }
});

// ============================================================
// FEDERATION EXCEL UPLOAD (scoped to competition)
// ============================================================
app.post('/api/federation/preview', upload.single('file'), (req, res) => {
    if (!isAdminKey(req.body.admin_key || req.headers['x-admin-key'])) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    if (!req.file) return res.status(400).json({ error: '파일이 필요합니다.' });
    try {
        const wb = XLSX.readFile(req.file.path);
        // 선수명단 시트 우선, 없으면 첫 번째 시트
        const rosterName = wb.SheetNames.find(n => n.includes('선수명단') || n.includes('명단')) || wb.SheetNames[0];
        const ws = wb.Sheets[rosterName];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
        if (rows.length < 2) return res.status(400).json({ error: '데이터가 없습니다.' });
        const headers = rows[0];
        const dataRows = rows.slice(1).filter(r => r[0] && r[1]);
        const relayColMap = {};
        headers.forEach((h, idx) => { const key = String(h).trim(); if (FED_RELAY_MAP[key]) relayColMap[key] = { idx, ...FED_RELAY_MAP[key] }; });
        const [_evCol1, _evCol2] = fedEventColIdx(headers);
        const eventSet = new Map();
        const relayTeams = new Map();
        dataRows.forEach(row => {
            const _g2414 = String(row[2] || '').trim();
            const gender = (_g2414 === '남' || _g2414 === '남자') ? 'M' : (_g2414 === '여' || _g2414 === '여자') ? 'F' : null;
            if (!gender) return;
            [row[_evCol1], _evCol2 >= 0 ? row[_evCol2] : ''].forEach(evtName => {
                if (!evtName) return;
                const mapped = resolveFedEventName(String(evtName).trim());
                if (!mapped) return;
                const fullName = mapped.suffix ? `${mapped.name} ${mapped.suffix}` : mapped.name;
                const evtKey = `${fullName}|${gender}`;
                if (!eventSet.has(evtKey)) eventSet.set(evtKey, { name: fullName, category: mapped.category, gender, count: 0 });
                eventSet.get(evtKey).count++;
            });
            for (const [colKey, relayInfo] of Object.entries(relayColMap)) {
                if (String(row[relayInfo.idx] || '').trim().toUpperCase() === 'O') {
                    const rGender = relayInfo.gender || gender;
                    const rKey = `${relayInfo.name}|${rGender}`;
                    if (!relayTeams.has(rKey)) relayTeams.set(rKey, new Set());
                    relayTeams.get(rKey).add(String(row[0] || '').trim());
                }
            }
        });
        const relayEvents = [];
        for (const [key, teams] of relayTeams) { const [name, gender] = key.split('|'); relayEvents.push({ name, category: 'relay', gender, teamCount: teams.size, teams: [...teams] }); }
        // 조편성 시트 존재 여부 알림
        const heatSheetName = wb.SheetNames.find(n => n.includes('조편성'));
        res.json({ success: true, sheetName: rosterName, totalRows: dataRows.length, headers, athleteCount: dataRows.length, individualEvents: [...eventSet.values()], relayEvents, relayColumns: Object.keys(relayColMap), hasHeatSheet: !!heatSheetName, heatSheetName });
    } catch (err) { res.status(500).json({ error: '파싱 오류: ' + err.message }); }
});

app.post('/api/federation/import', upload.single('file'), async (req, res) => {
    if (!isAdminKey(req.body.admin_key || req.headers['x-admin-key'])) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    if (!req.file) return res.status(400).json({ error: '파일이 필요합니다.' });
    const competition_id = parseInt(req.body.competition_id);
    if (!competition_id) return res.status(400).json({ error: 'competition_id 필요' });
    const clearExisting = req.body.clear_existing === 'true' || req.body.clear_existing === true;
    const heatSize = parseInt(req.body.heat_size) || 8;
    try {
        const wb = XLSX.readFile(req.file.path);
        // 선수명단 시트 우선, 없으면 첫 번째 시트
        const rosterName = wb.SheetNames.find(n => n.includes('선수명단') || n.includes('명단')) || wb.SheetNames[0];
        const ws = wb.Sheets[rosterName];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
        if (rows.length < 2) return res.status(400).json({ error: '데이터가 없습니다.' });
        const headers = rows[0];
        const dataRows = rows.slice(1).filter(r => r[0] && r[1]);
        const relayColMap = {};
        headers.forEach((h, idx) => { const key = String(h).trim(); if (FED_RELAY_MAP[key]) relayColMap[key] = { idx, ...FED_RELAY_MAP[key] }; });
        const [_evCol1, _evCol2] = fedEventColIdx(headers);
        let stats = { athletes: 0, events: 0, entries: 0, heats: 0, relayTeams: 0 };
        const createdEventNames = [];  // ⭐ 트랜잭션 안에서 push, 응답에서 전달

        await db.transaction(async () => {
            if (clearExisting) {
                const evts = await db.all('SELECT id FROM event WHERE competition_id=?', competition_id);
                for (const evt of evts) {
                    const hts = await db.all('SELECT id FROM heat WHERE event_id=?', evt.id);
                    for (const h of hts) { await db.run('DELETE FROM result WHERE heat_id=?', h.id); await db.run('DELETE FROM height_attempt WHERE heat_id=?', h.id); await db.run('DELETE FROM heat_entry WHERE heat_id=?', h.id); }
                    await db.run('DELETE FROM heat WHERE event_id=?', evt.id);
                    await db.run('DELETE FROM relay_member WHERE event_entry_id IN (SELECT id FROM event_entry WHERE event_id=?)', evt.id);
                    await db.run('DELETE FROM combined_score WHERE event_entry_id IN (SELECT id FROM event_entry WHERE event_id=?)', evt.id);
                    await db.run('DELETE FROM qualification_selection WHERE event_id=?', evt.id);
                    await db.run('DELETE FROM event_entry WHERE event_id=?', evt.id);
                }
                await db.run('DELETE FROM event WHERE competition_id=?', competition_id);
                await db.run('DELETE FROM athlete WHERE competition_id=?', competition_id);
            }

            const eventCache = new Map();
            const eventNormCache = new Map();  // normalized name → event id (for fuzzy match on re-upload)
            const eventByNameGender = new Map();  // ⭐ 재업로드 핵심 안전장치: name|gender → existing event id (round_type 무관)
            const evRows = await db.all('SELECT * FROM event WHERE competition_id=? AND parent_event_id IS NULL', competition_id);
            // Normalize: strip commas/spaces/case to match variants like '10,000m' vs '10000m'
            const _normEvtName = s => String(s || '').replace(/[,\s]+/g, '').toLowerCase();
            for (const e of evRows) {
                eventCache.set(`${e.name}|${e.category}|${e.gender}`, e.id);
                // Also index by (normalized_name | gender) as fallback for re-upload with different formatting
                eventNormCache.set(`${_normEvtName(e.name)}|${e.gender}`, e.id);
                // ⭐ round_type 무관 매칭용: 같은 이름·성별이 어떤 round_type 으로든 이미 있으면 재사용
                //    (재업로드 시 인원 변화로 round_type 만 달라져도 새 종목이 만들어지는 문제 방지)
                const ngKey = `${_normEvtName(e.name)}|${e.gender}`;
                if (!eventByNameGender.has(ngKey)) eventByNameGender.set(ngKey, e.id);
            }

            const neededIndividual = new Map();
            const relayParticipation = new Map();

            // Detect barcode column index from headers
            const _barcodeColIdx = headers.findIndex(h => {
                const hn = String(h || '').trim().toLowerCase();
                return hn === '\ubc14\ucf54\ub4dc' || hn === '\ubc14\ucf54\ub4dc\ubc88\ud638' || hn === 'barcode' || hn === '\ubc14\ucf54\ub4dc \ubc88\ud638';
            });
            const _bibColIdx = headers.findIndex(h => {
                const hn = String(h || '').trim().toLowerCase();
                return hn === '\ubc30\ubc88' || hn === 'bib' || hn === '\ubc30\ubc88\ud638' || hn === 'bib_number';
            });
            // 휴대폰 컬럼 탐색 (SMS·기록증 발송용) — 헤더명으로 위치 자동 인식
            const _phoneColIdx = headers.findIndex(h => {
                const hn = String(h || '').trim().toLowerCase();
                return /^(휴대폰|핸드폰|전화|전화번호|연락처|phone|phone_number|mobile)$/.test(hn);
            });
            const _barcodeMap = new Map(); // key: name|team|gender -> barcode
            const _bibMap = new Map(); // key: name|team|gender -> bib
            const _phoneMap = new Map(); // key: name|team|gender -> phone (숫자만)
            // barcode와 bib_number는 별도 필드로 유지 (바코드≠배번)

            dataRows.forEach(row => {
                const team = String(row[0] || '').trim();
                const name = String(row[1] || '').trim();
                const _g2499 = String(row[2] || '').trim();
                const gender = (_g2499 === '남' || _g2499 === '남자') ? 'M' : (_g2499 === '여' || _g2499 === '여자') ? 'F' : null;
                if (!name || !gender) return;

                // Read barcode from excel (find column by header name)
                let rowBarcode = '';
                if (_barcodeColIdx >= 0 && row[_barcodeColIdx]) {
                    rowBarcode = String(row[_barcodeColIdx]).trim();
                }
                let rowBib = '';
                if (_bibColIdx >= 0 && row[_bibColIdx]) {
                    rowBib = String(row[_bibColIdx]).trim();
                }
                // barcode와 bib_number는 별도 필드로 유지

                [row[_evCol1], _evCol2 >= 0 ? row[_evCol2] : ''].forEach(evtName => {
                    if (!evtName) return;
                    const mapped = resolveFedEventName(String(evtName).trim());
                    if (!mapped) return;
                    const fullName = mapped.suffix ? `${mapped.name} ${mapped.suffix}` : mapped.name;
                    const evtKey = `${fullName}|${gender}`;
                    if (!neededIndividual.has(evtKey)) neededIndividual.set(evtKey, { name: fullName, category: mapped.category, gender, athletes: [] });
                    neededIndividual.get(evtKey).athletes.push({ name, team, gender, barcode: rowBarcode });
                });

                // Store barcode mapping for this athlete
                if (rowBarcode) {
                    _barcodeMap.set(`${name}|${team}|${gender}`, rowBarcode);
                }
                if (rowBib) {
                    _bibMap.set(`${name}|${team}|${gender}`, rowBib);
                }
                if (_phoneColIdx >= 0 && row[_phoneColIdx]) {
                    const rowPhone = String(row[_phoneColIdx]).replace(/[^0-9]/g, '');
                    if (rowPhone) _phoneMap.set(`${name}|${team}|${gender}`, rowPhone);
                }
                for (const [colKey, relayInfo] of Object.entries(relayColMap)) {
                    if (String(row[relayInfo.idx] || '').trim().toUpperCase() === 'O') {
                        const rGender = relayInfo.gender || gender;
                        const rKey = `${relayInfo.name}|${rGender}`;
                        if (!relayParticipation.has(rKey)) relayParticipation.set(rKey, new Map());
                        const tm = relayParticipation.get(rKey);
                        if (!tm.has(team)) tm.set(team, []);
                        tm.get(team).push({ name, gender });
                    }
                }
            });

            for (const [key, info] of neededIndividual) {
                const ck = `${info.name}|${info.category}|${info.gender}`;
                if (!eventCache.has(ck)) {
                    // ⭐ 재업로드 안전장치 1: 같은 이름·성별의 종목이 이미 어떤 round_type 으로든 DB에 있는지 확인
                    //    (인원 변동으로 final ↔ preliminary 가 달라지더라도 기존 종목 재사용 — 두번 다시 중복 생성 금지)
                    const normKey = `${_normEvtName(info.name)}|${info.gender}`;
                    if (eventByNameGender.has(normKey)) {
                        const existingId = eventByNameGender.get(normKey);
                        eventCache.set(ck, existingId);
                        continue;  // 새로 만들지 않음 — 기존 종목 재사용
                    }
                    // 재업로드 안전장치 2: normalized 키로 한번 더 확인 ('10,000m' vs '10000m')
                    if (eventNormCache.has(normKey)) {
                        const existingId = eventNormCache.get(normKey);
                        eventCache.set(ck, existingId);
                        eventByNameGender.set(normKey, existingId);
                        continue;
                    }
                    // Field, combined, road events are always 'final'
                    // Only track short-distance events can have preliminary rounds
                    const ALWAYS_FINAL_CATEGORIES = ['field_distance', 'field_height', 'combined', 'relay', 'road'];
                    const ALWAYS_FINAL_EVENTS = ['1000m','5000m','5000mW','10,000m','10,000mW','10000m','3000mSC','3000m장애물','마라톤','하프마라톤','20KmW','35kmW','10K','5K'];
                    const isFinalOnly = ALWAYS_FINAL_CATEGORIES.includes(info.category) || ALWAYS_FINAL_EVENTS.some(e => info.name === e || info.name.startsWith(e + ' '));
                    const rt = (!isFinalOnly && info.athletes.length > heatSize) ? 'preliminary' : 'final';
                    try {
                        const r = await db.run('INSERT INTO event (competition_id,name,category,gender,round_type,round_status) VALUES (?,?,?,?,?,?)', competition_id, info.name, info.category, info.gender, rt, 'heats_generated');
                        eventCache.set(ck, r.lastInsertRowid);
                        eventNormCache.set(normKey, r.lastInsertRowid);
                        eventByNameGender.set(normKey, r.lastInsertRowid);
                        stats.events++;
                        createdEventNames.push(`${info.name} (${info.gender}, ${rt})`);
                    } catch (insErr) {
                        // ⭐ UNIQUE 인덱스 위반 → 동시 업로드 등으로 이미 만들어진 경우, 다시 조회해서 재사용
                        const exist = await db.get('SELECT id FROM event WHERE competition_id=? AND name=? AND gender=? AND parent_event_id IS NULL', competition_id, info.name, info.gender);
                        if (exist) {
                            eventCache.set(ck, exist.id);
                            eventNormCache.set(normKey, exist.id);
                            eventByNameGender.set(normKey, exist.id);
                        } else {
                            throw insErr;
                        }
                    }
                }
            }
            for (const [key, teamMap] of relayParticipation) {
                const [relayName, gender] = key.split('|');
                const ck = `${relayName}|relay|${gender}`;
                if (!eventCache.has(ck)) {
                    const normKey = `${_normEvtName(relayName)}|${gender}`;
                    // ⭐ 재업로드 안전장치: round_type 무관 재사용
                    if (eventByNameGender.has(normKey)) {
                        const existingId = eventByNameGender.get(normKey);
                        eventCache.set(ck, existingId);
                        continue;
                    }
                    if (eventNormCache.has(normKey)) {
                        const existingId = eventNormCache.get(normKey);
                        eventCache.set(ck, existingId);
                        eventByNameGender.set(normKey, existingId);
                        continue;
                    }
                    try {
                        const r = await db.run('INSERT INTO event (competition_id,name,category,gender,round_type,round_status) VALUES (?,?,?,?,?,?)', competition_id, relayName, 'relay', gender, 'final', 'heats_generated');
                        eventCache.set(ck, r.lastInsertRowid);
                        eventNormCache.set(normKey, r.lastInsertRowid);
                        eventByNameGender.set(normKey, r.lastInsertRowid);
                        stats.events++;
                        createdEventNames.push(`${relayName} (${gender}, final, 계주)`);
                    } catch (insErr) {
                        const exist = await db.get('SELECT id FROM event WHERE competition_id=? AND name=? AND gender=? AND parent_event_id IS NULL', competition_id, relayName, gender);
                        if (exist) {
                            eventCache.set(ck, exist.id);
                            eventNormCache.set(normKey, exist.id);
                            eventByNameGender.set(normKey, exist.id);
                        } else {
                            throw insErr;
                        }
                    }
                }
            }

            // 조편성 시트에서 배번 보충 (선수명단에 배번 없는 선수)
            const _heatSheetName = wb.SheetNames.find(n => n.includes('조편성'));
            if (_heatSheetName) {
                const _heatWs = wb.Sheets[_heatSheetName];
                const _heatRows = XLSX.utils.sheet_to_json(_heatWs, { header: 1 });
                if (_heatRows.length > 1) {
                    const _hHdr = _heatRows[0];
                    const _hBibIdx = _hHdr.findIndex(h => String(h||'').includes('배번'));
                    const _hNameIdx = _hHdr.findIndex(h => String(h||'').includes('성명') || String(h||'').includes('선수'));
                    const _hTeamIdx = _hHdr.findIndex(h => String(h||'').includes('소속') || String(h||'').includes('팀'));
                    const _hGenderIdx = _hHdr.findIndex(h => String(h||'').includes('성별'));
                    if (_hBibIdx >= 0 && _hNameIdx >= 0) {
                        _heatRows.slice(1).forEach(r => {
                            if (!r[_hNameIdx] || r[_hBibIdx] == null) return;
                            const hName = String(r[_hNameIdx]).trim();
                            const hBib = String(r[_hBibIdx]).trim();
                            const hTeam = _hTeamIdx >= 0 ? String(r[_hTeamIdx] || '').trim() : '';
                            const hGRaw = _hGenderIdx >= 0 ? String(r[_hGenderIdx] || '').trim() : '';
                            const hGender = (hGRaw === '남' || hGRaw === '남자') ? 'M' : (hGRaw === '여' || hGRaw === '여자') ? 'F' : null;
                            if (!hGender || !hBib) return;
                            const hKey = `${hName}|${hTeam}|${hGender}`;
                            if (!_bibMap.has(hKey)) {
                                _bibMap.set(hKey, hBib);
                            }
                        });
                    }
                }
            }

            const athleteCache = new Map();
            const athRows = await db.all('SELECT * FROM athlete WHERE competition_id=?', competition_id);
            for (const a of athRows) athleteCache.set(`${a.name}|${a.team}|${a.gender}`, a.id);
            const ensureAthlete = async (name, team, gender) => {
                const key = `${name}|${team}|${gender}`;
                if (athleteCache.has(key)) {
                    const existingId = athleteCache.get(key);
                    // Update bib/barcode if we have new data and existing is empty
                    const bib = _bibMap.get(key) || null;
                    const bc = _barcodeMap.get(key) || null;
                    if (bib) {
                        const existingAth = await db.get('SELECT gender FROM athlete WHERE id=?', existingId);
                        const bibConflict = await db.get('SELECT id FROM athlete WHERE competition_id=? AND bib_number=? AND gender=? AND id!=?', competition_id, bib, existingAth?.gender || 'M', existingId);
                        if (!bibConflict) await db.run('UPDATE athlete SET bib_number=? WHERE id=? AND (bib_number IS NULL OR bib_number = ?)', bib, existingId, '');
                    }
                    if (bc) await db.run('UPDATE athlete SET barcode=? WHERE id=? AND (barcode IS NULL OR barcode = ?)', bc, existingId, bc);
                    const ph = _phoneMap.get(key) || null;
                    if (ph) await db.run("UPDATE athlete SET phone=? WHERE id=? AND (phone IS NULL OR phone = '')", ph, existingId);
                    return existingId;
                }
                const bib = _bibMap.get(key) || null;
                const bc = _barcodeMap.get(key) || '';
                const ph = _phoneMap.get(key) || '';
                const r = await db.run('INSERT INTO athlete (competition_id,name,bib_number,team,barcode,gender,phone) VALUES (?,?,?,?,?,?,?)', competition_id, name, bib, team, bc, gender, ph);
                athleteCache.set(key, r.lastInsertRowid);
                stats.athletes++;
                return r.lastInsertRowid;
            };

            for (const [key, info] of neededIndividual) {
                const eventId = eventCache.get(`${info.name}|${info.category}|${info.gender}`);
                if (!eventId) continue;
                const hcRow = await db.get('SELECT COUNT(*) AS c FROM heat WHERE event_id=?', eventId);
                if (hcRow && hcRow.c > 0) continue;
                const entryIds = [];
                for (const ath of info.athletes) {
                    const aid = await ensureAthlete(ath.name, ath.team, ath.gender);
                    const er = await db.run("INSERT OR IGNORE INTO event_entry (event_id,athlete_id,status) VALUES (?,?,'registered')", eventId, aid);
                    let eid = er.lastInsertRowid;
                    if (!eid) {
                        const existing = await db.get('SELECT id FROM event_entry WHERE event_id=? AND athlete_id=?', eventId, aid);
                        eid = existing?.id;
                    }
                    if (eid) { entryIds.push(eid); stats.entries++; }
                }
                // Only short track events (≤800m) split into multiple heats (max 8 per heat)
                // Field events, long-distance track, combined, road → always 1 heat
                const isShort = isShortTrackEvent(info.name);
                const effectiveHeatSize = isShort ? heatSize : entryIds.length;
                const heatCount = isShort ? Math.ceil(entryIds.length / heatSize) : 1;
                for (let h = 0; h < heatCount; h++) {
                    const hr = await db.run('INSERT INTO heat (event_id,heat_number) VALUES (?,?)', eventId, h + 1);
                    stats.heats++;
                    const slice = entryIds.slice(h * effectiveHeatSize, (h + 1) * effectiveHeatSize);
                    for (let lane = 0; lane < slice.length; lane++) {
                        await db.run('INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES (?,?,?)', hr.lastInsertRowid, slice[lane], lane + 1);
                    }
                }
            }

            // ============================================================
            // AUTO-CREATE COMBINED (10종/7종/5종) SUB-EVENTS
            // ============================================================
            const DECATHLON_SUBS = [
                {order:1, name:'100m', category:'track'},
                {order:2, name:'멀리뛰기', category:'field_distance'},
                {order:3, name:'포환던지기', category:'field_distance'},
                {order:4, name:'높이뛰기', category:'field_height'},
                {order:5, name:'400m', category:'track'},
                {order:6, name:'110mH', category:'track'},
                {order:7, name:'원반던지기', category:'field_distance'},
                {order:8, name:'장대높이뛰기', category:'field_height'},
                {order:9, name:'창던지기', category:'field_distance'},
                {order:10, name:'1500m', category:'track'},
            ];
            const HEPTATHLON_SUBS = [
                {order:1, name:'100mH', category:'track'},
                {order:2, name:'높이뛰기', category:'field_height'},
                {order:3, name:'포환던지기', category:'field_distance'},
                {order:4, name:'200m', category:'track'},
                {order:5, name:'멀리뛰기', category:'field_distance'},
                {order:6, name:'창던지기', category:'field_distance'},
                {order:7, name:'800m', category:'track'},
            ];
            // ─── KAAF 중학교 5종경기 (Pentathlon) ───
            // 출처: KAAF 2018-2019 경기규칙 제5장 혼성경기
            // 1일 또는 연속 2일 실시 가능
            //   제1일: 100m → 포환던지기 → 110mH(남) / 100mH(여)
            //   제2일: 높이뛰기 → 800m
            // ★ 남녀 5종 차이점: 허들 종목만 다름 (남 110mH, 여 100mH)
            const PENTATHLON_M_SUBS = [
                {order:1, name:'100m',       category:'track'},          // Day 1
                {order:2, name:'포환던지기', category:'field_distance'}, // Day 1
                {order:3, name:'110mH',      category:'track'},          // Day 1
                {order:4, name:'높이뛰기',   category:'field_height'},   // Day 2
                {order:5, name:'800m',       category:'track'},          // Day 2
            ];
            const PENTATHLON_F_SUBS = [
                {order:1, name:'100m',       category:'track'},          // Day 1
                {order:2, name:'포환던지기', category:'field_distance'}, // Day 1
                {order:3, name:'100mH',      category:'track'},          // Day 1  ← 여자
                {order:4, name:'높이뛰기',   category:'field_height'},   // Day 2
                {order:5, name:'800m',       category:'track'},          // Day 2
            ];
            for (const [key, info] of neededIndividual) {
                if (info.category !== 'combined') continue;
                const parentId = eventCache.get(`${info.name}|${info.category}|${info.gender}`);
                if (!parentId) continue;
                // 이미 생성된 세부종목의 차수(sort_order) 집합 — '일부만 있으면 전체 스킵'이 아니라
                // '누락된 차수만' 생성한다. (예: 7종에 필드만 있고 트랙(100mH/200m/800m)이 빠진 경우 보충)
                const existingSubRows = await db.all('SELECT sort_order FROM event WHERE parent_event_id=?', parentId);
                const existingOrders = new Set((existingSubRows || []).map(r => Number(r.sort_order)));
                // ─── 종목별 sub-events 매핑 (gender 분기 포함) ───
                let subs, prefix;
                if (info.name === '10종경기') {
                    subs = DECATHLON_SUBS;
                    prefix = '[10종]';
                } else if (info.name === '7종경기') {
                    subs = HEPTATHLON_SUBS;
                    prefix = '[7종]';
                } else if (info.name === '5종경기') {
                    subs = info.gender === 'F' ? PENTATHLON_F_SUBS : PENTATHLON_M_SUBS;
                    prefix = '[5종]';
                } else {
                    continue;  // 알 수 없는 combined 종목 → 스킵
                }
                for (const sub of subs) {
                    if (existingOrders.has(Number(sub.order))) continue; // 이미 있는 차수는 건너뛰고 누락분만 생성 (중복 방지)
                    const subName = `${prefix} ${sub.name}`;
                    const subR = await db.run('INSERT INTO event (competition_id,name,category,gender,round_type,round_status,parent_event_id,sort_order) VALUES (?,?,?,?,?,?,?,?)', competition_id, subName, sub.category, info.gender, 'final', 'heats_generated', parentId, sub.order);
                    const subEventId = subR.lastInsertRowid;
                    const parentEntries = await db.all('SELECT ee.id, ee.athlete_id FROM event_entry ee WHERE ee.event_id=?', parentId);
                    for (const pe of parentEntries) {
                        await db.run("INSERT OR IGNORE INTO event_entry (event_id,athlete_id,status) VALUES (?,?,'registered')", subEventId, pe.athlete_id);
                    }
                    const subHeatR = await db.run('INSERT INTO heat (event_id,heat_number) VALUES (?,?)', subEventId, 1);
                    const subEntryIds = await db.all('SELECT id FROM event_entry WHERE event_id=?', subEventId);
                    for (let lane = 0; lane < subEntryIds.length; lane++) {
                        await db.run('INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES (?,?,?)', subHeatR.lastInsertRowid, subEntryIds[lane].id, lane + 1);
                    }
                }
                console.log(`[Combined] Created ${subs.length} sub-events for ${info.name} (${info.gender}), parent_id=${parentId}`);
            }

            // ============================================================
            // RELAY: Create team entries + store relay members
            // ============================================================
            for (const [key, teamMap] of relayParticipation) {
                const [relayName, gender] = key.split('|');
                const eventId = eventCache.get(`${relayName}|relay|${gender}`);
                if (!eventId) continue;
                const heatChkRow = await db.get('SELECT COUNT(*) AS c FROM heat WHERE event_id=?', eventId);
                if (((heatChkRow && heatChkRow.c) || 0) > 0) continue;
                const entryIds = [];
                for (const [teamName, members] of teamMap) {
                    // Create a "team athlete" record: name=teamName, bib=teamName, team=teamName
                    const rGender = gender === 'X' ? 'M' : gender;
                    const aid = await ensureAthlete(teamName, teamName, rGender);
                    const er = await db.run("INSERT OR IGNORE INTO event_entry (event_id,athlete_id,status) VALUES (?,?,'registered')", eventId, aid);
                    let eid = er.lastInsertRowid;
                    if (!eid) {
                        const existing = await db.get('SELECT id FROM event_entry WHERE event_id=? AND athlete_id=?', eventId, aid);
                        eid = existing?.id;
                    }
                    if (eid) {
                        entryIds.push(eid);
                        stats.entries++;
                        stats.relayTeams++;
                        // Store each member of this relay team
                        // Use ensureAthlete so relay-only athletes are also inserted
                        let legOrder = 1;
                        for (const member of members) {
                            const memberGender = member.gender || rGender;
                            const memberAid = await ensureAthlete(member.name, teamName, memberGender);
                            if (memberAid) {
                                await db.run('INSERT OR IGNORE INTO relay_member (event_entry_id, athlete_id, leg_order) VALUES (?,?,?)', eid, memberAid, legOrder++);
                            }
                        }
                    }
                }
                const heatCount = Math.ceil(entryIds.length / 8);
                for (let h = 0; h < heatCount; h++) {
                    const hr = await db.run('INSERT INTO heat (event_id,heat_number) VALUES (?,?)', eventId, h + 1);
                    stats.heats++;
                    const slice = entryIds.slice(h * 8, (h + 1) * 8);
                    for (let lane = 0; lane < slice.length; lane++) {
                        await db.run('INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES (?,?,?)', hr.lastInsertRowid, slice[lane], lane + 1);
                    }
                }
            }

            // ============================================================
            // 조편성 시트 처리: Heat/Lane 재배정
            // ============================================================
            const heatSheetName = wb.SheetNames.find(n => n.includes('조편성'));
            if (heatSheetName) {
                const heatWs = wb.Sheets[heatSheetName];
                const heatRows = XLSX.utils.sheet_to_json(heatWs, { header: 1 });
                if (heatRows.length > 1) {
                    const hHdr = heatRows[0];
                    // 헤더에서 컬럼 인덱스 찾기
                    const hGenderIdx = hHdr.findIndex(h => String(h||'').includes('성별'));
                    const hEventIdx = hHdr.findIndex(h => String(h||'').includes('종목'));
                    const hHeatIdx = hHdr.findIndex(h => String(h||'').includes('조'));
                    const hLaneIdx = hHdr.findIndex(h => String(h||'').includes('순서') || String(h||'').includes('레인'));
                    const hBibIdx = hHdr.findIndex(h => String(h||'').includes('배번'));
                    const hNameIdx = hHdr.findIndex(h => String(h||'').includes('성명') || String(h||'').includes('선수'));

                    if (hEventIdx >= 0 && hHeatIdx >= 0 && hBibIdx >= 0) {
                        // 종목+성별별 조편성 그룹핑
                        const heatAssign = new Map(); // 'eventName|gender' -> [{heat, lane, bib, name}]
                        heatRows.slice(1).forEach(r => {
                            if (!r[hEventIdx]) return;
                            const evtRaw = String(r[hEventIdx]).trim();
                            const mapped = resolveFedEventName(evtRaw);
                            if (!mapped) return;
                            const fullName = mapped.suffix ? `${mapped.name} ${mapped.suffix}` : mapped.name;
                            const gRaw = hGenderIdx >= 0 ? String(r[hGenderIdx] || '').trim() : '';
                            const gender = (gRaw === '남' || gRaw === '남자') ? 'M' : (gRaw === '여' || gRaw === '여자') ? 'F' : null;
                            if (!gender) return;
                            const heat = parseInt(r[hHeatIdx]) || 1;
                            const lane = hLaneIdx >= 0 ? (parseInt(r[hLaneIdx]) || 1) : 1;
                            const bib = r[hBibIdx] != null ? String(r[hBibIdx]).trim() : '';
                            const name = hNameIdx >= 0 ? String(r[hNameIdx] || '').trim() : '';
                            const key = `${fullName}|${mapped.category}|${gender}`;
                            if (!heatAssign.has(key)) heatAssign.set(key, []);
                            heatAssign.get(key).push({ heat, lane, bib, name });
                        });

                        for (const [evtKey, assignments] of heatAssign) {
                            const eventId = eventCache.get(evtKey);
                            if (!eventId) continue;
                            
                            // 기존 heats 삭제
                            const existingHeats = await db.all('SELECT id FROM heat WHERE event_id=?', eventId);
                            for (const eh of existingHeats) { await db.run('DELETE FROM heat_entry WHERE heat_id=?', eh.id); }
                            await db.run('DELETE FROM heat WHERE event_id=?', eventId);
                            
                            // 조별 그룹핑
                            const heatGroups = new Map();
                            assignments.forEach(a => {
                                if (!heatGroups.has(a.heat)) heatGroups.set(a.heat, []);
                                heatGroups.get(a.heat).push(a);
                            });
                            
                            // 조 생성 및 선수 배정
                            for (const [heatNum, entries] of [...heatGroups].sort((a,b) => a[0] - b[0])) {
                                const hr = await db.run('INSERT INTO heat (event_id,heat_number) VALUES (?,?)', eventId, heatNum);
                                const heatId = hr.lastInsertRowid;
                                for (const ent of entries) {
                                    // BIB 또는 이름으로 선수 찾기
                                    let athlete = null;
                                    if (ent.bib) {
                                        athlete = await db.get('SELECT * FROM athlete WHERE competition_id=? AND bib_number=?', competition_id, ent.bib);
                                    }
                                    if (!athlete && ent.name) {
                                        athlete = await db.get('SELECT * FROM athlete WHERE competition_id=? AND name=?', competition_id, ent.name);
                                    }
                                    if (!athlete) continue;
                                    
                                    const entry = await db.get('SELECT id FROM event_entry WHERE event_id=? AND athlete_id=?', eventId, athlete.id);
                                    if (!entry) continue;
                                    
                                    await db.run('INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES (?,?,?)', heatId, entry.id, ent.lane);
                                }
                            }
                        }
                        console.log(`[조편성] ${heatAssign.size}개 종목 조편성 적용 완료`);
                    }
                }
            }

            // ─── scoreboard_key 백필 ───
            // 연맹 import 의 조 생성 경로들은 scoreboard_key 를 설정하지 않으므로,
            // 키가 비어있는 모든 조에 대해 generateScoreboardKey 로 일괄 생성한다.
            // (generateScoreboardKey 는 연맹 라벨 없어도 남자/여자/혼성 기본 라벨로 폴백 → null 아님)
            const _keylessHeats = await db.all(`
                SELECT h.id AS heat_id, h.heat_number, h.event_id,
                       e.name, e.gender, e.round_type, e.competition_id
                FROM heat h JOIN event e ON e.id = h.event_id
                WHERE e.competition_id=? AND (h.scoreboard_key IS NULL OR h.scoreboard_key='')
            `, competition_id);
            const _heatCountByEvent = new Map();
            for (const _h of _keylessHeats) {
                if (!_heatCountByEvent.has(_h.event_id)) {
                    const _c = await db.get('SELECT COUNT(*) AS c FROM heat WHERE event_id=?', _h.event_id);
                    _heatCountByEvent.set(_h.event_id, Number(_c && _c.c) || 1);
                }
            }
            for (const _h of _keylessHeats) {
                const _evt = { id: _h.event_id, name: _h.name, gender: _h.gender, round_type: _h.round_type, competition_id: _h.competition_id };
                const _sbKey = await generateScoreboardKey(_evt, _h.heat_number, db, _heatCountByEvent.get(_h.event_id));
                if (_sbKey) await db.run('UPDATE heat SET scoreboard_key=? WHERE id=?', _sbKey, _h.heat_id);
            }

        })();
        opLog(`연맹 명단 업로드: 선수 ${stats.athletes}명, 종목 ${stats.events}개${createdEventNames.length ? ` (신규: ${createdEventNames.slice(0, 5).join(', ')}${createdEventNames.length > 5 ? ` 외 ${createdEventNames.length - 5}개` : ''})` : ''}`, 'import', 'admin', competition_id);
        // ⭐ created_event_names: 재업로드 시 0개면 정상. 누락된 종목이 새로 만들어졌다면 여기서 확인 가능
        res.json({ success: true, message: '업로드 완료', stats, created_event_names: createdEventNames });
    } catch (err) { console.error(err); res.status(500).json({ error: '가져오기 오류: ' + err.message }); }
});

// ============================================================
// ATHLETE-ONLY EXCEL UPLOAD
// Auto-detects column layout from headers.
// Supported formats:
//   (A) Fixed: 배번 | 선수명 | 소속 | 성별 | 바코드
//   (B) Federation: 팀명 | 선수명 | 성별 | 생년월일 | 종목1 | … | 바코드
// ============================================================
app.post('/api/athletes/upload', upload.single('file'), async (req, res) => {
    if (!isAdminKey(req.body.admin_key || req.headers['x-admin-key'])) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    if (!req.file) return res.status(400).json({ error: '파일이 필요합니다.' });
    const competition_id = parseInt(req.body.competition_id);
    if (!competition_id) return res.status(400).json({ error: 'competition_id 필요' });
    const clearExisting = req.body.clear_existing === 'true' || req.body.clear_existing === true;
    try {
        const wb = XLSX.readFile(req.file.path);
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
        if (rows.length < 2) return res.status(400).json({ error: '데이터가 없습니다.' });
        const headers = rows[0] || [];

        // --- Auto-detect column layout from headers ---
        const hdrMap = {};
        headers.forEach((h, idx) => {
            const hn = String(h || '').trim();
            const hl = hn.toLowerCase();
            if (/^(선수명|성명|이름|name)$/i.test(hn)) hdrMap.name = idx;
            else if (/^(팀명|소속|팀|team)$/i.test(hn)) hdrMap.team = idx;
            else if (/^(성별|gender)$/i.test(hn)) hdrMap.gender = idx;
            else if (/^(배번|배번호|bib|bib_number)$/i.test(hn)) hdrMap.bib = idx;
            else if (/^(바코드|바코드번호|barcode|바코드\s*번호)$/i.test(hn)) hdrMap.barcode = idx;
            else if (/^(휴대폰|핸드폰|전화|전화번호|연락처|phone|phone_number|mobile)$/i.test(hn)) hdrMap.phone = idx;
        });

        // Determine format: header-detected or legacy fixed columns
        const useHeaders = (hdrMap.name !== undefined);
        // barcode와 bib_number는 별도 필드 — 바코드를 빕으로 사용하지 않음

        const dataRows = rows.slice(1).filter(r => {
            const nameIdx = useHeaders ? hdrMap.name : 1;
            return r[nameIdx];
        });
        let stats = { added: 0, updated: 0, skipped: 0 };

        await db.transaction(async () => {
            if (clearExisting) {
                await db.run('DELETE FROM athlete WHERE competition_id=?', competition_id);
            }
            const existingCache = new Map();
            const existingRows = await db.all('SELECT * FROM athlete WHERE competition_id=?', competition_id);
            existingRows.forEach(a => existingCache.set(`${a.name}|${a.team}|${a.gender}`, a));

            // 휴대폰 번호 정규화 (010-1234-5678 → 01012345678) — 양식에 비어있으면 빈 문자열
            const normPhone = (p) => {
                if (p === undefined || p === null) return '';
                let s = String(p).trim();
                if (!s) return '';
                // 엑셀이 숫자로 인식할 경우 앞 0이 누락된 경우 보정
                s = s.replace(/[^0-9+]/g, '');
                if (s.startsWith('+82')) s = '0' + s.slice(3);
                else if (s.startsWith('82') && s.length >= 11) s = '0' + s.slice(2);
                // 1로 시작하는 10자리는 0 보정 (엑셀이 010 → 10으로 저장하는 경우)
                if (/^1\d{9}$/.test(s)) s = '0' + s;
                return s;
            };

            for (const row of dataRows) {
                let name, team, genderRaw, bib, barcode, phone;
                if (useHeaders) {
                    name = String(row[hdrMap.name] || '').trim();
                    team = hdrMap.team !== undefined ? String(row[hdrMap.team] || '').trim() : '';
                    genderRaw = hdrMap.gender !== undefined ? String(row[hdrMap.gender] || '').trim() : '';
                    bib = hdrMap.bib !== undefined ? (String(row[hdrMap.bib] || '').trim() || null) : null;
                    barcode = hdrMap.barcode !== undefined ? (String(row[hdrMap.barcode] || '').trim() || '') : '';
                    phone = hdrMap.phone !== undefined ? normPhone(row[hdrMap.phone]) : '';
                } else {
                    // Legacy fixed columns: bib | name | team | gender | barcode | phone(optional)
                    bib = String(row[0] || '').trim() || null;
                    name = String(row[1] || '').trim();
                    team = String(row[2] || '').trim();
                    genderRaw = String(row[3] || '').trim();
                    barcode = String(row[4] || '').trim() || '';
                    phone = normPhone(row[5]);
                }
                const gender = (genderRaw === '남' || genderRaw === '남자' || genderRaw === 'M') ? 'M' : (genderRaw === '여' || genderRaw === '여자' || genderRaw === 'F') ? 'F' : null;
                if (!name || !gender) { stats.skipped++; continue; }
                // barcode와 bib_number는 별도 필드로 유지 (바코드≠배번)

                const key = `${name}|${team}|${gender}`;
                if (existingCache.has(key)) {
                    const existing = existingCache.get(key);
                    if (existing && existing.id) {
                        let didUpdate = false;
                        if (bib && !existing.bib_number) {
                            await db.run('UPDATE athlete SET bib_number=? WHERE id=?', bib, existing.id);
                            didUpdate = true;
                        }
                        if (barcode && !existing.barcode) {
                            await db.run('UPDATE athlete SET barcode=? WHERE id=?', barcode, existing.id);
                            didUpdate = true;
                        }
                        if (phone && !existing.phone) {
                            await db.run('UPDATE athlete SET phone=? WHERE id=?', phone, existing.id);
                            didUpdate = true;
                        }
                        if (didUpdate) stats.updated = (stats.updated || 0) + 1;
                    }
                    stats.skipped++; continue;
                }
                await db.run('INSERT INTO athlete (competition_id,name,bib_number,team,barcode,gender,phone) VALUES (?,?,?,?,?,?,?)', competition_id, name, bib, team, barcode, gender, phone || '');
                existingCache.set(key, { id: null, bib_number: bib, barcode, phone });
                stats.added++;
            }
        })();

        opLog(`선수 명단 업로드: ${stats.added}명 추가, ${stats.updated || 0}명 업데이트, ${stats.skipped}명 스킵`, 'import', 'admin', competition_id);
        res.json({ success: true, stats });
    } catch (err) { console.error(err); res.status(500).json({ error: '업로드 오류: ' + err.message }); }
});

// ============================================================
// BIB NUMBER BATCH UPDATE (from Excel)
// Matches by name+team+gender, updates bib_number only
// ============================================================
app.post('/api/athletes/update-bib', upload.single('file'), async (req, res) => {
    const adminKey = req.body.admin_key || req.headers['x-admin-key'];
    if (!isAdminKey(adminKey) && !isOperationKey(adminKey)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    if (!req.file) return res.status(400).json({ error: '파일이 필요합니다.' });
    const competition_id = parseInt(req.body.competition_id);
    if (!competition_id) return res.status(400).json({ error: 'competition_id 필요' });
    const previewOnly = req.body.preview === 'true' || req.body.preview === true;
    try {
        const wb = XLSX.readFile(req.file.path);
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
        if (rows.length < 2) return res.status(400).json({ error: '데이터가 없습니다.' });
        const headers = rows[0] || [];

        // Auto-detect columns
        const hdrMap = {};
        headers.forEach((h, idx) => {
            const hn = String(h || '').trim();
            if (/^(선수명|성명|이름|name)$/i.test(hn)) hdrMap.name = idx;
            else if (/^(팀명|소속|소속명|팀|team)$/i.test(hn)) hdrMap.team = idx;      // 소속명: 연맹 배번 명단 원본
            else if (/^(생년월일|birth|birth_date)$/i.test(hn)) hdrMap.birth = idx;
            else if (/^(성별|gender)$/i.test(hn)) hdrMap.gender = idx;
            else if (/^(배번|배번호|bib|bib_number|번호)$/i.test(hn)) hdrMap.bib = idx;
            else if (/^(바코드|barcode|바코드번호)$/i.test(hn)) hdrMap.barcode = idx;
        });

        // Also support fixed layout from 조편성 sheet: 성별|종목|라운드|조|그룹|순서|배번|성명|소속
        const isHeatSheet = headers.length >= 9 && /성별/.test(String(headers[0]||'')) && /종목/.test(String(headers[1]||''));
        if (isHeatSheet) {
            hdrMap.gender = 0; hdrMap.bib = 6; hdrMap.name = 7; hdrMap.team = 8;
        }

        if (hdrMap.name === undefined) return res.status(400).json({ error: '선수명 컬럼을 찾을 수 없습니다.' });

        const hasGenderCol = hdrMap.gender !== undefined;

        // Build existing athlete cache — support both with and without gender
        const existingCache = new Map();      // name|team|gender → athlete
        const existingNoGender = new Map();   // name|team → athlete (fallback when no gender column)
        (await db.all('SELECT * FROM athlete WHERE competition_id=?', competition_id))
            .forEach(a => {
                existingCache.set(`${a.name}|${a.team}|${a.gender}`, a);
                // For name+team only matching, store first match (if no duplicate)
                const ngKey = `${a.name}|${a.team}`;
                if (existingNoGender.has(ngKey)) {
                    existingNoGender.set(ngKey, null); // mark as ambiguous (multiple genders)
                } else {
                    existingNoGender.set(ngKey, a);
                }
            });

        // Parse rows - deduplicate by name+team(+gender if available)
        const excelMap = new Map();
        const _altKey = new Map();            // '이름|소속|성별#배번' → '이름(yy)|소속|성별'
        for (const row of rows.slice(1)) {
            const name = String(row[hdrMap.name] || '').trim();
            if (!name) continue;
            const team = hdrMap.team !== undefined ? String(row[hdrMap.team] || '').trim() : '';
            const genderRaw = hasGenderCol ? String(row[hdrMap.gender] || '').trim() : '';
            const gender = (genderRaw === '남' || genderRaw === '남자' || genderRaw === 'M') ? 'M' : (genderRaw === '여' || genderRaw === '여자' || genderRaw === 'F') ? 'F' : null;
            let bib = hdrMap.bib !== undefined ? String(row[hdrMap.bib] || '').trim() : '';
            if (/^\d+$/.test(bib)) bib = bib.replace(/^0+(?=\d)/, '');      // 연맹 원본은 '00012' — 시스템 배번은 '12' (앞자리 0 때문에 전원 '변경'으로 잡히던 것 방지)
            if (!bib) continue;
            // 동명이인: 시스템은 '홍길동(06)' 처럼 출생연도를 붙여 구분한다 → 생년월일이 있으면 그 이름으로도 찾는다
            const _by = hdrMap.birth !== undefined ? String(row[hdrMap.birth] || '').replace(/\D/g, '') : '';
            const _yy = _by.length >= 8 ? _by.slice(2, 4) : (_by.length === 6 ? _by.slice(0, 2) : '');
            // If gender column exists but value is invalid, skip
            if (hasGenderCol && !gender) continue;
            const key = gender ? `${name}|${team}|${gender}` : `${name}|${team}`;
            if (!excelMap.has(key)) excelMap.set(key, { bib, hasGender: !!gender });
            else if (_yy) { const k2 = gender ? `${name}(${_yy})|${team}|${gender}` : `${name}(${_yy})|${team}`; if (!excelMap.has(k2)) excelMap.set(k2, { bib, hasGender: !!gender }); }
            if (_yy) _altKey.set(key + '#' + bib, gender ? `${name}(${_yy})|${team}|${gender}` : `${name}(${_yy})|${team}`);
        }

        const results = { matched: 0, updated: 0, already_same: 0, not_found: [], total_excel: excelMap.size };
        const updates = [];

        for (const [key, { bib: newBib, hasGender }] of excelMap) {
            let existing = null;
            if (hasGender) {
                existing = existingCache.get(key);
            } else {
                // Fallback: match by name+team only
                const found = existingNoGender.get(key);
                if (found) existing = found; // null means ambiguous → skip
            }
            if (!existing && _altKey.has(key + '#' + newBib)) {      // 동명이인 표기로 재시도
                const k2 = _altKey.get(key + '#' + newBib);
                existing = hasGender ? existingCache.get(k2) : (existingNoGender.get(k2) || null);
            }
            if (existing) {
                results.matched++;
                if (existing.bib_number === newBib) {
                    results.already_same++;
                } else {
                    updates.push({ id: existing.id, name: existing.name, team: existing.team, gender: existing.gender, old_bib: existing.bib_number, new_bib: newBib });
                    results.updated++;
                }
            } else {
                results.not_found.push(key);
            }
        }

        if (previewOnly) {
            return res.json({ success: true, preview: true, results, sample_updates: updates.slice(0, 20) });
        }

        // Apply updates
        await db.transaction(async () => {
            for (const u of updates) await db.run('UPDATE athlete SET bib_number=? WHERE id=?', u.new_bib, u.id);
        })();

        opLog(`BIB 일괄 수정: ${results.updated}명 업데이트, ${results.matched}명 매칭`, 'import', 'admin', competition_id);
        res.json({ success: true, results });
    } catch (err) { console.error(err); res.status(500).json({ error: 'BIB 업데이트 오류: ' + err.message }); }
});

// ============================================================
// PHONE BATCH UPDATE (from Excel)
// 양식: 선수명 + 팀명(선택) + 성별(선택) + 휴대폰
// 이름+소속(+성별)으로 매칭하여 phone만 업데이트
// ============================================================
app.post('/api/athletes/update-phone', upload.single('file'), async (req, res) => {
    const adminKey = req.body.admin_key || req.headers['x-admin-key'];
    if (!isAdminKey(adminKey) && !isOperationKey(adminKey)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    if (!req.file) return res.status(400).json({ error: '파일이 필요합니다.' });
    const competition_id = parseInt(req.body.competition_id);
    if (!competition_id) return res.status(400).json({ error: 'competition_id 필요' });
    const previewOnly = req.body.preview === 'true' || req.body.preview === true;
    try {
        const wb = XLSX.readFile(req.file.path);
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
        if (rows.length < 2) return res.status(400).json({ error: '데이터가 없습니다.' });
        const headers = rows[0] || [];

        const hdrMap = {};
        headers.forEach((h, idx) => {
            const hn = String(h || '').trim();
            if (/^(선수명|성명|이름|name)$/i.test(hn)) hdrMap.name = idx;
            else if (/^(팀명|소속|팀|team)$/i.test(hn)) hdrMap.team = idx;
            else if (/^(성별|gender)$/i.test(hn)) hdrMap.gender = idx;
            else if (/^(휴대폰|핸드폰|전화|전화번호|연락처|phone|phone_number|mobile)$/i.test(hn)) hdrMap.phone = idx;
        });
        if (hdrMap.name === undefined) return res.status(400).json({ error: '선수명 컬럼을 찾을 수 없습니다.' });
        if (hdrMap.phone === undefined) return res.status(400).json({ error: '휴대폰 컬럼을 찾을 수 없습니다.' });

        const cache = new Map();         // name|team|gender → athlete
        const cacheNG = new Map();       // name|team → athlete (또는 null=ambiguous)
        (await db.all('SELECT * FROM athlete WHERE competition_id=?', competition_id))
            .forEach(a => {
                cache.set(`${a.name}|${a.team}|${a.gender}`, a);
                const ng = `${a.name}|${a.team}`;
                cacheNG.set(ng, cacheNG.has(ng) ? null : a);
            });

        const results = { matched: 0, updated: 0, unchanged: 0, not_found: [] };
        const updates = [];

        for (const row of rows.slice(1)) {
            const name = String(row[hdrMap.name] || '').trim();
            if (!name) continue;
            const team = hdrMap.team !== undefined ? String(row[hdrMap.team] || '').trim() : '';
            const genderRaw = hdrMap.gender !== undefined ? String(row[hdrMap.gender] || '').trim() : '';
            const gender = (genderRaw === '남' || genderRaw === '남자' || genderRaw === 'M') ? 'M' : (genderRaw === '여' || genderRaw === '여자' || genderRaw === 'F') ? 'F' : null;
            const phone = _normalizeAthletePhone(row[hdrMap.phone]);
            if (!phone) continue;

            let existing = null;
            if (gender) existing = cache.get(`${name}|${team}|${gender}`);
            if (!existing) {
                const found = cacheNG.get(`${name}|${team}`);
                if (found) existing = found; // null이면 모호함
            }
            if (!existing) { results.not_found.push(`${name}/${team}`); continue; }
            results.matched++;
            if ((existing.phone || '') === phone) { results.unchanged++; continue; }
            updates.push({ id: existing.id, name: existing.name, team: existing.team, old: existing.phone || '', new: phone });
            results.updated++;
        }

        if (previewOnly) {
            return res.json({ success: true, preview: true, results, sample_updates: updates.slice(0, 30) });
        }

        await db.transaction(async () => {
            for (const u of updates) await db.run('UPDATE athlete SET phone=? WHERE id=?', u.new, u.id);
        })();

        opLog(`휴대폰 일괄 수정: ${results.updated}명 업데이트, ${results.matched}명 매칭`, 'import', 'admin', competition_id);
        res.json({ success: true, results });
    } catch (err) { console.error(err); res.status(500).json({ error: '휴대폰 업데이트 오류: ' + err.message }); }
});

// ============================================================
// EVENT-ONLY EXCEL UPLOAD
// 양식: 종목명 | 카테고리 | 성별(남/여/혼성) | 라운드
// 카테고리: track, field_distance, field_height, relay, combined, road
// 라운드: final(기본), preliminary, semifinal
// ============================================================
app.post('/api/events/upload', upload.single('file'), async (req, res) => {
    if (!isAdminKey(req.body.admin_key || req.headers['x-admin-key'])) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    if (!req.file) return res.status(400).json({ error: '파일이 필요합니다.' });
    const competition_id = parseInt(req.body.competition_id);
    if (!competition_id) return res.status(400).json({ error: 'competition_id 필요' });
    const clearExisting = req.body.clear_existing === 'true' || req.body.clear_existing === true;
    try {
        const wb = XLSX.readFile(req.file.path);
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
        if (rows.length < 2) return res.status(400).json({ error: '데이터가 없습니다.' });
        const dataRows = rows.slice(1).filter(r => r[0]); // 종목명(A열) 필수

        const CAT_ALIAS = {
            'track':'track','트랙':'track','field_distance':'field_distance','필드(거리)':'field_distance','필드거리':'field_distance',
            'field_height':'field_height','필드(높이)':'field_height','필드높이':'field_height',
            'relay':'relay','릴레이':'relay','combined':'combined','혼성':'combined','혼성경기':'combined',
            'road':'road','도로':'road','마라톤':'road'
        };
        const GENDER_ALIAS = { '남':'M','M':'M','남자':'M','여':'F','F':'F','여자':'F','혼성':'X','X':'X','혼':'X' };
        const ROUND_ALIAS = { '결승':'final','final':'final','예선':'preliminary','preliminary':'preliminary','준결승':'semifinal','semifinal':'semifinal' };

        let stats = { added: 0, skipped: 0 };

        await db.transaction(async () => {
            if (clearExisting) {
                const evts = await db.all('SELECT id FROM event WHERE competition_id=?', competition_id);
                for (const evt of evts) {
                    const hts = await db.all('SELECT id FROM heat WHERE event_id=?', evt.id);
                    for (const h of hts) { await db.run('DELETE FROM result WHERE heat_id=?', h.id); await db.run('DELETE FROM heat_entry WHERE heat_id=?', h.id); }
                    await db.run('DELETE FROM heat WHERE event_id=?', evt.id);
                    await db.run('DELETE FROM relay_member WHERE event_entry_id IN (SELECT id FROM event_entry WHERE event_id=?)', evt.id);
                    await db.run('DELETE FROM event_entry WHERE event_id=?', evt.id);
                }
                await db.run('DELETE FROM event WHERE competition_id=?', competition_id);
            }

            const existingCache = new Map();
            const existingEvents = await db.all('SELECT * FROM event WHERE competition_id=?', competition_id);
            for (const e of existingEvents) {
                existingCache.set(`${e.name}|${e.category}|${e.gender}|${e.round_type}`, e.id);
            }

            const INSERT_EVT_SQL = 'INSERT INTO event (competition_id,name,category,gender,round_type,round_status,sort_order) VALUES (?,?,?,?,?,?,?)';
            const INSERT_HEAT_SQL = 'INSERT INTO heat (event_id,heat_number) VALUES (?,?)';
            const mxRow = await db.get('SELECT MAX(sort_order) AS mx FROM event WHERE competition_id=?', competition_id);
            let sortOrder = ((mxRow && mxRow.mx) || 0) + 1;

            for (const row of dataRows) {
                const name = String(row[0] || '').trim();
                const catRaw = String(row[1] || '').trim().toLowerCase();
                const genderRaw = String(row[2] || '').trim();
                const roundRaw = String(row[3] || '').trim();

                const category = CAT_ALIAS[catRaw] || 'track';
                const gender = GENDER_ALIAS[genderRaw] || 'M';
                const roundType = ROUND_ALIAS[roundRaw] || 'final';

                if (!name) { stats.skipped++; continue; }
                const key = `${name}|${category}|${gender}|${roundType}`;
                if (existingCache.has(key)) { stats.skipped++; continue; }

                const r = await db.run(INSERT_EVT_SQL, competition_id, name, category, gender, roundType, 'created', sortOrder++);
                // Auto-create first heat
                await db.run(INSERT_HEAT_SQL, r.lastInsertRowid, 1);
                existingCache.set(key, r.lastInsertRowid);

                // Auto-create combined sub-events
                if (category === 'combined') {
                    const DECA = ['100m','멀리뛰기','포환던지기','높이뛰기','400m','110mH','원반던지기','장대높이뛰기','창던지기','1500m'];
                    const HEPTA = ['100mH','높이뛰기','포환던지기','200m','멀리뛰기','창던지기','800m'];
                    const subDefs = (gender === 'M') ? DECA : HEPTA;
                    const subCats = { '멀리뛰기':'field_distance','포환던지기':'field_distance','높이뛰기':'field_height',
                        '원반던지기':'field_distance','장대높이뛰기':'field_height','창던지기':'field_distance' };
                    for (const sn of subDefs) {
                        const sc = subCats[sn] || 'track';
                        const sr = await db.run(INSERT_EVT_SQL, competition_id, sn, sc, gender, 'final', 'created', sortOrder++);
                        await db.run('UPDATE event SET parent_event_id=? WHERE id=?', r.lastInsertRowid, sr.lastInsertRowid);
                        await db.run(INSERT_HEAT_SQL, sr.lastInsertRowid, 1);
                    }
                }

                stats.added++;
            }
        })();

        opLog(`종목 업로드: ${stats.added}개 추가, ${stats.skipped}개 스킵`, 'import', 'admin', competition_id);
        // Auto-sort after upload
        await autoSortCompetitionEvents(competition_id);
        res.json({ success: true, stats });
    } catch (err) { console.error(err); res.status(500).json({ error: '업로드 오류: ' + err.message }); }
});

// ============================================================
// HEAT ASSIGNMENT EXCEL UPLOAD (조편성 업로드)
// 양식: 성별 | 종목 | 라운드 | 조 | 그룹 | 순서 | 배번 | 성명 | 소속
// ============================================================

// Helper: Normalize event name from Excel to DB name
// Helper: 엑셀 종목명 → 저장 표기 (lib/eventName.js 로 이동)
// ============================================================
// 조편성 업로드 (preview/apply) — lib/routes/heat_assignment.js 로 추출 (2026-09)
// ============================================================
require('./lib/routes/heat_assignment')(app, { db, upload, isAdminKey, opLog, normalizeDivisionLabel, resolveFedEventName, guessEventCategory, autoLinkDisplayTimetable });

// ============================================================
// PACING LIGHT API (페이싱 라이트)
// ============================================================

// PACING 라우트들은 lib/routes/pacing.js 로 추출됨
require('./lib/routes/pacing')(app, { db, isOperationKey, opLog, getJudgeName, broadcastSSE });

// GET pacing configs for dashboard (public, no auth)
app.get('/api/public/pacing', async (req, res) => {
    const compId = parseInt(req.query.competition_id) || null;
    if (!compId) return res.status(400).json({ error: 'competition_id required' });
    const configs = await db.all('SELECT * FROM pacing_config WHERE competition_id=? ORDER BY event_name', compId);
    const result = [];
    for (const cfg of configs) {
        const colors = await db.all('SELECT * FROM pacing_color WHERE pacing_config_id=? ORDER BY sort_order', cfg.id);
        for (const c of colors) {
            c.segments = await db.all('SELECT * FROM pacing_segment WHERE pacing_color_id=? ORDER BY segment_order', c.id);
        }
        result.push({ ...cfg, colors });
    }
    res.json(result);
});

// ============================================================
// 계측 결과 가져오기 (.lif / 기록 xlsx / .txt) — lib/routes/timing_import.js 로 추출 (2026-09)
// ============================================================
const _timingImport = require('./lib/routes/timing_import')(app, { db, upload, isAdminKey, opLog, broadcastSSE, audit, getResultsRoutes: () => _resultsRoutes });
const { normBib: _recxNormBib, divToken: _recxDivToken, genderOf: _recxGenderOf, round: _recxRound } = _timingImport.recx;

// ============================================================
// 필드 수기 기록카드 가져오기 — lib/routes/field_card_import.js
// (투척·수평도약·수직도약 카드 → AI 전사 xlsx → 시기별 저장. 정규화 헬퍼는 기록 엑셀 가져오기와 공유)
// ============================================================
require('./lib/routes/field_card_import')(app, {
    db, isAdminKey, isOperationKey, opLog, broadcastSSE, audit, upload, requireAdminAfterCompEnd,
    recx: { normBib: _recxNormBib, divToken: _recxDivToken, genderOf: _recxGenderOf, round: _recxRound },
    runRecordCompareHook: _resultsRoutes && _resultsRoutes.runRecordCompareHook,
});

/**
 * GET /api/scoreboard/keys?competition_id=N
 * List all scoreboard_keys for a given competition (for debugging/review)
 */
app.get('/api/scoreboard/keys', async (req, res) => {
    const { competition_id } = req.query;
    if (!competition_id) return res.status(400).json({ error: 'competition_id 필수' });
    const keys = await db.all(`
        SELECT h.id as heat_id, h.heat_number, h.scoreboard_key, h.heat_name, h.wind,
               e.id as event_id, e.name as event_name, e.gender, e.round_type, e.category,
               e.competition_id
        FROM heat h
        JOIN event e ON e.id = h.event_id
        WHERE e.competition_id = ? AND h.scoreboard_key IS NOT NULL
        ORDER BY e.sort_order, h.heat_number
    `, competition_id);

    // 구식 event_link 기반 합동 키 (2-way 만 가능)
    const linkKeys = await db.all(`
        SELECT el.id as link_id, el.joint_scoreboard_key, el.event_id_a, el.event_id_b,
               ea.name as event_name, ea.gender, ea.round_type, ea.category
        FROM event_link el
        JOIN event ea ON ea.id = el.event_id_a
        WHERE (ea.competition_id = ? OR el.event_id_b IN (SELECT id FROM event WHERE competition_id = ?))
              AND el.joint_scoreboard_key IS NOT NULL
    `, competition_id, competition_id);

    // 신식 joint_group 기반 합동 키 (N-way 지원, 3-way "3way 10,000mW" 같은 케이스)
    const jointGroupKeysRaw = await db.all(`
        SELECT DISTINCT jg.id as joint_group_id, jg.name as joint_group_name, jg.joint_scoreboard_key
        FROM joint_group jg
        JOIN joint_group_member jgm ON jgm.joint_group_id = jg.id
        WHERE jgm.competition_id = ? AND jg.joint_scoreboard_key IS NOT NULL
    `, competition_id);

    // 각 joint_group 의 멤버 종목 정보까지 함께 묶어서 반환
    const jointGroupKeys = [];
    for (const jg of jointGroupKeysRaw) {
        const members = await db.all(`
            SELECT jgm.event_id, jgm.competition_id, jgm.sort_order,
                   e.name as event_name, e.gender, e.round_type, e.category, e.division
            FROM joint_group_member jgm
            JOIN event e ON e.id = jgm.event_id
            WHERE jgm.joint_group_id = ?
            ORDER BY jgm.sort_order
        `, jg.joint_group_id);
        const rep = members[0] || {};
        jointGroupKeys.push({
            joint_group_id: jg.joint_group_id,
            joint_scoreboard_key: jg.joint_scoreboard_key,
            name: jg.joint_group_name,
            gender: rep.gender || '',
            round_type: rep.round_type || '',
            category: rep.category || '',
            member_count: members.length,
            members
        });
    }

    res.json({
        heat_keys: keys,
        joint_keys: linkKeys,        // 호환성을 위해 기존 필드 유지
        joint_groups: jointGroupKeys // 신식 N-way 합동 그룹 (3way 등 — 외부 전광판은 이걸 봐야 함)
    });
});

/**
 * GET /api/scoreboard/lookup?key=남자실업부 100m 예선 1조&competition_id=N
 * 전광판 시스템에서 scoreboard_key로 heat + 선수 목록 조회
 */
app.get('/api/scoreboard/lookup', async (req, res) => {
    const { key, competition_id } = req.query;
    if (!key) return res.status(400).json({ error: 'key 필수 (scoreboard_key)' });
    
    // First try direct heat scoreboard_key match
    let heat;
    if (competition_id) {
        heat = await db.get(`
            SELECT h.*, e.name as event_name, e.gender, e.round_type, e.category, e.competition_id
            FROM heat h JOIN event e ON e.id = h.event_id
            WHERE h.scoreboard_key = ? AND e.competition_id = ?
        `, key, competition_id);
    } else {
        heat = await db.get(`
            SELECT h.*, e.name as event_name, e.gender, e.round_type, e.category, e.competition_id
            FROM heat h JOIN event e ON e.id = h.event_id
            WHERE h.scoreboard_key = ?
        `, key);
    }
    
    // If not found, check for joint scoreboard key
    if (!heat) {
        // ─── 신식 joint_group 우선 확인 (N-way 합동, 3way 등) ───
        const jointGroup = await db.get('SELECT * FROM joint_group WHERE joint_scoreboard_key = ?', key);
        if (jointGroup) {
            const members = await db.all(`
                SELECT jgm.event_id, jgm.competition_id, jgm.sort_order,
                       e.name as event_name, e.gender, e.round_type, e.category, e.division,
                       c.name as comp_name, c.federation
                FROM joint_group_member jgm
                JOIN event e ON e.id = jgm.event_id
                JOIN competition c ON c.id = jgm.competition_id
                WHERE jgm.joint_group_id = ?
                ORDER BY jgm.sort_order
            `, jointGroup.id);

            const allEntries = [];
            const seenEntry = new Set();
            for (const m of members) {
                // 각 멤버 종목의 최신 heat 가져옴
                const memberHeat = await db.get('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number DESC LIMIT 1', m.event_id);
                if (!memberHeat) continue;
                const memberEntries = await db.all(`
                    SELECT he.lane_number, he.sub_group, ee.id as event_entry_id, ee.status,
                           a.id as athlete_id, a.name, a.bib_number, a.team, a.gender,
                           a.federation as athlete_federation
                    FROM heat_entry he
                    JOIN event_entry ee ON ee.id = he.event_entry_id
                    JOIN athlete a ON a.id = ee.athlete_id
                    WHERE he.heat_id = ?
                    ORDER BY he.lane_number
                `, memberHeat.id);
                const memberResults = await db.all('SELECT * FROM result WHERE heat_id=?', memberHeat.id);
                for (const e of memberEntries) {
                    if (seenEntry.has(e.event_entry_id)) continue;
                    seenEntry.add(e.event_entry_id);
                    const r = memberResults.find(r => r.event_entry_id === e.event_entry_id);
                    allEntries.push({
                        ...e,
                        record: r ? (r.time_seconds || r.distance_meters || null) : null,
                        status_code: r ? r.status_code : null,
                        federation: m.federation || m.comp_name,
                        competition_id: m.competition_id,
                        event_id: m.event_id,
                        event_name: m.event_name,
                        heat_id: memberHeat.id,
                        wind: memberHeat.wind,
                    });
                }
            }

            const rep = members[0] || {};
            return res.json({
                is_joint: true,
                is_joint_group: true,
                joint_group_id: jointGroup.id,
                joint_scoreboard_key: key,
                event: {
                    name: jointGroup.joint_scoreboard_key || jointGroup.name,
                    gender: rep.gender || '',
                    round_type: rep.round_type || '',
                    category: rep.category || '',
                    competition_id: rep.competition_id
                },
                member_event_ids: members.map(m => m.event_id),
                entries: allEntries
            });
        }

        // ─── 구식 event_link 확인 (호환성 유지) ───
        const jointLink = await db.get(`SELECT * FROM event_link WHERE joint_scoreboard_key = ?`, key);
        if (jointLink) {
            // Found a joint key — redirect to joint scoreboard data
            const eventId = jointLink.event_id_a;
            const jointData = await getJointScoreboardData(eventId, db);
            if (jointData) {
                return res.json({
                    is_joint: true,
                    joint_scoreboard_key: key,
                    ...jointData
                });
            }
        }
        return res.status(404).json({ error: `매칭되는 조를 찾을 수 없습니다: "${key}"` });
    }
    
    const entries = await db.all(`
        SELECT he.lane_number, he.sub_group,
               ee.id as event_entry_id, ee.status,
               a.id as athlete_id, a.name, a.bib_number, a.team, a.gender
        FROM heat_entry he
        JOIN event_entry ee ON ee.id = he.event_entry_id
        JOIN athlete a ON a.id = ee.athlete_id
        WHERE he.heat_id = ?
        ORDER BY he.lane_number
    `, heat.id);
    
    res.json({
        heat_id: heat.id,
        heat_number: heat.heat_number,
        scoreboard_key: heat.scoreboard_key,
        event_name: heat.event_name,
        gender: heat.gender,
        round_type: heat.round_type,
        category: heat.category,
        competition_id: heat.competition_id,
        wind: heat.wind,
        entries
    });
});

// ============================================================
// EVENT LINK — 합동 종목 연결 (실업+대학 동시 진행 전광판)
// ============================================================

// EVENT LINK 라우트들은 lib/routes/event_links.js 로 추출됨
require('./lib/routes/event_links')(app, { db, isOperationKey, opLog, generateJointScoreboardKey });

// ============================================================
// JOINT GROUP MANAGEMENT — 합동 종목 그룹 (다중 대회 N:N)
// ============================================================
// JOINT GROUP 라우트들은 lib/routes/joint_groups.js 로 추출됨
require('./lib/routes/joint_groups')(app, { db, isOperationKey, opLog });
app.get('/api/admin/event-duplicates', async (req, res) => {
    if (!isAdminKey(req.query.admin_key || req.headers['x-admin-key'])) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    const competition_id = parseInt(req.query.competition_id);
    if (!competition_id) return res.status(400).json({ error: 'competition_id 필요' });
    try {
        const events = await db.all(
            'SELECT id, name, category, gender, round_type, round_status FROM event WHERE competition_id=? AND parent_event_id IS NULL ORDER BY id',
            competition_id
        );
        const _norm = s => String(s || '').replace(/[,\s]+/g, '').toLowerCase();
        const groups = new Map();
        for (const e of events) {
            const k = `${_norm(e.name)}|${e.gender}|${e.round_type || ''}`;
            if (!groups.has(k)) groups.set(k, []);
            groups.get(k).push(e);
        }
        const result = [];
        for (const [key, list] of groups) {
            if (list.length < 2) continue;
            // For each event in the group, count attached data
            const enriched = [];
            for (const e of list) {
                const heatCnt = (await db.get('SELECT COUNT(*) AS c FROM heat WHERE event_id=?', e.id))?.c || 0;
                const entryCnt = (await db.get('SELECT COUNT(*) AS c FROM event_entry WHERE event_id=?', e.id))?.c || 0;
                const resultCnt = (await db.get('SELECT COUNT(*) AS c FROM result r JOIN heat h ON h.id=r.heat_id WHERE h.event_id=?', e.id))?.c || 0;
                const inJointCnt = (await db.get('SELECT COUNT(*) AS c FROM joint_group_member WHERE event_id=?', e.id))?.c || 0;
                enriched.push({ ...e, heat_count: heatCnt, entry_count: entryCnt, result_count: resultCnt, joint_member_count: inJointCnt });
            }
            // Sort: prefer the one with most data (results > entries > heats > lowest id)
            enriched.sort((a, b) =>
                (b.result_count - a.result_count) ||
                (b.entry_count - a.entry_count) ||
                (b.heat_count - a.heat_count) ||
                (a.id - b.id)
            );
            result.push({
                key,
                name: list[0].name,
                gender: list[0].gender,
                round_type: list[0].round_type,
                keep: enriched[0],         // 보존 대상
                duplicates: enriched.slice(1),  // 삭제 대상 (사용자 확인 필요)
            });
        }
        res.json({ competition_id, duplicate_groups: result, total_dup_events: result.reduce((s,g) => s + g.duplicates.length, 0) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * POST /api/admin/event-duplicates/cleanup
 * Body: { admin_key, competition_id, dry_run?: bool, only_empty?: bool }
 * 중복 종목 중 데이터가 비어있는 것(empty) 또는 명시적으로 안전한 것만 삭제.
 * dry_run=true 이면 삭제는 안 하고 어떤 것들이 삭제될지 목록만 반환.
 * only_empty=true (default) 이면 entry/result/heat이 전부 0인 중복만 삭제 (가장 안전).
 */
app.post('/api/admin/event-duplicates/cleanup', async (req, res) => {
    if (!isAdminKey(req.body.admin_key || req.headers['x-admin-key'])) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    const competition_id = parseInt(req.body.competition_id);
    if (!competition_id) return res.status(400).json({ error: 'competition_id 필요' });
    const dryRun = req.body.dry_run === true || req.body.dry_run === 'true';
    const onlyEmpty = req.body.only_empty !== false && req.body.only_empty !== 'false';  // default true

    try {
        // Reuse diagnostic
        const events = await db.all(
            'SELECT id, name, category, gender, round_type FROM event WHERE competition_id=? AND parent_event_id IS NULL ORDER BY id',
            competition_id
        );
        const _norm = s => String(s || '').replace(/[,\s]+/g, '').toLowerCase();
        const groups = new Map();
        for (const e of events) {
            const k = `${_norm(e.name)}|${e.gender}|${e.round_type || ''}`;
            if (!groups.has(k)) groups.set(k, []);
            groups.get(k).push(e);
        }

        const candidates = [];   // events that will/would be deleted
        const skipped = [];      // events skipped (had data, not safe to delete)

        for (const [key, list] of groups) {
            if (list.length < 2) continue;
            const enriched = [];
            for (const e of list) {
                const heatCnt = (await db.get('SELECT COUNT(*) AS c FROM heat WHERE event_id=?', e.id))?.c || 0;
                const entryCnt = (await db.get('SELECT COUNT(*) AS c FROM event_entry WHERE event_id=?', e.id))?.c || 0;
                const resultCnt = (await db.get('SELECT COUNT(*) AS c FROM result r JOIN heat h ON h.id=r.heat_id WHERE h.event_id=?', e.id))?.c || 0;
                enriched.push({ ...e, heat_count: heatCnt, entry_count: entryCnt, result_count: resultCnt });
            }
            // keep best (most data); delete others IF empty
            enriched.sort((a, b) =>
                (b.result_count - a.result_count) ||
                (b.entry_count - a.entry_count) ||
                (b.heat_count - a.heat_count) ||
                (a.id - b.id)
            );
            const keep = enriched[0];
            for (const dup of enriched.slice(1)) {
                const isEmpty = dup.heat_count === 0 && dup.entry_count === 0 && dup.result_count === 0;
                if (onlyEmpty && !isEmpty) {
                    skipped.push({ ...dup, reason: 'has data (heat/entry/result)' });
                    continue;
                }
                candidates.push({ ...dup, keep_id: keep.id });
            }
        }

        if (dryRun) {
            return res.json({ dry_run: true, would_delete: candidates, skipped, total: candidates.length });
        }

        // Actually delete
        let deleted = 0;
        await db.transaction(async () => {
            for (const c of candidates) {
                // Re-point joint_group_member rows to the kept event (de-dupe later if same group)
                await db.run('UPDATE OR IGNORE joint_group_member SET event_id=? WHERE event_id=?', c.keep_id, c.id);
                // Remove the joint_group_member rows that conflicted (same group already had keep_id)
                await db.run('DELETE FROM joint_group_member WHERE event_id=?', c.id);
                // Clean up child rows (these should all be 0 if onlyEmpty=true, defensive otherwise)
                const heats = await db.all('SELECT id FROM heat WHERE event_id=?', c.id);
                for (const h of heats) {
                    await db.run('DELETE FROM result WHERE heat_id=?', h.id);
                    await db.run('DELETE FROM height_attempt WHERE heat_id=?', h.id);
                    await db.run('DELETE FROM heat_entry WHERE heat_id=?', h.id);
                }
                await db.run('DELETE FROM heat WHERE event_id=?', c.id);
                await db.run('DELETE FROM event_entry WHERE event_id=?', c.id);
                await db.run('DELETE FROM event_link WHERE event_id_a=? OR event_id_b=?', c.id, c.id);
                await db.run('DELETE FROM event WHERE id=?', c.id);
                deleted++;
            }
        })();
        opLog(`중복 종목 정리: ${deleted}개 종목 삭제 (대회 ${competition_id})`, 'admin', 'admin');
        res.json({ dry_run: false, deleted, skipped, total: candidates.length });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * POST /api/admin/event-duplicates/merge
 * Body: { admin_key, keep_id, dup_id, dry_run? }
 *
 * 두 중복 종목을 안전하게 병합. dup 의 모든 데이터를 keep 으로 이전한 뒤 dup 삭제.
 *
 * 처리 순서 (트랜잭션):
 *  1. dup 의 entry 중, 같은 athlete 가 keep 에도 있는지 검사 — 있으면 dup 측만 삭제 (keep 우선)
 *  2. dup 의 남은 entry 를 keep 으로 event_id 이전 (UPDATE event_entry SET event_id=keep_id)
 *  3. dup 의 heat 을 keep 으로 이전. heat_number 충돌하면 keep 의 max+1 로 재번호
 *  4. dup 의 joint_group_member 를 keep 으로 이전, UNIQUE 충돌 시 dup 측 삭제
 *  5. dup 의 event_link / event_video 등 메타 정리
 *  6. dup 삭제
 *
 * dry_run=true 면 어떤 일이 일어날지 카운트만 반환 (실제 변경 X).
 */
app.post('/api/admin/event-duplicates/merge', async (req, res) => {
    if (!isAdminKey(req.body.admin_key || req.headers['x-admin-key'])) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    const keep_id = parseInt(req.body.keep_id);
    const dup_id = parseInt(req.body.dup_id);
    const dryRun = req.body.dry_run === true || req.body.dry_run === 'true';
    if (!keep_id || !dup_id) return res.status(400).json({ error: 'keep_id, dup_id 필요' });
    if (keep_id === dup_id) return res.status(400).json({ error: 'keep_id 와 dup_id 가 동일' });

    try {
        const keep = await db.get('SELECT * FROM event WHERE id=?', keep_id);
        const dup = await db.get('SELECT * FROM event WHERE id=?', dup_id);
        if (!keep || !dup) return res.status(404).json({ error: '종목을 찾을 수 없음' });
        if (keep.competition_id !== dup.competition_id) return res.status(400).json({ error: '두 종목이 다른 대회에 속함 — 머지 불가' });

        // 1. dup 의 entry 분석
        const keepAthIds = new Set((await db.all('SELECT athlete_id FROM event_entry WHERE event_id=?', keep_id)).map(r => r.athlete_id));
        const dupEntries = await db.all('SELECT id, athlete_id FROM event_entry WHERE event_id=?', dup_id);
        const conflictEntries = dupEntries.filter(e => keepAthIds.has(e.athlete_id));
        const moveEntries = dupEntries.filter(e => !keepAthIds.has(e.athlete_id));

        // 2. heat 분석
        const dupHeats = await db.all('SELECT id, heat_number FROM heat WHERE event_id=?', dup_id);
        const keepMaxHeat = (await db.get('SELECT COALESCE(MAX(heat_number), 0) AS m FROM heat WHERE event_id=?', keep_id))?.m || 0;

        // 3. joint_group_member 분석
        const dupJgm = await db.all('SELECT id, joint_group_id FROM joint_group_member WHERE event_id=?', dup_id);
        const keepJgmGroups = new Set((await db.all('SELECT joint_group_id FROM joint_group_member WHERE event_id=?', keep_id)).map(r => r.joint_group_id));
        const conflictJgm = dupJgm.filter(j => keepJgmGroups.has(j.joint_group_id));
        const moveJgm = dupJgm.filter(j => !keepJgmGroups.has(j.joint_group_id));

        const summary = {
            keep_id, dup_id,
            keep_event: { name: keep.name, gender: keep.gender, round_type: keep.round_type },
            dup_event:  { name: dup.name,  gender: dup.gender,  round_type: dup.round_type },
            entries: {
                will_move:   moveEntries.length,
                will_delete: conflictEntries.length,
                reason: conflictEntries.length > 0 ? '같은 선수가 양쪽에 있으면 keep 측을 유지하고 dup 측 삭제' : ''
            },
            heats: {
                will_move: dupHeats.length,
                renumber_from: keepMaxHeat + 1,
                detail: dupHeats.map(h => ({ old_heat_number: h.heat_number, new_heat_number: keepMaxHeat + h.heat_number }))
            },
            joint_members: {
                will_move:   moveJgm.length,
                will_delete: conflictJgm.length,
            }
        };

        if (dryRun) return res.json({ dry_run: true, summary });

        await db.transaction(async () => {
            // 1) 충돌 entry → 삭제 (keep 측 유지)
            for (const e of conflictEntries) {
                // heat_entry 도 함께 정리
                await db.run('DELETE FROM heat_entry WHERE event_entry_id=?', e.id);
                await db.run('DELETE FROM event_entry WHERE id=?', e.id);
            }
            // 2) 남은 entry → keep 으로 이전
            for (const e of moveEntries) {
                await db.run('UPDATE event_entry SET event_id=? WHERE id=?', keep_id, e.id);
            }
            // 3) heat → 재번호 후 keep 으로 이전. heat_entry 는 heat_id 만 따라가므로 자동 OK.
            for (const h of dupHeats) {
                const newNum = keepMaxHeat + h.heat_number;
                await db.run('UPDATE heat SET event_id=?, heat_number=? WHERE id=?', keep_id, newNum, h.id);
            }
            // 4) joint_group_member → 이전 / 충돌 시 삭제
            for (const j of moveJgm) {
                await db.run('UPDATE joint_group_member SET event_id=? WHERE id=?', keep_id, j.id);
            }
            for (const j of conflictJgm) {
                await db.run('DELETE FROM joint_group_member WHERE id=?', j.id);
            }
            // 5) event_link 의 dup 측 참조를 keep 으로 (있으면)
            await db.run('UPDATE OR IGNORE event_link SET event_id_a=? WHERE event_id_a=?', keep_id, dup_id);
            await db.run('UPDATE OR IGNORE event_link SET event_id_b=? WHERE event_id_b=?', keep_id, dup_id);
            await db.run('DELETE FROM event_link WHERE event_id_a=? OR event_id_b=?', dup_id, dup_id);
            // 6) timetable 의 dup 참조도 keep 으로 (모두 끊지 말고 이전)
            await db.run('UPDATE timetable SET event_id=? WHERE event_id=?', keep_id, dup_id);
            // 7) dup 본체 삭제
            await db.run('DELETE FROM event WHERE id=?', dup_id);
        })();

        opLog(`중복 종목 병합: dup=${dup_id} → keep=${keep_id} (${keep.name} ${keep.gender})`, 'admin', 'admin', keep.competition_id);
        res.json({ dry_run: false, merged: true, summary });
    } catch (e) {
        console.error('[event-duplicates/merge] failed:', e);
        res.status(500).json({ error: e.message });
    }
});

/**
 * GET /api/scoreboard/joint?event_id=N
 * 합동 종목 전광판 데이터 — 연결된 모든 대회의 선수를 합쳐서 반환
 */
app.get('/api/scoreboard/joint', async (req, res) => {
    const { event_id } = req.query;
    if (!event_id) return res.status(400).json({ error: 'event_id 필수' });
    
    // Find all linked events
    const links = await db.all(`
        SELECT event_id_a, event_id_b FROM event_link
        WHERE event_id_a = ? OR event_id_b = ?
    `, event_id, event_id);
    
    const eventIds = new Set([parseInt(event_id)]);
    links.forEach(l => { eventIds.add(l.event_id_a); eventIds.add(l.event_id_b); });
    
    // Gather entries from all linked events
    const allEntries = [];
    for (const eid of eventIds) {
        const evt = await db.get('SELECT e.*, c.name as comp_name, c.federation FROM event e JOIN competition c ON c.id=e.competition_id WHERE e.id=?', eid);
        if (!evt) continue;
        
        const heat = await db.get('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number DESC LIMIT 1', eid);
        if (!heat) continue;
        
        const entries = await db.all(`
            SELECT he.lane_number, he.sub_group, ee.id as event_entry_id, ee.status,
                   a.name, a.bib_number, a.team, a.gender, a.federation as athlete_federation
            FROM heat_entry he
            JOIN event_entry ee ON ee.id = he.event_entry_id
            JOIN athlete a ON a.id = ee.athlete_id
            WHERE he.heat_id = ?
            ORDER BY he.lane_number
        `, heat.id);
        
        const results = await db.all('SELECT * FROM result WHERE heat_id=?', heat.id);
        
        // Label: use competition federation or name
        const fedLabel = evt.federation || evt.comp_name;
        
        entries.forEach(e => {
            const r = results.find(r => r.event_entry_id === e.event_entry_id);
            allEntries.push({
                ...e,
                record: r ? (r.time_seconds || r.distance_meters || null) : null,
                status_code: r ? r.status_code : null,
                federation: fedLabel,
                competition_id: evt.competition_id,
                event_id: eid,
                heat_id: heat.id,
                wind: heat.wind,
            });
        });
    }
    
    // Get primary event info
    const primaryEvt = await db.get('SELECT e.*, c.name as comp_name, c.federation FROM event e JOIN competition c ON c.id=e.competition_id WHERE e.id=?', event_id);
    
    res.json({
        event: primaryEvt,
        linked_event_ids: [...eventIds],
        entries: allEntries,
    });
});

// ============================================================
// RESULT IMAGE DOWNLOAD — 세부 경기 결과 이미지 (1080x1350)
// ============================================================

/**
 * GET /api/result-image/:eventId
 * 종목별 결과 이미지를 1080x1350 PNG로 생성
 */
app.get('/api/result-image/:eventId', async (req, res) => {
    try {
        const eventId = parseInt(req.params.eventId);
        const evt = await db.get('SELECT e.*, c.name as comp_name, c.federation FROM event e JOIN competition c ON c.id=e.competition_id WHERE e.id=?', eventId);
        if (!evt) return res.status(404).json({ error: 'Event not found' });

        const W = 1080, H = 1350;
        const canvas = createCanvas(W, H);
        const ctx = canvas.getContext('2d');

        // Background
        ctx.fillStyle = '#0a0c14';
        ctx.fillRect(0, 0, W, H);

        // Header gradient bar
        const grad = ctx.createLinearGradient(0, 0, W, 120);
        grad.addColorStop(0, '#1a5d3a');
        grad.addColorStop(1, '#2d9d78');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, W, 120);

        // Event name
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 36px "Noto Sans KR", sans-serif';
        const gLabel = evt.gender === 'M' ? '남자' : evt.gender === 'F' ? '여자' : '혼성';
        const roundLabel = { preliminary: '예선', semifinal: '준결승', final: '결승' }[evt.round_type] || '';
        ctx.fillText(`${gLabel} ${evt.name}`, 40, 55);
        ctx.font = '24px "Noto Sans KR", sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.fillText(`${roundLabel} | ${evt.comp_name}`, 40, 95);

        // Federation badge
        if (evt.federation) {
            const fedLabels = { KTFL: '실업', KUAF: '대학' };
            const fedText = fedLabels[evt.federation] || evt.federation;
            ctx.fillStyle = evt.federation === 'KTFL' ? '#2563eb' : '#dc2626';
            const tw = ctx.measureText(fedText).width;
            ctx.beginPath();
            ctx.roundRect(W - tw - 60, 30, tw + 20, 30, 6);
            ctx.fill();
            ctx.fillStyle = '#fff';
            ctx.font = 'bold 16px "Noto Sans KR", sans-serif';
            ctx.fillText(fedText, W - tw - 50, 52);
        }

        // Get heat data
        const heats = await db.all('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number', eventId);
        const isTrack = ['track', 'relay', 'road'].includes(evt.category);

        let y = 150;
        const ROW_H = 52;
        
        for (const heat of heats) {
            // Heat header
            if (heats.length > 1) {
                ctx.fillStyle = 'rgba(255,255,255,0.06)';
                ctx.fillRect(0, y, W, 36);
                ctx.fillStyle = '#4ade80';
                ctx.font = 'bold 18px "Noto Sans KR", sans-serif';
                const heatLabel = heat.heat_name || `${heat.heat_number}조`;
                ctx.fillText(heatLabel, 40, y + 25);
                if (heat.wind) {
                    ctx.fillStyle = '#a5d6c1';
                    ctx.font = '14px "Noto Sans KR", sans-serif';
                    ctx.fillText(`Wind: ${heat.wind}`, 200, y + 25);
                }
                y += 40;
            } else if (heat.wind) {
                ctx.fillStyle = '#a5d6c1';
                ctx.font = '14px "Noto Sans KR", sans-serif';
                ctx.fillText(`Wind: ${heat.wind}`, 40, y + 15);
                y += 25;
            }

            // Column headers
            ctx.fillStyle = 'rgba(255,255,255,0.04)';
            ctx.fillRect(0, y, W, 32);
            ctx.fillStyle = '#6b7b8d';
            ctx.font = 'bold 13px "Noto Sans KR", sans-serif';
            ctx.fillText('순위', 40, y + 22);
            ctx.fillText('배번', 120, y + 22);
            ctx.fillText('선수', 220, y + 22);
            ctx.fillText('소속', 520, y + 22);
            ctx.fillText('기록', 800, y + 22);
            y += 36;

            // Get entries with results
            const entries = await db.all(`
                SELECT he.lane_number, ee.id as event_entry_id, ee.status,
                       a.name, a.bib_number, a.team
                FROM heat_entry he
                JOIN event_entry ee ON ee.id = he.event_entry_id
                JOIN athlete a ON a.id = ee.athlete_id
                WHERE he.heat_id = ?
                ORDER BY he.lane_number
            `, heat.id);

            const results = await db.all('SELECT * FROM result WHERE heat_id=?', heat.id);

            // Build sorted entries
            const sortedEntries = entries.map(e => {
                const r = results.find(r => r.event_entry_id === e.event_entry_id);
                return {
                    ...e,
                    time: r?.time_seconds || r?.distance_meters || null,
                    status_code: r?.status_code || null,
                };
            }).sort((a, b) => {
                const aS = a.status_code === 'DNS' || a.status_code === 'DNF' || a.status_code === 'DQ';
                const bS = b.status_code === 'DNS' || b.status_code === 'DNF' || b.status_code === 'DQ';
                if (aS && !bS) return 1;
                if (!aS && bS) return -1;
                if (a.time == null && b.time == null) return (a.lane_number || 0) - (b.lane_number || 0);
                if (a.time == null) return 1;
                if (b.time == null) return -1;
                return isTrack ? a.time - b.time : b.time - a.time;
            });

            let rank = 0;
            for (const e of sortedEntries) {
                if (y + ROW_H > H - 80) break; // Leave room for footer

                const special = e.status_code === 'DNS' || e.status_code === 'DNF' || e.status_code === 'DQ';
                if (!special && e.time != null) rank++;

                // Alternating row bg
                if (rank > 0 && rank <= 3 && !special) {
                    ctx.fillStyle = 'rgba(45,157,120,0.12)';
                    ctx.fillRect(0, y, W, ROW_H);
                }

                // Rank
                if (!special && e.time != null) {
                    ctx.fillStyle = rank === 1 ? '#fbbf24' : rank === 2 ? '#cbd5e1' : rank === 3 ? '#d97706' : '#ffffff';
                    ctx.font = 'bold 22px "Noto Sans KR", sans-serif';
                    ctx.fillText(String(rank), 50, y + 34);
                }

                // Bib
                ctx.fillStyle = '#ffffff';
                ctx.font = 'bold 18px "Noto Sans KR", sans-serif';
                ctx.fillText(e.bib_number || '', 120, y + 34);

                // Name
                ctx.fillStyle = special ? 'rgba(255,255,255,0.4)' : '#ffffff';
                ctx.font = 'bold 20px "Noto Sans KR", sans-serif';
                ctx.fillText(e.name || '', 220, y + 34);

                // Team
                ctx.fillStyle = '#8a9bae';
                ctx.font = '15px "Noto Sans KR", sans-serif';
                ctx.fillText(e.team || '', 520, y + 34);

                // Record
                if (special) {
                    ctx.fillStyle = '#ef4444';
                    ctx.font = 'bold 18px "Noto Sans KR", sans-serif';
                    ctx.fillText(e.status_code, 800, y + 34);
                } else if (e.time != null) {
                    ctx.fillStyle = '#4ade80';
                    ctx.font = 'bold 22px monospace';
                    ctx.fillText(formatTimeForImage(e.time, isTrack), 780, y + 34);
                }

                // Row separator
                ctx.strokeStyle = 'rgba(255,255,255,0.05)';
                ctx.beginPath();
                ctx.moveTo(30, y + ROW_H);
                ctx.lineTo(W - 30, y + ROW_H);
                ctx.stroke();

                y += ROW_H;
            }
            y += 10;
        }

        // Footer
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(0, H - 50, W, 50);
        ctx.fillStyle = '#4a5';
        ctx.font = 'bold 14px "Noto Sans KR", sans-serif';
        ctx.fillText('PACE RISE', 40, H - 20);
        ctx.fillStyle = '#556';
        ctx.font = '11px "Noto Sans KR", sans-serif';
        const now = kstNow();
        ctx.fillText(now, W - 200, H - 20);

        // Send as PNG
        res.setHeader('Content-Type', 'image/png');
        const safeName = encodeURIComponent(`result_${evt.name}_${gLabel}.png`);
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${safeName}`);
        canvas.createPNGStream().pipe(res);
    } catch (err) {
        console.error('[Result Image]', err);
        res.status(500).json({ error: err.message });
    }
});

function formatTimeForImage(s, isTrack) {
    if (s == null) return '';
    if (!isTrack) return s.toFixed(2) + 'm';
    if (s >= 3600) {
        const h = Math.floor(s / 3600), m = Math.floor((s - h * 3600) / 60), r = s - h * 3600 - m * 60;
        return `${h}:${String(m).padStart(2,'0')}:${r < 10 ? '0' : ''}${r.toFixed(2)}`;
    }
    if (s >= 60) {
        const m = Math.floor(s / 60), r = s - m * 60;
        return `${m}:${r < 10 ? '0' : ''}${r.toFixed(2)}`;
    }
    return s.toFixed(2);
}

// ============================================================
// DEFAULT ROUTE → Home
// ============================================================
// Root serves index.html via express.static

// ============================================================
// GLOBAL ERROR HANDLER — 서버 크래시 방지 + PG/DB 입력 검증 에러 정규화
// ============================================================
app.use((err, req, res, next) => {
    // PG 특유의 잘못된 입력 → 400 으로 정규화 (SQLite는 lenient 처리, PG와 동작 통일)
    // 대표 코드:
    //   22P02 invalid_text_representation (예: BIGINT 컬럼에 'abc' 바인딩)
    //   22003 numeric_value_out_of_range
    //   22001 string_data_right_truncation
    //   23502 not_null_violation (필수 컬럼 NULL)
    //   23505 unique_violation
    //   23503 foreign_key_violation
    //   42P01 undefined_table, 42703 undefined_column (스키마 버그 — 운영 중에 발생하면 안 됨)
    const pgCode = err && err.code;
    if (pgCode === '22P02' || pgCode === '22003' || pgCode === '22001') {
        console.warn('[PG input invalid]', req.method, req.originalUrl, err.message);
        return res.status(400).json({ error: '잘못된 입력 형식입니다.', detail: err.message });
    }
    if (pgCode === '23505') {
        return res.status(409).json({ error: '이미 존재하는 값입니다 (중복).', detail: err.message });
    }
    if (pgCode === '23503') {
        return res.status(409).json({ error: '참조 무결성 위반 (연결된 데이터 존재).', detail: err.message });
    }
    if (pgCode === '23502') {
        return res.status(400).json({ error: '필수 값이 누락되었습니다.', detail: err.message });
    }
    console.error('[ERROR]', new Date().toISOString(), err.stack || err);
    res.status(500).json({ error: '서버 내부 오류가 발생했습니다.' });
});

// 예상치 못한 에러로 서버가 죽지 않도록 보호
process.on('uncaughtException', (err) => {
    console.error('[FATAL] Uncaught Exception:', new Date().toISOString(), err);
});
process.on('unhandledRejection', (reason) => {
    console.error('[FATAL] Unhandled Rejection:', new Date().toISOString(), reason);
});

// WA Validation API endpoints
app.get('/api/wa-validate/:id', async (req, res) => {
    const result = await validateWAHeatLanes(parseInt(req.params.id), db);
    res.json(result);
});
app.post('/api/wa-correct/:id', async (req, res) => {
    const result = await autoCorrectWALanes(parseInt(req.params.id), db);
    res.json(result);
});

// ============================================================
// DOCUMENT TEMPLATE SETTINGS — 문서 양식 커스터마이징
// ============================================================
// Ensure doc_template / event_records tables exist — SQLite-only 부트 마이그레이션
// PG 모드: schema.pg.sql 이 이미 정의함.
if (!db.isAsync) {
    try { db.exec(`CREATE TABLE IF NOT EXISTS doc_template (
        competition_id INTEGER PRIMARY KEY,
        ad_card TEXT DEFAULT '{}',
        start_list TEXT DEFAULT '{}',
        result_sheet TEXT DEFAULT '{}'
    )`); } catch(e) {}

    try { db.exec(`CREATE TABLE IF NOT EXISTS event_records (
        event_id INTEGER PRIMARY KEY,
        records TEXT DEFAULT '{}'
    )`); } catch(e) {}
    // 종합기록지 설정(심판장·기록원·표시 항목) — 예전엔 화면에서 보내도 저장 열이 없어 버려졌다 (2026-09)
    try { db.exec(`ALTER TABLE doc_template ADD COLUMN comprehensive TEXT DEFAULT '{}'`); } catch(e) {}
}

const DOC_DEFAULTS = {
    comprehensive: {
        chief_judge: '', chief_recorder: '', logo_left: '', logo_right: '',
        show_name: true, show_team: true, show_record: true, show_wind: true, show_bib: true, show_remark: true,
        cat_track: true, cat_field: true, cat_relay: true, cat_road: true, cat_combined: true,
    },
    ad_card: {
        cards_per_page: 4, bib_font_size: 48, name_font_size: 16,
        band_color_mode: 'gender_auto', custom_band_color: '#2d9d78', logo_url: '',
        show_bib: true, show_name: true, show_team: true, show_gender: true, show_events: true, show_barcode: false
    },
    start_list: {
        team_label: 'Team', font_size: 9, show_header: true,
        show_lane: true, show_bib: true, show_name: true, show_team: true, show_status: true, show_pb: false, show_dob: false,
        logo_left: '', logo_right: ''
    },
    result_sheet: {
        team_label: 'Team', font_size: 9, show_header: true, show_signature: true,
        show_rank: true, show_lane: true, show_bib: true, show_name: true, show_team: true, show_record: true, show_remark: true, show_wind: false,
        logo_left: '', logo_right: '',
        recorder_name: '', chief_recorder_name: '',
        show_records_table: true,
        records: { nr: { label: '한국기록(NR)', record: '', athlete: '', team: '', year: '' },
                   dr: { label: '부별기록(DR)', record: '', athlete: '', team: '', year: '' },
                   cr: { label: '대회기록(CR)', record: '', athlete: '', team: '', year: '' } }
    }
};

async function getDocTemplate(compId) {
    const row = await db.get('SELECT * FROM doc_template WHERE competition_id=?', compId);
    let result;
    if (!row) {
        result = JSON.parse(JSON.stringify(DOC_DEFAULTS));
    } else {
        try {
            result = {
                ad_card: { ...DOC_DEFAULTS.ad_card, ...JSON.parse(row.ad_card || '{}') },
                start_list: { ...DOC_DEFAULTS.start_list, ...JSON.parse(row.start_list || '{}') },
                result_sheet: { ...DOC_DEFAULTS.result_sheet, ...JSON.parse(row.result_sheet || '{}') },
                comprehensive: { ...DOC_DEFAULTS.comprehensive, ...JSON.parse(row.comprehensive || '{}') }
            };
        } catch(e) { result = JSON.parse(JSON.stringify(DOC_DEFAULTS)); }
    }
    // Auto-detect logo files if not set in template
    const logoDir = path.join(__dirname, 'public', 'uploads', 'logos');
    for (const pos of ['left', 'right']) {
        const field = `logo_${pos}`;
        for (const ext of ['.png', '.jpg', '.jpeg', '.gif', '.webp']) {
            const fPath = path.join(logoDir, `logo_${pos}_${compId}${ext}`);
            if (fs.existsSync(fPath)) {
                const publicUrl = `/uploads/logos/logo_${pos}_${compId}${ext}`;
                for (const docType of ['start_list', 'result_sheet', 'ad_card']) {
                    if (!result[docType][field]) result[docType][field] = publicUrl;
                }
                break;
            }
        }
    }
    return result;
}

app.get('/api/doc-templates/:compId', async (req, res) => {
    res.json(await getDocTemplate(req.params.compId));
});

app.post('/api/doc-templates', async (req, res) => {
    const { admin_key, competition_id, templates } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    if (!competition_id || !templates) return res.status(400).json({ error: 'competition_id, templates required' });
    const ad = JSON.stringify(templates.ad_card || {});
    const sl = JSON.stringify(templates.start_list || {});
    const rs = JSON.stringify(templates.result_sheet || {});
    const cp = JSON.stringify(templates.comprehensive || {});
    await db.run('INSERT INTO doc_template (competition_id, ad_card, start_list, result_sheet, comprehensive) VALUES (?, ?, ?, ?, ?) ON CONFLICT(competition_id) DO UPDATE SET ad_card=excluded.ad_card, start_list=excluded.start_list, result_sheet=excluded.result_sheet, comprehensive=excluded.comprehensive', competition_id, ad, sl, rs, cp);
    opLog('문서 양식 설정 업데이트', 'admin', 'admin', competition_id);
    res.json({ success: true });
});

// Logo upload for PDF documents
app.post('/api/doc-logos/upload', upload.single('logo'), async (req, res) => {
    if (!req.body.admin_key || !isOperationKey(req.body.admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const compId = req.body.competition_id;
    const position = req.body.position; // 'left', 'right', 'bottom'
    if (!compId || !['left', 'right', 'bottom'].includes(position)) return res.status(400).json({ error: 'competition_id and position (left/right/bottom) required' });

    // Save to persistent location
    const ext = (path.extname(req.file.originalname) || '.png').toLowerCase();
    const destDir = path.join(__dirname, 'public', 'uploads', 'logos');
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

    // 🛠️ 새 로고 업로드 전에 동일 (대회×포지션) 의 기존 로고 파일을 모두 제거.
    // 그래야 PNG → JPG 처럼 확장자가 바뀐 재업로드 시 옛 파일이 우선 매치되어
    // 종합기록지 등에 이전 로고가 계속 나오는 문제를 막을 수 있음.
    const oldExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
    for (const oe of oldExts) {
        try {
            const oldPath = path.join(destDir, `logo_${position}_${compId}${oe}`);
            if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        } catch(e) { /* skip */ }
    }

    const filename = `logo_${position}_${compId}${ext}`;
    const destPath = path.join(destDir, filename);
    fs.copyFileSync(req.file.path, destPath);
    fs.unlinkSync(req.file.path);

    // ⚠️ DB 에 저장하는 경로에는 절대 querystring(?v=...) 을 붙이지 않는다.
    // drawPdfHeader 등 서버 측에서 path.join(__dirname, 'public', logoLeft) 로
    // 실제 파일을 찾을 때 ?v=... 가 경로의 일부로 들어가 fs.existsSync 가 실패하기 때문.
    // 캐시버스터는 클라이언트 응답에만 별도로 붙여 브라우저 미리보기 캐시를 무효화.
    const publicUrl = `/uploads/logos/${filename}`;
    const cacheBustUrl = `${publicUrl}?v=${Date.now()}`;

    // Auto-update doc_template with the logo path for all document types
    const logoField = position === 'left' ? 'logo_left' : position === 'right' ? 'logo_right' : null;
    if (logoField) {
        const existing = await db.get('SELECT * FROM doc_template WHERE competition_id=?', compId);
        if (existing) {
            // Update each template sub-object with the new logo path
            for (const docType of ['start_list', 'result_sheet', 'ad_card']) {
                try {
                    const tpl = JSON.parse(existing[docType] || '{}');
                    tpl[logoField] = publicUrl;
                    await db.run(`UPDATE doc_template SET ${docType}=? WHERE competition_id=?`, JSON.stringify(tpl), compId);
                } catch(e) {}
            }
        } else {
            // Create default template with logo
            const sl = { ...DOC_DEFAULTS.start_list, [logoField]: publicUrl };
            const rs = { ...DOC_DEFAULTS.result_sheet, [logoField]: publicUrl };
            const ac = { ...DOC_DEFAULTS.ad_card, [logoField]: publicUrl };
            await db.run('INSERT INTO doc_template (competition_id, ad_card, start_list, result_sheet) VALUES (?,?,?,?)', compId, JSON.stringify(ac), JSON.stringify(sl), JSON.stringify(rs));
        }
    }

    opLog(`로고 업로드 (${position})`, 'admin', 'admin', compId);
    // 응답 url 은 캐시버스터 포함 → 클라이언트 미리보기가 즉시 새 이미지로 갱신.
    res.json({ success: true, url: cacheBustUrl, path: destPath });
});

// Logo delete for PDF documents
app.post('/api/doc-logos/delete', async (req, res) => {
    if (!req.body.admin_key || !isOperationKey(req.body.admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    const compId = req.body.competition_id;
    const position = req.body.position;
    if (!compId || !['left', 'right'].includes(position)) return res.status(400).json({ error: 'competition_id and position required' });

    const logoField = position === 'left' ? 'logo_left' : 'logo_right';
    const existing = await db.get('SELECT * FROM doc_template WHERE competition_id=?', compId);
    if (existing) {
        for (const docType of ['start_list', 'result_sheet', 'ad_card']) {
            try {
                const tpl = JSON.parse(existing[docType] || '{}');
                const oldPath = tpl[logoField];
                tpl[logoField] = '';
                await db.run(`UPDATE doc_template SET ${docType}=? WHERE competition_id=?`, JSON.stringify(tpl), compId);
                // Delete file if exists
                if (oldPath) {
                    const filePath = path.join(__dirname, 'public', oldPath.replace(/^\//, ''));
                    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                }
            } catch(e) {}
        }
    }
    try { opLog(`로고 삭제 (${position})`, 'admin', 'admin', compId); } catch(e) {}
    res.json({ success: true });
});

// ============================================================
// Per-Event Records BUNDLE — single JSON blob per event (NR/DR/CR per event_id)
// Backed by 'event_records' table (plural, JSON column).
// Distinct from 'event_record' (singular, normalized) registry served by
// /api/event-records?gender= / /api/event-records/:gender/:eventName / PUT
// further down. The naming collision is historical; bundle routes now use
// /api/event-record-bundle prefix with /api/event-records old aliases kept
// for backward compatibility (UI has been migrated).
// ============================================================
async function _bundleGet(req, res) {
    const row = await db.get('SELECT * FROM event_records WHERE event_id=?', req.params.eventId);
    if (!row) return res.json({ event_id: parseInt(req.params.eventId), records: {} });
    try {
        res.json({ event_id: row.event_id, records: JSON.parse(row.records || '{}') });
    } catch(e) {
        res.json({ event_id: row.event_id, records: {} });
    }
}
async function _bundlePost(req, res) {
    const { admin_key, event_id, records } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    if (!event_id || !records) return res.status(400).json({ error: 'event_id, records required' });
    await db.run('INSERT INTO event_records (event_id, records) VALUES (?, ?) ON CONFLICT(event_id) DO UPDATE SET records=excluded.records', event_id, JSON.stringify(records));
    opLog(`종목별 기록(NR/DR/CR) 저장 event_id=${event_id}`, 'admin', 'admin');
    res.json({ success: true });
}
// Canonical bundle URLs (preferred)
app.get('/api/event-record-bundle/:eventId', _bundleGet);
app.post('/api/event-record-bundle', _bundlePost);

// Phase C: 종목 1건에 대한 NR/DR/CR 정확 매칭 조회 (공개 페이지용)
//   ⚠️ 이 라우트는 /api/event-records/:eventId 보다 먼저 정의되어야 함 (Express 매칭 순서)
//   GET /api/event-records/lookup?event_name=100m&gender=M&division_code=M_OPEN&series_id=3
//   → { national: {...}|null, division: {...}|null, competition: {...}|null }
//   approved=1 만 반환
app.get('/api/event-records/lookup', async (req, res) => {
    try {
        const eventName = (req.query.event_name || '').trim();
        const gender = (req.query.gender || '').trim();
        if (!eventName || !gender) return res.status(400).json({ error: 'event_name, gender 필수' });
        const divCode = req.query.division_code ? String(req.query.division_code).trim() : null;
        const seriesId = req.query.series_id ? parseInt(req.query.series_id, 10) : null;

        // ─── 종목명 매칭 헬퍼: 1) 정확 매칭 시도 → 없으면 2) 정규화 fallback.
        //     event_record 에 '10000mW' 로 저장돼있고 클라가 '10,000m W' 처럼 보낸 경우도 잡아냄.
        const targetNorm = normalizeEventNameServer(eventName);
        async function _findOne(typeKey, extraSql, extraArgs) {
            // 1차: 정확 매칭
            const exact = await db.get(
                `SELECT * FROM event_record WHERE record_type='${typeKey}' AND event_name=? AND gender=?
                 ${extraSql} AND approved=1 ORDER BY id DESC LIMIT 1`,
                eventName, gender, ...extraArgs
            );
            if (exact) return exact;
            // 2차: 동일 (gender + 조건) 안에서 event_name 정규화 후 비교
            const candidates = await db.all(
                `SELECT * FROM event_record WHERE record_type='${typeKey}' AND gender=?
                 ${extraSql} AND approved=1`,
                gender, ...extraArgs
            );
            for (const c of (candidates || [])) {
                if (normalizeEventNameServer(c.event_name || '') === targetNorm) return c;
            }
            return null;
        }

        const out = { national: null, division: null, competition: null };
        out.national = await _findOne('national', `AND division_code IS NULL AND series_id IS NULL`, []);
        if (divCode) {
            out.division = await _findOne('division', `AND division_code=? AND series_id IS NULL`, [divCode]);
        }
        if (seriesId) {
            out.competition = await _findOne('competition', `AND division_code IS NULL AND series_id=?`, [seriesId]);
        }
        res.json(out);
    } catch (err) {
        console.error('[event-records/lookup]', err);
        res.status(500).json({ error: err.message });
    }
});

// Backward-compat aliases (deprecated — remove after one release cycle)
app.get('/api/event-records/:eventId', _bundleGet);
app.post('/api/event-records', _bundlePost);

// ============================================================
// [Admin] 시리즈 ↔ 대회 종목 매칭 진단 / 일괄 정규화
// ============================================================
// GET /api/admin/event-record-matching?competition_id=123
//   → 해당 대회의 모든 종목에 대해 NR/DR/CR 매칭 상태를 진단하여 반환.
//      각 종목별로 { event_name, gender, division_code, series_id,
//                  national: 'exact'|'normalized'|'none',
//                  division: ...,
//                  competition: ...,
//                  hints: [{ type, db_event_name, suggestion }] }
//      운영자가 어떤 종목에 NR/CR 매칭이 안 되는지 한눈에 보고 정규화 버튼으로 일괄 정리.
app.get('/api/admin/event-record-matching', async (req, res) => {
    try {
        const compId = parseInt(req.query.competition_id, 10);
        if (!compId) return res.status(400).json({ error: 'competition_id 필수' });
        const comp = await db.get('SELECT * FROM competition WHERE id=?', compId);
        if (!comp) return res.status(404).json({ error: '대회를 찾을 수 없습니다.' });

        const seriesId = comp.series_id || null;
        // 대회의 모든 종목 (부모 합동/혼성 포함, 세부종목 제외)
        // ⚠️ event 테이블에는 division_code 컬럼이 없다 (division 만 존재).
        //    DR 매칭은 event 의 division_code 가 아닌 competition 의 division_type 으로 처리하거나
        //    종목별 부 구분이 없으면 n/a 처리. 현재는 모든 event 의 division_code 를 null 로 본다.
        const events = await db.all(
            `SELECT id, name, gender FROM event WHERE competition_id=? AND parent_event_id IS NULL ORDER BY id`,
            compId
        );
        // division_code 필드를 가상으로 추가 (현재 event 테이블에 컬럼 없으므로 항상 null)
        for (const e of events) e.division_code = null;
        // 모든 event_record (approved=1) 를 한 번에 가져와 매칭 (DB hit 최소화)
        const allRecords = await db.all(
            `SELECT id, record_type, event_name, gender, division_code, series_id, record_value, holder_name FROM event_record WHERE approved=1`
        );

        // 헬퍼: 동일 (record_type, gender, divCode, seriesId) 묶음에서 매칭 찾기
        function findMatch(records, type, gender, divCode, seriesIdArg, eventName) {
            const targetNorm = normalizeEventNameServer(eventName);
            // 1) 동일 type/gender/divCode/seriesId 인 후보 좁히기
            const cands = records.filter(r =>
                r.record_type === type && r.gender === gender &&
                ((divCode == null && !r.division_code) || r.division_code === divCode) &&
                ((seriesIdArg == null && !r.series_id) || r.series_id === seriesIdArg)
            );
            if (cands.length === 0) return { status: 'none', record: null };
            // 2) 정확 매칭
            const exact = cands.find(r => r.event_name === eventName);
            if (exact) return { status: 'exact', record: exact };
            // 3) 정규화 fallback
            const normMatch = cands.find(r => normalizeEventNameServer(r.event_name || '') === targetNorm);
            if (normMatch) return { status: 'normalized', record: normMatch };
            // 매칭 안 됨 → 종목명 유사도로 후보 좁히기 (전체 cands 가 아닌 관련 후보만)
            //   1) 정규형이 동일하거나
            //   2) 한쪽이 다른 쪽의 부분문자열이거나
            //   3) 정규형 기준 substring 관계
            const targetLower = String(eventName || '').toLowerCase();
            function _isRelated(c) {
                const cn = String(c.event_name || '');
                const cnNorm = normalizeEventNameServer(cn);
                if (cnNorm === targetNorm) return true;
                const cnLower = cn.toLowerCase();
                if (cnLower.includes(targetLower) || targetLower.includes(cnLower)) return true;
                if (cnNorm && (cnNorm.includes(targetNorm) || targetNorm.includes(cnNorm))) return true;
                return false;
            }
            const related = cands.filter(_isRelated);
            // 유사 후보만 표시 (관련 없는 전체 후보 노출 X). 관련 후보 0 이면 빈 배열.
            const finalCands = related.slice(0, 5);
            return {
                status: 'none',
                record: null,
                candidates: finalCands.map(c => c.event_name),
                candidate_records: finalCands.map(c => ({ id: c.id, event_name: c.event_name, record_value: c.record_value, holder_name: c.holder_name }))
            };
        }

        const results = events.map(evt => {
            const nr = findMatch(allRecords, 'national', evt.gender, null, null, evt.name);
            const dr = evt.division_code
                ? findMatch(allRecords, 'division', evt.gender, evt.division_code, null, evt.name)
                : { status: 'n/a', record: null };
            const cr = seriesId
                ? findMatch(allRecords, 'competition', evt.gender, null, seriesId, evt.name)
                : { status: 'n/a', record: null };
            return {
                event_id: evt.id,
                event_name: evt.name,
                event_name_normalized: normalizeEventNameServer(evt.name),
                gender: evt.gender,
                division_code: evt.division_code,
                national:    { status: nr.status, db_event_name: nr.record ? nr.record.event_name : null, record_id: nr.record ? nr.record.id : null, record_value: nr.record ? nr.record.record_value : null, holder_name: nr.record ? nr.record.holder_name : null, candidates: nr.candidates || [], candidate_records: nr.candidate_records || [] },
                division:    { status: dr.status, db_event_name: dr.record ? dr.record.event_name : null, record_id: dr.record ? dr.record.id : null, record_value: dr.record ? dr.record.record_value : null, holder_name: dr.record ? dr.record.holder_name : null, candidates: dr.candidates || [], candidate_records: dr.candidate_records || [] },
                competition: { status: cr.status, db_event_name: cr.record ? cr.record.event_name : null, record_id: cr.record ? cr.record.id : null, record_value: cr.record ? cr.record.record_value : null, holder_name: cr.record ? cr.record.holder_name : null, candidates: cr.candidates || [], candidate_records: cr.candidate_records || [] }
            };
        });

        // 요약 통계
        const summary = {
            total_events: events.length,
            nr: { exact: 0, normalized: 0, none: 0 },
            dr: { exact: 0, normalized: 0, none: 0, na: 0 },
            cr: { exact: 0, normalized: 0, none: 0, na: 0 }
        };
        for (const r of results) {
            if (r.national.status === 'exact') summary.nr.exact++;
            else if (r.national.status === 'normalized') summary.nr.normalized++;
            else summary.nr.none++;
            if (r.division.status === 'exact') summary.dr.exact++;
            else if (r.division.status === 'normalized') summary.dr.normalized++;
            else if (r.division.status === 'n/a') summary.dr.na++;
            else summary.dr.none++;
            if (r.competition.status === 'exact') summary.cr.exact++;
            else if (r.competition.status === 'normalized') summary.cr.normalized++;
            else if (r.competition.status === 'n/a') summary.cr.na++;
            else summary.cr.none++;
        }

        res.json({
            competition: { id: comp.id, name: comp.name, series_id: seriesId },
            summary,
            events: results
        });
    } catch (err) {
        console.error('[event-record-matching]', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/admin/event-records/normalize-all
// Body: { admin_key, dry_run?: boolean, only_record_ids?: number[] }
// → event_record.event_name 을 normalizeEventName() 결과로 일괄 업데이트.
//   dry_run=true 이면 실제 update 는 안 하고 변경 예상만 반환.
//   only_record_ids 지정 시 그 id 들만 처리.
//   UNIQUE(record_type, event_name, gender, division_code, series_id) 충돌 시 해당 행은 skip.
app.post('/api/admin/event-records/normalize-all', async (req, res) => {
    try {
        const { admin_key, dry_run, only_record_ids } = req.body || {};
        if (!isAdminKey(admin_key) && !isOperationKey(admin_key)) {
            return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        }
        const isDry = !!dry_run;
        const idsFilter = Array.isArray(only_record_ids) && only_record_ids.length > 0
            ? only_record_ids.map(x => parseInt(x, 10)).filter(Number.isFinite)
            : null;

        // 후보 가져오기
        let rows;
        if (idsFilter && idsFilter.length > 0) {
            const ph = idsFilter.map(() => '?').join(',');
            rows = await db.all(`SELECT id, record_type, event_name, gender, division_code, series_id FROM event_record WHERE id IN (${ph})`, ...idsFilter);
        } else {
            rows = await db.all(`SELECT id, record_type, event_name, gender, division_code, series_id FROM event_record`);
        }

        const plan = [];
        const skipped = [];
        const updated = [];
        for (const r of rows) {
            const norm = normalizeEventNameServer(r.event_name || '');
            if (!norm || norm === r.event_name) continue;
            // UNIQUE 충돌 검사: 같은 (record_type, gender, division_code, series_id) 안에 이미 norm 이름이 있는지
            const conflict = await db.get(
                `SELECT id FROM event_record WHERE record_type=? AND event_name=? AND gender=?
                   AND COALESCE(division_code,'')=COALESCE(?,'')
                   AND COALESCE(series_id,-1)=COALESCE(?,-1)
                   AND id<>?`,
                r.record_type, norm, r.gender, r.division_code || null, r.series_id || null, r.id
            );
            if (conflict) {
                skipped.push({ id: r.id, before: r.event_name, after: norm, reason: 'UNIQUE conflict with id=' + conflict.id });
                continue;
            }
            plan.push({ id: r.id, before: r.event_name, after: norm, record_type: r.record_type, gender: r.gender });
            if (!isDry) {
                const _nowFER = db.isAsync ? 'NOW()' : "datetime('now')";
                await db.run(`UPDATE event_record SET event_name=?, updated_at=${_nowFER} WHERE id=?`, norm, r.id);
                updated.push(r.id);
            }
        }

        if (!isDry) {
            try { opLog(`[기록정규화] event_record 일괄 정규화: 총 ${plan.length}건 업데이트 / ${skipped.length}건 skip`, 'admin', 'admin', null); } catch(e) {}
        }

        res.json({
            dry_run: isDry,
            total_scanned: rows.length,
            planned_updates: plan.length,
            updated_count: updated.length,
            skipped_count: skipped.length,
            planned: plan,
            skipped
        });
    } catch (err) {
        console.error('[event-records/normalize-all]', err);
        res.status(500).json({ error: err.message });
    }
});

// ──────────────────────────────────────────────────────────────
// PUT /api/admin/event-records/:id/relink
// Body: { admin_key, target_event_name }
// → 시간표↔종목 매칭과 동일한 패턴의 인라인 1:1 매칭.
//   기존 event_record 의 event_name 을 target_event_name 으로 변경하여
//   특정 대회 종목(event.name)과 매칭되도록 함.
//   UNIQUE(record_type, event_name, gender, division_code, series_id) 충돌 시 거부.
// ──────────────────────────────────────────────────────────────
app.put('/api/admin/event-records/:id/relink', async (req, res) => {
    try {
        const { admin_key, target_event_name } = req.body || {};
        if (!isAdminKey(admin_key) && !isOperationKey(admin_key)) {
            return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        }
        const id = parseInt(req.params.id, 10);
        if (!id) return res.status(400).json({ error: 'id 필수' });
        const target = String(target_event_name || '').trim();
        if (!target) return res.status(400).json({ error: 'target_event_name 필수' });

        const r = await db.get(`SELECT id, record_type, event_name, gender, division_code, series_id FROM event_record WHERE id=?`, id);
        if (!r) return res.status(404).json({ error: '기록을 찾을 수 없습니다.' });
        if (r.event_name === target) {
            return res.json({ success: true, no_change: true });
        }
        // UNIQUE 충돌 검사 (같은 type/gender/divCode/seriesId 안에서)
        const conflict = await db.get(
            `SELECT id FROM event_record WHERE record_type=? AND event_name=? AND gender=?
               AND COALESCE(division_code,'')=COALESCE(?,'')
               AND COALESCE(series_id,-1)=COALESCE(?,-1)
               AND id<>?`,
            r.record_type, target, r.gender, r.division_code || null, r.series_id || null, r.id
        );
        if (conflict) {
            return res.status(409).json({ error: `이미 같은 슬롯에 '${target}' 기록이 존재합니다 (id=${conflict.id}).` });
        }
        const _nowER = db.isAsync ? 'NOW()' : "datetime('now')";
        await db.run(`UPDATE event_record SET event_name=?, updated_at=${_nowER} WHERE id=?`, target, id);
        try { opLog(`[기록재연결] event_record id=${id} '${r.event_name}' → '${target}'`, 'admin', 'admin', null); } catch(e) {}
        res.json({ success: true, before: r.event_name, after: target });
    } catch (err) {
        console.error('[event-records/relink]', err);
        res.status(500).json({ error: err.message });
    }
});

// ──────────────────────────────────────────────────────────────
// GET /api/admin/event-records/all-candidates
// Query: ?record_type=national|division|competition&gender=M|F|X&series_id=N(optional)
// → 같은 슬롯(type+gender+series) 에 등록된 모든 event_record 반환.
//   사용자가 정규화로도 매칭 안 되는 종목을 강제로 연결할 때 사용.
//   "있는데 못 불러오는" 케이스 (콤마/공백/표기 차이 등 정규화기가 못 잡는 경우).
// ──────────────────────────────────────────────────────────────
app.get('/api/admin/event-records/all-candidates', async (req, res) => {
    try {
        const recordType = String(req.query.record_type || '').trim();
        const gender = String(req.query.gender || '').trim();
        if (!['national', 'division', 'competition'].includes(recordType)) {
            return res.status(400).json({ error: 'record_type 은 national/division/competition' });
        }
        if (!gender) return res.status(400).json({ error: 'gender 필수' });
        const seriesId = req.query.series_id ? parseInt(req.query.series_id, 10) : null;

        let sql = `SELECT id, record_type, event_name, gender, division_code, series_id,
                          record_value, holder_name, holder_team, record_year
                   FROM event_record
                   WHERE record_type=? AND gender=? AND approved=1`;
        const args = [recordType, gender];
        if (recordType === 'competition' && seriesId) {
            sql += ` AND series_id=?`;
            args.push(seriesId);
        } else if (recordType === 'national') {
            sql += ` AND series_id IS NULL AND division_code IS NULL`;
        }
        sql += ` ORDER BY event_name`;
        const rows = await db.all(sql, ...args);
        res.json({ candidates: rows || [] });
    } catch (err) {
        console.error('[event-records/all-candidates]', err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// TIMETABLE (시간표) — Excel upload, parse, store, serve
// ============================================================
// SQLite-only 부트 마이그레이션 (PG 모드: schema.pg.sql 이 이미 모든 컬럼 포함)
if (!db.isAsync) {
    try { db.exec(`CREATE TABLE IF NOT EXISTS timetable (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        competition_id INTEGER NOT NULL,
        day INTEGER NOT NULL DEFAULT 1,
        section TEXT NOT NULL DEFAULT 'track',
        time TEXT NOT NULL,
        event_name TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT '',
        round TEXT NOT NULL DEFAULT '',
        note TEXT DEFAULT '',
        sort_order INTEGER DEFAULT 0,
        event_id INTEGER DEFAULT NULL,
        callroom_time TEXT DEFAULT NULL,
        scheduled_date TEXT DEFAULT NULL,
        UNIQUE(competition_id, day, section, time, event_name, category)
    )`); } catch(e) {}

    // Add new columns to existing timetable tables (migration)
    try { db.exec('ALTER TABLE timetable ADD COLUMN event_id INTEGER DEFAULT NULL'); } catch(e) {}
    try { db.exec('ALTER TABLE timetable ADD COLUMN callroom_time TEXT DEFAULT NULL'); } catch(e) {}
    try { db.exec('ALTER TABLE timetable ADD COLUMN scheduled_date TEXT DEFAULT NULL'); } catch(e) {}
    try { db.exec('ALTER TABLE timetable ADD COLUMN event_ids TEXT DEFAULT NULL'); } catch(e) {}
}

// Migration: UNIQUE 제약에 round 포함 (혼성/10종/5종 등 같은 시간·종목·부별이라도 round가 다르면 별개 행)
// 기존 UNIQUE(competition_id, day, section, time, event_name, category) → UNIQUE(... , round) 로 확장
// PG 모드에서는 schema.pg.sql이 이미 round 포함 UNIQUE 로 정의됨 — SQLite 전용 마이그레이션.
if (!db.isAsync) try {
    const idxRows = db.raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='timetable' AND name='ux_timetable_full'").all();
    if (idxRows.length === 0) {
        // 자동 인덱스(sqlite_autoindex_timetable_1)는 그대로 두면 round 미포함 충돌이 발생하므로 테이블 재구성
        const hasOldAutoIdx = db.raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='sqlite_autoindex_timetable_1'").get();
        if (hasOldAutoIdx) {
            console.log('[migration] timetable UNIQUE 재구성: round 컬럼 포함');
            db.exec('BEGIN');
            try {
                db.exec(`CREATE TABLE timetable_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    competition_id INTEGER NOT NULL,
                    day INTEGER NOT NULL DEFAULT 1,
                    section TEXT NOT NULL DEFAULT 'track',
                    time TEXT NOT NULL,
                    event_name TEXT NOT NULL,
                    category TEXT NOT NULL DEFAULT '',
                    round TEXT NOT NULL DEFAULT '',
                    note TEXT DEFAULT '',
                    sort_order INTEGER DEFAULT 0,
                    event_id INTEGER DEFAULT NULL,
                    callroom_time TEXT DEFAULT NULL,
                    scheduled_date TEXT DEFAULT NULL,
                    event_ids TEXT DEFAULT NULL,
                    UNIQUE(competition_id, day, section, time, event_name, category, round)
                )`);
                db.exec(`INSERT INTO timetable_new (id, competition_id, day, section, time, event_name, category, round, note, sort_order, event_id, callroom_time, scheduled_date, event_ids)
                         SELECT id, competition_id, day, section, time, event_name, category, round, note, sort_order, event_id, callroom_time, scheduled_date, event_ids FROM timetable`);
                db.exec('DROP TABLE timetable');
                db.exec('ALTER TABLE timetable_new RENAME TO timetable');
                db.exec('CREATE INDEX IF NOT EXISTS ux_timetable_full ON timetable(competition_id, day, section, time, event_name, category, round)');
                db.exec('COMMIT');
                console.log('[migration] timetable UNIQUE 재구성 완료');
            } catch (mErr) {
                db.exec('ROLLBACK');
                console.warn('[migration] timetable UNIQUE 재구성 실패(무시):', mErr.message);
            }
        } else {
            try { db.exec('CREATE INDEX IF NOT EXISTS ux_timetable_full ON timetable(competition_id, day, section, time, event_name, category, round)'); } catch(e) {}
        }
    }
} catch(e) { console.warn('[migration] timetable UNIQUE 점검 실패:', e.message); }

// GET timetable for a competition
// ============================================================
// TIMETABLE — 대회 일정 관리 (Excel 업로드, 자동 매칭, 일별 조회)
// ============================================================
// TIMETABLE 라우트들은 lib/routes/timetable.js 로 추출됨
const _timetableRoutes = require('./lib/routes/timetable')(app, { db, isAdminKey, isOperationKey, opLog, upload, XLSX, excelTimeToHHMM, cleanTimetableEventName });

// ============================================================
// PDF 문서 (스타트리스트·결과지·ID카드) — lib/routes/pdf_documents.js 로 추출 (2026-09)
// ============================================================
require('./lib/routes/pdf_documents')(app, { db, getDocTemplate, orderByBibSql, PORT });

// ============================================================
// 종목별 기록표(event_records) · 부 마스터(divisions) — lib/routes/event_records.js 로 추출 (2026-09)
// ============================================================
require('./lib/routes/event_records')(app, { db, isAdminKey, opLog, upload, guessEventCategory });

// ─── Competition Series CRUD ─── (lib/routes/competition_series.js 로 추출)
require('./lib/routes/competition_series')(app, { db, isAdminKey, opLog });

// ─── Records v4 (NR/DR/CR 통합) ─── (lib/routes/records.js 로 추출)
require('./lib/routes/records')(app, { db, isAdminKey, opLog });
// 기록표 엑셀 일괄 업로드 (NR/DR/CR) — /api/records/bulk-preview, /api/records/bulk-import
require('./lib/routes/records_bulk')(app, { db, isAdminKey, opLog, upload, XLSX, guessEventCategory });

// ============================================================
// RECORD BREAKS (신기록 승인 큐) — lib/routes/record_breaks.js 로 추출
// ============================================================
require("./lib/routes/record_breaks")(app, {
    db, isRecordOfficerOrAdmin, isAdminKey, opLog, broadcastSSE, getJudgeName
});

// ============================================================
// COMPREHENSIVE RESULT SHEET BY DIVISION — 부별 종합기록지 (Excel)
// ------------------------------------------------------------
// 부(division)별로 시트를 분리하여 모든 종목을 동적으로 출력.
// 기존 템플릿 기반 종합기록지와 달리 화이트리스트가 없으므로
// 80m, 3000m, 마라톤, 5종경기 등 모든 종목이 자동 포함된다.
// ============================================================
app.get('/api/documents/comprehensive-by-division/:compId/excel', async (req, res) => {
  try {
    const comp = await db.get('SELECT * FROM competition WHERE id=?', req.params.compId);
    if (!comp) return res.status(404).json({ error: 'Competition not found' });
    const { generateComprehensiveByDivision } = require('./lib/comprehensiveByDivision');
    const wb = await generateComprehensiveByDivision(db, comp);
    const buf = await wb.xlsx.writeBuffer();
    const baseName = `부별종합기록지_${(comp.name || 'result').replace(/[\\/:*?"<>|]/g, '_')}.xlsx`;
    const fileName = encodeURIComponent(baseName);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"; filename*=UTF-8''${fileName}`);
    res.end(Buffer.from(buf));
  } catch (err) {
    console.error('[CompByDiv Excel Error]', err);
    res.status(500).json({ error: '부별 종합기록지 생성 오류: ' + err.message });
  }
});

// ============================================================
// COMPREHENSIVE RESULT SHEET — 종합기록지 (Excel)
// ============================================================
app.get('/api/documents/comprehensive/:compId/excel', async (req, res) => {
  try {
    const comp = await db.get('SELECT * FROM competition WHERE id=?', req.params.compId);
    if (!comp) return res.status(404).json({ error: 'Competition not found' });
    const gender = req.query.gender || 'M'; // M or F
    const templateFile = gender === 'F' ? 'template_women.xlsx' : 'template_men.xlsx';
    const templatePath = path.join(__dirname, 'public', templateFile);

    // Check template file exists
    if (!fs.existsSync(templatePath)) {
      console.error(`[Comprehensive] Template not found: ${templatePath}`);
      return res.status(500).json({ error: `템플릿 파일이 없습니다: ${templateFile}. 서버에 public/${templateFile}을 배포해주세요.` });
    }

    // ---- Event name mapping: DB name -> template row name ----
    const MEN_EVENT_MAP = {
      '100m': '100m', '200m': '200m', '400m': '400m', '800m': '800m',
      '1500m': '1500m', '1,500m': '1500m', '5000m': '5000m', '5,000m': '5000m',
      '10000m': '10000m', '10,000m': '10000m',
      '110mH': '110mH', '110m허들': '110mH', '110m Hurdles': '110mH',
      '400mH': '400mH', '400m허들': '400mH', '400m Hurdles': '400mH',
      '3000mSC': '3000mSC', '3,000mSC': '3000mSC', '3000m장애물': '3000mSC',
      '10000mW': '10000mW', '10,000mW': '10000mW', '10000m경보': '10000mW',
      '높이뛰기': '높이뛰기', '장대높이뛰기': '장대높이뛰기',
      '멀리뛰기': '멀리뛰기', '세단뛰기': '세단뛰기',
      '포환던지기': '포환던지기', '원반던지기': '원반던지기',
      '해머던지기': '해머던지기', '창던지기': '창던지기',
      '10종경기': '10종경기', '십종경기': '10종경기',
      '4x100mR': '4x100mR', '4×100mR': '4x100mR', '4x100m릴레이': '4x100mR', '4X100mR': '4x100mR',
      '4x400mR': '4x400mR', '4×400mR': '4x400mR', '4x400m릴레이': '4x400mR', '4X400mR': '4x400mR',
      'MIXED 4x400mR': 'MIXED 4x400mR', 'MIXED 4×400mR': 'MIXED 4x400mR', '혼성4x400mR': 'MIXED 4x400mR',
      '4X400mR(Mixed)': 'MIXED 4x400mR', '4x400mR(Mixed)': 'MIXED 4x400mR', '4×400mR(Mixed)': 'MIXED 4x400mR',
      'MIXED4x400mR': 'MIXED 4x400mR', 'MIXED4X400mR': 'MIXED 4x400mR',
      '4x1500mR': '4x1500mR', '4×1500mR': '4x1500mR', '4x1500m릴레이': '4x1500mR', '4X1500mR': '4x1500mR',
      '4x800mR': '4x800mR', '4×800mR': '4x800mR', '4x800m릴레이': '4x800mR', '4X800mR': '4x800mR',
      // MIXED 4x800mR — 혼성 계주 (DB에서 '4600mR(Mixed)' 명칭으로 저장된 경우 포함)
      'MIXED 4x800mR': 'MIXED 4x800mR', 'MIXED 4×800mR': 'MIXED 4x800mR', '혼성4x800mR': 'MIXED 4x800mR',
      '4X800mR(Mixed)': 'MIXED 4x800mR', '4x800mR(Mixed)': 'MIXED 4x800mR', '4×800mR(Mixed)': 'MIXED 4x800mR',
      'MIXED4x800mR': 'MIXED 4x800mR', 'MIXED4X800mR': 'MIXED 4x800mR',
      '4600mR(Mixed)': 'MIXED 4x800mR', '4600mR (Mixed)': 'MIXED 4x800mR', '4600mR': 'MIXED 4x800mR',
      // 5000m 단체전 — 종목 칸만 생성 (자동 매칭 X, 사용자가 수기 입력)
      // (별도 매핑 없음: DB에 동일 종목명이 있더라도 칸만 노출됨)
    };
    const WOMEN_EVENT_MAP = { ...MEN_EVENT_MAP,
      '100mH': '100mH', '100m허들': '100mH', '100m Hurdles': '100mH',
      '7종경기': '7종경기', '칠종경기': '7종경기'
    };
    // Remove men-only events from women map
    if (gender === 'F') {
      delete WOMEN_EVENT_MAP['110mH'];
      delete WOMEN_EVENT_MAP['110m허들'];
      delete WOMEN_EVENT_MAP['110m Hurdles'];
      delete WOMEN_EVENT_MAP['10종경기'];
      delete WOMEN_EVENT_MAP['십종경기'];
    }
    const eventMap = gender === 'F' ? WOMEN_EVENT_MAP : MEN_EVENT_MAP;

    // ---- Identify wind-affected events ----
    const WIND_EVENTS = new Set(['100m','200m','110mH','100mH','멀리뛰기','세단뛰기']);
    // ---- Identify field height events ----
    const HEIGHT_EVENTS = new Set(['높이뛰기','장대높이뛰기']);
    // ---- Identify field distance/throw events ----
    const THROW_EVENTS = new Set(['포환던지기','원반던지기','해머던지기','창던지기']);
    const JUMP_EVENTS = new Set(['멀리뛰기','세단뛰기']);
    // ---- Relay events ----
    const RELAY_NAMES = new Set(['4x100mR','4x400mR','MIXED 4x400mR','4x800mR','MIXED 4x800mR','4x1500mR']);
    // ---- Combined events ----
    const COMBINED_NAMES = new Set(['10종경기','7종경기','5종경기']);

    // ---- Query ONLY final-round events ----
    // 종합기록지는 무조건 결승만 표시. 결승이 없는 종목은 제외.
    // (필드/투척/도약/복합 종목은 항상 round_type='final'로 생성됨)
    let allEvents;
    if (gender === 'M' || gender === 'F') {
      allEvents = await db.all(`
        SELECT e.* FROM event e WHERE e.competition_id=? AND e.gender IN (?, 'X')
        AND e.round_type='final'
        ORDER BY e.sort_order, e.id
      `, comp.id, gender);
    } else {
      allEvents = await db.all(`
        SELECT e.* FROM event e WHERE e.competition_id=?
        AND e.round_type='final'
        ORDER BY e.sort_order, e.id
      `, comp.id);
    }

    // ---- Format helpers ----
    function fmtTrackTime(seconds) {
      if (seconds == null) return '';
      if (seconds >= 3600) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds - h * 3600) / 60);
        const r = seconds - h * 3600 - m * 60;
        return `${h}:${m < 10 ? '0' : ''}${m}:${r < 10 ? '0' : ''}${r.toFixed(2)}`;
      }
      if (seconds >= 60) {
        const m = Math.floor(seconds / 60);
        const r = seconds - m * 60;
        return `${m}:${r < 10 ? '0' : ''}${r.toFixed(2)}`;
      }
      return seconds.toFixed(2);
    }
    function fmtFieldDist(meters) {
      // Template format: "18m09" for 18.09m, "7m96" for 7.96m
      if (meters == null) return '';
      const m = Math.floor(meters);
      const cm = Math.round((meters - m) * 100);
      return `${m}m${cm < 10 ? '0' : ''}${cm}`;
    }
    function fmtHeightCm(meters) {
      // Height: stored in meters (e.g. 2.15), display as "2m15" athletic notation
      if (meters == null) return '';
      const m = Math.floor(meters);
      const cm = Math.round((meters - m) * 100);
      return m + 'm' + String(cm).padStart(2, '0');
    }
    function fmtJumpCm(meters) {
      // Long/Triple jump: stored in meters (e.g. 7.96), display as cm integer (796)
      if (meters == null) return '';
      return String(Math.round(meters * 100));
    }
    function fmtWind(wind) {
      if (wind == null) return null;
      const w = parseFloat(wind);
      if (isNaN(w)) return null;
      return (w >= 0 ? '+' : '') + w.toFixed(1);
    }

    // ---- Build results for each event ----
    const resultEvents = [];

    for (const evt of allEvents) {
      const evtNameClean = evt.name.replace(/\s+/g, '').trim();
      let templateName = eventMap[evt.name] || eventMap[evtNameClean];
      // Try more fuzzy matching
      if (!templateName) {
        for (const [dbName, tplName] of Object.entries(eventMap)) {
          if (dbName.replace(/\s+/g, '') === evtNameClean || dbName.replace(/[,\s]/g, '') === evtNameClean.replace(/[,\s]/g, '')) {
            templateName = tplName;
            break;
          }
        }
      }
      if (!templateName) continue;

      const isRelay = evt.category === 'relay';
      const isCombined = evt.category === 'combined';
      const isFieldHeight = evt.category === 'field_height';
      const isFieldDist = evt.category === 'field_distance';
      const isTrack = evt.category === 'track' || evt.category === 'road';
      const hasWind = WIND_EVENTS.has(templateName);
      const isThrow = THROW_EVENTS.has(templateName);
      const isJump = JUMP_EVENTS.has(templateName);
      const isHeight = HEIGHT_EVENTS.has(templateName);

      const heats = await db.all('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number', evt.id);
      if (heats.length === 0) continue;

      let rankings = [];

      // ===== COMBINED EVENT =====
      if (isCombined) {
        const heat = heats[0];
        const entries = await db.all(`
          SELECT he.lane_number, ee.id AS event_entry_id, ee.status, ee.athlete_id,
                 a.name, a.bib_number, a.team
          FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id
          JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=?
        `, heat.id);

        const athleteData = await Promise.all(entries.map(async e => {
          const scores = await db.all('SELECT * FROM combined_score WHERE event_entry_id=? ORDER BY sub_event_order', e.event_entry_id);
          let totalPoints = scores.reduce((s, sc) => s + (sc.wa_points || 0), 0);
          const status = await db.get("SELECT status_code FROM result WHERE heat_id=? AND event_entry_id=? AND status_code IN ('DNF','DNS','DQ') LIMIT 1", heat.id, e.event_entry_id);
          let statusCode = status?.status_code || '';
          if (!statusCode && e.status === 'no_show') statusCode = 'DNS';
          return { ...e, totalPoints, status_code: statusCode };
        }));

        athleteData.sort((a, b) => {
          const aS = ['DNS','DNF','DQ'].includes(a.status_code);
          const bS = ['DNS','DNF','DQ'].includes(b.status_code);
          if (aS && !bS) return 1;
          if (!aS && bS) return -1;
          return b.totalPoints - a.totalPoints;
        });

        rankings = athleteData.slice(0, 8).map(a => ({
          name: a.name || '',
          team: a.team || '',
          record: ['DNS','DNF','DQ'].includes(a.status_code) ? a.status_code : String(a.totalPoints),
          wind: null,
          wa_score: null,
          _metric: ['DNS','DNF','DQ'].includes(a.status_code) ? null : a.totalPoints
        }));

      // ===== FIELD HEIGHT =====
      } else if (isFieldHeight) {
        const heat = heats[0];
        const entries = await db.all(`
          SELECT he.lane_number, ee.id AS event_entry_id, ee.status,
                 a.name, a.bib_number, a.team
          FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id
          JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=?
        `, heat.id);

        const allAttempts = await db.all('SELECT * FROM height_attempt WHERE heat_id=? ORDER BY bar_height, event_entry_id, attempt_number', heat.id);

        const athleteData = await Promise.all(entries.map(async e => {
          const myAttempts = allAttempts.filter(a => a.event_entry_id === e.event_entry_id);
          let bestCleared = null; let totalMisses = 0; let missesAtBest = 0;
          const heights = [...new Set(myAttempts.map(a => a.bar_height))].sort((a,b) => a-b);
          for (const h of heights) {
            const attH = myAttempts.filter(a => a.bar_height === h);
            const misses = attH.filter(a => a.result_mark === 'X').length;
            totalMisses += misses;
            if (attH.some(a => a.result_mark === 'O')) { bestCleared = h; missesAtBest = misses; }
          }
          // 카운트백은 공용 규칙(public/lib/ranking.js · WA TR 26.8): '마지막으로 넘은 높이까지'의 실패 수 — 예전엔 경기 전체 실패 수로 계산했다
          { const _hs = require('./public/lib/ranking').heightStatsFromAttempts(myAttempts); totalMisses = _hs.totalFails; missesAtBest = _hs.failsAtBest; }
          const results = await db.all('SELECT * FROM result WHERE heat_id=? AND event_entry_id=?', heat.id, e.event_entry_id);
          let status = results.find(r => r.status_code && ['DNS','DNF','DQ','NM'].includes(r.status_code))?.status_code || '';
          if (!status && e.status === 'no_show') status = 'DNS';
          if (bestCleared === null && !status) {
            // [FIX] 파울(0) / 패스(-1) 제외
            const bestR = results.find(r => r.distance_meters != null && r.distance_meters > 0);
            if (bestR) bestCleared = bestR.distance_meters;
          }
          if (!status && bestCleared === null && myAttempts.length > 0) status = 'NM';
          return { ...e, bestCleared, totalMisses, missesAtBest, status_code: status };
        }));

        athleteData.sort((a, b) => {
          const aS = ['DNS','DNF','DQ','NM'].includes(a.status_code);
          const bS = ['DNS','DNF','DQ','NM'].includes(b.status_code);
          if (aS && !bS) return 1; if (!aS && bS) return -1;
          if (a.bestCleared == null && b.bestCleared == null) return 0;
          if (a.bestCleared == null) return 1; if (b.bestCleared == null) return -1;
          if (b.bestCleared !== a.bestCleared) return b.bestCleared - a.bestCleared;
          if (a.missesAtBest !== b.missesAtBest) return a.missesAtBest - b.missesAtBest;
          return a.totalMisses - b.totalMisses;
        });

        rankings = athleteData.filter(a => !['DNS','DNF','DQ','NM'].includes(a.status_code) && a.bestCleared != null).slice(0, 8).map(a => ({
          name: a.name || '',
          team: a.team || '',
          record: fmtHeightCm(a.bestCleared),
          wind: null,
          wa_score: null,
          _metric: `${a.bestCleared}|${a.missesAtBest}|${a.totalMisses}` // 같은 높이+실패수 = 공동
        }));
        // Add NM/DNS/DNF/DQ at end (up to 8)
        const specials = athleteData.filter(a => ['DNS','DNF','DQ','NM'].includes(a.status_code) || a.bestCleared == null);
        for (const s of specials) {
          if (rankings.length >= 8) break;
          rankings.push({ name: s.name || '', team: s.team || '', record: s.status_code || 'NM', wind: null, wa_score: null, _metric: null });
        }

      // ===== FIELD DISTANCE (jumps + throws) =====
      } else if (isFieldDist) {
        // Combine all heats
        const allEntries = [];
        for (const heat of heats) {
          const entries = await db.all(`
            SELECT he.lane_number, ee.id AS event_entry_id, ee.status,
                   a.name, a.bib_number, a.team
            FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id
            JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=?
          `, heat.id);
          const results = await db.all('SELECT * FROM result WHERE heat_id=? ORDER BY event_entry_id, attempt_number', heat.id);
          const resMap = {};
          for (const r of results) { if (!resMap[r.event_entry_id]) resMap[r.event_entry_id] = []; resMap[r.event_entry_id].push(r); }

          for (const e of entries) {
            const recs = resMap[e.event_entry_id] || [];
            let best = null; let bestWind = null;
            for (const r of recs) {
              // [FIX] 파울(distance=0) / 패스(distance=-1) 제외, status_code X/FOUL 도 제외
              if (r.distance_meters != null && r.distance_meters > 0 && (r.status_code !== 'X' && r.status_code !== 'FOUL')) {
                if (best === null || r.distance_meters > best) { best = r.distance_meters; bestWind = r.wind; }
              }
            }
            let status = recs.find(r => r.status_code && ['DNS','DNF','NM','DQ'].includes(r.status_code))?.status_code || '';
            if (!status && e.status === 'no_show') status = 'DNS';
            // [FIX] NM 판정: 파울(distance===0) 또는 status X/FOUL 만 있으면 NM
            const allFoulRecs = recs.length > 0 && recs.every(r =>
              r.status_code === 'X' || r.status_code === 'FOUL' || r.distance_meters === 0
            );
            if (!status && best === null && allFoulRecs) status = 'NM';
            allEntries.push({ ...e, best, bestWind, status_code: status, sortedValid: recs.filter(r => r.distance_meters != null && r.distance_meters > 0 && r.status_code !== 'X' && r.status_code !== 'FOUL').map(r => r.distance_meters).sort((x, y) => y - x) });
          }
        }

        allEntries.sort((a, b) => {
          const aS = ['DNS','DNF','DQ','NM'].includes(a.status_code);
          const bS = ['DNS','DNF','DQ','NM'].includes(b.status_code);
          if (aS && !bS) return 1; if (!aS && bS) return -1;
          if (a.best == null && b.best == null) return 0;
          if (a.best == null) return 1; if (b.best == null) return -1;
          // 최고 기록이 같으면 2·3번째 기록으로 (WA TR 25.22 · public/lib/ranking.js) — 예전엔 최고 기록만 비교해 동률 순서가 임의였다
          return require('./public/lib/ranking').compareDistance(a, b);
        });

        // 투척+도약 모두 "15m09" 형식 사용 (fmtJumpCm은 cm정수 "1509"로 변환되어 오류)
        const fmtFn = (isThrow || isJump) ? fmtFieldDist : (m => m != null ? m.toFixed(2) : '');

        rankings = allEntries.slice(0, 8).map(a => ({
          name: a.name || '',
          team: a.team || '',
          record: ['DNS','DNF','DQ','NM'].includes(a.status_code) ? a.status_code : fmtFn(a.best),
          wind: (hasWind && a.bestWind != null) ? fmtWind(a.bestWind) : null,
          wa_score: null,
          _metric: ['DNS','DNF','DQ','NM'].includes(a.status_code) ? null : a.best
        }));

      // ===== TRACK / ROAD / RELAY =====
      } else {
        const allEntries = [];
        for (const heat of heats) {
          const entries = await db.all(`
            SELECT he.lane_number, ee.id AS event_entry_id, ee.status, ee.athlete_id,
                   a.name, a.bib_number, a.team
            FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id
            JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=?
          `, heat.id);
          const results = await db.all('SELECT * FROM result WHERE heat_id=? ORDER BY event_entry_id, attempt_number', heat.id);
          const resMap = {};
          for (const r of results) { if (!resMap[r.event_entry_id]) resMap[r.event_entry_id] = []; resMap[r.event_entry_id].push(r); }

          for (const e of entries) {
            const recs = resMap[e.event_entry_id] || [];
            const r = recs.find(r => r.time_seconds != null);
            const best = r ? r.time_seconds : null;
            const bestWind = r ? r.wind : (heat.wind != null ? heat.wind : null);
            let status = recs.find(r => r.status_code && ['DNS','DNF','NM','DQ'].includes(r.status_code))?.status_code || '';
            if (!status && e.status === 'no_show') status = 'DNS';
            allEntries.push({ ...e, best, bestWind, heat_wind: heat.wind, status_code: status });
          }
        }

        allEntries.sort((a, b) => {
          const aS = ['DNS','DNF','NM','DQ'].includes(a.status_code);
          const bS = ['DNS','DNF','NM','DQ'].includes(b.status_code);
          if (aS && !bS) return 1; if (!aS && bS) return -1;
          if (a.best == null && b.best == null) return 0;
          if (a.best == null) return 1; if (b.best == null) return -1;
          return a.best - b.best;
        });

        for (const a of allEntries.slice(0, 8)) {
          const isSpecial = ['DNS','DNF','NM','DQ'].includes(a.status_code);
          const entry = {
            name: a.name || '',
            team: a.team || '',
            record: isSpecial ? a.status_code : fmtTrackTime(a.best),
            wind: null,
            wa_score: null,
            _metric: isSpecial ? null : a.best
          };

          // Wind: per-result or per-heat
          if (hasWind) {
            if (a.bestWind != null) entry.wind = fmtWind(a.bestWind);
            else if (a.heat_wind != null) entry.wind = fmtWind(a.heat_wind);
          }

          // Relay: fetch members
          if (isRelay) {
            const memberRows = await db.all(`
              SELECT a.name FROM relay_member rm JOIN athlete a ON a.id=rm.athlete_id
              WHERE rm.event_entry_id=? ORDER BY rm.leg_order, ${orderByBibSql('a.bib_number')}
            `, a.event_entry_id);
            entry.members = memberRows.map(m => m.name);
            entry.is_relay = true;
          }

          rankings.push(entry);
        }
      }

      resultEvents.push({
        template_name: templateName,
        is_relay: isRelay,
        rankings
      });
    }

    // ---- Build JSON data for Python script ----
    const dateStr = comp.start_date && comp.end_date
      ? `${comp.start_date} ~ ${comp.end_date}`
      : comp.start_date || '';
    const tpl = await getDocTemplate(comp.id);
    const chiefJudgeName = tpl?.comprehensive?.chief_judge || tpl?.result_sheet?.chief_judge || tpl?.result_sheet?.chief_recorder_name || '';
    const chiefJudge = chiefJudgeName ? `심판장: ${chiefJudgeName} (인)` : '';

    const jsonData = {
      competition: {
        title: comp.name || '',
        date_range: dateStr,
        chief_judge: chiefJudge
      },
      events: resultEvents
    };

    // ---- Generate xlsx via adm-zip (direct XML modification) ----
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(templatePath);
    let sheetXml = zip.readAsText('xl/worksheets/sheet1.xml');

    // Event name -> template row mapping (built from template)
    const TEMPLATE_EVENTS_MEN = [
      {row:6,name:'100m'},{row:9,name:'200m'},{row:12,name:'400m'},{row:15,name:'800m'},
      {row:18,name:'1500m'},{row:21,name:'5000m'},{row:24,name:'10000m'},
      {row:27,name:'110mH'},{row:30,name:'400mH'},{row:33,name:'3000mSC'},{row:36,name:'10000mW'},
      {row:39,name:'높이뛰기'},{row:42,name:'장대높이뛰기'},
      {row:45,name:'멀리뛰기'},{row:48,name:'세단뛰기'},
      {row:51,name:'포환던지기'},{row:54,name:'원반던지기'},{row:57,name:'해머던지기'},{row:60,name:'창던지기'},
      {row:63,name:'10종경기'},
      {row:66,name:'4x100mR'},{row:69,name:'4x400mR'},{row:72,name:'MIXED 4x400mR'},{row:75,name:'4x1500mR'}
    ];
    const TEMPLATE_EVENTS_WOMEN = TEMPLATE_EVENTS_MEN.map(e => {
      if (e.name === '110mH') return { ...e, name: '100mH' };
      if (e.name === '10종경기') return { ...e, name: '7종경기' };
      return e;
    });
    const templateEvents = gender === 'F' ? TEMPLATE_EVENTS_WOMEN : TEMPLATE_EVENTS_MEN;
    const rowMap = {};
    for (const te of templateEvents) rowMap[te.name] = te.row;

    // Column mapping: 8 places → [name_col, rec_col]
    const PLACE_COLS = [
      ['C','E'],['F','H'],['I','K'],['L','N'],['O','Q'],['R','T'],['U','W'],['X','Z']
    ];
    const RELAY_EXTRA = ['D','G','J','M','P','S','V','Y'];

    function escXml(str) { return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

    // Collect all cell updates: { "C6": "value", ... }
    const cellUpdates = {};
    function queueCell(ref, val) {
      if (val !== null && val !== undefined && val !== '') cellUpdates[ref] = escXml(String(val));
    }

    // Fill header
    queueCell('B2', comp.name || '');
    queueCell('H3', dateStr);
    queueCell('X3', chiefJudge);

    // ── 신기록(NR/DR/CR) 기준기록 로드 (이 대회 시리즈 기준) ──
    const _compSeriesId = (comp && comp.series_id != null) ? comp.series_id : null;
    const _baseByTpl = {}; // template_name -> { national, division, competition }
    try {
      const _recRows = await db.all('SELECT * FROM event_record WHERE gender IN (?, ?)', gender, 'X');
      for (const rr of _recRows) {
        if (rr.record_type === 'national') { if (rr.series_id != null || rr.division_code != null) continue; }
        else if (rr.record_type === 'division') { if (rr.series_id != null) continue; }
        else if (rr.record_type === 'competition') { if (_compSeriesId == null || rr.series_id !== _compSeriesId) continue; }
        const tplName = eventMap[rr.event_name] || rr.event_name; // DB 종목명 → 템플릿 종목명
        if (!_baseByTpl[tplName]) _baseByTpl[tplName] = {};
        _baseByTpl[tplName][rr.record_type] = rr;
      }
    } catch (e) { console.warn('[comprehensive] 기준기록 로드 실패:', e.message); }
    const _parseRec = (s) => {
      if (s == null) return null;
      const t = String(s).trim();
      if (!t || ['DNS','DNF','DQ','DSQ','NM'].includes(t)) return null;
      const mm = t.match(/^(\d+)m(\d+)$/);                 // 12m45 / 3m60 → 12.45 / 3.60
      if (mm) return parseFloat(`${mm[1]}.${mm[2]}`);
      if (t.includes(':')) { const p = t.split(':').map(x => parseFloat(x)); if (p.some(isNaN)) return null; return p.reduce((a, v) => a * 60 + v, 0); }
      const v = parseFloat(t.replace(/[^\d.]/g, ''));
      return isNaN(v) ? null : v;
    };
    const _dirForTpl = (tplName) => {
      if (HEIGHT_EVENTS.has(tplName) || THROW_EVENTS.has(tplName) || JUMP_EVENTS.has(tplName)) return 'higher';
      if (COMBINED_NAMES.has(tplName)) return null; // 점수 기반 → 매트릭스 라벨 제외
      return 'lower'; // track/road/relay
    };
    const _recLabelFor = (tplName, recStr, windStr) => {
      const dir = _dirForTpl(tplName); if (!dir) return '';
      const base = _baseByTpl[tplName]; if (!base) return '';
      const num = _parseRec(recStr); if (num == null) return '';
      if (WIND_EVENTS.has(tplName) && windStr) { const w = parseFloat(String(windStr).replace('+', '')); if (!isNaN(w) && w > 2.0) return ''; } // 참고기록
      const out = [];
      for (const [k, lbl] of [['national', 'NR'], ['division', 'DR'], ['competition', 'CR']]) {
        const rec = base[k]; if (!rec) continue;
        const ov = _parseRec(rec.record_value); if (ov == null) continue;
        if (dir === 'lower' && num < ov) out.push(lbl);
        else if (dir === 'higher' && num > ov) out.push(lbl);
      }
      return out.join(' ');
    };

    // Fill events
    for (const evt of resultEvents) {
      const row = rowMap[evt.template_name];
      if (!row) continue;
      const rks = evt.rankings.slice(0, 8);
      // 순위 + 공동순위 계산 (유효기록만 순위 부여, 표준: 1,2,2,4)
      for (let i = 0; i < rks.length; i++) {
        const r = rks[i];
        if (r._metric == null) { r._rank = null; continue; }
        if (i > 0 && rks[i - 1]._metric != null && rks[i - 1]._metric === r._metric) {
          r._rank = rks[i - 1]._rank;
          r._tied = true; rks[i - 1]._tied = true;
        } else {
          r._rank = i + 1;
        }
      }
      for (let i = 0; i < rks.length; i++) {
        const r = rks[i];
        const [nameCol, recCol] = PLACE_COLS[i];
        if (evt.is_relay && r.members && r.members.length >= 2) {
          queueCell(`${nameCol}${row}`, r.members.slice(0, 2).join(' '));
          if (r.members.length >= 3) queueCell(`${RELAY_EXTRA[i]}${row}`, r.members.slice(2, 4).join(' '));
        } else {
          queueCell(`${nameCol}${row}`, r.name);
        }
        // 기록 옆 괄호: 공동순위 + 신기록(NR/DR/CR) — 예: "12m45 (2위, CR)"
        const parts = [];
        if (r._tied && r._rank != null) parts.push(`${r._rank}위`);
        if (!r.wa_score) {
          const _lbl = _recLabelFor(evt.template_name, r.record, r.wind);
          if (_lbl) parts.push(_lbl);
        }
        const recDisplay = (r.record != null ? String(r.record) : '') + (parts.length ? ` (${parts.join(', ')})` : '');
        queueCell(`${recCol}${row}`, recDisplay);
        queueCell(`${nameCol}${row + 1}`, r.team);
        if (r.wind) queueCell(`${recCol}${row + 1}`, r.wind);
        if (r.wa_score) queueCell(`${recCol}${row + 2}`, r.wa_score);
      }
    }

    // Single-pass XML replacement: find all <c r="XX" ...> and replace if in cellUpdates
    sheetXml = sheetXml.replace(/<c r="([A-Z]+\d+)"( s="\d+")(?:\s+t="[^"]*")?>(?:<[^<]*<\/c>|<\/c>)/gs, (match, ref, style) => {
      if (cellUpdates[ref] !== undefined) {
        return `<c r="${ref}"${style} t="inlineStr"><is><t>${cellUpdates[ref]}</t></is></c>`;
      }
      return match;
    });

    // Write modified XML back to zip
    zip.updateFile('xl/worksheets/sheet1.xml', Buffer.from(sheetXml, 'utf-8'));

    const outputBuffer = zip.toBuffer();
    const genderLabel = gender === 'M' ? '남자' : gender === 'F' ? '여자' : '혼성';
    const fileName = encodeURIComponent(`종합기록지_${genderLabel}_${comp.name || 'result'}.xlsx`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"; filename*=UTF-8''${fileName}`);
    res.end(outputBuffer);

  } catch (err) {
    console.error('[Comprehensive Excel Error]', err);
    if (!res.headersSent) {
      res.status(500).json({ error: '종합기록지 생성 오류: ' + err.message });
    }
  }
});

// ============================================================
// FULL RECORD SHEET — 연맹 종합기록지 (Excel, ExcelJS with formatting)
// 종합기록 + 개별 종목 시트 (트랙/필드/릴레이/혼성)
// ============================================================
app.get('/api/documents/full-record/:compId/excel', async (req, res) => {
  try {
    const comp = await db.get('SELECT * FROM competition WHERE id=?', req.params.compId);
    if (!comp) return res.status(404).json({ error: 'Competition not found' });
    const gender = req.query.gender || 'M';
    const genderLabel = gender === 'M' ? '남자' : '여자';

    const wb = await generateFullRecordExcel(db, comp, gender, getDocTemplate);
    const buf = await wb.xlsx.writeBuffer();
    const fileName = encodeURIComponent(`연맹종합기록지_${genderLabel}_${comp.name || 'result'}.xlsx`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"; filename*=UTF-8''${fileName}`);
    res.end(Buffer.from(buf));
  } catch (err) {
    console.error('[Full Record Excel Error]', err);
    if (!res.headersSent) {
      res.status(500).json({ error: '연맹기록지 생성 오류: ' + err.message });
    }
  }
});

// ============================================================
// FULL RECORD SHEET — 연맹 종합기록지 (PDF, PDFKit)
// 요약시트 landscape + 세부시트 portrait → A4 인쇄 최적화
// ============================================================
app.get('/api/documents/full-record/:compId/pdf', async (req, res) => {
  try {
    const comp = await db.get('SELECT * FROM competition WHERE id=?', req.params.compId);
    if (!comp) return res.status(404).json({ error: 'Competition not found' });
    const gender = req.query.gender || 'M';
    const genderLabel = gender === 'M' ? '남자' : '여자';

    const pdfBuffer = await generateFullRecordPdf(db, comp, gender);
    const fileName = encodeURIComponent(`연맹종합기록지_${genderLabel}_${comp.name || 'result'}.pdf`);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"; filename*=UTF-8''${fileName}`);
    res.end(pdfBuffer);
  } catch (err) {
    console.error('[Full Record PDF Error]', err);
    if (!res.headersSent) {
      res.status(500).json({ error: '연맹기록지 PDF 생성 오류: ' + err.message });
    }
  }
});

// ========== Certificate System API (lib/routes/certificate.js) ==========
//   추출 2026-05-31 (A-11): 11 routes + getEventResultsForCert 헬퍼
//     GET    /api/admin/certificate-templates
//     GET    /api/admin/certificate-templates/:id
//     POST   /api/admin/certificate-templates
//     PUT    /api/admin/certificate-templates/:id
//     DELETE /api/admin/certificate-templates/:id
//     POST   /api/admin/certificates/preview
//     POST   /api/admin/certificates/generate
//     POST   /api/admin/certificates/single
//     POST   /api/admin/certificate-images/upload
//     POST   /api/admin/certificate-images/delete
//     GET    /api/admin/certificates/log
//   헬퍼 getEventResultsForCert 는 모듈에서 반환받아 SMS 라우트 마운트 시 주입.
// 대회 운영 체크리스트 (대회 전·당일·후 점검)
require('./lib/routes/readiness')(app, {
    db, isAdminKey, kstNow, lastBackupAgeMs: _lastBackupAgeMs, backupS3,
    listFinalSnapshots: compId => { try { return fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith(`backup_final${compId}_`) && f.endsWith('.db')).sort(); } catch (e) { return []; } },
});
const _certMod = require('./lib/routes/certificate')(app, {
    db, isAdminKey, isOperationKey,
    generateCertificatePdf, generateCertificateBatch,
    upload,
    publicDir: path.join(__dirname, 'public'),
});
const getEventResultsForCert = _certMod.getEventResultsForCert;
// ========== END Certificate System ==========

// ============================================================
// 한국중·고육상연맹(KJAF) 종합기록지 — Excel (Phase 7-①, 2026-09)
//   시트 묶음(남중/여중, 학년부, 믹스릴레이, 신기록현황)은 종목의 부(division)·학년으로 자동 결정 → lib/kjafRecordSheet.js
// ============================================================
app.get('/api/documents/kjaf-record/:compId/excel', async (req, res) => {
    try {
        const comp = await db.get('SELECT * FROM competition WHERE id=?', req.params.compId);
        if (!comp) return res.status(404).json({ error: 'Competition not found' });
        const { generateKjafRecordSheet } = require('./lib/kjafRecordSheet');
        const wb = await generateKjafRecordSheet(db, comp, { getEventResultsForCert });
        const buf = await wb.xlsx.writeBuffer();
        const fileName = encodeURIComponent(`중고연맹_종합기록지_${comp.name || 'result'}.xlsx`);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"; filename*=UTF-8''${fileName}`);
        res.end(Buffer.from(buf));
    } catch (err) {
        console.error('[KJAF Record Excel Error]', err);
        if (!res.headersSent) res.status(500).json({ error: '중고연맹 종합기록지 생성 오류: ' + err.message });
    }
});

// ========== SMS System API (lib/routes/sms.js) ==========
//   추출 2026-05-31 (A-11): 6 routes
//     GET/POST /api/admin/sms/config
//     POST /api/admin/sms/preview
//     POST /api/admin/sms/send
//     POST /api/admin/sms/batch-send
//     GET /api/admin/sms/log
//   _resetSmsCounterIfNeeded 헬퍼는 모듈 내부로 이동.
//   getEventResultsForCert 는 server.js 의 함수를 그대로 주입 (certificate 추출 시 함께 이동).
require('./lib/routes/sms')(app, { db, isAdminKey, SMS, getEventResultsForCert });

// ========== 행사(event) 간편 기록입력 ==========
require('./lib/routes/eventRecord')(app, { db, isAdminKey, isOperationKey, SMS });

// ========== Push(FCM 웹푸시) System ==========
const Push = require('./lib/pushSender');
const _pushMod = require('./lib/routes/push')(app, { db, isAdminKey, Push });
const notifyEventInterest = (_pushMod && _pushMod.notifyEventInterest) || (async () => {});
// FCM 백그라운드 서비스워커 — 설정값을 주입해 동적 서빙(루트 스코프)
app.get('/firebase-messaging-sw.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Service-Worker-Allowed', '/');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'); // 항상 최신 SW
    const { configured, config } = Push.webConfig();
    if (!configured) { res.send('// firebase 미설정 — 푸시 비활성\nself.addEventListener("install",()=>self.skipWaiting());\n'); return; }
    res.send(`self.addEventListener('install', function(){ self.skipWaiting(); });
self.addEventListener('activate', function(e){ e.waitUntil(self.clients.claim()); });
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');
firebase.initializeApp(${JSON.stringify(config)});
// firebase-messaging 로드(토큰/구독용). 표시는 아래 raw push 리스너 하나로만 처리.
try { firebase.messaging(); } catch(e) {}
// 모든 푸시를 직접 표시 — 페이로드 구조가 무엇이든 title/body 를 최대한 찾아 항상 표시
self.addEventListener('push', function(event){
  let p = {};
  try { p = event.data ? event.data.json() : {}; } catch(e) { try { p = { body: event.data && event.data.text() }; } catch(_) {} }
  var d = p.data || p.notification || p || {};
  var title = d.title || (p.notification && p.notification.title) || '알림';
  var body = d.body || (p.notification && p.notification.body) || '';
  event.waitUntil(self.registration.showNotification(title, {
    body: body, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: d
  }));
});
// 알림 클릭 시 사이트 열기/포커스
self.addEventListener('notificationclick', function(event){
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type:'window', includeUncontrolled:true }).then(function(cl){
    for (const c of cl) { if ('focus' in c) return c.focus(); }
    if (self.clients.openWindow) return self.clients.openWindow('/');
  }));
});`);
});
// ========== END Push System ==========

// Document listing — available documents for a competition
app.get('/api/documents/:compId', async (req, res) => {
    const comp = await db.get('SELECT * FROM competition WHERE id=?', req.params.compId);
    if (!comp) return res.status(404).json({ error: 'Competition not found' });
    // 부모 종목 + 혼성 세부종목 모두 포함. 정렬은 부모 → 세부 순으로 유지.
    const parentEvents = await db.all("SELECT * FROM event WHERE competition_id=? AND parent_event_id IS NULL ORDER BY sort_order, id", comp.id);
    const subEvents = await db.all("SELECT * FROM event WHERE competition_id=? AND parent_event_id IS NOT NULL ORDER BY parent_event_id, sort_order, id", comp.id);
    const subsByParent = {};
    for (const s of subEvents) {
        if (!subsByParent[s.parent_event_id]) subsByParent[s.parent_event_id] = [];
        subsByParent[s.parent_event_id].push(s);
    }
    const docs = [];
    docs.push({ type: 'comprehensive-excel', label: '종합기록지 (남자)', url: `/api/documents/comprehensive/${comp.id}/excel?gender=M` });
    docs.push({ type: 'comprehensive-excel', label: '종합기록지 (여자)', url: `/api/documents/comprehensive/${comp.id}/excel?gender=F` });
    // 부별 종합기록지 — 부(division) 단위 시트 분리, 전체 종목 동적 출력 (80m/3000m/마라톤/5종경기 등 포함)
    docs.push({ type: 'comprehensive-by-division-excel', label: '부별 종합기록지 (전체 부)', url: `/api/documents/comprehensive-by-division/${comp.id}/excel` });
    // 연맹 종합기록지(Excel/PDF) 4종은 사용자 요청으로 문서 목록에서 제외 (2026-05).
    //   - 백엔드 라우트(/api/documents/full-record/...)는 그대로 유지하여 직접 URL 접근은 가능.
    const roundLabelMap = { preliminary: '예선', semifinal: '준결승', final: '결승' };
    const pushDocsForEvent = (evt, opts = {}) => {
        const gK = evt.gender === 'M' ? '남' : evt.gender === 'F' ? '여' : '혼';
        const roundK = roundLabelMap[evt.round_type] || evt.round_type || '';
        const roundSuffix = roundK ? ` (${roundK})` : '';
        // 혼성 부모는 "종합" 표시. 혼성 세부종목은 부모 prefix가 이름에 이미 포함됨 ([10종] 100m 등).
        const isCombinedParent = evt.category === 'combined' && !evt.parent_event_id;
        const labelExtra = isCombinedParent ? ' — 종합' : '';
        docs.push({
            type: 'start-list',
            label: `Start List: ${gK} ${evt.name}${labelExtra}${roundSuffix}`,
            url: `/api/documents/start-list/${evt.id}`,
            event_id: evt.id, gender: evt.gender,
            event_name: evt.name, round: evt.round_type, category: evt.category,
            parent_event_id: evt.parent_event_id || null
        });
        docs.push({
            type: 'result-sheet',
            label: `Results: ${gK} ${evt.name}${labelExtra}${roundSuffix}`,
            url: `/api/documents/result-sheet/${evt.id}`,
            event_id: evt.id, gender: evt.gender,
            event_name: evt.name, round: evt.round_type, category: evt.category,
            parent_event_id: evt.parent_event_id || null
        });
    };
    for (const evt of parentEvents) {
        pushDocsForEvent(evt);
        // 혼성 종목이면 바로 아래에 세부종목 문서들 추가
        const subs = subsByParent[evt.id] || [];
        for (const sub of subs) pushDocsForEvent(sub);
    }
    res.json(docs);
});

// ============================================================
// EXTERNAL API (외부 시스템 연동 — 결과 URL 자동 등록 등)
// ============================================================
//
// 보안 정책:
//   1) 모든 호출은 X-API-Key 헤더 필수 (또는 Authorization: Bearer <key>)
//   2) 키는 발급 시점에만 평문 노출, DB에는 bcrypt 해시만 저장
//   3) 키마다 적용 대회 제한 가능 (allowed_competition_id)
//   4) 분당 호출 제한 (기본 60회)
//   5) 노출용 대회(comp.mode='display')의 종목만 수정 가능
//   6) 모든 호출은 external_api_log에 자동 기록
//   7) 기존 result_url이 있으면 force=true 없이는 덮어쓰기 거부
//   8) dry_run=true: 검증만 하고 저장 안 함

// 평문 키 생성: 32바이트 랜덤 → "pkr_" prefix + base62 인코딩
function _generateApiKey() {
    const buf = crypto.randomBytes(24);
    const b64 = buf.toString('base64').replace(/[+/=]/g, '').slice(0, 32);
    return 'pkr_' + b64;
}
function _hashApiKey(plain) {
    return bcrypt.hashSync(plain, 10);
}
function _keyPrefix(plain) {
    // "pkr_a1b2c3d4..." → 앞 12자만 노출 식별용
    return (plain || '').slice(0, 12);
}

// 외부 API 호출 로그 기록 (fire-and-forget: SQLite sync raw / PG async)
const EXT_LOG_INSERT_SQL = `INSERT INTO external_api_log
    (api_key_id, key_prefix, endpoint, method, request_ip, user_agent,
     competition_id, event_id, request_body, response_status, response_code, duration_ms)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`;
function _logExternalCall(opts) {
    const args = [
        opts.api_key_id || null,
        opts.key_prefix || '',
        opts.endpoint || '',
        opts.method || 'POST',
        opts.request_ip || '',
        (opts.user_agent || '').slice(0, 500),
        opts.competition_id || null,
        opts.event_id || null,
        (opts.request_body || '').slice(0, 4000),
        opts.response_status || 0,
        opts.response_code || '',
        opts.duration_ms || 0,
    ];
    if (!db.isAsync) {
        try { db.raw.prepare(EXT_LOG_INSERT_SQL).run(...args); }
        catch(e) { console.warn('external_api_log sync insert failed:', e.message); }
    } else {
        db.run(EXT_LOG_INSERT_SQL, ...args)
            .catch(e => console.warn('external_api_log async insert failed:', e.message));
    }
}

// 메모리 기반 레이트 리미터 (분 단위 슬라이딩 윈도우, 키 ID 기준)
const _extRateMap = new Map(); // key: api_key_id, value: { windowStart: ms, count: n }
function _extExpired(expiresAt) {
    const str = String(expiresAt).trim();
    let t;
    if (/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/.test(str)) t = Date.parse(str.replace(' ', 'T') + (str.length === 10 ? 'T23:59:59' : '') + '+09:00');
    else t = Date.parse(str);
    return Number.isFinite(t) ? t < Date.now() : false;
}
function _checkRateLimit(apiKeyId, limitPerMin) {
    const now = Date.now();
    const winSize = 60 * 1000;
    const entry = _extRateMap.get(apiKeyId);
    if (!entry || (now - entry.windowStart) >= winSize) {
        _extRateMap.set(apiKeyId, { windowStart: now, count: 1 });
        return { allowed: true, remaining: limitPerMin - 1, resetIn: winSize };
    }
    if (entry.count >= limitPerMin) {
        return { allowed: false, remaining: 0, resetIn: winSize - (now - entry.windowStart) };
    }
    entry.count++;
    return { allowed: true, remaining: limitPerMin - entry.count, resetIn: winSize - (now - entry.windowStart) };
}

// API 키 검증 미들웨어
//   - 헤더 X-API-Key 또는 Authorization: Bearer <key>
//   - 키 검증 후 req.extApiKey에 키 레코드 부착
//   - 레이트 리밋 통과 못하면 429
//   - 응답 후 자동으로 external_api_log 기록
function externalApiAuth(req, res, next) {
    const startedAt = Date.now();
    const reqId = crypto.randomBytes(6).toString('hex');
    req._extReqId = reqId;
    req._extStartedAt = startedAt;

    // 응답 가로채기 (자동 로깅)
    const _origJson = res.json.bind(res);
    res.json = function(body) {
        const dur = Date.now() - startedAt;
        const code = (body && body.error_code) || (body && body.success ? 'OK' : '');
        try {
            _logExternalCall({
                api_key_id: req.extApiKey ? req.extApiKey.id : null,
                key_prefix: req.extApiKey ? req.extApiKey.key_prefix : (req._extKeyPrefix || ''),
                endpoint: req.originalUrl.split('?')[0],
                method: req.method,
                request_ip: (req.ip || '').toString(),
                user_agent: req.headers['user-agent'] || '',
                competition_id: (req.body && req.body.competition_id) || (req.query && req.query.competition_id) || null,
                event_id: (req.body && req.body.event_id) || (req.params && req.params.id) || null,
                request_body: req.method === 'GET' ? JSON.stringify(req.query || {}) : JSON.stringify(req.body || {}),
                response_status: res.statusCode,
                response_code: code,
                duration_ms: dur,
            });
        } catch(_){}
        return _origJson(body);
    };

    // 키 추출
    const headerKey = req.headers['x-api-key'] || '';
    const authHeader = req.headers['authorization'] || '';
    const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
    const plainKey = (headerKey || (bearerMatch ? bearerMatch[1] : '') || '').trim();
    if (!plainKey) {
        return res.status(401).json({ success: false, error_code: 'MISSING_API_KEY', message: 'X-API-Key 헤더가 필요합니다.' });
    }
    req._extKeyPrefix = _keyPrefix(plainKey);

    // prefix로 후보 조회 (보통 1개) → bcrypt 비교
    //   SQLite: sync raw / PG: async — 미들웨어는 async 흐름으로 통일
    (async () => {
        try {
            const prefix = _keyPrefix(plainKey);
            // 비교(bcrypt) 전에 IP+접두로 먼저 제한한다 — 예전엔 비교가 먼저라 접두(관리 화면에 보임)만 알면 서버를 붙잡아 둘 수 있었다
            const pre = _checkRateLimit('pre:' + prefix + ':' + (req.ip || ''), 120);
            if (!pre.allowed) return res.status(429).json({ success: false, error_code: 'RATE_LIMITED', message: '호출이 너무 잦습니다.', reset_in_ms: pre.resetIn });
            const candidates = await db.all('SELECT * FROM external_api_key WHERE key_prefix=?', prefix);
            let matched = null;
            for (const c of candidates) {
                if (await bcrypt.compare(plainKey, c.key_hash)) { matched = c; break; }     // 비동기 — 기록 입력 요청을 막지 않게
            }
            if (!matched) {
                return res.status(403).json({ success: false, error_code: 'INVALID_API_KEY', message: '유효하지 않은 API 키입니다.' });
            }
            if (matched.revoked_at) {
                return res.status(403).json({ success: false, error_code: 'KEY_REVOKED', message: '회수된 API 키입니다.' });
            }
            // 만료: 'YYYY-MM-DD HH:MM:SS'(KST 의도) 를 시각으로 바꿔 비교 (예전엔 문자열 비교라 그날 09:00 KST 에 만료됐다)
            if (matched.expires_at && _extExpired(matched.expires_at)) {
                return res.status(403).json({ success: false, error_code: 'KEY_EXPIRED', message: '만료된 API 키입니다.' });
            }

            // 레이트 리밋
            const rl = _checkRateLimit(matched.id, matched.rate_limit_per_min || 60);
            res.setHeader('X-RateLimit-Limit', String(matched.rate_limit_per_min || 60));
            res.setHeader('X-RateLimit-Remaining', String(rl.remaining));
            if (!rl.allowed) {
                return res.status(429).json({
                    success: false, error_code: 'RATE_LIMITED',
                    message: `분당 ${matched.rate_limit_per_min || 60}회 호출 한도를 초과했습니다.`,
                    reset_in_ms: rl.resetIn,
                });
            }

            // 통계 업데이트 (fire-and-forget — 미들웨어 응답 막지 않음)
            const USAGE_SQL = !db.isAsync
                ? 'UPDATE external_api_key SET last_used_at=datetime(\'now\'), total_calls=total_calls+1 WHERE id=?'
                : "UPDATE external_api_key SET last_used_at=NOW(), total_calls=total_calls+1 WHERE id=?";
            db.run(USAGE_SQL, matched.id).catch(()=>{});

            req.extApiKey = matched;
            next();
        } catch (e) {
            console.error('[externalApiAuth] error:', e.message);
            return res.status(500).json({ success: false, error_code: 'AUTH_INTERNAL', message: 'API 인증 처리 중 오류가 발생했습니다.' });
        }
    })();
}

// 헬퍼: 키의 적용 대회 제한 검증
//   - allowed_competition_id가 NULL이면 모든 노출용 대회 허용
//   - 값이 있으면 요청의 competition_id와 일치해야 함
function _checkCompetitionScope(extApiKey, requestedCompId) {
    if (!extApiKey.allowed_competition_id) return { ok: true };
    if (!requestedCompId) return { ok: false, code: 'COMPETITION_REQUIRED', message: '이 키는 특정 대회 전용입니다. competition_id를 명시해주세요.' };
    if (parseInt(requestedCompId) !== extApiKey.allowed_competition_id) {
        return { ok: false, code: 'COMPETITION_FORBIDDEN', message: `이 키는 competition_id=${extApiKey.allowed_competition_id}에만 사용 가능합니다.` };
    }
    return { ok: true };
}

// 헬퍼: 노출용 대회인지 확인
async function _ensureDisplayCompetition(compId) {
    const comp = await db.get('SELECT id, name, mode, start_date, end_date FROM competition WHERE id=?', parseInt(compId));
    if (!comp) return { ok: false, code: 'COMPETITION_NOT_FOUND', message: '대회를 찾을 수 없습니다.' };
    if (comp.mode !== 'display') return { ok: false, code: 'NOT_DISPLAY_MODE', message: '이 API는 노출용(display) 대회에만 사용 가능합니다.' };
    return { ok: true, comp };
}

// 헬퍼: URL 형식 검증
function _isValidUrl(url) {
    if (typeof url !== 'string') return false;
    if (url.length < 10 || url.length > 2000) return false;
    if (!/^https?:\/\/[^\s]+$/i.test(url)) return false;
    return true;
}

// ─── 외부 API 라우트들 ───────────────────────────────────────

// ── Phase 3: 종목 검색 ──
// GET /api/external/events/search
//   query params:
//     competition_id (optional if key has allowed_competition_id)
//     name           (partial match)
//     division       (partial match - "선수권" matches "선수권(남)" 등)
//     gender         (M | F | X)
//     round_type     (preliminary | semifinal | final)
//     limit          (default 50, max 200)
app.get('/api/external/events/search', externalApiAuth, async (req, res) => {
    const extKey = req.extApiKey;
    let compId = req.query.competition_id ? parseInt(req.query.competition_id) : null;

    // 키에 대회 제한이 걸려 있으면 그 대회로 강제
    if (extKey.allowed_competition_id) {
        if (compId && compId !== extKey.allowed_competition_id) {
            return res.status(403).json({ ok: false, code: 'COMPETITION_FORBIDDEN', message: '이 API 키는 다른 대회를 조회할 수 없습니다.' });
        }
        compId = extKey.allowed_competition_id;
    }
    if (!compId) {
        return res.status(400).json({ ok: false, code: 'MISSING_COMPETITION_ID', message: 'competition_id 파라미터가 필요합니다.' });
    }

    // 노출용 대회 강제
    const compCheck = await _ensureDisplayCompetition(compId);
    if (!compCheck.ok) return res.status(404).json({ ok: false, code: compCheck.code, message: compCheck.message });

    const name = (req.query.name || '').trim();
    const division = (req.query.division || '').trim();
    const gender = (req.query.gender || '').trim().toUpperCase();
    const roundType = (req.query.round_type || '').trim().toLowerCase();
    let limit = parseInt(req.query.limit || '50', 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 50;
    if (limit > 200) limit = 200;

    const where = ['e.competition_id = ?', '(e.parent_event_id IS NULL)'];
    const params = [compId];

    if (name) {
        where.push('e.name LIKE ?');
        params.push('%' + name + '%');
    }
    if (division) {
        where.push('e.division LIKE ?');
        params.push('%' + division + '%');
    }
    if (gender && ['M', 'F', 'X'].includes(gender)) {
        where.push('e.gender = ?');
        params.push(gender);
    }
    if (roundType && ['preliminary', 'semifinal', 'final'].includes(roundType)) {
        where.push('e.round_type = ?');
        params.push(roundType);
    }

    const sql = `
        SELECT e.id, e.competition_id, e.name, e.category, e.gender, e.division,
               e.round_type, e.round_status, e.sort_order,
               COALESCE(e.result_url, '') AS result_url,
               COALESCE(e.video_url, '')  AS video_url
        FROM event e
        WHERE ${where.join(' AND ')}
        ORDER BY e.division, e.sort_order, e.name, e.round_type
        LIMIT ?
    `;
    params.push(limit);

    try {
        const rows = await db.all(sql, ...params);

        // ─── 합동 종목 가상 row 추가 ──────────────────────────────
        // joint_group (3way 등) 을 별도 종목처럼 노출해서 외부 전광판 프로그램이
        // "3way 10,000mW" 같은 합동 키를 종목 목록에서 볼 수 있게 함.
        // 가상 ID 는 충돌 방지를 위해 음수 사용: -(joint_group.id) 로 매핑.
        // 단건 조회 시 /api/external/event/:id 가 음수 ID 를 받으면 joint_group 로 해석함.
        let virtualJointItems = [];
        try {
            // 이 대회에 속한 종목을 멤버로 가진 joint_group 들
            const jointGroups = await db.all(`
                SELECT DISTINCT jg.id, jg.name, jg.joint_scoreboard_key
                FROM joint_group jg
                JOIN joint_group_member jgm ON jgm.joint_group_id = jg.id
                WHERE jgm.competition_id = ?
            `, compId);

            for (const jg of jointGroups) {
                // 대표 멤버 1개 가져와서 gender/round_type/division 등 메타 추정
                const repMember = await db.get(`
                    SELECT e.gender, e.round_type, e.division, e.category, e.sort_order, e.name as orig_name
                    FROM joint_group_member jgm JOIN event e ON e.id = jgm.event_id
                    WHERE jgm.joint_group_id = ?
                    ORDER BY jgm.sort_order LIMIT 1
                `, jg.id);
                if (!repMember) continue;

                const virtualName = jg.joint_scoreboard_key || jg.name || `합동 ${repMember.orig_name}`;

                // 검색 필터 — 외부 API 가 받았던 동일 조건을 가상 row 에도 적용
                if (name && !virtualName.includes(name)) continue;
                if (division && repMember.division && !String(repMember.division).includes(division)) continue;
                if (gender && ['M', 'F', 'X'].includes(gender) && repMember.gender !== gender) continue;
                if (roundType && ['preliminary', 'semifinal', 'final'].includes(roundType) && repMember.round_type !== roundType) continue;

                virtualJointItems.push({
                    id: -jg.id,                              // 음수 ID = joint group 표식
                    competition_id: compId,
                    name: virtualName,
                    category: repMember.category || '',
                    gender: repMember.gender || '',
                    division: repMember.division || '',
                    round_type: repMember.round_type || '',
                    round_status: '',                        // 합동 그룹 자체는 상태 없음
                    sort_order: repMember.sort_order || 0,
                    result_url: '',
                    video_url: '',
                    is_joint: true,
                    joint_group_id: jg.id,
                    joint_scoreboard_key: jg.joint_scoreboard_key || null
                });
            }
        } catch (e) {
            console.error('[external/events/search] joint group enrich error:', e.message);
        }

        // limit 적용: 원본 rows 가 limit 을 가득 채웠으면 합동은 추가만, 아니면 같이 자르기
        const combined = [...rows, ...virtualJointItems];
        const items = combined.slice(0, limit);

        return res.json({
            ok: true,
            competition: { id: compCheck.comp.id, name: compCheck.comp.name, mode: compCheck.comp.mode, start_date: compCheck.comp.start_date, end_date: compCheck.comp.end_date },
            count: items.length,
            limit,
            items
        });
    } catch (e) {
        console.error('[external/events/search]', e);
        return res.status(500).json({ ok: false, code: 'INTERNAL_ERROR', message: e.message || 'internal error' });
    }
});

// ── Phase 4: 종목 단건 조회 ──
// GET /api/external/event/:id
// 음수 ID = joint_group (합동 종목) — search 응답에서 받은 가상 ID 그대로 사용 가능
app.get('/api/external/event/:id', externalApiAuth, async (req, res) => {
    const eventId = parseInt(req.params.id);
    if (!Number.isFinite(eventId) || eventId === 0) {
        return res.status(400).json({ ok: false, code: 'INVALID_EVENT_ID', message: 'event id가 올바르지 않습니다.' });
    }

    // ─── 합동 종목 (음수 ID) 처리 ──────────────────────────────────
    if (eventId < 0) {
        const groupId = -eventId;
        const jg = await db.get('SELECT * FROM joint_group WHERE id=?', groupId);
        if (!jg) return res.status(404).json({ ok: false, code: 'EVENT_NOT_FOUND', message: '합동 종목을 찾을 수 없습니다.' });

        const members = await db.all(`
            SELECT jgm.event_id, jgm.competition_id, jgm.sort_order,
                   e.name, e.gender, e.round_type, e.division, e.category, e.sort_order as event_sort_order,
                   e.round_status,
                   COALESCE(e.result_url,'') as result_url,
                   COALESCE(e.video_url,'') as video_url
            FROM joint_group_member jgm
            JOIN event e ON e.id = jgm.event_id
            WHERE jgm.joint_group_id = ?
            ORDER BY jgm.sort_order
        `, groupId);
        if (!members.length) return res.status(404).json({ ok: false, code: 'EVENT_NOT_FOUND', message: '합동 종목에 멤버가 없습니다.' });

        const rep = members[0];
        const compCheck = await _ensureDisplayCompetition(rep.competition_id);
        if (!compCheck.ok) return res.status(404).json({ ok: false, code: compCheck.code, message: compCheck.message });

        // 키 범위 검증 — 키가 대표 멤버 대회에 접근 가능해야 함
        const scope = _checkCompetitionScope(req.extApiKey, rep.competition_id);
        if (!scope.ok) return res.status(403).json({ ok: false, code: scope.code, message: scope.message });

        return res.json({
            ok: true,
            competition: { id: compCheck.comp.id, name: compCheck.comp.name, mode: compCheck.comp.mode, start_date: compCheck.comp.start_date, end_date: compCheck.comp.end_date },
            event: {
                id: eventId,                                 // 음수 ID 그대로
                competition_id: rep.competition_id,
                name: jg.joint_scoreboard_key || jg.name,
                category: rep.category || '',
                gender: rep.gender || '',
                division: rep.division || '',
                round_type: rep.round_type || '',
                round_status: rep.round_status || '',
                sort_order: rep.event_sort_order || 0,
                result_url: '',
                video_url: '',
                is_joint: true,
                joint_group_id: jg.id,
                joint_scoreboard_key: jg.joint_scoreboard_key || null,
                members: members.map(m => ({
                    event_id: m.event_id,
                    competition_id: m.competition_id,
                    name: m.name,
                    gender: m.gender,
                    round_type: m.round_type,
                    division: m.division,
                    sort_order: m.sort_order
                }))
            }
        });
    }

    // ─── 일반 종목 (양수 ID) — 기존 동작 그대로 ───────────────────
    const evt = await db.get(`
        SELECT e.id, e.competition_id, e.name, e.category, e.gender, e.division,
               e.round_type, e.round_status, e.sort_order,
               COALESCE(e.result_url, '') AS result_url,
               COALESCE(e.video_url, '')  AS video_url
        FROM event e
        WHERE e.id = ?
    `, eventId);

    if (!evt) {
        return res.status(404).json({ ok: false, code: 'EVENT_NOT_FOUND', message: '종목을 찾을 수 없습니다.' });
    }

    // 키 범위 검증
    const scope = _checkCompetitionScope(req.extApiKey, evt.competition_id);
    if (!scope.ok) return res.status(403).json({ ok: false, code: scope.code, message: scope.message });

    const compCheck = await _ensureDisplayCompetition(evt.competition_id);
    if (!compCheck.ok) return res.status(404).json({ ok: false, code: compCheck.code, message: compCheck.message });

    return res.json({
        ok: true,
        competition: { id: compCheck.comp.id, name: compCheck.comp.name, mode: compCheck.comp.mode, start_date: compCheck.comp.start_date, end_date: compCheck.comp.end_date },
        event: evt
    });
});

// ── Phase 5: 단건 결과 링크 저장 ──
// POST /api/external/event-result-link
//   body:
//     event_id (required)
//     url      (required, https?:// 형식)
//     field    (optional, default 'result_url' / 또는 'video_url')
//     dry_run  (optional bool)  — 검증만, 저장 X
//     force    (optional bool)  — 기존 값 덮어쓰기 허용
app.post('/api/external/event-result-link', externalApiAuth, async (req, res) => {
    const body = req.body || {};
    const eventId = parseInt(body.event_id);
    const url = (body.url || '').trim();
    const field = (body.field || 'result_url').trim();
    const dryRun = !!body.dry_run;
    const force = !!body.force;

    if (!Number.isFinite(eventId) || eventId <= 0) {
        return res.status(400).json({ ok: false, code: 'INVALID_EVENT_ID', message: 'event_id가 올바르지 않습니다.' });
    }
    if (!_isValidUrl(url)) {
        return res.status(400).json({ ok: false, code: 'INVALID_URL', message: 'url은 https?:// 형식이어야 합니다 (10~2000자).' });
    }
    if (!['result_url', 'video_url'].includes(field)) {
        return res.status(400).json({ ok: false, code: 'INVALID_FIELD', message: "field는 'result_url' 또는 'video_url'이어야 합니다." });
    }

    const evt = await db.get(`SELECT id, competition_id, name, division, gender, round_type,
                                   COALESCE(result_url,'') AS result_url,
                                   COALESCE(video_url,'')  AS video_url
                            FROM event WHERE id = ?`, eventId);
    if (!evt) {
        return res.status(404).json({ ok: false, code: 'EVENT_NOT_FOUND', message: '종목을 찾을 수 없습니다.' });
    }

    const scope = _checkCompetitionScope(req.extApiKey, evt.competition_id);
    if (!scope.ok) return res.status(403).json({ ok: false, code: scope.code, message: scope.message });

    const compCheck = await _ensureDisplayCompetition(evt.competition_id);
    if (!compCheck.ok) return res.status(404).json({ ok: false, code: compCheck.code, message: compCheck.message });

    const oldValue = evt[field] || '';
    const willOverwrite = oldValue && oldValue !== url;
    if (willOverwrite && !force) {
        return res.status(409).json({
            ok: false,
            code: 'ALREADY_HAS_VALUE',
            message: `이 종목에는 이미 ${field}이(가) 저장되어 있습니다. 덮어쓰려면 force=true 를 보내세요.`,
            event_id: eventId,
            field,
            current_value: oldValue,
            requested_value: url
        });
    }

    if (dryRun) {
        return res.json({
            ok: true,
            dry_run: true,
            event_id: eventId,
            field,
            current_value: oldValue,
            requested_value: url,
            will_overwrite: willOverwrite,
            event: { id: evt.id, name: evt.name, division: evt.division, gender: evt.gender, round_type: evt.round_type }
        });
    }

    // 실제 저장
    try {
        if (field === 'result_url') {
            await db.run('UPDATE event SET result_url = ? WHERE id = ?', url, eventId);
        } else {
            await db.run('UPDATE event SET video_url = ? WHERE id = ?', url, eventId);
        }
        // 응답에 사용할 메타
        req._extLogMeta = { competition_id: evt.competition_id, event_id: eventId };
        return res.json({
            ok: true,
            saved: true,
            event_id: eventId,
            field,
            previous_value: oldValue,
            new_value: url,
            overwritten: willOverwrite,
            event: { id: evt.id, name: evt.name, division: evt.division, gender: evt.gender, round_type: evt.round_type }
        });
    } catch (e) {
        console.error('[external/event-result-link]', e);
        return res.status(500).json({ ok: false, code: 'INTERNAL_ERROR', message: e.message || 'internal error' });
    }
});

// ── Phase 6: 배치 결과 링크 저장 ──
// POST /api/external/event-result-link/batch
//   body:
//     items:   [{ event_id, url, field?, force? }, ...]   (1~100개)
//     dry_run: bool (전체 dry-run)
//     stop_on_error: bool (default false)
app.post('/api/external/event-result-link/batch', externalApiAuth, async (req, res) => {
    const body = req.body || {};
    const items = Array.isArray(body.items) ? body.items : null;
    const dryRun = !!body.dry_run;
    const stopOnError = !!body.stop_on_error;

    if (!items || items.length === 0) {
        return res.status(400).json({ ok: false, code: 'EMPTY_ITEMS', message: 'items 배열이 비어 있습니다.' });
    }
    if (items.length > 100) {
        return res.status(400).json({ ok: false, code: 'TOO_MANY_ITEMS', message: 'items는 한번에 최대 100개까지만 처리됩니다.' });
    }

    // 1) 사전 검증 + 정규화
    const prepared = [];
    for (let i = 0; i < items.length; i++) {
        const it = items[i] || {};
        const eventId = parseInt(it.event_id);
        const url = (it.url || '').trim();
        const field = (it.field || 'result_url').trim();
        const force = !!it.force;

        if (!Number.isFinite(eventId) || eventId <= 0) {
            prepared.push({ index: i, ok: false, code: 'INVALID_EVENT_ID', message: 'event_id가 올바르지 않습니다.', input: it });
            continue;
        }
        if (!_isValidUrl(url)) {
            prepared.push({ index: i, ok: false, code: 'INVALID_URL', message: 'url 형식 오류.', event_id: eventId, input: it });
            continue;
        }
        if (!['result_url', 'video_url'].includes(field)) {
            prepared.push({ index: i, ok: false, code: 'INVALID_FIELD', message: "field는 'result_url' 또는 'video_url'.", event_id: eventId, input: it });
            continue;
        }

        const evt = await db.get(`SELECT id, competition_id, name, division, gender, round_type,
                                       COALESCE(result_url,'') AS result_url,
                                       COALESCE(video_url,'')  AS video_url
                                FROM event WHERE id = ?`, eventId);
        if (!evt) {
            prepared.push({ index: i, ok: false, code: 'EVENT_NOT_FOUND', message: '종목 없음.', event_id: eventId });
            continue;
        }
        const scope = _checkCompetitionScope(req.extApiKey, evt.competition_id);
        if (!scope.ok) {
            prepared.push({ index: i, ok: false, code: scope.code, message: scope.message, event_id: eventId });
            continue;
        }
        const compCheck = await _ensureDisplayCompetition(evt.competition_id);
        if (!compCheck.ok) {
            prepared.push({ index: i, ok: false, code: compCheck.code, message: compCheck.message, event_id: eventId });
            continue;
        }

        const oldValue = evt[field] || '';
        const willOverwrite = !!oldValue && oldValue !== url;
        if (willOverwrite && !force) {
            prepared.push({
                index: i, ok: false, code: 'ALREADY_HAS_VALUE',
                message: '기존 값이 존재. force=true 필요.',
                event_id: eventId, field, current_value: oldValue, requested_value: url
            });
            continue;
        }

        prepared.push({
            index: i, ok: true, willApply: true,
            event_id: eventId, field, url, force, willOverwrite, oldValue,
            event: { id: evt.id, name: evt.name, division: evt.division, gender: evt.gender, round_type: evt.round_type, competition_id: evt.competition_id }
        });
    }

    // stop_on_error 시 첫 실패에서 끊기
    if (stopOnError) {
        const firstErr = prepared.find(p => !p.ok);
        if (firstErr) {
            return res.status(400).json({
                ok: false,
                code: 'BATCH_VALIDATION_FAILED',
                message: '검증 단계에서 실패가 발생했고 stop_on_error=true 입니다.',
                results: prepared
            });
        }
    }

    if (dryRun) {
        const okCnt = prepared.filter(p => p.ok).length;
        return res.json({
            ok: true,
            dry_run: true,
            total: prepared.length,
            valid: okCnt,
            invalid: prepared.length - okCnt,
            results: prepared
        });
    }

    // 2) 트랜잭션 적용
    try {
        await db.transaction(async () => {
            for (const r of prepared) {
                if (!r.ok || !r.willApply) continue;
                if (r.field === 'result_url') await db.run('UPDATE event SET result_url = ? WHERE id = ?', r.url, r.event_id);
                else                          await db.run('UPDATE event SET video_url = ? WHERE id = ?', r.url, r.event_id);
                r.applied = true;
                r.previous_value = r.oldValue;
                r.new_value = r.url;
            }
        })();
    } catch (e) {
        console.error('[external/event-result-link/batch]', e);
        return res.status(500).json({ ok: false, code: 'INTERNAL_ERROR', message: e.message || 'internal error' });
    }

    const appliedCnt = prepared.filter(p => p.ok && p.applied).length;
    const failedCnt = prepared.filter(p => !p.ok).length;

    // 응답 정리(노출 필드 정돈)
    const cleanResults = prepared.map(p => {
        if (p.ok) {
            return {
                index: p.index, ok: true, applied: !!p.applied,
                event_id: p.event_id, field: p.field,
                previous_value: p.previous_value ?? p.oldValue,
                new_value: p.new_value ?? p.url,
                overwritten: !!p.willOverwrite,
                event: p.event
            };
        }
        return {
            index: p.index, ok: false, code: p.code, message: p.message,
            event_id: p.event_id, field: p.field || null,
            current_value: p.current_value, requested_value: p.requested_value
        };
    });

    return res.json({
        ok: true,
        total: prepared.length,
        applied: appliedCnt,
        failed: failedCnt,
        results: cleanResults
    });
});

// ── 외부 API 키 관리(관리자 전용) ──
//   POST   /api/admin/external-keys           발급
//   GET    /api/admin/external-keys           목록
//   POST   /api/admin/external-keys/:id/revoke 회수
//   GET    /api/admin/external-keys/logs      로그 조회
app.post('/api/admin/external-keys', async (req, res) => {
    const { admin_key, label, allowed_competition_id, rate_limit_per_min, expires_at } = req.body || {};
    if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 권한 필요' });

    const lbl = (label || '').toString().trim().slice(0, 200);
    if (!lbl) return res.status(400).json({ error: 'label은 필수입니다.' });

    let allowedComp = null;
    if (allowed_competition_id) {
        const cid = parseInt(allowed_competition_id);
        if (!Number.isFinite(cid) || cid <= 0) return res.status(400).json({ error: 'allowed_competition_id가 올바르지 않습니다.' });
        const c = await db.get('SELECT id, mode FROM competition WHERE id=?', cid);
        if (!c) return res.status(400).json({ error: '해당 대회가 존재하지 않습니다.' });
        allowedComp = cid;
    }

    let rate = parseInt(rate_limit_per_min);
    if (!Number.isFinite(rate) || rate <= 0) rate = 60;
    if (rate > 600) rate = 600;

    let expiresAt = null;
    if (expires_at) {
        const s = String(expires_at).trim();
        if (s) {
            // 간단 검증(YYYY-MM-DD 또는 YYYY-MM-DD HH:MM:SS)
            if (!/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/.test(s)) {
                return res.status(400).json({ error: 'expires_at 형식 오류 (YYYY-MM-DD 또는 YYYY-MM-DD HH:MM:SS).' });
            }
            expiresAt = s.length === 10 ? (s + ' 23:59:59') : s;
        }
    }

    const plain = _generateApiKey();
    const hash = _hashApiKey(plain);
    const prefix = _keyPrefix(plain);

    const info = await db.run(`
        INSERT INTO external_api_key (key_hash, key_prefix, label, allowed_competition_id, rate_limit_per_min, expires_at, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `, hash, prefix, lbl, allowedComp, rate, expiresAt, 'admin');

    return res.json({
        ok: true,
        message: 'API 키가 발급되었습니다. 이 키는 다시 표시되지 않으니 안전한 곳에 보관하세요.',
        id: info.lastInsertRowid,
        api_key: plain,             // ← 발급 시 1회만 반환
        key_prefix: prefix,
        label: lbl,
        allowed_competition_id: allowedComp,
        rate_limit_per_min: rate,
        expires_at: expiresAt
    });
});

app.get('/api/admin/external-keys', async (req, res) => {
    const adminKey = req.query.admin_key || req.headers['x-admin-key'];
    if (!isAdminKey(adminKey)) return res.status(403).json({ error: '관리자 권한 필요' });

    const rows = await db.all(`
        SELECT k.id, k.key_prefix, k.label, k.allowed_competition_id, k.rate_limit_per_min,
               k.expires_at, k.revoked_at, k.last_used_at, k.total_calls, k.created_at,
               c.name AS competition_name
        FROM external_api_key k
        LEFT JOIN competition c ON c.id = k.allowed_competition_id
        ORDER BY k.id DESC
    `);

    return res.json({ ok: true, items: rows });
});

app.post('/api/admin/external-keys/:id/revoke', async (req, res) => {
    const { admin_key } = req.body || {};
    if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 권한 필요' });
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id 오류' });

    const _nowFEA = db.isAsync ? 'NOW()' : "datetime('now')";
    const r = await db.run(`UPDATE external_api_key SET revoked_at = ${_nowFEA} WHERE id = ? AND revoked_at IS NULL`, id);
    if (r.changes === 0) return res.status(404).json({ error: '해당 키 없음 또는 이미 회수됨' });
    return res.json({ ok: true, id, revoked_at: new Date().toISOString() });
});

app.get('/api/admin/external-keys/logs', async (req, res) => {
    const adminKey = req.query.admin_key || req.headers['x-admin-key'];
    if (!isAdminKey(adminKey)) return res.status(403).json({ error: '관리자 권한 필요' });

    let limit = parseInt(req.query.limit || '100', 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 100;
    if (limit > 500) limit = 500;
    const apiKeyId = req.query.api_key_id ? parseInt(req.query.api_key_id) : null;

    let sql = `
        SELECT l.id, l.api_key_id, l.key_prefix, l.endpoint, l.method,
               l.request_ip, l.user_agent, l.competition_id, l.event_id,
               l.response_status, l.response_code, l.duration_ms, l.created_at,
               k.label AS key_label
        FROM external_api_log l
        LEFT JOIN external_api_key k ON k.id = l.api_key_id
    `;
    const params = [];
    if (apiKeyId) { sql += ' WHERE l.api_key_id = ?'; params.push(apiKeyId); }
    sql += ' ORDER BY l.id DESC LIMIT ?';
    params.push(limit);

    const rows = await db.all(sql, ...params);
    return res.json({ ok: true, count: rows.length, items: rows });
});


// ============================================================
// DISPLAY-MODE (노출용 대회) APIs
// ============================================================

// --- Helper: parse 종별 (e.g. "남고", "여자(아시아)", "남고(U20포함)", "중학교부", "U18(남)", "선수권(혼)", "남초") ---
// 정책: "라벨 자유화" — 알 수 없는 라벨도 가능한 한 그대로 division 으로 보존하고,
//       절대로 임의로 "중등부" 같은 기본값을 부여하지 않음.
function parseJongbyul(jb) {
    const raw = (jb || '').trim();
    // FIX: 공백 제거한 형태로 매칭(엑셀에 "남자 대학부"처럼 공백이 들어간 라벨 처리)
    const s = raw.replace(/\s+/g, '');
    if (!s) return { gender: 'X', division: '' };

    // ── 1) U20/U18 "포함" 변형 (괄호 안에 성별이 아닌 부가설명이 있는 경우) ──
    //    "남고(U20포함)", "여고(U20포함)" 등 — 괄호 매칭보다 먼저 처리해야 함.
    if (/남고\(U20/i.test(s) || /남자고등.*U20/i.test(s)) return { gender: 'M', division: 'U20' };
    if (/여고\(U20/i.test(s) || /여자고등.*U20/i.test(s)) return { gender: 'F', division: 'U20' };

    // ── 2) 괄호 표기: "U18(남)", "U20(여)", "선수권(혼)", "일반(남)", "남자(아시아)" 등 ──
    //    ★ 핵심 정책: 괄호 안이 성별 토큰(남/여/혼)이면 division은 base+괄호 통째로 보존(예: "선수권(남)", "U18(여)").
    //    그래야 명단 PDF의 부 라벨("선수권 남자부" → "선수권(남)")과 결정적으로 일치한다.
    //    이전 버그: base만 division으로 잘라 "선수권"으로 저장 → 명단 "선수권(남)"과 매칭 실패.
    const parenMatch = s.match(/^([^(]+)\(([^)]+)\)$/);
    if (parenMatch) {
        const base = parenMatch[1];
        const inside = parenMatch[2];
        // 성별 추정 — 괄호 안 우선, 없으면 base prefix(남자/여자) 에서 추출
        let gender = 'X';
        const isGenderToken = /^(남|남자|여|여자|혼|혼성|M|F|X|믹스|mix)/i.test(inside);
        if (/^남$|^남자$|^M$/i.test(inside)) gender = 'M';
        else if (/^여$|^여자$|^F$/i.test(inside)) gender = 'F';
        else if (/^혼$|^혼성$|^X$|^믹스/i.test(inside)) gender = 'X';
        else if (/^남/.test(base)) gender = 'M';
        else if (/^여/.test(base)) gender = 'F';

        // base 정규화
        let baseNorm = base;
        if (/^중학(교)?부?$|^중등부?$/.test(base)) baseNorm = '중등부';
        else if (/^고등(학교)?부?$/.test(base)) baseNorm = '고등부';
        else if (/^대학(교)?부?$/.test(base)) baseNorm = '대학부';
        else if (/^일반부?$/.test(base)) baseNorm = '일반부';
        else if (/^초등(학교)?부?$/.test(base)) baseNorm = '초등부';

        // (아시아) 국제 — 특수 케이스
        if (/아시아/.test(inside)) return { gender, division: '국제' };

        // 괄호 안이 성별 토큰이면 division은 "base(성별약자)" 형태로 보존
        // 예: "선수권(남)" → division="선수권(남)", "U18(여)" → division="U18(여)", "U20(혼)" → "U20(혼)"
        // 단, base가 학교부 계열이면 base만 사용 (예: "중등부(남)"은 어색 → "중등부" + gender=M 으로 분리)
        if (isGenderToken) {
            if (['중등부', '고등부', '대학부', '일반부', '초등부'].includes(baseNorm)) {
                return { gender, division: baseNorm };
            }
            // 선수권/U18/U20 등은 base+성별괄호 형태 보존
            const genderShort = (gender === 'M') ? '남' : (gender === 'F' ? '여' : '혼');
            return { gender, division: `${baseNorm}(${genderShort})` };
        }

        // 괄호 안이 성별 토큰이 아닌 경우(예: "남자(아시아)"는 위에서 이미 국제로 처리됨)
        return { gender, division: baseNorm };
    }

    // ── 3) 단독 부 라벨 (성별 표기 없음) ──
    if (/^중학교부$|^중학부$|^중등부$/.test(s)) return { gender: 'X', division: '중등부' };
    if (/^고등부$|^고등학교부$/.test(s)) return { gender: 'X', division: '고등부' };
    if (/^대학부$|^대학교부$/.test(s)) return { gender: 'X', division: '대학부' };
    if (/^일반부$/.test(s)) return { gender: 'X', division: '일반부' };
    if (/^초등부$|^초등학교부$/.test(s)) return { gender: 'X', division: '초등부' };
    if (/^U18$/i.test(s)) return { gender: 'X', division: 'U18' };
    if (/^U20$/i.test(s)) return { gender: 'X', division: 'U20' };
    if (/^선수권$/.test(s)) return { gender: 'X', division: '선수권' };

    // ── 3) U20 변형(legacy 호환) ──
    if (/남고\(U20/i.test(s) || /남자고등.*U20/i.test(s)) return { gender: 'M', division: 'U20' };
    if (/여고\(U20/i.test(s) || /여자고등.*U20/i.test(s)) return { gender: 'F', division: 'U20' };
    if (/남.*\(U20/i.test(s)) return { gender: 'M', division: 'U20' };
    if (/여.*\(U20/i.test(s)) return { gender: 'F', division: 'U20' };

    // ── 4) 짧은 코드: 남초/여초/남중/여중/남고/여고/남대/여대/남일/여일 ──
    const map = {
        '남초': { gender: 'M', division: '초등부' }, '여초': { gender: 'F', division: '초등부' },
        '남중': { gender: 'M', division: '중등부' }, '여중': { gender: 'F', division: '중등부' },
        '남고': { gender: 'M', division: '고등부' }, '여고': { gender: 'F', division: '고등부' },
        '남대': { gender: 'M', division: '대학부' }, '여대': { gender: 'F', division: '대학부' },
        '남일': { gender: 'M', division: '일반부' }, '여일': { gender: 'F', division: '일반부' },
    };
    if (map[s]) return map[s];

    // ── 5) "남자초등", "여자중학" 등 풀어쓴 라벨 ──
    if (/남자초등/.test(s)) return { gender: 'M', division: '초등부' };
    if (/여자초등/.test(s)) return { gender: 'F', division: '초등부' };
    if (/남자중학/.test(s)) return { gender: 'M', division: '중등부' };
    if (/여자중학/.test(s)) return { gender: 'F', division: '중등부' };
    if (/남자고등/.test(s)) return { gender: 'M', division: '고등부' };
    if (/여자고등/.test(s)) return { gender: 'F', division: '고등부' };
    if (/남자대학/.test(s)) return { gender: 'M', division: '대학부' };
    if (/여자대학/.test(s)) return { gender: 'F', division: '대학부' };
    if (/남자일반/.test(s)) return { gender: 'M', division: '일반부' };
    if (/여자일반/.test(s)) return { gender: 'F', division: '일반부' };

    // ── 5.5) 마스터즈/생활체육 연령부 코드: M35 / M40~M50 / W40 / W55~W65 ──
    //    M=남자, W=여자. 영문 대문자 + 숫자(범위 '~' 포함). division 은 원본 보존(예: "M35~M40").
    //    ※ 콤마 구분("W40,W55~W65")은 호출부(upload)에서 이미 분리되어 단일 성별 토큰으로 들어옴.
    if (/^M\d/.test(s) && !/W\d/.test(s)) return { gender: 'M', division: raw };
    if (/^W\d/.test(s) && !/M\d/.test(s)) return { gender: 'F', division: raw };

    // ── 6) 마지막 fallback: 절대 임의 division 부여 금지 ──
    //    원본 라벨을 그대로 division 으로 보존하여 신규 라벨도 표시되도록 함.
    if (s.startsWith('남')) return { gender: 'M', division: raw };
    if (s.startsWith('여')) return { gender: 'F', division: raw };
    return { gender: 'X', division: raw };
}

// parseJongbyul wrapper: division을 normalizeDivisionLabel로 한 번 더 정규화
// (시간표 import 시 division을 결정적 표기로 저장하기 위함 — 명단 측 표기와 일치)
function parseJongbyulNormalized(jb) {
    const r = parseJongbyul(jb);
    return { gender: r.gender, division: normalizeDivisionLabel(r.division) };
}

// --- Helper: parse 라운드 for display mode ---
// 통합 정규화: 시간표 엑셀(라운드 컬럼)과 명단 PDF(▣ 종목 (라운드)) 양쪽에서 동일하게 호출.
// 시간표 엑셀 예: "예선", "준결승", "결승", "결승(A)", "10종(1)", "자격(A)"
// 명단 PDF 예:   "5-2+6", "8-2", "준 4-2", "결승", "결승 2조", "7종", "10종", "Mixed", "10종) (기록경기"
//   ※ 명단 패턴 중 "10종) (기록경기" 같이 PDF 정규식이 괄호 짝을 잘못 잡아 round 안에 ") ("이 들어오는
//      경우도 안전하게 처리 (앞부분만 보고 종합경기로 인식).
//   ※ 이 함수는 결정적이고 idempotent — 같은 입력은 항상 같은 round_type을 반환해야 함.
function parseDisplayRound(roundStr) {
    const orig = (roundStr || '').trim();
    if (!orig) return { round_type: 'final', note: '', is_combined: false };

    // 종합경기 sub-event: "10종(1)", "10종(2)", "7종" — 부모 매칭용 마커
    //   · 시간표: "10종(1)" 형식 (괄호 안 숫자)
    //   · 명단:    "7종" 단독, "10종" 단독, "10종) (기록경기" (괄호 손상)
    if (/(\d+)종/.test(orig)) {
        const m = orig.match(/(\d+)종/);
        return {
            round_type: 'final',
            note: orig,
            is_combined: true,
            combined_n: m ? parseInt(m[1]) : null,
        };
    }

    // 자격(A), 자격(B) — 예선 라운드의 한 형태
    if (orig.startsWith('자격')) {
        return { round_type: 'preliminary', note: orig, is_combined: false };
    }

    // 예선 (명시)
    if (orig.includes('예선')) {
        const noteMatch = orig.match(/\((.+)\)/);
        return { round_type: 'preliminary', note: noteMatch ? noteMatch[1] : '', is_combined: false };
    }

    // 준결, 준결승 — "준 4-2", "준4-2" 처럼 PDF에서 "준" 접두어가 붙은 heat 패턴도 포함.
    //   기존 버그: 명단 PDF의 "준 4-2"가 final로 잘못 분류되던 케이스 수정.
    if (orig.startsWith('준결') || /^준\s*\d+-\d+/.test(orig)) {
        const noteMatch = orig.match(/\((.+)\)/);
        return { round_type: 'semifinal', note: noteMatch ? noteMatch[1] : orig, is_combined: false };
    }

    // 명단 PDF heat 패턴: "5-2+6", "8-2", "3-2+2", "2-3+2" → 예선
    if (/^\d+-\d+/.test(orig)) {
        return { round_type: 'preliminary', note: orig, is_combined: false };
    }

    // 결승 (명시) — "결승 2조", "결승(A)", "결승 A,B" 모두 final 로
    if (orig.startsWith('결승')) {
        const noteMatch = orig.match(/\((.+)\)/);
        return { round_type: 'final', note: noteMatch ? noteMatch[1] : (orig.replace(/^결승\s*/, '') || ''), is_combined: false };
    }

    // 4x400mR Mixed 결승 — PDF에서 "Mixed) (결승" 식으로 깨질 수도 있음
    if (/^mixed/i.test(orig)) {
        return { round_type: 'final', note: orig, is_combined: false };
    }

    return { round_type: 'final', note: orig, is_combined: false };
}

// --- Helper: division 정규화 (시간표 + 명단 양쪽에서 호출하는 공통 헬퍼) ---
// 입력: parseJongbyul 결과 또는 parseDivisionMarker 결과 또는 raw 문자열
// 출력: 양쪽이 결정적으로 같은 division 문자열을 만들도록 정규화
//   · "선수권 남자부" / "선수권(남)" → "선수권(남)"
//   · "U18 여자부" / "U18(여)" → "U18(여)"
//   · "중학교부" / "중등부" / "남자중학교부" → "중등부"
//   · "" 빈 문자열은 그대로 유지 (시간표 종별이 비어있는 경우 대비)
function normalizeDivisionLabel(div) {
    if (!div) return '';
    const s = div.toString().trim().replace(/\s+/g, '');
    if (!s) return '';

    // 선수권 변형 통합
    if (/^선수권\(?남자?\)?부?$/.test(s) || s === '선수권남' || s === '남자선수권') return '선수권(남)';
    if (/^선수권\(?여자?\)?부?$/.test(s) || s === '선수권여' || s === '여자선수권') return '선수권(여)';
    if (/^선수권\(?혼성?\)?부?$/.test(s) || /^선수권\(?mix/i.test(s)) return '선수권(혼)';
    if (s === '선수권') return '선수권';

    // U18/U20 변형 통합
    let m = s.match(/^U(18|20)\(?(남자?|여자?|혼성?)\)?부?$/i);
    if (m) {
        const g = /^남/.test(m[2]) ? '남' : (/^여/.test(m[2]) ? '여' : '혼');
        return `U${m[1]}(${g})`;
    }
    if (/^U18$/i.test(s)) return 'U18';
    if (/^U20$/i.test(s)) return 'U20';

    // 학교부 변형 통합
    if (/^(남자|여자)?(중학교부|중학부|중등부)$/.test(s)) return '중등부';
    if (/^(남자|여자)?(고등학교부|고등부)$/.test(s)) return '고등부';
    if (/^(남자|여자)?(대학교부|대학부)$/.test(s)) return '대학부';
    if (/^(남자|여자)?(초등학교부|초등부)$/.test(s)) return '초등부';
    if (/^(남자|여자)?(일반부|실업부)$/.test(s)) return '일반부';

    // 기타 알 수 없는 라벨은 원본 보존
    return div.toString().trim();
}

// --- Helper: Excel time fraction → HH:MM string ---
function excelTimeToHHMM(val) {
    if (typeof val === 'string') {
        if (/^\d{1,2}:\d{2}/.test(val)) {
            // Normalize "7:00" → "07:00"
            const m = val.match(/^(\d{1,2}):(\d{2})/);
            if (m) return String(m[1]).padStart(2, '0') + ':' + m[2];
            return val.substring(0, 5);
        }
        return val;
    }
    if (typeof val === 'number') {
        const totalMin = Math.round(val * 24 * 60);
        const h = Math.floor(totalMin / 60);
        const m = totalMin % 60;
        return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
    }
    return '';
}

// Clean up event_name string from timetable Excel cells:
// - Strip leading/trailing whitespace
// - Replace newlines/tabs/multi-space with single space
// - Remove space immediately before "(" so e.g. "4×400mR\n(Mixed)" → "4×400mR(Mixed)"
// - Unify full-width × → x (do NOT lowercase x; keep DB-style "X" vs "x" as-is and let matcher norm)
function cleanTimetableEventName(raw) {
    if (raw === null || raw === undefined) return '';
    let s = String(raw);
    // 1) Replace all whitespace (incl. \r, \n, \t, nbsp) with single space
    s = s.replace(/[\u00A0\s]+/g, ' ').trim();
    // 2) Remove space immediately before "(" to fix "4×400mR (Mixed)" → "4×400mR(Mixed)"
    s = s.replace(/\s+\(/g, '(');
    // 3) Common typo correction: "4600mR" → "4x600mR" (missing 'x' between 4 and digits)
    //    Only fix when looks like "<digit><3+digits>mR" but starts with 4 and length implies missing x
    //    Conservative: 4xxxmR(Mixed) where xxx is 3 digits (i.e. 4600 → really 4×600)
    //    Skip 4x100/400/200/etc. (already correct)
    s = s.replace(/^4(\d{3,4}m[Rr])/, (m, rest) => '4x' + rest);
    return s;
}

// --- Helper: determine event category from name ---
function guessEventCategory(eventName) {
    const n = (eventName || '').trim();
    if (/릴레이|[Rr]$|4[x×]/.test(n)) return 'relay';
    if (/높이뛰기|장대높이/.test(n)) return 'field_height';
    if (/멀리뛰기|세단뛰기|포환|원반|창던지기|해머/.test(n)) return 'field_distance';
    if (/종경기$/.test(n)) return 'combined';
    // FIX: 트랙 경보(예: 5000mW, 10000mW)는 트랙 경기. 도로 경보(20kmW, 35kmW, 50kmW)만 road.
    // 마라톤/하프마라톤/도로(km)는 road
    if (/마라톤|하프마라톤|road/i.test(n)) return 'road';
    if (/^\d+\s*[kK]m\s*[wW]$/.test(n) || /\d+\s*[kK][mM][wW]/.test(n)) return 'road'; // 20kmW, 35kmW
    if (/\d+\s*m\s*[wW]$/i.test(n)) return 'track'; // 5000mW, 10000mW (트랙 경보)
    if (/경보/.test(n)) return 'track'; // 한글 "경보"는 보통 트랙
    return 'track';
}

// Upload timetable for display-mode competition → auto-create events
app.post('/api/display/timetable/upload', upload.single('file'), async (req, res) => {
    try {
        const { competition_id, admin_key } = req.body;
        if (!competition_id) return res.status(400).json({ error: 'competition_id required' });
        if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
        if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });

        const comp = await db.get('SELECT * FROM competition WHERE id=?', parseInt(competition_id));
        if (!comp) { try { fs.unlinkSync(req.file.path); } catch(e) {} return res.status(404).json({ error: '대회를 찾을 수 없습니다.' }); }

        const wb = XLSX.readFile(req.file.path);
        const ws = wb.Sheets[wb.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json(ws, { header: 1 });

        // Find header row
        let headerIdx = -1;
        for (let i = 0; i < Math.min(data.length, 10); i++) {
            const row = (data[i] || []).map(c => String(c || '').trim());
            if (row.some(c => c === '날짜' || c === '시간' || c === '종목')) { headerIdx = i; break; }
        }
        if (headerIdx < 0) { try { fs.unlinkSync(req.file.path); } catch(e) {} return res.status(400).json({ error: '시간표 헤더를 찾을 수 없습니다. (날짜/시간/종목 컬럼 필요)' }); }

        const headers = data[headerIdx].map(c => String(c || '').trim());
        const colIdx = {
            date: headers.findIndex(h => h === '날짜'),
            section: headers.findIndex(h => h === '구분'),
            time: headers.findIndex(h => h === '시간'),
            event: headers.findIndex(h => h === '종목'),
            jongbyul: headers.findIndex(h => h === '종별'),
            round: headers.findIndex(h => h === '라운드'),
        };

        if (colIdx.time < 0 || colIdx.event < 0) {
            try { fs.unlinkSync(req.file.path); } catch(e) {}
            return res.status(400).json({ error: '시간/종목 컬럼이 필요합니다.' });
        }

        // Parse all dates to compute day numbers
        const dateSet = new Set();
        for (let i = headerIdx + 1; i < data.length; i++) {
            const row = data[i] || [];
            if (colIdx.date >= 0 && row[colIdx.date]) {
                const ds = String(row[colIdx.date]).trim();
                if (ds) dateSet.add(ds);
            }
        }
        const sortedDates = [...dateSet].sort();
        const dateToDay = {};
        sortedDates.forEach((d, idx) => { dateToDay[d] = idx + 1; });

        // Also use competition start_date for day offset
        const compStart = comp.start_date ? new Date(comp.start_date + 'T00:00:00') : null;

        const timetableEntries = [];
        const eventMap = {}; // key: eventName|gender|division → event definition

        let prevDate = sortedDates[0] || '';

        for (let i = headerIdx + 1; i < data.length; i++) {
            const row = data[i] || [];
            const rawDate = colIdx.date >= 0 ? String(row[colIdx.date] || '').trim() : '';
            const rawSection = colIdx.section >= 0 ? String(row[colIdx.section] || '').trim() : '';
            const rawTime = row[colIdx.time];
            const rawEvent = cleanTimetableEventName(row[colIdx.event] || '');
            const rawJongbyul = colIdx.jongbyul >= 0 ? String(row[colIdx.jongbyul] || '').replace(/[\u00A0\s]+/g, ' ').trim() : '';
            const rawRound = colIdx.round >= 0 ? String(row[colIdx.round] || '').replace(/[\u00A0\s]+/g, ' ').trim() : '';

            if (!rawEvent && !rawTime) continue;

            // Fix: sometimes 종목 column has the event name in jongbyul position (row shift)
            let eventName = rawEvent;
            let jongbyul = rawJongbyul;
            if (!eventName && rawJongbyul) { eventName = rawJongbyul; jongbyul = ''; }

            const currentDate = rawDate || prevDate;
            if (rawDate) prevDate = rawDate;

            const dayNum = dateToDay[currentDate] || 1;
            // '구분' column mapping: track/field/road (Korean & English)
            let section = 'track';
            const secLower = (rawSection || '').toLowerCase();
            if (secLower.includes('필드') || secLower.includes('field') || secLower.includes('투척') || secLower.includes('도약')) {
                section = 'field';
            } else if (secLower.includes('도로') || secLower.includes('road') || secLower.includes('경보') || secLower.includes('마라톤')) {
                section = 'road';
            }
            const timeStr = excelTimeToHHMM(rawTime);

            // Compute scheduled_date
            let scheduledDate = null;
            if (compStart && dayNum) {
                const dd = new Date(compStart);
                dd.setDate(dd.getDate() + dayNum - 1);
                scheduledDate = dd.toISOString().split('T')[0];
            }

            // FIX: jongbyul을 "/" 또는 "," 로 분리 (엑셀에 "남자 대학부, 남자 일반부, 여자 일반부" 같은 콤마 구분 입력 처리)
            const jbParts = jongbyul ? jongbyul.split(/[\/,]/).map(s => s.trim()).filter(Boolean) : [''];
            const parsedRound = parseDisplayRound(rawRound);

            for (const jbPart of jbParts) {
                const parsed = parseJongbyulNormalized(jbPart);
                const gender = parsed.gender;
                const division = parsed.division;

                // Determine event category from '구분' column (section) + event name
                let category = guessEventCategory(eventName);
                if (section === 'road' && category === 'track') {
                    category = 'road';
                } else if (section === 'field') {
                    if (category === 'track') {
                        // Use event name to distinguish height vs distance
                        if (/높이뛰기|장대높이/.test(eventName)) {
                            category = 'field_height';
                        } else {
                            category = 'field_distance';
                        }
                    }
                }

                // ── 결합경기(10종/7종/5종) 감지 ──
                //   · 종목명에 "(N종)" 표기: "100m(10종)", "멀리뛰기(7종)" (라운드=기록경기)  ← 그린·코리아오픈 양식
                //   · 또는 라운드에 "N종(..)" 표기: 레거시 양식
                //   → 부모("N종경기") 1개 + 각 세부종목을 자식(parent_event_id)으로 생성.
                const nameComb = eventName.match(/\((\d+)종\)/);
                const roundComb = rawRound.match(/^(\d+)종/);
                const combinedN = nameComb ? nameComb[1] : (roundComb ? roundComb[1] : null);

                if (combinedN) {
                    const parentName = `${combinedN}종경기`;
                    const pKey = `${parentName}|${gender}|${division || ''}`;
                    if (!eventMap[pKey]) {
                        eventMap[pKey] = { name: parentName, gender, division, category: 'combined', rounds: new Set(['final']), isParent: true };
                    }
                    // 자식: 종목명 그대로(마커 포함)로 저장 → 일반 단일종목과 충돌 방지 + 시간표 자동링크 일치
                    const cKey = `${eventName}|${gender}|${division || ''}`;
                    if (!eventMap[cKey]) {
                        eventMap[cKey] = {
                            name: eventName, gender, division,
                            category: (category === 'combined' ? 'track' : category),
                            rounds: new Set(['final']), isChild: true, parentKey: pKey,
                        };
                    }
                } else {
                    const eventKey = `${eventName}|${gender}|${division || ''}`;
                    if (!eventMap[eventKey]) {
                        eventMap[eventKey] = { name: eventName, gender, division, category, rounds: new Set() };
                    }
                    eventMap[eventKey].rounds.add(parsedRound.round_type);
                }

                // Add timetable entry
                timetableEntries.push({
                    competition_id: parseInt(competition_id),
                    day: dayNum,
                    section,
                    time: timeStr,
                    event_name: eventName,
                    category: jbPart || '',
                    round: rawRound,
                    note: parsedRound.note || '',
                    sort_order: timetableEntries.length,
                    scheduled_date: scheduledDate,
                    gender, division,
                });
            }
        }

        if (timetableEntries.length === 0) {
            try { fs.unlinkSync(req.file.path); } catch(e) {}
            return res.status(400).json({ error: '시간표 데이터가 없습니다.' });
        }

        const uploadedDays = [...new Set(timetableEntries.map(e => e.day))].sort((a, b) => a - b);

        // ─── OPTION C: PRESERVE PAST + DIFF MERGE FOR FUTURE/TODAY ───
        // 1) Determine "today" in local server timezone (YYYY-MM-DD)
        const todayStr = new Date().toISOString().split('T')[0];
        const overwriteMode = req.body.overwrite_mode || 'smart'; // 'smart' (default) | 'force' (legacy: full delete)

        // 2) Filter out entries for past days (scheduled_date < today) UNLESS force mode
        let filteredEntries = timetableEntries;
        let skippedPastDays = [];
        if (overwriteMode !== 'force') {
            const pastDaysSet = new Set();
            filteredEntries = timetableEntries.filter(e => {
                if (e.scheduled_date && e.scheduled_date < todayStr) {
                    pastDaysSet.add(e.day);
                    return false;
                }
                return true;
            });
            skippedPastDays = [...pastDaysSet].sort((a, b) => a - b);
        }

        const effectiveDays = [...new Set(filteredEntries.map(e => e.day))].sort((a, b) => a - b);

        // Transaction: smart-merge timetable + create events
        const tx = db.transaction(async () => {
            let addedCount = 0;
            let updatedCount = 0;
            let deletedCount = 0;
            let preservedCount = 0;

            const INS_TT_SQL = `INSERT INTO timetable
                (competition_id, day, section, time, event_name, category, round, note, sort_order, scheduled_date)
                VALUES (?,?,?,?,?,?,?,?,?,?)`;

            if (overwriteMode === 'force') {
                // LEGACY: full delete for uploaded days
                for (const d of uploadedDays) {
                    await db.run('DELETE FROM timetable WHERE competition_id=? AND day=?', parseInt(competition_id), d);
                }
                for (const e of timetableEntries) {
                    await db.run(INS_TT_SQL, e.competition_id, e.day, e.section, e.time, e.event_name, e.category, e.round, e.note, e.sort_order, e.scheduled_date);
                    addedCount++;
                }
            } else {
                // SMART MERGE (옵션 C):
                //   - 과거 일차(scheduled_date < today): 절대 건드리지 않음
                //   - 오늘/미래 일차: 행 단위 diff 머지
                //     * 매칭 키: (day, time, event_name, category, round)
                //     * 매칭 시 → UPDATE (event_id, callroom_time, note 등 보존)
                //     * 신규 → INSERT
                //     * 엑셀에 없는 기존 미래 행 → DELETE
                // FIX: event_id를 NULL로 리셋해서 autoLinkDisplayTimetable이 새 division/gender로 재링크하도록 함
                //       (예전 잘못된 라벨로 만들어진 event에 링크된 채 남아있는 문제 방지)
                const UPD_TT_SQL = `UPDATE timetable SET
                    section=?, note=?, sort_order=?, scheduled_date=?, event_id=NULL
                    WHERE id=?`;
                const DEL_ONE_SQL = 'DELETE FROM timetable WHERE id=?';

                for (const day of effectiveDays) {
                    // Existing rows for this day (only future/today, since past days are filtered upstream)
                    const existingRows = await db.all('SELECT * FROM timetable WHERE competition_id=? AND day=?', parseInt(competition_id), day);

                    // Skip if this day is in the past (safety)
                    const sampleRow = existingRows[0];
                    if (sampleRow && sampleRow.scheduled_date && sampleRow.scheduled_date < todayStr) {
                        preservedCount += existingRows.length;
                        continue;
                    }

                    // Build match key for existing rows
                    const buildKey = (r) => `${r.time||''}|${(r.event_name||'').trim()}|${(r.category||'').trim()}|${(r.round||'').trim()}`;
                    const existingByKey = new Map();
                    existingRows.forEach(r => {
                        const k = buildKey(r);
                        if (!existingByKey.has(k)) existingByKey.set(k, []);
                        existingByKey.get(k).push(r);
                    });

                    // New entries for this day
                    const newEntries = filteredEntries.filter(e => e.day === day);
                    const matchedExistingIds = new Set();

                    for (const e of newEntries) {
                        const k = buildKey(e);
                        const candidates = existingByKey.get(k);
                        if (candidates && candidates.length > 0) {
                            // UPDATE: take first unmatched candidate
                            const target = candidates.shift();
                            matchedExistingIds.add(target.id);
                            await db.run(UPD_TT_SQL, e.section, e.note || target.note, e.sort_order, e.scheduled_date, target.id);
                            updatedCount++;
                        } else {
                            // INSERT new row
                            await db.run(INS_TT_SQL, e.competition_id, e.day, e.section, e.time, e.event_name, e.category, e.round, e.note, e.sort_order, e.scheduled_date);
                            addedCount++;
                        }
                    }

                    // DELETE existing rows that are not in the new upload
                    for (const r of existingRows) {
                        if (!matchedExistingIds.has(r.id)) {
                            await db.run(DEL_ONE_SQL, r.id);
                            deletedCount++;
                        }
                    }
                }

                // Count preserved (past) days
                if (skippedPastDays.length > 0) {
                    const cnt = await db.get(`SELECT COUNT(*) AS c FROM timetable WHERE competition_id=? AND day IN (${skippedPastDays.map(()=>'?').join(',')})`, parseInt(competition_id), ...skippedPastDays);
                    preservedCount += (cnt && cnt.c) || 0;
                }
            }

            // Create events (skip if already exists for this competition)
            const existingEvents = await db.all('SELECT id, name, gender, division, round_type FROM event WHERE competition_id=?', parseInt(competition_id));
            const existingSet = new Set(existingEvents.map(e => `${e.name}|${e.gender}|${e.division || ''}|${e.round_type}`));

            const INS_EVENT_SQL = 'INSERT INTO event (competition_id, name, category, gender, round_type, division, sort_order) VALUES (?,?,?,?,?,?,?)';
            const INS_CHILD_SQL = 'INSERT INTO event (competition_id, name, category, gender, round_type, division, parent_event_id, sort_order) VALUES (?,?,?,?,?,?,?,?)';
            let eventCount = 0;
            let sortIdx = existingEvents.length;

            // 결합경기 자식 링크용: (name|gender|division) → final 라운드 event id
            const finalIdByKey = {};
            for (const e of existingEvents) {
                if (e.round_type === 'final') {
                    const k = `${e.name}|${e.gender}|${e.division || ''}`;
                    if (finalIdByKey[k] == null) finalIdByKey[k] = e.id;
                }
            }

            // 1) 일반 + 결합 부모 먼저 생성 (자식 제외)
            for (const ev of Object.values(eventMap)) {
                if (ev.isChild) continue;
                const rounds = ev.rounds.size > 0 ? [...ev.rounds] : ['final'];
                const hasP = rounds.includes('preliminary');
                const hasS = rounds.includes('semifinal');
                const roundsToCreate = [];
                if (hasP) roundsToCreate.push('preliminary');
                if (hasS) roundsToCreate.push('semifinal');
                roundsToCreate.push('final');
                const uniqueRounds = [...new Set(roundsToCreate)];

                for (const rt of uniqueRounds) {
                    const key = `${ev.name}|${ev.gender}|${ev.division || ''}|${rt}`;
                    if (!existingSet.has(key)) {
                        const r = await db.run(INS_EVENT_SQL, parseInt(competition_id), ev.name, ev.category, ev.gender, rt, ev.division || '', sortIdx++);
                        existingSet.add(key);
                        eventCount++;
                        if (rt === 'final') finalIdByKey[`${ev.name}|${ev.gender}|${ev.division || ''}`] = r.lastInsertRowid;
                    }
                }
            }

            // 2) 결합경기 자식 생성 — parent_event_id 로 부모에 연결
            for (const ev of Object.values(eventMap)) {
                if (!ev.isChild) continue;
                const parentId = finalIdByKey[ev.parentKey] || null;
                const key = `${ev.name}|${ev.gender}|${ev.division || ''}|final`;
                if (!existingSet.has(key)) {
                    await db.run(INS_CHILD_SQL, parseInt(competition_id), ev.name, ev.category, ev.gender, 'final', ev.division || '', parentId, sortIdx++);
                    existingSet.add(key);
                    eventCount++;
                }
            }

            return {
                ttCount: filteredEntries.length,
                eventCount,
                days: effectiveDays,
                skippedPastDays,
                addedCount, updatedCount, deletedCount, preservedCount,
                mode: overwriteMode
            };
        });

        const result = await tx();

        // Auto-link timetable to events
        try { await autoLinkDisplayTimetable(parseInt(competition_id)); } catch(e) { console.warn('Display auto-link warning:', e.message); }

        // Compute callroom times
        try {
            const needCR = await db.all('SELECT id, time, section FROM timetable WHERE competition_id=? AND callroom_time IS NULL', parseInt(competition_id));
            for (const tt of needCR) {
                const m = (tt.time || '').match(/^(\d{1,2}):(\d{2})/);
                if (!m) continue;
                let h = parseInt(m[1]), min = parseInt(m[2]);
                const offset = (tt.section === 'field') ? 45 : 30;
                min -= offset; while (min < 0) { min += 60; h -= 1; }
                if (h >= 0) {
                    await db.run('UPDATE timetable SET callroom_time=? WHERE id=? AND callroom_time IS NULL', String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0'), tt.id);
                }
            }
        } catch(e) {}

        try { fs.unlinkSync(req.file.path); } catch(e) {}

        // Build human-readable message
        let msg;
        if (result.mode === 'force') {
            msg = `[강제덮어쓰기] 시간표 ${result.ttCount}건 등록, 종목 ${result.eventCount}개 생성됨`;
        } else {
            const parts = [];
            if (result.addedCount) parts.push(`추가 ${result.addedCount}`);
            if (result.updatedCount) parts.push(`수정 ${result.updatedCount}`);
            if (result.deletedCount) parts.push(`삭제 ${result.deletedCount}`);
            if (result.skippedPastDays.length > 0) parts.push(`과거 ${result.skippedPastDays.map(d=>d+'일차').join('·')} 보존`);
            if (result.eventCount) parts.push(`종목 ${result.eventCount}개 신규`);
            msg = `[스마트머지] ${parts.join(' · ') || '변경 없음'}`;
        }

        opLog(`노출용 시간표 업로드 (${result.days.map(d=>d+'일차').join(', ') || '없음'}, ${msg})`, 'admin', 'admin', parseInt(competition_id));
        res.json({ success: true, ...result, message: msg });
    } catch(e) {
        console.error('Display timetable upload error:', e);
        try { if (req.file) fs.unlinkSync(req.file.path); } catch(ex) {}
        res.status(500).json({ error: '시간표 업로드 실패: ' + e.message });
    }
});

// 수동 재링크 API: 시간표의 모든 event_id를 NULL로 리셋한 뒤 autoLink 재실행
//   사용 케이스: 잘못된 라벨로 매칭됐던 행을 일괄 재매칭 (필요 시 누락된 event 자동 생성)
app.post('/api/display/timetable/relink/:compId', async (req, res) => {
    try {
        const { admin_key } = req.body;
        if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
        const compId = parseInt(req.params.compId);
        if (!compId) return res.status(400).json({ error: 'competition_id required' });

        const beforeRow = await db.get('SELECT COUNT(*) AS c FROM timetable WHERE competition_id=? AND event_id IS NOT NULL', compId);
        const before = beforeRow ? beforeRow.c : 0;
        await db.run('UPDATE timetable SET event_id=NULL WHERE competition_id=?', compId);
        const linked = await autoLinkDisplayTimetable(compId);
        const totalRow = await db.get('SELECT COUNT(*) AS c FROM timetable WHERE competition_id=?', compId);
        const total = totalRow ? totalRow.c : 0;
        const stillUnlinked = total - linked;
        opLog(`시간표 재링크 (이전 ${before} → 현재 ${linked}, 미매칭 ${stillUnlinked})`, 'admin', 'admin', compId);
        res.json({ success: true, total, linked, unlinked: stillUnlinked, before });
    } catch (e) {
        console.error('relink error:', e);
        res.status(500).json({ error: '재링크 실패: ' + e.message });
    }
});

// ─────────────────────────────────────────────────────────────────────
// 명단 재매칭 API: 노출용 대회의 모든 명단 row event_id를 NULL로 리셋한 뒤
// autoMatchDisplayRoster 재실행. 명단 PDF 재업로드 없이 매칭 로직만 갱신할 때 사용.
// ─────────────────────────────────────────────────────────────────────
app.post('/api/display/roster/relink/:compId', async (req, res) => {
    try {
        const { admin_key } = req.body;
        if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
        const compId = parseInt(req.params.compId);
        if (!compId) return res.status(400).json({ error: 'competition_id required' });

        const beforeRow = await db.get('SELECT COUNT(*) AS c FROM display_roster WHERE competition_id=? AND event_id IS NOT NULL', compId);
        const before = beforeRow ? beforeRow.c : 0;
        await db.run('UPDATE display_roster SET event_id=NULL WHERE competition_id=?', compId);
        const matched = await autoMatchDisplayRoster(compId);
        const totalRow = await db.get('SELECT COUNT(*) AS c FROM display_roster WHERE competition_id=?', compId);
        const total = totalRow ? totalRow.c : 0;
        const stillUnmatched = total - matched;
        opLog(`명단 재매칭 (이전 ${before} → 현재 ${matched}, 미매칭 ${stillUnmatched})`, 'admin', 'admin', compId);
        res.json({ success: true, total, matched, unmatched: stillUnmatched, before });
    } catch (e) {
        console.error('roster relink error:', e);
        res.status(500).json({ error: '명단 재매칭 실패: ' + e.message });
    }
});

// ─────────────────────────────────────────────────────────────────────
// 미매칭 리포트 API: event_id가 NULL인 명단 row를 (event_name, round, division, gender) 별로 그룹화해서 반환.
// 어떤 종목이 시간표에 없거나 표기가 다른지 한눈에 확인 가능.
// ─────────────────────────────────────────────────────────────────────
app.get('/api/display/roster/unmatched/:compId', async (req, res) => {
    try {
        const compId = parseInt(req.params.compId);
        if (!compId) return res.status(400).json({ error: 'competition_id required' });
        const rows = await db.all(`
            SELECT event_name, round, division, gender, COUNT(*) AS cnt
            FROM display_roster
            WHERE competition_id=? AND event_id IS NULL
            GROUP BY event_name, round, division, gender
            ORDER BY event_name, round, division, gender
        `, compId);
        const totalRow = await db.get('SELECT COUNT(*) AS c FROM display_roster WHERE competition_id=? AND event_id IS NULL', compId);
        const total = totalRow ? totalRow.c : 0;
        res.json({ success: true, total_unmatched: total, groups: rows });
    } catch (e) {
        console.error('unmatched report error:', e);
        res.status(500).json({ error: '미매칭 리포트 조회 실패: ' + e.message });
    }
});

// ─────────────────────────────────────────────────────────────────────
// 고아 event 정리 API (노출용 대회 한정)
//   사용 케이스: 옛날 코드(라벨 자유화 이전)로 시간표를 올렸을 때 잘못된
//                division/gender 로 만들어진 event 들이 DB에 남아있음.
//                재배포·재업로드 후, 시간표에 한 번도 링크되지 않고
//                선수 엔트리/조/결과 링크도 없는 "고아 event" 만 안전 삭제.
//
//   안전 정책 (다음 조건 모두 만족해야 삭제 후보):
//     - competition_id 일치
//     - timetable.event_id 참조 0건 (재링크 후 미사용)
//     - event_entry 0건 (선수 엔트리 없음)
//     - heat 0건 (조 편성 없음)
//     - result_url, video_url 모두 비어있음 (수동 입력 보호)
//     - 다른 event 의 parent_event_id 로 참조되지 않음 (10종/7종 보호)
//
//   2단계 분리:
//     GET  /api/display/cleanup-orphan-events/:compId  → 미리보기(삭제 안 함)
//     POST /api/display/cleanup-orphan-events/:compId  → 실제 삭제
// ─────────────────────────────────────────────────────────────────────
async function _findOrphanEvents(compId) {
    return await db.all(`
        SELECT e.id, e.name, e.gender, e.division, e.round_type, e.category,
               COALESCE(e.result_url,'') AS result_url,
               COALESCE(e.video_url,'')  AS video_url
        FROM event e
        WHERE e.competition_id = ?
          AND COALESCE(e.result_url,'') = ''
          AND COALESCE(e.video_url,'')  = ''
          AND e.parent_event_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM timetable    t  WHERE t.event_id        = e.id)
          AND NOT EXISTS (SELECT 1 FROM event_entry  ee WHERE ee.event_id       = e.id)
          AND NOT EXISTS (SELECT 1 FROM heat         h  WHERE h.event_id        = e.id)
          AND NOT EXISTS (SELECT 1 FROM event        e2 WHERE e2.parent_event_id = e.id)
        ORDER BY e.id
    `, compId);
}

// 미리보기
app.get('/api/display/cleanup-orphan-events/:compId', async (req, res) => {
    try {
        const admin_key = req.query.admin_key || req.headers['x-admin-key'] || '';
        if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
        const compId = parseInt(req.params.compId);
        if (!compId) return res.status(400).json({ error: 'competition_id required' });

        const comp = await db.get('SELECT id, name, mode FROM competition WHERE id=?', compId);
        if (!comp) return res.status(404).json({ error: '대회를 찾을 수 없습니다.' });
        if (comp.mode !== 'display') return res.status(400).json({ error: '노출용(display) 대회에서만 사용 가능합니다.' });

        const orphans = await _findOrphanEvents(compId);
        const totalEventsRow = await db.get('SELECT COUNT(*) AS c FROM event WHERE competition_id=?', compId);
        const totalEvents = totalEventsRow ? totalEventsRow.c : 0;

        // 그룹 요약
        const byBucket = {};
        orphans.forEach(o => {
            const k = `${o.division || '(EMPTY)'} | ${o.gender}`;
            byBucket[k] = (byBucket[k] || 0) + 1;
        });

        res.json({
            success: true,
            competition: { id: comp.id, name: comp.name },
            total_events: totalEvents,
            orphan_count: orphans.length,
            by_bucket: byBucket,
            orphans: orphans.map(o => ({
                id: o.id, name: o.name, gender: o.gender,
                division: o.division, round_type: o.round_type, category: o.category
            }))
        });
    } catch (e) {
        console.error('cleanup preview error:', e);
        res.status(500).json({ error: '미리보기 실패: ' + e.message });
    }
});

// 실제 삭제
app.post('/api/display/cleanup-orphan-events/:compId', async (req, res) => {
    try {
        const { admin_key, dry_run } = req.body || {};
        if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
        const compId = parseInt(req.params.compId);
        if (!compId) return res.status(400).json({ error: 'competition_id required' });

        const comp = await db.get('SELECT id, name, mode FROM competition WHERE id=?', compId);
        if (!comp) return res.status(404).json({ error: '대회를 찾을 수 없습니다.' });
        if (comp.mode !== 'display') return res.status(400).json({ error: '노출용(display) 대회에서만 사용 가능합니다.' });

        const orphans = await _findOrphanEvents(compId);
        if (dry_run) {
            return res.json({
                success: true, dry_run: true,
                would_delete: orphans.length,
                orphans: orphans.map(o => ({ id: o.id, name: o.name, gender: o.gender, division: o.division, round_type: o.round_type }))
            });
        }

        const deleted = await db.transaction(async () => {
            let n = 0;
            for (const o of orphans) {
                await db.run('DELETE FROM event WHERE id=?', o.id);
                n++;
            }
            return n;
        })();

        opLog(`고아 event 정리 (${deleted}개 삭제)`, 'admin', 'admin', compId);
        res.json({
            success: true,
            deleted,
            sample: orphans.slice(0, 20).map(o => ({ id: o.id, name: o.name, gender: o.gender, division: o.division, round_type: o.round_type }))
        });
    } catch (e) {
        console.error('cleanup orphan error:', e);
        res.status(500).json({ error: '정리 실패: ' + e.message });
    }
});

// Auto-link timetable to display-mode events
async function autoLinkDisplayTimetable(compId) {
    // 노출용(display) 대회만 시간표 행으로 종목을 자동 생성한다.
    // 운영용(operation) 대회는 시간표에 다른 부(예: 대학부) 행이 섞여 있어도
    // 종목을 만들지 않고 "이미 존재하는 종목과의 매칭(링크)"만 수행한다.
    const _comp = await db.get('SELECT mode FROM competition WHERE id=?', compId);
    const allowAutoCreate = !!(_comp && _comp.mode === 'display');
    let events = await db.all('SELECT id, name, gender, division, round_type, category FROM event WHERE competition_id=?', compId);
    const ttRows = await db.all('SELECT id, event_name, category AS jongbyul, round, event_id FROM timetable WHERE competition_id=?', compId);

    function norm(s) { return (s || '').replace(/\s+/g, '').toLowerCase().replace(/[×xX]/g, 'x'); }

    // Best-effort 카테고리 추정 (기존 동일 종목명에서 가져오거나 guessEventCategory)
    function guessCat(name) {
        const sameName = events.find(e => norm(e.name) === norm(name) && e.category);
        if (sameName) return sameName.category;
        return guessEventCategory(name);
    }

    let linked = 0;
    let createdEvents = 0;
    let nextSort = events.length;

    // 시간표 측에서도 동일한 정규화 기준 사용 (매칭 표기 차이 제거)
    function divNorm(d) { return normalizeDivisionLabel(d || ''); }

    for (const tt of ttRows) {
        if (tt.event_id) continue; // already linked
        const parsed = parseDisplayRound(tt.round);
        const jbParsed = parseJongbyulNormalized(tt.jongbyul);

        // 종합 sub-event는 부모 이벤트(N종경기)에 연결
        let targetName = tt.event_name;
        const isCombinedSub = parsed.is_combined && parsed.combined_n;
        if (isCombinedSub) {
            targetName = parsed.combined_n + '종경기';
        }
        const targetRound = isCombinedSub ? 'final' : parsed.round_type;
        const targetDivNorm = divNorm(jbParsed.division);

        // 1) Strict match: name + gender + division + round_type 모두 일치
        let match = events.find(ev => {
            if (norm(ev.name) !== norm(targetName)) return false;
            if (jbParsed.gender && ev.gender && ev.gender !== jbParsed.gender) return false;
            if (targetDivNorm && divNorm(ev.division) !== targetDivNorm) return false;
            return ev.round_type === targetRound;
        });

        // 2) Auto-create: 매칭 실패 시, parseJongbyul이 division을 추출했다면 누락된 event를 자동 생성
        //    (노출용 대회에서만 — 운영용은 종목 자동 생성 금지)
        if (!match && targetDivNorm && allowAutoCreate) {
            const cat = guessCat(targetName);
            const info = await db.run('INSERT INTO event (competition_id, name, category, gender, round_type, division, sort_order) VALUES (?,?,?,?,?,?,?)',
                compId, targetName, cat, jbParsed.gender || 'X', targetRound, targetDivNorm, nextSort++);
            match = {
                id: info.lastInsertRowid,
                name: targetName,
                gender: jbParsed.gender || 'X',
                division: targetDivNorm,
                round_type: targetRound,
                category: cat,
            };
            events.push(match);
            createdEvents++;
        }

        if (match) {
            await db.run('UPDATE timetable SET event_id=? WHERE id=?', match.id, tt.id);
            linked++;
        }
    }

    if (createdEvents > 0) {
        console.log(`[autoLink] competition_id=${compId}: ${linked} linked, ${createdEvents} events auto-created from timetable`);
    }
    // 폴백: 위 strict 매칭은 "실업(남)"·"대학/실업(여)" 같은 부별 표기를 division 으로 해석해
    //   division 이 빈 운영용 종목과 연결하지 못함 → 시간표 업로드/재매칭과 동일한 매처로 남은 NULL 행만 재시도.
    //   (결승·준결승 생성 직후 시간표의 "결승" 행이 자동 연결되도록)
    try {
        const fb = await _timetableRoutes.autoLinkTimetable(compId);
        if (fb && fb.linked) linked += fb.linked;
    } catch (fbErr) {
        console.warn('[autoLink fallback] ', fbErr.message);
    }
    return linked;
}

// Upload roster PDF for display-mode competition
app.post('/api/display/roster/upload', upload.single('file'), async (req, res) => {
    try {
        const { competition_id, admin_key, day, division_hint } = req.body;
        if (!competition_id) return res.status(400).json({ error: 'competition_id required' });
        if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
        if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });

        const dayNum = parseInt(day) || 1;
        // 파일명/사용자 입력에서 추출한 division_hint (PDF 파싱이 부 라벨을 못 찾을 때 fallback)
        // 예: "꿈나무" / "선수권" / "U18" / "U20"  (성별 정보가 같이 들어오면 "선수권 남자" 처럼)
        const divisionHint = (division_hint || '').toString().trim();
        const pdfParse = require('pdf-parse');
        const pdfBuffer = fs.readFileSync(req.file.path);

        pdfParse(pdfBuffer).then(async pdfData => {
            const text = pdfData.text;
            const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

            // --- Team database for parsing concatenated athlete lines ---
            // School suffixes (중학교, 고등학교, 대학교, etc.)
            const SCHOOL_SUFFIXES = [
                '체육중학교', '여자중학교', '중학교',
                '체육고등학교', '여자고등학교', '고등학교',
                '대학교', '대학'
            ];
            // Pro team suffixes
            const TEAM_SUFFIXES = [
                '특별자치도체육회', '특별자치도청', '광역시청', '특별시청',
                '시체육회', '도체육회', '시청', '군청', '도청', '체육회', '은행',
                '도시개발공사', '개발공사', '스포츠클럽_중', '스포츠클럽_고',
                '스포츠클럽', '국군체육부대', '남동구청'
            ];
            const ALL_SUFFIXES = [...SCHOOL_SUFFIXES, ...TEAM_SUFFIXES].sort((a, b) => b.length - a.length);

            // Known team/school prefixes for better matching
            const KNOWN_TEAMS = [
                '한국체육대학교', '국립경국대학교', '서울대학교', '성균관대학교', '성결대학교',
                '동아대학교', '조선대학교', '군산대학교', '원광대학교', '목포대학교',
                '경운대학교', '영남대학교', '경남대학교', '강원대학교', '인하대학교',
                '부산대학교', '문경대학교', 'SH서울주택도시개발공사',
                '전북개발공사', '무소속'
            ];

            const LOCATIONS = [
                '서울', '부산', '대구', '인천', '광주', '대전', '울산', '세종',
                '경기', '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주',
                '수원', '성남', '안양', '안산', '용인', '부천', '광명', '평택', '과천',
                '오산', '시흥', '군포', '의왕', '하남', '이천', '안성', '김포', '화성',
                '양주', '포천', '여주', '파주', '고양', '구리', '남양주', '동두천', '의정부',
                '춘천', '원주', '강릉', '동해', '태백', '속초', '삼척',
                '충주', '제천', '청주', '천안', '공주', '보령', '아산', '서산', '논산', '계룡', '당진',
                '전주', '군산', '익산', '정읍', '남원', '김제',
                '목포', '여수', '순천', '나주', '광양',
                '포항', '경주', '김천', '안동', '구미', '영주', '영천', '상주', '문경', '경산',
                '창원', '진주', '통영', '사천', '김해', '밀양', '거제', '양산',
                '서귀포', '영암', '진천', '음성', '영동', '정선', '단양', '보은',
                '가평', '양평', '연천', '영월', '철원', '화천', '양구', '인제', '고성', '양양',
                '옥천', '증평', '괴산',
                '금산', '부여', '서천', '청양', '홍성', '예산', '태안',
                '완주', '진안', '무주', '장수', '임실', '순창', '고창', '부안',
                '담양', '곡성', '구례', '고흥', '보성', '화순', '장흥', '강진', '해남',
                '무안', '함평', '영광', '장성', '완도', '진도', '신안', '진도',
                '군위', '의성', '청송', '영양', '영덕', '청도', '고령', '성주', '칠곡', '예천',
                '봉화', '울진', '울릉',
                '의령', '함안', '창녕', '남해', '하동', '산청', '함양', '거창', '합천',
                '강원특별자치', '경상북', '인천남동', '범어', '경기경안', '진주대곡',
                '진주문산', '진해냉천', '철산', '경수', '여선', '성서', '금파', '석우',
                '서생', '대청', '문산', '단원', '인천동방', '구월여자', '인화여자', '와동',
                '계남', '내동', '배문', '전곡', '문산수억', '심원', '덕계', '원곡', '유신',
                '충남', '충현', '순심', '남녕', '인일여자', '포항이동',
                '울산스포츠과학', '경기모바일과학', '김포과학기술', '과천중앙', '광주중앙',
                '대전송촌'
            ];
            const LOCATIONS_SORTED = [...LOCATIONS].sort((a, b) => b.length - a.length);

            function parseNameTeam(koreanPart) {
                if (!koreanPart || koreanPart.length < 4) return { name: koreanPart || '', team: '' };
                
                // Handle special cases: "무소속(경기)", "무소속(서울)" etc.
                const musoMatch = koreanPart.match(/^(.{2,4})(무소속\(.+\))$/);
                if (musoMatch) return { name: musoMatch[1], team: musoMatch[2] };
                
                // Handle (주) prefix teams
                const specialIdx = koreanPart.indexOf('(주)');
                if (specialIdx > 0 && specialIdx >= 2) {
                    return { name: koreanPart.substring(0, specialIdx), team: koreanPart.substring(specialIdx) };
                }

                // Try known full team names first
                for (const kt of KNOWN_TEAMS) {
                    if (koreanPart.endsWith(kt) && koreanPart.length > kt.length + 1) {
                        const nameEnd = koreanPart.length - kt.length;
                        if (nameEnd >= 2 && nameEnd <= 5) {
                            return { name: koreanPart.substring(0, nameEnd), team: kt };
                        }
                    }
                }

                // Strategy: find the longest valid team suffix from the end
                // Korean names are 2-4 chars (most commonly 3)
                // Teams end with: 중학교, 고등학교, 대학교, 시청, 군청, 도청, 체육회, etc.
                // Try name lengths 3, 2, 4 (prefer 3 as most common Korean name length)
                const teamIndicators = [
                    '중학교', '고등학교', '대학교', '대학', '시청', '군청', '도청',
                    '체육회', '도시개발공사', '개발공사', '국군체육부대',
                    '구청', '스포츠클럽', '공사', '클럽_중', '클럽_고'
                ];
                
                // Prefer 3-char name (most common), then 2, then 4
                for (const nameLen of [3, 2, 4]) {
                    if (nameLen >= koreanPart.length) continue;
                    const possibleTeam = koreanPart.substring(nameLen);
                    // Check if possibleTeam contains a team indicator
                    if (teamIndicators.some(ind => possibleTeam.includes(ind))) {
                        return { name: koreanPart.substring(0, nameLen), team: possibleTeam };
                    }
                }

                // Try suffix-based matching with location for pro teams (시청, 군청, etc.)
                for (const suffix of TEAM_SUFFIXES) {
                    if (!koreanPart.endsWith(suffix)) continue;
                    const beforeSuffix = koreanPart.substring(0, koreanPart.length - suffix.length);
                    for (const loc of LOCATIONS_SORTED) {
                        if (beforeSuffix.endsWith(loc)) {
                            const teamStart = beforeSuffix.length - loc.length;
                            if (teamStart >= 2 && teamStart <= 4) {
                                return { name: koreanPart.substring(0, teamStart), team: koreanPart.substring(teamStart) };
                            }
                        }
                    }
                }

                // Fallback: assume Korean name is 3 chars (most common)
                if (koreanPart.length >= 5) {
                    return { name: koreanPart.substring(0, 3), team: koreanPart.substring(3) };
                }
                return { name: koreanPart, team: '' };
            }

            // --- Division/Gender mapping (명단 PDF용) ---
            // 출력 division은 항상 normalizeDivisionLabel을 통과시켜 시간표 측 표기와 결정적으로 일치하게 함.
            function parseDivisionMarker(line) {
                let gender = '', division = '';
                const orig = line;

                // ── 신형 라벨 우선 처리 ─────────────────────────────────────
                // 1) "남초 4학년부", "여초 5학년부" 등 → 초등부
                let m = orig.match(/^(남|여)초\s*(\d+학년부)?$/);
                if (m) {
                    return { gender: m[1] === '남' ? 'M' : 'F', division: normalizeDivisionLabel('초등부') };
                }
                // 1.5) ★ 추가: "남중 1/2학년부", "여중 3학년부", "남고", "여고", "남대", "여대"
                //      꿈나무 PDF에 "남중 1/2학년부" 같은 라벨이 등장 — 기존엔 인식 못해 초등부 hint로 잘못 흘러감(Bug C 잔여).
                m = orig.match(/^(남|여)중(\s*[\d/]+학년부)?$/);
                if (m) {
                    return { gender: m[1] === '남' ? 'M' : 'F', division: normalizeDivisionLabel('중등부') };
                }
                m = orig.match(/^(남|여)고(\s*\d+학년부)?$/);
                if (m) {
                    return { gender: m[1] === '남' ? 'M' : 'F', division: normalizeDivisionLabel('고등부') };
                }
                m = orig.match(/^(남|여)대(\s*\d+학년부)?$/);
                if (m) {
                    return { gender: m[1] === '남' ? 'M' : 'F', division: normalizeDivisionLabel('대학부') };
                }
                // 2) "선수권 남자부" / "선수권 여자부" / "선수권 혼성부"
                m = orig.match(/^선수권\s*(남자|여자|혼성)부?$/);
                if (m) {
                    const g = m[1] === '남자' ? 'M' : (m[1] === '여자' ? 'F' : 'X');
                    const dv = m[1] === '남자' ? '선수권(남)' : (m[1] === '여자' ? '선수권(여)' : '선수권(혼)');
                    return { gender: g, division: normalizeDivisionLabel(dv) };
                }
                // 3) "U18 남자부" / "U20 여자부" / "U18 혼성부"
                m = orig.match(/^U(18|20)\s*(남자|여자|혼성)부?$/i);
                if (m) {
                    const g = m[2] === '남자' ? 'M' : (m[2] === '여자' ? 'F' : 'X');
                    const dv = `U${m[1]}(${m[2] === '남자' ? '남' : (m[2] === '여자' ? '여' : '혼')})`;
                    return { gender: g, division: normalizeDivisionLabel(dv) };
                }
                // 4) "꿈나무 남자부" / "꿈나무 여자부" (혹시 등장 시)
                m = orig.match(/^꿈나무\s*(남자|여자)부?$/);
                if (m) {
                    return { gender: m[1] === '남자' ? 'M' : 'F', division: normalizeDivisionLabel('초등부') };
                }

                // ── 구형 라벨: "남자/여자" + 중학교부/고등학교부/... ──
                if (line.startsWith('남자')) { gender = 'M'; line = line.substring(2); }
                else if (line.startsWith('여자')) { gender = 'F'; line = line.substring(2); }
                const divMap = {
                    '실업부': '일반부', '일반부': '일반부',
                    '대학부': '대학부', '대학교부': '대학부',
                    '고등부': '고등부', '고등학교부': '고등부',
                    '중등부': '중등부', '중학교부': '중등부',
                    '초등부': '초등부', '초등학교부': '초등부',
                };
                for (const [key, val] of Object.entries(divMap)) {
                    if (line.startsWith(key)) { division = val; break; }
                }
                if (!division && line) division = line;
                return { gender, division: normalizeDivisionLabel(division) };
            }

            // ============================================================
            // v4 PARSING: 라벨 기반 섹션 분할 + 릴레이 팀단위 + 혼성경기 통합 + noSeq 헤더
            //   - tmp/pdf_to_excel.js 의 v4 로직과 동일한 알고리즘
            //   - 부 라벨은 "라벨 등장 라인까지의 모든 라인 = 그 라벨" 로 묶음 (페이지 경계 무시)
            //   - 릴레이(4xNNNm[R] / 릴레이)는 첫 행만 = 레인+팀 한 행 (성명/배번 비움)
            //   - 혼성경기(round나 event_name에 (N종))는 dedup 통합해 "N종경기" 1행 per 선수
            //   - noSeqMode: 조헤더가 "N조레인번호성명소속"(공백 없음)이면 첫자리=레인, 나머지=배번
            // ============================================================
            const divMarkerRegex = new RegExp(
                '^(?:' +
                    '(?:남자|여자)?(?:초등학교부|중학교부|고등학교부|대학교부|일반부|초등부|중등부|고등부|대학부|실업부)' +
                    '|(?:남|여)초(?:\\s*[\\d/]+학년부)?' +
                    '|(?:남|여)중(?:\\s*[\\d/]+학년부)?' +
                    '|(?:남|여)고(?:\\s*[\\d/]+학년부)?' +
                    '|(?:남|여)대(?:\\s*[\\d/]+학년부)?' +
                    '|선수권\\s*(?:남자|여자|혼성)부?' +
                    '|U(?:18|20)\\s*(?:남자|여자|혼성)부?' +
                    '|꿈나무\\s*(?:남자|여자)부?' +
                ')$',
                'i'
            );

            // ── 파일명 힌트 fallback ──
            const hintParsed = divisionHint ? parseDivisionMarker(divisionHint) : null;
            const hintFallback = (hintParsed && hintParsed.division) ? hintParsed : null;
            if (hintFallback) {
                console.log(`[roster/upload v4] divisionHint="${divisionHint}" → ${JSON.stringify(hintFallback)}`);
            }

            // ── 라벨 기반 섹션 분할 ──
            //   페이지 마커(-NN-)는 제거. 부 라벨 라인 만나면 그 라벨까지의 모든 라인을 섹션으로 묶음.
            //   라벨 없이 끝난 마지막 섹션은 직전 라벨 또는 hintFallback 상속.
            const flatLines = lines.filter(l => !/^-\d+-$/.test(l));
            const sections = [];
            let curSec = [];
            let lastDivSeen = hintFallback
                ? { gender: hintFallback.gender, division: hintFallback.division }
                : { gender: '', division: '' };
            for (const l of flatLines) {
                if (divMarkerRegex.test(l)) {
                    const parsed = parseDivisionMarker(l);
                    if (parsed && parsed.division) {
                        sections.push({ lines: curSec, div: parsed });
                        lastDivSeen = parsed;
                        curSec = [];
                        continue;
                    }
                }
                curSec.push(l);
            }
            if (curSec.length) sections.push({ lines: curSec, div: lastDivSeen });

            // ── splitSeqAndBib (lastSeq 추적용) ──
            function splitSeqAndBib(digits, expectedSeq) {
                if (!digits) return { seq: null, bib: '' };
                if (digits.length >= 3 && expectedSeq >= 10) {
                    const twoDigit = parseInt(digits.substring(0, 2));
                    if (twoDigit === expectedSeq) return { seq: twoDigit, bib: digits.substring(2) };
                }
                if (digits.length >= 2) {
                    const oneDigit = parseInt(digits[0]);
                    if (oneDigit === expectedSeq && expectedSeq >= 1 && expectedSeq <= 9) {
                        return { seq: oneDigit, bib: digits.substring(1) };
                    }
                }
                if (digits.length >= 3) {
                    const twoDigit = parseInt(digits.substring(0, 2));
                    if (twoDigit >= 10 && twoDigit <= 99) return { seq: twoDigit, bib: digits.substring(2) };
                }
                if (digits.length >= 2) return { seq: parseInt(digits[0]), bib: digits.substring(1) };
                return { seq: null, bib: digits };
            }

            // ── 릴레이 종목 판별 ──
            function isRelayEvent(eventName) {
                if (!eventName) return false;
                return /\d\s*[x×Xx]\s*\d{2,4}\s*m?\s*R?/i.test(eventName)
                    || /릴레이/.test(eventName)
                    || /relay/i.test(eventName);
            }

            // ── 팀명(학교/시청/구청 등) 키워드 포함 여부 ──
            const TEAM_KEYWORDS = [
                '초등학교','중학교','고등학교','대학교','대학','시청','군청','도청','체육회',
                '도시개발공사','개발공사','국군체육부대','구청','스포츠클럽','공사',
                '클럽_중','클럽_고','클럽_초','체육부대',
            ];
            function hasTeamKeyword(s) {
                if (!s) return false;
                return TEAM_KEYWORDS.some(k => s.includes(k));
            }

            // ── 한 섹션 파싱 ──
            const rosterEntries = [];
            let sortOrder = 0;

            function parseSection(secLines, pageDiv) {
                let currentEvent = '', currentRound = '';
                let currentHeat = null;
                let laneHeaderSeen = false;
                let lastEntryIdx = -1;
                let lastSeq = 0;
                let noSeqMode = false;
                let relayMode = false;
                let relayCurrentLane = null;

                for (let i = 0; i < secLines.length; i++) {
                    const line = secLines[i];
                    if (!line) continue;
                    if (divMarkerRegex.test(line)) continue;
                    if (/^(KTFL|KOREA|TRACK|FIELD|LEAGUE|&|한국실업육상연맹|한국중고육상연맹|한국대학육상연맹|한국육상연맹|대한육상연맹)$/.test(line)) continue;

                    // 종목 헤더 (이중괄호 케이스 우선): ▣ 4x400mR(Mixed) (결승)
                    const evMatchDouble = line.match(/^[▣■□●○]\s*(.+?)\s*[\(（](.+?)[\)）]\s*[\(（](.+?)[\)）]\s*$/);
                    if (evMatchDouble) {
                        currentEvent = (evMatchDouble[1] + '(' + evMatchDouble[2] + ')').trim();
                        currentRound = evMatchDouble[3].trim();
                        currentHeat = null;
                        laneHeaderSeen = false;
                        lastEntryIdx = -1;
                        lastSeq = 0;
                        noSeqMode = false;
                        relayMode = isRelayEvent(currentEvent);
                        relayCurrentLane = null;
                        continue;
                    }
                    // 종목 헤더 (단일 괄호): ▣ 100m (5-2+6) | ▣ 100m(10종)
                    const evMatch = line.match(/^[▣■□●○]\s*(.+?)\s*[\(（](.+?)[\)）]\s*$/);
                    if (evMatch) {
                        currentEvent = evMatch[1].trim();
                        currentRound = evMatch[2].trim();
                        currentHeat = null;
                        laneHeaderSeen = false;
                        lastEntryIdx = -1;
                        lastSeq = 0;
                        noSeqMode = false;
                        relayMode = isRelayEvent(currentEvent);
                        relayCurrentLane = null;
                        continue;
                    }

                    // 조 헤더: "1조레인번호성명소속" (붙음→noSeq) | "1조   레인  번호성명소속" (공백→일반)
                    const heatMatch = line.match(/^(\d+)조\s*((?:레인|순)?\s*(?:번호)?\s*(?:성명)?\s*(?:소속)?)?\s*$/);
                    if (heatMatch) {
                        currentHeat = parseInt(heatMatch[1]);
                        laneHeaderSeen = true;
                        lastEntryIdx = -1;
                        lastSeq = 0;
                        const afterHeat = line.replace(/^\d+조/, '');
                        // 핵심 규칙:
                        //  · '순' 키워드가 들어가면 → 무조건 lastSeq 추적 모드 (noSeqMode=false)
                        //    (1500m 1조처럼 출전 인원이 10명을 넘어 두자리 순번이 나올 수 있음)
                        //  · '레인' 키워드만 있거나 키워드가 없을 때만 → 공백 유무로 noSeqMode 결정
                        //    (레인은 1~9 한자리이므로 noSeqMode 적용 안전)
                        if (/순/.test(afterHeat)) {
                            noSeqMode = false;
                        } else if (afterHeat && /\S/.test(afterHeat) && !/\s/.test(afterHeat)) {
                            noSeqMode = true;
                        } else {
                            noSeqMode = false;
                        }
                        relayCurrentLane = null;
                        continue;
                    }
                    // 비-조 헤더 "레인번호성명소속" / "레인  번호성명소속" (릴레이/필드)
                    // 주의: '순'은 여기서 매칭하지 않음 — 순은 lastSeq 추적이 필요하므로 아래 별도 분기
                    if (/^레인\s*(?:번호)?\s*(?:성명)?\s*(?:소속)?$/.test(line)) {
                        laneHeaderSeen = true;
                        lastSeq = 0;
                        noSeqMode = true; // 레인은 1~9 한자리 → noSeqMode 안전
                        relayCurrentLane = null;
                        continue;
                    }
                    // 필드 종목 "순번호성명소속" — 순 사용 (10명+ 가능 → lastSeq 추적 필수)
                    if (/^순\s*(?:번호)?\s*(?:성명)?\s*(?:소속)?$/.test(line)) {
                        laneHeaderSeen = true;
                        lastSeq = 0;
                        noSeqMode = false;
                        relayCurrentLane = null;
                        continue;
                    }
                    if (/^번호\s*성명/.test(line)) continue;

                    if (!currentEvent) continue;

                    // ──────── 릴레이 모드 ────────
                    if (relayMode) {
                        // R-A: "4   129김이겸    전곡고등학교" (공백 분리)
                        const rA = line.match(/^([1-9])\s+\d{1,3}\s*[가-힣]{2,4}\s+(.+)$/);
                        if (rA) {
                            relayCurrentLane = parseInt(rA[1]);
                            const team = rA[2].trim();
                            rosterEntries.push({
                                competition_id: parseInt(competition_id), day: dayNum,
                                event_name: currentEvent, round: currentRound,
                                division: pageDiv.division, gender: pageDiv.gender,
                                bib_number: '', athlete_name: '', team,
                                sort_order: sortOrder++, heat: null, lane: relayCurrentLane,
                            });
                            lastEntryIdx = rosterEntries.length - 1;
                            continue;
                        }
                        // R-B: "4614민지현화성시청" (붙음, 첫 행)
                        const rB = line.match(/^(\d+)([가-힣].+)$/);
                        if (rB) {
                            const digits = rB[1];
                            const rest = rB[2];
                            const nt = parseNameTeam(rest);
                            if (nt.team && hasTeamKeyword(nt.team)) {
                                relayCurrentLane = parseInt(digits[0]);
                                rosterEntries.push({
                                    competition_id: parseInt(competition_id), day: dayNum,
                                    event_name: currentEvent, round: currentRound,
                                    division: pageDiv.division, gender: pageDiv.gender,
                                    bib_number: '', athlete_name: '', team: nt.team,
                                    sort_order: sortOrder++, heat: null, lane: relayCurrentLane,
                                });
                                lastEntryIdx = rosterEntries.length - 1;
                                continue;
                            }
                            // 후속 멤버 행 (이름만, 팀 키워드 없음) → 스킵
                            continue;
                        }
                        // 한글만 있는 라인 — 직전 entry 의 team 보강
                        if (/^[가-힣A-Za-z_()（）\s]+$/.test(line) && lastEntryIdx >= 0
                            && rosterEntries[lastEntryIdx] && !rosterEntries[lastEntryIdx].team
                            && hasTeamKeyword(line)) {
                            rosterEntries[lastEntryIdx].team = line.trim();
                            continue;
                        }
                        continue;
                    }
                    // ──────── 일반 모드 ────────

                    let lane = null, bib = '', namePart = '', teamPart = '';

                    // 패턴 A: "5   31양지은    학교" (공백 분리, 한자리 순)
                    const aMatch = line.match(/^([1-9])\s+(\d{1,3})\s*([가-힣]{2,4})(?:\s{2,}(.+))?\s*$/);
                    if (aMatch) {
                        lane = parseInt(aMatch[1]);
                        bib = aMatch[2];
                        namePart = aMatch[3];
                        teamPart = (aMatch[4] || '').trim();
                    } else {
                        // 패턴 A2: "10  149김인혜    학교" (공백 분리, 두자리 순)
                        const aMatch2 = line.match(/^(\d{1,2})\s{2,}(\d{1,3})\s*([가-힣]{2,4})(?:\s{2,}(.+))?\s*$/);
                        if (aMatch2) {
                            lane = parseInt(aMatch2[1]);
                            bib = aMatch2[2];
                            namePart = aMatch2[3];
                            teamPart = (aMatch2[4] || '').trim();
                        } else {
                            // 패턴 C/D (붙음)
                            const m = line.match(/^(\d+)([가-힣].+)$/);
                            if (m) {
                                const digits = m[1];
                                const rest = m[2];
                                if (noSeqMode) {
                                    // 순 없는 페이지: 첫 한자리=레인, 나머지=배번
                                    lane = parseInt(digits[0]);
                                    bib = digits.substring(1);
                                } else {
                                    const expectedSeq = lastSeq + 1;
                                    const split = splitSeqAndBib(digits, expectedSeq);
                                    lane = split.seq;
                                    bib = split.bib;
                                }
                                const nt = parseNameTeam(rest);
                                namePart = nt.name;
                                teamPart = nt.team;
                            }
                        }
                    }

                    // 유효성 검증
                    const bibNum = parseInt(bib);
                    if (!namePart || namePart.length < 2 || !bibNum || bibNum <= 0 || bibNum >= 10000) {
                        // 직전 entry 의 소속 보강
                        if (/^[가-힣A-Za-z_()（）]/.test(line) && lastEntryIdx >= 0
                            && rosterEntries[lastEntryIdx] && !rosterEntries[lastEntryIdx].team
                            && !line.startsWith('▣')
                            && !/^(순|레인|번호|성명|소속)/.test(line)) {
                            rosterEntries[lastEntryIdx].team = line;
                        }
                        continue;
                    }

                    // 레인 저장 조건: heat 또는 laneHeader 가 보였을 때만
                    const laneToStore = (currentHeat || laneHeaderSeen) ? lane : null;

                    rosterEntries.push({
                        competition_id: parseInt(competition_id), day: dayNum,
                        event_name: currentEvent, round: currentRound,
                        division: pageDiv.division, gender: pageDiv.gender,
                        bib_number: bib, athlete_name: namePart, team: teamPart,
                        sort_order: sortOrder++, heat: currentHeat, lane: laneToStore,
                    });
                    lastEntryIdx = rosterEntries.length - 1;

                    if (typeof lane === 'number' && lane > 0 && lane === lastSeq + 1) {
                        lastSeq = lane;
                    } else if (typeof lane === 'number' && lane > lastSeq && !noSeqMode) {
                        lastSeq = lane;
                    }
                }
            }

            // ── 모든 섹션 파싱 ──
            for (const sec of sections) {
                const effDiv = (sec.div && sec.div.division)
                    ? sec.div
                    : (hintFallback || { gender: '', division: '' });
                parseSection(sec.lines, effDiv);
            }

            // ── 혼성경기(10종/7종) 통합 dedup ──
            //   event_name 또는 round 에 "(N종)"이 들어가면 → "N종경기" 단일 종목으로 통합
            //   같은 (division, gender, athlete_name, team, N) 키로 첫 등장만 유지
            function combinedEventName(eventName, round) {
                const text = `${eventName || ''} ${round || ''}`;
                const m = text.match(/(\d+)\s*종/);
                if (m) return `${m[1]}종경기`;
                return null;
            }
            const dedupedEntries = [];
            const combinedSeen = new Set();
            for (const e of rosterEntries) {
                const cn = combinedEventName(e.event_name, e.round);
                if (cn) {
                    const key = `${e.division}|${e.gender}|${e.athlete_name}|${e.team}|${cn}`;
                    if (combinedSeen.has(key)) continue;
                    combinedSeen.add(key);
                    dedupedEntries.push({
                        ...e,
                        event_name: cn,
                        round: '결승',
                        heat: null,
                        lane: null,
                    });
                } else {
                    dedupedEntries.push(e);
                }
            }
            rosterEntries.length = 0;
            for (const e of dedupedEntries) rosterEntries.push(e);

            // ⚠️ 부분 교체: 이번 PDF에 들어있는 (부·성별·종목) 조합만 삭제 후 재삽입.
            //   예전엔 day 전체를 지워서, 같은 날 코리아오픈 PDF → 초중고 PDF 순으로 올리면
            //   먼저 올린 명단(예: 코리아오픈 100m)이 통째로 사라졌음.
            //   이제 다른 부/종목(다른 PDF)은 보존되고, 같은 PDF 재업로드만 해당 종목을 갱신.
            const delKeys = new Map();
            for (const e of rosterEntries) {
                const k = `${e.division || ''}${e.gender || ''}${e.event_name || ''}`;
                if (!delKeys.has(k)) delKeys.set(k, { division: e.division || '', gender: e.gender || '', event_name: e.event_name || '' });
            }

            // Insert parsed roster (해당 부·성별·종목만 교체)
            await db.transaction(async () => {
                for (const { division, gender, event_name } of delKeys.values()) {
                    await db.run('DELETE FROM display_roster WHERE competition_id=? AND day=? AND division=? AND gender=? AND event_name=?',
                        parseInt(competition_id), dayNum, division, gender, event_name);
                }
                for (const e of rosterEntries) {
                    await db.run('INSERT INTO display_roster (competition_id, day, event_name, round, division, gender, bib_number, athlete_name, team, sort_order, heat, lane) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
                        e.competition_id, e.day, e.event_name, e.round, e.division, e.gender, e.bib_number, e.athlete_name, e.team, e.sort_order, e.heat || null, e.lane || null);
                }
            })();

            // Auto-match roster to events
            try { await autoMatchDisplayRoster(parseInt(competition_id)); } catch(e) { console.warn('Roster auto-match warning:', e.message); }

            try { fs.unlinkSync(req.file.path); } catch(e) {}
            opLog(`노출용 명단 업로드 (${dayNum}일차, ${rosterEntries.length}명)`, 'admin', 'admin', parseInt(competition_id));
            res.json({ success: true, count: rosterEntries.length, day: dayNum, message: `${dayNum}일차 명단 ${rosterEntries.length}명 등록됨` });
        }).catch(err => {
            try { fs.unlinkSync(req.file.path); } catch(e) {}
            res.status(500).json({ error: 'PDF 파싱 실패: ' + err.message });
        });
    } catch(e) {
        console.error('Roster upload error:', e);
        try { if (req.file) fs.unlinkSync(req.file.path); } catch(ex) {}
        res.status(500).json({ error: '명단 업로드 실패: ' + e.message });
    }
});

// ============================================================
// Excel 명단 업로드 (결정적 컬럼 매핑 — PDF 추측 매칭 대안)
// ============================================================
// PDF 추측 파싱이 엣지 케이스에서 계속 실패하므로, 사용자가 PDF→Excel 변환본을
// 직접 검수/수정한 후 업로드하는 워크플로를 지원한다.
//
// 기대 컬럼(헤더 한글 또는 영문 모두 허용):
//   일차/day, 종목/event_name, 라운드/round, 라운드타입/round_type,
//   조/heat, 레인/lane, 배번/bib_number, 성명/athlete_name,
//   소속/team, 부/division, 성별/gender
//
// 동작:
//   ① day 별로 기존 display_roster를 삭제 후 새로 INSERT
//   ② 업로드 직후 autoMatchDisplayRoster 호출 (시간표 events와 매칭)
//   ③ 매칭이 안 된 행은 관리 페이지에서 "수동 매칭"으로 직접 지정 가능
app.post('/api/display/roster/upload-excel', upload.single('file'), async (req, res) => {
    try {
        const { competition_id, admin_key } = req.body;
        if (!competition_id) return res.status(400).json({ error: 'competition_id required' });
        if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
        if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });

        const comp = await db.get('SELECT * FROM competition WHERE id=?', parseInt(competition_id));
        if (!comp) { try { fs.unlinkSync(req.file.path); } catch(e) {} return res.status(404).json({ error: '대회를 찾을 수 없습니다.' }); }

        const wb = XLSX.readFile(req.file.path);
        // 우선순위: '명단' 시트 > 첫번째 시트
        const sheetName = wb.SheetNames.find(s => s === '명단' || s === 'roster') || wb.SheetNames[0];
        const ws = wb.Sheets[sheetName];
        if (!ws) { try { fs.unlinkSync(req.file.path); } catch(e) {} return res.status(400).json({ error: '시트가 비어있습니다.' }); }

        const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        if (data.length < 2) { try { fs.unlinkSync(req.file.path); } catch(e) {} return res.status(400).json({ error: '데이터 행이 없습니다.' }); }

        // 헤더 매핑 (한/영 모두 지원)
        const headerRow = data[0].map(c => String(c || '').trim());
        function findCol(...names) {
            for (const n of names) {
                const idx = headerRow.findIndex(h => h === n);
                if (idx >= 0) return idx;
            }
            return -1;
        }
        const colIdx = {
            day: findCol('일차', 'day'),
            event_name: findCol('종목', 'event_name', 'event'),
            round: findCol('라운드', 'round'),
            round_type: findCol('라운드타입', 'round_type'),
            heat: findCol('조', 'heat'),
            lane: findCol('레인', 'lane'),
            bib_number: findCol('배번', 'bib_number', 'bib'),
            athlete_name: findCol('성명', 'athlete_name', 'name'),
            team: findCol('소속', 'team'),
            division: findCol('부', 'division'),
            gender: findCol('성별', 'gender'),
        };

        if (colIdx.event_name < 0 || colIdx.athlete_name < 0) {
            try { fs.unlinkSync(req.file.path); } catch(e) {}
            return res.status(400).json({ error: '필수 컬럼(종목/성명)이 없습니다. README 시트의 양식을 참고하세요.' });
        }

        // 행 파싱 (정규화는 normalizeDivisionLabel 한 번만 거침)
        function gNorm(g) {
            const s = String(g || '').trim().toUpperCase();
            if (s === 'M' || s === '남' || s === '남자') return 'M';
            if (s === 'F' || s === '여' || s === '여자') return 'F';
            if (s === 'X' || s === '혼' || s === '혼성' || s === 'MIX') return 'X';
            return '';
        }

        const entries = [];
        const daysSeen = new Set();
        for (let i = 1; i < data.length; i++) {
            const row = data[i] || [];
            const evName = String(row[colIdx.event_name] || '').trim();
            const athName = String(row[colIdx.athlete_name] || '').trim();
            if (!evName || !athName) continue; // skip empty rows

            const dayRaw = colIdx.day >= 0 ? row[colIdx.day] : 1;
            const dayNum = parseInt(dayRaw) || 1;
            daysSeen.add(dayNum);

            const round = colIdx.round >= 0 ? String(row[colIdx.round] || '').trim() : '';
            const heatRaw = colIdx.heat >= 0 ? row[colIdx.heat] : '';
            const laneRaw = colIdx.lane >= 0 ? row[colIdx.lane] : '';
            const bib = colIdx.bib_number >= 0 ? String(row[colIdx.bib_number] || '').trim() : '';
            const team = colIdx.team >= 0 ? String(row[colIdx.team] || '').trim() : '';
            const divRaw = colIdx.division >= 0 ? String(row[colIdx.division] || '').trim() : '';
            const genderRaw = colIdx.gender >= 0 ? row[colIdx.gender] : '';

            entries.push({
                competition_id: parseInt(competition_id),
                day: dayNum,
                event_name: evName,
                round: round,
                division: normalizeDivisionLabel(divRaw),
                gender: gNorm(genderRaw),
                bib_number: bib,
                athlete_name: athName,
                team: team,
                sort_order: entries.length,
                heat: heatRaw === '' || heatRaw === null ? null : (parseInt(heatRaw) || null),
                lane: laneRaw === '' || laneRaw === null ? null : (parseInt(laneRaw) || null),
            });
        }

        if (entries.length === 0) {
            try { fs.unlinkSync(req.file.path); } catch(e) {}
            return res.status(400).json({ error: '유효한 명단 행이 없습니다.' });
        }

        // 트랜잭션: (일차·부·성별·종목) 단위로만 교체 후 INSERT
        //   day 전체를 지우면 다른 PDF/엑셀로 올린 다른 부·종목이 사라지므로 부분 교체.
        const delKeysX = new Map();
        for (const e of entries) {
            const k = `${e.day}${e.division || ''}${e.gender || ''}${e.event_name || ''}`;
            if (!delKeysX.has(k)) delKeysX.set(k, { day: e.day, division: e.division || '', gender: e.gender || '', event_name: e.event_name || '' });
        }
        await db.transaction(async () => {
            for (const { day, division, gender, event_name } of delKeysX.values()) {
                await db.run('DELETE FROM display_roster WHERE competition_id=? AND day=? AND division=? AND gender=? AND event_name=?',
                    parseInt(competition_id), day, division, gender, event_name);
            }
            for (const e of entries) {
                await db.run('INSERT INTO display_roster (competition_id, day, event_name, round, division, gender, bib_number, athlete_name, team, sort_order, heat, lane) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
                    e.competition_id, e.day, e.event_name, e.round, e.division, e.gender, e.bib_number, e.athlete_name, e.team, e.sort_order, e.heat, e.lane);
            }
        })();

        // Auto-match
        try { await autoMatchDisplayRoster(parseInt(competition_id)); } catch(e) { console.warn('Roster auto-match warning:', e.message); }

        try { fs.unlinkSync(req.file.path); } catch(e) {}
        opLog(`노출용 명단 Excel 업로드 (일차 ${[...daysSeen].sort().join(',')}, ${entries.length}명)`, 'admin', 'admin', parseInt(competition_id));
        res.json({ success: true, count: entries.length, days: [...daysSeen].sort(), message: `Excel 명단 ${entries.length}명 등록됨` });
    } catch(e) {
        console.error('Roster Excel upload error:', e);
        try { if (req.file) fs.unlinkSync(req.file.path); } catch(ex) {}
        res.status(500).json({ error: 'Excel 명단 업로드 실패: ' + e.message });
    }
});

// ============================================================
// 명단 매칭 수동 수정 API
// ============================================================
//   ① GET  /api/display/roster/list/:compId          — 명단 행 목록 (필터 가능)
//   ② GET  /api/display/roster/events/:compId        — 매칭 후보 event 목록
//   ③ POST /api/display/roster/assign                — 단건 event_id 변경
//   ④ POST /api/display/roster/assign-bulk           — 다건 동시 변경 (그룹 단위)
//   ⑤ POST /api/display/roster/clear-event/:rosterId — event_id를 NULL로 (미매칭으로 되돌림)
app.get('/api/display/roster/list/:compId', async (req, res) => {
    try {
        const compId = parseInt(req.params.compId);
        const { day, only_unmatched, event_id } = req.query;
        let sql = `SELECT r.id, r.day, r.event_name, r.round, r.division, r.gender, r.bib_number,
                          r.athlete_name, r.team, r.heat, r.lane, r.event_id,
                          e.name AS matched_event_name, e.gender AS matched_event_gender,
                          e.division AS matched_event_division, e.round_type AS matched_event_round
                   FROM display_roster r
                   LEFT JOIN event e ON e.id = r.event_id
                   WHERE r.competition_id=?`;
        const args = [compId];
        if (day) { sql += ' AND r.day=?'; args.push(parseInt(day)); }
        if (only_unmatched === '1' || only_unmatched === 'true') sql += ' AND r.event_id IS NULL';
        if (event_id) { sql += ' AND r.event_id=?'; args.push(parseInt(event_id)); }
        sql += ' ORDER BY r.day, r.event_name, r.round, r.heat, r.lane, r.sort_order';
        const rows = await db.all(sql, ...args);
        res.json({ success: true, rows, total: rows.length });
    } catch(e) {
        console.error('roster/list error:', e);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/display/roster/events/:compId', async (req, res) => {
    try {
        const compId = parseInt(req.params.compId);
        const events = await db.all(`SELECT id, name, gender, division, round_type, category
             FROM event WHERE competition_id=?
             ORDER BY name, division, gender, round_type`, compId);
        res.json({ success: true, events });
    } catch(e) {
        console.error('roster/events error:', e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/display/roster/assign', async (req, res) => {
    try {
        const { admin_key, roster_id, event_id } = req.body;
        if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
        if (!roster_id) return res.status(400).json({ error: 'roster_id required' });
        const evId = event_id ? parseInt(event_id) : null;
        if (evId) {
            const ev = await db.get('SELECT id FROM event WHERE id=?', evId);
            if (!ev) return res.status(404).json({ error: '해당 종목이 존재하지 않습니다.' });
        }
        await db.run('UPDATE display_roster SET event_id=? WHERE id=?', evId, parseInt(roster_id));
        res.json({ success: true });
    } catch(e) {
        console.error('roster/assign error:', e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/display/roster/assign-bulk', async (req, res) => {
    try {
        const { admin_key, competition_id, filter, event_id } = req.body;
        if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
        if (!competition_id) return res.status(400).json({ error: 'competition_id required' });
        const evId = event_id ? parseInt(event_id) : null;
        if (evId) {
            const ev = await db.get('SELECT id FROM event WHERE id=?', evId);
            if (!ev) return res.status(404).json({ error: '해당 종목이 존재하지 않습니다.' });
        }
        // filter: { event_name, division, gender, round, day }
        const f = filter || {};
        let sql = 'UPDATE display_roster SET event_id=? WHERE competition_id=?';
        const args = [evId, parseInt(competition_id)];
        if (f.event_name) { sql += ' AND event_name=?'; args.push(f.event_name); }
        if (f.division !== undefined) { sql += ' AND division=?'; args.push(f.division || ''); }
        if (f.gender !== undefined) { sql += ' AND gender=?'; args.push(f.gender || ''); }
        if (f.round !== undefined) { sql += ' AND round=?'; args.push(f.round || ''); }
        if (f.day) { sql += ' AND day=?'; args.push(parseInt(f.day)); }
        const info = await db.run(sql, ...args);
        res.json({ success: true, updated: info.changes });
    } catch(e) {
        console.error('roster/assign-bulk error:', e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/display/roster/clear-event/:rosterId', async (req, res) => {
    try {
        const { admin_key } = req.body;
        if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
        await db.run('UPDATE display_roster SET event_id=NULL WHERE id=?', parseInt(req.params.rosterId));
        res.json({ success: true });
    } catch(e) {
        console.error('roster/clear-event error:', e);
        res.status(500).json({ error: e.message });
    }
});

// Auto-match roster entries to events
//
// 매칭 정책 (2026-05 재작성):
//   ① division/gender/round_type 정규화는 시간표·명단 양쪽이 동일 헬퍼를 사용 → 표기 차이로 인한
//      어긋남을 사전 차단 (parseDisplayRound + normalizeDivisionLabel)
//   ② 종합 sub-event(10종/7종)는 부모 이벤트(10종경기/7종경기)에만 연결.
//      · 부모 매칭 실패 시: division 표기 fallback만 시도, 절대 일반 종목으로 흘러가지 않음.
//      · 후보 부모 이름: "10종경기", "10종경기(남)", "남자10종경기", "육상10종경기" 등 다양한 표기 허용.
//   ③ 일반 종목: name + gender + division + round_type 4개 모두 일치할 때만 strict 매칭.
//      · Strict 실패 시 fallback은 "division/gender 표기를 normalize한 다음에 비교" 만 허용.
//        절대로 division 또는 gender 자체를 무시하지 않음 (이전 버그의 직접 원인).
//      · round_type 표기 차이가 있으면 양쪽 다시 parseDisplayRound로 정규화한 후 비교.
//   ④ gender가 비어있는 명단(혼성) → ev.gender ∈ {X, ''} 중 하나와 매칭.
//   ⑤ 매칭이 안 되면 그냥 둠. 잘못된 매칭보다 미매칭이 안전.
async function autoMatchDisplayRoster(compId) {
    const events = await db.all('SELECT id, name, gender, division, round_type FROM event WHERE competition_id=?', compId);
    const unmatched = await db.all('SELECT id, event_name, round, division, gender FROM display_roster WHERE competition_id=? AND event_id IS NULL', compId);
    const UPD_RM_SQL = 'UPDATE display_roster SET event_id=? WHERE id=?';

    // ── 정규화 헬퍼 ──
    function nameNorm(s) {
        if (!s) return '';
        let n = s.replace(/\s+/g, '');
        // 종합경기 접미사 정규화: "10종경기", "100m(10종)" 등에서 (10종)/(7종) 제거
        n = n.replace(/\((\d+종)\)$/, '');
        // 성별 접미사 제거: "10종경기(남)" / "10종경기 남자" 등의 변형
        n = n.replace(/\((남|여|혼|남자|여자|혼성)\)$/, '');
        n = n.replace(/(남자|여자|혼성)$/, '');
        // 앞 접두어 제거: "남자10종경기", "여자7종경기"
        n = n.replace(/^(남자|여자|혼성)/, '');
        // "육상" prefix 제거
        n = n.replace(/^육상/, '');
        return n.toLowerCase();
    }

    function divNorm(d) { return normalizeDivisionLabel(d || ''); }

    function genderEq(a, b) {
        const A = (a || '').trim();
        const B = (b || '').trim();
        if (A === B) return true;
        // 혼성: '' / 'X' / undefined 모두 동일 취급
        const isWild = (g) => !g || g === 'X' || g === '혼' || g === '혼성';
        if (isWild(A) && isWild(B)) return true;
        return false;
    }

    function roundEq(rosterRoundRaw, eventRoundType) {
        // event.round_type은 시간표 import 시 이미 parseDisplayRound로 만든 값(preliminary/semifinal/final)
        // 명단의 round 원문(rosterRoundRaw)은 매칭 시점에 한 번 더 parseDisplayRound로 정규화
        const r = parseDisplayRound(rosterRoundRaw);
        return r.round_type === (eventRoundType || 'final');
    }

    // 종합경기 부모 이벤트 후보 매칭: ev.name의 nameNorm 결과가 "Nx종경기"와 일치하면 OK
    function isCombinedParent(evName, n) {
        const norm = nameNorm(evName);
        return norm === `${n}종경기`;
    }

    let matched = 0;
    let combinedMatched = 0;
    let strictMatched = 0;
    let fallbackMatched = 0;
    let stillUnmatched = 0;

    for (const re of unmatched) {
        const parsed = parseDisplayRound(re.round || '');
        const isCombined = parsed.is_combined;
        const rosterDiv = divNorm(re.division);
        const rosterEvName = nameNorm(re.event_name);

        let match = null;

        // ── (A) 종합 sub-event: 부모 이벤트 매칭 ──
        if (isCombined && parsed.combined_n) {
            const n = parsed.combined_n;
            // (A-1) strict: 부모 + 동일 division + 동일 gender
            match = events.find(ev =>
                isCombinedParent(ev.name, n) &&
                divNorm(ev.division) === rosterDiv &&
                genderEq(ev.gender, re.gender)
            );
            // (A-2) fallback: division 표기가 살짝 다를 가능성 — gender만으로
            //        단, division 둘 다 비어있지 않은 경우엔 division 일치 강제 (잘못 붙는 것 방지)
            if (!match && !rosterDiv) {
                match = events.find(ev =>
                    isCombinedParent(ev.name, n) &&
                    genderEq(ev.gender, re.gender)
                );
            }
            // 종합 sub-event는 일반 종목으로 절대 흘러가지 않음 — 여기서 종료
            if (match) { await db.run(UPD_RM_SQL, match.id, re.id); matched++; combinedMatched++; }
            else stillUnmatched++;
            continue;
        }

        // ── (B) 일반 종목 strict 매칭: name + gender + division + round_type 모두 일치 ──
        match = events.find(ev =>
            nameNorm(ev.name) === rosterEvName &&
            divNorm(ev.division) === rosterDiv &&
            genderEq(ev.gender, re.gender) &&
            roundEq(re.round, ev.round_type)
        );
        if (match) { await db.run(UPD_RM_SQL, match.id, re.id); matched++; strictMatched++; continue; }

        // ── (C) Fallback 1: division 표기 차이 흡수 (양쪽 모두 normalize 후 비교)
        //        ※ rosterDiv가 빈 문자열일 때만 division 비교를 생략. 그렇지 않으면 division mismatch는 절대 매칭 X.
        if (rosterDiv === '') {
            match = events.find(ev =>
                nameNorm(ev.name) === rosterEvName &&
                genderEq(ev.gender, re.gender) &&
                roundEq(re.round, ev.round_type)
            );
            if (match) { await db.run(UPD_RM_SQL, match.id, re.id); matched++; fallbackMatched++; continue; }
        }

        // ── (D) Fallback 2: round_type만 'final' 가정한 매칭 (예선만 있고 결승 event가 없는 케이스 대비)
        //        예: 1500m 결승만 시간표에 있고 명단도 결승 → strict에서 잡혀야 하지만, round_type이
        //            엉뚱하게 들어간 레거시 데이터를 위해 round_type 비교를 한 번 더 느슨하게.
        //        단, 반드시 division + gender는 일치해야 함.
        match = events.find(ev =>
            nameNorm(ev.name) === rosterEvName &&
            divNorm(ev.division) === rosterDiv &&
            genderEq(ev.gender, re.gender)
        );
        if (match) { await db.run(UPD_RM_SQL, match.id, re.id); matched++; fallbackMatched++; continue; }

        stillUnmatched++;
    }

    if (matched > 0 || stillUnmatched > 0) {
        console.log(`[autoMatchDisplayRoster] comp=${compId}: matched=${matched} (strict=${strictMatched}, combined=${combinedMatched}, fallback=${fallbackMatched}), unmatched=${stillUnmatched}`);
    }
    return matched;
}

// Get display roster for a competition
app.get('/api/display/roster/:compId', async (req, res) => {
    const { event_id, day } = req.query;
    let sql = 'SELECT * FROM display_roster WHERE competition_id=?';
    const params = [req.params.compId];
    if (event_id) { sql += ' AND event_id=?'; params.push(event_id); }
    if (day) { sql += ' AND day=?'; params.push(parseInt(day)); }
    sql += ' ORDER BY event_name, sort_order';
    res.json(await db.all(sql, ...params));
});

// Get display events for a competition (with roster counts)
app.get('/api/display/events/:compId', async (req, res) => {
    const events = await db.all(`
        SELECT e.*, 
            (SELECT COUNT(*) FROM display_roster dr WHERE dr.event_id = e.id) as roster_count
        FROM event e 
        WHERE e.competition_id=? AND e.parent_event_id IS NULL
        ORDER BY e.division, e.sort_order, e.name
    `, req.params.compId);
    res.json(events);
});

// Update event result_url
app.put('/api/display/events/:id/result-url', async (req, res) => {
    const { admin_key, result_url } = req.body;
    if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
    await db.run('UPDATE event SET result_url=? WHERE id=?', result_url || '', req.params.id);
    res.json({ success: true });
});

// /api/display/events/bulk-result-url removed — was never called from any client.
// Use single PUT /api/display/events/:id/result-url instead.

// Get matching status overview
app.get('/api/display/match-status/:compId', async (req, res) => {
    const events = await db.all(`
        SELECT e.id, e.name, e.gender, e.division, e.round_type, e.result_url,
            (SELECT COUNT(*) FROM display_roster dr WHERE dr.event_id = e.id) as roster_count,
            (SELECT COUNT(*) FROM timetable tt WHERE tt.event_id = e.id AND tt.competition_id = e.competition_id) as timetable_count
        FROM event e
        WHERE e.competition_id=? AND e.parent_event_id IS NULL
        ORDER BY e.division, e.name, e.round_type
    `, req.params.compId);
    res.json(events);
});

// Manual match roster to event
app.post('/api/display/roster/match', async (req, res) => {
    const { admin_key, roster_ids, event_id } = req.body;
    if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
    if (!Array.isArray(roster_ids) || !event_id) return res.status(400).json({ error: 'roster_ids and event_id required' });
    await db.transaction(async () => {
        for (const rid of roster_ids) {
            await db.run('UPDATE display_roster SET event_id=? WHERE id=?', event_id, rid);
        }
    })();
    res.json({ success: true, count: roster_ids.length });
});

// Re-run auto-matching for roster
app.post('/api/display/roster/:compId/rematch', async (req, res) => {
    const { admin_key } = req.body;
    if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
    await db.run('UPDATE display_roster SET event_id=NULL WHERE competition_id=?', req.params.compId);
    const matched = await autoMatchDisplayRoster(parseInt(req.params.compId));
    res.json({ success: true, matched });
});

// Delete display roster for a specific day
app.delete('/api/display/roster/:compId/:day', async (req, res) => {
    const { admin_key } = req.body;
    if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
    await db.run('DELETE FROM display_roster WHERE competition_id=? AND day=?', req.params.compId, parseInt(req.params.day));
    res.json({ success: true });
});

// ─── 미지정(division 빈 값) 종목 일괄 정리 API ───
// GET  /api/display/cleanup-undefined/:compId  — 미리보기 (dry-run)
// POST /api/display/cleanup-undefined/:compId  — 실제 정리 실행
//
// 동작:
//   1) division이 비어있고 gender='X'가 아닌 종목들을 찾는다 (= "미지정" 종목)
//   2) 각각에 대해 같은 (name, gender, round_type)을 가지면서 division이 채워진 동일 종목이 있는지 확인
//   3) 흡수 가능: 미지정 종목에 연결된 timetable.event_id, display_roster.event_id를 흡수 대상에 재연결 후 미지정 종목 삭제
//   4) 흡수 불가능 (동일 종목 없음): 단순 삭제 (timetable.event_id NULL로 끊고 display_roster도 NULL로 끊음)
async function _findUndefinedEvents(compId) {
    return await db.all(`
        SELECT id, name, gender, division, round_type, category, sort_order
        FROM event
        WHERE competition_id=?
          AND (division IS NULL OR division='')
          AND gender != 'X'
          AND parent_event_id IS NULL
    `, compId);
}
async function _planCleanupUndefined(compId) {
    const undefinedEvents = await _findUndefinedEvents(compId);
    const allEvents = await db.all(`
        SELECT id, name, gender, division, round_type
        FROM event
        WHERE competition_id=? AND parent_event_id IS NULL
    `, compId);
    const plan = [];
    for (const u of undefinedEvents) {
        // 같은 name + gender + round_type, division이 채워진 후보 찾기
        const candidates = allEvents.filter(e =>
            e.id !== u.id &&
            e.name === u.name &&
            e.gender === u.gender &&
            e.round_type === u.round_type &&
            e.division && e.division.trim()
        );
        // 가장 우선순위 높은 후보(초등→중등→고등→U18→U20→대학→일반→선수권→국제 순) 선택
        const order = ['초등부','중등부','고등부','U18','U20','대학부','일반부','선수권','국제'];
        candidates.sort((a, b) => {
            const ai = order.indexOf(a.division);
            const bi = order.indexOf(b.division);
            return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
        });
        const ttRow = await db.get('SELECT COUNT(*) AS c FROM timetable WHERE event_id=?', u.id);
        const rosterRow = await db.get('SELECT COUNT(*) AS c FROM display_roster WHERE event_id=?', u.id);
        const ttCnt = ttRow ? ttRow.c : 0;
        const rosterCnt = rosterRow ? rosterRow.c : 0;
        if (candidates.length === 1) {
            // 후보가 1개뿐이면 자동 흡수
            plan.push({
                action: 'merge',
                undefined_event: u,
                target_event: candidates[0],
                timetable_count: ttCnt,
                roster_count: rosterCnt,
                note: `1개 후보 → 자동 흡수`
            });
        } else if (candidates.length > 1) {
            // 후보가 여러 개면 사용자 결정 필요 → 일단 삭제 후보로 보고 (timetable/roster 끊기)
            plan.push({
                action: 'orphan',
                undefined_event: u,
                candidates,
                timetable_count: ttCnt,
                roster_count: rosterCnt,
                note: `${candidates.length}개 후보 존재 → 수동 선택 필요`
            });
        } else {
            // 후보가 없으면 단순 삭제
            plan.push({
                action: 'delete',
                undefined_event: u,
                timetable_count: ttCnt,
                roster_count: rosterCnt,
                note: `흡수 대상 없음 → 단순 삭제`
            });
        }
    }
    return plan;
}
app.get('/api/display/cleanup-undefined/:compId', async (req, res) => {
    const { admin_key } = req.query;
    if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
    const plan = await _planCleanupUndefined(parseInt(req.params.compId));
    res.json({
        success: true,
        total: plan.length,
        merge_count: plan.filter(p => p.action === 'merge').length,
        delete_count: plan.filter(p => p.action === 'delete').length,
        orphan_count: plan.filter(p => p.action === 'orphan').length,
        plan
    });
});
app.post('/api/display/cleanup-undefined/:compId', async (req, res) => {
    const { admin_key, mode } = req.body;
    // mode: 'auto' (merge+delete만 자동 처리, orphan 제외) | 'force_delete' (orphan도 삭제)
    if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
    const compId = parseInt(req.params.compId);
    const plan = await _planCleanupUndefined(compId);
    let merged = 0, deleted = 0, skipped = 0;
    await db.transaction(async () => {
        for (const p of plan) {
            if (p.action === 'merge') {
                // timetable / display_roster 의 event_id 재연결
                await db.run('UPDATE timetable SET event_id=? WHERE event_id=?', p.target_event.id, p.undefined_event.id);
                await db.run('UPDATE display_roster SET event_id=? WHERE event_id=?', p.target_event.id, p.undefined_event.id);
                await db.run('DELETE FROM event WHERE id=?', p.undefined_event.id);
                merged++;
            } else if (p.action === 'delete') {
                await db.run('UPDATE timetable SET event_id=NULL WHERE event_id=?', p.undefined_event.id);
                await db.run('UPDATE display_roster SET event_id=NULL WHERE event_id=?', p.undefined_event.id);
                await db.run('DELETE FROM event WHERE id=?', p.undefined_event.id);
                deleted++;
            } else if (p.action === 'orphan') {
                if (mode === 'force_delete') {
                    await db.run('UPDATE timetable SET event_id=NULL WHERE event_id=?', p.undefined_event.id);
                    await db.run('UPDATE display_roster SET event_id=NULL WHERE event_id=?', p.undefined_event.id);
                    await db.run('DELETE FROM event WHERE id=?', p.undefined_event.id);
                    deleted++;
                } else {
                    skipped++;
                }
            }
        }
    })();
    opLog(`미지정 종목 정리 (병합 ${merged}, 삭제 ${deleted}, 스킵 ${skipped})`, 'admin', 'admin', compId);
    res.json({ success: true, merged, deleted, skipped, total: plan.length });
});

// ─── Display roster: 단일 행 CRUD (인라인 편집 / 릴레이 팀 편집) ───
// PUT  /api/display/roster/entry/:id  — 개별 행 수정
app.put('/api/display/roster/entry/:id', async (req, res) => {
    try {
        const { admin_key, day, event_name, round, division, gender, bib_number, athlete_name, team, heat, lane, sort_order, event_id } = req.body;
        if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
        const old = await db.get('SELECT * FROM display_roster WHERE id=?', req.params.id);
        if (!old) return res.status(404).json({ error: '명단 행을 찾을 수 없습니다.' });
        await db.run(`UPDATE display_roster SET
            day=?, event_name=?, round=?, division=?, gender=?,
            bib_number=?, athlete_name=?, team=?,
            heat=?, lane=?, sort_order=?, event_id=?
            WHERE id=?`, day != null ? parseInt(day) : old.day, event_name != null ? event_name : old.event_name, round != null ? round : old.round, division != null ? division : old.division, gender != null ? gender : old.gender, bib_number != null ? String(bib_number) : old.bib_number, athlete_name != null ? athlete_name : old.athlete_name, team != null ? team : old.team, heat != null && heat !== '' ? parseInt(heat) : null, lane != null && lane !== '' ? parseInt(lane) : null, sort_order != null ? parseInt(sort_order) : old.sort_order, event_id != null ? (event_id || null) : old.event_id, old.id);
        res.json({ success: true, id: old.id });
    } catch (e) {
        res.status(500).json({ error: '수정 실패: ' + e.message });
    }
});

// POST /api/display/roster/entry — 새 행 추가
app.post('/api/display/roster/entry', async (req, res) => {
    try {
        const { admin_key, competition_id, day, event_name, round, division, gender, bib_number, athlete_name, team, heat, lane, sort_order, event_id } = req.body;
        if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
        if (!competition_id || !athlete_name) return res.status(400).json({ error: 'competition_id, athlete_name 필수' });
        const info = await db.run(`INSERT INTO display_roster
            (competition_id, day, event_name, round, division, gender, bib_number, athlete_name, team, sort_order, event_id, heat, lane)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, parseInt(competition_id), parseInt(day) || 1, event_name || '', round || '', division || '', gender || '', bib_number != null ? String(bib_number) : '', athlete_name, team || '', sort_order != null ? parseInt(sort_order) : 0, event_id || null, heat != null && heat !== '' ? parseInt(heat) : null, lane != null && lane !== '' ? parseInt(lane) : null);
        // 자동 매칭 시도
        try { await autoMatchDisplayRoster(parseInt(competition_id)); } catch(e) {}
        res.json({ success: true, id: info.lastInsertRowid });
    } catch (e) {
        res.status(500).json({ error: '추가 실패: ' + e.message });
    }
});

// DELETE /api/display/roster/entry/:id — 개별 행 삭제
app.delete('/api/display/roster/entry/:id', async (req, res) => {
    try {
        const { admin_key } = req.body;
        if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
        const info = await db.run('DELETE FROM display_roster WHERE id=?', req.params.id);
        res.json({ success: true, deleted: info.changes });
    } catch (e) {
        res.status(500).json({ error: '삭제 실패: ' + e.message });
    }
});

// Serve display-manage page
app.get('/display-manage', (req, res) => {
    sendStampedHtml(res, 'display-manage.html');
});

// ============================================================
// BROADCAST OVERLAY — OBS/vMix HTML Overlay pages
// ============================================================
app.get('/overlay/scoreboard', (req, res) => {
    sendStampedHtml(res, 'overlay-scoreboard.html');
});
app.get('/overlay/lower-third', (req, res) => {
    sendStampedHtml(res, 'overlay-lower-third.html');
});

// Overlay data API — current live event data for overlay consumption
app.get('/api/overlay/current', async (req, res) => {
    const compId = req.query.competition_id;
    if (!compId) return res.status(400).json({ error: 'competition_id required' });

    // Find the currently active event (in_progress)
    const activeEvent = await db.get("SELECT * FROM event WHERE competition_id=? AND round_status='in_progress' AND parent_event_id IS NULL ORDER BY sort_order LIMIT 1", compId);
    if (!activeEvent) return res.json({ event: null, heat: null, entries: [] });

    const heat = await db.get('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number DESC LIMIT 1', activeEvent.id);
    if (!heat) return res.json({ event: activeEvent, heat: null, entries: [] });

    const entries = await db.all(`
        SELECT he.lane_number, ee.id AS event_entry_id, ee.status,
               a.name, a.bib_number, a.team, a.gender
        FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id
        JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=?
        ORDER BY he.lane_number ASC
    `, heat.id);

    const results = await db.all('SELECT * FROM result WHERE heat_id=?', heat.id);
    const comp = await db.get('SELECT * FROM competition WHERE id=?', compId);

    res.json({
        competition: comp,
        event: activeEvent,
        heat: heat,
        entries: entries.map(e => {
            const r = results.find(r => r.event_entry_id === e.event_entry_id && r.attempt_number === 1);
            return { ...e, record: r ? r.record : null, status_code: r ? r.status_code : null, remark: r ? r.remark : '' };
        })
    });
});

// ============================================================
// WEBSOCKET SCOREBOARD SERVER
// ============================================================
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });
const wsClients = new Set();

server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname === '/ws/scoreboard') {
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
        });
    } else {
        socket.destroy();
    }
});

// 죽은 연결 정리 — 30초마다 ping, 응답 없으면 끊는다 (예전엔 끊긴 태블릿·PC 의 소켓이 TCP 시간 초과까지 남아 전송 버퍼가 쌓였다)
if (require.main === module) setInterval(() => {
    wsClients.forEach(ws => {
        if (ws._alive === false) { try { ws.terminate(); } catch (e) {} wsClients.delete(ws); return; }
        ws._alive = false; try { ws.ping(); } catch (e) {}
    });
}, 30000).unref();

wss.on('connection', (ws) => {
    wsClients.add(ws);
    ws._alive = true;
    ws.on('pong', () => { ws._alive = true; });
    console.log(`[WS] Scoreboard client connected (total: ${wsClients.size})`);

    // Send initial state
    ws.send(JSON.stringify({ type: 'connected', timestamp: Date.now(), protocol: 'pacerise-scoreboard-v1' }));

    ws.on('message', async (msg) => {
        try {
            const data = JSON.parse(msg);
            // Handle client requests
            if (data.type === 'subscribe') {
                ws._compId = data.competition_id;
                ws.send(JSON.stringify({ type: 'subscribed', competition_id: data.competition_id }));
            }
            if (data.type === 'request_current') {
                await sendCurrentScoreboard(ws, data.competition_id);
            }
        } catch(e) {}
    });

    ws.on('close', () => {
        wsClients.delete(ws);
        console.log(`[WS] Scoreboard client disconnected (total: ${wsClients.size})`);
    });

    ws.on('error', () => { wsClients.delete(ws); });
});

function broadcastToScoreboard(eventType, data) {
    const msg = JSON.stringify({ type: eventType, data, timestamp: Date.now() });
    wsClients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
            // Only send to clients subscribed to this competition
            if (!ws._compId || !data.competition_id || ws._compId == data.competition_id) {
                try { ws.send(msg); } catch(e) {}
            }
        }
    });
}

// 전광판·방송 오버레이 현재 상태 (2026-09 점검으로 재작성)
//   예전엔 ① 마지막 조(heat_number DESC)를 보여줘 1조 경기 중에 빈 5조가 떴고 ② 거리 종목은 1차 시기 값으로 순위를 매겼으며
//   ③ 높이 종목(height_attempt)은 기록이 아예 안 나왔고 ④ 순위를 화면(오버레이)이 따로 계산해 동률·DQ 처리가 대시보드와 달랐다.
//   → 기록이 가장 최근에 들어온 조를 고르고, 종목별 기록 집계·순위를 서버가 공용 규칙(public/lib/ranking.js)으로 계산해 보낸다.
function _sbFormatTime(sec) {
    if (sec == null) return '';
    const r3 = Math.round(sec * 1000) / 1000, r2 = Math.round(sec * 100) / 100;
    const dp = Math.abs(r3 - r2) < 0.0001 ? 2 : 3;
    const pad = (v, d) => (v < 10 ? '0' : '') + v.toFixed(d);
    if (sec >= 3600) { const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), r = sec - h * 3600 - m * 60; return `${h}:${String(m).padStart(2, '0')}:${pad(r, dp)}`; }
    if (sec >= 60) { const m = Math.floor(sec / 60), r = sec - m * 60; return `${m}:${pad(r, dp)}`; }
    return sec.toFixed(dp);
}
async function _sbHeatEntries(heat, category, federation) {
    const R = require('./public/lib/ranking');
    const entries = await db.all(`
        SELECT he.lane_number, ee.id as event_entry_id, ee.status, ee.manual_rank, a.name, a.bib_number, a.team
        FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id
        JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=?
        ORDER BY he.lane_number ASC`, heat.id);
    const results = await db.all('SELECT * FROM result WHERE heat_id=?', heat.id);
    const attempts = category === 'field_height' ? await db.all('SELECT * FROM height_attempt WHERE heat_id=?', heat.id) : [];
    const out = entries.map(e => {
        const mine = results.filter(r => r.event_entry_id === e.event_entry_id);
        const st = (mine.find(r => r.attempt_number == null && r.status_code) || mine.find(r => r.status_code) || {}).status_code || (e.status === 'no_show' ? 'DNS' : '');
        const row = { ...e, federation, status_code: st, record: null, record_text: '', rank: null, best: null, sortedValid: [] };
        if (category === 'field_height') {
            const hs = R.heightStatsFromAttempts(attempts.filter(x => x.event_entry_id === e.event_entry_id));
            row.best = hs.best; row.failsAtBest = hs.failsAtBest; row.totalFails = hs.totalFails;
            if (hs.best != null) { row.record = hs.best; const m = Math.floor(hs.best); row.record_text = `${m}m${String(Math.round((hs.best - m) * 100)).padStart(2, '0')}`; }
            else if (!st && hs.isNM) row.status_code = 'NM';
        } else if (category === 'field_distance') {
            const ds = R.distanceStats(mine.filter(r => r.attempt_number != null).map(r => r.distance_meters));
            row.best = ds.best; row.sortedValid = ds.sortedValid;
            if (ds.best != null) { row.record = ds.best; row.record_text = ds.best.toFixed(2) + 'm'; }
        } else {
            const t = mine.map(r => r.time_seconds).filter(v => v != null && v > 0);
            if (t.length) { row.best = -Math.min(...t); row.record = Math.min(...t); row.record_text = _sbFormatTime(row.record); }
        }
        if (row.status_code) { row.best = null; }        // 실격·기권·결장은 기록이 있어도 순위 없음
        return row;
    });
    const cmp = category === 'field_height' ? R.compareHeight : category === 'field_distance' ? R.compareDistance : (x, y) => (y.best === x.best ? 0 : y.best - x.best);
    R.assignRanks(out, cmp);
    if (category === 'field_height') out.forEach(r => { if (r.best != null && r.manual_rank != null && r.manual_rank !== '') r.rank = Number(r.manual_rank); });
    return out.map(({ best, sortedValid, failsAtBest, totalFails, manual_rank, ...rest }) => rest);
}
async function sendCurrentScoreboard(ws, compId) {
    if (!compId) return;
    const activeEvent = await db.get("SELECT * FROM event WHERE competition_id=? AND round_status='in_progress' AND parent_event_id IS NULL ORDER BY sort_order LIMIT 1", compId);
    if (!activeEvent) {
        ws.send(JSON.stringify({ type: 'scoreboard_state', data: { event: null } }));
        return;
    }
    // 진행 중인 조 = 기록이 가장 최근에 들어온 조. 아직 기록이 없으면 1조
    const pickHeat = eventId => db.get(`SELECT h.* FROM heat h LEFT JOIN result r ON r.heat_id = h.id LEFT JOIN height_attempt ha ON ha.heat_id = h.id
        WHERE h.event_id = ? GROUP BY h.id ORDER BY (MAX(r.id) IS NULL AND MAX(ha.id) IS NULL) ASC, MAX(r.id) DESC, MAX(ha.id) DESC, h.heat_number ASC LIMIT 1`, eventId);
    const heat = await pickHeat(activeEvent.id);
    const totalHeatsRow = await db.get('SELECT COUNT(*) as cnt FROM heat WHERE event_id=?', activeEvent.id);
    const totalHeats = (totalHeatsRow && totalHeatsRow.cnt) || 0;
    const comp = await db.get('SELECT federation, name FROM competition WHERE id=?', compId);
    const primaryFed = (comp && (comp.federation || comp.name)) || '';
    let entries = heat ? await _sbHeatEntries(heat, activeEvent.category, primaryFed) : [];

    // 합동 종목 — 연결된 다른 대회 종목의 조를 합쳐 순위를 다시 매긴다
    const linkedEvents = await db.all(`
        SELECT CASE WHEN event_id_a = ? THEN event_id_b ELSE event_id_a END as linked_id
        FROM event_link WHERE event_id_a = ? OR event_id_b = ?`, activeEvent.id, activeEvent.id, activeEvent.id);
    for (const link of linkedEvents) {
        const linkedEvt = await db.get('SELECT e.*, c.federation, c.name as comp_name FROM event e JOIN competition c ON c.id=e.competition_id WHERE e.id=?', link.linked_id);
        if (!linkedEvt) continue;
        const linkedHeat = await pickHeat(link.linked_id);
        if (!linkedHeat) continue;
        entries = entries.concat(await _sbHeatEntries(linkedHeat, activeEvent.category, linkedEvt.federation || linkedEvt.comp_name || ''));
    }
    if (linkedEvents.length && entries.length) {
        // 합동: 두 조의 순위를 함께 — 기록(record) 기준으로 다시 매긴다 (동률은 같은 순위)
        const isTrack = !String(activeEvent.category || '').startsWith('field');
        const ranked = entries.filter(e => e.record != null && !e.status_code).sort((x, y) => isTrack ? x.record - y.record : y.record - x.record);
        ranked.forEach((e, i) => { e.rank = (i > 0 && ranked[i - 1].record === e.record) ? ranked[i - 1].rank : i + 1; });
    }

    ws.send(JSON.stringify({
        type: 'scoreboard_state',
        data: { competition_id: compId, event: activeEvent, heat, total_heats: totalHeats, is_joint: linkedEvents.length > 0, entries },
        timestamp: Date.now()
    }));
}

// Hook into existing broadcastSSE to also push to WebSocket clients
const _origBroadcastSSE = broadcastSSE;
const broadcastSSEAndWS = function(eventType, data) {
    _origBroadcastSSE(eventType, data);
    // Forward relevant events to WebSocket scoreboard
    if (['result_update', 'wind_update', 'height_update', 'event_status_changed', 'event_completed', 'heat_update'].includes(eventType)) {
        broadcastToScoreboard('scoreboard_' + eventType, data);
    }
};
// Monkey-patch: redirect all broadcastSSE calls to also broadcast WS
// We achieve this by re-assigning the function variable in the closure
// Since broadcastSSE is used throughout server.js, we wrap it:

// ─────────────────────────────────────────────────────────────────────
// 일회성 마이그레이션: 기존 DB의 division/round_type 표기 정규화
//   · event.division: "선수권 남자부" → "선수권(남)", "중학교부" → "중등부" 등
//   · event.round_type: "결승 2조"/"결승" 등 자유 텍스트 → preliminary/semifinal/final
//   · display_roster.division: 동일하게 정규화
// 멱등(idempotent) 함수 — 재실행해도 안전. 서버 시작 시 한 번 자동 실행.
// ─────────────────────────────────────────────────────────────────────
function migrateNormalizeDivisionAndRound() {
    // PG 모드: 데이터 정리는 마이그레이션 스크립트(scripts/migrate_sqlite_to_postgres.js)에서 별도 처리.
    // 부트 시 sync db.prepare 사용으로 PG 백엔드에서 throw 되므로 SQLite 전용 가드.
    if (db.isAsync) return;
    try {
        // 1) event.division 정규화
        const events = db.raw.prepare('SELECT id, division, round_type FROM event WHERE division IS NOT NULL OR round_type IS NOT NULL').all();
        const updEv = db.raw.prepare('UPDATE event SET division=?, round_type=? WHERE id=?');
        let evChanged = 0;
        events.forEach(ev => {
            const newDiv = normalizeDivisionLabel(ev.division || '');
            // round_type 정규화: 이미 preliminary/semifinal/final 이면 그대로, 아니면 parseDisplayRound로 변환
            let newRound = ev.round_type;
            if (newRound && !['preliminary', 'semifinal', 'final'].includes(newRound)) {
                newRound = parseDisplayRound(newRound).round_type;
            }
            if ((newDiv !== (ev.division || '')) || (newRound !== ev.round_type)) {
                updEv.run(newDiv, newRound, ev.id);
                evChanged++;
            }
        });

        // 2) display_roster.division 정규화
        const rosters = db.raw.prepare("SELECT id, division FROM display_roster WHERE division IS NOT NULL AND division <> ''").all();
        const updRo = db.raw.prepare('UPDATE display_roster SET division=? WHERE id=?');
        let roChanged = 0;
        rosters.forEach(r => {
            const newDiv = normalizeDivisionLabel(r.division || '');
            if (newDiv !== (r.division || '')) {
                updRo.run(newDiv, r.id);
                roChanged++;
            }
        });

        if (evChanged > 0 || roChanged > 0) {
            console.log(`[migrate] division/round normalize: event ${evChanged}건, display_roster ${roChanged}건 보정됨`);
        }
    } catch (e) {
        console.warn('[migrate] division/round normalize 경고:', e.message);
    }
}

// PG 모드 부팅(비동기): 설정·운영키 캐시 로드 + 초기 admin/운영키 시드.
//   예전엔 server.listen 콜백 안에서만 돌아서 ① 테스트(require)에서는 아예 돌지 않았고 ② 운영에서도 listen 직후 첫 요청이 빈 캐시를 볼 수 있었다.
//   → 요청 처리 전에 반드시 끝나도록 _bootReady 로 묶고, 미들웨어가 기다린다.
async function _pgBootAsync() {
    await Promise.allSettled(_bootTasks);          // 인증 테이블·PG 열 마이그레이션·상장 양식 시드
    if (!db.isAsync) return;
    try {
        await _loadConfigCacheAsync();
        await _reloadOpKeyCacheAsync();
        if (!_configCache.has('admin_id')) setConfigKey('admin_id', process.env.ADMIN_ID || 'admin');
        if (!_configCache.has('admin_pw')) setConfigKey('admin_pw', bcrypt.hashSync(process.env.ADMIN_PW || 'changeme', 10));
        else {
            const existingPw = _configCache.get('admin_pw') || '';
            if (existingPw && !existingPw.startsWith('$2a$') && !existingPw.startsWith('$2b$') && !existingPw.startsWith('$2y$')) {
                console.log('  [PG migration] admin_pw 가 평문 형태 → bcrypt 해시로 자동 변환');
                setConfigKey('admin_pw', bcrypt.hashSync(existingPw, 10));
            }
        }
        if (!_configCache.has('operation_key')) setConfigKey('operation_key', process.env.OPERATION_KEY || '1234');
        if (!_opKeyIsHash(ACCESS_KEYS.operation)) setDefaultOperationKey(ACCESS_KEYS.operation);
        if (!_configCache.has('record_officer_key')) setConfigKey('record_officer_key', process.env.RECORD_OFFICER_KEY || '');
        console.log(`  [PG cache] config: ${_configCache.size} keys, opkey: ${_opKeyCache.size} keys`);
    } catch (e) { console.error('[PG cache load] failed:', e.message); }
}
const _bootReady = _pgBootAsync();

// Export app/server for tests; only auto-listen when run directly (node server.js)
// db 도 노출 — 테스트에서 격리 DB에 픽스처를 직접 삽입하기 위함 (운영에선 미사용)
if (require.main !== module) {
    module.exports = { app, server, db, calcWAPoints, WA_TABLES, DECATHLON_KEYS, HEPTATHLON_KEYS, ready: _bootReady };
} else
server.listen(PORT, '0.0.0.0', async () => {
    await _bootReady;
    try {
        const compRow = await db.get('SELECT COUNT(*) as c FROM competition');
        const evtRow = await db.get('SELECT COUNT(*) as c FROM event');
        const athRow = await db.get('SELECT COUNT(*) as c FROM athlete');
        const compCount = compRow ? compRow.c : 0;
        const evtCount = evtRow ? evtRow.c : 0;
        const athCount = athRow ? athRow.c : 0;
        console.log(`\n  Pace Rise Competition OS v5 — port ${PORT}`);
        console.log(`  http://localhost:${PORT}/`);
        console.log(`  WebSocket Scoreboard: ws://localhost:${PORT}/ws/scoreboard`);
        console.log(`  DB backend: ${db.isAsync ? 'PostgreSQL' : 'SQLite'}`);
        console.log(`  DB: ${compCount} competitions, ${evtCount} events, ${athCount} athletes`);
        // Auth Phase 1 마이그레이션 상태 (부팅 IIFE 결과)
        if (global.__authMigOk) {
            console.log(`  Auth: app_user/session_refresh/login_audit ready ✓`);
        } else if (global.__authMigError) {
            console.log(`  Auth: ⚠ MIGRATION FAILED — ${global.__authMigError}`);
            console.log(`  Auth: JWT 로그인이 동작하지 않을 수 있음. /api/_diag/auth-init 로 재시도 가능`);
        } else {
            console.log(`  Auth: (마이그레이션 결과 대기 중 — 비동기 진행 중일 수 있음)`);
        }
        console.log('');
    } catch(e) {
        console.log(`\n  Pace Rise Competition OS v5 — port ${PORT}\n  http://localhost:${PORT}/\n  (DB count failed: ${e.message})\n`);
    }
    // 시작 직후 일회성 마이그레이션 실행 (멱등, SQLite 전용 — PG는 내부 가드)
    try { migrateNormalizeDivisionAndRound(); } catch(e) { console.warn('migrate failed:', e.message); }
});
