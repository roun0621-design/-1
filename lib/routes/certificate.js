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
    const PaceRanking = require('../../public/lib/ranking');
    const STATUS = ['DNS', 'DNF', 'DQ', 'NM'];
    // 초 소수 자리수: 기본 2자리, 3번째 자리가 유효하면 3자리 (FAT 1/1000 보존)
    const _secDp = v => Math.abs((Math.round(v * 1000) / 1000) - (Math.round(v * 100) / 100)) < 0.0001 ? 2 : 3;
    const fmtTime = t => {
        if (t >= 60) { const m = Math.floor(t / 60), r = t - m * 60, dp = _secDp(r); return `${m}:${r.toFixed(dp).padStart(dp === 3 ? 6 : 5, '0')}`; }
        return t.toFixed(_secDp(t));
    };
    const windNum = w => { if (w == null || w === '') return null; const n = parseFloat(String(w)); return isFinite(n) ? n : null; };

    // (2026-09 재작성) 상장·기록증·문자 발송이 쓰는 순위. 화면·결과지와 같은 공용 규칙(public/lib/ranking.js)을 쓴다.
    //   예전 구현의 문제: ① 순위 = 목록 위치(idx+1) → 동기록도 1위·2위로 갈려 상장이 잘못 나감
    //   ② 높이 종목을 result.distance_meters 로 봄(실제 데이터는 height_attempt) → 높이·장대는 순위·기록이 아예 없음
    //   ③ 필드에서 DQ/NM 상태 행이 기록 행에 덮여 실격 선수가 순위에 들어감 ④ 종합경기 미지원 ⑤ 기록 없는 선수에게도 순위 부여
    return async function getEventResultsForCert(eventId) {
        const event = await db.get('SELECT * FROM event WHERE id=?', eventId);
        if (!event) return { event: null, rows: [] };
        const cat = event.category;

        const entries = await db.all(`
            SELECT ee.id AS entry_id, ee.athlete_id, ee.status AS entry_status, ee.manual_rank,
                   a.name AS athlete_name, a.team, a.bib_number
            FROM event_entry ee JOIN athlete a ON a.id = ee.athlete_id WHERE ee.event_id = ?`, eventId);
        const heats = await db.all('SELECT id, heat_number, wind FROM heat WHERE event_id=?', eventId);
        const heatById = new Map(heats.map(h => [h.id, h]));
        const heRows = await db.all(`SELECT he.event_entry_id AS entry_id, he.heat_id FROM heat_entry he JOIN heat hh ON hh.id=he.heat_id WHERE hh.event_id=?`, eventId);
        const heatOf = new Map(); for (const r of heRows) if (!heatOf.has(r.entry_id)) heatOf.set(r.entry_id, r.heat_id);
        const results = heats.length ? await db.all(`SELECT * FROM result WHERE heat_id IN (${heats.map(() => '?').join(',')})`, ...heats.map(h => h.id)) : [];
        const resBy = new Map(); for (const r of results) { if (!resBy.has(r.event_entry_id)) resBy.set(r.event_entry_id, []); resBy.get(r.event_entry_id).push(r); }

        let attemptsBy = new Map();
        if (cat === 'field_height' && heats.length) {
            const att = await db.all(`SELECT * FROM height_attempt WHERE heat_id IN (${heats.map(() => '?').join(',')})`, ...heats.map(h => h.id));
            for (const a of att) { if (!attemptsBy.has(a.event_entry_id)) attemptsBy.set(a.event_entry_id, []); attemptsBy.get(a.event_entry_id).push(a); }
        }
        let totals = new Map();
        if (cat === 'combined') {
            const cs = await db.all(`SELECT event_entry_id, SUM(wa_points) AS total, COUNT(*) AS n FROM combined_score WHERE event_entry_id IN (SELECT id FROM event_entry WHERE event_id=?) GROUP BY event_entry_id`, eventId);
            for (const c of cs) totals.set(c.event_entry_id, c);
        }

        const rows = entries.map(e => {
            const recs = resBy.get(e.entry_id) || [];
            let status = (recs.find(r => r.status_code && STATUS.includes(String(r.status_code).toUpperCase())) || {}).status_code || '';
            status = status ? String(status).toUpperCase() : '';
            if (!status && e.entry_status === 'no_show') status = 'DNS';
            const row = { ...e, status_code: status || null, best: null, record_value: '', wind: null, heat_id: heatOf.get(e.entry_id) || null };
            if (cat === 'field_height') {
                const st = PaceRanking.heightStatsFromAttempts(attemptsBy.get(e.entry_id) || []);
                Object.assign(row, { best: st.best, failsAtBest: st.failsAtBest, totalFails: st.totalFails });
                if (!status && st.isNM) row.status_code = 'NM';
                if (row.best != null) row.record_value = row.best.toFixed(2) + 'm';
            } else if (cat === 'field_distance') {
                const valid = recs.filter(r => r.distance_meters != null && r.distance_meters > 0 && r.status_code !== 'X' && r.status_code !== 'FOUL');
                const st = PaceRanking.distanceStats(valid.map(r => r.distance_meters));
                Object.assign(row, { best: st.best, sortedValid: st.sortedValid });
                if (row.best != null) {
                    // 같은 거리가 여러 번이면 나중 시기의 풍속 (화면과 동일)
                    const bestRow = valid.filter(r => r.distance_meters === row.best).sort((x, y) => (y.attempt_number || 0) - (x.attempt_number || 0))[0];
                    row.wind = windNum(bestRow && bestRow.wind);
                    row.record_value = row.best.toFixed(2) + 'm';
                } else if (!status && recs.some(r => r.attempt_number != null)) row.status_code = 'NM';
            } else if (cat === 'combined') {
                const c = totals.get(e.entry_id);
                if (c && c.total > 0) { row.best = c.total; row.record_value = `${Math.floor(c.total)}점`; }
            } else { // track / road / relay
                const times = recs.filter(r => r.time_seconds != null && r.time_seconds > 0).map(r => r.time_seconds);
                if (times.length) {
                    row.time = Math.min(...times); row.best = -row.time;   // assignRanks 는 best 가 클수록 좋은 값 기준 → 음수로
                    row.record_value = fmtTime(row.time);
                    const h = heatById.get(row.heat_id); row.wind = windNum(h && h.wind);
                }
            }
            if (row.status_code) row.best = null;   // 실격·기권·기록없음은 기록이 남아 있어도 순위 없음
            return row;
        });

        // 순위: 동률이면 같은 순위, 다음 순위는 건너뜀
        const cmp = cat === 'field_height' ? PaceRanking.compareHeight
            : cat === 'field_distance' ? PaceRanking.compareDistance
            : (a, b) => (b.best === a.best ? 0 : b.best - a.best);   // 트랙(음수 시간)·종합(총점): 큰 값이 상위, 1/1000초·1점까지 같으면 동률
        const ranked = PaceRanking.assignRanks(rows, cmp);
        // 높이: 순위결정전 등 수동 순위가 있으면 그 값
        if (cat === 'field_height') rows.forEach(r => { if (r.best != null && r.manual_rank != null && r.manual_rank !== '') r.rank = Number(r.manual_rank); });

        // 조 내 순위 (조별 시상용) — 같은 규칙으로 조 안에서만 다시 매긴다
        const byHeat = new Map();
        for (const r of rows) { if (r.best == null) continue; const k = r.heat_id == null ? '_' : r.heat_id; if (!byHeat.has(k)) byHeat.set(k, []); byHeat.get(k).push({ ref: r, best: r.best, sortedValid: r.sortedValid, failsAtBest: r.failsAtBest, totalFails: r.totalFails }); }
        for (const list of byHeat.values()) { PaceRanking.assignRanks(list, cmp); list.forEach(x => { x.ref.heat_rank = x.rank; }); }

        const order = [...ranked.sort((a, b) => (a.rank - b.rank)), ...rows.filter(r => r.best == null)];
        const out = order.map(r => ({
            entry_id: r.entry_id, athlete_id: r.athlete_id, athlete_name: r.athlete_name, team: r.team || '', bib_number: r.bib_number,
            rank: r.best != null ? r.rank : null,
            record_value: r.best != null ? r.record_value : (r.status_code || ''),
            wind: r.best != null ? r.wind : null,
            finished: r.best != null,
            status_code: r.status_code,
            heat_number: (heatById.get(r.heat_id) || {}).heat_number ?? null,
            heat_rank: r.best != null ? (r.heat_rank ?? null) : null,
        }));
        const heatCount = new Set(out.map(r => r.heat_number).filter(x => x != null)).size;
        return { event, rows: out, heatCount };
    };
}

// 대회 시작일 → 상장 표기용 "YYYY년 M월 D일". 파싱 실패/미설정이면 '' (생성기가 오늘로 폴백).
function _certDateFromComp(comp) {
    const s = comp && comp.start_date ? String(comp.start_date).trim() : '';
    const m = s.match(/(\d{4})[-.\/]\s*(\d{1,2})[-.\/]\s*(\d{1,2})/);
    if (!m) return '';
    return `${m[1]}년 ${Number(m[2])}월 ${Number(m[3])}일`;
}

module.exports = function mountCertificateRoutes(app, deps) {
    const {
        db,
        isAdminKey,
        isOperationKey,
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
                watermark_image_path, watermark_opacity, watermark_scale, border_color, panel_color,
                text_color, label_color, accent_color, panel_opacity,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
                t.watermark_image_path || '',
                t.watermark_opacity == null ? 0.07 : Number(t.watermark_opacity),
                t.watermark_scale == null ? 0.45 : Number(t.watermark_scale),
                t.border_color || '#b8945a',
                t.panel_color || '#faf8f2',
                t.text_color || '#1a1a1a',
                t.label_color || '#8a7f6a',
                t.accent_color || '#7a3a00',
                t.panel_opacity == null ? 1.0 : Number(t.panel_opacity),
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
                watermark_image_path=?, watermark_opacity=?, watermark_scale=?, border_color=?, panel_color=?,
                text_color=?, label_color=?, accent_color=?, panel_opacity=?,
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
                t.watermark_image_path ?? cur.watermark_image_path,
                t.watermark_opacity == null ? cur.watermark_opacity : Number(t.watermark_opacity),
                t.watermark_scale == null ? cur.watermark_scale : Number(t.watermark_scale),
                t.border_color ?? cur.border_color,
                t.panel_color ?? cur.panel_color,
                t.text_color ?? cur.text_color,
                t.label_color ?? cur.label_color,
                t.accent_color ?? cur.accent_color,
                t.panel_opacity == null ? cur.panel_opacity : Number(t.panel_opacity),
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
                bib_number: '1234',
                gender: 'M',
                division: '중등부',
                event_name: '100m',
                rank: 1,
                record_value: '10.32 (NR)',
                wind: 1.2,
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

    // ── 공개 상장 열람 링크 (SMS "상장 다운로드" 링크의 대상) ──────────────
    //   GET /c/:token  — 로그인 없이 서명 토큰 소지자만 자기 상장 PDF 열람.
    //   토큰은 lib/certLink.js 의 HMAC 서명으로 위조 불가.
    const { verifyCertToken } = require('../certLink');

    // 공개 링크용 템플릿 선택: 대회전용→전역, kind 일치 우선, 없으면 아무 양식
    async function pickPublicCertTemplate(competitionId, kind) {
        let t = null;
        if (competitionId) {
            t = await db.get(`SELECT * FROM certificate_template WHERE competition_id=? AND kind=? ORDER BY is_default DESC, sort_order, id LIMIT 1`, competitionId, kind);
            if (t) return t;
        }
        t = await db.get(`SELECT * FROM certificate_template WHERE competition_id IS NULL AND kind=? ORDER BY is_default DESC, sort_order, id LIMIT 1`, kind);
        if (t) return t;
        if (competitionId) {
            t = await db.get(`SELECT * FROM certificate_template WHERE competition_id=? ORDER BY is_default DESC, sort_order, id LIMIT 1`, competitionId);
            if (t) return t;
        }
        return await db.get(`SELECT * FROM certificate_template ORDER BY is_default DESC, sort_order, id LIMIT 1`);
    }

    function _certLinkErrHtml(msg) {
        return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>상장 — PACE RISE</title>
<style>body{margin:0;font-family:-apple-system,'Noto Sans KR',sans-serif;background:#f5f0e0;color:#4a4a4a;display:flex;min-height:100vh;align-items:center;justify-content:center}
.box{background:#fff;border-radius:14px;padding:32px 28px;max-width:340px;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,.12)}
h1{font-size:16px;margin:0 0 8px;color:#8a7640}p{font-size:13px;line-height:1.7;margin:0}</style></head>
<body><div class="box"><h1>상장을 열 수 없습니다</h1><p>${msg}</p></div></body></html>`;
    }

    app.get('/c/:token', async (req, res) => {
        try {
            const parsed = await verifyCertToken(db, req.params.token);
            if (!parsed) return res.status(404).type('html').send(_certLinkErrHtml('유효하지 않거나 만료된 링크입니다.'));

            const { event, rows } = await getEventResultsForCert(parsed.eventId);
            if (!event) return res.status(404).type('html').send(_certLinkErrHtml('상장 정보를 찾을 수 없습니다.'));
            const row = rows.find(r => r.athlete_id === parsed.athleteId);
            if (!row) return res.status(404).type('html').send(_certLinkErrHtml('상장 정보를 찾을 수 없습니다.'));

            const compId = parsed.competitionId || event.competition_id || null;
            const comp = compId ? await db.get('SELECT * FROM competition WHERE id=?', compId) : null;

            // 순위가 있으면 시상장(award), 없으면 완주증(finisher)
            const kind = (row.rank != null && row.rank >= 1 && row.rank <= 3) ? 'award' : 'finisher';
            const tpl = await pickPublicCertTemplate(compId, kind);
            if (!tpl) return res.status(404).type('html').send(_certLinkErrHtml('상장 양식이 아직 준비되지 않았습니다.'));

            const data = {
                athlete_name: row.athlete_name,
                team: row.team,
                bib_number: row.bib_number,
                gender: event.gender,
                division: event.division || '',
                event_name: event.name,
                rank: kind === 'award' ? row.rank : null,
                record_value: row.record_value,
                wind: row.wind,
                competition_name: comp ? comp.name : '',
                date: _certDateFromComp(comp),   // 상장 날짜 = 대회 시작일 (열람 시점 무관, 항상 고정)
            };

            const buf = await generateCertificatePdf(tpl, data);
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', 'inline; filename="certificate.pdf"');
            res.setHeader('Cache-Control', 'private, max-age=3600');
            res.end(buf);
        } catch (err) {
            console.error('[CERT][public /c]', err);
            res.status(500).type('html').send(_certLinkErrHtml('상장을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.'));
        }
    });

    // 일괄 발급 — 대회/종목/순위범위 선택해서 PDF
    app.post('/api/admin/certificates/generate', async (req, res) => {
        try {
            const { admin_key, template_id, competition_id, event_ids,
                    rank_from, rank_to, include_finishers, mode, rank_scope, format } = req.body || {};
            // rank_scope: 'overall'(종합, 기본) | 'heat'(조별 — 조 내 순위로 시상)
            const useHeatRank = rank_scope === 'heat';
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
                const { event, rows, heatCount } = await getEventResultsForCert(eid);
                if (!event) continue;
                for (const row of rows) {
                    // 조별 시상이면 순위 기준을 조 내 순위(heat_rank)로 전환
                    const scopeRank = useHeatRank ? row.heat_rank : row.rank;
                    let shouldInclude = false;
                    if (certMode === 'record') {
                        // 기록증 모드 — 기록이 있는 출전자 전원
                        if (row.finished) shouldInclude = true;
                    } else if (certMode === 'finisher') {
                        // 완주증 모드 — 완주한 모든 선수
                        if (row.finished) shouldInclude = true;
                    } else {
                        // 시상장 모드 — 순위 범위 내 (조별이면 조 내 순위 기준)
                        if (scopeRank != null && scopeRank >= rankFrom && scopeRank <= rankTo) shouldInclude = true;
                        // 옵션: 동시 완주증도 포함
                        if (!shouldInclude && wantFinishers && row.finished && (scopeRank == null || scopeRank > rankTo)) {
                            shouldInclude = true;
                        }
                    }
                    if (!shouldInclude) continue;
                    items.push({
                        athlete_id: row.athlete_id,
                        athlete_name: row.athlete_name,
                        team: row.team,
                        bib_number: row.bib_number,
                        gender: event.gender,
                        division: event.division || '',
                        event_name: event.name,
                        rank: (certMode === 'finisher' || certMode === 'record') ? null : scopeRank,
                        rank_scope: useHeatRank ? 'heat' : 'overall',
                        record_value: row.record_value,
                        wind: row.wind,
                        // 조별 시상이면 조를 항상 표기, 종합이면 조가 2개 이상인 종목만 표기
                        heat_number: (row.heat_number != null && (useHeatRank || heatCount > 1)) ? row.heat_number : null,
                        competition_name: comp ? comp.name : '',
                        date: _certDateFromComp(comp),   // 상장 날짜 = 대회 시작일
                    });
                }
            }

            if (items.length === 0) {
                return res.status(400).json({ error: '조건에 해당하는 발급 대상이 없습니다.' });
            }

            // format: 'pdf'(기본) | 'docx'(워드·한글에서 열어 내용을 고칠 수 있는 편집용)
            const wantDocx = String(format || '').toLowerCase() === 'docx';
            const buf = wantDocx ? await require('../certificateDocx').generateCertificateDocx(tpl, items) : await generateCertificateBatch(tpl, items);

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

            const fileName = encodeURIComponent(`상장_${(comp?.name||'대회')}_${items.length}건.${wantDocx ? 'docx' : 'pdf'}`);
            res.setHeader('Content-Type', wantDocx ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${fileName}"; filename*=UTF-8''${fileName}`);
            res.end(buf);
        } catch (err) {
            console.error('[CERT][generate]', err);
            if (!res.headersSent) res.status(500).json({ error: err.message });
        }
    });

    // 종목 완료 후 기록입력 화면에서 바로 뽑는 상장 (워드 .docx — 받은 뒤 내용을 고칠 수 있다)
    //   POST /api/certificates/event-award  { event_id, rank_from=1, rank_to=3, template_id?, format='docx'|'pdf' }
    //   운영키/관리자. 양식은 template_id 가 없으면 그 대회의 기본 시상 양식 → 전역 기본 양식 순.
    app.post('/api/certificates/event-award', async (req, res) => {
        try {
            const { event_id, rank_from, rank_to, template_id, format, admin_key } = req.body || {};
            const key = admin_key || req.headers['x-admin-key'] || '';
            if (!(isAdminKey(key) || (typeof isOperationKey === 'function' && isOperationKey(key)))) return res.status(403).json({ error: '운영키 또는 관리자 권한이 필요합니다.' });
            const { event, rows, heatCount } = await getEventResultsForCert(parseInt(event_id, 10));
            if (!event) return res.status(404).json({ error: '종목을 찾을 수 없습니다.' });
            if (event.round_status !== 'completed') return res.status(400).json({ error: '경기 완료 처리된 종목만 상장을 출력할 수 있습니다.' });
            const comp = await db.get('SELECT * FROM competition WHERE id=?', event.competition_id);
            const tpl = template_id
                ? await db.get('SELECT * FROM certificate_template WHERE id=?', template_id)
                : await db.get(`SELECT * FROM certificate_template WHERE kind='award' AND (competition_id=? OR competition_id IS NULL)
                                ORDER BY CASE WHEN competition_id IS NULL THEN 1 ELSE 0 END, is_default DESC, sort_order, id LIMIT 1`, event.competition_id);
            if (!tpl) return res.status(404).json({ error: '시상 양식이 없습니다. 관리자 → 상장관리에서 양식을 먼저 만드세요.' });
            const from = Math.max(1, parseInt(rank_from || 1, 10)), to = Math.max(from, parseInt(rank_to || 3, 10));
            const items = rows.filter(r => r.rank != null && r.rank >= from && r.rank <= to).map(r => ({
                athlete_id: r.athlete_id, athlete_name: r.athlete_name, team: r.team, bib_number: r.bib_number,
                gender: event.gender, division: event.division || '', event_name: event.name, rank: r.rank,
                record_value: r.record_value, wind: r.wind, heat_number: null,
                competition_name: comp ? comp.name : '', date: _certDateFromComp(comp),
            }));
            if (!items.length) return res.status(400).json({ error: `${from}~${to}위에 해당하는 선수가 없습니다. (기록·순위를 확인하세요)` });
            const wantPdf = String(format || 'docx').toLowerCase() === 'pdf';
            const buf = wantPdf ? await generateCertificateBatch(tpl, items) : await require('../certificateDocx').generateCertificateDocx(tpl, items);
            try {
                const now = new Date().toISOString();
                for (const it of items) await db.run(`INSERT INTO certificate_issue_log (competition_id, template_id, event_id, athlete_id, rank_value, record_value, issued_at, issued_by, note) VALUES (?,?,?,?,?,?,?,?,?)`,
                    event.competition_id, tpl.id, event.id, it.athlete_id, it.rank, it.record_value || '', now, '기록입력', wantPdf ? 'award' : 'award-docx');
            } catch (_) { /* 로그 실패가 출력을 막지 않는다 */ }
            const gl = event.gender === 'M' ? '남자' : event.gender === 'F' ? '여자' : '혼성';
            const fileName = encodeURIComponent(`상장_${gl}_${event.name}_${items.length}명.${wantPdf ? 'pdf' : 'docx'}`);
            res.setHeader('Content-Type', wantPdf ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
            res.setHeader('Content-Disposition', `attachment; filename="${fileName}"; filename*=UTF-8''${fileName}`);
            res.end(buf);
        } catch (err) {
            console.error('[CERT][event-award]', err);
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
            const _data = data || {};
            // 날짜 미지정 시 대회 시작일로 채움 (competition_id 가 함께 온 경우)
            if (!_data.date && _data.competition_id) {
                const _comp = await db.get('SELECT * FROM competition WHERE id=?', _data.competition_id);
                if (_comp) _data.date = _certDateFromComp(_comp);
            }
            const buf = await generateCertificatePdf(tpl, _data);
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
            if (!templateId || !['logo_left', 'logo_right', 'seal', 'watermark'].includes(position)) {
                return res.status(400).json({ error: 'template_id, position(logo_left|logo_right|seal|watermark) 필요' });
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
                'watermark': 'watermark_image_path',
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
            if (!template_id || !['logo_left', 'logo_right', 'seal', 'watermark'].includes(position)) {
                return res.status(400).json({ error: 'template_id, position 필요' });
            }
            const fieldMap = {
                'logo_left': 'logo_left_path',
                'logo_right': 'logo_right_path',
                'seal': 'seal_image_path',
                'watermark': 'watermark_image_path',
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
