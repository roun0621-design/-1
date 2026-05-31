#!/usr/bin/env node
/**
 * 해남 실업부 재현 테스트 대회 생성 스크립트
 *
 * 목적: 사용자 제공 명단(원본 실업해남선수명단.xlsx)을 기반으로
 *       comp_id=43에 명단/종목/heat/entry/result를 전부 생성하여
 *       부별 종합기록지 누락 종목을 재현·진단한다.
 *
 * 카테고리 매핑은 lib/comprehensiveByDivision.js의 동작 기준과 동일하게
 * (track/field_distance/field_height/combined/relay) 분류한다.
 */
const path = require('path');
const Database = require('better-sqlite3');
const ExcelJS = require('exceljs');

const DB_PATH = path.join(__dirname, '..', 'db', 'competition.db');
const ENTRY_XLSX = path.join(__dirname, '..', 'tmp_uploads', 'entry_original.xlsx');

const db = new Database(DB_PATH);

// ─── 종목 → 카테고리 + division (실업부 = M_GEN/F_GEN) ──────────────────
const TRACK_EVENTS = new Set([
    '100m', '200m', '400m', '800m', '1500m', '5000m', '10000m', '3000m', '3000mSC',
    '100mH', '110mH', '400mH', '10000mW', '20000mW', '5000mW',
]);
const FIELD_DISTANCE = new Set([
    '멀리뛰기', '세단뛰기', '포환던지기', '원반던지기', '해머던지기', '창던지기',
]);
const FIELD_HEIGHT = new Set([
    '높이뛰기', '장대높이뛰기',
]);
const COMBINED = new Set([
    '10종경기', '7종경기', '5종경기',
]);
const RELAYS = ['4x100mR', '4x400mR', '4x400mR(Mixed)', '4x800mR', '4x1500mR'];

function categorize(name) {
    if (TRACK_EVENTS.has(name)) return 'track';
    if (FIELD_DISTANCE.has(name)) return 'field_distance';
    if (FIELD_HEIGHT.has(name)) return 'field_height';
    if (COMBINED.has(name)) return 'combined';
    if (RELAYS.includes(name)) return 'relay';
    return 'track';
}

function divisionFor(divisionLabel, gender) {
    // "남자일반부" → M_GEN, "여자일반부" → F_GEN
    if (divisionLabel.includes('남자일반') || (gender === '남자' && divisionLabel.includes('일반'))) return 'M_GEN';
    if (divisionLabel.includes('여자일반') || (gender === '여자' && divisionLabel.includes('일반'))) return 'F_GEN';
    // fallback
    return gender === '남자' ? 'M_GEN' : 'F_GEN';
}

// ─── 1) 대회 생성 ─────────────────────────────────────────────────────
async function createCompetition() {
    // 기존 'TEST_HAENAM_REPRO' 정리 (멱등 실행 지원)
    const existing = db.prepare("SELECT id FROM competition WHERE name='TEST_HAENAM_REPRO'").get();
    if (existing) {
        console.log('기존 테스트 대회 발견, 삭제 후 재생성:', existing.id);
        const eids = db.prepare('SELECT id FROM event WHERE competition_id=?').all(existing.id).map(e => e.id);
        for (const eid of eids) {
            const heatIds = db.prepare('SELECT id FROM heat WHERE event_id=?').all(eid).map(h => h.id);
            const eeIds = db.prepare('SELECT id FROM event_entry WHERE event_id=?').all(eid).map(e => e.id);
            // event_entry 의존 데이터 정리
            for (const eeId of eeIds) {
                try { db.prepare('DELETE FROM combined_score WHERE event_entry_id=?').run(eeId); } catch(e) {}
                try { db.prepare('DELETE FROM height_attempt WHERE event_entry_id=?').run(eeId); } catch(e) {}
                try { db.prepare('DELETE FROM relay_member WHERE event_entry_id=?').run(eeId); } catch(e) {}
            }
            for (const hid of heatIds) {
                db.prepare('DELETE FROM result WHERE heat_id=?').run(hid);
                db.prepare('DELETE FROM heat_entry WHERE heat_id=?').run(hid);
            }
            db.prepare('DELETE FROM heat WHERE event_id=?').run(eid);
            db.prepare('DELETE FROM event_entry WHERE event_id=?').run(eid);
        }
        db.prepare('DELETE FROM event WHERE competition_id=?').run(existing.id);
        db.prepare('DELETE FROM athlete WHERE competition_id=?').run(existing.id);
        db.prepare('DELETE FROM competition WHERE id=?').run(existing.id);
    }
    const r = db.prepare(`INSERT INTO competition (name, start_date, end_date, venue, status, federation, division_type, mode)
        VALUES ('TEST_HAENAM_REPRO', '2026-05-25', '2026-05-27', '해남스포츠파크',
                'active', 'KTFL', 'general', 'operation')`).run();
    console.log('✓ 대회 생성: comp_id =', r.lastInsertRowid);
    return r.lastInsertRowid;
}

// ─── 2) 명단 로드 ─────────────────────────────────────────────────────
async function loadEntries() {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(ENTRY_XLSX);
    const ws = wb.worksheets[0];
    const headers = [];
    for (let c = 1; c <= ws.columnCount; c++) headers.push(ws.getRow(1).getCell(c).value);
    const rows = [];
    for (let r = 2; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        const obj = {};
        for (let c = 1; c <= ws.columnCount; c++) {
            let v = row.getCell(c).value;
            if (v && typeof v === 'object' && v.text) v = v.text;
            obj[headers[c - 1]] = v === null || v === undefined ? '' : String(v).trim();
        }
        if (obj['성명']) rows.push(obj);
    }
    return rows;
}

// ─── 3) 선수 등록 ─────────────────────────────────────────────────────
function insertAthletes(compId, entries) {
    const ins = db.prepare(`INSERT INTO athlete (competition_id, name, bib_number, team, gender, federation, date_of_birth)
                            VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const tx = db.transaction((rows) => {
        const map = new Map(); // (name+bib) -> athlete_id
        for (const e of rows) {
            const g = e['성별'] === '남자' ? 'M' : 'F';
            const info = ins.run(compId, e['성명'], String(e['배번'] || ''), e['소속명'] || '', g, 'KTFL', e['생년월일'] || '');
            map.set(e['성명'] + '|' + e['배번'], info.lastInsertRowid);
        }
        return map;
    });
    const map = tx(entries);
    console.log(`✓ 선수 ${entries.length}명 등록`);
    return map;
}

// ─── 4) 종목 → heat → entry → result 생성 ──────────────────────────────
function createEventsAndResults(compId, entries, athleteMap) {
    // (eventName, gender, division) → [athleteIds]
    const byEvent = new Map();
    const addToEvent = (eventName, gender, division, athleteId) => {
        const key = `${eventName}|${gender}|${division}`;
        if (!byEvent.has(key)) byEvent.set(key, []);
        byEvent.get(key).push(athleteId);
    };

    // 개인종목
    for (const e of entries) {
        const g = e['성별'] === '남자' ? 'M' : 'F';
        const div = divisionFor(e['대회종별'], e['성별']);
        const aid = athleteMap.get(e['성명'] + '|' + e['배번']);
        for (const k of ['종목1', '종목2']) {
            const ev = e[k];
            if (ev && ev.trim()) addToEvent(ev.trim(), g, div, aid);
        }
    }
    // 릴레이 (개별 선수 entry로 단순화 — relay 종목에 entry 등록)
    for (const e of entries) {
        const g = e['성별'] === '남자' ? 'M' : 'F';
        const div = divisionFor(e['대회종별'], e['성별']);
        const aid = athleteMap.get(e['성명'] + '|' + e['배번']);
        for (const rk of RELAYS) {
            if (e[rk] && e[rk].includes('참여')) {
                const gAdj = rk.includes('Mixed') ? 'X' : g;
                const divAdj = rk.includes('Mixed') ? 'MIXED' : div;
                addToEvent(rk, gAdj, divAdj, aid);
            }
        }
    }

    console.log(`✓ 종목 그룹화: ${byEvent.size}개 (event,gender,division) 조합`);

    const insEvent = db.prepare(`INSERT INTO event (competition_id, name, category, sort_order, gender, round_type, round_status, division)
                                 VALUES (?, ?, ?, ?, ?, 'final', 'completed', ?)`);
    const insHeat = db.prepare(`INSERT INTO heat (event_id, heat_number, wind) VALUES (?, ?, ?)`);
    const insEvEntry = db.prepare(`INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?, ?, 'checked_in')`);
    const insHeatEntry = db.prepare(`INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?, ?, ?)`);
    const insResult = db.prepare(`INSERT INTO result (heat_id, event_entry_id, attempt_number, time_seconds, distance_meters, status_code, wind)
                                  VALUES (?, ?, ?, ?, ?, ?, ?)`);
    // 풍속 측정 종목 set
    const WIND_TRACK = new Set(['100m', '200m', '100mH', '110mH']);  // heat 풍속 (단일 값)
    const WIND_FIELD = new Set(['멀리뛰기', '세단뛰기']);              // result 풍속 (시도별)
    function randWind() {
      // -2.0 ~ +2.5 사이 균등, 소수 첫째자리
      return Math.round((Math.random() * 4.5 - 2.0) * 10) / 10;
    }
    const insCombined = db.prepare(`INSERT INTO combined_score (event_entry_id, sub_event_name, sub_event_order, raw_record, wa_points, status_code)
                                    VALUES (?, ?, ?, ?, ?, '')`);
    // 10종/7종 sub-event 정의 (이름은 임의)
    const DEC_SUBS = ['100m', '멀리뛰기', '포환던지기', '높이뛰기', '400m', '110mH', '원반던지기', '장대높이뛰기', '창던지기', '1500m'];
    const HEP_SUBS = ['100mH', '높이뛰기', '포환던지기', '200m', '멀리뛰기', '창던지기', '800m'];
    const PEN_SUBS = ['높이뛰기', '창던지기', '200m', '원반던지기', '1500m'];

    const tx = db.transaction(() => {
        let sortOrder = 0;
        let createdEvents = 0, createdResults = 0;

        // 일정한 sort_order 부여를 위해 종목 순서 고정
        const EVENT_ORDER = [
            '100m', '200m', '400m', '800m', '1500m', '5000m', '10000m', '3000mSC',
            '100mH', '110mH', '400mH', '10000mW',
            '멀리뛰기', '세단뛰기', '높이뛰기', '장대높이뛰기',
            '포환던지기', '원반던지기', '해머던지기', '창던지기',
            '10종경기', '7종경기', '5종경기',
            '4x100mR', '4x400mR', '4x400mR(Mixed)', '4x800mR', '4x1500mR'
        ];
        const sortedKeys = [...byEvent.keys()].sort((a, b) => {
            const na = a.split('|')[0], nb = b.split('|')[0];
            const ia = EVENT_ORDER.indexOf(na), ib = EVENT_ORDER.indexOf(nb);
            return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
        });

        for (const key of sortedKeys) {
            const [eventName, gender, division] = key.split('|');
            const athleteIds = byEvent.get(key);
            const category = categorize(eventName);
            // 종목 row
            const evInfo = insEvent.run(compId, eventName, category, ++sortOrder, gender, division);
            const eventId = evInfo.lastInsertRowid;
            createdEvents++;

            // heat (1조) + heat 풍속 (트랙 단거리만)
            const heatWind = WIND_TRACK.has(eventName) ? randWind() : null;
            const heatInfo = insHeat.run(eventId, 1, heatWind == null ? null : `${heatWind > 0 ? '+' : ''}${heatWind.toFixed(1)} m/s`);
            const heatId = heatInfo.lastInsertRowid;

            // 각 선수에 entry + heat_entry + result 생성
            let lane = 1;
            for (const aid of athleteIds) {
                const eeInfo = insEvEntry.run(eventId, aid);
                const eeId = eeInfo.lastInsertRowid;
                insHeatEntry.run(heatId, eeId, lane++);

                // 임의 기록 (카테고리별로 적절한 시간/거리)
                let timeSec = null, distM = null;
                const status = '';  // status_code 빈값 = 정상 기록
                if (category === 'track' || category === 'relay') {
                    // 100m 11~13초, 200m 22~26, 400m 50~60, 5000m 900~1200초 등
                    if (eventName === '100m') timeSec = 10.8 + Math.random() * 2;
                    else if (eventName === '200m') timeSec = 21.5 + Math.random() * 4;
                    else if (eventName === '400m') timeSec = 48 + Math.random() * 8;
                    else if (eventName === '800m') timeSec = 110 + Math.random() * 20;
                    else if (eventName === '1500m') timeSec = 230 + Math.random() * 40;
                    else if (eventName === '5000m') timeSec = 850 + Math.random() * 150;
                    else if (eventName === '10000m') timeSec = 1800 + Math.random() * 300;
                    else if (eventName === '3000mSC') timeSec = 540 + Math.random() * 100;
                    else if (eventName === '100mH') timeSec = 13.5 + Math.random() * 2;
                    else if (eventName === '110mH') timeSec = 14.5 + Math.random() * 2;
                    else if (eventName === '400mH') timeSec = 52 + Math.random() * 8;
                    else if (eventName === '10000mW') timeSec = 2700 + Math.random() * 500;
                    else if (eventName.startsWith('4x100')) timeSec = 40 + Math.random() * 5;
                    else if (eventName.startsWith('4x400')) timeSec = 195 + Math.random() * 20;
                    else timeSec = 60 + Math.random() * 20;
                } else if (category === 'field_distance') {
                    if (eventName === '멀리뛰기') distM = 6 + Math.random() * 2;
                    else if (eventName === '세단뛰기') distM = 13 + Math.random() * 3;
                    else if (eventName === '포환던지기') distM = 12 + Math.random() * 6;
                    else if (eventName === '원반던지기') distM = 35 + Math.random() * 25;
                    else if (eventName === '해머던지기') distM = 40 + Math.random() * 25;
                    else if (eventName === '창던지기') distM = 50 + Math.random() * 25;
                    else distM = 10 + Math.random() * 10;
                } else if (category === 'field_height') {
                    if (eventName === '높이뛰기') distM = 1.7 + Math.random() * 0.5;
                    else if (eventName === '장대높이뛰기') distM = 4 + Math.random() * 1.5;
                    else distM = 1.5 + Math.random();
                } else if (category === 'combined') {
                    // result 행은 건너뛰고 combined_score에 sub-event별 점수 기록
                }

                if (category === 'combined') {
                    // combined_score에 종목별 wa_points 기록
                    let subs;
                    if (eventName === '10종경기') subs = DEC_SUBS;
                    else if (eventName === '7종경기') subs = HEP_SUBS;
                    else subs = PEN_SUBS;
                    let order = 1;
                    for (const sn of subs) {
                        // 종목별 그럴듯한 점수 (600~950점)
                        const pts = Math.round(600 + Math.random() * 350);
                        const raw = (10 + Math.random() * 5).toFixed(2);  // 임의 raw record
                        insCombined.run(eeId, sn, order++, raw, pts);
                    }
                    createdResults++;
                } else {
                    // result 풍속:
                    //   - 트랙 단거리: heatWind (heat 단위로 공통)
                    //   - 필드(멀리/세단): 시도별 풍속 (선수별로 다름)
                    //   - 그 외: null
                    let resultWind = null;
                    if (WIND_TRACK.has(eventName)) resultWind = heatWind;
                    else if (WIND_FIELD.has(eventName)) resultWind = randWind();
                    insResult.run(heatId, eeId, 1, timeSec, distM, status, resultWind);
                    createdResults++;
                }
            }
        }
        return { createdEvents, createdResults };
    });
    const { createdEvents, createdResults } = tx();
    console.log(`✓ 종목 ${createdEvents}개, heat ${createdEvents}개, result ${createdResults}개 생성`);
    return { createdEvents, createdResults };
}

// ─── Main ─────────────────────────────────────────────────────────────
(async () => {
    try {
        const compId = await createCompetition();
        const entries = await loadEntries();
        console.log(`✓ 명단 로드: ${entries.length}명`);
        const athleteMap = insertAthletes(compId, entries);
        createEventsAndResults(compId, entries, athleteMap);

        // 요약
        const eventCount = db.prepare('SELECT COUNT(*) AS c FROM event WHERE competition_id=?').get(compId).c;
        const evtByDiv = db.prepare(`SELECT division, gender, COUNT(*) AS c FROM event WHERE competition_id=? GROUP BY division, gender ORDER BY division, gender`).all(compId);
        console.log(`\n=== 최종 요약 ===`);
        console.log(`comp_id = ${compId}, 총 종목 ${eventCount}개`);
        evtByDiv.forEach(r => console.log(`  ${r.division} (${r.gender}): ${r.c}`));
        console.log(`\n부별 종합기록지 URL: /api/documents/comprehensive-by-division/${compId}/excel`);
    } catch (err) {
        console.error('ERROR:', err);
        process.exit(1);
    } finally {
        db.close();
    }
})();
