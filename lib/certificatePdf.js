/**
 * Certificate PDF Generator (상장/완주증)
 * - A4 세로 (portrait)
 * - PDFKit + NanumSquare 폰트
 * - 양식 종류: 'award' (시상장), 'finisher' (완주증), 'team' (단체상)
 * - 순위 표기: 'ordinal' (우승/준우승/3위/4위...) | 'numeric' (1위/2위/3위...) | 'mixed'
 * - 본문 템플릿 변수: {athlete_name} {team} {event_name} {rank_label} {record_value} {date} {competition_name}
 */
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');

const FONT_R = path.join(__dirname, '..', 'public', 'fonts', 'NanumSquare_acR.ttf');
const FONT_B = path.join(__dirname, '..', 'public', 'fonts', 'NanumSquare_acB.ttf');

// A4 portrait (points): 595.28 x 841.89
const A4_W = 595.28;
const A4_H = 841.89;

module.exports = {
  generateCertificatePdf,
  generateCertificateBatch,
  renderRankLabel,
  fillTemplate,
};

/* ---------------- helpers ---------------- */

// 순위 → 한글 표기 변환
function renderRankLabel(rank, style) {
  if (rank == null || rank === '' || isNaN(Number(rank))) return '';
  const r = Number(rank);
  if (style === 'ordinal') {
    if (r === 1) return '우승';
    if (r === 2) return '준우승';
    return `${r}위`;
  }
  if (style === 'mixed') {
    if (r === 1) return '우승';
    if (r === 2) return '준우승';
    if (r === 3) return '3위';
    return `${r}위`;
  }
  // numeric
  return `${r}위`;
}

// 본문 템플릿 치환
function fillTemplate(tpl, vars) {
  if (!tpl) return '';
  return String(tpl).replace(/\{(\w+)\}/g, (m, key) => {
    const v = vars[key];
    return (v === undefined || v === null) ? '' : String(v);
  });
}

// 오늘 날짜 한국식 표기
function todayKR() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}년 ${Number(m)}월 ${Number(day)}일`;
}

// 상대경로(/uploads/...) → 절대경로 변환, http(s) URL은 그대로 못 쓰니 null 반환
function resolveImagePath(p) {
  if (!p || typeof p !== 'string') return null;
  if (/^https?:\/\//i.test(p)) return null; // remote URL — pdfkit는 file path or buffer만 허용
  // ?v=... 캐시버스터 제거
  let cleaned = p.split('?')[0];
  // 실제 절대경로 (예: /home/user/webapp/public/...) → 그대로
  if (cleaned.startsWith('/home/') || cleaned.startsWith('/usr/') || cleaned.startsWith('/var/') || cleaned.startsWith('/tmp/')) {
    return cleaned;
  }
  // 웹 절대경로 (/uploads/..., /logos/...) → public 하위로 변환
  if (cleaned.startsWith('/')) {
    return path.join(__dirname, '..', 'public', cleaned.replace(/^\/+/, ''));
  }
  // 상대경로
  return path.join(__dirname, '..', cleaned);
}

// 안전한 파일 존재 체크 (자동 경로 해석 포함)
function fileOk(p) {
  try {
    const resolved = resolveImagePath(p);
    if (!resolved) return false;
    return fs.existsSync(resolved) && fs.statSync(resolved).isFile();
  } catch (_) { return false; }
}
// 실제 이미지 로딩용 — 해석된 경로 반환 (없으면 null)
function imageFile(p) {
  if (!fileOk(p)) return null;
  return resolveImagePath(p);
}

/* ---------------- border drawing ---------------- */

function drawBorder(doc, style, color) {
  const margin = 28;
  const x = margin, y = margin;
  const w = A4_W - margin * 2;
  const h = A4_H - margin * 2;
  const c = color || '#b8945a';

  if (style === 'none') return;

  if (style === 'double-gold' || !style || style === 'default') {
    // 이중선 테두리 (금색 톤)
    doc.lineWidth(2).strokeColor(c).rect(x, y, w, h).stroke();
    doc.lineWidth(0.8).strokeColor(c).rect(x + 8, y + 8, w - 16, h - 16).stroke();
    return;
  }
  if (style === 'single') {
    doc.lineWidth(1.5).strokeColor(c).rect(x, y, w, h).stroke();
    return;
  }
  if (style === 'classic') {
    // 외곽 굵은선 + 내부 가는선 + 코너 장식
    doc.lineWidth(3).strokeColor(c).rect(x, y, w, h).stroke();
    doc.lineWidth(0.6).strokeColor(c).rect(x + 14, y + 14, w - 28, h - 28).stroke();
    return;
  }
  // fallback
  doc.lineWidth(1.5).strokeColor(c).rect(x, y, w, h).stroke();
}

/* ---------------- main: single certificate page ---------------- */

/**
 * 한 페이지(한 명) 분량의 상장을 doc에 그린다.
 * 새 페이지는 호출 측에서 doc.addPage() 로 추가.
 * @param {PDFKit.PDFDocument} doc
 * @param {Object} template - certificate_template row
 * @param {Object} data - { athlete_name, team, event_name, rank, record_value, competition_name, date, custom_body }
 */
// 기록증 — 미니멀 라인형 카드 레이아웃
function renderRecordCard(doc, tpl, data) {
  const accent = tpl.border_color || '#b79f58';
  const panelColor = tpl.panel_color || '#faf8f2';
  const textColor = tpl.text_color || '#1a1a1a';    // 본문 글씨(제목·이름·본문·날짜·발급자)
  const labelColor = tpl.label_color || '#8a7f6a';  // 보조 글씨(대회명·메타·패널 라벨)
  const accentColor = tpl.accent_color || '#7a3a00'; // 강조(기록값)
  const panelOpacity = Math.min(1, Math.max(0.2, tpl.panel_opacity == null ? 1 : Number(tpl.panel_opacity))); // 패널 투명도(낮추면 뒤 워터마크 비침)
  const x0 = 36, y0 = 36, cardW = A4_W - 72, cardH = A4_H - 72;

  // 상단 포인트 바 (라운드 모서리에 맞게 클립) → 테두리를 그 위에 그려 한 줄로 깔끔하게
  doc.save();
  doc.roundedRect(x0, y0, cardW, cardH, 14).clip();
  doc.fillColor(accent).rect(x0, y0, cardW, 7).fill();
  doc.restore();
  doc.save();
  doc.lineWidth(1.2).strokeColor(accent).roundedRect(x0, y0, cardW, cardH, 14).stroke();
  doc.restore();

  // ----- 로고 (좌/우 상단, 포인트 바 아래 카드 안쪽) -----
  const logoSize = 50, logoTop = 58;
  const lLogo = imageFile(tpl.logo_left_path);
  if (lLogo) { try { doc.image(lLogo, x0 + 30, logoTop, { fit: [logoSize, logoSize], align: 'center', valign: 'center' }); } catch (_) {} }
  const rLogo = imageFile(tpl.logo_right_path);
  if (rLogo) { try { doc.image(rLogo, x0 + cardW - 30 - logoSize, logoTop, { fit: [logoSize, logoSize], align: 'center', valign: 'center' }); } catch (_) {} }

  // ----- 워터마크 (본문·패널 '뒤'에 옅게) -----
  // 패널을 반투명(panel_opacity<1)으로 그리면 이 워터마크가 패널 너머로 비쳐 보인다.
  const wmImg = imageFile(tpl.watermark_image_path);
  if (wmImg) {
    const wmScale = Math.min(0.9, Math.max(0.1, Number(tpl.watermark_scale) || 0.45));
    const wmOpacity = Math.min(0.5, Math.max(0.02, Number(tpl.watermark_opacity) || 0.07));
    const box = A4_W * wmScale;
    try {
      doc.save();
      doc.opacity(wmOpacity);
      doc.image(wmImg, (A4_W - box) / 2, (A4_H - box) / 2, { fit: [box, box], align: 'center', valign: 'center' });
      doc.restore();
    } catch (_) { try { doc.restore(); } catch (_) {} }
  }

  // 제목
  doc.font('B').fontSize(38).fillColor(textColor);
  const title = (tpl.title_text && tpl.title_text !== '상  장') ? tpl.title_text : '기 록 증';
  const tw = doc.widthOfString(title);
  doc.text(title, (A4_W - tw) / 2, 92, { lineBreak: false });

  // 대회명
  if (data.competition_name) {
    doc.font('R').fontSize(13).fillColor(labelColor);
    const cw = doc.widthOfString(data.competition_name);
    doc.text(data.competition_name, (A4_W - cw) / 2, 146, { lineBreak: false });
  }
  // 구분선
  doc.lineWidth(0.8).strokeColor(accent).moveTo(A4_W / 2 - 60, 180).lineTo(A4_W / 2 + 60, 180).stroke();

  // 이름
  const name = data.athlete_name || '';
  doc.font('B').fontSize(28).fillColor(textColor);
  const nw = doc.widthOfString(name);
  doc.text(name, (A4_W - nw) / 2, 212, { lineBreak: false });

  // 성별 · 부별 · 소속 · 배번
  const genderLabel = data.gender === 'M' ? '남자' : data.gender === 'F' ? '여자' : data.gender === 'X' ? '혼성' : '';
  const subParts = [];
  if (genderLabel) subParts.push(genderLabel);
  if (data.division) subParts.push(data.division);
  if (data.team) subParts.push(data.team);
  if (data.bib_number != null && data.bib_number !== '') subParts.push(`배번 ${data.bib_number}`);
  if (subParts.length) {
    const sub = subParts.join('   ·   ');
    doc.font('R').fontSize(13).fillColor(labelColor);
    const sw = doc.widthOfString(sub);
    doc.text(sub, (A4_W - sw) / 2, 252, { lineBreak: false });
  }

  // 증명 문구
  const proveTpl = tpl.body_template || '위 선수는 본 대회에 출전하여 아래와 같은 기록을 수립하였음을 이에 증명합니다.';
  const proveText = fillTemplate(proveTpl, {
    athlete_name: name, team: data.team || '', event_name: data.event_name || '',
    competition_name: data.competition_name || '', date: data.date || todayKR(),
    rank_label: '', record_value: data.record_value || '',
  });
  doc.font('R').fontSize(14).fillColor(textColor);
  doc.text(proveText, 80, 292, { width: A4_W - 160, align: 'center', lineGap: 7 });

  // ----- 기록 패널 -----
  const mark = String(data.record_value || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  const windNum = (data.wind != null && data.wind !== '' && isFinite(Number(data.wind))) ? Number(data.wind) : null;
  const panelRows = [['종목', data.event_name || '-'], ['기록', mark || '-']];
  if (windNum != null) panelRows.push(['풍속', `${windNum > 0 ? '+' : ''}${windNum.toFixed(1)} m/s`]);

  const pw = 380, px = (A4_W - pw) / 2, rowH = 40, padV = 16;
  const panelTop = doc.y + 40;
  const panelH = panelRows.length * rowH + padV;
  doc.save();
  doc.lineWidth(1);
  doc.opacity(panelOpacity);  // 패널만 반투명 → 뒤 워터마크 비침 (라벨·값 텍스트는 아래에서 불투명으로 그림)
  doc.roundedRect(px, panelTop, pw, panelH, 12).fillAndStroke(panelColor, '#e3ddcf');
  doc.restore();

  let ry = panelTop + padV / 2;
  panelRows.forEach(([label, value], i) => {
    const cy = ry + rowH / 2;
    doc.font('R').fontSize(13).fillColor(labelColor);
    doc.text(label, px + 28, cy - 8, { lineBreak: false });
    const isRec = (label === '기록');
    doc.font('B').fontSize(isRec ? 20 : 15).fillColor(isRec ? accentColor : textColor);
    const vw = doc.widthOfString(value);
    doc.text(value, px + pw - 28 - vw, cy - (isRec ? 12 : 9), { lineBreak: false });
    if (i < panelRows.length - 1) {
      doc.lineWidth(0.5).strokeColor('#ece7da').moveTo(px + 20, ry + rowH).lineTo(px + pw - 20, ry + rowH).stroke();
    }
    ry += rowH;
  });

  // 확인 문구
  const confirmY = panelTop + panelH + 34;
  doc.font('R').fontSize(13).fillColor(textColor);
  const confirmText = '위에 기재된 내용이 틀림없음을 확인합니다.';
  const cfw = doc.widthOfString(confirmText);
  doc.text(confirmText, (A4_W - cfw) / 2, confirmY, { lineBreak: false });

  // 날짜 / 발급자 — 맨 아래 고정이 아니라 확인문구 아래로 자연스럽게 흐르게 배치
  // (단, 너무 위로 올라오지 않도록 최소 위치 보장 → 카드 하단 여백 균형)
  let by = Math.max(confirmY + 72, A4_H - 280);
  if (tpl.show_date !== 0) {
    const dateStr = data.date || todayKR();
    doc.font('R').fontSize(14).fillColor(textColor);
    const dw = doc.widthOfString(dateStr);
    doc.text(dateStr, (A4_W - dw) / 2, by, { lineBreak: false });
    by += 48;
  }
  // 발급자 (단체 / 직책+이름 / 인장)
  const org = tpl.signer_org || '';
  const sTitle = tpl.signer_title || '';
  const sName = tpl.signer_name || '';
  if (org) {
    doc.font('B').fontSize(18).fillColor(textColor);
    const ow = doc.widthOfString(org);
    doc.text(org, (A4_W - ow) / 2, by, { lineBreak: false });
    by += 30;
  }
  if (sName || sTitle) {
    doc.font('B').fontSize(18).fillColor(textColor);
    const line = `${sTitle}  ${sName}`.trim();
    const lw = doc.widthOfString(line);
    doc.text(line, (A4_W - lw) / 2, by, { lineBreak: false });
    const sealPath = imageFile(tpl.seal_image_path);
    if (sealPath) { try { doc.image(sealPath, (A4_W + lw) / 2 + 8, by - 10, { fit: [44, 44] }); } catch (_) {} }
  }
}

function renderCertificatePage(doc, template, data) {
  const tpl = template || {};
  const kind = tpl.kind || 'award';
  const rankStyle = tpl.rank_label_style || 'ordinal';
  const bgColor = tpl.background_color || '#fffdf6';
  const borderStyle = tpl.border_style || 'double-gold';
  const textColor = tpl.text_color || '#1a1a1a';    // 본문 글씨(제목·이름·본문·날짜·발급자)
  const labelColor = tpl.label_color || '#8a7f6a';  // 보조 글씨(대회명 부제)
  const accentColor = tpl.accent_color || '#7a3a00'; // 강조(종목·기록·인)

  // 배경
  doc.save();
  doc.rect(0, 0, A4_W, A4_H).fill(bgColor);
  doc.restore();

  // ----- 워터마크 (중앙 로고 이미지, 옅게) -----
  // 배경 다음·본문 전에 그려 본문이 위로 오게 함. 이미지 없으면 생략.
  // 단, 기록증(record)은 불투명 패널에 가려지므로 카드 렌더 끝에서 '맨 위'에 올린다.
  const wmImg = (kind !== 'record') ? imageFile(tpl.watermark_image_path) : null;
  if (wmImg) {
    const wmScale = Math.min(0.9, Math.max(0.1, Number(tpl.watermark_scale) || 0.45));
    const wmOpacity = Math.min(0.5, Math.max(0.02, Number(tpl.watermark_opacity) || 0.07));
    const box = A4_W * wmScale;
    try {
      doc.save();
      doc.opacity(wmOpacity);
      doc.image(wmImg, (A4_W - box) / 2, (A4_H - box) / 2, { fit: [box, box], align: 'center', valign: 'center' });
      doc.restore();
    } catch (_) { try { doc.restore(); } catch (_) {} }
  }

  // 기록증(record)은 미니멀 카드 레이아웃으로 별도 렌더
  if (kind === 'record') { renderRecordCard(doc, tpl, data); return; }

  // 테두리
  drawBorder(doc, borderStyle, tpl.border_color || '#b8945a');

  // ----- 로고 (좌/우) -----
  const logoTop = 70;
  const logoSize = 60;
  const lLogo = imageFile(tpl.logo_left_path);
  if (lLogo) { try { doc.image(lLogo, 80, logoTop, { fit: [logoSize, logoSize] }); } catch (_) {} }
  const rLogo = imageFile(tpl.logo_right_path);
  if (rLogo) { try { doc.image(rLogo, A4_W - 80 - logoSize, logoTop, { fit: [logoSize, logoSize] }); } catch (_) {} }

  // ----- 제목 (상  장 / 완 주 증) -----
  const titleText = tpl.title_text || (kind === 'finisher' ? '완 주 증' : kind === 'team' ? '단 체 상' : '상  장');
  doc.font('B').fontSize(54).fillColor(textColor);
  const titleW = doc.widthOfString(titleText);
  doc.text(titleText, (A4_W - titleW) / 2, 95, { lineBreak: false });

  // 부제 (대회명)
  if (data.competition_name) {
    doc.font('R').fontSize(14).fillColor(labelColor);
    const subW = doc.widthOfString(data.competition_name);
    doc.text(data.competition_name, (A4_W - subW) / 2, 168, { lineBreak: false });
  }

  // 구분선
  doc.lineWidth(0.8).strokeColor(tpl.border_color || '#b8945a')
     .moveTo(A4_W / 2 - 80, 200).lineTo(A4_W / 2 + 80, 200).stroke();

  // ----- 수상자 정보 (소속 / 이름) -----
  let cursorY = 230;
  const athleteName = data.athlete_name || '';
  const team = data.team || '';

  if (tpl.show_athlete_team !== 0 && team) {
    doc.font('R').fontSize(16).fillColor(textColor);
    const teamW = doc.widthOfString(team);
    doc.text(team, (A4_W - teamW) / 2, cursorY, { lineBreak: false });
    cursorY += 30;
  }

  doc.font('B').fontSize(32).fillColor(textColor);
  const nameW = doc.widthOfString(athleteName);
  doc.text(athleteName, (A4_W - nameW) / 2, cursorY, { lineBreak: false });
  cursorY += 56;

  // 귀하 표기는 본문에 포함 (아래 본문에서 처리)

  // ----- 본문 -----
  const rankLabel = renderRankLabel(data.rank, rankStyle);
  const vars = {
    athlete_name: athleteName,
    team: team,
    event_name: data.event_name || '',
    rank_label: rankLabel,
    rank: data.rank == null ? '' : String(data.rank),
    record_value: (tpl.show_record_value !== 0 && data.record_value) ? data.record_value : '',
    date: data.date || todayKR(),
    competition_name: data.competition_name || '',
  };

  // 기본 본문 (template에 없으면 kind별로 자동 생성)
  let bodyTpl = tpl.body_template;
  if (!bodyTpl) {
    // 종목은 아래 "종목 :" 전용 줄에서 표시하므로 본문에서는 생략(중복 방지)
    if (kind === 'finisher') {
      bodyTpl = '위 선수는 {competition_name}에 출전하여\n끝까지 완주하였기에 그 노력과 의지를 높이 평가하여\n이 증서를 수여합니다.';
    } else if (kind === 'team') {
      bodyTpl = '위 단체는 {competition_name}에서 {rank_label}을 차지하여\n그 우수한 성적을 인정하여 이 상장을 수여합니다.';
    } else {
      bodyTpl = '위 선수는 {competition_name}에서\n{rank_label}을 차지하여 그 우수한 성적을 인정하여\n이 상장을 수여합니다.';
    }
  }
  if (data.custom_body) bodyTpl = data.custom_body;

  const bodyText = fillTemplate(bodyTpl, vars);

  doc.font('R').fontSize(17).fillColor(textColor);
  doc.text(bodyText, 90, cursorY, {
    width: A4_W - 180,
    align: 'center',
    lineGap: 8,
  });

  // 종목 / 기록 (본문과 별개로 항상 표시)
  let infoY = doc.y + 14;
  if (vars.event_name) {
    doc.font('B').fontSize(20).fillColor(accentColor);
    const evText = `종목 : ${vars.event_name}`;
    const evW = doc.widthOfString(evText);
    doc.text(evText, (A4_W - evW) / 2, infoY, { lineBreak: false });
    infoY += 30;
  }
  if (vars.record_value) {
    doc.font('B').fontSize(20).fillColor(accentColor);
    const recText = `기록 : ${vars.record_value}`;
    const recW = doc.widthOfString(recText);
    doc.text(recText, (A4_W - recW) / 2, infoY, { lineBreak: false });
    infoY += 30;
  }

  // ----- 날짜 -----
  const dateY = A4_H - 230;
  if (tpl.show_date !== 0) {
    doc.font('R').fontSize(16).fillColor(textColor);
    const dateStr = vars.date;
    const dateW = doc.widthOfString(dateStr);
    doc.text(dateStr, (A4_W - dateW) / 2, dateY, { lineBreak: false });
  }

  // ----- 발급자 (단체명 / 직책 + 이름 / 인장) -----
  const signerY = A4_H - 170;
  const org = tpl.signer_org || '';
  const sTitle = tpl.signer_title || '회장';
  const sName = tpl.signer_name || '';

  if (org) {
    doc.font('B').fontSize(20).fillColor(textColor);
    const orgW = doc.widthOfString(org);
    doc.text(org, (A4_W - orgW) / 2, signerY, { lineBreak: false });
  }
  if (sName || sTitle) {
    doc.font('B').fontSize(20).fillColor(textColor);
    const line = `${sTitle}  ${sName}`.trim();
    const lineW = doc.widthOfString(line);
    const lineY = signerY + 32;
    doc.text(line, (A4_W - lineW) / 2, lineY, { lineBreak: false });

    // 인장 (이름 옆)
    const sealPath = imageFile(tpl.seal_image_path);
    if (sealPath) {
      const sealSize = 50;
      try {
        doc.image(sealPath,
          (A4_W + lineW) / 2 + 8, lineY - 8,
          { fit: [sealSize, sealSize] });
      } catch (_) {}
    } else {
      // 인장 없으면 "(인)" 표시
      doc.font('R').fontSize(14).fillColor(accentColor);
      doc.text('(인)', (A4_W + lineW) / 2 + 10, lineY + 4, { lineBreak: false });
    }
  }
}

/* ---------------- public API ---------------- */

/**
 * 단일 상장 PDF 생성
 * @param {Object} template
 * @param {Object} data
 * @returns {Promise<Buffer>}
 */
async function generateCertificatePdf(template, data) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        layout: 'portrait',
        margin: 0,
        info: {
          Title: `${template?.name || '상장'} - ${data?.athlete_name || ''}`,
          Author: template?.signer_org || 'PaceRise',
        },
      });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // 폰트 등록 (FONT_R/FONT_B 는 __dirname 기준 신뢰 절대경로 → fs 직접 확인.
      //  fileOk/resolveImagePath 는 사용자 업로드 이미지용이라 비표준 설치경로에서 폰트경로를 망가뜨림)
      if (fs.existsSync(FONT_R)) doc.registerFont('R', FONT_R);
      if (fs.existsSync(FONT_B)) doc.registerFont('B', FONT_B);

      renderCertificatePage(doc, template, data);
      doc.end();
    } catch (e) { reject(e); }
  });
}

/**
 * 다중 상장을 하나의 PDF로 (페이지마다 한 명)
 * @param {Object} template
 * @param {Array<Object>} items - data 배열
 * @returns {Promise<Buffer>}
 */
async function generateCertificateBatch(template, items) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        layout: 'portrait',
        margin: 0,
        info: {
          Title: `${template?.name || '상장'} 일괄`,
          Author: template?.signer_org || 'PaceRise',
        },
      });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      if (fs.existsSync(FONT_R)) doc.registerFont('R', FONT_R);
      if (fs.existsSync(FONT_B)) doc.registerFont('B', FONT_B);

      const list = Array.isArray(items) ? items : [];
      if (list.length === 0) {
        // 빈 PDF 방지 — 안내 페이지
        doc.font('R').fontSize(14).text('출력할 대상이 없습니다.', 100, 100);
      } else {
        list.forEach((item, idx) => {
          if (idx > 0) doc.addPage({ size: 'A4', layout: 'portrait', margin: 0 });
          renderCertificatePage(doc, template, item);
        });
      }
      doc.end();
    } catch (e) { reject(e); }
  });
}
