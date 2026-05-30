#!/usr/bin/env node
/**
 * PACERISE_upload_template.xlsx의 "휴대폰" 컬럼을 생년월일 ↔ 종목1 사이로 이동합니다.
 *
 * Before: [팀명, 선수명, 성별, 생년월일, 종목1, 종목2, ..., 4x800mR, 휴대폰, 바코드]
 * After:  [팀명, 선수명, 성별, 생년월일, 휴대폰, 종목1, 종목2, ..., 4x800mR, 바코드]
 *
 * 사용: node scripts/move_phone_column.js
 */
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');

const TEMPLATE_PATH = path.join(__dirname, '..', 'public', 'PACERISE_upload_template.xlsx');
const ROOT_PATH = path.join(__dirname, '..', 'PACERISE_upload_template.xlsx');

if (!fs.existsSync(TEMPLATE_PATH)) {
    console.error('Template not found:', TEMPLATE_PATH);
    process.exit(1);
}

const wb = XLSX.readFile(TEMPLATE_PATH);
const ws = wb.Sheets['선수명단'];
if (!ws) { console.error('선수명단 sheet not found'); process.exit(1); }

const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
const header = rows[0] || [];

const phoneIdx = header.findIndex(h => /^(휴대폰|핸드폰|전화|전화번호|연락처|phone|phone_number|mobile)$/i.test(String(h || '').trim()));
const birthIdx = header.findIndex(h => /^(생년월일|생일|birth|birthday|birth_date)$/i.test(String(h || '').trim()));

if (phoneIdx === -1) { console.error('휴대폰 컬럼이 없습니다.'); process.exit(1); }
if (birthIdx === -1) { console.error('생년월일 컬럼이 없습니다.'); process.exit(1); }

console.log(`현재 위치: 휴대폰=${phoneIdx}, 생년월일=${birthIdx}`);
console.log(`현재 헤더: [${header.join(', ')}]`);

// 목표 위치: 생년월일 바로 뒤
const targetIdx = birthIdx + 1;

if (phoneIdx === targetIdx) {
    console.log('[skip] 이미 생년월일 바로 뒤에 휴대폰이 있습니다.');
    process.exit(0);
}

// 모든 행에 대해 휴대폰 컬럼을 빼서 targetIdx에 삽입
// splice는 즉시 길이 변동 → 빼낸 후 삽입 위치 보정
for (const row of rows) {
    // 길이를 헤더 길이에 맞춤
    while (row.length < header.length) row.push('');
    const [v] = row.splice(phoneIdx, 1);   // 휴대폰 값을 뽑아냄
    // phoneIdx < targetIdx 이면 targetIdx는 그대로지만 인덱스 1 줄어듦 → targetIdx-1
    // phoneIdx > targetIdx 이면 targetIdx 그대로
    const insertAt = phoneIdx < targetIdx ? targetIdx - 1 : targetIdx;
    row.splice(insertAt, 0, v === undefined ? '' : v);
}

// 컬럼 너비도 동일하게 이동
const cols = ws['!cols'] || [];
while (cols.length < header.length) cols.push({});
const [phoneCol] = cols.splice(phoneIdx, 1);
const insertAt = phoneIdx < targetIdx ? targetIdx - 1 : targetIdx;
cols.splice(insertAt, 0, phoneCol || { wch: 14 });

// 새 시트 생성
const newWs = XLSX.utils.aoa_to_sheet(rows);
newWs['!cols'] = cols;

// 기존 셀 스타일/머지 보존을 위해 가능한 한 원본 메타도 옮김 (스타일은 xlsx 기본에서 보장 안 됨)
if (ws['!merges']) newWs['!merges'] = ws['!merges'];

wb.Sheets['선수명단'] = newWs;

XLSX.writeFile(wb, TEMPLATE_PATH);
fs.copyFileSync(TEMPLATE_PATH, ROOT_PATH);

console.log(`[OK] 휴대폰 이동: ${phoneIdx} → ${insertAt}`);
console.log(`새 헤더: [${rows[0].join(', ')}]`);
console.log('[saved]', TEMPLATE_PATH);
console.log('[saved]', ROOT_PATH);
