#!/usr/bin/env node
/**
 * scripts/scan_schema_parity.js — SQLite/PG 스키마 비대칭(누락 테이블) 정적 탐지
 * ------------------------------------------------------------------
 * 버그 사례(2026-06): 상장(certificate_template/certificate_issue_log)·문자
 * (sms_config/sms_log) 테이블이 server.js 의 SQLite 전용 부트 블록
 * (`if (!db.isAsync)` 내 `db.exec(CREATE TABLE ...)`)에서만 생성되고,
 * db/schema.pg.sql 에도 PG 런타임 마이그레이션(`db.run(CREATE TABLE ...)`)에도
 * 빠져 있어 → 운영 PostgreSQL 에서 "relation does not exist" 로 기능이 깨졌다.
 * 테스트는 SQLite 로만 돌아 이 비대칭을 잡지 못한다.
 *
 * 이 스크립트는 SQLite 부트에서 만들어지는 모든 테이블이 PG 쪽
 * (schema.pg.sql 또는 PG 런타임 마이그레이션)에서도 생성되는지 검사한다.
 *
 * 사용: node scripts/scan_schema_parity.js   (누락 0건이면 종료코드 0)
 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const pgSchema = fs.readFileSync(path.join(root, 'db', 'schema.pg.sql'), 'utf8');

// CREATE TABLE [IF NOT EXISTS] "?<name>"? 에서 테이블명 추출
const tableNames = (src, fnPattern) => {
    const out = new Set();
    // fnPattern 으로 db.exec(/db.run( 호출 안의 CREATE TABLE 만 좁히고 싶지만,
    // 단순·견고하게: 호출명 직후 백틱 안의 CREATE TABLE 을 스캔
    const re = new RegExp(fnPattern + String.raw`\s*\(\s*` + '`' + String.raw`\s*CREATE TABLE(?:\s+IF NOT EXISTS)?\s+"?([a-zA-Z_][\w]*)"?`, 'gi');
    let m;
    while ((m = re.exec(src))) out.add(m[1]);
    return out;
};

// SQLite 부트 블록: db.exec(`CREATE TABLE ...`)
const sqliteTables = tableNames(serverSrc, String.raw`db\.exec`);
// PG 런타임 마이그레이션: db.run(`CREATE TABLE ...`)
const pgRuntimeTables = tableNames(serverSrc, String.raw`db\.run`);
// schema.pg.sql 내 CREATE TABLE
const pgSchemaTables = new Set();
{
    const re = /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+"?([a-zA-Z_][\w]*)"?/gi;
    let m;
    while ((m = re.exec(pgSchema))) pgSchemaTables.add(m[1]);
}

const pgAll = new Set([...pgRuntimeTables, ...pgSchemaTables]);

// SQLite "테이블 재작성(rebuild)" 패턴의 임시 스크래치 테이블 — 생성 직후
// INSERT…SELECT 후 RENAME 되어 사라지므로 PG 대응이 불필요(PG는 ALTER 로 처리).
const IGNORE = new Set(['athlete_new', 'timetable_new']);

const missing = [...sqliteTables].filter(t => !pgAll.has(t) && !IGNORE.has(t)).sort();

console.log(`[schema-parity] SQLite 부트 테이블: ${sqliteTables.size}개, ` +
    `PG(schema+런타임) 테이블: ${pgAll.size}개`);

if (missing.length) {
    console.error(`\n❌ PG 쪽에 누락된 테이블 ${missing.length}개 ` +
        `(SQLite 부트에서만 생성됨 → 운영 PG 에서 깨짐):`);
    for (const t of missing) console.error(`   - ${t}`);
    console.error(`\n→ db/schema.pg.sql 과 server.js 의 PG 런타임 마이그레이션 블록` +
        `(if (db.isAsync) ...)에 추가하세요.`);
    process.exit(1);
}

console.log('✅ 누락 없음 — SQLite 부트 테이블이 모두 PG 쪽에도 정의됨.');
process.exit(0);
