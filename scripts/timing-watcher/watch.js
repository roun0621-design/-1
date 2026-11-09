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
 *
 *   에이전트(2026-10-10): 같은 파일을 @yao-pkg/pkg 로 실행 파일(PaceRise-TimingAgent.exe)로 묶어 계측 PC 에 폴더째 둔다 (scripts/timing-watcher/build-agent.sh).
 *     실행 파일 옆 config.json 에서 설정을 읽고(인자·환경변수가 우선), dir 이 없으면 옆의 inbox/ 폴더를 감시한다 → 폴더에 넣기만 하면 올라간다.
 *     config.json 이 없으면 틀을 만들어 주고 끝난다. 30초마다 /api/timing-agent/ping 으로 살아 있음·처리 건수를 보내 관리자 계측 화면에 표시된다.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const AGENT_VERSION = '1.0.0';
function baseDir() { return process.pkg ? path.dirname(process.execPath) : __dirname; }
const CONFIG_TEMPLATE = {
    server: 'https://pace-rise-node.com',
    key: '여기에 운영키 (관리자 › 계정·키 › 심판 운영키 — 계측 PC 전용으로 하나 발급)',
    competition_id: 0,
    dir: '',
    mode: 'auto',
    interval: 3,
    notify_url: '',
    host: '',
    name: '',
    _help: 'server: 서버 주소 / key: 운영키 / competition_id: 대회 번호(관리자 화면 주소의 id) / dir: 감시 폴더(비우면 옆의 inbox 폴더) / mode: auto(매칭되면 바로 적용) 또는 confirm(미리보기만, review 폴더로) / interval: 폴더 확인 주기(초) / notify_url: 실패 때 알릴 웹훅 / host: 조직 서브도메인(예 jp.pace-rise-node.com) / name: 이 PC 이름(비우면 컴퓨터 이름)',
};
function readConfigFile() {
    const p = path.join(baseDir(), 'config.json');
    if (!fs.existsSync(p)) return null;
    try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); } catch (e) { console.error('config.json 을 읽을 수 없습니다 (JSON 형식 확인):', e.message); process.exit(2); }
}

function parseArgs(argv) {
    const a = {}; for (let i = 0; i < argv.length; i++) { const k = argv[i]; if (k.startsWith('--')) { const key = k.slice(2); const v = (i + 1 < argv.length && !argv[i + 1].startsWith('--')) ? argv[++i] : '1'; a[key] = v; } }
    return a;
}
function loadConfig(argv, fileCfg) {
    const a = parseArgs(argv || []);
    const f = fileCfg || {};   // 우선순위: 인자 > 환경변수 > config.json > 기본값
    const pick = (arg, env, file, def) => (a[arg] != null ? a[arg] : (process.env[env] != null && process.env[env] !== '' ? process.env[env] : (f[file] != null && f[file] !== '' ? f[file] : def)));
    const cfg = {
        dir: String(pick('dir', 'PACE_WATCH_DIR', 'dir', '')),
        server: String(pick('server', 'PACE_SERVER', 'server', 'http://localhost:3000')).replace(/\/+$/, ''),
        key: String(pick('key', 'PACE_KEY', 'key', '')),
        comp: parseInt(pick('comp', 'PACE_COMP', 'competition_id', '0'), 10) || 0,
        mode: String(pick('mode', 'PACE_WATCH_MODE', 'mode', 'auto')) === 'confirm' ? 'confirm' : 'auto',
        interval: Math.max(1, parseInt(pick('interval', 'PACE_WATCH_INTERVAL', 'interval', '3'), 10) || 3),
        once: a.once === '1',
        notifyUrl: String(pick('notify-url', 'PACE_NOTIFY_URL', 'notify_url', '')),
        host: String(pick('host', 'PACE_HOST', 'host', '')),   // 조직 서브도메인 호스트를 따로 보낼 때 (예: jp.pace-rise-node.com)
        name: String(pick('name', 'PACE_AGENT_NAME', 'name', '') || os.hostname()).slice(0, 60),
        pingInterval: Math.max(10, parseInt(pick('ping-interval', 'PACE_PING_INTERVAL', 'ping_interval', '30'), 10) || 30),
    };
    if (/여기에 운영키/.test(cfg.key)) cfg.key = '';
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

const stats = { done: 0, review: 0, failed: 0, lastFile: '', lastAt: '' };
async function scanOnce(cfg, seen) {
    const names = fs.readdirSync(cfg.dir).filter(n => kindOf(n) && !n.startsWith('.'));
    for (const n of names) {
        const file = path.join(cfg.dir, n);
        if (!fs.statSync(file).isFile()) continue;
        const r = await processFile(cfg, file);
        if (r !== 'skip') { seen.add(n); if (stats[r] != null) stats[r]++; stats.lastFile = n; stats.lastAt = ts(); }
    }
}

/** 살아 있음 알림 — 관리자 계측 화면의 '에이전트' 표시용. 실패해도 워처는 계속 돈다 */
let _pingErrShown = false;
async function ping(cfg) {
    try {
        const headers = { 'Content-Type': 'application/json', 'x-admin-key': cfg.key }; if (cfg.host) headers['Host'] = cfg.host;
        const r = await fetch(cfg.server + '/api/timing-agent/ping', { method: 'POST', headers, body: JSON.stringify({
            competition_id: cfg.comp, name: cfg.name, version: AGENT_VERSION, mode: cfg.mode, dir: cfg.dir,
            done: stats.done, review: stats.review, failed: stats.failed, last_file: stats.lastFile, last_at: stats.lastAt, platform: process.platform,
        }) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        _pingErrShown = false;
    } catch (e) { if (!_pingErrShown) { log('상태 알림 실패(계속 감시함):', e.message); _pingErrShown = true; } }
}

function writeConfigTemplate() {
    const p = path.join(baseDir(), 'config.json');
    fs.writeFileSync(p, JSON.stringify(CONFIG_TEMPLATE, null, 2) + '\n');
    return p;
}

async function main() {
    const argv = process.argv.slice(2);
    let fileCfg = readConfigFile();
    if (!fileCfg && !argv.length) {
        const p = writeConfigTemplate();
        console.error(`설정 파일을 만들었습니다: ${p}\n  메모장으로 열어 key(운영키)와 competition_id(대회 번호)를 넣고 다시 실행하세요.`);
        process.exit(2);
    }
    const cfg = loadConfig(argv, fileCfg || {});
    if (!cfg.dir) { cfg.dir = path.join(baseDir(), 'inbox'); if (!fs.existsSync(cfg.dir)) fs.mkdirSync(cfg.dir, { recursive: true }); }   // 폴더를 안 정했으면 옆의 inbox/
    if (!fs.existsSync(cfg.dir)) { console.error('감시할 폴더가 없거나 접근할 수 없습니다:', cfg.dir); process.exit(2); }
    if (!cfg.key || !cfg.comp) { console.error('운영키(key)와 대회 번호(competition_id)가 필요합니다 — config.json 또는 --key / --comp'); process.exit(2); }
    try { const r = await fetch(cfg.server + '/api/health', { headers: cfg.host ? { Host: cfg.host } : {} }); if (!r.ok) throw new Error('HTTP ' + r.status); } catch (e) { console.error('서버 연결 실패:', cfg.server, e.message); process.exit(2); }
    log(`에이전트 v${AGENT_VERSION} 시작 — 폴더 ${cfg.dir} → ${cfg.server} (대회 ${cfg.comp}, ${cfg.mode} 모드, ${cfg.interval}초 주기, 이름 ${cfg.name})`);
    log('이 폴더에 .lif / .txt 파일을 넣으면 자동으로 올라갑니다. 끝내려면 Ctrl+C');
    const seen = new Set();
    await scanOnce(cfg, seen);
    if (cfg.once) return;
    await ping(cfg);
    setInterval(() => scanOnce(cfg, seen).catch(e => log('스캔 오류:', e.message)), cfg.interval * 1000);
    setInterval(() => ping(cfg), cfg.pingInterval * 1000);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { loadConfig, judge, processFile, kindOf, upload, ping, stats, AGENT_VERSION, CONFIG_TEMPLATE };
