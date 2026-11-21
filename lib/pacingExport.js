'use strict';
/**
 * 페이싱 라이트 설정 → WaveLight 시스템 파일(.pc2) — 2026-11-20
 *
 *   WaveLight 프로그램은 조명 한 줄(색 하나)마다 파일 하나를 읽는다. 파일은 JSON 배열이고 한 칸이 한 구간:
 *       [{"step-distance": "1000", "step-pace": 180.0}, …]
 *     step-distance  조명이 트랙(400m) 안쪽을 따라 가는 거리(m) — 문자열
 *     step-pace      그 구간에 걸리는 시간(초) — 숫자, 소수 둘째 자리까지
 *   색·종목·출발 위치는 파일에 없다(WaveLight 프로그램에서 고른다) → 파일 이름으로 알려 준다.
 *   표기(쉼표·콜론 뒤 공백, 69.0 처럼 소수점 유지, 줄바꿈 없음)는 운영사가 준 예시 파일과 글자 단위로 같게 낸다.
 *
 *   우리 설정(pacing_config › pacing_color › pacing_segment) 과의 대응:
 *     색 한 줄 → 파일 1개 · 구간 거리 → step-distance · 구간 랩타임 → step-pace
 *     예) 1000m 3분 = 한 구간 {1000, 180.0}, 구간이 나뉘어 있으면 구간마다 한 칸.
 *
 *   3000m 장애물만 다르다: 물웅덩이를 돌 때 선수는 트랙 바깥으로 121.41m 를 뛰는데 조명은 안쪽 100m 만 간다.
 *     그래서 조명 기준 구간은 250 → (100 + 300) × 6 → 100 → 100 (합 2850m) 이고, 우리 설정(달리는 거리 3000m 기준)의
 *     페이스를 그 구간들에 나눠 담는다. 시간은 0.01초 올림 — 예시 파일 7개(11:30~12:00)가 이 규칙으로 그대로 나온다.
 *
 *   파일 이름(영문만): <종목>_<성별>[_<부>]_<기록>_<색>.pc2   예) 3000mSC_Women_Senior_11-30_Green.pc2
 *
 *   프로그램이 받는 범위(2026-11-21, 실제 장비의 'Wavelight event tool' 5.0 화면 코드로 확인 — docs/WAVELIGHT.md):
 *     파일은 'Complex' 창에서 읽고, 창을 닫을 때(Confirm) 구간마다 검사한다. 한 구간이 19.2초보다 짧거나
 *     (초 × 거리)가 너무 크면 거부되어 창이 안 닫힌다 → 파일은 그 범위에 맞춰 짧은 구간은 이웃과 합치고 긴 구간은 나눈다(fitForProgram).
 *     전체 거리·기록은 그대로. 컨트롤러에 직접 보내는 값(controller — 에이전트용)은 이 검사를 안 거치므로 합치지 않은 원래 구간이다.
 *
 *   parsePacingKey(event_name)            '10,000m (남) [대학부]' → { name, gender, division }
 *   pacingKey(name, gender, division)      그 반대
 *   buildFiles(cfg, { division })          → { files: [{ color_key, filename, content, total_seconds, steps, converted, notes, controller }], skipped: [{ color_key, reason }] }
 *       controller = { colourNumber, startLamp, steps: [{ NumberOfLamps, Duration(ms) }] } — 에이전트가 컨트롤러에 그대로 보내는 값
 */
const { codeOf } = require('./eventCatalog');
const { parseDivision } = require('./division');

const GENDER_KO = { M: '남', F: '여', X: '혼성' };
const GENDER_BY_KO = { 남: 'M', 여: 'F', 혼성: 'X' };
const GENDER_EN = { M: 'Men', F: 'Women', X: 'Mixed' };
const COLOR_EN = { green: 'Green', red: 'Red', white: 'White', blue: 'Blue' };
const LEVEL_EN = { ELEM: 'Elem', MID: 'Middle', HIGH: 'High', UNIV: 'Univ', GEN: 'Senior' };
const NAMED_EVENT = { DEC: 'Decathlon', HEP: 'Heptathlon', PEN: 'Pentathlon', MILE: 'Mile' };

// WaveLight 프로그램 'Complex' 창의 검사(workoutPopup.js getWorkoutStepsArray) — 그 창은 값을 '400m 당 초'로 보고 검사한다:
//   초 × 2.5 / 60 < 0.8  → 거부 (= 한 구간 19.2초 미만)        초 × 2.5 × 거리 > 16,777,000 → 거부
//   구간 칸은 56개(7 + 7줄 × 7). 넘는 구간은 'Add a new row' 를 먼저 누르지 않으면 조용히 잘린다.
const PROGRAM = { MIN_SECONDS: 19.25, MAX_PRODUCT: 6700000, MAX_STEPS: 56 };
// 컨트롤러 명령(command06) 한 구간의 한계 — 조명 수 16비트 · 시간(ms) 24비트. 여유를 둔다.
const CONTROLLER = { MAX_LAMPS: 65000, MAX_MS: 16000000 };
// 프로그램의 색 번호(script.js setColor): 0 초록 · 1 파랑 · 2 흰색 · 3 빨강
const COLOUR_NUMBER = { green: 0, blue: 1, white: 2, red: 3 };
const TRACK = 400;

// 3000m 장애물(400m 트랙, 물웅덩이 바깥) — [조명이 가는 거리, 선수가 달리는 거리]
const STEEPLE_3000 = (() => {
    const DETOUR = [100, 121.41];
    const pieces = [[250, 250]];
    for (let i = 0; i < 7; i++) { pieces.push(DETOUR); if (i < 6) pieces.push([300, 300]); }
    pieces.push([100, 100]);
    return pieces;
})();

/** 페이싱 설정 키 → 종목명·성별·부. 키 꼴: '800m (남)' · '10,000m (남) [대학부]' · (옛 데이터) '800m' */
function parsePacingKey(eventName) {
    const s = String(eventName || '').trim();
    const m = s.match(/^(.*?)\s*\((남|여|혼성)\)(?:\s*\[(.+)\])?$/);
    if (!m) return { name: s, gender: null, division: '' };
    return { name: m[1].trim(), gender: GENDER_BY_KO[m[2]], division: (m[3] || '').trim() };
}
function pacingKey(name, gender, division) {
    return `${name} (${GENDER_KO[gender] || '혼성'})` + (division ? ` [${division}]` : '');
}

const ascii = s => String(s || '').replace(/[^A-Za-z0-9.-]+/g, '');

function eventToken(name) {
    const code = codeOf(name);
    if (code) {
        const m = String(code).match(/^(\d+)(SC|W|H)?$/);
        if (m) return m[1] + 'm' + (m[2] || '');
        if (NAMED_EVENT[code]) return NAMED_EVENT[code];
    }
    return ascii(String(name || '').replace(/,/g, '')) || 'Event';
}

/** 부 라벨 → 영문 토막. '대학부' → Univ, '일반부'·'실업부' → Senior, '고2학년부' → High2, 'U20(남)'·'18세이하부' → U20·U18. 모르면 영문·숫자만 남긴다 */
function divisionToken(division) {
    const s = String(division || '').replace(/\s+/g, '');
    if (!s) return '';
    let m = s.match(/^U(\d{2})/i); if (m) return 'U' + m[1];
    m = s.match(/(\d{2})세이하/); if (m) return 'U' + m[1];
    if (/선수권/.test(s)) return 'Champ';
    if (/국제/.test(s)) return 'Intl';
    if (/마스터/.test(s)) return 'Masters';
    const p = parseDivision(s);
    if (p.level && LEVEL_EN[p.level]) return LEVEL_EN[p.level] + (p.grade || '');
    return ascii(s);
}

/** 초 → 파일 이름용 기록. 690 → '11-30', 112.5 → '1-52.50' (콜론은 파일 이름에 못 쓴다) */
function timeToken(seconds) {
    const t = Math.round(Number(seconds) * 100) / 100;
    const min = Math.floor(t / 60);
    const sec = Math.round((t - min * 60) * 100) / 100;
    const whole = Number.isInteger(sec);
    return `${min}-${sec < 10 ? '0' : ''}${whole ? sec : sec.toFixed(2)}`;
}

function fileName({ name, gender, division, totalSeconds, colorKey }) {
    return [eventToken(name), GENDER_EN[gender] || '', divisionToken(division), timeToken(totalSeconds), COLOR_EN[colorKey] || ascii(colorKey)]
        .filter(Boolean).join('_') + '.pc2';
}

// 숫자 표기 — 소수 둘째 자리까지, 정수여도 '69.0' 처럼 소수점을 남긴다(예시 파일과 같게)
const round2 = x => Math.round(x * 100) / 100;
const ceil2 = x => Math.ceil(x * 100 - 1e-7) / 100;
function fmtNum(x) { const r = round2(x); return Number.isInteger(r) ? r.toFixed(1) : String(r); }

function serialize(steps) {
    return '[' + steps.map(s => `{"step-distance": "${s.distance}", "step-pace": ${fmtNum(s.seconds)}}`).join(', ') + ']';
}

/** 달리는 거리 x(m) 까지 걸리는 시간 — 구간 안에서는 같은 빠르기 */
function timeAt(segs, x) {
    let t = 0, d = 0;
    for (const s of segs) {
        if (x <= d) break;
        const len = Math.min(x - d, s.distance_meters);
        t += s.lap_seconds * (len / s.distance_meters);
        d += s.distance_meters;
    }
    return t;
}

/**
 * 구간 목록 → WaveLight 구간. 빈 랩타임이 있으면 { error }.
 *   returns { steps: [{ distance, seconds }], converted: 'steeple' | null }
 */
function toSteps(eventName, segments) {
    const segs = (segments || [])
        .slice().sort((a, b) => (a.segment_order || 0) - (b.segment_order || 0))
        .map(s => ({ distance_meters: Number(s.distance_meters) || 0, lap_seconds: Number(s.lap_seconds) || 0 }))
        .filter(s => s.distance_meters > 0);
    if (!segs.length) return { error: 'no_segments' };
    if (segs.some(s => !(s.lap_seconds > 0))) return { error: 'empty_lap' };
    const total = segs.reduce((a, s) => a + s.distance_meters, 0);
    if (codeOf(eventName) === '3000SC' && total === 3000) {
        let run = 0;
        const steps = STEEPLE_3000.map(([light, len]) => {
            const sec = ceil2(timeAt(segs, run + len) - timeAt(segs, run));
            run += len;
            return { distance: light, seconds: sec };
        });
        return { steps, converted: 'steeple' };
    }
    return { steps: segs.map(s => ({ distance: s.distance_meters, seconds: round2(s.lap_seconds) })), converted: null };
}

/** 한 구간을 n 토막으로 — 거리는 정수(조명 1개 = 1m), 시간은 거리 비례, 마지막 토막이 나머지를 받아 합이 그대로 */
function splitStep(step, n) {
    const out = []; let dLeft = step.distance, sLeft = step.seconds;
    for (let i = 0; i < n; i++) {
        const last = i === n - 1;
        const d = last ? dLeft : Math.round(step.distance / n);
        const sec = last ? round2(sLeft) : round2(step.seconds * d / step.distance);
        out.push({ distance: d, seconds: sec }); dLeft -= d; sLeft -= sec;
    }
    return out;
}

/**
 * 구간을 프로그램 'Complex' 창이 받는 범위로 맞춘다 — 긴 구간은 나누고(같은 빠르기라 조명 움직임은 같다), 19.2초 미만 구간은 빠르기가 더 비슷한 이웃과 합친다.
 *   returns { steps, notes } — notes: 'split' · 'merged' · 'too_short'(구간이 하나뿐이고 19.2초 미만 — 프로그램에 못 넣는다) · 'many_steps'(56칸 초과)
 */
function fitForProgram(steps) {
    const notes = [];
    let out = [];
    for (const s of steps) {
        const product = s.seconds * s.distance;
        if (product > PROGRAM.MAX_PRODUCT) { out.push(...splitStep(s, Math.ceil(Math.sqrt(product / PROGRAM.MAX_PRODUCT)))); if (!notes.includes('split')) notes.push('split'); }
        else out.push({ distance: s.distance, seconds: s.seconds });
    }
    const speed = s => s.distance / s.seconds;
    for (;;) {
        const i = out.findIndex(s => s.seconds < PROGRAM.MIN_SECONDS);
        if (i < 0) break;
        if (out.length === 1) { notes.push('too_short'); break; }
        const prev = out[i - 1], next = out[i + 1];
        const j = !prev ? i + 1 : !next ? i - 1 : (Math.abs(speed(prev) - speed(out[i])) <= Math.abs(speed(next) - speed(out[i])) ? i - 1 : i + 1);
        const a = Math.min(i, j);
        out.splice(a, 2, { distance: out[a].distance + out[a + 1].distance, seconds: round2(out[a].seconds + out[a + 1].seconds) });
        if (!notes.includes('merged')) notes.push('merged');
    }
    if (out.length > PROGRAM.MAX_STEPS) notes.push('many_steps');
    return { steps: out, notes };
}

/** 구간 → 컨트롤러 명령(command06)의 Steps: [{ NumberOfLamps, Duration(ms) }] — 프로그램이 Start 때 만드는 값과 같은 꼴 */
function controllerSteps(steps) {
    const out = [];
    for (const s of steps) {
        const n = Math.max(1, Math.ceil(s.distance / CONTROLLER.MAX_LAMPS), Math.ceil(s.seconds * 1000 / CONTROLLER.MAX_MS));
        for (const p of (n > 1 ? splitStep(s, n) : [s])) out.push({ NumberOfLamps: p.distance, Duration: Math.round(p.seconds * 1000) });
    }
    return out;
}

/** 출발선 조명 번호(프로그램의 Startline 값) — 결승선에서 끝나도록 조명이 가는 거리만큼 앞에서 출발. 400 → 0 · 1500 → 100 · 3000 → 200 · 3000m 장애물(조명 2850m) → 350 */
function startLamp(steps) {
    const light = steps.reduce((a, s) => a + s.distance, 0);
    return (TRACK - (light % TRACK)) % TRACK;
}

/**
 * 설정 하나(색 여러 줄) → 파일 목록.
 *   cfg: { event_name, colors: [{ color_key, segments: [...] }] }
 *   opts.division: 키에 부가 없을 때 쓸 부(그 종목·성별의 부가 대회에 하나뿐일 때 라우트가 넘긴다)
 */
function buildFiles(cfg, opts = {}) {
    const key = parsePacingKey(cfg.event_name);
    const division = key.division || opts.division || '';
    const files = [], skipped = [], used = new Set(opts.usedNames || []);
    for (const c of (cfg.colors || [])) {
        const r = toSteps(key.name, c.segments);
        if (r.error) { skipped.push({ color_key: c.color_key, reason: r.error }); continue; }
        // 파일 이름의 기록은 화면의 '총 기록'(입력한 랩타임 합) — 장애물은 올림 때문에 구간 합이 0.0x초 다를 수 있다
        const totalSeconds = round2((c.segments || []).reduce((a, s) => a + (Number(s.lap_seconds) || 0), 0));
        let filename = fileName({ name: key.name, gender: key.gender, division, totalSeconds, colorKey: c.color_key });
        for (let n = 2; used.has(filename.toLowerCase()); n++) filename = filename.replace(/(_\d+)?\.pc2$/, `_${n}.pc2`);
        used.add(filename.toLowerCase());
        const fit = fitForProgram(r.steps);
        files.push({
            color_key: c.color_key, filename, content: serialize(fit.steps), total_seconds: totalSeconds, steps: fit.steps.length, converted: r.converted,
            notes: fit.notes,     // 프로그램 범위에 맞춘 내용 — 'split' · 'merged' · 'too_short' · 'many_steps'
            controller: { colourNumber: COLOUR_NUMBER[c.color_key] != null ? COLOUR_NUMBER[c.color_key] : 0, startLamp: startLamp(r.steps), steps: controllerSteps(r.steps) },
        });
    }
    return { files, skipped, usedNames: used };
}

module.exports = { parsePacingKey, pacingKey, eventToken, divisionToken, timeToken, fileName, fmtNum, toSteps, serialize, buildFiles, fitForProgram, controllerSteps, startLamp, STEEPLE_3000, GENDER_EN, PROGRAM, COLOUR_NUMBER };
