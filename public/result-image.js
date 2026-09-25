/**
 * result-image.js — 결과 창 '이미지 저장' (2026-09-26)
 * ------------------------------------------------------------
 * 결과 표를 인스타에 올릴 수 있는 한 장짜리 이미지로 만든다.
 *   - 규격: 피드 4:5 (1080×1350). 줄이 많으면(17명↑) 스토리 9:16 (1080×1920)
 *   - 줄 수에 맞춰 행 높이·글자 크기를 자동으로 줄여 8명이든 15명이든 한 장에 전부 들어간다
 *   - 예선처럼 조가 여럿이면 조마다 한 장 (인스타 캐러셀)
 *   - 앱 화면 스타일 그대로(순위·국기·이름·기록·NR/PB·Q, 결승 1~3위 메달, 한국 선수 줄은 붉게)
 *   - 위: 대회명 · 종목 라운드 성별 · 날짜/시간 · 풍속 / 아래: 기존 기록 한 줄 · 공식 결과 기준 · PACE RISE : Node
 *   - 만들기는 html2canvas(기록 카드와 같은 로더), 저장은 폰이면 공유창(사진 저장·인스타), PC 는 PNG 다운로드
 *   - 진행 중(LIVE)이면 'LIVE · 21:43 기준'
 * 노출: window.openResultImage(eventId), window.__buildResultImages(eventId) (예시 렌더·테스트용)
 */
(function () {
    const W = 1080;
    const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const TAGS = ['WR', 'AR', 'GR', 'NR', 'PB', 'SB'];
    const tagOf = remark => { const t = String(remark || '').split(/\s+/); for (const k of TAGS) if (t.includes(k)) return k; return null; };
    const qualOf = remark => (String(remark || '').match(/\b(Q|q)\b/) || [null])[0];
    const pad = n => String(n).padStart(2, '0');
    const fmtMark = (v, isTime, category) => v == null ? '' : isTime ? formatTime(v, { noDecimal: category === 'road' }) : (category === 'field_height' ? formatHeight(v) : Number(v).toFixed(2));
    const TAG_COLOR = { WR: '#6a1b9a', AR: '#0d47a1', GR: '#b8860b', NR: '#c0392b' };
    // 긴 팀명 줄이기 (이미지 한 줄에 들어가게)
    const shortTeam = n => String(n || '').replace(/^People's Republic of /i, '').replace(/^Islamic Republic of /i, '').replace(/^Democratic People's Republic of Korea$/i, 'DPR Korea').replace(/^Republic of Korea$/i, '대한민국').replace(/^Chinese Taipei$/i, 'Chinese Taipei');
    // 글자가 칸 폭을 넘으면 실제 폭을 재서 글자 크기를 줄인다 (캔버스 measureText)
    const _mc = document.createElement('canvas').getContext('2d');
    const textW = (text, px, weight, family) => { _mc.font = `${weight || 700} ${px}px ${family || "'Noto Sans KR','Apple SD Gothic Neo',sans-serif"}`; return _mc.measureText(String(text || '')).width; };
    const fitFs = (fs, text, maxW, weight) => { let px = fs; while (px > 16 && textW(text, px, weight) > maxW) px -= 1; return px; };

    // ── 조 하나의 줄 계산 (앱 결과 창과 같은 규칙: 유효 기록 순 → 상태코드는 뒤로 → 기록 없는 선수는 맨 끝) ──
    function computeRows(evt, heat) {
        const cat = evt.category;
        const isTime = ['track', 'relay', 'road'].includes(cat);
        const higher = ['field_distance', 'field_height'].includes(cat);
        const byEntry = new Map();
        for (const r of (heat.results || [])) { if (!byEntry.has(r.event_entry_id)) byEntry.set(r.event_entry_id, []); byEntry.get(r.event_entry_id).push(r); }
        const rows = (heat.entries || []).map(e => {
            const rs = byEntry.get(e.event_entry_id) || [];
            const main = rs.find(r => r.attempt_number == null) || null;
            let mark = null, wind = null, status = (main && main.status_code) || '', failsAtBest = 0, totalFails = 0;
            if (isTime) { mark = main && main.time_seconds != null ? main.time_seconds : null; }
            else if (cat === 'field_height') {
                mark = main && main.distance_meters > 0 ? main.distance_meters : null;
                const mine = (heat.height_attempts || []).filter(a => a.event_entry_id === e.event_entry_id);
                if (mine.length && window.PaceRanking && PaceRanking.heightStatsFromAttempts) {
                    const hs = PaceRanking.heightStatsFromAttempts(mine);
                    if (hs) { if (mark == null && hs.best) mark = hs.best; failsAtBest = hs.failsAtBest || 0; totalFails = hs.totalFails || 0; }
                }
            } else {
                const att = rs.filter(r => r.attempt_number != null && r.distance_meters > 0);
                if (att.length) { const b = att.reduce((m, r) => r.distance_meters > m.distance_meters ? r : m, att[0]); mark = b.distance_meters; wind = b.wind; }
                else if (main && main.distance_meters > 0) { mark = main.distance_meters; wind = main.wind; }
                if (!status) { const sc = rs.find(r => r.status_code); if (sc) status = sc.status_code; }
            }
            return { e, mark, wind, status: status ? String(status).toUpperCase() : '', remark: (main && main.remark) || '', has: mark != null || !!status, failsAtBest, totalFails };
        });
        const stOrder = { NM: 0, DNF: 1, DQ: 2, DNS: 3 };
        rows.sort((a, b) => {
            if (a.mark != null && b.mark != null) { const d = higher ? b.mark - a.mark : a.mark - b.mark; if (d) return d; return (a.failsAtBest - b.failsAtBest) || (a.totalFails - b.totalFails); }   // 높이: 같은 높이면 카운트백
            if (a.mark != null) return -1; if (b.mark != null) return 1;
            if (a.status && b.status) return (stOrder[a.status] ?? 9) - (stOrder[b.status] ?? 9);
            if (a.status) return -1; if (b.status) return 1;
            return (a.e.lane_number || 99) - (b.e.lane_number || 99);
        });
        const same = (a, b) => a.mark === b.mark && a.failsAtBest === b.failsAtBest && a.totalFails === b.totalFails;
        let rk = 0; rows.forEach((r, i) => { if (r.mark == null) { r.place = null; return; } if (i === 0 || !same(r, rows[i - 1])) rk = i + 1; r.place = rk; });
        return { rows, isTime, higher };
    }

    // ── 한 장 HTML ──
    function pageHtml(ctx, heat, calc) {
        const { evt, comp, records, spot, relayMembers, now } = ctx;
        const N = calc.rows.length;
        const H = N > 16 ? 1920 : 1350;
        const headH = 250, footH = 150, padY = 56;
        const avail = H - headH - footH - padY * 2;
        const rowH = Math.max(40, Math.min(130, Math.floor(avail / Math.max(N, 1))));   // 줄이 적으면 크게(5줄이면 130px), 많으면 40px 까지
        const fs = Math.round(Math.max(22, Math.min(42, rowH * 0.4)));        // 이름
        const fsMark = Math.round(fs * 1.12);
        const showMembers = evt.category === 'relay' && rowH >= 70 && relayMembers;
        const isSub = !!evt.parent_event_id;                                   // 7종·10종 세부종목: 메달 없음
        const gL = evt.gender === 'M' ? '남자' : evt.gender === 'F' ? '여자' : '혼성';
        const roundL = { preliminary: '예선', semifinal: '준결승', final: '결승' }[evt.round_type] || '';
        const isFinal = evt.round_type === 'final' && !isSub;
        const heatL = ctx.multi ? ` ${heat.heat_name || (heat.heat_number + '조')}` : '';
        const sched = heat.scheduled_at ? new Date(heat.scheduled_at) : null;
        const dateL = sched && isFinite(sched) ? `${sched.getMonth() + 1}/${sched.getDate()}(${'일월화수목금토'[sched.getDay()]}) ${pad(sched.getHours())}:${pad(sched.getMinutes())}` : '';
        const windL = calc.isTime && heat.wind != null && heat.wind !== '' && isFinite(parseFloat(heat.wind)) ? `풍속 ${formatWind(parseFloat(heat.wind))}` : '';
        const live = evt.round_status === 'in_progress';
        const statusL = live ? `<span style="color:#c0392b;font-weight:800">LIVE</span> · ${pad(now.getHours())}:${pad(now.getMinutes())} 기준` : '대회 공식 결과 기준';
        const recs = records ? [['WR', records.world], ['AR', records.area], ['GR', records.games], ['NR', records.national]].filter(([, r]) => r && r.record_value).map(([k, r]) => `<span style="color:${TAG_COLOR[k]};font-weight:800">${k}</span> ${esc(r.record_value)}`).join(' &nbsp;·&nbsp; ') : '';
        const rowsHtml = calc.rows.map(r => {
            const e = r.e; const isSpot = !!(spot && e.team === spot);
            const dispName = isSpot && evt.category === 'relay' ? '대한민국' : (evt.category === 'relay' ? shortTeam(e.name) : e.name);
            const tag = tagOf(r.remark), q = qualOf(r.remark);
            const placeHtml = r.place == null ? `<span style="color:#b3261e;font-size:${Math.round(fs * 0.7)}px;font-weight:800">${esc(r.status)}</span>`
                : (isFinal && r.place <= 3 ? medalHtml(r.place, Math.round(rowH * 0.62)) : `<span style="font-weight:800;color:${r.place === 1 ? '#b79f58' : '#333'}">${r.place}</span>`);
            const flag = isSpot && spot === 'KOR' ? PaceIcons.svg('flagKR', { size: Math.round(fs * 0.95), style: 'vertical-align:-3px' }) : `<span style="font-weight:800;color:#666;font-size:${Math.round(fs * 0.8)}px;letter-spacing:.04em">${esc(e.team || '')}</span>`;
            const members = showMembers ? (() => { const all = relayMembers.filter(m => m.event_entry_id === e.event_entry_id).sort((a, b) => (a.leg_order || 99) - (b.leg_order || 99)); const legs = all.filter(m => m.leg_order >= 1 && m.leg_order <= 4); return (legs.length ? legs : all.slice(0, 4)).map(m => esc(m.name)).join(' · '); })() : '';
            const markText = r.mark == null ? '' : fmtMark(r.mark, calc.isTime, evt.category);
            const nameColW = W - 112 - 76 - 92 - (130 + 12) - Math.max(150, Math.ceil(textW(markText, fsMark, 700, "'D2Coding',monospace")) + 20) - 12;
            const markHtml = r.mark == null ? '' : `${markText}${!calc.isTime && r.wind != null && evt.category === 'field_distance' ? `<span style="font-size:${Math.round(fs * 0.55)}px;color:#999;margin-left:6px;font-family:'Noto Sans KR'">${formatWind(r.wind)}</span>` : ''}`;
            const tagHtml = (tag ? `<span style="display:inline-block;padding:2px 9px;border-radius:8px;font-size:${Math.round(fs * 0.6)}px;font-weight:800;line-height:1.3;${TAG_COLOR[tag] ? `background:${TAG_COLOR[tag]};color:#fff` : 'background:#e6f4ec;color:#1b7f4d;border:1px solid #bfe3cc'}">${tag}</span>` : '')
                + (q ? `<span style="display:inline-block;margin-left:6px;padding:2px 9px;border-radius:8px;font-size:${Math.round(fs * 0.6)}px;font-weight:800;line-height:1.3;background:#e6f4ec;color:#1b7f4d;border:1px solid #bfe3cc">${q}</span>` : '');
            return `<div style="display:flex;align-items:center;height:${rowH}px;border-bottom:1px solid #ece8de;${isSpot ? 'background:#fff3f3;margin:0 -16px;padding:0 16px;border-radius:10px;' : ''}">
                <div style="flex:none;width:76px;text-align:center;font-family:'D2Coding',monospace;font-size:${fsMark}px;display:flex;align-items:center;justify-content:center">${placeHtml}</div>
                <div style="flex:none;width:92px;display:flex;align-items:center">${flag}</div>
                <div style="flex:1;min-width:0;font-weight:${isSpot ? 900 : 700};color:${isSpot ? '#8b1a2a' : '#1f1d1a'};line-height:1.2"><div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:${fitFs(fs, dispName, nameColW, isSpot ? 900 : 700)}px">${esc(dispName)}</div>${members ? (() => { const plain = members.replace(/&[a-z#0-9]+;/g, 'x'); let mfs = Math.round(fs * 0.55), lines = 2; while (mfs > 16 && textW(plain, mfs, 500) > nameColW * 1.9) mfs -= 1; if (textW(plain, mfs, 500) > nameColW * 1.9) lines = 3;   /* 16px 아래로는 안 줄이고 세 줄 */ const html = members.split(' · ').map(m => `<span style="white-space:nowrap">${m}</span>`).join(' · '); return `<div style="font-size:${mfs}px;color:#777;font-weight:500;margin-top:3px;white-space:normal;line-height:1.25;max-height:${Math.round(mfs * 1.25 * lines + 2)}px;overflow:hidden">${html}</div>`; })() : ''}</div>
                <div style="flex:none;min-width:150px;text-align:right;display:flex;align-items:center;justify-content:flex-end;gap:12px"><span style="flex:none;min-width:130px;text-align:left">${tagHtml}</span><span style="font-family:'D2Coding',monospace;font-size:${fsMark}px;font-weight:700;color:${isSpot ? '#8b1a2a' : '#1f1d1a'};letter-spacing:-.01em">${markHtml}</span></div>
            </div>`;
        }).join('');
        return `<div class="ri-page" style="width:${W}px;height:${H}px;box-sizing:border-box;padding:${padY}px 56px;background:#fbfaf6;color:#1f1d1a;font-family:'Noto Sans KR','Apple SD Gothic Neo',sans-serif;display:flex;flex-direction:column;position:relative;overflow:hidden">
            <div style="height:${headH}px;flex:none">
                <div style="display:flex;align-items:center;justify-content:space-between"><div style="font-size:24px;font-weight:700;color:#8a7640;letter-spacing:.04em">${esc(comp.name || '')}</div><div style="font-family:'Audiowide',sans-serif;font-size:24px;letter-spacing:2px;color:#1a2a5e">PACE RISE <span style="color:#b79f58">: Node</span></div></div>
                <div style="font-size:64px;font-weight:900;letter-spacing:-.03em;line-height:1.15;margin-top:22px;word-break:keep-all">${gL} ${ctx.parentName ? esc(ctx.parentName) + ' · ' + esc(evt.name) : esc(evt.name) + ' ' + roundL}${heatL}</div>
                <div style="font-size:26px;color:#6f6a62;margin-top:14px;font-weight:500">${[dateL, windL, `${N}${evt.category === 'relay' ? '팀' : '명'}`].filter(Boolean).join(' &nbsp;·&nbsp; ')}</div>
                <div style="height:4px;background:#b79f58;width:120px;margin-top:22px"></div>
            </div>
            <div style="flex:1;min-height:0;display:flex;flex-direction:column;justify-content:center">${rowsHtml}</div>
            <div style="height:${footH}px;flex:none;display:flex;flex-direction:column;justify-content:flex-end;gap:10px;font-size:22px;color:#6f6a62">
                ${recs ? `<div style="font-family:'D2Coding',monospace;font-size:22px;color:#555">기존 기록 &nbsp; ${recs}</div>` : ''}
                <div style="display:flex;justify-content:space-between;align-items:center"><span>${statusL}</span><span style="font-size:20px;color:#9a958c">pace-rise-node.com</span></div>
            </div>
        </div>`;
    }

    // ── 데이터 모으기 → 페이지 HTML 배열 ──
    async function buildResultImages(eventId) {
        const data = await API.getFullResults(eventId);
        const evt = data.event;
        if (evt.category === 'combined') throw new Error('7종·10종 종합표 이미지는 아직 지원하지 않아요.');
        const comp = await API.getCompetitionInfo(getCompetitionId()).catch(() => ({}));
        let records = null;
        try {
            const normName = (typeof normalizeEventNameClient === 'function') ? normalizeEventNameClient(evt.name) : evt.name;
            records = await API.lookupEventRecords(normName, evt.gender, evt.division || null, comp.series_id || null, evt.id);
            if (typeof _intlRecords === 'function') records = _intlRecords(records);
        } catch (e) { records = null; }
        const spot = (typeof allEvents !== 'undefined' && (allEvents.find(e => e.spotlight) || {}).spotlight) || null;
        let relayMembers = null;
        if (evt.category === 'relay') { try { relayMembers = normalizeRelayMembers(await API.getRelayMembersBatch(evt.id)); } catch (e) {} }
        let heats = (data.heats || []).filter(h => (h.entries || []).length);
        heats = heats.filter(h => (h.results || []).some(r => r.time_seconds != null || r.distance_meters != null || r.status_code) || (h.height_attempts || []).length);   // 높이는 full-results 가 시기표(height_attempts)만 준다
        if (!heats.length) throw new Error('아직 기록이 없어요.');
        const parent = evt.parent_event_id && typeof allEvents !== 'undefined' ? allEvents.find(e => e.id === evt.parent_event_id) : null;   // 7종·10종 세부종목: '여자 7종경기 · 100mH'
        const ctx = { evt, comp, records, spot, relayMembers, now: new Date(), multi: heats.length > 1 || evt.round_type !== 'final', parentName: parent ? parent.name : null };
        return heats.map(h => { const calc = computeRows(evt, h); return { title: `${parent ? parent.name + ' ' : ''}${evt.name} ${ctx.multi && h.heat_number ? h.heat_number + '조' : ''}`.trim(), html: pageHtml(ctx, h, calc), rows: calc.rows.length }; });
    }

    // ── 화면: 미리보기 + 저장/공유 ──
    function _loadH2C() { return (typeof _scLoadHtml2Canvas === 'function') ? _scLoadHtml2Canvas() : Promise.reject(new Error('html2canvas 로더 없음')); }
    async function _toBlob(el) {
        await _loadH2C();
        const stage = el.closest('#ri-stage');
        const canvas = await html2canvas(el, { scale: 1, backgroundColor: '#fbfaf6', useCORS: true, logging: false, width: W, height: el.offsetHeight, windowWidth: W,
            ignoreElements: node => node !== stage && node.parentElement === document.body && !stage.contains(node) });   // 고정 헤더·툴바·모달이 이미지에 찍히지 않게
        return new Promise(res => canvas.toBlob(res, 'image/png'));
    }
    // 저장 경로 (환경마다 다르다)
    //   1) 공유창(navigator.share + 파일): 사파리·홈 화면 웹앱 → '이미지 저장'으로 사진 앱에
    //   2) 앱스토어 앱(WKWebView): 네이티브 브리지 paceSave 가 있으면 사진 앱에 바로 저장, 없으면 '길게 눌러 사진에 추가' 안내 (a[download] 는 WKWebView 에서 아무 일도 안 일어난다)
    //   3) PC: PNG 다운로드
    const _isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent || '');
    const _blobToBase64 = blob => new Promise(res => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.readAsDataURL(blob); });
    async function _save(blob, name) {
        const file = new File([blob], name, { type: 'image/png' });
        if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: name }); return 'shared'; } catch (e) { if (e && e.name === 'AbortError') return 'cancel'; } }
        if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.paceSave) {
            try { window.webkit.messageHandlers.paceSave.postMessage({ name, base64: await _blobToBase64(blob) }); return 'native'; } catch (e) {}
        }
        if (_isIOS()) return 'longpress';
        const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 3000);
        return 'downloaded';
    }
    const _canShareFiles = () => { try { return !!(navigator.share && navigator.canShare && navigator.canShare({ files: [new File([new Blob(['x'])], 'x.png', { type: 'image/png' })] })); } catch (e) { return false; } };
    function _closeModal() { const m = document.getElementById('ri-modal'); if (m) m.remove(); const st = document.getElementById('ri-stage'); if (st) st.remove(); if (window.unlockBodyScroll) unlockBodyScroll(); }
    async function openResultImage(eventId) {
        if (document.getElementById('ri-modal')) return;
        let pages;
        try { pages = await buildResultImages(eventId); } catch (e) { (window.uiAlert || alert)(e.message || String(e)); return; }
        // 실제 크기(1080px)로 그리는 무대 — 화면 밖에
        const stage = document.createElement('div'); stage.id = 'ri-stage'; stage.style.cssText = `position:absolute;left:-20000px;top:0;width:${W}px;`;
        stage.innerHTML = pages.map(p => p.html).join(''); document.body.appendChild(stage);
        const els = [...stage.querySelectorAll('.ri-page')];
        const modal = document.createElement('div'); modal.id = 'ri-modal';
        modal.style.cssText = 'position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,.6);display:flex;flex-direction:column;align-items:center;justify-content:flex-start;padding:16px;overflow:auto;';
        modal.innerHTML = `<div style="width:min(420px,100%);background:#fff;border-radius:14px;padding:12px 14px;box-shadow:0 20px 60px rgba(0,0,0,.35)">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px"><b style="font-size:14px">이미지 저장</b><button id="ri-close" style="border:none;background:#eee;border-radius:50%;width:32px;height:32px;font-size:18px;cursor:pointer">×</button></div>
            <div style="font-size:11px;color:#888;margin-bottom:8px">${pages.length > 1 ? `조마다 한 장 · ${pages.length}장` : '한 장'} · 만드는 중…</div>
            <div id="ri-list" style="display:flex;flex-direction:column;gap:12px"></div></div>`;
        document.body.appendChild(modal); if (window.lockBodyScroll) lockBodyScroll();
        modal.addEventListener('click', e => { if (e.target === modal) _closeModal(); });
        modal.querySelector('#ri-close').onclick = _closeModal;
        const list = modal.querySelector('#ri-list');
        try {
            await new Promise(r => setTimeout(r, 50));
            if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (e) {} }
            for (let i = 0; i < els.length; i++) {
                const blob = await _toBlob(els[i]);
                const url = URL.createObjectURL(blob);
                const name = `${(pages[i].title || 'result').replace(/[^\w가-힣().-]+/g, '_')}_${Date.now()}.png`;
                const item = document.createElement('div');
                // 옛 앱스토어 빌드(브리지 없음): 길게 눌러 '사진 저장'을 고르면 iOS 가 앱을 강제 종료한다(Info.plist 사진 권한 설명 누락) → 길게 누르기 메뉴를 막고 업데이트 안내
                const oldWrapper = _isIOS() && !_canShareFiles() && !(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.paceSave);
                item.innerHTML = `<img src="${url}" alt="${esc(pages[i].title)}" style="width:100%;border-radius:8px;border:1px solid #e5e5e5;display:block;-webkit-touch-callout:${oldWrapper ? 'none' : 'default'};-webkit-user-select:none"><div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px;gap:8px"><span style="font-size:12px;color:#666">${esc(pages[i].title)} · ${pages[i].rows}명</span>${oldWrapper ? '<span style="font-size:12px;color:#8b1a2a;font-weight:700;text-align:right">사진 저장은 앱 업데이트 후 지원돼요</span>' : '<button class="btn btn-sm btn-primary" style="font-size:12px">저장 / 공유</button>'}</div>`;
                if (oldWrapper) item.querySelector('img').addEventListener('contextmenu', e => e.preventDefault());
                const btn = item.querySelector('button');
                if (btn) btn.onclick = async () => { const r = await _save(blob, name); if (window.toast) { if (r === 'downloaded') toast('저장했습니다', 'success'); else if (r === 'native') toast('사진 앱에 저장했습니다', 'success'); else if (r === 'longpress') toast("이미지를 길게 눌러 '사진에 추가'를 선택하세요", 'info'); } };
                list.appendChild(item);
            }
            const note = modal.querySelector('div[style*="color:#888"]'); if (note) note.textContent = `${pages.length > 1 ? `조마다 한 장 · ${pages.length}장` : '한 장'} · 길게 눌러 저장할 수도 있어요`;
        } catch (e) { list.innerHTML = `<div style="color:#b3261e;font-size:12px">이미지 만들기 실패: ${esc(e.message || e)}</div>`; }
    }
    window.openResultImage = openResultImage;
    window.__buildResultImages = buildResultImages;
})();
