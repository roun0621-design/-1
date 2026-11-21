#!/usr/bin/env node
'use strict';
/**
 * WaveLight 에이전트 · 운영 콘솔 (2026-11-21) — 계측 에이전트(scripts/timing-watcher)를 거꾸로 쓴 꼴
 *   WaveLight 컨트롤러와 같은 네트워크에 있는 PC 에서 띄워 둔다. 하는 일:
 *     1) 폴더 맞추기 — 서버(관리 › 페이싱 라이트)에 저장된 내용을 주기적으로 받아 wavelight 폴더의 .pc2 를 최신으로 맞춘다.
 *        (프로그램의 Complex › Load file 로 손으로 넣을 때 쓰는 파일. 에이전트가 만든 파일만 지우고, 다른 파일은 건드리지 않는다)
 *     2) 컨트롤러에 올리기 — 콘솔(http://localhost:5010)에서 종목을 고르면, 색마다 빈 줄에 구간·색·출발선을 넣어
 *        **출발 신호 대기** 상태로 올린다(컨트롤러의 Wait for shotgun 과 같은 상태).
 *     3) 운영 콘솔 — 우리 시스템의 경기 진행 상태(예정 · 진행 중 · 완료)와 컨트롤러 줄 10개의 상태(비어 있음 · 대기 · 진행 중)를
 *        한 화면에 나란히 보여 주고, 둘이 어긋나면 알려 준다. 출발(Fire) · 취소도 여기서 한다.
 *        '자동 올리기'를 켜면 경기가 '진행 중'(소집 완료)으로 바뀌는 순간 그 종목을 대기로 올린다. 출발은 언제나 사람이(Fire 또는 출발 신호).
 *     에이전트는 조명 전원·밝기를 건드리지 않고, 취소는 에이전트가 올린 줄만 한다. 한 일은 logs/ 폴더에 날짜별로 남긴다.
 *
 *   컨트롤러 명령은 'Wavelight event tool' 5.0 화면이 보내는 것과 같다(docs/WAVELIGHT.md):
 *     GET  /command09   상태 60바이트(줄 1~10 상태 · 조명 전원 · 버전 · 한 바퀴 조명 수 …, 끝 2바이트 = 앞 58바이트 합)
 *     POST /command06   { runnerArrayNumber, Steps:[{NumberOfLamps, Duration(ms)}], colourNumber, startingDelay(출발선 조명), startingDelayInSeconds(255 = 출발 신호 대기), isHideEnabled, isPilotEnabled }
 *     POST /command08   { runnerArrayNumber }  줄 취소
 *     POST /command12   대기 중인 줄 출발(Fire)
 *
 *   node scripts/wavelight-agent/agent.js --server https://pace-rise-node.com --comp 63 --controller http://192.168.1.240:5001 [--dir <폴더>] [--port 5010] [--once]
 *   실행 파일(build-agent.sh)로 묶으면 옆의 config.json 을 읽는다. Node 18+, 외부 패키지 없음.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const PAGE = require('./page');

const AGENT_VERSION = '1.1.0';
function baseDir() { return process.pkg ? path.dirname(process.execPath) : __dirname; }
const CONFIG_TEMPLATE = {
    server: 'https://pace-rise-node.com',
    competition_id: 0,
    controller: 'http://192.168.1.240:5001',
    dir: '',
    interval: 5,
    port: 5010,
    host: '',
    _help: 'server: 서버 주소 / competition_id: 대회 번호(관리자 화면 주소의 id) / controller: WaveLight 화면을 여는 주소에서 /wavelight 앞까지(비우면 폴더 맞추기만) / dir: .pc2 를 둘 폴더(비우면 옆의 wavelight 폴더) / interval: 서버 확인 주기(초) / port: 이 PC 에서 여는 콘솔 번호 / host: 조직 서브도메인(예 jp.pace-rise-node.com)',
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
        interval: Math.max(2, parseInt(pick('interval', 'PACE_WL_INTERVAL', 'interval', '5'), 10) || 5),
        port: parseInt(pick('port', 'PACE_WL_PORT', 'port', '5010'), 10) || 5010,
        host: String(pick('host', 'PACE_HOST', 'host', '')),
        logDir: String(pick('log-dir', 'PACE_WL_LOG_DIR', 'log_dir', '')),
        once: a.once === '1',
    };
}

// ───────────────────────── 기록 ─────────────────────────
const LOG = { dir: '', recent: [] };      // dir 이 있으면 logs/wavelight-agent-YYYY-MM-DD.log 에도 남긴다
const pad = n => String(n).padStart(2, '0');
function ts(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }
function log(...m) {
    const line = `[${ts()}] ${m.join(' ')}`;
    console.log(line);
    LOG.recent.push(line); if (LOG.recent.length > 200) LOG.recent.shift();
    if (LOG.dir) { try { fs.mkdirSync(LOG.dir, { recursive: true }); fs.appendFileSync(path.join(LOG.dir, `wavelight-agent-${ts().slice(0, 10)}.log`), line + '\n'); } catch (e) {} }
}
const COLOR_KO = { green: '초록', red: '빨강', white: '흰색', blue: '파랑' };
const STATE_KO = { 0: '비어 있음', 1: '진행 중', 2: '출발 신호 대기' };
function clock(sec) { const t = Math.round(sec * 100) / 100, m = Math.floor(t / 60), s = Math.round((t - m * 60) * 100) / 100; return `${m}:${s < 10 ? '0' : ''}${Number.isInteger(s) ? s : s.toFixed(2)}`; }

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
/** returns { status, text } */
async function ctlFetch(cfg, pathName, body, isPost) {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 4000);
    try {
        const r = await fetch(cfg.controller + pathName, !isPost ? { signal: ctrl.signal } : {
            method: 'POST', signal: ctrl.signal,
            headers: { 'Content-Type': 'application/json;charset=UTF-8' },
            body: body === undefined ? undefined : JSON.stringify(body, null, '\t'),      // 프로그램 화면이 보내는 꼴 그대로
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return { status: r.status, text: await r.text() };
    } finally { clearTimeout(t); }
}
const ctlPost = (cfg, pathName, body) => ctlFetch(cfg, pathName, body, true);
// 읽기(GET)는 한 번 더 해 본다 — 컨트롤러 웹 서버는 한 번에 요청 하나만 받아서, WaveLight 화면의 5초 확인과 겹치면 가끔 끊긴다. 올리기(POST)는 다시 보내지 않는다.
async function ctlGet(cfg, pathName) {
    try { return (await ctlFetch(cfg, pathName)).text; } catch (e) { await new Promise(r => setTimeout(r, 300)); return (await ctlFetch(cfg, pathName)).text; }
}
const ackOf = text => (text === '\u0006' ? 'ACK' : text ? JSON.stringify(text.slice(0, 40)) : '빈 응답');

// 컨트롤러의 마지막 상태 + 에이전트가 올린 줄
const ctl = { status: null, error: '', at: 0, custom: [], customAt: 0 };
const lines = new Map();   // 줄 번호 → { slot, event_id, label, color_key, filename, total_seconds, steps, startLamp, sentAt, firedAt, state }

async function readStatus(cfg) {
    const s = parseStatus(JSON.parse(await ctlGet(cfg, '/command09')));
    if (!s) throw new Error('컨트롤러 응답을 읽을 수 없습니다');
    ctl.status = s; ctl.error = ''; ctl.at = Date.now();
    onStatus(s);
    return s;
}
/** 상태가 바뀐 것을 올린 줄에 반영 — 다른 곳(WaveLight 화면의 Fire · 출발 신호)에서 출발했어도 여기서 알아챈다 */
function onStatus(s, now = Date.now()) {
    for (const l of [...lines.values()]) {
        const cur = s.slots[l.slot - 1];
        if (cur === 1 && !l.firedAt) { l.firedAt = now; log(`출발: 줄 ${l.slot} ${COLOR_KO[l.color_key] || l.color_key} · ${l.label} (콘솔 밖에서 출발)`); }
        if (cur === 0 && now - l.sentAt > 1500) {
            if (l.firedAt) log(`끝남: 줄 ${l.slot} ${COLOR_KO[l.color_key] || l.color_key} · ${l.label} — 출발 뒤 ${clock(Math.round((now - l.firedAt) / 100) / 10)} (목표 ${clock(l.total_seconds)})`);
            else log(`비워짐: 줄 ${l.slot} ${COLOR_KO[l.color_key] || l.color_key} · ${l.label} (출발 전에 취소됨)`);
            lines.delete(l.slot); continue;
        }
        l.state = cur;
    }
}
/** 컨트롤러에 저장된 '사용자 지정 출발선' 조명 번호들 (없으면 []) — 1분 동안 기억 */
async function readCustomStartLamps(cfg) {
    if (Date.now() - ctl.customAt < 60000) return ctl.custom;
    try {
        ctl.custom = (JSON.parse(await ctlGet(cfg, '/loadSettingsFromAFile')).customStartingLineLampNumbers || []).map(n => parseInt(n, 10)).filter(n => n >= 0 && n < 400);
        ctl.customAt = Date.now();
    } catch (e) {}
    return ctl.custom;
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
        startingDelayInSeconds: 255,                     // 항상 '출발 신호 대기' — 올리는 것만으로는 조명이 출발하지 않는다
    };
}

/** 종목 하나를 컨트롤러에 올린다 — 색마다 빈 줄 하나. returns { ok, lines:[{slot,color_key,filename,state}], error } */
async function sendEvent(cfg, event, opts = {}) {
    const files = (event.files || []).filter(f => !opts.colors || opts.colors.includes(f.color_key));
    if (!files.length) return { ok: false, error: '보낼 색이 없습니다 (랩타임이 비어 있음)' };
    const st = await readStatus(cfg);
    if (st.lampsInRound !== 400 && st.lampsInRound !== 398) return { ok: false, error: `이 컨트롤러는 한 바퀴 조명이 ${st.lampsInRound}개입니다 — 400m 트랙 기준 설정만 올릴 수 있습니다` };
    const idle = st.slots.map((v, i) => (v === 0 ? i + 1 : 0)).filter(Boolean);
    if (idle.length < files.length) return { ok: false, error: `빈 줄이 ${idle.length}개뿐입니다 (필요 ${files.length}) — 쓰지 않는 줄을 취소하세요` };
    const startLamp = Number.isInteger(opts.startLamp) && opts.startLamp >= 0 && opts.startLamp < 400
        ? opts.startLamp : defaultStartLamp(event, await readCustomStartLamps(cfg));
    log(`올리기 시작${opts.auto ? '(자동)' : ''}: ${event.label} — ${files.length}줄 · 출발선 조명 ${startLamp} · 출발 신호 대기`);
    const out = [];
    for (let i = 0; i < files.length; i++) {
        const f = files[i], slot = idle[i];
        const cs = f.controller.steps;
        const r = await ctlPost(cfg, '/command06', buildCommand06(f, slot, startLamp));
        log(`  줄 ${slot} ${COLOR_KO[f.color_key] || f.color_key} ${clock(f.total_seconds)} (${cs.length}구간 · 조명 ${cs.reduce((a, s) => a + s.NumberOfLamps, 0)}m · ${(cs.reduce((a, s) => a + s.Duration, 0) / 1000).toFixed(2)}초) → 컨트롤러 응답 ${r.status} ${ackOf(r.text)}`);
        out.push({ slot, color_key: f.color_key, filename: f.filename });
        lines.set(slot, { slot, event_id: event.id, label: event.label, color_key: f.color_key, filename: f.filename, total_seconds: f.total_seconds, steps: cs, startLamp, sentAt: Date.now(), firedAt: 0, state: 2 });
    }
    await new Promise(r => setTimeout(r, opts.settleMs != null ? opts.settleMs : 700));
    const after = await readStatus(cfg);
    for (const l of out) l.state = after.slots[l.slot - 1];
    const missed = out.filter(l => l.state === 0);
    for (const l of missed) lines.delete(l.slot);
    log(`올리기 ${missed.length ? '실패' : '완료'}: ${event.label} — ${out.map(l => `줄 ${l.slot} 상태 ${l.state}(${STATE_KO[l.state] || '?'})`).join(' · ')} · 조명 전원 ${after.lampsOn ? '켜짐' : '꺼짐'}`);
    return { ok: missed.length === 0, startLamp, lines: out, lampsOn: after.lampsOn, error: missed.length ? `컨트롤러가 줄 ${missed.map(l => l.slot).join(', ')} 을 받지 않았습니다` : undefined };
}

/** 출발(Fire) — 대기 중인 줄을 모두 출발시킨다(WaveLight 화면의 Fire 와 같다) */
async function fire(cfg, opts = {}) {
    const st = await readStatus(cfg);
    const armed = st.slots.map((v, i) => (v === 2 ? i + 1 : 0)).filter(Boolean);
    if (!armed.length) return { ok: false, error: '출발 신호를 기다리는 줄이 없습니다' };
    const r = await ctlPost(cfg, '/command12');
    const now = Date.now();
    for (const n of armed) { const l = lines.get(n); if (l && !l.firedAt) l.firedAt = now; }
    await new Promise(res => setTimeout(res, opts.settleMs != null ? opts.settleMs : 600));
    const after = await readStatus(cfg);
    const running = armed.filter(n => after.slots[n - 1] === 1);
    log(`Fire: 줄 ${armed.join(' · ')} → 컨트롤러 응답 ${r.status} ${ackOf(r.text)} · 진행 중 ${running.length}줄` + (after.lampsOn ? '' : ' · 조명 전원 꺼짐'));
    return { ok: running.length > 0, started: running, lampsOn: after.lampsOn, error: running.length ? undefined : '컨트롤러가 출발하지 않았습니다' };
}

/** 에이전트가 올린 줄 중 아직 컨트롤러에 남아 있는 것만 취소 (slot 을 주면 그 줄만) */
async function cancelSent(cfg, slot) {
    const st = await readStatus(cfg);
    const slots = [...lines.keys()].filter(n => (slot == null || n === slot) && st.slots[n - 1] !== 0).sort((a, b) => a - b);
    for (const n of slots) {
        const r = await ctlPost(cfg, '/command08', { runnerArrayNumber: n });
        const l = lines.get(n);
        log(`취소: 줄 ${n} ${COLOR_KO[l.color_key] || l.color_key} · ${l.label} → 컨트롤러 응답 ${r.status}`);
        lines.delete(n);
    }
    if (slot == null) lines.clear();
    return { ok: true, cancelled: slots };
}

// 컨트롤러 조작(올리기 · Fire · 취소)은 한 번에 하나씩 — 올리는 도중에 Fire 가 끼어들지 않게 줄을 세운다
let _chain = Promise.resolve();
function serial(fn) { const p = _chain.then(fn, fn); _chain = p.then(() => {}, () => {}); return p; }

// ───────────────────────── 경기 진행 상태와 맞춰 보기 ─────────────────────────
const state = { plan: null, syncedAt: 0, syncError: '', folder: null, auto: false, live: null, pageAt: 0 };

const ROUND_KO = { preliminary: '예선', semifinal: '준결승', final: '결승' };
const whenKey = r => String((r.date || '') + (r.time || '99'));
/** 종목의 경기 상태: live(진행 중) · next(예정) · done(모두 완료) · ''(대회에 그 종목이 없음) + 표시용 문장 */
function raceOf(ev) {
    const rounds = ev.rounds || [];
    if (!rounds.length) return { status: '', text: '' };
    const name = r => [r.division, ROUND_KO[r.round_type] || r.round_type].filter(Boolean).join(' ');
    const live = rounds.find(r => r.status === 'in_progress');
    if (live) return { status: 'live', text: `${name(live)} 진행 중`, round: live };
    const next = rounds.filter(r => r.status !== 'completed').sort((a, b) => whenKey(a).localeCompare(whenKey(b)))[0];
    if (next) return { status: 'next', text: `${name(next)} 예정${next.time ? ' ' + next.time : ''}`, round: next };
    return { status: 'done', text: '완료' };
}
/**
 * 경기와 조명이 맞는지 한 문장으로 — level: ok(맞음) · warn(어긋남) · idle(할 일 없음)
 *   lineList: 에이전트가 올린 줄 [{ event_id, state }]
 */
function syncSummary(plan, lineList) {
    const events = (plan && plan.events) || [];
    const label = id => { const e = events.find(x => x.id === id); return e ? e.label : '다른 종목'; };
    const liveEv = events.filter(e => raceOf(e).status === 'live');
    const loaded = [...new Set(lineList.map(l => l.event_id))];
    const running = [...new Set(lineList.filter(l => l.state === 1).map(l => l.event_id))];
    if (liveEv.length) {
        const ids = liveEv.map(e => e.id);
        const stray = loaded.filter(id => !ids.includes(id));
        if (stray.length) return { level: 'warn', text: `경기는 ${liveEv.map(e => e.label).join(' · ')} 인데 조명은 ${stray.map(label).join(' · ')} 이(가) 올라가 있습니다` };
        const hit = ids.filter(id => loaded.includes(id));
        if (!hit.length) return { level: 'warn', text: `${liveEv.map(e => e.label).join(' · ')} 경기가 진행 중인데 조명이 올라가 있지 않습니다`, next_id: liveEv[0].id };
        if (hit.some(id => running.includes(id))) return { level: 'ok', text: `${hit.map(label).join(' · ')} — 경기와 조명이 함께 진행 중입니다` };
        return { level: 'ok', text: `${hit.map(label).join(' · ')} — 조명이 출발 신호를 기다립니다` };
    }
    if (running.length) return { level: 'warn', text: `조명은 ${running.map(label).join(' · ')} 이(가) 달리고 있는데 진행 중인 경기가 없습니다` };
    if (loaded.length) return { level: 'ok', text: `${loaded.map(label).join(' · ')} — 조명이 준비되어 있습니다 (경기는 아직 진행 중이 아님)` };
    const next = events.map(e => ({ e, r: raceOf(e) })).filter(x => x.r.status === 'next' && x.e.files.length)
        .sort((a, b) => whenKey(a.r.round).localeCompare(whenKey(b.r.round)))[0];
    if (next) return { level: 'idle', text: `다음 페이싱 종목: ${next.e.label} (${next.r.text})`, next_id: next.e.id };
    return { level: 'idle', text: '진행 중이거나 예정된 페이싱 종목이 없습니다' };
}

async function syncOnce(cfg) {
    try {
        const plan = await fetchPlan(cfg);
        const changed = !state.plan || state.plan.rev !== plan.rev;
        state.plan = plan; state.syncedAt = Date.now(); state.syncError = '';
        if (changed) {
            state.folder = syncFolder(cfg.dir, plan);
            log(`받음: 종목 ${plan.events.length} · 파일 ${state.folder.total} (새로 씀 ${state.folder.written}, 지움 ${state.folder.removed})`);
        }
        // 경기 상태가 '진행 중'으로 바뀐 종목 — 기록에 남기고, 자동 올리기가 켜져 있으면 대기로 올린다 (처음 받은 상태에는 반응하지 않는다)
        const liveNow = new Set(plan.events.filter(e => raceOf(e).status === 'live').map(e => e.id));
        if (state.live) {
            for (const ev of plan.events) {
                if (!liveNow.has(ev.id) || state.live.has(ev.id)) continue;
                log(`경기 진행 중: ${ev.label} (${raceOf(ev).text})`);
                if (state.auto && cfg.controller && ev.files.length && ![...lines.values()].some(l => l.event_id === ev.id)) {
                    try { const r = await serial(() => sendEvent(cfg, ev, { auto: true })); if (!r.ok) log(`자동 올리기 실패: ${ev.label} — ${r.error}`); }
                    catch (e) { log(`자동 올리기 실패: ${ev.label} — ${e.name === 'AbortError' ? '컨트롤러가 응답하지 않습니다' : e.message}`); }
                }
            }
            for (const id of state.live) if (!liveNow.has(id)) { const ev = plan.events.find(e => e.id === id); if (ev) log(`경기 상태 바뀜: ${ev.label} (${raceOf(ev).text})`); }
        }
        state.live = liveNow;
    } catch (e) {
        if (state.syncError !== e.message) log('서버에서 받지 못함(다시 시도함):', e.message);
        state.syncError = e.message;
    }
}

/** 컨트롤러 상태를 주기적으로 — 올린 줄이 있거나 콘솔이 열려 있을 때만 1초마다 */
async function tick(cfg) {
    if (!cfg.controller) return;
    if (!lines.size && Date.now() - state.pageAt > 15000) return;
    try { await readStatus(cfg); } catch (e) { ctl.status = null; ctl.error = e.name === 'AbortError' ? '응답 없음' : e.message; }
}

/** 출발 뒤 지금 몇 번째 구간인지 */
function progressOf(l, now) {
    if (!l.firedAt) return { elapsed: 0, step: 0 };
    const ms = now - l.firedAt; let acc = 0, step = l.steps.length;
    for (let i = 0; i < l.steps.length; i++) { acc += l.steps[i].Duration; if (ms < acc) { step = i + 1; break; } }
    return { elapsed: ms / 1000, step };
}

async function publicState(cfg) {
    state.pageAt = Date.now();
    if (cfg.controller && Date.now() - ctl.at > 2500) { try { await readStatus(cfg); } catch (e) { ctl.status = null; ctl.error = e.name === 'AbortError' ? '응답 없음' : e.message; } }
    const controller = cfg.controller ? ctl.status : null;
    const custom = controller ? await readCustomStartLamps(cfg) : [];
    const plan = state.plan, now = Date.now();
    const mine = [...lines.values()];
    return {
        version: AGENT_VERSION, now, competition_id: cfg.comp, competition_name: plan ? plan.competition_name : '',
        server: cfg.server, synced_at: state.syncedAt, sync_error: state.syncError, dir: cfg.dir, log_dir: LOG.dir,
        controller_url: cfg.controller, controller, controller_error: controller ? '' : ctl.error,
        auto: state.auto,
        sync: syncSummary(plan, mine),
        lines: Array.from({ length: 10 }, (_, i) => {
            const slot = i + 1, l = lines.get(slot), st = controller ? controller.slots[i] : null;
            if (!l) return { slot, state: st, mine: false };
            const p = progressOf(l, now);
            return { slot, state: st, mine: true, event_id: l.event_id, label: l.label, color_key: l.color_key, total_seconds: l.total_seconds, start_lamp: l.startLamp, fired_at: l.firedAt, elapsed: p.elapsed, step: p.step, steps: l.steps.length };
        }),
        // 종목은 경기 순서로: 진행 중 → 예정(시각 순) → 대회에 없는 종목 → 완료
        events: plan ? plan.events.map(ev => ({ ev, r: raceOf(ev) })).sort((a, b) => {
            const rank = x => ({ live: 0, next: 1, '': 2, done: 3 })[x.r.status];
            return rank(a) - rank(b) || whenKey(a.r.round || {}).localeCompare(whenKey(b.r.round || {})) || String(a.ev.event_name).localeCompare(String(b.ev.event_name));
        }).map(({ ev }) => ({
            id: ev.id, event_name: ev.event_name, label: ev.label, race: (r => ({ status: r.status, text: r.text }))(raceOf(ev)),
            start_lamp: defaultStartLamp(ev, custom), start_lamp_calc: ev.files[0] ? ev.files[0].controller.startLamp : 0,
            files: ev.files.map(f => ({ color_key: f.color_key, filename: f.filename, total_seconds: f.total_seconds, converted: f.converted, notes: f.notes || [], steps: f.controller.steps })),
            skipped: ev.skipped,
        })) : [],
        log: LOG.recent.slice(-14),
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
                const body = await readBody(req);
                if (url === '/api/auto') { state.auto = !!body.on; log(`자동 올리기 ${state.auto ? '켬' : '끔'}`); return send(200, { ok: true, auto: state.auto }); }
                if (!cfg.controller) return send(400, { error: 'config.json 에 controller 주소가 없습니다' });
                if (url === '/api/send') {
                    const ev = state.plan && state.plan.events.find(e => e.id === parseInt(body.event_id, 10));
                    if (!ev) return send(404, { error: '그 종목이 없습니다 — 새로 고친 뒤 다시 해 보세요' });
                    const lamp = body.start_lamp === '' || body.start_lamp == null ? undefined : parseInt(body.start_lamp, 10);
                    return send(200, await serial(() => sendEvent(cfg, ev, { startLamp: lamp })));
                }
                if (url === '/api/fire') return send(200, await serial(() => fire(cfg)));
                if (url === '/api/cancel') return send(200, await serial(() => cancelSent(cfg, body.slot == null ? undefined : parseInt(body.slot, 10))));
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
    LOG.dir = cfg.logDir || path.join(baseDir(), 'logs');
    log(`WaveLight 에이전트 v${AGENT_VERSION} 시작 — 서버 ${cfg.server} · 대회 ${cfg.comp} · 폴더 ${cfg.dir}` + (cfg.controller ? ` · 컨트롤러 ${cfg.controller}` : ' · 컨트롤러 주소 없음(폴더 맞추기만)'));
    await syncOnce(cfg);
    if (cfg.once) { if (state.syncError) process.exit(1); return; }
    setInterval(() => syncOnce(cfg), cfg.interval * 1000);
    setInterval(() => tick(cfg), 1000);
    try { await startPage(cfg); log(`콘솔: http://localhost:${cfg.port}  (이 PC 의 브라우저에서 여세요)`); }
    catch (e) { log(`콘솔을 열 수 없습니다(포트 ${cfg.port}): ${e.message} — 폴더 맞추기는 계속합니다`); }
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { loadConfig, fetchPlan, syncFolder, parseStatus, readStatus, defaultStartLamp, buildCommand06, sendEvent, fire, cancelSent, startPage, syncOnce, tick, publicState, raceOf, syncSummary, serial, state, lines, ctl, LOG, AGENT_VERSION, CONFIG_TEMPLATE, MANIFEST };
