-- ============================================================
-- Pace Rise Competition OS — PostgreSQL Schema
-- Auto-generated from SQLite by scripts/sqlite_to_postgres_schema.js
-- Source: /home/user/webapp/db/competition.db
-- Generated: 2026-05-15T16:00:11.770Z
-- ============================================================

-- (외래키는 모든 테이블 생성 후 ALTER TABLE로 추가, 순서 의존 없음)

-- Table: athlete
CREATE TABLE IF NOT EXISTS "athlete" (
    "id" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "competition_id" BIGINT NOT NULL,
    "name" TEXT NOT NULL,
    "bib_number" TEXT DEFAULT NULL,
    "team" TEXT NOT NULL DEFAULT '',
    "barcode" TEXT,
    "gender" TEXT NOT NULL,
    "created_at" TEXT NOT NULL DEFAULT NOW(),
    "federation" TEXT DEFAULT '',
    "personal_best" TEXT DEFAULT '',
    "date_of_birth" TEXT DEFAULT '',
    CHECK (gender IN ('M','F'))
);

-- Table: audit_log
CREATE TABLE IF NOT EXISTS "audit_log" (
    "id" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "competition_id" BIGINT,
    "table_name" TEXT NOT NULL,
    "record_id" BIGINT NOT NULL,
    "action" TEXT NOT NULL,
    "old_values" TEXT,
    "new_values" TEXT,
    "performed_by" TEXT NOT NULL DEFAULT 'system',
    "created_at" TEXT NOT NULL DEFAULT NOW(),
    "ip_address" TEXT,
    "user_agent" TEXT,
    CHECK (action IN ('INSERT','UPDATE','DELETE'))
);

-- Table: combined_score
CREATE TABLE IF NOT EXISTS "combined_score" (
    "id" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "event_entry_id" BIGINT NOT NULL,
    "sub_event_name" TEXT NOT NULL,
    "sub_event_order" BIGINT NOT NULL,
    "raw_record" DOUBLE PRECISION,
    "wa_points" BIGINT NOT NULL DEFAULT 0,
    "created_at" TEXT NOT NULL DEFAULT NOW(),
    UNIQUE ("event_entry_id", "sub_event_order")
);

-- Table: competition
CREATE TABLE IF NOT EXISTS "competition" (
    "id" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "name" TEXT NOT NULL,
    "start_date" TEXT NOT NULL,
    "end_date" TEXT NOT NULL,
    "venue" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'upcoming',
    "created_at" TEXT NOT NULL DEFAULT NOW(),
    "video_url" TEXT DEFAULT '',
    "federation" TEXT DEFAULT '',
    "division_type" TEXT DEFAULT '',
    "mode" TEXT NOT NULL DEFAULT 'operation',
    "series_id" BIGINT,
    CHECK (status IN ('upcoming','active','completed'))
);

-- Table: display_roster
CREATE TABLE IF NOT EXISTS "display_roster" (
    "id" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "competition_id" BIGINT NOT NULL,
    "day" BIGINT NOT NULL DEFAULT 1,
    "event_name" TEXT NOT NULL DEFAULT '',
    "round" TEXT NOT NULL DEFAULT '',
    "division" TEXT NOT NULL DEFAULT '',
    "gender" TEXT NOT NULL DEFAULT '',
    "bib_number" TEXT DEFAULT '',
    "athlete_name" TEXT NOT NULL DEFAULT '',
    "team" TEXT NOT NULL DEFAULT '',
    "sort_order" BIGINT NOT NULL DEFAULT 0,
    "event_id" BIGINT DEFAULT NULL,
    "created_at" TEXT NOT NULL DEFAULT NOW(),
    "heat" BIGINT DEFAULT NULL,
    "lane" BIGINT DEFAULT NULL
);

-- Table: doc_template
CREATE TABLE IF NOT EXISTS "doc_template" (
    "competition_id" BIGINT PRIMARY KEY,
    "ad_card" TEXT DEFAULT '{}',
    "start_list" TEXT DEFAULT '{}',
    "result_sheet" TEXT DEFAULT '{}'
);

-- Table: event
CREATE TABLE IF NOT EXISTS "event" (
    "id" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "competition_id" BIGINT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "sort_order" BIGINT NOT NULL DEFAULT 0,
    "gender" TEXT NOT NULL,
    "round_type" TEXT NOT NULL DEFAULT 'final',
    "round_status" TEXT NOT NULL DEFAULT 'created',
    "parent_event_id" BIGINT,
    "created_at" TEXT NOT NULL DEFAULT NOW(),
    "video_url" TEXT DEFAULT '',
    "callroom_event_memo" TEXT DEFAULT '',
    "division" TEXT NOT NULL DEFAULT '',
    "result_url" TEXT DEFAULT '',
    CHECK (category IN ('track','field_distance','field_height','combined','relay','road')),
    CHECK (gender IN ('M','F','X')),
    CHECK (round_type IN ('preliminary','semifinal','final'))
);

-- Table: event_entry
CREATE TABLE IF NOT EXISTS "event_entry" (
    "id" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "event_id" BIGINT NOT NULL,
    "athlete_id" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'registered',
    "created_at" TEXT NOT NULL DEFAULT NOW(),
    "callroom_memo" TEXT DEFAULT '',
    CHECK (status IN ('registered','checked_in','no_show')),
    UNIQUE ("event_id", "athlete_id")
);

-- Table: event_link
CREATE TABLE IF NOT EXISTS "event_link" (
    "id" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "event_id_a" BIGINT NOT NULL,
    "event_id_b" BIGINT NOT NULL,
    "link_type" TEXT NOT NULL DEFAULT 'joint_scoreboard',
    "created_at" TEXT NOT NULL DEFAULT NOW(),
    "joint_scoreboard_key" TEXT DEFAULT NULL,
    UNIQUE ("event_id_a", "event_id_b")
);

-- ============================================================
-- Records Management v4 (NR/DR/CR 통합 모델) — PostgreSQL
-- ============================================================

-- Table: division_master (부별 마스터, 13개)
CREATE TABLE IF NOT EXISTS "division_master" (
    "code" TEXT PRIMARY KEY,
    "label_ko" TEXT NOT NULL,
    "gender" TEXT NOT NULL,
    "school_level" TEXT NOT NULL,
    "sort_order" BIGINT NOT NULL DEFAULT 0,
    "active" BIGINT NOT NULL DEFAULT 1,
    "created_at" TEXT NOT NULL DEFAULT NOW(),
    CHECK (gender IN ('M','F','X')),
    CHECK (school_level IN ('OPEN','ELEM','MID','HIGH','UNIV','GEN','MIXED'))
);

-- Table: competition_series (대회 시리즈 = 회차 묶음)
CREATE TABLE IF NOT EXISTS "competition_series" (
    "id" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "name" TEXT NOT NULL UNIQUE,
    "federation" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "active" BIGINT NOT NULL DEFAULT 1,
    "created_at" TEXT NOT NULL DEFAULT NOW(),
    "updated_at" TEXT NOT NULL DEFAULT NOW()
);

-- Table: event_record (NR/DR/CR 통합)
-- 기존 테이블은 boot 마이그레이션에서 drop 후 재생성
CREATE TABLE IF NOT EXISTS "event_record" (
    "id" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "record_type" TEXT NOT NULL,
    "event_name" TEXT NOT NULL,
    "gender" TEXT NOT NULL,
    "division_code" TEXT,
    "series_id" BIGINT,
    "record_value" TEXT NOT NULL DEFAULT '',
    "record_value_num" DOUBLE PRECISION,
    "holder_name" TEXT NOT NULL DEFAULT '',
    "holder_team" TEXT NOT NULL DEFAULT '',
    "record_year" TEXT NOT NULL DEFAULT '',
    "record_date" TEXT NOT NULL DEFAULT '',
    "venue" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "approved" BIGINT NOT NULL DEFAULT 1,
    "approved_at" TEXT,
    "approved_by" TEXT,
    "created_at" TEXT NOT NULL DEFAULT NOW(),
    "updated_at" TEXT NOT NULL DEFAULT NOW(),
    CHECK (gender IN ('M','F','X')),
    CHECK (record_type IN ('national','division','competition'))
);
-- UNIQUE constraint on nullable columns: SQLite treats NULLs as distinct (OK),
-- PostgreSQL treats NULLs as distinct by default too. Add as separate constraint:
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'event_record_unique_v4') THEN
        ALTER TABLE "event_record" ADD CONSTRAINT event_record_unique_v4
            UNIQUE ("record_type", "event_name", "gender", "division_code", "series_id");
    END IF;
END $$;

-- Table: record_breaking_log (기록 갱신 이력 + 승인 큐)
CREATE TABLE IF NOT EXISTS "record_breaking_log" (
    "id" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "competition_id" BIGINT NOT NULL,
    "event_id" BIGINT,
    "event_entry_id" BIGINT,
    "record_type" TEXT NOT NULL,
    "event_name" TEXT NOT NULL,
    "gender" TEXT NOT NULL,
    "division_code" TEXT,
    "series_id" BIGINT,
    "previous_record_id" BIGINT,
    "previous_value" TEXT NOT NULL DEFAULT '',
    "new_value" TEXT NOT NULL DEFAULT '',
    "new_value_num" DOUBLE PRECISION,
    "athlete_name" TEXT NOT NULL DEFAULT '',
    "athlete_team" TEXT NOT NULL DEFAULT '',
    "bib_number" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "detected_at" TEXT NOT NULL DEFAULT NOW(),
    "reviewed_at" TEXT,
    "reviewed_by" TEXT,
    "review_note" TEXT NOT NULL DEFAULT '',
    CHECK (status IN ('pending','approved','rejected')),
    CHECK (record_type IN ('national','division','competition'))
);

-- Division Master seed (13 rows)
INSERT INTO "division_master" (code, label_ko, gender, school_level, sort_order) VALUES
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
    ('MIXED',   '통합부',     'X', 'MIXED', 900)
ON CONFLICT (code) DO NOTHING;

-- Table: event_records
CREATE TABLE IF NOT EXISTS "event_records" (
    "event_id" BIGINT PRIMARY KEY,
    "records" TEXT DEFAULT '{}'
);

-- Table: external_api_key
CREATE TABLE IF NOT EXISTS "external_api_key" (
    "id" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "key_hash" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "allowed_competition_id" BIGINT DEFAULT NULL,
    "rate_limit_per_min" BIGINT NOT NULL DEFAULT 60,
    "expires_at" TEXT DEFAULT NULL,
    "revoked_at" TEXT DEFAULT NULL,
    "last_used_at" TEXT DEFAULT NULL,
    "total_calls" BIGINT NOT NULL DEFAULT 0,
    "created_at" TEXT NOT NULL DEFAULT NOW(),
    "created_by" TEXT NOT NULL DEFAULT 'admin'
);

-- Table: external_api_log
CREATE TABLE IF NOT EXISTS "external_api_log" (
    "id" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "api_key_id" BIGINT DEFAULT NULL,
    "key_prefix" TEXT DEFAULT '',
    "endpoint" TEXT NOT NULL DEFAULT '',
    "method" TEXT NOT NULL DEFAULT 'POST',
    "request_ip" TEXT DEFAULT '',
    "user_agent" TEXT DEFAULT '',
    "competition_id" BIGINT DEFAULT NULL,
    "event_id" BIGINT DEFAULT NULL,
    "request_body" TEXT DEFAULT '',
    "response_status" BIGINT NOT NULL DEFAULT 0,
    "response_code" TEXT DEFAULT '',
    "duration_ms" BIGINT DEFAULT 0,
    "created_at" TEXT NOT NULL DEFAULT NOW()
);

-- Table: federation_list
CREATE TABLE IF NOT EXISTS "federation_list" (
    "id" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "badge_bg" TEXT NOT NULL DEFAULT '#e3f2fd',
    "badge_color" TEXT NOT NULL DEFAULT '#1565c0',
    "sort_order" BIGINT NOT NULL DEFAULT 0,
    "created_at" TEXT NOT NULL DEFAULT NOW(),
    "gender_label_m" TEXT DEFAULT '',
    "gender_label_f" TEXT DEFAULT '',
    "gender_label_x" TEXT DEFAULT '',
    UNIQUE ("code")
);

-- Table: heat
CREATE TABLE IF NOT EXISTS "heat" (
    "id" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "event_id" BIGINT NOT NULL,
    "heat_number" BIGINT NOT NULL,
    "created_at" TEXT NOT NULL DEFAULT NOW(),
    "wind" TEXT DEFAULT NULL,
    "heat_name" TEXT DEFAULT NULL,
    "scoreboard_key" TEXT DEFAULT NULL,
    UNIQUE ("event_id", "heat_number")
);

-- Table: heat_entry
CREATE TABLE IF NOT EXISTS "heat_entry" (
    "id" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "heat_id" BIGINT NOT NULL,
    "event_entry_id" BIGINT NOT NULL,
    "lane_number" BIGINT,
    "created_at" TEXT NOT NULL DEFAULT NOW(),
    "sub_group" TEXT DEFAULT NULL,
    UNIQUE ("heat_id", "event_entry_id")
);

-- Table: height_attempt
CREATE TABLE IF NOT EXISTS "height_attempt" (
    "id" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "heat_id" BIGINT NOT NULL,
    "event_entry_id" BIGINT NOT NULL,
    "bar_height" DOUBLE PRECISION NOT NULL,
    "attempt_number" BIGINT NOT NULL,
    "result_mark" TEXT NOT NULL,
    "created_at" TEXT NOT NULL DEFAULT NOW(),
    CHECK (attempt_number BETWEEN 1 AND 3),
    CHECK (result_mark IN ('O','X','PASS','-')),  -- '-' = 시기 자체 무시(미시도). 운영 PG는 ALTER 로 패치 완료(2026-05-19), 신규 부팅도 호환.
    UNIQUE ("heat_id", "event_entry_id", "bar_height", "attempt_number")
);

-- Table: home_popup
CREATE TABLE IF NOT EXISTS "home_popup" (
    "id" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "popup_type" TEXT NOT NULL DEFAULT 'public',
    "title" TEXT NOT NULL DEFAULT '',
    "subtitle" TEXT NOT NULL DEFAULT '',
    "intro_text" TEXT NOT NULL DEFAULT '',
    "bottom_btn_text" TEXT NOT NULL DEFAULT '',
    "bottom_btn_desc" TEXT NOT NULL DEFAULT '',
    "bottom_btn_link" TEXT NOT NULL DEFAULT '',
    "bottom_btn_active" BIGINT NOT NULL DEFAULT 1,
    "is_active" BIGINT NOT NULL DEFAULT 1,
    "show_from" TEXT DEFAULT NULL,
    "show_until" TEXT DEFAULT NULL,
    "created_at" TEXT NOT NULL DEFAULT NOW(),
    "updated_at" TEXT NOT NULL DEFAULT NOW(),
    "sort_order" BIGINT NOT NULL DEFAULT 0,
    CHECK (popup_type IN ('public','admin'))
);

-- Table: home_popup_section
CREATE TABLE IF NOT EXISTS "home_popup_section" (
    "id" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "popup_id" BIGINT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "content" TEXT NOT NULL DEFAULT '',
    "link_btn_text" TEXT NOT NULL DEFAULT '',
    "link_btn_url" TEXT NOT NULL DEFAULT '',
    "sort_order" BIGINT NOT NULL DEFAULT 0,
    "is_active" BIGINT NOT NULL DEFAULT 1,
    "created_at" TEXT NOT NULL DEFAULT NOW()
);

-- Table: joint_group
CREATE TABLE IF NOT EXISTS "joint_group" (
    "id" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "name" TEXT NOT NULL DEFAULT '',
    "joint_scoreboard_key" TEXT,
    "created_at" TEXT NOT NULL DEFAULT NOW()
);

-- Table: joint_group_member
CREATE TABLE IF NOT EXISTS "joint_group_member" (
    "id" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "joint_group_id" BIGINT NOT NULL,
    "event_id" BIGINT NOT NULL,
    "competition_id" BIGINT NOT NULL,
    "sort_order" BIGINT NOT NULL DEFAULT 0,
    UNIQUE ("joint_group_id", "event_id")
);

-- Table: operation_key
CREATE TABLE IF NOT EXISTS "operation_key" (
    "id" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "judge_name" TEXT NOT NULL,
    "key_value" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'operation',
    "active" BIGINT NOT NULL DEFAULT 1,
    "created_at" TEXT NOT NULL DEFAULT NOW(),
    "can_manage" BIGINT NOT NULL DEFAULT 0,
    CHECK (role IN ('operation','admin')),
    UNIQUE ("key_value")
);

-- Table: operation_log
CREATE TABLE IF NOT EXISTS "operation_log" (
    "id" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "competition_id" BIGINT,
    "message" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'general',
    "performed_by" TEXT NOT NULL DEFAULT 'system',
    "created_at" TEXT NOT NULL DEFAULT NOW()
);

-- Table: pacing_color
CREATE TABLE IF NOT EXISTS "pacing_color" (
    "id" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "pacing_config_id" BIGINT NOT NULL,
    "color_key" TEXT NOT NULL,
    "sort_order" BIGINT NOT NULL DEFAULT 0,
    "remark" TEXT NOT NULL DEFAULT '',
    "created_at" TEXT NOT NULL DEFAULT NOW(),
    CHECK (color_key IN ('green','red','white','blue')),
    UNIQUE ("pacing_config_id", "color_key")
);

-- Table: pacing_config
CREATE TABLE IF NOT EXISTS "pacing_config" (
    "id" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "competition_id" BIGINT NOT NULL,
    "event_name" TEXT NOT NULL,
    "notice" TEXT NOT NULL DEFAULT '',
    "created_at" TEXT NOT NULL DEFAULT NOW(),
    "updated_at" TEXT NOT NULL DEFAULT NOW(),
    UNIQUE ("competition_id", "event_name")
);

-- Table: pacing_segment
CREATE TABLE IF NOT EXISTS "pacing_segment" (
    "id" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "pacing_color_id" BIGINT NOT NULL,
    "segment_order" BIGINT NOT NULL,
    "distance_meters" BIGINT NOT NULL,
    "lap_seconds" DOUBLE PRECISION NOT NULL,
    "created_at" TEXT NOT NULL DEFAULT NOW(),
    UNIQUE ("pacing_color_id", "segment_order")
);

-- Table: qualification_selection
CREATE TABLE IF NOT EXISTS "qualification_selection" (
    "id" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "event_id" BIGINT NOT NULL,
    "event_entry_id" BIGINT NOT NULL,
    "selected" BIGINT NOT NULL DEFAULT 0,
    "approved" BIGINT NOT NULL DEFAULT 0,
    "approved_by" TEXT,
    "created_at" TEXT NOT NULL DEFAULT NOW(),
    "updated_at" TEXT NOT NULL DEFAULT NOW(),
    "qualification_type" TEXT DEFAULT '',
    UNIQUE ("event_id", "event_entry_id")
);

-- Table: relay_member
CREATE TABLE IF NOT EXISTS "relay_member" (
    "id" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "event_entry_id" BIGINT NOT NULL,
    "athlete_id" BIGINT NOT NULL,
    "leg_order" BIGINT,
    "created_at" TEXT NOT NULL DEFAULT NOW(),
    UNIQUE ("event_entry_id", "athlete_id")
);

-- Table: result
CREATE TABLE IF NOT EXISTS "result" (
    "id" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "heat_id" BIGINT NOT NULL,
    "event_entry_id" BIGINT NOT NULL,
    "attempt_number" BIGINT,
    "distance_meters" DOUBLE PRECISION,
    "time_seconds" DOUBLE PRECISION,
    "created_at" TEXT NOT NULL DEFAULT NOW(),
    "updated_at" TEXT NOT NULL DEFAULT NOW(),
    "remark" TEXT DEFAULT '',
    "status_code" TEXT DEFAULT '',
    "wind" DOUBLE PRECISION DEFAULT NULL,
    UNIQUE ("heat_id", "event_entry_id", "attempt_number")
);

-- Table: system_config
CREATE TABLE IF NOT EXISTS "system_config" (
    "key" TEXT PRIMARY KEY,
    "value" TEXT NOT NULL
);

-- Table: timetable
CREATE TABLE IF NOT EXISTS "timetable" (
    "id" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "competition_id" BIGINT NOT NULL,
    "day" BIGINT NOT NULL DEFAULT 1,
    "section" TEXT NOT NULL DEFAULT 'track',
    "time" TEXT NOT NULL,
    "event_name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT '',
    "round" TEXT NOT NULL DEFAULT '',
    "note" TEXT DEFAULT '',
    "sort_order" BIGINT DEFAULT 0,
    "event_id" BIGINT DEFAULT NULL,
    "callroom_time" TEXT DEFAULT NULL,
    "scheduled_date" TEXT DEFAULT NULL,
    "event_ids" TEXT DEFAULT NULL,
    UNIQUE ("competition_id", "day", "section", "time", "event_name", "category", "round")
);

-- ============================================================
-- Foreign Keys (deferred — added after all tables exist)
-- ============================================================

DO $$ BEGIN ALTER TABLE "athlete" ADD CONSTRAINT "fk_athlete_competition_id" FOREIGN KEY ("competition_id") REFERENCES "competition" ("id"); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "audit_log" ADD CONSTRAINT "fk_audit_log_competition_id" FOREIGN KEY ("competition_id") REFERENCES "competition" ("id"); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "combined_score" ADD CONSTRAINT "fk_combined_score_event_entry_id" FOREIGN KEY ("event_entry_id") REFERENCES "event_entry" ("id"); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "display_roster" ADD CONSTRAINT "fk_display_roster_competition_id" FOREIGN KEY ("competition_id") REFERENCES "competition" ("id"); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "event" ADD CONSTRAINT "fk_event_parent_event_id" FOREIGN KEY ("parent_event_id") REFERENCES "event" ("id"); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "event" ADD CONSTRAINT "fk_event_competition_id" FOREIGN KEY ("competition_id") REFERENCES "competition" ("id"); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "event_entry" ADD CONSTRAINT "fk_event_entry_athlete_id" FOREIGN KEY ("athlete_id") REFERENCES "athlete" ("id"); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "event_entry" ADD CONSTRAINT "fk_event_entry_event_id" FOREIGN KEY ("event_id") REFERENCES "event" ("id"); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "event_link" ADD CONSTRAINT "fk_event_link_event_id_b" FOREIGN KEY ("event_id_b") REFERENCES "event" ("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "event_link" ADD CONSTRAINT "fk_event_link_event_id_a" FOREIGN KEY ("event_id_a") REFERENCES "event" ("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "external_api_key" ADD CONSTRAINT "fk_external_api_key_allowed_competition_id" FOREIGN KEY ("allowed_competition_id") REFERENCES "competition" ("id") ON DELETE SET NULL; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "external_api_log" ADD CONSTRAINT "fk_external_api_log_api_key_id" FOREIGN KEY ("api_key_id") REFERENCES "external_api_key" ("id") ON DELETE SET NULL; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "heat" ADD CONSTRAINT "fk_heat_event_id" FOREIGN KEY ("event_id") REFERENCES "event" ("id"); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "heat_entry" ADD CONSTRAINT "fk_heat_entry_event_entry_id" FOREIGN KEY ("event_entry_id") REFERENCES "event_entry" ("id"); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "heat_entry" ADD CONSTRAINT "fk_heat_entry_heat_id" FOREIGN KEY ("heat_id") REFERENCES "heat" ("id"); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "height_attempt" ADD CONSTRAINT "fk_height_attempt_event_entry_id" FOREIGN KEY ("event_entry_id") REFERENCES "event_entry" ("id"); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "height_attempt" ADD CONSTRAINT "fk_height_attempt_heat_id" FOREIGN KEY ("heat_id") REFERENCES "heat" ("id"); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "home_popup_section" ADD CONSTRAINT "fk_home_popup_section_popup_id" FOREIGN KEY ("popup_id") REFERENCES "home_popup" ("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "joint_group_member" ADD CONSTRAINT "fk_joint_group_member_competition_id" FOREIGN KEY ("competition_id") REFERENCES "competition" ("id"); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "joint_group_member" ADD CONSTRAINT "fk_joint_group_member_event_id" FOREIGN KEY ("event_id") REFERENCES "event" ("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "joint_group_member" ADD CONSTRAINT "fk_joint_group_member_joint_group_id" FOREIGN KEY ("joint_group_id") REFERENCES "joint_group" ("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "operation_log" ADD CONSTRAINT "fk_operation_log_competition_id" FOREIGN KEY ("competition_id") REFERENCES "competition" ("id"); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "pacing_color" ADD CONSTRAINT "fk_pacing_color_pacing_config_id" FOREIGN KEY ("pacing_config_id") REFERENCES "pacing_config" ("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "pacing_config" ADD CONSTRAINT "fk_pacing_config_competition_id" FOREIGN KEY ("competition_id") REFERENCES "competition" ("id"); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "pacing_segment" ADD CONSTRAINT "fk_pacing_segment_pacing_color_id" FOREIGN KEY ("pacing_color_id") REFERENCES "pacing_color" ("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "qualification_selection" ADD CONSTRAINT "fk_qualification_selection_event_entry_id" FOREIGN KEY ("event_entry_id") REFERENCES "event_entry" ("id"); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "qualification_selection" ADD CONSTRAINT "fk_qualification_selection_event_id" FOREIGN KEY ("event_id") REFERENCES "event" ("id"); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "relay_member" ADD CONSTRAINT "fk_relay_member_athlete_id" FOREIGN KEY ("athlete_id") REFERENCES "athlete" ("id"); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "relay_member" ADD CONSTRAINT "fk_relay_member_event_entry_id" FOREIGN KEY ("event_entry_id") REFERENCES "event_entry" ("id"); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "result" ADD CONSTRAINT "fk_result_event_entry_id" FOREIGN KEY ("event_entry_id") REFERENCES "event_entry" ("id"); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "result" ADD CONSTRAINT "fk_result_heat_id" FOREIGN KEY ("heat_id") REFERENCES "heat" ("id"); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- Indexes
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_athlete_comp_bib ON athlete(competition_id, bib_number);
CREATE INDEX IF NOT EXISTS idx_athlete_comp_name ON athlete(competition_id, name);
CREATE INDEX IF NOT EXISTS idx_athlete_competition ON athlete(competition_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_comp ON audit_log(competition_id);
CREATE INDEX IF NOT EXISTS idx_combined_score_entry ON combined_score(event_entry_id);
CREATE INDEX IF NOT EXISTS idx_display_roster_comp ON display_roster(competition_id);
CREATE INDEX IF NOT EXISTS idx_display_roster_event ON display_roster(competition_id, event_id);
CREATE INDEX IF NOT EXISTS idx_event_comp_gender ON event(competition_id, gender);
CREATE INDEX IF NOT EXISTS idx_event_competition ON event(competition_id);
CREATE INDEX IF NOT EXISTS idx_event_parent ON event(parent_event_id);
CREATE INDEX IF NOT EXISTS idx_event_entry_athlete ON event_entry(athlete_id);
CREATE INDEX IF NOT EXISTS idx_event_entry_event ON event_entry(event_id);
CREATE INDEX IF NOT EXISTS idx_extkey_prefix ON external_api_key(key_prefix);
CREATE INDEX IF NOT EXISTS idx_extlog_created ON external_api_log(created_at);
CREATE INDEX IF NOT EXISTS idx_extlog_keyid ON external_api_log(api_key_id, created_at);
CREATE INDEX IF NOT EXISTS idx_heat_event ON heat(event_id);
CREATE INDEX IF NOT EXISTS idx_heat_entry_event_entry ON heat_entry(event_entry_id);
CREATE INDEX IF NOT EXISTS idx_heat_entry_heat ON heat_entry(heat_id);
CREATE INDEX IF NOT EXISTS idx_height_attempt_heat ON height_attempt(heat_id);
CREATE INDEX IF NOT EXISTS idx_operation_log_comp ON operation_log(competition_id);
CREATE INDEX IF NOT EXISTS idx_relay_member_entry ON relay_member(event_entry_id);
CREATE INDEX IF NOT EXISTS idx_result_event_entry ON result(event_entry_id);
CREATE INDEX IF NOT EXISTS idx_result_heat ON result(heat_id);
CREATE INDEX IF NOT EXISTS ux_timetable_full ON timetable(competition_id, day, section, time, event_name, category, round);
