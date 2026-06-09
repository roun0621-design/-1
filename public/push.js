/**
 * push.js — 웹푸시(FCM) 클라이언트
 * - 서버 설정(/api/push/web-config)이 있을 때만 동작. 없으면 조용히 종료.
 * - 알림 권한은 사용자 동작(버튼)에서 요청하는 게 좋음 → window.PaceRisePush.enable() 노출.
 * - 한 번 허용했으면 다음 방문부터 자동 재등록.
 */
(function () {
    var FB_VER = '10.12.2';
    var _cfg = null;
    var _token = null;

    function loadScript(src) {
        return new Promise(function (resolve, reject) {
            if (document.querySelector('script[src="' + src + '"]')) { resolve(); return; }
            var s = document.createElement('script');
            s.src = src; s.onload = resolve; s.onerror = reject;
            document.head.appendChild(s);
        });
    }

    async function getConfig() {
        if (_cfg) return _cfg;
        try {
            var res = await fetch('/api/push/web-config');
            _cfg = await res.json();
        } catch (e) { _cfg = { configured: false }; }
        return _cfg;
    }

    function currentAudience() {
        try {
            var role = localStorage.getItem('pace_role') || 'viewer';
            return (role && role !== 'viewer') ? 'staff' : 'public';
        } catch (e) { return 'public'; }
    }
    function currentCompId() {
        try { return (window.getCompetitionId && window.getCompetitionId()) || null; } catch (e) { return null; }
    }

    async function _registerToken(requestPermission) {
        var cfg = await getConfig();
        if (!cfg || !cfg.configured) return { ok: false, reason: 'not-configured' };
        if (!window.isSecureContext) return { ok: false, reason: 'insecure' };  // http면 푸시 불가
        if (!('serviceWorker' in navigator) || !('Notification' in window)) return { ok: false, reason: 'unsupported' };

        var perm = Notification.permission;
        if (perm === 'default' && requestPermission) perm = await Notification.requestPermission();
        if (perm !== 'granted') return { ok: false, reason: 'denied' };

        await loadScript('https://www.gstatic.com/firebasejs/' + FB_VER + '/firebase-app-compat.js');
        await loadScript('https://www.gstatic.com/firebasejs/' + FB_VER + '/firebase-messaging-compat.js');
        if (!window.firebase) return { ok: false, reason: 'sdk-failed' };
        if (!firebase.apps || !firebase.apps.length) firebase.initializeApp(cfg.config);
        if (!firebase.messaging.isSupported || !firebase.messaging.isSupported()) return { ok: false, reason: 'unsupported' };
        var messaging = firebase.messaging();

        // firebase SW 를 전용 scope 에 명시적 등록(앱 sw.js scope '/' 와 충돌 방지).
        // 토큰도 확실히 받고, 푸시가 알림핸들러 있는 이 SW로 정확히 전달됨.
        var swReg = await navigator.serviceWorker.register('/firebase-messaging-sw.js', { scope: '/firebase-cloud-messaging-push-scope' });
        try { await swReg.update(); } catch (e) {}
        var token = await messaging.getToken({ vapidKey: cfg.vapidKey, serviceWorkerRegistration: swReg });
        if (!token) return { ok: false, reason: 'no-token' };

        var rr = await fetch('/api/push/register', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: token, audience: currentAudience(), competition_id: currentCompId() })
        });
        if (!rr.ok) return { ok: false, reason: 'register-failed-' + rr.status };
        _token = token;
        syncFavorites();  // 관심 종목(즐겨찾기) 서버 동기화
        // 표시는 서비스워커의 push 리스너가 전담(포그라운드/백그라운드 모두) → 중복 방지.
        // 여기서는 따로 표시하지 않음(로그만).
        try { messaging.onMessage(function () { /* SW가 표시 */ }); } catch (e) {}
        return { ok: true, token: token };
    }

    // 관심 종목(즐겨찾기)을 서버에 동기화 — 토큰이 있을 때만
    function syncFavorites() {
        if (!_token) return;
        var keys = [];
        try { if (window.getFavorites) keys = window.getFavorites() || []; } catch (e) {}
        var compId = currentCompId();
        fetch('/api/push/interests', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: _token, competition_id: compId, keys: keys })
        }).catch(function () {});
    }

    // 버튼에서 호출 — 권한 요청 포함. 결과를 alert로 명확히 보여줌(모바일 디버깅).
    async function enable() {
        try {
            var r = await _registerToken(true);
            if (r.ok) { alert('✅ 알림이 켜졌습니다! 이제 공지를 받을 수 있어요.'); }
            else if (r.reason === 'insecure') { alert('⚠️ 보안(https) 주소가 아니라서 알림을 켤 수 없어요.\n주소창이 https:// 로 시작하는지 확인해 주세요. (http/IP 접속은 불가)'); }
            else if (r.reason === 'unsupported') { alert('⚠️ 이 브라우저에서는 웹푸시를 지원하지 않아요.\n• 아이폰은 사파리에서 "홈 화면에 추가" 후 그 아이콘으로 열어야 해요.\n• 안드로이드는 크롬을 권장합니다.'); }
            else if (r.reason === 'denied') { alert('🔕 알림이 차단되어 있어요.\n브라우저 주소창 자물쇠 → 사이트 설정 → 알림 "허용"으로 바꿔주세요.'); }
            else if (r.reason === 'not-configured') { alert('서버 알림 설정이 아직 안 됐어요.'); }
            else { alert('알림을 켤 수 없습니다 (' + r.reason + ')'); }
            return r;
        } catch (e) {
            var detail = (e && (e.code ? e.code + ' / ' : '') + (e.message || e)) || String(e);
            alert('알림 설정 중 오류:\n' + detail);
            try { console.error('[push] enable error', e); } catch (_) {}
            return { ok: false };
        }
    }

    // 이미 허용한 사용자는 자동 재등록(권한 요청 없음)
    async function autoInit() {
        try {
            if (('Notification' in window) && Notification.permission === 'granted') {
                await _registerToken(false);
            }
        } catch (e) { /* 조용히 무시 */ }
    }

    function _toast(msg) {
        if (window.toast) { try { window.toast(msg, 'info'); return; } catch (e) {} }
        try { console.log('[push]', msg); } catch (e) {}
    }

    // ── 일주일 보지 않기(dismiss) 헬퍼 ──
    function _dismissed(key) {
        try { return Date.now() < (parseInt(localStorage.getItem(key) || '0', 10) || 0); } catch (e) { return false; }
    }
    function _dismissWeek(key) {
        try { localStorage.setItem(key, String(Date.now() + 7 * 24 * 60 * 60 * 1000)); } catch (e) {}
    }

    function _injectPromptStyle() {
        if (document.getElementById('pr-push-style')) return;
        var s = document.createElement('style'); s.id = 'pr-push-style';
        s.textContent =
            '.pr-push-ov{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:99999;display:flex;align-items:center;justify-content:center;padding:24px;animation:prPushFade .15s ease;}' +
            '@keyframes prPushFade{from{opacity:0}to{opacity:1}}' +
            '.pr-push-card{background:#fff;border-radius:18px;max-width:340px;width:100%;padding:24px 22px 16px;box-shadow:0 14px 44px rgba(0,0,0,.28);text-align:center;}' +
            '.pr-push-ico{font-size:38px;margin-bottom:8px;}' +
            '.pr-push-ttl{font-size:17px;font-weight:800;color:#1a1a1a;margin-bottom:6px;}' +
            '.pr-push-msg{font-size:13px;color:#666;line-height:1.55;margin-bottom:16px;word-break:keep-all;}' +
            '.pr-push-acts{display:flex;gap:8px;}' +
            '.pr-push-acts button{flex:1;padding:11px 0;border-radius:10px;font-size:14px;font-weight:700;cursor:pointer;border:none;}' +
            '.pr-push-primary{background:#b79f58;color:#fff;}' +
            '.pr-push-ghost{background:#f0f0f0;color:#555;}' +
            '.pr-push-dismiss{display:inline-flex;align-items:center;gap:6px;margin-top:13px;font-size:12px;color:#9aa0a6;cursor:pointer;user-select:none;}' +
            '.pr-push-dismiss input{width:14px;height:14px;}';
        document.head.appendChild(s);
    }

    // 알림 허용 유도 팝업 (일주일 보지 않기 포함)
    function showPushPrompt(opts) {
        opts = opts || {};
        if (!('Notification' in window) || Notification.permission === 'granted') return; // 이미 허용이면 안 띄움
        if (document.getElementById('pr-push-ov')) return; // 중복 방지
        _injectPromptStyle();
        var ov = document.createElement('div'); ov.className = 'pr-push-ov'; ov.id = 'pr-push-ov';
        ov.innerHTML =
            '<div class="pr-push-card">' +
            '<div class="pr-push-ico">🔔</div>' +
            '<div class="pr-push-ttl">' + (opts.title || '경기 알림 받기') + '</div>' +
            '<div class="pr-push-msg">' + (opts.message || '관심 종목의 소집·결과를 휴대폰 알림으로 받아보세요.') + '</div>' +
            '<div class="pr-push-acts">' +
            '<button class="pr-push-ghost" data-act="close">닫기</button>' +
            '<button class="pr-push-primary" data-act="enable">알림 받기</button>' +
            '</div>' +
            '<label class="pr-push-dismiss"><input type="checkbox" id="pr-push-week"> 일주일 동안 보지 않기</label>' +
            '</div>';
        function dismissIfChecked() {
            var wk = ov.querySelector('#pr-push-week');
            if (wk && wk.checked && opts.dismissKey) _dismissWeek(opts.dismissKey);
        }
        ov.addEventListener('click', function (e) { if (e.target === ov) { dismissIfChecked(); ov.remove(); } });
        ov.querySelector('[data-act="close"]').onclick = function () { dismissIfChecked(); ov.remove(); };
        ov.querySelector('[data-act="enable"]').onclick = function () { ov.remove(); enable(); };
        document.body.appendChild(ov);
    }

    // 홈(대시보드) 진입 시 1회 유도
    async function maybeShowHomePrompt() {
        try {
            if (!('Notification' in window) || Notification.permission === 'granted') return;
            if (_dismissed('pace_push_home_dismiss')) return;
            var cfg = await getConfig();
            if (!cfg || !cfg.configured) return;
            showPushPrompt({ title: '경기 알림 받기', message: '관심 종목의 소집·결과를 휴대폰 알림으로 받아보세요.', dismissKey: 'pace_push_home_dismiss' });
        } catch (e) {}
    }

    // 종목 토글을 켤 때 유도(아직 알림 미허용일 때만)
    function promptToggle() {
        if (!('Notification' in window) || Notification.permission === 'granted') return;
        if (_dismissed('pace_push_toggle_dismiss')) return;
        showPushPrompt({ title: '경기 알림 켜기', message: '이 종목의 소집·결과 알림을 받으려면 알림을 켜주세요.', dismissKey: 'pace_push_toggle_dismiss' });
    }

    window.PaceRisePush = { enable: enable, autoInit: autoInit, syncFavorites: syncFavorites, maybeShowHomePrompt: maybeShowHomePrompt, promptToggle: promptToggle };
    // 페이지 로드 후: 자동 재등록(이미 허용 시) + 홈 유도 팝업(미허용 시)
    function _onReady() {
        setTimeout(autoInit, 1500);
        setTimeout(maybeShowHomePrompt, 2500);
    }
    if (document.readyState === 'complete' || document.readyState === 'interactive') { _onReady(); }
    else { window.addEventListener('DOMContentLoaded', _onReady); }
})();
