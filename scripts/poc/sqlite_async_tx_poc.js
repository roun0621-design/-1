// lib/db.js SQLite 어댑터의 async transaction 동작 검증
const path = require('path');
const fs = require('fs');

// 별도 임시 DB로 테스트
const TEST_DB = path.join(__dirname, 'tx_poc.db');
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

process.env.DB_BACKEND = 'sqlite';
process.env.DB_PATH = TEST_DB;
// 스키마/시드 자동 로드 끄기 (poc 전용 테이블만 쓸 거라서)
process.env.SCHEMA_PATH_OVERRIDE = '/nonexistent';

// lib/db.js는 SCHEMA_PATH가 없으면 빈 DB 만든다
const dbModulePath = path.resolve(__dirname, '..', '..', 'lib', 'db.js');
const { getDb } = require(dbModulePath);
const db = getDb();

async function setup() {
    await db.exec(`CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY AUTOINCREMENT, v INTEGER)`);
    await db.run('DELETE FROM t');
}

async function countRows() {
    const r = await db.get('SELECT COUNT(*) AS c FROM t');
    return r.c;
}

async function run() {
    await setup();
    console.log('Backend:', db.getBackendName());
    console.log('isAsync:', db.isAsync);
    let pass = 0, fail = 0;
    const check = (label, ok, detail='') => {
        if (ok) { console.log(`  ✓ ${label}`); pass++; }
        else    { console.log(`  ✗ ${label} ${detail}`); fail++; }
    };

    // -------- Test 1: sync(=non-async) 콜백 ----------
    console.log('\n[Test 1] sync callback (BEGIN/COMMIT)');
    {
        await setup();
        const txn = db.transaction(() => {
            db.run('INSERT INTO t (v) VALUES (?)', 1);
            db.run('INSERT INTO t (v) VALUES (?)', 2);
        });
        await txn();
        const c = await countRows();
        check('2 rows inserted', c === 2, `(actual=${c})`);
    }

    // -------- Test 2: async 콜백 ----------
    console.log('\n[Test 2] async callback (BEGIN/COMMIT)');
    {
        await setup();
        const txn = db.transaction(async () => {
            await db.run('INSERT INTO t (v) VALUES (?)', 10);
            await db.run('INSERT INTO t (v) VALUES (?)', 11);
            const c = (await db.get('SELECT COUNT(*) AS c FROM t')).c;
            check('inside-tx count=2', c === 2, `(actual=${c})`);
        });
        await txn();
        const c = await countRows();
        check('after-commit count=2', c === 2, `(actual=${c})`);
    }

    // -------- Test 3: 에러 시 롤백 ----------
    console.log('\n[Test 3] async callback throws → ROLLBACK');
    {
        await setup();
        const txn = db.transaction(async () => {
            await db.run('INSERT INTO t (v) VALUES (?)', 100);
            throw new Error('boom');
        });
        try {
            await txn();
            check('error propagated', false, '(no error thrown)');
        } catch (e) {
            check('error propagated', e.message === 'boom');
        }
        const c = await countRows();
        check('rollback: count=0', c === 0, `(actual=${c})`);
    }

    // -------- Test 4: 인자 전달 ----------
    console.log('\n[Test 4] argument passing');
    {
        await setup();
        const txn = db.transaction(async (a, b) => {
            await db.run('INSERT INTO t (v) VALUES (?)', a);
            await db.run('INSERT INTO t (v) VALUES (?)', b);
            return a + b;
        });
        const r = await txn(7, 8);
        check('return value', r === 15, `(actual=${r})`);
        const c = await countRows();
        check('2 rows', c === 2);
    }

    // -------- Test 5: 중첩(연속) 트랜잭션 ----------
    console.log('\n[Test 5] sequential transactions');
    {
        await setup();
        await db.transaction(async () => {
            await db.run('INSERT INTO t (v) VALUES (?)', 1);
        })();
        await db.transaction(async () => {
            await db.run('INSERT INTO t (v) VALUES (?)', 2);
        })();
        const c = await countRows();
        check('2 rows after 2 tx', c === 2, `(actual=${c})`);
    }

    console.log(`\n=== Result: ${pass}/${pass+fail} ===`);
    await db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    process.exit(fail === 0 ? 0 : 1);
}

run().catch(e => { console.error('FATAL:', e); process.exit(1); });
