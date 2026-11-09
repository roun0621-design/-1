#!/usr/bin/env node
/**
 * scripts/s3_upload.js — 임의 파일 1개를 S3로 업로드하는 CLI 업로더
 * ------------------------------------------------------------------
 * 기존 bash 백업 스크립트(backup_rds.sh)가 만든 .dump 파일을
 * .env 의 AWS 자격증명을 재사용해 S3로 올리기 위한 얇은 래퍼.
 * (aws CLI 불필요 — 이미 설치된 @aws-sdk/client-s3 + lib/backupS3 재사용)
 *
 * 사용:
 *   node scripts/s3_upload.js <파일경로> [키프리픽스]
 *   예: node scripts/s3_upload.js /home/ubuntu/backups/daily/x.dump rds-daily
 *
 * 종료코드: 0=성공, 1=실패 (호출하는 bash 에서 if 로 분기 가능)
 */

'use strict';

const path = require('path');
// cron/타 디렉토리에서 호출돼도 .env 를 확실히 찾도록 절대경로 지정
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const backupS3 = require('../lib/backupS3');

(async () => {
    const file = process.argv[2];
    const prefix = process.argv[3] || 'misc';

    if (!file) {
        console.error('사용법: node s3_upload.js <파일경로> [키프리픽스]');
        process.exit(1);
    }
    if (!backupS3.isConfigured()) {
        console.error('[s3_upload] ❌ BACKUP_S3_BUCKET 미설정 — .env 확인');
        process.exit(1);
    }

    const r = await backupS3.uploadFile(file, prefix);
    if (r.ok) {
        console.log('[s3_upload] ✅ OK:', r.key);
        process.exit(0);
    }
    console.error('[s3_upload] ❌ 실패:', r.error || (r.skipped ? 'skipped' : 'unknown'));
    process.exit(1);
})();
