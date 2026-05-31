/**
 * Timetable (대회 일정/타임테이블) routes
 *
 * server.js 에서 추출됨 (2단계 모듈 분리 — 9차).
 * 외부 의존성: db, isAdminKey, isOperationKey, opLog, upload, XLSX
 *
 * 라우트 (12개):
 *   GET    /api/timetable/:compId                       대회 일정 조회 (정렬: time, sort_order)
 *   POST   /api/timetable/upload                        Excel 파일 업로드 → 일괄 등록
 *   DELETE /api/timetable/:compId                       대회 전체 일정 삭제
 *   DELETE /api/timetable/:compId/:day                  특정 일자 일정 삭제
 *   PUT    /api/timetable/:id/link                      timetable ↔ event 연결
 *   PUT    /api/timetable/:id/unlink                    연결 해제
 *   PUT    /api/timetable/entry/:id                     일정 항목 수정
 *   POST   /api/timetable/entry                         일정 항목 추가
 *   DELETE /api/timetable/entry/:id                     일정 항목 삭제
 *   POST   /api/timetable/:compId/rematch               자동 매칭 재실행
 *   GET    /api/timetable/:compId/today                 오늘자 일정 (KST)
 *   GET    /api/timetable/:compId/event-schedule        종목별 스케줄
 */
module.exports = function mountTimetableRoutes(app, deps) {
    const { db, isAdminKey, isOperationKey, opLog, upload, XLSX } = deps;
    if (!app || !db || !isAdminKey || !isOperationKey || !opLog || !upload || !XLSX) {
        throw new Error('[timetable.js] mount requires { db, isAdminKey, isOperationKey, opLog, upload, XLSX }');
    }

app.get('/api/timetable/:compId', async (req, res) => {
    // FIX: time 우선 정렬 (HH:MM 문자열 정렬은 24시간 형식에서 안전), 같은 시간이면 sort_order
    const rows = await db.all('SELECT * FROM timetable WHERE competition_id=? ORDER BY day, time, section, sort_order', req.params.compId);
    // Include competition start_date for auto-day detection
    const comp = await db.get('SELECT start_date FROM competition WHERE id=?', req.params.compId);
    // Group by day
    const days = {};
    for (const r of rows) {
        if (!days[r.day]) days[r.day] = { track: [], field: [] };
        const s = r.section === 'field' ? 'field' : 'track';
        // Include result_url + round_status from linked event (if any)
        let result_url = null;
        let round_status = null;
        if (r.event_id) {
            const evt = await db.get('SELECT result_url, round_status FROM event WHERE id=?', r.event_id);
            if (evt) {
                result_url = evt.result_url || null;
                round_status = evt.round_status || null;
            }
        }
        days[r.day][s].push({ id: r.id, time: r.time, event_name: r.event_name, category: r.category, round: r.round, note: r.note, event_id: r.event_id, callroom_time: r.callroom_time, scheduled_date: r.scheduled_date, result_url, round_status });
    }
    res.json({ competition_id: parseInt(req.params.compId), days, start_date: comp ? comp.start_date : null });
});

// Upload timetable Excel
app.post('/api/timetable/upload', upload.single('file'), async (req, res) => {
    try {
        const { competition_id, admin_key } = req.body;
        if (!competition_id) return res.status(400).json({ error: 'competition_id required' });
        if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
        if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });

        const wb = XLSX.readFile(req.file.path);
        const allEntries = [];

        // 대회 시작일을 미리 조회 (날짜 컬럼이 있을 때 day 계산용)
        const _compStartRow = await db.get('SELECT start_date FROM competition WHERE id=?', parseInt(competition_id));
        const _startDateMs = (_compStartRow && _compStartRow.start_date)
            ? new Date(_compStartRow.start_date + 'T00:00:00').getTime() : null;

        // 한국어 날짜 문자열 → YYYY-MM-DD 파싱 (예: "2026. 4. 30(목)" → "2026-04-30")
        function parseKoreanDate(s) {
            if (!s) return null;
            if (s instanceof Date) {
                const y = s.getFullYear(), mo = s.getMonth()+1, dd = s.getDate();
                return `${y}-${String(mo).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;
            }
            const str = s.toString().trim();
            // 숫자(엑셀 시리얼) 처리
            if (/^\d+(\.\d+)?$/.test(str)) {
                const n = parseFloat(str);
                if (n > 25000 && n < 80000) {
                    const d = new Date(Date.UTC(1899, 11, 30) + n * 86400000);
                    const y = d.getUTCFullYear(), mo = d.getUTCMonth()+1, dd = d.getUTCDate();
                    return `${y}-${String(mo).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;
                }
            }
            // "2026. 4. 30(목)" / "2026-04-30" / "2026/4/30" 모두 매칭
            const m = str.match(/(\d{4})[.\-\/]\s*(\d{1,2})[.\-\/]\s*(\d{1,2})/);
            if (m) return `${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`;
            return null;
        }

        // Process each sheet as a day
        wb.SheetNames.forEach((sheetName, idx) => {
            const ws = wb.Sheets[sheetName];
            const data = XLSX.utils.sheet_to_json(ws, { defval: '' });
            // Determine day number from sheet name or index (fallback)
            let sheetDayNum = idx + 1;
            const dayMatch = sheetName.match(/(\d+)/);
            if (dayMatch) sheetDayNum = parseInt(dayMatch[1]);

            data.forEach((row, rowIdx) => {
                // Expected columns: 날짜(date), 구분(section), 시간(time), 종목(event), 부별/종별(category), 라운드(round), 비고(note)
                const section = (row['구분'] || row['section'] || row['Section'] || '').toString().trim().toLowerCase();
                const rawTime = row['시간'] !== undefined ? row['시간'] : (row['time'] !== undefined ? row['time'] : row['Time']);
                // FIX: Excel 시간 셀이 분수(0.4166…)로 들어오는 경우 HH:MM 으로 변환
                const time = excelTimeToHHMM(rawTime);
                const eventName = cleanTimetableEventName(row['종목'] || row['event'] || row['Event'] || row['event_name'] || '');
                const category = (row['부별'] || row['종별'] || row['category'] || row['Category'] || '').toString().replace(/[\u00A0\s]+/g, ' ').trim();
                const round = (row['라운드'] || row['round'] || row['Round'] || '').toString().replace(/[\u00A0\s]+/g, ' ').trim();
                const note = (row['비고'] || row['note'] || row['Note'] || '').toString().replace(/[\u00A0\s]+/g, ' ').trim();

                if (!time || !eventName) return; // skip empty rows

                // FIX: 날짜 컬럼이 있으면 day 번호를 행별로 산출 (한 시트에 여러 날짜가 섞인 케이스 지원)
                let dayNum = sheetDayNum;
                let scheduledDate = null;
                const rawDate = row['날짜'] || row['date'] || row['Date'] || row['일자'];
                if (rawDate !== undefined && rawDate !== '') {
                    const ymd = parseKoreanDate(rawDate);
                    if (ymd) {
                        scheduledDate = ymd;
                        if (_startDateMs !== null) {
                            const rowMs = new Date(ymd + 'T00:00:00').getTime();
                            const diff = Math.round((rowMs - _startDateMs) / 86400000) + 1;
                            if (diff >= 1 && diff <= 30) dayNum = diff;
                        }
                    }
                }

                const sec = (section.includes('필드') || section.includes('field')) ? 'field' : 'track';
                allEntries.push({
                    competition_id: parseInt(competition_id),
                    day: dayNum,
                    section: sec,
                    time: time,
                    event_name: eventName,
                    category: category,
                    round: round,
                    note: note,
                    sort_order: rowIdx,
                    scheduled_date: scheduledDate || undefined
                });
            });
        });

        if (allEntries.length === 0) {
            // Clean up temp file
            try { fs.unlinkSync(req.file.path); } catch(e) {}
            return res.status(400).json({ error: '시간표 데이터가 없습니다. 엑셀 형식을 확인하세요.' });
        }

        // Determine which days are in the uploaded file
        const uploadedDays = [...new Set(allEntries.map(e => e.day))].sort((a, b) => a - b);

        // ─── OPTION C: PRESERVE PAST + DIFF MERGE FOR FUTURE/TODAY ───
        const todayStr = new Date().toISOString().split('T')[0];
        const overwriteMode = req.body.overwrite_mode || 'smart'; // 'smart' (default) | 'force'

        // Compute scheduled_date for each entry (based on competition start_date)
        const compRow = await db.get('SELECT start_date FROM competition WHERE id=?', parseInt(competition_id));
        if (compRow && compRow.start_date) {
            const startDate = new Date(compRow.start_date + 'T00:00:00');
            allEntries.forEach(e => {
                const dd = new Date(startDate);
                dd.setDate(dd.getDate() + e.day - 1);
                e.scheduled_date = dd.toISOString().split('T')[0];
            });
        }

        // Filter out past-day entries unless force mode
        let filteredEntries = allEntries;
        let skippedPastDays = [];
        if (overwriteMode !== 'force') {
            const pastDaysSet = new Set();
            filteredEntries = allEntries.filter(e => {
                if (e.scheduled_date && e.scheduled_date < todayStr) {
                    pastDaysSet.add(e.day);
                    return false;
                }
                return true;
            });
            skippedPastDays = [...pastDaysSet].sort((a, b) => a - b);
        }
        const effectiveDays = [...new Set(filteredEntries.map(e => e.day))].sort((a, b) => a - b);

        let mergeStats = { addedCount: 0, updatedCount: 0, deletedCount: 0, preservedCount: 0 };

        if (overwriteMode === 'force') {
            // LEGACY: full delete for uploaded days
            await db.transaction(async () => {
                for (const d of uploadedDays) {
                    await db.run('DELETE FROM timetable WHERE competition_id=? AND day=?', parseInt(competition_id), d);
                }
                for (const e of allEntries) {
                    await db.run('INSERT INTO timetable (competition_id, day, section, time, event_name, category, round, note, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                        e.competition_id, e.day, e.section, e.time, e.event_name, e.category, e.round, e.note, e.sort_order);
                }
            })();
            mergeStats.addedCount = allEntries.length;
        } else {
            // SMART MERGE: 행 단위 diff (과거 일차 보존)
            const INSERT_SQL = 'INSERT INTO timetable (competition_id, day, section, time, event_name, category, round, note, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)';
            const UPDATE_SQL = 'UPDATE timetable SET section=?, note=?, sort_order=? WHERE id=?';
            const DELETE_ONE_SQL = 'DELETE FROM timetable WHERE id=?';

            // 수동 매칭 보호: event_name+round+category 가 같으면 (time/sort 만 바뀐 경우)
            //                event_id 를 새 행에 이전시킴. 새로 INSERT 된 행도 LAST_INSERT_ROWID 로 회수.
            const _ttNorm = s => (s || '').replace(/[,\s]+/g, '').toLowerCase().replace(/×/g, 'x').replace(/X/g, 'x');
            const buildSoftKey = (r) => `${_ttNorm(r.event_name)}|${_ttNorm(r.category)}|${_ttNorm(r.round)}`;

            const INSERT_RETURN_SQL = INSERT_SQL;  // last insert rowid 회수용 alias

            const tx = db.transaction(async () => {
                for (const day of effectiveDays) {
                    const existingRows = await db.all('SELECT * FROM timetable WHERE competition_id=? AND day=?', parseInt(competition_id), day);

                    // Safety: skip if past day
                    const sampleRow = existingRows[0];
                    if (sampleRow && sampleRow.scheduled_date && sampleRow.scheduled_date < todayStr) {
                        mergeStats.preservedCount += existingRows.length;
                        continue;
                    }

                    const buildKey = (r) => `${r.time||''}|${(r.event_name||'').trim()}|${(r.category||'').trim()}|${(r.round||'').trim()}`;
                    const existingByKey = new Map();
                    const existingBySoftKey = new Map();  // 약한 매칭: event_name+round+category 동일 → event_id 이전 후보
                    existingRows.forEach(r => {
                        const k = buildKey(r);
                        if (!existingByKey.has(k)) existingByKey.set(k, []);
                        existingByKey.get(k).push(r);
                        const sk = buildSoftKey(r);
                        if (!existingBySoftKey.has(sk)) existingBySoftKey.set(sk, []);
                        existingBySoftKey.get(sk).push(r);
                    });

                    const newEntries = filteredEntries.filter(e => e.day === day);
                    const matchedIds = new Set();
                    // event_id 가 이미 회수된 기존 행은 두 번 이전되지 않도록 추적
                    const consumedEventIds = new Set();
                    // 새로 INSERT 된 행에 event_id 를 옮겨붙이기 위해 등록
                    const pendingEventIdInherit = [];  // { newRowId, eventId, eventIdsJson }

                    for (const e of newEntries) {
                        const k = buildKey(e);
                        const candidates = existingByKey.get(k);
                        if (candidates && candidates.length > 0) {
                            const target = candidates.shift();
                            matchedIds.add(target.id);
                            // 강한 매칭 → 단순 UPDATE (event_id 그대로 유지됨)
                            await db.run(UPDATE_SQL, e.section, e.note || target.note, e.sort_order, target.id);
                            mergeStats.updatedCount++;
                            if (target.event_id) consumedEventIds.add(target.event_id);
                        } else {
                            // 강한 매칭 실패 — INSERT 하지만, 약한 매칭으로 event_id 회수 시도
                            const ins = await db.run(INSERT_RETURN_SQL, e.competition_id, e.day, e.section, e.time, e.event_name, e.category, e.round, e.note, e.sort_order);
                            mergeStats.addedCount++;
                            const sk = buildSoftKey(e);
                            const softCands = existingBySoftKey.get(sk);
                            if (softCands && softCands.length > 0) {
                                // 가장 가까운 기존 행 (event_id 가 있고 아직 회수 안 된 것) 선택
                                const inheritFrom = softCands.find(r => r.event_id && !consumedEventIds.has(r.event_id));
                                if (inheritFrom) {
                                    pendingEventIdInherit.push({
                                        newRowId: ins.lastInsertRowid,
                                        eventId: inheritFrom.event_id,
                                        eventIdsJson: inheritFrom.event_ids || null,
                                    });
                                    consumedEventIds.add(inheritFrom.event_id);
                                }
                            }
                        }
                    }

                    // 새 행에 event_id 이전 적용 (수동 매칭 보호)
                    for (const inh of pendingEventIdInherit) {
                        await db.run('UPDATE timetable SET event_id=?, event_ids=? WHERE id=?', inh.eventId, inh.eventIdsJson, inh.newRowId);
                        mergeStats.preservedLinks = (mergeStats.preservedLinks || 0) + 1;
                    }

                    for (const r of existingRows) {
                        if (!matchedIds.has(r.id)) {
                            await db.run(DELETE_ONE_SQL, r.id);
                            mergeStats.deletedCount++;
                        }
                    }
                }

                if (skippedPastDays.length > 0) {
                    const cnt = await db.get(`SELECT COUNT(*) AS c FROM timetable WHERE competition_id=? AND day IN (${skippedPastDays.map(()=>'?').join(',')})`, parseInt(competition_id), ...skippedPastDays);
                    mergeStats.preservedCount += (cnt && cnt.c) || 0;
                }
            });
            await tx();
        }

        // Auto-link timetable entries to events
        try {
            await autoLinkTimetable(parseInt(competition_id));
        } catch(linkErr) {
            console.warn('Timetable auto-link warning:', linkErr.message);
        }

        // Auto-compute callroom_time (WA standard: 30 min before event time for track, 45 min for field)
        try {
            const needCR = await db.all('SELECT id, time, section FROM timetable WHERE competition_id=? AND callroom_time IS NULL', parseInt(competition_id));
            for (const tt of needCR) {
                const m = (tt.time || '').match(/^(\d{1,2}):(\d{2})/);
                if (!m) continue;
                let h = parseInt(m[1]), min = parseInt(m[2]);
                const offset = (tt.section === 'field') ? 45 : 30; // WA standard offsets
                min -= offset;
                while (min < 0) { min += 60; h -= 1; }
                if (h < 0) continue; // invalid
                const crTime = String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
                await db.run('UPDATE timetable SET callroom_time=? WHERE id=? AND callroom_time IS NULL', crTime, tt.id);
            }
        } catch(crErr) {
            console.warn('Callroom time auto-compute warning:', crErr.message);
        }

        // Compute scheduled_date for any rows still missing it
        try {
            const comp = await db.get('SELECT start_date FROM competition WHERE id=?', parseInt(competition_id));
            if (comp && comp.start_date) {
                const startDate = new Date(comp.start_date + 'T00:00:00');
                for (const d of effectiveDays) {
                    const dayDate = new Date(startDate);
                    dayDate.setDate(dayDate.getDate() + d - 1);
                    const dateStr = dayDate.toISOString().split('T')[0];
                    await db.run('UPDATE timetable SET scheduled_date=? WHERE competition_id=? AND day=? AND scheduled_date IS NULL', dateStr, parseInt(competition_id), d);
                }
            }
        } catch(dateErr) {
            console.warn('Timetable date computation warning:', dateErr.message);
        }

        // Clean up temp file
        try { fs.unlinkSync(req.file.path); } catch(e) {}

        // Build human-readable message
        let msg;
        if (overwriteMode === 'force') {
            msg = `[강제덮어쓰기] ${effectiveDays.map(d=>d+'일차').join(', ')} 시간표 ${allEntries.length}건 등록됨`;
        } else {
            const parts = [];
            if (mergeStats.addedCount) parts.push(`추가 ${mergeStats.addedCount}`);
            if (mergeStats.updatedCount) parts.push(`수정 ${mergeStats.updatedCount}`);
            if (mergeStats.deletedCount) parts.push(`삭제 ${mergeStats.deletedCount}`);
            if (skippedPastDays.length > 0) parts.push(`과거 ${skippedPastDays.map(d=>d+'일차').join('·')} 보존`);
            msg = `[스마트머지] ${parts.join(' · ') || '변경 없음'}`;
        }

        opLog(`시간표 업로드 (대회ID=${competition_id}, ${msg})`, 'admin', 'admin');
        res.json({
            success: true,
            count: filteredEntries.length,
            days: effectiveDays,
            skippedPastDays,
            mode: overwriteMode,
            ...mergeStats,
            message: msg
        });
    } catch(e) {
        console.error('Timetable upload error:', e);
        try { if (req.file) fs.unlinkSync(req.file.path); } catch(ex) {}
        res.status(500).json({ error: '시간표 업로드 실패: ' + e.message });
    }
});

// Delete timetable for a competition (all days)
app.delete('/api/timetable/:compId', async (req, res) => {
    const { admin_key } = req.body || {};
    if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
    await db.run('DELETE FROM timetable WHERE competition_id=?', req.params.compId);
    opLog(`시간표 전체 삭제 (대회ID=${req.params.compId})`, 'admin', 'admin');
    res.json({ success: true });
});

// Delete timetable for a specific day
app.delete('/api/timetable/:compId/:day', async (req, res) => {
    const { admin_key } = req.body || {};
    if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
    const { compId, day } = req.params;
    await db.run('DELETE FROM timetable WHERE competition_id=? AND day=?', compId, parseInt(day));
    opLog(`시간표 ${day}일차 삭제 (대회ID=${compId})`, 'admin', 'admin');
    res.json({ success: true });
});

// Manual link: connect timetable entry to event
app.put('/api/timetable/:id/link', async (req, res) => {
    const { admin_key, event_id } = req.body || {};
    if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
    if (!event_id) return res.status(400).json({ error: 'event_id required' });
    const tt = await db.get('SELECT * FROM timetable WHERE id=?', req.params.id);
    if (!tt) return res.status(404).json({ error: '시간표 항목 없음' });
    // Prevent duplicate: check if this event_id is already linked to another timetable entry in the same competition
    const existing = await db.get('SELECT id FROM timetable WHERE competition_id=? AND event_id=? AND id!=?', tt.competition_id, event_id, req.params.id);
    if (existing) return res.status(400).json({ error: '이 종목은 이미 다른 시간표 항목에 연결되어 있습니다.' });
    await db.run('UPDATE timetable SET event_id=? WHERE id=?', event_id, req.params.id);
    // Auto-compute callroom_time if not set
    if (!tt.callroom_time && tt.time) {
        const m = tt.time.match(/^(\d{1,2}):(\d{2})/);
        if (m) {
            let h = parseInt(m[1]), min = parseInt(m[2]);
            const offset = (tt.section === 'field') ? 45 : 30;
            min -= offset;
            while (min < 0) { min += 60; h -= 1; }
            if (h >= 0) {
                const crTime = String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
                await db.run('UPDATE timetable SET callroom_time=? WHERE id=?', crTime, req.params.id);
            }
        }
    }
    res.json({ success: true });
});

// Manual unlink: disconnect timetable entry from event
app.put('/api/timetable/:id/unlink', async (req, res) => {
    const { admin_key } = req.body || {};
    if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
    await db.run('UPDATE timetable SET event_id=NULL WHERE id=?', req.params.id);
    res.json({ success: true });
});

// Edit single timetable entry (inline edit from display-manage)
// Allows editing: time, event_name, category(jongbyul), round, note, callroom_time, section, day, scheduled_date
app.put('/api/timetable/entry/:id', async (req, res) => {
    try {
        const { admin_key, time, event_name, category, round, note, callroom_time, section, day, scheduled_date, event_id } = req.body || {};
        if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
        const tt = await db.get('SELECT * FROM timetable WHERE id=?', req.params.id);
        if (!tt) return res.status(404).json({ error: '시간표 항목 없음' });

        const fields = [];
        const values = [];
        const setIf = (col, val) => { if (val !== undefined) { fields.push(`${col}=?`); values.push(val); } };
        setIf('time', time);
        setIf('event_name', event_name);
        setIf('category', category);
        setIf('round', round);
        setIf('note', note);
        setIf('callroom_time', callroom_time);
        setIf('section', section);
        setIf('day', day !== undefined ? parseInt(day) : undefined);
        setIf('scheduled_date', scheduled_date);
        if (event_id !== undefined) {
            // event_id can be null to unlink
            fields.push('event_id=?');
            values.push(event_id || null);
        }
        if (fields.length === 0) return res.status(400).json({ error: '수정할 필드가 없습니다.' });

        values.push(req.params.id);
        await db.run(`UPDATE timetable SET ${fields.join(', ')} WHERE id=?`, ...values);

        // If time changed and callroom_time wasn't explicitly provided, recompute it
        if (time !== undefined && callroom_time === undefined) {
            const updated = await db.get('SELECT * FROM timetable WHERE id=?', req.params.id);
            const m = (updated.time || '').match(/^(\d{1,2}):(\d{2})/);
            if (m) {
                let h = parseInt(m[1]), min = parseInt(m[2]);
                const offset = (updated.section === 'field') ? 45 : 30;
                min -= offset;
                while (min < 0) { min += 60; h -= 1; }
                if (h >= 0) {
                    const crTime = String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
                    await db.run('UPDATE timetable SET callroom_time=? WHERE id=?', crTime, req.params.id);
                }
            }
        }

        opLog(`시간표 항목 수정 (ID=${req.params.id}, 대회ID=${tt.competition_id})`, 'admin', 'admin', tt.competition_id);
        res.json({ success: true });
    } catch(e) {
        console.error('Timetable entry edit error:', e);
        res.status(500).json({ error: '수정 실패: ' + e.message });
    }
});

// Add new timetable entry (single row)
app.post('/api/timetable/entry', async (req, res) => {
    try {
        const { admin_key, competition_id, day, section, time, event_name, category, round, note, callroom_time, scheduled_date } = req.body || {};
        if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
        if (!competition_id) return res.status(400).json({ error: 'competition_id required' });
        if (!day || !time || !event_name) return res.status(400).json({ error: 'day, time, event_name 필수' });

        // Compute scheduled_date if not provided
        let schedDate = scheduled_date || null;
        if (!schedDate) {
            const comp = await db.get('SELECT start_date FROM competition WHERE id=?', parseInt(competition_id));
            if (comp && comp.start_date) {
                const d = new Date(comp.start_date + 'T00:00:00');
                d.setDate(d.getDate() + parseInt(day) - 1);
                schedDate = d.toISOString().split('T')[0];
            }
        }

        // Compute callroom_time if not provided
        let cr = callroom_time || null;
        if (!cr && time) {
            const m = time.match(/^(\d{1,2}):(\d{2})/);
            if (m) {
                let h = parseInt(m[1]), min = parseInt(m[2]);
                const offset = (section === 'field') ? 45 : 30;
                min -= offset;
                while (min < 0) { min += 60; h -= 1; }
                if (h >= 0) cr = String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
            }
        }

        // Get next sort_order for the day
        const maxSort = await db.get('SELECT MAX(sort_order) AS m FROM timetable WHERE competition_id=? AND day=?', parseInt(competition_id), parseInt(day));
        const sortOrder = (maxSort && maxSort.m !== null ? maxSort.m : -1) + 1;

        const result = await db.run(`INSERT INTO timetable
            (competition_id, day, section, time, event_name, category, round, note, sort_order, callroom_time, scheduled_date)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, parseInt(competition_id), parseInt(day), section || 'track', time, event_name, category || '', round || '', note || '', sortOrder, cr, schedDate);
        opLog(`시간표 항목 추가 (대회ID=${competition_id}, ${day}일차, ${event_name})`, 'admin', 'admin', parseInt(competition_id));
        res.json({ success: true, id: result.lastInsertRowid });
    } catch(e) {
        console.error('Timetable entry add error:', e);
        res.status(500).json({ error: '추가 실패: ' + e.message });
    }
});

// Delete single timetable entry
app.delete('/api/timetable/entry/:id', async (req, res) => {
    try {
        const adminKey = req.body?.admin_key || req.query?.admin_key || req.headers['x-admin-key'];
        if (!isOperationKey(adminKey) && !isAdminKey(adminKey)) return res.status(403).json({ error: '권한 없음' });
        const tt = await db.get('SELECT * FROM timetable WHERE id=?', req.params.id);
        if (!tt) return res.status(404).json({ error: '시간표 항목 없음' });
        await db.run('DELETE FROM timetable WHERE id=?', req.params.id);
        opLog(`시간표 항목 삭제 (ID=${req.params.id}, 대회ID=${tt.competition_id}, ${tt.event_name})`, 'admin', 'admin', tt.competition_id);
        res.json({ success: true });
    } catch(e) {
        console.error('Timetable entry delete error:', e);
        res.status(500).json({ error: '삭제 실패: ' + e.message });
    }
});

// ---- Shared timetable auto-link function ----
// options.force = true 면 이미 event_id 가 채워진 행도 다시 매칭 시도 (라운드 생성 직후 등)
async function autoLinkTimetable(compId, options = {}) {
    const force = options.force === true;
    const compEvents = await db.all('SELECT id, name, gender, category, round_type FROM event WHERE competition_id=? AND parent_event_id IS NULL', compId);
    // 중복 종목 처리: 같은 (normalized_name, gender, round_type) 그룹에서 데이터 많은 종목을 우선 선택할 수 있도록 enrich
    // (heat/entry/result 수 합산 → 점수)
    const evScoreMap = new Map();
    for (const e of compEvents) {
        const hc = (await db.get('SELECT COUNT(*) AS c FROM heat WHERE event_id=?', e.id))?.c || 0;
        const ec = (await db.get('SELECT COUNT(*) AS c FROM event_entry WHERE event_id=?', e.id))?.c || 0;
        const rc = (await db.get('SELECT COUNT(*) AS c FROM result r JOIN heat h ON h.id=r.heat_id WHERE h.event_id=?', e.id))?.c || 0;
        evScoreMap.set(e.id, hc * 1 + ec * 10 + rc * 100);  // 기록 > 엔트리 > 조 가중치
    }

    // force=true 면 모든 행, 아니면 NULL 행만
    const ttRows = force
        ? await db.all('SELECT id, event_name, category, round, event_id FROM timetable WHERE competition_id=?', compId)
        : await db.all('SELECT id, event_name, category, round, event_id FROM timetable WHERE competition_id=? AND event_id IS NULL', compId);

    // Determine competition federation and division_type (for A6 filtering)
    const comp = await db.get('SELECT federation, division_type FROM competition WHERE id=?', compId);
    const federation = (comp && comp.federation) || '';
    const divisionType = (comp && comp.division_type) || '';

    // Normalize: lowercase, remove all whitespace AND commas, unify × → x, X → x
    // 쉼표 제거가 핵심 — '10,000m' vs '10000m' 매칭을 가능하게 함
    function norm(s) { return (s || '').replace(/[,\s]+/g, '').toLowerCase().replace(/×/g, 'x').replace(/X/g, 'x'); }

    // Extract division info from category. 지원 포맷:
    //   "대학(남)" → { divisions: ['대학'], genders: ['M'] }
    //   "대학/실업(여)" → { divisions: ['대학','실업'], genders: ['F'] }
    //   "대학(남)/실업(남,여)" → { divisions: ['대학','실업'], genders: ['M','F'] }
    //   "남고" / "여대" / "남일" / "여중" → 줄임 표기: 첫글자 성별 + 다음글자 부서
    //   "남자(아시아)" / "여자(아시아)" → 단순 성별
    //   "대학부" / "고등부" / "일반부" / "남자" / "여자" → 부서 또는 성별만
    //   "남" / "여" → 성별만
    function parseCategory(cat) {
        if (!cat) return { divisions: [], genders: [] };
        const genders = new Set();
        const divisions = new Set();

        const DIV_CHAR_MAP = { '초':'초등', '중':'중등', '고':'고등', '대':'대학', '일':'일반', '실':'실업' };

        // Split by "/" to handle "대학(남)/실업(남,여)"
        const parts = cat.split('/');
        for (let part of parts) {
            part = part.trim();

            // 1) 표준 패턴: "대학(남)" / "실업(남,여)" 같은 (성별) 괄호
            const divMatch = part.match(/^(대학|실업|초등|중등|고등|일반)/);
            if (divMatch) divisions.add(divMatch[1]);
            const genderMatch = part.match(/\(([남여혼성,]+)\)/);
            if (genderMatch) {
                const inner = genderMatch[1];
                if (inner.includes('남')) genders.add('M');
                if (inner.includes('여')) genders.add('F');
                if (inner.includes('혼성')) genders.add('X');
            }

            // 2) 줄임 표기 패턴: "남고" / "여대" / "남일(U20포함)" 등
            //    첫글자가 남/여, 둘째 글자가 부서 약자
            const shortMatch = part.match(/^([남여])([초중고대일실])(?:[부]?)/);
            if (shortMatch) {
                genders.add(shortMatch[1] === '남' ? 'M' : 'F');
                if (DIV_CHAR_MAP[shortMatch[2]]) divisions.add(DIV_CHAR_MAP[shortMatch[2]]);
            }

            // 3) 단순 성별: "남자" / "여자" / "남" / "여" (괄호 없는 경우만 처리해서 1) 의 (남) 와 혼동 방지)
            //    하지만 part 가 짧고 부서 정보 없는 경우만
            if (!divMatch && !shortMatch) {
                if (/^남자?(\(|$)/.test(part)) genders.add('M');
                if (/^여자?(\(|$)/.test(part)) genders.add('F');
                if (/혼성|혼합/.test(part)) genders.add('X');
            }

            // 4) "대학부" / "고등부" 같은 부서만 표기
            const divOnlyMatch = part.match(/^(대학|실업|초등|중등|고등|일반)부$/);
            if (divOnlyMatch) divisions.add(divOnlyMatch[1]);
        }
        return { divisions: [...divisions], genders: [...genders] };
    }

    // A6: Check if timetable category is applicable to this competition's federation/division
    // KTFL (실업) or division_type=pro → skip "대학" only items
    // KUAF (대학) or division_type=univ → skip "실업" only items
    function isDivisionMatch(parsedCat) {
        if (parsedCat.divisions.length === 0) return true; // No division specified → always match
        
        // Map federation OR division_type to allowed divisions
        const fedLower = federation.toLowerCase();
        let myDiv = null;
        if (fedLower.includes('ktfl') || fedLower.includes('실업') || divisionType === 'pro') myDiv = '실업';
        else if (fedLower.includes('kuaf') || fedLower.includes('대학') || divisionType === 'univ') myDiv = '대학';
        else if (divisionType === 'high') myDiv = '고등';
        else if (divisionType === 'middle') myDiv = '중등';
        else if (divisionType === 'general') myDiv = '일반';
        
        if (!myDiv) return true; // Unknown federation/division → allow all
        
        // If the timetable row ONLY has the OTHER division, skip it
        // e.g., KTFL competition + "대학(남)" only → skip
        // e.g., KTFL competition + "대학/실업(남)" → allow (includes 실업)
        return parsedCat.divisions.includes(myDiv);
    }

    // Parse round from timetable: handle "결승", "4-1+4", "10종(3)", "결승2조", "결승(A,B)" etc.
    function parseRound(roundStr, eventName) {
        const r = (roundStr || '').trim();
        // Combined event sub-events: "10종(N)", "7종(N)", "5종(N)"
        if (/^(?:10|7|5)종\(\d+\)/.test(r)) {
            const m = r.match(/^(\d+종)/);
            return { round: 'final', isCombinedSub: true, combinedType: m ? m[1] : null };
        }
        // Preliminary patterns: "N-N+N" format
        if (/^\d+-\d+\+\d+$/.test(r)) return { round: 'preliminary' };
        // Final variants: "결승", "결승2조", "결승(A,B)"
        if (r.startsWith('결승') || r === 'final') return { round: 'final' };
        if (r === '예선' || r === 'preliminary') return { round: 'preliminary' };
        if (r === '준결승' || r === '준결' || r === 'semifinal') return { round: 'semifinal' };
        // Default: final
        return { round: 'final' };
    }

    let linked = 0;
    for (const tt of ttRows) {
        const parsed = parseRound(tt.round, tt.event_name);
        const ttRound = parsed.round;
        const catInfo = parseCategory(tt.category);

        // A6: Skip if division doesn't match this competition's federation
        if (!isDivisionMatch(catInfo)) continue;

        // For combined sub-events (10종/7종/5종), match to the combined event
        let targetName = tt.event_name;
        if (parsed.isCombinedSub) {
            if (parsed.combinedType === '10종') targetName = '10종경기';
            else if (parsed.combinedType === '7종') targetName = '7종경기';
            else if (parsed.combinedType === '5종') targetName = '5종경기';
        }

        const ttNorm = norm(targetName);

        // A7: Find ALL matching events (for multi-gender entries like "경보 남녀 동시출발")
        const matches = compEvents.filter(ev => {
            if (ev.round_type !== ttRound) return false;
            // Name match (normalized: spaces+commas removed, ×→x, case insensitive)
            const nameOk = norm(ev.name) === ttNorm;
            if (!nameOk) return false;
            // Gender match
            if (catInfo.genders.length > 0) {
                if (!catInfo.genders.includes(ev.gender)) return false;
            }
            return true;
        });

        if (matches.length > 0) {
            // 중복 종목 robustness: gender 별로 그룹화한 뒤 각 그룹에서 데이터 가장 많은 event 를 대표로 선택.
            // 예) '경보 남녀 동시출발' → M/F 각 1개씩 대표 선택. 같은 gender 안에 중복 종목이 있으면 score 높은 쪽.
            const byGender = new Map();
            for (const m of matches) {
                if (!byGender.has(m.gender)) byGender.set(m.gender, []);
                byGender.get(m.gender).push(m);
            }
            const representatives = [];
            for (const [, list] of byGender) {
                list.sort((a, b) => (evScoreMap.get(b.id) || 0) - (evScoreMap.get(a.id) || 0) || (a.id - b.id));
                representatives.push(list[0]);
            }
            const primaryId = representatives[0].id;
            const allIds = representatives.map(m => m.id);
            const eventIdsJson = allIds.length > 1 ? JSON.stringify(allIds) : null;
            await db.run('UPDATE timetable SET event_id=?, event_ids=? WHERE id=?', primaryId, eventIdsJson, tt.id);
            linked++;
        } else if (force && tt.event_id !== null) {
            // force 모드 + 이번 매칭 실패 → 기존 매칭이 stale 한 게 아닌 한 그대로 둠 (수동 매칭 보호)
            // 단 event_id 가 가리키던 종목이 더 이상 존재하지 않으면 NULL 로 리셋
            const stillExists = compEvents.some(e => e.id === tt.event_id);
            if (!stillExists) {
                await db.run('UPDATE timetable SET event_id=NULL, event_ids=NULL WHERE id=?', tt.id);
            }
        }
    }
    return { linked, total: ttRows.length };
}

// Re-run auto-matching for a competition's timetable
app.post('/api/timetable/:compId/rematch', async (req, res) => {
    const { admin_key } = req.body || {};
    if (!isOperationKey(admin_key) && !isAdminKey(admin_key)) return res.status(403).json({ error: '권한 없음' });
    const compId = parseInt(req.params.compId);
    // Clear existing links first so we can re-match everything
    await db.run('UPDATE timetable SET event_id=NULL WHERE competition_id=?', compId);
    const result = await autoLinkTimetable(compId);
    res.json({ success: true, linked: result.linked, total: result.total });
});

// GET today's scheduled events (for monitor/app notifications)
app.get('/api/timetable/:compId/today', async (req, res) => {
    const compId = req.params.compId;
    const today = new Date().toISOString().split('T')[0];
    
    // Try to find rows by scheduled_date first, then fall back to day-based lookup
    let rows = await db.all('SELECT t.*, e.round_status as event_round_status, e.id as linked_event_id FROM timetable t LEFT JOIN event e ON t.event_id = e.id WHERE t.competition_id=? AND t.scheduled_date=? ORDER BY t.sort_order, t.time', compId, today);
    
    if (rows.length === 0) {
        // Fall back: determine day from competition start_date
        const comp = await db.get('SELECT start_date FROM competition WHERE id=?', compId);
        if (comp && comp.start_date) {
            const start = new Date(comp.start_date + 'T00:00:00');
            const now = new Date(today + 'T00:00:00');
            const dayNum = Math.floor((now - start) / (24 * 60 * 60 * 1000)) + 1;
            if (dayNum > 0) {
                rows = await db.all('SELECT t.*, e.round_status as event_round_status, e.id as linked_event_id FROM timetable t LEFT JOIN event e ON t.event_id = e.id WHERE t.competition_id=? AND t.day=? ORDER BY t.sort_order, t.time', compId, dayNum);
            }
        }
    }
    
    res.json(rows.map(r => ({
        id: r.id,
        time: r.time,
        event_name: r.event_name,
        category: r.category,
        round: r.round,
        section: r.section,
        note: r.note,
        event_id: r.event_id || r.linked_event_id,
        callroom_time: r.callroom_time,
        scheduled_date: r.scheduled_date,
        event_round_status: r.event_round_status
    })));
});

// GET timetable schedule info for events (for matrix dot indicators)
app.get('/api/timetable/:compId/event-schedule', async (req, res) => {
    const compId = req.params.compId;
    const today = new Date().toISOString().split('T')[0];
    const rows = await db.all(`SELECT t.event_id, t.event_ids, t.time, t.callroom_time, t.scheduled_date, t.event_name, t.round, t.day, e.round_status
         FROM timetable t LEFT JOIN event e ON t.event_id = e.id
         WHERE t.competition_id=? AND t.event_id IS NOT NULL
         ORDER BY t.scheduled_date, t.time`, compId);
    // Return a map: event_id -> schedule info
    // A7: Also map additional event_ids from multi-linked rows
    const schedule = {};
    rows.forEach(r => {
        const info = {
            time: r.time,
            callroom_time: r.callroom_time,
            scheduled_date: r.scheduled_date,
            day: r.day,
            is_today: r.scheduled_date === today,
            round_status: r.round_status
        };
        schedule[r.event_id] = info;
        // A7: If event_ids JSON exists, map all additional events to same schedule
        if (r.event_ids) {
            try {
                const ids = JSON.parse(r.event_ids);
                if (Array.isArray(ids)) {
                    ids.forEach(id => { if (!schedule[id]) schedule[id] = info; });
                }
            } catch(e) {}
        }
    });
    res.json(schedule);
});
};
