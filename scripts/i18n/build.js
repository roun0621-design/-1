#!/usr/bin/env node
'use strict';
/**
 * 사전 빌드 — parts/<lang>_*.json(번역 조각) + 자동 항목(종목 사전·라벨 사전·부 라벨) → public/locales/<lang>.json (2026-09-30, B3)
 *   node scripts/i18n/build.js            en·ja 둘 다
 *   node scripts/i18n/build.js en
 *   우선순위: 자동 항목 < 조각 파일(파일명 순) < public/locales/<lang>.overrides.json(손으로 고친 것, 있으면)
 *   결과 키는 한국어 원문. 값이 원문과 같거나 빈 문자열이면 뺀다(사전 크기·의미 없음).
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const PARTS = path.join(__dirname, 'parts');
const OUT = path.join(ROOT, 'public', 'locales');
const EC = require(path.join(ROOT, 'lib', 'eventCatalog'));
const Labels = require(path.join(ROOT, 'lib', 'labels'));
const HANGUL = /[가-힣]/;

function autoEntries(lang) {
    const d = {};
    for (const e of EC.list()) d[e.ko] = lang === 'ja' ? e.ja : e.en;
    // round_short('예선'→'H')는 뺀다 — '예선'→'Heats' 를 덮으면 안 되니까. gender_short('남'→'M')는 충돌 없어 넣는다
    for (const [group, rows] of Object.entries(Labels.DICT)) { if (group === 'round_short') continue; for (const v of Object.values(rows)) { const t = lang === 'ja' ? (v[2] != null ? v[2] : v[1]) : v[1]; if (v[0] && t) d[v[0]] = t; } }
    // 부 마스터 기본 13 + 학년 20 (DB 없이 시드 기준)
    const base = [['남자초등부', 'M', 'ELEM'], ['남자중학부', 'M', 'MID'], ['남자고등부', 'M', 'HIGH'], ['남자대학부', 'M', 'UNIV'], ['남자일반부', 'M', 'GEN'], ['남자공개부', 'M', 'OPEN'], ['여자초등부', 'F', 'ELEM'], ['여자중학부', 'F', 'MID'], ['여자고등부', 'F', 'HIGH'], ['여자대학부', 'F', 'UNIV'], ['여자일반부', 'F', 'GEN'], ['여자공개부', 'F', 'OPEN'], ['통합부', 'X', 'MIXED']];
    for (const [ko, gender, lv] of base) d[ko] = Labels.divisionLabel({ gender, school_level: lv, label_ko: ko }, lang);
    try { for (const r of require(path.join(ROOT, 'lib', 'division')).gradeDivisionSeed()) d[r[1]] = Labels.divisionLabel({ gender: r[2], school_level: r[3], grade: r[5], label_ko: r[1] }, lang); } catch (e) {}
    // 짧은 부 라벨(종목명 접미로 쓰이는 것)
    const short = { '초등부': ['Elementary', '小学'], '중등부': ['Middle school', '中学'], '고등부': ['High school', '高校'], '대학부': ['University', '大学'], '일반부': ['Senior', '一般'], '실업부': ['Senior (club)', '実業団'], '공개부': ['Open', 'オープン'], '통합부': ['Mixed', '混合'], '선수권': ['Championship', '選手権'] };
    for (const [ko, v] of Object.entries(short)) d[ko] = lang === 'ja' ? v[1] : v[0];
    for (let g = 1; g <= 6; g++) d[`${g}학년부`] = lang === 'ja' ? `${g}年` : `Grade ${g}`;
    for (const [ko, en, ja] of [['초', 'Elem.', '小'], ['중', 'Mid.', '中'], ['고', 'High', '高']]) for (let g = 1; g <= 6; g++) d[`${ko}${g}학년부`] = lang === 'ja' ? `${ja}${g}年` : `${en} Grade ${g}`;
    return d;
}
function build(lang) {
    const dict = autoEntries(lang);
    const files = fs.existsSync(PARTS) ? fs.readdirSync(PARTS).filter(f => f.startsWith(lang + '_') && f.endsWith('.json')).sort() : [];
    for (const f of files) {
        const part = JSON.parse(fs.readFileSync(path.join(PARTS, f), 'utf8'));
        for (const [k, v] of Object.entries(part)) if (typeof v === 'string') dict[k] = v;
    }
    const ovPath = path.join(OUT, lang + '.overrides.json');
    if (fs.existsSync(ovPath)) Object.assign(dict, JSON.parse(fs.readFileSync(ovPath, 'utf8')));
    let n = 0, dropped = 0; const out = {};
    for (const k of Object.keys(dict).sort()) {
        const v = String(dict[k] || '').trim();
        if (!v || v === k) { dropped++; continue; }
        out[k] = v; n++;
    }
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, lang + '.json'), JSON.stringify(out, null, 0));
    const leftover = Object.values(out).filter(v => HANGUL.test(v)).length;
    console.log(`${lang}: ${n} entries (${files.length} parts, ${dropped} dropped, ${leftover} values still contain Hangul) → public/locales/${lang}.json`);
}
const langs = process.argv[2] ? [process.argv[2]] : ['en', 'ja'];
langs.forEach(build);
