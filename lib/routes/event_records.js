'use strict';
/**
 * 종목별 기록표(event_records, 결과지 하단 NR/DR/CR 표) · 부(division) 마스터 — server.js 에서 추출 (2026-09 Phase 4)
 *   GET/PUT /api/event-records[/batch|/:gender/:eventName] · GET /api/divisions · /api/admin/divisions CRUD
 *   ※ 동작은 인라인 시절과 동일 — 회귀: tests/api/09_read_endpoints, 24_records_bulk, 21_heat_assignment_division
 */
const XLSX = require('xlsx');

module.exports = function mountEventRecordsRoutes(app, deps) {
    const { db, isAdminKey, opLog, upload, guessEventCategory } = deps;
    for (const [k, v] of Object.entries({ db, isAdminKey, opLog, upload, guessEventCategory })) {
        if (!v) throw new Error(`[event_records] mount requires deps.${k}`);
    }

    // ============================================================
    // EVENT RECORDS MANAGEMENT — 종목별 기록 관리 API
    // ============================================================

    // GET all event records (optionally filter by gender)
    app.get('/api/event-records', async (req, res) => {
        try {
            const gender = req.query.gender; // M or F
            let rows;
            if (gender) {
                rows = await db.all('SELECT * FROM event_record WHERE gender=? ORDER BY event_name, record_type', gender);
            } else {
                rows = await db.all('SELECT * FROM event_record ORDER BY gender, event_name, record_type');
            }
            res.json(rows);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // GET records for a specific event
    app.get('/api/event-records/:gender/:eventName', async (req, res) => {
        try {
            const { gender, eventName } = req.params;
            const rows = await db.all('SELECT * FROM event_record WHERE gender=? AND event_name=? ORDER BY record_type', gender, decodeURIComponent(eventName));
            // Return as object: { national: {...}, division: {...}, competition: {...} }
            const result = {};
            for (const r of rows) result[r.record_type] = r;
            res.json(result);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // PUT (upsert) event record — 백워드 호환 (구 UI 호출용)
    // v4 스키마: UNIQUE(record_type, event_name, gender, division_code, series_id)
    // 구 UI는 division_code/series_id 없이 호출하므로 NULL로 처리 → NR(national)만 의미 있음.
    // DR/CR도 division_code/series_id NULL인 슬롯 하나만 차지하게 됨 (구 호환).
    // 새 UI는 /api/records (신 API) 를 사용해야 함.
    app.put('/api/event-records', async (req, res) => {
        try {
            const { admin_key, gender, event_name, record_type, record_value, holder_name, holder_team, record_year } = req.body;
            if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
            if (!gender || !event_name || !record_type) return res.status(400).json({ error: 'gender, event_name, record_type 필수' });
            if (!['M','F','X'].includes(gender)) return res.status(400).json({ error: 'gender는 M/F/X' });
            if (!['national','division','competition'].includes(record_type)) return res.status(400).json({ error: 'record_type는 national/division/competition' });

            // v4 UNIQUE: (record_type, event_name, gender, division_code, series_id)
            // SQLite/PG 모두 NULL은 distinct로 취급하므로 ON CONFLICT 사용 불가 → 수동 UPSERT
            const existing = await db.get(
                `SELECT id FROM event_record WHERE record_type=? AND event_name=? AND gender=? AND division_code IS NULL AND series_id IS NULL`,
                record_type, event_name, gender
            );
            if (existing) {
                await db.run(
                    `UPDATE event_record SET record_value=?, holder_name=?, holder_team=?, record_year=?, updated_at=` + (db.isAsync ? 'NOW()' : `datetime('now')`) + ` WHERE id=?`,
                    record_value || '', holder_name || '', holder_team || '', record_year || '', existing.id
                );
            } else {
                await db.run(
                    `INSERT INTO event_record (record_type, event_name, gender, division_code, series_id, record_value, holder_name, holder_team, record_year, approved) VALUES (?,?,?,NULL,NULL,?,?,?,?,1)`,
                    record_type, event_name, gender, record_value || '', holder_name || '', holder_team || '', record_year || ''
                );
            }
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // PUT batch upsert for a single event (all 3 record types at once) — 백워드 호환
    app.put('/api/event-records/batch', async (req, res) => {
        try {
            const { admin_key, gender, event_name, records } = req.body;
            if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
            if (!gender || !event_name || !records) return res.status(400).json({ error: 'gender, event_name, records 필수' });

            const nowExpr = db.isAsync ? 'NOW()' : `datetime('now')`;
            await db.transaction(async () => {
                for (const rt of ['national', 'division', 'competition']) {
                    const r = records[rt];
                    if (!r) continue;
                    const existing = await db.get(
                        `SELECT id FROM event_record WHERE record_type=? AND event_name=? AND gender=? AND division_code IS NULL AND series_id IS NULL`,
                        rt, event_name, gender
                    );
                    if (existing) {
                        await db.run(
                            `UPDATE event_record SET record_value=?, holder_name=?, holder_team=?, record_year=?, updated_at=${nowExpr} WHERE id=?`,
                            r.record_value || '', r.holder_name || '', r.holder_team || '', r.record_year || '', existing.id
                        );
                    } else {
                        await db.run(
                            `INSERT INTO event_record (record_type, event_name, gender, division_code, series_id, record_value, holder_name, holder_team, record_year, approved) VALUES (?,?,?,NULL,NULL,?,?,?,?,1)`,
                            rt, event_name, gender, r.record_value || '', r.holder_name || '', r.holder_team || '', r.record_year || ''
                        );
                    }
                }
            })();

            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ============================================================
    // RECORDS MANAGEMENT v4 — NR/DR/CR 통합 신 API (Phase B-2)
    // ============================================================

    // GET divisions master
    app.get('/api/divisions', async (req, res) => {
        try {
            const rows = await db.all('SELECT code, label_ko, gender, school_level, sort_order, grade FROM division_master WHERE active=1 ORDER BY sort_order, code');
            res.json(rows);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ─── Division Master CRUD (관리자 전용) ───
    // 기본 13부 시드(시스템 부)는 code 변경/삭제 차단, label_ko/sort_order만 편집 허용.
    // 기본 13부 + 학년 단위 20부(부팅 때 다시 시드되므로 지워도 되살아난다 → 삭제 대신 비활성)
    const BASE_DIVISION_CODES = new Set([
        'M_ELEM','M_MID','M_HIGH','M_UNIV','M_GEN','M_OPEN',
        'F_ELEM','F_MID','F_HIGH','F_UNIV','F_GEN','F_OPEN',
        'MIXED',
        ...require('../division').gradeDivisionSeed().map(r => r[0]),
    ]);

    // GET all divisions (active+inactive, admin/operator view)
    app.get('/api/admin/divisions', async (req, res) => {
        try {
            const rows = await db.all('SELECT code, label_ko, gender, school_level, sort_order, active, created_at, grade FROM division_master ORDER BY sort_order, code');
            // is_base 플래그 부여 (UI 보호용)
            const result = rows.map(r => ({ ...r, is_base: BASE_DIVISION_CODES.has(r.code) }));
            res.json(result);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // POST create division (admin only)
    app.post('/api/admin/divisions', async (req, res) => {
        try {
            const { admin_key, code, label_ko, gender, school_level, sort_order, grade } = req.body || {};
            if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
            if (!code || !code.trim()) return res.status(400).json({ error: 'code 필수' });
            const gradeNum = grade == null || grade === '' ? null : parseInt(grade, 10);
            if (gradeNum != null && !(gradeNum >= 1 && gradeNum <= 6)) return res.status(400).json({ error: 'grade는 1~6' });
            if (!label_ko || !label_ko.trim()) return res.status(400).json({ error: 'label_ko 필수' });
            if (!['M','F','X'].includes(gender)) return res.status(400).json({ error: 'gender는 M/F/X 중 하나' });
            const validLevels = ['OPEN','ELEM','MID','HIGH','UNIV','GEN','MIXED'];
            if (!validLevels.includes(school_level)) return res.status(400).json({ error: 'school_level은 ' + validLevels.join('/') + ' 중 하나' });
            const codeTrim = code.trim().toUpperCase();
            // code 형식 검증 (영숫자/언더스코어만)
            if (!/^[A-Z0-9_]+$/.test(codeTrim)) return res.status(400).json({ error: 'code는 영문 대문자/숫자/언더스코어만 사용 가능' });
            const so = Number.isFinite(parseInt(sort_order, 10)) ? parseInt(sort_order, 10) : 500;
            try {
                await db.run(
                    'INSERT INTO division_master (code, label_ko, gender, school_level, sort_order, active, grade) VALUES (?, ?, ?, ?, ?, 1, ?)',
                    codeTrim, label_ko.trim(), gender, school_level, so, gradeNum
                );
                const row = await db.get('SELECT code, label_ko, gender, school_level, sort_order, active, created_at, grade FROM division_master WHERE code=?', codeTrim);
                opLog(`부 생성: ${codeTrim} (${label_ko.trim()})`, 'admin', 'admin');
                res.json({ ...row, is_base: false });
            } catch (e) {
                if (/UNIQUE|duplicate|PRIMARY/i.test(e.message)) return res.status(400).json({ error: '같은 code의 부가 이미 존재합니다.' });
                throw e;
            }
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // PUT update division (admin only). 기본 13부는 label_ko / sort_order 만 변경 가능.
    app.put('/api/admin/divisions/:code', async (req, res) => {
        try {
            const { admin_key, label_ko, gender, school_level, sort_order, active, grade } = req.body || {};
            if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
            const code = req.params.code;
            const old = await db.get('SELECT * FROM division_master WHERE code=?', code);
            if (!old) return res.status(404).json({ error: 'Not found' });
            const isBase = BASE_DIVISION_CODES.has(code);

            // 변경 가능 필드 결정
            const newLabel = (label_ko !== undefined && label_ko !== null && String(label_ko).trim()) ? String(label_ko).trim() : old.label_ko;
            const newSort = (sort_order !== undefined && Number.isFinite(parseInt(sort_order, 10))) ? parseInt(sort_order, 10) : old.sort_order;
            let newGender = old.gender;
            let newLevel = old.school_level;
            let newActive = old.active;

            if (!isBase) {
                if (gender !== undefined) {
                    if (!['M','F','X'].includes(gender)) return res.status(400).json({ error: 'gender는 M/F/X 중 하나' });
                    newGender = gender;
                }
                if (school_level !== undefined) {
                    const validLevels = ['OPEN','ELEM','MID','HIGH','UNIV','GEN','MIXED'];
                    if (!validLevels.includes(school_level)) return res.status(400).json({ error: 'school_level은 ' + validLevels.join('/') + ' 중 하나' });
                    newLevel = school_level;
                }
                if (active !== undefined) newActive = active ? 1 : 0;
            }
            let newGrade = old.grade == null ? null : old.grade;
            if (grade !== undefined) {
                newGrade = grade == null || grade === '' ? null : parseInt(grade, 10);
                if (newGrade != null && !(newGrade >= 1 && newGrade <= 6)) return res.status(400).json({ error: 'grade는 1~6' });
            }

            await db.run(
                'UPDATE division_master SET label_ko=?, gender=?, school_level=?, sort_order=?, active=?, grade=? WHERE code=?',
                newLabel, newGender, newLevel, newSort, newActive, newGrade, code
            );
            const row = await db.get('SELECT code, label_ko, gender, school_level, sort_order, active, created_at, grade FROM division_master WHERE code=?', code);
            opLog(`부 수정: ${code} (${newLabel})`, 'admin', 'admin');
            res.json({ ...row, is_base: isBase });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // DELETE division (admin only). 기본 13부는 삭제 차단. 커스텀 부는 사용 중이면 force 필요.
    app.delete('/api/admin/divisions/:code', async (req, res) => {
        try {
            const { admin_key, force, hard } = req.body || {};
            if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
            const code = req.params.code;
            if (BASE_DIVISION_CODES.has(code)) return res.status(400).json({ error: '기본 부(13부·학년부 20부)는 삭제할 수 없습니다. 비활성으로 바꾸세요.' });
            const old = await db.get('SELECT * FROM division_master WHERE code=?', code);
            if (!old) return res.status(404).json({ error: 'Not found' });

            // 사용 중인 종목/기록 카운트 (SQLite/PG 양쪽 호환)
            let eventCnt = null, recCnt = null;
            try { eventCnt = await db.get('SELECT COUNT(*) AS c FROM event WHERE division=?', code); } catch(_) {}
            try { recCnt = await db.get('SELECT COUNT(*) AS c FROM event_record WHERE division_code=?', code); } catch(_) {}
            const usedEvents = eventCnt?.c || 0;
            const usedRecords = recCnt?.c || 0;

            if ((usedEvents > 0 || usedRecords > 0) && !force) {
                return res.status(409).json({
                    error: '사용 중인 부입니다.',
                    needs_force: true,
                    used_events: usedEvents,
                    used_records: usedRecords,
                    message: `종목 ${usedEvents}개, 기록 ${usedRecords}개에서 사용 중입니다. 강제 삭제하려면 force=true로 다시 요청하세요.`
                });
            }

            if (hard && usedEvents === 0 && usedRecords === 0) {
                await db.run('DELETE FROM division_master WHERE code=?', code);
                opLog(`부 완전 삭제: ${code} (${old.label_ko})`, 'admin', 'admin');
                res.json({ success: true, deleted: 'hard', code });
            } else {
                // 기본 동작: soft delete (active=0). 종목/기록의 division 값은 그대로 유지 (보존).
                await db.run('UPDATE division_master SET active=0 WHERE code=?', code);
                opLog(`부 비활성화: ${code} (${old.label_ko}) — 사용 종목 ${usedEvents}, 기록 ${usedRecords}건`, 'admin', 'admin');
                res.json({ success: true, deleted: 'soft', code, used_events: usedEvents, used_records: usedRecords });
            }
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
};
