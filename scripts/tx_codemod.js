#!/usr/bin/env node
/**
 * tx_codemod.js — db.transaction() 호출에 누락된 await 추가 (Phase 2-G G-1)
 *
 * 변환 대상 (자동, 안전):
 *   1) `db.transaction(async () => {...})()` 한 줄 또는 여러 줄 IIFE
 *      → `await db.transaction(async () => {...})()`
 *   2) `const txn = db.transaction(async () => {...}); txn();`
 *      → `const txn = db.transaction(async () => {...}); await txn();`
 *
 * 변환 제외 (수동 처리):
 *   - `db.transaction(() => {...})` sync 콜백 — stmt 변수 의존, 인라인화 필요
 *
 * 사용:
 *   node scripts/tx_codemod.js [--dry] [--file server.js]
 */

const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const fileArg = argv.find(a => a.startsWith('--file='));
const FILE = fileArg ? fileArg.slice('--file='.length) : 'server.js';

const filePath = path.resolve(FILE);
const source = fs.readFileSync(filePath, 'utf8');

const ast = acorn.parse(source, {
    ecmaVersion: 2022, sourceType: 'script',
    locations: true, ranges: true
});

// parent map
const parentMap = new Map();
walk.fullAncestor(ast, (node, _state, ancestors) => {
    if (ancestors.length > 1) parentMap.set(node, ancestors[ancestors.length - 2]);
});

function enclosingFunction(node) {
    let cur = parentMap.get(node);
    while (cur) {
        if (cur.type === 'FunctionDeclaration'
         || cur.type === 'FunctionExpression'
         || cur.type === 'ArrowFunctionExpression') return cur;
        cur = parentMap.get(cur);
    }
    return null;
}

// db.transaction(...)을 모두 찾고, 그 결과가 어떻게 사용되는지 추적
const transactionCalls = [];   // CallExpression: db.transaction(fn)

walk.simple(ast, {
    CallExpression(node) {
        const c = node.callee;
        if (c.type === 'MemberExpression'
         && c.object.type === 'Identifier' && c.object.name === 'db'
         && c.property.type === 'Identifier' && c.property.name === 'transaction') {
            transactionCalls.push(node);
        }
    }
});

const edits = [];           // {start, end, text, kind, line}
const funcsToAsync = new Set();
const skipped = [];

const asyncFuncsToAsync = (fn, reason) => {
    if (!fn) return; // top-level은 별도 처리 안 함
    if (!fn.async) funcsToAsync.add(fn);
};

for (const txCall of transactionCalls) {
    const lineNo = txCall.loc.start.line;
    const cb = txCall.arguments[0];
    if (!cb) {
        skipped.push({ line: lineNo, reason: 'no callback arg' });
        continue;
    }
    const cbIsAsync = (cb.type === 'ArrowFunctionExpression' || cb.type === 'FunctionExpression') && cb.async;

    // 부모 컨텍스트 살피기
    const parent = parentMap.get(txCall);

    // Case 1: 변수 저장 — VariableDeclarator의 init이 db.transaction(...)인 경우
    //   const txn = db.transaction(...);
    //   ⇒ 여기서는 변환 안 하고, txn() 호출 사이트에서 await 추가
    if (parent && parent.type === 'VariableDeclarator') {
        // txn 변수 이름 추출
        const declId = parent.id;
        if (declId.type !== 'Identifier') {
            skipped.push({ line: lineNo, reason: 'destructured txn var' });
            continue;
        }
        if (!cbIsAsync) {
            skipped.push({ line: lineNo, reason: 'sync-stored — manual inline needed', kind: 'sync-stored' });
            continue;
        }
        // async-stored → 변수 호출 사이트 찾기 (선언의 enclosing scope 안에서만)
        const txnName = declId.name;
        const declScope = enclosingFunction(parent) || ast;  // 모듈 top-level이면 ast 전체
        let callSitesFound = 0;
        walk.simple(declScope, {
            CallExpression(cnode) {
                if (cnode.callee.type === 'Identifier' && cnode.callee.name === txnName) {
                    // 이미 await가 앞에 있나?
                    const par = parentMap.get(cnode);
                    if (par && par.type === 'AwaitExpression') return;
                    const fn = enclosingFunction(cnode);
                    asyncFuncsToAsync(fn);
                    edits.push({
                        start: cnode.start, end: cnode.start, text: 'await ',
                        kind: 'async-stored-call', line: cnode.loc.start.line
                    });
                    callSitesFound++;
                }
            }
        });
        if (callSitesFound === 0) {
            skipped.push({ line: lineNo, reason: `async-stored: no call site of ${txnName}` });
        }
        continue;
    }

    // Case 2: IIFE — db.transaction(...)() 형태 — parent가 CallExpression이고 callee가 txCall
    if (parent && parent.type === 'CallExpression' && parent.callee === txCall) {
        // IIFE: parent는 (txCall)(...) 호출
        // 이미 await가 더 위에 있는지 확인
        const grand = parentMap.get(parent);
        if (grand && grand.type === 'AwaitExpression') {
            skipped.push({ line: lineNo, reason: 'already awaited' });
            continue;
        }
        if (!cbIsAsync) {
            // sync IIFE — 수동 필요 (stmt 변수 의존)
            skipped.push({ line: lineNo, reason: 'sync-iife — manual inline needed', kind: 'sync-iife' });
            continue;
        }
        // async-iife → 앞에 'await ' 삽입 (IIFE 전체 expr 앞에)
        const fn = enclosingFunction(parent);
        if (!fn) {
            skipped.push({ line: lineNo, reason: 'top-level async-iife — skip', kind: 'top-level' });
            continue;
        }
        asyncFuncsToAsync(fn);
        edits.push({
            start: parent.start, end: parent.start, text: 'await ',
            kind: 'async-iife', line: lineNo
        });
        continue;
    }

    // 그 외 (passing to other fn 등) — skip
    skipped.push({ line: lineNo, reason: 'other usage (not IIFE, not var decl)' });
}

// 함수에 async 키워드 추가 — 시작 위치는 함수 종류별로 다름
for (const fn of funcsToAsync) {
    if (fn.async) continue;
    if (fn.type === 'FunctionDeclaration' || fn.type === 'FunctionExpression') {
        // 'function' 키워드 앞
        edits.push({
            start: fn.start, end: fn.start, text: 'async ',
            kind: 'mark-async', line: fn.loc.start.line
        });
    } else if (fn.type === 'ArrowFunctionExpression') {
        edits.push({
            start: fn.start, end: fn.start, text: 'async ',
            kind: 'mark-async', line: fn.loc.start.line
        });
    }
}

// 끝 → 시작 순 정렬, end가 같으면 start가 큰 게 먼저 (역순)
edits.sort((a, b) => (b.end - a.end) || (b.start - a.start));

let out = source;
for (const e of edits) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
}

// 통계
const byKind = {};
for (const e of edits) byKind[e.kind] = (byKind[e.kind] || 0) + 1;

console.log('=== tx_codemod result ===');
console.log(`File: ${filePath}`);
console.log(`Transactions found: ${transactionCalls.length}`);
console.log(`Edits to apply: ${edits.length}`);
for (const [k, n] of Object.entries(byKind)) console.log(`  ${k.padEnd(20)} : ${n}`);
console.log(`Skipped: ${skipped.length}`);
const skipByReason = {};
for (const s of skipped) skipByReason[s.kind || s.reason.split(' ')[0]] = (skipByReason[s.kind || s.reason.split(' ')[0]] || 0) + 1;
for (const [k, n] of Object.entries(skipByReason)) console.log(`  skip ${k.padEnd(16)} : ${n}`);
if (skipped.length && skipped.length < 30) {
    console.log('\nSkip details:');
    for (const s of skipped) console.log(`  L${s.line}: ${s.reason}`);
}

if (DRY) {
    console.log('\n[dry] not writing file');
} else {
    fs.writeFileSync(filePath, out, 'utf8');
    console.log(`\nWritten: ${filePath}`);
}
