/**
 * Relay Member routes
 *
 * server.js 에서 추출됨 (2단계 모듈 분리 — 2차).
 * 외부 의존성: db, orderByBibSql
 *
 * 사용법:
 *   require('./lib/routes/relay_members')(app, { db, orderByBibSql });
 *
 * 라우트 (5개):
 *   GET    /api/relay-members              (event_id+team OR event_entry_id 로 조회)
 *   GET    /api/relay-members/batch        (event_id 의 모든 팀 일괄 조회)
 *   POST   /api/relay-members              (멤버 추가)
 *   DELETE /api/relay-members              (멤버 삭제)
 *   PUT    /api/relay-members/order        (leg_order 재정렬)
 *
 * ⚠️ Express 라우트 등록 순서 주의:
 *   /api/relay-members/batch 와 /api/relay-members/order 는 정적 경로라
 *   /api/relay-members 보다 먼저 등록될 필요는 없음 (메서드/경로 모두 다르므로).
 *   하지만 명확성 위해 GET batch 를 GET 일반보다 먼저 등록.
 */
module.exports = function mountRelayMemberRoutes(app, deps) {
    const { db, orderByBibSql } = deps;
    if (!app || !db || !orderByBibSql) {
        throw new Error('[relay_members.js] mount requires { db, orderByBibSql }');
    }

    // GET /api/relay-members/batch — event_id 의 모든 relay 팀 멤버 일괄 조회
    app.get('/api/relay-members/batch', async (req, res) => {
        const eventId = parseInt(req.query.event_id);
        if (!eventId) return res.status(400).json({ error: 'event_id required' });

        // Get all event_entries for this relay event
        const entries = await db.all(`
            SELECT ee.id AS event_entry_id, a.name AS team_name, a.id AS athlete_id
            FROM event_entry ee JOIN athlete a ON a.id = ee.athlete_id
            WHERE ee.event_id = ?
        `, eventId);

        // For each entry, fetch relay members
        const result = {};
        for (const entry of entries) {
            const members = await db.all(`
                SELECT a.id, a.name, a.team, a.bib_number, a.gender, rm.leg_order
                FROM relay_member rm JOIN athlete a ON a.id = rm.athlete_id
                WHERE rm.event_entry_id = ?
                ORDER BY rm.leg_order, a.name
            `, entry.event_entry_id);
            if (members.length > 0) {
                result[entry.event_entry_id] = { team_name: entry.team_name, members };
            }
        }
        res.json(result);
    });

    // GET /api/relay-members — 단일 팀의 멤버 조회
    // 입력: event_entry_id OR (event_id + team)
    app.get('/api/relay-members', async (req, res) => {
        const { event_id, team, event_entry_id } = req.query;
        if (!event_id && !event_entry_id) {
            return res.status(400).json({ error: 'event_id or event_entry_id required' });
        }

        let entryId = event_entry_id;
        if (!entryId && event_id && team) {
            const evt = await db.get('SELECT * FROM event WHERE id=?', event_id);
            if (!evt) return res.status(404).json({ error: 'Event not found' });
            const teamEntry = await db.get(`
                SELECT ee.id FROM event_entry ee
                JOIN athlete a ON a.id = ee.athlete_id
                WHERE ee.event_id = ? AND a.name = ?
            `, event_id, team);
            if (!teamEntry) return res.json([]);
            entryId = teamEntry.id;
        }
        if (!entryId) return res.json([]);

        // Return only athletes registered in relay_member for this entry
        const members = await db.all(`
            SELECT a.*, rm.leg_order, rm.event_entry_id FROM relay_member rm
            JOIN athlete a ON a.id = rm.athlete_id
            WHERE rm.event_entry_id = ?
            ORDER BY rm.leg_order, ${orderByBibSql('a.bib_number')}
        `, entryId);
        res.json(members);
    });

    // POST /api/relay-members — 멤버 추가
    app.post('/api/relay-members', async (req, res) => {
        const { event_entry_id, athlete_id, leg_order } = req.body;
        if (!event_entry_id || !athlete_id) {
            return res.status(400).json({ error: 'event_entry_id and athlete_id required' });
        }
        try {
            // ── 계주 팀 구성 규칙 (WA TR 24, 2026-09 Phase 2) ──
            //   · 한 팀은 6명까지(주자 4 + 예비 2), 선수는 같은 종목에서 한 팀에만
            //   · 남자/여자 계주에 다른 성별 불가, 혼성(X)은 남 2·여 2 (중고연맹 요강도 동일)
            const ev = await db.get('SELECT e.id AS event_id, e.gender, e.category, e.name FROM event_entry ee JOIN event e ON e.id=ee.event_id WHERE ee.id=?', event_entry_id);
            const add = await db.get('SELECT id, name, gender FROM athlete WHERE id=?', athlete_id);
            if (!ev) return res.status(404).json({ error: '출전 항목을 찾을 수 없습니다.' });
            if (!add) return res.status(404).json({ error: '선수를 찾을 수 없습니다.' });
            const already = await db.get('SELECT 1 AS x FROM relay_member WHERE event_entry_id=? AND athlete_id=?', event_entry_id, athlete_id);
            if (!already) {
                const cur = await db.all('SELECT a.gender FROM relay_member rm JOIN athlete a ON a.id=rm.athlete_id WHERE rm.event_entry_id=?', event_entry_id);
                if (cur.length >= 6) return res.status(400).json({ error: '계주 팀은 6명까지입니다 (주자 4명 + 예비 2명, WA TR 24)' });
                const other = await db.get(`SELECT a.name AS team FROM relay_member rm JOIN event_entry ee ON ee.id=rm.event_entry_id JOIN athlete a ON a.id=ee.athlete_id
                                            WHERE ee.event_id=? AND rm.athlete_id=? AND rm.event_entry_id<>?`, ev.event_id, athlete_id, event_entry_id);
                if (other) return res.status(400).json({ error: `${add.name} 선수는 같은 종목의 다른 팀(${other.team})에 이미 들어 있습니다` });
                if ((ev.gender === 'M' || ev.gender === 'F') && add.gender && add.gender !== ev.gender) {
                    return res.status(400).json({ error: `${ev.gender === 'M' ? '남자' : '여자'} 계주에 ${add.gender === 'M' ? '남자' : '여자'} 선수(${add.name})는 들어갈 수 없습니다` });
                }
                if (ev.gender === 'X' && require('../kjafRules').isRelay(ev)) {
                    const chk = require('../kjafRules').checkMixedRelay(cur.map(x => x.gender), add.gender);
                    if (!chk.ok) return res.status(400).json({ error: '혼성 계주 구성: ' + chk.error });
                }
            }
            // 주자 순서 1~4 만 순서로, 5·6번째(예비)는 순서 없음
            const leg = Number(leg_order) >= 1 && Number(leg_order) <= 4 ? Number(leg_order) : null;
            await db.run(
                'INSERT OR IGNORE INTO relay_member (event_entry_id, athlete_id, leg_order) VALUES (?,?,?)',
                event_entry_id, athlete_id, leg
            );
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // DELETE /api/relay-members — 멤버 삭제
    app.delete('/api/relay-members', async (req, res) => {
        const { event_entry_id, athlete_id } = req.body;
        if (!event_entry_id || !athlete_id) {
            return res.status(400).json({ error: 'event_entry_id and athlete_id required' });
        }
        await db.run(
            'DELETE FROM relay_member WHERE event_entry_id=? AND athlete_id=?',
            event_entry_id, athlete_id
        );
        res.json({ success: true });
    });

    // PUT /api/relay-members/order — leg_order 재정렬
    app.put('/api/relay-members/order', async (req, res) => {
        const { event_entry_id, members } = req.body;
        if (!event_entry_id || !Array.isArray(members)) {
            return res.status(400).json({ error: 'event_entry_id and members array required' });
        }
        // 주자 순서는 1~4, 같은 구간에 두 명 불가 (예비는 순서 없음 = null)
        const legs = members.map(m => m.leg_order).filter(l => l != null && l !== '');
        if (legs.some(l => !(Number(l) >= 1 && Number(l) <= 4))) return res.status(400).json({ error: '주자 순서는 1~4 입니다 (예비 선수는 비워 두세요)' });
        if (new Set(legs.map(Number)).size !== legs.length) return res.status(400).json({ error: '같은 구간에 두 명을 둘 수 없습니다' });
        try {
            await db.transaction(async () => {
                for (const m of members) {
                    await db.run(
                        'UPDATE relay_member SET leg_order=? WHERE event_entry_id=? AND athlete_id=?',
                        m.leg_order == null || m.leg_order === '' ? null : Number(m.leg_order), event_entry_id, m.athlete_id
                    );
                }
            })();
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
};
