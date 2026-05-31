/**
 * Full Record PDF Generator — Excel→PDF Converter
 * Generates the Excel workbook first (reusing fullRecordExcel.js),
 * then renders each worksheet cell-by-cell to PDF using PDFKit.
 * This guarantees the PDF layout matches the Excel output exactly.
 */
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const { generateFullRecordExcel } = require('./fullRecordExcel');

// ---- Fonts ----
const FONT_R = path.join(__dirname, '..', 'public', 'fonts', 'NanumSquare_acR.ttf');
const FONT_B = path.join(__dirname, '..', 'public', 'fonts', 'NanumSquare_acB.ttf');

// A4 dimensions in points (1pt = 1/72 inch)
const A4_W = 595.28;  // 210mm
const A4_H = 841.89;  // 297mm

module.exports = { generateFullRecordPdf };

/**
 * Convert ExcelJS ARGB color (e.g. "FF262324" or "FFFFF9C4") to hex "#rrggbb"
 */
function argbToHex(argb) {
  if (!argb || typeof argb !== 'string') return null;
  // Remove alpha channel (first 2 chars if 8-char ARGB)
  const hex = argb.length === 8 ? argb.slice(2) : argb;
  if (hex.length !== 6) return null;
  return '#' + hex;
}

/**
 * Get fill color from ExcelJS cell
 */
function getCellFillColor(cell) {
  const fill = cell.fill;
  if (!fill) return null;
  if (fill.type === 'pattern' && fill.pattern === 'solid') {
    return argbToHex(fill.fgColor?.argb) || argbToHex(fill.bgColor?.argb) || null;
  }
  return argbToHex(fill.fgColor?.argb) || null;
}

/**
 * Get font color from ExcelJS cell
 */
function getCellFontColor(cell) {
  return argbToHex(cell.font?.color?.argb) || '#000000';
}

/**
 * Check if a color is dark (for deciding text contrast)
 */
function isDarkColor(hex) {
  if (!hex) return false;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (r * 0.299 + g * 0.587 + b * 0.114) < 128;
}

/**
 * Convert ExcelJS column width units to points for PDF rendering.
 * ExcelJS width ≈ character widths; we map to physical points.
 * A4 portrait printable width ≈ 545pt (with 25pt margins).
 * A4 landscape printable width ≈ 792pt (with 25pt margins).
 */
function colWidthToPoints(excelWidth, totalExcelWidth, pageContentWidth) {
  if (!excelWidth || totalExcelWidth <= 0) return 10;
  return (excelWidth / totalExcelWidth) * pageContentWidth;
}

async function generateFullRecordPdf(db, comp, gender) {
  // Step 1: Generate the Excel workbook using the existing generator
  // We need the getDocTemplate function
  function getDocTemplate(compId) {
    try {
      const row = db.prepare('SELECT * FROM doc_template WHERE competition_id=?').get(compId);
      if (!row) return null;
      try {
        const templates = JSON.parse(row.templates || '{}');
        return templates;
      } catch (e) {
        return null;
      }
    } catch (e) { return null; }
  }

  const wb = await generateFullRecordExcel(db, comp, gender, getDocTemplate);

  // Step 2: Create PDF document
  const doc = new PDFDocument({ autoFirstPage: false, bufferPages: true });
  const chunks = [];
  doc.on('data', c => chunks.push(c));

  // Register fonts
  doc.registerFont('NanumR', FONT_R);
  doc.registerFont('NanumB', FONT_B);

  // Step 3: Render each worksheet to PDF
  for (const ws of wb.worksheets) {
    const isLandscape = ws.pageSetup?.orientation === 'landscape';
    const pageW = isLandscape ? A4_H : A4_W;
    const pageH = isLandscape ? A4_W : A4_H;
    const margin = isLandscape ? 15 : 18;
    const contentW = pageW - margin * 2;
    const contentH = pageH - margin * 2;

    // Calculate total Excel column width
    let totalExcelW = 0;
    const colWidths = [];
    for (let c = 1; c <= (ws.columnCount || 1); c++) {
      const col = ws.getColumn(c);
      const w = col.width || ws.properties?.defaultColWidth || 8;
      colWidths.push(w);
      totalExcelW += w;
    }

    // Convert to PDF points — stretch to fill full content width
    const colPts = colWidths.map(w => colWidthToPoints(w, totalExcelW, contentW));

    // Cumulative X offsets for column boundaries (margin + sum of preceding col widths)
    // Used both for cell rendering AND for placing images at their Excel column positions.
    const colX = [margin];
    for (let i = 0; i < colPts.length; i++) colX.push(colX[i] + colPts[i]);

    // 🛠️ 이미지(로고) 사전 수집 — Excel 의 ws.getImages() 를 PDF 의 첫 페이지 상단에 그림.
    // ExcelJS 의 image range.tl.{col,row} 는 0-based, ext.{width,height} 는 EMU(1px = 9525 EMU)
    // 가 아닌 픽셀 단위. 우리는 cell 좌표(1-based) 기준 X 위치만 잡고 row 높이는 첫 행 (header)
    // 으로 고정. (Excel→PDF 의 1:1 픽셀 변환은 비현실적이므로 시각적 일치를 우선)
    const wsImages = (typeof ws.getImages === 'function') ? (ws.getImages() || []) : [];
    const pdfImages = [];
    for (const img of wsImages) {
      try {
        // ExcelJS 의 media 는 imageId 인덱스 기준으로 배열에 저장됨 (index 필드는 보통 없음).
        // 메모리 buffer 가 없으면 filename 으로 디스크에서 직접 읽어옴.
        const media = (wb.media && wb.media[img.imageId])
          || (wb.model?.media && wb.model.media[img.imageId])
          || (wb.model?.media || []).find(m => m.index === img.imageId);
        if (!media) continue;
        let buffer = media.buffer;
        if (!buffer && media.filename) {
          try { buffer = fs.readFileSync(media.filename); } catch(e) { /* skip */ }
        }
        if (!buffer) continue;
        // range.tl: 0-based col/row
        const tlCol0 = Math.floor(img.range?.tl?.nativeCol ?? img.range?.tl?.col ?? 0);
        const tlRow0 = Math.floor(img.range?.tl?.nativeRow ?? img.range?.tl?.row ?? 0);
        // ext: pixel size (Excel pixels @96dpi); convert to PDF points (1pt = 96/72 px ≈ 1.333)
        const extW = img.range?.ext?.width || 110;
        const extH = img.range?.ext?.height || 40;
        const ptW = extW * 72 / 96;
        const ptH = extH * 72 / 96;
        pdfImages.push({
          buffer, tlCol: tlCol0 + 1, tlRow: tlRow0 + 1, ptW, ptH
        });
      } catch(e) { /* skip broken image */ }
    }

    // Start first page for this sheet
    doc.addPage({
      size: 'A4',
      layout: isLandscape ? 'landscape' : 'portrait',
      margin: margin
    });

    let y = margin;

    // 헤더 영역 row 높이 합계를 미리 계산해서 로고 Y 좌표를 잡는 데 사용 (이미지가 row 1~3 에
    // 위치할 경우 해당 row 들의 y 범위 내에 정확하게 그려야 함)
    function _yForRow(rNum) {
      let yy = margin;
      for (let rr = 1; rr < rNum; rr++) {
        const row = ws.getRow(rr);
        const rh = (row.height && row.height > 0) ? row.height : 14;
        yy += rh;
      }
      return yy;
    }
    function _drawHeaderImages() {
      for (const im of pdfImages) {
        // 헤더 이미지(첫 5 행 이내 = 표 상단 로고 영역) 만 첫 페이지 상단에 그림.
        // 그 외 이미지(데이터 영역 임베드 등)는 무시 — 종합기록지에는 헤더 로고만 의미 있음.
        if (im.tlRow > 5) continue;
        try {
          const x = colX[im.tlCol - 1] ?? margin;
          const yPos = _yForRow(im.tlRow);
          doc.image(im.buffer, x + 1, yPos + 1, { width: im.ptW, height: im.ptH });
        } catch(e) { /* PDFKit 가 이미지 포맷을 못 읽으면 skip */ }
      }
    }

    // Track merged cells
    const merges = [];
    ws.model?.merges?.forEach(m => {
      // m is like "A1:F1" or "B1:E1"
      merges.push(m);
    });

    // Parse merge ranges into a lookup
    const mergedCells = new Map(); // "row,col" -> { startRow, startCol, endRow, endCol }
    const mergedSkip = new Set(); // cells that are covered by a merge but not the top-left
    for (const m of merges) {
      const parts = m.split(':');
      if (parts.length !== 2) continue;
      const s = parseCellRef(parts[0]);
      const e = parseCellRef(parts[1]);
      if (!s || !e) continue;
      mergedCells.set(`${s.row},${s.col}`, { startRow: s.row, startCol: s.col, endRow: e.row, endCol: e.col });
      for (let r = s.row; r <= e.row; r++) {
        for (let c = s.col; c <= e.col; c++) {
          if (r !== s.row || c !== s.col) {
            mergedSkip.add(`${r},${c}`);
          }
        }
      }
    }

    // Render rows
    for (let r = 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      // Row height: ExcelJS row.height is in points
      // If undefined, use a sensible default that matches print quality
      let rowH = row.height;
      const hasExplicitHeight = rowH && rowH > 0;
      if (!hasExplicitHeight) {
        // Estimate from font size of first non-empty cell in row
        let maxFontSize = 8;
        for (let c = 1; c <= colWidths.length; c++) {
          const cell = row.getCell(c);
          if (cell.value) maxFontSize = Math.max(maxFontSize, cell.font?.size || 8);
        }
        rowH = maxFontSize * 1.8 + 2; // comfortable line height
      }
      if (rowH < 10) rowH = 10;

      // For cells with multiline content (e.g. relay member lists),
      // only expand row height when Excel did NOT set an explicit height.
      // When Excel sets an explicit height, respect it and let text clip naturally,
      // matching the printed Excel behavior (summary sheet NM notes, etc.)
      if (!hasExplicitHeight) {
        let maxTextH = rowH;
        for (let c = 1; c <= colWidths.length; c++) {
          const key = `${r},${c}`;
          if (mergedSkip.has(key)) continue;
          const cell = row.getCell(c);
          if (!cell.value) continue;
          let value = '';
          if (typeof cell.value === 'object' && cell.value.richText) {
            value = cell.value.richText.map(rt => rt.text).join('');
          } else {
            value = String(cell.value);
          }
          if (!value || !value.includes('\n')) continue; // only check multiline
          const fontSize = Math.min(cell.font?.size || 8, 13);
          const font = cell.font?.bold ? 'NanumB' : 'NanumR';
          let cellW = colPts[c - 1];
          const merge = mergedCells.get(key);
          if (merge) {
            cellW = 0;
            for (let mc = merge.startCol; mc <= merge.endCol; mc++) {
              cellW += colPts[mc - 1] || 0;
            }
          }
          doc.font(font).fontSize(fontSize);
          const neededH = doc.heightOfString(value, { width: Math.max(cellW - 4, 10) }) + 4;
          if (neededH > maxTextH) maxTextH = neededH;
        }
        rowH = maxTextH;
      }

      // Check if we need a new page
      if (y + rowH > pageH - margin) {
        doc.addPage({
          size: 'A4',
          layout: isLandscape ? 'landscape' : 'portrait',
          margin: margin
        });
        y = margin;
      }

      let x = margin;
      for (let c = 1; c <= colWidths.length; c++) {
        const key = `${r},${c}`;

        // Skip cells covered by merges — but still advance x past this column!
        // The merge-start cell drew over its OWN single column width (we advance x by that),
        // and the merge-continuation cells must also advance x so following non-merged cells
        // are positioned in their correct columns.
        // ⚠️ Previously we used `continue` without advancing x, which caused all subsequent
        //    cells in the row to be shifted left into the merged area (e.g. wind values in
        //    종합 시트 were rendered on top of 종목명 column).
        if (mergedSkip.has(key)) {
          x += colPts[c - 1] || 0;
          continue;
        }

        const cell = row.getCell(c);
        let cellW = colPts[c - 1];
        let cellH = rowH;
        // Always advance x by the single column width so per-column alignment is preserved.
        // Merge-continuation cells (in mergedSkip) above already advance the same way,
        // so each row has identical column boundaries.
        let xAdvance = colPts[c - 1] || 0;

        // Handle merged cells (start cell)
        const merge = mergedCells.get(key);
        if (merge) {
          // Calculate total width of merged columns — used ONLY for drawing
          // background/border/text. The x cursor still advances by a single column.
          cellW = 0;
          for (let mc = merge.startCol; mc <= merge.endCol; mc++) {
            cellW += colPts[mc - 1] || 0;
          }
          // Calculate total height of merged rows
          if (merge.endRow > merge.startRow) {
            cellH = 0;
            for (let mr = merge.startRow; mr <= merge.endRow; mr++) {
              const mrow = ws.getRow(mr);
              cellH += mrow.height || 15;
            }
          }
        }

        // Get cell value
        let value = '';
        if (cell.value !== null && cell.value !== undefined) {
          if (typeof cell.value === 'object' && cell.value.richText) {
            value = cell.value.richText.map(rt => rt.text).join('');
          } else {
            value = String(cell.value);
          }
        }

        // Get styles
        const fillColor = getCellFillColor(cell);
        const fontColor = getCellFontColor(cell);
        const isBold = cell.font?.bold || false;
        const fontSize = cell.font?.size || 8;
        const alignment = cell.alignment || {};
        const hAlign = alignment.horizontal || 'center';

        // Draw cell background
        if (fillColor && fillColor !== '#FFFFFF' && fillColor !== '#ffffff') {
          doc.save().rect(x, y, cellW, cellH).fill(fillColor).restore();
        }

        // Draw cell border (thin lines)
        doc.save()
          .lineWidth(0.3)
          .strokeColor('#CCCCCC')
          .rect(x, y, cellW, cellH)
          .stroke()
          .restore();

        // Draw text
        if (value) {
          const pdfFontSize = Math.min(fontSize, 13); // Use actual font size
          const font = isBold ? 'NanumB' : 'NanumR';
          let textColor = fontColor;
          // If dark background, use white text
          if (fillColor && isDarkColor(fillColor)) {
            textColor = '#FFFFFF';
          }

          doc.save()
            .font(font)
            .fontSize(pdfFontSize)
            .fillColor(textColor);

          // Calculate text position
          const textW = cellW - 4;
          const textH = doc.heightOfString(value, { width: textW, align: hAlign });
          let ty = y + Math.max(1, (cellH - textH) / 2);

          // Clip to cell bounds
          doc.save();
          doc.rect(x, y, cellW, cellH).clip();
          doc.text(value, x + 2, ty, {
            width: textW,
            align: hAlign,
            lineGap: 0
          });
          doc.restore();

          doc.restore();
        }

        x += xAdvance;
      }

      y += rowH;

      // 🛠️ 헤더 row (1~3) 가 모두 그려진 후 로고 이미지를 그 위에 overlay.
      // Excel 의 row 1 은 보통 fill 색상이 있어 이미지가 가려질 수 있으므로
      // 셀 그리기 다음에 그려서 로고가 위에 보이도록 함.
      if (r === 3 && pdfImages.length > 0) {
        _drawHeaderImages();
      }
    }
  }

  // Finalize
  doc.end();
  return new Promise(resolve => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

/**
 * Parse Excel cell reference (e.g. "A1", "AB23") to {row, col}
 */
function parseCellRef(ref) {
  const match = ref.match(/^([A-Z]+)(\d+)$/);
  if (!match) return null;
  const letters = match[1];
  const row = parseInt(match[2]);
  let col = 0;
  for (let i = 0; i < letters.length; i++) {
    col = col * 26 + (letters.charCodeAt(i) - 64);
  }
  return { row, col };
}
