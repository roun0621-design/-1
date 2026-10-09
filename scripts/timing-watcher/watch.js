#!/usr/bin/env node
'use strict';
/**
 * 계측 파일 자동 취합 워처 (C1, 2026-10-09)
 *   계측 PC 의 결과 폴더를 지켜보다가 새 .lif(FinishLynx) / .txt(계측 텍스트) 파일이 생기면 서버에 올린다.
 *   서버의 미리보기·매칭·적용 API 를 그대로 쓴다 — 워처는 "폴더 감시 + 올리기 + 결과 정리"만 한다.
 *
 *   node scripts/timing-watcher/watch.js --dir "C:\\Lynx\\results" --server https://pace-rise-node.com --key <운영키> --comp 63 [--mode auto|confirm] [--once]
 *   환경변수로도 됨: PACE_WATCH_DIR, PACE_SERVER, PACE_KEY, PACE_COMP, PACE_WATCH_MODE, PACE_WATCH_INTERVAL(초, 기본 3), PACE_NOTIFY_URL
 *
 *   mode
 *     auto    : 미리보기에서 모든 파일이 조에 매칭되고 오류가 없으면 바로 적용. 아니면 review/ 로 옮기고 사유를 남긴다.
 *     confirm : 적용하지 않고 미리보기 결과만 보여 준 뒤 review/ 로 옮긴다 (관리자가 화면에서 올림).
 *   처리한 파일은 done/ (성공) · failed/ (오류) · review/ (확인 필요) 로 옮기고 같은 이름의 .log 를 남긴다.
 *   파일이 아직 쓰이는 중이면(크기가 1초 사이에 바뀜) 기다린다. Node 18+ (fetch·FormData 내장), 외부 패키지 없음.
 */
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
    const a = {}; for (let i = 0; i < argv.length; i++) { const k = argv[i]; if (k.startsWith('--')) { const key = k.slice(2); const v = (i + 1 < argv.length && !argv[i + 1].startsWith('--')) ? argv[++i] : '1'; a[key] = v; } }
    return a;
}
function loadConfig(argv) {
    const a = parseArgs(argv || []);
    const cfg = {
        dir: a.dir || process.env.PACE_WATCH_DIR || '',
        server: (a.server || process.env.PACE_SERVER || 'http://localhost:3000').replace(/\/+$/, ''),
        key: a.key || process.env.PACE_KEY || '',
        comp: parseInt(a.comp || process.env.PACE_COMP || '0', 10) || 0,
        mode: (a.mode || process.env.PACE_WATCH_MODE || 'auto') === 'confirm' ? 'confirm' : 'auto',
        interval: Math.max(1, parseInt(a.interval || process.env.PACE_WATCH_INTERVAL || '3', 10) || 3),
        once: a.once === '1',
        notifyUrl: a['notify-url'] || process.env.PACE_NOTIFY_URL || '',
        host: a.host || process.env.PACE_HOST || '',   // 조직 서브도메인 호스트를 따로 보낼 때 (예: jp.pace-rise-node.com)
    };
    return cfg;
}
const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (...m) => console.log(`[${ts()}]`, ...m);

function kindOf(file) { const e = path.extname(file).toLowerCase(); return e === '.lif' ? 'lif' : e === '.txt' ? 'txt' : null; }

async function stable(file, ms = 1000) {
    const a = fs.statSync(file).size; await new Promise(r => setTimeout(r, ms)); const b = fs.statSync(file).size; return a === b && b > 0;
}

/** 서버에 올린다. preview=true 면 적용 없이 미리보기만 */
async function upload(cfg, file, kind, preview) {
    const fd = new FormData();
    fd.append('competition_id', String(cfg.comp));
    fd.append('admin_key', cfg.key);
    if (kind === 'txt' && preview) fd.append('preview', 'true');
    const buf = fs.readFileSync(file);
    fd.append('files', new Blob([buf]), path.basename(file));
    const url = kind === 'lif' ? (preview ? '/api/scoreboard/preview' : '/api/scoreboard/import') : '/api/timing-txt/import';
    const headers = { 'x-admin-key': cfg.key }; if (cfg.host) headers['Host'] = cfg.host;
    const r = await fetch(cfg.server + url, { method: 'POST', body: fd, headers });
    let j = null; try { j = await r.json(); } catch (e) { j = { error: 'invalid json ' + r.status }; }
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
}

/** 미리보기 결과를 판정: { ok, summary, reasons[] } */
function judge(kind, prev) {
    const reasons = []; const parts = [];
    for (const f of (prev.results || [])) {
        if (f.error) { reasons.push(`${f.filename}: ${f.error}`); continue; }
        if (kind === 'lif') {
            if (f.matchStatus !== 'matched' || !f.heatInfo) reasons.push(`${f.filename}: 조를 못 찾음 (${f.header && f.header.scoreboardKey})`);
            else if (f.heatInfo.ambiguous) reasons.push(`${f.filename}: 후보 조가 둘 이상 — 전광판 키를 확인하세요`);
            const unmatched = (f.athleteMatches || []).filter(m => m.match_method === 'none' && m.lif_type === 'result').length;
            if (unmatched) reasons.push(`${f.filename}: 선수 ${unmatched}명 미매칭`);
            parts.push(`${f.filename} → ${f.heatInfo ? `${f.heatInfo.event_name} ${f.heatInfo.heat_number}조` : '?'} (${(f.athleteMatches || []).length}명${unmatched ? `, 미매칭 ${unmatched}` : ''})`);
        } else {
            if (f.error) reasons.push(`${f.filename}: ${f.error}`);
            else if (f.matched != null && f.total != null && f.matched < f.total) reasons.push(`${f.label || f.filename}: ${f.total - f.matched}명 미매칭`);
            parts.push(`${f.label || f.filename} (${f.matched}/${f.total})`);
        }
    }
    return { ok: reasons.length === 0, summary: parts.join(' · '), reasons };
}

function moveTo(cfg, file, sub, note) {
    const dir = path.join(cfg.dir, sub); if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    let dest = path.join(dir, path.basename(file)); let i = 1;
    while (fs.existsSync(dest)) dest = path.join(dir, `${path.basename(file, path.extname(file))}_${i++}${path.extname(file)}`);
    fs.renameSync(file, dest);
    if (note) fs.writeFileSync(dest + '.log', `[${ts()}] ${note}\n`);
    return dest;
}

async function notify(cfg, text) {
    if (!cfg.notifyUrl) return;
    try { await fetch(cfg.notifyUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }); } catch (e) {}
}

/** 파일 하나 처리. 반환 'done' | 'review' | 'failed' | 'skip' */
async function processFile(cfg, file) {
    const kind = kindOf(file); if (!kind) return 'skip';
    try {
        if (!(await stable(file))) { log('아직 쓰는 중:', path.basename(file)); return 'skip'; }
        const prev = await upload(cfg, file, kind, true);
        const verdict = judge(kind, prev);
        if (cfg.mode === 'confirm') { log('확인 필요(확인 모드):', path.basename(file), '—', verdict.summary); moveTo(cfg, file, 'review', `확인 모드 · ${verdict.summary}${verdict.reasons.length ? ' · ' + verdict.reasons.join(' / ') : ''}`); return 'review'; }
        if (!verdict.ok) { log('확인 필요:', path.basename(file), '—', verdict.reasons.join(' / ')); moveTo(cfg, file, 'review', verdict.reasons.join(' / ')); await notify(cfg, `[계측 워처] 확인 필요: ${path.basename(file)} — ${verdict.reasons.join(' / ')}`); return 'review'; }
        const applied = await upload(cfg, file, kind, false);
        const stat = (applied.results || []).map(f => f.error ? `${f.filename}: ${f.error}` : `${f.filename}: ${f.imported}건 적용${f.skipped ? `, ${f.skipped}건 건너뜀` : ''}${f.wind ? `, 풍속 ${f.wind}` : ''}`).join(' · ');
        const anyErr = (applied.results || []).some(f => f.error);
        log(anyErr ? '일부 실패:' : '적용:', path.basename(file), '—', stat);
        moveTo(cfg, file, anyErr ? 'failed' : 'done', stat);
        if (anyErr) await notify(cfg, `[계측 워처] 실패: ${path.basename(file)} — ${stat}`);
        return anyErr ? 'failed' : 'done';
    } catch (e) {
        log('오류:', path.basename(file), '—', e.message);
        try { moveTo(cfg, file, 'failed', e.message); } catch (_) {}
        await notify(cfg, `[계측 워처] 오류: ${path.basename(file)} — ${e.message}`);
        return 'failed';
    }
}

async function scanOnce(cfg, seen) {
    const names = fs.readdirSync(cfg.dir).filter(n => kindOf(n) && !n.startsWith('.'));
    for (const n of names) {
        const file = path.join(cfg.dir, n);
        if (!fs.statSync(file).isFile()) continue;
        const r = await processFile(cfg, file);
        if (r !== 'skip') seen.add(n);
    }
}

async function main() {
    const cfg = loadConfig(process.argv.slice(2));
    if (!cfg.dir || !fs.existsSync(cfg.dir)) { console.error('--dir <결과 폴더> 가 필요합니다 (없거나 접근 불가):', cfg.dir); process.exit(2); }
    if (!cfg.key || !cfg.comp) { console.error('--key <운영키> 와 --comp <대회 id> 가 필요합니다.'); process.exit(2); }
    try { const r = await fetch(cfg.server + '/api/health', { headers: cfg.host ? { Host: cfg.host } : {} }); if (!r.ok) throw new Error('HTTP ' + r.status); } catch (e) { console.error('서버 연결 실패:', cfg.server, e.message); process.exit(2); }
    log(`워처 시작 — 폴더 ${cfg.dir} → ${cfg.server} (대회 ${cfg.comp}, ${cfg.mode} 모드, ${cfg.interval}초 주기)`);
    const seen = new Set();
    await scanOnce(cfg, seen);
    if (cfg.once) return;
    setInterval(() => scanOnce(cfg, seen).catch(e => log('스캔 오류:', e.message)), cfg.interval * 1000);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { loadConfig, judge, processFile, kindOf, upload };
