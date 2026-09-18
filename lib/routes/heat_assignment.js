'use strict';
/**
 * 조편성 업로드 (2·3단계) — server.js 에서 추출 (2026-09 Phase 4)
 *   POST /api/heat-assignment/preview  파일 → 종목별 변경 미리보기
 *   POST /api/heat-assignment/apply    적용 (종목 자동 생성, 라운드 전환, 조·레인 교체, 기록 있는 종목 보호)
 *   연맹 데일리 원본(xlsx ▣ 양식 / PDF)은 lib/federationDaily(.Pdf) 가 표준 표로 바꿔 같은 흐름을 탄다.
 *   ※ 동작은 server.js 인라인 시절과 동일해야 한다 — 회귀 테스트: tests/flows/01_yecheon_pipeline, tests/api/25_heat_assignment_round_sync
 */
const fs = require('fs');
const XLSX = require('xlsx');

module.exports = function mountHeatAssignmentRoutes(app, deps) {
    const { db, upload, isAdminKey, opLog, normalizeDivisionLabel, resolveFedEventName, guessEventCategory, autoLinkDisplayTimetable } = deps;
    for (const [k, v] of Object.entries({ db, upload, isAdminKey, opLog, normalizeDivisionLabel, resolveFedEventName, guessEventCategory, autoLinkDisplayTimetable })) {
        if (!v) throw new Error(`[heat_assignment] mount requires deps.${k}`);
    }

    const { storedName: normalizeEventName } = require('../eventName');

    // Helper: Normalize gender from Excel
    function normalizeGender(raw) {
        if (!raw) return null;
        const s = String(raw).trim();
        if (s === '남' || s === 'M' || s === '남자') return 'M';
        if (s === '여' || s === 'F' || s === '여자') return 'F';
        if (s === '혼성' || s === 'X' || s === '혼') return 'X';
        return null;
    }

    // Helper: Normalize round from Excel
    function normalizeRound(raw) {
        if (!raw) return 'final';
        const s = String(raw).trim().toLowerCase();
        if (s === '예선' || s === 'preliminary' || s === '예') return 'preliminary';
        if (s === '준결승' || s === 'semifinal' || s === '준결') return 'semifinal';
        if (s === '결승' || s === 'final' || s === '결') return 'final';
        // 10종/7종 sub-events are stored as round_type='final' in DB
        if (/10종|십종|decathlon|7종|칠종|heptathlon/i.test(s)) return 'final';
        // Patterns like "3-2+2", "2-3+2" → preliminary (multiple heats with advancement)
        if (/^\d+-\d+\+\d+$/.test(s)) return 'preliminary';
        // Excel date serial numbers (예선 misread as date) → treat as preliminary
        if (/^\d{4,5}$/.test(s)) return 'preliminary';
        return 'final';
    }

    // Helper: Normalize division (부) from Excel — delegates to the shared label canonicalizer
    // (normalizeDivisionLabel: 중등부/고등부/대학부/초등부/일반부/선수권(남|여|혼)/U18/U20 정규화)
    function normalizeDivision(raw) {
        if (raw == null) return '';
        const s = String(raw).trim();
        if (!s) return '';
        return normalizeDivisionLabel(s);
    }
    // Helper: normalized division key for matching (공백/괄호 무시 비교는 normalizeDivisionLabel 이 처리)
    function divNorm(v) { return normalizeDivisionLabel(String(v || '')); }

    // Helper: infer event category for a heat-assignment row (file has no category column)
    //   1) resolveFedEventName (FED_EVENT_MAP: 1500m→track, 릴레이→relay, 10,000m, 10종경기→combined …)
    //   2) guessEventCategory (이름 정규식 폴백)
    function inferHeatEventCategory(eventNameRaw) {
        const base = String(eventNameRaw || '').replace(/^\[(10종|7종)\]\s*/, '');
        const m = resolveFedEventName(base);
        if (m && m.category) return m.category;
        return guessEventCategory(base);
    }
    // Helper: round_type for an auto-created heat-assignment event
    //   엑셀이 명시한 라운드(parsedRound) 우선, 단 field/road/combined/relay·장거리는 항상 final 로 보정
    function computeHeatRoundType(category, eventName, parsedRound) {
        const ALWAYS_FINAL_CATEGORIES = ['field_distance', 'field_height', 'combined', 'relay', 'road'];
        const ALWAYS_FINAL_EVENTS = ['1000m','5000m','5000mW','10,000m','10,000mW','10000m','3000mSC','3000m장애물','마라톤','하프마라톤','20KmW','35kmW','10K','5K'];
        const base = String(eventName || '').replace(/^\[(10종|7종)\]\s*/, '');
        const isFinalOnly = ALWAYS_FINAL_CATEGORIES.includes(category) || ALWAYS_FINAL_EVENTS.some(e => base === e || base.startsWith(e + ' '));
        if (isFinalOnly) return 'final';
        return parsedRound || 'final';
    }

    // Division-aware event lookup for heat-assignment import (apply/preview 공유).
    //   (a) displayName 정확매칭(이 importer 의 이전 실행) → (b) 기본명 + division 컬럼 매칭(시간표 자동연결이 만든 종목 재사용)
    //   → (c) division 없을 때만 기본명 레거시 매칭(부 없는 기존 대회 하위호환)
    async function findHeatAssignmentEvent(competition_id, group) {
        const { gender, eventName, division, displayName, round } = group;
        const g = gender && gender !== '?' ? gender : null;
        const tryName = async (name) => {
            if (g) {
                return await db.get('SELECT * FROM event WHERE competition_id=? AND name=? AND gender=? AND round_type=? AND parent_event_id IS NULL', competition_id, name, g, round)
                    || await db.get('SELECT * FROM event WHERE competition_id=? AND name=? AND gender=? AND parent_event_id IS NULL', competition_id, name, g)
                    || await db.get('SELECT * FROM event WHERE competition_id=? AND name=? AND gender=? AND round_type=?', competition_id, name, g, round)
                    || await db.get('SELECT * FROM event WHERE competition_id=? AND name=? AND gender=?', competition_id, name, g);
            }
            return await db.get('SELECT * FROM event WHERE competition_id=? AND name=? AND parent_event_id IS NULL', competition_id, name)
                || await db.get('SELECT * FROM event WHERE competition_id=? AND name=?', competition_id, name);
        };
        // (a) displayName 정확매칭
        let e = await tryName(displayName);
        if (e) return e;
        // (b) 시간표 자동연결 종목 재사용: 기본명 + division 컬럼 일치
        if (division && g) {
            const cands = await db.all('SELECT * FROM event WHERE competition_id=? AND name=? AND gender=?', competition_id, eventName, g);
            const hit = cands.find(c => divNorm(c.division) === divNorm(division));
            if (hit) return hit;
        }
        // (c) 부 없는 경우만 기본명 레거시 매칭
        if (!division) {
            e = await tryName(eventName);
            if (e) return e;
        }
        return null;
    }

    // Parse heat assignment Excel: returns grouped events
    //   roster(선택): 그 대회 선수 목록 — 연맹 데일리 양식(▣ 섹션형)을 표로 바꿀 때 성명·소속을 명단 기준으로 맞춘다
    function parseHeatAssignmentExcel(filePath, roster, pdfDaily) {
        if (pdfDaily) return _parseHeatAssignmentRows(null, 'PDF', roster, pdfDaily);
        const wb = XLSX.readFile(filePath);
        // Try to find sheet named '조편성', otherwise use first sheet
        const sheetName = wb.SheetNames.find(n => n.includes('조편성')) || wb.SheetNames[0];
        const ws = wb.Sheets[sheetName];
        return _parseHeatAssignmentRows(ws, sheetName, roster, null);
    }
    // PDF 데일리: 글자 추출 → ▣ 섹션형 표 (비동기라 라우트에서 먼저 만든 뒤 넘긴다)
    async function loadHeatAssignmentUpload(file, roster) {
        const isPdf = /\.pdf$/i.test(file.originalname || '') || file.mimetype === 'application/pdf';
        if (!isPdf) return parseHeatAssignmentExcel(file.path, roster);
        const pdf = await require('../federationDailyPdf').pdfToDailyRows(fs.readFileSync(file.path), roster);
        return parseHeatAssignmentExcel(null, roster, pdf);
    }
    function _parseHeatAssignmentRows(ws, sheetName, roster, pdfDaily) {
        let rows = ws ? XLSX.utils.sheet_to_json(ws, { header: 1 }) : [];
        // 연맹 '데일리 조편성' 원본(▣ 섹션형)을 그대로 올린 경우 → 표준 표로 변환해서 아래 흐름을 그대로 탄다
        let _fedDaily = null;
        {
            const asText = pdfDaily ? pdfDaily.aoa : XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
            _fedDaily = require('../federationDaily').convertIfFederationDaily(asText, roster || []);
            if (_fedDaily) rows = _fedDaily.aoa;
            if (pdfDaily && _fedDaily) _fedDaily.notes.unshift(...pdfDaily.issues);
        }
        if (rows.length < 2) throw new Error(_fedDaily ? '연맹 데일리 양식으로 인식했지만 선수 행을 찾지 못했습니다. (▣ 종목 머리글과 레인·번호·성명·소속 열을 확인하세요)' : '데이터가 없습니다.');

        // Detect headers
        const headers = rows[0].map(h => String(h || '').trim());
    
        // Find column indices by header name (flexible matching)
        const colIdx = {};
        headers.forEach((h, idx) => {
            // 헤더에 괄호 설명이 붙은 템플릿("성별(남/여/혼성)", "라운드(예선/결승)",
            // "그룹(A/B)", "순서(레인)" 등)도 인식되도록 첫 괄호 이전의 핵심 키워드만 추출해 매칭.
            // (정확매칭만 하면 성별·라운드·그룹·레인 컬럼을 놓쳐 성별 NULL·레인 NULL 사고 발생)
            const hl = h.replace(/[\(（].*$/, '').trim().toLowerCase();
            if (hl === '성별' || hl === 'gender') colIdx.gender = idx;
            else if (hl === '종목' || hl === 'event' || hl === '종목명') colIdx.event = idx;
            else if (hl === '라운드' || hl === 'round') colIdx.round = idx;
            else if (hl === '조' || hl === 'heat' || hl === '조번호') colIdx.heat = idx;
            else if (hl === '그룹' || hl === 'group' || hl === '그룹명') colIdx.group = idx;
            else if (hl === '순서' || hl === 'lane' || hl === '레인' || hl === '레인/순서') colIdx.lane = idx;
            else if (hl === '배번' || hl === 'bib' || hl === '번호') colIdx.bib = idx;
            else if (hl === '성명' || hl === 'name' || hl === '선수명') colIdx.name = idx;
            else if (hl === '소속' || hl === 'team' || hl === '팀명') colIdx.team = idx;
            else if (hl === '부' || hl === '부별' || hl === '종별' || hl === '부문' || hl === 'division') colIdx.division = idx;
        });

        // Validate required columns
        if (colIdx.event === undefined) throw new Error("'종목' 컬럼을 찾을 수 없습니다.");
        if (colIdx.name === undefined) throw new Error("'성명' 컬럼을 찾을 수 없습니다.");

        const dataRows = rows.slice(1).filter(r => r[colIdx.event] && r[colIdx.name]);
    
        // Group by event key: gender + event_name + round_type
        const eventGroups = new Map();
    
        for (const row of dataRows) {
            const gender = normalizeGender(row[colIdx.gender !== undefined ? colIdx.gender : -1]);
            let eventName = normalizeEventName(row[colIdx.event]);
            const rawRound = colIdx.round !== undefined ? String(row[colIdx.round] || '').trim() : '';
        
            // Detect 10종/7종 in round column → prefix event name with [10종]/[7종]
            const is10jong = /10종|십종|decathlon/i.test(rawRound);
            const is7jong = /7종|칠종|heptathlon/i.test(rawRound);
            if (is10jong && eventName && !eventName.startsWith('[10종]')) {
                eventName = `[10종] ${eventName}`;
            } else if (is7jong && eventName && !eventName.startsWith('[7종]')) {
                eventName = `[7종] ${eventName}`;
            }
        
            const round = normalizeRound(rawRound);
            // 10종/7종 세부종목은 조 번호를 항상 1로 강제 (전체 선수가 1조에서 뜀)
            let heatNum = colIdx.heat !== undefined ? parseInt(row[colIdx.heat]) || 1 : 1;
            if (is10jong || is7jong) heatNum = 1;
            let group = colIdx.group !== undefined ? (row[colIdx.group] ? String(row[colIdx.group]).replace(/[\s\u3000]+/g, '').toUpperCase() : null) : null;
            if (group === '') group = null;
            const lane = colIdx.lane !== undefined ? parseInt(row[colIdx.lane]) || null : null;
            const bib = colIdx.bib !== undefined ? (row[colIdx.bib] != null ? String(row[colIdx.bib]).trim() : null) : null;
            const name = String(row[colIdx.name]).trim();
            const team = colIdx.team !== undefined ? String(row[colIdx.team] || '').replace(/[\s\u3000]+$/g, '').trim() : '';
            // \ubd80(division): \uc885\ubaa9\uba85\uc5d0 \uc811\ubbf8\uc0ac\ub85c \ubd99\uc5ec \ubd80\ubcc4\ub85c \ub2e4\ub978 \uc885\ubaa9\uc774 \ub418\ub3c4\ub85d (\uc608: "1500m \uc77c\ubc18\ubd80")
            const division = colIdx.division !== undefined ? normalizeDivision(row[colIdx.division]) : '';
            const displayName = division ? `${eventName} ${division}` : eventName;

            if (!eventName || !name) continue;

            const eventKey = `${gender || '?'}|${eventName}|${division}|${round}`;
            if (!eventGroups.has(eventKey)) {
                eventGroups.set(eventKey, {
                    gender, eventName, division, displayName, round,
                    entries: []
                });
            }
            eventGroups.get(eventKey).entries.push({
                heat: heatNum, group, lane, bib, name, team
            });
        }

        // ============================================================
        // 라운드 혼재 자동 병합: 같은 성별+종목에서 소수 선수만 다른 라운드로
        // 되어있으면 엑셀 입력 오류로 간주하여 다수 라운드 쪽으로 병합
        // 예: 남 400mH 예선:10명, 결승:1명 → 1명을 예선으로 병합
        // 단, 10종/7종 세부종목과의 혼재는 제외 (이건 정상)
        // ============================================================
        const mergeWarnings = [];
        const byGenderEvent = new Map(); // 'M|400mH|일반부' → [{eventKey, round, count}]  ← 부 포함: 부가 다르면 절대 병합 안 함
        for (const [eventKey, group] of eventGroups) {
            const ge = `${group.gender}|${group.eventName}|${group.division || ''}`;
            if (!byGenderEvent.has(ge)) byGenderEvent.set(ge, []);
            byGenderEvent.get(ge).push({ eventKey, round: group.round, count: group.entries.length });
        }

        for (const [ge, rounds] of byGenderEvent) {
            if (rounds.length < 2) continue;
            // 10종/7종 세부종목은 병합 대상이 아님 (round column에 '10종','7종' 등이 있으면 이미 별도 eventName)
            // 여기서 걸리는 건 순수하게 예선/결승/준결승이 혼재된 경우만
            const total = rounds.reduce((s, r) => s + r.count, 0);
            // 가장 선수가 많은 라운드 찾기
            rounds.sort((a, b) => b.count - a.count);
            const majority = rounds[0];
            // 소수 라운드들 (전체의 20% 미만인 그룹)
            const minorities = rounds.slice(1).filter(r => r.count < total * 0.2);
            if (minorities.length === 0) continue;

            for (const minor of minorities) {
                const minorGroup = eventGroups.get(minor.eventKey);
                const majorGroup = eventGroups.get(majority.eventKey);
                if (!minorGroup || !majorGroup) continue;

                const [g, evName, evDiv] = ge.split('|');
                const gLabel = (g === 'M' ? '남' : g === 'F' ? '여' : '혼성') + (evDiv ? ' ' + evDiv : '');
                const minRoundLabel = { preliminary: '예선', semifinal: '준결승', final: '결승' }[minor.round] || minor.round;
                const majRoundLabel = { preliminary: '예선', semifinal: '준결승', final: '결승' }[majority.round] || majority.round;

                // 소수 그룹의 선수를 다수 그룹으로 이동
                for (const entry of minorGroup.entries) {
                    majorGroup.entries.push(entry);
                }
                // 소수 그룹 제거
                eventGroups.delete(minor.eventKey);

                const names = minorGroup.entries.map(e => e.name).join(', ');
                mergeWarnings.push(
                    `${gLabel} ${evName}: ${names} (${minor.count}명)이 '${minRoundLabel}'로 되어있으나 ` +
                    `다수(${majority.count}명)가 '${majRoundLabel}'이므로 '${majRoundLabel}'로 병합했습니다.`
                );
                console.log(`[조편성 라운드 병합] ${gLabel} ${evName}: ${minRoundLabel}(${minor.count}명) → ${majRoundLabel}(${majority.count}명)으로 병합 [${names}]`);
            }
        }

        if (_fedDaily) {
            mergeWarnings.unshift(`연맹 데일리 ${pdfDaily ? 'PDF(' + pdfDaily.pages + '쪽)를' : '양식을'} 자동 변환했습니다: ${_fedDaily.eventCount}개 종목 · ${_fedDaily.rowCount}행` + (pdfDaily ? ' — PDF 는 칸이 붙어 나와 등록 명단과 대조해 끊었습니다. 아래 \'확인 필요\' 항목이 있으면 꼭 확인하세요.' : ''), ..._fedDaily.notes.map(n => '[데일리] ' + n));
        }
        return { eventGroups, totalRows: dataRows.length, sheetName, mergeWarnings, sourceFormat: pdfDaily ? 'federation_daily_pdf' : _fedDaily ? 'federation_daily' : 'table' };
    }

    // PREVIEW API — Compare Excel data with DB, show changes
    app.post('/api/heat-assignment/preview', upload.single('file'), async (req, res) => {
        if (!isAdminKey(req.body.admin_key || req.headers['x-admin-key'])) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        if (!req.file) return res.status(400).json({ error: '파일이 필요합니다.' });
        const competition_id = parseInt(req.body.competition_id);
        if (!competition_id) return res.status(400).json({ error: 'competition_id 필요' });

        try {
            const _roster = await db.all('SELECT name, bib_number, team, gender FROM athlete WHERE competition_id=?', competition_id);
            const { eventGroups, totalRows, sheetName, mergeWarnings, sourceFormat } = await loadHeatAssignmentUpload(req.file, _roster);
        
            const preview = [];
        
            for (const [eventKey, group] of eventGroups) {
                const { gender, eventName, division, displayName, round, entries } = group;

                // 부(division) 인식 종목 조회 (apply 와 동일 헬퍼)
                let dbEvent = await findHeatAssignmentEvent(competition_id, group);
                // Fuzzy fallback: 공백 제거 후 displayName LIKE 매칭 (예: "10K 국제 남자부" → "10K국제남자부")
                if (!dbEvent && gender && gender !== '?') {
                    const stripped = displayName.replace(/\s+/g, '%');
                    dbEvent = await db.get("SELECT * FROM event WHERE competition_id=? AND REPLACE(REPLACE(name,' ',''),' ','') = ? AND gender=?", competition_id, displayName.replace(/\s+/g, ''), gender);
                    if (!dbEvent) {
                        dbEvent = await db.get("SELECT * FROM event WHERE competition_id=? AND name LIKE ? AND gender=?", competition_id, `%${stripped}%`, gender);
                    }
                }

                if (!dbEvent) {
                    const genderLabel0 = gender === 'M' ? '남' : gender === 'F' ? '여' : '혼성';
                    // 조합경기 세부종목([10종]/[7종])은 자동생성 제외 → 기존처럼 not_found
                    const isCombinedSub = /^\[(10종|7종)\]/.test(eventName);
                    if (isCombinedSub) {
                        let suggestions = [];
                        if (gender && gender !== '?') {
                            const sugRows = await db.all('SELECT id, name, round_type FROM event WHERE competition_id=? AND gender=? AND parent_event_id IS NULL ORDER BY name', competition_id, gender);
                            suggestions = sugRows.map(e => ({ id: e.id, name: e.name, round: e.round_type }));
                        }
                        preview.push({
                            eventKey, eventName: `${genderLabel0} ${displayName}`, gender, round,
                            status: 'not_found',
                            message: `종목을 찾을 수 없습니다(조합경기 세부종목은 자동생성 제외): ${genderLabel0} ${displayName}`,
                            excelEntries: entries.length, dbEntries: 0, hasResults: false, changes: [], suggestions, canAutoCreate: false
                        });
                        continue;
                    }
                    // 자동생성 예정 — 생성될 종목 정보 표시
                    const cat = inferHeatEventCategory(eventName);
                    const rt = computeHeatRoundType(cat, eventName, round);
                    const roundLabel0 = rt === 'preliminary' ? '예선' : rt === 'semifinal' ? '준결승' : '결승';
                    preview.push({
                        eventKey, eventName: `${genderLabel0} ${displayName}`, gender, round,
                        status: 'will_create',
                        message: `종목 자동생성: ${genderLabel0} ${displayName} (${cat}, ${roundLabel0})`,
                        excelEntries: entries.length,
                        dbEntries: 0,
                        hasResults: false,
                        changes: entries.map(e => ({ type: 'added', name: e.name, team: e.team })),
                        willCreate: { name: displayName, category: cat, round: rt, division: division || '' },
                        canAutoCreate: true
                    });
                    continue;
                }

                // Get current DB heats + entries for this event
                const dbHeats = await db.all('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number', dbEvent.id);
                const dbHeatEntries = [];
                for (const h of dbHeats) {
                    const hEntries = await db.all(`
                        SELECT he.id, he.heat_id, he.lane_number, he.event_entry_id, he.sub_group,
                               a.name, a.bib_number, a.team, a.id as athlete_id
                        FROM heat_entry he
                        JOIN event_entry ee ON ee.id = he.event_entry_id
                        JOIN athlete a ON a.id = ee.athlete_id
                        WHERE he.heat_id = ?
                        ORDER BY he.lane_number
                    `, h.id);
                    dbHeatEntries.push({ heat: h, entries: hEntries });
                }

                // Check if results exist for this event
                let resultCount = 0;
                let heightAttemptCount = 0;
                for (const h of dbHeats) {
                    const rRow = await db.get('SELECT COUNT(*) as c FROM result WHERE heat_id=?', h.id);
                    resultCount += (rRow && rRow.c) || 0;
                    const haRow = await db.get('SELECT COUNT(*) as c FROM height_attempt WHERE heat_id=?', h.id);
                    heightAttemptCount += (haRow && haRow.c) || 0;
                }
                const hasResults = resultCount > 0 || heightAttemptCount > 0;

                // Build flat DB state for comparison: use Set of full key (handles duplicate lanes in field events)
                const dbFullKeys = new Set();
                for (const hd of dbHeatEntries) {
                    for (const e of hd.entries) {
                        dbFullKeys.add(`${hd.heat.heat_number}|${e.lane_number}|${e.sub_group || ''}|${e.name}|${e.team}`);
                    }
                }

                // Keep Excel original lane numbers (e.g., A:1-18, B:19-26) — no renumbering

                // Build flat Excel state
                const excelFullKeys = new Set();
                for (const e of entries) {
                    excelFullKeys.add(`${e.heat}|${e.lane || 0}|${e.group || ''}|${e.name}|${e.team}`);
                }

                // Compare: detect changes
                const changes = [];
                let isIdentical = true;

                // Check if heats/athletes differ
                const dbAthleteSet = new Set();
                for (const hd of dbHeatEntries) {
                    for (const e of hd.entries) {
                        dbAthleteSet.add(`${e.name}|${e.team}`);
                    }
                }
                const excelAthleteSet = new Set();
                for (const e of entries) {
                    excelAthleteSet.add(`${e.name}|${e.team}`);
                }

                // Athletes added (in Excel but not in DB)
                for (const ea of excelAthleteSet) {
                    if (!dbAthleteSet.has(ea)) {
                        isIdentical = false;
                        const [name, team] = ea.split('|');
                        changes.push({ type: 'added', name, team });
                    }
                }

                // Athletes removed (in DB but not in Excel)
                for (const da of dbAthleteSet) {
                    if (!excelAthleteSet.has(da)) {
                        isIdentical = false;
                        const [name, team] = da.split('|');
                        changes.push({ type: 'removed', name, team });
                    }
                }

                // Heat count changed
                const excelHeatNums = new Set(entries.map(e => e.heat));
                if (excelHeatNums.size !== dbHeats.length) {
                    isIdentical = false;
                    changes.push({ type: 'heat_count', from: dbHeats.length, to: excelHeatNums.size });
                }

                // Lane reassignment check (if same athletes but different lanes/heats)
                if (changes.length === 0) {
                    if (dbFullKeys.size !== excelFullKeys.size) {
                        isIdentical = false;
                        changes.push({ type: 'lane_change', detail: `레인/순서 변경됨` });
                    } else {
                        for (const key of excelFullKeys) {
                            if (!dbFullKeys.has(key)) {
                                isIdentical = false;
                                changes.push({ type: 'lane_change', detail: `레인/순서 변경됨` });
                                break;
                            }
                        }
                    }
                }

                const genderLabel = gender === 'M' ? '남' : gender === 'F' ? '여' : '혼성';
                const roundLabel = round === 'preliminary' ? '예선' : round === 'semifinal' ? '준결승' : '결승';
                const _rL = r => ({ preliminary: '예선', semifinal: '준결승', final: '결승' }[r] || r);

                // 라운드 동기화 예고 (apply 와 같은 조건: 트랙·릴레이·도로, 기록 없음, 같은 라운드 별도 종목 없음)
                let roundChange = null;
                if (!dbEvent.parent_event_id && ['track', 'relay', 'road'].includes(dbEvent.category)
                    && ['preliminary', 'semifinal', 'final'].includes(round) && dbEvent.round_type !== round && !hasResults) {
                    const sibling = await db.get('SELECT id FROM event WHERE competition_id=? AND name=? AND gender=? AND round_type=? AND parent_event_id IS NULL AND id!=?', competition_id, dbEvent.name, dbEvent.gender, round, dbEvent.id);
                    if (!sibling) { roundChange = { from: dbEvent.round_type, to: round }; isIdentical = false; changes.push({ type: 'round', from: dbEvent.round_type, to: round }); }
                }

                preview.push({
                    eventKey,
                    eventName: `${genderLabel} ${displayName}`,
                    eventId: dbEvent.id,
                    gender, round,
                    roundChange,
                    status: isIdentical ? 'unchanged' : (hasResults ? 'has_results' : 'changed'),
                    message: isIdentical
                        ? '변경없음 (스킵)'
                        : hasResults
                            ? `기록이 있습니다 (${resultCount + heightAttemptCount}건). 변경 시 기록이 초기화됩니다.`
                            : (roundChange ? `변경 적용 가능 · 라운드 ${_rL(roundChange.from)}→${_rL(roundChange.to)}` : '변경 적용 가능'),
                    excelEntries: entries.length,
                    dbEntries: dbHeatEntries.reduce((sum, hd) => sum + hd.entries.length, 0),
                    hasResults,
                    resultCount: resultCount + heightAttemptCount,
                    changes,
                    excelHeats: excelHeatNums.size
                });
            }

            // Sort: changed first, then has_results, then unchanged, then not_found
            const statusOrder = { changed: 0, has_results: 1, unchanged: 2, not_found: 3 };
            preview.sort((a, b) => (statusOrder[a.status] || 9) - (statusOrder[b.status] || 9));

            res.json({
                success: true,
                sheetName,
                totalRows,
                eventCount: eventGroups.size,
                preview,
                mergeWarnings: mergeWarnings || [],
                sourceFormat
            });
        } catch (err) {
            console.error('[Heat Assignment Preview Error]', err);
            res.status(err.userFacing ? 400 : 500).json({ error: err.userFacing ? err.message : '조편성 미리보기 오류: ' + err.message });
        }
    });

    // /api/heat-assignment/create-events removed — was never called from any client.
    // The /api/heat-assignment/apply route now creates missing events inline as part of its transaction.

    // APPLY API — Actually update heats based on Excel
    app.post('/api/heat-assignment/apply', upload.single('file'), async (req, res) => {
        if (!isAdminKey(req.body.admin_key || req.headers['x-admin-key'])) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        if (!req.file) return res.status(400).json({ error: '파일이 필요합니다.' });
        const competition_id = parseInt(req.body.competition_id);
        if (!competition_id) return res.status(400).json({ error: 'competition_id 필요' });

        // forceEventIds: comma-separated event IDs to force update even if results exist
        const forceEventIds = new Set(
            (req.body.force_event_ids || '').split(',').map(s => parseInt(s.trim())).filter(n => n > 0)
        );

        try {
            // Validate competition exists
            const comp = await db.get('SELECT id FROM competition WHERE id=?', competition_id);
            if (!comp) {
                return res.status(400).json({ success: false, error: `대회를 찾을 수 없습니다 (ID: ${competition_id})` });
            }

            const _roster = await db.all('SELECT name, bib_number, team, gender FROM athlete WHERE competition_id=?', competition_id);
            const { eventGroups, mergeWarnings } = await loadHeatAssignmentUpload(req.file, _roster);
            const stats = { updated: 0, skipped: 0, skippedUnchanged: 0, skippedHasResults: 0, notFound: 0, athletesAdded: 0, entriesCreated: 0, eventsCreated: 0 };
            let roundChangedAny = false;

            await db.transaction(async () => {
                // Cache all athletes for this competition by name+team
                const athleteCache = new Map();
                (await db.all('SELECT * FROM athlete WHERE competition_id=?', competition_id))
                    .forEach(a => {
                        athleteCache.set(`${a.name}|${a.team}|${a.gender}`, a);
                        // Also index by name+team (without gender) for flexible matching
                        if (!athleteCache.has(`${a.name}|${a.team}`)) {
                            athleteCache.set(`${a.name}|${a.team}`, a);
                        }
                    });
            
                // (PG 호환: sync prepare 제거. 아래 루프에서 await db.run 사용.)

                // Build scoreboard_key: look up federation gender labels for this competition
                const comp = await db.get('SELECT * FROM competition WHERE id=?', competition_id);
                let _sbLabelM = '', _sbLabelF = '', _sbLabelX = '';
                if (comp && comp.federation) {
                    const fed = await db.get('SELECT * FROM federation_list WHERE code=?', comp.federation);
                    if (fed) {
                        _sbLabelM = fed.gender_label_m || '';
                        _sbLabelF = fed.gender_label_f || '';
                        _sbLabelX = fed.gender_label_x || '';
                    }
                }
                function buildScoreboardKey(gender, eventName, roundType, heatNum, totalHeats) {
                    // 연맹 성별 라벨이 설정돼 있으면 사용, 없으면 기본 라벨(남자/여자/혼성)로 폴백 → 키가 항상 생성됨
                    // (부는 eventName(displayName)에 이미 포함되므로 키에 자연히 반영됨)
                    const gLabel = (gender === 'M' ? _sbLabelM : gender === 'F' ? _sbLabelF : _sbLabelX)
                        || ({ M: '남자', F: '여자', X: '혼성' }[gender] || '');
                    if (!gLabel) return null; // 성별 자체가 불명일 때만 skip
                    const rLabel = { preliminary: '예선', semifinal: '준결승', final: '결승' }[roundType] || roundType;
                    // 결승이 1조뿐이면 "조" 생략 (예: "남자실업부 100m 결승")
                    if (roundType === 'final' && totalHeats === 1) {
                        return `${gLabel} ${eventName} ${rLabel}`;
                    }
                    return `${gLabel} ${eventName} ${rLabel} ${heatNum}조`;
                }
                for (const [eventKey, group] of eventGroups) {
                    const { gender, eventName, division, displayName, round, entries } = group;

                    // Keep Excel original lane numbers — no renumbering
                    // Excel has sequential lane numbers across groups (A:1-18, B:19-26) and that's correct

                    // 부(division) 인식 종목 조회 (apply/preview 공유 헬퍼)
                    let dbEvent = await findHeatAssignmentEvent(competition_id, group);

                    // 없으면 종목 자동생성 (부별로 별도 종목) — 한 파일로 종목+선수+조편성 한번에
                    if (!dbEvent) {
                        // 조합경기 세부종목([10종]/[7종])은 부모 연결이 필요 → 자동생성 대상에서 제외(안전), 기존처럼 스킵
                        if (/^\[(10종|7종)\]/.test(eventName)) {
                            stats.notFound++;
                            continue;
                        }
                        const cat = inferHeatEventCategory(eventName);
                        const rt = computeHeatRoundType(cat, eventName, round);
                        const evGender = gender && gender !== '?' ? gender : 'X';
                        try {
                            const ins = await db.run('INSERT INTO event (competition_id,name,category,gender,round_type,division,round_status) VALUES (?,?,?,?,?,?,?)',
                                competition_id, displayName, cat, evGender, rt, division || '', 'heats_generated');
                            dbEvent = { id: ins.lastInsertRowid, name: displayName, category: cat, gender: evGender, round_type: rt, division: division || '', parent_event_id: null };
                        } catch (insErr) {
                            // UNIQUE 충돌(동시 업로드 등) → 재조회 재사용
                            dbEvent = await db.get('SELECT * FROM event WHERE competition_id=? AND name=? AND gender=? AND parent_event_id IS NULL', competition_id, displayName, evGender);
                            if (!dbEvent) throw insErr;
                        }
                        stats.eventsCreated = (stats.eventsCreated || 0) + 1;
                    }

                    // ── 라운드 동기화 (2026-09) ──
                    //   사전소집 후 예선이 폐지돼 결승 직행이 되거나(1500m 36명→15명), 반대로 릴레이에 예선이 생기는 경우
                    //   파일의 라운드와 종목 round_type 이 어긋난다. findHeatAssignmentEvent 는 같은 라운드 종목이 없으면
                    //   다른 라운드 종목을 잡아 조만 바꾸고 round_type 은 그대로 두던 문제 → 기록이 없고 해당 라운드의
                    //   별도 종목이 없을 때만 종목 라운드를 파일에 맞춘다. (트랙·릴레이·도로만, 필드/종합/세부종목 제외)
                    if (!dbEvent.parent_event_id && ['track', 'relay', 'road'].includes(dbEvent.category)
                        && ['preliminary', 'semifinal', 'final'].includes(round) && dbEvent.round_type !== round) {
                        const rcRow = await db.get('SELECT COUNT(*) AS c FROM result r JOIN heat h ON h.id=r.heat_id WHERE h.event_id=?', dbEvent.id);
                        const sibling = await db.get('SELECT id FROM event WHERE competition_id=? AND name=? AND gender=? AND round_type=? AND parent_event_id IS NULL AND id!=?', competition_id, dbEvent.name, dbEvent.gender, round, dbEvent.id);
                        if (((rcRow && rcRow.c) || 0) === 0 && !sibling) {
                            await db.run('UPDATE event SET round_type=? WHERE id=?', round, dbEvent.id);
                            stats.roundChanged = (stats.roundChanged || 0) + 1;
                            roundChangedAny = true;
                            dbEvent.round_type = round;
                        }
                    }

                    // Get current DB state
                    const dbHeats = await db.all('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number', dbEvent.id);
                
                    // Check if data is identical (quick comparison: same athlete count and names)
                    const dbAthleteNames = new Set();
                    for (const h of dbHeats) {
                        const hEntries = await db.all(`
                            SELECT a.name, a.team FROM heat_entry he
                            JOIN event_entry ee ON ee.id = he.event_entry_id
                            JOIN athlete a ON a.id = ee.athlete_id
                            WHERE he.heat_id = ?
                        `, h.id);
                        hEntries.forEach(e => dbAthleteNames.add(`${e.name}|${e.team}`));
                    }
                    const excelAthleteNames = new Set(entries.map(e => `${e.name}|${e.team}`));
                
                    // Deep comparison: check if heats, lanes, and athletes are all the same
                    let isIdentical = dbAthleteNames.size === excelAthleteNames.size;
                    if (isIdentical) {
                        for (const n of excelAthleteNames) {
                            if (!dbAthleteNames.has(n)) { isIdentical = false; break; }
                        }
                    }
                    if (isIdentical) {
                        // Also check lane assignments (use Set of full keys to handle duplicate lanes in field events)
                        const dbStateSet = new Set();
                        for (const h of dbHeats) {
                            const hEntries = await db.all(`
                                SELECT he.lane_number, he.sub_group, a.name, a.team
                                FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id
                                JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=?
                            `, h.id);
                            hEntries.forEach(e => dbStateSet.add(`${h.heat_number}|${e.lane_number}|${e.sub_group || ''}|${e.name}|${e.team}`));
                        }
                        const excelStateSet = new Set();
                        for (const e of entries) {
                            excelStateSet.add(`${e.heat}|${e.lane || 0}|${e.group || ''}|${e.name}|${e.team}`);
                        }
                        if (dbStateSet.size !== excelStateSet.size) {
                            isIdentical = false;
                        } else {
                            for (const key of excelStateSet) {
                                if (!dbStateSet.has(key)) { isIdentical = false; break; }
                            }
                        }
                    }

                    if (isIdentical) {
                        stats.skippedUnchanged++;
                        stats.skipped++;
                        continue;
                    }

                    // Check if results exist
                    let resultCount = 0;
                    for (const h of dbHeats) {
                        const rRow = await db.get('SELECT COUNT(*) as c FROM result WHERE heat_id=?', h.id);
                        resultCount += (rRow && rRow.c) || 0;
                        const haRow = await db.get('SELECT COUNT(*) as c FROM height_attempt WHERE heat_id=?', h.id);
                        resultCount += (haRow && haRow.c) || 0;
                    }

                    if (resultCount > 0 && !forceEventIds.has(dbEvent.id)) {
                        stats.skippedHasResults++;
                        stats.skipped++;
                        continue;
                    }

                    // === APPLY CHANGES ===
                
                    // 1. Delete existing heats, heat_entries, results for this event
                    for (const h of dbHeats) {
                        await db.run('DELETE FROM result WHERE heat_id=?', h.id);
                        await db.run('DELETE FROM height_attempt WHERE heat_id=?', h.id);
                        await db.run('DELETE FROM heat_entry WHERE heat_id=?', h.id);
                    }
                    await db.run('DELETE FROM heat WHERE event_id=?', dbEvent.id);

                    // 2. For relay events: also clear old event_entries (team "athletes")
                    const isRelay = dbEvent.category === 'relay';

                    // 3. Group entries by heat number
                    const heatGroups = new Map();
                    for (const e of entries) {
                        if (!heatGroups.has(e.heat)) heatGroups.set(e.heat, []);
                        heatGroups.get(e.heat).push(e);
                    }

                    // 3.5 Re-number heats sequentially (1,2,3...) if Excel has gaps or wrong numbers
                    // e.g., Excel says heat=3 but only 1 heat exists → renumber to 1
                    const sortedHeatKeys = [...heatGroups.keys()].sort((a, b) => a - b);
                    const heatRenumberMap = new Map();
                    sortedHeatKeys.forEach((origNum, idx) => {
                        heatRenumberMap.set(origNum, idx + 1);
                    });

                    // 4. Create heats and heat entries
                    for (const [origHeatNum, heatEntries] of [...heatGroups].sort((a, b) => a[0] - b[0])) {
                        const heatNum = heatRenumberMap.get(origHeatNum);
                        const sbKey = buildScoreboardKey(gender, displayName, round, heatNum, heatGroups.size);
                        const heatRow = await db.run('INSERT INTO heat (event_id,heat_number,scoreboard_key) VALUES (?,?,?)', dbEvent.id, heatNum, sbKey);
                        const heatId = heatRow.lastInsertRowid;

                        for (const entry of heatEntries) {
                            // Find or create athlete
                            let athlete = null;
                            const effGender = gender === 'X' ? 'M' : gender;

                            if (isRelay) {
                                // Relay: entry.name is team name
                                athlete = athleteCache.get(`${entry.name}|${entry.name}|${effGender}`)
                                    || athleteCache.get(`${entry.name}|${entry.team}|${effGender}`)
                                    || athleteCache.get(`${entry.name}|${entry.name}`);
                            } else {
                                // Individual: find by name+team+gender, then name+team
                                athlete = athleteCache.get(`${entry.name}|${entry.team}|${effGender}`)
                                    || athleteCache.get(`${entry.name}|${entry.team}`);
                            
                                // Also try finding by bib number if provided
                                // IMPORTANT: Only match if name also matches to prevent wrong athlete assignment
                                if (!athlete && entry.bib) {
                                    const byBib = await db.get('SELECT * FROM athlete WHERE competition_id=? AND bib_number=?', competition_id, String(entry.bib));
                                    if (byBib && byBib.name === entry.name) {
                                        athlete = byBib;
                                    }
                                    // If bib matches but name differs, it's a different athlete — do NOT use
                                }
                            }

                            if (!athlete) {
                                // Create new athlete — bib only if provided and not already taken
                                let newBib = entry.bib ? String(entry.bib) : null;
                                if (newBib) {
                                    const bibTaken = await db.get('SELECT id FROM athlete WHERE competition_id=? AND bib_number=? AND gender=?', competition_id, newBib, effGender || 'M');
                                    if (bibTaken) newBib = null; // bib already used by another athlete of same gender, leave NULL
                                }
                                // Do NOT auto-assign bib — keep NULL if not provided
                                const bc = ''; // barcode managed by user
                                const newGender = isRelay ? (effGender || 'M') : (effGender || 'M');
                                const r = await db.run('INSERT INTO athlete (competition_id,name,bib_number,team,barcode,gender) VALUES (?,?,?,?,?,?)', competition_id, entry.name, newBib, entry.team || entry.name, bc, newGender);
                                athlete = { id: r.lastInsertRowid, name: entry.name, bib_number: newBib, team: entry.team || entry.name, gender: newGender };
                                athleteCache.set(`${entry.name}|${entry.team || entry.name}|${newGender}`, athlete);
                                athleteCache.set(`${entry.name}|${entry.team || entry.name}`, athlete);
                                stats.athletesAdded++;
                            } else if (entry.bib && !athlete.bib_number) {
                                // Athlete exists but has no bib — update from heat assignment data
                                const bibStr = String(entry.bib);
                                const bibTaken = await db.get('SELECT id FROM athlete WHERE competition_id=? AND bib_number=? AND gender=? AND id!=?', competition_id, bibStr, athlete.gender || effGender || 'M', athlete.id);
                                if (!bibTaken) {
                                    await db.run('UPDATE athlete SET bib_number=? WHERE id=? AND bib_number IS NULL', bibStr, athlete.id);
                                    athlete.bib_number = bibStr;
                                }
                            }

                            // Ensure event_entry exists
                            const entryResult = await db.run("INSERT OR IGNORE INTO event_entry (event_id,athlete_id,status) VALUES (?,?,'registered')", dbEvent.id, athlete.id);
                            let eventEntryId = entryResult.changes > 0 ? entryResult.lastInsertRowid : null;
                            if (!eventEntryId) {
                                const existing = await db.get('SELECT id FROM event_entry WHERE event_id=? AND athlete_id=?', dbEvent.id, athlete.id);
                                eventEntryId = existing ? existing.id : null;
                            }

                            if (eventEntryId) {
                                // Prevent UNIQUE constraint violation: skip if this event_entry is already in this heat
                                const alreadyInHeat = await db.get('SELECT id FROM heat_entry WHERE heat_id=? AND event_entry_id=?', heatId, eventEntryId);
                                if (!alreadyInHeat) {
                                    await db.run('INSERT INTO heat_entry (heat_id,event_entry_id,lane_number,sub_group) VALUES (?,?,?,?)', heatId, eventEntryId, entry.lane, entry.group || null);
                                    stats.entriesCreated++;
                                }
                            }
                        }
                    }

                    // 5. COMBINED (10종/7종) SUB-EVENT FIX:
                    //    When applying heat assignment to a combined sub-event (e.g., [7종] 100mH),
                    //    the Excel may only contain athletes competing on a specific day.
                    //    But ALL parent event athletes must be in each sub-event's heat_entry
                    //    for call-room and result entry to work properly.
                    //    → After processing Excel entries, add missing parent athletes to the heat.
                    if (dbEvent.parent_event_id) {
                        const parentEvt = await db.get('SELECT * FROM event WHERE id=?', dbEvent.parent_event_id);
                        if (parentEvt && parentEvt.category === 'combined') {
                            // 보충 기준 = 부모 종목의 "스타트리스트"(heat_entry). 부모에 조편성이 있으면 거기 있는 선수만 보충하고,
                            //   출전 등록(event_entry)만 남은 불참 선수는 세부종목 조에 다시 넣지 않는다 (2026-09: 데일리 조편성으로
                            //   10종 7명→4명이 됐는데 불참 3명이 세부종목마다 재추가되던 문제). 부모에 조가 없으면 종전대로 전체 등록자.
                            let parentEntries = await db.all(`SELECT DISTINCT ee.athlete_id, a.name, a.team FROM event_entry ee
                                JOIN athlete a ON ee.athlete_id=a.id
                                JOIN heat_entry he ON he.event_entry_id=ee.id JOIN heat h ON h.id=he.heat_id AND h.event_id=ee.event_id
                                WHERE ee.event_id=?`, dbEvent.parent_event_id);
                            if (parentEntries.length === 0) {
                                parentEntries = await db.all('SELECT ee.athlete_id, a.name, a.team FROM event_entry ee JOIN athlete a ON ee.athlete_id=a.id WHERE ee.event_id=?', dbEvent.parent_event_id);
                            }

                            // Get currently assigned heat(s) for this sub-event
                            const currentHeats = await db.all('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number', dbEvent.id);
                            // Use the first heat (combined sub-events typically have 1 heat)
                            let targetHeatId = currentHeats.length > 0 ? currentHeats[0].id : null;
                            if (!targetHeatId) {
                                // No heat exists yet → create one
                                const sbKey = buildScoreboardKey(gender, dbEvent.name, dbEvent.round_type || round, 1, 1);
                                const hRow = await db.run('INSERT INTO heat (event_id,heat_number,scoreboard_key) VALUES (?,?,?)', dbEvent.id, 1, sbKey);
                                targetHeatId = hRow.lastInsertRowid;
                            }
                        
                            // Find max lane number currently in this heat
                            const maxLane = await db.get('SELECT MAX(lane_number) as m FROM heat_entry WHERE heat_id=?', targetHeatId);
                            let nextLane = (maxLane && maxLane.m) ? maxLane.m + 1 : 1;
                        
                            for (const pEntry of parentEntries) {
                                // Ensure event_entry exists in sub-event
                                const eeResult = await db.run("INSERT OR IGNORE INTO event_entry (event_id,athlete_id,status) VALUES (?,?,'registered')", dbEvent.id, pEntry.athlete_id);
                                let eeId = eeResult.changes > 0 ? eeResult.lastInsertRowid : null;
                                if (!eeId) {
                                    const existing = await db.get('SELECT id FROM event_entry WHERE event_id=? AND athlete_id=?', dbEvent.id, pEntry.athlete_id);
                                    eeId = existing ? existing.id : null;
                                }
                                if (!eeId) continue;
                            
                                // Check if already in any heat for this sub-event
                                const alreadyAssigned = await db.get('SELECT he.id FROM heat_entry he JOIN heat h ON he.heat_id=h.id WHERE h.event_id=? AND he.event_entry_id=?', dbEvent.id, eeId);
                            
                                if (!alreadyAssigned) {
                                    // Not in heat → add to the target heat with next available lane
                                    await db.run('INSERT INTO heat_entry (heat_id,event_entry_id,lane_number,sub_group) VALUES (?,?,?,?)', targetHeatId, eeId, nextLane++, null);
                                    stats.entriesCreated++;
                                }
                            }
                        }
                    }

                    // 5b. Handle athletes no longer in this event's heats
                    //    We do NOT delete event_entry rows — they may be referenced by
                    //    combined_score, qualification_selection, relay_member, or sub-events.
                    //    The athlete is simply not in any heat anymore (effectively DNS).
                    //    This is safe because heat_entry rows were already deleted above.

                    // 6. RELAY: Auto-populate relay_member from team roster
                    //    For each relay team entry, find athletes belonging to the same team
                    //    and add them as relay_member if not already present.
                    if (isRelay) {
                        const allEventEntries = await db.all('SELECT ee.id, ee.athlete_id, a.name, a.team FROM event_entry ee JOIN athlete a ON ee.athlete_id=a.id WHERE ee.event_id=?', dbEvent.id);
                    
                        for (const teamEntry of allEventEntries) {
                            // "Team athlete" records: name === team (e.g., name='광주광역시청', team='광주광역시청')
                            if (teamEntry.name !== teamEntry.team) continue;
                        
                            // Check if this team entry already has relay members
                            const existingMembersRow = await db.get('SELECT COUNT(*) AS c FROM relay_member WHERE event_entry_id=?', teamEntry.id);
                            const existingMembers = (existingMembersRow && existingMembersRow.c) || 0;
                            if (existingMembers > 0) continue; // Already has members, skip
                        
                            // Find individual athletes from the same team
                            const effGender = gender === 'X' ? null : gender; // For mixed, accept any gender
                            let teamAthletes;
                            if (effGender) {
                                teamAthletes = await db.all('SELECT id, name, team FROM athlete WHERE competition_id=? AND team=? AND gender=? AND name!=team ORDER BY id', competition_id, teamEntry.team, effGender);
                            } else {
                                teamAthletes = await db.all('SELECT id, name, team FROM athlete WHERE competition_id=? AND team=? AND name!=team ORDER BY id', competition_id, teamEntry.team);
                            }
                        
                            // Add each athlete as relay member
                            let legOrder = 1;
                            for (const ath of teamAthletes) {
                                await db.run('INSERT OR IGNORE INTO relay_member (event_entry_id, athlete_id, leg_order) VALUES (?,?,?)', teamEntry.id, ath.id, legOrder++);
                            }
                            if (teamAthletes.length > 0) {
                                stats.relayMembersAdded = (stats.relayMembersAdded || 0) + teamAthletes.length;
                            }
                        }
                    }

                    stats.updated++;
                }
            })();

            // 라운드가 바뀐 종목이 있으면 시간표 "결승"/"예선" 행이 새 라운드에 붙도록 재매칭
            if (roundChangedAny) {
                try { await autoLinkDisplayTimetable(competition_id); } catch (autoErr) { console.warn('[autoLink after heat-assignment round sync] ', autoErr.message); }
            }

            opLog(`조편성 업로드: ${stats.updated}개 종목 변경, ${stats.eventsCreated || 0}개 종목 생성, ${stats.skippedUnchanged}개 스킵(변경없음), ${stats.skippedHasResults}개 스킵(기록있음)${stats.relayMembersAdded ? ', 릴레이 멤버 ' + stats.relayMembersAdded + '명 자동등록' : ''}${stats.roundChanged ? ', 라운드 변경 ' + stats.roundChanged + '개' : ''}`, 'import', 'admin', competition_id);
            res.json({ success: true, message: '조편성 적용 완료', stats, mergeWarnings: mergeWarnings || [] });
        } catch (err) {
            console.error('[Heat Assignment Apply Error]', err);
            res.status(500).json({ error: '조편성 적용 오류: ' + err.message });
        }
    });
};
