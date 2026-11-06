'use strict';
/**
 * 로그 기간 조회 공용 (2026-09-22) — 외부 API 호출 로그·운영 로그가 같은 규칙으로 from/to(한국 날짜)·CSV 를 받는다
 *   parseRange(query)             { fromMs, toMs, fromDay, toDay } — from/to 는 'YYYY-MM-DD'(한국 시각 기준, to 는 그날 끝까지). 없으면 null
 *   inRange(range, createdAt, parseMs)  created_at(SQLite UTC 문자열 / PG timestamptz 문자열) 을 ms 로 읽어 판정
 *   sqlDayWindow(range, col)      DB 에서 넉넉히 거르는 조건 (앞뒤 하루 여유; 정확한 판정은 inRange 가 한다) → { sql, params }
 *   toCsv(rows, columns)          BOM + CSV (엑셀에서 한글 바로 열림)
 */
function parseRange(q) {
    const day = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim())) ? v.trim() : null;
    const fromDay = day(q.from), toDay = day(q.to);
    if (!fromDay && !toDay) return null;
    const fromMs = fromDay ? new Date(fromDay + 'T00:00:00+09:00').getTime() : -Infinity;
    const toMs = toDay ? new Date(toDay + 'T23:59:59.999+09:00').getTime() : Infinity;
    return { fromMs, toMs, fromDay, toDay };
}
function inRange(range, createdAt, parseMs) {
    if (!range) return true;
    const ms = parseMs(createdAt);
    if (!Number.isFinite(ms)) return true;   // 못 읽는 값은 거르지 않는다 (숨기는 것보다 보이는 게 안전)
    return ms >= range.fromMs && ms <= range.toMs;
}
function shiftDay(ymd, n) { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function sqlDayWindow(range, col) {
    if (!range) return { sql: '', params: [] };
    const parts = [], params = [];
    if (range.fromDay) { parts.push(`substr(${col},1,10) >= ?`); params.push(shiftDay(range.fromDay, -1)); }
    if (range.toDay) { parts.push(`substr(${col},1,10) <= ?`); params.push(shiftDay(range.toDay, 1)); }
    return { sql: parts.join(' AND '), params };
}
function toCsv(rows, columns) {
    const esc = v => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    return '\ufeff' + [columns.map(c => esc(c.label || c.key)).join(',')].concat(rows.map(r => columns.map(c => esc(typeof c.get === 'function' ? c.get(r) : r[c.key])).join(','))).join('\r\n');
}
module.exports = { parseRange, inRange, sqlDayWindow, toCsv };
