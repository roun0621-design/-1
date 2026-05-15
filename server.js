/**
 * Pace Rise Competition OS — Express Server v5
 * Multi-competition, 3-tier auth (viewer/judge/admin)
 * v5: WebSocket scoreboard, PDF documents, broadcast overlay, security enhancements
 */
require('dotenv').config();
const express = require('express');
const compression = require('compression');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx');
const helmet = require('helmet');
const { generateFullRecordExcel } = require('./lib/fullRecordExcel');
const { generateFullRecordPdf } = require('./lib/fullRecordPdf');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const { initDatabase, DB_PATH } = require('./db/init');
const { getDb } = require('./lib/db');
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

// 매일 새벽 3시 자동 백업 (KST = UTC+9 → UTC 18시)
cron.schedule('0 18 * * *', () => performBackup('daily'));

// 대회 진행 중 30분마다 백업 (활성 대회가 있을 때만)
cron.schedule('*/30 * * * *', () => {
    try {
        const active = db.prepare("SELECT COUNT(*) as c FROM competition WHERE status IN ('in_progress','active')").get();
        if (active && active.c > 0) performBackup('live');
    } catch(e) {}
});

// 서버 시작 시 1회 백업
setTimeout(() => performBackup('startup'), 5000);

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

// /open — Android intent:// 중간 리다이렉트 페이지 (카카오톡/인스타 인앱브라우저 대응)
app.get('/open', (req, res) => res.sendFile(path.join(__dirname, 'public', 'open.html')));

// DB 어댑터 사용 (lib/db.js).
// 기존 better-sqlite3 인터페이스 100% 호환 — db.prepare/.get/.all/.run/.exec/.transaction/.pragma 모두 정상 동작.
// 환경변수 DB_BACKEND=sqlite (기본) / postgres (예정)로 백엔드 전환 가능.
const db = getDb();

// ---- Access Keys (persisted in DB via system_config table) ----
// Ensure tables exist
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
try {
    const tableInfo = db.prepare("PRAGMA table_info(athlete)").all();
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
try {
    const linksNoKey = db.prepare(`SELECT el.*, ea.name, ea.gender, ea.round_type, ea.competition_id
        FROM event_link el JOIN event ea ON ea.id = el.event_id_a
        WHERE el.joint_scoreboard_key IS NULL`).all();
    for (const link of linksNoKey) {
        const genderLabel = { M: '남자', F: '여자', X: '혼성' }[link.gender] || '';
        const roundLabel = { preliminary: '예선', semifinal: '준결승', final: '결승' }[link.round_type] || link.round_type;
        const key = `합동 ${genderLabel} ${link.name} ${roundLabel}`;
        db.prepare('UPDATE event_link SET joint_scoreboard_key=? WHERE id=?').run(key, link.id);
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
// Seed default federations if table is empty
try {
    const fedCount = db.prepare('SELECT COUNT(*) as cnt FROM federation_list').get().cnt;
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

// Persist default admin in DB if not exists
function getConfigKey(k, def) {
    const row = db.prepare('SELECT value FROM system_config WHERE key=?').get(k);
    return row ? row.value : def;
}
function setConfigKey(k, v) {
    db.prepare('INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)').run(k, v);
}
// Initialize default admin account if not in system_config (bcrypt hashed)
if (!db.prepare("SELECT 1 FROM system_config WHERE key='admin_id'").get()) {
    setConfigKey('admin_id', process.env.ADMIN_ID || 'admin');
    setConfigKey('admin_pw', bcrypt.hashSync(process.env.ADMIN_PW || 'changeme', 10));
}
// Migrate: if existing admin_pw is plaintext (not bcrypt hash), hash it
{
    const existingPw = getConfigKey('admin_pw', '');
    if (existingPw && !existingPw.startsWith('$2a$') && !existingPw.startsWith('$2b$')) {
        setConfigKey('admin_pw', bcrypt.hashSync(existingPw, 10));
    }
}
// Legacy compat: also store operation key in DB
if (!db.prepare("SELECT 1 FROM system_config WHERE key='operation_key'").get()) {
    setConfigKey('operation_key', process.env.OPERATION_KEY || '1234');
}

const ACCESS_KEYS = {
    get operation() { return getConfigKey('operation_key', '1234'); },
    set operation(v) { setConfigKey('operation_key', v); },
    get adminHash() { return getConfigKey('admin_pw', ''); },
    set admin(v) { setConfigKey('admin_pw', bcrypt.hashSync(v, 10)); },
};
const ADMIN_ID = () => getConfigKey('admin_id', 'admin');

function isOperationKey(key) {
    if (!key) return false;
    if (key === ACCESS_KEYS.operation) return true;
    if (bcrypt.compareSync(key, ACCESS_KEYS.adminHash)) return true;
    const dbKey = db.prepare('SELECT * FROM operation_key WHERE key_value=? AND active=1').get(key);
    return !!dbKey;
}
function isAdminKey(key) {
    if (!key) return false;
    return bcrypt.compareSync(key, ACCESS_KEYS.adminHash);
}
function isAdminOrManager(key) {
    if (isAdminKey(key)) return true;
    const dbKey = db.prepare('SELECT * FROM operation_key WHERE key_value=? AND active=1 AND can_manage=1').get(key);
    return !!dbKey;
}
function getJudgeName(key) {
    if (isAdminKey(key)) return '관리자';
    if (key === ACCESS_KEYS.operation) return '운영(기본키)';
    const dbKey = db.prepare('SELECT judge_name FROM operation_key WHERE key_value=? AND active=1').get(key);
    return dbKey ? dbKey.judge_name : 'unknown';
}
function getKeyRole(key) {
    if (isAdminKey(key)) return 'admin';
    const dbKey = db.prepare('SELECT * FROM operation_key WHERE key_value=? AND active=1').get(key);
    if (dbKey) return dbKey.can_manage ? 'admin' : 'operation';
    if (key === ACCESS_KEYS.operation) return 'operation';
    return null;
}

// Check if competition has ended (for post-competition lock)
function isCompetitionEnded(competitionId) {
    if (!competitionId) return false;
    const comp = db.prepare('SELECT status, end_date FROM competition WHERE id=?').get(competitionId);
    if (!comp) return false;
    if (comp.status === 'completed') return true;
    const today = kstNow().slice(0, 10);
    if (comp.end_date && comp.end_date < today) return true;
    return false;
}

// Check if action should be blocked for non-admin after competition ends
function requireAdminAfterCompEnd(competitionId, adminKey, res) {
    if (isCompetitionEnded(competitionId) && !isAdminKey(adminKey)) {
        res.status(403).json({ error: '대회가 종료되었습니다. 관리자 권한으로만 수정할 수 있습니다.' });
        return true; // blocked
    }
    return false; // allowed
}

function verifyJudgeLogin(judgeName, key) {
    // Admin login: id + password (bcrypt)
    if (judgeName === ADMIN_ID() && bcrypt.compareSync(key, ACCESS_KEYS.adminHash)) {
        return { role: 'admin', judge_name: '관리자' };
    }
    // Judge login: judge_name + key_value must both match
    const dbKey = db.prepare('SELECT * FROM operation_key WHERE judge_name=? AND key_value=? AND active=1').get(judgeName, key);
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

// ---- Audit & OpLog ----
function audit(table, id, action, oldV, newV, by = 'operator', compId = null, req = null) {
    const ts = kstNow();
    const ip = req ? (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim() : null;
    const ua = req ? (req.headers['user-agent'] || '').substring(0, 256) : null;
    db.prepare(`INSERT INTO audit_log (competition_id,table_name,record_id,action,old_values,new_values,performed_by,created_at,ip_address,user_agent) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(compId, table, id, action, oldV ? JSON.stringify(oldV) : null, newV ? JSON.stringify(newV) : null, by, ts, ip, ua);
}
function opLog(message, category = 'general', performedBy = 'system', compId = null) {
    const ts = kstNow();
    db.prepare(`INSERT INTO operation_log (competition_id,message,category,performed_by,created_at) VALUES (?,?,?,?,?)`)
        .run(compId, message, category, performedBy, ts);
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
function waSeededDistribution(event, qualifiedSels, groupCount, db) {
    // Get best performance for each qualified athlete + source heat info
    const athletePerf = qualifiedSels.map(sel => {
        const origEntry = db.prepare('SELECT * FROM event_entry WHERE id=?').get(sel.event_entry_id);
        if (!origEntry) return { ...sel, athlete_id: null, team: '', perf: Infinity, sourceHeat: null };
        const athlete = db.prepare('SELECT * FROM athlete WHERE id=?').get(origEntry.athlete_id);
        // Get best result from all heats of the source event + track source heat
        let bestPerf = Infinity;
        let sourceHeat = null;
        const heats = db.prepare('SELECT id, heat_number FROM heat WHERE event_id=?').all(event.id);
        for (const h of heats) {
            const entryInHeat = db.prepare('SELECT * FROM heat_entry WHERE heat_id=? AND event_entry_id=?').get(h.id, sel.event_entry_id);
            if (!entryInHeat) continue;
            if (!sourceHeat) sourceHeat = h.heat_number; // track which heat the athlete came from
            if (event.category === 'track' || event.category === 'relay' || event.category === 'road') {
                const r = db.prepare('SELECT MIN(time_seconds) AS best FROM result WHERE heat_id=? AND event_entry_id=? AND time_seconds > 0').get(h.id, sel.event_entry_id);
                if (r && r.best && r.best < bestPerf) { bestPerf = r.best; sourceHeat = h.heat_number; }
            } else if (event.category === 'field_distance') {
                const r = db.prepare('SELECT MAX(distance_meters) AS best FROM result WHERE heat_id=? AND event_entry_id=? AND distance_meters > 0').get(h.id, sel.event_entry_id);
                if (r && r.best) { bestPerf = -r.best; sourceHeat = h.heat_number; }
            } else if (event.category === 'field_height') {
                const r = db.prepare("SELECT MAX(bar_height) AS best FROM height_attempt WHERE heat_id=? AND event_entry_id=? AND result_mark='O'").get(h.id, sel.event_entry_id);
                if (r && r.best) { bestPerf = -r.best; sourceHeat = h.heat_number; }
            }
        }
        return { ...sel, athlete_id: origEntry.athlete_id, team: athlete ? athlete.team : '', perf: bestPerf, sourceHeat };
    });

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
function generateScoreboardKey(event, heatNumber, db, totalHeats) {
    const genderLabel = { M: '남자', F: '여자', X: '혼성' }[event.gender] || '';
    const roundLabel = { preliminary: '예선', semifinal: '준결승', final: '결승' }[event.round_type] || event.round_type;
    let federationLabel = '';
    if (event.competition_id) {
        const comp = db.prepare('SELECT federation, division_type FROM competition WHERE id=?').get(event.competition_id);
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
function generateJointScoreboardKey(event, db) {
    const genderLabel = { M: '남자', F: '여자', X: '혼성' }[event.gender] || '';
    const roundLabel = { preliminary: '예선', semifinal: '준결승', final: '결승' }[event.round_type] || event.round_type;
    // Count heats for this event to decide whether to add heat numbers
    const heats = db.prepare('SELECT COUNT(*) as cnt FROM heat WHERE event_id=?').get(event.id);
    const heatCount = heats ? heats.cnt : 0;
    if (heatCount <= 1) {
        return `합동 ${genderLabel} ${event.name} ${roundLabel}`;
    }
    // Multiple heats — return base key; individual heat keys will be: "합동 남자 100m 예선 1조", etc.
    return `합동 ${genderLabel} ${event.name} ${roundLabel}`;
}

// Generate per-heat joint scoreboard keys and store them
function generateJointHeatKeys(eventIdA, eventIdB, db) {
    const evA = db.prepare('SELECT * FROM event WHERE id=?').get(eventIdA);
    if (!evA) return null;
    const baseKey = generateJointScoreboardKey(evA, db);

    // Find all heats for both events, pair them by heat_number
    const heatsA = db.prepare('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number').all(eventIdA);
    const heatsB = db.prepare('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number').all(eventIdB);
    const maxHeats = Math.max(heatsA.length, heatsB.length);

    if (maxHeats <= 1) {
        return baseKey; // Single heat, no heat number suffix
    }
    // Multiple heats — key will include heat numbers
    return baseKey;
}

// Get joint scoreboard data for a given event_id (used by lookup fallback)
function getJointScoreboardData(eventId, dbRef) {
    const links = dbRef.prepare(`
        SELECT event_id_a, event_id_b FROM event_link
        WHERE event_id_a = ? OR event_id_b = ?
    `).all(eventId, eventId);
    
    const eventIds = new Set([parseInt(eventId)]);
    links.forEach(l => { eventIds.add(l.event_id_a); eventIds.add(l.event_id_b); });
    
    const allEntries = [];
    let primaryEvt = null;
    for (const eid of eventIds) {
        const evt = dbRef.prepare('SELECT e.*, c.name as comp_name, c.federation FROM event e JOIN competition c ON c.id=e.competition_id WHERE e.id=?').get(eid);
        if (!evt) continue;
        if (eid === parseInt(eventId) || !primaryEvt) primaryEvt = evt;
        
        const heat = dbRef.prepare('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number DESC LIMIT 1').get(eid);
        if (!heat) continue;
        
        const entries = dbRef.prepare(`
            SELECT he.lane_number, he.sub_group, ee.id as event_entry_id, ee.status,
                   a.name, a.bib_number, a.team, a.gender, a.federation as athlete_federation
            FROM heat_entry he
            JOIN event_entry ee ON ee.id = he.event_entry_id
            JOIN athlete a ON a.id = ee.athlete_id
            WHERE he.heat_id = ?
            ORDER BY he.lane_number
        `).all(heat.id);
        
        const results = dbRef.prepare('SELECT * FROM result WHERE heat_id=?').all(heat.id);
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
app.post('/api/auth/verify', authLimiter, (req, res) => {
    const { key, judge_name } = req.body;
    // New: judge_name + key login
    if (judge_name && key) {
        const result = verifyJudgeLogin(judge_name, key);
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
app.post('/api/staff/verify', authLimiter, (req, res) => {
    const { key } = req.body;
    if (isOperationKey(key)) {
        const jn = getJudgeName(key);
        return res.json({ success: true, role: getKeyRole(key) || 'operation', judge_name: jn });
    }
    res.status(403).json({ error: 'Invalid key' });
});

// ============================================================
// COMPETITIONS CRUD — with auto-status update
// ============================================================
function autoUpdateCompetitionStatus() {
    const today = kstNow().slice(0, 10); // YYYY-MM-DD (KST)
    // upcoming → active if start_date <= today
    db.prepare("UPDATE competition SET status='active' WHERE status='upcoming' AND start_date <= ?").run(today);
    // active → completed if end_date < today
    db.prepare("UPDATE competition SET status='completed' WHERE status='active' AND end_date < ?").run(today);
}

app.get('/api/competitions', async (req, res) => {
    autoUpdateCompetitionStatus();
    res.json(await db.all('SELECT * FROM competition ORDER BY start_date ASC'));
});
// Competitions within 2 weeks (for home top section) — MUST be before /:id
// 노출 정책:
//  - 기본(?window=active): "현재 진행중 대회 기준 ±3일" 윈도우
//      · 진행중(active) 대회의 [start_date - 3일, end_date + 3일] 안에 걸치는 대회
//      · 진행중 대회가 없으면 fallback으로 오늘 ±3일 윈도우 사용
//  - ?window=all: 전체 대회 (펼침 모드)
app.get('/api/competitions/recent', async (req, res) => {
    const window = (req.query.window || 'active').toLowerCase();

    if (window === 'all') {
        // 전체 대회 (펼침 탭에서 사용) — status 우선, 시작일 내림차순
        const rows = await db.all(`
            SELECT * FROM competition
            ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'upcoming' THEN 1 WHEN 'completed' THEN 2 ELSE 3 END,
                     start_date DESC
        `);
        return res.json(rows);
    }

    // active 윈도우: 진행중 대회 기준 ±3일
    const today = new Date().toISOString().slice(0, 10);
    const addDays = (dateStr, n) => {
        const d = new Date(dateStr + 'T00:00:00');
        d.setDate(d.getDate() + n);
        return d.toISOString().slice(0, 10);
    };

    const activeComps = await db.all(`SELECT start_date, end_date FROM competition WHERE status='active'`);

    let winStart, winEnd;
    if (activeComps.length > 0) {
        const starts = activeComps.map(c => c.start_date).filter(Boolean).sort();
        const ends = activeComps.map(c => c.end_date).filter(Boolean).sort();
        winStart = addDays(starts[0], -3);
        winEnd = addDays(ends[ends.length - 1], 3);
    } else {
        // fallback: 오늘 ±3일
        winStart = addDays(today, -3);
        winEnd = addDays(today, 3);
    }

    const rows = await db.all(`
        SELECT * FROM competition
        WHERE status = 'active'
           OR (end_date >= ? AND start_date <= ?)
        ORDER BY CASE WHEN status='active' THEN 0 ELSE 1 END, start_date DESC
    `, winStart, winEnd);
    res.json({ window: { start: winStart, end: winEnd, mode: 'active' }, items: rows });
});
// Competitions by federation — MUST be before /:id
app.get('/api/competitions/by-federation/:code', async (req, res) => {
    const rows = await db.all('SELECT * FROM competition WHERE federation=? ORDER BY start_date DESC', req.params.code);
    res.json(rows);
});
app.get('/api/competitions/:id', async (req, res) => {
    const c = await db.get('SELECT * FROM competition WHERE id=?', req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    res.json(c);
});
app.post('/api/competitions', async (req, res) => {
    const { admin_key, name, start_date, end_date, venue, federation, mode } = req.body;
    if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    if (!name || !start_date || !end_date) return res.status(400).json({ error: '대회명, 시작일, 종료일은 필수입니다.' });
    const compMode = (mode === 'display') ? 'display' : 'operation';
    try {
        const info = await db.run('INSERT INTO competition (name,start_date,end_date,venue,federation,mode) VALUES (?,?,?,?,?,?)', name, start_date, end_date, venue || '', federation || '', compMode);
        const comp = await db.get('SELECT * FROM competition WHERE id=?', info.lastInsertRowid);
        opLog(`대회 생성: ${name} (${compMode === 'display' ? '노출용' : '운영용'})`, 'admin', 'admin', comp.id);
        res.json(comp);
    } catch (e) { res.status(400).json({ error: '대회 생성 실패: ' + e.message }); }
});
app.put('/api/competitions/:id', async (req, res) => {
    const { admin_key, name, start_date, end_date, venue, status, video_url, federation, division_type, mode } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    const old = await db.get('SELECT * FROM competition WHERE id=?', req.params.id);
    if (!old) return res.status(404).json({ error: 'Not found' });
    const compMode = mode ? ((mode === 'display') ? 'display' : 'operation') : old.mode;
    await db.run('UPDATE competition SET name=?,start_date=?,end_date=?,venue=?,status=?,video_url=?,federation=?,division_type=?,mode=? WHERE id=?', name||old.name, start_date||old.start_date, end_date||old.end_date, venue??old.venue, status||old.status, video_url??old.video_url??'', federation??old.federation??'', division_type??old.division_type??'', compMode||'operation', old.id);
    res.json(await db.get('SELECT * FROM competition WHERE id=?', old.id));
});
app.delete('/api/competitions/:id', async (req, res) => {
    const { admin_key } = req.body;
    if (!isAdminOrManager(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    const comp = await db.get('SELECT * FROM competition WHERE id=?', req.params.id);
    if (!comp) return res.status(404).json({ error: 'Not found' });

    // 삭제 전 자동 백업 (트랜잭션 시작 전 — 실제 백업은 삭제 직전 DB를 복사해야 의미가 있음)
    try {
        const backupDir = require('path').join(__dirname, 'backups');
        if (!require('fs').existsSync(backupDir)) require('fs').mkdirSync(backupDir);
        const safeName = (comp.name || 'comp').replace(/[\/\\:*?"<>|]/g, '_');
        const backupName = `deleted_${safeName}_${new Date().toISOString().replace(/[:.]/g,'-')}.db`;
        require('fs').copyFileSync(require('path').join(__dirname, 'db/competition.db'), require('path').join(backupDir, backupName));
        console.log(`[Backup] 삭제 전 백업 완료: ${backupName}`);
    } catch(e) { console.error('[Backup] 삭제 전 백업 실패:', e.message); }

    // 안전 헬퍼: 테이블/컬럼이 존재할 때만 DELETE 실행 (스키마 다변화 대비)
    const tableExists = async (name) => {
        try { return !!await db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", name); }
        catch(_){ return false; }
    };
    const hasColumn = async (table, col) => {
        try {
            const cols = await db.all(`PRAGMA table_info(${table})`);
            return cols.some(c => c.name === col);
        } catch(_){ return false; }
    };
    const safeRun = async (sql, ...args) => {
        try { return await db.run(sql, ...args); }
        catch(e){ console.warn('[delete-comp] skip:', sql.split('\n')[0].trim(), '|', e.message); return null; }
    };

    try {
        await db.transaction(async () => {
            const events = await db.all('SELECT id FROM event WHERE competition_id=?', comp.id);
            const eventIds = events.map(e => e.id);

            for (const evt of events) {
                const heats = await db.all('SELECT id FROM heat WHERE event_id=?', evt.id);
                for (const h of heats) {
                    safeRun('DELETE FROM result WHERE heat_id=?', h.id);
                    safeRun('DELETE FROM height_attempt WHERE heat_id=?', h.id);
                    safeRun('DELETE FROM heat_entry WHERE heat_id=?', h.id);
                }
                safeRun('DELETE FROM heat WHERE event_id=?', evt.id);
                safeRun('DELETE FROM relay_member WHERE event_entry_id IN (SELECT id FROM event_entry WHERE event_id=?)', evt.id);
                safeRun('DELETE FROM combined_score WHERE event_entry_id IN (SELECT id FROM event_entry WHERE event_id=?)', evt.id);
                safeRun('DELETE FROM qualification_selection WHERE event_id=?', evt.id);
                safeRun('DELETE FROM event_entry WHERE event_id=?', evt.id);
                // event_id 직접 참조 테이블들 (신규 추가 포함)
                if (tableExists('event_records')) safeRun('DELETE FROM event_records WHERE event_id=?', evt.id);
                if (tableExists('event_link'))    safeRun('DELETE FROM event_link WHERE event_id_a=? OR event_id_b=?', evt.id, evt.id);
                if (tableExists('joint_group_member') && hasColumn('joint_group_member','event_id'))
                    safeRun('DELETE FROM joint_group_member WHERE event_id=?', evt.id);
            }

            // pacing 트리: pacing_config(competition_id) → pacing_color(pacing_config_id) → pacing_segment(pacing_color_id)
            if (tableExists('pacing_config')) {
                const cfgs = await db.all('SELECT id FROM pacing_config WHERE competition_id=?', comp.id);
                for (const cfg of cfgs) {
                    if (tableExists('pacing_color')) {
                        const colors = await db.all('SELECT id FROM pacing_color WHERE pacing_config_id=?', cfg.id);
                        for (const c of colors) {
                            if (tableExists('pacing_segment')) safeRun('DELETE FROM pacing_segment WHERE pacing_color_id=?', c.id);
                        }
                        safeRun('DELETE FROM pacing_color WHERE pacing_config_id=?', cfg.id);
                    }
                }
                safeRun('DELETE FROM pacing_config WHERE competition_id=?', comp.id);
            }

            // competition_id 직접 참조 테이블 일괄 정리
            const compIdTables = [
                'event', 'athlete', 'audit_log', 'operation_log',
                'display_roster', 'timetable', 'doc_template',
                'external_api_log', 'joint_group_member'
            ];
            for (const t of compIdTables) {
                if (tableExists(t) && hasColumn(t, 'competition_id')) {
                    safeRun(`DELETE FROM ${t} WHERE competition_id=?`, comp.id);
                }
            }

            // 마지막에 대회 본체 삭제
            safeRun('DELETE FROM competition WHERE id=?', comp.id);
        })();

        return res.json({ success: true });
    } catch(e) {
        console.error('[delete-comp] 트랜잭션 실패:', e.message, e.stack);
        return res.status(500).json({ error: '대회 삭제 중 오류: ' + e.message });
    }
});

// Competition info (public — for viewer)
app.get('/api/competition-info', async (req, res) => {
    const compId = req.query.competition_id;
    if (compId) {
        const c = await db.get('SELECT * FROM competition WHERE id=?', compId);
        if (c) return res.json({ name: c.name, dates: `${c.start_date} ~ ${c.end_date}`, venue: c.venue, video_url: c.video_url || '', federation: c.federation || '' });
    }
    const c = await db.get('SELECT * FROM competition ORDER BY start_date DESC LIMIT 1');
    if (c) return res.json({ name: c.name, dates: `${c.start_date} ~ ${c.end_date}`, venue: c.venue, video_url: c.video_url || '', federation: c.federation || '' });
    res.json({ name: '', dates: '', venue: '', video_url: '', federation: '' });
});

// ============================================================
// FEDERATION LIST — CRUD
// ============================================================
// Federation list — CRUD
app.get('/api/federations', async (req, res) => {
    const rows = await db.all('SELECT * FROM federation_list ORDER BY sort_order, code');
    res.json(rows);
});
app.post('/api/federations', async (req, res) => {
    const { admin_key, code, name, badge_bg, badge_color, gender_label_m, gender_label_f, gender_label_x } = req.body;
    if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    if (!code || !code.trim()) return res.status(400).json({ error: '연맹 코드는 필수입니다.' });
    try {
        const maxOrder = await db.get('SELECT MAX(sort_order) as m FROM federation_list').m || 0;
        const info = await db.run('INSERT INTO federation_list (code, name, badge_bg, badge_color, sort_order, gender_label_m, gender_label_f, gender_label_x) VALUES (?,?,?,?,?,?,?,?)', code.trim().toUpperCase(), name || '', badge_bg || '#e3f2fd', badge_color || '#1565c0', maxOrder + 1, gender_label_m || '', gender_label_f || '', gender_label_x || '');
        opLog(`연맹 추가: ${code}`, 'admin', 'admin');
        res.json({ id: info.lastInsertRowid, success: true });
    } catch (e) {
        if (e.message.includes('UNIQUE')) return res.status(400).json({ error: '이미 존재하는 연맹 코드입니다.' });
        res.status(500).json({ error: e.message });
    }
});
app.put('/api/federations/:id', async (req, res) => {
    const { admin_key, code, name, badge_bg, badge_color, sort_order, gender_label_m, gender_label_f, gender_label_x } = req.body;
    if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    const old = await db.get('SELECT * FROM federation_list WHERE id=?', req.params.id);
    if (!old) return res.status(404).json({ error: 'Not found' });
    try {
        await db.run('UPDATE federation_list SET code=?, name=?, badge_bg=?, badge_color=?, sort_order=?, gender_label_m=?, gender_label_f=?, gender_label_x=? WHERE id=?', code || old.code, name ?? old.name, badge_bg || old.badge_bg, badge_color || old.badge_color, sort_order ?? old.sort_order, gender_label_m ?? old.gender_label_m ?? '', gender_label_f ?? old.gender_label_f ?? '', gender_label_x ?? old.gender_label_x ?? '', old.id);
        opLog(`연맹 수정: ${code || old.code}`, 'admin', 'admin');
        res.json({ success: true });
    } catch (e) {
        if (e.message.includes('UNIQUE')) return res.status(400).json({ error: '이미 존재하는 연맹 코드입니다.' });
        res.status(500).json({ error: e.message });
    }
});
app.delete('/api/federations/:id', async (req, res) => {
    const { admin_key } = req.body;
    if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    const old = await db.get('SELECT * FROM federation_list WHERE id=?', req.params.id);
    if (!old) return res.status(404).json({ error: 'Not found' });
    await db.run('DELETE FROM federation_list WHERE id=?', old.id);
    opLog(`연맹 삭제: ${old.code}`, 'admin', 'admin');
    res.json({ success: true });
});
app.put('/api/federations/reorder', async (req, res) => {
    const { admin_key, order } = req.body;
    if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    if (!Array.isArray(order)) return res.status(400).json({ error: 'order array required' });
    await db.transaction(async () => {
        for (let i = 0; i < order.length; i++) {
            await db.run('UPDATE federation_list SET sort_order=? WHERE id=?', i + 1, order[i]);
        }
    })();
    res.json({ success: true });
});

// ============================================================
// HOME POPUP — CMS
// ============================================================
app.get('/api/home-popups', async (req, res) => {
    const popups = await db.all('SELECT * FROM home_popup ORDER BY sort_order, id');
    const sections = await db.all('SELECT * FROM home_popup_section ORDER BY popup_id, sort_order');
    popups.forEach(p => { p.sections = sections.filter(s => s.popup_id === p.id); });
    res.json(popups);
});
app.post('/api/home-popups', async (req, res) => {
    const { admin_key, popup_type, title, subtitle, intro_text, bottom_btn_text, bottom_btn_desc, bottom_btn_link, bottom_btn_active, is_active, show_from, show_until, sort_order, sections } = req.body;
    if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    try {
        const maxOrder = await db.get('SELECT MAX(sort_order) as m FROM home_popup').m || 0;
        const info = await db.run(`INSERT INTO home_popup (popup_type, title, subtitle, intro_text, bottom_btn_text, bottom_btn_desc, bottom_btn_link, bottom_btn_active, is_active, show_from, show_until, sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, popup_type || 'public', title || '', subtitle || '', intro_text || '', bottom_btn_text || '', bottom_btn_desc || '', bottom_btn_link || '', bottom_btn_active ?? 1, is_active ?? 1, show_from || null, show_until || null, sort_order ?? maxOrder + 1);
        const popupId = info.lastInsertRowid;
        if (Array.isArray(sections)) {
            const stmt = db.prepare('INSERT INTO home_popup_section (popup_id, title, content, link_btn_text, link_btn_url, sort_order, is_active) VALUES (?,?,?,?,?,?,?)');
            sections.forEach((s, i) => stmt.run(popupId, s.title || '', s.content || '', s.link_btn_text || '', s.link_btn_url || '', s.sort_order ?? i, s.is_active ?? 1));
        }
        opLog('홈 팝업 생성', 'admin', 'admin');
        res.json({ id: popupId, success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/home-popups/reorder', async (req, res) => {
    const { admin_key, order } = req.body;
    if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    if (!Array.isArray(order)) return res.status(400).json({ error: 'order array required' });
    await db.transaction(async () => {
        for (let i = 0; i < order.length; i++) {
            await db.run('UPDATE home_popup SET sort_order=? WHERE id=?', i + 1, order[i]);
        }
    })();
    res.json({ success: true });
});
app.put('/api/home-popups/:id', async (req, res) => {
    const { admin_key, popup_type, title, subtitle, intro_text, bottom_btn_text, bottom_btn_desc, bottom_btn_link, bottom_btn_active, is_active, show_from, show_until, sort_order, sections } = req.body;
    if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    const old = await db.get('SELECT * FROM home_popup WHERE id=?', req.params.id);
    if (!old) return res.status(404).json({ error: 'Not found' });
    try {
        await db.run(`UPDATE home_popup SET popup_type=?, title=?, subtitle=?, intro_text=?, bottom_btn_text=?, bottom_btn_desc=?, bottom_btn_link=?, bottom_btn_active=?, is_active=?, show_from=?, show_until=?, sort_order=?, updated_at=datetime('now') WHERE id=?`, popup_type || old.popup_type, title ?? old.title, subtitle ?? old.subtitle, intro_text ?? old.intro_text, bottom_btn_text ?? old.bottom_btn_text, bottom_btn_desc ?? old.bottom_btn_desc, bottom_btn_link ?? old.bottom_btn_link, bottom_btn_active ?? old.bottom_btn_active, is_active ?? old.is_active, show_from || old.show_from, show_until || old.show_until, sort_order ?? old.sort_order ?? 0, old.id);
        // Replace sections if provided
        if (Array.isArray(sections)) {
            await db.run('DELETE FROM home_popup_section WHERE popup_id=?', old.id);
            const stmt = db.prepare('INSERT INTO home_popup_section (popup_id, title, content, link_btn_text, link_btn_url, sort_order, is_active) VALUES (?,?,?,?,?,?,?)');
            sections.forEach((s, i) => stmt.run(old.id, s.title || '', s.content || '', s.link_btn_text || '', s.link_btn_url || '', s.sort_order ?? i, s.is_active ?? 1));
        }
        opLog('홈 팝업 수정', 'admin', 'admin');
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/home-popups/:id', async (req, res) => {
    const { admin_key } = req.body;
    if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    const old = await db.get('SELECT * FROM home_popup WHERE id=?', req.params.id);
    if (!old) return res.status(404).json({ error: 'Not found' });
    await db.transaction(async () => {
        await db.run('DELETE FROM home_popup_section WHERE popup_id=?', old.id);
        await db.run('DELETE FROM home_popup WHERE id=?', old.id);
    })();
    opLog('홈 팝업 삭제', 'admin', 'admin');
    res.json({ success: true });
});



// ============================================================
// EVENTS — scoped to competition
// ============================================================
// Heat allocations view — shows all heats/lanes for an event (used in manual edit UI)
app.get('/api/events/:id/heat-allocations', async (req, res) => {
    const event = await db.get('SELECT * FROM event WHERE id=?', req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    const heats = await db.all('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number', event.id);
    const result = heats.map(async h => {
        const entries = await db.all(`SELECT he.lane_number, he.sub_group, he.id AS heat_entry_id, ee.id AS event_entry_id, ee.status,
               a.id AS athlete_id, a.name, a.bib_number, a.team, a.gender
        FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id
        JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=? ORDER BY he.lane_number ASC, CAST(a.bib_number AS INTEGER)`, h.id);
        return { ...h, entries };
    });
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
    const hcStmt = db.prepare('SELECT COUNT(*) AS cnt FROM heat WHERE event_id=?');
    events.forEach(e => { e.heat_count = hcStmt.get(e.id).cnt; });
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
        WHERE ee.event_id=? ORDER BY CAST(a.bib_number AS INTEGER)
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
    query += ` ORDER BY he.lane_number ASC, CAST(a.bib_number AS INTEGER)`;
    res.json(await db.all(query, ...params));
});

// ============================================================
// RESULTS
// ============================================================
app.get('/api/results', async (req, res) => {
    if (!req.query.heat_id) return res.status(400).json({ error: 'heat_id required' });
    res.json(await db.all(`
        SELECT r.*, a.name, a.bib_number, a.team
        FROM result r JOIN event_entry ee ON ee.id=r.event_entry_id
        JOIN athlete a ON a.id=ee.athlete_id
        WHERE r.heat_id=? ORDER BY r.event_entry_id, r.attempt_number
    `, req.query.heat_id));
});
app.post('/api/results/upsert', async (req, res) => {
    const { heat_id, event_entry_id, attempt_number, distance_meters, time_seconds, remark, status_code, wind, admin_key } = req.body;
    if (!heat_id || !event_entry_id) return res.status(400).json({ error: 'heat_id and event_entry_id required' });
    const he = await db.get('SELECT * FROM heat_entry WHERE heat_id=? AND event_entry_id=?', heat_id, event_entry_id);
    if (!he) return res.status(404).json({ error: 'Entry not in heat' });
    const heat = await db.get('SELECT * FROM heat WHERE id=?', heat_id);
    if (heat) {
        const event = await db.get('SELECT * FROM event WHERE id=?', heat.event_id);
        // Post-competition lock: only admin can modify after competition ends
        if (event && requireAdminAfterCompEnd(event.competition_id, admin_key, res)) return;
        // Completed events require admin_key to modify
        if (event && event.round_status === 'completed') {
            if (!isAdminKey(admin_key) && !isOperationKey(admin_key)) return res.status(403).json({ error: '완료된 경기의 기록 수정은 관리자 키가 필요합니다.' });
        }
        if (event && event.round_status !== 'in_progress' && event.round_status !== 'completed') {
            let allowed = false;
            // Allow combined sub-events: auto-promote both parent and sub-event
            if (event.parent_event_id) {
                const parent = await db.get('SELECT * FROM event WHERE id=?', event.parent_event_id);
                if (parent && parent.category === 'combined') {
                    allowed = true;
                    // Auto-promote parent if needed
                    if (parent.round_status !== 'in_progress' && parent.round_status !== 'completed') {
                        await db.run("UPDATE event SET round_status='in_progress' WHERE id=?", parent.id);
                        broadcastSSE('event_status_changed', { event_id: parent.id, round_status: 'in_progress' });
                    }
                    // Auto-promote sub-event
                    await db.run("UPDATE event SET round_status='in_progress' WHERE id=?", event.id);
                    broadcastSSE('event_status_changed', { event_id: event.id, round_status: 'in_progress' });
                }
            }
            // Auto-promote from 'created' or 'heats_generated' to 'in_progress' when heats exist
            if (!allowed && (event.round_status === 'created' || event.round_status === 'heats_generated')) {
                const heatCount = await db.get('SELECT COUNT(*) as cnt FROM heat WHERE event_id=?', event.id).cnt;
                if (heatCount > 0) {
                    allowed = true;
                    await db.run("UPDATE event SET round_status='in_progress' WHERE id=?", event.id);
                    broadcastSSE('event_status_changed', { event_id: event.id, round_status: 'in_progress' });
                    const gL = event.gender === 'M' ? '남자' : event.gender === 'F' ? '여자' : '혼성';
                    const roundL = { preliminary: '예선', semifinal: '준결승', final: '결승' }[event.round_type] || event.round_type;
                    opLog(`${event.name} ${roundL} ${gL} 기록 입력 시작 (자동 진행중 전환)`, 'record', 'system', event.competition_id);
                }
            }
            if (!allowed) return res.status(400).json({ error: '소집이 완료되지 않았습니다.' });
        }
    }
    // Validate status_code (DQ, DNS, DNF, NM are valid)
    const validStatusCodes = ['', 'DQ', 'DNS', 'DNF', 'NM'];
    const sc = status_code && validStatusCodes.includes(status_code.toUpperCase()) ? status_code.toUpperCase() : '';
    
    if (!sc && time_seconds !== undefined && time_seconds !== null) {
        if (typeof time_seconds !== 'number' || time_seconds <= 0) return res.status(400).json({ error: '유효하지 않은 기록입니다.' });
    }
    if (!sc && distance_meters !== undefined && distance_meters !== null) {
        // Allow 0 (foul) and -1 (pass) as special values
        if (typeof distance_meters !== 'number' || (distance_meters < 0 && distance_meters !== -1)) return res.status(400).json({ error: '유효하지 않은 거리입니다.' });
    }
    // Auto-update round_status to in_progress when first result is saved
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
        let existing = await db.get('SELECT * FROM result WHERE heat_id=? AND event_entry_id=? AND attempt_number IS ?', heat_id, event_entry_id, attempt_number || null);
        // Fallback: for track/relay/road (no attempt_number), find any existing result for this entry
        if (!existing && !attempt_number) {
            existing = await db.get('SELECT * FROM result WHERE heat_id=? AND event_entry_id=? ORDER BY id DESC LIMIT 1', heat_id, event_entry_id);
        }
        if (existing) {
            // Preserve existing values for fields not included in the request (undefined → keep existing)
            const updDist = distance_meters !== undefined ? (distance_meters ?? null) : existing.distance_meters;
            const updTime = time_seconds !== undefined ? (time_seconds ?? null) : existing.time_seconds;
            const updRemark = remark !== undefined ? (remark ?? '') : (existing.remark ?? '');
            // IMPORTANT: status_code '' (empty) means CLEAR — use explicit check, not ||
            const updSc = status_code !== undefined ? (sc) : (existing.status_code || '');
            const updWind = wind !== undefined ? (wind ?? null) : existing.wind;
            
            // If everything is being cleared (no time, no distance, no status, no remark), DELETE the result instead
            if (updDist == null && updTime == null && !updSc && !updRemark && status_code !== undefined) {
                await db.run('DELETE FROM result WHERE id=?', existing.id);
                // Also clear combined_score for this entry if parent is combined
                if (heat) {
                    const _delEvt = await db.get('SELECT * FROM event WHERE id=?', heat.event_id);
                    if (_delEvt && _delEvt.parent_event_id) {
                        const _subOrd = await db.get('SELECT COUNT(*) as cnt FROM event WHERE parent_event_id=? AND id<=?', _delEvt.parent_event_id, _delEvt.id)?.cnt || 0;
                        await db.run('DELETE FROM combined_score WHERE event_entry_id IN (SELECT id FROM event_entry WHERE event_id=? AND athlete_id=(SELECT athlete_id FROM event_entry WHERE id=?)) AND sub_event_order=?', _delEvt.parent_event_id, event_entry_id, _subOrd);
                        broadcastSSE('combined_update', { event_id: _delEvt.parent_event_id });
                    }
                }
                audit('result', existing.id, 'DELETE', existing, null, 'operator', null, req);
                broadcastSSE('result_update', { heat_id, event_entry_id });
                return res.json({ success: true, deleted: true, deleted_id: existing.id });
            }
            
            await db.run("UPDATE result SET distance_meters=?,time_seconds=?,remark=?,status_code=?,wind=?,updated_at=datetime('now') WHERE id=?", updDist, updTime, updRemark, updSc, updWind, existing.id);
            const upd = await db.get('SELECT * FROM result WHERE id=?', existing.id);
            audit('result', existing.id, 'UPDATE', existing, upd, 'operator', null, req);
            broadcastSSE('result_update', { heat_id, event_entry_id });
            res.json(upd);
        } else {
            const info = await db.run('INSERT INTO result (heat_id,event_entry_id,attempt_number,distance_meters,time_seconds,remark,status_code,wind) VALUES (?,?,?,?,?,?,?,?)', heat_id, event_entry_id, attempt_number || null, distance_meters ?? null, time_seconds ?? null, remark || '', sc || '', wind ?? null);
            const ins = await db.get('SELECT * FROM result WHERE id=?', info.lastInsertRowid);
            audit('result', ins.id, 'INSERT', null, ins, 'operator', null, req);
            broadcastSSE('result_update', { heat_id, event_entry_id });
            res.json(ins);
        }
    } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// Delete a single result by heat_id + event_entry_id + attempt_number (for clearing field entries)
app.delete('/api/results', async (req, res) => {
    const { heat_id, event_entry_id, attempt_number, admin_key } = req.body;
    if (!heat_id || !event_entry_id) return res.status(400).json({ error: 'heat_id and event_entry_id required' });
    // Check if event is completed — require admin_key
    const _dHeat = await db.get('SELECT * FROM heat WHERE id=?', heat_id);
    if (_dHeat) {
        const _dEvt = await db.get('SELECT * FROM event WHERE id=?', _dHeat.event_id);
        // Post-competition lock
        if (_dEvt && requireAdminAfterCompEnd(_dEvt.competition_id, admin_key, res)) return;
        if (_dEvt && _dEvt.round_status === 'completed' && !isAdminKey(admin_key) && !isOperationKey(admin_key))
            return res.status(403).json({ error: '완료된 경기의 기록 삭제는 관리자 키가 필요합니다.' });
    }
    let row;
    if (attempt_number) {
        row = await db.get('SELECT * FROM result WHERE heat_id=? AND event_entry_id=? AND attempt_number=?', heat_id, event_entry_id, attempt_number);
    } else {
        row = await db.get('SELECT * FROM result WHERE heat_id=? AND event_entry_id=? AND attempt_number IS NULL ORDER BY id DESC LIMIT 1', heat_id, event_entry_id);
    }
    if (!row) return res.status(404).json({ error: 'Result not found' });
    await db.run('DELETE FROM result WHERE id=?', row.id);
    // Also clear combined_score for this entry if parent is combined
    const heat = await db.get('SELECT * FROM heat WHERE id=?', heat_id);
    if (heat) {
        const evt = await db.get('SELECT * FROM event WHERE id=?', heat.event_id);
        if (evt && evt.parent_event_id) {
            const subOrder = await db.get('SELECT COUNT(*) as cnt FROM event WHERE parent_event_id=? AND id<=?', evt.parent_event_id, evt.id)?.cnt || 0;
            await db.run('DELETE FROM combined_score WHERE event_entry_id IN (SELECT id FROM event_entry WHERE event_id=? AND athlete_id=(SELECT athlete_id FROM event_entry WHERE id=?)) AND sub_event_order=?', evt.parent_event_id, event_entry_id, subOrder);
        }
    }
    audit('result', row.id, 'DELETE', row, null, 'operator', null, req);
    broadcastSSE('result_update', { heat_id, event_entry_id });
    if (heat) {
        const evt = await db.get('SELECT * FROM event WHERE id=?', heat.event_id);
        if (evt && evt.parent_event_id) broadcastSSE('combined_update', { event_id: evt.parent_event_id });
    }
    res.json({ success: true, deleted_id: row.id });
});

// Reset all results for a sub-event (combined 서브이벤트 기록 전체 초기화)
app.post('/api/results/reset-sub-event', async (req, res) => {
    const { event_id } = req.body;
    if (!event_id) return res.status(400).json({ error: 'event_id required' });
    const evt = await db.get('SELECT * FROM event WHERE id=?', event_id);
    if (!evt) return res.status(404).json({ error: 'Event not found' });
    
    const heats = await db.all('SELECT id FROM heat WHERE event_id=?', event_id);
    let deletedResults = 0, deletedAttempts = 0;
    
    for (const h of heats) {
        const rc = await db.run('DELETE FROM result WHERE heat_id=?', h.id);
        deletedResults += rc.changes;
        const ac = await db.run('DELETE FROM height_attempt WHERE heat_id=?', h.id);
        deletedAttempts += ac.changes;
    }
    
    // Clear combined_score for this sub-event
    if (evt.parent_event_id) {
        const subOrder = await db.get('SELECT COUNT(*) as cnt FROM event WHERE parent_event_id=? AND id<=?', evt.parent_event_id, evt.id)?.cnt || 0;
        if (subOrder > 0) {
            await db.run('DELETE FROM combined_score WHERE event_entry_id IN (SELECT id FROM event_entry WHERE event_id=?) AND sub_event_order=?', evt.parent_event_id, subOrder);
        }
    }
    
    // Reset round_status back to heats_generated
    if (evt.round_status === 'in_progress' || evt.round_status === 'completed') {
        await db.run("UPDATE event SET round_status='heats_generated' WHERE id=?", event_id);
        broadcastSSE('event_status_changed', { event_id, round_status: 'heats_generated' });
    }
    
    broadcastSSE('result_update', { event_id });
    broadcastSSE('combined_update', { event_id });
    const gL = evt.gender === 'M' ? '남자' : evt.gender === 'F' ? '여자' : '혼성';
    opLog(`${evt.name} ${gL} 기록 전체 초기화 (결과 ${deletedResults}건, 시기 ${deletedAttempts}건 삭제)`, 'record', 'system', evt.competition_id);
    res.json({ success: true, deletedResults, deletedAttempts });
});

// ============================================================
// HEAT WIND (track events: per-heat wind)
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
    const result = heats.map(async h => {
        const entries = await db.all(`SELECT he.lane_number, he.sub_group, ee.id AS event_entry_id, ee.status,
               a.name, a.bib_number, a.team FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id
               JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=? ORDER BY he.lane_number ASC, CAST(a.bib_number AS INTEGER)`, h.id);
        if (event.category === 'field_height') {
            return { ...h, entries, height_attempts: await db.all('SELECT * FROM height_attempt WHERE heat_id=? ORDER BY bar_height, event_entry_id, attempt_number', h.id) };
        }
        return { ...h, entries, results: await db.all('SELECT * FROM result WHERE heat_id=? ORDER BY event_entry_id, attempt_number', h.id) };
    });
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
    const { heat_id, event_entry_id, bar_height, attempt_number, result_mark, admin_key } = req.body;
    if (!heat_id || !event_entry_id || !bar_height || !attempt_number)
        return res.status(400).json({ error: 'heat_id, event_entry_id, bar_height, attempt_number required' });

    // Check if event is completed — require admin_key
    const _hHeat = await db.get('SELECT * FROM heat WHERE id=?', heat_id);
    if (_hHeat) {
        const _hEvt = await db.get('SELECT * FROM event WHERE id=?', _hHeat.event_id);
        // Post-competition lock
        if (_hEvt && requireAdminAfterCompEnd(_hEvt.competition_id, admin_key, res)) return;
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
            await db.run('UPDATE height_attempt SET result_mark=? WHERE id=?', normalizedMark, existing.id);
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
// COMBINED SCORES
// ============================================================
app.get('/api/combined-scores', async (req, res) => {
    if (!req.query.event_id) return res.status(400).json({ error: 'event_id required' });
    res.json(await db.all(`
        SELECT cs.*, a.name, a.bib_number, a.team
        FROM combined_score cs JOIN event_entry ee ON ee.id=cs.event_entry_id
        JOIN athlete a ON a.id=ee.athlete_id
        WHERE ee.event_id=? ORDER BY cs.event_entry_id, cs.sub_event_order
    `, req.query.event_id));
});
app.post('/api/combined-scores/save', async (req, res) => {
    const { event_entry_id, sub_event_name, sub_event_order, raw_record, wa_points, admin_key } = req.body;
    if (!event_entry_id || !sub_event_name || !sub_event_order) return res.status(400).json({ error: 'Required fields missing' });
    // Post-competition lock
    try {
        const ee = await db.get('SELECT e.competition_id FROM event_entry ee JOIN event e ON e.id=ee.event_id WHERE ee.id=?', event_entry_id);
        if (ee && requireAdminAfterCompEnd(ee.competition_id, admin_key, res)) return;
    } catch(e) {}
    try {
        const existing = await db.get('SELECT * FROM combined_score WHERE event_entry_id=? AND sub_event_order=?', event_entry_id, sub_event_order);
        if (existing) {
            await db.run('UPDATE combined_score SET raw_record=?,wa_points=?,sub_event_name=? WHERE id=?', raw_record ?? null, wa_points || 0, sub_event_name, existing.id);
            res.json(await db.get('SELECT * FROM combined_score WHERE id=?', existing.id));
        } else {
            const info = await db.run('INSERT INTO combined_score (event_entry_id,sub_event_name,sub_event_order,raw_record,wa_points) VALUES (?,?,?,?,?)', event_entry_id, sub_event_name, sub_event_order, raw_record ?? null, wa_points || 0);
            res.json(await db.get('SELECT * FROM combined_score WHERE id=?', info.lastInsertRowid));
        }
        broadcastSSE('combined_update', { event_entry_id, sub_event_order });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});
app.get('/api/combined-sub-events', async (req, res) => {
    if (!req.query.parent_event_id) return res.status(400).json({ error: 'parent_event_id required' });
    res.json(await db.all('SELECT * FROM event WHERE parent_event_id=? ORDER BY id', req.query.parent_event_id));
});
app.post('/api/combined-scores/sync', async (req, res) => {
    const { parent_event_id } = req.body;
    if (!parent_event_id) return res.status(400).json({ error: 'parent_event_id required' });
    const parentEvent = await db.get('SELECT * FROM event WHERE id=?', parent_event_id);
    if (!parentEvent || parentEvent.category !== 'combined') return res.status(400).json({ error: 'Not a combined event' });
    const subEvents = await db.all('SELECT * FROM event WHERE parent_event_id=? ORDER BY id', parent_event_id);
    const parentEntries = await db.all('SELECT ee.id AS event_entry_id, ee.athlete_id FROM event_entry ee WHERE ee.event_id=?', parent_event_id);
    let syncCount = 0;
    const UPSERT_SQL = `INSERT INTO combined_score (event_entry_id,sub_event_name,sub_event_order,raw_record,wa_points)
        VALUES (?,?,?,?,?) ON CONFLICT(event_entry_id,sub_event_order) DO UPDATE SET raw_record=excluded.raw_record, wa_points=excluded.wa_points, sub_event_name=excluded.sub_event_name`;
    await db.transaction(async () => {
        for (let idx = 0; idx < subEvents.length; idx++) {
            const subEvt = subEvents[idx];
            const subOrder = idx + 1;
            const subHeat = await db.get('SELECT id FROM heat WHERE event_id=? LIMIT 1', subEvt.id);
            if (!subHeat) continue;
            for (const pe of parentEntries) {
                const subEntry = await db.get('SELECT id FROM event_entry WHERE event_id=? AND athlete_id=?', subEvt.id, pe.athlete_id);
                if (!subEntry) continue;
                let bestRecord = null;
                let hasAttempts = false;
                if (subEvt.category === 'track') {
                    const r = await db.get('SELECT MIN(time_seconds) AS best FROM result WHERE heat_id=? AND event_entry_id=? AND time_seconds > 0', subHeat.id, subEntry.id);
                    if (r && r.best) bestRecord = r.best;
                    // Check if athlete has any result rows (including DNS/DNF/NM)
                    const cnt = await db.get('SELECT COUNT(*) AS c FROM result WHERE heat_id=? AND event_entry_id=?', subHeat.id, subEntry.id);
                    if (cnt && cnt.c > 0) hasAttempts = true;
                } else if (subEvt.category === 'field_distance') {
                    const r = await db.get('SELECT MAX(distance_meters) AS best FROM result WHERE heat_id=? AND event_entry_id=? AND distance_meters > 0', subHeat.id, subEntry.id);
                    if (r && r.best) bestRecord = r.best;
                    // NM check: has attempts but all fouls (distance=0)
                    const cnt = await db.get('SELECT COUNT(*) AS c FROM result WHERE heat_id=? AND event_entry_id=? AND attempt_number IS NOT NULL', subHeat.id, subEntry.id);
                    if (cnt && cnt.c > 0) hasAttempts = true;
                } else if (subEvt.category === 'field_height') {
                    const r = await db.get("SELECT MAX(bar_height) AS best FROM height_attempt WHERE heat_id=? AND event_entry_id=? AND result_mark='O'", subHeat.id, subEntry.id);
                    if (r && r.best) bestRecord = r.best;
                    // NM check: has height attempts but no clearance (all X or PASS)
                    const cnt = await db.get('SELECT COUNT(*) AS c FROM height_attempt WHERE heat_id=? AND event_entry_id=?', subHeat.id, subEntry.id);
                    if (cnt && cnt.c > 0) hasAttempts = true;
                }
                if (bestRecord != null) {
                    const waKeys = parentEvent.gender === 'M' ? DECATHLON_KEYS : HEPTATHLON_KEYS;
                    const waKey = waKeys[subOrder - 1];
                    const waPoints = waKey ? calcWAPoints(waKey, bestRecord) : 0;
                    await db.run(UPSERT_SQL, pe.event_entry_id, subEvt.name, subOrder, bestRecord, waPoints);
                    syncCount++;
                } else if (hasAttempts) {
                    // NM (No Mark): athlete attempted but has no valid record → 0 points
                    await db.run(UPSERT_SQL, pe.event_entry_id, subEvt.name, subOrder, 0, 0);
                    syncCount++;
                } else {
                    // No record and no attempts → DELETE any existing combined_score for this sub-event
                    const delResult = await db.run('DELETE FROM combined_score WHERE event_entry_id=? AND sub_event_order=?', pe.event_entry_id, subOrder);
                    if (delResult.changes > 0) syncCount++;
                }
            }
        }
    })();
    res.json({ success: true, synced: syncCount });
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
    if (_evt && requireAdminAfterCompEnd(_evt.competition_id, admin_key, res)) return;
    await db.run('UPDATE event_entry SET status=? WHERE id=?', status, req.params.id);
    syncCombinedSubEventCheckin(entry.event_id, entry.athlete_id, status);
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
        return continueCheckin(res, athlete, event_id, competition_id);
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
    if (competition_id) athlete = findAthlete(competition_id);
    if (!athlete) athlete = findAthlete(null);
    if (!athlete) return res.status(404).json({ error: '선수를 찾을 수 없습니다', barcode });
    return continueCheckin(res, athlete, event_id, competition_id);
});

// Shared checkin logic: find entry → update status → respond
function continueCheckin(res, athlete, event_id, competition_id) {
    let entry;
    if (event_id) {
        entry = db.prepare('SELECT * FROM event_entry WHERE event_id=? AND athlete_id=?').get(event_id, athlete.id);
        if (!entry) {
            const cid = competition_id || (db.prepare('SELECT competition_id FROM event WHERE id=?').get(event_id))?.competition_id;
            if (cid) {
                const allEntries = db.prepare(`
                    SELECT ee.*, e.name as event_name FROM event_entry ee 
                    JOIN event e ON ee.event_id=e.id 
                    WHERE ee.athlete_id=? AND e.competition_id=?
                    ORDER BY CASE ee.status WHEN 'registered' THEN 0 WHEN 'checked_in' THEN 1 ELSE 2 END
                `).all(athlete.id, cid);
                if (allEntries.length > 0) {
                    entry = allEntries.find(e => e.status === 'registered') || allEntries[0];
                }
            }
        }
    } else {
        entry = db.prepare("SELECT * FROM event_entry WHERE athlete_id=? AND status='registered' LIMIT 1").get(athlete.id);
    }
    if (!entry) return res.status(404).json({ error: '해당 종목에 등록되지 않은 선수입니다', athlete: { name: athlete.name, bib: athlete.bib_number } });
    
    const wasAlready = entry.status === 'checked_in';
    if (!wasAlready) {
        db.prepare("UPDATE event_entry SET status='checked_in' WHERE id=?").run(entry.id);
        syncCombinedSubEventCheckin(entry.event_id, athlete.id, 'checked_in');
        const _he2 = db.prepare('SELECT heat_id FROM heat_entry WHERE event_entry_id=?').get(entry.id);
        broadcastSSE('entry_status', { event_entry_id: entry.id, status: 'checked_in', event_id: entry.event_id, heat_id: _he2 ? _he2.heat_id : null });
    }
    
    const heatEntry = db.prepare(`SELECT he.heat_id, h.heat_number FROM heat_entry he JOIN heat h ON he.heat_id=h.id WHERE he.event_entry_id=?`).get(entry.id);
    
    res.json({ 
        success: true, already: wasAlready, athlete, 
        entry: { ...entry, status: 'checked_in' },
        heat_id: heatEntry ? heatEntry.heat_id : null,
        heat_number: heatEntry ? heatEntry.heat_number : null,
        event_id: entry.event_id
    });
}

// Helper: sync combined sub-event entries when parent is checked in
function syncCombinedSubEventCheckin(parentEventId, athleteId, status) {
    const parentEvt = db.prepare('SELECT * FROM event WHERE id=?').get(parentEventId);
    if (!parentEvt || parentEvt.category !== 'combined') return;
    const subEvents = db.prepare('SELECT id FROM event WHERE parent_event_id=?').all(parentEventId);
    for (const sub of subEvents) {
        const subEntry = db.prepare('SELECT * FROM event_entry WHERE event_id=? AND athlete_id=?').get(sub.id, athleteId);
        if (subEntry && subEntry.status !== status) {
            db.prepare('UPDATE event_entry SET status=? WHERE id=?').run(status, subEntry.id);
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
                ON CONFLICT(event_id,event_entry_id) DO UPDATE SET selected=excluded.selected, qualification_type=excluded.qualification_type, updated_at=datetime('now')`,
                event_id, s.event_entry_id, s.selected ? 1 : 0, s.qualification_type || '');
        }
    })();
    res.json({ success: true });
});
app.post('/api/qualifications/approve', async (req, res) => {
    const { event_id } = req.body;
    if (!event_id) return res.status(400).json({ error: 'event_id required' });
    await db.run("UPDATE qualification_selection SET approved=1,approved_by='admin',updated_at=datetime('now') WHERE event_id=? AND selected=1", event_id);
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
    const insertDNS = db.prepare(`INSERT OR IGNORE INTO result (heat_id, event_entry_id, attempt_number, status_code) VALUES (?, ?, NULL, 'DNS')`);
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
                insertDNS.run(h.id, ns.event_entry_id);
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
    const qualSels = qualified.map(async q => {
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
    });

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
        const sbKey = generateScoreboardKey(finalEvent, 1, db, numHeats);
        await db.run('UPDATE heat SET scoreboard_key=? WHERE id=?', sbKey, heatInfo.lastInsertRowid);
        // WA lane assignment for single heat with pattern-based random shuffle
        const lanes = waAssignLanesBulk(qualSels, qualSels.length, isShortTrack_, event.name);
        qualSels.forEach(async (ath, idx) => {
            const newEntry = await db.run("INSERT INTO event_entry (event_id,athlete_id,status) VALUES (?,?,'registered')", finalEventId, ath.athlete_id);
            await db.run('INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES (?,?,?)', heatInfo.lastInsertRowid, newEntry.lastInsertRowid, lanes[idx]);
        });
    } else {
        // Multi-heat final with WA seeding
        const seeded = waSeededDistribution(event, qualSels, numHeats, db);
        for (let g = 0; g < numHeats; g++) {
            const heatInfo = await db.run('INSERT INTO heat (event_id,heat_number) VALUES (?,?)', finalEventId, g + 1);
            // Auto-generate scoreboard_key
            const sbKey = generateScoreboardKey(finalEvent, g + 1, db, numHeats);
            await db.run('UPDATE heat SET scoreboard_key=? WHERE id=?', sbKey, heatInfo.lastInsertRowid);
            const groupAthletes = seeded[g] || [];
            // Sort within group by performance for correct WA lane assignment
            groupAthletes.sort((a, b) => a.perf - b.perf);
            const lanes = waAssignLanesBulk(groupAthletes, groupAthletes.length, isShortTrack_, event.name);
            groupAthletes.forEach(async (ath, idx) => {
                const newEntry = await db.run("INSERT INTO event_entry (event_id,athlete_id,status) VALUES (?,?,'registered')", finalEventId, ath.athlete_id);
                await db.run('INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES (?,?,?)', heatInfo.lastInsertRowid, newEntry.lastInsertRowid, lanes[idx]);
            });
        }
    }
    opLog(`${event.name} ${event.gender === 'M' ? '남자' : '여자'} 결승 라운드 생성 (${qualified.length}명 진출)`, 'round', 'system', event.competition_id);
    // SSE broadcast so dashboard/results pages pick up the new final event
    broadcastSSE('event_status_changed', { event_id: finalEventId, round_status: 'heats_generated' });
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

    const result = heats.map(async heat => {
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
        const athleteDetails = entries.map(async e => {
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
        });

        return {
            heat_id: heat.id,
            heat_number: heat.heat_number,
            heat_name: heat.heat_name || `Heat ${heat.heat_number}`,
            entries: athleteDetails
        };
    });

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
        const upsertQ = db.prepare(`INSERT INTO qualification_selection (event_id,event_entry_id,selected,approved,approved_by,qualification_type) VALUES (?,?,1,1,'admin',?)
            ON CONFLICT(event_id,event_entry_id) DO UPDATE SET selected=1,approved=1,qualification_type=excluded.qualification_type`);
        for (const sel of qualifiedSels) {
            upsertQ.run(event.id, sel.event_entry_id, sel.qualification_type || '');
        }
        const info = await db.run(`INSERT INTO event (competition_id,name,category,gender,round_type,round_status) VALUES (?,?,?,?,'semifinal','heats_generated')`, event.competition_id, event.name, event.category, event.gender);
        semiEventId = info.lastInsertRowid;

        // Fetch the newly created semi event for scoreboard key generation
        const semiEvent = await db.get('SELECT * FROM event WHERE id=?', semiEventId);

        // WA serpentine seeding: sort athletes by performance, distribute in zigzag
        const seeded = waSeededDistribution(event, qualifiedSels, group_count, db);
        for (let g = 0; g < group_count; g++) {
            const heatInfo = await db.run('INSERT INTO heat (event_id,heat_number) VALUES (?,?)', semiEventId, g + 1);
            // Auto-generate scoreboard_key
            const sbKey = generateScoreboardKey(semiEvent, g + 1, db, group_count);
            await db.run('UPDATE heat SET scoreboard_key=? WHERE id=?', sbKey, heatInfo.lastInsertRowid);
            const groupAthletes = seeded[g] || [];
            // Sort within group by performance for correct WA lane assignment
            groupAthletes.sort((a, b) => a.perf - b.perf);
            const lanes = waAssignLanesBulk(groupAthletes, groupAthletes.length, isShortTrack, event.name);
            groupAthletes.forEach(async (ath, idx) => {
                const newEntry = await db.run("INSERT INTO event_entry (event_id,athlete_id,status) VALUES (?,?,'registered')", semiEventId, ath.athlete_id);
                await db.run('INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES (?,?,?)', heatInfo.lastInsertRowid, newEntry.lastInsertRowid, lanes[idx]);
            });
        }
    })();
    opLog(`${event.name} 준결승 생성 (${qualifiedIds.length}명, ${group_count}개 조)`, 'round', 'system', event.competition_id);
    // SSE broadcast so dashboard/results pages pick up the new semifinal event
    broadcastSSE('event_status_changed', { event_id: semiEventId, round_status: 'heats_generated' });
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
    // Enrich with entry_count and heat_count
    const stmtEntry = db.prepare('SELECT COUNT(*) as cnt FROM event_entry WHERE event_id=?');
    const stmtHeat = db.prepare('SELECT COUNT(*) as cnt FROM heat WHERE event_id=?');
    subs.forEach(s => {
        s.entry_count = stmtEntry.get(s.id).cnt;
        s.heat_count = stmtHeat.get(s.id).cnt;
    });
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
        subEntries.forEach(async (se, idx) => {
            await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?, ?, ?)', heatInfo.lastInsertRowid, se.id, idx + 1);
        });
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
        await db.run('DELETE FROM combined_score WHERE sub_event_order=? AND event_entry_id IN (SELECT id FROM event_entry WHERE event_id=?)', sub.sort_order, parent.id);
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

    const parentAthletes = await db.all('SELECT athlete_id FROM event_entry WHERE event_id=?', parent.id).map(e => e.athlete_id);
    const subs = await db.all('SELECT id FROM event WHERE parent_event_id=?', parent.id);
    let addedCount = 0;

    await db.transaction(async () => {
        for (const sub of subs) {
            const existingAthletes = new Set(
                await db.all('SELECT athlete_id FROM event_entry WHERE event_id=?', sub.id).map(e => e.athlete_id)
            );
            for (const athId of parentAthletes) {
                if (!existingAthletes.has(athId)) {
                    const info = await db.run('INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?, ?, ?)', sub.id, athId, 'registered');
                    // Add to existing heat (heat 1)
                    const heat = await db.get('SELECT id FROM heat WHERE event_id=? ORDER BY heat_number LIMIT 1', sub.id);
                    if (heat) {
                        const laneCount = await db.get('SELECT COUNT(*) AS c FROM heat_entry WHERE heat_id=?', heat.id).c;
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
    const result = events.map(async e => {
        const heats = await db.all('SELECT id FROM heat WHERE event_id=?', e.id);
        let totalEntries = 0, totalResults = 0;
        for (const h of heats) {
            totalEntries += await db.get('SELECT COUNT(*) AS c FROM heat_entry WHERE heat_id=?', h.id).c;
            totalResults += await db.get('SELECT COUNT(DISTINCT event_entry_id) AS c FROM result WHERE heat_id=?', h.id).c;
        }
        return { ...e, heat_count: heats.length, total_entries: totalEntries, total_results: totalResults };
    });
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
    const result = heats.map(async h => {
        const entries = await db.all(`SELECT he.lane_number, he.sub_group, ee.id AS event_entry_id, ee.status,
               a.name, a.bib_number, a.team FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id
               JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=? ORDER BY he.lane_number ASC, CAST(a.bib_number AS INTEGER)`, h.id);
        if (event.category === 'field_height') {
            return { ...h, entries, height_attempts: await db.all('SELECT * FROM height_attempt WHERE heat_id=? ORDER BY bar_height, event_entry_id, attempt_number', h.id) };
        }
        return { ...h, entries, results: await db.all('SELECT * FROM result WHERE heat_id=? ORDER BY event_entry_id, attempt_number', h.id) };
    });
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
    const maxLane = await db.get('SELECT MAX(lane_number) AS mx FROM heat_entry WHERE heat_id=?', heat_id).mx || 0;
    await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?, ?, ?)', heat_id, entry.id, maxLane + 1);
    broadcastSSE('entry_status', { event_entry_id: entry.id, status: entry.status });
    res.json({ success: true, entry });
});

// Relay team members — relay_member table only (no fallback to avoid wrong data)
app.get('/api/relay-members', async (req, res) => {
    const { event_id, team, event_entry_id } = req.query;
    if (!event_id && !event_entry_id) return res.status(400).json({ error: 'event_id or event_entry_id required' });
    
    let entryId = event_entry_id;
    if (!entryId && event_id && team) {
        const evt = await db.get('SELECT * FROM event WHERE id=?', event_id);
        if (!evt) return res.status(404).json({ error: 'Event not found' });
        const teamEntry = await db.get(`
            SELECT ee.id FROM event_entry ee
            JOIN athlete a ON a.id = ee.athlete_id
            WHERE ee.event_id = ? AND a.name = ?
        `, event_id, team);
        if (!teamEntry) return res.json([]);
        entryId = teamEntry.id;
    }
    if (!entryId) return res.json([]);
    
    // Return only athletes registered in relay_member for this entry
    const members = await db.all(`
        SELECT a.*, rm.leg_order, rm.event_entry_id FROM relay_member rm
        JOIN athlete a ON a.id = rm.athlete_id
        WHERE rm.event_entry_id = ?
        ORDER BY rm.leg_order, CAST(a.bib_number AS INTEGER)
    `, entryId);
    res.json(members);
});

// Relay members batch — all relay members for all teams in one event
app.get('/api/relay-members/batch', async (req, res) => {
    const eventId = parseInt(req.query.event_id);
    if (!eventId) return res.status(400).json({ error: 'event_id required' });
    
    // Get all event_entries for this relay event
    const entries = await db.all(`
        SELECT ee.id AS event_entry_id, a.name AS team_name, a.id AS athlete_id
        FROM event_entry ee JOIN athlete a ON a.id = ee.athlete_id
        WHERE ee.event_id = ?
    `, eventId);
    
    // For each entry, fetch relay members
    const result = {};
    for (const entry of entries) {
        const members = await db.all(`
            SELECT a.id, a.name, a.team, a.bib_number, a.gender, rm.leg_order
            FROM relay_member rm JOIN athlete a ON a.id = rm.athlete_id
            WHERE rm.event_entry_id = ?
            ORDER BY rm.leg_order, a.name
        `, entry.event_entry_id);
        if (members.length > 0) {
            result[entry.event_entry_id] = { team_name: entry.team_name, members };
        }
    }
    res.json(result);
});

// Relay member management APIs
app.post('/api/relay-members', async (req, res) => {
    const { event_entry_id, athlete_id, leg_order } = req.body;
    if (!event_entry_id || !athlete_id) return res.status(400).json({ error: 'event_entry_id and athlete_id required' });
    try {
        await db.run('INSERT OR IGNORE INTO relay_member (event_entry_id, athlete_id, leg_order) VALUES (?,?,?)', event_entry_id, athlete_id, leg_order || null);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/relay-members', async (req, res) => {
    const { event_entry_id, athlete_id } = req.body;
    if (!event_entry_id || !athlete_id) return res.status(400).json({ error: 'event_entry_id and athlete_id required' });
    await db.run('DELETE FROM relay_member WHERE event_entry_id=? AND athlete_id=?', event_entry_id, athlete_id);
    res.json({ success: true });
});

app.put('/api/relay-members/order', (req, res) => {
    const { event_entry_id, members } = req.body;
    if (!event_entry_id || !Array.isArray(members)) return res.status(400).json({ error: 'event_entry_id and members array required' });
    try {
        const stmt = db.prepare('UPDATE relay_member SET leg_order=? WHERE event_entry_id=? AND athlete_id=?');
        members.forEach(m => stmt.run(m.leg_order, event_entry_id, m.athlete_id));
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

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

    const result = events.map(async evt => {
        const heats = await db.all('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number', evt.id);
        let totalEntries = 0, checkedIn = 0, noShow = 0;
        const heatDetails = heats.map(async h => {
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
        });
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
    });
    res.json(result);
});

// ============================================================
// ADMIN: KEY MANAGEMENT (supports multi-key with judge names)
// ============================================================
app.post('/api/admin/change-keys', (req, res) => {
    const { admin_key, new_operation_key, new_admin_key, new_admin_id } = req.body;
    if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    if (new_operation_key && new_operation_key.length >= 4) ACCESS_KEYS.operation = new_operation_key;
    if (new_admin_key && new_admin_key.length >= 4) ACCESS_KEYS.admin = new_admin_key;  // setter hashes automatically
    if (new_admin_id && new_admin_id.trim()) setConfigKey('admin_id', new_admin_id.trim());
    res.json({ success: true, operation_key: ACCESS_KEYS.operation, admin_id: ADMIN_ID() });
});
app.get('/api/admin/current-keys', (req, res) => {
    if (!isAdminKey(req.query.key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    res.json({ operation: ACCESS_KEYS.operation, admin_id: ADMIN_ID() });
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
            if (k.startsWith('site_')) await db.run('INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)', k, String(v));
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
    res.json(await db.all('SELECT * FROM athlete WHERE competition_id=? ORDER BY CAST(bib_number AS INTEGER)', compId));
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
    if (compId) return res.json(await db.all('SELECT * FROM athlete WHERE competition_id=? ORDER BY CAST(bib_number AS INTEGER)', compId));
    res.json(await db.all('SELECT * FROM athlete ORDER BY CAST(bib_number AS INTEGER)'));
});
app.post('/api/admin/athletes', async (req, res) => {
    const { admin_key, competition_id, name, bib_number, team, gender, barcode } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    if (!name || !gender || !competition_id) return res.status(400).json({ error: '필수 항목이 누락되었습니다 (이름, 성별, 대회ID).' });
    try {
        const bib = bib_number ? String(bib_number).trim() : null;
        const bc = barcode || '';
        const info = await db.run('INSERT INTO athlete (competition_id,name,bib_number,team,barcode,gender) VALUES (?,?,?,?,?,?)', competition_id, name, bib, team || '', bc, gender);
        res.json(await db.get('SELECT * FROM athlete WHERE id=?', info.lastInsertRowid));
    } catch (e) { res.status(400).json({ error: '등록 오류: ' + e.message }); }
});
app.put('/api/admin/athletes/:id', async (req, res) => {
    const { admin_key, name, bib_number, team, gender, barcode } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    const old = await db.get('SELECT * FROM athlete WHERE id=?', req.params.id);
    if (!old) return res.status(404).json({ error: 'Not found' });
    try {
        const newBib = bib_number !== undefined ? (bib_number ? String(bib_number).trim() : null) : old.bib_number;
        await db.run('UPDATE athlete SET name=?,bib_number=?,team=?,gender=?,barcode=? WHERE id=?', name || old.name, newBib, team ?? old.team, gender || old.gender, barcode ?? old.barcode, old.id);
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
            const maxLeg = await db.get('SELECT MAX(leg_order) AS mx FROM relay_member WHERE event_entry_id=?', existingTeamEntry.id).mx || 0;
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
            const maxLane = await db.get('SELECT MAX(lane_number) AS mx FROM heat_entry WHERE heat_id=?', heat.id).mx || 0;
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
        const maxLane = await db.get('SELECT MAX(lane_number) AS mx FROM heat_entry WHERE heat_id=?', heat.id).mx || 0;
        await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?, ?, ?)', heat.id, entryId, maxLane + 1);

        audit('event_entry', entryId, 'INSERT', null, { event_id, athlete_id: ath.id }, 'admin', evt.competition_id, req);
        broadcastSSE('entry_status', { event_entry_id: entryId, status: 'registered' });
    })();

    res.json({ success: true, event_entry_id: await db.get('SELECT id FROM event_entry WHERE event_id=? AND athlete_id=?', event_id, ath.id).id });
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
    '7종경기','10종경기',
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
        res.json(evt);
    } catch (e) { res.status(400).json({ error: '추가 오류: ' + e.message }); }
});
app.put('/api/admin/events/:id', async (req, res) => {
    const { admin_key, name, category, gender, round_type, sort_order, round_status, video_url, division, result_url } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    const old = await db.get('SELECT * FROM event WHERE id=?', req.params.id);
    if (!old) return res.status(404).json({ error: 'Not found' });
    await db.run('UPDATE event SET name=?,category=?,gender=?,round_type=?,sort_order=?,round_status=?,video_url=?,division=?,result_url=? WHERE id=?', name || old.name, category || old.category, gender || old.gender, round_type || old.round_type, sort_order ?? old.sort_order, round_status || old.round_status, video_url ?? old.video_url ?? '', division ?? old.division ?? '', result_url ?? old.result_url ?? '', old.id);
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
    const { admin_key, event_entry_id, delete_event_entry } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    const heat = await db.get('SELECT * FROM heat WHERE id=?', req.params.id);
    if (!heat) return res.status(404).json({ error: 'Heat not found' });
    const he = await db.get('SELECT * FROM heat_entry WHERE heat_id=? AND event_entry_id=?', req.params.id, event_entry_id);
    if (!he) return res.status(404).json({ error: '해당 선수가 이 조에 없습니다.' });
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
    res.json({ success: true });
});
app.post('/api/admin/heats/:id/move-entry', async (req, res) => {
    const { admin_key, event_entry_id, target_heat_id, lane_number } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    await db.transaction(async () => {
        // Remove from current heat
        await db.run('DELETE FROM heat_entry WHERE heat_id=? AND event_entry_id=?', req.params.id, event_entry_id);
        // Add to target heat
        await db.run('INSERT OR REPLACE INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?, ?, ?)', target_heat_id, event_entry_id, lane_number || null);
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
app.get('/api/admin/backup', (req, res) => {
    if (!isOperationKey(req.query.key)) return res.status(403).json({ error: '운영키가 필요합니다.' });
    const format = req.query.format || 'json';
    const compId = req.query.competition_id;
    const tables = ['competition','event','athlete','event_entry','heat','heat_entry','result','height_attempt','combined_score','qualification_selection','relay_member','audit_log','operation_log'];
    const backup = {};
    tables.forEach(async t => {
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
    });
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
            await db.all('SELECT * FROM event WHERE competition_id=? AND parent_event_id IS NULL', competition_id).forEach(e => eventCache.set(`${e.name}|${e.category}|${e.gender}`, e.id));

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

            const insertEvent = db.prepare('INSERT INTO event (competition_id,name,category,gender,round_type,round_status) VALUES (?,?,?,?,?,?)');
            for (const [key, info] of neededIndividual) {
                const ck = `${info.name}|${info.category}|${info.gender}`;
                if (!eventCache.has(ck)) {
                    // Field, combined, road events are always 'final'
                    // Only track short-distance events can have preliminary rounds
                    const ALWAYS_FINAL_CATEGORIES = ['field_distance', 'field_height', 'combined', 'relay', 'road'];
                    const ALWAYS_FINAL_EVENTS = ['5000m','5000mW','10,000m','10,000mW','10000m','3000mSC','3000m장애물','마라톤','하프마라톤','20KmW','35kmW','10K','5K'];
                    const isFinalOnly = ALWAYS_FINAL_CATEGORIES.includes(info.category) || ALWAYS_FINAL_EVENTS.some(e => info.name === e || info.name.startsWith(e + ' '));
                    const rt = (!isFinalOnly && info.athletes.length > heatSize) ? 'preliminary' : 'final';
                    const r = insertEvent.run(competition_id, info.name, info.category, info.gender, rt, 'heats_generated');
                    eventCache.set(ck, r.lastInsertRowid);
                    stats.events++;
                }
            }
            for (const [key, teamMap] of relayParticipation) {
                const [relayName, gender] = key.split('|');
                const ck = `${relayName}|relay|${gender}`;
                if (!eventCache.has(ck)) {
                    const r = insertEvent.run(competition_id, relayName, 'relay', gender, 'final', 'heats_generated');
                    eventCache.set(ck, r.lastInsertRowid);
                    stats.events++;
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
            await db.all('SELECT * FROM athlete WHERE competition_id=?', competition_id).forEach(a => athleteCache.set(`${a.name}|${a.team}|${a.gender}`, a.id));
            const insertAthlete = db.prepare('INSERT INTO athlete (competition_id,name,bib_number,team,barcode,gender) VALUES (?,?,?,?,?,?)');
            const updateAthleteBib = db.prepare('UPDATE athlete SET bib_number=? WHERE id=? AND (bib_number IS NULL OR bib_number = ?)');
            const checkBibConflict = db.prepare('SELECT id FROM athlete WHERE competition_id=? AND bib_number=? AND gender=? AND id!=?');
            const updateAthleteBarcode = db.prepare('UPDATE athlete SET barcode=? WHERE id=? AND (barcode IS NULL OR barcode = ?)');
            const ensureAthlete = async (name, team, gender) => {
                const key = `${name}|${team}|${gender}`;
                if (athleteCache.has(key)) {
                    const existingId = athleteCache.get(key);
                    // Update bib/barcode if we have new data and existing is empty
                    const bib = _bibMap.get(key) || null;
                    const bc = _barcodeMap.get(key) || null;
                    if (bib) {
                        const existingAth = await db.get('SELECT gender FROM athlete WHERE id=?', existingId);
                        const bibConflict = checkBibConflict.get(competition_id, bib, existingAth?.gender || 'M', existingId);
                        if (!bibConflict) updateAthleteBib.run(bib, existingId, '');
                    }
                    if (bc) updateAthleteBarcode.run(bc, existingId, bc);
                    return existingId;
                }
                const bib = _bibMap.get(key) || null;
                const bc = _barcodeMap.get(key) || '';
                const r = insertAthlete.run(competition_id, name, bib, team, bc, gender);
                athleteCache.set(key, r.lastInsertRowid);
                stats.athletes++;
                return r.lastInsertRowid;
            };

            const insertEntry = db.prepare("INSERT OR IGNORE INTO event_entry (event_id,athlete_id,status) VALUES (?,?,'registered')");
            const insertHeat = db.prepare('INSERT INTO heat (event_id,heat_number) VALUES (?,?)');
            const insertHeatEntry = db.prepare('INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES (?,?,?)');
            const countHeats = db.prepare('SELECT COUNT(*) AS c FROM heat WHERE event_id=?');
            const getEntryId = db.prepare('SELECT id FROM event_entry WHERE event_id=? AND athlete_id=?');

            for (const [key, info] of neededIndividual) {
                const eventId = eventCache.get(`${info.name}|${info.category}|${info.gender}`);
                if (!eventId) continue;
                if (countHeats.get(eventId).c > 0) continue;
                const entryIds = [];
                for (const ath of info.athletes) {
                    const aid = ensureAthlete(ath.name, ath.team, ath.gender);
                    const er = insertEntry.run(eventId, aid);
                    const eid = er.lastInsertRowid || getEntryId.get(eventId, aid)?.id;
                    if (eid) { entryIds.push(eid); stats.entries++; }
                }
                // Only short track events (≤800m) split into multiple heats (max 8 per heat)
                // Field events, long-distance track, combined, road → always 1 heat
                const isShort = isShortTrackEvent(info.name);
                const effectiveHeatSize = isShort ? heatSize : entryIds.length;
                const heatCount = isShort ? Math.ceil(entryIds.length / heatSize) : 1;
                for (let h = 0; h < heatCount; h++) {
                    const hr = insertHeat.run(eventId, h + 1);
                    stats.heats++;
                    entryIds.slice(h * effectiveHeatSize, (h + 1) * effectiveHeatSize).forEach((eid, lane) => insertHeatEntry.run(hr.lastInsertRowid, eid, lane + 1));
                }
            }

            // ============================================================
            // AUTO-CREATE COMBINED (10종/7종) SUB-EVENTS
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
            const insertSubEvent = db.prepare('INSERT INTO event (competition_id,name,category,gender,round_type,round_status,parent_event_id,sort_order) VALUES (?,?,?,?,?,?,?,?)');
            for (const [key, info] of neededIndividual) {
                if (info.category !== 'combined') continue;
                const parentId = eventCache.get(`${info.name}|${info.category}|${info.gender}`);
                if (!parentId) continue;
                const existingSubs = await db.get('SELECT COUNT(*) AS c FROM event WHERE parent_event_id=?', parentId).c;
                if (existingSubs > 0) continue;
                const subs = info.name === '10종경기' ? DECATHLON_SUBS : HEPTATHLON_SUBS;
                const prefix = info.name === '10종경기' ? '[10종]' : '[7종]';
                for (const sub of subs) {
                    const subName = `${prefix} ${sub.name}`;
                    const subR = insertSubEvent.run(competition_id, subName, sub.category, info.gender, 'final', 'heats_generated', parentId, sub.order);
                    const subEventId = subR.lastInsertRowid;
                    const parentEntries = await db.all('SELECT ee.id, ee.athlete_id FROM event_entry ee WHERE ee.event_id=?', parentId);
                    for (const pe of parentEntries) {
                        insertEntry.run(subEventId, pe.athlete_id);
                    }
                    const subHeatR = insertHeat.run(subEventId, 1);
                    const subEntryIds = await db.all('SELECT id FROM event_entry WHERE event_id=?', subEventId);
                    subEntryIds.forEach((se, lane) => insertHeatEntry.run(subHeatR.lastInsertRowid, se.id, lane + 1));
                }
                console.log(`[Combined] Created ${subs.length} sub-events for ${info.name} (${info.gender}), parent_id=${parentId}`);
            }

            // ============================================================
            // RELAY: Create team entries + store relay members
            // ============================================================
            const insertRelayMember = db.prepare('INSERT OR IGNORE INTO relay_member (event_entry_id, athlete_id, leg_order) VALUES (?,?,?)');
            for (const [key, teamMap] of relayParticipation) {
                const [relayName, gender] = key.split('|');
                const eventId = eventCache.get(`${relayName}|relay|${gender}`);
                if (!eventId) continue;
                if (await db.get('SELECT COUNT(*) AS c FROM heat WHERE event_id=?', eventId).c > 0) continue;
                const entryIds = [];
                for (const [teamName, members] of teamMap) {
                    // Create a "team athlete" record: name=teamName, bib=teamName, team=teamName
                    const rGender = gender === 'X' ? 'M' : gender;
                    const aid = ensureAthlete(teamName, teamName, rGender);
                    const er = insertEntry.run(eventId, aid);
                    const eid = er.lastInsertRowid || getEntryId.get(eventId, aid)?.id;
                    if (eid) {
                        entryIds.push(eid);
                        stats.entries++;
                        stats.relayTeams++;
                        // Store each member of this relay team
                        // Use ensureAthlete so relay-only athletes are also inserted
                        let legOrder = 1;
                        for (const member of members) {
                            const memberGender = member.gender || rGender;
                            const memberAid = ensureAthlete(member.name, teamName, memberGender);
                            if (memberAid) {
                                insertRelayMember.run(eid, memberAid, legOrder++);
                            }
                        }
                    }
                }
                const heatCount = Math.ceil(entryIds.length / 8);
                for (let h = 0; h < heatCount; h++) {
                    const hr = insertHeat.run(eventId, h + 1);
                    stats.heats++;
                    entryIds.slice(h * 8, (h + 1) * 8).forEach((eid, lane) => insertHeatEntry.run(hr.lastInsertRowid, eid, lane + 1));
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

                        // 기존 heat/heat_entry 삭제 후 조편성대로 재배정
                        const deleteHeatEntries = db.prepare('DELETE FROM heat_entry WHERE heat_id=?');
                        const deleteHeats = db.prepare('DELETE FROM heat WHERE event_id=?');
                        
                        for (const [evtKey, assignments] of heatAssign) {
                            const eventId = eventCache.get(evtKey);
                            if (!eventId) continue;
                            
                            // 기존 heats 삭제
                            const existingHeats = await db.all('SELECT id FROM heat WHERE event_id=?', eventId);
                            for (const eh of existingHeats) { deleteHeatEntries.run(eh.id); }
                            deleteHeats.run(eventId);
                            
                            // 조별 그룹핑
                            const heatGroups = new Map();
                            assignments.forEach(a => {
                                if (!heatGroups.has(a.heat)) heatGroups.set(a.heat, []);
                                heatGroups.get(a.heat).push(a);
                            });
                            
                            // 조 생성 및 선수 배정
                            for (const [heatNum, entries] of [...heatGroups].sort((a,b) => a[0] - b[0])) {
                                const hr = insertHeat.run(eventId, heatNum);
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
                                    
                                    insertHeatEntry.run(heatId, entry.id, ent.lane);
                                }
                            }
                        }
                        console.log(`[조편성] ${heatAssign.size}개 종목 조편성 적용 완료`);
                    }
                }
            }

        })();
        opLog(`연맹 명단 업로드: 선수 ${stats.athletes}명, 종목 ${stats.events}개`, 'import', 'admin', competition_id);
        res.json({ success: true, message: '업로드 완료', stats });
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
            await db.all('SELECT * FROM athlete WHERE competition_id=?', competition_id)
                .forEach(a => existingCache.set(`${a.name}|${a.team}|${a.gender}`, a));

            const insertAth = db.prepare('INSERT INTO athlete (competition_id,name,bib_number,team,barcode,gender) VALUES (?,?,?,?,?,?)');

            for (const row of dataRows) {
                let name, team, genderRaw, bib, barcode;
                if (useHeaders) {
                    name = String(row[hdrMap.name] || '').trim();
                    team = hdrMap.team !== undefined ? String(row[hdrMap.team] || '').trim() : '';
                    genderRaw = hdrMap.gender !== undefined ? String(row[hdrMap.gender] || '').trim() : '';
                    bib = hdrMap.bib !== undefined ? (String(row[hdrMap.bib] || '').trim() || null) : null;
                    barcode = hdrMap.barcode !== undefined ? (String(row[hdrMap.barcode] || '').trim() || '') : '';
                } else {
                    // Legacy fixed columns: bib | name | team | gender | barcode
                    bib = String(row[0] || '').trim() || null;
                    name = String(row[1] || '').trim();
                    team = String(row[2] || '').trim();
                    genderRaw = String(row[3] || '').trim();
                    barcode = String(row[4] || '').trim() || '';
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
                        if (didUpdate) stats.updated = (stats.updated || 0) + 1;
                    }
                    stats.skipped++; continue;
                }
                insertAth.run(competition_id, name, bib, team, barcode, gender);
                existingCache.set(key, { id: null, bib_number: bib, barcode });
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
        await db.all('SELECT * FROM athlete WHERE competition_id=?', competition_id)
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
            await db.all('SELECT * FROM event WHERE competition_id=?', competition_id)
                .forEach(e => existingCache.set(`${e.name}|${e.category}|${e.gender}|${e.round_type}`, e.id));

            const insertEvt = db.prepare('INSERT INTO event (competition_id,name,category,gender,round_type,round_status,sort_order) VALUES (?,?,?,?,?,?,?)');
            const insertHeat = db.prepare('INSERT INTO heat (event_id,heat_number) VALUES (?,?)');
            let sortOrder = (await db.get('SELECT MAX(sort_order) AS mx FROM event WHERE competition_id=?', competition_id).mx || 0) + 1;

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

                const r = insertEvt.run(competition_id, name, category, gender, roundType, 'created', sortOrder++);
                // Auto-create first heat
                insertHeat.run(r.lastInsertRowid, 1);
                existingCache.set(key, r.lastInsertRowid);

                // Auto-create combined sub-events
                if (category === 'combined') {
                    const DECA = ['100m','멀리뛰기','포환던지기','높이뛰기','400m','110mH','원반던지기','장대높이뛰기','창던지기','1500m'];
                    const HEPTA = ['100mH','높이뛰기','포환던지기','200m','멀리뛰기','창던지기','800m'];
                    const subDefs = (gender === 'M') ? DECA : HEPTA;
                    const subCats = { '멀리뛰기':'field_distance','포환던지기':'field_distance','높이뛰기':'field_height',
                        '원반던지기':'field_distance','장대높이뛰기':'field_height','창던지기':'field_distance' };
                    subDefs.forEach(async (sn, idx) => {
                        const sc = subCats[sn] || 'track';
                        const sr = insertEvt.run(competition_id, sn, sc, gender, 'final', 'created', sortOrder++);
                        await db.run('UPDATE event SET parent_event_id=? WHERE id=?', r.lastInsertRowid, sr.lastInsertRowid);
                        insertHeat.run(sr.lastInsertRowid, 1);
                    });
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
                    suggestions = await db.all('SELECT id, name, round_type FROM event WHERE competition_id=? AND gender=? AND parent_event_id IS NULL ORDER BY name', competition_id, gender).map(e => ({ id: e.id, name: e.name, round: e.round_type }));
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
                resultCount += await db.get('SELECT COUNT(*) as c FROM result WHERE heat_id=?', h.id).c;
                heightAttemptCount += await db.get('SELECT COUNT(*) as c FROM height_attempt WHERE heat_id=?', h.id).c;
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

// AUTO-CREATE missing events from heat assignment Excel
app.post('/api/heat-assignment/create-events', express.json(), async (req, res) => {
    if (!isAdminKey(req.body.admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    const { competition_id, events } = req.body;
    if (!competition_id || !events || !Array.isArray(events)) return res.status(400).json({ error: 'competition_id와 events 배열이 필요합니다.' });

    // Detect category from event name
    function detectCategory(name) {
        const n = name.toLowerCase();
        if (n.includes('릴레이') || n.includes('relay') || /^\d+x\d+m/i.test(n)) return 'relay';
        // FIX: 트랙 경보(5000mW, 10000mW 등)는 트랙. 도로 경보(20kmW, 35kmW, 50kmW)만 road.
        if (/\d+\s*km\s*w/i.test(n)) return 'road'; // 20kmW, 35kmW, 50kmW (도로경보)
        if (/\d+\s*m\s*w$/i.test(n)) return 'track'; // 5000mW, 10000mW (트랙경보)
        if (n.includes('마라톤') || n.includes('하프') || n.includes('half') || n.includes('road')) return 'road';
        if (/\d+\s*k(m)?\b/i.test(n)) return 'road'; // 5K, 10K, 10km (도로)
        if (n.includes('높이') || n.includes('장대') || n.includes('high') || n.includes('pole')) return 'field_height';
        if (n.includes('멀리') || n.includes('세단') || n.includes('포환') || n.includes('원반') || n.includes('창') || n.includes('해머') || n.includes('투척') || n.includes('long') || n.includes('triple') || n.includes('shot') || n.includes('discus') || n.includes('javelin') || n.includes('hammer')) return 'field_distance';
        if (n.includes('10종') || n.includes('7종') || n.includes('decathlon') || n.includes('heptathlon') || n.includes('combined')) return 'combined';
        return 'track'; // default: 알 수 없는 종목은 트랙으로 처리 (이전엔 road 기본값으로 잘못 처리됨)
    }

    const created = [];
    const stmt = db.prepare('INSERT INTO event (competition_id, name, gender, category, round_type, round_status, sort_order) VALUES (?,?,?,?,?,?,?)');
    const maxSort = await db.get('SELECT MAX(sort_order) as m FROM event WHERE competition_id=?', competition_id).m || 0;

    let sortOrder = maxSort + 1;
    for (const evt of events) {
        const { eventName, gender, round } = evt;
        if (!eventName || !gender) continue;
        // Check if already exists
        const existing = await db.get('SELECT id FROM event WHERE competition_id=? AND name=? AND gender=?', competition_id, eventName, gender);
        if (existing) continue;

        const category = detectCategory(eventName);
        const info = stmt.run(competition_id, eventName, gender, category, round || 'final', 'created', sortOrder++);
        created.push({ id: info.lastInsertRowid, name: eventName, gender, category, round: round || 'final' });
    }

    if (created.length > 0) {
        opLog(`종목 자동 생성 (${created.length}개): ${created.map(e => e.name).join(', ')}`, 'admin', 'admin');
    }

    res.json({ success: true, created, count: created.length });
});

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
            await db.all('SELECT * FROM athlete WHERE competition_id=?', competition_id)
                .forEach(a => {
                    athleteCache.set(`${a.name}|${a.team}|${a.gender}`, a);
                    // Also index by name+team (without gender) for flexible matching
                    if (!athleteCache.has(`${a.name}|${a.team}`)) {
                        athleteCache.set(`${a.name}|${a.team}`, a);
                    }
                });
            
            const insertAthlete = db.prepare('INSERT INTO athlete (competition_id,name,bib_number,team,barcode,gender) VALUES (?,?,?,?,?,?)');
            const updateAthleteBibHA = db.prepare('UPDATE athlete SET bib_number=? WHERE id=? AND bib_number IS NULL');
            const insertEntry = db.prepare("INSERT OR IGNORE INTO event_entry (event_id,athlete_id,status) VALUES (?,?,'registered')");
            const getEntryId = db.prepare('SELECT id FROM event_entry WHERE event_id=? AND athlete_id=?');
            const insertHeat = db.prepare('INSERT INTO heat (event_id,heat_number,scoreboard_key) VALUES (?,?,?)');
            const insertHeatEntry = db.prepare('INSERT INTO heat_entry (heat_id,event_entry_id,lane_number,sub_group) VALUES (?,?,?,?)');

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
                    resultCount += await db.get('SELECT COUNT(*) as c FROM result WHERE heat_id=?', h.id).c;
                    resultCount += await db.get('SELECT COUNT(*) as c FROM height_attempt WHERE heat_id=?', h.id).c;
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
                    const heatRow = insertHeat.run(dbEvent.id, heatNum, sbKey);
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
                            const r = insertAthlete.run(competition_id, entry.name, newBib, entry.team || entry.name, bc, newGender);
                            athlete = { id: r.lastInsertRowid, name: entry.name, bib_number: newBib, team: entry.team || entry.name, gender: newGender };
                            athleteCache.set(`${entry.name}|${entry.team || entry.name}|${newGender}`, athlete);
                            athleteCache.set(`${entry.name}|${entry.team || entry.name}`, athlete);
                            stats.athletesAdded++;
                        } else if (entry.bib && !athlete.bib_number) {
                            // Athlete exists but has no bib — update from heat assignment data
                            const bibStr = String(entry.bib);
                            const bibTaken = await db.get('SELECT id FROM athlete WHERE competition_id=? AND bib_number=? AND gender=? AND id!=?', competition_id, bibStr, athlete.gender || effGender || 'M', athlete.id);
                            if (!bibTaken) {
                                updateAthleteBibHA.run(bibStr, athlete.id);
                                athlete.bib_number = bibStr;
                            }
                        }

                        // Ensure event_entry exists
                        const entryResult = insertEntry.run(dbEvent.id, athlete.id);
                        let eventEntryId = entryResult.changes > 0 ? entryResult.lastInsertRowid : null;
                        if (!eventEntryId) {
                            const existing = getEntryId.get(dbEvent.id, athlete.id);
                            eventEntryId = existing ? existing.id : null;
                        }

                        if (eventEntryId) {
                            // Prevent UNIQUE constraint violation: skip if this event_entry is already in this heat
                            const alreadyInHeat = await db.get('SELECT id FROM heat_entry WHERE heat_id=? AND event_entry_id=?', heatId, eventEntryId);
                            if (!alreadyInHeat) {
                                insertHeatEntry.run(heatId, eventEntryId, entry.lane, entry.group || null);
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
                            const hRow = insertHeat.run(dbEvent.id, 1, sbKey);
                            targetHeatId = hRow.lastInsertRowid;
                        }
                        
                        // Find max lane number currently in this heat
                        const maxLane = await db.get('SELECT MAX(lane_number) as m FROM heat_entry WHERE heat_id=?', targetHeatId);
                        let nextLane = (maxLane && maxLane.m) ? maxLane.m + 1 : 1;
                        
                        for (const pEntry of parentEntries) {
                            // Ensure event_entry exists in sub-event
                            const eeResult = insertEntry.run(dbEvent.id, pEntry.athlete_id);
                            let eeId = eeResult.changes > 0 ? eeResult.lastInsertRowid : null;
                            if (!eeId) {
                                const existing = getEntryId.get(dbEvent.id, pEntry.athlete_id);
                                eeId = existing ? existing.id : null;
                            }
                            if (!eeId) continue;
                            
                            // Check if already in any heat for this sub-event
                            const alreadyAssigned = await db.get('SELECT he.id FROM heat_entry he JOIN heat h ON he.heat_id=h.id WHERE h.event_id=? AND he.event_entry_id=?', dbEvent.id, eeId);
                            
                            if (!alreadyAssigned) {
                                // Not in heat → add to the target heat with next available lane
                                insertHeatEntry.run(targetHeatId, eeId, nextLane++, null);
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
                    const insertRelayMem = db.prepare('INSERT OR IGNORE INTO relay_member (event_entry_id, athlete_id, leg_order) VALUES (?,?,?)');
                    
                    for (const teamEntry of allEventEntries) {
                        // "Team athlete" records: name === team (e.g., name='광주광역시청', team='광주광역시청')
                        if (teamEntry.name !== teamEntry.team) continue;
                        
                        // Check if this team entry already has relay members
                        const existingMembers = await db.get('SELECT COUNT(*) AS c FROM relay_member WHERE event_entry_id=?', teamEntry.id).c;
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
                            insertRelayMem.run(teamEntry.id, ath.id, legOrder++);
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

// GET all pacing configs for a competition
app.get('/api/pacing', async (req, res) => {
    const compId = parseInt(req.query.competition_id) || null;
    if (!compId) return res.status(400).json({ error: 'competition_id required' });
    const configs = await db.all('SELECT * FROM pacing_config WHERE competition_id=? ORDER BY event_name', compId);
    const result = configs.map(async cfg => {
        const colors = await db.all('SELECT * FROM pacing_color WHERE pacing_config_id=? ORDER BY sort_order', cfg.id);
        colors.forEach(async c => {
            c.segments = await db.all('SELECT * FROM pacing_segment WHERE pacing_color_id=? ORDER BY segment_order', c.id);
        });
        return { ...cfg, colors };
    });
    res.json(result);
});

// GET single pacing config by id
app.get('/api/pacing/:id', async (req, res) => {
    const cfg = await db.get('SELECT * FROM pacing_config WHERE id=?', parseInt(req.params.id));
    if (!cfg) return res.status(404).json({ error: 'not found' });
    const colors = await db.all('SELECT * FROM pacing_color WHERE pacing_config_id=? ORDER BY sort_order', cfg.id);
    colors.forEach(async c => {
        c.segments = await db.all('SELECT * FROM pacing_segment WHERE pacing_color_id=? ORDER BY segment_order', c.id);
    });
    res.json({ ...cfg, colors });
});

// POST create or update full pacing config (upsert)
// Body: { competition_id, event_name, notice, colors: [{ color_key, sort_order, remark, segments: [{ segment_order, distance_meters, lap_seconds }] }] }
app.post('/api/pacing', async (req, res) => {
    const key = req.body.admin_key || req.headers['x-admin-key'] || '';
    if (!isOperationKey(key)) return res.status(403).json({ error: '인증 필요' });
    const { competition_id, event_name, notice, colors } = req.body;
    if (!competition_id || !event_name) return res.status(400).json({ error: 'competition_id and event_name required' });

    const trx = db.transaction(async () => {
        // Upsert pacing_config
        let cfg = await db.get('SELECT id FROM pacing_config WHERE competition_id=? AND event_name=?', competition_id, event_name);
        if (cfg) {
            await db.run('UPDATE pacing_config SET notice=?, updated_at=datetime(\'now\') WHERE id=?', notice || '', cfg.id);
        } else {
            const r = await db.run('INSERT INTO pacing_config (competition_id, event_name, notice) VALUES (?,?,?)', competition_id, event_name, notice || '');
            cfg = { id: r.lastInsertRowid };
        }
        // Delete old colors + segments (cascade)
        await db.run('DELETE FROM pacing_color WHERE pacing_config_id=?', cfg.id);
        // Insert colors + segments
        if (Array.isArray(colors)) {
            colors.forEach(async (c, ci) => {
                const cr = await db.run('INSERT INTO pacing_color (pacing_config_id, color_key, sort_order, remark) VALUES (?,?,?,?)', cfg.id, c.color_key, c.sort_order != null ? c.sort_order : ci, c.remark || '');
                if (Array.isArray(c.segments)) {
                    c.segments.forEach(async (seg, si) => {
                        await db.run('INSERT INTO pacing_segment (pacing_color_id, segment_order, distance_meters, lap_seconds) VALUES (?,?,?,?)', cr.lastInsertRowid, seg.segment_order != null ? seg.segment_order : si, seg.distance_meters, seg.lap_seconds);
                    });
                }
            });
        }
        return cfg.id;
    });
    try {
        const cfgId = await trx();
        opLog(`페이싱 라이트 설정 저장: ${event_name}`, 'pacing', getJudgeName(key), competition_id);
        broadcastSSE('pacing_update', { competition_id, event_name });
        res.json({ ok: true, id: cfgId });
    } catch (e) {
        console.error('[Pacing Save Error]', e);
        res.status(500).json({ error: e.message });
    }
});

// DELETE pacing config
app.delete('/api/pacing/:id', async (req, res) => {
    const key = req.body.admin_key || req.headers['x-admin-key'] || '';
    if (!isOperationKey(key)) return res.status(403).json({ error: '인증 필요' });
    const cfg = await db.get('SELECT * FROM pacing_config WHERE id=?', parseInt(req.params.id));
    if (!cfg) return res.status(404).json({ error: 'not found' });
    await db.run('DELETE FROM pacing_config WHERE id=?', cfg.id);
    opLog(`페이싱 라이트 삭제: ${cfg.event_name}`, 'pacing', getJudgeName(key), cfg.competition_id);
    broadcastSSE('pacing_update', { competition_id: cfg.competition_id });
    res.json({ ok: true });
});

// GET pacing configs for dashboard (public, no auth)
app.get('/api/public/pacing', async (req, res) => {
    const compId = parseInt(req.query.competition_id) || null;
    if (!compId) return res.status(400).json({ error: 'competition_id required' });
    const configs = await db.all('SELECT * FROM pacing_config WHERE competition_id=? ORDER BY event_name', compId);
    const result = configs.map(async cfg => {
        const colors = await db.all('SELECT * FROM pacing_color WHERE pacing_config_id=? ORDER BY sort_order', cfg.id);
        colors.forEach(async c => {
            c.segments = await db.all('SELECT * FROM pacing_segment WHERE pacing_color_id=? ORDER BY segment_order', c.id);
        });
        return { ...cfg, colors };
    });
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
                        await db.run("UPDATE result SET time_seconds=?,status_code=?,remark=?,updated_at=datetime('now') WHERE id=?", time_seconds, status_code, '', existing.id);
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
    
    // Also include joint scoreboard keys from event_link
    const jointKeys = await db.all(`
        SELECT el.id as link_id, el.joint_scoreboard_key, el.event_id_a, el.event_id_b,
               ea.name as event_name, ea.gender, ea.round_type, ea.category
        FROM event_link el
        JOIN event ea ON ea.id = el.event_id_a
        WHERE (ea.competition_id = ? OR el.event_id_b IN (SELECT id FROM event WHERE competition_id = ?))
              AND el.joint_scoreboard_key IS NOT NULL
    `, competition_id, competition_id);
    
    res.json({
        heat_keys: keys,
        joint_keys: jointKeys
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
        const jointLink = await db.get(`SELECT * FROM event_link WHERE joint_scoreboard_key = ?`, key);
        if (jointLink) {
            // Found a joint key — redirect to joint scoreboard data
            const eventId = jointLink.event_id_a;
            const jointData = getJointScoreboardData(eventId, db);
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

/**
 * GET /api/event-links?competition_id=N
 * 해당 대회에 연결된 모든 합동 종목 목록
 */
app.get('/api/event-links', async (req, res) => {
    const { competition_id } = req.query;
    if (!competition_id) return res.status(400).json({ error: 'competition_id 필수' });
    const links = await db.all(`
        SELECT el.*,
               ea.name as event_a_name, ea.gender as event_a_gender, ea.category as event_a_category,
               ca.name as comp_a_name, ca.federation as comp_a_federation,
               eb.name as event_b_name, eb.gender as event_b_gender, eb.category as event_b_category,
               cb.name as comp_b_name, cb.federation as comp_b_federation
        FROM event_link el
        JOIN event ea ON ea.id = el.event_id_a
        JOIN competition ca ON ca.id = ea.competition_id
        JOIN event eb ON eb.id = el.event_id_b
        JOIN competition cb ON cb.id = eb.competition_id
        WHERE ea.competition_id = ? OR eb.competition_id = ?
        ORDER BY ea.name, ea.gender
    `, competition_id, competition_id);
    res.json(links);
});

/**
 * POST /api/event-links
 * 합동 종목 연결 생성
 * Body: { admin_key, event_id_a, event_id_b }
 */
app.post('/api/event-links', async (req, res) => {
    const { admin_key, event_id_a, event_id_b } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    if (!event_id_a || !event_id_b) return res.status(400).json({ error: 'event_id_a, event_id_b 필수' });
    if (event_id_a === event_id_b) return res.status(400).json({ error: '같은 종목끼리 연결할 수 없습니다.' });
    
    // Verify events exist
    const evA = await db.get('SELECT * FROM event WHERE id=?', event_id_a);
    const evB = await db.get('SELECT * FROM event WHERE id=?', event_id_b);
    if (!evA || !evB) return res.status(404).json({ error: '종목을 찾을 수 없습니다.' });
    
    try {
        // Ensure consistent order (smaller id first)
        const [idA, idB] = event_id_a < event_id_b ? [event_id_a, event_id_b] : [event_id_b, event_id_a];
        await db.run('INSERT OR IGNORE INTO event_link (event_id_a, event_id_b) VALUES (?, ?)', idA, idB);
        
        const compA = await db.get('SELECT name, federation FROM competition WHERE id=?', evA.competition_id);
        const compB = await db.get('SELECT name, federation FROM competition WHERE id=?', evB.competition_id);
        opLog(`합동 종목 연결: ${evA.name}(${compA?.federation || compA?.name}) ↔ ${evB.name}(${compB?.federation || compB?.name})`, 'admin', 'admin');
        
        // Auto-generate joint scoreboard key
        const jointKey = generateJointScoreboardKey(evA, db);
        const link = await db.get('SELECT id FROM event_link WHERE event_id_a=? AND event_id_b=?', idA, idB);
        if (link) {
            await db.run('UPDATE event_link SET joint_scoreboard_key=? WHERE id=?', jointKey, link.id);
        }
        
        res.json({ success: true, joint_scoreboard_key: jointKey });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * DELETE /api/event-links/:id
 * 합동 종목 연결 삭제
 */
app.delete('/api/event-links/:id', async (req, res) => {
    const { admin_key } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    await db.run('DELETE FROM event_link WHERE id=?', req.params.id);
    res.json({ success: true });
});

/**
 * POST /api/event-links/auto-match
 * 두 대회 간 같은 종목명+성별 자동 매칭
 * Body: { admin_key, competition_id_a, competition_id_b }
 */
app.post('/api/event-links/auto-match', async (req, res) => {
    const { admin_key, competition_id_a, competition_id_b } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    if (!competition_id_a || !competition_id_b) return res.status(400).json({ error: 'competition_id_a, competition_id_b 필수' });
    
    const eventsA = await db.all('SELECT * FROM event WHERE competition_id=? AND parent_event_id IS NULL', competition_id_a);
    const eventsB = await db.all('SELECT * FROM event WHERE competition_id=? AND parent_event_id IS NULL', competition_id_b);
    
    let linked = 0;
    const matches = [];
    for (const a of eventsA) {
        const b = eventsB.find(e => e.name === a.name && e.gender === a.gender && e.round_type === a.round_type);
        if (b) {
            const [idA, idB] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
            const existing = await db.get('SELECT id FROM event_link WHERE event_id_a=? AND event_id_b=?', idA, idB);
            if (!existing) {
                const jointKey = generateJointScoreboardKey(a, db);
                await db.run('INSERT INTO event_link (event_id_a, event_id_b, joint_scoreboard_key) VALUES (?, ?, ?)', idA, idB, jointKey);
                linked++;
            }
            matches.push({ event_name: a.name, gender: a.gender, event_id_a: a.id, event_id_b: b.id });
        }
    }
    
    opLog(`합동 종목 자동 매칭: ${linked}개 연결 (대회 ${competition_id_a} ↔ ${competition_id_b})`, 'admin', 'admin');
    res.json({ success: true, linked, matches });
});

// ============================================================
// JOINT GROUP MANAGEMENT — 합동 종목 그룹 (다중 대회 N:N)
// ============================================================

/**
 * GET /api/joint-groups?competition_id=N
 * List all joint groups that contain events from the given competition
 */
app.get('/api/joint-groups', async (req, res) => {
    const { competition_id } = req.query;
    if (!competition_id) return res.status(400).json({ error: 'competition_id 필수' });
    const groups = await db.all(`
        SELECT DISTINCT jg.* FROM joint_group jg
        JOIN joint_group_member jgm ON jgm.joint_group_id = jg.id
        WHERE jgm.competition_id = ?
        ORDER BY jg.id
    `, competition_id);
    // For each group, fetch members
    const result = groups.map(async g => {
        const members = await db.all(`
            SELECT jgm.*, e.name as event_name, e.gender, e.round_type, e.category,
                   c.name as comp_name, c.federation
            FROM joint_group_member jgm
            JOIN event e ON e.id = jgm.event_id
            JOIN competition c ON c.id = jgm.competition_id
            WHERE jgm.joint_group_id = ?
            ORDER BY jgm.sort_order
        `, g.id);
        return { ...g, members };
    });
    res.json(result);
});

/**
 * POST /api/joint-groups
 * Create a new joint group with selected events (multi-select)
 * Body: { admin_key, name, event_ids: [id1, id2, ...] }
 */
app.post('/api/joint-groups', async (req, res) => {
    const { admin_key, name, event_ids } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    if (!event_ids || !Array.isArray(event_ids) || event_ids.length < 2) {
        return res.status(400).json({ error: '최소 2개 이상의 종목을 선택하세요.' });
    }
    // Verify all events exist
    const events = event_ids.map(async id => await db.get('SELECT e.*, c.name as comp_name, c.federation FROM event e JOIN competition c ON c.id=e.competition_id WHERE e.id=?', id)).filter(Boolean);
    if (events.length < 2) return res.status(400).json({ error: '유효한 종목이 2개 미만입니다.' });

    // Auto-generate scoreboard key
    const genderLabel = { M: '남자', F: '여자', X: '혼성' }[events[0].gender] || '';
    const roundLabel = { preliminary: '예선', semifinal: '준결승', final: '결승' }[events[0].round_type] || '';
    const autoKey = `합동 ${genderLabel} ${events[0].name} ${roundLabel}`.trim();
    const groupName = name || events[0].name;

    let groupId;
    await db.transaction(async () => {
        const info = await db.run('INSERT INTO joint_group (name, joint_scoreboard_key) VALUES (?, ?)', groupName, autoKey);
        groupId = info.lastInsertRowid;
        events.forEach(async (evt, idx) => {
            await db.run('INSERT OR IGNORE INTO joint_group_member (joint_group_id, event_id, competition_id, sort_order) VALUES (?, ?, ?, ?)', groupId, evt.id, evt.competition_id, idx);
        });
        // Also maintain backward-compat event_link for scoreboard (pair-wise)
        for (let i = 0; i < events.length; i++) {
            for (let j = i + 1; j < events.length; j++) {
                const [idA, idB] = events[i].id < events[j].id ? [events[i].id, events[j].id] : [events[j].id, events[i].id];
                await db.run('INSERT OR IGNORE INTO event_link (event_id_a, event_id_b, joint_scoreboard_key) VALUES (?, ?, ?)', idA, idB, autoKey);
            }
        }
    })();

    const feds = events.map(e => e.federation || e.comp_name).join('+');
    opLog(`합동 그룹 생성: ${groupName} (${feds}, ${events.length}개 종목)`, 'admin', 'admin');
    const created = await db.get('SELECT * FROM joint_group WHERE id=?', groupId);
    res.json({ success: true, group: created });
});

/**
 * PUT /api/joint-groups/:id
 * Update a joint group (name, scoreboard key)
 * Body: { admin_key, name?, joint_scoreboard_key? }
 */
app.put('/api/joint-groups/:id', async (req, res) => {
    const { admin_key, name, joint_scoreboard_key } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    const g = await db.get('SELECT * FROM joint_group WHERE id=?', req.params.id);
    if (!g) return res.status(404).json({ error: 'Joint group not found' });

    const updates = [], params = [];
    if (name !== undefined) { updates.push('name=?'); params.push(name); }
    if (joint_scoreboard_key !== undefined) {
        updates.push('joint_scoreboard_key=?');
        params.push(joint_scoreboard_key);
        // Also update event_link backward compat keys
        const members = await db.all('SELECT event_id FROM joint_group_member WHERE joint_group_id=?', g.id);
        const ids = members.map(m => m.event_id);
        for (let i = 0; i < ids.length; i++) {
            for (let j = i + 1; j < ids.length; j++) {
                const [idA, idB] = ids[i] < ids[j] ? [ids[i], ids[j]] : [ids[j], ids[i]];
                await db.run('UPDATE event_link SET joint_scoreboard_key=? WHERE event_id_a=? AND event_id_b=?', joint_scoreboard_key, idA, idB);
            }
        }
    }
    if (updates.length === 0) return res.status(400).json({ error: '수정할 항목이 없습니다.' });
    params.push(g.id);
    await db.run(`UPDATE joint_group SET ${updates.join(',')} WHERE id=?`, ...params);
    res.json({ success: true });
});

/**
 * DELETE /api/joint-groups/:id
 * Delete a joint group and its members
 */
app.delete('/api/joint-groups/:id', async (req, res) => {
    const { admin_key } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    const g = await db.get('SELECT * FROM joint_group WHERE id=?', req.params.id);
    if (!g) return res.status(404).json({ error: 'Joint group not found' });

    await db.transaction(async () => {
        // Remove backward-compat event_link entries
        const members = await db.all('SELECT event_id FROM joint_group_member WHERE joint_group_id=?', g.id);
        const ids = members.map(m => m.event_id);
        for (let i = 0; i < ids.length; i++) {
            for (let j = i + 1; j < ids.length; j++) {
                const [idA, idB] = ids[i] < ids[j] ? [ids[i], ids[j]] : [ids[j], ids[i]];
                await db.run('DELETE FROM event_link WHERE event_id_a=? AND event_id_b=?', idA, idB);
            }
        }
        await db.run('DELETE FROM joint_group_member WHERE joint_group_id=?', g.id);
        await db.run('DELETE FROM joint_group WHERE id=?', g.id);
    })();
    opLog(`합동 그룹 삭제: ${g.name}`, 'admin', 'admin');
    res.json({ success: true });
});

/**
 * POST /api/joint-groups/:id/members
 * Add events to an existing joint group
 * Body: { admin_key, event_ids: [id1, id2, ...] }
 */
app.post('/api/joint-groups/:id/members', async (req, res) => {
    const { admin_key, event_ids } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    const g = await db.get('SELECT * FROM joint_group WHERE id=?', req.params.id);
    if (!g) return res.status(404).json({ error: 'Joint group not found' });
    if (!event_ids || !Array.isArray(event_ids) || event_ids.length === 0) return res.status(400).json({ error: 'event_ids 필수' });

    const maxSort = await db.get('SELECT MAX(sort_order) AS m FROM joint_group_member WHERE joint_group_id=?', g.id);
    let nextSort = (maxSort?.m || 0) + 1;
    const existingMembers = await db.all('SELECT event_id FROM joint_group_member WHERE joint_group_id=?', g.id).map(m => m.event_id);

    let added = 0;
    await db.transaction(async () => {
        for (const eid of event_ids) {
            const evt = await db.get('SELECT * FROM event WHERE id=?', eid);
            if (!evt) continue;
            if (existingMembers.includes(eid)) continue;
            await db.run('INSERT OR IGNORE INTO joint_group_member (joint_group_id, event_id, competition_id, sort_order) VALUES (?, ?, ?, ?)', g.id, eid, evt.competition_id, nextSort++);
            // Add event_link pairs with all existing members
            for (const existId of existingMembers) {
                const [idA, idB] = eid < existId ? [eid, existId] : [existId, eid];
                await db.run('INSERT OR IGNORE INTO event_link (event_id_a, event_id_b, joint_scoreboard_key) VALUES (?, ?, ?)', idA, idB, g.joint_scoreboard_key || '');
            }
            existingMembers.push(eid);
            added++;
        }
    })();
    res.json({ success: true, added });
});

/**
 * DELETE /api/joint-groups/:groupId/members/:eventId
 * Remove a single event from a joint group
 */
app.delete('/api/joint-groups/:groupId/members/:eventId', async (req, res) => {
    const { admin_key } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    const gId = parseInt(req.params.groupId), eId = parseInt(req.params.eventId);
    await db.transaction(async () => {
        await db.run('DELETE FROM joint_group_member WHERE joint_group_id=? AND event_id=?', gId, eId);
        // Remove event_link pairs involving this event within the group
        const remaining = await db.all('SELECT event_id FROM joint_group_member WHERE joint_group_id=?', gId).map(m => m.event_id);
        // Remove links between this event and any remaining group member
        // (careful: only remove if no other group links them)
        for (const rId of remaining) {
            const [idA, idB] = eId < rId ? [eId, rId] : [rId, eId];
            // Check if any other group still links these two
            const otherLink = await db.get(`SELECT 1 FROM joint_group_member jgm1
                JOIN joint_group_member jgm2 ON jgm2.joint_group_id=jgm1.joint_group_id AND jgm2.event_id=?
                WHERE jgm1.event_id=? AND jgm1.joint_group_id != ?`, idA, idB, gId);
            if (!otherLink) {
                await db.run('DELETE FROM event_link WHERE event_id_a=? AND event_id_b=?', idA, idB);
            }
        }
        // If group now has < 2 members, delete the whole group
        const count = await db.get('SELECT COUNT(*) AS c FROM joint_group_member WHERE joint_group_id=?', gId).c;
        if (count < 2) {
            await db.run('DELETE FROM joint_group_member WHERE joint_group_id=?', gId);
            await db.run('DELETE FROM joint_group WHERE id=?', gId);
        }
    })();
    res.json({ success: true });
});

/**
 * POST /api/joint-groups/auto-create
 * Auto-create joint groups for competitions by matching event names
 * Body: { admin_key, competition_ids: [id1, id2, ...] }
 */
app.post('/api/joint-groups/auto-create', async (req, res) => {
    const { admin_key, competition_ids } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    if (!competition_ids || competition_ids.length < 2) return res.status(400).json({ error: '최소 2개 대회를 선택하세요.' });

    // Get all events for each competition
    const compEvents = {};
    for (const cid of competition_ids) {
        compEvents[cid] = await db.all('SELECT e.*, c.name as comp_name, c.federation FROM event e JOIN competition c ON c.id=e.competition_id WHERE e.competition_id=? AND e.parent_event_id IS NULL', cid);
    }

    // Group events by name+gender+round_type across competitions
    const eventMap = {};
    for (const cid of competition_ids) {
        for (const evt of compEvents[cid]) {
            const key = `${evt.name}|${evt.gender}|${evt.round_type}`;
            if (!eventMap[key]) eventMap[key] = [];
            eventMap[key].push(evt);
        }
    }

    let created = 0;
    await db.transaction(async () => {
        for (const [key, events] of Object.entries(eventMap)) {
            if (events.length < 2) continue;
            // Check if already grouped
            const eventIds = events.map(e => e.id);
            const existing = await db.get(`SELECT jg.id FROM joint_group jg
                JOIN joint_group_member jgm ON jgm.joint_group_id=jg.id
                WHERE jgm.event_id IN (${eventIds.map(() => '?').join(',')})
                GROUP BY jg.id HAVING COUNT(*)>=2`, ...eventIds);
            if (existing) continue;

            const genderLabel = { M: '남자', F: '여자', X: '혼성' }[events[0].gender] || '';
            const roundLabel = { preliminary: '예선', semifinal: '준결승', final: '결승' }[events[0].round_type] || '';
            const jointKey = `합동 ${genderLabel} ${events[0].name} ${roundLabel}`.trim();

            const gInfo = await db.run('INSERT INTO joint_group (name, joint_scoreboard_key) VALUES (?, ?)', events[0].name, jointKey);
            events.forEach(async (evt, idx) => {
                await db.run('INSERT OR IGNORE INTO joint_group_member (joint_group_id, event_id, competition_id, sort_order) VALUES (?, ?, ?, ?)', gInfo.lastInsertRowid, evt.id, evt.competition_id, idx);
            });
            // backward-compat event_link
            for (let i = 0; i < events.length; i++) {
                for (let j = i + 1; j < events.length; j++) {
                    const [idA, idB] = events[i].id < events[j].id ? [events[i].id, events[j].id] : [events[j].id, events[i].id];
                    await db.run('INSERT OR IGNORE INTO event_link (event_id_a, event_id_b, joint_scoreboard_key) VALUES (?, ?, ?)', idA, idB, jointKey);
                }
            }
            created++;
        }
    })();

    opLog(`합동 그룹 자동 생성: ${created}개 그룹 (대회 ${competition_ids.join(', ')})`, 'admin', 'admin');
    res.json({ success: true, created });
});

/**
 * GET /api/joint-groups/by-event/:eventId
 * Get joint group info for a specific event (for callroom/record pages)
 */
app.get('/api/joint-groups/by-event/:eventId', async (req, res) => {
    const eventId = parseInt(req.params.eventId);
    const membership = await db.all(`
        SELECT jg.*, jgm.sort_order FROM joint_group jg
        JOIN joint_group_member jgm ON jgm.joint_group_id = jg.id
        WHERE jgm.event_id = ?
    `, eventId);
    if (membership.length === 0) return res.json(null);

    // Return all groups this event belongs to, with all their members
    const result = membership.map(async g => {
        const members = await db.all(`
            SELECT jgm.*, e.name as event_name, e.gender, e.round_type, e.category,
                   c.name as comp_name, c.federation
            FROM joint_group_member jgm
            JOIN event e ON e.id = jgm.event_id
            JOIN competition c ON c.id = jgm.competition_id
            WHERE jgm.joint_group_id = ?
            ORDER BY jgm.sort_order
        `, g.id);
        return { ...g, members };
    });
    res.json(result);
});

/**
 * GET /api/joint-groups/:id/entries
 * Get combined entries from all events in a joint group (for callroom view)
 */
app.get('/api/joint-groups/:id/entries', async (req, res) => {
    const gId = parseInt(req.params.id);
    const g = await db.get('SELECT * FROM joint_group WHERE id=?', gId);
    if (!g) return res.status(404).json({ error: 'Joint group not found' });

    const members = await db.all(`
        SELECT jgm.*, e.name as event_name, e.category, e.gender, e.round_type,
               c.name as comp_name, c.federation
        FROM joint_group_member jgm
        JOIN event e ON e.id = jgm.event_id
        JOIN competition c ON c.id = jgm.competition_id
        WHERE jgm.joint_group_id = ?
        ORDER BY jgm.sort_order
    `, gId);

    const allEntries = [];
    for (const m of members) {
        const heat = await db.get('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number LIMIT 1', m.event_id);
        if (!heat) continue;
        const entries = await db.all(`
            SELECT he.lane_number, he.sub_group, ee.id as event_entry_id, ee.status, ee.event_id,
                   a.id as athlete_id, a.name, a.bib_number, a.team, a.gender, a.barcode
            FROM heat_entry he
            JOIN event_entry ee ON ee.id = he.event_entry_id
            JOIN athlete a ON a.id = ee.athlete_id
            WHERE he.heat_id = ?
            ORDER BY he.lane_number
        `, heat.id);
        entries.forEach(e => {
            allEntries.push({
                ...e,
                heat_id: heat.id,
                federation: m.federation || m.comp_name,
                competition_id: m.competition_id,
                comp_name: m.comp_name,
                source_event_id: m.event_id,
            });
        });
    }
    res.json({ group: g, members, entries: allEntries });
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
// GLOBAL ERROR HANDLER — 서버 크래시 방지
// ============================================================
app.use((err, req, res, next) => {
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
// Ensure doc_template table exists
try { db.exec(`CREATE TABLE IF NOT EXISTS doc_template (
    competition_id INTEGER PRIMARY KEY,
    ad_card TEXT DEFAULT '{}',
    start_list TEXT DEFAULT '{}',
    result_sheet TEXT DEFAULT '{}'
)`); } catch(e) {}

// Ensure event_records table exists (per-event NR/DR/CR records)
try { db.exec(`CREATE TABLE IF NOT EXISTS event_records (
    event_id INTEGER PRIMARY KEY,
    records TEXT DEFAULT '{}'
)`); } catch(e) {}

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

function getDocTemplate(compId) {
    const row = db.prepare('SELECT * FROM doc_template WHERE competition_id=?').get(compId);
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

app.get('/api/doc-templates/:compId', (req, res) => {
    res.json(getDocTemplate(req.params.compId));
});

app.post('/api/doc-templates', async (req, res) => {
    const { admin_key, competition_id, templates } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    if (!competition_id || !templates) return res.status(400).json({ error: 'competition_id, templates required' });
    const ad = JSON.stringify(templates.ad_card || {});
    const sl = JSON.stringify(templates.start_list || {});
    const rs = JSON.stringify(templates.result_sheet || {});
    await db.run('INSERT OR REPLACE INTO doc_template (competition_id, ad_card, start_list, result_sheet) VALUES (?, ?, ?, ?)', competition_id, ad, sl, rs);
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
    const ext = path.extname(req.file.originalname) || '.png';
    const destDir = path.join(__dirname, 'public', 'uploads', 'logos');
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    const filename = `logo_${position}_${compId}${ext}`;
    const destPath = path.join(destDir, filename);
    fs.copyFileSync(req.file.path, destPath);
    fs.unlinkSync(req.file.path);

    const publicUrl = `/uploads/logos/${filename}`;

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
    res.json({ success: true, url: publicUrl, path: destPath });
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
// Per-Event Records (NR/DR/CR)
// ============================================================
app.get('/api/event-records/:eventId', async (req, res) => {
    const row = await db.get('SELECT * FROM event_records WHERE event_id=?', req.params.eventId);
    if (!row) return res.json({ event_id: parseInt(req.params.eventId), records: {} });
    try {
        res.json({ event_id: row.event_id, records: JSON.parse(row.records || '{}') });
    } catch(e) {
        res.json({ event_id: row.event_id, records: {} });
    }
});

app.post('/api/event-records', async (req, res) => {
    const { admin_key, event_id, records } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    if (!event_id || !records) return res.status(400).json({ error: 'event_id, records required' });
    await db.run('INSERT OR REPLACE INTO event_records (event_id, records) VALUES (?, ?)', event_id, JSON.stringify(records));
    opLog(`종목별 기록(NR/DR/CR) 저장 event_id=${event_id}`, 'admin', 'admin');
    res.json({ success: true });
});

// ============================================================
// TIMETABLE (시간표) — Excel upload, parse, store, serve
// ============================================================
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

// Migration: UNIQUE 제약에 round 포함 (혼성/10종/5종 등 같은 시간·종목·부별이라도 round가 다르면 별개 행)
// 기존 UNIQUE(competition_id, day, section, time, event_name, category) → UNIQUE(... , round) 로 확장
try {
    const idxRows = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='timetable' AND name='ux_timetable_full'").all();
    if (idxRows.length === 0) {
        // 자동 인덱스(sqlite_autoindex_timetable_1)는 그대로 두면 round 미포함 충돌이 발생하므로 테이블 재구성
        const hasOldAutoIdx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='sqlite_autoindex_timetable_1'").get();
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
app.get('/api/timetable/:compId', async (req, res) => {
    // FIX: time 우선 정렬 (HH:MM 문자열 정렬은 24시간 형식에서 안전), 같은 시간이면 sort_order
    const rows = await db.all('SELECT * FROM timetable WHERE competition_id=? ORDER BY day, time, section, sort_order', req.params.compId);
    // Include competition start_date for auto-day detection
    const comp = await db.get('SELECT start_date FROM competition WHERE id=?', req.params.compId);
    // Group by day
    const days = {};
    rows.forEach(async r => {
        if (!days[r.day]) days[r.day] = { track: [], field: [] };
        const s = r.section === 'field' ? 'field' : 'track';
        // Include result_url from linked event (if any)
        let result_url = null;
        if (r.event_id) {
            const evt = await db.get('SELECT result_url FROM event WHERE id=?', r.event_id);
            if (evt) result_url = evt.result_url || null;
        }
        days[r.day][s].push({ id: r.id, time: r.time, event_name: r.event_name, category: r.category, round: r.round, note: r.note, event_id: r.event_id, callroom_time: r.callroom_time, scheduled_date: r.scheduled_date, result_url });
    });
    res.json({ competition_id: parseInt(req.params.compId), days, start_date: comp ? comp.start_date : null });
});

// Upload timetable Excel
app.post('/api/timetable/upload', upload.single('file'), async (req, res) => {
    try {
        const { competition_id, admin_key } = req.body;
        if (!competition_id) return res.status(400).json({ error: 'competition_id required' });
        if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
        if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });

        const wb = XLSX.readFile(req.file.path);
        const allEntries = [];

        // 대회 시작일을 미리 조회 (날짜 컬럼이 있을 때 day 계산용)
        const _compStartRow = await db.get('SELECT start_date FROM competition WHERE id=?', parseInt(competition_id));
        const _startDateMs = (_compStartRow && _compStartRow.start_date)
            ? new Date(_compStartRow.start_date + 'T00:00:00').getTime() : null;

        // 한국어 날짜 문자열 → YYYY-MM-DD 파싱 (예: "2026. 4. 30(목)" → "2026-04-30")
        function parseKoreanDate(s) {
            if (!s) return null;
            if (s instanceof Date) {
                const y = s.getFullYear(), mo = s.getMonth()+1, dd = s.getDate();
                return `${y}-${String(mo).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;
            }
            const str = s.toString().trim();
            // 숫자(엑셀 시리얼) 처리
            if (/^\d+(\.\d+)?$/.test(str)) {
                const n = parseFloat(str);
                if (n > 25000 && n < 80000) {
                    const d = new Date(Date.UTC(1899, 11, 30) + n * 86400000);
                    const y = d.getUTCFullYear(), mo = d.getUTCMonth()+1, dd = d.getUTCDate();
                    return `${y}-${String(mo).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;
                }
            }
            // "2026. 4. 30(목)" / "2026-04-30" / "2026/4/30" 모두 매칭
            const m = str.match(/(\d{4})[.\-\/]\s*(\d{1,2})[.\-\/]\s*(\d{1,2})/);
            if (m) return `${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`;
            return null;
        }

        // Process each sheet as a day
        wb.SheetNames.forEach((sheetName, idx) => {
            const ws = wb.Sheets[sheetName];
            const data = XLSX.utils.sheet_to_json(ws, { defval: '' });
            // Determine day number from sheet name or index (fallback)
            let sheetDayNum = idx + 1;
            const dayMatch = sheetName.match(/(\d+)/);
            if (dayMatch) sheetDayNum = parseInt(dayMatch[1]);

            data.forEach((row, rowIdx) => {
                // Expected columns: 날짜(date), 구분(section), 시간(time), 종목(event), 부별/종별(category), 라운드(round), 비고(note)
                const section = (row['구분'] || row['section'] || row['Section'] || '').toString().trim().toLowerCase();
                const rawTime = row['시간'] !== undefined ? row['시간'] : (row['time'] !== undefined ? row['time'] : row['Time']);
                // FIX: Excel 시간 셀이 분수(0.4166…)로 들어오는 경우 HH:MM 으로 변환
                const time = excelTimeToHHMM(rawTime);
                const eventName = (row['종목'] || row['event'] || row['Event'] || row['event_name'] || '').toString().trim();
                const category = (row['부별'] || row['종별'] || row['category'] || row['Category'] || '').toString().trim();
                const round = (row['라운드'] || row['round'] || row['Round'] || '').toString().trim();
                const note = (row['비고'] || row['note'] || row['Note'] || '').toString().trim();

                if (!time || !eventName) return; // skip empty rows

                // FIX: 날짜 컬럼이 있으면 day 번호를 행별로 산출 (한 시트에 여러 날짜가 섞인 케이스 지원)
                let dayNum = sheetDayNum;
                let scheduledDate = null;
                const rawDate = row['날짜'] || row['date'] || row['Date'] || row['일자'];
                if (rawDate !== undefined && rawDate !== '') {
                    const ymd = parseKoreanDate(rawDate);
                    if (ymd) {
                        scheduledDate = ymd;
                        if (_startDateMs !== null) {
                            const rowMs = new Date(ymd + 'T00:00:00').getTime();
                            const diff = Math.round((rowMs - _startDateMs) / 86400000) + 1;
                            if (diff >= 1 && diff <= 30) dayNum = diff;
                        }
                    }
                }

                const sec = (section.includes('필드') || section.includes('field')) ? 'field' : 'track';
                allEntries.push({
                    competition_id: parseInt(competition_id),
                    day: dayNum,
                    section: sec,
                    time: time,
                    event_name: eventName,
                    category: category,
                    round: round,
                    note: note,
                    sort_order: rowIdx,
                    scheduled_date: scheduledDate || undefined
                });
            });
        });

        if (allEntries.length === 0) {
            // Clean up temp file
            try { fs.unlinkSync(req.file.path); } catch(e) {}
            return res.status(400).json({ error: '시간표 데이터가 없습니다. 엑셀 형식을 확인하세요.' });
        }

        // Determine which days are in the uploaded file
        const uploadedDays = [...new Set(allEntries.map(e => e.day))].sort((a, b) => a - b);

        // ─── OPTION C: PRESERVE PAST + DIFF MERGE FOR FUTURE/TODAY ───
        const todayStr = new Date().toISOString().split('T')[0];
        const overwriteMode = req.body.overwrite_mode || 'smart'; // 'smart' (default) | 'force'

        // Compute scheduled_date for each entry (based on competition start_date)
        const compRow = await db.get('SELECT start_date FROM competition WHERE id=?', parseInt(competition_id));
        if (compRow && compRow.start_date) {
            const startDate = new Date(compRow.start_date + 'T00:00:00');
            allEntries.forEach(e => {
                const dd = new Date(startDate);
                dd.setDate(dd.getDate() + e.day - 1);
                e.scheduled_date = dd.toISOString().split('T')[0];
            });
        }

        // Filter out past-day entries unless force mode
        let filteredEntries = allEntries;
        let skippedPastDays = [];
        if (overwriteMode !== 'force') {
            const pastDaysSet = new Set();
            filteredEntries = allEntries.filter(e => {
                if (e.scheduled_date && e.scheduled_date < todayStr) {
                    pastDaysSet.add(e.day);
                    return false;
                }
                return true;
            });
            skippedPastDays = [...pastDaysSet].sort((a, b) => a - b);
        }
        const effectiveDays = [...new Set(filteredEntries.map(e => e.day))].sort((a, b) => a - b);

        let mergeStats = { addedCount: 0, updatedCount: 0, deletedCount: 0, preservedCount: 0 };

        if (overwriteMode === 'force') {
            // LEGACY: full delete for uploaded days
            await db.transaction(async () => {
                for (const d of uploadedDays) {
                    await db.run('DELETE FROM timetable WHERE competition_id=? AND day=?', parseInt(competition_id), d);
                }
                for (const e of allEntries) {
                    await db.run('INSERT INTO timetable (competition_id, day, section, time, event_name, category, round, note, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                        e.competition_id, e.day, e.section, e.time, e.event_name, e.category, e.round, e.note, e.sort_order);
                }
            })();
            mergeStats.addedCount = allEntries.length;
        } else {
            // SMART MERGE: 행 단위 diff (과거 일차 보존)
            const INSERT_SQL = 'INSERT INTO timetable (competition_id, day, section, time, event_name, category, round, note, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)';
            const UPDATE_SQL = 'UPDATE timetable SET section=?, note=?, sort_order=? WHERE id=?';
            const DELETE_ONE_SQL = 'DELETE FROM timetable WHERE id=?';

            const tx = db.transaction(async () => {
                for (const day of effectiveDays) {
                    const existingRows = await db.all('SELECT * FROM timetable WHERE competition_id=? AND day=?', parseInt(competition_id), day);

                    // Safety: skip if past day
                    const sampleRow = existingRows[0];
                    if (sampleRow && sampleRow.scheduled_date && sampleRow.scheduled_date < todayStr) {
                        mergeStats.preservedCount += existingRows.length;
                        continue;
                    }

                    const buildKey = (r) => `${r.time||''}|${(r.event_name||'').trim()}|${(r.category||'').trim()}|${(r.round||'').trim()}`;
                    const existingByKey = new Map();
                    existingRows.forEach(r => {
                        const k = buildKey(r);
                        if (!existingByKey.has(k)) existingByKey.set(k, []);
                        existingByKey.get(k).push(r);
                    });

                    const newEntries = filteredEntries.filter(e => e.day === day);
                    const matchedIds = new Set();

                    for (const e of newEntries) {
                        const k = buildKey(e);
                        const candidates = existingByKey.get(k);
                        if (candidates && candidates.length > 0) {
                            const target = candidates.shift();
                            matchedIds.add(target.id);
                            await db.run(UPDATE_SQL, e.section, e.note || target.note, e.sort_order, target.id);
                            mergeStats.updatedCount++;
                        } else {
                            await db.run(INSERT_SQL, e.competition_id, e.day, e.section, e.time, e.event_name, e.category, e.round, e.note, e.sort_order);
                            mergeStats.addedCount++;
                        }
                    }

                    for (const r of existingRows) {
                        if (!matchedIds.has(r.id)) {
                            await db.run(DELETE_ONE_SQL, r.id);
                            mergeStats.deletedCount++;
                        }
                    }
                }

                if (skippedPastDays.length > 0) {
                    const cnt = await db.get(`SELECT COUNT(*) AS c FROM timetable WHERE competition_id=? AND day IN (${skippedPastDays.map(()=>'?').join(',')})`, parseInt(competition_id), ...skippedPastDays);
                    mergeStats.preservedCount += (cnt && cnt.c) || 0;
                }
            });
            await tx();
        }

        // Auto-link timetable entries to events
        try {
            autoLinkTimetable(parseInt(competition_id));
        } catch(linkErr) {
            console.warn('Timetable auto-link warning:', linkErr.message);
        }

        // Auto-compute callroom_time (WA standard: 30 min before event time for track, 45 min for field)
        try {
            const crStmt = db.prepare('UPDATE timetable SET callroom_time=? WHERE id=? AND callroom_time IS NULL');
            const needCR = await db.all('SELECT id, time, section FROM timetable WHERE competition_id=? AND callroom_time IS NULL', parseInt(competition_id));
            needCR.forEach(tt => {
                const m = (tt.time || '').match(/^(\d{1,2}):(\d{2})/);
                if (!m) return;
                let h = parseInt(m[1]), min = parseInt(m[2]);
                const offset = (tt.section === 'field') ? 45 : 30; // WA standard offsets
                min -= offset;
                while (min < 0) { min += 60; h -= 1; }
                if (h < 0) return; // invalid
                const crTime = String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
                crStmt.run(crTime, tt.id);
            });
        } catch(crErr) {
            console.warn('Callroom time auto-compute warning:', crErr.message);
        }

        // Compute scheduled_date for any rows still missing it
        try {
            const comp = await db.get('SELECT start_date FROM competition WHERE id=?', parseInt(competition_id));
            if (comp && comp.start_date) {
                const startDate = new Date(comp.start_date + 'T00:00:00');
                const updateDateStmt = db.prepare('UPDATE timetable SET scheduled_date=? WHERE competition_id=? AND day=? AND scheduled_date IS NULL');
                effectiveDays.forEach(d => {
                    const dayDate = new Date(startDate);
                    dayDate.setDate(dayDate.getDate() + d - 1);
                    const dateStr = dayDate.toISOString().split('T')[0];
                    updateDateStmt.run(dateStr, parseInt(competition_id), d);
                });
            }
        } catch(dateErr) {
            console.warn('Timetable date computation warning:', dateErr.message);
        }

        // Clean up temp file
        try { fs.unlinkSync(req.file.path); } catch(e) {}

        // Build human-readable message
        let msg;
        if (overwriteMode === 'force') {
            msg = `[강제덮어쓰기] ${effectiveDays.map(d=>d+'일차').join(', ')} 시간표 ${allEntries.length}건 등록됨`;
        } else {
            const parts = [];
            if (mergeStats.addedCount) parts.push(`추가 ${mergeStats.addedCount}`);
            if (mergeStats.updatedCount) parts.push(`수정 ${mergeStats.updatedCount}`);
            if (mergeStats.deletedCount) parts.push(`삭제 ${mergeStats.deletedCount}`);
            if (skippedPastDays.length > 0) parts.push(`과거 ${skippedPastDays.map(d=>d+'일차').join('·')} 보존`);
            msg = `[스마트머지] ${parts.join(' · ') || '변경 없음'}`;
        }

        opLog(`시간표 업로드 (대회ID=${competition_id}, ${msg})`, 'admin', 'admin');
        res.json({
            success: true,
            count: filteredEntries.length,
            days: effectiveDays,
            skippedPastDays,
            mode: overwriteMode,
            ...mergeStats,
            message: msg
        });
    } catch(e) {
        console.error('Timetable upload error:', e);
        try { if (req.file) fs.unlinkSync(req.file.path); } catch(ex) {}
        res.status(500).json({ error: '시간표 업로드 실패: ' + e.message });
    }
});

// Delete timetable for a competition (all days)
app.delete('/api/timetable/:compId', async (req, res) => {
    const { admin_key } = req.body || {};
    if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
    await db.run('DELETE FROM timetable WHERE competition_id=?', req.params.compId);
    opLog(`시간표 전체 삭제 (대회ID=${req.params.compId})`, 'admin', 'admin');
    res.json({ success: true });
});

// Delete timetable for a specific day
app.delete('/api/timetable/:compId/:day', async (req, res) => {
    const { admin_key } = req.body || {};
    if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
    const { compId, day } = req.params;
    await db.run('DELETE FROM timetable WHERE competition_id=? AND day=?', compId, parseInt(day));
    opLog(`시간표 ${day}일차 삭제 (대회ID=${compId})`, 'admin', 'admin');
    res.json({ success: true });
});

// Manual link: connect timetable entry to event
app.put('/api/timetable/:id/link', async (req, res) => {
    const { admin_key, event_id } = req.body || {};
    if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
    if (!event_id) return res.status(400).json({ error: 'event_id required' });
    const tt = await db.get('SELECT * FROM timetable WHERE id=?', req.params.id);
    if (!tt) return res.status(404).json({ error: '시간표 항목 없음' });
    // Prevent duplicate: check if this event_id is already linked to another timetable entry in the same competition
    const existing = await db.get('SELECT id FROM timetable WHERE competition_id=? AND event_id=? AND id!=?', tt.competition_id, event_id, req.params.id);
    if (existing) return res.status(400).json({ error: '이 종목은 이미 다른 시간표 항목에 연결되어 있습니다.' });
    await db.run('UPDATE timetable SET event_id=? WHERE id=?', event_id, req.params.id);
    // Auto-compute callroom_time if not set
    if (!tt.callroom_time && tt.time) {
        const m = tt.time.match(/^(\d{1,2}):(\d{2})/);
        if (m) {
            let h = parseInt(m[1]), min = parseInt(m[2]);
            const offset = (tt.section === 'field') ? 45 : 30;
            min -= offset;
            while (min < 0) { min += 60; h -= 1; }
            if (h >= 0) {
                const crTime = String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
                await db.run('UPDATE timetable SET callroom_time=? WHERE id=?', crTime, req.params.id);
            }
        }
    }
    res.json({ success: true });
});

// Manual unlink: disconnect timetable entry from event
app.put('/api/timetable/:id/unlink', async (req, res) => {
    const { admin_key } = req.body || {};
    if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
    await db.run('UPDATE timetable SET event_id=NULL WHERE id=?', req.params.id);
    res.json({ success: true });
});

// Edit single timetable entry (inline edit from display-manage)
// Allows editing: time, event_name, category(jongbyul), round, note, callroom_time, section, day, scheduled_date
app.put('/api/timetable/entry/:id', async (req, res) => {
    try {
        const { admin_key, time, event_name, category, round, note, callroom_time, section, day, scheduled_date, event_id } = req.body || {};
        if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
        const tt = await db.get('SELECT * FROM timetable WHERE id=?', req.params.id);
        if (!tt) return res.status(404).json({ error: '시간표 항목 없음' });

        const fields = [];
        const values = [];
        const setIf = (col, val) => { if (val !== undefined) { fields.push(`${col}=?`); values.push(val); } };
        setIf('time', time);
        setIf('event_name', event_name);
        setIf('category', category);
        setIf('round', round);
        setIf('note', note);
        setIf('callroom_time', callroom_time);
        setIf('section', section);
        setIf('day', day !== undefined ? parseInt(day) : undefined);
        setIf('scheduled_date', scheduled_date);
        if (event_id !== undefined) {
            // event_id can be null to unlink
            fields.push('event_id=?');
            values.push(event_id || null);
        }
        if (fields.length === 0) return res.status(400).json({ error: '수정할 필드가 없습니다.' });

        values.push(req.params.id);
        await db.run(`UPDATE timetable SET ${fields.join(', ')} WHERE id=?`, ...values);

        // If time changed and callroom_time wasn't explicitly provided, recompute it
        if (time !== undefined && callroom_time === undefined) {
            const updated = await db.get('SELECT * FROM timetable WHERE id=?', req.params.id);
            const m = (updated.time || '').match(/^(\d{1,2}):(\d{2})/);
            if (m) {
                let h = parseInt(m[1]), min = parseInt(m[2]);
                const offset = (updated.section === 'field') ? 45 : 30;
                min -= offset;
                while (min < 0) { min += 60; h -= 1; }
                if (h >= 0) {
                    const crTime = String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
                    await db.run('UPDATE timetable SET callroom_time=? WHERE id=?', crTime, req.params.id);
                }
            }
        }

        opLog(`시간표 항목 수정 (ID=${req.params.id}, 대회ID=${tt.competition_id})`, 'admin', 'admin', tt.competition_id);
        res.json({ success: true });
    } catch(e) {
        console.error('Timetable entry edit error:', e);
        res.status(500).json({ error: '수정 실패: ' + e.message });
    }
});

// Add new timetable entry (single row)
app.post('/api/timetable/entry', async (req, res) => {
    try {
        const { admin_key, competition_id, day, section, time, event_name, category, round, note, callroom_time, scheduled_date } = req.body || {};
        if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
        if (!competition_id) return res.status(400).json({ error: 'competition_id required' });
        if (!day || !time || !event_name) return res.status(400).json({ error: 'day, time, event_name 필수' });

        // Compute scheduled_date if not provided
        let schedDate = scheduled_date || null;
        if (!schedDate) {
            const comp = await db.get('SELECT start_date FROM competition WHERE id=?', parseInt(competition_id));
            if (comp && comp.start_date) {
                const d = new Date(comp.start_date + 'T00:00:00');
                d.setDate(d.getDate() + parseInt(day) - 1);
                schedDate = d.toISOString().split('T')[0];
            }
        }

        // Compute callroom_time if not provided
        let cr = callroom_time || null;
        if (!cr && time) {
            const m = time.match(/^(\d{1,2}):(\d{2})/);
            if (m) {
                let h = parseInt(m[1]), min = parseInt(m[2]);
                const offset = (section === 'field') ? 45 : 30;
                min -= offset;
                while (min < 0) { min += 60; h -= 1; }
                if (h >= 0) cr = String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
            }
        }

        // Get next sort_order for the day
        const maxSort = await db.get('SELECT MAX(sort_order) AS m FROM timetable WHERE competition_id=? AND day=?', parseInt(competition_id), parseInt(day));
        const sortOrder = (maxSort && maxSort.m !== null ? maxSort.m : -1) + 1;

        const result = await db.run(`INSERT INTO timetable
            (competition_id, day, section, time, event_name, category, round, note, sort_order, callroom_time, scheduled_date)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, parseInt(competition_id), parseInt(day), section || 'track', time, event_name, category || '', round || '', note || '', sortOrder, cr, schedDate);
        opLog(`시간표 항목 추가 (대회ID=${competition_id}, ${day}일차, ${event_name})`, 'admin', 'admin', parseInt(competition_id));
        res.json({ success: true, id: result.lastInsertRowid });
    } catch(e) {
        console.error('Timetable entry add error:', e);
        res.status(500).json({ error: '추가 실패: ' + e.message });
    }
});

// Delete single timetable entry
app.delete('/api/timetable/entry/:id', async (req, res) => {
    try {
        const adminKey = req.body?.admin_key || req.query?.admin_key || req.headers['x-admin-key'];
        if (!isOperationKey(adminKey) && !isAdminKey(adminKey)) return res.status(403).json({ error: '권한 없음' });
        const tt = await db.get('SELECT * FROM timetable WHERE id=?', req.params.id);
        if (!tt) return res.status(404).json({ error: '시간표 항목 없음' });
        await db.run('DELETE FROM timetable WHERE id=?', req.params.id);
        opLog(`시간표 항목 삭제 (ID=${req.params.id}, 대회ID=${tt.competition_id}, ${tt.event_name})`, 'admin', 'admin', tt.competition_id);
        res.json({ success: true });
    } catch(e) {
        console.error('Timetable entry delete error:', e);
        res.status(500).json({ error: '삭제 실패: ' + e.message });
    }
});

// ---- Shared timetable auto-link function ----
function autoLinkTimetable(compId) {
    const compEvents = db.prepare('SELECT id, name, gender, category, round_type FROM event WHERE competition_id=? AND parent_event_id IS NULL').all(compId);
    const linkStmt = db.prepare('UPDATE timetable SET event_id=?, event_ids=? WHERE id=?');
    const ttRows = db.prepare('SELECT id, event_name, category, round FROM timetable WHERE competition_id=? AND event_id IS NULL').all(compId);

    // Determine competition federation and division_type (for A6 filtering)
    const comp = db.prepare('SELECT federation, division_type FROM competition WHERE id=?').get(compId);
    const federation = (comp && comp.federation) || '';
    const divisionType = (comp && comp.division_type) || '';

    // Normalize: lowercase, remove all whitespace, unify × → x, X → x
    function norm(s) { return (s || '').replace(/\s+/g, '').toLowerCase().replace(/×/g, 'x').replace(/X/g, 'x'); }

    // Extract division info from category: "대학(남)" → { divisions: ['대학'], genders: ['M'] }
    // "대학/실업(여)" → { divisions: ['대학','실업'], genders: ['F'] }
    // "대학(남)/실업(남,여)" → { divisions: ['대학','실업'], genders: ['M','F'] }
    function parseCategory(cat) {
        if (!cat) return { divisions: [], genders: [] };
        const genders = new Set();
        const divisions = new Set();
        
        // Split by "/" to handle "대학(남)/실업(남,여)"
        const parts = cat.split('/');
        for (const part of parts) {
            const divMatch = part.match(/^(대학|실업|초등|중등|고등|일반)/);
            if (divMatch) divisions.add(divMatch[1]);
            
            const genderMatch = part.match(/\(([남여혼성,]+)\)/);
            if (genderMatch) {
                const inner = genderMatch[1];
                if (inner.includes('남')) genders.add('M');
                if (inner.includes('여')) genders.add('F');
                if (inner.includes('혼성')) genders.add('X');
            }
        }
        return { divisions: [...divisions], genders: [...genders] };
    }

    // A6: Check if timetable category is applicable to this competition's federation/division
    // KTFL (실업) or division_type=pro → skip "대학" only items
    // KUAF (대학) or division_type=univ → skip "실업" only items
    function isDivisionMatch(parsedCat) {
        if (parsedCat.divisions.length === 0) return true; // No division specified → always match
        
        // Map federation OR division_type to allowed divisions
        const fedLower = federation.toLowerCase();
        let myDiv = null;
        if (fedLower.includes('ktfl') || fedLower.includes('실업') || divisionType === 'pro') myDiv = '실업';
        else if (fedLower.includes('kuaf') || fedLower.includes('대학') || divisionType === 'univ') myDiv = '대학';
        else if (divisionType === 'high') myDiv = '고등';
        else if (divisionType === 'middle') myDiv = '중등';
        else if (divisionType === 'general') myDiv = '일반';
        
        if (!myDiv) return true; // Unknown federation/division → allow all
        
        // If the timetable row ONLY has the OTHER division, skip it
        // e.g., KTFL competition + "대학(남)" only → skip
        // e.g., KTFL competition + "대학/실업(남)" → allow (includes 실업)
        return parsedCat.divisions.includes(myDiv);
    }

    // Parse round from timetable: handle "결승", "4-1+4", "10종(3)", "결승2조", "결승(A,B)" etc.
    function parseRound(roundStr, eventName) {
        const r = (roundStr || '').trim();
        // Combined event sub-events: "10종(N)" or "7종(N)"
        if (/^[17]0?종\(\d+\)/.test(r)) return { round: 'final', isCombinedSub: true, combinedType: r.startsWith('10') || r.startsWith('7') ? r.match(/^(\d+종)/)[1] : null };
        // Preliminary patterns: "N-N+N" format
        if (/^\d+-\d+\+\d+$/.test(r)) return { round: 'preliminary' };
        // Final variants: "결승", "결승2조", "결승(A,B)"
        if (r.startsWith('결승') || r === 'final') return { round: 'final' };
        if (r === '예선' || r === 'preliminary') return { round: 'preliminary' };
        if (r === '준결승' || r === '준결' || r === 'semifinal') return { round: 'semifinal' };
        // Default: final
        return { round: 'final' };
    }

    let linked = 0;
    ttRows.forEach(tt => {
        const parsed = parseRound(tt.round, tt.event_name);
        const ttRound = parsed.round;
        const catInfo = parseCategory(tt.category);

        // A6: Skip if division doesn't match this competition's federation
        if (!isDivisionMatch(catInfo)) return;

        // For combined sub-events (10종/7종), match to the combined event
        let targetName = tt.event_name;
        if (parsed.isCombinedSub) {
            if (parsed.combinedType === '10종') targetName = '10종경기';
            else if (parsed.combinedType === '7종') targetName = '7종경기';
        }

        const ttNorm = norm(targetName);
        
        // A7: Find ALL matching events (for multi-gender entries like "경보 남녀 동시출발")
        const matches = compEvents.filter(ev => {
            if (ev.round_type !== ttRound) return false;
            // Name match (normalized: spaces removed, ×→x, case insensitive)
            const nameOk = norm(ev.name) === ttNorm;
            if (!nameOk) return false;
            // Gender match
            if (catInfo.genders.length > 0) {
                if (!catInfo.genders.includes(ev.gender)) return false;
            }
            return true;
        });
        
        if (matches.length > 0) {
            // Primary link: first match (for backward compatibility with event_id)
            const primaryId = matches[0].id;
            const allIds = matches.map(m => m.id);
            const eventIdsJson = allIds.length > 1 ? JSON.stringify(allIds) : null;
            linkStmt.run(primaryId, eventIdsJson, tt.id);
            linked++;
        }
    });
    return { linked, total: ttRows.length };
}

// Re-run auto-matching for a competition's timetable
app.post('/api/timetable/:compId/rematch', async (req, res) => {
    const { admin_key } = req.body || {};
    if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
    const compId = parseInt(req.params.compId);
    // Clear existing links first so we can re-match everything
    await db.run('UPDATE timetable SET event_id=NULL WHERE competition_id=?', compId);
    const result = autoLinkTimetable(compId);
    res.json({ success: true, linked: result.linked, total: result.total });
});

// GET today's scheduled events (for monitor/app notifications)
app.get('/api/timetable/:compId/today', async (req, res) => {
    const compId = req.params.compId;
    const today = new Date().toISOString().split('T')[0];
    
    // Try to find rows by scheduled_date first, then fall back to day-based lookup
    let rows = await db.all('SELECT t.*, e.round_status as event_round_status, e.id as linked_event_id FROM timetable t LEFT JOIN event e ON t.event_id = e.id WHERE t.competition_id=? AND t.scheduled_date=? ORDER BY t.sort_order, t.time', compId, today);
    
    if (rows.length === 0) {
        // Fall back: determine day from competition start_date
        const comp = await db.get('SELECT start_date FROM competition WHERE id=?', compId);
        if (comp && comp.start_date) {
            const start = new Date(comp.start_date + 'T00:00:00');
            const now = new Date(today + 'T00:00:00');
            const dayNum = Math.floor((now - start) / (24 * 60 * 60 * 1000)) + 1;
            if (dayNum > 0) {
                rows = await db.all('SELECT t.*, e.round_status as event_round_status, e.id as linked_event_id FROM timetable t LEFT JOIN event e ON t.event_id = e.id WHERE t.competition_id=? AND t.day=? ORDER BY t.sort_order, t.time', compId, dayNum);
            }
        }
    }
    
    res.json(rows.map(r => ({
        id: r.id,
        time: r.time,
        event_name: r.event_name,
        category: r.category,
        round: r.round,
        section: r.section,
        note: r.note,
        event_id: r.event_id || r.linked_event_id,
        callroom_time: r.callroom_time,
        scheduled_date: r.scheduled_date,
        event_round_status: r.event_round_status
    })));
});

// GET timetable schedule info for events (for matrix dot indicators)
app.get('/api/timetable/:compId/event-schedule', async (req, res) => {
    const compId = req.params.compId;
    const today = new Date().toISOString().split('T')[0];
    const rows = await db.all(`SELECT t.event_id, t.event_ids, t.time, t.callroom_time, t.scheduled_date, t.event_name, t.round, t.day, e.round_status
         FROM timetable t LEFT JOIN event e ON t.event_id = e.id
         WHERE t.competition_id=? AND t.event_id IS NOT NULL
         ORDER BY t.scheduled_date, t.time`, compId);
    // Return a map: event_id -> schedule info
    // A7: Also map additional event_ids from multi-linked rows
    const schedule = {};
    rows.forEach(r => {
        const info = {
            time: r.time,
            callroom_time: r.callroom_time,
            scheduled_date: r.scheduled_date,
            day: r.day,
            is_today: r.scheduled_date === today,
            round_status: r.round_status
        };
        schedule[r.event_id] = info;
        // A7: If event_ids JSON exists, map all additional events to same schedule
        if (r.event_ids) {
            try {
                const ids = JSON.parse(r.event_ids);
                if (Array.isArray(ids)) {
                    ids.forEach(id => { if (!schedule[id]) schedule[id] = info; });
                }
            } catch(e) {}
        }
    });
    res.json(schedule);
});

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
    const logoLeft = tpl.logo_left || '';
    const logoRight = tpl.logo_right || '';
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
    const rowH = Math.max(20, fontSize + 10);
    const { boldCols = [], highlight = false } = opts;

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
        pdfFont(doc, isBold).fontSize(fontSize).fillColor('#000');
        doc.text(String(val), col.x + 2, y + (rowH - fontSize) / 2, { width: col.w - 4, align: 'center' });
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
    const tpl = getDocTemplate(event.competition_id).start_list;

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
            ORDER BY he.lane_number ASC, CAST(a.bib_number AS INTEGER)
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
    const tpl = getDocTemplate(event.competition_id).result_sheet;

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

    let curY = margin;

    // Header with logos
    if (tpl.show_header !== false) {
        curY = drawPdfHeader(doc, comp, tpl, pageW, margin);
    }

    // "OFFICIAL RESULT" label (green)
    pdfFont(doc, true).fontSize(11).fillColor(PR_GREEN);
    doc.text('OFFICIAL RESULT', margin, curY, { width: pageW - margin * 2 });
    curY += 16;

    // Event title
    pdfFont(doc, true).fontSize(12).fillColor('#000');
    doc.text(`${gK}  ${event.name}`, margin, curY);
    curY += 18;

    // Round / Date bar
    const barH = 22;
    doc.save();
    doc.rect(margin, curY, 80, barH).fill('#1a1a1a');
    pdfFont(doc, true).fontSize(9).fillColor('#fff');
    doc.text(roundL, margin + 4, curY + 6, { width: 72, align: 'center' });
    doc.restore();
    pdfFont(doc, false).fontSize(9).fillColor('#333');
    doc.text(comp ? comp.start_date : '', margin + 88, curY + 6);
    doc.save();
    doc.moveTo(margin, curY).lineTo(pageW - margin, curY).lineWidth(0.5).stroke('#333');
    doc.moveTo(margin, curY + barH).lineTo(pageW - margin, curY + barH).lineWidth(0.5).stroke('#333');
    doc.restore();
    curY += barH + 8;

    // ============================================================
    // COMBINED EVENT (10종/7종) — completely different layout
    // ============================================================
    if (isCombined) {
        const subEvents = await db.all('SELECT * FROM event WHERE parent_event_id=? ORDER BY sort_order, id', event.id);
        const heat = heats[0];
        if (!heat) { doc.end(); return; }
        const entries = await db.all(`
            SELECT he.lane_number, ee.id AS event_entry_id, ee.status, ee.athlete_id,
                   a.name, a.bib_number, a.team
            FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id
            JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=?
            ORDER BY he.lane_number ASC
        `, heat.id);

        // Build sub-event short names for columns
        const subLabels = subEvents.map(se => {
            let n = se.name.replace(/\[.*?\]\s*/, '');
            if (n.length > 5) n = n.substring(0, 5);
            return n;
        });

        // Gather all combined_scores and sub-event results for each athlete
        const athleteData = entries.map(async e => {
            const scores = await db.all('SELECT * FROM combined_score WHERE event_entry_id=? ORDER BY sub_event_order', e.event_entry_id);
            let totalPoints = 0;
            const subScores = [];
            for (let i = 0; i < subEvents.length; i++) {
                const se = subEvents[i];
                const sc = scores.find(s => s.sub_event_order === i + 1) || null;
                let rawRecord = null; let wind = null; let points = 0;
                if (sc) {
                    rawRecord = sc.raw_record;
                    points = sc.wa_points || 0;
                    totalPoints += points;
                } else {
                    // Try to get from sub-event's result table
                    const subHeat = await db.get('SELECT id FROM heat WHERE event_id=?', se.id);
                    if (subHeat) {
                        const subEE = await db.get('SELECT id FROM event_entry WHERE event_id=? AND athlete_id=?', se.id, e.athlete_id);
                        if (subEE) {
                            const subRes = await db.get('SELECT * FROM result WHERE heat_id=? AND event_entry_id=? ORDER BY attempt_number LIMIT 1', subHeat.id, subEE.id);
                            if (subRes) {
                                const isST = se.category === 'track' || se.category === 'road' || se.category === 'relay';
                                rawRecord = isST ? subRes.time_seconds : subRes.distance_meters;
                                wind = subRes.wind;
                            }
                            // For field_height, get best cleared height
                            if (se.category === 'field_height') {
                                const best = await db.get("SELECT MAX(bar_height) AS best FROM height_attempt WHERE heat_id=? AND event_entry_id=? AND result_mark='O'", subHeat.id, subEE.id);
                                if (best && best.best) rawRecord = best.best;
                            }
                            // For field_distance, get best attempt
                            if (se.category === 'field_distance' && !rawRecord) {
                                const bestD = await db.get('SELECT MAX(distance_meters) AS best FROM result WHERE heat_id=? AND event_entry_id=? AND distance_meters IS NOT NULL', subHeat.id, subEE.id);
                                if (bestD && bestD.best) rawRecord = bestD.best;
                            }
                        }
                    }
                }
                subScores.push({ rawRecord, wind, points, subEvent: se });
            }
            // Check for DNF status
            const status = await db.get("SELECT status_code FROM result WHERE heat_id=? AND event_entry_id=? AND status_code IN ('DNF','DNS','DQ') LIMIT 1", heat.id, e.event_entry_id);
            let statusCode = status?.status_code || '';
            // Fallback: if entry status is no_show and no explicit DNS result, treat as DNS
            if (!statusCode && e.status === 'no_show') statusCode = 'DNS';
            // 0 points with no explicit status → DNF
            if (!statusCode && totalPoints === 0) statusCode = 'DNF';
            return { ...e, subScores, totalPoints, status_code: statusCode };
        });

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
        pdfFont(doc, false).fontSize(5.5).fillColor('#888');
        for (let i = 0; i < subEvents.length; i++) {
            const se = subEvents[i];
            if (se.category === 'track' || se.category === 'field_distance') {
                // Show 'WIND' label for wind-affected sub-events
            }
        }
        doc.text('WIND', comCols[4 + Math.floor(subEvents.length / 2)]?.x || tableLeft + totalW * 0.5, curY + 3, { width: 40 });
        doc.restore();
        curY += windRowH;

        // Render each athlete (3 rows: record, points, wind)
        let rank = 0;
        for (const ath of athleteData) {
            const rowH3 = 42; // 3 sub-rows * 14px each
            if (curY + rowH3 > pageH - margin - 80) {
                doc.addPage(); curY = margin;
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

            // Row 3: wind
            const y3 = curY + subRowH * 2;
            pdfFont(doc, false).fontSize(5).fillColor('#999');
            for (let i = 0; i < ath.subScores.length; i++) {
                const sc = ath.subScores[i];
                const col = comCols[4 + i];
                if (col && sc.wind != null) {
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
        const athleteData = entries.map(async e => {
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
            if (bestCleared === null && !status) {
                const bestR = results.find(r => r.distance_meters != null);
                if (bestR) bestCleared = bestR.distance_meters;
            }
            return { ...e, bestCleared, totalMisses, missesAtBest, heightResults, status_code: status };
        });

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
            if (curY + Math.max(20, hFS + 10) > pageH - margin - 80) {
                doc.addPage(); curY = margin;
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
            if (curY + Math.max(20, hFS + 10) > pageH - margin - 80) break;
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
                        if (r.status_code === 'X' || r.status_code === 'FOUL') {
                            attempts.push({ dist: null, wind: r.wind, foul: true, pass: false });
                        } else if (r.status_code === '-' || r.status_code === 'PASS') {
                            attempts.push({ dist: null, wind: null, foul: false, pass: true });
                        } else if (r.distance_meters != null) {
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
                if (!status && best === null && recs.length > 0 && recs.every(r => r.status_code === 'X' || r.status_code === 'FOUL')) {
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
                if (curY + 80 > pageH - margin - 80) { doc.addPage(); curY = margin; }
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
                if (curY + rowH > pageH - margin - 80) {
                    doc.addPage(); curY = margin;
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
                if (curY + neededH > pageH - margin - 80) { doc.addPage(); curY = margin; }
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
                if (curY + dataRowH2 > pageH - margin - 80) {
                    doc.addPage(); curY = margin;
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
                curY = drawTableRow(doc, rsCols, vals, curY, tableLeft, tableRight, fontSize, { boldCols: ['name', 'record'] });
            }
            curY += 8;
        }
    }

    // Legend line
    curY += 4;
    pdfFont(doc, false).fontSize(7).fillColor('#555');
    doc.text('DQ=실격  DNS=경기불참  DNF=중도기권  NM=기록없음  Q=순위통과  q=기록통과', margin, curY);
    curY += 12;

    // Signature section (conditional) — aligned to table edges
    if (tpl.show_signature !== false) {
        if (curY > pageH - margin - 100) { doc.addPage(); curY = margin; }
        curY += 10;
        pdfFont(doc, false).fontSize(8.5).fillColor('#333');
        const recName = tpl.recorder_name || '';
        const chiefName = tpl.chief_recorder_name || '';
        const sigLineW = 150;
        doc.text(`기록자 :    ${recName}`, tableLeft, curY);
        const chiefX = tableRight - sigLineW;
        doc.text(`기록주임 :    ${chiefName}`, chiefX, curY);
        curY += 16;
        doc.moveTo(tableLeft, curY).lineTo(tableLeft + sigLineW, curY).lineWidth(0.5).stroke('#999');
        doc.moveTo(chiefX, curY).lineTo(tableRight, curY).lineWidth(0.5).stroke('#999');
        curY += 18;
    }

    // NR/DR/CR Records table (conditional) — per-event records with global fallback
    if (tpl.show_records_table !== false) {
        if (curY > pageH - margin - 100) { doc.addPage(); curY = margin; }
        // Load per-event records from event_records table
        const evtRecRow = await db.get('SELECT records FROM event_records WHERE event_id=?', event.id);
        let evtRec = {};
        if (evtRecRow) { try { evtRec = JSON.parse(evtRecRow.records || '{}'); } catch(e) {} }
        
        // Fallback: load from global event_record table (records management tab)
        // Normalize event name for lookup
        let normName = event.name.replace(/\s+/g, '').replace(/,/g, '').replace(/(\d)[×Xx](\d)/g, '$1x$2');
        const nameMap = { '110m허들':'110mH','100m허들':'100mH','400m허들':'400mH','3000m장애물':'3000mSC','10000m경보':'10000mW','십종경기':'10종경기','칠종경기':'7종경기','4x100m릴레이':'4x100mR','4x400m릴레이':'4x400mR','혼성4x400mR':'MIXED 4x400mR','MIXED4x400mR':'MIXED 4x400mR','4x800m릴레이':'4x800mR','4x1500m릴레이':'4x1500mR' };
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
        } catch(e) { /* event_record table might not exist */ }
        
        // Fallback to template-level labels
        const recTpl = tpl.records || {};
        const recRows = [
            { ...(recTpl.nr || { label: '한국기록(NR)' }), ...(evtRec.nr || {}) },
            { ...(recTpl.dr || { label: '부별기록(DR)' }), ...(evtRec.dr || {}) },
            { ...(recTpl.cr || { label: '대회기록(CR)' }), ...(evtRec.cr || {}) }
        ];
        const recCols = [
            { key: 'label', label: '구 분', x: tableLeft, w: totalW * 0.22 },
            { key: 'record', label: '기 록', x: tableLeft + totalW * 0.22, w: totalW * 0.18 },
            { key: 'athlete', label: '선 수 명', x: tableLeft + totalW * 0.40, w: totalW * 0.20 },
            { key: 'team', label: '소 속 명', x: tableLeft + totalW * 0.60, w: totalW * 0.22 },
            { key: 'year', label: '수립년도', x: tableLeft + totalW * 0.82, w: totalW * 0.18 }
        ];
        curY = drawTableHeader(doc, recCols, curY, tableLeft, tableRight, fontSize);
        for (const row of recRows) {
            const vals = recCols.map(c => row[c.key] || '');
            curY = drawTableRow(doc, recCols, vals, curY, tableLeft, tableRight, fontSize);
        }
        curY += 10;
    }

    // Branding footer
    drawBrandingFooter(doc, pageW, pageH, margin);
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
    const athletes = await db.all('SELECT * FROM athlete WHERE competition_id=? ORDER BY CAST(bib_number AS INTEGER)', comp.id);
    if (athletes.length === 0) return res.status(404).json({ error: 'No athletes found' });
    const tpl = getDocTemplate(comp.id).ad_card;

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

    athletes.forEach(async (athlete, idx) => {
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
    });

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

// PUT (upsert) event record
app.put('/api/event-records', async (req, res) => {
    try {
        const { admin_key, gender, event_name, record_type, record_value, holder_name, holder_team, record_year } = req.body;
        if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        if (!gender || !event_name || !record_type) return res.status(400).json({ error: 'gender, event_name, record_type 필수' });
        if (!['M','F'].includes(gender)) return res.status(400).json({ error: 'gender는 M 또는 F' });
        if (!['national','division','competition'].includes(record_type)) return res.status(400).json({ error: 'record_type는 national/division/competition' });

        await db.run(`INSERT INTO event_record (gender, event_name, record_type, record_value, holder_name, holder_team, record_year, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(gender, event_name, record_type) DO UPDATE SET
                record_value=excluded.record_value, holder_name=excluded.holder_name,
                holder_team=excluded.holder_team, record_year=excluded.record_year,
                updated_at=datetime('now')
        `, gender, event_name, record_type, record_value || '', holder_name || '', holder_team || '', record_year || '');

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT batch upsert for a single event (all 3 record types at once)
app.put('/api/event-records/batch', async (req, res) => {
    try {
        const { admin_key, gender, event_name, records } = req.body;
        if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        if (!gender || !event_name || !records) return res.status(400).json({ error: 'gender, event_name, records 필수' });

        await db.transaction(async () => {
            for (const rt of ['national', 'division', 'competition']) {
                const r = records[rt];
                if (r) {
                    await db.run(`INSERT INTO event_record (gender, event_name, record_type, record_value, holder_name, holder_team, record_year, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
                        ON CONFLICT(gender, event_name, record_type) DO UPDATE SET
                            record_value=excluded.record_value, holder_name=excluded.holder_name,
                            holder_team=excluded.holder_team, record_year=excluded.record_year,
                            updated_at=datetime('now')
                    `, gender, event_name, rt, r.record_value || '', r.holder_name || '', r.holder_team || '', r.record_year || '');
                }
            }
        })();

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
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
      '4x800mR': '4x800mR', '4×800mR': '4x800mR', '4x800m릴레이': '4x800mR', '4X800mR': '4x800mR'
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
    const RELAY_NAMES = new Set(['4x100mR','4x400mR','MIXED 4x400mR','4x800mR','4x1500mR']);
    // ---- Combined events ----
    const COMBINED_NAMES = new Set(['10종경기','7종경기']);

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

        const athleteData = entries.map(async e => {
          const scores = await db.all('SELECT * FROM combined_score WHERE event_entry_id=? ORDER BY sub_event_order', e.event_entry_id);
          let totalPoints = scores.reduce((s, sc) => s + (sc.wa_points || 0), 0);
          const status = await db.get("SELECT status_code FROM result WHERE heat_id=? AND event_entry_id=? AND status_code IN ('DNF','DNS','DQ') LIMIT 1", heat.id, e.event_entry_id);
          let statusCode = status?.status_code || '';
          if (!statusCode && e.status === 'no_show') statusCode = 'DNS';
          return { ...e, totalPoints, status_code: statusCode };
        });

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

        const athleteData = entries.map(async e => {
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
            const bestR = results.find(r => r.distance_meters != null);
            if (bestR) bestCleared = bestR.distance_meters;
          }
          if (!status && bestCleared === null && myAttempts.length > 0) status = 'NM';
          return { ...e, bestCleared, totalMisses, missesAtBest, status_code: status };
        });

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
              if (r.distance_meters != null && (r.status_code !== 'X' && r.status_code !== 'FOUL')) {
                if (best === null || r.distance_meters > best) { best = r.distance_meters; bestWind = r.wind; }
              }
            }
            let status = recs.find(r => r.status_code && ['DNS','DNF','NM','DQ'].includes(r.status_code))?.status_code || '';
            if (!status && e.status === 'no_show') status = 'DNS';
            if (!status && best === null && recs.length > 0 && recs.every(r => r.status_code === 'X' || r.status_code === 'FOUL')) status = 'NM';
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
            const members = await db.all(`
              SELECT a.name FROM relay_member rm JOIN athlete a ON a.id=rm.athlete_id
              WHERE rm.event_entry_id=? ORDER BY rm.leg_order, CAST(a.bib_number AS INTEGER)
            `, a.event_entry_id).map(m => m.name);
            entry.members = members;
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
    const tpl = getDocTemplate(comp.id);
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

// Document listing — available documents for a competition
app.get('/api/documents/:compId', async (req, res) => {
    const comp = await db.get('SELECT * FROM competition WHERE id=?', req.params.compId);
    if (!comp) return res.status(404).json({ error: 'Competition not found' });
    const events = await db.all("SELECT * FROM event WHERE competition_id=? AND parent_event_id IS NULL ORDER BY sort_order, id", comp.id);
    const docs = [];
    docs.push({ type: 'comprehensive-excel', label: '종합기록지 (남자)', url: `/api/documents/comprehensive/${comp.id}/excel?gender=M` });
    docs.push({ type: 'comprehensive-excel', label: '종합기록지 (여자)', url: `/api/documents/comprehensive/${comp.id}/excel?gender=F` });
    docs.push({ type: 'full-record-excel', label: '연맹 종합기록지 (남자)', url: `/api/documents/full-record/${comp.id}/excel?gender=M` });
    docs.push({ type: 'full-record-excel', label: '연맹 종합기록지 (여자)', url: `/api/documents/full-record/${comp.id}/excel?gender=F` });
    docs.push({ type: 'full-record-pdf', label: '연맹 종합기록지 PDF (남자)', url: `/api/documents/full-record/${comp.id}/pdf?gender=M` });
    docs.push({ type: 'full-record-pdf', label: '연맹 종합기록지 PDF (여자)', url: `/api/documents/full-record/${comp.id}/pdf?gender=F` });
    const roundLabelMap = { preliminary: '예선', semifinal: '준결승', final: '결승' };
    for (const evt of events) {
        const gK = evt.gender === 'M' ? '남' : evt.gender === 'F' ? '여' : '혼';
        const roundK = roundLabelMap[evt.round_type] || evt.round_type || '';
        const roundSuffix = roundK ? ` (${roundK})` : '';
        docs.push({ type: 'start-list', label: `Start List: ${gK} ${evt.name}${roundSuffix}`, url: `/api/documents/start-list/${evt.id}`, event_id: evt.id, gender: evt.gender, event_name: evt.name, round: evt.round_type, category: evt.category });
        docs.push({ type: 'result-sheet', label: `Results: ${gK} ${evt.name}${roundSuffix}`, url: `/api/documents/result-sheet/${evt.id}`, event_id: evt.id, gender: evt.gender, event_name: evt.name, round: evt.round_type, category: evt.category });
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

// 외부 API 호출 로그 기록
function _logExternalCall(opts) {
    try {
        db.prepare(`INSERT INTO external_api_log
            (api_key_id, key_prefix, endpoint, method, request_ip, user_agent,
             competition_id, event_id, request_body, response_status, response_code, duration_ms)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
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
            opts.duration_ms || 0
        );
    } catch(e) {
        console.warn('external_api_log insert failed:', e.message);
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
    const prefix = _keyPrefix(plainKey);
    const candidates = db.prepare('SELECT * FROM external_api_key WHERE key_prefix=?').all(prefix);
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

    // 통계 업데이트 (비차단)
    try {
        db.prepare('UPDATE external_api_key SET last_used_at=datetime(\'now\'), total_calls=total_calls+1 WHERE id=?').run(matched.id);
    } catch(_){}

    req.extApiKey = matched;
    next();
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
function _ensureDisplayCompetition(compId) {
    const comp = db.prepare('SELECT id, name, mode, start_date, end_date FROM competition WHERE id=?').get(parseInt(compId));
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
    const compCheck = _ensureDisplayCompetition(compId);
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
        return res.json({
            ok: true,
            competition: { id: compCheck.comp.id, name: compCheck.comp.name, mode: compCheck.comp.mode, start_date: compCheck.comp.start_date, end_date: compCheck.comp.end_date },
            count: rows.length,
            limit,
            items: rows
        });
    } catch (e) {
        console.error('[external/events/search]', e);
        return res.status(500).json({ ok: false, code: 'INTERNAL_ERROR', message: e.message || 'internal error' });
    }
});

// ── Phase 4: 종목 단건 조회 ──
// GET /api/external/event/:id
app.get('/api/external/event/:id', externalApiAuth, async (req, res) => {
    const eventId = parseInt(req.params.id);
    if (!Number.isFinite(eventId) || eventId <= 0) {
        return res.status(400).json({ ok: false, code: 'INVALID_EVENT_ID', message: 'event id가 올바르지 않습니다.' });
    }

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

    const compCheck = _ensureDisplayCompetition(evt.competition_id);
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

    const compCheck = _ensureDisplayCompetition(evt.competition_id);
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
        const compCheck = _ensureDisplayCompetition(evt.competition_id);
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

    const r = await db.run(`UPDATE external_api_key SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL`, id);
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
        if (/^\d{1,2}:\d{2}/.test(val)) return val.substring(0, 5);
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
            const rawEvent = String(row[colIdx.event] || '').trim();
            const rawJongbyul = colIdx.jongbyul >= 0 ? String(row[colIdx.jongbyul] || '').trim() : '';
            const rawRound = colIdx.round >= 0 ? String(row[colIdx.round] || '').trim() : '';

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

            if (overwriteMode === 'force') {
                // LEGACY: full delete for uploaded days
                const delTT = db.prepare('DELETE FROM timetable WHERE competition_id=? AND day=?');
                uploadedDays.forEach(d => delTT.run(parseInt(competition_id), d));
                const insTT = db.prepare('INSERT INTO timetable (competition_id, day, section, time, event_name, category, round, note, sort_order, scheduled_date) VALUES (?,?,?,?,?,?,?,?,?,?)');
                timetableEntries.forEach(e => {
                    insTT.run(e.competition_id, e.day, e.section, e.time, e.event_name, e.category, e.round, e.note, e.sort_order, e.scheduled_date);
                    addedCount++;
                });
            } else {
                // SMART MERGE (옵션 C):
                //   - 과거 일차(scheduled_date < today): 절대 건드리지 않음
                //   - 오늘/미래 일차: 행 단위 diff 머지
                //     * 매칭 키: (day, time, event_name, category, round)
                //     * 매칭 시 → UPDATE (event_id, callroom_time, note 등 보존)
                //     * 신규 → INSERT
                //     * 엑셀에 없는 기존 미래 행 → DELETE
                const insTT = db.prepare(`INSERT INTO timetable
                    (competition_id, day, section, time, event_name, category, round, note, sort_order, scheduled_date)
                    VALUES (?,?,?,?,?,?,?,?,?,?)`);
                // FIX: event_id를 NULL로 리셋해서 autoLinkDisplayTimetable이 새 division/gender로 재링크하도록 함
                //       (예전 잘못된 라벨로 만들어진 event에 링크된 채 남아있는 문제 방지)
                const updTT = db.prepare(`UPDATE timetable SET
                    section=?, note=?, sort_order=?, scheduled_date=?, event_id=NULL
                    WHERE id=?`);
                const delOne = db.prepare('DELETE FROM timetable WHERE id=?');

                effectiveDays.forEach(async day => {
                    // Existing rows for this day (only future/today, since past days are filtered upstream)
                    const existingRows = await db.all('SELECT * FROM timetable WHERE competition_id=? AND day=?', parseInt(competition_id), day);

                    // Skip if this day is in the past (safety)
                    const sampleRow = existingRows[0];
                    if (sampleRow && sampleRow.scheduled_date && sampleRow.scheduled_date < todayStr) {
                        preservedCount += existingRows.length;
                        return;
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

                    newEntries.forEach(e => {
                        const k = buildKey(e);
                        const candidates = existingByKey.get(k);
                        if (candidates && candidates.length > 0) {
                            // UPDATE: take first unmatched candidate
                            const target = candidates.shift();
                            matchedExistingIds.add(target.id);
                            updTT.run(e.section, e.note || target.note, e.sort_order, e.scheduled_date, target.id);
                            updatedCount++;
                        } else {
                            // INSERT new row
                            insTT.run(e.competition_id, e.day, e.section, e.time, e.event_name, e.category, e.round, e.note, e.sort_order, e.scheduled_date);
                            addedCount++;
                        }
                    });

                    // DELETE existing rows that are not in the new upload
                    existingRows.forEach(r => {
                        if (!matchedExistingIds.has(r.id)) {
                            delOne.run(r.id);
                            deletedCount++;
                        }
                    });
                });

                // Count preserved (past) days
                if (skippedPastDays.length > 0) {
                    const cnt = await db.get(`SELECT COUNT(*) AS c FROM timetable WHERE competition_id=? AND day IN (${skippedPastDays.map(()=>'?').join(',')})`, parseInt(competition_id), ...skippedPastDays);
                    preservedCount += (cnt && cnt.c) || 0;
                }
            }

            // Create events (skip if already exists for this competition)
            const existingEvents = await db.all('SELECT id, name, gender, division, round_type FROM event WHERE competition_id=?', parseInt(competition_id));
            const existingSet = new Set(existingEvents.map(e => `${e.name}|${e.gender}|${e.division || ''}|${e.round_type}`));

            const insEvent = db.prepare('INSERT INTO event (competition_id, name, category, gender, round_type, division, sort_order) VALUES (?,?,?,?,?,?,?)');
            let eventCount = 0;
            let sortIdx = existingEvents.length;

            Object.values(eventMap).forEach(ev => {
                const rounds = ev.rounds.size > 0 ? [...ev.rounds] : ['final'];
                const hasP = rounds.includes('preliminary');
                const hasS = rounds.includes('semifinal');
                const roundsToCreate = [];
                if (hasP) roundsToCreate.push('preliminary');
                if (hasS) roundsToCreate.push('semifinal');
                roundsToCreate.push('final');
                const uniqueRounds = [...new Set(roundsToCreate)];

                uniqueRounds.forEach(rt => {
                    const key = `${ev.name}|${ev.gender}|${ev.division || ''}|${rt}`;
                    if (!existingSet.has(key)) {
                        insEvent.run(parseInt(competition_id), ev.name, ev.category, ev.gender, rt, ev.division || '', sortIdx++);
                        existingSet.add(key);
                        eventCount++;
                    }
                });
            });

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
        try { autoLinkDisplayTimetable(parseInt(competition_id)); } catch(e) { console.warn('Display auto-link warning:', e.message); }

        // Compute callroom times
        try {
            const crStmt = db.prepare('UPDATE timetable SET callroom_time=? WHERE id=? AND callroom_time IS NULL');
            const needCR = await db.all('SELECT id, time, section FROM timetable WHERE competition_id=? AND callroom_time IS NULL', parseInt(competition_id));
            needCR.forEach(tt => {
                const m = (tt.time || '').match(/^(\d{1,2}):(\d{2})/);
                if (!m) return;
                let h = parseInt(m[1]), min = parseInt(m[2]);
                const offset = (tt.section === 'field') ? 45 : 30;
                min -= offset; while (min < 0) { min += 60; h -= 1; }
                if (h >= 0) crStmt.run(String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0'), tt.id);
            });
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

        const before = await db.get('SELECT COUNT(*) AS c FROM timetable WHERE competition_id=? AND event_id IS NOT NULL', compId).c;
        await db.run('UPDATE timetable SET event_id=NULL WHERE competition_id=?', compId);
        const linked = autoLinkDisplayTimetable(compId);
        const total = await db.get('SELECT COUNT(*) AS c FROM timetable WHERE competition_id=?', compId).c;
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

        const before = await db.get('SELECT COUNT(*) AS c FROM display_roster WHERE competition_id=? AND event_id IS NOT NULL', compId).c;
        await db.run('UPDATE display_roster SET event_id=NULL WHERE competition_id=?', compId);
        const matched = autoMatchDisplayRoster(compId);
        const total = await db.get('SELECT COUNT(*) AS c FROM display_roster WHERE competition_id=?', compId).c;
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
        const total = await db.get('SELECT COUNT(*) AS c FROM display_roster WHERE competition_id=? AND event_id IS NULL', compId).c;
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
function _findOrphanEvents(compId) {
    return db.prepare(`
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
    `).all(compId);
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

        const orphans = _findOrphanEvents(compId);
        const totalEvents = await db.get('SELECT COUNT(*) AS c FROM event WHERE competition_id=?', compId).c;

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

        const orphans = _findOrphanEvents(compId);
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
function autoLinkDisplayTimetable(compId) {
    let events = db.prepare('SELECT id, name, gender, division, round_type, category FROM event WHERE competition_id=?').all(compId);
    const ttRows = db.prepare('SELECT id, event_name, category AS jongbyul, round, event_id FROM timetable WHERE competition_id=?').all(compId);
    const linkStmt = db.prepare('UPDATE timetable SET event_id=? WHERE id=?');
    const insEvent = db.prepare('INSERT INTO event (competition_id, name, category, gender, round_type, division, sort_order) VALUES (?,?,?,?,?,?,?)');

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

    ttRows.forEach(tt => {
        if (tt.event_id) return; // already linked
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
            const info = insEvent.run(compId, targetName, cat, jbParsed.gender || 'X', targetRound, targetDivNorm, nextSort++);
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
            linkStmt.run(match.id, tt.id);
            linked++;
        }
    });

    if (createdEvents > 0) {
        console.log(`[autoLink] competition_id=${compId}: ${linked} linked, ${createdEvents} events auto-created from timetable`);
    }
    return linked;
}

// Upload roster PDF for display-mode competition
app.post('/api/display/roster/upload', upload.single('file'), (req, res) => {
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
            try { autoMatchDisplayRoster(parseInt(competition_id)); } catch(e) { console.warn('Roster auto-match warning:', e.message); }

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
        try { autoMatchDisplayRoster(parseInt(competition_id)); } catch(e) { console.warn('Roster auto-match warning:', e.message); }

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
function autoMatchDisplayRoster(compId) {
    const events = db.prepare('SELECT id, name, gender, division, round_type FROM event WHERE competition_id=?').all(compId);
    const unmatched = db.prepare('SELECT id, event_name, round, division, gender FROM display_roster WHERE competition_id=? AND event_id IS NULL').all(compId);
    const updStmt = db.prepare('UPDATE display_roster SET event_id=? WHERE id=?');

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

    unmatched.forEach(re => {
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
            if (match) { updStmt.run(match.id, re.id); matched++; combinedMatched++; }
            else stillUnmatched++;
            return;
        }

        // ── (B) 일반 종목 strict 매칭: name + gender + division + round_type 모두 일치 ──
        match = events.find(ev =>
            nameNorm(ev.name) === rosterEvName &&
            divNorm(ev.division) === rosterDiv &&
            genderEq(ev.gender, re.gender) &&
            roundEq(re.round, ev.round_type)
        );
        if (match) { updStmt.run(match.id, re.id); matched++; strictMatched++; return; }

        // ── (C) Fallback 1: division 표기 차이 흡수 (양쪽 모두 normalize 후 비교)
        //        ※ rosterDiv가 빈 문자열일 때만 division 비교를 생략. 그렇지 않으면 division mismatch는 절대 매칭 X.
        if (rosterDiv === '') {
            match = events.find(ev =>
                nameNorm(ev.name) === rosterEvName &&
                genderEq(ev.gender, re.gender) &&
                roundEq(re.round, ev.round_type)
            );
            if (match) { updStmt.run(match.id, re.id); matched++; fallbackMatched++; return; }
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
        if (match) { updStmt.run(match.id, re.id); matched++; fallbackMatched++; return; }

        stillUnmatched++;
    });

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

// Bulk update result URLs
app.put('/api/display/events/bulk-result-url', async (req, res) => {
    const { admin_key, updates } = req.body;
    if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
    if (!Array.isArray(updates)) return res.status(400).json({ error: 'updates array required' });
    await db.transaction(async () => {
        for (const u of updates) {
            await db.run('UPDATE event SET result_url=? WHERE id=?', u.result_url || '', u.id);
        }
    })();
    res.json({ success: true, count: updates.length });
});

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
app.post('/api/display/roster/match', (req, res) => {
    const { admin_key, roster_ids, event_id } = req.body;
    if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
    if (!Array.isArray(roster_ids) || !event_id) return res.status(400).json({ error: 'roster_ids and event_id required' });
    const stmt = db.prepare('UPDATE display_roster SET event_id=? WHERE id=?');
    roster_ids.forEach(rid => stmt.run(event_id, rid));
    res.json({ success: true, count: roster_ids.length });
});

// Re-run auto-matching for roster
app.post('/api/display/roster/:compId/rematch', async (req, res) => {
    const { admin_key } = req.body;
    if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
    await db.run('UPDATE display_roster SET event_id=NULL WHERE competition_id=?', req.params.compId);
    const matched = autoMatchDisplayRoster(parseInt(req.params.compId));
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
        try { autoMatchDisplayRoster(parseInt(competition_id)); } catch(e) {}
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

    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg);
            // Handle client requests
            if (data.type === 'subscribe') {
                ws._compId = data.competition_id;
                ws.send(JSON.stringify({ type: 'subscribed', competition_id: data.competition_id }));
            }
            if (data.type === 'request_current') {
                sendCurrentScoreboard(ws, data.competition_id);
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

function sendCurrentScoreboard(ws, compId) {
    if (!compId) return;
    const activeEvent = db.prepare("SELECT * FROM event WHERE competition_id=? AND round_status='in_progress' AND parent_event_id IS NULL ORDER BY sort_order LIMIT 1").get(compId);
    if (!activeEvent) {
        ws.send(JSON.stringify({ type: 'scoreboard_state', data: { event: null } }));
        return;
    }
    const heat = db.prepare('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number DESC LIMIT 1').get(activeEvent.id);
    const totalHeats = db.prepare('SELECT COUNT(*) as cnt FROM heat WHERE event_id=?').get(activeEvent.id)?.cnt || 0;
    
    // Get entries for this event's heat
    let entries = heat ? db.prepare(`
        SELECT he.lane_number, ee.id as event_entry_id, ee.status, a.name, a.bib_number, a.team
        FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id
        JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=?
        ORDER BY he.lane_number ASC
    `).all(heat.id) : [];
    let results = heat ? db.prepare('SELECT * FROM result WHERE heat_id=?').all(heat.id) : [];
    
    // Check for linked (joint) events — 합동 종목 전광판
    const linkedEvents = db.prepare(`
        SELECT CASE WHEN event_id_a = ? THEN event_id_b ELSE event_id_a END as linked_id
        FROM event_link WHERE event_id_a = ? OR event_id_b = ?
    `).all(activeEvent.id, activeEvent.id, activeEvent.id);
    
    const comp = db.prepare('SELECT federation, name FROM competition WHERE id=?').get(compId);
    const primaryFed = comp?.federation || comp?.name || '';
    
    // Tag primary entries with federation
    entries = entries.map(e => ({ ...e, federation: primaryFed }));
    
    // Merge linked event entries
    for (const link of linkedEvents) {
        const linkedEvt = db.prepare('SELECT e.*, c.federation, c.name as comp_name FROM event e JOIN competition c ON c.id=e.competition_id WHERE e.id=?').get(link.linked_id);
        if (!linkedEvt) continue;
        const linkedHeat = db.prepare('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number DESC LIMIT 1').get(link.linked_id);
        if (!linkedHeat) continue;
        
        const linkedEntries = db.prepare(`
            SELECT he.lane_number, ee.id as event_entry_id, ee.status, a.name, a.bib_number, a.team
            FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id
            JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=?
            ORDER BY he.lane_number ASC
        `).all(linkedHeat.id);
        const linkedResults = db.prepare('SELECT * FROM result WHERE heat_id=?').all(linkedHeat.id);
        
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
    try {
        // 1) event.division 정규화
        const events = db.prepare('SELECT id, division, round_type FROM event WHERE division IS NOT NULL OR round_type IS NOT NULL').all();
        const updEv = db.prepare('UPDATE event SET division=?, round_type=? WHERE id=?');
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
        const rosters = db.prepare("SELECT id, division FROM display_roster WHERE division IS NOT NULL AND division <> ''").all();
        const updRo = db.prepare('UPDATE display_roster SET division=? WHERE id=?');
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

server.listen(PORT, '0.0.0.0', () => {
    try {
        const compCount = db.prepare('SELECT COUNT(*) as c FROM competition').get().c;
        const evtCount = db.prepare('SELECT COUNT(*) as c FROM event').get().c;
        const athCount = db.prepare('SELECT COUNT(*) as c FROM athlete').get().c;
        console.log(`\n  Pace Rise Competition OS v5 — port ${PORT}`);
        console.log(`  http://localhost:${PORT}/`);
        console.log(`  WebSocket Scoreboard: ws://localhost:${PORT}/ws/scoreboard`);
        console.log(`  DB: ${compCount} competitions, ${evtCount} events, ${athCount} athletes\n`);
    } catch(e) {
        console.log(`\n  Pace Rise Competition OS v5 — port ${PORT}\n  http://localhost:${PORT}/\n`);
    }
    // 시작 직후 일회성 마이그레이션 실행 (멱등)
    try { migrateNormalizeDivisionAndRound(); } catch(e) { console.warn('migrate failed:', e.message); }
});
