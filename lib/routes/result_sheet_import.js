'use strict';
/**
 * lib/routes/result_sheet_import.js — 결과 문자용 결과표 가져오기 (2026-11-08)
 *
 *   주최가 경기 운영을 하고 우리는 결과 문자만 보내는 대회: 주최가 주는 '이름·전화번호·소속·종목·기록' 엑셀을 올리면
 *   선수(이름+전화로 동일인) · 종목(성별·부별·종목·라운드, 없으면 만든다) · 조(기본 1조) · 기록(트랙 시간/거리/높이/상태)을 한 번에 넣는다.
 *   그다음은 기존 '문자 일괄 발송'(종목 × 선수 한 통씩)을 그대로 쓴다. 파싱은 lib/resultSheetImport.js.
 *
 *   POST /api/admin/result-sheet/preview   multipart(file, admin_key, competition_id)  → 읽은 행·종목 묶음·문제 (DB 변경 없음)
 *   POST /api/admin/result-sheet/import    multipart(file, admin_key, competition_id)  → 반영
 *
 *   반영 규칙: 선수 단위 교체 — 파일에 있는 (종목, 선수)의 기록만 다시 쓴다. 파일에 없는 선수·종목은 건드리지 않는다.
 *             같은 파일을 다시 올려도 결과가 같다(멱등). 순위 칸이 있으면 manual_rank 로 둔다(문자의 N위는 기록으로 다시 계산하지만 동률 처리에 쓰인다).
 */
const fs = require('fs');
const R = require('../resultSheetImport');

module.exports = function mountResultSheetImportRoutes(app, deps) {
    const { db, isAdminKey, opLog, broadcastSSE, upload } = deps;
    for (const [k, v] of Object.entries({ db, isAdminKey, opLog, upload })) if (!v) throw new Error(`[result_sheet_import] mount requires deps.${k}`);
    const keyOf = req => String((req.body && req.body.admin_key) || req.headers['x-admin-key'] || req.query.admin_key || req.query.key || '');

    /** 파일 → 행 + 종목 묶음 + 기존 선수 매칭 (미리보기·반영 공용) */
    async function analyze(compId, buffer) {
        const parsed = R.parseResultSheet(buffer);
        const groups = new Map();                                    // eventKeyStr → { key, label, rows, event }
        for (const row of parsed.rows) {
            const ks = R.eventKeyStr(row.eventKey);
            if (!groups.has(ks)) groups.set(ks, { key: ks, label: row.label, eventKey: row.eventKey, rows: [], event: null });
            groups.get(ks).rows.push(row);
        }
        const events = await db.all('SELECT * FROM event WHERE competition_id=? AND parent_event_id IS NULL', compId);
        for (const g of groups.values()) {
            const k = g.eventKey;
            g.event = events.find(e => e.name === k.name && e.gender === k.gender && e.round_type === k.round && (e.division || '') === (k.division || '')) || null;
        }
        const athletes = await db.all('SELECT id, name, team, phone, gender FROM athlete WHERE competition_id=?', compId);
        const byPhone = new Map(), byNameTeam = new Map();
        for (const a of athletes) {
            const p = R.normPhone(a.phone); if (p) { if (!byPhone.has(p)) byPhone.set(p, []); byPhone.get(p).push(a); }
            const nt = `${a.name}|${a.team || ''}`; if (!byNameTeam.has(nt)) byNameTeam.set(nt, []); byNameTeam.get(nt).push(a);
        }
        const seenNew = new Map();                                   // 이 파일 안에서 새로 만들 선수 (이름|전화 → 임시 키)
        for (const row of parsed.rows) {
            let a = null;
            if (row.phone && byPhone.has(row.phone)) a = byPhone.get(row.phone).find(x => x.name === row.name) || null;
            if (!a) { const l = byNameTeam.get(`${row.name}|${row.team || ''}`) || []; if (l.length === 1 && (!row.phone || !R.normPhone(l[0].phone) || R.normPhone(l[0].phone) === row.phone)) a = l[0]; }
            row.athlete_id = a ? a.id : null;
            row.athlete_new = !a;
            if (!a) { const nk = `${row.name}|${row.phone || row.team}`; if (!seenNew.has(nk)) seenNew.set(nk, true); }
        }
        const stats = {
            rows: parsed.rows.length, ok: parsed.rows.filter(r => !r.issues.length).length, with_issues: parsed.rows.filter(r => r.issues.length).length,
            events: groups.size, events_new: [...groups.values()].filter(g => !g.event).length,
            athletes: new Set(parsed.rows.map(r => r.athlete_id ? `id:${r.athlete_id}` : `new:${r.name}|${r.phone || r.team}`)).size,
            athletes_new: seenNew.size, no_phone: parsed.rows.filter(r => !r.phone).length,
            sendable: parsed.rows.filter(r => r.phone && r.name && r.eventKey.name && (r.status || r.value != null)).length,
        };
        return { parsed, groups: [...groups.values()], stats };
    }
    const canWrite = r => !!(r.name && r.eventKey.name && r.eventKey.gender && (r.status || r.value != null));

    app.post('/api/admin/result-sheet/preview', upload.single('file'), async (req, res) => {
        if (!isAdminKey(keyOf(req))) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        const compId = parseInt(req.body && req.body.competition_id, 10);
        if (!compId) return res.status(400).json({ error: 'competition_id 가 필요합니다.' });
        if (!req.file) return res.status(400).json({ error: '파일을 올리세요 (xlsx·csv).' });
        try {
            const comp = await db.get('SELECT id, name FROM competition WHERE id=?', compId);
            if (!comp) return res.status(404).json({ error: '대회를 찾을 수 없습니다.' });
            const { parsed, groups, stats } = await analyze(compId, fs.readFileSync(req.file.path));
            res.json({ success: true, header: parsed.header, sheets: parsed.sheets, issues: parsed.issues, stats,
                groups: groups.map(g => ({ key: g.key, label: g.label, count: g.rows.length, writable: g.rows.filter(canWrite).length, event: g.event ? { id: g.event.id, name: g.event.name } : null })),
                rows: parsed.rows.map(r => ({ line: r.line, sheet: r.sheet, name: r.name, phone: r.phone, team: r.team, label: r.label, record: r.recordRaw, status: r.status, value: r.value, rank: r.rank, heat: r.heat, athlete_new: r.athlete_new, issues: r.issues, writable: canWrite(r) })) });
        } catch (e) { res.status(400).json({ error: e.message }); }
        finally { try { fs.unlinkSync(req.file.path); } catch (e) {} }
    });

    app.post('/api/admin/result-sheet/import', upload.single('file'), async (req, res) => {
        if (!isAdminKey(keyOf(req))) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        const compId = parseInt(req.body && req.body.competition_id, 10);
        if (!compId) return res.status(400).json({ error: 'competition_id 가 필요합니다.' });
        if (!req.file) return res.status(400).json({ error: '파일을 올리세요 (xlsx·csv).' });
        try {
            const comp = await db.get('SELECT * FROM competition WHERE id=?', compId);
            if (!comp) return res.status(404).json({ error: '대회를 찾을 수 없습니다.' });
            const { parsed, groups, stats } = await analyze(compId, fs.readFileSync(req.file.path));
            const out = { events_created: 0, heats_created: 0, athletes_created: 0, phone_updated: 0, results: 0, skipped: 0 };
            const ownNew = new Map();                                // 이 파일 안에서 만든 선수 재사용 (한 아이가 두 종목)
            const maxSort = await db.get('SELECT COALESCE(MAX(sort_order),0) AS m FROM event WHERE competition_id=?', compId);
            let sort = Number(maxSort.m || 0);
            await db.transaction(async () => {
                for (const g of groups) {
                    const k = g.eventKey;
                    const rows = g.rows.filter(canWrite);
                    out.skipped += g.rows.length - rows.length;
                    if (!rows.length) continue;
                    let ev = g.event;
                    if (!ev) {
                        sort += 10;
                        const r = await db.run('INSERT INTO event (competition_id, name, category, sort_order, gender, round_type, round_status, division) VALUES (?,?,?,?,?,?,?,?)',
                            compId, k.name, k.category, sort, k.gender, k.round, 'created', k.division || '');
                        ev = await db.get('SELECT * FROM event WHERE id=?', r.lastInsertRowid); out.events_created++;
                    }
                    const heatCache = new Map();
                    const heatOf = async (no) => {
                        if (heatCache.has(no)) return heatCache.get(no);
                        let h = await db.get('SELECT * FROM heat WHERE event_id=? AND heat_number=?', ev.id, no);
                        if (!h) { const r = await db.run('INSERT INTO heat (event_id, heat_number) VALUES (?,?)', ev.id, no); h = { id: r.lastInsertRowid, heat_number: no }; out.heats_created++; }
                        heatCache.set(no, h); return h;
                    };
                    let order = 0;
                    for (const row of rows) {
                        order++;
                        // 선수
                        let athleteId = row.athlete_id;
                        if (!athleteId) {
                            const nk = `${row.name}|${row.phone || row.team}`;
                            if (ownNew.has(nk)) athleteId = ownNew.get(nk);
                            else {
                                const g2 = k.gender === 'F' ? 'F' : 'M';
                                let r = null;
                                for (const nm of [row.name, `${row.name} (${row.team || row.phone.slice(-4)})`]) {
                                    try { r = await db.run('INSERT INTO athlete (competition_id, name, team, gender, phone, barcode) VALUES (?,?,?,?,?,?)', compId, nm, row.team || '', g2, row.phone || '', `RS:${compId}:${row.phone || nm}:${row.team || ''}`.slice(0, 60)); break; }
                                    catch (e) { if (!/UNIQUE|duplicate|23505/i.test(String(e.message || e.code))) throw e; }
                                }
                                if (!r) { out.skipped++; continue; }
                                athleteId = r.lastInsertRowid; ownNew.set(nk, athleteId); out.athletes_created++;
                            }
                        } else if (row.phone) {
                            const cur = await db.get('SELECT phone FROM athlete WHERE id=?', athleteId);
                            if (cur && R.normPhone(cur.phone) !== row.phone) { await db.run('UPDATE athlete SET phone=? WHERE id=?', row.phone, athleteId); out.phone_updated++; }
                        }
                        // 출전 · 조
                        let ee = await db.get('SELECT id FROM event_entry WHERE event_id=? AND athlete_id=?', ev.id, athleteId);
                        if (!ee) { const r = await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?,'registered')", ev.id, athleteId); ee = { id: r.lastInsertRowid }; }
                        if (row.status === 'DNS') await db.run("UPDATE event_entry SET status='no_show' WHERE id=?", ee.id);
                        else await db.run("UPDATE event_entry SET status='registered' WHERE id=? AND status='no_show'", ee.id);
                        await db.run('UPDATE event_entry SET manual_rank=? WHERE id=?', row.rank, ee.id);
                        const h = await heatOf(row.heat || 1);
                        const he = await db.get('SELECT id FROM heat_entry WHERE heat_id=? AND event_entry_id=?', h.id, ee.id);
                        if (!he) await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?,?,?)', h.id, ee.id, row.rank || order);
                        // 기록 (선수 단위 교체)
                        await db.run('DELETE FROM result WHERE heat_id=? AND event_entry_id=?', h.id, ee.id);
                        await db.run('DELETE FROM height_attempt WHERE heat_id=? AND event_entry_id=?', h.id, ee.id);
                        if (row.status) {
                            await db.run('INSERT INTO result (heat_id, event_entry_id, attempt_number, status_code, remark) VALUES (?,?,NULL,?,?)', h.id, ee.id, row.status, row.remark || '');
                        } else if (k.category === 'field_height') {
                            await db.run("INSERT INTO height_attempt (heat_id, event_entry_id, bar_height, attempt_number, result_mark) VALUES (?,?,?,1,'O')", h.id, ee.id, row.value);
                        } else if (k.category === 'field_distance') {
                            await db.run('INSERT INTO result (heat_id, event_entry_id, attempt_number, distance_meters, remark) VALUES (?,?,1,?,?)', h.id, ee.id, row.value, row.remark || '');
                        } else if (k.category === 'combined') {
                            await db.run('INSERT INTO result (heat_id, event_entry_id, attempt_number, distance_meters, remark) VALUES (?,?,NULL,?,?)', h.id, ee.id, row.value, row.remark || '');
                        } else {
                            await db.run('INSERT INTO result (heat_id, event_entry_id, attempt_number, time_seconds, remark) VALUES (?,?,NULL,?,?)', h.id, ee.id, row.value, row.remark || '');
                        }
                        out.results++;
                    }
                    await db.run("UPDATE event SET round_status='completed' WHERE id=?", ev.id);
                }
            })();
            opLog(`결과표 가져오기(문자용): 행 ${parsed.rows.length} · 기록 ${out.results}건 · 종목 ${groups.length}개(새 ${out.events_created}) · 새 선수 ${out.athletes_created}명${out.phone_updated ? ` · 전화 갱신 ${out.phone_updated}` : ''}${out.skipped ? ` · 건너뜀 ${out.skipped}` : ''}`, 'admin', 'admin', compId);
            if (broadcastSSE) { try { broadcastSSE('result_update', { competition_id: compId, source: 'result-sheet' }); } catch (e) {} }
            res.json({ success: true, stats, ...out, issues: parsed.issues, groups: groups.map(g => ({ key: g.key, label: g.label, count: g.rows.length, writable: g.rows.filter(canWrite).length })) });
        } catch (e) { console.error('[result-sheet/import]', e); res.status(500).json({ error: e.message }); }
        finally { try { fs.unlinkSync(req.file.path); } catch (e) {} }
    });
};
