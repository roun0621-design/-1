'use strict';
/**
 * 운영 관측 라이트 (2026-10-12, 해외 D16 '운영 관측' — Sentry 같은 외부 서비스 없이 서버 안에서)
 *   - 오류 기록: Express 500·uncaughtException·unhandledRejection 을 메모리 링 버퍼(최근 200건) + logs/errors.log(JSON 줄) 에 남긴다
 *   - 요청 통계: /api 요청 수·5xx·느린 요청(>1초)·최근 500건 지연의 p95
 *   - GET /api/admin/server-status (관리자) → 관리자 › 현황 '서버 상태' 카드
 *   키·토큰은 남기지 않는다(쿼리스트링 제거, 본문 안 봄).
 */
const fs = require('fs');
const path = require('path');

const MAX_ERRORS = 200, MAX_LAT = 500;
const state = { errors: [], lat: [], req: 0, err5xx: 0, slow: 0, hourly: new Map(), startedAt: Date.now() };
let logDir = null;

function init(opts) {
    logDir = (opts && opts.logDir) || path.join(process.cwd(), 'logs');
    try { fs.mkdirSync(logDir, { recursive: true }); } catch (e) { logDir = null; }
}

function _hourKey(ts) { return Math.floor(ts / 3600000); }
function _bump(map, key) { map.set(key, (map.get(key) || 0) + 1); for (const k of map.keys()) if (k < key - 48) map.delete(k); }

/** 오류 한 건 기록. kind: 'http' | 'uncaught' | 'rejection' | 'custom' */
function recordError(kind, err, req) {
    const ts = Date.now();
    const e = {
        ts: new Date(ts).toISOString(), kind,
        message: String((err && err.message) || err || '').slice(0, 300),
        stack: err && err.stack ? String(err.stack).split('\n').slice(0, 4).join('\n').slice(0, 600) : '',
        method: req ? req.method : '', path: req ? String(req.originalUrl || req.url || '').split('?')[0].slice(0, 200) : '',
        status: req && req.res ? req.res.statusCode : undefined, code: err && err.code ? String(err.code) : undefined,
    };
    state.errors.push(e); if (state.errors.length > MAX_ERRORS) state.errors.shift();
    _bump(state.hourly, _hourKey(ts));
    if (logDir) fs.appendFile(path.join(logDir, 'errors.log'), JSON.stringify(e) + '\n', () => {});
    return e;
}

/** /api 요청 지연·상태 집계 미들웨어 */
function requestStats() {
    return (req, res, next) => {
        if (!req.path.startsWith('/api')) return next();
        const t0 = process.hrtime.bigint();
        res.on('finish', () => {
            const ms = Number(process.hrtime.bigint() - t0) / 1e6;
            state.req++;
            state.lat.push(ms); if (state.lat.length > MAX_LAT) state.lat.shift();
            if (ms > 1000) state.slow++;
            if (res.statusCode >= 500) state.err5xx++;
        });
        next();
    };
}

function _p(arr, q) { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))]); }

async function snapshot(db, extra) {
    const mem = process.memoryUsage();
    let dbLatency = null, dbOk = true;
    try { const t0 = Date.now(); await db.get('SELECT 1 AS ok'); dbLatency = Date.now() - t0; } catch (e) { dbOk = false; }
    const nowH = _hourKey(Date.now());
    let errors24h = 0; for (const [k, v] of state.hourly) if (k > nowH - 24) errors24h += v;
    let dbFileMb = null;
    if (!db.isAsync && process.env.SQLITE_PATH) { try { dbFileMb = Math.round(fs.statSync(process.env.SQLITE_PATH).size / 1048576 * 10) / 10; } catch (e) {} }
    return {
        ok: dbOk, ts: new Date().toISOString(), node: process.version, pid: process.pid,
        uptime_sec: Math.floor(process.uptime()), started_at: new Date(state.startedAt).toISOString(),
        rss_mb: Math.round(mem.rss / 1048576), heap_used_mb: Math.round(mem.heapUsed / 1048576), heap_total_mb: Math.round(mem.heapTotal / 1048576),
        db: { backend: db.isAsync ? 'postgres' : 'sqlite', up: dbOk, latency_ms: dbLatency, file_mb: dbFileMb },
        requests: { total: state.req, err5xx: state.err5xx, slow_over_1s: state.slow, p50_ms: _p(state.lat, 0.5), p95_ms: _p(state.lat, 0.95), sample: state.lat.length },
        errors: { last_24h: errors24h, recent: state.errors.slice(-10).reverse() },
        ...(extra || {}),
    };
}

module.exports = { init, recordError, requestStats, snapshot, _state: state };
