#!/usr/bin/env node
/**
 * Phase 2-B: SQLite → PostgreSQL 스키마 변환기
 * ============================================
 *
 * 목적:
 *   실제 운영 중인 SQLite DB를 introspection해서 PostgreSQL용 schema.pg.sql 생성.
 *   schema.sql + server.js의 ALTER TABLE 런타임 마이그레이션 + 백업 자동 정리 결과까지
 *   모두 반영된 "현재 살아있는 스키마"를 기준으로 변환한다.
 *
 * 변환 규칙:
 *   - INTEGER PRIMARY KEY AUTOINCREMENT  → BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY
 *   - INTEGER PRIMARY KEY                → BIGINT PRIMARY KEY
 *   - TEXT                               → TEXT
 *   - REAL                               → DOUBLE PRECISION
 *   - INTEGER                            → BIGINT
 *   - BLOB                               → BYTEA
 *   - DEFAULT (datetime('now'))          → DEFAULT NOW()
 *   - DEFAULT CURRENT_TIMESTAMP          → DEFAULT NOW()
 *   - CHECK(... IN ('a','b'))            → 그대로 사용 (PG 호환)
 *   - REFERENCES x(id)                   → 그대로 사용
 *   - UNIQUE(...)                        → 그대로 사용
 *   - ON DELETE CASCADE                  → 그대로 사용
 *
 * 출력: db/schema.pg.sql
 *
 * 사용법:
 *   node scripts/sqlite_to_postgres_schema.js [--db path] [--out path]
 *
 *   --db PATH    SQLite DB 경로 (기본: ./db/competition.db)
 *   --out PATH   출력 경로 (기본: ./db/schema.pg.sql)
 *   --dry-run    파일에 쓰지 않고 stdout으로만 출력
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// ──────────────────────────────────────────────
// 인자 파싱
// ──────────────────────────────────────────────
const args = process.argv.slice(2);
function argVal(name, dflt) {
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
}
const DB_PATH = argVal('--db', path.join(__dirname, '..', 'db', 'competition.db'));
const OUT_PATH = argVal('--out', path.join(__dirname, '..', 'db', 'schema.pg.sql'));
const DRY_RUN = args.includes('--dry-run');

if (!fs.existsSync(DB_PATH)) {
    console.error(`[ERROR] SQLite DB not found: ${DB_PATH}`);
    process.exit(1);
}

// ──────────────────────────────────────────────
// SQLite introspection
// ──────────────────────────────────────────────
const db = new Database(DB_PATH, { readonly: true });

const tables = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='table'
      AND name NOT LIKE 'sqlite_%'
      AND name NOT LIKE '_litestream%'
    ORDER BY name
`).all().map(r => r.name);

const indexes = db.prepare(`
    SELECT name, tbl_name, sql FROM sqlite_master
    WHERE type='index'
      AND sql IS NOT NULL
      AND name NOT LIKE 'sqlite_%'
    ORDER BY tbl_name, name
`).all();

console.log(`[scan] ${tables.length} tables, ${indexes.length} indexes found in ${DB_PATH}`);

// ──────────────────────────────────────────────
// 실데이터 샘플링 기반 타입 추론
// SQLite는 컬럼 선언 타입과 실제 저장 타입이 다를 수 있다 (storage class affinity).
// 운영 데이터의 실제 타입을 확인해 선언과 충돌하면 보수적으로 TEXT 처리.
// ──────────────────────────────────────────────
function inferActualType(tableName, columnName, declaredType) {
    try {
        const rows = db.prepare(
            `SELECT "${columnName}" AS v FROM "${tableName}" WHERE "${columnName}" IS NOT NULL LIMIT 200`
        ).all();
        if (rows.length === 0) return null;

        let hasString = false, hasNumber = false, hasBuffer = false;
        for (const r of rows) {
            const v = r.v;
            if (v === null) continue;
            if (typeof v === 'string') hasString = true;
            else if (typeof v === 'number') hasNumber = true;
            else if (Buffer.isBuffer(v)) hasBuffer = true;
        }

        // 선언이 숫자형(REAL/INTEGER)인데 실데이터에 문자열이 섞여있으면 → TEXT 다운그레이드
        const decl = (declaredType || '').toUpperCase();
        const isNumericDecl = decl === 'REAL' || decl === 'FLOAT' || decl === 'DOUBLE' || decl === 'INTEGER' || decl === 'NUMERIC';
        if (isNumericDecl && hasString) {
            console.warn(`[infer] ${tableName}.${columnName}: declared ${decl} but contains strings → downgrade to TEXT`);
            return 'TEXT_OVERRIDE';
        }
        if (hasBuffer) return 'BYTEA_OVERRIDE';
        return null;
    } catch (e) {
        return null;
    }
}

// ──────────────────────────────────────────────
// 컬럼 타입 변환
// ──────────────────────────────────────────────
function convertType(sqliteType, isPrimaryKey, isAutoincrement) {
    const t = (sqliteType || '').trim().toUpperCase();

    // 정수형 + PRIMARY KEY AUTOINCREMENT → IDENTITY
    if (isAutoincrement) {
        return 'BIGINT GENERATED ALWAYS AS IDENTITY';
    }
    if (isPrimaryKey && (t === 'INTEGER' || t === '')) {
        return 'BIGINT';
    }

    if (t === '' || t === 'INTEGER') return 'BIGINT';
    if (t === 'TEXT' || t.startsWith('VARCHAR') || t.startsWith('CHAR') || t === 'CLOB') return 'TEXT';
    if (t === 'REAL' || t === 'FLOAT' || t === 'DOUBLE' || t === 'DOUBLE PRECISION') return 'DOUBLE PRECISION';
    if (t === 'NUMERIC' || t.startsWith('DECIMAL') || t.startsWith('NUMERIC')) return 'NUMERIC';
    if (t === 'BLOB') return 'BYTEA';
    if (t === 'BOOLEAN' || t === 'BOOL') return 'BOOLEAN';
    if (t === 'DATE') return 'DATE';
    if (t === 'DATETIME' || t === 'TIMESTAMP') return 'TIMESTAMP';

    // 알 수 없는 타입은 TEXT로 보수적 처리
    console.warn(`[warn] unknown column type '${t}', fallback to TEXT`);
    return 'TEXT';
}

// DEFAULT 값 변환
function convertDefault(dflt) {
    if (dflt == null) return null;
    let v = String(dflt).trim();
    // datetime('now') → NOW()
    if (/^datetime\s*\(\s*['"]now['"]\s*\)$/i.test(v)) return 'NOW()';
    if (/^CURRENT_TIMESTAMP$/i.test(v)) return 'NOW()';
    if (/^CURRENT_DATE$/i.test(v)) return 'CURRENT_DATE';
    if (/^CURRENT_TIME$/i.test(v)) return 'CURRENT_TIME';
    return v;
}

// 외래키는 모든 테이블 생성 후 ALTER TABLE로 별도 추가 (순환/순서 의존 해소)
const deferredFks = [];

// ──────────────────────────────────────────────
// 한 테이블 CREATE 문 생성
// ──────────────────────────────────────────────
function emitTable(tableName) {
    const createSql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name = ?`).get(tableName).sql;

    // PRAGMA로 컬럼 정보 수집
    const cols = db.prepare(`PRAGMA table_info(${tableName})`).all();
    // PRAGMA로 외래키 정보
    const fks = db.prepare(`PRAGMA foreign_key_list(${tableName})`).all();
    // PRAGMA로 인덱스 정보 (UNIQUE 추출용)
    const idxList = db.prepare(`PRAGMA index_list(${tableName})`).all();
    // UNIQUE 자동 인덱스 + 명시적 UNIQUE
    const uniqueGroups = [];
    for (const idx of idxList) {
        if (idx.unique && idx.origin !== 'pk') {
            const cols2 = db.prepare(`PRAGMA index_info(${idx.name})`).all()
                .sort((a, b) => a.seqno - b.seqno)
                .map(c => `"${c.name}"`);
            if (cols2.length > 0) {
                uniqueGroups.push({ name: idx.name, origin: idx.origin, cols: cols2 });
            }
        }
    }

    // PRIMARY KEY 컬럼 (단일 컬럼 PK는 컬럼 정의에 inline)
    const pkCols = cols.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk);
    const singleColPk = pkCols.length === 1 ? pkCols[0] : null;

    // AUTOINCREMENT 감지 (원본 CREATE SQL에서 검색)
    const hasAutoincrement = /AUTOINCREMENT/i.test(createSql);

    const lines = [];
    lines.push(`CREATE TABLE IF NOT EXISTS "${tableName}" (`);

    const colDefs = [];
    for (const col of cols) {
        const isPK = col.pk > 0 && pkCols.length === 1;
        const isAuto = isPK && hasAutoincrement && /INTEGER/i.test(col.type);
        let pgType = convertType(col.type, isPK, isAuto);

        // 실데이터 기반 타입 오버라이드 (선언 vs 실제 불일치 처리)
        if (!isPK) {
            const inferred = inferActualType(tableName, col.name, col.type);
            if (inferred === 'TEXT_OVERRIDE') pgType = 'TEXT';
            else if (inferred === 'BYTEA_OVERRIDE') pgType = 'BYTEA';
        }

        let line = `    "${col.name}" ${pgType}`;
        if (isPK) line += ' PRIMARY KEY';
        if (col.notnull && !isPK) line += ' NOT NULL';

        const dflt = convertDefault(col.dflt_value);
        if (dflt !== null) {
            line += ` DEFAULT ${dflt}`;
        }
        colDefs.push(line);
    }

    // 복합 PK
    if (pkCols.length > 1) {
        const pkList = pkCols.map(c => `"${c.name}"`).join(', ');
        colDefs.push(`    PRIMARY KEY (${pkList})`);
    }

    // 외래키 — 테이블 생성 후 별도 ALTER TABLE 로 추가 (순서 의존 회피)
    const fkGroups = {};
    for (const fk of fks) {
        if (!fkGroups[fk.id]) fkGroups[fk.id] = { table: fk.table, from: [], to: [], on_delete: fk.on_delete, on_update: fk.on_update };
        fkGroups[fk.id].from.push(fk.from);
        fkGroups[fk.id].to.push(fk.to);
    }
    for (const fk of Object.values(fkGroups)) {
        deferredFks.push({ from_table: tableName, ...fk });
    }

    // CHECK 제약 — 원본 SQL에서 추출 (introspection으로는 못 가져옴)
    const checkPattern = /CHECK\s*\(\s*([^()]+(?:\([^()]*\)[^()]*)*)\s*\)/gi;
    const checkMatches = [...createSql.matchAll(checkPattern)];
    for (const m of checkMatches) {
        const expr = m[1].trim();
        // 컬럼 정의에 inline된 CHECK일 수 있지만, table-level로 두는 게 안전
        // 중복 방지 위해 동일 제약은 한 번만 add
        const checkLine = `    CHECK (${expr})`;
        if (!colDefs.includes(checkLine)) {
            colDefs.push(checkLine);
        }
    }

    // UNIQUE — 자동 생성된 (PRAGMA origin='u')만, 자동 PK는 제외
    for (const ug of uniqueGroups) {
        if (ug.origin === 'u') {
            colDefs.push(`    UNIQUE (${ug.cols.join(', ')})`);
        }
    }

    lines.push(colDefs.join(',\n'));
    lines.push(');');

    return { sql: lines.join('\n'), uniqueGroups };
}

// ──────────────────────────────────────────────
// 인덱스 변환
// ──────────────────────────────────────────────
function emitIndex(idx) {
    const sql = idx.sql || '';
    // SQLite: CREATE [UNIQUE] INDEX [IF NOT EXISTS] name ON table(col, ...)
    // PostgreSQL과 호환되지만, 따옴표 통일하고 IF NOT EXISTS 보장
    let pg = sql;

    // CREATE INDEX → CREATE INDEX IF NOT EXISTS
    if (!/IF\s+NOT\s+EXISTS/i.test(pg)) {
        pg = pg.replace(/CREATE\s+(UNIQUE\s+)?INDEX\s+/i, (m, unique) => {
            return `CREATE ${unique || ''}INDEX IF NOT EXISTS `;
        });
    }

    // datetime('now') 등 함수형 인덱스 변환 (있을 경우)
    pg = pg.replace(/datetime\s*\(\s*['"]now['"]\s*\)/gi, 'NOW()');

    // 세미콜론 보장
    pg = pg.trim();
    if (!pg.endsWith(';')) pg += ';';

    return pg;
}

// ──────────────────────────────────────────────
// 전체 schema.pg.sql 생성
// ──────────────────────────────────────────────
const output = [];
output.push('-- ============================================================');
output.push('-- Pace Rise Competition OS — PostgreSQL Schema');
output.push(`-- Auto-generated from SQLite by scripts/sqlite_to_postgres_schema.js`);
output.push(`-- Source: ${DB_PATH}`);
output.push(`-- Generated: ${new Date().toISOString()}`);
output.push('-- ============================================================');
output.push('');
// FK는 ALTER TABLE 로 후처리하므로 별도 SET 불필요
output.push('-- (외래키는 모든 테이블 생성 후 ALTER TABLE로 추가, 순서 의존 없음)');
output.push('');

const tableStats = [];
for (const t of tables) {
    try {
        const { sql, uniqueGroups } = emitTable(t);
        output.push(`-- Table: ${t}`);
        output.push(sql);
        output.push('');
        tableStats.push({ name: t, uniques: uniqueGroups.length });
    } catch (e) {
        console.error(`[ERROR] failed to emit table ${t}:`, e.message);
        output.push(`-- ERROR: failed to emit table ${t}: ${e.message}`);
    }
}

output.push('-- ============================================================');
output.push('-- Foreign Keys (deferred — added after all tables exist)');
output.push('-- ============================================================');
output.push('');
let fkCount = 0;
for (const fk of deferredFks) {
    const fromList = fk.from.map(c => `"${c}"`).join(', ');
    const toList = fk.to.map(c => `"${c}"`).join(', ');
    const constraintName = `fk_${fk.from_table}_${fk.from.join('_')}`;
    let line = `ALTER TABLE "${fk.from_table}" ADD CONSTRAINT "${constraintName}" FOREIGN KEY (${fromList}) REFERENCES "${fk.table}" (${toList})`;
    if (fk.on_delete && fk.on_delete !== 'NO ACTION') line += ` ON DELETE ${fk.on_delete}`;
    if (fk.on_update && fk.on_update !== 'NO ACTION') line += ` ON UPDATE ${fk.on_update}`;
    line += ';';
    // 이미 존재하면 무시 — DO 블록으로 감싸기
    output.push(`DO $$ BEGIN ${line} EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    fkCount++;
}

output.push('');
output.push('-- ============================================================');
output.push('-- Indexes');
output.push('-- ============================================================');
output.push('');
for (const idx of indexes) {
    try {
        output.push(emitIndex(idx));
    } catch (e) {
        console.error(`[ERROR] failed to emit index ${idx.name}:`, e.message);
    }
}

output.push('');

console.log(`[stat]  foreign keys: ${fkCount}`);

const finalSql = output.join('\n');

// ──────────────────────────────────────────────
// 출력
// ──────────────────────────────────────────────
if (DRY_RUN) {
    console.log(finalSql);
} else {
    fs.writeFileSync(OUT_PATH, finalSql, 'utf8');
    console.log(`[write] ${OUT_PATH} (${finalSql.length} bytes)`);
    console.log(`[stat]  tables: ${tables.length}, indexes: ${indexes.length}`);
    console.log(`[stat]  table list:`);
    for (const ts of tableStats) {
        console.log(`        - ${ts.name} (${ts.uniques} unique constraints)`);
    }
}

db.close();
