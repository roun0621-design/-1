/**
 * 부별 종합기록지 Excel 생성기
 * ─────────────────────────────────────────────────────────────
 * 첨부 양식 참고: 2025 KBS 초중고, 2026 춘계 중고, 6회 학년별 종합기록지
 *
 * 특징:
 * - 부(division)별로 시트 분리 (예: 남자초등부, 여자중학부, ...)
 * - DB의 모든 종목을 그대로 출력 (80m, 1000m 등 화이트리스트 없음)
 * - 종목당 1~8위 + 풍속 + 비고(CR/대회신 등) 자동 표시
 * - 릴레이는 멤버 명단 줄바꿈 표시
 * - 혼성경기(5종/7종/10종)는 총점 + 종목명 표시
 *
 * 출력 레이아웃 (각 시트):
 *   R1: (빈줄)
 *   R2:           대회명 (병합, B~N)
 *   R3: 부 이름   장소/날짜
 *   R4: (빈줄)
 *   R5: 순위 |  1위(병합) | 2위(병합) | 3위(병합) | ... | 8위
 *   R6: 종목 | 성명|소속|기록 | 성명|소속|기록 | ...
 *   R7~: 종목별 데이터 (트랙은 풍속 행 추가)
 */

const ExcelJS = require('exceljs');

// ────────────── 스타일 ──────────────
const GOLD = 'FFB79F58';
const DARK = 'FF262324';
const GRAY_BG = 'FFEFEFEF';
const LIGHT_GOLD_BG = 'FFF8F3E8';

const THIN_BORDER = { style: 'thin', color: { argb: '999999' } };
const MED_BORDER = { style: 'medium', color: { argb: '333333' } };

const borderAll = { top: THIN_BORDER, bottom: THIN_BORDER, left: THIN_BORDER, right: THIN_BORDER };
const borderHeader = { top: MED_BORDER, bottom: MED_BORDER, left: THIN_BORDER, right: THIN_BORDER };

const fonts = {
  title: { name: '맑은 고딕', size: 14, bold: true, color: { argb: DARK } },
  subtitle: { name: '맑은 고딕', size: 10, bold: true, color: { argb: DARK } },
  divLabel: { name: '맑은 고딕', size: 11, bold: true, color: { argb: 'FF0050B3' } },
  headerCell: { name: '맑은 고딕', size: 9, bold: true, color: { argb: DARK } },
  eventName: { name: '맑은 고딕', size: 10, bold: true, color: { argb: DARK } },
  data: { name: '맑은 고딕', size: 9 },
  small: { name: '맑은 고딕', size: 8 },
  wind: { name: '맑은 고딕', size: 8, italic: true, color: { argb: 'FF666666' } },
  record: { name: '맑은 고딕', size: 9, bold: true, color: { argb: 'FF2D5016' } },
  noteRecord: { name: '맑은 고딕', size: 8, bold: true, color: { argb: 'FFCC0000' } },
};

const fills = {
  gold: { type: 'pattern', pattern: 'solid', fgColor: { argb: GOLD } },
  gray: { type: 'pattern', pattern: 'solid', fgColor: { argb: GRAY_BG } },
  lightGold: { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHT_GOLD_BG } },
};

const alignCenter = { vertical: 'middle', horizontal: 'center', wrapText: true };
const alignLeft = { vertical: 'middle', horizontal: 'left', wrapText: true, indent: 1 };

// ────────────── 포맷 헬퍼 ──────────────
function fmtTrackTime(seconds) {
  if (seconds == null || seconds === '') return '';
  const s = parseFloat(seconds);
  if (isNaN(s)) return String(seconds);
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s - h * 3600) / 60);
    const r = s - h * 3600 - m * 60;
    return `${h}:${m < 10 ? '0' : ''}${m}:${r < 10 ? '0' : ''}${r.toFixed(2)}`;
  }
  if (s >= 60) {
    const m = Math.floor(s / 60);
    const r = s - m * 60;
    return `${m}:${r < 10 ? '0' : ''}${r.toFixed(2)}`;
  }
  return s.toFixed(2);
}
function fmtFieldDist(meters) {
  if (meters == null || meters === '') return '';
  const v = parseFloat(meters);
  if (isNaN(v)) return String(meters);
  return v.toFixed(2);  // "7.96" 같은 일반 미터 표기 (KBS/춘계 양식)
}
function fmtWind(wind) {
  if (wind == null || wind === '') return '';
  const w = parseFloat(wind);
  if (isNaN(w)) return '';
  return (w >= 0 ? '+' : '') + w.toFixed(1);
}

const WIND_EVENTS = new Set(['100m','200m','110mH','100mH','80m','60m','100m허들','110m허들']);
const FIELD_HORIZ = new Set(['멀리뛰기','세단뛰기']);
const FIELD_THROW = new Set(['포환던지기','원반던지기','해머던지기','창던지기']);
const FIELD_HEIGHT = new Set(['높이뛰기','장대높이뛰기']);

function isTrackEvent(category) {
  return category === 'track' || category === 'road';
}
function isFieldDistance(category, name) {
  return category === 'field_distance' || FIELD_HORIZ.has(name) || FIELD_THROW.has(name);
}
function isFieldHeight(category, name) {
  return category === 'field_height' || FIELD_HEIGHT.has(name);
}
function isWindEvent(name) {
  const n = (name || '').replace(/\s+/g, '');
  if (WIND_EVENTS.has(n)) return true;
  if (FIELD_HORIZ.has(n)) return true;
  return false;
}

// ────────────── 종목 정렬 ──────────────
// 출력 순서: 단거리(짧→긴) → 중장거리 → 허들 → 장애물/경보 → 도약 → 투척 → 혼성 → 릴레이
const EVENT_SORT_KEY = (() => {
  const TRACK_ORDER = ['60m','80m','100m','200m','300m','400m','600m','800m','1000m','1500m','3000m','5000m','10000m'];
  const HURDLE_ORDER = ['80mH','100mH','110mH','300mH','400mH'];
  const SC_WALK = ['2000mSC','3000mSC','3000mW','5000mW','10000mW','20kmW','35kmW','50kmW'];
  const ROAD = ['5K','10K','하프마라톤','마라톤'];
  const FIELD_HEIGHT_LIST = ['높이뛰기','장대높이뛰기'];
  const FIELD_HORIZ_LIST = ['멀리뛰기','세단뛰기'];
  const FIELD_THROW_LIST = ['포환던지기','원반던지기','해머던지기','창던지기'];
  const COMBINED = ['5종경기','7종경기','10종경기'];
  const RELAY_PRIORITY = ['4x100mR','4x400mR','MIXED 4x400mR','4x800mR','4x1500mR'];

  const allOrder = [
    ...TRACK_ORDER,
    ...HURDLE_ORDER,
    ...SC_WALK,
    ...ROAD,
    ...FIELD_HEIGHT_LIST,
    ...FIELD_HORIZ_LIST,
    ...FIELD_THROW_LIST,
    ...COMBINED,
    ...RELAY_PRIORITY,
  ];
  const map = new Map();
  allOrder.forEach((n, i) => map.set(n, i));
  return (name) => {
    if (map.has(name)) return map.get(name);
    // 알 수 없는 종목은 트랙 거리로 추정
    const m = name.match(/(\d+)m/);
    if (m) return 50 + parseInt(m[1]);
    return 9999;
  };
})();

// ────────────── 결과 조회 ──────────────
// 스키마 정리 (확인된 컬럼명):
//   result(id, heat_id, event_entry_id, attempt_number, distance_meters, time_seconds,
//          status_code, wind, remark)
//   height_attempt(id, heat_id, event_entry_id, bar_height, attempt_number, result_mark)
//   combined_score(id, event_entry_id, sub_event_name, sub_event_order, raw_record,
//                  wa_points, status_code)
//   relay_member(id, event_entry_id, athlete_id, leg_order)
//
// (이전 구현이 r.final_time / r.event_id / r.height_meters / relay_team 같은 존재하지
//  않는 컬럼·테이블을 참조하여 트랙·필드·릴레이 종목 결과가 빈 칸으로 출력되던 버그를
//  완전히 다시 작성하여 수정한다.)
async function getTopResultsForEvent(db, evt) {
  const isRelay = evt.category === 'relay';
  const isCombined = evt.category === 'combined';
  const isHeight = isFieldHeight(evt.category, evt.name);
  const isDist = isFieldDistance(evt.category, evt.name);
  const isTrack = isTrackEvent(evt.category);

  // heat 가져오기 (이벤트 별 heat 들. 트랙/릴레이는 예선·결승 다수, 필드/혼성은 1개)
  const heats = await db.all('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number', evt.id);
  if (heats.length === 0) {
    return { rankings: [], category: 'none', hasWind: isWindEvent(evt.name), recordTag: '' };
  }

  // ── 혼성경기: combined_score 합산 ──
  if (isCombined) {
    const heat = heats[0];
    const entries = await db.all(`
      SELECT he.lane_number, ee.id AS event_entry_id, ee.status, ee.athlete_id,
             a.name, a.bib_number, a.team
      FROM heat_entry he
      JOIN event_entry ee ON ee.id=he.event_entry_id
      JOIN athlete a ON a.id=ee.athlete_id
      WHERE he.heat_id=?`, heat.id);

    const athleteData = [];
    for (const e of entries) {
      const scores = await db.all('SELECT * FROM combined_score WHERE event_entry_id=? ORDER BY sub_event_order', e.event_entry_id);
      const totalPoints = scores.reduce((s, sc) => s + (sc.wa_points || 0), 0);
      // status_code: result 또는 combined_score에서 검출
      let status = '';
      try {
        const s1 = await db.get(
          `SELECT status_code FROM result WHERE event_entry_id=? AND status_code IN ('DNS','DNF','DQ') LIMIT 1`,
          e.event_entry_id);
        if (s1?.status_code) status = s1.status_code;
      } catch(_) {}
      if (!status) {
        const s2 = scores.find(sc => sc.status_code && ['DNS','DNF','DQ'].includes(sc.status_code));
        if (s2) status = s2.status_code;
      }
      if (!status && e.status === 'no_show') status = 'DNS';
      athleteData.push({ ...e, totalPoints, status_code: status });
    }
    athleteData.sort((a, b) => {
      const aF = ['DNS','DNF','DQ'].includes(a.status_code);
      const bF = ['DNS','DNF','DQ'].includes(b.status_code);
      if (aF && !bF) return 1;
      if (!aF && bF) return -1;
      return b.totalPoints - a.totalPoints;
    });
    const rankings = athleteData.filter(a => a.status_code !== 'DNS').slice(0, 8).map(a => ({
      name: a.name || '',
      team: a.team || '',
      record: ['DNS','DNF','DQ'].includes(a.status_code) ? a.status_code : String(a.totalPoints || 0),
      wind: null,
    }));
    return { rankings, category: 'combined', hasWind: false, recordTag: '' };
  }

  // ── 필드 (높이뛰기/장대높이뛰기) — height_attempt 기반 ──
  if (isHeight) {
    const heat = heats[0];
    const entries = await db.all(`
      SELECT he.lane_number, ee.id AS event_entry_id, ee.status,
             a.name, a.bib_number, a.team
      FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id
      JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=?`, heat.id);
    const allAttempts = await db.all(
      'SELECT * FROM height_attempt WHERE heat_id=? ORDER BY bar_height, event_entry_id, attempt_number',
      heat.id);

    const athleteData = [];
    for (const e of entries) {
      const myAttempts = allAttempts.filter(a => a.event_entry_id === e.event_entry_id);
      let bestCleared = null, totalMisses = 0, missesAtBest = 0;
      const heights = [...new Set(myAttempts.map(a => a.bar_height))].sort((a, b) => a - b);
      for (const h of heights) {
        const attH = myAttempts.filter(a => a.bar_height === h);
        const misses = attH.filter(a => a.result_mark === 'X').length;
        totalMisses += misses;
        if (attH.some(a => a.result_mark === 'O')) { bestCleared = h; missesAtBest = misses; }
      }
      // height_attempt가 없으면 result.distance_meters 도 시도 (호환)
      const results = await db.all('SELECT * FROM result WHERE heat_id=? AND event_entry_id=?', heat.id, e.event_entry_id);
      let status = results.find(r => r.status_code && ['DNS','DNF','DQ','NM'].includes(r.status_code))?.status_code || '';
      if (!status && e.status === 'no_show') status = 'DNS';
      if (bestCleared === null && !status) {
        const bestR = results.find(r => r.distance_meters != null && r.distance_meters > 0);
        if (bestR) bestCleared = bestR.distance_meters;
      }
      athleteData.push({ ...e, bestCleared, totalMisses, missesAtBest, status_code: status });
    }
    athleteData.sort((a, b) => {
      const aF = ['DNS','DNF','DQ','NM'].includes(a.status_code);
      const bF = ['DNS','DNF','DQ','NM'].includes(b.status_code);
      if (aF && !bF) return 1; if (!aF && bF) return -1;
      if (a.bestCleared == null && b.bestCleared == null) return 0;
      if (a.bestCleared == null) return 1; if (b.bestCleared == null) return -1;
      if (b.bestCleared !== a.bestCleared) return b.bestCleared - a.bestCleared;
      if (a.missesAtBest !== b.missesAtBest) return a.missesAtBest - b.missesAtBest;
      return a.totalMisses - b.totalMisses;
    });
    const rankings = athleteData
      .filter(a => !['DNS','DNF','DQ','NM'].includes(a.status_code) && a.bestCleared != null)
      .slice(0, 8)
      .map(a => ({
        name: a.name || '',
        team: a.team || '',
        record: fmtFieldDist(a.bestCleared),  // 미터 표기 (1.95 등)
        wind: null,
      }));
    return { rankings, category: 'field_height', hasWind: false, recordTag: '' };
  }

  // ── 필드 (도약·투척) — result.distance_meters의 max ──
  if (isDist) {
    const allEntries = [];
    for (const heat of heats) {
      const entries = await db.all(`
        SELECT he.lane_number, ee.id AS event_entry_id, ee.status, ee.athlete_id,
               a.name, a.bib_number, a.team
        FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id
        JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=?`, heat.id);
      const results = await db.all(
        'SELECT * FROM result WHERE heat_id=? ORDER BY event_entry_id, attempt_number',
        heat.id);
      const resMap = {};
      for (const r of results) {
        if (!resMap[r.event_entry_id]) resMap[r.event_entry_id] = [];
        resMap[r.event_entry_id].push(r);
      }
      for (const e of entries) {
        const recs = resMap[e.event_entry_id] || [];
        let best = null, bestWind = null;
        for (const r of recs) {
          // 파울(0)/패스(-1)/X/FOUL 제외
          if (r.distance_meters != null && r.distance_meters > 0 &&
              r.status_code !== 'X' && r.status_code !== 'FOUL') {
            if (best === null || r.distance_meters > best) {
              best = r.distance_meters;
              bestWind = r.wind;
            }
          }
        }
        let status = recs.find(r => r.status_code && ['DNS','DNF','NM','DQ'].includes(r.status_code))?.status_code || '';
        if (!status && e.status === 'no_show') status = 'DNS';
        const allFoul = recs.length > 0 && recs.every(r =>
          r.status_code === 'X' || r.status_code === 'FOUL' || r.distance_meters === 0);
        if (!status && best === null && allFoul) status = 'NM';
        allEntries.push({ ...e, best, bestWind, status_code: status });
      }
    }
    allEntries.sort((a, b) => {
      const aF = ['DNS','DNF','DQ','NM'].includes(a.status_code);
      const bF = ['DNS','DNF','DQ','NM'].includes(b.status_code);
      if (aF && !bF) return 1; if (!aF && bF) return -1;
      if (a.best == null && b.best == null) return 0;
      if (a.best == null) return 1; if (b.best == null) return -1;
      return b.best - a.best;
    });
    const hasWind = isWindEvent(evt.name);
    const rankings = allEntries
      .filter(a => a.status_code !== 'DNS')
      .slice(0, 8)
      .map(a => ({
        name: a.name || '',
        team: a.team || '',
        record: ['DNS','DNF','DQ','NM'].includes(a.status_code) ? a.status_code : fmtFieldDist(a.best),
        wind: (hasWind && a.bestWind != null) ? fmtWind(a.bestWind) : null,
      }));
    return { rankings, category: 'field_distance', hasWind, recordTag: '' };
  }

  // ── 트랙 / 도로 / 릴레이 — result.time_seconds 의 min (heat 통합) ──
  // 트랙: 한 사람당 result row 1개 ( attempt_number=1 )
  // 릴레이도 동일하게 처리하되, 멤버 이름을 줄바꿈으로 합쳐서 표시
  const allEntries = [];
  for (const heat of heats) {
    const entries = await db.all(`
      SELECT he.lane_number, ee.id AS event_entry_id, ee.status, ee.athlete_id,
             a.name, a.bib_number, a.team
      FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id
      JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=?`, heat.id);
    const results = await db.all(
      'SELECT * FROM result WHERE heat_id=? ORDER BY event_entry_id, attempt_number',
      heat.id);
    const resMap = {};
    for (const r of results) {
      if (!resMap[r.event_entry_id]) resMap[r.event_entry_id] = [];
      resMap[r.event_entry_id].push(r);
    }
    for (const e of entries) {
      const recs = resMap[e.event_entry_id] || [];
      // best = MIN(time_seconds) among recs
      let best = null, bestWind = null;
      for (const r of recs) {
        if (r.time_seconds != null && r.time_seconds > 0) {
          if (best == null || r.time_seconds < best) {
            best = r.time_seconds;
            bestWind = r.wind;
          }
        }
      }
      let status = recs.find(r => r.status_code && ['DNS','DNF','NM','DQ'].includes(r.status_code))?.status_code || '';
      if (!status && e.status === 'no_show') status = 'DNS';
      allEntries.push({ ...e, best, bestWind, heat_wind: heat.wind, status_code: status });
    }
  }

  // 정렬 & 동일 event_entry_id 중복 제거 (예선/결승 양쪽에 등장하면 best만 유지)
  const bestByEE = new Map();
  for (const a of allEntries) {
    const cur = bestByEE.get(a.event_entry_id);
    if (!cur) { bestByEE.set(a.event_entry_id, a); continue; }
    // 둘 다 정상 기록인 경우 더 작은 time
    if (a.best != null && (cur.best == null || a.best < cur.best)) {
      bestByEE.set(a.event_entry_id, a);
    }
  }
  const deduped = [...bestByEE.values()];

  deduped.sort((a, b) => {
    const aF = ['DNS','DNF','NM','DQ'].includes(a.status_code);
    const bF = ['DNS','DNF','NM','DQ'].includes(b.status_code);
    if (aF && !bF) return 1; if (!aF && bF) return -1;
    if (a.best == null && b.best == null) return 0;
    if (a.best == null) return 1; if (b.best == null) return -1;
    return a.best - b.best;
  });

  const hasWind = isWindEvent(evt.name);
  const rankings = [];
  for (const a of deduped.filter(e => e.status_code !== 'DNS').slice(0, 8)) {
    const isSpecial = ['DNF','NM','DQ'].includes(a.status_code);
    const entry = {
      name: a.name || '',
      team: a.team || '',
      record: isSpecial ? a.status_code : fmtTrackTime(a.best),
      wind: null,
    };
    if (hasWind) {
      if (a.bestWind != null) entry.wind = fmtWind(a.bestWind);
      else if (a.heat_wind != null) entry.wind = fmtWind(a.heat_wind);
    }
    // 릴레이: 멤버 이름 합치기
    if (isRelay) {
      const members = await db.all(
        `SELECT a.name FROM relay_member rm
         JOIN athlete a ON a.id=rm.athlete_id
         WHERE rm.event_entry_id=? ORDER BY rm.leg_order`,
        a.event_entry_id);
      if (members && members.length > 0) {
        entry.name = members.map(m => m.name).join('\n');
      }
      // 릴레이는 풍속 없음
      entry.wind = null;
    }
    rankings.push(entry);
  }

  return {
    rankings,
    category: isRelay ? 'relay' : 'track',
    hasWind: isRelay ? false : hasWind,
    recordTag: '',
  };
}

// ────────────── 시트 생성 ──────────────
function createDivisionSheet(wb, comp, divLabel, divEvents, eventResults) {
  // 시트 이름 최대 31자, 특수문자 제거
  let sheetName = divLabel.replace(/[\\\/\?\*\[\]:]/g, '').slice(0, 31);
  const ws = wb.addWorksheet(sheetName, {
    views: [{ state: 'frozen', xSplit: 0, ySplit: 6 }],
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  // 열 너비 설정 (16열)
  // A: 종목  B-D: 1위(성명/소속/기록)  E-G: 2위  H-J: 3위  K-M: 4위  N-P: 5위
  const COL_WIDTHS = [
    14,  // A: 종목명
    10, 14, 9,    // B,C,D: 1위
    10, 14, 9,    // E,F,G: 2위
    10, 14, 9,    // H,I,J: 3위
    10, 14, 9,    // K,L,M: 4위
    10, 14, 9,    // N,O,P: 5위
  ];
  COL_WIDTHS.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  // ── R1: 대회명 (병합) ──
  ws.mergeCells('A1:P1');
  const c1 = ws.getCell('A1');
  c1.value = comp.name || '';
  c1.font = fonts.title;
  c1.alignment = alignCenter;
  ws.getRow(1).height = 28;

  // ── R2: 부 라벨 + 장소/기간 ──
  ws.mergeCells('A2:E2');
  const c2a = ws.getCell('A2');
  c2a.value = `▣ ${divLabel}`;
  c2a.font = fonts.divLabel;
  c2a.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  ws.mergeCells('F2:P2');
  const c2b = ws.getCell('F2');
  c2b.value = `(${comp.venue || ''}  ${comp.start_date || ''} ~ ${comp.end_date || ''})`;
  c2b.font = fonts.subtitle;
  c2b.alignment = { vertical: 'middle', horizontal: 'right', indent: 1 };
  ws.getRow(2).height = 22;

  // ── R3: 빈 줄 ──
  ws.getRow(3).height = 6;

  // ── R4: 순위 헤더 (1위~5위 병합) ──
  // 종목 + 1위(B-D) + 2위(E-G) + 3위(H-J) + 4위(K-M) + 5위(N-P)
  ws.mergeCells('A4:A5');
  ws.getCell('A4').value = '종목';
  ws.getCell('A4').font = fonts.headerCell;
  ws.getCell('A4').alignment = alignCenter;
  ws.getCell('A4').fill = fills.lightGold;
  ws.getCell('A4').border = borderHeader;

  const ranks = [
    { label: '1위', start: 'B', end: 'D' },
    { label: '2위', start: 'E', end: 'G' },
    { label: '3위', start: 'H', end: 'J' },
    { label: '4위', start: 'K', end: 'M' },
    { label: '5위', start: 'N', end: 'P' },
  ];
  for (const r of ranks) {
    ws.mergeCells(`${r.start}4:${r.end}4`);
    const cell = ws.getCell(`${r.start}4`);
    cell.value = r.label;
    cell.font = fonts.headerCell;
    cell.alignment = alignCenter;
    cell.fill = fills.lightGold;
    cell.border = borderHeader;
  }

  // ── R5: 성명/소속/기록 ──
  const subHeaders = ['B','E','H','K','N'].map(letter => letter);
  const subOffsets = [0, 1, 2]; // 성명, 소속, 기록
  for (const startLetter of subHeaders) {
    const colStart = ws.getColumn(startLetter).number;
    ws.getCell(5, colStart).value = '성명';
    ws.getCell(5, colStart + 1).value = '소속';
    ws.getCell(5, colStart + 2).value = '기록';
    for (let off = 0; off < 3; off++) {
      const c = ws.getCell(5, colStart + off);
      c.font = fonts.headerCell;
      c.alignment = alignCenter;
      c.fill = fills.gray;
      c.border = borderHeader;
    }
  }
  ws.getRow(4).height = 18;
  ws.getRow(5).height = 16;

  // ── R6+: 종목 데이터 ──
  let rowIdx = 6;
  for (const evt of divEvents) {
    const result = eventResults.get(evt.id);
    if (!result) continue;

    const rankings = result.rankings || [];
    const hasWind = result.hasWind;

    // 종목명 셀 (A열)
    const eventNameCell = ws.getCell(rowIdx, 1);
    eventNameCell.value = evt.name;
    eventNameCell.font = fonts.eventName;
    eventNameCell.alignment = alignCenter;
    eventNameCell.fill = fills.lightGold;
    eventNameCell.border = borderAll;

    // 1~5위 데이터
    for (let rank = 0; rank < 5; rank++) {
      const r = rankings[rank] || { name: '', team: '', record: '', wind: null };
      const colBase = 2 + rank * 3;  // B=2, E=5, H=8, K=11, N=14
      // 성명
      const cName = ws.getCell(rowIdx, colBase);
      cName.value = r.name;
      cName.font = fonts.data;
      cName.alignment = alignCenter;
      cName.border = borderAll;
      if (cName.value && cName.value.includes && cName.value.includes('\n')) {
        cName.alignment = { ...cName.alignment, wrapText: true };
      }
      // 소속
      const cTeam = ws.getCell(rowIdx, colBase + 1);
      cTeam.value = r.team;
      cTeam.font = fonts.data;
      cTeam.alignment = alignCenter;
      cTeam.border = borderAll;
      // 기록
      const cRec = ws.getCell(rowIdx, colBase + 2);
      cRec.value = r.record;
      cRec.font = ['DNS','DNF','DQ','NM'].includes(r.record) ? fonts.noteRecord : fonts.record;
      cRec.alignment = alignCenter;
      cRec.border = borderAll;
    }
    // 행 높이: 릴레이는 멤버 명단이 줄바꿈되므로 더 높게
    if (evt.category === 'relay') {
      ws.getRow(rowIdx).height = 38;
    } else {
      ws.getRow(rowIdx).height = 18;
    }
    rowIdx++;

    // ── 풍속 행 (트랙 단거리/멀리뛰기/세단뛰기) ──
    if (hasWind && rankings.some(r => r.wind)) {
      const windCell = ws.getCell(rowIdx, 1);
      windCell.value = '풍속';
      windCell.font = fonts.wind;
      windCell.alignment = alignCenter;
      windCell.fill = fills.gray;
      windCell.border = borderAll;

      for (let rank = 0; rank < 5; rank++) {
        const r = rankings[rank] || { wind: null };
        const colRec = 2 + rank * 3 + 2;
        const cW = ws.getCell(rowIdx, colRec);
        cW.value = r.wind || '';
        cW.font = fonts.wind;
        cW.alignment = alignCenter;
        cW.border = borderAll;
        // 성명/소속 칸은 비움 + 테두리만
        for (let off = 0; off < 2; off++) {
          const c = ws.getCell(rowIdx, 2 + rank * 3 + off);
          c.border = borderAll;
        }
      }
      ws.getRow(rowIdx).height = 14;
      rowIdx++;
    }
  }

  // ── 마지막 빈 줄 (시각적 여백) ──
  ws.getRow(rowIdx).height = 8;
}

// ────────────── 메인 진입점 ──────────────
async function generateComprehensiveByDivision(db, comp) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'PaceRise';
  wb.created = new Date();
  wb.properties.date1904 = false;

  // 1) 종목 전부 가져오기 (sub-event 제외)
  // round_type 필터를 완화 — 'final' 또는 NULL/빈 값. 'preliminary' 라운드만 있는 종목도
  // 결승이 없는 채로 종료되는 경우(예선=결승)가 있어 함께 포함하되, 같은 종목에
  // final 라운드가 따로 있으면 final 우선(중복 제거)한다.
  const rawEvents = await db.all(`
    SELECT * FROM event 
    WHERE competition_id=? AND parent_event_id IS NULL
    ORDER BY sort_order, id`, comp.id);

  // 같은 (name, gender, division) 키로 중복 라운드 제거 — final 우선, 없으면 NULL, 그 다음 다른 라운드
  const roundPriority = (rt) => {
    if (rt === 'final' || !rt) return 0;
    if (rt === 'semifinal') return 1;
    if (rt === 'preliminary') return 2;
    return 3;
  };
  const groupKey = (e) => `${e.name}__${e.gender||''}__${e.division||''}`;
  const bestByKey = new Map();
  for (const ev of rawEvents) {
    const k = groupKey(ev);
    const cur = bestByKey.get(k);
    if (!cur || roundPriority(ev.round_type) < roundPriority(cur.round_type)) {
      bestByKey.set(k, ev);
    }
  }
  const allEvents = [...bestByKey.values()].sort((a,b) => (a.sort_order||0) - (b.sort_order||0) || a.id - b.id);

  if (allEvents.length === 0) {
    // 빈 종합기록지라도 시트 1개는 만들어 표시
    const ws = wb.addWorksheet('종합기록지');
    ws.getCell('A1').value = `${comp.name} — 종목이 없습니다.`;
    return wb;
  }

  // 2) 부(division) 별로 그룹화
  // event.division 이 비어있거나 division_master에 없는 코드인 경우 →
  //  - 성별이 있으면 "미분류 (남자)" / "미분류 (여자)" / "미분류 (혼성)" 시트로 분리
  //  - 성별도 없으면 "미분류" 단일 시트
  // division_master.code 사전 로드 (등록된 부 코드 set)
  let divisionMaster;
  try {
    divisionMaster = await db.all('SELECT code, label_ko, sort_order FROM division_master');
  } catch(e) { divisionMaster = []; }
  const validDivisionCodes = new Set(divisionMaster.map(d => d.code));

  const uncatKeyFor = (ev) => {
    const g = (ev.gender || '').toUpperCase();
    if (g === 'M') return '_UNCAT_M';
    if (g === 'F') return '_UNCAT_F';
    if (g === 'X') return '_UNCAT_X';
    return '_UNCAT';
  };

  const groupByDiv = new Map();
  for (const ev of allEvents) {
    let divKey;
    if (ev.division && validDivisionCodes.has(ev.division)) {
      divKey = ev.division;
    } else if (ev.division) {
      // division 코드는 있는데 master에 없는 미등록 코드 → 그대로 키로 사용 (시트는 코드명 표시)
      divKey = ev.division;
    } else {
      // division 빈 값 → 성별 기반 미분류 그룹
      divKey = uncatKeyFor(ev);
    }
    if (!groupByDiv.has(divKey)) groupByDiv.set(divKey, []);
    groupByDiv.get(divKey).push(ev);
  }

  // 3) 부 라벨 조회 — division_master 는 위에서 이미 로드함
  const divLabelMap = new Map();
  const divSortMap = new Map();
  for (const dm of divisionMaster) {
    divLabelMap.set(dm.code, dm.label_ko);
    divSortMap.set(dm.code, dm.sort_order || 9999);
  }
  // 미분류 그룹 라벨/정렬 — 항상 맨 뒤에 위치
  divLabelMap.set('_UNCAT_M', '미분류 (남자)');
  divLabelMap.set('_UNCAT_F', '미분류 (여자)');
  divLabelMap.set('_UNCAT_X', '미분류 (혼성)');
  divLabelMap.set('_UNCAT',   '미분류');
  divSortMap.set('_UNCAT_M', 99001);
  divSortMap.set('_UNCAT_F', 99002);
  divSortMap.set('_UNCAT_X', 99003);
  divSortMap.set('_UNCAT',   99004);

  // 4) 부별 정렬 (sort_order 기준)
  const divKeys = [...groupByDiv.keys()].sort((a, b) => {
    const sa = divSortMap.get(a) ?? 9999;
    const sb = divSortMap.get(b) ?? 9999;
    if (sa !== sb) return sa - sb;
    return a.localeCompare(b);
  });

  // 5) 각 부의 종목 정렬 (트랙 단거리 → 중장거리 → 허들 → 도약 → 투척 → 혼성 → 릴레이)
  for (const divKey of divKeys) {
    const evs = groupByDiv.get(divKey);
    evs.sort((a, b) => {
      const ka = EVENT_SORT_KEY(a.name);
      const kb = EVENT_SORT_KEY(b.name);
      if (ka !== kb) return ka - kb;
      return (a.sort_order || 0) - (b.sort_order || 0);
    });
  }

  // 6) 모든 종목의 결과를 미리 조회 (병렬)
  const allEventIds = allEvents.map(e => e.id);
  const eventResults = new Map();
  for (const ev of allEvents) {
    try {
      const r = await getTopResultsForEvent(db, ev);
      eventResults.set(ev.id, r);
    } catch (e) {
      console.error(`[CompByDiv] 결과 조회 실패 (event_id=${ev.id}, name=${ev.name}):`, e.message);
      eventResults.set(ev.id, { rankings: [], category: 'unknown', hasWind: false });
    }
  }

  // 7) 부별 시트 생성
  for (const divKey of divKeys) {
    const divLabel = divLabelMap.get(divKey) || divKey;
    const divEvents = groupByDiv.get(divKey);
    createDivisionSheet(wb, comp, divLabel, divEvents, eventResults);
  }

  return wb;
}

module.exports = { generateComprehensiveByDivision };
