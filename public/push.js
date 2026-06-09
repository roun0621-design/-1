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
        if (!('serviceWorker' in navigator) || !('Notification' in window)) return { ok: false, reason: 'unsupported' };

        var perm = Notification.permission;
        if (perm === 'default' && requestPermission) perm = await Notification.requestPermission();
        if (perm !== 'granted') return { ok: false, reason: 'denied' };

        await loadScript('https://www.gstatic.com/firebasejs/' + FB_VER + '/firebase-app-compat.js');
        await loadScript('https://www.gstatic.com/firebasejs/' + FB_VER + '/firebase-messaging-compat.js');
        if (!window.firebase) return { ok: false, reason: 'sdk-failed' };
        if (!firebase.apps || !firebase.apps.length) firebase.initializeApp(cfg.config);
        var messaging = firebase.messaging();

        var swReg = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
        var token = await messaging.getToken({ vapidKey: cfg.vapidKey, serviceWorkerRegistration: swReg });
        if (!token) return { ok: false, reason: 'no-token' };

        await fetch('/api/push/register', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: token, audience: currentAudience(), competition_id: currentCompId() })
        });
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

    // 버튼에서 호출 — 권한 요청 포함
    async function enable() {
        try {
            var r = await _registerToken(true);
            if (r.ok) { _toast('알림이 켜졌습니다 🔔'); }
            else if (r.reason === 'denied') { _toast('브라우저에서 알림이 차단되어 있어요. 설정에서 허용해 주세요.'); }
            else if (r.reason === 'not-configured') { _toast('알림 설정이 아직 준비되지 않았습니다.'); }
            else { _toast('알림을 켤 수 없습니다 (' + r.reason + ')'); }
            return r;
        } catch (e) { _toast('알림 설정 실패: ' + e.message); return { ok: false }; }
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
