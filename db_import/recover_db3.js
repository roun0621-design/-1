/**
 * Recover corrupted SQLite DB - hardcoded schema matching source
 */
const Database = require('better-sqlite3');
const fs = require('fs');

const SOURCE = process.argv[2] || 'db_import/ktfl_source.db';
const TARGET = process.argv[3] || 'db/competition.db';

if (fs.existsSync(TARGET)) fs.unlinkSync(TARGET);

const src = new Database(SOURCE, { fileMustExist: true });
const tgt = new Database(TARGET);
tgt.pragma('journal_mode = WAL');
tgt.pragma('foreign_keys = OFF');

// Schema matching the source DB exactly
const SCHEMA = `
CREATE TABLE competition (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    venue TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'upcoming',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    video_url TEXT DEFAULT '',
    federation TEXT DEFAULT ''
);

CREATE TABLE athlete (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    competition_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    bib_number TEXT DEFAULT NULL,
    team TEXT DEFAULT '',
    barcode TEXT,
    gender TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    federation TEXT DEFAULT '',
    personal_best TEXT DEFAULT '',
    date_of_birth TEXT DEFAULT ''
);

CREATE TABLE event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    competition_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    gender TEXT NOT NULL,
    round_type TEXT NOT NULL DEFAULT 'final',
    round_status TEXT NOT NULL DEFAULT 'created',
    parent_event_id INTEGER DEFAULT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    video_url TEXT DEFAULT '',
    callroom_event_memo TEXT DEFAULT ''
);

CREATE TABLE event_entry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    athlete_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'registered',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    callroom_memo TEXT DEFAULT '',
    UNIQUE(event_id, athlete_id)
);

CREATE TABLE heat (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    heat_number INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    wind REAL DEFAULT NULL,
    heat_name TEXT DEFAULT NULL,
    scoreboard_key TEXT DEFAULT NULL
);

CREATE TABLE heat_entry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    heat_id INTEGER NOT NULL,
    event_entry_id INTEGER NOT NULL,
    lane_number INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    sub_group TEXT DEFAULT NULL,
    UNIQUE(heat_id, event_entry_id)
);

CREATE TABLE result (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    heat_id INTEGER NOT NULL,
    event_entry_id INTEGER NOT NULL,
    attempt_number INTEGER,
    distance_meters REAL,
    time_seconds REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    remark TEXT DEFAULT '',
    status_code TEXT DEFAULT '',
    wind REAL DEFAULT NULL,
    UNIQUE(heat_id, event_entry_id, attempt_number)
);

CREATE TABLE height_attempt (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    heat_id INTEGER NOT NULL,
    event_entry_id INTEGER NOT NULL,
    bar_height REAL,
    attempt_number INTEGER,
    result_mark TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE combined_score (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_entry_id INTEGER NOT NULL,
    sub_event_name TEXT,
    sub_event_order INTEGER,
    raw_record REAL,
    wa_points INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE relay_member (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_entry_id INTEGER NOT NULL,
    athlete_id INTEGER NOT NULL,
    leg_order INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE qualification_selection (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    event_entry_id INTEGER NOT NULL,
    selected INTEGER NOT NULL DEFAULT 0,
    approved INTEGER NOT NULL DEFAULT 0,
    approved_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    qualification_type TEXT DEFAULT '',
    UNIQUE(event_id, event_entry_id)
);

CREATE TABLE operation_key (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    judge_name TEXT NOT NULL,
    key_value TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL DEFAULT 'operation',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    can_manage INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE operation_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    competition_id INTEGER,
    message TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'general',
    performed_by TEXT NOT NULL DEFAULT 'system',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    competition_id INTEGER,
    table_name TEXT NOT NULL,
    record_id INTEGER,
    action TEXT NOT NULL,
    old_values TEXT,
    new_values TEXT,
    performed_by TEXT NOT NULL DEFAULT 'system',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE system_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE event_link (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id_a INTEGER NOT NULL,
    event_id_b INTEGER NOT NULL,
    link_type TEXT NOT NULL DEFAULT 'joint_scoreboard',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    joint_scoreboard_key TEXT DEFAULT NULL,
    UNIQUE(event_id_a, event_id_b)
);

CREATE TABLE pacing_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    competition_id INTEGER NOT NULL,
    event_name TEXT NOT NULL,
    notice TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(competition_id, event_name)
);

CREATE TABLE pacing_color (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pacing_config_id INTEGER NOT NULL,
    color_key TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    remark TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(pacing_config_id, color_key)
);

CREATE TABLE pacing_segment (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pacing_color_id INTEGER NOT NULL,
    segment_order INTEGER NOT NULL,
    distance_meters INTEGER NOT NULL,
    lap_seconds REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(pacing_color_id, segment_order)
);

CREATE TABLE home_popup (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    popup_type TEXT NOT NULL DEFAULT 'public',
    title TEXT NOT NULL DEFAULT '',
    subtitle TEXT NOT NULL DEFAULT '',
    intro_text TEXT NOT NULL DEFAULT '',
    bottom_btn_text TEXT NOT NULL DEFAULT '',
    bottom_btn_desc TEXT NOT NULL DEFAULT '',
    bottom_btn_link TEXT NOT NULL DEFAULT '',
    bottom_btn_active INTEGER NOT NULL DEFAULT 1,
    is_active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE home_popup_section (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    popup_id INTEGER NOT NULL,
    section_type TEXT NOT NULL DEFAULT 'text',
    content TEXT NOT NULL DEFAULT '',
    image_url TEXT NOT NULL DEFAULT '',
    btn_text TEXT NOT NULL DEFAULT '',
    btn_link TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE federation_list (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    badge_bg TEXT NOT NULL DEFAULT '#e3f2fd',
    badge_color TEXT NOT NULL DEFAULT '#1565c0',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    gender_label_m TEXT DEFAULT '',
    gender_label_f TEXT DEFAULT '',
    gender_label_x TEXT DEFAULT ''
);

CREATE TABLE timetable (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    competition_id INTEGER NOT NULL,
    day INTEGER DEFAULT 1,
    section TEXT DEFAULT 'track',
    time TEXT,
    event_name TEXT,
    category TEXT DEFAULT '',
    round TEXT DEFAULT '',
    note TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0
);

CREATE TABLE doc_template (
    competition_id INTEGER PRIMARY KEY,
    ad_card TEXT DEFAULT '{}',
    comp_record TEXT DEFAULT '{}',
    start_list TEXT DEFAULT '{}',
    result_sheet TEXT DEFAULT '{}'
);

CREATE TABLE event_records (
    event_id INTEGER PRIMARY KEY,
    records TEXT DEFAULT '{}'
);
`;

console.log('Creating clean schema...');
tgt.exec(SCHEMA);

// Indexes
tgt.exec(`
CREATE INDEX IF NOT EXISTS idx_event_competition ON event(competition_id);
CREATE INDEX IF NOT EXISTS idx_event_parent ON event(parent_event_id);
CREATE INDEX IF NOT EXISTS idx_event_comp_gender ON event(competition_id, gender);
CREATE INDEX IF NOT EXISTS idx_athlete_competition ON athlete(competition_id);
CREATE INDEX IF NOT EXISTS idx_event_entry_event ON event_entry(event_id);
CREATE INDEX IF NOT EXISTS idx_event_entry_athlete ON event_entry(athlete_id);
CREATE INDEX IF NOT EXISTS idx_heat_event ON heat(event_id);
CREATE INDEX IF NOT EXISTS idx_heat_entry_heat ON heat_entry(heat_id);
CREATE INDEX IF NOT EXISTS idx_heat_entry_event_entry ON heat_entry(event_entry_id);
CREATE INDEX IF NOT EXISTS idx_result_heat ON result(heat_id);
CREATE INDEX IF NOT EXISTS idx_result_event_entry ON result(event_entry_id);
CREATE INDEX IF NOT EXISTS idx_height_attempt_heat ON height_attempt(heat_id);
CREATE INDEX IF NOT EXISTS idx_relay_member_entry ON relay_member(event_entry_id);
CREATE INDEX IF NOT EXISTS idx_operation_log_comp ON operation_log(competition_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_comp ON audit_log(competition_id);
`);

console.log('Schema created. Copying data...');

// Tables to copy (order matters)
const TABLES = [
    'competition','athlete','event','event_entry','heat','heat_entry',
    'result','height_attempt','combined_score','relay_member',
    'qualification_selection','operation_key','operation_log','audit_log',
    'system_config','event_link','pacing_config','pacing_color',
    'pacing_segment','home_popup','home_popup_section','federation_list',
    'timetable','doc_template','event_records'
];

for (const table of TABLES) {
    try {
        const rows = src.prepare(`SELECT * FROM "${table}"`).all();
        if (rows.length === 0) {
            console.log(`  ${table}: 0 rows`);
            continue;
        }
        
        // Get target columns
        const tgtCols = tgt.prepare(`PRAGMA table_info("${table}")`).all().map(c => c.name);
        const srcCols = Object.keys(rows[0]);
        // Only use columns that exist in both
        const cols = srcCols.filter(c => tgtCols.includes(c));
        
        const placeholders = cols.map(() => '?').join(',');
        const colStr = cols.map(c => `"${c}"`).join(',');
        
        const insert = tgt.prepare(`INSERT OR IGNORE INTO "${table}" (${colStr}) VALUES (${placeholders})`);
        const insertMany = tgt.transaction((data) => {
            for (const row of data) {
                insert.run(...cols.map(c => row[c] !== undefined ? row[c] : null));
            }
        });
        
        insertMany(rows);
        console.log(`  ${table}: ${rows.length} rows`);
    } catch(e) {
        console.log(`  ${table}: ERROR - ${e.message.substring(0,100)}`);
    }
}

// Update sqlite_sequence
try {
    const seqs = src.prepare('SELECT * FROM sqlite_sequence').all();
    for (const s of seqs) {
        tgt.prepare('INSERT OR REPLACE INTO sqlite_sequence(name, seq) VALUES (?, ?)').run(s.name, s.seq);
    }
    console.log(`  sqlite_sequence: ${seqs.length} entries`);
} catch(e) {}

src.close();
tgt.close();

console.log(`\nDone! Clean DB: ${TARGET} (${(fs.statSync(TARGET).size / 1024 / 1024).toFixed(2)} MB)`);
