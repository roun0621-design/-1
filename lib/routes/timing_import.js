'use strict';
/**
 * 계측 결과 가져오기 — server.js 에서 추출 (2026-09 Phase 4)
 *   POST /api/scoreboard/preview · /api/scoreboard/import   전광판 .lif (FinishLynx)
 *   POST /api/records/xlsx-preview · /api/records/xlsx-import   기록 엑셀
 *   POST /api/timing-txt/import                              계측 .txt
 *   시간·상태·라운드·성별 해석은 lib/timingParse.js, 조·선수 매칭은 _recxResolveHeat/_recxMatchGroup (세 경로 공용).
 *   ※ 동작은 인라인 시절과 동일 — 회귀: tests/api/27_lif_structural_match, 41_timing_import_safety, 22_federation_import_scoreboard
 *   반환: { recx } — 필드 기록카드 가져오기(field_card_import)가 같은 정규화 헬퍼를 쓴다
 */
const fs = require('fs');
const XLSX = require('xlsx');
const timingParse = require('../timingParse');

module.exports = function mountTimingImportRoutes(app, deps) {
    const { db, upload, isAdminKey, opLog, broadcastSSE, audit, getResultsRoutes } = deps;
    for (const [k, v] of Object.entries({ db, upload, isAdminKey, opLog, broadcastSSE, audit, getResultsRoutes })) {
        if (!v) throw new Error(`[timing_import] mount requires deps.${k}`);
    }
    // results.js 의 신기록 감지 훅 — 마운트 순서와 무관하게 호출 시점에 읽는다
    const _resultsRoutes = { get runRecordCompareHook() { const r = getResultsRoutes(); return r && r.runRecordCompareHook; } };

    // ============================================================
    // 전광판 (Scoreboard) .lif File Import
    // ============================================================

    /**
     * Parse a .lif file buffer (UTF-16 LE with BOM).
     * Returns { header: { status, competitionNum, eventNum, eventName, scoreboardKey, timestamp }, rows: [...] }
     */
    function parseLifBuffer(buffer) {
        // Decode UTF-16 LE (may have BOM)
        let text;
        if (buffer[0] === 0xFF && buffer[1] === 0xFE) {
            text = buffer.toString('utf16le'); // Node handles BOM
        } else {
            // Try utf16le anyway
            text = buffer.toString('utf16le');
        }
        // Remove BOM if present
        text = text.replace(/^\uFEFF/, '');
    
        const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
        if (lines.length === 0) throw new Error('.lif 파일이 비어 있습니다.');

        // Parse header line
        const hParts = lines[0].split(',');
        const status = (hParts[0] || '').trim();
        const competitionNum = (hParts[1] || '').trim();
        const eventNum = (hParts[2] || '').trim();
        const rawEventName = (hParts[3] || '').trim();
        const timestamp = (hParts[hParts.length - 1] || '').trim();

        // Extract wind speed from header
        // When wind data is present: hParts[4] = wind value (e.g., "-1.8"), hParts[5] contains "m/s"
        // When no wind: hParts[4] is empty or does not pair with "m/s" in hParts[5]
        let wind = null;
        const windCandidate = (hParts[4] || '').trim();
        const windUnit = (hParts[5] || '').trim();
        if (windCandidate && windUnit && /m\/s/i.test(windUnit)) {
            const parsedWind = parseFloat(windCandidate);
            if (!isNaN(parsedWind)) {
                wind = parsedWind;
            }
        }

        // Extract scoreboard_key from event name
        // e.g., "남초부 60m 예선 1조 (2+4)" → scoreboard_key = "남초부 60m 예선 1조"
        // e.g., "여중부 100mH 결승" → scoreboard_key = "여중부 100mH 결승" (keep as-is for finals)
        let scoreboardKey = rawEventName
            .replace(/\s*\([\d\+]+\)\s*$/, '')   // Remove "(2+4)" suffix
            .trim();

        // If no "N조" suffix and it's NOT a final, append "1조" for matching
        // Finals with single heat should NOT have "1조" appended
        if (!/\d+조$/.test(scoreboardKey)) {
            // Check if this looks like a final (contains 결승)
            if (!/결승/.test(scoreboardKey)) {
                scoreboardKey += ' 1조';
            }
        }

        // Parse data rows
        const rows = [];
        for (let i = 1; i < lines.length; i++) {
            const parts = lines[i].split(',');
            const rank = (parts[0] || '').trim();
            const bib = (parts[1] || '').trim();
            const lane = (parts[2] || '').trim();
            // parts[3] is usually empty
            const name = (parts[4] || '').trim();
            const team = (parts[5] || '').trim();
            const rawTime = (parts[6] || '').trim();
            // parts[7] empty
            const timeDiffOrAbs = (parts[8] || '').trim(); // For rank=1 this is absolute time, for others it's diff

            // Determine row type
            if (!rank && !bib && lane) {
                // Empty lane
                rows.push({ type: 'empty', lane: parseInt(lane) });
            } else if (timingParse.parseStatus(rank) || timingParse.parseStatus(rawTime)) {
                // DNS/DNF/DQ — "DQ(TR16.8)" 처럼 사유가 붙어도 상태다 (예전엔 'DQ' 만 인식해 나머지는 빈 기록으로 저장됐다)
                const st = timingParse.parseStatus(rank) || timingParse.parseStatus(rawTime);
                rows.push({ type: st === 'NM' ? 'DNF' : st, bib, lane: parseInt(lane), name, team, note: st !== rank ? String(rank || rawTime) : '' });
            } else if (rank && bib && name) {
                // Valid result row — "3:22.35"(분:초) / "1:02:03.4"(시:분:초) / "10,52" 지원. 못 읽으면 invalid 로 남겨 화면에 알린다
                const time = timingParse.parseTime(rawTime);
                if (time == null) { rows.push({ type: 'invalid', bib, lane: parseInt(lane), name, team, raw: rawTime, reason: `시간을 읽을 수 없음: "${rawTime}"` }); continue; }
                rows.push({
                    type: 'result',
                    rank: parseInt(rank),
                    bib,
                    lane: parseInt(lane),
                    name,
                    team,
                    time,
                });
            }
        }

        return {
            header: {
                status,
                competitionNum,
                eventNum,
                eventName: rawEventName,
                scoreboardKey,
                timestamp,
                wind,
            },
            rows,
        };
    }

    /**
     * .lif 헤더 → 조(heat) 찾기. 반환 { heat, jointHeats, via } / heat=null 이면 미매칭
     *   1) heat.scoreboard_key 정확 일치
     *   2) joint_group.joint_scoreboard_key (합동조)
     *   3) 구조 매칭 — .txt/.xlsx 가져오기와 같은 알고리즘(_recxResolveHeat):
     *      라벨을 성별·부·종목·라운드·조 로 분해해 매칭. "남자 실업부 100 결승" ↔ "남자 일반부 100m 결승" 처럼
     *      부 명칭(실업↔일반)·띄어쓰기·단위(m) 가 달라 문자열 키가 안 맞을 때 잡아준다.
     */
    async function _lifFindHeat(competition_id, header) {
        const SEL = `SELECT h.*, e.name as event_name, e.gender, e.round_type, e.category, e.competition_id as comp_id, e.id as event_id
                     FROM heat h JOIN event e ON e.id = h.event_id`;
        let heat = await db.get(`${SEL} WHERE h.scoreboard_key = ? AND e.competition_id = ?`, header.scoreboardKey, competition_id);
        if (heat) return { heat, jointHeats: [], via: 'key' };
        const jointHeats = [];
        const jg = await db.get('SELECT * FROM joint_group WHERE joint_scoreboard_key = ?', header.scoreboardKey);
        if (jg) {
            const members = await db.all('SELECT event_id FROM joint_group_member WHERE joint_group_id = ?', jg.id);
            for (const m of members) {
                const mh = await db.get(`${SEL} WHERE h.event_id = ? ORDER BY h.heat_number LIMIT 1`, m.event_id);
                if (mh) jointHeats.push(mh);
            }
            heat = jointHeats.find(h => String(h.comp_id) === String(competition_id)) || null;      // 이 대회에 구성원이 없으면 다른 대회 조로 넣지 않는다
            if (heat) return { heat, jointHeats, via: 'joint' };
        }
        // 구조 매칭 (라벨에 "(2+4)" 같은 접미는 이미 제거된 scoreboardKey 사용)
        try {
            const label = _parseEventLabel(header.scoreboardKey || header.eventName);
            const resolved = await _recxResolveHeat(competition_id, label);
            if (resolved && resolved.heat) {
                const sh = await db.get(`${SEL} WHERE h.id = ?`, resolved.heat.id);
                if (sh) return { heat: sh, jointHeats: [], via: 'structural', ambiguous: !!resolved.ambiguous };
            }
        } catch (e) { console.warn('[lif structural match]', e.message); }
        return { heat: null, jointHeats: [], via: null };
    }
    // .lif 배번 매칭 — 앞자리 0 무시 ("007" ↔ "7")
    function _lifBibEq(a, b) { const x = _recxNormBib(a), y = _recxNormBib(b); return !!x && x === y; }

    /**
     * POST /api/scoreboard/preview
     * Upload .lif files and preview parsed data + matching status
     */
    app.post('/api/scoreboard/preview', upload.array('files', 50), async (req, res) => {
        try {
            const { competition_id } = req.body;
            if (!competition_id) return res.status(400).json({ error: 'competition_id 필수' });

            const files = req.files;
            if (!files || files.length === 0) return res.status(400).json({ error: '.lif 파일을 선택해 주세요.' });

            const results = [];
            for (const file of files) {
                try {
                    const buf = fs.readFileSync(file.path);
                    const parsed = parseLifBuffer(buf);

                    // 조 찾기: 키 정확일치 → 합동조 키 → 구조 매칭(.txt/.xlsx 와 동일)
                    const found = await _lifFindHeat(competition_id, parsed.header);
                    const heat = found.heat;

                    let matchStatus = 'not_found';
                    let heatInfo = null;
                    let athleteMatches = [];

                    if (heat) {
                        matchStatus = 'matched';
                        heatInfo = {
                            heat_id: heat.id,
                            event_name: heat.event_name,
                            gender: heat.gender,
                            round_type: heat.round_type,
                            heat_number: heat.heat_number,
                            scoreboard_key: heat.scoreboard_key,
                            match_via: found.via,
                            ambiguous: !!found.ambiguous,
                        };

                        // Check athlete matches for each result row
                        const heatEntries = await db.all(`
                            SELECT he.*, ee.athlete_id, ee.id as event_entry_id,
                                   a.name, a.bib_number, a.team
                            FROM heat_entry he
                            JOIN event_entry ee ON ee.id = he.event_entry_id
                            JOIN athlete a ON a.id = ee.athlete_id
                            WHERE he.heat_id = ?
                        `, heat.id);

                        for (const row of parsed.rows) {
                            if (row.type === 'empty') continue;

                            let matchedEntry = null;
                            let matchMethod = 'none';

                            // 1. Match by BIB number (앞자리 0 무시)
                            if (row.bib) {
                                matchedEntry = heatEntries.find(e => _lifBibEq(e.bib_number, row.bib));
                                if (matchedEntry) matchMethod = 'bib';
                            }

                            // 2. Fallback: match by lane number
                            if (!matchedEntry && row.lane) {
                                matchedEntry = heatEntries.find(e => e.lane_number === row.lane);
                                if (matchedEntry) matchMethod = 'lane';
                            }

                            // 3. Fallback: match by name
                            if (!matchedEntry && row.name) {
                                matchedEntry = heatEntries.find(e => e.name === row.name);
                                if (matchedEntry) matchMethod = 'name';
                            }

                            // 이미 서버에 있는 기록 — 심판이 고친 값을 가져오기가 덮어쓰게 되면 미리보기에서 알린다
                            let existing = null;
                            if (matchedEntry) {
                                const ex = await db.get('SELECT time_seconds, status_code FROM result WHERE heat_id=? AND event_entry_id=? AND attempt_number IS NULL ORDER BY id DESC LIMIT 1', matchedEntry.source_heat_id || heat.id, matchedEntry.event_entry_id);
                                if (ex && (ex.time_seconds != null || ex.status_code)) existing = { time_seconds: ex.time_seconds, status_code: ex.status_code || '' };
                            }
                            const _incomingTime = row.type === 'result' ? row.time : null, _incomingStatus = ['DNS', 'DNF', 'DQ'].includes(row.type) ? row.type : '';
                            const overwrites = !!existing && ((_incomingTime != null && existing.time_seconds !== _incomingTime) || (_incomingStatus !== (existing.status_code || '') && (_incomingStatus || _incomingTime != null)));
                            athleteMatches.push({
                                existing, overwrites,
                                lif_rank: row.rank || row.type,
                                lif_bib: row.bib,
                                lif_lane: row.lane,
                                lif_name: row.name,
                                lif_team: row.team,
                                lif_time: row.time,
                                lif_type: row.type,
                                db_name: matchedEntry?.name || null,
                                db_bib: matchedEntry?.bib_number || null,
                                db_team: matchedEntry?.team || null,
                                db_lane: matchedEntry?.lane_number || null,
                                event_entry_id: matchedEntry?.event_entry_id || null,
                                heat_entry_id: matchedEntry?.id || null,
                                match_method: matchMethod,
                            });
                        }
                    }

                    results.push({
                        filename: file.originalname,
                        header: parsed.header,
                        rows: parsed.rows,
                        matchStatus,
                        heatInfo,
                        athleteMatches,
                    });
                } catch (parseErr) {
                    results.push({
                        filename: file.originalname,
                        error: parseErr.message,
                        matchStatus: 'error',
                    });
                } finally {
                    // Cleanup temp file
                    try { fs.unlinkSync(file.path); } catch(e) {}
                }
            }

            res.json({ success: true, results });
        } catch (err) {
            console.error('[Scoreboard Preview]', err);
            res.status(500).json({ error: err.message });
        }
    });

    /**
     * POST /api/scoreboard/import
     * Apply .lif results to DB — upsert results for matched athletes
     */
    app.post('/api/scoreboard/import', upload.array('files', 50), async (req, res) => {
        try {
            const { competition_id } = req.body;
            if (!competition_id) return res.status(400).json({ error: 'competition_id 필수' });

            const files = req.files;
            if (!files || files.length === 0) return res.status(400).json({ error: '.lif 파일을 선택해 주세요.' });

            const importResults = [];
            const hookJobs = [];   // 트랜잭션 뒤 신기록 감지에 넘길 [{row, heat}]
            const importTx = db.transaction(async () => {
                for (const file of files) {
                    let buf, parsed;
                    try {
                        buf = fs.readFileSync(file.path);
                        parsed = parseLifBuffer(buf);
                    } catch (parseErr) {
                        importResults.push({ filename: file.originalname, error: parseErr.message, imported: 0, skipped: 0 });
                        try { fs.unlinkSync(file.path); } catch(e) {}
                        continue;
                    }

                    // 조 찾기: 키 정확일치 → 합동조 키 → 구조 매칭(.txt/.xlsx 와 동일)
                    const found = await _lifFindHeat(competition_id, parsed.header);
                    const heat = found.heat;
                    const jointHeats = found.jointHeats;

                    if (!heat) {
                        importResults.push({
                            filename: file.originalname,
                            scoreboardKey: parsed.header.scoreboardKey,
                            error: `매칭되는 조를 찾을 수 없습니다: "${parsed.header.scoreboardKey}"`,
                            imported: 0, skipped: 0,
                        });
                        try { fs.unlinkSync(file.path); } catch(e) {}
                        continue;
                    }

                    // Get heat entries — include all joint heat entries for athlete matching
                    let heatEntries = await db.all(`
                        SELECT he.*, ee.athlete_id, ee.id as event_entry_id,
                               a.name, a.bib_number, a.team, ? as source_heat_id
                        FROM heat_entry he
                        JOIN event_entry ee ON ee.id = he.event_entry_id
                        JOIN athlete a ON a.id = ee.athlete_id
                        WHERE he.heat_id = ?
                    `, heat.id, heat.id);

                    // If joint import, also gather entries from other joint heats
                    if (jointHeats.length > 1) {
                        for (const jh of jointHeats) {
                            if (jh.id === heat.id) continue;
                            const jhEntries = await db.all(`
                                SELECT he.*, ee.athlete_id, ee.id as event_entry_id,
                                       a.name, a.bib_number, a.team, ? as source_heat_id
                                FROM heat_entry he
                                JOIN event_entry ee ON ee.id = he.event_entry_id
                                JOIN athlete a ON a.id = ee.athlete_id
                                WHERE he.heat_id = ?
                            `, jh.id, jh.id);
                            heatEntries = heatEntries.concat(jhEntries);
                        }
                    }

                    let imported = 0, skipped = 0;
                    const details = [], overwritten = [];

                    for (const row of parsed.rows) {
                        if (row.type === 'empty') continue;

                        // Match athlete
                        let matchedEntry = null;

                        // 1. BIB match (앞자리 0 무시)
                        if (row.bib) {
                            matchedEntry = heatEntries.find(e => _lifBibEq(e.bib_number, row.bib));
                        }
                        // 2. Lane match
                        if (!matchedEntry && row.lane) {
                            matchedEntry = heatEntries.find(e => e.lane_number === row.lane);
                        }
                        // 3. Name match
                        if (!matchedEntry && row.name) {
                            matchedEntry = heatEntries.find(e => e.name === row.name);
                        }

                        if (!matchedEntry) {
                            skipped++;
                            details.push({ name: row.name, bib: row.bib, reason: '매칭 실패' });
                            continue;
                        }

                        const heat_id = matchedEntry.source_heat_id || heat.id;
                        const event_entry_id = matchedEntry.event_entry_id;

                        // Determine status_code and time
                        let time_seconds = null;
                        let status_code = '';

                        if (row.type === 'DNS' || row.type === 'DNF' || row.type === 'DQ') {
                            status_code = row.type;
                        } else if (row.type === 'result') {
                            time_seconds = row.time;
                        } else {
                            skipped++; details.push({ name: row.name, bib: row.bib, reason: row.reason || '읽을 수 없는 행' }); continue;
                        }
                        if (row.type === 'result' && (time_seconds == null || !(time_seconds > 0))) {
                            // 시간이 없는 결과 행으로 심판이 넣은 기록을 지우지 않는다
                            skipped++; details.push({ name: row.name, bib: row.bib, reason: '시간 없음 — 기존 기록 유지' }); continue;
                        }

                        // Upsert result — 비고(remark)는 심판이 적은 것이므로 유지한다
                        const existing = await db.get('SELECT * FROM result WHERE heat_id=? AND event_entry_id=? AND attempt_number IS NULL ORDER BY id DESC LIMIT 1', heat_id, event_entry_id);
                        let written = null;
                        if (existing) {
                            const _nowFR2 = db.isAsync ? 'NOW()' : "datetime('now')";
                            await db.run(`UPDATE result SET time_seconds=?,status_code=?,updated_at=${_nowFR2} WHERE id=?`, time_seconds, status_code, existing.id);
                            const upd = await db.get('SELECT * FROM result WHERE id=?', existing.id);
                            audit('result', existing.id, 'UPDATE', existing, upd, 'scoreboard', null, req);
                            written = upd;
                            if (existing.time_seconds != null && existing.time_seconds !== time_seconds) overwritten.push({ name: row.name, bib: row.bib, before: existing.status_code || existing.time_seconds, after: status_code || time_seconds });
                        } else {
                            const info = await db.run('INSERT INTO result (heat_id,event_entry_id,time_seconds,status_code,remark) VALUES (?,?,?,?,?)', heat_id, event_entry_id, time_seconds, status_code, row.note || '');
                            const ins = await db.get('SELECT * FROM result WHERE id=?', info.lastInsertRowid);
                            audit('result', ins.id, 'INSERT', null, ins, 'scoreboard', null, req);
                            written = ins;
                        }
                        if (written) hookJobs.push({ row: written, heat: matchedEntry.source_heat_id ? await db.get('SELECT * FROM heat WHERE id=?', matchedEntry.source_heat_id) : heat });

                        imported++;
                        details.push({ name: row.name, bib: row.bib, time: time_seconds, status: status_code || 'OK' });
                    }

                    // Auto-save wind from .lif to heat (if wind data present)
                    let windImported = null;
                    if (parsed.header.wind != null) {
                        const windStr = parsed.header.wind.toFixed(1) + ' m/s';
                        // Apply wind to all joint heats
                        const windHeats = jointHeats.length > 0 ? jointHeats : [heat];
                        for (const wh of windHeats) {
                            await db.run('UPDATE heat SET wind=? WHERE id=?', windStr, wh.id);
                            broadcastSSE('wind_update', { heat_id: wh.id, wind: windStr });
                        }
                        windImported = windStr;
                    }

                    // Auto-update event round_status to in_progress (all joint events)
                    const statusHeats = jointHeats.length > 0 ? jointHeats : [heat];
                    for (const sh of statusHeats) {
                        const event = await db.get('SELECT * FROM event WHERE id=?', sh.event_id);
                        if (event && (event.round_status === 'heats_generated' || event.round_status === 'created') && imported > 0) {
                            await db.run("UPDATE event SET round_status='in_progress' WHERE id=?", event.id);
                            broadcastSSE('event_status_changed', { event_id: event.id, round_status: 'in_progress' });
                        }
                    }

                    // Broadcast result updates (all joint heats)
                    if (imported > 0) {
                        for (const rh of (jointHeats.length > 0 ? jointHeats : [heat])) {
                            broadcastSSE('result_update', { heat_id: rh.id, bulk: true });
                        }
                    }

                    const gL = heat.gender === 'M' ? '남자' : heat.gender === 'F' ? '여자' : '혼성';
                    const rL = { preliminary: '예선', semifinal: '준결승', final: '결승' }[heat.round_type] || heat.round_type;
                    const windLog = windImported != null ? ` / 풍속 ${windImported}` : '';
                    opLog(`전광판 연동: ${heat.event_name} ${rL} ${gL} ${heat.heat_number}조 — ${imported}건 입력${windLog}`, 'record', 'scoreboard', competition_id);

                    importResults.push({
                        filename: file.originalname,
                        scoreboardKey: parsed.header.scoreboardKey,
                        heatInfo: {
                            heat_id: heat.id,
                            event_name: heat.event_name,
                            heat_number: heat.heat_number,
                        },
                        wind: windImported,
                        imported,
                        skipped,
                        overwritten,          // 이미 있던 기록을 다른 값으로 덮은 선수 (심판 수정과 겹칠 때 확인용)
                        details,
                    });

                    try { fs.unlinkSync(file.path); } catch(e) {}
                }
            });

            await importTx();
            // 신기록 감지 — 수기 입력과 같은 훅. (트랜잭션이 끝난 뒤에 돌린다)
            if (_resultsRoutes && _resultsRoutes.runRecordCompareHook) for (const j of hookJobs) { try { await _resultsRoutes.runRecordCompareHook(j.row, j.heat); } catch (e) { /* 감지 실패는 가져오기를 막지 않는다 */ } }
            res.json({ success: true, results: importResults });
        } catch (err) {
            console.error('[Scoreboard Import]', err);
            res.status(500).json({ error: err.message });
        }
    });

    // ============================================================
    // 기록 엑셀 가져오기 (.lif 대안) — 헤더형 xlsx 를 배번 기준으로 매칭/입력
    //   헤더 예: 종별 | 세부종목 | 라운드 | 조 | 순위 | 레인 | 배번 | 성명 | 기록 | 풍속 | 팀명 | 기록구분 | 대회일자
    //   .lif 와 동일하게 (종목/조 매칭) → (배번→레인→성명 선수매칭) → 기록 업서트.
    //   차이: 문자열 scoreboard_key 대신 (성별+부+종목+라운드+조) 구조로 이벤트/조를 조회하고,
    //         배번 앞자리 0 정규화 + 기록포맷(분:초/미터) 변환 + 순위칸의 DNS/DNF/DQ 처리.
    // ============================================================
    function _recxNormBib(b) {
        const d = String(b == null ? '' : b).replace(/[^0-9]/g, '');
        return d.replace(/^0+/, '') || (d ? '0' : '');   // "00227"→"227", "000"→"0"
    }
    // 이름 정규화·부 토큰·후보 고르기는 공통 규칙 (lib/eventMatch.js) — 시간표 자동연결과 같은 판정
    const EM = require('../eventMatch');
    const _recxNormEvt = EM.normEvt;
    const _recxDivToken = EM.divToken;
    // 성별·라운드·시간 해석은 공통 파서(lib/timingParse.js) — 예전엔 '준결승'이 결승으로, 'DQ(TR16.8)'이 16.8초로, 라벨 중간의 성별을 놓쳤다
    const _recxGenderOf = timingParse.genderOf;
    const _recxRound = timingParse.parseRound;
    const _recxParseTime = timingParse.parseTime;
    // "6.72m"/"6.72"→6.72
    function _recxParseDist(raw) {
        const f = parseFloat(String(raw || '').replace(/[^0-9.]/g, ''));
        return isNaN(f) ? null : f;
    }

    function parseRecordXlsx(buffer) {
        const wbk = XLSX.read(buffer, { type: 'buffer' });
        const ws = wbk.Sheets[wbk.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        if (rows.length < 2) throw new Error('데이터가 없습니다.');
        const H = rows[0].map(h => String(h || '').trim());
        const col = {};
        H.forEach((h, i) => {
            const hl = h.toLowerCase();
            if (h.includes('세부종목') || h === '종목' || h.includes('종목명')) col.event = i;
            else if (h === '종별' || h.includes('부문') || h.includes('부별') || h === '부') col.div = i;
            else if (h.includes('라운드')) col.round = i;
            else if (h.includes('기록구분')) col.rtype = i;
            else if (h === '기록' || hl === 'record' || hl === 'result') col.record = i;
            else if (h === '조' || h.includes('조번호')) col.heat = i;
            else if (h.includes('순위')) { if (col.rank === undefined || h === '순위') col.rank = i; }
            else if (h.includes('레인') || h.includes('순서')) col.lane = i;
            else if (h.includes('배번') || hl === 'bib') col.bib = i;
            else if (h.includes('성명') || h.includes('이름') || h.includes('선수')) col.name = i;
            else if (h.includes('풍속') || h.includes('바람') || hl === 'wind') col.wind = i;
            else if (h.includes('팀') || h.includes('소속')) col.team = i;
        });
        if (col.event === undefined) throw new Error("'세부종목' 컬럼을 찾을 수 없습니다.");
        if (col.div === undefined) throw new Error("'종별' 컬럼을 찾을 수 없습니다.");

        const groups = new Map(); // key: divRaw|event|round|heat
        const get = (r, k) => (col[k] === undefined ? '' : String(r[col[k]] == null ? '' : r[col[k]]).trim());
        for (const r of rows.slice(1)) {
            if (!r || !r.some(c => String(c).trim())) continue;
            const divRaw = get(r, 'div');
            const eventName = get(r, 'event');
            if (!divRaw || !eventName) continue;
            const roundRaw = get(r, 'round');
            const heatNum = parseInt(get(r, 'heat')) || 1;
            const gk = `${divRaw}|${eventName}|${roundRaw}|${heatNum}`;
            if (!groups.has(gk)) {
                groups.set(gk, {
                    divisionRaw: divRaw,
                    gender: _recxGenderOf(divRaw),
                    divToken: _recxDivToken(divRaw),
                    eventName,
                    roundRaw: roundRaw || '결승',
                    round: _recxRound(roundRaw),
                    heatNum,
                    wind: null,
                    rows: [],
                });
            }
            const g = groups.get(gk);
            const windRaw = get(r, 'wind');
            if (g.wind == null && windRaw) { const w = parseFloat(windRaw); if (!isNaN(w)) g.wind = w; }
            const rankRaw = get(r, 'rank');
            const recordRaw = get(r, 'record');
            // 상태는 순위 칸·기록구분 칸·기록 칸 어디에 있어도, 사유가 붙어도("DQ(TR16.8)") 상태로 본다 — 공통 파서
            let type = timingParse.parseStatus(rankRaw) || timingParse.parseStatus(get(r, 'rtype')) || timingParse.parseStatus(recordRaw) || 'result';
            if (type === 'result' && !recordRaw && !/^\d+$/.test(rankRaw)) type = 'NM';
            g.rows.push({
                type,
                rank: /^\d+$/.test(rankRaw) ? parseInt(rankRaw, 10) : null,
                bib: get(r, 'bib'),
                lane: parseInt(get(r, 'lane')) || null,
                name: get(r, 'name'),
                team: get(r, 'team'),
                recordRaw,
            });
        }
        return Array.from(groups.values());
    }

    // 그룹 → (event, heat) 해석. 반환 { heat, event, ambiguous } 또는 null
    async function _recxResolveHeat(competition_id, g) {
        const events = await db.all('SELECT * FROM event WHERE competition_id=? AND parent_event_id IS NULL', competition_id);
        // 정확한 이름이 있으면 그것만(100m ↛ 100mH), 없을 때만 접두 · 라운드가 안 맞으면 라운드 무시 · 여럿이면 부 토큰으로 좁힘 — 공통 규칙
        const found = EM.findEvents(events, { name: g.eventName, gender: g.gender, round: g.round, divToken: g.divToken }, { allowPrefix: true, roundFallback: true });
        const cands = found.matches;
        if (cands.length === 0) return null;
        const event = cands[0];
        const ambiguous = found.ambiguous;
        let heat = await db.get('SELECT * FROM heat WHERE event_id=? AND heat_number=?', event.id, g.heatNum);
        if (!heat) {
            // 해당 조 번호가 없을 때: 조가 하나뿐인 종목(결승 단일조 등)만 그 조로 폴백.
            // 다중 조인데 지정 조가 없으면 엉뚱한 조에 덮어쓰지 않도록 매칭 실패 처리.
            const heats = await db.all('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number', event.id);
            if (heats.length === 1) heat = heats[0];
        }
        return heat ? { heat, event, ambiguous } : null;
    }

    async function _recxMatchGroup(competition_id, g) {
        const resolved = await _recxResolveHeat(competition_id, g);
        if (!resolved) return { group: g, matchStatus: 'not_found', heatInfo: null, athleteMatches: [] };
        const { heat, event, ambiguous } = resolved;
        const heatEntries = await db.all(`
            SELECT he.*, ee.athlete_id, ee.id as event_entry_id, a.name, a.bib_number, a.team
            FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id JOIN athlete a ON a.id=ee.athlete_id
            WHERE he.heat_id=?`, heat.id);
        const isField = String(event.category || '').startsWith('field');
        const athleteMatches = [];
        for (const row of g.rows) {
            let m = null, method = 'none';
            if (row.bib) { const nb = _recxNormBib(row.bib); m = heatEntries.find(e => _recxNormBib(e.bib_number) === nb); if (m) method = 'bib'; }
            if (!m && row.lane) { m = heatEntries.find(e => e.lane_number === row.lane); if (m) method = 'lane'; }
            if (!m && row.name) { m = heatEntries.find(e => e.name === row.name); if (m) method = 'name'; }
            let val = null;
            if (row.type === 'result') val = isField ? _recxParseDist(row.recordRaw) : _recxParseTime(row.recordRaw);
            athleteMatches.push({
                rec_rank: row.type === 'result' ? row.rank : row.type,
                rec_bib: row.bib, rec_lane: row.lane, rec_name: row.name, rec_team: row.team,
                rec_type: row.type, rec_value: val, rec_raw: row.recordRaw, is_field: isField,
                db_name: m ? m.name : null, db_bib: m ? m.bib_number : null, db_lane: m ? m.lane_number : null,
                event_entry_id: m ? m.event_entry_id : null, match_method: method,
            });
        }
        return {
            group: g,
            matchStatus: 'matched',
            ambiguous,
            heatInfo: { heat_id: heat.id, event_id: event.id, event_name: event.name, gender: event.gender, division: event.division || '', round_type: event.round_type, heat_number: heat.heat_number, is_field: isField },
            athleteMatches,
        };
    }

    // 미리보기 — 매칭 현황만 표시 (DB 변경 없음)
    app.post('/api/record-xlsx/preview', upload.single('file'), async (req, res) => {
        if (!isAdminKey(req.body.admin_key || req.headers['x-admin-key'])) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        if (!req.file) return res.status(400).json({ error: '파일이 필요합니다.' });
        const competition_id = parseInt(req.body.competition_id);
        if (!competition_id) return res.status(400).json({ error: 'competition_id 필요' });
        try {
            const buf = fs.readFileSync(req.file.path);
            const groups = parseRecordXlsx(buf);
            const results = [];
            for (const g of groups) results.push(await _recxMatchGroup(competition_id, g));
            res.json({ success: true, total_groups: groups.length, results });
        } catch (err) {
            console.error('[record-xlsx/preview]', err);
            res.status(500).json({ error: err.message });
        } finally { try { fs.unlinkSync(req.file.path); } catch (e) {} }
    });

    // 적용 — 매칭된 선수에게 기록 업서트
    app.post('/api/record-xlsx/import', upload.single('file'), async (req, res) => {
        if (!isAdminKey(req.body.admin_key || req.headers['x-admin-key'])) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        if (!req.file) return res.status(400).json({ error: '파일이 필요합니다.' });
        const competition_id = parseInt(req.body.competition_id);
        if (!competition_id) return res.status(400).json({ error: 'competition_id 필요' });
        try {
            const buf = fs.readFileSync(req.file.path);
            const groups = parseRecordXlsx(buf);
            const out = [];
            const _hookJobs = [];   // 트랜잭션 뒤 신기록 감지 (수기 입력과 같은 훅)
            await db.transaction(async () => {
                for (const g of groups) {
                    const matched = await _recxMatchGroup(competition_id, g);
                    if (matched.matchStatus !== 'matched') {
                        out.push({ label: `${g.divisionRaw} ${g.eventName} ${g.roundRaw} ${g.heatNum}조`, error: '매칭되는 종목/조를 찾을 수 없습니다.', imported: 0, skipped: g.rows.length });
                        continue;
                    }
                    if (matched.ambiguous) {
                        // 후보 종목이 둘 이상(성별·부를 못 가림) — 첫 후보에 넣지 않고 거부한다. 파일의 종목 라벨에 성별·부를 적어 다시 올린다
                        out.push({ label: `${g.divisionRaw} ${g.eventName} ${g.roundRaw} ${g.heatNum}조`, error: '해당하는 종목이 둘 이상입니다(성별·부 구분 필요). 라벨에 성별·부를 적어 다시 올려 주세요.', imported: 0, skipped: g.rows.length });
                        continue;
                    }
                    const { heat_id, event_id, is_field } = matched.heatInfo;
                    let imported = 0, skipped = 0;
                    for (const am of matched.athleteMatches) {
                        if (!am.event_entry_id) { skipped++; continue; }
                        let time_seconds = null, distance_meters = null, status_code = '';
                        if (am.rec_type === 'DNS') status_code = 'DNS';
                        else if (am.rec_type === 'DNF') status_code = 'DNF';
                        else if (am.rec_type === 'DQ') status_code = 'DQ';
                        else if (am.rec_type === 'NM') status_code = 'NM';
                        else { if (is_field) distance_meters = am.rec_value; else time_seconds = am.rec_value; }
                        if (am.rec_type === 'result' && time_seconds == null && distance_meters == null) { skipped++; continue; }
                        const existing = await db.get('SELECT * FROM result WHERE heat_id=? AND event_entry_id=? AND attempt_number IS NULL ORDER BY id DESC LIMIT 1', heat_id, am.event_entry_id);
                        const _now = db.isAsync ? 'NOW()' : "datetime('now')";
                        if (existing) {
                            await db.run(`UPDATE result SET time_seconds=?,distance_meters=?,status_code=?,updated_at=${_now} WHERE id=?`, time_seconds, distance_meters, status_code, existing.id);
                            const upd = await db.get('SELECT * FROM result WHERE id=?', existing.id);
                            audit('result', existing.id, 'UPDATE', existing, upd, 'record-xlsx', null, req);
                            _hookJobs.push({ row: upd, heat_id });
                        } else {
                            const info = await db.run('INSERT INTO result (heat_id,event_entry_id,time_seconds,distance_meters,status_code,remark) VALUES (?,?,?,?,?,?)', heat_id, am.event_entry_id, time_seconds, distance_meters, status_code, '');
                            const ins = await db.get('SELECT * FROM result WHERE id=?', info.lastInsertRowid);
                            audit('result', ins.id, 'INSERT', null, ins, 'record-xlsx', null, req);
                            _hookJobs.push({ row: ins, heat_id });
                        }
                        imported++;
                    }
                    if (g.wind != null && !is_field) {
                        const windStr = g.wind.toFixed(1) + ' m/s';
                        await db.run('UPDATE heat SET wind=? WHERE id=?', windStr, heat_id);
                        broadcastSSE('wind_update', { heat_id, wind: windStr });
                    }
                    const ev = await db.get('SELECT * FROM event WHERE id=?', event_id);
                    if (ev && imported > 0 && (ev.round_status === 'heats_generated' || ev.round_status === 'created')) {
                        await db.run("UPDATE event SET round_status='in_progress' WHERE id=?", event_id);
                        broadcastSSE('event_status_changed', { event_id, round_status: 'in_progress' });
                    }
                    if (imported > 0) broadcastSSE('result_update', { heat_id, bulk: true });
                    out.push({ label: `${matched.heatInfo.event_name} ${matched.heatInfo.round_type} ${matched.heatInfo.heat_number}조`, imported, skipped, wind: g.wind != null && !is_field ? g.wind.toFixed(1) + ' m/s' : null });
                }
            })();
            const totalImp = out.reduce((s, r) => s + (r.imported || 0), 0);
            await _runImportRecordHooks(_hookJobs);
            opLog(`기록 엑셀 가져오기: ${out.length}개 그룹, ${totalImp}건 입력`, 'record', 'admin', competition_id);
            res.json({ success: true, results: out });
        } catch (err) {
            console.error('[record-xlsx/import]', err);
            res.status(500).json({ error: err.message });
        } finally { try { fs.unlinkSync(req.file.path); } catch (e) {} }
    });

    // ============================================================
    // 계측 결과 .txt 가져오기 (계측업체 결과프로그램 출력물)
    //   양식(탭 구분):
    //     1행: "성별 부 종목 라운드 [조]\t풍속(m/s)\t...\t날짜-시간"  (예: 남자 장년부 100m 예선 1조 \t N/A m/s \t ...)
    //     2행: 순위 \t 번호 \t 레인 \t 이름 \t 소속 \t 기록
    //     3행~: 데이터 (기록 = 12.34 / 1:05.3 / DNS/DNF/DQ, 순위 ##$$ = 비순위)
    //   → record-xlsx 임포트와 동일 인프라(_recxMatchGroup/삽입) 재활용. 파일 1개 = 종목·조 1개.
    // ============================================================
    // "남자 실업부 100m 결승 2조" 같은 한 줄 종목 라벨 → { divisionRaw, gender, divToken, eventName, roundRaw, round, heatNum }
    //   .txt(계측 결과) 1행과 .lif 헤더가 같은 형태라 공유. 종목(거리/필드) 위치 기준으로 앞=성별+부, 뒤=라운드+조.
    //   전광판 .lif 는 "100 결승" 처럼 m 이 빠진 경우가 있어 숫자만 있으면 m 을 붙인다.
    // 가져오기 뒤 신기록 감지 — 수기 입력(results.js)과 같은 훅. 트랜잭션이 끝난 뒤 돌린다 (예전엔 세 경로 모두 감지를 건너뛰었다)
    async function _runImportRecordHooks(jobs) {
        if (!_resultsRoutes || !_resultsRoutes.runRecordCompareHook) return;
        const heatCache = new Map();
        for (const j of jobs || []) {
            try {
                if (!heatCache.has(j.heat_id)) heatCache.set(j.heat_id, await db.get('SELECT * FROM heat WHERE id=?', j.heat_id));
                await _resultsRoutes.runRecordCompareHook(j.row, heatCache.get(j.heat_id));
            } catch (e) { /* 감지 실패는 가져오기를 막지 않는다 */ }
        }
    }
    function _parseEventLabel(fullName) {
        fullName = String(fullName || '').trim();
        let em = fullName.match(/(\d+\s*[×xX]\s*\d+\s*m?R?|\d+mH|\d+mSC|\d+mW|\d+m|\d+kmW?|하프마라톤|마라톤|멀리뛰기|세단뛰기|높이뛰기|장대높이뛰기|포환던지기|원반던지기|창던지기|해머던지기|\d+종경기)/i);
        let eventName = em ? em[1].replace(/\s+/g, '') : fullName;
        if (!em) {
            // 단위 없는 거리("100 결승", "1500 예선 1조") → 100m / 1500m
            const bare = fullName.match(/(?:^|\s)(\d{2,5})(?=\s|$)/);
            if (bare) { em = { index: bare.index + (bare[0].length - bare[1].length), 1: bare[1] }; eventName = bare[1] + 'm'; }
        }
        const beforeEvt = em ? fullName.slice(0, em.index).trim() : '';
        const afterEvt = em ? fullName.slice(em.index + em[1].length).trim() : '';
        const hm = afterEvt.match(/(\d+)\s*조/); const heatNum = hm ? parseInt(hm[1]) : 1;
        const roundRaw = /예선/.test(afterEvt) ? '예선' : /준결/.test(afterEvt) ? '준결승' : '결승';
        const divisionRaw = beforeEvt || fullName;
        return { divisionRaw, gender: _recxGenderOf(divisionRaw), divToken: _recxDivToken(divisionRaw), eventName, roundRaw, round: _recxRound(roundRaw), heatNum };
    }

    function parseTimingTxt(content) {
        content = String(content).replace(/^﻿/, '');
        const lines = content.split(/\r?\n/);
        let i = 0; while (i < lines.length && !lines[i].trim()) i++;
        if (i >= lines.length) throw new Error('빈 파일');
        const head = lines[i].split('\t').map(s => s.trim());
        const fullName = (head[0] || '').replace(/^﻿/, '').trim();
        if (!fullName) throw new Error('1행에서 종목명을 찾을 수 없습니다.');
        // 풍속: 메타 필드 중 m/s 로 끝나는 것 (N/A m/s 는 무시)
        let wind = null;
        for (const f of head.slice(1)) { const wm = String(f).match(/([+-]?\d+(?:\.\d+)?)\s*m\/s/i); if (wm) { const w = parseFloat(wm[1]); if (!isNaN(w)) { wind = w; break; } } }
        const label = _parseEventLabel(fullName);
        // 컬럼 헤더행 (순위 … 기록)
        let hi = -1;
        for (let k = i + 1; k < lines.length; k++) { if (/순위/.test(lines[k]) && /기록/.test(lines[k])) { hi = k; break; } }
        if (hi < 0) hi = i + 1;
        const cols = (lines[hi] || '').split('\t').map(s => s.trim());
        const ci = {
            rank: cols.findIndex(c => /순위/.test(c)), bib: cols.findIndex(c => /번호|배번/.test(c)),
            lane: cols.findIndex(c => /레인|순서/.test(c)), name: cols.findIndex(c => /이름|성명/.test(c)),
            team: cols.findIndex(c => /소속|팀/.test(c)), record: cols.findIndex(c => /기록/.test(c)),
        };
        const rows = [];
        for (let k = hi + 1; k < lines.length; k++) {
            if (!lines[k].trim()) continue;
            const f = lines[k].split('\t');
            const gv = (idx) => idx >= 0 ? String(f[idx] == null ? '' : f[idx]).trim() : '';
            const name = gv(ci.name), rec = gv(ci.record), bib = gv(ci.bib);
            if (!name && !rec && !bib) continue;
            const rankRaw = gv(ci.rank);
            let type = 'result';
            const _st = timingParse.parseStatus(rec);       // "DQ(TR16.8)" 처럼 사유가 붙어도 상태 (예전엔 16.8초 기록이 됐다)
            if (_st) type = _st;
            rows.push({ type, rank: /^\d+$/.test(rankRaw) ? parseInt(rankRaw) : null, bib, lane: parseInt(gv(ci.lane)) || null, name, team: gv(ci.team), recordRaw: rec });
        }
        return [{ ...label, wind, rows }];
    }

    app.post('/api/timing-txt/import', upload.array('files', 100), async (req, res) => {
        const competition_id = parseInt(req.body.competition_id);
        if (!competition_id) return res.status(400).json({ error: 'competition_id 필요' });
        if (!req.files || !req.files.length) return res.status(400).json({ error: '.txt 파일을 선택하세요.' });
        const previewOnly = req.body.preview === 'true' || req.body.preview === true;
        const out = [];
        const _hookJobs = [];   // 트랜잭션 뒤 신기록 감지 (수기 입력과 같은 훅)
        const run = async () => {
            for (const file of req.files) {
                let groups;
                try { groups = parseTimingTxt(fs.readFileSync(file.path, 'utf8')); }
                catch (e) { out.push({ filename: file.originalname, error: e.message, imported: 0, skipped: 0 }); continue; }
                for (const g of groups) {
                    const matched = await _recxMatchGroup(competition_id, g);
                    if (matched.matchStatus !== 'matched') {
                        out.push({ filename: file.originalname, label: `${g.divisionRaw} ${g.eventName} ${g.roundRaw} ${g.heatNum}조`, error: '매칭되는 종목/조 없음', imported: 0, skipped: g.rows.length, matched: 0, total: g.rows.length });
                        continue;
                    }
                    if (matched.ambiguous) {
                        // 후보 종목이 둘 이상(성별·부를 못 가림) — 첫 후보에 넣지 않고 거부한다. 파일의 종목 라벨에 성별·부를 적어 다시 올린다
                        out.push({ label: `${g.divisionRaw} ${g.eventName} ${g.roundRaw} ${g.heatNum}조`, error: '해당하는 종목이 둘 이상입니다(성별·부 구분 필요). 라벨에 성별·부를 적어 다시 올려 주세요.', imported: 0, skipped: g.rows.length });
                        continue;
                    }
                    const { heat_id, event_id, is_field } = matched.heatInfo;
                    const matchedCnt = matched.athleteMatches.filter(a => a.event_entry_id).length;
                    if (previewOnly) {
                        out.push({ filename: file.originalname, label: `${matched.heatInfo.event_name} ${{ preliminary: '예선', semifinal: '준결승', final: '결승' }[matched.heatInfo.round_type] || ''} ${matched.heatInfo.heat_number}조`, matched: matchedCnt, total: matched.athleteMatches.length,
                            rows: matched.athleteMatches.map(a => ({ rank: a.rec_rank, bib: a.rec_bib, name: a.rec_name, record: a.rec_raw, ok: !!a.event_entry_id })) });
                        continue;
                    }
                    let imported = 0, skipped = 0;
                    for (const am of matched.athleteMatches) {
                        if (!am.event_entry_id) { skipped++; continue; }
                        let time_seconds = null, distance_meters = null, status_code = '';
                        if (am.rec_type === 'DNS') status_code = 'DNS';
                        else if (am.rec_type === 'DNF') status_code = 'DNF';
                        else if (am.rec_type === 'DQ') status_code = 'DQ';
                        else if (am.rec_type === 'NM') status_code = 'NM';
                        else { if (is_field) distance_meters = am.rec_value; else time_seconds = am.rec_value; }
                        if (am.rec_type === 'result' && time_seconds == null && distance_meters == null) { skipped++; continue; }
                        const existing = await db.get('SELECT * FROM result WHERE heat_id=? AND event_entry_id=? AND attempt_number IS NULL ORDER BY id DESC LIMIT 1', heat_id, am.event_entry_id);
                        const _now = db.isAsync ? 'NOW()' : "datetime('now')";
                        if (existing) {
                            await db.run(`UPDATE result SET time_seconds=?,distance_meters=?,status_code=?,updated_at=${_now} WHERE id=?`, time_seconds, distance_meters, status_code, existing.id);
                            const upd = await db.get('SELECT * FROM result WHERE id=?', existing.id);
                            audit('result', existing.id, 'UPDATE', existing, upd, 'timing-txt', null, req);
                            _hookJobs.push({ row: upd, heat_id });
                        } else {
                            const info = await db.run('INSERT INTO result (heat_id,event_entry_id,time_seconds,distance_meters,status_code,remark) VALUES (?,?,?,?,?,?)', heat_id, am.event_entry_id, time_seconds, distance_meters, status_code, '');
                            const ins = await db.get('SELECT * FROM result WHERE id=?', info.lastInsertRowid);
                            audit('result', ins.id, 'INSERT', null, ins, 'timing-txt', null, req);
                            _hookJobs.push({ row: ins, heat_id });
                        }
                        imported++;
                    }
                    if (g.wind != null && !is_field) {
                        const windStr = g.wind.toFixed(1) + ' m/s';
                        await db.run('UPDATE heat SET wind=? WHERE id=?', windStr, heat_id);
                        broadcastSSE('wind_update', { heat_id, wind: windStr });
                    }
                    const ev = await db.get('SELECT * FROM event WHERE id=?', event_id);
                    if (ev && imported > 0 && (ev.round_status === 'heats_generated' || ev.round_status === 'created')) {
                        await db.run("UPDATE event SET round_status='in_progress' WHERE id=?", event_id);
                        broadcastSSE('event_status_changed', { event_id, round_status: 'in_progress' });
                    }
                    if (imported > 0) broadcastSSE('result_update', { heat_id, bulk: true });
                    out.push({ filename: file.originalname, label: `${matched.heatInfo.event_name} ${{ preliminary: '예선', semifinal: '준결승', final: '결승' }[matched.heatInfo.round_type] || ''} ${matched.heatInfo.heat_number}조`, imported, skipped, matched: matchedCnt, total: matched.athleteMatches.length, wind: g.wind != null && !is_field ? g.wind.toFixed(1) + ' m/s' : null });
                }
            }
        };
        try {
            if (previewOnly) await run(); else await db.transaction(run)();
            if (!previewOnly) await _runImportRecordHooks(_hookJobs);
            const totalImp = out.reduce((s, r) => s + (r.imported || 0), 0);
            if (!previewOnly && totalImp > 0) opLog(`계측결과(txt) 가져오기: ${req.files.length}개 파일, ${totalImp}건 입력`, 'record', 'timing', competition_id);
            res.json({ success: true, preview: previewOnly, results: out });
        } catch (err) {
            console.error('[timing-txt/import]', err);
            res.status(500).json({ error: err.message });
        } finally { for (const f of (req.files || [])) { try { fs.unlinkSync(f.path); } catch (e) {} } }
    });

    return { recx: { normBib: _recxNormBib, divToken: _recxDivToken, genderOf: _recxGenderOf, round: _recxRound } };
};
