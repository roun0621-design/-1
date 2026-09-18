/**
 * 기록표 엑셀 일괄 업로드 (NR / DR / CR)
 *
 * 연맹 프로그램의 기록표(한국기록·부별기록·대회기록)를 우리 양식 엑셀로 옮겨 한 번에 등록한다.
 * 저장 규칙은 lib/routes/records.js 의 PUT /api/records(수동 UPSERT)와 동일.
 *
 * 사용법:
 *   require('./lib/routes/records_bulk')(app, { db, isAdminKey, opLog, upload, XLSX, guessEventCategory });
 *
 * 라우트:
 *   POST /api/records/bulk-preview   multipart(file, admin_key, series_id?)  → 행별 상태(신규/갱신/변경없음/나쁜값/오류)
 *   POST /api/records/bulk-import    multipart(file, admin_key, series_id?, allow_worse?) → 적용
 *
 * 엑셀 양식 (시트 1개, 1행 헤더, 한 행 = 기록 1건):
 *   종류 | 성별 | 부 | 종목 | 기록 | 성명 | 소속 | 대회명 | 장소 | 일자 | 풍속 | 비고
 *   - 종류: NR/DR/CR (한국기록/부별기록/대회기록 도 허용)
 *   - 부: DR 에만 필수 — 대학/일반(실업)/고등/중등/초등/공개/통합 → 성별과 조합해 division_master code
 *   - 시리즈(CR)는 엑셀이 아니라 화면에서 선택(series_id) — 파일 하나가 한 시리즈에 들어간다.
 */
const fs = require('fs');
const { normalizeEventName, parseRecordValue, getCompareDirection, isBetter } = require('../recordCompare');

const TYPE_MAP = {
    'nr': 'national', '한국기록': 'national', 'national': 'national',
    'dr': 'division', '부별기록': 'division', 'division': 'division',
    'cr': 'competition', '대회기록': 'competition', 'competition': 'competition',
};
const GENDER_MAP = { '남': 'M', '남자': 'M', 'm': 'M', '여': 'F', '여자': 'F', 'f': 'F', '혼성': 'X', '혼합': 'X', 'mixed': 'X', 'x': 'X', '통합': 'X' };
// 부 라벨 → school_level (실업은 일반부로 통일 — 2026-09 정책)
const LEVEL_MAP = {
    '대학': 'UNIV', '대학부': 'UNIV', '대학교': 'UNIV', 'univ': 'UNIV',
    '일반': 'GEN', '일반부': 'GEN', '실업': 'GEN', '실업부': 'GEN', 'gen': 'GEN',
    '고등': 'HIGH', '고등부': 'HIGH', '고': 'HIGH', 'high': 'HIGH',
    '중등': 'MID', '중등부': 'MID', '중': 'MID', 'mid': 'MID',
    '초등': 'ELEM', '초등부': 'ELEM', '초': 'ELEM', 'elem': 'ELEM',
    '공개': 'OPEN', '공개부': 'OPEN', 'open': 'OPEN',
    '통합': 'MIXED', '통합부': 'MIXED', '혼성': 'MIXED', 'mixed': 'MIXED',
};
const HEADER_ALIASES = {
    type: ['종류', '기록종류', '구분', 'type', 'record_type'],
    gender: ['성별', 'gender'],
    division: ['부', '부별', '부문', 'division'],
    event: ['종목', '종목명', 'event', 'event_name'],
    value: ['기록', '기록값', 'record', 'record_value'],
    holder: ['성명', '이름', '선수명', '보유자', 'holder', 'holder_name'],
    team: ['소속', '팀', '팀명', 'team', 'holder_team'],
    meet: ['대회명', '대회', 'meet', 'competition'],
    venue: ['장소', 'venue'],
    date: ['일자', '날짜', '일시', 'date', 'record_date'],
    wind: ['풍속', 'wind'],
    note: ['비고', 'note', '메모'],
};

const s = v => (v == null ? '' : String(v).replace(/[ 　]/g, ' ').trim());

// 종목명: recordCompare 정규화 + 규격 괄호 제거 ("110mH(1.067m)", "포환던지기(7.260kg)", "창던지기(600g)")
function normalizeRecordEventName(raw) {
    let n = s(raw).replace(/\(\s*[\d.]+\s*(kg|g|m|cm)\s*\)/gi, '').trim();
    n = normalizeEventName(n);
    // 종합 표기 통일
    n = n.replace(/^10종$/, '10종경기').replace(/^7종$/, '7종경기').replace(/^5종$/, '5종경기');
    return n;
}

// 기록값: 허용 형식만 통과 (오타 "3:38:60", "37.10.55" 는 오류로)
//   초: 10.07 / 14.0        분:초: 1:44.14 / 3:38.60        시:분:초: 2:07:20 / 1:19:13
//   미터: 2.36 / 2m36 / 2m 36 / 8.22m       점수: 7860 / 7,860 / 7860점
function parseRecordCell(raw) {
    let v = s(raw).replace(/\s+/g, '').replace(/[,，]/g, '').replace(/점$/, '');
    if (!v) return { ok: false, reason: '기록 없음' };
    let canon = v;
    const mm = v.match(/^(\d+)[mM](\d{1,2})$/);
    if (mm) canon = `${mm[1]}.${mm[2].length === 1 ? mm[2] : mm[2].padStart(2, '0')}`;
    else canon = v.replace(/[mM]$/, '');
    let ok = false;
    let m;
    if ((m = canon.match(/^(\d+):(\d{1,2})(?:\.(\d{1,3}))?$/))) ok = parseInt(m[2], 10) < 60;
    else if ((m = canon.match(/^(\d+):(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?$/))) ok = parseInt(m[2], 10) < 60 && parseInt(m[3], 10) < 60;
    else if (/^\d+(\.\d{1,3})?$/.test(canon)) ok = true;
    if (!ok) return { ok: false, reason: `기록 형식 오류: "${s(raw)}"` };
    const num = parseRecordValue(canon);
    if (num == null || !isFinite(num) || num <= 0) return { ok: false, reason: `기록 형식 오류: "${s(raw)}"` };
    return { ok: true, value: canon, num };
}

// 일자: 2017-06-27 / 2017.06.27 / 2017. 6. 27 / 20170627 / 2017 / 엑셀 날짜 시리얼
function parseDateCell(raw) {
    if (raw instanceof Date) {
        const y = raw.getFullYear(), mo = raw.getMonth() + 1, d = raw.getDate();
        return { date: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`, year: String(y) };
    }
    const v = s(raw);
    if (!v) return { date: '', year: '' };
    if (/^\d{5}$/.test(v)) { // 엑셀 시리얼
        const d = new Date(Date.UTC(1899, 11, 30) + parseInt(v, 10) * 86400000);
        return { date: d.toISOString().slice(0, 10), year: String(d.getUTCFullYear()) };
    }
    let m = v.match(/^(\d{4})\s*[.\-\/]\s*(\d{1,2})\s*[.\-\/]\s*(\d{1,2})\.?$/) || v.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (m) return { date: `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`, year: m[1] };
    m = v.match(/^(\d{4})\s*[.\-\/]\s*(\d{1,2})\.?$/);
    if (m) return { date: `${m[1]}-${m[2].padStart(2, '0')}`, year: m[1] };
    m = v.match(/(\d{4})/);
    return { date: v, year: m ? m[1] : '' };
}

function mapHeaders(headerRow) {
    const idx = {};
    headerRow.forEach((h, i) => {
        const hn = s(h).replace(/\s+/g, '').toLowerCase();
        for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
            if (idx[key] === undefined && aliases.some(a => a.toLowerCase() === hn)) idx[key] = i;
        }
    });
    return idx;
}

module.exports = function mountRecordsBulkRoutes(app, deps) {
    const { db, isAdminKey, opLog, upload, XLSX, guessEventCategory } = deps;
    if (!app || !db || !isAdminKey || !opLog || !upload || !XLSX || typeof guessEventCategory !== 'function') {
        throw new Error('[records_bulk.js] mount requires { db, isAdminKey, opLog, upload, XLSX, guessEventCategory }');
    }

    // 엑셀 → 행 목록 (파싱만, DB 미접촉). 각 행: { row, errors[], ...정규화 필드 }
    function parseWorkbook(filePath, seriesId) {
        const wb = XLSX.readFile(filePath, { cellDates: true });
        const sheetName = wb.SheetNames.find(n => /기록/.test(n)) || wb.SheetNames[0];
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' });
        if (rows.length < 2) throw new Error('데이터가 없습니다 (1행 헤더 + 2행부터 기록).');
        const col = mapHeaders(rows[0]);
        for (const k of ['type', 'gender', 'event', 'value']) {
            if (col[k] === undefined) throw new Error(`'${HEADER_ALIASES[k][0]}' 열을 찾을 수 없습니다. 헤더: ${rows[0].map(s).filter(Boolean).join(' | ')}`);
        }
        const get = (r, k) => (col[k] === undefined ? '' : r[col[k]]);
        const out = [];
        rows.slice(1).forEach((r, i) => {
            if (!r.some(c => s(c))) return; // 빈 행
            const rowNo = i + 2;
            const errors = [];
            const typeRaw = s(get(r, 'type')), genderRaw = s(get(r, 'gender')), divRaw = s(get(r, 'division'));
            const record_type = TYPE_MAP[typeRaw.toLowerCase()] || null;
            if (!record_type) errors.push(`종류 인식 불가: "${typeRaw}" (NR/DR/CR)`);
            const gender = GENDER_MAP[genderRaw.toLowerCase()] || null;
            if (!gender) errors.push(`성별 인식 불가: "${genderRaw}" (남/여/혼성)`);
            const event_name = normalizeRecordEventName(get(r, 'event'));
            if (!event_name) errors.push('종목 없음');
            let division_code = null;
            if (record_type === 'division') {
                const level = LEVEL_MAP[divRaw.replace(/\s+/g, '').toLowerCase()];
                if (!level) errors.push(divRaw ? `부 인식 불가: "${divRaw}" (대학/일반/고등/중등/초등)` : 'DR(부별기록)은 부 필수');
                else division_code = level === 'MIXED' ? 'MIXED' : `${gender || '?'}_${level}`;
            } else if (divRaw && record_type) {
                // NR/CR 에 부가 적혀 있으면 무시하되 알려준다
            }
            let series_id = null;
            if (record_type === 'competition') {
                if (!seriesId) errors.push('CR(대회기록)은 화면에서 시리즈를 선택해야 합니다');
                else series_id = seriesId;
            }
            const val = parseRecordCell(get(r, 'value'));
            if (!val.ok) errors.push(val.reason);
            const { date, year } = parseDateCell(get(r, 'date'));
            const wind = s(get(r, 'wind'));
            const meet = s(get(r, 'meet'));
            const noteParts = [];
            if (wind) noteParts.push(`풍속 ${/^[+-]/.test(wind) ? wind : (isNaN(parseFloat(wind)) ? wind : (parseFloat(wind) >= 0 ? '+' : '') + wind)}`);
            if (meet) noteParts.push(meet);
            if (s(get(r, 'note'))) noteParts.push(s(get(r, 'note')));
            out.push({
                row: rowNo, errors, record_type, gender, division_code, series_id, event_name,
                event_raw: s(get(r, 'event')),
                record_value: val.ok ? val.value : s(get(r, 'value')), record_value_num: val.ok ? val.num : null,
                holder_name: s(get(r, 'holder')), holder_team: s(get(r, 'team')),
                record_date: date, record_year: year, venue: s(get(r, 'venue')), note: noteParts.join(' · '),
            });
        });
        return { sheetName, rows: out };
    }

    async function findExisting(x) {
        if (x.record_type === 'national') {
            return db.get('SELECT * FROM event_record WHERE record_type=? AND event_name=? AND gender=? AND division_code IS NULL AND series_id IS NULL', 'national', x.event_name, x.gender);
        }
        if (x.record_type === 'division') {
            return db.get('SELECT * FROM event_record WHERE record_type=? AND event_name=? AND gender=? AND division_code=? AND series_id IS NULL', 'division', x.event_name, x.gender, x.division_code);
        }
        return db.get('SELECT * FROM event_record WHERE record_type=? AND event_name=? AND gender=? AND division_code IS NULL AND series_id=?', 'competition', x.event_name, x.gender, x.series_id);
    }

    // 행 상태 판정: error / new / update / unchanged / worse (기존보다 나쁜 값으로 바뀜 — 확인 필요)
    async function analyze(rows, seriesId) {
        const divCodes = new Set((await db.all('SELECT code FROM division_master WHERE active=1')).map(d => d.code));
        const series = seriesId ? await db.get('SELECT id, name FROM competition_series WHERE id=?', seriesId) : null;
        if (seriesId && !series) throw new Error(`시리즈(id=${seriesId})를 찾을 수 없습니다`);
        // 파일 안 중복 키 검사 (동률 2건 등) — 뒤 행은 오류
        const seen = new Map();
        for (const x of rows) {
            if (x.errors.length) continue;
            if (x.division_code && !divCodes.has(x.division_code)) x.errors.push(`부 코드 없음: ${x.division_code} (관리자 → 부 관리에서 생성)`);
            const key = `${x.record_type}|${x.gender}|${x.event_name}|${x.division_code || ''}|${x.series_id || ''}`;
            if (seen.has(key)) x.errors.push(`${seen.get(key)}행과 같은 기록(종류·성별·종목·부)이 중복 — 한 건만 남기고 나머지는 비고로 합치세요`);
            else seen.set(key, x.row);
        }
        for (const x of rows) {
            if (x.errors.length) { x.status = 'error'; continue; }
            const ex = await findExisting(x);
            x.existing = ex ? { id: ex.id, record_value: ex.record_value, holder_name: ex.holder_name, holder_team: ex.holder_team, record_year: ex.record_year } : null;
            if (!ex) { x.status = 'new'; continue; }
            const exNum = parseRecordValue(ex.record_value);
            const same = exNum != null && x.record_value_num != null && Math.abs(exNum - x.record_value_num) < 1e-9;
            const metaSame = (ex.holder_name || '') === x.holder_name && (ex.holder_team || '') === x.holder_team && (ex.record_year || '') === x.record_year && (ex.record_date || '') === x.record_date && (ex.venue || '') === x.venue && (ex.note || '') === x.note;
            if (same && metaSame) { x.status = 'unchanged'; continue; }
            const dir = getCompareDirection(guessEventCategory(x.event_name));
            // 값이 달라졌고, 방향을 아는 종목에서 기존보다 나쁜 값이면 확인 대상
            if (!same && dir && exNum != null && isBetter(exNum, x.record_value_num, dir)) { x.status = 'worse'; continue; }
            x.status = 'update';
        }
        return { series };
    }

    function summarize(rows) {
        const c = { total: rows.length, new: 0, update: 0, unchanged: 0, worse: 0, error: 0 };
        rows.forEach(x => { c[x.status] = (c[x.status] || 0) + 1; });
        return c;
    }

    app.post('/api/records/bulk-preview', upload.single('file'), async (req, res) => {
        if (!isAdminKey(req.body.admin_key || req.headers['x-admin-key'])) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        if (!req.file) return res.status(400).json({ error: '파일이 필요합니다.' });
        const seriesId = parseInt(req.body.series_id, 10) || null;
        try {
            const { sheetName, rows } = parseWorkbook(req.file.path, seriesId);
            const { series } = await analyze(rows, seriesId);
            res.json({ success: true, sheetName, series: series ? { id: series.id, name: series.name } : null, summary: summarize(rows), rows });
        } catch (err) {
            res.status(400).json({ error: err.message });
        } finally { try { fs.unlinkSync(req.file.path); } catch (e) {} }
    });

    app.post('/api/records/bulk-import', upload.single('file'), async (req, res) => {
        if (!isAdminKey(req.body.admin_key || req.headers['x-admin-key'])) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        if (!req.file) return res.status(400).json({ error: '파일이 필요합니다.' });
        const seriesId = parseInt(req.body.series_id, 10) || null;
        const allowWorse = req.body.allow_worse === '1' || req.body.allow_worse === 'true';
        try {
            const { rows } = parseWorkbook(req.file.path, seriesId);
            const { series } = await analyze(rows, seriesId);
            const summary = summarize(rows);
            if (summary.error > 0) {
                return res.status(400).json({ error: `오류 행 ${summary.error}건이 있어 적용하지 않았습니다. 미리보기에서 수정 후 다시 올려주세요.`, summary, rows: rows.filter(x => x.status === 'error') });
            }
            const nowExpr = db.isAsync ? 'NOW()' : `datetime('now')`;
            const stats = { inserted: 0, updated: 0, unchanged: 0, skippedWorse: 0 };
            await db.transaction(async () => {
                for (const x of rows) {
                    if (x.status === 'unchanged') { stats.unchanged++; continue; }
                    if (x.status === 'worse' && !allowWorse) { stats.skippedWorse++; continue; }
                    if (x.existing) {
                        await db.run(`UPDATE event_record SET record_value=?, record_value_num=?, holder_name=?, holder_team=?, record_year=?, record_date=?, venue=?, note=?, approved=1, updated_at=${nowExpr} WHERE id=?`,
                            x.record_value, x.record_value_num, x.holder_name, x.holder_team, x.record_year, x.record_date, x.venue, x.note, x.existing.id);
                        stats.updated++;
                    } else {
                        await db.run(`INSERT INTO event_record (record_type, event_name, gender, division_code, series_id, record_value, record_value_num, holder_name, holder_team, record_year, record_date, venue, note, approved) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
                            x.record_type, x.event_name, x.gender, x.division_code, x.series_id, x.record_value, x.record_value_num, x.holder_name, x.holder_team, x.record_year, x.record_date, x.venue, x.note);
                        stats.inserted++;
                    }
                }
            })();
            opLog(`기록표 일괄 업로드: 신규 ${stats.inserted} · 갱신 ${stats.updated} · 변경없음 ${stats.unchanged}${stats.skippedWorse ? ` · 나쁜값 건너뜀 ${stats.skippedWorse}` : ''}${series ? ` (시리즈: ${series.name})` : ''}`, 'admin', 'admin');
            res.json({ success: true, stats, series: series ? { id: series.id, name: series.name } : null });
        } catch (err) {
            console.error('[records/bulk-import]', err);
            res.status(400).json({ error: err.message });
        } finally { try { fs.unlinkSync(req.file.path); } catch (e) {} }
    });

    // 테스트/재사용용
    return { parseRecordCell, parseDateCell, normalizeRecordEventName };
};
