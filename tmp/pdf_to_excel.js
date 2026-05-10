// PDF roster → 정규화된 Excel 변환기 (v2 — 페이지 단위 부 라벨 + 정확 레인 추출)
//
// 변경점 (v1 → v2):
//   1) 부 라벨 = "페이지 단위" 로 적용한다.
//      PDF는 페이지 마커(-NN-) 사이에 종목/조/선수 데이터가 있고, 부 라벨은 그 페이지의 끝부분에 등장한다.
//      따라서 어떤 행의 부는 "그 행이 속한 페이지의 부 라벨" 이며, 다음 페이지의 라벨로 새지 않는다.
//      (v1 의 getDivisionForLine 은 다음 부 라벨로 흘러넘쳐 여초 5/6 → 남중 같은 오류를 냈다.)
//
//   2) 레인/배번 추출을 케이스별로 분기한다.
//      - "1조레인번호성명소속" (붙어있는 헤더, u18/u20 형식): 다음 행은 [레인1자리][배번1~3자리][한글이름][한글소속]
//      - "1조  레인 번호 성명 소속" (공백 구분 헤더, 꿈나무 형식): "  3   22배윤우    학교명" 패턴
//      - 이름이 다음 줄로 잘린 경우(소속 누락 행) 다음 줄을 소속으로 합친다.
//
//   3) 마지막 페이지처럼 부 라벨이 없는 페이지는 직전 페이지의 부를 상속받는다.
//
// 컬럼: day | event_name | round | round_type | heat | lane | bib_number | athlete_name | team | division | gender | source_pdf

const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const XLSX = require('xlsx');

// ── 부 라벨 정규화 ──
function normalizeDivisionLabel(div) {
    if (!div) return '';
    const s = div.toString().trim().replace(/\s+/g, '');
    if (!s) return '';
    if (/^선수권\(?남자?\)?부?$/.test(s) || s === '선수권남' || s === '남자선수권') return '선수권(남)';
    if (/^선수권\(?여자?\)?부?$/.test(s) || s === '선수권여' || s === '여자선수권') return '선수권(여)';
    if (/^선수권\(?혼성?\)?부?$/.test(s) || /^선수권\(?mix/i.test(s)) return '선수권(혼)';
    if (s === '선수권') return '선수권';
    let m = s.match(/^U(18|20)\(?(남자?|여자?|혼성?)\)?부?$/i);
    if (m) {
        const g = /^남/.test(m[2]) ? '남' : (/^여/.test(m[2]) ? '여' : '혼');
        return `U${m[1]}(${g})`;
    }
    if (/^U18$/i.test(s)) return 'U18';
    if (/^U20$/i.test(s)) return 'U20';
    if (/^(남자|여자)?(중학교부|중학부|중등부)$/.test(s)) return '중등부';
    if (/^(남자|여자)?(고등학교부|고등부)$/.test(s)) return '고등부';
    if (/^(남자|여자)?(대학교부|대학부)$/.test(s)) return '대학부';
    if (/^(남자|여자)?(초등학교부|초등부)$/.test(s)) return '초등부';
    if (/^(남자|여자)?(일반부|실업부)$/.test(s)) return '일반부';
    return div.toString().trim();
}

// ── 부 라벨 라인 → {gender, division, sublabel} ──
// sublabel 은 학년부 등의 보조정보 (예: "5/6학년부", "1/2학년부", "4학년부") — 같은 base division 안에서 추가 분리용
function parseDivisionMarker(line) {
    let m;
    m = line.match(/^(남|여)초\s*([\d/]+학년부)?$/);
    if (m) return { gender: m[1]==='남'?'M':'F', division: '초등부', sublabel: m[2] || '' };
    m = line.match(/^(남|여)중\s*([\d/]+학년부)?$/);
    if (m) return { gender: m[1]==='남'?'M':'F', division: '중등부', sublabel: m[2] || '' };
    m = line.match(/^(남|여)고\s*([\d/]+학년부)?$/);
    if (m) return { gender: m[1]==='남'?'M':'F', division: '고등부', sublabel: m[2] || '' };
    m = line.match(/^(남|여)대\s*([\d/]+학년부)?$/);
    if (m) return { gender: m[1]==='남'?'M':'F', division: '대학부', sublabel: m[2] || '' };
    m = line.match(/^선수권\s*(남자|여자|혼성)부?$/);
    if (m) {
        const g = m[1]==='남자'?'M':(m[1]==='여자'?'F':'X');
        const dv = m[1]==='남자'?'선수권(남)':(m[1]==='여자'?'선수권(여)':'선수권(혼)');
        return { gender: g, division: dv, sublabel: '' };
    }
    m = line.match(/^U(18|20)\s*(남자|여자|혼성)부?$/i);
    if (m) {
        const g = m[2]==='남자'?'M':(m[2]==='여자'?'F':'X');
        const dv = `U${m[1]}(${m[2]==='남자'?'남':(m[2]==='여자'?'여':'혼')})`;
        return { gender: g, division: dv, sublabel: '' };
    }
    m = line.match(/^꿈나무\s*(남자|여자)부?$/);
    if (m) return { gender: m[1]==='남자'?'M':'F', division: '초등부', sublabel: '꿈나무' };
    return { gender: '', division: '', sublabel: '' };
}

const divMarkerRegex = new RegExp(
    '^(?:' +
    '(?:남|여)초(?:\\s*[\\d/]+학년부)?' +
    '|(?:남|여)중(?:\\s*[\\d/]+학년부)?' +
    '|(?:남|여)고(?:\\s*[\\d/]+학년부)?' +
    '|(?:남|여)대(?:\\s*[\\d/]+학년부)?' +
    '|선수권\\s*(?:남자|여자|혼성)부?' +
    '|U(?:18|20)\\s*(?:남자|여자|혼성)부?' +
    '|꿈나무\\s*(?:남자|여자)부?' +
    ')$', 'i'
);

// ── 라운드 정규화 ──
function classifyRound(roundStr) {
    const orig = (roundStr || '').trim();
    if (!orig) return 'final';
    if (/(\d+)종/.test(orig)) return 'final';
    if (orig.startsWith('자격')) return 'preliminary';
    if (orig.includes('예선')) return 'preliminary';
    if (orig.startsWith('준결') || /^준\s*\d+-\d+/.test(orig)) return 'semifinal';
    if (/^\d+-\d+/.test(orig)) return 'preliminary';
    if (orig.startsWith('결승')) return 'final';
    if (/^mixed/i.test(orig)) return 'final';
    return 'final';
}

// ── 학교/팀 추출 ──
const TEAM_INDICATORS = [
    '중학교','고등학교','대학교','대학','시청','군청','도청','체육회',
    '도시개발공사','개발공사','국군체육부대','구청','스포츠클럽','공사',
    '클럽_중','클럽_고','클럽_초','체육부대','종합고등학교','과학기술고등학교',
    '여자고등학교','여자중학교','체육중학교','체육고등학교',
];

function isTeamName(s) {
    return TEAM_INDICATORS.some(ind => s.includes(ind));
}

// ── 한글덩어리에서 [이름][소속] 분리 ──
function splitNameTeam(koreanPart) {
    if (!koreanPart) return { name: '', team: '' };
    const s = koreanPart.trim();
    if (s.length < 2) return { name: s, team: '' };
    // 무소속(지역)
    const muso = s.match(/^(.{2,4})(무소속\(.+\))$/);
    if (muso) return { name: muso[1], team: muso[2] };

    // 이름 길이 후보 [3, 2, 4]
    for (const nameLen of [3, 2, 4]) {
        if (nameLen >= s.length) continue;
        const team = s.substring(nameLen);
        if (isTeamName(team)) return { name: s.substring(0, nameLen), team };
    }
    // 폴백: 5자 이상이면 앞 3자 이름, 나머지 소속
    if (s.length >= 5) return { name: s.substring(0, 3), team: s.substring(3) };
    return { name: s, team: '' };
}

// ── 한 페이지 내 행 파싱 ──
// pageLines: 페이지 안의 라인 배열 (페이지 마커 제외)
// pageDiv: { gender, division, sublabel } — 이 페이지에 적용할 부
//
// 핵심 아이디어: 순(順) / 레인(lane) 은 같은 종목 / 같은 조 안에서 1부터 N 까지 연속 증가한다.
//   → 직전 행의 순/레인을 추적해서 "다음 행은 prevSeq+1 로 시작" 한다는 제약으로
//     붙어있는 숫자 덩어리에서 순(1~99)과 배번(1~9999)을 정확히 분리한다.
function parsePageLines(pageLines, pageDiv) {
    const entries = [];
    let currentEvent = '', currentRound = '';
    let currentHeat = null;
    let lastEntryIdx = -1;
    let lastSeq = 0; // 직전 행의 순 또는 레인 (현 종목/조 안에서 누적)

    for (let i = 0; i < pageLines.length; i++) {
        const line = pageLines[i];
        if (!line) continue;
        if (divMarkerRegex.test(line)) continue; // 페이지 끝 부 라벨 스킵
        if (/^(KTFL|KOREA|TRACK|FIELD|LEAGUE|&|한국실업육상연맹|한국중고육상연맹|한국대학육상연맹|한국육상연맹|대한육상연맹)$/.test(line)) continue;

        // 종목 라인 ▣ 80m (2-3+2) 또는 ▣ 100m(준4-2)
        const evMatch = line.match(/^[▣■□●○]\s*(.+?)\s*[\(（](.+?)[\)）]\s*$/);
        if (evMatch) {
            currentEvent = evMatch[1].trim();
            currentRound = evMatch[2].trim();
            currentHeat = null;
            lastEntryIdx = -1;
            lastSeq = 0;
            continue;
        }

        // 조 헤더: "1조   레인  번호성명소속" 또는 "1조레인번호성명소속" 또는 "순번호성명소속"
        const heatMatch = line.match(/^(\d+)조\s*(?:레인|순)?\s*(?:번호)?\s*(?:성명)?\s*(?:소속)?\s*$/);
        if (heatMatch) {
            currentHeat = parseInt(heatMatch[1]);
            lastEntryIdx = -1;
            lastSeq = 0; // 새 조 시작 → 레인 카운터 리셋
            continue;
        }
        // "순번호성명소속" — 트랙은 아니지만 필드 종목의 통합 헤더
        if (/^(순|레인|번호)\s*(번호|성명|소속)?/.test(line) && !/\d{2,}/.test(line)) {
            // heat 없는 종목 (필드)
            currentHeat = currentHeat || null;
            lastSeq = 0; // 헤더 등장 → 카운터 리셋
            continue;
        }

        if (!currentEvent) continue;

        // 데이터 행 패턴 분리
        let lane = null, bib = '', namePart = '', teamPart = '';

        // ── 헬퍼: 붙어있는 숫자열 digits 에서 (순/레인, 배번) 분리 ──
        // expectedSeq = lastSeq + 1 (다음에 와야 할 순)
        // 우선순위:
        //   1) digits 가 expectedSeq 두자리(예: "10", "11")로 시작 + 나머지 길이 ≥ 1 → 순=두자리
        //   2) digits 첫 한자리가 expectedSeq 와 일치 + 나머지 길이 ≥ 1 → 순=한자리
        //   3) 폴백: 첫 한자리(1~9)를 순, 나머지를 배번 (단 expectedSeq 가 10 이상이고
        //      digits 두자리가 expectedSeq 면 무조건 두자리 우선)
        function splitSeqAndBib(digits, expectedSeq) {
            if (!digits) return { seq: null, bib: '' };
            // 두자리 순 매칭 시도 (expectedSeq ≥ 10 이거나, 다음에 와야 할 순이 두자리인 경우)
            if (digits.length >= 3 && expectedSeq >= 10) {
                const twoDigit = parseInt(digits.substring(0, 2));
                if (twoDigit === expectedSeq) {
                    return { seq: twoDigit, bib: digits.substring(2) };
                }
            }
            // 한자리 순 매칭
            if (digits.length >= 2) {
                const oneDigit = parseInt(digits[0]);
                if (oneDigit === expectedSeq && expectedSeq >= 1 && expectedSeq <= 9) {
                    return { seq: oneDigit, bib: digits.substring(1) };
                }
            }
            // expectedSeq 가 모르거나 어긋나는 경우(첫 행/PDF 결손/리셋)
            // → 휴리스틱: digits 두자리(10~99)로 시작 + 나머지 ≥ 1 면 두자리 순으로 가정
            if (digits.length >= 3) {
                const twoDigit = parseInt(digits.substring(0, 2));
                // 두자리가 10~99 범위 + (expectedSeq 가 0이거나 두자리와 일치/근접)
                if (twoDigit >= 10 && twoDigit <= 99) {
                    // 이전 순 추적이 끊긴 케이스에서도 두자리 우선 시도
                    // 단, 두자리 순 다음 자리들이 모두 숫자 + 길이 ≥ 1 조건 만족 시
                    return { seq: twoDigit, bib: digits.substring(2) };
                }
            }
            // 최종 폴백: 한자리 순
            if (digits.length >= 2) {
                return { seq: parseInt(digits[0]), bib: digits.substring(1) };
            }
            return { seq: null, bib: digits };
        }

        // 패턴 A/B: "5   31양지은    학교" (공백 구분 — 꿈나무 형식)
        //   순/레인이 한자리만 노출되는 케이스 (PDF 자체가 1~9만 사용)
        const aMatch = line.match(/^([1-9])\s+(\d{1,3})\s*([가-힣]{2,4})(?:\s{2,}(.+))?\s*$/);
        if (aMatch) {
            lane = parseInt(aMatch[1]);
            bib = aMatch[2];
            namePart = aMatch[3];
            teamPart = (aMatch[4] || '').trim();
        } else {
            // 패턴 A2: "10  149김인혜    학교" (공백 구분, 두자리 순)
            const aMatch2 = line.match(/^(\d{1,2})\s{2,}(\d{1,3})\s*([가-힣]{2,4})(?:\s{2,}(.+))?\s*$/);
            if (aMatch2) {
                lane = parseInt(aMatch2[1]);
                bib = aMatch2[2];
                namePart = aMatch2[3];
                teamPart = (aMatch2[4] || '').trim();
            } else {
                // 패턴 C/D: "2245명민준마산구암고등학교" 또는 "10657우상혁용인시청" (모두 붙어있음)
                const m = line.match(/^(\d+)([가-힣].+)$/);
                if (m) {
                    const digits = m[1];
                    const rest = m[2];
                    const expectedSeq = lastSeq + 1;
                    const split = splitSeqAndBib(digits, expectedSeq);
                    lane = split.seq;
                    bib = split.bib;
                    const nt = splitNameTeam(rest);
                    namePart = nt.name;
                    teamPart = nt.team;
                }
            }
        }

        // 유효성 검증
        const bibNum = parseInt(bib);
        if (!namePart || namePart.length < 2 || !bibNum || bibNum <= 0 || bibNum >= 10000) {
            // 데이터 행이 아닐 수 있음 — 직전 entry 의 소속 보강 시도
            if (/^[가-힣A-Za-z_()（）]/.test(line) && lastEntryIdx >= 0
                && entries[lastEntryIdx] && !entries[lastEntryIdx].team
                && !line.startsWith('▣')) {
                entries[lastEntryIdx].team = line;
            }
            continue;
        }

        entries.push({
            event_name: currentEvent,
            round: currentRound,
            heat: currentHeat,
            lane,
            bib_number: bib,
            athlete_name: namePart,
            team: teamPart,
            division: normalizeDivisionLabel(pageDiv.division),
            gender: pageDiv.gender,
            sublabel: pageDiv.sublabel || '',
        });
        lastEntryIdx = entries.length - 1;
        // 다음 행의 expectedSeq 추적 — 정상 push 됐고 lane(=순/레인)이 lastSeq+1 인 경우만 갱신
        if (typeof lane === 'number' && lane > 0 && lane === lastSeq + 1) {
            lastSeq = lane;
        } else if (typeof lane === 'number' && lane > lastSeq) {
            // 페이지 결손 등으로 점프했더라도 레인 자체가 단조증가면 따라간다
            lastSeq = lane;
        }
    }

    return entries;
}

// ── PDF 한 개 → 페이지 단위 분할 후 파싱 ──
async function parseRosterPDF(pdfPath, fallbackHint) {
    const buf = fs.readFileSync(pdfPath);
    const data = await pdfParse(buf);
    const lines = data.text.split('\n').map(l => l.trim()).filter(Boolean);

    // 페이지 마커(-NN-)로 페이지 분할
    const pages = [];
    let curPage = [];
    for (const l of lines) {
        if (/^-\d+-$/.test(l)) {
            if (curPage.length) pages.push(curPage);
            curPage = [];
        } else {
            curPage.push(l);
        }
    }
    if (curPage.length) pages.push(curPage);

    // 각 페이지의 부 라벨 = 그 페이지 안에서 마지막에 등장하는 divMarkerRegex 매칭 라인
    const fallbackParsed = fallbackHint ? parseDivisionMarker(fallbackHint) : null;
    let lastDiv = (fallbackParsed && fallbackParsed.division) ? fallbackParsed : { gender: '', division: '', sublabel: '' };

    const allEntries = [];
    for (const page of pages) {
        // 부 라벨 탐색
        let pageDiv = null;
        for (const l of page) {
            if (divMarkerRegex.test(l)) {
                pageDiv = parseDivisionMarker(l);
                if (pageDiv && pageDiv.division) break; // 첫 매칭 채택
            }
        }
        // 페이지에 부 라벨이 없으면 직전 페이지 부 상속
        const effDiv = (pageDiv && pageDiv.division) ? pageDiv : lastDiv;
        if (effDiv.division) lastDiv = effDiv;

        const pageEntries = parsePageLines(page, effDiv);
        for (const e of pageEntries) allEntries.push(e);
    }

    return allEntries;
}

(async () => {
    const baseDir = path.join(__dirname);
    const pdfFiles = [
        { file: 'roster_kkumnamu.pdf', hint: '꿈나무 남자부' },
        { file: 'roster_seonsugwon.pdf', hint: '선수권 남자부' },
        { file: 'roster_u18.pdf', hint: 'U18 남자부' },
        { file: 'roster_u20.pdf', hint: 'U20 남자부' },
    ];

    const allRows = [];
    for (const { file, hint } of pdfFiles) {
        console.log(`Processing ${file}...`);
        const entries = await parseRosterPDF(path.join(baseDir, file), hint);
        for (const e of entries) {
            allRows.push({
                day: 1,
                event_name: e.event_name,
                round: e.round,
                round_type: classifyRound(e.round),
                heat: e.heat || '',
                lane: e.lane || '',
                bib_number: e.bib_number,
                athlete_name: e.athlete_name,
                team: e.team,
                division: e.division,
                sublabel: e.sublabel || '',
                gender: e.gender,
                source_pdf: file,
            });
        }
        console.log(`  → ${entries.length} entries`);
    }

    // ── 부/성별 분포 출력 (검증용) ──
    const stats = {};
    for (const r of allRows) {
        const key = `${r.division}|${r.gender}|${r.sublabel || '-'}`;
        stats[key] = (stats[key] || 0) + 1;
    }
    console.log('\n=== 부/성별 분포 ===');
    Object.entries(stats).sort().forEach(([k, v]) => console.log(`  ${k}: ${v}`));

    // ── Excel 생성 ──
    const ws = XLSX.utils.json_to_sheet(allRows, {
        header: ['day','event_name','round','round_type','heat','lane','bib_number','athlete_name','team','division','sublabel','gender','source_pdf']
    });

    XLSX.utils.sheet_add_aoa(ws, [[
        '일차', '종목', '라운드', '라운드타입', '조', '레인', '배번', '성명', '소속', '부', '학년부', '성별', '원본PDF'
    ]], { origin: 'A1' });

    ws['!cols'] = [
        { wch: 6 },  { wch: 14 }, { wch: 16 }, { wch: 12 },
        { wch: 5 },  { wch: 6 },  { wch: 7 },  { wch: 10 },
        { wch: 24 }, { wch: 12 }, { wch: 10 }, { wch: 6 }, { wch: 22 },
    ];

    const readme = [
        ['PACE RISE 명단 Excel 양식 (v2 — 페이지 단위 부 라벨 적용)'],
        [''],
        ['이 파일은 PDF 명단을 자동 변환한 결과입니다.'],
        ['v2 변경: 부 라벨이 페이지 단위로 적용되어 v1 의 \"여초→남중\" 같은 오류를 해결.'],
        [''],
        ['컬럼 설명:'],
        ['  일차       1, 2, 3 ... (대회 첫날 = 1)'],
        ['  종목       100m, 200m, 멀리뛰기, 4x400mR 등'],
        ['  라운드     PDF 원본 라벨 (5-2+6, 결승, 7종 등)'],
        ['  라운드타입 preliminary | semifinal | final  (자동 분류, 필요시 수정)'],
        ['  조         heat 번호 (필드 종목은 비어있음)'],
        ['  레인       1~9 (트랙) 또는 순(필드, 1~99)'],
        ['  배번       선수 배번'],
        ['  성명       선수 이름'],
        ['  소속       팀/학교'],
        ['  부         초등부 / 중등부 / 고등부 / 대학부 / 일반부 / 선수권(남/여/혼) / U18(남/여/혼) / U20(남/여/혼)'],
        ['  학년부     "4학년부", "5/6학년부", "1/2학년부" 같은 보조 라벨 (없을 수 있음)'],
        ['  성별       M / F / X'],
        ['  원본PDF    참고용'],
        [''],
        ['업로드 시 매칭이 잘못된 행은 직접 수정하세요. 종목별 매칭은 관리 페이지의 \"매칭 수동 수정\" 모달에서도 가능합니다.'],
    ];
    const wsReadme = XLSX.utils.aoa_to_sheet(readme);
    wsReadme['!cols'] = [{ wch: 100 }];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsReadme, 'README');
    XLSX.utils.book_append_sheet(wb, ws, '명단');

    const outPath = path.join(baseDir, 'roster_converted.xlsx');
    XLSX.writeFile(wb, outPath);
    console.log(`\n✅ ${outPath} (${allRows.length} rows)`);
})().catch(e => { console.error(e); process.exit(1); });
