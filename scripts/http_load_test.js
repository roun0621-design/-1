#!/usr/bin/env node
/**
 * 간단·재현 가능한 HTTP 부하 테스트 (외부 의존성 없음, Node http keep-alive)
 *
 * 사용:
 *   BASE=http://localhost:3100 CONCURRENCY=200 TOTAL=20000 node scripts/http_load_test.js
 *
 * 다수 관중/심판 동시 조회 상황을 읽기 부하로 재현한다.
 * 측정: 처리량(RPS), 지연 p50/p95/p99/max, 에러율.
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');

const BASE = process.env.BASE || 'http://localhost:3100';
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '100', 10);
const TOTAL = parseInt(process.env.TOTAL || '20000', 10);
const PATHS = (process.env.PATHS ||
  '/api/health,/api/competitions,/api/events,/dashboard.html').split(',');

const isHttps = BASE.startsWith('https');
const agent = new (isHttps ? https : http).Agent({
  keepAlive: true, maxSockets: CONCURRENCY + 10,
});
const client = isHttps ? https : http;

let done = 0, started = 0, errors = 0;
const lat = [];
let pi = 0;

function nextPath() { const p = PATHS[pi % PATHS.length]; pi++; return p; }

function one() {
  if (started >= TOTAL) return;
  started++;
  const path = nextPath();
  const u = new URL(BASE + path);
  const t0 = process.hrtime.bigint();
  const req = client.request(
    { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', agent },
    (res) => {
      res.on('data', () => {});
      res.on('end', () => {
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        lat.push(ms);
        if (res.statusCode >= 400) errors++;
        finish();
      });
    }
  );
  req.on('error', () => { errors++; finish(); });
  req.end();
}

function finish() {
  done++;
  if (started < TOTAL) one();
  if (done === TOTAL) report();
}

function pct(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

let startTime;
function report() {
  const elapsed = (Date.now() - startTime) / 1000;
  const rps = Math.round(done / elapsed);
  const out = {
    base: BASE, concurrency: CONCURRENCY, total: TOTAL,
    paths: PATHS, elapsed_s: +elapsed.toFixed(2),
    rps, errors, error_rate: +((errors / TOTAL) * 100).toFixed(3),
    p50: +pct(lat, 50).toFixed(1), p95: +pct(lat, 95).toFixed(1),
    p99: +pct(lat, 99).toFixed(1), max: +Math.max(...lat).toFixed(1),
  };
  console.log(JSON.stringify(out));
}

startTime = Date.now();
for (let i = 0; i < CONCURRENCY; i++) one();
