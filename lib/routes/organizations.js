'use strict';
/**
 * 조직(organization) 라우트 — 멀티테넌시 1단계 (docs/MULTI_TENANCY_PLAN.md)
 *   GET  /api/org                       공개 — 현재 호스트의 조직 요약 (이름·국가·시간대·기본 언어·브랜드)
 *   GET  /api/admin/organizations       플랫폼 관리자(기본 조직의 관리자 키) — 전체 목록
 *   POST /api/admin/organizations       플랫폼 관리자 — 생성
 *   PUT  /api/admin/organizations/:id   플랫폼 관리자 — 수정 (slug 변경 포함)
 *   조직 생성·수정은 기본 조직 호스트에서만 된다. 다른 조직 호스트에서는 403.
 */
const TZ = require('../tz');
const Org = require('../org');

module.exports = function mountOrganizationRoutes(app, deps) {
    const { db, isAdminKey, opLog, org, upload } = deps;
    const path = require('path'), fs = require('fs');
    if (!app || !db || !isAdminKey || !opLog || !org) throw new Error('[organizations.js] mount requires { db, isAdminKey, opLog, org }');

    const nowExpr = () => (db.isAsync ? 'NOW()' : "datetime('now')");
    const requirePlatformAdmin = async (req, res) => {
        const key = (req.body && req.body.admin_key) || (req.query && req.query.key);
        if (!isAdminKey(key)) { res.status(403).json({ error: '관리자 키가 필요합니다.' }); return false; }
        const d = await org.defaultOrg();
        if (!req.org || req.org.id !== d.id) { res.status(403).json({ error: '조직 관리는 기본 조직에서만 할 수 있습니다.' }); return false; }
        return true;
    };

    app.get('/api/org', async (req, res) => {
        try { res.json(await org.summary(req.org || Org.FALLBACK_DEFAULT)); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/admin/organizations', async (req, res) => {
        if (!(await requirePlatformAdmin(req, res))) return;
        const rows = await db.all('SELECT * FROM organization ORDER BY id');
        const counts = await db.all('SELECT organization_id, COUNT(*) AS c FROM competition GROUP BY organization_id');
        const cm = {}; counts.forEach(r => { cm[r.organization_id] = Number(r.c); });
        res.json(rows.map(r => ({ ...r, competition_count: cm[r.id] || 0 })));
    });

    // 입력 검증 — 생성·수정 공용. 반환: { ok, error, values }
    function validate(body, existing) {
        const v = {};
        const pick = (k, def) => (body[k] !== undefined ? body[k] : (existing ? existing[k] : def));
        v.slug = String(pick('slug', '')).trim().toLowerCase();
        if (!Org.isValidSlug(v.slug)) return { error: '주소(slug)는 소문자·숫자·하이픈 2~39자이며 www·api·admin 은 쓸 수 없습니다.' };
        v.name = String(pick('name', '')).trim();
        if (!v.name) return { error: '조직 이름은 필수입니다.' };
        v.name_en = String(pick('name_en', '')).trim();
        v.country = String(pick('country', 'KR')).trim().toUpperCase();
        if (!Org.isValidCountry(v.country)) return { error: '국가는 두 글자 코드(KR, JP, US …)로 적습니다.' };
        v.default_tz = String(pick('default_tz', TZ.DEFAULT_TZ)).trim() || TZ.DEFAULT_TZ;
        if (!TZ.isValidTz(v.default_tz)) return { error: `시간대 이름이 올바르지 않습니다: ${v.default_tz}` };
        v.default_lang = String(pick('default_lang', 'ko')).trim().toLowerCase();
        if (!Org.isValidLang(v.default_lang)) return { error: '기본 언어는 ko / en / ja 중 하나입니다.' };
        v.custom_domain = String(pick('custom_domain', '')).trim().toLowerCase();
        if (v.custom_domain && !/^[a-z0-9.-]{3,253}$/.test(v.custom_domain)) return { error: '전용 도메인 형식이 올바르지 않습니다.' };
        v.site_name = String(pick('site_name', '')).trim();
        v.brand_color_point = String(pick('brand_color_point', '')).trim();
        v.brand_color_accent = String(pick('brand_color_accent', '')).trim();
        v.active = pick('active', 1) ? 1 : 0;
        return { values: v };
    }

    app.post('/api/admin/organizations', async (req, res) => {
        if (!(await requirePlatformAdmin(req, res))) return;
        const { error, values: v } = validate(req.body || {}, null);
        if (error) return res.status(400).json({ error });
        const dup = await db.get('SELECT id FROM organization WHERE slug=?', v.slug);
        if (dup) return res.status(409).json({ error: '이미 쓰는 주소(slug)입니다.' });
        if (v.custom_domain) { const d2 = await db.get('SELECT id FROM organization WHERE custom_domain=?', v.custom_domain); if (d2) return res.status(409).json({ error: '이미 쓰는 전용 도메인입니다.' }); }
        const info = await db.run(
            'INSERT INTO organization (slug,name,name_en,country,default_tz,default_lang,custom_domain,site_name,brand_color_point,brand_color_accent,active) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
            v.slug, v.name, v.name_en, v.country, v.default_tz, v.default_lang, v.custom_domain, v.site_name, v.brand_color_point, v.brand_color_accent, v.active);
        org.invalidate();
        try { await require('../certificateTemplates').seedDefaultTemplates(db, info.lastInsertRowid, v.default_lang); } catch (e) { console.error('[org] 양식 시드 실패:', e.message); }   // 새 조직에도 기본 상장 양식
        const row = await db.get('SELECT * FROM organization WHERE id=?', info.lastInsertRowid);
        opLog(`조직 생성: ${v.name} (${v.slug}, ${v.country})`, 'admin', 'admin');
        res.json(row);
    });

    app.put('/api/admin/organizations/:id', async (req, res) => {
        if (!(await requirePlatformAdmin(req, res))) return;
        const old = await db.get('SELECT * FROM organization WHERE id=?', req.params.id);
        if (!old) return res.status(404).json({ error: '조직을 찾을 수 없습니다.' });
        const { error, values: v } = validate(req.body || {}, old);
        if (error) return res.status(400).json({ error });
        const d = await org.defaultOrg();
        if (old.id === d.id && (v.slug !== old.slug || !v.active)) return res.status(400).json({ error: '기본 조직의 주소는 바꾸거나 끌 수 없습니다.' });
        const dup = await db.get('SELECT id FROM organization WHERE slug=? AND id<>?', v.slug, old.id);
        if (dup) return res.status(409).json({ error: '이미 쓰는 주소(slug)입니다.' });
        if (v.custom_domain) { const d2 = await db.get('SELECT id FROM organization WHERE custom_domain=? AND id<>?', v.custom_domain, old.id); if (d2) return res.status(409).json({ error: '이미 쓰는 전용 도메인입니다.' }); }
        await db.run(
            `UPDATE organization SET slug=?, name=?, name_en=?, country=?, default_tz=?, default_lang=?, custom_domain=?, site_name=?, brand_color_point=?, brand_color_accent=?, active=?, updated_at=${nowExpr()} WHERE id=?`,
            v.slug, v.name, v.name_en, v.country, v.default_tz, v.default_lang, v.custom_domain, v.site_name, v.brand_color_point, v.brand_color_accent, v.active, old.id);
        org.invalidate();
        opLog(`조직 수정: ${v.name} (${v.slug})`, 'admin', 'admin');
        res.json(await db.get('SELECT * FROM organization WHERE id=?', old.id));
    });

    // 조직 로고 (홈·관리자 헤더에 워드마크 대신 표시). 플랫폼 관리자가 기본 조직 호스트에서, 또는 그 조직 호스트의 관리자가 자기 조직만
    app.post('/api/admin/organizations/:id/logo', upload ? upload.single('image') : (req, res, next) => next(), async (req, res) => {
        try {
            const key = (req.body && req.body.admin_key) || req.query.key;
            if (!isAdminKey(key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
            const target = await db.get('SELECT * FROM organization WHERE id=?', req.params.id);
            if (!target) return res.status(404).json({ error: '조직을 찾을 수 없습니다.' });
            const d = await org.defaultOrg();
            if (!(req.org && (req.org.id === d.id || req.org.id === target.id))) return res.status(403).json({ error: '이 조직의 로고는 여기서 바꿀 수 없습니다.' });
            if (!req.file) return res.status(400).json({ error: '파일이 업로드되지 않았습니다.' });
            const destDir = path.join(__dirname, '..', '..', 'public', 'uploads', 'brand');
            if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
            for (const oe of ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']) { try { fs.unlinkSync(path.join(destDir, `org_${target.id}${oe}`)); } catch (e) {} }
            const ext = (path.extname(req.file.originalname) || '.png').toLowerCase();
            if (!['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext)) return res.status(400).json({ error: '이미지 파일(png/jpg/svg/webp)만 올릴 수 있습니다.' });
            const filename = `org_${target.id}${ext}`;
            fs.copyFileSync(req.file.path, path.join(destDir, filename)); try { fs.unlinkSync(req.file.path); } catch (e) {}
            const url = `/uploads/brand/${filename}`;
            await db.run('UPDATE organization SET brand_logo_path=? WHERE id=?', url, target.id);
            org.invalidate();
            opLog(`조직 로고 변경: ${target.name}`, 'admin', 'admin');
            res.json({ success: true, url: url + '?v=' + Date.now(), path: url });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
    app.delete('/api/admin/organizations/:id/logo', async (req, res) => {
        const key = (req.body && req.body.admin_key) || req.query.key;
        if (!isAdminKey(key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        const target = await db.get('SELECT * FROM organization WHERE id=?', req.params.id);
        if (!target) return res.status(404).json({ error: '조직을 찾을 수 없습니다.' });
        const d = await org.defaultOrg();
        if (!(req.org && (req.org.id === d.id || req.org.id === target.id))) return res.status(403).json({ error: '권한이 없습니다.' });
        await db.run("UPDATE organization SET brand_logo_path='' WHERE id=?", target.id);
        org.invalidate();
        res.json({ success: true });
    });
};
