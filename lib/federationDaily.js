'use strict';
/**
 * 연맹 '데일리 조편성' 파일(▣ 섹션형 xlsx) → 시스템 조편성 양식(표)으로 변환.
 *   2026 예천 대회 때는 이 변환을 매일 손으로(스크립트로) 해서 올렸다. 이제 조편성 업로드에 그대로 올리면 된다.
 *
 * 연맹 양식의 모양 (시트 1장):
 *     남자실업부                      ← 성별 머리글 (남자/여자 + 대학부·실업부 …, 접두가 없으면 혼성)
 *     ▣ 100m (3-2+2)                 ← 종목. 괄호 = 진출 규정(예선) / '결승' / 없음. "멀리뛰기(10종)" = 종합경기 세부종목
 *     1조  레인 번호 성명 소속        ← 조 머리글
 *          3    125  홍길동 ○○시청
 *     ▣ 1조 A  /  ▣ A                ← 같은 조 안의 그룹(5000m 결승 A·B 등)
 *   실업 파일은 A열이 비어 있어 한 칸씩 밀려 있다 → ▣ 가 처음 나오는 열로 자동 보정.
 *   계주: 레인이 적힌 행이 팀의 첫 주자, 이어지는 레인 없는 행이 나머지 주자.
 *
 * 출력: [성별, 종목, 라운드, 조, 그룹, 순서, 배번, 성명, 소속, 비고] — parseHeatAssignmentExcel 이 읽는 표준 표
 */
const s = v => String(v == null ? '' : v).replace(/[\s　]+/g, ' ').trim();
const HEADER = ['성별', '종목', '라운드', '조', '그룹', '순서', '배번', '성명', '소속', '비고'];
const EV_NAME = { '10000m': '10,000m', '10000mW': '10,000mW' };
const COMBINED_PARENT = { '10종': '10종경기', '7종': '7종경기' };
const gLabel = g => ({ M: '남', F: '여', X: '혼성' }[g] || '');

/** 연맹 데일리 양식인가? — ▣ 로 시작하는 칸이 있고, 표준 표의 머리글(종목+성명)이 없다 */
function isFederationDaily(rows) {
    const head = (rows || []).slice(0, 200);
    const hasMark = head.some(r => (r || []).some(c => s(c).startsWith('▣')));
    if (!hasMark) return false;
    const first = ((rows || [])[0] || []).map(s);
    return !(first.includes('종목') && (first.includes('성명') || first.includes('선수명')));
}

function parseFederationDaily(rows) {
    const probe = rows.find(r => (r || []).some(c => s(c).startsWith('▣')));
    const offset = probe ? probe.findIndex(c => s(c).startsWith('▣')) : 0;
    const events = [], unparsed = [];
    let gender = null, ev = null, heat = 1, group = null, team = null;
    rows.forEach((r0, ri) => {
        const full = (r0 || []).map(s);
        if (!full.some(Boolean)) return;
        let m;
        // 성별 머리글은 열 위치와 무관하게 행의 첫 값으로 판단
        const t0 = (full.find(Boolean) || '').replace(/^▣\s*/, '');      // 사전 조편성 원본은 성별 머리글에도 ▣ 가 붙는다 ("▣ 남자실업부")
        if ((m = t0.match(/^(남자|여자|혼성)?\s*(대학교?부|실업부|일반부|고등부|중등부|초등부|선수권부?)$/))) { gender = m[1] === '남자' ? 'M' : m[1] === '여자' ? 'F' : 'X'; return; }
        const r = full.slice(Math.max(0, offset));
        const c = [0, 1, 2, 3, 4].map(i => s(r[i]));
        if (c[0].startsWith('▣') || c[1].startsWith('▣')) {
            const tt = (c[0].startsWith('▣') ? c[0] : c[1]).replace(/^▣\s*/, '').trim();
            if ((m = tt.match(/^(\d+)조\s*([A-Za-z])$/))) { heat = +m[1]; group = m[2].toUpperCase(); return; }
            if ((m = tt.match(/^([A-Za-z])$/))) { group = m[1].toUpperCase(); return; }      // "▣ A" — 같은 조 안의 그룹
            let name = tt, roundRaw = '';
            if ((m = tt.match(/^(.*?)\s*\(([^()]*)\)$/)) && !/^(10종|7종)$/.test(m[2].trim())) { name = m[1].trim(); roundRaw = m[2].trim(); }
            let combined = null, base = name;
            if ((m = name.match(/^(.+?)\s*\((10종|7종)\)$/))) { base = m[1].trim(); combined = m[2]; }
            const code = /^\d+-\d+\+\d+$/.test(roundRaw) ? roundRaw : '';
            const round = combined ? combined : (code || /예선/.test(roundRaw)) ? '예선' : /준결/.test(roundRaw) ? '준결승' : '결승';
            ev = { gender, name, base, combined, roundRaw, code, round, isRelay: /mR(\(|$)/i.test(base.replace(/\s/g, '')), entries: [], teams: [], srcRow: ri + 1 };
            events.push(ev); heat = 1; group = null; team = null; return;
        }
        if (/^\d+조$/.test(c[0])) { heat = parseInt(c[0], 10); group = null; if (c[1] === '레인' || c[1] === '순') return; }
        if (!c[0] && (c[1] === '레인' || c[1] === '순' || c[1] === '순서')) return;
        if (/^\d+$/.test(c[2]) && (c[3] || c[4])) {
            const lane = /^\d+$/.test(c[1]) ? parseInt(c[1], 10) : null, bib = parseInt(c[2], 10), name = c[3], tm = c[4];
            if (!ev) { unparsed.push({ row: ri + 1, cells: c.filter(Boolean).join(' | ') }); return; }
            if (ev.isRelay) {
                if (lane != null) { team = { heat, lane, team: tm, members: [], srcRow: ri + 1 }; ev.teams.push(team); }
                if (!team) { unparsed.push({ row: ri + 1, cells: c.filter(Boolean).join(' | ') }); return; }
                team.members.push({ bib, name, team: tm || team.team });
            } else ev.entries.push({ heat, group, lane, bib, name, team: tm, srcRow: ri + 1 });
            return;
        }
        unparsed.push({ row: ri + 1, cells: c.filter(Boolean).join(' | ') });
    });
    // 그룹(A/B)이 있는 조는 순서를 그룹 등장 순으로 이어서 매긴다 (A 1..n, B n+1..)
    for (const e of events) {
        if (e.isRelay || !e.entries.some(x => x.group)) continue;
        const perHeat = {};
        for (const x of e.entries) { perHeat[x.heat] = (perHeat[x.heat] || 0) + 1; x.lane = perHeat[x.heat]; }
    }
    return { events, unparsed };
}

/**
 * 표준 표로 변환. roster: 그 대회의 선수 [{name, bib_number, team, gender}] — 성명·소속은 등록 명단을 우선한다
 *   (데일리의 오탈자, 동명이인 '(yy)' 표기를 명단 기준으로 맞추기 위해). 명단에 없으면 데일리 값 그대로(업로드 때 자동 생성).
 */
function toAssignmentRows(parsed, roster) {
    const notes = [];
    const byBib = new Map();
    for (const a of roster || []) {
        const bib = String(a.bib_number == null ? '' : a.bib_number).replace(/^0+/, '');
        if (!bib || !/^\d+$/.test(bib)) continue;
        const k = `${a.gender}|${bib}`; if (!byBib.has(k)) byBib.set(k, []); byBib.get(k).push(a);
    }
    const findA = (g, bib, name) => {
        const cands = (g === 'X' ? ['M', 'F'] : [g]).flatMap(x => byBib.get(`${x}|${bib}`) || []);
        return cands.find(a => a.name === name || a.name.replace(/\(\d{2}\)$/, '') === name) || (cands.length === 1 ? cands[0] : null);
    };
    const rows = [], combinedMembers = {};
    for (const ev of parsed.events) {
        const g = ev.gender, evName = EV_NAME[ev.base] || ev.base;
        const heats = new Set((ev.isRelay ? ev.teams : ev.entries).map(x => x.heat)).size;
        if (ev.code && parseInt(ev.code, 10) !== heats) notes.push(`${gLabel(g)} ${ev.name}: 머리글의 진출 규정은 "${ev.code}"인데 실제 ${heats}개 조 — ${heats}개 조로 처리`);
        if (!g) notes.push(`${ev.name}: 성별 머리글(예: 남자실업부)을 찾지 못함 — 성별 없이 처리됨 (${ev.srcRow}행)`);
        if (ev.combined) {
            const ck = `${g}|${ev.combined}`; combinedMembers[ck] = combinedMembers[ck] || new Map();
            for (const e of ev.entries) {
                const a = findA(g, e.bib, e.name);
                const nm = a ? a.name : e.name, tm = (a && a.team) || e.team || '';
                combinedMembers[ck].set(e.bib, { name: nm, team: tm });
                rows.push([gLabel(g), evName, ev.combined, 1, '', e.lane, e.bib, nm, tm, `${ev.combined}경기 세부종목`]);
            }
            continue;
        }
        if (ev.isRelay) {
            for (const t of ev.teams) {
                rows.push([gLabel(g), ev.base.replace(/\s/g, ''), ev.round, t.heat, '', t.lane, '', t.team, t.team, ev.code || '']);
                for (const mem of t.members) if (roster && roster.length && !findA(g, mem.bib, mem.name)) notes.push(`계주 주자가 명단에 없음: ${t.team} ${mem.bib} ${mem.name} (${gLabel(g)} ${ev.name})`);
            }
            continue;
        }
        for (const e of ev.entries) {
            const a = findA(g, e.bib, e.name);
            if (roster && roster.length) {
                if (!a) notes.push(`명단에 없는 선수: ${gLabel(g)} ${ev.name} 배번 ${e.bib} ${e.name} ${e.team} → 적용 시 자동 등록`);
                else if (a.name.replace(/\(\d{2}\)$/, '') !== e.name) notes.push(`이름 불일치: 배번 ${e.bib} 데일리 "${e.name}" / 명단 "${a.name}" → 명단 이름으로 처리`);
            }
            rows.push([gLabel(g), evName, ev.round, e.heat, e.group || '', e.lane == null ? '' : e.lane, e.bib, a ? a.name : e.name, a ? (a.team || e.team) : e.team, ev.code || (e.group ? `${ev.round} ${e.heat}조 ${e.group}그룹` : '')]);
        }
    }
    // 종합경기 부모 행 — 세부종목 출전자를 모아 부모(10종경기/7종경기)에 넣는다 (기권자 제외가 세부종목 조에 반영되도록)
    const parentRows = [];
    for (const [ck, members] of Object.entries(combinedMembers)) {
        const [g, type] = ck.split('|');
        let i = 1;
        for (const [bib, mem] of members) parentRows.push([gLabel(g), COMBINED_PARENT[type], '결승', 1, '', i++, bib, mem.name, mem.team, `${type}경기 출전자 (데일리 기준)`]);
        const subs = parsed.events.filter(e => e.gender === g && e.combined === type);
        if (new Set(subs.map(e => e.entries.length)).size > 1) notes.push(`${gLabel(g)} ${COMBINED_PARENT[type]} 세부종목 인원이 서로 다름: ${subs.map(e => `${e.base} ${e.entries.length}명`).join(', ')}`);
    }
    if (parsed.unparsed.length) notes.push(`해석하지 못한 행 ${parsed.unparsed.length}건: ` + parsed.unparsed.slice(0, 8).map(u => `${u.row}행(${u.cells})`).join(', ') + (parsed.unparsed.length > 8 ? ' …' : ''));
    return { aoa: [HEADER, ...parentRows, ...rows], notes, eventCount: parsed.events.length, rowCount: parentRows.length + rows.length };
}

/** rows(시트 전체) → 표준 표. 연맹 양식이 아니면 null */
function convertIfFederationDaily(rows, roster) {
    if (!isFederationDaily(rows)) return null;
    return toAssignmentRows(parseFederationDaily(rows), roster);
}

module.exports = { isFederationDaily, parseFederationDaily, toAssignmentRows, convertIfFederationDaily, HEADER };
