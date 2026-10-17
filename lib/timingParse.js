'use strict';
/**
 * 계측 결과 파일(.lif / .txt / 기록 xlsx) 공통 파서 — 세 경로가 각자 다르게 읽던 것을 한 곳으로 (2026-09 Phase 3-③)
 *   parseStatus(token)  'DNS'|'DNF'|'DQ'|'NM'|null — "DQ(TR16.8)" 처럼 사유가 붙어도 상태로 본다 (예전엔 16.8초 기록이 됐다)
 *   parseTime(raw)      초 단위 숫자 | null — "10.52" "10,52" "1:52.34" "1:02:15.3" "10.523". 글자가 섞인 값은 null(추측하지 않는다)
 *   parseRound(raw)     'preliminary'|'semifinal'|'final' — '준결승' 을 '결승'보다 먼저 본다 (예전엔 준결승 결과가 결승 조에 들어갔다)
 *   genderOf(raw)       'M'|'F'|'X'|null — 라벨 어디에 있어도 찾는다 ("합동 남자 100m", "실업부 여자 100m")
 */
function parseStatus(token) {
    const s = String(token == null ? '' : token).trim().toUpperCase();
    if (!s) return null;
    if (/^(DNS|결장|불참)(?![A-Z])/.test(s)) return 'DNS';
    if (/^(DNF|기권|중도포기)(?![A-Z])/.test(s)) return 'DNF';
    if (/^(DQ|DSQ|DISQ|실격)(?![A-Z])/.test(s)) return 'DQ';
    if (/^(NM|NH|기록없음)(?![A-Z])/.test(s)) return 'NM';
    return null;
}
function parseTime(raw) {
    let s = String(raw == null ? '' : raw).trim();
    if (!s) return null;
    s = s.replace(/\s/g, '');
    if (/^\d+,\d+$/.test(s)) s = s.replace(',', '.');          // 10,52 (유럽식 소수점)
    if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(s)) return null;  // 글자·기호가 섞이면 시간이 아니다
    const parts = s.split(':').map(Number);
    if (parts.some(v => Number.isNaN(v))) return null;
    const secs = parts.reduce((a, v) => a * 60 + v, 0);
    return secs > 0 ? secs : null;
}
function parseRound(raw) {
    const r = String(raw || '').trim();
    if (/준결|semi/i.test(r)) return 'semifinal';
    if (/결승|final/i.test(r)) return 'final';
    if (/예선|prelim|heat/i.test(r)) return 'preliminary';
    return 'final';
}
function genderOf(raw) {
    const s = String(raw || '').trim();
    if (/혼성|mixed/i.test(s)) return 'X';
    if (/남자|(^|[\s(])남([\s)]|$)|\bmen\b|\bmale\b|(^|\s)M(\s|$)/i.test(s)) return 'M';
    if (/여자|(^|[\s(])여([\s)]|$)|\bwomen\b|\bfemale\b|(^|\s)F(\s|$)/i.test(s)) return 'F';
    if (/^x$/i.test(s)) return 'X';
    return null;
}
module.exports = { parseStatus, parseTime, parseRound, genderOf };
