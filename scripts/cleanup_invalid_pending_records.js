#!/usr/bin/env node
/**
 * 잘못 감지된 pending 신기록 후보 정리
 *
 * 배경:
 *   parseRecordValue가 "5,535" 같은 콤마 천단위 값을 5로 잘못 파싱하던 버그로
 *   잘못된 신기록 후보가 record_breaking_log에 쌓여 있을 수 있음.
 *   본 스크립트는 (1) 점수/시간 비교 방향과 일치하지 않는 케이스,
 *   (2) previous_value/new_value를 재파싱해서 방향 위반인 케이스를
 *   status='rejected'로 일괄 정리한다.
 *
 * 사용:
 *   node scripts/cleanup_invalid_pending_records.js          # dry-run (조회만)
 *   node scripts/cleanup_invalid_pending_records.js --apply  # 실제 정리
 */
const path = require('path');
const Database = require('better-sqlite3');
const { parseRecordValue, getCompareDirection } = require('../lib/recordCompare');

const APPLY = process.argv.includes('--apply');
const DB_PATH = path.join(__dirname, '..', 'db', 'competition.db');
const db = new Database(DB_PATH);

const logs = db.prepare(`
  SELECT rbl.id, rbl.event_name, rbl.record_type, rbl.previous_value, rbl.new_value, rbl.new_value_num,
         rbl.athlete_name, rbl.athlete_team, rbl.status,
         e.category, e.name AS event_full_name
  FROM record_breaking_log rbl
  LEFT JOIN event e ON e.id=rbl.event_id
  WHERE rbl.status='pending'
  ORDER BY rbl.id DESC
`).all();

const invalid = [];
for (const l of logs) {
    const dir = getCompareDirection(l.category);
    // combined은 getCompareDirection이 null을 반환 — 점수는 higher
    const realDir = (l.category === 'combined') ? 'higher' : dir;
    if (!realDir) continue; // 비교 안 하는 카테고리는 skip
    const prev = parseRecordValue(l.previous_value);
    const cur = l.new_value_num;
    if (prev == null || cur == null) continue; // 비교 불가
    const isBetter = (realDir === 'higher') ? (cur > prev) : (cur < prev);
    if (!isBetter) {
        invalid.push({ ...l, prev_parsed: prev, realDir });
    }
}

console.log(`전체 pending: ${logs.length}건 / 방향 위반: ${invalid.length}건\n`);
for (const l of invalid) {
    console.log(`  [${l.id}] ${l.record_type.toUpperCase()} ${l.event_name} (${l.category}) | ${l.athlete_name}(${l.athlete_team})`);
    console.log(`         prev="${l.previous_value}"(parsed=${l.prev_parsed}) → new="${l.new_value}"(num=${l.new_value_num}) | dir=${l.realDir}`);
}

if (invalid.length === 0) {
    console.log('정리할 대상 없음.');
    process.exit(0);
}

if (!APPLY) {
    console.log(`\n💡 실제 정리하려면 --apply 플래그 사용: node ${process.argv[1]} --apply`);
    process.exit(0);
}

const stmt = db.prepare(`UPDATE record_breaking_log
                         SET status='rejected',
                             reviewed_by='system',
                             reviewed_at=datetime('now'),
                             review_note='auto-cleanup: parseRecordValue 콤마 버그(2026-05-29 fix)로 인한 잘못된 감지'
                         WHERE id=?`);
let n = 0;
for (const l of invalid) {
    stmt.run(l.id);
    n++;
}
console.log(`\n✓ ${n}건을 'rejected'로 정리 완료.`);
db.close();
