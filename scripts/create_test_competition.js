// 부별 종합기록지 + 5종경기 테스트용 대회 생성 스크립트
// 초/중/고/일반/대학 전 부 + 남녀 5종경기 + 다양한 종목(80m 포함) 모두 포함

const path = require('path');
const Database = require('better-sqlite3');
const db = new Database(path.join(__dirname, '..', 'db', 'competition.db'));

const COMP_NAME = '테스트 - 학년별/부별 종합기록지 (5종 포함)';

// ─── 기존 동명 대회 있으면 삭제 (테스트 반복용) ───
const existing = db.prepare('SELECT id FROM competition WHERE name=?').get(COMP_NAME);
if (existing) {
    console.log(`[Cleanup] 기존 테스트 대회 삭제: comp_id=${existing.id}`);
    const cid = existing.id;
    db.prepare('DELETE FROM heat_entry WHERE heat_id IN (SELECT id FROM heat WHERE event_id IN (SELECT id FROM event WHERE competition_id=?))').run(cid);
    db.prepare('DELETE FROM heat WHERE event_id IN (SELECT id FROM event WHERE competition_id=?)').run(cid);
    db.prepare('DELETE FROM event_entry WHERE event_id IN (SELECT id FROM event WHERE competition_id=?)').run(cid);
    db.prepare('DELETE FROM event WHERE competition_id=?').run(cid);
    db.prepare('DELETE FROM athlete WHERE competition_id=?').run(cid);
    db.prepare('DELETE FROM competition WHERE id=?').run(cid);
}

// ─── 대회 생성 ───
const info = db.prepare(`INSERT INTO competition (name, start_date, end_date, venue, federation, mode, division_type) VALUES (?,?,?,?,?,?,?)`)
    .run(COMP_NAME, '2026-09-25', '2026-09-29', '보은스포츠파크', 'KAAF', 'operation', '');
const compId = info.lastInsertRowid;
console.log(`[OK] 대회 생성: comp_id=${compId}, name="${COMP_NAME}"`);

// ─── 부 정의 (division_master code) ───
// 학년별/세부 부 추가도 가능하지만 일단 13부 + 학년부 일부 추가
const DIVISIONS = [
    // 초등부 (학년별)
    { code: 'M_ELEM_34', label: '남자초등 3,4학년부', gender: 'M', sort: 1 },
    { code: 'F_ELEM_34', label: '여자초등 3,4학년부', gender: 'F', sort: 2 },
    { code: 'M_ELEM_5', label: '남자초등 5학년부', gender: 'M', sort: 3 },
    { code: 'F_ELEM_5', label: '여자초등 5학년부', gender: 'F', sort: 4 },
    { code: 'M_ELEM_6', label: '남자초등 6학년부', gender: 'M', sort: 5 },
    { code: 'F_ELEM_6', label: '여자초등 6학년부', gender: 'F', sort: 6 },
    // 중학교
    { code: 'M_MID', label: '남자중학부', gender: 'M', sort: 10 },
    { code: 'F_MID', label: '여자중학부', gender: 'F', sort: 11 },
    // 고등학교
    { code: 'M_HIGH', label: '남자고등부', gender: 'M', sort: 20 },
    { code: 'F_HIGH', label: '여자고등부', gender: 'F', sort: 21 },
    // 대학/일반
    { code: 'M_UNIV', label: '남자대학부', gender: 'M', sort: 30 },
    { code: 'F_UNIV', label: '여자대학부', gender: 'F', sort: 31 },
    { code: 'M_GEN', label: '남자일반부', gender: 'M', sort: 40 },
    { code: 'F_GEN', label: '여자일반부', gender: 'F', sort: 41 },
];

// 부 추가가 안 된 코드들을 division_master에 INSERT (idempotent)
const insDM = db.prepare(`INSERT OR IGNORE INTO division_master (code, label_ko, gender, school_level, sort_order) VALUES (?,?,?,?,?)`);
for (const d of DIVISIONS) {
    let lvl = 'MIXED';
    if (d.code.includes('ELEM')) lvl = 'ELEM';
    else if (d.code.includes('MID')) lvl = 'MID';
    else if (d.code.includes('HIGH')) lvl = 'HIGH';
    else if (d.code.includes('UNIV')) lvl = 'UNIV';
    else if (d.code.includes('GEN')) lvl = 'GEN';
    insDM.run(d.code, d.label, d.gender, lvl, 1000 + d.sort);
}
console.log(`[OK] division_master 시드 (사용자 정의 부 ${DIVISIONS.length}개 추가)`);

// ─── 종목 생성 ───
// 부별로 다른 종목 세트가 등장하도록 구성
const EVENT_SETS = {
    // 초3,4학년부: 80m, 800m, 멀리뛰기, 높이뛰기, 4x100mR (80m 포함 = 핵심 테스트!)
    'M_ELEM_34': [
        { name: '80m', category: 'track' },
        { name: '800m', category: 'track' },
        { name: '멀리뛰기', category: 'field_distance' },
        { name: '높이뛰기', category: 'field_height' },
        { name: '4x100mR', category: 'relay' },
    ],
    'F_ELEM_34': [
        { name: '80m', category: 'track' },
        { name: '800m', category: 'track' },
        { name: '멀리뛰기', category: 'field_distance' },
    ],
    // 초5: 80m + 100m
    'M_ELEM_5': [
        { name: '80m', category: 'track' },
        { name: '100m', category: 'track' },
        { name: '포환던지기', category: 'field_distance' },
    ],
    'F_ELEM_5': [
        { name: '80m', category: 'track' },
        { name: '100m', category: 'track' },
    ],
    // 초6
    'M_ELEM_6': [
        { name: '100m', category: 'track' },
        { name: '200m', category: 'track' },
        { name: '4x100mR', category: 'relay' },
    ],
    'F_ELEM_6': [
        { name: '100m', category: 'track' },
        { name: '4x100mR', category: 'relay' },
    ],
    // 중학교: 5종경기 포함 (★ 핵심 테스트!)
    'M_MID': [
        { name: '100m', category: 'track' },
        { name: '200m', category: 'track' },
        { name: '400m', category: 'track' },
        { name: '800m', category: 'track' },
        { name: '1500m', category: 'track' },
        { name: '3000m', category: 'track' },  // 중학생 종목, 화이트리스트 없는 종목 테스트
        { name: '110mH', category: 'track' },
        { name: '높이뛰기', category: 'field_height' },
        { name: '멀리뛰기', category: 'field_distance' },
        { name: '포환던지기', category: 'field_distance' },
        { name: '원반던지기', category: 'field_distance' },
        { name: '창던지기', category: 'field_distance' },
        { name: '4x100mR', category: 'relay' },
        { name: '4x400mR', category: 'relay' },
        { name: '5종경기', category: 'combined' },  // ★ 남자 5종 (110mH 포함)
    ],
    'F_MID': [
        { name: '100m', category: 'track' },
        { name: '200m', category: 'track' },
        { name: '400m', category: 'track' },
        { name: '800m', category: 'track' },
        { name: '1500m', category: 'track' },
        { name: '100mH', category: 'track' },
        { name: '높이뛰기', category: 'field_height' },
        { name: '멀리뛰기', category: 'field_distance' },
        { name: '포환던지기', category: 'field_distance' },
        { name: '4x100mR', category: 'relay' },
        { name: '5종경기', category: 'combined' },  // ★ 여자 5종 (100mH 포함)
    ],
    // 고등학교: 10종/7종
    'M_HIGH': [
        { name: '100m', category: 'track' },
        { name: '200m', category: 'track' },
        { name: '400m', category: 'track' },
        { name: '110mH', category: 'track' },
        { name: '높이뛰기', category: 'field_height' },
        { name: '멀리뛰기', category: 'field_distance' },
        { name: '포환던지기', category: 'field_distance' },
        { name: '10종경기', category: 'combined' },
    ],
    'F_HIGH': [
        { name: '100m', category: 'track' },
        { name: '200m', category: 'track' },
        { name: '100mH', category: 'track' },
        { name: '높이뛰기', category: 'field_height' },
        { name: '멀리뛰기', category: 'field_distance' },
        { name: '7종경기', category: 'combined' },
    ],
    // 대학/일반: 표준 종목
    'M_UNIV': [
        { name: '100m', category: 'track' },
        { name: '5000m', category: 'track' },
        { name: '10000m', category: 'track' },
        { name: '110mH', category: 'track' },
        { name: '높이뛰기', category: 'field_height' },
        { name: '멀리뛰기', category: 'field_distance' },
        { name: '포환던지기', category: 'field_distance' },
        { name: '해머던지기', category: 'field_distance' },
        { name: '4x400mR', category: 'relay' },
    ],
    'F_UNIV': [
        { name: '100m', category: 'track' },
        { name: '5000m', category: 'track' },
        { name: '100mH', category: 'track' },
        { name: '높이뛰기', category: 'field_height' },
        { name: '4x400mR', category: 'relay' },
    ],
    'M_GEN': [
        { name: '100m', category: 'track' },
        { name: '1500m', category: 'track' },
        { name: '5000m', category: 'track' },
        { name: '10000m', category: 'track' },
        { name: '마라톤', category: 'road' },  // 도로종목 테스트
        { name: '높이뛰기', category: 'field_height' },
        { name: '멀리뛰기', category: 'field_distance' },
    ],
    'F_GEN': [
        { name: '100m', category: 'track' },
        { name: '1500m', category: 'track' },
        { name: '5000m', category: 'track' },
        { name: '마라톤', category: 'road' },
    ],
};

let createdEvents = 0;
let createdCombinedParents = [];

const insEv = db.prepare(`INSERT INTO event (competition_id, name, category, gender, division, round_type, round_status, sort_order) VALUES (?,?,?,?,?,'final','heats_generated',?)`);

for (const [divCode, events] of Object.entries(EVENT_SETS)) {
    const div = DIVISIONS.find(d => d.code === divCode);
    if (!div) continue;
    let sortOrder = 1;
    for (const ev of events) {
        const r = insEv.run(compId, ev.name, ev.category, div.gender, divCode, sortOrder++);
        createdEvents++;
        if (ev.category === 'combined') {
            createdCombinedParents.push({ id: r.lastInsertRowid, name: ev.name, gender: div.gender, division: divCode });
        }
    }
}
console.log(`[OK] 종목 생성: ${createdEvents}개 (combined parent ${createdCombinedParents.length}개 포함)`);

// ─── Combined sub-events 생성 (5종/7종/10종) ───
const DECATHLON_SUBS = [
    {order:1, name:'100m', category:'track'},
    {order:2, name:'멀리뛰기', category:'field_distance'},
    {order:3, name:'포환던지기', category:'field_distance'},
    {order:4, name:'높이뛰기', category:'field_height'},
    {order:5, name:'400m', category:'track'},
    {order:6, name:'110mH', category:'track'},
    {order:7, name:'원반던지기', category:'field_distance'},
    {order:8, name:'장대높이뛰기', category:'field_height'},
    {order:9, name:'창던지기', category:'field_distance'},
    {order:10, name:'1500m', category:'track'},
];
const HEPTATHLON_SUBS = [
    {order:1, name:'100mH', category:'track'},
    {order:2, name:'높이뛰기', category:'field_height'},
    {order:3, name:'포환던지기', category:'field_distance'},
    {order:4, name:'200m', category:'track'},
    {order:5, name:'멀리뛰기', category:'field_distance'},
    {order:6, name:'창던지기', category:'field_distance'},
    {order:7, name:'800m', category:'track'},
];
const PENTATHLON_M_SUBS = [
    {order:1, name:'100m', category:'track'},
    {order:2, name:'포환던지기', category:'field_distance'},
    {order:3, name:'110mH', category:'track'},
    {order:4, name:'높이뛰기', category:'field_height'},
    {order:5, name:'800m', category:'track'},
];
const PENTATHLON_F_SUBS = [
    {order:1, name:'100m', category:'track'},
    {order:2, name:'포환던지기', category:'field_distance'},
    {order:3, name:'100mH', category:'track'},
    {order:4, name:'높이뛰기', category:'field_height'},
    {order:5, name:'800m', category:'track'},
];

const insSubEv = db.prepare(`INSERT INTO event (competition_id, name, category, gender, division, round_type, round_status, parent_event_id, sort_order) VALUES (?,?,?,?,?,'final','heats_generated',?,?)`);

for (const parent of createdCombinedParents) {
    let subs, prefix;
    if (parent.name === '10종경기') { subs = DECATHLON_SUBS; prefix = '[10종]'; }
    else if (parent.name === '7종경기') { subs = HEPTATHLON_SUBS; prefix = '[7종]'; }
    else if (parent.name === '5종경기') {
        subs = parent.gender === 'F' ? PENTATHLON_F_SUBS : PENTATHLON_M_SUBS;
        prefix = '[5종]';
    } else { continue; }

    for (const sub of subs) {
        const subName = `${prefix} ${sub.name}`;
        insSubEv.run(compId, subName, sub.category, parent.gender, parent.division, parent.id, sub.order);
    }
    console.log(`  → ${parent.name} (${parent.gender}, ${parent.division}): ${subs.length}개 sub-events 생성`);
}

// ─── 샘플 선수 일부 생성 (각 부에 2~3명씩) ───
// athlete 테이블에는 division 컬럼 없음 — event 측에만 division 존재
const insAth = db.prepare(`INSERT INTO athlete (competition_id, name, gender, team, bib_number) VALUES (?,?,?,?,?)`);
let bibCounter = 1001;
let athleteCount = 0;
for (const div of DIVISIONS) {
    for (let i = 1; i <= 3; i++) {
        const name = `${div.label.replace(/\s/g,'')}_선수${i}`;
        insAth.run(compId, name, div.gender, `테스트팀(${div.label})`, String(bibCounter++));
        athleteCount++;
    }
}
console.log(`[OK] 샘플 선수 ${athleteCount}명 생성 (각 부 3명씩)`);

console.log('\n=========================================');
console.log(`✅ 테스트 대회 생성 완료`);
console.log(`   comp_id: ${compId}`);
console.log(`   부 개수: ${DIVISIONS.length}`);
console.log(`   종목 개수: ${createdEvents}`);
console.log(`   combined parents: ${createdCombinedParents.length}`);
console.log('=========================================');
db.close();
