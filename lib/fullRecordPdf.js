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

    // Start first page for this sheet
    doc.addPage({
      size: 'A4',
      layout: isLandscape ? 'landscape' : 'portrait',
      margin: margin
    });

    let y = margin;

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
