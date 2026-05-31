/**
 * 통백업 / 통복원 API 회귀 테스트 (SQLite only)
 *
 * 보호하는 것:
 *  - GET  /api/admin/full-backup/download  → ZIP 다운로드 (admin_key 필수)
 *  - POST /api/admin/full-backup/preview   → ZIP 메타 확인 (admin_key 필수)
 *
 * 복원(restore)은 process.exit(0) 을 호출해 vitest 자체를 죽이므로 여기서는 테스트하지 않음.
 * → 별도 E2E 스크립트(PM2 환경)에서만 수행. 이미 수동 검증 완료(May 30, 4→5→4 cycle).
 *
 * 시나리오:
 *  1) 인증 없이 호출 → 403
 *  2) 정상 admin_key 로 다운로드 → 200 + ZIP 매직넘버 (PK\x03\x04)
 *  3) 다운로드한 ZIP 을 preview 로 다시 업로드 → manifest 검증
 */
const request = require('supertest');
const path = require('path');
const fs = require('fs');
const os = require('os');

let app;
const ADMIN_KEY = 'testadmin1234'; // global-setup.js 의 ADMIN_PW 와 동일해야 함

beforeAll(async () => {
    app = require('../../server.js').app;
});

describe('Full Backup API — 회귀', () => {

    it('인증 없이 다운로드 시도 → 403', async () => {
        const res = await request(app).get('/api/admin/full-backup/download');
        expect(res.status).toBe(403);
    });

    it('잘못된 admin_key → 403', async () => {
        const res = await request(app)
            .get('/api/admin/full-backup/download')
            .query({ key: 'wrong_key_xyz' });
        expect(res.status).toBe(403);
    });

    it('정상 admin_key 로 ZIP 다운로드 → 200 + PK 매직넘버', async () => {
        const res = await request(app)
            .get('/api/admin/full-backup/download')
            .query({ key: ADMIN_KEY })
            .buffer(true)
            .parse((res, cb) => {
                // binary 응답을 Buffer 로 받음 (supertest 는 기본적으로 text)
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => cb(null, Buffer.concat(chunks)));
            });

        expect(res.status).toBe(200);
        const body = res.body;
        // ZIP 시그니처: 0x50 0x4b 0x03 0x04
        expect(body.length).toBeGreaterThan(100);
        expect(body[0]).toBe(0x50); // 'P'
        expect(body[1]).toBe(0x4b); // 'K'
        expect(body[2]).toBe(0x03);
        expect(body[3]).toBe(0x04);

        // 후속 preview 테스트용으로 임시 저장
        const tmpZip = path.join(os.tmpdir(), `pacerise-test-backup-${Date.now()}.zip`);
        fs.writeFileSync(tmpZip, body);
        global.__testBackupZipPath = tmpZip;
    });

    it('다운로드한 ZIP 을 preview 로 검증 → manifest OK', async () => {
        const zipPath = global.__testBackupZipPath;
        expect(zipPath).toBeDefined();
        expect(fs.existsSync(zipPath)).toBe(true);

        const res = await request(app)
            .post('/api/admin/full-backup/preview')
            .field('admin_key', ADMIN_KEY)
            .attach('file', zipPath);

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('ok', true);
        expect(res.body).toHaveProperty('manifest');
        expect(res.body).toHaveProperty('db_present', true);
        expect(res.body.entries_count).toBeGreaterThan(0);
        const m = res.body.manifest;
        expect(m.db_backend).toBe('sqlite');
        expect(m.version).toBeDefined();
        expect(m.created_at).toBeDefined();
    });
});
