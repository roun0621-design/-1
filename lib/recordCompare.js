// ============================================================
// recordCompare.js — Phase C1
// result 저장 시 NR/DR/CR 기록 갱신 자동 감지 → record_breaking_log
// ============================================================
//
// 사용:
//   const { detectRecordBreaks } = require('./lib/recordCompare');
//   await detectRecordBreaks(db, { result, heat, event, athlete, competition, eventEntry });
//
// 설계 원칙:
// - best-effort: 실패해도 throw 안 함 (호출자가 try/catch 없이 호출 가능)
// - SQLite/PG 양쪽 호환 (db.isAsync flag 활용)
// - NULL-aware: division_code/series_id IS NULL 매칭 정확히
// - 중복 pending 방지: 같은 (event_entry_id, attempt_number, record_type, division, series)
//   조합으로 이미 pending 행이 있으면 UPDATE, 없으면 INSERT
// - 종목명 정규화: event.name이 기록 관리탭의 정식명과 매칭되는지 best-effort 정규화
// ============================================================

'use strict';

// ─── 종목 카테고리 → 비교 방향 ───────────────────────────────
// track / road: 낮을수록 좋음 (time_seconds)
// field_distance / field_height: 높을수록 좋음 (distance_meters)
// combined: 일단 제외 (점수 계산이 별도)
// relay: 트랙과 동일 (낮을수록)
function getCompareDirection(category) {
    if (category === 'field_distance' || category === 'field_height') return 'higher';
    if (category === 'track' || category === 'road' || category === 'relay') return 'lower';
    return null; // combined 등은 비교 안 함
}

// ─── 종목명 정규화 ────────────────────────────────────────────
// event.name이 매트릭스의 정식 종목명과 다를 수 있어 best-effort 매칭.
// 예: "100m 예선" → "100m", "남자 100미터" → "100m"
function normalizeEventName(name) {
    if (!name) return '';
    let s = String(name).trim();
    // 라운드 토큰 제거
    s = s.replace(/\s*(예선|준결승|결승|preliminary|semifinal|final)\s*/gi, ' ').trim();
    // 성별 토큰 제거 (정식명에 성별 prefix 없음)
    s = s.replace(/^(남자|여자|남|여|M|F)\s+/i, '').trim();
    // 한글 단위 통일
    s = s.replace(/미터\s*허들/g, 'mH')
         .replace(/미터\s*장애물/g, 'mSC')
         .replace(/미터\s*경보/g, 'mW')
         .replace(/미터/g, 'm');
    // 릴레이 표기 통일: 4×100m, 4x100M, 400×4 → 4x100mR
    s = s.replace(/×/g, 'x').replace(/X/g, 'x');
    s = s.replace(/(\d+)\s*x\s*(\d+)\s*m(?:\s*릴레이|\s*계주|\s*R)?/gi, '$1x$2mR');
    // 공백 정리
    s = s.replace(/\s+/g, ' ').trim();
    return s;
}

// ─── 값 비교: 새 값이 기존 기록보다 좋은가? ─────────────────────
// recordValue: 문자열일 수 있음 ("10.34", "8.21m", "2:05.12")
// 파싱: 콜론 포함하면 분/초 변환, 'm' suffix는 제거, 그 외 parseFloat
function parseRecordValue(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    const s = String(v).trim().replace(/m$/i, '').replace(/\s+/g, '');
    if (s.includes(':')) {
        // mm:ss.xx or hh:mm:ss.xx
        const parts = s.split(':').map(parseFloat);
        if (parts.some(isNaN)) return null;
        if (parts.length === 2) return parts[0] * 60 + parts[1];
        if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
        return null;
    }
    const n = parseFloat(s);
    return isNaN(n) ? null : n;
}

function isBetter(newVal, oldVal, direction) {
    if (newVal === null || !isFinite(newVal)) return false;
    if (oldVal === null || !isFinite(oldVal)) return true; // 기존 기록 없음 → 신기록
    if (direction === 'lower') return newVal < oldVal;
    if (direction === 'higher') return newVal > oldVal;
    return false;
}

// ─── DB 헬퍼: 기존 event_record 조회 (NULL-aware) ────────────
async function findEventRecord(db, record_type, event_name, gender, division_code, series_id) {
    if (division_code == null && series_id == null) {
        return await db.get(
            `SELECT * FROM event_record WHERE record_type=? AND event_name=? AND gender=?
             AND division_code IS NULL AND series_id IS NULL AND approved=1
             ORDER BY id DESC LIMIT 1`,
            record_type, event_name, gender
        );
    }
    if (division_code != null && series_id == null) {
        return await db.get(
            `SELECT * FROM event_record WHERE record_type=? AND event_name=? AND gender=?
             AND division_code=? AND series_id IS NULL AND approved=1
             ORDER BY id DESC LIMIT 1`,
            record_type, event_name, gender, division_code
        );
    }
    if (division_code == null && series_id != null) {
        return await db.get(
            `SELECT * FROM event_record WHERE record_type=? AND event_name=? AND gender=?
             AND division_code IS NULL AND series_id=? AND approved=1
             ORDER BY id DESC LIMIT 1`,
            record_type, event_name, gender, series_id
        );
    }
    return null;
}

// ─── DB 헬퍼: 같은 컨텍스트로 pending 로그가 이미 있는지 ─────
async function findExistingPending(db, event_entry_id, attempt_number, record_type, division_code, series_id) {
    const attClause = (attempt_number == null) ? 'IS NULL' : '= ?';
    const dcClause  = (division_code == null) ? 'IS NULL' : '= ?';
    const siClause  = (series_id == null) ? 'IS NULL' : '= ?';
    const sql = `SELECT * FROM record_breaking_log
                 WHERE event_entry_id=? AND record_type=? AND status='pending'
                 AND division_code ${dcClause} AND series_id ${siClause}
                 ORDER BY id DESC LIMIT 1`;
    const params = [event_entry_id, record_type];
    if (division_code != null) params.push(division_code);
    if (series_id != null) params.push(series_id);
    return await db.get(sql, ...params);
}

// ─── 단일 record_type 비교 + 로깅 ────────────────────────────
async function compareAndLog(db, ctx, record_type, division_code, series_id) {
    const { result, event, athlete, competition, eventEntry, newValueNum, direction, normalizedName } = ctx;
    if (!normalizedName) return null;

    const existing = await findEventRecord(db, record_type, normalizedName, event.gender, division_code, series_id);
    const existingNum = existing ? parseRecordValue(existing.record_value) : null;

    if (!isBetter(newValueNum, existingNum, direction)) return null;

    // newValue 문자열 표현
    const newValueStr = formatValueForDisplay(newValueNum, direction, event.category);

    // 중복 pending 검사 — 같은 entry/attempt/타입/부/시리즈
    const existingPending = await findExistingPending(
        db, result.event_entry_id, result.attempt_number, record_type, division_code, series_id
    );

    const nowFn = db.isAsync ? 'NOW()' : "datetime('now')";

    if (existingPending) {
        // 이미 pending이 있으면 새 값으로 업데이트
        await db.run(
            `UPDATE record_breaking_log
             SET previous_record_id=?, previous_value=?, new_value=?, new_value_num=?,
                 athlete_name=?, athlete_team=?, bib_number=?,
                 detected_at=${nowFn}
             WHERE id=?`,
            existing ? existing.id : null,
            existing ? (existing.record_value || '') : '',
            newValueStr, newValueNum,
            athlete?.name || '', athlete?.team || '', athlete?.bib_number || '',
            existingPending.id
        );
        return { id: existingPending.id, updated: true, record_type, division_code, series_id };
    }

    // 신규 INSERT
    const info = await db.run(
        `INSERT INTO record_breaking_log
         (competition_id, event_id, event_entry_id, record_type, event_name, gender,
          division_code, series_id, previous_record_id, previous_value, new_value, new_value_num,
          athlete_name, athlete_team, bib_number, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')`,
        competition.id, event.id, result.event_entry_id, record_type, normalizedName, event.gender,
        division_code, series_id,
        existing ? existing.id : null,
        existing ? (existing.record_value || '') : '',
        newValueStr, newValueNum,
        athlete?.name || '', athlete?.team || '', athlete?.bib_number || ''
    );
    return { id: info.lastInsertRowid, created: true, record_type, division_code, series_id };
}

// ─── 값 표시 포맷 ────────────────────────────────────────────
function formatValueForDisplay(num, direction, category) {
    if (num == null || !isFinite(num)) return '';
    if (direction === 'higher') {
        // 거리/높이: m 단위, 소수 2자리
        return num.toFixed(2);
    }
    // 시간: 60초 이상이면 mm:ss.xx, 미만이면 ss.xx
    if (num >= 60) {
        const m = Math.floor(num / 60);
        const s = num - m * 60;
        if (m >= 60) {
            const h = Math.floor(m / 60);
            const mm = m - h * 60;
            return `${h}:${String(mm).padStart(2,'0')}:${s.toFixed(2).padStart(5,'0')}`;
        }
        return `${m}:${s.toFixed(2).padStart(5,'0')}`;
    }
    return num.toFixed(2);
}

// ─── 메인 export: detectRecordBreaks ─────────────────────────
//   db: lib/db.js 인스턴스
//   ctx: { result, heat, event, athlete, competition, eventEntry }
//
// 모든 컨텍스트는 row 객체 (DB에서 이미 SELECT된 것). 호출자가 미리 로딩.
//
// 반환: { detected: [...], skipped: 'reason' }  (실패해도 throw 안 함)
// ============================================================
async function detectRecordBreaks(db, ctx) {
    try {
        const { result, event, athlete, competition } = ctx;
        if (!result || !event || !competition) return { detected: [], skipped: 'missing-context' };

        // DQ/DNS/DNF/NM 같은 비유효 상태는 비교 안 함
        if (result.status_code && result.status_code !== '') {
            return { detected: [], skipped: 'status-code:' + result.status_code };
        }

        const direction = getCompareDirection(event.category);
        if (!direction) return { detected: [], skipped: 'category-skipped:' + event.category };

        // new value 추출
        let newValueNum = null;
        if (direction === 'lower') {
            newValueNum = (typeof result.time_seconds === 'number' && result.time_seconds > 0)
                ? result.time_seconds : null;
        } else {
            newValueNum = (typeof result.distance_meters === 'number' && result.distance_meters > 0)
                ? result.distance_meters : null;
        }
        if (newValueNum == null) return { detected: [], skipped: 'no-valid-value' };

        const normalizedName = normalizeEventName(event.name);
        if (!normalizedName) return { detected: [], skipped: 'name-normalize-failed' };

        const enrichedCtx = { ...ctx, newValueNum, direction, normalizedName };
        const detected = [];

        // 1) NR (national)
        const nrRes = await compareAndLog(db, enrichedCtx, 'national', null, null);
        if (nrRes) detected.push(nrRes);

        // 2) DR (division) — event.division 가 division_master에 존재할 때만
        if (event.division && event.division !== '') {
            // event.division이 부 코드(M_OPEN 등)와 일치하는지 검증
            const divExists = await db.get(
                'SELECT code FROM division_master WHERE code=? AND active=1',
                event.division
            );
            if (divExists) {
                const drRes = await compareAndLog(db, enrichedCtx, 'division', event.division, null);
                if (drRes) detected.push(drRes);
            }
        }

        // 3) CR (competition) — competition.series_id 가 있을 때만
        if (competition.series_id) {
            const sExists = await db.get(
                'SELECT id FROM competition_series WHERE id=? AND active=1',
                competition.series_id
            );
            if (sExists) {
                const crRes = await compareAndLog(db, enrichedCtx, 'competition', null, competition.series_id);
                if (crRes) detected.push(crRes);
            }
        }

        return { detected, skipped: null };
    } catch (err) {
        // 절대 throw 안 함 — 콘솔 로깅만
        console.error('[recordCompare] detectRecordBreaks failed:', err && err.message);
        return { detected: [], skipped: 'error:' + (err && err.message) };
    }
}

module.exports = {
    detectRecordBreaks,
    // export for tests
    normalizeEventName,
    parseRecordValue,
    isBetter,
    getCompareDirection,
    formatValueForDisplay,
};
