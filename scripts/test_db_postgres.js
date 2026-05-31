/**
 * Phase 2-B/A 통합 검증
 * =========================
 * lib/db.js의 PostgreSQL 어댑터가 실제 PostgreSQL과 정상 연동되는지 검증.
 *
 * 사전조건:
 *   - DB_BACKEND=postgres 환경변수
 *   - DATABASE_URL=postgres://pacerise:pacerise_test_pw@localhost:5432/pacerise_test
 *   - db/schema.pg.sql 이 pacerise_test에 적용되어 있어야 함
 *
 * 사용:
 *   DB_BACKEND=postgres \
 *   DATABASE_URL=postgres://pacerise:pacerise_test_pw@localhost:5432/pacerise_test \
 *   node scripts/test_db_postgres.js
 */
const assert = require('assert');

console.log('═══════════════════════════════════════════════════════');
console.log('  Phase 2-A/B 통합: lib/db.js × PostgreSQL 라이브 검증');
console.log('═══════════════════════════════════════════════════════\n');

process.env.DB_BACKEND = process.env.DB_BACKEND || 'postgres';
console.log(`DB_BACKEND = ${process.env.DB_BACKEND}`);
console.log(`DATABASE_URL = ${process.env.DATABASE_URL || '(unset)'}\n`);

const { getDb, _resetForTest } = require('../lib/db');
_resetForTest();
const db = getDb();

let pass = 0, fail = 0;
async function test(name, fn) {
    try {
        await fn();
        pass++;
        console.log(`  ✅ ${name}`);
    } catch (e) {
        fail++;
        console.log(`  ❌ ${name}: ${e.message}`);
        if (e.query) console.log(`     SQL: ${e.query}`);
    }
}

(async () => {
    // ─────────────────────────────────────────
    // 0. 백엔드 기본 정보
    // ─────────────────────────────────────────
    console.log('▶ Group 0: 백엔드 정보');
    console.log('───────────────────────────────────────────────────────');
    await test('백엔드 이름 = postgres', () => {
        assert.strictEqual(db.getBackendName(), 'postgres');
    });
    await test('isAsync = true', () => {
        assert.strictEqual(db.isAsync, true);
    });

    // ─────────────────────────────────────────
    // 1. 기본 CRUD (실 PG)
    // ─────────────────────────────────────────
    console.log('\n▶ Group 1: 기본 CRUD');
    console.log('───────────────────────────────────────────────────────');

    // 테스트 시작 전 청소
    await db.exec('DELETE FROM event WHERE competition_id IN (SELECT id FROM competition WHERE name LIKE \'__test_%\')');
    await db.exec('DELETE FROM competition WHERE name LIKE \'__test_%\'');

    let competitionId;
    await test('INSERT 후 lastInsertRowid 반환', async () => {
        const r = await db.run(
            `INSERT INTO competition (name, start_date, end_date, venue, status) VALUES (?, ?, ?, ?, ?)`,
            '__test_competition_1', '2026-06-01', '2026-06-02', '__test_venue', 'upcoming'
        );
        assert.strictEqual(r.changes, 1);
        assert.ok(typeof r.lastInsertRowid === 'number' && r.lastInsertRowid > 0, 'lastInsertRowid must be number');
        competitionId = r.lastInsertRowid;
    });

    await test('SELECT 단일 row (db.get)', async () => {
        const row = await db.get(`SELECT id, name, status FROM competition WHERE id = ?`, competitionId);
        assert.strictEqual(row.name, '__test_competition_1');
        assert.strictEqual(row.status, 'upcoming');
    });

    await test('SELECT 여러 row (db.all)', async () => {
        await db.run(
            `INSERT INTO competition (name, start_date, end_date, venue, status) VALUES (?, ?, ?, ?, ?)`,
            '__test_competition_2', '2026-07-01', '2026-07-02', '__test_v2', 'upcoming'
        );
        const rows = await db.all(`SELECT id FROM competition WHERE name LIKE '__test_%' ORDER BY id`);
        assert.ok(rows.length >= 2, `expected >= 2, got ${rows.length}`);
    });

    await test('UPDATE (changes count)', async () => {
        const r = await db.run(`UPDATE competition SET status = ? WHERE id = ?`, 'active', competitionId);
        assert.strictEqual(r.changes, 1);
    });

    await test('UPDATE 후 변경 확인', async () => {
        const row = await db.get(`SELECT status FROM competition WHERE id = ?`, competitionId);
        assert.strictEqual(row.status, 'active');
    });

    await test('DELETE (changes count)', async () => {
        const r = await db.run(`DELETE FROM competition WHERE name = ?`, '__test_competition_2');
        assert.strictEqual(r.changes, 1);
    });

    // ─────────────────────────────────────────
    // 2. SQL 자동 변환 검증 (실 PG 실행)
    // ─────────────────────────────────────────
    console.log('\n▶ Group 2: SQL 자동 변환 (실행 검증)');
    console.log('───────────────────────────────────────────────────────');

    await test('? placeholder → $N 변환 (다중 인자)', async () => {
        const row = await db.get(
            `SELECT id FROM competition WHERE name = ? AND start_date = ?`,
            '__test_competition_1', '2026-06-01'
        );
        assert.ok(row && row.id === competitionId);
    });

    await test("datetime('now') → NOW() 변환", async () => {
        // operation_log는 created_at DEFAULT (datetime('now'))를 가짐
        // 명시적으로 datetime('now')를 보낸 경우도 변환되어야 함
        const r = await db.run(
            `INSERT INTO operation_log (competition_id, message, performed_by, created_at) VALUES (?, ?, ?, datetime('now'))`,
            competitionId, '__test_message', 'test_user'
        );
        assert.strictEqual(r.changes, 1);
    });

    await test('INSERT OR IGNORE → ON CONFLICT DO NOTHING', async () => {
        // event_record는 (gender, event_name, record_type) UNIQUE 제약 있음
        await db.run(
            `INSERT OR IGNORE INTO event_record (gender, event_name, record_type, record_value) VALUES (?, ?, ?, ?)`,
            'M', '__test_event_100m', 'national', '10.00'
        );
        // 두 번째: 충돌해도 에러 안나야 함
        const r = await db.run(
            `INSERT OR IGNORE INTO event_record (gender, event_name, record_type, record_value) VALUES (?, ?, ?, ?)`,
            'M', '__test_event_100m', 'national', '9.99'
        );
        // PG: 충돌 시 changes=0
        assert.strictEqual(r.changes, 0, `expected changes=0 (conflict), got ${r.changes}`);
        const row = await db.get(
            `SELECT record_value FROM event_record WHERE gender = ? AND event_name = ? AND record_type = ?`,
            'M', '__test_event_100m', 'national'
        );
        // 첫번째 값 유지
        assert.strictEqual(row.record_value, '10.00');
        // 청소
        await db.run(`DELETE FROM event_record WHERE event_name = ?`, '__test_event_100m');
    });

    await test('문자열 내 ? 보존', async () => {
        // 'what?' 같은 문자열 안의 ?는 placeholder로 변환되면 안됨
        const r = await db.run(
            `INSERT INTO operation_log (competition_id, message, performed_by) VALUES (?, 'what?', ?)`,
            competitionId, 'test'
        );
        assert.strictEqual(r.changes, 1);
        const row = await db.get(
            `SELECT message FROM operation_log WHERE competition_id = ? AND message = 'what?'`,
            competitionId
        );
        assert.strictEqual(row.message, 'what?');
    });

    // ─────────────────────────────────────────
    // 3. 트랜잭션 (AsyncLocalStorage)
    // ─────────────────────────────────────────
    console.log('\n▶ Group 3: 트랜잭션');
    console.log('───────────────────────────────────────────────────────');

    await test('정상 트랜잭션 COMMIT', async () => {
        const txn = db.transaction(async (name) => {
            const r1 = await db.run(
                `INSERT INTO competition (name, start_date, end_date, venue, status) VALUES (?, ?, ?, ?, ?)`,
                name, '2026-08-01', '2026-08-02', '__txn_venue', 'upcoming'
            );
            // 같은 트랜잭션 내 SELECT
            const row = await db.get(`SELECT id FROM competition WHERE id = ?`, r1.lastInsertRowid);
            assert.ok(row, 'inside txn: row should be visible');
            return r1.lastInsertRowid;
        });
        const newId = await txn('__test_txn_commit');
        const row = await db.get(`SELECT name FROM competition WHERE id = ?`, newId);
        assert.strictEqual(row.name, '__test_txn_commit');
    });

    await test('에러 트랜잭션 ROLLBACK', async () => {
        let thrown = false;
        const txn = db.transaction(async () => {
            await db.run(
                `INSERT INTO competition (name, start_date, end_date, venue, status) VALUES (?, ?, ?, ?, ?)`,
                '__test_txn_rollback', '2026-09-01', '2026-09-02', '__rb_venue', 'upcoming'
            );
            throw new Error('intentional rollback');
        });
        try {
            await txn();
        } catch (e) {
            thrown = true;
            assert.strictEqual(e.message, 'intentional rollback');
        }
        assert.strictEqual(thrown, true, 'error must propagate');
        // rollback 확인
        const row = await db.get(`SELECT id FROM competition WHERE name = ?`, '__test_txn_rollback');
        assert.strictEqual(row, undefined, 'row must not exist after rollback');
    });

    // ─────────────────────────────────────────
    // 4. db.prepare() 안전망 (에러 throw 확인)
    // ─────────────────────────────────────────
    console.log('\n▶ Group 4: 안전망 (db.prepare는 PG에서 금지)');
    console.log('───────────────────────────────────────────────────────');

    await test('db.prepare() 호출 시 에러 throw', () => {
        let thrown = false;
        try {
            db.prepare('SELECT 1');
        } catch (e) {
            thrown = true;
            assert.ok(e.message.includes('not supported'));
        }
        assert.strictEqual(thrown, true);
    });

    // ─────────────────────────────────────────
    // 5. 동시 입력 부하 테스트 (소규모)
    // ─────────────────────────────────────────
    console.log('\n▶ Group 5: 동시 입력 부하 (10 동시 × 50건 = 500건)');
    console.log('───────────────────────────────────────────────────────');

    await test('500건 동시 INSERT 100% 성공', async () => {
        const startTs = Date.now();
        const promises = [];
        for (let worker = 0; worker < 10; worker++) {
            promises.push((async () => {
                let success = 0, errors = 0;
                for (let i = 0; i < 50; i++) {
                    try {
                        await db.run(
                            `INSERT INTO operation_log (competition_id, message, performed_by, category) VALUES (?, ?, ?, ?)`,
                            competitionId,
                            `__concurrent_test_w${worker}_i${i}`,
                            `worker_${worker}`,
                            '__test'
                        );
                        success++;
                    } catch (e) {
                        errors++;
                    }
                }
                return { success, errors };
            })());
        }
        const results = await Promise.all(promises);
        const totalSuccess = results.reduce((sum, r) => sum + r.success, 0);
        const totalErrors = results.reduce((sum, r) => sum + r.errors, 0);
        const elapsed = Date.now() - startTs;
        console.log(`     500건 / ${elapsed}ms / 성공=${totalSuccess} 에러=${totalErrors}`);
        assert.strictEqual(totalSuccess, 500);
        assert.strictEqual(totalErrors, 0);
    });

    // ─────────────────────────────────────────
    // 청소
    // ─────────────────────────────────────────
    await db.exec(`DELETE FROM operation_log WHERE category = '__test'`);
    await db.exec(`DELETE FROM operation_log WHERE message LIKE '__concurrent_test_%'`);
    await db.exec(`DELETE FROM operation_log WHERE message = 'what?'`);
    await db.exec(`DELETE FROM operation_log WHERE message = '__test_message'`);
    await db.exec(`DELETE FROM event WHERE competition_id IN (SELECT id FROM competition WHERE name LIKE '__test_%')`);
    await db.exec(`DELETE FROM competition WHERE name LIKE '__test_%'`);

    // ─────────────────────────────────────────
    // 결과
    // ─────────────────────────────────────────
    console.log('\n═══════════════════════════════════════════════════════');
    console.log(`  최종: ${pass} pass / ${fail} fail`);
    console.log('═══════════════════════════════════════════════════════');

    await db.close();
    process.exit(fail > 0 ? 1 : 0);
})();
