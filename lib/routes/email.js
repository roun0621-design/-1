'use strict';
/**
 * 이메일 — 설정·시험 발송·기록증 일괄 발송·이력 (D12, 2026-10-12). 문자(sms.js)와 같은 틀, 조직별 설정.
 *   GET  /api/admin/email/config              설정(비밀번호는 설정 여부만)
 *   POST /api/admin/email/config              저장 (smtp_pass 가 '***UNCHANGED***' 면 유지)
 *   POST /api/admin/email/test                { to } 시험 발송 (force_real 이면 시뮬레이션이어도 이 한 통은 실제로)
 *   POST /api/admin/email/send-certificates   { competition_id, event_ids?, rank_from, rank_to, include_finishers, subject?, body?, skip_sent, force_real }
 *                                             — 문자 일괄 발송과 같은 대상 규칙(getEventResultsForCert), 선수 email 로 기록증 링크(/c/:token) 발송
 *   GET  /api/admin/email/log?competition_id= 이력
 *   deps: db, isAdminKey, Mail(lib/mailer), getEventResultsForCert
 */
const { buildCertToken } = require('../certLink');

module.exports = function mountEmailRoutes(app, deps) {
    const { db, isAdminKey, Mail, getEventResultsForCert } = deps;
    for (const k of ['db', 'isAdminKey', 'Mail', 'getEventResultsForCert']) if (!deps[k]) throw new Error(`[email] mount requires deps.${k}`);
    const orgOf = req => (req.org && req.org.id) || 1;
    const _running = new Set();

    app.get('/api/admin/email/config', async (req, res) => {
        if (!isAdminKey(req.query.admin_key || req.headers['x-admin-key'])) return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
        const c = await Mail.getEmailConfig(db, orgOf(req));
        const { smtp_pass, ...rest } = c;
        res.json({ config: { ...rest, smtp_pass_set: !!smtp_pass, default_subject: c.default_subject || Mail.DEFAULT_SUBJECT, default_body: c.default_body || Mail.DEFAULT_BODY } });
    });

    app.post('/api/admin/email/config', async (req, res) => {
        const b = req.body || {};
        if (!isAdminKey(b.admin_key)) return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
        const cur = await Mail.getEmailConfig(db, orgOf(req));
        const port = parseInt(b.smtp_port, 10);
        if (b.from_address && !Mail.isValidEmail(b.from_address)) return res.status(400).json({ error: `보내는 주소가 이메일 형식이 아닙니다: ${b.from_address}` });
        await db.run(`UPDATE email_config SET smtp_host=?, smtp_port=?, smtp_secure=?, smtp_user=?, smtp_pass=?, from_address=?, from_name=?, sim_mode=?, default_subject=?, default_body=?, updated_at=? WHERE id=?`,
            String(b.smtp_host ?? cur.smtp_host ?? '').trim(), Number.isFinite(port) && port > 0 ? port : (cur.smtp_port || 587),
            b.smtp_secure === undefined ? (cur.smtp_secure || 0) : (b.smtp_secure && b.smtp_secure !== 'false' ? 1 : 0),
            String(b.smtp_user ?? cur.smtp_user ?? '').trim(), (b.smtp_pass === undefined || b.smtp_pass === '***UNCHANGED***') ? (cur.smtp_pass || '') : String(b.smtp_pass),
            String(b.from_address ?? cur.from_address ?? '').trim(), String(b.from_name ?? cur.from_name ?? '').trim(),
            b.sim_mode === undefined ? (cur.sim_mode == null ? 1 : cur.sim_mode) : (b.sim_mode && b.sim_mode !== 'false' ? 1 : 0),
            String(b.default_subject ?? cur.default_subject ?? ''), String(b.default_body ?? cur.default_body ?? ''), new Date().toISOString(), cur.id);
        Mail._resetTransports();
        res.json({ success: true });
    });

    app.post('/api/admin/email/test', async (req, res) => {
        const b = req.body || {};
        if (!isAdminKey(b.admin_key)) return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
        if (!Mail.isValidEmail(b.to)) return res.status(400).json({ error: `받는 주소가 이메일 형식이 아닙니다: ${b.to || ''}` });
        let cfg = await Mail.getEmailConfig(db, orgOf(req));
        if (b.force_real) {
            if (!cfg.smtp_host || !cfg.from_address) return res.status(400).json({ error: '실제로 보내려면 SMTP 호스트와 보내는 주소를 먼저 저장하세요.' });
            cfg = { ...cfg, sim_mode: 0 };
        }
        const r = await Mail.sendOne(cfg, { to: b.to, subject: b.subject || '[PACE RISE : Node] 이메일 시험 발송', text: b.text || '이메일 설정이 올바르게 됐습니다.\n\nPACE RISE : Node' });
        await Mail.logSend(db, { organization_id: orgOf(req), to_address: b.to, subject: b.subject || '시험 발송', ...r, triggered_by: 'test' });
        res.status(r.status === 'failed' ? 502 : 200).json({ success: r.status !== 'failed', ...r });
    });

    app.post('/api/admin/email/send-certificates', async (req, res) => {
        const b = req.body || {};
        if (!isAdminKey(b.admin_key)) return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
        const compId = parseInt(b.competition_id, 10);
        if (!compId) return res.status(400).json({ error: 'competition_id 필요' });
        const comp = await db.get('SELECT * FROM competition WHERE id=?', compId);
        if (!comp) return res.status(404).json({ error: '대회를 찾을 수 없습니다.' });
        let cfg = await Mail.getEmailConfig(db, orgOf(req));
        if (b.force_real) {
            if (!cfg.smtp_host || !cfg.from_address) return res.status(400).json({ error: '실제로 보내려면 SMTP 호스트와 보내는 주소를 먼저 저장하세요.' });
            cfg = { ...cfg, sim_mode: 0 };
        }
        let org = null; try { org = await db.get('SELECT name, site_name FROM organization WHERE id=?', orgOf(req)); } catch (e) { /* SQLite 는 동기 — .catch 불가 */ }
        const orgName = (org && (org.site_name || org.name)) || 'PACE RISE : Node';
        let eventIds = Array.isArray(b.event_ids) ? b.event_ids.map(x => parseInt(x, 10)).filter(Boolean) : [];
        if (!eventIds.length) eventIds = (await db.all(`SELECT id FROM event WHERE competition_id=? AND round_type='final' ORDER BY sort_order, id`, compId)).map(e => e.id);
        const rankFrom = Math.max(1, parseInt(b.rank_from || 1, 10)), rankTo = Math.max(rankFrom, parseInt(b.rank_to || 3, 10));
        const wantFinishers = !!b.include_finishers, skipSent = b.skip_sent !== false && b.skip_sent !== 'false';
        const subjectTpl = b.subject || cfg.default_subject || Mail.DEFAULT_SUBJECT, bodyTpl = b.body || cfg.default_body || Mail.DEFAULT_BODY;
        const baseUrl = String(b.cert_url_base || process.env.PUBLIC_BASE_URL || (req.get && req.get('host') ? `https://${req.get('host')}` : '')).replace(/\/+$/, '');
        const realRun = !Number(cfg.sim_mode) && !!cfg.smtp_host;
        const dedupe = realRun ? "('sent')" : "('sent','simulated')";
        const sentKeys = new Set();
        if (skipSent) for (const s of await db.all(`SELECT event_id, athlete_id FROM email_log WHERE competition_id=? AND status IN ${dedupe}`, compId)) sentKeys.add(`${s.event_id}|${s.athlete_id}`);
        if (_running.has(String(compId))) return res.status(409).json({ error: '이 대회의 이메일 일괄 발송이 아직 진행 중입니다.', in_progress: true });
        _running.add(String(compId));
        const out = { total: 0, sent: 0, simulated: 0, skipped: 0, failed: 0, skipped_sent: 0, no_email: 0, results: [] };
        try {
            for (const eid of eventIds) {
                const { event, rows } = await getEventResultsForCert(eid);
                if (!event) continue;
                for (const row of rows) {
                    const rank = row.rank;
                    let include = rank != null && rank >= rankFrom && rank <= rankTo && row.finished;
                    if (!include && wantFinishers && row.finished) include = true;
                    if (!include) continue;
                    if (skipSent && sentKeys.has(`${eid}|${row.athlete_id}`)) { out.skipped_sent++; continue; }
                    const ath = await db.get('SELECT id, name, email FROM athlete WHERE id=?', row.athlete_id);
                    const to = (ath && ath.email || '').trim();
                    if (!to) { out.no_email++; continue; }
                    let certUrl = '';
                    if (baseUrl) certUrl = `${baseUrl}/c/${await buildCertToken(db, { competitionId: compId, eventId: eid, athleteId: row.athlete_id })}`;
                    const vars = { athlete_name: row.athlete_name, team: row.team || '', event_name: event.name, competition_name: comp.name_en && /[a-z]/i.test(String(b.lang || '')) ? comp.name_en : comp.name,
                        rank_label: rank == null ? '완주' : rank === 1 ? '우승' : rank === 2 ? '준우승' : `${rank}위`, rank: rank == null ? '' : rank, record_value: row.record_value || '', cert_url: certUrl, org_name: orgName, heat: row.heat_number || '' };
                    const subject = Mail.fillTemplate(subjectTpl, vars), text = Mail.fillTemplate(bodyTpl, vars);
                    const r = await Mail.sendOne(cfg, { to, subject, text });
                    await Mail.logSend(db, { organization_id: orgOf(req), competition_id: compId, athlete_id: row.athlete_id, event_id: eid, to_address: to, subject, ...r, triggered_by: 'certificate' });
                    out.total++; out[r.status] = (out[r.status] || 0) + 1;
                    out.results.push({ event_id: eid, athlete_id: row.athlete_id, name: row.athlete_name, to, status: r.status, error: r.error_message || '' });
                }
            }
        } finally { _running.delete(String(compId)); }
        res.json({ success: true, ...out });
    });

    app.get('/api/admin/email/log', async (req, res) => {
        if (!isAdminKey(req.query.admin_key || req.headers['x-admin-key'])) return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
        const compId = parseInt(req.query.competition_id, 10) || 0;
        const limit = Math.min(500, parseInt(req.query.limit, 10) || 200);
        const rows = compId
            ? await db.all(`SELECT l.*, a.name AS athlete_name, e.name AS event_name FROM email_log l LEFT JOIN athlete a ON a.id=l.athlete_id LEFT JOIN event e ON e.id=l.event_id WHERE l.organization_id=? AND l.competition_id=? ORDER BY l.id DESC LIMIT ?`, orgOf(req), compId, limit)
            : await db.all(`SELECT l.*, a.name AS athlete_name, e.name AS event_name FROM email_log l LEFT JOIN athlete a ON a.id=l.athlete_id LEFT JOIN event e ON e.id=l.event_id WHERE l.organization_id=? ORDER BY l.id DESC LIMIT ?`, orgOf(req), limit);
        res.json({ logs: rows });
    });
};
