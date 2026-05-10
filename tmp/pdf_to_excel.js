// PDF roster → 정규화된 Excel 변환기 (v4 — 릴레이/혼성/순없음 헤더 처리)
//
// v3 → v4 변경점:
//   1) 릴레이 종목 처리:
//      - 종목명이 4xNNNm[R] / 4×NNNmR / 릴레이 등 → "팀 단위" 출력
//      - 첫 행(레인+첫주자+소속)에서 레인과 소속만 추출, 성명/배번 없음
//      - 같은 팀의 후속 3명(또는 그 이상) 라인은 스킵
//      - 다음 레인 등장 시 새 팀 행
//
//   2) 혼성경기 통합:
//      - 100m(10종), 멀리뛰기(10종), 포환던지기(10종), 높이뛰기(10종), 400m(10종) 5섹션 → 한 선수당 "10종경기" 1행
//      - 100mH(7종), 높이뛰기(7종), 포환던지기(7종), 200m(7종), 멀리뛰기(7종), 800m(7종) 6섹션 → 한 선수당 "7종경기" 1행
//      - 첫 등장한 세부종목의 레인/배번/소속만 보존, 이후 중복은 dedup
//
//   3) "N조레인번호성명소속" 헤더(공백 없이 붙음) 페이지에서 순(seq) 없는 패턴:
//      - 데이터 행은 [레인 1자리][배번 가변 1~3자리][한글 이름][한글 소속]
//      - 예: "236피서진경기금정초등학교" → 레인=2, 배번=36, 이름=피서진, 소속=경기금정초등학교
//      - 헤더 키워드 = 'noSeq' 모드 (lastSeq 추적 비활성화)
//
//   4) 소속이 다음 줄로 잘린 경우 직전 행에 합치기 (강화)
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

const TEAM_INDICATORS = [
    '중학교','고등학교','대학교','대학','시청','군청','도청','체육회',
    '도시개발공사','개발공사','국군체육부대','구청','스포츠클럽','공사',
    '클럽_중','클럽_고','클럽_초','체육부대','종합고등학교','과학기술고등학교',
    '여자고등학교','여자중학교','체육중학교','체육고등학교','초등학교',
];

function isTeamName(s) {
    if (!s) return false;
    return TEAM_INDICATORS.some(ind => s.includes(ind));
}

function splitNameTeam(koreanPart) {
    if (!koreanPart) return { name: '', team: '' };
    const s = koreanPart.trim();
    if (s.length < 2) return { name: s, team: '' };
    const muso = s.match(/^(.{2,4})(무소속\(.+\))$/);
    if (muso) return { name: muso[1], team: muso[2] };
    for (const nameLen of [3, 2, 4]) {
        if (nameLen >= s.length) continue;
        const team = s.substring(nameLen);
        if (isTeamName(team)) return { name: s.substring(0, nameLen), team };
    }
    if (s.length >= 5) return { name: s.substring(0, 3), team: s.substring(3) };
    return { name: s, team: '' };
}

// ── 종목 분류 ──
// 릴레이 종목 판별 — 4x100mR / 4x400mR / 4x800mR / 4x100m / 릴레이 등
function isRelayEvent(eventName) {
    if (!eventName) return false;
    return /\d\s*[x×Xx]\s*\d{2,4}\s*m?\s*R?/i.test(eventName)
        || /릴레이/.test(eventName)
        || /relay/i.test(eventName);
}

// 혼성경기(10종/7종) 세부종목 → 통합 종목명 매핑
// "100m(10종)" / round="10종" 등 → "10종경기", "100mH(7종)" → "7종경기"
function combinedEventName(eventName, round) {
    const text = `${eventName || ''} ${round || ''}`;
    const m10 = text.match(/(\d+)\s*종/);
    if (m10) return `${m10[1]}종경기`;
    return null;
}

// ── 한 페이지 내 행 파싱 ──
// noSeqHeader: true면 데이터 행에서 순(seq) 없이 [레인 1자리][배번][이름][소속] 으로 해석
function parsePageLines(pageLines, pageDiv) {
    const entries = [];
    let currentEvent = '', currentRound = '';
    let currentHeat = null;
    let lastEntryIdx = -1;
    let lastSeq = 0;
    let noSeqMode = false;     // 현재 종목/조에서 "순 없음" 모드 여부 (헤더 키워드로 판단)
    let relayMode = false;     // 현재 종목이 릴레이 여부
    let relayCurrentLane = null; // 릴레이 모드에서 현재 진행 중인 팀 레인
    let relayPushedForLane = false; // 현재 레인에 대해 이미 팀 행이 푸시되었는지

    for (let i = 0; i < pageLines.length; i++) {
        const line = pageLines[i];
        if (!line) continue;
        if (divMarkerRegex.test(line)) continue;
        if (/^(KTFL|KOREA|TRACK|FIELD|LEAGUE|&|한국실업육상연맹|한국중고육상연맹|한국대학육상연맹|한국육상연맹|대한육상연맹)$/.test(line)) continue;

        // 종목 라인 ▣ 80m (2-3+2) | ▣ 100m(준4-2) | ▣ 4x400mR(Mixed) (결승) | ▣ 4x800mR (결승)
        const evMatch = line.match(/^[▣■□●○]\s*(.+?)\s*[\(（](.+?)[\)）]\s*(?:[\(（](.+?)[\)）]\s*)?$/);
        if (evMatch) {
            // (Mixed) 같은 1차 괄호가 종목명 일부일 수 있는 경우 처리
            // 이중 괄호 케이스 "▣ 4x400mR(Mixed) (결승)" → eventName="4x400mR(Mixed)" round="결승"
            // 단일 케이스 "▣ 100m (5-2+6)" → eventName="100m" round="5-2+6"
            if (evMatch[3]) {
                currentEvent = (evMatch[1] + '(' + evMatch[2] + ')').trim();
                currentRound = evMatch[3].trim();
            } else {
                currentEvent = evMatch[1].trim();
                currentRound = evMatch[2].trim();
            }
            currentHeat = null;
            lastEntryIdx = -1;
            lastSeq = 0;
            noSeqMode = false;
            relayMode = isRelayEvent(currentEvent);
            relayCurrentLane = null;
            relayPushedForLane = false;
            continue;
        }
        // ▣ 종목명 만 (라운드 없음) — 드물지만 처리
        const evMatch2 = line.match(/^[▣■□●○]\s*(.+?)\s*$/);
        if (evMatch2 && !/[\(（]/.test(line)) {
            currentEvent = evMatch2[1].trim();
            currentRound = '';
            currentHeat = null;
            lastEntryIdx = -1;
            lastSeq = 0;
            noSeqMode = false;
            relayMode = isRelayEvent(currentEvent);
            relayCurrentLane = null;
            relayPushedForLane = false;
            continue;
        }

        // 조 헤더: "1조   레인  번호성명소속" (공백 분리) 또는 "1조레인번호성명소속" (붙음) 또는 "1조"만
        const heatMatch = line.match(/^(\d+)조\s*((?:레인|순)?\s*(?:번호)?\s*(?:성명)?\s*(?:소속)?)?\s*$/);
        if (heatMatch) {
            currentHeat = parseInt(heatMatch[1]);
            lastEntryIdx = -1;
            lastSeq = 0;
            // 헤더 안에 공백이 있는지(=순 사용) 없는지(=순 없음) 판별
            // line 원본에서 첫 "조" 이후 공백 유무 체크
            const afterHeat = line.replace(/^\d+조/, '');
            // afterHeat 가 공백 없이 "레인번호성명소속" 처럼 붙어 있으면 noSeq 모드
            // afterHeat 가 비어있거나 공백 + 키워드 면 일반 모드
            if (afterHeat && /\S/.test(afterHeat) && !/\s/.test(afterHeat)) {
                noSeqMode = true;
            } else {
                noSeqMode = false;
            }
            relayCurrentLane = null;
            relayPushedForLane = false;
            continue;
        }

        // "레인번호성명소속" / "레인  번호성명소속" 형태의 비-조 헤더 (릴레이/필드 등)
        if (/^(?:레인|순)\s*(?:번호)?\s*(?:성명)?\s*(?:소속)?$/.test(line)) {
            lastSeq = 0;
            // 이 형태 헤더는 모두 "공백 분리 또는 키워드만" → noSeq 여부는 다음 데이터 행 자체로 판단
            // 일반적으로 릴레이 헤더("레인번호성명소속" 붙음)는 noSeq, 트랙 헤더("레인  번호성명소속" 공백)는 noSeq
            // 둘 다 순(seq)을 쓰지 않고 레인을 쓰므로 noSeqMode 켠다
            noSeqMode = true;
            currentHeat = currentHeat || null;
            relayCurrentLane = null;
            relayPushedForLane = false;
            continue;
        }
        // "순번호성명소속" — 필드 종목, 순 사용
        if (/^순\s*번호\s*성명\s*소속$/.test(line) || /^순번호성명소속$/.test(line)) {
            lastSeq = 0;
            noSeqMode = false;
            currentHeat = currentHeat || null;
            continue;
        }

        if (!currentEvent) continue;

        // ── splitSeqAndBib (lastSeq 추적용) ──
        function splitSeqAndBib(digits, expectedSeq) {
            if (!digits) return { seq: null, bib: '' };
            if (digits.length >= 3 && expectedSeq >= 10) {
                const twoDigit = parseInt(digits.substring(0, 2));
                if (twoDigit === expectedSeq) return { seq: twoDigit, bib: digits.substring(2) };
            }
            if (digits.length >= 2) {
                const oneDigit = parseInt(digits[0]);
                if (oneDigit === expectedSeq && expectedSeq >= 1 && expectedSeq <= 9)
                    return { seq: oneDigit, bib: digits.substring(1) };
            }
            if (digits.length >= 3) {
                const twoDigit = parseInt(digits.substring(0, 2));
                if (twoDigit >= 10 && twoDigit <= 99) return { seq: twoDigit, bib: digits.substring(2) };
            }
            if (digits.length >= 2) return { seq: parseInt(digits[0]), bib: digits.substring(1) };
            return { seq: null, bib: digits };
        }

        // ──────────── 릴레이 모드 ────────────
        if (relayMode) {
            // 패턴 R-A: "4   129김이겸    전곡고등학교" (공백 분리, 첫 행)
            //   → 레인=4, 팀=전곡고등학교 (팀명만 출력, 김이겸은 무시)
            let rA = line.match(/^([1-9])\s+\d{1,3}\s*[가-힣]{2,4}\s+(.+)$/);
            if (rA) {
                relayCurrentLane = parseInt(rA[1]);
                let team = rA[2].trim();
                entries.push({
                    event_name: currentEvent, round: currentRound, heat: currentHeat,
                    lane: relayCurrentLane, bib_number: '', athlete_name: '',
                    team, division: normalizeDivisionLabel(pageDiv.division),
                    gender: pageDiv.gender, sublabel: pageDiv.sublabel || '',
                });
                lastEntryIdx = entries.length - 1;
                relayPushedForLane = true;
                continue;
            }
            // 패턴 R-B: "4614민지현화성시청" (붙음, 첫 행)
            //   → 레인=4(첫자리), 배번/이름은 무시, 팀=뒤에 학교/팀 키워드 들어간 한글덩어리
            let rB = line.match(/^(\d+)([가-힣].+)$/);
            if (rB) {
                const digits = rB[1];
                const rest = rB[2];
                // 첫 행인지 후속 행인지 판단:
                //   - 첫 행: 첫 글자(레인)가 1~9 + 한글뒤에 팀키워드 존재
                //   - 후속 행: 팀 키워드 없거나 팀이 비어있음 (배번+이름만)
                const nt = splitNameTeam(rest);
                if (nt.team && isTeamName(nt.team)) {
                    // 첫 행 (레인 + 팀)
                    relayCurrentLane = parseInt(digits[0]);
                    entries.push({
                        event_name: currentEvent, round: currentRound, heat: currentHeat,
                        lane: relayCurrentLane, bib_number: '', athlete_name: '',
                        team: nt.team, division: normalizeDivisionLabel(pageDiv.division),
                        gender: pageDiv.gender, sublabel: pageDiv.sublabel || '',
                    });
                    lastEntryIdx = entries.length - 1;
                    relayPushedForLane = true;
                    continue;
                }
                // 후속 멤버 행 (팀 없는 배번+이름) → 스킵
                continue;
            }
            // 한글만 있는 라인 → 팀명이 다음 줄로 잘린 케이스 가능
            //   직전 entry 의 team 이 비어있으면 채우기
            if (/^[가-힣A-Za-z_()（）\s]+$/.test(line) && lastEntryIdx >= 0
                && entries[lastEntryIdx] && !entries[lastEntryIdx].team
                && isTeamName(line)) {
                entries[lastEntryIdx].team = line.trim();
                continue;
            }
            // 그 외(이름만 있는 후속 멤버) 스킵
            continue;
        }
        // ──────────── 일반 모드 ────────────

        let lane = null, bib = '', namePart = '', teamPart = '';

        // 패턴 A: "5   31양지은    학교" (공백 분리, 한자리 순/레인)
        const aMatch = line.match(/^([1-9])\s+(\d{1,3})\s*([가-힣]{2,4})(?:\s{2,}(.+))?\s*$/);
        if (aMatch) {
            lane = parseInt(aMatch[1]);
            bib = aMatch[2];
            namePart = aMatch[3];
            teamPart = (aMatch[4] || '').trim();
        } else {
            // 패턴 A2: "10  149김인혜    학교" (공백 분리, 두자리 순)
            const aMatch2 = line.match(/^(\d{1,2})\s{2,}(\d{1,3})\s*([가-힣]{2,4})(?:\s{2,}(.+))?\s*$/);
            if (aMatch2) {
                lane = parseInt(aMatch2[1]);
                bib = aMatch2[2];
                namePart = aMatch2[3];
                teamPart = (aMatch2[4] || '').trim();
            } else {
                // 패턴 C/D (붙음)
                const m = line.match(/^(\d+)([가-힣].+)$/);
                if (m) {
                    const digits = m[1];
                    const rest = m[2];
                    if (noSeqMode) {
                        // 순 없는 페이지: 첫 한자리=레인, 나머지=배번
                        lane = parseInt(digits[0]);
                        bib = digits.substring(1);
                    } else {
                        const expectedSeq = lastSeq + 1;
                        const split = splitSeqAndBib(digits, expectedSeq);
                        lane = split.seq;
                        bib = split.bib;
                    }
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
        if (typeof lane === 'number' && lane > 0 && lane === lastSeq + 1) {
            lastSeq = lane;
        } else if (typeof lane === 'number' && lane > lastSeq && !noSeqMode) {
            lastSeq = lane;
        }
    }

    return entries;
}

async function parseRosterPDF(pdfPath, fallbackHint) {
    const buf = fs.readFileSync(pdfPath);
    const data = await pdfParse(buf);
    const lines = data.text.split('\n').map(l => l.trim()).filter(Boolean);

    // 페이지 마커(-NN-) 제거 — 부 라벨은 페이지 경계를 무시하고 "라벨 등장 위치까지"에 적용
    const flatLines = lines.filter(l => !/^-\d+-$/.test(l));

    // 부 라벨 기반 섹션 분할:
    //   라벨 라인이 등장하면, 직전 라벨까지의 모든 라인 + 직전 라벨 행 자체를 묶어 한 섹션으로 만든다.
    //   섹션의 부 = 그 섹션 끝의 라벨.
    //   라벨 없이 끝나는 마지막 섹션은 직전 부를 상속.
    const fallbackParsed = fallbackHint ? parseDivisionMarker(fallbackHint) : null;
    const fallbackDiv = (fallbackParsed && fallbackParsed.division)
        ? fallbackParsed
        : { gender: '', division: '', sublabel: '' };

    const sections = [];
    let curSection = [];
    let lastDivSeen = fallbackDiv;
    for (const l of flatLines) {
        if (divMarkerRegex.test(l)) {
            const d = parseDivisionMarker(l);
            if (d && d.division) {
                sections.push({ lines: curSection, div: d });
                lastDivSeen = d;
                curSection = [];
                continue;
            }
        }
        curSection.push(l);
    }
    if (curSection.length) {
        sections.push({ lines: curSection, div: lastDivSeen });
    }

    const allEntries = [];
    for (const sec of sections) {
        const effDiv = (sec.div && sec.div.division) ? sec.div : fallbackDiv;
        const secEntries = parsePageLines(sec.lines, effDiv);
        for (const e of secEntries) allEntries.push(e);
    }

    return allEntries;
}

// ── 혼성경기(10종/7종) 통합 dedup ──
// 같은 (division, gender, 이름, 소속) 키로 여러 세부종목이 있으면 1행으로 통합
//   - 통합 종목명 = "10종경기" / "7종경기"
//   - lane/heat 은 첫 등장 세부종목의 값을 보존
function mergeCombinedEvents(rows) {
    const result = [];
    const combinedSeen = new Map(); // key → entry index in result
    for (const r of rows) {
        const cn = combinedEventName(r.event_name, r.round);
        if (cn) {
            const key = `${r.division}|${r.gender}|${r.athlete_name}|${r.team}|${cn}`;
            if (combinedSeen.has(key)) continue; // 중복 → 스킵
            combinedSeen.set(key, result.length);
            result.push({
                ...r,
                event_name: cn,
                round: '결승',
                round_type: 'final',
                heat: '',
                lane: '',
            });
        } else {
            result.push(r);
        }
    }
    return result;
}

(async () => {
    const baseDir = path.join(__dirname);
    const pdfFiles = [
        { file: 'roster_kkumnamu.pdf', hint: '꿈나무 남자부' },
        { file: 'roster_seonsugwon.pdf', hint: '선수권 남자부' },
        { file: 'roster_u18.pdf', hint: 'U18 남자부' },
        { file: 'roster_u20.pdf', hint: 'U20 남자부' },
    ];

    let allRows = [];
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

    // 혼성경기 dedup
    const beforeMerge = allRows.length;
    allRows = mergeCombinedEvents(allRows);
    console.log(`혼성경기 통합: ${beforeMerge} → ${allRows.length} 행`);

    // 통계
    const stats = {};
    for (const r of allRows) {
        const key = `${r.division}|${r.gender}|${r.sublabel || '-'}`;
        stats[key] = (stats[key] || 0) + 1;
    }
    console.log('\n=== 부/성별 분포 ===');
    Object.entries(stats).sort().forEach(([k, v]) => console.log(`  ${k}: ${v}`));

    // 릴레이 통계
    const relayRows = allRows.filter(r => isRelayEvent(r.event_name));
    console.log(`\n[릴레이] 행수: ${relayRows.length} (모두 팀 단위)`);
    relayRows.slice(0, 8).forEach(r => console.log(`  ${r.event_name} ${r.division} 레인:${r.lane} 팀:${r.team}`));

    // 혼성경기 통계
    const combinedRows = allRows.filter(r => /\d+종경기/.test(r.event_name));
    console.log(`\n[혼성경기] 행수: ${combinedRows.length}`);
    combinedRows.slice(0, 8).forEach(r => console.log(`  ${r.event_name} ${r.division} 배번:${r.bib_number} 성명:${r.athlete_name} 소속:${r.team}`));

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
        ['PACE RISE 명단 Excel 양식 (v4 — 릴레이 팀단위 + 혼성경기 통합 + noSeq 헤더)'],
        [''],
        ['v4 변경:'],
        ['  - 릴레이(4xNNNmR 등): 팀 단위 1행만 출력. 배번/성명 비어있고 소속(팀)만 채워짐.'],
        ['  - 혼성경기: 100m(10종)/멀리뛰기(10종)/포환던지기(10종)/높이뛰기(10종)/400m(10종) → "10종경기" 1행으로 통합. 7종도 동일.'],
        ['  - 남초 100m 4학년부처럼 "N조레인번호성명소속"(공백 없이 붙은) 헤더 페이지: 첫 자리=레인, 나머지=배번 정확 추출.'],
        [''],
        ['컬럼 설명:'],
        ['  일차       1, 2, 3 ... (대회 첫날 = 1)'],
        ['  종목       100m, 200m, 멀리뛰기, 4x400mR, 10종경기 등'],
        ['  라운드     PDF 원본 라벨 (5-2+6, 결승 등)'],
        ['  라운드타입 preliminary | semifinal | final'],
        ['  조         heat 번호 (필드/릴레이/혼성은 비어있음)'],
        ['  레인       1~9 (트랙) / 순 (필드)'],
        ['  배번       선수 배번 (릴레이는 비어있음)'],
        ['  성명       선수 이름 (릴레이는 비어있음)'],
        ['  소속       팀/학교'],
        ['  부         초등부 / 중등부 / 고등부 / 대학부 / 일반부 / 선수권(남/여/혼) / U18(남/여/혼) / U20(남/여/혼)'],
        ['  학년부     "4학년부", "5/6학년부", "1/2학년부" 같은 보조 라벨'],
        ['  성별       M / F / X'],
        ['  원본PDF    참고용'],
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
