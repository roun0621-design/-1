/**
 * Home Popup — CMS routes
 *
 * server.js 에서 추출됨 (2단계 모듈 분리).
 * 외부 의존성: db, isAdminKey, opLog
 *
 * 사용법:
 *   require('./lib/routes/home_popups')(app, { db, isAdminKey, opLog });
 *
 * 라우트:
 *   GET    /api/home-popups
 *   POST   /api/home-popups
 *   PUT    /api/home-popups/reorder    (⚠️ /:id 보다 먼저 등록)
 *   PUT    /api/home-popups/:id
 *   DELETE /api/home-popups/:id
 */
module.exports = function mountHomePopupRoutes(app, deps) {
    const { db, isAdminKey, opLog } = deps;
    if (!app || !db || !isAdminKey || !opLog) {
        throw new Error('[home_popups.js] mount requires { db, isAdminKey, opLog }');
    }

    app.get('/api/home-popups', async (req, res) => {
        const popups = await db.all('SELECT * FROM home_popup ORDER BY sort_order, id');
        const sections = await db.all('SELECT * FROM home_popup_section ORDER BY popup_id, sort_order');
        popups.forEach(p => { p.sections = sections.filter(s => s.popup_id === p.id); });
        res.json(popups);
    });

    app.post('/api/home-popups', async (req, res) => {
        const {
            admin_key, popup_type, title, subtitle, intro_text,
            bottom_btn_text, bottom_btn_desc, bottom_btn_link, bottom_btn_active,
            is_active, show_from, show_until, sort_order, sections
        } = req.body;
        if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        try {
            const maxOrderRow = await db.get('SELECT MAX(sort_order) as m FROM home_popup');
            const maxOrder = (maxOrderRow && maxOrderRow.m) || 0;
            const info = await db.run(
                `INSERT INTO home_popup (popup_type, title, subtitle, intro_text, bottom_btn_text, bottom_btn_desc, bottom_btn_link, bottom_btn_active, is_active, show_from, show_until, sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
                popup_type || 'public', title || '', subtitle || '', intro_text || '',
                bottom_btn_text || '', bottom_btn_desc || '', bottom_btn_link || '',
                bottom_btn_active ?? 1, is_active ?? 1,
                show_from || null, show_until || null, sort_order ?? maxOrder + 1
            );
            const popupId = info.lastInsertRowid;
            if (Array.isArray(sections)) {
                for (let i = 0; i < sections.length; i++) {
                    const s = sections[i];
                    await db.run(
                        'INSERT INTO home_popup_section (popup_id, title, content, link_btn_text, link_btn_url, sort_order, is_active) VALUES (?,?,?,?,?,?,?)',
                        popupId, s.title || '', s.content || '', s.link_btn_text || '', s.link_btn_url || '',
                        s.sort_order ?? i, s.is_active ?? 1
                    );
                }
            }
            opLog('홈 팝업 생성', 'admin', 'admin');
            res.json({ id: popupId, success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ⚠️ /reorder 는 /:id 보다 먼저
    app.put('/api/home-popups/reorder', async (req, res) => {
        const { admin_key, order } = req.body;
        if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        if (!Array.isArray(order)) return res.status(400).json({ error: 'order array required' });
        await db.transaction(async () => {
            for (let i = 0; i < order.length; i++) {
                await db.run('UPDATE home_popup SET sort_order=? WHERE id=?', i + 1, order[i]);
            }
        })();
        res.json({ success: true });
    });

    app.put('/api/home-popups/:id', async (req, res) => {
        const {
            admin_key, popup_type, title, subtitle, intro_text,
            bottom_btn_text, bottom_btn_desc, bottom_btn_link, bottom_btn_active,
            is_active, show_from, show_until, sort_order, sections
        } = req.body;
        if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        const old = await db.get('SELECT * FROM home_popup WHERE id=?', req.params.id);
        if (!old) return res.status(404).json({ error: 'Not found' });
        try {
            const _nowF1 = db.isAsync ? 'NOW()' : "datetime('now')";
            await db.run(
                `UPDATE home_popup SET popup_type=?, title=?, subtitle=?, intro_text=?, bottom_btn_text=?, bottom_btn_desc=?, bottom_btn_link=?, bottom_btn_active=?, is_active=?, show_from=?, show_until=?, sort_order=?, updated_at=${_nowF1} WHERE id=?`,
                popup_type || old.popup_type, title ?? old.title, subtitle ?? old.subtitle,
                intro_text ?? old.intro_text, bottom_btn_text ?? old.bottom_btn_text,
                bottom_btn_desc ?? old.bottom_btn_desc, bottom_btn_link ?? old.bottom_btn_link,
                bottom_btn_active ?? old.bottom_btn_active, is_active ?? old.is_active,
                show_from || old.show_from, show_until || old.show_until,
                sort_order ?? old.sort_order ?? 0, old.id
            );
            if (Array.isArray(sections)) {
                await db.run('DELETE FROM home_popup_section WHERE popup_id=?', old.id);
                for (let i = 0; i < sections.length; i++) {
                    const s = sections[i];
                    await db.run(
                        'INSERT INTO home_popup_section (popup_id, title, content, link_btn_text, link_btn_url, sort_order, is_active) VALUES (?,?,?,?,?,?,?)',
                        old.id, s.title || '', s.content || '', s.link_btn_text || '', s.link_btn_url || '',
                        s.sort_order ?? i, s.is_active ?? 1
                    );
                }
            }
            opLog('홈 팝업 수정', 'admin', 'admin');
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.delete('/api/home-popups/:id', async (req, res) => {
        const { admin_key } = req.body;
        if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        const old = await db.get('SELECT * FROM home_popup WHERE id=?', req.params.id);
        if (!old) return res.status(404).json({ error: 'Not found' });
        await db.transaction(async () => {
            await db.run('DELETE FROM home_popup_section WHERE popup_id=?', old.id);
            await db.run('DELETE FROM home_popup WHERE id=?', old.id);
        })();
        opLog('홈 팝업 삭제', 'admin', 'admin');
        res.json({ success: true });
    });
};
