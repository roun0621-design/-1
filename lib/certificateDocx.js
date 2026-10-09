'use strict';
/**
 * 상장 워드(.docx) 생성 — 받는 쪽에서 내용을 바로 고칠 수 있는 편집용 파일. 워드·한컴오피스(한글) 모두 .docx 를 연다.
 *   양식은 '워드 상장 양식'(lib/awardDocxTemplate.js) — PDF 양식(certificate_template)과 별개다.
 *   구성: 발급번호 / 제목 / 종목·순위·기록·소속·성명(계주는 선수 명단) / 본문 / 날짜 / 수여자(직인 자리) — 한 사람당 한 쪽
 *
 *   generateCertificateDocx(config, items) → Promise<Buffer>
 *     config: awardDocxTemplate.normalize() 결과
 *     items:  [{ athlete_name, team, event_name, gender, division, rank, record_value, wind, heat_number, members[], competition_name }]
 */
const JSZip = require('jszip');
const { renderRankLabel, fillTemplate } = require('./certificatePdf');
const { normalize } = require('./awardDocxTemplate');

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
let FONT = '바탕';       // 양식의 글꼴(생성 시작 때 설정). PC 에 없으면 워드/한글이 기본 글꼴로 대체한다.
const genderLabel = g => (g === 'M' ? '남자' : g === 'F' ? '여자' : g === 'X' ? '혼성' : '');

function todayKR() { const d = new Date(); return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`; }

// 문단 하나. opts: { size(pt), bold, align, spacingBefore, spacingAfter(pt), line(배수), charSpacing(pt), indentLeft(cm), color, pageBreakBefore }
function para(text, o = {}) {
    const lines = String(text == null ? '' : text).split(/\r?\n/);
    const rPr = `<w:rPr><w:rFonts w:ascii="${FONT}" w:hAnsi="${FONT}" w:eastAsia="${FONT}" w:cs="${FONT}"/>${o.bold ? '<w:b/>' : ''}` +
        `${o.color ? `<w:color w:val="${o.color}"/>` : ''}${o.charSpacing ? `<w:spacing w:val="${Math.round(o.charSpacing * 20)}"/>` : ''}` +
        `<w:sz w:val="${Math.round((o.size || 14) * 2)}"/><w:szCs w:val="${Math.round((o.size || 14) * 2)}"/></w:rPr>`;
    const runs = lines.map((ln, i) => `${i > 0 ? '<w:r><w:br/></w:r>' : ''}<w:r>${rPr}<w:t xml:space="preserve">${esc(ln)}</w:t></w:r>`).join('');
    // wordWrap=0: 한글을 글자 단위로 자르지 않고 띄어쓰기에서 줄바꿈 ('육상경/기대회' 처럼 단어가 쪼개지지 않게)
    //   ※ pPr 자식 순서는 스키마로 정해져 있다(pageBreakBefore → wordWrap → spacing → ind → jc). 어기면 워드가 '손상된 파일'로 본다.
    const pPr = `<w:pPr>${o.pageBreakBefore ? '<w:pageBreakBefore/>' : ''}<w:wordWrap w:val="0"/>` +
        `<w:spacing w:before="${Math.round((o.spacingBefore || 0) * 20)}" w:after="${Math.round((o.spacingAfter || 0) * 20)}" w:line="${Math.round((o.line || 1.15) * 240)}" w:lineRule="auto"/>` +
        `${o.indentLeft ? `<w:ind w:left="${Math.round(o.indentLeft * 567)}"/>` : ''}<w:jc w:val="${o.align || 'left'}"/></w:pPr>`;
    return `<w:p>${pPr}${runs}</w:p>`;
}

// "종 목 : 남자 100m" 형식의 항목 줄 (라벨 폭을 맞추기 위해 탭 사용)
function fieldLine(label, value, o = {}) {
    const size = o.size || 18;
    const rPr = b => `<w:rPr><w:rFonts w:ascii="${FONT}" w:hAnsi="${FONT}" w:eastAsia="${FONT}" w:cs="${FONT}"/>${b ? '<w:b/>' : ''}<w:sz w:val="${size * 2}"/><w:szCs w:val="${size * 2}"/></w:rPr>`;
    return `<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="${Math.round((o.indent || 3.2) * 567 + 1900 * size / 18)}"/></w:tabs>` +
        `<w:spacing w:before="0" w:after="${Math.round((o.after == null ? 6 : o.after) * 20)}" w:line="300" w:lineRule="auto"/><w:ind w:left="${Math.round((o.indent || 3.2) * 567)}"/></w:pPr>` +
        `<w:r>${rPr(false)}<w:t xml:space="preserve">${esc(label)}</w:t></w:r><w:r>${rPr(false)}<w:tab/></w:r>` +
        `<w:r>${rPr(true)}<w:t xml:space="preserve">${esc(value)}</w:t></w:r></w:p>`;
}

function certificateBody(cfg, it, idx) {
    const rankLabel = renderRankLabel(it.rank, cfg.rank_label_style || 'numeric');
    const eventFull = [genderLabel(it.gender), it.division ? `${String(it.division).replace(/부$/, '')}부` : '', it.event_name].filter(Boolean).join(' ')
        + (it.heat_number != null ? ` ${it.heat_number}조` : '');
    const date = (cfg.award_date && cfg.award_date.trim()) || todayKR();          // 비우면 출력하는 날(시상일)
    const windTxt = (cfg.show_wind && it.wind != null && it.wind !== '') ? `(풍속 ${Number(it.wind) > 0 ? '+' : ''}${Number(it.wind).toFixed(1)})` : '';
    const record = [it.record_value || '', windTxt].filter(Boolean).join(' ');
    const vars = {
        athlete_name: it.athlete_name || '', team: it.team || '', event_name: eventFull, rank_label: rankLabel,
        record_value: it.record_value || '', record: it.record_value || '', date, competition_name: it.competition_name || '', comp_name: it.competition_name || '',
    };
    const isTeam = Array.isArray(it.members) && it.members.filter(Boolean).length > 0;
    const body = fillTemplate(isTeam && cfg.body_template_team ? cfg.body_template_team : cfg.body_template, vars);
    const year = (String(date).match(/\d{4}/) || [String(new Date().getFullYear())])[0];
    const serial = fillTemplate(cfg.serial_format, { year, seq: String((cfg.serial_start || 1) + idx).padStart(3, '0'), event: it.event_name || '' });
    const members = Array.isArray(it.members) ? it.members.filter(Boolean) : [];
    const fs = cfg.field_size;
    const indent = cfg.paper_orientation === 'landscape' ? 7.2 : 3.2;      // 항목 줄 왼쪽 들여쓰기(cm) — 가로 용지는 가운데로 더 민다

    const out = [];
    // 첫 문단이 쪽 나눔을 맡는다 — 발급번호를 숨겨도 빈 문단으로 자리를 지켜 제목 위치가 같게 한다
    out.push(para(cfg.show_serial ? serial : '', { size: 12, align: 'left', spacingAfter: 18, pageBreakBefore: idx > 0 }));
    out.push(para(cfg.title_text, { size: cfg.title_size, bold: true, align: 'center', charSpacing: 12, spacingBefore: 6, spacingAfter: 30 }));
    if (cfg.show_event) out.push(fieldLine('종    목 :', eventFull, { size: fs, indent }));
    if (cfg.show_rank && rankLabel) out.push(fieldLine('순    위 :', rankLabel, { size: fs, indent }));
    if (cfg.show_record && record) out.push(fieldLine('기    록 :', record, { size: fs, indent }));
    if (members.length && cfg.show_members) {
        // 계주: 팀이 수상자 — 소속(팀명) + 선수 명단
        out.push(fieldLine('소    속 :', it.team || it.athlete_name || '', { size: fs, indent }));
        out.push(fieldLine('선    수 :', members.join('  '), { size: fs, indent, after: 30 }));
    } else {
        if (cfg.show_team && it.team && it.team !== it.athlete_name) out.push(fieldLine('소    속 :', it.team, { size: fs, indent }));
        out.push(fieldLine('성    명 :', it.athlete_name || '', { size: fs, indent, after: 30 }));
    }
    out.push(para(body, { size: cfg.body_size, align: 'center', line: 1.7, spacingBefore: 12, spacingAfter: 36 }));
    if (cfg.show_date) out.push(para(date, { size: cfg.date_size, align: 'center', spacingAfter: 30 }));
    if (cfg.signer_org) out.push(para(cfg.signer_org, { size: cfg.signer_size, bold: true, align: 'center', charSpacing: 2, spacingAfter: 4 }));
    const signer = [cfg.signer_title || '', cfg.signer_name || ''].filter(Boolean).join('  ');
    const signLine = [signer, cfg.seal_mark || ''].filter(Boolean).join('   ');
    if (signLine) out.push(para(signLine, { size: cfg.signer_size, bold: true, align: 'center', charSpacing: 2 }));
    return out.join('');
}

async function generateCertificateDocx(template, items) {
    const tpl = normalize(template);
    FONT = esc(tpl.font_family);
    const landscape = tpl.paper_orientation === 'landscape';
    const W = landscape ? 16838 : 11906, H = landscape ? 11906 : 16838;      // A4 (twips)
    const borderColor = String(tpl.border_color || '#b8945a').replace('#', '');
    const border = tpl.border_style === 'none' ? '' :
        `<w:pgBorders w:offsetFrom="page">${['top', 'left', 'bottom', 'right'].map(sd =>
            `<w:${sd} w:val="${tpl.border_style === 'single' ? 'single' : 'double'}" w:sz="18" w:space="24" w:color="${borderColor}"/>`).join('')}</w:pgBorders>`;
    const bodyXml = (items || []).map((it, i) => certificateBody(tpl, it, i)).join('');
    const sect = `<w:sectPr><w:pgSz w:w="${W}" w:h="${H}"${landscape ? ' w:orient="landscape"' : ''}/>` +
        `<w:pgMar w:top="1985" w:right="1417" w:bottom="1701" w:left="1417" w:header="720" w:footer="720" w:gutter="0"/>${border}</w:sectPr>`;
    const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}${sect}</w:body></w:document>`;
    const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr>` +
        `<w:rFonts w:ascii="${FONT}" w:hAnsi="${FONT}" w:eastAsia="${FONT}" w:cs="${FONT}"/><w:lang w:val="en-US" w:eastAsia="ko-KR"/><w:sz w:val="28"/></w:rPr></w:rPrDefault></w:docDefaults>` +
        `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`;

    const zip = new JSZip();
    zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
        `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`);
    zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
    zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
    zip.file('word/document.xml', document);
    zip.file('word/styles.xml', styles);
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { generateCertificateDocx };
