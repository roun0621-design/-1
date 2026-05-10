/**
 * Recover a corrupted SQLite DB by recreating schema and copying data
 */
const Database = require('better-sqlite3');
const fs = require('fs');

const SOURCE = process.argv[2] || 'db/competition.db';
const TARGET = process.argv[3] || 'db/competition_clean.db';

// Remove target if exists
if (fs.existsSync(TARGET)) fs.unlinkSync(TARGET);

// Known schema from server.js
const SCHEMA = `
CREATE TABLE competition (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    venue TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'upcoming' CHECK(status IN ('upcoming','active','completed')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    video_url TEXT DEFAULT '',
    federation TEXT DEFAULT ''
);

CREATE TABLE athlete (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    competition_id INTEGER NOT NULL REFERENCES competition(id),
    name TEXT NOT NULL,
    bib_number TEXT,
    barcode TEXT,
    gender TEXT CHECK(gender IN ('M','F','X')),
    team TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    competition_id INTEGER NOT NULL REFERENCES competition(id),
    name TEXT NOT NULL,
    category TEXT NOT NULL CHECK(category IN ('track','field_distance','field_height','combined','relay','road')),
    sort_order INTEGER NOT NULL DEFAULT 0,
    gender TEXT NOT NULL CHECK(gender IN ('M','F','X')),
    round_type TEXT NOT NULL DEFAULT 'final' CHECK(round_type IN ('preliminary','semifinal','final')),
    round_status TEXT NOT NULL DEFAULT 'created' CHECK(round_status IN ('created','heats_generated','in_progress','completed')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    parent_event_id INTEGER DEFAULT NULL REFERENCES event(id),
    video_url TEXT DEFAULT '',
    callroom_memo TEXT DEFAULT ''
);

CREATE TABLE event_entry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES event(id),
    athlete_id INTEGER NOT NULL REFERENCES athlete(id),
    status TEXT NOT NULL DEFAULT 'registered' CHECK(status IN ('registered','checked_in','no_show')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    callroom_memo TEXT DEFAULT '',
    UNIQUE(event_id, athlete_id)
);

CREATE TABLE heat (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES event(id),
    heat_number INTEGER NOT NULL,
    scoreboard_key TEXT,
    joint_scoreboard_key TEXT DEFAULT NULL,
    wind TEXT DEFAULT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE heat_entry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    heat_id INTEGER NOT NULL REFERENCES heat(id),
    event_entry_id INTEGER NOT NULL REFERENCES event_entry(id),
    lane_number INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    sub_group TEXT DEFAULT NULL,
    UNIQUE(heat_id, event_entry_id)
);

CREATE TABLE result (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    heat_id INTEGER NOT NULL REFERENCES heat(id),
    event_entry_id INTEGER NOT NULL REFERENCES event_entry(id),
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
    heat_id INTEGER NOT NULL REFERENCES heat(id),
    event_entry_id INTEGER NOT NULL REFERENCES event_entry(id),
    height_cm REAL NOT NULL,
    attempt_order INTEGER NOT NULL,
    result TEXT NOT NULL CHECK(result IN ('O','X','P','-')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE combined_score (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_entry_id INTEGER NOT NULL REFERENCES event_entry(id),
    sub_event_id INTEGER NOT NULL REFERENCES event(id),
    score INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(event_entry_id, sub_event_id)
);

CREATE TABLE relay_member (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_entry_id INTEGER NOT NULL REFERENCES event_entry(id),
    athlete_id INTEGER NOT NULL REFERENCES athlete(id),
    leg_order INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE qualification_selection (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES event(id),
    event_entry_id INTEGER NOT NULL REFERENCES event_entry(id),
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
    role TEXT NOT NULL DEFAULT 'operation' CHECK(role IN ('operation','admin')),
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    can_manage INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE operation_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    competition_id INTEGER REFERENCES competition(id),
    message TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'general',
    performed_by TEXT NOT NULL DEFAULT 'system',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    competition_id INTEGER REFERENCES competition(id),
    table_name TEXT NOT NULL,
    record_id INTEGER,
    action TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    performed_by TEXT NOT NULL DEFAULT 'system',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE system_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE event_link (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id_a INTEGER NOT NULL REFERENCES event(id) ON DELETE CASCADE,
    event_id_b INTEGER NOT NULL REFERENCES event(id) ON DELETE CASCADE,
    link_type TEXT NOT NULL DEFAULT 'joint_scoreboard',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    joint_scoreboard_key TEXT DEFAULT NULL,
    UNIQUE(event_id_a, event_id_b)
);

CREATE TABLE pacing_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    competition_id INTEGER NOT NULL REFERENCES competition(id),
    event_name TEXT NOT NULL,
    notice TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(competition_id, event_name)
);

CREATE TABLE pacing_color (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pacing_config_id INTEGER NOT NULL REFERENCES pacing_config(id) ON DELETE CASCADE,
    color_key TEXT NOT NULL CHECK(color_key IN ('green','red','white','blue')),
    sort_order INTEGER NOT NULL DEFAULT 0,
    remark TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(pacing_config_id, color_key)
);

CREATE TABLE pacing_segment (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pacing_color_id INTEGER NOT NULL REFERENCES pacing_color(id) ON DELETE CASCADE,
    segment_order INTEGER NOT NULL,
    distance_meters INTEGER NOT NULL,
    lap_seconds REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(pacing_color_id, segment_order)
);

CREATE TABLE home_popup (
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
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE home_popup_section (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    popup_id INTEGER NOT NULL REFERENCES home_popup(id) ON DELETE CASCADE,
    section_type TEXT NOT NULL DEFAULT 'text' CHECK(section_type IN ('text','image','button')),
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
    competition_id INTEGER NOT NULL REFERENCES competition(id),
    day_number INTEGER NOT NULL DEFAULT 1,
    time_slot TEXT NOT NULL DEFAULT '',
    event_name TEXT NOT NULL DEFAULT '',
    category TEXT DEFAULT '',
    gender TEXT DEFAULT '',
    round_text TEXT DEFAULT '',
    venue_area TEXT DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    notes TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
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

// Table names to copy data from (order matters for FK)
const TABLES = [
    'sqlite_sequence',
    'competition', 'athlete', 'event', 'event_entry',
    'heat', 'heat_entry', 'result', 'height_attempt',
    'combined_score', 'relay_member', 'qualification_selection',
    'operation_key', 'operation_log', 'audit_log', 'system_config',
    'event_link', 'pacing_config', 'pacing_color', 'pacing_segment',
    'home_popup', 'home_popup_section', 'federation_list',
    'timetable', 'doc_template', 'event_records'
];

console.log('Opening source DB (read-only, ignore schema errors)...');

// Open source with nativeBinding option to avoid schema check
const src = new Database(SOURCE, { fileMustExist: true });

// Create clean target
const tgt = new Database(TARGET);
tgt.pragma('journal_mode = WAL');
tgt.pragma('foreign_keys = OFF');

// Create schema
console.log('Creating clean schema...');
tgt.exec(SCHEMA);

// Create indexes
const INDEXES = `
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
`;
tgt.exec(INDEXES);

// Copy data table by table
for (const table of TABLES) {
    try {
        const rows = src.prepare(`SELECT * FROM "${table}"`).all();
        if (rows.length === 0) {
            console.log(`  ${table}: 0 rows (empty)`);
            continue;
        }
        
        const cols = Object.keys(rows[0]);
        const placeholders = cols.map(() => '?').join(',');
        const colStr = cols.map(c => `"${c}"`).join(',');
        
        const insert = tgt.prepare(`INSERT OR IGNORE INTO "${table}" (${colStr}) VALUES (${placeholders})`);
        const insertMany = tgt.transaction((data) => {
            for (const row of data) {
                insert.run(...cols.map(c => row[c]));
            }
        });
        
        insertMany(rows);
        console.log(`  ${table}: ${rows.length} rows copied`);
    } catch (e) {
        console.log(`  ${table}: ERROR - ${e.message.substring(0, 100)}`);
    }
}

src.close();
tgt.close();

console.log(`\nDone! Clean DB at ${TARGET}`);
console.log(`Size: ${(fs.statSync(TARGET).size / 1024 / 1024).toFixed(2)} MB`);
