#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
결과보고서 생성기 (PACE RISE : Node)
- 거래처(을: 주식회사 에스피씨티솔루션) 양식으로 작성
- 일반용역비 양식 내 과업지시서/용역계약서/검수조서 기준 실제 수행 내용 반영
- 품목별 증빙사진 6종 첨부
실제 수행한 작업만 기재 (과장/허위 금지)
"""
from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml.ns import qn
from docx.oxml import OxmlElement
import os

BASE = '/home/user/webapp'
IMG = os.path.join(BASE, 'evidence', '품목별증빙사진')
OUT = os.path.join(BASE, 'evidence', '결과보고서', '결과보고서_PACE-RISE_Node.docx')

FONT = '맑은 고딕'
FONT_FALLBACK = 'Noto Sans CJK KR'

NAVY = RGBColor(0x1F, 0x37, 0x64)
GRAY = RGBColor(0x55, 0x55, 0x55)
LIGHT = 'EAF0F8'


def set_kfont(run, size=None, bold=None, color=None):
    run.font.name = FONT
    r = run._element
    rpr = r.get_or_add_rPr()
    rfonts = rpr.find(qn('w:rFonts'))
    if rfonts is None:
        rfonts = OxmlElement('w:rFonts')
        rpr.append(rfonts)
    for a in ('w:eastAsia', 'w:ascii', 'w:hAnsi', 'w:cs'):
        rfonts.set(qn(a), FONT)
    if size is not None:
        run.font.size = Pt(size)
    if bold is not None:
        run.font.bold = bold
    if color is not None:
        run.font.color.rgb = color


def shade(cell, hexcolor):
    tcpr = cell._tc.get_or_add_tcPr()
    sh = OxmlElement('w:shd')
    sh.set(qn('w:val'), 'clear')
    sh.set(qn('w:fill'), hexcolor)
    tcpr.append(sh)


def set_cell_text(cell, text, size=10, bold=False, color=None, align=None, shade_hex=None):
    cell.text = ''
    p = cell.paragraphs[0]
    if align is not None:
        p.alignment = align
    parts = str(text).split('\n')
    for i, line in enumerate(parts):
        if i > 0:
            p = cell.add_paragraph()
            if align is not None:
                p.alignment = align
        run = p.add_run(line)
        set_kfont(run, size=size, bold=bold, color=color)
    if shade_hex:
        shade(cell, shade_hex)


def add_para(doc, text='', size=10.5, bold=False, color=None, align=None, space_after=6, space_before=0):
    p = doc.add_paragraph()
    if align is not None:
        p.alignment = align
    p.paragraph_format.space_after = Pt(space_after)
    p.paragraph_format.space_before = Pt(space_before)
    if text:
        run = p.add_run(text)
        set_kfont(run, size=size, bold=bold, color=color)
    return p


def add_heading(doc, num, title):
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(14)
    p.paragraph_format.space_after = Pt(6)
    run = p.add_run(f'{num}. {title}')
    set_kfont(run, size=13, bold=True, color=NAVY)
    # underline bar
    pPr = p._p.get_or_add_pPr()
    pbdr = OxmlElement('w:pBdr')
    bottom = OxmlElement('w:bottom')
    bottom.set(qn('w:val'), 'single')
    bottom.set(qn('w:sz'), '12')
    bottom.set(qn('w:space'), '4')
    bottom.set(qn('w:color'), '1F3764')
    pbdr.append(bottom)
    pPr.append(pbdr)
    return p


def style_table(table):
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    tbl = table._tbl
    borders = OxmlElement('w:tblBorders')
    for edge in ('top', 'left', 'bottom', 'right', 'insideH', 'insideV'):
        e = OxmlElement(f'w:{edge}')
        e.set(qn('w:val'), 'single')
        e.set(qn('w:sz'), '6')
        e.set(qn('w:space'), '0')
        e.set(qn('w:color'), 'AAB4C4')
        borders.append(e)
    tblPr = tbl.tblPr
    tblPr.append(borders)


# ---------------------------------------------------------------------------
doc = Document()

# default style
st = doc.styles['Normal']
st.font.name = FONT
st.font.size = Pt(10.5)
st.element.rPr.rFonts.set(qn('w:eastAsia'), FONT)

sec = doc.sections[0]
sec.top_margin = Cm(2.0)
sec.bottom_margin = Cm(2.0)
sec.left_margin = Cm(2.2)
sec.right_margin = Cm(2.2)

# ===== 표지 =====
for _ in range(3):
    add_para(doc, '', space_after=2)
add_para(doc, '결 과 보 고 서', size=30, bold=True, color=NAVY,
         align=WD_ALIGN_PARAGRAPH.CENTER, space_after=10)
add_para(doc, '', space_after=2)
add_para(doc, '육상경기 운영플랫폼(COS) 모바일 앱 개발 및\n웹·인프라 고도화',
         size=15, bold=True, align=WD_ALIGN_PARAGRAPH.CENTER, space_after=30)
add_para(doc, '― PACE RISE : Node ―', size=12, color=GRAY,
         align=WD_ALIGN_PARAGRAPH.CENTER, space_after=60)

# 표지 정보 박스
cover = doc.add_table(rows=4, cols=2)
cover.alignment = WD_TABLE_ALIGNMENT.CENTER
style_table(cover)
cover_data = [
    ('용 역 명', '육상경기 운영플랫폼(COS) 모바일 앱 개발 및 웹·인프라 고도화'),
    ('용역기간', '2026. 4. 28. ~ 2026. 6. 18.'),
    ('용역완료일자', '2026. 6. 18.'),
    ('용역업체(을)', '주식회사 에스피씨티솔루션      (인)'),
]
for i, (k, v) in enumerate(cover_data):
    set_cell_text(cover.rows[i].cells[0], k, size=11, bold=True,
                  align=WD_ALIGN_PARAGRAPH.CENTER, shade_hex=LIGHT)
    set_cell_text(cover.rows[i].cells[1], v, size=11,
                  align=WD_ALIGN_PARAGRAPH.CENTER)
cover.columns[0].width = Cm(4.0)
cover.columns[1].width = Cm(12.0)

add_para(doc, '', space_after=80)
add_para(doc, '2026. 6. 18.', size=13, bold=True,
         align=WD_ALIGN_PARAGRAPH.CENTER, space_after=6)
add_para(doc, '주식회사 에스피씨티솔루션  (인)', size=13, bold=True,
         align=WD_ALIGN_PARAGRAPH.CENTER, space_after=4)

doc.add_page_break()

# ===== 1. 용역 개요 =====
add_heading(doc, 'Ⅰ', '용역 개요')
ov = doc.add_table(rows=5, cols=2)
style_table(ov)
ov_data = [
    ('1. 용역명', '육상경기 운영플랫폼(COS) 모바일 앱 개발 및 웹·인프라 고도화'),
    ('2. 용역기간', '2026. 4. 28. ~ 2026. 6. 18. (계약 체결일 ~ 완료일)'),
    ('3. 용역금액', '금20,000,000원(VAT 별도) / 부가세 포함 금22,000,000원'),
    ('4. 용역목적', 'COS(‘노드’ 경기운영시스템 포함)를 모바일 환경으로 확장하고,\n'
                  '대규모 경기 데이터의 안정적 처리를 위해 클라우드 인프라·보안·웹 사용성을 고도화'),
    ('5. 수행업체', '주식회사 에스피씨티솔루션 (을) / 발주처 주식회사 페이스라이즈 (갑)'),
]
for i, (k, v) in enumerate(ov_data):
    set_cell_text(ov.rows[i].cells[0], k, size=10, bold=True,
                  align=WD_ALIGN_PARAGRAPH.CENTER, shade_hex=LIGHT)
    set_cell_text(ov.rows[i].cells[1], v, size=10)
ov.columns[0].width = Cm(3.4)
ov.columns[1].width = Cm(12.6)
add_para(doc, '', space_after=4)

# ===== 2. 주요 수행 내용 =====
add_heading(doc, 'Ⅱ', '주요 수행 내용')
summary = [
    ('① 모바일 앱(PWA/Android TWA/iOS)',
     '기존 웹앱을 PWA(Web App Manifest + Service Worker + 오프라인 캐시)로 최적화하고, '
     'Android는 TWA로 래핑하여 App Bundle(AAB, 패키지 com.pacerise.node, v1.0.1)을 생성·서명, '
     'iOS는 Safari ‘홈 화면에 추가’ standalone 풀스크린 구동을 지원. '
     '실제 빌드·스토어 업로드는 발주처가 직접 수행하도록 앱 프로젝트 소스 일체와 빌드·배포 가이드 제공.'),
    ('② AWS 클라우드 마이그레이션',
     '단일 서버 운영 환경을 AWS 서울 리전(ap-northeast-2)으로 이전하여 전국·국제 규모 대회의 '
     '트래픽·데이터를 안정 처리. Node.js 20 / Express 운영 인스턴스 배포, PM2 무중단 운영 + '
     '헬스체크(/api/health) 구성, 운영 도메인(pace-rise-node.com) 연결.'),
    ('③ DB 전환·이관 (SQLite → PostgreSQL)',
     'PostgreSQL 15 스키마 이행(schema.pg.sql) 및 환경변수(DB_BACKEND) 기반 이중 백엔드 구성. '
     'FK 위상정렬 순서 이관 + 시퀀스 재설정으로 무결성 유지. '
     '전 테이블 건수 대조 검증(34개 테이블 / 7,075행 → 34 PASS · 0 FAIL, 전체 일치).'),
    ('④ 보안 (SSL/TLS · 접근 인증)',
     'Let’s Encrypt 인증서로 운영 도메인 전 구간 HTTPS(SSL/TLS) 적용(HTTP 200 확인), '
     'JWT 기반 로그인 인증 및 권한 분리(심판/운영/관리자), API 호출 속도 제한(RATE_LIMIT) 적용.'),
    ('⑤ 웹 UI/UX 고도화 (‘노드’ 경기운영시스템)',
     '심판·경기운영진 태스크 플로우 분석 기반으로 운영 프로세스 단순화. '
     '대회 목록을 주관 연맹(KAAF/KTFL/기타)별 그룹화·뱃지 체계로 개편하고 RECENT(진행/예정) 영역 신설, '
     '경기 운영 모니터(출전/소집 현황·실시간 출석 집계)·메인 홈 정보구조 개선. '
     'git 이력 기반 개편 전(ca3d736)·후(main) 비교 검증.'),
    ('⑥ 실시간 처리 · 동시접속 검증',
     'WebSocket(/ws/scoreboard) + SSE 기반 풀링 없는 실시간 push, PostgreSQL Connection Pool(max 20) '
     '기반 동시 연결 관리. 부하테스트 실측(동시 50/100/200/500 구간 에러율 0%, 동시 200 p95 약 400ms) 및 '
     '전국·국제 대회 실 운영 검증(공개 API /api/competitions 확인), Android·iOS 실기기 구동 확인.'),
]
for title, body in summary:
    p = add_para(doc, '', space_after=2, space_before=4)
    r = p.add_run(title)
    set_kfont(r, size=11, bold=True, color=NAVY)
    add_para(doc, body, size=10, space_after=6)

doc.add_page_break()

# ===== 3. 요구사항별 이행 내역 =====
add_heading(doc, 'Ⅲ', '요구사항별 이행 내역')
add_para(doc, '※ 과업지시서 요구사항(총 10건)에 대한 수행 결과 및 증빙 정보', size=9.5, color=GRAY, space_after=6)
req = doc.add_table(rows=1, cols=4)
style_table(req)
hdr = ['고유번호', '요구사항', '이행 결과', '증빙(산출정보)']
widths = [Cm(2.0), Cm(4.6), Cm(6.2), Cm(3.6)]
for i, h in enumerate(hdr):
    set_cell_text(req.rows[0].cells[i], h, size=9.5, bold=True,
                  align=WD_ALIGN_PARAGRAPH.CENTER, shade_hex='1F3764', color=RGBColor(0xFF,0xFF,0xFF))
req_rows = [
    ('ECR-001', 'AWS 클라우드 환경 구성',
     'AWS 서울 리전 운영 인스턴스 배포, PostgreSQL 연결, 도메인·HTTPS, PM2 무중단·헬스체크 구성 완료',
     'AWS 구성도, 실측 IP, /api/health 응답'),
    ('SFR-001', 'PWA 기반 모바일 앱(Android TWA)',
     'PWA 최적화 + Android TWA 래핑, AAB 빌드·서명(v1.0.1), iOS PWA 홈화면 설치 지원 완료',
     '앱 소스, AAB 산출물, 빌드·배포 가이드'),
    ('SFR-002', 'Cross-Device 반응형 화면',
     '공통 반응형 CSS 도입, 모바일 뷰포트 기준 레이아웃, 주요 5개 페이지 일괄 적용 완료',
     '개편 전·후 화면, responsive.css'),
    ('SFR-003', '‘노드’ 웹 UI/UX 개편',
     '연맹별 그룹화·뱃지 체계, RECENT 영역, 경기 운영 모니터·메인 홈 개편, git 전·후 비교 완료',
     '배포 URL, 개편 화면'),
    ('SFR-004', '실시간 기록 확인·제어 인터페이스',
     '출전 상태 분류·진행률 시각화, 종목·조·레인 단위 실시간 입력, 출석 실시간 집계, WebSocket+SSE push 완료',
     '적용 화면, 배포 URL'),
    ('DAR-001', 'SQLite→PostgreSQL 마이그레이션',
     'PostgreSQL 15 스키마 이행·이중 백엔드, FK 위상정렬 이관, 34테이블/7,075행 → 34 PASS·0 FAIL 검증',
     '이관 검증 리포트, schema.pg.sql'),
    ('SER-001', 'SSL/TLS 적용 및 접근 인증',
     'Let’s Encrypt 전 구간 HTTPS 적용(HTTP 200), JWT 인증·권한 분리, API 속도 제한 적용 완료',
     'SSL 검증 결과, 자물쇠 화면'),
    ('PER-001', '다수 동시접속 안정 처리',
     'Connection Pool(max 20), WebSocket+SSE, 동시 50~500 에러율 0%·동시200 p95 약 400ms, 실 운영 검증',
     '부하테스트 결과표, 실 운영 이력'),
    ('TER-001', '부하테스트·실증 운영·실기기 확인',
     '부하테스트(동시 500까지 무에러), vitest 단위테스트, 실 운영 검증, Android·iOS 실기기 구동 확인',
     '부하테스트 결과, 실기기 화면'),
    ('QUR-001', 'WA 표준 호환 및 코드 품질',
     'WA(세계육상연맹) 기록 보고 규격 준수, 모듈화 개선(2→33), vitest 회귀검증, Git 형상관리(276커밋)',
     '호환성 점검표, 테스트 결과'),
]
for r0 in req_rows:
    row = req.add_row()
    for ci, val in enumerate(r0):
        set_cell_text(row.cells[ci], val, size=8.5,
                      align=(WD_ALIGN_PARAGRAPH.CENTER if ci == 0 else None))
for i, w in enumerate(widths):
    req.columns[i].width = w
add_para(doc, '', space_after=4)

# ===== 4. 최종 산출물 =====
add_heading(doc, 'Ⅳ', '최종 산출물 (납품목록)')
deliv = doc.add_table(rows=1, cols=4)
style_table(deliv)
for i, h in enumerate(['구분', '납품목록', '수량', '형식']):
    set_cell_text(deliv.rows[0].cells[i], h, size=10, bold=True,
                  align=WD_ALIGN_PARAGRAPH.CENTER, shade_hex='1F3764', color=RGBColor(0xFF,0xFF,0xFF))
deliv_rows = [
    ('1', 'PWA 기반 앱 프로젝트 소스 일체 (Android TWA 래핑·AAB 빌드 설정 포함)', '1식', '전자파일'),
    ('2', '앱 빌드·배포 가이드 (Google Play 업로드용, 발주처 자체 수행)', '1부', '전자파일'),
    ('3', 'AWS 클라우드 아키텍처 구성도·실측 IP', '1부', '전자파일'),
    ('4', 'SQLite→PostgreSQL 이관 검증 리포트 (34테이블/7,075행)', '1부', '전자파일'),
    ('5', "HTTPS(SSL/TLS) 적용 내역서 (Let's Encrypt 인증서·자물쇠 화면)", '1부', '전자파일'),
    ('6', '‘노드’ 경기운영시스템 웹 UI/UX 개편 화면(전·후)·배포 URL', '1식', '전자파일'),
    ('7', '전체 소스코드 일체 (189파일/약 70,693행/276커밋, 소유권 발주처 귀속)', '1식', '전자파일'),
]
for r0 in deliv_rows:
    row = deliv.add_row()
    for ci, val in enumerate(r0):
        set_cell_text(row.cells[ci], val, size=9.5,
                      align=(None if ci == 1 else WD_ALIGN_PARAGRAPH.CENTER))
deliv.columns[0].width = Cm(1.4)
deliv.columns[1].width = Cm(10.6)
deliv.columns[2].width = Cm(2.0)
deliv.columns[3].width = Cm(2.0)

doc.add_page_break()

# ===== 5. 증빙 (품목별 증빙사진) =====
add_heading(doc, 'Ⅴ', '수행 결과 증빙 (실 운영 화면)')
add_para(doc, '※ 운영 서비스(pace-rise-node.com)에서 직접 캡처한 실제 화면입니다.',
         size=9.5, color=GRAY, space_after=8)

images = [
    ('01_메인화면_대회목록.png', '메인화면 – 연맹별 대회목록 (KAAF/KTFL 그룹화·RECENT 영역)'),
    ('02_경기운영_대시보드_KAAF배.png', '경기운영 대시보드 – KAAF배 제54회 + 코리아오픈'),
    ('03_경기운영_대시보드_제80회.png', '경기운영 대시보드 – 제80회 전국육상경기선수권 (부문별 운영)'),
    ('04_경기시간표_259경기.png', '경기시간표 – 259경기 5일치 타임테이블·결과 연동'),
    ('05_앱설치안내_PWA.png', '앱 설치 안내 – PWA (Android Chrome / iOS Safari 홈화면 추가)'),
    ('06_모바일반응형화면.png', '모바일 반응형 화면 – PWA Cross-Device 대응'),
]
for idx, (fn, cap) in enumerate(images):
    path = os.path.join(IMG, fn)
    if not os.path.exists(path):
        continue
    cap_p = add_para(doc, '', space_after=2, space_before=(8 if idx else 2))
    r = cap_p.add_run(f'[{idx+1}] {cap}')
    set_kfont(r, size=10, bold=True, color=NAVY)
    pic_p = doc.add_paragraph()
    pic_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    pic_p.paragraph_format.space_after = Pt(6)
    run = pic_p.add_run()
    run.add_picture(path, width=Cm(15.5))
    if idx % 2 == 1 and idx != len(images) - 1:
        doc.add_page_break()

# ===== 결재/날인 =====
add_para(doc, '', space_after=14, space_before=10)
add_para(doc,
         '상기와 같이 본 용역(육상경기 운영플랫폼(COS) 모바일 앱 개발 및 웹·인프라 고도화)을 '
         '계약 내용에 따라 성실히 수행하여 완료하였기에 그 결과를 보고합니다.',
         size=10.5, align=WD_ALIGN_PARAGRAPH.CENTER, space_after=24)
add_para(doc, '2026. 6. 18.', size=12, bold=True, align=WD_ALIGN_PARAGRAPH.CENTER, space_after=14)
add_para(doc, '수행업체 : 주식회사 에스피씨티솔루션      대표  김 동 식   (인)',
         size=11.5, bold=True, align=WD_ALIGN_PARAGRAPH.CENTER, space_after=2)
add_para(doc, '주식회사 페이스라이즈 귀하', size=11, align=WD_ALIGN_PARAGRAPH.CENTER, space_after=2)

os.makedirs(os.path.dirname(OUT), exist_ok=True)
doc.save(OUT)
print('saved:', OUT)

