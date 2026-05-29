#!/usr/bin/env node
/**
 * cleanup_bad_record_logs.js
 *
 * 잘못 감지된 record_breaking_log pending 행을 'rejected' 로 일괄 정리.
 *
 * 대상 (의심 케이스):
 *   - combined(10종/7종/5종) + field_distance + field_height 카테고리에서
 *     previous_value 가 콤마 포함 ("5,535" 같은) 인데 new_value_num 보다 큰 경우
 *   - 즉, 점수/거리/높이가 "악화"인데 신기록으로 감지된 모든 케이스
 *
 * 사용:
 *   node scripts/cleanup_bad_record_logs.js          # dry-run (보고만)
 *   node scripts/cleanup_bad_record_logs.js --apply  # 실제 정리 (rejected 처리)
 */
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'db', 'competition.db');
const APPLY = process.argv.includes('--apply');

const db = new Database(DB_PATH);

function parseRecordValueSafe(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    let s = String(v).trim().replace(/\s+/g, '').replace(/[,，]/g, '');
    if (!s) return null;
    if (s.includes(':')) {
        const parts = s.split(':').map(parseFloat);
        if (parts.some(isNaN)) return null;
        if (parts.length === 2) return parts[0] * 60 + parts[1];
        if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
        return null;
    }
    s = s.replace(/[mM]$/, '');
    const n = parseFloat(s);
    return isNaN(n) ? null : n;
}

function categoryDirection(category) {
    if (category === 'combined') return 'higher';
    if (category === 'field_distance' || category === 'field_height') return 'higher';
    if (category === 'track' || category === 'road' || category === 'relay') return 'lower';
    return null;
}

const rows = db.prepare(`
    SELECT rbl.id, rbl.record_type, rbl.event_name, rbl.previous_value, rbl.new_value,
           rbl.new_value_num, rbl.athlete_name, rbl.athlete_team, rbl.status,
           rbl.detected_at, e.category, e.parent_event_id
    FROM record_breaking_log rbl
    LEFT JOIN event e ON e.id=rbl.event_id
    WHERE rbl.status='pending'
    ORDER BY rbl.id DESC
`).all();

const bad = [];
for (const r of rows) {
    const direction = categoryDirection(r.category);
    if (!direction) continue;
    const oldNum = parseRecordValueSafe(r.previous_value);
    const newNum = r.new_value_num;
    if (oldNum == null || newNum == null) continue;
    const isImprovement = (direction === 'higher') ? newNum > oldNum : newNum < oldNum;
    if (!isImprovement) {
        bad.push({ ...r, direction, oldNum });
    }
}

console.log(`\n=== record_breaking_log cleanup (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===`);
console.log(`총 pending 행: ${rows.length}`);
console.log(`잘못 감지된 행: ${bad.length}\n`);

for (const b of bad) {
    console.log(`  [${b.id}] ${b.record_type.toUpperCase()} ${b.event_name} | ${b.athlete_name}(${b.athlete_team})`);
    console.log(`        prev="${b.previous_value}" (parsed=${b.oldNum}) → new="${b.new_value}" (num=${b.new_value_num})`);
    console.log(`        category=${b.category} direction=${b.direction} (악화인데 감지됨 — 거부 처리)`);
}

if (APPLY && bad.length > 0) {
    const stmt = db.prepare(`UPDATE record_breaking_log
        SET status='rejected',
            reviewed_by='system-cleanup',
            review_note='자동 정리: parseRecordValue 콤마 파싱 버그로 오감지된 케이스',
            reviewed_at=datetime('now')
        WHERE id=?`);
    const tx = db.transaction((ids) => { for (const id of ids) stmt.run(id); });
    tx(bad.map(b => b.id));
    console.log(`\n✓ ${bad.length}건 'rejected' 처리 완료.`);
} else if (!APPLY && bad.length > 0) {
    console.log(`\n실제 정리하려면: node scripts/cleanup_bad_record_logs.js --apply`);
} else {
    console.log(`\n정리할 항목 없음.`);
}

db.close();
