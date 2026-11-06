'use strict';
/**
 * 되돌리기(undo) — 파괴 동작 전에 지워질 행을 통째로 저장해 두고, 24시간 안에 그대로 되살린다 (2026-09 Phase 6)
 *   대상: 기록 전체 초기화 · 선수 삭제 · 종목 삭제 · 조 삭제
 *   전에는 키패드의 기록 되돌리기 말고는 되돌릴 방법이 없어, 잘못 누르면 백업 복원뿐이었다.
 *
 *   snapshot(db, { competition_id, kind, label, performed_by, role, tables: [{ table, where, params }], meta }) → { id, rows }
 *     tables 는 "부모 → 자식" 순서로 준다(되살릴 때 같은 순서로 넣는다). where 는 SQL 조각, params 는 그 값.
 *   restore(db, id) → { restored: { table: n } }   — 같은 id 의 행이 이미 있으면 건너뛴다(INSERT OR IGNORE)
 *   list(db, competition_id) → 24시간 안, 아직 안 되살린 것 최근 20건
 *
 *   PG: id 가 GENERATED ALWAYS 라 OVERRIDING SYSTEM VALUE 로 넣고, 시퀀스를 MAX(id) 로 맞춘다.
 */
const UNDO_TTL_MS = 24 * 60 * 60 * 1000;

async function ensureTable(db) {
    if (db.isAsync) {
        await db.run(`CREATE TABLE IF NOT EXISTS undo_snapshot (
            id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            competition_id BIGINT,
            kind TEXT NOT NULL,
            label TEXT NOT NULL DEFAULT '',
            payload TEXT NOT NULL,
            performed_by TEXT NOT NULL DEFAULT '',
            role TEXT NOT NULL DEFAULT 'operation',
            created_at TEXT NOT NULL DEFAULT NOW(),
            restored_at TEXT
        )`);
    } else {
        db.exec(`CREATE TABLE IF NOT EXISTS undo_snapshot (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            competition_id INTEGER,
            kind TEXT NOT NULL,
            label TEXT NOT NULL DEFAULT '',
            payload TEXT NOT NULL,
            performed_by TEXT NOT NULL DEFAULT '',
            role TEXT NOT NULL DEFAULT 'operation',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            restored_at TEXT
        )`);
    }
}

/** 지워질 행을 읽어 저장. 저장할 게 없으면 null */
async function snapshot(db, { competition_id, kind, label, performed_by, role, tables, meta }) {
    const data = [];
    let total = 0;
    for (const t of tables) {
        const rows = await db.all(`SELECT * FROM ${t.table} WHERE ${t.where}`, ...(t.params || []));
        if (rows.length) { data.push({ table: t.table, rows }); total += rows.length; }
    }
    if (!total) return null;
    const r = await db.run(
        'INSERT INTO undo_snapshot (competition_id, kind, label, payload, performed_by, role) VALUES (?,?,?,?,?,?)',
        competition_id || null, kind, label || '', JSON.stringify({ meta: meta || {}, data }), performed_by || '', role || 'operation'
    );
    return { id: r.lastInsertRowid, rows: total };
}

function _ageMs(createdAt) {
    let s = String(createdAt || '').trim().replace(' ', 'T');
    if (/[+-]\d\d$/.test(s)) s += ':00';                                    // PG '+00' → '+00:00'
    if (!/Z$|[+-]\d\d:\d\d$/.test(s)) s += 'Z';                            // 시간대 없는 값(SQLite datetime('now'))은 UTC
    const t = Date.parse(s);
    return isFinite(t) ? Date.now() - t : Infinity;
}

async function get(db, id) {
    const row = await db.get('SELECT * FROM undo_snapshot WHERE id=?', id);
    if (!row) return null;
    return { ...row, expired: _ageMs(row.created_at) > UNDO_TTL_MS, restored: !!row.restored_at };
}

/** 저장해 둔 행을 그대로 되살린다 (트랜잭션). 이미 되살렸거나 24시간이 지났으면 오류 */
async function restore(db, id) {
    const snap = await get(db, id);
    if (!snap) throw Object.assign(new Error('되돌릴 작업을 찾을 수 없습니다.'), { status: 404 });
    if (snap.restored) throw Object.assign(new Error('이미 되돌린 작업입니다.'), { status: 400 });
    if (snap.expired) throw Object.assign(new Error('24시간이 지나 되돌릴 수 없습니다. 백업에서 복원하세요.'), { status: 400 });
    const parsed = JSON.parse(snap.payload);
    const data = Array.isArray(parsed) ? parsed : parsed.data, meta = Array.isArray(parsed) ? {} : (parsed.meta || {});
    const restored = {};
    await db.transaction(async () => {
        for (const { table, rows } of data) {
            let n = 0;
            for (const row of rows) {
                const cols = Object.keys(row);
                const sql = `INSERT OR IGNORE INTO ${table} (${cols.join(',')}) ${db.isAsync ? 'OVERRIDING SYSTEM VALUE ' : ''}VALUES (${cols.map(() => '?').join(',')})`;
                const r = await db.run(sql, ...cols.map(c => row[c]));
                n += Number(r && r.changes) || 0;
            }
            restored[table] = n;
            if (db.isAsync && rows.some(r => r.id != null)) {
                try { await db.run(`SELECT setval(pg_get_serial_sequence('${table}','id'), (SELECT COALESCE(MAX(id),1) FROM ${table}))`); } catch (e) {}
            }
        }
        const nowFn = db.isAsync ? 'NOW()' : "datetime('now')";
        await db.run(`UPDATE undo_snapshot SET restored_at=${nowFn} WHERE id=?`, id);
    })();
    return { restored, kind: snap.kind, label: snap.label, competition_id: snap.competition_id, meta, data };
}

async function list(db, competition_id, limit = 20) {
    const rows = await db.all('SELECT id, competition_id, kind, label, performed_by, role, created_at, restored_at FROM undo_snapshot WHERE competition_id=? ORDER BY id DESC LIMIT ?', competition_id, limit * 3);
    return rows.filter(r => !r.restored_at && _ageMs(r.created_at) <= UNDO_TTL_MS).slice(0, limit);
}

/** 오래된 스냅샷 정리 (7일) — 부팅 때 한 번 */
async function prune(db) {
    try { await db.run(db.isAsync ? "DELETE FROM undo_snapshot WHERE created_at::timestamptz < NOW() - INTERVAL '7 days'" : "DELETE FROM undo_snapshot WHERE created_at < datetime('now','-7 days')"); } catch (e) {}
}

module.exports = { ensureTable, snapshot, restore, get, list, prune, UNDO_TTL_MS };
