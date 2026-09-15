'use strict';
/**
 * lib/routes/field_card_import.js — 필드 수기 기록카드 가져오기
 *
 * 심판이 손으로 쓴 필드 기록카드(투척·수평도약·수직도약)를 사진(서버 AI 전사) 또는 xlsx 로 올리면
 * 종목·조·선수를 매칭하고 시기별 기록을 저장한다.
 * 파싱/계산/검산은 lib/fieldCardImport.js, 사진 전사·카드 JSON 변환은 lib/fieldCardVision.js.
 *
 * 두 가지 사용 모드
 *   - 일괄 모드 (관리자 페이지): heat_id 없이 파일을 올리면 종별·세부종목·라운드·조를 읽어 조를 찾는다. 관리자 키 필수.
 *   - 조 고정 모드 (기록 입력창): heat_id 를 주면 그 조로 고정하고 선수만 배번 → 순서 → 성명 순으로 매칭한다.
 *     관리자 키 또는 운영키. 대회 종료 잠금은 requireAdminAfterCompEnd 로 관리자만 통과.
 *
 * 외부 의존성(deps): db, isAdminKey, opLog, broadcastSSE, audit, upload,
 *   recx { normBib, divToken, genderOf, round }, isOperationKey(선택), requireAdminAfterCompEnd(선택),
 *   runRecordCompareHook(선택, results.js 의 신기록 감지 훅), transcribe(선택, 테스트 주입)
 *
 * 라우트:
 *   GET  /api/field-card/template?kind=throw|horizontal|vertical   양식 xlsx
 *   GET  /api/field-card/prompt                                     AI 전사용 프롬프트 (text/plain)
 *   POST /api/field-card/preview       multipart file [+ heat_id]  매칭·계산·검산 미리보기 (DB 변경 없음)
 *   POST /api/field-card/transcribe    multipart images[] [+ heat_id, hint]  사진 → 서버 AI 전사 → 미리보기 + xlsx (+ 조 고정이면 편집용 card)
 *   POST /api/field-card/analyze-json  JSON { heat_id, card }       편집한 카드 JSON 재매칭·재검산 (DB 변경 없음)
 *   POST /api/field-card/import        multipart file [+ heat_id]  저장
 *   POST /api/field-card/import-json   JSON { heat_id, card }       편집한 카드 JSON 저장
 *
 * 저장 규칙 (선수 단위 교체):
 *   - 파일/카드에 기록이 있는 선수만 그 선수의 시기 전체를 다시 씀. 빈 행, 없는 선수, 오류 행은 건드리지 않음.
 *   - 거리: result (attempt_number 1~6, 파울 0, 패스 -1, 풍속은 멀리뛰기·세단뛰기의 유효 시기에만)
 *           기록구분(DNS/DNF/DQ/NM)은 attempt_number NULL 행의 status_code
 *   - 높이: height_attempt (O / X / PASS), 기록구분은 result NULL 행 (record.html 과 동일)
 *   - 카드의 최고기록·순위는 저장하지 않고 계산값과 대조해 경고만 표시
 *   - 유효 시기 저장 후 신기록 감지 훅 호출 (혼성 세부종목이면 종합점수 동기화까지 훅이 처리)
 */
const fs = require('fs');
const fc = require('../fieldCardImport');
const vision = require('../fieldCardVision');

module.exports = function mountFieldCardImportRoutes(app, deps) {
    const { db, isAdminKey, isOperationKey, opLog, broadcastSSE, audit, upload, recx, runRecordCompareHook, requireAdminAfterCompEnd } = deps;
    if (!app || !db || !isAdminKey || !opLog || !broadcastSSE || !audit || !upload || !recx) {
        throw new Error('[field_card_import.js] mount requires { db, isAdminKey, opLog, broadcastSSE, audit, upload, recx }');
    }
    const transcribe = typeof deps.transcribe === 'function' ? deps.transcribe : vision.transcribeCards;   // 테스트 주입용
    const ROUND_L = { preliminary: '예선', semifinal: '준결승', final: '결승' };
    const genderL = (g) => (g === 'M' ? '남자' : g === 'F' ? '여자' : '혼성');
    const cleanupFiles = (files) => { for (const f of files || []) { try { fs.unlinkSync(f.path); } catch (e) {} } };

    // ─────────────────────────────────────────────────────────
    // 인증 / 대상 조
    // ─────────────────────────────────────────────────────────
    function keyOf(req) {
        return (req.body && (req.body.admin_key || req.body.key)) || req.headers['x-admin-key'] || (req.query && req.query.key) || '';
    }
    function roleOf(key) {
        if (key && isAdminKey(key)) return 'admin';
        if (key && typeof isOperationKey === 'function' && isOperationKey(key)) return 'operation';
        return null;
    }
    async function resolveFixedHeat(heat_id) {
        const heat = await db.get('SELECT * FROM heat WHERE id=?', heat_id);
        if (!heat) return null;
        const event = await db.get('SELECT * FROM event WHERE id=?', heat.event_id);
        if (!event) return null;
        return { event, heat };
    }
    /**
     * 공통 요청 검사. 성공 시 { key, role, competition_id, fixed } 반환, 실패 시 응답 후 null.
     *  - heat_id 없음(일괄): 관리자 키 필수
     *  - heat_id 있음(조 고정): 관리자 또는 운영키. 저장(write)이고 관리자가 아니면 대회 종료 잠금 검사
     */
    async function guard(req, res, { write = false } = {}) {
        const key = keyOf(req);
        const role = roleOf(key);
        const heat_id = parseInt(req.body && req.body.heat_id) || null;
        if (!role) { res.status(403).json({ error: heat_id ? '관리자 키 또는 운영키가 필요합니다.' : '관리자 키가 필요합니다.' }); return null; }
        if (!heat_id && role !== 'admin') { res.status(403).json({ error: '조를 지정하지 않은 일괄 업로드는 관리자 키가 필요합니다.' }); return null; }
        let fixed = null;
        if (heat_id) {
            fixed = await resolveFixedHeat(heat_id);
            if (!fixed) { res.status(404).json({ error: '조(heat)를 찾을 수 없습니다.' }); return null; }
            if (!String(fixed.event.category || '').startsWith('field')) { res.status(400).json({ error: '필드 종목의 조가 아닙니다.' }); return null; }
        }
        const competition_id = parseInt(req.body && req.body.competition_id) || (fixed ? fixed.event.competition_id : 0);
        if (!competition_id) { res.status(400).json({ error: 'competition_id 필요' }); return null; }
        if (fixed && fixed.event.competition_id !== competition_id) { res.status(400).json({ error: '조가 해당 대회 소속이 아닙니다.' }); return null; }
        if (write && role !== 'admin' && typeof requireAdminAfterCompEnd === 'function') {
            if (await requireAdminAfterCompEnd(competition_id, key, res)) return null;   // 응답은 헬퍼가 함
        }
        return { key, role, competition_id, fixed, heat_id };
    }
    function fixedMeta(fixed) {
        const { event, heat } = fixed;
        return {
            division: `${genderL(event.gender)} ${event.division || ''}`.trim(),
            event: event.name, round: ROUND_L[event.round_type] || '결승', heat: String(heat.heat_number || 1),
            kind: event.category === 'field_height' ? 'height' : 'distance',
            needs_wind: event.category === 'field_distance' && fc.needsWindByName(event.name),
        };
    }

    // ─────────────────────────────────────────────────────────
    // 종목 / 조 해석 (일괄 모드)
    // ─────────────────────────────────────────────────────────
    function dbDivTok(e) {
        if (e.division && String(e.division).trim()) return recx.divToken(e.division);
        const t = recx.divToken(e.name);
        return ['초등', '중등', '고등', '대학', '일반'].includes(t) ? t : '';
    }
    function nameOk(dbName, base) {
        const n = fc.normalizeEventName(dbName).base;
        return !!base && !!n && (n === base || n.startsWith(base) || base.startsWith(n));
    }
    async function resolveGroup(competition_id, g) {
        const { base, combined } = fc.normalizeEventName(g.eventName);
        const gender = recx.genderOf(g.divisionRaw);
        const divTok = recx.divToken(g.divisionRaw);
        const round = recx.round(g.roundRaw);
        let cands = [];
        if (combined) {
            const parents = await db.all("SELECT * FROM event WHERE competition_id=? AND category='combined' AND parent_event_id IS NULL", competition_id);
            for (const p of parents) {
                if (!String(p.name).includes(combined)) continue;
                if (gender && p.gender && p.gender !== gender) continue;
                const subs = await db.all('SELECT * FROM event WHERE parent_event_id=? ORDER BY sort_order, id', p.id);
                for (const s of subs) if (String(s.category || '').startsWith('field') && nameOk(s.name, base)) cands.push(s);
            }
        } else {
            const events = await db.all("SELECT * FROM event WHERE competition_id=? AND parent_event_id IS NULL AND category IN ('field_distance','field_height')", competition_id);
            cands = events.filter(e => (!gender || !e.gender || e.gender === gender) && nameOk(e.name, base));
            const byRound = cands.filter(e => e.round_type === round);
            if (byRound.length) cands = byRound;
            if (cands.length > 1 && divTok) {
                const narrowed = cands.filter(e => { const t = dbDivTok(e); return t === '' || t === divTok; });
                if (narrowed.length) cands = narrowed;
            }
        }
        if (!cands.length) return null;
        const event = cands[0];
        let heat = await db.get('SELECT * FROM heat WHERE event_id=? AND heat_number=?', event.id, g.heatNum);
        if (!heat) {
            const heats = await db.all('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number', event.id);
            if (heats.length === 1) heat = heats[0];
        }
        if (!heat) return null;
        return { event, heat, ambiguous: cands.length > 1 };
    }

    // ─────────────────────────────────────────────────────────
    // 기존 값 (미리보기 diff 용)
    // ─────────────────────────────────────────────────────────
    async function loadExisting(heat_id, kind) {
        const map = new Map();
        const ensure = (id) => { if (!map.has(id)) map.set(id, { attempts: {}, marks: {}, status_code: '' }); return map.get(id); };
        const results = await db.all('SELECT * FROM result WHERE heat_id=? ORDER BY event_entry_id, attempt_number', heat_id);
        for (const r of results) {
            const e = ensure(r.event_entry_id);
            if (r.attempt_number != null) e.attempts[r.attempt_number] = { value: r.distance_meters, wind: r.wind };
            if (r.status_code) e.status_code = r.status_code;
        }
        if (kind === 'height') {
            const has = await db.all('SELECT * FROM height_attempt WHERE heat_id=? ORDER BY event_entry_id, bar_height, attempt_number', heat_id);
            for (const a of has) {
                const e = ensure(a.event_entry_id);
                const k = fc.hk(a.bar_height);
                e.marks[k] = (e.marks[k] || '') + ((a.result_mark === 'PASS' || a.result_mark === '-') ? '-' : a.result_mark);
            }
        }
        return map;
    }
    function isChanged(kind, row, ex) {
        if (!ex) return true;
        if ((ex.status_code || '') !== (row.status.code || '')) return true;
        if (kind === 'distance') {
            for (let n = 1; n <= fc.MAX_ATTEMPTS; n++) {
                const a = row.attempts[n], b = ex.attempts[n];
                if (!a && !b) continue;
                if (!a || !b) return true;
                if (Math.abs(Number(a.value) - Number(b.value)) > 0.005) return true;
                const aw = a.wind == null ? null : Number(a.wind), bw = b.wind == null ? null : Number(b.wind);
                if ((aw == null) !== (bw == null) || (aw != null && Math.abs(aw - bw) > 0.05)) return true;
            }
            return false;
        }
        const keys = new Set([...Object.keys(row.marks), ...Object.keys(ex.marks)]);
        for (const k of keys) if (fc.marksToString(row.marks[k] || []) !== (ex.marks[k] || '')) return true;
        return false;
    }

    function serializeRow(g, r, m, ex, needsWind) {
        const attempts = {};
        for (let n = 1; n <= fc.MAX_ATTEMPTS; n++) {
            const a = r.attempts[n]; if (!a) continue;
            attempts[n] = { kind: a.kind, value: a.value, wind: needsWind ? a.wind : null,
                disp: a.kind === 'valid' ? fc.fmtDist(a.value) : (a.kind === 'foul' ? 'X' : '-') };
        }
        const marks = {};
        for (const k of Object.keys(r.marks)) marks[k] = fc.marksToString(r.marks[k]);
        const hasError = r.issues.some(i => i.level === 'error');
        return {
            where: r.where, row_index: r.rowIndex, order: r.order, bib: r.bib, name: r.name, team: r.team, remark: r.remark,
            attempts, marks,
            computed: { best: r.computed.best, rank: r.computed.rank, bestWind: needsWind ? r.computed.bestWind : null },
            card: { best: r.card.best, bestNM: r.card.bestNM, rank: r.card.rank },
            status: r.status.code || '',
            db: m ? { event_entry_id: m.event_entry_id, name: m.name, bib: m.bib_number, lane: m.lane_number, entry_status: m.entry_status } : null,
            existing: ex ? { attempts: ex.attempts, marks: ex.marks, status_code: ex.status_code } : null,
            changed: m ? isChanged(g.kind, r, ex) : null,
            has_data: !!r.hasData,
            will_import: !!m && !!r.hasData && !hasError,
            issues: r.issues,
            _raw: r,
        };
    }

    /** AI 전사의 '판독 불확실' 셀을 해당 행의 경고로 붙임 (배번 → 순서 → 성명 순 매칭) */
    function applyAnnotations(groups, annotations) {
        for (const an of annotations || []) {
            const base = fc.normalizeEventName(an.event).base;
            const g = groups.find(x => fc.normalizeEventName(x.eventName).base === base && x.heatNum === an.heat)
                   || groups.find(x => fc.normalizeEventName(x.eventName).base === base) || (groups.length === 1 ? groups[0] : null);
            if (!g) continue;
            const nb = fc.normBib(an.bib);
            let row = nb ? g.rows.find(r => fc.normBib(r.bib) === nb) : null;
            if (!row && an.order) row = g.rows.find(r => r.order === an.order);
            if (!row && an.name) { const nn = fc.normName(an.name); row = g.rows.find(r => fc.normName(r.name) === nn); }
            if (!row) continue;
            row.issues.push({ level: 'warn', msg: `AI 판독 불확실: ${an.cells.join(', ')} — 사진과 대조하세요` });
        }
    }

    /**
     * 파일 → 그룹별 매칭/계산/검산 결과. rows[]._raw 는 내부용 (응답 전 strip).
     * opts.annotations: AI 불확실 셀, opts.fixed: { event, heat } 조 고정 (종목 해석 생략)
     */
    async function analyze(competition_id, buffer, opts = {}) {
        const parsed = fc.parseFieldCardWorkbook(buffer);
        parsed.groups.forEach(g => g.rows.forEach((r, i) => { r.rowIndex = i; }));
        if (opts.annotations && opts.annotations.length) applyAnnotations(parsed.groups, opts.annotations);
        if (opts.fixed && parsed.groups.length > 1) {
            const labels = parsed.groups.map(fc.groupLabel).join(' / ');
            throw Object.assign(new Error(`한 조에 저장하려는데 파일에 여러 종목·조가 섞여 있습니다: ${labels}`), { code: 'MIXED_GROUPS' });
        }
        const out = [];
        for (const g of parsed.groups) {
            const label = fc.groupLabel(g);
            const resolved = opts.fixed ? { event: opts.fixed.event, heat: opts.fixed.heat, ambiguous: false } : await resolveGroup(competition_id, g);
            if (!resolved) {
                fc.computeGroup(g, { needsWind: fc.needsWindByName(g.eventName) });
                out.push({ label, kind: g.kind, matchStatus: 'not_found', heatInfo: null, heights: g.heights,
                    issues: [...g.issues, { level: 'error', msg: '매칭되는 종목/조를 찾을 수 없습니다. 종별·세부종목·라운드·조를 확인하세요.' }],
                    rows: g.rows.map(r => serializeRow(g, r, null, null, false)) });
                continue;
            }
            const { event, heat, ambiguous } = resolved;
            const dbKind = event.category === 'field_height' ? 'height' : 'distance';
            const needsWind = dbKind === 'distance' && fc.needsWindByName(event.name);
            fc.computeGroup(g, { needsWind });
            const heatInfo = {
                heat_id: heat.id, event_id: event.id, event_name: event.name, gender: event.gender,
                division: event.division || '', round_type: event.round_type, heat_number: heat.heat_number,
                category: event.category, needs_wind: needsWind, parent_event_id: event.parent_event_id || null,
                competition_id: event.competition_id,
            };
            const issues = [...g.issues];
            if (ambiguous) issues.push({ level: 'warn', msg: '종목 후보가 여러 개입니다 — 매칭된 종목이 맞는지 확인하세요.' });
            if (g.kind !== dbKind) {
                issues.push({ level: 'error', msg: dbKind === 'height' ? '높이 종목인데 거리 양식(1차~6차)으로 작성됨' : '거리 종목인데 높이 양식으로 작성됨' });
                out.push({ label, kind: g.kind, matchStatus: 'kind_mismatch', heatInfo, heights: g.heights, issues,
                    rows: g.rows.map(r => serializeRow(g, r, null, null, false)) });
                continue;
            }
            if (!needsWind && g.windSheet) issues.push({ level: 'info', msg: '풍속이 필요 없는 종목이라 풍속 시트는 무시' });

            const entries = await db.all(`
                SELECT he.lane_number, ee.id AS event_entry_id, ee.status AS entry_status, a.name, a.bib_number, a.team
                FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id JOIN athlete a ON a.id=ee.athlete_id
                WHERE he.heat_id=?`, heat.id);
            if (!entries.length) issues.push({ level: 'error', msg: '이 조에 배정된 선수가 없습니다 (조 편성 먼저 필요)' });
            const existing = await loadExisting(heat.id, dbKind);
            const used = new Set();
            const rows = [];
            for (const r of g.rows) {
                let m = null, method = 'none';
                const nb = fc.normBib(r.bib);
                if (nb) { m = entries.find(e => fc.normBib(e.bib_number) === nb) || null; if (m) method = 'bib'; }
                if (!m && r.order) { m = entries.find(e => e.lane_number === r.order) || null; if (m) method = 'order'; }
                if (!m && r.name) { const nn = fc.normName(r.name); m = entries.find(e => fc.normName(e.name) === nn) || null; if (m) method = 'name'; }
                if (m && used.has(m.event_entry_id)) {
                    r.issues.push({ level: 'error', msg: `같은 선수(${m.name})에 두 행이 매칭됨 — 이 행은 건너뜀` });
                    m = null; method = 'dup';
                }
                if (m) {
                    used.add(m.event_entry_id);
                    if (method === 'bib' && r.name && fc.normName(r.name) !== fc.normName(m.name))
                        r.issues.push({ level: 'warn', msg: `성명 불일치: 카드 "${r.name}" / DB "${m.name}" (배번 ${m.bib_number} 기준 매칭)` });
                    if (method !== 'bib') r.issues.push({ level: 'warn', msg: `배번으로 못 찾아 ${method === 'order' ? '순서' : '성명'}로 매칭함` });
                } else if (method !== 'dup') {
                    r.issues.push({ level: 'error', msg: `선수를 찾을 수 없음 (배번 ${r.bib || '-'} / 순서 ${r.order || '-'} / ${r.name || '-'}) — 배번이나 성명을 고치면 다시 매칭합니다` });
                }
                const ex = m ? (existing.get(m.event_entry_id) || null) : null;
                const s = serializeRow(g, r, m, ex, needsWind);
                s.match_method = method;
                rows.push(s);
            }
            // 조 고정 모드: 카드에 없는 선수 목록 (누락 행 추가용)
            const unmatched = opts.fixed ? entries.filter(e => !used.has(e.event_entry_id)).map(e => ({ event_entry_id: e.event_entry_id, name: e.name, bib: e.bib_number, lane: e.lane_number })) : undefined;
            out.push({ label, kind: g.kind, matchStatus: 'matched', heatInfo, heights: g.heights, issues, rows, unmatched_entries: unmatched });
        }
        return { groups: out, issues: parsed.issues, parsed };
    }
    function stripRaw(groups) {
        return groups.map(g => ({ ...g, rows: g.rows.map(({ _raw, ...rest }) => rest) }));
    }

    /** 파싱된 그룹(원본 행) → 편집용 카드 JSON (xlsx 업로드도 편집 표로 열 수 있게) */
    function cardFromGroup(g, meta) {
        const kind = g.kind === 'height' ? 'height' : 'distance';
        const heights = kind === 'height' ? [...g.heights].sort((a, b) => a - b) : [];
        const athletes = g.rows.map(r => {
            const attempts = [], winds = [];
            for (let n = 1; n <= fc.MAX_ATTEMPTS; n++) {
                const a = r.attempts[n];
                attempts.push(a ? (a.kind === 'valid' ? fc.fmtDist(a.value) : a.kind === 'foul' ? 'X' : '-') : '');
                winds.push(a && a.wind != null ? fc.fmtWind(a.wind) : '');
            }
            return {
                order: r.order ? String(r.order) : '', bib: r.bib || '', name: r.name || '', team: r.team || '',
                attempts: kind === 'height' ? [] : attempts, winds: kind === 'height' ? [] : winds,
                marks: heights.map(h => fc.marksToString(r.marks[fc.hk(h)] || [])),
                best: r.card.bestNM ? 'NM' : (r.card.best != null ? (kind === 'height' ? fc.hk(r.card.best) : fc.fmtDist(r.card.best)) : ''),
                rank: r.card.rank != null ? String(r.card.rank) : '', status: r.status.code || '', remark: r.remark || '', uncertain: [],
            };
        });
        return vision.normalizeCard({ kind, division: meta ? meta.division : g.divisionRaw, event: meta ? meta.event : g.eventName,
            round: meta ? meta.round : g.roundRaw, heat: meta ? meta.heat : String(g.heatNum), bar_heights: heights.map(h => fc.hk(h)), athletes, notes: '' });
    }
    /** 편집용 카드 JSON → (조 고정) 분석 입력 buffer + annotations */
    function cardToInputs(cardRaw, meta) {
        const card = vision.normalizeCard(cardRaw);
        if (card.kind === 'wind') throw Object.assign(new Error('풍속 카드만으로는 저장할 수 없습니다.'), { code: 'BAD_CARD' });
        Object.assign(card, { division: meta.division, event: meta.event, round: meta.round, heat: meta.heat });
        if (!card.athletes.length) throw Object.assign(new Error('선수 행이 없습니다.'), { code: 'BAD_CARD' });
        const sheets = vision.cardsToSheets([card]);
        return { card, buffer: vision.cardsToWorkbookBuffer(sheets), annotations: vision.cardsToAnnotations([card]) };
    }

    // ─────────────────────────────────────────────────────────
    // 저장 (공통) — groups: analyze() 결과 (_raw 포함)
    // ─────────────────────────────────────────────────────────
    const INSERT_RESULT = 'INSERT INTO result (heat_id,event_entry_id,attempt_number,distance_meters,time_seconds,remark,status_code,wind) VALUES (?,?,?,?,?,?,?,?)';
    async function applyImport(groups, req, auth) {
        const out = [];
        const hookJobs = [];
        const by = auth.role === 'admin' ? 'admin' : 'operator';
        await db.transaction(async () => {
            for (const g of groups) {
                if (g.matchStatus !== 'matched' || g.issues.some(i => i.level === 'error')) {
                    out.push({ label: g.label, heatInfo: g.heatInfo, imported: 0, skipped: g.rows.length, issues: g.issues, error: '매칭 실패 또는 오류로 건너뜀' });
                    continue;
                }
                const { heat_id, event_id, needs_wind } = g.heatInfo;
                const compId = g.heatInfo.competition_id;
                const heatRow = await db.get('SELECT * FROM heat WHERE id=?', heat_id);
                let imported = 0, skipped = 0;
                const rowResults = [];
                for (const row of g.rows) {
                    if (!row.will_import) { skipped++; continue; }
                    const r = row._raw;
                    const eid = row.db.event_entry_id;
                    if (g.kind === 'distance') {
                        const old = await db.all('SELECT * FROM result WHERE heat_id=? AND event_entry_id=?', heat_id, eid);
                        for (const o of old) { await db.run('DELETE FROM result WHERE id=?', o.id); audit('result', o.id, 'DELETE', o, null, 'field-card', compId, req); }
                        for (let n = 1; n <= fc.MAX_ATTEMPTS; n++) {
                            const a = r.attempts[n]; if (!a) continue;
                            const wind = (needs_wind && a.kind === 'valid' && a.wind != null) ? a.wind : null;
                            const info = await db.run(INSERT_RESULT, heat_id, eid, n, a.value, null, '', '', wind);
                            const ins = await db.get('SELECT * FROM result WHERE id=?', info.lastInsertRowid);
                            audit('result', ins.id, 'INSERT', null, ins, 'field-card', compId, req);
                            if (a.kind === 'valid') hookJobs.push({ row: ins, heat: heatRow });
                        }
                    } else {
                        const oldH = await db.all('SELECT * FROM height_attempt WHERE heat_id=? AND event_entry_id=?', heat_id, eid);
                        for (const o of oldH) { await db.run('DELETE FROM height_attempt WHERE id=?', o.id); audit('height_attempt', o.id, 'DELETE', o, null, 'field-card', compId, req); }
                        const oldS = await db.all('SELECT * FROM result WHERE heat_id=? AND event_entry_id=? AND attempt_number IS NULL', heat_id, eid);
                        for (const o of oldS) { await db.run('DELETE FROM result WHERE id=?', o.id); audit('result', o.id, 'DELETE', o, null, 'field-card', compId, req); }
                        for (const h of [...g.heights].sort((a, b) => a - b)) {
                            const marks = r.marks[fc.hk(h)]; if (!marks) continue;
                            for (let i = 0; i < marks.length; i++) {
                                const info = await db.run('INSERT INTO height_attempt (heat_id,event_entry_id,bar_height,attempt_number,result_mark) VALUES (?,?,?,?,?)', heat_id, eid, h, i + 1, marks[i]);
                                const ins = await db.get('SELECT * FROM height_attempt WHERE id=?', info.lastInsertRowid);
                                audit('height_attempt', ins.id, 'INSERT', null, ins, 'field-card', compId, req);
                            }
                        }
                    }
                    if (r.status.code) {
                        const info = await db.run(INSERT_RESULT, heat_id, eid, null, null, null, '', r.status.code, null);
                        const ins = await db.get('SELECT * FROM result WHERE id=?', info.lastInsertRowid);
                        audit('result', ins.id, 'INSERT', null, ins, 'field-card', compId, req);
                    }
                    imported++;
                    rowResults.push({ bib: row.db.bib, name: row.db.name, changed: row.changed, status: row.status, best: row.computed.best });
                }
                if (imported > 0) {
                    // round_status 자동 진행중 전환 — /api/results/upsert 와 동일한 opLog 포맷
                    const ev = await db.get('SELECT * FROM event WHERE id=?', event_id);
                    if (ev && (ev.round_status === 'heats_generated' || ev.round_status === 'created')) {
                        await db.run("UPDATE event SET round_status='in_progress' WHERE id=?", event_id);
                        broadcastSSE('event_status_changed', { event_id, round_status: 'in_progress' });
                        opLog(`${ev.name} ${ROUND_L[ev.round_type] || ev.round_type} ${genderL(ev.gender)} 기록 입력 시작 (자동 진행중 전환)`, 'record', 'system', ev.competition_id);
                    }
                    if (ev && ev.parent_event_id) {
                        const parentEvt = await db.get('SELECT * FROM event WHERE id=?', ev.parent_event_id);
                        if (parentEvt && parentEvt.category === 'combined' && (parentEvt.round_status === 'heats_generated' || parentEvt.round_status === 'created')) {
                            await db.run("UPDATE event SET round_status='in_progress' WHERE id=?", parentEvt.id);
                            broadcastSSE('event_status_changed', { event_id: parentEvt.id, round_status: 'in_progress' });
                            opLog(`${parentEvt.name} 기록 입력 시작 (세부종목 자동 진행중 전환)`, 'record', 'system', parentEvt.competition_id);
                        }
                    }
                    if (g.kind === 'distance') broadcastSSE('result_update', { heat_id, bulk: true });
                    else broadcastSSE('height_update', { heat_id });
                    const hi = g.heatInfo;
                    opLog(`필드 기록카드 가져오기: ${hi.event_name} ${ROUND_L[hi.round_type] || hi.round_type} ${genderL(hi.gender)} ${hi.heat_number}조 — ${imported}명 입력`, 'record', by, compId);
                }
                out.push({ label: g.label, heatInfo: g.heatInfo, imported, skipped, issues: g.issues, rows: rowResults });
            }
        })();
        // 신기록 감지 (커밋 후, best-effort). 세부종목이면 훅이 혼성 종합점수 동기화도 수행.
        if (typeof runRecordCompareHook === 'function') {
            for (const j of hookJobs) { try { await runRecordCompareHook(j.row, j.heat); } catch (e) { /* non-fatal */ } }
        }
        return out;
    }
    function sendError(res, err, tag) {
        if (err && err.code === 'NOT_CONFIGURED') return res.status(503).json({ error: err.message });
        if (err && ['BAD_IMAGE', 'REFUSAL', 'TRUNCATED', 'BAD_JSON', 'MIXED_GROUPS', 'BAD_CARD'].includes(err.code)) return res.status(422).json({ error: err.message });
        if (err && /기록 시트를 찾을 수 없습니다/.test(String(err.message))) return res.status(422).json({ error: err.message });
        console.error(`[field-card/${tag}]`, err);
        if (err && err.status) return res.status(502).json({ error: `AI 전사 호출 실패 (${err.status}): ${err.message}` });
        res.status(500).json({ error: err.message });
    }

    // ─────────────────────────────────────────────────────────
    // 양식 / 프롬프트
    // ─────────────────────────────────────────────────────────
    app.get('/api/field-card/template', (req, res) => {
        const kind = String(req.query.kind || 'throw');
        const t = fc.TEMPLATES[kind];
        if (!t) return res.status(400).json({ error: 'kind 는 throw / horizontal / vertical 중 하나' });
        const buf = fc.buildTemplateWorkbook(kind);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${t.filename}"; filename*=UTF-8''${encodeURIComponent(t.filenameKo)}`);
        res.send(buf);
    });
    app.get('/api/field-card/prompt', (req, res) => {
        res.type('text/plain; charset=utf-8').send(fc.AI_PROMPT);
    });

    // ─────────────────────────────────────────────────────────
    // 미리보기 — xlsx (DB 변경 없음). heat_id 가 있으면 조 고정 + 편집용 card 동봉
    // ─────────────────────────────────────────────────────────
    app.post('/api/field-card/preview', upload.single('file'), async (req, res) => {
        const auth = await guard(req, res);
        if (!auth) { cleanupFiles(req.file ? [req.file] : []); return; }
        if (!req.file) return res.status(400).json({ error: '파일이 필요합니다.' });
        try {
            const buf = fs.readFileSync(req.file.path);
            const { groups, issues, parsed } = await analyze(auth.competition_id, buf, { fixed: auth.fixed });
            const body = { success: true, total_groups: groups.length, groups: stripRaw(groups), issues };
            if (auth.fixed && parsed.groups.length === 1) { const meta = fixedMeta(auth.fixed); body.card = cardFromGroup(parsed.groups[0], meta); body.target = meta; }
            res.json(body);
        } catch (err) { sendError(res, err, 'preview'); }
        finally { cleanupFiles([req.file]); }
    });

    // ─────────────────────────────────────────────────────────
    // 사진 → 서버 AI 전사 → 미리보기 + xlsx (DB 변경 없음)
    //   heat_id 가 있으면 그 조로 고정하고, 편집용 card(기록카드+풍속카드 합본)를 함께 돌려준다.
    // ─────────────────────────────────────────────────────────
    app.post('/api/field-card/transcribe', upload.array('images', vision.MAX_IMAGES), async (req, res) => {
        const files = req.files || [];
        const auth = await guard(req, res);
        if (!auth) { cleanupFiles(files); return; }
        if (!files.length) { cleanupFiles(files); return res.status(400).json({ error: '카드 사진이 필요합니다 (images).' }); }
        const fixture = process.env.NODE_ENV === 'test' && !!process.env.FIELD_CARD_TRANSCRIBE_FIXTURE;
        if (!fixture && transcribe === vision.transcribeCards && !vision.isConfigured()) {
            cleanupFiles(files);
            return res.status(503).json({ error: 'ANTHROPIC_API_KEY 가 서버에 설정되지 않아 사진 전사를 쓸 수 없습니다. xlsx 업로드는 그대로 가능합니다.' });
        }
        try {
            const images = files.map(f => ({ buffer: fs.readFileSync(f.path), mimetype: f.mimetype, name: f.originalname }));
            let hint = String(req.body.hint || '').slice(0, 300);
            const meta = auth.fixed ? fixedMeta(auth.fixed) : null;
            if (meta) hint = `이 사진은 "${meta.division} ${meta.event} ${meta.round} ${meta.heat}조" 카드입니다 (${meta.kind === 'height' ? '높이 종목' : '거리 종목'}${meta.needs_wind ? ', 풍속 카드가 함께 있을 수 있음' : ''}).${hint ? ' ' + hint : ''}`;
            const t = await transcribe({ images, hint });
            const cards = Array.isArray(t.cards) ? t.cards : [];
            const usage = t.usage || { input_tokens: 0, output_tokens: 0 };
            opLog(`필드 기록카드 AI 전사: 사진 ${files.length}장 → 카드 ${cards.length}장 (${t.model}, 입력 ${usage.input_tokens} / 출력 ${usage.output_tokens} 토큰)`, 'record', auth.role === 'admin' ? 'admin' : 'operator', auth.competition_id);
            const transcription = {
                cards: cards.length, model: t.model, usage, cost_usd: t.cost_usd == null ? null : t.cost_usd,
                uncertain_cells: 0, images: t.images || [], fixture: !!t.fixture, notes: cards.map(c => String(c.notes || '').trim()).filter(Boolean),
            };
            if (meta) {
                // 조 고정: 카드들을 한 장으로 합쳐 편집용 card 로, 종목·조는 대상 조로 강제
                const merged = vision.mergeCardsForHeat(cards);
                if (!merged.card) return res.status(422).json({ error: cards.length ? '풍속 카드만 인식되었습니다. 기록카드 사진과 함께 올려 주세요.' : '사진에서 기록카드를 찾지 못했습니다. 카드 전체가 정면으로 나오게 다시 찍어 주세요.', transcription });
                const { card, buffer, annotations } = cardToInputs(merged.card, meta);
                transcription.notes = [...transcription.notes, ...merged.notes.filter(n => !transcription.notes.includes(n))];
                transcription.uncertain_cells = annotations.reduce((n, a) => n + a.cells.length, 0);
                const { groups, issues } = await analyze(auth.competition_id, buffer, { annotations, fixed: auth.fixed });
                const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
                return res.json({ success: true, total_groups: groups.length, groups: stripRaw(groups), issues, card, target: meta,
                    xlsx_base64: buffer.toString('base64'), xlsx_filename: `field_card_ai_${stamp}.xlsx`, transcription });
            }
            const sheets = vision.cardsToSheets(cards);
            if (!sheets.some(sh => sh.name === '기록' || sh.name.startsWith('높이'))) {
                return res.status(422).json({ error: cards.length ? '풍속 카드만 인식되었습니다. 기록카드 사진과 함께 올려 주세요.' : '사진에서 기록카드를 찾지 못했습니다. 카드 전체가 정면으로 나오게 다시 찍어 주세요.', transcription });
            }
            const buffer = vision.cardsToWorkbookBuffer(sheets);
            const annotations = vision.cardsToAnnotations(cards);
            transcription.uncertain_cells = annotations.reduce((n, a) => n + a.cells.length, 0);
            const { groups, issues } = await analyze(auth.competition_id, buffer, { annotations });
            const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
            res.json({ success: true, total_groups: groups.length, groups: stripRaw(groups), issues,
                xlsx_base64: buffer.toString('base64'), xlsx_filename: `field_card_ai_${stamp}.xlsx`, transcription });
        } catch (err) { sendError(res, err, 'transcribe'); }
        finally { cleanupFiles(files); }
    });

    // ─────────────────────────────────────────────────────────
    // 편집한 카드 JSON 재분석 / 저장 (조 고정 전용)
    // ─────────────────────────────────────────────────────────
    app.post('/api/field-card/analyze-json', async (req, res) => {
        const auth = await guard(req, res);
        if (!auth) return;
        if (!auth.fixed) return res.status(400).json({ error: 'heat_id 가 필요합니다.' });
        try {
            const meta = fixedMeta(auth.fixed);
            const { card, buffer, annotations } = cardToInputs(req.body.card, meta);
            const { groups, issues } = await analyze(auth.competition_id, buffer, { annotations, fixed: auth.fixed });
            res.json({ success: true, groups: stripRaw(groups), issues, card, target: meta });
        } catch (err) { sendError(res, err, 'analyze-json'); }
    });
    app.post('/api/field-card/import-json', async (req, res) => {
        const auth = await guard(req, res, { write: true });
        if (!auth) return;
        if (!auth.fixed) return res.status(400).json({ error: 'heat_id 가 필요합니다.' });
        try {
            const meta = fixedMeta(auth.fixed);
            const { buffer, annotations } = cardToInputs(req.body.card, meta);
            const { groups, issues } = await analyze(auth.competition_id, buffer, { annotations, fixed: auth.fixed });
            const results = await applyImport(groups, req, auth);
            res.json({ success: true, results, issues });
        } catch (err) { sendError(res, err, 'import-json'); }
    });

    // ─────────────────────────────────────────────────────────
    // 저장 — xlsx (선수 단위 교체)
    // ─────────────────────────────────────────────────────────
    app.post('/api/field-card/import', upload.single('file'), async (req, res) => {
        const auth = await guard(req, res, { write: true });
        if (!auth) { cleanupFiles(req.file ? [req.file] : []); return; }
        if (!req.file) return res.status(400).json({ error: '파일이 필요합니다.' });
        try {
            const buf = fs.readFileSync(req.file.path);
            const { groups, issues } = await analyze(auth.competition_id, buf, { fixed: auth.fixed });
            const results = await applyImport(groups, req, auth);
            res.json({ success: true, results, issues });
        } catch (err) { sendError(res, err, 'import'); }
        finally { cleanupFiles([req.file]); }
    });
};
