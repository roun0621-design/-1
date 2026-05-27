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

// ─── 풍속 검증 대상 종목 ─────────────────────────────────────
// 육상 규정상 풍속 +2.0 m/s 초과 시 신기록 불인정 (참고기록)
// 대상: 100m, 200m, 100mH, 110mH, 멀리뛰기, 세단뛰기
// 정규화 후 종목명 기준으로 판정
const WIND_LIMIT = 2.0; // m/s, 초과(>) 시 참고기록
function isWindAffectedEvent(normalizedName) {
    if (!normalizedName) return false;
    const s = String(normalizedName).trim();
    // 트랙: 100m, 200m (단, 100mH/110mH도 포함). 400m 이상은 풍속 영향 없음
    if (/^100m$/i.test(s)) return true;
    if (/^200m$/i.test(s)) return true;
    if (/^100mH$/i.test(s)) return true;
    if (/^110mH$/i.test(s)) return true;
    // 필드: 멀리뛰기, 세단뛰기 (한글 정식명)
    if (s === '멀리뛰기' || s === '세단뛰기') return true;
    // 영문/약어 표기 안전망
    if (/^(LJ|TJ|long\s*jump|triple\s*jump)$/i.test(s)) return true;
    return false;
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
// recordValue: 문자열일 수 있음 ("10.34", "8.21m", "2:05.12", "7m70", "1m95")
// 파싱 우선순위:
//   1) 콜론 포함 → 시:분:초 / 분:초 변환 (트랙용)
//   2) 한국식 "<정수>m<센티/소수>" 표기 → m을 소수점으로:
//        "7m70" → 7.70 m  (구버전은 잘못 7 로 파싱하던 버그)
//        "1m95" → 1.95 m
//        "7m7"  → 7.70 m  (한 자리는 10cm 단위로 해석 — 통상 표기 관행)
//        "7m07" → 7.07 m
//        "10m05" → 10.05 m
//   3) trailing 'm' / 'M' 제거 후 parseFloat ("8.21m" → 8.21)
//   4) 그 외 일반 parseFloat
function parseRecordValue(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    let s = String(v).trim().replace(/\s+/g, '');
    if (!s) return null;
    if (s.includes(':')) {
        // mm:ss.xx or hh:mm:ss.xx
        const parts = s.split(':').map(parseFloat);
        if (parts.some(isNaN)) return null;
        if (parts.length === 2) return parts[0] * 60 + parts[1];
        if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
        return null;
    }
    // 한국식 "<정수>m<숫자>" 표기 (장대높이뛰기/높이뛰기/멀리뛰기 등 필드 종목)
    // 예: "7m70" = 7.70m, "1m95" = 1.95m, "7m7" = 7.70m (한 자리는 10cm 단위)
    // ⚠️ 이전 버그: /m$/i 만 제거해서 "7m70" → "7m70" → parseFloat → 7 로 파싱되어
    //              실제 7.50m 가 들어와도 7 보다 크다고 신기록 오감지.
    const koMatch = s.match(/^(\d+)\s*[mM]\s*(\d+)$/);
    if (koMatch) {
        const meters = parseInt(koMatch[1], 10);
        const frac = koMatch[2];
        // 한 자리는 10cm 단위 (관행), 두 자리 이상은 그대로 cm/mm 단위
        // "7m7" → "7.7" (0.7m=70cm) — 표기 관행상 "7m70" 의 축약형
        // "7m70" → "7.70"  /  "7m07" → "7.07"
        const fracStr = frac.length === 1 ? frac : frac.padStart(2, '0');
        const n = parseFloat(`${meters}.${fracStr}`);
        return isNaN(n) ? null : n;
    }
    // trailing m / M 제거 (예: "8.21m" → "8.21")
    s = s.replace(/[mM]$/, '');
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

    // wind 값 (감지 시점의 풍속 보존, null 가능)
    const windVal = (typeof result.wind === 'number' && isFinite(result.wind)) ? result.wind : null;

    if (existingPending) {
        // 이미 pending이 있으면 새 값으로 업데이트
        await db.run(
            `UPDATE record_breaking_log
             SET previous_record_id=?, previous_value=?, new_value=?, new_value_num=?,
                 athlete_name=?, athlete_team=?, bib_number=?,
                 wind=?, detected_at=${nowFn}
             WHERE id=?`,
            existing ? existing.id : null,
            existing ? (existing.record_value || '') : '',
            newValueStr, newValueNum,
            athlete?.name || '', athlete?.team || '', athlete?.bib_number || '',
            windVal,
            existingPending.id
        );
        return { id: existingPending.id, updated: true, record_type, division_code, series_id };
    }

    // 신규 INSERT
    const info = await db.run(
        `INSERT INTO record_breaking_log
         (competition_id, event_id, event_entry_id, record_type, event_name, gender,
          division_code, series_id, previous_record_id, previous_value, new_value, new_value_num,
          athlete_name, athlete_team, bib_number, wind, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')`,
        competition.id, event.id, result.event_entry_id, record_type, normalizedName, event.gender,
        division_code, series_id,
        existing ? existing.id : null,
        existing ? (existing.record_value || '') : '',
        newValueStr, newValueNum,
        athlete?.name || '', athlete?.team || '', athlete?.bib_number || '',
        windVal
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

        // ─── 풍속 검증 (육상 규정) ────────────────────────────
        // 100m/200m/100mH/110mH/멀리뛰기/세단뛰기는 풍속 +2.0 m/s 초과 시
        // 참고기록(reference)이며 신기록으로 인정되지 않음 → skip
        if (isWindAffectedEvent(normalizedName)) {
            const wind = (typeof result.wind === 'number') ? result.wind : null;
            if (wind !== null && wind > WIND_LIMIT) {
                return {
                    detected: [],
                    skipped: `wind-over-limit:${wind.toFixed(1)}m/s (>${WIND_LIMIT.toFixed(1)}, 참고기록)`
                };
            }
        }

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

// ============================================================
// detectCombinedRecordBreaks — combined 종목 자동 감지 (Phase C 확장 Task 3)
// ============================================================
//
// combined(혼성경기: 10종/7종)는 sub-event들의 wa_points 합계로 비교됨.
// 따라서 일반 result 저장 경로(detectRecordBreaks)와는 다른 경로로 감지:
//   - 호출 시점: 한 sub-event의 점수가 저장/변경된 직후
//   - 비교 대상: 동일 athlete의 SUM(wa_points) over the parent_event
//   - 모든 sub-event가 입력되었을 때만 (incomplete 합계로 신기록 감지 방지)
//   - new_value/new_value_num: 합계 점수 (정수)
//   - direction: higher (점수가 높을수록 좋음)
//
// 입력:
//   db: DB instance
//   ctx: { parent_event, athlete, competition, eventEntry }
//     - parent_event: { id, name, gender, category='combined', division, ... }
//     - athlete: { id, name, team, bib_number }
//     - competition: { id, series_id, ... }
//     - eventEntry: { id, athlete_id, event_id=parent_event.id, ... }
//
// 반환: { detected: [...], skipped: 'reason' }
// ============================================================
async function detectCombinedRecordBreaks(db, ctx) {
    try {
        const { parent_event, athlete, competition, eventEntry } = ctx;
        if (!parent_event || !athlete || !competition || !eventEntry) {
            return { detected: [], skipped: 'missing-context' };
        }
        if (parent_event.category !== 'combined') {
            return { detected: [], skipped: 'not-combined' };
        }

        // 모든 sub-event 개수
        const subEvents = await db.all(
            'SELECT id FROM event WHERE parent_event_id=?',
            parent_event.id
        );
        const expectedSubCount = subEvents.length;
        if (expectedSubCount === 0) {
            return { detected: [], skipped: 'no-sub-events' };
        }

        // 이 entry의 입력된 sub-event score 행들
        const scores = await db.all(
            `SELECT sub_event_order, wa_points
             FROM combined_score
             WHERE event_entry_id=?`,
            eventEntry.id
        );
        // 미완료(모든 sub-event 점수가 들어오지 않음) → skip
        // 단, 일부 race에서는 wa_points=0(NM/DNS)도 유효 입력으로 봄.
        // 여기서는 row 존재 = 입력 완료로 본다.
        const inputCount = scores.length;
        if (inputCount < expectedSubCount) {
            return { detected: [], skipped: `incomplete:${inputCount}/${expectedSubCount}` };
        }

        // 합계 wa_points
        let totalPoints = 0;
        for (const s of scores) {
            if (typeof s.wa_points === 'number' && isFinite(s.wa_points)) {
                totalPoints += s.wa_points;
            }
        }
        if (totalPoints <= 0) {
            return { detected: [], skipped: 'zero-total' };
        }

        // 종목명 정규화 — combined는 보통 '10종경기', '7종경기' 같은 명칭
        const normalizedName = normalizeEventName(parent_event.name);
        if (!normalizedName) {
            return { detected: [], skipped: 'name-normalize-failed' };
        }

        // direction = higher (점수)
        // category는 'combined' 그대로 두되, formatValueForDisplay 호환을 위해
        // higher direction에서 toFixed(2)가 호출되지 않도록 — 정수 표시.
        const newValueStr = String(Math.floor(totalPoints));

        const direction = 'higher';
        const enrichedCtx = {
            result: { event_entry_id: eventEntry.id, attempt_number: null, wind: null },
            event: parent_event,
            athlete, competition, eventEntry,
            newValueNum: totalPoints,
            direction,
            normalizedName,
            // formatValueForDisplay override를 위한 힌트
            _combinedOverride: true,
        };

        const detected = [];

        // compareAndLog 직접 호출 대신 inline (값 포맷이 다르고 풍속 무관)
        async function _logCombined(record_type, division_code, series_id) {
            const existing = await findEventRecord(db, record_type, normalizedName, parent_event.gender, division_code, series_id);
            const existingNum = existing ? parseRecordValue(existing.record_value) : null;
            if (!isBetter(totalPoints, existingNum, direction)) return null;

            const existingPending = await findExistingPending(
                db, eventEntry.id, null, record_type, division_code, series_id
            );
            const nowFn = db.isAsync ? 'NOW()' : "datetime('now')";

            if (existingPending) {
                await db.run(
                    `UPDATE record_breaking_log
                     SET previous_record_id=?, previous_value=?, new_value=?, new_value_num=?,
                         athlete_name=?, athlete_team=?, bib_number=?,
                         wind=?, detected_at=${nowFn}
                     WHERE id=?`,
                    existing ? existing.id : null,
                    existing ? (existing.record_value || '') : '',
                    newValueStr, totalPoints,
                    athlete?.name || '', athlete?.team || '', athlete?.bib_number || '',
                    null, // combined은 풍속 없음
                    existingPending.id
                );
                return { id: existingPending.id, updated: true, record_type, division_code, series_id };
            }

            const info = await db.run(
                `INSERT INTO record_breaking_log
                 (competition_id, event_id, event_entry_id, record_type, event_name, gender,
                  division_code, series_id, previous_record_id, previous_value, new_value, new_value_num,
                  athlete_name, athlete_team, bib_number, wind, status)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')`,
                competition.id, parent_event.id, eventEntry.id, record_type, normalizedName, parent_event.gender,
                division_code, series_id,
                existing ? existing.id : null,
                existing ? (existing.record_value || '') : '',
                newValueStr, totalPoints,
                athlete?.name || '', athlete?.team || '', athlete?.bib_number || '',
                null
            );
            return { id: info.lastInsertRowid, created: true, record_type, division_code, series_id };
        }

        // 1) NR
        const nrRes = await _logCombined('national', null, null);
        if (nrRes) detected.push(nrRes);

        // 2) DR
        if (parent_event.division && parent_event.division !== '') {
            const divExists = await db.get(
                'SELECT code FROM division_master WHERE code=? AND active=1',
                parent_event.division
            );
            if (divExists) {
                const drRes = await _logCombined('division', parent_event.division, null);
                if (drRes) detected.push(drRes);
            }
        }

        // 3) CR
        if (competition.series_id) {
            const sExists = await db.get(
                'SELECT id FROM competition_series WHERE id=? AND active=1',
                competition.series_id
            );
            if (sExists) {
                const crRes = await _logCombined('competition', null, competition.series_id);
                if (crRes) detected.push(crRes);
            }
        }

        return { detected, skipped: null };
    } catch (err) {
        console.error('[recordCompare] detectCombinedRecordBreaks failed:', err && err.message);
        return { detected: [], skipped: 'error:' + (err && err.message) };
    }
}

module.exports = {
    detectRecordBreaks,
    detectCombinedRecordBreaks,
    // export for tests
    normalizeEventName,
    parseRecordValue,
    isBetter,
    getCompareDirection,
    formatValueForDisplay,
    isWindAffectedEvent,
    WIND_LIMIT,
};
