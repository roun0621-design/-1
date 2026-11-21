'use strict';
/**
 * WaveLight 에이전트의 보내기 화면 (이 PC 에서만 열린다 — http://localhost:5010)
 *   디자인 틀(docs/DESIGN_SYSTEM.md): 글자 12/13/14/16/20, 흰 카드 1px 보더 8px, 타탄은 Primary 에만, 이모지·기호 없음.
 *   실행 파일 하나로 묶이도록 HTML 을 문자열로 둔다.
 */
module.exports = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WaveLight 보내기 — PACE RISE Node</title>
<style>
  :root { --ink:#0E0E10; --sub:#6D6A64; --line:#D6D3CB; --bg:#F4F3EF; --tartan:#C24A2E; --tartan-ink:#B8432A; --danger:#B4232C; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Malgun Gothic","Apple SD Gothic Neo",sans-serif; }
  main { max-width: 860px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size:20px; margin:0 0 4px; }
  .lead { color:var(--sub); font-size:13px; margin:0 0 16px; }
  .card { background:#fff; border:1px solid var(--line); border-radius:8px; padding:20px; margin-bottom:16px; }
  .card h2 { font-size:16px; margin:0 0 12px; }
  .kv { display:grid; grid-template-columns: 96px 1fr; gap:6px 12px; font-size:13px; }
  .kv dt { color:var(--sub); } .kv dd { margin:0; word-break:break-all; }
  .ok { color:#1E7A46; font-weight:600; } .bad { color:var(--danger); font-weight:600; } .muted { color:var(--sub); }
  .row { display:flex; align-items:center; gap:12px; padding:12px 0; border-top:1px solid #ECEAE4; flex-wrap:wrap; }
  .row:first-of-type { border-top:0; }
  .row .name { flex:1 1 220px; min-width:0; }
  .row .name b { display:block; font-size:14px; } .row .name span { font-size:12px; color:var(--sub); }
  .lines { flex:1 1 200px; display:flex; flex-wrap:wrap; gap:4px 12px; font-size:13px; font-family:ui-monospace,Menlo,Consolas,"D2Coding",monospace; }
  .dot { display:inline-block; width:10px; height:10px; border-radius:50%; border:1px solid rgba(0,0,0,.25); margin-right:5px; vertical-align:-1px; }
  label.lamp { font-size:12px; color:var(--sub); display:flex; align-items:center; gap:6px; white-space:nowrap; }
  input[type=number] { width:68px; height:32px; border:1px solid var(--line); border-radius:6px; padding:0 8px; font:13px ui-monospace,Menlo,Consolas,monospace; }
  button { height:32px; padding:0 14px; border-radius:6px; border:1px solid var(--ink); background:#fff; color:var(--ink); font:600 13px inherit; cursor:pointer; white-space:nowrap; }
  button:hover { background:#F4F3EF; } button:disabled { opacity:.45; cursor:default; }
  button.danger { border-color:var(--danger); color:var(--danger); }
  .msg { flex-basis:100%; font-size:13px; }
  .empty { color:var(--sub); font-size:13px; padding:8px 0; }
  .sent { display:flex; align-items:center; gap:12px; flex-wrap:wrap; font-size:13px; }
</style>
</head>
<body>
<main>
  <h1>WaveLight 보내기</h1>
  <p class="lead">종목을 올리면 색마다 빈 줄에 들어가 출발 신호를 기다립니다. 출발은 WaveLight 화면의 Fire 로 합니다.</p>

  <section class="card">
    <h2>연결</h2>
    <dl class="kv" id="conn"><dt>상태</dt><dd class="muted">확인하는 중</dd></dl>
  </section>

  <section class="card">
    <h2>종목</h2>
    <div id="events"><div class="empty">서버에서 받는 중입니다.</div></div>
  </section>

  <section class="card">
    <h2>올린 줄</h2>
    <div id="sent"><div class="empty">아직 올린 줄이 없습니다.</div></div>
  </section>
</main>
<script>
(function () {
  var COLORS = { green: ['초록', '#2E9E4F'], red: ['빨강', '#D93025'], white: ['흰색', '#FFFFFF'], blue: ['파랑', '#1A73E8'] };
  var lampEdit = {};      // 종목 id → 운영자가 고친 출발선
  var msgs = {};          // 종목 id → 마지막 결과 문장
  var busy = false, last = null;
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function clock(sec) { var t = Math.round(sec * 100) / 100, m = Math.floor(t / 60), s = Math.round((t - m * 60) * 100) / 100; return m + ':' + (s < 10 ? '0' : '') + (Number.isInteger(s) ? s : s.toFixed(2)); }
  function ago(ms) { if (!ms) return '아직 못 받음'; var s = Math.round((Date.now() - ms) / 1000); return s < 60 ? s + '초 전' : Math.round(s / 60) + '분 전'; }
  function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PaceRise-Agent': '1' }, body: JSON.stringify(body || {}) }).then(function (r) { return r.json(); });
  }
  function render(d) {
    last = d;
    var c = d.controller, conn = [];
    conn.push('<dt>대회</dt><dd>' + esc(d.competition_name || ('대회 ' + d.competition_id)) + '</dd>');
    conn.push('<dt>서버</dt><dd>' + (d.sync_error ? '<span class="bad">받지 못함</span> <span class="muted">' + esc(d.sync_error) + ' · 마지막으로 받은 내용을 씁니다</span>' : '<span class="ok">받음</span> <span class="muted">' + ago(d.synced_at) + '</span>') + '</dd>');
    if (!d.controller_url) conn.push('<dt>컨트롤러</dt><dd class="muted">주소가 설정되지 않았습니다. 폴더의 파일만 맞춥니다.</dd>');
    else if (!c) conn.push('<dt>컨트롤러</dt><dd><span class="bad">연결 안 됨</span> <span class="muted">' + esc(d.controller_url) + ' · ' + esc(d.controller_error) + '</span></dd>');
    else conn.push('<dt>컨트롤러</dt><dd><span class="ok">연결됨</span> <span class="muted">한 바퀴 조명 ' + c.lampsInRound + '개 · 버전 ' + esc(c.version) + '</span></dd>'
      + '<dt>조명 전원</dt><dd>' + (c.lampsOn ? '켜짐' : '<span class="bad">꺼짐</span> <span class="muted">WaveLight 화면에서 켜야 조명이 보입니다</span>') + '</dd>');
    conn.push('<dt>파일 폴더</dt><dd class="muted">' + esc(d.dir) + '</dd>');
    document.getElementById('conn').innerHTML = conn.join('');

    var canSend = !!c && !busy;
    var rows = (d.events || []).map(function (ev) {
      var lines = ev.files.map(function (f) { var k = COLORS[f.color_key] || [f.color_key, '#ccc']; return '<span><i class="dot" style="background:' + k[1] + '"></i>' + esc(k[0]) + ' ' + clock(f.total_seconds) + '</span>'; }).join('');
      var lamp = lampEdit[ev.id] != null ? lampEdit[ev.id] : ev.start_lamp;
      var none = !ev.files.length;
      return '<div class="row"><div class="name"><b>' + esc(ev.label) + '</b><span>' + esc(ev.event_name) + '</span></div>'
        + '<div class="lines">' + (lines || '<span class="muted">랩타임이 비어 있습니다</span>') + '</div>'
        + '<label class="lamp">출발선 조명 <input type="number" min="0" max="399" data-lamp="' + ev.id + '" value="' + esc(lamp) + '"' + (none ? ' disabled' : '') + '></label>'
        + '<button data-send="' + ev.id + '"' + (canSend && !none ? '' : ' disabled') + '>올리기</button>'
        + (msgs[ev.id] ? '<div class="msg ' + (msgs[ev.id].ok ? 'ok' : 'bad') + '">' + esc(msgs[ev.id].text) + '</div>' : '')
        + '</div>';
    }).join('');
    var box = document.getElementById('events');
    if (!(document.activeElement && document.activeElement.hasAttribute && document.activeElement.hasAttribute('data-lamp')))
      box.innerHTML = rows || '<div class="empty">' + (d.synced_at ? '이 대회에 저장된 페이싱 설정이 없습니다. 관리 화면의 페이싱 라이트에서 저장하면 여기에 나옵니다.' : '서버에서 받는 중입니다.') + '</div>';

    var sent = d.sent || [];
    document.getElementById('sent').innerHTML = sent.length
      ? '<div class="sent"><div style="flex:1 1 300px">' + sent.map(function (s) { var k = COLORS[s.color_key] || [s.color_key, '#ccc']; return '<div>줄 ' + s.slot + ' · <i class="dot" style="background:' + k[1] + '"></i>' + esc(k[0]) + ' · ' + esc(s.label) + '</div>'; }).join('') + '</div>'
        + '<button class="danger" id="cancel"' + (busy ? ' disabled' : '') + '>올린 줄 취소</button></div>'
      : '<div class="empty">아직 올린 줄이 없습니다.</div>';
  }
  function refresh() { return fetch('/api/state').then(function (r) { return r.json(); }).then(render).catch(function () {}); }

  document.addEventListener('input', function (e) { var id = e.target.getAttribute && e.target.getAttribute('data-lamp'); if (id) lampEdit[id] = e.target.value; });
  document.addEventListener('click', function (e) {
    var t = e.target, id = t.getAttribute && t.getAttribute('data-send');
    if (id && last) {
      var ev = last.events.filter(function (x) { return String(x.id) === id; })[0]; if (!ev) return;
      var lamp = lampEdit[id] != null && lampEdit[id] !== '' ? parseInt(lampEdit[id], 10) : ev.start_lamp;
      if (!(lamp >= 0 && lamp < 400)) { msgs[id] = { ok: false, text: '출발선 조명은 0~399 사이여야 합니다.' }; render(last); return; }
      var names = ev.files.map(function (f) { return (COLORS[f.color_key] || [f.color_key])[0]; }).join(' · ');
      if (!confirm(ev.label + '\\n' + names + ' ' + ev.files.length + '줄을 컨트롤러에 올립니다.\\n출발선 조명 ' + lamp + ' · 출발 신호 대기')) return;
      busy = true; render(last);
      post('/api/send', { event_id: ev.id, start_lamp: lamp }).then(function (r) {
        msgs[id] = r.ok
          ? { ok: true, text: '줄 ' + r.lines.map(function (l) { return l.slot; }).join(' · ') + '에 올렸습니다. WaveLight 화면에서 Fire 를 누르면 출발합니다.' + (r.lampsOn ? '' : ' 조명 전원이 꺼져 있습니다.') }
          : { ok: false, text: r.error || '올리지 못했습니다.' };
      }).catch(function () { msgs[id] = { ok: false, text: '에이전트와 연결이 끊겼습니다.' }; }).then(function () { busy = false; return refresh(); });
    }
    if (t.id === 'cancel') {
      if (!confirm('에이전트가 올린 줄을 컨트롤러에서 취소합니다.')) return;
      busy = true; render(last);
      post('/api/cancel').catch(function () {}).then(function () { busy = false; msgs = {}; return refresh(); });
    }
  });
  refresh(); setInterval(refresh, 3000);
})();
</script>
</body>
</html>
`;
