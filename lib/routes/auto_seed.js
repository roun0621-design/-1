'use strict';
/**
 * 1라운드 자동 조편성·레인 추첨 (C2, 2026-10-09) — WA TR 20.3.1
 *   해외에선 연맹이 조편성을 주지 않는다. 출전 선수의 SB/PB(엔트리 기록)로 순위를 매겨 지그재그(serpentine)로 조에 나누고,
 *   같은 소속은 가능한 한 다른 조로, 레인은 기존 WA 레인 규칙(waAssignLanesBulk: 상위 시드가 가운데 레인 후보)으로 배정한다.
 *   기록이 없는 선수는 맨 뒤(무작위)로.
 *
 *   POST /api/events/:id/auto-seed   { admin_key, heat_size?, basis?('best'|'sb'|'pb'), dry_run?('1'), force?('1'), separate_teams?('0') }
 *     - heat_size 기본: 단거리(레인 종목) 8, 그 외(800m 이상·필드)는 한 조(=출전 수)
 *     - dry_run 이면 DB 를 바꾸지 않고 조편성안만 돌려준다
 *     - 이미 기록이 입력된 종목은 force 없이는 거부
 *   응답 { success, event:{id,name,gender,round_type}, heat_size, heats:[{heat_number, scoreboard_key, entries:[{event_entry_id, name, bib, team, perf_text, perf, lane, seed}]}], unseeded:n, warnings:[…], applied:bool }
 */
const { parseRecordValue } = require('../recordCompare');
const EventCatalog = require('../eventCatalog');

const LOWER_IS_BETTER = new Set(['track', 'relay', 'road']);

function perfOf(entry, basis, lowerBetter) {
    const cand = basis === 'pb' ? [entry.personal_best] : basis === 'sb' ? [entry.season_best] : [entry.season_best, entry.personal_best];
    let best = null, text = '';
    for (const v of cand) {
        const n = parseRecordValue(v);
        if (n == null || !isFinite(n) || n <= 0) continue;
        if (best == null || (lowerBetter ? n < best : n > best)) { best = n; text = String(v); }
    }
    return { perf: best, perf_text: text };
}

// 지그재그 분배 + 같은 소속 분리 (서버의 waSeededDistribution 과 같은 규칙, 기록 유무만 다르게)
function serpentine(ranked, heatCount, separateTeams) {
    const groups = Array.from({ length: heatCount }, () => []);
    ranked.forEach((a, idx) => {
        const row = Math.floor(idx / heatCount), col = idx % heatCount;
        groups[row % 2 === 0 ? col : heatCount - 1 - col].push(a);
    });
    if (separateTeams && heatCount > 1) {
        for (let pass = 0; pass < 4; pass++) {
            let moved = false;
            for (let g = 0; g < heatCount; g++) {
                const seen = new Map();
                for (let i = 0; i < groups[g].length; i++) {
                    const a = groups[g][i]; if (!a.team) continue;
                    if (!seen.has(a.team)) { seen.set(a.team, i); continue; }
                    // 같은 시드 띠(row)의 다른 조 선수와 바꿔 본다 — 상대 조에 그 팀이 없을 때만
                    for (let og = 0; og < heatCount && !moved; og++) {
                        if (og === g) continue;
                        const j = groups[og].findIndex((b, bi) => bi === i && !groups[og].some(x => x.team === a.team) && !groups[g].some((x, xi) => xi !== i && x.team === b.team));
                        if (j >= 0) { const tmp = groups[og][j]; groups[og][j] = a; groups[g][i] = tmp; moved = true; }
                    }
                }
            }
            if (!moved) break;
        }
    }
    return groups;
}

module.exports = function mountAutoSeed(app, deps) {
    const { db, isOperationKey, opLog, waAssignLanesBulk, isShortTrackEvent, generateScoreboardKey, broadcastSSE } = deps;
    if (!app || !db || !isOperationKey || !opLog || !waAssignLanesBulk || !isShortTrackEvent || !generateScoreboardKey) throw new Error('[auto_seed.js] mount requires { db, isOperationKey, opLog, waAssignLanesBulk, isShortTrackEvent, generateScoreboardKey }');
    const keyOf = req => (req.body && (req.body.admin_key || req.body.operation_key)) || req.headers['x-admin-key'] || (req.query && req.query.key) || '';
    const truthy = v => v === true || v === 1 || v === '1' || v === 'true';

    app.post('/api/events/:id/auto-seed', async (req, res) => {
        try {
            if (!isOperationKey(keyOf(req))) return res.status(403).json({ error: '인증 키가 필요합니다.' });
            const event = await db.get('SELECT * FROM event WHERE id=?', req.params.id);
            if (!event) return res.status(404).json({ error: '종목을 찾을 수 없습니다.' });
            if (event.category === 'combined') return res.status(400).json({ error: '혼성경기는 세부종목별로 조편성합니다.' });
            const body = req.body || {};
            const dryRun = truthy(body.dry_run), force = truthy(body.force), separateTeams = !(body.separate_teams === '0' || body.separate_teams === false || body.separate_teams === 0);
            const basis = ['sb', 'pb', 'best'].includes(body.basis) ? body.basis : 'best';
            const lowerBetter = LOWER_IS_BETTER.has(event.category);
            const shortTrack = isShortTrackEvent(event.name);

            const entries = await db.all(`SELECT ee.id AS event_entry_id, ee.status, a.name, a.bib_number, a.team,
                                                 COALESCE(NULLIF(ee.personal_best,''), a.personal_best, '') AS personal_best,
                                                 COALESCE(NULLIF(ee.season_best,''), a.season_best, '') AS season_best
                                          FROM event_entry ee JOIN athlete a ON a.id=ee.athlete_id
                                          WHERE ee.event_id=? AND ee.status<>'no_show' ORDER BY ee.id`, event.id);
            if (!entries.length) return res.status(400).json({ error: '출전 선수가 없습니다.' });
            const n = entries.length;
            const heatSize = Math.max(1, Math.min(99, parseInt(body.heat_size, 10) || (shortTrack ? 8 : n)));
            const heatCount = Math.max(1, Math.ceil(n / heatSize));

            const withPerf = [], without = [];
            for (const e of entries) { const p = perfOf(e, basis, lowerBetter); (p.perf == null ? without : withPerf).push({ ...e, ...p }); }
            withPerf.sort((a, b) => (lowerBetter ? a.perf - b.perf : b.perf - a.perf) || String(a.bib_number || '').localeCompare(String(b.bib_number || '')));
            // 기록 없는 선수는 무작위로 맨 뒤
            for (let i = without.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [without[i], without[j]] = [without[j], without[i]]; }
            const ranked = [...withPerf, ...without].map((a, i) => ({ ...a, seed: i + 1 }));

            const groups = serpentine(ranked, heatCount, separateTeams);
            const warnings = [];
            if (!withPerf.length) warnings.push('엔트리 기록(SB/PB)이 하나도 없어 무작위로 나눴습니다.');
            else if (without.length) warnings.push(`기록 없는 선수 ${without.length}명은 맨 뒤 시드로 두었습니다.`);
            // 레인: 조 안에서 시드순으로 WA 레인 배정 (단거리만; 그 외는 1부터)
            const heats = groups.map((g, gi) => {
                const inHeat = g.slice().sort((a, b) => a.seed - b.seed);
                const lanes = waAssignLanesBulk(inHeat, inHeat.length, shortTrack, event.name);
                return { heat_number: gi + 1, entries: inHeat.map((a, i) => ({ event_entry_id: a.event_entry_id, name: a.name, bib: a.bib_number || '', team: a.team || '', perf_text: a.perf_text, perf: a.perf, seed: a.seed, lane: lanes[i] })) };
            });
            if (separateTeams) {
                for (const h of heats) { const t = {}; h.entries.forEach(e => { if (e.team) t[e.team] = (t[e.team] || 0) + 1; }); const dup = Object.entries(t).filter(([, c]) => c > 1).map(([k, c]) => `${k}×${c}`); if (dup.length) warnings.push(`${h.heat_number}조에 같은 소속: ${dup.join(', ')}`); }
            }

            if (dryRun) return res.json({ success: true, applied: false, event: { id: event.id, name: event.name, gender: event.gender, round_type: event.round_type }, heat_size: heatSize, heats, unseeded: without.length, warnings });

            // 적용: 기존 기록이 있으면 force 없이는 거부
            const hasResults = await db.get('SELECT COUNT(*) AS c FROM result r JOIN heat h ON h.id=r.heat_id WHERE h.event_id=?', event.id);
            const hasHeights = await db.get('SELECT COUNT(*) AS c FROM height_attempt ha JOIN heat h ON h.id=ha.heat_id WHERE h.event_id=?', event.id);
            if ((Number(hasResults && hasResults.c) || Number(hasHeights && hasHeights.c)) && !force) return res.status(409).json({ error: '이미 기록이 입력된 종목입니다. 기존 조·기록을 지우고 다시 나누려면 force 를 켜세요.', needs_force: true });
            await db.transaction(async () => {
                const old = await db.all('SELECT id FROM heat WHERE event_id=?', event.id);
                for (const h of old) {
                    await db.run('DELETE FROM result WHERE heat_id=?', h.id);
                    await db.run('DELETE FROM height_attempt WHERE heat_id=?', h.id);
                    await db.run('DELETE FROM heat_entry WHERE heat_id=?', h.id);
                    await db.run('DELETE FROM heat WHERE id=?', h.id);
                }
                for (const h of heats) {
                    const key = await generateScoreboardKey(event, h.heat_number, db, heats.length);
                    const info = await db.run('INSERT INTO heat (event_id, heat_number, scoreboard_key) VALUES (?,?,?)', event.id, h.heat_number, key);
                    h.heat_id = info.lastInsertRowid; h.scoreboard_key = key;
                    for (const e of h.entries) await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?,?,?)', h.heat_id, e.event_entry_id, e.lane);
                }
                if (['created', 'in_progress', 'completed'].includes(event.round_status)) await db.run("UPDATE event SET round_status='heats_generated' WHERE id=? AND round_status IN ('created')", event.id);
            })();
            opLog(`자동 조편성: ${event.name} (${n}명 → ${heats.length}조, 기준 ${basis.toUpperCase()}${separateTeams ? ', 소속 분리' : ''})`, 'operation', 'auto-seed', event.competition_id);
            if (broadcastSSE) try { broadcastSSE('heats_changed', { event_id: event.id, competition_id: event.competition_id }); } catch (e) {}
            res.json({ success: true, applied: true, event: { id: event.id, name: event.name, gender: event.gender, round_type: event.round_type }, heat_size: heatSize, heats, unseeded: without.length, warnings });
        } catch (e) { console.error('[auto-seed]', e); res.status(500).json({ error: e.message }); }
    });
};
module.exports._internal = { serpentine, perfOf };
