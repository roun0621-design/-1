#!/usr/bin/env node
/**
 * Phase 2-G-9-part3 Stage 3 — Load test (PG concurrent INSERT)
 *
 * 목적
 * ─────────────────────────────────────────────────────────────
 *   PostgreSQL 모드에서 대량 동시 INSERT 시 latency 분포(p50/p95/p99/max)
 *   와 에러/데드락 발생 건수를 측정한다.
 *
 *   - lib/db.js 를 직접 사용 → HTTP/express 오버헤드 제외, 순수 DB 성능
 *   - athlete 테이블에 INSERT (FK 의존 적음, id auto-gen)
 *   - 동시성 = concurrency 옵션 (기본 50), 총 요청수 = total (기본 10000)
 *
 * 실행
 * ─────────────────────────────────────────────────────────────
 *   PGCONN="postgres://pacerise:pacerise_test_pw@localhost:5432/pacerise_test" \
 *   node scripts/load_test.js
 *
 *   # 옵션
 *   TOTAL=10000 CONCURRENCY=50 node scripts/load_test.js
 *
 * 종료 코드
 * ─────────────────────────────────────────────────────────────
 *   0 = 모든 요청 성공
 *   1 = 1건 이상 에러
 */

'use strict';

const path = require('path');

process.env.DB_BACKEND = process.env.DB_BACKEND || 'postgres';
if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = process.env.PGCONN
        || 'postgres://pacerise:pacerise_test_pw@localhost:5432/pacerise_test';
}

const { getDb } = require(path.join(__dirname, '..', 'lib', 'db.js'));

const TOTAL = parseInt(process.env.TOTAL || '10000', 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '50', 10);

function colored(msg, color) {
    const codes = { red: 31, green: 32, yellow: 33, blue: 34, gray: 90 };
    const c = codes[color] || 37;
    return `\x1b[${c}m${msg}\x1b[0m`;
}

function percentile(sortedArr, p) {
    if (sortedArr.length === 0) return 0;
    const idx = Math.min(sortedArr.length - 1, Math.floor(sortedArr.length * p));
    return sortedArr[idx];
}

async function main() {
    console.log(colored('═══════════════════════════════════════════════════════', 'blue'));
    console.log(colored('  Phase 2-G-9-part3 Stage 3: LOAD TEST', 'blue'));
    console.log(colored(`  PostgreSQL 동시 INSERT — total=${TOTAL}, concurrency=${CONCURRENCY}`, 'blue'));
    console.log(colored('═══════════════════════════════════════════════════════', 'blue'));
    console.log('');

    const db = getDb();
    if (!db.isAsync) {
        console.error(colored('FATAL: DB_BACKEND 가 postgres 가 아닙니다.', 'red'));
        process.exit(2);
    }

    // 1) 테스트용 competition 생성 (FK 충족)
    console.log(colored('▶ 테스트 대회 준비 ...', 'gray'));
    const compRes = await db.run(
        `INSERT INTO competition (name, start_date, end_date, venue, status)
         VALUES (?, ?, ?, ?, ?)`,
        'LOAD_TEST_COMP', '2026-08-01', '2026-08-02', 'LoadVenue', 'upcoming'
    );
    const COMP_ID = compRes.lastInsertRowid;
    console.log(colored(`  competition id=${COMP_ID} 생성`, 'gray'));

    // 2) 워커 풀: concurrency 만큼 동시에 INSERT 처리
    const latencies = [];
    let errors = 0;
    const errorSamples = [];
    let inserted = 0;
    let nextIdx = 0;

    const t0 = Date.now();

    async function worker(workerId) {
        while (true) {
            const i = nextIdx++;
            if (i >= TOTAL) return;

            const name = `LoadAthlete_${i}_${workerId}`;
            const bib = String(10000 + i);
            const team = `LoadTeam_${i % 20}`;
            const gender = i % 2 === 0 ? 'M' : 'F';

            const start = process.hrtime.bigint();
            try {
                await db.run(
                    `INSERT INTO athlete (competition_id, name, bib_number, team, barcode, gender)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    COMP_ID, name, bib, team, '', gender
                );
                const elapsedNs = Number(process.hrtime.bigint() - start);
                latencies.push(elapsedNs / 1e6); // ms
                inserted++;
            } catch (e) {
                errors++;
                if (errorSamples.length < 5) {
                    errorSamples.push(e.message);
                }
            }

            if ((inserted + errors) % 1000 === 0 && (inserted + errors) > 0) {
                const elapsed = (Date.now() - t0) / 1000;
                const rate = (inserted + errors) / elapsed;
                process.stdout.write(`\r  진행: ${inserted + errors}/${TOTAL}  (${rate.toFixed(0)} req/s)   `);
            }
        }
    }

    console.log(colored(`▶ ${CONCURRENCY} workers x ${TOTAL} INSERTs 시작 ...`, 'gray'));
    const workers = [];
    for (let w = 0; w < CONCURRENCY; w++) {
        workers.push(worker(w));
    }
    await Promise.all(workers);

    const totalMs = Date.now() - t0;
    process.stdout.write('\r');
    console.log(colored(`✓ 완료 (총 ${(totalMs / 1000).toFixed(2)}s)                          `, 'green'));
    console.log('');

    // 3) 통계
    latencies.sort((a, b) => a - b);
    const p50 = percentile(latencies, 0.5);
    const p95 = percentile(latencies, 0.95);
    const p99 = percentile(latencies, 0.99);
    const max = latencies.length ? latencies[latencies.length - 1] : 0;
    const min = latencies.length ? latencies[0] : 0;
    const mean = latencies.length ? (latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
    const throughput = inserted / (totalMs / 1000);

    console.log(colored('───────────────────────────────────────────────────────', 'blue'));
    console.log(colored('  Latency (ms)', 'blue'));
    console.log(colored('───────────────────────────────────────────────────────', 'blue'));
    console.log(`    min      : ${min.toFixed(2)} ms`);
    console.log(`    mean     : ${mean.toFixed(2)} ms`);
    console.log(`    p50      : ${p50.toFixed(2)} ms`);
    console.log(`    p95      : ${p95.toFixed(2)} ms`);
    console.log(`    p99      : ${p99.toFixed(2)} ms`);
    console.log(`    max      : ${max.toFixed(2)} ms`);
    console.log('');
    console.log(colored('───────────────────────────────────────────────────────', 'blue'));
    console.log(colored('  Throughput / Errors', 'blue'));
    console.log(colored('───────────────────────────────────────────────────────', 'blue'));
    console.log(`    inserted : ${inserted} / ${TOTAL}`);
    console.log(`    errors   : ${errors}`);
    console.log(`    rate     : ${throughput.toFixed(0)} req/s`);
    console.log(`    total    : ${(totalMs / 1000).toFixed(2)} s`);
    if (errors > 0) {
        console.log('');
        console.log(colored('  Error samples:', 'red'));
        for (const e of errorSamples) console.log(`    - ${e}`);
    }
    console.log('');

    // 4) 정합성 검증: 실제로 INSERT 된 row 수
    const cntRow = await db.get('SELECT COUNT(*) AS c FROM athlete WHERE competition_id=?', COMP_ID);
    const actualCount = parseInt(cntRow.c, 10);
    console.log(colored('───────────────────────────────────────────────────────', 'blue'));
    console.log(colored('  Integrity check', 'blue'));
    console.log(colored('───────────────────────────────────────────────────────', 'blue'));
    console.log(`    DB row count : ${actualCount}`);
    console.log(`    expected     : ${inserted}`);
    const integrityOk = actualCount === inserted;
    console.log(`    integrity    : ${integrityOk ? colored('OK', 'green') : colored('MISMATCH', 'red')}`);
    console.log('');

    // 5) 정리
    console.log(colored('▶ 테스트 데이터 정리 ...', 'gray'));
    await db.run('DELETE FROM athlete WHERE competition_id=?', COMP_ID);
    await db.run('DELETE FROM competition WHERE id=?', COMP_ID);
    console.log(colored('  완료', 'gray'));
    console.log('');

    console.log(colored('═══════════════════════════════════════════════════════', 'blue'));
    if (errors === 0 && integrityOk) {
        console.log(colored(`  ✅ LOAD TEST PASS — ${inserted} inserts, 0 errors, integrity OK`, 'green'));
    } else {
        console.log(colored(`  ❌ LOAD TEST FAIL — errors=${errors}, integrity=${integrityOk}`, 'red'));
    }
    console.log(colored('═══════════════════════════════════════════════════════', 'blue'));

    // Pool 종료 (process.exit 없으면 hang)
    try { await db.raw.end(); } catch (_) {}
    process.exit((errors === 0 && integrityOk) ? 0 : 1);
}

main().catch((e) => {
    console.error(colored('FATAL: ' + e.message, 'red'));
    console.error(e.stack);
    process.exit(2);
});
