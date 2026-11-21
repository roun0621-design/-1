/**
 * Pacing Light routes (페이싱 라이트)
 *
 * server.js 에서 추출됨 (2단계 모듈 분리 — 3차).
 * 외부 의존성: db, isOperationKey, opLog, getJudgeName, broadcastSSE
 *
 * 사용법:
 *   require('./lib/routes/pacing')(app, { db, isOperationKey, opLog, getJudgeName, broadcastSSE });
 *
 * 라우트 (6개):
 *   GET    /api/pacing                  (competition_id 별 전체 설정)
 *   GET    /api/pacing/wavelight.zip    (대회 전체 WaveLight 파일 묶음 — competition_id)
 *   GET    /api/pacing/wavelight.json   (에이전트용 — 대회 전체 파일 내용 + 컨트롤러에 보낼 값, scripts/wavelight-agent)
 *   GET    /api/pacing/:id              (단일 설정)
 *   GET    /api/pacing/:id/wavelight    (WaveLight 파일: ?list=1 목록 · ?color=green 파일 하나(.pc2) · 없으면 그 종목 묶음(zip))
 *   POST   /api/pacing                  (upsert — 인증 필요)
 *   DELETE /api/pacing/:id              (삭제 — 인증 필요)
 *
 * ⚠️ 주의:
 *   - POST 라우트의 'datetime(\'now\')' 는 SQLite 전용. PG 환경에서는 NOW() 로
 *     변환되어야 하지만 현재 server.js 와 동일하게 유지 (추후 별도 패치).
 */
const PacingExport = require('../pacingExport');

module.exports = function mountPacingRoutes(app, deps) {
    const { db, isOperationKey, opLog, getJudgeName, broadcastSSE } = deps;
    if (!app || !db || !isOperationKey || !opLog || !getJudgeName || !broadcastSSE) {
        throw new Error('[pacing.js] mount requires { db, isOperationKey, opLog, getJudgeName, broadcastSSE }');
    }

    // GET all pacing configs for a competition
    app.get('/api/pacing', async (req, res) => {
        const compId = parseInt(req.query.competition_id) || null;
        if (!compId) return res.status(400).json({ error: 'competition_id required' });
        const configs = await db.all(
            'SELECT * FROM pacing_config WHERE competition_id=? ORDER BY event_name',
            compId
        );
        const result = [];
        for (const cfg of configs) {
            const colors = await db.all(
                'SELECT * FROM pacing_color WHERE pacing_config_id=? ORDER BY sort_order',
                cfg.id
            );
            for (const c of colors) {
                c.segments = await db.all(
                    'SELECT * FROM pacing_segment WHERE pacing_color_id=? ORDER BY segment_order',
                    c.id
                );
            }
            result.push({ ...cfg, colors });
        }
        res.json(result);
    });

    // ── WaveLight 시스템 파일(.pc2) 내려받기 (lib/pacingExport.js) ──
    //   색 한 줄 = 파일 하나. 파일 이름은 영문: <종목>_<성별>[_<부>]_<기록>_<색>.pc2
    //   설정 조회(GET)와 같은 공개 범위 — 내용이 대시보드 Target 팝업에 이미 공개돼 있다.
    async function loadConfig(cfg) {
        const colors = await db.all('SELECT * FROM pacing_color WHERE pacing_config_id=? ORDER BY sort_order', cfg.id);
        for (const c of colors) {
            c.segments = await db.all('SELECT * FROM pacing_segment WHERE pacing_color_id=? ORDER BY segment_order', c.id);
        }
        return { ...cfg, colors };
    }
    // 키에 부가 없는 설정('800m (남)')은, 그 종목·성별의 부가 대회에 하나뿐이면 그 부를 파일 이름에 쓴다
    async function soleDivision(cfg) {
        const k = PacingExport.parsePacingKey(cfg.event_name);
        if (k.division || !k.gender) return '';
        const rows = await db.all(
            "SELECT DISTINCT division FROM event WHERE competition_id=? AND name=? AND gender=? AND parent_event_id IS NULL AND division IS NOT NULL AND division<>''",
            cfg.competition_id, k.name, k.gender
        );
        return rows.length === 1 ? rows[0].division : '';
    }
    function sendZip(res, zipName, files) {
        const AdmZip = require('adm-zip');
        const zip = new AdmZip();
        for (const f of files) zip.addFile(f.filename, Buffer.from(f.content, 'utf8'));
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
        res.send(zip.toBuffer());
    }

    // 대회 전체 묶음 — '/api/pacing/:id' 보다 먼저 등록
    app.get('/api/pacing/wavelight.zip', async (req, res) => {
        const compId = parseInt(req.query.competition_id) || null;
        if (!compId) return res.status(400).json({ error: 'competition_id required' });
        const configs = await db.all('SELECT * FROM pacing_config WHERE competition_id=? ORDER BY event_name', compId);
        const files = []; let used;
        for (const cfg of configs) {
            const r = PacingExport.buildFiles(await loadConfig(cfg), { division: await soleDivision(cfg), usedNames: used });
            used = r.usedNames; files.push(...r.files);
        }
        if (!files.length) return res.status(404).json({ error: '내려받을 페이싱 설정이 없습니다' });
        sendZip(res, `WaveLight_comp${compId}.zip`, files);
    });

    // 에이전트용(scripts/wavelight-agent) — 종목마다 파일 내용과 컨트롤러에 그대로 보낼 값(색 번호·출발선 조명·구간)을 한 번에.
    //   rev 는 내용의 지문 — 에이전트가 바뀐 것만 다시 쓴다.
    app.get('/api/pacing/wavelight.json', async (req, res) => {
        const compId = parseInt(req.query.competition_id) || null;
        if (!compId) return res.status(400).json({ error: 'competition_id required' });
        const comp = await db.get('SELECT id, name FROM competition WHERE id=?', compId);
        if (!comp) return res.status(404).json({ error: 'not found' });
        const configs = await db.all('SELECT * FROM pacing_config WHERE competition_id=? ORDER BY event_name', compId);
        const events = []; let used;
        for (const cfg of configs) {
            const division = await soleDivision(cfg);
            const r = PacingExport.buildFiles(await loadConfig(cfg), { division, usedNames: used });
            used = r.usedNames;
            const k = PacingExport.parsePacingKey(cfg.event_name);
            events.push({
                id: cfg.id, event_name: cfg.event_name, name: k.name, gender: k.gender, division: k.division || division,
                label: [PacingExport.eventToken(k.name), PacingExport.GENDER_EN[k.gender] || '', PacingExport.divisionToken(k.division || division)].filter(Boolean).join(' '),
                files: r.files, skipped: r.skipped,
            });
        }
        const rev = require('crypto').createHash('sha1').update(JSON.stringify(events)).digest('hex').slice(0, 12);
        // 경기 진행 상태(콘솔용) — 그 설정에 해당하는 종목 라운드의 상태·시작 시각. rev(파일 지문)에는 넣지 않는다.
        //   round_status: created · heats_generated(예정) → in_progress(소집 완료~경기 중) → completed
        const rows = await db.all('SELECT id, name, gender, division, round_type, round_status FROM event WHERE competition_id=? AND parent_event_id IS NULL ORDER BY sort_order, id', compId);
        const tt = await db.all('SELECT event_id, time, scheduled_date FROM timetable WHERE competition_id=? AND event_id IS NOT NULL ORDER BY scheduled_date, time', compId);
        const when = new Map();
        for (const t of tt) if (!when.has(Number(t.event_id))) when.set(Number(t.event_id), t);
        for (const ev of events) {
            const k = PacingExport.parsePacingKey(ev.event_name);
            ev.rounds = rows.filter(r => r.name === k.name && (!k.gender || r.gender === k.gender) && (!k.division || r.division === k.division)).map(r => {
                const t = when.get(Number(r.id));
                return { event_id: r.id, round_type: r.round_type, division: r.division || '', status: r.round_status, time: t ? t.time : null, date: t ? t.scheduled_date : null };
            });
        }
        res.json({ competition_id: compId, competition_name: comp.name, rev, events });
    });

    app.get('/api/pacing/:id/wavelight', async (req, res) => {
        const row = await db.get('SELECT * FROM pacing_config WHERE id=?', parseInt(req.params.id));
        if (!row) return res.status(404).json({ error: 'not found' });
        const cfg = await loadConfig(row);
        const { files, skipped } = PacingExport.buildFiles(cfg, { division: await soleDivision(row) });
        if (req.query.list) {
            return res.json({
                event_name: row.event_name,
                files: files.map(f => ({ color_key: f.color_key, filename: f.filename, total_seconds: f.total_seconds, steps: f.steps, converted: f.converted, notes: f.notes })),
                skipped,
            });
        }
        if (req.query.color) {
            const f = files.find(x => x.color_key === String(req.query.color));
            if (!f) return res.status(404).json({ error: '그 색의 랩타임이 비어 있습니다' });
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Disposition', `attachment; filename="${f.filename}"`);
            return res.send(Buffer.from(f.content, 'utf8'));
        }
        if (!files.length) return res.status(404).json({ error: '랩타임이 입력된 색이 없습니다' });
        const k = PacingExport.parsePacingKey(row.event_name);
        const zipName = ['WaveLight', PacingExport.eventToken(k.name), PacingExport.GENDER_EN[k.gender] || '', PacingExport.divisionToken(k.division)].filter(Boolean).join('_') + '.zip';
        sendZip(res, zipName, files);
    });

    // GET single pacing config by id
    app.get('/api/pacing/:id', async (req, res) => {
        const cfg = await db.get('SELECT * FROM pacing_config WHERE id=?', parseInt(req.params.id));
        if (!cfg) return res.status(404).json({ error: 'not found' });
        const colors = await db.all(
            'SELECT * FROM pacing_color WHERE pacing_config_id=? ORDER BY sort_order',
            cfg.id
        );
        for (const c of colors) {
            c.segments = await db.all(
                'SELECT * FROM pacing_segment WHERE pacing_color_id=? ORDER BY segment_order',
                c.id
            );
        }
        res.json({ ...cfg, colors });
    });

    // POST create or update full pacing config (upsert)
    // Body: { competition_id, event_name, notice, colors: [{ color_key, sort_order, remark, segments: [{ segment_order, distance_meters, lap_seconds }] }] }
    app.post('/api/pacing', async (req, res) => {
        const key = req.body.admin_key || req.headers['x-admin-key'] || '';
        if (!isOperationKey(key)) return res.status(403).json({ error: '인증 필요' });
        const { competition_id, event_name, notice, colors } = req.body;
        if (!competition_id || !event_name) {
            return res.status(400).json({ error: 'competition_id and event_name required' });
        }

        const trx = db.transaction(async () => {
            // Upsert pacing_config
            let cfg = await db.get(
                'SELECT id FROM pacing_config WHERE competition_id=? AND event_name=?',
                competition_id, event_name
            );
            if (cfg) {
                await db.run(
                    "UPDATE pacing_config SET notice=?, updated_at=datetime('now') WHERE id=?",
                    notice || '', cfg.id
                );
            } else {
                const r = await db.run(
                    'INSERT INTO pacing_config (competition_id, event_name, notice) VALUES (?,?,?)',
                    competition_id, event_name, notice || ''
                );
                cfg = { id: r.lastInsertRowid };
            }
            // Delete old colors + segments (cascade)
            await db.run('DELETE FROM pacing_color WHERE pacing_config_id=?', cfg.id);
            // Insert colors + segments
            if (Array.isArray(colors)) {
                for (let ci = 0; ci < colors.length; ci++) {
                    const c = colors[ci];
                    const cr = await db.run(
                        'INSERT INTO pacing_color (pacing_config_id, color_key, sort_order, remark) VALUES (?,?,?,?)',
                        cfg.id, c.color_key, c.sort_order != null ? c.sort_order : ci, c.remark || ''
                    );
                    if (Array.isArray(c.segments)) {
                        for (let si = 0; si < c.segments.length; si++) {
                            const seg = c.segments[si];
                            await db.run(
                                'INSERT INTO pacing_segment (pacing_color_id, segment_order, distance_meters, lap_seconds) VALUES (?,?,?,?)',
                                cr.lastInsertRowid,
                                seg.segment_order != null ? seg.segment_order : si,
                                seg.distance_meters, seg.lap_seconds
                            );
                        }
                    }
                }
            }
            return cfg.id;
        });
        try {
            const cfgId = await trx();
            opLog(`페이싱 라이트 설정 저장: ${event_name}`, 'pacing', getJudgeName(key), competition_id);
            broadcastSSE('pacing_update', { competition_id, event_name });
            res.json({ ok: true, id: cfgId });
        } catch (e) {
            console.error('[Pacing Save Error]', e);
            res.status(500).json({ error: e.message });
        }
    });

    // DELETE pacing config
    app.delete('/api/pacing/:id', async (req, res) => {
        const key = req.body.admin_key || req.headers['x-admin-key'] || '';
        if (!isOperationKey(key)) return res.status(403).json({ error: '인증 필요' });
        const cfg = await db.get('SELECT * FROM pacing_config WHERE id=?', parseInt(req.params.id));
        if (!cfg) return res.status(404).json({ error: 'not found' });
        await db.run('DELETE FROM pacing_config WHERE id=?', cfg.id);
        opLog(`페이싱 라이트 삭제: ${cfg.event_name}`, 'pacing', getJudgeName(key), cfg.competition_id);
        broadcastSSE('pacing_update', { competition_id: cfg.competition_id });
        res.json({ ok: true });
    });
};
