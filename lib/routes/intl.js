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

// 조별 순위: 조 안의 모든 결과(시도별이면 최고)를 종목 종류에 맞게 정렬해 등수를 매긴다 → Map('heatId:entryId' → place)
async function _placesInHeats(db, heatIds) {
    const out = new Map();
    if (!heatIds.length) return out;
    const R = require('../../public/lib/ranking');
    const hph = heatIds.map(() => '?').join(',');
    const cat = new Map();
    for (const h of await db.all(`SELECT h.id, e.category FROM heat h JOIN event e ON e.id=h.event_id WHERE h.id IN (${hph})`, ...heatIds)) cat.set(Number(h.id), h.category);
    const best = new Map();   // 'heat:entry' → { time, dist, status }
    const upd = (hid, eid, t, d, st) => {
        const k = hid + ':' + eid, c = best.get(k) || { heat_id: hid, entry_id: eid, time: null, dist: null, status: null };
        if (st) c.status = st;
        if (t != null && (c.time == null || t < c.time)) c.time = t;
        if (d != null && (c.dist == null || d > c.dist)) c.dist = d;
        best.set(k, c);
    };
    for (const r of await db.all(`SELECT heat_id, event_entry_id, time_seconds, distance_meters, status_code FROM result WHERE heat_id IN (${hph})`, ...heatIds)) upd(Number(r.heat_id), Number(r.event_entry_id), r.time_seconds, r.distance_meters, r.status_code);
    for (const r of await db.all(`SELECT heat_id, event_entry_id, MAX(bar_height) AS h FROM height_attempt WHERE heat_id IN (${hph}) AND result_mark='O' GROUP BY heat_id, event_entry_id`, ...heatIds)) upd(Number(r.heat_id), Number(r.event_entry_id), null, r.h, null);
    const byHeat = new Map();
    for (const b of best.values()) { if (!byHeat.has(b.heat_id)) byHeat.set(b.heat_id, []); byHeat.get(b.heat_id).push(b); }
    for (const [hid, rows] of byHeat) {
        const field = /^field/.test(cat.get(hid) || '') || cat.get(hid) === 'combined';   // 필드·종합(점수)은 클수록 좋다
        const val = b => field ? b.dist : b.time;
        const cmp = R.withStatusLast((a, b) => {
            const va = val(a), vb = val(b);
            if (va == null && vb == null) return 0; if (va == null) return 1; if (vb == null) return -1;
            return field ? vb - va : va - vb;
        });
        rows.forEach(b => { b.status_code = b.status; });
        rows.sort(cmp);
        let place = 0;
        rows.forEach((b, i) => {
            if (b.status || val(b) == null) return;
            if (i === 0 || cmp(rows[i - 1], b) !== 0) place = i + 1;    // 동기록은 같은 등수
            out.set(b.heat_id + ':' + b.entry_id, place);
        });
    }
    return out;
}

module.exports = function mountIntlRoutes(app, deps) {
    const { db, isAdminKey, isOperationKey, opLog, broadcastSSE } = deps;   // deps.upload (multer) · deps.notifyEventInterest 는 선택
    const keyOf = req => String(req.headers['x-admin-key'] || (req.body && req.body.admin_key) || req.query.key || '');
    // 결과가 들어오면 화면 갱신(SSE), 라운드가 공식 완료되면 관심 종목 알림(수기 입력의 '결과 발표' 와 같은 경로)
    const onApplied = async ({ event_id, heat_id, completed }) => {
        try { broadcastSSE('result_update', { event_id, heat_id, source: 'intl-sync' }); } catch (e) {}
        if (completed && typeof deps.notifyEventInterest === 'function') {
            try {
                const event = await db.get('SELECT * FROM event WHERE id=?', event_id);
                if (event) {
                    const gL = event.gender === 'M' ? '남자' : event.gender === 'F' ? '여자' : '혼성';
                    const rL = { preliminary: '예선', semifinal: '준결승', final: '결승' }[event.round_type] || '';
                    await deps.notifyEventInterest(event, { kind: 'result', title: `${gL} ${event.name} ${rL} 결과 발표`, body: '공식 결과가 나왔습니다. 눌러서 확인하세요.' });
                    opLog(`국제대회 결과 완료: ${gL} ${event.name} ${rL}`, 'record', 'system', event.competition_id);
                }
            } catch (e) { console.error('[intl-sync] notify', e.message); }
        }
    };

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
                rows = sync.rowsFromSheet(XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }));      // 제목·출처 줄 위에 있어도 머리글을 찾는다
                try { require('fs').unlinkSync(req.file.path); } catch (e) {}
            }
            if (!rows) return res.status(400).json({ error: '파일(xlsx/csv) 또는 rows 가 필요합니다.' });
            const st = await sync.applyAthleteInfo(db, comp.id, rows);
            opLog(`국제대회 선수 정보 반영: ${st.matched}명 (미매칭 ${st.unmatched.length})`, 'admin', 'admin', comp.id);
            res.json({ success: true, ...st });
        } catch (e) { res.status(400).json({ error: '반영 실패: ' + e.message }); }
    });

    // 관심 국가(한국) 선수단 명단 — 선수 기준으로 출전 종목·다음 경기·PB/SB·결과를 묶는다 (대시보드 '대표팀 명단' 창)
    //   GET /api/competitions/:compId/roster[?team=KOR]   (공개)
    app.get('/api/competitions/:compId/roster', async (req, res) => {
        const comp = await db.get('SELECT id, sync_source FROM competition WHERE id=?', req.params.compId);
        if (!comp) return res.status(404).json({ error: '대회를 찾을 수 없습니다.' });
        let source = null; try { source = JSON.parse(comp.sync_source || 'null'); } catch (e) {}
        const team = String(req.query.team || (source && source.spotlight) || '').trim().toUpperCase();
        if (!team) return res.status(400).json({ error: '관심 국가가 설정되지 않은 대회입니다.' });
        try {
            const athletes = await db.all('SELECT id, name, name_alt, gender, date_of_birth, personal_best, season_best, barcode FROM athlete WHERE competition_id=? AND team=? ORDER BY name', comp.id, team);
            if (!athletes.length) return res.json({ team, athletes: [], teams: [] });
            const ids = athletes.map(a => a.id);
            const ph = ids.map(() => '?').join(',');
            const entries = await db.all(`SELECT ee.id AS entry_id, ee.athlete_id, COALESCE(NULLIF(ee.personal_best,''), a.personal_best, '') AS personal_best, COALESCE(NULLIF(ee.season_best,''), a.season_best, '') AS season_best,
                    e.id AS event_id, e.name AS event_name, e.gender AS event_gender, e.round_type, e.round_status, e.category, e.external_key, e.parent_event_id
                FROM event_entry ee JOIN event e ON e.id=ee.event_id JOIN athlete a ON a.id=ee.athlete_id WHERE ee.athlete_id IN (${ph})`, ...ids);   // 출전별 PB/SB 가 없으면 선수 PB/SB
            const entryIds = entries.map(x => x.entry_id);
            const eph = entryIds.map(() => '?').join(',') || 'NULL';
            // 조 시각: 선수가 배정된 조 → 없으면 종목의 첫 조
            const heatOf = new Map();
            for (const h of await db.all(`SELECT he.event_entry_id, h.scheduled_at, h.heat_number FROM heat_entry he JOIN heat h ON h.id=he.heat_id WHERE he.event_entry_id IN (${eph})`, ...entryIds)) heatOf.set(Number(h.event_entry_id), h);
            const eventIds = [...new Set(entries.map(x => x.event_id))];
            const evph = eventIds.map(() => '?').join(',') || 'NULL';
            const firstHeat = new Map();
            for (const h of await db.all(`SELECT event_id, MIN(scheduled_at) AS scheduled_at FROM heat WHERE event_id IN (${evph}) AND scheduled_at IS NOT NULL GROUP BY event_id`, ...eventIds)) firstHeat.set(Number(h.event_id), h.scheduled_at);
            const ttOf = new Map();
            for (const t of await db.all(`SELECT event_id, day, time, scheduled_date FROM timetable WHERE competition_id=? AND event_id IN (${evph}) ORDER BY day, time`, comp.id, ...eventIds)) if (!ttOf.has(Number(t.event_id))) ttOf.set(Number(t.event_id), t);
            // 결과: 동기화 결과는 attempt_number NULL 한 줄. 수기 입력(시도별)이면 트랙 최소 시간 / 필드 최대 거리
            const resOf = new Map();
            for (const r of await db.all(`SELECT r.heat_id, r.event_entry_id, r.time_seconds, r.distance_meters, r.status_code, COALESCE(CAST(r.wind AS TEXT), h.wind) AS wind, r.attempt_number FROM result r JOIN heat h ON h.id=r.heat_id WHERE r.event_entry_id IN (${eph})`, ...entryIds)) {   // 풍속은 결과 행에 없으면 조의 풍속
                const k = Number(r.event_entry_id), cur = resOf.get(k);
                if (!cur || r.attempt_number == null || (cur.attempt_number != null && ((r.time_seconds != null && (cur.time_seconds == null || r.time_seconds < cur.time_seconds)) || (r.distance_meters != null && (cur.distance_meters == null || r.distance_meters > cur.distance_meters))))) resOf.set(k, r);
            }
            for (const r of await db.all(`SELECT event_entry_id, heat_id, MAX(bar_height) AS h FROM height_attempt WHERE event_entry_id IN (${eph}) AND result_mark='O' GROUP BY event_entry_id, heat_id`, ...entryIds)) {
                const k = Number(r.event_entry_id); if (!resOf.has(k)) resOf.set(k, { heat_id: r.heat_id, distance_meters: r.h, time_seconds: null, status_code: null });
            }
            // 순위: 같은 조 안에서 (트랙·계주·도로 = 시간 오름차순, 필드 = 거리·높이 내림차순, 상태코드는 뒤) — 결승은 조가 하나라 곧 최종 순위
            const placeOf = await _placesInHeats(db, [...new Set([...resOf.values()].map(r => r.heat_id).filter(Boolean))]);
            const heatCount = new Map();
            for (const h of await db.all(`SELECT event_id, COUNT(*) AS c FROM heat WHERE event_id IN (${evph}) GROUP BY event_id`, ...eventIds)) heatCount.set(Number(h.event_id), Number(h.c));
            // 계주 멤버
            const relayMembers = new Map();
            const memberOf = new Map();   // 선수 id → 자기가 멤버인 계주 entry id 들
            for (const m of await db.all(`SELECT rm.event_entry_id, rm.leg_order, rm.athlete_id, a.name, a.name_alt FROM relay_member rm JOIN athlete a ON a.id=rm.athlete_id WHERE rm.event_entry_id IN (${eph}) ORDER BY rm.leg_order`, ...entryIds)) {
                const k = Number(m.event_entry_id); if (!relayMembers.has(k)) relayMembers.set(k, []); relayMembers.get(k).push({ name: m.name, name_alt: m.name_alt, leg_order: m.leg_order });
                if (!memberOf.has(Number(m.athlete_id))) memberOf.set(Number(m.athlete_id), []); memberOf.get(Number(m.athlete_id)).push(k);
            }
            // PB/SB 경신: 결과 숫자가 PB/SB 숫자보다 좋으면 (트랙·도로·계주 = 작을수록, 필드·종합 = 클수록). 상태코드면 판정 안 함
            const better = (ev, mark, ref) => {
                if (!ref || mark == null) return false;
                const refN = B.markToNumber(ref, ev.category); if (refN == null) return false;
                const higher = /^field/.test(ev.category) || ev.category === 'combined';
                return higher ? mark > refN + 1e-9 : mark < refN - 1e-9;
            };
            const byAthlete = new Map(), evByEntry = new Map();
            for (const x of entries) {
                const h = heatOf.get(Number(x.entry_id));
                const tt = ttOf.get(Number(x.event_id));
                const r = resOf.get(Number(x.entry_id));
                const ev = { event_id: x.event_id, event_name: x.event_name, gender: x.event_gender, round_type: x.round_type, round_status: x.round_status, category: x.category, parent_event_id: x.parent_event_id,
                    scheduled_at: (h && h.scheduled_at) || firstHeat.get(Number(x.event_id)) || null, heat_number: h ? h.heat_number : null,
                    day: tt ? tt.day : null, time: tt ? tt.time : null, scheduled_date: tt ? tt.scheduled_date : null,
                    personal_best: x.personal_best || '', season_best: x.season_best || '',
                    result: r ? (() => {
                        const mark = r.status_code ? null : (r.time_seconds != null ? r.time_seconds : r.distance_meters);
                        return { time_seconds: r.time_seconds, distance_meters: r.distance_meters, status_code: r.status_code || null, wind: (r.wind != null && r.wind !== '' && isFinite(parseFloat(r.wind))) ? parseFloat(r.wind) : null,
                            place: placeOf.get(r.heat_id + ':' + x.entry_id) || null, heat_count: heatCount.get(Number(x.event_id)) || 0,
                            pb_improved: better({ category: x.category }, mark, x.personal_best), sb_improved: better({ category: x.category }, mark, x.season_best) };
                    })() : null,
                    members: relayMembers.get(Number(x.entry_id)) || undefined };
                if (!byAthlete.has(x.athlete_id)) byAthlete.set(x.athlete_id, []);
                byAthlete.get(x.athlete_id).push(ev);
                evByEntry.set(Number(x.entry_id), ev);
            }
            // 계주 멤버에게도 팀 종목을 붙인다 (relay: true — 팀 엔트리의 PB·결과를 그대로 보여줌)
            for (const [aid, entryIds2] of memberOf) {
                if (!byAthlete.has(aid)) byAthlete.set(aid, []);
                for (const eid of entryIds2) { const ev = evByEntry.get(eid); if (ev && !byAthlete.get(aid).some(z => z.event_id === ev.event_id)) byAthlete.get(aid).push({ ...ev, relay: true }); }
            }
            const sortKey = ev => ev.scheduled_at || (ev.scheduled_date ? `${ev.scheduled_date}T${ev.time || '00:00'}` : (ev.day != null ? `D${String(ev.day).padStart(2, '0')}T${ev.time || '00:00'}` : '~'));
            const out = athletes.map(a => {
                const evs = (byAthlete.get(a.id) || []).sort((p, q) => sortKey(p).localeCompare(sortKey(q)));
                const next = evs.find(e => e.round_status !== 'completed') || null;
                return { id: a.id, name: a.name, name_alt: a.name_alt, gender: a.gender, birth_year: (String(a.date_of_birth || '').match(/^\d{4}/) || [null])[0],
                    personal_best: a.personal_best || '', season_best: a.season_best || '', is_team: /^RELAY_/.test(String(a.barcode || '')),
                    events: evs, next_key: next ? sortKey(next) : null };
            });
            // 메달 집계: 결승 라운드의 공식 결과(완료된 종목) 1·2·3위 — 종목당 한 번 (계주는 팀 하나)
            const medals = { gold: 0, silver: 0, bronze: 0, events: [] };
            const seenEv = new Set();
            for (const a of out) for (const ev of a.events) {
                if (ev.relay || ev.round_type !== 'final' || ev.round_status !== 'completed' || !ev.result || !ev.result.place || ev.result.place > 3 || seenEv.has(ev.event_id)) continue;
                seenEv.add(ev.event_id);
                medals[['gold', 'silver', 'bronze'][ev.result.place - 1]]++;
                medals.events.push({ event_id: ev.event_id, event_name: ev.event_name, gender: ev.gender, place: ev.result.place, name: a.name });
            }
            res.json({ team, athletes: out.filter(a => !a.is_team), teams: out.filter(a => a.is_team), medals });
        } catch (e) { res.status(500).json({ error: '명단 조회 실패: ' + e.message }); }
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
