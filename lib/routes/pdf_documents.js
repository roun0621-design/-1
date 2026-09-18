'use strict';
/**
 * PDF 문서 — 스타트리스트 · 결과지(+PNG) · ID카드(AD카드) — server.js 에서 추출 (2026-09 Phase 4)
 *   GET /api/documents/start-list/:eventId · /api/documents/result-sheet/:eventId[/png] · /api/documents/ad-card/:compId
 *   글꼴·표 그리기·머리글/바닥글 헬퍼 포함. 양식은 deps.getDocTemplate (doc_template).
 *   ※ 동작은 인라인 시절과 동일 — 회귀: tests/api/12_documents, tests/flows/02_documents_ranking, 06_ad_card_barcode
 */
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { createCanvas } = require('canvas');
const { execSync } = require('child_process');
const code128 = require('../code128');

module.exports = function mountPdfDocumentRoutes(app, deps) {
    const { db, getDocTemplate, orderByBibSql, PORT } = deps;
    for (const [k, v] of Object.entries({ db, getDocTemplate, orderByBibSql })) {
        if (!v) throw new Error(`[pdf_documents] mount requires deps.${k}`);
    }

    // ============================================================
    // PDF DOCUMENT GENERATION — WA-Style Professional Layout
    // ============================================================
    // Bundled fonts — always available regardless of server OS
    const FONT_PATH_REGULAR = path.join(__dirname, '..', '..', 'public', 'fonts', 'NanumSquare_acR.ttf');
    const FONT_PATH_BOLD = path.join(__dirname, '..', '..', 'public', 'fonts', 'NanumSquare_acB.ttf');
    const FONT_PATH_AUDIOWIDE = path.join(__dirname, '..', '..', 'public', 'fonts', 'Audiowide-Regular.ttf');
    const FONT_AVAILABLE = fs.existsSync(FONT_PATH_REGULAR);
    const AUDIOWIDE_AVAILABLE = fs.existsSync(FONT_PATH_AUDIOWIDE);
    if (!FONT_AVAILABLE) console.warn('[WARN] Korean fonts not found at', FONT_PATH_REGULAR);
    if (!AUDIOWIDE_AVAILABLE) console.warn('[WARN] Audiowide font not found at', FONT_PATH_AUDIOWIDE);

    function pdfFont(doc, bold) {
        if (FONT_AVAILABLE) {
            doc.font(bold ? FONT_PATH_BOLD : FONT_PATH_REGULAR);
        }
        return doc;
    }

    // PACE RISE theme colors
    const PR_GREEN = '#2d9d78';
    const PR_GREEN_DARK = '#1e7a5c';
    const PR_GREEN_LIGHT = '#e8f5f0';
    const PR_HEADER_BG = '#2d9d78';
    const PR_TABLE_HEADER_BG = '#2d9d78';
    const PR_TABLE_BORDER = '#d0d0d0';

    // Helper: Draw page header with logos, competition name, and venue/dates
    function drawPdfHeader(doc, comp, tpl, pageW, margin) {
        // querystring(?v=...) 을 제거해 실제 파일 경로만 사용 (DB 에 캐시버스터 URL 이 저장돼 있을 수 있음)
        const stripQs = (u) => (u || '').split('?')[0];
        const logoLeft = stripQs(tpl.logo_left);
        const logoRight = stripQs(tpl.logo_right);
        const headerTop = margin;
        const logoMaxH = 50;
        const logoMaxW = 65;
        const centerX = pageW / 2;

        // Left logo
        if (logoLeft) {
            try {
                const lPath = path.join(__dirname, '..', '..', 'public', logoLeft);
                if (fs.existsSync(lPath)) {
                    doc.image(lPath, margin, headerTop, { fit: [logoMaxW, logoMaxH], align: 'center', valign: 'center' });
                }
            } catch(e) { console.error('[PDF] Logo error:', e.message); }
        }

        // Right logo
        if (logoRight) {
            try {
                const rPath = path.join(__dirname, '..', '..', 'public', logoRight);
                if (fs.existsSync(rPath)) {
                    doc.image(rPath, pageW - margin - logoMaxW, headerTop, { fit: [logoMaxW, logoMaxH], align: 'center', valign: 'center' });
                }
            } catch(e) {}
        }

        // Competition name (center)
        const textLeft = margin + (logoLeft ? logoMaxW + 10 : 0);
        const textRight = pageW - margin - (logoRight ? logoMaxW + 10 : 0);
        const textW = textRight - textLeft;

        pdfFont(doc, true).fontSize(14).fillColor('#000');
        doc.text(comp ? comp.name : 'PACE RISE Competition', textLeft, headerTop + 4, { width: textW, align: 'center' });

        // Venue
        if (comp && comp.venue) {
            pdfFont(doc, false).fontSize(9).fillColor('#333');
            doc.text(comp.venue, textLeft, headerTop + 24, { width: textW, align: 'center' });
        }

        // Dates
        if (comp) {
            pdfFont(doc, false).fontSize(9).fillColor('#333');
            const dateStr = comp.end_date && comp.end_date !== comp.start_date
                ? `${comp.start_date} ~ ${comp.end_date}` : (comp.start_date || '');
            doc.text(dateStr, textLeft, headerTop + 38, { width: textW, align: 'center' });
        }

        return headerTop + Math.max(logoMaxH, 52) + 8; // return Y after header
    }

    // Helper: Draw WA-style table with green header
    function drawTableHeader(doc, cols, y, tableLeft, tableRight, fontSize) {
        const rowH = Math.max(22, fontSize + 12);
        // Green header background
        doc.save();
        doc.rect(tableLeft, y, tableRight - tableLeft, rowH).fill(PR_TABLE_HEADER_BG);
        // Header text
        pdfFont(doc, true).fontSize(fontSize).fillColor('#fff');
        for (const col of cols) {
            doc.text(col.label, col.x, y + (rowH - fontSize) / 2, { width: col.w, align: 'center' });
        }
        // Header borders
        doc.rect(tableLeft, y, tableRight - tableLeft, rowH).stroke(PR_GREEN_DARK);
        doc.restore();
        return y + rowH;
    }

    // Helper: Draw a table data row with borders
    function drawTableRow(doc, cols, values, y, tableLeft, tableRight, fontSize, opts = {}) {
        const {
            boldCols = [],
            highlight = false,
            // wrapCols: 자동 줄바꿈을 허용하고 행높이를 콘텐츠에 맞춰 늘릴 컬럼 key 배열.
            //           기본값 빈 배열 → 기존 동작(고정 높이) 그대로 유지 (하위 호환).
            wrapCols = [],
            // alignByCol: 컬럼별 정렬 override. { remark: 'left', ... } 형식.
            alignByCol = {},
            // minRowH: 최소 행 높이 (override). 기본 = Math.max(20, fontSize + 10)
            minRowH = null,
            // smallFontCols: 특정 컬럼을 더 작은 폰트로 그리고 싶을 때 (예: 단체전 멤버 리스트)
            //                { remark: 7 } 형식 — 값이 폰트 크기. 미지정 컬럼은 fontSize 사용.
            smallFontCols = {}
        } = opts;

        const baseRowH = minRowH != null ? minRowH : Math.max(20, fontSize + 10);

        // ─── 1) wrapCols 가 지정된 경우 콘텐츠에 따라 행 높이 계산 ───
        // ⚠️ 중요: heightOfString 측정 옵션과 doc.text 그리기 옵션을 100% 동일하게 맞춰야
        //         마지막 줄이 잘리지 않음 (lineGap 등 누락 주의).
        let rowH = baseRowH;
        if (wrapCols.length > 0) {
            for (let i = 0; i < cols.length; i++) {
                const col = cols[i];
                if (!wrapCols.includes(col.key)) continue;
                const val = String(values[i] || '');
                if (!val) continue;
                const colFontSize = smallFontCols[col.key] || fontSize;
                const isBold = boldCols.includes(col.key);
                pdfFont(doc, isBold).fontSize(colFontSize);
                try {
                    // measure 옵션 = draw 옵션 (lineGap 포함, ellipsis 등은 측정에 영향 없음)
                    const measured = doc.heightOfString(val, {
                        width: col.w - 4,
                        align: alignByCol[col.key] || 'center',
                        lineGap: 0.5
                    });
                    // 위/아래 6pt 패딩 + 안전 마진 4pt = 16pt (마지막 줄 descender 보호)
                    const needed = Math.ceil(measured) + 16;
                    if (needed > rowH) rowH = needed;
                } catch (_) { /* heightOfString 실패시 기본 높이 유지 */ }
            }
        }

        if (highlight) {
            doc.save();
            doc.rect(tableLeft, y, tableRight - tableLeft, rowH).fill(PR_GREEN_LIGHT);
            doc.restore();
        }

        // Row bottom border
        doc.save();
        doc.moveTo(tableLeft, y + rowH).lineTo(tableRight, y + rowH).lineWidth(0.5).stroke(PR_TABLE_BORDER);
        // Left/right borders
        doc.moveTo(tableLeft, y).lineTo(tableLeft, y + rowH).stroke(PR_TABLE_BORDER);
        doc.moveTo(tableRight, y).lineTo(tableRight, y + rowH).stroke(PR_TABLE_BORDER);
        doc.restore();

        // Cell text
        for (let i = 0; i < cols.length; i++) {
            const col = cols[i];
            const val = values[i] || '';
            const isBold = boldCols.includes(col.key);
            const colFontSize = smallFontCols[col.key] || fontSize;
            const align = alignByCol[col.key] || 'center';
            pdfFont(doc, isBold).fontSize(colFontSize).fillColor('#000');

            let textY;
            if (wrapCols.includes(col.key)) {
                // 줄바꿈 셀: 위쪽 6pt 패딩에서 시작.
                // ⚠️ height 옵션을 지정하지 않음 — rowH는 heightOfString 측정값+16pt 안전마진으로
                //   이미 충분하므로 height 제약을 주면 오히려 마지막 줄이 잘릴 수 있음.
                //   (열 너비 부족으로 PDFKit 이 자동 줄바꿈한 라인까지 모두 그려져야 함)
                textY = y + 6;
                doc.text(String(val), col.x + 2, textY, {
                    width: col.w - 4,
                    align: align,
                    ellipsis: false,
                    lineGap: 0.5
                });
            } else {
                // 단일 라인 셀: 기존처럼 세로 중앙 정렬 (단, 행높이가 늘어났을 수 있으므로 rowH 기준)
                textY = y + (rowH - colFontSize) / 2;
                doc.text(String(val), col.x + 2, textY, {
                    width: col.w - 4,
                    align: align,
                    lineBreak: false   // 단일 라인 — 줄바꿈 차단해서 다음 행과 겹침 방지
                });
            }
        }

        return y + rowH;
    }

    // Helper: Draw bottom branding footer (Audiowide font, 3 lines centered)
    function drawBrandingFooter(doc, pageW, pageH, margin) {
        const contentW = pageW - margin * 2;
        const lineGap = 2;
        const line1Size = 10;  // P-R : Node
        const line2Size = 7;   // PACE RISE | Competition Operating System |
        const line3Size = 7.5; // pace-rise-node.com
        const totalH = line1Size + line2Size + line3Size + lineGap * 2 + 6;
        const footerY = pageH - margin - totalH;

        // Line 1: "P-R : Node" (Audiowide)
        if (AUDIOWIDE_AVAILABLE) doc.font(FONT_PATH_AUDIOWIDE); else pdfFont(doc, true);
        doc.fontSize(line1Size).fillColor('#2d9d78');
        doc.text('P-R : Node', margin, footerY, { width: contentW, align: 'center' });

        // Line 2: "PACE RISE | Competition Operating System |" (Audiowide)
        const y2 = footerY + line1Size + lineGap;
        if (AUDIOWIDE_AVAILABLE) doc.font(FONT_PATH_AUDIOWIDE); else pdfFont(doc, false);
        doc.fontSize(line2Size).fillColor('#777');
        doc.text('PACE RISE  |  Competition Operating System  |', margin, y2, { width: contentW, align: 'center' });

        // Line 3: "pace-rise-node.com" (Audiowide)
        const y3 = y2 + line2Size + lineGap;
        if (AUDIOWIDE_AVAILABLE) doc.font(FONT_PATH_AUDIOWIDE); else pdfFont(doc, false);
        doc.fontSize(line3Size).fillColor('#2d9d78');
        doc.text('pace-rise-node.com', margin, y3, { width: contentW, align: 'center' });
    }

    // ==================== START LIST PDF ====================
    app.get('/api/documents/start-list/:eventId', async (req, res) => {
        const event = await db.get('SELECT * FROM event WHERE id=?', req.params.eventId);
        if (!event) return res.status(404).json({ error: 'Event not found' });
        const comp = await db.get('SELECT * FROM competition WHERE id=?', event.competition_id);
        const heats = await db.all('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number', event.id);
        const tpl = (await getDocTemplate(event.competition_id)).start_list;

        const pageW = 595.28; const pageH = 841.89; const margin = 40;
        const doc = new PDFDocument({ size: 'A4', margin, bufferPages: true });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Content-Disposition', `inline; filename="startlist_${event.id}_${event.gender}.pdf"`);
        doc.pipe(res);

        const gL = event.gender === 'M' ? 'Men' : event.gender === 'F' ? 'Women' : 'Mixed';
        const gK = event.gender === 'M' ? '남자' : event.gender === 'F' ? '여자' : '혼성';
        const roundL = { preliminary: 'Preliminary', semifinal: 'Semi-Final', final: 'Final' }[event.round_type] || event.round_type;
        const roundK = { preliminary: '예선', semifinal: '준결승', final: '결승' }[event.round_type] || event.round_type;
        const fontSize = tpl.font_size || 9;
        const teamLabel = tpl.team_label || 'Team';
        const teamLabelK = { Team: '소 속', School: '학 교', Club: '클 럽', Affiliation: '소 속' }[teamLabel] || '소 속';

        let curY = margin;

        // Header with logos
        if (tpl.show_header !== false) {
            curY = drawPdfHeader(doc, comp, tpl, pageW, margin);
        }

        // "START LIST" label (green)
        pdfFont(doc, true).fontSize(11).fillColor(PR_GREEN);
        doc.text('START LIST', margin, curY, { width: pageW - margin * 2 });
        curY += 16;

        // Event title
        pdfFont(doc, true).fontSize(12).fillColor('#000');
        doc.text(`${gK}  ${event.name}`, margin, curY);
        curY += 18;

        // Round bar
        const barH = 20;
        doc.save();
        doc.rect(margin, curY, 80, barH).fill('#1a1a1a');
        pdfFont(doc, true).fontSize(9).fillColor('#fff');
        doc.text(roundL, margin + 4, curY + 5, { width: 72, align: 'center' });
        doc.restore();
        pdfFont(doc, false).fontSize(9).fillColor('#333');
        doc.text(`${roundK}`, margin + 88, curY + 5);
        curY += barH + 10;

        // Build dynamic columns
        const tableLeft = margin;
        const tableRight = pageW - margin;
        const totalW = tableRight - tableLeft;
        const slCols = [];
        let xOff = tableLeft;
        if (tpl.show_lane !== false) { slCols.push({ key: 'lane', label: '레 인', x: xOff, w: totalW * 0.08 }); xOff += totalW * 0.08; }
        if (tpl.show_bib !== false) { slCols.push({ key: 'bib', label: '배 번', x: xOff, w: totalW * 0.10 }); xOff += totalW * 0.10; }
        if (tpl.show_name !== false) {
            const remainW = totalW - (xOff - tableLeft) - (tpl.show_team !== false ? totalW * 0.25 : 0) - (tpl.show_status !== false ? totalW * 0.12 : 0) - (tpl.show_pb ? totalW * 0.12 : 0) - (tpl.show_dob ? totalW * 0.12 : 0);
            slCols.push({ key: 'name', label: '선 수 명', x: xOff, w: Math.max(remainW, totalW * 0.15) }); xOff += Math.max(remainW, totalW * 0.15);
        }
        if (tpl.show_team !== false) { slCols.push({ key: 'team', label: teamLabelK, x: xOff, w: totalW * 0.25 }); xOff += totalW * 0.25; }
        if (tpl.show_pb) { slCols.push({ key: 'pb', label: 'PB', x: xOff, w: totalW * 0.12 }); xOff += totalW * 0.12; }
        if (tpl.show_dob) { slCols.push({ key: 'dob', label: '생년월일', x: xOff, w: totalW * 0.12 }); xOff += totalW * 0.12; }
        if (tpl.show_status !== false) { slCols.push({ key: 'status', label: '출 석', x: xOff, w: totalW * 0.12 }); xOff += totalW * 0.12; }

        for (const heat of heats) {
            const entries = await db.all(`
                SELECT he.lane_number, he.sub_group, ee.status, a.name, a.bib_number, a.team, a.date_of_birth, a.personal_best
                FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id
                JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=?
                ORDER BY he.lane_number ASC, ${orderByBibSql('a.bib_number')}
            `, heat.id);

            // Check page break (use dynamic row height based on fontSize)
            const headerRowH = Math.max(22, fontSize + 12);
            const dataRowH = Math.max(20, fontSize + 10);
            const neededH = 30 + headerRowH + entries.length * dataRowH + 10;
            if (curY + neededH > pageH - margin - 30) {
                doc.addPage();
                curY = margin;
            }

            // Heat label
            const hLabel = heat.heat_name || `Heat ${heat.heat_number}`;
            pdfFont(doc, true).fontSize(10).fillColor('#000');
            doc.text(hLabel, margin, curY);
            if (heat.scoreboard_key) { pdfFont(doc, false).fontSize(7).fillColor('#888'); doc.text(heat.scoreboard_key, margin + 100, curY + 2); }
            curY += 16;

            // Table header
            curY = drawTableHeader(doc, slCols, curY, tableLeft, tableRight, fontSize);

            // Data rows
            for (const e of entries) {
                if (curY + dataRowH > pageH - margin - 30) {
                    doc.addPage(); curY = margin;
                    curY = drawTableHeader(doc, slCols, curY, tableLeft, tableRight, fontSize);
                }
                const vals = slCols.map(col => {
                    switch (col.key) {
                        case 'lane': return String(e.lane_number || '-');
                        case 'bib': return e.bib_number || '-';
                        case 'name': return e.name || '';
                        case 'team': return e.team || '';
                        case 'status': return { registered: 'Reg', checked_in: 'In', no_show: 'DNS' }[e.status] || e.status || '';
                        case 'pb': return e.personal_best || '';
                        case 'dob': return e.date_of_birth || '';
                        default: return '';
                    }
                });
                curY = drawTableRow(doc, slCols, vals, curY, tableLeft, tableRight, fontSize, { boldCols: ['name'] });
            }
            curY += 12;
        }

        // Branding footer
        drawBrandingFooter(doc, pageW, pageH, margin);
        doc.end();
    });

    // ==================== RESULT SHEET PDF ====================
    app.get('/api/documents/result-sheet/:eventId', async (req, res) => {
      try {
        const event = await db.get('SELECT * FROM event WHERE id=?', req.params.eventId);
        if (!event) return res.status(404).json({ error: 'Event not found' });
        const comp = await db.get('SELECT * FROM competition WHERE id=?', event.competition_id);
        const heats = await db.all('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number', event.id);
        const tpl = (await getDocTemplate(event.competition_id)).result_sheet;

        // ─── 종목별 실제 진행 날짜 조회 ─────────────────────────────────────
        // timetable.scheduled_date / day 에서 이 event 의 실제 날짜를 가져온다.
        // 우선순위:
        //   1) timetable.event_id 가 event.id 와 일치하는 row 의 scheduled_date
        //   2) timetable.event_ids JSON 배열에 event.id 가 포함된 row 의 scheduled_date
        //   3) timetable.day 와 comp.start_date 를 더해서 계산 (day 는 1-based)
        //   4) 매칭 없으면 fallback 으로 comp.start_date 사용
        // round_type 이 일치하는 row 를 우선 고른다 (예선/결승 같은 종목이 다른 날일 수 있음).
        let eventDateStr = '';
        try {
            const roundMap = { preliminary: '예선', semifinal: '준결승', final: '결승', heats: '예선' };
            const ttRound = roundMap[event.round_type] || event.round_type;
            // (1) event_id 직접 매칭 + round 일치 우선
            // 참고: SQLite 백엔드는 db.get 이 동기, PG 는 async. 두 케이스 모두에서 await 가 안전하게 동작.
            //       try-catch 만으로 에러 처리 (db.get(...).catch 패턴은 SQLite 에서 TypeError 발생).
            let ttRow = null;
            try {
                ttRow = await db.get(
                    `SELECT scheduled_date, day FROM timetable
                     WHERE competition_id=? AND event_id=? AND (round=? OR round IS NULL OR round='')
                     ORDER BY (round=?) DESC, day ASC, time ASC LIMIT 1`,
                    event.competition_id, event.id, ttRound, ttRound
                );
            } catch(_) { ttRow = null; }
            // (1b) round 무시하고 event_id 만 매칭
            if (!ttRow) {
                try {
                    ttRow = await db.get(
                        `SELECT scheduled_date, day FROM timetable
                         WHERE competition_id=? AND event_id=? ORDER BY day ASC, time ASC LIMIT 1`,
                        event.competition_id, event.id
                    );
                } catch(_) { ttRow = null; }
            }
            // (2) event_ids JSON 매칭 (혼성/공동 종목 대비)
            if (!ttRow) {
                let candidates = [];
                try {
                    candidates = await db.all(
                        `SELECT scheduled_date, day, event_ids FROM timetable
                         WHERE competition_id=? AND event_ids IS NOT NULL AND event_ids <> ''`,
                        event.competition_id
                    );
                } catch(_) { candidates = []; }
                for (const c of candidates) {
                    try {
                        const ids = JSON.parse(c.event_ids);
                        if (Array.isArray(ids) && ids.map(Number).includes(Number(event.id))) {
                            ttRow = c; break;
                        }
                    } catch(_) {}
                }
            }
            if (ttRow) {
                if (ttRow.scheduled_date) {
                    eventDateStr = ttRow.scheduled_date;
                } else if (ttRow.day && comp && comp.start_date) {
                    // day 가 1-based 라고 가정하고 comp.start_date 에 (day-1) 일 더하기
                    const d = new Date(comp.start_date + 'T00:00:00');
                    d.setDate(d.getDate() + (Number(ttRow.day) - 1));
                    eventDateStr = d.toISOString().slice(0, 10);
                }
            }
        } catch (e) {
            console.warn('[result-sheet PDF] event date lookup failed:', e.message);
        }
        // Fallback: 종목별 날짜 못 찾으면 comp.start_date 사용 (기존 동작 유지)
        if (!eventDateStr && comp) eventDateStr = comp.start_date || '';

        const pageW = 595.28; const pageH = 841.89; const margin = 40;
        const doc = new PDFDocument({ size: 'A4', margin, bufferPages: true });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Content-Disposition', `inline; filename="results_${event.id}_${event.gender}.pdf"`);
        doc.pipe(res);

        const gK = event.gender === 'M' ? '남자' : event.gender === 'F' ? '여자' : '혼성';
        const roundL = { preliminary: 'Preliminary', semifinal: 'Semi-Final', final: 'Final' }[event.round_type] || event.round_type;
        const fontSize = tpl.font_size || 9;
        const teamLabel = tpl.team_label || 'Team';
        const teamLabelK = { Team: '소 속 명', School: '학 교', Club: '클 럽', Affiliation: '소 속 명' }[teamLabel] || '소 속 명';

        const isFieldDist = event.category === 'field_distance';
        const isFieldHeight = event.category === 'field_height';
        const isField = isFieldDist || isFieldHeight;
        const isCombined = event.category === 'combined';
        const isTrack = event.category === 'track' || event.category === 'relay' || event.category === 'road';
        const tableLeft = margin;
        const tableRight = pageW - margin;
        const totalW = tableRight - tableLeft;

        // ============================================================
        // [PAGE-REPEAT] 종목 상단 헤더 + 하단 NR/DR/CR 박스를 매 페이지마다 반복
        //   - drawEventTopHeader: 대회 로고/제목 + OFFICIAL RESULT + 종목명 + Round/Date bar
        //   - drawEventBottomBox: legend + 서명 + NR/DR/CR 표
        //   - body 영역(heats) 그리는 동안 addPage 직후 curY 를 헤더 아래로 리셋
        //   - body 영역 끝 한계는 pageH - margin - BOTTOM_RESERVED 로 강제
        //   - PDF 종료 직전 bufferPages 로 전체 페이지 순회하며 헤더/하단 재그리기
        // ============================================================
        const drawEventTopHeader = (d) => {
            let y = margin;
            if (tpl.show_header !== false) {
                y = drawPdfHeader(d, comp, tpl, pageW, margin);
            }
            // "OFFICIAL RESULT" label
            pdfFont(d, true).fontSize(11).fillColor(PR_GREEN);
            d.text('OFFICIAL RESULT', margin, y, { width: pageW - margin * 2 });
            y += 16;
            // Event title
            pdfFont(d, true).fontSize(12).fillColor('#000');
            d.text(`${gK}  ${event.name}`, margin, y);
            y += 18;
            // Round / Date bar
            const barH = 22;
            d.save();
            d.rect(margin, y, 80, barH).fill('#1a1a1a');
            pdfFont(d, true).fontSize(9).fillColor('#fff');
            d.text(roundL, margin + 4, y + 6, { width: 72, align: 'center' });
            d.restore();
            pdfFont(d, false).fontSize(9).fillColor('#333');
            // 종목별 실제 진행 날짜 사용 (timetable.scheduled_date) — 대회 시작일이 아닌 종목 당일 표시
            d.text(eventDateStr || '', margin + 88, y + 6);
            d.save();
            d.moveTo(margin, y).lineTo(pageW - margin, y).lineWidth(0.5).stroke('#333');
            d.moveTo(margin, y + barH).lineTo(pageW - margin, y + barH).lineWidth(0.5).stroke('#333');
            d.restore();
            y += barH + 8;
            return y;
        };

        // 하단 NR/DR/CR + 서명 + legend 박스 데이터 (페이지 마다 반복 그리기 위해 미리 준비)
        // event_records 와 global event_record 에서 NR/DR/CR 로드
        const _loadRecordsData = async () => {
            const evtRecRow = await db.get('SELECT records FROM event_records WHERE event_id=?', event.id);
            let evtRec = {};
            if (evtRecRow) { try { evtRec = JSON.parse(evtRecRow.records || '{}'); } catch(e) {} }
            let normName = event.name.replace(/\s+/g, '').replace(/,/g, '').replace(/(\d)[×Xx](\d)/g, '$1x$2');
            const nameMap = { '110m허들':'110mH','100m허들':'100mH','400m허들':'400mH','3000m장애물':'3000mSC','10000m경보':'10000mW','십종경기':'10종경기','칠종경기':'7종경기','오종경기':'5종경기','펜타슬론':'5종경기','Pentathlon':'5종경기','4x100m릴레이':'4x100mR','4x400m릴레이':'4x400mR','혼성4x400mR':'MIXED 4x400mR','MIXED4x400mR':'MIXED 4x400mR','4x800m릴레이':'4x800mR','4x1500m릴레이':'4x1500mR' };
            normName = nameMap[normName] || normName;
            try {
                // 이 대회의 시리즈 컨텍스트 — CR(대회기록)은 반드시 '이 대회가 연결된 시리즈'의 기록만 사용해야 함.
                // (series_id 필터가 없으면 같은 종목의 다른 시리즈 CR 이 잘못 끌려옴)
                const _compRow = await db.get('SELECT series_id FROM competition WHERE id=?', event.competition_id);
                const _compSeriesId = _compRow ? _compRow.series_id : null;
                const globalRecs = await db.all('SELECT * FROM event_record WHERE gender=? AND event_name=?', event.gender, normName);
                for (const gr of globalRecs) {
                    const keyMap = { national: 'nr', division: 'dr', competition: 'cr' };
                    const shortKey = keyMap[gr.record_type];
                    if (!shortKey) continue;
                    // 시리즈/부 컨텍스트 필터 (다른 시리즈·잘못된 행 혼입 방지)
                    if (gr.record_type === 'national') {
                        if (gr.series_id != null || gr.division_code != null) continue; // NR = 전국(시리즈/부 없음)
                    } else if (gr.record_type === 'division') {
                        if (gr.series_id != null) continue; // DR 은 시리즈 기록이 아님
                    } else if (gr.record_type === 'competition') {
                        // CR = 이 대회가 연결된 시리즈의 기록만 (다른 시리즈 배제). 시리즈 미연결이면 CR 없음.
                        if (_compSeriesId == null || gr.series_id !== _compSeriesId) continue;
                    }
                    if (!evtRec[shortKey] || !evtRec[shortKey].record) {
                        evtRec[shortKey] = { label: gr.record_type === 'national' ? '한국기록(NR)' : gr.record_type === 'division' ? '부별기록(DR)' : '대회기록(CR)', record: gr.record_value || '', athlete: gr.holder_name || '', team: gr.holder_team || '', year: gr.record_year || '' };
                    }
                }
            } catch(e) {}
            const recTpl = tpl.records || {};
            return [
                { ...(recTpl.nr || { label: '한국기록(NR)' }), ...(evtRec.nr || {}) },
                { ...(recTpl.dr || { label: '부별기록(DR)' }), ...(evtRec.dr || {}) },
                { ...(recTpl.cr || { label: '대회기록(CR)' }), ...(evtRec.cr || {}) }
            ];
        };
        const recRowsForFooter = (tpl.show_records_table !== false) ? await _loadRecordsData() : null;

        // ─── 비고란 신기록(NR/DR/CR) 표기용 — 기준기록 숫자화 + 방향 ───
        // 기준을 깬 선수는 비고에 NR/DR/CR 표기 (깬 사람 전원). 승인/팝업은 별도(최고 1명).
        const _parseRecNum = (s) => {
            if (s == null) return null;
            const t = String(s).trim();
            if (!t) return null;
            if (t.includes(':')) {
                const parts = t.split(':').map(p => parseFloat(p));
                if (parts.some(isNaN)) return null;
                return parts.reduce((acc, v) => acc * 60 + v, 0);
            }
            const v = parseFloat(t.replace(/[^\d.]/g, ''));
            return isNaN(v) ? null : v;
        };
        const _recDir = (event.category === 'field_distance' || event.category === 'field_height') ? 'higher'
                      : (event.category === 'track' || event.category === 'road' || event.category === 'relay') ? 'lower' : null;
        const _recBaseline = {
            NR: recRowsForFooter ? _parseRecNum(recRowsForFooter[0] && recRowsForFooter[0].record) : null,
            DR: recRowsForFooter ? _parseRecNum(recRowsForFooter[1] && recRowsForFooter[1].record) : null,
            CR: recRowsForFooter ? _parseRecNum(recRowsForFooter[2] && recRowsForFooter[2].record) : null,
        };
        // val 이 깬 기록 라벨들 (예: "CR" 또는 "NR DR CR"). bestWind>2.0(참고기록)이면 미표기.
        const _brokenRecLabels = (val, bestWind) => {
            if (val == null || !isFinite(val) || !_recDir) return '';
            if (bestWind != null && bestWind > 2.0) return ''; // 풍속 초과 → 신기록 불인정
            const out = [];
            for (const lbl of ['NR', 'DR', 'CR']) {
                const base = _recBaseline[lbl];
                if (base == null) continue;
                if (_recDir === 'lower' && val < base) out.push(lbl);
                else if (_recDir === 'higher' && val > base) out.push(lbl);
            }
            return out.join(' ');
        };

        // 하단 박스 그리기: legend + 서명선 + NR/DR/CR 3행 표
        // 페이지 하단 영역 레이아웃 (위→아래):
        //   [legend 12]  +  [signature 24]  +  [표 header 22 + data row 20 x 3 = 82]  =  118pt
        //   브랜딩 푸터 ≈ 34.5pt, footerY = pageH - margin - 34.5 ≈ 767.4
        //   박스 ↔ 푸터 간격 12pt 확보
        // 박스를 푸터 바로 위로 "anchor down" 방식으로 배치 (정확한 위치 보장)
        const BRANDING_FOOTER_H = 34.5;
        const BOX_FOOTER_GAP = 12;
        // 박스 실제 높이 = legend 12 + (signature 24 if shown) + table header 22 + data rows 20 * N
        const _recCount = recRowsForFooter ? recRowsForFooter.length : 0;
        const _sigH = (tpl.show_signature !== false) ? 24 : 0;
        const _tableH = recRowsForFooter ? (22 + 20 * _recCount) : 0;
        const BOX_H = 12 + _sigH + _tableH; // legend + sig + table
        // 본문 영역 하단 한계: 박스 시작 y - 8pt 여백
        const BOX_TOP_Y = pageH - margin - BRANDING_FOOTER_H - BOX_FOOTER_GAP - BOX_H;
        const BOTTOM_RESERVED = pageH - margin - BOX_TOP_Y + 8; // 본문 ↔ 박스 사이 8pt 여백
        const drawEventBottomBox = (d) => {
            d.save(); // bufferPages + switchToPage 안전성 위한 그래픽 상태 격리
            const totalH = pageH - margin * 2;
            // 박스 시작 Y: 푸터 위로 정확히 anchor 됨 → 어떤 BOTTOM_RESERVED 값과도 무관하게 항상 푸터 위에 위치
            let y = BOX_TOP_Y;
            // Legend line
            pdfFont(d, false).fontSize(7).fillColor('#555');
            d.text('DQ=실격  DNS=경기불참  DNF=중도기권  NM=기록없음  Q=순위통과  q=기록통과', margin, y);
            y += 12;
            // Signature (작게)
            if (tpl.show_signature !== false) {
                pdfFont(d, false).fontSize(8.5).fillColor('#333');
                const recName = tpl.recorder_name || '';
                const chiefName = tpl.chief_recorder_name || '';
                const sigLineW = 150;
                d.text(`기록자 :    ${recName}`, tableLeft, y);
                const chiefX = tableRight - sigLineW;
                d.text(`기록주임 :    ${chiefName}`, chiefX, y);
                y += 14;
                d.save();
                d.moveTo(tableLeft, y).lineTo(tableLeft + sigLineW, y).lineWidth(0.5).stroke('#999');
                d.moveTo(chiefX, y).lineTo(tableRight, y).lineWidth(0.5).stroke('#999');
                d.restore();
                y += 10;
            }
            // NR/DR/CR 표
            if (recRowsForFooter) {
                const recCols = [
                    { key: 'label', label: '구 분', x: tableLeft, w: totalW * 0.22 },
                    { key: 'record', label: '기 록', x: tableLeft + totalW * 0.22, w: totalW * 0.18 },
                    { key: 'athlete', label: '선 수 명', x: tableLeft + totalW * 0.40, w: totalW * 0.20 },
                    { key: 'team', label: '소 속 명', x: tableLeft + totalW * 0.60, w: totalW * 0.22 },
                    { key: 'year', label: '수립년도', x: tableLeft + totalW * 0.82, w: totalW * 0.18 }
                ];
                y = drawTableHeader(d, recCols, y, tableLeft, tableRight, fontSize);
                for (const row of recRowsForFooter) {
                    const vals = recCols.map(c => row[c.key] || '');
                    y = drawTableRow(d, recCols, vals, y, tableLeft, tableRight, fontSize);
                }
            }
            d.restore();
        };

        let curY = drawEventTopHeader(doc);
        // body 영역 하단 한계: 기존 코드들의 `pageH - margin - 80` 대신
        // 하단 박스 자리를 비워두기 위해 BOTTOM_RESERVED 사용
        const BODY_BOTTOM = pageH - margin - BOTTOM_RESERVED;

        // ============================================================
        // COMBINED EVENT (10종/7종) — completely different layout
        // ============================================================
        if (isCombined) {
            const subEvents = await db.all('SELECT * FROM event WHERE parent_event_id=? ORDER BY sort_order, id', event.id);
            const heat = heats[0]; // optional — 혼성 부모는 heat 가 없을 수 있음
            // 부모 종목의 entries 조회: heat 가 있으면 lane 순, 없으면 event_entry 직접 조회
            let entries;
            if (heat) {
                entries = await db.all(`
                    SELECT he.lane_number, ee.id AS event_entry_id, ee.status, ee.athlete_id,
                           a.name, a.bib_number, a.team
                    FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id
                    JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=?
                    ORDER BY he.lane_number ASC
                `, heat.id);
            } else {
                // heat 없는 혼성 부모: event_entry 만으로 본문 생성 (lane 정보는 null)
                entries = await db.all(`
                    SELECT NULL AS lane_number, ee.id AS event_entry_id, ee.status, ee.athlete_id,
                           a.name, a.bib_number, a.team
                    FROM event_entry ee JOIN athlete a ON a.id=ee.athlete_id
                    WHERE ee.event_id=?
                    ORDER BY a.bib_number ASC, ee.id ASC
                `, event.id);
            }
            // 그래도 entries 가 비어있으면 안내 텍스트만 출력하고 종료 (빈 페이지 방지)
            if (!entries || entries.length === 0) {
                pdfFont(doc, false).fontSize(11).fillColor('#888');
                doc.text('— 등록된 선수가 없습니다 —', margin, curY + 20, { width: pageW - margin * 2, align: 'center' });
                // bufferPages 루프에서 헤더/푸터/박스 그려지도록 본문은 비워두고 정상 종료
            }

            // Build sub-event short names for columns
            const subLabels = subEvents.map(se => {
                let n = se.name.replace(/\[.*?\]\s*/, '');
                if (n.length > 5) n = n.substring(0, 5);
                return n;
            });

            // Helper: parse wind value — handles both numeric (real) and text ("0.5 m/s") storage
            const parseWindValue = (w) => {
                if (w == null) return null;
                if (typeof w === 'number') return isFinite(w) ? w : null;
                const m = String(w).match(/-?\d+(?:\.\d+)?/);
                return m ? parseFloat(m[0]) : null;
            };

            // Gather all combined_scores and sub-event results for each athlete
            const athleteData = await Promise.all(entries.map(async e => {
                const scores = await db.all('SELECT * FROM combined_score WHERE event_entry_id=? ORDER BY sub_event_order', e.event_entry_id);
                let totalPoints = 0;
                const subScores = [];
                for (let i = 0; i < subEvents.length; i++) {
                    const se = subEvents[i];
                    const sc = scores.find(s => s.sub_event_order === i + 1) || null;
                    let rawRecord = null; let wind = null; let points = 0;
                    const isWindAffected = se.category === 'track' || se.category === 'field_distance';
                    if (sc) {
                        rawRecord = sc.raw_record;
                        points = sc.wa_points || 0;
                        totalPoints += points;
                    }
                    // Always try to load sub-event heat/result data (for wind retrieval and as fallback for missing combined_score)
                    const subHeat = await db.get('SELECT id, wind FROM heat WHERE event_id=?', se.id);
                    if (subHeat) {
                        const subEE = await db.get('SELECT id FROM event_entry WHERE event_id=? AND athlete_id=?', se.id, e.athlete_id);
                        if (subEE) {
                            // Find best result (track: lowest time; field_distance: highest distance)
                            let subRes = null;
                            if (se.category === 'track' || se.category === 'road' || se.category === 'relay') {
                                subRes = await db.get('SELECT * FROM result WHERE heat_id=? AND event_entry_id=? AND time_seconds IS NOT NULL ORDER BY time_seconds ASC LIMIT 1', subHeat.id, subEE.id);
                            } else if (se.category === 'field_distance') {
                                subRes = await db.get('SELECT * FROM result WHERE heat_id=? AND event_entry_id=? AND distance_meters IS NOT NULL ORDER BY distance_meters DESC LIMIT 1', subHeat.id, subEE.id);
                            } else {
                                subRes = await db.get('SELECT * FROM result WHERE heat_id=? AND event_entry_id=? ORDER BY attempt_number LIMIT 1', subHeat.id, subEE.id);
                            }

                            if (!sc && subRes) {
                                // Fallback record only if no combined_score
                                const isST = se.category === 'track' || se.category === 'road' || se.category === 'relay';
                                rawRecord = isST ? subRes.time_seconds : subRes.distance_meters;
                            }
                            // Always pull wind for wind-affected sub-events
                            if (isWindAffected) {
                                // Prefer result.wind (per-attempt accuracy), then fall back to heat.wind
                                wind = parseWindValue(subRes?.wind);
                                if (wind == null) wind = parseWindValue(subHeat.wind);
                            }
                            // For field_height fallback
                            if (!sc && se.category === 'field_height') {
                                const best = await db.get("SELECT MAX(bar_height) AS best FROM height_attempt WHERE heat_id=? AND event_entry_id=? AND result_mark='O'", subHeat.id, subEE.id);
                                if (best && best.best) rawRecord = best.best;
                            }
                            // For field_distance no-result fallback
                            if (!sc && se.category === 'field_distance' && !rawRecord) {
                                const bestD = await db.get('SELECT MAX(distance_meters) AS best FROM result WHERE heat_id=? AND event_entry_id=? AND distance_meters IS NOT NULL', subHeat.id, subEE.id);
                                if (bestD && bestD.best) rawRecord = bestD.best;
                            }
                        } else if (isWindAffected) {
                            // No event_entry for sub event → use heat-level wind as best-effort
                            wind = parseWindValue(subHeat.wind);
                        }
                    }
                    subScores.push({ rawRecord, wind, points, subEvent: se });
                }
                // Check for DNF status — heat 가 없으면 heat_id 조건 없이 entry 만으로 조회
                const status = heat
                    ? await db.get("SELECT status_code FROM result WHERE heat_id=? AND event_entry_id=? AND status_code IN ('DNF','DNS','DQ') LIMIT 1", heat.id, e.event_entry_id)
                    : await db.get("SELECT status_code FROM result WHERE event_entry_id=? AND status_code IN ('DNF','DNS','DQ') LIMIT 1", e.event_entry_id);
                let statusCode = status?.status_code || '';
                // Fallback: if entry status is no_show and no explicit DNS result, treat as DNS
                if (!statusCode && e.status === 'no_show') statusCode = 'DNS';
                // 0 points with no explicit status → DNF
                if (!statusCode && totalPoints === 0) statusCode = 'DNF';
                return { ...e, subScores, totalPoints, status_code: statusCode };
            }));

            // Sort by total points descending; DNF at bottom
            athleteData.sort((a, b) => {
                const aS = ['DNS','DNF','DQ'].includes(a.status_code);
                const bS = ['DNS','DNF','DQ'].includes(b.status_code);
                if (aS && !bS) return 1;
                if (!aS && bS) return -1;
                if (aS && bS) return 0;
                return b.totalPoints - a.totalPoints;
            });

            // Build combined columns: 순위, 배번, 선수명, 소속명, [sub-events...], 결과
            const comCols = [];
            let cx = tableLeft;
            comCols.push({ key: 'rank', label: '순위', x: cx, w: totalW * 0.05 }); cx += totalW * 0.05;
            comCols.push({ key: 'bib', label: '배번', x: cx, w: totalW * 0.05 }); cx += totalW * 0.05;
            comCols.push({ key: 'name', label: '선수명', x: cx, w: totalW * 0.10 }); cx += totalW * 0.10;
            comCols.push({ key: 'team', label: '소속명', x: cx, w: totalW * 0.12 }); cx += totalW * 0.12;
            const subW = Math.max(0.04, (totalW * 0.58) / Math.max(subEvents.length, 1)) / totalW;
            for (let i = 0; i < subEvents.length; i++) {
                comCols.push({ key: `sub_${i}`, label: subLabels[i], x: cx, w: totalW * subW }); cx += totalW * subW;
            }
            comCols.push({ key: 'total', label: '결과', x: cx, w: (tableRight - cx) * 0.6 }); cx += (tableRight - cx) * 0.6;
            comCols.push({ key: 'remark', label: '비고', x: cx, w: tableRight - cx }); // remaining

            // Draw header (smaller font for combined)
            const comFS = Math.min(fontSize, 7);
            curY = drawTableHeader(doc, comCols, curY, tableLeft, tableRight, comFS);

            // Sub-header: WIND row (for wind-affected events)
            const windRowH = 14;
            doc.save();
            doc.rect(tableLeft, curY, totalW, windRowH).fill('#f5f5f5').stroke(PR_TABLE_BORDER);
            // "WIND (m/s)" label placed in the team column area (left of sub-events) for clarity
            pdfFont(doc, true).fontSize(6).fillColor('#555');
            const teamColEnd = comCols[3] ? comCols[3].x + comCols[3].w : tableLeft + totalW * 0.32;
            doc.text('WIND (m/s)', tableLeft, curY + 3, { width: teamColEnd - tableLeft, align: 'right' });
            // Mark each wind-affected sub-event column with a small wind indicator above
            pdfFont(doc, false).fontSize(5.5).fillColor('#888');
            for (let i = 0; i < subEvents.length; i++) {
                const se = subEvents[i];
                if (se.category === 'track' || se.category === 'field_distance') {
                    const col = comCols[4 + i];
                    if (col) doc.text('↓', col.x + 1, curY + 3, { width: col.w - 2, align: 'center' });
                }
            }
            doc.restore();
            curY += windRowH;

            // Render each athlete (3 rows: record, points, wind)
            let rank = 0;
            for (const ath of athleteData) {
                const rowH3 = 42; // 3 sub-rows * 14px each
                if (curY + rowH3 > BODY_BOTTOM) {
                    doc.addPage(); curY = drawEventTopHeader(doc);
                    curY = drawTableHeader(doc, comCols, curY, tableLeft, tableRight, comFS);
                    curY += windRowH; // skip wind header space
                }
                const special = ['DNS','DNF','DQ'].includes(ath.status_code);
                if (!special) rank++;

                // Row background
                doc.save();
                doc.rect(tableLeft, curY, totalW, rowH3).stroke(PR_TABLE_BORDER);
                doc.restore();

                const subRowH = 14;
                // Row 1: record values
                pdfFont(doc, false).fontSize(comFS).fillColor('#000');
                const y1 = curY + 2;
                doc.text(special ? '' : String(rank), comCols[0].x + 2, y1, { width: comCols[0].w - 4, align: 'center' });
                doc.text(ath.bib_number || '-', comCols[1].x + 2, y1, { width: comCols[1].w - 4, align: 'center' });
                pdfFont(doc, true).fontSize(comFS);
                doc.text(ath.name || '', comCols[2].x + 2, y1, { width: comCols[2].w - 4, align: 'center' });
                pdfFont(doc, false).fontSize(comFS);
                doc.text(ath.team || '', comCols[3].x + 2, y1, { width: comCols[3].w - 4, align: 'center' });
                // Sub-event records
                for (let i = 0; i < ath.subScores.length; i++) {
                    const sc = ath.subScores[i];
                    let recStr = '';
                    if (sc.rawRecord != null) {
                        const se = sc.subEvent;
                        if (se.category === 'track' || se.category === 'road' || se.category === 'relay') {
                            recStr = formatTimeForPDF(sc.rawRecord);
                        } else {
                            recStr = sc.rawRecord.toFixed(2);
                        }
                    }
                    const col = comCols[4 + i];
                    if (col) doc.text(recStr, col.x + 1, y1, { width: col.w - 2, align: 'center' });
                }
                // Total — DNF/DQ → 공백
                const totalCol = comCols.find(c => c.key === 'total');
                pdfFont(doc, true).fontSize(comFS + 1).fillColor('#000');
                doc.text(special ? '' : String(ath.totalPoints), totalCol.x + 2, y1, { width: totalCol.w - 4, align: 'center' });
                // Remark — DNF/DQ status
                const remkCol = comCols.find(c => c.key === 'remark');
                if (remkCol) {
                    pdfFont(doc, false).fontSize(comFS).fillColor('#000');
                    doc.text(special ? ath.status_code : '', remkCol.x + 2, y1, { width: remkCol.w - 4, align: 'center' });
                }

                // Row 2: points
                const y2 = curY + subRowH + 1;
                pdfFont(doc, false).fontSize(5.5).fillColor('#666');
                for (let i = 0; i < ath.subScores.length; i++) {
                    const sc = ath.subScores[i];
                    const col = comCols[4 + i];
                    if (col && sc.points) doc.text(String(sc.points), col.x + 1, y2, { width: col.w - 2, align: 'center' });
                }

                // Row 3: wind (per sub-event, for track/field_distance only)
                const y3 = curY + subRowH * 2;
                pdfFont(doc, false).fontSize(6).fillColor('#0066aa');
                for (let i = 0; i < ath.subScores.length; i++) {
                    const sc = ath.subScores[i];
                    const col = comCols[4 + i];
                    if (col && typeof sc.wind === 'number' && isFinite(sc.wind)) {
                        const wStr = (sc.wind >= 0 ? '+' : '') + sc.wind.toFixed(1);
                        doc.text(wStr, col.x + 1, y3, { width: col.w - 2, align: 'center' });
                    }
                }

                curY += rowH3;
            }
            curY += 8;

        // ============================================================
        // FIELD HEIGHT EVENT (높이뛰기/장대높이뛰기) — O/X/XXO format
        // ============================================================
        } else if (isFieldHeight) {
            const heat = heats[0]; // field height typically has one heat
            if (!heat) { doc.end(); return; }
            const entries = await db.all(`
                SELECT he.lane_number, ee.id AS event_entry_id, ee.status, ee.manual_rank,
                       a.name, a.bib_number, a.team
                FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id
                JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=?
                ORDER BY he.lane_number ASC
            `, heat.id);

            // Get all height attempts for this heat
            const allAttempts = await db.all('SELECT * FROM height_attempt WHERE heat_id=? ORDER BY bar_height, event_entry_id, attempt_number', heat.id);
            // Get unique bar heights
            const barHeights = [...new Set(allAttempts.map(a => a.bar_height))].sort((a, b) => a - b);

            // Build athlete data
            const athleteData = await Promise.all(entries.map(async e => {
                const myAttempts = allAttempts.filter(a => a.event_entry_id === e.event_entry_id);
                let bestCleared = null;
                let totalMisses = 0; let missesAtBest = 0;
                const heightResults = {};
                for (const h of barHeights) {
                    const attemptsAtH = myAttempts.filter(a => a.bar_height === h).sort((a, b) => a.attempt_number - b.attempt_number);
                    if (attemptsAtH.length === 0) {
                        heightResults[h] = ''; // did not attempt
                    } else {
                        let str = attemptsAtH.map(a => a.result_mark).join('');
                        heightResults[h] = str;
                        const misses = attemptsAtH.filter(a => a.result_mark === 'X').length;
                        totalMisses += misses;
                        if (attemptsAtH.some(a => a.result_mark === 'O')) {
                            bestCleared = h;
                            missesAtBest = misses;
                        }
                    }
                }
                // 카운트백은 공용 규칙(public/lib/ranking.js · WA TR 26.8): '마지막으로 넘은 높이까지'의 실패 수 — 예전엔 경기 전체 실패 수로 계산했다
                { const _hs = require('../../public/lib/ranking').heightStatsFromAttempts(myAttempts); totalMisses = _hs.totalFails; missesAtBest = _hs.failsAtBest; }
                // Also check result table for status
                const results = await db.all('SELECT * FROM result WHERE heat_id=? AND event_entry_id=?', heat.id, e.event_entry_id);
                let status = results.find(r => r.status_code && r.status_code !== '')?.status_code || '';
                // Fallback: if entry status is no_show and no explicit DNS result, treat as DNS
                if (!status && e.status === 'no_show') status = 'DNS';
                // If no height_attempt data, check result table for best distance_meters (used as height)
                // [FIX] distance_meters===0 은 파울, -1 은 패스 이므로 양수만 유효
                if (bestCleared === null && !status) {
                    const bestR = results.find(r => r.distance_meters != null && r.distance_meters > 0);
                    if (bestR) bestCleared = bestR.distance_meters;
                }
                return { ...e, bestCleared, totalMisses, missesAtBest, heightResults, status_code: status };
            }));

            // Sort: highest cleared → fewest misses at best → fewest total misses
            athleteData.sort((a, b) => {
                const aS = ['DNS','DNF','DQ','NM'].includes(a.status_code);
                const bS = ['DNS','DNF','DQ','NM'].includes(b.status_code);
                if (aS && !bS) return 1;
                if (!aS && bS) return -1;
                if (a.bestCleared == null && b.bestCleared == null) return 0;
                if (a.bestCleared == null) return 1;
                if (b.bestCleared == null) return -1;
                if (b.bestCleared !== a.bestCleared) return b.bestCleared - a.bestCleared;
                // 같은 높이 → 수동 순위(순위결정전) 우선, 없으면 countback
                if (a.manual_rank != null && b.manual_rank != null) return a.manual_rank - b.manual_rank;
                if (a.missesAtBest !== b.missesAtBest) return a.missesAtBest - b.missesAtBest;
                return a.totalMisses - b.totalMisses;
            });

            // Build columns: 순위, 배번, 선수명, 소속명, [bar heights...], 결과
            const hCols = [];
            let hx = tableLeft;
            hCols.push({ key: 'rank', label: '순위', x: hx, w: totalW * 0.06 }); hx += totalW * 0.06;
            hCols.push({ key: 'bib', label: '배번', x: hx, w: totalW * 0.06 }); hx += totalW * 0.06;
            hCols.push({ key: 'name', label: '선수명', x: hx, w: totalW * 0.12 }); hx += totalW * 0.12;
            hCols.push({ key: 'team', label: teamLabelK, x: hx, w: totalW * 0.14 }); hx += totalW * 0.14;
            const remainForBars = totalW * 0.52;
            const barW = barHeights.length > 0 ? Math.min(remainForBars / barHeights.length, totalW * 0.08) : totalW * 0.06;
            for (const bh of barHeights) {
                hCols.push({ key: `h_${bh}`, label: bh.toFixed(2), x: hx, w: barW }); hx += barW;
            }
            hCols.push({ key: 'result', label: '결 과', x: hx, w: (tableRight - hx) * 0.6 }); hx += (tableRight - hx) * 0.6;
            hCols.push({ key: 'remark', label: '비 고', x: hx, w: tableRight - hx });

            const hFS = Math.min(fontSize, barHeights.length > 6 ? 7 : 8);
            curY = drawTableHeader(doc, hCols, curY, tableLeft, tableRight, hFS);

            let rank = 0; let prevAth = null; let athIdx = 0;
            for (const ath of athleteData) {
                if (curY + Math.max(20, hFS + 10) > BODY_BOTTOM) {
                    doc.addPage(); curY = drawEventTopHeader(doc);
                    curY = drawTableHeader(doc, hCols, curY, tableLeft, tableRight, hFS);
                }
                const special = ['DNS','DNF','DQ','NM'].includes(ath.status_code) || ath.bestCleared == null;
                if (!special) {
                    athIdx++;
                    if (ath.manual_rank != null) {
                        // 순위결정전 등 수동 순위 — 계산 순위 대신 직접 입력값 사용
                        rank = ath.manual_rank;
                    } else {
                        // WA tie-break: same bestCleared + missesAtBest + totalMisses = same rank
                        const isTied = prevAth && prevAth.manual_rank == null && prevAth.bestCleared === ath.bestCleared
                            && prevAth.missesAtBest === ath.missesAtBest
                            && prevAth.totalMisses === ath.totalMisses;
                        if (!isTied) rank = athIdx;
                    }
                    prevAth = ath;
                }
                const _hLbl = (!special && ath.bestCleared != null) ? (_brokenRecLabels(ath.bestCleared, null) || '') : '';
                const vals = hCols.map(col => {
                    if (col.key === 'rank') return special ? '' : String(rank);
                    if (col.key === 'bib') return ath.bib_number || '-';
                    if (col.key === 'name') return ath.name || '';
                    if (col.key === 'team') return ath.team || '';
                    if (col.key === 'result') return special ? (ath.status_code || 'NM') : (ath.bestCleared != null ? (ath.bestCleared.toFixed(2) + (_hLbl ? ` (${_hLbl})` : '')) : '');
                    if (col.key === 'remark') return '';
                    if (col.key.startsWith('h_')) {
                        const bh = parseFloat(col.key.substring(2));
                        return ath.heightResults[bh] || '';
                    }
                    return '';
                });
                curY = drawTableRow(doc, hCols, vals, curY, tableLeft, tableRight, hFS, { boldCols: ['name', 'result'] });
            }

            // Draw empty rows up to 12 (like the reference image)
            const minRows = 12;
            const drawn = athleteData.length;
            for (let i = drawn + 1; i <= minRows; i++) {
                if (curY + Math.max(20, hFS + 10) > BODY_BOTTOM) break;
                const emptyVals = hCols.map(col => col.key === 'rank' ? String(i) : '');
                curY = drawTableRow(doc, hCols, emptyVals, curY, tableLeft, tableRight, hFS);
            }
            curY += 8;

        // ============================================================
        // FIELD DISTANCE EVENT (멀리뛰기/세단뛰기/포환/원반/해머/창) — 6 attempts with wind
        // ============================================================
        } else if (isFieldDist) {
            for (const heat of heats) {
                const entries = await db.all(`
                    SELECT he.lane_number, ee.id AS event_entry_id, ee.status,
                           a.name, a.bib_number, a.team
                    FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id
                    JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=?
                    ORDER BY he.lane_number ASC
                `, heat.id);

                const results = await db.all('SELECT * FROM result WHERE heat_id=? ORDER BY event_entry_id, attempt_number', heat.id);

                // Determine max attempts (usually 6 for final, 3 for qualifying)
                const maxAttempt = results.reduce((max, r) => Math.max(max, r.attempt_number || 0), 0) || 6;
                const numAttempts = Math.max(maxAttempt, 3);

                // Determine if this event has wind (멀리뛰기, 세단뛰기 = yes; 투척 = no)
                const hasWind = /멀리|세단|long|triple/i.test(event.name);

                // Build athlete data
                const resMap = {};
                for (const r of results) {
                    if (!resMap[r.event_entry_id]) resMap[r.event_entry_id] = [];
                    resMap[r.event_entry_id].push(r);
                }

                const athleteData = entries.map(e => {
                    const recs = resMap[e.event_entry_id] || [];
                    let best = null; let bestWind = null; let bestAttempt = -1;
                    const attempts = [];
                    for (let i = 1; i <= numAttempts; i++) {
                        const r = recs.find(r => r.attempt_number === i);
                        if (r) {
                            // [FIX] 수기입력 record.js 는 파울=distance_meters:0, 패스=distance_meters:-1 로 저장하므로
                            //       status_code 뿐 아니라 distance_meters 값으로도 판정해야 한다.
                            const isFoulByDist = (r.distance_meters === 0);
                            const isPassByDist = (r.distance_meters === -1);
                            if (r.status_code === 'X' || r.status_code === 'FOUL' || isFoulByDist) {
                                attempts.push({ dist: null, wind: r.wind, foul: true, pass: false });
                            } else if (r.status_code === '-' || r.status_code === 'PASS' || isPassByDist) {
                                attempts.push({ dist: null, wind: null, foul: false, pass: true });
                            } else if (r.distance_meters != null && r.distance_meters > 0) {
                                attempts.push({ dist: r.distance_meters, wind: r.wind, foul: false, pass: false });
                                if (best === null || r.distance_meters > best) {
                                    best = r.distance_meters;
                                    bestWind = r.wind;
                                    bestAttempt = i;
                                }
                            } else {
                                attempts.push({ dist: null, wind: null, foul: false, pass: false });
                            }
                        } else {
                            attempts.push({ dist: null, wind: null, foul: false, pass: false });
                        }
                    }
                    let status = recs.find(r => r.status_code && ['DNS','DNF','NM','DQ'].includes(r.status_code))?.status_code || '';
                    // Fallback: if entry status is no_show and no explicit DNS result, treat as DNS
                    if (!status && e.status === 'no_show') status = 'DNS';
                    // [FIX] NM 판정도 distance_meters===0 (파울) 포함
                    const allFoulOrEmpty = recs.length > 0 && recs.every(r =>
                        r.status_code === 'X' || r.status_code === 'FOUL' || r.distance_meters === 0
                    );
                    if (!status && best === null && allFoulOrEmpty) {
                        return { ...e, attempts, best, bestWind, status_code: 'NM' };
                    }
                    return { ...e, attempts, best, bestWind, status_code: status };
                });

                // Sort by best distance descending
                athleteData.forEach(a => { a.sortedValid = (a.attempts || []).map(x => x.dist).filter(d => typeof d === 'number' && d > 0).sort((x, y) => y - x); });
                athleteData.sort((a, b) => {
                    const aS = ['DNS','DNF','DQ','NM'].includes(a.status_code);
                    const bS = ['DNS','DNF','DQ','NM'].includes(b.status_code);
                    if (aS && !bS) return 1;
                    if (!aS && bS) return -1;
                    if (a.best == null && b.best == null) return 0;
                    if (a.best == null) return 1;
                    if (b.best == null) return -1;
                    // 최고 기록이 같으면 2·3번째 기록으로 (WA TR 25.22 · public/lib/ranking.js) — 예전엔 최고 기록만 비교해 동률 순서가 임의였다
                    return require('../../public/lib/ranking').compareDistance(a, b);
                });
                // 순위: 동률이면 같은 순위, 다음 순위는 건너뜀 (예전엔 rank++ 로 무조건 1씩 증가)
                require('../../public/lib/ranking').assignRanks(athleteData.filter(a => !['DNS','DNF','DQ','NM'].includes(a.status_code)), require('../../public/lib/ranking').compareDistance);

                // Heat label
                if (heats.length > 1) {
                    if (curY + 80 > BODY_BOTTOM) { doc.addPage(); curY = drawEventTopHeader(doc); }
                    pdfFont(doc, true).fontSize(10).fillColor('#000');
                    doc.text(heat.heat_name || `Heat ${heat.heat_number}`, margin, curY);
                    curY += 16;
                }

                // Build columns: 순위, 배번, 선수명, 소속명, [1..N], 결과, 비고(wind of best)
                const fdCols = [];
                let fx = tableLeft;
                fdCols.push({ key: 'rank', label: '순위', x: fx, w: totalW * 0.05 }); fx += totalW * 0.05;
                fdCols.push({ key: 'bib', label: '배번', x: fx, w: totalW * 0.06 }); fx += totalW * 0.06;
                fdCols.push({ key: 'name', label: '선수명', x: fx, w: totalW * 0.12 }); fx += totalW * 0.12;
                fdCols.push({ key: 'team', label: teamLabelK, x: fx, w: totalW * 0.14 }); fx += totalW * 0.14;
                const attW = Math.min(totalW * 0.08, (totalW * 0.48) / numAttempts);
                for (let i = 1; i <= numAttempts; i++) {
                    fdCols.push({ key: `att_${i}`, label: String(i), x: fx, w: attW }); fx += attW;
                }
                fdCols.push({ key: 'result', label: '결 과', x: fx, w: totalW * 0.09 }); fx += totalW * 0.09;
                fdCols.push({ key: 'remark', label: '비 고', x: fx, w: tableRight - fx });

                // Draw header with 2 sub-rows (attempt numbers + WIND)
                const fdFS = Math.min(fontSize, 7.5);
                curY = drawTableHeader(doc, fdCols, curY, tableLeft, tableRight, fdFS);

                if (hasWind) {
                    // WIND sub-header row
                    const windH = 12;
                    doc.save();
                    doc.rect(tableLeft, curY, totalW, windH).fill('#f8f8f8').stroke(PR_TABLE_BORDER);
                    pdfFont(doc, false).fontSize(5.5).fillColor('#888');
                    doc.text('WIND', tableLeft + totalW * 0.37 / 2, curY + 2, { width: totalW * 0.37, align: 'center' });
                    doc.restore();
                    curY += windH;
                }

                // Render athletes (2 rows each: distance + wind)
                let rank = 0;
                for (const ath of athleteData) {
                    const rowH = hasWind ? 30 : 18; // 2 sub-rows if wind, 1 if not
                    if (curY + rowH > BODY_BOTTOM) {
                        doc.addPage(); curY = drawEventTopHeader(doc);
                        curY = drawTableHeader(doc, fdCols, curY, tableLeft, tableRight, fdFS);
                        if (hasWind) curY += 12;
                    }
                    const special = ['DNS','DNF','DQ','NM'].includes(ath.status_code);
                    if (!special && ath.best != null) rank = ath.rank != null ? ath.rank : rank + 1;

                    // Row border
                    doc.save();
                    doc.rect(tableLeft, curY, totalW, rowH).stroke(PR_TABLE_BORDER);
                    doc.restore();

                    const y1 = curY + 2;
                    pdfFont(doc, false).fontSize(fdFS).fillColor('#000');
                    doc.text(special ? '' : (ath.best != null ? String(rank) : ''), fdCols[0].x + 1, y1, { width: fdCols[0].w - 2, align: 'center' });
                    doc.text(ath.bib_number || '-', fdCols[1].x + 1, y1, { width: fdCols[1].w - 2, align: 'center' });
                    pdfFont(doc, true).fontSize(fdFS);
                    doc.text(ath.name || '', fdCols[2].x + 1, y1, { width: fdCols[2].w - 2, align: 'center' });
                    pdfFont(doc, false).fontSize(fdFS);
                    doc.text(ath.team || '', fdCols[3].x + 1, y1, { width: fdCols[3].w - 2, align: 'center' });

                    // Attempt distances (row 1)
                    for (let i = 0; i < numAttempts; i++) {
                        const att = ath.attempts[i];
                        const col = fdCols[4 + i];
                        let val = '';
                        if (att.foul) val = 'X';
                        else if (att.pass) val = '-';
                        else if (att.dist != null) val = att.dist.toFixed(2);
                        doc.text(val, col.x + 1, y1, { width: col.w - 2, align: 'center' });
                    }

                    // Result (best) — DNF/DQ/NM 은 결과란에, 신기록(NR/DR/CR)은 기록 값 옆 괄호로
                    const resCol = fdCols[4 + numAttempts];
                    pdfFont(doc, true).fontSize(fdFS + 0.5).fillColor('#000');
                    const _fdLbl = (!special && ath.best != null) ? _brokenRecLabels(ath.best, ath.bestWind) : '';
                    const _fdRec = special ? (ath.status_code || '') : (ath.best != null ? (ath.best.toFixed(2) + (_fdLbl ? ` (${_fdLbl})` : '')) : '');
                    doc.text(_fdRec, resCol.x + 1, y1, { width: resCol.w - 2, align: 'center' });
                    // 비고: 상태코드는 결과란에 표시되므로 비움 (신기록도 결과란 괄호로 이동)

                    // Wind per attempt (row 2) — only if hasWind
                    if (hasWind) {
                        const y2 = curY + 15;
                        pdfFont(doc, false).fontSize(5.5).fillColor('#888');
                        for (let i = 0; i < numAttempts; i++) {
                            const att = ath.attempts[i];
                            const col = fdCols[4 + i];
                            if (att.wind != null) {
                                doc.text((att.wind >= 0 ? '+' : '') + att.wind.toFixed(1), col.x + 1, y2, { width: col.w - 2, align: 'center' });
                            }
                        }
                    }

                    curY += rowH;
                }
                curY += 8;
            }

        // ============================================================
        // TRACK / ROAD / RELAY — best time only (existing logic, fixed)
        // ============================================================
        } else {
            const dataRowH2 = Math.max(20, fontSize + 10);
            const rsCols = [];
            let xOff = tableLeft;
            if (tpl.show_rank !== false) { rsCols.push({ key: 'rank', label: '순 위', x: xOff, w: totalW * 0.07 }); xOff += totalW * 0.07; }
            if (tpl.show_lane !== false) { rsCols.push({ key: 'lane', label: '레 인', x: xOff, w: totalW * 0.07 }); xOff += totalW * 0.07; }
            if (tpl.show_bib !== false) { rsCols.push({ key: 'bib', label: '배 번', x: xOff, w: totalW * 0.08 }); xOff += totalW * 0.08; }
            if (tpl.show_name !== false) {
                const usedFrac = (xOff - tableLeft) / totalW + (tpl.show_team !== false ? 0.22 : 0) + (tpl.show_record !== false ? 0.14 : 0) + (tpl.show_remark !== false ? 0.12 : 0) + (tpl.show_wind ? 0.10 : 0);
                const nameFrac = Math.max(0.12, 1 - usedFrac);
                rsCols.push({ key: 'name', label: '선 수 명', x: xOff, w: totalW * nameFrac }); xOff += totalW * nameFrac;
            }
            if (tpl.show_team !== false) { rsCols.push({ key: 'team', label: teamLabelK, x: xOff, w: totalW * 0.22 }); xOff += totalW * 0.22; }
            if (tpl.show_record !== false) { rsCols.push({ key: 'record', label: '기 록', x: xOff, w: totalW * 0.14 }); xOff += totalW * 0.14; }
            if (tpl.show_wind) { rsCols.push({ key: 'wind', label: '풍 속', x: xOff, w: totalW * 0.10 }); xOff += totalW * 0.10; }
            if (tpl.show_remark !== false) { rsCols.push({ key: 'remark', label: '비 고', x: xOff, w: totalW * 0.12 }); xOff += totalW * 0.12; }

            // Load Q/q qualifications for non-final rounds
            let qualMap = {};
            if (event.round_type !== 'final') {
                const quals = await db.all('SELECT event_entry_id, qualification_type FROM qualification_selection WHERE event_id=? AND selected=1', event.id);
                for (const q of quals) { qualMap[q.event_entry_id] = q.qualification_type || 'Q'; }
            }

            for (const heat of heats) {
                const entries = await db.all(`
                    SELECT he.lane_number, ee.id AS event_entry_id, ee.status,
                           a.name, a.bib_number, a.team
                    FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id
                    JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=?
                    ORDER BY he.lane_number ASC
                `, heat.id);

                const results = await db.all('SELECT * FROM result WHERE heat_id=? ORDER BY event_entry_id, attempt_number', heat.id);

                if (heats.length > 1) {
                    const headerRowH2 = Math.max(22, fontSize + 12);
                    const neededH = 30 + headerRowH2 + entries.length * dataRowH2 + 20;
                    if (curY + neededH > BODY_BOTTOM) { doc.addPage(); curY = drawEventTopHeader(doc); }
                    const hLabel = heat.heat_name || `Heat ${heat.heat_number}`;
                    pdfFont(doc, true).fontSize(10).fillColor('#000');
                    doc.text(hLabel, margin, curY);
                    if (heat.wind != null && tpl.show_wind) { pdfFont(doc, false).fontSize(8).fillColor('#666'); doc.text(`Wind: ${heat.wind}`, margin + 100, curY + 2); }
                    curY += 16;
                }

                curY = drawTableHeader(doc, rsCols, curY, tableLeft, tableRight, fontSize);

                const resMap = {};
                for (const r of results) {
                    if (!resMap[r.event_entry_id]) resMap[r.event_entry_id] = [];
                    resMap[r.event_entry_id].push(r);
                }

                const ranked = entries.map(e => {
                    const recs = resMap[e.event_entry_id] || [];
                    const r = recs.find(r => r.time_seconds != null);
                    const best = r ? r.time_seconds : null;
                    const bestWind = r ? r.wind : null;
                    let status = recs.find(r => r.status_code && r.status_code !== '' && ['DNS','DNF','NM','DQ'].includes(r.status_code))?.status_code || '';
                    // Fallback: if entry status is no_show and no explicit DNS result, treat as DNS
                    if (!status && e.status === 'no_show') status = 'DNS';
                    return { ...e, best, bestWind, status_code: status, allResults: recs };
                });

                ranked.sort((a, b) => {
                    const aS = ['DNS','DNF','NM','DQ'].includes(a.status_code);
                    const bS = ['DNS','DNF','NM','DQ'].includes(b.status_code);
                    if (aS && !bS) return 1;
                    if (!aS && bS) return -1;
                    if (a.best == null && b.best == null) return 0;
                    if (a.best == null) return 1;
                    if (b.best == null) return -1;
                    return a.best - b.best;
                });

                let rank = 0;
                for (const e of ranked) {
                    if (curY + dataRowH2 > BODY_BOTTOM) {
                        doc.addPage(); curY = drawEventTopHeader(doc);
                        curY = drawTableHeader(doc, rsCols, curY, tableLeft, tableRight, fontSize);
                    }
                    const special = ['DNS','DNF','NM','DQ'].includes(e.status_code);
                    rank++;
                    let recStr = '';
                    if (special) { recStr = e.status_code; rank--; }
                    else if (e.best != null) { recStr = formatTimeForPDF(e.best); }

                    // 비고: DNF/DQ/DNS/NM → 비고란에만, Q/q도 비고란
                    let remarkStr = '';
                    if (special) remarkStr = e.status_code;
                    else if (qualMap[e.event_entry_id]) remarkStr = qualMap[e.event_entry_id];
                    else remarkStr = e.allResults?.[0]?.remark || '';
                    // 신기록 라벨(NR/DR/CR) — 기록 값 옆 괄호에 표기
                    const _recLbl = (!special && e.best != null) ? _brokenRecLabels(e.best, e.bestWind) : '';

                    // ─── 비고 멤버 리스트 정규화 (긴 텍스트 줄바꿈) ───
                    // 사용자가 비고에 멤버 이름을 ", " 로 구분해 직접 입력하는 케이스 대비:
                    //   "이동욱(14:48.74), 이정윤(15:09.42), 김현우(15:20.06)"
                    //   → 콤마마다 개행으로 분리해 비고 컬럼 안에 세로로 적층
                    // 짧은 텍스트(PB/SB/Q/NR 같은 코드 또는 콤마 없는 단순 텍스트)는 그대로 유지.
                    // 임계: 25자 이상 + 콤마 포함 → 멤버 리스트로 간주 (어느 종목이든 안전)
                    if (remarkStr && remarkStr.length > 25 && remarkStr.includes(',')) {
                        remarkStr = remarkStr
                            .replace(/\s*,\s*/g, '\n')   // ", " → 개행
                            .trim();
                    }

                    const vals = rsCols.map(col => {
                        switch (col.key) {
                            case 'rank': return special ? '' : String(rank);
                            case 'lane': return String(e.lane_number || '-');
                            case 'bib': return e.bib_number || '-';
                            case 'name': return e.name || '';
                            case 'team': return e.team || '';
                            case 'record': return special ? '' : (e.best != null ? formatTimeForPDF(e.best) + (_recLbl ? ` (${_recLbl})` : '') : '');
                            case 'wind': return e.bestWind != null ? String(e.bestWind) : (heat.wind != null ? String(heat.wind) : '');
                            case 'remark': return remarkStr;
                            default: return '';
                        }
                    });

                    // ─── 비고 자동 줄바꿈 + 행높이 자동 확장 (긴 텍스트 대비) ───
                    // wrapCols 에 'remark' 포함 → drawTableRow 가 heightOfString 으로 측정하여 rowH 자동 확장.
                    // alignByCol: 비고는 좌측 정렬(이름 리스트가 길 때 가독성 향상)
                    // smallFontCols: 비고만 작은 폰트(7pt)로 줄여 좁은 컬럼 안에 더 잘 들어가게 함
                    const drawOpts = {
                        boldCols: ['name', 'record'],
                        wrapCols: ['remark'],
                        alignByCol: { remark: 'left' },
                        smallFontCols: { remark: Math.max(7, fontSize - 1) }
                    };
                    // 페이지 break 안전성: drawTableRow 가 행 높이를 늘릴 수 있으므로
                    // 실제 그리기 전에 heightOfString 으로 정확히 측정하고, 자리 부족하면 페이지 추가.
                    // ⚠️ 단순 \n 개수 기반 추정은 부정확함 — 비고 컬럼 너비가 좁아서 PDFKit이
                    //   자동 줄바꿈으로 추가 라인을 만들 수 있기 때문 (예: "김현우(15:20.06)"이
                    //   한 줄에 안 들어가서 2줄이 됨). 반드시 heightOfString 으로 실측해야 함.
                    let estRowH = dataRowH2;
                    if (remarkStr) {
                        const remarkCol = rsCols.find(c => c.key === 'remark');
                        if (remarkCol) {
                            const remarkFs = drawOpts.smallFontCols.remark;
                            pdfFont(doc, false).fontSize(remarkFs);
                            try {
                                const measured = doc.heightOfString(remarkStr, {
                                    width: remarkCol.w - 4,
                                    align: 'left',
                                    lineGap: 0.5
                                });
                                estRowH = Math.max(estRowH, Math.ceil(measured) + 16);
                            } catch (_) {
                                // 실측 실패시 폴백 — \n 기반 추정에 안전 마진 추가
                                const lineCount = (remarkStr.match(/\n/g) || []).length + 1;
                                estRowH = Math.max(estRowH, lineCount * 2 * (remarkFs + 2) + 16);
                            }
                        }
                    }
                    if (curY + estRowH > BODY_BOTTOM) {
                        doc.addPage(); curY = drawEventTopHeader(doc);
                        curY = drawTableHeader(doc, rsCols, curY, tableLeft, tableRight, fontSize);
                    }
                    curY = drawTableRow(doc, rsCols, vals, curY, tableLeft, tableRight, fontSize, drawOpts);
                }
                curY += 8;
            }
        }

        // [PAGE-REPEAT] 모든 페이지에 상단 헤더(이미 본문 그릴 때 그렸음) + 하단 박스 보장
        // bufferPages: true 옵션 덕에 doc.bufferedPageRange() 로 전체 페이지 순회 가능.
        // 본문은 이미 BODY_BOTTOM 위까지만 그렸으므로 하단은 비어 있음 → 박스 안전하게 추가.
        // 단, 마지막 페이지에서 본문이 너무 짧게 끝났더라도 박스는 페이지 하단 고정 위치에 그려야 함.
        try {
            const range = doc.bufferedPageRange(); // { start, count }
            for (let i = range.start; i < range.start + range.count; i++) {
                doc.switchToPage(i);
                // 페이지 마다 상단 헤더는 본문 그릴 때 이미 그렸지만, 첫 페이지 외에 누락 가능성 방어
                // → 본문 그리는 곳 모두에서 drawEventTopHeader 를 호출하므로 여기서는 하단 박스만 그림
                drawEventBottomBox(doc);
            }
        } catch (e) { console.warn('[result-sheet] page-repeat error:', e.message); }

        // Branding footer (마지막 페이지에만 그릴 수도 있고 모든 페이지에 그릴 수도 있음.
        // 기존 동작 유지: 마지막 페이지에만 푸터 — drawBrandingFooter 가 현재 페이지에 그리므로
        // 위 루프 종료 후 마지막 페이지가 활성 상태 → 그대로 호출하면 마지막 페이지에 그려짐.)
        // [개선] 모든 페이지에 푸터도 같이 그리도록 변경
        try {
            const range = doc.bufferedPageRange();
            for (let i = range.start; i < range.start + range.count; i++) {
                doc.switchToPage(i);
                drawBrandingFooter(doc, pageW, pageH, margin);
            }
        } catch (e) { drawBrandingFooter(doc, pageW, pageH, margin); }
        doc.end();
      } catch (err) {
        console.error('[Result Sheet Error]', err);
        if (!res.headersSent) {
            res.status(500).json({ error: '기록지 생성 오류: ' + err.message });
        }
      }
    });

    /**
     * GET /api/documents/result-sheet/:eventId/png
     * PDF 결과지와 동일한 레이아웃을 PNG 이미지로 변환하여 반환
     * 내부적으로 result-sheet PDF를 생성한 후 pdftoppm으로 PNG 변환
     */
    app.get('/api/documents/result-sheet/:eventId/png', async (req, res) => {
        const eventId = req.params.eventId;
        const tmpDir = '/tmp/pacerise_png_' + Date.now() + '_' + eventId;
        try {
            // Step 1: Generate PDF internally by calling our own endpoint
            const pdfUrl = `http://localhost:${PORT}/api/documents/result-sheet/${eventId}`;
            const pdfResp = await fetch(pdfUrl);
            if (!pdfResp.ok) {
                return res.status(pdfResp.status).json({ error: 'PDF generation failed' });
            }
            const pdfBuffer = Buffer.from(await pdfResp.arrayBuffer());

            // Step 2: Write PDF to temp file
            fs.mkdirSync(tmpDir, { recursive: true });
            const pdfPath = path.join(tmpDir, 'result.pdf');
            fs.writeFileSync(pdfPath, pdfBuffer);

            // Step 3: Convert PDF pages to PNG using pdftoppm (300 DPI)
            const pngPrefix = path.join(tmpDir, 'page');
            execSync(`pdftoppm -png -r 300 "${pdfPath}" "${pngPrefix}"`, { timeout: 15000 });

            // Step 4: Read all generated PNG files
            const pngFiles = fs.readdirSync(tmpDir)
                .filter(f => f.startsWith('page') && f.endsWith('.png'))
                .sort();

            if (pngFiles.length === 0) {
                throw new Error('PNG conversion produced no files');
            }

            if (pngFiles.length === 1) {
                // Single page — return directly
                const pngData = fs.readFileSync(path.join(tmpDir, pngFiles[0]));
                res.setHeader('Content-Type', 'image/png');
                res.setHeader('Content-Disposition', `attachment; filename="result_${eventId}.png"`);
                res.send(pngData);
            } else {
                // Multiple pages — stitch vertically using node-canvas
                const images = pngFiles.map(f => {
                    const data = fs.readFileSync(path.join(tmpDir, f));
                    const img = new (require('canvas').Image)();
                    img.src = data;
                    return img;
                });
                const totalW = images[0].width;
                const totalH = images.reduce((sum, img) => sum + img.height, 0);
                const stitched = createCanvas(totalW, totalH);
                const sctx = stitched.getContext('2d');
                let offsetY = 0;
                for (const img of images) {
                    sctx.drawImage(img, 0, offsetY);
                    offsetY += img.height;
                }
                const pngBuf = stitched.toBuffer('image/png');
                res.setHeader('Content-Type', 'image/png');
                res.setHeader('Content-Disposition', `attachment; filename="result_${eventId}.png"`);
                res.send(pngBuf);
            }
        } catch (err) {
            console.error('[Result Sheet PNG Error]', err);
            if (!res.headersSent) {
                res.status(500).json({ error: 'PNG 생성 오류: ' + err.message });
            }
        } finally {
            // Cleanup temp files
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e) {}
        }
    });

    function formatTimeForPDF(s) {
        if (s == null) return '';
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

    // AD Card PDF — 선수 인가증 (Template-aware)
    app.get('/api/documents/ad-card/:compId', async (req, res) => {
        const comp = await db.get('SELECT * FROM competition WHERE id=?', req.params.compId);
        if (!comp) return res.status(404).json({ error: 'Competition not found' });
        let athletes = await db.all(`SELECT * FROM athlete WHERE competition_id=? ORDER BY ${orderByBibSql()}`, comp.id);
        // 참가 종목을 한 번에 읽는다 (선수마다 조회하지 않는다). 예선·결승처럼 같은 종목의 라운드는 한 줄로 합친다.
        const _entryRows = await db.all(`
            SELECT ee.athlete_id, e.id AS event_id, e.name, e.category FROM event_entry ee
            JOIN event e ON e.id = ee.event_id
            WHERE e.competition_id = ? AND e.parent_event_id IS NULL
            ORDER BY e.sort_order, e.id`, comp.id);
        const _eventsOf = new Map();
        for (const r of _entryRows) { if (!_eventsOf.has(r.athlete_id)) _eventsOf.set(r.athlete_id, []); _eventsOf.get(r.athlete_id).push(r); }
        // 계주 팀은 athlete 테이블에 '가상 선수'로 들어 있다 — 사람에게 주는 ID카드 대상이 아니다
        const _isRelayTeam = a => /^RELAY_/.test(a.barcode || '') || ((_eventsOf.get(a.id) || []).length > 0 && (_eventsOf.get(a.id) || []).every(e => e.category === 'relay') && a.name === a.team);
        athletes = athletes.filter(a => !_isRelayTeam(a));
        // 필터: ?team= / ?gender=M|F / ?event_id= / ?athlete_ids=1,2,3 — 추가 등록·분실 재발급 때 전체를 다시 뽑지 않도록
        if (req.query.team) athletes = athletes.filter(a => (a.team || '') === String(req.query.team));
        if (req.query.gender) athletes = athletes.filter(a => a.gender === String(req.query.gender).toUpperCase());
        if (req.query.event_id) { const eid = Number(req.query.event_id); athletes = athletes.filter(a => (_eventsOf.get(a.id) || []).some(e => e.event_id === eid)); }
        if (req.query.athlete_ids) { const ids = new Set(String(req.query.athlete_ids).split(',').map(Number)); athletes = athletes.filter(a => ids.has(a.id)); }
        // ?bibs=12,W31,105 — 배번으로 지정 (W 접두 = 여자, M 접두 = 남자. 접두가 없으면 그 배번의 남녀 모두)
        if (req.query.bibs) {
            const want = String(req.query.bibs).split(/[\s,]+/).filter(Boolean).map(t => { const m = t.match(/^([WwFfMm])?-?0*(\d+)$/); return m ? { g: m[1] ? (/[Mm]/.test(m[1]) ? 'M' : 'F') : null, bib: m[2] } : { g: null, bib: t }; });
            athletes = athletes.filter(a => want.some(w => String(a.bib_number || '').replace(/^0+/, '') === w.bib && (!w.g || a.gender === w.g)));
        }
        if (athletes.length === 0) return res.status(404).json({ error: 'No athletes found' });
        const tpl = (await getDocTemplate(comp.id)).ad_card;
        // 바코드는 소집실 스캔에 쓰인다. 설정 화면이 없어 저장값(false)은 사용자의 선택이 아니므로 기본으로 넣고, ?barcode=0 일 때만 뺀다.
        const showBarcode = String(req.query.barcode || '') !== '0';
        const barcodeValueOf = a => {
            const bc = String(a.barcode || '').trim();
            if (bc && code128.encode(bc)) return bc;
            const bib = String(a.bib_number || '').trim();
            if (!bib || !code128.encode(bib)) return '';
            return a.gender === 'F' ? `W${bib}` : bib;      // 남녀 배번이 겹치는 대회가 있어 여자는 W 접두(소집실 스캔 규칙과 동일)
        };

        const cardsPerPage = [1, 2, 4].includes(Number(req.query.per_page)) ? Number(req.query.per_page) : (tpl.cards_per_page || 4);      // ?per_page=1|2|4 로 발급 때 바로 고른다
        const bibSize = tpl.bib_font_size || 48;
        const nameSize = tpl.name_font_size || 16;
        const bandMode = tpl.band_color_mode || 'gender_auto';
        const customColor = tpl.custom_band_color || '#2d9d78';

        const doc = new PDFDocument({ size: 'A4', margin: 20, bufferPages: true });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Content-Disposition', `inline; filename="ad-cards_${comp.id}.pdf"`);
        doc.pipe(res);

        // Layout calculation based on cards_per_page
        let CARD_W, CARD_H, COLS, ROWS, GAP_X, GAP_Y, START_X, START_Y;
        if (cardsPerPage === 1) {
            CARD_W = 515; CARD_H = 760; COLS = 1; ROWS = 1; GAP_X = 0; GAP_Y = 0; START_X = 40; START_Y = 30;
        } else if (cardsPerPage === 2) {
            CARD_W = 400; CARD_H = 360; COLS = 1; ROWS = 2; GAP_X = 0; GAP_Y = 20; START_X = 98; START_Y = 25;
        } else {
            CARD_W = 260; CARD_H = 360; COLS = 2; ROWS = 2; GAP_X = 15; GAP_Y = 15; START_X = 25; START_Y = 25;
        }

        for (let idx = 0; idx < athletes.length; idx++) {
            const athlete = athletes[idx];
            if (idx > 0 && idx % cardsPerPage === 0) doc.addPage();
            const posInPage = idx % cardsPerPage;
            const col = posInPage % COLS;
            const row = Math.floor(posInPage / COLS) % ROWS;
            const x = START_X + col * (CARD_W + GAP_X);
            const y = START_Y + row * (CARD_H + GAP_Y);

            // Card border
            doc.save();
            doc.roundedRect(x, y, CARD_W, CARD_H, 8).stroke('#333');

            // Header band color
            let bandColor;
            if (bandMode === 'custom') {
                bandColor = customColor;
            } else {
                bandColor = athlete.gender === 'M' ? '#2196F3' : athlete.gender === 'F' ? '#E91E63' : '#FFC107';
            }
            doc.rect(x, y, CARD_W, 40).fill(bandColor);

            // Competition name on band
            pdfFont(doc, true).fontSize(cardsPerPage === 1 ? 12 : 8).fillColor('#fff');
            doc.text(comp.name, x + 10, y + 6, { width: CARD_W - 20, align: 'center', height: cardsPerPage === 1 ? 16 : 12, ellipsis: true });
            pdfFont(doc, false).fontSize(cardsPerPage === 1 ? 8 : 6).fillColor('#fff');
            doc.text('ACCREDITATION / AD CARD', x + 10, y + (cardsPerPage === 1 ? 26 : 22), { width: CARD_W - 20, align: 'center' });

            let contentY = y + 55;
            const centerX = x + 10;
            const contentW = CARD_W - 20;

            // Bib number (conditional)
            if (tpl.show_bib !== false) {
                pdfFont(doc, true).fontSize(bibSize).fillColor('#1a1a1a');
                doc.text(athlete.bib_number || '-', centerX, contentY, { width: contentW, align: 'center' });
                contentY += bibSize + (cardsPerPage === 1 ? 20 : 12);
            }

            // Name (conditional)
            if (tpl.show_name !== false) {
                pdfFont(doc, true).fontSize(nameSize).fillColor('#333');
                // 긴 이름(외국 선수 등)은 잘라내지 않고 글자를 줄여 한 줄에 맞춘다
                let _ns = nameSize;
                while (_ns > 9 && doc.widthOfString(athlete.name || '') > contentW) { _ns -= 1; doc.fontSize(_ns); }
                doc.text(athlete.name || '', centerX, contentY + (nameSize - _ns) / 2, { width: contentW, align: 'center', height: _ns + 6, ellipsis: true });
                contentY += nameSize + 10;
            }

            // Team (conditional)
            if (tpl.show_team !== false) {
                pdfFont(doc, false).fontSize(cardsPerPage === 1 ? 14 : 11).fillColor('#666');
                doc.text(athlete.team || '', centerX, contentY, { width: contentW, align: 'center', height: cardsPerPage === 1 ? 20 : 15, ellipsis: true });
                contentY += (cardsPerPage === 1 ? 24 : 18);
            }

            // Gender label (conditional)
            if (tpl.show_gender !== false) {
                const gLabel = athlete.gender === 'M' ? 'MALE' : athlete.gender === 'F' ? 'FEMALE' : 'MIXED';
                pdfFont(doc, true).fontSize(9).fillColor(bandColor);
                doc.text(gLabel, centerX, contentY, { width: contentW, align: 'center' });
                contentY += 18;
            }

            // Events enrolled (conditional)
            if (tpl.show_events !== false) {
                const _seen = new Set();
                const events = (_eventsOf.get(athlete.id) || []).filter(e => !_seen.has(e.name) && _seen.add(e.name));

                contentY += 5;
                pdfFont(doc, true).fontSize(7).fillColor('#999');
                doc.text('EVENTS', centerX, contentY, { width: contentW, align: 'center' });
                contentY += 12;
                pdfFont(doc, false).fontSize(8).fillColor('#333');
                const maxEvents = cardsPerPage === 1 ? 12 : 6;
                for (const ev of events.slice(0, maxEvents)) {
                    doc.text(ev.name, centerX, contentY, { width: contentW, align: 'center' });
                    contentY += 11;
                }
                if (events.length > maxEvents) {
                    doc.text(`+${events.length - maxEvents} more`, centerX, contentY, { width: contentW, align: 'center' });
                }
            }

            // 바코드 (Code 128) — 소집실 스캐너가 읽는 값: 등록된 바코드, 없으면 배번(여자는 W 접두)
            if (showBarcode) {
                const bcVal = barcodeValueOf(athlete);
                const barcodeY = y + CARD_H - (cardsPerPage === 1 ? 110 : 80);
                if (bcVal && code128.drawPdf(doc, bcVal, centerX, barcodeY, { width: contentW, height: cardsPerPage === 1 ? 44 : 28 })) {
                    pdfFont(doc, false).fontSize(cardsPerPage === 1 ? 9 : 7).fillColor('#555');
                    doc.text(bcVal, centerX, barcodeY + (cardsPerPage === 1 ? 48 : 31), { width: contentW, align: 'center' });
                }
            }

            // Footer with comp venue & dates
            pdfFont(doc, false).fontSize(6).fillColor('#aaa');
            doc.text(`${comp.venue || ''} | ${comp.start_date} ~ ${comp.end_date}`, centerX, y + CARD_H - 30, { width: contentW, align: 'center' });
            pdfFont(doc, false).fontSize(5).fillColor('#ccc');
            doc.text('PACE RISE Competition OS', centerX, y + CARD_H - 18, { width: contentW, align: 'center' });

            doc.restore();
        }

        doc.end();
    });
};
