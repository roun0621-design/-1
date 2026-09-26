'use strict';
/**
 * 기록표 관리자 진단(매칭 현황·일괄 정규화·재연결·후보) — server.js 에서 이동 (2026-09-22, Phase 4 분해). 동작은 인라인 시절과 같다.
 *   deps: _divisionCodeFor, db, isAdminKey, isOperationKey, normalizeEventNameServer, opLog
 */
module.exports = function mountEventRecordAdminRoutes(app, deps) {
    const { _divisionCodeFor, db, isAdminKey, isOperationKey, normalizeEventNameServer, opLog } = deps;
    for (const k of ["_divisionCodeFor","db","isAdminKey","isOperationKey","normalizeEventNameServer","opLog"]) if (deps[k] === undefined) throw new Error('[event_record_admin.js] mount requires deps.' + k);

    // ============================================================
    // [Admin] 시리즈 ↔ 대회 종목 매칭 진단 / 일괄 정규화
    // ============================================================
    // GET /api/admin/event-record-matching?competition_id=123
    //   → 해당 대회의 모든 종목에 대해 NR/DR/CR 매칭 상태를 진단하여 반환.
    //      각 종목별로 { event_name, gender, division_code, series_id,
    //                  national: 'exact'|'normalized'|'none',
    //                  division: ...,
    //                  competition: ...,
    //                  hints: [{ type, db_event_name, suggestion }] }
    //      운영자가 어떤 종목에 NR/CR 매칭이 안 되는지 한눈에 보고 정규화 버튼으로 일괄 정리.
    app.get('/api/admin/event-record-matching', async (req, res) => {
        try {
            const compId = parseInt(req.query.competition_id, 10);
            if (!compId) return res.status(400).json({ error: 'competition_id 필수' });
            const comp = await db.get('SELECT * FROM competition WHERE id=?', compId);
            if (!comp) return res.status(404).json({ error: '대회를 찾을 수 없습니다.' });

            const seriesId = comp.series_id || null;
            // 대회의 모든 종목 (부모 합동/혼성 포함, 세부종목 제외)
            // event 에는 division_code 컬럼이 없고 부 라벨(division)만 있다 → 라벨·학년·성별로 부 마스터 코드를 푼다 (Phase 7-②, 기록 감지와 같은 규칙)
            const events = await db.all(
                `SELECT id, name, gender, division FROM event WHERE competition_id=? AND parent_event_id IS NULL ORDER BY id`,
                compId
            );
            const _masters = await db.all('SELECT code, label_ko, gender, school_level, grade FROM division_master WHERE active=1');
            for (const e of events) e.division_code = _divisionCodeFor(e.division, e.gender, _masters);
            // 모든 event_record (approved=1) 를 한 번에 가져와 매칭 (DB hit 최소화)
            const allRecords = await db.all(
                `SELECT id, record_type, event_name, gender, division_code, series_id, record_value, holder_name FROM event_record WHERE approved=1`
            );

            // 헬퍼: 동일 (record_type, gender, divCode, seriesId) 묶음에서 매칭 찾기
            function findMatch(records, type, gender, divCode, seriesIdArg, eventName) {
                const targetNorm = normalizeEventNameServer(eventName);
                // 1) 동일 type/gender/divCode/seriesId 인 후보 좁히기
                const cands = records.filter(r =>
                    r.record_type === type && r.gender === gender &&
                    ((divCode == null && !r.division_code) || r.division_code === divCode) &&
                    ((seriesIdArg == null && !r.series_id) || r.series_id === seriesIdArg)
                );
                if (cands.length === 0) return { status: 'none', record: null };
                // 2) 정확 매칭
                const exact = cands.find(r => r.event_name === eventName);
                if (exact) return { status: 'exact', record: exact };
                // 3) 정규화 fallback
                const normMatch = cands.find(r => normalizeEventNameServer(r.event_name || '') === targetNorm);
                if (normMatch) return { status: 'normalized', record: normMatch };
                // 매칭 안 됨 → 종목명 유사도로 후보 좁히기 (전체 cands 가 아닌 관련 후보만)
                //   1) 정규형이 동일하거나
                //   2) 한쪽이 다른 쪽의 부분문자열이거나
                //   3) 정규형 기준 substring 관계
                const targetLower = String(eventName || '').toLowerCase();
                function _isRelated(c) {
                    const cn = String(c.event_name || '');
                    const cnNorm = normalizeEventNameServer(cn);
                    if (cnNorm === targetNorm) return true;
                    const cnLower = cn.toLowerCase();
                    if (cnLower.includes(targetLower) || targetLower.includes(cnLower)) return true;
                    if (cnNorm && (cnNorm.includes(targetNorm) || targetNorm.includes(cnNorm))) return true;
                    return false;
                }
                const related = cands.filter(_isRelated);
                // 유사 후보만 표시 (관련 없는 전체 후보 노출 X). 관련 후보 0 이면 빈 배열.
                const finalCands = related.slice(0, 5);
                return {
                    status: 'none',
                    record: null,
                    candidates: finalCands.map(c => c.event_name),
                    candidate_records: finalCands.map(c => ({ id: c.id, event_name: c.event_name, record_value: c.record_value, holder_name: c.holder_name }))
                };
            }

            const results = events.map(evt => {
                const nr = findMatch(allRecords, 'national', evt.gender, null, null, evt.name);
                const dr = evt.division_code
                    ? findMatch(allRecords, 'division', evt.gender, evt.division_code, null, evt.name)
                    : { status: 'n/a', record: null };
                const cr = seriesId
                    ? findMatch(allRecords, 'competition', evt.gender, null, seriesId, evt.name)
                    : { status: 'n/a', record: null };
                return {
                    event_id: evt.id,
                    event_name: evt.name,
                    event_name_normalized: normalizeEventNameServer(evt.name),
                    gender: evt.gender,
                    division_code: evt.division_code,
                    national:    { status: nr.status, db_event_name: nr.record ? nr.record.event_name : null, record_id: nr.record ? nr.record.id : null, record_value: nr.record ? nr.record.record_value : null, holder_name: nr.record ? nr.record.holder_name : null, candidates: nr.candidates || [], candidate_records: nr.candidate_records || [] },
                    division:    { status: dr.status, db_event_name: dr.record ? dr.record.event_name : null, record_id: dr.record ? dr.record.id : null, record_value: dr.record ? dr.record.record_value : null, holder_name: dr.record ? dr.record.holder_name : null, candidates: dr.candidates || [], candidate_records: dr.candidate_records || [] },
                    competition: { status: cr.status, db_event_name: cr.record ? cr.record.event_name : null, record_id: cr.record ? cr.record.id : null, record_value: cr.record ? cr.record.record_value : null, holder_name: cr.record ? cr.record.holder_name : null, candidates: cr.candidates || [], candidate_records: cr.candidate_records || [] }
                };
            });

            // 요약 통계
            const summary = {
                total_events: events.length,
                nr: { exact: 0, normalized: 0, none: 0 },
                dr: { exact: 0, normalized: 0, none: 0, na: 0 },
                cr: { exact: 0, normalized: 0, none: 0, na: 0 }
            };
            for (const r of results) {
                if (r.national.status === 'exact') summary.nr.exact++;
                else if (r.national.status === 'normalized') summary.nr.normalized++;
                else summary.nr.none++;
                if (r.division.status === 'exact') summary.dr.exact++;
                else if (r.division.status === 'normalized') summary.dr.normalized++;
                else if (r.division.status === 'n/a') summary.dr.na++;
                else summary.dr.none++;
                if (r.competition.status === 'exact') summary.cr.exact++;
                else if (r.competition.status === 'normalized') summary.cr.normalized++;
                else if (r.competition.status === 'n/a') summary.cr.na++;
                else summary.cr.none++;
            }

            res.json({
                competition: { id: comp.id, name: comp.name, series_id: seriesId },
                summary,
                events: results
            });
        } catch (err) {
            console.error('[event-record-matching]', err);
            res.status(500).json({ error: err.message });
        }
    });

    // POST /api/admin/event-records/normalize-all
    // Body: { admin_key, dry_run?: boolean, only_record_ids?: number[] }
    // → event_record.event_name 을 normalizeEventName() 결과로 일괄 업데이트.
    //   dry_run=true 이면 실제 update 는 안 하고 변경 예상만 반환.
    //   only_record_ids 지정 시 그 id 들만 처리.
    //   UNIQUE(record_type, event_name, gender, division_code, series_id) 충돌 시 해당 행은 skip.
    app.post('/api/admin/event-records/normalize-all', async (req, res) => {
        try {
            const { admin_key, dry_run, only_record_ids } = req.body || {};
            if (!isAdminKey(admin_key) && !isOperationKey(admin_key)) {
                return res.status(403).json({ error: '관리자 키가 필요합니다.' });
            }
            const isDry = !!dry_run;
            const idsFilter = Array.isArray(only_record_ids) && only_record_ids.length > 0
                ? only_record_ids.map(x => parseInt(x, 10)).filter(Number.isFinite)
                : null;

            // 후보 가져오기
            let rows;
            if (idsFilter && idsFilter.length > 0) {
                const ph = idsFilter.map(() => '?').join(',');
                rows = await db.all(`SELECT id, record_type, event_name, gender, division_code, series_id FROM event_record WHERE id IN (${ph})`, ...idsFilter);
            } else {
                rows = await db.all(`SELECT id, record_type, event_name, gender, division_code, series_id FROM event_record`);
            }

            const plan = [];
            const skipped = [];
            const updated = [];
            for (const r of rows) {
                const norm = normalizeEventNameServer(r.event_name || '');
                if (!norm || norm === r.event_name) continue;
                // UNIQUE 충돌 검사: 같은 (record_type, gender, division_code, series_id) 안에 이미 norm 이름이 있는지
                const conflict = await db.get(
                    `SELECT id FROM event_record WHERE record_type=? AND event_name=? AND gender=?
                       AND COALESCE(division_code,'')=COALESCE(?,'')
                       AND COALESCE(series_id,-1)=COALESCE(?,-1)
                       AND id<>?`,
                    r.record_type, norm, r.gender, r.division_code || null, r.series_id || null, r.id
                );
                if (conflict) {
                    skipped.push({ id: r.id, before: r.event_name, after: norm, reason: 'UNIQUE conflict with id=' + conflict.id });
                    continue;
                }
                plan.push({ id: r.id, before: r.event_name, after: norm, record_type: r.record_type, gender: r.gender });
                if (!isDry) {
                    const _nowFER = db.isAsync ? 'NOW()' : "datetime('now')";
                    await db.run(`UPDATE event_record SET event_name=?, updated_at=${_nowFER} WHERE id=?`, norm, r.id);
                    updated.push(r.id);
                }
            }

            if (!isDry) {
                try { opLog(`[기록정규화] event_record 일괄 정규화: 총 ${plan.length}건 업데이트 / ${skipped.length}건 skip`, 'admin', 'admin', null); } catch(e) {}
            }

            res.json({
                dry_run: isDry,
                total_scanned: rows.length,
                planned_updates: plan.length,
                updated_count: updated.length,
                skipped_count: skipped.length,
                planned: plan,
                skipped
            });
        } catch (err) {
            console.error('[event-records/normalize-all]', err);
            res.status(500).json({ error: err.message });
        }
    });

    // ──────────────────────────────────────────────────────────────
    // PUT /api/admin/event-records/:id/relink
    // Body: { admin_key, target_event_name }
    // → 시간표↔종목 매칭과 동일한 패턴의 인라인 1:1 매칭.
    //   기존 event_record 의 event_name 을 target_event_name 으로 변경하여
    //   특정 대회 종목(event.name)과 매칭되도록 함.
    //   UNIQUE(record_type, event_name, gender, division_code, series_id) 충돌 시 거부.
    // ──────────────────────────────────────────────────────────────
    app.put('/api/admin/event-records/:id/relink', async (req, res) => {
        try {
            const { admin_key, target_event_name } = req.body || {};
            if (!isAdminKey(admin_key) && !isOperationKey(admin_key)) {
                return res.status(403).json({ error: '관리자 키가 필요합니다.' });
            }
            const id = parseInt(req.params.id, 10);
            if (!id) return res.status(400).json({ error: 'id 필수' });
            const target = String(target_event_name || '').trim();
            if (!target) return res.status(400).json({ error: 'target_event_name 필수' });

            const r = await db.get(`SELECT id, record_type, event_name, gender, division_code, series_id FROM event_record WHERE id=?`, id);
            if (!r) return res.status(404).json({ error: '기록을 찾을 수 없습니다.' });
            if (r.event_name === target) {
                return res.json({ success: true, no_change: true });
            }
            // UNIQUE 충돌 검사 (같은 type/gender/divCode/seriesId 안에서)
            const conflict = await db.get(
                `SELECT id FROM event_record WHERE record_type=? AND event_name=? AND gender=?
                   AND COALESCE(division_code,'')=COALESCE(?,'')
                   AND COALESCE(series_id,-1)=COALESCE(?,-1)
                   AND id<>?`,
                r.record_type, target, r.gender, r.division_code || null, r.series_id || null, r.id
            );
            if (conflict) {
                return res.status(409).json({ error: `이미 같은 슬롯에 '${target}' 기록이 존재합니다 (id=${conflict.id}).` });
            }
            const _nowER = db.isAsync ? 'NOW()' : "datetime('now')";
            await db.run(`UPDATE event_record SET event_name=?, updated_at=${_nowER} WHERE id=?`, target, id);
            try { opLog(`[기록재연결] event_record id=${id} '${r.event_name}' → '${target}'`, 'admin', 'admin', null); } catch(e) {}
            res.json({ success: true, before: r.event_name, after: target });
        } catch (err) {
            console.error('[event-records/relink]', err);
            res.status(500).json({ error: err.message });
        }
    });

    // ──────────────────────────────────────────────────────────────
    // GET /api/admin/event-records/all-candidates
    // Query: ?record_type=national|division|competition&gender=M|F|X&series_id=N(optional)
    // → 같은 슬롯(type+gender+series) 에 등록된 모든 event_record 반환.
    //   사용자가 정규화로도 매칭 안 되는 종목을 강제로 연결할 때 사용.
    //   "있는데 못 불러오는" 케이스 (콤마/공백/표기 차이 등 정규화기가 못 잡는 경우).
    // ──────────────────────────────────────────────────────────────
    app.get('/api/admin/event-records/all-candidates', async (req, res) => {
        try {
            const recordType = String(req.query.record_type || '').trim();
            const gender = String(req.query.gender || '').trim();
            if (!['national', 'division', 'competition'].includes(recordType)) {
                return res.status(400).json({ error: 'record_type 은 national/division/competition' });
            }
            if (!gender) return res.status(400).json({ error: 'gender 필수' });
            const seriesId = req.query.series_id ? parseInt(req.query.series_id, 10) : null;

            let sql = `SELECT id, record_type, event_name, gender, division_code, series_id,
                              record_value, holder_name, holder_team, record_year
                       FROM event_record
                       WHERE record_type=? AND gender=? AND approved=1`;
            const args = [recordType, gender];
            if (recordType === 'competition' && seriesId) {
                sql += ` AND series_id=?`;
                args.push(seriesId);
            } else if (recordType === 'national') {
                sql += ` AND series_id IS NULL AND division_code IS NULL`;
            }
            sql += ` ORDER BY event_name`;
            const rows = await db.all(sql, ...args);
            res.json({ candidates: rows || [] });
        } catch (err) {
            console.error('[event-records/all-candidates]', err);
            res.status(500).json({ error: err.message });
        }
    });

    return {  };
};
