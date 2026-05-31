// ============================================================
// lib/routes/certificate.js
// ------------------------------------------------------------
// 상장(Certificate) 시스템 — 추출 2026-05-31 (A-11)
//
// 11 routes (server.js 의 10690~11072 영역에서 분리)
//   GET    /api/admin/certificate-templates
//   GET    /api/admin/certificate-templates/:id
//   POST   /api/admin/certificate-templates
//   PUT    /api/admin/certificate-templates/:id
//   DELETE /api/admin/certificate-templates/:id
//   POST   /api/admin/certificates/preview
//   POST   /api/admin/certificates/generate
//   POST   /api/admin/certificates/single
//   POST   /api/admin/certificate-images/upload
//   POST   /api/admin/certificate-images/delete
//   GET    /api/admin/certificates/log
//
// 양식 종류: award(시상장) | finisher(완주증) | team(단체상)
// 순위 표기: ordinal(우승/준우승/3위) | numeric(1위/2위/3위) | mixed
//
// 의존성 (Dependency Injection):
//   db                      — DB adapter (better-sqlite3 / pg) from lib/db.js
//   isAdminKey              — 관리자 인증 함수
//   generateCertificatePdf  — lib/certificatePdf.js 의 단건 PDF 생성기
//   generateCertificateBatch — lib/certificatePdf.js 의 일괄 PDF 생성기
//   upload                  — multer 미들웨어 (image upload 라우트용)
//   publicDir               — 절대경로 (server.js 의 __dirname/public). cert 이미지 저장지점
//
// 또한 `getEventResultsForCert` 헬퍼를 module.exports.getEventResultsForCert
// 에 노출하여 다른 모듈(예: sms.js)이 서버 부팅 시 함께 주입받을 수 있게 한다.
// ============================================================

const path = require('path');
const fs = require('fs');

// 종목 결과 가져오기 (랭킹·기록 포함) — 상장 발급용 헬퍼
// db 어댑터에 의존하므로 팩토리에서 db 를 클로저로 캡처해서 반환한다.
function buildGetEventResultsForCert(db) {
    return async function getEventResultsForCert(eventId) {
        const event = await db.get('SELECT * FROM event WHERE id=?', eventId);
        if (!event) return { event: null, rows: [] };

        // 트랙(time_seconds) / 필드(distance_meters) 자동 판별
        const rows = await db.all(`
            SELECT
                ee.id AS entry_id,
                ee.athlete_id,
                a.name AS athlete_name,
                a.team,
                a.bib_number,
                r.time_seconds,
                r.distance_meters,
                r.status_code,
                r.wind,
                r.attempt_number
            FROM event_entry ee
            JOIN athlete a ON a.id = ee.athlete_id
            LEFT JOIN heat h ON h.event_id = ee.event_id
            LEFT JOIN result r ON r.event_entry_id = ee.id AND r.heat_id = h.id
            WHERE ee.event_id = ?
        `, eventId);

        // 같은 선수에 여러 시도가 있을 수 있어 best 기록만 추림
        const byAthlete = new Map();
        for (const row of rows) {
            const cur = byAthlete.get(row.athlete_id);
            const valid = (row.status_code == null || row.status_code === '' || row.status_code === 'OK');
            const t = (row.time_seconds != null && row.time_seconds > 0) ? row.time_seconds : null;
            const d = (row.distance_meters != null && row.distance_meters > 0) ? row.distance_meters : null;
            if (!cur) { byAthlete.set(row.athlete_id, row); continue; }
            // 더 좋은 기록 갱신
            if (t && (cur.time_seconds == null || t < cur.time_seconds)) byAthlete.set(row.athlete_id, row);
            else if (d && (cur.distance_meters == null || d > cur.distance_meters)) byAthlete.set(row.athlete_id, row);
        }
        const list = Array.from(byAthlete.values());

        // 시간(track) → 오름차순, 거리(field) → 내림차순
        const hasTime = list.some(x => x.time_seconds != null && x.time_seconds > 0);
        const hasDist = list.some(x => x.distance_meters != null && x.distance_meters > 0);
        list.sort((a, b) => {
            const aStatus = a.status_code && a.status_code !== 'OK';
            const bStatus = b.status_code && b.status_code !== 'OK';
            if (aStatus && !bStatus) return 1;
            if (!aStatus && bStatus) return -1;
            if (hasTime) {
                const at = a.time_seconds || 999999, bt = b.time_seconds || 999999;
                return at - bt;
            }
            if (hasDist) {
                const ad = a.distance_meters || -1, bd = b.distance_meters || -1;
                return bd - ad;
            }
            return 0;
        });

        // 순위 부여 및 기록 포맷
        const ranked = list.map((row, idx) => {
            const hasResult = (row.time_seconds && row.time_seconds > 0) ||
                             (row.distance_meters && row.distance_meters > 0) ||
                             (row.status_code === 'DNS' || row.status_code === 'DNF' || row.status_code === 'DQ');
            const rank = (row.status_code && row.status_code !== 'OK') ? null : (idx + 1);
            let recordValue = '';
            if (row.time_seconds && row.time_seconds > 0) {
                const t = row.time_seconds;
                if (t >= 60) {
                    const m = Math.floor(t / 60);
                    const s = (t - m * 60).toFixed(2);
                    recordValue = `${m}:${s.padStart(5, '0')}`;
                } else {
                    recordValue = t.toFixed(2);
                }
                if (row.wind) recordValue += ` (${row.wind})`;
            } else if (row.distance_meters && row.distance_meters > 0) {
                recordValue = row.distance_meters.toFixed(2) + 'm';
            } else if (row.status_code) {
                recordValue = row.status_code;
            }
            return {
                athlete_id: row.athlete_id,
                athlete_name: row.athlete_name,
                team: row.team || '',
                bib_number: row.bib_number,
                rank,
                record_value: recordValue,
                finished: hasResult && (!row.status_code || row.status_code === 'OK'),
                status_code: row.status_code,
            };
        });
        return { event, rows: ranked };
    };
}

module.exports = function mountCertificateRoutes(app, deps) {
    const {
        db,
        isAdminKey,
        generateCertificatePdf,
        generateCertificateBatch,
        upload,
        publicDir, // 절대경로 (__dirname/public)
    } = deps;

    if (!app || !db || !isAdminKey || !generateCertificatePdf || !generateCertificateBatch || !upload || !publicDir) {
        throw new Error('[certificate] required deps missing (app, db, isAdminKey, generateCertificatePdf, generateCertificateBatch, upload, publicDir)');
    }

    const getEventResultsForCert = buildGetEventResultsForCert(db);
    // 외부에서도 동일 헬퍼 재사용할 수 있도록 module-level 에 노출
    module.exports.getEventResultsForCert = getEventResultsForCert;

    // 템플릿 목록 (관리자) — 대회 ID 옵션
    app.get('/api/admin/certificate-templates', async (req, res) => {
        try {
            const adminKey = req.query.admin_key;
            if (!isAdminKey(adminKey)) return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
            const compId = req.query.competition_id;
            let rows;
            if (compId) {
                rows = await db.all(
                    `SELECT * FROM certificate_template
                     WHERE competition_id IS NULL OR competition_id = ?
                     ORDER BY sort_order, id`, compId);
            } else {
                rows = await db.all('SELECT * FROM certificate_template ORDER BY sort_order, id');
            }
            res.json({ templates: rows });
        } catch (err) {
            console.error('[CERT][list] error:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // 템플릿 단건 조회
    app.get('/api/admin/certificate-templates/:id', async (req, res) => {
        try {
            const adminKey = req.query.admin_key;
            if (!isAdminKey(adminKey)) return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
            const row = await db.get('SELECT * FROM certificate_template WHERE id=?', req.params.id);
            if (!row) return res.status(404).json({ error: '템플릿을 찾을 수 없습니다.' });
            res.json({ template: row });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // 템플릿 생성
    app.post('/api/admin/certificate-templates', async (req, res) => {
        try {
            const { admin_key } = req.body || {};
            if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
            const t = req.body || {};
            const now = new Date().toISOString();
            const result = await db.run(`INSERT INTO certificate_template (
                competition_id, name, kind, title_text, body_template, rank_label_style,
                signer_org, signer_title, signer_name,
                logo_left_path, logo_right_path, seal_image_path,
                paper_orientation, show_record_value, show_athlete_team, show_date,
                background_color, border_style, font_family, is_default, sort_order,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                t.competition_id || null,
                t.name || '새 양식',
                t.kind || 'award',
                t.title_text || '상  장',
                t.body_template || '',
                t.rank_label_style || 'ordinal',
                t.signer_org || '',
                t.signer_title || '회장',
                t.signer_name || '',
                t.logo_left_path || '',
                t.logo_right_path || '',
                t.seal_image_path || '',
                t.paper_orientation || 'portrait',
                t.show_record_value == null ? 1 : (t.show_record_value ? 1 : 0),
                t.show_athlete_team == null ? 1 : (t.show_athlete_team ? 1 : 0),
                t.show_date == null ? 1 : (t.show_date ? 1 : 0),
                t.background_color || '#fffdf6',
                t.border_style || 'double-gold',
                t.font_family || 'NanumSquare',
                t.is_default ? 1 : 0,
                t.sort_order || 0,
                now, now
            );
            const row = await db.get('SELECT * FROM certificate_template WHERE id=?', result.lastInsertRowid);
            res.json({ success: true, template: row });
        } catch (err) {
            console.error('[CERT][create]', err);
            res.status(500).json({ error: err.message });
        }
    });

    // 템플릿 수정
    app.put('/api/admin/certificate-templates/:id', async (req, res) => {
        try {
            const { admin_key } = req.body || {};
            if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
            const t = req.body || {};
            const id = req.params.id;
            const cur = await db.get('SELECT * FROM certificate_template WHERE id=?', id);
            if (!cur) return res.status(404).json({ error: '템플릿을 찾을 수 없습니다.' });
            const now = new Date().toISOString();
            await db.run(`UPDATE certificate_template SET
                competition_id=?, name=?, kind=?, title_text=?, body_template=?, rank_label_style=?,
                signer_org=?, signer_title=?, signer_name=?,
                logo_left_path=?, logo_right_path=?, seal_image_path=?,
                paper_orientation=?, show_record_value=?, show_athlete_team=?, show_date=?,
                background_color=?, border_style=?, font_family=?, is_default=?, sort_order=?,
                updated_at=?
                WHERE id=?`,
                t.competition_id !== undefined ? t.competition_id : cur.competition_id,
                t.name ?? cur.name,
                t.kind ?? cur.kind,
                t.title_text ?? cur.title_text,
                t.body_template ?? cur.body_template,
                t.rank_label_style ?? cur.rank_label_style,
                t.signer_org ?? cur.signer_org,
                t.signer_title ?? cur.signer_title,
                t.signer_name ?? cur.signer_name,
                t.logo_left_path ?? cur.logo_left_path,
                t.logo_right_path ?? cur.logo_right_path,
                t.seal_image_path ?? cur.seal_image_path,
                t.paper_orientation ?? cur.paper_orientation,
                t.show_record_value == null ? cur.show_record_value : (t.show_record_value ? 1 : 0),
                t.show_athlete_team == null ? cur.show_athlete_team : (t.show_athlete_team ? 1 : 0),
                t.show_date == null ? cur.show_date : (t.show_date ? 1 : 0),
                t.background_color ?? cur.background_color,
                t.border_style ?? cur.border_style,
                t.font_family ?? cur.font_family,
                t.is_default == null ? cur.is_default : (t.is_default ? 1 : 0),
                t.sort_order ?? cur.sort_order,
                now, id
            );
            const row = await db.get('SELECT * FROM certificate_template WHERE id=?', id);
            res.json({ success: true, template: row });
        } catch (err) {
            console.error('[CERT][update]', err);
            res.status(500).json({ error: err.message });
        }
    });

    // 템플릿 삭제
    app.delete('/api/admin/certificate-templates/:id', async (req, res) => {
        try {
            const adminKey = (req.body && req.body.admin_key) || req.query.admin_key;
            if (!isAdminKey(adminKey)) return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
            await db.run('DELETE FROM certificate_template WHERE id=?', req.params.id);
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // 미리보기 PDF — 가짜 데이터로 한 페이지
    app.post('/api/admin/certificates/preview', async (req, res) => {
        try {
            const { admin_key, template, sample } = req.body || {};
            if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
            const tpl = template || {};
            const data = Object.assign({
                athlete_name: '홍길동',
                team: '소속명',
                event_name: '남자 100m',
                rank: 1,
                record_value: '10.32 (NR)',
                competition_name: '제00회 대회',
            }, sample || {});
            const buf = await generateCertificatePdf(tpl, data);
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', 'inline; filename="cert_preview.pdf"');
            res.end(buf);
        } catch (err) {
            console.error('[CERT][preview]', err);
            res.status(500).json({ error: err.message });
        }
    });

    // 일괄 발급 — 대회/종목/순위범위 선택해서 PDF
    app.post('/api/admin/certificates/generate', async (req, res) => {
        try {
            const { admin_key, template_id, competition_id, event_ids,
                    rank_from, rank_to, include_finishers, mode } = req.body || {};
            if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 권한이 필요합니다.' });

            const tpl = await db.get('SELECT * FROM certificate_template WHERE id=?', template_id);
            if (!tpl) return res.status(404).json({ error: '템플릿을 찾을 수 없습니다.' });

            const comp = competition_id ? await db.get('SELECT * FROM competition WHERE id=?', competition_id) : null;

            let targetEventIds = Array.isArray(event_ids) ? event_ids.slice() : [];
            if (targetEventIds.length === 0 && competition_id) {
                // 대회 전체 이벤트
                const all = await db.all(`SELECT id FROM event WHERE competition_id=? AND round_type='final' ORDER BY sort_order, id`, competition_id);
                targetEventIds = all.map(e => e.id);
            }
            if (targetEventIds.length === 0) {
                return res.status(400).json({ error: '발급할 종목이 없습니다.' });
            }

            const rankFrom = Math.max(1, parseInt(rank_from || 1, 10));
            const rankTo = Math.max(rankFrom, parseInt(rank_to || 3, 10));
            const wantFinishers = !!include_finishers;
            const certMode = mode || tpl.kind || 'award';

            const items = [];
            for (const eid of targetEventIds) {
                const { event, rows } = await getEventResultsForCert(eid);
                if (!event) continue;
                for (const row of rows) {
                    let shouldInclude = false;
                    if (certMode === 'finisher') {
                        // 완주증 모드 — 완주한 모든 선수
                        if (row.finished) shouldInclude = true;
                    } else {
                        // 시상장 모드 — 순위 범위 내
                        if (row.rank != null && row.rank >= rankFrom && row.rank <= rankTo) shouldInclude = true;
                        // 옵션: 동시 완주증도 포함
                        if (!shouldInclude && wantFinishers && row.finished && (row.rank == null || row.rank > rankTo)) {
                            shouldInclude = true;
                        }
                    }
                    if (!shouldInclude) continue;
                    items.push({
                        athlete_id: row.athlete_id,
                        athlete_name: row.athlete_name,
                        team: row.team,
                        event_name: event.name,
                        rank: certMode === 'finisher' ? null : row.rank,
                        record_value: row.record_value,
                        competition_name: comp ? comp.name : '',
                    });
                }
            }

            if (items.length === 0) {
                return res.status(400).json({ error: '조건에 해당하는 발급 대상이 없습니다.' });
            }

            const buf = await generateCertificateBatch(tpl, items);

            // 발급 로그 기록
            const now = new Date().toISOString();
            const INSERT_LOG_SQL = `INSERT INTO certificate_issue_log
                (competition_id, template_id, event_id, athlete_id, rank_value, record_value, issued_at, issued_by, note)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            try {
                const txn = db.transaction(async () => {
                    for (const it of items) {
                        await db.run(INSERT_LOG_SQL,
                            competition_id || null,
                            tpl.id,
                            null,
                            it.athlete_id,
                            it.rank == null ? null : it.rank,
                            it.record_value || '',
                            now,
                            '관리자',
                            certMode
                        );
                    }
                });
                await txn();
            } catch (_) { /* log failure should not block PDF */ }

            const fileName = encodeURIComponent(`상장_${(comp?.name||'대회')}_${items.length}건.pdf`);
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${fileName}"; filename*=UTF-8''${fileName}`);
            res.end(buf);
        } catch (err) {
            console.error('[CERT][generate]', err);
            if (!res.headersSent) res.status(500).json({ error: err.message });
        }
    });

    // 개별 발급 — 특정 선수 1명에 대해 PDF (재발급용)
    app.post('/api/admin/certificates/single', async (req, res) => {
        try {
            const { admin_key, template_id, data } = req.body || {};
            if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
            const tpl = await db.get('SELECT * FROM certificate_template WHERE id=?', template_id);
            if (!tpl) return res.status(404).json({ error: '템플릿을 찾을 수 없습니다.' });
            const buf = await generateCertificatePdf(tpl, data || {});
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="cert.pdf"`);
            res.end(buf);
        } catch (err) {
            console.error('[CERT][single]', err);
            res.status(500).json({ error: err.message });
        }
    });

    // 상장 이미지 업로드 (로고/인장)
    // position: 'logo_left' | 'logo_right' | 'seal'
    app.post('/api/admin/certificate-images/upload', upload.single('image'), async (req, res) => {
        try {
            if (!isAdminKey(req.body.admin_key)) return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
            if (!req.file) return res.status(400).json({ error: '파일이 업로드되지 않았습니다.' });
            const templateId = parseInt(req.body.template_id, 10);
            const position = req.body.position;
            if (!templateId || !['logo_left', 'logo_right', 'seal'].includes(position)) {
                return res.status(400).json({ error: 'template_id, position(logo_left|logo_right|seal) 필요' });
            }

            const tpl = await db.get('SELECT * FROM certificate_template WHERE id=?', templateId);
            if (!tpl) return res.status(404).json({ error: '템플릿을 찾을 수 없습니다.' });

            // 저장 디렉토리
            const destDir = path.join(publicDir, 'uploads', 'cert_images');
            if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

            // 기존 파일 제거 (확장자 다를 수 있음)
            const oldExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
            for (const oe of oldExts) {
                const oldPath = path.join(destDir, `cert_${position}_${templateId}${oe}`);
                try { if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath); } catch(e) {}
            }

            // 새 파일 저장
            const ext = (path.extname(req.file.originalname) || '.png').toLowerCase();
            const filename = `cert_${position}_${templateId}${ext}`;
            const destPath = path.join(destDir, filename);
            fs.copyFileSync(req.file.path, destPath);
            try { fs.unlinkSync(req.file.path); } catch(_) {}

            const publicUrl = `/uploads/cert_images/${filename}`;

            // 템플릿 DB 업데이트
            const fieldMap = {
                'logo_left': 'logo_left_path',
                'logo_right': 'logo_right_path',
                'seal': 'seal_image_path',
            };
            const dbField = fieldMap[position];
            const now = new Date().toISOString();
            await db.run(`UPDATE certificate_template SET ${dbField}=?, updated_at=? WHERE id=?`, publicUrl, now, templateId);

            const cacheBust = `${publicUrl}?v=${Date.now()}`;
            res.json({ success: true, url: cacheBust, path: publicUrl });
        } catch (err) {
            console.error('[CERT][image-upload]', err);
            res.status(500).json({ error: err.message });
        }
    });

    // 상장 이미지 삭제
    app.post('/api/admin/certificate-images/delete', async (req, res) => {
        try {
            const { admin_key, template_id, position } = req.body || {};
            if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
            if (!template_id || !['logo_left', 'logo_right', 'seal'].includes(position)) {
                return res.status(400).json({ error: 'template_id, position 필요' });
            }
            const fieldMap = {
                'logo_left': 'logo_left_path',
                'logo_right': 'logo_right_path',
                'seal': 'seal_image_path',
            };
            const tpl = await db.get('SELECT * FROM certificate_template WHERE id=?', template_id);
            if (!tpl) return res.status(404).json({ error: '템플릿을 찾을 수 없습니다.' });
            const oldPath = tpl[fieldMap[position]];
            if (oldPath) {
                const absPath = path.join(publicDir, oldPath.replace(/^\/+/, ''));
                try { if (fs.existsSync(absPath)) fs.unlinkSync(absPath); } catch(e) {}
            }
            await db.run(`UPDATE certificate_template SET ${fieldMap[position]}='', updated_at=? WHERE id=?`, new Date().toISOString(), template_id);
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // 발급 로그
    app.get('/api/admin/certificates/log', async (req, res) => {
        try {
            const adminKey = req.query.admin_key;
            if (!isAdminKey(adminKey)) return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
            const compId = req.query.competition_id;
            const limit = Math.min(parseInt(req.query.limit || 200, 10), 1000);
            const where = compId ? 'WHERE l.competition_id=?' : '';
            const params = compId ? [compId, limit] : [limit];
            const rows = await db.all(`
                SELECT l.*, t.name AS template_name, a.name AS athlete_name, a.team
                FROM certificate_issue_log l
                LEFT JOIN certificate_template t ON t.id = l.template_id
                LEFT JOIN athlete a ON a.id = l.athlete_id
                ${where}
                ORDER BY l.issued_at DESC
                LIMIT ?
            `, ...params);
            res.json({ logs: rows });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // 모듈 외부에서 헬퍼 재사용 (SMS 등)
    return { getEventResultsForCert };
};

// 헬퍼 팩토리는 require 직후에도 노출
module.exports.buildGetEventResultsForCert = buildGetEventResultsForCert;
