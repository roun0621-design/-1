/**
 * Record Breaks (신기록 승인 큐) routes
 *
 * server.js 에서 추출됨 (2단계 모듈 분리 — 6차).
 * Phase C3/C4 — 신기록 자동 감지/승인/거부 워크플로
 *
 * 외부 의존성:
 *   db, isRecordOfficerOrAdmin, isAdminKey, opLog, broadcastSSE, getJudgeName
 *
 * 라우트 (5개):
 *   GET    /api/record-breaks                목록 + counts (status/competition_id 필터)
 *   GET    /api/record-breaks/recent         공개 — 최근 승인된 신기록 (배너용)
 *   GET    /api/record-breaks/:id            단건 조회
 *   POST   /api/record-breaks/:id/approve    승인 → event_record UPSERT
 *   POST   /api/record-breaks/:id/reject     거부
 *
 * ⚠️ /recent 는 /:id 보다 먼저 등록되어야 함 (Express 매칭 순서)
 */
module.exports = function mountRecordBreaksRoutes(app, deps) {
    const { db, isRecordOfficerOrAdmin, isAdminKey, opLog, broadcastSSE, getJudgeName } = deps;
    if (!app || !db || !isRecordOfficerOrAdmin || !isAdminKey || !opLog || !broadcastSSE || !getJudgeName) {
        throw new Error('[record_breaks.js] mount requires { db, isRecordOfficerOrAdmin, isAdminKey, opLog, broadcastSSE, getJudgeName }');
    }

    // GET /api/record-breaks?status=pending&competition_id=...&limit=100
    app.get('/api/record-breaks', async (req, res) => {
        try {
            const status = req.query.status || 'pending';
            const cId = req.query.competition_id ? parseInt(req.query.competition_id, 10) : null;
            const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
            const where = [];
            const params = [];
            if (status !== 'all') { where.push('rbl.status=?'); params.push(status); }
            if (cId) { where.push('rbl.competition_id=?'); params.push(cId); }
            const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
            const sql = `SELECT rbl.*,
                                c.name AS competition_name,
                                e.name AS event_real_name,
                                dm.label_ko AS division_label,
                                cs.name AS series_name
                         FROM record_breaking_log rbl
                         LEFT JOIN competition c ON c.id = rbl.competition_id
                         LEFT JOIN event e ON e.id = rbl.event_id
                         LEFT JOIN division_master dm ON dm.code = rbl.division_code
                         LEFT JOIN competition_series cs ON cs.id = rbl.series_id
                         ${whereSql}
                         ORDER BY rbl.detected_at DESC, rbl.id DESC
                         LIMIT ${limit}`;
            const rows = await db.all(sql, ...params);
            const counts = await db.get(`
                SELECT
                    COUNT(CASE WHEN status='pending' THEN 1 END) AS pending,
                    COUNT(CASE WHEN status='approved' THEN 1 END) AS approved,
                    COUNT(CASE WHEN status='rejected' THEN 1 END) AS rejected
                FROM record_breaking_log
                ${cId ? 'WHERE competition_id=?' : ''}
            `, ...(cId ? [cId] : []));
            res.json({ rows, counts: counts || { pending: 0, approved: 0, rejected: 0 } });
        } catch (err) {
            console.error('[GET /api/record-breaks]', err);
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/record-breaks/recent — 공개 (배너용)
    // ⚠️ :id 라우트보다 먼저 정의되어야 함
    app.get('/api/record-breaks/recent', async (req, res) => {
        try {
            const cId = req.query.competition_id ? parseInt(req.query.competition_id, 10) : null;
            const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 5, 1), 20);
            const where = ["rbl.status='approved'"];
            const params = [];
            if (cId) { where.push('rbl.competition_id=?'); params.push(cId); }
            const sql = `SELECT rbl.id, rbl.competition_id, rbl.event_id, rbl.record_type,
                                rbl.event_name, rbl.gender, rbl.division_code, rbl.series_id,
                                rbl.previous_value, rbl.new_value, rbl.new_value_num,
                                rbl.athlete_name, rbl.athlete_team, rbl.bib_number,
                                rbl.wind,
                                rbl.detected_at, rbl.reviewed_at,
                                c.name AS competition_name,
                                dm.label_ko AS division_label,
                                cs.name AS series_name
                         FROM record_breaking_log rbl
                         LEFT JOIN competition c ON c.id = rbl.competition_id
                         LEFT JOIN division_master dm ON dm.code = rbl.division_code
                         LEFT JOIN competition_series cs ON cs.id = rbl.series_id
                         WHERE ${where.join(' AND ')}
                         ORDER BY rbl.reviewed_at DESC, rbl.id DESC
                         LIMIT ${limit}`;
            const rows = await db.all(sql, ...params);
            res.json({ rows });
        } catch (err) {
            console.error('[GET /api/record-breaks/recent]', err);
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/record-breaks/:id — 단건 조회
    app.get('/api/record-breaks/:id', async (req, res) => {
        try {
            const row = await db.get(`
                SELECT rbl.*,
                       c.name AS competition_name,
                       e.name AS event_real_name,
                       dm.label_ko AS division_label,
                       cs.name AS series_name
                FROM record_breaking_log rbl
                LEFT JOIN competition c ON c.id = rbl.competition_id
                LEFT JOIN event e ON e.id = rbl.event_id
                LEFT JOIN division_master dm ON dm.code = rbl.division_code
                LEFT JOIN competition_series cs ON cs.id = rbl.series_id
                WHERE rbl.id=?
            `, req.params.id);
            if (!row) return res.status(404).json({ error: 'Not found' });
            res.json(row);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // POST /api/record-breaks/:id/approve — event_record UPSERT + status='approved'
    app.post('/api/record-breaks/:id/approve', async (req, res) => {
        try {
            const { admin_key, note } = req.body || {};
            if (!isRecordOfficerOrAdmin(admin_key)) return res.status(403).json({ error: '관리자 또는 기록위원 키가 필요합니다.' });
            const rbl = await db.get('SELECT * FROM record_breaking_log WHERE id=?', req.params.id);
            if (!rbl) return res.status(404).json({ error: 'Not found' });
            if (rbl.status !== 'pending') return res.status(400).json({ error: `이미 처리됨: ${rbl.status}` });

            const { record_type, event_name, gender, division_code, series_id, new_value, new_value_num,
                    athlete_name, athlete_team } = rbl;

            // 수립년도: detected_at의 연도 사용
            let recordYear = '';
            try { recordYear = String(new Date(rbl.detected_at).getFullYear()); }
            catch(e) { recordYear = String(new Date().getFullYear()); }

            // 기존 event_record 찾기 (NULL-aware)
            let existing;
            if (division_code == null && series_id == null) {
                existing = await db.get(
                    `SELECT id FROM event_record WHERE record_type=? AND event_name=? AND gender=?
                     AND division_code IS NULL AND series_id IS NULL`,
                    record_type, event_name, gender
                );
            } else if (division_code != null && series_id == null) {
                existing = await db.get(
                    `SELECT id FROM event_record WHERE record_type=? AND event_name=? AND gender=?
                     AND division_code=? AND series_id IS NULL`,
                    record_type, event_name, gender, division_code
                );
            } else if (division_code == null && series_id != null) {
                existing = await db.get(
                    `SELECT id FROM event_record WHERE record_type=? AND event_name=? AND gender=?
                     AND division_code IS NULL AND series_id=?`,
                    record_type, event_name, gender, series_id
                );
            }

            if (existing) {
                await db.run(
                    `UPDATE event_record SET record_value=?, record_year=?, holder_name=?, holder_team=?, approved=1 WHERE id=?`,
                    new_value || (new_value_num != null ? String(new_value_num) : ''),
                    recordYear, athlete_name || '', athlete_team || '', existing.id
                );
            } else {
                await db.run(
                    `INSERT INTO event_record (record_type, event_name, gender, division_code, series_id,
                                               record_value, holder_name, holder_team, record_year, approved)
                     VALUES (?,?,?,?,?,?,?,?,?,1)`,
                    record_type, event_name, gender, division_code, series_id,
                    new_value || (new_value_num != null ? String(new_value_num) : ''),
                    athlete_name || '', athlete_team || '', recordYear
                );
            }

            // log 상태 갱신
            const nowFn = db.isAsync ? 'NOW()' : "datetime('now')";
            await db.run(
                `UPDATE record_breaking_log SET status='approved', reviewed_at=${nowFn}, reviewed_by=?, review_note=? WHERE id=?`,
                getJudgeName(admin_key) || 'admin', note || '', rbl.id
            );

            const reviewerRole = isAdminKey(admin_key) ? 'admin' : 'record_officer';
            opLog(`🏆 기록 승인: ${event_name} ${record_type.toUpperCase()} (${athlete_name} ${new_value})`,
                  getJudgeName(admin_key) || reviewerRole, reviewerRole, rbl.competition_id);
            broadcastSSE('record_break_resolved', { id: rbl.id, status: 'approved', competition_id: rbl.competition_id });
            res.json({ success: true, status: 'approved' });
        } catch (err) {
            console.error('[approve record-break]', err);
            res.status(500).json({ error: err.message });
        }
    });

    // POST /api/record-breaks/:id/reject — status='rejected'
    app.post('/api/record-breaks/:id/reject', async (req, res) => {
        try {
            const { admin_key, note } = req.body || {};
            if (!isRecordOfficerOrAdmin(admin_key)) return res.status(403).json({ error: '관리자 또는 기록위원 키가 필요합니다.' });
            const rbl = await db.get('SELECT * FROM record_breaking_log WHERE id=?', req.params.id);
            if (!rbl) return res.status(404).json({ error: 'Not found' });
            if (rbl.status !== 'pending') return res.status(400).json({ error: `이미 처리됨: ${rbl.status}` });
            const nowFn = db.isAsync ? 'NOW()' : "datetime('now')";
            await db.run(
                `UPDATE record_breaking_log SET status='rejected', reviewed_at=${nowFn}, reviewed_by=?, review_note=? WHERE id=?`,
                getJudgeName(admin_key) || 'admin', note || '', rbl.id
            );
            const reviewerRole = isAdminKey(admin_key) ? 'admin' : 'record_officer';
            opLog(`기록 거부: ${rbl.event_name} ${rbl.record_type.toUpperCase()} (${rbl.athlete_name} ${rbl.new_value})`,
                  getJudgeName(admin_key) || reviewerRole, reviewerRole, rbl.competition_id);
            broadcastSSE('record_break_resolved', { id: rbl.id, status: 'rejected', competition_id: rbl.competition_id });
            res.json({ success: true, status: 'rejected' });
        } catch (err) {
            console.error('[reject record-break]', err);
            res.status(500).json({ error: err.message });
        }
    });
};
