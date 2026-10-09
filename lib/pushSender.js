'use strict';
/**
 * pushSender.js — FCM(Firebase Cloud Messaging) 웹푸시 발송 래퍼
 * ------------------------------------------------------------------
 * 설계 원칙: 키(서비스계정/웹설정)가 없거나 firebase-admin 미설치면 "자동 비활성(no-op)".
 *   → 환경변수만 채우면 켜지고, 없으면 앱은 평소처럼 동작(SMS sim_mode 와 동일 철학).
 *
 * 서버 발송용(서비스계정) 환경변수 — 다음 중 하나:
 *   FIREBASE_SERVICE_ACCOUNT       = 서비스계정 JSON 문자열(통째로)
 *   FIREBASE_SERVICE_ACCOUNT_PATH  = 서비스계정 JSON 파일 경로
 *   또는 FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY (개별)
 *
 * 클라이언트(웹) 설정 환경변수 — 브라우저에 내려가는 공개값:
 *   FIREBASE_WEB_API_KEY, FIREBASE_WEB_AUTH_DOMAIN, FIREBASE_PROJECT_ID,
 *   FIREBASE_MESSAGING_SENDER_ID, FIREBASE_WEB_APP_ID, FIREBASE_VAPID_KEY
 */
const fs = require('fs');

let admin = null;
let _initTried = false;
let _enabled = false;
let _initError = null;

function _serviceAccount() {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT || '';
    if (raw && raw.trim().startsWith('{')) {
        try { return JSON.parse(raw); } catch (e) { _initError = 'FIREBASE_SERVICE_ACCOUNT JSON 파싱 실패'; return null; }
    }
    const p = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || '';
    if (p) {
        try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { _initError = '서비스계정 파일 읽기 실패: ' + e.message; return null; }
    }
    if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
        return {
            project_id: process.env.FIREBASE_PROJECT_ID,
            client_email: process.env.FIREBASE_CLIENT_EMAIL,
            private_key: process.env.FIREBASE_PRIVATE_KEY,
        };
    }
    return null;
}

function _init() {
    if (_initTried) return;
    _initTried = true;
    const sa = _serviceAccount();
    if (!sa) { _enabled = false; if (!_initError) _initError = '미설정(서비스계정 환경변수 없음)'; return; }
    try {
        admin = require('firebase-admin');
    } catch (e) {
        _enabled = false; _initError = 'firebase-admin 미설치 — 배포 시 npm install 필요'; return;
    }
    try {
        if (!admin.apps || !admin.apps.length) {
            admin.initializeApp({
                credential: admin.credential.cert({
                    projectId: sa.project_id || sa.projectId,
                    clientEmail: sa.client_email || sa.clientEmail,
                    privateKey: String(sa.private_key || sa.privateKey || '').replace(/\\n/g, '\n'),
                }),
            });
        }
        _enabled = true;
    } catch (e) {
        _enabled = false; _initError = 'firebase 초기화 실패: ' + e.message;
    }
}

function isEnabled() { _init(); return _enabled; }
function status() { _init(); return { enabled: _enabled, error: _enabled ? null : _initError }; }

// 브라우저로 내려보낼 공개 설정
function webConfig() {
    const config = {
        apiKey: process.env.FIREBASE_WEB_API_KEY || '',
        authDomain: process.env.FIREBASE_WEB_AUTH_DOMAIN || '',
        projectId: process.env.FIREBASE_PROJECT_ID || '',
        messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
        appId: process.env.FIREBASE_WEB_APP_ID || '',
    };
    const vapidKey = process.env.FIREBASE_VAPID_KEY || '';
    const configured = !!(config.apiKey && config.projectId && config.messagingSenderId && config.appId && vapidKey);
    return { configured, config, vapidKey };
}

async function sendToTopic(topic, { title, body, data } = {}) {
    _init();
    if (!_enabled) return { ok: false, skipped: true, error: _initError };
    try {
        const strData = {};
        Object.entries(data || {}).forEach(([k, v]) => { strData[k] = String(v == null ? '' : v); });
        const id = await admin.messaging().send({
            topic,
            notification: { title: title || '', body: body || '' },
            data: strData,
            webpush: { notification: { icon: '/icons/icon-192.png' } },
        });
        return { ok: true, id };
    } catch (e) { return { ok: false, error: e.message }; }
}

// 플랫폼별 메시지 본문 (테스트에서 직접 확인)
//   web:     data-only — 브라우저 자동표시에 의존하지 않고 SW 가 직접 표시(가장 확실)
//   ios:     notification + apns(aps.alert·sound) — WKWebView 앱은 SW 가 없으니 APNs 알림 형식이어야 표시된다
//   android: notification + android(high) — 네이티브 래퍼(TWA/캐패시터)용
function buildMessage(platform, { title, body, data } = {}) {
    const payloadData = { title: title || '알림', body: body || '' };
    Object.entries(data || {}).forEach(([k, v]) => { payloadData[k] = String(v == null ? '' : v); });
    if (platform === 'ios') {
        return {
            notification: { title: payloadData.title, body: payloadData.body },
            data: payloadData,
            apns: { headers: { 'apns-priority': '10' }, payload: { aps: { sound: 'default', 'mutable-content': 1 } } },
        };
    }
    if (platform === 'android') {
        return {
            notification: { title: payloadData.title, body: payloadData.body },
            data: payloadData,
            android: { priority: 'high', ttl: 600000, notification: { icon: 'ic_notification', color: '#1a2a5e' } },
        };
    }
    return { data: payloadData, webpush: { headers: { Urgency: 'high', TTL: '600' } } };
}

// 저장된 토큰들에 직접 발송(멀티캐스트) — 토픽 구독 의존 없이 확실히 전달.
//   tokens: 문자열 배열(=web) 또는 { token, platform } 배열. 플랫폼별로 나눠 보낸다.
// 반환: { ok, sent, failed, invalidTokens[] }  (invalidTokens 는 만료/해지된 토큰)
async function sendToTokens(tokens, { title, body, data } = {}) {
    _init();
    if (!_enabled) return { ok: false, skipped: true, error: _initError };
    const list = (tokens || []).filter(Boolean).map(t => typeof t === 'string' ? { token: t, platform: 'web' } : { token: t.token, platform: t.platform || 'web' }).filter(t => t.token);
    if (!list.length) return { ok: true, sent: 0, failed: 0, invalidTokens: [], empty: true };
    const groups = new Map();
    for (const t of list) { const p = ['ios', 'android'].includes(t.platform) ? t.platform : 'web'; if (!groups.has(p)) groups.set(p, []); groups.get(p).push(t.token); }
    let sent = 0, failed = 0; const invalidTokens = [];
    try {
        for (const [platform, ptokens] of groups) {
        const message = buildMessage(platform, { title, body, data });
        // 500개씩 끊어서 (FCM 멀티캐스트 한도)
        for (let i = 0; i < ptokens.length; i += 500) {
            const chunk = ptokens.slice(i, i + 500);
            const resp = await admin.messaging().sendEachForMulticast({ tokens: chunk, ...message });
            resp.responses.forEach((r, idx) => {
                if (r.success) { sent++; }
                else {
                    failed++;
                    const code = r.error && r.error.code || '';
                    // 토큰 자체가 죽은 경우만 비활성화한다. 'invalid-argument' 는 본문이 너무 큰 경우 등 '메시지' 쪽 문제로도 나오므로
                    //   여기에 넣으면 긴 공지 한 번에 모든 기기의 구독이 꺼질 수 있다.
                    if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
                        invalidTokens.push(chunk[idx]);
                    }
                }
            });
        }
        }
        return { ok: true, sent, failed, invalidTokens };
    } catch (e) { return { ok: false, error: e.message, sent, failed, invalidTokens }; }
}

async function subscribe(tokens, topic) {
    _init();
    if (!_enabled) return { ok: false, skipped: true };
    try { await admin.messaging().subscribeToTopic(tokens, topic); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
}
async function unsubscribe(tokens, topic) {
    _init();
    if (!_enabled) return { ok: false, skipped: true };
    try { await admin.messaging().unsubscribeFromTopic(tokens, topic); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { isEnabled, status, webConfig, sendToTopic, sendToTokens, subscribe, unsubscribe, buildMessage };
