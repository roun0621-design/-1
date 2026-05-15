#!/usr/bin/env node
/**
 * Phase 2-C: SQLite → PostgreSQL 데이터 이관
 * ==========================================
 *
 * 목적:
 *   실 운영 SQLite DB의 모든 데이터를 PostgreSQL로 안전하게 이관.
 *
 * 동작:
 *   1) PG 측 모든 테이블 데이터 비우기 (TRUNCATE ... CASCADE)
 *   2) FK 순서를 고려해 부모 테이블부터 INSERT
 *   3) IDENTITY 컬럼은 명시적 id 값 보존 (OVERRIDING SYSTEM VALUE)
 *   4) 시퀀스 재설정 (max(id)+1) — 향후 새 INSERT 시 충돌 방지
 *   5) row count 검증 (SQLite vs PostgreSQL)
 *
 * 사용법:
 *   DATABASE_URL=postgres://user:pw@host:5432/dbname \
 *   node scripts/migrate_sqlite_to_postgres.js [옵션]
 *
 * 옵션:
 *   --sqlite PATH   소스 SQLite DB (기본: ./db/competition.db)
 *   --truncate      이관 전 PG 테이블 비우기 (기본 ON, --no-truncate 로 끄기)
 *   --no-truncate   비우기 끄기 (기존 데이터 보존, 신규만 추가)
 *   --batch N       배치 크기 (기본 500)
 *   --dry-run       실제 INSERT 안 함, 계획만 출력
 *   --tables LIST   특정 테이블만 (쉼표 구분)
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { Pool } = require('pg');

// ─────────────────────────────────────────
// 인자 파싱
// ─────────────────────────────────────────
const args = process.argv.slice(2);
function argVal(name, dflt) {
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
}
const SQLITE_PATH = argVal('--sqlite', path.join(__dirname, '..', 'db', 'competition.db'));
const BATCH_SIZE = parseInt(argVal('--batch', '500'), 10);
const DRY_RUN = args.includes('--dry-run');
const TRUNCATE = !args.includes('--no-truncate');
const ONLY_TABLES = argVal('--tables', '').split(',').filter(Boolean);

if (!process.env.DATABASE_URL) {
    console.error('[ERROR] DATABASE_URL 환경변수 필수');
    console.error('  예: DATABASE_URL=postgres://pacerise:pw@localhost:5432/pacerise node scripts/migrate_sqlite_to_postgres.js');
    process.exit(1);
}
if (!fs.existsSync(SQLITE_PATH)) {
    console.error(`[ERROR] SQLite DB 없음: ${SQLITE_PATH}`);
    process.exit(1);
}

console.log('═══════════════════════════════════════════════════════');
console.log('  SQLite → PostgreSQL 데이터 이관');
console.log('═══════════════════════════════════════════════════════');
console.log(`  source     : ${SQLITE_PATH}`);
console.log(`  target     : ${process.env.DATABASE_URL.replace(/:[^:@]*@/, ':***@')}`);
console.log(`  truncate   : ${TRUNCATE}`);
console.log(`  batch size : ${BATCH_SIZE}`);
console.log(`  dry run    : ${DRY_RUN}`);
if (ONLY_TABLES.length) console.log(`  tables     : ${ONLY_TABLES.join(', ')}`);
console.log('───────────────────────────────────────────────────────\n');

// ─────────────────────────────────────────
// 연결
// ─────────────────────────────────────────
const sqlite = new Database(SQLITE_PATH, { readonly: true });
const pgPool = new Pool({ connectionString: process.env.DATABASE_URL });

// ─────────────────────────────────────────
// FK 의존 순서 계산 (위상정렬)
// ─────────────────────────────────────────
function topoSortTables() {
    const tables = sqlite.prepare(`
        SELECT name FROM sqlite_master
        WHERE type='table'
          AND name NOT LIKE 'sqlite_%'
        ORDER BY name
    `).all().map(r => r.name);

    // 각 테이블의 FK 부모 목록
    const deps = {};
    for (const t of tables) {
        const fks = sqlite.prepare(`PRAGMA foreign_key_list(${t})`).all();
        deps[t] = new Set();
        for (const fk of fks) {
            if (fk.table !== t) deps[t].add(fk.table);  // 자기참조 무시
        }
    }

    const sorted = [];
    const visited = new Set();
    function visit(t) {
        if (visited.has(t)) return;
        visited.add(t);
        for (const dep of (deps[t] || new Set())) {
            if (tables.includes(dep)) visit(dep);
        }
        sorted.push(t);
    }
    for (const t of tables) visit(t);
    return sorted;
}

const orderedTables = topoSortTables();
let workTables = ONLY_TABLES.length
    ? orderedTables.filter(t => ONLY_TABLES.includes(t))
    : orderedTables;
console.log('이관 순서 (FK 의존 위상정렬):');
console.log('  ' + workTables.join(' → '));
console.log();

// ─────────────────────────────────────────
// 헬퍼: PG identity 컬럼 알아내기
// ─────────────────────────────────────────
async function getIdentityColumns(client, tableName) {
    const res = await client.query(`
        SELECT column_name, is_identity, identity_generation
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
    `, [tableName]);
    return res.rows
        .filter(r => r.is_identity === 'YES')
        .map(r => r.column_name);
}

// ─────────────────────────────────────────
// 헬퍼: 시퀀스 이름 알아내기
// ─────────────────────────────────────────
async function getSequenceName(client, tableName, columnName) {
    const res = await client.query(
        `SELECT pg_get_serial_sequence($1, $2) AS seq`,
        [tableName, columnName]
    );
    return res.rows[0] && res.rows[0].seq;
}

// ─────────────────────────────────────────
// 한 테이블 이관
// ─────────────────────────────────────────
async function migrateTable(client, tableName) {
    // PG 측 컬럼 정보
    const colRes = await client.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position
    `, [tableName]);
    const pgColumns = colRes.rows.map(r => r.column_name);
    if (pgColumns.length === 0) {
        return { table: tableName, status: 'skip', reason: 'no columns in PG' };
    }

    // SQLite 측 컬럼 (있는 것만 가져옴)
    const sqliteCols = sqlite.prepare(`PRAGMA table_info(${tableName})`).all().map(c => c.name);
    const commonCols = pgColumns.filter(c => sqliteCols.includes(c));
    if (commonCols.length === 0) {
        return { table: tableName, status: 'skip', reason: 'no common columns' };
    }
    const missingInSqlite = pgColumns.filter(c => !sqliteCols.includes(c));
    if (missingInSqlite.length) {
        // PG 에는 있는데 SQLite에 없는 컬럼은 DEFAULT 로 채워지므로 OK, 다만 노티만.
    }

    // SQLite 데이터 읽기
    const colList = commonCols.map(c => `"${c}"`).join(', ');
    const sourceRows = sqlite.prepare(`SELECT ${colList} FROM "${tableName}"`).all();

    if (sourceRows.length === 0) {
        return { table: tableName, status: 'empty', rows: 0 };
    }

    if (DRY_RUN) {
        return { table: tableName, status: 'dry-run', rows: sourceRows.length, cols: commonCols.length };
    }

    // PG identity 컬럼
    const identityCols = await getIdentityColumns(client, tableName);
    const hasIdentity = identityCols.length > 0;

    // INSERT 문 작성 (배치)
    const colInsert = commonCols.map(c => `"${c}"`).join(', ');
    let inserted = 0;

    for (let i = 0; i < sourceRows.length; i += BATCH_SIZE) {
        const batch = sourceRows.slice(i, i + BATCH_SIZE);
        const values = [];
        const params = [];
        let pIdx = 1;
        for (const row of batch) {
            const placeholders = commonCols.map(c => {
                params.push(normalizeValue(row[c]));
                return `$${pIdx++}`;
            });
            values.push(`(${placeholders.join(', ')})`);
        }

        // OVERRIDING SYSTEM VALUE 로 identity 값 강제 보존
        const sql = `INSERT INTO "${tableName}" (${colInsert}) ${hasIdentity ? 'OVERRIDING SYSTEM VALUE ' : ''}VALUES ${values.join(', ')}`;
        await client.query(sql, params);
        inserted += batch.length;
    }

    // 시퀀스 재설정 (다음 id가 max(id)+1이 되도록)
    if (hasIdentity) {
        for (const idCol of identityCols) {
            const seqName = await getSequenceName(client, tableName, idCol);
            if (seqName) {
                await client.query(
                    `SELECT setval($1, (SELECT COALESCE(MAX("${idCol}"), 0) FROM "${tableName}") + 1, false)`,
                    [seqName]
                );
            }
        }
    }

    return { table: tableName, status: 'ok', rows: inserted, cols: commonCols.length, identityCols };
}

function normalizeValue(v) {
    // better-sqlite3는 INTEGER를 number, TEXT를 string, NULL을 null로 반환
    // BLOB는 Buffer. PG pg 모듈은 Buffer를 bytea로 자동 변환.
    if (v === undefined) return null;
    // SQLite는 BOOLEAN 없음, INTEGER 0/1 → BIGINT 그대로
    return v;
}

// ─────────────────────────────────────────
// 메인
// ─────────────────────────────────────────
(async () => {
    const client = await pgPool.connect();
    const results = [];
    let errored = false;

    try {
        await client.query('BEGIN');

        // 1) TRUNCATE
        if (TRUNCATE && !DRY_RUN) {
            console.log('▶ Step 1: PG 테이블 비우기 (TRUNCATE CASCADE)');
            // 모든 테이블 한 번에 TRUNCATE CASCADE
            const allTables = workTables.map(t => `"${t}"`).join(', ');
            await client.query(`TRUNCATE ${allTables} RESTART IDENTITY CASCADE`);
            console.log(`  ✓ ${workTables.length} 테이블 비움\n`);
        } else if (DRY_RUN) {
            console.log('▶ Step 1: (dry-run) TRUNCATE 건너뜀\n');
        }

        // 2) 데이터 이관
        console.log('▶ Step 2: 데이터 이관');
        for (const t of workTables) {
            const r = await migrateTable(client, t);
            results.push(r);
            const status = r.status === 'ok'
                ? `✓ ${String(r.rows).padStart(6)} rows`
                : r.status === 'empty'
                    ? '· (empty)'
                    : r.status === 'dry-run'
                        ? `~ ${String(r.rows).padStart(6)} rows`
                        : `! ${r.reason}`;
            console.log(`  ${t.padEnd(30)} ${status}`);
        }
        console.log();

        if (DRY_RUN) {
            await client.query('ROLLBACK');
            console.log('▶ Step 3: dry-run 모드 — ROLLBACK 완료');
        } else {
            await client.query('COMMIT');
            console.log('▶ Step 3: COMMIT 완료');
        }

    } catch (e) {
        errored = true;
        await client.query('ROLLBACK');
        console.error('\n❌ 이관 실패, ROLLBACK 수행됨');
        console.error('  message:', e.message);
        if (e.detail) console.error('  detail :', e.detail);
        if (e.query) console.error('  query  :', e.query.substring(0, 200));
    } finally {
        client.release();
    }

    // 3) 검증
    if (!errored && !DRY_RUN) {
        console.log('\n▶ Step 4: row count 검증');
        const verify = await pgPool.connect();
        try {
            let pass = 0, fail = 0;
            for (const t of workTables) {
                const sqliteCnt = sqlite.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n;
                const pgRes = await verify.query(`SELECT COUNT(*)::int AS n FROM "${t}"`);
                const pgCnt = pgRes.rows[0].n;
                const ok = sqliteCnt === pgCnt;
                if (ok) pass++; else fail++;
                const mark = ok ? '✓' : '✗';
                console.log(`  ${mark} ${t.padEnd(30)} sqlite=${String(sqliteCnt).padStart(6)}  pg=${String(pgCnt).padStart(6)}`);
            }
            console.log(`\n  결과: ${pass} pass / ${fail} fail`);
            if (fail > 0) errored = true;
        } finally {
            verify.release();
        }
    }

    sqlite.close();
    await pgPool.end();

    console.log('\n═══════════════════════════════════════════════════════');
    console.log(errored ? '  ❌ 실패' : '  ✅ 성공');
    console.log('═══════════════════════════════════════════════════════');
    process.exit(errored ? 1 : 0);
})();
