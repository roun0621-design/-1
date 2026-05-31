/**
 * Records v4 (NR/DR/CR 통합) routes
 *
 * server.js 에서 추출됨 (2단계 모듈 분리 — 4차).
 * 외부 의존성: db, isAdminKey, opLog
 *
 * 사용법:
 *   require('./lib/routes/records')(app, { db, isAdminKey, opLog });
 *
 * 라우트 (4개):
 *   GET    /api/records              필터 조회 (event_name/gender/record_type/division_code/series_id)
 *   GET    /api/records/matrix       종목+성별 단위로 NR/DR/CR 묶음 반환
 *   PUT    /api/records              수동 UPSERT (admin_key 필요)
 *   DELETE /api/records/:id          삭제 (admin_key 필요)
 *
 * ⚠️ /matrix 는 /:id 보다 먼저 등록되어야 함 (라우트 순서 주의)
 */
module.exports = function mountRecordsRoutes(app, deps) {
    const { db, isAdminKey, opLog } = deps;
    if (!app || !db || !isAdminKey || !opLog) {
        throw new Error('[records.js] mount requires { db, isAdminKey, opLog }');
    }

    // GET records — query params로 필터: ?event_name=&gender=&record_type=&division_code=&series_id=
    app.get('/api/records', async (req, res) => {
        try {
            const { event_name, gender, record_type, division_code, series_id } = req.query;
            const where = [];
            const params = [];
            if (event_name)    { where.push('event_name=?');    params.push(event_name); }
            if (gender)        { where.push('gender=?');        params.push(gender); }
            if (record_type)   { where.push('record_type=?');   params.push(record_type); }
            if (division_code) { where.push('division_code=?'); params.push(division_code); }
            if (series_id)     { where.push('series_id=?');     params.push(parseInt(series_id, 10)); }
            const sql = 'SELECT * FROM event_record'
                + (where.length ? ' WHERE ' + where.join(' AND ') : '')
                + ' ORDER BY event_name, gender, record_type, division_code, series_id';
            const rows = await db.all(sql, ...params);
            res.json(rows);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // GET matrix — 특정 종목+성별의 NR/DR(13개)/CR(시리즈별) 한 번에 묶어 반환
    // 응답 형태: { event_name, gender, national: {...|null}, divisions: { M_OPEN:{...|null}, ... }, competitions: [{series_id, series_name, ...}] }
    app.get('/api/records/matrix', async (req, res) => {
        try {
            const { event_name, gender } = req.query;
            if (!event_name || !gender) return res.status(400).json({ error: 'event_name, gender 필수' });
            const rows = await db.all(
                'SELECT * FROM event_record WHERE event_name=? AND gender=?',
                event_name, gender
            );
            const divisions = await db.all('SELECT code FROM division_master WHERE active=1 ORDER BY sort_order');
            const seriesAll = await db.all('SELECT id, name, federation FROM competition_series WHERE active=1 ORDER BY name');

            const result = {
                event_name,
                gender,
                national: null,
                divisions: {},   // code -> record | null
                competitions: [] // [{series_id, series_name, record}]
            };
            for (const d of divisions) result.divisions[d.code] = null;
            const seriesMap = {};
            for (const s of seriesAll) {
                seriesMap[s.id] = { series_id: s.id, series_name: s.name, federation: s.federation, record: null };
            }

            for (const r of rows) {
                if (r.record_type === 'national' && r.division_code == null && r.series_id == null) {
                    result.national = r;
                } else if (r.record_type === 'division' && r.division_code) {
                    result.divisions[r.division_code] = r;
                } else if (r.record_type === 'competition' && r.series_id != null) {
                    if (seriesMap[r.series_id]) seriesMap[r.series_id].record = r;
                }
            }
            result.competitions = Object.values(seriesMap);
            res.json(result);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // PUT/POST records — upsert
    // body: { admin_key, record_type, event_name, gender, division_code?, series_id?,
    //         record_value, holder_name?, holder_team?, record_year?, record_date?, venue?, note? }
    app.put('/api/records', async (req, res) => {
        try {
            const {
                admin_key, record_type, event_name, gender, division_code, series_id,
                record_value, holder_name, holder_team, record_year, record_date, venue, note
            } = req.body;
            if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
            if (!record_type || !event_name || !gender) {
                return res.status(400).json({ error: 'record_type, event_name, gender 필수' });
            }
            if (!['national','division','competition'].includes(record_type)) {
                return res.status(400).json({ error: 'record_type는 national/division/competition' });
            }
            if (!['M','F','X'].includes(gender)) {
                return res.status(400).json({ error: 'gender는 M/F/X' });
            }
            // Consistency checks
            if (record_type === 'national'    && (division_code || series_id))  return res.status(400).json({ error: 'NR은 division_code/series_id 없어야 합니다.' });
            if (record_type === 'division'    && !division_code)                return res.status(400).json({ error: 'DR은 division_code 필수' });
            if (record_type === 'competition' && !series_id)                    return res.status(400).json({ error: 'CR은 series_id 필수' });

            const dCode = division_code || null;
            const sId   = series_id ? parseInt(series_id, 10) : null;
            const nowExpr = db.isAsync ? 'NOW()' : `datetime('now')`;

            // 수동 UPSERT (NULL 컬럼이 UNIQUE에 포함되어 있어 ON CONFLICT가 불안정)
            let existing;
            if (dCode == null && sId == null) {
                existing = await db.get(
                    'SELECT id FROM event_record WHERE record_type=? AND event_name=? AND gender=? AND division_code IS NULL AND series_id IS NULL',
                    record_type, event_name, gender
                );
            } else if (dCode != null && sId == null) {
                existing = await db.get(
                    'SELECT id FROM event_record WHERE record_type=? AND event_name=? AND gender=? AND division_code=? AND series_id IS NULL',
                    record_type, event_name, gender, dCode
                );
            } else if (dCode == null && sId != null) {
                existing = await db.get(
                    'SELECT id FROM event_record WHERE record_type=? AND event_name=? AND gender=? AND division_code IS NULL AND series_id=?',
                    record_type, event_name, gender, sId
                );
            }

            if (existing) {
                await db.run(
                    `UPDATE event_record SET record_value=?, holder_name=?, holder_team=?, record_year=?, record_date=?, venue=?, note=?, approved=1, updated_at=${nowExpr} WHERE id=?`,
                    record_value || '', holder_name || '', holder_team || '',
                    record_year || '', record_date || '', venue || '', note || '', existing.id
                );
                res.json({ success: true, id: existing.id, mode: 'updated' });
            } else {
                const info = await db.run(
                    `INSERT INTO event_record (record_type, event_name, gender, division_code, series_id, record_value, holder_name, holder_team, record_year, record_date, venue, note, approved) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)`,
                    record_type, event_name, gender, dCode, sId,
                    record_value || '', holder_name || '', holder_team || '',
                    record_year || '', record_date || '', venue || '', note || ''
                );
                res.json({ success: true, id: info.lastInsertRowid, mode: 'inserted' });
            }
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // DELETE /api/records/:id — admin_key 필요
    app.delete('/api/records/:id', async (req, res) => {
        try {
            const { admin_key } = req.body || {};
            if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
            const r = await db.get('SELECT * FROM event_record WHERE id=?', req.params.id);
            if (!r) return res.status(404).json({ error: 'Not found' });
            await db.run('DELETE FROM event_record WHERE id=?', req.params.id);
            opLog(`기록 삭제: ${r.event_name} ${r.gender} ${r.record_type} ${r.division_code||''} ${r.series_id||''}`, 'admin', 'admin');
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
};
