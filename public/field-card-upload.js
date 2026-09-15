/**
 * field-card-upload.js — 기록 입력창용 필드 기록카드 업로드 창
 *
 * 종목·조가 정해진 화면(record.html)에서 심판 수기 기록카드 사진(또는 xlsx)을 올리면
 *   1) 사진을 여러 장 모아(기록표 + 풍속표) 서버 AI 전사 → 2) 표에서 배번·성명·기록·풍속을 직접 고치면
 *   고칠 때마다 서버가 다시 매칭·검산 → 3) 저장.
 * 서버: /api/field-card/transcribe · preview · analyze-json · import-json (heat_id 고정 모드, 관리자 또는 운영키)
 *
 * 사용: FieldCardUpload.open({ competitionId, heatId, key, eventName, gender, division, roundType, heatNumber,
 *                              category, needsWind, onSaved })
 */
(function () {
    'use strict';
    const MAX_EDGE = 2576, QUALITY = 0.88;
    const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const fmtWind = w => { if (w == null || w === '') return ''; const v = Number(w); if (Number.isNaN(v)) return String(w); return (v > 0 ? '+' : '') + v.toFixed(1); };
    const ROUND_L = { preliminary: '예선', semifinal: '준결승', final: '결승' };
    const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

    async function readJson(resp) {
        const text = await resp.text();
        try { return JSON.parse(text); }
        catch (e) {
            const hint = resp.status === 413 ? ' 업로드 용량 제한에 걸렸습니다 (nginx client_max_body_size).'
                : (resp.status === 502 || resp.status === 504) ? ' 프록시 응답 시간 제한에 걸렸을 수 있습니다.'
                : resp.status === 404 ? ' 서버에 이 기능이 배포되지 않았습니다.' : '';
            const err = new Error(`서버가 JSON 이 아닌 응답을 보냈습니다 (HTTP ${resp.status}).${hint}`);
            err.status = resp.status; throw err;
        }
    }
    // 브라우저에서 긴 변 maxEdge px JPEG 로 축소 (업로드·비용 절감, EXIF 회전 반영)
    async function shrinkImage(file, maxEdge = MAX_EDGE, quality = QUALITY) {
        let bmp;
        try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
        catch (e) { throw new Error(`${file.name}: 브라우저가 읽지 못하는 형식입니다. HEIC 라면 JPEG 로 변환해 주세요.`); }
        const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
        const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(bmp, 0, 0, w, h);
        if (bmp.close) bmp.close();
        const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', quality));
        if (!blob) throw new Error(`${file.name}: 이미지 변환 실패`);
        return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
    }
    const isXlsx = f => /\.xlsx?$/i.test(f.name);
    const isImage = f => /^image\//i.test(f.type) || /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(f.name);

    const CSS = `
    .fcu-overlay{position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:9000;display:flex;align-items:flex-start;justify-content:center;padding:16px;overflow:auto}
    .fcu-modal{background:#fff;color:#111827;border-radius:12px;width:min(1180px,100%);max-height:calc(100vh - 32px);display:flex;flex-direction:column;box-shadow:0 20px 50px rgba(0,0,0,.35);font-size:13px}
    .fcu-head{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid #e5e7eb}
    .fcu-head .fcu-ctx{color:#3d5a8a;font-weight:600}
    .fcu-close{margin-left:auto;background:none;border:0;font-size:20px;cursor:pointer;color:#6b7280}
    .fcu-body{padding:14px 16px;overflow:auto}
    .fcu-foot{display:flex;gap:8px;align-items:center;padding:12px 16px;border-top:1px solid #e5e7eb;flex-wrap:wrap}
    .fcu-foot .fcu-spacer{flex:1}
    .fcu-btn{border:1px solid #cbd5e1;background:#fff;border-radius:8px;padding:7px 14px;font-size:13px;cursor:pointer;color:#111827}
    .fcu-btn:disabled{opacity:.45;cursor:not-allowed}
    .fcu-btn.pri{background:#3d5a8a;border-color:#3d5a8a;color:#fff;font-weight:600}
    .fcu-btn.sm{padding:3px 8px;font-size:12px;border-radius:6px}
    .fcu-drop{border:2px dashed #b7c6de;border-radius:10px;padding:22px 14px;text-align:center;cursor:pointer;background:#fbfcfe}
    .fcu-drop.over{background:#eef3fa;border-color:#5b7fb5}
    .fcu-files{display:flex;gap:10px;flex-wrap:wrap;margin-top:12px}
    .fcu-file{position:relative;width:120px;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;background:#f8fafc}
    .fcu-file img{width:100%;height:90px;object-fit:cover;display:block}
    .fcu-file .fcu-fn{font-size:10px;padding:4px 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#374151}
    .fcu-file .fcu-x{position:absolute;top:4px;right:4px;background:rgba(17,24,39,.75);color:#fff;border:0;border-radius:50%;width:20px;height:20px;cursor:pointer;font-size:12px;line-height:20px;padding:0}
    .fcu-note{font-size:12px;color:#6b7280;margin-top:8px;line-height:1.6}
    .fcu-meta{border:1px solid #cfdcee;background:#eef3fa;border-radius:8px;padding:8px 12px;margin-bottom:10px;font-size:12px;line-height:1.6}
    .fcu-wrap{overflow-x:auto}
    .fcu-table{border-collapse:collapse;font-size:12px;min-width:100%}
    .fcu-table th,.fcu-table td{border-top:1px solid #f1f5f9;padding:3px 4px;text-align:center;vertical-align:top;white-space:nowrap}
    .fcu-table th{background:#f7f8fa;font-weight:600;font-size:11px}
    .fcu-table td.l{text-align:left}
    .fcu-in{border:1px solid #d1d5db;border-radius:5px;padding:3px 4px;font-size:12px;width:62px;text-align:center;background:#fff;color:#111827}
    .fcu-in.s{width:44px}.fcu-in.n{width:72px}.fcu-in.w{width:52px;margin-top:2px;font-size:11px;color:#374151;display:block;margin-left:auto;margin-right:auto}
    .fcu-in.unc{background:#fef3c7;border-color:#f59e0b}
    .fcu-in.badv{background:#fee2e2;border-color:#ef4444}
    .fcu-db{font-size:11px;text-align:left}
    .fcu-ok{color:#166534}.fcu-err{color:#dc2626;font-weight:600}.fcu-warn{color:#b45309}.fcu-mut{color:#9ca3af}
    .fcu-calc{font-weight:600}.fcu-calc small{display:block;font-weight:400;color:#9ca3af;font-size:10px}
    .fcu-badge{display:inline-block;padding:0 6px;border-radius:10px;font-size:10px;font-weight:700}
    .fcu-badge.new{background:#dcfce7;color:#166534}.fcu-badge.chg{background:#fef3c7;color:#92400e}.fcu-badge.same{background:#f3f4f6;color:#6b7280}.fcu-badge.skip{background:#fee2e2;color:#991b1b}
    .fcu-issues td{text-align:left;font-size:11px;padding:2px 8px 6px;background:#fffbeb}
    .fcu-issue.error{color:#dc2626}.fcu-issue.warn{color:#b45309}.fcu-issue.info{color:#6b7280}
    .fcu-chip{display:inline-block;border:1px dashed #94a3b8;border-radius:12px;padding:1px 8px;font-size:11px;margin:2px;cursor:pointer;background:#fff}
    .fcu-status{font-size:12px;color:#374151;margin-top:8px}
    @media (max-width:640px){.fcu-overlay{padding:6px}.fcu-modal{border-radius:8px;max-height:calc(100vh - 12px)}.fcu-body{padding:10px}}
    `;
    function ensureCss() {
        if (document.getElementById('fcu-css')) return;
        const st = document.createElement('style'); st.id = 'fcu-css'; st.textContent = CSS; document.head.appendChild(st);
    }

    function open(opts) {
        ensureCss();
        const S = { files: [], urls: new Map(), card: null, analysis: null, meta: null, target: null, busy: false, step: 1, dirty: false, saved: false, timer: null, status: '' };
        const ctxLabel = `${opts.gender === 'M' ? '남자' : opts.gender === 'F' ? '여자' : ''} ${opts.division || ''} ${opts.eventName || ''} ${ROUND_L[opts.roundType] || ''} ${opts.heatNumber ? opts.heatNumber + '조' : ''}`.replace(/\s+/g, ' ').trim();
        const isHeight = opts.category === 'field_height';
        const needsWind = !!opts.needsWind;

        const ov = document.createElement('div'); ov.className = 'fcu-overlay';
        ov.innerHTML = `<div class="fcu-modal" role="dialog" aria-modal="true">
            <div class="fcu-head"><strong>📷 기록카드 업로드</strong><span class="fcu-ctx">${esc(ctxLabel)}</span><button class="fcu-close" data-act="close" title="닫기">✕</button></div>
            <div class="fcu-body"></div>
            <div class="fcu-foot"></div></div>`;
        document.body.appendChild(ov);
        const body = ov.querySelector('.fcu-body'), foot = ov.querySelector('.fcu-foot');

        const urlFor = (f) => { if (!S.urls.has(f)) S.urls.set(f, URL.createObjectURL(f)); return S.urls.get(f); };
        function close(force) {
            if (!force && S.step === 2 && S.dirty && !S.saved && !confirm('저장하지 않은 수정 내용이 있습니다. 닫을까요?')) return;
            for (const u of S.urls.values()) { try { URL.revokeObjectURL(u); } catch (e) {} }
            ov.remove();
        }
        function fd(extra) {
            const f = new FormData();
            f.append('admin_key', opts.key); f.append('competition_id', opts.competitionId); f.append('heat_id', opts.heatId);
            for (const [k, v] of Object.entries(extra || {})) f.append(k, v);
            return f;
        }
        const headers = () => ({ 'x-admin-key': opts.key });
        const postJson = (url, payload) => fetch(url, { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then(readJson);

        // ── 1단계: 파일 모으기 ──────────────────────────────────
        function addFiles(list) {
            const arr = Array.from(list || []);
            for (const f of arr) {
                if (!isXlsx(f) && !isImage(f)) continue;
                if (S.files.some(x => x.name === f.name && x.size === f.size)) continue;
                S.files.push(f);
            }
            if (S.files.filter(isImage).length > 4) { S.files = S.files.filter(isImage).slice(0, 4).concat(S.files.filter(isXlsx)); alert('사진은 한 번에 4장까지 올릴 수 있습니다.'); }
            render();
        }
        function renderStep1() {
            const imgs = S.files.filter(isImage), xl = S.files.filter(isXlsx);
            body.innerHTML = `
                <div class="fcu-drop" data-act="pick">
                    <div style="font-size:24px;">📷</div>
                    <div style="font-weight:600;">카드 사진을 여기에 끌어다 놓거나 클릭해서 선택</div>
                    <div class="fcu-note">${needsWind ? '<strong>기록표와 풍속표 두 장</strong>을 차례로 올린 뒤 전사를 시작하세요. ' : ''}사진은 한 번에 4장까지, xlsx 파일도 됩니다. 종목과 조는 이 화면(${esc(ctxLabel)})으로 고정되고 선수는 배번으로 맞춥니다.</div>
                </div>
                <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;">
                    <label class="fcu-btn sm">사진 선택<input type="file" accept="image/*" multiple hidden data-in="img"></label>
                    <label class="fcu-btn sm">카메라로 촬영<input type="file" accept="image/*" capture="environment" hidden data-in="cam"></label>
                    <label class="fcu-btn sm">xlsx 선택<input type="file" accept=".xlsx,.xls" hidden data-in="xlsx"></label>
                </div>
                <div class="fcu-files">${S.files.map((f, i) => `<div class="fcu-file">${isImage(f) ? `<img src="${urlFor(f)}" alt="">` : '<div style="height:90px;display:flex;align-items:center;justify-content:center;font-size:28px;">📄</div>'}<div class="fcu-fn" title="${esc(f.name)}">${esc(f.name)}</div><button class="fcu-x" data-act="rm" data-i="${i}" title="제거">✕</button></div>`).join('')}</div>
                ${S.status ? `<div class="fcu-status">${esc(S.status)}</div>` : ''}`;
            const n = imgs.length;
            foot.innerHTML = `<span class="fcu-note" style="margin:0;">${n ? `사진 ${n}장` : ''}${xl.length ? ` xlsx ${xl.length}개` : ''}</span><span class="fcu-spacer"></span>
                <button class="fcu-btn" data-act="close">닫기</button>
                <button class="fcu-btn pri" data-act="start" ${(!S.files.length || S.busy) ? 'disabled' : ''}>${S.busy ? '처리 중…' : (xl.length && !n ? '파일 분석' : `전사 시작${n ? ` (${n}장)` : ''}`)}</button>`;
        }
        async function start() {
            if (S.busy || !S.files.length) return;
            const imgs = S.files.filter(isImage), xl = S.files.filter(isXlsx);
            S.busy = true; S.status = imgs.length ? `사진 ${imgs.length}장을 AI 로 전사하는 중입니다… 보통 10~30초 걸립니다.` : '파일을 분석하는 중입니다…'; render();
            try {
                let data;
                if (imgs.length) {
                    const send = async (edge, q) => {
                        const f = fd();
                        for (const im of imgs) f.append('images', await shrinkImage(im, edge, q));
                        return fetch('/api/field-card/transcribe', { method: 'POST', headers: headers(), body: f });
                    };
                    let resp = await send(MAX_EDGE, QUALITY);
                    if (resp.status === 413) { S.status = '업로드 용량 제한(413)으로 사진을 더 작게 줄여 다시 보냅니다…'; render(); resp = await send(1800, 0.75); }
                    data = await readJson(resp);
                    if (!resp.ok || !data.success) throw new Error(data.error || '전사 실패');
                } else {
                    const resp = await fetch('/api/field-card/preview', { method: 'POST', headers: headers(), body: fd({ file: xl[0] }) });
                    data = await readJson(resp);
                    if (!resp.ok || !data.success) throw new Error(data.error || '분석 실패');
                    if (!data.card) throw new Error('파일에서 이 조의 카드 하나를 찾지 못했습니다. 한 조의 기록만 담긴 파일을 올려 주세요.');
                }
                S.card = data.card; S.analysis = data; S.meta = data.transcription || null; S.target = data.target || null;
                S.step = 2; S.dirty = false; S.status = '';
            } catch (e) {
                S.status = '오류: ' + e.message;
            } finally { S.busy = false; render(); }
        }

        // ── 2단계: 표에서 수정 → 재분석 → 저장 ───────────────────
        const uncOf = (a) => {
            const set = new Set();
            for (const u of a.uncertain || []) {
                let m;
                if ((m = u.match(/^(\d)차\s*풍속/))) set.add('w' + m[1]);
                else if ((m = u.match(/^(\d)차/))) set.add('a' + m[1]);
                else if (/배번/.test(u)) set.add('bib'); else if (/성명|이름/.test(u)) set.add('name'); else if (/순서/.test(u)) set.add('order');
                else if (/최고/.test(u)) set.add('best'); else if (/순위/.test(u)) set.add('rank');
                else if (/^\d+(\.\d+)?$/.test(u)) { const idx = (S.card.bar_heights || []).findIndex(h => Number(h) === Number(u) || Number(h) * 100 === Number(u)); if (idx >= 0) set.add('m' + idx); }
            }
            return set;
        };
        function rowsOf() { const g = S.analysis && S.analysis.groups && S.analysis.groups[0]; return g && g.rows ? g.rows : []; }
        function renderStep2() {
            const card = S.card, g = S.analysis && S.analysis.groups ? S.analysis.groups[0] : null;
            const arows = rowsOf();
            const heights = card.bar_heights || [];
            const cols = isHeight ? heights : ['1차', '2차', '3차', '4차', '5차', '6차'];
            const t = S.meta;
            let html = '';
            if (t) {
                const usage = t.usage || {};
                html += `<div class="fcu-meta"><strong>AI 전사 완료</strong> · 카드 ${t.cards || 0}장 · 판독 불확실 셀 <strong class="${t.uncertain_cells ? 'fcu-warn' : 'fcu-mut'}">${t.uncertain_cells || 0}</strong>개
                    <span class="fcu-mut">· ${esc(t.model || '')} · 토큰 ${usage.input_tokens || 0}/${usage.output_tokens || 0}${t.cost_usd != null ? ` · 약 $${Number(t.cost_usd).toFixed(3)}` : ''}</span>
                    ${(t.notes || []).length ? `<div class="fcu-mut">AI 메모: ${esc(t.notes.join(' / '))}</div>` : ''}
                    <div class="fcu-mut">노란 칸은 AI 가 확신하지 못한 셀입니다. 배번·성명·기록을 고치면 자동으로 다시 매칭·검산합니다. 기록은 숫자 / 파울 X / 패스 - ${needsWind ? '· 풍속은 +0.8 처럼 부호 포함' : ''}${isHeight ? '· 높이 칸은 O, XO, XXO, XXX, -' : ''}.</div></div>`;
            } else {
                html += `<div class="fcu-meta">배번·성명·기록을 고치면 자동으로 다시 매칭·검산합니다.</div>`;
            }
            if (g && g.issues && g.issues.length) html += `<div style="margin-bottom:6px;">${g.issues.map(i => `<div class="fcu-issue ${i.level}">${i.level === 'error' ? '✕' : i.level === 'warn' ? '⚠' : 'ⓘ'} ${esc(i.msg)}</div>`).join('')}</div>`;
            if (isHeight) html += `<div style="margin-bottom:8px;font-size:12px;">바 높이 (왼쪽부터, 쉼표 구분): <input class="fcu-in" style="width:min(420px,80vw);text-align:left;" data-f="heights" value="${esc(heights.join(', '))}"></div>`;

            html += `<div class="fcu-wrap"><table class="fcu-table"><thead><tr><th>#</th><th>순서</th><th>배번</th><th>성명</th><th class="l">DB 선수</th>${cols.map(c => `<th>${esc(c)}</th>`).join('')}<th>최고<br><small>계산 / 카드</small></th><th>순위<br><small>계산 / 카드</small></th><th>구분</th><th>상태</th><th></th></tr></thead><tbody>`;
            card.athletes.forEach((a, i) => {
                const r = arows[i] || null;
                const unc = uncOf(a);
                const err = r ? r.issues.some(x => x.level === 'error') : false;
                const cells = cols.map((c, ci) => {
                    if (isHeight) return `<td><input class="fcu-in s ${unc.has('m' + ci) ? 'unc' : ''}" data-r="${i}" data-f="m" data-h="${ci}" value="${esc(a.marks[ci] || '')}"></td>`;
                    const n = ci + 1;
                    return `<td><input class="fcu-in ${unc.has('a' + n) ? 'unc' : ''}" data-r="${i}" data-f="a" data-n="${n}" value="${esc(a.attempts[ci] || '')}" placeholder="—">${needsWind ? `<input class="fcu-in w ${unc.has('w' + n) ? 'unc' : ''}" data-r="${i}" data-f="w" data-n="${n}" value="${esc(a.winds[ci] || '')}" placeholder="풍속">` : ''}</td>`;
                }).join('');
                const dbCell = !r ? '<span class="fcu-mut">분석 중…</span>' : r.db
                    ? `<span class="fcu-ok">${esc(r.db.name)}</span> <span class="fcu-mut">(${esc(r.db.bib)}${r.db.lane ? ' · ' + r.db.lane + '번' : ''})</span>${r.match_method && r.match_method !== 'bib' ? `<div class="fcu-warn">${r.match_method === 'order' ? '순서' : '성명'}로 매칭</div>` : ''}`
                    : '<span class="fcu-err">매칭 실패</span><div class="fcu-mut">배번·성명 수정 시 재매칭</div>';
                const best = r && r.computed.best != null ? (isHeight ? Number(r.computed.best).toFixed(2) : Number(r.computed.best).toFixed(2)) : '–';
                const bestMis = r && r.card.best != null && r.computed.best != null && Math.abs(r.card.best - r.computed.best) > 0.005;
                const rank = r && r.computed.rank != null ? r.computed.rank : '–';
                const rankMis = r && r.card.rank != null && r.computed.rank != null && r.card.rank !== r.computed.rank;
                const badge = !r ? '' : !r.db ? '<span class="fcu-badge skip">매칭실패</span>' : !r.has_data ? '<span class="fcu-badge same">빈 행</span>' : err ? '<span class="fcu-badge skip">건너뜀</span>' : !r.existing ? '<span class="fcu-badge new">신규</span>' : r.changed ? '<span class="fcu-badge chg">변경</span>' : '<span class="fcu-badge same">동일</span>';
                html += `<tr>
                    <td class="fcu-mut">${i + 1}</td>
                    <td><input class="fcu-in s ${unc.has('order') ? 'unc' : ''}" data-r="${i}" data-f="order" value="${esc(a.order)}"></td>
                    <td><input class="fcu-in s ${unc.has('bib') ? 'unc' : ''} ${r && !r.db ? 'badv' : ''}" data-r="${i}" data-f="bib" value="${esc(a.bib)}"></td>
                    <td><input class="fcu-in n ${unc.has('name') ? 'unc' : ''}" data-r="${i}" data-f="name" value="${esc(a.name)}"></td>
                    <td class="fcu-db">${dbCell}</td>${cells}
                    <td class="fcu-calc">${best}${r && r.computed.bestWind != null ? `<small>${esc(fmtWind(r.computed.bestWind))}</small>` : ''}<input class="fcu-in s ${unc.has('best') ? 'unc' : ''}" style="margin-top:2px;color:${bestMis ? '#dc2626' : '#6b7280'};" data-r="${i}" data-f="best" value="${esc(a.best)}" title="카드에 적힌 최고기록 (검산용)"></td>
                    <td class="fcu-calc">${rank}<input class="fcu-in s ${unc.has('rank') ? 'unc' : ''}" style="margin-top:2px;color:${rankMis ? '#dc2626' : '#6b7280'};" data-r="${i}" data-f="rank" value="${esc(a.rank)}" title="카드에 적힌 순위 (검산용)"></td>
                    <td><select class="fcu-in s" data-r="${i}" data-f="status">${['', 'DNS', 'DNF', 'DQ', 'NM'].map(v => `<option value="${v}" ${a.status === v ? 'selected' : ''}>${v || '—'}</option>`).join('')}</select></td>
                    <td>${badge}</td>
                    <td><button class="fcu-btn sm" data-act="del" data-r="${i}" title="행 삭제">✕</button></td></tr>`;
                if (r && r.issues.length) html += `<tr class="fcu-issues"><td colspan="${cols.length + 10}">${r.issues.map(x => `<div class="fcu-issue ${x.level}">${x.level === 'error' ? '✕' : x.level === 'warn' ? '⚠' : 'ⓘ'} ${esc(x.msg)}</div>`).join('')}</td></tr>`;
            });
            html += '</tbody></table></div>';
            const un = g && g.unmatched_entries ? g.unmatched_entries : [];
            html += `<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
                <button class="fcu-btn sm" data-act="add">+ 행 추가</button>
                ${un.length ? `<span class="fcu-mut" style="font-size:11px;">카드에 없는 선수 (누르면 행 추가):</span>${un.map(u => `<span class="fcu-chip" data-act="addent" data-bib="${esc(u.bib)}" data-name="${esc(u.name)}" data-lane="${esc(u.lane || '')}">${esc(u.name)} (${esc(u.bib)})</span>`).join('')}` : ''}
            </div>${S.status ? `<div class="fcu-status">${esc(S.status)}</div>` : ''}`;
            body.innerHTML = html;

            const willN = arows.filter(r => r.will_import).length;
            const warnN = (g ? g.issues.filter(i => i.level === 'warn').length : 0) + arows.reduce((s, r) => s + r.issues.filter(i => i.level === 'warn').length, 0);
            const errN = arows.reduce((s, r) => s + r.issues.filter(i => i.level === 'error').length, 0);
            foot.innerHTML = `<span class="fcu-note" style="margin:0;">저장 예정 <strong>${willN}</strong>명 · 경고 <strong class="fcu-warn">${warnN}</strong> · 오류 <strong class="fcu-err">${errN}</strong>${S.busy ? ' · 분석 중…' : ''}</span><span class="fcu-spacer"></span>
                <button class="fcu-btn" data-act="back">사진 다시 선택</button>
                <button class="fcu-btn" data-act="close">닫기</button>
                <button class="fcu-btn pri" data-act="save" ${(S.busy || !willN) ? 'disabled' : ''}>저장 (${willN}명)</button>`;
        }
        function captureFocus() {
            const el = document.activeElement;
            if (!el || !ov.contains(el) || !el.dataset || !el.dataset.f) return null;
            return { r: el.dataset.r, f: el.dataset.f, n: el.dataset.n, h: el.dataset.h, pos: el.selectionStart };
        }
        function restoreFocus(fs) {
            if (!fs) return;
            const sel = `[data-f="${fs.f}"]${fs.r != null ? `[data-r="${fs.r}"]` : ''}${fs.n ? `[data-n="${fs.n}"]` : ''}${fs.h ? `[data-h="${fs.h}"]` : ''}`;
            const el = body.querySelector(sel);
            if (el) { el.focus(); try { if (fs.pos != null && el.setSelectionRange) el.setSelectionRange(fs.pos, fs.pos); } catch (e) {} }
        }
        function render() {
            const fs = captureFocus();
            if (S.step === 1) renderStep1(); else renderStep2();
            restoreFocus(fs);
        }
        function blankAthlete(pre) {
            const h = (S.card.bar_heights || []).length;
            return Object.assign({ order: '', bib: '', name: '', team: '', attempts: isHeight ? [] : ['', '', '', '', '', ''], winds: isHeight ? [] : ['', '', '', '', '', ''], marks: isHeight ? Array(h).fill('') : [], best: '', rank: '', status: '', remark: '', uncertain: [] }, pre || {});
        }
        function scheduleAnalyze() {
            S.dirty = true;
            if (S.timer) clearTimeout(S.timer);
            S.timer = setTimeout(analyze, 350);
        }
        async function analyze() {
            S.timer = null;
            if (S.busy) { S.timer = setTimeout(analyze, 300); return; }
            S.busy = true; render();
            try {
                const data = await postJson('/api/field-card/analyze-json', { admin_key: opts.key, competition_id: opts.competitionId, heat_id: opts.heatId, card: S.card });
                if (!data.success) throw new Error(data.error || '분석 실패');
                S.analysis = data; S.status = '';
            } catch (e) { S.status = '분석 오류: ' + e.message; }
            finally { S.busy = false; render(); }
        }
        async function save() {
            const willN = rowsOf().filter(r => r.will_import).length;
            if (!willN || S.busy) return;
            if (!confirm(`${willN}명의 기록을 저장합니다. 카드에 있는 선수는 시기 전체가 이 표의 값으로 교체됩니다. 계속할까요?`)) return;
            S.busy = true; S.status = '저장 중…'; render();
            try {
                const data = await postJson('/api/field-card/import-json', { admin_key: opts.key, competition_id: opts.competitionId, heat_id: opts.heatId, card: S.card });
                if (!data.success) throw new Error(data.error || '저장 실패');
                const r = (data.results || [])[0] || {};
                S.saved = true; S.status = `저장 완료: ${r.imported || 0}명 입력${r.skipped ? `, ${r.skipped}명 건너뜀` : ''}`;
                render();
                if (typeof opts.onSaved === 'function') { try { await opts.onSaved(data); } catch (e) {} }
                setTimeout(() => close(true), 700);
            } catch (e) { S.status = '저장 오류: ' + e.message; S.busy = false; render(); }
        }

        // ── 이벤트 위임 ───────────────────────────────────────
        ov.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-act]'); if (!btn) return;
            const act = btn.dataset.act;
            if (act === 'close') return close(false);
            if (act === 'pick') return ov.querySelector('input[data-in="img"]').click();
            if (act === 'rm') { const f = S.files[+btn.dataset.i]; if (f && S.urls.has(f)) { URL.revokeObjectURL(S.urls.get(f)); S.urls.delete(f); } S.files.splice(+btn.dataset.i, 1); return render(); }
            if (act === 'start') return start();
            if (act === 'back') { S.step = 1; S.status = ''; return render(); }
            if (act === 'save') return save();
            if (act === 'add') { S.card.athletes.push(blankAthlete()); render(); return scheduleAnalyze(); }
            if (act === 'addent') { S.card.athletes.push(blankAthlete({ bib: btn.dataset.bib, name: btn.dataset.name, order: btn.dataset.lane || '' })); render(); return scheduleAnalyze(); }
            if (act === 'del') { if (!confirm('이 행을 지울까요?')) return; S.card.athletes.splice(+btn.dataset.r, 1); render(); return scheduleAnalyze(); }
        });
        ov.addEventListener('change', (e) => {
            const el = e.target;
            if (el.dataset && el.dataset.in) { addFiles(el.files); el.value = ''; return; }
            if (!el.dataset || !el.dataset.f || S.step !== 2) return;
            const f = el.dataset.f, v = String(el.value || '').trim();
            if (f === 'heights') {
                const hs = v.split(/[,\s]+/).map(x => x.trim()).filter(Boolean);
                S.card.bar_heights = hs;
                S.card.athletes.forEach(a => { const m = a.marks || []; a.marks = hs.map((h, i) => m[i] || ''); });
                render(); return scheduleAnalyze();
            }
            const a = S.card.athletes[+el.dataset.r]; if (!a) return;
            if (f === 'a') a.attempts[+el.dataset.n - 1] = v;
            else if (f === 'w') a.winds[+el.dataset.n - 1] = v;
            else if (f === 'm') a.marks[+el.dataset.h] = v;
            else a[f] = v;
            // 사용자가 고친 셀은 더 이상 '불확실' 표시하지 않음
            const label = f === 'a' ? `${el.dataset.n}차` : f === 'w' ? `${el.dataset.n}차풍속` : f === 'bib' ? '배번' : f === 'name' ? '성명' : f === 'order' ? '순서' : f === 'best' ? '최고기록' : f === 'rank' ? '순위' : f === 'm' ? String((S.card.bar_heights || [])[+el.dataset.h] || '') : '';
            if (label) a.uncertain = (a.uncertain || []).filter(u => u.replace(/\s/g, '') !== label.replace(/\s/g, '') && !(f === 'w' && u === `${el.dataset.n}차 풍속`));
            scheduleAnalyze();
        });
        ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(false); });
        const dz = () => ov.querySelector('.fcu-drop');
        ['dragenter', 'dragover'].forEach(ev => ov.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); const d = dz(); if (d) d.classList.add('over'); }));
        ['dragleave', 'drop'].forEach(ev => ov.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); const d = dz(); if (d) d.classList.remove('over'); }));
        ov.addEventListener('drop', e => { if (S.step === 1) addFiles(e.dataTransfer && e.dataTransfer.files); });

        render();
        return { close: () => close(true) };
    }

    window.FieldCardUpload = { open, shrinkImage, readJson };
})();
