/**
 * Pace Rise Competition OS — Express Server v4
 * Multi-competition, 3-tier auth (viewer/judge/admin)
 */
require('dotenv').config();
const express = require('express');
const compression = require('compression');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const { initDatabase } = require('./db/init');

const upload = multer({ dest: '/tmp/uploads/', limits: { fileSize: 10 * 1024 * 1024 } });

// ---- KST (한국표준시, UTC+9) Helper ----
function kstNow() {
    const d = new Date();
    d.setHours(d.getHours() + 9);
    return d.toISOString().replace('T', ' ').substring(0, 19);
}

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

const db = initDatabase();

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
// Add remark + status_code to result table if missing
try { db.exec(`ALTER TABLE result ADD COLUMN remark TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE result ADD COLUMN status_code TEXT DEFAULT ''`); } catch(e) {}
// Add wind columns (migration)
try { db.exec(`ALTER TABLE result ADD COLUMN wind REAL DEFAULT NULL`); } catch(e) {}
try { db.exec(`ALTER TABLE heat ADD COLUMN wind REAL DEFAULT NULL`); } catch(e) {}
// Add heat_name to heat (custom display name, e.g. "준결1조", "A조")
try { db.exec(`ALTER TABLE heat ADD COLUMN heat_name TEXT DEFAULT NULL`); } catch(e) {}
// Add sub_group to heat_entry (A/B group for 5000m/10000m etc.)
try { db.exec(`ALTER TABLE heat_entry ADD COLUMN sub_group TEXT DEFAULT NULL`); } catch(e) {}
// Add qualification_type to qualification_selection (Q or q)
try { db.exec(`ALTER TABLE qualification_selection ADD COLUMN qualification_type TEXT DEFAULT ''`); } catch(e) {}
// Add federation column to athlete (KTFL=실업, KUAF=대학)
try { db.exec(`ALTER TABLE athlete ADD COLUMN federation TEXT DEFAULT ''`); } catch(e) {}
// Add federation column to competition (KTFL=실업, KUAF=대학, ''=없음)
try { db.exec(`ALTER TABLE competition ADD COLUMN federation TEXT DEFAULT ''`); } catch(e) {}
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

// ---- SSE clients ----
let sseClients = [];
function broadcastSSE(eventType, data) {
    const msg = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    sseClients = sseClients.filter(c => {
        try { c.write(msg); return true; }
        catch { return false; }
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

// ---- Audit & OpLog ----
function audit(table, id, action, oldV, newV, by = 'operator', compId = null) {
    const ts = kstNow();
    db.prepare(`INSERT INTO audit_log (competition_id,table_name,record_id,action,old_values,new_values,performed_by,created_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(compId, table, id, action, oldV ? JSON.stringify(oldV) : null, newV ? JSON.stringify(newV) : null, by, ts);
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
    '10,000mW':{name:'10,000mW',category:'track'},'100mH':{name:'100mH',category:'track'},
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

    // Sort by performance (ascending for track = fastest first)
    athletePerf.sort((a, b) => a.perf - b.perf);

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
// Top seeds get center lanes (3-6), lower seeds get outer lanes (1,2,7,8)
function waAssignLane(seedIdx, totalInHeat, isShortTrack) {
    if (!isShortTrack || totalInHeat <= 0) return seedIdx + 1;
    // Lane preference order: 4,5,3,6,2,7,1,8 (center out)
    const laneOrder = [4, 5, 3, 6, 2, 7, 1, 8];
    const maxLanes = Math.min(totalInHeat, 8);
    if (seedIdx < maxLanes) return laneOrder[seedIdx];
    return seedIdx + 1;
}

// WA Regulation Validator — check and auto-correct heat/lane assignments
function validateWAHeatLanes(eventId, db) {
    const event = db.prepare('SELECT * FROM event WHERE id=?').get(eventId);
    if (!event) return { valid: true, issues: [], corrections: 0 };
    const isShort = isShortTrackEvent(event.name);
    const heats = db.prepare('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number').all(eventId);
    const issues = [];
    let corrections = 0;

    for (const heat of heats) {
        const entries = db.prepare(`SELECT he.*, ee.athlete_id, a.name, a.team
            FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id
            JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=? ORDER BY he.lane_number`).all(heat.id);

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

// Auto-correct WA violations: reassign lanes using WA lane preference
function autoCorrectWALanes(eventId, db) {
    const event = db.prepare('SELECT * FROM event WHERE id=?').get(eventId);
    if (!event) return { corrections: 0, issues: [] };
    const isShort = isShortTrackEvent(event.name);
    const heats = db.prepare('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number').all(eventId);
    let corrections = 0;
    const issues = [];

    db.transaction(() => {
        for (const heat of heats) {
            const entries = db.prepare(`SELECT he.*, ee.athlete_id FROM heat_entry he
                JOIN event_entry ee ON ee.id=he.event_entry_id WHERE he.heat_id=? ORDER BY he.lane_number`).all(heat.id);

            if (isShort) {
                // Check for duplicate lanes or invalid lanes
                const laneSet = new Set();
                let needsReassign = false;
                entries.forEach(e => {
                    if (e.lane_number < 1 || e.lane_number > 8 || laneSet.has(e.lane_number)) needsReassign = true;
                    laneSet.add(e.lane_number);
                });

                if (needsReassign && entries.length <= 8) {
                    // Reassign using WA lane preference order
                    entries.forEach((e, idx) => {
                        const newLane = waAssignLane(idx, entries.length, true);
                        if (newLane !== e.lane_number) {
                            db.prepare('UPDATE heat_entry SET lane_number=? WHERE id=?').run(newLane, e.id);
                            corrections++;
                        }
                    });
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

app.get('/api/competitions', (req, res) => {
    autoUpdateCompetitionStatus();
    res.json(db.prepare('SELECT * FROM competition ORDER BY start_date ASC').all());
});
// Competitions within 2 weeks (for home top section) — MUST be before /:id
app.get('/api/competitions/recent', (req, res) => {
    const today = new Date().toISOString().slice(0, 10);
    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const twoWeeksLater = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const rows = db.prepare(`
        SELECT * FROM competition
        WHERE status = 'active'
           OR (end_date >= ? AND start_date <= ?)
        ORDER BY CASE WHEN status='active' THEN 0 ELSE 1 END, start_date DESC
    `).all(twoWeeksAgo, twoWeeksLater);
    res.json(rows);
});
// Competitions by federation — MUST be before /:id
app.get('/api/competitions/by-federation/:code', (req, res) => {
    const rows = db.prepare('SELECT * FROM competition WHERE federation=? ORDER BY start_date DESC').all(req.params.code);
    res.json(rows);
});
app.get('/api/competitions/:id', (req, res) => {
    const c = db.prepare('SELECT * FROM competition WHERE id=?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    res.json(c);
});
app.post('/api/competitions', (req, res) => {
    const { admin_key, name, start_date, end_date, venue, federation } = req.body;
    if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    if (!name || !start_date || !end_date) return res.status(400).json({ error: '대회명, 시작일, 종료일은 필수입니다.' });
    try {
        const info = db.prepare('INSERT INTO competition (name,start_date,end_date,venue,federation) VALUES (?,?,?,?,?)')
            .run(name, start_date, end_date, venue || '', federation || '');
        const comp = db.prepare('SELECT * FROM competition WHERE id=?').get(info.lastInsertRowid);
        opLog(`대회 생성: ${name}`, 'admin', 'admin', comp.id);
        res.json(comp);
    } catch (e) { res.status(400).json({ error: '대회 생성 실패: ' + e.message }); }
});
app.put('/api/competitions/:id', (req, res) => {
    const { admin_key, name, start_date, end_date, venue, status, video_url, federation } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    const old = db.prepare('SELECT * FROM competition WHERE id=?').get(req.params.id);
    if (!old) return res.status(404).json({ error: 'Not found' });
    db.prepare('UPDATE competition SET name=?,start_date=?,end_date=?,venue=?,status=?,video_url=?,federation=? WHERE id=?')
        .run(name||old.name, start_date||old.start_date, end_date||old.end_date, venue??old.venue, status||old.status, video_url??old.video_url??'', federation??old.federation??'', old.id);
    res.json(db.prepare('SELECT * FROM competition WHERE id=?').get(old.id));
});
app.delete('/api/competitions/:id', (req, res) => {
    const { admin_key } = req.body;
    if (!isAdminOrManager(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    const comp = db.prepare('SELECT * FROM competition WHERE id=?').get(req.params.id);
    if (!comp) return res.status(404).json({ error: 'Not found' });
    db.transaction(() => {
        const events = db.prepare('SELECT id FROM event WHERE competition_id=?').all(comp.id);
        for (const evt of events) {
            const heats = db.prepare('SELECT id FROM heat WHERE event_id=?').all(evt.id);
            for (const h of heats) {
                db.prepare('DELETE FROM result WHERE heat_id=?').run(h.id);
                db.prepare('DELETE FROM height_attempt WHERE heat_id=?').run(h.id);
                db.prepare('DELETE FROM heat_entry WHERE heat_id=?').run(h.id);
            }
            db.prepare('DELETE FROM heat WHERE event_id=?').run(evt.id);
            db.prepare('DELETE FROM relay_member WHERE event_entry_id IN (SELECT id FROM event_entry WHERE event_id=?)').run(evt.id);
            db.prepare('DELETE FROM combined_score WHERE event_entry_id IN (SELECT id FROM event_entry WHERE event_id=?)').run(evt.id);
            db.prepare('DELETE FROM qualification_selection WHERE event_id=?').run(evt.id);
            db.prepare('DELETE FROM event_entry WHERE event_id=?').run(evt.id);
        }
        db.prepare('DELETE FROM event WHERE competition_id=?').run(comp.id);
        db.prepare('DELETE FROM athlete WHERE competition_id=?').run(comp.id);
        db.prepare('DELETE FROM audit_log WHERE competition_id=?').run(comp.id);
        db.prepare('DELETE FROM operation_log WHERE competition_id=?').run(comp.id);
        db.prepare('DELETE FROM competition WHERE id=?').run(comp.id);
    })();
    res.json({ success: true });
});

// Competition info (public — for viewer)
app.get('/api/competition-info', (req, res) => {
    const compId = req.query.competition_id;
    if (compId) {
        const c = db.prepare('SELECT * FROM competition WHERE id=?').get(compId);
        if (c) return res.json({ name: c.name, dates: `${c.start_date} ~ ${c.end_date}`, venue: c.venue, video_url: c.video_url || '', federation: c.federation || '' });
    }
    const c = db.prepare('SELECT * FROM competition ORDER BY start_date DESC LIMIT 1').get();
    if (c) return res.json({ name: c.name, dates: `${c.start_date} ~ ${c.end_date}`, venue: c.venue, video_url: c.video_url || '', federation: c.federation || '' });
    res.json({ name: '', dates: '', venue: '', video_url: '', federation: '' });
});

// ============================================================
// FEDERATION LIST — CRUD
// ============================================================
// Federation list — CRUD
app.get('/api/federations', (req, res) => {
    const rows = db.prepare('SELECT * FROM federation_list ORDER BY sort_order, code').all();
    res.json(rows);
});
app.post('/api/federations', (req, res) => {
    const { admin_key, code, name, badge_bg, badge_color } = req.body;
    if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    if (!code || !code.trim()) return res.status(400).json({ error: '연맹 코드는 필수입니다.' });
    try {
        const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM federation_list').get().m || 0;
        const info = db.prepare('INSERT INTO federation_list (code, name, badge_bg, badge_color, sort_order) VALUES (?,?,?,?,?)')
            .run(code.trim().toUpperCase(), name || '', badge_bg || '#e3f2fd', badge_color || '#1565c0', maxOrder + 1);
        opLog(`연맹 추가: ${code}`, 'admin', 'admin');
        res.json({ id: info.lastInsertRowid, success: true });
    } catch (e) {
        if (e.message.includes('UNIQUE')) return res.status(400).json({ error: '이미 존재하는 연맹 코드입니다.' });
        res.status(500).json({ error: e.message });
    }
});
app.put('/api/federations/:id', (req, res) => {
    const { admin_key, code, name, badge_bg, badge_color, sort_order } = req.body;
    if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    const old = db.prepare('SELECT * FROM federation_list WHERE id=?').get(req.params.id);
    if (!old) return res.status(404).json({ error: 'Not found' });
    try {
        db.prepare('UPDATE federation_list SET code=?, name=?, badge_bg=?, badge_color=?, sort_order=? WHERE id=?')
            .run(code || old.code, name ?? old.name, badge_bg || old.badge_bg, badge_color || old.badge_color, sort_order ?? old.sort_order, old.id);
        opLog(`연맹 수정: ${code || old.code}`, 'admin', 'admin');
        res.json({ success: true });
    } catch (e) {
        if (e.message.includes('UNIQUE')) return res.status(400).json({ error: '이미 존재하는 연맹 코드입니다.' });
        res.status(500).json({ error: e.message });
    }
});
app.delete('/api/federations/:id', (req, res) => {
    const { admin_key } = req.body;
    if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    const old = db.prepare('SELECT * FROM federation_list WHERE id=?').get(req.params.id);
    if (!old) return res.status(404).json({ error: 'Not found' });
    db.prepare('DELETE FROM federation_list WHERE id=?').run(old.id);
    opLog(`연맹 삭제: ${old.code}`, 'admin', 'admin');
    res.json({ success: true });
});
app.put('/api/federations/reorder', (req, res) => {
    const { admin_key, order } = req.body;
    if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    if (!Array.isArray(order)) return res.status(400).json({ error: 'order array required' });
    const stmt = db.prepare('UPDATE federation_list SET sort_order=? WHERE id=?');
    db.transaction(() => { order.forEach((id, i) => stmt.run(i + 1, id)); })();
    res.json({ success: true });
});

// ============================================================
// HOME POPUP — CMS
// ============================================================
app.get('/api/home-popups', (req, res) => {
    const popups = db.prepare('SELECT * FROM home_popup ORDER BY sort_order, id').all();
    const sections = db.prepare('SELECT * FROM home_popup_section ORDER BY popup_id, sort_order').all();
    popups.forEach(p => { p.sections = sections.filter(s => s.popup_id === p.id); });
    res.json(popups);
});
app.post('/api/home-popups', (req, res) => {
    const { admin_key, popup_type, title, subtitle, intro_text, bottom_btn_text, bottom_btn_desc, bottom_btn_link, bottom_btn_active, is_active, show_from, show_until, sort_order, sections } = req.body;
    if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    try {
        const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM home_popup').get().m || 0;
        const info = db.prepare(`INSERT INTO home_popup (popup_type, title, subtitle, intro_text, bottom_btn_text, bottom_btn_desc, bottom_btn_link, bottom_btn_active, is_active, show_from, show_until, sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(popup_type || 'public', title || '', subtitle || '', intro_text || '', bottom_btn_text || '', bottom_btn_desc || '', bottom_btn_link || '', bottom_btn_active ?? 1, is_active ?? 1, show_from || null, show_until || null, sort_order ?? maxOrder + 1);
        const popupId = info.lastInsertRowid;
        if (Array.isArray(sections)) {
            const stmt = db.prepare('INSERT INTO home_popup_section (popup_id, title, content, link_btn_text, link_btn_url, sort_order, is_active) VALUES (?,?,?,?,?,?,?)');
            sections.forEach((s, i) => stmt.run(popupId, s.title || '', s.content || '', s.link_btn_text || '', s.link_btn_url || '', s.sort_order ?? i, s.is_active ?? 1));
        }
        opLog('홈 팝업 생성', 'admin', 'admin');
        res.json({ id: popupId, success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/home-popups/reorder', (req, res) => {
    const { admin_key, order } = req.body;
    if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    if (!Array.isArray(order)) return res.status(400).json({ error: 'order array required' });
    const stmt = db.prepare('UPDATE home_popup SET sort_order=? WHERE id=?');
    db.transaction(() => { order.forEach((id, i) => stmt.run(i + 1, id)); })();
    res.json({ success: true });
});
app.put('/api/home-popups/:id', (req, res) => {
    const { admin_key, popup_type, title, subtitle, intro_text, bottom_btn_text, bottom_btn_desc, bottom_btn_link, bottom_btn_active, is_active, show_from, show_until, sort_order, sections } = req.body;
    if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    const old = db.prepare('SELECT * FROM home_popup WHERE id=?').get(req.params.id);
    if (!old) return res.status(404).json({ error: 'Not found' });
    try {
        db.prepare(`UPDATE home_popup SET popup_type=?, title=?, subtitle=?, intro_text=?, bottom_btn_text=?, bottom_btn_desc=?, bottom_btn_link=?, bottom_btn_active=?, is_active=?, show_from=?, show_until=?, sort_order=?, updated_at=datetime('now') WHERE id=?`)
            .run(popup_type || old.popup_type, title ?? old.title, subtitle ?? old.subtitle, intro_text ?? old.intro_text, bottom_btn_text ?? old.bottom_btn_text, bottom_btn_desc ?? old.bottom_btn_desc, bottom_btn_link ?? old.bottom_btn_link, bottom_btn_active ?? old.bottom_btn_active, is_active ?? old.is_active, show_from || old.show_from, show_until || old.show_until, sort_order ?? old.sort_order ?? 0, old.id);
        // Replace sections if provided
        if (Array.isArray(sections)) {
            db.prepare('DELETE FROM home_popup_section WHERE popup_id=?').run(old.id);
            const stmt = db.prepare('INSERT INTO home_popup_section (popup_id, title, content, link_btn_text, link_btn_url, sort_order, is_active) VALUES (?,?,?,?,?,?,?)');
            sections.forEach((s, i) => stmt.run(old.id, s.title || '', s.content || '', s.link_btn_text || '', s.link_btn_url || '', s.sort_order ?? i, s.is_active ?? 1));
        }
        opLog('홈 팝업 수정', 'admin', 'admin');
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/home-popups/:id', (req, res) => {
    const { admin_key } = req.body;
    if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    const old = db.prepare('SELECT * FROM home_popup WHERE id=?').get(req.params.id);
    if (!old) return res.status(404).json({ error: 'Not found' });
    db.transaction(() => {
        db.prepare('DELETE FROM home_popup_section WHERE popup_id=?').run(old.id);
        db.prepare('DELETE FROM home_popup WHERE id=?').run(old.id);
    })();
    opLog('홈 팝업 삭제', 'admin', 'admin');
    res.json({ success: true });
});



// ============================================================
// EVENTS — scoped to competition
// ============================================================
// Heat allocations view — shows all heats/lanes for an event (used in manual edit UI)
app.get('/api/events/:id/heat-allocations', (req, res) => {
    const event = db.prepare('SELECT * FROM event WHERE id=?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    const heats = db.prepare('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number').all(event.id);
    const result = heats.map(h => {
        const entries = db.prepare(`SELECT he.lane_number, he.sub_group, he.id AS heat_entry_id, ee.id AS event_entry_id, ee.status,
               a.id AS athlete_id, a.name, a.bib_number, a.team, a.gender
        FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id
        JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=? ORDER BY he.lane_number ASC, CAST(a.bib_number AS INTEGER)`).all(h.id);
        return { ...h, entries };
    });
    res.json({ event, heats: result });
});
app.get('/api/events', (req, res) => {
    const { gender, category, competition_id } = req.query;
    let q = 'SELECT * FROM event WHERE 1=1';
    const p = [];
    if (competition_id) { q += ' AND competition_id=?'; p.push(competition_id); }
    if (gender) { q += ' AND gender=?'; p.push(gender); }
    if (category) { q += ' AND category=?'; p.push(category); }
    q += ' ORDER BY sort_order, id';
    res.json(db.prepare(q).all(...p));
});
app.get('/api/events/:id', (req, res) => {
    const e = db.prepare('SELECT * FROM event WHERE id=?').get(req.params.id);
    if (!e) return res.status(404).json({ error: 'Not found' });
    res.json(e);
});
app.get('/api/events/:id/entries', (req, res) => {
    res.json(db.prepare(`
        SELECT ee.id AS event_entry_id, ee.status, ee.event_id,
               a.id AS athlete_id, a.name, a.bib_number, a.team, a.gender
        FROM event_entry ee JOIN athlete a ON a.id=ee.athlete_id
        WHERE ee.event_id=? ORDER BY CAST(a.bib_number AS INTEGER)
    `).all(req.params.id));
});

// ============================================================
// HEATS
// ============================================================
app.get('/api/heats', (req, res) => {
    if (!req.query.event_id) return res.status(400).json({ error: 'event_id required' });
    res.json(db.prepare('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number').all(req.query.event_id));
});
app.get('/api/heats/:id/entries', (req, res) => {
    const statusFilter = req.query.status;
    let query = `SELECT he.id AS heat_entry_id, he.lane_number, he.sub_group,
               ee.id AS event_entry_id, ee.status,
               a.id AS athlete_id, a.name, a.bib_number, a.team, a.gender, a.barcode
        FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id
        JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=?`;
    const params = [req.params.id];
    if (statusFilter) { query += ` AND ee.status=?`; params.push(statusFilter); }
    query += ` ORDER BY he.lane_number ASC, CAST(a.bib_number AS INTEGER)`;
    res.json(db.prepare(query).all(...params));
});

// ============================================================
// RESULTS
// ============================================================
app.get('/api/results', (req, res) => {
    if (!req.query.heat_id) return res.status(400).json({ error: 'heat_id required' });
    res.json(db.prepare(`
        SELECT r.*, a.name, a.bib_number, a.team
        FROM result r JOIN event_entry ee ON ee.id=r.event_entry_id
        JOIN athlete a ON a.id=ee.athlete_id
        WHERE r.heat_id=? ORDER BY r.event_entry_id, r.attempt_number
    `).all(req.query.heat_id));
});
app.post('/api/results/upsert', (req, res) => {
    const { heat_id, event_entry_id, attempt_number, distance_meters, time_seconds, remark, status_code, wind } = req.body;
    if (!heat_id || !event_entry_id) return res.status(400).json({ error: 'heat_id and event_entry_id required' });
    const he = db.prepare('SELECT * FROM heat_entry WHERE heat_id=? AND event_entry_id=?').get(heat_id, event_entry_id);
    if (!he) return res.status(404).json({ error: 'Entry not in heat' });
    const heat = db.prepare('SELECT * FROM heat WHERE id=?').get(heat_id);
    if (heat) {
        const event = db.prepare('SELECT * FROM event WHERE id=?').get(heat.event_id);
        if (event && event.round_status !== 'in_progress' && event.round_status !== 'completed') {
            let allowed = false;
            // Allow combined sub-events if parent is in_progress/completed
            if (event.parent_event_id) {
                const parent = db.prepare('SELECT * FROM event WHERE id=?').get(event.parent_event_id);
                if (parent && parent.category === 'combined' && (parent.round_status === 'in_progress' || parent.round_status === 'completed')) allowed = true;
            }
            // Auto-promote from 'created' or 'heats_generated' to 'in_progress' when heats exist
            if (!allowed && (event.round_status === 'created' || event.round_status === 'heats_generated')) {
                const heatCount = db.prepare('SELECT COUNT(*) as cnt FROM heat WHERE event_id=?').get(event.id).cnt;
                if (heatCount > 0) {
                    allowed = true;
                    db.prepare("UPDATE event SET round_status='in_progress' WHERE id=?").run(event.id);
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
        const event = db.prepare('SELECT * FROM event WHERE id=?').get(heat.event_id);
        if (event && (event.round_status === 'heats_generated' || event.round_status === 'created')) {
            db.prepare("UPDATE event SET round_status='in_progress' WHERE id=?").run(event.id);
            broadcastSSE('event_status_changed', { event_id: event.id, round_status: 'in_progress' });
            const gL = event.gender === 'M' ? '남자' : event.gender === 'F' ? '여자' : '혼성';
            const roundL = { preliminary: '예선', semifinal: '준결승', final: '결승' }[event.round_type] || event.round_type;
            opLog(`${event.name} ${roundL} ${gL} 기록 입력 시작 (자동 진행중 전환)`, 'record', 'system', event.competition_id);
        }
        // Also update parent combined event status if this is a sub-event
        if (event && event.parent_event_id) {
            const parentEvt = db.prepare('SELECT * FROM event WHERE id=?').get(event.parent_event_id);
            if (parentEvt && parentEvt.category === 'combined' && (parentEvt.round_status === 'heats_generated' || parentEvt.round_status === 'created')) {
                db.prepare("UPDATE event SET round_status='in_progress' WHERE id=?").run(parentEvt.id);
                broadcastSSE('event_status_changed', { event_id: parentEvt.id, round_status: 'in_progress' });
                opLog(`${parentEvt.name} 기록 입력 시작 (세부종목 자동 진행중 전환)`, 'record', 'system', parentEvt.competition_id);
            }
        }
    }
    try {
        let existing = db.prepare('SELECT * FROM result WHERE heat_id=? AND event_entry_id=? AND attempt_number IS ?')
            .get(heat_id, event_entry_id, attempt_number || null);
        // Fallback: for track/relay/road (no attempt_number), find any existing result for this entry
        if (!existing && !attempt_number) {
            existing = db.prepare('SELECT * FROM result WHERE heat_id=? AND event_entry_id=? ORDER BY id DESC LIMIT 1')
                .get(heat_id, event_entry_id);
        }
        if (existing) {
            // Preserve existing values for fields not included in the request (undefined → keep existing)
            const updDist = distance_meters !== undefined ? (distance_meters ?? null) : existing.distance_meters;
            const updTime = time_seconds !== undefined ? (time_seconds ?? null) : existing.time_seconds;
            const updRemark = remark !== undefined ? (remark ?? '') : (existing.remark ?? '');
            const updSc = sc || existing.status_code || '';
            const updWind = wind !== undefined ? (wind ?? null) : existing.wind;
            db.prepare("UPDATE result SET distance_meters=?,time_seconds=?,remark=?,status_code=?,wind=?,updated_at=datetime('now') WHERE id=?")
                .run(updDist, updTime, updRemark, updSc, updWind, existing.id);
            const upd = db.prepare('SELECT * FROM result WHERE id=?').get(existing.id);
            audit('result', existing.id, 'UPDATE', existing, upd);
            broadcastSSE('result_update', { heat_id, event_entry_id });
            res.json(upd);
        } else {
            const info = db.prepare('INSERT INTO result (heat_id,event_entry_id,attempt_number,distance_meters,time_seconds,remark,status_code,wind) VALUES (?,?,?,?,?,?,?,?)')
                .run(heat_id, event_entry_id, attempt_number || null, distance_meters ?? null, time_seconds ?? null, remark || '', sc || '', wind ?? null);
            const ins = db.prepare('SELECT * FROM result WHERE id=?').get(info.lastInsertRowid);
            audit('result', ins.id, 'INSERT', null, ins);
            broadcastSSE('result_update', { heat_id, event_entry_id });
            res.json(ins);
        }
    } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// Delete a single result by heat_id + event_entry_id + attempt_number (for clearing field entries)
app.delete('/api/results', (req, res) => {
    const { heat_id, event_entry_id, attempt_number } = req.body;
    if (!heat_id || !event_entry_id) return res.status(400).json({ error: 'heat_id and event_entry_id required' });
    let row;
    if (attempt_number) {
        row = db.prepare('SELECT * FROM result WHERE heat_id=? AND event_entry_id=? AND attempt_number=?').get(heat_id, event_entry_id, attempt_number);
    } else {
        row = db.prepare('SELECT * FROM result WHERE heat_id=? AND event_entry_id=? AND attempt_number IS NULL ORDER BY id DESC LIMIT 1').get(heat_id, event_entry_id);
    }
    if (!row) return res.status(404).json({ error: 'Result not found' });
    db.prepare('DELETE FROM result WHERE id=?').run(row.id);
    audit('result', row.id, 'DELETE', row, null);
    broadcastSSE('result_update', { heat_id, event_entry_id });
    res.json({ success: true, deleted_id: row.id });
});

// ============================================================
// HEAT WIND (track events: per-heat wind)
// ============================================================
app.post('/api/heats/:id/wind', (req, res) => {
    const { wind } = req.body;
    const heat = db.prepare('SELECT * FROM heat WHERE id=?').get(req.params.id);
    if (!heat) return res.status(404).json({ error: 'Heat not found' });
    db.prepare('UPDATE heat SET wind=? WHERE id=?').run(wind ?? null, heat.id);
    broadcastSSE('wind_update', { heat_id: heat.id, wind });
    res.json({ success: true, wind });
});
app.get('/api/heats/:id/wind', (req, res) => {
    const heat = db.prepare('SELECT * FROM heat WHERE id=?').get(req.params.id);
    if (!heat) return res.status(404).json({ error: 'Heat not found' });
    res.json({ heat_id: heat.id, wind: heat.wind });
});

// Rename heat (custom display name)
app.post('/api/heats/:id/rename', (req, res) => {
    const key = req.body.admin_key || req.headers['x-admin-key'] || '';
    if (!isOperationKey(key)) return res.status(403).json({ error: '인증 필요' });
    const heat = db.prepare('SELECT * FROM heat WHERE id=?').get(parseInt(req.params.id));
    if (!heat) return res.status(404).json({ error: 'Heat not found' });
    const heat_name = req.body.heat_name != null ? String(req.body.heat_name).trim() || null : null;
    db.prepare('UPDATE heat SET heat_name=? WHERE id=?').run(heat_name, heat.id);
    broadcastSSE('heat_update', { heat_id: heat.id, event_id: heat.event_id, heat_name });
    res.json({ success: true, heat_id: heat.id, heat_name });
});

// ============================================================
// LIVE RESULTS API — for dashboard real-time view
// ============================================================
app.get('/api/events/:id/live-results', (req, res) => {
    const event = db.prepare('SELECT * FROM event WHERE id=?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    const heats = db.prepare('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number').all(event.id);
    // Also load qualifications if available
    const quals = db.prepare('SELECT * FROM qualification_selection WHERE event_id=? AND selected=1').all(event.id);
    const result = heats.map(h => {
        const entries = db.prepare(`SELECT he.lane_number, he.sub_group, ee.id AS event_entry_id, ee.status,
               a.name, a.bib_number, a.team FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id
               JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=? ORDER BY he.lane_number ASC, CAST(a.bib_number AS INTEGER)`).all(h.id);
        if (event.category === 'field_height') {
            return { ...h, entries, height_attempts: db.prepare('SELECT * FROM height_attempt WHERE heat_id=? ORDER BY bar_height, event_entry_id, attempt_number').all(h.id) };
        }
        return { ...h, entries, results: db.prepare('SELECT * FROM result WHERE heat_id=? ORDER BY event_entry_id, attempt_number').all(h.id) };
    });
    res.json({ event, heats: result, qualifications: quals });
});

// ============================================================
// HEIGHT ATTEMPTS
// ============================================================
app.get('/api/height-attempts', (req, res) => {
    if (!req.query.heat_id) return res.status(400).json({ error: 'heat_id required' });
    res.json(db.prepare(`
        SELECT ha.*, a.name, a.bib_number, a.team
        FROM height_attempt ha JOIN event_entry ee ON ee.id=ha.event_entry_id
        JOIN athlete a ON a.id=ee.athlete_id
        WHERE ha.heat_id=? ORDER BY ha.bar_height, ha.event_entry_id, ha.attempt_number
    `).all(req.query.heat_id));
});
app.post('/api/height-attempts/save', (req, res) => {
    const { heat_id, event_entry_id, bar_height, attempt_number, result_mark } = req.body;
    if (!heat_id || !event_entry_id || !bar_height || !attempt_number)
        return res.status(400).json({ error: 'heat_id, event_entry_id, bar_height, attempt_number required' });

    // Empty mark = delete the attempt (toggle back to empty)
    if (!result_mark || result_mark === '') {
        const existing = db.prepare('SELECT * FROM height_attempt WHERE heat_id=? AND event_entry_id=? AND bar_height=? AND attempt_number=?')
            .get(heat_id, event_entry_id, bar_height, attempt_number);
        if (existing) {
            db.prepare('DELETE FROM height_attempt WHERE id=?').run(existing.id);
            broadcastSSE('height_update', { heat_id, event_entry_id, bar_height });
        }
        return res.json({ success: true, deleted: true });
    }

    // Normalize: accept both '-' and 'PASS' as pass mark, store as 'PASS' (DB constraint)
    let normalizedMark = result_mark;
    if (normalizedMark === '-') normalizedMark = 'PASS';
    // Auto-update round_status to in_progress when first height attempt is saved
    const heat = db.prepare('SELECT * FROM heat WHERE id=?').get(heat_id);
    if (heat) {
        const event = db.prepare('SELECT * FROM event WHERE id=?').get(heat.event_id);
        if (event && (event.round_status === 'heats_generated' || event.round_status === 'created')) {
            db.prepare("UPDATE event SET round_status='in_progress' WHERE id=?").run(event.id);
            broadcastSSE('event_status_changed', { event_id: event.id, round_status: 'in_progress' });
            const gL = event.gender === 'M' ? '남자' : event.gender === 'F' ? '여자' : '혼성';
            const roundL = { preliminary: '예선', semifinal: '준결승', final: '결승' }[event.round_type] || event.round_type;
            opLog(`${event.name} ${roundL} ${gL} 기록 입력 시작 (자동 진행중 전환)`, 'record', 'system', event.competition_id);
        }
        // Also update parent combined event status if this is a sub-event
        if (event && event.parent_event_id) {
            const parentEvt = db.prepare('SELECT * FROM event WHERE id=?').get(event.parent_event_id);
            if (parentEvt && parentEvt.category === 'combined' && (parentEvt.round_status === 'heats_generated' || parentEvt.round_status === 'created')) {
                db.prepare("UPDATE event SET round_status='in_progress' WHERE id=?").run(parentEvt.id);
                broadcastSSE('event_status_changed', { event_id: parentEvt.id, round_status: 'in_progress' });
                opLog(`${parentEvt.name} 기록 입력 시작 (세부종목 자동 진행중 전환)`, 'record', 'system', parentEvt.competition_id);
            }
        }
    }
    try {
        const existing = db.prepare('SELECT * FROM height_attempt WHERE heat_id=? AND event_entry_id=? AND bar_height=? AND attempt_number=?')
            .get(heat_id, event_entry_id, bar_height, attempt_number);
        if (existing) {
            db.prepare('UPDATE height_attempt SET result_mark=? WHERE id=?').run(normalizedMark, existing.id);
            const upd = db.prepare('SELECT * FROM height_attempt WHERE id=?').get(existing.id);
            broadcastSSE('height_update', { heat_id, event_entry_id, bar_height });
            res.json(upd);
        } else {
            const info = db.prepare('INSERT INTO height_attempt (heat_id,event_entry_id,bar_height,attempt_number,result_mark) VALUES (?,?,?,?,?)')
                .run(heat_id, event_entry_id, bar_height, attempt_number, normalizedMark);
            const ins = db.prepare('SELECT * FROM height_attempt WHERE id=?').get(info.lastInsertRowid);
            broadcastSSE('height_update', { heat_id, event_entry_id, bar_height });
            res.json(ins);
        }
    } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// Delete all height attempts for a specific bar_height in a heat
app.post('/api/height-attempts/delete-bar', (req, res) => {
    const { heat_id, bar_height, admin_key } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    if (!heat_id || bar_height == null) return res.status(400).json({ error: 'heat_id and bar_height required' });
    const deleted = db.prepare('DELETE FROM height_attempt WHERE heat_id=? AND bar_height=?').run(heat_id, parseFloat(bar_height));
    broadcastSSE('height_update', { heat_id, bar_height });
    res.json({ success: true, deleted: deleted.changes });
});

// ============================================================
// COMBINED SCORES
// ============================================================
app.get('/api/combined-scores', (req, res) => {
    if (!req.query.event_id) return res.status(400).json({ error: 'event_id required' });
    res.json(db.prepare(`
        SELECT cs.*, a.name, a.bib_number, a.team
        FROM combined_score cs JOIN event_entry ee ON ee.id=cs.event_entry_id
        JOIN athlete a ON a.id=ee.athlete_id
        WHERE ee.event_id=? ORDER BY cs.event_entry_id, cs.sub_event_order
    `).all(req.query.event_id));
});
app.post('/api/combined-scores/save', (req, res) => {
    const { event_entry_id, sub_event_name, sub_event_order, raw_record, wa_points } = req.body;
    if (!event_entry_id || !sub_event_name || !sub_event_order) return res.status(400).json({ error: 'Required fields missing' });
    try {
        const existing = db.prepare('SELECT * FROM combined_score WHERE event_entry_id=? AND sub_event_order=?')
            .get(event_entry_id, sub_event_order);
        if (existing) {
            db.prepare('UPDATE combined_score SET raw_record=?,wa_points=?,sub_event_name=? WHERE id=?')
                .run(raw_record ?? null, wa_points || 0, sub_event_name, existing.id);
            res.json(db.prepare('SELECT * FROM combined_score WHERE id=?').get(existing.id));
        } else {
            const info = db.prepare('INSERT INTO combined_score (event_entry_id,sub_event_name,sub_event_order,raw_record,wa_points) VALUES (?,?,?,?,?)')
                .run(event_entry_id, sub_event_name, sub_event_order, raw_record ?? null, wa_points || 0);
            res.json(db.prepare('SELECT * FROM combined_score WHERE id=?').get(info.lastInsertRowid));
        }
        broadcastSSE('combined_update', { event_entry_id, sub_event_order });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});
app.get('/api/combined-sub-events', (req, res) => {
    if (!req.query.parent_event_id) return res.status(400).json({ error: 'parent_event_id required' });
    res.json(db.prepare('SELECT * FROM event WHERE parent_event_id=? ORDER BY id').all(req.query.parent_event_id));
});
app.post('/api/combined-scores/sync', (req, res) => {
    const { parent_event_id } = req.body;
    if (!parent_event_id) return res.status(400).json({ error: 'parent_event_id required' });
    const parentEvent = db.prepare('SELECT * FROM event WHERE id=?').get(parent_event_id);
    if (!parentEvent || parentEvent.category !== 'combined') return res.status(400).json({ error: 'Not a combined event' });
    const subEvents = db.prepare('SELECT * FROM event WHERE parent_event_id=? ORDER BY id').all(parent_event_id);
    const parentEntries = db.prepare('SELECT ee.id AS event_entry_id, ee.athlete_id FROM event_entry ee WHERE ee.event_id=?').all(parent_event_id);
    let syncCount = 0;
    const upsert = db.prepare(`INSERT INTO combined_score (event_entry_id,sub_event_name,sub_event_order,raw_record,wa_points)
        VALUES (?,?,?,?,?) ON CONFLICT(event_entry_id,sub_event_order) DO UPDATE SET raw_record=excluded.raw_record, wa_points=excluded.wa_points, sub_event_name=excluded.sub_event_name`);
    db.transaction(() => {
        subEvents.forEach((subEvt, idx) => {
            const subOrder = idx + 1;
            const subHeat = db.prepare('SELECT id FROM heat WHERE event_id=? LIMIT 1').get(subEvt.id);
            if (!subHeat) return;
            parentEntries.forEach(pe => {
                const subEntry = db.prepare('SELECT id FROM event_entry WHERE event_id=? AND athlete_id=?').get(subEvt.id, pe.athlete_id);
                if (!subEntry) return;
                let bestRecord = null;
                let hasAttempts = false;
                if (subEvt.category === 'track') {
                    const r = db.prepare('SELECT MIN(time_seconds) AS best FROM result WHERE heat_id=? AND event_entry_id=? AND time_seconds > 0').get(subHeat.id, subEntry.id);
                    if (r && r.best) bestRecord = r.best;
                    // Check if athlete has any result rows (including DNS/DNF/NM)
                    const cnt = db.prepare('SELECT COUNT(*) AS c FROM result WHERE heat_id=? AND event_entry_id=?').get(subHeat.id, subEntry.id);
                    if (cnt && cnt.c > 0) hasAttempts = true;
                } else if (subEvt.category === 'field_distance') {
                    const r = db.prepare('SELECT MAX(distance_meters) AS best FROM result WHERE heat_id=? AND event_entry_id=? AND distance_meters > 0').get(subHeat.id, subEntry.id);
                    if (r && r.best) bestRecord = r.best;
                    // NM check: has attempts but all fouls (distance=0)
                    const cnt = db.prepare('SELECT COUNT(*) AS c FROM result WHERE heat_id=? AND event_entry_id=? AND attempt_number IS NOT NULL').get(subHeat.id, subEntry.id);
                    if (cnt && cnt.c > 0) hasAttempts = true;
                } else if (subEvt.category === 'field_height') {
                    const r = db.prepare("SELECT MAX(bar_height) AS best FROM height_attempt WHERE heat_id=? AND event_entry_id=? AND result_mark='O'").get(subHeat.id, subEntry.id);
                    if (r && r.best) bestRecord = r.best;
                    // NM check: has height attempts but no clearance (all X or PASS)
                    const cnt = db.prepare('SELECT COUNT(*) AS c FROM height_attempt WHERE heat_id=? AND event_entry_id=?').get(subHeat.id, subEntry.id);
                    if (cnt && cnt.c > 0) hasAttempts = true;
                }
                if (bestRecord != null) {
                    const waKeys = parentEvent.gender === 'M' ? DECATHLON_KEYS : HEPTATHLON_KEYS;
                    const waKey = waKeys[subOrder - 1];
                    const waPoints = waKey ? calcWAPoints(waKey, bestRecord) : 0;
                    upsert.run(pe.event_entry_id, subEvt.name, subOrder, bestRecord, waPoints);
                    syncCount++;
                } else if (hasAttempts) {
                    // NM (No Mark): athlete attempted but has no valid record → 0 points
                    upsert.run(pe.event_entry_id, subEvt.name, subOrder, 0, 0);
                    syncCount++;
                }
            });
        });
    })();
    res.json({ success: true, synced: syncCount });
});

// ============================================================
// CALLROOM
// ============================================================
app.get('/api/barcode/:code', (req, res) => {
    const a = db.prepare('SELECT * FROM athlete WHERE barcode=?').get(req.params.code);
    if (!a) return res.status(404).json({ error: 'Barcode not found' });
    res.json(a);
});
app.patch('/api/event-entries/:id/status', (req, res) => {
    const { status } = req.body;
    if (!['registered', 'checked_in', 'no_show'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const entry = db.prepare('SELECT * FROM event_entry WHERE id=?').get(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not found' });
    db.prepare('UPDATE event_entry SET status=? WHERE id=?').run(status, req.params.id);
    syncCombinedSubEventCheckin(entry.event_id, entry.athlete_id, status);
    broadcastSSE('entry_status', { event_entry_id: entry.id, status });
    res.json(db.prepare('SELECT * FROM event_entry WHERE id=?').get(req.params.id));
});
app.post('/api/callroom/checkin', (req, res) => {
    const { barcode, event_id } = req.body;
    if (!barcode) return res.status(400).json({ error: 'barcode required' });
    // Search by barcode first, then by bib_number
    let athlete = db.prepare('SELECT * FROM athlete WHERE barcode=?').get(barcode);
    if (!athlete) athlete = db.prepare('SELECT * FROM athlete WHERE bib_number=?').get(barcode);
    if (!athlete) {
        // Try stripping PR2026 prefix and search bib
        const stripped = barcode.replace(/^PR\d{4}/, '');
        if (stripped) athlete = db.prepare('SELECT * FROM athlete WHERE bib_number=?').get(stripped);
    }
    if (!athlete) return res.status(404).json({ error: '선수를 찾을 수 없습니다', barcode });
    let entry;
    if (event_id) {
        entry = db.prepare('SELECT * FROM event_entry WHERE event_id=? AND athlete_id=?').get(event_id, athlete.id);
        if (!entry) {
            // Maybe different heat of the same event — search all entries for this athlete in this event's heats
            const evt = db.prepare('SELECT * FROM event WHERE id=?').get(event_id);
            if (evt) {
                // Search across all events with same parent or same event
                const allEntries = db.prepare('SELECT ee.*, e.name as event_name FROM event_entry ee JOIN event e ON ee.event_id=e.id WHERE ee.athlete_id=? AND e.competition_id=?').all(athlete.id, evt.competition_id);
                if (allEntries.length > 0) {
                    // Find entry that is not yet checked_in (prefer registered)
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
        broadcastSSE('entry_status', { event_entry_id: entry.id, status: 'checked_in' });
    }
    
    // Find heat info for the entry (for auto-heat-switch on client)
    const heatEntry = db.prepare(`SELECT he.heat_id, h.heat_number FROM heat_entry he JOIN heat h ON he.heat_id=h.id WHERE he.event_entry_id=?`).get(entry.id);
    
    res.json({ 
        success: true, already: wasAlready, athlete, 
        entry: { ...entry, status: 'checked_in' },
        heat_id: heatEntry ? heatEntry.heat_id : null,
        heat_number: heatEntry ? heatEntry.heat_number : null,
        event_id: entry.event_id
    });
});

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
app.post('/api/combined/sync-checkin', (req, res) => {
    const { event_id } = req.body;
    if (!event_id) return res.status(400).json({ error: 'event_id required' });
    const evt = db.prepare('SELECT * FROM event WHERE id=?').get(event_id);
    if (!evt || evt.category !== 'combined') return res.status(400).json({ error: 'Not a combined event' });
    const parentEntries = db.prepare('SELECT * FROM event_entry WHERE event_id=?').all(event_id);
    const subEvents = db.prepare('SELECT id FROM event WHERE parent_event_id=?').all(event_id);
    let synced = 0;
    db.transaction(() => {
        for (const pe of parentEntries) {
            for (const sub of subEvents) {
                const subEntry = db.prepare('SELECT * FROM event_entry WHERE event_id=? AND athlete_id=?').get(sub.id, pe.athlete_id);
                if (subEntry && subEntry.status !== pe.status) {
                    db.prepare('UPDATE event_entry SET status=? WHERE id=?').run(pe.status, subEntry.id);
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
app.get('/api/qualifications', (req, res) => {
    if (!req.query.event_id) return res.status(400).json({ error: 'event_id required' });
    res.json(db.prepare(`SELECT qs.*, a.name, a.bib_number, a.team FROM qualification_selection qs
        JOIN event_entry ee ON ee.id=qs.event_entry_id JOIN athlete a ON a.id=ee.athlete_id WHERE qs.event_id=?`).all(req.query.event_id));
});
app.post('/api/qualifications/save', (req, res) => {
    const { event_id, selections } = req.body;
    if (!event_id || !selections) return res.status(400).json({ error: 'Missing fields' });
    const upsert = db.prepare(`INSERT INTO qualification_selection (event_id,event_entry_id,selected,qualification_type) VALUES (?,?,?,?)
        ON CONFLICT(event_id,event_entry_id) DO UPDATE SET selected=excluded.selected, qualification_type=excluded.qualification_type, updated_at=datetime('now')`);
    db.transaction(() => { for (const s of selections) upsert.run(event_id, s.event_entry_id, s.selected ? 1 : 0, s.qualification_type || ''); })();
    res.json({ success: true });
});
app.post('/api/qualifications/approve', (req, res) => {
    const { event_id } = req.body;
    if (!event_id) return res.status(400).json({ error: 'event_id required' });
    db.prepare("UPDATE qualification_selection SET approved=1,approved_by='admin',updated_at=datetime('now') WHERE event_id=? AND selected=1").run(event_id);
    res.json({ success: true });
});

// ============================================================
// ROUND MANAGEMENT
// ============================================================
app.post('/api/events/:id/complete', (req, res) => {
    const { judge_name, admin_key } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '유효하지 않은 운영키입니다.' });
    if (!judge_name || !judge_name.trim()) return res.status(400).json({ error: 'Judge name required' });
    const event = db.prepare('SELECT * FROM event WHERE id=?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (event.round_status === 'completed') return res.status(400).json({ error: '이미 완료된 경기입니다.' });
    if (event.round_status !== 'in_progress') return res.status(400).json({ error: '진행 중인 경기만 완료 처리할 수 있습니다.' });
    db.prepare("UPDATE event SET round_status='completed' WHERE id=?").run(event.id);
    broadcastSSE('event_completed', { event_id: event.id, judge_name });
    const gL = event.gender === 'M' ? '남자' : event.gender === 'F' ? '여자' : '혼성';
    const roundL = { preliminary: '예선', semifinal: '준결승', final: '결승' }[event.round_type] || event.round_type;
    opLog(`${event.name} ${roundL} 경기완료 - ${judge_name}`, 'completion', judge_name, event.competition_id);
    res.json({ success: true, event: db.prepare('SELECT * FROM event WHERE id=?').get(event.id) });
});
app.post('/api/events/:id/revert-complete', (req, res) => {
    const { admin_key } = req.body;
    if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    const event = db.prepare('SELECT * FROM event WHERE id=?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (event.round_status !== 'completed') return res.status(400).json({ error: '완료 상태의 경기만 되돌릴 수 있습니다.' });
    db.prepare("UPDATE event SET round_status='in_progress' WHERE id=?").run(event.id);
    broadcastSSE('event_reverted', { event_id: event.id });
    opLog(`${event.name} 경기완료 취소 (관리자)`, 'revert', 'admin', event.competition_id);
    res.json({ success: true, event: db.prepare('SELECT * FROM event WHERE id=?').get(event.id) });
});
app.post('/api/events/:id/callroom-complete', (req, res) => {
    const { judge_name, heat_id } = req.body;
    const event = db.prepare('SELECT * FROM event WHERE id=?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (event.round_status === 'completed') return res.status(400).json({ error: '이미 완료된 경기입니다.' });
    // Allow multiple callroom-complete calls for different heats (예선 1조, 2조, etc.)
    if (event.round_status !== 'in_progress') {
        db.prepare("UPDATE event SET round_status='in_progress' WHERE id=?").run(event.id);
    }
    const performer = judge_name || 'operator';
    const roundL = { preliminary: '예선', semifinal: '준결승', final: '결승' }[event.round_type] || event.round_type;
    // If heat_id provided, identify which heat number
    let heatLabel = '';
    if (heat_id) {
        const heats = db.prepare('SELECT id FROM heat WHERE event_id=? ORDER BY heat_number').all(event.id);
        const heatIdx = heats.findIndex(h => h.id === parseInt(heat_id));
        if (heatIdx >= 0) heatLabel = ` ${heatIdx + 1}조`;
    }
    audit('event', event.id, 'UPDATE', { round_status: event.round_status }, { action: 'callroom_complete', round_status: 'in_progress', heat_id: heat_id || null }, performer, event.competition_id);
    broadcastSSE('callroom_complete', { event_id: event.id, judge_name: performer, heat_id: heat_id || null });
    opLog(`${event.name} ${roundL}${heatLabel} 소집 완료 - ${performer}`, 'callroom', performer, event.competition_id);
    res.json({ success: true });
});
app.post('/api/events/:id/create-final', (req, res) => {
    const event = db.prepare('SELECT * FROM event WHERE id=?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    const existingFinal = db.prepare("SELECT id FROM event WHERE name=? AND gender=? AND category=? AND round_type='final' AND competition_id=? AND parent_event_id IS NULL AND id!=?")
        .get(event.name, event.gender, event.category, event.competition_id, event.id);
    if (existingFinal) return res.status(400).json({ error: '이미 결승이 존재합니다.' });
    const qualified = db.prepare(`SELECT event_entry_id, qualification_type FROM qualification_selection WHERE event_id=? AND selected=1 AND approved=1`).all(event.id);
    if (qualified.length === 0) return res.status(400).json({ error: 'No approved qualifiers' });

    const isShortTrack_ = isShortTrackEvent(event.name);
    // For finals, check if we need multiple heats (>8 athletes for ≤800m)
    const { group_count: finalGroupCount } = req.body;
    const numHeats = finalGroupCount || 1;

    const info = db.prepare(`INSERT INTO event (competition_id,name,category,gender,round_type,round_status) VALUES (?,?,?,?,'final','created')`)
        .run(event.competition_id, event.name, event.category, event.gender);
    const finalEventId = info.lastInsertRowid;

    // Build athlete data for WA seeding — with best performance for sorting
    const qualSels = qualified.map(q => {
        const origEntry = db.prepare('SELECT * FROM event_entry WHERE id=?').get(q.event_entry_id);
        if (!origEntry) return { event_entry_id: q.event_entry_id, athlete_id: null, qualification_type: q.qualification_type || '', perf: Infinity };
        // Get best performance across all heats of the source event
        let bestPerf = Infinity;
        const heats = db.prepare('SELECT id FROM heat WHERE event_id=?').all(event.id);
        for (const h of heats) {
            const entryInHeat = db.prepare('SELECT id FROM heat_entry WHERE heat_id=? AND event_entry_id=?').get(h.id, q.event_entry_id);
            if (!entryInHeat) continue;
            if (event.category === 'track' || event.category === 'relay' || event.category === 'road') {
                const r = db.prepare('SELECT MIN(time_seconds) AS best FROM result WHERE heat_id=? AND event_entry_id=? AND time_seconds > 0').get(h.id, q.event_entry_id);
                if (r && r.best != null && r.best < bestPerf) bestPerf = r.best;
            } else if (event.category === 'field_distance') {
                const r = db.prepare('SELECT MAX(distance_meters) AS best FROM result WHERE heat_id=? AND event_entry_id=? AND distance_meters > 0').get(h.id, q.event_entry_id);
                if (r && r.best) bestPerf = -r.best; // negate so ascending sort = best first
            } else if (event.category === 'field_height') {
                const r = db.prepare("SELECT MAX(bar_height) AS best FROM height_attempt WHERE heat_id=? AND event_entry_id=? AND result_mark='O'").get(h.id, q.event_entry_id);
                if (r && r.best) bestPerf = -r.best;
            }
        }
        return { event_entry_id: q.event_entry_id, athlete_id: origEntry.athlete_id, qualification_type: q.qualification_type || '', perf: bestPerf };
    });

    // Sort by performance: ascending (fastest/best first)
    qualSels.sort((a, b) => a.perf - b.perf);

    if (numHeats === 1) {
        const heatInfo = db.prepare('INSERT INTO heat (event_id,heat_number) VALUES (?,1)').run(finalEventId);
        // WA lane assignment for single heat
        qualSels.forEach((ath, idx) => {
            const newEntry = db.prepare("INSERT INTO event_entry (event_id,athlete_id,status) VALUES (?,?,'registered')").run(finalEventId, ath.athlete_id);
            const lane = waAssignLane(idx, qualSels.length, isShortTrack_);
            db.prepare('INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES (?,?,?)').run(heatInfo.lastInsertRowid, newEntry.lastInsertRowid, lane);
        });
    } else {
        // Multi-heat final with WA seeding
        const seeded = waSeededDistribution(event, qualSels, numHeats, db);
        for (let g = 0; g < numHeats; g++) {
            const heatInfo = db.prepare('INSERT INTO heat (event_id,heat_number) VALUES (?,?)').run(finalEventId, g + 1);
            const groupAthletes = seeded[g] || [];
            // Sort within group by performance for correct WA lane assignment
            groupAthletes.sort((a, b) => a.perf - b.perf);
            groupAthletes.forEach((ath, idx) => {
                const newEntry = db.prepare("INSERT INTO event_entry (event_id,athlete_id,status) VALUES (?,?,'registered')").run(finalEventId, ath.athlete_id);
                const lane = waAssignLane(idx, groupAthletes.length, isShortTrack_);
                db.prepare('INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES (?,?,?)').run(heatInfo.lastInsertRowid, newEntry.lastInsertRowid, lane);
            });
        }
    }
    opLog(`${event.name} ${event.gender === 'M' ? '남자' : '여자'} 결승 라운드 생성 (${qualified.length}명 진출)`, 'round', 'system', event.competition_id);
    res.json({ success: true, final_event_id: finalEventId, count: qualified.length });
});
app.post('/api/events/:id/create-semifinal', (req, res) => {
    const event = db.prepare('SELECT * FROM event WHERE id=?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    const existingSemi = db.prepare("SELECT id FROM event WHERE name=? AND gender=? AND category=? AND round_type='semifinal' AND competition_id=? AND parent_event_id IS NULL")
        .get(event.name, event.gender, event.category, event.competition_id);
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
    db.transaction(() => {
        const upsertQ = db.prepare(`INSERT INTO qualification_selection (event_id,event_entry_id,selected,approved,approved_by,qualification_type) VALUES (?,?,1,1,'admin',?)
            ON CONFLICT(event_id,event_entry_id) DO UPDATE SET selected=1,approved=1,qualification_type=excluded.qualification_type`);
        for (const sel of qualifiedSels) {
            upsertQ.run(event.id, sel.event_entry_id, sel.qualification_type || '');
        }
        const info = db.prepare(`INSERT INTO event (competition_id,name,category,gender,round_type,round_status) VALUES (?,?,?,?,'semifinal','heats_generated')`)
            .run(event.competition_id, event.name, event.category, event.gender);
        semiEventId = info.lastInsertRowid;

        // WA serpentine seeding: sort athletes by performance, distribute in zigzag
        const seeded = waSeededDistribution(event, qualifiedSels, group_count, db);
        for (let g = 0; g < group_count; g++) {
            const heatInfo = db.prepare('INSERT INTO heat (event_id,heat_number) VALUES (?,?)').run(semiEventId, g + 1);
            const groupAthletes = seeded[g] || [];
            // Sort within group by performance for correct WA lane assignment
            groupAthletes.sort((a, b) => a.perf - b.perf);
            groupAthletes.forEach((ath, idx) => {
                const newEntry = db.prepare("INSERT INTO event_entry (event_id,athlete_id,status) VALUES (?,?,'registered')").run(semiEventId, ath.athlete_id);
                const lane = waAssignLane(idx, groupAthletes.length, isShortTrack);
                db.prepare('INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES (?,?,?)').run(heatInfo.lastInsertRowid, newEntry.lastInsertRowid, lane);
            });
        }
    })();
    opLog(`${event.name} 준결승 생성 (${qualifiedIds.length}명, ${group_count}개 조)`, 'round', 'system', event.competition_id);
    res.json({ success: true, semi_event_id: semiEventId, count: qualifiedIds.length });
});
app.delete('/api/events/:id', (req, res) => {
    const { admin_key } = req.body;
    if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    const event = db.prepare('SELECT * FROM event WHERE id=?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (event.round_type === 'preliminary' && !event.parent_event_id) return res.status(400).json({ error: '예선은 삭제할 수 없습니다.' });
    db.transaction(() => {
        const heats = db.prepare('SELECT id FROM heat WHERE event_id=?').all(event.id);
        for (const h of heats) {
            db.prepare('DELETE FROM result WHERE heat_id=?').run(h.id);
            db.prepare('DELETE FROM height_attempt WHERE heat_id=?').run(h.id);
            db.prepare('DELETE FROM heat_entry WHERE heat_id=?').run(h.id);
        }
        db.prepare('DELETE FROM heat WHERE event_id=?').run(event.id);
        db.prepare('DELETE FROM relay_member WHERE event_entry_id IN (SELECT id FROM event_entry WHERE event_id=?)').run(event.id);
        db.prepare('DELETE FROM event_entry WHERE event_id=?').run(event.id);
        db.prepare('DELETE FROM qualification_selection WHERE event_id=?').run(event.id);
        db.prepare('DELETE FROM event WHERE id=?').run(event.id);
    })();
    res.json({ success: true });
});
app.post('/api/lanes/assign', (req, res) => {
    const { heat_id, assignments } = req.body;
    if (!heat_id || !assignments) return res.status(400).json({ error: 'Missing fields' });
    const upd = db.prepare('UPDATE heat_entry SET lane_number=? WHERE heat_id=? AND event_entry_id=?');
    db.transaction(() => { for (const a of assignments) upd.run(a.lane_number, heat_id, a.event_entry_id); })();
    res.json({ success: true });
});

// Update heat entries — batch move athletes between heats and update lane numbers
app.post('/api/admin/heats/update-entries', (req, res) => {
    const { heat_id, entries, admin_key } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    if (!heat_id || !entries) return res.status(400).json({ error: 'Missing fields' });
    const upd = db.prepare('UPDATE heat_entry SET lane_number=? WHERE heat_id=? AND event_entry_id=?');
    db.transaction(() => { for (const e of entries) upd.run(e.lane_number, heat_id, e.event_entry_id); })();
    res.json({ success: true });
});

// Update sub_group (A/B) for a heat entry
app.post('/api/admin/heat-entry/set-group', (req, res) => {
    const { heat_entry_id, event_entry_id, heat_id, sub_group, admin_key } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    const g = sub_group ? String(sub_group).toUpperCase() : null;
    if (heat_entry_id) {
        db.prepare('UPDATE heat_entry SET sub_group=? WHERE id=?').run(g, heat_entry_id);
    } else if (heat_id && event_entry_id) {
        db.prepare('UPDATE heat_entry SET sub_group=? WHERE heat_id=? AND event_entry_id=?').run(g, heat_id, event_entry_id);
    } else {
        return res.status(400).json({ error: 'heat_entry_id or (heat_id + event_entry_id) required' });
    }
    res.json({ success: true, sub_group: g });
});

// ============================================================
// ROUND STATUS
// ============================================================
app.get('/api/round-status', (req, res) => {
    const compId = req.query.competition_id;
    let q = 'SELECT * FROM event WHERE parent_event_id IS NULL';
    const p = [];
    if (compId) { q += ' AND competition_id=?'; p.push(compId); }
    q += ' ORDER BY sort_order, id';
    const events = db.prepare(q).all(...p);
    const result = events.map(e => {
        const heats = db.prepare('SELECT id FROM heat WHERE event_id=?').all(e.id);
        let totalEntries = 0, totalResults = 0;
        for (const h of heats) {
            totalEntries += db.prepare('SELECT COUNT(*) AS c FROM heat_entry WHERE heat_id=?').get(h.id).c;
            totalResults += db.prepare('SELECT COUNT(DISTINCT event_entry_id) AS c FROM result WHERE heat_id=?').get(h.id).c;
        }
        return { ...e, heat_count: heats.length, total_entries: totalEntries, total_results: totalResults };
    });
    res.json(result);
});

// ============================================================
// FULL RESULTS EXPORT
// ============================================================
app.get('/api/events/:id/full-results', (req, res) => {
    const event = db.prepare('SELECT * FROM event WHERE id=?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    const heats = db.prepare('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number').all(event.id);
    const quals = db.prepare('SELECT * FROM qualification_selection WHERE event_id=? AND selected=1').all(event.id);
    const result = heats.map(h => {
        const entries = db.prepare(`SELECT he.lane_number, he.sub_group, ee.id AS event_entry_id, ee.status,
               a.name, a.bib_number, a.team FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id
               JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=? ORDER BY he.lane_number ASC, CAST(a.bib_number AS INTEGER)`).all(h.id);
        if (event.category === 'field_height') {
            return { ...h, entries, height_attempts: db.prepare('SELECT * FROM height_attempt WHERE heat_id=? ORDER BY bar_height, event_entry_id, attempt_number').all(h.id) };
        }
        return { ...h, entries, results: db.prepare('SELECT * FROM result WHERE heat_id=? ORDER BY event_entry_id, attempt_number').all(h.id) };
    });
    res.json({ event, heats: result, qualifications: quals });
});

// ============================================================
// LOGS
// ============================================================
app.get('/api/audit-log', (req, res) => {
    const compId = req.query.competition_id;
    if (compId) return res.json(db.prepare('SELECT * FROM audit_log WHERE competition_id=? ORDER BY created_at DESC LIMIT 30').all(compId));
    res.json(db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 30').all());
});
app.get('/api/operation-log', (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const compId = req.query.competition_id;
    if (compId) return res.json(db.prepare('SELECT * FROM operation_log WHERE competition_id=? ORDER BY created_at DESC LIMIT ?').all(compId, limit));
    res.json(db.prepare('SELECT * FROM operation_log ORDER BY created_at DESC LIMIT ?').all(limit));
});

// ============================================================
// HEAT ENTRY — add athlete to heat (for post-heat-creation additions)
// ============================================================
app.post('/api/heat-entries/add', (req, res) => {
    const { heat_id, athlete_id, event_id } = req.body;
    if (!heat_id || !athlete_id || !event_id) return res.status(400).json({ error: 'heat_id, athlete_id, event_id required' });
    // Validate heat belongs to the correct event
    const heat = db.prepare('SELECT * FROM heat WHERE id=?').get(heat_id);
    if (!heat) return res.status(404).json({ error: 'Heat not found' });
    if (heat.event_id !== parseInt(event_id)) return res.status(400).json({ error: '조가 해당 종목에 속하지 않습니다.' });
    // Ensure event_entry exists (or create)
    let entry = db.prepare('SELECT * FROM event_entry WHERE event_id=? AND athlete_id=?').get(event_id, athlete_id);
    if (!entry) {
        const info = db.prepare('INSERT INTO event_entry (event_id, athlete_id) VALUES (?, ?)').run(event_id, athlete_id);
        entry = db.prepare('SELECT * FROM event_entry WHERE id=?').get(info.lastInsertRowid);
    }
    // Check if already in heat
    const existing = db.prepare('SELECT * FROM heat_entry WHERE heat_id=? AND event_entry_id=?').get(heat_id, entry.id);
    if (existing) return res.json({ success: true, already: true, entry });
    // Add to heat with next lane number
    const maxLane = db.prepare('SELECT MAX(lane_number) AS mx FROM heat_entry WHERE heat_id=?').get(heat_id).mx || 0;
    db.prepare('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?, ?, ?)').run(heat_id, entry.id, maxLane + 1);
    broadcastSSE('entry_status', { event_entry_id: entry.id, status: entry.status });
    res.json({ success: true, entry });
});

// Relay team members — relay_member table only (no fallback to avoid wrong data)
app.get('/api/relay-members', (req, res) => {
    const { event_id, team, event_entry_id } = req.query;
    if (!event_id && !event_entry_id) return res.status(400).json({ error: 'event_id or event_entry_id required' });
    
    let entryId = event_entry_id;
    if (!entryId && event_id && team) {
        const evt = db.prepare('SELECT * FROM event WHERE id=?').get(event_id);
        if (!evt) return res.status(404).json({ error: 'Event not found' });
        const teamEntry = db.prepare(`
            SELECT ee.id FROM event_entry ee
            JOIN athlete a ON a.id = ee.athlete_id
            WHERE ee.event_id = ? AND a.name = ?
        `).get(event_id, team);
        if (!teamEntry) return res.json([]);
        entryId = teamEntry.id;
    }
    if (!entryId) return res.json([]);
    
    // Return only athletes registered in relay_member for this entry
    const members = db.prepare(`
        SELECT a.*, rm.leg_order, rm.event_entry_id FROM relay_member rm
        JOIN athlete a ON a.id = rm.athlete_id
        WHERE rm.event_entry_id = ?
        ORDER BY rm.leg_order, CAST(a.bib_number AS INTEGER)
    `).all(entryId);
    res.json(members);
});

// Relay members batch — all relay members for all teams in one event
app.get('/api/relay-members/batch', (req, res) => {
    const eventId = parseInt(req.query.event_id);
    if (!eventId) return res.status(400).json({ error: 'event_id required' });
    
    // Get all event_entries for this relay event
    const entries = db.prepare(`
        SELECT ee.id AS event_entry_id, a.name AS team_name, a.id AS athlete_id
        FROM event_entry ee JOIN athlete a ON a.id = ee.athlete_id
        WHERE ee.event_id = ?
    `).all(eventId);
    
    // For each entry, fetch relay members
    const result = {};
    for (const entry of entries) {
        const members = db.prepare(`
            SELECT a.id, a.name, a.team, a.bib_number, a.gender, rm.leg_order
            FROM relay_member rm JOIN athlete a ON a.id = rm.athlete_id
            WHERE rm.event_entry_id = ?
            ORDER BY rm.leg_order, a.name
        `).all(entry.event_entry_id);
        if (members.length > 0) {
            result[entry.event_entry_id] = { team_name: entry.team_name, members };
        }
    }
    res.json(result);
});

// Relay member management APIs
app.post('/api/relay-members', (req, res) => {
    const { event_entry_id, athlete_id, leg_order } = req.body;
    if (!event_entry_id || !athlete_id) return res.status(400).json({ error: 'event_entry_id and athlete_id required' });
    try {
        db.prepare('INSERT OR IGNORE INTO relay_member (event_entry_id, athlete_id, leg_order) VALUES (?,?,?)').run(event_entry_id, athlete_id, leg_order || null);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/relay-members', (req, res) => {
    const { event_entry_id, athlete_id } = req.body;
    if (!event_entry_id || !athlete_id) return res.status(400).json({ error: 'event_entry_id and athlete_id required' });
    db.prepare('DELETE FROM relay_member WHERE event_entry_id=? AND athlete_id=?').run(event_entry_id, athlete_id);
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
app.get('/api/public/events', (req, res) => {
    const compId = req.query.competition_id;
    if (compId) return res.json(db.prepare("SELECT * FROM event WHERE competition_id=? AND parent_event_id IS NULL ORDER BY sort_order, id").all(compId));
    res.json(db.prepare("SELECT * FROM event WHERE parent_event_id IS NULL ORDER BY sort_order, id").all());
});
app.get('/api/public/callroom-status', (req, res) => {
    const logs = db.prepare("SELECT * FROM audit_log WHERE table_name='event' AND new_values LIKE '%callroom_complete%' ORDER BY created_at DESC LIMIT 50").all();
    const completedIds = new Set();
    logs.forEach(l => { try { const nv = JSON.parse(l.new_values); if (nv && nv.action === 'callroom_complete') completedIds.add(l.record_id); } catch {} });
    res.json({ completed_event_ids: Array.from(completedIds) });
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
app.get('/api/registered-judges', (req, res) => {
    const judges = db.prepare('SELECT judge_name FROM operation_key WHERE active=1 ORDER BY judge_name').all();
    res.json(judges.map(j => j.judge_name));
});

// Multi-key CRUD
app.get('/api/admin/operation-keys', (req, res) => {
    if (!isAdminKey(req.query.key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    res.json(db.prepare('SELECT id, judge_name, key_value, role, can_manage, active, created_at FROM operation_key ORDER BY created_at DESC').all());
});
app.post('/api/admin/operation-keys', (req, res) => {
    const { admin_key, judge_name, key_value, can_manage } = req.body;
    if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    if (!judge_name || !key_value || key_value.length < 4) return res.status(400).json({ error: '심판명과 키(4자 이상)를 입력하세요.' });
    try {
        const info = db.prepare('INSERT INTO operation_key (judge_name, key_value, can_manage) VALUES (?, ?, ?)').run(judge_name, key_value, can_manage ? 1 : 0);
        opLog(`운영키 생성: ${judge_name}${can_manage ? ' (관리권한)' : ''}`, 'admin', 'admin');
        res.json(db.prepare('SELECT * FROM operation_key WHERE id=?').get(info.lastInsertRowid));
    } catch (e) { res.status(400).json({ error: '키가 중복되었습니다.' }); }
});
app.delete('/api/admin/operation-keys/:id', (req, res) => {
    const { admin_key } = req.body;
    if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    const key = db.prepare('SELECT * FROM operation_key WHERE id=?').get(req.params.id);
    if (!key) return res.status(404).json({ error: 'Not found' });
    db.prepare('DELETE FROM operation_key WHERE id=?').run(req.params.id);
    opLog(`운영키 삭제: ${key.judge_name}`, 'admin', 'admin');
    res.json({ success: true });
});

// ============================================================
// SITE CONFIG (editable install guide, manual, about texts & links)
// ============================================================
app.get('/api/site-config', (req, res) => {
    // Public: returns all site_* config keys
    const rows = db.prepare("SELECT key, value FROM system_config WHERE key LIKE 'site_%'").all();
    const config = {};
    rows.forEach(r => { config[r.key] = r.value; });
    res.json(config);
});
app.post('/api/admin/site-config', (req, res) => {
    const { admin_key, configs } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '운영키가 필요합니다.' });
    if (!configs || typeof configs !== 'object') return res.status(400).json({ error: 'configs object required' });
    const upsert = db.prepare('INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)');
    const tx = db.transaction(() => {
        for (const [k, v] of Object.entries(configs)) {
            if (k.startsWith('site_')) upsert.run(k, String(v));
        }
    });
    tx();
    opLog('사이트 설정 업데이트', 'admin', 'admin');
    res.json({ success: true });
});
app.patch('/api/admin/operation-keys/:id', (req, res) => {
    const { admin_key, active, can_manage } = req.body;
    if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    const key = db.prepare('SELECT * FROM operation_key WHERE id=?').get(req.params.id);
    if (!key) return res.status(404).json({ error: 'Not found' });
    const newActive = active !== undefined ? (active ? 1 : 0) : key.active;
    const newCanManage = can_manage !== undefined ? (can_manage ? 1 : 0) : key.can_manage;
    db.prepare('UPDATE operation_key SET active=?, can_manage=? WHERE id=?').run(newActive, newCanManage, req.params.id);
    const updated = db.prepare('SELECT * FROM operation_key WHERE id=?').get(req.params.id);
    if (can_manage !== undefined) {
        opLog(`${key.judge_name} 심판 권한 변경: ${newCanManage ? '관리자' : '운영'}`, 'admin', 'admin');
    }
    res.json(updated);
});

// ============================================================
// PUBLIC: Athletes by competition (callroom / record use)
// ============================================================
app.get('/api/athletes', (req, res) => {
    const compId = req.query.competition_id;
    if (!compId) return res.status(400).json({ error: 'competition_id 필요' });
    res.json(db.prepare('SELECT * FROM athlete WHERE competition_id=? ORDER BY CAST(bib_number AS INTEGER)').all(compId));
});

// ============================================================
// ADMIN: ATHLETE CRUD (scoped to competition)
// ============================================================
app.get('/api/admin/athletes', (req, res) => {
    if (!isAdminKey(req.query.key) && !isOperationKey(req.query.key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    const compId = req.query.competition_id;
    if (compId) return res.json(db.prepare('SELECT * FROM athlete WHERE competition_id=? ORDER BY CAST(bib_number AS INTEGER)').all(compId));
    res.json(db.prepare('SELECT * FROM athlete ORDER BY CAST(bib_number AS INTEGER)').all());
});
app.post('/api/admin/athletes', (req, res) => {
    const { admin_key, competition_id, name, bib_number, team, gender, barcode } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    if (!name || !gender || !competition_id) return res.status(400).json({ error: '필수 항목이 누락되었습니다 (이름, 성별, 대회ID).' });
    try {
        const bib = bib_number ? String(bib_number).trim() : null;
        const bc = barcode || '';
        const info = db.prepare('INSERT INTO athlete (competition_id,name,bib_number,team,barcode,gender) VALUES (?,?,?,?,?,?)')
            .run(competition_id, name, bib, team || '', bc, gender);
        res.json(db.prepare('SELECT * FROM athlete WHERE id=?').get(info.lastInsertRowid));
    } catch (e) { res.status(400).json({ error: '등록 오류: ' + e.message }); }
});
app.put('/api/admin/athletes/:id', (req, res) => {
    const { admin_key, name, bib_number, team, gender, barcode } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    const old = db.prepare('SELECT * FROM athlete WHERE id=?').get(req.params.id);
    if (!old) return res.status(404).json({ error: 'Not found' });
    try {
        const newBib = bib_number !== undefined ? (bib_number ? String(bib_number).trim() : null) : old.bib_number;
        db.prepare('UPDATE athlete SET name=?,bib_number=?,team=?,gender=?,barcode=? WHERE id=?')
            .run(name || old.name, newBib, team ?? old.team, gender || old.gender, barcode ?? old.barcode, old.id);
        res.json(db.prepare('SELECT * FROM athlete WHERE id=?').get(old.id));
    } catch (e) { res.status(400).json({ error: '수정 오류: ' + e.message }); }
});
app.delete('/api/admin/athletes/:id', (req, res) => {
    const { admin_key } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    const ath = db.prepare('SELECT * FROM athlete WHERE id=?').get(req.params.id);
    if (!ath) return res.status(404).json({ error: 'Not found' });
    db.transaction(() => {
        const entries = db.prepare('SELECT id FROM event_entry WHERE athlete_id=?').all(ath.id);
        for (const e of entries) {
            db.prepare('DELETE FROM result WHERE event_entry_id=?').run(e.id);
            db.prepare('DELETE FROM height_attempt WHERE event_entry_id=?').run(e.id);
            db.prepare('DELETE FROM heat_entry WHERE event_entry_id=?').run(e.id);
            db.prepare('DELETE FROM combined_score WHERE event_entry_id=?').run(e.id);
            db.prepare('DELETE FROM qualification_selection WHERE event_entry_id=?').run(e.id);
        }
        db.prepare('DELETE FROM relay_member WHERE event_entry_id IN (SELECT id FROM event_entry WHERE athlete_id=?)').run(ath.id);
        db.prepare('DELETE FROM event_entry WHERE athlete_id=?').run(ath.id);
        db.prepare('DELETE FROM athlete WHERE id=?').run(ath.id);
    })();
    res.json({ success: true });
});

// ---- Athlete ↔ Event Assignment ----
app.get('/api/admin/athletes/:id/events', (req, res) => {
    if (!isAdminKey(req.query.key) && !isOperationKey(req.query.key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    res.json(db.prepare(`
        SELECT ee.id AS event_entry_id, ee.event_id, ee.status, e.name AS event_name, e.category, e.gender, e.round_type
        FROM event_entry ee JOIN event e ON e.id=ee.event_id
        WHERE ee.athlete_id=? ORDER BY e.sort_order, e.id
    `).all(req.params.id));
});
app.post('/api/admin/athletes/:id/events', (req, res) => {
    const { admin_key, event_id } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    const ath = db.prepare('SELECT * FROM athlete WHERE id=?').get(req.params.id);
    if (!ath) return res.status(404).json({ error: 'Athlete not found' });
    const evt = db.prepare('SELECT * FROM event WHERE id=?').get(event_id);
    if (!evt) return res.status(404).json({ error: 'Event not found' });

    // For relay events: add athlete as relay_member to existing team, don't create new team
    if (evt.category === 'relay') {
        // Find existing team entry for this athlete's team
        const teamName = ath.team || ath.name;
        const existingTeamEntry = db.prepare(`
            SELECT ee.id FROM event_entry ee
            JOIN athlete a ON a.id = ee.athlete_id
            WHERE ee.event_id = ? AND a.name = ?
        `).get(event_id, teamName);

        if (existingTeamEntry) {
            // Add as relay member to existing team
            const existingMember = db.prepare('SELECT id FROM relay_member WHERE event_entry_id=? AND athlete_id=?').get(existingTeamEntry.id, ath.id);
            if (existingMember) return res.status(409).json({ error: '이미 등록된 릴레이 멤버입니다.' });
            const maxLeg = db.prepare('SELECT MAX(leg_order) AS mx FROM relay_member WHERE event_entry_id=?').get(existingTeamEntry.id).mx || 0;
            db.prepare('INSERT OR IGNORE INTO relay_member (event_entry_id, athlete_id, leg_order) VALUES (?,?,?)').run(existingTeamEntry.id, ath.id, maxLeg + 1);
            return res.json({ success: true, event_entry_id: existingTeamEntry.id, added_as: 'relay_member' });
        }
        // No existing team → create a dummy team athlete and add this athlete as relay_member
        const rGender = evt.gender === 'X' ? 'M' : evt.gender;
        let teamAthlete = db.prepare('SELECT * FROM athlete WHERE competition_id=? AND name=? AND bib_number=?').get(evt.competition_id, teamName, teamName);
        if (!teamAthlete) {
            const teamInfo = db.prepare('INSERT INTO athlete (competition_id,name,bib_number,team,barcode,gender) VALUES (?,?,?,?,?,?)')
                .run(evt.competition_id, teamName, teamName, teamName, `RELAY_${teamName}`, rGender);
            teamAthlete = db.prepare('SELECT * FROM athlete WHERE id=?').get(teamInfo.lastInsertRowid);
        }
        // Create event_entry for the team
        let teamEntry = db.prepare('SELECT id FROM event_entry WHERE event_id=? AND athlete_id=?').get(event_id, teamAthlete.id);
        if (!teamEntry) {
            const teInfo = db.prepare("INSERT INTO event_entry (event_id,athlete_id,status) VALUES (?,?,'registered')").run(event_id, teamAthlete.id);
            teamEntry = { id: teInfo.lastInsertRowid };
            // Assign to first heat
            let heat = db.prepare('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number LIMIT 1').get(event_id);
            if (!heat) {
                const hInfo = db.prepare('INSERT INTO heat (event_id, heat_number) VALUES (?, 1)').run(event_id);
                heat = { id: hInfo.lastInsertRowid };
            }
            const maxLane = db.prepare('SELECT MAX(lane_number) AS mx FROM heat_entry WHERE heat_id=?').get(heat.id).mx || 0;
            db.prepare('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?, ?, ?)').run(heat.id, teamEntry.id, maxLane + 1);
        }
        // Add the athlete as relay member
        db.prepare('INSERT OR IGNORE INTO relay_member (event_entry_id, athlete_id, leg_order) VALUES (?,?,?)').run(teamEntry.id, ath.id, 1);
        return res.json({ success: true, event_entry_id: teamEntry.id, added_as: 'relay_member_new_team' });
    }

    const exists = db.prepare('SELECT id FROM event_entry WHERE event_id=? AND athlete_id=?').get(event_id, ath.id);
    if (exists) return res.status(409).json({ error: '이미 등록된 종목입니다.' });

    db.transaction(() => {
        // 1. Create event_entry
        const info = db.prepare("INSERT INTO event_entry (event_id,athlete_id,status) VALUES (?,?,'registered')").run(event_id, ath.id);
        const entryId = info.lastInsertRowid;

        // 2. Auto-assign to first heat (create heat if none exists)
        let heat = db.prepare('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number LIMIT 1').get(event_id);
        if (!heat) {
            const hInfo = db.prepare('INSERT INTO heat (event_id, heat_number) VALUES (?, 1)').run(event_id);
            heat = { id: hInfo.lastInsertRowid };
        }
        // Determine next lane number
        const maxLane = db.prepare('SELECT MAX(lane_number) AS mx FROM heat_entry WHERE heat_id=?').get(heat.id).mx || 0;
        db.prepare('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?, ?, ?)').run(heat.id, entryId, maxLane + 1);

        audit('event_entry', entryId, 'INSERT', null, { event_id, athlete_id: ath.id }, 'admin', evt.competition_id);
        broadcastSSE('entry_status', { event_entry_id: entryId, status: 'registered' });
    })();

    res.json({ success: true, event_entry_id: db.prepare('SELECT id FROM event_entry WHERE event_id=? AND athlete_id=?').get(event_id, ath.id).id });
});
app.delete('/api/admin/athletes/:athleteId/events/:entryId', (req, res) => {
    const { admin_key } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    const entry = db.prepare('SELECT * FROM event_entry WHERE id=?').get(req.params.entryId);
    if (!entry) return res.status(404).json({ error: 'Entry not found' });
    db.transaction(() => {
        db.prepare('DELETE FROM result WHERE event_entry_id=?').run(entry.id);
        db.prepare('DELETE FROM height_attempt WHERE event_entry_id=?').run(entry.id);
        db.prepare('DELETE FROM heat_entry WHERE event_entry_id=?').run(entry.id);
        db.prepare('DELETE FROM combined_score WHERE event_entry_id=?').run(entry.id);
        db.prepare('DELETE FROM qualification_selection WHERE event_entry_id=?').run(entry.id);
        db.prepare('DELETE FROM relay_member WHERE event_entry_id=?').run(entry.id);
        db.prepare('DELETE FROM event_entry WHERE id=?').run(entry.id);
    })();
    res.json({ success: true });
});

// ============================================================
// ADMIN: EVENT CRUD
// ============================================================
app.get('/api/admin/events', (req, res) => {
    if (!isAdminKey(req.query.key) && !isOperationKey(req.query.key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    const compId = req.query.competition_id;
    if (compId) return res.json(db.prepare('SELECT * FROM event WHERE competition_id=? ORDER BY sort_order, id').all(compId));
    res.json(db.prepare('SELECT * FROM event ORDER BY sort_order, id').all());
});
app.post('/api/admin/events', (req, res) => {
    const { admin_key, competition_id, name, category, gender, round_type, sort_order } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    if (!name || !category || !gender || !competition_id) return res.status(400).json({ error: '필수 항목이 누락되었습니다.' });
    try {
        const info = db.prepare('INSERT INTO event (competition_id,name,category,gender,round_type,round_status,sort_order) VALUES (?,?,?,?,?,?,?)')
            .run(competition_id, name, category, gender, round_type || 'final', 'created', sort_order || 0);
        const evt = db.prepare('SELECT * FROM event WHERE id=?').get(info.lastInsertRowid);
        db.prepare('INSERT INTO heat (event_id,heat_number) VALUES (?,1)').run(evt.id);
        res.json(evt);
    } catch (e) { res.status(400).json({ error: '추가 오류: ' + e.message }); }
});
app.put('/api/admin/events/:id', (req, res) => {
    const { admin_key, name, category, gender, round_type, sort_order, round_status, video_url } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    const old = db.prepare('SELECT * FROM event WHERE id=?').get(req.params.id);
    if (!old) return res.status(404).json({ error: 'Not found' });
    db.prepare('UPDATE event SET name=?,category=?,gender=?,round_type=?,sort_order=?,round_status=?,video_url=? WHERE id=?')
        .run(name || old.name, category || old.category, gender || old.gender, round_type || old.round_type,
             sort_order ?? old.sort_order, round_status || old.round_status, video_url ?? old.video_url ?? '', old.id);
    res.json(db.prepare('SELECT * FROM event WHERE id=?').get(old.id));
});

// Event video URL (accessible by operation key holders)
app.put('/api/events/:id/video-url', (req, res) => {
    const { key, video_url } = req.body;
    if (!isOperationKey(key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    const evt = db.prepare('SELECT * FROM event WHERE id=?').get(req.params.id);
    if (!evt) return res.status(404).json({ error: 'Not found' });
    db.prepare('UPDATE event SET video_url=? WHERE id=?').run(video_url || '', evt.id);
    res.json({ ok: true, video_url: video_url || '' });
});
app.get('/api/events/:id/video-url', (req, res) => {
    const evt = db.prepare('SELECT video_url FROM event WHERE id=?').get(req.params.id);
    if (!evt) return res.status(404).json({ error: 'Not found' });
    res.json({ video_url: evt.video_url || '' });
});

// Auto-sort events by standard athletics order
app.post('/api/admin/events/auto-sort', (req, res) => {
    const { admin_key, competition_id } = req.body;
    if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    if (!competition_id) return res.status(400).json({ error: 'competition_id 필요' });

    // Standard athletics event order
    const STANDARD_ORDER = [
        '100m','200m','400m','800m','1500m','3000m',
        '5000m','5000mW','10,000m','10000m','10,000mW','10000mW',
        '100mH','110mH','400mH','3000mSC','3000m장애물',
        '멀리뛰기','세단뛰기','높이뛰기','장대높이뛰기',
        '포환던지기','원반던지기','해머던지기','창던지기',
        '10종경기','7종경기',
        '4X100mR','4x100m 릴레이','4X400mR','4x400m 릴레이',
        '4X400mR(Mixed)','혼성 4x400m 릴레이',
        '4×800mR','4×1500mR',
        '하프마라톤','마라톤','20KmW','35kmW',
    ];

    const events = db.prepare('SELECT * FROM event WHERE competition_id=? AND parent_event_id IS NULL').all(competition_id);
    const update = db.prepare('UPDATE event SET sort_order=? WHERE id=?');

    db.transaction(() => {
        events.forEach(evt => {
            // Find index in standard order, or put at end
            let idx = STANDARD_ORDER.findIndex(s => s === evt.name);
            if (idx === -1) {
                // Try partial match
                idx = STANDARD_ORDER.findIndex(s => evt.name.includes(s) || s.includes(evt.name));
            }
            const order = idx >= 0 ? (idx + 1) * 10 : 9990;
            update.run(order, evt.id);
            // Also update sub-events
            db.prepare('UPDATE event SET sort_order=? WHERE parent_event_id=?').run(order, evt.id);
        });
    })();

    res.json({ success: true, message: `${events.length}개 종목 자동정렬 완료` });
});

app.delete('/api/admin/events/:id', (req, res) => {
    const { admin_key } = req.body;
    if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    const event = db.prepare('SELECT * FROM event WHERE id=?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Not found' });
    db.transaction(() => {
        const subs = db.prepare('SELECT id FROM event WHERE parent_event_id=?').all(event.id);
        for (const sub of subs) {
            const subHeats = db.prepare('SELECT id FROM heat WHERE event_id=?').all(sub.id);
            for (const h of subHeats) { db.prepare('DELETE FROM result WHERE heat_id=?').run(h.id); db.prepare('DELETE FROM height_attempt WHERE heat_id=?').run(h.id); db.prepare('DELETE FROM heat_entry WHERE heat_id=?').run(h.id); }
            db.prepare('DELETE FROM heat WHERE event_id=?').run(sub.id); db.prepare('DELETE FROM relay_member WHERE event_entry_id IN (SELECT id FROM event_entry WHERE event_id=?)').run(sub.id); db.prepare('DELETE FROM event_entry WHERE event_id=?').run(sub.id); db.prepare('DELETE FROM event WHERE id=?').run(sub.id);
        }
        const heats = db.prepare('SELECT id FROM heat WHERE event_id=?').all(event.id);
        for (const h of heats) { db.prepare('DELETE FROM result WHERE heat_id=?').run(h.id); db.prepare('DELETE FROM height_attempt WHERE heat_id=?').run(h.id); db.prepare('DELETE FROM heat_entry WHERE heat_id=?').run(h.id); }
        db.prepare('DELETE FROM heat WHERE event_id=?').run(event.id);
        db.prepare('DELETE FROM relay_member WHERE event_entry_id IN (SELECT id FROM event_entry WHERE event_id=?)').run(event.id);
        db.prepare('DELETE FROM combined_score WHERE event_entry_id IN (SELECT id FROM event_entry WHERE event_id=?)').run(event.id);
        db.prepare('DELETE FROM qualification_selection WHERE event_id=?').run(event.id);
        db.prepare('DELETE FROM event_entry WHERE event_id=?').run(event.id);
        db.prepare('DELETE FROM event WHERE id=?').run(event.id);
    })();
    res.json({ success: true });
});

// ============================================================
// ADMIN: HEAT MANAGEMENT (merge, add, delete, move athlete)
// ============================================================
app.post('/api/admin/events/:id/add-heat', (req, res) => {
    const { admin_key } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    const event = db.prepare('SELECT * FROM event WHERE id=?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    const maxHeat = db.prepare('SELECT MAX(heat_number) AS mx FROM heat WHERE event_id=?').get(event.id);
    const nextNum = (maxHeat.mx || 0) + 1;
    const info = db.prepare('INSERT INTO heat (event_id, heat_number) VALUES (?, ?)').run(event.id, nextNum);
    res.json({ success: true, heat_id: info.lastInsertRowid, heat_number: nextNum });
});
app.delete('/api/admin/heats/:id', (req, res) => {
    const { admin_key } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    const heat = db.prepare('SELECT * FROM heat WHERE id=?').get(req.params.id);
    if (!heat) return res.status(404).json({ error: 'Heat not found' });
    db.transaction(() => {
        db.prepare('DELETE FROM result WHERE heat_id=?').run(heat.id);
        db.prepare('DELETE FROM height_attempt WHERE heat_id=?').run(heat.id);
        db.prepare('DELETE FROM heat_entry WHERE heat_id=?').run(heat.id);
        db.prepare('DELETE FROM heat WHERE id=?').run(heat.id);
    })();
    res.json({ success: true });
});
// Remove athlete from heat (without deleting event_entry — just unlink from heat)
app.post('/api/admin/heats/:id/remove-entry', (req, res) => {
    const { admin_key, event_entry_id, delete_event_entry } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    const heat = db.prepare('SELECT * FROM heat WHERE id=?').get(req.params.id);
    if (!heat) return res.status(404).json({ error: 'Heat not found' });
    const he = db.prepare('SELECT * FROM heat_entry WHERE heat_id=? AND event_entry_id=?').get(req.params.id, event_entry_id);
    if (!he) return res.status(404).json({ error: '해당 선수가 이 조에 없습니다.' });
    db.transaction(() => {
        // Remove from heat
        db.prepare('DELETE FROM heat_entry WHERE heat_id=? AND event_entry_id=?').run(req.params.id, event_entry_id);
        // Optionally also delete the event_entry (full removal from event)
        if (delete_event_entry) {
            db.prepare('DELETE FROM result WHERE event_entry_id=?').run(event_entry_id);
            db.prepare('DELETE FROM height_attempt WHERE event_entry_id=?').run(event_entry_id);
            db.prepare('DELETE FROM combined_score WHERE event_entry_id=?').run(event_entry_id);
            db.prepare('DELETE FROM qualification_selection WHERE event_entry_id=?').run(event_entry_id);
            db.prepare('DELETE FROM relay_member WHERE event_entry_id=?').run(event_entry_id);
            db.prepare('DELETE FROM event_entry WHERE id=?').run(event_entry_id);
        }
    })();
    broadcastSSE('entry_status', { event_entry_id, status: 'removed' });
    res.json({ success: true });
});
app.post('/api/admin/heats/:id/move-entry', (req, res) => {
    const { admin_key, event_entry_id, target_heat_id, lane_number } = req.body;
    if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
    db.transaction(() => {
        // Remove from current heat
        db.prepare('DELETE FROM heat_entry WHERE heat_id=? AND event_entry_id=?').run(req.params.id, event_entry_id);
        // Add to target heat
        db.prepare('INSERT OR REPLACE INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?, ?, ?)').run(target_heat_id, event_entry_id, lane_number || null);
    })();
    res.json({ success: true });
});
// Force event status change (admin override)
app.post('/api/admin/events/:id/force-status', (req, res) => {
    const { admin_key, round_status, round_type } = req.body;
    if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    const event = db.prepare('SELECT * FROM event WHERE id=?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    const updates = [];
    const params = [];
    if (round_status) { updates.push('round_status=?'); params.push(round_status); }
    if (round_type) { updates.push('round_type=?'); params.push(round_type); }
    if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });
    params.push(event.id);
    db.prepare(`UPDATE event SET ${updates.join(',')} WHERE id=?`).run(...params);
    opLog(`${event.name} 강제 상태변경: ${round_status || ''} ${round_type || ''}`, 'admin', 'admin', event.competition_id);
    broadcastSSE('event_reverted', { event_id: event.id });
    res.json({ success: true, event: db.prepare('SELECT * FROM event WHERE id=?').get(event.id) });
});

// ============================================================
// ADMIN: DB RESET (per competition)
// ============================================================
app.post('/api/admin/reset-db', (req, res) => {
    const { admin_key, competition_id } = req.body;
    if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    if (!competition_id) return res.status(400).json({ error: 'competition_id required' });
    db.transaction(() => {
        const events = db.prepare('SELECT id FROM event WHERE competition_id=?').all(competition_id);
        for (const evt of events) {
            const heats = db.prepare('SELECT id FROM heat WHERE event_id=?').all(evt.id);
            for (const h of heats) { db.prepare('DELETE FROM result WHERE heat_id=?').run(h.id); db.prepare('DELETE FROM height_attempt WHERE heat_id=?').run(h.id); db.prepare('DELETE FROM heat_entry WHERE heat_id=?').run(h.id); }
            db.prepare('DELETE FROM heat WHERE event_id=?').run(evt.id);
            db.prepare('DELETE FROM relay_member WHERE event_entry_id IN (SELECT id FROM event_entry WHERE event_id=?)').run(evt.id);
            db.prepare('DELETE FROM combined_score WHERE event_entry_id IN (SELECT id FROM event_entry WHERE event_id=?)').run(evt.id);
            db.prepare('DELETE FROM qualification_selection WHERE event_id=?').run(evt.id);
            db.prepare('DELETE FROM event_entry WHERE event_id=?').run(evt.id);
        }
        db.prepare('DELETE FROM event WHERE competition_id=?').run(competition_id);
        db.prepare('DELETE FROM athlete WHERE competition_id=?').run(competition_id);
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
    tables.forEach(t => {
        try {
            if (compId && t !== 'operation_log' && t !== 'audit_log') {
                // Scoped backup: filter by competition_id where possible
                if (t === 'competition') backup[t] = db.prepare('SELECT * FROM competition WHERE id=?').all(compId);
                else if (t === 'event') backup[t] = db.prepare('SELECT * FROM event WHERE competition_id=?').all(compId);
                else if (t === 'athlete') backup[t] = db.prepare('SELECT * FROM athlete WHERE competition_id=?').all(compId);
                else if (t === 'event_entry') backup[t] = db.prepare('SELECT ee.* FROM event_entry ee JOIN event e ON ee.event_id=e.id WHERE e.competition_id=?').all(compId);
                else if (t === 'heat') backup[t] = db.prepare('SELECT h.* FROM heat h JOIN event e ON h.event_id=e.id WHERE e.competition_id=?').all(compId);
                else if (t === 'heat_entry') backup[t] = db.prepare('SELECT he.* FROM heat_entry he JOIN heat h ON he.heat_id=h.id JOIN event e ON h.event_id=e.id WHERE e.competition_id=?').all(compId);
                else if (t === 'result') backup[t] = db.prepare('SELECT r.* FROM result r JOIN heat h ON r.heat_id=h.id JOIN event e ON h.event_id=e.id WHERE e.competition_id=?').all(compId);
                else if (t === 'height_attempt') backup[t] = db.prepare('SELECT ha.* FROM height_attempt ha JOIN heat h ON ha.heat_id=h.id JOIN event e ON h.event_id=e.id WHERE e.competition_id=?').all(compId);
                else if (t === 'combined_score') backup[t] = db.prepare('SELECT cs.* FROM combined_score cs JOIN event_entry ee ON cs.event_entry_id=ee.id JOIN event e ON ee.event_id=e.id WHERE e.competition_id=?').all(compId);
                else if (t === 'qualification_selection') backup[t] = db.prepare('SELECT qs.* FROM qualification_selection qs JOIN event e ON qs.event_id=e.id WHERE e.competition_id=?').all(compId);
                else if (t === 'relay_member') backup[t] = db.prepare('SELECT rm.* FROM relay_member rm JOIN event_entry ee ON rm.event_entry_id=ee.id JOIN event e ON ee.event_id=e.id WHERE e.competition_id=?').all(compId);
                else backup[t] = db.prepare(`SELECT * FROM ${t}`).all();
            } else {
                backup[t] = db.prepare(`SELECT * FROM ${t}`).all();
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
            const gender = String(row[2] || '').trim() === '남' ? 'M' : String(row[2] || '').trim() === '여' ? 'F' : null;
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
                if (row[relayInfo.idx] === 'O') {
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

app.post('/api/federation/import', upload.single('file'), (req, res) => {
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

        db.transaction(() => {
            if (clearExisting) {
                const evts = db.prepare('SELECT id FROM event WHERE competition_id=?').all(competition_id);
                for (const evt of evts) {
                    const hts = db.prepare('SELECT id FROM heat WHERE event_id=?').all(evt.id);
                    for (const h of hts) { db.prepare('DELETE FROM result WHERE heat_id=?').run(h.id); db.prepare('DELETE FROM height_attempt WHERE heat_id=?').run(h.id); db.prepare('DELETE FROM heat_entry WHERE heat_id=?').run(h.id); }
                    db.prepare('DELETE FROM heat WHERE event_id=?').run(evt.id);
                    db.prepare('DELETE FROM relay_member WHERE event_entry_id IN (SELECT id FROM event_entry WHERE event_id=?)').run(evt.id);
                    db.prepare('DELETE FROM combined_score WHERE event_entry_id IN (SELECT id FROM event_entry WHERE event_id=?)').run(evt.id);
                    db.prepare('DELETE FROM qualification_selection WHERE event_id=?').run(evt.id);
                    db.prepare('DELETE FROM event_entry WHERE event_id=?').run(evt.id);
                }
                db.prepare('DELETE FROM event WHERE competition_id=?').run(competition_id);
                db.prepare('DELETE FROM athlete WHERE competition_id=?').run(competition_id);
            }

            const eventCache = new Map();
            db.prepare('SELECT * FROM event WHERE competition_id=? AND parent_event_id IS NULL').all(competition_id).forEach(e => eventCache.set(`${e.name}|${e.category}|${e.gender}`, e.id));

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

            dataRows.forEach(row => {
                const team = String(row[0] || '').trim();
                const name = String(row[1] || '').trim();
                const gender = String(row[2] || '').trim() === '남' ? 'M' : String(row[2] || '').trim() === '여' ? 'F' : null;
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
                    if (row[relayInfo.idx] === 'O') {
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
                            const hGender = hGRaw === '남' ? 'M' : hGRaw === '여' ? 'F' : null;
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
            db.prepare('SELECT * FROM athlete WHERE competition_id=?').all(competition_id).forEach(a => athleteCache.set(`${a.name}|${a.team}|${a.gender}`, a.id));
            const insertAthlete = db.prepare('INSERT INTO athlete (competition_id,name,bib_number,team,barcode,gender) VALUES (?,?,?,?,?,?)');
            const updateAthleteBib = db.prepare('UPDATE athlete SET bib_number=? WHERE id=? AND (bib_number IS NULL OR bib_number = ?)');
            const updateAthleteBarcode = db.prepare('UPDATE athlete SET barcode=? WHERE id=? AND (barcode IS NULL OR barcode = ?)');
            const ensureAthlete = (name, team, gender) => {
                const key = `${name}|${team}|${gender}`;
                if (athleteCache.has(key)) {
                    const existingId = athleteCache.get(key);
                    // Update bib/barcode if we have new data and existing is empty
                    const bib = _bibMap.get(key) || null;
                    const bc = _barcodeMap.get(key) || null;
                    if (bib) updateAthleteBib.run(bib, existingId, bib);
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
                const existingSubs = db.prepare('SELECT COUNT(*) AS c FROM event WHERE parent_event_id=?').get(parentId).c;
                if (existingSubs > 0) continue;
                const subs = info.name === '10종경기' ? DECATHLON_SUBS : HEPTATHLON_SUBS;
                const prefix = info.name === '10종경기' ? '[10종]' : '[7종]';
                for (const sub of subs) {
                    const subName = `${prefix} ${sub.name}`;
                    const subR = insertSubEvent.run(competition_id, subName, sub.category, info.gender, 'final', 'heats_generated', parentId, sub.order);
                    const subEventId = subR.lastInsertRowid;
                    const parentEntries = db.prepare('SELECT ee.id, ee.athlete_id FROM event_entry ee WHERE ee.event_id=?').all(parentId);
                    for (const pe of parentEntries) {
                        insertEntry.run(subEventId, pe.athlete_id);
                    }
                    const subHeatR = insertHeat.run(subEventId, 1);
                    const subEntryIds = db.prepare('SELECT id FROM event_entry WHERE event_id=?').all(subEventId);
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
                if (db.prepare('SELECT COUNT(*) AS c FROM heat WHERE event_id=?').get(eventId).c > 0) continue;
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
                            const gender = gRaw === '남' ? 'M' : gRaw === '여' ? 'F' : null;
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
                            const existingHeats = db.prepare('SELECT id FROM heat WHERE event_id=?').all(eventId);
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
                                        athlete = db.prepare('SELECT * FROM athlete WHERE competition_id=? AND bib_number=?').get(competition_id, ent.bib);
                                    }
                                    if (!athlete && ent.name) {
                                        athlete = db.prepare('SELECT * FROM athlete WHERE competition_id=? AND name=?').get(competition_id, ent.name);
                                    }
                                    if (!athlete) continue;
                                    
                                    const entry = db.prepare('SELECT id FROM event_entry WHERE event_id=? AND athlete_id=?').get(eventId, athlete.id);
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
// 양식: 배번(BIB) | 선수명 | 소속 | 성별(남/여) | 바코드
// 열 순서 고정, 바코드는 선택사항
// ============================================================
app.post('/api/athletes/upload', upload.single('file'), (req, res) => {
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
        const dataRows = rows.slice(1).filter(r => r[1]); // 선수명(B열) 필수
        let stats = { added: 0, skipped: 0 };

        db.transaction(() => {
            if (clearExisting) {
                db.prepare('DELETE FROM athlete WHERE competition_id=?').run(competition_id);
            }
            const existingCache = new Map();
            db.prepare('SELECT * FROM athlete WHERE competition_id=?').all(competition_id)
                .forEach(a => existingCache.set(`${a.name}|${a.team}|${a.gender}`, a));

            const insertAth = db.prepare('INSERT INTO athlete (competition_id,name,bib_number,team,barcode,gender) VALUES (?,?,?,?,?,?)');

            for (const row of dataRows) {
                const bib = String(row[0] || '').trim() || null;
                const name = String(row[1] || '').trim();
                const team = String(row[2] || '').trim();
                const genderRaw = String(row[3] || '').trim();
                const gender = (genderRaw === '남' || genderRaw === 'M') ? 'M' : (genderRaw === '여' || genderRaw === 'F') ? 'F' : null;
                const barcode = String(row[4] || '').trim() || '';
                if (!name || !gender) { stats.skipped++; continue; }
                const key = `${name}|${team}|${gender}`;
                if (existingCache.has(key)) {
                    // Update bib/barcode if currently empty and new data is available
                    const existing = existingCache.get(key);
                    if (existing && existing.id) {
                        if (bib && !existing.bib_number) {
                            db.prepare('UPDATE athlete SET bib_number=? WHERE id=?').run(bib, existing.id);
                        }
                        if (barcode && !existing.barcode) {
                            db.prepare('UPDATE athlete SET barcode=? WHERE id=?').run(barcode, existing.id);
                        }
                    }
                    stats.skipped++; continue;
                }
                insertAth.run(competition_id, name, bib, team, barcode, gender);
                existingCache.set(key, { id: null, bib_number: bib, barcode });
                stats.added++;
            }
        })();

        opLog(`선수 명단 업로드: ${stats.added}명 추가, ${stats.skipped}명 스킵`, 'import', 'admin', competition_id);
        res.json({ success: true, stats });
    } catch (err) { console.error(err); res.status(500).json({ error: '업로드 오류: ' + err.message }); }
});

// ============================================================
// EVENT-ONLY EXCEL UPLOAD
// 양식: 종목명 | 카테고리 | 성별(남/여/혼성) | 라운드
// 카테고리: track, field_distance, field_height, relay, combined, road
// 라운드: final(기본), preliminary, semifinal
// ============================================================
app.post('/api/events/upload', upload.single('file'), (req, res) => {
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

        db.transaction(() => {
            if (clearExisting) {
                const evts = db.prepare('SELECT id FROM event WHERE competition_id=?').all(competition_id);
                for (const evt of evts) {
                    const hts = db.prepare('SELECT id FROM heat WHERE event_id=?').all(evt.id);
                    for (const h of hts) { db.prepare('DELETE FROM result WHERE heat_id=?').run(h.id); db.prepare('DELETE FROM heat_entry WHERE heat_id=?').run(h.id); }
                    db.prepare('DELETE FROM heat WHERE event_id=?').run(evt.id);
                    db.prepare('DELETE FROM relay_member WHERE event_entry_id IN (SELECT id FROM event_entry WHERE event_id=?)').run(evt.id);
                    db.prepare('DELETE FROM event_entry WHERE event_id=?').run(evt.id);
                }
                db.prepare('DELETE FROM event WHERE competition_id=?').run(competition_id);
            }

            const existingCache = new Map();
            db.prepare('SELECT * FROM event WHERE competition_id=?').all(competition_id)
                .forEach(e => existingCache.set(`${e.name}|${e.category}|${e.gender}|${e.round_type}`, e.id));

            const insertEvt = db.prepare('INSERT INTO event (competition_id,name,category,gender,round_type,round_status,sort_order) VALUES (?,?,?,?,?,?,?)');
            const insertHeat = db.prepare('INSERT INTO heat (event_id,heat_number) VALUES (?,?)');
            let sortOrder = (db.prepare('SELECT MAX(sort_order) AS mx FROM event WHERE competition_id=?').get(competition_id).mx || 0) + 1;

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
                    subDefs.forEach((sn, idx) => {
                        const sc = subCats[sn] || 'track';
                        const sr = insertEvt.run(competition_id, sn, sc, gender, 'final', 'created', sortOrder++);
                        db.prepare('UPDATE event SET parent_event_id=? WHERE id=?').run(r.lastInsertRowid, sr.lastInsertRowid);
                        insertHeat.run(sr.lastInsertRowid, 1);
                    });
                }

                stats.added++;
            }
        })();

        opLog(`종목 업로드: ${stats.added}개 추가, ${stats.skipped}개 스킵`, 'import', 'admin', competition_id);
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
        const heatNum = colIdx.heat !== undefined ? parseInt(row[colIdx.heat]) || 1 : 1;
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

    return { eventGroups, totalRows: dataRows.length, sheetName };
}

// PREVIEW API — Compare Excel data with DB, show changes
app.post('/api/heat-assignment/preview', upload.single('file'), (req, res) => {
    if (!isAdminKey(req.body.admin_key || req.headers['x-admin-key'])) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    if (!req.file) return res.status(400).json({ error: '파일이 필요합니다.' });
    const competition_id = parseInt(req.body.competition_id);
    if (!competition_id) return res.status(400).json({ error: 'competition_id 필요' });

    try {
        const { eventGroups, totalRows, sheetName } = parseHeatAssignmentExcel(req.file.path);
        
        const preview = [];
        
        for (const [eventKey, group] of eventGroups) {
            const { gender, eventName, round, entries } = group;
            
            // Find matching event in DB
            let dbEvent = null;
            if (gender && gender !== '?') {
                dbEvent = db.prepare(
                    'SELECT * FROM event WHERE competition_id=? AND name=? AND gender=? AND round_type=? AND parent_event_id IS NULL'
                ).get(competition_id, eventName, gender, round);
            }
            // Fallback: try without round_type match (some events only have final)
            if (!dbEvent && gender && gender !== '?') {
                dbEvent = db.prepare(
                    'SELECT * FROM event WHERE competition_id=? AND name=? AND gender=? AND parent_event_id IS NULL'
                ).get(competition_id, eventName, gender);
            }
            // Fallback: try without parent_event_id constraint (for child events like [10종] 100m, [7종] 100mH)
            if (!dbEvent && gender && gender !== '?') {
                dbEvent = db.prepare(
                    'SELECT * FROM event WHERE competition_id=? AND name=? AND gender=? AND round_type=?'
                ).get(competition_id, eventName, gender, round);
            }
            if (!dbEvent && gender && gender !== '?') {
                dbEvent = db.prepare(
                    'SELECT * FROM event WHERE competition_id=? AND name=? AND gender=?'
                ).get(competition_id, eventName, gender);
            }
            // Fuzzy fallback: LIKE match for partial names (e.g., "10K 국제 남자부" → DB has "10K국제남자부")
            if (!dbEvent && gender && gender !== '?') {
                const stripped = eventName.replace(/\s+/g, '%');
                dbEvent = db.prepare(
                    "SELECT * FROM event WHERE competition_id=? AND REPLACE(REPLACE(name,' ',''),' ','') = ? AND gender=?"
                ).get(competition_id, eventName.replace(/\s+/g, ''), gender);
                if (!dbEvent) {
                    dbEvent = db.prepare(
                        "SELECT * FROM event WHERE competition_id=? AND name LIKE ? AND gender=?"
                    ).get(competition_id, `%${stripped}%`, gender);
                }
            }
            
            if (!dbEvent) {
                // Try to find similar events as suggestions
                let suggestions = [];
                if (gender && gender !== '?') {
                    suggestions = db.prepare(
                        'SELECT id, name, round_type FROM event WHERE competition_id=? AND gender=? AND parent_event_id IS NULL ORDER BY name'
                    ).all(competition_id, gender).map(e => ({ id: e.id, name: e.name, round: e.round_type }));
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
            const dbHeats = db.prepare('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number').all(dbEvent.id);
            const dbHeatEntries = [];
            for (const h of dbHeats) {
                const hEntries = db.prepare(`
                    SELECT he.id, he.heat_id, he.lane_number, he.event_entry_id, he.sub_group,
                           a.name, a.bib_number, a.team, a.id as athlete_id
                    FROM heat_entry he
                    JOIN event_entry ee ON ee.id = he.event_entry_id
                    JOIN athlete a ON a.id = ee.athlete_id
                    WHERE he.heat_id = ?
                    ORDER BY he.lane_number
                `).all(h.id);
                dbHeatEntries.push({ heat: h, entries: hEntries });
            }

            // Check if results exist for this event
            let resultCount = 0;
            let heightAttemptCount = 0;
            for (const h of dbHeats) {
                resultCount += db.prepare('SELECT COUNT(*) as c FROM result WHERE heat_id=?').get(h.id).c;
                heightAttemptCount += db.prepare('SELECT COUNT(*) as c FROM height_attempt WHERE heat_id=?').get(h.id).c;
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
            preview
        });
    } catch (err) {
        console.error('[Heat Assignment Preview Error]', err);
        res.status(500).json({ error: '조편성 미리보기 오류: ' + err.message });
    }
});

// AUTO-CREATE missing events from heat assignment Excel
app.post('/api/heat-assignment/create-events', express.json(), (req, res) => {
    if (!isAdminKey(req.body.admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
    const { competition_id, events } = req.body;
    if (!competition_id || !events || !Array.isArray(events)) return res.status(400).json({ error: 'competition_id와 events 배열이 필요합니다.' });

    // Detect category from event name
    function detectCategory(name) {
        const n = name.toLowerCase();
        if (n.includes('릴레이') || n.includes('relay') || /^\d+x\d+m/i.test(n)) return 'relay';
        if (n.includes('마라톤') || n.includes('하프') || n.includes('10k') || n.includes('5k') || n.includes('half') || n.includes('road') || n.includes('km')) return 'road';
        if (n.includes('높이') || n.includes('장대') || n.includes('high') || n.includes('pole')) return 'field_height';
        if (n.includes('멀리') || n.includes('세단') || n.includes('포환') || n.includes('원반') || n.includes('창') || n.includes('해머') || n.includes('투척') || n.includes('long') || n.includes('triple') || n.includes('shot') || n.includes('discus') || n.includes('javelin') || n.includes('hammer')) return 'field_distance';
        if (n.includes('10종') || n.includes('7종') || n.includes('decathlon') || n.includes('heptathlon') || n.includes('combined')) return 'combined';
        return 'road'; // default for unknown events like "10K 국제 남자부"
    }

    const created = [];
    const stmt = db.prepare('INSERT INTO event (competition_id, name, gender, category, round_type, round_status, sort_order) VALUES (?,?,?,?,?,?,?)');
    const maxSort = db.prepare('SELECT MAX(sort_order) as m FROM event WHERE competition_id=?').get(competition_id).m || 0;

    let sortOrder = maxSort + 1;
    for (const evt of events) {
        const { eventName, gender, round } = evt;
        if (!eventName || !gender) continue;
        // Check if already exists
        const existing = db.prepare('SELECT id FROM event WHERE competition_id=? AND name=? AND gender=?').get(competition_id, eventName, gender);
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
app.post('/api/heat-assignment/apply', upload.single('file'), (req, res) => {
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
        const comp = db.prepare('SELECT id FROM competition WHERE id=?').get(competition_id);
        if (!comp) {
            return res.status(400).json({ success: false, error: `대회를 찾을 수 없습니다 (ID: ${competition_id})` });
        }

        const { eventGroups } = parseHeatAssignmentExcel(req.file.path);
        const stats = { updated: 0, skipped: 0, skippedUnchanged: 0, skippedHasResults: 0, notFound: 0, athletesAdded: 0, entriesCreated: 0 };

        db.transaction(() => {
            // Cache all athletes for this competition by name+team
            const athleteCache = new Map();
            db.prepare('SELECT * FROM athlete WHERE competition_id=?').all(competition_id)
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
            const insertHeat = db.prepare('INSERT INTO heat (event_id,heat_number) VALUES (?,?)');
            const insertHeatEntry = db.prepare('INSERT INTO heat_entry (heat_id,event_entry_id,lane_number,sub_group) VALUES (?,?,?,?)');

            for (const [eventKey, group] of eventGroups) {
                const { gender, eventName, round, entries } = group;

                // Keep Excel original lane numbers — no renumbering
                // Excel has sequential lane numbers across groups (A:1-18, B:19-26) and that's correct

                // Find matching event in DB
                let dbEvent = null;
                if (gender && gender !== '?') {
                    dbEvent = db.prepare(
                        'SELECT * FROM event WHERE competition_id=? AND name=? AND gender=? AND round_type=? AND parent_event_id IS NULL'
                    ).get(competition_id, eventName, gender, round);
                }
                if (!dbEvent && gender && gender !== '?') {
                    dbEvent = db.prepare(
                        'SELECT * FROM event WHERE competition_id=? AND name=? AND gender=? AND parent_event_id IS NULL'
                    ).get(competition_id, eventName, gender);
                }
                // Fallback: try without parent_event_id constraint (for child events like [10종] 100m, [7종] 100mH)
                if (!dbEvent && gender && gender !== '?') {
                    dbEvent = db.prepare(
                        'SELECT * FROM event WHERE competition_id=? AND name=? AND gender=? AND round_type=?'
                    ).get(competition_id, eventName, gender, round);
                }
                if (!dbEvent && gender && gender !== '?') {
                    dbEvent = db.prepare(
                        'SELECT * FROM event WHERE competition_id=? AND name=? AND gender=?'
                    ).get(competition_id, eventName, gender);
                }

                if (!dbEvent) {
                    stats.notFound++;
                    continue;
                }

                // Get current DB state
                const dbHeats = db.prepare('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number').all(dbEvent.id);
                
                // Check if data is identical (quick comparison: same athlete count and names)
                const dbAthleteNames = new Set();
                for (const h of dbHeats) {
                    const hEntries = db.prepare(`
                        SELECT a.name, a.team FROM heat_entry he
                        JOIN event_entry ee ON ee.id = he.event_entry_id
                        JOIN athlete a ON a.id = ee.athlete_id
                        WHERE he.heat_id = ?
                    `).all(h.id);
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
                        const hEntries = db.prepare(`
                            SELECT he.lane_number, he.sub_group, a.name, a.team
                            FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id
                            JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=?
                        `).all(h.id);
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
                    resultCount += db.prepare('SELECT COUNT(*) as c FROM result WHERE heat_id=?').get(h.id).c;
                    resultCount += db.prepare('SELECT COUNT(*) as c FROM height_attempt WHERE heat_id=?').get(h.id).c;
                }

                if (resultCount > 0 && !forceEventIds.has(dbEvent.id)) {
                    stats.skippedHasResults++;
                    stats.skipped++;
                    continue;
                }

                // === APPLY CHANGES ===
                
                // 1. Delete existing heats, heat_entries, results for this event
                for (const h of dbHeats) {
                    db.prepare('DELETE FROM result WHERE heat_id=?').run(h.id);
                    db.prepare('DELETE FROM height_attempt WHERE heat_id=?').run(h.id);
                    db.prepare('DELETE FROM heat_entry WHERE heat_id=?').run(h.id);
                }
                db.prepare('DELETE FROM heat WHERE event_id=?').run(dbEvent.id);

                // 2. For relay events: also clear old event_entries (team "athletes")
                const isRelay = dbEvent.category === 'relay';

                // 3. Group entries by heat number
                const heatGroups = new Map();
                for (const e of entries) {
                    if (!heatGroups.has(e.heat)) heatGroups.set(e.heat, []);
                    heatGroups.get(e.heat).push(e);
                }

                // 4. Create heats and heat entries
                for (const [heatNum, heatEntries] of [...heatGroups].sort((a, b) => a[0] - b[0])) {
                    const heatRow = insertHeat.run(dbEvent.id, heatNum);
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
                                const byBib = db.prepare('SELECT * FROM athlete WHERE competition_id=? AND bib_number=?').get(competition_id, String(entry.bib));
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
                                const bibTaken = db.prepare('SELECT id FROM athlete WHERE competition_id=? AND bib_number=?').get(competition_id, newBib);
                                if (bibTaken) newBib = null; // bib already used by another athlete, leave NULL
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
                            const bibTaken = db.prepare('SELECT id FROM athlete WHERE competition_id=? AND bib_number=? AND id!=?').get(competition_id, bibStr, athlete.id);
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
                            const alreadyInHeat = db.prepare('SELECT id FROM heat_entry WHERE heat_id=? AND event_entry_id=?').get(heatId, eventEntryId);
                            if (!alreadyInHeat) {
                                insertHeatEntry.run(heatId, eventEntryId, entry.lane, entry.group || null);
                                stats.entriesCreated++;
                            }
                        }
                    }
                }

                // 5. Handle athletes no longer in this event's heats
                //    We do NOT delete event_entry rows — they may be referenced by
                //    combined_score, qualification_selection, relay_member, or sub-events.
                //    The athlete is simply not in any heat anymore (effectively DNS).
                //    This is safe because heat_entry rows were already deleted above.

                // 6. RELAY: Auto-populate relay_member from team roster
                //    For each relay team entry, find athletes belonging to the same team
                //    and add them as relay_member if not already present.
                if (isRelay) {
                    const allEventEntries = db.prepare('SELECT ee.id, ee.athlete_id, a.name, a.team FROM event_entry ee JOIN athlete a ON ee.athlete_id=a.id WHERE ee.event_id=?').all(dbEvent.id);
                    const insertRelayMem = db.prepare('INSERT OR IGNORE INTO relay_member (event_entry_id, athlete_id, leg_order) VALUES (?,?,?)');
                    
                    for (const teamEntry of allEventEntries) {
                        // "Team athlete" records: name === team (e.g., name='광주광역시청', team='광주광역시청')
                        if (teamEntry.name !== teamEntry.team) continue;
                        
                        // Check if this team entry already has relay members
                        const existingMembers = db.prepare('SELECT COUNT(*) AS c FROM relay_member WHERE event_entry_id=?').get(teamEntry.id).c;
                        if (existingMembers > 0) continue; // Already has members, skip
                        
                        // Find individual athletes from the same team
                        const effGender = gender === 'X' ? null : gender; // For mixed, accept any gender
                        let teamAthletes;
                        if (effGender) {
                            teamAthletes = db.prepare(
                                'SELECT id, name, team FROM athlete WHERE competition_id=? AND team=? AND gender=? AND name!=team ORDER BY id'
                            ).all(competition_id, teamEntry.team, effGender);
                        } else {
                            teamAthletes = db.prepare(
                                'SELECT id, name, team FROM athlete WHERE competition_id=? AND team=? AND name!=team ORDER BY id'
                            ).all(competition_id, teamEntry.team);
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
        res.json({ success: true, message: '조편성 적용 완료', stats });
    } catch (err) {
        console.error('[Heat Assignment Apply Error]', err);
        res.status(500).json({ error: '조편성 적용 오류: ' + err.message });
    }
});

// ============================================================
// PACING LIGHT API (페이싱 라이트)
// ============================================================

// GET all pacing configs for a competition
app.get('/api/pacing', (req, res) => {
    const compId = parseInt(req.query.competition_id) || null;
    if (!compId) return res.status(400).json({ error: 'competition_id required' });
    const configs = db.prepare('SELECT * FROM pacing_config WHERE competition_id=? ORDER BY event_name').all(compId);
    const result = configs.map(cfg => {
        const colors = db.prepare('SELECT * FROM pacing_color WHERE pacing_config_id=? ORDER BY sort_order').all(cfg.id);
        colors.forEach(c => {
            c.segments = db.prepare('SELECT * FROM pacing_segment WHERE pacing_color_id=? ORDER BY segment_order').all(c.id);
        });
        return { ...cfg, colors };
    });
    res.json(result);
});

// GET single pacing config by id
app.get('/api/pacing/:id', (req, res) => {
    const cfg = db.prepare('SELECT * FROM pacing_config WHERE id=?').get(parseInt(req.params.id));
    if (!cfg) return res.status(404).json({ error: 'not found' });
    const colors = db.prepare('SELECT * FROM pacing_color WHERE pacing_config_id=? ORDER BY sort_order').all(cfg.id);
    colors.forEach(c => {
        c.segments = db.prepare('SELECT * FROM pacing_segment WHERE pacing_color_id=? ORDER BY segment_order').all(c.id);
    });
    res.json({ ...cfg, colors });
});

// POST create or update full pacing config (upsert)
// Body: { competition_id, event_name, notice, colors: [{ color_key, sort_order, remark, segments: [{ segment_order, distance_meters, lap_seconds }] }] }
app.post('/api/pacing', (req, res) => {
    const key = req.body.admin_key || req.headers['x-admin-key'] || '';
    if (!isOperationKey(key)) return res.status(403).json({ error: '인증 필요' });
    const { competition_id, event_name, notice, colors } = req.body;
    if (!competition_id || !event_name) return res.status(400).json({ error: 'competition_id and event_name required' });

    const trx = db.transaction(() => {
        // Upsert pacing_config
        let cfg = db.prepare('SELECT id FROM pacing_config WHERE competition_id=? AND event_name=?').get(competition_id, event_name);
        if (cfg) {
            db.prepare('UPDATE pacing_config SET notice=?, updated_at=datetime(\'now\') WHERE id=?').run(notice || '', cfg.id);
        } else {
            const r = db.prepare('INSERT INTO pacing_config (competition_id, event_name, notice) VALUES (?,?,?)').run(competition_id, event_name, notice || '');
            cfg = { id: r.lastInsertRowid };
        }
        // Delete old colors + segments (cascade)
        db.prepare('DELETE FROM pacing_color WHERE pacing_config_id=?').run(cfg.id);
        // Insert colors + segments
        if (Array.isArray(colors)) {
            colors.forEach((c, ci) => {
                const cr = db.prepare('INSERT INTO pacing_color (pacing_config_id, color_key, sort_order, remark) VALUES (?,?,?,?)')
                    .run(cfg.id, c.color_key, c.sort_order != null ? c.sort_order : ci, c.remark || '');
                if (Array.isArray(c.segments)) {
                    c.segments.forEach((seg, si) => {
                        db.prepare('INSERT INTO pacing_segment (pacing_color_id, segment_order, distance_meters, lap_seconds) VALUES (?,?,?,?)')
                            .run(cr.lastInsertRowid, seg.segment_order != null ? seg.segment_order : si, seg.distance_meters, seg.lap_seconds);
                    });
                }
            });
        }
        return cfg.id;
    });
    try {
        const cfgId = trx();
        opLog(`페이싱 라이트 설정 저장: ${event_name}`, 'pacing', getJudgeName(key), competition_id);
        broadcastSSE('pacing_update', { competition_id, event_name });
        res.json({ ok: true, id: cfgId });
    } catch (e) {
        console.error('[Pacing Save Error]', e);
        res.status(500).json({ error: e.message });
    }
});

// DELETE pacing config
app.delete('/api/pacing/:id', (req, res) => {
    const key = req.body.admin_key || req.headers['x-admin-key'] || '';
    if (!isOperationKey(key)) return res.status(403).json({ error: '인증 필요' });
    const cfg = db.prepare('SELECT * FROM pacing_config WHERE id=?').get(parseInt(req.params.id));
    if (!cfg) return res.status(404).json({ error: 'not found' });
    db.prepare('DELETE FROM pacing_config WHERE id=?').run(cfg.id);
    opLog(`페이싱 라이트 삭제: ${cfg.event_name}`, 'pacing', getJudgeName(key), cfg.competition_id);
    broadcastSSE('pacing_update', { competition_id: cfg.competition_id });
    res.json({ ok: true });
});

// GET pacing configs for dashboard (public, no auth)
app.get('/api/public/pacing', (req, res) => {
    const compId = parseInt(req.query.competition_id) || null;
    if (!compId) return res.status(400).json({ error: 'competition_id required' });
    const configs = db.prepare('SELECT * FROM pacing_config WHERE competition_id=? ORDER BY event_name').all(compId);
    const result = configs.map(cfg => {
        const colors = db.prepare('SELECT * FROM pacing_color WHERE pacing_config_id=? ORDER BY sort_order').all(cfg.id);
        colors.forEach(c => {
            c.segments = db.prepare('SELECT * FROM pacing_segment WHERE pacing_color_id=? ORDER BY segment_order').all(c.id);
        });
        return { ...cfg, colors };
    });
    res.json(result);
});

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
app.get('/api/wa-validate/:id', (req, res) => {
    const result = validateWAHeatLanes(parseInt(req.params.id), db);
    res.json(result);
});
app.post('/api/wa-correct/:id', (req, res) => {
    const result = autoCorrectWALanes(parseInt(req.params.id), db);
    res.json(result);
});

app.listen(PORT, '0.0.0.0', () => {
    // Log DB status on startup
    try {
        const compCount = db.prepare('SELECT COUNT(*) as c FROM competition').get().c;
        const evtCount = db.prepare('SELECT COUNT(*) as c FROM event').get().c;
        const athCount = db.prepare('SELECT COUNT(*) as c FROM athlete').get().c;
        console.log(`\n  Pace Rise Competition OS v4 — port ${PORT}`);
        console.log(`  http://localhost:${PORT}/`);
        console.log(`  DB: ${compCount} competitions, ${evtCount} events, ${athCount} athletes (data preserved)\n`);
    } catch(e) {
        console.log(`\n  Pace Rise Competition OS v4 — port ${PORT}\n  http://localhost:${PORT}/\n`);
    }
});
