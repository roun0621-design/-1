#!/usr/bin/env node
/**
 * HTTP 동시접속 부하 테스트 (읽기 경로 — 관중/스코어보드 동시 조회 시나리오)
 *
 * 목적: 다수 동시접속(관중·심판이 동시에 대시보드/결과를 조회) 상황에서
 *       서버 응답 latency 분포(p50/p95/p99/max)·처리량(req/s)·에러율 측정.
 *
 * ⚠️ 운영 서버(라이브 대회)에는 절대 돌리지 말 것. 로컬 격리 서버 전용.
 *
 * 실행:
 *   BASE=http://localhost:3000 CONCURRENCY=100 TOTAL=5000 node scripts/http_load_test.js
 */
'use strict';
const http = require('http');
const { URL } = require('url');

const BASE = process.env.BASE || 'http://localhost:3000';
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '100', 10);
const TOTAL = parseInt(process.env.TOTAL || '5000', 10);

// 실제 브라우저처럼 연결을 재사용(keep-alive). maxSockets = 동시성.
// (keep-alive 없이 매 요청 새 소켓을 열면 연결 폭주로 ECONNRESET → 서버 한계가 아닌 클라 한계 측정됨)
const agent = new http.Agent({ keepAlive: true, maxSockets: CONCURRENCY, maxFreeSockets: CONCURRENCY });

function get(path) {
    return new Promise((resolve) => {
        const u = new URL(path, BASE);
        const t0 = process.hrtime.bigint();
        const req = http.get(u, { agent }, (res) => {
            res.on('data', () => {});
            res.on('end', () => {
                const ms = Number(process.hrtime.bigint() - t0) / 1e6;
                resolve({ ok: res.statusCode >= 200 && res.statusCode < 400, code: res.statusCode, ms });
            });
        });
        req.on('error', () => resolve({ ok: false, code: 0, ms: Number(process.hrtime.bigint() - t0) / 1e6 }));
        req.setTimeout(15000, () => { req.destroy(); resolve({ ok: false, code: 0, ms: 15000 }); });
    });
}

function pct(sorted, p) {
    if (!sorted.length) return 0;
    const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[i];
}

(async () => {
    // 1) 조회할 대회/종목 id 발견
    let compId = 1, paths = ['/api/health', '/api/competitions'];
    try {
        const r = await get('/api/competitions');
        // 본문이 필요하므로 한 번 더 직접 fetch
    } catch (e) {}
    // 실제 id 탐색
    await new Promise((resolve) => {
        const u = new URL('/api/competitions', BASE);
        http.get(u, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => {
            try { const a = JSON.parse(d); const list = Array.isArray(a) ? a : (a.competitions || []); if (list[0]) compId = list[0].id; } catch (e) {}
            resolve();
        }); }).on('error', resolve);
    });
    paths = [
        '/api/health',
        '/api/competitions',
        `/api/events?competition_id=${compId}`,
        '/dashboard.html',
        '/api/health',
        `/api/events?competition_id=${compId}`,
    ];

    console.log(`[load] BASE=${BASE}  CONCURRENCY=${CONCURRENCY}  TOTAL=${TOTAL}  compId=${compId}`);
    console.log(`[load] paths: ${paths.join(' , ')}`);

    const results = [];
    let issued = 0;
    const t0 = Date.now();

    async function worker() {
        while (issued < TOTAL) {
            const i = issued++;
            if (i >= TOTAL) break;
            const p = paths[i % paths.length];
            results.push(await get(p));
        }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    const wall = (Date.now() - t0) / 1000;
    const lat = results.map(r => r.ms).sort((a, b) => a - b);
    const okCnt = results.filter(r => r.ok).length;
    const errCnt = results.length - okCnt;
    const fmt = n => n.toFixed(1);

    console.log('\n────────── 결과 ──────────');
    console.log(`총 요청      : ${results.length}`);
    console.log(`성공/에러    : ${okCnt} / ${errCnt}  (에러율 ${(errCnt / results.length * 100).toFixed(2)}%)`);
    console.log(`소요 시간    : ${fmt(wall)} s`);
    console.log(`처리량(RPS)  : ${fmt(results.length / wall)} req/s`);
    console.log(`동시성       : ${CONCURRENCY}`);
    console.log(`latency p50  : ${fmt(pct(lat, 50))} ms`);
    console.log(`latency p95  : ${fmt(pct(lat, 95))} ms`);
    console.log(`latency p99  : ${fmt(pct(lat, 99))} ms`);
    console.log(`latency max  : ${fmt(lat[lat.length - 1] || 0)} ms`);
    console.log('──────────────────────────');
    process.exit(errCnt > 0 ? 1 : 0);
})();
