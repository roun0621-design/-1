'use strict';
/**
 * 라벨 사전 — 라운드·상태·성별·종목군·상태코드·기록 종류·부(division) 의 한글/영문 표기 (2026-09-30, 해외 대회 대비 B2)
 *   서버 응답은 코드(round_type='semifinal' 등)를 주고, 표시 언어는 이 사전으로 고른다. `GET /api/labels?lang=en` 이 통째로 내려준다.
 *   label(group, code, lang)      예: label('round', 'semifinal', 'en') → 'Semifinal'
 *   divisionLabelEn(row)          division_master 행 → 영문 라벨 ('Men High School Grade 2', 'Women Senior', 'Mixed')
 *   all(lang)                     { round:{…}, status:{…}, … } 한 언어 전체
 */
const DICT = {
    round: { preliminary: ['예선', 'Heats'], semifinal: ['준결승', 'Semifinal'], final: ['결승', 'Final'], sub: ['세부종목', 'Event'] },
    round_short: { preliminary: ['예선', 'H'], semifinal: ['준결승', 'SF'], final: ['결승', 'F'] },
    round_status: { created: ['대기', 'Scheduled'], heats_generated: ['조편성', 'Start list'], in_progress: ['진행 중', 'Live'], completed: ['완료', 'Official'] },
    competition_status: { upcoming: ['예정', 'Upcoming'], active: ['진행 중', 'In progress'], completed: ['종료', 'Completed'] },
    gender: { M: ['남자', 'Men'], F: ['여자', 'Women'], X: ['혼성', 'Mixed'] },
    gender_short: { M: ['남', 'M'], F: ['여', 'W'], X: ['혼', 'X'] },
    category: { track: ['트랙', 'Track'], field_distance: ['필드(거리)', 'Field (horizontal/throws)'], field_height: ['필드(높이)', 'Field (vertical)'], combined: ['혼성경기', 'Combined events'], relay: ['계주', 'Relays'], road: ['도로', 'Road'] },
    category_group: { '단거리': ['단거리', 'Sprints'], '중장거리': ['중장거리', 'Middle & long distance'], '허들·장애물': ['허들·장애물', 'Hurdles & steeplechase'], '경보·도로': ['경보·도로', 'Race walks & road'], '도약': ['도약', 'Jumps'], '투척': ['투척', 'Throws'], '혼성': ['혼성', 'Combined'], '계주': ['계주', 'Relays'], '기타': ['기타', 'Other'] },
    entry_status: { registered: ['등록', 'Entered'], checked_in: ['소집 완료', 'Checked in'], no_show: ['결장', 'DNS'] },
    status_code: { DQ: ['실격', 'DQ'], DNS: ['결장', 'DNS'], DNF: ['중도 포기', 'DNF'], NM: ['기록 없음', 'NM'], NH: ['기록 없음', 'NH'] },
    qualified: { Q: ['순위 진출', 'Q (place)'], q: ['기록 진출', 'q (time)'], qJ: ['이의 제기 인용', 'q (jury)'], qR: ['재경기', 'q (re-run)'] },
    record: { WR: ['세계기록', 'World record'], AR: ['아시아기록', 'Area record'], GR: ['대회기록', 'Games record'], NR: ['한국기록', 'National record'], DR: ['부별기록', 'Division record'], CR: ['대회기록', 'Competition record'], PB: ['개인 최고', 'Personal best'], SB: ['시즌 최고', 'Season best'] },
    school_level: { ELEM: ['초등부', 'Elementary'], MID: ['중등부', 'Middle school'], HIGH: ['고등부', 'High school'], UNIV: ['대학부', 'University'], GEN: ['일반부', 'Senior'], OPEN: ['공개부', 'Open'], MIXED: ['통합부', 'Mixed'] },
    wind: { unit: ['m/s', 'm/s'], over: ['참고기록(풍속 초과)', 'Wind-assisted'] },
};
const LANG_IDX = { ko: 0, en: 1 };
function label(group, code, lang) {
    const g = DICT[group]; const row = g && g[code];
    if (!row) return code == null ? '' : String(code);
    return row[LANG_IDX[lang] === undefined ? 0 : LANG_IDX[lang]];
}
function all(lang) {
    const i = LANG_IDX[lang] === undefined ? 0 : LANG_IDX[lang]; const out = {};
    for (const [g, rows] of Object.entries(DICT)) { out[g] = {}; for (const [k, v] of Object.entries(rows)) out[g][k] = v[i]; }
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
module.exports = { DICT, label, all, divisionLabelEn };
