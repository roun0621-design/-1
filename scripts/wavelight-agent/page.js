'use strict';
/**
 * WaveLight 운영 콘솔 (이 PC 에서만 열린다 — http://localhost:5010)
 *   경기 진행 상태(우리 시스템)와 조명 줄 상태(컨트롤러)를 한 화면에 — 맞는지 한 문장, 줄 10개, 종목별 올리기·구간 보기, 기록.
 *   디자인 틀(docs/DESIGN_SYSTEM.md): 글자 12/13/14/16/20, 흰 카드 1px 보더 8px, 타탄 채움은 Fire 하나, 이모지·기호 없음.
 *   실행 파일 하나로 묶이도록 HTML 을 문자열로 둔다.
 */
module.exports = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WaveLight 운영 콘솔 — PACE RISE Node</title>
<style>
  :root { --ink:#0E0E10; --sub:#6D6A64; --line:#D6D3CB; --soft:#ECEAE4; --bg:#F4F3EF; --tartan:#C24A2E; --tartan-ink:#B8432A; --tartan-soft:#F6E4DF; --danger:#B4232C; --ok:#1E7A46; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Malgun Gothic","Apple SD Gothic Neo",sans-serif; }
  main { max-width: 1120px; margin: 0 auto; padding: 24px 16px 48px; }
  header { display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; margin-bottom:16px; }
  h1 { font-size:20px; margin:0; }
  header .comp { color:var(--sub); font-size:13px; }
  .grid { display:grid; grid-template-columns: 1.7fr 1fr; gap:16px; }
  @media (max-width: 860px) { .grid { grid-template-columns: 1fr; } }
  .card { background:#fff; border:1px solid var(--line); border-radius:8px; padding:20px; margin-bottom:16px; min-width:0; }
  .card h2 { font-size:16px; margin:0 0 12px; }
  .cap { font-size:12px; color:var(--sub); letter-spacing:.04em; }
  .mono { font-family:ui-monospace,Menlo,Consolas,"D2Coding",monospace; font-variant-numeric: tabular-nums; }
  .ok { color:var(--ok); font-weight:600; } .bad { color:var(--danger); font-weight:600; } .muted { color:var(--sub); }
  .kv { display:grid; grid-template-columns: 84px 1fr; gap:6px 12px; font-size:13px; margin:0; }
  .kv dt { color:var(--sub); } .kv dd { margin:0; word-break:break-all; }
  .verdict { font-size:16px; font-weight:600; margin:0 0 12px; }
  .verdict.warn { color:var(--danger); } .verdict.ok { color:var(--ok); } .verdict.idle { color:var(--ink); font-weight:500; }
  .pair { display:grid; grid-template-columns: 1fr 1fr; gap:12px; border-top:1px solid var(--soft); padding-top:12px; }
  .pair b { display:block; font-size:14px; margin-top:2px; }
  .actions { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-top:16px; }
  .actions label { font-size:13px; display:flex; align-items:center; gap:6px; margin-left:auto; cursor:pointer; }
  button { height:32px; padding:0 14px; border-radius:6px; border:1px solid var(--ink); background:#fff; color:var(--ink); font:600 13px inherit; cursor:pointer; white-space:nowrap; }
  button:hover { background:var(--bg); } button:disabled { opacity:.4; cursor:default; }
  button.primary { background:var(--tartan); border-color:var(--tartan); color:#fff; padding:0 22px; } button.primary:hover { background:#A63E26; }
  button.danger { border-color:var(--danger); color:var(--danger); }
  button.text { border-color:transparent; padding:0 6px; color:var(--sub); font-weight:500; } button.sm { height:28px; padding:0 10px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { text-align:left; font-size:12px; font-weight:500; color:var(--sub); padding:6px 8px; border-bottom:1px solid var(--line); white-space:nowrap; }
  td { padding:6px 8px; border-bottom:1px solid var(--soft); vertical-align:middle; }
  tr.idle td { color:#A8A49C; }
  .chip { display:inline-block; font-size:12px; line-height:20px; padding:0 8px; border-radius:10px; border:1px solid var(--line); white-space:nowrap; }
  .chip.live { background:var(--tartan); border-color:var(--tartan); color:#fff; } .chip.wait { border-color:var(--ink); } .chip.done { color:var(--sub); }
  .dot { display:inline-block; width:10px; height:10px; border-radius:50%; border:1px solid rgba(0,0,0,.25); margin-right:5px; vertical-align:-1px; }
  .bar { height:6px; background:var(--soft); border-radius:3px; overflow:hidden; min-width:90px; } .bar i { display:block; height:100%; background:var(--tartan); }
  .row { display:flex; align-items:center; gap:12px; padding:12px 0; border-top:1px solid var(--soft); flex-wrap:wrap; }
  .row:first-child { border-top:0; padding-top:0; }
  .row .name { flex:1 1 200px; min-width:0; } .row .name b { font-size:14px; margin-right:8px; } .row .name span.ko { display:block; font-size:12px; color:var(--sub); }
  .colors { flex:1 1 220px; display:flex; flex-wrap:wrap; gap:4px 12px; font-size:13px; }
  label.lamp { font-size:12px; color:var(--sub); display:flex; align-items:center; gap:6px; white-space:nowrap; }
  input[type=number] { width:64px; height:32px; border:1px solid var(--line); border-radius:6px; padding:0 8px; font:13px ui-monospace,Menlo,Consolas,monospace; }
  .msg { flex-basis:100%; font-size:13px; }
  .steps { flex-basis:100%; display:flex; gap:20px; flex-wrap:wrap; padding:4px 0 4px; }
  .steps table { width:auto; } .steps td, .steps th { padding:3px 10px 3px 0; border:0; } .steps td { text-align:right; }
  .steps .cap { margin-bottom:4px; }
  .empty { color:var(--sub); font-size:13px; padding:4px 0; }
  pre { margin:0; font:12px/1.7 ui-monospace,Menlo,Consolas,"D2Coding",monospace; white-space:pre-wrap; word-break:break-all; }
</style>
</head>
<body>
<main>
  <header><h1>WaveLight 운영 콘솔</h1><span class="comp" id="comp"></span></header>

  <div class="grid">
    <section class="card">
      <h2>경기와 조명</h2>
      <p class="verdict idle" id="verdict">확인하는 중</p>
      <div class="pair">
        <div><span class="cap">경기 진행</span><b id="race">-</b></div>
        <div><span class="cap">조명</span><b id="light">-</b></div>
      </div>
      <div class="actions">
        <button class="primary" id="fire" disabled>Fire</button>
        <button class="danger" id="cancelAll" disabled>올린 줄 모두 취소</button>
        <label title="경기가 진행 중(소집 완료)으로 바뀌면 그 종목을 출발 신호 대기로 올립니다. 출발은 언제나 Fire 로 합니다."><input type="checkbox" id="auto"> 경기가 진행 중이 되면 자동으로 올리기</label>
      </div>
      <div class="msg" id="topmsg" style="margin-top:10px"></div>
    </section>
    <section class="card">
      <h2>연결</h2>
      <dl class="kv" id="conn"><dt>상태</dt><dd class="muted">확인하는 중</dd></dl>
    </section>
  </div>

  <section class="card">
    <h2>조명 줄</h2>
    <div style="overflow-x:auto"><table>
      <thead><tr><th>줄</th><th>상태</th><th>색</th><th>종목</th><th>목표</th><th>경과</th><th style="width:22%">진행</th><th>구간</th><th>출발선</th><th></th></tr></thead>
      <tbody id="lines"></tbody>
    </table></div>
  </section>

  <section class="card">
    <h2>종목</h2>
    <div id="events"><div class="empty">서버에서 받는 중입니다.</div></div>
  </section>

  <section class="card">
    <h2>기록</h2>
    <pre id="log" class="muted"></pre>
    <div class="cap" id="logdir" style="margin-top:8px"></div>
  </section>
</main>
<script>
(function () {
  var COLORS = { green: ['초록', '#2E9E4F'], red: ['빨강', '#D93025'], white: ['흰색', '#FFFFFF'], blue: ['파랑', '#1A73E8'] };
  var lampEdit = {}, msgs = {}, open = {}, topmsg = null;
  var busy = false, last = null;
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function clock(sec, whole) { var t = whole ? Math.floor(sec) : Math.round(sec * 100) / 100, m = Math.floor(t / 60), s = Math.round((t - m * 60) * 100) / 100; return m + ':' + (s < 10 ? '0' : '') + (Number.isInteger(s) ? s : s.toFixed(2)); }
  function ago(ms) { if (!ms) return '아직 못 받음'; var s = Math.round((Date.now() - ms) / 1000); return s < 60 ? s + '초 전' : Math.round(s / 60) + '분 전'; }
  function dot(key) { var k = COLORS[key] || [key, '#ccc']; return '<i class="dot" style="background:' + k[1] + '"></i>' + esc(k[0]); }
  function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PaceRise-Agent': '1' }, body: JSON.stringify(body || {}) }).then(function (r) { return r.json(); });
  }
  function raceChip(r) { if (!r || !r.status) return ''; return '<span class="chip ' + (r.status === 'live' ? 'live' : r.status === 'done' ? 'done' : 'wait') + '">' + esc(r.text) + '</span>'; }

  function render(d) {
    last = d;
    var c = d.controller;
    document.getElementById('comp').textContent = (d.competition_name || ('대회 ' + d.competition_id)) + ' · 에이전트 ' + d.version;

    // 경기와 조명
    var v = document.getElementById('verdict'); v.className = 'verdict ' + d.sync.level; v.textContent = d.sync.text;
    var live = d.events.filter(function (e) { return e.race.status === 'live'; });
    document.getElementById('race').innerHTML = live.length ? live.map(function (e) { return esc(e.label) + ' <span class="chip live">' + esc(e.race.text) + '</span>'; }).join('<br>') : '<span class="muted" style="font-weight:400">진행 중인 페이싱 종목 없음</span>';
    var armed = c ? c.slots.filter(function (s) { return s === 2; }).length : 0, running = c ? c.slots.filter(function (s) { return s === 1; }).length : 0;
    document.getElementById('light').innerHTML = !c ? '<span class="bad">컨트롤러 연결 안 됨</span>' : (armed || running) ? ('출발 신호 대기 ' + armed + '줄 · 진행 중 ' + running + '줄') : '<span class="muted" style="font-weight:400">올라간 줄 없음</span>';
    var mine = d.lines.filter(function (l) { return l.mine; });
    document.getElementById('fire').disabled = busy || !armed;
    document.getElementById('cancelAll').disabled = busy || !mine.length;
    document.getElementById('auto').checked = !!d.auto;
    document.getElementById('topmsg').innerHTML = topmsg ? '<span class="' + (topmsg.ok ? 'ok' : 'bad') + '">' + esc(topmsg.text) + '</span>' : '';

    // 연결
    var conn = [];
    conn.push('<dt>서버</dt><dd>' + (d.sync_error ? '<span class="bad">받지 못함</span> <span class="muted">' + esc(d.sync_error) + ' · 마지막으로 받은 내용을 씁니다</span>' : '<span class="ok">받음</span> <span class="muted">' + ago(d.synced_at) + '</span>') + '</dd>');
    if (!d.controller_url) conn.push('<dt>컨트롤러</dt><dd class="muted">주소가 설정되지 않았습니다. 폴더의 파일만 맞춥니다.</dd>');
    else if (!c) conn.push('<dt>컨트롤러</dt><dd><span class="bad">연결 안 됨</span> <span class="muted">' + esc(d.controller_url) + ' · ' + esc(d.controller_error) + '</span></dd>');
    else conn.push('<dt>컨트롤러</dt><dd><span class="ok">연결됨</span> <span class="muted">' + esc(d.controller_url.replace(/^https?:\\/\\//, '')) + '</span></dd>'
      + '<dt>조명</dt><dd>한 바퀴 ' + c.lampsInRound + '개 · 버전 ' + esc(c.version) + '</dd>'
      + '<dt>조명 전원</dt><dd>' + (c.lampsOn ? '켜짐 <span class="muted">밝기 ' + c.lampPower + '%</span>' : '<span class="bad">꺼짐</span> <span class="muted">WaveLight 화면에서 켜야 조명이 보입니다</span>') + '</dd>');
    conn.push('<dt>파일 폴더</dt><dd class="muted">' + esc(d.dir) + '</dd>');
    document.getElementById('conn').innerHTML = conn.join('');

    // 줄 10개
    document.getElementById('lines').innerHTML = d.lines.map(function (l) {
      var st = l.state === 2 ? '<span class="chip wait">출발 신호 대기</span>' : l.state === 1 ? '<span class="chip live">진행 중</span>' : l.state === 0 ? '비어 있음' : '-';
      if (!l.mine) return '<tr class="' + (l.state ? '' : 'idle') + '"><td class="mono">' + l.slot + '</td><td>' + st + '</td><td colspan="8">' + (l.state ? '<span class="muted">WaveLight 화면에서 올린 줄</span>' : '') + '</td></tr>';
      var pct = l.fired_at ? Math.min(100, l.elapsed / l.total_seconds * 100) : 0;
      return '<tr><td class="mono">' + l.slot + '</td><td>' + st + '</td><td>' + dot(l.color_key) + '</td><td><b>' + esc(l.label) + '</b></td>'
        + '<td class="mono">' + clock(l.total_seconds) + '</td><td class="mono">' + (l.fired_at ? clock(Math.min(l.elapsed, l.total_seconds), true) : '-') + '</td>'
        + '<td><div class="bar"><i style="width:' + pct.toFixed(1) + '%"></i></div></td>'
        + '<td class="mono">' + (l.fired_at ? l.step + ' / ' + l.steps : l.steps) + '</td><td class="mono">' + l.start_lamp + '</td>'
        + '<td style="text-align:right"><button class="danger sm" data-cancel="' + l.slot + '"' + (busy ? ' disabled' : '') + '>취소</button></td></tr>';
    }).join('');

    // 종목
    var canSend = !!c && !busy;
    var rows = (d.events || []).map(function (ev) {
      var colors = ev.files.map(function (f) { return '<span>' + dot(f.color_key) + ' <span class="mono">' + clock(f.total_seconds) + '</span></span>'; }).join('');
      var lamp = lampEdit[ev.id] != null ? lampEdit[ev.id] : ev.start_lamp;
      var none = !ev.files.length;
      var steps = '';
      if (open[ev.id]) {
        steps = '<div class="steps">' + ev.files.map(function (f) {
          var acc = 0, light = 0;
          var body = f.steps.map(function (s, i) { acc += s.Duration; light += s.NumberOfLamps; return '<tr><td>' + (i + 1) + '</td><td>' + s.NumberOfLamps + '</td><td>' + (s.Duration / 1000).toFixed(2) + '</td><td>' + clock(acc / 1000) + '</td></tr>'; }).join('');
          return '<div><div class="cap">' + dot(f.color_key) + ' · 조명 ' + light + 'm' + (f.converted === 'steeple' ? ' (물웅덩이 구간 환산)' : '') + '</div><table class="mono"><thead><tr><th>구간</th><th>조명(m)</th><th>시간(초)</th><th>누적</th></tr></thead><tbody>' + body + '</tbody></table></div>';
        }).join('') + '</div>';
      }
      return '<div class="row"><div class="name"><b>' + esc(ev.label) + '</b>' + raceChip(ev.race) + '<span class="ko">' + esc(ev.event_name) + '</span></div>'
        + '<div class="colors">' + (colors || '<span class="muted">랩타임이 비어 있습니다</span>') + '</div>'
        + '<label class="lamp">출발선 조명 <input type="number" min="0" max="399" data-lamp="' + ev.id + '" value="' + esc(lamp) + '"' + (none ? ' disabled' : '') + '></label>'
        + '<button class="text" data-open="' + ev.id + '"' + (none ? ' disabled' : '') + '>' + (open[ev.id] ? '구간 접기' : '구간 보기') + '</button>'
        + '<button data-send="' + ev.id + '"' + (canSend && !none ? '' : ' disabled') + '>올리기</button>'
        + (msgs[ev.id] ? '<div class="msg ' + (msgs[ev.id].ok ? 'ok' : 'bad') + '">' + esc(msgs[ev.id].text) + '</div>' : '')
        + steps + '</div>';
    }).join('');
    var box = document.getElementById('events');
    if (!(document.activeElement && document.activeElement.hasAttribute && document.activeElement.hasAttribute('data-lamp')))
      box.innerHTML = rows || '<div class="empty">' + (d.synced_at ? '이 대회에 저장된 페이싱 설정이 없습니다. 관리 화면의 페이싱 라이트에서 저장하면 여기에 나옵니다.' : '서버에서 받는 중입니다.') + '</div>';

    document.getElementById('log').textContent = (d.log || []).join('\\n') || '아직 기록이 없습니다.';
    document.getElementById('logdir').textContent = d.log_dir ? '기록 파일: ' + d.log_dir : '';
  }
  function refresh() { return fetch('/api/state').then(function (r) { return r.json(); }).then(render).catch(function () {}); }
  function run(p, done) { busy = true; if (last) render(last); p.then(done).catch(function () { topmsg = { ok: false, text: '에이전트와 연결이 끊겼습니다.' }; }).then(function () { busy = false; return refresh(); }); }

  document.addEventListener('input', function (e) { var id = e.target.getAttribute && e.target.getAttribute('data-lamp'); if (id) lampEdit[id] = e.target.value; });
  document.addEventListener('change', function (e) { if (e.target.id === 'auto') post('/api/auto', { on: e.target.checked }).then(refresh); });
  document.addEventListener('click', function (e) {
    var t = e.target, id;
    if (!t.getAttribute || !last) return;
    if ((id = t.getAttribute('data-open'))) { open[id] = !open[id]; render(last); return; }
    if ((id = t.getAttribute('data-send'))) {
      var ev = last.events.filter(function (x) { return String(x.id) === id; })[0]; if (!ev) return;
      var lamp = lampEdit[id] != null && lampEdit[id] !== '' ? parseInt(lampEdit[id], 10) : ev.start_lamp;
      if (!(lamp >= 0 && lamp < 400)) { msgs[id] = { ok: false, text: '출발선 조명은 0~399 사이여야 합니다.' }; render(last); return; }
      var names = ev.files.map(function (f) { return (COLORS[f.color_key] || [f.color_key])[0]; }).join(' · ');
      if (!confirm(ev.label + '\\n' + names + ' ' + ev.files.length + '줄을 컨트롤러에 올립니다.\\n출발선 조명 ' + lamp + ' · 출발 신호 대기')) return;
      run(post('/api/send', { event_id: ev.id, start_lamp: lamp }), function (r) {
        msgs = {}; topmsg = null;
        msgs[id] = r.ok ? { ok: true, text: '줄 ' + r.lines.map(function (l) { return l.slot; }).join(' · ') + '에 올렸습니다. Fire 를 누르면 출발합니다.' + (r.lampsOn ? '' : ' 조명 전원이 꺼져 있습니다.') } : { ok: false, text: r.error || '올리지 못했습니다.' };
      });
      return;
    }
    if (t.id === 'fire') {
      var n = last.controller ? last.controller.slots.filter(function (s) { return s === 2; }).length : 0;
      if (!confirm('출발 신호를 기다리는 ' + n + '줄을 지금 출발시킵니다.')) return;
      run(post('/api/fire'), function (r) { msgs = {}; topmsg = r.ok ? { ok: true, text: '줄 ' + r.started.join(' · ') + ' 출발했습니다.' + (r.lampsOn ? '' : ' 조명 전원이 꺼져 있습니다.') } : { ok: false, text: r.error || '출발하지 못했습니다.' }; });
      return;
    }
    if (t.id === 'cancelAll' || (id = t.getAttribute('data-cancel'))) {
      if (!confirm(id ? '줄 ' + id + ' 을 취소합니다.' : '이 콘솔에서 올린 줄을 모두 취소합니다.')) return;
      run(post('/api/cancel', id ? { slot: parseInt(id, 10) } : {}), function (r) { msgs = {}; topmsg = { ok: true, text: r.cancelled && r.cancelled.length ? '줄 ' + r.cancelled.join(' · ') + ' 취소했습니다.' : '취소할 줄이 없습니다.' }; });
    }
  });
  refresh(); setInterval(function () { if (!busy) refresh(); }, 1000);
})();
</script>
</body>
</html>
`;
