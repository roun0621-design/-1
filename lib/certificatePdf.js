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

// 안전한 파일 존재 체크
function fileOk(p) {
  try { return p && fs.existsSync(p) && fs.statSync(p).isFile(); } catch (_) { return false; }
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
function renderCertificatePage(doc, template, data) {
  const tpl = template || {};
  const kind = tpl.kind || 'award';
  const rankStyle = tpl.rank_label_style || 'ordinal';
  const bgColor = tpl.background_color || '#fffdf6';
  const borderStyle = tpl.border_style || 'double-gold';

  // 배경
  doc.save();
  doc.rect(0, 0, A4_W, A4_H).fill(bgColor);
  doc.restore();

  // 테두리
  drawBorder(doc, borderStyle, '#b8945a');

  // ----- 로고 (좌/우) -----
  const logoTop = 70;
  const logoSize = 60;
  if (fileOk(tpl.logo_left_path)) {
    try { doc.image(tpl.logo_left_path, 80, logoTop, { fit: [logoSize, logoSize] }); } catch (_) {}
  }
  if (fileOk(tpl.logo_right_path)) {
    try { doc.image(tpl.logo_right_path, A4_W - 80 - logoSize, logoTop, { fit: [logoSize, logoSize] }); } catch (_) {}
  }

  // ----- 제목 (상  장 / 완 주 증) -----
  const titleText = tpl.title_text || (kind === 'finisher' ? '완 주 증' : kind === 'team' ? '단 체 상' : '상  장');
  doc.font('B').fontSize(54).fillColor('#1a1a1a');
  const titleW = doc.widthOfString(titleText);
  doc.text(titleText, (A4_W - titleW) / 2, 95, { lineBreak: false });

  // 부제 (대회명)
  if (data.competition_name) {
    doc.font('R').fontSize(14).fillColor('#5a4520');
    const subW = doc.widthOfString(data.competition_name);
    doc.text(data.competition_name, (A4_W - subW) / 2, 168, { lineBreak: false });
  }

  // 구분선
  doc.lineWidth(0.8).strokeColor('#b8945a')
     .moveTo(A4_W / 2 - 80, 200).lineTo(A4_W / 2 + 80, 200).stroke();

  // ----- 수상자 정보 (소속 / 이름) -----
  let cursorY = 230;
  const athleteName = data.athlete_name || '';
  const team = data.team || '';

  if (tpl.show_athlete_team !== 0 && team) {
    doc.font('R').fontSize(16).fillColor('#333');
    const teamW = doc.widthOfString(team);
    doc.text(team, (A4_W - teamW) / 2, cursorY, { lineBreak: false });
    cursorY += 30;
  }

  doc.font('B').fontSize(32).fillColor('#1a1a1a');
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
    if (kind === 'finisher') {
      bodyTpl = '위 선수는 {competition_name} {event_name} 종목에 출전하여\n끝까지 완주하였기에 그 노력과 의지를 높이 평가하여\n이 증서를 수여합니다.';
    } else if (kind === 'team') {
      bodyTpl = '위 단체는 {competition_name}에서 {rank_label}을 차지하여\n그 우수한 성적을 인정하여 이 상장을 수여합니다.';
    } else {
      bodyTpl = '위 선수는 {competition_name}\n{event_name} 종목에서 {rank_label}을 차지하여\n그 우수한 성적을 인정하여 이 상장을 수여합니다.';
    }
  }
  if (data.custom_body) bodyTpl = data.custom_body;

  const bodyText = fillTemplate(bodyTpl, vars);

  doc.font('R').fontSize(17).fillColor('#222');
  doc.text(bodyText, 90, cursorY, {
    width: A4_W - 180,
    align: 'center',
    lineGap: 8,
  });

  // 기록값 (별도 강조)
  if (vars.record_value) {
    const recY = doc.y + 14;
    doc.font('B').fontSize(20).fillColor('#7a3a00');
    const recText = `기록 : ${vars.record_value}`;
    const recW = doc.widthOfString(recText);
    doc.text(recText, (A4_W - recW) / 2, recY, { lineBreak: false });
  }

  // ----- 날짜 -----
  const dateY = A4_H - 230;
  if (tpl.show_date !== 0) {
    doc.font('R').fontSize(16).fillColor('#222');
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
    doc.font('B').fontSize(20).fillColor('#1a1a1a');
    const orgW = doc.widthOfString(org);
    doc.text(org, (A4_W - orgW) / 2, signerY, { lineBreak: false });
  }
  if (sName || sTitle) {
    doc.font('B').fontSize(20).fillColor('#1a1a1a');
    const line = `${sTitle}  ${sName}`.trim();
    const lineW = doc.widthOfString(line);
    const lineY = signerY + 32;
    doc.text(line, (A4_W - lineW) / 2, lineY, { lineBreak: false });

    // 인장 (이름 옆)
    if (fileOk(tpl.seal_image_path)) {
      const sealSize = 50;
      try {
        doc.image(tpl.seal_image_path,
          (A4_W + lineW) / 2 + 8, lineY - 8,
          { fit: [sealSize, sealSize] });
      } catch (_) {}
    } else {
      // 인장 없으면 "(인)" 표시
      doc.font('R').fontSize(14).fillColor('#a02020');
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

      // 폰트 등록
      if (fileOk(FONT_R)) doc.registerFont('R', FONT_R);
      if (fileOk(FONT_B)) doc.registerFont('B', FONT_B);

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

      if (fileOk(FONT_R)) doc.registerFont('R', FONT_R);
      if (fileOk(FONT_B)) doc.registerFont('B', FONT_B);

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
