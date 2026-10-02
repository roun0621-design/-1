'use strict';
/**
 * 한국중·고육상연맹 대회 요강 규칙 — Phase 7-③ (2026-09)
 *   요강(춘계·회장배·학년별) 8·10조에서 시스템이 확인할 수 있는 것만:
 *     · 개인 종목은 1인 2종목까지 (계주·종합경기는 별도)
 *     · 계주는 학교당 1팀
 *     · 1학년부 종목과 본경기(학교급 전체 부) 같은 종목 중복 출전 불가
 *     · 믹스릴레이는 남 2·여 2
 *     · 예선이 5조 이상이면 준결승을 둔다
 *     · 타임레이스(중 1500·3000 / 고 1500·5000·3000mSC)는 조 순위가 아닌 종합 기록 순위
 *
 *   applies(comp, events)  — 이 대회에 적용할지 (연맹 KJAF 이거나 초·중·고 부 종목이 있으면)
 *   checkEntries({ events, entries, members }) → [{ key, level: 'warn'|'info', label, detail, count }]
 *   checkMixedRelay(memberGenders, adding) → { ok, error }
 */
const { parseDivision } = require('./division');
const { stripDivisionSuffix } = require('./eventName');

const SCHOOL = new Set(['ELEM', 'MID', 'HIGH']);
const isRelay = ev => ev.category === 'relay' || /\d\s*[x×X]\s*\d+\s*m/i.test(ev.name || '');
const TIME_RACE = { MID: /^(1500m|3000m)$/, HIGH: /^(1500m|5000m|3000mSC)$/ };

function applies(comp, events) {
    if (comp && String(comp.federation || '').toUpperCase() === 'KJAF') return true;
    return (events || []).some(e => SCHOOL.has(parseDivision(e.division).level));
}

/**
 * entries: [{ event_id, athlete_id, athlete_name, team, bib_number, gender, status }]  (계주 팀 항목 포함 — 계주는 팀명이 athlete_name)
 * members: [{ event_entry_id, athlete_id, athlete_name, gender }]  (계주 주자)
 */
function checkEntries({ events, entries, members }) {
    const evById = new Map((events || []).filter(e => !e.parent_event_id).map(e => [e.id, e]));
    const out = [];
    const push = (key, level, label, rows, fmt) => { if (rows.length) out.push({ key, level, label, count: rows.length, detail: rows.slice(0, 8).map(fmt).join(' · ') + (rows.length > 8 ? ` 외 ${rows.length - 8}` : '') }); };

    // 같은 종목의 예선·준결승·결승은 한 출전으로 센다
    const evKey = e => `${e.gender}|${e.division || ''}|${stripDivisionSuffix(e.name)}`;
    const perAthlete = new Map();   // athlete_id → { name, team, individual:Set(evKey), relays:Set, byLevel: Map(level → Map(evName → Set(grade|null))) }
    for (const en of entries || []) {
        const ev = evById.get(en.event_id); if (!ev) continue;
        if (en.status === 'withdrawn' || en.status === 'no_show') continue;
        const rec = perAthlete.get(en.athlete_id) || { name: en.athlete_name, team: en.team, individual: new Set(), relays: new Set() };
        if (isRelay(ev)) rec.relays.add(evKey(ev));
        else if (ev.category !== 'combined') rec.individual.add(evKey(ev));
        perAthlete.set(en.athlete_id, rec);
    }
    // ① 1인 2종목 초과 (개인 트랙·필드)
    const over = [...perAthlete.values()].filter(a => a.individual.size > 2);
    push('kjaf_two_events', 'warn', '개인 종목 1인 2종목 초과', over, a => `${a.name}(${a.team}) ${a.individual.size}종목`);

    // ② 계주 학교당 1팀
    const relayTeams = new Map();   // evKey → Map(team → count)
    for (const en of entries || []) {
        const ev = evById.get(en.event_id); if (!ev || !isRelay(ev)) continue;
        if (en.status === 'withdrawn' || en.status === 'no_show') continue;
        const k = evKey(ev); if (!relayTeams.has(k)) relayTeams.set(k, new Map());
        const team = String(en.team || en.athlete_name || '').replace(/\s*[A-Z]$|\s*\(?[AB]\)?$/, '').trim();   // '예천중 A'·'예천중(B)' 는 같은 학교
        relayTeams.get(k).set(team, (relayTeams.get(k).get(team) || 0) + 1);
    }
    const dupRelay = [];
    for (const [k, teams] of relayTeams) for (const [team, n] of teams) if (n > 1) dupRelay.push({ ev: k.split('|')[2], team, n });
    push('kjaf_relay_one_team', 'warn', '계주 학교당 1팀 초과', dupRelay, x => `${x.ev} ${x.team} ${x.n}팀`);

    // ③ 1학년부 ↔ 본경기 같은 종목 중복
    const dupGrade = [];
    for (const [, a] of perAthlete) {
        const seen = new Map();   // level|evName → Set(grade)
        for (const k of [...a.individual, ...a.relays]) {
            const [, division, name] = k.split('|');
            const p = parseDivision(division); if (!SCHOOL.has(p.level)) continue;
            const kk = `${p.level}|${name}`; if (!seen.has(kk)) seen.set(kk, new Set());
            seen.get(kk).add(p.grade == null ? 'all' : String(p.grade));
        }
        for (const [kk, grades] of seen) if (grades.has('all') && grades.size > 1) dupGrade.push({ name: a.name, team: a.team, ev: kk.split('|')[1] });
    }
    push('kjaf_grade_dup', 'warn', '학년부와 본경기 같은 종목 중복 출전', dupGrade, x => `${x.name}(${x.team}) ${x.ev}`);

    // ④ 믹스릴레이 남 2·여 2
    const byEntry = new Map();
    for (const m of members || []) { if (!byEntry.has(m.event_entry_id)) byEntry.set(m.event_entry_id, []); byEntry.get(m.event_entry_id).push(m); }
    const badMix = [];
    for (const en of entries || []) {
        const ev = evById.get(en.event_id); if (!ev || ev.gender !== 'X' || !isRelay(ev)) continue;
        const ms = byEntry.get(en.id || en.entry_id) || []; if (!ms.length) continue;
        const r = checkMixedRelay(ms.map(m => m.gender));
        if (!r.ok) badMix.push({ team: en.athlete_name || en.team, why: r.error });
    }
    push('kjaf_mixed_relay', 'warn', '믹스릴레이 구성(남 2·여 2)', badMix, x => `${x.team}: ${x.why}`);

    // ⑤ 예선 5조 이상인데 준결승 없이 결승만
    const semiMissing = [];
    const evs = [...evById.values()];
    for (const e of evs) {
        if (e.round_type !== 'preliminary') continue;
        if ((e.heat_count || 0) < 5) continue;
        const hasSemi = evs.some(f => f.round_type === 'semifinal' && evKey(f) === evKey(e));
        if (!hasSemi) semiMissing.push({ ev: `${stripDivisionSuffix(e.name)}${e.division ? ' ' + e.division : ''}`, n: e.heat_count });
    }
    push('kjaf_semifinal', 'info', '예선 5조 이상 — 준결승 권장', semiMissing, x => `${x.ev} 예선 ${x.n}조`);

    // ⑥ 타임레이스 안내 (결승이 2조 이상이면 종합 기록 순위로 처리됨을 알림)
    const timeRace = [];
    for (const e of evs) {
        if (e.round_type !== 'final' || (e.heat_count || 0) < 2) continue;
        const p = parseDivision(e.division); const re = TIME_RACE[p.level]; if (!re) continue;
        if (re.test(stripDivisionSuffix(e.name).replace(/\s/g, ''))) timeRace.push({ ev: `${stripDivisionSuffix(e.name)} ${e.division || ''}`.trim(), n: e.heat_count });
    }
    push('kjaf_time_race', 'info', '타임레이스 — 조와 관계없이 종합 기록 순위', timeRace, x => `${x.ev} ${x.n}조`);
    return out;
}

/** 믹스릴레이 주자 성별 목록(+추가하려는 성별) → 남 2·여 2 를 넘지 않는지 */
function checkMixedRelay(genders, adding) {
    const all = [...(genders || []), ...(adding ? [adding] : [])].map(g => String(g || '').toUpperCase());
    const m = all.filter(g => g === 'M').length, f = all.filter(g => g === 'F').length;
    if (m > 2) return { ok: false, error: `남자 ${m}명 — 믹스릴레이는 남 2·여 2` };
    if (f > 2) return { ok: false, error: `여자 ${f}명 — 믹스릴레이는 남 2·여 2` };
    if (all.length > 4) return { ok: false, error: `주자 ${all.length}명 — 4명까지` };
    if (all.length === 4 && (m !== 2 || f !== 2)) return { ok: false, error: `남 ${m}·여 ${f} — 믹스릴레이는 남 2·여 2` };
    return { ok: true, error: null };
}

module.exports = { applies, checkEntries, checkMixedRelay, isRelay };
