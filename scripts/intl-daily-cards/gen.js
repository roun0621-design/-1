// 데일리 카드 생성기 — 결과 다이제스트(일차별) + 출전 예정(하루). 입력: roster.json(결과), dayN.json(예정), events.json
const fs = require('fs'); const path = require('path');
const S = path.dirname(__dirname);
const roster = JSON.parse(fs.readFileSync(S + '/roster.json', 'utf8'));
const events = JSON.parse(fs.readFileSync(S + '/events.json', 'utf8'));
const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const G = { M: '남자', F: '여자', X: '혼성' }, R = { preliminary: '예선', semifinal: '준결승', final: '결승' };
const DOW = '일월화수목금토';
const fmtT = (s, road) => { if (s == null) return ''; if (s >= 3600) { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60; return `${h}:${String(m).padStart(2, '0')}:${String(Math.round(r)).padStart(2, '0')}`; } if (s >= 60) { const m = Math.floor(s / 60), r = s - m * 60; return `${m}:${r < 10 ? '0' : ''}${r.toFixed(2)}`; } return s.toFixed(2); };
const dayNo = d => Math.round((Date.parse(d + 'T00:00:00+09:00') - Date.parse('2026-09-23T00:00:00+09:00')) / 864e5) + 1;
const dLabel = d => { const dt = new Date(d + 'T00:00:00+09:00'); return `${dt.getMonth() + 1}/${dt.getDate()}(${DOW[dt.getDay()]})`; };
const hasSemi = (name, g) => events.some(e => e.name === name && e.gender === g && e.round_type === 'semifinal');

// ── 결과 행 모으기 ──
function resultRows(days) {
  const rows = []; const seen = new Set();
  for (const a of [...roster.athletes, ...roster.teams]) for (const e of a.events) {
    if (!e.result || !e.scheduled_at) continue; const d = e.scheduled_at.slice(0, 10); if (!days.includes(d)) continue;
    if (e.relay && !a.is_team) continue;
    const key = d + e.event_id + a.name; if (seen.has(key)) continue; seen.add(key);
    const r = e.result; const isTime = r.time_seconds != null; const road = e.category === 'road';
    const mark = r.status_code ? r.status_code : isTime ? fmtT(r.time_seconds, road) : r.distance_meters != null ? Number(r.distance_meters).toFixed(2) : '';
    let next = ''; if (e.round_type !== 'final') { const n = e.round_type === 'preliminary' && hasSemi(e.event_name, e.gender) ? '준결승' : '결승'; if (r.qual) next = n + ' 진출'; else if (e.round_status === 'completed' && !r.status_code) next = (R[e.round_type] || '') + ' 탈락'; }
    rows.push({ d, t: e.scheduled_at.slice(11, 16), g: e.gender, ev: e.event_name, rt: e.round_type, name: a.is_team ? '대한민국' : a.name, members: a.is_team && e.members ? e.members.map(m => m.name).join(' · ') : '', heat: e.heat_number, heats: r.heat_count, place: r.place, mark, tag: r.tag, next, status: r.status_code, final: e.round_type === 'final' });
  }
  rows.sort((p, q) => (p.d + p.t + p.ev).localeCompare(q.d + q.t + q.ev));
  for (const r of rows) if (r.tag === 'PB' || r.tag === 'SB') { const prev = rows.find(x => x !== r && x.name === r.name && x.ev === r.ev && x.g === r.g && x.mark === r.mark && (x.d + x.t) < (r.d + r.t) && x.tag === r.tag); if (prev) r.tag = '=' + r.tag; }
  return rows;
}
const medal = (p, size) => p >= 1 && p <= 3 ? `<span class="md m${p}" style="width:${size}px;height:${size}px;font-size:${Math.round(size * .55)}px">${p}</span>` : '';
function rowHtml(r, fs) {
  const place = r.status ? `<span class="st">${esc(r.status)}</span>` : r.final ? (r.place <= 3 ? medal(r.place, Math.round(fs * 1.5)) : `<span class="pl">${r.place}위</span>`) : `<span class="pl">${r.heats > 1 && r.heat ? r.heat + '조 ' : ''}${r.place ? r.place + '위' : ''}</span>`;
  const tag = r.tag ? `<span class="tag ${r.tag.replace('=', '\\=')}">${r.tag}</span>` : ''; const chip = r.next ? `<span class="chip ${/진출/.test(r.next) ? 'q' : 'out'}">${r.next}</span>` : '';
  return `<div class="row" style="font-size:${fs}px"><div class="ev"><span class="evn">${G[r.g]} ${esc(String(r.ev).replace(/\s*\(Mixed\)/i, '').replace('하프마라톤경보', '하프마라톤 경보'))}</span><span class="rt ${r.rt}">${R[r.rt] || ''}</span></div><div class="nm">${esc(r.name)}</div><div class="res"><span class="ct">${tag}</span><span class="cq">${chip}</span><span class="cp">${place}</span><span class="cm"><span class="mk">${esc(r.mark)}</span></span></div></div>${r.members ? `<div class="memrow" style="font-size:${fs}px">${esc(r.members)}</div>` : ''}`;
}
const CSS = `
*{box-sizing:border-box}body{margin:0;background:#888;font-family:'Noto Sans KR','Apple SD Gothic Neo',sans-serif;color:#1f1d1a;-webkit-font-smoothing:antialiased}
.card{width:1080px;height:1350px;position:relative;overflow:hidden;background:#fbfaf6;padding:70px 64px 56px;display:flex;flex-direction:column}
.brand{font-family:'Audiowide',sans-serif;font-size:26px;letter-spacing:2px;color:#1a2a5e}.brand span{color:#b79f58}
.top{display:flex;align-items:center;justify-content:space-between}.top .pg{font-family:'Audiowide',sans-serif;font-size:20px;color:#b79f58;letter-spacing:2px}
.eyebrow{margin-top:34px;font-size:24px;font-weight:700;color:#8a7640;letter-spacing:.05em;display:flex;align-items:center;gap:14px}
h1{font-size:60px;line-height:1.15;font-weight:900;letter-spacing:-.03em;margin:8px 0 0;word-break:keep-all}
.sub{font-size:24px;color:#6f6a62;margin-top:10px;font-weight:500}
.rule{width:110px;height:4px;background:#b79f58;margin:22px 0 8px}
.body{flex:1;min-height:0;display:flex;flex-direction:column;justify-content:flex-start}
.day{margin-top:18px;font-size:22px;font-weight:800;color:#8b1a2a;letter-spacing:.04em;padding-bottom:6px;border-bottom:2px solid #ead9a0;display:flex;align-items:center;gap:10px}
.day small{font-weight:600;color:#9a958c;font-size:19px}
.row{display:flex;align-items:center;gap:14px;padding:9px 0;border-bottom:1px solid #ece8de}
.row .ev{flex:0 0 272px;font-weight:700;color:#333;white-space:nowrap;display:flex;align-items:baseline;gap:6px}.row .ev .evn{min-width:0;overflow:hidden;text-overflow:ellipsis}.row .ev .rt{flex:none}.row .ev .rt{font-weight:800;margin-left:4px}.rt.preliminary{color:#1565c0}.rt.semifinal{color:#e65100}.rt.final{color:#b3261e}
.row .nm{flex:1;min-width:0;font-weight:900;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.row:has(+ .memrow){border-bottom:none;padding-bottom:2px}.memrow{font-size:.62em;color:#777;font-weight:500;padding:0 0 8px 286px;border-bottom:1px solid #ece8de;white-space:nowrap}
.row .res{flex:none;display:flex;align-items:center;gap:8px}.row .res .ct{flex:0 0 52px;display:flex;justify-content:flex-end}.row .res .cq{flex:0 0 106px;display:flex;justify-content:flex-end}.row .res .cp{flex:0 0 84px;display:flex;justify-content:flex-end}.row .res .cm{flex:0 0 136px;text-align:right}
.pl{display:inline-block;min-width:44px;padding:2px 10px;border-radius:9px;background:#e9edf6;color:#1a2a5e;font-weight:800;font-size:.8em;text-align:center;white-space:nowrap}
.st{color:#b3261e;font-weight:800;font-size:.8em}
.mk{font-family:'D2Coding',monospace;font-weight:700;font-size:1.05em}
.tag{display:inline-block;padding:2px 8px;border-radius:7px;font-size:.68em;font-weight:800;line-height:1.3}.tag.NR{background:#c0392b;color:#fff}.tag.GR{background:#b8860b;color:#fff}.tag.AR{background:#0d47a1;color:#fff}.tag.PB,.tag.\=PB{background:#e6f4ec;color:#1b7f4d;border:1px solid #bfe3cc}.tag.SB,.tag.\=SB{background:#fff;color:#1b7f4d;border:1px solid #bfe3cc}
.chip{display:inline-block;padding:2px 9px;border-radius:9px;font-size:.68em;font-weight:800;white-space:nowrap}.chip.q{background:#e6f4ec;color:#1b7f4d;border:1px solid #bfe3cc}.chip.out{background:#f1efe9;color:#8a8580;border:1px solid #e2ddd2;font-weight:600}
.md{display:inline-flex;align-items:center;justify-content:center;border-radius:50%;color:#fff;font-weight:800;font-family:'D2Coding',monospace}.m1{background:linear-gradient(135deg,#f1d36a,#c7a12a)}.m2{background:linear-gradient(135deg,#e3e6ea,#9ba2ac)}.m3{background:linear-gradient(135deg,#d69b5f,#a1632c)}
.foot{margin-top:auto;padding-top:18px;border-top:2px solid #ead9a0;display:flex;align-items:center;justify-content:space-between;gap:20px}
.foot .stores{display:flex;gap:12px}.store{display:inline-flex;align-items:center;gap:10px;padding:9px 16px 9px 12px;border-radius:12px;background:#111;color:#fff}.store .t{line-height:1.1}.store .t small{display:block;font-size:11px;opacity:.8}.store .t b{font-size:21px;font-weight:700;letter-spacing:-.01em}
.foot .url{font-family:'Audiowide',sans-serif;font-size:22px;letter-spacing:1px;color:#1a2a5e}
.flag{display:inline-flex;align-items:center;justify-content:center;width:44px;height:30px;border-radius:5px;background:#fff;border:1.5px solid #333}
/* 표지 */
.cover{justify-content:center}.cv-brand{font-family:'Audiowide',sans-serif;font-size:108px;line-height:1.05;letter-spacing:2px;color:#1a2a5e;margin-top:auto;padding-top:90px}.cv-brand span{color:#b79f58;font-size:.8em}
.cv-line{display:flex;align-items:center;gap:18px;margin-top:70px;font-size:30px;font-weight:700;color:#8a7640;letter-spacing:.03em}
.cv-title{font-size:84px;font-weight:900;letter-spacing:-.03em;line-height:1.15;margin-top:24px;word-break:keep-all;margin-bottom:auto}
/* 예정 */
.srow{display:flex;align-items:center;gap:16px;padding:8px 0;border-bottom:1px solid #ece8de}
.srow .tm{flex:0 0 96px;font-family:'D2Coding',monospace;font-size:1.05em;font-weight:700;color:#8a7640}
.srow .mid{flex:1;min-width:0}.srow .ev{font-weight:700;color:#333}.srow .ev .rt{font-weight:800}.srow .nm{font-weight:900;font-size:1.08em;margin-top:1px}.srow .pbsb{font-family:'D2Coding',monospace;font-size:.78em;color:#555;margin-top:2px}.srow .subs{font-size:.7em;color:#777;margin-top:2px}
.srow .rk{flex:none;text-align:right;align-self:center}.rkp{display:inline-block;padding:4px 11px;border-radius:10px;background:#f1efe9;color:#6b665e;font-family:'D2Coding',monospace;font-weight:800;font-size:.82em;white-space:nowrap}.rkp.good{background:#e6f4ec;color:#1b7f4d}.rkp b{font-family:'D2Coding',monospace;font-size:.8em;letter-spacing:.08em;margin-right:7px;font-weight:800}.rkn{font-size:.62em;color:#9a958c;margin-top:4px}
`;
const TG = `<svg width="0" height="0" style="position:absolute"><defs><g id="tg"><g stroke="none" transform="rotate(33)"><circle r="7" fill="#1a2a5e"/><path d="M-7 0A7 7 0 0 1 7 0A3.5 3.5 0 0 0 0 0A3.5 3.5 0 0 1 -7 0Z" fill="#c8102e"/></g></g></defs></svg>`;
const flag = (sz) => `<span class="flag" style="width:${sz}px;height:${Math.round(sz * .68)}px"><svg viewBox="-12 -8 24 16" width="${sz - 8}" height="${Math.round((sz - 8) * .68)}"><use href="#tg"/></svg></span>`;
const APPLE = '<svg viewBox="0 0 24 24" fill="#fff" width="30" height="30"><path d="M16.365 12.7c-.02-2.1 1.72-3.11 1.8-3.16-.98-1.43-2.5-1.63-3.04-1.65-1.3-.13-2.53.76-3.19.76-.66 0-1.67-.74-2.75-.72-1.41.02-2.72.82-3.45 2.09-1.47 2.55-.38 6.33 1.06 8.4.7 1.01 1.53 2.15 2.62 2.11 1.05-.04 1.45-.68 2.72-.68s1.63.68 2.74.66c1.13-.02 1.85-1.03 2.54-2.05.8-1.17 1.13-2.3 1.15-2.36-.03-.01-2.2-.85-2.2-3.4zM14.27 6.5c.58-.7.97-1.68.86-2.65-.83.03-1.85.56-2.45 1.25-.54.62-1.01 1.62-.88 2.57.93.07 1.88-.47 2.47-1.17z"/></svg>';
const GPLAY = '<svg viewBox="0 0 24 24" width="30" height="30"><path d="M3.6 2.4c-.3.3-.5.8-.5 1.4v16.4c0 .6.2 1.1.5 1.4l.1.1 9.2-9.2v-.2L3.7 2.3l-.1.1z" fill="#4285f4"/><path d="M16 15.6l-3.1-3.1v-.2l3.1-3.1.1.1 3.6 2.1c1 .6 1 1.5 0 2.1L16 15.6z" fill="#fbbc04"/><path d="M16.1 15.5L12.9 12.3 3.6 21.6c.3.4.9.4 1.5.1l11-6.2" fill="#ea4335"/><path d="M16.1 9.1L5.1 2.9c-.6-.4-1.2-.3-1.5.1l9.3 9.3 3.2-3.2z" fill="#34a853"/></svg>';
const foot = () => `<div class="foot"><div class="stores"><span class="store">${APPLE}<span class="t"><small>Download on the</small><b>App Store</b></span></span><span class="store">${GPLAY}<span class="t"><small>GET IT ON</small><b>Google Play</b></span></span></div><div class="url">pace-rise-node.com</div></div>`;
const head = (eyebrow, h1, sub, pg) => `<div class="top"><div class="brand">PACE RISE <span>: Node</span></div></div><div class="eyebrow">${flag(44)}${eyebrow}</div><h1>${h1}</h1><div class="sub">${sub}</div><div class="rule"></div>`;

// ── 결과 카드: days 배열을 페이지로 나눠 (한 페이지 최대 rows 수에 맞춰 글자 크기) ──
function resultCards(days, title, filePrefix) {
  const rows = resultRows(days);
  const byDay = days.map(d => ({ d, rows: rows.filter(r => r.d === d) })).filter(x => x.rows.length);
  // 페이지 나누기: 한 페이지 ≤ 13행
  const pages = []; let cur = [], n = 0;
  for (const x of byDay) { if (n && n + x.rows.length > 13) { pages.push(cur); cur = []; n = 0; } cur.push(x); n += x.rows.length; }
  if (cur.length) pages.push(cur);
  const medals = roster.medals;
  return pages.map((pg, i) => {
    const total = pg.reduce((a, x) => a + x.rows.length, 0);
    const fs = total >= 13 ? 22 : total >= 10 ? 24 : 26;
    const body = pg.map(x => `<div class="day">${dLabel(x.d)} · ${dayNo(x.d)}일차 <small>${x.rows.length}경기</small></div>${x.rows.map(r => rowHtml(r, fs)).join('')}`).join('');
    const sub = `메달 <b style="color:#c7a12a">금 ${medals.gold}</b> · <b style="color:#9ba2ac">은 ${medals.silver}</b> · <b style="color:#a1632c">동 ${medals.bronze}</b> &nbsp;·&nbsp; 대회 공식 결과 기준`;
    return { file: `${filePrefix}_${i + 1}.png`, html: `<section class="card">${head(`2026 아이치·나고야 아시안게임 육상 · 대한민국`, title, sub, `${String(i + 2).padStart(2, '0')} / ${String(pages.length + 1).padStart(2, '0')}`)}<div class="body">${body}</div>${foot()}</section>` };
  });
}
// ── 예정 카드 ──
function scheduleCards(day, list, filePrefix) {
  const pages = []; for (let i = 0; i < list.length; i += 8) pages.push(list.slice(i, i + 8));
  return pages.map((pg, i) => {
    const fs = pg.length >= 8 ? 20 : pg.length >= 6 ? 23 : 26;
    const rowsHtml = pg.map(x => {
      const rk = x.rank && x.rank.all ? (x.rt === 'final' || x.rank.heats === 1 ? `<span class="rkp${x.rank.all.r <= 3 ? ' good' : ''}"><b>RANK</b>${x.rank.all.r}/${x.rank.all.n}</span>` : `<span class="rkp${x.rank.heat && x.rank.heat.r <= 3 ? ' good' : ''}"><b>RANK</b>${x.rank.heat.r}/${x.rank.heat.n}</span><div class="rkn">조 기준 · 전체 ${x.rank.all.r}/${x.rank.all.n}${x.rank.lane ? ` · ${x.rank.heat_number ? x.rank.heat_number + '조 ' : ''}${x.rank.lane}레인` : ''}</div>`) : (x.combined ? `<span class="rkp"><b>10종</b>Day 1</span>` : x.entries ? `<span class="rkp"><b>엔트리</b>${x.entries}명</span>` : '');
      return `<div class="srow" style="font-size:${fs}px"><div class="tm">${x.time}</div><div class="mid"><div class="ev">${G[x.g]} ${esc(x.ev)} <span class="rt ${x.combined ? '' : x.rt}">${x.combined ? 'Day 1' : (R[x.rt] || '')}${x.heat && x.rt !== 'final' && !x.combined ? ' ' + x.heat + '조' : ''}</span></div><div class="nm">${esc(x.name)}</div>${x.subs ? `<div class="subs">${esc(x.subs)}${x.subs.split('·').length < 5 ? ' · 21:20 400m' : ''}</div>` : `<div class="pbsb">${x.pb ? 'PB ' + esc(x.pb) : ''}${x.sb ? ' · SB ' + esc(x.sb) : ''}${x.rule ? ` · <span style="font-family:'Noto Sans KR';color:#8a8580">${esc(x.rule)}</span>` : ''}</div>`}</div><div class="rk">${rk}</div></div>`;
    }).join('');
    return { file: `${filePrefix}_${i + 1}.png`, html: `<section class="card">${head(`2026 아이치·나고야 아시안게임 육상 · 대한민국`, `${dLabel(day)} 오늘의 출전`, `${dayNo(day)}일차 · 한국 선수 ${list.length}경기 · 한국시간 · RANK는 스타트 리스트 PB 순번(참고)`, `${String(i + 2).padStart(2, '0')} / ${String(pages.length + 1).padStart(2, '0')}`)}<div class="body">${rowsHtml}</div>${foot()}</section>` };
  });
}
function coverCard(title, file) {
  return { file, html: `<section class="card cover"><div class="cv-brand">PACE RISE<br><span>: Node</span></div><div class="cv-line">${flag(52)}<span>2026 아이치·나고야 아시안게임 육상 · 대한민국</span></div><div class="cv-title">${title}</div>${foot()}</section>` };
}
module.exports = { resultCards, scheduleCards, coverCard, CSS, TG };
if (require.main === module) {
  const mode = process.argv[2]; const out = [];
  if (mode === 'results') { const days = process.argv[3].split(','); const title = process.argv[4]; out.push(coverCard(title.replace('<br>', ' '), process.argv[5] + '_0.png')); out.push(...resultCards(days, title.replace('<br>', ' '), process.argv[5])); }
  if (mode === 'schedule') { const day = process.argv[3]; const list = JSON.parse(fs.readFileSync(process.argv[4], 'utf8')); out.push(coverCard(`${dLabel(day)} 오늘의 출전`, process.argv[5] + '_0.png')); out.push(...scheduleCards(day, list, process.argv[5])); }
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700;900&family=Audiowide&display=swap"><style>${CSS}</style></head><body>${TG}${out.map(o => o.html).join('')}</body></html>`;
  fs.writeFileSync(__dirname + '/page.html', html); fs.writeFileSync(__dirname + '/page.json', JSON.stringify(out.map(o => o.file)));
  console.log('cards', out.map(o => o.file).join(', '));
}
