#!/usr/bin/env node
/**
 * PACERISE_upload_template.xlsx에 "휴대폰" 컬럼을 추가합니다.
 * - 선수명단 시트의 헤더에 "휴대폰" 추가 (바코드 앞에 삽입)
 * - 작성가이드 시트에 휴대폰 컬럼 설명 추가
 *
 * 사용: node scripts/update_template_phone.js
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

// 휴대폰 컬럼이 이미 있는지 확인
const phoneIdx = header.findIndex(h => /^(휴대폰|핸드폰|전화|전화번호|연락처|phone|phone_number|mobile)$/i.test(String(h || '').trim()));
const barcodeIdx = header.findIndex(h => /^(바코드|barcode|바코드번호)$/i.test(String(h || '').trim()));

let modified = false;
if (phoneIdx === -1) {
    // 바코드 앞에 삽입 (없으면 맨 끝)
    const insertAt = barcodeIdx >= 0 ? barcodeIdx : header.length;
    for (const row of rows) {
        row.splice(insertAt, 0, insertAt === barcodeIdx ? '휴대폰' : (row === rows[0] ? '휴대폰' : ''));
    }
    // 첫 행만 헤더로 추가, 데이터 행은 빈 칸으로 둠
    // 위 splice는 모든 행에 동일하게 빈 값을 삽입했으므로 헤더만 "휴대폰"이 되도록 보정
    rows[0][insertAt] = '휴대폰';
    for (let i = 1; i < rows.length; i++) {
        // 데이터 행: 휴대폰 위치는 빈 문자열
        if (rows[i][insertAt] === '휴대폰') rows[i][insertAt] = '';
    }
    modified = true;
    console.log(`[OK] 선수명단: '휴대폰' 컬럼 추가 (위치 ${insertAt})`);
} else {
    console.log(`[skip] 선수명단: 이미 '휴대폰' 컬럼 존재 (위치 ${phoneIdx})`);
}

if (modified) {
    // 새 시트 작성 후 워크북에 덮어쓰기
    const newWs = XLSX.utils.aoa_to_sheet(rows);
    // 컬럼 너비 보존이 필요하면 별도 처리 — 일단 자동
    // 휴대폰 컬럼은 폭 12
    newWs['!cols'] = newWs['!cols'] || [];
    const insertedIdx = rows[0].indexOf('휴대폰');
    if (insertedIdx >= 0) newWs['!cols'][insertedIdx] = { wch: 14 };

    wb.Sheets['선수명단'] = newWs;
}

// 작성가이드에 안내 추가
const guideWs = wb.Sheets['작성가이드'];
if (guideWs) {
    const guideRows = XLSX.utils.sheet_to_json(guideWs, { header: 1 });
    const hasPhoneNote = guideRows.some(r => r.some(c => /휴대폰.*문자|문자.*휴대폰|SMS/i.test(String(c || ''))));
    if (!hasPhoneNote) {
        guideRows.push(['']);
        guideRows.push(['=== 휴대폰 / 문자(SMS) 관련 ===']);
        guideRows.push(['• 선수명단 시트의 "휴대폰" 컬럼은 결과 안내 SMS 발송용입니다.']);
        guideRows.push(['• 형식: 01012345678 (하이픈, 공백 자동 제거됨)']);
        guideRows.push(['• 비워둬도 됩니다 — 비어 있는 선수는 SMS 발송 대상에서 자동 제외됩니다.']);
        guideRows.push(['• 이후 관리자 페이지의 "선수 관리" 탭에서 개별 수정 가능합니다.']);
        guideRows.push(['• 휴대폰만 업데이트하고 싶을 때는 "휴대폰 일괄 업로드" 기능을 사용하세요.']);
        const newGuide = XLSX.utils.aoa_to_sheet(guideRows);
        newGuide['!cols'] = [{ wch: 70 }];
        wb.Sheets['작성가이드'] = newGuide;
        modified = true;
        console.log('[OK] 작성가이드: 휴대폰 안내 7줄 추가');
    } else {
        console.log('[skip] 작성가이드: 이미 휴대폰 안내 있음');
    }
}

if (modified) {
    XLSX.writeFile(wb, TEMPLATE_PATH);
    fs.copyFileSync(TEMPLATE_PATH, ROOT_PATH);
    console.log('[saved]', TEMPLATE_PATH);
    console.log('[saved]', ROOT_PATH);
} else {
    console.log('[no changes]');
}
