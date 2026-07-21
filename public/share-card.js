// ============================================================
// SNS 기록 카드 (share-card.js)
// ------------------------------------------------------------
// 선수가 대시보드 결과표에서 자기 기록 행을 누르면 인스타그램 규격
// (1080x1350, 4:5) PNG 카드를 만들어 저장/공유할 수 있게 한다.
//
// 디자인 방향: "화이트 에디토리얼" — 상장 문법(가운데 정렬/테두리/
// 균일한 글자 크기/연한 배경 워터마크)을 의도적으로 버렸다.
//   - 전부 좌측 정렬
//   - 기록만 압도적으로 크게, 나머지는 극단적으로 작게
//   - 테두리·구분선 없음
//   - 로고는 워터마크로 깔지 않고 우하단에서 잘려 나가게 배치
//
// 렌더링은 서버가 아니라 브라우저에서 한다. node-canvas 는 devDependency
// 라 배포(`npm ci --omit=dev`) 에서 빠지므로 서버 라우트로 만들면 운영에서
// 터진다. html2canvas-pro 는 이미 dependencies 에 있고 results.js 의
// exportPNG() 에서 검증된 경로다.
// ============================================================

const SC_W = 1080, SC_H = 1350;

let _scLoaded = false;      // html2canvas 로더 1회성
let _scStyled = false;      // 스타일 주입 1회성
let _scData = null;         // 현재 팝업에 뜬 카드 데이터
let _scPrebuilt = null;     // 미리 구워둔 PNG blob (공유 버튼의 즉시 응답용)
let _scPrebuiltKey = '';    // 그 blob 이 어떤 카드 데이터로 만들어졌는지

// ------------------------------------------------------------
// html2canvas 지연 로드 — 카드를 실제로 열 때만 206KB 를 받는다.
// (대시보드 첫 로딩을 무겁게 만들지 않기 위해)
// ------------------------------------------------------------
function _scLoadHtml2Canvas() {
    if (typeof html2canvas !== 'undefined') return Promise.resolve();
    if (_scLoaded) return _scLoaded;
    _scLoaded = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = '/lib/html2canvas-pro.min.js';
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('html2canvas 로드 실패'));
        document.head.appendChild(s);
    });
    return _scLoaded;
}

// ------------------------------------------------------------
// 스타일 주입
// 기록 숫자는 Audiowide, 한글은 NanumSquare. 둘 다 저장소에 이미 있다.
// ------------------------------------------------------------
function _scInjectStyles() {
    if (_scStyled) return;
    _scStyled = true;
    const css = `
@font-face { font-family:'SCNum'; src:url('/fonts/Audiowide-Regular.ttf') format('truetype'); font-display:block; }
@font-face { font-family:'SCKo'; src:url('/fonts/NanumSquare_acR.ttf') format('truetype'); font-weight:400; font-display:block; }
@font-face { font-family:'SCKo'; src:url('/fonts/NanumSquare_acB.ttf') format('truetype'); font-weight:700; font-display:block; }

/* ── 팝업 ── */
.sc-overlay { position:fixed; inset:0; background:rgba(17,17,17,0.72); z-index:9000;
    display:none; align-items:center; justify-content:center; padding:20px; }
.sc-overlay.show { display:flex; }
.sc-sheet { background:#fff; border-radius:20px; padding:22px 20px 20px; width:100%;
    max-width:400px; max-height:92vh; overflow-y:auto; text-align:center; }
.sc-sheet-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:16px; }
.sc-sheet-head strong { font-size:15px; font-weight:700; color:#111; }
.sc-x { border:none; background:none; font-size:26px; line-height:1; color:#999; cursor:pointer; padding:0 4px; }

/* 실제 카드는 1080x1350 고정. 미리보기는 transform 으로 축소만 한다.
   (축소 렌더가 아니라 원본을 그대로 캡처하므로 결과물 품질에 영향 없음) */
.sc-stage { position:relative; margin:0 auto; overflow:hidden; border-radius:12px;
    box-shadow:0 6px 24px rgba(0,0,0,0.14); }
.sc-stage .sc-card { position:absolute; top:0; left:0; transform-origin:top left; }

.sc-opts { display:flex; align-items:center; justify-content:center; gap:8px;
    margin:16px 0 14px; font-size:13px; color:#444; }
.sc-opts label { display:flex; align-items:center; gap:6px; cursor:pointer; }
.sc-btns { display:flex; gap:8px; }
.sc-btn { flex:1; padding:13px 0; border:none; border-radius:11px; font-size:14px;
    font-weight:700; cursor:pointer; font-family:inherit; }
.sc-btn-sub { background:#f1f1f1; color:#333; }
.sc-btn-main { background:#111; color:#fff; }
.sc-btn:disabled { opacity:0.5; cursor:default; }

/* ── 카드 본체 (1080x1350) ── */
/* text-align:left 는 필수 — 팝업 시트가 center 라 상속되면 카드가 상장처럼 보인다 */
.sc-card { width:${SC_W}px; height:${SC_H}px; background:#fff; position:relative;
    overflow:hidden; font-family:'SCKo',sans-serif; color:#111; text-align:left;
    box-sizing:border-box; padding:96px 88px; }
.sc-event { font-family:'SCNum','SCKo',sans-serif; font-size:76px; line-height:1;
    letter-spacing:-1px; color:#111; }
.sc-event-ko { font-family:'SCKo',sans-serif; font-weight:700; }
.sc-div { margin-top:20px; font-size:30px; font-weight:400; color:#9a9a9a; letter-spacing:-0.5px; }
.sc-record { font-family:'SCNum',sans-serif; font-size:206px; line-height:1;
    letter-spacing:-6px; margin-top:118px; color:#111; }
.sc-record.sc-record-sm { font-size:150px; letter-spacing:-4px; }
.sc-name { margin-top:262px; font-size:52px; font-weight:700; letter-spacing:-1.5px; }
/* 혼성경기(10종/7종): 총점 아래에 세부 기록만 나열한다.
   종목명은 넣지 않는다 — 순서가 국제 규정으로 고정돼 있어 선수는 순서로 안다.
   라벨을 넣는 순간 '표'가 되고, 표는 상장 쪽으로 끌려간다.
   줄바꿈이 Day 1 / Day 2 경계를 그대로 나타낸다 (10종 5+5, 7종 4+3). */
.sc-marks { margin-top:84px; display:grid; gap:26px 20px; }
.sc-marks span { font-family:'SCNum',sans-serif; font-size:33px; letter-spacing:-1px;
    color:#111; white-space:nowrap; }
.sc-marks span.sc-mark-out { color:#c0c0c0; }
.sc-has-marks .sc-name { margin-top:84px; }
.sc-team { margin-top:14px; font-size:30px; font-weight:400; color:#6b6b6b; letter-spacing:-0.5px; }
.sc-meta { margin-top:12px; font-size:26px; font-weight:400; color:#9a9a9a; letter-spacing:-0.3px; }
.sc-foot { position:absolute; left:88px; bottom:88px; }
.sc-comp { font-size:24px; font-weight:400; color:#9a9a9a; letter-spacing:-0.3px;
    max-width:600px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sc-date { margin-top:8px; font-family:'SCNum',sans-serif; font-size:21px;
    letter-spacing:0.5px; color:#b0b0b0; }
.sc-brand { margin-top:14px; font-family:'SCNum',sans-serif; font-size:22px;
    letter-spacing:2px; color:#111; }
/* 로고는 우하단에서 카드 밖으로 잘려 나간다 (워터마크 아님) */
/* 로고는 카드 안에 온전히 들어온다 (잘리지 않음).
   더 왼쪽으로 밀거나 키우면 이름·순위 블록과 겹치고,
   더 내리면 footer 의 'powered by PACE RISE' 글자와 부딪힌다. */
.sc-logo { position:absolute; right:20px; bottom:300px; width:620px;
    opacity:0.14; pointer-events:none; }
/* 혼성경기는 세부 기록 두 줄이 로고 자리까지 내려오므로 로고를 덜 올린다 */
.sc-has-marks .sc-logo { bottom:200px; }
`;
    const el = document.createElement('style');
    el.id = 'sc-styles';
    el.textContent = css;
    document.head.appendChild(el);
}

// ------------------------------------------------------------
// 종목명 표기
// "100m" → "100M" (영문/숫자는 대문자로 키워 스포츠 타이포로)
// "멀리뛰기" → 그대로 (한글은 toUpperCase 영향 없음)
// ------------------------------------------------------------
function _scEventLabel(name) {
    const s = String(name || '').trim();
    return { text: s.toUpperCase(), isKo: /[가-힣]/.test(s) };
}

// ------------------------------------------------------------
// 카드 DOM 생성 — 1080x1350 원본 크기 그대로
// ------------------------------------------------------------
function _scBuildCard(d) {
    const card = document.createElement('div');
    card.className = 'sc-card';

    const ev = _scEventLabel(d.eventName);
    const marks = Array.isArray(d.marks) ? d.marks : null;
    if (marks && marks.length) card.classList.add('sc-has-marks');

    // 순위 + 레인/No. 을 점으로 이어 한 줄로 (항목이 늘어도 레이아웃이 안 깨진다)
    // 혼성경기는 세부 종목마다 레인이 달라 종합 카드에 레인 번호가 의미 없다 → 순위만.
    const metaParts = [];
    if (d.showRank && d.rank) metaParts.push(`${d.rank}위`);
    if (!marks && d.laneLabel && d.laneNumber) metaParts.push(`${d.laneLabel} ${d.laneNumber}`);

    let marksHtml = '';
    if (marks && marks.length) {
        const perRow = d.marksPerRow || 5;
        // 1fr 등폭 — max-content 로 두면 두 줄의 열 간격이 들쭉날쭉해 보인다
        marksHtml = `<div class="sc-marks" style="grid-template-columns:repeat(${perRow},1fr);">`
            + marks.map(m => {
                const out = /^(DNS|DNF|DQ|NM|—)$/.test(String(m));
                return `<span class="${out ? 'sc-mark-out' : ''}">${_scEsc(m)}</span>`;
            }).join('')
            + '</div>';
    }

    // 기록 문자열이 길면(예: "1:52.34") 한 줄에 안 들어가므로 한 단계 줄인다
    const recStr = String(d.record || '—');
    const recCls = recStr.length > 6 ? 'sc-record sc-record-sm' : 'sc-record';

    card.innerHTML = `
        <div class="sc-event ${ev.isKo ? 'sc-event-ko' : ''}">${_scEsc(ev.text)}</div>
        ${d.division ? `<div class="sc-div">${_scEsc(d.division)}</div>` : ''}
        <div class="${recCls}">${_scEsc(recStr)}</div>
        ${marksHtml}
        <div class="sc-name">${_scEsc(d.name)}</div>
        ${d.team ? `<div class="sc-team">${_scEsc(d.team)}</div>` : ''}
        ${metaParts.length ? `<div class="sc-meta">${_scEsc(metaParts.join('  ·  '))}</div>` : ''}
        <div class="sc-foot">
            ${d.competition ? `<div class="sc-comp">${_scEsc(d.competition)}</div>` : ''}
            ${d.compDate ? `<div class="sc-date">${_scEsc(_scFmtDate(d.compDate))}</div>` : ''}
            <div class="sc-brand">powered by PACE RISE</div>
        </div>
        <img class="sc-logo" src="/brand/pacerise-mark.png" alt="">
    `;
    return card;
}

// 대회 날짜 표기
// API 는 "2026-02-19 ~ 2026-02-21" 형태로 준다. 카드에는 점 표기로 바꾸고,
// 같은 해·같은 달이면 뒷 날짜에서 중복을 덜어낸다 → "2026.02.19 – 02.21"
function _scFmtDate(raw) {
    const s = String(raw || '').trim();
    if (!s) return '';
    // 범위 구분자가 '-' 인 경우가 있어 split 대신 날짜 패턴을 직접 뽑는다
    const dates = s.match(/\d{4}-\d{2}-\d{2}/g) || [];
    if (dates.length === 0) return s;
    const dot = d => d.replace(/-/g, '.');
    if (dates.length === 1) return dot(dates[0]);
    const [a, b] = dates;
    if (a === b) return dot(a);
    const [ay, am] = a.split('-'), [by, bm, bd] = b.split('-');
    if (ay === by && am === bm) return `${dot(a)} – ${bd}`;
    if (ay === by) return `${dot(a)} – ${bm}.${bd}`;
    return `${dot(a)} – ${dot(b)}`;
}

function _scEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ------------------------------------------------------------
// 미리보기 갱신 — 원본 카드를 만들고 stage 크기에 맞춰 축소해서 보여준다
// ------------------------------------------------------------
function _scRenderPreview() {
    const stage = document.getElementById('sc-stage');
    if (!stage || !_scData) return;
    stage.innerHTML = '';
    const card = _scBuildCard(_scData);
    stage.appendChild(card);

    const w = stage.clientWidth || 320;
    const k = w / SC_W;
    card.style.transform = `scale(${k})`;
    stage.style.height = Math.round(SC_H * k) + 'px';
}

// ------------------------------------------------------------
// 카드 팝업 열기
// payload: { eventName, division, record, name, team, rank, laneLabel,
//            laneNumber, competition }
// ------------------------------------------------------------
function openShareCard(payload) {
    _scInjectStyles();
    _scData = Object.assign({ showRank: true }, payload);

    let ov = document.getElementById('sc-overlay');
    if (!ov) {
        ov = document.createElement('div');
        ov.id = 'sc-overlay';
        ov.className = 'sc-overlay';
        ov.innerHTML = `
            <div class="sc-sheet" onclick="event.stopPropagation()">
                <div class="sc-sheet-head">
                    <strong>기록 카드</strong>
                    <button class="sc-x" onclick="closeShareCard()">&times;</button>
                </div>
                <div class="sc-stage" id="sc-stage"></div>
                <div class="sc-opts">
                    <label><input type="checkbox" id="sc-rank" checked onchange="_scToggleRank(this.checked)"> 순위 표시</label>
                </div>
                <div class="sc-btns">
                    <button class="sc-btn sc-btn-sub" id="sc-save" onclick="_scSave()">이미지 저장</button>
                    <button class="sc-btn sc-btn-main" id="sc-share" onclick="_scShare()">공유</button>
                </div>
            </div>`;
        ov.addEventListener('click', () => closeShareCard());
        document.body.appendChild(ov);
    }

    const cb = document.getElementById('sc-rank');
    if (cb) cb.checked = true;
    // 순위가 없는 경우(실격/기록없음)엔 토글 자체를 숨긴다
    const opts = ov.querySelector('.sc-opts');
    if (opts) opts.style.display = _scData.rank ? '' : 'none';

    ov.classList.add('show');
    if (window.pushModalState) pushModalState(() => closeShareCard());

    // 폰트가 로드된 뒤에 그려야 미리보기와 최종 PNG 가 어긋나지 않는다
    const draw = () => { _scRenderPreview(); _scPrewarm(); };
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(draw).catch(draw);
    else _scRenderPreview();
}

function closeShareCard() {
    const ov = document.getElementById('sc-overlay');
    if (!ov || !ov.classList.contains('show')) return;
    ov.classList.remove('show');
    if (window.popModalState) popModalState();
}

function _scToggleRank(on) {
    if (!_scData) return;
    _scData.showRank = !!on;
    _scRenderPreview();
    _scPrewarm();
}

// ------------------------------------------------------------
// PNG 생성 — 화면에 보이는 축소본이 아니라 1080x1350 원본을 캡처한다.
// 화면 밖에 원본 크기로 잠깐 붙였다가 캡처 후 제거.
// ------------------------------------------------------------
async function _scToBlob() {
    await _scLoadHtml2Canvas();
    if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (e) {} }

    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:-99999px;top:0;';
    const card = _scBuildCard(_scData);
    holder.appendChild(card);
    document.body.appendChild(holder);

    try {
        // 로고 이미지가 로드되기 전에 캡처되면 로고가 빠진 카드가 나온다
        const img = card.querySelector('.sc-logo');
        if (img && !img.complete) {
            await new Promise(res => { img.onload = res; img.onerror = res; });
        }
        const canvas = await html2canvas(card, {
            width: SC_W, height: SC_H, scale: 1,
            backgroundColor: '#ffffff', useCORS: true, logging: false
        });
        return await new Promise(res => canvas.toBlob(res, 'image/png'));
    } finally {
        holder.remove();
    }
}

function _scKey() { try { return JSON.stringify(_scData); } catch (e) { return ''; } }

// 캐시된 blob 이 현재 카드와 같으면 재사용, 아니면 새로 굽는다
async function _scBlob() {
    if (_scPrebuilt && _scPrebuiltKey === _scKey()) return _scPrebuilt;
    const blob = await _scToBlob();
    _scPrebuilt = blob;
    _scPrebuiltKey = _scKey();
    return blob;
}

// 팝업이 뜨는 즉시 백그라운드로 PNG 를 구워둔다 → 공유 버튼이 기다림 없이
// navigator.share() 를 호출할 수 있다(사용자 조작 권한 만료 방지).
function _scPrewarm() {
    const key = _scKey();
    _scPrebuilt = null;
    _scPrebuiltKey = '';
    _scToBlob().then(b => {
        if (_scKey() === key) { _scPrebuilt = b; _scPrebuiltKey = key; }
    }).catch(() => { /* 실패해도 버튼 누를 때 다시 시도한다 */ });
}

function _scFileName() {
    const d = _scData || {};
    return `${d.name || 'record'}_${d.eventName || ''}.png`.replace(/\s+/g, '');
}

// 다운로드
// ⚠️ 앵커를 DOM 에 붙이지 않고 click() 하면 브라우저가 download 속성을 무시하고
// blob URL 로 '이동'해 버린다 — 페이지가 about:blank 로 날아가 앱이 종료된 것처럼 보인다.
// 반드시 body 에 붙였다가 지울 것.
function _scDownload(blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = _scFileName();
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function _scBusy(on) {
    ['sc-save', 'sc-share'].forEach(id => {
        const b = document.getElementById(id);
        if (b) b.disabled = on;
    });
}

async function _scSave() {
    _scBusy(true);
    try {
        _scDownload(await _scBlob());
    } catch (e) {
        alert('이미지 생성에 실패했습니다.');
    } finally { _scBusy(false); }
}

async function _scShare() {
    _scBusy(true);
    try {
        // 미리 만들어둔 blob 이 있으면 await 없이 바로 share() 를 호출한다.
        // navigator.share() 는 사용자 조작 직후에만 허용되는데(transient
        // activation), PNG 생성을 기다리는 동안 그 권한이 만료되면
        // NotAllowedError 가 난다. openShareCard() 에서 미리 굽는 이유.
        const ready = _scPrebuilt;
        const blob = ready || await _scBlob();
        const file = new File([blob], _scFileName(), { type: 'image/png' });

        if (navigator.canShare && navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file] });
        } else {
            _scDownload(blob);          // 공유 미지원(주로 PC) → 저장으로 대체
        }
    } catch (e) {
        if (e && e.name === 'AbortError') return;       // 사용자가 공유창을 닫음
        if (e && e.name === 'NotAllowedError') {        // 조작 권한 만료 → 저장으로 대체
            try { _scDownload(await _scBlob()); return; } catch (e2) {}
        }
        alert('공유에 실패했습니다.');
    } finally { _scBusy(false); }
}
