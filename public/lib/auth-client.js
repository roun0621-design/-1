/**
 * PACE RISE Auth Client (Phase 3 — UI)
 *
 * 신규 JWT 기반 로그인 시스템의 클라이언트 헬퍼.
 *
 * 사용:
 *   await PaceAuth.login(username, password)
 *   await PaceAuth.me()      // 현재 사용자 (null 가능)
 *   await PaceAuth.logout()
 *   PaceAuth.getAccessToken()  // 동기, localStorage 에서
 *   PaceAuth.authFetch(url, opts)  // 자동으로 Authorization 헤더 추가 + 401 시 refresh 시도
 *
 * ⚠️ 기존 ?key= 인증과 별개로 동작.
 *    HttpOnly 쿠키도 서버가 같이 set 하므로 동일 출처 요청은 쿠키만으로도 동작 가능.
 */
(function (global) {
    'use strict';

    const LS_ACCESS  = 'pr_access_token';
    const LS_REFRESH = 'pr_refresh_token';
    const LS_USER    = 'pr_auth_user';

    function setTokens(access, refresh, user) {
        try {
            if (access)  localStorage.setItem(LS_ACCESS, access);
            if (refresh) localStorage.setItem(LS_REFRESH, refresh);
            if (user)    localStorage.setItem(LS_USER, JSON.stringify(user));
        } catch (e) { /* private mode 등 */ }
    }

    function clearTokens() {
        try {
            localStorage.removeItem(LS_ACCESS);
            localStorage.removeItem(LS_REFRESH);
            localStorage.removeItem(LS_USER);
        } catch (e) {}
    }

    function getAccessToken() {
        try { return localStorage.getItem(LS_ACCESS) || null; } catch (e) { return null; }
    }

    function getRefreshToken() {
        try { return localStorage.getItem(LS_REFRESH) || null; } catch (e) { return null; }
    }

    function getCachedUser() {
        try {
            const raw = localStorage.getItem(LS_USER);
            return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
    }

    /** POST /api/auth/login */
    async function login(username, password) {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ username, password }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            throw new Error(data.error || `로그인 실패 (${res.status})`);
        }
        setTokens(data.access_token, data.refresh_token, data.user);
        return data;
    }

    /** POST /api/auth/refresh — 토큰 갱신 */
    async function refresh() {
        const rt = getRefreshToken();
        const body = rt ? JSON.stringify({ refresh_token: rt }) : '{}';
        const res = await fetch('/api/auth/refresh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body,
        });
        if (!res.ok) {
            clearTokens();
            throw new Error('refresh 실패');
        }
        const data = await res.json();
        setTokens(data.access_token, data.refresh_token, getCachedUser());
        return data;
    }

    /** GET /api/auth/me */
    async function me() {
        const token = getAccessToken();
        const headers = {};
        if (token) headers['Authorization'] = 'Bearer ' + token;
        const res = await fetch('/api/auth/me', {
            credentials: 'same-origin',
            headers,
        });
        if (res.status === 401) {
            // 한 번 refresh 시도
            try {
                await refresh();
                return me();
            } catch (e) {
                return null;
            }
        }
        if (!res.ok) return null;
        const data = await res.json();
        if (data && data.user) {
            try { localStorage.setItem(LS_USER, JSON.stringify(data.user)); } catch(e) {}
        }
        return data.user || null;
    }

    /** POST /api/auth/logout */
    async function logout() {
        try {
            const rt = getRefreshToken();
            await fetch('/api/auth/logout', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: rt ? JSON.stringify({ refresh_token: rt }) : '{}',
            });
        } catch (e) { /* 무시 */ }
        clearTokens();
    }

    /** POST /api/auth/change-password */
    async function changePassword(current, next) {
        const token = getAccessToken();
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = 'Bearer ' + token;
        const res = await fetch('/api/auth/change-password', {
            method: 'POST',
            credentials: 'same-origin',
            headers,
            body: JSON.stringify({ current, next }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '비밀번호 변경 실패');
        clearTokens(); // 보안: 모든 세션 회수됨
        return data;
    }

    /**
     * 인증 fetch — Authorization 헤더 자동 부착, 401 시 1회 refresh 후 재시도.
     */
    async function authFetch(url, opts) {
        opts = opts || {};
        opts.credentials = opts.credentials || 'same-origin';
        opts.headers = Object.assign({}, opts.headers || {});
        const token = getAccessToken();
        if (token && !opts.headers['Authorization']) {
            opts.headers['Authorization'] = 'Bearer ' + token;
        }
        let res = await fetch(url, opts);
        if (res.status === 401 && getRefreshToken()) {
            try {
                await refresh();
                const newToken = getAccessToken();
                if (newToken) opts.headers['Authorization'] = 'Bearer ' + newToken;
                res = await fetch(url, opts);
            } catch (e) { /* 그냥 401 그대로 반환 */ }
        }
        return res;
    }

    global.PaceAuth = {
        login, refresh, me, logout, changePassword,
        getAccessToken, getRefreshToken, getCachedUser,
        clearTokens, authFetch,
    };
})(window);
