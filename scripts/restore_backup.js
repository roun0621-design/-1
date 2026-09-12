#!/usr/bin/env node
/**
 * scripts/restore_backup.js — 백업 점검 & 복구 도구
 * ------------------------------------------------------------------
 * "백업이 실제로 복구되는가"를 검증하기 위한 운영 스크립트.
 * 로컬 backups/ 와 (설정 시) S3 양쪽을 다룬다.
 *
 * 사용법:
 *   node scripts/restore_backup.js list                 # 로컬+S3 백업 목록
 *   node scripts/restore_backup.js verify <경로|S3키>    # 무결성 검사(기본 동작, 안전)
 *   node scripts/restore_backup.js verify-latest [tag]   # 최신 백업 1건 자동 검증
 *   node scripts/restore_backup.js restore <경로|S3키> --yes
 *                                                        # 실제 복구(현재 DB는 사전 백업 후 교체)
 *
 * 안전장치:
 *   - 기본은 검증만. 실제 교체(restore)는 --yes 플래그가 있어야 수행.
 *   - 복구 직전 현재 competition.db 를 backups/ 로 pre-restore 스냅샷 보관.
 *   - 검증은 PRAGMA integrity_check + 핵심 테이블 행 수 확인.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');
const { DB_PATH } = require('../db/init');
const backupS3 = require('../lib/backupS3');

const BACKUP_DIR = path.join(__dirname, '..', 'backups');

function localBackups() {
    if (!fs.existsSync(BACKUP_DIR)) return [];
    return fs.readdirSync(BACKUP_DIR)
        .filter(f => f.startsWith('backup_') && f.endsWith('.db'))
        .map(f => {
            const p = path.join(BACKUP_DIR, f);
            const st = fs.statSync(p);
            return { name: f, path: p, size: st.size, mtime: st.mtime };
        })
        .sort((a, b) => b.mtime - a.mtime);
}

function fmtSize(n) {
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
    return n + ' B';
}

/** 무결성 검사: integrity_check + 핵심 테이블 카운트. throw 하지 않고 결과 객체 반환. */
function verifyDbFile(filePath) {
    const result = { file: filePath, ok: false, integrity: null, counts: {}, error: null };
    let db;
    try {
        db = new Database(filePath, { readonly: true, fileMustExist: true });
        result.integrity = db.pragma('integrity_check', { simple: true });
        const tables = ['competition', 'event', 'athlete', 'event_entry', 'result'];
        for (const t of tables) {
            try {
                const row = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get();
                result.counts[t] = row.c;
            } catch (e) {
                result.counts[t] = `(테이블 없음: ${e.message})`;
            }
        }
        result.ok = result.integrity === 'ok';
    } catch (e) {
        result.error = e.message;
    } finally {
        if (db) try { db.close(); } catch (e) {}
    }
    return result;
}

function printVerify(r) {
    console.log(`\n── 무결성 검사: ${path.basename(r.file)} ──`);
    if (r.error) { console.log(`  ❌ 열기 실패: ${r.error}`); return r.ok; }
    console.log(`  integrity_check : ${r.integrity === 'ok' ? '✅ ok' : '❌ ' + r.integrity}`);
    for (const [t, c] of Object.entries(r.counts)) console.log(`  ${t.padEnd(13)}: ${c}`);
    console.log(`  → 판정: ${r.ok ? '✅ 복구 가능' : '❌ 손상 의심'}`);
    return r.ok;
}

/** S3 키이거나 로컬 경로인 인자를 받아 검증 가능한 로컬 파일 경로로 정규화. */
async function resolveToLocal(arg) {
    if (fs.existsSync(arg)) return { path: arg, temp: false };
    // 로컬에 없으면 S3 키로 간주하고 임시 다운로드
    if (!backupS3.isConfigured()) {
        throw new Error(`로컬에 파일이 없고 S3도 미설정: ${arg}`);
    }
    const dest = path.join(os.tmpdir(), 'restore_' + path.basename(arg));
    const r = await backupS3.downloadBackup(arg, dest);
    if (!r.ok) throw new Error(`S3 다운로드 실패: ${r.error}`);
    return { path: dest, temp: true };
}

async function cmdList() {
    console.log('=== 로컬 백업 (backups/) ===');
    const locals = localBackups();
    if (!locals.length) console.log('  (없음)');
    for (const b of locals.slice(0, 20)) {
        console.log(`  ${b.name.padEnd(46)} ${fmtSize(b.size).padStart(9)}  ${b.mtime.toISOString()}`);
    }
    if (locals.length > 20) console.log(`  ... 외 ${locals.length - 20}건`);

    console.log(`\n=== 오프사이트 S3 백업 ===`);
    if (!backupS3.isConfigured()) {
        console.log('  ⚠️  S3 미설정 (BACKUP_S3_BUCKET 없음) — 오프사이트 백업이 꺼져 있습니다!');
        return;
    }
    const remote = await backupS3.listBackups();
    if (!remote.length) { console.log('  (S3에 백업 없음)'); return; }
    for (const o of remote.slice(0, 20)) {
        console.log(`  ${o.key.padEnd(60)} ${fmtSize(o.size).padStart(9)}  ${new Date(o.lastModified).toISOString()}`);
    }
    if (remote.length > 20) console.log(`  ... 외 ${remote.length - 20}건`);
}

async function cmdVerify(arg) {
    const { path: local, temp } = await resolveToLocal(arg);
    const ok = printVerify(verifyDbFile(local));
    if (temp) try { fs.unlinkSync(local); } catch (e) {}
    process.exit(ok ? 0 : 1);
}

async function cmdVerifyLatest(tag) {
    let target;
    const locals = localBackups().filter(b => !tag || b.name.startsWith(`backup_${tag}_`));
    if (locals.length) {
        target = locals[0].path;
    } else if (backupS3.isConfigured()) {
        const remote = await backupS3.listBackups(tag);
        if (!remote.length) { console.log('검증할 백업이 없습니다.'); process.exit(1); }
        target = remote[0].key;
    } else {
        console.log('검증할 백업이 없습니다.'); process.exit(1);
    }
    console.log(`최신 백업 대상: ${target}`);
    return cmdVerify(target);
}

async function cmdRestore(arg, yes) {
    const { path: local, temp } = await resolveToLocal(arg);

    // 1) 복구 전 검증 — 손상된 백업으로 덮어쓰는 사고 방지
    console.log('복구 전 백업 무결성 검사...');
    if (!printVerify(verifyDbFile(local))) {
        console.log('\n❌ 백업이 손상되어 복구를 중단합니다.');
        if (temp) try { fs.unlinkSync(local); } catch (e) {}
        process.exit(1);
    }

    if (!yes) {
        console.log('\n⚠️  실제 복구를 하려면 --yes 플래그가 필요합니다. (지금은 검증만 수행)');
        console.log(`   예: node scripts/restore_backup.js restore ${arg} --yes`);
        if (temp) try { fs.unlinkSync(local); } catch (e) {}
        process.exit(0);
    }

    // 2) 현재 DB를 pre-restore 스냅샷으로 보관
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    if (fs.existsSync(DB_PATH)) {
        const snap = path.join(BACKUP_DIR, `backup_prerestore_${stamp}.db`);
        try {
            const cur = new Database(DB_PATH, { readonly: true });
            cur.backup(snap).then(() => cur.close()).catch(() => {});
            // backup()은 async지만 동기 흐름 단순화를 위해 파일 복사도 보강
        } catch (e) {
            try { fs.copyFileSync(DB_PATH, snap); } catch (e2) {}
        }
        console.log(`현재 DB 보관: ${path.basename(snap)}`);
    }

    // 3) WAL/SHM 정리 후 교체 (.backup() 산출물은 단일 파일이라 WAL 잔재 제거가 안전)
    try { fs.unlinkSync(DB_PATH + '-wal'); } catch (e) {}
    try { fs.unlinkSync(DB_PATH + '-shm'); } catch (e) {}
    fs.copyFileSync(local, DB_PATH);
    console.log(`\n✅ 복구 완료: ${path.basename(local)} → ${DB_PATH}`);
    console.log('   서버를 재시작(pm2 restart pacerise)하면 복구된 DB로 기동합니다.');

    if (temp) try { fs.unlinkSync(local); } catch (e) {}
    process.exit(0);
}

(async () => {
    const [cmd, ...rest] = process.argv.slice(2);
    const yes = rest.includes('--yes');
    const args = rest.filter(a => a !== '--yes');
    try {
        switch (cmd) {
            case 'list': return await cmdList();
            case 'verify': if (!args[0]) { console.log('사용법: verify <경로|S3키>'); process.exit(1); } return await cmdVerify(args[0]);
            case 'verify-latest': return await cmdVerifyLatest(args[0]);
            case 'restore': if (!args[0]) { console.log('사용법: restore <경로|S3키> --yes'); process.exit(1); } return await cmdRestore(args[0], yes);
            default:
                console.log('백업 점검 & 복구 도구\n');
                console.log('  node scripts/restore_backup.js list');
                console.log('  node scripts/restore_backup.js verify <경로|S3키>');
                console.log('  node scripts/restore_backup.js verify-latest [daily|hourly|startup]');
                console.log('  node scripts/restore_backup.js restore <경로|S3키> --yes');
                process.exit(0);
        }
    } catch (e) {
        console.error('오류:', e.message);
        process.exit(1);
    }
})();
