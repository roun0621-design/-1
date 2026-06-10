/**
 * 행사(event) 간편 기록입력 — 소집실 없이 선수 즉석 등록 + 거리 기록(최고기록만) + 기록증 수동 발송.
 *
 *   POST /api/event/:slug/record     — 선수 등록 + 종목 출전 + 거리 기록(best 갱신)
 *   GET  /api/event/:slug/records    — 종목별 참가자 + 최고거리 + 순위
 *   POST /api/event/:slug/send-cert  — 해당 참가자에게 기록증 문자 발송(수동)
 *
 * 인증: 운영키 또는 관리자키(body.key / query.key / x-admin-key).
 * 화이트라벨 분리를 위해 일반 운영/노출 라우트와 독립.
 */
module.exports = function mountEventRecordRoutes(app, deps) {
    const { db, isAdminKey, isOperationKey, SMS } = deps;

    async function getEventComp(slug) {
        return db.get('SELECT * FROM competition WHERE event_slug=?', String(slug || '').toLowerCase());
    }
    function staffKey(req) {
        return (req.body && req.body.key) || (req.query && req.query.key) || req.headers['x-admin-key'] || '';
    }
    function authStaff(req) {
        const k = staffKey(req);
        return !!k && (isAdminKey(k) || isOperationKey(k));
    }
    const normPhone = (p) => String(p || '').replace(/[^0-9]/g, '');

    // ── 기록 저장: 즉석 등록 + best 거리 갱신 ──
    app.post('/api/event/:slug/record', async (req, res) => {
        try {
            if (!authStaff(req)) return res.status(403).json({ error: '운영 권한이 필요합니다.' });
            const comp = await getEventComp(req.params.slug);
            if (!comp || comp.mode !== 'event') return res.status(404).json({ error: '행사를 찾을 수 없습니다.' });

            const { event_id, name, team, gender, phone } = req.body || {};
            const dist = parseFloat(req.body && req.body.distance_meters);
            if (!event_id) return res.status(400).json({ error: '종목을 선택하세요.' });
            if (!name || !String(name).trim()) return res.status(400).json({ error: '이름을 입력하세요.' });
            if (!(dist >= 0)) return res.status(400).json({ error: '거리를 올바르게 입력하세요.' });

            const ev = await db.get('SELECT * FROM event WHERE id=? AND competition_id=?', event_id, comp.id);
            if (!ev) return res.status(404).json({ error: '종목을 찾을 수 없습니다.' });

            const nm = String(name).trim();
            const tm = String(team || '').trim();
            const g = (gender === 'F') ? 'F' : 'M'; // athlete.gender CHECK = M/F
            const ph = normPhone(phone);

            const out = await db.transaction(async () => {
                // 1) 선수 찾기/등록 — 전화 있으면 (이름+전화), 없으면 (이름+소속) 으로 동일인 판단
                let ath = null;
                const cands = await db.all('SELECT * FROM athlete WHERE competition_id=? AND name=?', comp.id, nm);
                for (const c of cands) {
                    const cph = normPhone(c.phone);
                    if (ph && cph && cph === ph) { ath = c; break; }
                    if (!ph && (String(c.team || '').trim() === tm)) { ath = c; break; }
                }
                if (!ath) {
                    const ins = await db.run('INSERT INTO athlete (competition_id, name, team, gender, phone) VALUES (?,?,?,?,?)',
                        comp.id, nm, tm, g, ph);
                    ath = await db.get('SELECT * FROM athlete WHERE id=?', ins.lastInsertRowid);
                } else {
                    // 최신 정보로 보강(전화/소속/성별 채워주기)
                    await db.run('UPDATE athlete SET team=?, gender=?, phone=? WHERE id=?',
                        tm || ath.team, g, ph || ath.phone, ath.id);
                }

                // 2) 출전(event_entry) 보장
                let entry = await db.get('SELECT * FROM event_entry WHERE event_id=? AND athlete_id=?', ev.id, ath.id);
                if (!entry) {
                    const ie = await db.run('INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?,?)', ev.id, ath.id, 'checked_in');
                    entry = await db.get('SELECT * FROM event_entry WHERE id=?', ie.lastInsertRowid);
                }

                // 3) heat 보장(행사는 단일 heat #1)
                let heat = await db.get('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number LIMIT 1', ev.id);
                if (!heat) {
                    const ih = await db.run('INSERT INTO heat (event_id, heat_number) VALUES (?,1)', ev.id);
                    heat = await db.get('SELECT * FROM heat WHERE id=?', ih.lastInsertRowid);
                }
                let he = await db.get('SELECT * FROM heat_entry WHERE heat_id=? AND event_entry_id=?', heat.id, entry.id);
                if (!he) {
                    await db.run('INSERT INTO heat_entry (heat_id, event_entry_id) VALUES (?,?)', heat.id, entry.id);
                }

                // 4) result — best 거리만 유지(attempt 1 단일 행 upsert)
                const cur = await db.get('SELECT * FROM result WHERE heat_id=? AND event_entry_id=? AND attempt_number=1', heat.id, entry.id);
                let improved = true, best = dist;
                if (cur) {
                    const prev = (cur.distance_meters == null) ? -1 : cur.distance_meters;
                    if (dist > prev) {
                        await db.run('UPDATE result SET distance_meters=?, updated_at=? WHERE id=?', dist, new Date().toISOString(), cur.id);
                        best = dist; improved = true;
                    } else {
                        best = prev; improved = false; // 기존 최고기록 유지
                    }
                } else {
                    await db.run('INSERT INTO result (heat_id, event_entry_id, attempt_number, distance_meters) VALUES (?,?,1,?)', heat.id, entry.id, dist);
                    best = dist; improved = true;
                }
                return { athlete_id: ath.id, entry_id: entry.id, name: nm, team: tm, gender: g, phone: ph, this_distance: dist, best, improved };
            })();

            res.json({ success: true, ...out });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ── 참가자 목록 + 최고거리 + 순위 ──
    app.get('/api/event/:slug/records', async (req, res) => {
        try {
            if (!authStaff(req)) return res.status(403).json({ error: '운영 권한이 필요합니다.' });
            const comp = await getEventComp(req.params.slug);
            if (!comp || comp.mode !== 'event') return res.status(404).json({ error: '행사를 찾을 수 없습니다.' });
            const eventId = req.query.event_id;
            if (!eventId) return res.status(400).json({ error: 'event_id 필요' });

            const rows = await db.all(
                `SELECT ee.id AS entry_id, a.id AS athlete_id, a.name, a.team, a.gender, a.phone,
                        (SELECT MAX(r.distance_meters) FROM result r WHERE r.event_entry_id = ee.id) AS best
                 FROM event_entry ee JOIN athlete a ON a.id = ee.athlete_id
                 WHERE ee.event_id = ?`, eventId);
            // 거리 내림차순 정렬 + 순위(백엔드 무관하게 JS 에서)
            rows.forEach(r => { r.best = (r.best == null) ? null : Number(r.best); });
            rows.sort((a, b) => (b.best ?? -1) - (a.best ?? -1));
            let rank = 0, shown = 0, prev = null;
            rows.forEach(r => {
                shown++;
                if (r.best == null) { r.rank = null; return; }
                if (prev === null || r.best < prev) { rank = shown; prev = r.best; }
                r.rank = rank;
            });
            res.json(rows);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ── 기록증 문자 수동 발송 ──
    app.post('/api/event/:slug/send-cert', async (req, res) => {
        try {
            if (!authStaff(req)) return res.status(403).json({ error: '운영 권한이 필요합니다.' });
            const comp = await getEventComp(req.params.slug);
            if (!comp || comp.mode !== 'event') return res.status(404).json({ error: '행사를 찾을 수 없습니다.' });
            const { entry_id } = req.body || {};
            if (!entry_id) return res.status(400).json({ error: 'entry_id 필요' });

            const row = await db.get(
                `SELECT ee.id AS entry_id, ee.event_id, a.id AS athlete_id, a.name, a.team, a.phone,
                        e.name AS event_name,
                        (SELECT MAX(r.distance_meters) FROM result r WHERE r.event_entry_id = ee.id) AS best
                 FROM event_entry ee JOIN athlete a ON a.id = ee.athlete_id
                 JOIN event e ON e.id = ee.event_id
                 WHERE ee.id = ?`, entry_id);
            if (!row) return res.status(404).json({ error: '참가자를 찾을 수 없습니다.' });
            const phone = normPhone(row.phone);
            if (!phone) return res.status(400).json({ error: '전화번호가 없어 발송할 수 없습니다.' });

            const cfg = await db.get('SELECT * FROM sms_config WHERE id=1');
            if (!cfg) return res.status(500).json({ error: 'SMS 설정이 초기화되지 않았습니다.' });

            const distTxt = (row.best == null) ? '기록 없음' : (Number(row.best) + ' m');
            const message = `[${comp.name}] ${row.name}님\n${row.event_name}\n기록: ${distTxt}\n참가해 주셔서 감사합니다.\n\nPowered by PACE RISE`;

            const result = await SMS.sendOne(cfg, { phone, message, title: comp.name });
            await db.run(`INSERT INTO sms_log
                (competition_id, athlete_id, phone_number, message, status, provider, provider_msg_id, error_message, cost, sent_at, triggered_by)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
                comp.id, row.athlete_id, SMS.normalizePhone(phone), message, result.status, cfg.provider,
                result.provider_msg_id, result.error_message, result.cost, new Date().toISOString(), 'event-record');
            if (result.status === 'sent' || result.status === 'simulated') {
                await db.run('UPDATE sms_config SET sent_this_month = sent_this_month + 1 WHERE id=1');
            }
            res.json({ success: true, status: result.status });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
};
