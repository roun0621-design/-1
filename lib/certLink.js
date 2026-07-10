/**
 * 상장 공개 링크 토큰 — 서명 기반(무상태)
 *
 * SMS로 보내는 "상장 다운로드" 링크에 사용. athlete_id 를 그대로 노출하지 않고
 * HMAC 서명으로 위조를 막는다(스키마 변경 없음). 서명 비밀키는 JWT 시크릿을 재사용.
 *
 *   token = base64url("{competitionId}:{eventId}:{athleteId}") + "." + base64url(HMAC-SHA256)[:27]
 *
 * 서명이 없으면 위조 불가 → 로그인 없이도 링크 소지자만 열람 가능.
 */
const crypto = require('crypto');
const { getOrCreateSecret } = require('./auth/jwt');

function b64url(buf) {
    return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecodeStr(str) {
    let s = String(str).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return Buffer.from(s, 'base64').toString('utf8');
}
function _sign(payloadB64, secret) {
    return b64url(crypto.createHmac('sha256', secret).update(payloadB64).digest()).slice(0, 27);
}

/**
 * 상장 링크 토큰 생성
 * @param {Object} db
 * @param {{competitionId:number, eventId:number, athleteId:number}} p
 * @returns {Promise<string>}
 */
async function buildCertToken(db, p) {
    const secret = await getOrCreateSecret(db);
    const payload = `${p.competitionId || 0}:${p.eventId}:${p.athleteId}`;
    const pb = b64url(payload);
    return `${pb}.${_sign(pb, secret)}`;
}

/**
 * 토큰 검증 → { competitionId, eventId, athleteId } 또는 null
 */
async function verifyCertToken(db, token) {
    if (!token || typeof token !== 'string' || token.indexOf('.') < 0) return null;
    const idx = token.indexOf('.');
    const pb = token.slice(0, idx);
    const sig = token.slice(idx + 1);
    if (!pb || !sig) return null;
    const secret = await getOrCreateSecret(db);
    const expected = _sign(pb, secret);
    if (sig.length !== expected.length) return null;
    let ok = false;
    try { ok = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); } catch (e) { return null; }
    if (!ok) return null;
    let payload;
    try { payload = b64urlDecodeStr(pb); } catch (e) { return null; }
    const parts = payload.split(':');
    const competitionId = parseInt(parts[0], 10);
    const eventId = parseInt(parts[1], 10);
    const athleteId = parseInt(parts[2], 10);
    if (!eventId || !athleteId) return null;
    return { competitionId: competitionId || null, eventId, athleteId };
}

module.exports = { buildCertToken, verifyCertToken };
