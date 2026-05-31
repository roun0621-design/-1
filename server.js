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
const { createCanvas, registerFont } = require('canvas');
const http = require('http');
const crypto = require('crypto');
const cron = require('node-cron');

// Ensure upload temp directory exists (fixes deployment upload failures)
const fs = require('fs');
const { execSync } = require('child_process');
const UPLOAD_TMP = '/tmp/uploads/';
if (!fs.existsSync(UPLOAD_TMP)) fs.mkdirSync(UPLOAD_TMP, { recursive: true });
const upload = multer({ dest: UPLOAD_TMP, limits: { fileSize: 10 * 1024 * 1024 } });

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
const BACKUP_DIR = path.join(__dirname, 'backups');
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
const BACKUP_MAX_DAYS = 7;

function performBackup(tag = 'daily') {
    try {
        const ts = kstNow().replace(/[: ]/g, '-');
        const backupFile = path.join(BACKUP_DIR, `backup_${tag}_${ts}.db`);
        fs.copyFileSync(DB_PATH, backupFile);
        // WAL 파일도 함께 백업
        if (fs.existsSync(DB_PATH + '-wal')) fs.copyFileSync(DB_PATH + '-wal', backupFile + '-wal');
        if (fs.existsSync(DB_PATH + '-shm')) fs.copyFileSync(DB_PATH + '-shm', backupFile + '-shm');
        console.log(`[Backup] ${tag} 백업 완료: ${path.basename(backupFile)}`);
        cleanOldBackups();
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

// 매일 새벽 3시 (KST = UTC+9 → UTC 18시) 정시 daily 백업
cron.schedule('0 18 * * *', () => performBackup('daily'));

// 매 시각 정시 hourly 백업
cron.schedule('0 * * * *', () => performBackup('hourly'));

// 5분마다 watchdog — cron 이 놓친 백업을 자동 복구
setInterval(() => {
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
setTimeout(() => {
    performBackup('startup');
    // 시작 시점에 daily/hourly 가 너무 오래된 상태면 즉시 부트스트랩
    if (_lastBackupAgeMs('daily') >= 24 * 60 * 60 * 1000) performBackup('daily');
    if (_lastBackupAgeMs('hourly') >= 60 * 60 * 1000) performBackup('hourly');
}, 5000);

const app = express();
const PORT = process.env.PORT || 3000;

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
    max: 3000,             // IP당 최대 3000회/분
    message: { error: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.' }
}));
// 인증 API는 더 엄격하게 제한 (무차별 대입 방지)
const authLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,               // 1분에 30회
    message: { error: '로그인 시도가 너무 많습니다. 1분 후 다시 시도하세요.' }
});

app.use(compression());
app.use(express.json());
// AUTH Phase 2: JWT 쿠키 파싱 (HttpOnly access_token / refresh_token)
try { app.use(require('cookie-parser')()); } catch (e) { console.warn('[auth] cookie-parser 미설치:', e.message); }

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
];
async function _extractCompetitionIdFromRequest(req) {
    try {
        // URL 직접 매칭 — /api/competitions/:id, /api/admin/competitions/:id/*
        const mDirect = req.path.match(/^\/api(?:\/admin)?\/competitions\/(\d+)/);
        if (mDirect) return parseInt(mDirect[1]);

        const b = req.body || {};
        const q = req.query || {};

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
        // athlete_id → athlete.competition_id
        const athId = b.athlete_id || q.athlete_id;
        if (athId) {
            const a = await db.get('SELECT competition_id FROM athlete WHERE id=?', athId);
            if (a) return a.competition_id;
        }
    } catch (e) { /* 추출 실패는 통과시킴 */ }
    return null;
}
app.use(async (req, res, next) => {
    if (!WRITE_METHODS.has(req.method)) return next();
    // 정적 자원이나 API 외부 요청은 통과
    if (!req.path.startsWith('/api/')) return next();
    // 면제 경로
    for (const re of COMP_END_GUARD_EXEMPT) if (re.test(req.path)) return next();
    // 키 추출 (본문 / 쿼리)
    const key = (req.body && (req.body.admin_key || req.body.operation_key || req.body.key))
            || (req.query && (req.query.admin_key || req.query.key));
    // 관리자 키는 무조건 통과
    if (key && isAdminKey(key)) return next();
    // competition_id 추출 시도
    const compId = await _extractCompetitionIdFromRequest(req);
    if (!compId) return next(); // 추출 못 하면 통과
    try {
        if (await isCompetitionEnded(compId)) {
            return res.status(403).json({
                error: '대회가 종료되었습니다. 관리자 권한으로만 수정할 수 있습니다.',
                competition_ended: true,
                competition_id: compId,
            });
        }
    } catch (e) { /* 가드 실패 시 통과 (가용성 우선) */ }
    next();
});

// Block results.html access — redirect to dashboard
app.get('/results.html', (req, res) => {
    const comp = req.query.comp ? `?comp=${req.query.comp}` : '';
    res.redirect(`/dashboard.html${comp}`);
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
app.get('/api/health', (req, res) => {
    res.json({
        ok: true,
        backend: db.isAsync ? 'postgres' : 'sqlite',
        authMig: global.__authMigOk ? 'ok' : (global.__authMigError ? 'failed' : 'pending'),
        authMigError: global.__authMigError || null,
        uptime_sec: Math.floor(process.uptime()),
        node: process.version,
        ts: new Date().toISOString(),
    });
});

// /open — Android intent:// 중간 리다이렉트 페이지 (카카오톡/인스타 인앱브라우저 대응)
app.get('/open', (req, res) => res.sendFile(path.join(__dirname, 'public', 'open.html')));

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
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`); } catch(e) { console.error('[DB] certificate_template create error:', e.message); }

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
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_sms_log_comp ON sms_log(competition_id, sent_at DESC)`); } catch(e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_sms_log_athlete ON sms_log(athlete_id, sent_at DESC)`); } catch(e) {}
// ========== END SMS Schema ==========

// ========== AUTH Phase 1: app_user / session_refresh / login_audit ==========
// (실제 호출은 SQLite-only 블록 종료 후 — 양쪽 백엔드에서 모두 실행되어야 함)
// 이 위치에서는 글로벌 상태 플래그만 선언.
global.__authMigError = null;
global.__authMigOk = false;

// 기본 상장 템플릿 시드 (최초 1회) — 시상장 + 완주증
// SQLite/PostgreSQL 양쪽에서 동작하도록 통합 db API 사용 (비동기)
(async () => {
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
})();

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
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`); } catch(e) {}
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
// competition.mode: 'operation' (운영용) or 'display' (노출용)
try { db.exec(`ALTER TABLE competition ADD COLUMN mode TEXT NOT NULL DEFAULT 'operation'`); } catch(e) {}
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
(async () => {
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
})();

// ─── Records Management v4 — PostgreSQL 마이그레이션 (비동기, idempotent) ───
// PG 모드에서는 schema.pg.sql 을 운영자가 한 번 실행하지만, 새 테이블/컬럼이
// 누락된 기존 DB에 대비해 boot 시 멱등 마이그레이션을 시도한다.
if (db.isAsync) {
    (async () => {
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
            // event: callroom_event_memo, video_url
            await pgIdempotentAddCol('event', 'callroom_event_memo', `TEXT DEFAULT ''`);
            await pgIdempotentAddCol('event', 'video_url', `TEXT DEFAULT ''`);
            // competition: federation, division_type, video_url
            await pgIdempotentAddCol('competition', 'federation', `TEXT DEFAULT ''`);
            await pgIdempotentAddCol('competition', 'division_type', `TEXT DEFAULT ''`);
            await pgIdempotentAddCol('competition', 'video_url', `TEXT DEFAULT ''`);
            // athlete: federation, personal_best, date_of_birth
            await pgIdempotentAddCol('athlete', 'federation', `TEXT DEFAULT ''`);
            await pgIdempotentAddCol('athlete', 'personal_best', `TEXT DEFAULT ''`);
            await pgIdempotentAddCol('athlete', 'date_of_birth', `TEXT DEFAULT ''`);
            // qualification_selection: qualification_type
            await pgIdempotentAddCol('qualification_selection', 'qualification_type', `TEXT DEFAULT ''`);
            // record_breaking_log: wind
            await pgIdempotentAddCol('record_breaking_log', 'wind', `DOUBLE PRECISION DEFAULT NULL`);
            // event_link: joint_scoreboard_key
            await pgIdempotentAddCol('event_link', 'joint_scoreboard_key', `TEXT DEFAULT NULL`);
            // operation_key: can_manage
            await pgIdempotentAddCol('operation_key', 'can_manage', `BIGINT NOT NULL DEFAULT 0`);
            console.log('[PG migration] idempotent column migrations complete (combined_score.status_code 등)');
        } catch (e) {
            console.error('[PG migration] idempotent column migrations error:', e.message);
        }
    })();
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

// ─── operation_key 메모리 캐시 (Phase 2-G-2-extra-3b-2) ───────────────
// 목적: isOperationKey/isAdminOrManager/getJudgeName/getKeyRole 의 DB hit을 boot 1회 + 변경 시로 축소.
//   매 request마다 발생하던 DB query 제거. caller 89건 무변경 유지.
// 캐시 형태: Map<key_value, { judge_name, can_manage, active }>
const _opKeyCache = new Map();
function _loadOpKeyCacheSync() {
    if (db.isAsync) return; // PG: 별도 async 로더 필요(추후)
    try {
        const rows = db.raw.prepare('SELECT key_value, judge_name, can_manage, active FROM operation_key WHERE active=1').all();
        _opKeyCache.clear();
        for (const r of rows) _opKeyCache.set(r.key_value, r);
    } catch (e) {
        console.error('[opkey-cache] sync load failed:', e.message);
    }
}
async function _reloadOpKeyCacheAsync() {
    try {
        const rows = await db.all('SELECT key_value, judge_name, can_manage, active FROM operation_key WHERE active=1');
        _opKeyCache.clear();
        for (const r of rows) _opKeyCache.set(r.key_value, r);
    } catch (e) {
        console.error('[opkey-cache] async reload failed:', e.message);
    }
}
if (!db.isAsync) _loadOpKeyCacheSync();

function isOperationKey(key) {
    if (!key) return false;
    if (key === ACCESS_KEYS.operation) return true;
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
    return bcrypt.compareSync(key, ACCESS_KEYS.adminHash);
}
function isAdminOrManager(key) {
    if (isAdminKey(key)) return true;
    const r = _opKeyCache.get(key);
    return !!(r && r.can_manage);
}
// Phase C 확장: 기록위원 전용 키 — 신기록 승인/거부 권한.
//   ACCESS_KEYS.recordOfficer 가 비어있으면 항상 false (비활성).
function isRecordOfficerKey(key) {
    if (!key) return false;
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
    if (isAdminKey(key)) return '관리자';
    if (isRecordOfficerKey(key)) return '기록위원';
    if (key === ACCESS_KEYS.operation) return '운영(기본키)';
    const r = _opKeyCache.get(key);
    return r ? r.judge_name : 'unknown';
}
function getKeyRole(key) {
    if (isAdminKey(key)) return 'admin';
    if (isRecordOfficerKey(key)) return 'record_officer';
    const r = _opKeyCache.get(key);
    if (r) return r.can_manage ? 'admin' : 'operation';
    if (key === ACCESS_KEYS.operation) return 'operation';
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
    const dbKey = await db.get('SELECT * FROM operation_key WHERE judge_name=? AND key_value=? AND active=1', judgeName, key);
    if (dbKey) return { role: dbKey.can_manage ? 'admin' : 'operation', judge_name: dbKey.judge_name };
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
    // Also forward to WebSocket scoreboard clients
    if (typeof wsClients !== 'undefined' && ['result_update', 'wind_update', 'height_update', 'event_status_changed', 'event_completed', 'heat_update', 'entry_status', 'callroom_complete'].includes(eventType)) {
        const wsMsg = JSON.stringify({ type: 'scoreboard_' + eventType, data, timestamp: Date.now() });
        wsClients.forEach(ws => {
            if (ws.readyState === 1) { // WebSocket.OPEN
                try { ws.send(wsMsg); } catch(e) {}
            }
        });
    }
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
    const ip = req ? (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim() : null;
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
    '800m':{name:'800m',category:'track'},'1500m':{name:'1500m',category:'track'},'5000m':{name:'5000m',category:'track'},
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
const FED_RELAY_MAP = {
    '400mR':{name:'4X100mR',category:'relay'},'1600mR':{name:'4X400mR',category:'relay'},
    'Mixed':{name:'4X400mR(Mixed)',category:'relay',gender:'X'},
    '4 x 1500mR':{name:'4×1500mR',category:'relay'},'4 x 800mR':{name:'4×800mR',category:'relay'},
    '4x100mR':{name:'4X100mR',category:'relay'},'4x400mR':{name:'4X400mR',category:'relay'},
    '4x800mR':{name:'4×800mR',category:'relay'},'4x1500mR':{name:'4×1500mR',category:'relay'},
    '4X100mR':{name:'4X100mR',category:'relay'},'4X400mR':{name:'4X400mR',category:'relay'},
    '4X800mR':{name:'4×800mR',category:'relay'},
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
        athletePerf.push({ ...sel, athlete_id: origEntry.athlete_id, team: athlete ? athlete.team : '', perf: bestPerf, sourceHeat });
    }

    // WA seeding: Q (순위 진출) first by performance, then q (기록 진출) by performance
    // A q athlete cannot outrank a Q athlete even with a better record
    const qOrder = { 'Q': 0, 'q': 1, '': 2 };
    athletePerf.sort((a, b) => {
        const aQ = qOrder[a.qualification_type] ?? 2;
        const bQ = qOrder[b.qualification_type] ?? 2;
        if (aQ !== bQ) return aQ - bQ;
        return a.perf - b.perf;
    });

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

// ============================================================
// DIAG: auth-state 진단 + 복구 라우트 (운영 디버깅용)
//   - GET  /api/_diag/auth-state   : app_user 테이블 존재여부 / row 수 / 마이그레이션 상태
//   - POST /api/_diag/auth-init    : runAuthMigrations 재실행 (legacy admin key 헤더 필요)
//   - POST /api/_diag/admin-reset  : ROUNKIM 등 관리자 비번을 system_config.admin_pw 와 동기화
//     (사전조건: x-admin-key 헤더에 legacy admin key 일치)
// ============================================================
function diagRequireAdminKey(req, res) {
    const k = req.headers['x-admin-key'] || req.query.adminKey;
    if (!isAdminKey(String(k || ''))) {
        res.status(403).json({ error: 'forbidden — admin key required (x-admin-key header)' });
        return false;
    }
    return true;
}

app.get('/api/_diag/auth-state', async (req, res) => {
    if (!diagRequireAdminKey(req, res)) return;
    try {
        const out = {
            backend: db.getBackendName ? db.getBackendName() : (db.isAsync ? 'postgres' : 'sqlite'),
            authMigOk: !!global.__authMigOk,
            authMigError: global.__authMigError || null,
        };
        // app_user 테이블 존재 여부
        try {
            const cntRow = await db.get('SELECT COUNT(*) AS c FROM app_user');
            out.app_user_count = cntRow ? Number(cntRow.c) : 0;
            // 사용자 목록 (해시는 prefix 만)
            const rows = await db.all('SELECT id, username, role, active, COALESCE(SUBSTRING(password_hash FROM 1 FOR 15), \'\') AS hash_prefix FROM app_user ORDER BY id');
            out.app_users = rows;
        } catch (e) {
            out.app_user_error = String(e && e.message || e);
        }
        // system_config 핵심 키 (값은 prefix 만)
        try {
            const cfg = await db.all("SELECT key, COALESCE(SUBSTRING(value FROM 1 FOR 25), '') AS value_preview FROM system_config WHERE key IN ('admin_id','admin_pw','jwt_secret')");
            out.system_config = cfg;
        } catch (e) {
            out.system_config_error = String(e && e.message || e);
        }
        res.json(out);
    } catch (e) {
        res.status(500).json({ error: String(e && e.message || e) });
    }
});

app.post('/api/_diag/auth-init', async (req, res) => {
    if (!diagRequireAdminKey(req, res)) return;
    try {
        const { runAuthMigrations } = require('./lib/auth/migrations');
        await runAuthMigrations(db);
        global.__authMigOk = true;
        global.__authMigError = null;
        console.log('[auth-mig] manual re-run OK via /api/_diag/auth-init');
        res.json({ ok: true, message: 'runAuthMigrations 재실행 완료' });
    } catch (e) {
        global.__authMigError = String(e && e.message || e);
        console.error('[auth-mig] manual re-run FAILED:', e.message, e.code || '', e.detail || '');
        res.status(500).json({
            ok: false,
            error: String(e && e.message || e),
            code: e && e.code || null,
            detail: e && e.detail || null,
            query: e && e.query ? String(e.query).substring(0, 500) : null
        });
    }
});

app.post('/api/_diag/admin-reset', async (req, res) => {
    if (!diagRequireAdminKey(req, res)) return;
    try {
        const { runAuthMigrations } = require('./lib/auth/migrations');
        await runAuthMigrations(db);
        // 이 시점 후 app_user 의 관리자 row 가 system_config.admin_pw 와 동기화되어 있어야 함
        const adminUsername = ADMIN_ID();
        const row = await db.get('SELECT id, username, role, active FROM app_user WHERE username=?', adminUsername);
        if (!row) {
            return res.status(500).json({ ok: false, error: `app_user('${adminUsername}') 시드 실패 — migrations 결과 확인 필요` });
        }
        res.json({ ok: true, message: `관리자 계정 동기화 완료`, user: row });
    } catch (e) {
        res.status(500).json({ ok: false, error: String(e && e.message || e), code: e && e.code || null });
    }
});

app.post('/api/auth/verify', authLimiter, async (req, res) => {
    const { key, judge_name } = req.body;
    // New: judge_name + key login
    if (judge_name && key) {
        const result = await verifyJudgeLogin(judge_name, key);
        if (result) return res.json({ success: true, role: result.role, label: result.role === 'admin' ? '관리자' : '운영', judge_name: result.judge_name });
        return res.status(403).json({ error: '심판명 또는 운영키가 일치하지 않습니다.' });
    }
    // Legacy: key-only login (backward compat)
    if (key) {
        if (isAdminKey(key)) return res.json({ success: true, role: 'admin', label: '관리자', judge_name: '관리자' });
        if (isOperationKey(key)) {
            const jn = getJudgeName(key);
            return res.json({ success: true, role: getKeyRole(key) || 'operation', label: '운영', judge_name: jn });
        }
    }
    res.status(403).json({ error: '유효하지 않은 키입니다.' });
});
app.post('/api/admin/verify', authLimiter, (req, res) => {
    const { admin_key } = req.body;
    if (isOperationKey(admin_key) || isAdminKey(admin_key)) {
        const jn = getJudgeName(admin_key);
        return res.json({ success: true, judge_name: jn });
    }
    res.status(403).json({ error: 'Invalid admin key' });
});
// /api/staff/verify removed — was never called from any client.
// Use /api/admin/verify (admin/operation key verification) instead.

// ============================================================
// COMPETITIONS CRUD — lib/routes/competitions.js 로 추출
// ============================================================
require("./lib/routes/competitions")(app, {
    db, isAdminKey, isOperationKey, isAdminOrManager, opLog, broadcastSSE, kstNow
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
               ee.id AS event_entry_id, ee.status, ee.callroom_memo,
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
require('./lib/routes/results')(app, { db, isAdminKey, isOperationKey, opLog, broadcastSSE, calcWAPoints, requireAdminAfterCompEnd });
// ============================================================
app.post('/api/heats/:id/wind', async (req, res) => {
    const { wind } = req.body;
    const heat = await db.get('SELECT * FROM heat WHERE id=?', req.params.id);
    if (!heat) return res.status(404).json({ error: 'Heat not found' });
    // Store as "N.N m/s" text format for scoreboard system compatibility
    let windValue = null;
    if (wind != null && wind !== '') {
        const v = parseFloat(wind);
        if (!isNaN(v)) windValue = v.toFixed(1) + ' m/s';
    }
    await db.run('UPDATE heat SET wind=? WHERE id=?', windValue, heat.id);
    broadcastSSE('wind_update', { heat_id: heat.id, wind: windValue });
    res.json({ success: true, wind: windValue });
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
        const entries = await db.all(`SELECT he.lane_number, he.sub_group, ee.id AS event_entry_id, ee.status,
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
    db, isAdminKey, isOperationKey, opLog, broadcastSSE
});

// ============================================================
// CALLROOM
// ============================================================
app.get('/api/barcode/:code', async (req, res) => {
    const raw = req.params.code.trim();

    // W/w prefix → female athlete by bib
    const wMatch = raw.match(/^[Ww][-]?(\d+)$/);
    if (wMatch) {
        const bibNum = wMatch[1].replace(/^0+/, '') || '0';
        const a = await db.get("SELECT * FROM athlete WHERE bib_number=? AND gender='F'", bibNum);
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
        a = await db.get('SELECT * FROM athlete WHERE barcode=?', v);
        if (a) break;
    }
    if (!a) {
        for (const v of variants) {
            a = await db.get('SELECT * FROM athlete WHERE bib_number=?', v);
            if (a) break;
        }
    }
    if (!a) return res.status(404).json({ error: 'Barcode not found' });
    res.json(a);
});
app.patch('/api/event-entries/:id/status', async (req, res) => {
    const { status, admin_key } = req.body;
    if (!['registered', 'checked_in', 'no_show'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const entry = await db.get('SELECT * FROM event_entry WHERE id=?', req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not found' });
    // Post-competition lock
    const _evt = await db.get('SELECT competition_id FROM event WHERE id=?', entry.event_id);
    if (_evt && await requireAdminAfterCompEnd(_evt.competition_id, admin_key, res)) return;
    await db.run('UPDATE event_entry SET status=? WHERE id=?', status, req.params.id);
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
app.post('/api/callroom/checkin', async (req, res) => {
    const { barcode, event_id, admin_key } = req.body;
    if (!barcode) return res.status(400).json({ error: 'barcode required' });

    // Determine competition_id from event_id for scoped athlete search
    let competition_id = null;
    if (event_id) {
        const evt = await db.get('SELECT competition_id FROM event WHERE id=?', event_id);
        if (evt) competition_id = evt.competition_id;
    }
    // Post-competition lock removed for callroom — callroom stays accessible after competition ends

    // ── Robust barcode normalization ──
    // Supports: PR-298, PR0298, PR298, 298, PR2026298, W63 (female by bib)
    const raw = barcode.trim();

    // ── W/w prefix → female athlete by bib number ──
    const wMatch = raw.match(/^[Ww][-]?(\d+)$/);
    if (wMatch) {
        const bibNum = wMatch[1].replace(/^0+/, '') || '0';
        let athlete = null;
        if (competition_id) {
            athlete = await db.get("SELECT * FROM athlete WHERE bib_number=? AND gender='F' AND competition_id=?", bibNum, competition_id);
        }
        if (!athlete) {
            athlete = await db.get("SELECT * FROM athlete WHERE bib_number=? AND gender='F'", bibNum);
        }
        if (!athlete) return res.status(404).json({ error: `여자 배번 ${bibNum} 선수를 찾을 수 없습니다`, barcode });
        // Jump directly to entry lookup (skip normal barcode search)
        return await continueCheckin(res, athlete, event_id, competition_id);
    }

    // ── Normal barcode variants ──
    const variants = new Set();
    variants.add(raw);
    let numPart = null;
    const pr2026Match = raw.match(/^PR2026(\d+)$/i);
    const prMatch = raw.match(/^PR[-]?0*(\d+)$/i);
    if (pr2026Match) numPart = pr2026Match[1];
    else if (prMatch) numPart = prMatch[1];
    else if (/^\d+$/.test(raw)) numPart = raw.replace(/^0+/, '') || '0';
    if (numPart) {
        variants.add(`PR-${numPart}`);
        variants.add(`PR${numPart}`);
        variants.add(`PR${numPart.padStart(4, '0')}`);
        variants.add(numPart);
        variants.add(numPart.padStart(2, '0'));
    }
    const variantArr = [...variants];

    async function findAthlete(scope) {
        for (const v of variantArr) {
            const a = scope
                ? await db.get('SELECT * FROM athlete WHERE barcode=? AND competition_id=?', v, scope)
                : await db.get('SELECT * FROM athlete WHERE barcode=?', v);
            if (a) return a;
        }
        for (const v of variantArr) {
            const a = scope
                ? await db.get('SELECT * FROM athlete WHERE bib_number=? AND competition_id=?', v, scope)
                : await db.get('SELECT * FROM athlete WHERE bib_number=?', v);
            if (a) return a;
        }
        return null;
    }

    let athlete = null;
    if (competition_id) athlete = await findAthlete(competition_id);
    if (!athlete) athlete = await findAthlete(null);
    if (!athlete) return res.status(404).json({ error: '선수를 찾을 수 없습니다', barcode });
    return await continueCheckin(res, athlete, event_id, competition_id);
});

// Shared checkin logic: find entry → update status → respond
async function continueCheckin(res, athlete, event_id, competition_id) {
    let entry;
    if (event_id) {
        entry = await db.get('SELECT * FROM event_entry WHERE event_id=? AND athlete_id=?', event_id, athlete.id);
        if (!entry) {
            let cid = competition_id;
            if (!cid) {
                const evRow = await db.get('SELECT competition_id FROM event WHERE id=?', event_id);
                cid = evRow ? evRow.competition_id : null;
            }
            if (cid) {
                const allEntries = await db.all(`
                    SELECT ee.*, e.name as event_name FROM event_entry ee 
                    JOIN event e ON ee.event_id=e.id 
                    WHERE ee.athlete_id=? AND e.competition_id=?
                    ORDER BY CASE ee.status WHEN 'registered' THEN 0 WHEN 'checked_in' THEN 1 ELSE 2 END
                `, athlete.id, cid);
                if (allEntries.length > 0) {
                    entry = allEntries.find(e => e.status === 'registered') || allEntries[0];
                }
            }
        }
    } else {
        entry = await db.get("SELECT * FROM event_entry WHERE athlete_id=? AND status='registered' LIMIT 1", athlete.id);
    }
    if (!entry) return res.status(404).json({ error: '해당 종목에 등록되지 않은 선수입니다', athlete: { name: athlete.name, bib: athlete.bib_number } });

    const wasAlready = entry.status === 'checked_in';
    if (!wasAlready) {
        await db.run("UPDATE event_entry SET status='checked_in' WHERE id=?", entry.id);
        await syncCombinedSubEventCheckin(entry.event_id, athlete.id, 'checked_in');
        const _he2 = await db.get('SELECT heat_id FROM heat_entry WHERE event_entry_id=?', entry.id);
        broadcastSSE('entry_status', { event_entry_id: entry.id, status: 'checked_in', event_id: entry.event_id, heat_id: _he2 ? _he2.heat_id : null });
    }

    const heatEntry = await db.get(`SELECT he.heat_id, h.heat_number FROM heat_entry he JOIN heat h ON he.heat_id=h.id WHERE he.event_entry_id=?`, entry.id);

    res.json({
        success: true, already: wasAlready, athlete,
        entry: { ...entry, status: 'checked_in' },
        heat_id: heatEntry ? heatEntry.heat_id : null,
        heat_number: heatEntry ? heatEntry.heat_number : null,
        event_id: entry.event_id
    });
}

// Helper: sync combined sub-event entries when parent is checked in
async function syncCombinedSubEventCheckin(parentEventId, athleteId, status) {
    const parentEvt = await db.get('SELECT * FROM event WHERE id=?', parentEventId);
    if (!parentEvt || parentEvt.category !== 'combined') return;
    const subEvents = await db.all('SELECT id FROM event WHERE parent_event_id=?', parentEventId);
    for (const sub of subEvents) {
        const subEntry = await db.get('SELECT * FROM event_entry WHERE event_id=? AND athlete_id=?', sub.id, athleteId);
        if (subEntry && subEntry.status !== status) {
            await db.run('UPDATE event_entry SET status=? WHERE id=?', status, subEntry.id);
        }
    }
}

// Bulk sync: set all sub-event entries to match parent checked_in status
app.post('/api/combined/sync-checkin', async (req, res) => {
    const { event_id } = req.body;
    if (!event_id) return res.status(400).json({ error: 'event_id required' });
    const evt = await db.get('SELECT * FROM event WHERE id=?', event_id);
    if (!evt || evt.category !== 'combined') return res.status(400).json({ error: 'Not a combined event' });
    const parentEntries = await db.all('SELECT * FROM event_entry WHERE event_id=?', event_id);
    const subEvents = await db.all('SELECT id FROM event WHERE parent_event_id=?', event_id);
    let synced = 0;
    await db.transaction(async () => {
        for (const pe of parentEntries) {
            for (const sub of subEvents) {
                const subEntry = await db.get('SELECT * FROM event_entry WHERE event_id=? AND athlete_id=?', sub.id, pe.athlete_id);
                if (subEntry && subEntry.status !== pe.status) {
                    await db.run('UPDATE event_entry SET status=? WHERE id=?', pe.status, subEntry.id);
                    synced++;
                }
            }
        }
    })();
    res.json({ success: true, synced });
});

// ============================================================
// QUALIFICATIONS
// ============================================================
app.get('/api/qualifications', async (req, res) => {
    if (!req.query.event_id) return res.status(400).json({ error: 'event_id required' });
    res.json(await db.all(`SELECT qs.*, a.name, a.bib_number, a.team FROM qualification_selection qs
        JOIN event_entry ee ON ee.id=qs.event_entry_id JOIN athlete a ON a.id=ee.athlete_id WHERE qs.event_id=?`, req.query.event_id));
});
app.post('/api/qualifications/save', async (req, res) => {
    const { event_id, selections } = req.body;
    if (!event_id || !selections) return res.status(400).json({ error: 'Missing fields' });
    await db.transaction(async () => {
        for (const s of selections) {
            await db.run(`INSERT INTO qualification_selection (event_id,event_entry_id,selected,qualification_type) VALUES (?,?,?,?)
                ON CONFLICT(event_id,event_entry_id) DO UPDATE SET selected=excluded.selected, qualification_type=excluded.qualification_type, updated_at=${db.isAsync ? 'NOW()' : "datetime('now')"}`,
                event_id, s.event_entry_id, s.selected ? 1 : 0, s.qualification_type || '');
        }
    })();
    res.json({ success: true });
});
app.post('/api/qualifications/approve', async (req, res) => {
    const { event_id } = req.body;
    if (!event_id) return res.status(400).json({ error: 'event_id required' });
    const _nowFQ = db.isAsync ? 'NOW()' : "datetime('now')";
    await db.run(`UPDATE qualification_selection SET approved=1,approved_by='admin',updated_at=${_nowFQ} WHERE event_id=? AND selected=1`, event_id);
    res.json({ success: true });
});

// ============================================================
// ROUND MANAGEMENT
// ============================================================
app.post('/api/events/:id/complete', async (req, res) => {
    const { judge_name, admin_key } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '유효하지 않은 운영키입니다.' });
    if (!judge_name || !judge_name.trim()) return res.status(400).json({ error: 'Judge name required' });
    const event = await db.get('SELECT * FROM event WHERE id=?', req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (event.round_status === 'completed') return res.status(400).json({ error: '이미 완료된 경기입니다.' });
    if (event.round_status !== 'in_progress') return res.status(400).json({ error: '진행 중인 경기만 완료 처리할 수 있습니다.' });
    await db.run("UPDATE event SET round_status='completed' WHERE id=?", event.id);
    broadcastSSE('event_completed', { event_id: event.id, judge_name });
    const gL = event.gender === 'M' ? '남자' : event.gender === 'F' ? '여자' : '혼성';
    const roundL = { preliminary: '예선', semifinal: '준결승', final: '결승' }[event.round_type] || event.round_type;
    opLog(`${event.name} ${roundL} 경기완료 - ${judge_name}`, 'completion', judge_name, event.competition_id);
    res.json({ success: true, event: await db.get('SELECT * FROM event WHERE id=?', event.id) });
});
app.post('/api/events/:id/revert-complete', async (req, res) => {
    const { admin_key } = req.body;
    if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    const event = await db.get('SELECT * FROM event WHERE id=?', req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (event.round_status !== 'completed') return res.status(400).json({ error: '완료 상태의 경기만 되돌릴 수 있습니다.' });
    await db.run("UPDATE event SET round_status='in_progress' WHERE id=?", event.id);
    broadcastSSE('event_reverted', { event_id: event.id });
    opLog(`${event.name} 경기완료 취소 (관리자)`, 'revert', 'admin', event.competition_id);
    res.json({ success: true, event: await db.get('SELECT * FROM event WHERE id=?', event.id) });
});
app.post('/api/events/:id/callroom-complete', async (req, res) => {
    const { judge_name, heat_id, admin_key } = req.body;
    const event = await db.get('SELECT * FROM event WHERE id=?', req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    // Post-competition lock removed for callroom — callroom stays accessible after competition ends
    if (event.round_status === 'completed') return res.status(400).json({ error: '이미 완료된 경기입니다.' });
    // Allow multiple callroom-complete calls for different heats (예선 1조, 2조, etc.)
    if (event.round_status !== 'in_progress') {
        await db.run("UPDATE event SET round_status='in_progress' WHERE id=?", event.id);
    }
    const performer = judge_name || 'operator';
    const roundL = { preliminary: '예선', semifinal: '준결승', final: '결승' }[event.round_type] || event.round_type;
    // If heat_id provided, identify which heat number
    let heatLabel = '';
    if (heat_id) {
        const heats = await db.all('SELECT id FROM heat WHERE event_id=? ORDER BY heat_number', event.id);
        const heatIdx = heats.findIndex(h => h.id === parseInt(heat_id));
        if (heatIdx >= 0) heatLabel = ` ${heatIdx + 1}조`;
    }
    // Auto-insert DNS result for no_show entries in the relevant heat(s)
    let dnsCount = 0;
    const targetHeats = heat_id
        ? [await db.get('SELECT * FROM heat WHERE id=?', parseInt(heat_id))]
        : await db.all('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number', event.id);
    for (const h of targetHeats) {
        if (!h) continue;
        const noShowEntries = await db.all(`
            SELECT he.event_entry_id FROM heat_entry he
            JOIN event_entry ee ON ee.id = he.event_entry_id
            WHERE he.heat_id = ? AND ee.status = 'no_show'
        `, h.id);
        for (const ns of noShowEntries) {
            // Only insert if no result row exists yet for this entry in this heat
            const existing = await db.get('SELECT id FROM result WHERE heat_id=? AND event_entry_id=? LIMIT 1', h.id, ns.event_entry_id);
            if (!existing) {
                await db.run(`INSERT OR IGNORE INTO result (heat_id, event_entry_id, attempt_number, status_code) VALUES (?, ?, NULL, 'DNS')`, h.id, ns.event_entry_id);
                dnsCount++;
            }
        }
    }
    if (dnsCount > 0) {
        opLog(`${event.name} ${roundL}${heatLabel} 결석 선수 ${dnsCount}명 DNS 자동 처리`, 'callroom', performer, event.competition_id);
    }

    audit('event', event.id, 'UPDATE', { round_status: event.round_status }, { action: 'callroom_complete', round_status: 'in_progress', heat_id: heat_id || null }, performer, event.competition_id, req);
    broadcastSSE('callroom_complete', { event_id: event.id, judge_name: performer, heat_id: heat_id || null });
    opLog(`${event.name} ${roundL}${heatLabel} 소집 완료 - ${performer}`, 'callroom', performer, event.competition_id);
    res.json({ success: true, dns_auto: dnsCount });
});
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
        return { event_entry_id: q.event_entry_id, athlete_id: origEntry.athlete_id, qualification_type: q.qualification_type || '', perf: bestPerf };
    }));

    // WA seeding: Q (순위 진출) first by performance, then q (기록 진출) by performance
    // A q athlete cannot outrank a Q athlete even with a better record
    const qOrder = { 'Q': 0, 'q': 1, '': 2 };
    qualSels.sort((a, b) => {
        const aQ = qOrder[a.qualification_type] ?? 2;
        const bQ = qOrder[b.qualification_type] ?? 2;
        if (aQ !== bQ) return aQ - bQ;   // Q before q before unqualified
        return a.perf - b.perf;            // within same group: best performance first
    });

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
            groupAthletes.sort((a, b) => a.perf - b.perf);
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
    try { await autoLinkTimetable(event.competition_id); } catch(autoErr) { console.warn('[autoLink after final] ', autoErr.message); }
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
            groupAthletes.sort((a, b) => a.perf - b.perf);
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
    try { await autoLinkTimetable(event.competition_id); } catch(autoErr) { console.warn('[autoLink after semifinal] ', autoErr.message); }
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
        const entries = await db.all(`SELECT he.lane_number, he.sub_group, ee.id AS event_entry_id, ee.status,
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
    if (compId) return res.json(await db.all("SELECT * FROM event WHERE competition_id=? AND parent_event_id IS NULL ORDER BY sort_order, id", compId));
    res.json(await db.all("SELECT * FROM event WHERE parent_event_id IS NULL ORDER BY sort_order, id"));
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
    if (new_operation_key && new_operation_key.length >= 4) ACCESS_KEYS.operation = new_operation_key;
    if (new_admin_key && new_admin_key.length >= 4) ACCESS_KEYS.admin = new_admin_key;  // setter hashes automatically
    if (new_admin_id && new_admin_id.trim()) setConfigKey('admin_id', new_admin_id.trim());
    // Phase C 확장: 기록위원 키. 빈 문자열 명시 시 비활성, 4자 이상이면 설정
    if (typeof new_record_officer_key === 'string') {
        const trimmed = new_record_officer_key.trim();
        if (trimmed === '' || trimmed.length >= 4) {
            ACCESS_KEYS.recordOfficer = trimmed;
        }
    }
    res.json({
        success: true,
        operation_key: ACCESS_KEYS.operation,
        admin_id: ADMIN_ID(),
        record_officer_key: ACCESS_KEYS.recordOfficer,
        record_officer_active: !!ACCESS_KEYS.recordOfficer,
    });
});
app.get('/api/admin/current-keys', (req, res) => {
    if (!isAdminKey(req.query.key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    res.json({
        operation: ACCESS_KEYS.operation,
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
    res.json(await db.all('SELECT id, judge_name, key_value, role, can_manage, active, created_at FROM operation_key ORDER BY created_at DESC'));
});
app.post('/api/admin/operation-keys', async (req, res) => {
    const { admin_key, judge_name, key_value, can_manage } = req.body;
    if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    if (!judge_name || !key_value || key_value.length < 4) return res.status(400).json({ error: '심판명과 키(4자 이상)를 입력하세요.' });
    try {
        const info = await db.run('INSERT INTO operation_key (judge_name, key_value, can_manage) VALUES (?, ?, ?)', judge_name, key_value, can_manage ? 1 : 0);
        await _reloadOpKeyCacheAsync();
        opLog(`운영키 생성: ${judge_name}${can_manage ? ' (관리권한)' : ''}`, 'admin', 'admin');
        res.json(await db.get('SELECT * FROM operation_key WHERE id=?', info.lastInsertRowid));
    } catch (e) { res.status(400).json({ error: '키가 중복되었습니다.' }); }
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
        try { await autoLinkTimetable(competition_id); } catch(autoErr) { console.warn('[autoLink after event create] ', autoErr.message); }
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
        try { await autoLinkTimetable(old.competition_id); } catch(autoErr) { console.warn('[autoLink after event update] ', autoErr.message); }
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

app.post('/api/admin/db-backup/trigger', (req, res) => {
    if (!isOperationKey(req.body.admin_key)) return res.status(403).json({ error: '운영키가 필요합니다.' });
    const tag = (req.body.tag || 'manual').replace(/[^a-z0-9]/gi, '').slice(0, 20) || 'manual';
    const file = performBackup(tag);
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
app.post('/api/admin/full-backup/restore', _fullBackupUpload.single('file'), (req, res) => {
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
            rollbackFile = performBackup('prerestore');
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
        const eventSet = new Map();
        const relayTeams = new Map();
        dataRows.forEach(row => {
            const _g2414 = String(row[2] || '').trim();
            const gender = (_g2414 === '남' || _g2414 === '남자') ? 'M' : (_g2414 === '여' || _g2414 === '여자') ? 'F' : null;
            if (!gender) return;
            [row[4], row[5]].forEach(evtName => {
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
            const _barcodeMap = new Map(); // key: name|team|gender -> barcode
            const _bibMap = new Map(); // key: name|team|gender -> bib
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

                [row[4], row[5]].forEach(evtName => {
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
                    const ALWAYS_FINAL_EVENTS = ['5000m','5000mW','10,000m','10,000mW','10000m','3000mSC','3000m장애물','마라톤','하프마라톤','20KmW','35kmW','10K','5K'];
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
                    return existingId;
                }
                const bib = _bibMap.get(key) || null;
                const bc = _barcodeMap.get(key) || '';
                const r = await db.run('INSERT INTO athlete (competition_id,name,bib_number,team,barcode,gender) VALUES (?,?,?,?,?,?)', competition_id, name, bib, team, bc, gender);
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
                const existingSubsRow = await db.get('SELECT COUNT(*) AS c FROM event WHERE parent_event_id=?', parentId);
                const existingSubs = (existingSubsRow && existingSubsRow.c) || 0;
                if (existingSubs > 0) continue;
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
            else if (/^(팀명|소속|팀|team)$/i.test(hn)) hdrMap.team = idx;
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
        for (const row of rows.slice(1)) {
            const name = String(row[hdrMap.name] || '').trim();
            if (!name) continue;
            const team = hdrMap.team !== undefined ? String(row[hdrMap.team] || '').trim() : '';
            const genderRaw = hasGenderCol ? String(row[hdrMap.gender] || '').trim() : '';
            const gender = (genderRaw === '남' || genderRaw === '남자' || genderRaw === 'M') ? 'M' : (genderRaw === '여' || genderRaw === '여자' || genderRaw === 'F') ? 'F' : null;
            const bib = hdrMap.bib !== undefined ? String(row[hdrMap.bib] || '').trim() : '';
            if (!bib) continue;
            // If gender column exists but value is invalid, skip
            if (hasGenderCol && !gender) continue;
            const key = gender ? `${name}|${team}|${gender}` : `${name}|${team}`;
            if (!excelMap.has(key)) excelMap.set(key, { bib, hasGender: !!gender });
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
function normalizeEventName(raw) {
    if (!raw) return null;
    const s = String(raw).trim();
    // Map common variations
    const map = {
        '10000m': '10,000m', '10000mW': '10,000mW',
        '4x100mR': '4X100mR', '4X100mR': '4X100mR', '4 x 100mR': '4X100mR',
        '4x400mR': '4X400mR', '4X400mR': '4X400mR', '4 x 400mR': '4X400mR',
        '4x400mR(Mixed)': '4X400mR(Mixed)', 'Mixed 4x400mR': '4X400mR(Mixed)', 'Mixed4x400mR': '4X400mR(Mixed)',
        '4x400mR Mixed': '4X400mR(Mixed)', '4X400mR Mixed': '4X400mR(Mixed)', '4 x 400mR Mixed': '4X400mR(Mixed)',
        '4x1500mR': '4×1500mR', '4X1500mR': '4×1500mR', '4 x 1500mR': '4×1500mR',
        '4x800mR': '4×800mR', '4X800mR': '4×800mR', '4 x 800mR': '4×800mR',
    };
    return map[s] || s;
}

// Helper: Normalize gender from Excel
function normalizeGender(raw) {
    if (!raw) return null;
    const s = String(raw).trim();
    if (s === '남' || s === 'M' || s === '남자') return 'M';
    if (s === '여' || s === 'F' || s === '여자') return 'F';
    if (s === '혼성' || s === 'X' || s === '혼') return 'X';
    return null;
}

// Helper: Normalize round from Excel
function normalizeRound(raw) {
    if (!raw) return 'final';
    const s = String(raw).trim().toLowerCase();
    if (s === '예선' || s === 'preliminary' || s === '예') return 'preliminary';
    if (s === '준결승' || s === 'semifinal' || s === '준결') return 'semifinal';
    if (s === '결승' || s === 'final' || s === '결') return 'final';
    // 10종/7종 sub-events are stored as round_type='final' in DB
    if (/10종|십종|decathlon|7종|칠종|heptathlon/i.test(s)) return 'final';
    // Patterns like "3-2+2", "2-3+2" → preliminary (multiple heats with advancement)
    if (/^\d+-\d+\+\d+$/.test(s)) return 'preliminary';
    // Excel date serial numbers (예선 misread as date) → treat as preliminary
    if (/^\d{4,5}$/.test(s)) return 'preliminary';
    return 'final';
}

// Parse heat assignment Excel: returns grouped events
function parseHeatAssignmentExcel(filePath) {
    const wb = XLSX.readFile(filePath);
    // Try to find sheet named '조편성', otherwise use first sheet
    const sheetName = wb.SheetNames.find(n => n.includes('조편성')) || wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
    if (rows.length < 2) throw new Error('데이터가 없습니다.');

    // Detect headers
    const headers = rows[0].map(h => String(h || '').trim());
    
    // Find column indices by header name (flexible matching)
    const colIdx = {};
    headers.forEach((h, idx) => {
        const hl = h.toLowerCase();
        if (hl === '성별' || hl === 'gender') colIdx.gender = idx;
        else if (hl === '종목' || hl === 'event' || hl === '종목명') colIdx.event = idx;
        else if (hl === '라운드' || hl === 'round') colIdx.round = idx;
        else if (hl === '조' || hl === 'heat' || hl === '조번호') colIdx.heat = idx;
        else if (hl === '그룹' || hl === 'group' || hl === '그룹명') colIdx.group = idx;
        else if (hl === '순서' || hl === 'lane' || hl === '레인' || hl === '레인/순서') colIdx.lane = idx;
        else if (hl === '배번' || hl === 'bib' || hl === '번호') colIdx.bib = idx;
        else if (hl === '성명' || hl === 'name' || hl === '선수명') colIdx.name = idx;
        else if (hl === '소속' || hl === 'team' || hl === '팀명') colIdx.team = idx;
    });

    // Validate required columns
    if (colIdx.event === undefined) throw new Error("'종목' 컬럼을 찾을 수 없습니다.");
    if (colIdx.name === undefined) throw new Error("'성명' 컬럼을 찾을 수 없습니다.");

    const dataRows = rows.slice(1).filter(r => r[colIdx.event] && r[colIdx.name]);
    
    // Group by event key: gender + event_name + round_type
    const eventGroups = new Map();
    
    for (const row of dataRows) {
        const gender = normalizeGender(row[colIdx.gender !== undefined ? colIdx.gender : -1]);
        let eventName = normalizeEventName(row[colIdx.event]);
        const rawRound = colIdx.round !== undefined ? String(row[colIdx.round] || '').trim() : '';
        
        // Detect 10종/7종 in round column → prefix event name with [10종]/[7종]
        const is10jong = /10종|십종|decathlon/i.test(rawRound);
        const is7jong = /7종|칠종|heptathlon/i.test(rawRound);
        if (is10jong && eventName && !eventName.startsWith('[10종]')) {
            eventName = `[10종] ${eventName}`;
        } else if (is7jong && eventName && !eventName.startsWith('[7종]')) {
            eventName = `[7종] ${eventName}`;
        }
        
        const round = normalizeRound(rawRound);
        // 10종/7종 세부종목은 조 번호를 항상 1로 강제 (전체 선수가 1조에서 뜀)
        let heatNum = colIdx.heat !== undefined ? parseInt(row[colIdx.heat]) || 1 : 1;
        if (is10jong || is7jong) heatNum = 1;
        let group = colIdx.group !== undefined ? (row[colIdx.group] ? String(row[colIdx.group]).replace(/[\s\u3000]+/g, '').toUpperCase() : null) : null;
        if (group === '') group = null;
        const lane = colIdx.lane !== undefined ? parseInt(row[colIdx.lane]) || null : null;
        const bib = colIdx.bib !== undefined ? (row[colIdx.bib] != null ? String(row[colIdx.bib]).trim() : null) : null;
        const name = String(row[colIdx.name]).trim();
        const team = colIdx.team !== undefined ? String(row[colIdx.team] || '').replace(/[\s\u3000]+$/g, '').trim() : '';

        if (!eventName || !name) continue;

        const eventKey = `${gender || '?'}|${eventName}|${round}`;
        if (!eventGroups.has(eventKey)) {
            eventGroups.set(eventKey, {
                gender, eventName, round,
                entries: []
            });
        }
        eventGroups.get(eventKey).entries.push({
            heat: heatNum, group, lane, bib, name, team
        });
    }

    // ============================================================
    // 라운드 혼재 자동 병합: 같은 성별+종목에서 소수 선수만 다른 라운드로
    // 되어있으면 엑셀 입력 오류로 간주하여 다수 라운드 쪽으로 병합
    // 예: 남 400mH 예선:10명, 결승:1명 → 1명을 예선으로 병합
    // 단, 10종/7종 세부종목과의 혼재는 제외 (이건 정상)
    // ============================================================
    const mergeWarnings = [];
    const byGenderEvent = new Map(); // 'M|400mH' → [{eventKey, round, count}]
    for (const [eventKey, group] of eventGroups) {
        const ge = `${group.gender}|${group.eventName}`;
        if (!byGenderEvent.has(ge)) byGenderEvent.set(ge, []);
        byGenderEvent.get(ge).push({ eventKey, round: group.round, count: group.entries.length });
    }

    for (const [ge, rounds] of byGenderEvent) {
        if (rounds.length < 2) continue;
        // 10종/7종 세부종목은 병합 대상이 아님 (round column에 '10종','7종' 등이 있으면 이미 별도 eventName)
        // 여기서 걸리는 건 순수하게 예선/결승/준결승이 혼재된 경우만
        const total = rounds.reduce((s, r) => s + r.count, 0);
        // 가장 선수가 많은 라운드 찾기
        rounds.sort((a, b) => b.count - a.count);
        const majority = rounds[0];
        // 소수 라운드들 (전체의 20% 미만인 그룹)
        const minorities = rounds.slice(1).filter(r => r.count < total * 0.2);
        if (minorities.length === 0) continue;

        for (const minor of minorities) {
            const minorGroup = eventGroups.get(minor.eventKey);
            const majorGroup = eventGroups.get(majority.eventKey);
            if (!minorGroup || !majorGroup) continue;

            const [g, evName] = ge.split('|');
            const gLabel = g === 'M' ? '남' : g === 'F' ? '여' : '혼성';
            const minRoundLabel = { preliminary: '예선', semifinal: '준결승', final: '결승' }[minor.round] || minor.round;
            const majRoundLabel = { preliminary: '예선', semifinal: '준결승', final: '결승' }[majority.round] || majority.round;

            // 소수 그룹의 선수를 다수 그룹으로 이동
            for (const entry of minorGroup.entries) {
                majorGroup.entries.push(entry);
            }
            // 소수 그룹 제거
            eventGroups.delete(minor.eventKey);

            const names = minorGroup.entries.map(e => e.name).join(', ');
            mergeWarnings.push(
                `${gLabel} ${evName}: ${names} (${minor.count}명)이 '${minRoundLabel}'로 되어있으나 ` +
                `다수(${majority.count}명)가 '${majRoundLabel}'이므로 '${majRoundLabel}'로 병합했습니다.`
            );
            console.log(`[조편성 라운드 병합] ${gLabel} ${evName}: ${minRoundLabel}(${minor.count}명) → ${majRoundLabel}(${majority.count}명)으로 병합 [${names}]`);
        }
    }

    return { eventGroups, totalRows: dataRows.length, sheetName, mergeWarnings };
}

// PREVIEW API — Compare Excel data with DB, show changes
app.post('/api/heat-assignment/preview', upload.single('file'), async (req, res) => {
    if (!isAdminKey(req.body.admin_key || req.headers['x-admin-key'])) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    if (!req.file) return res.status(400).json({ error: '파일이 필요합니다.' });
    const competition_id = parseInt(req.body.competition_id);
    if (!competition_id) return res.status(400).json({ error: 'competition_id 필요' });

    try {
        const { eventGroups, totalRows, sheetName, mergeWarnings } = parseHeatAssignmentExcel(req.file.path);
        
        const preview = [];
        
        for (const [eventKey, group] of eventGroups) {
            const { gender, eventName, round, entries } = group;
            
            // Find matching event in DB
            let dbEvent = null;
            if (gender && gender !== '?') {
                dbEvent = await db.get('SELECT * FROM event WHERE competition_id=? AND name=? AND gender=? AND round_type=? AND parent_event_id IS NULL', competition_id, eventName, gender, round);
            }
            // Fallback: try without round_type match (some events only have final)
            if (!dbEvent && gender && gender !== '?') {
                dbEvent = await db.get('SELECT * FROM event WHERE competition_id=? AND name=? AND gender=? AND parent_event_id IS NULL', competition_id, eventName, gender);
            }
            // Fallback: try without parent_event_id constraint (for child events like [10종] 100m, [7종] 100mH)
            if (!dbEvent && gender && gender !== '?') {
                dbEvent = await db.get('SELECT * FROM event WHERE competition_id=? AND name=? AND gender=? AND round_type=?', competition_id, eventName, gender, round);
            }
            if (!dbEvent && gender && gender !== '?') {
                dbEvent = await db.get('SELECT * FROM event WHERE competition_id=? AND name=? AND gender=?', competition_id, eventName, gender);
            }
            // Fuzzy fallback: LIKE match for partial names (e.g., "10K 국제 남자부" → DB has "10K국제남자부")
            if (!dbEvent && gender && gender !== '?') {
                const stripped = eventName.replace(/\s+/g, '%');
                dbEvent = await db.get("SELECT * FROM event WHERE competition_id=? AND REPLACE(REPLACE(name,' ',''),' ','') = ? AND gender=?", competition_id, eventName.replace(/\s+/g, ''), gender);
                if (!dbEvent) {
                    dbEvent = await db.get("SELECT * FROM event WHERE competition_id=? AND name LIKE ? AND gender=?", competition_id, `%${stripped}%`, gender);
                }
            }
            
            if (!dbEvent) {
                // Try to find similar events as suggestions
                let suggestions = [];
                if (gender && gender !== '?') {
                    const sugRows = await db.all('SELECT id, name, round_type FROM event WHERE competition_id=? AND gender=? AND parent_event_id IS NULL ORDER BY name', competition_id, gender);
                    suggestions = sugRows.map(e => ({ id: e.id, name: e.name, round: e.round_type }));
                }
                preview.push({
                    eventKey, eventName, gender, round,
                    status: 'not_found',
                    message: `종목을 찾을 수 없습니다: ${gender === 'M' ? '남' : gender === 'F' ? '여' : '혼성'} ${eventName}`,
                    excelEntries: entries.length,
                    dbEntries: 0,
                    hasResults: false,
                    changes: [],
                    suggestions,
                    canAutoCreate: true
                });
                continue;
            }

            // Get current DB heats + entries for this event
            const dbHeats = await db.all('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number', dbEvent.id);
            const dbHeatEntries = [];
            for (const h of dbHeats) {
                const hEntries = await db.all(`
                    SELECT he.id, he.heat_id, he.lane_number, he.event_entry_id, he.sub_group,
                           a.name, a.bib_number, a.team, a.id as athlete_id
                    FROM heat_entry he
                    JOIN event_entry ee ON ee.id = he.event_entry_id
                    JOIN athlete a ON a.id = ee.athlete_id
                    WHERE he.heat_id = ?
                    ORDER BY he.lane_number
                `, h.id);
                dbHeatEntries.push({ heat: h, entries: hEntries });
            }

            // Check if results exist for this event
            let resultCount = 0;
            let heightAttemptCount = 0;
            for (const h of dbHeats) {
                const rRow = await db.get('SELECT COUNT(*) as c FROM result WHERE heat_id=?', h.id);
                resultCount += (rRow && rRow.c) || 0;
                const haRow = await db.get('SELECT COUNT(*) as c FROM height_attempt WHERE heat_id=?', h.id);
                heightAttemptCount += (haRow && haRow.c) || 0;
            }
            const hasResults = resultCount > 0 || heightAttemptCount > 0;

            // Build flat DB state for comparison: use Set of full key (handles duplicate lanes in field events)
            const dbFullKeys = new Set();
            for (const hd of dbHeatEntries) {
                for (const e of hd.entries) {
                    dbFullKeys.add(`${hd.heat.heat_number}|${e.lane_number}|${e.sub_group || ''}|${e.name}|${e.team}`);
                }
            }

            // Keep Excel original lane numbers (e.g., A:1-18, B:19-26) — no renumbering

            // Build flat Excel state
            const excelFullKeys = new Set();
            for (const e of entries) {
                excelFullKeys.add(`${e.heat}|${e.lane || 0}|${e.group || ''}|${e.name}|${e.team}`);
            }

            // Compare: detect changes
            const changes = [];
            let isIdentical = true;

            // Check if heats/athletes differ
            const dbAthleteSet = new Set();
            for (const hd of dbHeatEntries) {
                for (const e of hd.entries) {
                    dbAthleteSet.add(`${e.name}|${e.team}`);
                }
            }
            const excelAthleteSet = new Set();
            for (const e of entries) {
                excelAthleteSet.add(`${e.name}|${e.team}`);
            }

            // Athletes added (in Excel but not in DB)
            for (const ea of excelAthleteSet) {
                if (!dbAthleteSet.has(ea)) {
                    isIdentical = false;
                    const [name, team] = ea.split('|');
                    changes.push({ type: 'added', name, team });
                }
            }

            // Athletes removed (in DB but not in Excel)
            for (const da of dbAthleteSet) {
                if (!excelAthleteSet.has(da)) {
                    isIdentical = false;
                    const [name, team] = da.split('|');
                    changes.push({ type: 'removed', name, team });
                }
            }

            // Heat count changed
            const excelHeatNums = new Set(entries.map(e => e.heat));
            if (excelHeatNums.size !== dbHeats.length) {
                isIdentical = false;
                changes.push({ type: 'heat_count', from: dbHeats.length, to: excelHeatNums.size });
            }

            // Lane reassignment check (if same athletes but different lanes/heats)
            if (changes.length === 0) {
                if (dbFullKeys.size !== excelFullKeys.size) {
                    isIdentical = false;
                    changes.push({ type: 'lane_change', detail: `레인/순서 변경됨` });
                } else {
                    for (const key of excelFullKeys) {
                        if (!dbFullKeys.has(key)) {
                            isIdentical = false;
                            changes.push({ type: 'lane_change', detail: `레인/순서 변경됨` });
                            break;
                        }
                    }
                }
            }

            const genderLabel = gender === 'M' ? '남' : gender === 'F' ? '여' : '혼성';
            const roundLabel = round === 'preliminary' ? '예선' : round === 'semifinal' ? '준결승' : '결승';

            preview.push({
                eventKey,
                eventName: `${genderLabel} ${eventName}`,
                eventId: dbEvent.id,
                gender, round,
                status: isIdentical ? 'unchanged' : (hasResults ? 'has_results' : 'changed'),
                message: isIdentical
                    ? '변경없음 (스킵)'
                    : hasResults
                        ? `기록이 있습니다 (${resultCount + heightAttemptCount}건). 변경 시 기록이 초기화됩니다.`
                        : '변경 적용 가능',
                excelEntries: entries.length,
                dbEntries: dbHeatEntries.reduce((sum, hd) => sum + hd.entries.length, 0),
                hasResults,
                resultCount: resultCount + heightAttemptCount,
                changes,
                excelHeats: excelHeatNums.size
            });
        }

        // Sort: changed first, then has_results, then unchanged, then not_found
        const statusOrder = { changed: 0, has_results: 1, unchanged: 2, not_found: 3 };
        preview.sort((a, b) => (statusOrder[a.status] || 9) - (statusOrder[b.status] || 9));

        res.json({
            success: true,
            sheetName,
            totalRows,
            eventCount: eventGroups.size,
            preview,
            mergeWarnings: mergeWarnings || []
        });
    } catch (err) {
        console.error('[Heat Assignment Preview Error]', err);
        res.status(500).json({ error: '조편성 미리보기 오류: ' + err.message });
    }
});

// /api/heat-assignment/create-events removed — was never called from any client.
// The /api/heat-assignment/apply route now creates missing events inline as part of its transaction.

// APPLY API — Actually update heats based on Excel
app.post('/api/heat-assignment/apply', upload.single('file'), async (req, res) => {
    if (!isAdminKey(req.body.admin_key || req.headers['x-admin-key'])) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    if (!req.file) return res.status(400).json({ error: '파일이 필요합니다.' });
    const competition_id = parseInt(req.body.competition_id);
    if (!competition_id) return res.status(400).json({ error: 'competition_id 필요' });

    // forceEventIds: comma-separated event IDs to force update even if results exist
    const forceEventIds = new Set(
        (req.body.force_event_ids || '').split(',').map(s => parseInt(s.trim())).filter(n => n > 0)
    );

    try {
        // Validate competition exists
        const comp = await db.get('SELECT id FROM competition WHERE id=?', competition_id);
        if (!comp) {
            return res.status(400).json({ success: false, error: `대회를 찾을 수 없습니다 (ID: ${competition_id})` });
        }

        const { eventGroups, mergeWarnings } = parseHeatAssignmentExcel(req.file.path);
        const stats = { updated: 0, skipped: 0, skippedUnchanged: 0, skippedHasResults: 0, notFound: 0, athletesAdded: 0, entriesCreated: 0 };

        await db.transaction(async () => {
            // Cache all athletes for this competition by name+team
            const athleteCache = new Map();
            (await db.all('SELECT * FROM athlete WHERE competition_id=?', competition_id))
                .forEach(a => {
                    athleteCache.set(`${a.name}|${a.team}|${a.gender}`, a);
                    // Also index by name+team (without gender) for flexible matching
                    if (!athleteCache.has(`${a.name}|${a.team}`)) {
                        athleteCache.set(`${a.name}|${a.team}`, a);
                    }
                });
            
            // (PG 호환: sync prepare 제거. 아래 루프에서 await db.run 사용.)

            // Build scoreboard_key: look up federation gender labels for this competition
            const comp = await db.get('SELECT * FROM competition WHERE id=?', competition_id);
            let _sbLabelM = '', _sbLabelF = '', _sbLabelX = '';
            if (comp && comp.federation) {
                const fed = await db.get('SELECT * FROM federation_list WHERE code=?', comp.federation);
                if (fed) {
                    _sbLabelM = fed.gender_label_m || '';
                    _sbLabelF = fed.gender_label_f || '';
                    _sbLabelX = fed.gender_label_x || '';
                }
            }
            function buildScoreboardKey(gender, eventName, roundType, heatNum, totalHeats) {
                const gLabel = gender === 'M' ? _sbLabelM : gender === 'F' ? _sbLabelF : _sbLabelX;
                if (!gLabel) return null; // no federation label configured → skip
                const rLabel = { preliminary: '예선', semifinal: '준결승', final: '결승' }[roundType] || roundType;
                // 결승이 1조뿐이면 "조" 생략 (예: "남자실업부 100m 결승")
                if (roundType === 'final' && totalHeats === 1) {
                    return `${gLabel} ${eventName} ${rLabel}`;
                }
                return `${gLabel} ${eventName} ${rLabel} ${heatNum}조`;
            }
            for (const [eventKey, group] of eventGroups) {
                const { gender, eventName, round, entries } = group;

                // Keep Excel original lane numbers — no renumbering
                // Excel has sequential lane numbers across groups (A:1-18, B:19-26) and that's correct

                // Find matching event in DB
                let dbEvent = null;
                if (gender && gender !== '?') {
                    dbEvent = await db.get('SELECT * FROM event WHERE competition_id=? AND name=? AND gender=? AND round_type=? AND parent_event_id IS NULL', competition_id, eventName, gender, round);
                }
                if (!dbEvent && gender && gender !== '?') {
                    dbEvent = await db.get('SELECT * FROM event WHERE competition_id=? AND name=? AND gender=? AND parent_event_id IS NULL', competition_id, eventName, gender);
                }
                // Fallback: try without parent_event_id constraint (for child events like [10종] 100m, [7종] 100mH)
                if (!dbEvent && gender && gender !== '?') {
                    dbEvent = await db.get('SELECT * FROM event WHERE competition_id=? AND name=? AND gender=? AND round_type=?', competition_id, eventName, gender, round);
                }
                if (!dbEvent && gender && gender !== '?') {
                    dbEvent = await db.get('SELECT * FROM event WHERE competition_id=? AND name=? AND gender=?', competition_id, eventName, gender);
                }

                if (!dbEvent) {
                    stats.notFound++;
                    continue;
                }

                // Get current DB state
                const dbHeats = await db.all('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number', dbEvent.id);
                
                // Check if data is identical (quick comparison: same athlete count and names)
                const dbAthleteNames = new Set();
                for (const h of dbHeats) {
                    const hEntries = await db.all(`
                        SELECT a.name, a.team FROM heat_entry he
                        JOIN event_entry ee ON ee.id = he.event_entry_id
                        JOIN athlete a ON a.id = ee.athlete_id
                        WHERE he.heat_id = ?
                    `, h.id);
                    hEntries.forEach(e => dbAthleteNames.add(`${e.name}|${e.team}`));
                }
                const excelAthleteNames = new Set(entries.map(e => `${e.name}|${e.team}`));
                
                // Deep comparison: check if heats, lanes, and athletes are all the same
                let isIdentical = dbAthleteNames.size === excelAthleteNames.size;
                if (isIdentical) {
                    for (const n of excelAthleteNames) {
                        if (!dbAthleteNames.has(n)) { isIdentical = false; break; }
                    }
                }
                if (isIdentical) {
                    // Also check lane assignments (use Set of full keys to handle duplicate lanes in field events)
                    const dbStateSet = new Set();
                    for (const h of dbHeats) {
                        const hEntries = await db.all(`
                            SELECT he.lane_number, he.sub_group, a.name, a.team
                            FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id
                            JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=?
                        `, h.id);
                        hEntries.forEach(e => dbStateSet.add(`${h.heat_number}|${e.lane_number}|${e.sub_group || ''}|${e.name}|${e.team}`));
                    }
                    const excelStateSet = new Set();
                    for (const e of entries) {
                        excelStateSet.add(`${e.heat}|${e.lane || 0}|${e.group || ''}|${e.name}|${e.team}`);
                    }
                    if (dbStateSet.size !== excelStateSet.size) {
                        isIdentical = false;
                    } else {
                        for (const key of excelStateSet) {
                            if (!dbStateSet.has(key)) { isIdentical = false; break; }
                        }
                    }
                }

                if (isIdentical) {
                    stats.skippedUnchanged++;
                    stats.skipped++;
                    continue;
                }

                // Check if results exist
                let resultCount = 0;
                for (const h of dbHeats) {
                    const rRow = await db.get('SELECT COUNT(*) as c FROM result WHERE heat_id=?', h.id);
                    resultCount += (rRow && rRow.c) || 0;
                    const haRow = await db.get('SELECT COUNT(*) as c FROM height_attempt WHERE heat_id=?', h.id);
                    resultCount += (haRow && haRow.c) || 0;
                }

                if (resultCount > 0 && !forceEventIds.has(dbEvent.id)) {
                    stats.skippedHasResults++;
                    stats.skipped++;
                    continue;
                }

                // === APPLY CHANGES ===
                
                // 1. Delete existing heats, heat_entries, results for this event
                for (const h of dbHeats) {
                    await db.run('DELETE FROM result WHERE heat_id=?', h.id);
                    await db.run('DELETE FROM height_attempt WHERE heat_id=?', h.id);
                    await db.run('DELETE FROM heat_entry WHERE heat_id=?', h.id);
                }
                await db.run('DELETE FROM heat WHERE event_id=?', dbEvent.id);

                // 2. For relay events: also clear old event_entries (team "athletes")
                const isRelay = dbEvent.category === 'relay';

                // 3. Group entries by heat number
                const heatGroups = new Map();
                for (const e of entries) {
                    if (!heatGroups.has(e.heat)) heatGroups.set(e.heat, []);
                    heatGroups.get(e.heat).push(e);
                }

                // 3.5 Re-number heats sequentially (1,2,3...) if Excel has gaps or wrong numbers
                // e.g., Excel says heat=3 but only 1 heat exists → renumber to 1
                const sortedHeatKeys = [...heatGroups.keys()].sort((a, b) => a - b);
                const heatRenumberMap = new Map();
                sortedHeatKeys.forEach((origNum, idx) => {
                    heatRenumberMap.set(origNum, idx + 1);
                });

                // 4. Create heats and heat entries
                for (const [origHeatNum, heatEntries] of [...heatGroups].sort((a, b) => a[0] - b[0])) {
                    const heatNum = heatRenumberMap.get(origHeatNum);
                    const sbKey = buildScoreboardKey(gender, eventName, round, heatNum, heatGroups.size);
                    const heatRow = await db.run('INSERT INTO heat (event_id,heat_number,scoreboard_key) VALUES (?,?,?)', dbEvent.id, heatNum, sbKey);
                    const heatId = heatRow.lastInsertRowid;

                    for (const entry of heatEntries) {
                        // Find or create athlete
                        let athlete = null;
                        const effGender = gender === 'X' ? 'M' : gender;

                        if (isRelay) {
                            // Relay: entry.name is team name
                            athlete = athleteCache.get(`${entry.name}|${entry.name}|${effGender}`)
                                || athleteCache.get(`${entry.name}|${entry.team}|${effGender}`)
                                || athleteCache.get(`${entry.name}|${entry.name}`);
                        } else {
                            // Individual: find by name+team+gender, then name+team
                            athlete = athleteCache.get(`${entry.name}|${entry.team}|${effGender}`)
                                || athleteCache.get(`${entry.name}|${entry.team}`);
                            
                            // Also try finding by bib number if provided
                            // IMPORTANT: Only match if name also matches to prevent wrong athlete assignment
                            if (!athlete && entry.bib) {
                                const byBib = await db.get('SELECT * FROM athlete WHERE competition_id=? AND bib_number=?', competition_id, String(entry.bib));
                                if (byBib && byBib.name === entry.name) {
                                    athlete = byBib;
                                }
                                // If bib matches but name differs, it's a different athlete — do NOT use
                            }
                        }

                        if (!athlete) {
                            // Create new athlete — bib only if provided and not already taken
                            let newBib = entry.bib ? String(entry.bib) : null;
                            if (newBib) {
                                const bibTaken = await db.get('SELECT id FROM athlete WHERE competition_id=? AND bib_number=? AND gender=?', competition_id, newBib, effGender || 'M');
                                if (bibTaken) newBib = null; // bib already used by another athlete of same gender, leave NULL
                            }
                            // Do NOT auto-assign bib — keep NULL if not provided
                            const bc = ''; // barcode managed by user
                            const newGender = isRelay ? (effGender || 'M') : (effGender || 'M');
                            const r = await db.run('INSERT INTO athlete (competition_id,name,bib_number,team,barcode,gender) VALUES (?,?,?,?,?,?)', competition_id, entry.name, newBib, entry.team || entry.name, bc, newGender);
                            athlete = { id: r.lastInsertRowid, name: entry.name, bib_number: newBib, team: entry.team || entry.name, gender: newGender };
                            athleteCache.set(`${entry.name}|${entry.team || entry.name}|${newGender}`, athlete);
                            athleteCache.set(`${entry.name}|${entry.team || entry.name}`, athlete);
                            stats.athletesAdded++;
                        } else if (entry.bib && !athlete.bib_number) {
                            // Athlete exists but has no bib — update from heat assignment data
                            const bibStr = String(entry.bib);
                            const bibTaken = await db.get('SELECT id FROM athlete WHERE competition_id=? AND bib_number=? AND gender=? AND id!=?', competition_id, bibStr, athlete.gender || effGender || 'M', athlete.id);
                            if (!bibTaken) {
                                await db.run('UPDATE athlete SET bib_number=? WHERE id=? AND bib_number IS NULL', bibStr, athlete.id);
                                athlete.bib_number = bibStr;
                            }
                        }

                        // Ensure event_entry exists
                        const entryResult = await db.run("INSERT OR IGNORE INTO event_entry (event_id,athlete_id,status) VALUES (?,?,'registered')", dbEvent.id, athlete.id);
                        let eventEntryId = entryResult.changes > 0 ? entryResult.lastInsertRowid : null;
                        if (!eventEntryId) {
                            const existing = await db.get('SELECT id FROM event_entry WHERE event_id=? AND athlete_id=?', dbEvent.id, athlete.id);
                            eventEntryId = existing ? existing.id : null;
                        }

                        if (eventEntryId) {
                            // Prevent UNIQUE constraint violation: skip if this event_entry is already in this heat
                            const alreadyInHeat = await db.get('SELECT id FROM heat_entry WHERE heat_id=? AND event_entry_id=?', heatId, eventEntryId);
                            if (!alreadyInHeat) {
                                await db.run('INSERT INTO heat_entry (heat_id,event_entry_id,lane_number,sub_group) VALUES (?,?,?,?)', heatId, eventEntryId, entry.lane, entry.group || null);
                                stats.entriesCreated++;
                            }
                        }
                    }
                }

                // 5. COMBINED (10종/7종) SUB-EVENT FIX:
                //    When applying heat assignment to a combined sub-event (e.g., [7종] 100mH),
                //    the Excel may only contain athletes competing on a specific day.
                //    But ALL parent event athletes must be in each sub-event's heat_entry
                //    for call-room and result entry to work properly.
                //    → After processing Excel entries, add missing parent athletes to the heat.
                if (dbEvent.parent_event_id) {
                    const parentEvt = await db.get('SELECT * FROM event WHERE id=?', dbEvent.parent_event_id);
                    if (parentEvt && parentEvt.category === 'combined') {
                        // Get all athletes from parent event_entry
                        const parentEntries = await db.all('SELECT ee.athlete_id, a.name, a.team FROM event_entry ee JOIN athlete a ON ee.athlete_id=a.id WHERE ee.event_id=?', dbEvent.parent_event_id);
                        
                        // Get currently assigned heat(s) for this sub-event
                        const currentHeats = await db.all('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number', dbEvent.id);
                        // Use the first heat (combined sub-events typically have 1 heat)
                        let targetHeatId = currentHeats.length > 0 ? currentHeats[0].id : null;
                        if (!targetHeatId) {
                            // No heat exists yet → create one
                            const sbKey = buildScoreboardKey(gender, eventName, round, 1, 1);
                            const hRow = await db.run('INSERT INTO heat (event_id,heat_number,scoreboard_key) VALUES (?,?,?)', dbEvent.id, 1, sbKey);
                            targetHeatId = hRow.lastInsertRowid;
                        }
                        
                        // Find max lane number currently in this heat
                        const maxLane = await db.get('SELECT MAX(lane_number) as m FROM heat_entry WHERE heat_id=?', targetHeatId);
                        let nextLane = (maxLane && maxLane.m) ? maxLane.m + 1 : 1;
                        
                        for (const pEntry of parentEntries) {
                            // Ensure event_entry exists in sub-event
                            const eeResult = await db.run("INSERT OR IGNORE INTO event_entry (event_id,athlete_id,status) VALUES (?,?,'registered')", dbEvent.id, pEntry.athlete_id);
                            let eeId = eeResult.changes > 0 ? eeResult.lastInsertRowid : null;
                            if (!eeId) {
                                const existing = await db.get('SELECT id FROM event_entry WHERE event_id=? AND athlete_id=?', dbEvent.id, pEntry.athlete_id);
                                eeId = existing ? existing.id : null;
                            }
                            if (!eeId) continue;
                            
                            // Check if already in any heat for this sub-event
                            const alreadyAssigned = await db.get('SELECT he.id FROM heat_entry he JOIN heat h ON he.heat_id=h.id WHERE h.event_id=? AND he.event_entry_id=?', dbEvent.id, eeId);
                            
                            if (!alreadyAssigned) {
                                // Not in heat → add to the target heat with next available lane
                                await db.run('INSERT INTO heat_entry (heat_id,event_entry_id,lane_number,sub_group) VALUES (?,?,?,?)', targetHeatId, eeId, nextLane++, null);
                                stats.entriesCreated++;
                            }
                        }
                    }
                }

                // 5b. Handle athletes no longer in this event's heats
                //    We do NOT delete event_entry rows — they may be referenced by
                //    combined_score, qualification_selection, relay_member, or sub-events.
                //    The athlete is simply not in any heat anymore (effectively DNS).
                //    This is safe because heat_entry rows were already deleted above.

                // 6. RELAY: Auto-populate relay_member from team roster
                //    For each relay team entry, find athletes belonging to the same team
                //    and add them as relay_member if not already present.
                if (isRelay) {
                    const allEventEntries = await db.all('SELECT ee.id, ee.athlete_id, a.name, a.team FROM event_entry ee JOIN athlete a ON ee.athlete_id=a.id WHERE ee.event_id=?', dbEvent.id);
                    
                    for (const teamEntry of allEventEntries) {
                        // "Team athlete" records: name === team (e.g., name='광주광역시청', team='광주광역시청')
                        if (teamEntry.name !== teamEntry.team) continue;
                        
                        // Check if this team entry already has relay members
                        const existingMembersRow = await db.get('SELECT COUNT(*) AS c FROM relay_member WHERE event_entry_id=?', teamEntry.id);
                        const existingMembers = (existingMembersRow && existingMembersRow.c) || 0;
                        if (existingMembers > 0) continue; // Already has members, skip
                        
                        // Find individual athletes from the same team
                        const effGender = gender === 'X' ? null : gender; // For mixed, accept any gender
                        let teamAthletes;
                        if (effGender) {
                            teamAthletes = await db.all('SELECT id, name, team FROM athlete WHERE competition_id=? AND team=? AND gender=? AND name!=team ORDER BY id', competition_id, teamEntry.team, effGender);
                        } else {
                            teamAthletes = await db.all('SELECT id, name, team FROM athlete WHERE competition_id=? AND team=? AND name!=team ORDER BY id', competition_id, teamEntry.team);
                        }
                        
                        // Add each athlete as relay member
                        let legOrder = 1;
                        for (const ath of teamAthletes) {
                            await db.run('INSERT OR IGNORE INTO relay_member (event_entry_id, athlete_id, leg_order) VALUES (?,?,?)', teamEntry.id, ath.id, legOrder++);
                        }
                        if (teamAthletes.length > 0) {
                            stats.relayMembersAdded = (stats.relayMembersAdded || 0) + teamAthletes.length;
                        }
                    }
                }

                stats.updated++;
            }
        })();

        opLog(`조편성 업로드: ${stats.updated}개 종목 변경, ${stats.skippedUnchanged}개 스킵(변경없음), ${stats.skippedHasResults}개 스킵(기록있음)${stats.relayMembersAdded ? ', 릴레이 멤버 ' + stats.relayMembersAdded + '명 자동등록' : ''}`, 'import', 'admin', competition_id);
        res.json({ success: true, message: '조편성 적용 완료', stats, mergeWarnings: mergeWarnings || [] });
    } catch (err) {
        console.error('[Heat Assignment Apply Error]', err);
        res.status(500).json({ error: '조편성 적용 오류: ' + err.message });
    }
});

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
// 전광판 (Scoreboard) .lif File Import
// ============================================================

/**
 * Parse a .lif file buffer (UTF-16 LE with BOM).
 * Returns { header: { status, competitionNum, eventNum, eventName, scoreboardKey, timestamp }, rows: [...] }
 */
function parseLifBuffer(buffer) {
    // Decode UTF-16 LE (may have BOM)
    let text;
    if (buffer[0] === 0xFF && buffer[1] === 0xFE) {
        text = buffer.toString('utf16le'); // Node handles BOM
    } else {
        // Try utf16le anyway
        text = buffer.toString('utf16le');
    }
    // Remove BOM if present
    text = text.replace(/^\uFEFF/, '');
    
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length === 0) throw new Error('.lif 파일이 비어 있습니다.');

    // Parse header line
    const hParts = lines[0].split(',');
    const status = (hParts[0] || '').trim();
    const competitionNum = (hParts[1] || '').trim();
    const eventNum = (hParts[2] || '').trim();
    const rawEventName = (hParts[3] || '').trim();
    const timestamp = (hParts[hParts.length - 1] || '').trim();

    // Extract wind speed from header
    // When wind data is present: hParts[4] = wind value (e.g., "-1.8"), hParts[5] contains "m/s"
    // When no wind: hParts[4] is empty or does not pair with "m/s" in hParts[5]
    let wind = null;
    const windCandidate = (hParts[4] || '').trim();
    const windUnit = (hParts[5] || '').trim();
    if (windCandidate && windUnit && /m\/s/i.test(windUnit)) {
        const parsedWind = parseFloat(windCandidate);
        if (!isNaN(parsedWind)) {
            wind = parsedWind;
        }
    }

    // Extract scoreboard_key from event name
    // e.g., "남초부 60m 예선 1조 (2+4)" → scoreboard_key = "남초부 60m 예선 1조"
    // e.g., "여중부 100mH 결승" → scoreboard_key = "여중부 100mH 결승" (keep as-is for finals)
    let scoreboardKey = rawEventName
        .replace(/\s*\([\d\+]+\)\s*$/, '')   // Remove "(2+4)" suffix
        .trim();

    // If no "N조" suffix and it's NOT a final, append "1조" for matching
    // Finals with single heat should NOT have "1조" appended
    if (!/\d+조$/.test(scoreboardKey)) {
        // Check if this looks like a final (contains 결승)
        if (!/결승/.test(scoreboardKey)) {
            scoreboardKey += ' 1조';
        }
    }

    // Parse data rows
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(',');
        const rank = (parts[0] || '').trim();
        const bib = (parts[1] || '').trim();
        const lane = (parts[2] || '').trim();
        // parts[3] is usually empty
        const name = (parts[4] || '').trim();
        const team = (parts[5] || '').trim();
        const rawTime = (parts[6] || '').trim();
        // parts[7] empty
        const timeDiffOrAbs = (parts[8] || '').trim(); // For rank=1 this is absolute time, for others it's diff

        // Determine row type
        if (!rank && !bib && lane) {
            // Empty lane
            rows.push({ type: 'empty', lane: parseInt(lane) });
        } else if (rank === 'DNS') {
            rows.push({ type: 'DNS', bib, lane: parseInt(lane), name, team });
        } else if (rank === 'DNF') {
            rows.push({ type: 'DNF', bib, lane: parseInt(lane), name, team });
        } else if (rank === 'DQ') {
            rows.push({ type: 'DQ', bib, lane: parseInt(lane), name, team });
        } else if (rank && bib && name) {
            // Valid result row
            const time = parseFloat(rawTime);
            rows.push({
                type: 'result',
                rank: parseInt(rank),
                bib,
                lane: parseInt(lane),
                name,
                team,
                time: isNaN(time) ? null : time,
            });
        }
    }

    return {
        header: {
            status,
            competitionNum,
            eventNum,
            eventName: rawEventName,
            scoreboardKey,
            timestamp,
            wind,
        },
        rows,
    };
}

/**
 * POST /api/scoreboard/preview
 * Upload .lif files and preview parsed data + matching status
 */
app.post('/api/scoreboard/preview', upload.array('files', 50), async (req, res) => {
    try {
        const { competition_id } = req.body;
        if (!competition_id) return res.status(400).json({ error: 'competition_id 필수' });

        const files = req.files;
        if (!files || files.length === 0) return res.status(400).json({ error: '.lif 파일을 선택해 주세요.' });

        const results = [];
        for (const file of files) {
            try {
                const buf = fs.readFileSync(file.path);
                const parsed = parseLifBuffer(buf);

                // Try to find matching heat by scoreboard_key
                let heat = await db.get(`
                    SELECT h.*, e.name as event_name, e.gender, e.round_type, e.competition_id as comp_id
                    FROM heat h
                    JOIN event e ON e.id = h.event_id
                    WHERE h.scoreboard_key = ? AND e.competition_id = ?
                `, parsed.header.scoreboardKey, competition_id);

                // Fallback: try joint_scoreboard_key
                if (!heat) {
                    const jg = await db.get('SELECT * FROM joint_group WHERE joint_scoreboard_key = ?', parsed.header.scoreboardKey);
                    if (jg) {
                        const members = await db.all('SELECT event_id FROM joint_group_member WHERE joint_group_id = ?', jg.id);
                        for (const m of members) {
                            const mh = await db.get(`SELECT h.*, e.name as event_name, e.gender, e.round_type, e.competition_id as comp_id
                                FROM heat h JOIN event e ON e.id=h.event_id WHERE h.event_id=? AND e.competition_id=? ORDER BY h.heat_number LIMIT 1`, m.event_id, competition_id);
                            if (mh) { heat = mh; break; }
                        }
                        // If not in this competition, use any
                        if (!heat) {
                            for (const m of members) {
                                const mh = await db.get(`SELECT h.*, e.name as event_name, e.gender, e.round_type, e.competition_id as comp_id
                                    FROM heat h JOIN event e ON e.id=h.event_id WHERE h.event_id=? ORDER BY h.heat_number LIMIT 1`, m.event_id);
                                if (mh) { heat = mh; break; }
                            }
                        }
                    }
                }

                let matchStatus = 'not_found';
                let heatInfo = null;
                let athleteMatches = [];

                if (heat) {
                    matchStatus = 'matched';
                    heatInfo = {
                        heat_id: heat.id,
                        event_name: heat.event_name,
                        gender: heat.gender,
                        round_type: heat.round_type,
                        heat_number: heat.heat_number,
                        scoreboard_key: heat.scoreboard_key,
                    };

                    // Check athlete matches for each result row
                    const heatEntries = await db.all(`
                        SELECT he.*, ee.athlete_id, ee.id as event_entry_id,
                               a.name, a.bib_number, a.team
                        FROM heat_entry he
                        JOIN event_entry ee ON ee.id = he.event_entry_id
                        JOIN athlete a ON a.id = ee.athlete_id
                        WHERE he.heat_id = ?
                    `, heat.id);

                    for (const row of parsed.rows) {
                        if (row.type === 'empty') continue;

                        let matchedEntry = null;
                        let matchMethod = 'none';

                        // 1. Match by BIB number
                        if (row.bib) {
                            matchedEntry = heatEntries.find(e => e.bib_number === row.bib);
                            if (matchedEntry) matchMethod = 'bib';
                        }

                        // 2. Fallback: match by lane number
                        if (!matchedEntry && row.lane) {
                            matchedEntry = heatEntries.find(e => e.lane_number === row.lane);
                            if (matchedEntry) matchMethod = 'lane';
                        }

                        // 3. Fallback: match by name
                        if (!matchedEntry && row.name) {
                            matchedEntry = heatEntries.find(e => e.name === row.name);
                            if (matchedEntry) matchMethod = 'name';
                        }

                        athleteMatches.push({
                            lif_rank: row.rank || row.type,
                            lif_bib: row.bib,
                            lif_lane: row.lane,
                            lif_name: row.name,
                            lif_team: row.team,
                            lif_time: row.time,
                            lif_type: row.type,
                            db_name: matchedEntry?.name || null,
                            db_bib: matchedEntry?.bib_number || null,
                            db_team: matchedEntry?.team || null,
                            db_lane: matchedEntry?.lane_number || null,
                            event_entry_id: matchedEntry?.event_entry_id || null,
                            heat_entry_id: matchedEntry?.id || null,
                            match_method: matchMethod,
                        });
                    }
                }

                results.push({
                    filename: file.originalname,
                    header: parsed.header,
                    rows: parsed.rows,
                    matchStatus,
                    heatInfo,
                    athleteMatches,
                });
            } catch (parseErr) {
                results.push({
                    filename: file.originalname,
                    error: parseErr.message,
                    matchStatus: 'error',
                });
            } finally {
                // Cleanup temp file
                try { fs.unlinkSync(file.path); } catch(e) {}
            }
        }

        res.json({ success: true, results });
    } catch (err) {
        console.error('[Scoreboard Preview]', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/scoreboard/import
 * Apply .lif results to DB — upsert results for matched athletes
 */
app.post('/api/scoreboard/import', upload.array('files', 50), async (req, res) => {
    try {
        const { competition_id } = req.body;
        if (!competition_id) return res.status(400).json({ error: 'competition_id 필수' });

        const files = req.files;
        if (!files || files.length === 0) return res.status(400).json({ error: '.lif 파일을 선택해 주세요.' });

        const importResults = [];
        const importTx = db.transaction(async () => {
            for (const file of files) {
                let buf, parsed;
                try {
                    buf = fs.readFileSync(file.path);
                    parsed = parseLifBuffer(buf);
                } catch (parseErr) {
                    importResults.push({ filename: file.originalname, error: parseErr.message, imported: 0, skipped: 0 });
                    try { fs.unlinkSync(file.path); } catch(e) {}
                    continue;
                }

                // Find heat — first try direct scoreboard_key match
                let heat = await db.get(`
                    SELECT h.*, e.name as event_name, e.gender, e.round_type, e.category,
                           e.competition_id as comp_id, e.id as event_id
                    FROM heat h
                    JOIN event e ON e.id = h.event_id
                    WHERE h.scoreboard_key = ? AND e.competition_id = ?
                `, parsed.header.scoreboardKey, competition_id);

                // If no direct match, try joint_scoreboard_key — find all heats in this joint group
                let jointHeats = [];
                if (!heat) {
                    const jointGroup = await db.get(`SELECT jg.* FROM joint_group jg WHERE jg.joint_scoreboard_key = ?`, parsed.header.scoreboardKey);
                    if (jointGroup) {
                        const members = await db.all(`SELECT jgm.event_id FROM joint_group_member jgm WHERE jgm.joint_group_id = ?`, jointGroup.id);
                        for (const m of members) {
                            const mHeat = await db.get(`
                                SELECT h.*, e.name as event_name, e.gender, e.round_type, e.category,
                                       e.competition_id as comp_id, e.id as event_id
                                FROM heat h JOIN event e ON e.id = h.event_id
                                WHERE h.event_id = ? ORDER BY h.heat_number LIMIT 1
                            `, m.event_id);
                            if (mHeat) jointHeats.push(mHeat);
                        }
                        // Use the first heat that belongs to this competition as primary
                        heat = jointHeats.find(h => String(h.comp_id) === String(competition_id));
                        if (!heat && jointHeats.length > 0) heat = jointHeats[0];
                    }
                }

                if (!heat) {
                    importResults.push({
                        filename: file.originalname,
                        scoreboardKey: parsed.header.scoreboardKey,
                        error: `매칭되는 조를 찾을 수 없습니다: "${parsed.header.scoreboardKey}"`,
                        imported: 0, skipped: 0,
                    });
                    try { fs.unlinkSync(file.path); } catch(e) {}
                    continue;
                }

                // Get heat entries — include all joint heat entries for athlete matching
                let heatEntries = await db.all(`
                    SELECT he.*, ee.athlete_id, ee.id as event_entry_id,
                           a.name, a.bib_number, a.team, ? as source_heat_id
                    FROM heat_entry he
                    JOIN event_entry ee ON ee.id = he.event_entry_id
                    JOIN athlete a ON a.id = ee.athlete_id
                    WHERE he.heat_id = ?
                `, heat.id, heat.id);

                // If joint import, also gather entries from other joint heats
                if (jointHeats.length > 1) {
                    for (const jh of jointHeats) {
                        if (jh.id === heat.id) continue;
                        const jhEntries = await db.all(`
                            SELECT he.*, ee.athlete_id, ee.id as event_entry_id,
                                   a.name, a.bib_number, a.team, ? as source_heat_id
                            FROM heat_entry he
                            JOIN event_entry ee ON ee.id = he.event_entry_id
                            JOIN athlete a ON a.id = ee.athlete_id
                            WHERE he.heat_id = ?
                        `, jh.id, jh.id);
                        heatEntries = heatEntries.concat(jhEntries);
                    }
                }

                let imported = 0, skipped = 0;
                const details = [];

                for (const row of parsed.rows) {
                    if (row.type === 'empty') continue;

                    // Match athlete
                    let matchedEntry = null;

                    // 1. BIB match
                    if (row.bib) {
                        matchedEntry = heatEntries.find(e => e.bib_number === row.bib);
                    }
                    // 2. Lane match
                    if (!matchedEntry && row.lane) {
                        matchedEntry = heatEntries.find(e => e.lane_number === row.lane);
                    }
                    // 3. Name match
                    if (!matchedEntry && row.name) {
                        matchedEntry = heatEntries.find(e => e.name === row.name);
                    }

                    if (!matchedEntry) {
                        skipped++;
                        details.push({ name: row.name, bib: row.bib, reason: '매칭 실패' });
                        continue;
                    }

                    const heat_id = matchedEntry.source_heat_id || heat.id;
                    const event_entry_id = matchedEntry.event_entry_id;

                    // Determine status_code and time
                    let time_seconds = null;
                    let status_code = '';

                    if (row.type === 'DNS') {
                        status_code = 'DNS';
                    } else if (row.type === 'DNF') {
                        status_code = 'DNF';
                    } else if (row.type === 'DQ') {
                        status_code = 'DQ';
                    } else if (row.type === 'result') {
                        time_seconds = row.time;
                    }

                    // Upsert result
                    const existing = await db.get('SELECT * FROM result WHERE heat_id=? AND event_entry_id=? AND attempt_number IS NULL ORDER BY id DESC LIMIT 1', heat_id, event_entry_id);

                    if (existing) {
                        const _nowFR2 = db.isAsync ? 'NOW()' : "datetime('now')";
                        await db.run(`UPDATE result SET time_seconds=?,status_code=?,remark=?,updated_at=${_nowFR2} WHERE id=?`, time_seconds, status_code, '', existing.id);
                        const upd = await db.get('SELECT * FROM result WHERE id=?', existing.id);
                        audit('result', existing.id, 'UPDATE', existing, upd, 'scoreboard', null, req);
                    } else {
                        const info = await db.run('INSERT INTO result (heat_id,event_entry_id,time_seconds,status_code,remark) VALUES (?,?,?,?,?)', heat_id, event_entry_id, time_seconds, status_code, '');
                        const ins = await db.get('SELECT * FROM result WHERE id=?', info.lastInsertRowid);
                        audit('result', ins.id, 'INSERT', null, ins, 'scoreboard', null, req);
                    }

                    imported++;
                    details.push({ name: row.name, bib: row.bib, time: time_seconds, status: status_code || 'OK' });
                }

                // Auto-save wind from .lif to heat (if wind data present)
                let windImported = null;
                if (parsed.header.wind != null) {
                    const windStr = parsed.header.wind.toFixed(1) + ' m/s';
                    // Apply wind to all joint heats
                    const windHeats = jointHeats.length > 0 ? jointHeats : [heat];
                    for (const wh of windHeats) {
                        await db.run('UPDATE heat SET wind=? WHERE id=?', windStr, wh.id);
                        broadcastSSE('wind_update', { heat_id: wh.id, wind: windStr });
                    }
                    windImported = windStr;
                }

                // Auto-update event round_status to in_progress (all joint events)
                const statusHeats = jointHeats.length > 0 ? jointHeats : [heat];
                for (const sh of statusHeats) {
                    const event = await db.get('SELECT * FROM event WHERE id=?', sh.event_id);
                    if (event && (event.round_status === 'heats_generated' || event.round_status === 'created') && imported > 0) {
                        await db.run("UPDATE event SET round_status='in_progress' WHERE id=?", event.id);
                        broadcastSSE('event_status_changed', { event_id: event.id, round_status: 'in_progress' });
                    }
                }

                // Broadcast result updates (all joint heats)
                if (imported > 0) {
                    for (const rh of (jointHeats.length > 0 ? jointHeats : [heat])) {
                        broadcastSSE('result_update', { heat_id: rh.id, bulk: true });
                    }
                }

                const gL = heat.gender === 'M' ? '남자' : heat.gender === 'F' ? '여자' : '혼성';
                const rL = { preliminary: '예선', semifinal: '준결승', final: '결승' }[heat.round_type] || heat.round_type;
                const windLog = windImported != null ? ` / 풍속 ${windImported}` : '';
                opLog(`전광판 연동: ${heat.event_name} ${rL} ${gL} ${heat.heat_number}조 — ${imported}건 입력${windLog}`, 'record', 'scoreboard', competition_id);

                importResults.push({
                    filename: file.originalname,
                    scoreboardKey: parsed.header.scoreboardKey,
                    heatInfo: {
                        heat_id: heat.id,
                        event_name: heat.event_name,
                        heat_number: heat.heat_number,
                    },
                    wind: windImported,
                    imported,
                    skipped,
                    details,
                });

                try { fs.unlinkSync(file.path); } catch(e) {}
            }
        });

        await importTx();
        res.json({ success: true, results: importResults });
    } catch (err) {
        console.error('[Scoreboard Import]', err);
        res.status(500).json({ error: err.message });
    }
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
}

const DOC_DEFAULTS = {
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
                result_sheet: { ...DOC_DEFAULTS.result_sheet, ...JSON.parse(row.result_sheet || '{}') }
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
    await db.run('INSERT INTO doc_template (competition_id, ad_card, start_list, result_sheet) VALUES (?, ?, ?, ?) ON CONFLICT(competition_id) DO UPDATE SET ad_card=excluded.ad_card, start_list=excluded.start_list, result_sheet=excluded.result_sheet', competition_id, ad, sl, rs);
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
require('./lib/routes/timetable')(app, { db, isAdminKey, isOperationKey, opLog, upload, XLSX });

// ============================================================
// PDF DOCUMENT GENERATION — WA-Style Professional Layout
// ============================================================
// Bundled fonts — always available regardless of server OS
const FONT_PATH_REGULAR = path.join(__dirname, 'public', 'fonts', 'NanumSquare_acR.ttf');
const FONT_PATH_BOLD = path.join(__dirname, 'public', 'fonts', 'NanumSquare_acB.ttf');
const FONT_PATH_AUDIOWIDE = path.join(__dirname, 'public', 'fonts', 'Audiowide-Regular.ttf');
const FONT_AVAILABLE = fs.existsSync(FONT_PATH_REGULAR);
const AUDIOWIDE_AVAILABLE = fs.existsSync(FONT_PATH_AUDIOWIDE);
if (!FONT_AVAILABLE) console.warn('[WARN] Korean fonts not found at', FONT_PATH_REGULAR);
if (!AUDIOWIDE_AVAILABLE) console.warn('[WARN] Audiowide font not found at', FONT_PATH_AUDIOWIDE);

function pdfFont(doc, bold) {
    if (FONT_AVAILABLE) {
        doc.font(bold ? FONT_PATH_BOLD : FONT_PATH_REGULAR);
    }
    return doc;
}

// PACE RISE theme colors
const PR_GREEN = '#2d9d78';
const PR_GREEN_DARK = '#1e7a5c';
const PR_GREEN_LIGHT = '#e8f5f0';
const PR_HEADER_BG = '#2d9d78';
const PR_TABLE_HEADER_BG = '#2d9d78';
const PR_TABLE_BORDER = '#d0d0d0';

// Helper: Draw page header with logos, competition name, and venue/dates
function drawPdfHeader(doc, comp, tpl, pageW, margin) {
    // querystring(?v=...) 을 제거해 실제 파일 경로만 사용 (DB 에 캐시버스터 URL 이 저장돼 있을 수 있음)
    const stripQs = (u) => (u || '').split('?')[0];
    const logoLeft = stripQs(tpl.logo_left);
    const logoRight = stripQs(tpl.logo_right);
    const headerTop = margin;
    const logoMaxH = 50;
    const logoMaxW = 65;
    const centerX = pageW / 2;

    // Left logo
    if (logoLeft) {
        try {
            const lPath = path.join(__dirname, 'public', logoLeft);
            if (fs.existsSync(lPath)) {
                doc.image(lPath, margin, headerTop, { fit: [logoMaxW, logoMaxH], align: 'center', valign: 'center' });
            }
        } catch(e) { console.error('[PDF] Logo error:', e.message); }
    }

    // Right logo
    if (logoRight) {
        try {
            const rPath = path.join(__dirname, 'public', logoRight);
            if (fs.existsSync(rPath)) {
                doc.image(rPath, pageW - margin - logoMaxW, headerTop, { fit: [logoMaxW, logoMaxH], align: 'center', valign: 'center' });
            }
        } catch(e) {}
    }

    // Competition name (center)
    const textLeft = margin + (logoLeft ? logoMaxW + 10 : 0);
    const textRight = pageW - margin - (logoRight ? logoMaxW + 10 : 0);
    const textW = textRight - textLeft;

    pdfFont(doc, true).fontSize(14).fillColor('#000');
    doc.text(comp ? comp.name : 'PACE RISE Competition', textLeft, headerTop + 4, { width: textW, align: 'center' });

    // Venue
    if (comp && comp.venue) {
        pdfFont(doc, false).fontSize(9).fillColor('#333');
        doc.text(comp.venue, textLeft, headerTop + 24, { width: textW, align: 'center' });
    }

    // Dates
    if (comp) {
        pdfFont(doc, false).fontSize(9).fillColor('#333');
        const dateStr = comp.end_date && comp.end_date !== comp.start_date
            ? `${comp.start_date} ~ ${comp.end_date}` : (comp.start_date || '');
        doc.text(dateStr, textLeft, headerTop + 38, { width: textW, align: 'center' });
    }

    return headerTop + Math.max(logoMaxH, 52) + 8; // return Y after header
}

// Helper: Draw WA-style table with green header
function drawTableHeader(doc, cols, y, tableLeft, tableRight, fontSize) {
    const rowH = Math.max(22, fontSize + 12);
    // Green header background
    doc.save();
    doc.rect(tableLeft, y, tableRight - tableLeft, rowH).fill(PR_TABLE_HEADER_BG);
    // Header text
    pdfFont(doc, true).fontSize(fontSize).fillColor('#fff');
    for (const col of cols) {
        doc.text(col.label, col.x, y + (rowH - fontSize) / 2, { width: col.w, align: 'center' });
    }
    // Header borders
    doc.rect(tableLeft, y, tableRight - tableLeft, rowH).stroke(PR_GREEN_DARK);
    doc.restore();
    return y + rowH;
}

// Helper: Draw a table data row with borders
function drawTableRow(doc, cols, values, y, tableLeft, tableRight, fontSize, opts = {}) {
    const {
        boldCols = [],
        highlight = false,
        // wrapCols: 자동 줄바꿈을 허용하고 행높이를 콘텐츠에 맞춰 늘릴 컬럼 key 배열.
        //           기본값 빈 배열 → 기존 동작(고정 높이) 그대로 유지 (하위 호환).
        wrapCols = [],
        // alignByCol: 컬럼별 정렬 override. { remark: 'left', ... } 형식.
        alignByCol = {},
        // minRowH: 최소 행 높이 (override). 기본 = Math.max(20, fontSize + 10)
        minRowH = null,
        // smallFontCols: 특정 컬럼을 더 작은 폰트로 그리고 싶을 때 (예: 단체전 멤버 리스트)
        //                { remark: 7 } 형식 — 값이 폰트 크기. 미지정 컬럼은 fontSize 사용.
        smallFontCols = {}
    } = opts;

    const baseRowH = minRowH != null ? minRowH : Math.max(20, fontSize + 10);

    // ─── 1) wrapCols 가 지정된 경우 콘텐츠에 따라 행 높이 계산 ───
    // ⚠️ 중요: heightOfString 측정 옵션과 doc.text 그리기 옵션을 100% 동일하게 맞춰야
    //         마지막 줄이 잘리지 않음 (lineGap 등 누락 주의).
    let rowH = baseRowH;
    if (wrapCols.length > 0) {
        for (let i = 0; i < cols.length; i++) {
            const col = cols[i];
            if (!wrapCols.includes(col.key)) continue;
            const val = String(values[i] || '');
            if (!val) continue;
            const colFontSize = smallFontCols[col.key] || fontSize;
            const isBold = boldCols.includes(col.key);
            pdfFont(doc, isBold).fontSize(colFontSize);
            try {
                // measure 옵션 = draw 옵션 (lineGap 포함, ellipsis 등은 측정에 영향 없음)
                const measured = doc.heightOfString(val, {
                    width: col.w - 4,
                    align: alignByCol[col.key] || 'center',
                    lineGap: 0.5
                });
                // 위/아래 6pt 패딩 + 안전 마진 4pt = 16pt (마지막 줄 descender 보호)
                const needed = Math.ceil(measured) + 16;
                if (needed > rowH) rowH = needed;
            } catch (_) { /* heightOfString 실패시 기본 높이 유지 */ }
        }
    }

    if (highlight) {
        doc.save();
        doc.rect(tableLeft, y, tableRight - tableLeft, rowH).fill(PR_GREEN_LIGHT);
        doc.restore();
    }

    // Row bottom border
    doc.save();
    doc.moveTo(tableLeft, y + rowH).lineTo(tableRight, y + rowH).lineWidth(0.5).stroke(PR_TABLE_BORDER);
    // Left/right borders
    doc.moveTo(tableLeft, y).lineTo(tableLeft, y + rowH).stroke(PR_TABLE_BORDER);
    doc.moveTo(tableRight, y).lineTo(tableRight, y + rowH).stroke(PR_TABLE_BORDER);
    doc.restore();

    // Cell text
    for (let i = 0; i < cols.length; i++) {
        const col = cols[i];
        const val = values[i] || '';
        const isBold = boldCols.includes(col.key);
        const colFontSize = smallFontCols[col.key] || fontSize;
        const align = alignByCol[col.key] || 'center';
        pdfFont(doc, isBold).fontSize(colFontSize).fillColor('#000');

        let textY;
        if (wrapCols.includes(col.key)) {
            // 줄바꿈 셀: 위쪽 6pt 패딩에서 시작.
            // ⚠️ height 옵션을 지정하지 않음 — rowH는 heightOfString 측정값+16pt 안전마진으로
            //   이미 충분하므로 height 제약을 주면 오히려 마지막 줄이 잘릴 수 있음.
            //   (열 너비 부족으로 PDFKit 이 자동 줄바꿈한 라인까지 모두 그려져야 함)
            textY = y + 6;
            doc.text(String(val), col.x + 2, textY, {
                width: col.w - 4,
                align: align,
                ellipsis: false,
                lineGap: 0.5
            });
        } else {
            // 단일 라인 셀: 기존처럼 세로 중앙 정렬 (단, 행높이가 늘어났을 수 있으므로 rowH 기준)
            textY = y + (rowH - colFontSize) / 2;
            doc.text(String(val), col.x + 2, textY, {
                width: col.w - 4,
                align: align,
                lineBreak: false   // 단일 라인 — 줄바꿈 차단해서 다음 행과 겹침 방지
            });
        }
    }

    return y + rowH;
}

// Helper: Draw bottom branding footer (Audiowide font, 3 lines centered)
function drawBrandingFooter(doc, pageW, pageH, margin) {
    const contentW = pageW - margin * 2;
    const lineGap = 2;
    const line1Size = 10;  // P-R : Node
    const line2Size = 7;   // PACE RISE | Competition Operating System |
    const line3Size = 7.5; // pace-rise-node.com
    const totalH = line1Size + line2Size + line3Size + lineGap * 2 + 6;
    const footerY = pageH - margin - totalH;

    // Line 1: "P-R : Node" (Audiowide)
    if (AUDIOWIDE_AVAILABLE) doc.font(FONT_PATH_AUDIOWIDE); else pdfFont(doc, true);
    doc.fontSize(line1Size).fillColor('#2d9d78');
    doc.text('P-R : Node', margin, footerY, { width: contentW, align: 'center' });

    // Line 2: "PACE RISE | Competition Operating System |" (Audiowide)
    const y2 = footerY + line1Size + lineGap;
    if (AUDIOWIDE_AVAILABLE) doc.font(FONT_PATH_AUDIOWIDE); else pdfFont(doc, false);
    doc.fontSize(line2Size).fillColor('#777');
    doc.text('PACE RISE  |  Competition Operating System  |', margin, y2, { width: contentW, align: 'center' });

    // Line 3: "pace-rise-node.com" (Audiowide)
    const y3 = y2 + line2Size + lineGap;
    if (AUDIOWIDE_AVAILABLE) doc.font(FONT_PATH_AUDIOWIDE); else pdfFont(doc, false);
    doc.fontSize(line3Size).fillColor('#2d9d78');
    doc.text('pace-rise-node.com', margin, y3, { width: contentW, align: 'center' });
}

// ==================== START LIST PDF ====================
app.get('/api/documents/start-list/:eventId', async (req, res) => {
    const event = await db.get('SELECT * FROM event WHERE id=?', req.params.eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    const comp = await db.get('SELECT * FROM competition WHERE id=?', event.competition_id);
    const heats = await db.all('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number', event.id);
    const tpl = (await getDocTemplate(event.competition_id)).start_list;

    const pageW = 595.28; const pageH = 841.89; const margin = 40;
    const doc = new PDFDocument({ size: 'A4', margin, bufferPages: true });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Content-Disposition', `inline; filename="startlist_${event.id}_${event.gender}.pdf"`);
    doc.pipe(res);

    const gL = event.gender === 'M' ? 'Men' : event.gender === 'F' ? 'Women' : 'Mixed';
    const gK = event.gender === 'M' ? '남자' : event.gender === 'F' ? '여자' : '혼성';
    const roundL = { preliminary: 'Preliminary', semifinal: 'Semi-Final', final: 'Final' }[event.round_type] || event.round_type;
    const roundK = { preliminary: '예선', semifinal: '준결승', final: '결승' }[event.round_type] || event.round_type;
    const fontSize = tpl.font_size || 9;
    const teamLabel = tpl.team_label || 'Team';
    const teamLabelK = { Team: '소 속', School: '학 교', Club: '클 럽', Affiliation: '소 속' }[teamLabel] || '소 속';

    let curY = margin;

    // Header with logos
    if (tpl.show_header !== false) {
        curY = drawPdfHeader(doc, comp, tpl, pageW, margin);
    }

    // "START LIST" label (green)
    pdfFont(doc, true).fontSize(11).fillColor(PR_GREEN);
    doc.text('START LIST', margin, curY, { width: pageW - margin * 2 });
    curY += 16;

    // Event title
    pdfFont(doc, true).fontSize(12).fillColor('#000');
    doc.text(`${gK}  ${event.name}`, margin, curY);
    curY += 18;

    // Round bar
    const barH = 20;
    doc.save();
    doc.rect(margin, curY, 80, barH).fill('#1a1a1a');
    pdfFont(doc, true).fontSize(9).fillColor('#fff');
    doc.text(roundL, margin + 4, curY + 5, { width: 72, align: 'center' });
    doc.restore();
    pdfFont(doc, false).fontSize(9).fillColor('#333');
    doc.text(`${roundK}`, margin + 88, curY + 5);
    curY += barH + 10;

    // Build dynamic columns
    const tableLeft = margin;
    const tableRight = pageW - margin;
    const totalW = tableRight - tableLeft;
    const slCols = [];
    let xOff = tableLeft;
    if (tpl.show_lane !== false) { slCols.push({ key: 'lane', label: '레 인', x: xOff, w: totalW * 0.08 }); xOff += totalW * 0.08; }
    if (tpl.show_bib !== false) { slCols.push({ key: 'bib', label: '배 번', x: xOff, w: totalW * 0.10 }); xOff += totalW * 0.10; }
    if (tpl.show_name !== false) {
        const remainW = totalW - (xOff - tableLeft) - (tpl.show_team !== false ? totalW * 0.25 : 0) - (tpl.show_status !== false ? totalW * 0.12 : 0) - (tpl.show_pb ? totalW * 0.12 : 0) - (tpl.show_dob ? totalW * 0.12 : 0);
        slCols.push({ key: 'name', label: '선 수 명', x: xOff, w: Math.max(remainW, totalW * 0.15) }); xOff += Math.max(remainW, totalW * 0.15);
    }
    if (tpl.show_team !== false) { slCols.push({ key: 'team', label: teamLabelK, x: xOff, w: totalW * 0.25 }); xOff += totalW * 0.25; }
    if (tpl.show_pb) { slCols.push({ key: 'pb', label: 'PB', x: xOff, w: totalW * 0.12 }); xOff += totalW * 0.12; }
    if (tpl.show_dob) { slCols.push({ key: 'dob', label: '생년월일', x: xOff, w: totalW * 0.12 }); xOff += totalW * 0.12; }
    if (tpl.show_status !== false) { slCols.push({ key: 'status', label: '출 석', x: xOff, w: totalW * 0.12 }); xOff += totalW * 0.12; }

    for (const heat of heats) {
        const entries = await db.all(`
            SELECT he.lane_number, he.sub_group, ee.status, a.name, a.bib_number, a.team, a.date_of_birth, a.personal_best
            FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id
            JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=?
            ORDER BY he.lane_number ASC, ${orderByBibSql('a.bib_number')}
        `, heat.id);

        // Check page break (use dynamic row height based on fontSize)
        const headerRowH = Math.max(22, fontSize + 12);
        const dataRowH = Math.max(20, fontSize + 10);
        const neededH = 30 + headerRowH + entries.length * dataRowH + 10;
        if (curY + neededH > pageH - margin - 30) {
            doc.addPage();
            curY = margin;
        }

        // Heat label
        const hLabel = heat.heat_name || `Heat ${heat.heat_number}`;
        pdfFont(doc, true).fontSize(10).fillColor('#000');
        doc.text(hLabel, margin, curY);
        if (heat.scoreboard_key) { pdfFont(doc, false).fontSize(7).fillColor('#888'); doc.text(heat.scoreboard_key, margin + 100, curY + 2); }
        curY += 16;

        // Table header
        curY = drawTableHeader(doc, slCols, curY, tableLeft, tableRight, fontSize);

        // Data rows
        for (const e of entries) {
            if (curY + dataRowH > pageH - margin - 30) {
                doc.addPage(); curY = margin;
                curY = drawTableHeader(doc, slCols, curY, tableLeft, tableRight, fontSize);
            }
            const vals = slCols.map(col => {
                switch (col.key) {
                    case 'lane': return String(e.lane_number || '-');
                    case 'bib': return e.bib_number || '-';
                    case 'name': return e.name || '';
                    case 'team': return e.team || '';
                    case 'status': return { registered: 'Reg', checked_in: 'In', no_show: 'DNS' }[e.status] || e.status || '';
                    case 'pb': return e.personal_best || '';
                    case 'dob': return e.date_of_birth || '';
                    default: return '';
                }
            });
            curY = drawTableRow(doc, slCols, vals, curY, tableLeft, tableRight, fontSize, { boldCols: ['name'] });
        }
        curY += 12;
    }

    // Branding footer
    drawBrandingFooter(doc, pageW, pageH, margin);
    doc.end();
});

// ==================== RESULT SHEET PDF ====================
app.get('/api/documents/result-sheet/:eventId', async (req, res) => {
  try {
    const event = await db.get('SELECT * FROM event WHERE id=?', req.params.eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    const comp = await db.get('SELECT * FROM competition WHERE id=?', event.competition_id);
    const heats = await db.all('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number', event.id);
    const tpl = (await getDocTemplate(event.competition_id)).result_sheet;

    // ─── 종목별 실제 진행 날짜 조회 ─────────────────────────────────────
    // timetable.scheduled_date / day 에서 이 event 의 실제 날짜를 가져온다.
    // 우선순위:
    //   1) timetable.event_id 가 event.id 와 일치하는 row 의 scheduled_date
    //   2) timetable.event_ids JSON 배열에 event.id 가 포함된 row 의 scheduled_date
    //   3) timetable.day 와 comp.start_date 를 더해서 계산 (day 는 1-based)
    //   4) 매칭 없으면 fallback 으로 comp.start_date 사용
    // round_type 이 일치하는 row 를 우선 고른다 (예선/결승 같은 종목이 다른 날일 수 있음).
    let eventDateStr = '';
    try {
        const roundMap = { preliminary: '예선', semifinal: '준결승', final: '결승', heats: '예선' };
        const ttRound = roundMap[event.round_type] || event.round_type;
        // (1) event_id 직접 매칭 + round 일치 우선
        // 참고: SQLite 백엔드는 db.get 이 동기, PG 는 async. 두 케이스 모두에서 await 가 안전하게 동작.
        //       try-catch 만으로 에러 처리 (db.get(...).catch 패턴은 SQLite 에서 TypeError 발생).
        let ttRow = null;
        try {
            ttRow = await db.get(
                `SELECT scheduled_date, day FROM timetable
                 WHERE competition_id=? AND event_id=? AND (round=? OR round IS NULL OR round='')
                 ORDER BY (round=?) DESC, day ASC, time ASC LIMIT 1`,
                event.competition_id, event.id, ttRound, ttRound
            );
        } catch(_) { ttRow = null; }
        // (1b) round 무시하고 event_id 만 매칭
        if (!ttRow) {
            try {
                ttRow = await db.get(
                    `SELECT scheduled_date, day FROM timetable
                     WHERE competition_id=? AND event_id=? ORDER BY day ASC, time ASC LIMIT 1`,
                    event.competition_id, event.id
                );
            } catch(_) { ttRow = null; }
        }
        // (2) event_ids JSON 매칭 (혼성/공동 종목 대비)
        if (!ttRow) {
            let candidates = [];
            try {
                candidates = await db.all(
                    `SELECT scheduled_date, day, event_ids FROM timetable
                     WHERE competition_id=? AND event_ids IS NOT NULL AND event_ids <> ''`,
                    event.competition_id
                );
            } catch(_) { candidates = []; }
            for (const c of candidates) {
                try {
                    const ids = JSON.parse(c.event_ids);
                    if (Array.isArray(ids) && ids.map(Number).includes(Number(event.id))) {
                        ttRow = c; break;
                    }
                } catch(_) {}
            }
        }
        if (ttRow) {
            if (ttRow.scheduled_date) {
                eventDateStr = ttRow.scheduled_date;
            } else if (ttRow.day && comp && comp.start_date) {
                // day 가 1-based 라고 가정하고 comp.start_date 에 (day-1) 일 더하기
                const d = new Date(comp.start_date + 'T00:00:00');
                d.setDate(d.getDate() + (Number(ttRow.day) - 1));
                eventDateStr = d.toISOString().slice(0, 10);
            }
        }
    } catch (e) {
        console.warn('[result-sheet PDF] event date lookup failed:', e.message);
    }
    // Fallback: 종목별 날짜 못 찾으면 comp.start_date 사용 (기존 동작 유지)
    if (!eventDateStr && comp) eventDateStr = comp.start_date || '';

    const pageW = 595.28; const pageH = 841.89; const margin = 40;
    const doc = new PDFDocument({ size: 'A4', margin, bufferPages: true });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Content-Disposition', `inline; filename="results_${event.id}_${event.gender}.pdf"`);
    doc.pipe(res);

    const gK = event.gender === 'M' ? '남자' : event.gender === 'F' ? '여자' : '혼성';
    const roundL = { preliminary: 'Preliminary', semifinal: 'Semi-Final', final: 'Final' }[event.round_type] || event.round_type;
    const fontSize = tpl.font_size || 9;
    const teamLabel = tpl.team_label || 'Team';
    const teamLabelK = { Team: '소 속 명', School: '학 교', Club: '클 럽', Affiliation: '소 속 명' }[teamLabel] || '소 속 명';

    const isFieldDist = event.category === 'field_distance';
    const isFieldHeight = event.category === 'field_height';
    const isField = isFieldDist || isFieldHeight;
    const isCombined = event.category === 'combined';
    const isTrack = event.category === 'track' || event.category === 'relay' || event.category === 'road';
    const tableLeft = margin;
    const tableRight = pageW - margin;
    const totalW = tableRight - tableLeft;

    // ============================================================
    // [PAGE-REPEAT] 종목 상단 헤더 + 하단 NR/DR/CR 박스를 매 페이지마다 반복
    //   - drawEventTopHeader: 대회 로고/제목 + OFFICIAL RESULT + 종목명 + Round/Date bar
    //   - drawEventBottomBox: legend + 서명 + NR/DR/CR 표
    //   - body 영역(heats) 그리는 동안 addPage 직후 curY 를 헤더 아래로 리셋
    //   - body 영역 끝 한계는 pageH - margin - BOTTOM_RESERVED 로 강제
    //   - PDF 종료 직전 bufferPages 로 전체 페이지 순회하며 헤더/하단 재그리기
    // ============================================================
    const drawEventTopHeader = (d) => {
        let y = margin;
        if (tpl.show_header !== false) {
            y = drawPdfHeader(d, comp, tpl, pageW, margin);
        }
        // "OFFICIAL RESULT" label
        pdfFont(d, true).fontSize(11).fillColor(PR_GREEN);
        d.text('OFFICIAL RESULT', margin, y, { width: pageW - margin * 2 });
        y += 16;
        // Event title
        pdfFont(d, true).fontSize(12).fillColor('#000');
        d.text(`${gK}  ${event.name}`, margin, y);
        y += 18;
        // Round / Date bar
        const barH = 22;
        d.save();
        d.rect(margin, y, 80, barH).fill('#1a1a1a');
        pdfFont(d, true).fontSize(9).fillColor('#fff');
        d.text(roundL, margin + 4, y + 6, { width: 72, align: 'center' });
        d.restore();
        pdfFont(d, false).fontSize(9).fillColor('#333');
        // 종목별 실제 진행 날짜 사용 (timetable.scheduled_date) — 대회 시작일이 아닌 종목 당일 표시
        d.text(eventDateStr || '', margin + 88, y + 6);
        d.save();
        d.moveTo(margin, y).lineTo(pageW - margin, y).lineWidth(0.5).stroke('#333');
        d.moveTo(margin, y + barH).lineTo(pageW - margin, y + barH).lineWidth(0.5).stroke('#333');
        d.restore();
        y += barH + 8;
        return y;
    };

    // 하단 NR/DR/CR + 서명 + legend 박스 데이터 (페이지 마다 반복 그리기 위해 미리 준비)
    // event_records 와 global event_record 에서 NR/DR/CR 로드
    const _loadRecordsData = async () => {
        const evtRecRow = await db.get('SELECT records FROM event_records WHERE event_id=?', event.id);
        let evtRec = {};
        if (evtRecRow) { try { evtRec = JSON.parse(evtRecRow.records || '{}'); } catch(e) {} }
        let normName = event.name.replace(/\s+/g, '').replace(/,/g, '').replace(/(\d)[×Xx](\d)/g, '$1x$2');
        const nameMap = { '110m허들':'110mH','100m허들':'100mH','400m허들':'400mH','3000m장애물':'3000mSC','10000m경보':'10000mW','십종경기':'10종경기','칠종경기':'7종경기','오종경기':'5종경기','펜타슬론':'5종경기','Pentathlon':'5종경기','4x100m릴레이':'4x100mR','4x400m릴레이':'4x400mR','혼성4x400mR':'MIXED 4x400mR','MIXED4x400mR':'MIXED 4x400mR','4x800m릴레이':'4x800mR','4x1500m릴레이':'4x1500mR' };
        normName = nameMap[normName] || normName;
        try {
            const globalRecs = await db.all('SELECT * FROM event_record WHERE gender=? AND event_name=?', event.gender, normName);
            for (const gr of globalRecs) {
                const keyMap = { national: 'nr', division: 'dr', competition: 'cr' };
                const shortKey = keyMap[gr.record_type];
                if (shortKey && (!evtRec[shortKey] || !evtRec[shortKey].record)) {
                    evtRec[shortKey] = { label: gr.record_type === 'national' ? '한국기록(NR)' : gr.record_type === 'division' ? '부별기록(DR)' : '대회기록(CR)', record: gr.record_value || '', athlete: gr.holder_name || '', team: gr.holder_team || '', year: gr.record_year || '' };
                }
            }
        } catch(e) {}
        const recTpl = tpl.records || {};
        return [
            { ...(recTpl.nr || { label: '한국기록(NR)' }), ...(evtRec.nr || {}) },
            { ...(recTpl.dr || { label: '부별기록(DR)' }), ...(evtRec.dr || {}) },
            { ...(recTpl.cr || { label: '대회기록(CR)' }), ...(evtRec.cr || {}) }
        ];
    };
    const recRowsForFooter = (tpl.show_records_table !== false) ? await _loadRecordsData() : null;

    // 하단 박스 그리기: legend + 서명선 + NR/DR/CR 3행 표
    // 페이지 하단 영역 레이아웃 (위→아래):
    //   [legend 12]  +  [signature 24]  +  [표 header 22 + data row 20 x 3 = 82]  =  118pt
    //   브랜딩 푸터 ≈ 34.5pt, footerY = pageH - margin - 34.5 ≈ 767.4
    //   박스 ↔ 푸터 간격 12pt 확보
    // 박스를 푸터 바로 위로 "anchor down" 방식으로 배치 (정확한 위치 보장)
    const BRANDING_FOOTER_H = 34.5;
    const BOX_FOOTER_GAP = 12;
    // 박스 실제 높이 = legend 12 + (signature 24 if shown) + table header 22 + data rows 20 * N
    const _recCount = recRowsForFooter ? recRowsForFooter.length : 0;
    const _sigH = (tpl.show_signature !== false) ? 24 : 0;
    const _tableH = recRowsForFooter ? (22 + 20 * _recCount) : 0;
    const BOX_H = 12 + _sigH + _tableH; // legend + sig + table
    // 본문 영역 하단 한계: 박스 시작 y - 8pt 여백
    const BOX_TOP_Y = pageH - margin - BRANDING_FOOTER_H - BOX_FOOTER_GAP - BOX_H;
    const BOTTOM_RESERVED = pageH - margin - BOX_TOP_Y + 8; // 본문 ↔ 박스 사이 8pt 여백
    const drawEventBottomBox = (d) => {
        d.save(); // bufferPages + switchToPage 안전성 위한 그래픽 상태 격리
        const totalH = pageH - margin * 2;
        // 박스 시작 Y: 푸터 위로 정확히 anchor 됨 → 어떤 BOTTOM_RESERVED 값과도 무관하게 항상 푸터 위에 위치
        let y = BOX_TOP_Y;
        // Legend line
        pdfFont(d, false).fontSize(7).fillColor('#555');
        d.text('DQ=실격  DNS=경기불참  DNF=중도기권  NM=기록없음  Q=순위통과  q=기록통과', margin, y);
        y += 12;
        // Signature (작게)
        if (tpl.show_signature !== false) {
            pdfFont(d, false).fontSize(8.5).fillColor('#333');
            const recName = tpl.recorder_name || '';
            const chiefName = tpl.chief_recorder_name || '';
            const sigLineW = 150;
            d.text(`기록자 :    ${recName}`, tableLeft, y);
            const chiefX = tableRight - sigLineW;
            d.text(`기록주임 :    ${chiefName}`, chiefX, y);
            y += 14;
            d.save();
            d.moveTo(tableLeft, y).lineTo(tableLeft + sigLineW, y).lineWidth(0.5).stroke('#999');
            d.moveTo(chiefX, y).lineTo(tableRight, y).lineWidth(0.5).stroke('#999');
            d.restore();
            y += 10;
        }
        // NR/DR/CR 표
        if (recRowsForFooter) {
            const recCols = [
                { key: 'label', label: '구 분', x: tableLeft, w: totalW * 0.22 },
                { key: 'record', label: '기 록', x: tableLeft + totalW * 0.22, w: totalW * 0.18 },
                { key: 'athlete', label: '선 수 명', x: tableLeft + totalW * 0.40, w: totalW * 0.20 },
                { key: 'team', label: '소 속 명', x: tableLeft + totalW * 0.60, w: totalW * 0.22 },
                { key: 'year', label: '수립년도', x: tableLeft + totalW * 0.82, w: totalW * 0.18 }
            ];
            y = drawTableHeader(d, recCols, y, tableLeft, tableRight, fontSize);
            for (const row of recRowsForFooter) {
                const vals = recCols.map(c => row[c.key] || '');
                y = drawTableRow(d, recCols, vals, y, tableLeft, tableRight, fontSize);
            }
        }
        d.restore();
    };

    let curY = drawEventTopHeader(doc);
    // body 영역 하단 한계: 기존 코드들의 `pageH - margin - 80` 대신
    // 하단 박스 자리를 비워두기 위해 BOTTOM_RESERVED 사용
    const BODY_BOTTOM = pageH - margin - BOTTOM_RESERVED;

    // ============================================================
    // COMBINED EVENT (10종/7종) — completely different layout
    // ============================================================
    if (isCombined) {
        const subEvents = await db.all('SELECT * FROM event WHERE parent_event_id=? ORDER BY sort_order, id', event.id);
        const heat = heats[0]; // optional — 혼성 부모는 heat 가 없을 수 있음
        // 부모 종목의 entries 조회: heat 가 있으면 lane 순, 없으면 event_entry 직접 조회
        let entries;
        if (heat) {
            entries = await db.all(`
                SELECT he.lane_number, ee.id AS event_entry_id, ee.status, ee.athlete_id,
                       a.name, a.bib_number, a.team
                FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id
                JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=?
                ORDER BY he.lane_number ASC
            `, heat.id);
        } else {
            // heat 없는 혼성 부모: event_entry 만으로 본문 생성 (lane 정보는 null)
            entries = await db.all(`
                SELECT NULL AS lane_number, ee.id AS event_entry_id, ee.status, ee.athlete_id,
                       a.name, a.bib_number, a.team
                FROM event_entry ee JOIN athlete a ON a.id=ee.athlete_id
                WHERE ee.event_id=?
                ORDER BY a.bib_number ASC, ee.id ASC
            `, event.id);
        }
        // 그래도 entries 가 비어있으면 안내 텍스트만 출력하고 종료 (빈 페이지 방지)
        if (!entries || entries.length === 0) {
            pdfFont(doc, false).fontSize(11).fillColor('#888');
            doc.text('— 등록된 선수가 없습니다 —', margin, curY + 20, { width: pageW - margin * 2, align: 'center' });
            // bufferPages 루프에서 헤더/푸터/박스 그려지도록 본문은 비워두고 정상 종료
        }

        // Build sub-event short names for columns
        const subLabels = subEvents.map(se => {
            let n = se.name.replace(/\[.*?\]\s*/, '');
            if (n.length > 5) n = n.substring(0, 5);
            return n;
        });

        // Helper: parse wind value — handles both numeric (real) and text ("0.5 m/s") storage
        const parseWindValue = (w) => {
            if (w == null) return null;
            if (typeof w === 'number') return isFinite(w) ? w : null;
            const m = String(w).match(/-?\d+(?:\.\d+)?/);
            return m ? parseFloat(m[0]) : null;
        };

        // Gather all combined_scores and sub-event results for each athlete
        const athleteData = await Promise.all(entries.map(async e => {
            const scores = await db.all('SELECT * FROM combined_score WHERE event_entry_id=? ORDER BY sub_event_order', e.event_entry_id);
            let totalPoints = 0;
            const subScores = [];
            for (let i = 0; i < subEvents.length; i++) {
                const se = subEvents[i];
                const sc = scores.find(s => s.sub_event_order === i + 1) || null;
                let rawRecord = null; let wind = null; let points = 0;
                const isWindAffected = se.category === 'track' || se.category === 'field_distance';
                if (sc) {
                    rawRecord = sc.raw_record;
                    points = sc.wa_points || 0;
                    totalPoints += points;
                }
                // Always try to load sub-event heat/result data (for wind retrieval and as fallback for missing combined_score)
                const subHeat = await db.get('SELECT id, wind FROM heat WHERE event_id=?', se.id);
                if (subHeat) {
                    const subEE = await db.get('SELECT id FROM event_entry WHERE event_id=? AND athlete_id=?', se.id, e.athlete_id);
                    if (subEE) {
                        // Find best result (track: lowest time; field_distance: highest distance)
                        let subRes = null;
                        if (se.category === 'track' || se.category === 'road' || se.category === 'relay') {
                            subRes = await db.get('SELECT * FROM result WHERE heat_id=? AND event_entry_id=? AND time_seconds IS NOT NULL ORDER BY time_seconds ASC LIMIT 1', subHeat.id, subEE.id);
                        } else if (se.category === 'field_distance') {
                            subRes = await db.get('SELECT * FROM result WHERE heat_id=? AND event_entry_id=? AND distance_meters IS NOT NULL ORDER BY distance_meters DESC LIMIT 1', subHeat.id, subEE.id);
                        } else {
                            subRes = await db.get('SELECT * FROM result WHERE heat_id=? AND event_entry_id=? ORDER BY attempt_number LIMIT 1', subHeat.id, subEE.id);
                        }

                        if (!sc && subRes) {
                            // Fallback record only if no combined_score
                            const isST = se.category === 'track' || se.category === 'road' || se.category === 'relay';
                            rawRecord = isST ? subRes.time_seconds : subRes.distance_meters;
                        }
                        // Always pull wind for wind-affected sub-events
                        if (isWindAffected) {
                            // Prefer result.wind (per-attempt accuracy), then fall back to heat.wind
                            wind = parseWindValue(subRes?.wind);
                            if (wind == null) wind = parseWindValue(subHeat.wind);
                        }
                        // For field_height fallback
                        if (!sc && se.category === 'field_height') {
                            const best = await db.get("SELECT MAX(bar_height) AS best FROM height_attempt WHERE heat_id=? AND event_entry_id=? AND result_mark='O'", subHeat.id, subEE.id);
                            if (best && best.best) rawRecord = best.best;
                        }
                        // For field_distance no-result fallback
                        if (!sc && se.category === 'field_distance' && !rawRecord) {
                            const bestD = await db.get('SELECT MAX(distance_meters) AS best FROM result WHERE heat_id=? AND event_entry_id=? AND distance_meters IS NOT NULL', subHeat.id, subEE.id);
                            if (bestD && bestD.best) rawRecord = bestD.best;
                        }
                    } else if (isWindAffected) {
                        // No event_entry for sub event → use heat-level wind as best-effort
                        wind = parseWindValue(subHeat.wind);
                    }
                }
                subScores.push({ rawRecord, wind, points, subEvent: se });
            }
            // Check for DNF status — heat 가 없으면 heat_id 조건 없이 entry 만으로 조회
            const status = heat
                ? await db.get("SELECT status_code FROM result WHERE heat_id=? AND event_entry_id=? AND status_code IN ('DNF','DNS','DQ') LIMIT 1", heat.id, e.event_entry_id)
                : await db.get("SELECT status_code FROM result WHERE event_entry_id=? AND status_code IN ('DNF','DNS','DQ') LIMIT 1", e.event_entry_id);
            let statusCode = status?.status_code || '';
            // Fallback: if entry status is no_show and no explicit DNS result, treat as DNS
            if (!statusCode && e.status === 'no_show') statusCode = 'DNS';
            // 0 points with no explicit status → DNF
            if (!statusCode && totalPoints === 0) statusCode = 'DNF';
            return { ...e, subScores, totalPoints, status_code: statusCode };
        }));

        // Sort by total points descending; DNF at bottom
        athleteData.sort((a, b) => {
            const aS = ['DNS','DNF','DQ'].includes(a.status_code);
            const bS = ['DNS','DNF','DQ'].includes(b.status_code);
            if (aS && !bS) return 1;
            if (!aS && bS) return -1;
            if (aS && bS) return 0;
            return b.totalPoints - a.totalPoints;
        });

        // Build combined columns: 순위, 배번, 선수명, 소속명, [sub-events...], 결과
        const comCols = [];
        let cx = tableLeft;
        comCols.push({ key: 'rank', label: '순위', x: cx, w: totalW * 0.05 }); cx += totalW * 0.05;
        comCols.push({ key: 'bib', label: '배번', x: cx, w: totalW * 0.05 }); cx += totalW * 0.05;
        comCols.push({ key: 'name', label: '선수명', x: cx, w: totalW * 0.10 }); cx += totalW * 0.10;
        comCols.push({ key: 'team', label: '소속명', x: cx, w: totalW * 0.12 }); cx += totalW * 0.12;
        const subW = Math.max(0.04, (totalW * 0.58) / Math.max(subEvents.length, 1)) / totalW;
        for (let i = 0; i < subEvents.length; i++) {
            comCols.push({ key: `sub_${i}`, label: subLabels[i], x: cx, w: totalW * subW }); cx += totalW * subW;
        }
        comCols.push({ key: 'total', label: '결과', x: cx, w: (tableRight - cx) * 0.6 }); cx += (tableRight - cx) * 0.6;
        comCols.push({ key: 'remark', label: '비고', x: cx, w: tableRight - cx }); // remaining

        // Draw header (smaller font for combined)
        const comFS = Math.min(fontSize, 7);
        curY = drawTableHeader(doc, comCols, curY, tableLeft, tableRight, comFS);

        // Sub-header: WIND row (for wind-affected events)
        const windRowH = 14;
        doc.save();
        doc.rect(tableLeft, curY, totalW, windRowH).fill('#f5f5f5').stroke(PR_TABLE_BORDER);
        // "WIND (m/s)" label placed in the team column area (left of sub-events) for clarity
        pdfFont(doc, true).fontSize(6).fillColor('#555');
        const teamColEnd = comCols[3] ? comCols[3].x + comCols[3].w : tableLeft + totalW * 0.32;
        doc.text('WIND (m/s)', tableLeft, curY + 3, { width: teamColEnd - tableLeft, align: 'right' });
        // Mark each wind-affected sub-event column with a small wind indicator above
        pdfFont(doc, false).fontSize(5.5).fillColor('#888');
        for (let i = 0; i < subEvents.length; i++) {
            const se = subEvents[i];
            if (se.category === 'track' || se.category === 'field_distance') {
                const col = comCols[4 + i];
                if (col) doc.text('↓', col.x + 1, curY + 3, { width: col.w - 2, align: 'center' });
            }
        }
        doc.restore();
        curY += windRowH;

        // Render each athlete (3 rows: record, points, wind)
        let rank = 0;
        for (const ath of athleteData) {
            const rowH3 = 42; // 3 sub-rows * 14px each
            if (curY + rowH3 > BODY_BOTTOM) {
                doc.addPage(); curY = drawEventTopHeader(doc);
                curY = drawTableHeader(doc, comCols, curY, tableLeft, tableRight, comFS);
                curY += windRowH; // skip wind header space
            }
            const special = ['DNS','DNF','DQ'].includes(ath.status_code);
            if (!special) rank++;

            // Row background
            doc.save();
            doc.rect(tableLeft, curY, totalW, rowH3).stroke(PR_TABLE_BORDER);
            doc.restore();

            const subRowH = 14;
            // Row 1: record values
            pdfFont(doc, false).fontSize(comFS).fillColor('#000');
            const y1 = curY + 2;
            doc.text(special ? '' : String(rank), comCols[0].x + 2, y1, { width: comCols[0].w - 4, align: 'center' });
            doc.text(ath.bib_number || '-', comCols[1].x + 2, y1, { width: comCols[1].w - 4, align: 'center' });
            pdfFont(doc, true).fontSize(comFS);
            doc.text(ath.name || '', comCols[2].x + 2, y1, { width: comCols[2].w - 4, align: 'center' });
            pdfFont(doc, false).fontSize(comFS);
            doc.text(ath.team || '', comCols[3].x + 2, y1, { width: comCols[3].w - 4, align: 'center' });
            // Sub-event records
            for (let i = 0; i < ath.subScores.length; i++) {
                const sc = ath.subScores[i];
                let recStr = '';
                if (sc.rawRecord != null) {
                    const se = sc.subEvent;
                    if (se.category === 'track' || se.category === 'road' || se.category === 'relay') {
                        recStr = formatTimeForPDF(sc.rawRecord);
                    } else {
                        recStr = sc.rawRecord.toFixed(2);
                    }
                }
                const col = comCols[4 + i];
                if (col) doc.text(recStr, col.x + 1, y1, { width: col.w - 2, align: 'center' });
            }
            // Total — DNF/DQ → 공백
            const totalCol = comCols.find(c => c.key === 'total');
            pdfFont(doc, true).fontSize(comFS + 1).fillColor('#000');
            doc.text(special ? '' : String(ath.totalPoints), totalCol.x + 2, y1, { width: totalCol.w - 4, align: 'center' });
            // Remark — DNF/DQ status
            const remkCol = comCols.find(c => c.key === 'remark');
            if (remkCol) {
                pdfFont(doc, false).fontSize(comFS).fillColor('#000');
                doc.text(special ? ath.status_code : '', remkCol.x + 2, y1, { width: remkCol.w - 4, align: 'center' });
            }

            // Row 2: points
            const y2 = curY + subRowH + 1;
            pdfFont(doc, false).fontSize(5.5).fillColor('#666');
            for (let i = 0; i < ath.subScores.length; i++) {
                const sc = ath.subScores[i];
                const col = comCols[4 + i];
                if (col && sc.points) doc.text(String(sc.points), col.x + 1, y2, { width: col.w - 2, align: 'center' });
            }

            // Row 3: wind (per sub-event, for track/field_distance only)
            const y3 = curY + subRowH * 2;
            pdfFont(doc, false).fontSize(6).fillColor('#0066aa');
            for (let i = 0; i < ath.subScores.length; i++) {
                const sc = ath.subScores[i];
                const col = comCols[4 + i];
                if (col && typeof sc.wind === 'number' && isFinite(sc.wind)) {
                    const wStr = (sc.wind >= 0 ? '+' : '') + sc.wind.toFixed(1);
                    doc.text(wStr, col.x + 1, y3, { width: col.w - 2, align: 'center' });
                }
            }

            curY += rowH3;
        }
        curY += 8;

    // ============================================================
    // FIELD HEIGHT EVENT (높이뛰기/장대높이뛰기) — O/X/XXO format
    // ============================================================
    } else if (isFieldHeight) {
        const heat = heats[0]; // field height typically has one heat
        if (!heat) { doc.end(); return; }
        const entries = await db.all(`
            SELECT he.lane_number, ee.id AS event_entry_id, ee.status,
                   a.name, a.bib_number, a.team
            FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id
            JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=?
            ORDER BY he.lane_number ASC
        `, heat.id);

        // Get all height attempts for this heat
        const allAttempts = await db.all('SELECT * FROM height_attempt WHERE heat_id=? ORDER BY bar_height, event_entry_id, attempt_number', heat.id);
        // Get unique bar heights
        const barHeights = [...new Set(allAttempts.map(a => a.bar_height))].sort((a, b) => a - b);

        // Build athlete data
        const athleteData = await Promise.all(entries.map(async e => {
            const myAttempts = allAttempts.filter(a => a.event_entry_id === e.event_entry_id);
            let bestCleared = null;
            let totalMisses = 0; let missesAtBest = 0;
            const heightResults = {};
            for (const h of barHeights) {
                const attemptsAtH = myAttempts.filter(a => a.bar_height === h).sort((a, b) => a.attempt_number - b.attempt_number);
                if (attemptsAtH.length === 0) {
                    heightResults[h] = ''; // did not attempt
                } else {
                    let str = attemptsAtH.map(a => a.result_mark).join('');
                    heightResults[h] = str;
                    const misses = attemptsAtH.filter(a => a.result_mark === 'X').length;
                    totalMisses += misses;
                    if (attemptsAtH.some(a => a.result_mark === 'O')) {
                        bestCleared = h;
                        missesAtBest = misses;
                    }
                }
            }
            // Also check result table for status
            const results = await db.all('SELECT * FROM result WHERE heat_id=? AND event_entry_id=?', heat.id, e.event_entry_id);
            let status = results.find(r => r.status_code && r.status_code !== '')?.status_code || '';
            // Fallback: if entry status is no_show and no explicit DNS result, treat as DNS
            if (!status && e.status === 'no_show') status = 'DNS';
            // If no height_attempt data, check result table for best distance_meters (used as height)
            // [FIX] distance_meters===0 은 파울, -1 은 패스 이므로 양수만 유효
            if (bestCleared === null && !status) {
                const bestR = results.find(r => r.distance_meters != null && r.distance_meters > 0);
                if (bestR) bestCleared = bestR.distance_meters;
            }
            return { ...e, bestCleared, totalMisses, missesAtBest, heightResults, status_code: status };
        }));

        // Sort: highest cleared → fewest misses at best → fewest total misses
        athleteData.sort((a, b) => {
            const aS = ['DNS','DNF','DQ','NM'].includes(a.status_code);
            const bS = ['DNS','DNF','DQ','NM'].includes(b.status_code);
            if (aS && !bS) return 1;
            if (!aS && bS) return -1;
            if (a.bestCleared == null && b.bestCleared == null) return 0;
            if (a.bestCleared == null) return 1;
            if (b.bestCleared == null) return -1;
            if (b.bestCleared !== a.bestCleared) return b.bestCleared - a.bestCleared;
            if (a.missesAtBest !== b.missesAtBest) return a.missesAtBest - b.missesAtBest;
            return a.totalMisses - b.totalMisses;
        });

        // Build columns: 순위, 배번, 선수명, 소속명, [bar heights...], 결과
        const hCols = [];
        let hx = tableLeft;
        hCols.push({ key: 'rank', label: '순위', x: hx, w: totalW * 0.06 }); hx += totalW * 0.06;
        hCols.push({ key: 'bib', label: '배번', x: hx, w: totalW * 0.06 }); hx += totalW * 0.06;
        hCols.push({ key: 'name', label: '선수명', x: hx, w: totalW * 0.12 }); hx += totalW * 0.12;
        hCols.push({ key: 'team', label: teamLabelK, x: hx, w: totalW * 0.14 }); hx += totalW * 0.14;
        const remainForBars = totalW * 0.52;
        const barW = barHeights.length > 0 ? Math.min(remainForBars / barHeights.length, totalW * 0.08) : totalW * 0.06;
        for (const bh of barHeights) {
            hCols.push({ key: `h_${bh}`, label: bh.toFixed(2), x: hx, w: barW }); hx += barW;
        }
        hCols.push({ key: 'result', label: '결 과', x: hx, w: (tableRight - hx) * 0.6 }); hx += (tableRight - hx) * 0.6;
        hCols.push({ key: 'remark', label: '비 고', x: hx, w: tableRight - hx });

        const hFS = Math.min(fontSize, barHeights.length > 6 ? 7 : 8);
        curY = drawTableHeader(doc, hCols, curY, tableLeft, tableRight, hFS);

        let rank = 0; let prevAth = null; let athIdx = 0;
        for (const ath of athleteData) {
            if (curY + Math.max(20, hFS + 10) > BODY_BOTTOM) {
                doc.addPage(); curY = drawEventTopHeader(doc);
                curY = drawTableHeader(doc, hCols, curY, tableLeft, tableRight, hFS);
            }
            const special = ['DNS','DNF','DQ','NM'].includes(ath.status_code) || ath.bestCleared == null;
            if (!special) {
                athIdx++;
                // WA tie-break: same bestCleared + missesAtBest + totalMisses = same rank
                const isTied = prevAth && prevAth.bestCleared === ath.bestCleared
                    && prevAth.missesAtBest === ath.missesAtBest
                    && prevAth.totalMisses === ath.totalMisses;
                if (!isTied) rank = athIdx;
                prevAth = ath;
            }
            const vals = hCols.map(col => {
                if (col.key === 'rank') return special ? '' : String(rank);
                if (col.key === 'bib') return ath.bib_number || '-';
                if (col.key === 'name') return ath.name || '';
                if (col.key === 'team') return ath.team || '';
                if (col.key === 'result') return special ? '' : (ath.bestCleared != null ? ath.bestCleared.toFixed(2) : '');
                if (col.key === 'remark') return special ? (ath.status_code || 'NM') : '';
                if (col.key.startsWith('h_')) {
                    const bh = parseFloat(col.key.substring(2));
                    return ath.heightResults[bh] || '';
                }
                return '';
            });
            curY = drawTableRow(doc, hCols, vals, curY, tableLeft, tableRight, hFS, { boldCols: ['name', 'result'] });
        }

        // Draw empty rows up to 12 (like the reference image)
        const minRows = 12;
        const drawn = athleteData.length;
        for (let i = drawn + 1; i <= minRows; i++) {
            if (curY + Math.max(20, hFS + 10) > BODY_BOTTOM) break;
            const emptyVals = hCols.map(col => col.key === 'rank' ? String(i) : '');
            curY = drawTableRow(doc, hCols, emptyVals, curY, tableLeft, tableRight, hFS);
        }
        curY += 8;

    // ============================================================
    // FIELD DISTANCE EVENT (멀리뛰기/세단뛰기/포환/원반/해머/창) — 6 attempts with wind
    // ============================================================
    } else if (isFieldDist) {
        for (const heat of heats) {
            const entries = await db.all(`
                SELECT he.lane_number, ee.id AS event_entry_id, ee.status,
                       a.name, a.bib_number, a.team
                FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id
                JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=?
                ORDER BY he.lane_number ASC
            `, heat.id);

            const results = await db.all('SELECT * FROM result WHERE heat_id=? ORDER BY event_entry_id, attempt_number', heat.id);

            // Determine max attempts (usually 6 for final, 3 for qualifying)
            const maxAttempt = results.reduce((max, r) => Math.max(max, r.attempt_number || 0), 0) || 6;
            const numAttempts = Math.max(maxAttempt, 3);

            // Determine if this event has wind (멀리뛰기, 세단뛰기 = yes; 투척 = no)
            const hasWind = /멀리|세단|long|triple/i.test(event.name);

            // Build athlete data
            const resMap = {};
            for (const r of results) {
                if (!resMap[r.event_entry_id]) resMap[r.event_entry_id] = [];
                resMap[r.event_entry_id].push(r);
            }

            const athleteData = entries.map(e => {
                const recs = resMap[e.event_entry_id] || [];
                let best = null; let bestWind = null; let bestAttempt = -1;
                const attempts = [];
                for (let i = 1; i <= numAttempts; i++) {
                    const r = recs.find(r => r.attempt_number === i);
                    if (r) {
                        // [FIX] 수기입력 record.js 는 파울=distance_meters:0, 패스=distance_meters:-1 로 저장하므로
                        //       status_code 뿐 아니라 distance_meters 값으로도 판정해야 한다.
                        const isFoulByDist = (r.distance_meters === 0);
                        const isPassByDist = (r.distance_meters === -1);
                        if (r.status_code === 'X' || r.status_code === 'FOUL' || isFoulByDist) {
                            attempts.push({ dist: null, wind: r.wind, foul: true, pass: false });
                        } else if (r.status_code === '-' || r.status_code === 'PASS' || isPassByDist) {
                            attempts.push({ dist: null, wind: null, foul: false, pass: true });
                        } else if (r.distance_meters != null && r.distance_meters > 0) {
                            attempts.push({ dist: r.distance_meters, wind: r.wind, foul: false, pass: false });
                            if (best === null || r.distance_meters > best) {
                                best = r.distance_meters;
                                bestWind = r.wind;
                                bestAttempt = i;
                            }
                        } else {
                            attempts.push({ dist: null, wind: null, foul: false, pass: false });
                        }
                    } else {
                        attempts.push({ dist: null, wind: null, foul: false, pass: false });
                    }
                }
                let status = recs.find(r => r.status_code && ['DNS','DNF','NM','DQ'].includes(r.status_code))?.status_code || '';
                // Fallback: if entry status is no_show and no explicit DNS result, treat as DNS
                if (!status && e.status === 'no_show') status = 'DNS';
                // [FIX] NM 판정도 distance_meters===0 (파울) 포함
                const allFoulOrEmpty = recs.length > 0 && recs.every(r =>
                    r.status_code === 'X' || r.status_code === 'FOUL' || r.distance_meters === 0
                );
                if (!status && best === null && allFoulOrEmpty) {
                    return { ...e, attempts, best, bestWind, status_code: 'NM' };
                }
                return { ...e, attempts, best, bestWind, status_code: status };
            });

            // Sort by best distance descending
            athleteData.sort((a, b) => {
                const aS = ['DNS','DNF','DQ','NM'].includes(a.status_code);
                const bS = ['DNS','DNF','DQ','NM'].includes(b.status_code);
                if (aS && !bS) return 1;
                if (!aS && bS) return -1;
                if (a.best == null && b.best == null) return 0;
                if (a.best == null) return 1;
                if (b.best == null) return -1;
                return b.best - a.best;
            });

            // Heat label
            if (heats.length > 1) {
                if (curY + 80 > BODY_BOTTOM) { doc.addPage(); curY = drawEventTopHeader(doc); }
                pdfFont(doc, true).fontSize(10).fillColor('#000');
                doc.text(heat.heat_name || `Heat ${heat.heat_number}`, margin, curY);
                curY += 16;
            }

            // Build columns: 순위, 배번, 선수명, 소속명, [1..N], 결과, 비고(wind of best)
            const fdCols = [];
            let fx = tableLeft;
            fdCols.push({ key: 'rank', label: '순위', x: fx, w: totalW * 0.05 }); fx += totalW * 0.05;
            fdCols.push({ key: 'bib', label: '배번', x: fx, w: totalW * 0.06 }); fx += totalW * 0.06;
            fdCols.push({ key: 'name', label: '선수명', x: fx, w: totalW * 0.12 }); fx += totalW * 0.12;
            fdCols.push({ key: 'team', label: teamLabelK, x: fx, w: totalW * 0.14 }); fx += totalW * 0.14;
            const attW = Math.min(totalW * 0.08, (totalW * 0.48) / numAttempts);
            for (let i = 1; i <= numAttempts; i++) {
                fdCols.push({ key: `att_${i}`, label: String(i), x: fx, w: attW }); fx += attW;
            }
            fdCols.push({ key: 'result', label: '결 과', x: fx, w: totalW * 0.09 }); fx += totalW * 0.09;
            fdCols.push({ key: 'remark', label: '비 고', x: fx, w: tableRight - fx });

            // Draw header with 2 sub-rows (attempt numbers + WIND)
            const fdFS = Math.min(fontSize, 7.5);
            curY = drawTableHeader(doc, fdCols, curY, tableLeft, tableRight, fdFS);

            if (hasWind) {
                // WIND sub-header row
                const windH = 12;
                doc.save();
                doc.rect(tableLeft, curY, totalW, windH).fill('#f8f8f8').stroke(PR_TABLE_BORDER);
                pdfFont(doc, false).fontSize(5.5).fillColor('#888');
                doc.text('WIND', tableLeft + totalW * 0.37 / 2, curY + 2, { width: totalW * 0.37, align: 'center' });
                doc.restore();
                curY += windH;
            }

            // Render athletes (2 rows each: distance + wind)
            let rank = 0;
            for (const ath of athleteData) {
                const rowH = hasWind ? 30 : 18; // 2 sub-rows if wind, 1 if not
                if (curY + rowH > BODY_BOTTOM) {
                    doc.addPage(); curY = drawEventTopHeader(doc);
                    curY = drawTableHeader(doc, fdCols, curY, tableLeft, tableRight, fdFS);
                    if (hasWind) curY += 12;
                }
                const special = ['DNS','DNF','DQ','NM'].includes(ath.status_code);
                if (!special && ath.best != null) rank++;

                // Row border
                doc.save();
                doc.rect(tableLeft, curY, totalW, rowH).stroke(PR_TABLE_BORDER);
                doc.restore();

                const y1 = curY + 2;
                pdfFont(doc, false).fontSize(fdFS).fillColor('#000');
                doc.text(special ? '' : (ath.best != null ? String(rank) : ''), fdCols[0].x + 1, y1, { width: fdCols[0].w - 2, align: 'center' });
                doc.text(ath.bib_number || '-', fdCols[1].x + 1, y1, { width: fdCols[1].w - 2, align: 'center' });
                pdfFont(doc, true).fontSize(fdFS);
                doc.text(ath.name || '', fdCols[2].x + 1, y1, { width: fdCols[2].w - 2, align: 'center' });
                pdfFont(doc, false).fontSize(fdFS);
                doc.text(ath.team || '', fdCols[3].x + 1, y1, { width: fdCols[3].w - 2, align: 'center' });

                // Attempt distances (row 1)
                for (let i = 0; i < numAttempts; i++) {
                    const att = ath.attempts[i];
                    const col = fdCols[4 + i];
                    let val = '';
                    if (att.foul) val = 'X';
                    else if (att.pass) val = '-';
                    else if (att.dist != null) val = att.dist.toFixed(2);
                    doc.text(val, col.x + 1, y1, { width: col.w - 2, align: 'center' });
                }

                // Result (best) — DNF/DQ/NM → 기록란 공백, 비고란에만
                const resCol = fdCols[4 + numAttempts];
                pdfFont(doc, true).fontSize(fdFS + 0.5).fillColor('#000');
                doc.text(special ? '' : (ath.best != null ? ath.best.toFixed(2) : ''), resCol.x + 1, y1, { width: resCol.w - 2, align: 'center' });

                // Remark: status_code or wind of best
                const remCol = fdCols[fdCols.length - 1];
                pdfFont(doc, false).fontSize(fdFS).fillColor('#000');
                if (special) {
                    doc.text(ath.status_code, remCol.x + 1, y1, { width: remCol.w - 2, align: 'center' });
                } else if (hasWind && ath.bestWind != null) {
                    doc.text((ath.bestWind >= 0 ? '+' : '') + ath.bestWind.toFixed(1), remCol.x + 1, y1, { width: remCol.w - 2, align: 'center' });
                }

                // Wind per attempt (row 2) — only if hasWind
                if (hasWind) {
                    const y2 = curY + 15;
                    pdfFont(doc, false).fontSize(5.5).fillColor('#888');
                    for (let i = 0; i < numAttempts; i++) {
                        const att = ath.attempts[i];
                        const col = fdCols[4 + i];
                        if (att.wind != null) {
                            doc.text((att.wind >= 0 ? '+' : '') + att.wind.toFixed(1), col.x + 1, y2, { width: col.w - 2, align: 'center' });
                        }
                    }
                }

                curY += rowH;
            }
            curY += 8;
        }

    // ============================================================
    // TRACK / ROAD / RELAY — best time only (existing logic, fixed)
    // ============================================================
    } else {
        const dataRowH2 = Math.max(20, fontSize + 10);
        const rsCols = [];
        let xOff = tableLeft;
        if (tpl.show_rank !== false) { rsCols.push({ key: 'rank', label: '순 위', x: xOff, w: totalW * 0.07 }); xOff += totalW * 0.07; }
        if (tpl.show_lane !== false) { rsCols.push({ key: 'lane', label: '레 인', x: xOff, w: totalW * 0.07 }); xOff += totalW * 0.07; }
        if (tpl.show_bib !== false) { rsCols.push({ key: 'bib', label: '배 번', x: xOff, w: totalW * 0.08 }); xOff += totalW * 0.08; }
        if (tpl.show_name !== false) {
            const usedFrac = (xOff - tableLeft) / totalW + (tpl.show_team !== false ? 0.22 : 0) + (tpl.show_record !== false ? 0.14 : 0) + (tpl.show_remark !== false ? 0.12 : 0) + (tpl.show_wind ? 0.10 : 0);
            const nameFrac = Math.max(0.12, 1 - usedFrac);
            rsCols.push({ key: 'name', label: '선 수 명', x: xOff, w: totalW * nameFrac }); xOff += totalW * nameFrac;
        }
        if (tpl.show_team !== false) { rsCols.push({ key: 'team', label: teamLabelK, x: xOff, w: totalW * 0.22 }); xOff += totalW * 0.22; }
        if (tpl.show_record !== false) { rsCols.push({ key: 'record', label: '기 록', x: xOff, w: totalW * 0.14 }); xOff += totalW * 0.14; }
        if (tpl.show_wind) { rsCols.push({ key: 'wind', label: '풍 속', x: xOff, w: totalW * 0.10 }); xOff += totalW * 0.10; }
        if (tpl.show_remark !== false) { rsCols.push({ key: 'remark', label: '비 고', x: xOff, w: totalW * 0.12 }); xOff += totalW * 0.12; }

        // Load Q/q qualifications for non-final rounds
        let qualMap = {};
        if (event.round_type !== 'final') {
            const quals = await db.all('SELECT event_entry_id, qualification_type FROM qualification_selection WHERE event_id=? AND selected=1', event.id);
            for (const q of quals) { qualMap[q.event_entry_id] = q.qualification_type || 'Q'; }
        }

        for (const heat of heats) {
            const entries = await db.all(`
                SELECT he.lane_number, ee.id AS event_entry_id, ee.status,
                       a.name, a.bib_number, a.team
                FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id
                JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=?
                ORDER BY he.lane_number ASC
            `, heat.id);

            const results = await db.all('SELECT * FROM result WHERE heat_id=? ORDER BY event_entry_id, attempt_number', heat.id);

            if (heats.length > 1) {
                const headerRowH2 = Math.max(22, fontSize + 12);
                const neededH = 30 + headerRowH2 + entries.length * dataRowH2 + 20;
                if (curY + neededH > BODY_BOTTOM) { doc.addPage(); curY = drawEventTopHeader(doc); }
                const hLabel = heat.heat_name || `Heat ${heat.heat_number}`;
                pdfFont(doc, true).fontSize(10).fillColor('#000');
                doc.text(hLabel, margin, curY);
                if (heat.wind != null && tpl.show_wind) { pdfFont(doc, false).fontSize(8).fillColor('#666'); doc.text(`Wind: ${heat.wind}`, margin + 100, curY + 2); }
                curY += 16;
            }

            curY = drawTableHeader(doc, rsCols, curY, tableLeft, tableRight, fontSize);

            const resMap = {};
            for (const r of results) {
                if (!resMap[r.event_entry_id]) resMap[r.event_entry_id] = [];
                resMap[r.event_entry_id].push(r);
            }

            const ranked = entries.map(e => {
                const recs = resMap[e.event_entry_id] || [];
                const r = recs.find(r => r.time_seconds != null);
                const best = r ? r.time_seconds : null;
                const bestWind = r ? r.wind : null;
                let status = recs.find(r => r.status_code && r.status_code !== '' && ['DNS','DNF','NM','DQ'].includes(r.status_code))?.status_code || '';
                // Fallback: if entry status is no_show and no explicit DNS result, treat as DNS
                if (!status && e.status === 'no_show') status = 'DNS';
                return { ...e, best, bestWind, status_code: status, allResults: recs };
            });

            ranked.sort((a, b) => {
                const aS = ['DNS','DNF','NM','DQ'].includes(a.status_code);
                const bS = ['DNS','DNF','NM','DQ'].includes(b.status_code);
                if (aS && !bS) return 1;
                if (!aS && bS) return -1;
                if (a.best == null && b.best == null) return 0;
                if (a.best == null) return 1;
                if (b.best == null) return -1;
                return a.best - b.best;
            });

            let rank = 0;
            for (const e of ranked) {
                if (curY + dataRowH2 > BODY_BOTTOM) {
                    doc.addPage(); curY = drawEventTopHeader(doc);
                    curY = drawTableHeader(doc, rsCols, curY, tableLeft, tableRight, fontSize);
                }
                const special = ['DNS','DNF','NM','DQ'].includes(e.status_code);
                rank++;
                let recStr = '';
                if (special) { recStr = e.status_code; rank--; }
                else if (e.best != null) { recStr = formatTimeForPDF(e.best); }

                // 비고: DNF/DQ/DNS/NM → 비고란에만, Q/q도 비고란
                let remarkStr = '';
                if (special) remarkStr = e.status_code;
                else if (qualMap[e.event_entry_id]) remarkStr = qualMap[e.event_entry_id];
                else remarkStr = e.allResults?.[0]?.remark || '';

                // ─── 비고 멤버 리스트 정규화 (긴 텍스트 줄바꿈) ───
                // 사용자가 비고에 멤버 이름을 ", " 로 구분해 직접 입력하는 케이스 대비:
                //   "이동욱(14:48.74), 이정윤(15:09.42), 김현우(15:20.06)"
                //   → 콤마마다 개행으로 분리해 비고 컬럼 안에 세로로 적층
                // 짧은 텍스트(PB/SB/Q/NR 같은 코드 또는 콤마 없는 단순 텍스트)는 그대로 유지.
                // 임계: 25자 이상 + 콤마 포함 → 멤버 리스트로 간주 (어느 종목이든 안전)
                if (remarkStr && remarkStr.length > 25 && remarkStr.includes(',')) {
                    remarkStr = remarkStr
                        .replace(/\s*,\s*/g, '\n')   // ", " → 개행
                        .trim();
                }

                const vals = rsCols.map(col => {
                    switch (col.key) {
                        case 'rank': return special ? '' : String(rank);
                        case 'lane': return String(e.lane_number || '-');
                        case 'bib': return e.bib_number || '-';
                        case 'name': return e.name || '';
                        case 'team': return e.team || '';
                        case 'record': return special ? '' : (e.best != null ? formatTimeForPDF(e.best) : '');
                        case 'wind': return e.bestWind != null ? String(e.bestWind) : (heat.wind != null ? String(heat.wind) : '');
                        case 'remark': return remarkStr;
                        default: return '';
                    }
                });

                // ─── 비고 자동 줄바꿈 + 행높이 자동 확장 (긴 텍스트 대비) ───
                // wrapCols 에 'remark' 포함 → drawTableRow 가 heightOfString 으로 측정하여 rowH 자동 확장.
                // alignByCol: 비고는 좌측 정렬(이름 리스트가 길 때 가독성 향상)
                // smallFontCols: 비고만 작은 폰트(7pt)로 줄여 좁은 컬럼 안에 더 잘 들어가게 함
                const drawOpts = {
                    boldCols: ['name', 'record'],
                    wrapCols: ['remark'],
                    alignByCol: { remark: 'left' },
                    smallFontCols: { remark: Math.max(7, fontSize - 1) }
                };
                // 페이지 break 안전성: drawTableRow 가 행 높이를 늘릴 수 있으므로
                // 실제 그리기 전에 heightOfString 으로 정확히 측정하고, 자리 부족하면 페이지 추가.
                // ⚠️ 단순 \n 개수 기반 추정은 부정확함 — 비고 컬럼 너비가 좁아서 PDFKit이
                //   자동 줄바꿈으로 추가 라인을 만들 수 있기 때문 (예: "김현우(15:20.06)"이
                //   한 줄에 안 들어가서 2줄이 됨). 반드시 heightOfString 으로 실측해야 함.
                let estRowH = dataRowH2;
                if (remarkStr) {
                    const remarkCol = rsCols.find(c => c.key === 'remark');
                    if (remarkCol) {
                        const remarkFs = drawOpts.smallFontCols.remark;
                        pdfFont(doc, false).fontSize(remarkFs);
                        try {
                            const measured = doc.heightOfString(remarkStr, {
                                width: remarkCol.w - 4,
                                align: 'left',
                                lineGap: 0.5
                            });
                            estRowH = Math.max(estRowH, Math.ceil(measured) + 16);
                        } catch (_) {
                            // 실측 실패시 폴백 — \n 기반 추정에 안전 마진 추가
                            const lineCount = (remarkStr.match(/\n/g) || []).length + 1;
                            estRowH = Math.max(estRowH, lineCount * 2 * (remarkFs + 2) + 16);
                        }
                    }
                }
                if (curY + estRowH > BODY_BOTTOM) {
                    doc.addPage(); curY = drawEventTopHeader(doc);
                    curY = drawTableHeader(doc, rsCols, curY, tableLeft, tableRight, fontSize);
                }
                curY = drawTableRow(doc, rsCols, vals, curY, tableLeft, tableRight, fontSize, drawOpts);
            }
            curY += 8;
        }
    }

    // [PAGE-REPEAT] 모든 페이지에 상단 헤더(이미 본문 그릴 때 그렸음) + 하단 박스 보장
    // bufferPages: true 옵션 덕에 doc.bufferedPageRange() 로 전체 페이지 순회 가능.
    // 본문은 이미 BODY_BOTTOM 위까지만 그렸으므로 하단은 비어 있음 → 박스 안전하게 추가.
    // 단, 마지막 페이지에서 본문이 너무 짧게 끝났더라도 박스는 페이지 하단 고정 위치에 그려야 함.
    try {
        const range = doc.bufferedPageRange(); // { start, count }
        for (let i = range.start; i < range.start + range.count; i++) {
            doc.switchToPage(i);
            // 페이지 마다 상단 헤더는 본문 그릴 때 이미 그렸지만, 첫 페이지 외에 누락 가능성 방어
            // → 본문 그리는 곳 모두에서 drawEventTopHeader 를 호출하므로 여기서는 하단 박스만 그림
            drawEventBottomBox(doc);
        }
    } catch (e) { console.warn('[result-sheet] page-repeat error:', e.message); }

    // Branding footer (마지막 페이지에만 그릴 수도 있고 모든 페이지에 그릴 수도 있음.
    // 기존 동작 유지: 마지막 페이지에만 푸터 — drawBrandingFooter 가 현재 페이지에 그리므로
    // 위 루프 종료 후 마지막 페이지가 활성 상태 → 그대로 호출하면 마지막 페이지에 그려짐.)
    // [개선] 모든 페이지에 푸터도 같이 그리도록 변경
    try {
        const range = doc.bufferedPageRange();
        for (let i = range.start; i < range.start + range.count; i++) {
            doc.switchToPage(i);
            drawBrandingFooter(doc, pageW, pageH, margin);
        }
    } catch (e) { drawBrandingFooter(doc, pageW, pageH, margin); }
    doc.end();
  } catch (err) {
    console.error('[Result Sheet Error]', err);
    if (!res.headersSent) {
        res.status(500).json({ error: '기록지 생성 오류: ' + err.message });
    }
  }
});

/**
 * GET /api/documents/result-sheet/:eventId/png
 * PDF 결과지와 동일한 레이아웃을 PNG 이미지로 변환하여 반환
 * 내부적으로 result-sheet PDF를 생성한 후 pdftoppm으로 PNG 변환
 */
app.get('/api/documents/result-sheet/:eventId/png', async (req, res) => {
    const eventId = req.params.eventId;
    const tmpDir = '/tmp/pacerise_png_' + Date.now() + '_' + eventId;
    try {
        // Step 1: Generate PDF internally by calling our own endpoint
        const pdfUrl = `http://localhost:${PORT}/api/documents/result-sheet/${eventId}`;
        const pdfResp = await fetch(pdfUrl);
        if (!pdfResp.ok) {
            return res.status(pdfResp.status).json({ error: 'PDF generation failed' });
        }
        const pdfBuffer = Buffer.from(await pdfResp.arrayBuffer());

        // Step 2: Write PDF to temp file
        fs.mkdirSync(tmpDir, { recursive: true });
        const pdfPath = path.join(tmpDir, 'result.pdf');
        fs.writeFileSync(pdfPath, pdfBuffer);

        // Step 3: Convert PDF pages to PNG using pdftoppm (300 DPI)
        const pngPrefix = path.join(tmpDir, 'page');
        execSync(`pdftoppm -png -r 300 "${pdfPath}" "${pngPrefix}"`, { timeout: 15000 });

        // Step 4: Read all generated PNG files
        const pngFiles = fs.readdirSync(tmpDir)
            .filter(f => f.startsWith('page') && f.endsWith('.png'))
            .sort();

        if (pngFiles.length === 0) {
            throw new Error('PNG conversion produced no files');
        }

        if (pngFiles.length === 1) {
            // Single page — return directly
            const pngData = fs.readFileSync(path.join(tmpDir, pngFiles[0]));
            res.setHeader('Content-Type', 'image/png');
            res.setHeader('Content-Disposition', `attachment; filename="result_${eventId}.png"`);
            res.send(pngData);
        } else {
            // Multiple pages — stitch vertically using node-canvas
            const images = pngFiles.map(f => {
                const data = fs.readFileSync(path.join(tmpDir, f));
                const img = new (require('canvas').Image)();
                img.src = data;
                return img;
            });
            const totalW = images[0].width;
            const totalH = images.reduce((sum, img) => sum + img.height, 0);
            const stitched = createCanvas(totalW, totalH);
            const sctx = stitched.getContext('2d');
            let offsetY = 0;
            for (const img of images) {
                sctx.drawImage(img, 0, offsetY);
                offsetY += img.height;
            }
            const pngBuf = stitched.toBuffer('image/png');
            res.setHeader('Content-Type', 'image/png');
            res.setHeader('Content-Disposition', `attachment; filename="result_${eventId}.png"`);
            res.send(pngBuf);
        }
    } catch (err) {
        console.error('[Result Sheet PNG Error]', err);
        if (!res.headersSent) {
            res.status(500).json({ error: 'PNG 생성 오류: ' + err.message });
        }
    } finally {
        // Cleanup temp files
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e) {}
    }
});

function formatTimeForPDF(s) {
    if (s == null) return '';
    if (s >= 3600) {
        const h = Math.floor(s / 3600);
        const m = Math.floor((s - h * 3600) / 60);
        const r = s - h * 3600 - m * 60;
        return `${h}:${m < 10 ? '0' : ''}${m}:${r < 10 ? '0' : ''}${r.toFixed(2)}`;
    }
    if (s >= 60) {
        const m = Math.floor(s / 60);
        const r = s - m * 60;
        return `${m}:${r < 10 ? '0' : ''}${r.toFixed(2)}`;
    }
    return s.toFixed(2);
}

// AD Card PDF — 선수 인가증 (Template-aware)
app.get('/api/documents/ad-card/:compId', async (req, res) => {
    const comp = await db.get('SELECT * FROM competition WHERE id=?', req.params.compId);
    if (!comp) return res.status(404).json({ error: 'Competition not found' });
    const athletes = await db.all(`SELECT * FROM athlete WHERE competition_id=? ORDER BY ${orderByBibSql()}`, comp.id);
    if (athletes.length === 0) return res.status(404).json({ error: 'No athletes found' });
    const tpl = (await getDocTemplate(comp.id)).ad_card;

    const cardsPerPage = tpl.cards_per_page || 4;
    const bibSize = tpl.bib_font_size || 48;
    const nameSize = tpl.name_font_size || 16;
    const bandMode = tpl.band_color_mode || 'gender_auto';
    const customColor = tpl.custom_band_color || '#2d9d78';

    const doc = new PDFDocument({ size: 'A4', margin: 20, bufferPages: true });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Content-Disposition', `inline; filename="ad-cards_${comp.id}.pdf"`);
    doc.pipe(res);

    // Layout calculation based on cards_per_page
    let CARD_W, CARD_H, COLS, ROWS, GAP_X, GAP_Y, START_X, START_Y;
    if (cardsPerPage === 1) {
        CARD_W = 515; CARD_H = 760; COLS = 1; ROWS = 1; GAP_X = 0; GAP_Y = 0; START_X = 40; START_Y = 30;
    } else if (cardsPerPage === 2) {
        CARD_W = 400; CARD_H = 360; COLS = 1; ROWS = 2; GAP_X = 0; GAP_Y = 20; START_X = 98; START_Y = 25;
    } else {
        CARD_W = 260; CARD_H = 360; COLS = 2; ROWS = 2; GAP_X = 15; GAP_Y = 15; START_X = 25; START_Y = 25;
    }

    for (let idx = 0; idx < athletes.length; idx++) {
        const athlete = athletes[idx];
        if (idx > 0 && idx % cardsPerPage === 0) doc.addPage();
        const posInPage = idx % cardsPerPage;
        const col = posInPage % COLS;
        const row = Math.floor(posInPage / COLS) % ROWS;
        const x = START_X + col * (CARD_W + GAP_X);
        const y = START_Y + row * (CARD_H + GAP_Y);

        // Card border
        doc.save();
        doc.roundedRect(x, y, CARD_W, CARD_H, 8).stroke('#333');

        // Header band color
        let bandColor;
        if (bandMode === 'custom') {
            bandColor = customColor;
        } else {
            bandColor = athlete.gender === 'M' ? '#2196F3' : athlete.gender === 'F' ? '#E91E63' : '#FFC107';
        }
        doc.rect(x, y, CARD_W, 40).fill(bandColor);

        // Competition name on band
        pdfFont(doc, true).fontSize(cardsPerPage === 1 ? 12 : 8).fillColor('#fff');
        doc.text(comp.name, x + 10, y + 6, { width: CARD_W - 20, align: 'center' });
        pdfFont(doc, false).fontSize(cardsPerPage === 1 ? 8 : 6).fillColor('#fff');
        doc.text('ACCREDITATION / AD CARD', x + 10, y + (cardsPerPage === 1 ? 26 : 22), { width: CARD_W - 20, align: 'center' });

        let contentY = y + 55;
        const centerX = x + 10;
        const contentW = CARD_W - 20;

        // Bib number (conditional)
        if (tpl.show_bib !== false) {
            pdfFont(doc, true).fontSize(bibSize).fillColor('#1a1a1a');
            doc.text(athlete.bib_number || '-', centerX, contentY, { width: contentW, align: 'center' });
            contentY += bibSize + (cardsPerPage === 1 ? 20 : 12);
        }

        // Name (conditional)
        if (tpl.show_name !== false) {
            pdfFont(doc, true).fontSize(nameSize).fillColor('#333');
            doc.text(athlete.name || '', centerX, contentY, { width: contentW, align: 'center' });
            contentY += nameSize + 10;
        }

        // Team (conditional)
        if (tpl.show_team !== false) {
            pdfFont(doc, false).fontSize(cardsPerPage === 1 ? 14 : 11).fillColor('#666');
            doc.text(athlete.team || '', centerX, contentY, { width: contentW, align: 'center' });
            contentY += (cardsPerPage === 1 ? 24 : 18);
        }

        // Gender label (conditional)
        if (tpl.show_gender !== false) {
            const gLabel = athlete.gender === 'M' ? 'MALE' : athlete.gender === 'F' ? 'FEMALE' : 'MIXED';
            pdfFont(doc, true).fontSize(9).fillColor(bandColor);
            doc.text(gLabel, centerX, contentY, { width: contentW, align: 'center' });
            contentY += 18;
        }

        // Events enrolled (conditional)
        if (tpl.show_events !== false) {
            const events = await db.all(`
                SELECT e.name, e.gender, e.round_type FROM event_entry ee
                JOIN event e ON e.id = ee.event_id
                WHERE ee.athlete_id = ? AND e.competition_id = ? AND e.parent_event_id IS NULL
                ORDER BY e.sort_order
            `, athlete.id, comp.id);

            contentY += 5;
            pdfFont(doc, true).fontSize(7).fillColor('#999');
            doc.text('EVENTS', centerX, contentY, { width: contentW, align: 'center' });
            contentY += 12;
            pdfFont(doc, false).fontSize(8).fillColor('#333');
            const maxEvents = cardsPerPage === 1 ? 12 : 6;
            for (const ev of events.slice(0, maxEvents)) {
                doc.text(ev.name, centerX, contentY, { width: contentW, align: 'center' });
                contentY += 11;
            }
            if (events.length > maxEvents) {
                doc.text(`+${events.length - maxEvents} more`, centerX, contentY, { width: contentW, align: 'center' });
            }
        }

        // Barcode placeholder (conditional)
        if (tpl.show_barcode) {
            const barcodeY = y + CARD_H - 55;
            pdfFont(doc, false).fontSize(7).fillColor('#666');
            doc.text('|||||||||||||||||||||||', centerX, barcodeY, { width: contentW, align: 'center', characterSpacing: 2 });
            pdfFont(doc, false).fontSize(6).fillColor('#888');
            doc.text(athlete.barcode || athlete.bib_number || '', centerX, barcodeY + 12, { width: contentW, align: 'center' });
        }

        // Footer with comp venue & dates
        pdfFont(doc, false).fontSize(6).fillColor('#aaa');
        doc.text(`${comp.venue || ''} | ${comp.start_date} ~ ${comp.end_date}`, centerX, y + CARD_H - 30, { width: contentW, align: 'center' });
        pdfFont(doc, false).fontSize(5).fillColor('#ccc');
        doc.text('PACE RISE Competition OS', centerX, y + CARD_H - 18, { width: contentW, align: 'center' });

        doc.restore();
    }

    doc.end();
});

// ============================================================
// EVENT RECORDS MANAGEMENT — 종목별 기록 관리 API
// ============================================================

// GET all event records (optionally filter by gender)
app.get('/api/event-records', async (req, res) => {
    try {
        const gender = req.query.gender; // M or F
        let rows;
        if (gender) {
            rows = await db.all('SELECT * FROM event_record WHERE gender=? ORDER BY event_name, record_type', gender);
        } else {
            rows = await db.all('SELECT * FROM event_record ORDER BY gender, event_name, record_type');
        }
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET records for a specific event
app.get('/api/event-records/:gender/:eventName', async (req, res) => {
    try {
        const { gender, eventName } = req.params;
        const rows = await db.all('SELECT * FROM event_record WHERE gender=? AND event_name=? ORDER BY record_type', gender, decodeURIComponent(eventName));
        // Return as object: { national: {...}, division: {...}, competition: {...} }
        const result = {};
        for (const r of rows) result[r.record_type] = r;
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT (upsert) event record — 백워드 호환 (구 UI 호출용)
// v4 스키마: UNIQUE(record_type, event_name, gender, division_code, series_id)
// 구 UI는 division_code/series_id 없이 호출하므로 NULL로 처리 → NR(national)만 의미 있음.
// DR/CR도 division_code/series_id NULL인 슬롯 하나만 차지하게 됨 (구 호환).
// 새 UI는 /api/records (신 API) 를 사용해야 함.
app.put('/api/event-records', async (req, res) => {
    try {
        const { admin_key, gender, event_name, record_type, record_value, holder_name, holder_team, record_year } = req.body;
        if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        if (!gender || !event_name || !record_type) return res.status(400).json({ error: 'gender, event_name, record_type 필수' });
        if (!['M','F','X'].includes(gender)) return res.status(400).json({ error: 'gender는 M/F/X' });
        if (!['national','division','competition'].includes(record_type)) return res.status(400).json({ error: 'record_type는 national/division/competition' });

        // v4 UNIQUE: (record_type, event_name, gender, division_code, series_id)
        // SQLite/PG 모두 NULL은 distinct로 취급하므로 ON CONFLICT 사용 불가 → 수동 UPSERT
        const existing = await db.get(
            `SELECT id FROM event_record WHERE record_type=? AND event_name=? AND gender=? AND division_code IS NULL AND series_id IS NULL`,
            record_type, event_name, gender
        );
        if (existing) {
            await db.run(
                `UPDATE event_record SET record_value=?, holder_name=?, holder_team=?, record_year=?, updated_at=` + (db.isAsync ? 'NOW()' : `datetime('now')`) + ` WHERE id=?`,
                record_value || '', holder_name || '', holder_team || '', record_year || '', existing.id
            );
        } else {
            await db.run(
                `INSERT INTO event_record (record_type, event_name, gender, division_code, series_id, record_value, holder_name, holder_team, record_year, approved) VALUES (?,?,?,NULL,NULL,?,?,?,?,1)`,
                record_type, event_name, gender, record_value || '', holder_name || '', holder_team || '', record_year || ''
            );
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT batch upsert for a single event (all 3 record types at once) — 백워드 호환
app.put('/api/event-records/batch', async (req, res) => {
    try {
        const { admin_key, gender, event_name, records } = req.body;
        if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        if (!gender || !event_name || !records) return res.status(400).json({ error: 'gender, event_name, records 필수' });

        const nowExpr = db.isAsync ? 'NOW()' : `datetime('now')`;
        await db.transaction(async () => {
            for (const rt of ['national', 'division', 'competition']) {
                const r = records[rt];
                if (!r) continue;
                const existing = await db.get(
                    `SELECT id FROM event_record WHERE record_type=? AND event_name=? AND gender=? AND division_code IS NULL AND series_id IS NULL`,
                    rt, event_name, gender
                );
                if (existing) {
                    await db.run(
                        `UPDATE event_record SET record_value=?, holder_name=?, holder_team=?, record_year=?, updated_at=${nowExpr} WHERE id=?`,
                        r.record_value || '', r.holder_name || '', r.holder_team || '', r.record_year || '', existing.id
                    );
                } else {
                    await db.run(
                        `INSERT INTO event_record (record_type, event_name, gender, division_code, series_id, record_value, holder_name, holder_team, record_year, approved) VALUES (?,?,?,NULL,NULL,?,?,?,?,1)`,
                        rt, event_name, gender, r.record_value || '', r.holder_name || '', r.holder_team || '', r.record_year || ''
                    );
                }
            }
        })();

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// RECORDS MANAGEMENT v4 — NR/DR/CR 통합 신 API (Phase B-2)
// ============================================================

// GET divisions master
app.get('/api/divisions', async (req, res) => {
    try {
        const rows = await db.all('SELECT code, label_ko, gender, school_level, sort_order FROM division_master WHERE active=1 ORDER BY sort_order, code');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Division Master CRUD (관리자 전용) ───
// 기본 13부 시드(시스템 부)는 code 변경/삭제 차단, label_ko/sort_order만 편집 허용.
const BASE_DIVISION_CODES = new Set([
    'M_ELEM','M_MID','M_HIGH','M_UNIV','M_GEN','M_OPEN',
    'F_ELEM','F_MID','F_HIGH','F_UNIV','F_GEN','F_OPEN',
    'MIXED'
]);

// GET all divisions (active+inactive, admin/operator view)
app.get('/api/admin/divisions', async (req, res) => {
    try {
        const rows = await db.all('SELECT code, label_ko, gender, school_level, sort_order, active, created_at FROM division_master ORDER BY sort_order, code');
        // is_base 플래그 부여 (UI 보호용)
        const result = rows.map(r => ({ ...r, is_base: BASE_DIVISION_CODES.has(r.code) }));
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST create division (admin only)
app.post('/api/admin/divisions', async (req, res) => {
    try {
        const { admin_key, code, label_ko, gender, school_level, sort_order } = req.body || {};
        if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        if (!code || !code.trim()) return res.status(400).json({ error: 'code 필수' });
        if (!label_ko || !label_ko.trim()) return res.status(400).json({ error: 'label_ko 필수' });
        if (!['M','F','X'].includes(gender)) return res.status(400).json({ error: 'gender는 M/F/X 중 하나' });
        const validLevels = ['OPEN','ELEM','MID','HIGH','UNIV','GEN','MIXED'];
        if (!validLevels.includes(school_level)) return res.status(400).json({ error: 'school_level은 ' + validLevels.join('/') + ' 중 하나' });
        const codeTrim = code.trim().toUpperCase();
        // code 형식 검증 (영숫자/언더스코어만)
        if (!/^[A-Z0-9_]+$/.test(codeTrim)) return res.status(400).json({ error: 'code는 영문 대문자/숫자/언더스코어만 사용 가능' });
        const so = Number.isFinite(parseInt(sort_order, 10)) ? parseInt(sort_order, 10) : 500;
        try {
            await db.run(
                'INSERT INTO division_master (code, label_ko, gender, school_level, sort_order, active) VALUES (?, ?, ?, ?, ?, 1)',
                codeTrim, label_ko.trim(), gender, school_level, so
            );
            const row = await db.get('SELECT code, label_ko, gender, school_level, sort_order, active, created_at FROM division_master WHERE code=?', codeTrim);
            opLog(`부 생성: ${codeTrim} (${label_ko.trim()})`, 'admin', 'admin');
            res.json({ ...row, is_base: false });
        } catch (e) {
            if (/UNIQUE|duplicate|PRIMARY/i.test(e.message)) return res.status(400).json({ error: '같은 code의 부가 이미 존재합니다.' });
            throw e;
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT update division (admin only). 기본 13부는 label_ko / sort_order 만 변경 가능.
app.put('/api/admin/divisions/:code', async (req, res) => {
    try {
        const { admin_key, label_ko, gender, school_level, sort_order, active } = req.body || {};
        if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        const code = req.params.code;
        const old = await db.get('SELECT * FROM division_master WHERE code=?', code);
        if (!old) return res.status(404).json({ error: 'Not found' });
        const isBase = BASE_DIVISION_CODES.has(code);

        // 변경 가능 필드 결정
        const newLabel = (label_ko !== undefined && label_ko !== null && String(label_ko).trim()) ? String(label_ko).trim() : old.label_ko;
        const newSort = (sort_order !== undefined && Number.isFinite(parseInt(sort_order, 10))) ? parseInt(sort_order, 10) : old.sort_order;
        let newGender = old.gender;
        let newLevel = old.school_level;
        let newActive = old.active;

        if (!isBase) {
            if (gender !== undefined) {
                if (!['M','F','X'].includes(gender)) return res.status(400).json({ error: 'gender는 M/F/X 중 하나' });
                newGender = gender;
            }
            if (school_level !== undefined) {
                const validLevels = ['OPEN','ELEM','MID','HIGH','UNIV','GEN','MIXED'];
                if (!validLevels.includes(school_level)) return res.status(400).json({ error: 'school_level은 ' + validLevels.join('/') + ' 중 하나' });
                newLevel = school_level;
            }
            if (active !== undefined) newActive = active ? 1 : 0;
        }

        await db.run(
            'UPDATE division_master SET label_ko=?, gender=?, school_level=?, sort_order=?, active=? WHERE code=?',
            newLabel, newGender, newLevel, newSort, newActive, code
        );
        const row = await db.get('SELECT code, label_ko, gender, school_level, sort_order, active, created_at FROM division_master WHERE code=?', code);
        opLog(`부 수정: ${code} (${newLabel})`, 'admin', 'admin');
        res.json({ ...row, is_base: isBase });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE division (admin only). 기본 13부는 삭제 차단. 커스텀 부는 사용 중이면 force 필요.
app.delete('/api/admin/divisions/:code', async (req, res) => {
    try {
        const { admin_key, force, hard } = req.body || {};
        if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        const code = req.params.code;
        if (BASE_DIVISION_CODES.has(code)) return res.status(400).json({ error: '기본 13부는 삭제할 수 없습니다.' });
        const old = await db.get('SELECT * FROM division_master WHERE code=?', code);
        if (!old) return res.status(404).json({ error: 'Not found' });

        // 사용 중인 종목/기록 카운트 (SQLite/PG 양쪽 호환)
        let eventCnt = null, recCnt = null;
        try { eventCnt = await db.get('SELECT COUNT(*) AS c FROM event WHERE division=?', code); } catch(_) {}
        try { recCnt = await db.get('SELECT COUNT(*) AS c FROM event_record WHERE division_code=?', code); } catch(_) {}
        const usedEvents = eventCnt?.c || 0;
        const usedRecords = recCnt?.c || 0;

        if ((usedEvents > 0 || usedRecords > 0) && !force) {
            return res.status(409).json({
                error: '사용 중인 부입니다.',
                needs_force: true,
                used_events: usedEvents,
                used_records: usedRecords,
                message: `종목 ${usedEvents}개, 기록 ${usedRecords}개에서 사용 중입니다. 강제 삭제하려면 force=true로 다시 요청하세요.`
            });
        }

        if (hard && usedEvents === 0 && usedRecords === 0) {
            await db.run('DELETE FROM division_master WHERE code=?', code);
            opLog(`부 완전 삭제: ${code} (${old.label_ko})`, 'admin', 'admin');
            res.json({ success: true, deleted: 'hard', code });
        } else {
            // 기본 동작: soft delete (active=0). 종목/기록의 division 값은 그대로 유지 (보존).
            await db.run('UPDATE division_master SET active=0 WHERE code=?', code);
            opLog(`부 비활성화: ${code} (${old.label_ko}) — 사용 종목 ${usedEvents}, 기록 ${usedRecords}건`, 'admin', 'admin');
            res.json({ success: true, deleted: 'soft', code, used_events: usedEvents, used_records: usedRecords });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Competition Series CRUD ─── (lib/routes/competition_series.js 로 추출)
require('./lib/routes/competition_series')(app, { db, isAdminKey, opLog });

// ─── Records v4 (NR/DR/CR 통합) ─── (lib/routes/records.js 로 추출)
require('./lib/routes/records')(app, { db, isAdminKey, opLog });

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

        rankings = athleteData.filter(a => a.status_code !== 'DNS').slice(0, 8).map(a => ({
          name: a.name || '',
          team: a.team || '',
          record: ['DNS','DNF','DQ'].includes(a.status_code) ? a.status_code : String(a.totalPoints),
          wind: null,
          wa_score: null
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
          wa_score: null
        }));
        // Add NM/DNS/DNF at end
        const specials = athleteData.filter(a => ['DNS','DNF','DQ','NM'].includes(a.status_code) || a.bestCleared == null);
        for (const s of specials) {
          if (rankings.length >= 8) break;
          rankings.push({ name: s.name || '', team: s.team || '', record: s.status_code || 'NM', wind: null, wa_score: null });
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
            allEntries.push({ ...e, best, bestWind, status_code: status });
          }
        }

        allEntries.sort((a, b) => {
          const aS = ['DNS','DNF','DQ','NM'].includes(a.status_code);
          const bS = ['DNS','DNF','DQ','NM'].includes(b.status_code);
          if (aS && !bS) return 1; if (!aS && bS) return -1;
          if (a.best == null && b.best == null) return 0;
          if (a.best == null) return 1; if (b.best == null) return -1;
          return b.best - a.best;
        });

        // 투척+도약 모두 "15m09" 형식 사용 (fmtJumpCm은 cm정수 "1509"로 변환되어 오류)
        const fmtFn = (isThrow || isJump) ? fmtFieldDist : (m => m != null ? m.toFixed(2) : '');

        rankings = allEntries.filter(a => a.status_code !== 'DNS').slice(0, 8).map(a => ({
          name: a.name || '',
          team: a.team || '',
          record: ['DNS','DNF','DQ','NM'].includes(a.status_code) ? a.status_code : fmtFn(a.best),
          wind: (hasWind && a.bestWind != null) ? fmtWind(a.bestWind) : null,
          wa_score: null
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

        for (const a of allEntries.filter(e => e.status_code !== 'DNS').slice(0, 8)) {
          const isSpecial = ['DNF','NM','DQ'].includes(a.status_code);
          const entry = {
            name: a.name || '',
            team: a.team || '',
            record: isSpecial ? a.status_code : fmtTrackTime(a.best),
            wind: null,
            wa_score: null
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

    // Fill events
    for (const evt of resultEvents) {
      const row = rowMap[evt.template_name];
      if (!row) continue;
      for (let i = 0; i < Math.min(evt.rankings.length, 8); i++) {
        const r = evt.rankings[i];
        const [nameCol, recCol] = PLACE_COLS[i];
        if (evt.is_relay && r.members && r.members.length >= 2) {
          queueCell(`${nameCol}${row}`, r.members.slice(0, 2).join(' '));
          if (r.members.length >= 3) queueCell(`${RELAY_EXTRA[i]}${row}`, r.members.slice(2, 4).join(' '));
        } else {
          queueCell(`${nameCol}${row}`, r.name);
        }
        queueCell(`${recCol}${row}`, r.record);
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
const _certMod = require('./lib/routes/certificate')(app, {
    db, isAdminKey,
    generateCertificatePdf, generateCertificateBatch,
    upload,
    publicDir: path.join(__dirname, 'public'),
});
const getEventResultsForCert = _certMod.getEventResultsForCert;
// ========== END Certificate System ==========

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
                request_ip: (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim(),
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
            const candidates = await db.all('SELECT * FROM external_api_key WHERE key_prefix=?', prefix);
            let matched = null;
            for (const c of candidates) {
                if (bcrypt.compareSync(plainKey, c.key_hash)) { matched = c; break; }
            }
            if (!matched) {
                return res.status(403).json({ success: false, error_code: 'INVALID_API_KEY', message: '유효하지 않은 API 키입니다.' });
            }
            if (matched.revoked_at) {
                return res.status(403).json({ success: false, error_code: 'KEY_REVOKED', message: '회수된 API 키입니다.' });
            }
            if (matched.expires_at && matched.expires_at < new Date().toISOString()) {
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

                // Build unique event key (eventName + gender + division)
                // Combined sub-events (10종, 7종, 5종) should map to parent combined event
                let parentEventName = eventName;
                let isCombinedSub = false;
                if (/^\d+종\(\d+\)/.test(rawRound)) {
                    isCombinedSub = true;
                    const combMatch = rawRound.match(/^(\d+)종/);
                    if (combMatch) parentEventName = combMatch[1] + '종경기';
                    category = 'combined';
                }

                const eventKey = `${isCombinedSub ? parentEventName : eventName}|${gender}|${division}`;
                if (!eventMap[eventKey]) {
                    eventMap[eventKey] = {
                        name: isCombinedSub ? parentEventName : eventName,
                        gender, division, category,
                        rounds: new Set(),
                    };
                }
                if (!isCombinedSub) {
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
            let eventCount = 0;
            let sortIdx = existingEvents.length;

            for (const ev of Object.values(eventMap)) {
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
                        await db.run(INS_EVENT_SQL, parseInt(competition_id), ev.name, ev.category, ev.gender, rt, ev.division || '', sortIdx++);
                        existingSet.add(key);
                        eventCount++;
                    }
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
        if (!match && targetDivNorm) {
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

            // Delete existing roster for this day
            await db.run('DELETE FROM display_roster WHERE competition_id=? AND day=?', parseInt(competition_id), dayNum);

            // Insert parsed roster
            await db.transaction(async () => {
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

        // 트랜잭션: day별 삭제 후 INSERT
        await db.transaction(async () => {
            for (const d of [...daysSeen]) {
                await db.run('DELETE FROM display_roster WHERE competition_id=? AND day=?', parseInt(competition_id), d);
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
    res.sendFile(path.join(__dirname, 'public', 'display-manage.html'));
});

// ============================================================
// BROADCAST OVERLAY — OBS/vMix HTML Overlay pages
// ============================================================
app.get('/overlay/scoreboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'overlay-scoreboard.html'));
});
app.get('/overlay/lower-third', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'overlay-lower-third.html'));
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

wss.on('connection', (ws) => {
    wsClients.add(ws);
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

async function sendCurrentScoreboard(ws, compId) {
    if (!compId) return;
    const activeEvent = await db.get("SELECT * FROM event WHERE competition_id=? AND round_status='in_progress' AND parent_event_id IS NULL ORDER BY sort_order LIMIT 1", compId);
    if (!activeEvent) {
        ws.send(JSON.stringify({ type: 'scoreboard_state', data: { event: null } }));
        return;
    }
    const heat = await db.get('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number DESC LIMIT 1', activeEvent.id);
    const totalHeatsRow = await db.get('SELECT COUNT(*) as cnt FROM heat WHERE event_id=?', activeEvent.id);
    const totalHeats = (totalHeatsRow && totalHeatsRow.cnt) || 0;
    
    // Get entries for this event's heat
    let entries = heat ? await db.all(`
        SELECT he.lane_number, ee.id as event_entry_id, ee.status, a.name, a.bib_number, a.team
        FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id
        JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=?
        ORDER BY he.lane_number ASC
    `, heat.id) : [];
    let results = heat ? await db.all('SELECT * FROM result WHERE heat_id=?', heat.id) : [];
    
    // Check for linked (joint) events — 합동 종목 전광판
    const linkedEvents = await db.all(`
        SELECT CASE WHEN event_id_a = ? THEN event_id_b ELSE event_id_a END as linked_id
        FROM event_link WHERE event_id_a = ? OR event_id_b = ?
    `, activeEvent.id, activeEvent.id, activeEvent.id);
    
    const comp = await db.get('SELECT federation, name FROM competition WHERE id=?', compId);
    const primaryFed = (comp && (comp.federation || comp.name)) || '';
    
    // Tag primary entries with federation
    entries = entries.map(e => ({ ...e, federation: primaryFed }));
    
    // Merge linked event entries
    for (const link of linkedEvents) {
        const linkedEvt = await db.get('SELECT e.*, c.federation, c.name as comp_name FROM event e JOIN competition c ON c.id=e.competition_id WHERE e.id=?', link.linked_id);
        if (!linkedEvt) continue;
        const linkedHeat = await db.get('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number DESC LIMIT 1', link.linked_id);
        if (!linkedHeat) continue;
        
        const linkedEntries = await db.all(`
            SELECT he.lane_number, ee.id as event_entry_id, ee.status, a.name, a.bib_number, a.team
            FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id
            JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=?
            ORDER BY he.lane_number ASC
        `, linkedHeat.id);
        const linkedResults = await db.all('SELECT * FROM result WHERE heat_id=?', linkedHeat.id);
        
        const linkedFed = linkedEvt.federation || linkedEvt.comp_name || '';
        entries = entries.concat(linkedEntries.map(e => ({ ...e, federation: linkedFed })));
        results = results.concat(linkedResults);
    }

    ws.send(JSON.stringify({
        type: 'scoreboard_state',
        data: {
            event: activeEvent,
            heat,
            total_heats: totalHeats,
            is_joint: linkedEvents.length > 0,
            entries: entries.map(e => {
                const r = results.find(r => r.event_entry_id === e.event_entry_id);
                const record = r ? (r.time_seconds ?? r.distance_meters ?? null) : null;
                return { ...e, record, status_code: r?.status_code || '' };
            })
        },
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

// Export app/server for tests; only auto-listen when run directly (node server.js)
if (require.main !== module) {
    module.exports = { app, server };
} else
server.listen(PORT, '0.0.0.0', async () => {
    // PG 모드: boot 시 1회 async 캐시 로드 (SQLite는 boot 직후 sync 로드 완료됨)
    if (db.isAsync) {
        try {
            await _loadConfigCacheAsync();
            await _reloadOpKeyCacheAsync();
            // PG 모드 초기 admin 자동 시드: admin_pw 가 없으면 env 값으로 bcrypt 해시 저장
            if (!_configCache.has('admin_id')) {
                setConfigKey('admin_id', process.env.ADMIN_ID || 'admin');
            }
            if (!_configCache.has('admin_pw')) {
                setConfigKey('admin_pw', bcrypt.hashSync(process.env.ADMIN_PW || 'changeme', 10));
            } else {
                // 평문 → bcrypt 자동 마이그레이션 (SQLite L581 와 동일 로직, PG 누락 보완)
                const existingPw = _configCache.get('admin_pw') || '';
                if (existingPw && !existingPw.startsWith('$2a$') && !existingPw.startsWith('$2b$') && !existingPw.startsWith('$2y$')) {
                    console.log('  [PG migration] admin_pw 가 평문 형태 → bcrypt 해시로 자동 변환');
                    setConfigKey('admin_pw', bcrypt.hashSync(existingPw, 10));
                }
            }
            if (!_configCache.has('operation_key')) {
                setConfigKey('operation_key', process.env.OPERATION_KEY || '1234');
            }
            console.log(`  [PG cache] config: ${_configCache.size} keys, opkey: ${_opKeyCache.size} keys`);
        } catch (e) {
            console.error('[PG cache load] failed:', e.message);
        }
    }
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
