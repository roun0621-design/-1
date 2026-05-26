/**
 * 해남 2026 데일리 조편성 변환기
 * 입력: 데일리 엑셀 (블록 형식: 섹션→종목→조→선수)
 * 출력: 단일 시트 "조편성" — 9열 스키마
 *
 * 출력 스키마:
 *   A: 성별 (남/여/혼성)
 *   B: 종목 (예: 200m, [10종] 110mH, 4x400mR(Mixed))
 *   C: 라운드 (예선/결승)
 *   D: 조 (1, 2, 3, ...)
 *   E: 그룹 (A/B) — 5000m/10000m만 해당
 *   F: 순서 (레인 번호 또는 시기 순서)
 *   G: 배번 (릴레이: 비움 = NULL)
 *   H: 성명 (릴레이: 팀명)
 *   I: 소속
 *
 * 릴레이 규칙: 1팀 = 1행, 배번 비우고 성명에 팀명(=소속) 입력
 */

const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

// ── 헬퍼: 행에서 첫 번째 non-null 컬럼의 인덱스 찾기 ──
function firstNonNullIdx(row) {
    if (!row) return -1;
    for (let i = 0; i < row.length; i++) {
        const v = row[i];
        if (v !== null && v !== undefined && String(v).trim() !== '') return i;
    }
    return -1;
}

// ── 헬퍼: 행이 비어있는지 ──
function isEmptyRow(row) {
    if (!row) return true;
    return !row.some(c => c !== null && c !== undefined && String(c).trim() !== '');
}

// ── 헬퍼: 텍스트 정규화 ──
function clean(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/\s+/g, ' ').trim();
}

// ── 섹션 헤더 파싱: "▣ 남자대학교부" / "▣ 대학교부" / "남자실업부" / "실업부" ──
//    반환: { gender: '남'|'여'|'혼성', division: '대학교부'|'실업부' } 또는 null
function parseSection(text) {
    const t = clean(text).replace(/^▣\s*/, '');
    // 혼성 (성별 prefix 없음)
    const mMixed = /^(대학교부|실업부)$/.exec(t);
    if (mMixed) return { gender: '혼성', division: mMixed[1] };
    // 남자/여자
    const m = /^(남자|여자)(대학교부|실업부)$/.exec(t);
    if (m) return { gender: m[1] === '남자' ? '남' : '여', division: m[2] };
    return null;
}

// ── 종목 헤더 파싱: "▣ 200m (3-1+5)" / "▣ 110mH(10종)  " / "▣ 4x400mR(Mixed) (결승)" ──
//    반환: { event: '200m', round: '예선'|'결승', combined: '10종'|'7종'|null }
function parseEventHeader(text) {
    const t = clean(text).replace(/^▣\s*/, '');
    if (!t) return null;
    // (10종) / (7종) 어노테이션 추출 — 종목명에 바로 붙어있을 수도 있음: "110mH(10종)"
    let combined = null;
    let body = t;
    const mCombined = /\((10종|7종)\)\s*/.exec(body);
    if (mCombined) {
        combined = mCombined[1];
        body = body.replace(mCombined[0], '').trim();
    }
    // 라운드 추출: "(결승)" 명시 / "(N-X+Y)" 형식 = 예선 / 그 외 단독 = 결승
    let round = '결승';
    const mRound = /\(([^)]+)\)\s*$/.exec(body);
    if (mRound) {
        const inside = mRound[1].trim();
        if (inside === '결승') {
            round = '결승';
        } else if (/^\d+-\d+\+\d+$/.test(inside) || /^\d+\s*-\s*\d+\s*\+\s*\d+$/.test(inside)) {
            round = '예선';
        } else if (/예선/.test(inside)) {
            round = '예선';
        } else if (/결승/.test(inside)) {
            round = '결승';
        }
        // 결승/예선이 아닌 다른 괄호(예: Mixed)는 종목명의 일부이므로 유지
        if (inside === '결승' || /^\d+-\d+\+\d+$/.test(inside) || inside === '예선') {
            body = body.replace(mRound[0], '').trim();
        }
    } else {
        // 괄호 표기 없음 → 결승 (또는 단일 라운드)
        round = '결승';
    }
    // 빈 종목명 방어
    if (!body) return null;
    return { event: body, round, combined };
}

// ── 종합경기 sub-event 종목명 포맷팅 ──
function formatEventName(event, combined) {
    if (combined === '10종') return `[10종] ${event}`;
    if (combined === '7종') return `[7종] ${event}`;
    return event;
}

// ── 그룹 컬럼 적용 여부 (5000m/10000m만 A/B 그룹 구분) ──
function shouldHaveGroup(eventName) {
    // 정확한 트랙 종목만: 5000m, 10000m (walk/sub-event 제외)
    // 10000mW는 walking이므로 제외, 5000mW도 마찬가지
    const e = eventName.replace(/\s+/g, '');
    return /^5000m$/.test(e) || /^10000m$/.test(e);
}

// ── 릴레이 종목 판정 ──
function isRelay(eventName) {
    return /^\d+\s*x\s*\d+m?R(\(Mixed\))?$/i.test(eventName.replace(/\s+/g, ''));
}

// ── 조 헤더 인식: "1조", "2조", "A조", "B조" ──
//    반환: { heatNum: 1, group: null } 또는 { heatNum: 1, group: 'A' }
function parseHeatLabel(text) {
    const t = clean(text);
    // "1조 A" / "1조A" 형식
    let m = /^(\d+)조\s*([AB])$/.exec(t);
    if (m) return { heatNum: parseInt(m[1], 10), group: m[2] };
    // "A조" / "B조" 형식
    m = /^([AB])조$/.exec(t);
    if (m) return { heatNum: 1, group: m[1] };
    // "1조" 형식
    m = /^(\d+)조$/.exec(t);
    if (m) return { heatNum: parseInt(m[1], 10), group: null };
    return null;
}

// ── 메인 변환 함수 ──
function convertWorkbook(inputPath, outputPath, label) {
    console.log(`\n=== Converting: ${label} ===`);
    console.log(`  Input:  ${inputPath}`);
    const wb = XLSX.readFile(inputPath);

    const allRows = []; // 최종 출력 행들

    let stats = {
        sections: 0,
        events: 0,
        heats: 0,
        athletes: 0,
        relayTeams: 0,
        combinedSubs: 0,
    };

    for (const sheetName of wb.SheetNames) {
        const ws = wb.Sheets[sheetName];
        const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false });
        console.log(`  Sheet "${sheetName}": ${data.length} rows`);

        // 상태 머신
        let curSection = null;      // { gender, division }
        let curEvent = null;        // { event, round, combined, displayName, isRelay, hasGroup }
        let curHeat = null;         // { heatNum, group }
        let curRelayTeam = null;    // { lane, teamName, bib } — 1팀당 1번만 emit
        let columnHeaders = null;   // 가장 최근 본 컬럼 헤더 행 (레인/번호/성명/소속)
        let colMap = null;          // 컬럼 인덱스 매핑

        for (let r = 0; r < data.length; r++) {
            const row = data[r];
            if (isEmptyRow(row)) continue;

            const firstIdx = firstNonNullIdx(row);
            const firstVal = clean(row[firstIdx]);

            // === 1) 섹션 헤더 감지 ===
            // 섹션 헤더는 보통 col 0에 위치하고 다른 컬럼들은 비어있음
            const onlyFirst = row.filter((c, i) => i !== firstIdx && c !== null && clean(c) !== '').length === 0;
            if (onlyFirst) {
                const sec = parseSection(firstVal);
                if (sec) {
                    curSection = sec;
                    curEvent = null;
                    curHeat = null;
                    curRelayTeam = null;
                    stats.sections++;
                    console.log(`    [Section] ${sec.gender} ${sec.division}`);
                    continue;
                }
                // === 2) 종목 헤더 감지 ===
                if (firstVal.startsWith('▣')) {
                    const evt = parseEventHeader(firstVal);
                    if (evt) {
                        const displayName = formatEventName(evt.event, evt.combined);
                        curEvent = {
                            ...evt,
                            displayName,
                            isRelay: isRelay(evt.event),
                            hasGroup: shouldHaveGroup(evt.event),
                        };
                        curHeat = null;
                        curRelayTeam = null;
                        stats.events++;
                        if (evt.combined) stats.combinedSubs++;
                        continue;
                    }
                }
            }

            // === 3) 컬럼 헤더 행 감지 ===
            //    Row pattern: [조라벨 또는 null, '레인'|'순'|' ', '번호', '성명', '소속', (원소속)?]
            //    or pro file: [null, 조라벨, '레인', '번호', '성명', '소속']
            //    헤더 행에는 반드시 '번호' / '성명' / '소속' 등이 포함됨
            const rowJoined = row.map(c => clean(c)).join('|');
            const isHeaderRow = /번호.*성명.*소속/.test(rowJoined) || /레인.*번호.*성명/.test(rowJoined) || /^.*\|순\|번호\|성명\|소속/.test(rowJoined);

            if (isHeaderRow) {
                // 조 라벨이 같은 행에 있을 수 있음 (대학부 형식: ["1조","레인",...])
                // 헤더 컬럼 매핑
                colMap = { lane: -1, bib: -1, name: -1, team: -1 };
                for (let i = 0; i < row.length; i++) {
                    const v = clean(row[i]);
                    if (v === '레인' || v === '순' || v === '순서') colMap.lane = i;
                    else if (v === '번호') colMap.bib = i;
                    else if (v === '성명') colMap.name = i;
                    else if (v === '소속') colMap.team = i;
                    // 원소속은 무시
                }
                columnHeaders = row;
                // 같은 행에 조 라벨이 있는지 확인
                // 헤더 컬럼이 아닌 곳에 X조 형식이 있으면 그것이 heat label
                for (let i = 0; i < row.length; i++) {
                    if (i === colMap.lane || i === colMap.bib || i === colMap.name || i === colMap.team) continue;
                    const v = clean(row[i]);
                    if (!v) continue;
                    const hl = parseHeatLabel(v);
                    if (hl) {
                        curHeat = hl;
                        curRelayTeam = null;
                        stats.heats++;
                        break;
                    }
                }
                continue;
            }

            // === 4) 조 라벨 단독 행 (대학부에는 없음, 실업부에서 가끔 발생) ===
            if (onlyFirst) {
                const hl = parseHeatLabel(firstVal);
                if (hl) {
                    curHeat = hl;
                    curRelayTeam = null;
                    stats.heats++;
                    continue;
                }
            }

            // === 5) 선수 데이터 행 ===
            //    헤더가 없거나 종목/섹션이 없으면 스킵
            if (!curSection || !curEvent || !colMap) continue;

            const laneRaw = colMap.lane >= 0 ? clean(row[colMap.lane]) : '';
            const bibRaw = colMap.bib >= 0 ? clean(row[colMap.bib]) : '';
            const nameRaw = colMap.name >= 0 ? clean(row[colMap.name]) : '';
            const teamRaw = colMap.team >= 0 ? clean(row[colMap.team]) : '';

            // 기록할 만한 데이터가 없으면 스킵
            if (!bibRaw && !nameRaw && !teamRaw) continue;

            // 조 정보 보강: 조 라벨이 같은 행 데이터 셀에 들어있는 경우 (드물지만)
            // 일반적으로 colMap.lane은 lane number만 가짐

            // 조 정보 없으면 임시로 1조 처리하지 말고, curHeat를 초기화
            if (!curHeat) {
                // 일부 종목은 조 헤더 없이 바로 선수 나열 (드물지만 결승 단일 조)
                curHeat = { heatNum: 1, group: null };
                stats.heats++;
            }

            // === 5-A) 릴레이 처리: 1팀 = 1행 ===
            if (curEvent.isRelay) {
                // lane이 있으면 새 팀 시작 → 1행 emit
                // lane이 비어있으면 이전 팀의 멤버 → 스킵 (이미 1행 emit 완료)
                if (laneRaw) {
                    // 팀명: 소속 (=원소속과 동일)
                    const teamName = teamRaw || nameRaw; // 팀명 추출
                    const teamFallback = teamRaw || teamName;
                    curRelayTeam = {
                        lane: laneRaw,
                        teamName: teamName, // 첫 멤버의 소속 = 팀명
                    };
                    allRows.push([
                        curSection.gender,                    // A 성별
                        curEvent.displayName,                 // B 종목
                        curEvent.round,                       // C 라운드
                        curHeat.heatNum,                      // D 조
                        curHeat.group || '',                  // E 그룹
                        laneRaw,                              // F 순서(레인)
                        '',                                   // G 배번 (NULL)
                        teamName,                             // H 성명(팀명)
                        teamFallback,                         // I 소속
                    ]);
                    stats.relayTeams++;
                }
                // lane이 비어있으면 멤버 → 스킵
                continue;
            }

            // === 5-B) 일반 종목: 1선수 = 1행 ===
            // 순서(F): lane이 있으면 lane, 아니면 행 순번
            const order = laneRaw;

            allRows.push([
                curSection.gender,             // A 성별
                curEvent.displayName,          // B 종목
                curEvent.round,                // C 라운드
                curHeat.heatNum,               // D 조
                (curEvent.hasGroup ? (curHeat.group || '') : ''), // E 그룹 (5000m/10000m만)
                order,                         // F 순서
                bibRaw,                        // G 배번
                nameRaw,                       // H 성명
                teamRaw,                       // I 소속
            ]);
            stats.athletes++;
        }
    }

    // === 출력 워크북 생성 ===
    const outWb = XLSX.utils.book_new();
    const header = ['성별', '종목', '라운드', '조', '그룹', '순서', '배번', '성명', '소속'];
    const sheetData = [header, ...allRows];
    const outWs = XLSX.utils.aoa_to_sheet(sheetData);

    // 컬럼 너비 설정
    outWs['!cols'] = [
        { wch: 6 },   // A 성별
        { wch: 18 },  // B 종목
        { wch: 8 },   // C 라운드
        { wch: 6 },   // D 조
        { wch: 6 },   // E 그룹
        { wch: 6 },   // F 순서
        { wch: 8 },   // G 배번
        { wch: 18 },  // H 성명
        { wch: 22 },  // I 소속
    ];

    XLSX.utils.book_append_sheet(outWb, outWs, '조편성');
    XLSX.writeFile(outWb, outputPath);

    console.log(`  Output: ${outputPath}`);
    console.log(`  Stats:`, stats);
    console.log(`  Total rows emitted: ${allRows.length}`);
    return { stats, rowCount: allRows.length };
}

// ── 실행 ──
if (require.main === module) {
    const outDir = path.join(__dirname, 'output');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const r1 = convertWorkbook(
        '/tmp/in2/univ_day2.xlsx',
        path.join(outDir, '2026_해남_대학부_2일차_조편성.xlsx'),
        '대학부 2일차'
    );

    const r2 = convertWorkbook(
        '/tmp/in2/pro_day2.xlsx',
        path.join(outDir, '2026_해남_실업부_2일차_조편성.xlsx'),
        '실업부 2일차'
    );

    console.log('\n=== Summary ===');
    console.log('대학부:', r1.stats, 'rows:', r1.rowCount);
    console.log('실업부:', r2.stats, 'rows:', r2.rowCount);
}

module.exports = { convertWorkbook };
