#!/usr/bin/env node
/**
 * Phase 2-G-9-part3 Stage 2 — Parity test (SQLite vs PG byte-compare)
 *
 * 목적
 * ─────────────────────────────────────────────────────────────
 *   동일한 server.js 코드를 두 백엔드(SQLite / PostgreSQL)로
 *   각각 다른 포트에서 띄운 뒤, 동일한 요청 시퀀스를 양쪽에 보내고
 *   응답 본문을 정규화(normalize)해 비교한다.
 *
 *   - 환경에 따라 달라지는 필드는 normalize 단계에서 제거/마스킹
 *     (id / created_at / updated_at / timestamps / event_entry_id / ...)
 *   - HTTP status / 핵심 비즈니스 필드 (name / bib_number / status / ...) 는
 *     양쪽 백엔드에서 100% 일치해야 한다.
 *
 * 실행
 * ─────────────────────────────────────────────────────────────
 *   PGCONN="postgres://pacerise:pacerise_test_pw@localhost:5432/pacerise_test" \
 *   node scripts/parity_test.js
 *
 * 종료 코드: 0 = 모두 일치, 1 = 1건 이상 불일치
 *
 * 주의
 * ─────────────────────────────────────────────────────────────
 *   - PG 측 테이블은 미리 마이그레이션 완료된 상태여야 한다
 *     (scripts/migrate_sqlite_to_postgres.js 실행 후 사용)
 *   - SQLite 측은 별도 임시 DB 파일을 만들지 않고 db/competition.db 사용
 *     (이미 데이터가 있어도 created_at/id 가 정규화되므로 무방)
 *   - 두 서버는 동일한 비교 직전에 신규 competition 을 만들고 그 안에서만
 *     CRUD 시퀀스를 돌린다 → 외부 데이터는 건드리지 않음.
 */

'use strict';

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

// ─── 설정 ──────────────────────────────────────────────────────
const SQLITE_PORT = 13001;
const PG_PORT = 13002;
const BOOT_TIMEOUT_MS = 30000;
const REQUEST_TIMEOUT_MS = 10000;
const ADMIN_KEY = process.env.ADMIN_PW || 'JChy!!34';
const OPERATION_KEY = process.env.OPERATION_KEY || '1234';
const PG_CONN = process.env.PGCONN || process.env.DATABASE_URL
    || 'postgres://pacerise:pacerise_test_pw@localhost:5432/pacerise_test';

const ROOT = path.join(__dirname, '..');
const SERVER_JS = path.join(ROOT, 'server.js');

const LOG_DIR = '/tmp';
const SQLITE_LOG = path.join(LOG_DIR, 'parity_sqlite.log');
const PG_LOG = path.join(LOG_DIR, 'parity_pg.log');

// ─── 유틸 ─────────────────────────────────────────────────────
function colored(msg, color) {
    const codes = { red: 31, green: 32, yellow: 33, blue: 34, gray: 90 };
    const c = codes[color] || 37;
    return `\x1b[${c}m${msg}\x1b[0m`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function httpRequest(port, method, urlPath, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const opts = {
            host: 'localhost',
            port,
            path: urlPath,
            method,
            headers: {
                'Content-Type': 'application/json',
            },
        };
        if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);

        const req = http.request(opts, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf-8');
                let json = null;
                try { json = JSON.parse(text); } catch (_) { json = { _raw: text }; }
                resolve({ status: res.statusCode, body: json, text });
            });
        });
        req.on('error', reject);
        req.setTimeout(REQUEST_TIMEOUT_MS, () => {
            req.destroy(new Error('request timeout'));
        });
        if (data) req.write(data);
        req.end();
    });
}

async function waitForBoot(port, label) {
    const start = Date.now();
    while (Date.now() - start < BOOT_TIMEOUT_MS) {
        try {
            const r = await httpRequest(port, 'GET', '/api/competitions');
            if (r.status === 200 || r.status === 401 || r.status === 403) {
                return true;
            }
        } catch (_) { /* not up yet */ }
        await sleep(500);
    }
    throw new Error(`[${label}] boot timeout (${BOOT_TIMEOUT_MS}ms)`);
}

function spawnServer(label, env, logPath) {
    const out = fs.openSync(logPath, 'w');
    const err = fs.openSync(logPath, 'a');
    const child = spawn('node', [SERVER_JS], {
        cwd: ROOT,
        env: { ...process.env, ...env },
        stdio: ['ignore', out, err],
        detached: false,
    });
    child.on('error', (e) => {
        console.error(`[${label}] spawn error:`, e.message);
    });
    return child;
}

// ─── 정규화 함수 ───────────────────────────────────────────────
// 응답 본문에서 환경에 따라 달라지는 필드를 마스킹/제거하여
// SQLite ↔ PG 비교가 가능하도록 변환.
const VOLATILE_FIELDS = new Set([
    'id', 'created_at', 'updated_at', 'timestamp', 'completed_at',
    'event_entry_id', 'event_id', 'athlete_id', 'competition_id',
    'heat_id', 'parent_event_id', 'sort_order',
    'lastInsertRowid', 'changes',
]);

function normalize(value) {
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) return value.map(normalize);
    if (typeof value === 'object') {
        const out = {};
        const keys = Object.keys(value).sort();
        for (const k of keys) {
            if (VOLATILE_FIELDS.has(k)) {
                out[k] = '<NORMALIZED>';
            } else if (typeof value[k] === 'string' && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value[k])) {
                // ISO/SQL timestamp string (e.g. "2026-05-18 00:00:46.326363+00")
                out[k] = '<TIMESTAMP>';
            } else {
                out[k] = normalize(value[k]);
            }
        }
        return out;
    }
    return value;
}

function jsonEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

// ─── 테스트 시나리오 ────────────────────────────────────────────
// 각 step: { name, run(port) => {status,body} }
// run 은 양쪽 백엔드에 각각 한 번씩 호출되고, normalize 후 비교된다.
// 상태(ID) 는 step 사이에 ctx 객체로 전달되며, ctx 는 각 백엔드별로 분리됨.
const SCENARIO = [
    {
        name: 'POST /api/competitions (create)',
        run: async (port, ctx) => {
            const r = await httpRequest(port, 'POST', '/api/competitions', {
                admin_key: ADMIN_KEY,
                name: 'PARITY_TEST_COMP',
                start_date: '2026-07-01',
                end_date: '2026-07-02',
                venue: 'ParityVenue',
            });
            if (r.body && r.body.id) ctx.comp_id = r.body.id;
            return r;
        },
    },
    {
        name: 'GET /api/competitions/:id',
        run: async (port, ctx) => httpRequest(port, 'GET', `/api/competitions/${ctx.comp_id}`),
    },
    {
        name: 'PUT /api/competitions/:id',
        run: async (port, ctx) => httpRequest(port, 'PUT', `/api/competitions/${ctx.comp_id}`, {
            admin_key: OPERATION_KEY,
            name: 'PARITY_TEST_COMP_UPDATED',
            start_date: '2026-07-01',
            end_date: '2026-07-03',
            venue: 'ParityVenueUpdated',
        }),
    },
    {
        name: 'POST /api/admin/events',
        run: async (port, ctx) => {
            const r = await httpRequest(port, 'POST', '/api/admin/events', {
                admin_key: OPERATION_KEY,
                competition_id: ctx.comp_id,
                name: '100m',
                category: 'track',
                gender: 'M',
                round_type: 'final',
            });
            if (r.body && r.body.id) ctx.event_id = r.body.id;
            return r;
        },
    },
    {
        name: 'POST /api/admin/athletes (1)',
        run: async (port, ctx) => {
            const r = await httpRequest(port, 'POST', '/api/admin/athletes', {
                admin_key: OPERATION_KEY,
                competition_id: ctx.comp_id,
                name: 'ParityRunner1',
                bib_number: '201',
                team: 'TeamP',
                gender: 'M',
            });
            if (r.body && r.body.id) ctx.athlete1_id = r.body.id;
            return r;
        },
    },
    {
        name: 'POST /api/admin/athletes (2)',
        run: async (port, ctx) => {
            const r = await httpRequest(port, 'POST', '/api/admin/athletes', {
                admin_key: OPERATION_KEY,
                competition_id: ctx.comp_id,
                name: 'ParityRunner2',
                bib_number: '202',
                team: 'TeamP',
                gender: 'M',
            });
            if (r.body && r.body.id) ctx.athlete2_id = r.body.id;
            return r;
        },
    },
    {
        name: 'PUT /api/admin/athletes/:id',
        run: async (port, ctx) => httpRequest(port, 'PUT', `/api/admin/athletes/${ctx.athlete1_id}`, {
            admin_key: OPERATION_KEY,
            name: 'ParityRunner1_UPDATED',
            bib_number: '203',
            team: 'TeamP2',
            gender: 'M',
        }),
    },
    {
        name: 'GET /api/athletes?competition_id (list)',
        run: async (port, ctx) => httpRequest(port, 'GET', `/api/athletes?competition_id=${ctx.comp_id}`),
    },
    {
        name: 'POST /api/admin/athletes/:id/events (assign 1)',
        run: async (port, ctx) => httpRequest(port, 'POST', `/api/admin/athletes/${ctx.athlete1_id}/events`, {
            admin_key: OPERATION_KEY,
            event_id: ctx.event_id,
        }),
    },
    {
        name: 'POST /api/admin/athletes/:id/events (assign 2)',
        run: async (port, ctx) => httpRequest(port, 'POST', `/api/admin/athletes/${ctx.athlete2_id}/events`, {
            admin_key: OPERATION_KEY,
            event_id: ctx.event_id,
        }),
    },
    {
        name: 'GET /api/events/:id/entries',
        run: async (port, ctx) => httpRequest(port, 'GET', `/api/events/${ctx.event_id}/entries`),
    },
    {
        name: 'GET /api/admin/athletes/:id/events',
        run: async (port, ctx) => httpRequest(port, 'GET', `/api/admin/athletes/${ctx.athlete1_id}/events?key=${OPERATION_KEY}`),
    },
    {
        name: 'GET non-existent competition (404)',
        run: async (port) => httpRequest(port, 'GET', '/api/competitions/99999999'),
    },
    {
        name: 'POST /api/competitions missing required (400)',
        run: async (port) => httpRequest(port, 'POST', '/api/competitions', {
            admin_key: ADMIN_KEY,
            name: 'incomplete',
        }),
    },
    {
        name: 'DELETE /api/admin/athletes/:id (cleanup 1)',
        run: async (port, ctx) => httpRequest(port, 'DELETE', `/api/admin/athletes/${ctx.athlete1_id}`, {
            admin_key: ADMIN_KEY,
        }),
    },
    {
        name: 'DELETE /api/admin/athletes/:id (cleanup 2)',
        run: async (port, ctx) => httpRequest(port, 'DELETE', `/api/admin/athletes/${ctx.athlete2_id}`, {
            admin_key: ADMIN_KEY,
        }),
    },
    {
        name: 'DELETE /api/competitions/:id (cleanup)',
        run: async (port, ctx) => httpRequest(port, 'DELETE', `/api/competitions/${ctx.comp_id}`, {
            admin_key: ADMIN_KEY,
        }),
    },
    {
        name: 'GET deleted competition (404)',
        run: async (port, ctx) => httpRequest(port, 'GET', `/api/competitions/${ctx.comp_id}`),
    },
];

// ─── 메인 ─────────────────────────────────────────────────────
async function main() {
    console.log(colored('═══════════════════════════════════════════════════════', 'blue'));
    console.log(colored('  Phase 2-G-9-part3 Stage 2: PARITY TEST', 'blue'));
    console.log(colored('  SQLite vs PostgreSQL — 응답 byte-compare', 'blue'));
    console.log(colored('═══════════════════════════════════════════════════════', 'blue'));
    console.log('');

    // 1) 양쪽 서버 부팅
    console.log(colored(`▶ SQLite 서버 부팅 (port ${SQLITE_PORT}) ...`, 'gray'));
    const sqliteServer = spawnServer('sqlite', {
        PORT: String(SQLITE_PORT),
        DB_BACKEND: 'sqlite',
        ADMIN_ID: 'parity',
        ADMIN_PW: ADMIN_KEY,
        OPERATION_KEY,
    }, SQLITE_LOG);

    console.log(colored(`▶ PG 서버 부팅 (port ${PG_PORT}) ...`, 'gray'));
    const pgServer = spawnServer('pg', {
        PORT: String(PG_PORT),
        DB_BACKEND: 'postgres',
        DATABASE_URL: PG_CONN,
        ADMIN_ID: 'parity',
        ADMIN_PW: ADMIN_KEY,
        OPERATION_KEY,
    }, PG_LOG);

    const cleanup = () => {
        try { sqliteServer.kill('SIGTERM'); } catch (_) {}
        try { pgServer.kill('SIGTERM'); } catch (_) {}
    };
    process.on('SIGINT', () => { cleanup(); process.exit(2); });

    try {
        await Promise.all([
            waitForBoot(SQLITE_PORT, 'sqlite'),
            waitForBoot(PG_PORT, 'pg'),
        ]);
        console.log(colored('✓ 양쪽 서버 모두 준비 완료', 'green'));
        console.log('');

        // 2) 시나리오 순차 실행
        const sqliteCtx = {};
        const pgCtx = {};
        let pass = 0, fail = 0;
        const failures = [];

        for (const step of SCENARIO) {
            let sqlR, pgR;
            try {
                sqlR = await step.run(SQLITE_PORT, sqliteCtx);
            } catch (e) {
                console.log(`  ${colored('✗', 'red')} ${step.name}  [sqlite request failed: ${e.message}]`);
                fail++;
                failures.push({ name: step.name, reason: 'sqlite-error', detail: e.message });
                continue;
            }
            try {
                pgR = await step.run(PG_PORT, pgCtx);
            } catch (e) {
                console.log(`  ${colored('✗', 'red')} ${step.name}  [pg request failed: ${e.message}]`);
                fail++;
                failures.push({ name: step.name, reason: 'pg-error', detail: e.message });
                continue;
            }

            const sqlNorm = { status: sqlR.status, body: normalize(sqlR.body) };
            const pgNorm = { status: pgR.status, body: normalize(pgR.body) };

            if (jsonEqual(sqlNorm, pgNorm)) {
                pass++;
                console.log(`  ${colored('✓', 'green')} ${step.name}  (status=${sqlR.status})`);
            } else {
                fail++;
                console.log(`  ${colored('✗', 'red')} ${step.name}`);
                console.log(`     ${colored('sqlite:', 'gray')} ${JSON.stringify(sqlNorm).slice(0, 200)}`);
                console.log(`     ${colored('   pg :', 'gray')} ${JSON.stringify(pgNorm).slice(0, 200)}`);
                failures.push({
                    name: step.name,
                    reason: 'mismatch',
                    sqlite: sqlNorm,
                    pg: pgNorm,
                });
            }
        }

        console.log('');
        console.log(colored('───────────────────────────────────────────────────────', 'blue'));
        console.log(`  결과: ${colored(pass + ' pass', 'green')} / ${colored(fail + ' fail', fail ? 'red' : 'gray')} / total ${SCENARIO.length}`);
        console.log(colored('═══════════════════════════════════════════════════════', 'blue'));

        if (failures.length) {
            console.log('');
            console.log(colored('상세 실패:', 'red'));
            for (const f of failures) {
                console.log(`  - ${f.name}  [${f.reason}]`);
                if (f.detail) console.log(`      ${f.detail}`);
            }
        }

        cleanup();
        process.exit(fail ? 1 : 0);
    } catch (e) {
        console.error(colored('FATAL: ' + e.message, 'red'));
        console.error(`  SQLite log: ${SQLITE_LOG}`);
        console.error(`  PG log    : ${PG_LOG}`);
        cleanup();
        process.exit(2);
    }
}

main();
