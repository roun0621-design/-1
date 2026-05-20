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
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    video_url TEXT DEFAULT '',
    federation TEXT DEFAULT '',
    division_type TEXT DEFAULT '',
    mode TEXT NOT NULL DEFAULT 'operation',         -- 'operation' | 'display'
    series_id INTEGER REFERENCES competition_series(id)
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
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    video_url TEXT DEFAULT '',
    callroom_event_memo TEXT DEFAULT '',
    division TEXT NOT NULL DEFAULT '',
    result_url TEXT DEFAULT ''
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

-- ============================================================
-- Records Management v4 (NR/DR/CR 통합 모델)
-- ============================================================

-- Division Master (부별 마스터)
-- 13 codes: 성별 6 학교급(초/중/고/대/일반/공개) × 2 + MIXED(혼성)
CREATE TABLE IF NOT EXISTS division_master (
    code TEXT PRIMARY KEY,                          -- M_OPEN / F_HIGH / MIXED 등
    label_ko TEXT NOT NULL,                         -- 남자일반부, 여자고등부, 통합부
    gender TEXT NOT NULL CHECK(gender IN ('M','F','X')),
    school_level TEXT NOT NULL CHECK(school_level IN ('OPEN','ELEM','MID','HIGH','UNIV','GEN','MIXED')),
    sort_order INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Competition Series (대회 시리즈 = 회차 묶음)
-- 예: "전국실업단대항육상경기대회" 한 묶음 → 매년 1회 개최되는 시리즈
CREATE TABLE IF NOT EXISTS competition_series (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,                      -- 시리즈명
    federation TEXT NOT NULL DEFAULT '',            -- 주관 연맹 (KAAF, KTFL, etc.)
    description TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Event Records (NR/DR/CR 통합)
-- NR (national): division_code NULL, series_id NULL
-- DR (division): division_code 필수, series_id NULL
-- CR (competition): division_code NULL, series_id 필수
-- (구 스키마 마이그레이션은 server.js boot 단계에서 수행)
CREATE TABLE IF NOT EXISTS event_record (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    record_type TEXT NOT NULL CHECK(record_type IN ('national','division','competition')),
    event_name TEXT NOT NULL,                       -- 정규화된 종목명
    gender TEXT NOT NULL CHECK(gender IN ('M','F','X')),
    division_code TEXT REFERENCES division_master(code),  -- DR일 때만 필수
    series_id INTEGER REFERENCES competition_series(id),  -- CR일 때만 필수
    record_value TEXT NOT NULL DEFAULT '',          -- "10.21" or "11:23.45" 등 원본 문자열
    record_value_num REAL,                          -- 비교용 숫자(초·미터·점수)
    holder_name TEXT NOT NULL DEFAULT '',
    holder_team TEXT NOT NULL DEFAULT '',
    record_year TEXT NOT NULL DEFAULT '',
    record_date TEXT NOT NULL DEFAULT '',
    venue TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    approved INTEGER NOT NULL DEFAULT 1,            -- 시드 데이터는 즉시 승인
    approved_at TEXT,
    approved_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(record_type, event_name, gender, division_code, series_id)
);

-- Record Breaking Log (기록 갱신 이력 + 승인 큐)
-- 결과 저장 시 기존 record 대비 신기록 가능성 발견되면 pending으로 적재
-- 관리자가 승인하면 event_record가 갱신됨
CREATE TABLE IF NOT EXISTS record_breaking_log (
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
);

-- ============================================================
-- Division Master 시드 (13개)
-- ============================================================
INSERT OR IGNORE INTO division_master (code, label_ko, gender, school_level, sort_order) VALUES
    ('M_ELEM',  '남자초등부', 'M', 'ELEM',  10),
    ('M_MID',   '남자중학부', 'M', 'MID',   20),
    ('M_HIGH',  '남자고등부', 'M', 'HIGH',  30),
    ('M_UNIV',  '남자대학부', 'M', 'UNIV',  40),
    ('M_GEN',   '남자일반부', 'M', 'GEN',   50),
    ('M_OPEN',  '남자공개부', 'M', 'OPEN',  60),
    ('F_ELEM',  '여자초등부', 'F', 'ELEM', 110),
    ('F_MID',   '여자중학부', 'F', 'MID',  120),
    ('F_HIGH',  '여자고등부', 'F', 'HIGH', 130),
    ('F_UNIV',  '여자대학부', 'F', 'UNIV', 140),
    ('F_GEN',   '여자일반부', 'F', 'GEN',  150),
    ('F_OPEN',  '여자공개부', 'F', 'OPEN', 160),
    ('MIXED',   '통합부',     'X', 'MIXED', 900);

-- ============================================================
-- competition / event parity (PG에는 있지만 SQLite schema.sql에는 누락됐던 컬럼들)
-- 기존 DB에는 ALTER로 추가되므로 schema.sql만 갱신
-- ============================================================
-- competition.federation, division_type, mode, video_url, series_id
-- event.video_url, callroom_event_memo, division, result_url
-- (실제 ALTER는 server.js boot 마이그레이션에서 수행)

-- Event Records (legacy JSON bundle, 호환용 — Phase D에서 제거 예정)
CREATE TABLE IF NOT EXISTS event_records (
    event_id INTEGER PRIMARY KEY,
    records TEXT DEFAULT '{}'
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
