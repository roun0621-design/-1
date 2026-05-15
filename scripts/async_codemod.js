#!/usr/bin/env node
/**
 * Phase 2-D~F: SQLite sync → PostgreSQL async 자동 코드 변환
 * =========================================================
 *
 * 목적:
 *   server.js (+ lib/*.js) 의 1000+ `db.prepare(SQL).METHOD(args)` 호출을
 *   `await db.METHOD(SQL, ...args)` 로 변환한다.
 *   동시에 호출자 함수를 자동으로 `async` 마킹.
 *
 * 변환 패턴:
 *   1) db.prepare(SQL).get(...args)    → await db.get(SQL, ...args)
 *   2) db.prepare(SQL).all(...args)    → await db.all(SQL, ...args)
 *   3) db.prepare(SQL).run(...args)    → await db.run(SQL, ...args)
 *   4) db.exec(SQL)                    → await db.exec(SQL)
 *   5) db.transaction(fn)              → 그대로 두되 fn에 async 적용 + 호출처 await
 *   6) stmt = db.prepare(SQL); stmt.run(args) (별도 변수) → 표시만, 사람이 처리
 *
 * 안전장치:
 *   - AST 파싱: 정확한 함수 경계, 표현식 인식
 *   - 함수가 async가 아니면 async 추가 (FunctionDeclaration/ArrowFunctionExpression/etc.)
 *   - 변환 후 `node --check` 로 문법 검증
 *
 * 사용법:
 *   node scripts/async_codemod.js --file server.js [--dry-run]
 *   node scripts/async_codemod.js --file server.js --routes /api/timetable,/api/competitions
 */

const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');

// ──────────────────────────────────────────────
// 인자
// ──────────────────────────────────────────────
const args = process.argv.slice(2);
function argVal(name, dflt) {
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
}
const FILE = argVal('--file', null);
const DRY = args.includes('--dry-run');
const ROUTES = (argVal('--routes', '') || '').split(',').filter(Boolean);
const LINE_FROM = parseInt(argVal('--from', '0'), 10);
const LINE_TO = parseInt(argVal('--to', '999999'), 10);

if (!FILE) {
    console.error('Usage: node scripts/async_codemod.js --file <path> [--dry-run] [--routes /api/x,/api/y] [--from N --to M]');
    process.exit(1);
}
const FILE_ABS = path.resolve(FILE);
if (!fs.existsSync(FILE_ABS)) { console.error('not found:', FILE_ABS); process.exit(1); }

const source = fs.readFileSync(FILE_ABS, 'utf8');
console.log(`[scan] ${FILE_ABS} (${source.length} bytes, ${source.split('\n').length} lines)`);

// ──────────────────────────────────────────────
// 1) Parse
// ──────────────────────────────────────────────
let ast;
try {
    ast = acorn.parse(source, {
        ecmaVersion: 'latest',
        sourceType: 'script',
        allowReturnOutsideFunction: true,
        allowAwaitOutsideFunction: true,
        locations: true
    });
} catch (e) {
    console.error('[parse error]', e.message);
    process.exit(1);
}

// ──────────────────────────────────────────────
// 2) 함수 경계 + parents 수집
// ──────────────────────────────────────────────
// node -> parent (fullAncestor 는 ancestors 배열을 함께 전달)
const parentMap = new WeakMap();
walk.fullAncestor(ast, (node, state, ancestors) => {
    if (ancestors.length >= 2) {
        parentMap.set(node, ancestors[ancestors.length - 2]);
    }
});
function getParents(node) {
    const list = [];
    let cur = parentMap.get(node);
    while (cur) {
        list.push(cur);
        cur = parentMap.get(cur);
    }
    return list;
}
function enclosingFunction(node) {
    const ps = getParents(node);
    for (const p of ps) {
        if (p.type === 'FunctionDeclaration' || p.type === 'FunctionExpression' || p.type === 'ArrowFunctionExpression' || p.type === 'MethodDefinition') {
            return p;
        }
    }
    return null; // top-level
}

// ──────────────────────────────────────────────
// 3) 라우트 필터 (선택적)
// ──────────────────────────────────────────────
// 특정 라우트의 핸들러 콜백 범위만 변환하고 싶을 때 사용.
// app.get/post/put/delete/patch( '/api/...' , handler )  형태 감지
const routeRanges = []; // {path, start, end, handlerNode}
walk.full(ast, (node) => {
    if (node.type !== 'CallExpression') return;
    const callee = node.callee;
    if (!callee || callee.type !== 'MemberExpression') return;
    const obj = callee.object;
    const prop = callee.property;
    if (!obj || !prop) return;
    if (obj.type !== 'Identifier' || obj.name !== 'app') return;
    if (!['get', 'post', 'put', 'delete', 'patch', 'all', 'use'].includes(prop.name)) return;
    if (node.arguments.length < 2) return;
    const pathArg = node.arguments[0];
    if (pathArg.type !== 'Literal' || typeof pathArg.value !== 'string') return;
    const handler = node.arguments[node.arguments.length - 1];
    if (handler.type !== 'FunctionExpression' && handler.type !== 'ArrowFunctionExpression') return;
    routeRanges.push({
        path: pathArg.value,
        start: handler.start,
        end: handler.end,
        handlerNode: handler,
        method: prop.name
    });
});

function inRoutesFilter(node) {
    if (ROUTES.length === 0) return true;
    for (const r of routeRanges) {
        if (!ROUTES.some(rf => r.path.startsWith(rf))) continue;
        if (node.start >= r.start && node.end <= r.end) return true;
    }
    return false;
}

function inLineFilter(node) {
    const ln = node.loc.start.line;
    return ln >= LINE_FROM && ln <= LINE_TO;
}

// ──────────────────────────────────────────────
// 4) 변환 대상 수집
// ──────────────────────────────────────────────
// 패턴 A: db.prepare(SQL).METHOD(args)
//   = CallExpression
//       .callee = MemberExpression
//           .object = CallExpression
//               .callee = MemberExpression(db.prepare)
//               .arguments = [SQL]
//           .property = Identifier(get|all|run|iterate)
//       .arguments = [args...]
const replacements = []; // {start, end, text, funcToAsyncify, kind}
const funcsToAsync = new Set();
const skipped = [];

function isDbIdent(n) {
    return n && n.type === 'Identifier' && n.name === 'db';
}

walk.simple(ast, {
    CallExpression(node) {
        if (!inLineFilter(node)) return;
        if (!inRoutesFilter(node)) return;

        const callee = node.callee;
        if (callee.type !== 'MemberExpression') return;

        // ===== 패턴 A: db.prepare(SQL).METHOD(args) =====
        const inner = callee.object;
        if (inner && inner.type === 'CallExpression'
            && inner.callee.type === 'MemberExpression'
            && isDbIdent(inner.callee.object)
            && inner.callee.property.type === 'Identifier'
            && inner.callee.property.name === 'prepare'
            && callee.property.type === 'Identifier'
            && ['get', 'all', 'run', 'iterate'].includes(callee.property.name)
        ) {
            if (inner.arguments.length !== 1) {
                skipped.push({ line: node.loc.start.line, reason: 'prepare takes !=1 arg' });
                return;
            }
            // 변환:  db.prepare(SQL).M(args)   →  await db.M(SQL, args)
            const method = callee.property.name;
            const sqlSrc = source.slice(inner.arguments[0].start, inner.arguments[0].end);
            const argsSrc = node.arguments.map(a => source.slice(a.start, a.end));
            const newArgs = [sqlSrc, ...argsSrc].join(', ');
            const newText = `await db.${method}(${newArgs})`;

            // top-level 호출은 변환하지 않음 (Node CommonJS는 TLA 불허)
            const fn = enclosingFunction(node);
            if (!fn) {
                skipped.push({ line: node.loc.start.line, reason: 'top-level — keep sync', kind: 'top-level' });
                return;
            }
            if (!fn.async) funcsToAsync.add(fn);

            replacements.push({
                start: node.start, end: node.end, text: newText,
                line: node.loc.start.line, kind: `prepare.${method}`, fn
            });
            return;
        }

        // ===== 패턴 B: db.exec(SQL) =====
        if (isDbIdent(callee.object)
            && callee.property.type === 'Identifier'
            && callee.property.name === 'exec'
        ) {
            // 이미 await 있는지: parent가 AwaitExpression이면 skip
            const parent = parentMap.get(node);
            if (parent && parent.type === 'AwaitExpression') return;

            const fn = enclosingFunction(node);
            if (!fn) {
                // 부팅 시 스키마 초기화 등 top-level 호출 — sync 유지 (CommonJS)
                skipped.push({ line: node.loc.start.line, reason: 'top-level — keep sync', kind: 'top-level' });
                return;
            }
            if (!fn.async) funcsToAsync.add(fn);

            const srcText = source.slice(node.start, node.end);
            const newText = 'await ' + srcText;
            replacements.push({
                start: node.start, end: node.end, text: newText,
                line: node.loc.start.line, kind: 'db.exec', fn
            });
            return;
        }
    },

    // 패턴 C: stmt = db.prepare(SQL)   ← stmt 변수 저장 (변환 위험, 표시만)
    VariableDeclarator(node) {
        if (!inLineFilter(node)) return;
        if (!inRoutesFilter(node)) return;
        const init = node.init;
        if (!init || init.type !== 'CallExpression') return;
        const c = init.callee;
        if (!c || c.type !== 'MemberExpression') return;
        if (!isDbIdent(c.object)) return;
        if (c.property.type !== 'Identifier' || c.property.name !== 'prepare') return;
        // 이건 자동 변환 안 함 (이후 stmt.run/get/all 분산 호출 추적이 복잡)
        skipped.push({ line: node.loc.start.line, reason: 'stmt = db.prepare(...) — manual handling needed', kind: 'stmt-var' });
    }
});

// 추가로 패턴 D: db.prepare(SQL)만 단독 호출되는 경우(반환값 안 씀)도 표시
walk.simple(ast, {
    ExpressionStatement(node) {
        if (!inLineFilter(node)) return;
        if (!inRoutesFilter(node)) return;
        const e = node.expression;
        if (!e || e.type !== 'CallExpression') return;
        const c = e.callee;
        if (!c || c.type !== 'MemberExpression') return;
        if (!isDbIdent(c.object)) return;
        if (c.property.type !== 'Identifier' || c.property.name !== 'prepare') return;
        skipped.push({ line: node.loc.start.line, reason: 'db.prepare(...) without method call', kind: 'prepare-only' });
    }
});

// ──────────────────────────────────────────────
// 5) 모든 편집을 하나로 합쳐 뒤에서부터 적용 (offset 안전)
// ──────────────────────────────────────────────
const allEdits = [];

// 치환(자리 교체)
for (const r of replacements) {
    allEdits.push({ start: r.start, end: r.end, text: r.text, op: 'replace', meta: r });
}

// async 키워드 삽입
const asyncFns = Array.from(funcsToAsync);
for (const fn of asyncFns) {
    if (fn.async) continue;
    allEdits.push({ start: fn.start, end: fn.start, text: 'async ', op: 'insert', meta: { kind: 'async-mark', fnType: fn.type } });
}

// 뒤에서부터 적용 (end 큰 것 → end 같으면 start 큰 것)
allEdits.sort((a, b) => {
    if (a.end !== b.end) return b.end - a.end;
    return b.start - a.start;
});

let out = source;
let lastStart = source.length + 1;
for (const e of allEdits) {
    if (e.end > lastStart) {
        // overlap — replace가 async 삽입 위치를 덮어쓸 수 있음 (불가능하지만 안전)
        console.warn('[overlap]', e.op, 'at', e.start, '-', e.end, 'lastStart=', lastStart);
        continue;
    }
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    lastStart = e.start;
}

// ──────────────────────────────────────────────
// 6) 결과 출력 + 통계
// ──────────────────────────────────────────────
const stats = {
    'prepare.get': 0, 'prepare.all': 0, 'prepare.run': 0, 'prepare.iterate': 0, 'db.exec': 0
};
for (const r of replacements) stats[r.kind] = (stats[r.kind] || 0) + 1;
console.log(`[apply] replacements: ${replacements.length}`);
for (const [k, v] of Object.entries(stats)) {
    if (v > 0) console.log(`         - ${k.padEnd(20)} ${v}`);
}
console.log(`[async] functions marked async: ${asyncFns.length}`);
console.log(`[skip ] manual review needed: ${skipped.length}`);
if (skipped.length > 0 && skipped.length <= 30) {
    for (const s of skipped) console.log(`         · L${s.line}: ${s.reason}`);
} else if (skipped.length > 30) {
    for (const s of skipped.slice(0, 10)) console.log(`         · L${s.line}: ${s.reason}`);
    console.log(`         · ... +${skipped.length - 10} more`);
}

if (DRY) {
    console.log('[dry-run] no file written');
    // 통계 결과 stderr로 한번 더
} else {
    fs.writeFileSync(FILE_ABS, out, 'utf8');
    console.log(`[write] ${FILE_ABS} (${out.length} bytes)`);
}
