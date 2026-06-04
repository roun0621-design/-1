#!/usr/bin/env node
/**
 * scripts/pg_backup.js — PostgreSQL(RDS) 논리 백업 → S3 업로드
 * ------------------------------------------------------------------
 * RDS 자동 백업(7일)을 보완하는 "추가 안전망":
 *   - pg_dump 로 DB 전체를 떠서 gzip 압축
 *   - 방금 만든 S3 버킷에 업로드 (오프사이트·장기보관·이식용)
 *   - 로컬 사본은 backups/pg/ 에 단기 보관(기본 7일) 후 정리
 *
 * RDS 자동백업이 못 막는 것을 메움:
 *   - RDS 인스턴스 자체 삭제 사고
 *   - 7일보다 오래된 시점(시즌 아카이브)
 *   - 다른 서버/로컬로 이식·복원
 *
 * 필요 .env:
 *   DATABASE_URL          (필수) — pg_dump 접속 (앱과 동일)
 *   BACKUP_S3_BUCKET      (필수) — 없으면 로컬 백업만 하고 경고
 *   BACKUP_S3_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY  — S3 자격
 *   PG_BACKUP_LOCAL_DAYS  (선택) — 로컬 보관일, 기본 7
 *
 * 사용:
 *   node scripts/pg_backup.js          # 백업 1회 실행 (cron 으로 매일 호출)
 *
 * 복원(참고):
 *   gunzip -c backups/pg/<파일>.sql.gz | psql "$DATABASE_URL"
 *   (보통 빈 DB 또는 새 DB 에 복원. 운영 DB 덮어쓰기는 신중히)
 */

'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');
const backupS3 = require('../lib/backupS3');

const DATABASE_URL = process.env.DATABASE_URL;
const LOCAL_DAYS = parseInt(process.env.PG_BACKUP_LOCAL_DAYS || '7', 10);
const OUT_DIR = path.join(__dirname, '..', 'backups', 'pg');

function tsStamp() {
    // KST(UTC+9) 기준 YYYY-MM-DD-HH-MM-SS
    const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
    return d.toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

function pruneLocal() {
    try {
        const cutoff = Date.now() - LOCAL_DAYS * 24 * 60 * 60 * 1000;
        for (const f of fs.readdirSync(OUT_DIR)) {
            if (!f.endsWith('.sql.gz')) continue;
            const fp = path.join(OUT_DIR, f);
            if (fs.statSync(fp).mtimeMs < cutoff) {
                fs.unlinkSync(fp);
                console.log(`[PgBackup] 오래된 로컬 백업 삭제: ${f}`);
            }
        }
    } catch (e) { /* 디렉토리 없으면 무시 */ }
}

/**
 * node-postgres 는 sslmode=no-verify 를 이해하지만 libpq(pg_dump)는 거부한다.
 * SSL 연결은 유지하되 인증서 검증만 생략하는 libpq 등가값은 'require'.
 */
function sanitizeUrlForPgDump(url) {
    return url.replace(/sslmode=no-verify/gi, 'sslmode=require');
}

/** pg_dump → gzip → 파일. 성공 시 파일 경로 반환(Promise). */
function dumpToFile(filePath) {
    return new Promise((resolve, reject) => {
        // --no-owner / --no-privileges: 다른 DB·롤로 복원해도 깨지지 않게
        const args = [sanitizeUrlForPgDump(DATABASE_URL), '--no-owner', '--no-privileges'];
        const dump = spawn('pg_dump', args, { env: process.env });

        const gzip = zlib.createGzip();
        const out = fs.createWriteStream(filePath);
        let stderr = '';
        let dumpCode = null;

        dump.stderr.on('data', d => { stderr += d.toString(); });
        dump.on('error', err => reject(new Error(`pg_dump 실행 실패: ${err.message}`)));
        dump.on('close', code => { dumpCode = code; });

        dump.stdout.pipe(gzip).pipe(out);

        out.on('error', err => reject(err));
        out.on('finish', () => {
            if (dumpCode !== 0) {
                // 실패한 부분 파일 제거
                try { fs.unlinkSync(filePath); } catch (e) {}
                return reject(new Error(`pg_dump 비정상 종료(code=${dumpCode}): ${stderr.trim()}`));
            }
            resolve(filePath);
        });
    });
}

(async () => {
    if (!DATABASE_URL) {
        console.error('[PgBackup] ❌ DATABASE_URL 이 없습니다 (.env 확인). PG 백업은 PostgreSQL 환경 전용입니다.');
        process.exit(1);
    }

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const file = path.join(OUT_DIR, `pacerise_pg_${tsStamp()}.sql.gz`);

    console.log('[PgBackup] pg_dump 시작...');
    try {
        await dumpToFile(file);
    } catch (e) {
        console.error('[PgBackup] ❌ 덤프 실패:', e.message);
        process.exit(1);
    }

    const sizeKB = (fs.statSync(file).size / 1024).toFixed(1);
    if (parseFloat(sizeKB) < 1) {
        console.error(`[PgBackup] ⚠️  덤프 파일이 비정상적으로 작습니다(${sizeKB}KB). 백업 실패 의심.`);
        process.exit(1);
    }
    console.log(`[PgBackup] ✅ 로컬 백업 완료: ${path.basename(file)} (${sizeKB}KB)`);

    // S3 업로드 (설정 시에만)
    if (backupS3.isConfigured()) {
        const r = await backupS3.uploadBackup(file, 'pg');
        if (r.ok) console.log(`[PgBackup] ✅ S3 업로드 완료: ${r.key}`);
        else console.error('[PgBackup] ⚠️  S3 업로드 실패(로컬 백업은 보존됨):', r.error || r.skipped);
    } else {
        console.warn('[PgBackup] ⚠️  BACKUP_S3_BUCKET 미설정 — 오프사이트 업로드 건너뜀(로컬만).');
    }

    pruneLocal();
    console.log('[PgBackup] 완료.');
    process.exit(0);
})();
