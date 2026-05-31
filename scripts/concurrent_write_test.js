/**
 * 동시 쓰기 부하 테스트 — busy_timeout 효과 검증
 *
 * 시나리오: 심판 5명이 동시에 result 테이블에 기록 입력하는 상황 시뮬레이션.
 * - 각 심판은 50건의 입력을 빠르게 수행
 * - 충돌(SQLITE_BUSY) 발생 빈도 측정
 * - busy_timeout이 제대로 적용됐다면 SQLITE_BUSY 0건이어야 함
 */
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'db', '_concurrent_test.db');

if (isMainThread) {
    // 메인 — 깨끗한 테스트 DB 생성
    const Database = require('better-sqlite3');
    const fs = require('fs');
    try { fs.unlinkSync(DB_PATH); } catch(e){}
    try { fs.unlinkSync(DB_PATH + '-wal'); } catch(e){}
    try { fs.unlinkSync(DB_PATH + '-shm'); } catch(e){}

    const db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000'); // ⚡ 핵심
    db.exec(`CREATE TABLE result_test (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        judge_id INTEGER NOT NULL,
        athlete_id INTEGER NOT NULL,
        time_seconds REAL,
        created_at TEXT DEFAULT (datetime('now'))
    )`);
    db.close();

    const NUM_JUDGES = 5;
    const ROWS_PER_JUDGE = 50;
    console.log(`\n=== 동시 쓰기 부하 테스트 ===`);
    console.log(`심판 ${NUM_JUDGES}명 × 각 ${ROWS_PER_JUDGE}건 = 총 ${NUM_JUDGES * ROWS_PER_JUDGE}건 동시 입력 시뮬레이션`);
    console.log(`busy_timeout: 5000ms (활성)\n`);

    const workers = [];
    const results = [];
    const startTime = Date.now();

    for (let i = 0; i < NUM_JUDGES; i++) {
        const w = new Worker(__filename, {
            workerData: { judgeId: i + 1, rowCount: ROWS_PER_JUDGE, dbPath: DB_PATH }
        });
        w.on('message', (msg) => {
            results.push(msg);
            if (results.length === NUM_JUDGES) {
                const elapsed = Date.now() - startTime;
                let totalSuccess = 0, totalBusy = 0, totalOther = 0;
                results.forEach(r => {
                    totalSuccess += r.success;
                    totalBusy += r.busy;
                    totalOther += r.other;
                });
                console.log('=== 결과 ===');
                results.forEach(r => {
                    console.log(`  심판 #${r.judgeId}: 성공 ${r.success}건, BUSY ${r.busy}건, 기타에러 ${r.other}건 (${r.elapsedMs}ms)`);
                });
                console.log('');
                console.log(`총 소요: ${elapsed}ms`);
                console.log(`전체 성공: ${totalSuccess}건 / ${NUM_JUDGES * ROWS_PER_JUDGE}건 (${(totalSuccess/(NUM_JUDGES*ROWS_PER_JUDGE)*100).toFixed(1)}%)`);
                console.log(`SQLITE_BUSY 에러: ${totalBusy}건`);
                console.log(`기타 에러: ${totalOther}건`);
                console.log('');
                if (totalBusy === 0 && totalOther === 0) {
                    console.log('✅ 합격 — busy_timeout이 정상 작동, 충돌 없이 동시 입력 처리됨');
                } else {
                    console.log('⚠️ 일부 충돌 발생 — 추가 튜닝 필요');
                }
                // 최종 검증: DB에 실제 들어간 row 수
                const verify = new (require('better-sqlite3'))(DB_PATH, { readonly: true });
                const cnt = verify.prepare('SELECT COUNT(*) as c FROM result_test').get().c;
                console.log(`DB 실제 저장: ${cnt}건 ${cnt === NUM_JUDGES * ROWS_PER_JUDGE ? '✅' : '❌'}`);
                verify.close();
                // 정리
                try { require('fs').unlinkSync(DB_PATH); } catch(e){}
                try { require('fs').unlinkSync(DB_PATH + '-wal'); } catch(e){}
                try { require('fs').unlinkSync(DB_PATH + '-shm'); } catch(e){}
                process.exit(totalBusy === 0 && totalOther === 0 ? 0 : 1);
            }
        });
        w.on('error', (e) => { console.error('Worker error:', e); process.exit(1); });
        workers.push(w);
    }
} else {
    // 워커 — 한 명의 심판 역할
    const Database = require('better-sqlite3');
    const { judgeId, rowCount, dbPath } = workerData;
    const db = new Database(dbPath);
    db.pragma('busy_timeout = 5000'); // 워커도 동일 설정
    const stmt = db.prepare('INSERT INTO result_test (judge_id, athlete_id, time_seconds) VALUES (?, ?, ?)');
    let success = 0, busy = 0, other = 0;
    const start = Date.now();
    for (let i = 0; i < rowCount; i++) {
        try {
            stmt.run(judgeId, judgeId * 1000 + i, 10.0 + Math.random() * 5);
            success++;
        } catch (e) {
            if (e.code === 'SQLITE_BUSY') busy++;
            else { other++; console.error(`심판 #${judgeId} 에러:`, e.message); }
        }
    }
    const elapsedMs = Date.now() - start;
    db.close();
    parentPort.postMessage({ judgeId, success, busy, other, elapsedMs });
}
