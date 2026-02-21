-- ============================================================
-- Pace Rise Competition OS — Database Schema v2
-- 올림픽 육상 전 종목 지원
-- ============================================================

PRAGMA foreign_keys = ON;

-- Events (종목)
CREATE TABLE IF NOT EXISTS event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    category TEXT NOT NULL CHECK(category IN ('track','field_distance','field_height','combined')),
    gender TEXT NOT NULL CHECK(gender IN ('M','F','X')),
    round_type TEXT NOT NULL DEFAULT 'final' CHECK(round_type IN ('preliminary','semifinal','final')),
    round_status TEXT NOT NULL DEFAULT 'created',
    parent_event_id INTEGER REFERENCES event(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Athletes (선수)
CREATE TABLE IF NOT EXISTS athlete (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    bib_number TEXT NOT NULL UNIQUE,
    team TEXT NOT NULL DEFAULT '',
    barcode TEXT UNIQUE,
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

-- Height Attempts (높이뛰기/장대높이뛰기)
CREATE TABLE IF NOT EXISTS height_attempt (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    heat_id INTEGER NOT NULL REFERENCES heat(id),
    event_entry_id INTEGER NOT NULL REFERENCES event_entry(id),
    bar_height REAL NOT NULL,
    attempt_number INTEGER NOT NULL CHECK(attempt_number BETWEEN 1 AND 3),
    result_mark TEXT NOT NULL CHECK(result_mark IN ('O','X','PASS')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(heat_id, event_entry_id, bar_height, attempt_number)
);

-- Combined Scores (혼성 경기 10종/7종)
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
    table_name TEXT NOT NULL,
    record_id INTEGER NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('INSERT','UPDATE','DELETE')),
    old_values TEXT,
    new_values TEXT,
    performed_by TEXT NOT NULL DEFAULT 'system',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
