'use strict';
/**
 * 종목 목록·상세·엔트리·조 배정 조회, 조 목록·조 엔트리 조회 (대시보드·기록입력·소집이 읽는 핵심 조회) — server.js 에서 이동 (2026-09-22, Phase 4 분해). 동작은 인라인 시절과 같다.
 *   deps: db, orderByBibSql
 */
module.exports = function mountEventsReadRoutes(app, deps) {
    const { db, orderByBibSql } = deps;
    for (const k of ["db","orderByBibSql"]) if (deps[k] === undefined) throw new Error('[events_read.js] mount requires deps.' + k);

    // Heat allocations view — shows all heats/lanes for an event (used in manual edit UI)
    app.get('/api/events/:id/heat-allocations', async (req, res) => {
        const event = await db.get('SELECT * FROM event WHERE id=?', req.params.id);
        if (!event) return res.status(404).json({ error: 'Event not found' });
        const heats = await db.all('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number', event.id);
        const result = await Promise.all(heats.map(async h => {
            const entries = await db.all(`SELECT he.lane_number, he.sub_group, he.id AS heat_entry_id, ee.id AS event_entry_id, ee.status,
                   a.id AS athlete_id, a.name, a.bib_number, a.team, a.gender
            FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id
            JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=? ORDER BY he.lane_number ASC, ${orderByBibSql('a.bib_number')}`, h.id);
            return { ...h, entries };
        }));
        res.json({ event, heats: result });
    });
    app.get('/api/events', async (req, res) => {
        const { gender, category, competition_id } = req.query;
        let q = 'SELECT * FROM event WHERE 1=1';
        const p = [];
        if (competition_id) { q += ' AND competition_id=?'; p.push(competition_id); }
        if (gender) { q += ' AND gender=?'; p.push(gender); }
        if (category) { q += ' AND category=?'; p.push(category); }
        q += ' ORDER BY sort_order, id';
        const events = await db.all(q, ...p);
        // Attach heat_count so dashboard can show roster button for events with heats
        // (PG-safe: 단일 GROUP BY 쿼리로 일괄 조회, 이전 N+1 sync prepare 제거)
        if (events.length > 0) {
            const ids = events.map(e => e.id);
            const placeholders = ids.map(() => '?').join(',');
            const counts = await db.all(`SELECT event_id, COUNT(*) AS cnt FROM heat WHERE event_id IN (${placeholders}) GROUP BY event_id`, ...ids);
            const countMap = new Map(counts.map(c => [c.event_id, Number(c.cnt)]));
            events.forEach(e => { e.heat_count = countMap.get(e.id) || 0; });
            // 출전 인원 — 조가 아직 없는 종목의 '엔트리' 버튼용
            const ecounts = await db.all(`SELECT event_id, COUNT(*) AS cnt FROM event_entry WHERE event_id IN (${placeholders}) GROUP BY event_id`, ...ids);
            const ecountMap = new Map(ecounts.map(c => [Number(c.event_id), Number(c.cnt)]));
            events.forEach(e => { e.entry_count = ecountMap.get(Number(e.id)) || 0; });
            // 조에 실제로 배정된 인원(레인) — 국제대회는 조(유닛)가 일정에서 먼저 만들어지고 명단은 나중에 오므로, 조가 있어도 비어 있으면 '명단' 대신 '엔트리'
            const hcounts = await db.all(`SELECT h.event_id, COUNT(he.id) AS cnt FROM heat h JOIN heat_entry he ON he.heat_id=h.id WHERE h.event_id IN (${placeholders}) GROUP BY h.event_id`, ...ids);
            const hcountMap = new Map(hcounts.map(c => [Number(c.event_id), Number(c.cnt)]));
            events.forEach(e => { e.heat_entry_count = hcountMap.get(Number(e.id)) || 0; });
            // 국제대회(동기화 대회): 관심 국가(spotlight, 예: KOR) 선수가 출전하는 종목 표시 — 대시보드 배지·'한국 선수' 필터
            if (competition_id) {
                try {
                    const comp = await db.get('SELECT sync_source FROM competition WHERE id=?', competition_id);
                    const src = comp && comp.sync_source ? JSON.parse(comp.sync_source) : null;
                    if (src && src.spotlight) {
                        const rows = await db.all(`SELECT DISTINCT ee.event_id FROM event_entry ee JOIN athlete a ON a.id=ee.athlete_id WHERE ee.event_id IN (${placeholders}) AND a.team=?`, ...ids, src.spotlight);
                        const spot = new Set(rows.map(r => Number(r.event_id)));
                        // 같은 종목의 다른 라운드(external_key 앞부분이 같음)도 함께 표시 — 예선에만 엔트리가 있어도 결승 행에 배지가 보이게
                        const baseOf = e => String(e.external_key || '').split('#')[0] || null;
                        const spotBases = new Set(events.filter(e => spot.has(Number(e.id))).map(baseOf).filter(Boolean));
                        events.forEach(e => { e.spotlight = spot.has(Number(e.id)) || (baseOf(e) != null && spotBases.has(baseOf(e))) ? src.spotlight : null; });
                    }
                } catch (e) {}
            }
        }
        res.json(events);
    });
    app.get('/api/events/:id', async (req, res) => {
        const e = await db.get('SELECT * FROM event WHERE id=?', req.params.id);
        if (!e) return res.status(404).json({ error: 'Not found' });
        res.json(e);
    });
    app.get('/api/events/:id/entries', async (req, res) => {
        res.json(await db.all(`
            SELECT ee.id AS event_entry_id, ee.status, ee.event_id,
                   a.id AS athlete_id, a.name, a.bib_number, a.team, a.gender,
                   a.name_alt, a.federation, a.date_of_birth,
                   COALESCE(NULLIF(ee.personal_best,''), a.personal_best) AS personal_best, COALESCE(NULLIF(ee.season_best,''), a.season_best) AS season_best
            FROM event_entry ee JOIN athlete a ON a.id=ee.athlete_id
            WHERE ee.event_id=? ORDER BY ${orderByBibSql('a.bib_number')}
        `, req.params.id));
    });

    // ============================================================
    // HEATS
    // ============================================================
    app.get('/api/heats', async (req, res) => {
        if (!req.query.event_id) return res.status(400).json({ error: 'event_id required' });
        res.json(await db.all('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number', req.query.event_id));
    });
    app.get('/api/heats/:id/entries', async (req, res) => {
        const statusFilter = req.query.status;
        let query = `SELECT he.id AS heat_entry_id, he.lane_number, he.sub_group,
                   ee.id AS event_entry_id, ee.status, ee.callroom_memo, ee.manual_rank,
                   a.id AS athlete_id, a.name, a.bib_number, a.team, a.gender, a.barcode,
                   a.name_alt, a.date_of_birth,
                   COALESCE(NULLIF(ee.personal_best,''), a.personal_best) AS personal_best, COALESCE(NULLIF(ee.season_best,''), a.season_best) AS season_best
            FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id
            JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=?`;
        const params = [req.params.id];
        if (statusFilter) { query += ` AND ee.status=?`; params.push(statusFilter); }
        query += ` ORDER BY he.lane_number ASC, ${orderByBibSql('a.bib_number')}`;
        res.json(await db.all(query, ...params));
    });


    return {  };
};
