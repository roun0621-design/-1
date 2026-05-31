/**
 * Pacing Light routes (페이싱 라이트)
 *
 * server.js 에서 추출됨 (2단계 모듈 분리 — 3차).
 * 외부 의존성: db, isOperationKey, opLog, getJudgeName, broadcastSSE
 *
 * 사용법:
 *   require('./lib/routes/pacing')(app, { db, isOperationKey, opLog, getJudgeName, broadcastSSE });
 *
 * 라우트 (4개):
 *   GET    /api/pacing                  (competition_id 별 전체 설정)
 *   GET    /api/pacing/:id              (단일 설정)
 *   POST   /api/pacing                  (upsert — 인증 필요)
 *   DELETE /api/pacing/:id              (삭제 — 인증 필요)
 *
 * ⚠️ 주의:
 *   - POST 라우트의 'datetime(\'now\')' 는 SQLite 전용. PG 환경에서는 NOW() 로
 *     변환되어야 하지만 현재 server.js 와 동일하게 유지 (추후 별도 패치).
 */
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
