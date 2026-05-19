/**
 * PACE RISE — Database Abstraction Layer
 * ========================================
 *
 * 목적:
 *   - 기존 better-sqlite3 코드 한 줄도 안 바꿔도 그대로 동작 (SQLite 백엔드)
 *   - PostgreSQL 백엔드 추가로 동시 입력 완전 대응
 *   - 환경변수 한 줄로 SQLite ↔ PostgreSQL 전환
 *
 * 백엔드 선택:
 *   - 환경변수 DB_BACKEND ('sqlite' | 'postgres'), 기본값 'sqlite'
 *   - DB_BACKEND=sqlite          → 동기 API (better-sqlite3)
 *   - DB_BACKEND=postgres        → 비동기 API (pg)
 *
 * 통일 인터페이스 (SQLite=동기, PostgreSQL=비동기):
 *   - db.get(sql, ...params)              한 행 조회
 *   - db.all(sql, ...params)              여러 행 조회
 *   - db.run(sql, ...params)              INSERT/UPDATE/DELETE → { changes, lastInsertRowid }
 *   - db.exec(sql)                        스키마 변경 등 다중 statement
 *   - db.transaction(fn)                  트랜잭션 함수 래퍼 (호출하면 트랜잭션 실행)
 *   - db.prepare(sql)                     SQLite 호환용 (PostgreSQL에서는 사용 불가)
 *   - db.pragma(sql)                      SQLite 전용 (PostgreSQL은 no-op)
 *   - db.close()                          연결 종료
 *   - db.getBackendName()                 'sqlite' | 'postgres'
 *   - db.isAsync                          true (PostgreSQL) / false (SQLite)
 *
 * PostgreSQL 어댑터의 SQL 자동 변환:
 *   - ? placeholder → $1, $2, ...
 *   - INSERT OR IGNORE → INSERT ... ON CONFLICT DO NOTHING
 *   - INSERT OR REPLACE → INSERT ... ON CONFLICT ... DO UPDATE SET ...
 *   - INSERT 시 lastInsertRowid 필요하면 RETURNING id 자동 추가
 *   - datetime('now') → NOW()
 *   - strftime → TO_CHAR
 */

const path = require('path');
const fs = require('fs');

// ============================================================
// SQLite 백엔드 어댑터 (동기)
// ============================================================
function createSqliteAdapter(options = {}) {
    const Database = require('better-sqlite3');
    const DB_PATH = options.path || path.join(__dirname, '..', 'db', 'competition.db');
    const SCHEMA_PATH = options.schemaPath || path.join(__dirname, '..', 'db', 'schema.sql');

    const exists = fs.existsSync(DB_PATH);
    const raw = new Database(DB_PATH);

    // WAL 모드 + 성능 최적화
    raw.pragma('journal_mode = WAL');
    raw.pragma('foreign_keys = ON');
    raw.pragma('synchronous = NORMAL');
    raw.pragma('cache_size = -64000');
    raw.pragma('temp_store = MEMORY');

    // ⚡ 동시 입력 충돌 완화 (멈춤 현상 응급조치)
    raw.pragma('busy_timeout = 5000');
    raw.pragma('wal_autocheckpoint = 1000');
    raw.pragma('mmap_size = 268435456');

    // 신규 DB 초기화 (기존 db/init.js 로직 보존)
    if (!exists && fs.existsSync(SCHEMA_PATH)) {
        const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
        raw.exec(schema);
        try {
            raw.prepare(`INSERT INTO competition (name, start_date, end_date, venue, status)
                VALUES ('2026 Pace Rise Invitational', '2026-02-19', '2026-02-21', 'PACE RISE 종합운동장', 'upcoming')`).run();
        } catch (e) {}
        const SEED_PATH = path.join(__dirname, '..', 'db', 'seed_clean.sql');
        if (fs.existsSync(SEED_PATH)) {
            try {
                const seed = fs.readFileSync(SEED_PATH, 'utf8');
                let cleaned = ''; let inStr = false; let i = 0;
                while (i < seed.length) {
                    if (seed[i] === "'") {
                        if (inStr && i + 1 < seed.length && seed[i + 1] === "'") { cleaned += "''"; i += 2; continue; }
                        inStr = !inStr;
                    }
                    if (!inStr && seed[i] === '-' && i + 1 < seed.length && seed[i + 1] === '-') {
                        while (i < seed.length && seed[i] !== '\n') i++;
                        continue;
                    }
                    cleaned += seed[i]; i++;
                }
                const stmts = cleaned.split(';').map(s => s.trim()).filter(s => s.length > 0);
                let ok = 0, skip = 0;
                for (const s of stmts) { try { raw.exec(s + ';'); ok++; } catch (e) { skip++; } }
                console.log(`[DB:sqlite] Seed data: ${ok} statements OK, ${skip} skipped`);
            } catch (e) { console.error('[DB:sqlite] Seed error:', e.message); }
        }
        console.log('[DB:sqlite] Database created with schema');
    } else if (fs.existsSync(SCHEMA_PATH)) {
        const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
        raw.exec(schema);
        console.log('[DB:sqlite] Database loaded (existing)');
    }

    return {
        getBackendName() { return 'sqlite'; },
        isAsync: false,
        raw,

        get(sql, ...params) {
            if (params.length === 1 && Array.isArray(params[0])) params = params[0];
            return raw.prepare(sql).get(...params);
        },

        all(sql, ...params) {
            if (params.length === 1 && Array.isArray(params[0])) params = params[0];
            return raw.prepare(sql).all(...params);
        },

        run(sql, ...params) {
            if (params.length === 1 && Array.isArray(params[0])) params = params[0];
            const info = raw.prepare(sql).run(...params);
            return {
                changes: info.changes,
                lastInsertRowid: info.lastInsertRowid
            };
        },

        exec(sql) {
            return raw.exec(sql);
        },

        /**
         * 트랜잭션 — PG 백엔드와 시그니처 동일 (async 함수 지원).
         *
         * 사용: const txn = db.transaction(async () => { ... });
         *       await txn(args);
         *
         * better-sqlite3의 raw.transaction()은 async 콜백을 받으면
         *   "TypeError: Transaction function cannot return a promise"
         * 로 거부하므로, 우리가 직접 BEGIN/COMMIT/ROLLBACK 을 발행한다.
         *
         * 단, SQLite 메서드(db.get/all/run/exec)는 모두 sync이므로
         * async 콜백 안의 await은 마이크로태스크일 뿐 실제 DB I/O는 sync로 처리된다.
         * 따라서 BEGIN/COMMIT 사이에서 모든 쓰기가 같은 트랜잭션으로 묶임이 보장된다.
         */
        transaction(fn) {
            return async (...args) => {
                raw.exec('BEGIN');
                try {
                    const result = await fn(...args);
                    raw.exec('COMMIT');
                    return result;
                } catch (err) {
                    try { raw.exec('ROLLBACK'); } catch(e) {}
                    throw err;
                }
            };
        },

        prepare(sql) {
            return raw.prepare(sql);
        },

        pragma(sql) {
            return raw.pragma(sql);
        },

        // ─── 메타 헬퍼: 양 백엔드 호환 ────────────────────────────
        async tableExists(name) {
            const row = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
            return !!row;
        },
        async columnExists(table, column) {
            try {
                const cols = raw.prepare(`PRAGMA table_info(${table})`).all();
                return cols.some(c => c.name === column);
            } catch (_) { return false; }
        },
        async indexExists(name) {
            const row = raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?").get(name);
            return !!row;
        },

        close() {
            raw.close();
        }
    };
}

// ============================================================
// PostgreSQL 백엔드 어댑터 (비동기)
// ============================================================

/**
 * SQLite SQL을 PostgreSQL SQL로 변환
 * - ? placeholder → $1, $2, ...
 * - INSERT OR IGNORE → ON CONFLICT DO NOTHING
 * - INSERT OR REPLACE → 호출자가 직접 ON CONFLICT 사용해야 함 (자동 변환 위험)
 * - datetime('now') → NOW()
 */
function convertSqlForPostgres(sql) {
    let converted = sql;

    // 1. datetime('now') → NOW()
    converted = converted.replace(/datetime\s*\(\s*['"]now['"]\s*\)/gi, 'NOW()');

    // 2. INSERT OR IGNORE → INSERT ... ON CONFLICT DO NOTHING
    //    (SQL 끝에 ON CONFLICT 절이 없는 경우만)
    if (/^\s*INSERT\s+OR\s+IGNORE/i.test(converted)) {
        converted = converted.replace(/^\s*INSERT\s+OR\s+IGNORE/i, 'INSERT');
        if (!/ON\s+CONFLICT/i.test(converted)) {
            converted = converted.replace(/;?\s*$/, ' ON CONFLICT DO NOTHING');
        }
    }

    // 3. INSERT OR REPLACE → INSERT (사용자가 ON CONFLICT DO UPDATE를 직접 명시해야 함)
    //    자동 변환은 위험 (UNIQUE 컬럼을 알 수 없음). 일단 INSERT로만 변환하고 로그.
    if (/^\s*INSERT\s+OR\s+REPLACE/i.test(converted)) {
        converted = converted.replace(/^\s*INSERT\s+OR\s+REPLACE/i, 'INSERT');
        // 호출자가 별도로 ON CONFLICT 절을 붙여야 함
    }

    // 4. ? placeholder → $1, $2, ...
    //    문자열 리터럴 내부의 ?는 건드리지 않음
    let result = '';
    let idx = 0;
    let placeholderCount = 0;
    let inString = false;
    let stringChar = null;
    while (idx < converted.length) {
        const ch = converted[idx];
        if (inString) {
            result += ch;
            if (ch === stringChar) {
                // 이스케이프 처리: '' → 그대로 문자열
                if (idx + 1 < converted.length && converted[idx + 1] === stringChar) {
                    result += converted[idx + 1];
                    idx += 2;
                    continue;
                }
                inString = false;
            }
            idx++;
        } else {
            if (ch === "'" || ch === '"') {
                inString = true;
                stringChar = ch;
                result += ch;
                idx++;
            } else if (ch === '?') {
                placeholderCount++;
                result += '$' + placeholderCount;
                idx++;
            } else {
                result += ch;
                idx++;
            }
        }
    }

    return result;
}

/**
 * INSERT 문에 RETURNING id 자동 추가 (lastInsertRowid 호환용)
 *
 * PostgreSQL 절 순서:
 *   INSERT INTO ... VALUES (...) [ON CONFLICT ...] [RETURNING ...]
 *
 * 따라서 ON CONFLICT 절이 이미 있으면 그 다음에 RETURNING 을 붙여야 한다.
 * 호출 시점은 convertSqlForPostgres() 이후이므로, SQL은 이미 변환된 상태.
 */
// id 컬럼이 없는 테이블 목록 (PK가 자연키인 경우)
// 이 테이블들에는 RETURNING id 를 붙이면 PG가 "column id does not exist" 에러 발생.
// schema.pg.sql 기준 자동 검증 완료 (2026-05-17).
const TABLES_WITHOUT_ID = new Set([
    'system_config',   // PK: key
    'event_records',   // PK: event_id
    'doc_template',    // PK: competition_id
]);

function addReturningId(sql) {
    if (!/^\s*INSERT\s/i.test(sql)) return sql;
    if (/RETURNING/i.test(sql)) return sql;
    // INSERT INTO "tablename" 또는 INSERT INTO tablename 에서 테이블명 추출
    const m = sql.match(/^\s*INSERT\s+INTO\s+["`]?([a-zA-Z_][a-zA-Z0-9_]*)["`]?/i);
    if (m && TABLES_WITHOUT_ID.has(m[1].toLowerCase())) {
        return sql; // id 컬럼 없으므로 RETURNING 생략
    }
    // 세미콜론 제거 (있다면 마지막에 다시 붙임)
    let s = sql.replace(/;?\s*$/, '');
    s += ' RETURNING id';
    return s;
}

function createPostgresAdapter(options = {}) {
    const { Pool } = require('pg');

    // 연결 정보: 우선순위 1) options 2) DATABASE_URL 3) 개별 환경변수
    const connectionConfig = options.connectionString || process.env.DATABASE_URL
        ? { connectionString: options.connectionString || process.env.DATABASE_URL }
        : {
            host: options.host || process.env.PGHOST || 'localhost',
            port: options.port || parseInt(process.env.PGPORT || '5432', 10),
            user: options.user || process.env.PGUSER || 'postgres',
            password: options.password || process.env.PGPASSWORD || '',
            database: options.database || process.env.PGDATABASE || 'pacerise',
        };

    // 풀 옵션
    const poolConfig = {
        ...connectionConfig,
        max: options.poolMax || 20,           // 최대 동시 연결 20개 (운영 충분)
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
    };

    const pool = new Pool(poolConfig);

    // BIGINT를 JS number로 변환 (id 컬럼이 BIGINT일 때)
    // pg는 기본적으로 BIGINT를 문자열로 반환하지만, 우리 id는 안전한 범위라 number로 변환
    const types = require('pg').types;
    types.setTypeParser(20, (val) => parseInt(val, 10)); // BIGINT (OID 20)

    console.log('[DB:postgres] Pool initialized (max:', poolConfig.max, ')');

    /**
     * 쿼리 실행 (내부 헬퍼)
     * @param {string} sql
     * @param {Array} params
     * @param {object} client 선택적 transaction client
     */
    /**
     * @param {string} sql
     * @param {Array} params
     * @param {object} client
     * @param {object} options { addReturning: bool } — INSERT에 RETURNING id 추가 여부
     */
    /**
     * SQLite와 PG의 파라미터 처리 차이를 흡수.
     * - undefined → null (PG는 undefined를 보내면 "bind message supplies N parameters" 에러)
     * - 빈 문자열 그대로 유지 (의도된 빈 문자열일 수 있음)
     * - 'undefined'/'null' 문자열은 그대로 (의도된 케이스일 수 있어 자동 변환 안 함 — 호출자 책임)
     */
    function _sanitizeParams(params) {
        if (!Array.isArray(params)) return params;
        return params.map(p => (p === undefined ? null : p));
    }

    async function query(sql, params, client, options = {}) {
        const executor = client || pool;
        // 1) SQLite → PostgreSQL SQL 변환 (ON CONFLICT 삽입 포함)
        let pgSql = convertSqlForPostgres(sql);
        // 2) 그 뒤에 RETURNING id 추가 (ON CONFLICT 뒤에 위치하도록 순서 보장)
        if (options.addReturning) {
            pgSql = addReturningId(pgSql);
        }
        // 3) 파라미터 정규화: undefined → null (PG bind 호환)
        const safeParams = _sanitizeParams(params);
        try {
            const res = await executor.query(pgSql, safeParams);
            return res;
        } catch (err) {
            err.query = pgSql;
            err.originalSql = sql;
            err.params = safeParams;
            throw err;
        }
    }

    // 트랜잭션 컨텍스트 (AsyncLocalStorage로 트랜잭션 내부 추적)
    const { AsyncLocalStorage } = require('async_hooks');
    const txnStorage = new AsyncLocalStorage();

    function currentClient() {
        return txnStorage.getStore();
    }

    return {
        getBackendName() { return 'postgres'; },
        isAsync: true,
        raw: pool,

        async get(sql, ...params) {
            if (params.length === 1 && Array.isArray(params[0])) params = params[0];
            const res = await query(sql, params, currentClient());
            return res.rows[0] || undefined;
        },

        async all(sql, ...params) {
            if (params.length === 1 && Array.isArray(params[0])) params = params[0];
            const res = await query(sql, params, currentClient());
            return res.rows;
        },

        async run(sql, ...params) {
            if (params.length === 1 && Array.isArray(params[0])) params = params[0];
            // INSERT면 RETURNING id 자동 추가 (lastInsertRowid 호환)
            // 단, RETURNING은 ON CONFLICT 절 뒤에 와야 하므로 query() 내부에서 변환 직후 추가
            const isInsert = /^\s*INSERT\s/i.test(sql);
            const res = await query(sql, params, currentClient(), { addReturning: isInsert });
            return {
                changes: res.rowCount || 0,
                lastInsertRowid: isInsert && res.rows && res.rows[0] ? res.rows[0].id : undefined
            };
        },

        async exec(sql) {
            // exec는 다중 statement 가능. pg는 1쿼리당 1statement지만 ;로 구분되면 따로 실행
            // 다만 PostgreSQL은 ;로 구분된 statement도 한 번에 받음.
            await query(sql, [], currentClient());
        },

        /**
         * 트랜잭션 — better-sqlite3 시그니처와 유사
         * 사용: const txn = db.transaction(async (a, b) => { ... });
         *       await txn(a, b);
         */
        transaction(fn) {
            return async (...args) => {
                const client = await pool.connect();
                try {
                    await client.query('BEGIN');
                    const result = await txnStorage.run(client, async () => {
                        return await fn(...args);
                    });
                    await client.query('COMMIT');
                    return result;
                } catch (err) {
                    try { await client.query('ROLLBACK'); } catch(e) {}
                    throw err;
                } finally {
                    client.release();
                }
            };
        },

        // SQLite prepare 호환 — PostgreSQL에서는 사용 불가, 에러 던짐 (코드 변환 강제)
        prepare(sql) {
            throw new Error(
                `[DB:postgres] db.prepare() is not supported. ` +
                `Use db.get(sql, ...params), db.all(...), or db.run(...) instead. ` +
                `SQL: ${sql.substring(0, 100)}...`
            );
        },

        // SQLite 전용 — no-op
        pragma(sql) {
            // 무시 (PostgreSQL에서는 의미 없음). 디버그 로그만.
            // console.log('[DB:postgres] pragma ignored:', sql);
            return [];
        },

        // ─── 메타 헬퍼: 양 백엔드 호환 (information_schema 사용) ─────
        async tableExists(name) {
            const res = await query(
                "SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1",
                [name],
                currentClient()
            );
            return res.rows.length > 0;
        },
        async columnExists(table, column) {
            const res = await query(
                "SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2",
                [table, column],
                currentClient()
            );
            return res.rows.length > 0;
        },
        async indexExists(name) {
            const res = await query(
                "SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = $1",
                [name],
                currentClient()
            );
            return res.rows.length > 0;
        },

        async close() {
            await pool.end();
        },

        // 디버깅용: SQL 변환 결과 확인
        _convertSql: convertSqlForPostgres
    };
}

// ============================================================
// 팩토리: 환경변수로 백엔드 선택
// ============================================================
let _singleton = null;

function getDb(options = {}) {
    if (_singleton) return _singleton;

    const backend = (process.env.DB_BACKEND || 'sqlite').toLowerCase();
    if (backend === 'sqlite') {
        _singleton = createSqliteAdapter(options);
    } else if (backend === 'postgres' || backend === 'postgresql' || backend === 'pg') {
        _singleton = createPostgresAdapter(options);
    } else {
        throw new Error(`[DB] Unknown DB_BACKEND: ${backend}. Use 'sqlite' or 'postgres'.`);
    }

    return _singleton;
}

function getDbPath() {
    return path.join(__dirname, '..', 'db', 'competition.db');
}

module.exports = {
    getDb,
    getDbPath,
    // 내부/테스트용
    _convertSql: convertSqlForPostgres,
    _resetForTest() { if (_singleton) { try { _singleton.close(); } catch(e){} } _singleton = null; }
};
