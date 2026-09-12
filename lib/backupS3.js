/**
 * lib/backupS3.js — 오프사이트(원격) 백업: AWS S3 업로드/조회/다운로드
 * ------------------------------------------------------------------
 * 목적: 로컬 backups/ 폴더에만 쌓이던 백업을 S3로도 복제해서
 *       EC2 인스턴스/디스크가 소실돼도 백업이 함께 날아가지 않게 한다.
 *
 * 설정(.env):
 *   BACKUP_S3_BUCKET   (필수) — 이 값이 없으면 모듈 전체가 "비활성(no-op)"
 *   BACKUP_S3_PREFIX   (선택) — 키 접두사, 기본 'pacerise-backups/'
 *   BACKUP_S3_REGION   (선택) — 리전, 없으면 AWS_REGION, 그것도 없으면 'ap-northeast-2'
 *   BACKUP_S3_SSE      (선택) — 서버측 암호화, 기본 'AES256' ('aws:kms'도 가능, 'off'면 끔)
 *   자격증명           — EC2 IAM 역할(권장) 또는 표준 AWS 환경변수(AWS_ACCESS_KEY_ID 등)
 *
 * 설계 원칙:
 *   - BACKUP_S3_BUCKET 미설정 시 모든 함수가 조용히 no-op → 개발/테스트 환경 무영향.
 *   - SDK require 를 지연(lazy) 처리 → 미설치 상태라도 서버 부팅이 깨지지 않음.
 *   - 업로드 실패가 로컬 백업 흐름을 막지 않도록 호출부는 fire-and-forget 로 쓴다.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const BUCKET = process.env.BACKUP_S3_BUCKET || '';
const PREFIX = (process.env.BACKUP_S3_PREFIX || 'pacerise-backups/').replace(/^\/+/, '');
const REGION = process.env.BACKUP_S3_REGION || process.env.AWS_REGION || 'ap-northeast-2';
const SSE_RAW = (process.env.BACKUP_S3_SSE || 'AES256').trim();
const SSE = SSE_RAW.toLowerCase() === 'off' ? null : SSE_RAW;

let _client = null;        // 지연 초기화된 S3Client
let _sdk = null;           // 지연 require 된 @aws-sdk/client-s3
let _disabledReason = null; // 비활성 사유(1회만 로깅)

function isConfigured() {
    return !!BUCKET;
}

function _warnOnce(reason) {
    if (_disabledReason === reason) return;
    _disabledReason = reason;
    console.warn(`[BackupS3] 비활성: ${reason}`);
}

/** 지연 초기화. 실패하면 null 반환(호출부는 no-op 처리). */
function _getClient() {
    if (!isConfigured()) { _warnOnce('BACKUP_S3_BUCKET 미설정 — 오프사이트 백업 꺼짐'); return null; }
    if (_client) return _client;
    try {
        _sdk = _sdk || require('@aws-sdk/client-s3');
        _client = new _sdk.S3Client({ region: REGION });
        console.log(`[BackupS3] 활성화 — s3://${BUCKET}/${PREFIX} (region=${REGION}, sse=${SSE || 'off'})`);
        return _client;
    } catch (e) {
        _warnOnce(`@aws-sdk/client-s3 로드 실패 (${e.message}) — npm install 필요`);
        return null;
    }
}

/** 로컬 백업 파일명 → S3 키. 예: backup_hourly_2026-06-04-21-00-00.db → prefix/hourly/2026-06-04/<name> */
function _keyFor(filePath, tag) {
    const base = path.basename(filePath);
    // 파일명에서 날짜(YYYY-MM-DD) 추출해 날짜별 폴더로 정리
    const m = base.match(/(\d{4}-\d{2}-\d{2})/);
    const dateFolder = m ? m[1] : 'misc';
    return `${PREFIX}${tag}/${dateFolder}/${base}`;
}

/**
 * 백업 파일 1개를 S3로 업로드. (.backup() 산출물은 단일 .db 파일이라 한 번이면 충분)
 * @returns {Promise<{ok:boolean, key?:string, skipped?:boolean, error?:string}>}
 */
async function uploadBackup(filePath, tag = 'manual') {
    const client = _getClient();
    if (!client) return { ok: false, skipped: true };
    if (!fs.existsSync(filePath)) return { ok: false, error: `파일 없음: ${filePath}` };

    const key = _keyFor(filePath, tag);
    try {
        const body = fs.readFileSync(filePath);
        const params = { Bucket: BUCKET, Key: key, Body: body };
        if (SSE) params.ServerSideEncryption = SSE;
        await client.send(new _sdk.PutObjectCommand(params));
        console.log(`[BackupS3] 업로드 완료: s3://${BUCKET}/${key} (${body.length} bytes)`);
        return { ok: true, key };
    } catch (e) {
        console.error(`[BackupS3] 업로드 실패 (${key}):`, e.message);
        return { ok: false, error: e.message };
    }
}

/**
 * 임의의 파일 1개를 S3로 업로드 (포맷 무관 — 예: backup_rds.sh 의 .dump 파일).
 * 키 = `${PREFIX}${keyPrefix}/${파일명}`. 파일명에 타임스탬프가 있으면 정렬됨.
 * @returns {Promise<{ok:boolean, key?:string, skipped?:boolean, error?:string}>}
 */
async function uploadFile(filePath, keyPrefix = 'misc') {
    const client = _getClient();
    if (!client) return { ok: false, skipped: true };
    if (!fs.existsSync(filePath)) return { ok: false, error: `파일 없음: ${filePath}` };

    const cleanPrefix = String(keyPrefix).replace(/^\/+|\/+$/g, '');
    const key = `${PREFIX}${cleanPrefix}/${path.basename(filePath)}`;
    try {
        const body = fs.readFileSync(filePath);
        const params = { Bucket: BUCKET, Key: key, Body: body };
        if (SSE) params.ServerSideEncryption = SSE;
        await client.send(new _sdk.PutObjectCommand(params));
        console.log(`[BackupS3] 업로드 완료: s3://${BUCKET}/${key} (${body.length} bytes)`);
        return { ok: true, key };
    } catch (e) {
        console.error(`[BackupS3] 업로드 실패 (${key}):`, e.message);
        return { ok: false, error: e.message };
    }
}

/**
 * S3에 올라간 백업 목록 조회 (복구 스크립트용).
 * @param {string} [tag] — 'daily'|'hourly'|'startup'|'manual'; 생략 시 전체
 * @returns {Promise<Array<{key, size, lastModified}>>}
 */
async function listBackups(tag) {
    const client = _getClient();
    if (!client) return [];
    const Prefix = tag ? `${PREFIX}${tag}/` : PREFIX;
    const out = [];
    let ContinuationToken;
    try {
        do {
            const resp = await client.send(new _sdk.ListObjectsV2Command({ Bucket: BUCKET, Prefix, ContinuationToken }));
            for (const o of resp.Contents || []) {
                if (o.Key.endsWith('.db')) out.push({ key: o.Key, size: o.Size, lastModified: o.LastModified });
            }
            ContinuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
        } while (ContinuationToken);
    } catch (e) {
        console.error('[BackupS3] 목록 조회 실패:', e.message);
    }
    out.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
    return out;
}

/**
 * S3 객체를 로컬 파일로 다운로드 (복구 스크립트용).
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function downloadBackup(key, destPath) {
    const client = _getClient();
    if (!client) return { ok: false, error: 'S3 비활성' };
    try {
        const resp = await client.send(new _sdk.GetObjectCommand({ Bucket: BUCKET, Key: key }));
        await new Promise((resolve, reject) => {
            const ws = fs.createWriteStream(destPath);
            resp.Body.on('error', reject);
            ws.on('error', reject);
            ws.on('finish', resolve);
            resp.Body.pipe(ws);
        });
        console.log(`[BackupS3] 다운로드 완료: ${key} → ${destPath}`);
        return { ok: true };
    } catch (e) {
        console.error(`[BackupS3] 다운로드 실패 (${key}):`, e.message);
        return { ok: false, error: e.message };
    }
}

module.exports = { isConfigured, uploadBackup, uploadFile, listBackups, downloadBackup, _config: { BUCKET, PREFIX, REGION, SSE } };
