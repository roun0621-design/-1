'use strict';
/**
 * 문서(기록지·스타트리스트·종합기록지) 표시 라벨 사전 — 한글(기본)/영문 (2026-10, 해외 대회 대비 B5)
 *   docLabels(lang)             → 동결된 라벨 객체 L. L.rank, L.name … 와 함수 L.attempt(n), L.placeN(n), L.heatTitle(n) …
 *                                 ※ 한글 값은 기존 문서의 글자·띄어쓰기를 그대로(바이트 동일) 유지한다 — 띄어쓰기가 다른 같은 뜻의 라벨은 키를 따로 둔다
 *   compName(comp, lang)        → 영문이면 competition.name_en(있을 때), 아니면 name
 *   eventName(evt, lang)        → 영문이면 종목 사전(lib/eventCatalog) 영문명(코드를 모르면 원래 이름), 한글이면 evt.name 그대로
 *   genderLabel(g, lang)        → '남자'/'Men' (lib/labels gender)
 *   genderDiv(g, lang)          → '남자부'/"Men's"
 *   roundLabel(round_type, heatNumber, lang) → '결   승' · '예선  2조' · 'Heat 2' · 'Semi-Final 1'
 *   fontName(lang)              → 엑셀 글꼴: ko '맑은 고딕', en 'Calibri'
 *   normLang(x)                 → 'ko' | 'en' (ja 는 당분간 en)
 */
const EventCatalog = require('./eventCatalog');
const Labels = require('./labels');

// [ko, en]
const DICT = {
    // 표 머리글 — 연맹 기록지(엑셀)
    rank: ['등위', 'Rank'], rankSp: ['등 위', 'Rank'],
    bib: ['번호', 'Bib'],
    name: ['성명', 'Name'], nameSp2: ['성  명', 'Name'],
    athletes: ['선  수', 'Athletes'],
    team: ['소속', 'Team'], teamSp: ['소 속', 'Team'],
    mark: ['기록', 'Mark'], markSp1: ['기 록', 'Mark'], markSp2: ['기  록', 'Mark'],
    remarks: ['비고', 'Remarks'], remarksSp: ['비 고', 'Remarks'],
    event: ['종목', 'Event'],
    points: ['점수', 'Points'],
    windColon: ['풍  속:', 'Wind:'],
    wind: ['풍속', 'Wind'], windSp: ['풍 속', 'Wind'],
    typeSp: ['구 분', 'Type'], type: ['구분', 'Type'],
    recordYear: ['기록수립년도', 'Year'], year: ['수립년도', 'Year'],
    // 표 머리글 — PDF 기록지·스타트리스트
    rankPdf: ['순위', 'Rank'], rankPdfSp: ['순 위', 'Rank'],
    bibPdf: ['배번', 'Bib'], bibPdfSp: ['배 번', 'Bib'],
    athleteName: ['선수명', 'Name'], athleteNameSp: ['선 수 명', 'Name'],
    teamName: ['소속명', 'Team'], teamNameSp: ['소 속 명', 'Team'],
    result: ['결과', 'Result'], resultSp: ['결 과', 'Result'],
    lane: ['레인', 'Lane'], laneSp: ['레 인', 'Lane'],
    heat: ['조', 'Heat'],
    dob: ['생년월일', 'Date of Birth'],
    attendance: ['출 석', 'Status'],
    // 기록 비교표·신기록
    recordCompare: ['기 록 비 교 표', 'Record Comparison'],
    nr: ['한국기록(NR)', 'National Record (NR)'],
    dr: ['부별기록(DR)', 'Division Record (DR)'],
    cr: ['대회기록(CR)', 'Competition Record (CR)'],
    national: ['한국', 'National'],
    none: ['(없음)', '(none)'],
    newRecords: ['신기록', 'New Records'],
    newRecordsLegend: ['※ NR=한국기록 · DR=부별기록 · CR=대회기록 · 풍속 +2.0m/s 초과 = 참고기록(불인정)',
        '※ NR=National record · DR=Division record · CR=Competition record · Wind over +2.0 m/s = wind-assisted (not ratified)'],
    gender: ['성별', 'Gender'],
    divisionSeries: ['부/시리즈', 'Division / Series'],
    prevRecord: ['이전기록', 'Previous'],
    newRecord: ['신기록', 'New Record'],
    updatedAt: ['갱신일', 'Date'],
    generated: ['생성일', 'Generated'],
    legendCodes: ['DQ=실격  DNS=경기불참  DNF=중도기권  NM=기록없음  Q=순위통과  q=기록통과',
        'DQ=Disqualified  DNS=Did not start  DNF=Did not finish  NM=No mark  Q=Qualified by place  q=Qualified by time'],
    // 서명·직책
    chiefJudge: ['심판장', 'Chief Judge'],
    recorder: ['기록자', 'Recorder'],
    chiefRecorder: ['기록주임', 'Chief Recorder'],
    // 제목·시트
    finalTitle: ['결   승', 'Final'],
    summarySheet: ['종합기록', 'Summary'],
    comprehensive: ['종합기록지', 'Comprehensive Results'],
    noAthletes: ['— 등록된 선수가 없습니다 —', '— No athletes entered —'],
    noEvents: ['종목이 없습니다.', 'No events.'],
    unclassified: ['미분류', 'Unclassified'],
    lastHeight: ['마지막으로 넘은 높이까지', 'up to last cleared height'],
};
const GENDER_DIV = { M: ['남자부', "Men's"], F: ['여자부', "Women's"], X: ['혼성부', 'Mixed'] };
const TEAM_LABEL_KO = { Team: '소 속', School: '학 교', Club: '클 럽', Affiliation: '소 속' };
const TEAM_NAME_KO = { Team: '소 속 명', School: '학 교', Club: '클 럽', Affiliation: '소 속 명' };

function normLang(x) { const s = String(x || '').toLowerCase(); return (s === 'en' || s === 'ja') ? 'en' : 'ko'; }
function ordinal(n) {
    const v = Number(n) || 0, m100 = v % 100, m10 = v % 10;
    if (m100 >= 11 && m100 <= 13) return v + 'th';
    return v + (m10 === 1 ? 'st' : m10 === 2 ? 'nd' : m10 === 3 ? 'rd' : 'th');
}

function docLabels(lang) {
    const en = normLang(lang) === 'en';
    const i = en ? 1 : 0;
    const L = {};
    for (const [k, v] of Object.entries(DICT)) L[k] = v[i];
    L.lang = en ? 'en' : 'ko';
    L.attempt = n => en ? `Att. ${n}` : `${n}차`;
    L.placeN = n => en ? ordinal(n) : `${n}위`;
    L.heatTitle = n => en ? `Heat ${n}` : `예선  ${n}조`;
    L.semiTitle = n => en ? `Semi-Final ${n}` : `준결승  ${n}조`;
    L.seriesN = id => en ? `Series #${id}` : `시리즈#${id}`;
    L.genderDiv = g => (GENDER_DIV[g] || GENDER_DIV.X)[i];
    L.genderWord = g => Labels.label('gender', g || 'X', en ? 'en' : 'ko');
    // 종합기록 시트 2행: ko '남자부 (MEN'S)' · en "Men's"
    L.summaryGender = g => en ? L.genderDiv(g) : `${L.genderDiv(g)} (${g === 'M' ? "MEN'S" : "WOMEN'S"})`;
    L.newRecordsTitle = (compTitle, g) => en ? `🏆 ${compTitle} — ${L.genderDiv(g)} ${L.newRecords}` : `🏆 ${compTitle} — ${L.genderWord(g)} 신기록 갱신 모음`;
    L.newRecordsHeaders = () => en
        ? ['No.', 'Type', 'Event', 'Gender', 'Division / Series', 'Previous', 'New Record', 'Name', 'Team', 'Wind', 'Date']
        : ['No.', '구분', '종목', '성별', '부/시리즈', '이전기록', '신기록', '선수명', '소속', '풍속', '갱신일'];
    L.newRecordsFooter = (date, n) => en ? `Generated: ${date} · ${n} record${n === 1 ? '' : 's'} · PACE RISE` : `생성일: ${date} · 총 ${n}건 · PACE RISE`;
    L.chiefJudgeLine = name => name ? `${L.chiefJudge}: ${name}` : '';
    L.eventLine = evtName => `${L.event}: ${evtName}`;
    L.noEventsMsg = compTitle => `${compTitle} — ${L.noEvents}`;
    L.unclassifiedFor = g => {
        if (!g) return L.unclassified;
        return en ? `${L.unclassified} (${L.genderWord(g)})` : `미분류 (${L.genderWord(g)})`;
    };
    // 스타트리스트·기록지 소속 머리글 — 양식의 team_label(Team/School/Club/Affiliation)
    L.teamLabel = tplLabel => en ? (tplLabel || 'Team') : (TEAM_LABEL_KO[tplLabel] || '소 속');
    L.teamNameLabel = tplLabel => en ? (tplLabel || 'Team') : (TEAM_NAME_KO[tplLabel] || '소 속 명');
    L.recordTypeLabel = recordType => recordType === 'national' ? L.nr : recordType === 'division' ? L.dr : L.cr;
    return Object.freeze(L);
}

function compName(comp, lang) {
    if (!comp) return '';
    if (normLang(lang) === 'en' && comp.name_en && String(comp.name_en).trim()) return String(comp.name_en).trim();
    return comp.name || '';
}
// 영문 종목명: event.code → 없으면 이름으로 코드 추정 → 사전 영문. 부 접미('100m 일반부')는 한글이라 영문 문서엔 붙이지 않는다
function eventName(evt, lang) {
    if (!evt) return '';
    const raw = typeof evt === 'string' ? evt : (evt.name || '');
    if (normLang(lang) !== 'en') return raw;
    const code = (typeof evt === 'object' && evt.code) ? evt.code : EventCatalog.codeOf(raw);
    if (!code || !EventCatalog.entry(code)) return raw;
    return EventCatalog.label(code, 'en');
}
function genderLabel(g, lang) { return Labels.label('gender', g || 'X', normLang(lang)); }
function genderDiv(g, lang) { return docLabels(lang).genderDiv(g); }
function roundLabel(roundType, heatNumber, lang) {
    const L = docLabels(lang);
    if (roundType === 'preliminary') return L.heatTitle(heatNumber);
    if (roundType === 'semifinal') return L.semiTitle(heatNumber);
    return L.finalTitle;
}
function fontName(lang) { return normLang(lang) === 'en' ? 'Calibri' : '맑은 고딕'; }

module.exports = { docLabels, compName, eventName, genderLabel, genderDiv, roundLabel, fontName, normLang, DICT };
