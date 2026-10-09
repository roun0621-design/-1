'use strict';
/**
 * 바코드 조회·출전 상태·메모·수동 순위·종목 소집 메모(소집 보조) — server.js 에서 이동 (2026-09-22, Phase 4 분해). 동작은 인라인 시절과 같다.
 *   deps: broadcastSSE, db, parseDbTimestampMs, requireAdminAfterCompEnd, syncCombinedSubEventCheckin
 */
module.exports = function mountEntryMetaRoutes(app, deps) {
    const { broadcastSSE, db, parseDbTimestampMs, requireAdminAfterCompEnd, syncCombinedSubEventCheckin } = deps;
    for (const k of ["broadcastSSE","db","parseDbTimestampMs","requireAdminAfterCompEnd","syncCombinedSubEventCheckin"]) if (deps[k] === undefined) throw new Error('[entry_meta.js] mount requires deps.' + k);

    // ============================================================
    // CALLROOM
    // ============================================================
    app.get('/api/barcode/:code', async (req, res) => {
        const raw = req.params.code.trim();
        // ?competition_id= 를 주면 그 대회 선수만 본다 — 대회가 여러 개면 같은 배번이 다른 대회 선수로 잡히기 때문
        const _scope = req.query.competition_id ? Number(req.query.competition_id) : null;
        const _one = (col, v, extra = '') => _scope ? db.get(`SELECT * FROM athlete WHERE ${col}=?${extra} AND competition_id=?`, v, _scope) : db.get(`SELECT * FROM athlete WHERE ${col}=?${extra}`, v);

        // W/w prefix → female athlete by bib
        const wMatch = raw.match(/^[Ww][-]?(\d+)$/);
        if (wMatch) {
            const bibNum = wMatch[1].replace(/^0+/, '') || '0';
            const a = await _one('bib_number', bibNum, " AND gender='F'");
            if (!a) return res.status(404).json({ error: 'Barcode not found' });
            return res.json(a);
        }

        // Normal barcode normalization
        const variants = [raw];
        let numPart = null;
        const pr2026Match = raw.match(/^PR2026(\d+)$/i);
        const prMatch = raw.match(/^PR[-]?0*(\d+)$/i);
        if (pr2026Match) numPart = pr2026Match[1];
        else if (prMatch) numPart = prMatch[1];
        else if (/^\d+$/.test(raw)) numPart = raw.replace(/^0+/, '') || '0';
        if (numPart) {
            variants.push(`PR-${numPart}`, `PR${numPart}`, `PR${numPart.padStart(4, '0')}`, numPart);
        }
        let a = null;
        for (const v of variants) {
            a = await _one('barcode', v);
            if (a) break;
        }
        if (!a) {
            for (const v of variants) {
                a = await _one('bib_number', v);
                if (a) break;
            }
        }
        if (!a) return res.status(404).json({ error: 'Barcode not found' });
        res.json(a);
    });
    app.patch('/api/event-entries/:id/status', async (req, res) => {
        const { status, admin_key, offline_input_at } = req.body;
        if (!['registered', 'checked_in', 'no_show'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
        const entry = await db.get('SELECT * FROM event_entry WHERE id=?', req.params.id);
        if (!entry) return res.status(404).json({ error: 'Not found' });
        // Post-competition lock
        const _evt = await db.get('SELECT competition_id FROM event WHERE id=?', entry.event_id);
        if (_evt && await requireAdminAfterCompEnd(_evt.competition_id, admin_key, res)) return;
        // 오프라인 재전송: 그 사이 다른 기기(소집실 PC 등)가 상태를 바꿨으면 옛 값으로 덮지 않는다
        if (offline_input_at && entry.status_updated_at) {
            const serverMs = parseDbTimestampMs(entry.status_updated_at), offMs = Number(offline_input_at);
            if (Number.isFinite(serverMs) && Number.isFinite(offMs) && serverMs > offMs) {
                return res.status(409).json({ error: 'CONFLICT_NEWER_ON_SERVER', message: '그 사이에 다른 기기에서 소집 상태를 바꿨습니다. 오프라인 입력값은 적용되지 않았습니다.', server_value: { status: entry.status, updated_at: entry.status_updated_at }, rejected_offline_value: { status, offline_input_at } });
            }
        }
        await db.run(`UPDATE event_entry SET status=?, status_updated_at=${db.isAsync ? 'NOW()' : "datetime('now')"} WHERE id=?`, status, req.params.id);
        await syncCombinedSubEventCheckin(entry.event_id, entry.athlete_id, status);
        const _he = await db.get('SELECT heat_id FROM heat_entry WHERE event_entry_id=?', entry.id);
        broadcastSSE('entry_status', { event_entry_id: entry.id, status, event_id: entry.event_id, heat_id: _he ? _he.heat_id : null });
        res.json(await db.get('SELECT * FROM event_entry WHERE id=?', req.params.id));
    });
    // Save callroom memo
    app.patch('/api/event-entries/:id/memo', async (req, res) => {
        const { memo } = req.body;
        const entry = await db.get('SELECT * FROM event_entry WHERE id=?', req.params.id);
        if (!entry) return res.status(404).json({ error: 'Not found' });
        await db.run('UPDATE event_entry SET callroom_memo=? WHERE id=?', memo || '', req.params.id);
        res.json({ success: true });
    });
    // Save manual rank (수직도약 순위결정전 등 동기록 시 직접 입력한 순위)
    app.patch('/api/event-entries/:id/manual-rank', async (req, res) => {
        const { manual_rank, admin_key } = req.body;
        const entry = await db.get('SELECT * FROM event_entry WHERE id=?', req.params.id);
        if (!entry) return res.status(404).json({ error: 'Not found' });
        const _evt = await db.get('SELECT competition_id FROM event WHERE id=?', entry.event_id);
        if (_evt && await requireAdminAfterCompEnd(_evt.competition_id, admin_key, res)) return;
        let mr = (manual_rank === null || manual_rank === '' || manual_rank === undefined) ? null : parseInt(manual_rank);
        if (mr != null && (isNaN(mr) || mr < 1)) mr = null;
        await db.run('UPDATE event_entry SET manual_rank=? WHERE id=?', mr, req.params.id);
        broadcastSSE('result_update', { event_id: entry.event_id });
        res.json({ success: true, manual_rank: mr });
    });
    // Get/Save event-level callroom memo (소집실 종목 메모 — 인쇄 시 제목 하단)
    app.get('/api/events/:id/callroom-memo', async (req, res) => {
        const evt = await db.get('SELECT callroom_event_memo FROM event WHERE id=?', req.params.id);
        if (!evt) return res.status(404).json({ error: 'Event not found' });
        res.json({ memo: evt.callroom_event_memo || '' });
    });
    app.patch('/api/events/:id/callroom-memo', async (req, res) => {
        const { memo } = req.body;
        const evt = await db.get('SELECT id FROM event WHERE id=?', req.params.id);
        if (!evt) return res.status(404).json({ error: 'Event not found' });
        await db.run('UPDATE event SET callroom_event_memo=? WHERE id=?', memo || '', req.params.id);
        res.json({ success: true, memo: memo || '' });
    });

    return {  };
};
