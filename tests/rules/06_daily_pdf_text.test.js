/**
 * [업로드] 연맹 데일리 PDF → 조편성 (lib/federationDailyPdf.js)
 *   PDF 에서 뽑은 글자는 칸이 붙어 있다("2106홍길동국립경국대학교(B)"). 끊는 위치는 등록 명단과 대조해 정한다.
 *   실제 PDF 는 실명이 들어 있어 저장소에 둘 수 없다 → 익명화된 연맹 xlsx 원본을 'PDF 글자 추출 모양'으로 바꿔 검증한다
 *   (모양은 2026 예천 대학부 2일차 PDF 의 추출 결과와 같다: 칸 붙음, 조 머리글 "1조레인번호성명소속", 성별 표시는 구간 뒤).
 */
const path = require('path');
const XLSX = require('xlsx');
const FD = require('../../lib/federationDaily');
const FP = require('../../lib/federationDailyPdf');
const FX = path.join(__dirname, '..', 'fixtures', 'yecheon2026');
const sheet = f => { const wb = XLSX.readFile(f); return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: false }); };
const t = v => String(v == null ? '' : v).trim();

// 연맹 배번 명단 원본 → 시스템 명단 모양
const rosterOf = key => sheet(path.join(FX, key, 'src_federation_bib_roster.xlsx')).slice(1).map(r => ({ name: t(r[6]), team: t(r[3]), gender: t(r[10]) === '남자' ? 'M' : 'F', bib_number: t(r[11]).replace(/^0+/, '') }));

// 연맹 xlsx(▣ 섹션형) → PDF 글자 추출 모양
function asPdfText(rows) {
    const probe = rows.find(r => r.some(c => t(c).startsWith('▣'))); const off = probe.findIndex(c => t(c).startsWith('▣'));
    const out = []; let pendingGender = null;
    for (const r0 of rows) {
        const full = r0.map(t); if (!full.some(Boolean)) continue;
        const first = full.find(Boolean);
        if (/^(남자|여자)?(대학교?부|실업부)$/.test(first)) { if (pendingGender) out.push(pendingGender); pendingGender = first; continue; }
        const c = full.slice(off);
        if (c[0].startsWith('▣')) out.push(c[0]);
        else if (/^\d+조$/.test(c[0])) out.push(c[0] + c.slice(1, 5).join(''));
        else out.push(c.slice(1, 5).join(''));                 // 레인+번호+성명+소속 이 한 덩어리
    }
    if (pendingGender) out.push(pendingGender);
    return out.join('\n');
}

describe('데일리 PDF 글자 → 조편성', () => {
    for (const [key, file] of [['univ', 'src_federation_daily_day2.xlsx'], ['univ', 'src_federation_daily_day3.xlsx'], ['pro', 'src_federation_daily_day3.xlsx']]) {
        it(`${key} ${file}: 붙어 나온 글자를 명단으로 끊어 xlsx 원본과 같은 결과 — 추정 0건`, () => {
            const rows = sheet(path.join(FX, key, file)), roster = rosterOf(key);
            const text = asPdfText(rows);
            expect(text).toMatch(/\n\d{2,}[가-힣]/);                                   // 정말 붙어 있는 모양인지
            const pdf = FP.textToDailyRows(text, roster);
            expect(pdf.issues).toEqual([]);
            const a = FD.convertIfFederationDaily(pdf.aoa, roster), b = FD.convertIfFederationDaily(rows, roster);
            expect(a.aoa).toEqual(b.aoa);
        });
    }
    it('명단에 없는 선수는 추정하되 반드시 "확인 필요"로 알린다', () => {
        const roster = rosterOf('univ');
        const text = ['▣ 100m (결승)', '1조레인번호성명소속', '3999가나다없는대학교', '남자대학부'].join('\n');
        const r = FP.textToDailyRows(text, roster);
        expect(r.issues.length).toBe(1); expect(r.issues[0]).toContain('확인 필요');
        expect(r.aoa.find(x => x[2] === 999)).toEqual(['', 3, 999, '가나다', '없는대학교']);
    });
    it('레인 두 자리(10번 이후 순서)와 배번 경계: "10123홍…" 은 명단에 맞는 쪽으로', () => {
        const roster = [{ name: '홍길동', team: '가대학교', gender: 'M', bib_number: '123' }, { name: '김철수', team: '가대학교', gender: 'M', bib_number: '23' }];
        const r = FP.textToDailyRows(['▣ 5000m (결승)', '1조순번호성명소속', '10123홍길동가대학교', '1123김철수가대학교', '남자대학부'].join('\n'), roster);
        expect(r.issues).toEqual([]);
        expect(r.aoa.slice(-2)).toEqual([['', 10, 123, '홍길동', '가대학교'], ['', 11, 23, '김철수', '가대학교']]);
    });
});
