/**
 * Combined Scores (혼성경기/혼성종목 점수) routes
 *
 * server.js 에서 추출됨 (2단계 모듈 분리 — 7차).
 * 외부 의존성: db, isAdminKey, isOperationKey, opLog, broadcastSSE
 *
 * 라우트 (5개):
 *   GET    /api/combined-scores              event_id 의 모든 점수 (athlete JOIN)
 *   POST   /api/combined-scores/save         개별 점수 저장/upsert
 *   POST   /api/combined-scores/sync         heat 결과 → combined_score 일괄 동기화
 *   POST   /api/combined-scores/repair       무결성 복구
 *   GET    /api/combined-scores/diag         진단 (관리자용)
 *
 * ⚠️ /save, /sync, /repair, /diag 는 정적 경로라 / 와 충돌 없음.
 */
module.exports = function mountCombinedScoresRoutes(app, deps) {
    const { db, isAdminKey, isOperationKey, opLog, broadcastSSE,
            DECATHLON_KEYS, HEPTATHLON_KEYS, WA_TABLES, calcWAPoints } = deps;
    if (!app || !db || !isAdminKey || !isOperationKey || !opLog || !broadcastSSE) {
        throw new Error('[combined_scores.js] mount requires { db, isAdminKey, isOperationKey, opLog, broadcastSSE }');
    }
    // WA scoring 상수는 server.js 의 1456~ 라인 (DECATHLON_KEYS) 와 wa_tables 모듈 (WA_TABLES, calcWAPoints) 에서 주입.
    // 누락 시 /sync /repair 호출이 ReferenceError: DECATHLON_KEYS is not defined 로 500 떨어짐.
    // (2026-06 fix — 10종경기 결과 모달 로드 실패의 진짜 원인)
    if (!DECATHLON_KEYS || !HEPTATHLON_KEYS || !WA_TABLES || typeof calcWAPoints !== 'function') {
        throw new Error('[combined_scores.js] mount requires { DECATHLON_KEYS, HEPTATHLON_KEYS, WA_TABLES, calcWAPoints } — WA 점수 계산 의존성 누락');
    }

    // ============================================================
    app.get('/api/combined-scores', async (req, res) => {
        if (!req.query.event_id) return res.status(400).json({ error: 'event_id required' });
        res.json(await db.all(`
            SELECT cs.*, a.name, a.bib_number, a.team
            FROM combined_score cs JOIN event_entry ee ON ee.id=cs.event_entry_id
            JOIN athlete a ON a.id=ee.athlete_id
            WHERE ee.event_id=? ORDER BY cs.event_entry_id, cs.sub_event_order
        `, req.query.event_id));
    });
    app.post('/api/combined-scores/save', async (req, res) => {
        const { event_entry_id, sub_event_name, sub_event_order, raw_record, wa_points, admin_key } = req.body;
        if (!event_entry_id || !sub_event_name || !sub_event_order) return res.status(400).json({ error: 'Required fields missing' });
        // Post-competition lock
        try {
            const ee = await db.get('SELECT e.competition_id FROM event_entry ee JOIN event e ON e.id=ee.event_id WHERE ee.id=?', event_entry_id);
            if (ee && await requireAdminAfterCompEnd(ee.competition_id, admin_key, res)) return;
        } catch(e) {}
        try {
            const existing = await db.get('SELECT * FROM combined_score WHERE event_entry_id=? AND sub_event_order=?', event_entry_id, sub_event_order);
            if (existing) {
                await db.run('UPDATE combined_score SET raw_record=?,wa_points=?,sub_event_name=? WHERE id=?', raw_record ?? null, wa_points || 0, sub_event_name, existing.id);
                res.json(await db.get('SELECT * FROM combined_score WHERE id=?', existing.id));
            } else {
                const info = await db.run('INSERT INTO combined_score (event_entry_id,sub_event_name,sub_event_order,raw_record,wa_points) VALUES (?,?,?,?,?)', event_entry_id, sub_event_name, sub_event_order, raw_record ?? null, wa_points || 0);
                res.json(await db.get('SELECT * FROM combined_score WHERE id=?', info.lastInsertRowid));
            }
            broadcastSSE('combined_update', { event_entry_id, sub_event_order });
            // Phase C 확장 Task 3: combined 신기록 감지 (직접 입력 경로)
            // sub_event_entry → parent_event 유추 후 hook 호출
            try {
                const subEntry = await db.get(
                    'SELECT ee.id AS sub_entry_id, e.parent_event_id FROM event_entry ee JOIN event e ON e.id=ee.event_id WHERE ee.id=?',
                    event_entry_id
                );
                if (subEntry && subEntry.parent_event_id) {
                    _runCombinedRecordCompareHook(subEntry.parent_event_id, subEntry.sub_entry_id).catch(()=>{});
                }
            } catch(e) {}
        } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
    });
    app.get('/api/combined-sub-events', async (req, res) => {
        if (!req.query.parent_event_id) return res.status(400).json({ error: 'parent_event_id required' });
        // sort_order가 DECATHLON_EVENTS / HEPTATHLON_EVENTS의 정식 순서(1..10/1..7)와 매핑되는 canonical 순서.
        // id 순서로 정렬하면 sub-event 삭제/추가/재정렬 후 DECATHLON 순서와 어긋날 수 있음.
        res.json(await db.all('SELECT * FROM event WHERE parent_event_id=? ORDER BY sort_order, id', req.query.parent_event_id));
    });
    app.post('/api/combined-scores/sync', async (req, res) => {
        const { parent_event_id, force } = req.body;
        if (!parent_event_id) return res.status(400).json({ error: 'parent_event_id required' });
        const parentEvent = await db.get('SELECT * FROM event WHERE id=?', parent_event_id);
        if (!parentEvent || parentEvent.category !== 'combined') return res.status(400).json({ error: 'Not a combined event' });
        // ⚠️ 중요: ORDER BY sort_order, id (DECATHLON/HEPTATHLON 정식 순서와 매핑되는 canonical 정렬)
        // 과거 ORDER BY id만 사용 시, sub-event 삭제/추가/재정렬로 id 순서와 sort_order가 어긋난 대회에서
        // sub_event_order/waKey 매핑이 잘못되어 다른 종목 기록(예: 창던지기 49.54m)이 멀리뛰기로 잘못
        // 환산되는 버그 발생 (raw_record=49.54 → calcWAPoints('M_long_jump',49.54)=20058pt).
        const subEvents = await db.all('SELECT * FROM event WHERE parent_event_id=? ORDER BY sort_order, id', parent_event_id);
        const parentEntries = await db.all('SELECT ee.id AS event_entry_id, ee.athlete_id FROM event_entry ee WHERE ee.event_id=?', parent_event_id);
        const waKeys = parentEvent.gender === 'M' ? DECATHLON_KEYS : HEPTATHLON_KEYS;
        const expectedCount = waKeys.length; // 10 or 7
        let syncCount = 0;
        let purgedCount = 0;
        let healedCount = 0;
        // ─── status_code 컬럼 포함 UPSERT (DNS/DNF/DQ/NM 을 종합기록지에 그대로 노출).
        //     이전엔 UPSERT_SQL 에 status_code 가 빠져서, /sync 호출 시 새 row 가 status_code='' 로 INSERT 되어
        //     트랙 DNF 등이 종합기록지에 표시 안 되는 버그 발생. (2026-05 fix)
        const UPSERT_SQL = `INSERT INTO combined_score (event_entry_id,sub_event_name,sub_event_order,raw_record,wa_points,status_code)
            VALUES (?,?,?,?,?,?) ON CONFLICT(event_entry_id,sub_event_order) DO UPDATE SET raw_record=excluded.raw_record, wa_points=excluded.wa_points, sub_event_name=excluded.sub_event_name, status_code=excluded.status_code`;
    
        // 🛡️ Defensive cleanup (always runs, even without force):
        // Remove any combined_score row whose sub_event_order is outside [1, expectedCount].
        // These are orphans created in older buggy code paths and never reachable from the UI.
        await db.transaction(async () => {
            const orphan = await db.run(
                `DELETE FROM combined_score
                 WHERE event_entry_id IN (SELECT id FROM event_entry WHERE event_id=?)
                   AND (sub_event_order < 1 OR sub_event_order > ?)`,
                parent_event_id, expectedCount
            );
            if (orphan && orphan.changes) purgedCount += orphan.changes;
        })();
    
        // 🛡️ Force mode (or when raw_record sanity check fails):
        // Wipe everything for this parent and rebuild from scratch.
        // Triggered when sub-event categories don't match WA-expected categories (i.e., sub_event reordering happened).
        const expectedCatBySubOrder = waKeys.map(k => {
            const t = WA_TABLES[k]; if (!t) return null;
            if (t.type === 'track') return 'track';
            if (t.type === 'field_cm') return k.includes('high_jump') || k.includes('pole_vault') ? 'field_height' : 'field_distance';
            return 'field_distance'; // field_m → throws (field_distance)
        });
        // Compute actual sort_order rank for each sub-event (1-based, matches frontend `s.sort_order === se.order` mapping after sync)
        let categoryMismatch = false;
        for (let idx = 0; idx < subEvents.length && idx < expectedCount; idx++) {
            const expCat = expectedCatBySubOrder[idx];
            const actCat = subEvents[idx].category;
            // field_distance ↔ field (legacy) are equivalent for jumps/throws
            if (expCat && actCat && expCat !== actCat) {
                categoryMismatch = true;
                break;
            }
        }
        if (force || categoryMismatch) {
            await db.transaction(async () => {
                const wipe = await db.run(
                    `DELETE FROM combined_score
                     WHERE event_entry_id IN (SELECT id FROM event_entry WHERE event_id=?)`,
                    parent_event_id
                );
                if (wipe && wipe.changes) healedCount += wipe.changes;
            })();
        }
    
        await db.transaction(async () => {
            for (let idx = 0; idx < subEvents.length; idx++) {
                const subEvt = subEvents[idx];
                const subOrder = idx + 1;
                if (subOrder > expectedCount) break; // Guard: ignore extra sub-events beyond decathlon/heptathlon size
                // 🛠️ FIX: sub-event 에 heat 가 여러 개 있을 수 있음 (예: 멀리뛰기를 그룹별로 분할 진행한 경우).
                // 과거 'LIMIT 1' 로 첫 heat 만 보면, 사용자가 다른 heat 에 기록을 저장한 경우 sync 가 건너뛰어
                // 종합 순위에 "—" 로 표시되는 버그 발생. 모든 heat 의 result 를 합산하여 best 를 구함.
                const subHeats = await db.all('SELECT id FROM heat WHERE event_id=?', subEvt.id);
                if (!subHeats || subHeats.length === 0) continue;
                const subHeatIds = subHeats.map(h => h.id);
                const heatPh = subHeatIds.map(() => '?').join(',');
                for (const pe of parentEntries) {
                    const subEntry = await db.get('SELECT id FROM event_entry WHERE event_id=? AND athlete_id=?', subEvt.id, pe.athlete_id);
                    if (!subEntry) continue;
                    // ─── status_code 우선 조회 (DNS/DNF/DQ/NM) — _syncCombinedScoresForAthlete 와 동일 로직.
                    //     1) result.status_code 가 있으면 채택
                    //     2) heat_entry.status='no_show' → DNS
                    let statusCode = '';
                    // ⚠️ 'X'/'PASS'/'-' 등 시도별 마크 는 status_code 가 아닌 좌석 별 파울 표시 용도 — 화이트리스트만 채택.
                    const _scRow = await db.get(
                        `SELECT status_code FROM result WHERE heat_id IN (${heatPh}) AND event_entry_id=? AND status_code IN ('DNS','DNF','DQ','NM') LIMIT 1`,
                        ...subHeatIds, subEntry.id
                    );
                    if (_scRow && _scRow.status_code) {
                        statusCode = _scRow.status_code;
                    } else {
                        // ⚠️ heat_entry 에는 status 컬럼이 없음 — status 는 event_entry 에 있다.
                        const _heRow = await db.get(
                            `SELECT status FROM event_entry WHERE id=?`,
                            subEntry.id
                        );
                        if (_heRow && _heRow.status === 'no_show') statusCode = 'DNS';
                    }
                    let bestRecord = null;
                    let hasAttempts = false;
                    if (subEvt.category === 'track') {
                        const r = await db.get(`SELECT MIN(time_seconds) AS best FROM result WHERE heat_id IN (${heatPh}) AND event_entry_id=? AND time_seconds > 0`, ...subHeatIds, subEntry.id);
                        if (r && r.best) bestRecord = r.best;
                        // Check if athlete has any result rows (including DNS/DNF/NM)
                        const cnt = await db.get(`SELECT COUNT(*) AS c FROM result WHERE heat_id IN (${heatPh}) AND event_entry_id=?`, ...subHeatIds, subEntry.id);
                        if (cnt && cnt.c > 0) hasAttempts = true;
                    } else if (subEvt.category === 'field_distance') {
                        const r = await db.get(`SELECT MAX(distance_meters) AS best FROM result WHERE heat_id IN (${heatPh}) AND event_entry_id=? AND distance_meters > 0`, ...subHeatIds, subEntry.id);
                        if (r && r.best) bestRecord = r.best;
                        // NM check: has attempts but all fouls (distance=0)
                        const cnt = await db.get(`SELECT COUNT(*) AS c FROM result WHERE heat_id IN (${heatPh}) AND event_entry_id=? AND attempt_number IS NOT NULL`, ...subHeatIds, subEntry.id);
                        if (cnt && cnt.c > 0) hasAttempts = true;
                    } else if (subEvt.category === 'field_height') {
                        const r = await db.get(`SELECT MAX(bar_height) AS best FROM height_attempt WHERE heat_id IN (${heatPh}) AND event_entry_id=? AND result_mark='O'`, ...subHeatIds, subEntry.id);
                        if (r && r.best) bestRecord = r.best;
                        // NM check: has height attempts but no clearance (all X or PASS)
                        const cnt = await db.get(`SELECT COUNT(*) AS c FROM height_attempt WHERE heat_id IN (${heatPh}) AND event_entry_id=?`, ...subHeatIds, subEntry.id);
                        if (cnt && cnt.c > 0) hasAttempts = true;
                    }
                    if (bestRecord != null) {
                        const waKey = waKeys[subOrder - 1];
                        // 🛡️ Sanity check: raw_record must be plausible for the WA event type.
                        // Long jump/triple jump: typically 3-9m. If we get a 40+m value here, the sub-event
                        // category mapping is wrong — skip this row (don't write) to avoid 20000pt artifacts.
                        let valid = true;
                        if (waKey === 'M_long_jump' || waKey === 'F_long_jump') {
                            if (bestRecord > 12) valid = false;       // world record ~8.95m → 12m hard cap
                        } else if (waKey === 'M_high_jump' || waKey === 'F_high_jump') {
                            if (bestRecord > 3) valid = false;        // world record ~2.45m
                        } else if (waKey === 'M_pole_vault') {
                            if (bestRecord > 7) valid = false;        // world record ~6.23m
                        } else if (waKey === 'M_shot_put' || waKey === 'F_shot_put') {
                            if (bestRecord > 25) valid = false;       // world record ~23m
                        }
                        if (!valid) {
                            console.warn(`[sync] Skipping implausible record: ${subEvt.name} (subOrder=${subOrder}, waKey=${waKey}, raw=${bestRecord}) — likely sub-event mapping mismatch`);
                            const delResult = await db.run('DELETE FROM combined_score WHERE event_entry_id=? AND sub_event_order=?', pe.event_entry_id, subOrder);
                            if (delResult.changes > 0) healedCount += delResult.changes;
                            continue;
                        }
                        const waPoints = waKey ? calcWAPoints(waKey, bestRecord) : 0;
                        // 유효 기록 있어도 status_code 가 있으면 함께 저장 (보통 DQ 같은 케이스)
                        await db.run(UPSERT_SQL, pe.event_entry_id, subEvt.name, subOrder, bestRecord, waPoints, statusCode);
                        syncCount++;
                    } else if (statusCode) {
                        // ─── 기록 0 + status_code 존재 → DNS/DNF/DQ/NM 으로 표시, WA 점수 0.
                        //     트랙 NM 은 부적합 → DNF 로 폴백 (_syncCombinedScoresForAthlete 와 동일 로직)
                        let effSc = statusCode;
                        if (subEvt.category === 'track' && effSc === 'NM') effSc = 'DNF';
                        await db.run(UPSERT_SQL, pe.event_entry_id, subEvt.name, subOrder, 0, 0, effSc);
                        syncCount++;
                    } else if (hasAttempts) {
                        // NM (No Mark): athlete attempted but has no valid record → 0 points.
                        // 필드는 NM, 트랙은 DNF 로 폴백 (status_code 없는 옛 데이터 호환)
                        const fallbackSc = (subEvt.category === 'field_distance' || subEvt.category === 'field_height') ? 'NM' : 'DNF';
                        await db.run(UPSERT_SQL, pe.event_entry_id, subEvt.name, subOrder, 0, 0, fallbackSc);
                        syncCount++;
                    } else {
                        // No record and no attempts → DELETE any existing combined_score for this sub-event
                        const delResult = await db.run('DELETE FROM combined_score WHERE event_entry_id=? AND sub_event_order=?', pe.event_entry_id, subOrder);
                        if (delResult.changes > 0) syncCount++;
                    }
                }
            }
        })();
        res.json({ success: true, synced: syncCount, purged: purgedCount, healed: healedCount });
    });
    
    // 🔧 Force-repair: wipe and rebuild all combined_score rows for a parent event.
    // Use when the scoreboard shows clearly wrong values (e.g., long jump 49.54m / 20058pt)
    // due to historical sub-event reordering corrupting sub_event_order ↔ raw_record mapping.
    app.post('/api/combined-scores/repair', async (req, res) => {
        const { parent_event_id, admin_key } = req.body;
        if (!parent_event_id) return res.status(400).json({ error: 'parent_event_id required' });
        if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) {
            return res.status(403).json({ error: '운영자 또는 관리자 키가 필요합니다.' });
        }
        const parentEvent = await db.get('SELECT * FROM event WHERE id=?', parent_event_id);
        if (!parentEvent || parentEvent.category !== 'combined') return res.status(400).json({ error: 'Not a combined event' });
        // Wipe and rebuild all combined_score rows for this parent
        const wipe = await db.run(
            `DELETE FROM combined_score
             WHERE event_entry_id IN (SELECT id FROM event_entry WHERE event_id=?)`,
            parent_event_id
        );
        const wipedCount = (wipe && wipe.changes) || 0;
        try {
            // Use an internal HTTP call would be heavy — re-run the sync logic inline
            const subEvents = await db.all('SELECT * FROM event WHERE parent_event_id=? ORDER BY sort_order, id', parent_event_id);
            const parentEntries = await db.all('SELECT ee.id AS event_entry_id, ee.athlete_id FROM event_entry ee WHERE ee.event_id=?', parent_event_id);
            const waKeys = parentEvent.gender === 'M' ? DECATHLON_KEYS : HEPTATHLON_KEYS;
            const expectedCount = waKeys.length;
            let synced = 0;
            // ─── status_code 컬럼 포함 UPSERT (DNS/DNF/DQ/NM 보존)
            const UPSERT_SQL = `INSERT INTO combined_score (event_entry_id,sub_event_name,sub_event_order,raw_record,wa_points,status_code)
                VALUES (?,?,?,?,?,?) ON CONFLICT(event_entry_id,sub_event_order) DO UPDATE SET raw_record=excluded.raw_record, wa_points=excluded.wa_points, sub_event_name=excluded.sub_event_name, status_code=excluded.status_code`;
            await db.transaction(async () => {
                for (let idx = 0; idx < subEvents.length && idx < expectedCount; idx++) {
                    const subEvt = subEvents[idx];
                    const subOrder = idx + 1;
                    // 🛠️ FIX: 모든 heat 합산 (sync 엔드포인트와 동일 로직)
                    const subHeats = await db.all('SELECT id FROM heat WHERE event_id=?', subEvt.id);
                    if (!subHeats || subHeats.length === 0) continue;
                    const subHeatIds = subHeats.map(h => h.id);
                    const heatPh = subHeatIds.map(() => '?').join(',');
                    for (const pe of parentEntries) {
                        const subEntry = await db.get('SELECT id FROM event_entry WHERE event_id=? AND athlete_id=?', subEvt.id, pe.athlete_id);
                        if (!subEntry) continue;
                        // ─── status_code 우선 조회 (DNS/DNF/DQ/NM)
                        let statusCode = '';
                        // ⚠️ 화이트리스트 (DNS/DNF/DQ/NM) 만 status_code 로 인정. 'X'/'PASS'/'-' 등 시도 마크 제외.
                        const _scRow = await db.get(
                            `SELECT status_code FROM result WHERE heat_id IN (${heatPh}) AND event_entry_id=? AND status_code IN ('DNS','DNF','DQ','NM') LIMIT 1`,
                            ...subHeatIds, subEntry.id
                        );
                        if (_scRow && _scRow.status_code) {
                            statusCode = _scRow.status_code;
                        } else {
                            // ⚠️ heat_entry 에는 status 컬럼이 없음 — status 는 event_entry 에 있다.
                            const _heRow = await db.get(
                                `SELECT status FROM event_entry WHERE id=?`,
                                subEntry.id
                            );
                            if (_heRow && _heRow.status === 'no_show') statusCode = 'DNS';
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
                            const waPoints = waKey ? calcWAPoints(waKey, bestRecord) : 0;
                            await db.run(UPSERT_SQL, pe.event_entry_id, subEvt.name, subOrder, bestRecord, waPoints, statusCode);
                            synced++;
                        } else if (statusCode) {
                            let effSc = statusCode;
                            if (subEvt.category === 'track' && effSc === 'NM') effSc = 'DNF';
                            await db.run(UPSERT_SQL, pe.event_entry_id, subEvt.name, subOrder, 0, 0, effSc);
                            synced++;
                        } else if (hasAttempts) {
                            const fallbackSc = (subEvt.category === 'field_distance' || subEvt.category === 'field_height') ? 'NM' : 'DNF';
                            await db.run(UPSERT_SQL, pe.event_entry_id, subEvt.name, subOrder, 0, 0, fallbackSc);
                            synced++;
                        }
                    }
                }
            })();
            broadcastSSE('combined_update', { event_id: parent_event_id });
            opLog(`🔧 종합 결과 강제 재계산: ${parentEvent.name} (삭제 ${wipedCount}건, 재구축 ${synced}건)`, 'event', 'admin', parentEvent.competition_id);
            res.json({ success: true, wiped: wipedCount, rebuilt: synced });
        } catch (err) {
            console.error('[combined-scores/repair]', err);
            res.status(500).json({ error: 'Repair failed: ' + (err.message || err) });
        }
    });
    
    // 🔍 진단 엔드포인트: 종합경기에서 특정 sub-event 점수가 누락된 원인을 즉시 추적.
    // 사용 예: GET /api/combined-scores/diag?parent_event_id=46&sub_order=2
    // (sub_order: 1-based, 10종 멀리뛰기=2, 7종 멀리뛰기=5 등)
    // 반환: 모든 부모 entry × sub entry × heat × result 매핑 상태 + 누락 사유.
    app.get('/api/combined-scores/diag', async (req, res) => {
        try {
            const parent_event_id = +req.query.parent_event_id;
            const sub_order = req.query.sub_order ? +req.query.sub_order : null;
            if (!parent_event_id) return res.status(400).json({ error: 'parent_event_id required' });
            const parentEvent = await db.get('SELECT * FROM event WHERE id=?', parent_event_id);
            if (!parentEvent) return res.status(404).json({ error: 'Parent event not found' });
            if (parentEvent.category !== 'combined') return res.status(400).json({ error: 'Not a combined event' });
    
            const waKeys = parentEvent.gender === 'M' ? DECATHLON_KEYS : HEPTATHLON_KEYS;
            const expectedCount = waKeys.length;
            const subEvents = await db.all('SELECT * FROM event WHERE parent_event_id=? ORDER BY sort_order, id', parent_event_id);
            const parentEntries = await db.all(`
                SELECT ee.id AS event_entry_id, ee.athlete_id, a.bib_number, a.name
                FROM event_entry ee JOIN athlete a ON a.id = ee.athlete_id
                WHERE ee.event_id=?
                ORDER BY a.bib_number
            `, parent_event_id);
    
            const targetIndices = sub_order ? [sub_order - 1] : subEvents.map((_, i) => i);
            const report = [];
    
            for (const idx of targetIndices) {
                if (idx < 0 || idx >= subEvents.length) continue;
                const subEvt = subEvents[idx];
                const subOrder = idx + 1;
                const waKey = waKeys[idx] || null;
                const subHeats = await db.all('SELECT id, heat_number FROM heat WHERE event_id=?', subEvt.id);
                const subHeatIds = subHeats.map(h => h.id);
                const heatPh = subHeatIds.length ? subHeatIds.map(() => '?').join(',') : null;
    
                const subInfo = {
                    sub_order: subOrder,
                    sub_event_id: subEvt.id,
                    sub_event_name: subEvt.name,
                    category: subEvt.category,
                    sort_order: subEvt.sort_order,
                    wa_key: waKey,
                    heats: subHeats,
                    athletes: []
                };
    
                for (const pe of parentEntries) {
                    const subEntry = await db.get('SELECT id, status FROM event_entry WHERE event_id=? AND athlete_id=?', subEvt.id, pe.athlete_id);
                    const row = {
                        bib: pe.bib_number,
                        name: pe.name,
                        athlete_id: pe.athlete_id,
                        parent_entry_id: pe.event_entry_id,
                        sub_entry_id: subEntry ? subEntry.id : null,
                        sub_entry_status: subEntry ? subEntry.status : null,
                        result_count: 0,
                        best_record: null,
                        has_attempts: false,
                        combined_score_row: null,
                        skip_reason: null
                    };
                    if (!subEntry) {
                        row.skip_reason = 'sub-event 에 event_entry 가 없음 (소집/엔트리 누락)';
                    } else if (!heatPh) {
                        row.skip_reason = 'sub-event 에 heat 가 없음';
                    } else {
                        if (subEvt.category === 'track') {
                            const r = await db.get(`SELECT MIN(time_seconds) AS best, COUNT(*) AS cnt FROM result WHERE heat_id IN (${heatPh}) AND event_entry_id=?`, ...subHeatIds, subEntry.id);
                            const valid = await db.get(`SELECT MIN(time_seconds) AS best FROM result WHERE heat_id IN (${heatPh}) AND event_entry_id=? AND time_seconds > 0`, ...subHeatIds, subEntry.id);
                            row.result_count = r ? r.cnt : 0;
                            row.best_record = valid ? valid.best : null;
                            row.has_attempts = row.result_count > 0;
                        } else if (subEvt.category === 'field_distance') {
                            const r = await db.get(`SELECT COUNT(*) AS cnt FROM result WHERE heat_id IN (${heatPh}) AND event_entry_id=? AND attempt_number IS NOT NULL`, ...subHeatIds, subEntry.id);
                            const valid = await db.get(`SELECT MAX(distance_meters) AS best FROM result WHERE heat_id IN (${heatPh}) AND event_entry_id=? AND distance_meters > 0`, ...subHeatIds, subEntry.id);
                            row.result_count = r ? r.cnt : 0;
                            row.best_record = valid ? valid.best : null;
                            row.has_attempts = row.result_count > 0;
                        } else if (subEvt.category === 'field_height') {
                            const r = await db.get(`SELECT COUNT(*) AS cnt FROM height_attempt WHERE heat_id IN (${heatPh}) AND event_entry_id=?`, ...subHeatIds, subEntry.id);
                            const valid = await db.get(`SELECT MAX(bar_height) AS best FROM height_attempt WHERE heat_id IN (${heatPh}) AND event_entry_id=? AND result_mark='O'`, ...subHeatIds, subEntry.id);
                            row.result_count = r ? r.cnt : 0;
                            row.best_record = valid ? valid.best : null;
                            row.has_attempts = row.result_count > 0;
                        }
                        // sanity check
                        if (row.best_record != null && waKey) {
                            let plausible = true;
                            if ((waKey === 'M_long_jump' || waKey === 'F_long_jump') && row.best_record > 12) plausible = false;
                            else if ((waKey === 'M_high_jump' || waKey === 'F_high_jump') && row.best_record > 3) plausible = false;
                            else if (waKey === 'M_pole_vault' && row.best_record > 7) plausible = false;
                            else if ((waKey === 'M_shot_put' || waKey === 'F_shot_put') && row.best_record > 25) plausible = false;
                            if (!plausible) row.skip_reason = `raw_record=${row.best_record} 가 ${waKey} 한계 초과 — sub-event 매핑 오류 가능`;
                        }
                    }
                    // combined_score 조회 (부모 entry 기준)
                    const cs = await db.get('SELECT * FROM combined_score WHERE event_entry_id=? AND sub_event_order=?', pe.event_entry_id, subOrder);
                    row.combined_score_row = cs || null;
                    if (!cs && row.best_record != null && !row.skip_reason) {
                        row.skip_reason = 'best_record 는 존재하나 combined_score row 없음 → sync 미실행 또는 sync 직후 다른 경로에서 삭제됨';
                    }
                    subInfo.athletes.push(row);
                }
                report.push(subInfo);
            }
    
            res.json({
                parent_event: { id: parentEvent.id, name: parentEvent.name, gender: parentEvent.gender, category: parentEvent.category },
                sub_event_count: subEvents.length,
                expected_count: expectedCount,
                parent_entries_count: parentEntries.length,
                report
            });
        } catch (err) {
            console.error('[combined-scores/diag]', err);
            res.status(500).json({ error: 'Diag failed: ' + (err.message || err) });
        }
    });
};
