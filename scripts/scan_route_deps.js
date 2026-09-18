#!/usr/bin/env node
/**
 * scripts/scan_route_deps.js — 추출된 라우트 모듈의 "미주입 헬퍼" 정적 탐지
 * ------------------------------------------------------------------
 * server.js → lib/routes/* 모듈 분리 시, server.js 헬퍼를 deps 로 넘기지 않고
 * 호출하면 런타임 ReferenceError(=500/기능무력화)가 발생한다(2026-06 audit/
 * parseDbTimestampMs/requireAdminAfterCompEnd/timetable 버그 사례).
 *
 * 이 스크립트는 각 모듈에서 "호출되지만 deps·로컬·require·빌트인 어디에도 없는"
 * camelCase 식별자를 찾아 경고한다. 새 모듈을 추출할 때마다 돌릴 것.
 *
 * 사용: node scripts/scan_route_deps.js   (의심 0건이면 종료코드 0)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'lib', 'routes');

const BUILTIN = new Set(['parseInt', 'parseFloat', 'isNaN', 'isFinite', 'toFixed', 'toString', 'valueOf',
    'toLowerCase', 'toUpperCase', 'charCodeAt', 'charAt', 'fromCharCode', 'padStart', 'padEnd', 'indexOf',
    'lastIndexOf', 'findIndex', 'flatMap', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
    'encodeURIComponent', 'decodeURIComponent', 'hasOwnProperty', 'toISOString', 'getTime', 'isArray']);

let found = 0;
for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const deps = new Set();
    const dm = src.match(/const\s*\{([\s\S]*?)\}\s*=\s*deps/);
    if (dm) dm[1].split(',').forEach(s => { const n = s.trim().split(':')[0].trim(); if (n) deps.add(n); });

    const local = new Set();
    let m;
    const reLocal = /\b(?:function\s+([a-zA-Z_$][\w$]*)|(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=)/g;
    while ((m = reLocal.exec(src))) local.add(m[1] || m[2]);
    const reReq = /const\s*\{([^}]*)\}\s*=\s*require/g;
    while ((m = reReq.exec(src))) m[1].split(',').forEach(s => { const n = s.trim().split(':')[0].trim(); if (n) local.add(n); });

    const calls = new Set();
    const reCall = /(?<![.\w$])([a-zA-Z_$][\w$]*)\s*\(/g;
    while ((m = reCall.exec(src))) calls.add(m[1]);

    // camelCase 헬퍼만 (SQL ALL_CAPS·snake_case 테이블명 제외)
    const suspects = [...calls].filter(c =>
        /^[a-z_][a-z0-9_]*[A-Z]/.test(c) && !deps.has(c) && !local.has(c) && !BUILTIN.has(c));
    if (suspects.length) {
        found += suspects.length;
        console.log(`🔴 [${f}] 미주입 의심: ${suspects.join(', ')}`);
    }
}
if (!found) {
    console.log('✅ 미주입 헬퍼 의심 없음');
    process.exit(0);
}
console.log(`\n⚠️  ${found}건 — typeof 가드로 처리됐거나 의도된 경우가 아니면 deps 주입 필요.`);
process.exit(1);
