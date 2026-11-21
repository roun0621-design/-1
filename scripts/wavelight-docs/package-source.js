#!/usr/bin/env node
'use strict';
/**
 * 제출용 소스코드 묶음 2개 — 날짜가 드러나지 않게 만든다(사용자 요청 — 제출 자료의 날짜 비공개)
 *   1_페이싱_자동생성_전송_모듈_소스코드.zip   2_통합_운영_콘솔_소스코드.zip
 *   · 파일 안에 연도(20xx)가 있으면 멈춘다 — 주석에 날짜를 적지 않는다
 *   · zip 안 파일의 고친 날짜는 모두 같은 고정값(1980-01-01, zip 의 '날짜 없음' 관례)
 *   · 테스트 파일은 넣지 않는다(시험용 대회 날짜가 들어 있다)
 *   node scripts/wavelight-docs/package-source.js [출력 폴더]      (기본: ~/Desktop/WaveLight_증빙/소스코드)
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');

const ROOT = path.join(__dirname, '..', '..');
const OUT = process.argv[2] || path.join(os.homedir(), 'Desktop', 'WaveLight_증빙', '소스코드');
const AGENT = 'scripts/wavelight-agent/';
const SETS = {
    '1_페이싱_자동생성_전송_모듈_소스코드.zip': ['lib/pacingExport.js', 'lib/routes/pacing.js', AGENT + 'agent.js', AGENT + 'build-agent.sh', AGENT + 'agent-README.txt'],
    '2_통합_운영_콘솔_소스코드.zip': [AGENT + 'page.js', AGENT + 'agent.js', 'lib/routes/pacing.js'],
};
const FIXED = new Date(1980, 0, 1, 0, 0, 0);

fs.mkdirSync(OUT, { recursive: true });
for (const [name, files] of Object.entries(SETS)) {
    const zip = new AdmZip();
    for (const f of files) {
        const buf = fs.readFileSync(path.join(ROOT, f));
        const hit = buf.toString('utf8').split('\n').findIndex(l => /(^|[^0-9])20\d\d([^0-9]|$)/.test(l));
        if (hit >= 0) { console.error(`멈춤: ${f}:${hit + 1} 에 연도가 있습니다 — 날짜를 지운 뒤 다시 실행하세요`); process.exit(1); }
        zip.addFile(f, buf);
        zip.getEntry(f).header.time = FIXED;
    }
    const out = path.join(OUT, name);
    zip.writeZip(out);
    console.log('→', out, `(${files.length}개 파일)`);
}
