'use strict';
/**
 * 공개 읽기 API v1 (2026-10-12, 해외 D14 "공개 읽기 API 정식화")
 *   전광판 제조사·방송·외부 결과 사이트가 쓰는 **읽기 전용** API. 응답 모양·필드 이름을 고정하고(영문 snake_case) 버전을 붙인다.
 *   인증: 관리자 › 계정·키 › 외부 API 에서 발급한 키를 `X-API-Key` 로 (externalApiAuth 그대로 — 조직·대회 범위·분당 한도·호출 로그 공통).
 *   운영용 대회도 읽을 수 있다(결과 링크 API 의 display 전용 제한은 쓰기 쪽 얘기). 개인정보(생년월일·연락처)는 내보내지 않는다.
 *
 *   GET /api/v1/openapi.json                       명세(키 없이)
 *   GET /api/v1/competitions                       대회 목록(이 키의 조직, 숨김 제외)
 *   GET /api/v1/competitions/:id                   대회 + 종목·선수 수
 *   GET /api/v1/competitions/:id/events            종목 목록(코드·영문명·라운드·상태·조/출전 수·기준기록)
 *   GET /api/v1/competitions/:id/athletes          선수 목록(배번·이름·소속·성별 — 생년월일·연락처 없음)
 *   GET /api/v1/competitions/:id/results/latest    최근 완료된 종목들의 순위표 (limit, 기본 10)
 *   GET /api/v1/events/:id                         종목 상세
 *   GET /api/v1/events/:id/startlist               조·레인별 스타트리스트
 *   GET /api/v1/events/:id/results                 순위표(getEventResultsForCert 와 같은 규칙 — 상장·기록지와 같은 순위)
 *   응답: { success: true, data, meta: { version: 'v1', generated_at } } / 오류: { success: false, error_code, message }
 */
const EventCatalog = require('../eventCatalog');
const Labels = require('../labels');
const { parseRecordValue } = require('../recordCompare');

module.exports = function mountPublicV1Routes(app, deps) {
    const { db, externalApiAuth, checkCompetitionScope, getEventResultsForCert, orderByBibSql } = deps;
    for (const k of ['db', 'externalApiAuth', 'checkCompetitionScope', 'getEventResultsForCert', 'orderByBibSql']) if (!deps[k]) throw new Error(`[public_v1] mount requires deps.${k}`);

    const ok = (res, data, extra) => res.json({ success: true, data, meta: { version: 'v1', generated_at: new Date().toISOString(), ...(extra || {}) } });
    const fail = (res, status, code, message) => res.status(status).json({ success: false, error_code: code, message });
    const int = v => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : 0; };
    const nz = v => (v == null || v === '' ? null : v);

    // ── 모양 고정 ──
    function shapeCompetition(c, counts) {
        return {
            id: c.id, name: c.name, name_en: nz(c.name_en), name_ja: nz(c.name_ja), start_date: c.start_date, end_date: c.end_date,
            venue: nz(c.venue), federation: nz(c.federation), timezone: nz(c.timezone), status: c.status || 'upcoming',
            status_label: Labels.label('competition_status', c.status || 'upcoming', 'en'), mode: c.mode || 'operation', division_type: nz(c.division_type),
            ...(counts || {}),
        };
    }
    function shapeEvent(e) {
        const code = e.code || EventCatalog.codeOf(e.name) || null;
        return {
            id: e.id, competition_id: e.competition_id, code, name: e.name, name_en: code ? EventCatalog.label(code, 'en') : e.name,
            gender: e.gender, gender_label: Labels.label('gender', e.gender, 'en'), division: nz(e.division), category: e.category,
            round: e.round_type, round_label: Labels.label('round', e.round_type, 'en'), round_status: e.round_status, round_status_label: Labels.label('round_status', e.round_status, 'en'),
            parent_event_id: nz(e.parent_event_id), sort_order: e.sort_order == null ? null : Number(e.sort_order), wind_affected: code ? !!EventCatalog.isWindAffected(code) : false,
            entry_standard: nz(e.entry_standard), target_time: nz(e.target_time), height_progression: nz(e.height_progression),
            heat_count: e.heat_count == null ? undefined : Number(e.heat_count), entry_count: e.entry_count == null ? undefined : Number(e.entry_count),
        };
    }
    function shapeAthlete(a) {
        return { id: a.id, bib: nz(a.bib_number), name: a.name, family_name: nz(a.family_name), given_name: nz(a.given_name), name_alt: nz(a.name_alt), team: nz(a.team), gender: a.gender, gender_label: Labels.label('gender', a.gender, 'en'), grade: nz(a.grade), personal_best: nz(a.personal_best), season_best: nz(a.season_best) };
    }

    async function loadCompetition(req, res) {
        const id = int(req.params.id); if (!id) { fail(res, 400, 'BAD_ID', 'competition id must be a positive integer'); return null; }
        const scope = await checkCompetitionScope(req.extApiKey, id);
        if (!scope.ok) { fail(res, 403, scope.code, scope.message); return null; }
        const c = await db.get('SELECT * FROM competition WHERE id=?', id);
        if (!c || Number(c.organization_id || 1) !== Number(req.extApiKey.organization_id || 1)) { fail(res, 404, 'COMPETITION_NOT_FOUND', 'competition not found'); return null; }
        return c;
    }
    async function loadEvent(req, res) {
        const id = int(req.params.id); if (!id) { fail(res, 400, 'BAD_ID', 'event id must be a positive integer'); return null; }
        const e = await db.get('SELECT * FROM event WHERE id=?', id);
        if (!e) { fail(res, 404, 'EVENT_NOT_FOUND', 'event not found'); return null; }
        const scope = await checkCompetitionScope(req.extApiKey, e.competition_id);
        if (!scope.ok) { fail(res, 403, scope.code, scope.message); return null; }
        const c = await db.get('SELECT id, organization_id FROM competition WHERE id=?', e.competition_id);
        if (!c || Number(c.organization_id || 1) !== Number(req.extApiKey.organization_id || 1)) { fail(res, 404, 'EVENT_NOT_FOUND', 'event not found'); return null; }
        return e;
    }

    /** 종목 순위표 — 상장·기록지와 같은 규칙(getEventResultsForCert). 조·레인·풍속·기록 숫자까지 */
    async function eventResults(event) {
        const r = await getEventResultsForCert(event.id);
        const heats = await db.all('SELECT id, heat_number, wind, scheduled_at FROM heat WHERE event_id=? ORDER BY heat_number', event.id);
        const heatById = new Map(heats.map(h => [h.id, h]));
        const heatByNumber = new Map(heats.map(h => [Number(h.heat_number), h]));
        const lanes = await db.all('SELECT he.event_entry_id, he.heat_id, he.lane_number FROM heat_entry he JOIN heat h ON h.id=he.heat_id WHERE h.event_id=?', event.id);
        const laneOf = new Map(lanes.map(l => [`${l.heat_id}:${l.event_entry_id}`, l.lane_number]));
        // 헬퍼 행은 heat_number·record_value(문자)만 준다 → 조 id·레인은 여기서 붙이고, 숫자 기록은 문자 기록을 풀어서
        const rows = (r.rows || []).map(x => {
            const h = x.heat_number != null ? heatByNumber.get(Number(x.heat_number)) : null;
            const status = x.status_code ? String(x.status_code).toUpperCase() : null;
            const mark = status ? null : (x.record_value || null);
            const num = mark ? parseRecordValue(mark) : null;
            const out = {
                rank: x.rank == null ? null : Number(x.rank), heat_rank: x.heat_rank == null ? null : Number(x.heat_rank),
                entry_id: x.entry_id, athlete_id: x.athlete_id, bib: nz(x.bib_number), name: x.athlete_name, team: nz(x.team),
                heat_id: h ? h.id : null, heat_number: h ? h.heat_number : null, lane: h ? (laneOf.get(`${h.id}:${x.entry_id}`) ?? null) : null,
                status, status_label: status ? Labels.label('status_code', status, 'en') : null,   // DQ/DNS/DNF/NM: 상태만, 기록은 내보내지 않는다(기록지와 같음)
                mark, wind: x.wind == null ? null : Number(x.wind),
            };
            const n = num == null || !isFinite(num) ? null : Number(num);
            if (event.category === 'field_height' || event.category === 'field_distance') out.distance_meters = n;
            else if (event.category === 'combined') out.points = n;
            else out.time_seconds = n;
            return out;
        });
        rows.sort((a, b) => (a.rank == null) - (b.rank == null) || (a.rank || 0) - (b.rank || 0) || (a.heat_number || 0) - (b.heat_number || 0) || (a.lane || 0) - (b.lane || 0));
        return { event: shapeEvent(event), heats: heats.map(h => ({ id: h.id, heat_number: h.heat_number, wind: h.wind == null || h.wind === '' ? null : Number(h.wind), scheduled_at: nz(h.scheduled_at) })), results: rows };
    }

    // 두 접두어로 같은 라우트를 연다: /api/v1 (정식) 과 /api/public/v1 — 운영 nginx 가 /api/v1/ 을 옛 pacerise-api(3001) 로 보내는 동안의 우회 (2026-10-12)
    const PREFIXES = ['/api/v1', '/api/public/v1'];
    const GET = (p, h) => PREFIXES.forEach(pre => app.get(pre + p, h));

    // ── 명세 (키 없이) ──
    GET('/openapi.json', (req, res) => res.json(openapi(req)));

    // 이 아래는 전부 키 필요
    PREFIXES.forEach(pre => app.use(pre, externalApiAuth));

    GET('/competitions', async (req, res) => {
        const org = Number(req.extApiKey.organization_id || 1);
        let rows = await db.all(`SELECT * FROM competition WHERE organization_id=? AND home_visibility != 'hidden' ORDER BY start_date DESC`, org);
        if (req.extApiKey.allowed_competition_id) rows = rows.filter(c => c.id === req.extApiKey.allowed_competition_id);
        ok(res, rows.map(c => shapeCompetition(c)), { count: rows.length });
    });
    GET('/competitions/:id', async (req, res) => {
        const c = await loadCompetition(req, res); if (!c) return;
        const ev = await db.get('SELECT COUNT(*) AS n FROM event WHERE competition_id=? AND parent_event_id IS NULL', c.id);
        const at = await db.get('SELECT COUNT(*) AS n FROM athlete WHERE competition_id=?', c.id);
        ok(res, shapeCompetition(c, { event_count: Number(ev.n), athlete_count: Number(at.n) }));
    });
    GET('/competitions/:id/events', async (req, res) => {
        const c = await loadCompetition(req, res); if (!c) return;
        const events = await db.all('SELECT * FROM event WHERE competition_id=? ORDER BY sort_order, id', c.id);
        if (events.length) {
            const ids = events.map(e => e.id), ph = ids.map(() => '?').join(',');
            const hc = new Map((await db.all(`SELECT event_id, COUNT(*) AS n FROM heat WHERE event_id IN (${ph}) GROUP BY event_id`, ...ids)).map(r => [Number(r.event_id), Number(r.n)]));
            const ec = new Map((await db.all(`SELECT event_id, COUNT(*) AS n FROM event_entry WHERE event_id IN (${ph}) GROUP BY event_id`, ...ids)).map(r => [Number(r.event_id), Number(r.n)]));
            events.forEach(e => { e.heat_count = hc.get(Number(e.id)) || 0; e.entry_count = ec.get(Number(e.id)) || 0; });
        }
        ok(res, events.map(shapeEvent), { count: events.length });
    });
    GET('/competitions/:id/athletes', async (req, res) => {
        const c = await loadCompetition(req, res); if (!c) return;
        const rows = await db.all(`SELECT * FROM athlete WHERE competition_id=? ORDER BY ${orderByBibSql('bib_number')}, name`, c.id);
        ok(res, rows.map(shapeAthlete), { count: rows.length });
    });
    GET('/competitions/:id/results/latest', async (req, res) => {
        const c = await loadCompetition(req, res); if (!c) return;
        const limit = Math.min(50, int(req.query.limit) || 10);
        // 완료된 종목 중 결과가 가장 최근에 바뀐 순 (result.updated_at / height_attempt.created_at)
        const events = await db.all(`SELECT e.*, (SELECT MAX(r.updated_at) FROM result r JOIN heat h ON h.id=r.heat_id WHERE h.event_id=e.id) AS last_result_at
                                     FROM event e WHERE e.competition_id=? AND e.round_status='completed' AND e.parent_event_id IS NULL
                                     ORDER BY last_result_at DESC, e.id DESC LIMIT ?`, c.id, limit);
        const data = [];
        for (const e of events) data.push({ ...(await eventResults(e)), last_result_at: nz(e.last_result_at) });
        ok(res, data, { count: data.length });
    });
    GET('/events/:id', async (req, res) => {
        const e = await loadEvent(req, res); if (!e) return;
        e.heat_count = Number((await db.get('SELECT COUNT(*) AS n FROM heat WHERE event_id=?', e.id)).n);
        e.entry_count = Number((await db.get('SELECT COUNT(*) AS n FROM event_entry WHERE event_id=?', e.id)).n);
        ok(res, shapeEvent(e));
    });
    GET('/events/:id/startlist', async (req, res) => {
        const e = await loadEvent(req, res); if (!e) return;
        const heats = await db.all('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number', e.id);
        const data = [];
        for (const h of heats) {
            const entries = await db.all(`SELECT he.lane_number, he.sub_group, ee.id AS entry_id, ee.status, a.id AS athlete_id, a.name, a.family_name, a.given_name, a.name_alt, a.bib_number, a.team, a.gender,
                                                 COALESCE(NULLIF(ee.personal_best,''), a.personal_best) AS personal_best, COALESCE(NULLIF(ee.season_best,''), a.season_best) AS season_best
                                          FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id JOIN athlete a ON a.id=ee.athlete_id
                                          WHERE he.heat_id=? ORDER BY he.lane_number ASC, ${orderByBibSql('a.bib_number')}`, h.id);
            data.push({ id: h.id, heat_number: h.heat_number, scheduled_at: nz(h.scheduled_at), wind: h.wind == null || h.wind === '' ? null : Number(h.wind),
                entries: entries.map(x => ({ lane: x.lane_number == null ? null : Number(x.lane_number), sub_group: nz(x.sub_group), entry_id: x.entry_id, athlete_id: x.athlete_id, bib: nz(x.bib_number), name: x.name, family_name: nz(x.family_name), given_name: nz(x.given_name), name_alt: nz(x.name_alt), team: nz(x.team), gender: x.gender, status: x.status || 'registered', status_label: Labels.label('entry_status', x.status || 'registered', 'en'), personal_best: nz(x.personal_best), season_best: nz(x.season_best) })) });
        }
        ok(res, { event: shapeEvent(e), heats: data }, { heat_count: data.length });
    });
    GET('/events/:id/results', async (req, res) => {
        const e = await loadEvent(req, res); if (!e) return;
        ok(res, await eventResults(e));
    });

    // ── OpenAPI 3.0 (요약 — 필드는 위 shape* 와 같다) ──
    function openapi(req) {
        const base = `${req.protocol}://${req.get('host')}`;
        const P = (summary, params, schemaRef) => ({ get: { summary, security: [{ ApiKey: [] }], parameters: params, responses: { 200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/Envelope' } } } }, 401: { description: 'missing key' }, 403: { description: 'invalid/revoked/expired key, competition out of scope' }, 404: { description: 'not found' }, 429: { description: 'rate limited (X-RateLimit-Limit / X-RateLimit-Remaining)' } }, 'x-data': schemaRef } });
        const idParam = name => ({ name, in: 'path', required: true, schema: { type: 'integer' } });
        return {
            openapi: '3.0.3',
            info: { title: 'PACE RISE : Node — Public Read API', version: 'v1', description: 'Read-only competition data (competitions, events, athletes, start lists, ranked results) for scoreboards, broadcast and result sites. Authenticate with X-API-Key (issued in Admin › Accounts & Keys › External API). Keys are scoped to the issuing organization and optionally to one competition; rate-limited per minute. Personal data (date of birth, phone) is never returned.' },
            servers: [{ url: base, description: 'paths may also be called with the /api/public/v1 prefix' }],
            components: {
                securitySchemes: { ApiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' } },
                schemas: {
                    Envelope: { type: 'object', properties: { success: { type: 'boolean' }, data: {}, meta: { type: 'object', properties: { version: { type: 'string', example: 'v1' }, generated_at: { type: 'string', format: 'date-time' }, count: { type: 'integer' } } } } },
                    Error: { type: 'object', properties: { success: { type: 'boolean', example: false }, error_code: { type: 'string' }, message: { type: 'string' } } },
                    Competition: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' }, name_en: { type: 'string', nullable: true }, name_ja: { type: 'string', nullable: true }, start_date: { type: 'string', example: '2026-09-23' }, end_date: { type: 'string' }, venue: { type: 'string', nullable: true }, federation: { type: 'string', nullable: true }, timezone: { type: 'string', nullable: true, example: 'Asia/Seoul' }, status: { type: 'string', enum: ['upcoming', 'ongoing', 'completed'] }, status_label: { type: 'string' }, mode: { type: 'string' }, event_count: { type: 'integer' }, athlete_count: { type: 'integer' } } },
                    Event: { type: 'object', properties: { id: { type: 'integer' }, competition_id: { type: 'integer' }, code: { type: 'string', nullable: true, example: '100m' }, name: { type: 'string' }, name_en: { type: 'string' }, gender: { type: 'string', enum: ['M', 'F', 'X'] }, gender_label: { type: 'string' }, division: { type: 'string', nullable: true }, category: { type: 'string', enum: ['track', 'road', 'relay', 'field_distance', 'field_height', 'combined'] }, round: { type: 'string', example: 'final' }, round_label: { type: 'string' }, round_status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] }, round_status_label: { type: 'string' }, parent_event_id: { type: 'integer', nullable: true }, sort_order: { type: 'integer', nullable: true }, wind_affected: { type: 'boolean' }, entry_standard: { type: 'string', nullable: true }, target_time: { type: 'string', nullable: true }, height_progression: { type: 'string', nullable: true }, heat_count: { type: 'integer' }, entry_count: { type: 'integer' } } },
                    Athlete: { type: 'object', properties: { id: { type: 'integer' }, bib: { type: 'string', nullable: true }, name: { type: 'string' }, family_name: { type: 'string', nullable: true }, given_name: { type: 'string', nullable: true }, name_alt: { type: 'string', nullable: true }, team: { type: 'string', nullable: true }, gender: { type: 'string' }, gender_label: { type: 'string' }, grade: { type: 'string', nullable: true }, personal_best: { type: 'string', nullable: true }, season_best: { type: 'string', nullable: true } } },
                    StartListEntry: { type: 'object', properties: { lane: { type: 'integer', nullable: true }, sub_group: { type: 'string', nullable: true }, entry_id: { type: 'integer' }, athlete_id: { type: 'integer' }, bib: { type: 'string', nullable: true }, name: { type: 'string' }, team: { type: 'string', nullable: true }, status: { type: 'string', example: 'checked_in' }, status_label: { type: 'string' }, personal_best: { type: 'string', nullable: true }, season_best: { type: 'string', nullable: true } } },
                    ResultRow: { type: 'object', properties: { rank: { type: 'integer', nullable: true, description: 'null when no valid mark (DNS/DNF/DQ/NM) — ties share a rank' }, heat_rank: { type: 'integer', nullable: true }, entry_id: { type: 'integer' }, athlete_id: { type: 'integer' }, bib: { type: 'string', nullable: true }, name: { type: 'string' }, team: { type: 'string', nullable: true }, heat_id: { type: 'integer', nullable: true }, heat_number: { type: 'integer', nullable: true }, lane: { type: 'integer', nullable: true }, status: { type: 'string', nullable: true, example: 'DQ' }, status_label: { type: 'string', nullable: true }, mark: { type: 'string', nullable: true, description: 'formatted: 10.52 / 1:45.30 / 7.80m / 4123점' }, time_seconds: { type: 'number', nullable: true, description: 'track/road/relay only' }, distance_meters: { type: 'number', nullable: true, description: 'field only (height = cleared height)' }, points: { type: 'number', nullable: true, description: 'combined only' }, wind: { type: 'number', nullable: true } } },
                    EventResults: { type: 'object', properties: { event: { $ref: '#/components/schemas/Event' }, heats: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' }, heat_number: { type: 'integer' }, wind: { type: 'number', nullable: true }, scheduled_at: { type: 'string', nullable: true } } } }, results: { type: 'array', items: { $ref: '#/components/schemas/ResultRow' } }, last_result_at: { type: 'string', nullable: true } } },
                },
            },
            paths: {
                '/api/v1/competitions': P('List competitions of the key’s organization (hidden ones excluded)', [], 'Competition[]'),
                '/api/v1/competitions/{id}': P('Competition detail with event/athlete counts', [idParam('id')], 'Competition'),
                '/api/v1/competitions/{id}/events': P('Events of a competition', [idParam('id')], 'Event[]'),
                '/api/v1/competitions/{id}/athletes': P('Athletes of a competition (no personal data)', [idParam('id')], 'Athlete[]'),
                '/api/v1/competitions/{id}/results/latest': P('Most recently completed events with ranked results', [idParam('id'), { name: 'limit', in: 'query', schema: { type: 'integer', default: 10, maximum: 50 } }], 'EventResults[]'),
                '/api/v1/events/{id}': P('Event detail', [idParam('id')], 'Event'),
                '/api/v1/events/{id}/startlist': P('Start list by heat and lane', [idParam('id')], '{ event, heats[{ id, heat_number, scheduled_at, wind, entries: StartListEntry[] }] }'),
                '/api/v1/events/{id}/results': P('Ranked results (same ranking rules as certificates and result sheets)', [idParam('id')], 'EventResults'),
            },
        };
    }

    return {};
};
