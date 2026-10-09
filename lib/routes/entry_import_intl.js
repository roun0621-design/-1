'use strict';
/**
 * 국제 양식 엔트리 가져오기 (B4, 2026-10-09) — WA·현지 연맹 스타일의 영문 CSV/xlsx 한 장으로 선수 + 종목 + 출전을 등록한다.
 *
 *   열(머리글 이름으로 인식, 순서 무관, 한글·영문 모두):
 *     Bib · Last name(Family name/Surname) · First name(Given name) · Name(전체 이름, 성·이름이 없을 때) · Local name(현지 표기, name_alt)
 *     Nation/Country/Club/Team · Gender(M/F/X, Men/Women, male/female, 남/여) · DOB · Event(s)/Event 1·2… · PB · SB · Phone · Grade
 *   종목은 lib/eventCatalog.js 로 푼다('Long Jump'·'100m Hurdles'·'멀리뛰기' 전부 OK). DB 에는 사전의 한글 정식명 + code 로 저장하고 화면은 언어에 맞게 보여 준다.
 *   계주 종목은 이 양식에서 받지 않는다(팀 단위라 열이 다름 — 미리보기에 경고). 라운드는 결승 1조로 만들고 조편성·시드는 3단계(조편성) 에서.
 *   선수 이름: 성·이름이 따로 오면 name_order('given-family' 기본 | 'family-given') 순서로 name 을 만들고 family_name/given_name 도 저장한다.
 *
 *   GET  /api/entries/intl/template.xlsx          양식 내려받기 (예시 2행 + Events 시트)
 *   POST /api/entries/intl/preview                 { file, admin_key, name_order? } → 행별 판정
 *   POST /api/entries/intl/import                  { file, admin_key, competition_id, name_order? } → 적용
 */
const XLSX = require('xlsx');
const EventCatalog = require('../eventCatalog');

const H = {   // 머리글 별칭 (소문자·공백 제거 뒤 비교)
    bib: ['bib', 'bibno', 'bibnumber', 'bib_number', 'no', 'number', 'startno', '배번', '배번호'],
    family: ['lastname', 'last', 'familyname', 'family', 'surname', '성'],
    given: ['firstname', 'first', 'givenname', 'given', 'forename', '이름(명)', '명'],
    name: ['name', 'fullname', 'athlete', 'athletename', '선수명', '성명', '이름', '선수'],
    local: ['localname', 'nativename', 'name_alt', 'namealt', '현지명', '현지표기', '한글이름', '영문이름'],
    team: ['nation', 'country', 'noc', 'nat', 'club', 'team', 'teamclub', 'nationclub', 'nation/club', 'team/club', 'affiliation', '소속', '팀', '팀명', '국가', '클럽'],
    gender: ['gender', 'sex', 'm/f', '성별'],
    dob: ['dob', 'dateofbirth', 'birthdate', 'birthday', 'born', 'birth', '생년월일', '생일'],
    events: ['event', 'events', 'event(s)', 'discipline', 'disciplines', '종목'],
    pb: ['pb', 'personalbest', '개인최고', '개인기록'],
    sb: ['sb', 'seasonbest', '시즌최고', '시즌기록'],
    phone: ['phone', 'mobile', 'phone_number', 'tel', '휴대폰', '핸드폰', '전화', '전화번호', '연락처'],
    grade: ['grade', 'year', '학년'],
};
const normHdr = s => String(s || '').toLowerCase().replace(/[\s_\-.]/g, '').replace(/\(s\)$/, 's');
function mapHeaders(headers) {
    const idx = {}; const eventCols = [];
    headers.forEach((h, i) => {
        const k = normHdr(h); if (!k) return;
        for (const [field, aliases] of Object.entries(H)) {
            if (field === 'events') { if (aliases.map(normHdr).includes(k) || /^(event|events?|종목)\d+$/.test(k)) { eventCols.push(i); return; } continue; }
            if (aliases.map(normHdr).includes(k) && idx[field] == null) { idx[field] = i; return; }
        }
    });
    return { idx, eventCols };
}
function parseGender(v) {
    const s = String(v || '').trim().toLowerCase();
    if (!s) return null;
    if (['m', 'men', 'man', 'male', 'boys', 'boy', '남', '남자', '男', '男子'].includes(s)) return 'M';
    if (['f', 'w', 'women', 'woman', 'female', 'girls', 'girl', '여', '여자', '女', '女子'].includes(s)) return 'F';
    if (['x', 'mixed', 'mix', '혼성', '混合'].includes(s)) return 'X';
    return null;
}
// 생년월일 → YYYY-MM-DD. 엑셀 날짜(숫자)·YYYY-MM-DD·YYYY.MM.DD·DD.MM.YYYY·DD/MM/YYYY·MM/DD/YYYY(앞이 12 초과면 일로)·YYYYMMDD
function parseDob(v) {
    if (v == null || v === '') return '';
    if (typeof v === 'number' && v > 20000 && v < 80000) { const d = new Date(Math.round((v - 25569) * 86400 * 1000)); return isNaN(d) ? '' : d.toISOString().slice(0, 10); }
    const s = String(v).trim();
    let m;
    if ((m = s.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/))) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    if ((m = s.match(/^(\d{1,2})[-./](\d{1,2})[-./](\d{4})$/))) { let d = +m[1], mo = +m[2]; if (mo > 12 && d <= 12) [d, mo] = [mo, d]; return `${m[3]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }
    if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) return `${m[1]}-${m[2]}-${m[3]}`;
    return s.slice(0, 10);
}
const clean = v => String(v == null ? '' : v).trim();
function splitEvents(cells) {
    const out = [];
    for (const c of cells) for (const p of String(c || '').split(/[;,/|\n]+/)) { const t = p.trim(); if (t) out.push(t); }
    return out;
}
function readRows(filePath, originalName) {
    // CSV 는 UTF-8 로 읽는다 (XLSX.readFile 의 기본은 latin1 → 한글·일문이 깨진다). xlsx 는 PK 서명으로 구분
    const buf = require('fs').readFileSync(filePath);
    const isZip = buf.length > 3 && buf[0] === 0x50 && buf[1] === 0x4b;
    const wb = (!isZip && (/\.csv$/i.test(String(originalName || '')) || !/\.xlsx?$/i.test(String(originalName || ''))))
        ? XLSX.read(buf.toString('utf8').replace(/^\uFEFF/, ''), { type: 'string', cellDates: false })
        : XLSX.read(buf, { type: 'buffer', cellDates: false });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
    return { sheetName: wb.SheetNames[0], rows };
}

/** 파일을 행별 판정으로 바꾼다 (DB 는 종목·선수 존재 여부 확인에만 사용) */
async function analyze(db, filePath, { competition_id, name_order, originalName }) {
    const { sheetName, rows } = readRows(filePath, originalName);
    if (!rows.length) throw new Error('빈 파일입니다.');
    const headers = rows[0].map(clean);
    const { idx, eventCols } = mapHeaders(headers);
    if (idx.name == null && (idx.family == null || idx.given == null)) throw new Error('이름 열이 없습니다 — Name 또는 Last name + First name 열이 필요합니다.');
    if (idx.gender == null) throw new Error('Gender 열이 필요합니다.');
    const familyFirst = name_order === 'family-given';
    const existingAth = competition_id ? await db.all('SELECT id, name, team, gender, bib_number FROM athlete WHERE competition_id=?', competition_id) : [];
    const byBib = new Map(), byKey = new Map();
    for (const a of existingAth) { if (a.bib_number) byBib.set(String(a.bib_number), a); byKey.set(`${a.name}|${a.team}|${a.gender}`, a); }
    const existingEv = competition_id ? await db.all("SELECT id, name, code, gender FROM event WHERE competition_id=? AND parent_event_id IS NULL AND round_type='final'", competition_id) : [];
    const evKey = new Map(); for (const e of existingEv) { const c = e.code || EventCatalog.codeOf(e.name); if (c) evKey.set(`${c}|${e.gender}`, e); }

    const out = []; const seenBib = new Map(); const unknownEvents = new Set(); const relayEvents = new Set();
    for (let r = 1; r < rows.length; r++) {
        const row = rows[r]; if (!row || !row.some(c => clean(c))) continue;
        const get = f => (idx[f] == null ? '' : row[idx[f]]);
        const errors = [], warnings = [];
        const family = clean(get('family')), given = clean(get('given'));
        let name = clean(get('name'));
        if (!name && (family || given)) name = familyFirst ? `${family} ${given}`.trim() : `${given} ${family}`.trim();
        if (!name) errors.push('이름 없음');
        const gender = parseGender(get('gender'));
        if (!gender) errors.push(`성별 인식 불가: ${clean(get('gender')) || '(빈칸)'}`);
        const team = clean(get('team'));
        const bib = clean(get('bib')).replace(/\.0$/, '');
        if (bib) { if (seenBib.has(bib)) errors.push(`배번 ${bib} 이 ${seenBib.get(bib)}행과 중복`); else seenBib.set(bib, r + 1); }
        const dob = parseDob(get('dob'));
        const events = [];
        for (const raw of splitEvents(eventCols.map(i => row[i]))) {
            const code = EventCatalog.codeOf(raw); const e = code && EventCatalog.entry(code);
            if (!e) { unknownEvents.add(raw); warnings.push(`종목 모름: ${raw}`); continue; }
            if (e.category === 'relay') { relayEvents.add(raw); warnings.push(`계주는 이 양식에서 받지 않음: ${raw}`); continue; }
            const g = gender || 'M';
            const existing = evKey.get(`${code}|${g}`);
            events.push({ raw, code, name: e.ko, name_en: e.en, category: e.category, gender: g, exists: !!existing });
        }
        const ex = (bib && byBib.get(bib)) || (name && byKey.get(`${name}|${team}|${gender}`)) || null;
        out.push({
            row: r + 1, errors, warnings,
            status: errors.length ? 'error' : (ex ? 'update' : 'new'),
            athlete: { name, family_name: family, given_name: given, name_alt: clean(get('local')), team, gender, bib_number: bib, date_of_birth: dob, personal_best: clean(get('pb')), season_best: clean(get('sb')), phone: clean(get('phone')).replace(/[^0-9+]/g, ''), grade: clean(get('grade')) },
            existing_id: ex ? ex.id : null,
            events,
        });
    }
    const summary = {
        rows: out.length, new: out.filter(x => x.status === 'new').length, update: out.filter(x => x.status === 'update').length, error: out.filter(x => x.status === 'error').length,
        entries: out.filter(x => !x.errors.length).reduce((n, x) => n + x.events.length, 0),
        events_new: [...new Set(out.flatMap(x => x.events.filter(e => !e.exists).map(e => `${e.code}|${e.gender}`)))].length,
        unknown_events: [...unknownEvents], relay_events: [...relayEvents],
        columns: Object.fromEntries(Object.entries(idx).map(([k, i]) => [k, headers[i]])), event_columns: eventCols.map(i => headers[i]),
    };
    return { sheetName, summary, rows: out };
}

module.exports = function mountEntryImportIntl(app, deps) {
    const { db, isOperationKey, opLog, upload } = deps;
    if (!app || !db || !isOperationKey || !opLog || !upload) throw new Error('[entry_import_intl.js] mount requires { db, isOperationKey, opLog, upload }');
    const fs = require('fs');
    const keyOf = req => (req.body && req.body.admin_key) || req.headers['x-admin-key'] || (req.query && req.query.key) || '';

    app.get('/api/entries/intl/template.xlsx', async (req, res) => {
        try {
            const ExcelJS = require('exceljs');
            const wb = new ExcelJS.Workbook();
            const ws = wb.addWorksheet('Entries');
            ws.addRow(['Bib', 'Last name', 'First name', 'Nation/Club', 'Gender', 'DOB', 'Event 1', 'Event 2', 'PB', 'SB', 'Local name', 'Phone']);
            ws.addRow([101, 'KIM', 'Guk-young', 'KOR', 'M', '1991-04-19', '100m', '200m', '10.07', '10.21', '김국영', '']);
            ws.addRow([205, 'YAMADA', 'Hanako', 'JPN', 'F', '2001-08-02', 'Long Jump', '', '6.45', '6.30', '山田花子', '']);
            ws.getRow(1).font = { bold: true };
            ws.columns.forEach(c => { c.width = 14; });
            const ev = wb.addWorksheet('Events');
            ev.addRow(['Code', 'English', 'Korean', 'Category']); ev.getRow(1).font = { bold: true };
            for (const e of EventCatalog.list()) if (e.category !== 'relay') ev.addRow([e.code, e.en, e.ko, e.category]);
            ev.columns.forEach(c => { c.width = 24; });
            const note = wb.addWorksheet('How to');
            ['Headers are matched by name (any order). Required: Gender and either Name or Last name + First name.', 'Gender: M / F / X (Men / Women / Mixed also accepted).', 'DOB: YYYY-MM-DD (DD.MM.YYYY also accepted).', 'Event 1, Event 2 … or one "Events" column separated by commas. Use names from the Events sheet (English or Korean).', 'Relay events are not imported from this sheet — set them up in the events screen.', 'CSV with the same headers is accepted too.'].forEach(t => note.addRow([t]));
            note.getColumn(1).width = 110;
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', 'attachment; filename="PACERISE_entries_template.xlsx"');
            res.end(Buffer.from(await wb.xlsx.writeBuffer()));
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/entries/intl/preview', upload.single('file'), async (req, res) => {
        if (!isOperationKey(keyOf(req))) return res.status(403).json({ error: '인증 키가 필요합니다.' });
        if (!req.file) return res.status(400).json({ error: '파일이 필요합니다.' });
        try {
            const competition_id = parseInt(req.body.competition_id, 10) || null;
            res.json({ success: true, ...(await analyze(db, req.file.path, { competition_id, name_order: req.body.name_order, originalName: req.file.originalname })) });
        } catch (e) { res.status(400).json({ error: e.message }); }
        finally { try { fs.unlinkSync(req.file.path); } catch (e) {} }
    });

    app.post('/api/entries/intl/import', upload.single('file'), async (req, res) => {
        if (!isOperationKey(keyOf(req))) return res.status(403).json({ error: '인증 키가 필요합니다.' });
        if (!req.file) return res.status(400).json({ error: '파일이 필요합니다.' });
        const competition_id = parseInt(req.body.competition_id, 10);
        if (!competition_id) { try { fs.unlinkSync(req.file.path); } catch (e) {} return res.status(400).json({ error: 'competition_id 필요' }); }
        try {
            const comp = await db.get('SELECT id FROM competition WHERE id=?', competition_id);
            if (!comp) return res.status(404).json({ error: '대회를 찾을 수 없습니다.' });
            const { rows, summary } = await analyze(db, req.file.path, { competition_id, name_order: req.body.name_order, originalName: req.file.originalname });
            if (summary.error > 0 && req.body.skip_errors !== '1' && req.body.skip_errors !== 'true') {
                return res.status(400).json({ error: `오류 행 ${summary.error}건이 있어 적용하지 않았습니다. 미리보기에서 고치거나 '오류 행 건너뛰기'를 켜세요.`, summary, rows: rows.filter(x => x.status === 'error') });
            }
            const stats = { athletes_new: 0, athletes_updated: 0, events_new: 0, entries: 0, skipped: summary.error };
            await db.transaction(async () => {
                const evCache = new Map();
                for (const e of await db.all("SELECT id, name, code, gender FROM event WHERE competition_id=? AND parent_event_id IS NULL AND round_type='final'", competition_id)) { const c = e.code || EventCatalog.codeOf(e.name); if (c) evCache.set(`${c}|${e.gender}`, e.id); }
                for (const x of rows) {
                    if (x.errors.length) continue;
                    const a = x.athlete; let athleteId = x.existing_id;
                    if (athleteId) {
                        // 비어 있는 칸만 채운다 (이름·소속은 유지)
                        await db.run(`UPDATE athlete SET bib_number=CASE WHEN bib_number IS NULL OR bib_number='' THEN ? ELSE bib_number END,
                                      date_of_birth=CASE WHEN date_of_birth IS NULL OR date_of_birth='' THEN ? ELSE date_of_birth END,
                                      personal_best=CASE WHEN personal_best IS NULL OR personal_best='' THEN ? ELSE personal_best END,
                                      season_best=CASE WHEN season_best IS NULL OR season_best='' THEN ? ELSE season_best END,
                                      phone=CASE WHEN phone IS NULL OR phone='' THEN ? ELSE phone END,
                                      name_alt=CASE WHEN name_alt IS NULL OR name_alt='' THEN ? ELSE name_alt END,
                                      family_name=CASE WHEN family_name IS NULL OR family_name='' THEN ? ELSE family_name END,
                                      given_name=CASE WHEN given_name IS NULL OR given_name='' THEN ? ELSE given_name END
                                      WHERE id=?`, a.bib_number || null, a.date_of_birth, a.personal_best, a.season_best, a.phone, a.name_alt, a.family_name, a.given_name, athleteId);
                        stats.athletes_updated++;
                    } else {
                        const gradeNum = parseInt(String(a.grade).replace(/[^0-9]/g, ''), 10);
                        const info = await db.run('INSERT INTO athlete (competition_id,name,bib_number,team,barcode,gender,phone,grade,date_of_birth,personal_best,season_best,name_alt,family_name,given_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                            competition_id, a.name, a.bib_number || null, a.team, '', a.gender, a.phone, (gradeNum >= 1 && gradeNum <= 6) ? gradeNum : null, a.date_of_birth, a.personal_best, a.season_best, a.name_alt, a.family_name, a.given_name);
                        athleteId = info.lastInsertRowid; stats.athletes_new++;
                    }
                    for (const ev of x.events) {
                        const k = `${ev.code}|${ev.gender}`;
                        let eventId = evCache.get(k);
                        if (!eventId) {
                            const info = await db.run("INSERT INTO event (competition_id,name,category,gender,round_type,round_status,code) VALUES (?,?,?,?,'final','created',?)", competition_id, ev.name, ev.category, ev.gender, ev.code);
                            eventId = info.lastInsertRowid; evCache.set(k, eventId); stats.events_new++;
                            await db.run('INSERT INTO heat (event_id, heat_number) VALUES (?, 1)', eventId);
                        }
                        const dup = await db.get('SELECT id FROM event_entry WHERE event_id=? AND athlete_id=?', eventId, athleteId);
                        if (!dup) { await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?,'registered')", eventId, athleteId); stats.entries++; }
                    }
                }
            })();
            opLog(`국제 양식 엔트리 가져오기: 선수 ${stats.athletes_new}명 신규 · ${stats.athletes_updated}명 갱신 · 종목 ${stats.events_new}개 · 출전 ${stats.entries}건`, 'admin', 'admin', competition_id);
            res.json({ success: true, stats, summary });
        } catch (e) { res.status(400).json({ error: e.message }); }
        finally { try { fs.unlinkSync(req.file.path); } catch (e) {} }
    });
};
