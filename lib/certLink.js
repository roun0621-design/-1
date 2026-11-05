/**
 * 상장 공개 링크 토큰
 *
 * (2026-11-05) 새 링크는 DB 발급 기록(cert_link) 기반 — 난수 토큰 + 발급 때 선수 이름·배번 스냅샷.
 *   서명 토큰의 두 가지 흠 때문이다: ① 서버 키(JWT 시크릿)가 바뀌면 보낸 링크가 전부 죽는다
 *   ② (대회:종목:선수) 번호만 담아, 명단을 다시 올려 같은 번호에 다른 선수가 들어오면 남의 상장이 열린다.
 *   옛 서명 토큰('.' 포함)은 계속 받되, 공개 라우트가 문자 발송 기록과 대조해 선수가 바뀐 흔적이 있으면 열지 않는다.
 *
 * (옛) 서명 기반(무상태) 토큰 —
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

/** 난수 토큰 — base64url 22자, '.' 이 없어 옛 서명 토큰과 구분된다 */
function randomToken() { return b64url(crypto.randomBytes(16)); }

/**
 * 링크 발급 (cert_link 에 기록) → token
 * @param {{competitionId, eventId, athleteId, athleteName?, bibNumber?, team?, eventName?, channel?}} p
 */
async function issueCertLink(db, p) {
    const row = [
        parseInt(p.competitionId, 10) || 0, parseInt(p.eventId, 10), parseInt(p.athleteId, 10),
        String(p.athleteName || '').slice(0, 100), p.bibNumber == null ? '' : String(p.bibNumber).slice(0, 20),
        String(p.team || '').slice(0, 100), String(p.eventName || '').slice(0, 100), p.channel === 'email' ? 'email' : 'sms',
        new Date().toISOString(),
    ];
    for (let i = 0; ; i++) {
        const token = randomToken();
        try {
            await db.run(`INSERT INTO cert_link (token, competition_id, event_id, athlete_id, athlete_name, bib_number, team, event_name, channel, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`, token, ...row);
            return token;
        } catch (e) { if (i >= 2) throw e; }   // UNIQUE 충돌(사실상 없음)이면 한 번 더
    }
}

/**
 * 토큰 해석 → { kind:'db'|'legacy', token, competitionId, eventId, athleteId, link? } 또는 null
 *   '.' 이 있으면 옛 서명 토큰, 아니면 cert_link 조회
 */
async function resolveCertLink(db, token) {
    if (!token || typeof token !== 'string') return null;
    if (token.indexOf('.') >= 0) {
        const p = await verifyCertToken(db, token);
        return p ? { kind: 'legacy', token, ...p } : null;
    }
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
    const link = await db.get('SELECT * FROM cert_link WHERE token=?', token);
    if (!link) return null;
    return { kind: 'db', token, competitionId: link.competition_id || null, eventId: link.event_id, athleteId: link.athlete_id, link };
}

module.exports = { buildCertToken, verifyCertToken, issueCertLink, resolveCertLink };
