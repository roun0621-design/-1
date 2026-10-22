'use strict';
/**
 * 조직(organization) — 멀티테넌시 1단계 (2026-10-01, docs/MULTI_TENANCY_PLAN.md)
 *
 *   한 서버·한 코드에서 조직별로 칸막이를 친다. 요청마다 호스트(도메인)로 조직을 고르고 req.org 에 둔다.
 *   선택 순서:
 *     ① ?org=<slug> 쿼리 또는 x-org 헤더 (로컬·테스트용. 실존 slug 일 때만)
 *     ② 호스트 == organization.custom_domain
 *     ③ 호스트의 첫 라벨 == organization.slug   (jp.pace-rise-node.com, jp.localhost)
 *     ④ 그 외(pace-rise-node.com, www, localhost) → 기본 조직 (ORG_DEFAULT_SLUG, 기본 'pace-rise')
 *   조직 목록은 60초 캐시. 조직을 만들거나 고치면 invalidate() 로 비운다.
 */

const DEFAULT_SLUG = process.env.ORG_DEFAULT_SLUG || 'pace-rise';
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}$/;
const RESERVED = new Set(['www', 'api', 'admin', 'static', 'app', 'mail', 'ftp']);
const LANGS = ['ko', 'en', 'ja'];
const CACHE_MS = 60 * 1000;

// 기본 조직이 DB 에 아직 없을 때(부팅 직후·테스트) 쓰는 대체값 — id 1 과 같은 모양
const FALLBACK_DEFAULT = Object.freeze({
    id: 1, slug: DEFAULT_SLUG, name: 'PACE RISE', name_en: 'PACE RISE', country: 'KR',
    default_tz: 'Asia/Seoul', default_lang: 'ko', custom_domain: '', site_name: '',
    brand_logo_path: '', brand_color_point: '', brand_color_accent: '', settings_json: '{}', active: 1,
});

function isValidSlug(s) { return typeof s === 'string' && SLUG_RE.test(s) && !RESERVED.has(s); }
function isValidCountry(c) { return typeof c === 'string' && /^[A-Z]{2}$/.test(c); }
function isValidLang(l) { return LANGS.includes(l); }

function hostOf(req) {
    const raw = String((req.headers && req.headers.host) || '').toLowerCase();
    return raw.split(':')[0];
}

// 공개 응답용 요약 (settings_json·내부 컬럼 제외)
function summary(org, defaultId) {
    return {
        id: org.id, slug: org.slug, name: org.name, name_en: org.name_en || '',
        country: org.country, default_tz: org.default_tz, default_lang: org.default_lang,
        site_name: org.site_name || '', custom_domain: org.custom_domain || '',
        brand: { logo: org.brand_logo_path || '', point: org.brand_color_point || '', accent: org.brand_color_accent || '' },
        is_default: org.id === defaultId,
    };
}

function createResolver(dbOrGetter) {
    const getDb = typeof dbOrGetter === 'function' ? dbOrGetter : () => dbOrGetter;   // server.js 는 db 가 뒤에서 선언되므로 getter 로 넘긴다
    let rows = null, loadedAt = 0, loading = null;

    async function load() {
        try { rows = await getDb().all('SELECT * FROM organization WHERE active=1 ORDER BY id'); }
        catch (e) { rows = []; }
        loadedAt = Date.now();
        return rows;
    }
    async function all() {
        if (rows && Date.now() - loadedAt < CACHE_MS) return rows;
        if (!loading) loading = load().finally(() => { loading = null; });
        return loading;
    }
    function invalidate() { rows = null; loadedAt = 0; }

    async function defaultOrg() {
        const list = await all();
        return list.find(o => o.slug === DEFAULT_SLUG) || list.find(o => o.id === 1) || list[0] || FALLBACK_DEFAULT;
    }

    async function resolve(req) {
        const list = await all();
        const bySlug = s => list.find(o => o.slug === s);
        // ① 명시적 지정
        const explicit = (req.query && req.query.org) || (req.headers && req.headers['x-org']);
        if (explicit) { const o = bySlug(String(explicit).toLowerCase()); if (o) return o; }
        const host = hostOf(req);
        if (host) {
            // ② 전용 도메인
            const byDomain = list.find(o => o.custom_domain && o.custom_domain.toLowerCase() === host);
            if (byDomain) return byDomain;
            // ③ 서브도메인
            const labels = host.split('.');
            if (labels.length >= 2 && labels[0] !== 'www') { const o = bySlug(labels[0]); if (o) return o; }
        }
        // ④ 기본
        return defaultOrg();
    }

    function middleware() {
        return (req, res, next) => {
            resolve(req).then(org => { req.org = org; next(); }).catch(() => { req.org = FALLBACK_DEFAULT; next(); });
        };
    }

    return { resolve, middleware, invalidate, all, defaultOrg, summary: async (org) => summary(org, (await defaultOrg()).id) };
}

module.exports = { createResolver, isValidSlug, isValidCountry, isValidLang, LANGS, DEFAULT_SLUG, FALLBACK_DEFAULT, summary };
