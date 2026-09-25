// 특정 날짜의 한국 선수 출전 목록 + 스타트 리스트 PB 순번 (앱 규칙과 동일)
const day = process.argv[2]; const base = 'http://localhost:3199';
const parse = v => { if (v == null || v === '') return null; const s = String(v).trim(); if (s.includes(':')) { const p = s.split(':').map(parseFloat); return p.length === 2 ? p[0] * 60 + p[1] : p[0] * 3600 + p[1] * 60 + p[2]; } const n = parseFloat(s); return isNaN(n) ? null : n; };
(async () => {
  const j = async u => (await fetch(base + u)).json();
  const roster = await j('/api/competitions/2/roster');
  const events = await j('/api/events?competition_id=2');
  const out = [];
  const seenEv = new Map();
  for (const a of [...roster.athletes, ...roster.teams]) for (let e of a.events) {
    if (!e.scheduled_at || !e.scheduled_at.startsWith(day) || e.result) continue;
    if (a.is_team === false && e.relay) continue;   // 계주는 팀 줄로만
    let ev = events.find(x => x.id === e.event_id);
    let subs = '';
    if (e.parent_event_id) { const parent = events.find(x => x.id === e.parent_event_id); const key0 = e.parent_event_id + '|' + a.name; if (seenEv.has(key0)) continue; seenEv.set(key0, 1); const todays = a.events.filter(x => x.parent_event_id === e.parent_event_id && x.scheduled_at && x.scheduled_at.startsWith(day)).sort((p, q) => p.scheduled_at.localeCompare(q.scheduled_at)); subs = todays.map(x => `${x.scheduled_at.slice(11, 16)} ${x.event_name}`).join(' · '); e = { ...e, event_name: parent ? parent.name : e.event_name, event_id: e.parent_event_id }; ev = parent; }
    if (!subs) { const key = e.event_id + '|' + a.name; if (seenEv.has(key)) continue; seenEv.set(key, 1); }
    let rank = null;
    if (ev && ev.heat_count > 0 && ev.category !== 'combined') {
      const heats = await j(`/api/heats?event_id=${e.event_id}`).catch(() => []);
      const higher = ['field_distance', 'field_height'].includes(ev.category);
      const all = []; let mine = null, myHeat = null;
      for (const h of heats) { const ents = await j(`/api/heats/${h.id}/entries`); for (const x of ents) { const pbn = parse(x.personal_best); all.push({ h: h.id, pb: pbn, team: x.team, name: x.name }); if (x.team === 'KOR' && (x.name === a.name || x.name === a.name_alt || (a.is_team))) { mine = { h: h.id, pb: pbn, lane: x.lane_number }; myHeat = h; } } }
      if (mine && all.filter(x => x.pb != null).length * 2 >= all.length && mine.pb != null) {
        const rk = (list) => { const w = list.filter(x => x.pb != null).sort((p, q) => higher ? q.pb - p.pb : p.pb - q.pb); let r = 0; for (let i = 0; i < w.length; i++) { if (i === 0 || w[i].pb !== w[i - 1].pb) r = i + 1; if (w[i] === mine || (w[i].h === mine.h && w[i].pb === mine.pb && w[i].team === 'KOR')) return { r, n: w.length }; } return null; };
        const inHeat = rk(all.filter(x => x.h === mine.h)); const overall = rk(all);
        rank = { heat: inHeat, all: overall, heats: heats.length, lane: mine.lane, heat_number: myHeat && myHeat.heat_number };
      }
    }
    let rule = ''; try { const sp = await j(`/api/events/${e.event_id}/spotlight`); rule = (sp.rule && sp.rule.text_ko) || ''; } catch (x) {}
    out.push({ time: e.scheduled_at.slice(11, 16), ev: e.event_name, g: e.gender, rt: e.round_type, name: a.is_team ? '대한민국' : a.name, members: e.members ? e.members.map(m => m.name).join(' · ') : '', pb: e.personal_best, sb: e.season_best, heat: e.heat_number, rank, rule, entries: ev ? ev.heat_entry_count : null, relay: !!a.is_team, subs, combined: !!subs });
  }
  out.sort((p, q) => p.time.localeCompare(q.time));
  console.log(JSON.stringify(out, null, 1));
})();
