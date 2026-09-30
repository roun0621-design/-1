'use strict';
/**
 * 라벨 사전 — 라운드·상태·성별·종목군·상태코드·기록 종류·부(division) 의 한글/영문 표기 (2026-09-30, 해외 대회 대비 B2)
 *   서버 응답은 코드(round_type='semifinal' 등)를 주고, 표시 언어는 이 사전으로 고른다. `GET /api/labels?lang=en` 이 통째로 내려준다.
 *   label(group, code, lang)      예: label('round', 'semifinal', 'en') → 'Semifinal'
 *   divisionLabelEn(row)          division_master 행 → 영문 라벨 ('Men High School Grade 2', 'Women Senior', 'Mixed')
 *   all(lang)                     { round:{…}, status:{…}, … } 한 언어 전체
 */
// [ko, en, ja] — ja 가 없으면 en 으로
const DICT = {
    round: { preliminary: ['예선', 'Heats', '予選'], semifinal: ['준결승', 'Semifinal', '準決勝'], final: ['결승', 'Final', '決勝'], sub: ['세부종목', 'Event', '種目'] },
    round_short: { preliminary: ['예선', 'H', '予'], semifinal: ['준결승', 'SF', '準'], final: ['결승', 'F', '決'] },
    round_status: { created: ['대기', 'Scheduled', '予定'], heats_generated: ['조편성', 'Start list', 'スタートリスト'], in_progress: ['진행 중', 'Live', '進行中'], completed: ['완료', 'Official', '確定'] },
    competition_status: { upcoming: ['예정', 'Upcoming', '予定'], active: ['진행 중', 'In progress', '進行中'], completed: ['종료', 'Completed', '終了'] },
    gender: { M: ['남자', 'Men', '男子'], F: ['여자', 'Women', '女子'], X: ['혼성', 'Mixed', '混合'] },
    gender_short: { M: ['남', 'M', '男'], F: ['여', 'W', '女'], X: ['혼', 'X', '混'] },
    category: { track: ['트랙', 'Track', 'トラック'], field_distance: ['필드(거리)', 'Field (horizontal/throws)', 'フィールド(距離)'], field_height: ['필드(높이)', 'Field (vertical)', 'フィールド(高さ)'], combined: ['혼성경기', 'Combined events', '混成競技'], relay: ['계주', 'Relays', 'リレー'], road: ['도로', 'Road', 'ロード'] },
    category_group: { '단거리': ['단거리', 'Sprints', '短距離'], '중장거리': ['중장거리', 'Middle & long distance', '中長距離'], '허들·장애물': ['허들·장애물', 'Hurdles & steeplechase', 'ハードル・障害'], '경보·도로': ['경보·도로', 'Race walks & road', '競歩・ロード'], '도약': ['도약', 'Jumps', '跳躍'], '투척': ['투척', 'Throws', '投てき'], '혼성': ['혼성', 'Combined', '混成'], '계주': ['계주', 'Relays', 'リレー'], '기타': ['기타', 'Other', 'その他'] },
    entry_status: { registered: ['등록', 'Entered', '登録'], checked_in: ['소집 완료', 'Checked in', '招集完了'], no_show: ['결장', 'DNS', '欠場'] },
    status_code: { DQ: ['실격', 'DQ', '失格'], DNS: ['결장', 'DNS', '欠場'], DNF: ['중도 포기', 'DNF', '途中棄権'], NM: ['기록 없음', 'NM', '記録なし'], NH: ['기록 없음', 'NH', '記録なし'] },
    qualified: { Q: ['순위 진출', 'Q (place)', '着順通過'], q: ['기록 진출', 'q (time)', '記録通過'], qJ: ['이의 제기 인용', 'q (jury)', '抗議認容'], qR: ['재경기', 'q (re-run)', '再レース'] },
    record: { WR: ['세계기록', 'World record', '世界記録'], AR: ['아시아기록', 'Area record', 'アジア記録'], GR: ['대회기록', 'Games record', '大会記録'], NR: ['한국기록', 'National record', '国内記録'], DR: ['부별기록', 'Division record', '部門記録'], CR: ['대회기록', 'Competition record', '大会記録'], PB: ['개인 최고', 'Personal best', '自己ベスト'], SB: ['시즌 최고', 'Season best', 'シーズンベスト'] },
    school_level: { ELEM: ['초등부', 'Elementary', '小学'], MID: ['중등부', 'Middle school', '中学'], HIGH: ['고등부', 'High school', '高校'], UNIV: ['대학부', 'University', '大学'], GEN: ['일반부', 'Senior', '一般'], OPEN: ['공개부', 'Open', 'オープン'], MIXED: ['통합부', 'Mixed', '混合'] },
    wind: { unit: ['m/s', 'm/s', 'm/s'], over: ['참고기록(풍속 초과)', 'Wind-assisted', '追い風参考'] },
};
const LANG_IDX = { ko: 0, en: 1, ja: 2 };
function pick(row, lang) { const i = LANG_IDX[lang] === undefined ? 0 : LANG_IDX[lang]; return row[i] != null ? row[i] : row[1]; }
function label(group, code, lang) {
    const g = DICT[group]; const row = g && g[code];
    if (!row) return code == null ? '' : String(code);
    return pick(row, lang);
}
function all(lang) {
    const out = {};
    for (const [g, rows] of Object.entries(DICT)) { out[g] = {}; for (const [k, v] of Object.entries(rows)) out[g][k] = pick(v, lang); }
    return out;
}
// 부 마스터 행 → 영문 라벨. 관리자가 label_en 을 직접 넣었으면 그걸 우선
function divisionLabelEn(row) {
    if (!row) return '';
    if (row.label_en && String(row.label_en).trim()) return String(row.label_en).trim();
    if (row.school_level === 'MIXED' || row.gender === 'X') return 'Mixed';
    const g = label('gender', row.gender, 'en');
    const lv = label('school_level', row.school_level, 'en');
    return `${g} ${lv}${row.grade ? ' Grade ' + row.grade : ''}`.trim();
}
// 일본어 부 라벨: 男子高校2年 / 女子一般 / 混合
function divisionLabelJa(row) {
    if (!row) return '';
    if (row.school_level === 'MIXED' || row.gender === 'X') return '混合';
    return `${label('gender', row.gender, 'ja')}${label('school_level', row.school_level, 'ja')}${row.grade ? row.grade + '年' : ''}`;
}
function divisionLabel(row, lang) { return lang === 'en' ? divisionLabelEn(row) : lang === 'ja' ? divisionLabelJa(row) : (row && row.label_ko) || ''; }
module.exports = { DICT, label, all, divisionLabelEn, divisionLabelJa, divisionLabel };
