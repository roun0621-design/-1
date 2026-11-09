'use strict';
/**
 * 노출용(display) 대회 라우트 — server.js 에서 이동 (2026-09-22, Phase 4 분해)
 *   시간표 업로드(→종목 자동 생성·연결), 명단(roster) 업로드·매칭·편집, 고아/미지정 종목 정리, 결과 링크.
 *   25 라우트 + autoLinkDisplayTimetable(종목 생성·수정·라운드 완료 뒤 server.js 가 호출) · autoMatchDisplayRoster.
 *   동작은 인라인 시절과 같다 — 헬퍼(parseJongbyul·parseDisplayRound·guessEventCategory…)는 다른 모듈도 쓰므로 server.js 에 두고 deps 로 받는다.
 */
module.exports = function mountDisplayRoutes(app, deps) {
    const { db, upload, XLSX, fs, isAdminKey, isOperationKey, opLog, normalizeDivisionLabel,
        parseJongbyul, parseJongbyulNormalized, parseDisplayRound, excelTimeToHHMM, cleanTimetableEventName, guessEventCategory, timetableRoutes } = deps;
    const _timetableRoutes = timetableRoutes;
    for (const k of ['db', 'upload', 'XLSX', 'fs', 'isAdminKey', 'isOperationKey', 'opLog', 'normalizeDivisionLabel', 'parseJongbyul', 'parseJongbyulNormalized', 'parseDisplayRound', 'excelTimeToHHMM', 'cleanTimetableEventName', 'guessEventCategory', 'timetableRoutes']) {
        if (!deps[k]) throw new Error('[display.js] mount requires deps.' + k);
    }

    // Upload timetable for display-mode competition → auto-create events
    app.post('/api/display/timetable/upload', upload.single('file'), async (req, res) => {
        try {
            const { competition_id, admin_key } = req.body;
            if (!competition_id) return res.status(400).json({ error: 'competition_id required' });
            if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
            if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });

            const comp = await db.get('SELECT * FROM competition WHERE id=?', parseInt(competition_id));
            if (!comp) { try { fs.unlinkSync(req.file.path); } catch(e) {} return res.status(404).json({ error: '대회를 찾을 수 없습니다.' }); }

            const wb = XLSX.readFile(req.file.path);
            const ws = wb.Sheets[wb.SheetNames[0]];
            const data = XLSX.utils.sheet_to_json(ws, { header: 1 });

            // Find header row
            let headerIdx = -1;
            for (let i = 0; i < Math.min(data.length, 10); i++) {
                const row = (data[i] || []).map(c => String(c || '').trim());
                if (row.some(c => c === '날짜' || c === '시간' || c === '종목')) { headerIdx = i; break; }
            }
            if (headerIdx < 0) { try { fs.unlinkSync(req.file.path); } catch(e) {} return res.status(400).json({ error: '시간표 헤더를 찾을 수 없습니다. (날짜/시간/종목 컬럼 필요)' }); }

            const headers = data[headerIdx].map(c => String(c || '').trim());
            const colIdx = {
                date: headers.findIndex(h => h === '날짜'),
                section: headers.findIndex(h => h === '구분'),
                time: headers.findIndex(h => h === '시간'),
                event: headers.findIndex(h => h === '종목'),
                jongbyul: headers.findIndex(h => h === '종별'),
                round: headers.findIndex(h => h === '라운드'),
            };

            if (colIdx.time < 0 || colIdx.event < 0) {
                try { fs.unlinkSync(req.file.path); } catch(e) {}
                return res.status(400).json({ error: '시간/종목 컬럼이 필요합니다.' });
            }

            // Parse all dates to compute day numbers
            const dateSet = new Set();
            for (let i = headerIdx + 1; i < data.length; i++) {
                const row = data[i] || [];
                if (colIdx.date >= 0 && row[colIdx.date]) {
                    const ds = String(row[colIdx.date]).trim();
                    if (ds) dateSet.add(ds);
                }
            }
            const sortedDates = [...dateSet].sort();
            const dateToDay = {};
            sortedDates.forEach((d, idx) => { dateToDay[d] = idx + 1; });

            // Also use competition start_date for day offset
            const compStart = comp.start_date ? new Date(comp.start_date + 'T00:00:00') : null;

            const timetableEntries = [];
            const eventMap = {}; // key: eventName|gender|division → event definition

            let prevDate = sortedDates[0] || '';

            for (let i = headerIdx + 1; i < data.length; i++) {
                const row = data[i] || [];
                const rawDate = colIdx.date >= 0 ? String(row[colIdx.date] || '').trim() : '';
                const rawSection = colIdx.section >= 0 ? String(row[colIdx.section] || '').trim() : '';
                const rawTime = row[colIdx.time];
                const rawEvent = cleanTimetableEventName(row[colIdx.event] || '');
                const rawJongbyul = colIdx.jongbyul >= 0 ? String(row[colIdx.jongbyul] || '').replace(/[\u00A0\s]+/g, ' ').trim() : '';
                const rawRound = colIdx.round >= 0 ? String(row[colIdx.round] || '').replace(/[\u00A0\s]+/g, ' ').trim() : '';

                if (!rawEvent && !rawTime) continue;

                // Fix: sometimes 종목 column has the event name in jongbyul position (row shift)
                let eventName = rawEvent;
                let jongbyul = rawJongbyul;
                if (!eventName && rawJongbyul) { eventName = rawJongbyul; jongbyul = ''; }

                const currentDate = rawDate || prevDate;
                if (rawDate) prevDate = rawDate;

                const dayNum = dateToDay[currentDate] || 1;
                // '구분' column mapping: track/field/road (Korean & English)
                let section = 'track';
                const secLower = (rawSection || '').toLowerCase();
                if (secLower.includes('필드') || secLower.includes('field') || secLower.includes('투척') || secLower.includes('도약')) {
                    section = 'field';
                } else if (secLower.includes('도로') || secLower.includes('road') || secLower.includes('경보') || secLower.includes('마라톤')) {
                    section = 'road';
                }
                const timeStr = excelTimeToHHMM(rawTime);

                // Compute scheduled_date
                let scheduledDate = null;
                if (compStart && dayNum) {
                    const dd = new Date(compStart);
                    dd.setDate(dd.getDate() + dayNum - 1);
                    scheduledDate = dd.toISOString().split('T')[0];
                }

                // FIX: jongbyul을 "/" 또는 "," 로 분리 (엑셀에 "남자 대학부, 남자 일반부, 여자 일반부" 같은 콤마 구분 입력 처리)
                const jbParts = jongbyul ? jongbyul.split(/[\/,]/).map(s => s.trim()).filter(Boolean) : [''];
                const parsedRound = parseDisplayRound(rawRound);

                for (const jbPart of jbParts) {
                    const parsed = parseJongbyulNormalized(jbPart);
                    const gender = parsed.gender;
                    const division = parsed.division;

                    // Determine event category from '구분' column (section) + event name
                    let category = guessEventCategory(eventName);
                    if (section === 'road' && category === 'track') {
                        category = 'road';
                    } else if (section === 'field') {
                        if (category === 'track') {
                            // Use event name to distinguish height vs distance
                            if (/높이뛰기|장대높이/.test(eventName)) {
                                category = 'field_height';
                            } else {
                                category = 'field_distance';
                            }
                        }
                    }

                    // ── 결합경기(10종/7종/5종) 감지 ──
                    //   · 종목명에 "(N종)" 표기: "100m(10종)", "멀리뛰기(7종)" (라운드=기록경기)  ← 그린·코리아오픈 양식
                    //   · 또는 라운드에 "N종(..)" 표기: 레거시 양식
                    //   → 부모("N종경기") 1개 + 각 세부종목을 자식(parent_event_id)으로 생성.
                    const nameComb = eventName.match(/\((\d+)종\)/);
                    const roundComb = rawRound.match(/^(\d+)종/);
                    const combinedN = nameComb ? nameComb[1] : (roundComb ? roundComb[1] : null);

                    if (combinedN) {
                        const parentName = `${combinedN}종경기`;
                        const pKey = `${parentName}|${gender}|${division || ''}`;
                        if (!eventMap[pKey]) {
                            eventMap[pKey] = { name: parentName, gender, division, category: 'combined', rounds: new Set(['final']), isParent: true };
                        }
                        // 자식: 종목명 그대로(마커 포함)로 저장 → 일반 단일종목과 충돌 방지 + 시간표 자동링크 일치
                        const cKey = `${eventName}|${gender}|${division || ''}`;
                        if (!eventMap[cKey]) {
                            eventMap[cKey] = {
                                name: eventName, gender, division,
                                category: (category === 'combined' ? 'track' : category),
                                rounds: new Set(['final']), isChild: true, parentKey: pKey,
                            };
                        }
                    } else {
                        const eventKey = `${eventName}|${gender}|${division || ''}`;
                        if (!eventMap[eventKey]) {
                            eventMap[eventKey] = { name: eventName, gender, division, category, rounds: new Set() };
                        }
                        eventMap[eventKey].rounds.add(parsedRound.round_type);
                    }

                    // Add timetable entry
                    timetableEntries.push({
                        competition_id: parseInt(competition_id),
                        day: dayNum,
                        section,
                        time: timeStr,
                        event_name: eventName,
                        category: jbPart || '',
                        round: rawRound,
                        note: parsedRound.note || '',
                        sort_order: timetableEntries.length,
                        scheduled_date: scheduledDate,
                        gender, division,
                    });
                }
            }

            if (timetableEntries.length === 0) {
                try { fs.unlinkSync(req.file.path); } catch(e) {}
                return res.status(400).json({ error: '시간표 데이터가 없습니다.' });
            }

            const uploadedDays = [...new Set(timetableEntries.map(e => e.day))].sort((a, b) => a - b);

            // ─── OPTION C: PRESERVE PAST + DIFF MERGE FOR FUTURE/TODAY ───
            // 1) Determine "today" in local server timezone (YYYY-MM-DD)
            const todayStr = new Date().toISOString().split('T')[0];
            const overwriteMode = req.body.overwrite_mode || 'smart'; // 'smart' (default) | 'force' (legacy: full delete)

            // 2) Filter out entries for past days (scheduled_date < today) UNLESS force mode
            let filteredEntries = timetableEntries;
            let skippedPastDays = [];
            if (overwriteMode !== 'force') {
                const pastDaysSet = new Set();
                filteredEntries = timetableEntries.filter(e => {
                    if (e.scheduled_date && e.scheduled_date < todayStr) {
                        pastDaysSet.add(e.day);
                        return false;
                    }
                    return true;
                });
                skippedPastDays = [...pastDaysSet].sort((a, b) => a - b);
            }

            const effectiveDays = [...new Set(filteredEntries.map(e => e.day))].sort((a, b) => a - b);

            // Transaction: smart-merge timetable + create events
            const tx = db.transaction(async () => {
                let addedCount = 0;
                let updatedCount = 0;
                let deletedCount = 0;
                let preservedCount = 0;

                const INS_TT_SQL = `INSERT INTO timetable
                    (competition_id, day, section, time, event_name, category, round, note, sort_order, scheduled_date)
                    VALUES (?,?,?,?,?,?,?,?,?,?)`;

                if (overwriteMode === 'force') {
                    // LEGACY: full delete for uploaded days
                    for (const d of uploadedDays) {
                        await db.run('DELETE FROM timetable WHERE competition_id=? AND day=?', parseInt(competition_id), d);
                    }
                    for (const e of timetableEntries) {
                        await db.run(INS_TT_SQL, e.competition_id, e.day, e.section, e.time, e.event_name, e.category, e.round, e.note, e.sort_order, e.scheduled_date);
                        addedCount++;
                    }
                } else {
                    // SMART MERGE (옵션 C):
                    //   - 과거 일차(scheduled_date < today): 절대 건드리지 않음
                    //   - 오늘/미래 일차: 행 단위 diff 머지
                    //     * 매칭 키: (day, time, event_name, category, round)
                    //     * 매칭 시 → UPDATE (event_id, callroom_time, note 등 보존)
                    //     * 신규 → INSERT
                    //     * 엑셀에 없는 기존 미래 행 → DELETE
                    // FIX: event_id를 NULL로 리셋해서 autoLinkDisplayTimetable이 새 division/gender로 재링크하도록 함
                    //       (예전 잘못된 라벨로 만들어진 event에 링크된 채 남아있는 문제 방지)
                    const UPD_TT_SQL = `UPDATE timetable SET
                        section=?, note=?, sort_order=?, scheduled_date=?, event_id=NULL
                        WHERE id=?`;
                    const DEL_ONE_SQL = 'DELETE FROM timetable WHERE id=?';

                    for (const day of effectiveDays) {
                        // Existing rows for this day (only future/today, since past days are filtered upstream)
                        const existingRows = await db.all('SELECT * FROM timetable WHERE competition_id=? AND day=?', parseInt(competition_id), day);

                        // Skip if this day is in the past (safety)
                        const sampleRow = existingRows[0];
                        if (sampleRow && sampleRow.scheduled_date && sampleRow.scheduled_date < todayStr) {
                            preservedCount += existingRows.length;
                            continue;
                        }

                        // Build match key for existing rows
                        const buildKey = (r) => `${r.time||''}|${(r.event_name||'').trim()}|${(r.category||'').trim()}|${(r.round||'').trim()}`;
                        const existingByKey = new Map();
                        existingRows.forEach(r => {
                            const k = buildKey(r);
                            if (!existingByKey.has(k)) existingByKey.set(k, []);
                            existingByKey.get(k).push(r);
                        });

                        // New entries for this day
                        const newEntries = filteredEntries.filter(e => e.day === day);
                        const matchedExistingIds = new Set();

                        for (const e of newEntries) {
                            const k = buildKey(e);
                            const candidates = existingByKey.get(k);
                            if (candidates && candidates.length > 0) {
                                // UPDATE: take first unmatched candidate
                                const target = candidates.shift();
                                matchedExistingIds.add(target.id);
                                await db.run(UPD_TT_SQL, e.section, e.note || target.note, e.sort_order, e.scheduled_date, target.id);
                                updatedCount++;
                            } else {
                                // INSERT new row
                                await db.run(INS_TT_SQL, e.competition_id, e.day, e.section, e.time, e.event_name, e.category, e.round, e.note, e.sort_order, e.scheduled_date);
                                addedCount++;
                            }
                        }

                        // DELETE existing rows that are not in the new upload
                        for (const r of existingRows) {
                            if (!matchedExistingIds.has(r.id)) {
                                await db.run(DEL_ONE_SQL, r.id);
                                deletedCount++;
                            }
                        }
                    }

                    // Count preserved (past) days
                    if (skippedPastDays.length > 0) {
                        const cnt = await db.get(`SELECT COUNT(*) AS c FROM timetable WHERE competition_id=? AND day IN (${skippedPastDays.map(()=>'?').join(',')})`, parseInt(competition_id), ...skippedPastDays);
                        preservedCount += (cnt && cnt.c) || 0;
                    }
                }

                // Create events (skip if already exists for this competition)
                const existingEvents = await db.all('SELECT id, name, gender, division, round_type FROM event WHERE competition_id=?', parseInt(competition_id));
                const existingSet = new Set(existingEvents.map(e => `${e.name}|${e.gender}|${e.division || ''}|${e.round_type}`));

                const INS_EVENT_SQL = 'INSERT INTO event (competition_id, name, category, gender, round_type, division, sort_order) VALUES (?,?,?,?,?,?,?)';
                const INS_CHILD_SQL = 'INSERT INTO event (competition_id, name, category, gender, round_type, division, parent_event_id, sort_order) VALUES (?,?,?,?,?,?,?,?)';
                let eventCount = 0;
                let sortIdx = existingEvents.length;

                // 결합경기 자식 링크용: (name|gender|division) → final 라운드 event id
                const finalIdByKey = {};
                for (const e of existingEvents) {
                    if (e.round_type === 'final') {
                        const k = `${e.name}|${e.gender}|${e.division || ''}`;
                        if (finalIdByKey[k] == null) finalIdByKey[k] = e.id;
                    }
                }

                // 1) 일반 + 결합 부모 먼저 생성 (자식 제외)
                for (const ev of Object.values(eventMap)) {
                    if (ev.isChild) continue;
                    const rounds = ev.rounds.size > 0 ? [...ev.rounds] : ['final'];
                    const hasP = rounds.includes('preliminary');
                    const hasS = rounds.includes('semifinal');
                    const roundsToCreate = [];
                    if (hasP) roundsToCreate.push('preliminary');
                    if (hasS) roundsToCreate.push('semifinal');
                    roundsToCreate.push('final');
                    const uniqueRounds = [...new Set(roundsToCreate)];

                    for (const rt of uniqueRounds) {
                        const key = `${ev.name}|${ev.gender}|${ev.division || ''}|${rt}`;
                        if (!existingSet.has(key)) {
                            const r = await db.run(INS_EVENT_SQL, parseInt(competition_id), ev.name, ev.category, ev.gender, rt, ev.division || '', sortIdx++);
                            existingSet.add(key);
                            eventCount++;
                            if (rt === 'final') finalIdByKey[`${ev.name}|${ev.gender}|${ev.division || ''}`] = r.lastInsertRowid;
                        }
                    }
                }

                // 2) 결합경기 자식 생성 — parent_event_id 로 부모에 연결
                for (const ev of Object.values(eventMap)) {
                    if (!ev.isChild) continue;
                    const parentId = finalIdByKey[ev.parentKey] || null;
                    const key = `${ev.name}|${ev.gender}|${ev.division || ''}|final`;
                    if (!existingSet.has(key)) {
                        await db.run(INS_CHILD_SQL, parseInt(competition_id), ev.name, ev.category, ev.gender, 'final', ev.division || '', parentId, sortIdx++);
                        existingSet.add(key);
                        eventCount++;
                    }
                }

                return {
                    ttCount: filteredEntries.length,
                    eventCount,
                    days: effectiveDays,
                    skippedPastDays,
                    addedCount, updatedCount, deletedCount, preservedCount,
                    mode: overwriteMode
                };
            });

            const result = await tx();

            // Auto-link timetable to events
            try { await autoLinkDisplayTimetable(parseInt(competition_id)); } catch(e) { console.warn('Display auto-link warning:', e.message); }

            // Compute callroom times
            try {
                const needCR = await db.all('SELECT id, time, section FROM timetable WHERE competition_id=? AND callroom_time IS NULL', parseInt(competition_id));
                for (const tt of needCR) {
                    const m = (tt.time || '').match(/^(\d{1,2}):(\d{2})/);
                    if (!m) continue;
                    let h = parseInt(m[1]), min = parseInt(m[2]);
                    const offset = (tt.section === 'field') ? 45 : 30;
                    min -= offset; while (min < 0) { min += 60; h -= 1; }
                    if (h >= 0) {
                        await db.run('UPDATE timetable SET callroom_time=? WHERE id=? AND callroom_time IS NULL', String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0'), tt.id);
                    }
                }
            } catch(e) {}

            try { fs.unlinkSync(req.file.path); } catch(e) {}

            // Build human-readable message
            let msg;
            if (result.mode === 'force') {
                msg = `[강제덮어쓰기] 시간표 ${result.ttCount}건 등록, 종목 ${result.eventCount}개 생성됨`;
            } else {
                const parts = [];
                if (result.addedCount) parts.push(`추가 ${result.addedCount}`);
                if (result.updatedCount) parts.push(`수정 ${result.updatedCount}`);
                if (result.deletedCount) parts.push(`삭제 ${result.deletedCount}`);
                if (result.skippedPastDays.length > 0) parts.push(`과거 ${result.skippedPastDays.map(d=>d+'일차').join('·')} 보존`);
                if (result.eventCount) parts.push(`종목 ${result.eventCount}개 신규`);
                msg = `[스마트머지] ${parts.join(' · ') || '변경 없음'}`;
            }

            opLog(`노출용 시간표 업로드 (${result.days.map(d=>d+'일차').join(', ') || '없음'}, ${msg})`, 'admin', 'admin', parseInt(competition_id));
            res.json({ success: true, ...result, message: msg });
        } catch(e) {
            console.error('Display timetable upload error:', e);
            try { if (req.file) fs.unlinkSync(req.file.path); } catch(ex) {}
            res.status(500).json({ error: '시간표 업로드 실패: ' + e.message });
        }
    });

    // 수동 재링크 API: 시간표의 모든 event_id를 NULL로 리셋한 뒤 autoLink 재실행
    //   사용 케이스: 잘못된 라벨로 매칭됐던 행을 일괄 재매칭 (필요 시 누락된 event 자동 생성)
    app.post('/api/display/timetable/relink/:compId', async (req, res) => {
        try {
            const { admin_key } = req.body;
            if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
            const compId = parseInt(req.params.compId);
            if (!compId) return res.status(400).json({ error: 'competition_id required' });

            const beforeRow = await db.get('SELECT COUNT(*) AS c FROM timetable WHERE competition_id=? AND event_id IS NOT NULL', compId);
            const before = beforeRow ? beforeRow.c : 0;
            await db.run('UPDATE timetable SET event_id=NULL WHERE competition_id=?', compId);
            const linked = await autoLinkDisplayTimetable(compId);
            const totalRow = await db.get('SELECT COUNT(*) AS c FROM timetable WHERE competition_id=?', compId);
            const total = totalRow ? totalRow.c : 0;
            const stillUnlinked = total - linked;
            opLog(`시간표 재링크 (이전 ${before} → 현재 ${linked}, 미매칭 ${stillUnlinked})`, 'admin', 'admin', compId);
            res.json({ success: true, total, linked, unlinked: stillUnlinked, before });
        } catch (e) {
            console.error('relink error:', e);
            res.status(500).json({ error: '재링크 실패: ' + e.message });
        }
    });

    // ─────────────────────────────────────────────────────────────────────
    // 명단 재매칭 API: 노출용 대회의 모든 명단 row event_id를 NULL로 리셋한 뒤
    // autoMatchDisplayRoster 재실행. 명단 PDF 재업로드 없이 매칭 로직만 갱신할 때 사용.
    // ─────────────────────────────────────────────────────────────────────
    app.post('/api/display/roster/relink/:compId', async (req, res) => {
        try {
            const { admin_key } = req.body;
            if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
            const compId = parseInt(req.params.compId);
            if (!compId) return res.status(400).json({ error: 'competition_id required' });

            const beforeRow = await db.get('SELECT COUNT(*) AS c FROM display_roster WHERE competition_id=? AND event_id IS NOT NULL', compId);
            const before = beforeRow ? beforeRow.c : 0;
            await db.run('UPDATE display_roster SET event_id=NULL WHERE competition_id=?', compId);
            const matched = await autoMatchDisplayRoster(compId);
            const totalRow = await db.get('SELECT COUNT(*) AS c FROM display_roster WHERE competition_id=?', compId);
            const total = totalRow ? totalRow.c : 0;
            const stillUnmatched = total - matched;
            opLog(`명단 재매칭 (이전 ${before} → 현재 ${matched}, 미매칭 ${stillUnmatched})`, 'admin', 'admin', compId);
            res.json({ success: true, total, matched, unmatched: stillUnmatched, before });
        } catch (e) {
            console.error('roster relink error:', e);
            res.status(500).json({ error: '명단 재매칭 실패: ' + e.message });
        }
    });

    // ─────────────────────────────────────────────────────────────────────
    // 미매칭 리포트 API: event_id가 NULL인 명단 row를 (event_name, round, division, gender) 별로 그룹화해서 반환.
    // 어떤 종목이 시간표에 없거나 표기가 다른지 한눈에 확인 가능.
    // ─────────────────────────────────────────────────────────────────────
    app.get('/api/display/roster/unmatched/:compId', async (req, res) => {
        try {
            const compId = parseInt(req.params.compId);
            if (!compId) return res.status(400).json({ error: 'competition_id required' });
            const rows = await db.all(`
                SELECT event_name, round, division, gender, COUNT(*) AS cnt
                FROM display_roster
                WHERE competition_id=? AND event_id IS NULL
                GROUP BY event_name, round, division, gender
                ORDER BY event_name, round, division, gender
            `, compId);
            const totalRow = await db.get('SELECT COUNT(*) AS c FROM display_roster WHERE competition_id=? AND event_id IS NULL', compId);
            const total = totalRow ? totalRow.c : 0;
            res.json({ success: true, total_unmatched: total, groups: rows });
        } catch (e) {
            console.error('unmatched report error:', e);
            res.status(500).json({ error: '미매칭 리포트 조회 실패: ' + e.message });
        }
    });

    // ─────────────────────────────────────────────────────────────────────
    // 고아 event 정리 API (노출용 대회 한정)
    //   사용 케이스: 옛날 코드(라벨 자유화 이전)로 시간표를 올렸을 때 잘못된
    //                division/gender 로 만들어진 event 들이 DB에 남아있음.
    //                재배포·재업로드 후, 시간표에 한 번도 링크되지 않고
    //                선수 엔트리/조/결과 링크도 없는 "고아 event" 만 안전 삭제.
    //
    //   안전 정책 (다음 조건 모두 만족해야 삭제 후보):
    //     - competition_id 일치
    //     - timetable.event_id 참조 0건 (재링크 후 미사용)
    //     - event_entry 0건 (선수 엔트리 없음)
    //     - heat 0건 (조 편성 없음)
    //     - result_url, video_url 모두 비어있음 (수동 입력 보호)
    //     - 다른 event 의 parent_event_id 로 참조되지 않음 (10종/7종 보호)
    //
    //   2단계 분리:
    //     GET  /api/display/cleanup-orphan-events/:compId  → 미리보기(삭제 안 함)
    //     POST /api/display/cleanup-orphan-events/:compId  → 실제 삭제
    // ─────────────────────────────────────────────────────────────────────
    async function _findOrphanEvents(compId) {
        return await db.all(`
            SELECT e.id, e.name, e.gender, e.division, e.round_type, e.category,
                   COALESCE(e.result_url,'') AS result_url,
                   COALESCE(e.video_url,'')  AS video_url
            FROM event e
            WHERE e.competition_id = ?
              AND COALESCE(e.result_url,'') = ''
              AND COALESCE(e.video_url,'')  = ''
              AND e.parent_event_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM timetable    t  WHERE t.event_id        = e.id)
              AND NOT EXISTS (SELECT 1 FROM event_entry  ee WHERE ee.event_id       = e.id)
              AND NOT EXISTS (SELECT 1 FROM heat         h  WHERE h.event_id        = e.id)
              AND NOT EXISTS (SELECT 1 FROM event        e2 WHERE e2.parent_event_id = e.id)
            ORDER BY e.id
        `, compId);
    }

    // 미리보기
    app.get('/api/display/cleanup-orphan-events/:compId', async (req, res) => {
        try {
            const admin_key = req.query.admin_key || req.headers['x-admin-key'] || '';
            if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
            const compId = parseInt(req.params.compId);
            if (!compId) return res.status(400).json({ error: 'competition_id required' });

            const comp = await db.get('SELECT id, name, mode FROM competition WHERE id=?', compId);
            if (!comp) return res.status(404).json({ error: '대회를 찾을 수 없습니다.' });
            if (comp.mode !== 'display') return res.status(400).json({ error: '노출용(display) 대회에서만 사용 가능합니다.' });

            const orphans = await _findOrphanEvents(compId);
            const totalEventsRow = await db.get('SELECT COUNT(*) AS c FROM event WHERE competition_id=?', compId);
            const totalEvents = totalEventsRow ? totalEventsRow.c : 0;

            // 그룹 요약
            const byBucket = {};
            orphans.forEach(o => {
                const k = `${o.division || '(EMPTY)'} | ${o.gender}`;
                byBucket[k] = (byBucket[k] || 0) + 1;
            });

            res.json({
                success: true,
                competition: { id: comp.id, name: comp.name },
                total_events: totalEvents,
                orphan_count: orphans.length,
                by_bucket: byBucket,
                orphans: orphans.map(o => ({
                    id: o.id, name: o.name, gender: o.gender,
                    division: o.division, round_type: o.round_type, category: o.category
                }))
            });
        } catch (e) {
            console.error('cleanup preview error:', e);
            res.status(500).json({ error: '미리보기 실패: ' + e.message });
        }
    });

    // 실제 삭제
    app.post('/api/display/cleanup-orphan-events/:compId', async (req, res) => {
        try {
            const { admin_key, dry_run } = req.body || {};
            if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
            const compId = parseInt(req.params.compId);
            if (!compId) return res.status(400).json({ error: 'competition_id required' });

            const comp = await db.get('SELECT id, name, mode FROM competition WHERE id=?', compId);
            if (!comp) return res.status(404).json({ error: '대회를 찾을 수 없습니다.' });
            if (comp.mode !== 'display') return res.status(400).json({ error: '노출용(display) 대회에서만 사용 가능합니다.' });

            const orphans = await _findOrphanEvents(compId);
            if (dry_run) {
                return res.json({
                    success: true, dry_run: true,
                    would_delete: orphans.length,
                    orphans: orphans.map(o => ({ id: o.id, name: o.name, gender: o.gender, division: o.division, round_type: o.round_type }))
                });
            }

            const deleted = await db.transaction(async () => {
                let n = 0;
                for (const o of orphans) {
                    await db.run('DELETE FROM event WHERE id=?', o.id);
                    n++;
                }
                return n;
            })();

            opLog(`고아 event 정리 (${deleted}개 삭제)`, 'admin', 'admin', compId);
            res.json({
                success: true,
                deleted,
                sample: orphans.slice(0, 20).map(o => ({ id: o.id, name: o.name, gender: o.gender, division: o.division, round_type: o.round_type }))
            });
        } catch (e) {
            console.error('cleanup orphan error:', e);
            res.status(500).json({ error: '정리 실패: ' + e.message });
        }
    });

    // Auto-link timetable to display-mode events
    async function autoLinkDisplayTimetable(compId) {
        // 노출용(display) 대회만 시간표 행으로 종목을 자동 생성한다.
        // 운영용(operation) 대회는 시간표에 다른 부(예: 대학부) 행이 섞여 있어도
        // 종목을 만들지 않고 "이미 존재하는 종목과의 매칭(링크)"만 수행한다.
        const _comp = await db.get('SELECT mode FROM competition WHERE id=?', compId);
        const allowAutoCreate = !!(_comp && _comp.mode === 'display');
        let events = await db.all('SELECT id, name, gender, division, round_type, category FROM event WHERE competition_id=?', compId);
        const ttRows = await db.all('SELECT id, event_name, category AS jongbyul, round, event_id FROM timetable WHERE competition_id=?', compId);

        const EM = require('../eventMatch');
        const norm = EM.normEvt;   // 시간표 자동연결·계측 가져오기와 같은 정규화 (콤마도 지운다: '10,000m' = '10000m')

        // Best-effort 카테고리 추정 (기존 동일 종목명에서 가져오거나 guessEventCategory)
        function guessCat(name) {
            const sameName = events.find(e => norm(e.name) === norm(name) && e.category);
            if (sameName) return sameName.category;
            return guessEventCategory(name);
        }

        let linked = 0;
        let createdEvents = 0;
        let nextSort = events.length;

        // 시간표 측에서도 동일한 정규화 기준 사용 (매칭 표기 차이 제거)
        function divNorm(d) { return normalizeDivisionLabel(d || ''); }

        for (const tt of ttRows) {
            if (tt.event_id) continue; // already linked
            const parsed = parseDisplayRound(tt.round);
            const jbParsed = parseJongbyulNormalized(tt.jongbyul);

            // 종합 sub-event는 부모 이벤트(N종경기)에 연결
            let targetName = tt.event_name;
            const isCombinedSub = parsed.is_combined && parsed.combined_n;
            if (isCombinedSub) {
                targetName = parsed.combined_n + '종경기';
            }
            const targetRound = isCombinedSub ? 'final' : parsed.round_type;
            const targetDivNorm = divNorm(jbParsed.division);

            // 1) Strict match: name + gender + division + round_type 모두 일치 — 공통 규칙 (부는 정규화 라벨로 비교)
            let match = EM.findEvents(events.map(ev => ({ ...ev, division: divNorm(ev.division) })), { name: targetName, gender: jbParsed.gender || null, round: targetRound, division: targetDivNorm }, { divisionStrict: true }).matches[0];
            if (match) match = events.find(ev => ev.id === match.id);

            // 2) Auto-create: 매칭 실패 시, parseJongbyul이 division을 추출했다면 누락된 event를 자동 생성
            //    (노출용 대회에서만 — 운영용은 종목 자동 생성 금지)
            if (!match && targetDivNorm && allowAutoCreate) {
                const cat = guessCat(targetName);
                const info = await db.run('INSERT INTO event (competition_id, name, category, gender, round_type, division, sort_order) VALUES (?,?,?,?,?,?,?)',
                    compId, targetName, cat, jbParsed.gender || 'X', targetRound, targetDivNorm, nextSort++);
                match = {
                    id: info.lastInsertRowid,
                    name: targetName,
                    gender: jbParsed.gender || 'X',
                    division: targetDivNorm,
                    round_type: targetRound,
                    category: cat,
                };
                events.push(match);
                createdEvents++;
            }

            if (match) {
                await db.run('UPDATE timetable SET event_id=? WHERE id=?', match.id, tt.id);
                linked++;
            }
        }

        if (createdEvents > 0) {
            console.log(`[autoLink] competition_id=${compId}: ${linked} linked, ${createdEvents} events auto-created from timetable`);
        }
        // 폴백: 위 strict 매칭은 "실업(남)"·"대학/실업(여)" 같은 부별 표기를 division 으로 해석해
        //   division 이 빈 운영용 종목과 연결하지 못함 → 시간표 업로드/재매칭과 동일한 매처로 남은 NULL 행만 재시도.
        //   (결승·준결승 생성 직후 시간표의 "결승" 행이 자동 연결되도록)
        try {
            const fb = await _timetableRoutes.autoLinkTimetable(compId);
            if (fb && fb.linked) linked += fb.linked;
        } catch (fbErr) {
            console.warn('[autoLink fallback] ', fbErr.message);
        }
        return linked;
    }

    // Upload roster PDF for display-mode competition
    app.post('/api/display/roster/upload', upload.single('file'), async (req, res) => {
        try {
            const { competition_id, admin_key, day, division_hint } = req.body;
            if (!competition_id) return res.status(400).json({ error: 'competition_id required' });
            if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
            if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });

            const dayNum = parseInt(day) || 1;
            // 파일명/사용자 입력에서 추출한 division_hint (PDF 파싱이 부 라벨을 못 찾을 때 fallback)
            // 예: "꿈나무" / "선수권" / "U18" / "U20"  (성별 정보가 같이 들어오면 "선수권 남자" 처럼)
            const divisionHint = (division_hint || '').toString().trim();
            const pdfParse = require('pdf-parse');
            const pdfBuffer = fs.readFileSync(req.file.path);

            pdfParse(pdfBuffer).then(async pdfData => {
                const text = pdfData.text;
                const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

                // --- Team database for parsing concatenated athlete lines ---
                // School suffixes (중학교, 고등학교, 대학교, etc.)
                const SCHOOL_SUFFIXES = [
                    '체육중학교', '여자중학교', '중학교',
                    '체육고등학교', '여자고등학교', '고등학교',
                    '대학교', '대학'
                ];
                // Pro team suffixes
                const TEAM_SUFFIXES = [
                    '특별자치도체육회', '특별자치도청', '광역시청', '특별시청',
                    '시체육회', '도체육회', '시청', '군청', '도청', '체육회', '은행',
                    '도시개발공사', '개발공사', '스포츠클럽_중', '스포츠클럽_고',
                    '스포츠클럽', '국군체육부대', '남동구청'
                ];
                const ALL_SUFFIXES = [...SCHOOL_SUFFIXES, ...TEAM_SUFFIXES].sort((a, b) => b.length - a.length);

                // Known team/school prefixes for better matching
                const KNOWN_TEAMS = [
                    '한국체육대학교', '국립경국대학교', '서울대학교', '성균관대학교', '성결대학교',
                    '동아대학교', '조선대학교', '군산대학교', '원광대학교', '목포대학교',
                    '경운대학교', '영남대학교', '경남대학교', '강원대학교', '인하대학교',
                    '부산대학교', '문경대학교', 'SH서울주택도시개발공사',
                    '전북개발공사', '무소속'
                ];

                const LOCATIONS = [
                    '서울', '부산', '대구', '인천', '광주', '대전', '울산', '세종',
                    '경기', '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주',
                    '수원', '성남', '안양', '안산', '용인', '부천', '광명', '평택', '과천',
                    '오산', '시흥', '군포', '의왕', '하남', '이천', '안성', '김포', '화성',
                    '양주', '포천', '여주', '파주', '고양', '구리', '남양주', '동두천', '의정부',
                    '춘천', '원주', '강릉', '동해', '태백', '속초', '삼척',
                    '충주', '제천', '청주', '천안', '공주', '보령', '아산', '서산', '논산', '계룡', '당진',
                    '전주', '군산', '익산', '정읍', '남원', '김제',
                    '목포', '여수', '순천', '나주', '광양',
                    '포항', '경주', '김천', '안동', '구미', '영주', '영천', '상주', '문경', '경산',
                    '창원', '진주', '통영', '사천', '김해', '밀양', '거제', '양산',
                    '서귀포', '영암', '진천', '음성', '영동', '정선', '단양', '보은',
                    '가평', '양평', '연천', '영월', '철원', '화천', '양구', '인제', '고성', '양양',
                    '옥천', '증평', '괴산',
                    '금산', '부여', '서천', '청양', '홍성', '예산', '태안',
                    '완주', '진안', '무주', '장수', '임실', '순창', '고창', '부안',
                    '담양', '곡성', '구례', '고흥', '보성', '화순', '장흥', '강진', '해남',
                    '무안', '함평', '영광', '장성', '완도', '진도', '신안', '진도',
                    '군위', '의성', '청송', '영양', '영덕', '청도', '고령', '성주', '칠곡', '예천',
                    '봉화', '울진', '울릉',
                    '의령', '함안', '창녕', '남해', '하동', '산청', '함양', '거창', '합천',
                    '강원특별자치', '경상북', '인천남동', '범어', '경기경안', '진주대곡',
                    '진주문산', '진해냉천', '철산', '경수', '여선', '성서', '금파', '석우',
                    '서생', '대청', '문산', '단원', '인천동방', '구월여자', '인화여자', '와동',
                    '계남', '내동', '배문', '전곡', '문산수억', '심원', '덕계', '원곡', '유신',
                    '충남', '충현', '순심', '남녕', '인일여자', '포항이동',
                    '울산스포츠과학', '경기모바일과학', '김포과학기술', '과천중앙', '광주중앙',
                    '대전송촌'
                ];
                const LOCATIONS_SORTED = [...LOCATIONS].sort((a, b) => b.length - a.length);

                function parseNameTeam(koreanPart) {
                    if (!koreanPart || koreanPart.length < 4) return { name: koreanPart || '', team: '' };
                    
                    // Handle special cases: "무소속(경기)", "무소속(서울)" etc.
                    const musoMatch = koreanPart.match(/^(.{2,4})(무소속\(.+\))$/);
                    if (musoMatch) return { name: musoMatch[1], team: musoMatch[2] };
                    
                    // Handle (주) prefix teams
                    const specialIdx = koreanPart.indexOf('(주)');
                    if (specialIdx > 0 && specialIdx >= 2) {
                        return { name: koreanPart.substring(0, specialIdx), team: koreanPart.substring(specialIdx) };
                    }

                    // Try known full team names first
                    for (const kt of KNOWN_TEAMS) {
                        if (koreanPart.endsWith(kt) && koreanPart.length > kt.length + 1) {
                            const nameEnd = koreanPart.length - kt.length;
                            if (nameEnd >= 2 && nameEnd <= 5) {
                                return { name: koreanPart.substring(0, nameEnd), team: kt };
                            }
                        }
                    }

                    // Strategy: find the longest valid team suffix from the end
                    // Korean names are 2-4 chars (most commonly 3)
                    // Teams end with: 중학교, 고등학교, 대학교, 시청, 군청, 도청, 체육회, etc.
                    // Try name lengths 3, 2, 4 (prefer 3 as most common Korean name length)
                    const teamIndicators = [
                        '중학교', '고등학교', '대학교', '대학', '시청', '군청', '도청',
                        '체육회', '도시개발공사', '개발공사', '국군체육부대',
                        '구청', '스포츠클럽', '공사', '클럽_중', '클럽_고'
                    ];
                    
                    // Prefer 3-char name (most common), then 2, then 4
                    for (const nameLen of [3, 2, 4]) {
                        if (nameLen >= koreanPart.length) continue;
                        const possibleTeam = koreanPart.substring(nameLen);
                        // Check if possibleTeam contains a team indicator
                        if (teamIndicators.some(ind => possibleTeam.includes(ind))) {
                            return { name: koreanPart.substring(0, nameLen), team: possibleTeam };
                        }
                    }

                    // Try suffix-based matching with location for pro teams (시청, 군청, etc.)
                    for (const suffix of TEAM_SUFFIXES) {
                        if (!koreanPart.endsWith(suffix)) continue;
                        const beforeSuffix = koreanPart.substring(0, koreanPart.length - suffix.length);
                        for (const loc of LOCATIONS_SORTED) {
                            if (beforeSuffix.endsWith(loc)) {
                                const teamStart = beforeSuffix.length - loc.length;
                                if (teamStart >= 2 && teamStart <= 4) {
                                    return { name: koreanPart.substring(0, teamStart), team: koreanPart.substring(teamStart) };
                                }
                            }
                        }
                    }

                    // Fallback: assume Korean name is 3 chars (most common)
                    if (koreanPart.length >= 5) {
                        return { name: koreanPart.substring(0, 3), team: koreanPart.substring(3) };
                    }
                    return { name: koreanPart, team: '' };
                }

                // --- Division/Gender mapping (명단 PDF용) ---
                // 출력 division은 항상 normalizeDivisionLabel을 통과시켜 시간표 측 표기와 결정적으로 일치하게 함.
                function parseDivisionMarker(line) {
                    let gender = '', division = '';
                    const orig = line;

                    // ── 신형 라벨 우선 처리 ─────────────────────────────────────
                    // 1) "남초 4학년부", "여초 5학년부" 등 → 초등부
                    let m = orig.match(/^(남|여)초\s*(\d+학년부)?$/);
                    if (m) {
                        return { gender: m[1] === '남' ? 'M' : 'F', division: normalizeDivisionLabel('초등부') };
                    }
                    // 1.5) ★ 추가: "남중 1/2학년부", "여중 3학년부", "남고", "여고", "남대", "여대"
                    //      꿈나무 PDF에 "남중 1/2학년부" 같은 라벨이 등장 — 기존엔 인식 못해 초등부 hint로 잘못 흘러감(Bug C 잔여).
                    m = orig.match(/^(남|여)중(\s*[\d/]+학년부)?$/);
                    if (m) {
                        return { gender: m[1] === '남' ? 'M' : 'F', division: normalizeDivisionLabel('중등부') };
                    }
                    m = orig.match(/^(남|여)고(\s*\d+학년부)?$/);
                    if (m) {
                        return { gender: m[1] === '남' ? 'M' : 'F', division: normalizeDivisionLabel('고등부') };
                    }
                    m = orig.match(/^(남|여)대(\s*\d+학년부)?$/);
                    if (m) {
                        return { gender: m[1] === '남' ? 'M' : 'F', division: normalizeDivisionLabel('대학부') };
                    }
                    // 2) "선수권 남자부" / "선수권 여자부" / "선수권 혼성부"
                    m = orig.match(/^선수권\s*(남자|여자|혼성)부?$/);
                    if (m) {
                        const g = m[1] === '남자' ? 'M' : (m[1] === '여자' ? 'F' : 'X');
                        const dv = m[1] === '남자' ? '선수권(남)' : (m[1] === '여자' ? '선수권(여)' : '선수권(혼)');
                        return { gender: g, division: normalizeDivisionLabel(dv) };
                    }
                    // 3) "U18 남자부" / "U20 여자부" / "U18 혼성부"
                    m = orig.match(/^U(18|20)\s*(남자|여자|혼성)부?$/i);
                    if (m) {
                        const g = m[2] === '남자' ? 'M' : (m[2] === '여자' ? 'F' : 'X');
                        const dv = `U${m[1]}(${m[2] === '남자' ? '남' : (m[2] === '여자' ? '여' : '혼')})`;
                        return { gender: g, division: normalizeDivisionLabel(dv) };
                    }
                    // 4) "꿈나무 남자부" / "꿈나무 여자부" (혹시 등장 시)
                    m = orig.match(/^꿈나무\s*(남자|여자)부?$/);
                    if (m) {
                        return { gender: m[1] === '남자' ? 'M' : 'F', division: normalizeDivisionLabel('초등부') };
                    }

                    // ── 구형 라벨: "남자/여자" + 중학교부/고등학교부/... ──
                    if (line.startsWith('남자')) { gender = 'M'; line = line.substring(2); }
                    else if (line.startsWith('여자')) { gender = 'F'; line = line.substring(2); }
                    const divMap = {
                        '실업부': '일반부', '일반부': '일반부',
                        '대학부': '대학부', '대학교부': '대학부',
                        '고등부': '고등부', '고등학교부': '고등부',
                        '중등부': '중등부', '중학교부': '중등부',
                        '초등부': '초등부', '초등학교부': '초등부',
                    };
                    for (const [key, val] of Object.entries(divMap)) {
                        if (line.startsWith(key)) { division = val; break; }
                    }
                    if (!division && line) division = line;
                    return { gender, division: normalizeDivisionLabel(division) };
                }

                // ============================================================
                // v4 PARSING: 라벨 기반 섹션 분할 + 릴레이 팀단위 + 혼성경기 통합 + noSeq 헤더
                //   - tmp/pdf_to_excel.js 의 v4 로직과 동일한 알고리즘
                //   - 부 라벨은 "라벨 등장 라인까지의 모든 라인 = 그 라벨" 로 묶음 (페이지 경계 무시)
                //   - 릴레이(4xNNNm[R] / 릴레이)는 첫 행만 = 레인+팀 한 행 (성명/배번 비움)
                //   - 혼성경기(round나 event_name에 (N종))는 dedup 통합해 "N종경기" 1행 per 선수
                //   - noSeqMode: 조헤더가 "N조레인번호성명소속"(공백 없음)이면 첫자리=레인, 나머지=배번
                // ============================================================
                const divMarkerRegex = new RegExp(
                    '^(?:' +
                        '(?:남자|여자)?(?:초등학교부|중학교부|고등학교부|대학교부|일반부|초등부|중등부|고등부|대학부|실업부)' +
                        '|(?:남|여)초(?:\\s*[\\d/]+학년부)?' +
                        '|(?:남|여)중(?:\\s*[\\d/]+학년부)?' +
                        '|(?:남|여)고(?:\\s*[\\d/]+학년부)?' +
                        '|(?:남|여)대(?:\\s*[\\d/]+학년부)?' +
                        '|선수권\\s*(?:남자|여자|혼성)부?' +
                        '|U(?:18|20)\\s*(?:남자|여자|혼성)부?' +
                        '|꿈나무\\s*(?:남자|여자)부?' +
                    ')$',
                    'i'
                );

                // ── 파일명 힌트 fallback ──
                const hintParsed = divisionHint ? parseDivisionMarker(divisionHint) : null;
                const hintFallback = (hintParsed && hintParsed.division) ? hintParsed : null;
                if (hintFallback) {
                    console.log(`[roster/upload v4] divisionHint="${divisionHint}" → ${JSON.stringify(hintFallback)}`);
                }

                // ── 라벨 기반 섹션 분할 ──
                //   페이지 마커(-NN-)는 제거. 부 라벨 라인 만나면 그 라벨까지의 모든 라인을 섹션으로 묶음.
                //   라벨 없이 끝난 마지막 섹션은 직전 라벨 또는 hintFallback 상속.
                const flatLines = lines.filter(l => !/^-\d+-$/.test(l));
                const sections = [];
                let curSec = [];
                let lastDivSeen = hintFallback
                    ? { gender: hintFallback.gender, division: hintFallback.division }
                    : { gender: '', division: '' };
                for (const l of flatLines) {
                    if (divMarkerRegex.test(l)) {
                        const parsed = parseDivisionMarker(l);
                        if (parsed && parsed.division) {
                            sections.push({ lines: curSec, div: parsed });
                            lastDivSeen = parsed;
                            curSec = [];
                            continue;
                        }
                    }
                    curSec.push(l);
                }
                if (curSec.length) sections.push({ lines: curSec, div: lastDivSeen });

                // ── splitSeqAndBib (lastSeq 추적용) ──
                function splitSeqAndBib(digits, expectedSeq) {
                    if (!digits) return { seq: null, bib: '' };
                    if (digits.length >= 3 && expectedSeq >= 10) {
                        const twoDigit = parseInt(digits.substring(0, 2));
                        if (twoDigit === expectedSeq) return { seq: twoDigit, bib: digits.substring(2) };
                    }
                    if (digits.length >= 2) {
                        const oneDigit = parseInt(digits[0]);
                        if (oneDigit === expectedSeq && expectedSeq >= 1 && expectedSeq <= 9) {
                            return { seq: oneDigit, bib: digits.substring(1) };
                        }
                    }
                    if (digits.length >= 3) {
                        const twoDigit = parseInt(digits.substring(0, 2));
                        if (twoDigit >= 10 && twoDigit <= 99) return { seq: twoDigit, bib: digits.substring(2) };
                    }
                    if (digits.length >= 2) return { seq: parseInt(digits[0]), bib: digits.substring(1) };
                    return { seq: null, bib: digits };
                }

                // ── 릴레이 종목 판별 ──
                function isRelayEvent(eventName) {
                    if (!eventName) return false;
                    return /\d\s*[x×Xx]\s*\d{2,4}\s*m?\s*R?/i.test(eventName)
                        || /릴레이/.test(eventName)
                        || /relay/i.test(eventName);
                }

                // ── 팀명(학교/시청/구청 등) 키워드 포함 여부 ──
                const TEAM_KEYWORDS = [
                    '초등학교','중학교','고등학교','대학교','대학','시청','군청','도청','체육회',
                    '도시개발공사','개발공사','국군체육부대','구청','스포츠클럽','공사',
                    '클럽_중','클럽_고','클럽_초','체육부대',
                ];
                function hasTeamKeyword(s) {
                    if (!s) return false;
                    return TEAM_KEYWORDS.some(k => s.includes(k));
                }

                // ── 한 섹션 파싱 ──
                const rosterEntries = [];
                let sortOrder = 0;

                function parseSection(secLines, pageDiv) {
                    let currentEvent = '', currentRound = '';
                    let currentHeat = null;
                    let laneHeaderSeen = false;
                    let lastEntryIdx = -1;
                    let lastSeq = 0;
                    let noSeqMode = false;
                    let relayMode = false;
                    let relayCurrentLane = null;

                    for (let i = 0; i < secLines.length; i++) {
                        const line = secLines[i];
                        if (!line) continue;
                        if (divMarkerRegex.test(line)) continue;
                        if (/^(KTFL|KOREA|TRACK|FIELD|LEAGUE|&|한국실업육상연맹|한국중고육상연맹|한국대학육상연맹|한국육상연맹|대한육상연맹)$/.test(line)) continue;

                        // 종목 헤더 (이중괄호 케이스 우선): ▣ 4x400mR(Mixed) (결승)
                        const evMatchDouble = line.match(/^[▣■□●○]\s*(.+?)\s*[\(（](.+?)[\)）]\s*[\(（](.+?)[\)）]\s*$/);
                        if (evMatchDouble) {
                            currentEvent = (evMatchDouble[1] + '(' + evMatchDouble[2] + ')').trim();
                            currentRound = evMatchDouble[3].trim();
                            currentHeat = null;
                            laneHeaderSeen = false;
                            lastEntryIdx = -1;
                            lastSeq = 0;
                            noSeqMode = false;
                            relayMode = isRelayEvent(currentEvent);
                            relayCurrentLane = null;
                            continue;
                        }
                        // 종목 헤더 (단일 괄호): ▣ 100m (5-2+6) | ▣ 100m(10종)
                        const evMatch = line.match(/^[▣■□●○]\s*(.+?)\s*[\(（](.+?)[\)）]\s*$/);
                        if (evMatch) {
                            currentEvent = evMatch[1].trim();
                            currentRound = evMatch[2].trim();
                            currentHeat = null;
                            laneHeaderSeen = false;
                            lastEntryIdx = -1;
                            lastSeq = 0;
                            noSeqMode = false;
                            relayMode = isRelayEvent(currentEvent);
                            relayCurrentLane = null;
                            continue;
                        }

                        // 조 헤더: "1조레인번호성명소속" (붙음→noSeq) | "1조   레인  번호성명소속" (공백→일반)
                        const heatMatch = line.match(/^(\d+)조\s*((?:레인|순)?\s*(?:번호)?\s*(?:성명)?\s*(?:소속)?)?\s*$/);
                        if (heatMatch) {
                            currentHeat = parseInt(heatMatch[1]);
                            laneHeaderSeen = true;
                            lastEntryIdx = -1;
                            lastSeq = 0;
                            const afterHeat = line.replace(/^\d+조/, '');
                            // 핵심 규칙:
                            //  · '순' 키워드가 들어가면 → 무조건 lastSeq 추적 모드 (noSeqMode=false)
                            //    (1500m 1조처럼 출전 인원이 10명을 넘어 두자리 순번이 나올 수 있음)
                            //  · '레인' 키워드만 있거나 키워드가 없을 때만 → 공백 유무로 noSeqMode 결정
                            //    (레인은 1~9 한자리이므로 noSeqMode 적용 안전)
                            if (/순/.test(afterHeat)) {
                                noSeqMode = false;
                            } else if (afterHeat && /\S/.test(afterHeat) && !/\s/.test(afterHeat)) {
                                noSeqMode = true;
                            } else {
                                noSeqMode = false;
                            }
                            relayCurrentLane = null;
                            continue;
                        }
                        // 비-조 헤더 "레인번호성명소속" / "레인  번호성명소속" (릴레이/필드)
                        // 주의: '순'은 여기서 매칭하지 않음 — 순은 lastSeq 추적이 필요하므로 아래 별도 분기
                        if (/^레인\s*(?:번호)?\s*(?:성명)?\s*(?:소속)?$/.test(line)) {
                            laneHeaderSeen = true;
                            lastSeq = 0;
                            noSeqMode = true; // 레인은 1~9 한자리 → noSeqMode 안전
                            relayCurrentLane = null;
                            continue;
                        }
                        // 필드 종목 "순번호성명소속" — 순 사용 (10명+ 가능 → lastSeq 추적 필수)
                        if (/^순\s*(?:번호)?\s*(?:성명)?\s*(?:소속)?$/.test(line)) {
                            laneHeaderSeen = true;
                            lastSeq = 0;
                            noSeqMode = false;
                            relayCurrentLane = null;
                            continue;
                        }
                        if (/^번호\s*성명/.test(line)) continue;

                        if (!currentEvent) continue;

                        // ──────── 릴레이 모드 ────────
                        if (relayMode) {
                            // R-A: "4   129김이겸    전곡고등학교" (공백 분리)
                            const rA = line.match(/^([1-9])\s+\d{1,3}\s*[가-힣]{2,4}\s+(.+)$/);
                            if (rA) {
                                relayCurrentLane = parseInt(rA[1]);
                                const team = rA[2].trim();
                                rosterEntries.push({
                                    competition_id: parseInt(competition_id), day: dayNum,
                                    event_name: currentEvent, round: currentRound,
                                    division: pageDiv.division, gender: pageDiv.gender,
                                    bib_number: '', athlete_name: '', team,
                                    sort_order: sortOrder++, heat: null, lane: relayCurrentLane,
                                });
                                lastEntryIdx = rosterEntries.length - 1;
                                continue;
                            }
                            // R-B: "4614민지현화성시청" (붙음, 첫 행)
                            const rB = line.match(/^(\d+)([가-힣].+)$/);
                            if (rB) {
                                const digits = rB[1];
                                const rest = rB[2];
                                const nt = parseNameTeam(rest);
                                if (nt.team && hasTeamKeyword(nt.team)) {
                                    relayCurrentLane = parseInt(digits[0]);
                                    rosterEntries.push({
                                        competition_id: parseInt(competition_id), day: dayNum,
                                        event_name: currentEvent, round: currentRound,
                                        division: pageDiv.division, gender: pageDiv.gender,
                                        bib_number: '', athlete_name: '', team: nt.team,
                                        sort_order: sortOrder++, heat: null, lane: relayCurrentLane,
                                    });
                                    lastEntryIdx = rosterEntries.length - 1;
                                    continue;
                                }
                                // 후속 멤버 행 (이름만, 팀 키워드 없음) → 스킵
                                continue;
                            }
                            // 한글만 있는 라인 — 직전 entry 의 team 보강
                            if (/^[가-힣A-Za-z_()（）\s]+$/.test(line) && lastEntryIdx >= 0
                                && rosterEntries[lastEntryIdx] && !rosterEntries[lastEntryIdx].team
                                && hasTeamKeyword(line)) {
                                rosterEntries[lastEntryIdx].team = line.trim();
                                continue;
                            }
                            continue;
                        }
                        // ──────── 일반 모드 ────────

                        let lane = null, bib = '', namePart = '', teamPart = '';

                        // 패턴 A: "5   31양지은    학교" (공백 분리, 한자리 순)
                        const aMatch = line.match(/^([1-9])\s+(\d{1,3})\s*([가-힣]{2,4})(?:\s{2,}(.+))?\s*$/);
                        if (aMatch) {
                            lane = parseInt(aMatch[1]);
                            bib = aMatch[2];
                            namePart = aMatch[3];
                            teamPart = (aMatch[4] || '').trim();
                        } else {
                            // 패턴 A2: "10  149김인혜    학교" (공백 분리, 두자리 순)
                            const aMatch2 = line.match(/^(\d{1,2})\s{2,}(\d{1,3})\s*([가-힣]{2,4})(?:\s{2,}(.+))?\s*$/);
                            if (aMatch2) {
                                lane = parseInt(aMatch2[1]);
                                bib = aMatch2[2];
                                namePart = aMatch2[3];
                                teamPart = (aMatch2[4] || '').trim();
                            } else {
                                // 패턴 C/D (붙음)
                                const m = line.match(/^(\d+)([가-힣].+)$/);
                                if (m) {
                                    const digits = m[1];
                                    const rest = m[2];
                                    if (noSeqMode) {
                                        // 순 없는 페이지: 첫 한자리=레인, 나머지=배번
                                        lane = parseInt(digits[0]);
                                        bib = digits.substring(1);
                                    } else {
                                        const expectedSeq = lastSeq + 1;
                                        const split = splitSeqAndBib(digits, expectedSeq);
                                        lane = split.seq;
                                        bib = split.bib;
                                    }
                                    const nt = parseNameTeam(rest);
                                    namePart = nt.name;
                                    teamPart = nt.team;
                                }
                            }
                        }

                        // 유효성 검증
                        const bibNum = parseInt(bib);
                        if (!namePart || namePart.length < 2 || !bibNum || bibNum <= 0 || bibNum >= 10000) {
                            // 직전 entry 의 소속 보강
                            if (/^[가-힣A-Za-z_()（）]/.test(line) && lastEntryIdx >= 0
                                && rosterEntries[lastEntryIdx] && !rosterEntries[lastEntryIdx].team
                                && !line.startsWith('▣')
                                && !/^(순|레인|번호|성명|소속)/.test(line)) {
                                rosterEntries[lastEntryIdx].team = line;
                            }
                            continue;
                        }

                        // 레인 저장 조건: heat 또는 laneHeader 가 보였을 때만
                        const laneToStore = (currentHeat || laneHeaderSeen) ? lane : null;

                        rosterEntries.push({
                            competition_id: parseInt(competition_id), day: dayNum,
                            event_name: currentEvent, round: currentRound,
                            division: pageDiv.division, gender: pageDiv.gender,
                            bib_number: bib, athlete_name: namePart, team: teamPart,
                            sort_order: sortOrder++, heat: currentHeat, lane: laneToStore,
                        });
                        lastEntryIdx = rosterEntries.length - 1;

                        if (typeof lane === 'number' && lane > 0 && lane === lastSeq + 1) {
                            lastSeq = lane;
                        } else if (typeof lane === 'number' && lane > lastSeq && !noSeqMode) {
                            lastSeq = lane;
                        }
                    }
                }

                // ── 모든 섹션 파싱 ──
                for (const sec of sections) {
                    const effDiv = (sec.div && sec.div.division)
                        ? sec.div
                        : (hintFallback || { gender: '', division: '' });
                    parseSection(sec.lines, effDiv);
                }

                // ── 혼성경기(10종/7종) 통합 dedup ──
                //   event_name 또는 round 에 "(N종)"이 들어가면 → "N종경기" 단일 종목으로 통합
                //   같은 (division, gender, athlete_name, team, N) 키로 첫 등장만 유지
                function combinedEventName(eventName, round) {
                    const text = `${eventName || ''} ${round || ''}`;
                    const m = text.match(/(\d+)\s*종/);
                    if (m) return `${m[1]}종경기`;
                    return null;
                }
                const dedupedEntries = [];
                const combinedSeen = new Set();
                for (const e of rosterEntries) {
                    const cn = combinedEventName(e.event_name, e.round);
                    if (cn) {
                        const key = `${e.division}|${e.gender}|${e.athlete_name}|${e.team}|${cn}`;
                        if (combinedSeen.has(key)) continue;
                        combinedSeen.add(key);
                        dedupedEntries.push({
                            ...e,
                            event_name: cn,
                            round: '결승',
                            heat: null,
                            lane: null,
                        });
                    } else {
                        dedupedEntries.push(e);
                    }
                }
                rosterEntries.length = 0;
                for (const e of dedupedEntries) rosterEntries.push(e);

                // ⚠️ 부분 교체: 이번 PDF에 들어있는 (부·성별·종목) 조합만 삭제 후 재삽입.
                //   예전엔 day 전체를 지워서, 같은 날 코리아오픈 PDF → 초중고 PDF 순으로 올리면
                //   먼저 올린 명단(예: 코리아오픈 100m)이 통째로 사라졌음.
                //   이제 다른 부/종목(다른 PDF)은 보존되고, 같은 PDF 재업로드만 해당 종목을 갱신.
                const delKeys = new Map();
                for (const e of rosterEntries) {
                    const k = `${e.division || ''}${e.gender || ''}${e.event_name || ''}`;
                    if (!delKeys.has(k)) delKeys.set(k, { division: e.division || '', gender: e.gender || '', event_name: e.event_name || '' });
                }

                // Insert parsed roster (해당 부·성별·종목만 교체)
                await db.transaction(async () => {
                    for (const { division, gender, event_name } of delKeys.values()) {
                        await db.run('DELETE FROM display_roster WHERE competition_id=? AND day=? AND division=? AND gender=? AND event_name=?',
                            parseInt(competition_id), dayNum, division, gender, event_name);
                    }
                    for (const e of rosterEntries) {
                        await db.run('INSERT INTO display_roster (competition_id, day, event_name, round, division, gender, bib_number, athlete_name, team, sort_order, heat, lane) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
                            e.competition_id, e.day, e.event_name, e.round, e.division, e.gender, e.bib_number, e.athlete_name, e.team, e.sort_order, e.heat || null, e.lane || null);
                    }
                })();

                // Auto-match roster to events
                try { await autoMatchDisplayRoster(parseInt(competition_id)); } catch(e) { console.warn('Roster auto-match warning:', e.message); }

                try { fs.unlinkSync(req.file.path); } catch(e) {}
                opLog(`노출용 명단 업로드 (${dayNum}일차, ${rosterEntries.length}명)`, 'admin', 'admin', parseInt(competition_id));
                res.json({ success: true, count: rosterEntries.length, day: dayNum, message: `${dayNum}일차 명단 ${rosterEntries.length}명 등록됨` });
            }).catch(err => {
                try { fs.unlinkSync(req.file.path); } catch(e) {}
                res.status(500).json({ error: 'PDF 파싱 실패: ' + err.message });
            });
        } catch(e) {
            console.error('Roster upload error:', e);
            try { if (req.file) fs.unlinkSync(req.file.path); } catch(ex) {}
            res.status(500).json({ error: '명단 업로드 실패: ' + e.message });
        }
    });

    // ============================================================
    // Excel 명단 업로드 (결정적 컬럼 매핑 — PDF 추측 매칭 대안)
    // ============================================================
    // PDF 추측 파싱이 엣지 케이스에서 계속 실패하므로, 사용자가 PDF→Excel 변환본을
    // 직접 검수/수정한 후 업로드하는 워크플로를 지원한다.
    //
    // 기대 컬럼(헤더 한글 또는 영문 모두 허용):
    //   일차/day, 종목/event_name, 라운드/round, 라운드타입/round_type,
    //   조/heat, 레인/lane, 배번/bib_number, 성명/athlete_name,
    //   소속/team, 부/division, 성별/gender
    //
    // 동작:
    //   ① day 별로 기존 display_roster를 삭제 후 새로 INSERT
    //   ② 업로드 직후 autoMatchDisplayRoster 호출 (시간표 events와 매칭)
    //   ③ 매칭이 안 된 행은 관리 페이지에서 "수동 매칭"으로 직접 지정 가능
    app.post('/api/display/roster/upload-excel', upload.single('file'), async (req, res) => {
        try {
            const { competition_id, admin_key } = req.body;
            if (!competition_id) return res.status(400).json({ error: 'competition_id required' });
            if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
            if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });

            const comp = await db.get('SELECT * FROM competition WHERE id=?', parseInt(competition_id));
            if (!comp) { try { fs.unlinkSync(req.file.path); } catch(e) {} return res.status(404).json({ error: '대회를 찾을 수 없습니다.' }); }

            const wb = XLSX.readFile(req.file.path);
            // 우선순위: '명단' 시트 > 첫번째 시트
            const sheetName = wb.SheetNames.find(s => s === '명단' || s === 'roster') || wb.SheetNames[0];
            const ws = wb.Sheets[sheetName];
            if (!ws) { try { fs.unlinkSync(req.file.path); } catch(e) {} return res.status(400).json({ error: '시트가 비어있습니다.' }); }

            const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
            if (data.length < 2) { try { fs.unlinkSync(req.file.path); } catch(e) {} return res.status(400).json({ error: '데이터 행이 없습니다.' }); }

            // 헤더 매핑 (한/영 모두 지원)
            const headerRow = data[0].map(c => String(c || '').trim());
            function findCol(...names) {
                for (const n of names) {
                    const idx = headerRow.findIndex(h => h === n);
                    if (idx >= 0) return idx;
                }
                return -1;
            }
            const colIdx = {
                day: findCol('일차', 'day'),
                event_name: findCol('종목', 'event_name', 'event'),
                round: findCol('라운드', 'round'),
                round_type: findCol('라운드타입', 'round_type'),
                heat: findCol('조', 'heat'),
                lane: findCol('레인', 'lane'),
                bib_number: findCol('배번', 'bib_number', 'bib'),
                athlete_name: findCol('성명', 'athlete_name', 'name'),
                team: findCol('소속', 'team'),
                division: findCol('부', 'division'),
                gender: findCol('성별', 'gender'),
            };

            if (colIdx.event_name < 0 || colIdx.athlete_name < 0) {
                try { fs.unlinkSync(req.file.path); } catch(e) {}
                return res.status(400).json({ error: '필수 컬럼(종목/성명)이 없습니다. README 시트의 양식을 참고하세요.' });
            }

            // 행 파싱 (정규화는 normalizeDivisionLabel 한 번만 거침)
            function gNorm(g) {
                const s = String(g || '').trim().toUpperCase();
                if (s === 'M' || s === '남' || s === '남자') return 'M';
                if (s === 'F' || s === '여' || s === '여자') return 'F';
                if (s === 'X' || s === '혼' || s === '혼성' || s === 'MIX') return 'X';
                return '';
            }

            const entries = [];
            const daysSeen = new Set();
            for (let i = 1; i < data.length; i++) {
                const row = data[i] || [];
                const evName = String(row[colIdx.event_name] || '').trim();
                const athName = String(row[colIdx.athlete_name] || '').trim();
                if (!evName || !athName) continue; // skip empty rows

                const dayRaw = colIdx.day >= 0 ? row[colIdx.day] : 1;
                const dayNum = parseInt(dayRaw) || 1;
                daysSeen.add(dayNum);

                const round = colIdx.round >= 0 ? String(row[colIdx.round] || '').trim() : '';
                const heatRaw = colIdx.heat >= 0 ? row[colIdx.heat] : '';
                const laneRaw = colIdx.lane >= 0 ? row[colIdx.lane] : '';
                const bib = colIdx.bib_number >= 0 ? String(row[colIdx.bib_number] || '').trim() : '';
                const team = colIdx.team >= 0 ? String(row[colIdx.team] || '').trim() : '';
                const divRaw = colIdx.division >= 0 ? String(row[colIdx.division] || '').trim() : '';
                const genderRaw = colIdx.gender >= 0 ? row[colIdx.gender] : '';

                entries.push({
                    competition_id: parseInt(competition_id),
                    day: dayNum,
                    event_name: evName,
                    round: round,
                    division: normalizeDivisionLabel(divRaw),
                    gender: gNorm(genderRaw),
                    bib_number: bib,
                    athlete_name: athName,
                    team: team,
                    sort_order: entries.length,
                    heat: heatRaw === '' || heatRaw === null ? null : (parseInt(heatRaw) || null),
                    lane: laneRaw === '' || laneRaw === null ? null : (parseInt(laneRaw) || null),
                });
            }

            if (entries.length === 0) {
                try { fs.unlinkSync(req.file.path); } catch(e) {}
                return res.status(400).json({ error: '유효한 명단 행이 없습니다.' });
            }

            // 트랜잭션: (일차·부·성별·종목) 단위로만 교체 후 INSERT
            //   day 전체를 지우면 다른 PDF/엑셀로 올린 다른 부·종목이 사라지므로 부분 교체.
            const delKeysX = new Map();
            for (const e of entries) {
                const k = `${e.day}${e.division || ''}${e.gender || ''}${e.event_name || ''}`;
                if (!delKeysX.has(k)) delKeysX.set(k, { day: e.day, division: e.division || '', gender: e.gender || '', event_name: e.event_name || '' });
            }
            await db.transaction(async () => {
                for (const { day, division, gender, event_name } of delKeysX.values()) {
                    await db.run('DELETE FROM display_roster WHERE competition_id=? AND day=? AND division=? AND gender=? AND event_name=?',
                        parseInt(competition_id), day, division, gender, event_name);
                }
                for (const e of entries) {
                    await db.run('INSERT INTO display_roster (competition_id, day, event_name, round, division, gender, bib_number, athlete_name, team, sort_order, heat, lane) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
                        e.competition_id, e.day, e.event_name, e.round, e.division, e.gender, e.bib_number, e.athlete_name, e.team, e.sort_order, e.heat, e.lane);
                }
            })();

            // Auto-match
            try { await autoMatchDisplayRoster(parseInt(competition_id)); } catch(e) { console.warn('Roster auto-match warning:', e.message); }

            try { fs.unlinkSync(req.file.path); } catch(e) {}
            opLog(`노출용 명단 Excel 업로드 (일차 ${[...daysSeen].sort().join(',')}, ${entries.length}명)`, 'admin', 'admin', parseInt(competition_id));
            res.json({ success: true, count: entries.length, days: [...daysSeen].sort(), message: `Excel 명단 ${entries.length}명 등록됨` });
        } catch(e) {
            console.error('Roster Excel upload error:', e);
            try { if (req.file) fs.unlinkSync(req.file.path); } catch(ex) {}
            res.status(500).json({ error: 'Excel 명단 업로드 실패: ' + e.message });
        }
    });

    // ============================================================
    // 명단 매칭 수동 수정 API
    // ============================================================
    //   ① GET  /api/display/roster/list/:compId          — 명단 행 목록 (필터 가능)
    //   ② GET  /api/display/roster/events/:compId        — 매칭 후보 event 목록
    //   ③ POST /api/display/roster/assign                — 단건 event_id 변경
    //   ④ POST /api/display/roster/assign-bulk           — 다건 동시 변경 (그룹 단위)
    //   ⑤ POST /api/display/roster/clear-event/:rosterId — event_id를 NULL로 (미매칭으로 되돌림)
    app.get('/api/display/roster/list/:compId', async (req, res) => {
        try {
            const compId = parseInt(req.params.compId);
            const { day, only_unmatched, event_id } = req.query;
            let sql = `SELECT r.id, r.day, r.event_name, r.round, r.division, r.gender, r.bib_number,
                              r.athlete_name, r.team, r.heat, r.lane, r.event_id,
                              e.name AS matched_event_name, e.gender AS matched_event_gender,
                              e.division AS matched_event_division, e.round_type AS matched_event_round
                       FROM display_roster r
                       LEFT JOIN event e ON e.id = r.event_id
                       WHERE r.competition_id=?`;
            const args = [compId];
            if (day) { sql += ' AND r.day=?'; args.push(parseInt(day)); }
            if (only_unmatched === '1' || only_unmatched === 'true') sql += ' AND r.event_id IS NULL';
            if (event_id) { sql += ' AND r.event_id=?'; args.push(parseInt(event_id)); }
            sql += ' ORDER BY r.day, r.event_name, r.round, r.heat, r.lane, r.sort_order';
            const rows = await db.all(sql, ...args);
            res.json({ success: true, rows, total: rows.length });
        } catch(e) {
            console.error('roster/list error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    app.get('/api/display/roster/events/:compId', async (req, res) => {
        try {
            const compId = parseInt(req.params.compId);
            const events = await db.all(`SELECT id, name, gender, division, round_type, category
                 FROM event WHERE competition_id=?
                 ORDER BY name, division, gender, round_type`, compId);
            res.json({ success: true, events });
        } catch(e) {
            console.error('roster/events error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/display/roster/assign', async (req, res) => {
        try {
            const { admin_key, roster_id, event_id } = req.body;
            if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
            if (!roster_id) return res.status(400).json({ error: 'roster_id required' });
            const evId = event_id ? parseInt(event_id) : null;
            if (evId) {
                const ev = await db.get('SELECT id FROM event WHERE id=?', evId);
                if (!ev) return res.status(404).json({ error: '해당 종목이 존재하지 않습니다.' });
            }
            await db.run('UPDATE display_roster SET event_id=? WHERE id=?', evId, parseInt(roster_id));
            res.json({ success: true });
        } catch(e) {
            console.error('roster/assign error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/display/roster/assign-bulk', async (req, res) => {
        try {
            const { admin_key, competition_id, filter, event_id } = req.body;
            if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
            if (!competition_id) return res.status(400).json({ error: 'competition_id required' });
            const evId = event_id ? parseInt(event_id) : null;
            if (evId) {
                const ev = await db.get('SELECT id FROM event WHERE id=?', evId);
                if (!ev) return res.status(404).json({ error: '해당 종목이 존재하지 않습니다.' });
            }
            // filter: { event_name, division, gender, round, day }
            const f = filter || {};
            let sql = 'UPDATE display_roster SET event_id=? WHERE competition_id=?';
            const args = [evId, parseInt(competition_id)];
            if (f.event_name) { sql += ' AND event_name=?'; args.push(f.event_name); }
            if (f.division !== undefined) { sql += ' AND division=?'; args.push(f.division || ''); }
            if (f.gender !== undefined) { sql += ' AND gender=?'; args.push(f.gender || ''); }
            if (f.round !== undefined) { sql += ' AND round=?'; args.push(f.round || ''); }
            if (f.day) { sql += ' AND day=?'; args.push(parseInt(f.day)); }
            const info = await db.run(sql, ...args);
            res.json({ success: true, updated: info.changes });
        } catch(e) {
            console.error('roster/assign-bulk error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/display/roster/clear-event/:rosterId', async (req, res) => {
        try {
            const { admin_key } = req.body;
            if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
            await db.run('UPDATE display_roster SET event_id=NULL WHERE id=?', parseInt(req.params.rosterId));
            res.json({ success: true });
        } catch(e) {
            console.error('roster/clear-event error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // Auto-match roster entries to events
    //
    // 매칭 정책 (2026-05 재작성):
    //   ① division/gender/round_type 정규화는 시간표·명단 양쪽이 동일 헬퍼를 사용 → 표기 차이로 인한
    //      어긋남을 사전 차단 (parseDisplayRound + normalizeDivisionLabel)
    //   ② 종합 sub-event(10종/7종)는 부모 이벤트(10종경기/7종경기)에만 연결.
    //      · 부모 매칭 실패 시: division 표기 fallback만 시도, 절대 일반 종목으로 흘러가지 않음.
    //      · 후보 부모 이름: "10종경기", "10종경기(남)", "남자10종경기", "육상10종경기" 등 다양한 표기 허용.
    //   ③ 일반 종목: name + gender + division + round_type 4개 모두 일치할 때만 strict 매칭.
    //      · Strict 실패 시 fallback은 "division/gender 표기를 normalize한 다음에 비교" 만 허용.
    //        절대로 division 또는 gender 자체를 무시하지 않음 (이전 버그의 직접 원인).
    //      · round_type 표기 차이가 있으면 양쪽 다시 parseDisplayRound로 정규화한 후 비교.
    //   ④ gender가 비어있는 명단(혼성) → ev.gender ∈ {X, ''} 중 하나와 매칭.
    //   ⑤ 매칭이 안 되면 그냥 둠. 잘못된 매칭보다 미매칭이 안전.
    async function autoMatchDisplayRoster(compId) {
        const events = await db.all('SELECT id, name, gender, division, round_type FROM event WHERE competition_id=?', compId);
        const unmatched = await db.all('SELECT id, event_name, round, division, gender FROM display_roster WHERE competition_id=? AND event_id IS NULL', compId);
        const UPD_RM_SQL = 'UPDATE display_roster SET event_id=? WHERE id=?';

        // ── 정규화 헬퍼 ──
        function nameNorm(s) {
            if (!s) return '';
            let n = s.replace(/\s+/g, '');
            // 종합경기 접미사 정규화: "10종경기", "100m(10종)" 등에서 (10종)/(7종) 제거
            n = n.replace(/\((\d+종)\)$/, '');
            // 성별 접미사 제거: "10종경기(남)" / "10종경기 남자" 등의 변형
            n = n.replace(/\((남|여|혼|남자|여자|혼성)\)$/, '');
            n = n.replace(/(남자|여자|혼성)$/, '');
            // 앞 접두어 제거: "남자10종경기", "여자7종경기"
            n = n.replace(/^(남자|여자|혼성)/, '');
            // "육상" prefix 제거
            n = n.replace(/^육상/, '');
            return n.toLowerCase();
        }

        function divNorm(d) { return normalizeDivisionLabel(d || ''); }

        function genderEq(a, b) {
            const A = (a || '').trim();
            const B = (b || '').trim();
            if (A === B) return true;
            // 혼성: '' / 'X' / undefined 모두 동일 취급
            const isWild = (g) => !g || g === 'X' || g === '혼' || g === '혼성';
            if (isWild(A) && isWild(B)) return true;
            return false;
        }

        function roundEq(rosterRoundRaw, eventRoundType) {
            // event.round_type은 시간표 import 시 이미 parseDisplayRound로 만든 값(preliminary/semifinal/final)
            // 명단의 round 원문(rosterRoundRaw)은 매칭 시점에 한 번 더 parseDisplayRound로 정규화
            const r = parseDisplayRound(rosterRoundRaw);
            return r.round_type === (eventRoundType || 'final');
        }

        // 종합경기 부모 이벤트 후보 매칭: ev.name의 nameNorm 결과가 "Nx종경기"와 일치하면 OK
        function isCombinedParent(evName, n) {
            const norm = nameNorm(evName);
            return norm === `${n}종경기`;
        }

        let matched = 0;
        let combinedMatched = 0;
        let strictMatched = 0;
        let fallbackMatched = 0;
        let stillUnmatched = 0;

        for (const re of unmatched) {
            const parsed = parseDisplayRound(re.round || '');
            const isCombined = parsed.is_combined;
            const rosterDiv = divNorm(re.division);
            const rosterEvName = nameNorm(re.event_name);

            let match = null;

            // ── (A) 종합 sub-event: 부모 이벤트 매칭 ──
            if (isCombined && parsed.combined_n) {
                const n = parsed.combined_n;
                // (A-1) strict: 부모 + 동일 division + 동일 gender
                match = events.find(ev =>
                    isCombinedParent(ev.name, n) &&
                    divNorm(ev.division) === rosterDiv &&
                    genderEq(ev.gender, re.gender)
                );
                // (A-2) fallback: division 표기가 살짝 다를 가능성 — gender만으로
                //        단, division 둘 다 비어있지 않은 경우엔 division 일치 강제 (잘못 붙는 것 방지)
                if (!match && !rosterDiv) {
                    match = events.find(ev =>
                        isCombinedParent(ev.name, n) &&
                        genderEq(ev.gender, re.gender)
                    );
                }
                // 종합 sub-event는 일반 종목으로 절대 흘러가지 않음 — 여기서 종료
                if (match) { await db.run(UPD_RM_SQL, match.id, re.id); matched++; combinedMatched++; }
                else stillUnmatched++;
                continue;
            }

            // ── (B) 일반 종목 strict 매칭: name + gender + division + round_type 모두 일치 ──
            match = events.find(ev =>
                nameNorm(ev.name) === rosterEvName &&
                divNorm(ev.division) === rosterDiv &&
                genderEq(ev.gender, re.gender) &&
                roundEq(re.round, ev.round_type)
            );
            if (match) { await db.run(UPD_RM_SQL, match.id, re.id); matched++; strictMatched++; continue; }

            // ── (C) Fallback 1: division 표기 차이 흡수 (양쪽 모두 normalize 후 비교)
            //        ※ rosterDiv가 빈 문자열일 때만 division 비교를 생략. 그렇지 않으면 division mismatch는 절대 매칭 X.
            if (rosterDiv === '') {
                match = events.find(ev =>
                    nameNorm(ev.name) === rosterEvName &&
                    genderEq(ev.gender, re.gender) &&
                    roundEq(re.round, ev.round_type)
                );
                if (match) { await db.run(UPD_RM_SQL, match.id, re.id); matched++; fallbackMatched++; continue; }
            }

            // ── (D) Fallback 2: round_type만 'final' 가정한 매칭 (예선만 있고 결승 event가 없는 케이스 대비)
            //        예: 1500m 결승만 시간표에 있고 명단도 결승 → strict에서 잡혀야 하지만, round_type이
            //            엉뚱하게 들어간 레거시 데이터를 위해 round_type 비교를 한 번 더 느슨하게.
            //        단, 반드시 division + gender는 일치해야 함.
            match = events.find(ev =>
                nameNorm(ev.name) === rosterEvName &&
                divNorm(ev.division) === rosterDiv &&
                genderEq(ev.gender, re.gender)
            );
            if (match) { await db.run(UPD_RM_SQL, match.id, re.id); matched++; fallbackMatched++; continue; }

            stillUnmatched++;
        }

        if (matched > 0 || stillUnmatched > 0) {
            console.log(`[autoMatchDisplayRoster] comp=${compId}: matched=${matched} (strict=${strictMatched}, combined=${combinedMatched}, fallback=${fallbackMatched}), unmatched=${stillUnmatched}`);
        }
        return matched;
    }

    // Get display roster for a competition
    app.get('/api/display/roster/:compId', async (req, res) => {
        const { event_id, day } = req.query;
        let sql = 'SELECT * FROM display_roster WHERE competition_id=?';
        const params = [req.params.compId];
        if (event_id) { sql += ' AND event_id=?'; params.push(event_id); }
        if (day) { sql += ' AND day=?'; params.push(parseInt(day)); }
        sql += ' ORDER BY event_name, sort_order';
        res.json(await db.all(sql, ...params));
    });

    // Get display events for a competition (with roster counts)
    app.get('/api/display/events/:compId', async (req, res) => {
        const events = await db.all(`
            SELECT e.*, 
                (SELECT COUNT(*) FROM display_roster dr WHERE dr.event_id = e.id) as roster_count
            FROM event e 
            WHERE e.competition_id=? AND e.parent_event_id IS NULL
            ORDER BY e.division, e.sort_order, e.name
        `, req.params.compId);
        res.json(events);
    });

    // Update event result_url
    app.put('/api/display/events/:id/result-url', async (req, res) => {
        const { admin_key, result_url } = req.body;
        if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
        await db.run('UPDATE event SET result_url=? WHERE id=?', result_url || '', req.params.id);
        res.json({ success: true });
    });

    // /api/display/events/bulk-result-url removed — was never called from any client.
    // Use single PUT /api/display/events/:id/result-url instead.

    // Get matching status overview
    app.get('/api/display/match-status/:compId', async (req, res) => {
        const events = await db.all(`
            SELECT e.id, e.name, e.gender, e.division, e.round_type, e.result_url,
                (SELECT COUNT(*) FROM display_roster dr WHERE dr.event_id = e.id) as roster_count,
                (SELECT COUNT(*) FROM timetable tt WHERE tt.event_id = e.id AND tt.competition_id = e.competition_id) as timetable_count
            FROM event e
            WHERE e.competition_id=? AND e.parent_event_id IS NULL
            ORDER BY e.division, e.name, e.round_type
        `, req.params.compId);
        res.json(events);
    });

    // Manual match roster to event
    app.post('/api/display/roster/match', async (req, res) => {
        const { admin_key, roster_ids, event_id } = req.body;
        if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
        if (!Array.isArray(roster_ids) || !event_id) return res.status(400).json({ error: 'roster_ids and event_id required' });
        await db.transaction(async () => {
            for (const rid of roster_ids) {
                await db.run('UPDATE display_roster SET event_id=? WHERE id=?', event_id, rid);
            }
        })();
        res.json({ success: true, count: roster_ids.length });
    });

    // Re-run auto-matching for roster
    app.post('/api/display/roster/:compId/rematch', async (req, res) => {
        const { admin_key } = req.body;
        if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
        await db.run('UPDATE display_roster SET event_id=NULL WHERE competition_id=?', req.params.compId);
        const matched = await autoMatchDisplayRoster(parseInt(req.params.compId));
        res.json({ success: true, matched });
    });

    // Delete display roster for a specific day
    app.delete('/api/display/roster/:compId/:day', async (req, res) => {
        const { admin_key } = req.body;
        if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
        await db.run('DELETE FROM display_roster WHERE competition_id=? AND day=?', req.params.compId, parseInt(req.params.day));
        res.json({ success: true });
    });

    // ─── 미지정(division 빈 값) 종목 일괄 정리 API ───
    // GET  /api/display/cleanup-undefined/:compId  — 미리보기 (dry-run)
    // POST /api/display/cleanup-undefined/:compId  — 실제 정리 실행
    //
    // 동작:
    //   1) division이 비어있고 gender='X'가 아닌 종목들을 찾는다 (= "미지정" 종목)
    //   2) 각각에 대해 같은 (name, gender, round_type)을 가지면서 division이 채워진 동일 종목이 있는지 확인
    //   3) 흡수 가능: 미지정 종목에 연결된 timetable.event_id, display_roster.event_id를 흡수 대상에 재연결 후 미지정 종목 삭제
    //   4) 흡수 불가능 (동일 종목 없음): 단순 삭제 (timetable.event_id NULL로 끊고 display_roster도 NULL로 끊음)
    async function _findUndefinedEvents(compId) {
        return await db.all(`
            SELECT id, name, gender, division, round_type, category, sort_order
            FROM event
            WHERE competition_id=?
              AND (division IS NULL OR division='')
              AND gender != 'X'
              AND parent_event_id IS NULL
        `, compId);
    }
    async function _planCleanupUndefined(compId) {
        const undefinedEvents = await _findUndefinedEvents(compId);
        const allEvents = await db.all(`
            SELECT id, name, gender, division, round_type
            FROM event
            WHERE competition_id=? AND parent_event_id IS NULL
        `, compId);
        const plan = [];
        for (const u of undefinedEvents) {
            // 같은 name + gender + round_type, division이 채워진 후보 찾기
            const candidates = allEvents.filter(e =>
                e.id !== u.id &&
                e.name === u.name &&
                e.gender === u.gender &&
                e.round_type === u.round_type &&
                e.division && e.division.trim()
            );
            // 가장 우선순위 높은 후보(초등→중등→고등→U18→U20→대학→일반→선수권→국제 순) 선택
            const order = ['초등부','중등부','고등부','U18','U20','대학부','일반부','선수권','국제'];
            candidates.sort((a, b) => {
                const ai = order.indexOf(a.division);
                const bi = order.indexOf(b.division);
                return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
            });
            const ttRow = await db.get('SELECT COUNT(*) AS c FROM timetable WHERE event_id=?', u.id);
            const rosterRow = await db.get('SELECT COUNT(*) AS c FROM display_roster WHERE event_id=?', u.id);
            const ttCnt = ttRow ? ttRow.c : 0;
            const rosterCnt = rosterRow ? rosterRow.c : 0;
            if (candidates.length === 1) {
                // 후보가 1개뿐이면 자동 흡수
                plan.push({
                    action: 'merge',
                    undefined_event: u,
                    target_event: candidates[0],
                    timetable_count: ttCnt,
                    roster_count: rosterCnt,
                    note: `1개 후보 → 자동 흡수`
                });
            } else if (candidates.length > 1) {
                // 후보가 여러 개면 사용자 결정 필요 → 일단 삭제 후보로 보고 (timetable/roster 끊기)
                plan.push({
                    action: 'orphan',
                    undefined_event: u,
                    candidates,
                    timetable_count: ttCnt,
                    roster_count: rosterCnt,
                    note: `${candidates.length}개 후보 존재 → 수동 선택 필요`
                });
            } else {
                // 후보가 없으면 단순 삭제
                plan.push({
                    action: 'delete',
                    undefined_event: u,
                    timetable_count: ttCnt,
                    roster_count: rosterCnt,
                    note: `흡수 대상 없음 → 단순 삭제`
                });
            }
        }
        return plan;
    }
    app.get('/api/display/cleanup-undefined/:compId', async (req, res) => {
        const { admin_key } = req.query;
        if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
        const plan = await _planCleanupUndefined(parseInt(req.params.compId));
        res.json({
            success: true,
            total: plan.length,
            merge_count: plan.filter(p => p.action === 'merge').length,
            delete_count: plan.filter(p => p.action === 'delete').length,
            orphan_count: plan.filter(p => p.action === 'orphan').length,
            plan
        });
    });
    app.post('/api/display/cleanup-undefined/:compId', async (req, res) => {
        const { admin_key, mode } = req.body;
        // mode: 'auto' (merge+delete만 자동 처리, orphan 제외) | 'force_delete' (orphan도 삭제)
        if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
        const compId = parseInt(req.params.compId);
        const plan = await _planCleanupUndefined(compId);
        let merged = 0, deleted = 0, skipped = 0;
        await db.transaction(async () => {
            for (const p of plan) {
                if (p.action === 'merge') {
                    // timetable / display_roster 의 event_id 재연결
                    await db.run('UPDATE timetable SET event_id=? WHERE event_id=?', p.target_event.id, p.undefined_event.id);
                    await db.run('UPDATE display_roster SET event_id=? WHERE event_id=?', p.target_event.id, p.undefined_event.id);
                    await db.run('DELETE FROM event WHERE id=?', p.undefined_event.id);
                    merged++;
                } else if (p.action === 'delete') {
                    await db.run('UPDATE timetable SET event_id=NULL WHERE event_id=?', p.undefined_event.id);
                    await db.run('UPDATE display_roster SET event_id=NULL WHERE event_id=?', p.undefined_event.id);
                    await db.run('DELETE FROM event WHERE id=?', p.undefined_event.id);
                    deleted++;
                } else if (p.action === 'orphan') {
                    if (mode === 'force_delete') {
                        await db.run('UPDATE timetable SET event_id=NULL WHERE event_id=?', p.undefined_event.id);
                        await db.run('UPDATE display_roster SET event_id=NULL WHERE event_id=?', p.undefined_event.id);
                        await db.run('DELETE FROM event WHERE id=?', p.undefined_event.id);
                        deleted++;
                    } else {
                        skipped++;
                    }
                }
            }
        })();
        opLog(`미지정 종목 정리 (병합 ${merged}, 삭제 ${deleted}, 스킵 ${skipped})`, 'admin', 'admin', compId);
        res.json({ success: true, merged, deleted, skipped, total: plan.length });
    });

    // ─── Display roster: 단일 행 CRUD (인라인 편집 / 릴레이 팀 편집) ───
    // PUT  /api/display/roster/entry/:id  — 개별 행 수정
    app.put('/api/display/roster/entry/:id', async (req, res) => {
        try {
            const { admin_key, day, event_name, round, division, gender, bib_number, athlete_name, team, heat, lane, sort_order, event_id } = req.body;
            if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
            const old = await db.get('SELECT * FROM display_roster WHERE id=?', req.params.id);
            if (!old) return res.status(404).json({ error: '명단 행을 찾을 수 없습니다.' });
            await db.run(`UPDATE display_roster SET
                day=?, event_name=?, round=?, division=?, gender=?,
                bib_number=?, athlete_name=?, team=?,
                heat=?, lane=?, sort_order=?, event_id=?
                WHERE id=?`, day != null ? parseInt(day) : old.day, event_name != null ? event_name : old.event_name, round != null ? round : old.round, division != null ? division : old.division, gender != null ? gender : old.gender, bib_number != null ? String(bib_number) : old.bib_number, athlete_name != null ? athlete_name : old.athlete_name, team != null ? team : old.team, heat != null && heat !== '' ? parseInt(heat) : null, lane != null && lane !== '' ? parseInt(lane) : null, sort_order != null ? parseInt(sort_order) : old.sort_order, event_id != null ? (event_id || null) : old.event_id, old.id);
            res.json({ success: true, id: old.id });
        } catch (e) {
            res.status(500).json({ error: '수정 실패: ' + e.message });
        }
    });

    // POST /api/display/roster/entry — 새 행 추가
    app.post('/api/display/roster/entry', async (req, res) => {
        try {
            const { admin_key, competition_id, day, event_name, round, division, gender, bib_number, athlete_name, team, heat, lane, sort_order, event_id } = req.body;
            if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
            if (!competition_id || !athlete_name) return res.status(400).json({ error: 'competition_id, athlete_name 필수' });
            const info = await db.run(`INSERT INTO display_roster
                (competition_id, day, event_name, round, division, gender, bib_number, athlete_name, team, sort_order, event_id, heat, lane)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, parseInt(competition_id), parseInt(day) || 1, event_name || '', round || '', division || '', gender || '', bib_number != null ? String(bib_number) : '', athlete_name, team || '', sort_order != null ? parseInt(sort_order) : 0, event_id || null, heat != null && heat !== '' ? parseInt(heat) : null, lane != null && lane !== '' ? parseInt(lane) : null);
            // 자동 매칭 시도
            try { await autoMatchDisplayRoster(parseInt(competition_id)); } catch(e) {}
            res.json({ success: true, id: info.lastInsertRowid });
        } catch (e) {
            res.status(500).json({ error: '추가 실패: ' + e.message });
        }
    });

    // DELETE /api/display/roster/entry/:id — 개별 행 삭제
    app.delete('/api/display/roster/entry/:id', async (req, res) => {
        try {
            const { admin_key } = req.body;
            if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
            const info = await db.run('DELETE FROM display_roster WHERE id=?', req.params.id);
            res.json({ success: true, deleted: info.changes });
        } catch (e) {
            res.status(500).json({ error: '삭제 실패: ' + e.message });
        }
    });

    return { autoLinkDisplayTimetable, autoMatchDisplayRoster };
};
