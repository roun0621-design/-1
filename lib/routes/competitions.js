/**
 * Competitions CRUD routes
 *
 * server.js 에서 추출됨 (2단계 모듈 분리 — 5차).
 * 외부 의존성: db, isAdminKey, isOperationKey, isAdminOrManager, opLog, broadcastSSE, kstNow
 *
 * 사용법:
 *   require('./lib/routes/competitions')(app, {
 *     db, isAdminKey, isOperationKey, isAdminOrManager, opLog, broadcastSSE, kstNow
 *   });
 *
 * 라우트 (9개):
 *   GET    /api/competitions                          전체 목록 + auto-status 업데이트
 *   GET    /api/competitions/recent                   현재 진행 윈도우(±3일) / window=all
 *   GET    /api/competitions/by-federation/:code      연맹 코드별
 *   GET    /api/competitions/:id                      단건
 *   POST   /api/competitions                          생성 (admin_key)
 *   PUT    /api/competitions/:id                      수정 (operation_key)
 *   POST   /api/admin/competitions/:id/close          종료 (admin_key)
 *   POST   /api/admin/competitions/:id/reopen         재개 (admin_key)
 *   DELETE /api/competitions/:id                      삭제 + 자동 백업 (admin/manager)
 *
 * ⚠️ 라우트 순서 (Express path match) 매우 중요:
 *   /recent, /by-federation/:code 가 /:id 보다 먼저 등록되어야 함.
 *
 * 회귀 보호: tests/api/02_competitions.test.js (5 tests)
 */
module.exports = function mountCompetitionsRoutes(app, deps) {
    const { db, isAdminKey, isOperationKey, isAdminOrManager, opLog, broadcastSSE, kstNow } = deps;
    if (!app || !db || !isAdminKey || !isOperationKey || !isAdminOrManager || !opLog || !broadcastSSE || !kstNow) {
        throw new Error('[competitions.js] mount requires { db, isAdminKey, isOperationKey, isAdminOrManager, opLog, broadcastSSE, kstNow }');
    }

    // Auto-status update — upcoming→active→completed by date
    async function autoUpdateCompetitionStatus() {
        const today = kstNow().slice(0, 10); // YYYY-MM-DD (KST)
        // upcoming → active if start_date <= today
        await db.run("UPDATE competition SET status='active' WHERE status='upcoming' AND start_date <= ?", today);
        // active → completed if end_date < today
        await db.run("UPDATE competition SET status='completed' WHERE status='active' AND end_date < ?", today);
    }

    app.get('/api/competitions', async (req, res) => {
        await autoUpdateCompetitionStatus();
        res.json(await db.all('SELECT * FROM competition ORDER BY start_date ASC'));
    });

    // Competitions within 2 weeks (for home top section) — MUST be before /:id
    // 노출 정책:
    //  - 기본(?window=active): "현재 진행중 대회 기준 ±3일" 윈도우
    //      · 진행중(active) 대회의 [start_date - 3일, end_date + 3일] 안에 걸치는 대회
    //      · 진행중 대회가 없으면 fallback으로 오늘 ±3일 윈도우 사용
    //  - ?window=all: 전체 대회 (펼침 모드)
    app.get('/api/competitions/recent', async (req, res) => {
        const window = (req.query.window || 'active').toLowerCase();

        if (window === 'all') {
            // 전체 대회 (펼침 탭에서 사용) — status 우선, 시작일 내림차순
            const rows = await db.all(`
                SELECT * FROM competition
                ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'upcoming' THEN 1 WHEN 'completed' THEN 2 ELSE 3 END,
                         start_date DESC
            `);
            return res.json(rows);
        }

        // active 윈도우: 진행중 대회 기준 ±3일
        const today = new Date().toISOString().slice(0, 10);
        const addDays = (dateStr, n) => {
            const d = new Date(dateStr + 'T00:00:00');
            d.setDate(d.getDate() + n);
            return d.toISOString().slice(0, 10);
        };

        const activeComps = await db.all(`SELECT start_date, end_date FROM competition WHERE status='active'`);

        let winStart, winEnd;
        if (activeComps.length > 0) {
            const starts = activeComps.map(c => c.start_date).filter(Boolean).sort();
            const ends = activeComps.map(c => c.end_date).filter(Boolean).sort();
            winStart = addDays(starts[0], -3);
            winEnd = addDays(ends[ends.length - 1], 3);
        } else {
            // fallback: 오늘 ±3일
            winStart = addDays(today, -3);
            winEnd = addDays(today, 3);
        }

        const rows = await db.all(`
            SELECT * FROM competition
            WHERE status = 'active'
               OR (end_date >= ? AND start_date <= ?)
            ORDER BY CASE WHEN status='active' THEN 0 ELSE 1 END, start_date DESC
        `, winStart, winEnd);
        res.json({ window: { start: winStart, end: winEnd, mode: 'active' }, items: rows });
    });

    // Competitions by federation — MUST be before /:id
    app.get('/api/competitions/by-federation/:code', async (req, res) => {
        const rows = await db.all('SELECT * FROM competition WHERE federation=? ORDER BY start_date DESC', req.params.code);
        res.json(rows);
    });

    app.get('/api/competitions/:id', async (req, res) => {
        const c = await db.get('SELECT * FROM competition WHERE id=?', req.params.id);
        if (!c) return res.status(404).json({ error: 'Not found' });
        res.json(c);
    });

    app.post('/api/competitions', async (req, res) => {
        const { admin_key, name, start_date, end_date, venue, federation, mode, division_type, video_url, series_id } = req.body;
        if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        if (!name || !start_date || !end_date) return res.status(400).json({ error: '대회명, 시작일, 종료일은 필수입니다.' });
        const compMode = (mode === 'display') ? 'display' : 'operation';
        const allowedDivisions = ['','pro','univ','high','middle','general'];
        const divType = allowedDivisions.includes(division_type) ? division_type : '';
        // series_id: 빈 문자열/0/null/undefined → NULL, 그 외 정수면 사용
        let sId = null;
        if (series_id !== undefined && series_id !== null && series_id !== '' && series_id !== 0) {
            const parsed = parseInt(series_id, 10);
            if (!isNaN(parsed) && parsed > 0) {
                // 실존 시리즈 검증 (선택사항이지만 데이터 정합성을 위해)
                try {
                    const s = await db.get('SELECT id FROM competition_series WHERE id=? AND active=1', parsed);
                    if (s) sId = parsed;
                } catch(e) {}
            }
        }
        try {
            const info = await db.run(
                'INSERT INTO competition (name,start_date,end_date,venue,federation,mode,division_type,video_url,series_id) VALUES (?,?,?,?,?,?,?,?,?)',
                name, start_date, end_date, venue || '', federation || '', compMode, divType, video_url || '', sId
            );
            const comp = await db.get('SELECT * FROM competition WHERE id=?', info.lastInsertRowid);
            opLog(`대회 생성: ${name} (${compMode === 'display' ? '노출용' : '운영용'})${sId ? ' [시리즈 연결]' : ''}`, 'admin', 'admin', comp.id);
            res.json(comp);
        } catch (e) { res.status(400).json({ error: '대회 생성 실패: ' + e.message }); }
    });

    app.put('/api/competitions/:id', async (req, res) => {
        const { admin_key, name, start_date, end_date, venue, status, video_url, federation, division_type, mode, series_id } = req.body;
        if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
        const old = await db.get('SELECT * FROM competition WHERE id=?', req.params.id);
        if (!old) return res.status(404).json({ error: 'Not found' });
        const compMode = mode ? ((mode === 'display') ? 'display' : 'operation') : old.mode;
        // series_id 처리: undefined → 기존값 유지, null/''/0 → NULL로 해제, 정수 → 검증 후 설정
        let sId = old.series_id ?? null;
        if (series_id !== undefined) {
            if (series_id === null || series_id === '' || series_id === 0) {
                sId = null;
            } else {
                const parsed = parseInt(series_id, 10);
                if (!isNaN(parsed) && parsed > 0) {
                    try {
                        const s = await db.get('SELECT id FROM competition_series WHERE id=? AND active=1', parsed);
                        sId = s ? parsed : sId;
                    } catch(e) {}
                }
            }
        }
        await db.run('UPDATE competition SET name=?,start_date=?,end_date=?,venue=?,status=?,video_url=?,federation=?,division_type=?,mode=?,series_id=? WHERE id=?',
            name||old.name, start_date||old.start_date, end_date||old.end_date,
            venue??old.venue, status||old.status, video_url??old.video_url??'',
            federation??old.federation??'', division_type??old.division_type??'',
            compMode||'operation', sId, old.id);
        res.json(await db.get('SELECT * FROM competition WHERE id=?', old.id));
    });

    // ------------------------------------------------------------
    // 대회 종료/재개 — 관리자 전용
    // 종료(status='completed') 시 글로벌 쓰기 가드(requireAdminAfterCompEnd)가
    // 운영자/녹화관 키의 모든 쓰기를 차단 → 뷰어모드로 전환됨.
    // ------------------------------------------------------------
    app.post('/api/admin/competitions/:id/close', async (req, res) => {
        const { admin_key } = req.body || {};
        if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        const comp = await db.get('SELECT * FROM competition WHERE id=?', req.params.id);
        if (!comp) return res.status(404).json({ error: 'Not found' });
        if (comp.status === 'completed') {
            return res.json({ success: true, already_closed: true, status: 'completed' });
        }
        await db.run("UPDATE competition SET status='completed' WHERE id=?", comp.id);
        try { opLog(`대회 종료: ${comp.name}`, 'admin', 'admin', comp.id); } catch(e) {}
        broadcastSSE('competition_status', { competition_id: comp.id, status: 'completed' });
        res.json({ success: true, status: 'completed', competition: await db.get('SELECT * FROM competition WHERE id=?', comp.id) });
    });

    app.post('/api/admin/competitions/:id/reopen', async (req, res) => {
        const { admin_key } = req.body || {};
        if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        const comp = await db.get('SELECT * FROM competition WHERE id=?', req.params.id);
        if (!comp) return res.status(404).json({ error: 'Not found' });
        // 시작/종료일과 오늘을 비교해 'upcoming' 또는 'active' 로 자동 결정
        // (DB CHECK 제약: status IN ('upcoming','active','completed'))
        const today = kstNow().slice(0, 10);
        let newStatus = 'active';
        if (comp.start_date && comp.start_date > today) newStatus = 'upcoming';
        await db.run('UPDATE competition SET status=? WHERE id=?', newStatus, comp.id);
        try { opLog(`대회 재개: ${comp.name} → ${newStatus}`, 'admin', 'admin', comp.id); } catch(e) {}
        broadcastSSE('competition_status', { competition_id: comp.id, status: newStatus });
        res.json({ success: true, status: newStatus, competition: await db.get('SELECT * FROM competition WHERE id=?', comp.id) });
    });

    app.delete('/api/competitions/:id', async (req, res) => {
        const { admin_key } = req.body;
        if (!isAdminOrManager(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        const comp = await db.get('SELECT * FROM competition WHERE id=?', req.params.id);
        if (!comp) return res.status(404).json({ error: 'Not found' });

        // 삭제 전 자동 백업 (트랜잭션 시작 전 — 실제 백업은 삭제 직전 DB를 복사해야 의미가 있음)
        try {
            const path = require('path');
            const fs = require('fs');
            const projectRoot = path.join(__dirname, '..', '..'); // lib/routes/competitions.js → 프로젝트 루트
            const backupDir = path.join(projectRoot, 'backups');
            if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir);
            const safeName = (comp.name || 'comp').replace(/[\/\\:*?"<>|]/g, '_');
            const backupName = `deleted_${safeName}_${new Date().toISOString().replace(/[:.]/g,'-')}.db`;
            const dbPath = process.env.SQLITE_PATH || path.join(projectRoot, 'db/competition.db');
            fs.copyFileSync(dbPath, path.join(backupDir, backupName));
            console.log(`[Backup] 삭제 전 백업 완료: ${backupName}`);
        } catch(e) { console.error('[Backup] 삭제 전 백업 실패:', e.message); }

        // 안전 헬퍼: 테이블/컬럼이 존재할 때만 DELETE 실행 (스키마 다변화 대비)
        // lib/db.js 메타 헬퍼 사용 — 양 백엔드 호환 (SQLite=sqlite_master/PRAGMA, PG=information_schema)
        const tableExists = (name) => db.tableExists(name);
        const hasColumn = (table, col) => db.columnExists(table, col);
        const safeRun = async (sql, ...args) => {
            try { return await db.run(sql, ...args); }
            catch(e){ console.warn('[delete-comp] skip:', sql.split('\n')[0].trim(), '|', e.message); return null; }
        };

        try {
            await db.transaction(async () => {
                const events = await db.all('SELECT id FROM event WHERE competition_id=?', comp.id);

                for (const evt of events) {
                    const heats = await db.all('SELECT id FROM heat WHERE event_id=?', evt.id);
                    for (const h of heats) {
                        safeRun('DELETE FROM result WHERE heat_id=?', h.id);
                        safeRun('DELETE FROM height_attempt WHERE heat_id=?', h.id);
                        safeRun('DELETE FROM heat_entry WHERE heat_id=?', h.id);
                    }
                    safeRun('DELETE FROM heat WHERE event_id=?', evt.id);
                    safeRun('DELETE FROM relay_member WHERE event_entry_id IN (SELECT id FROM event_entry WHERE event_id=?)', evt.id);
                    safeRun('DELETE FROM combined_score WHERE event_entry_id IN (SELECT id FROM event_entry WHERE event_id=?)', evt.id);
                    safeRun('DELETE FROM qualification_selection WHERE event_id=?', evt.id);
                    safeRun('DELETE FROM event_entry WHERE event_id=?', evt.id);
                    // event_id 직접 참조 테이블들 (신규 추가 포함)
                    if (tableExists('event_records')) safeRun('DELETE FROM event_records WHERE event_id=?', evt.id);
                    if (tableExists('event_link'))    safeRun('DELETE FROM event_link WHERE event_id_a=? OR event_id_b=?', evt.id, evt.id);
                    if (tableExists('joint_group_member') && hasColumn('joint_group_member','event_id'))
                        safeRun('DELETE FROM joint_group_member WHERE event_id=?', evt.id);
                }

                // pacing 트리: pacing_config(competition_id) → pacing_color(pacing_config_id) → pacing_segment(pacing_color_id)
                if (tableExists('pacing_config')) {
                    const cfgs = await db.all('SELECT id FROM pacing_config WHERE competition_id=?', comp.id);
                    for (const cfg of cfgs) {
                        if (tableExists('pacing_color')) {
                            const colors = await db.all('SELECT id FROM pacing_color WHERE pacing_config_id=?', cfg.id);
                            for (const c of colors) {
                                if (tableExists('pacing_segment')) safeRun('DELETE FROM pacing_segment WHERE pacing_color_id=?', c.id);
                            }
                            safeRun('DELETE FROM pacing_color WHERE pacing_config_id=?', cfg.id);
                        }
                    }
                    safeRun('DELETE FROM pacing_config WHERE competition_id=?', comp.id);
                }

                // competition_id 직접 참조 테이블 일괄 정리
                const compIdTables = [
                    'event', 'athlete', 'audit_log', 'operation_log',
                    'display_roster', 'timetable', 'doc_template',
                    'external_api_log', 'joint_group_member'
                ];
                for (const t of compIdTables) {
                    if (tableExists(t) && hasColumn(t, 'competition_id')) {
                        safeRun(`DELETE FROM ${t} WHERE competition_id=?`, comp.id);
                    }
                }

                // 마지막에 대회 본체 삭제
                safeRun('DELETE FROM competition WHERE id=?', comp.id);
            })();

            // ⭐ 대회 삭제 후 UNIQUE INDEX 재시도
            //    (이전에 중복 데이터로 인해 인덱스 생성이 실패했더라도, 삭제 후엔 성공할 수 있음)
            try {
                db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_event_top_level ON event(competition_id, name, gender, round_type) WHERE parent_event_id IS NULL`);
                console.log('[delete-comp] ux_event_top_level UNIQUE 인덱스 생성/확인 (대회 삭제 후 재시도)');
            } catch(e) {
                // 다른 대회에 여전히 중복이 있을 수 있음 — 경고만
                console.warn('[delete-comp] ux_event_top_level 재생성 실패:', e.message);
            }
            try {
                db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_athlete_per_competition ON athlete(competition_id, name, team, gender)`);
            } catch(e) {
                console.warn('[delete-comp] ux_athlete_per_competition 재생성 실패:', e.message);
            }

            return res.json({ success: true });
        } catch(e) {
            console.error('[delete-comp] 트랜잭션 실패:', e.message, e.stack);
            return res.status(500).json({ error: '대회 삭제 중 오류: ' + e.message });
        }
    });
};
