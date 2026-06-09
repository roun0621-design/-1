/**
 * push.js — 웹푸시(FCM) 클라이언트
 * - 서버 설정(/api/push/web-config)이 있을 때만 동작. 없으면 조용히 종료.
 * - 알림 권한은 사용자 동작(버튼)에서 요청하는 게 좋음 → window.PaceRisePush.enable() 노출.
 * - 한 번 허용했으면 다음 방문부터 자동 재등록.
 */
(function () {
    var FB_VER = '10.12.2';
    var _cfg = null;

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

        var swReg = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
        await navigator.serviceWorker.ready;
        var token = await messaging.getToken({ vapidKey: cfg.vapidKey, serviceWorkerRegistration: swReg });
        if (!token) return { ok: false, reason: 'no-token' };

        var rr = await fetch('/api/push/register', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: token, audience: currentAudience(), competition_id: currentCompId() })
        });
        if (!rr.ok) return { ok: false, reason: 'register-failed-' + rr.status };
        // 포그라운드 메시지 — 간단 알림
        try {
            messaging.onMessage(function (payload) {
                var n = (payload && payload.notification) || {};
                if (Notification.permission === 'granted') {
                    new Notification(n.title || '알림', { body: n.body || '', icon: '/icons/icon-192.png' });
                }
            });
        } catch (e) {}
        return { ok: true, token: token };
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
        } catch (e) { alert('알림 설정 중 오류: ' + (e && e.message ? e.message : e)); return { ok: false }; }
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

    window.PaceRisePush = { enable: enable, autoInit: autoInit };
    // 페이지 로드 후 자동 재등록(이미 허용한 경우만)
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        setTimeout(autoInit, 1500);
    } else {
        window.addEventListener('DOMContentLoaded', function () { setTimeout(autoInit, 1500); });
    }
})();
