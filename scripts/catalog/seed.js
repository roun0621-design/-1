'use strict';
/**
 * 카탈로그 스크린샷용 가상 대회 시드 (영문만 — 화면에 한글이 한 글자도 안 보이게) — 2026-10-22 재촬영 요청
 *   node scripts/catalog/seed.js <sqlite 경로> <ids.json 출력>
 *   서버 모듈을 테스트 모드로 띄워(listen 안 함) 스키마를 만들고 직접 INSERT 한다. 운영 DB 와 무관.
 *   종목 이름은 사전 키(한글 정식명)로 넣는다 — 화면은 언어 사전으로 영문 표기한다(멀리뛰기 → Long Jump).
 */
const fs = require('fs');
const dbPath = process.argv[2], outPath = process.argv[3];
if (!dbPath || !outPath) { console.error('usage: seed.js <sqlite> <ids.json>'); process.exit(1); }
process.env.SQLITE_PATH = dbPath; process.env.DB_BACKEND = 'sqlite'; process.env.NODE_ENV = 'test'; process.env.VITEST = '1';
process.env.ADMIN_PW = 'testadmin1234'; process.env.OPERATION_KEY = 'testopkey'; process.env.INTL_SYNC = 'off';

const FIRST = { M: { kr: ['Minjun', 'Seojun', 'Jiho', 'Hyunwoo', 'Doyun', 'Siwoo', 'Taeyang', 'Junseo'], jp: ['Kenji', 'Haruto', 'Riku', 'Takumi', 'Sora', 'Yuto', 'Ren'], eu: ['Lucas', 'Noah', 'Elias', 'Finn', 'Jonas', 'Liam', 'Mateo', 'Luca'], sea: ['Somchai', 'Arief', 'Rizky', 'Wira', 'Bagas', 'Thanh', 'Minh'], us: ['Jordan', 'Tyler', 'Aiden', 'Marcus', 'Ethan', 'Isaiah', 'Caleb'] },
    F: { kr: ['Yejin', 'Soyeon', 'Jiwoo', 'Haeun', 'Yuna', 'Chaewon', 'Seoyeon', 'Dahye'], jp: ['Arisa', 'Yui', 'Sakura', 'Hina', 'Mei', 'Aoi', 'Rin'], eu: ['Lena', 'Mia', 'Emma', 'Clara', 'Nora', 'Sofia', 'Lea', 'Ines'], sea: ['Dewi', 'Kanya', 'Linh', 'Putri', 'Mai', 'Nadia', 'Thuy'], us: ['Maya', 'Zoe', 'Ava', 'Chloe', 'Harper', 'Riley', 'Nia'] } };
const LAST = { kr: ['Park', 'Kim', 'Lee', 'Choi', 'Jung', 'Han', 'Yoon', 'Kang'], jp: ['Sato', 'Tanaka', 'Suzuki', 'Kobayashi', 'Nakamura', 'Yamada'],
    eu: ['Meyer', 'Schulz', 'Berg', 'Rossi', 'Dubois', 'Novak', 'Fischer', 'Jansen'], sea: ['P.', 'Santoso', 'Tran', 'Pham', 'Wijaya', 'Chaiyaporn'], us: ['Carter', 'Brooks', 'Reed', 'Hayes', 'Bennett', 'Foster'] };
const TEAMS = ['Seoul AC', 'Busan Track Club', 'Tokyo Striders', 'Osaka Athletics', 'Bangkok Athletics', 'Hanoi Sprint Club', 'Jakarta Runners', 'Taipei Flyers', 'Manila Harriers', 'Berlin Sprint Team', 'Lyon Athlétisme', 'Portland Track'];
let seed = 7; const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
const pick = a => a[Math.floor(rnd() * a.length)];
const names = new Set();
function person(gender) {
    const n = pick(['kr', 'jp', 'eu', 'sea', 'us']);
    let nm; do { nm = `${pick(FIRST[gender === 'F' ? 'F' : 'M'][n])} ${pick(LAST[n])}`; } while (names.has(nm));
    names.add(nm); return nm;
}
const r2 = v => Math.round(v * 100) / 100;

(async () => {
    const mod = require('../../server.js'); const db = mod.db; await mod.ready;
    const ids = {};
    const today = new Date(); const now0 = today.getTime(); const ymd = d => { const x = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return x.toISOString().slice(0, 10); };
    const d0 = ymd(today), d1 = ymd(new Date(today.getTime() + 86400000));
    // ── 대회 ──
    const comp = (await db.run("INSERT INTO competition (name, name_en, name_ja, start_date, end_date, venue, status, federation, timezone, organization_id) VALUES (?,?,?,?,?,?,?,?,?,1)",
        '2026 Seoul International Athletics Meeting', '2026 Seoul International Athletics Meeting', '2026 ソウル国際陸上競技大会', d0, d1, 'Seoul Olympic Park Auxiliary Stadium', 'active', '', 'Asia/Seoul')).lastInsertRowid;
    const comp2 = (await db.run("INSERT INTO competition (name, name_en, name_ja, start_date, end_date, venue, status, federation, timezone, organization_id) VALUES (?,?,?,?,?,?,?,?,?,1)",
        '2026 Busan Coastal Invitational', '2026 Busan Coastal Invitational', '2026 釜山コースタル招待大会', d0, d0, 'Busan Asiad Auxiliary Stadium', 'active', '', 'Asia/Seoul')).lastInsertRowid;
    ids.comp = comp; ids.comp2 = comp2;
    let bib = 100;
    const athletes = { M: [], F: [] };
    async function mkAthlete(gender, cid = comp) {
        const name = person(gender); bib++;
        const id = (await db.run('INSERT INTO athlete (competition_id, name, bib_number, team, barcode, gender, federation) VALUES (?,?,?,?,?,?,?)', cid, name, String(bib), pick(TEAMS), 'A' + bib, gender, '')).lastInsertRowid;
        const a = { id, name, bib: String(bib), gender }; if (cid === comp) athletes[gender].push(a); return a;
    }
    for (let i = 0; i < 32; i++) await mkAthlete('M');
    for (let i = 0; i < 32; i++) await mkAthlete('F');
    let sort = 0;
    async function mkEvent({ name, category, gender, round_type, round_status, parent = null, cid = comp, code = null }) {
        sort += 10;
        const id = (await db.run("INSERT INTO event (competition_id, name, category, sort_order, gender, round_type, round_status, parent_event_id, division, code) VALUES (?,?,?,?,?,?,?,?,?,?)",
            cid, name, category, sort, gender, round_type, round_status, parent, '', code || require('../../lib/eventCatalog').codeOf(name))).lastInsertRowid;
        return id;
    }
    const entry = async (eid, aid, status = 'registered') => (await db.run("INSERT INTO event_entry (event_id, athlete_id, status, status_updated_at) VALUES (?,?,?,?)", eid, aid, status, status === 'checked_in' ? new Date().toISOString() : null)).lastInsertRowid;
    const heat = async (eid, no, wind = null) => (await db.run('INSERT INTO heat (event_id, heat_number, wind) VALUES (?,?,?)', eid, no, wind)).lastInsertRowid;
    const lane = (hid, eeid, ln) => db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?,?,?)', hid, eeid, ln);
    const res = (hid, eeid, t, d, status = '', remark = '', attempt = null, wind = null) => db.run('INSERT INTO result (heat_id, event_entry_id, attempt_number, time_seconds, distance_meters, status_code, remark, wind) VALUES (?,?,?,?,?,?,?,?)', hid, eeid, attempt, t, d, status, remark, wind);
    const tt = (day, section, time, event_name, category, round, eid, date, note = '') => db.run('INSERT INTO timetable (competition_id, day, section, time, event_name, category, round, note, sort_order, event_id, scheduled_date) VALUES (?,?,?,?,?,?,?,?,?,?,?)', comp, day, section, time, event_name, category, round, note, 0, eid, date);

    // ── 100m M: 예선 2조(완료) + 결승(완료) ──
    const m = athletes.M, f = athletes.F;
    const m100p = await mkEvent({ name: '100m', category: 'track', gender: 'M', round_type: 'preliminary', round_status: 'completed' });
    const m100f = await mkEvent({ name: '100m', category: 'track', gender: 'M', round_type: 'final', round_status: 'completed' });
    const m100Entries = [];
    for (let h = 1; h <= 2; h++) {
        const hid = await heat(m100p, h, h === 1 ? 0.8 : -0.3);
        for (let l = 1; l <= 8; l++) { const a = m[(h - 1) * 8 + l - 1]; const ee = await entry(m100p, a.id); await lane(hid, ee, l); const t = r2(10.35 + rnd() * 0.9); await res(hid, ee, t, null, '', '', null, h === 1 ? 0.8 : -0.3); m100Entries.push({ a, t }); }
    }
    m100Entries.sort((x, y) => x.t - y.t);
    { const hid = await heat(m100f, 1, 1.1); const lanes = [4, 5, 6, 3, 7, 2, 8, 1]; const top = m100Entries.slice(0, 8);
      for (let i = 0; i < 8; i++) { const ee = await entry(m100f, top[i].a.id, 'checked_in'); await lane(hid, ee, lanes[i]);
        if (i === 6) await res(hid, ee, null, null, 'DNF', '', null, 1.1); else await res(hid, ee, r2(top[i].t - 0.08 + i * 0.03), null, '', i === 0 ? 'CR' : i === 2 ? 'PB' : i === 4 ? 'SB' : '', null, 1.1); } }
    ids.m100f = m100f;
    // ── 100m W: 예선 2조(완료) + 결승(진행 중: 풍속 +0.7, 8명 중 6명 기록) ──
    const w100p = await mkEvent({ name: '100m', category: 'track', gender: 'F', round_type: 'preliminary', round_status: 'completed' });
    const w100f = await mkEvent({ name: '100m', category: 'track', gender: 'F', round_type: 'final', round_status: 'in_progress' });
    const w100Entries = [];
    for (let h = 1; h <= 2; h++) {
        const hid = await heat(w100p, h, h === 1 ? 0.2 : 1.4);
        for (let l = 1; l <= 8; l++) { const a = f[(h - 1) * 8 + l - 1]; const ee = await entry(w100p, a.id); await lane(hid, ee, l); const t = r2(11.45 + rnd() * 0.9); await res(hid, ee, t, null, '', '', null, h === 1 ? 0.2 : 1.4); w100Entries.push({ a, t }); }
    }
    w100Entries.sort((x, y) => x.t - y.t);
    { const hid = await heat(w100f, 1, 0.7); const lanes = [4, 5, 6, 3, 7, 2, 8, 1]; const top = w100Entries.slice(0, 8); ids.w100fHeat = hid;
      for (let i = 0; i < 8; i++) { const ee = await entry(w100f, top[i].a.id, 'checked_in'); await lane(hid, ee, lanes[i]); if (i < 6) await res(hid, ee, r2(top[i].t - 0.05 + i * 0.04), null, '', '', null, 0.7); } }
    ids.w100f = w100f;
    // ── 200m M: 준결승 2조(완료) + 진출 선택 승인(Q 3명씩 + q 2명) → 촬영 때 결승을 자동 생성한다 ──
    const m200s = await mkEvent({ name: '200m', category: 'track', gender: 'M', round_type: 'semifinal', round_status: 'completed' });
    const m200 = [];
    for (let h = 1; h <= 2; h++) {
        const hid = await heat(m200s, h, h === 1 ? -0.6 : 0.4);
        for (let l = 1; l <= 8; l++) { const a = m[16 + (h - 1) * 8 + l - 1]; const ee = await entry(m200s, a.id); await lane(hid, ee, l); const t = r2(20.85 + rnd() * 1.1); await res(hid, ee, t, null, '', '', null, h === 1 ? -0.6 : 0.4); m200.push({ ee, t, h }); }
    }
    for (const h of [1, 2]) { const rows = m200.filter(x => x.h === h).sort((a, b) => a.t - b.t); rows.forEach((x, i) => { x.q = i < 3 ? 'Q' : ''; }); }
    m200.filter(x => !x.q).sort((a, b) => a.t - b.t).slice(0, 2).forEach(x => { x.q = 'q'; });
    for (const x of m200) await db.run('INSERT INTO qualification_selection (event_id, event_entry_id, selected, approved, approved_by, qualification_type) VALUES (?,?,?,?,?,?)', m200s, x.ee, x.q ? 1 : 0, x.q ? 1 : 0, 'Chief Judge', x.q);
    ids.m200s = m200s;
    // ── 멀리뛰기 W (진행 중: 12명, 1~3차 전원, 4~6차 상위 8명 중 일부) ──
    const wlj = await mkEvent({ name: '멀리뛰기', category: 'field_distance', gender: 'F', round_type: 'final', round_status: 'in_progress' });
    { const hid = await heat(wlj, 1); for (let i = 0; i < 12; i++) { const a = f[16 + i]; const ee = await entry(wlj, a.id, 'checked_in'); await lane(hid, ee, i + 1);
        for (let at = 1; at <= 3; at++) { const foul = rnd() < 0.15; await res(hid, ee, null, foul ? 0 : r2(5.6 + rnd() * 1.1), '', '', at, r2(rnd() * 2 - 0.5)); }
        if (i < 5) await res(hid, ee, null, r2(5.7 + rnd() * 1.0), '', '', 4, r2(rnd() * 2 - 0.5)); } }
    ids.wlj = wlj;
    // ── 높이뛰기 M (완료: 10명, 높이별 시기) ──
    const mhj = await mkEvent({ name: '높이뛰기', category: 'field_height', gender: 'M', round_type: 'final', round_status: 'completed' });
    { const hid = await heat(mhj, 1); const hs = [1.90, 1.95, 2.00, 2.05, 2.10, 2.14, 2.18];
      for (let i = 0; i < 10; i++) { const a = m[i]; const ee = await entry(mhj, a.id, 'checked_in'); await lane(hid, ee, i + 1); const stop = 2 + Math.floor(rnd() * 5); let best = null;
        for (let k = 0; k < hs.length; k++) { if (k > stop) break; const h = hs[k]; if (k < stop) { const n = rnd() < 0.7 ? 1 : rnd() < 0.5 ? 2 : 3; for (let t = 1; t < n; t++) await db.run('INSERT INTO height_attempt (heat_id, event_entry_id, bar_height, attempt_number, result_mark) VALUES (?,?,?,?,?)', hid, ee, h, t, 'X'); await db.run('INSERT INTO height_attempt (heat_id, event_entry_id, bar_height, attempt_number, result_mark) VALUES (?,?,?,?,?)', hid, ee, h, n, 'O'); best = h; }
          else { for (let t = 1; t <= 3; t++) await db.run('INSERT INTO height_attempt (heat_id, event_entry_id, bar_height, attempt_number, result_mark) VALUES (?,?,?,?,?)', hid, ee, h, t, 'X'); } }
        if (best) await res(hid, ee, null, best, '', '', null); else await res(hid, ee, null, null, 'NM', '', null); } }
    ids.mhj = mhj;
    // ── 4X100mR M (완료: 6팀) ──
    const mrel = await mkEvent({ name: '4X100mR', category: 'relay', gender: 'M', round_type: 'final', round_status: 'completed' });
    { const hid = await heat(mrel, 1); const teams = TEAMS.slice(0, 6);
      for (let i = 0; i < 6; i++) { const tid = (await db.run('INSERT INTO athlete (competition_id, name, bib_number, team, barcode, gender, federation) VALUES (?,?,?,?,?,?,?)', comp, teams[i], String(201 + i), teams[i], 'T' + i, 'M', '')).lastInsertRowid;
        const ee = await entry(mrel, tid, 'checked_in'); await lane(hid, ee, i + 2); await res(hid, ee, r2(39.2 + rnd() * 1.6), null, '', i === 0 ? 'CR' : '', null);
        for (let leg = 1; leg <= 4; leg++) await db.run('INSERT INTO relay_member (event_entry_id, athlete_id, leg_order) VALUES (?,?,?)', ee, m[(i * 4 + leg - 1) % 32].id, leg); } }
    ids.mrel = mrel;
    // ── 10종경기 M (진행 중: 세부종목 10개, 5개 완료) ──
    const mdec = await mkEvent({ name: '10종경기', category: 'combined', gender: 'M', round_type: 'final', round_status: 'in_progress' });
    const SUBS = [['100m', 'track'], ['멀리뛰기', 'field_distance'], ['포환던지기', 'field_distance'], ['높이뛰기', 'field_height'], ['400m', 'track'], ['110mH', 'track'], ['원반던지기', 'field_distance'], ['장대높이뛰기', 'field_height'], ['창던지기', 'field_distance'], ['1500m', 'track']];
    const decAth = m.slice(24, 32); const decEntries = []; const decHeat = await heat(mdec, 1);
    for (const a of decAth) { const ee = await entry(mdec, a.id, 'checked_in'); decEntries.push({ a, ee }); await lane(decHeat, ee, decEntries.length); }
    const subIds = [];
    for (let i = 0; i < SUBS.length; i++) {
        const [nm, cat] = SUBS[i]; const done = i < 5;
        const sid = await mkEvent({ name: `[10종] ${nm}`, category: cat, gender: 'M', round_type: 'final', round_status: done ? 'completed' : 'created', parent: mdec, code: require('../../lib/eventCatalog').codeOf(nm) });
        subIds.push(sid); const hid = await heat(sid, 1, cat === 'track' && i === 0 ? 0.3 : null);
        for (const { a, ee: pe } of decEntries) { const ee = await entry(sid, a.id, 'checked_in'); await lane(hid, ee, decEntries.findIndex(x => x.a === a) + 1);
            if (done) { let raw, pts; if (nm === '100m') { raw = r2(10.9 + rnd() * 0.6); pts = Math.round(mod.calcWAPoints('M_100m', raw) || 800); await res(hid, ee, raw, null, '', '', null, 0.3); }
                else if (nm === '400m') { raw = r2(48.5 + rnd() * 2.5); pts = Math.round(mod.calcWAPoints('M_400m', raw) || 800); await res(hid, ee, raw, null); }
                else if (nm === '높이뛰기') { raw = r2(1.85 + Math.floor(rnd() * 5) * 0.03); pts = Math.round(mod.calcWAPoints('M_high_jump', raw) || 700); await res(hid, ee, null, raw); }
                else { raw = r2(nm === '멀리뛰기' ? 6.6 + rnd() * 0.9 : 12.5 + rnd() * 3); pts = Math.round(mod.calcWAPoints(nm === '멀리뛰기' ? 'M_long_jump' : 'M_shot_put', raw) || 700); for (let at = 1; at <= 3; at++) await res(hid, ee, null, at === 2 ? raw : r2(raw - rnd() * 0.5), '', '', at); }
                await db.run('INSERT INTO combined_score (event_entry_id, sub_event_name, sub_event_order, raw_record, wa_points) VALUES (?,?,?,?,?)', pe, nm, i + 1, raw, pts); } }
    }
    ids.mdec = mdec; ids.decSubs = subIds;
    // ── 시간표(오늘 09:00~17:30 고정 — 촬영은 capture.js 가 브라우저 시계를 12:14 로 맞춘다) ──
    const rows = [['09:30', '100m', 'Men', '예선', m100p, 'track'], ['10:00', '높이뛰기', 'Men', '결승', mhj, 'field'], ['10:10', '100m', 'Women', '예선', w100p, 'track'], ['10:40', '200m', 'Men', '준결승', m200s, 'track'],
        ['11:00', '멀리뛰기', 'Women', '결승', wlj, 'field'], ['11:20', '4X100mR', 'Men', '결승', mrel, 'track'], ['11:40', '100m', 'Men', '결승', m100f, 'track'], ['12:10', '100m', 'Women', '결승', w100f, 'track'], ['12:40', '200m', 'Men', '결승', null, 'track']];
    for (const [time, name, cat, round, eid, sec] of rows) await tt(1, sec, time, name, cat, round, eid, d0);
    const DEC_T = ['09:00', '09:45', '10:30', '11:15', '12:30', '13:30', '14:15', '15:00', '16:00', '17:15'];
    for (let i = 0; i < SUBS.length; i++) await tt(1, SUBS[i][1] === 'track' ? 'track' : 'field', DEC_T[i], SUBS[i][0], 'Men', `10종(${i + 1})`, mdec, d0);   // 세부종목 줄은 부모 종목에 건다(전국체전 동기화와 같은 모양)
    // ── 둘째 대회(홈 '두 대회 동시 운영' 카드용): 종목 몇 개 ──
    { const e1 = await mkEvent({ name: '800m', category: 'track', gender: 'F', round_type: 'final', round_status: 'in_progress', cid: comp2 }); const e2 = await mkEvent({ name: '포환던지기', category: 'field_distance', gender: 'M', round_type: 'final', round_status: 'completed', cid: comp2 }); const e3 = await mkEvent({ name: '5000m', category: 'track', gender: 'M', round_type: 'final', round_status: 'created', cid: comp2 });
      const hid = await heat(e1, 1); for (let i = 0; i < 8; i++) { const a = await mkAthlete('F', comp2); const ee = await entry(e1, a.id, 'checked_in'); await lane(hid, ee, i + 1); if (i < 4) await res(hid, ee, r2(124 + rnd() * 6), null); }
      const hid2 = await heat(e2, 1); for (let i = 0; i < 6; i++) { const a = await mkAthlete('M', comp2); const ee = await entry(e2, a.id, 'checked_in'); await lane(hid2, ee, i + 1); for (let at = 1; at <= 3; at++) await res(hid2, ee, null, r2(15 + rnd() * 3), '', '', at); }
      void e3; }
    // ── 운영 로그(영문) ──
    const now = new Date(d0 + 'T12:12:00').getTime();   // 촬영 시계(12:14) 기준
    const log = async (min, msg, cat, by) => db.run('INSERT INTO operation_log (competition_id, message, category, performed_by, created_at) VALUES (?,?,?,?,?)', comp, msg, cat, by, new Date(now - min * 60000).toISOString().replace('T', ' ').slice(0, 19));
    const L = [[2, 'Result saved: W 100m Final · lane 6 · 11.58 (+0.7)', 'record', 'Judge · Kenji Sato'], [3, 'Result saved: W 100m Final · lane 5 · 11.52 (+0.7)', 'record', 'Judge · Kenji Sato'], [4, 'Wind set: W 100m Final · +0.7', 'record', 'Judge · Kenji Sato'],
        [6, 'Call room: W 100m Final · 8/8 checked in', 'callroom', 'Call room · Arisa Tanaka'], [9, 'Round completed: M 100m Final (official)', 'completion', 'Chief Judge'], [11, 'Result corrected: M 100m Final · lane 3 · 10.41 → 10.38', 'record', 'Chief Judge'],
        [14, 'Final created: M 200m · 8 athletes (Q6 + q2) · WA serpentine seeding', 'round', 'Chief Judge'], [16, 'Qualification approved: M 200m Semifinal', 'round', 'Chief Judge'], [21, 'Long Jump W · attempt 4 started (top 8)', 'record', 'Judge · Lucas Meyer'],
        [25, 'High Jump M · bar raised to 2.18', 'record', 'Judge · Somchai P.'], [33, 'Call room: M 200m Semifinal · 16/16 checked in', 'callroom', 'Call room · Arisa Tanaka'], [40, 'Undo: result deleted M 100m Heat 2 · lane 4 (duplicate entry)', 'revert', 'admin'],
        [52, 'Timetable updated: W 100m Final 12:00 → 12:10', 'admin', 'admin'], [70, 'Operation key issued: Judges (expires today 20:00)', 'admin', 'admin'], [95, 'Athlete list imported: 64 athletes · 12 teams', 'admin', 'admin']];
    for (const [min, msg, cat, by] of L) await log(min, msg, cat, by);
    await db.run("UPDATE event_entry SET status='checked_in', status_updated_at=? WHERE event_id IN (SELECT id FROM event WHERE round_status='completed')", d0 + 'T09:00:00');   // 끝난 종목은 전원 소집 완료
    // 스코어보드 키(전광판 매칭 경고가 안 뜨게) + 운영키 한 개(심판 키 경고가 안 뜨게)
    for (const h of await db.all('SELECT h.id, h.heat_number, e.name, e.gender, e.round_type, (SELECT COUNT(*) FROM heat x WHERE x.event_id=e.id) n FROM heat h JOIN event e ON e.id=h.event_id'))
        await db.run('UPDATE heat SET scoreboard_key=? WHERE id=?', `${h.gender}-${h.name.replace(/\s/g, '')}-${h.round_type}${Number(h.n) > 1 ? '-' + h.heat_number : ''}`, h.id);
    try { await db.run("INSERT INTO operation_key (organization_id, judge_name, key_value, role, active, can_manage, key_prefix, key_hint) VALUES (1, 'Judges (Day 1)', 'demo-judges-2026', 'operation', 1, 0, 'demo', '…2026')"); } catch (e) {}
    fs.writeFileSync(outPath, JSON.stringify(ids, null, 2));
    console.log('seeded', JSON.stringify(ids));
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
