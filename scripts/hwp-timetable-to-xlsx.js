#!/usr/bin/env node
/**
 * HWP 경기 시간표 → 표준 엑셀 변환기
 *
 * 사용법:
 *   1) HWP를 HTML로 1차 변환:
 *        hwp5html --output /tmp/hwp_html <input.hwp>
 *   2) 본 스크립트 실행:
 *        node scripts/hwp-timetable-to-xlsx.js /tmp/hwp_html/index.xhtml <output.xlsx>
 *
 * 또는 한 번에:
 *   node scripts/hwp-timetable-to-xlsx.js --hwp <input.hwp> -o <output.xlsx>
 *
 * 변환 결과는 /api/timetable/upload 가 인식하는 표준 컬럼 구조:
 *   날짜 | 구분 | 시간 | 종목 | 종별 | 라운드 | 비고
 *
 * 처리 항목:
 *   - 18개 표(헤더+데이터) 자동 분류 (트랙/필드)
 *   - 좌/우 2단(10컬럼) 레이아웃 평탄화
 *   - 반복 약물(", “, 〃) 직전 값으로 펼치기
 *   - 종별 줄바꿈("선수권(여) U18(여)") → 슬래시 결합("선수권(여)/U18(여)")
 *   - "제N일 경기 ... YYYY. M. D" 헤더에서 일자 자동 매핑
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const XLSX = require('xlsx');

// ─── CLI 파싱 ───
const args = process.argv.slice(2);
let hwpPath = null;
let inputHtml = null;
let outputXlsx = null;
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--hwp') hwpPath = args[++i];
    else if (args[i] === '-o' || args[i] === '--output') outputXlsx = args[++i];
    else if (!inputHtml && args[i].endsWith('.xhtml')) inputHtml = args[i];
    else if (!outputXlsx) outputXlsx = args[i];
}

if (!inputHtml && hwpPath) {
    const tmpDir = fs.mkdtempSync('/tmp/hwphtml-');
    try {
        execFileSync('hwp5html', ['--output', tmpDir, hwpPath], { stdio: 'inherit' });
        inputHtml = path.join(tmpDir, 'index.xhtml');
    } catch (e) {
        console.error('hwp5html 실행 실패. pyhwp 가 설치되어 있는지 확인하세요. (pip install pyhwp)');
        process.exit(1);
    }
}

if (!inputHtml) {
    console.error('사용법: node hwp-timetable-to-xlsx.js <html|--hwp file> [-o output.xlsx]');
    process.exit(1);
}
if (!outputXlsx) outputXlsx = inputHtml.replace(/\.xhtml$/, '.xlsx');

// ─── HTML 로드 ───
const html = fs.readFileSync(inputHtml, 'utf8');

// ─── 셀 텍스트 정리 ───
function cellText(cellHtml) {
    return cellHtml
        .replace(/<\/p\s*>/gi, '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&#13;/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{2,}/g, '\n')
        .trim();
}

// ─── 표 분리 + 표 사이 텍스트 ───
const segments = html.split(/(<table[\s\S]*?<\/table>)/);
const tables = [];           // { html, beforeText }
let buffer = '';
segments.forEach(seg => {
    if (seg.startsWith('<table')) {
        const before = buffer.replace(/<[^>]+>/g, ' ')
                             .replace(/&[a-z#0-9]+;/gi, ' ')
                             .replace(/\s+/g, ' ')
                             .trim();
        tables.push({ html: seg, beforeText: before });
        buffer = '';
    } else {
        buffer += seg;
    }
});

// ─── 일자 헤더 파싱 (제N일 경기 YYYY. M. D) ───
function parseDayHeader(text) {
    if (!text) return null;
    const m = text.match(/제\s*(\d+)\s*일\s*경기.*?(\d{4})\s*\.\s*(\d{1,2})\s*\.\s*(\d{1,2})/);
    if (!m) return null;
    const day = parseInt(m[1]);
    const yyyy = m[2];
    const mm = String(parseInt(m[3])).padStart(2, '0');
    const dd = String(parseInt(m[4])).padStart(2, '0');
    return { day, dateStr: `${yyyy}. ${parseInt(m[3])}. ${parseInt(m[4])}`, ymd: `${yyyy}-${mm}-${dd}` };
}

// ─── 표 종류 판별 ───
function classifyTable(table) {
    const rows = table.html.match(/<tr[\s\S]*?<\/tr>/g) || [];
    if (rows.length === 0) return 'empty';
    const firstCells = rows[0].match(/<t[hd][\s\S]*?<\/t[hd]>/g) || [];
    const firstText = firstCells.map(cellText).join(' ');
    if (/트\s*랙/.test(firstText) && /필\s*드/.test(firstText)) return 'mixed';   // 마지막 날 합본
    if (/트\s*랙/.test(firstText)) return 'track';
    if (/필\s*드/.test(firstText)) return 'field';
    if (firstText.length < 30 && /경\s*기\s*시\s*간\s*표/.test(firstText)) return 'banner';
    // 컬럼 10개면 데이터 표
    let maxCells = 0;
    rows.forEach(r => {
        const cells = r.match(/<t[hd][\s\S]*?<\/t[hd]>/g) || [];
        if (cells.length > maxCells) maxCells = cells.length;
    });
    return maxCells >= 5 ? 'data?' : 'banner';
}

// ─── 셀 행 추출 ───
function extractRows(table) {
    const rowsHtml = table.html.match(/<tr[\s\S]*?<\/tr>/g) || [];
    return rowsHtml.map(r => {
        const cells = r.match(/<t[hd][\s\S]*?<\/t[hd]>/g) || [];
        return cells.map(cellText);
    });
}

// ─── 반복 약물 판별 ───
function isDitto(s) {
    if (!s) return false;
    const t = s.replace(/\s/g, '');
    return /^["“”〃″'']+$/.test(t);
}

// ─── 종별 줄바꿈 결합 ───
function normalizeCategory(s) {
    if (!s) return '';
    return s.split('\n').map(x => x.trim()).filter(Boolean).join('/');
}

// ─── 시간 정규화 ───
function normalizeTime(s) {
    if (!s) return '';
    const t = s.toString().trim();
    const m = t.match(/^(\d{1,2}):(\d{2})/);
    if (m) return `${String(parseInt(m[1])).padStart(2, '0')}:${m[2]}`;
    return t;
}

// ─── 데이터 표(짝수 인덱스, T2/T4/.../T18)를 일자/구분과 매칭 ───
const allEntries = [];
let currentDayInfo = null;

// 날짜·구분은 데이터 표 직전 텍스트와 표 머리(R0)를 동시에 본다
for (let i = 0; i < tables.length; i++) {
    const tbl = tables[i];
    const before = tbl.beforeText;

    // before 에 일자 헤더가 들어 있으면 갱신
    const dayInfo = parseDayHeader(before);
    if (dayInfo) currentDayInfo = dayInfo;

    const kind = classifyTable(tbl);
    if (kind !== 'track' && kind !== 'field' && kind !== 'mixed') continue;
    if (!currentDayInfo) {
        console.warn(`[warn] 일자 정보 없음 (table ${i + 1}, kind=${kind})`);
        continue;
    }

    const rows = extractRows(tbl);

    // 첫 행은 "트랙 경기" / "필드 경기" 머리, 두 번째 행은 컬럼 헤더(시간/종목/종별/라운드/P)
    // mixed 의 경우 첫 행 셀 2개 (트랙/필드)
    let dataRows = rows.slice(2);

    // 좌(0..4) / 우(5..9) 두 컬럼셋을 처리
    // mixed 인 경우: 좌=트랙, 우=필드 (이미 표 자체가 그렇게 구성)
    const leftSection = (kind === 'mixed' || kind === 'track') ? 'track' : 'field';
    const rightSection = (kind === 'mixed') ? 'field' : leftSection;  // mixed=필드, 나머지는 좌우 동일 섹션(연속된 두 단)

    // 펼치기 상태(좌·우 각각)
    const stateL = { time: '', event: '', cat: '', round: '' };
    const stateR = { time: '', event: '', cat: '', round: '' };

    function ingest(state, time, event, cat, round, sec) {
        // 빈 행
        const all = [time, event, cat, round].map(x => (x || '').trim());
        if (all.every(v => v === '' || isDitto(v))) return;

        // ditto/blank → state 사용 (단, blank time 은 별도 종목/시간이 없으므로 skip)
        const t = (!time || isDitto(time)) ? state.time : normalizeTime(time);
        const e = (!event || isDitto(event)) ? state.event : event.trim();
        const c = (!cat || isDitto(cat)) ? state.cat : normalizeCategory(cat);
        const r = (!round || isDitto(round)) ? state.round : round.trim();

        // 시간/종목 둘 다 비어있으면 skip
        if (!t || !e) return;

        state.time = t;
        state.event = e;
        state.cat = c;
        state.round = r;

        allEntries.push({
            '날짜': currentDayInfo.dateStr,
            '구분': sec === 'field' ? '필드' : '트랙',
            '시간': t,
            '종목': e,
            '종별': c,
            '라운드': r,
            '비고': '',
            _day: currentDayInfo.day,
            _ymd: currentDayInfo.ymd,
            _section: sec,
            _sortKey: t,
        });
    }

    dataRows.forEach(rawRow => {
        // 셀 누락 보정: HWP→HTML 변환 시 빈 셀(특히 P 컬럼)이 누락되어 9칸이 되는 경우 → 10칸으로 정규화
        let row = rawRow.slice();
        if (row.length === 9) {
            // 좌측 P(인덱스 4) 누락으로 가정하고 보강
            row = [row[0], row[1], row[2], row[3], '', row[4], row[5], row[6], row[7], row[8]];
        } else if (row.length < 10) {
            // 부족분 빈 문자열로 채움
            while (row.length < 10) row.push('');
        }

        // 휴식/안내 행 스킵
        const left0 = (row[0] || '').replace(/\s/g, '');
        const right0 = (row[5] || '').replace(/\s/g, '');
        const isLeftBreak = /^(휴식|점심|중식|석식|정리|준비|개회식|폐회식)$/.test(left0);
        const isRightBreak = /^(휴식|점심|중식|석식|정리|준비|개회식|폐회식)$/.test(right0);

        // 좌 0..4
        if (!isLeftBreak) ingest(stateL, row[0], row[1], row[2], row[3], leftSection);
        // 우 5..9
        if (!isRightBreak) ingest(stateR, row[5], row[6], row[7], row[8], rightSection);
    });
}

// ─── 후처리: 혼성 릴레이의 종별 단독 라벨 → (혼) 보정 ───
allEntries.forEach(e => {
    const ev = (e['종목'] || '').replace(/\s/g, '');
    const isMixed = /믹스릴레이|혼성|mixed/i.test(ev);
    if (isMixed && /^(선수권|U18|U20|일반|대학)$/.test(e['종별'])) {
        e['종별'] = `${e['종별']}(혼)`;
    }
    // 종목 셀에 줄바꿈 들어간 케이스 정리 (4x400mR\n(믹스릴레이) → 4x400mR(믹스릴레이))
    if (e['종목'].includes('\n')) {
        e['종목'] = e['종목'].split('\n').map(s => s.trim()).filter(Boolean).join('');
    }
});

// ─── 일자/구분/시간 정렬 ───
allEntries.sort((a, b) => {
    if (a._day !== b._day) return a._day - b._day;
    if (a._section !== b._section) return a._section === 'track' ? -1 : 1;
    return a._sortKey.localeCompare(b._sortKey);
});

console.log(`[info] 총 ${allEntries.length}개 행 추출`);
const dayCount = {};
allEntries.forEach(e => { dayCount[e._day] = (dayCount[e._day] || 0) + 1; });
Object.keys(dayCount).sort().forEach(d => console.log(`  - 제${d}일: ${dayCount[d]}건`));

// ─── 검증: 같은 시간/종목/종별/라운드 중복 0건이어야 함 ───
const dupKey = new Map();
allEntries.forEach((e, i) => {
    const k = `${e._day}|${e._section}|${e.시간}|${e.종목}|${e.종별}|${e.라운드}`;
    if (!dupKey.has(k)) dupKey.set(k, []);
    dupKey.get(k).push(i);
});
let dupCount = 0;
for (const [k, arr] of dupKey.entries()) {
    if (arr.length > 1) {
        dupCount++;
        if (dupCount <= 5) console.warn(`[warn] 중복: ${k} (${arr.length}건)`);
    }
}
if (dupCount > 0) console.warn(`[warn] 중복 키 ${dupCount}개`);
else console.log('[info] 중복 키 없음 ✓');

// ─── 엑셀 작성 ───
const sheetData = allEntries.map(e => ({
    '날짜': e['날짜'],
    '구분': e['구분'],
    '시간': e['시간'],
    '종목': e['종목'],
    '종별': e['종별'],
    '라운드': e['라운드'],
    '비고': e['비고'],
}));

const ws = XLSX.utils.json_to_sheet(sheetData, {
    header: ['날짜', '구분', '시간', '종목', '종별', '라운드', '비고']
});
ws['!cols'] = [
    { wch: 16 }, { wch: 6 }, { wch: 8 }, { wch: 14 },
    { wch: 22 }, { wch: 16 }, { wch: 16 },
];

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, '시간표');
XLSX.writeFile(wb, outputXlsx);

console.log(`[done] 출력: ${outputXlsx}`);
