'use strict';
/**
 * 국제대회 동기화 API (2026-09) — lib/intl/sync.js
 *   PUT  /api/admin/intl/:compId/source     동기화 출처 저장 { base, champ, disc, lang, referer, spotlight, enabled }
 *   POST /api/admin/intl/:compId/setup      일정 → 종목·조·시간표 (+ 엔트리)
 *   POST /api/admin/intl/:compId/sync       지금 동기화 (결과 · force=entries|structure)
 *   GET  /api/admin/intl/:compId/status     출처·마지막 상태
 *   GET  /api/admin/intl/:compId/probe      결과 API 한 조를 그대로 보여줌 (형식 확인용) ?key=<유닛키>
 *   스케줄러: 동기화가 켜진 대회를 60초마다 돌린다 (조 시각 전후 창 안의 조만 읽는다)
 */
const sync = require('../intl/sync');
const B = require('../intl/bornan');

module.exports = function mountIntlRoutes(app, deps) {
    const { db, isAdminKey, isOperationKey, opLog, broadcastSSE } = deps;   // deps.upload (multer) 는 선택
    const keyOf = req => String(req.headers['x-admin-key'] || (req.body && req.body.admin_key) || req.query.key || '');
    const onApplied = ({ event_id, heat_id }) => { try { broadcastSSE('result_update', { event_id, heat_id, source: 'intl-sync' }); } catch (e) {} };

    app.get('/api/admin/intl/:compId/status', async (req, res) => {
        if (!isOperationKey(keyOf(req))) return res.status(403).json({ error: '인증 키가 필요합니다.' });
        const comp = await db.get('SELECT id, name, sync_source, sync_state FROM competition WHERE id=?', req.params.compId);
        if (!comp) return res.status(404).json({ error: '대회를 찾을 수 없습니다.' });
        let source = null, state = null; try { source = JSON.parse(comp.sync_source || 'null'); } catch (e) {} try { state = JSON.parse(comp.sync_state || 'null'); } catch (e) {}
        const counts = {
            events: await db.get('SELECT COUNT(*) c FROM event WHERE competition_id=? AND external_key IS NOT NULL', comp.id),
            heats: await db.get('SELECT COUNT(*) c FROM heat h JOIN event e ON e.id=h.event_id WHERE e.competition_id=? AND h.external_key IS NOT NULL', comp.id),
            athletes: await db.get("SELECT COUNT(*) c FROM athlete WHERE competition_id=? AND barcode LIKE 'BN:%'", comp.id),
            results: await db.get('SELECT COUNT(*) c FROM result r JOIN heat h ON h.id=r.heat_id JOIN event e ON e.id=h.event_id WHERE e.competition_id=? AND h.external_key IS NOT NULL', comp.id),
        };
        res.json({ source, state, counts: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Number(v.c || 0)])), scheduler: _schedulerInfo() });
    });

    app.put('/api/admin/intl/:compId/source', async (req, res) => {
        if (!isAdminKey(keyOf(req))) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        const comp = await db.get('SELECT id FROM competition WHERE id=?', req.params.compId);
        if (!comp) return res.status(404).json({ error: '대회를 찾을 수 없습니다.' });
        const b = req.body || {};
        if (b.clear) { await db.run('UPDATE competition SET sync_source=NULL WHERE id=?', comp.id); return res.json({ success: true, source: null }); }
        const base = String(b.base || '').trim().replace(/\/$/, '');
        if (!/^https:\/\/[a-z0-9.-]+$/i.test(base)) return res.status(400).json({ error: 'base 는 https://호스트 형식이어야 합니다 (예: https://back.results.asiangames2026.org)' });
        const source = { provider: 'bornan', base, champ: String(b.champ || '').trim(), disc: String(b.disc || 'ATH').trim().toUpperCase(), lang: String(b.lang || 'en').trim(),
            referer: String(b.referer || '').trim() || undefined, spotlight: String(b.spotlight || '').trim().toUpperCase() || undefined, enabled: b.enabled !== false && b.enabled !== 'false' };
        if (!source.champ) return res.status(400).json({ error: '대회 코드(champ)가 필요합니다 (예: AG2026)' });
        await db.run('UPDATE competition SET sync_source=? WHERE id=?', JSON.stringify(source), comp.id);
        opLog(`국제대회 동기화 출처 설정: ${source.base} ${source.champ}/${source.disc}${source.enabled ? '' : ' (꺼짐)'}`, 'admin', 'admin', comp.id);
        res.json({ success: true, source });
    });

    app.post('/api/admin/intl/:compId/setup', async (req, res) => {
        if (!isAdminKey(keyOf(req))) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        const comp = await db.get('SELECT * FROM competition WHERE id=?', req.params.compId);
        if (!comp) return res.status(404).json({ error: '대회를 찾을 수 없습니다.' });
        if (!sync.parseSource(comp)) return res.status(400).json({ error: '동기화 출처를 먼저 저장하세요.' });
        try {
            const structure = await sync.setupStructure(db, comp);
            const entries = req.body && req.body.skip_entries ? null : await sync.syncEntries(db, comp);
            opLog(`국제대회 구조 생성: 종목 ${structure.events}개, 조 ${structure.stats.heats}개, 시간표 ${structure.stats.timetable}행${entries ? `, 선수 ${entries.athletes}명` : ''}`, 'admin', 'admin', comp.id);
            res.json({ success: true, structure, entries });
        } catch (e) { res.status(502).json({ error: '구조 생성 실패: ' + e.message }); }
    });

    app.post('/api/admin/intl/:compId/sync', async (req, res) => {
        if (!isOperationKey(keyOf(req))) return res.status(403).json({ error: '인증 키가 필요합니다.' });
        const comp = await db.get('SELECT * FROM competition WHERE id=?', req.params.compId);
        if (!comp) return res.status(404).json({ error: '대회를 찾을 수 없습니다.' });
        if (!sync.parseSource(comp)) return res.status(400).json({ error: '동기화 출처를 먼저 저장하세요.' });
        try {
            const force = req.body && req.body.force;
            const all = !!(req.body && req.body.all);
            const out = await sync.runOnce(db, comp, { force, all, onApplied });
            res.json({ success: true, ...out });
        } catch (e) { res.status(502).json({ error: '동기화 실패: ' + e.message }); }
    });

    // 선수 보조 정보(한글 이름·PB·SB) 올리기 — xlsx/csv(헤더: 영문이름|reg, 한글이름, PB, SB) 또는 JSON rows
    app.post('/api/admin/intl/:compId/athlete-info', deps.upload ? deps.upload.single('file') : (req, res, next) => next(), async (req, res) => {
        if (!isAdminKey(keyOf(req))) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        const comp = await db.get('SELECT id FROM competition WHERE id=?', req.params.compId);
        if (!comp) return res.status(404).json({ error: '대회를 찾을 수 없습니다.' });
        try {
            let rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : null;
            if (!rows && req.file) {
                const XLSX = require('xlsx'); const wb = XLSX.readFile(req.file.path); const ws = wb.Sheets[wb.SheetNames[0]];
                rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
                try { require('fs').unlinkSync(req.file.path); } catch (e) {}
            }
            if (!rows) return res.status(400).json({ error: '파일(xlsx/csv) 또는 rows 가 필요합니다.' });
            const st = await sync.applyAthleteInfo(db, comp.id, rows);
            opLog(`국제대회 선수 정보 반영: ${st.matched}명 (미매칭 ${st.unmatched.length})`, 'admin', 'admin', comp.id);
            res.json({ success: true, ...st });
        } catch (e) { res.status(400).json({ error: '반영 실패: ' + e.message }); }
    });

    app.get('/api/admin/intl/:compId/probe', async (req, res) => {
        if (!isOperationKey(keyOf(req))) return res.status(403).json({ error: '인증 키가 필요합니다.' });
        const comp = await db.get('SELECT * FROM competition WHERE id=?', req.params.compId);
        const source = comp && sync.parseSource(comp);
        if (!source) return res.status(400).json({ error: '동기화 출처가 없습니다.' });
        const tail = String(req.query.path || ('results/' + encodeURIComponent(String(req.query.unit || ''))));
        try { const json = await B.fetchJson(source, tail); res.json({ path: B.apiPath(source, tail), shape: B.describeResults(json), parsed: B.parseResults(json).rows.slice(0, 3), json }); }
        catch (e) { res.status(502).json({ error: e.message }); }
    });

    // ── 스케줄러 ──
    const _sched = { running: false, last_run: null, last_error: null, interval_ms: parseInt(process.env.INTL_SYNC_INTERVAL_MS || '60000', 10) };
    function _schedulerInfo() { return { ..._sched }; }
    async function tick() {
        if (_sched.running) return;
        _sched.running = true;
        try {
            const comps = await db.all("SELECT * FROM competition WHERE sync_source IS NOT NULL AND status <> 'completed'");
            for (const comp of comps) {
                const source = sync.parseSource(comp); if (!source || source.enabled === false) continue;
                // 대회 기간 밖(하루 전~하루 뒤)이면 쉰다
                const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
                if (comp.start_date && today < addDays(comp.start_date, -1)) continue;
                if (comp.end_date && today > addDays(comp.end_date, 1)) continue;
                try { await sync.runOnce(db, comp, { onApplied }); _sched.last_error = null; }
                catch (e) { _sched.last_error = `${comp.name}: ${e.message}`; console.error('[intl-sync]', comp.id, e.message); }
            }
            _sched.last_run = new Date().toISOString();
        } finally { _sched.running = false; }
    }
    function addDays(ymd, n) { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
    if (process.env.NODE_ENV !== 'test' && !process.env.VITEST && process.env.INTL_SYNC !== 'off') {
        const t = setInterval(() => { tick().catch(() => {}); }, _sched.interval_ms);
        if (t.unref) t.unref();
        setTimeout(() => { tick().catch(() => {}); }, 15000).unref();
    }
    return { tick, info: _schedulerInfo };
};
