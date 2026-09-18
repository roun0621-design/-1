'use strict';
/**
 * push.js — 웹푸시(FCM) 라우트
 *   GET  /api/push/web-config           클라이언트 Firebase 공개설정(+VAPID)
 *   POST /api/push/register             기기 토큰 등록 + 토픽 구독
 *   POST /api/push/unregister           토큰 비활성
 *   POST /api/admin/push/send           관리자 공지 발송(토픽)
 *   GET  /api/admin/push/status         설정/토큰 상태
 *
 * 토픽 규칙: 'all', 'public', 'staff', 'comp_<id>_public', 'comp_<id>_staff'
 */
module.exports = function mountPushRoutes(app, deps) {
    const { db, isAdminKey, Push } = deps;

    function topicsFor(audience, competitionId) {
        const aud = audience === 'staff' ? 'staff' : 'public';
        const t = ['all', aud];
        if (competitionId) t.push(`comp_${competitionId}_${aud}`);
        return t;
    }

    // 클라이언트 공개설정
    app.get('/api/push/web-config', (req, res) => {
        try { res.json(Push.webConfig()); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });

    // 토큰 등록 + 구독
    app.post('/api/push/register', async (req, res) => {
        try {
            const { token, audience, competition_id } = req.body || {};
            if (!token) return res.status(400).json({ error: 'token 필요' });
            const aud = audience === 'staff' ? 'staff' : 'public';
            const ua = String(req.headers['user-agent'] || '').slice(0, 300);
            const now = new Date().toISOString();
            const existing = await db.get('SELECT id FROM push_token WHERE token=?', token);
            if (existing) {
                await db.run('UPDATE push_token SET audience=?, competition_id=?, user_agent=?, active=1, updated_at=? WHERE token=?',
                    aud, competition_id || null, ua, now, token);
            } else {
                await db.run('INSERT INTO push_token (token, audience, competition_id, user_agent, active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
                    token, aud, competition_id || null, ua, now, now);
            }
            // 토픽 구독은 하지 않는다 — 발송은 전부 저장된 토큰으로 직접 한다(sendToTopic 호출부 없음).
            //   예전엔 관람객이 대시보드를 열 때마다 FCM 구독 호출 3번을 순서대로 기다렸다 (수천 명이면 서버가 FCM 응답을 기다리며 묶인다).
            res.json({ success: true, subscribed: [], push_enabled: Push.isEnabled() });
        } catch (e) { console.error('[PUSH][register]', e); res.status(500).json({ error: e.message }); }
    });

    // 토큰 비활성
    app.post('/api/push/unregister', async (req, res) => {
        try {
            const { token } = req.body || {};
            if (!token) return res.status(400).json({ error: 'token 필요' });
            await db.run('UPDATE push_token SET active=0, updated_at=? WHERE token=?', new Date().toISOString(), token);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // 관리자 공지 발송 — 저장된 토큰에 직접 멀티캐스트(토픽 구독 의존 없음)
    app.post('/api/admin/push/send', async (req, res) => {
        try {
            const { admin_key, title, body, audience, competition_id } = req.body || {};
            if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
            if (!body) return res.status(400).json({ error: '내용(body)이 필요합니다.' });
            const aud = (audience === 'staff' || audience === 'public') ? audience : 'all';

            // 대상 토큰 조회
            let sql = 'SELECT token FROM push_token WHERE active=1';
            const params = [];
            if (aud !== 'all') { sql += ' AND audience=?'; params.push(aud); }
            if (competition_id) { sql += ' AND (competition_id=? OR competition_id IS NULL)'; params.push(competition_id); }
            const rows = await db.all(sql, ...params);
            const tokens = rows.map(r => r.token);
            if (!tokens.length) {
                return res.json({ success: true, sent: 0, note: '구독한 기기가 없습니다. 폰에서 "알림 받기"를 먼저 눌러주세요.' });
            }

            const r = await Push.sendToTokens(tokens, {
                title: title || '알림',
                body,
                data: { competition_id: String(competition_id || ''), audience: aud },
            });

            // 만료/해지 토큰 비활성화
            if (r.invalidTokens && r.invalidTokens.length) {
                const now = new Date().toISOString();
                for (const t of r.invalidTokens) {
                    try { await db.run('UPDATE push_token SET active=0, updated_at=? WHERE token=?', now, t); } catch (_) {}
                }
            }
            res.json({ success: !!r.ok, audience: aud, targeted: tokens.length, ...r });
        } catch (e) { console.error('[PUSH][send]', e); res.status(500).json({ error: e.message }); }
    });

    // 상태
    app.get('/api/admin/push/status', async (req, res) => {
        try {
            if (!isAdminKey(req.query.admin_key)) return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
            const cnt = await db.get('SELECT COUNT(*) AS c FROM push_token WHERE active=1');
            res.json({ ...Push.status(), web_configured: Push.webConfig().configured, tokens: cnt ? Number(cnt.c) : 0 });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // 관심 종목(즐겨찾기) 동기화 — 토큰별로 키 목록 교체
    // body: { token, competition_id, keys: ['M|100m', ...] }
    app.post('/api/push/interests', async (req, res) => {
        try {
            const { token, competition_id, keys } = req.body || {};
            if (!token) return res.status(400).json({ error: 'token 필요' });
            const list = Array.isArray(keys) ? keys.filter(k => typeof k === 'string' && k) : [];
            const now = new Date().toISOString();
            const txn = db.transaction(async () => {
                if (competition_id) await db.run('DELETE FROM push_interest WHERE token=? AND competition_id=?', token, competition_id);
                else await db.run('DELETE FROM push_interest WHERE token=? AND competition_id IS NULL', token);
                for (const k of list) {
                    await db.run('INSERT INTO push_interest (token, competition_id, fav_key, created_at) VALUES (?, ?, ?, ?)',
                        token, competition_id || null, k, now);
                }
            });
            await txn();
            res.json({ success: true, count: list.length });
        } catch (e) { console.error('[PUSH][interests]', e); res.status(500).json({ error: e.message }); }
    });

    // 특정 종목(event)의 관심 등록자에게 발송 — 소집/결과 트리거에서 호출
    // 같은 종목·같은 종류의 알림은 6시간 안에 한 번만 — 소집 완료는 조마다 호출되고(8개 조 = 같은 알림 8번),
    //   완료 → 되돌리기 → 다시 완료하면 '결과 발표'가 또 나갔다.
    const _sentRecently = new Map();
    const DEDUPE_MS = 6 * 60 * 60 * 1000;
    async function notifyEventInterest(event, opts) {
        try {
            if (!event || !Push.isEnabled()) return { ok: false, skipped: !Push.isEnabled() };
            const _dk = `${event.id}|${(opts && opts.kind) || ''}`;
            const _now = Date.now();
            if (_sentRecently.has(_dk) && _now - _sentRecently.get(_dk) < DEDUPE_MS) return { ok: true, sent: 0, deduped: true };
            _sentRecently.set(_dk, _now);
            if (_sentRecently.size > 2000) { for (const [k, t] of _sentRecently) if (_now - t > DEDUPE_MS) _sentRecently.delete(k); }
            const favKey = (event.gender || '') + '|' + (event.name || '');
            const rows = await db.all(
                `SELECT DISTINCT pt.token AS token
                 FROM push_interest pi JOIN push_token pt ON pt.token = pi.token
                 WHERE pi.fav_key = ? AND (pi.competition_id = ? OR pi.competition_id IS NULL) AND pt.active = 1`,
                favKey, event.competition_id);
            const tokens = rows.map(r => r.token);
            if (!tokens.length) return { ok: true, sent: 0 };
            const r = await Push.sendToTokens(tokens, {
                title: (opts && opts.title) || '알림',
                body: (opts && opts.body) || '',
                data: { event_id: String(event.id || ''), kind: (opts && opts.kind) || '' },
            });
            if (r.invalidTokens && r.invalidTokens.length) {
                const now = new Date().toISOString();
                for (const t of r.invalidTokens) { try { await db.run('UPDATE push_token SET active=0, updated_at=? WHERE token=?', now, t); } catch (_) {} }
            }
            return r;
        } catch (e) { console.error('[PUSH][notifyEventInterest]', e.message); return { ok: false, error: e.message }; }
    }

    return { notifyEventInterest };
};
