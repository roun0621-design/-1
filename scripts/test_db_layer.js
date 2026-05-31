/**
 * Phase 2-A 검증 테스트
 * ========================
 * 1) convertSqlForPostgres() 단위 테스트
 * 2) SQLite 어댑터 backward compat (기존 코드 그대로 동작하는지)
 * 3) lib/db.js 모듈 로딩 정상성
 */
const assert = require('assert');

console.log('═══════════════════════════════════════════════════════');
console.log('  Phase 2-A: lib/db.js 검증 테스트');
console.log('═══════════════════════════════════════════════════════\n');

// ──────────────────────────────────────────────────────────────
// 1. convertSqlForPostgres() 단위 테스트
// ──────────────────────────────────────────────────────────────
console.log('▶ Test Group 1: convertSqlForPostgres() SQL 변환');
console.log('───────────────────────────────────────────────────────');

const { _convertSql } = require('../lib/db');

let pass = 0, fail = 0;
function test(name, actual, expected) {
    const ok = actual === expected;
    if (ok) {
        pass++;
        console.log(`  ✅ ${name}`);
    } else {
        fail++;
        console.log(`  ❌ ${name}`);
        console.log(`     expected: ${JSON.stringify(expected)}`);
        console.log(`     actual:   ${JSON.stringify(actual)}`);
    }
}

// 1-A. ? → $N
test('단일 ? placeholder',
    _convertSql('SELECT * FROM athlete WHERE id = ?'),
    'SELECT * FROM athlete WHERE id = $1'
);

test('여러 ? placeholder',
    _convertSql('SELECT * FROM result WHERE event_id = ? AND athlete_id = ?'),
    'SELECT * FROM result WHERE event_id = $1 AND athlete_id = $2'
);

test('INSERT 다중 placeholder',
    _convertSql('INSERT INTO athlete (name, gender, birth) VALUES (?, ?, ?)'),
    'INSERT INTO athlete (name, gender, birth) VALUES ($1, $2, $3)'
);

// 1-B. 문자열 리터럴 안의 ? 보존
test('문자열 내부 ? 보존',
    _convertSql("SELECT * FROM athlete WHERE name = 'who?' AND id = ?"),
    "SELECT * FROM athlete WHERE name = 'who?' AND id = $1"
);

test('escape된 작은따옴표 처리',
    _convertSql("SELECT * FROM x WHERE name = 'O''Brien' AND id = ?"),
    "SELECT * FROM x WHERE name = 'O''Brien' AND id = $1"
);

// 1-C. datetime('now') → NOW()
test("datetime('now') 변환",
    _convertSql("INSERT INTO log (msg, ts) VALUES (?, datetime('now'))"),
    "INSERT INTO log (msg, ts) VALUES ($1, NOW())"
);

test('datetime("now") 변환 (큰따옴표)',
    _convertSql('INSERT INTO log (ts) VALUES (datetime("now"))'),
    'INSERT INTO log (ts) VALUES (NOW())'
);

// 1-D. INSERT OR IGNORE → ON CONFLICT DO NOTHING
test('INSERT OR IGNORE 변환',
    _convertSql('INSERT OR IGNORE INTO event_record (event_id, athlete_id) VALUES (?, ?)'),
    'INSERT INTO event_record (event_id, athlete_id) VALUES ($1, $2) ON CONFLICT DO NOTHING'
);

test('INSERT OR IGNORE + 세미콜론',
    _convertSql('INSERT OR IGNORE INTO x (a) VALUES (?);'),
    'INSERT INTO x (a) VALUES ($1) ON CONFLICT DO NOTHING'
);

// 1-E. INSERT OR REPLACE → INSERT (호출자가 ON CONFLICT 명시해야 함)
test('INSERT OR REPLACE → INSERT (수동 ON CONFLICT 필요)',
    _convertSql('INSERT OR REPLACE INTO x (id, val) VALUES (?, ?)'),
    'INSERT INTO x (id, val) VALUES ($1, $2)'
);

// 1-F. 일반 SELECT/UPDATE/DELETE
test('UPDATE 변환',
    _convertSql('UPDATE athlete SET name = ? WHERE id = ?'),
    'UPDATE athlete SET name = $1 WHERE id = $2'
);

test('DELETE 변환',
    _convertSql('DELETE FROM heat_entry WHERE heat_id = ?'),
    'DELETE FROM heat_entry WHERE heat_id = $1'
);

// 1-G. placeholder 없는 SQL은 변형 없이
test('placeholder 없는 SELECT',
    _convertSql('SELECT COUNT(*) FROM athlete'),
    'SELECT COUNT(*) FROM athlete'
);

test('CREATE TABLE은 그대로 통과',
    _convertSql('CREATE TABLE x (id INTEGER)'),
    'CREATE TABLE x (id INTEGER)'
);

// 1-H. 복합 케이스
test('복합: INSERT OR IGNORE + datetime + 문자열 내 ?',
    _convertSql("INSERT OR IGNORE INTO log (msg, ts) VALUES ('what?', datetime('now'))"),
    "INSERT INTO log (msg, ts) VALUES ('what?', NOW()) ON CONFLICT DO NOTHING"
);

console.log(`\n  결과: ${pass} pass / ${fail} fail\n`);

// ──────────────────────────────────────────────────────────────
// 2. SQLite 어댑터 backward compat 테스트
// ──────────────────────────────────────────────────────────────
console.log('▶ Test Group 2: SQLite 어댑터 백워드 호환');
console.log('───────────────────────────────────────────────────────');

// 명시적으로 DB_BACKEND=sqlite (기본값이지만 명확히)
process.env.DB_BACKEND = 'sqlite';

const { getDb, _resetForTest } = require('../lib/db');
_resetForTest();

let sqlitePass = 0, sqliteFail = 0;
function sqliteTest(name, fn) {
    try {
        fn();
        sqlitePass++;
        console.log(`  ✅ ${name}`);
    } catch (e) {
        sqliteFail++;
        console.log(`  ❌ ${name}: ${e.message}`);
    }
}

const db = getDb();

sqliteTest('백엔드 이름', () => {
    assert.strictEqual(db.getBackendName(), 'sqlite');
});

sqliteTest('isAsync = false', () => {
    assert.strictEqual(db.isAsync, false);
});

sqliteTest('raw 핸들 노출', () => {
    assert.ok(db.raw);
    assert.strictEqual(typeof db.raw.prepare, 'function');
});

sqliteTest('db.prepare()로 SELECT 작동', () => {
    const row = db.prepare('SELECT 1 AS x').get();
    assert.strictEqual(row.x, 1);
});

sqliteTest('db.get() 헬퍼 작동', () => {
    const row = db.get('SELECT 1 AS x');
    assert.strictEqual(row.x, 1);
});

sqliteTest('db.all() 헬퍼 작동', () => {
    const rows = db.all('SELECT 1 AS x UNION SELECT 2');
    assert.strictEqual(rows.length, 2);
});

sqliteTest('db.get(sql, ...params) 가변 인자 작동', () => {
    const row = db.get('SELECT ? AS x', 42);
    assert.strictEqual(row.x, 42);
});

sqliteTest('db.get(sql, [params]) 배열 형태도 작동', () => {
    const row = db.get('SELECT ? AS x', [42]);
    assert.strictEqual(row.x, 42);
});

sqliteTest('db.pragma() 작동', () => {
    const result = db.pragma('busy_timeout');
    // busy_timeout=5000으로 설정했으니
    assert.ok(Array.isArray(result) || typeof result === 'number');
});

sqliteTest('busy_timeout PRAGMA 적용 확인 (5000ms)', () => {
    // raw.pragma 직접 호출 (simple 옵션 사용)
    const result = db.raw.pragma('busy_timeout', { simple: true });
    assert.strictEqual(result, 5000);
});

sqliteTest('competition 테이블 존재 확인 (스키마 로드)', () => {
    const row = db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name='competition'`);
    assert.ok(row, 'competition 테이블 없음');
});

// db.transaction() / 싱글톤 / 최종 요약 — Phase 2-G 이후 트랜잭션이 async로 통일됐기 때문에
// 이 뒤의 로직 전체를 async IIFE 안에서 직렬 실행 (출력 순서 보장)
let singletonPass = 0, singletonFail = 0;

(async () => {
    // ── db.transaction() 작동 (async 시그니처) ──
    try {
        const txn = db.transaction(async () => {
            return db.get('SELECT 1 AS x').x;
        });
        const r = await txn();
        assert.strictEqual(r, 1);
        sqlitePass++;
        console.log('  ✅ db.transaction() async 작동');
    } catch (e) {
        sqliteFail++;
        console.log(`  ❌ db.transaction() async 작동: ${e.message}`);
    }
    console.log(`\n  결과: ${sqlitePass} pass / ${sqliteFail} fail\n`);

    // ── 3. 싱글톤 동작 확인 ──
    console.log('▶ Test Group 3: getDb() 싱글톤 동작');
    console.log('───────────────────────────────────────────────────────');
    try {
        const db1 = getDb();
        const db2 = getDb();
        assert.strictEqual(db1, db2, '같은 인스턴스여야 함');
        singletonPass++;
        console.log('  ✅ getDb() 두 번 호출 시 같은 인스턴스 반환');
    } catch (e) {
        singletonFail++;
        console.log(`  ❌ 싱글톤 검증 실패: ${e.message}`);
    }
    console.log(`\n  결과: ${singletonPass} pass / ${singletonFail} fail\n`);

    // ── 최종 요약 ──
    const totalPass = pass + sqlitePass + singletonPass;
    const totalFail = fail + sqliteFail + singletonFail;

    console.log('═══════════════════════════════════════════════════════');
    console.log(`  최종: ${totalPass} pass / ${totalFail} fail`);
    console.log('═══════════════════════════════════════════════════════');

    try { db.close(); } catch(e) {}

    if (totalFail === 0) {
        console.log('\n✅ Phase 2-A 검증 통과');
        process.exit(0);
    } else {
        process.exit(1);
    }
})();
