/**
 * Certificate PDF Generator (상장/완주증)
 * - A4 세로 (portrait)
 * - PDFKit + NanumSquare 폰트
 * - 양식 종류: 'award' (시상장), 'finisher' (완주증), 'team' (단체상)
 * - 순위 표기: 'ordinal' (우승/준우승/3위/4위...) | 'numeric' (1위/2위/3위...) | 'mixed'
 * - 본문 템플릿 변수: {athlete_name} {team} {event_name} {rank_label} {record_value} {date} {competition_name}
 * - 배치 옵션(2026-11-06): font_scale(글자 1~1.3) · logo_scale(로고 0.5~2) · show_body(본문/증명 문구) · signer_inline(발급자 한 줄)
 *   기록증(record)은 내용 블록을 카드 세로 가운데에 놓는다.
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
// ----- 양식 배율·배치 옵션 (2026-11-06, 경기도육상연맹 요청: 글씨·로고 키우고 전체를 아래로 가운데 맞춤) -----
//   font_scale 1~1.3 : 글자 크기와 세로 간격 배율 (기본 1 = 예전 크기)
//   logo_scale 0.5~2 : 좌·우 로고 배율 (기본 1 = 기록증 50pt · 상장 60pt)
//   show_body 0      : 본문(기록증은 '…증명합니다' 증명 문구)을 빼고 그 자리를 접는다
//   signer_inline 1  : 발급자를 '단체명  직책  이름' 한 줄로 (기본은 단체명 / 직책 이름 두 줄)
function tplScales(tpl) {
  const f = Number(tpl.font_scale), l = Number(tpl.logo_scale);
  return {
    s: Math.min(1.3, Math.max(1, isFinite(f) && f > 0 ? f : 1)),
    ls: Math.min(2, Math.max(0.5, isFinite(l) && l > 0 ? l : 1)),
  };
}
function tplShowBody(tpl) { return !(tpl.show_body === 0 || tpl.show_body === '0' || tpl.show_body === false); }
// 발급자 줄 목록 — [{ text, withSeal }] (인장은 직책·이름이 있는 줄 옆에만)
function signerLines(tpl, defaultTitle) {
  const org = tpl.signer_org || '';
  const sTitle = tpl.signer_title || defaultTitle || '';
  const sName = tpl.signer_name || '';
  const nameLine = `${sTitle}  ${sName}`.trim();
  if (Number(tpl.signer_inline) === 1) {
    const one = [org, nameLine].filter(Boolean).join('  ');
    return one ? [{ text: one, withSeal: !!nameLine }] : [];
  }
  const lines = [];
  if (org) lines.push({ text: org, withSeal: false });
  if (nameLine) lines.push({ text: nameLine, withSeal: true });
  return lines;
}

// 기록증 — 미니멀 라인형 카드 레이아웃
//   세로 배치: 내용 블록(제목~발급자) 높이를 먼저 재서 카드 세로 가운데에 놓는다 (2026-11-06).
//   예전엔 위에서부터 고정 좌표라 아래쪽이 크게 비었다(날짜만 '최소 위치'로 끌어내려 균형을 흉내냄).
function renderRecordCard(doc, tpl, data) {
  const accent = tpl.border_color || '#b8945a';
  const panelColor = tpl.panel_color || '#faf8f2';
  const textColor = tpl.text_color || '#1a1a1a';    // 본문 글씨(제목·이름·본문·날짜·발급자)
  const labelColor = tpl.label_color || '#8a7f6a';  // 보조 글씨(대회명·메타·패널 라벨)
  const accentColor = tpl.accent_color || '#7a3a00'; // 강조(기록값)
  const panelOpacity = Math.min(1, Math.max(0.2, tpl.panel_opacity == null ? 1 : Number(tpl.panel_opacity))); // 패널 투명도(낮추면 뒤 워터마크 비침)
  const x0 = 36, y0 = 36, cardW = A4_W - 72, cardH = A4_H - 72;
  const { s: s0, ls } = tplScales(tpl);
  const showBody = tplShowBody(tpl);

  // 상단 포인트 바 (라운드 모서리에 맞게 클립) → 테두리를 그 위에 그려 한 줄로 깔끔하게
  doc.save();
  doc.roundedRect(x0, y0, cardW, cardH, 14).clip();
  doc.fillColor(accent).rect(x0, y0, cardW, 7).fill();
  doc.restore();
  doc.save();
  doc.lineWidth(1.2).strokeColor(accent).roundedRect(x0, y0, cardW, cardH, 14).stroke();
  doc.restore();

  // ----- 로고 (좌/우 상단, 포인트 바 아래 카드 안쪽) -----
  const logoSize = Math.round(50 * ls), logoTop = 58;
  const lLogo = imageFile(tpl.logo_left_path);
  if (lLogo) { try { doc.image(lLogo, x0 + 30, logoTop, { fit: [logoSize, logoSize], align: 'center', valign: 'center' }); } catch (_) {} }
  const rLogo = imageFile(tpl.logo_right_path);
  if (rLogo) { try { doc.image(rLogo, x0 + cardW - 30 - logoSize, logoTop, { fit: [logoSize, logoSize], align: 'center', valign: 'center' }); } catch (_) {} }

  // ----- 내용 준비 -----
  const name = data.athlete_name || '';
  const proveTpl = tpl.body_template || '위 선수는 본 대회에 출전하여 아래와 같은 기록을 수립하였음을 이에 증명합니다.';
  const proveText = showBody ? fillTemplate(proveTpl, {
    athlete_name: name, team: data.team || '', event_name: data.event_name || '',
    competition_name: data.competition_name || '', date: data.date || todayKR(),
    rank_label: '', record_value: data.record_value || '',
  }) : '';
  const mark = String(data.record_value || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  const windNum = (data.wind != null && data.wind !== '' && isFinite(Number(data.wind))) ? Number(data.wind) : null;
  const panelRows = [['종목', data.event_name || '-'], ['기록', mark || '-']];
  if (data.heat_number != null && data.heat_number !== '') panelRows.push(['조', `${data.heat_number}조`]);
  if (windNum != null) panelRows.push(['풍속', `${windNum > 0 ? '+' : ''}${windNum.toFixed(1)} m/s`]);
  const genderLabel = data.gender === 'M' ? '남자' : data.gender === 'F' ? '여자' : data.gender === 'X' ? '혼성' : '';
  const subParts = [];
  if (genderLabel) subParts.push(genderLabel);
  if (data.division) subParts.push(data.division);
  if (data.team) subParts.push(data.team);
  if (data.bib_number != null && data.bib_number !== '') subParts.push(`배번 ${data.bib_number}`);
  const sub = subParts.join('   ·   ');
  const showDate = !(tpl.show_date === 0 || tpl.show_date === '0');
  const dateStr = data.date || todayKR();
  const lines = signerLines(tpl, '');
  const sealPath = lines.some(l => l.withSeal) ? imageFile(tpl.seal_image_path) : null;
  const title = (tpl.title_text && tpl.title_text !== '상  장') ? tpl.title_text : '기 록 증';
  const confirmText = '위에 기재된 내용이 틀림없음을 확인합니다.';

  // ----- 치수: 배율 s 에서 블록 안 상대 위치(제목 = 0)와 전체 높이를 잰다 -----
  //   제목 0 · 대회명 54 · 구분선 88 · 이름 120 · 메타 160 · 증명 문구 200 → 기록 패널 → 확인 문구 → 날짜 → 발급자
  //   글자는 s 배, 세로 간격은 g = 1 + (s-1)×0.5 배 (간격까지 똑같이 키우면 1.3 배에서 한 장에 안 들어간다)
  const layout = (s) => {
    const g = 1 + (s - 1) * 0.5;
    const proveOpts = { width: A4_W - 160, align: 'center', lineGap: 7 * g };
    doc.font('R').fontSize(14 * s);
    const proveH = showBody ? doc.heightOfString(proveText, proveOpts) : 0;   // text() 가 doc.y 를 올리는 셈과 같다(줄 높이+lineGap × 줄 수)
    const pw = Math.min(cardW - 60, 380 * s), px = (A4_W - pw) / 2, rowH = 40 * g, padV = 16 * g;
    const panelH = panelRows.length * rowH + padV;
    const panelRel = showBody ? 200 * g + proveH + 40 * g : 160 * g + 48 * g;
    const confirmRel = panelRel + panelH + 34 * g;
    const dateRel = confirmRel + 72 * g;
    const signerRel = dateRel + (showDate ? 48 * g : 0);
    let blockEnd = confirmRel + 13 * s * 1.3;
    if (showDate) blockEnd = dateRel + 14 * s * 1.3;
    if (lines.length) {
      const lastY = signerRel + (lines.length - 1) * 30 * g;
      blockEnd = Math.max(lastY + 18 * s * 1.3, sealPath ? lastY + 34 * s : 0);
    }
    return { s, g, proveOpts, proveH, pw, px, rowH, padV, panelH, panelRel, confirmRel, dateRel, signerRel, blockEnd };
  };
  const minTop = y0 + 56;              // 예전 제목 위치(92) — 포인트 바·로고 줄 아래로는 못 올라간다
  const maxBottom = y0 + cardH - 20;   // 카드 하단 최소 여백
  let L = layout(s0);
  for (let i = 0; i < 8 && L.s > 1 && minTop + L.blockEnd > maxBottom; i++) L = layout(Math.max(1, L.s - 0.05));   // 카드에 안 들어가면 배율을 조금씩 줄인다
  const s = L.s;
  // 로고 줄 아래 ~ 카드 하단 사이의 세로 가운데 (로고가 없으면 포인트 바 아래부터). 로고가 클수록 내용이 그만큼 내려간다.
  const regionTop = (lLogo || rLogo) ? logoTop + logoSize + 8 : y0 + 24;
  let top = regionTop + (maxBottom - regionTop - L.blockEnd) / 2;
  top = Math.max(minTop, Math.min(top, maxBottom - L.blockEnd));
  const { g, proveOpts, pw, px, rowH, padV, panelH } = L;
  const panelTop = top + L.panelRel;

  // ----- 기록 패널 바탕 (워터마크 '아래') -----
  //   예전엔 워터마크 → 패널 순서라 기본(불투명) 패널이 가운데 워터마크를 통째로 가렸다(2026-11-05 사용자 지적).
  //   이제 패널 바탕 → 워터마크 → 글자 순서 — 워터마크가 패널 안까지 비친다. panel_opacity 는 종이 바탕 비침용으로 남는다.
  doc.save();
  doc.lineWidth(1);
  doc.opacity(panelOpacity);
  doc.roundedRect(px, panelTop, pw, panelH, 12 * s).fillAndStroke(panelColor, '#e3ddcf');
  doc.restore();

  // ----- 워터마크 (패널 위 · 글자 아래, 옅게) -----
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
  doc.font('B').fontSize(38 * s).fillColor(textColor);
  const tw = doc.widthOfString(title);
  doc.text(title, (A4_W - tw) / 2, top, { lineBreak: false });

  // 대회명
  if (data.competition_name) {
    doc.font('R').fontSize(13 * s).fillColor(labelColor);
    const cw = doc.widthOfString(data.competition_name);
    doc.text(data.competition_name, (A4_W - cw) / 2, top + 54 * g, { lineBreak: false });
  }
  // 구분선
  doc.lineWidth(0.8).strokeColor(accent).moveTo(A4_W / 2 - 60 * s, top + 88 * g).lineTo(A4_W / 2 + 60 * s, top + 88 * g).stroke();

  // 이름
  doc.font('B').fontSize(28 * s).fillColor(textColor);
  const nw = doc.widthOfString(name);
  doc.text(name, (A4_W - nw) / 2, top + 120 * g, { lineBreak: false });

  // 성별 · 부별 · 소속 · 배번
  if (sub) {
    doc.font('R').fontSize(13 * s).fillColor(labelColor);
    const sw = doc.widthOfString(sub);
    doc.text(sub, (A4_W - sw) / 2, top + 160 * g, { lineBreak: false });
  }

  // 증명 문구 (show_body=0 이면 없음 — 패널이 그만큼 올라온다)
  if (showBody) {
    doc.font('R').fontSize(14 * s).fillColor(textColor);
    doc.text(proveText, 80, top + 200 * g, proveOpts);
  }

  // ----- 기록 패널 글자 (바탕은 위에서 워터마크보다 먼저 그렸다) -----
  let ry = panelTop + padV / 2;
  panelRows.forEach(([label, value], i) => {
    const cy = ry + rowH / 2;
    doc.font('R').fontSize(13 * s).fillColor(labelColor);
    doc.text(label, px + 28 * s, cy - 8 * s, { lineBreak: false });
    const isRec = (label === '기록');
    doc.font('B').fontSize((isRec ? 20 : 15) * s).fillColor(isRec ? accentColor : textColor);
    const vw = doc.widthOfString(value);
    doc.text(value, px + pw - 28 * s - vw, cy - (isRec ? 12 : 9) * s, { lineBreak: false });
    if (i < panelRows.length - 1) {
      doc.lineWidth(0.5).strokeColor('#ece7da').moveTo(px + 20, ry + rowH).lineTo(px + pw - 20, ry + rowH).stroke();
    }
    ry += rowH;
  });

  // 확인 문구
  const confirmY = top + L.confirmRel;
  doc.font('R').fontSize(13 * s).fillColor(textColor);
  const cfw = doc.widthOfString(confirmText);
  doc.text(confirmText, (A4_W - cfw) / 2, confirmY, { lineBreak: false });

  // 날짜
  if (showDate) {
    doc.font('R').fontSize(14 * s).fillColor(textColor);
    const dw = doc.widthOfString(dateStr);
    doc.text(dateStr, (A4_W - dw) / 2, top + L.dateRel, { lineBreak: false });
  }
  // 발급자 (단체 / 직책+이름 / 인장 — signer_inline=1 이면 한 줄)
  let by = top + L.signerRel;
  lines.forEach((ln) => {
    doc.font('B').fontSize(18 * s).fillColor(textColor);
    const lw = doc.widthOfString(ln.text);
    doc.text(ln.text, (A4_W - lw) / 2, by, { lineBreak: false });
    if (ln.withSeal && sealPath) { try { doc.image(sealPath, (A4_W + lw) / 2 + 8 * s, by - 10 * s, { fit: [44 * s, 44 * s] }); } catch (_) {} }
    by += 30 * g;
  });
}

function renderCertificatePage(doc, template, data) {
  const tpl = template || {};
  const kind = tpl.kind || 'award';
  // 조별 시상은 조 1위가 종목 우승이 아니므로 '우승/준우승' 대신 항상 'N위' 로 표기
  const rankStyle = (data.rank_scope === 'heat') ? 'numeric' : (tpl.rank_label_style || 'ordinal');
  const bgColor = tpl.background_color || '#fffdf6';
  const borderStyle = tpl.border_style || 'double-gold';
  const textColor = tpl.text_color || '#1a1a1a';    // 본문 글씨(제목·이름·본문·날짜·발급자)
  const labelColor = tpl.label_color || '#8a7f6a';  // 보조 글씨(대회명 부제)
  const accentColor = tpl.accent_color || '#7a3a00'; // 강조(종목·기록·인)
  const { s, ls } = tplScales(tpl);     // 글자·로고 배율 (2026-11-06)
  const showBody = tplShowBody(tpl);

  // 배경
  doc.save();
  doc.rect(0, 0, A4_W, A4_H).fill(bgColor);
  doc.restore();

  // ----- 워터마크 (중앙 로고 이미지, 옅게) -----
  // 배경 다음·본문 전에 그려 본문이 위로 오게 함. 이미지 없으면 생략.
  // 단, 기록증(record)은 renderRecordCard 가 기록 패널 바탕 위·글자 아래에 따로 그린다 (패널이 가리지 않게, 2026-11-05).
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

  // ----- 로고 (좌/우) — logo_scale 로 키우면 부제와 겹치지 않게 머리 부분을 그만큼 내린다 -----
  const logoTop = 70;
  const logoSize = Math.round(60 * ls);
  const headShift = Math.max(0, logoSize - 60) * 0.6;
  const lLogo = imageFile(tpl.logo_left_path);
  if (lLogo) { try { doc.image(lLogo, 80, logoTop, { fit: [logoSize, logoSize] }); } catch (_) {} }
  const rLogo = imageFile(tpl.logo_right_path);
  if (rLogo) { try { doc.image(rLogo, A4_W - 80 - logoSize, logoTop, { fit: [logoSize, logoSize] }); } catch (_) {} }

  // ----- 제목 (상  장 / 완 주 증) -----
  const titleText = tpl.title_text || (kind === 'finisher' ? '완 주 증' : kind === 'team' ? '단 체 상' : '상  장');
  doc.font('B').fontSize(54 * s).fillColor(textColor);
  const titleW = doc.widthOfString(titleText);
  doc.text(titleText, (A4_W - titleW) / 2, 95 + headShift, { lineBreak: false });

  // 부제 (대회명)
  if (data.competition_name) {
    doc.font('R').fontSize(14 * s).fillColor(labelColor);
    const subW = doc.widthOfString(data.competition_name);
    doc.text(data.competition_name, (A4_W - subW) / 2, 168 + headShift + 20 * (s - 1), { lineBreak: false });
  }

  // 구분선
  const divY = 200 + headShift + 26 * (s - 1);
  doc.lineWidth(0.8).strokeColor(tpl.border_color || '#b8945a')
     .moveTo(A4_W / 2 - 80, divY).lineTo(A4_W / 2 + 80, divY).stroke();

  // ----- 수상자 정보 (소속 / 이름) -----
  let cursorY = divY + 30;
  const athleteName = data.athlete_name || '';
  const team = data.team || '';

  if (tpl.show_athlete_team !== 0 && team) {
    doc.font('R').fontSize(16 * s).fillColor(textColor);
    const teamW = doc.widthOfString(team);
    doc.text(team, (A4_W - teamW) / 2, cursorY, { lineBreak: false });
    cursorY += 30 * s;
  }

  doc.font('B').fontSize(32 * s).fillColor(textColor);
  const nameW = doc.widthOfString(athleteName);
  doc.text(athleteName, (A4_W - nameW) / 2, cursorY, { lineBreak: false });
  cursorY += 56 * s;

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

  let infoY = cursorY;
  if (showBody) {   // show_body=0 이면 본문 없이 종목·기록으로 바로 (2026-11-06)
    doc.font('R').fontSize(17 * s).fillColor(textColor);
    doc.text(bodyText, 90, cursorY, {
      width: A4_W - 180,
      align: 'center',
      lineGap: 8 * s,
    });
    infoY = doc.y + 14 * s;
  }

  // 종목 / 기록 (본문과 별개로 항상 표시)
  if (vars.event_name) {
    doc.font('B').fontSize(20 * s).fillColor(accentColor);
    // 조가 여러 개인 종목은 '종목 : 800m (3조)' 처럼 몇조인지 함께 표기
    const heatSuffix = (data.heat_number != null && data.heat_number !== '') ? ` (${data.heat_number}조)` : '';
    const evText = `종목 : ${vars.event_name}${heatSuffix}`;
    const evW = doc.widthOfString(evText);
    doc.text(evText, (A4_W - evW) / 2, infoY, { lineBreak: false });
    infoY += 30 * s;
  }
  if (vars.record_value) {
    doc.font('B').fontSize(20 * s).fillColor(accentColor);
    const recText = `기록 : ${vars.record_value}`;
    const recW = doc.widthOfString(recText);
    doc.text(recText, (A4_W - recW) / 2, infoY, { lineBreak: false });
    infoY += 30 * s;
  }

  // ----- 날짜 -----
  const dateY = A4_H - 230;
  if (tpl.show_date !== 0) {
    doc.font('R').fontSize(16 * s).fillColor(textColor);
    const dateStr = vars.date;
    const dateW = doc.widthOfString(dateStr);
    doc.text(dateStr, (A4_W - dateW) / 2, dateY, { lineBreak: false });
  }

  // ----- 발급자 (단체명 / 직책 + 이름 / 인장 — signer_inline=1 이면 '단체명  직책  이름' 한 줄) -----
  const signerY = A4_H - 170;
  const sLines = signerLines(tpl, '회장');
  sLines.forEach((ln, i) => {
    doc.font('B').fontSize(20 * s).fillColor(textColor);
    const lineW = doc.widthOfString(ln.text);
    // 두 줄이면 단체명 signerY · 이름 줄 +32, 한 줄이면 그 사이(+16)
    const lineY = sLines.length === 1 ? signerY + 16 : signerY + i * 32 * s;
    doc.text(ln.text, (A4_W - lineW) / 2, lineY, { lineBreak: false });
    if (!ln.withSeal) return;
    // 인장 (이름 옆)
    const sealPath = imageFile(tpl.seal_image_path);
    if (sealPath) {
      const sealSize = 50 * s;
      try {
        doc.image(sealPath,
          (A4_W + lineW) / 2 + 8, lineY - 8 * s,
          { fit: [sealSize, sealSize] });
      } catch (_) {}
    } else {
      // 인장 없으면 "(인)" 표시
      doc.font('R').fontSize(14 * s).fillColor(accentColor);
      doc.text('(인)', (A4_W + lineW) / 2 + 10, lineY + 4 * s, { lineBreak: false });
    }
  });
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
