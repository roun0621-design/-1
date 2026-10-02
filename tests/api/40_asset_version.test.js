/**
 * 캐시 버전 자동화 — HTML 의 ?v= 와 sw.js 의 CACHE_NAME 이 파일 내용 해시로 나간다
 */
const request = require('supertest');
const fs = require('fs'), path = require('path'), crypto = require('crypto');
let app;
beforeAll(async () => { app = require('../../server.js').app; });
const PUB = path.join(__dirname, '..', '..', 'public');
const sha = f => crypto.createHash('sha1').update(fs.readFileSync(path.join(PUB, f))).digest('hex').slice(0, 10);

describe('자원 버전', () => {
    it('HTML 의 common.js?v= 가 손으로 적은 번호가 아니라 파일 해시', async () => {
        const r = await request(app).get('/dashboard.html');
        expect(r.status).toBe(200);
        const m = r.text.match(/common\.js\?v=([0-9a-f]{10})/);
        expect(m && m[1]).toBe(sha('common.js'));
        expect(r.text).toMatch(new RegExp(`dashboard\\.js\\?v=${sha('dashboard.js')}`));
        expect(r.text).toMatch(new RegExp(`styles\\.css\\?v=${sha('styles.css')}`));
        expect(r.headers['cache-control']).toContain('no-store');
    });
    it('/ 와 /e/<slug> 도 같은 처리', async () => {
        expect((await request(app).get('/')).text).toMatch(new RegExp(`common\\.js\\?v=${sha('common.js')}`));
        const e = await request(app).get('/e/some-slug');
        expect(e.status).toBe(200); expect(e.text).toMatch(new RegExp(`dashboard\\.js\\?v=${sha('dashboard.js')}`));
    });
    it('sw.js 의 CACHE_NAME 은 자원 전체 해시 — 한 파일이 바뀌면 이름이 바뀐다', async () => {
        const r = await request(app).get('/sw.js');
        const m = r.text.match(/const CACHE_NAME = 'pacerise-([0-9a-f]{10})';/);
        expect(m).toBeTruthy();
        const { create } = require('../../lib/assetVersion');
        const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'av-')); fs.writeFileSync(path.join(tmp, 'a.js'), 'x'); fs.writeFileSync(path.join(tmp, 'sw.js'), "const CACHE_NAME = 'pacerise-v1';");
        const av = create(tmp); const n1 = av.swCacheName();
        fs.writeFileSync(path.join(tmp, 'a.js'), 'y'); const later = Date.now() / 1000 + 5; fs.utimesSync(path.join(tmp, 'a.js'), later, later);
        expect(av.swCacheName()).not.toBe(n1);
        expect(av.stampSw(fs.readFileSync(path.join(tmp, 'sw.js'), 'utf8'))).toContain(`const CACHE_NAME = '${av.swCacheName()}';`);
    });
    it('open.html 은 iOS 앱에서 홈으로 우회하는 기존 동작 유지', async () => {
        const r = await request(app).get('/open.html').set('User-Agent', 'PWAShell/1.0');
        expect(r.status).toBe(302);
    });
});
