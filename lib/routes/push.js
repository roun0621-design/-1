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
            const topics = topicsFor(aud, competition_id);
            for (const t of topics) { await Push.subscribe([token], t); }
            res.json({ success: true, subscribed: topics, push_enabled: Push.isEnabled() });
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

    // 관리자 공지 발송
    app.post('/api/admin/push/send', async (req, res) => {
        try {
            const { admin_key, title, body, audience, competition_id } = req.body || {};
            if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
            if (!body) return res.status(400).json({ error: '내용(body)이 필요합니다.' });
            const aud = (audience === 'staff' || audience === 'public') ? audience : 'all';
            let topic = aud;
            if (competition_id && aud !== 'all') topic = `comp_${competition_id}_${aud}`;
            const r = await Push.sendToTopic(topic, {
                title: title || '알림',
                body,
                data: { competition_id: String(competition_id || ''), audience: aud },
            });
            res.json({ success: !!r.ok, topic, ...r });
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
};
