'use strict';
/**
 * 관리자 선수·종목·조 관리(공개 선수 조회, 선수 CRUD·출전, 종목 CRUD·자동정렬·영상 URL, 조 추가/삭제/선수 이동, 상태 강제 변경) — server.js 에서 이동 (2026-09-22, Phase 4 분해). 동작은 인라인 시절과 같다.
 *   deps: _undo, _undoSnapshotEvent, audit, autoLinkDisplayTimetable, broadcastSSE, db, getJudgeName, isAdminKey, isOperationKey, opLog, orderByBibSql
 */
module.exports = function mountAdminEventsRoutes(app, deps) {
    const { _undo, _undoSnapshotEvent, audit, autoLinkDisplayTimetable, broadcastSSE, db, getJudgeName, isAdminKey, isOperationKey, opLog, orderByBibSql } = deps;
    for (const k of ["_undo","_undoSnapshotEvent","audit","autoLinkDisplayTimetable","broadcastSSE","db","getJudgeName","isAdminKey","isOperationKey","opLog","orderByBibSql"]) if (deps[k] === undefined) throw new Error('[admin_events.js] mount requires deps.' + k);

    // ============================================================
    // PUBLIC: Athletes by competition (callroom / record use)
    // ============================================================
    app.get('/api/athletes', async (req, res) => {
        const compId = req.query.competition_id;
        if (!compId) return res.status(400).json({ error: 'competition_id 필요' });
        res.json(await db.all(`SELECT * FROM athlete WHERE competition_id=? ORDER BY ${orderByBibSql()}, id`, compId));
    });

    // Athlete entries — list events an athlete is entered in
    app.get('/api/athletes/:id/entries', async (req, res) => {
        const athleteId = req.params.id;
        try {
            const rows = await db.all(`
                SELECT ee.id as event_entry_id, ee.event_id, ee.status,
                       e.name as event_name, e.round_type, e.category, e.gender,
                       he.heat_id, he.lane_number,
                       h.heat_number
                FROM event_entry ee
                JOIN event e ON e.id = ee.event_id
                LEFT JOIN heat_entry he ON he.event_entry_id = ee.id
                LEFT JOIN heat h ON h.id = he.heat_id
                WHERE ee.athlete_id = ?
                ORDER BY e.sort_order, e.name
            `, athleteId);
            res.json(rows);
        } catch (e) { res.json([]); }
    });

    // ============================================================
    // ADMIN: ATHLETE CRUD (scoped to competition)
    // ============================================================
    app.get('/api/admin/athletes', async (req, res) => {
        if (!isAdminKey(req.query.key) && !isOperationKey(req.query.key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
        const compId = req.query.competition_id;
        if (compId) return res.json(await db.all(`SELECT * FROM athlete WHERE competition_id=? ORDER BY ${orderByBibSql()}`, compId));
        res.json(await db.all(`SELECT * FROM athlete ORDER BY ${orderByBibSql()}`));
    });
    // 전화번호 정규화 (CRUD 공용)
    function _normalizeAthletePhone(p) {
        if (p === undefined || p === null) return '';
        let s = String(p).trim();
        if (!s) return '';
        s = s.replace(/[^0-9+]/g, '');
        if (s.startsWith('+82')) s = '0' + s.slice(3);
        else if (s.startsWith('82') && s.length >= 11) s = '0' + s.slice(2);
        if (/^1\d{9}$/.test(s)) s = '0' + s;
        return s;
    }

    // 학년: 1~6 정수만, 그 밖은 null (학년별 대회·연맹 명단용, Phase 7-②)
    function _normalizeGrade(g) { const n = parseInt(String(g == null ? '' : g).replace(/[^0-9]/g, ''), 10); return n >= 1 && n <= 6 ? n : null; }

    app.post('/api/admin/athletes', async (req, res) => {
        const { admin_key, competition_id, name, bib_number, team, gender, barcode, phone, grade } = req.body;
        if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
        if (!name || !gender || !competition_id) return res.status(400).json({ error: '필수 항목이 누락되었습니다 (이름, 성별, 대회ID).' });
        try {
            const bib = bib_number ? String(bib_number).trim() : null;
            const bc = barcode || '';
            const ph = _normalizeAthletePhone(phone);
            const info = await db.run('INSERT INTO athlete (competition_id,name,bib_number,team,barcode,gender,phone,grade) VALUES (?,?,?,?,?,?,?,?)', competition_id, name, bib, team || '', bc, gender, ph, _normalizeGrade(grade));
            res.json(await db.get('SELECT * FROM athlete WHERE id=?', info.lastInsertRowid));
        } catch (e) { res.status(400).json({ error: '등록 오류: ' + e.message }); }
    });
    app.put('/api/admin/athletes/:id', async (req, res) => {
        const { admin_key, name, bib_number, team, gender, barcode, phone, grade } = req.body;
        if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
        const old = await db.get('SELECT * FROM athlete WHERE id=?', req.params.id);
        if (!old) return res.status(404).json({ error: 'Not found' });
        try {
            const newBib = bib_number !== undefined ? (bib_number ? String(bib_number).trim() : null) : old.bib_number;
            const newPhone = phone !== undefined ? _normalizeAthletePhone(phone) : (old.phone || '');
            await db.run('UPDATE athlete SET name=?,bib_number=?,team=?,gender=?,barcode=?,phone=?,grade=? WHERE id=?', name || old.name, newBib, team ?? old.team, gender || old.gender, barcode ?? old.barcode, newPhone, grade === undefined ? old.grade : _normalizeGrade(grade), old.id);
            res.json(await db.get('SELECT * FROM athlete WHERE id=?', old.id));
        } catch (e) { res.status(400).json({ error: '수정 오류: ' + e.message }); }
    });
    app.delete('/api/admin/athletes/:id', async (req, res) => {
        const { admin_key } = req.body;
        if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
        const ath = await db.get('SELECT * FROM athlete WHERE id=?', req.params.id);
        if (!ath) return res.status(404).json({ error: 'Not found' });
        // 되돌리기용 스냅샷 (선수 + 출전·조·기록·시기·종합 점수·진출·계주 주자)
        let undoId = null;
        try {
            const snap = await _undo.snapshot(db, {
                competition_id: ath.competition_id, kind: 'athlete_delete', role: isAdminKey(admin_key) ? 'admin' : 'operation', performed_by: getJudgeName(admin_key) || '',
                label: `선수 삭제: ${ath.name}${ath.team ? ' (' + ath.team + ')' : ''}${ath.bib_number ? ' #' + ath.bib_number : ''}`,
                tables: [
                    { table: 'athlete', where: 'id=?', params: [ath.id] },
                    { table: 'event_entry', where: 'athlete_id=?', params: [ath.id] },
                    { table: 'heat_entry', where: 'event_entry_id IN (SELECT id FROM event_entry WHERE athlete_id=?)', params: [ath.id] },
                    { table: 'result', where: 'event_entry_id IN (SELECT id FROM event_entry WHERE athlete_id=?)', params: [ath.id] },
                    { table: 'height_attempt', where: 'event_entry_id IN (SELECT id FROM event_entry WHERE athlete_id=?)', params: [ath.id] },
                    { table: 'combined_score', where: 'event_entry_id IN (SELECT id FROM event_entry WHERE athlete_id=?)', params: [ath.id] },
                    { table: 'qualification_selection', where: 'event_entry_id IN (SELECT id FROM event_entry WHERE athlete_id=?)', params: [ath.id] },
                    { table: 'relay_member', where: 'event_entry_id IN (SELECT id FROM event_entry WHERE athlete_id=?) OR athlete_id=?', params: [ath.id, ath.id] },
                ],
            });
            undoId = snap ? snap.id : null;
        } catch (e) { console.error('[undo] athlete snapshot:', e.message); }
        await db.transaction(async () => {
            const entries = await db.all('SELECT id FROM event_entry WHERE athlete_id=?', ath.id);
            for (const e of entries) {
                await db.run('DELETE FROM result WHERE event_entry_id=?', e.id);
                await db.run('DELETE FROM height_attempt WHERE event_entry_id=?', e.id);
                await db.run('DELETE FROM heat_entry WHERE event_entry_id=?', e.id);
                await db.run('DELETE FROM combined_score WHERE event_entry_id=?', e.id);
                await db.run('DELETE FROM qualification_selection WHERE event_entry_id=?', e.id);
            }
            await db.run('DELETE FROM relay_member WHERE event_entry_id IN (SELECT id FROM event_entry WHERE athlete_id=?)', ath.id);
            await db.run('DELETE FROM relay_member WHERE athlete_id=?', ath.id);      // 계주 주자로 든 것도 (남아 있으면 팀 주자 목록이 깨진 선수를 가리킨다)
            await db.run('DELETE FROM event_entry WHERE athlete_id=?', ath.id);
            await db.run('DELETE FROM athlete WHERE id=?', ath.id);
        })();
        res.json({ success: true, undo_id: undoId });
    });

    // ---- Athlete ↔ Event Assignment ----
    app.get('/api/admin/athletes/:id/events', async (req, res) => {
        if (!isAdminKey(req.query.key) && !isOperationKey(req.query.key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
        res.json(await db.all(`
            SELECT ee.id AS event_entry_id, ee.event_id, ee.status, e.name AS event_name, e.category, e.gender, e.round_type
            FROM event_entry ee JOIN event e ON e.id=ee.event_id
            WHERE ee.athlete_id=? ORDER BY e.sort_order, e.id
        `, req.params.id));
    });
    app.post('/api/admin/athletes/:id/events', async (req, res) => {
        const { admin_key, event_id } = req.body;
        if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
        const ath = await db.get('SELECT * FROM athlete WHERE id=?', req.params.id);
        if (!ath) return res.status(404).json({ error: 'Athlete not found' });
        const evt = await db.get('SELECT * FROM event WHERE id=?', event_id);
        if (!evt) return res.status(404).json({ error: 'Event not found' });

        // For relay events: add athlete as relay_member to existing team, don't create new team
        if (evt.category === 'relay') {
            // Find existing team entry for this athlete's team
            const teamName = ath.team || ath.name;
            const existingTeamEntry = await db.get(`
                SELECT ee.id FROM event_entry ee
                JOIN athlete a ON a.id = ee.athlete_id
                WHERE ee.event_id = ? AND a.name = ?
            `, event_id, teamName);

            if (existingTeamEntry) {
                // Add as relay member to existing team
                const existingMember = await db.get('SELECT id FROM relay_member WHERE event_entry_id=? AND athlete_id=?', existingTeamEntry.id, ath.id);
                if (existingMember) return res.status(409).json({ error: '이미 등록된 릴레이 멤버입니다.' });
                const maxLegRow = await db.get('SELECT MAX(leg_order) AS mx FROM relay_member WHERE event_entry_id=?', existingTeamEntry.id);
                const maxLeg = (maxLegRow && maxLegRow.mx) || 0;
                await db.run('INSERT OR IGNORE INTO relay_member (event_entry_id, athlete_id, leg_order) VALUES (?,?,?)', existingTeamEntry.id, ath.id, maxLeg + 1);
                return res.json({ success: true, event_entry_id: existingTeamEntry.id, added_as: 'relay_member' });
            }
            // No existing team → create a dummy team athlete and add this athlete as relay_member
            const rGender = evt.gender === 'X' ? 'M' : evt.gender;
            let teamAthlete = await db.get('SELECT * FROM athlete WHERE competition_id=? AND name=? AND bib_number=?', evt.competition_id, teamName, teamName);
            if (!teamAthlete) {
                const teamInfo = await db.run('INSERT INTO athlete (competition_id,name,bib_number,team,barcode,gender) VALUES (?,?,?,?,?,?)', evt.competition_id, teamName, teamName, teamName, `RELAY_${teamName}`, rGender);
                teamAthlete = await db.get('SELECT * FROM athlete WHERE id=?', teamInfo.lastInsertRowid);
            }
            // Create event_entry for the team
            let teamEntry = await db.get('SELECT id FROM event_entry WHERE event_id=? AND athlete_id=?', event_id, teamAthlete.id);
            if (!teamEntry) {
                const teInfo = await db.run("INSERT INTO event_entry (event_id,athlete_id,status) VALUES (?,?,'registered')", event_id, teamAthlete.id);
                teamEntry = { id: teInfo.lastInsertRowid };
                // Assign to first heat
                let heat = await db.get('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number LIMIT 1', event_id);
                if (!heat) {
                    const hInfo = await db.run('INSERT INTO heat (event_id, heat_number) VALUES (?, 1)', event_id);
                    heat = { id: hInfo.lastInsertRowid };
                }
                const maxLaneRow = await db.get('SELECT MAX(lane_number) AS mx FROM heat_entry WHERE heat_id=?', heat.id);
                const maxLane = (maxLaneRow && maxLaneRow.mx) || 0;
                await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?, ?, ?)', heat.id, teamEntry.id, maxLane + 1);
            }
            // Add the athlete as relay member
            await db.run('INSERT OR IGNORE INTO relay_member (event_entry_id, athlete_id, leg_order) VALUES (?,?,?)', teamEntry.id, ath.id, 1);
            return res.json({ success: true, event_entry_id: teamEntry.id, added_as: 'relay_member_new_team' });
        }

        const exists = await db.get('SELECT id FROM event_entry WHERE event_id=? AND athlete_id=?', event_id, ath.id);
        if (exists) return res.status(409).json({ error: '이미 등록된 종목입니다.' });

        await db.transaction(async () => {
            // 1. Create event_entry
            const info = await db.run("INSERT INTO event_entry (event_id,athlete_id,status) VALUES (?,?,'registered')", event_id, ath.id);
            const entryId = info.lastInsertRowid;

            // 2. Auto-assign to first heat (create heat if none exists)
            let heat = await db.get('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number LIMIT 1', event_id);
            if (!heat) {
                const hInfo = await db.run('INSERT INTO heat (event_id, heat_number) VALUES (?, 1)', event_id);
                heat = { id: hInfo.lastInsertRowid };
            }
            // Determine next lane number
            const maxLaneRow = await db.get('SELECT MAX(lane_number) AS mx FROM heat_entry WHERE heat_id=?', heat.id);
            const maxLane = (maxLaneRow && maxLaneRow.mx) || 0;
            await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?, ?, ?)', heat.id, entryId, maxLane + 1);

            audit('event_entry', entryId, 'INSERT', null, { event_id, athlete_id: ath.id }, 'admin', evt.competition_id, req);
            broadcastSSE('entry_status', { event_entry_id: entryId, status: 'registered' });
        })();

        const eeRow = await db.get('SELECT id FROM event_entry WHERE event_id=? AND athlete_id=?', event_id, ath.id);
        res.json({ success: true, event_entry_id: eeRow ? eeRow.id : null });
    });
    app.delete('/api/admin/athletes/:athleteId/events/:entryId', async (req, res) => {
        const { admin_key } = req.body;
        if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
        const entry = await db.get('SELECT * FROM event_entry WHERE id=?', req.params.entryId);
        if (!entry) return res.status(404).json({ error: 'Entry not found' });
        await db.transaction(async () => {
            await db.run('DELETE FROM result WHERE event_entry_id=?', entry.id);
            await db.run('DELETE FROM height_attempt WHERE event_entry_id=?', entry.id);
            await db.run('DELETE FROM heat_entry WHERE event_entry_id=?', entry.id);
            await db.run('DELETE FROM combined_score WHERE event_entry_id=?', entry.id);
            await db.run('DELETE FROM qualification_selection WHERE event_entry_id=?', entry.id);
            await db.run('DELETE FROM relay_member WHERE event_entry_id=?', entry.id);
            await db.run('DELETE FROM event_entry WHERE id=?', entry.id);
        })();
        res.json({ success: true });
    });

    // ============================================================
    // ADMIN: EVENT CRUD
    // ============================================================
    app.get('/api/admin/events', async (req, res) => {
        if (!isAdminKey(req.query.key) && !isOperationKey(req.query.key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
        const compId = req.query.competition_id;
        if (compId) return res.json(await db.all('SELECT * FROM event WHERE competition_id=? ORDER BY sort_order, id', compId));
        res.json(await db.all('SELECT * FROM event ORDER BY sort_order, id'));
    });
    // Standard athletics event order (WA + KAAF) - reusable
    // Order: Sprints(100~400) → Middle(800~1500) → Long(3000~10000) → Hurdles → SC → Walks(track) → Road → Jumps → Throws → Combined → Relays
    const STANDARD_EVENT_ORDER = [
        // Sprints
        '100m','200m','400m',
        // Middle distance
        '800m','1500m','1마일','Mile',
        // Long distance
        '3000m','5000m','10000m',
        // Hurdles
        '100mH','110mH','400mH',
        // Steeplechase
        '2000mSC','3000mSC',
        // Track walks
        '3000mW','5000mW','10000mW',
        // Road walks
        '20kmW','35kmW','50kmW',
        // Road running
        '하프마라톤','마라톤',
        // Vertical jumps
        '높이뛰기','장대높이뛰기',
        // Horizontal jumps
        '멀리뛰기','세단뛰기',
        // Throws
        '포환던지기','원반던지기','해머던지기','창던지기',
        // Combined
        '5종경기','7종경기','10종경기',
        // Relays
        '4x100mR','4x400mR','4x400mR(혼성)','4x800mR','4x1500mR',
    ];
    // Normalize event name for robust matching (whitespace removed, lowercase, unified relay/walk/hurdle/SC/marathon tokens)
    function _normEvtName(s) {
        if (!s) return '';
        let t = String(s).trim().toLowerCase();
        // Unify relay multiplication signs and remove spaces
        t = t.replace(/[×x✕✖＊*]/g, 'x');
        t = t.replace(/\s+/g, '');
        t = t.replace(/,/g, '');
        // Relay normalization: "4x100m릴레이" / "4x100r" → "4x100mr"
        t = t.replace(/(\d+)x(\d+)m?릴레이/g, '$1x$2mr');
        t = t.replace(/(\d+)x(\d+)r(?![a-z0-9])/g, '$1x$2mr');
        // Mixed relay
        t = t.replace(/mixed/g, '혼성');
        t = t.replace(/\(mix\)/g, '(혼성)');
        // If "혼성" appears before a relay token, convert to suffix form: "혼성4x400mr" → "4x400mr(혼성)"
        t = t.replace(/혼성(\d+x\d+mr)/g, '$1(혼성)');
        // Walk normalization: "20km경보" / "20킬로경보" → "20kmw"
        t = t.replace(/(\d+)\s*km\s*(?:경보|w)\b/gi, '$1kmw');
        t = t.replace(/(\d+)\s*m\s*(?:경보|w)\b/gi, '$1mw');
        t = t.replace(/(\d+)킬로경보/g, '$1kmw');
        t = t.replace(/경보/g, 'w');
        // Hurdles: "100m허들" → "100mh"
        t = t.replace(/(\d+)m?허들/g, '$1mh');
        t = t.replace(/허들/g, 'h');
        // Steeplechase: "3000m장애물" → "3000msc"
        t = t.replace(/(\d+)m?장애물/g, '$1msc');
        t = t.replace(/장애물/g, 'sc');
        // Marathon variants
        t = t.replace(/하프\s*마라톤/g, '하프마라톤');
        t = t.replace(/halfmarathon/g, '하프마라톤');
        t = t.replace(/marathon/g, '마라톤');
        return t;
    }
    function getStandardSortOrder(eventName) {
        if (!eventName) return 9990;
        const normTarget = _normEvtName(eventName);
        // 1) Exact match (after normalization)
        let idx = STANDARD_EVENT_ORDER.findIndex(s => _normEvtName(s) === normTarget);
        if (idx >= 0) return (idx + 1) * 10;
        // 2) Pattern-based fallback by category keyword
        //    Use regex to avoid the "100m matches 100mH" trap
        const patterns = [
            // Track walks
            { re: /^(\d+)mw$/, get: m => `${m[1]}mw` },
            // Road walks
            { re: /^(\d+)kmw$/, get: m => `${m[1]}kmw` },
            // Hurdles
            { re: /^(\d+)mh$/, get: m => `${m[1]}mh` },
            // Steeplechase
            { re: /^(\d+)msc$/, get: m => `${m[1]}msc` },
            // Relays
            { re: /^(\d+)x(\d+)mr(\(혼성\))?$/, get: m => `${m[1]}x${m[2]}mr${m[3]||''}` },
            // Plain track distance
            { re: /^(\d+)m$/, get: m => `${m[1]}m` },
        ];
        for (const p of patterns) {
            const mt = normTarget.match(p.re);
            if (!mt) continue;
            const probe = p.get(mt);
            const j = STANDARD_EVENT_ORDER.findIndex(s => _normEvtName(s) === probe);
            if (j >= 0) return (j + 1) * 10;
        }
        // 3) Substring fallback - but exclude track-distance vs hurdle/walk/SC confusion
        //    Only allow substring match if normalized target does NOT contain extra suffixes
        const safeForSubstr = !/[hwc]|sc|mr/.test(normTarget) || /^(\d+)(m|km)/.test(normTarget) === false;
        if (safeForSubstr) {
            idx = STANDARD_EVENT_ORDER.findIndex(s => {
                const ns = _normEvtName(s);
                return ns.length >= 2 && (normTarget.includes(ns) || ns.includes(normTarget));
            });
            if (idx >= 0) return (idx + 1) * 10;
        }
        return 9990;
    }
    async function autoSortCompetitionEvents(competitionId) {
        const events = await db.all('SELECT * FROM event WHERE competition_id=? AND parent_event_id IS NULL', competitionId);
        await db.transaction(async () => {
            for (const evt of events) {
                const order = getStandardSortOrder(evt.name);
                await db.run('UPDATE event SET sort_order=? WHERE id=?', order, evt.id);
                await db.run('UPDATE event SET sort_order=? WHERE parent_event_id=?', order, evt.id);
            }
        })();
    }

    app.post('/api/admin/events', async (req, res) => {
        const { admin_key, competition_id, name, category, gender, round_type, sort_order, division, video_url, result_url } = req.body;
        if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
        if (!name || !category || !gender || !competition_id) return res.status(400).json({ error: '필수 항목이 누락되었습니다.' });
        try {
            const autoOrder = sort_order || getStandardSortOrder(name);
            const info = await db.run('INSERT INTO event (competition_id,name,category,gender,round_type,round_status,sort_order,division,video_url,result_url) VALUES (?,?,?,?,?,?,?,?,?,?)', competition_id, name, category, gender, round_type || 'final', 'created', autoOrder, division || '', video_url || '', result_url || '');
            const evt = await db.get('SELECT * FROM event WHERE id=?', info.lastInsertRowid);
            await db.run('INSERT INTO heat (event_id,heat_number) VALUES (?,1)', evt.id);
            // 시간표 자동 재매칭 (새 종목이 생겼으므로 시간표의 매칭되지 않은 행과 연결 가능)
            try { await autoLinkDisplayTimetable(competition_id); } catch(autoErr) { console.warn('[autoLink after event create] ', autoErr.message); }
            res.json(evt);
        } catch (e) { res.status(400).json({ error: '추가 오류: ' + e.message }); }
    });
    app.put('/api/admin/events/:id', async (req, res) => {
        const { admin_key, name, category, gender, round_type, sort_order, round_status, video_url, division, result_url } = req.body;
        if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
        const old = await db.get('SELECT * FROM event WHERE id=?', req.params.id);
        if (!old) return res.status(404).json({ error: 'Not found' });
        await db.run('UPDATE event SET name=?,category=?,gender=?,round_type=?,sort_order=?,round_status=?,video_url=?,division=?,result_url=? WHERE id=?', name || old.name, category || old.category, gender || old.gender, round_type || old.round_type, sort_order ?? old.sort_order, round_status || old.round_status, video_url ?? old.video_url ?? '', division ?? old.division ?? '', result_url ?? old.result_url ?? '', old.id);
        // 종목 이름/성별/라운드가 바뀌었을 가능성이 있으므로 시간표 재매칭 시도 (단 수동 매칭은 보호)
        if (name !== old.name || gender !== old.gender || round_type !== old.round_type) {
            try { await autoLinkDisplayTimetable(old.competition_id); } catch(autoErr) { console.warn('[autoLink after event update] ', autoErr.message); }
        }
        res.json(await db.get('SELECT * FROM event WHERE id=?', old.id));
    });

    // Event video URL (accessible by operation key holders)
    app.put('/api/events/:id/video-url', async (req, res) => {
        const { key, video_url } = req.body;
        if (!isOperationKey(key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
        const evt = await db.get('SELECT * FROM event WHERE id=?', req.params.id);
        if (!evt) return res.status(404).json({ error: 'Not found' });
        await db.run('UPDATE event SET video_url=? WHERE id=?', video_url || '', evt.id);
        res.json({ ok: true, video_url: video_url || '' });
    });
    app.get('/api/events/:id/video-url', async (req, res) => {
        const evt = await db.get('SELECT video_url FROM event WHERE id=?', req.params.id);
        if (!evt) return res.status(404).json({ error: 'Not found' });
        res.json({ video_url: evt.video_url || '' });
    });

    // Auto-sort events by standard athletics order (WA + KAAF)
    // Allow operation key as well so on-site staff can trigger this without master admin key
    app.post('/api/admin/events/auto-sort', async (req, res) => {
        const { admin_key, competition_id } = req.body;
        if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
        if (!competition_id) return res.status(400).json({ error: 'competition_id 필요' });
        await autoSortCompetitionEvents(competition_id);
        const row = await db.get('SELECT COUNT(*) as cnt FROM event WHERE competition_id=? AND parent_event_id IS NULL', competition_id);
        const count = row ? row.cnt : 0;
        res.json({ success: true, message: `${count}개 종목 자동정렬 완료 (WA 표준 순서)` });
    });

    app.delete('/api/admin/events/:id', async (req, res) => {
        const { admin_key } = req.body;
        if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        const event = await db.get('SELECT * FROM event WHERE id=?', req.params.id);
        if (!event) return res.status(404).json({ error: 'Not found' });
        const undoId = await _undoSnapshotEvent(event, 'admin');
        await db.transaction(async () => {
            const subs = await db.all('SELECT id FROM event WHERE parent_event_id=?', event.id);
            for (const sub of subs) {
                const subHeats = await db.all('SELECT id FROM heat WHERE event_id=?', sub.id);
                for (const h of subHeats) { await db.run('DELETE FROM result WHERE heat_id=?', h.id); await db.run('DELETE FROM height_attempt WHERE heat_id=?', h.id); await db.run('DELETE FROM heat_entry WHERE heat_id=?', h.id); }
                await db.run('DELETE FROM heat WHERE event_id=?', sub.id); await db.run('DELETE FROM relay_member WHERE event_entry_id IN (SELECT id FROM event_entry WHERE event_id=?)', sub.id); await db.run('DELETE FROM event_entry WHERE event_id=?', sub.id); await db.run('DELETE FROM event WHERE id=?', sub.id);
            }
            const heats = await db.all('SELECT id FROM heat WHERE event_id=?', event.id);
            for (const h of heats) { await db.run('DELETE FROM result WHERE heat_id=?', h.id); await db.run('DELETE FROM height_attempt WHERE heat_id=?', h.id); await db.run('DELETE FROM heat_entry WHERE heat_id=?', h.id); }
            await db.run('DELETE FROM heat WHERE event_id=?', event.id);
            await db.run('DELETE FROM relay_member WHERE event_entry_id IN (SELECT id FROM event_entry WHERE event_id=?)', event.id);
            await db.run('DELETE FROM combined_score WHERE event_entry_id IN (SELECT id FROM event_entry WHERE event_id=?)', event.id);
            await db.run('DELETE FROM qualification_selection WHERE event_id=?', event.id);
            await db.run('DELETE FROM event_entry WHERE event_id=?', event.id);
            await db.run('DELETE FROM event WHERE id=?', event.id);
        })();
        res.json({ success: true, undo_id: undoId });
    });

    // ============================================================
    // ADMIN: HEAT MANAGEMENT (merge, add, delete, move athlete)
    // ============================================================
    app.post('/api/admin/events/:id/add-heat', async (req, res) => {
        const { admin_key } = req.body;
        if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
        const event = await db.get('SELECT * FROM event WHERE id=?', req.params.id);
        if (!event) return res.status(404).json({ error: 'Event not found' });
        const maxHeat = await db.get('SELECT MAX(heat_number) AS mx FROM heat WHERE event_id=?', event.id);
        const nextNum = (maxHeat.mx || 0) + 1;
        const info = await db.run('INSERT INTO heat (event_id, heat_number) VALUES (?, ?)', event.id, nextNum);
        res.json({ success: true, heat_id: info.lastInsertRowid, heat_number: nextNum });
    });
    app.delete('/api/admin/heats/:id', async (req, res) => {
        const { admin_key } = req.body;
        if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
        const heat = await db.get('SELECT * FROM heat WHERE id=?', req.params.id);
        if (!heat) return res.status(404).json({ error: 'Heat not found' });
        let undoId = null;
        try {
            const ev = await db.get('SELECT * FROM event WHERE id=?', heat.event_id);
            const snap = await _undo.snapshot(db, {
                competition_id: ev && ev.competition_id, kind: 'heat_delete', role: 'operation', performed_by: getJudgeName(admin_key) || '',
                label: `조 삭제: ${ev ? ev.name + ' ' : ''}${heat.heat_number}조`, meta: { event_id: heat.event_id },
                tables: [
                    { table: 'heat', where: 'id=?', params: [heat.id] },
                    { table: 'heat_entry', where: 'heat_id=?', params: [heat.id] },
                    { table: 'result', where: 'heat_id=?', params: [heat.id] },
                    { table: 'height_attempt', where: 'heat_id=?', params: [heat.id] },
                ],
            });
            undoId = snap ? snap.id : null;
        } catch (e) { console.error('[undo] heat snapshot:', e.message); }
        await db.transaction(async () => {
            await db.run('DELETE FROM result WHERE heat_id=?', heat.id);
            await db.run('DELETE FROM height_attempt WHERE heat_id=?', heat.id);
            await db.run('DELETE FROM heat_entry WHERE heat_id=?', heat.id);
            await db.run('DELETE FROM heat WHERE id=?', heat.id);
        })();
        res.json({ success: true, undo_id: undoId });
    });
    // Remove athlete from heat (without deleting event_entry — just unlink from heat)
    app.post('/api/admin/heats/:id/remove-entry', async (req, res) => {
        const { admin_key, event_entry_id, delete_event_entry, force } = req.body;
        if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
        const heat = await db.get('SELECT * FROM heat WHERE id=?', req.params.id);
        if (!heat) return res.status(404).json({ error: 'Heat not found' });
        const he = await db.get('SELECT * FROM heat_entry WHERE heat_id=? AND event_entry_id=?', req.params.id, event_entry_id);
        if (!he) return res.status(404).json({ error: '해당 선수가 이 조에 없습니다.' });

        // delete_event_entry=true 인 경우 결과 데이터 존재 여부 체크
        let removedResultCount = 0;
        if (delete_event_entry) {
            const r1 = await db.get('SELECT COUNT(*) AS n FROM result WHERE event_entry_id=?', event_entry_id);
            const r2 = await db.get('SELECT COUNT(*) AS n FROM height_attempt WHERE event_entry_id=?', event_entry_id);
            const r3 = await db.get('SELECT COUNT(*) AS n FROM combined_score WHERE event_entry_id=?', event_entry_id);
            removedResultCount = (r1?.n || 0) + (r2?.n || 0) + (r3?.n || 0);
            if (removedResultCount > 0 && !force) {
                return res.status(409).json({
                    error: '기록 데이터가 존재합니다',
                    detail: `이 선수에 ${removedResultCount}건의 기록이 저장되어 있습니다. 강제로 삭제하려면 force=true 와 함께 다시 요청하세요.`,
                    result_count: removedResultCount,
                    needs_force: true,
                });
            }
        }

        await db.transaction(async () => {
            // Remove from heat
            await db.run('DELETE FROM heat_entry WHERE heat_id=? AND event_entry_id=?', req.params.id, event_entry_id);
            // Optionally also delete the event_entry (full removal from event)
            if (delete_event_entry) {
                await db.run('DELETE FROM result WHERE event_entry_id=?', event_entry_id);
                await db.run('DELETE FROM height_attempt WHERE event_entry_id=?', event_entry_id);
                await db.run('DELETE FROM combined_score WHERE event_entry_id=?', event_entry_id);
                await db.run('DELETE FROM qualification_selection WHERE event_entry_id=?', event_entry_id);
                await db.run('DELETE FROM relay_member WHERE event_entry_id=?', event_entry_id);
                await db.run('DELETE FROM event_entry WHERE id=?', event_entry_id);
            }
        })();
        broadcastSSE('entry_status', { event_entry_id, status: 'removed' });
        res.json({ success: true, removed_results: removedResultCount });
    });
    app.post('/api/admin/heats/:id/move-entry', async (req, res) => {
        const { admin_key, event_entry_id, target_heat_id, lane_number } = req.body;
        if (!isOperationKey(admin_key)) return res.status(403).json({ error: '인증 키가 필요합니다.' });
        await db.transaction(async () => {
            // Remove from current heat
            await db.run('DELETE FROM heat_entry WHERE heat_id=? AND event_entry_id=?', req.params.id, event_entry_id);
            // Add to target heat
            await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?, ?, ?) ON CONFLICT(heat_id, event_entry_id) DO UPDATE SET lane_number=excluded.lane_number', target_heat_id, event_entry_id, lane_number || null);
        })();
        res.json({ success: true });
    });
    // Force event status change (admin override)
    app.post('/api/admin/events/:id/force-status', async (req, res) => {
        const { admin_key, round_status, round_type } = req.body;
        if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        const event = await db.get('SELECT * FROM event WHERE id=?', req.params.id);
        if (!event) return res.status(404).json({ error: 'Event not found' });
        const updates = [];
        const params = [];
        if (round_status) { updates.push('round_status=?'); params.push(round_status); }
        if (round_type) { updates.push('round_type=?'); params.push(round_type); }
        if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });
        params.push(event.id);
        await db.run(`UPDATE event SET ${updates.join(',')} WHERE id=?`, ...params);
        opLog(`${event.name} 강제 상태변경: ${round_status || ''} ${round_type || ''}`, 'admin', 'admin', event.competition_id);
        broadcastSSE('event_reverted', { event_id: event.id });
        res.json({ success: true, event: await db.get('SELECT * FROM event WHERE id=?', event.id) });
    });

    // ============================================================

    return { _normalizeAthletePhone, _normalizeGrade, STANDARD_EVENT_ORDER, _normEvtName, getStandardSortOrder, autoSortCompetitionEvents };
};
