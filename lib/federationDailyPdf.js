'use strict';
/**
 * 연맹 '데일리 조편성' PDF → ▣ 섹션형 표(연맹 xlsx 와 같은 모양) → lib/federationDaily.js 가 시스템 양식으로 변환.
 *
 * PDF 에서 글자를 뽑으면 표의 칸이 붙어 나온다:
 *     "1조레인번호성명소속"                  ← 조 머리글
 *     "2106홍길동국립경국대학교(B)"          ← 레인 2 · 번호 106 · 성명 · 소속  (어디서 끊을지 글자만으로는 알 수 없다)
 *     "남자대학부"                           ← 성별 표시는 그 쪽(page)의 내용 '뒤'에 나온다
 * 끊는 위치는 추측하지 않고 **등록 명단(성별·배번·성명)과 맞는 조합**을 고른다. 명단으로 확인되지 않은 행은
 * 소속 이름이 명단에 있는 조합 → 성명 3글자 순으로 고르되, 반드시 '확인 필요'로 알린다.
 */
const norm = v => String(v == null ? '' : v).replace(/[\s　]+/g, ' ').trim();
const GENDER_RE = /^(남자|여자|혼성)?\s*(대학교?부|실업부|일반부|고등부|중등부|초등부|선수권부?)$/;
const genderOf = l => { const m = l.match(GENDER_RE); return m ? (m[1] === '남자' ? 'M' : m[1] === '여자' ? 'F' : 'X') : null; };

function textToDailyRows(text, roster) {
    const byBib = new Map(), teams = new Set();
    for (const a of roster || []) {
        const bib = String(a.bib_number == null ? '' : a.bib_number).replace(/^0+/, '');
        if (a.team) teams.add(norm(a.team).replace(/\s/g, ''));
        if (!/^\d+$/.test(bib)) continue;
        const k = `${a.gender}|${bib}`; if (!byBib.has(k)) byBib.set(k, []); byBib.get(k).push(String(a.name || '').replace(/\(\d{2}\)$/, ''));
    }
    const known = (g, bib, name) => (g === 'X' || !g ? ['M', 'F'] : [g]).some(x => (byBib.get(`${x}|${bib}`) || []).includes(name));

    const lines = String(text || '').split(/\r?\n/).map(norm).filter(Boolean);
    // 성별 표시가 내용 앞에 오는지 뒤에 오는지: 첫 성별 표시보다 먼저 ▣ 종목이 나오면 '뒤'
    const firstG = lines.findIndex(l => genderOf(l.replace(/^▣\s*/, '')) && !/\(/.test(l));
    const firstEv = lines.findIndex(l => l.startsWith('▣') && !genderOf(l.replace(/^▣\s*/, '')));
    const trailing = firstG > -1 && firstEv > -1 && firstEv < firstG;
    const blocks = []; let cur = [], curG = null;
    for (const l of lines) {
        const g = genderOf(l.replace(/^▣\s*/, ''));
        if (g && !/\(/.test(l)) {
            if (trailing) { if (!l.startsWith('▣')) { blocks.push({ gender: g, lines: cur }); cur = []; } }
            else { if (cur.length) blocks.push({ gender: curG, lines: cur }); cur = []; curG = g; }
            continue;
        }
        cur.push(l);
    }
    if (cur.length) blocks.push({ gender: trailing ? null : curG, lines: cur });

    const aoa = [], issues = [];
    let evName = '', isRelay = false, lastTeam = null, lastG = null;
    for (const b of blocks) {
        const g = b.gender;
        if (!g) { if (b.lines.some(l => /^\d/.test(l))) issues.push(`성별 표시를 찾지 못한 구간: ${b.lines.slice(0, 2).join(' / ')} … (${b.lines.length}줄) — 제외됨`); continue; }
        if (g !== lastG) { aoa.push([{ M: '남자부', F: '여자부', X: '혼성부' }[g].replace('부', '일반부')]); lastG = g; }
        for (const l of b.lines) {
            let m;
            if (l.startsWith('▣')) {
                const t = l.replace(/^▣\s*/, '');
                if (/^(\d+조\s*)?[A-Za-z]$/.test(t)) { aoa.push(['▣ ' + t]); continue; }
                evName = t; isRelay = /mR(\(|\s|$)/i.test(evName.replace(/\s/g, '')); lastTeam = null; aoa.push(['▣ ' + evName]); continue;
            }
            if ((m = l.match(/^(\d+)조\s*(레인|순서?)\s*번호\s*성명\s*소속$/))) { aoa.push([m[1] + '조', m[2] === '레인' ? '레인' : '순', '번호', '성명', '소속']); lastTeam = null; continue; }
            if (/^(레인|순서?)\s*번호\s*성명\s*소속$/.test(l)) continue;
            const dm = l.match(/^(\d+)\s*(\D.*)$/);
            if (!dm || !evName) { if (/\d/.test(l) && evName) issues.push(`해석 못 한 줄: [${evName}] ${l}`); continue; }
            const digits = dm[1], rest = dm[2].replace(/\s/g, '');
            // 계주: 같은 팀이 이어지면 레인 없는 주자 행
            const sameTeam = isRelay && lastTeam && rest.endsWith(lastTeam);
            const laneLens = sameTeam ? [0] : [1, 2];
            const combos = [];
            // 계주의 2~4번 주자는 소속 칸이 비어 있는 양식도 있다("72홍길동" = 번호 72 · 성명) — 팀이 정해진 뒤에만, 명단으로 확인될 때만
            if (isRelay && lastTeam && digits[0] !== '0' && known(g, String(+digits), rest)) combos.push({ lane: null, bib: +digits, name: rest, team: '', ok: true, teamKnown: true });
            for (let nl = 2; nl <= Math.min(rest.length - 1, 14); nl++) {
                const name = rest.slice(0, nl), team = rest.slice(nl);
                for (const ln of laneLens) {
                    if (digits.length <= ln) continue;
                    if (digits[ln] === '0') continue;                    // 배번은 0 으로 시작하지 않는다 ("10123" 을 레인 1 · 배번 0123 으로 끊지 않게)
                    const lane = ln ? +digits.slice(0, ln) : null, bib = +digits.slice(ln);
                    if (lane != null && (lane < 1 || lane > 40)) continue;
                    combos.push({ lane, bib, name, team, ok: known(g, String(bib), name), teamKnown: teams.has(team) });
                }
            }
            let pick = combos.find(c => c.ok && c.teamKnown) || combos.find(c => c.ok);
            if (!pick) {
                pick = combos.find(c => c.teamKnown && (c.lane == null || c.lane <= 9)) || combos.find(c => c.name.length === 3 && (c.lane == null || c.lane <= 9)) || combos[0];
                if (!pick) { issues.push(`해석 못 한 줄: [${evName}] ${l}`); continue; }
                issues.push(`명단으로 확인되지 않음 — 확인 필요: [${evName}] "${l}" → ${pick.lane == null ? '' : '레인 ' + pick.lane + ' · '}번호 ${pick.bib} · ${pick.name} · ${pick.team}`);
            }
            if (isRelay) {
                if (pick.team !== lastTeam && pick.lane != null) { aoa.push(['', pick.lane, pick.bib, pick.name, pick.team]); lastTeam = pick.team; }
                else aoa.push(['', '', pick.bib, pick.name, pick.team]);
            } else aoa.push(['', pick.lane, pick.bib, pick.name, pick.team]);
        }
    }
    return { aoa, issues };
}

async function pdfToDailyRows(buffer, roster) {
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(buffer);
    if (!data.text || !/▣/.test(data.text)) {
        const e = new Error(data.text && data.text.trim().length > 50
            ? 'PDF 에서 ▣ 종목 머리글을 찾지 못했습니다. 연맹 데일리 조편성 PDF 가 맞는지 확인하세요.'
            : 'PDF 에서 글자를 읽을 수 없습니다(스캔한 그림 PDF). 엑셀 원본을 받아 올려 주세요.');
        e.userFacing = true; throw e;
    }
    return { ...textToDailyRows(data.text, roster), pages: data.numpages };
}

module.exports = { textToDailyRows, pdfToDailyRows };
