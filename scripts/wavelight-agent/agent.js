#!/usr/bin/env node
'use strict';
/**
 * WaveLight 에이전트 (2026-11-21) — 계측 에이전트(scripts/timing-watcher)를 거꾸로 쓴 꼴
 *   WaveLight 컨트롤러와 같은 네트워크에 있는 PC 에서 띄워 둔다. 하는 일은 둘:
 *     1) 폴더 맞추기 — 서버(관리 › 페이싱 라이트)에 저장된 내용을 주기적으로 받아 wavelight 폴더의 .pc2 를 최신으로 맞춘다.
 *        (프로그램의 Complex › Load file 로 손으로 넣을 때 쓰는 파일. 에이전트가 만든 파일만 지우고, 다른 파일은 건드리지 않는다)
 *     2) 컨트롤러에 올리기 — 이 PC 의 보내기 화면(http://localhost:5010)에서 종목을 고르면, 색마다 빈 줄에
 *        구간·색·출발선을 넣어 **출발 신호 대기** 상태로 컨트롤러에 올린다. 조명은 WaveLight 화면의 Fire(또는 출발 신호)로 출발한다.
 *        에이전트는 조명을 출발시키지 않고, 전원·밝기도 건드리지 않는다. 취소는 에이전트가 올린 줄만.
 *
 *   컨트롤러 명령은 'Wavelight event tool' 5.0 화면이 보내는 것과 같다(docs/WAVELIGHT.md):
 *     GET  /command09   상태 60바이트(줄 1~10 상태 · 조명 전원 · 버전 · 한 바퀴 조명 수 …, 끝 2바이트 = 앞 58바이트 합)
 *     POST /command06   { runnerArrayNumber, Steps:[{NumberOfLamps, Duration(ms)}], colourNumber, startingDelay(출발선 조명), startingDelayInSeconds(255 = 출발 신호 대기), isHideEnabled, isPilotEnabled }
 *     POST /command08   { runnerArrayNumber }  줄 취소
 *
 *   node scripts/wavelight-agent/agent.js --server https://pace-rise-node.com --comp 63 --controller http://192.168.1.240:5001 [--dir <폴더>] [--port 5010] [--once]
 *   실행 파일(build-agent.sh)로 묶으면 옆의 config.json 을 읽는다. Node 18+, 외부 패키지 없음.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const PAGE = require('./page');

const AGENT_VERSION = '1.0.0';
function baseDir() { return process.pkg ? path.dirname(process.execPath) : __dirname; }
const CONFIG_TEMPLATE = {
    server: 'https://pace-rise-node.com',
    competition_id: 0,
    controller: 'http://192.168.1.240:5001',
    dir: '',
    interval: 10,
    port: 5010,
    host: '',
    _help: 'server: 서버 주소 / competition_id: 대회 번호(관리자 화면 주소의 id) / controller: WaveLight 화면을 여는 주소에서 /wavelight 앞까지(비우면 폴더 맞추기만) / dir: .pc2 를 둘 폴더(비우면 옆의 wavelight 폴더) / interval: 서버 확인 주기(초) / port: 이 PC 에서 여는 보내기 화면 번호 / host: 조직 서브도메인(예 jp.pace-rise-node.com)',
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
    return {
        server: String(pick('server', 'PACE_SERVER', 'server', 'http://localhost:3000')).replace(/\/+$/, ''),
        comp: parseInt(pick('comp', 'PACE_COMP', 'competition_id', '0'), 10) || 0,
        controller: String(pick('controller', 'PACE_WL_CONTROLLER', 'controller', '')).replace(/\/wavelight\/?$/, '').replace(/\/+$/, ''),
        dir: String(pick('dir', 'PACE_WL_DIR', 'dir', '')) || path.join(baseDir(), 'wavelight'),
        interval: Math.max(3, parseInt(pick('interval', 'PACE_WL_INTERVAL', 'interval', '10'), 10) || 10),
        port: parseInt(pick('port', 'PACE_WL_PORT', 'port', '5010'), 10) || 5010,
        host: String(pick('host', 'PACE_HOST', 'host', '')),
        once: a.once === '1',
    };
}
const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (...m) => console.log(`[${ts()}]`, ...m);

// ───────────────────────── 서버 → 폴더 ─────────────────────────
const MANIFEST = '.pacerise-wavelight.json';   // 에이전트가 만든 파일 이름 목록 — 여기 있는 것만 지운다

async function fetchPlan(cfg) {
    const r = await fetch(`${cfg.server}/api/pacing/wavelight.json?competition_id=${cfg.comp}`, { headers: cfg.host ? { Host: cfg.host } : {} });
    if (!r.ok) throw new Error(r.status === 404 ? `대회 ${cfg.comp} 을 찾을 수 없습니다` : 'HTTP ' + r.status);
    return r.json();
}

/** 폴더의 .pc2 를 plan 과 같게 — 바뀐 것만 쓰고, 에이전트가 만들었는데 이제 없는 파일은 지운다. returns { written, removed, total } */
function syncFolder(dir, plan) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const mPath = path.join(dir, MANIFEST);
    let owned = [];
    try { owned = JSON.parse(fs.readFileSync(mPath, 'utf8')).files || []; } catch (e) {}
    const want = new Map();
    for (const ev of plan.events || []) for (const f of ev.files || []) {
        if (/^[A-Za-z0-9._-]+\.pc2$/.test(f.filename)) want.set(f.filename, f.content);   // 서버가 준 이름이라도 폴더 밖으로 못 나가게
    }
    let written = 0, removed = 0;
    for (const [name, content] of want) {
        const p = path.join(dir, name);
        let cur = null; try { cur = fs.readFileSync(p, 'utf8'); } catch (e) {}
        if (cur !== content) { fs.writeFileSync(p, content); written++; }
    }
    for (const name of owned) {
        if (want.has(name) || !/^[A-Za-z0-9._-]+\.pc2$/.test(name)) continue;
        try { fs.unlinkSync(path.join(dir, name)); removed++; } catch (e) {}
    }
    fs.writeFileSync(mPath, JSON.stringify({ rev: plan.rev, files: [...want.keys()] }, null, 1));
    return { written, removed, total: want.size };
}

// ───────────────────────── 컨트롤러 ─────────────────────────
/** command09 응답(60바이트) → 상태. 합이 안 맞으면 null */
function parseStatus(arr) {
    if (!Array.isArray(arr) || arr.length < 60) return null;
    let sum = 0; for (let i = 0; i <= 57; i++) sum += arr[i];
    if (sum !== arr[58] * 256 + arr[59]) return null;
    return {
        slots: arr.slice(0, 10),                         // 줄 1~10: 0 비어 있음 · 2 출발 신호 대기 · 1 진행 중(끝나면 스스로 0)
        lampsOn: arr[10] !== 0,
        version: String.fromCharCode(...arr.slice(11, 15)),
        lampsInRound: arr[15] * 256 + arr[16],
        lampPower: arr[25],
    };
}
async function ctlFetch(cfg, pathName, body) {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 4000);
    try {
        const r = await fetch(cfg.controller + pathName, body === undefined ? { signal: ctrl.signal } : {
            method: 'POST', signal: ctrl.signal,
            headers: { 'Content-Type': 'application/json;charset=UTF-8' },
            body: JSON.stringify(body, null, '\t'),      // 프로그램 화면이 보내는 꼴 그대로
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return await r.text();
    } finally { clearTimeout(t); }
}
async function readStatus(cfg) {
    const s = parseStatus(JSON.parse(await ctlFetch(cfg, '/command09')));
    if (!s) throw new Error('컨트롤러 응답을 읽을 수 없습니다');
    return s;
}
/** 컨트롤러에 저장된 '사용자 지정 출발선' 조명 번호들 (없으면 []) */
async function readCustomStartLamps(cfg) {
    try { return (JSON.parse(await ctlFetch(cfg, '/loadSettingsFromAFile')).customStartingLineLampNumbers || []).map(n => parseInt(n, 10)).filter(n => n >= 0 && n < 400); } catch (e) { return []; }
}

/**
 * 출발선 기본값 — 서버가 계산한 값(결승선에서 끝나게)에서 3m 안쪽에 컨트롤러의 '사용자 지정 출발선'이 있으면 그 값을 쓴다
 * (3000m 장애물 출발선은 운영자가 현장에서 맞춰 저장해 둔다 — 계산 350, 현장 351 같은 차이).
 */
function defaultStartLamp(event, customLamps) {
    const f = (event.files || [])[0];
    if (!f) return 0;
    const calc = f.controller.startLamp;
    const near = (customLamps || []).find(n => Math.min(Math.abs(n - calc), 400 - Math.abs(n - calc)) <= 3);
    return near != null ? near : calc;
}

/** 한 줄의 command06 본문 */
function buildCommand06(file, slot, startLamp) {
    return {
        isHideEnabled: 0, isPilotEnabled: 0,
        runnerArrayNumber: slot,
        Steps: file.controller.steps,
        colourNumber: file.controller.colourNumber,
        startingDelay: startLamp,
        startingDelayInSeconds: 255,                     // 항상 '출발 신호 대기' — 에이전트는 조명을 바로 출발시키지 않는다
    };
}

const sent = [];   // 에이전트가 올린 줄: { slot, event_id, label, color_key, filename, at }

/** 종목 하나를 컨트롤러에 올린다 — 색마다 빈 줄 하나. returns { ok, lines:[{slot,color_key,filename,state}], error } */
async function sendEvent(cfg, event, opts = {}) {
    const files = (event.files || []).filter(f => !opts.colors || opts.colors.includes(f.color_key));
    if (!files.length) return { ok: false, error: '보낼 색이 없습니다 (랩타임이 비어 있음)' };
    const st = await readStatus(cfg);
    if (st.lampsInRound !== 400 && st.lampsInRound !== 398) return { ok: false, error: `이 컨트롤러는 한 바퀴 조명이 ${st.lampsInRound}개입니다 — 400m 트랙 기준 설정만 올릴 수 있습니다` };
    const idle = st.slots.map((v, i) => (v === 0 ? i + 1 : 0)).filter(Boolean);
    if (idle.length < files.length) return { ok: false, error: `빈 줄이 ${idle.length}개뿐입니다 (필요 ${files.length}) — WaveLight 화면에서 쓰지 않는 줄을 Cancel 하세요` };
    const startLamp = Number.isInteger(opts.startLamp) && opts.startLamp >= 0 && opts.startLamp < 400
        ? opts.startLamp : defaultStartLamp(event, await readCustomStartLamps(cfg));
    const lines = [];
    for (let i = 0; i < files.length; i++) {
        const f = files[i], slot = idle[i];
        await ctlFetch(cfg, '/command06', buildCommand06(f, slot, startLamp));
        lines.push({ slot, color_key: f.color_key, filename: f.filename });
        sent.push({ slot, event_id: event.id, label: event.label, color_key: f.color_key, filename: f.filename, at: Date.now() });
    }
    await new Promise(r => setTimeout(r, opts.settleMs != null ? opts.settleMs : 700));
    const after = await readStatus(cfg);
    for (const l of lines) l.state = after.slots[l.slot - 1];
    const missed = lines.filter(l => l.state === 0);
    log(`올림: ${event.label} — ${lines.map(l => `줄 ${l.slot} ${l.color_key}`).join(', ')} · 출발선 조명 ${startLamp}`);
    return { ok: missed.length === 0, startLamp, lines, lampsOn: after.lampsOn, error: missed.length ? `컨트롤러가 줄 ${missed.map(l => l.slot).join(', ')} 을 받지 않았습니다` : undefined };
}

/** 에이전트가 올린 줄 중 아직 컨트롤러에 남아 있는 것만 취소 */
async function cancelSent(cfg) {
    const st = await readStatus(cfg);
    const slots = [...new Set(sent.map(s => s.slot))].filter(n => st.slots[n - 1] !== 0);
    for (const slot of slots) await ctlFetch(cfg, '/command08', { runnerArrayNumber: slot });
    sent.length = 0;
    if (slots.length) log('취소: 줄 ' + slots.join(', '));
    return { ok: true, cancelled: slots };
}

// ───────────────────────── 보내기 화면(이 PC 에서만) ─────────────────────────
const state = { plan: null, syncedAt: 0, syncError: '', folder: null };

async function syncOnce(cfg) {
    try {
        const plan = await fetchPlan(cfg);
        const changed = !state.plan || state.plan.rev !== plan.rev;
        state.plan = plan; state.syncedAt = Date.now(); state.syncError = '';
        if (changed) {
            state.folder = syncFolder(cfg.dir, plan);
            log(`받음: 종목 ${plan.events.length} · 파일 ${state.folder.total} (새로 씀 ${state.folder.written}, 지움 ${state.folder.removed})`);
        }
    } catch (e) {
        if (state.syncError !== e.message) log('서버에서 받지 못함(다시 시도함):', e.message);
        state.syncError = e.message;
    }
}

async function publicState(cfg) {
    let controller = null, controllerError = '';
    let custom = [];
    if (cfg.controller) {
        try { controller = await readStatus(cfg); custom = await readCustomStartLamps(cfg); } catch (e) { controllerError = e.name === 'AbortError' ? '응답 없음' : e.message; }
    }
    // 올린 줄 중 컨트롤러에서 이미 비워진 것은 목록에서 뺀다
    if (controller) for (let i = sent.length - 1; i >= 0; i--) if (controller.slots[sent[i].slot - 1] === 0 && Date.now() - sent[i].at > 3000) sent.splice(i, 1);
    const plan = state.plan;
    return {
        version: AGENT_VERSION, competition_id: cfg.comp, competition_name: plan ? plan.competition_name : '',
        server: cfg.server, synced_at: state.syncedAt, sync_error: state.syncError, dir: cfg.dir,
        controller_url: cfg.controller, controller, controller_error: controllerError,
        sent: sent.map(s => ({ slot: s.slot, event_id: s.event_id, label: s.label, color_key: s.color_key })),
        events: plan ? plan.events.map(ev => ({
            id: ev.id, event_name: ev.event_name, label: ev.label,
            start_lamp: defaultStartLamp(ev, custom), start_lamp_calc: ev.files[0] ? ev.files[0].controller.startLamp : 0,
            files: ev.files.map(f => ({ color_key: f.color_key, filename: f.filename, total_seconds: f.total_seconds, converted: f.converted })),
            skipped: ev.skipped,
        })) : [],
    };
}

function readBody(req) {
    return new Promise((resolve, reject) => { let b = ''; req.on('data', d => { b += d; if (b.length > 1e5) req.destroy(); }); req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } }); req.on('error', reject); });
}
function startPage(cfg) {
    const server = http.createServer(async (req, res) => {
        const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
        try {
            const url = req.url.split('?')[0];
            if (req.method === 'GET' && url === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(PAGE); }
            if (req.method === 'GET' && url === '/favicon.ico') { res.writeHead(204); return res.end(); }
            if (req.method === 'GET' && url === '/api/state') return send(200, await publicState(cfg));
            if (req.method === 'POST') {
                // 다른 웹 페이지가 몰래 부르지 못하게 — 이 화면만 붙이는 머리글 + 같은 주소에서 온 요청만
                const origin = req.headers.origin || '';
                if (req.headers['x-pacerise-agent'] !== '1' || (origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))) return send(403, { error: 'forbidden' });
                if (!cfg.controller) return send(400, { error: 'config.json 에 controller 주소가 없습니다' });
                const body = await readBody(req);
                if (url === '/api/send') {
                    const ev = state.plan && state.plan.events.find(e => e.id === parseInt(body.event_id, 10));
                    if (!ev) return send(404, { error: '그 종목이 없습니다 — 새로 고친 뒤 다시 해 보세요' });
                    const lamp = body.start_lamp === '' || body.start_lamp == null ? undefined : parseInt(body.start_lamp, 10);
                    return send(200, await sendEvent(cfg, ev, { startLamp: lamp }));
                }
                if (url === '/api/cancel') return send(200, await cancelSent(cfg));
            }
            send(404, { error: 'not found' });
        } catch (e) {
            send(502, { error: e.name === 'AbortError' ? '컨트롤러가 응답하지 않습니다' : e.message });
        }
    });
    return new Promise((resolve, reject) => { server.once('error', reject); server.listen(cfg.port, '127.0.0.1', () => resolve(server)); });
}

async function main() {
    const fileCfg = process.pkg ? readConfigFile() : (fs.existsSync(path.join(baseDir(), 'config.json')) ? readConfigFile() : null);
    if (process.pkg && !fileCfg) {
        fs.writeFileSync(path.join(baseDir(), 'config.json'), JSON.stringify(CONFIG_TEMPLATE, null, 2) + '\n');
        console.log('config.json 을 만들었습니다. competition_id(대회 번호)와 controller(WaveLight 주소)를 채우고 다시 실행하세요.');
        return;
    }
    const cfg = loadConfig(process.argv.slice(2), fileCfg);
    if (!cfg.comp) { console.error('대회 번호(competition_id)가 필요합니다 — config.json 을 확인하세요.'); process.exit(2); }
    log(`WaveLight 에이전트 v${AGENT_VERSION} 시작 — 서버 ${cfg.server} · 대회 ${cfg.comp} · 폴더 ${cfg.dir}` + (cfg.controller ? ` · 컨트롤러 ${cfg.controller}` : ' · 컨트롤러 주소 없음(폴더 맞추기만)'));
    await syncOnce(cfg);
    if (cfg.once) { if (state.syncError) process.exit(1); return; }
    setInterval(() => syncOnce(cfg), cfg.interval * 1000);
    try { await startPage(cfg); log(`보내기 화면: http://localhost:${cfg.port}  (이 PC 의 브라우저에서 여세요)`); }
    catch (e) { log(`보내기 화면을 열 수 없습니다(포트 ${cfg.port}): ${e.message} — 폴더 맞추기는 계속합니다`); }
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { loadConfig, fetchPlan, syncFolder, parseStatus, readStatus, defaultStartLamp, buildCommand06, sendEvent, cancelSent, startPage, syncOnce, publicState, state, sent, AGENT_VERSION, CONFIG_TEMPLATE, MANIFEST };
