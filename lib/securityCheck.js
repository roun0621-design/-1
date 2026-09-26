/**
 * lib/securityCheck.js — 부팅 시 약한 자격증명 자가점검 (경고만, 동작 변경 없음)
 * ------------------------------------------------------------------
 * 운영 중 관찰된 실제 위험(operation_key='1234', 기본 비밀번호 등)을
 * 부팅 로그 + /api/health 로 surface 해서 "조용히 약한 채로" 두는 걸 막는다.
 * 자격증명을 바꾸지는 않는다(잠금 위험) — 알림만 한다.
 */

'use strict';

// 흔하거나 기본값인 약한 비밀 목록 (소문자 비교)
const WEAK = new Set([
    '1234', '12345', '123456', '1234567', '12345678', '0000', '1111',
    'admin', 'password', 'passwd', 'changeme', 'operation', 'test',
    'qwerty', 'asdf', 'secret', 'pacerise', 'key', 'default',
]);

function isWeak(v, minLen) {
    if (v === undefined || v === null || v === '') return true;
    const s = String(v);
    if (s.length < minLen) return true;
    return WEAK.has(s.toLowerCase());
}

/**
 * @returns {string[]} 사람이 읽을 경고 메시지 배열 (없으면 빈 배열)
 */
function runSecuritySelfCheck(env = process.env) {
    const w = [];

    if (!env.OPERATION_KEY) {
        w.push("OPERATION_KEY 미설정 — 기본값 '1234' 사용 중. 즉시 강한 값으로 설정 필요");
    } else if (isWeak(env.OPERATION_KEY, 6)) {
        w.push('OPERATION_KEY 가 약함(짧거나 흔한 값). 8자 이상 무작위 권장');
    }

    if (!env.ADMIN_PW) {
        w.push("ADMIN_PW 미설정 — 기본값 'changeme' 사용 중. 즉시 변경 필요");
    } else if (isWeak(env.ADMIN_PW, 8)) {
        w.push('ADMIN_PW 가 약함(8자 미만 또는 흔한 값). 강한 비밀번호 권장');
    }

    if (!env.ADMIN_ID || String(env.ADMIN_ID).toLowerCase() === 'admin') {
        w.push("ADMIN_ID 가 기본값('admin') — 추측 어려운 ID 권장");
    }

    // JWT_SECRET 은 미설정 시 자동생성/저장되므로(jwt.js) '설정됐는데 약한' 경우만 경고
    if (env.JWT_SECRET && String(env.JWT_SECRET).length < 32) {
        w.push('JWT_SECRET 가 32자 미만 — 자동생성 키보다 약할 수 있음(설정 제거 또는 강화 권장)');
    }

    return w;
}

module.exports = { runSecuritySelfCheck, _WEAK: WEAK };
