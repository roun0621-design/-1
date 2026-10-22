'use strict';
/**
 * 정적 자원 캐시 버전 자동화 (2026-09 Phase 4)
 *   전에는 JS/CSS 를 고칠 때마다 HTML 의 `?v=NN` 과 sw.js 의 CACHE_NAME 을 손으로 올렸다. 빠뜨리면 브라우저·서비스워커가 옛 파일을 쓴다.
 *   이제 서버가 파일 내용의 해시로 버전을 만든다:
 *     - HTML 을 내보낼 때 `xxx.js?v=…` / `xxx.css?v=…` 를 그 파일의 해시로 바꿔 쓴다 (원본 파일은 그대로)
 *     - sw.js 의 CACHE_NAME 을 모든 JS/CSS/HTML 해시의 해시로 바꿔 쓴다 → 어느 파일이든 바뀌면 SW 가 새 버전으로 설치된다
 *   파일의 mtime 이 바뀌면 해시를 다시 계산한다(배포 후 재시작 없이도 반영).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function create(publicDir) {
    const cache = new Map();   // rel path → { mtimeMs, size, hash }
    function hashOf(rel) {
        const p = path.join(publicDir, rel);
        let st; try { st = fs.statSync(p); } catch (e) { return null; }
        const c = cache.get(rel);
        if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.hash;
        const hash = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex').slice(0, 10);
        cache.set(rel, { mtimeMs: st.mtimeMs, size: st.size, hash });
        return hash;
    }
    /** HTML 안의 ?v= 를 파일 해시로 */
    function stampHtml(html) {
        return String(html).replace(/((?:src|href)=["'])([^"']+?\.(?:js|css))\?v=[^"'&]*/g, (m, pre, file) => {
            const rel = file.replace(/^\//, '').replace(/^\.\//, '');
            const h = hashOf(rel);
            return h ? `${pre}${file}?v=${h}` : m;
        });
    }
    /** 서비스워커 CACHE_NAME 을 자원 전체 해시로 */
    function swCacheName() {
        const files = [];
        (function walk(dir, rel) {
            let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
            for (const e of ents) {
                if (e.name.startsWith('.')) continue;
                const r = rel ? rel + '/' + e.name : e.name;
                if (e.isDirectory()) { if (!/^(uploads|fonts|icons|node_modules)$/.test(e.name)) walk(path.join(dir, e.name), r); }
                else if (/\.(js|css|html)$/.test(e.name) && e.name !== 'sw.js') files.push(r);
            }
        })(publicDir, '');
        files.sort();
        const h = crypto.createHash('sha1');
        for (const f of files) h.update(f).update(':').update(hashOf(f) || '');
        return 'pacerise-' + h.digest('hex').slice(0, 10);
    }
    function stampSw(js) { return String(js).replace(/const CACHE_NAME = '[^']*';/, `const CACHE_NAME = '${swCacheName()}';`); }
    return { hashOf, stampHtml, stampSw, swCacheName };
}
module.exports = { create };
