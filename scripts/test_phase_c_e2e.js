// Phase C E2E (integration) — server.js 부팅 없이 lib/db + lib/recordCompare 직접 사용
// 1. 임시 SQLite DB에 schema 적용
// 2. 시리즈/대회/종목/선수/엔트리 DB INSERT
// 3. detectRecordBreaks 직접 호출 → record_breaking_log 검증
// 4. 같은 entry 더 좋은 기록 → pending 업데이트 (중복 방지)
// 5. server.js의 approve/reject 로직과 동등한 매뉴얼 UPSERT 검증
//
// 이 방식의 장점: HTTP/인증 우회 → 핵심 로직만 깔끔히 테스트

const path = require('path');
const fs = require('fs');

const TEST_DB = path.join(__dirname, '..', 'db', 'phase_c_test.db');
try { fs.unlinkSync(TEST_DB); } catch(e) {}

// 환경변수로 DB 경로 강제
process.env.DB_PATH = TEST_DB;
process.env.NODE_ENV = 'test';
process.env.DB_BACKEND = 'sqlite';

const { getDb } = require('../lib/db');
const { detectRecordBreaks } = require('../lib/recordCompare');

// getDb는 옵션으로 path를 받음 (singleton). 첫 호출에서 TEST_DB로 고정.
const _db = getDb({ path: TEST_DB });
// 이후 require된 lib/recordCompare 내부에서 db.get/run을 호출할 때 같은 싱글톤을 받게 됨

let pass = 0, fail = 0;
function log(name, ok, detail) {
    if (ok) { pass++; console.log('  ✅', name); }
    else { fail++; console.log('  ❌', name, detail !== undefined ? '— ' + JSON.stringify(detail) : ''); }
}

async function main() {
    const db = _db;
    // db.js는 init 시 schema.sql을 자동 로드함 (정상)

    // server.js 부팅 시 적용되는 boot 마이그레이션을 여기서 직접 수행
    // result 테이블에 status_code/remark/wind 컬럼 추가
    try { db.exec(`ALTER TABLE result ADD COLUMN remark TEXT DEFAULT ''`); } catch(e) {}
    try { db.exec(`ALTER TABLE result ADD COLUMN status_code TEXT DEFAULT ''`); } catch(e) {}
    try { db.exec(`ALTER TABLE result ADD COLUMN wind REAL DEFAULT NULL`); } catch(e) {}
    // competition 테이블에 series_id (Phase B) 추가
    try { db.exec(`ALTER TABLE competition ADD COLUMN series_id INTEGER REFERENCES competition_series(id)`); } catch(e) {}

    // Schema 자동 로드 외에 boot 마이그레이션 블록(server.js 안)이 division_master/competition_series 시드를 보장.
    // 여기서는 server.js 부팅을 안 하니, 시드를 직접 적용:
    const seedDivCount = await db.get('SELECT COUNT(*) AS c FROM division_master');
    if (!seedDivCount || seedDivCount.c === 0) {
        // schema.sql에 이미 INSERT OR IGNORE가 있으니 정상 적용됐을 것. 만약 안 됐다면 수동:
        const seeds = [
            ['M_ELEM',  '남자초등부', 'M', 'ELEM',  10],
            ['M_MID',   '남자중학부', 'M', 'MID',   20],
            ['M_HIGH',  '남자고등부', 'M', 'HIGH',  30],
            ['M_UNIV',  '남자대학부', 'M', 'UNIV',  40],
            ['M_GEN',   '남자일반부', 'M', 'GEN',   50],
            ['M_OPEN',  '남자공개부', 'M', 'OPEN',  60],
            ['F_ELEM',  '여자초등부', 'F', 'ELEM', 110],
            ['F_MID',   '여자중학부', 'F', 'MID',  120],
            ['F_HIGH',  '여자고등부', 'F', 'HIGH', 130],
            ['F_UNIV',  '여자대학부', 'F', 'UNIV', 140],
            ['F_GEN',   '여자일반부', 'F', 'GEN',  150],
            ['F_OPEN',  '여자공개부', 'F', 'OPEN', 160],
            ['MIXED',   '혼성부',     'X', 'MIXED', 200],
        ];
        for (const s of seeds) {
            try { await db.run('INSERT OR IGNORE INTO division_master (code, label_ko, gender, school_level, sort_order) VALUES (?,?,?,?,?)', ...s); } catch(e) {}
        }
    }

    console.log('▶ Phase C 통합 시나리오\n');

    // 시리즈
    const sIns = await db.run('INSERT INTO competition_series (name, description, active) VALUES (?,?,1)', 'TEST 시리즈', 'e2e');
    const seriesId = sIns.lastInsertRowid;
    log('시리즈 INSERT', !!seriesId);

    // 대회 (series_id 연결)
    const cIns = await db.run(
        `INSERT INTO competition (name, start_date, end_date, venue, status, mode, series_id)
         VALUES (?,?,?,?,?,?,?)`,
        'E2E 대회', '2025-01-01', '2025-01-02', '', 'upcoming', 'operation', seriesId
    );
    const compId = cIns.lastInsertRowid;
    log('대회 INSERT (시리즈 연결)', !!compId);

    // 종목 (트랙 100m 남자, division=M_OPEN)
    const eIns = await db.run(
        `INSERT INTO event (competition_id, name, category, gender, round_type, division)
         VALUES (?,?,?,?,?,?)`,
        compId, '100m', 'track', 'M', 'final', 'M_OPEN'
    );
    const eventId = eIns.lastInsertRowid;
    log('종목 INSERT (100m M_OPEN)', !!eventId);

    // 선수
    const aIns = await db.run(
        `INSERT INTO athlete (competition_id, name, team, gender, bib_number) VALUES (?,?,?,?,?)`,
        compId, '테스트선수', '테스트팀', 'M', '101'
    );
    const athleteId = aIns.lastInsertRowid;
    log('선수 INSERT', !!athleteId);

    // 엔트리
    const enIns = await db.run('INSERT INTO event_entry (event_id, athlete_id) VALUES (?,?)', eventId, athleteId);
    const entryId = enIns.lastInsertRowid;
    log('엔트리 INSERT', !!entryId);

    // 조
    const hIns = await db.run('INSERT INTO heat (event_id, heat_number) VALUES (?,?)', eventId, 1);
    const heatId = hIns.lastInsertRowid;
    log('heat INSERT', !!heatId);

    // 첫 결과 INSERT (10.07초)
    const r1Ins = await db.run(
        `INSERT INTO result (heat_id, event_entry_id, time_seconds, status_code) VALUES (?,?,?,?)`,
        heatId, entryId, 10.07, ''
    );
    const r1 = await db.get('SELECT * FROM result WHERE id=?', r1Ins.lastInsertRowid);
    const event = await db.get('SELECT * FROM event WHERE id=?', eventId);
    const heat = await db.get('SELECT * FROM heat WHERE id=?', heatId);
    const competition = await db.get('SELECT * FROM competition WHERE id=?', compId);
    const athlete = await db.get('SELECT * FROM athlete WHERE id=?', athleteId);
    const eventEntry = await db.get('SELECT * FROM event_entry WHERE id=?', entryId);

    // detectRecordBreaks 직접 호출
    const ret1 = await detectRecordBreaks(db, { result: r1, heat, event, athlete, competition, eventEntry });
    log('detectRecordBreaks 호출 OK', ret1 && !ret1.skipped, ret1);
    log('3건(NR/DR/CR) 감지', ret1.detected && ret1.detected.length === 3, ret1.detected);

    // record_breaking_log 직접 확인
    const logs1 = await db.all('SELECT * FROM record_breaking_log WHERE competition_id=? AND status=?', compId, 'pending');
    log('record_breaking_log에 3건 pending', logs1.length === 3, logs1.map(x => `${x.record_type}/${x.division_code||'-'}/${x.series_id||'-'}/${x.new_value}`));

    const nrLog = logs1.find(x => x.record_type === 'national');
    const drLog = logs1.find(x => x.record_type === 'division' && x.division_code === 'M_OPEN');
    const crLog = logs1.find(x => x.record_type === 'competition' && x.series_id === seriesId);
    log('NR row 존재', !!nrLog);
    log('DR(M_OPEN) row 존재', !!drLog);
    log('CR(시리즈) row 존재', !!crLog);
    log('NR new_value_num = 10.07', nrLog && Math.abs(nrLog.new_value_num - 10.07) < 0.01, nrLog && nrLog.new_value_num);

    // 더 좋은 기록 UPDATE
    await db.run("UPDATE result SET time_seconds=? WHERE id=?", 9.95, r1.id);
    const r2 = await db.get('SELECT * FROM result WHERE id=?', r1.id);
    const ret2 = await detectRecordBreaks(db, { result: r2, heat, event, athlete, competition, eventEntry });
    log('두 번째 호출 OK', !ret2.skipped, ret2);

    const logs2 = await db.all('SELECT * FROM record_breaking_log WHERE competition_id=? AND status=?', compId, 'pending');
    log('pending 여전히 3건 (중복 방지)', logs2.length === 3, logs2.length);
    const nrLog2 = logs2.find(x => x.record_type === 'national');
    log('NR pending 값이 9.95로 업데이트', nrLog2 && Math.abs(nrLog2.new_value_num - 9.95) < 0.01, nrLog2 && nrLog2.new_value_num);

    // 같은 값 재호출 → 새 pending 안 생김 (기존 record가 없으므로 isBetter는 여전히 true,
    // 하지만 같은 entry/attempt 기준 중복 방지로 UPDATE만 일어남)
    const ret3 = await detectRecordBreaks(db, { result: r2, heat, event, athlete, competition, eventEntry });
    const logs3 = await db.all('SELECT * FROM record_breaking_log WHERE competition_id=? AND status=?', compId, 'pending');
    log('동일 결과 재감지 시 pending 변동 없음', logs3.length === 3);

    // 더 나쁜 기록은 비교 안 되어야 함 — 새 result 객체로 시뮬레이션 (기존 pending 값보다 나쁨)
    // 하지만 detectRecordBreaks는 기존 event_record와 비교하지 pending과는 비교 안 함.
    // event_record가 비어 있으므로 어떤 값이든 newval이 더 나음 → 여전히 pending 갱신.
    // 이 단계에서는 그게 정상이므로 별도 테스트 안 함.

    // DQ 결과 → skip
    await db.run("UPDATE result SET status_code='DQ', time_seconds=NULL WHERE id=?", r1.id);
    const r3 = await db.get('SELECT * FROM result WHERE id=?', r1.id);
    const retDQ = await detectRecordBreaks(db, { result: r3, heat, event, athlete, competition, eventEntry });
    log('DQ는 skip', retDQ.skipped && retDQ.skipped.includes('status-code'), retDQ.skipped);

    // === 승인 로직 시뮬레이션 (server.js의 approve 라우트와 동일 패턴) ===
    if (nrLog) {
        const recordYear = String(new Date(nrLog.detected_at).getFullYear());
        // NULL-aware UPSERT
        const existing = await db.get(
            `SELECT id FROM event_record WHERE record_type=? AND event_name=? AND gender=?
             AND division_code IS NULL AND series_id IS NULL`,
            'national', '100m', 'M'
        );
        if (existing) {
            await db.run(
                `UPDATE event_record SET record_value=?, record_year=?, holder_name=?, holder_team=?, approved=1 WHERE id=?`,
                String(nrLog2.new_value_num), recordYear, nrLog.athlete_name, nrLog.athlete_team, existing.id
            );
        } else {
            await db.run(
                `INSERT INTO event_record (record_type, event_name, gender, division_code, series_id,
                                            record_value, holder_name, holder_team, record_year, approved)
                 VALUES (?,?,?,?,?,?,?,?,?,1)`,
                'national', '100m', 'M', null, null,
                String(nrLog2.new_value_num), nrLog.athlete_name, nrLog.athlete_team, recordYear
            );
        }
        await db.run("UPDATE record_breaking_log SET status='approved', reviewed_at=datetime('now') WHERE id=?", nrLog.id);
        log('NR 승인 시뮬레이션 완료', true);

        const nrRec = await db.get(
            `SELECT * FROM event_record WHERE record_type='national' AND event_name='100m' AND gender='M'
             AND division_code IS NULL AND series_id IS NULL`
        );
        log('event_record NR 갱신됨', nrRec && Math.abs(parseFloat(nrRec.record_value) - 9.95) < 0.01,
            nrRec && nrRec.record_value);
    }

    // 다시 detectRecordBreaks 호출 시: event_record에 NR=9.95가 이미 있으므로
    // 더 나쁜 기록(10.50)을 입력하면 NR pending은 안 생김
    await db.run("UPDATE result SET status_code='', time_seconds=? WHERE id=?", 10.50, r1.id);
    // 새 entry 만들어서 충돌 회피
    const a2 = await db.run(`INSERT INTO athlete (competition_id, name, team, gender, bib_number) VALUES (?,?,?,?,?)`,
        compId, '선수2', '팀2', 'M', '102');
    const en2 = await db.run('INSERT INTO event_entry (event_id, athlete_id) VALUES (?,?)', eventId, a2.lastInsertRowid);
    const r4Ins = await db.run(
        `INSERT INTO result (heat_id, event_entry_id, time_seconds, status_code) VALUES (?,?,?,?)`,
        heatId, en2.lastInsertRowid, 10.50, ''
    );
    const r4 = await db.get('SELECT * FROM result WHERE id=?', r4Ins.lastInsertRowid);
    const ath2 = await db.get('SELECT * FROM athlete WHERE id=?', a2.lastInsertRowid);
    const en2Row = await db.get('SELECT * FROM event_entry WHERE id=?', en2.lastInsertRowid);
    const ret4 = await detectRecordBreaks(db, { result: r4, heat, event, athlete: ath2, competition, eventEntry: en2Row });

    const hasNR = ret4.detected.some(d => d.record_type === 'national');
    log('승인된 NR(9.95)보다 나쁜 기록(10.50) → NR 갱신 감지 안 함', !hasNR, ret4.detected);

    const hasDR = ret4.detected.some(d => d.record_type === 'division');
    log('DR은 아직 event_record 비어있어 감지됨', hasDR, ret4.detected);

    // Cleanup test DB
    try { fs.unlinkSync(TEST_DB); } catch(e) {}

    console.log('\n═══════════════════════════════════════════');
    console.log(`  결과: ${pass} pass / ${fail} fail`);
    console.log('═══════════════════════════════════════════');
    process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('TEST FAILED:', err);
    try { fs.unlinkSync(TEST_DB); } catch(e) {}
    process.exit(1);
});
