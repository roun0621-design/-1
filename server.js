/**
 * Pace Rise Competition OS — Express Server v2
 * Full Olympic Athletics Demo
 */
const express = require('express');
const path = require('path');
const { initDatabase } = require('./db/init');

const app = express();
const PORT = 3000;
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const db = initDatabase();

// ---- SSE clients ----
let sseClients = [];

function broadcastSSE(eventType, data) {
    const msg = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    sseClients = sseClients.filter(c => {
        try { c.write(msg); return true; }
        catch { return false; }
    });
}

// ---- WA Scoring (server-side) ----
const WA_TABLES = {
    M_100m:{A:25.4347,B:18,C:1.81,type:'track'},M_long_jump:{A:0.14354,B:220,C:1.40,type:'field_cm'},
    M_shot_put:{A:51.39,B:1.5,C:1.05,type:'field_m'},M_high_jump:{A:0.8465,B:75,C:1.42,type:'field_cm'},
    M_400m:{A:1.53775,B:82,C:1.81,type:'track'},M_110m_hurdles:{A:5.74352,B:28.5,C:1.92,type:'track'},
    M_discus:{A:12.91,B:4,C:1.1,type:'field_m'},M_pole_vault:{A:0.2797,B:100,C:1.35,type:'field_cm'},
    M_javelin:{A:10.14,B:7,C:1.08,type:'field_m'},M_1500m:{A:0.03768,B:480,C:1.85,type:'track'},
    F_200m:{A:4.99087,B:42.5,C:1.81,type:'track'},F_100m_hurdles:{A:9.23076,B:26.7,C:1.835,type:'track'},
    F_high_jump:{A:1.84523,B:75,C:1.348,type:'field_cm'},F_shot_put:{A:56.0211,B:1.5,C:1.05,type:'field_m'},
    F_long_jump:{A:0.188807,B:210,C:1.41,type:'field_cm'},F_javelin:{A:15.9803,B:3.8,C:1.04,type:'field_m'},
    F_800m:{A:0.11193,B:254,C:1.88,type:'track'},
};
const DECATHLON_KEYS = ['M_100m','M_long_jump','M_shot_put','M_high_jump','M_400m','M_110m_hurdles','M_discus','M_pole_vault','M_javelin','M_1500m'];
const HEPTATHLON_KEYS = ['F_100m_hurdles','F_high_jump','F_shot_put','F_200m','F_long_jump','F_javelin','F_800m'];
function calcWAPoints(key, rawRecord) {
    const t = WA_TABLES[key];
    if (!t || rawRecord == null || rawRecord <= 0) return 0;
    let val;
    if (t.type === 'track') { val = t.B - rawRecord; if (val <= 0) return 0; return Math.floor(t.A * Math.pow(val, t.C)); }
    else if (t.type === 'field_cm') { val = rawRecord * 100 - t.B; if (val <= 0) return 0; return Math.floor(t.A * Math.pow(val, t.C)); }
    else { val = rawRecord - t.B; if (val <= 0) return 0; return Math.floor(t.A * Math.pow(val, t.C)); }
}

// ---- Audit Helper ----
function audit(table, id, action, oldV, newV, by = 'operator') {
    db.prepare(`INSERT INTO audit_log (table_name,record_id,action,old_values,new_values,performed_by) VALUES (?,?,?,?,?,?)`)
        .run(table, id, action, oldV ? JSON.stringify(oldV) : null, newV ? JSON.stringify(newV) : null, by);
}

// ============================================================
// Events
// ============================================================
app.get('/api/events', (req, res) => {
    const { gender, category } = req.query;
    let q = 'SELECT * FROM event WHERE 1=1';
    const p = [];
    if (gender) { q += ' AND gender=?'; p.push(gender); }
    if (category) { q += ' AND category=?'; p.push(category); }
    q += ' ORDER BY id';
    res.json(db.prepare(q).all(...p));
});

app.get('/api/events/:id', (req, res) => {
    const e = db.prepare('SELECT * FROM event WHERE id=?').get(req.params.id);
    if (!e) return res.status(404).json({ error: 'Not found' });
    res.json(e);
});

app.get('/api/events/:id/entries', (req, res) => {
    res.json(db.prepare(`
        SELECT ee.id AS event_entry_id, ee.status, ee.event_id,
               a.id AS athlete_id, a.name, a.bib_number, a.team, a.gender
        FROM event_entry ee JOIN athlete a ON a.id=ee.athlete_id
        WHERE ee.event_id=? ORDER BY CAST(a.bib_number AS INTEGER)
    `).all(req.params.id));
});

// ============================================================
// Heats
// ============================================================
app.get('/api/heats', (req, res) => {
    if (!req.query.event_id) return res.status(400).json({ error: 'event_id required' });
    res.json(db.prepare('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number').all(req.query.event_id));
});

app.get('/api/heats/:id/entries', (req, res) => {
    const statusFilter = req.query.status; // e.g. ?status=checked_in
    let query = `
        SELECT he.id AS heat_entry_id, he.lane_number,
               ee.id AS event_entry_id, ee.status,
               a.id AS athlete_id, a.name, a.bib_number, a.team, a.gender
        FROM heat_entry he
        JOIN event_entry ee ON ee.id=he.event_entry_id
        JOIN athlete a ON a.id=ee.athlete_id
        WHERE he.heat_id=?`;
    const params = [req.params.id];
    if (statusFilter) {
        query += ` AND ee.status=?`;
        params.push(statusFilter);
    }
    query += ` ORDER BY CAST(a.bib_number AS INTEGER)`;
    res.json(db.prepare(query).all(...params));
});

// ============================================================
// Results (Track + Field Distance)
// ============================================================
app.get('/api/results', (req, res) => {
    if (!req.query.heat_id) return res.status(400).json({ error: 'heat_id required' });
    res.json(db.prepare(`
        SELECT r.*, a.name, a.bib_number, a.team
        FROM result r JOIN event_entry ee ON ee.id=r.event_entry_id
        JOIN athlete a ON a.id=ee.athlete_id
        WHERE r.heat_id=? ORDER BY r.event_entry_id, r.attempt_number
    `).all(req.query.heat_id));
});

app.post('/api/results/upsert', (req, res) => {
    const { heat_id, event_entry_id, attempt_number, distance_meters, time_seconds } = req.body;
    if (!heat_id || !event_entry_id) return res.status(400).json({ error: 'heat_id and event_entry_id required' });

    const he = db.prepare('SELECT * FROM heat_entry WHERE heat_id=? AND event_entry_id=?').get(heat_id, event_entry_id);
    if (!he) return res.status(404).json({ error: 'Entry not in heat' });

    try {
        const existing = db.prepare('SELECT * FROM result WHERE heat_id=? AND event_entry_id=? AND attempt_number IS ?')
            .get(heat_id, event_entry_id, attempt_number || null);
        if (existing) {
            const old = { ...existing };
            db.prepare("UPDATE result SET distance_meters=?,time_seconds=?,updated_at=datetime('now') WHERE id=?")
                .run(distance_meters ?? null, time_seconds ?? null, existing.id);
            const upd = db.prepare('SELECT * FROM result WHERE id=?').get(existing.id);
            audit('result', existing.id, 'UPDATE', old, upd);
            broadcastSSE('result_update', { heat_id, event_entry_id });
            res.json(upd);
        } else {
            const info = db.prepare('INSERT INTO result (heat_id,event_entry_id,attempt_number,distance_meters,time_seconds) VALUES (?,?,?,?,?)')
                .run(heat_id, event_entry_id, attempt_number || null, distance_meters ?? null, time_seconds ?? null);
            const ins = db.prepare('SELECT * FROM result WHERE id=?').get(info.lastInsertRowid);
            audit('result', ins.id, 'INSERT', null, ins);
            broadcastSSE('result_update', { heat_id, event_entry_id });
            res.json(ins);
        }
    } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ============================================================
// Height Attempts
// ============================================================
app.get('/api/height-attempts', (req, res) => {
    if (!req.query.heat_id) return res.status(400).json({ error: 'heat_id required' });
    res.json(db.prepare(`
        SELECT ha.*, a.name, a.bib_number, a.team
        FROM height_attempt ha JOIN event_entry ee ON ee.id=ha.event_entry_id
        JOIN athlete a ON a.id=ee.athlete_id
        WHERE ha.heat_id=? ORDER BY ha.bar_height, ha.event_entry_id, ha.attempt_number
    `).all(req.query.heat_id));
});

app.post('/api/height-attempts/save', (req, res) => {
    const { heat_id, event_entry_id, bar_height, attempt_number, result_mark } = req.body;
    if (!heat_id || !event_entry_id || !bar_height || !attempt_number || !result_mark)
        return res.status(400).json({ error: 'All fields required' });

    try {
        const existing = db.prepare('SELECT * FROM height_attempt WHERE heat_id=? AND event_entry_id=? AND bar_height=? AND attempt_number=?')
            .get(heat_id, event_entry_id, bar_height, attempt_number);
        if (existing) {
            db.prepare('UPDATE height_attempt SET result_mark=? WHERE id=?').run(result_mark, existing.id);
            const upd = db.prepare('SELECT * FROM height_attempt WHERE id=?').get(existing.id);
            audit('height_attempt', existing.id, 'UPDATE', existing, upd);
            res.json(upd);
        } else {
            const info = db.prepare('INSERT INTO height_attempt (heat_id,event_entry_id,bar_height,attempt_number,result_mark) VALUES (?,?,?,?,?)')
                .run(heat_id, event_entry_id, bar_height, attempt_number, result_mark);
            const ins = db.prepare('SELECT * FROM height_attempt WHERE id=?').get(info.lastInsertRowid);
            audit('height_attempt', ins.id, 'INSERT', null, ins);
            res.json(ins);
        }
    } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ============================================================
// Combined Scores (혼성 경기)
// ============================================================
app.get('/api/combined-scores', (req, res) => {
    if (!req.query.event_id) return res.status(400).json({ error: 'event_id required' });
    res.json(db.prepare(`
        SELECT cs.*, a.name, a.bib_number, a.team
        FROM combined_score cs JOIN event_entry ee ON ee.id=cs.event_entry_id
        JOIN athlete a ON a.id=ee.athlete_id
        WHERE ee.event_id=? ORDER BY cs.event_entry_id, cs.sub_event_order
    `).all(req.query.event_id));
});

app.post('/api/combined-scores/save', (req, res) => {
    const { event_entry_id, sub_event_name, sub_event_order, raw_record, wa_points } = req.body;
    if (!event_entry_id || !sub_event_name || !sub_event_order)
        return res.status(400).json({ error: 'Required fields missing' });

    try {
        const existing = db.prepare('SELECT * FROM combined_score WHERE event_entry_id=? AND sub_event_order=?')
            .get(event_entry_id, sub_event_order);
        if (existing) {
            db.prepare('UPDATE combined_score SET raw_record=?,wa_points=?,sub_event_name=? WHERE id=?')
                .run(raw_record ?? null, wa_points || 0, sub_event_name, existing.id);
            const upd = db.prepare('SELECT * FROM combined_score WHERE id=?').get(existing.id);
            audit('combined_score', existing.id, 'UPDATE', existing, upd);
            res.json(upd);
        } else {
            const info = db.prepare('INSERT INTO combined_score (event_entry_id,sub_event_name,sub_event_order,raw_record,wa_points) VALUES (?,?,?,?,?)')
                .run(event_entry_id, sub_event_name, sub_event_order, raw_record ?? null, wa_points || 0);
            const ins = db.prepare('SELECT * FROM combined_score WHERE id=?').get(info.lastInsertRowid);
            audit('combined_score', ins.id, 'INSERT', null, ins);
            res.json(ins);
        }
    } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// Get sub-events for a combined event
app.get('/api/combined-sub-events', (req, res) => {
    if (!req.query.parent_event_id) return res.status(400).json({ error: 'parent_event_id required' });
    res.json(db.prepare('SELECT * FROM event WHERE parent_event_id=? ORDER BY id').all(req.query.parent_event_id));
});

// Sync: pull BEST results from sub-event into combined_score
// This reads actual results from the sub-event's heat and updates combined_score
app.post('/api/combined-scores/sync', (req, res) => {
    const { parent_event_id } = req.body;
    if (!parent_event_id) return res.status(400).json({ error: 'parent_event_id required' });

    const parentEvent = db.prepare('SELECT * FROM event WHERE id=?').get(parent_event_id);
    if (!parentEvent || parentEvent.category !== 'combined') return res.status(400).json({ error: 'Not a combined event' });

    const subEvents = db.prepare('SELECT * FROM event WHERE parent_event_id=? ORDER BY id').all(parent_event_id);
    const parentEntries = db.prepare('SELECT ee.id AS event_entry_id, ee.athlete_id FROM event_entry ee WHERE ee.event_id=?').all(parent_event_id);

    let syncCount = 0;
    const upsert = db.prepare(`INSERT INTO combined_score (event_entry_id,sub_event_name,sub_event_order,raw_record,wa_points)
        VALUES (?,?,?,?,?) ON CONFLICT(event_entry_id,sub_event_order) DO UPDATE SET raw_record=excluded.raw_record, wa_points=excluded.wa_points, sub_event_name=excluded.sub_event_name`);

    db.transaction(() => {
        subEvents.forEach((subEvt, idx) => {
            const subOrder = idx + 1;
            const subHeat = db.prepare('SELECT id FROM heat WHERE event_id=? LIMIT 1').get(subEvt.id);
            if (!subHeat) return;

            parentEntries.forEach(pe => {
                // Find the sub-event entry for this athlete
                const subEntry = db.prepare('SELECT id FROM event_entry WHERE event_id=? AND athlete_id=?').get(subEvt.id, pe.athlete_id);
                if (!subEntry) return;

                let bestRecord = null;
                if (subEvt.category === 'track') {
                    const r = db.prepare('SELECT MIN(time_seconds) AS best FROM result WHERE heat_id=? AND event_entry_id=? AND time_seconds IS NOT NULL AND time_seconds > 0').get(subHeat.id, subEntry.id);
                    if (r && r.best) bestRecord = r.best;
                } else if (subEvt.category === 'field_distance') {
                    const r = db.prepare('SELECT MAX(distance_meters) AS best FROM result WHERE heat_id=? AND event_entry_id=? AND distance_meters IS NOT NULL AND distance_meters > 0').get(subHeat.id, subEntry.id);
                    if (r && r.best) bestRecord = r.best;
                } else if (subEvt.category === 'field_height') {
                    const r = db.prepare('SELECT MAX(bar_height) AS best FROM height_attempt WHERE heat_id=? AND event_entry_id=? AND result_mark=?').get(subHeat.id, subEntry.id, 'O');
                    if (r && r.best) bestRecord = r.best;
                }

                if (bestRecord != null) {
                    // Calculate WA points server-side
                    const waKeys = parentEvent.gender === 'M' ? DECATHLON_KEYS : HEPTATHLON_KEYS;
                    const waKey = waKeys[subOrder - 1];
                    const waPoints = waKey ? calcWAPoints(waKey, bestRecord) : 0;
                    upsert.run(pe.event_entry_id, subEvt.name, subOrder, bestRecord, waPoints);
                    syncCount++;
                }
            });
        });
    })();

    res.json({ success: true, synced: syncCount });
});

// ============================================================
// Call Room — Barcode lookup + Status change
// ============================================================
app.get('/api/barcode/:code', (req, res) => {
    const a = db.prepare('SELECT * FROM athlete WHERE barcode=?').get(req.params.code);
    if (!a) return res.status(404).json({ error: 'Barcode not found' });
    res.json(a);
});

app.patch('/api/event-entries/:id/status', (req, res) => {
    const { status } = req.body;
    if (!['registered', 'checked_in', 'no_show'].includes(status))
        return res.status(400).json({ error: 'Invalid status' });
    const entry = db.prepare('SELECT * FROM event_entry WHERE id=?').get(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not found' });
    const old = { ...entry };
    db.prepare('UPDATE event_entry SET status=? WHERE id=?').run(status, req.params.id);
    const upd = db.prepare('SELECT * FROM event_entry WHERE id=?').get(req.params.id);
    audit('event_entry', entry.id, 'UPDATE', old, upd);
    broadcastSSE('entry_status', { event_entry_id: entry.id, status });
    res.json(upd);
});

// Check in by barcode for a specific event
app.post('/api/callroom/checkin', (req, res) => {
    const { barcode, event_id } = req.body;
    if (!barcode) return res.status(400).json({ error: 'barcode required' });
    const athlete = db.prepare('SELECT * FROM athlete WHERE barcode=?').get(barcode);
    if (!athlete) return res.status(404).json({ error: 'Barcode not found', barcode });
    // Find event entry
    let entry;
    if (event_id) {
        entry = db.prepare('SELECT * FROM event_entry WHERE event_id=? AND athlete_id=?').get(event_id, athlete.id);
    } else {
        // Find any registered entry for this athlete
        entry = db.prepare("SELECT * FROM event_entry WHERE athlete_id=? AND status='registered' LIMIT 1").get(athlete.id);
    }
    if (!entry) return res.status(404).json({ error: 'No entry found', athlete: { name: athlete.name, bib: athlete.bib_number } });
    if (entry.status === 'checked_in') return res.json({ already: true, athlete, entry });

    db.prepare("UPDATE event_entry SET status='checked_in' WHERE id=?").run(entry.id);
    audit('event_entry', entry.id, 'UPDATE', { status: entry.status }, { status: 'checked_in' });
    res.json({ success: true, athlete, entry: { ...entry, status: 'checked_in' } });
});

// ============================================================
// Qualification
// ============================================================
app.get('/api/qualifications', (req, res) => {
    if (!req.query.event_id) return res.status(400).json({ error: 'event_id required' });
    res.json(db.prepare(`
        SELECT qs.*, a.name, a.bib_number FROM qualification_selection qs
        JOIN event_entry ee ON ee.id=qs.event_entry_id
        JOIN athlete a ON a.id=ee.athlete_id WHERE qs.event_id=?
    `).all(req.query.event_id));
});

app.post('/api/qualifications/save', (req, res) => {
    const { event_id, selections } = req.body;
    if (!event_id || !selections) return res.status(400).json({ error: 'Missing fields' });
    const upsert = db.prepare(`INSERT INTO qualification_selection (event_id,event_entry_id,selected)
        VALUES (?,?,?) ON CONFLICT(event_id,event_entry_id) DO UPDATE SET selected=excluded.selected, updated_at=datetime('now')`);
    db.transaction(() => { for (const s of selections) upsert.run(event_id, s.event_entry_id, s.selected ? 1 : 0); })();
    audit('qualification_selection', 0, 'UPDATE', null, { event_id, count: selections.length });
    res.json({ success: true });
});

app.post('/api/qualifications/approve', (req, res) => {
    const { event_id } = req.body;
    if (!event_id) return res.status(400).json({ error: 'event_id required' });
    db.prepare("UPDATE qualification_selection SET approved=1,approved_by='admin',updated_at=datetime('now') WHERE event_id=? AND selected=1")
        .run(event_id);
    audit('qualification_selection', 0, 'UPDATE', null, { event_id, action: 'approve' });
    res.json({ success: true });
});

// Create final round from qualified athletes
app.post('/api/events/:id/create-final', (req, res) => {
    const event = db.prepare('SELECT * FROM event WHERE id=?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const qualified = db.prepare(`SELECT event_entry_id FROM qualification_selection WHERE event_id=? AND selected=1 AND approved=1`).all(event.id);
    if (qualified.length === 0) return res.status(400).json({ error: 'No approved qualifiers' });

    // Create final event
    const info = db.prepare(`INSERT INTO event (name,category,gender,round_type,round_status) VALUES (?,?,?,'final','created')`)
        .run(event.name, event.category, event.gender);
    const finalEventId = info.lastInsertRowid;

    // Create entries + heat
    const heatInfo = db.prepare('INSERT INTO heat (event_id,heat_number) VALUES (?,1)').run(finalEventId);
    const finalHeatId = heatInfo.lastInsertRowid;

    for (const q of qualified) {
        const origEntry = db.prepare('SELECT * FROM event_entry WHERE id=?').get(q.event_entry_id);
        const newEntry = db.prepare("INSERT INTO event_entry (event_id,athlete_id,status) VALUES (?,?,'registered')").run(finalEventId, origEntry.athlete_id);
        db.prepare('INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES (?,?,NULL)').run(finalHeatId, newEntry.lastInsertRowid);
    }

    audit('event', finalEventId, 'INSERT', null, { action: 'create_final', source_event: event.id });
    res.json({ success: true, final_event_id: finalEventId, final_heat_id: finalHeatId, count: qualified.length });
});

// ============================================================
// Lane Assignment
// ============================================================
app.post('/api/lanes/assign', (req, res) => {
    const { heat_id, assignments } = req.body;
    if (!heat_id || !assignments) return res.status(400).json({ error: 'Missing fields' });
    const upd = db.prepare('UPDATE heat_entry SET lane_number=? WHERE heat_id=? AND event_entry_id=?');
    db.transaction(() => { for (const a of assignments) upd.run(a.lane_number, heat_id, a.event_entry_id); })();
    audit('heat_entry', 0, 'UPDATE', null, { heat_id, count: assignments.length });
    res.json({ success: true });
});

// ============================================================
// Round Status — aggregated for dashboard matrix
// ============================================================
app.get('/api/round-status', (req, res) => {
    const events = db.prepare('SELECT * FROM event WHERE parent_event_id IS NULL ORDER BY id').all();
    const result = events.map(e => {
        const heats = db.prepare('SELECT id FROM heat WHERE event_id=?').all(e.id);
        let totalEntries = 0, totalResults = 0;
        for (const h of heats) {
            const entries = db.prepare('SELECT COUNT(*) AS c FROM heat_entry WHERE heat_id=?').get(h.id);
            const results = db.prepare('SELECT COUNT(DISTINCT event_entry_id) AS c FROM result WHERE heat_id=?').get(h.id);
            totalEntries += entries.c;
            totalResults += results.c;
        }
        let status = 'created';
        if (heats.length > 0 && totalResults > 0 && totalResults >= totalEntries) status = 'completed';
        else if (totalResults > 0) status = 'in_progress';
        else if (heats.length > 0) status = 'heats_generated';
        return { ...e, heat_count: heats.length, total_entries: totalEntries, total_results: totalResults, computed_status: status };
    });
    res.json(result);
});

// ============================================================
// Audit Log
// ============================================================
app.get('/api/audit-log', (req, res) => {
    res.json(db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 30').all());
});

// ============================================================
// Admin key verification
// ============================================================
app.post('/api/admin/verify', (req, res) => {
    const { admin_key } = req.body;
    if (admin_key === '1234') return res.json({ success: true });
    res.status(403).json({ error: 'Invalid admin key' });
});

// ============================================================
// Round completion (경기 완료) with judge name
// ============================================================
app.post('/api/events/:id/complete', (req, res) => {
    const { judge_name, admin_key } = req.body;
    if (admin_key !== '1234') return res.status(403).json({ error: 'Invalid admin key' });
    if (!judge_name || !judge_name.trim()) return res.status(400).json({ error: 'Judge name required' });

    const event = db.prepare('SELECT * FROM event WHERE id=?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const old = { ...event };
    db.prepare("UPDATE event SET round_status='completed' WHERE id=?").run(event.id);
    const upd = db.prepare('SELECT * FROM event WHERE id=?').get(event.id);
    audit('event', event.id, 'UPDATE', old, { ...upd, judge_name }, judge_name);
    broadcastSSE('event_completed', { event_id: event.id, judge_name });
    res.json({ success: true, event: upd });
});

// ============================================================
// Callroom completion (소집 완료)
// ============================================================
app.post('/api/events/:id/callroom-complete', (req, res) => {
    const { judge_name } = req.body;
    const event = db.prepare('SELECT * FROM event WHERE id=?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    // Mark all remaining 'registered' entries as checked_in or leave as is
    // Just update event status to reflect callroom done
    const old = { round_status: event.round_status };
    if (event.round_status === 'created' || event.round_status === 'heats_generated') {
        db.prepare("UPDATE event SET round_status='in_progress' WHERE id=?").run(event.id);
    }
    audit('event', event.id, 'UPDATE', old, { action: 'callroom_complete', judge_name: judge_name || 'operator' }, judge_name || 'operator');
    broadcastSSE('callroom_complete', { event_id: event.id, judge_name: judge_name || 'operator' });
    res.json({ success: true });
});

// ============================================================
// Create semifinal round from qualified athletes
// ============================================================
app.post('/api/events/:id/create-semifinal', (req, res) => {
    const event = db.prepare('SELECT * FROM event WHERE id=?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const { group_count, selections } = req.body;
    if (!group_count || group_count < 1) return res.status(400).json({ error: 'group_count required (>=1)' });
    if (!selections || selections.length === 0) return res.status(400).json({ error: 'No selections' });

    const qualifiedIds = selections.filter(s => s.selected).map(s => s.event_entry_id);
    if (qualifiedIds.length === 0) return res.status(400).json({ error: 'No qualified athletes' });

    // Save qualification selections
    const upsertQ = db.prepare(`INSERT INTO qualification_selection (event_id,event_entry_id,selected,approved,approved_by)
        VALUES (?,?,1,1,'admin') ON CONFLICT(event_id,event_entry_id) DO UPDATE SET selected=1,approved=1,approved_by='admin',updated_at=datetime('now')`);

    let semiEventId;
    db.transaction(() => {
        // Save qualifications
        for (const eid of qualifiedIds) upsertQ.run(event.id, eid);

        // Create semifinal event
        const info = db.prepare(`INSERT INTO event (name,category,gender,round_type,round_status) VALUES (?,?,?,'semifinal','heats_generated')`)
            .run(event.name, event.category, event.gender);
        semiEventId = info.lastInsertRowid;

        // Distribute athletes into groups
        const perGroup = Math.ceil(qualifiedIds.length / group_count);
        for (let g = 0; g < group_count; g++) {
            const heatInfo = db.prepare('INSERT INTO heat (event_id,heat_number) VALUES (?,?)').run(semiEventId, g + 1);
            const heatId = heatInfo.lastInsertRowid;
            const groupIds = qualifiedIds.slice(g * perGroup, (g + 1) * perGroup);
            let lane = 1;
            for (const origEntryId of groupIds) {
                const origEntry = db.prepare('SELECT * FROM event_entry WHERE id=?').get(origEntryId);
                if (!origEntry) continue;
                const newEntry = db.prepare("INSERT INTO event_entry (event_id,athlete_id,status) VALUES (?,?,'registered')")
                    .run(semiEventId, origEntry.athlete_id);
                db.prepare('INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES (?,?,?)').run(heatId, newEntry.lastInsertRowid, lane++);
            }
        }
    })();

    audit('event', semiEventId, 'INSERT', null, { action: 'create_semifinal', source_event: event.id, groups: group_count });
    res.json({ success: true, semi_event_id: semiEventId, count: qualifiedIds.length, groups: group_count });
});

// ============================================================
// Export: All heats data for a given event (for unified download)
// ============================================================
app.get('/api/events/:id/full-results', (req, res) => {
    const event = db.prepare('SELECT * FROM event WHERE id=?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const heats = db.prepare('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number').all(event.id);
    const result = heats.map(h => {
        let entries;
        if (event.category === 'field_height') {
            entries = db.prepare(`
                SELECT he.lane_number, ee.id AS event_entry_id, ee.status,
                       a.name, a.bib_number, a.team
                FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id
                JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=? ORDER BY CAST(a.bib_number AS INTEGER)
            `).all(h.id);
            const heightAttempts = db.prepare('SELECT * FROM height_attempt WHERE heat_id=? ORDER BY bar_height, event_entry_id, attempt_number').all(h.id);
            return { ...h, entries, height_attempts: heightAttempts };
        } else {
            entries = db.prepare(`
                SELECT he.lane_number, ee.id AS event_entry_id, ee.status,
                       a.name, a.bib_number, a.team
                FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id
                JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=? ORDER BY CAST(a.bib_number AS INTEGER)
            `).all(h.id);
            const results = db.prepare('SELECT * FROM result WHERE heat_id=? ORDER BY event_entry_id, attempt_number').all(h.id);
            return { ...h, entries, results };
        }
    });

    res.json({ event, heats: result });
});

// ============================================================
// SSE — Server-Sent Events for real-time updates
// ============================================================
app.get('/api/sse', (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
    });
    res.write('event: connected\ndata: {}\n\n');
    sseClients.push(res);
    req.on('close', () => {
        sseClients = sseClients.filter(c => c !== res);
    });
});

// ============================================================
// Data Backup — export entire DB as JSON
// ============================================================
app.get('/api/admin/backup', (req, res) => {
    const tables = ['event', 'athlete', 'event_entry', 'heat', 'heat_entry', 'result', 'height_attempt', 'combined_score', 'qualification_selection', 'audit_log'];
    const backup = {};
    tables.forEach(t => {
        backup[t] = db.prepare(`SELECT * FROM ${t}`).all();
    });
    backup._timestamp = new Date().toISOString();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="pace-rise-backup-${new Date().toISOString().slice(0,10)}.json"`);
    res.json(backup);
});

// ============================================================
// Public Viewer Data — completed callrooms + results only
// ============================================================
app.get('/api/public/events', (req, res) => {
    // Return events that are in_progress or completed
    const events = db.prepare("SELECT * FROM event WHERE parent_event_id IS NULL AND round_status IN ('in_progress','completed') ORDER BY id").all();
    res.json(events);
});

app.get('/api/public/callroom-status', (req, res) => {
    // Return callroom completion info from audit log
    const logs = db.prepare("SELECT * FROM audit_log WHERE table_name='event' AND new_values LIKE '%callroom_complete%' ORDER BY created_at DESC LIMIT 50").all();
    const completedIds = new Set();
    logs.forEach(l => {
        try { const nv = JSON.parse(l.new_values); if (nv && nv.action === 'callroom_complete') completedIds.add(l.record_id); } catch {}
    });
    res.json({ completed_event_ids: Array.from(completedIds) });
});

// ============================================================
// Start
// ============================================================
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  Pace Rise Competition OS — port ${PORT}\n  http://localhost:${PORT}/demo/\n`);
});
