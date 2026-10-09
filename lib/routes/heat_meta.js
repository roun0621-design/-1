'use strict';
/**
 * 조 풍속·이름·전광판 키, 라이브 결과, 높이 시도 저장/삭제 — server.js 에서 이동 (2026-09-22, Phase 4 분해). 동작은 인라인 시절과 같다.
 *   deps: _resultsRoutes, broadcastSSE, db, isAdminKey, isOperationKey, opLog, orderByBibSql, parseDbTimestampMs, requireAdminAfterCompEnd
 */
module.exports = function mountHeatMetaRoutes(app, deps) {
    const { _resultsRoutes, broadcastSSE, db, isAdminKey, isOperationKey, opLog, orderByBibSql, parseDbTimestampMs, requireAdminAfterCompEnd } = deps;
    for (const k of ["_resultsRoutes","broadcastSSE","db","isAdminKey","isOperationKey","opLog","orderByBibSql","parseDbTimestampMs","requireAdminAfterCompEnd"]) if (deps[k] === undefined) throw new Error('[heat_meta.js] mount requires deps.' + k);

    // ============================================================
    app.post('/api/heats/:id/wind', async (req, res) => {
        const { wind, offline_input_at } = req.body;
        const heat = await db.get('SELECT * FROM heat WHERE id=?', req.params.id);
        if (!heat) return res.status(404).json({ error: 'Heat not found' });
        // 오프라인 재전송: 그 사이 다른 기기가 풍속을 바꿨으면 옛 값으로 덮지 않는다 (기록 입력과 같은 규칙)
        if (offline_input_at && heat.wind_updated_at) {
            const serverMs = parseDbTimestampMs(heat.wind_updated_at), offMs = Number(offline_input_at);
            if (Number.isFinite(serverMs) && Number.isFinite(offMs) && serverMs > offMs) {
                return res.status(409).json({ error: 'CONFLICT_NEWER_ON_SERVER', message: '운영진이 그 사이에 풍속을 갱신했습니다. 오프라인 입력값은 적용되지 않았습니다.', server_value: { wind: heat.wind, updated_at: heat.wind_updated_at }, rejected_offline_value: { wind, offline_input_at } });
            }
        }
        // Store as "N.N m/s" text format for scoreboard system compatibility
        let windValue = null;
        if (wind != null && wind !== '') {
            const v = parseFloat(wind);
            if (!isNaN(v)) windValue = v.toFixed(1) + ' m/s';
        }
        await db.run(`UPDATE heat SET wind=?, wind_updated_at=${db.isAsync ? 'NOW()' : "datetime('now')"} WHERE id=?`, windValue, heat.id);
        broadcastSSE('wind_update', { heat_id: heat.id, wind: windValue });
        // 풍속이 바뀌면 이 조의 신기록 판정을 다시 (추풍이면 대기 중 감지 제거, 허용 풍속이면 재감지)
        let recheck = null;
        try { recheck = await _resultsRoutes.reevaluateHeatRecords(heat.id); } catch (e) { console.error('[wind] 신기록 재판정 실패:', e && e.message); }
        res.json({ success: true, wind: windValue, record_recheck: recheck });
    });
    app.get('/api/heats/:id/wind', async (req, res) => {
        const heat = await db.get('SELECT * FROM heat WHERE id=?', req.params.id);
        if (!heat) return res.status(404).json({ error: 'Heat not found' });
        res.json({ heat_id: heat.id, wind: heat.wind });
    });

    // Rename heat (custom display name)
    app.post('/api/heats/:id/rename', async (req, res) => {
        const key = req.body.admin_key || req.headers['x-admin-key'] || '';
        if (!isOperationKey(key)) return res.status(403).json({ error: '인증 필요' });
        const heat = await db.get('SELECT * FROM heat WHERE id=?', parseInt(req.params.id));
        if (!heat) return res.status(404).json({ error: 'Heat not found' });
        const heat_name = req.body.heat_name != null ? String(req.body.heat_name).trim() || null : null;

        // Also update scoreboard_key if provided in request, or regenerate from heat_name
        let scoreboard_key = heat.scoreboard_key; // keep existing by default
        if (req.body.scoreboard_key !== undefined) {
            // Explicit scoreboard_key override
            scoreboard_key = req.body.scoreboard_key ? String(req.body.scoreboard_key).trim() : null;
        } else if (heat_name && heat.scoreboard_key) {
            // Auto-update: replace the heat number suffix in scoreboard_key
            // e.g., scoreboard_key "남자실업부 100m 예선 1조" + heat_name "예선 3조" → "남자실업부 100m 예선 3조"
            // Extract heat number from heat_name if it contains "N조"
            const heatNameMatch = heat_name.match(/(\d+)\s*조/);
            if (heatNameMatch) {
                scoreboard_key = heat.scoreboard_key.replace(/\d+조$/, heatNameMatch[1] + '조');
            }
        }

        await db.run('UPDATE heat SET heat_name=?, scoreboard_key=? WHERE id=?', heat_name, scoreboard_key, heat.id);
        broadcastSSE('heat_update', { heat_id: heat.id, event_id: heat.event_id, heat_name, scoreboard_key });
        res.json({ success: true, heat_id: heat.id, heat_name, scoreboard_key });
    });

    // Update scoreboard_key directly
    app.post('/api/heats/:id/scoreboard-key', async (req, res) => {
        const key = req.body.admin_key || req.headers['x-admin-key'] || '';
        if (!isOperationKey(key)) return res.status(403).json({ error: '인증 필요' });
        const heat = await db.get('SELECT * FROM heat WHERE id=?', parseInt(req.params.id));
        if (!heat) return res.status(404).json({ error: 'Heat not found' });
        const scoreboard_key = req.body.scoreboard_key != null ? String(req.body.scoreboard_key).trim() || null : null;
        await db.run('UPDATE heat SET scoreboard_key=? WHERE id=?', scoreboard_key, heat.id);
        broadcastSSE('heat_update', { heat_id: heat.id, event_id: heat.event_id, scoreboard_key });
        res.json({ success: true, heat_id: heat.id, scoreboard_key });
    });

    // ============================================================
    // LIVE RESULTS API — for dashboard real-time view
    // ============================================================
    app.get('/api/events/:id/live-results', async (req, res) => {
        const event = await db.get('SELECT * FROM event WHERE id=?', req.params.id);
        if (!event) return res.status(404).json({ error: 'Event not found' });
        const heats = await db.all('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number', event.id);
        // Also load qualifications if available
        const quals = await db.all('SELECT * FROM qualification_selection WHERE event_id=? AND selected=1', event.id);
        const result = await Promise.all(heats.map(async h => {
            const entries = await db.all(`SELECT he.lane_number, he.sub_group, ee.id AS event_entry_id, ee.status, ee.manual_rank,
                   a.name, a.bib_number, a.team, a.name_alt, COALESCE(NULLIF(ee.personal_best,''), a.personal_best) AS personal_best, COALESCE(NULLIF(ee.season_best,''), a.season_best) AS season_best FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id
                   JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=? ORDER BY he.lane_number ASC, ${orderByBibSql('a.bib_number')}`, h.id);
            if (event.category === 'field_height') {
                return { ...h, entries, height_attempts: await db.all('SELECT * FROM height_attempt WHERE heat_id=? ORDER BY bar_height, event_entry_id, attempt_number', h.id) };
            }
            return { ...h, entries, results: await db.all('SELECT * FROM result WHERE heat_id=? ORDER BY event_entry_id, attempt_number', h.id) };
        }));
        // 명단이 아직 없는 조는 뺀다 (국제대회: 공식 일정엔 4조였다가 2조로 줄어드는 등) — 명단 있는 조가 하나라도 있을 때만
        const filled = result.filter(h => (h.entries || []).length > 0);
        res.json({ event, heats: filled.length ? filled : result, qualifications: quals });
    });

    // ============================================================
    // HEIGHT ATTEMPTS
    // ============================================================
    app.get('/api/height-attempts', async (req, res) => {
        if (!req.query.heat_id) return res.status(400).json({ error: 'heat_id required' });
        res.json(await db.all(`
            SELECT ha.*, a.name, a.bib_number, a.team
            FROM height_attempt ha JOIN event_entry ee ON ee.id=ha.event_entry_id
            JOIN athlete a ON a.id=ee.athlete_id
            WHERE ha.heat_id=? ORDER BY ha.bar_height, ha.event_entry_id, ha.attempt_number
        `, req.query.heat_id));
    });
    app.post('/api/height-attempts/save', async (req, res) => {
        const { heat_id, event_entry_id, bar_height, attempt_number, result_mark, admin_key, offline_input_at } = req.body;
        if (!heat_id || !event_entry_id || !bar_height || !attempt_number)
            return res.status(400).json({ error: 'heat_id, event_entry_id, bar_height, attempt_number required' });

        // Check if event is completed — require admin_key
        const _hHeat = await db.get('SELECT * FROM heat WHERE id=?', heat_id);
        if (_hHeat) {
            const _hEvt = await db.get('SELECT * FROM event WHERE id=?', _hHeat.event_id);
            // Post-competition lock
            if (_hEvt && await requireAdminAfterCompEnd(_hEvt.competition_id, admin_key, res)) return;
            if (_hEvt && _hEvt.round_status === 'completed' && !isAdminKey(admin_key) && !isOperationKey(admin_key))
                return res.status(403).json({ error: '완료된 경기의 기록 수정은 관리자 키가 필요합니다.' });
        }

        // Empty mark = delete the attempt (toggle back to empty)
        if (!result_mark || result_mark === '') {
            const existing = await db.get('SELECT * FROM height_attempt WHERE heat_id=? AND event_entry_id=? AND bar_height=? AND attempt_number=?', heat_id, event_entry_id, bar_height, attempt_number);
            if (existing) {
                await db.run('DELETE FROM height_attempt WHERE id=?', existing.id);
                broadcastSSE('height_update', { heat_id, event_entry_id, bar_height });
            }
            return res.json({ success: true, deleted: true });
        }

        // Normalize: accept both '-' and 'PASS' as pass mark, store as 'PASS' (DB constraint)
        let normalizedMark = result_mark;
        if (normalizedMark === '-') normalizedMark = 'PASS';
        // Auto-update round_status to in_progress when first height attempt is saved
        const heat = await db.get('SELECT * FROM heat WHERE id=?', heat_id);
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
            const existing = await db.get('SELECT * FROM height_attempt WHERE heat_id=? AND event_entry_id=? AND bar_height=? AND attempt_number=?', heat_id, event_entry_id, bar_height, attempt_number);
            if (existing) {
                // ─── 오프라인 동기화 충돌 감지 ─────────────────────────
                // PG/SQLite 양쪽 timestamp 텍스트 형식을 모두 안전하게 파싱 (parseDbTimestampMs)
                if (offline_input_at && existing.updated_at) {
                    const serverUpdatedMs = parseDbTimestampMs(existing.updated_at);
                    const offlineMs = Number(offline_input_at);
                    if (Number.isFinite(serverUpdatedMs) && Number.isFinite(offlineMs) && serverUpdatedMs > offlineMs) {
                        return res.status(409).json({
                            error: 'CONFLICT_NEWER_ON_SERVER',
                            message: '운영진이 그 사이에 기록을 갱신했습니다. 오프라인 입력값은 적용되지 않았습니다.',
                            server_value: { result_mark: existing.result_mark, updated_at: existing.updated_at },
                            rejected_offline_value: { result_mark, bar_height, attempt_number, offline_input_at }
                        });
                    }
                }
                const _nowFH = db.isAsync ? 'NOW()' : "datetime('now')";
                await db.run(`UPDATE height_attempt SET result_mark=?,updated_at=${_nowFH} WHERE id=?`, normalizedMark, existing.id);
                const upd = await db.get('SELECT * FROM height_attempt WHERE id=?', existing.id);
                broadcastSSE('height_update', { heat_id, event_entry_id, bar_height });
                res.json(upd);
            } else {
                const info = await db.run('INSERT INTO height_attempt (heat_id,event_entry_id,bar_height,attempt_number,result_mark) VALUES (?,?,?,?,?)', heat_id, event_entry_id, bar_height, attempt_number, normalizedMark);
                const ins = await db.get('SELECT * FROM height_attempt WHERE id=?', info.lastInsertRowid);
                broadcastSSE('height_update', { heat_id, event_entry_id, bar_height });
                res.json(ins);
            }
        } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
    });

    // Delete all height attempts for a specific bar_height in a heat
    app.post('/api/height-attempts/delete-bar', async (req, res) => {
        const { heat_id, bar_height, admin_key } = req.body;
        if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
        if (!heat_id || bar_height == null) return res.status(400).json({ error: 'heat_id and bar_height required' });
        // Check if event is completed — require admin_key
        const _dbHeat = await db.get('SELECT * FROM heat WHERE id=?', heat_id);
        if (_dbHeat) {
            const _dbEvt = await db.get('SELECT * FROM event WHERE id=?', _dbHeat.event_id);
            if (_dbEvt && _dbEvt.round_status === 'completed' && !isAdminKey(admin_key) && !isOperationKey(admin_key))
                return res.status(403).json({ error: '완료된 경기의 기록 삭제는 관리자 키가 필요합니다.' });
        }
        const deleted = await db.run('DELETE FROM height_attempt WHERE heat_id=? AND bar_height=?', heat_id, parseFloat(bar_height));
        broadcastSSE('height_update', { heat_id, bar_height });
        res.json({ success: true, deleted: deleted.changes });
    });


    return {  };
};
