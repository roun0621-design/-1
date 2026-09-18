'use strict';
/**
 * 소집(콜룸) · 경기 완료 — server.js 에서 추출 (2026-09 Phase 4)
 *   POST /api/callroom/checkin (배번·바코드 출석) · /api/combined/sync-checkin · /api/events/:id/complete(경기 완료) ·
 *   /api/events/:id/callroom-complete · /api/events/callroom-complete-batch · /api/events/callroom-revert-batch
 *   반환 { syncCombinedSubEventCheckin } — 소집 상태 변경 라우트(server.js)가 종합경기 세부종목 동기화에 쓴다
 *   ※ 동작은 인라인 시절과 동일 — 회귀: tests/flows/04_callroom_checkin, tests/api/28_force_complete, 30_combined_autosync, 38_comp_end_lock
 */
module.exports = function mountCallroomRoutes(app, deps) {
    const { db, isOperationKey, isAdminKey, opLog, broadcastSSE, audit, notifyEventInterest } = deps;
    for (const [k, v] of Object.entries({ db, isOperationKey, isAdminKey, opLog, broadcastSSE, audit, notifyEventInterest })) {
        if (!v) throw new Error(`[callroom] mount requires deps.${k}`);
    }

    app.post('/api/callroom/checkin', async (req, res) => {
        const { barcode, event_id, admin_key } = req.body;
        if (!barcode) return res.status(400).json({ error: 'barcode required' });

        // Determine competition_id from event_id for scoped athlete search
        let competition_id = null;
        if (event_id) {
            const evt = await db.get('SELECT competition_id FROM event WHERE id=?', event_id);
            if (evt) competition_id = evt.competition_id;
        }
        // Post-competition lock removed for callroom — callroom stays accessible after competition ends

        // ── Robust barcode normalization ──
        // Supports: PR-298, PR0298, PR298, 298, PR2026298, W63 (female by bib)
        const raw = barcode.trim();

        // ── W/w prefix → female athlete by bib number ──
        const wMatch = raw.match(/^[Ww][-]?(\d+)$/);
        if (wMatch) {
            const bibNum = wMatch[1].replace(/^0+/, '') || '0';
            let athlete = null;
            if (competition_id) {
                athlete = await db.get("SELECT * FROM athlete WHERE bib_number=? AND gender='F' AND competition_id=?", bibNum, competition_id);
            }
            if (!athlete) {
                athlete = await db.get("SELECT * FROM athlete WHERE bib_number=? AND gender='F'", bibNum);
            }
            if (!athlete) return res.status(404).json({ error: `여자 배번 ${bibNum} 선수를 찾을 수 없습니다`, barcode });
            // Jump directly to entry lookup (skip normal barcode search)
            return await continueCheckin(res, athlete, event_id, competition_id);
        }

        // ── Normal barcode variants ──
        const variants = new Set();
        variants.add(raw);
        let numPart = null;
        const pr2026Match = raw.match(/^PR2026(\d+)$/i);
        const prMatch = raw.match(/^PR[-]?0*(\d+)$/i);
        if (pr2026Match) numPart = pr2026Match[1];
        else if (prMatch) numPart = prMatch[1];
        else if (/^\d+$/.test(raw)) numPart = raw.replace(/^0+/, '') || '0';
        if (numPart) {
            variants.add(`PR-${numPart}`);
            variants.add(`PR${numPart}`);
            variants.add(`PR${numPart.padStart(4, '0')}`);
            variants.add(numPart);
            variants.add(numPart.padStart(2, '0'));
        }
        const variantArr = [...variants];

        // (2026-09) 후보를 '전부' 모은 뒤 고른다. 남·여가 같은 배번을 쓰는 대회가 많은데(예천: 남 25·여 25 모두 존재)
        //   예전엔 배번이 같은 첫 선수를 그대로 써서, 여자 100m 소집에서 "25"를 치면 남자 25번이 다른 종목에 출석 처리됐다.
        //   우선순위: ① 지금 소집 중인 종목에 등록된 선수 ② 그 종목과 성별이 같은 선수 ③ 첫 후보
        async function findCandidates(scope) {
            const out = []; const seen = new Set();
            const push = rows => { for (const a of rows || []) if (!seen.has(a.id)) { seen.add(a.id); out.push(a); } };
            for (const v of variantArr) push(scope ? await db.all('SELECT * FROM athlete WHERE barcode=? AND competition_id=?', v, scope) : await db.all('SELECT * FROM athlete WHERE barcode=?', v));
            for (const v of variantArr) push(scope ? await db.all('SELECT * FROM athlete WHERE bib_number=? AND competition_id=?', v, scope) : await db.all('SELECT * FROM athlete WHERE bib_number=?', v));
            return out;
        }
        async function pickAthlete(cands) {
            if (!cands.length) return null;
            if (event_id) {
                for (const a of cands) { if (await db.get('SELECT id FROM event_entry WHERE event_id=? AND athlete_id=?', event_id, a.id)) return a; }
                const ev = await db.get('SELECT gender FROM event WHERE id=?', event_id);
                if (ev && ev.gender && ev.gender !== 'X') { const g = cands.find(a => a.gender === ev.gender); if (g) return g; }
            }
            return cands[0];
        }

        let athlete = null;
        if (competition_id) athlete = await pickAthlete(await findCandidates(competition_id));
        // 대회를 알 수 없을 때만 전체에서 찾는다 (대회가 정해져 있는데 다른 대회 선수를 출석 처리하면 안 된다)
        if (!athlete && !competition_id) athlete = await pickAthlete(await findCandidates(null));
        if (!athlete) return res.status(404).json({ error: '선수를 찾을 수 없습니다', barcode });
        return await continueCheckin(res, athlete, event_id, competition_id);
    });

    // Shared checkin logic: find entry → update status → respond
    async function continueCheckin(res, athlete, event_id, competition_id) {
        let entry;
        if (event_id) {
            entry = await db.get('SELECT * FROM event_entry WHERE event_id=? AND athlete_id=?', event_id, athlete.id);
            if (!entry) {
                let cid = competition_id;
                if (!cid) {
                    const evRow = await db.get('SELECT competition_id FROM event WHERE id=?', event_id);
                    cid = evRow ? evRow.competition_id : null;
                }
                if (cid) {
                    const allEntries = await db.all(`
                        SELECT ee.*, e.name as event_name FROM event_entry ee 
                        JOIN event e ON ee.event_id=e.id 
                        WHERE ee.athlete_id=? AND e.competition_id=?
                        ORDER BY CASE ee.status WHEN 'registered' THEN 0 WHEN 'checked_in' THEN 1 ELSE 2 END
                    `, athlete.id, cid);
                    if (allEntries.length > 0) {
                        entry = allEntries.find(e => e.status === 'registered') || allEntries[0];
                    }
                }
            }
        } else {
            entry = await db.get("SELECT * FROM event_entry WHERE athlete_id=? AND status='registered' LIMIT 1", athlete.id);
        }
        if (!entry) return res.status(404).json({ error: '해당 종목에 등록되지 않은 선수입니다', athlete: { name: athlete.name, bib: athlete.bib_number } });

        const wasAlready = entry.status === 'checked_in';
        if (!wasAlready) {
            await db.run("UPDATE event_entry SET status='checked_in' WHERE id=?", entry.id);
            await syncCombinedSubEventCheckin(entry.event_id, athlete.id, 'checked_in');
            const _he2 = await db.get('SELECT heat_id FROM heat_entry WHERE event_entry_id=?', entry.id);
            broadcastSSE('entry_status', { event_entry_id: entry.id, status: 'checked_in', event_id: entry.event_id, heat_id: _he2 ? _he2.heat_id : null });
        }

        const heatEntry = await db.get(`SELECT he.heat_id, h.heat_number FROM heat_entry he JOIN heat h ON he.heat_id=h.id WHERE he.event_entry_id=?`, entry.id);

        res.json({
            success: true, already: wasAlready, athlete,
            entry: { ...entry, status: 'checked_in' },
            heat_id: heatEntry ? heatEntry.heat_id : null,
            heat_number: heatEntry ? heatEntry.heat_number : null,
            event_id: entry.event_id
        });
    }

    // Helper: sync combined sub-event entries when parent is checked in
    async function syncCombinedSubEventCheckin(parentEventId, athleteId, status) {
        const parentEvt = await db.get('SELECT * FROM event WHERE id=?', parentEventId);
        if (!parentEvt || parentEvt.category !== 'combined') return;
        const subEvents = await db.all('SELECT id FROM event WHERE parent_event_id=?', parentEventId);
        for (const sub of subEvents) {
            const subEntry = await db.get('SELECT * FROM event_entry WHERE event_id=? AND athlete_id=?', sub.id, athleteId);
            if (subEntry && subEntry.status !== status) {
                await db.run('UPDATE event_entry SET status=? WHERE id=?', status, subEntry.id);
            }
        }
    }

    // Bulk sync: set all sub-event entries to match parent checked_in status
    app.post('/api/combined/sync-checkin', async (req, res) => {
        const { event_id } = req.body;
        if (!event_id) return res.status(400).json({ error: 'event_id required' });
        const evt = await db.get('SELECT * FROM event WHERE id=?', event_id);
        if (!evt || evt.category !== 'combined') return res.status(400).json({ error: 'Not a combined event' });
        const parentEntries = await db.all('SELECT * FROM event_entry WHERE event_id=?', event_id);
        const subEvents = await db.all('SELECT id FROM event WHERE parent_event_id=?', event_id);
        let synced = 0;
        await db.transaction(async () => {
            for (const pe of parentEntries) {
                for (const sub of subEvents) {
                    const subEntry = await db.get('SELECT * FROM event_entry WHERE event_id=? AND athlete_id=?', sub.id, pe.athlete_id);
                    if (subEntry && subEntry.status !== pe.status) {
                        await db.run('UPDATE event_entry SET status=? WHERE id=?', pe.status, subEntry.id);
                        synced++;
                    }
                }
            }
        })();
        res.json({ success: true, synced });
    });


    // ============================================================
    // ROUND MANAGEMENT
    // ============================================================
    app.post('/api/events/:id/complete', async (req, res) => {
        const { judge_name, admin_key } = req.body;
        if (!isOperationKey(admin_key)) return res.status(403).json({ error: '유효하지 않은 운영키입니다.' });
        if (!judge_name || !judge_name.trim()) return res.status(400).json({ error: 'Judge name required' });
        const event = await db.get('SELECT * FROM event WHERE id=?', req.params.id);
        if (!event) return res.status(404).json({ error: 'Event not found' });
        if (event.round_status === 'completed') return res.status(400).json({ error: '이미 완료된 경기입니다.' });
        // 기록이 하나도 없거나 소집 전(created/heats_generated)이어도 강제 완료 허용 (현장 요청 2026-09).
        // 되돌리기는 /revert-complete (관리자). 운영 로그에 '강제' 표기.
        const forced = event.round_status !== 'in_progress';
        const resultCntRow = await db.get('SELECT COUNT(*) as cnt FROM result r JOIN heat h ON h.id = r.heat_id WHERE h.event_id = ?', event.id);
        const noRecords = !resultCntRow || !resultCntRow.cnt;
        await db.run("UPDATE event SET round_status='completed' WHERE id=?", event.id);
        broadcastSSE('event_completed', { event_id: event.id, judge_name });
        const gL = event.gender === 'M' ? '남자' : event.gender === 'F' ? '여자' : '혼성';
        const roundL = { preliminary: '예선', semifinal: '준결승', final: '결승' }[event.round_type] || event.round_type;
        if (forced || noRecords) opLog(`${event.name} ${roundL} 강제 완료 (${forced ? '진행중 아님: ' + event.round_status : ''}${forced && noRecords ? ', ' : ''}${noRecords ? '기록 없음' : ''}) - ${judge_name}`, 'completion', judge_name, event.competition_id);
        // 관심 종목 알림 — 경기완료(결과 확정)
        notifyEventInterest(event, { kind: 'result', title: `${gL} ${event.division ? event.division + ' ' : ''}${event.name} 결과 발표`, body: `${roundL} 경기가 완료되어 결과가 올라왔습니다.` }).catch(() => {});
        opLog(`${event.name} ${roundL} 경기완료 - ${judge_name}`, 'completion', judge_name, event.competition_id);
        res.json({ success: true, event: await db.get('SELECT * FROM event WHERE id=?', event.id) });
    });
    app.post('/api/events/:id/revert-complete', async (req, res) => {
        const { admin_key } = req.body;
        if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        const event = await db.get('SELECT * FROM event WHERE id=?', req.params.id);
        if (!event) return res.status(404).json({ error: 'Event not found' });
        if (event.round_status !== 'completed') return res.status(400).json({ error: '완료 상태의 경기만 되돌릴 수 있습니다.' });
        await db.run("UPDATE event SET round_status='in_progress' WHERE id=?", event.id);
        broadcastSSE('event_reverted', { event_id: event.id });
        opLog(`${event.name} 경기완료 취소 (관리자)`, 'revert', 'admin', event.competition_id);
        res.json({ success: true, event: await db.get('SELECT * FROM event WHERE id=?', event.id) });
    });
    app.post('/api/events/:id/callroom-complete', async (req, res) => {
        const { judge_name, heat_id, admin_key } = req.body;
        const event = await db.get('SELECT * FROM event WHERE id=?', req.params.id);
        if (!event) return res.status(404).json({ error: 'Event not found' });
        // Post-competition lock removed for callroom — callroom stays accessible after competition ends
        if (event.round_status === 'completed') return res.status(400).json({ error: '이미 완료된 경기입니다.' });
        // Allow multiple callroom-complete calls for different heats (예선 1조, 2조, etc.)
        if (event.round_status !== 'in_progress') {
            await db.run("UPDATE event SET round_status='in_progress' WHERE id=?", event.id);
        }
        const performer = judge_name || 'operator';
        const roundL = { preliminary: '예선', semifinal: '준결승', final: '결승' }[event.round_type] || event.round_type;
        // If heat_id provided, identify which heat number
        let heatLabel = '';
        if (heat_id) {
            const heats = await db.all('SELECT id FROM heat WHERE event_id=? ORDER BY heat_number', event.id);
            const heatIdx = heats.findIndex(h => h.id === parseInt(heat_id));
            if (heatIdx >= 0) heatLabel = ` ${heatIdx + 1}조`;
        }
        // Auto-insert DNS result for no_show entries in the relevant heat(s)
        let dnsCount = 0;
        const targetHeats = heat_id
            ? [await db.get('SELECT * FROM heat WHERE id=?', parseInt(heat_id))]
            : await db.all('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number', event.id);
        for (const h of targetHeats) {
            if (!h) continue;
            const noShowEntries = await db.all(`
                SELECT he.event_entry_id FROM heat_entry he
                JOIN event_entry ee ON ee.id = he.event_entry_id
                WHERE he.heat_id = ? AND ee.status = 'no_show'
            `, h.id);
            for (const ns of noShowEntries) {
                // Only insert if no result row exists yet for this entry in this heat
                const existing = await db.get('SELECT id FROM result WHERE heat_id=? AND event_entry_id=? LIMIT 1', h.id, ns.event_entry_id);
                if (!existing) {
                    await db.run(`INSERT OR IGNORE INTO result (heat_id, event_entry_id, attempt_number, status_code) VALUES (?, ?, NULL, 'DNS')`, h.id, ns.event_entry_id);
                    dnsCount++;
                }
            }
        }
        if (dnsCount > 0) {
            opLog(`${event.name} ${roundL}${heatLabel} 결석 선수 ${dnsCount}명 DNS 자동 처리`, 'callroom', performer, event.competition_id);
        }

        audit('event', event.id, 'UPDATE', { round_status: event.round_status }, { action: 'callroom_complete', round_status: 'in_progress', heat_id: heat_id || null }, performer, event.competition_id, req);
        broadcastSSE('callroom_complete', { event_id: event.id, judge_name: performer, heat_id: heat_id || null });
        // 관심 종목 알림 — 소집 완료
        { const _gL = event.gender === 'M' ? '남자' : event.gender === 'F' ? '여자' : '혼성';
          notifyEventInterest(event, { kind: 'callroom', title: `${_gL} ${event.division ? event.division + ' ' : ''}${event.name} 소집 완료`, body: `소집이 완료되어 곧 경기가 시작됩니다.` }).catch(() => {}); }
        opLog(`${event.name} ${roundL}${heatLabel} 소집 완료 - ${performer}`, 'callroom', performer, event.competition_id);
        res.json({ success: true, dns_auto: dnsCount });
    });

    // ============================================================
    // 일괄 소집완료 / 되돌리기 (부별·다중선택 운영용)
    //   - 여러 종목을 한 번에 소집완료(in_progress) 또는 되돌림(heats_generated)
    //   - 푸시 알림은 스팸 방지를 위해 발송하지 않음(단일 소집완료만 발송)
    // ============================================================
    app.post('/api/events/callroom-complete-batch', async (req, res) => {
        const { event_ids, judge_name } = req.body;
        // 단일 소집완료(/callroom-complete)와 동일하게 현장 운영자용 — 별도 키 요구 없음(프론트 확인창이 안전장치)
        if (!Array.isArray(event_ids) || event_ids.length === 0) return res.status(400).json({ error: '종목을 선택하세요.' });
        const performer = judge_name || 'operator';
        const done = [], skipped = [];
        let compId = null;
        for (const eid of event_ids) {
            const event = await db.get('SELECT * FROM event WHERE id=?', eid);
            if (!event) { skipped.push({ id: eid, reason: 'not_found' }); continue; }
            compId = event.competition_id;
            if (event.round_status === 'completed') { skipped.push({ id: eid, reason: 'completed' }); continue; }
            if (event.round_status !== 'in_progress') {
                await db.run("UPDATE event SET round_status='in_progress' WHERE id=?", event.id);
            }
            // 등록 선수 전원 자동 출석(checked_in) — 일괄 소집은 개별 출석 단계를 건너뛰므로
            // 이 처리가 없으면 기록입력 화면에 "소집이 완료된 선수가 없습니다"로 뜬다.
            // no_show(결석)는 유지하고 registered 만 checked_in 으로 전환.
            await db.run(`UPDATE event_entry SET status='checked_in'
                WHERE status='registered' AND id IN (
                    SELECT he.event_entry_id FROM heat_entry he JOIN heat h ON h.id=he.heat_id WHERE h.event_id=?
                )`, event.id);
            // 결석(no_show) 선수 DNS 자동 처리 (단일 소집완료와 동일)
            const heats = await db.all('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number', event.id);
            for (const h of heats) {
                const noShow = await db.all(`SELECT he.event_entry_id FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id WHERE he.heat_id=? AND ee.status='no_show'`, h.id);
                for (const ns of noShow) {
                    const ex = await db.get('SELECT id FROM result WHERE heat_id=? AND event_entry_id=? LIMIT 1', h.id, ns.event_entry_id);
                    if (!ex) await db.run(`INSERT OR IGNORE INTO result (heat_id,event_entry_id,attempt_number,status_code) VALUES (?,?,NULL,'DNS')`, h.id, ns.event_entry_id);
                }
            }
            audit('event', event.id, 'UPDATE', { round_status: event.round_status }, { action: 'callroom_complete', round_status: 'in_progress', batch: true }, performer, event.competition_id, req);
            broadcastSSE('callroom_complete', { event_id: event.id, judge_name: performer, heat_id: null });
            done.push(event.id);
        }
        if (done.length) opLog(`일괄 소집완료: ${done.length}개 종목 - ${performer}`, 'callroom', performer, compId);
        res.json({ success: true, completed: done.length, skipped });
    });

    app.post('/api/events/callroom-revert-batch', async (req, res) => {
        const { event_ids, judge_name } = req.body;
        if (!Array.isArray(event_ids) || event_ids.length === 0) return res.status(400).json({ error: '종목을 선택하세요.' });
        const performer = judge_name || 'operator';
        const reverted = [], blocked = [];
        let compId = null;
        for (const eid of event_ids) {
            const event = await db.get('SELECT * FROM event WHERE id=?', eid);
            if (!event) continue;
            compId = event.competition_id;
            if (event.round_status !== 'in_progress') { blocked.push({ id: eid, reason: 'not_in_progress' }); continue; }
            // 실기록(비 DNS)이 하나라도 있으면 되돌리기 금지 (이미 기록 입력 시작)
            const realResult = await db.get(`SELECT r.id FROM result r JOIN heat h ON h.id=r.heat_id WHERE h.event_id=? AND (r.time_seconds IS NOT NULL OR r.distance_meters IS NOT NULL OR (r.status_code IS NOT NULL AND r.status_code<>'DNS')) LIMIT 1`, event.id);
            if (realResult) { blocked.push({ id: eid, reason: 'has_results' }); continue; }
            // 자동 DNS만 제거 후 소집전(heats_generated) 상태로 되돌림
            await db.run(`DELETE FROM result WHERE heat_id IN (SELECT id FROM heat WHERE event_id=?) AND status_code='DNS' AND time_seconds IS NULL AND distance_meters IS NULL`, event.id);
            // 일괄 소집완료 시 자동 출석(checked_in) 처리한 것을 되돌림 (checked_in → registered)
            await db.run(`UPDATE event_entry SET status='registered'
                WHERE status='checked_in' AND id IN (
                    SELECT he.event_entry_id FROM heat_entry he JOIN heat h ON h.id=he.heat_id WHERE h.event_id=?
                )`, event.id);
            await db.run("UPDATE event SET round_status='heats_generated' WHERE id=?", event.id);
            audit('event', event.id, 'UPDATE', { round_status: 'in_progress' }, { action: 'callroom_revert', round_status: 'heats_generated', batch: true }, performer, event.competition_id, req);
            broadcastSSE('event_status_changed', { event_id: event.id, round_status: 'heats_generated' });
            reverted.push(event.id);
        }
        if (reverted.length) opLog(`일괄 소집 되돌리기: ${reverted.length}개 종목 - ${performer}`, 'callroom', performer, compId);
        res.json({ success: true, reverted: reverted.length, blocked });
    });

    return { syncCombinedSubEventCheckin };
};
