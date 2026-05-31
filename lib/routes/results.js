/**
 * Results (경기 결과 입력/저장) routes
 *
 * server.js 에서 추출됨 (2단계 모듈 분리 — 10차).
 * 외부 의존성: db, isAdminKey, isOperationKey, opLog, broadcastSSE,
 *              calcWAPoints, requireAdminAfterCompEnd
 *
 * 모듈 내부 require: lib/recordCompare (detectRecordBreaks, detectCombinedRecordBreaks)
 *
 * 라우트 (4개):
 *   GET    /api/results                           heat 결과 조회
 *   POST   /api/results/upsert                    결과 upsert (가장 중요한 라우트, 신기록 감지)
 *   DELETE /api/results                           결과 삭제
 *   POST   /api/results/reset-sub-event           combined 하위 종목 초기화
 */
const { detectRecordBreaks, detectCombinedRecordBreaks } = require('../recordCompare');

module.exports = function mountResultsRoutes(app, deps) {
    const { db, isAdminKey, isOperationKey, opLog, broadcastSSE,
            calcWAPoints, requireAdminAfterCompEnd } = deps;
    if (!app || !db || !isAdminKey || !isOperationKey || !opLog || !broadcastSSE
        || !calcWAPoints || !requireAdminAfterCompEnd) {
        throw new Error('[results.js] mount requires { db, isAdminKey, isOperationKey, opLog, broadcastSSE, calcWAPoints, requireAdminAfterCompEnd }');
    }

app.get('/api/results', async (req, res) => {
    const heatId = parseInt(req.query.heat_id, 10);
    // PG는 BIGINT에 'undefined'/'abc' 같은 문자열을 넘기면 500 에러를 던지므로
    // 정수로 변환 가능한지 명시 검증 (SQLite는 lenient 처리하지만 PG와 동작 통일).
    if (!Number.isFinite(heatId) || heatId <= 0) {
        return res.status(400).json({ error: 'heat_id (positive integer) required' });
    }
    res.json(await db.all(`
        SELECT r.*, a.name, a.bib_number, a.team
        FROM result r JOIN event_entry ee ON ee.id=r.event_entry_id
        JOIN athlete a ON a.id=ee.athlete_id
        WHERE r.heat_id=? ORDER BY r.event_entry_id, r.attempt_number
    `, heatId));
});
app.post('/api/results/upsert', async (req, res) => {
    const { heat_id, event_entry_id, attempt_number, distance_meters, time_seconds, remark, status_code, wind, admin_key, offline_input_at } = req.body;
    if (!heat_id || !event_entry_id) return res.status(400).json({ error: 'heat_id and event_entry_id required' });
    const he = await db.get('SELECT * FROM heat_entry WHERE heat_id=? AND event_entry_id=?', heat_id, event_entry_id);
    if (!he) return res.status(404).json({ error: 'Entry not in heat' });
    const heat = await db.get('SELECT * FROM heat WHERE id=?', heat_id);
    if (heat) {
        const event = await db.get('SELECT * FROM event WHERE id=?', heat.event_id);
        // Post-competition lock: only admin can modify after competition ends
        if (event && await requireAdminAfterCompEnd(event.competition_id, admin_key, res)) return;
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
                const heatCountRow = await db.get('SELECT COUNT(*) as cnt FROM heat WHERE event_id=?', event.id);
                const heatCount = (heatCountRow && heatCountRow.cnt) || 0;
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
        // PG는 'IS ?' 바인딩 미지원 (SQLite는 IS NULL 비교 허용) → attempt_number NULL/값 분기
        const _attNum = attempt_number || null;
        let existing;
        if (_attNum === null) {
            existing = await db.get('SELECT * FROM result WHERE heat_id=? AND event_entry_id=? AND attempt_number IS NULL', heat_id, event_entry_id);
        } else {
            existing = await db.get('SELECT * FROM result WHERE heat_id=? AND event_entry_id=? AND attempt_number=?', heat_id, event_entry_id, _attNum);
        }
        // Fallback: for track/relay/road (no attempt_number), find any existing result for this entry
        if (!existing && !attempt_number) {
            existing = await db.get('SELECT * FROM result WHERE heat_id=? AND event_entry_id=? ORDER BY id DESC LIMIT 1', heat_id, event_entry_id);
        }
        if (existing) {
            // ─── 오프라인 동기화 충돌 감지 ─────────────────────────
            // offline_input_at: 클라이언트가 오프라인 상태에서 입력한 시각 (ms epoch)
            // 서버의 existing.updated_at 이 더 최근이면 → 운영진이 그 사이에 갱신했다는 뜻 → 거부
            // PG/SQLite 양쪽 timestamp 텍스트 형식을 모두 안전하게 파싱 (parseDbTimestampMs)
            if (offline_input_at && existing.updated_at) {
                const serverUpdatedMs = parseDbTimestampMs(existing.updated_at);
                const offlineMs = Number(offline_input_at);
                if (Number.isFinite(serverUpdatedMs) && Number.isFinite(offlineMs) && serverUpdatedMs > offlineMs) {
                    return res.status(409).json({
                        error: 'CONFLICT_NEWER_ON_SERVER',
                        message: '운영진이 그 사이에 기록을 갱신했습니다. 오프라인 입력값은 적용되지 않았습니다.',
                        server_value: {
                            distance_meters: existing.distance_meters,
                            time_seconds: existing.time_seconds,
                            status_code: existing.status_code,
                            wind: existing.wind,
                            updated_at: existing.updated_at
                        },
                        rejected_offline_value: { distance_meters, time_seconds, status_code, wind, offline_input_at }
                    });
                }
            }
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
                        // sub_event_order는 sort_order rank (1-base) — id 순서가 아닌 canonical 순서.
                        const _subOrd = await db.get(
                            'SELECT COUNT(*) as cnt FROM event WHERE parent_event_id=? AND (sort_order < ? OR (sort_order = ? AND id <= ?))',
                            _delEvt.parent_event_id, _delEvt.sort_order, _delEvt.sort_order, _delEvt.id
                        )?.cnt || 0;
                        await db.run('DELETE FROM combined_score WHERE event_entry_id IN (SELECT id FROM event_entry WHERE event_id=? AND athlete_id=(SELECT athlete_id FROM event_entry WHERE id=?)) AND sub_event_order=?', _delEvt.parent_event_id, event_entry_id, _subOrd);
                        broadcastSSE('combined_update', { event_id: _delEvt.parent_event_id });
                    }
                }
                audit('result', existing.id, 'DELETE', existing, null, 'operator', null, req);
                broadcastSSE('result_update', { heat_id, event_entry_id });
                return res.json({ success: true, deleted: true, deleted_id: existing.id });
            }
            
            const _nowFR = db.isAsync ? 'NOW()' : "datetime('now')";
            await db.run(`UPDATE result SET distance_meters=?,time_seconds=?,remark=?,status_code=?,wind=?,updated_at=${_nowFR} WHERE id=?`, updDist, updTime, updRemark, updSc, updWind, existing.id);
            const upd = await db.get('SELECT * FROM result WHERE id=?', existing.id);
            audit('result', existing.id, 'UPDATE', existing, upd, 'operator', null, req);
            // Phase C1: 기록 갱신 감지 (best-effort, 실패해도 응답에 영향 없음)
            await _runRecordCompareHook(upd, heat).catch(()=>{});
            broadcastSSE('result_update', { heat_id, event_entry_id });
            res.json(upd);
        } else {
            const info = await db.run('INSERT INTO result (heat_id,event_entry_id,attempt_number,distance_meters,time_seconds,remark,status_code,wind) VALUES (?,?,?,?,?,?,?,?)', heat_id, event_entry_id, attempt_number || null, distance_meters ?? null, time_seconds ?? null, remark || '', sc || '', wind ?? null);
            const ins = await db.get('SELECT * FROM result WHERE id=?', info.lastInsertRowid);
            audit('result', ins.id, 'INSERT', null, ins, 'operator', null, req);
            // Phase C1: 기록 갱신 감지
            await _runRecordCompareHook(ins, heat).catch(()=>{});
            broadcastSSE('result_update', { heat_id, event_entry_id });
            res.json(ins);
        }
    } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// Phase C1 헬퍼: result 저장 후 호출 — 모든 컨텍스트 로드 후 detectRecordBreaks 실행
// best-effort: 실패해도 throw 안 함 (호출자가 .catch로 한 번 더 감싸도 무방)
async function _runRecordCompareHook(result, heatRow) {
    try {
        if (!result || !heatRow) return;
        const event = await db.get('SELECT * FROM event WHERE id=?', heatRow.event_id);
        if (!event) return;
        // combined 부모: 단일 result 경로로는 처리 안 함 (combined_score sync 경로에서 처리)
        if (event.category === 'combined') return;
        // sub-event(parent_event_id 존재): 일반 NR/DR/CR은 비교 안 하지만,
        // 부모 combined의 신기록 감지는 별도로 호출.
        // ⚠️ race 차단 (2026-05): 과거엔 fire-and-forget 호출이라
        //     클라이언트 응답 → syncCombinedFromSubEvent 가 _syncCombinedScoresForAthlete 보다 먼저 끝나
        //     status_code='DNF' 가 빈 값으로 덮어써지는 버그 발생. → await 로 동기화.
        if (event.parent_event_id) {
            await _runCombinedRecordCompareHook(event.parent_event_id, result.event_entry_id).catch(()=>{});
            return;
        }
        const competition = await db.get('SELECT * FROM competition WHERE id=?', event.competition_id);
        if (!competition) return;
        const eventEntry = await db.get('SELECT * FROM event_entry WHERE id=?', result.event_entry_id);
        let athlete = null;
        if (eventEntry && eventEntry.athlete_id) {
            athlete = await db.get('SELECT * FROM athlete WHERE id=?', eventEntry.athlete_id);
        }
        const ret = await detectRecordBreaks(db, {
            result, heat: heatRow, event, athlete, competition, eventEntry
        });
        // 풍속 초과로 인한 참고기록 — opLog만 남기고 별도 SSE 발행
        if (ret && ret.skipped && ret.skipped.startsWith('wind-over-limit')) {
            const wind = (typeof result.wind === 'number') ? result.wind : null;
            const val = result.time_seconds || result.distance_meters;
            opLog(`💨 풍속 초과 참고기록: ${event.name} (${athlete?.name || '선수'} ${val}, 풍속 +${wind?.toFixed(1)}m/s) — 신기록 불인정`, 'record', 'system', competition.id);
            broadcastSSE('record_break_wind_skipped', {
                competition_id: competition.id, event_id: event.id,
                event_name: event.name, athlete_name: athlete?.name || '',
                value: val, wind: wind
            });
        }
        if (ret && ret.detected && ret.detected.length > 0) {
            for (const d of ret.detected) {
                opLog(`🏆 ${d.record_type.toUpperCase()} 기록 갱신 감지: ${event.name} (${athlete?.name || '선수'} ${result.time_seconds || result.distance_meters}) — 승인 대기`, 'record', 'system', competition.id);
            }
            broadcastSSE('record_break_detected', {
                competition_id: competition.id, event_id: event.id,
                event_name: event.name,
                athlete_name: athlete?.name || '',
                athlete_team: athlete?.team || '',
                value: result.time_seconds || result.distance_meters,
                detected: ret.detected
            });
        }
    } catch (e) {
        console.error('[recordCompareHook] failed (non-fatal):', e && e.message);
    }
}

// Phase C 확장 Task 3: combined 종목 신기록 감지 헬퍼
// sub-event result 저장 후, OR combined-scores/save 후에 호출.
// best-effort: 실패해도 throw 안 함.
// 🛠️ 단일 athlete 의 combined_score 를 모든 sub-event 에 대해 다시 계산하여 UPSERT.
// /api/results/upsert 에서 자동으로 호출 → frontend sync 누락에 대비한 server-side 보장 경로.
async function _syncCombinedScoresForAthlete(parent_event, parentEntry, athleteId) {
    if (!parent_event || !parentEntry || !athleteId) return;
    const waKeys = parent_event.gender === 'M' ? DECATHLON_KEYS : HEPTATHLON_KEYS;
    const expectedCount = waKeys.length;
    const subEvents = await db.all('SELECT * FROM event WHERE parent_event_id=? ORDER BY sort_order, id', parent_event.id);
    // ─── status_code 컬럼 포함 UPSERT (DNS/DNF/DQ/NM 을 종합기록지에 그대로 노출)
    const UPSERT_SQL = `INSERT INTO combined_score (event_entry_id,sub_event_name,sub_event_order,raw_record,wa_points,status_code)
        VALUES (?,?,?,?,?,?) ON CONFLICT(event_entry_id,sub_event_order) DO UPDATE SET raw_record=excluded.raw_record, wa_points=excluded.wa_points, sub_event_name=excluded.sub_event_name, status_code=excluded.status_code`;

    for (let idx = 0; idx < subEvents.length && idx < expectedCount; idx++) {
        const subEvt = subEvents[idx];
        const subOrder = idx + 1;
        const subHeats = await db.all('SELECT id FROM heat WHERE event_id=?', subEvt.id);
        if (!subHeats || subHeats.length === 0) continue;
        const subHeatIds = subHeats.map(h => h.id);
        const heatPh = subHeatIds.map(() => '?').join(',');
        const subEntry = await db.get('SELECT id FROM event_entry WHERE event_id=? AND athlete_id=?', subEvt.id, athleteId);
        if (!subEntry) continue;

        // ─── status_code 우선 조회 (DNS/DNF/DQ/NM) ───────────────────
        // 1) result 테이블의 명시적 status_code (트랙/필드 공통)
        // 2) heat_entry.status='no_show' → DNS
        let statusCode = '';
        // ⚠️ 'X'/'PASS'/'-' 같은 시도별 마크 는 status_code 가 아니므로 제외. 화이트리스트만 채택.
        const scRow = await db.get(
            `SELECT status_code FROM result WHERE heat_id IN (${heatPh}) AND event_entry_id=? AND status_code IN ('DNS','DNF','DQ','NM') LIMIT 1`,
            ...subHeatIds, subEntry.id
        );
        if (scRow && scRow.status_code) {
            statusCode = scRow.status_code;
        } else {
            // ⚠️ heat_entry 에는 status 컬럼이 없음 — status 는 event_entry 에 있다.
            const heRow = await db.get(
                `SELECT status FROM event_entry WHERE id=?`,
                subEntry.id
            );
            if (heRow && heRow.status === 'no_show') statusCode = 'DNS';
        }

        let bestRecord = null;
        let hasAttempts = false;
        if (subEvt.category === 'track') {
            const r = await db.get(`SELECT MIN(time_seconds) AS best FROM result WHERE heat_id IN (${heatPh}) AND event_entry_id=? AND time_seconds > 0`, ...subHeatIds, subEntry.id);
            if (r && r.best) bestRecord = r.best;
            const cnt = await db.get(`SELECT COUNT(*) AS c FROM result WHERE heat_id IN (${heatPh}) AND event_entry_id=?`, ...subHeatIds, subEntry.id);
            if (cnt && cnt.c > 0) hasAttempts = true;
        } else if (subEvt.category === 'field_distance') {
            const r = await db.get(`SELECT MAX(distance_meters) AS best FROM result WHERE heat_id IN (${heatPh}) AND event_entry_id=? AND distance_meters > 0`, ...subHeatIds, subEntry.id);
            if (r && r.best) bestRecord = r.best;
            const cnt = await db.get(`SELECT COUNT(*) AS c FROM result WHERE heat_id IN (${heatPh}) AND event_entry_id=? AND attempt_number IS NOT NULL`, ...subHeatIds, subEntry.id);
            if (cnt && cnt.c > 0) hasAttempts = true;
        } else if (subEvt.category === 'field_height') {
            const r = await db.get(`SELECT MAX(bar_height) AS best FROM height_attempt WHERE heat_id IN (${heatPh}) AND event_entry_id=? AND result_mark='O'`, ...subHeatIds, subEntry.id);
            if (r && r.best) bestRecord = r.best;
            const cnt = await db.get(`SELECT COUNT(*) AS c FROM height_attempt WHERE heat_id IN (${heatPh}) AND event_entry_id=?`, ...subHeatIds, subEntry.id);
            if (cnt && cnt.c > 0) hasAttempts = true;
        }
        if (bestRecord != null) {
            const waKey = waKeys[subOrder - 1];
            // Sanity check
            let valid = true;
            if (waKey === 'M_long_jump' || waKey === 'F_long_jump') { if (bestRecord > 12) valid = false; }
            else if (waKey === 'M_high_jump' || waKey === 'F_high_jump') { if (bestRecord > 3) valid = false; }
            else if (waKey === 'M_pole_vault') { if (bestRecord > 7) valid = false; }
            else if (waKey === 'M_shot_put' || waKey === 'F_shot_put') { if (bestRecord > 25) valid = false; }
            if (!valid) {
                await db.run('DELETE FROM combined_score WHERE event_entry_id=? AND sub_event_order=?', parentEntry.id, subOrder);
                continue;
            }
            const waPoints = waKey ? calcWAPoints(waKey, bestRecord) : 0;
            // status_code 가 있더라도 유효 기록이 있으면 정상 점수 반영 (DQ 인 경우만 예외처리는 추후 정책에 따라)
            await db.run(UPSERT_SQL, parentEntry.id, subEvt.name, subOrder, bestRecord, waPoints, statusCode);
        } else if (statusCode) {
            // ─── 기록 0, 상태코드 존재 → DNS/DNF/DQ/NM 으로 표시. WA 점수 0.
            //     트랙에서 NM 이 들어오면 무시(트랙은 NM 불가) → DNF 로 폴백
            let effSc = statusCode;
            if (subEvt.category === 'track' && effSc === 'NM') effSc = 'DNF';
            await db.run(UPSERT_SQL, parentEntry.id, subEvt.name, subOrder, 0, 0, effSc);
        } else if (hasAttempts) {
            // 시도는 있는데 유효 기록 없음 → 필드는 NM, 트랙은 DNF (이전엔 무차별 raw=0, status=''→ 클라가 NM 표시)
            const fallbackSc = (subEvt.category === 'field_distance' || subEvt.category === 'field_height') ? 'NM' : 'DNF';
            await db.run(UPSERT_SQL, parentEntry.id, subEvt.name, subOrder, 0, 0, fallbackSc);
        } else {
            await db.run('DELETE FROM combined_score WHERE event_entry_id=? AND sub_event_order=?', parentEntry.id, subOrder);
        }
    }
    broadcastSSE('combined_update', { event_id: parent_event.id });
}

async function _runCombinedRecordCompareHook(parentEventId, subEventEntryId) {
    try {
        if (!parentEventId) return;
        const parent_event = await db.get('SELECT * FROM event WHERE id=?', parentEventId);
        if (!parent_event || parent_event.category !== 'combined') return;
        const competition = await db.get('SELECT * FROM competition WHERE id=?', parent_event.competition_id);
        if (!competition) return;

        // sub-event entry → athlete_id → 부모 event_entry
        let athleteId = null;
        if (subEventEntryId) {
            const subEntry = await db.get('SELECT athlete_id FROM event_entry WHERE id=?', subEventEntryId);
            if (subEntry) athleteId = subEntry.athlete_id;
        }
        if (!athleteId) return;
        const parentEntry = await db.get(
            'SELECT * FROM event_entry WHERE event_id=? AND athlete_id=?',
            parent_event.id, athleteId
        );
        if (!parentEntry) return;
        const athlete = await db.get('SELECT * FROM athlete WHERE id=?', athleteId);

        // 🛠️ FIX: sub-event 기록 저장 시 server-side 에서도 combined_score 를 자동 sync.
        // 과거에는 frontend (record.js) 가 syncCombinedFromSubEvent 를 호출했으나,
        // 외부 도구(엑셀 업로드/API 직접 호출/관리자 수동 입력)로 result 만 저장된 경우
        // sync 가 실행되지 않아 종합 순위에 "—" 표시되는 버그 발생. server 에서 보장.
        await _syncCombinedScoresForAthlete(parent_event, parentEntry, athleteId).catch(err => {
            console.error('[autoSync] failed:', err && err.message);
        });

        const ret = await detectCombinedRecordBreaks(db, {
            parent_event, athlete, competition, eventEntry: parentEntry
        });
        if (ret && ret.detected && ret.detected.length > 0) {
            for (const d of ret.detected) {
                opLog(`🏆 ${d.record_type.toUpperCase()} 기록 갱신 감지(혼성): ${parent_event.name} (${athlete?.name || '선수'} 합계 점수) — 승인 대기`, 'record', 'system', competition.id);
            }
            broadcastSSE('record_break_detected', {
                competition_id: competition.id, event_id: parent_event.id,
                event_name: parent_event.name,
                athlete_name: athlete?.name || '',
                athlete_team: athlete?.team || '',
                value: null,
                detected: ret.detected,
                combined: true,
            });
        }
    } catch (e) {
        console.error('[combinedRecordCompareHook] failed (non-fatal):', e && e.message);
    }
}

// Delete a single result by heat_id + event_entry_id + attempt_number (for clearing field entries)
app.delete('/api/results', async (req, res) => {
    const { heat_id, event_entry_id, attempt_number, admin_key } = req.body;
    if (!heat_id || !event_entry_id) return res.status(400).json({ error: 'heat_id and event_entry_id required' });
    // Check if event is completed — require admin_key
    const _dHeat = await db.get('SELECT * FROM heat WHERE id=?', heat_id);
    if (_dHeat) {
        const _dEvt = await db.get('SELECT * FROM event WHERE id=?', _dHeat.event_id);
        // Post-competition lock
        if (_dEvt && await requireAdminAfterCompEnd(_dEvt.competition_id, admin_key, res)) return;
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
            // sub_event_order는 sort_order rank (1-base) — id 순서가 아닌 canonical 순서.
            const subOrder = await db.get(
                'SELECT COUNT(*) as cnt FROM event WHERE parent_event_id=? AND (sort_order < ? OR (sort_order = ? AND id <= ?))',
                evt.parent_event_id, evt.sort_order, evt.sort_order, evt.id
            )?.cnt || 0;
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
        // sub_event_order는 sort_order rank (1-base) — id 순서가 아닌 canonical 순서.
        const subOrder = await db.get(
            'SELECT COUNT(*) as cnt FROM event WHERE parent_event_id=? AND (sort_order < ? OR (sort_order = ? AND id <= ?))',
            evt.parent_event_id, evt.sort_order, evt.sort_order, evt.id
        )?.cnt || 0;
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
};
