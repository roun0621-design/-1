-- ============================================================
-- Pace Rise Competition OS — Database Schema v3
-- Multi-competition support
-- ============================================================

PRAGMA foreign_keys = ON;

-- Competitions (대회)
CREATE TABLE IF NOT EXISTS competition (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    venue TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'upcoming' CHECK(status IN ('upcoming','active','completed')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Events (종목) — linked to competition
CREATE TABLE IF NOT EXISTS event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    competition_id INTEGER NOT NULL REFERENCES competition(id),
    name TEXT NOT NULL,
    category TEXT NOT NULL CHECK(category IN ('track','field_distance','field_height','combined','relay','road')),
    sort_order INTEGER NOT NULL DEFAULT 0,
    gender TEXT NOT NULL CHECK(gender IN ('M','F','X')),
    round_type TEXT NOT NULL DEFAULT 'final' CHECK(round_type IN ('preliminary','semifinal','final')),
    round_status TEXT NOT NULL DEFAULT 'created',
    parent_event_id INTEGER REFERENCES event(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Athletes (선수) — linked to competition
CREATE TABLE IF NOT EXISTS athlete (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    competition_id INTEGER NOT NULL REFERENCES competition(id),
    name TEXT NOT NULL,
    bib_number TEXT DEFAULT NULL,
    team TEXT NOT NULL DEFAULT '',
    barcode TEXT,
    gender TEXT NOT NULL CHECK(gender IN ('M','F')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Event Entries
CREATE TABLE IF NOT EXISTS event_entry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES event(id),
    athlete_id INTEGER NOT NULL REFERENCES athlete(id),
    status TEXT NOT NULL DEFAULT 'registered' CHECK(status IN ('registered','checked_in','no_show')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(event_id, athlete_id)
);

-- Heats (조)
CREATE TABLE IF NOT EXISTS heat (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES event(id),
    heat_number INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(event_id, heat_number)
);

-- Heat Entries
CREATE TABLE IF NOT EXISTS heat_entry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    heat_id INTEGER NOT NULL REFERENCES heat(id),
    event_entry_id INTEGER NOT NULL REFERENCES event_entry(id),
    lane_number INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(heat_id, event_entry_id)
);

-- Results (Track + Field Distance)
CREATE TABLE IF NOT EXISTS result (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    heat_id INTEGER NOT NULL REFERENCES heat(id),
    event_entry_id INTEGER NOT NULL REFERENCES event_entry(id),
    attempt_number INTEGER,
    distance_meters REAL,
    time_seconds REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(heat_id, event_entry_id, attempt_number)
);

-- Height Attempts
CREATE TABLE IF NOT EXISTS height_attempt (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    heat_id INTEGER NOT NULL REFERENCES heat(id),
    event_entry_id INTEGER NOT NULL REFERENCES event_entry(id),
    bar_height REAL NOT NULL,
    attempt_number INTEGER NOT NULL CHECK(attempt_number BETWEEN 1 AND 3),
    result_mark TEXT NOT NULL CHECK(result_mark IN ('O','X','PASS','-')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(heat_id, event_entry_id, bar_height, attempt_number)
);

-- Combined Scores
CREATE TABLE IF NOT EXISTS combined_score (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_entry_id INTEGER NOT NULL REFERENCES event_entry(id),
    sub_event_name TEXT NOT NULL,
    sub_event_order INTEGER NOT NULL,
    raw_record REAL,
    wa_points INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(event_entry_id, sub_event_order)
);

-- Qualification Selection
CREATE TABLE IF NOT EXISTS qualification_selection (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES event(id),
    event_entry_id INTEGER NOT NULL REFERENCES event_entry(id),
    selected INTEGER NOT NULL DEFAULT 0,
    approved INTEGER NOT NULL DEFAULT 0,
    approved_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(event_id, event_entry_id)
);

-- Audit Log (append-only)
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    competition_id INTEGER REFERENCES competition(id),
    table_name TEXT NOT NULL,
    record_id INTEGER NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('INSERT','UPDATE','DELETE')),
    old_values TEXT,
    new_values TEXT,
    performed_by TEXT NOT NULL DEFAULT 'system',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Operation Log
CREATE TABLE IF NOT EXISTS operation_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    competition_id INTEGER REFERENCES competition(id),
    message TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'general',
    performed_by TEXT NOT NULL DEFAULT 'system',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Relay Team Members (릴레이 팀 구성원)
CREATE TABLE IF NOT EXISTS relay_member (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_entry_id INTEGER NOT NULL REFERENCES event_entry(id),
    athlete_id INTEGER NOT NULL REFERENCES athlete(id),
    leg_order INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(event_entry_id, athlete_id)
);

-- Pacing Light Config (페이싱라이트 설정)
CREATE TABLE IF NOT EXISTS pacing_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    competition_id INTEGER NOT NULL REFERENCES competition(id),
    event_name TEXT NOT NULL,
    notice TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(competition_id, event_name)
);

-- Pacing Light Colors (컬러별 페이스 설정)
CREATE TABLE IF NOT EXISTS pacing_color (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pacing_config_id INTEGER NOT NULL REFERENCES pacing_config(id) ON DELETE CASCADE,
    color_key TEXT NOT NULL CHECK(color_key IN ('green','red','white','blue')),
    sort_order INTEGER NOT NULL DEFAULT 0,
    remark TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(pacing_config_id, color_key)
);

-- Pacing Light Segments (구간별 랩타임)
CREATE TABLE IF NOT EXISTS pacing_segment (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pacing_color_id INTEGER NOT NULL REFERENCES pacing_color(id) ON DELETE CASCADE,
    segment_order INTEGER NOT NULL,
    distance_meters INTEGER NOT NULL,
    lap_seconds REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(pacing_color_id, segment_order)
);

-- Operation Keys (심판별 운영키)
CREATE TABLE IF NOT EXISTS operation_key (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    judge_name TEXT NOT NULL,
    key_value TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL DEFAULT 'operation' CHECK(role IN ('operation','admin')),
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
