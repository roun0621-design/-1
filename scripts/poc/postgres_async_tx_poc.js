// PG 어댑터의 async transaction이 SQLite 어댑터와 동일한 시그니처/결과를 내는지 검증
const path = require('path');

process.env.DB_BACKEND = 'postgres';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://pacerise:pacerise_test_pw@localhost:5432/pacerise_test';

const { getDb, _resetForTest } = require(path.resolve(__dirname, '..', '..', 'lib', 'db.js'));
_resetForTest();
const db = getDb();

async function setup() {
    await db.exec(`CREATE TABLE IF NOT EXISTS tx_poc_t (id SERIAL PRIMARY KEY, v INTEGER)`);
    await db.run('DELETE FROM tx_poc_t');
}

async function countRows() {
    const r = await db.get('SELECT COUNT(*)::int AS c FROM tx_poc_t');
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

    console.log('\n[Test 1] sync callback');
    {
        await setup();
        const txn = db.transaction(() => {
            // PG 백엔드는 async fn 가정이지만 sync도 통과해야 (return type relaxed)
            return Promise.all([
                db.run('INSERT INTO tx_poc_t (v) VALUES ($1)', 1),
                db.run('INSERT INTO tx_poc_t (v) VALUES ($1)', 2),
            ]);
        });
        await txn();
        const c = await countRows();
        check('2 rows inserted', c === 2, `(actual=${c})`);
    }

    console.log('\n[Test 2] async callback');
    {
        await setup();
        const txn = db.transaction(async () => {
            await db.run('INSERT INTO tx_poc_t (v) VALUES ($1)', 10);
            await db.run('INSERT INTO tx_poc_t (v) VALUES ($1)', 11);
            const c = (await db.get('SELECT COUNT(*)::int AS c FROM tx_poc_t')).c;
            check('inside-tx count=2', c === 2, `(actual=${c})`);
        });
        await txn();
        check('after-commit count=2', (await countRows()) === 2);
    }

    console.log('\n[Test 3] error → ROLLBACK');
    {
        await setup();
        const txn = db.transaction(async () => {
            await db.run('INSERT INTO tx_poc_t (v) VALUES ($1)', 100);
            throw new Error('boom');
        });
        try {
            await txn();
            check('error propagated', false, '(no error)');
        } catch (e) { check('error propagated', e.message === 'boom'); }
        const c = await countRows();
        check('rollback: count=0', c === 0, `(actual=${c})`);
    }

    console.log('\n[Test 4] args + return');
    {
        await setup();
        const txn = db.transaction(async (a, b) => {
            await db.run('INSERT INTO tx_poc_t (v) VALUES ($1)', a);
            await db.run('INSERT INTO tx_poc_t (v) VALUES ($1)', b);
            return a + b;
        });
        const r = await txn(7, 8);
        check('return value', r === 15);
        check('2 rows', (await countRows()) === 2);
    }

    console.log('\n[Test 5] sequential tx');
    {
        await setup();
        await db.transaction(async () => { await db.run('INSERT INTO tx_poc_t (v) VALUES ($1)', 1); })();
        await db.transaction(async () => { await db.run('INSERT INTO tx_poc_t (v) VALUES ($1)', 2); })();
        check('2 rows after 2 tx', (await countRows()) === 2);
    }

    await db.exec('DROP TABLE IF EXISTS tx_poc_t');
    console.log(`\n=== Result: ${pass}/${pass+fail} ===`);
    await db.close();
    process.exit(fail === 0 ? 0 : 1);
}

run().catch(e => { console.error('FATAL:', e); process.exit(1); });
