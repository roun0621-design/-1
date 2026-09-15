'use strict';
/**
 * lib/routes/field_card_import.js — 필드 수기 기록카드 가져오기
 *
 * 심판이 손으로 쓴 필드 기록카드(투척·수평도약·수직도약)를 AI(ChatGPT/Claude)로 전사한 xlsx 를
 * 관리자 페이지에서 올리면 종목·조·선수를 매칭하고 시기별 기록을 저장한다.
 * 파싱/계산/검산은 lib/fieldCardImport.js (순수 함수), 이 파일은 DB 매칭과 저장만 담당.
 *
 * 외부 의존성(deps): db, isAdminKey, opLog, broadcastSSE, audit, upload,
 *   recx { normBib, divToken, genderOf, round }  — server.js 기록 엑셀 가져오기와 같은 정규화 규칙
 *   runRecordCompareHook(resultRow, heatRow)      — results.js 의 신기록 감지 훅 (선택, best-effort)
 *
 * 라우트:
 *   GET  /api/field-card/template?kind=throw|horizontal|vertical   양식 xlsx 다운로드
 *   GET  /api/field-card/prompt                                     AI 전사용 프롬프트 (text/plain)
 *   POST /api/field-card/preview     (multipart file + competition_id)     매칭·계산·검산 미리보기 (DB 변경 없음)
 *   POST /api/field-card/transcribe  (multipart images[] + competition_id) 사진 → 서버 AI 전사 → 미리보기 + xlsx (DB 변경 없음)
 *   POST /api/field-card/import      (multipart file + competition_id)     저장
 *
 * 저장 규칙:
 *   - 관리자 키 필수. (대회 종료 잠금은 관리자 전용 경로라 자동 충족)
 *   - 선수 단위 교체: 파일에 기록이 있는 선수만 그 선수의 시기 전체를 파일대로 다시 씀.
 *     빈 행, 파일에 없는 선수, 오류(인식 불가·매칭 실패) 행은 건드리지 않음.
 *   - 거리 종목: result (attempt_number 1~6, 파울 0, 패스 -1, 풍속은 멀리뛰기·세단뛰기의 유효 시기에만)
 *               기록구분(DNS/DNF/DQ/NM)은 attempt_number NULL 행의 status_code
 *   - 높이 종목: height_attempt (O / X / PASS), 기록구분은 result NULL 행 (record.html 과 동일)
 *   - 카드의 최고기록·순위는 저장하지 않고 계산값과 대조해 경고만 표시
 *   - 유효 시기 저장 후 신기록 감지 훅 호출 (혼성경기 세부종목이면 종합점수 동기화까지 훅이 처리)
 */
const fs = require('fs');
const fc = require('../fieldCardImport');
const vision = require('../fieldCardVision');

module.exports = function mountFieldCardImportRoutes(app, deps) {
    const { db, isAdminKey, opLog, broadcastSSE, audit, upload, recx, runRecordCompareHook } = deps;
    const transcribe = typeof deps.transcribe === 'function' ? deps.transcribe : vision.transcribeCards;   // 테스트 주입용
    if (!app || !db || !isAdminKey || !opLog || !broadcastSSE || !audit || !upload || !recx) {
        throw new Error('[field_card_import.js] mount requires { db, isAdminKey, opLog, broadcastSSE, audit, upload, recx }');
    }
    const ROUND_L = { preliminary: '예선', semifinal: '준결승', final: '결승' };
    const genderL = (g) => (g === 'M' ? '남자' : g === 'F' ? '여자' : '혼성');

    // ─────────────────────────────────────────────────────────
    // 종목 / 조 해석
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
            // 혼성경기 세부종목: "10종 포환던지기" → 부모(10종) 아래의 필드 세부종목
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
            // 조 번호가 없을 때: 조가 하나뿐인 종목만 그 조로 폴백 (다중 조는 엉뚱한 조 덮어쓰기 방지)
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
        for (const k of keys) {
            if (fc.marksToString(row.marks[k] || []) !== (ex.marks[k] || '')) return true;
        }
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
            where: r.where, order: r.order, bib: r.bib, name: r.name, team: r.team, remark: r.remark,
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
                   || groups.find(x => fc.normalizeEventName(x.eventName).base === base);
            if (!g) continue;
            const nb = fc.normBib(an.bib);
            let row = nb ? g.rows.find(r => fc.normBib(r.bib) === nb) : null;
            if (!row && an.order) row = g.rows.find(r => r.order === an.order);
            if (!row && an.name) { const nn = fc.normName(an.name); row = g.rows.find(r => fc.normName(r.name) === nn); }
            if (!row) continue;
            row.issues.push({ level: 'warn', msg: `AI 판독 불확실: ${an.cells.join(', ')} — 사진과 대조하세요` });
        }
    }

    /** 파일 → 그룹별 매칭/계산/검산 결과. rows[]._raw 는 내부용 (응답 전 strip). opts.annotations: AI 불확실 셀 */
    async function analyze(competition_id, buffer, opts = {}) {
        const parsed = fc.parseFieldCardWorkbook(buffer);
        if (opts.annotations && opts.annotations.length) applyAnnotations(parsed.groups, opts.annotations);
        const out = [];
        for (const g of parsed.groups) {
            const label = fc.groupLabel(g);
            const resolved = await resolveGroup(competition_id, g);
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
                    r.issues.push({ level: 'error', msg: `선수를 찾을 수 없음 (배번 ${r.bib || '-'} / 순서 ${r.order || '-'} / ${r.name || '-'})` });
                }
                const ex = m ? (existing.get(m.event_entry_id) || null) : null;
                const s = serializeRow(g, r, m, ex, needsWind);
                s.match_method = method;
                rows.push(s);
            }
            out.push({ label, kind: g.kind, matchStatus: 'matched', heatInfo, heights: g.heights, issues, rows });
        }
        return { groups: out, issues: parsed.issues };
    }
    function stripRaw(groups) {
        return groups.map(g => ({ ...g, rows: g.rows.map(({ _raw, ...rest }) => rest) }));
    }
    function checkAuth(req, res) {
        const key = req.body.admin_key || req.headers['x-admin-key'];
        if (!isAdminKey(key)) { res.status(403).json({ error: '관리자 키가 필요합니다.' }); return false; }
        if (!req.file) { res.status(400).json({ error: '파일이 필요합니다.' }); return false; }
        const competition_id = parseInt(req.body.competition_id);
        if (!competition_id) { res.status(400).json({ error: 'competition_id 필요' }); return false; }
        return competition_id;
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
    // 사진 → 서버 AI 전사 → 미리보기 + xlsx (DB 변경 없음)
    //   응답의 xlsx_base64 를 그대로 /api/field-card/import 에 올리면 저장. (수정은 xlsx 내려받아 고친 뒤 재업로드)
    // ─────────────────────────────────────────────────────────
    app.post('/api/field-card/transcribe', upload.array('images', vision.MAX_IMAGES), async (req, res) => {
        const files = req.files || [];
        const cleanup = () => { for (const f of files) { try { fs.unlinkSync(f.path); } catch (e) {} } };
        const key = req.body.admin_key || req.headers['x-admin-key'];
        if (!isAdminKey(key)) { cleanup(); return res.status(403).json({ error: '관리자 키가 필요합니다.' }); }
        const competition_id = parseInt(req.body.competition_id);
        if (!competition_id) { cleanup(); return res.status(400).json({ error: 'competition_id 필요' }); }
        if (!files.length) { cleanup(); return res.status(400).json({ error: '카드 사진이 필요합니다 (images).' }); }
        const fixture = process.env.NODE_ENV === 'test' && !!process.env.FIELD_CARD_TRANSCRIBE_FIXTURE;
        if (!fixture && transcribe === vision.transcribeCards && !vision.isConfigured()) {
            cleanup();
            return res.status(503).json({ error: 'ANTHROPIC_API_KEY 가 서버에 설정되지 않아 사진 전사를 쓸 수 없습니다. xlsx 업로드는 그대로 가능합니다.' });
        }
        try {
            const images = files.map(f => ({ buffer: fs.readFileSync(f.path), mimetype: f.mimetype, name: f.originalname }));
            const t = await transcribe({ images, hint: String(req.body.hint || '').slice(0, 300) });
            const cards = Array.isArray(t.cards) ? t.cards : [];
            const usage = t.usage || { input_tokens: 0, output_tokens: 0 };
            opLog(`필드 기록카드 AI 전사: 사진 ${files.length}장 → 카드 ${cards.length}장 (${t.model}, 입력 ${usage.input_tokens} / 출력 ${usage.output_tokens} 토큰)`, 'record', 'admin', competition_id);
            const sheets = vision.cardsToSheets(cards);
            if (!sheets.some(sh => sh.name === '기록' || sh.name.startsWith('높이'))) {
                return res.status(422).json({ error: cards.length ? '풍속 카드만 인식되었습니다. 기록카드 사진과 함께 올려 주세요.' : '사진에서 기록카드를 찾지 못했습니다. 카드 전체가 정면으로 나오게 다시 찍어 주세요.', transcription: { cards: cards.length, model: t.model, usage } });
            }
            const buffer = vision.cardsToWorkbookBuffer(sheets);
            const annotations = vision.cardsToAnnotations(cards);
            const { groups, issues } = await analyze(competition_id, buffer, { annotations });
            const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
            res.json({
                success: true, total_groups: groups.length, groups: stripRaw(groups), issues,
                xlsx_base64: buffer.toString('base64'), xlsx_filename: `field_card_ai_${stamp}.xlsx`,
                transcription: {
                    cards: cards.length, model: t.model, usage, cost_usd: t.cost_usd == null ? null : t.cost_usd,
                    uncertain_cells: annotations.reduce((n, a) => n + a.cells.length, 0),
                    images: t.images || [], fixture: !!t.fixture,
                    notes: cards.map(c => String(c.notes || '').trim()).filter(Boolean),
                },
            });
        } catch (err) {
            if (err && err.code === 'NOT_CONFIGURED') return res.status(503).json({ error: err.message });
            if (err && (err.code === 'BAD_IMAGE' || err.code === 'REFUSAL' || err.code === 'TRUNCATED' || err.code === 'BAD_JSON')) return res.status(422).json({ error: err.message });
            console.error('[field-card/transcribe]', err);
            if (err && err.status) return res.status(502).json({ error: `AI 전사 호출 실패 (${err.status}): ${err.message}` });
            res.status(500).json({ error: err.message });
        } finally { cleanup(); }
    });

    // ─────────────────────────────────────────────────────────
    // 미리보기 — 매칭·계산·검산만 (DB 변경 없음)
    // ─────────────────────────────────────────────────────────
    app.post('/api/field-card/preview', upload.single('file'), async (req, res) => {
        const competition_id = checkAuth(req, res);
        if (!competition_id) { if (req.file) { try { fs.unlinkSync(req.file.path); } catch (e) {} } return; }
        try {
            const buf = fs.readFileSync(req.file.path);
            const { groups, issues } = await analyze(competition_id, buf);
            res.json({ success: true, total_groups: groups.length, groups: stripRaw(groups), issues });
        } catch (err) {
            console.error('[field-card/preview]', err);
            res.status(500).json({ error: err.message });
        } finally { try { fs.unlinkSync(req.file.path); } catch (e) {} }
    });

    // ─────────────────────────────────────────────────────────
    // 저장 — 선수 단위 교체
    // ─────────────────────────────────────────────────────────
    const INSERT_RESULT = 'INSERT INTO result (heat_id,event_entry_id,attempt_number,distance_meters,time_seconds,remark,status_code,wind) VALUES (?,?,?,?,?,?,?,?)';
    app.post('/api/field-card/import', upload.single('file'), async (req, res) => {
        const competition_id = checkAuth(req, res);
        if (!competition_id) { if (req.file) { try { fs.unlinkSync(req.file.path); } catch (e) {} } return; }
        try {
            const buf = fs.readFileSync(req.file.path);
            const { groups, issues } = await analyze(competition_id, buf);
            const out = [];
            const hookJobs = [];
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
                        opLog(`필드 기록카드 가져오기: ${hi.event_name} ${ROUND_L[hi.round_type] || hi.round_type} ${genderL(hi.gender)} ${hi.heat_number}조 — ${imported}명 입력`, 'record', 'admin', compId);
                    }
                    out.push({ label: g.label, heatInfo: g.heatInfo, imported, skipped, issues: g.issues, rows: rowResults });
                }
            })();
            // 신기록 감지 (커밋 후, best-effort). 세부종목이면 훅이 혼성 종합점수 동기화도 수행.
            if (typeof runRecordCompareHook === 'function') {
                for (const j of hookJobs) { try { await runRecordCompareHook(j.row, j.heat); } catch (e) { /* non-fatal */ } }
            }
            res.json({ success: true, results: out, issues });
        } catch (err) {
            console.error('[field-card/import]', err);
            res.status(500).json({ error: err.message });
        } finally { try { fs.unlinkSync(req.file.path); } catch (e) {} }
    });
};
