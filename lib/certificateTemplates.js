'use strict';
/**
 * 상장·기록증 기본 양식 시드 — 조직마다 4종 (멀티테넌시 후속, 2026-10-09)
 *   예전엔 부팅 때 표가 비어 있으면 한 번만 넣었다(기본 조직). 이제 새 조직을 만들 때도 같은 4종을 그 조직 것으로 넣는다.
 *   서버 부팅(server.js) 과 조직 생성(lib/routes/organizations.js) 이 같이 쓴다.
 */
const INS_SQL = `INSERT INTO certificate_template (
    competition_id, name, kind, title_text, body_template, rank_label_style,
    signer_org, signer_title, signer_name,
    paper_orientation, show_record_value, show_athlete_team, show_date,
    background_color, border_style, font_family, is_default, sort_order,
    created_at, updated_at, organization_id
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const DEFAULTS = [
    // name, kind, title, body, rank_label_style, show_record, show_team, show_date, border, is_default, sort
    ['기본 시상장 (우승/준우승)', 'award', '상  장', '위 선수는 {competition_name}\n{event_name} 종목에서 {rank_label}을 차지하여\n그 우수한 성적을 인정하여 이 상장을 수여합니다.', 'ordinal', 1, 1, 1, 'double-gold', 1, 1],
    ['기본 시상장 (1위/2위/3위)', 'award', '상  장', '위 선수는 {competition_name}\n{event_name} 종목에서 {rank_label}을 차지하여\n그 우수한 성적을 인정하여 이 상장을 수여합니다.', 'numeric', 1, 1, 1, 'double-gold', 0, 2],
    ['완주증 (마스터즈용)', 'finisher', '완 주 증', '위 선수는 {competition_name} {event_name} 종목에 출전하여\n끝까지 완주하였기에 그 노력과 의지를 높이 평가하여\n이 증서를 수여합니다.', 'ordinal', 1, 1, 1, 'classic', 0, 3],
    ['단체상', 'team', '단 체 상', '위 단체는 {competition_name}에서 {rank_label}을 차지하여\n그 우수한 성적을 인정하여 이 상장을 수여합니다.', 'ordinal', 0, 0, 1, 'double-gold', 0, 4],
];
// 영문 조직용 (default_lang 이 ko 가 아니면) — 제목·본문만 영어
const DEFAULTS_EN = [
    ['Award certificate (1st/2nd/3rd)', 'award', 'CERTIFICATE', 'This certifies that the above athlete placed {rank_label}\nin the {event_name} at {competition_name}\nand is hereby recognised for this achievement.', 'numeric', 1, 1, 1, 'double-gold', 1, 1],
    ['Finisher certificate', 'finisher', 'FINISHER', 'This certifies that the above athlete completed\nthe {event_name} at {competition_name}.', 'ordinal', 1, 1, 1, 'classic', 0, 2],
    ['Team award', 'team', 'TEAM AWARD', 'This certifies that the above team placed {rank_label}\nat {competition_name}.', 'ordinal', 0, 0, 1, 'double-gold', 0, 3],
];

/** 조직에 기본 양식이 하나도 없으면 4종(영문 조직은 3종)을 넣는다. 반환: 넣은 수 */
async function seedDefaultTemplates(db, orgId, lang) {
    const o = Number(orgId || 1);
    const row = await db.get('SELECT COUNT(*) AS c FROM certificate_template WHERE organization_id=?', o);
    if (row && Number(row.c) > 0) return 0;
    const now = new Date().toISOString();
    const list = lang && lang !== 'ko' ? DEFAULTS_EN : DEFAULTS;
    for (const [name, kind, title, body, style, rec, team, date, border, isDef, sort] of list) {
        await db.run(INS_SQL, null, name, kind, title, body, style, '', lang && lang !== 'ko' ? 'President' : '회장', '',
            'portrait', rec, team, date, '#fffdf6', border, 'NanumSquare', isDef, sort, now, now, o);
    }
    return list.length;
}

module.exports = { seedDefaultTemplates };
