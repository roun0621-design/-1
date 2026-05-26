#!/usr/bin/env node
/**
 * 2026 해남 데일리 조편성 → 시스템 업로드 표준 양식 변환기
 *
 * Input  : 2026 해남 대학부/실업부 데일리1일.xlsx
 *          (섹션: "남자(대학|실업)부" / "여자(대학|실업)부"
 *           이벤트: "▣ <종목명> (<라운드포맷>)" 또는 "▣ <종목명>(<종합경기>)"
 *           조 헤더: ["", "N조"|"", "레인"|"순", "번호", "성명", "소속"]
 *           데이터: ["", "", lane/order, bib, name, team])
 *
 * Output : 표준 조편성 양식 xlsx
 *          시트 "조편성", 9열 헤더:
 *            성별 | 종목 | 라운드 | 조 | 그룹 | 순서 | 배번 | 성명 | 소속
 *
 * 변환 규칙:
 *   - 성별        : "남자..." → "남",  "여자..." → "여"
 *   - 종목        : "▣ 100m (5-1+3)" → "100m"
 *                  "▣ 100m(10종)" → "100m" + 라운드="10종"
 *                  "▣ 100mH(7종)" → "100mH" + 라운드="7종"
 *   - 라운드      : "(결승)" → "결승"
 *                  "(N-M+K)" 형식 (예선 다조) → "예선"
 *                  "(10종)" / "(7종)" → "10종" / "7종"
 *   - 조          : "N조" → N, 미명시(결승 등) → "1"
 *   - 그룹        : 비움
 *   - 순서        : 데이터 row 의 col[2] (레인 또는 순)
 *                  4x100mR/계주에서 두 번째 이후 멤버는 첫 행 lane 을 상속
 *   - 배번        : col[3]
 *   - 성명        : col[4]
 *   - 소속        : col[5] (계주에서 비어있으면 첫 멤버 team 상속)
 *
 * 출력 파일 한 개에 두 입력 파일을 모두 합쳐서 저장.
 */

const path = require('path');
const fs   = require('fs');
const XLSX = require('/home/user/webapp/node_modules/xlsx');

// ────────────────────────────────────────────────────────────────────────────
// 1. 입력 파일 NFC 정규화로 찾기
// ────────────────────────────────────────────────────────────────────────────
const INPUT_DIR = '/home/user/uploaded_files';
const INPUT_NAMES = [
  '2026 해남 대학부 데일리1일.xlsx',
  '2026 해남 실업부 데일리1일.xlsx',
];
const allFiles = fs.readdirSync(INPUT_DIR);
const inputFiles = [];
for (const want of INPUT_NAMES) {
  const wantNFC = want.normalize('NFC');
  const hit = allFiles.find(f => f.normalize('NFC') === wantNFC);
  if (!hit) throw new Error(`입력 파일을 찾을 수 없습니다: ${want}`);
  inputFiles.push({
    label: want.includes('대학부') ? '대학부' : '실업부',
    fullpath: path.join(INPUT_DIR, hit),
  });
}

// ────────────────────────────────────────────────────────────────────────────
// 2. 헤더 인식 헬퍼들
// ────────────────────────────────────────────────────────────────────────────

// "남자대학부" / "여자실업부" → "남" / "여"   |  매칭 안 되면 null
function detectGenderHeader(row) {
  const c0 = (row[0] || '').toString().trim();
  if (/^남자.*부$/.test(c0)) return '남';
  if (/^여자.*부$/.test(c0)) return '여';
  return null;
}

// "▣ 100m (5-1+3)"  → { event:"100m", round:"예선" }
// "▣ 400m (결승)"   → { event:"400m", round:"결승" }
// "▣ 100m(10종)"    → { event:"100m", round:"10종" }
// "▣ 100mH(7종)"    → { event:"100mH", round:"7종" }
// "▣ 높이뛰기 (결승)" → { event:"높이뛰기", round:"결승" }
function detectEventHeader(row) {
  // event headers live in col[1] in these files
  const raw = (row[1] || '').toString().trim();
  if (!raw.startsWith('▣')) return null;
  // strip leading "▣" and trailing whitespace
  let s = raw.replace(/^▣\s*/, '').trim();

  // Try to split into event + bracket
  //  공백을 사이에 둘 수도 있고 (예: "100m (결승)") 붙어 있을 수도 있음 (예: "100m(10종)")
  const m = s.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (!m) {
    // No bracket present → assume final
    return { event: s, round: '결승' };
  }
  let event = m[1].trim();
  const inside = m[2].trim();

  let round;
  if (inside === '결승') round = '결승';
  else if (inside === '10종') round = '10종';
  else if (inside === '7종')  round = '7종';
  else if (/^\d+-\d+(\+\d+)?$/.test(inside)) round = '예선'; // "5-1+3" 등
  else if (inside === '예선') round = '예선';
  else round = inside; // fallback

  return { event, round };
}

// "1조" 같은 셀이 들어있는 row 가 heat-header
//  col[1] == "N조"  &&  col[2] in ("레인", "순")
//  단, col[1] 이 비었지만 col[2] 가 "레인"/"순" 인 경우(결승 단일조)도 헤더
function detectHeatHeader(row) {
  const c1 = (row[1] || '').toString().trim();
  const c2 = (row[2] || '').toString().trim();
  const isOrderCol = c2 === '레인' || c2 === '순';
  if (!isOrderCol) return null;

  let heatNum = null;
  const mm = c1.match(/^(\d+)\s*조$/);
  if (mm) heatNum = mm[1];
  // 결승 단일조: c1 empty → heat=1
  if (!heatNum) heatNum = '1';

  return { heat: heatNum, orderLabel: c2 }; // orderLabel "레인" or "순"
}

// 데이터 row 인지 체크 — bib(col[3]) 와 성명(col[4]) 이 둘 다 비어있지 않으면 데이터
function isDataRow(row) {
  const bib  = (row[3] || '').toString().trim();
  const name = (row[4] || '').toString().trim();
  return bib !== '' && name !== '';
}

// ────────────────────────────────────────────────────────────────────────────
// 3. 메인 파싱 루프 — 대학부 / 실업부 별도로 저장
// ────────────────────────────────────────────────────────────────────────────
const outRows  = [];                  // 합본
const rowsByDivision = { '대학부': [], '실업부': [] };

for (const { label, fullpath } of inputFiles) {
  console.log(`\n=== ${label}  (${path.basename(fullpath)}) ===`);
  const wb = XLSX.readFile(fullpath);
  for (const sn of wb.SheetNames) {
    const ws  = wb.Sheets[sn];
    const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });

    let curGender = null;     // "남" / "여"
    let curEvent  = null;     // 예: "100m"
    let curRound  = null;     // 예: "예선" / "결승" / "10종" / "7종"
    let curHeat   = null;     // 예: "1"
    let curOrderLabel = null; // "레인" / "순"
    // 계주에서 첫 번째 멤버의 lane/team 을 다음 멤버들에게 상속
    let inheritedLane = '';
    let inheritedTeam = '';
    let isRelay = false;      // 4x100mR 등
    let relayMemberIdx = 0;   // 같은 팀 내 멤버 카운트 (출력에는 사용 안하지만 디버깅용)

    let beforeCount = outRows.length;

    for (let i = 0; i < grid.length; i++) {
      const row = grid[i];
      if (!row || row.every(c => (c == null ? '' : String(c)).trim() === '')) continue;

      // 1) 성별 헤더?
      const g = detectGenderHeader(row);
      if (g) { curGender = g; continue; }

      // 2) 이벤트 헤더?
      const ev = detectEventHeader(row);
      if (ev) {
        curEvent = ev.event;
        curRound = ev.round;
        // 이벤트가 새로 시작하면 heat / 계주 inherit 정보 reset
        curHeat = null;
        inheritedLane = '';
        inheritedTeam = '';
        isRelay = /^\d+x\d+m?R$/.test(curEvent) || /R$/.test(curEvent) && /^\d+x/.test(curEvent);
        // 더 안전한 계주 판별: 종목명에 'R' 끝
        isRelay = /^\d+x\d+m?R$/.test(curEvent);
        relayMemberIdx = 0;
        // "(결승)" 단일조: heat 미정의 → 다음 heat 헤더가 나오면 그때 결정.
        //   하지만 (결승) 인데 heat 헤더가 1조 없이 바로 lane 헤더만 나오는 케이스 있음 → 헤더 감지 시 1 로 처리
        continue;
      }

      // 3) 조 / lane-header?
      const hh = detectHeatHeader(row);
      if (hh) {
        curHeat = hh.heat;
        curOrderLabel = hh.orderLabel;
        // 새 heat 시작 → 계주 상속 초기화
        inheritedLane = '';
        inheritedTeam = '';
        relayMemberIdx = 0;
        continue;
      }

      // 4) 데이터 row?
      if (!isDataRow(row)) continue;
      if (!curGender || !curEvent || !curRound || !curHeat) {
        // 헤더가 아직 안 잡힌 상태에서의 데이터 → 스킵 + 경고
        console.warn(`  ⚠ skip row ${i + 1}: header not ready  ${JSON.stringify(row.slice(0, 6))}`);
        continue;
      }

      let lane = (row[2] || '').toString().trim();
      const bib  = (row[3] || '').toString().trim();
      const name = (row[4] || '').toString().trim();
      let team   = (row[5] || '').toString().trim();

      // 계주: lane 이 비어있고 inheritedLane 이 있으면 같은 팀 멤버
      if (isRelay) {
        if (lane === '') {
          lane = inheritedLane;
          if (team === '') team = inheritedTeam;
          relayMemberIdx += 1;
        } else {
          // 첫 멤버 — 상속 정보 갱신
          inheritedLane = lane;
          inheritedTeam = team;
          relayMemberIdx = 1;
        }
      }

      const rec = {
        성별: curGender,
        종목: curEvent,
        라운드: curRound,
        조: curHeat,
        그룹: '',
        순서: lane,
        배번: bib,
        성명: name,
        소속: team,
      };
      outRows.push(rec);
      rowsByDivision[label].push(rec);
    }

    console.log(`  → ${outRows.length - beforeCount} rows generated`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 4. 출력 xlsx 작성
// ────────────────────────────────────────────────────────────────────────────
const HEADER = ['성별', '종목', '라운드', '조', '그룹', '순서', '배번', '성명', '소속'];
const COL_WIDTHS = [
  { wch: 6 }, { wch: 14 }, { wch: 8 }, { wch: 6 }, { wch: 6 },
  { wch: 6 }, { wch: 8 }, { wch: 14 }, { wch: 28 },
];

function writeBook(rows, outPath) {
  const aoa = [HEADER, ...rows.map(r => HEADER.map(h => r[h]))];
  const wb  = XLSX.utils.book_new();
  const ws  = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = COL_WIDTHS;
  XLSX.utils.book_append_sheet(wb, ws, '조편성');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  XLSX.writeFile(wb, outPath);
}

const OUT_DIR = '/home/user/webapp/output';
const OUT_ALL = path.join(OUT_DIR, '2026_해남_조편성_데일리1일_전체.xlsx');
const OUT_COL = path.join(OUT_DIR, '2026_해남_대학부_조편성_데일리1일.xlsx');
const OUT_PRO = path.join(OUT_DIR, '2026_해남_실업부_조편성_데일리1일.xlsx');

writeBook(outRows,                   OUT_ALL);
writeBook(rowsByDivision['대학부'],  OUT_COL);
writeBook(rowsByDivision['실업부'],  OUT_PRO);

console.log(`\n✅ 출력 완료:`);
console.log(`   • ${OUT_ALL}   (${outRows.length} 행 — 합본)`);
console.log(`   • ${OUT_COL}   (${rowsByDivision['대학부'].length} 행)`);
console.log(`   • ${OUT_PRO}   (${rowsByDivision['실업부'].length} 행)`);

// ────────────────────────────────────────────────────────────────────────────
// 5. 분포 요약 출력 (검수용)
// ────────────────────────────────────────────────────────────────────────────
const summary = {};
for (const r of outRows) {
  const key = `${r.성별}/${r.종목}/${r.라운드}`;
  if (!summary[key]) summary[key] = { heats: new Set(), count: 0 };
  summary[key].heats.add(r.조);
  summary[key].count += 1;
}
console.log('\n── 종목/라운드별 분포 ──');
const keys = Object.keys(summary).sort();
for (const k of keys) {
  const s = summary[k];
  console.log(`  ${k.padEnd(28)}  조:${[...s.heats].sort((a, b) => +a - +b).join(',').padEnd(10)}  rows:${s.count}`);
}
