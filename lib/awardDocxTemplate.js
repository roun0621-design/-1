'use strict';
/**
 * 워드 상장 양식 — 현장에서 인쇄해 시상대에서 주는 '종이 상장' 전용 설정.
 *   PDF 양식(certificate_template)은 문자로 보내는 기록증·상장에 맞춰져 있다(배경·로고·직인 이미지, 링크, 일괄 발송).
 *   워드 상장은 받는 쪽에서 문구를 고쳐 인쇄하는 문서라 필요한 항목이 다르다 → 따로 관리한다.
 *
 *   저장: award_docx_template (scope_key 'global' | 'c<대회id>', config JSON). 대회 양식이 없으면 전체 기본 → 내장 기본값.
 */
const DEFAULTS = Object.freeze({
    title_text: '상  장',
    // 발급번호
    show_serial: 1,
    serial_format: '제 {year}-{seq} 호',      // {year} 연도, {seq} 일련번호(3자리), {event} 종목명
    serial_start: 1,
    // 항목 줄
    show_event: 1, show_rank: 1, show_record: 1, show_wind: 1, show_team: 1, show_members: 1,
    rank_label_style: 'numeric',              // numeric: 1위 / mixed: 우승·준우승·3위 / ordinal: 우승·준우승·N위
    // 본문 — 변수: {competition_name} {event_name} {rank_label} {athlete_name} {team} {record_value} {date}
    body_template: '위 선수는 {competition_name}\n{event_name} 종목에서 위와 같이 우수한 성적을\n거두었기에 이 상장을 수여합니다.',
    // 계주(단체) 본문 — 수상자가 팀이므로 '위 선수는' 대신 쓴다
    body_template_team: '위 팀은 {competition_name}\n{event_name} 종목에서 위와 같이 우수한 성적을\n거두었기에 이 상장을 수여합니다.',
    // 날짜: 비우면 출력하는 날(시상일). 예) 2026년 9월 16일
    show_date: 1,
    award_date: '',
    // 수여자
    signer_org: '',
    signer_title: '회장',
    signer_name: '',
    seal_mark: '(직인)',                      // 직인 찍을 자리 표시. 비우면 표시하지 않는다
    // 글꼴·크기(pt)
    font_family: '바탕',
    title_size: 54, field_size: 18, body_size: 18, date_size: 18, signer_size: 26,
    // 용지
    paper_orientation: 'portrait',            // portrait | landscape
    border_style: 'double',                   // none | single | double
    border_color: '#b8945a',
});
const FONTS = ['바탕', '궁서', '맑은 고딕', '굴림', '돋움', '나눔명조', '함초롬바탕', 'HY견명조'];
const NUM_FIELDS = { title_size: [20, 90], field_size: [10, 36], body_size: [10, 36], date_size: [10, 36], signer_size: [12, 48], serial_start: [1, 99999] };
const BOOL_FIELDS = ['show_serial', 'show_event', 'show_rank', 'show_record', 'show_wind', 'show_team', 'show_members', 'show_date'];
const TEXT_FIELDS = { title_text: 40, serial_format: 60, body_template: 1000, body_template_team: 1000, award_date: 40, signer_org: 80, signer_title: 40, signer_name: 40, seal_mark: 20, font_family: 40 };

/** 입력값을 검증·정리해 완전한 설정으로 만든다 (모르는 키는 버린다) */
function normalize(input) {
    const src = input && typeof input === 'object' ? input : {};
    const out = { ...DEFAULTS };
    for (const [k, max] of Object.entries(TEXT_FIELDS)) if (src[k] != null) out[k] = String(src[k]).slice(0, max);
    for (const k of BOOL_FIELDS) if (src[k] != null) out[k] = (src[k] === true || src[k] === 1 || src[k] === '1' || src[k] === 'true') ? 1 : 0;
    for (const [k, [lo, hi]] of Object.entries(NUM_FIELDS)) if (src[k] != null && src[k] !== '') { const n = Number(src[k]); if (Number.isFinite(n)) out[k] = Math.min(hi, Math.max(lo, Math.round(n))); }
    if (['numeric', 'mixed', 'ordinal'].includes(src.rank_label_style)) out.rank_label_style = src.rank_label_style;
    if (['portrait', 'landscape'].includes(src.paper_orientation)) out.paper_orientation = src.paper_orientation;
    if (['none', 'single', 'double'].includes(src.border_style)) out.border_style = src.border_style;
    if (/^#[0-9a-fA-F]{6}$/.test(String(src.border_color || ''))) out.border_color = src.border_color;
    if (!out.title_text.trim()) out.title_text = DEFAULTS.title_text;
    if (!out.font_family.trim()) out.font_family = DEFAULTS.font_family;
    return out;
}

const keyOf = compId => (compId ? `c${parseInt(compId, 10)}` : 'global');

async function ensureTable(db) {
    await db.exec(`CREATE TABLE IF NOT EXISTS award_docx_template (scope_key TEXT PRIMARY KEY, config TEXT NOT NULL, updated_at TEXT)`);
}
/** 적용되는 양식: 대회 양식 → 전체 기본 → 내장 기본값. source 로 어디서 왔는지 알려준다 */
async function getEffective(db, compId) {
    for (const [key, source] of [[compId ? keyOf(compId) : null, 'competition'], ['global', 'global']]) {
        if (!key) continue;
        const row = await db.get('SELECT config FROM award_docx_template WHERE scope_key=?', key);
        if (row) { try { return { source, config: normalize(JSON.parse(row.config)) }; } catch (e) { /* 깨진 JSON 은 무시 */ } }
    }
    return { source: 'builtin', config: { ...DEFAULTS } };
}
async function save(db, compId, input) {
    const config = normalize(input);
    const key = keyOf(compId);
    const txn = db.transaction(async () => {
        await db.run('DELETE FROM award_docx_template WHERE scope_key=?', key);
        await db.run('INSERT INTO award_docx_template (scope_key, config, updated_at) VALUES (?,?,?)', key, JSON.stringify(config), new Date().toISOString());
    });
    await txn();
    return config;
}
async function remove(db, compId) { await db.run('DELETE FROM award_docx_template WHERE scope_key=?', keyOf(compId)); }

module.exports = { DEFAULTS, FONTS, normalize, ensureTable, getEffective, save, remove };
