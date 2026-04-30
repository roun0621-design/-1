/**
 * PACE RISE : Node — Demo Seed Script
 * 2026 전국육상경기선수권대회 (3일, 4/18~20)
 * 실존 한국 선수 + 실제 기록 수준 + 전종목 + 모든 기능
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Backup first
const DB_PATH = path.join(__dirname, '..', 'db', 'competition.db');
const BACKUP_PATH = path.join(__dirname, '..', 'backups', `pre_demo_${Date.now()}.db`);
if (!fs.existsSync(path.dirname(BACKUP_PATH))) fs.mkdirSync(path.dirname(BACKUP_PATH), { recursive: true });
fs.copyFileSync(DB_PATH, BACKUP_PATH);
console.log(`[Backup] ${BACKUP_PATH}`);

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = OFF');

// ============================================================
// 1. CLEAR OLD DATA (keep system config)
// ============================================================
console.log('[1/10] Clearing old data...');
const dataTables = [
    'pacing_segment','pacing_color','pacing_config',
    'qualification_selection','combined_score','height_attempt',
    'relay_member','result','heat_entry','heat',
    'event_entry','event_records','event_link','event',
    'timetable','athlete','competition','joint_group_member','joint_group',
    'audit_log','operation_log','doc_template','home_popup','home_popup_section'
];
dataTables.forEach(t => { try { db.exec(`DELETE FROM ${t}`); } catch(e) {} });
try { db.exec("DELETE FROM sqlite_sequence WHERE name IN ('" + dataTables.join("','") + "')"); } catch(e) {}
console.log('  Cleared.');

// ============================================================
// 2. COMPETITION
// ============================================================
console.log('[2/10] Creating competition...');
const comp = db.prepare(`INSERT INTO competition (name, start_date, end_date, venue, status, federation, division_type) VALUES (?,?,?,?,?,?,?)`)
    .run('2026 전국육상경기선수권대회', '2026-04-18', '2026-04-20', '서울종합운동장(잠실)', 'active', '', '');
const COMP_ID = Number(comp.lastInsertRowid);

// Doc template
db.prepare(`INSERT INTO doc_template (competition_id, ad_card, start_list, result_sheet) VALUES (?,?,?,?)`)
    .run(COMP_ID, '{}',
    '{"team_label":"소속","show_header":true,"show_lane":true,"show_bib":true,"show_name":true,"show_team":true,"show_status":true,"show_pb":true,"show_dob":true}',
    JSON.stringify({
        team_label:"소속", show_header:true, show_signature:true, show_rank:true, show_lane:true, show_bib:true, show_name:true, show_team:true, show_record:true, show_remark:true, show_wind:true,
        show_records_table:true, chief_judge:"이종훈", chief_recorder_name:"김세종",
        records: {
            nr:{label:"한국기록(NR)",record:"",athlete:"",team:"",year:""},
            cr:{label:"대회기록(CR)",record:"",athlete:"",team:"",year:""}
        }
    }));

// ============================================================
// 3. ATHLETES — Real Korean track & field athletes
// ============================================================
console.log('[3/10] Creating athletes...');

let bibCounter = { M: 100, F: 500 };
function addAthlete(name, gender, team, pb, dob) {
    const bib = bibCounter[gender]++;
    return Number(db.prepare(`INSERT INTO athlete (competition_id, name, bib_number, team, gender, federation, personal_best, date_of_birth, barcode) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(COMP_ID, name, bib, team, gender, '', pb || '', dob || '', `BC${bib}`).lastInsertRowid);
}

// ---- MALE ATHLETES ----
const M = {};
// Sprinters 100m/200m
M['김국영'] = addAthlete('김국영', 'M', '광주광역시청', '10.07', '1991-01-27');
M['이정태'] = addAthlete('이정태', 'M', '제주특별자치도청', '10.15', '2002-06-15');
M['오세하'] = addAthlete('오세하', 'M', '코오롱', '10.19', '1997-03-12');
M['정세영'] = addAthlete('정세영', 'M', '삼성전자', '10.22', '2000-08-20');
M['박봉고'] = addAthlete('박봉고', 'M', '부산광역시청', '10.25', '1999-04-05');
M['최명진'] = addAthlete('최명진', 'M', '경기도청', '10.28', '2001-11-10');
M['이재원'] = addAthlete('이재원', 'M', '한국전력', '10.30', '1998-07-22');
M['김건우'] = addAthlete('김건우', 'M', '삼성전자', '10.33', '2003-02-14');
// 200m specialists
M['여호수아'] = addAthlete('여호수아', 'M', '남양주시청', '20.45', '2000-05-30');
M['이동규'] = addAthlete('이동규', 'M', '대구광역시청', '20.62', '1999-09-18');
// 400m
M['백승호'] = addAthlete('백승호', 'M', '화성시청', '45.89', '2000-03-25');
M['김세준'] = addAthlete('김세준', 'M', '대전광역시청', '46.12', '2001-12-08');
M['정혁'] = addAthlete('정혁', 'M', '울산광역시청', '46.35', '1998-06-14');
M['이민규'] = addAthlete('이민규', 'M', '인천광역시청', '46.50', '2002-01-20');
// 800m/1500m
M['이재영'] = addAthlete('이재영', 'M', '경기도청', '1:47.2', '1999-04-12');
M['김현수'] = addAthlete('김현수', 'M', '삼성전자', '1:47.8', '2001-08-03');
M['박민수'] = addAthlete('박민수', 'M', '코오롱', '1:48.5', '2000-02-17');
M['최원호'] = addAthlete('최원호', 'M', '화성시청', '3:40.1', '1998-11-25');
M['강태훈'] = addAthlete('강태훈', 'M', '제주특별자치도청', '3:41.5', '2002-07-09');
M['장선우'] = addAthlete('장선우', 'M', '대전광역시청', '1:48.0', '2000-06-14');
M['최동현'] = addAthlete('최동현', 'M', '부산광역시청', '1:49.2', '2001-03-28');
M['신동우'] = addAthlete('신동우', 'M', '광주광역시청', '3:42.5', '2000-09-11');
// 5000m/10000m
M['심종섭'] = addAthlete('심종섭', 'M', '화성시청', '13:35', '1996-01-15');
M['안승빈'] = addAthlete('안승빈', 'M', '경기도청', '13:42', '2000-10-22');
M['이성민'] = addAthlete('이성민', 'M', '삼성전자', '13:50', '1999-05-08');
M['정찬영'] = addAthlete('정찬영', 'M', '코오롱', '13:55', '2001-07-19');
M['윤성호'] = addAthlete('윤성호', 'M', '대구광역시청', '29:15', '1998-02-04');
M['김태훈'] = addAthlete('김태훈', 'M', '울산광역시청', '29:30', '2000-11-16');
// 3000mSC
M['김명우'] = addAthlete('김명우', 'M', '경기도청', '8:42', '1999-08-25');
M['박성호'] = addAthlete('박성호', 'M', '코오롱', '8:50', '2001-04-10');
// Hurdles
M['박태건'] = addAthlete('박태건', 'M', '대구광역시청', '13.62', '1998-03-30');
M['김대건'] = addAthlete('김대건', 'M', '광주광역시청', '13.78', '2001-09-14');
M['이준영'] = addAthlete('이준영', 'M', '삼성전자', '13.85', '2002-05-20');
M['이상혁'] = addAthlete('이상혁', 'M', '화성시청', '49.52', '1999-12-01');
M['김승환'] = addAthlete('김승환', 'M', '코오롱', '49.80', '2000-06-23');
M['오민혁'] = addAthlete('오민혁', 'M', '인천광역시청', '50.10', '2001-08-15');
// High jump
M['우상혁'] = addAthlete('우상혁', 'M', '용인시청', '2.36', '1996-04-27');
M['정진욱'] = addAthlete('정진욱', 'M', '부산광역시청', '2.22', '2001-03-15');
M['강현우'] = addAthlete('강현우', 'M', '대전광역시청', '2.18', '2003-08-10');
M['박성민'] = addAthlete('박성민', 'M', '삼성전자', '2.15', '2002-05-22');
M['이태준'] = addAthlete('이태준', 'M', '경기도청', '2.12', '2001-09-30');
M['김도윤'] = addAthlete('김도윤', 'M', '코오롱', '2.10', '2003-01-18');
// Pole vault
M['진민섭'] = addAthlete('진민섭', 'M', '제주특별자치도청', '5.63', '1995-07-19');
M['이준호'] = addAthlete('이준호', 'M', '화성시청', '5.30', '2001-10-05');
M['김동현'] = addAthlete('김동현', 'M', '삼성전자', '5.20', '2002-03-14');
M['최진혁'] = addAthlete('최진혁', 'M', '대구광역시청', '5.10', '2000-07-28');
// Long jump
M['김도현'] = addAthlete('김도현', 'M', '경기도청', '7.92', '1999-02-28');
M['이하늘'] = addAthlete('이하늘', 'M', '삼성전자', '7.75', '2001-06-13');
M['박현수'] = addAthlete('박현수', 'M', '화성시청', '7.60', '2002-09-05');
M['강민재'] = addAthlete('강민재', 'M', '코오롱', '7.45', '2000-12-20');
M['윤재호'] = addAthlete('윤재호', 'M', '대전광역시청', '7.35', '2003-04-15');
M['서영진'] = addAthlete('서영진', 'M', '부산광역시청', '7.25', '2001-11-08');
// Triple jump
M['김민성'] = addAthlete('김민성', 'M', '대구광역시청', '16.28', '2000-09-07');
M['박준형'] = addAthlete('박준형', 'M', '광주광역시청', '15.95', '2002-01-11');
M['이현우'] = addAthlete('이현우', 'M', '삼성전자', '15.80', '2001-05-25');
M['정우성'] = addAthlete('정우성', 'M', '경기도청', '15.60', '2003-02-18');
// Shot put
M['정일우'] = addAthlete('정일우', 'M', '삼성전자', '18.52', '1997-08-16');
M['이병찬'] = addAthlete('이병찬', 'M', '화성시청', '17.80', '2000-12-03');
M['강진호'] = addAthlete('강진호', 'M', '코오롱', '17.20', '2001-07-15');
M['박형준'] = addAthlete('박형준', 'M', '대전광역시청', '16.80', '2002-03-28');
// Discus
M['강창수'] = addAthlete('강창수', 'M', '코오롱', '57.25', '1998-04-20');
M['박지훈'] = addAthlete('박지훈', 'M', '울산광역시청', '55.90', '2001-07-28');
M['이건호'] = addAthlete('이건호', 'M', '삼성전자', '54.50', '2000-10-12');
M['김우진'] = addAthlete('김우진', 'M', '경기도청', '53.00', '2002-06-05');
// Javelin
M['허강민'] = addAthlete('허강민', 'M', '제주특별자치도청', '74.15', '1999-11-14');
M['최성재'] = addAthlete('최성재', 'M', '대전광역시청', '72.30', '2002-03-06');
M['남상원'] = addAthlete('남상원', 'M', '부산광역시청', '68.50', '2000-10-19');
M['김태형'] = addAthlete('김태형', 'M', '경기도청', '66.80', '2001-05-25');
// Hammer
M['이윤호'] = addAthlete('이윤호', 'M', '화성시청', '65.80', '1998-09-12');
M['정재원'] = addAthlete('정재원', 'M', '코오롱', '63.50', '2001-02-20');
M['박현진'] = addAthlete('박현진', 'M', '삼성전자', '61.20', '2002-08-07');
M['김호진'] = addAthlete('김호진', 'M', '대구광역시청', '59.80', '2000-04-16');
// Decathlon
M['최진우'] = addAthlete('최진우', 'M', '삼성전자', '7800', '1999-08-12');
M['이경민'] = addAthlete('이경민', 'M', '화성시청', '7500', '2001-02-03');
M['김형준'] = addAthlete('김형준', 'M', '코오롱', '7200', '2000-06-18');
M['박성찬'] = addAthlete('박성찬', 'M', '경기도청', '6900', '2002-04-22');

// Extra male for relay teams (4 teams x 4-6 runners)
const relayTeamsM = ['삼성전자','코오롱','경기도청','화성시청'];
for (let t = 0; t < 4; t++) {
    for (let i = 1; i <= 6; i++) {
        M[`relay_${relayTeamsM[t]}_m_${i}`] = addAthlete(`${relayTeamsM[t]}선수${i}`, 'M', relayTeamsM[t], '', `200${i}-01-01`);
    }
}

// ---- FEMALE ATHLETES ----
const F = {};
// Sprinters 100m/200m
F['양예빈'] = addAthlete('양예빈', 'F', '화성시청', '11.45', '2002-03-12');
F['김민지'] = addAthlete('김민지', 'F', '삼성전자', '11.52', '2001-07-20');
F['이소영'] = addAthlete('이소영', 'F', '경기도청', '11.60', '2003-01-15');
F['박서연'] = addAthlete('박서연', 'F', '코오롱', '11.68', '2000-09-28');
F['최수빈'] = addAthlete('최수빈', 'F', '대구광역시청', '11.75', '2002-05-10');
F['한민지'] = addAthlete('한민지', 'F', '광주광역시청', '11.80', '2001-11-22');
F['정다은'] = addAthlete('정다은', 'F', '제주특별자치도청', '11.88', '2003-04-08');
F['서유나'] = addAthlete('서유나', 'F', '인천광역시청', '11.95', '2000-08-17');
// 200m/400m
F['김민서'] = addAthlete('김민서', 'F', '화성시청', '23.50', '2001-06-05');
F['이현진'] = addAthlete('이현진', 'F', '삼성전자', '23.80', '2002-02-19');
F['박하늘'] = addAthlete('박하늘', 'F', '경기도청', '52.80', '2000-10-30');
F['최윤서'] = addAthlete('최윤서', 'F', '코오롱', '53.20', '2003-07-14');
F['정수현'] = addAthlete('정수현', 'F', '대전광역시청', '53.60', '2001-09-12');
F['이예진'] = addAthlete('이예진', 'F', '부산광역시청', '54.00', '2002-04-25');
// 800m/1500m
F['김서연'] = addAthlete('김서연', 'F', '삼성전자', '2:03.5', '2001-04-25');
F['이수민'] = addAthlete('이수민', 'F', '화성시청', '2:04.8', '2002-12-08');
F['장선영'] = addAthlete('장선영', 'F', '대전광역시청', '4:15.0', '1999-03-17');
F['박유진'] = addAthlete('박유진', 'F', '경기도청', '2:05.5', '2001-08-14');
F['이지수'] = addAthlete('이지수', 'F', '코오롱', '4:18.0', '2002-05-20');
// 5000m/10000m
F['정유진'] = addAthlete('정유진', 'F', '경기도청', '15:42', '2000-07-22');
F['박은빈'] = addAthlete('박은빈', 'F', '코오롱', '15:58', '2001-11-05');
F['김하늘'] = addAthlete('김하늘', 'F', '삼성전자', '16:10', '2002-03-18');
// 3000mSC
F['이도연'] = addAthlete('이도연', 'F', '화성시청', '10:05', '2001-06-30');
F['최은정'] = addAthlete('최은정', 'F', '경기도청', '10:20', '2002-09-15');
// Hurdles
F['정혜림'] = addAthlete('정혜림', 'F', '대구광역시청', '13.18', '2000-06-30');
F['김다영'] = addAthlete('김다영', 'F', '광주광역시청', '13.45', '2002-09-12');
F['이서윤'] = addAthlete('이서윤', 'F', '삼성전자', '13.60', '2001-02-25');
F['이지원'] = addAthlete('이지원', 'F', '삼성전자', '56.50', '2001-01-28');
F['박예린'] = addAthlete('박예린', 'F', '코오롱', '57.20', '2002-07-18');
F['김소연'] = addAthlete('김소연', 'F', '화성시청', '57.80', '2003-03-10');
// High jump
F['김현진'] = addAthlete('김현진', 'F', '화성시청', '1.87', '2002-05-14');
F['박선아'] = addAthlete('박선아', 'F', '경기도청', '1.82', '2003-10-20');
F['이나영'] = addAthlete('이나영', 'F', '삼성전자', '1.78', '2001-08-06');
F['최서현'] = addAthlete('최서현', 'F', '코오롱', '1.75', '2002-11-28');
F['정민서'] = addAthlete('정민서', 'F', '대전광역시청', '1.72', '2003-05-10');
F['한유진'] = addAthlete('한유진', 'F', '대구광역시청', '1.70', '2001-09-22');
// Pole vault
F['임은지'] = addAthlete('임은지', 'F', '코오롱', '4.30', '1999-12-15');
F['최지은'] = addAthlete('최지은', 'F', '화성시청', '4.10', '2002-04-02');
F['박수아'] = addAthlete('박수아', 'F', '삼성전자', '3.90', '2001-07-20');
F['이가영'] = addAthlete('이가영', 'F', '경기도청', '3.80', '2003-02-14');
// Long jump
F['김유리'] = addAthlete('김유리', 'F', '삼성전자', '6.35', '2001-03-18');
F['이하은'] = addAthlete('이하은', 'F', '대구광역시청', '6.20', '2002-07-25');
F['박지수'] = addAthlete('박지수', 'F', '경기도청', '6.05', '2000-12-10');
F['최민경'] = addAthlete('최민경', 'F', '코오롱', '5.90', '2003-04-22');
// Triple jump
F['박소희'] = addAthlete('박소희', 'F', '경기도청', '13.45', '2000-11-09');
F['김수진'] = addAthlete('김수진', 'F', '삼성전자', '13.20', '2002-06-18');
F['이지현'] = addAthlete('이지현', 'F', '화성시청', '13.00', '2001-01-30');
// Shot put
F['이미영'] = addAthlete('이미영', 'F', '화성시청', '16.80', '1998-05-22');
F['김슬기'] = addAthlete('김슬기', 'F', '코오롱', '15.95', '2001-09-30');
F['박현아'] = addAthlete('박현아', 'F', '삼성전자', '15.20', '2002-03-08');
// Discus
F['정아름'] = addAthlete('정아름', 'F', '삼성전자', '55.20', '2000-02-14');
F['최예진'] = addAthlete('최예진', 'F', '대전광역시청', '53.80', '2002-06-07');
F['김보라'] = addAthlete('김보라', 'F', '코오롱', '52.00', '2001-10-15');
// Javelin
F['한소망'] = addAthlete('한소망', 'F', '광주광역시청', '58.60', '1999-10-11');
F['박지연'] = addAthlete('박지연', 'F', '부산광역시청', '56.50', '2001-01-23');
F['이은서'] = addAthlete('이은서', 'F', '삼성전자', '54.80', '2002-08-30');
// Hammer
F['이수진'] = addAthlete('이수진', 'F', '경기도청', '60.15', '2000-08-28');
F['최민지'] = addAthlete('최민지', 'F', '화성시청', '58.20', '2001-12-05');
F['박서현'] = addAthlete('박서현', 'F', '코오롱', '56.00', '2002-05-18');
// Heptathlon
F['김다솜'] = addAthlete('김다솜', 'F', '삼성전자', '5800', '2001-04-15');
F['이서현'] = addAthlete('이서현', 'F', '화성시청', '5500', '2002-11-20');
F['박지현'] = addAthlete('박지현', 'F', '코오롱', '5200', '2003-03-08');
F['정하은'] = addAthlete('정하은', 'F', '경기도청', '5000', '2001-07-12');

// Extra female for relay teams (4 teams x 6 runners)
const relayTeamsF = ['삼성전자','코오롱','경기도청','화성시청'];
for (let t = 0; t < 4; t++) {
    for (let i = 1; i <= 6; i++) {
        F[`relay_${relayTeamsF[t]}_f_${i}`] = addAthlete(`${relayTeamsF[t]}여선수${i}`, 'F', relayTeamsF[t], '', `200${i}-01-01`);
    }
}

const athCount = db.prepare('SELECT COUNT(*) as c FROM athlete WHERE competition_id=?').get(COMP_ID).c;
console.log(`  Created ${athCount} athletes.`);

// ============================================================
// HELPER FUNCTIONS
// ============================================================
const now = () => new Date().toISOString().replace('T', ' ').substring(0, 19);

function createEvent(name, category, gender, roundType, roundStatus, sortOrder, parentId) {
    return Number(db.prepare(`INSERT INTO event (competition_id, name, category, gender, round_type, round_status, sort_order, parent_event_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(COMP_ID, name, category, gender, roundType, roundStatus, sortOrder, parentId || null, now()).lastInsertRowid);
}

function createHeat(eventId, heatNumber, wind, heatName) {
    return Number(db.prepare(`INSERT INTO heat (event_id, heat_number, wind, heat_name, created_at) VALUES (?,?,?,?,?)`)
        .run(eventId, heatNumber, wind || null, heatName || null, now()).lastInsertRowid);
}

function createEntry(eventId, athleteId, status) {
    return Number(db.prepare(`INSERT INTO event_entry (event_id, athlete_id, status, created_at) VALUES (?,?,?,?)`)
        .run(eventId, athleteId, status || 'registered', now()).lastInsertRowid);
}

function createHeatEntry(heatId, entryId, lane) {
    return Number(db.prepare(`INSERT INTO heat_entry (heat_id, event_entry_id, lane_number, created_at) VALUES (?,?,?,?)`)
        .run(heatId, entryId, lane, now()).lastInsertRowid);
}

function insertResult(heatId, entryId, opts) {
    // opts: { time_seconds, distance_meters, attempt_number, remark, status_code, wind }
    return Number(db.prepare(`INSERT INTO result (heat_id, event_entry_id, attempt_number, distance_meters, time_seconds, remark, status_code, wind, created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(heatId, entryId, opts.attempt_number || null, opts.distance_meters || null, opts.time_seconds || null, opts.remark || '', opts.status_code || '', opts.wind || null, now()).lastInsertRowid);
}

function insertHeightAttempt(heatId, entryId, barHeight, attemptNum, mark) {
    return db.prepare(`INSERT INTO height_attempt (heat_id, event_entry_id, bar_height, attempt_number, result_mark, created_at) VALUES (?,?,?,?,?,?)`)
        .run(heatId, entryId, barHeight, attemptNum, mark, now());
}

function insertCombinedScore(entryId, subName, subOrder, rawRecord, waPoints) {
    return db.prepare(`INSERT INTO combined_score (event_entry_id, sub_event_name, sub_event_order, raw_record, wa_points, created_at) VALUES (?,?,?,?,?,?)`)
        .run(entryId, subName, subOrder, rawRecord, waPoints, now());
}

// Gaussian-like random variation: base +/- range
function vary(base, range) {
    return +(base + (Math.random() - 0.5) * 2 * range).toFixed(2);
}

// ============================================================
// 4. EVENTS + HEATS + ENTRIES + RESULTS
// ============================================================
console.log('[4/10] Creating events...');

let sortOrder = 0;
const allEvents = {}; // store event info for timetable

// -------------------------------------------------------
// TRACK EVENTS - MALE
// -------------------------------------------------------

// --- M 100m: prelim (COMPLETED) + final (COMPLETED) = Day1 ---
{
    const runners = ['김국영','이정태','오세하','정세영','박봉고','최명진','이재원','김건우'];
    // Prelim
    const evPrelim = createEvent('100m', 'track', 'M', 'preliminary', 'completed', sortOrder++, null);
    allEvents['M_100m_prelim'] = evPrelim;
    const h1 = createHeat(evPrelim, 1, 0.8, null);
    const h2 = createHeat(evPrelim, 2, 1.2, null);
    const ents = runners.map(n => ({ name: n, eid: createEntry(evPrelim, M[n], 'checked_in') }));
    // Heat 1: 4 runners
    [0,1,2,3].forEach((i, lane) => {
        const he = createHeatEntry(h1, ents[i].eid, lane+3);
        const times = [10.12, 10.18, 10.25, 10.38];
        insertResult(h1, ents[i].eid, { time_seconds: times[i], wind: 0.8, remark: i<2 ? 'Q' : (i===2 ? 'q' : '') });
    });
    // Heat 2: 4 runners
    [4,5,6,7].forEach((i, lane) => {
        const he = createHeatEntry(h2, ents[i].eid, lane+3);
        const times = [10.30, 10.35, 10.42, 10.48];
        insertResult(h2, ents[i].eid, { time_seconds: times[i-4], wind: 1.2, remark: lane<2 ? 'Q' : (lane===2 ? 'q' : '') });
    });
    // Final
    const evFinal = createEvent('100m', 'track', 'M', 'final', 'completed', sortOrder++, null);
    allEvents['M_100m_final'] = evFinal;
    const hf = createHeat(evFinal, 1, 1.5, null);
    const finalists = ['김국영','이정태','오세하','박봉고','최명진','이재원'];
    const finalTimes = [10.04, 10.13, 10.20, 10.28, 10.33, 10.39];
    finalists.forEach((n, i) => {
        const eid = createEntry(evFinal, M[n], 'checked_in');
        createHeatEntry(hf, eid, i+3);
        insertResult(hf, eid, { time_seconds: finalTimes[i], wind: 1.5, remark: i===0 ? 'NR' : '' });
    });
}

// --- M 200m: prelim (COMPLETED) + final (IN_PROGRESS - results being entered) = Day1 ---
{
    const runners = ['김국영','여호수아','이동규','정세영','박봉고','최명진','이재원','김건우'];
    const evPrelim = createEvent('200m', 'track', 'M', 'preliminary', 'completed', sortOrder++, null);
    allEvents['M_200m_prelim'] = evPrelim;
    const h1 = createHeat(evPrelim, 1, 0.5, null);
    const h2 = createHeat(evPrelim, 2, -0.3, null);
    const ents = runners.map(n => ({ name: n, eid: createEntry(evPrelim, M[n], 'checked_in') }));
    [0,1,2,3].forEach((i, lane) => {
        createHeatEntry(h1, ents[i].eid, lane+3);
        insertResult(h1, ents[i].eid, { time_seconds: [20.52, 20.58, 20.75, 20.88][i], wind: 0.5, remark: i<2?'Q':'q' });
    });
    [4,5,6,7].forEach((i, lane) => {
        createHeatEntry(h2, ents[i].eid, lane+3);
        insertResult(h2, ents[i].eid, { time_seconds: [20.65, 20.72, 20.80, 20.95][i-4], wind: -0.3, remark: lane<2?'Q':'' });
    });
    // Final - in progress (only some results entered)
    const evFinal = createEvent('200m', 'track', 'M', 'final', 'in_progress', sortOrder++, null);
    allEvents['M_200m_final'] = evFinal;
    const hf = createHeat(evFinal, 1, null, null);
    const finalists = ['김국영','여호수아','이동규','정세영','박봉고','최명진'];
    finalists.forEach((n, i) => {
        const eid = createEntry(evFinal, M[n], 'checked_in');
        createHeatEntry(hf, eid, i+3);
        // Only first 3 have results (in progress)
        if (i < 3) {
            insertResult(hf, eid, { time_seconds: [20.38, 20.45, 20.68][i], wind: 1.8 });
        }
    });
}

// --- M 400m: prelim (COMPLETED) + final (COMPLETED) = Day2 ---
{
    const runners = ['백승호','김세준','정혁','이민규'];
    const evPrelim = createEvent('400m', 'track', 'M', 'preliminary', 'completed', sortOrder++, null);
    allEvents['M_400m_prelim'] = evPrelim;
    const h1 = createHeat(evPrelim, 1, null, null);
    const ents = runners.map(n => ({ name: n, eid: createEntry(evPrelim, M[n], 'checked_in') }));
    ents.forEach((e, i) => {
        createHeatEntry(h1, e.eid, i+3);
        insertResult(h1, e.eid, { time_seconds: [46.05, 46.28, 46.55, 46.78][i], remark: i<3?'Q':'' });
    });
    const evFinal = createEvent('400m', 'track', 'M', 'final', 'completed', sortOrder++, null);
    allEvents['M_400m_final'] = evFinal;
    const hf = createHeat(evFinal, 1, null, null);
    ['백승호','김세준','정혁'].forEach((n, i) => {
        const eid = createEntry(evFinal, M[n], 'checked_in');
        createHeatEntry(hf, eid, i+4);
        insertResult(hf, eid, { time_seconds: [45.72, 46.10, 46.42][i], remark: i===0 ? 'CR' : '' });
    });
}

// --- M 800m: final only (COMPLETED) = Day2 ---
{
    const runners = ['이재영','김현수','박민수','장선우','최동현'];
    const ev = createEvent('800m', 'track', 'M', 'final', 'completed', sortOrder++, null);
    allEvents['M_800m'] = ev;
    const h = createHeat(ev, 1, null, null);
    const times = [106.85, 107.30, 107.92, 108.45, 109.10];
    runners.forEach((n, i) => {
        const eid = createEntry(ev, M[n], 'checked_in');
        createHeatEntry(h, eid, i+3);
        insertResult(h, eid, { time_seconds: times[i] });
    });
}

// --- M 1500m: final only (COMPLETED) = Day2 ---
{
    const runners = ['최원호','강태훈','신동우','이재영','김현수'];
    const ev = createEvent('1500m', 'track', 'M', 'final', 'completed', sortOrder++, null);
    allEvents['M_1500m'] = ev;
    const h = createHeat(ev, 1, null, null);
    const times = [219.50, 220.80, 221.95, 222.50, 223.10];
    runners.forEach((n, i) => {
        const eid = createEntry(ev, M[n], 'checked_in');
        createHeatEntry(h, eid, i+1);
        insertResult(h, eid, { time_seconds: times[i] });
    });
}

// --- M 5000m: final (heats_generated - not started yet) = Day3 ---
{
    const runners = ['심종섭','안승빈','이성민','정찬영'];
    const ev = createEvent('5000m', 'track', 'M', 'final', 'heats_generated', sortOrder++, null);
    allEvents['M_5000m'] = ev;
    const h = createHeat(ev, 1, null, null);
    runners.forEach((n, i) => {
        const eid = createEntry(ev, M[n], 'checked_in');
        createHeatEntry(h, eid, i+1);
    });
}

// --- M 10,000m: final (COMPLETED) = Day1 ---
{
    const runners = ['윤성호','김태훈','심종섭','안승빈'];
    const ev = createEvent('10,000m', 'track', 'M', 'final', 'completed', sortOrder++, null);
    allEvents['M_10000m'] = ev;
    const h = createHeat(ev, 1, null, null);
    const times = [1755.20, 1770.50, 1785.00, 1800.30];
    runners.forEach((n, i) => {
        const eid = createEntry(ev, M[n], 'checked_in');
        createHeatEntry(h, eid, i+1);
        insertResult(h, eid, { time_seconds: times[i] });
    });
}

// --- M 3000mSC: final (COMPLETED) = Day2 ---
{
    const runners = ['김명우','박성호','안승빈','정찬영'];
    const ev = createEvent('3000mSC', 'track', 'M', 'final', 'completed', sortOrder++, null);
    allEvents['M_3000mSC'] = ev;
    const h = createHeat(ev, 1, null, null);
    const times = [521.50, 528.20, 535.00, 540.80];
    runners.forEach((n, i) => {
        const eid = createEntry(ev, M[n], 'checked_in');
        createHeatEntry(h, eid, i+1);
        insertResult(h, eid, { time_seconds: times[i] });
    });
}

// --- M 110mH: final (COMPLETED) = Day1 ---
{
    const runners = ['박태건','김대건','이준영'];
    const ev = createEvent('110mH', 'track', 'M', 'final', 'completed', sortOrder++, null);
    allEvents['M_110mH'] = ev;
    const h = createHeat(ev, 1, 0.6, null);
    const times = [13.55, 13.72, 13.88];
    runners.forEach((n, i) => {
        const eid = createEntry(ev, M[n], 'checked_in');
        createHeatEntry(h, eid, i+4);
        insertResult(h, eid, { time_seconds: times[i], wind: 0.6, remark: i===0 ? 'NR' : '' });
    });
}

// --- M 400mH: prelim (COMPLETED) + final (heats_generated) = Day3 ---
{
    const runners = ['이상혁','김승환','오민혁'];
    const evPrelim = createEvent('400mH', 'track', 'M', 'preliminary', 'completed', sortOrder++, null);
    allEvents['M_400mH_prelim'] = evPrelim;
    const h1 = createHeat(evPrelim, 1, null, null);
    runners.forEach((n, i) => {
        const eid = createEntry(evPrelim, M[n], 'checked_in');
        createHeatEntry(h1, eid, i+4);
        insertResult(h1, eid, { time_seconds: [49.80, 50.15, 50.55][i], remark: 'Q' });
    });
    const evFinal = createEvent('400mH', 'track', 'M', 'final', 'heats_generated', sortOrder++, null);
    allEvents['M_400mH_final'] = evFinal;
    const hf = createHeat(evFinal, 1, null, null);
    runners.forEach((n, i) => {
        const eid = createEntry(evFinal, M[n], 'checked_in');
        createHeatEntry(hf, eid, i+4);
    });
}

// -------------------------------------------------------
// TRACK EVENTS - FEMALE
// -------------------------------------------------------

// --- F 100m: prelim (COMPLETED) + final (COMPLETED) = Day1 ---
{
    const runners = ['양예빈','김민지','이소영','박서연','최수빈','한민지','정다은','서유나'];
    const evPrelim = createEvent('100m', 'track', 'F', 'preliminary', 'completed', sortOrder++, null);
    allEvents['F_100m_prelim'] = evPrelim;
    const h1 = createHeat(evPrelim, 1, 1.0, null);
    const h2 = createHeat(evPrelim, 2, 0.3, null);
    const ents = runners.map(n => ({ name: n, eid: createEntry(evPrelim, F[n], 'checked_in') }));
    [0,1,2,3].forEach((i, lane) => {
        createHeatEntry(h1, ents[i].eid, lane+3);
        insertResult(h1, ents[i].eid, { time_seconds: [11.50, 11.58, 11.68, 11.78][i], wind: 1.0, remark: i<2?'Q':'q' });
    });
    [4,5,6,7].forEach((i, lane) => {
        createHeatEntry(h2, ents[i].eid, lane+3);
        insertResult(h2, ents[i].eid, { time_seconds: [11.80, 11.85, 11.92, 12.05][i-4], wind: 0.3, remark: lane<2?'Q':'' });
    });
    const evFinal = createEvent('100m', 'track', 'F', 'final', 'completed', sortOrder++, null);
    allEvents['F_100m_final'] = evFinal;
    const hf = createHeat(evFinal, 1, 0.8, null);
    const finalists = ['양예빈','김민지','이소영','박서연','최수빈','한민지'];
    const finalTimes = [11.38, 11.48, 11.55, 11.65, 11.72, 11.80];
    finalists.forEach((n, i) => {
        const eid = createEntry(evFinal, F[n], 'checked_in');
        createHeatEntry(hf, eid, i+3);
        insertResult(hf, eid, { time_seconds: finalTimes[i], wind: 0.8, remark: i===0 ? 'CR' : '' });
    });
}

// --- F 200m: final (COMPLETED) = Day2 ---
{
    const runners = ['양예빈','김민서','이현진','김민지','이소영','박서연'];
    const ev = createEvent('200m', 'track', 'F', 'final', 'completed', sortOrder++, null);
    allEvents['F_200m'] = ev;
    const h = createHeat(ev, 1, 1.2, null);
    const times = [23.35, 23.55, 23.82, 23.90, 24.05, 24.18];
    runners.forEach((n, i) => {
        const eid = createEntry(ev, F[n], 'checked_in');
        createHeatEntry(h, eid, i+3);
        insertResult(h, eid, { time_seconds: times[i], wind: 1.2, remark: i===0 ? 'NR' : '' });
    });
}

// --- F 400m: prelim (COMPLETED) + final (COMPLETED) = Day2 ---
{
    const runners = ['박하늘','최윤서','정수현','이예진'];
    const evPrelim = createEvent('400m', 'track', 'F', 'preliminary', 'completed', sortOrder++, null);
    allEvents['F_400m_prelim'] = evPrelim;
    const h1 = createHeat(evPrelim, 1, null, null);
    runners.forEach((n, i) => {
        const eid = createEntry(evPrelim, F[n], 'checked_in');
        createHeatEntry(h1, eid, i+3);
        insertResult(h1, eid, { time_seconds: [52.95, 53.45, 53.80, 54.25][i], remark: 'Q' });
    });
    const evFinal = createEvent('400m', 'track', 'F', 'final', 'completed', sortOrder++, null);
    allEvents['F_400m_final'] = evFinal;
    const hf = createHeat(evFinal, 1, null, null);
    runners.forEach((n, i) => {
        const eid = createEntry(evFinal, F[n], 'checked_in');
        createHeatEntry(hf, eid, i+3);
        insertResult(hf, eid, { time_seconds: [52.60, 53.15, 53.55, 53.95][i] });
    });
}

// --- F 800m: final (COMPLETED) = Day2 ---
{
    const runners = ['김서연','이수민','박유진'];
    const ev = createEvent('800m', 'track', 'F', 'final', 'completed', sortOrder++, null);
    allEvents['F_800m'] = ev;
    const h = createHeat(ev, 1, null, null);
    const times = [122.80, 123.50, 124.90];
    runners.forEach((n, i) => {
        const eid = createEntry(ev, F[n], 'checked_in');
        createHeatEntry(h, eid, i+3);
        insertResult(h, eid, { time_seconds: times[i] });
    });
}

// --- F 1500m: final (COMPLETED) = Day3 ---
{
    const runners = ['장선영','이지수','김서연','이수민'];
    const ev = createEvent('1500m', 'track', 'F', 'final', 'completed', sortOrder++, null);
    allEvents['F_1500m'] = ev;
    const h = createHeat(ev, 1, null, null);
    const times = [253.80, 256.50, 258.20, 260.00];
    runners.forEach((n, i) => {
        const eid = createEntry(ev, F[n], 'checked_in');
        createHeatEntry(h, eid, i+1);
        insertResult(h, eid, { time_seconds: times[i] });
    });
}

// --- F 5000m: final (heats_generated - not started) = Day3 ---
{
    const runners = ['정유진','박은빈','김하늘'];
    const ev = createEvent('5000m', 'track', 'F', 'final', 'heats_generated', sortOrder++, null);
    allEvents['F_5000m'] = ev;
    const h = createHeat(ev, 1, null, null);
    runners.forEach((n, i) => {
        const eid = createEntry(ev, F[n], 'checked_in');
        createHeatEntry(h, eid, i+1);
    });
}

// --- F 3000mSC: final (COMPLETED) = Day2 ---
{
    const runners = ['이도연','최은정'];
    const ev = createEvent('3000mSC', 'track', 'F', 'final', 'completed', sortOrder++, null);
    allEvents['F_3000mSC'] = ev;
    const h = createHeat(ev, 1, null, null);
    [603.50, 618.00].forEach((t, i) => {
        const eid = createEntry(ev, F[runners[i]], 'checked_in');
        createHeatEntry(h, eid, i+1);
        insertResult(h, eid, { time_seconds: t });
    });
}

// --- F 100mH: final (COMPLETED) = Day1 ---
{
    const runners = ['정혜림','김다영','이서윤'];
    const ev = createEvent('100mH', 'track', 'F', 'final', 'completed', sortOrder++, null);
    allEvents['F_100mH'] = ev;
    const h = createHeat(ev, 1, 0.4, null);
    [13.10, 13.38, 13.55].forEach((t, i) => {
        const eid = createEntry(ev, F[runners[i]], 'checked_in');
        createHeatEntry(h, eid, i+4);
        insertResult(h, eid, { time_seconds: t, wind: 0.4, remark: i===0 ? 'NR' : '' });
    });
}

// --- F 400mH: final (heats_generated - upcoming Day3) ---
{
    const runners = ['이지원','박예린','김소연'];
    const ev = createEvent('400mH', 'track', 'F', 'final', 'heats_generated', sortOrder++, null);
    allEvents['F_400mH'] = ev;
    const h = createHeat(ev, 1, null, null);
    runners.forEach((n, i) => {
        const eid = createEntry(ev, F[n], 'registered');
        createHeatEntry(h, eid, i+4);
    });
}

// -------------------------------------------------------
// FIELD HEIGHT EVENTS
// -------------------------------------------------------

// --- M High Jump: final (COMPLETED) = Day1 ---
{
    const ev = createEvent('높이뛰기', 'field_height', 'M', 'final', 'completed', sortOrder++, null);
    allEvents['M_HJ'] = ev;
    const h = createHeat(ev, 1, null, null);
    const jumpers = ['우상혁','정진욱','강현우','박성민','이태준','김도윤'];
    const entries = jumpers.map(n => ({ name: n, eid: createEntry(ev, M[n], 'checked_in') }));
    entries.forEach((e, i) => createHeatEntry(h, e.eid, i+1));
    
    // Heights: 2.05, 2.10, 2.15, 2.18, 2.21, 2.24, 2.27, 2.30, 2.33, 2.36
    const heights = [2.05, 2.10, 2.15, 2.18, 2.21, 2.24, 2.27, 2.30, 2.33, 2.36];
    // 우상혁: O O O O O O O O XO O (cleared 2.36 = NR!)
    const results_us = ['O','O','O','O','O','O','O','O','XO','O'];
    // 정진욱: O O O O O XO XXO - done at 2.27
    const results_jj = ['O','O','O','O','O','XO','XXO',null,null,null];
    // 강현우: O O O XO XXO - done at 2.21
    const results_kh = ['O','O','O','XO','XXO',null,null,null,null,null];
    // 박성민: O O O XXO - done at 2.18
    const results_ps = ['O','O','O','XXO',null,null,null,null,null,null];
    // 이태준: O O XXX - failed at 2.15
    const results_it = ['O','O','XXX',null,null,null,null,null,null,null];
    // 김도윤: O XXX - failed at 2.10
    const results_kd = ['O','XXX',null,null,null,null,null,null,null,null];
    
    const allResults = [results_us, results_jj, results_kh, results_ps, results_it, results_kd];
    
    entries.forEach((e, pi) => {
        const res = allResults[pi];
        res.forEach((markStr, hi) => {
            if (!markStr) return;
            // Parse individual attempts from string (e.g., "XO" -> X, O; "XXX" -> X, X, X)
            for (let ci = 0; ci < markStr.length; ci++) {
                const ch = markStr[ci];
                const mark = ch === 'O' ? 'O' : ch === 'X' ? 'X' : 'PASS';
                insertHeightAttempt(h, e.eid, heights[hi], ci + 1, mark);
            }
        });
    });
}

// --- F High Jump: final (COMPLETED) = Day2 ---
{
    const ev = createEvent('높이뛰기', 'field_height', 'F', 'final', 'completed', sortOrder++, null);
    allEvents['F_HJ'] = ev;
    const h = createHeat(ev, 1, null, null);
    const jumpers = ['김현진','박선아','이나영','최서현','정민서','한유진'];
    const entries = jumpers.map(n => ({ name: n, eid: createEntry(ev, F[n], 'checked_in') }));
    entries.forEach((e, i) => createHeatEntry(h, e.eid, i+1));

    const heights = [1.60, 1.65, 1.70, 1.73, 1.76, 1.79, 1.82, 1.85, 1.88];
    // 김현진: O O O O O O O XO O (1.88 = CR)
    const r0 = ['O','O','O','O','O','O','O','XO','O'];
    // 박선아: O O O O O O XO XXO
    const r1 = ['O','O','O','O','O','O','XO','XXO',null];
    // 이나영: O O O O O XO XXX
    const r2 = ['O','O','O','O','O','XO','XXX',null,null];
    // 최서현: O O O O XO XXX
    const r3 = ['O','O','O','O','XO','XXX',null,null,null];
    // 정민서: O O O XXO XXX
    const r4 = ['O','O','O','XXO','XXX',null,null,null,null];
    // 한유진: O O XXX
    const r5 = ['O','O','XXX',null,null,null,null,null,null];
    
    [r0,r1,r2,r3,r4,r5].forEach((res, pi) => {
        res.forEach((markStr, hi) => {
            if (!markStr) return;
            for (let ci = 0; ci < markStr.length; ci++) {
                const ch = markStr[ci];
                insertHeightAttempt(h, entries[pi].eid, heights[hi], ci + 1, ch === 'O' ? 'O' : 'X');
            }
        });
    });
}

// --- M Pole Vault: final (IN_PROGRESS) = Day2 ---
{
    const ev = createEvent('장대높이뛰기', 'field_height', 'M', 'final', 'in_progress', sortOrder++, null);
    allEvents['M_PV'] = ev;
    const h = createHeat(ev, 1, null, null);
    const jumpers = ['진민섭','이준호','김동현','최진혁'];
    const entries = jumpers.map(n => ({ name: n, eid: createEntry(ev, M[n], 'checked_in') }));
    entries.forEach((e, i) => createHeatEntry(h, e.eid, i+1));

    const heights = [4.80, 4.95, 5.10, 5.20, 5.30, 5.45];
    // 진민섭: O O O O O (at 5.30, waiting for 5.45)
    const r0 = ['O','O','O','O','O',null];
    // 이준호: O O O XO (at 5.20, waiting)
    const r1 = ['O','O','O','XO',null,null];
    // 김동현: O O XO XXX (failed at 5.20)
    const r2 = ['O','O','XO','XXX',null,null];
    // 최진혁: O XO XXX (failed at 5.10)
    const r3 = ['O','XO','XXX',null,null,null];
    
    [r0,r1,r2,r3].forEach((res, pi) => {
        res.forEach((markStr, hi) => {
            if (!markStr) return;
            for (let ci = 0; ci < markStr.length; ci++) {
                insertHeightAttempt(h, entries[pi].eid, heights[hi], ci + 1, markStr[ci] === 'O' ? 'O' : 'X');
            }
        });
    });
}

// --- F Pole Vault: final (heats_generated - Day3) ---
{
    const ev = createEvent('장대높이뛰기', 'field_height', 'F', 'final', 'heats_generated', sortOrder++, null);
    allEvents['F_PV'] = ev;
    const h = createHeat(ev, 1, null, null);
    ['임은지','최지은','박수아','이가영'].forEach((n, i) => {
        const eid = createEntry(ev, F[n], 'registered');
        createHeatEntry(h, eid, i+1);
    });
}

// -------------------------------------------------------
// FIELD DISTANCE EVENTS
// -------------------------------------------------------

// --- M Long Jump: final (COMPLETED) = Day1 ---
{
    const ev = createEvent('멀리뛰기', 'field_distance', 'M', 'final', 'completed', sortOrder++, null);
    allEvents['M_LJ'] = ev;
    const h = createHeat(ev, 1, null, null);
    const athletes = ['김도현','이하늘','박현수','강민재','윤재호','서영진'];
    const entries = athletes.map(n => ({ name: n, eid: createEntry(ev, M[n], 'checked_in') }));
    entries.forEach((e, i) => createHeatEntry(h, e.eid, i+1));
    
    // 6 attempts per athlete
    const attempts = [
        [7.85, 0, 7.92, 7.80, 0, 7.88],  // 김도현 (0 = foul)
        [7.65, 7.72, 0, 7.75, 7.68, 7.70],  // 이하늘
        [7.55, 7.60, 7.48, 0, 7.58, 7.52],  // 박현수
        [7.40, 0, 7.45, 7.38, 7.42, 0],  // 강민재
        [7.28, 7.35, 0, 7.30, 7.33, 7.25],  // 윤재호
        [7.15, 7.20, 7.25, 0, 7.18, 7.22],  // 서영진
    ];
    const winds = [0.5, -0.2, 1.0, 0.8, -0.5, 1.2];
    
    entries.forEach((e, pi) => {
        attempts[pi].forEach((dist, ai) => {
            if (dist === 0) {
                insertResult(h, e.eid, { attempt_number: ai+1, distance_meters: null, status_code: 'X', wind: winds[ai] });
            } else {
                insertResult(h, e.eid, { attempt_number: ai+1, distance_meters: dist, wind: winds[ai], remark: (pi===0 && ai===2) ? 'NR' : '' });
            }
        });
    });
}

// --- F Long Jump: final (COMPLETED) = Day2 ---
{
    const ev = createEvent('멀리뛰기', 'field_distance', 'F', 'final', 'completed', sortOrder++, null);
    allEvents['F_LJ'] = ev;
    const h = createHeat(ev, 1, null, null);
    const athletes = ['김유리','이하은','박지수','최민경'];
    const entries = athletes.map(n => ({ name: n, eid: createEntry(ev, F[n], 'checked_in') }));
    entries.forEach((e, i) => createHeatEntry(h, e.eid, i+1));
    
    const attempts = [
        [6.25, 0, 6.35, 6.28, 6.30, 6.32],
        [6.10, 6.18, 6.20, 0, 6.15, 6.12],
        [5.98, 6.05, 0, 6.00, 5.95, 6.02],
        [5.85, 5.90, 5.88, 5.92, 0, 5.87],
    ];
    entries.forEach((e, pi) => {
        attempts[pi].forEach((dist, ai) => {
            if (dist === 0) {
                insertResult(h, e.eid, { attempt_number: ai+1, distance_meters: null, status_code: 'X', wind: vary(0.5, 1.0) });
            } else {
                insertResult(h, e.eid, { attempt_number: ai+1, distance_meters: dist, wind: vary(0.5, 1.0) });
            }
        });
    });
}

// --- M Triple Jump: final (COMPLETED) = Day2 ---
{
    const ev = createEvent('세단뛰기', 'field_distance', 'M', 'final', 'completed', sortOrder++, null);
    allEvents['M_TJ'] = ev;
    const h = createHeat(ev, 1, null, null);
    const athletes = ['김민성','박준형','이현우','정우성'];
    const entries = athletes.map(n => ({ name: n, eid: createEntry(ev, M[n], 'checked_in') }));
    entries.forEach((e, i) => createHeatEntry(h, e.eid, i+1));
    
    const attempts = [
        [16.10, 0, 16.28, 16.15, 16.20, 0],
        [15.80, 15.95, 0, 15.88, 15.90, 15.85],
        [15.65, 15.72, 15.80, 0, 15.75, 15.68],
        [15.45, 0, 15.55, 15.60, 0, 15.50],
    ];
    entries.forEach((e, pi) => {
        attempts[pi].forEach((dist, ai) => {
            if (dist === 0) {
                insertResult(h, e.eid, { attempt_number: ai+1, distance_meters: null, status_code: 'X', wind: vary(0.3, 0.8) });
            } else {
                insertResult(h, e.eid, { attempt_number: ai+1, distance_meters: dist, wind: vary(0.3, 0.8) });
            }
        });
    });
}

// --- F Triple Jump: final (heats_generated - Day3) ---
{
    const ev = createEvent('세단뛰기', 'field_distance', 'F', 'final', 'heats_generated', sortOrder++, null);
    allEvents['F_TJ'] = ev;
    const h = createHeat(ev, 1, null, null);
    ['박소희','김수진','이지현'].forEach((n, i) => {
        const eid = createEntry(ev, F[n], 'registered');
        createHeatEntry(h, eid, i+1);
    });
}

// --- M Shot Put: final (COMPLETED) = Day1 ---
{
    const ev = createEvent('포환던지기', 'field_distance', 'M', 'final', 'completed', sortOrder++, null);
    allEvents['M_SP'] = ev;
    const h = createHeat(ev, 1, null, null);
    const athletes = ['정일우','이병찬','강진호','박형준'];
    const entries = athletes.map(n => ({ name: n, eid: createEntry(ev, M[n], 'checked_in') }));
    entries.forEach((e, i) => createHeatEntry(h, e.eid, i+1));
    
    const attempts = [
        [17.80, 18.10, 0, 18.52, 18.30, 18.45],
        [17.20, 17.50, 17.80, 0, 17.65, 17.40],
        [16.80, 17.00, 17.20, 16.90, 0, 17.10],
        [16.50, 16.70, 0, 16.80, 16.60, 16.75],
    ];
    entries.forEach((e, pi) => {
        attempts[pi].forEach((dist, ai) => {
            if (dist === 0) {
                insertResult(h, e.eid, { attempt_number: ai+1, distance_meters: null, status_code: 'X' });
            } else {
                insertResult(h, e.eid, { attempt_number: ai+1, distance_meters: dist });
            }
        });
    });
}

// --- F Shot Put: final (COMPLETED) = Day1 ---
{
    const ev = createEvent('포환던지기', 'field_distance', 'F', 'final', 'completed', sortOrder++, null);
    allEvents['F_SP'] = ev;
    const h = createHeat(ev, 1, null, null);
    const athletes = ['이미영','김슬기','박현아'];
    const entries = athletes.map(n => ({ name: n, eid: createEntry(ev, F[n], 'checked_in') }));
    entries.forEach((e, i) => createHeatEntry(h, e.eid, i+1));
    
    const attempts = [
        [16.20, 16.50, 0, 16.80, 16.40, 16.60],
        [15.50, 15.80, 15.95, 0, 15.70, 15.85],
        [14.80, 15.00, 15.20, 14.90, 0, 15.10],
    ];
    entries.forEach((e, pi) => {
        attempts[pi].forEach((dist, ai) => {
            if (dist === 0) {
                insertResult(h, e.eid, { attempt_number: ai+1, distance_meters: null, status_code: 'X' });
            } else {
                insertResult(h, e.eid, { attempt_number: ai+1, distance_meters: dist });
            }
        });
    });
}

// --- M Discus: final (COMPLETED) = Day2 ---
{
    const ev = createEvent('원반던지기', 'field_distance', 'M', 'final', 'completed', sortOrder++, null);
    allEvents['M_DT'] = ev;
    const h = createHeat(ev, 1, null, null);
    const athletes = ['강창수','박지훈','이건호','김우진'];
    const entries = athletes.map(n => ({ name: n, eid: createEntry(ev, M[n], 'checked_in') }));
    entries.forEach((e, i) => createHeatEntry(h, e.eid, i+1));
    
    const attempts = [
        [55.50, 57.25, 0, 56.80, 55.90, 56.50],
        [54.20, 55.50, 55.90, 0, 55.10, 55.60],
        [53.00, 53.80, 54.50, 53.50, 0, 54.00],
        [52.00, 52.50, 53.00, 0, 52.80, 52.30],
    ];
    entries.forEach((e, pi) => {
        attempts[pi].forEach((dist, ai) => {
            if (dist === 0) {
                insertResult(h, e.eid, { attempt_number: ai+1, distance_meters: null, status_code: 'X' });
            } else {
                insertResult(h, e.eid, { attempt_number: ai+1, distance_meters: dist });
            }
        });
    });
}

// --- F Discus: final (COMPLETED) = Day2 ---
{
    const ev = createEvent('원반던지기', 'field_distance', 'F', 'final', 'completed', sortOrder++, null);
    allEvents['F_DT'] = ev;
    const h = createHeat(ev, 1, null, null);
    const athletes = ['정아름','최예진','김보라'];
    const entries = athletes.map(n => ({ name: n, eid: createEntry(ev, F[n], 'checked_in') }));
    entries.forEach((e, i) => createHeatEntry(h, e.eid, i+1));
    
    const attempts = [
        [53.50, 55.20, 0, 54.80, 54.00, 54.50],
        [52.00, 53.00, 53.80, 0, 53.20, 52.80],
        [50.50, 51.20, 52.00, 51.80, 0, 51.50],
    ];
    entries.forEach((e, pi) => {
        attempts[pi].forEach((dist, ai) => {
            if (dist === 0) {
                insertResult(h, e.eid, { attempt_number: ai+1, distance_meters: null, status_code: 'X' });
            } else {
                insertResult(h, e.eid, { attempt_number: ai+1, distance_meters: dist });
            }
        });
    });
}

// --- M Javelin: final (COMPLETED) = Day2 ---
{
    const ev = createEvent('창던지기', 'field_distance', 'M', 'final', 'completed', sortOrder++, null);
    allEvents['M_JT'] = ev;
    const h = createHeat(ev, 1, null, null);
    const athletes = ['허강민','최성재','남상원','김태형'];
    const entries = athletes.map(n => ({ name: n, eid: createEntry(ev, M[n], 'checked_in') }));
    entries.forEach((e, i) => createHeatEntry(h, e.eid, i+1));
    
    const attempts = [
        [72.00, 74.15, 0, 73.50, 72.80, 73.00],
        [70.50, 71.80, 72.30, 0, 71.50, 72.00],
        [66.50, 67.80, 68.50, 67.00, 0, 68.00],
        [65.00, 66.00, 66.80, 0, 66.50, 65.80],
    ];
    entries.forEach((e, pi) => {
        attempts[pi].forEach((dist, ai) => {
            if (dist === 0) {
                insertResult(h, e.eid, { attempt_number: ai+1, distance_meters: null, status_code: 'X' });
            } else {
                insertResult(h, e.eid, { attempt_number: ai+1, distance_meters: dist });
            }
        });
    });
}

// --- F Javelin: final (IN_PROGRESS) = Day3 ---
{
    const ev = createEvent('창던지기', 'field_distance', 'F', 'final', 'in_progress', sortOrder++, null);
    allEvents['F_JT'] = ev;
    const h = createHeat(ev, 1, null, null);
    const athletes = ['한소망','박지연','이은서'];
    const entries = athletes.map(n => ({ name: n, eid: createEntry(ev, F[n], 'checked_in') }));
    entries.forEach((e, i) => createHeatEntry(h, e.eid, i+1));
    
    // Only 3 attempts done so far (in progress)
    const attempts = [
        [56.50, 58.60, 57.80],
        [54.00, 56.50, 0],
        [52.50, 54.80, 53.50],
    ];
    entries.forEach((e, pi) => {
        attempts[pi].forEach((dist, ai) => {
            if (dist === 0) {
                insertResult(h, e.eid, { attempt_number: ai+1, distance_meters: null, status_code: 'X' });
            } else {
                insertResult(h, e.eid, { attempt_number: ai+1, distance_meters: dist });
            }
        });
    });
}

// --- M Hammer: final (COMPLETED) = Day1 ---
{
    const ev = createEvent('해머던지기', 'field_distance', 'M', 'final', 'completed', sortOrder++, null);
    allEvents['M_HT'] = ev;
    const h = createHeat(ev, 1, null, null);
    const athletes = ['이윤호','정재원','박현진','김호진'];
    const entries = athletes.map(n => ({ name: n, eid: createEntry(ev, M[n], 'checked_in') }));
    entries.forEach((e, i) => createHeatEntry(h, e.eid, i+1));
    
    const attempts = [
        [63.50, 65.80, 0, 64.50, 65.00, 64.80],
        [61.50, 63.00, 63.50, 0, 62.80, 63.20],
        [59.50, 60.50, 61.20, 60.80, 0, 61.00],
        [58.00, 59.00, 59.80, 0, 59.50, 59.20],
    ];
    entries.forEach((e, pi) => {
        attempts[pi].forEach((dist, ai) => {
            if (dist === 0) {
                insertResult(h, e.eid, { attempt_number: ai+1, distance_meters: null, status_code: 'X' });
            } else {
                insertResult(h, e.eid, { attempt_number: ai+1, distance_meters: dist });
            }
        });
    });
}

// --- F Hammer: final (COMPLETED) = Day2 ---
{
    const ev = createEvent('해머던지기', 'field_distance', 'F', 'final', 'completed', sortOrder++, null);
    allEvents['F_HT'] = ev;
    const h = createHeat(ev, 1, null, null);
    const athletes = ['이수진','최민지','박서현'];
    const entries = athletes.map(n => ({ name: n, eid: createEntry(ev, F[n], 'checked_in') }));
    entries.forEach((e, i) => createHeatEntry(h, e.eid, i+1));
    
    const attempts = [
        [58.00, 60.15, 0, 59.50, 58.80, 59.00],
        [56.50, 57.80, 58.20, 0, 57.50, 58.00],
        [54.50, 55.50, 56.00, 55.80, 0, 55.50],
    ];
    entries.forEach((e, pi) => {
        attempts[pi].forEach((dist, ai) => {
            if (dist === 0) {
                insertResult(h, e.eid, { attempt_number: ai+1, distance_meters: null, status_code: 'X' });
            } else {
                insertResult(h, e.eid, { attempt_number: ai+1, distance_meters: dist });
            }
        });
    });
}

// -------------------------------------------------------
// RELAY EVENTS
// -------------------------------------------------------
console.log('[5/10] Creating relay events...');

function createRelayEvent(name, gender, roundStatus, sortOrd) {
    const ev = createEvent(name, 'relay', gender, 'final', roundStatus, sortOrd, null);
    return ev;
}

// --- M 4X100mR: final (COMPLETED) = Day2 ---
{
    const ev = createRelayEvent('4X100mR', 'M', 'completed', sortOrder++);
    allEvents['M_4x100R'] = ev;
    const h = createHeat(ev, 1, 0.9, null);
    
    const teams = relayTeamsM;
    const teamTimes = [39.20, 39.55, 39.80, 40.10];
    
    teams.forEach((team, ti) => {
        // Use sprinters from each team + relay extras
        const runners = [];
        // Find 4 runners from the team
        const teamAthletes = Object.entries(M).filter(([key, id]) => {
            const ath = db.prepare('SELECT * FROM athlete WHERE id=?').get(id);
            return ath && ath.team === team;
        }).slice(0, 4);
        
        const teamAthId = teamAthletes.length > 0 ? teamAthletes[0][1] : M[`relay_${team}_m_1`];
        const eid = createEntry(ev, teamAthId, 'checked_in');
        createHeatEntry(h, eid, ti + 3);
        insertResult(h, eid, { time_seconds: teamTimes[ti], wind: 0.9 });
        
        // Relay members
        for (let leg = 1; leg <= 4; leg++) {
            const memberId = teamAthletes.length >= leg ? teamAthletes[leg-1][1] : M[`relay_${team}_m_${leg}`];
            if (memberId) {
                db.prepare('INSERT INTO relay_member (event_entry_id, athlete_id, leg_order, created_at) VALUES (?,?,?,?)')
                    .run(eid, memberId, leg, now());
            }
        }
    });
}

// --- F 4X100mR: final (COMPLETED) = Day2 ---
{
    const ev = createRelayEvent('4X100mR', 'F', 'completed', sortOrder++);
    allEvents['F_4x100R'] = ev;
    const h = createHeat(ev, 1, 0.5, null);
    
    const teamTimes = [44.50, 44.85, 45.10, 45.45];
    relayTeamsF.forEach((team, ti) => {
        const teamAthletes = Object.entries(F).filter(([key, id]) => {
            const ath = db.prepare('SELECT * FROM athlete WHERE id=?').get(id);
            return ath && ath.team === team;
        }).slice(0, 4);
        
        const teamAthId = teamAthletes.length > 0 ? teamAthletes[0][1] : F[`relay_${team}_f_1`];
        const eid = createEntry(ev, teamAthId, 'checked_in');
        createHeatEntry(h, eid, ti + 3);
        insertResult(h, eid, { time_seconds: teamTimes[ti], wind: 0.5 });
        
        for (let leg = 1; leg <= 4; leg++) {
            const memberId = teamAthletes.length >= leg ? teamAthletes[leg-1][1] : F[`relay_${team}_f_${leg}`];
            if (memberId) {
                db.prepare('INSERT INTO relay_member (event_entry_id, athlete_id, leg_order, created_at) VALUES (?,?,?,?)')
                    .run(eid, memberId, leg, now());
            }
        }
    });
}

// --- M 4X400mR: final (heats_generated - Day3) ---
{
    const ev = createRelayEvent('4X400mR', 'M', 'heats_generated', sortOrder++);
    allEvents['M_4x400R'] = ev;
    const h = createHeat(ev, 1, null, null);
    
    relayTeamsM.forEach((team, ti) => {
        const teamAthletes = Object.entries(M).filter(([key, id]) => {
            const ath = db.prepare('SELECT * FROM athlete WHERE id=?').get(id);
            return ath && ath.team === team;
        }).slice(0, 4);
        
        const teamAthId = teamAthletes.length > 0 ? teamAthletes[0][1] : M[`relay_${team}_m_1`];
        const eid = createEntry(ev, teamAthId, 'registered');
        createHeatEntry(h, eid, ti + 3);
        
        for (let leg = 1; leg <= 4; leg++) {
            const memberId = teamAthletes.length >= leg ? teamAthletes[leg-1][1] : M[`relay_${team}_m_${leg}`];
            if (memberId) {
                db.prepare('INSERT INTO relay_member (event_entry_id, athlete_id, leg_order, created_at) VALUES (?,?,?,?)')
                    .run(eid, memberId, leg, now());
            }
        }
    });
}

// --- F 4X400mR: final (heats_generated - Day3) ---
{
    const ev = createRelayEvent('4X400mR', 'F', 'heats_generated', sortOrder++);
    allEvents['F_4x400R'] = ev;
    const h = createHeat(ev, 1, null, null);
    
    relayTeamsF.forEach((team, ti) => {
        const teamAthletes = Object.entries(F).filter(([key, id]) => {
            const ath = db.prepare('SELECT * FROM athlete WHERE id=?').get(id);
            return ath && ath.team === team;
        }).slice(0, 4);
        
        const teamAthId = teamAthletes.length > 0 ? teamAthletes[0][1] : F[`relay_${team}_f_1`];
        const eid = createEntry(ev, teamAthId, 'registered');
        createHeatEntry(h, eid, ti + 3);
        
        for (let leg = 1; leg <= 4; leg++) {
            const memberId = teamAthletes.length >= leg ? teamAthletes[leg-1][1] : F[`relay_${team}_f_${leg}`];
            if (memberId) {
                db.prepare('INSERT INTO relay_member (event_entry_id, athlete_id, leg_order, created_at) VALUES (?,?,?,?)')
                    .run(eid, memberId, leg, now());
            }
        }
    });
}

// -------------------------------------------------------
// COMBINED EVENTS
// -------------------------------------------------------
console.log('[6/10] Creating combined events...');

// --- M 10종경기 (Decathlon): Day1-Day2, COMPLETED ---
{
    const evMain = createEvent('10종경기', 'combined', 'M', 'final', 'completed', sortOrder++, null);
    allEvents['M_decathlon'] = evMain;
    
    const decathletes = ['최진우','이경민','김형준','박성찬'];
    const mainEntries = decathletes.map(n => ({ name: n, eid: createEntry(evMain, M[n], 'checked_in') }));
    
    // Sub-events for decathlon
    const subEvents = [
        { name: '[10종] 100m', cat: 'track', order: 1 },
        { name: '[10종] 멀리뛰기', cat: 'field_distance', order: 2 },
        { name: '[10종] 포환던지기', cat: 'field_distance', order: 3 },
        { name: '[10종] 높이뛰기', cat: 'field_height', order: 4 },
        { name: '[10종] 400m', cat: 'track', order: 5 },
        { name: '[10종] 110mH', cat: 'track', order: 6 },
        { name: '[10종] 원반던지기', cat: 'field_distance', order: 7 },
        { name: '[10종] 장대높이뛰기', cat: 'field_height', order: 8 },
        { name: '[10종] 창던지기', cat: 'field_distance', order: 9 },
        { name: '[10종] 1500m', cat: 'track', order: 10 },
    ];
    
    // Raw records for each decathlete across 10 events [seconds or meters]
    const rawRecords = [
        // 최진우 (7800pts)
        [10.85, 7.35, 14.20, 2.00, 48.50, 14.50, 42.50, 4.80, 58.00, 268.50],
        // 이경민 (7500pts)
        [11.00, 7.15, 13.80, 1.95, 49.20, 14.80, 40.50, 4.60, 55.00, 272.00],
        // 김형준 (7200pts)
        [11.15, 6.95, 13.50, 1.90, 49.80, 15.10, 39.00, 4.40, 52.00, 278.00],
        // 박성찬 (6900pts)
        [11.30, 6.80, 13.00, 1.85, 50.50, 15.40, 37.50, 4.20, 49.00, 285.00],
    ];
    
    // WA points (approximate)
    const waPoints = [
        [880, 850, 720, 756, 820, 810, 680, 790, 710, 684],
        [840, 810, 690, 720, 780, 770, 640, 740, 660, 650],
        [800, 770, 660, 684, 740, 730, 610, 690, 620, 596],
        [760, 740, 620, 648, 700, 690, 580, 640, 580, 542],
    ];
    
    subEvents.forEach((se, si) => {
        const subEvId = createEvent(se.name, se.cat, 'M', 'final', 'completed', sortOrder++, evMain);
        const subHeat = createHeat(subEvId, 1, se.cat === 'track' && se.order <= 1 ? 0.5 : null, null);
        
        mainEntries.forEach((me, pi) => {
            const subEntry = createEntry(subEvId, M[decathletes[pi]], 'checked_in');
            createHeatEntry(subHeat, subEntry, pi + 1);
            
            const raw = rawRecords[pi][si];
            
            if (se.cat === 'track') {
                insertResult(subHeat, subEntry, { time_seconds: raw, wind: si === 0 ? 0.5 : null });
            } else if (se.cat === 'field_height') {
                // For height events in combined, create height attempts
                const baseH = se.order === 4 ? 1.70 : 4.00; // HJ or PV
                const step = se.order === 4 ? 0.05 : 0.20;
                let currentH = baseH;
                while (currentH < raw) {
                    insertHeightAttempt(subHeat, subEntry, currentH, 1, 'O');
                    currentH = +(currentH + step).toFixed(2);
                }
                // Clear final height
                insertHeightAttempt(subHeat, subEntry, +raw.toFixed(2), 1, 'O');
                // Fail next
                insertHeightAttempt(subHeat, subEntry, +(raw + step).toFixed(2), 1, 'X');
                insertHeightAttempt(subHeat, subEntry, +(raw + step).toFixed(2), 2, 'X');
                insertHeightAttempt(subHeat, subEntry, +(raw + step).toFixed(2), 3, 'X');
            } else {
                // Field distance
                insertResult(subHeat, subEntry, { attempt_number: 1, distance_meters: raw * 0.95 });
                insertResult(subHeat, subEntry, { attempt_number: 2, distance_meters: null, status_code: 'X' });
                insertResult(subHeat, subEntry, { attempt_number: 3, distance_meters: raw });
            }
            
            // Combined score
            insertCombinedScore(me.eid, se.name.replace('[10종] ', ''), se.order, raw, waPoints[pi][si]);
        });
    });
}

// --- F 7종경기 (Heptathlon): Day1-Day2, COMPLETED ---
{
    const evMain = createEvent('7종경기', 'combined', 'F', 'final', 'completed', sortOrder++, null);
    allEvents['F_heptathlon'] = evMain;
    
    const heptathletes = ['김다솜','이서현','박지현','정하은'];
    const mainEntries = heptathletes.map(n => ({ name: n, eid: createEntry(evMain, F[n], 'checked_in') }));
    
    const subEvents = [
        { name: '[7종] 100mH', cat: 'track', order: 1 },
        { name: '[7종] 높이뛰기', cat: 'field_height', order: 2 },
        { name: '[7종] 포환던지기', cat: 'field_distance', order: 3 },
        { name: '[7종] 200m', cat: 'track', order: 4 },
        { name: '[7종] 멀리뛰기', cat: 'field_distance', order: 5 },
        { name: '[7종] 창던지기', cat: 'field_distance', order: 6 },
        { name: '[7종] 800m', cat: 'track', order: 7 },
    ];
    
    const rawRecords = [
        // 김다솜 (5800pts)
        [13.80, 1.75, 12.50, 24.50, 5.95, 40.00, 132.00],
        // 이서현 (5500pts)
        [14.10, 1.70, 12.00, 25.00, 5.75, 38.00, 135.00],
        // 박지현 (5200pts)
        [14.40, 1.65, 11.50, 25.50, 5.55, 36.00, 138.00],
        // 정하은 (5000pts)
        [14.70, 1.60, 11.00, 26.00, 5.35, 34.00, 142.00],
    ];
    
    const waPoints = [
        [920, 810, 680, 830, 780, 650, 730],
        [870, 760, 650, 790, 740, 610, 680],
        [820, 710, 620, 750, 700, 570, 630],
        [770, 660, 590, 710, 660, 530, 580],
    ];
    
    subEvents.forEach((se, si) => {
        const subEvId = createEvent(se.name, se.cat, 'F', 'final', 'completed', sortOrder++, evMain);
        const subHeat = createHeat(subEvId, 1, se.cat === 'track' && se.order === 1 ? 0.3 : null, null);
        
        mainEntries.forEach((me, pi) => {
            const subEntry = createEntry(subEvId, F[heptathletes[pi]], 'checked_in');
            createHeatEntry(subHeat, subEntry, pi + 1);
            
            const raw = rawRecords[pi][si];
            
            if (se.cat === 'track') {
                insertResult(subHeat, subEntry, { time_seconds: raw, wind: si === 0 ? 0.3 : null });
            } else if (se.cat === 'field_height') {
                let currentH = 1.45;
                while (currentH < raw) {
                    insertHeightAttempt(subHeat, subEntry, currentH, 1, 'O');
                    currentH = +(currentH + 0.05).toFixed(2);
                }
                insertHeightAttempt(subHeat, subEntry, +raw.toFixed(2), 1, 'O');
                insertHeightAttempt(subHeat, subEntry, +(raw + 0.05).toFixed(2), 1, 'X');
                insertHeightAttempt(subHeat, subEntry, +(raw + 0.05).toFixed(2), 2, 'X');
                insertHeightAttempt(subHeat, subEntry, +(raw + 0.05).toFixed(2), 3, 'X');
            } else {
                insertResult(subHeat, subEntry, { attempt_number: 1, distance_meters: raw * 0.94 });
                insertResult(subHeat, subEntry, { attempt_number: 2, distance_meters: raw });
                insertResult(subHeat, subEntry, { attempt_number: 3, distance_meters: raw * 0.97 });
            }
            
            insertCombinedScore(me.eid, se.name.replace('[7종] ', ''), se.order, raw, waPoints[pi][si]);
        });
    });
}

// ============================================================
// 7. TIMETABLE (3-day schedule)
// ============================================================
console.log('[7/10] Creating timetable...');

const timetable = [
    // DAY 1 (4/18 Sat) - Opening + Track prelims + Field finals
    { day: 1, section: 'ceremony', time: '08:30', event_name: '개회식', category: '', round: '', note: '개회식', scheduled_date: '2026-04-18' },
    { day: 1, section: 'track', time: '09:00', event_name: '10,000m', category: '남', round: '결승', note: '', scheduled_date: '2026-04-18' },
    { day: 1, section: 'field', time: '09:30', event_name: '포환던지기', category: '남', round: '결승', note: '', callroom_time: '08:30', scheduled_date: '2026-04-18' },
    { day: 1, section: 'field', time: '09:30', event_name: '해머던지기', category: '남', round: '결승', note: '', callroom_time: '08:30', scheduled_date: '2026-04-18' },
    { day: 1, section: 'field', time: '10:00', event_name: '높이뛰기', category: '남', round: '결승', note: '', callroom_time: '09:00', scheduled_date: '2026-04-18' },
    { day: 1, section: 'field', time: '10:00', event_name: '멀리뛰기', category: '남', round: '결승', note: '', callroom_time: '09:00', scheduled_date: '2026-04-18' },
    { day: 1, section: 'field', time: '10:00', event_name: '포환던지기', category: '여', round: '결승', note: '', callroom_time: '09:00', scheduled_date: '2026-04-18' },
    { day: 1, section: 'track', time: '10:30', event_name: '100mH', category: '여', round: '결승', note: '', callroom_time: '09:30', scheduled_date: '2026-04-18' },
    { day: 1, section: 'track', time: '10:50', event_name: '110mH', category: '남', round: '결승', note: '', callroom_time: '09:50', scheduled_date: '2026-04-18' },
    { day: 1, section: 'combined', time: '11:00', event_name: '10종경기', category: '남', round: '1일차', note: '100m/멀리뛰기/포환/높이뛰기/400m', scheduled_date: '2026-04-18' },
    { day: 1, section: 'combined', time: '11:00', event_name: '7종경기', category: '여', round: '1일차', note: '100mH/높이뛰기/포환/200m', scheduled_date: '2026-04-18' },
    { day: 1, section: 'track', time: '14:00', event_name: '100m', category: '남', round: '예선', note: '2조', callroom_time: '13:00', scheduled_date: '2026-04-18' },
    { day: 1, section: 'track', time: '14:30', event_name: '100m', category: '여', round: '예선', note: '2조', callroom_time: '13:30', scheduled_date: '2026-04-18' },
    { day: 1, section: 'track', time: '15:00', event_name: '200m', category: '남', round: '예선', note: '2조', callroom_time: '14:00', scheduled_date: '2026-04-18' },
    { day: 1, section: 'track', time: '16:00', event_name: '100m', category: '남', round: '결승', note: '', callroom_time: '15:00', scheduled_date: '2026-04-18' },
    { day: 1, section: 'track', time: '16:20', event_name: '100m', category: '여', round: '결승', note: '', callroom_time: '15:20', scheduled_date: '2026-04-18' },
    
    // DAY 2 (4/19 Sun) - More finals + prelims
    { day: 2, section: 'combined', time: '09:00', event_name: '10종경기', category: '남', round: '2일차', note: '110mH/원반/장대/창/1500m', scheduled_date: '2026-04-19' },
    { day: 2, section: 'combined', time: '09:00', event_name: '7종경기', category: '여', round: '2일차', note: '멀리뛰기/창/800m', scheduled_date: '2026-04-19' },
    { day: 2, section: 'field', time: '09:30', event_name: '원반던지기', category: '남', round: '결승', note: '', callroom_time: '08:30', scheduled_date: '2026-04-19' },
    { day: 2, section: 'field', time: '09:30', event_name: '높이뛰기', category: '여', round: '결승', note: '', callroom_time: '08:30', scheduled_date: '2026-04-19' },
    { day: 2, section: 'field', time: '09:30', event_name: '장대높이뛰기', category: '남', round: '결승', note: '', callroom_time: '08:30', scheduled_date: '2026-04-19' },
    { day: 2, section: 'field', time: '10:00', event_name: '멀리뛰기', category: '여', round: '결승', note: '', callroom_time: '09:00', scheduled_date: '2026-04-19' },
    { day: 2, section: 'field', time: '10:00', event_name: '원반던지기', category: '여', round: '결승', note: '', callroom_time: '09:00', scheduled_date: '2026-04-19' },
    { day: 2, section: 'field', time: '10:00', event_name: '해머던지기', category: '여', round: '결승', note: '', callroom_time: '09:00', scheduled_date: '2026-04-19' },
    { day: 2, section: 'track', time: '10:30', event_name: '400m', category: '남', round: '예선', note: '', callroom_time: '09:30', scheduled_date: '2026-04-19' },
    { day: 2, section: 'track', time: '11:00', event_name: '400m', category: '여', round: '예선', note: '', callroom_time: '10:00', scheduled_date: '2026-04-19' },
    { day: 2, section: 'track', time: '11:30', event_name: '400mH', category: '남', round: '예선', note: '', callroom_time: '10:30', scheduled_date: '2026-04-19' },
    { day: 2, section: 'field', time: '13:00', event_name: '창던지기', category: '남', round: '결승', note: '', callroom_time: '12:00', scheduled_date: '2026-04-19' },
    { day: 2, section: 'field', time: '13:00', event_name: '세단뛰기', category: '남', round: '결승', note: '', callroom_time: '12:00', scheduled_date: '2026-04-19' },
    { day: 2, section: 'track', time: '14:00', event_name: '200m', category: '남', round: '결승', note: '진행 중', callroom_time: '13:00', scheduled_date: '2026-04-19' },
    { day: 2, section: 'track', time: '14:20', event_name: '200m', category: '여', round: '결승', note: '', callroom_time: '13:20', scheduled_date: '2026-04-19' },
    { day: 2, section: 'track', time: '14:40', event_name: '3000mSC', category: '남', round: '결승', note: '', callroom_time: '13:40', scheduled_date: '2026-04-19' },
    { day: 2, section: 'track', time: '15:00', event_name: '800m', category: '남', round: '결승', note: '', callroom_time: '14:00', scheduled_date: '2026-04-19' },
    { day: 2, section: 'track', time: '15:20', event_name: '800m', category: '여', round: '결승', note: '', callroom_time: '14:20', scheduled_date: '2026-04-19' },
    { day: 2, section: 'track', time: '15:40', event_name: '3000mSC', category: '여', round: '결승', note: '', callroom_time: '14:40', scheduled_date: '2026-04-19' },
    { day: 2, section: 'track', time: '16:00', event_name: '400m', category: '남', round: '결승', note: '', callroom_time: '15:00', scheduled_date: '2026-04-19' },
    { day: 2, section: 'track', time: '16:20', event_name: '400m', category: '여', round: '결승', note: '', callroom_time: '15:20', scheduled_date: '2026-04-19' },
    { day: 2, section: 'track', time: '16:40', event_name: '4X100mR', category: '남', round: '결승', note: '', callroom_time: '15:40', scheduled_date: '2026-04-19' },
    { day: 2, section: 'track', time: '16:55', event_name: '4X100mR', category: '여', round: '결승', note: '', callroom_time: '15:55', scheduled_date: '2026-04-19' },
    
    // DAY 3 (4/20 Mon) - Final day
    { day: 3, section: 'field', time: '09:00', event_name: '장대높이뛰기', category: '여', round: '결승', note: '', callroom_time: '08:00', scheduled_date: '2026-04-20' },
    { day: 3, section: 'field', time: '09:00', event_name: '세단뛰기', category: '여', round: '결승', note: '', callroom_time: '08:00', scheduled_date: '2026-04-20' },
    { day: 3, section: 'field', time: '09:30', event_name: '창던지기', category: '여', round: '결승', note: '진행 중', callroom_time: '08:30', scheduled_date: '2026-04-20' },
    { day: 3, section: 'track', time: '10:00', event_name: '1500m', category: '남', round: '결승', note: '', callroom_time: '09:00', scheduled_date: '2026-04-20' },
    { day: 3, section: 'track', time: '10:20', event_name: '1500m', category: '여', round: '결승', note: '', callroom_time: '09:20', scheduled_date: '2026-04-20' },
    { day: 3, section: 'track', time: '10:40', event_name: '400mH', category: '남', round: '결승', note: '', callroom_time: '09:40', scheduled_date: '2026-04-20' },
    { day: 3, section: 'track', time: '11:00', event_name: '400mH', category: '여', round: '결승', note: '', callroom_time: '10:00', scheduled_date: '2026-04-20' },
    { day: 3, section: 'track', time: '14:00', event_name: '5000m', category: '남', round: '결승', note: '', callroom_time: '13:00', scheduled_date: '2026-04-20' },
    { day: 3, section: 'track', time: '14:30', event_name: '5000m', category: '여', round: '결승', note: '', callroom_time: '13:30', scheduled_date: '2026-04-20' },
    { day: 3, section: 'track', time: '15:30', event_name: '4X400mR', category: '남', round: '결승', note: '', callroom_time: '14:30', scheduled_date: '2026-04-20' },
    { day: 3, section: 'track', time: '15:45', event_name: '4X400mR', category: '여', round: '결승', note: '', callroom_time: '14:45', scheduled_date: '2026-04-20' },
    { day: 3, section: 'ceremony', time: '16:30', event_name: '폐회식', category: '', round: '', note: '시상식 포함', scheduled_date: '2026-04-20' },
];

const ttInsert = db.prepare(`INSERT INTO timetable (competition_id, day, section, time, event_name, category, round, note, sort_order, callroom_time, scheduled_date) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
timetable.forEach((t, i) => {
    ttInsert.run(COMP_ID, t.day, t.section, t.time, t.event_name, t.category, t.round, t.note, i, t.callroom_time || null, t.scheduled_date || null);
});
console.log(`  Created ${timetable.length} timetable entries.`);

// ============================================================
// 8. PACING LIGHT CONFIG
// ============================================================
console.log('[8/10] Creating pacing config...');

// Pacing for M 800m
{
    const pc = db.prepare('INSERT INTO pacing_config (competition_id, event_name, notice, created_at, updated_at) VALUES (?,?,?,?,?)')
        .run(COMP_ID, '800m (남)', '1:46 페이스 / 200m-400m-600m-800m', now(), now());
    const pcId = Number(pc.lastInsertRowid);
    
    // Green = 1:46 target
    const color = db.prepare('INSERT INTO pacing_color (pacing_config_id, color_key, sort_order, remark, created_at) VALUES (?,?,?,?,?)')
        .run(pcId, 'green', 0, '1:46 타겟', now());
    const colorId = Number(color.lastInsertRowid);
    
    const segInsert = db.prepare('INSERT INTO pacing_segment (pacing_color_id, segment_order, distance_meters, lap_seconds, created_at) VALUES (?,?,?,?,?)');
    segInsert.run(colorId, 0, 200, 26.5, now());
    segInsert.run(colorId, 1, 400, 26.5, now());
    segInsert.run(colorId, 2, 600, 27.0, now());
    segInsert.run(colorId, 3, 800, 26.0, now());
    
    // Red = 1:50 target
    const color2 = db.prepare('INSERT INTO pacing_color (pacing_config_id, color_key, sort_order, remark, created_at) VALUES (?,?,?,?,?)')
        .run(pcId, 'red', 1, '1:50 타겟', now());
    const color2Id = Number(color2.lastInsertRowid);
    segInsert.run(color2Id, 0, 200, 27.5, now());
    segInsert.run(color2Id, 1, 400, 27.5, now());
    segInsert.run(color2Id, 2, 600, 27.5, now());
    segInsert.run(color2Id, 3, 800, 27.5, now());
}

// Pacing for M 1500m
{
    const pc = db.prepare('INSERT INTO pacing_config (competition_id, event_name, notice, created_at, updated_at) VALUES (?,?,?,?,?)')
        .run(COMP_ID, '1500m (남)', '3:38 페이스 / 400m 단위', now(), now());
    const pcId = Number(pc.lastInsertRowid);
    
    const color = db.prepare('INSERT INTO pacing_color (pacing_config_id, color_key, sort_order, remark, created_at) VALUES (?,?,?,?,?)')
        .run(pcId, 'green', 0, '3:38 타겟', now());
    const colorId = Number(color.lastInsertRowid);
    
    const segInsert = db.prepare('INSERT INTO pacing_segment (pacing_color_id, segment_order, distance_meters, lap_seconds, created_at) VALUES (?,?,?,?,?)');
    segInsert.run(colorId, 0, 400, 58.0, now());
    segInsert.run(colorId, 1, 800, 58.0, now());
    segInsert.run(colorId, 2, 1200, 58.0, now());
    segInsert.run(colorId, 3, 1500, 44.0, now());
}

// Pacing for M 5000m
{
    const pc = db.prepare('INSERT INTO pacing_config (competition_id, event_name, notice, created_at, updated_at) VALUES (?,?,?,?,?)')
        .run(COMP_ID, '5000m (남)', '13:30 페이스 / 1000m 단위', now(), now());
    const pcId = Number(pc.lastInsertRowid);
    
    const color = db.prepare('INSERT INTO pacing_color (pacing_config_id, color_key, sort_order, remark, created_at) VALUES (?,?,?,?,?)')
        .run(pcId, 'green', 0, '13:30 타겟', now());
    const colorId = Number(color.lastInsertRowid);
    
    const segInsert = db.prepare('INSERT INTO pacing_segment (pacing_color_id, segment_order, distance_meters, lap_seconds, created_at) VALUES (?,?,?,?,?)');
    segInsert.run(colorId, 0, 1000, 162.0, now());
    segInsert.run(colorId, 1, 2000, 162.0, now());
    segInsert.run(colorId, 2, 3000, 162.0, now());
    segInsert.run(colorId, 3, 4000, 162.0, now());
    segInsert.run(colorId, 4, 5000, 162.0, now());
}

console.log('  Created pacing configs for 800m, 1500m, 5000m.');

// ============================================================
// 9. EVENT RECORDS (NR/CR per event)
// ============================================================
console.log('[9/10] Creating event records...');

const eventRecordsList = [
    // M track
    { evName: '100m', gender: 'M', records: { nr: { record: '10.07', athlete: '김국영', team: '광주시청', year: '2017' }, cr: { record: '10.12', athlete: '김국영', team: '광주시청', year: '2024' } } },
    { evName: '200m', gender: 'M', records: { nr: { record: '20.43', athlete: '여호수아', team: '남양주시청', year: '2023' }, cr: { record: '20.55', athlete: '여호수아', team: '남양주시청', year: '2024' } } },
    { evName: '400m', gender: 'M', records: { nr: { record: '45.44', athlete: '백승호', team: '화성시청', year: '2023' }, cr: { record: '45.72', athlete: '백승호', team: '화성시청', year: '2026' } } },
    { evName: '800m', gender: 'M', records: { nr: { record: '1:46.12', athlete: '이재영', team: '경기도청', year: '2022' }, cr: { record: '1:47.50', athlete: '이재영', team: '경기도청', year: '2024' } } },
    { evName: '1500m', gender: 'M', records: { nr: { record: '3:38.50', athlete: '최원호', team: '화성시청', year: '2022' }, cr: { record: '3:40.20', athlete: '최원호', team: '화성시청', year: '2024' } } },
    { evName: '5000m', gender: 'M', records: { nr: { record: '13:32.50', athlete: '심종섭', team: '화성시청', year: '2023' }, cr: { record: '13:40.00', athlete: '심종섭', team: '화성시청', year: '2024' } } },
    { evName: '10,000m', gender: 'M', records: { nr: { record: '28:32.00', athlete: '윤성호', team: '대구시청', year: '2022' }, cr: { record: '29:05.00', athlete: '윤성호', team: '대구시청', year: '2024' } } },
    { evName: '110mH', gender: 'M', records: { nr: { record: '13.42', athlete: '박태건', team: '대구시청', year: '2023' }, cr: { record: '13.55', athlete: '박태건', team: '대구시청', year: '2026' } } },
    { evName: '400mH', gender: 'M', records: { nr: { record: '49.15', athlete: '이상혁', team: '화성시청', year: '2022' }, cr: { record: '49.52', athlete: '이상혁', team: '화성시청', year: '2024' } } },
    { evName: '3000mSC', gender: 'M', records: { nr: { record: '8:35.00', athlete: '김명우', team: '경기도청', year: '2023' }, cr: { record: '8:42.50', athlete: '김명우', team: '경기도청', year: '2024' } } },
    // M field
    { evName: '높이뛰기', gender: 'M', records: { nr: { record: '2.36', athlete: '우상혁', team: '용인시청', year: '2022' }, cr: { record: '2.33', athlete: '우상혁', team: '용인시청', year: '2024' } } },
    { evName: '장대높이뛰기', gender: 'M', records: { nr: { record: '5.63', athlete: '진민섭', team: '제주도청', year: '2021' }, cr: { record: '5.50', athlete: '진민섭', team: '제주도청', year: '2024' } } },
    { evName: '멀리뛰기', gender: 'M', records: { nr: { record: '7.92', athlete: '김도현', team: '경기도청', year: '2023' }, cr: { record: '7.85', athlete: '김도현', team: '경기도청', year: '2024' } } },
    { evName: '세단뛰기', gender: 'M', records: { nr: { record: '16.28', athlete: '김민성', team: '대구시청', year: '2023' }, cr: { record: '16.10', athlete: '김민성', team: '대구시청', year: '2024' } } },
    { evName: '포환던지기', gender: 'M', records: { nr: { record: '18.52', athlete: '정일우', team: '삼성전자', year: '2022' }, cr: { record: '18.10', athlete: '정일우', team: '삼성전자', year: '2024' } } },
    { evName: '원반던지기', gender: 'M', records: { nr: { record: '57.25', athlete: '강창수', team: '코오롱', year: '2023' }, cr: { record: '55.80', athlete: '강창수', team: '코오롱', year: '2024' } } },
    { evName: '창던지기', gender: 'M', records: { nr: { record: '74.15', athlete: '허강민', team: '제주도청', year: '2022' }, cr: { record: '72.50', athlete: '허강민', team: '제주도청', year: '2024' } } },
    { evName: '해머던지기', gender: 'M', records: { nr: { record: '65.80', athlete: '이윤호', team: '화성시청', year: '2023' }, cr: { record: '63.50', athlete: '이윤호', team: '화성시청', year: '2024' } } },
    // F track
    { evName: '100m', gender: 'F', records: { nr: { record: '11.38', athlete: '양예빈', team: '화성시청', year: '2024' }, cr: { record: '11.50', athlete: '양예빈', team: '화성시청', year: '2024' } } },
    { evName: '200m', gender: 'F', records: { nr: { record: '23.35', athlete: '양예빈', team: '화성시청', year: '2024' }, cr: { record: '23.60', athlete: '양예빈', team: '화성시청', year: '2024' } } },
    { evName: '400m', gender: 'F', records: { nr: { record: '52.50', athlete: '박하늘', team: '경기도청', year: '2023' }, cr: { record: '53.00', athlete: '박하늘', team: '경기도청', year: '2024' } } },
    { evName: '800m', gender: 'F', records: { nr: { record: '2:02.50', athlete: '김서연', team: '삼성전자', year: '2023' }, cr: { record: '2:04.00', athlete: '김서연', team: '삼성전자', year: '2024' } } },
    { evName: '100mH', gender: 'F', records: { nr: { record: '13.10', athlete: '정혜림', team: '대구시청', year: '2024' }, cr: { record: '13.25', athlete: '정혜림', team: '대구시청', year: '2024' } } },
    { evName: '높이뛰기', gender: 'F', records: { nr: { record: '1.88', athlete: '김현진', team: '화성시청', year: '2026' }, cr: { record: '1.85', athlete: '김현진', team: '화성시청', year: '2024' } } },
    // F field
    { evName: '멀리뛰기', gender: 'F', records: { nr: { record: '6.35', athlete: '김유리', team: '삼성전자', year: '2023' }, cr: { record: '6.25', athlete: '김유리', team: '삼성전자', year: '2024' } } },
    { evName: '포환던지기', gender: 'F', records: { nr: { record: '16.80', athlete: '이미영', team: '화성시청', year: '2022' }, cr: { record: '16.50', athlete: '이미영', team: '화성시청', year: '2024' } } },
    { evName: '원반던지기', gender: 'F', records: { nr: { record: '55.20', athlete: '정아름', team: '삼성전자', year: '2023' }, cr: { record: '54.00', athlete: '정아름', team: '삼성전자', year: '2024' } } },
    { evName: '창던지기', gender: 'F', records: { nr: { record: '58.60', athlete: '한소망', team: '광주시청', year: '2022' }, cr: { record: '57.00', athlete: '한소망', team: '광주시청', year: '2024' } } },
    { evName: '해머던지기', gender: 'F', records: { nr: { record: '60.15', athlete: '이수진', team: '경기도청', year: '2023' }, cr: { record: '58.50', athlete: '이수진', team: '경기도청', year: '2024' } } },
];

// Find matching events and insert records
const evRecInsert = db.prepare('INSERT OR REPLACE INTO event_records (event_id, records) VALUES (?,?)');
eventRecordsList.forEach(er => {
    // Find final event
    const matchEvents = db.prepare("SELECT id FROM event WHERE competition_id=? AND name=? AND gender=? AND (round_type='final' OR round_type='preliminary') AND parent_event_id IS NULL ORDER BY round_type='final' DESC").all(COMP_ID, er.evName, er.gender);
    if (matchEvents.length > 0) {
        evRecInsert.run(matchEvents[0].id, JSON.stringify(er.records));
    }
});
console.log(`  Created ${eventRecordsList.length} event record entries.`);

// ============================================================
// 10. OPERATION LOG (sample entries for realism)
// ============================================================
console.log('[10/10] Creating operation log...');

const opLogs = [
    { message: '대회 생성: 2026 전국육상경기선수권대회', category: 'admin', performed_by: '김로운' },
    { message: '선수 일괄 업로드 완료 (남 80명, 여 65명)', category: 'admin', performed_by: '김로운' },
    { message: '시간표 등록 완료 (3일 50항목)', category: 'admin', performed_by: '김로운' },
    { message: 'DAY1 경기 시작 — 10,000m (남) 결승', category: 'race', performed_by: '김세종' },
    { message: '100m (남) 예선 1조 소집 완료', category: 'callroom', performed_by: '김세종' },
    { message: '100m (남) 예선 2조 소집 완료', category: 'callroom', performed_by: '김세종' },
    { message: '100m (남) 결승 기록 확정', category: 'race', performed_by: '김세종' },
    { message: '높이뛰기 (남) 결승 — 우상혁 2.36m (한국신기록 타이!)', category: 'record', performed_by: '김세종' },
    { message: '110mH (남) 결승 — 박태건 13.55 (한국신기록)', category: 'record', performed_by: '김세종' },
    { message: 'DAY2 경기 시작', category: 'race', performed_by: '김세종' },
    { message: '4X100mR (남) 결승 기록 확정', category: 'race', performed_by: '김세종' },
    { message: '200m (남) 결승 진행 중 — 3명 기록 입력 완료', category: 'race', performed_by: '중계팀' },
    { message: 'DAY3 경기 시작', category: 'race', performed_by: '김세종' },
    { message: '페이싱 라이트 설정: 800m(남), 1500m(남), 5000m(남)', category: 'admin', performed_by: '김로운' },
    { message: '창던지기 (여) 진행 중 — 3차 시기까지 완료', category: 'race', performed_by: '중계팀' },
];

const opLogInsert = db.prepare('INSERT INTO operation_log (competition_id, message, category, performed_by, created_at) VALUES (?,?,?,?,?)');
const baseDate = new Date('2026-04-18T08:00:00+09:00');
opLogs.forEach((log, i) => {
    const d = new Date(baseDate.getTime() + i * 3600000); // hourly increments
    opLogInsert.run(COMP_ID, log.message, log.category, log.performed_by, d.toISOString().replace('T', ' ').substring(0, 19));
});
console.log(`  Created ${opLogs.length} operation log entries.`);

// ============================================================
// FINAL SUMMARY
// ============================================================
const stats = {
    athletes: db.prepare('SELECT COUNT(*) as c FROM athlete WHERE competition_id=?').get(COMP_ID).c,
    events: db.prepare('SELECT COUNT(*) as c FROM event WHERE competition_id=?').get(COMP_ID).c,
    heats: db.prepare('SELECT COUNT(*) as c FROM heat h JOIN event e ON h.event_id=e.id WHERE e.competition_id=?').get(COMP_ID).c,
    entries: db.prepare('SELECT COUNT(*) as c FROM event_entry ee JOIN event e ON ee.event_id=e.id WHERE e.competition_id=?').get(COMP_ID).c,
    results: db.prepare('SELECT COUNT(*) as c FROM result r JOIN heat h ON r.heat_id=h.id JOIN event e ON h.event_id=e.id WHERE e.competition_id=?').get(COMP_ID).c,
    heightAttempts: db.prepare('SELECT COUNT(*) as c FROM height_attempt ha JOIN heat h ON ha.heat_id=h.id JOIN event e ON h.event_id=e.id WHERE e.competition_id=?').get(COMP_ID).c,
    combinedScores: db.prepare('SELECT COUNT(*) as c FROM combined_score cs JOIN event_entry ee ON cs.event_entry_id=ee.id JOIN event e ON ee.event_id=e.id WHERE e.competition_id=?').get(COMP_ID).c,
    relayMembers: db.prepare('SELECT COUNT(*) as c FROM relay_member rm JOIN event_entry ee ON rm.event_entry_id=ee.id JOIN event e ON ee.event_id=e.id WHERE e.competition_id=?').get(COMP_ID).c,
    timetable: db.prepare('SELECT COUNT(*) as c FROM timetable WHERE competition_id=?').get(COMP_ID).c,
    pacingConfigs: db.prepare('SELECT COUNT(*) as c FROM pacing_config WHERE competition_id=?').get(COMP_ID).c,
};

console.log('\n========================================');
console.log('       DEMO SEED COMPLETE');
console.log('========================================');
console.log(`  Athletes:        ${stats.athletes}`);
console.log(`  Events:          ${stats.events}`);
console.log(`  Heats:           ${stats.heats}`);
console.log(`  Event Entries:   ${stats.entries}`);
console.log(`  Results:         ${stats.results}`);
console.log(`  Height Attempts: ${stats.heightAttempts}`);
console.log(`  Combined Scores: ${stats.combinedScores}`);
console.log(`  Relay Members:   ${stats.relayMembers}`);
console.log(`  Timetable:       ${stats.timetable}`);
console.log(`  Pacing Configs:  ${stats.pacingConfigs}`);
console.log('========================================');
console.log('Event status mix:');
console.log('  completed     — 100m/200m(예선)/400m/800m/1500m/10000m/3000mSC/110mH/HJ/LJ/TJ/SP/DT/JT/HT/4x100R/10종/7종');
console.log('  in_progress   — 200m(결승)/PV(남)/JT(여)');
console.log('  heats_generated — 400mH(결승)/5000m/F_400mH/F_PV/F_TJ/4x400R');
console.log('========================================\n');

db.close();
console.log('Done. Restart the server to load new data.');
