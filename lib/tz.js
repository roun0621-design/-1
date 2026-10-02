'use strict';
/**
 * 대회 시간대(timezone) — 2026-09-30, 해외 대회 대비
 *   지금까지는 서버·화면이 전부 KST(UTC+9) 고정이었다(kstNow, 소집 시간창, 자동 상태 전환, 시간표 '오늘').
 *   이제 competition.timezone(IANA 이름, 기본 'Asia/Seoul') 기준으로 "오늘"·"지금 시각"을 판정한다.
 *   로그 시각(opLog/audit) 은 서버 기본 시간대(APP_TZ, 기본 Asia/Seoul) 그대로 — 대회와 무관한 운영 기록이라서.
 *
 *   todayIn(tz)            'YYYY-MM-DD'
 *   nowIn(tz)              { ymd, hm, hms, minutes }     minutes = 그 시간대의 0시부터 지난 분
 *   nowStrIn(tz)           'YYYY-MM-DD HH:MM:SS'          (kstNow 와 같은 모양)
 *   hhmmIn(iso, tz)        ISO 문자열의 시:분 — 오프셋(Z, ±hh:mm)이 있으면 tz 로 환산, 없으면(현지시각 표기) 그대로
 *   ymdIn(iso, tz)         ISO 문자열의 날짜 — 위와 같은 규칙
 *   compTz(comp)           comp.timezone 또는 기본값
 *   isValidTz(tz)          Intl 이 아는 이름인지
 */
const DEFAULT_TZ = process.env.APP_TZ || 'Asia/Seoul';
const _fmtCache = new Map();
function _fmt(tz) {
    let f = _fmtCache.get(tz);
    if (!f) {
        f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
        _fmtCache.set(tz, f);
    }
    return f;
}
function isValidTz(tz) {
    if (!tz || typeof tz !== 'string' || tz.length > 64) return false;
    try { _fmt(tz); return true; } catch (e) { return false; }
}
function compTz(comp) {
    const tz = comp && comp.timezone;
    return isValidTz(tz) ? tz : DEFAULT_TZ;
}
function partsIn(date, tz) {
    const p = {};
    for (const x of _fmt(isValidTz(tz) ? tz : DEFAULT_TZ).formatToParts(date)) if (x.type !== 'literal') p[x.type] = x.value;
    const hour = p.hour === '24' ? '00' : p.hour;   // 일부 ICU 가 자정을 24 로 낸다
    return { y: p.year, mo: p.month, d: p.day, h: hour, mi: p.minute, s: p.second };
}
function nowIn(tz, date) {
    const p = partsIn(date || new Date(), tz);
    return { ymd: `${p.y}-${p.mo}-${p.d}`, hm: `${p.h}:${p.mi}`, hms: `${p.h}:${p.mi}:${p.s}`, minutes: Number(p.h) * 60 + Number(p.mi) };
}
function todayIn(tz, date) { return nowIn(tz, date).ymd; }
function nowStrIn(tz, date) { const n = nowIn(tz, date); return `${n.ymd} ${n.hms}`; }
const _HAS_OFFSET = /(Z|[+-]\d\d:?\d\d)$/i;
function hhmmIn(iso, tz) {
    const s = String(iso || '');
    if (_HAS_OFFSET.test(s)) { const d = new Date(s); if (isFinite(d)) return nowIn(tz, d).hm; }
    const m = s.match(/T(\d\d):(\d\d)/); return m ? `${m[1]}:${m[2]}` : '';
}
function ymdIn(iso, tz) {
    const s = String(iso || '');
    if (_HAS_OFFSET.test(s)) { const d = new Date(s); if (isFinite(d)) return nowIn(tz, d).ymd; }
    return s.slice(0, 10);
}
// 날짜 문자열 더하기 — 서버 시간대와 무관하게 (예전엔 new Date('...T00:00:00') 뒤 toISOString 이라 서버가 UTC 가 아니면 하루가 밀렸다)
function shiftYmd(ymd, n) {
    const d = new Date(String(ymd).slice(0, 10) + 'T00:00:00Z'); if (!isFinite(d)) return String(ymd);
    d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
// 관리자 화면 선택지 (자유 입력도 허용 — isValidTz 로 검증)
const COMMON_TZ = ['Asia/Seoul', 'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Manila', 'Asia/Singapore', 'Asia/Kuala_Lumpur', 'Asia/Jakarta', 'Asia/Bangkok', 'Asia/Ho_Chi_Minh', 'Asia/Kolkata', 'Asia/Dubai', 'Asia/Doha', 'Asia/Tashkent', 'Asia/Almaty', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Rome', 'Europe/Madrid', 'Europe/Warsaw', 'Europe/Istanbul', 'Africa/Nairobi', 'Africa/Johannesburg', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Sao_Paulo', 'America/Mexico_City', 'Australia/Sydney', 'Australia/Brisbane', 'Pacific/Auckland', 'UTC'];

module.exports = { DEFAULT_TZ, COMMON_TZ, isValidTz, compTz, nowIn, todayIn, nowStrIn, hhmmIn, ymdIn, shiftYmd, partsIn };
