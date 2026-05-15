/**
 * PACE RISE — Database Abstraction Layer
 * ========================================
 *
 * 목적:
 *   - 기존 better-sqlite3 코드 한 줄도 안 바꿔도 그대로 동작
 *   - 동시에 새 코드는 통일된 인터페이스(db.get/all/run/exec/transaction)로 작성 가능
 *   - 향후 PostgreSQL 등 다른 백엔드로 교체할 때 이 파일만 수정하면 됨
 *
 * 백엔드 선택:
 *   - 환경변수 DB_BACKEND ('sqlite' | 'postgres'), 기본값 'sqlite'
 *   - 1단계(현재): SQLite 어댑터만 구현, 100% 하위 호환
 *   - 2단계(예정): PostgreSQL 어댑터 추가
 *
 * 제공 인터페이스:
 *   - db.get(sql, ...params)              한 행 조회
 *   - db.all(sql, ...params)              여러 행 조회
 *   - db.run(sql, ...params)              INSERT/UPDATE/DELETE → { changes, lastInsertRowid }
 *   - db.exec(sql)                        스키마 변경 등 다중 statement
 *   - db.transaction(fn)                  트랜잭션 (better-sqlite3 호환 시그니처)
 *   - db.prepare(sql)                     기존 코드 호환용 (Statement 객체 반환)
 *   - db.pragma(sql)                      SQLite 전용 (PostgreSQL에서는 no-op)
 *   - db.close()                          연결 종료
 *   - db.getBackendName()                 'sqlite' | 'postgres'
 *   - db.raw                              원본 백엔드 객체 (필요 시 직접 접근)
 *
 * 사용 예:
 *   const { getDb } = require('./lib/db');
 *   const db = getDb();
 *   const row = db.get('SELECT * FROM athlete WHERE id=?', 123);
 *   const info = db.run('INSERT INTO athlete (name) VALUES (?)', '홍길동');
 *   console.log(info.lastInsertRowid);
 */

const path = require('path');
const fs = require('fs');

// ============================================================
// SQLite 백엔드 어댑터
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
    // busy_timeout: 다른 트랜잭션이 잠금 보유 중일 때, 즉시 SQLITE_BUSY 에러를 던지지 않고
    // 지정 시간(ms)까지 재시도하며 대기. 5초로 설정 — 트랙 종목 입력 충돌 대비.
    raw.pragma('busy_timeout = 5000');
    // wal_autocheckpoint: WAL 파일 크기 제어 (4MB마다 체크포인트)
    raw.pragma('wal_autocheckpoint = 1000');
    // mmap_size: 메모리맵 I/O로 읽기 성능 향상 (256MB)
    raw.pragma('mmap_size = 268435456');

    // 신규 DB 초기화 (기존 db/init.js 로직 보존)
    if (!exists && fs.existsSync(SCHEMA_PATH)) {
        const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
        raw.exec(schema);
        try {
            raw.prepare(`INSERT INTO competition (name, start_date, end_date, venue, status)
                VALUES ('2026 Pace Rise Invitational', '2026-02-19', '2026-02-21', 'PACE RISE 종합운동장', 'upcoming')`).run();
        } catch (e) {}
        // 시드 데이터 로드 (기존 로직)
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
        // 기존 DB: 스키마에 IF NOT EXISTS 들어있으므로 안전하게 다시 실행
        const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
        raw.exec(schema);
        console.log('[DB:sqlite] Database loaded (existing)');
    }

    // -----------------------------
    // 통일 인터페이스 구현
    // -----------------------------
    const adapter = {
        // 백엔드 식별
        getBackendName() { return 'sqlite'; },
        raw,

        // 단일 행 조회
        get(sql, ...params) {
            // params가 단일 배열로 전달된 경우 펼침 (better-sqlite3 호환)
            if (params.length === 1 && Array.isArray(params[0])) params = params[0];
            return raw.prepare(sql).get(...params);
        },

        // 여러 행 조회
        all(sql, ...params) {
            if (params.length === 1 && Array.isArray(params[0])) params = params[0];
            return raw.prepare(sql).all(...params);
        },

        // INSERT/UPDATE/DELETE
        run(sql, ...params) {
            if (params.length === 1 && Array.isArray(params[0])) params = params[0];
            const info = raw.prepare(sql).run(...params);
            return {
                changes: info.changes,
                lastInsertRowid: info.lastInsertRowid
            };
        },

        // 다중 statement 실행 (스키마 변경 등)
        exec(sql) {
            return raw.exec(sql);
        },

        // 트랜잭션 — better-sqlite3 시그니처 호환
        // 사용: db.transaction(() => { ... })()  또는  db.transaction(() => { ... })
        // better-sqlite3는 transaction(fn)이 호출 가능한 함수를 반환함
        transaction(fn) {
            return raw.transaction(fn);
        },

        // 기존 코드 호환: db.prepare(...).get/.all/.run 그대로 사용 가능
        prepare(sql) {
            return raw.prepare(sql);
        },

        // SQLite 전용
        pragma(sql) {
            return raw.pragma(sql);
        },

        close() {
            raw.close();
        }
    };

    return adapter;
}

// ============================================================
// PostgreSQL 백엔드 어댑터 (placeholder — 2단계에서 구현)
// ============================================================
function createPostgresAdapter(options = {}) {
    throw new Error(
        '[DB] PostgreSQL 백엔드는 2단계에서 구현 예정입니다. ' +
        '현재는 DB_BACKEND=sqlite (기본값)를 사용해주세요.'
    );
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

// DB 경로 호출자가 알아야 하는 경우 (백업 등)
function getDbPath() {
    return path.join(__dirname, '..', 'db', 'competition.db');
}

module.exports = {
    getDb,
    getDbPath,
    // 테스트/유틸용
    _resetForTest() { if (_singleton) { try { _singleton.close(); } catch(e){} } _singleton = null; }
};
