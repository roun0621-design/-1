/**
 * Full Record Excel Generator — ExcelJS Version v2
 * Professional formatting: auto-width, logos, print setup, improved layout
 */
const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');

// ---- Style Presets ----
const GOLD = 'FFB79F58';
const DARK = 'FF262324';
const GRAY_BG = 'FFE8E8E8';
const LIGHT_GOLD_BG = 'FFF8F3E8';
const WHITE = 'FFFFFFFF';

const THIN_BORDER = { style: 'thin', color: { argb: '999999' } };
const MED_BORDER = { style: 'medium', color: { argb: '333333' } };
const THICK_BORDER = { style: 'medium', color: { argb: DARK } };

const borders = {
  all: { top: THIN_BORDER, bottom: THIN_BORDER, left: THIN_BORDER, right: THIN_BORDER },
  header: { top: MED_BORDER, bottom: MED_BORDER, left: THIN_BORDER, right: THIN_BORDER },
  outer: { top: THICK_BORDER, bottom: THICK_BORDER, left: THICK_BORDER, right: THICK_BORDER },
  bottom: { bottom: MED_BORDER, left: THIN_BORDER, right: THIN_BORDER },
  top: { top: MED_BORDER, left: THIN_BORDER, right: THIN_BORDER },
};

const fonts = {
  title: { name: '맑은 고딕', size: 14, bold: true, color: { argb: DARK } },
  subtitle: { name: '맑은 고딕', size: 10, bold: true, color: { argb: DARK } },
  header: { name: '맑은 고딕', size: 8, bold: true, color: { argb: WHITE } },
  headerAlt: { name: '맑은 고딕', size: 9, bold: true, color: { argb: DARK } },
  normal: { name: '맑은 고딕', size: 9 },
  small: { name: '맑은 고딕', size: 8 },
  smallBold: { name: '맑은 고딕', size: 8, bold: true },
  tiny: { name: '맑은 고딕', size: 7 },
  tinyBold: { name: '맑은 고딕', size: 7, bold: true },
  relayName: { name: '맑은 고딕', size: 6.8 },
  event: { name: '맑은 고딕', size: 11, bold: true, color: { argb: DARK } },
  round: { name: '맑은 고딕', size: 10, bold: true },
  record: { name: '맑은 고딕', size: 9, bold: true, color: { argb: 'FF2D5016' } },
  recordSm: { name: '맑은 고딕', size: 8, bold: true, color: { argb: 'FF2D5016' } },
};

const fills = {
  headerDark: { type: 'pattern', pattern: 'solid', fgColor: { argb: DARK } },
  headerGold: { type: 'pattern', pattern: 'solid', fgColor: { argb: GOLD } },
  gray: { type: 'pattern', pattern: 'solid', fgColor: { argb: GRAY_BG } },
  lightGold: { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHT_GOLD_BG } },
  white: { type: 'pattern', pattern: 'solid', fgColor: { argb: WHITE } },
  titleBg: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF9C4' } },
};

const alignC = { horizontal: 'center', vertical: 'middle', wrapText: true };
const alignL = { horizontal: 'left', vertical: 'middle', wrapText: true };
const alignR = { horizontal: 'right', vertical: 'middle', wrapText: true };

// ---- Format helpers ----
function fmtTime(seconds) {
  if (seconds == null) return '';
  if (seconds >= 3600) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds - h * 3600) / 60);
    const r = seconds - h * 3600 - m * 60;
    return `${h}:${m < 10 ? '0' : ''}${m}:${r < 10 ? '0' : ''}${r.toFixed(2)}`;
  }
  if (seconds >= 60) {
    const m = Math.floor(seconds / 60);
    const r = seconds - m * 60;
    return `${m}:${r < 10 ? '0' : ''}${r.toFixed(2)}`;
  }
  return seconds.toFixed(2);
}
function fmtDist(meters) {
  if (meters == null || meters <= 0) return '';
  const m = Math.floor(meters);
  const cm = Math.round((meters - m) * 100);
  return `${m}m${cm < 10 ? '0' : ''}${cm}`;
}
function fmtHeight(meters) {
  if (meters == null) return '';
  const m = Math.floor(meters);
  const cm = Math.round((meters - m) * 100);
  return m + 'm' + String(cm).padStart(2, '0');
}
function fmtWind(w) {
  if (w == null) return '';
  const v = parseFloat(w);
  if (isNaN(v)) return '';
  return (v >= 0 ? '+' : '') + v.toFixed(1);
}

/** Measure approximate Korean/ASCII char width (Korean ≈ 2 chars) */
function measureText(str) {
  if (!str) return 0;
  let w = 0;
  for (const ch of String(str)) {
    w += ch.charCodeAt(0) > 0x7F ? 2 : 1;
  }
  return w;
}

// ---- Helper: set cell value and style ----
function setCell(ws, row, col, value, style = {}) {
  const cell = ws.getCell(row, col);
  cell.value = value;
  if (style.font) cell.font = style.font;
  if (style.fill) cell.fill = style.fill;
  if (style.alignment) cell.alignment = style.alignment;
  if (style.border) cell.border = style.border;
  if (style.numFmt) cell.numFmt = style.numFmt;
  return cell;
}

// ---- Helper: merge and set value ----
function mergeSet(ws, r1, c1, r2, c2, value, style = {}) {
  ws.mergeCells(r1, c1, r2, c2);
  setCell(ws, r1, c1, value, style);
}

// ---- Helper: apply border to range ----
function applyBorders(ws, r1, c1, r2, c2, border) {
  for (let r = r1; r <= r2; r++) {
    for (let c = c1; c <= c2; c++) {
      const cell = ws.getCell(r, c);
      cell.border = border || borders.all;
    }
  }
}

// ---- Helper: add logo to sheet ----
async function addLogo(ws, wb, compId, position, row, col, width, height) {
  const logoDir = path.join(__dirname, '..', 'public', 'uploads', 'logos');
  const extensions = ['.png', '.jpg', '.jpeg', '.gif'];
  for (const ext of extensions) {
    const logoPath = path.join(logoDir, `logo_${position}_${compId}${ext}`);
    if (fs.existsSync(logoPath)) {
      const imageId = wb.addImage({ filename: logoPath, extension: ext.replace('.', '') });
      ws.addImage(imageId, {
        tl: { col: col - 1, row: row - 1 },
        ext: { width: width || 100, height: height || 50 }
      });
      return true;
    }
  }
  return false;
}

// ---- Build record comparison table ----
function buildRecordTable(ws, startRow, recData, recorder, chiefJudge, totalCols) {
  const maxCol = totalCols || 6;
  // 기록비교표는 최소 5개 열이 필요하므로 maxCol이 작으면 확장
  const recMaxCol = Math.max(maxCol, 5);
  let r = startRow;
  r++; // blank

  mergeSet(ws, r, 1, r, recMaxCol, '기 록 비 교 표', { font: fonts.subtitle, alignment: alignC });
  applyBorders(ws, r, 1, r, recMaxCol, borders.bottom);
  r++;
  r++; // blank

  // 기록비교표 열 배분: 시트 전체 컬럼 수에 따라 병합 범위를 동적으로 결정
  let recCols;
  if (recMaxCol >= 12) {
    recCols = { label: [1,2], record: [3,4], name: [5,7], team: [8,9], year: [10, recMaxCol] };
  } else if (recMaxCol >= 6) {
    recCols = { label: [1,2], record: [3,3], name: [4,4], team: [5,5], year: [6, recMaxCol] };
  } else {
    // 4~5열 시트: 각 항목 1열씩
    recCols = { label: [1,1], record: [2,2], name: [3,3], team: [4,4], year: [5, recMaxCol] };
  }

  // Header
  const headers = [
    { text: '구 분', cols: recCols.label },
    { text: '기  록', cols: recCols.record },
    { text: '성  명', cols: recCols.name },
    { text: '소 속', cols: recCols.team },
    { text: '기록수립년도', cols: recCols.year },
  ];
  for (const h of headers) {
    mergeSet(ws, r, h.cols[0], r, h.cols[1], h.text, { font: fonts.headerAlt, fill: fills.gray, alignment: alignC, border: borders.all });
  }
  // Fill any gaps with borders
  for (let c = 1; c <= recMaxCol; c++) {
    const cell = ws.getCell(r, c);
    if (!cell.border) cell.border = borders.all;
  }
  ws.getRow(r).height = 28;
  r++;

  // Records
  const recTypes = [
    { key: 'national', label: '한국기록(NR)' },
    { key: 'division', label: '부별기록(DR)' },
    { key: 'competition', label: '대회기록(CR)' },
  ];
  for (const rt of recTypes) {
    const rec = recData?.[rt.key] || {};
    mergeSet(ws, r, recCols.label[0], r, recCols.label[1], rt.label, { font: fonts.smallBold, alignment: alignC, border: borders.all });
    mergeSet(ws, r, recCols.record[0], r, recCols.record[1], rec.record_value || '', { font: fonts.record, alignment: alignC, border: borders.all });
    mergeSet(ws, r, recCols.name[0], r, recCols.name[1], rec.holder_name || '', { font: fonts.small, alignment: alignC, border: borders.all });
    mergeSet(ws, r, recCols.team[0], r, recCols.team[1], rec.holder_team || '', { font: fonts.small, alignment: alignC, border: borders.all });
    mergeSet(ws, r, recCols.year[0], r, recCols.year[1], rec.record_year || '', { font: fonts.small, alignment: alignC, border: borders.all });
    for (let c = 1; c <= recMaxCol; c++) {
      const cell = ws.getCell(r, c);
      if (!cell.border) cell.border = borders.all;
    }
    ws.getRow(r).height = 28;
    r++;
  }
  r++; // blank
  return r + 1;
}

// ============================================================
// MAIN GENERATOR
// ============================================================
async function generateFullRecordExcel(db, comp, gender, getDocTemplate) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'PACE RISE';
  wb.created = new Date();

  const genderLabel = gender === 'M' ? '남자' : '여자';

  // ---- Event definitions ----
  const MEN_SHEET_ORDER = [
    '100m','200m','400m','800m','1500m','5000m','10000m',
    '110mH','400mH','3000mSC','10000mW',
    '높이뛰기','장대높이뛰기','멀리뛰기','세단뛰기',
    '포환던지기','원반던지기','해머던지기','창던지기',
    '10종경기','4x100mR','4x400mR','4x400mR(Mixed)','4x800mR','4x1500mR'
  ];
  const WOMEN_SHEET_ORDER = [
    '100m','200m','400m','800m','1500m','5000m','10000m',
    '100mH','400mH','3000mSC','10000mW',
    '높이뛰기','장대높이뛰기','멀리뛰기','세단뛰기',
    '포환던지기','원반던지기','해머던지기','창던지기',
    '7종경기','4x100mR','4x400mR','4x400mR(Mixed)','4x800mR','4x1500mR'
  ];
  const SHEET_ORDER = gender === 'F' ? WOMEN_SHEET_ORDER : MEN_SHEET_ORDER;
  const WIND_EVENTS = new Set(['100m','200m','110mH','100mH']);
  const HEIGHT_EVENTS = new Set(['높이뛰기','장대높이뛰기']);
  const THROW_EVENTS = new Set(['포환던지기','원반던지기','해머던지기','창던지기']);
  const JUMP_EVENTS = new Set(['멀리뛰기','세단뛰기']);
  const RELAY_EVENTS = new Set(['4x100mR','4x400mR','4x400mR(Mixed)','4x800mR','4x1500mR']);
  const COMBINED_EVENTS = new Set(['10종경기','7종경기']);

  // ---- Event name normalization ----
  function normalizeEventName(name) {
    let n = name.replace(/\s+/g, '').replace(/,/g, '');
    n = n.replace(/(\d)[×Xx](\d)/g, '$1x$2');
    const map = {
      '110m허들': '110mH', '110mHurdles': '110mH', '100m허들': '100mH', '100mHurdles': '100mH',
      '400m허들': '400mH', '400mHurdles': '400mH', '3000m장애물': '3000mSC',
      '10000m경보': '10000mW', '십종경기': '10종경기', '칠종경기': '7종경기',
      '4x100m릴레이': '4x100mR', '4x400m릴레이': '4x400mR', '4x1500m릴레이': '4x1500mR',
      'MIXED4x400mR': '4x400mR(Mixed)', '혼성4x400mR': '4x400mR(Mixed)',
      '4x400mR(Mixed)': '4x400mR(Mixed)', '4x400mR(mixed)': '4x400mR(Mixed)',
      'MIXED 4x400mR': '4x400mR(Mixed)',
      '4x800mR': '4x800mR', '4x800m릴레이': '4x800mR'
    };
    return map[n] || n;
  }

  // ---- Load event records (from both tables for maximum compatibility) ----
  const eventRecords = {};
  try {
    const recRows = db.prepare('SELECT * FROM event_record WHERE gender=?').all(gender);
    for (const r of recRows) {
      if (!eventRecords[r.event_name]) eventRecords[r.event_name] = {};
      eventRecords[r.event_name][r.record_type] = r;
    }
  } catch(e) { /* event_record table might not exist */ }

  // ---- Get events ----
  const allEvents = db.prepare(`
    SELECT e.* FROM event e WHERE e.competition_id=? AND e.gender IN (?, 'X')
    ORDER BY e.sort_order, e.id
  `).all(comp.id, gender);

  const eventsByName = {};
  for (const evt of allEvents) {
    const norm = normalizeEventName(evt.name);
    if (!eventsByName[norm]) eventsByName[norm] = [];
    eventsByName[norm].push(evt);
  }

  // Compute event date from timetable schedule
  function getEventDate(evtId) {
    try {
      const tt = db.prepare('SELECT day FROM timetable WHERE event_id=? LIMIT 1').get(evtId);
      if (tt && tt.day && comp.start_date) {
        const base = new Date(comp.start_date);
        base.setDate(base.getDate() + tt.day - 1);
        return `${base.getFullYear()}-${base.getMonth()+1}-${base.getDate()}`;
      }
    } catch(e) {}
    return comp.start_date || '';
  }

  const compInfo = {
    title: comp.name || '',
    date: comp.start_date && comp.end_date ? `${comp.start_date} ~ ${comp.end_date}` : comp.start_date || '',
    venue: comp.venue || ''
  };
  const tpl = getDocTemplate(comp.id);
  // 심판장: comprehensive.chief_judge (우선) → result_sheet.chief_judge → result_sheet.chief_recorder_name (폴백)
  const chiefJudge = tpl?.comprehensive?.chief_judge || tpl?.result_sheet?.chief_judge || tpl?.result_sheet?.chief_recorder_name || '';
  const recorder = tpl?.result_sheet?.recorder_name || '';

  // Also try to load per-event records from event_records table for fallback
  function getEventRecordsForEvent(eventId) {
    try {
      const row = db.prepare('SELECT records FROM event_records WHERE event_id=?').get(eventId);
      if (row && row.records) return JSON.parse(row.records);
    } catch(e) {}
    return null;
  }

  // ---- getEventRankings (same logic) ----
  function getEventRankings(evt) {
    const isCombined = evt.category === 'combined';
    const isFieldHeight = evt.category === 'field_height';
    const isFieldDist = evt.category === 'field_distance';
    const isRelay = evt.category === 'relay';
    const heats = db.prepare('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number').all(evt.id);
    if (heats.length === 0) return [];

    if (isCombined) {
      const heat = heats[0];
      const entries = db.prepare(`SELECT he.lane_number, ee.id AS event_entry_id, ee.status, ee.athlete_id,
        a.name, a.bib_number, a.team FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id
        JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=?`).all(heat.id);
      return entries.map(e => {
        const scores = db.prepare('SELECT * FROM combined_score WHERE event_entry_id=? ORDER BY sub_event_order').all(e.event_entry_id);
        let totalPoints = scores.reduce((s, sc) => s + (sc.wa_points || 0), 0);
        const status = db.prepare("SELECT status_code FROM result WHERE heat_id=? AND event_entry_id=? AND status_code IN ('DNF','DNS','DQ') LIMIT 1").get(heat.id, e.event_entry_id);
        let sc = status?.status_code || '';
        if (!sc && e.status === 'no_show') sc = 'DNS';
        // 0 points with no explicit status → DNF
        if (!sc && totalPoints === 0) sc = 'DNF';
        return { ...e, record: sc || String(totalPoints), status_code: sc, sort_val: sc ? 99999 : -totalPoints };
      }).sort((a, b) => {
        const aS = ['DNS','DNF','DQ'].includes(a.status_code);
        const bS = ['DNS','DNF','DQ'].includes(b.status_code);
        if (aS && !bS) return 1; if (!aS && bS) return -1;
        if (aS && bS) { const order = {DNF:1,DQ:2,DNS:3}; return (order[a.status_code]||9) - (order[b.status_code]||9); }
        return parseInt(b.record) > parseInt(a.record) ? 1 : -1;
      });
    } else if (isFieldHeight) {
      const heat = heats[0];
      const entries = db.prepare(`SELECT he.lane_number, ee.id AS event_entry_id, ee.status,
        a.name, a.bib_number, a.team FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id
        JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=?`).all(heat.id);
      const allAttempts = db.prepare('SELECT * FROM height_attempt WHERE heat_id=? ORDER BY bar_height, event_entry_id, attempt_number').all(heat.id);
      return entries.map(e => {
        const myAttempts = allAttempts.filter(a => a.event_entry_id === e.event_entry_id);
        let bestCleared = null, totalMisses = 0, missesAtBest = 0;
        const heights = [...new Set(myAttempts.map(a => a.bar_height))].sort((a,b) => a-b);
        for (const h of heights) {
          const attH = myAttempts.filter(a => a.bar_height === h);
          const misses = attH.filter(a => a.result_mark === 'X').length;
          totalMisses += misses;
          if (attH.some(a => a.result_mark === 'O')) { bestCleared = h; missesAtBest = misses; }
        }
        const results = db.prepare('SELECT * FROM result WHERE heat_id=? AND event_entry_id=?').all(heat.id, e.event_entry_id);
        let sc = results.find(r => r.status_code && ['DNS','DNF','DQ','NM'].includes(r.status_code))?.status_code || '';
        if (!sc && e.status === 'no_show') sc = 'DNS';
        if (bestCleared === null && !sc) { const bestR = results.find(r => r.distance_meters != null); if (bestR) bestCleared = bestR.distance_meters; }
        if (!sc && bestCleared === null) sc = 'NM';
        return { ...e, bestCleared, totalMisses, missesAtBest, status_code: sc, record: sc || fmtHeight(bestCleared), attempts: myAttempts, heights };
      }).sort((a, b) => {
        const aS = ['DNS','DNF','DQ','NM'].includes(a.status_code);
        const bS = ['DNS','DNF','DQ','NM'].includes(b.status_code);
        if (aS && !bS) return 1; if (!aS && bS) return -1;
        if (aS && bS) { const order = {DNF:1,DQ:2,NM:3,DNS:4}; return (order[a.status_code]||9) - (order[b.status_code]||9); }
        if (a.bestCleared == null && b.bestCleared == null) return 0;
        if (a.bestCleared == null) return 1; if (b.bestCleared == null) return -1;
        if (b.bestCleared !== a.bestCleared) return b.bestCleared - a.bestCleared;
        if (a.missesAtBest !== b.missesAtBest) return a.missesAtBest - b.missesAtBest;
        return a.totalMisses - b.totalMisses;
      });
    } else if (isFieldDist) {
      const allEntries = [];
      for (const heat of heats) {
        const entries = db.prepare(`SELECT he.lane_number, ee.id AS event_entry_id, ee.status,
          a.name, a.bib_number, a.team FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id
          JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=?`).all(heat.id);
        const results = db.prepare('SELECT * FROM result WHERE heat_id=? ORDER BY event_entry_id, attempt_number').all(heat.id);
        const resMap = {};
        for (const r of results) { if (!resMap[r.event_entry_id]) resMap[r.event_entry_id] = []; resMap[r.event_entry_id].push(r); }
        for (const e of entries) {
          const recs = resMap[e.event_entry_id] || [];
          let best = null, bestWind = null;
          const attempts = [];
          for (const r of recs) {
            attempts.push(r);
            if (r.distance_meters != null && r.distance_meters > 0 && r.status_code !== 'X' && r.status_code !== 'FOUL') {
              if (best === null || r.distance_meters > best) { best = r.distance_meters; bestWind = r.wind; }
            }
          }
          let sc = recs.find(r => r.status_code && ['DNS','DNF','NM','DQ'].includes(r.status_code))?.status_code || '';
          if (!sc && e.status === 'no_show') sc = 'DNS';
          if (!sc && best === null) sc = 'NM';
          allEntries.push({ ...e, best, bestWind, status_code: sc, record: sc || fmtDist(best), attempts });
        }
      }
      return allEntries.sort((a, b) => {
        const aS = ['DNS','DNF','DQ','NM'].includes(a.status_code);
        const bS = ['DNS','DNF','DQ','NM'].includes(b.status_code);
        if (aS && !bS) return 1; if (!aS && bS) return -1;
        if (aS && bS) { const order = {DNF:1,DQ:2,NM:3,DNS:4}; return (order[a.status_code]||9) - (order[b.status_code]||9); }
        if (a.best == null && b.best == null) return 0;
        if (a.best == null) return 1; if (b.best == null) return -1;
        return b.best - a.best;
      });
    } else {
      // Track / Road / Relay
      const allEntries = [];
      for (const heat of heats) {
        const entries = db.prepare(`SELECT he.lane_number, ee.id AS event_entry_id, ee.status, ee.athlete_id,
          a.name, a.bib_number, a.team FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id
          JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=?`).all(heat.id);
        const results = db.prepare('SELECT * FROM result WHERE heat_id=? ORDER BY event_entry_id, attempt_number').all(heat.id);
        const resMap = {};
        for (const r of results) { if (!resMap[r.event_entry_id]) resMap[r.event_entry_id] = []; resMap[r.event_entry_id].push(r); }
        for (const e of entries) {
          const recs = resMap[e.event_entry_id] || [];
          const r = recs.find(r => r.time_seconds != null);
          const best = r ? r.time_seconds : null;
          const bestWind = (r && r.wind != null) ? r.wind : (heat.wind != null ? heat.wind : null);
          let sc = recs.find(r => r.status_code && ['DNS','DNF','NM','DQ'].includes(r.status_code))?.status_code || '';
          if (!sc && e.status === 'no_show') sc = 'DNS';
          const entry = { ...e, best, bestWind, heat_wind: heat.wind, status_code: sc, record: sc || fmtTime(best) };
          if (isRelay) {
            entry.members = db.prepare(`SELECT a.name FROM relay_member rm JOIN athlete a ON a.id=rm.athlete_id
              WHERE rm.event_entry_id=? ORDER BY rm.leg_order, CAST(a.bib_number AS INTEGER)`).all(e.event_entry_id).map(m => m.name);
          }
          allEntries.push(entry);
        }
      }
      return allEntries.sort((a, b) => {
        const aS = ['DNS','DNF','NM','DQ'].includes(a.status_code);
        const bS = ['DNS','DNF','NM','DQ'].includes(b.status_code);
        if (aS && !bS) return 1; if (!aS && bS) return -1;
        if (aS && bS) { const order = {DNF:1,DQ:2,DNS:3}; return (order[a.status_code]||9) - (order[b.status_code]||9); }
        if (a.best == null && b.best == null) return 0;
        if (a.best == null) return 1; if (b.best == null) return -1;
        return a.best - b.best;
      });
    }
  }

  // ---- Helper: build standard sheet header with logos ----
  function buildSheetHeader(ws, evtName, roundLabel, compInfo, genderLabel, compId, totalCols, eventDate) {
    const maxCol = totalCols || 6;
    // Row 1: Title banner
    ws.getRow(1).height = 42;
    mergeSet(ws, 1, 1, 1, maxCol, compInfo.title, { font: fonts.title, fill: fills.titleBg, alignment: alignC, border: borders.all });

    // Row 2: Division + Date + Judge
    ws.getRow(2).height = 24;
    const dateStr = eventDate || compInfo.date;
    const divLabel = `${evtName.includes('Mixed') || evtName.includes('MIXED') ? '혼성' : genderLabel}부`;
    if (maxCol <= 5) {
      // For small column sheets, put everything in one or two merged areas
      const mid = Math.ceil(maxCol / 2);
      mergeSet(ws, 2, 1, 2, mid, divLabel, { font: fonts.subtitle, alignment: alignC, border: borders.all });
      mergeSet(ws, 2, mid + 1, 2, maxCol, `${dateStr}  |  ${compInfo.venue}`, { font: fonts.small, alignment: alignC, border: borders.all });
    } else {
      const col2mid = Math.floor(maxCol * 0.4);
      const col2end = Math.floor(maxCol * 0.7);
      mergeSet(ws, 2, 1, 2, Math.max(2, col2mid), divLabel, { font: fonts.subtitle, alignment: alignC, border: borders.all });
      mergeSet(ws, 2, col2mid + 1, 2, col2end, `${dateStr}  |  ${compInfo.venue}`, { font: fonts.small, alignment: alignC, border: borders.all });
      mergeSet(ws, 2, col2end + 1, 2, maxCol, chiefJudge ? `심판장: ${chiefJudge}` : '', { font: fonts.small, alignment: alignC, border: borders.all });
    }

    // Row 3: Event name + Round
    const col3mid = Math.ceil(maxCol / 2);
    mergeSet(ws, 3, 1, 3, col3mid, `종목: ${evtName}`, { font: fonts.event, alignment: alignC, border: borders.all });
    mergeSet(ws, 3, col3mid + 1, 3, maxCol, roundLabel || '결   승', { font: fonts.round, alignment: alignC, border: borders.all });
    ws.getRow(3).height = 25;

    // 종목별 기록지에는 로고 미노출

    return 4; // next available row
  }

  // ===== SHEET 1: 종합기록 =====
  {
    const ws = wb.addWorksheet('종합기록', { properties: { defaultColWidth: 8 } });
    ws.pageSetup = {
      paperSize: 9, orientation: 'landscape',
      fitToPage: false,
      scale: 100,
      margins: { left: 0.2, right: 0.2, top: 0.3, bottom: 0.3, header: 0.15, footer: 0.15 }
    };

    // ---- Improved column layout ----
    // Structure per rank: [name+bib, team, record] = 3 cols per rank
    // Total: 1(empty) + 1(종목) + 8*3(ranks) = 26 cols (비고 열 제거)
    const colWidths = [
      2.5,  // A: row spacer
      10,   // B: 종목
      // 1위~8위: each = [이름, 소속, 기록]
      9.14, 10, 8,   // 1위
      9.14, 10, 8,   // 2위
      9.14, 10, 8,   // 3위
      9.14, 10, 8,   // 4위
      9.14, 10, 8,   // 5위
      9.14, 10, 8,   // 6위
      9.14, 10, 8,   // 7위
      9.14, 10, 8,   // 8위
    ];
    colWidths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

    // Row 1: Logo left + Title + Logo right (3-row header block)
    ws.getRow(1).height = 42;
    // Left logo area (cols 1-2)
    mergeSet(ws, 1, 1, 1, 2, '', { fill: fills.titleBg, border: borders.all });
    // Title (center area)
    mergeSet(ws, 1, 3, 1, 23, compInfo.title, {
      font: { name: '맑은 고딕', size: 16, bold: true, color: { argb: DARK } },
      fill: fills.titleBg, alignment: alignC, border: borders.all
    });
    // Right logo area
    mergeSet(ws, 1, 24, 1, 26, '', { fill: fills.titleBg, border: borders.all });

    // Logos in title row
    addLogo(ws, wb, comp.id, 'left', 1, 1, 110, 38);
    addLogo(ws, wb, comp.id, 'right', 1, 24, 110, 38);

    // Row 2: Gender + Date/Venue + Chief Judge
    ws.getRow(2).height = 20;
    mergeSet(ws, 2, 1, 2, 5, `${genderLabel}부 (${gender === 'M' ? "MEN'S" : "WOMEN'S"})`, {
      font: fonts.subtitle, alignment: alignL, border: borders.all
    });
    mergeSet(ws, 2, 6, 2, 19, `${compInfo.date}  |  ${compInfo.venue}`, { font: fonts.small, alignment: alignC, border: borders.all });
    mergeSet(ws, 2, 20, 2, 26, chiefJudge ? `심판장: ${chiefJudge}` : '', {
      font: fonts.small, alignment: alignC, border: borders.all
    });

    // Row 3: blank spacer
    ws.getRow(3).height = 4;
    let row = 4;

    // Row 4: Column headers
    // New layout: each rank = [이름, 소속, 기록]
    setCell(ws, row, 1, '', { font: fonts.header, fill: fills.headerDark, alignment: alignC, border: borders.header });
    setCell(ws, row, 2, '종목', { font: fonts.header, fill: fills.headerDark, alignment: alignC, border: borders.header });
    for (let i = 1; i <= 8; i++) {
      const baseCol = 3 + (i - 1) * 3;
      setCell(ws, row, baseCol, '성명', { font: fonts.header, fill: fills.headerDark, alignment: alignC, border: borders.header });
      setCell(ws, row, baseCol + 1, `${i}위`, { font: { ...fonts.header, color: { argb: 'FFFFD700' } }, fill: fills.headerDark, alignment: alignC, border: borders.header });
      setCell(ws, row, baseCol + 2, '기록', { font: fonts.header, fill: fills.headerDark, alignment: alignC, border: borders.header });
    }
    ws.getRow(row).height = 18;
    row++;

    // Data rows
    for (const evtName of SHEET_ORDER) {
      const evts = eventsByName[evtName];
      if (!evts) continue;
      const finalEvt = evts.find(e => e.round_type === 'final');
      if (!finalEvt) continue;
      const rankings = getEventRankings(finalEvt);
      const hasWind = WIND_EVENTS.has(evtName);
      const isRelay = RELAY_EVENTS.has(evtName);
      const isJumpEvt = JUMP_EVENTS.has(evtName);
      // 종합기록지 요약: 유효한 기록이 있는 선수만 표시 (DNS/DNF/DQ/NM 제외)
      const filtered = rankings.filter(r => !['DNS','DNF','DQ','NM'].includes(r.status_code));

      const needsSecondRow = hasWind || isRelay || isJumpEvt;

      // Row: Names + records
      setCell(ws, row, 1, '', { border: borders.all });
      setCell(ws, row, 2, evtName, { font: fonts.smallBold, alignment: alignC, border: borders.all, fill: fills.lightGold });
      for (let i = 0; i < 8; i++) {
        const r = filtered[i];
        const baseCol = 3 + i * 3;
        if (r) {
          let name = r.name || '';
          if (isRelay && r.members && r.members.length > 0) {
            const m = r.members;
            const lines = [];
            for (let j = 0; j < m.length; j += 2) lines.push(m.slice(j, j + 2).join(' '));
            name = lines.join('\n');
          }
          const nameFont = isRelay ? fonts.relayName : fonts.small;
          setCell(ws, row, baseCol, name, { font: nameFont, alignment: { horizontal: 'center', vertical: 'middle', wrapText: true }, border: borders.all });
          setCell(ws, row, baseCol + 1, r.team || '', { font: fonts.tiny, alignment: { horizontal: 'center', vertical: 'middle', wrapText: true }, border: borders.all });
          // DNF/DQ/DNS → 기록란 공백
          const isDnfDqDns = ['DNF','DQ','DNS'].includes(r.status_code);
          const isNM = r.status_code === 'NM';
          const recDisplay = isDnfDqDns ? '' : (r.record || '');
          setCell(ws, row, baseCol + 2, recDisplay, { font: fonts.recordSm, alignment: alignC, border: borders.all });
        } else {
          setCell(ws, row, baseCol, '', { border: borders.all });
          setCell(ws, row, baseCol + 1, '', { border: borders.all });
          setCell(ws, row, baseCol + 2, '', { border: borders.all });
        }
      }

      ws.getRow(row).height = needsSecondRow ? 13.5 : 27;
      const dataRow = row;
      row++;

      // Wind row OR relay info row (second row — vertically merge event column cells)
      if (needsSecondRow) {
        setCell(ws, row, 1, '', { border: borders.all });
        setCell(ws, row, 2, '', { border: borders.all });
        for (let i = 0; i < 8; i++) {
          const r = filtered[i];
          const baseCol = 3 + i * 3;
          if (hasWind || isJumpEvt) {
            setCell(ws, row, baseCol, '', { border: borders.all });
            setCell(ws, row, baseCol + 1, '', { border: borders.all });
            setCell(ws, row, baseCol + 2, r ? fmtWind(r.bestWind) : '', {
              font: { ...fonts.tiny, color: { argb: 'FF888888' } }, alignment: alignC, border: borders.all
            });
          } else {
            // Relay: second row is empty (members already shown in first row's name col)
            setCell(ws, row, baseCol, '', { border: borders.all });
            setCell(ws, row, baseCol + 1, '', { border: borders.all });
            setCell(ws, row, baseCol + 2, '', { border: borders.all });
          }
        }
        ws.getRow(row).height = (hasWind || isJumpEvt) ? 13.5 : 14;

        // Vertical merge: name+team+record cells for each rank across 2 rows
        for (let i = 0; i < 8; i++) {
          const baseCol = 3 + i * 3;
          try { ws.mergeCells(dataRow, baseCol, row, baseCol); } catch(e) {} // name
          try { ws.mergeCells(dataRow, baseCol + 1, row, baseCol + 1); } catch(e) {} // team
          if (!hasWind && !isJumpEvt) {
            try { ws.mergeCells(dataRow, baseCol + 2, row, baseCol + 2); } catch(e) {} // record (merge for relay only)
          }
        }
        // Also merge A and B cols vertically
        try { ws.mergeCells(dataRow, 1, row, 1); } catch(e) {}
        try { ws.mergeCells(dataRow, 2, row, 2); } catch(e) {}

        row++;
      }
    }
  }

  // ===== SHEET 2: 신기록 (Phase C) =====
  // 이 대회에서 인정된(approved) NR/DR/CR 모음
  // record_breaking_log에서 status='approved'인 행을 가져옴
  // 행이 0건이면 시트 자체를 생성하지 않음 (시각 노이즈 감소)
  try {
    const recordBreaks = db.prepare(`
      SELECT rbl.*,
             dm.label_ko AS division_label,
             cs.name AS series_name
      FROM record_breaking_log rbl
      LEFT JOIN division_master dm ON dm.code = rbl.division_code
      LEFT JOIN competition_series cs ON cs.id = rbl.series_id
      WHERE rbl.competition_id=? AND rbl.status='approved' AND rbl.gender IN (?, 'X')
      ORDER BY rbl.reviewed_at DESC, rbl.id DESC
    `).all(comp.id, gender);

    if (recordBreaks && recordBreaks.length > 0) {
      const wsR = wb.addWorksheet('신기록', { properties: { defaultColWidth: 12 } });
      wsR.pageSetup = {
        paperSize: 9, orientation: 'landscape',
        fitToPage: true, fitToWidth: 1, fitToHeight: 0,
        margins: { left: 0.4, right: 0.4, top: 0.4, bottom: 0.4, header: 0.15, footer: 0.15 }
      };

      // 컬럼 폭
      const colsR = [4, 8, 14, 6, 14, 12, 14, 14, 8, 14, 18];
      colsR.forEach((w, i) => { wsR.getColumn(i + 1).width = w; });

      // 제목 (B2:K2 merge)
      mergeSet(wsR, 2, 2, 2, 11, `🏆 ${compInfo.title} — ${genderLabel} 신기록 갱신 모음`, {
        font: { name: '맑은 고딕', size: 16, bold: true, color: { argb: 'FF8B0000' } },
        alignment: { horizontal: 'center', vertical: 'middle' },
        fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF8E1' } }
      });
      wsR.getRow(2).height = 28;

      // 부제목
      mergeSet(wsR, 3, 2, 3, 11,
        `※ NR=한국기록 · DR=부별기록 · CR=대회기록 · 풍속 +2.0m/s 초과 = 참고기록(불인정)`, {
        font: { name: '맑은 고딕', size: 9, italic: true, color: { argb: 'FF666666' } },
        alignment: { horizontal: 'center', vertical: 'middle' }
      });

      // 헤더 (row 5)
      const headerRow = 5;
      const headers = ['No.', '구분', '종목', '성별', '부/시리즈', '이전기록', '신기록', '선수명', '소속', '풍속', '갱신일'];
      const headerStyle = {
        font: { name: '맑은 고딕', size: 11, bold: true, color: { argb: 'FFFFFFFF' } },
        alignment: { horizontal: 'center', vertical: 'middle', wrapText: true },
        fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2C3E50' } },
        border: {
          top: { style: 'thin', color: { argb: 'FF333333' } },
          left: { style: 'thin', color: { argb: 'FF333333' } },
          bottom: { style: 'thin', color: { argb: 'FF333333' } },
          right: { style: 'thin', color: { argb: 'FF333333' } }
        }
      };
      headers.forEach((h, i) => setCell(wsR, headerRow, i + 1, h, headerStyle));
      wsR.getRow(headerRow).height = 24;

      // 데이터
      const baseCellStyle = {
        font: { name: '맑은 고딕', size: 10 },
        alignment: { horizontal: 'center', vertical: 'middle' },
        border: {
          top: { style: 'thin', color: { argb: 'FFAAAAAA' } },
          left: { style: 'thin', color: { argb: 'FFAAAAAA' } },
          bottom: { style: 'thin', color: { argb: 'FFAAAAAA' } },
          right: { style: 'thin', color: { argb: 'FFAAAAAA' } }
        }
      };
      const typeColors = {
        national:    { argb: 'FFE74C3C', label: 'NR' },
        division:    { argb: 'FF3498DB', label: 'DR' },
        competition: { argb: 'FF27AE60', label: 'CR' }
      };

      recordBreaks.forEach((r, idx) => {
        const dataRow = headerRow + 1 + idx;
        const tc = typeColors[r.record_type] || { argb: 'FF7F8C8D', label: '-' };
        const ctxLabel = r.record_type === 'division'
          ? (r.division_label || r.division_code || '')
          : r.record_type === 'competition'
            ? (r.series_name || `시리즈#${r.series_id || '-'}`)
            : '한국';
        const genderK = r.gender === 'M' ? '남자' : r.gender === 'F' ? '여자' : '혼성';
        const wind = (typeof r.wind === 'number' && !isNaN(r.wind)) ? `+${r.wind.toFixed(1)}` : '-';
        const reviewedAt = r.reviewed_at ? String(r.reviewed_at).substring(0, 10) : '';

        setCell(wsR, dataRow, 1, idx + 1, baseCellStyle);
        // 구분: 색상 강조
        setCell(wsR, dataRow, 2, tc.label, {
          ...baseCellStyle,
          font: { name: '맑은 고딕', size: 11, bold: true, color: { argb: 'FFFFFFFF' } },
          fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: tc.argb } }
        });
        setCell(wsR, dataRow, 3, r.event_name || '', { ...baseCellStyle, font: { name: '맑은 고딕', size: 10, bold: true } });
        setCell(wsR, dataRow, 4, genderK, baseCellStyle);
        setCell(wsR, dataRow, 5, ctxLabel, baseCellStyle);
        setCell(wsR, dataRow, 6, r.previous_value || '(없음)', { ...baseCellStyle, font: { name: '맑은 고딕', size: 10, color: { argb: 'FF888888' } } });
        setCell(wsR, dataRow, 7, r.new_value || '', {
          ...baseCellStyle,
          font: { name: '맑은 고딕', size: 11, bold: true, color: { argb: tc.argb } }
        });
        setCell(wsR, dataRow, 8, r.athlete_name || '', { ...baseCellStyle, font: { name: '맑은 고딕', size: 10, bold: true } });
        setCell(wsR, dataRow, 9, r.athlete_team || '', baseCellStyle);
        setCell(wsR, dataRow, 10, wind, baseCellStyle);
        setCell(wsR, dataRow, 11, reviewedAt, baseCellStyle);
        wsR.getRow(dataRow).height = 20;
      });

      // 푸터
      const footerRow = headerRow + 1 + recordBreaks.length + 1;
      mergeSet(wsR, footerRow, 2, footerRow, 11,
        `생성일: ${new Date().toISOString().substring(0,10)} · 총 ${recordBreaks.length}건 · PACE RISE`, {
        font: { name: '맑은 고딕', size: 9, italic: true, color: { argb: 'FF999999' } },
        alignment: { horizontal: 'right', vertical: 'middle' }
      });
    }
  } catch (e) {
    // 신기록 시트는 부가 기능. 실패해도 전체 Excel 생성에 영향 X
    console.warn('[fullRecordExcel] 신기록 시트 생성 실패 (non-fatal):', e && e.message);
  }

  // ===== INDIVIDUAL EVENT SHEETS =====
  for (const evtName of SHEET_ORDER) {
    const evts = eventsByName[evtName];
    if (!evts) continue;

    const isRelay = RELAY_EVENTS.has(evtName);
    const isCombined = COMBINED_EVENTS.has(evtName);
    const isHeight = HEIGHT_EVENTS.has(evtName);
    const isThrow = THROW_EVENTS.has(evtName);
    const isJump = JUMP_EVENTS.has(evtName);
    const hasWind = WIND_EVENTS.has(evtName);
    const isFieldDist = isThrow || isJump;

    const sortedEvts = [...evts].sort((a, b) => {
      const order = { final: 0, semifinal: 1, preliminary: 2 };
      return (order[a.round_type] || 9) - (order[b.round_type] || 9);
    });
    const finalEvts = sortedEvts.filter(e => e.round_type === 'final');
    const prelimEvts = sortedEvts.filter(e => e.round_type === 'preliminary').sort((a, b) => {
      const ha = db.prepare('SELECT MIN(heat_number) as mn FROM heat WHERE event_id=?').get(a.id);
      const hb = db.prepare('SELECT MIN(heat_number) as mn FROM heat WHERE event_id=?').get(b.id);
      return (ha?.mn || 0) - (hb?.mn || 0);
    });
    const semiEvts = sortedEvts.filter(e => e.round_type === 'semifinal').sort((a, b) => {
      const ha = db.prepare('SELECT MIN(heat_number) as mn FROM heat WHERE event_id=?').get(a.id);
      const hb = db.prepare('SELECT MIN(heat_number) as mn FROM heat WHERE event_id=?').get(b.id);
      return (ha?.mn || 0) - (hb?.mn || 0);
    });
    const orderedEvts = [...finalEvts, ...prelimEvts, ...semiEvts];

    let sheetName = evtName.length > 31 ? evtName.substring(0, 31) : evtName;
    if (wb.worksheets.find(s => s.name === sheetName)) sheetName = sheetName + '_';
    const ws = wb.addWorksheet(sheetName);
    ws.pageSetup = {
      paperSize: 9, orientation: 'portrait',
      fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      margins: { left: 0.4, right: 0.4, top: 0.4, bottom: 0.4, header: 0.15, footer: 0.15 }
    };

    // Get merged record data: prefer event_record (global), fallback to event_records (per-event)
    const finalEvt = finalEvts[0];
    let mergedRecData = eventRecords[evtName] || {};
    if (finalEvt) {
      const perEvtRec = getEventRecordsForEvent(finalEvt.id);
      if (perEvtRec) {
        // Merge: per-event records fill in blanks
        for (const key of ['nr', 'dr', 'cr']) {
          const mappedKey = key === 'nr' ? 'national' : key === 'dr' ? 'division' : 'competition';
          if (perEvtRec[key] && !mergedRecData[mappedKey]?.record_value) {
            mergedRecData[mappedKey] = {
              record_value: perEvtRec[key].record || '',
              holder_name: perEvtRec[key].athlete || '',
              holder_team: perEvtRec[key].team || '',
              record_year: perEvtRec[key].year || ''
            };
          }
        }
      }
    }

    // ---- HEIGHT events ----
    if (isHeight) {
      if (!finalEvt) continue;
      const rankings = getEventRankings(finalEvt);
      const allHeights = new Set();
      for (const r of rankings) { if (r.heights) r.heights.forEach(h => allHeights.add(h)); }
      const heights = [...allHeights].sort((a, b) => a - b);

      const totalCols = 4 + heights.length + 2;
      ws.getColumn(1).width = 7; ws.getColumn(2).width = 12; ws.getColumn(3).width = 8; ws.getColumn(4).width = 16;
      for (let i = 0; i < heights.length; i++) ws.getColumn(5 + i).width = 7;
      ws.getColumn(5 + heights.length).width = 9;
      ws.getColumn(6 + heights.length).width = 6;

      buildSheetHeader(ws, evtName, '결   승', compInfo, genderLabel, comp.id, 6 + heights.length, getEventDate(finalEvt.id));
      let row = 5;

      const hdrRow = ['등위', '성명', '번호', '소속', ...heights.map(h => fmtHeight(h)), '기록', '비고'];
      for (let c = 0; c < hdrRow.length; c++) {
        setCell(ws, row, c + 1, hdrRow[c], { font: fonts.header, fill: fills.headerDark, alignment: alignC, border: borders.header });
      }
      ws.getRow(row).height = 22;
      row++;

      let rank = 1;
      for (const r of rankings) {
        const isSpecial = ['DNS','DNF','DQ','NM'].includes(r.status_code);
        if (r.status_code === 'DNS') continue; // Skip DNS
        const bgFill = rank % 2 === 0 ? fills.gray : fills.white;
        setCell(ws, row, 1, isSpecial ? '' : rank, { font: fonts.normal, alignment: alignC, border: borders.all, fill: bgFill });
        if (!isSpecial) rank++;
        setCell(ws, row, 2, r.name || '', { font: fonts.normal, alignment: alignC, border: borders.all, fill: bgFill });
        setCell(ws, row, 3, r.bib_number || '', { font: fonts.small, alignment: alignC, border: borders.all, fill: bgFill });
        setCell(ws, row, 4, r.team || '', { font: fonts.small, alignment: alignC, border: borders.all, fill: bgFill });
        const myAttempts = r.attempts || [];
        for (let hi = 0; hi < heights.length; hi++) {
          const attH = myAttempts.filter(a => a.bar_height === heights[hi]);
          let mark = '';
          if (attH.length > 0) {
            mark = attH.sort((a, b) => a.attempt_number - b.attempt_number).map(a => a.result_mark === 'PASS' ? '-' : a.result_mark).join('');
          }
          setCell(ws, row, 5 + hi, mark, { font: fonts.small, alignment: alignC, border: borders.all, fill: bgFill });
        }
        // DNF/DQ → 기록란 공백, 비고란에만 표시. NM → 기록+비고 모두 표시
        const isDnfDqH = ['DNF','DQ'].includes(r.status_code);
        const heightRecVal = isDnfDqH ? '' : (r.record || '');
        setCell(ws, row, 5 + heights.length, heightRecVal, { font: fonts.record, alignment: alignC, border: borders.all, fill: bgFill });
        setCell(ws, row, 6 + heights.length, isSpecial ? r.status_code : '', { font: fonts.small, alignment: alignC, border: borders.all, fill: bgFill });
        row++;
      }
      buildRecordTable(ws, row, mergedRecData, recorder, chiefJudge, 6 + heights.length);
      continue;
    }

    // ---- FIELD DISTANCE / THROW events ----
    if (isFieldDist) {
      if (!finalEvt) continue;
      const rankings = getEventRankings(finalEvt);
      // Wind per attempt: always for jump events, also for throws if any wind data exists
      const hasWindData = isJump || rankings.some(r => (r.attempts || []).some(a => a.wind != null));
      const showWind = hasWindData;

      const colW = [6, 12, 8, 16, 9, 9, 9, 9, 9, 9, 11, 7];
      colW.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

      buildSheetHeader(ws, evtName, '결   승', compInfo, genderLabel, comp.id, 12, getEventDate(finalEvt.id));
      let row = 5;

      const hdrRow = ['등위', '성명', '번호', '소속', '1차', '2차', '3차', '4차', '5차', '6차', '기록', '비고'];
      for (let c = 0; c < hdrRow.length; c++) {
        setCell(ws, row, c + 1, hdrRow[c], { font: fonts.header, fill: fills.headerDark, alignment: alignC, border: borders.header });
      }
      ws.getRow(row).height = 22;
      row++;

      let rank = 1;
      for (const r of rankings) {
        const isSpecial = ['DNS','DNF','DQ','NM'].includes(r.status_code);
        if (r.status_code === 'DNS') continue;
        const bgFill = rank % 2 === 0 ? fills.gray : fills.white;
        setCell(ws, row, 1, isSpecial ? '' : rank, { font: fonts.normal, alignment: alignC, border: borders.all, fill: bgFill });
        if (!isSpecial) rank++;
        setCell(ws, row, 2, r.name || '', { font: fonts.normal, alignment: alignC, border: borders.all, fill: bgFill });
        setCell(ws, row, 3, r.bib_number || '', { font: fonts.small, alignment: alignC, border: borders.all, fill: bgFill });
        setCell(ws, row, 4, r.team || '', { font: fonts.small, alignment: { horizontal: 'left', vertical: 'middle', wrapText: true }, border: borders.all, fill: bgFill });

        const attempts = r.attempts || [];
        for (let i = 1; i <= 6; i++) {
          const att = attempts.find(a => a.attempt_number === i);
          let val = '-';
          if (att) {
            if (att.status_code === 'X' || att.status_code === 'FOUL' || (att.distance_meters === 0 && !att.status_code)) val = 'X';
            else if (att.distance_meters != null && att.distance_meters > 0) {
              val = fmtDist(att.distance_meters);
            }
          }
          setCell(ws, row, 4 + i, val, { font: fonts.small, alignment: alignC, border: borders.all, fill: bgFill });
        }
        // DNF/DQ → 기록란 공백, 비고란에만 표시. NM → 기록+비고 모두 표시
        const isDnfDq = ['DNF','DQ'].includes(r.status_code);
        const fieldRecVal = isDnfDq ? '' : (isSpecial ? r.status_code : (r.record || ''));
        setCell(ws, row, 11, fieldRecVal, { font: fonts.record, alignment: alignC, border: borders.all, fill: bgFill });
        setCell(ws, row, 12, isSpecial ? r.status_code : '', { font: fonts.small, alignment: alignC, border: borders.all, fill: bgFill });
        const dataRow = row;
        row++;

        // Wind row for jump events
        if (showWind) {
          setCell(ws, row, 1, '', { border: borders.all, fill: bgFill });
          setCell(ws, row, 2, '', { border: borders.all, fill: bgFill });
          setCell(ws, row, 3, '', { border: borders.all, fill: bgFill });
          setCell(ws, row, 4, '', { border: borders.all, fill: bgFill });
          for (let i = 1; i <= 6; i++) {
            const att = attempts.find(a => a.attempt_number === i);
            const windVal = (att && att.wind != null) ? fmtWind(att.wind) : '';
            setCell(ws, row, 4 + i, windVal, { font: { ...fonts.tiny, color: { argb: 'FF888888' } }, alignment: alignC, border: borders.all, fill: bgFill });
          }
          setCell(ws, row, 11, r.bestWind != null ? fmtWind(r.bestWind) : '', { font: { ...fonts.tiny, color: { argb: 'FF888888' } }, alignment: alignC, border: borders.all, fill: bgFill });
          setCell(ws, row, 12, '', { border: borders.all, fill: bgFill });
          ws.getRow(row).height = 13;
          // Merge rank, name, bib, team vertically
          try { ws.mergeCells(dataRow, 1, row, 1); } catch(e) {}
          try { ws.mergeCells(dataRow, 2, row, 2); } catch(e) {}
          try { ws.mergeCells(dataRow, 3, row, 3); } catch(e) {}
          try { ws.mergeCells(dataRow, 4, row, 4); } catch(e) {}
          row++;
        }
      }
      buildRecordTable(ws, row, mergedRecData, recorder, chiefJudge, 12);
      continue;
    }

    // ---- RELAY events ----
    if (isRelay) {
      if (!finalEvt) continue;
      const rankings = getEventRankings(finalEvt);

      const colW = [7, 18, 18, 14, 8, 8];
      colW.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

      buildSheetHeader(ws, evtName, '결   승', compInfo, genderLabel, comp.id, 6, getEventDate(finalEvt.id));
      let row = 5;

      const hdrRow = ['등 위', '소 속', '선  수', '기  록', '비고', ''];
      for (let c = 0; c < hdrRow.length; c++) {
        setCell(ws, row, c + 1, hdrRow[c], { font: fonts.header, fill: fills.headerDark, alignment: alignC, border: borders.header });
      }
      ws.getRow(row).height = 22;
      row++;

      let rank = 1;
      for (const r of rankings) {
        const isSpecial = ['DNS','DNF','DQ'].includes(r.status_code);
        if (r.status_code === 'DNS') continue;
        const members = r.members || [];
        const bgFill = rank % 2 === 0 ? fills.gray : fills.white;

        // Row 1: rank + team name + record
        setCell(ws, row, 1, isSpecial ? '' : rank, { font: fonts.normal, alignment: alignC, border: borders.all, fill: bgFill });
        if (!isSpecial) rank++;
        mergeSet(ws, row, 2, row, 3, r.team || '', { font: fonts.normal, alignment: { horizontal: 'left', vertical: 'middle', wrapText: true }, border: borders.all, fill: bgFill });
        // DNF/DQ → 기록란 공백, 비고란에만 표시
        const relayRecVal = ['DNF','DQ'].includes(r.status_code) ? '' : r.record;
        setCell(ws, row, 4, relayRecVal, { font: fonts.record, alignment: alignC, border: borders.all, fill: bgFill });
        setCell(ws, row, 5, isSpecial ? r.status_code : '', { border: borders.all, fill: bgFill });
        setCell(ws, row, 6, '', { border: borders.all, fill: bgFill });
        ws.getRow(row).height = 20;
        row++;

        // Row 2: runners listed with 2 names per line
        setCell(ws, row, 1, '', { border: borders.all, fill: bgFill });
        const lines = [];
        for (let mi = 0; mi < members.length; mi += 2) {
          lines.push(members.slice(mi, mi + 2).join('  '));
        }
        const runnerStr = lines.join('\n');
        mergeSet(ws, row, 2, row, 3, runnerStr, { font: fonts.small, alignment: { horizontal: 'center', vertical: 'middle', wrapText: true }, border: borders.all, fill: bgFill });
        setCell(ws, row, 4, '', { border: borders.all, fill: bgFill });
        setCell(ws, row, 5, '', { border: borders.all, fill: bgFill });
        setCell(ws, row, 6, '', { border: borders.all, fill: bgFill });
        const runnerRowHeight = Math.max(18, lines.length * 14);
        ws.getRow(row).height = runnerRowHeight;
        row++;
      }
      buildRecordTable(ws, row, mergedRecData, recorder, chiefJudge, 6);
      continue;
    }

    // ---- COMBINED events ----
    if (isCombined) {
      if (!finalEvt) continue;
      const rankings = getEventRankings(finalEvt);

      const colW = [7, 14, 8, 18, 12, 14];
      colW.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

      buildSheetHeader(ws, evtName, '결   승', compInfo, genderLabel, comp.id, 6, getEventDate(finalEvt.id));
      let row = 5;

      const hdrRow = ['등 위', '성명', '번호', '소속', '점수', '비고'];
      for (let c = 0; c < hdrRow.length; c++) {
        setCell(ws, row, c + 1, hdrRow[c], { font: fonts.header, fill: fills.headerDark, alignment: alignC, border: borders.header });
      }
      ws.getRow(row).height = 22;
      row++;

      let rank = 1;
      for (const r of rankings) {
        const isSpecial = ['DNS','DNF','DQ'].includes(r.status_code);
        if (r.status_code === 'DNS') continue;
        const bgFill = rank % 2 === 0 ? fills.gray : fills.white;
        setCell(ws, row, 1, isSpecial ? '' : rank, { font: fonts.normal, alignment: alignC, border: borders.all, fill: bgFill });
        if (!isSpecial) rank++;
        setCell(ws, row, 2, r.name || '', { font: fonts.normal, alignment: alignC, border: borders.all, fill: bgFill });
        setCell(ws, row, 3, r.bib_number || '', { font: fonts.small, alignment: alignC, border: borders.all, fill: bgFill });
        setCell(ws, row, 4, r.team || '', { font: fonts.small, alignment: alignC, border: borders.all, fill: bgFill });
        // DNF/DQ → 기록란(점수) 공백, 비고란에만 표시
        const combRecVal = ['DNF','DQ'].includes(r.status_code) ? '' : (r.record || '');
        setCell(ws, row, 5, combRecVal, { font: fonts.record, alignment: alignC, border: borders.all, fill: bgFill });
        setCell(ws, row, 6, isSpecial ? r.status_code : '', { font: fonts.small, alignment: alignC, border: borders.all, fill: bgFill });
        row++;
      }
      buildRecordTable(ws, row, mergedRecData, recorder, chiefJudge, 6);
      continue;
    }

    // ---- TRACK events (with multiple rounds) ----
    const colW = [7, 14, 8, 13, 11, 14];
    colW.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

    let row = 1;
    let isFirstBlock = true;

    for (const evt of orderedEvts) {
      const isFinal = evt.round_type === 'final';
      const heats = db.prepare('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number').all(evt.id);

      // Load qualification selections for non-final rounds (Q/q markers)
      let qualMap = {};
      if (!isFinal) {
        const quals = db.prepare('SELECT event_entry_id, qualification_type FROM qualification_selection WHERE event_id=? AND selected=1').all(evt.id);
        for (const q of quals) { qualMap[q.event_entry_id] = q.qualification_type || 'Q'; }
      }

      for (const heat of heats) {
        const heatEntries = db.prepare(`SELECT he.lane_number, ee.id AS event_entry_id, ee.status, ee.athlete_id,
          a.name, a.bib_number, a.team FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id
          JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=?`).all(heat.id);
        const heatResults = db.prepare('SELECT * FROM result WHERE heat_id=? ORDER BY event_entry_id').all(heat.id);
        const resMap = {};
        for (const r of heatResults) { if (!resMap[r.event_entry_id]) resMap[r.event_entry_id] = []; resMap[r.event_entry_id].push(r); }

        const entries = heatEntries.map(e => {
          const recs = resMap[e.event_entry_id] || [];
          const r = recs.find(r => r.time_seconds != null);
          const best = r ? r.time_seconds : null;
          const bestWind = r ? r.wind : null;
          let sc = recs.find(r => r.status_code && ['DNS','DNF','NM','DQ'].includes(r.status_code))?.status_code || '';
          if (!sc && e.status === 'no_show') sc = 'DNS';
          return { ...e, best, bestWind, status_code: sc, record: sc || fmtTime(best) };
        }).sort((a, b) => {
          const aS = ['DNS','DNF','NM','DQ'].includes(a.status_code);
          const bS = ['DNS','DNF','NM','DQ'].includes(b.status_code);
          if (aS && !bS) return 1; if (!aS && bS) return -1;
          if (aS && bS) { const order = {DNF:1,DQ:2,DNS:3}; return (order[a.status_code]||9) - (order[b.status_code]||9); }
          if (a.best == null && b.best == null) return 0;
          if (a.best == null) return 1; if (b.best == null) return -1;
          return a.best - b.best;
        });

        if (isFirstBlock) {
          let roundLabel = '결   승';
          if (evt.round_type === 'preliminary') roundLabel = `예선  ${heat.heat_number}조`;
          else if (evt.round_type === 'semifinal') roundLabel = `준결승  ${heat.heat_number}조`;
          row = buildSheetHeader(ws, evtName, roundLabel, compInfo, genderLabel, comp.id, 6, getEventDate(evt.id));
          isFirstBlock = false;
        } else {
          row++; // spacer
          let roundLabel = '결   승';
          if (evt.round_type === 'preliminary') roundLabel = `예선  ${heat.heat_number}조`;
          else if (evt.round_type === 'semifinal') roundLabel = `준결승  ${heat.heat_number}조`;
          mergeSet(ws, row, 1, row, 6, roundLabel, { font: fonts.round, alignment: alignC, fill: fills.lightGold, border: borders.header });
          ws.getRow(row).height = 22;
          row++;
        }

        // Wind
        if (hasWind) {
          mergeSet(ws, row, 1, row, 2, '풍  속:', { font: fonts.smallBold, alignment: alignR });
          setCell(ws, row, 3, heat.wind != null ? fmtWind(parseFloat(String(heat.wind).replace(' m/s', ''))) : '', { font: fonts.normal, alignment: alignC });
          setCell(ws, row, 4, 'm/s', { font: fonts.small, alignment: alignL });
          row++;
        }

        // Header row
        const hdrRow = ['등위', '성명', '번호', '소속', '기록', '비고'];
        for (let c = 0; c < hdrRow.length; c++) {
          setCell(ws, row, c + 1, hdrRow[c], { font: fonts.header, fill: fills.headerDark, alignment: alignC, border: borders.header });
        }
        ws.getRow(row).height = 22;
        row++;

        // Data
        let rank = 1;
        for (const e of entries) {
          const isSpecial = ['DNS','DNF','DQ'].includes(e.status_code);
          if (e.status_code === 'DNS') continue; // Skip DNS in output
          const bgFill = rank % 2 === 0 ? fills.gray : fills.white;
          setCell(ws, row, 1, isSpecial ? '' : rank, { font: fonts.normal, alignment: alignC, border: borders.all, fill: bgFill });
          if (!isSpecial) rank++;
          setCell(ws, row, 2, e.name || '', { font: fonts.normal, alignment: alignC, border: borders.all, fill: bgFill });
          setCell(ws, row, 3, e.bib_number || '', { font: fonts.small, alignment: alignC, border: borders.all, fill: bgFill });
          setCell(ws, row, 4, e.team || '', { font: fonts.small, alignment: alignC, border: borders.all, fill: bgFill });
          // DNF/DQ → 기록란 공백, 비고란에만 표시
          const isDnfDq = ['DNF','DQ'].includes(e.status_code);
          const recVal = isDnfDq ? '' : (e.record || '');
          setCell(ws, row, 5, recVal, { font: fonts.record, alignment: alignC, border: borders.all, fill: bgFill });
          const remarkVal = isSpecial ? e.status_code : (qualMap[e.event_entry_id] || '');
          const remarkFont = remarkVal === 'Q' ? { ...fonts.small, bold: true, color: { argb: 'FF0066CC' } }
                           : remarkVal === 'q' ? { ...fonts.small, color: { argb: 'FF0066CC' } }
                           : fonts.small;
          setCell(ws, row, 6, remarkVal, { font: remarkFont, alignment: alignC, border: borders.all, fill: bgFill });
          row++;
        }

        // Record comparison table for final only
        if (isFinal && heats.indexOf(heat) === heats.length - 1) {
          row = buildRecordTable(ws, row, mergedRecData, recorder, chiefJudge, 6);
        }
      }
    }
  }

  return wb;
}

module.exports = { generateFullRecordExcel };
