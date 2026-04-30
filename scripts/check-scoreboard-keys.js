#!/usr/bin/env node
/**
 * 스코어보드 키 진단 스크립트
 * 서버에서 실행: node scripts/check-scoreboard-keys.js
 */
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'db', 'competition.db');
const db = new Database(DB_PATH);

// 1. heat 테이블 컬럼 확인
console.log('=== heat 테이블 컬럼 ===');
const cols = db.prepare('PRAGMA table_info(heat)').all();
cols.forEach(c => console.log(`  ${c.name} (${c.type}) default=${c.dflt_value}`));
const hasSbKey = cols.some(c => c.name === 'scoreboard_key');
console.log(`\n  scoreboard_key 컬럼 존재: ${hasSbKey ? '✅ YES' : '❌ NO'}`);

if (!hasSbKey) {
    console.log('\n❌ scoreboard_key 컬럼이 없습니다. pm2 restart 후 다시 확인하세요.');
    process.exit(1);
}

// 2. 데이터 확인
const total = db.prepare('SELECT COUNT(*) as cnt FROM heat').get().cnt;
const withKey = db.prepare("SELECT COUNT(*) as cnt FROM heat WHERE scoreboard_key IS NOT NULL AND scoreboard_key != ''").get().cnt;
const withoutKey = total - withKey;

console.log(`\n=== 데이터 현황 ===`);
console.log(`  총 heat: ${total}`);
console.log(`  scoreboard_key 있음: ${withKey} ✅`);
console.log(`  scoreboard_key 없음 (NULL): ${withoutKey} ${withoutKey > 0 ? '⚠️' : '✅'}`);

// 3. 키 있는 heat 샘플
if (withKey > 0) {
    console.log(`\n=== scoreboard_key 있는 heat (상위 10개) ===`);
    const keys = db.prepare(`
        SELECT h.id, h.heat_number, h.scoreboard_key, e.name, e.gender, e.round_type
        FROM heat h JOIN event e ON e.id = h.event_id
        WHERE h.scoreboard_key IS NOT NULL
        ORDER BY h.id LIMIT 10
    `).all();
    keys.forEach(k => console.log(`  Heat ${k.id}: ${k.scoreboard_key} (${k.name} ${k.gender} ${k.round_type} ${k.heat_number}조)`));
}

// 4. 키 없는 heat 샘플
if (withoutKey > 0) {
    console.log(`\n=== scoreboard_key 없는 heat (상위 10개) ===`);
    const noKeys = db.prepare(`
        SELECT h.id, h.heat_number, e.name, e.gender, e.round_type, e.competition_id
        FROM heat h JOIN event e ON e.id = h.event_id
        WHERE h.scoreboard_key IS NULL
        ORDER BY h.id LIMIT 10
    `).all();
    noKeys.forEach(k => console.log(`  Heat ${k.id}: (NULL) — ${k.name} ${k.gender} ${k.round_type} ${k.heat_number}조 [comp ${k.competition_id}]`));
}

// 5. 연맹 gender_label 확인
console.log(`\n=== 연맹 성별 표시명 ===`);
try {
    const feds = db.prepare('SELECT * FROM federation_list').all();
    if (feds.length === 0) {
        console.log('  ⚠️ 등록된 연맹이 없습니다.');
    } else {
        feds.forEach(f => {
            console.log(`  ${f.code} (${f.name}): 남=${f.gender_label_m || 'NULL'}, 여=${f.gender_label_f || 'NULL'}, 혼성=${f.gender_label_x || 'NULL'}`);
        });
    }
} catch(e) {
    console.log('  ⚠️ federation_list 테이블 접근 실패:', e.message);
}

console.log('\n=== 진단 완료 ===');
if (withoutKey > 0) {
    console.log('⚠️  scoreboard_key가 NULL인 heat가 있습니다.');
    console.log('   해결: 1) 연맹 관리에서 성별 표시명 설정');
    console.log('         2) 조편성 엑셀 재업로드');
    console.log('         또는 종목관리에서 🔑키 수동 입력');
}
