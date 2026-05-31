/**
 * lib/routes/sms.js — SMS System API 모듈
 *
 * 추출 시점: 2026-05-31 (A-11 모듈 추출 1단계)
 * 출처: server.js 라인 11074~11308 (235줄)
 *
 * 6 routes:
 *   GET    /api/admin/sms/config       — 설정 조회 (api_key 마스킹)
 *   POST   /api/admin/sms/config       — 설정 저장
 *   POST   /api/admin/sms/preview      — 메시지 길이/종류 미리보기
 *   POST   /api/admin/sms/send         — 단건 발송
 *   POST   /api/admin/sms/batch-send   — 대량 발송 (상장 모드 등)
 *   GET    /api/admin/sms/log          — 발송 이력 조회
 *
 * 모든 라우트는 admin_key 필수 (req.body.admin_key 또는 req.query.admin_key)
 *
 * 의존성 주입 (server.js 에서 mount 시):
 *   - db                       : DB 어댑터
 *   - isAdminKey               : 관리자 키 검증 함수
 *   - SMS                      : ./lib/smsSender 모듈
 *   - getEventResultsForCert   : 종목별 상위/완주자 결과 조회 헬퍼
 *                                (현재 server.js 의 함수, certificate 모듈 추출 시 함께 이동 예정)
 */
module.exports = function mountSmsRoutes(app, deps) {
    const { db, isAdminKey, SMS, getEventResultsForCert } = deps;
    if (!app) throw new Error('[lib/routes/sms] app required');
    if (!db) throw new Error('[lib/routes/sms] db required');
    if (!isAdminKey) throw new Error('[lib/routes/sms] isAdminKey required');
    if (!SMS) throw new Error('[lib/routes/sms] SMS module required');
    if (!getEventResultsForCert) throw new Error('[lib/routes/sms] getEventResultsForCert required');

    // 월 카운터 리셋 헬퍼 (async) — 내부 전용
    async function _resetSmsCounterIfNeeded(cfg) {
        const now = new Date();
        const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        if (cfg.last_reset_month !== ym) {
            await db.run('UPDATE sms_config SET sent_this_month=0, last_reset_month=? WHERE id=1', ym);
            cfg.sent_this_month = 0;
            cfg.last_reset_month = ym;
        }
        return cfg;
    }

    // SMS 설정 조회
    app.get('/api/admin/sms/config', async (req, res) => {
        try {
            const adminKey = req.query.admin_key;
            if (!isAdminKey(adminKey)) return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
            const cfg = await db.get('SELECT * FROM sms_config WHERE id=1');
            if (!cfg) return res.status(500).json({ error: 'sms_config가 초기화되지 않았습니다.' });
            await _resetSmsCounterIfNeeded(cfg);
            // api_key는 마스킹
            const masked = Object.assign({}, cfg, {
                api_key: cfg.api_key ? '***' + cfg.api_key.slice(-4) : '',
                api_key_set: !!cfg.api_key,
            });
            res.json({ config: masked });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // SMS 설정 저장
    app.post('/api/admin/sms/config', async (req, res) => {
        try {
            const { admin_key, provider, api_key, user_id, sender_number, sender_name, sim_mode, default_template, monthly_quota } = req.body || {};
            if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
            const cur = await db.get('SELECT * FROM sms_config WHERE id=1');
            const now = new Date().toISOString();
            // api_key가 빈 문자열이면 기존 유지 (편의)
            const finalApiKey = (api_key === undefined || api_key === '***UNCHANGED***') ? (cur ? cur.api_key : '') : (api_key || '');
            await db.run(`UPDATE sms_config SET
                provider=?, api_key=?, user_id=?, sender_number=?, sender_name=?,
                sim_mode=?, default_template=?, monthly_quota=?, updated_at=?
                WHERE id=1`,
                provider || (cur && cur.provider) || 'aligo',
                finalApiKey,
                user_id || '',
                SMS.normalizePhone(sender_number || ''),
                sender_name || '',
                sim_mode ? 1 : 0,
                default_template || (cur && cur.default_template) || '',
                parseInt(monthly_quota || 0, 10),
                now
            );
            res.json({ success: true });
        } catch (err) {
            console.error('[SMS][config]', err);
            res.status(500).json({ error: err.message });
        }
    });

    // 메시지 길이/종류 미리보기
    app.post('/api/admin/sms/preview', (req, res) => {
        try {
            const { admin_key, message } = req.body || {};
            if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
            const bytes = SMS.getMessageBytes(message || '');
            const msgType = SMS.detectMessageType(message || '');
            const cost = msgType === 'LMS' ? 35 : 13;
            res.json({ bytes, msg_type: msgType, est_cost_per_msg: cost });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // 단건 발송
    app.post('/api/admin/sms/send', async (req, res) => {
        try {
            const { admin_key, phone, message, title, competition_id, athlete_id, triggered_by } = req.body || {};
            if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
            const cfg = await db.get('SELECT * FROM sms_config WHERE id=1');
            if (!cfg) return res.status(500).json({ error: 'sms_config가 초기화되지 않았습니다.' });
            await _resetSmsCounterIfNeeded(cfg);

            const result = await SMS.sendOne(cfg, { phone, message, title });

            // 로그 기록
            await db.run(`INSERT INTO sms_log
                (competition_id, athlete_id, phone_number, message, status, provider, provider_msg_id, error_message, cost, sent_at, triggered_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                competition_id || null,
                athlete_id || null,
                SMS.normalizePhone(phone),
                message,
                result.status,
                cfg.provider,
                result.provider_msg_id,
                result.error_message,
                result.cost,
                new Date().toISOString(),
                triggered_by || 'manual'
            );

            if (result.status === 'sent' || result.status === 'simulated') {
                await db.run('UPDATE sms_config SET sent_this_month = sent_this_month + 1 WHERE id=1');
            }

            res.json({ success: true, ...result });
        } catch (err) {
            console.error('[SMS][send]', err);
            res.status(500).json({ error: err.message });
        }
    });

    // 일괄 발송 (대회+종목+상장 모드 등 → 자동 메시지 생성)
    app.post('/api/admin/sms/batch-send', async (req, res) => {
        try {
            const { admin_key, competition_id, event_ids, rank_from, rank_to, include_finishers,
                    template, triggered_by, cert_url_base } = req.body || {};
            if (!isAdminKey(admin_key)) return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
            if (!competition_id) return res.status(400).json({ error: 'competition_id 필요' });

            const cfg = await db.get('SELECT * FROM sms_config WHERE id=1');
            if (!cfg) return res.status(500).json({ error: 'sms_config가 초기화되지 않았습니다.' });
            await _resetSmsCounterIfNeeded(cfg);

            const comp = await db.get('SELECT * FROM competition WHERE id=?', competition_id);
            if (!comp) return res.status(404).json({ error: '대회를 찾을 수 없습니다.' });

            let targetEventIds = Array.isArray(event_ids) ? event_ids.slice() : [];
            if (targetEventIds.length === 0) {
                const all = await db.all(`SELECT id FROM event WHERE competition_id=? AND round_type='final' ORDER BY sort_order, id`, competition_id);
                targetEventIds = all.map(e => e.id);
            }

            const rankFrom = Math.max(1, parseInt(rank_from || 1, 10));
            const rankTo = Math.max(rankFrom, parseInt(rank_to || 3, 10));
            const wantFinishers = !!include_finishers;
            const tplMsg = template || cfg.default_template;

            const recipients = [];
            for (const eid of targetEventIds) {
                const { event, rows } = await getEventResultsForCert(eid);
                if (!event) continue;
                for (const row of rows) {
                    // 선수 폰번호 조회 (athlete table에 phone 컬럼이 있어야 함 — 없으면 빈 칸으로 시뮬레이션)
                    let include = false;
                    if (row.rank != null && row.rank >= rankFrom && row.rank <= rankTo) include = true;
                    if (!include && wantFinishers && row.finished) include = true;
                    if (!include) continue;

                    const ath = await db.get('SELECT * FROM athlete WHERE id=?', row.athlete_id);
                    const phone = ath && (ath.phone || ath.phone_number || '') || '';
                    const message = SMS.fillMessageTemplate(tplMsg, {
                        athlete_name: row.athlete_name,
                        team: row.team,
                        event_name: event.name,
                        rank: row.rank == null ? '' : row.rank,
                        rank_label: row.rank == null ? '완주' : (row.rank === 1 ? '우승' : row.rank === 2 ? '준우승' : `${row.rank}위`),
                        record_value: row.record_value,
                        competition_name: comp.name,
                        cert_url: cert_url_base ? `${cert_url_base}/${row.athlete_id}` : '',
                    });
                    recipients.push({ athlete_id: row.athlete_id, athlete_name: row.athlete_name, phone, message });
                }
            }

            // 발송 (순차 — 알리고 동시연결 제한 회피)
            const results = [];
            for (const r of recipients) {
                const sendResult = await SMS.sendOne(cfg, { phone: r.phone, message: r.message });
                await db.run(`INSERT INTO sms_log
                    (competition_id, athlete_id, phone_number, message, status, provider, provider_msg_id, error_message, cost, sent_at, triggered_by)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    competition_id,
                    r.athlete_id,
                    SMS.normalizePhone(r.phone),
                    r.message,
                    sendResult.status,
                    cfg.provider,
                    sendResult.provider_msg_id,
                    sendResult.error_message,
                    sendResult.cost,
                    new Date().toISOString(),
                    triggered_by || 'cert_batch'
                );
                if (sendResult.status === 'sent' || sendResult.status === 'simulated') {
                    await db.run('UPDATE sms_config SET sent_this_month = sent_this_month + 1 WHERE id=1');
                }
                results.push({
                    athlete_id: r.athlete_id,
                    athlete_name: r.athlete_name,
                    phone: r.phone,
                    status: sendResult.status,
                    error: sendResult.error_message,
                });
            }

            const summary = results.reduce((acc, r) => {
                acc[r.status] = (acc[r.status] || 0) + 1;
                return acc;
            }, {});

            res.json({ success: true, sim_mode: !!cfg.sim_mode, total: results.length, summary, results });
        } catch (err) {
            console.error('[SMS][batch-send]', err);
            res.status(500).json({ error: err.message });
        }
    });

    // 발송 이력
    app.get('/api/admin/sms/log', async (req, res) => {
        try {
            const adminKey = req.query.admin_key;
            if (!isAdminKey(adminKey)) return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
            const compId = req.query.competition_id;
            const limit = Math.min(parseInt(req.query.limit || 200, 10), 1000);
            const where = compId ? 'WHERE l.competition_id=?' : '';
            const params = compId ? [compId, limit] : [limit];
            const rows = await db.all(`
                SELECT l.*, a.name AS athlete_name, a.team
                FROM sms_log l
                LEFT JOIN athlete a ON a.id = l.athlete_id
                ${where}
                ORDER BY l.sent_at DESC
                LIMIT ?
            `, ...params);
            res.json({ logs: rows });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
};
