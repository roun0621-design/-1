'use strict';
/**
 * 관리자 백업·복원(DB 초기화·JSON 백업·파일 백업 상태/트리거·전체 백업 다운로드/미리보기/복원) — server.js 에서 이동 (2026-09-22, Phase 4 분해). 동작은 인라인 시절과 같다.
 *   deps: BACKUP_DIR, BACKUP_MAX_DAYS, DB_PATH, UPLOAD_TMP, XLSX, _applyJwtBridge, backupS3, db, fs, isAdminKey, isOperationKey, multer, path, performBackup
 */
module.exports = function mountAdminBackupRoutes(app, deps) {
    const { BACKUP_DIR, BACKUP_MAX_DAYS, DB_PATH, UPLOAD_TMP, XLSX, _applyJwtBridge, backupS3, db, fs, isAdminKey, isOperationKey, multer, path, performBackup } = deps;
    for (const k of ["BACKUP_DIR","BACKUP_MAX_DAYS","DB_PATH","UPLOAD_TMP","XLSX","_applyJwtBridge","backupS3","db","fs","isAdminKey","isOperationKey","multer","path","performBackup"]) if (deps[k] === undefined) throw new Error('[admin_backup.js] mount requires deps.' + k);

    // ADMIN: DB RESET (per competition)
    // ============================================================
    app.post('/api/admin/reset-db', async (req, res) => {
        const { admin_key, competition_id } = req.body;
        if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        if (!competition_id) return res.status(400).json({ error: 'competition_id required' });
        await db.transaction(async () => {
            const events = await db.all('SELECT id FROM event WHERE competition_id=?', competition_id);
            for (const evt of events) {
                const heats = await db.all('SELECT id FROM heat WHERE event_id=?', evt.id);
                for (const h of heats) { await db.run('DELETE FROM result WHERE heat_id=?', h.id); await db.run('DELETE FROM height_attempt WHERE heat_id=?', h.id); await db.run('DELETE FROM heat_entry WHERE heat_id=?', h.id); }
                await db.run('DELETE FROM heat WHERE event_id=?', evt.id);
                await db.run('DELETE FROM relay_member WHERE event_entry_id IN (SELECT id FROM event_entry WHERE event_id=?)', evt.id);
                await db.run('DELETE FROM combined_score WHERE event_entry_id IN (SELECT id FROM event_entry WHERE event_id=?)', evt.id);
                await db.run('DELETE FROM qualification_selection WHERE event_id=?', evt.id);
                await db.run('DELETE FROM event_entry WHERE event_id=?', evt.id);
            }
            await db.run('DELETE FROM event WHERE competition_id=?', competition_id);
            await db.run('DELETE FROM athlete WHERE competition_id=?', competition_id);
        })();
        res.json({ success: true, message: '해당 대회 데이터가 초기화되었습니다.' });
    });

    // ============================================================
    // ADMIN: BACKUP
    // ============================================================
    app.get('/api/admin/backup', async (req, res) => {
        if (!isOperationKey(req.query.key)) return res.status(403).json({ error: '운영키가 필요합니다.' });
        const format = req.query.format || 'json';
        const compId = req.query.competition_id;
        const tables = ['competition','event','athlete','event_entry','heat','heat_entry','result','height_attempt','combined_score','qualification_selection','relay_member','audit_log','operation_log'];
        const backup = {};
        for (const t of tables) {
            try {
                if (compId && t !== 'operation_log' && t !== 'audit_log') {
                    // Scoped backup: filter by competition_id where possible
                    if (t === 'competition') backup[t] = await db.all('SELECT * FROM competition WHERE id=?', compId);
                    else if (t === 'event') backup[t] = await db.all('SELECT * FROM event WHERE competition_id=?', compId);
                    else if (t === 'athlete') backup[t] = await db.all('SELECT * FROM athlete WHERE competition_id=?', compId);
                    else if (t === 'event_entry') backup[t] = await db.all('SELECT ee.* FROM event_entry ee JOIN event e ON ee.event_id=e.id WHERE e.competition_id=?', compId);
                    else if (t === 'heat') backup[t] = await db.all('SELECT h.* FROM heat h JOIN event e ON h.event_id=e.id WHERE e.competition_id=?', compId);
                    else if (t === 'heat_entry') backup[t] = await db.all('SELECT he.* FROM heat_entry he JOIN heat h ON he.heat_id=h.id JOIN event e ON h.event_id=e.id WHERE e.competition_id=?', compId);
                    else if (t === 'result') backup[t] = await db.all('SELECT r.* FROM result r JOIN heat h ON r.heat_id=h.id JOIN event e ON h.event_id=e.id WHERE e.competition_id=?', compId);
                    else if (t === 'height_attempt') backup[t] = await db.all('SELECT ha.* FROM height_attempt ha JOIN heat h ON ha.heat_id=h.id JOIN event e ON h.event_id=e.id WHERE e.competition_id=?', compId);
                    else if (t === 'combined_score') backup[t] = await db.all('SELECT cs.* FROM combined_score cs JOIN event_entry ee ON cs.event_entry_id=ee.id JOIN event e ON ee.event_id=e.id WHERE e.competition_id=?', compId);
                    else if (t === 'qualification_selection') backup[t] = await db.all('SELECT qs.* FROM qualification_selection qs JOIN event e ON qs.event_id=e.id WHERE e.competition_id=?', compId);
                    else if (t === 'relay_member') backup[t] = await db.all('SELECT rm.* FROM relay_member rm JOIN event_entry ee ON rm.event_entry_id=ee.id JOIN event e ON ee.event_id=e.id WHERE e.competition_id=?', compId);
                    else backup[t] = await db.all(`SELECT * FROM ${t}`);
                } else {
                    backup[t] = await db.all(`SELECT * FROM ${t}`);
                }
            } catch(e) { backup[t] = []; }
        }
        backup._timestamp = new Date().toISOString();

        if (format === 'xlsx') {
            // Excel format: each table as a sheet
            const wb = XLSX.utils.book_new();
            for (const [name, rows] of Object.entries(backup)) {
                if (name === '_timestamp' || !Array.isArray(rows) || rows.length === 0) continue;
                const ws = XLSX.utils.json_to_sheet(rows);
                XLSX.utils.book_append_sheet(wb, ws, name.substring(0, 31));
            }
            const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename="pace-rise-backup-${new Date().toISOString().slice(0,10)}.xlsx"`);
            return res.send(buf);
        }

        // Default JSON
        res.setHeader('Content-Disposition', `attachment; filename="pace-rise-backup-${new Date().toISOString().slice(0,10)}.json"`);
        res.json(backup);
    });

    // ─── 파일 백업 (.db dump) 상태 조회 & 수동 트리거 ───────────────────────────
    // performBackup() 로 만들어진 backups/*.db 들의 현황을 조회/관리.
    // daily/hourly/startup/live/manual 태그별 통계, 최근 백업 목록, 다음 예정 시각 등.

    app.get('/api/admin/db-backup/status', (req, res) => {
        if (!isOperationKey(req.query.key)) return res.status(403).json({ error: '운영키가 필요합니다.' });
        try {
            const files = fs.readdirSync(BACKUP_DIR)
                .filter(f => f.startsWith('backup_') && f.endsWith('.db'))
                .map(f => {
                    const fpath = path.join(BACKUP_DIR, f);
                    const st = fs.statSync(fpath);
                    const m = f.match(/^backup_([^_]+)_(.+)\.db$/);
                    return {
                        name: f, tag: m ? m[1] : 'unknown',
                        size: st.size, mtime: st.mtime,
                        ageMs: Date.now() - st.mtimeMs
                    };
                })
                .sort((a, b) => b.mtime - a.mtime);

            const tagStats = {};
            for (const f of files) {
                if (!tagStats[f.tag]) tagStats[f.tag] = { count: 0, totalSize: 0, latest: null };
                tagStats[f.tag].count++;
                tagStats[f.tag].totalSize += f.size;
                if (!tagStats[f.tag].latest || f.mtime > new Date(tagStats[f.tag].latest)) {
                    tagStats[f.tag].latest = f.mtime;
                }
            }

            res.json({
                total_count: files.length,
                total_size_bytes: files.reduce((s, f) => s + f.size, 0),
                backup_dir: BACKUP_DIR,
                max_retention_days: BACKUP_MAX_DAYS,
                offsite_s3: backupS3.isConfigured(),      // false 면 서버 디스크가 유일한 사본
                final_snapshots: files.filter(f => /^final/.test(f.tag)).map(f => f.name),
                by_tag: tagStats,
                recent_10: files.slice(0, 10).map(f => ({
                    name: f.name, tag: f.tag,
                    size_kb: Math.round(f.size / 1024),
                    mtime: f.mtime,
                    age_minutes: Math.round(f.ageMs / 60000)
                })),
                health: {
                    daily_age_hours: tagStats.daily ? Math.round((Date.now() - new Date(tagStats.daily.latest)) / 3600000) : null,
                    hourly_age_minutes: tagStats.hourly ? Math.round((Date.now() - new Date(tagStats.hourly.latest)) / 60000) : null,
                    daily_ok: tagStats.daily && (Date.now() - new Date(tagStats.daily.latest)) < 25 * 60 * 60 * 1000,
                    hourly_ok: tagStats.hourly && (Date.now() - new Date(tagStats.hourly.latest)) < 70 * 60 * 1000
                }
            });
        } catch (e) {
            res.status(500).json({ error: '백업 상태 조회 실패: ' + e.message });
        }
    });

    app.post('/api/admin/db-backup/trigger', async (req, res) => {
        if (!isOperationKey(req.body.admin_key)) return res.status(403).json({ error: '운영키가 필요합니다.' });
        const tag = (req.body.tag || 'manual').replace(/[^a-z0-9]/gi, '').slice(0, 20) || 'manual';
        if (db.isAsync) return res.status(400).json({ error: 'PostgreSQL 모드에서는 파일 백업을 쓰지 않습니다 — RDS 자동 백업·스냅샷을 이용하세요.' });
        const file = await performBackup(tag);      // async — await 가 없어 path.basename(Promise) 로 항상 500 이었다
        if (!file) return res.status(500).json({ error: '백업 생성 실패' });
        res.json({ success: true, file: path.basename(file), tag });
    });

    // ============================================================
    // 통백업 / 통복원 (Full Snapshot Backup & Restore)
    // ------------------------------------------------------------
    // ZIP 안에 DB(competition.db + WAL/SHM) + public/uploads/ 전체 + manifest.json 을 묶음.
    // 복원은 매우 위험하므로:
    //   - 관리자 키 필수
    //   - 복원 직전 현재 상태를 자동으로 백업 (rollback 용)
    //   - 복원 후 서버 재시작이 권장됨 (DB 핸들 새로 열기 위해)
    // PostgreSQL 백엔드는 이 기능 미지원 (SQLite 파일 기반 전제)
    // ============================================================

    // 풀백업 전용 multer (큰 파일 허용, 최대 200MB)
    const _fullBackupUpload = multer({
        dest: UPLOAD_TMP,
        limits: { fileSize: 200 * 1024 * 1024 }
    });

    // 풀백업에 포함할 자산 디렉토리들 (DB 외부에 저장된 사용자 데이터)
    const _FULL_BACKUP_ASSET_DIRS = [
        { src: path.join(__dirname, 'public', 'uploads'), zipPrefix: 'public/uploads' },
        { src: path.join(__dirname, 'uploads'),           zipPrefix: 'uploads' },
    ];

    // GET /api/admin/full-backup/download
    // 통백업 ZIP 다운로드 — SQLite 파일 + 업로드 자산 + manifest.json
    app.get('/api/admin/full-backup/download', (req, res) => {
        if (db.isAsync) {
            return res.status(400).json({ error: '통백업/복원은 SQLite 백엔드 전용입니다. PostgreSQL 환경에선 외부 도구(pg_dump)를 사용하세요.' });
        }
        if (!isAdminKey(req.query.key)) return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        try {
            const AdmZip = require('adm-zip');
            const zip = new AdmZip();
            const manifest = {
                type: 'pace-rise-full-backup',
                version: 1,
                created_at: new Date().toISOString(),
                db_backend: 'sqlite',
                files: [],
            };

            // 1) DB 파일들 — 일관성 확보를 위해 WAL 체크포인트 후 복사
            try { db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch(_) {}
            const dbBase = path.basename(DB_PATH);
            if (fs.existsSync(DB_PATH)) {
                const buf = fs.readFileSync(DB_PATH);
                zip.addFile(`db/${dbBase}`, buf);
                manifest.files.push({ path: `db/${dbBase}`, size: buf.length, kind: 'sqlite-main' });
            }
            for (const ext of ['-wal', '-shm']) {
                const p = DB_PATH + ext;
                if (fs.existsSync(p)) {
                    const buf = fs.readFileSync(p);
                    zip.addFile(`db/${dbBase}${ext}`, buf);
                    manifest.files.push({ path: `db/${dbBase}${ext}`, size: buf.length, kind: 'sqlite' + ext });
                }
            }

            // 2) 자산 디렉토리들 — 재귀적으로 추가
            function _walk(dir, basePath, zipPrefix) {
                if (!fs.existsSync(dir)) return;
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const ent of entries) {
                    if (ent.name.startsWith('.')) continue; // .gitkeep 등 제외
                    const full = path.join(dir, ent.name);
                    const rel = path.relative(basePath, full).replace(/\\/g, '/');
                    const zipPath = `${zipPrefix}/${rel}`;
                    if (ent.isDirectory()) {
                        _walk(full, basePath, zipPrefix);
                    } else if (ent.isFile()) {
                        try {
                            const buf = fs.readFileSync(full);
                            zip.addFile(zipPath, buf);
                            manifest.files.push({ path: zipPath, size: buf.length, kind: 'asset' });
                        } catch(_) {}
                    }
                }
            }
            for (const asset of _FULL_BACKUP_ASSET_DIRS) {
                _walk(asset.src, asset.src, asset.zipPrefix);
            }

            // 3) manifest.json 마지막에 추가
            const totalAssetSize = manifest.files.filter(f => f.kind === 'asset').reduce((s, f) => s + f.size, 0);
            manifest.summary = {
                total_files: manifest.files.length,
                db_files: manifest.files.filter(f => f.kind.startsWith('sqlite')).length,
                asset_files: manifest.files.filter(f => f.kind === 'asset').length,
                total_asset_bytes: totalAssetSize,
            };
            zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));

            const zipBuf = zip.toBuffer();
            const ts = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
            res.setHeader('Content-Type', 'application/zip');
            res.setHeader('Content-Disposition', `attachment; filename="pace-rise-full-backup-${ts}.zip"`);
            res.send(zipBuf);
        } catch (e) {
            console.error('[FullBackup] 다운로드 실패:', e);
            res.status(500).json({ error: '통백업 생성 실패: ' + e.message });
        }
    });

    // POST /api/admin/full-backup/preview
    // ZIP 업로드 → manifest 파싱 + 무결성 검사 (실제 복원은 하지 않음)
    app.post('/api/admin/full-backup/preview', _fullBackupUpload.single('file'), (req, res) => {
        _applyJwtBridge(req); // multer 가 req.body 를 새로 만들므로 JWT 브리지 재주입
        if (db.isAsync) {
            try { if (req.file) fs.unlinkSync(req.file.path); } catch(_) {}
            return res.status(400).json({ error: '통백업/복원은 SQLite 백엔드 전용입니다.' });
        }
        if (!isAdminKey(req.body.admin_key)) {
            try { if (req.file) fs.unlinkSync(req.file.path); } catch(_) {}
            return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        }
        if (!req.file) return res.status(400).json({ error: 'ZIP 파일이 필요합니다.' });
        try {
            const AdmZip = require('adm-zip');
            const zip = new AdmZip(req.file.path);
            const entries = zip.getEntries();
            const manifestEntry = entries.find(e => e.entryName === 'manifest.json');
            if (!manifestEntry) {
                return res.status(400).json({ error: 'manifest.json이 없습니다. 올바른 PACE RISE 통백업 ZIP이 아닙니다.' });
            }
            const manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
            if (manifest.type !== 'pace-rise-full-backup') {
                return res.status(400).json({ error: '백업 타입 불일치: ' + manifest.type });
            }
            // DB 파일 존재 여부
            const dbBase = path.basename(DB_PATH);
            const hasDb = entries.some(e => e.entryName === `db/${dbBase}`);
            if (!hasDb) {
                return res.status(400).json({ error: `DB 파일이 없습니다 (db/${dbBase}).` });
            }
            // 자산 카운트
            const assetCount = entries.filter(e => !e.entryName.startsWith('db/') && e.entryName !== 'manifest.json').length;
            res.json({
                ok: true,
                manifest: {
                    version: manifest.version,
                    created_at: manifest.created_at,
                    db_backend: manifest.db_backend,
                    summary: manifest.summary,
                },
                zip_size: fs.statSync(req.file.path).size,
                db_present: hasDb,
                entries_count: entries.length,
                asset_count: assetCount,
                tmp_path: req.file.path, // 다음 단계 apply에서 재사용 (file_id 처럼)
            });
        } catch (e) {
            try { if (req.file) fs.unlinkSync(req.file.path); } catch(_) {}
            res.status(500).json({ error: '백업 ZIP 분석 실패: ' + e.message });
        }
    });

    // POST /api/admin/full-backup/restore
    // ZIP 업로드 → 즉시 복원. 매우 위험.
    // confirm='RESTORE'를 명시적으로 받음. 복원 직전 자동 안전 백업 수행.
    app.post('/api/admin/full-backup/restore', _fullBackupUpload.single('file'), async (req, res) => {
        _applyJwtBridge(req); // multer 가 req.body 를 새로 만들므로 JWT 브리지 재주입
        if (db.isAsync) {
            try { if (req.file) fs.unlinkSync(req.file.path); } catch(_) {}
            return res.status(400).json({ error: '통백업/복원은 SQLite 백엔드 전용입니다.' });
        }
        if (!isAdminKey(req.body.admin_key)) {
            try { if (req.file) fs.unlinkSync(req.file.path); } catch(_) {}
            return res.status(403).json({ error: '관리자 키가 필요합니다.' });
        }
        if (req.body.confirm !== 'RESTORE') {
            try { if (req.file) fs.unlinkSync(req.file.path); } catch(_) {}
            return res.status(400).json({ error: '복원 확인 문자열이 일치하지 않습니다. confirm=RESTORE 필요.' });
        }
        if (!req.file) return res.status(400).json({ error: 'ZIP 파일이 필요합니다.' });

        const zipPath = req.file.path;
        try {
            const AdmZip = require('adm-zip');
            const zip = new AdmZip(zipPath);
            const entries = zip.getEntries();
            const manifestEntry = entries.find(e => e.entryName === 'manifest.json');
            if (!manifestEntry) throw new Error('manifest.json이 없습니다.');
            const manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
            if (manifest.type !== 'pace-rise-full-backup') throw new Error('백업 타입 불일치');
            const dbBase = path.basename(DB_PATH);
            const dbEntry = entries.find(e => e.entryName === `db/${dbBase}`);
            if (!dbEntry) throw new Error(`DB 파일이 없습니다: db/${dbBase}`);

            // ── Step 1: 현재 상태 안전 백업 (rollback 용) ──
            let rollbackFile = null;
            try {
                try { db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch(_) {}
                rollbackFile = await performBackup('prerestore');   // await 누락 → 복원이 백업 완료 전에 시작될 수 있었다
                console.log('[FullRestore] 복원 전 자동 백업:', rollbackFile);
            } catch (e) {
                console.warn('[FullRestore] 자동 백업 실패(무시):', e.message);
            }

            // ── Step 2: SQLite 연결을 닫고 파일 교체 ──
            // better-sqlite3는 close() 후 다시 열기 어려우므로, DB 파일을 덮어쓴 후 서버 재시작 안내.
            // 단, 같은 프로세스에서 이어 쓰기 위해 db.raw.close() → 새 인스턴스 교체는 위험하므로
            // 본 라우트는 "파일 교체 + 재시작 권장" 모델로 동작.
            try { db.raw.close(); } catch(_) {}

            // 기존 WAL/SHM 정리 (서로 다른 백업에서 온 wal과 main이 섞이면 손상 위험)
            for (const ext of ['-wal', '-shm']) {
                try { if (fs.existsSync(DB_PATH + ext)) fs.unlinkSync(DB_PATH + ext); } catch(_) {}
            }

            // ── Step 3: 새 DB 파일 쓰기 ──
            fs.writeFileSync(DB_PATH, dbEntry.getData());
            // 백업에 포함된 wal/shm은 동일 시점의 main과 짝이 맞을 때만 의미가 있음.
            // PRAGMA wal_checkpoint(TRUNCATE)로 백업할 때 wal을 비웠으므로 보통 wal은 비어있거나 없음.
            // 복원 시에도 wal은 비워둔 채 새 인스턴스가 다시 만들도록 함.

            // ── Step 4: 자산 디렉토리 복원 ──
            // 기존 자산을 모두 삭제하지는 않음 (운영 안전). 백업 내 파일만 덮어씀.
            let restoredAssets = 0;
            for (const ent of entries) {
                if (ent.entryName === 'manifest.json') continue;
                if (ent.entryName.startsWith('db/')) continue;
                if (ent.isDirectory) continue;
                // 보안: zip-slip 방지 — 절대경로/상위 디렉토리 참조 금지
                if (/(^|\/)\.\.(\/|$)/.test(ent.entryName) || ent.entryName.startsWith('/')) continue;
                // 자산 경로 매핑: public/uploads/* → /home/user/webapp/public/uploads/*
                //                 uploads/*        → /home/user/webapp/uploads/*
                let outPath = null;
                for (const asset of _FULL_BACKUP_ASSET_DIRS) {
                    if (ent.entryName.startsWith(asset.zipPrefix + '/')) {
                        const rel = ent.entryName.substring(asset.zipPrefix.length + 1);
                        outPath = path.join(asset.src, rel);
                        break;
                    }
                }
                if (!outPath) continue;
                try {
                    fs.mkdirSync(path.dirname(outPath), { recursive: true });
                    fs.writeFileSync(outPath, ent.getData());
                    restoredAssets++;
                } catch (e) {
                    console.warn('[FullRestore] 자산 쓰기 실패:', outPath, e.message);
                }
            }

            try { fs.unlinkSync(zipPath); } catch(_) {}

            // 응답 후 서버 종료 — PM2가 자동 재시작하여 새 DB 핸들로 부팅
            res.json({
                ok: true,
                message: '복원 완료. 서버가 자동 재시작됩니다.',
                restored_assets: restoredAssets,
                rollback_file: rollbackFile ? path.basename(rollbackFile) : null,
                manifest_created_at: manifest.created_at,
            });

            // 응답 전송 후 1.5초 뒤 graceful exit → PM2가 재시작
            setTimeout(() => {
                console.log('[FullRestore] 복원 완료, 서버 재시작 (PM2 auto-restart 기대)');
                process.exit(0);
            }, 1500);
        } catch (e) {
            try { fs.unlinkSync(zipPath); } catch(_) {}
            console.error('[FullRestore] 실패:', e);
            res.status(500).json({ error: '복원 실패: ' + e.message });
        }
    });

    return { _fullBackupUpload, _FULL_BACKUP_ASSET_DIRS };
};
