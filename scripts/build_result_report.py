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

# ── 색상 정책 : 글씨는 모두 검정, 배경(음영)은 모두 화이트 ──
BLACK = RGBColor(0x00, 0x00, 0x00)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
# 기존 코드 호환을 위해 동일 이름 유지하되 전부 검정/흰색으로 매핑
NAVY = BLACK            # 제목·강조 글씨 → 검정
GRAY = BLACK            # 주석 글씨 → 검정
LIGHT = 'FFFFFF'        # 표 라벨 음영 → 흰색
HEADER_FILL = 'FFFFFF'  # 표 헤더 음영 → 흰색
HEADER_TEXT = BLACK     # 표 헤더 글씨 → 검정
BORDER = '000000'       # 표/제목 밑줄 테두리 → 검정


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
    # 제목이 뒤따르는 본문/표와 분리되어 페이지 끝에 고립되지 않도록
    p.paragraph_format.keep_with_next = True
    run = p.add_run(f'{num}. {title}')
    set_kfont(run, size=13, bold=True, color=NAVY)
    # underline bar (검정)
    pPr = p._p.get_or_add_pPr()
    pbdr = OxmlElement('w:pBdr')
    bottom = OxmlElement('w:bottom')
    bottom.set(qn('w:val'), 'single')
    bottom.set(qn('w:sz'), '12')
    bottom.set(qn('w:space'), '4')
    bottom.set(qn('w:color'), BORDER)
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
        e.set(qn('w:color'), BORDER)
        borders.append(e)
    tblPr = tbl.tblPr
    tblPr.append(borders)
    # 각 행이 페이지 중간에서 잘리지 않도록 (자연스러운 페이지 넘김)
    no_split_rows(table)


def no_split_rows(table):
    """표의 모든 행에 cantSplit 적용 (행이 페이지 경계에서 쪼개지지 않게)."""
    for row in table.rows:
        trPr = row._tr.get_or_add_trPr()
        if trPr.find(qn('w:cantSplit')) is None:
            cant = OxmlElement('w:cantSplit')
            cant.set(qn('w:val'), 'true')
            trPr.append(cant)


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
                  align=WD_ALIGN_PARAGRAPH.CENTER, shade_hex=HEADER_FILL, color=HEADER_TEXT)
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
     'WA(세계육상연맹) 기록 보고 규격 준수, 모듈화 개선(2→33), vitest 회귀검증, Git 형상관리(Conventional Commits)',
     '호환성 점검표, 테스트 결과'),
]
for r0 in req_rows:
    row = req.add_row()
    for ci, val in enumerate(r0):
        set_cell_text(row.cells[ci], val, size=8.5,
                      align=(WD_ALIGN_PARAGRAPH.CENTER if ci == 0 else None))
for i, w in enumerate(widths):
    req.columns[i].width = w
no_split_rows(req)
add_para(doc, '', space_after=4)

# ===== 4. 최종 산출물 =====
add_heading(doc, 'Ⅳ', '최종 산출물 (납품목록)')
deliv = doc.add_table(rows=1, cols=4)
style_table(deliv)
for i, h in enumerate(['구분', '납품목록', '수량', '납품 형태 / 위치']):
    set_cell_text(deliv.rows[0].cells[i], h, size=10, bold=True,
                  align=WD_ALIGN_PARAGRAPH.CENTER, shade_hex=HEADER_FILL, color=HEADER_TEXT)
deliv_rows = [
    ('1', 'PWA 기반 앱 프로젝트 소스 일체 (Android TWA 래핑·AAB 빌드 설정 포함)', '1식',
     'GitHub 소스 + build/app-release-v2.aab'),
    ('2', '앱 빌드·배포 가이드 (Google Play 업로드용, 발주처 자체 수행)', '1부',
     'evidence/app_build_guide_report.html'),
    ('3', 'AWS 클라우드 아키텍처 구성도·실측 IP', '1부',
     'evidence/aws_report.html'),
    ('4', 'SQLite→PostgreSQL 이관 검증 리포트 (34테이블/7,075행)', '1부',
     'db/schema.pg.sql + migration_report.html'),
    ('5', "HTTPS(SSL/TLS) 적용 내역서 (Let's Encrypt 인증서·자물쇠 화면)", '1부',
     'evidence/https_report.html'),
    ('6', '‘노드’ 경기운영시스템 웹 UI/UX 개편 화면(전·후)·배포 URL', '1식',
     'web_before_after + pace-rise-node.com'),
    ('7', '전체 소스코드 일체 (253파일/약 83,746행/289커밋, 소유권 발주처 귀속)', '1식',
     'github.com/roun0621-design/-1'),
]
for r0 in deliv_rows:
    row = deliv.add_row()
    for ci, val in enumerate(r0):
        set_cell_text(row.cells[ci], val, size=9,
                      align=(None if ci in (1, 3) else WD_ALIGN_PARAGRAPH.CENTER))
deliv.columns[0].width = Cm(1.2)
deliv.columns[1].width = Cm(8.0)
deliv.columns[2].width = Cm(1.4)
deliv.columns[3].width = Cm(5.4)
no_split_rows(deliv)
add_para(doc, '', space_after=2)
add_para(doc, '※ 상기 산출물의 구체적 납품 형태·형상관리(커밋)·검증 근거는 「Ⅴ. 산출물별 상세 증빙」에 기재.',
         size=9, color=GRAY, space_after=4)

doc.add_page_break()

# ===== Ⅴ. 산출물별 상세 증빙 (어떻게/어디에/어떤 형태로) =====
add_heading(doc, 'Ⅴ', '산출물별 상세 증빙 (납품 형태·형상관리·검증)')
add_para(doc,
         '※ 본 용역의 모든 산출물은 Git 형상관리 저장소를 통해 형상관리·납품되며, '
         '아래에 각 산출물의 ① 납품 형태·위치 ② Git 형상관리(브랜치·커밋·PR) ③ 검증 근거를 구체적으로 명시한다.',
         size=9.5, color=GRAY, space_after=6)

# 공통: 형상관리 환경 안내 박스
git_box = doc.add_table(rows=4, cols=2)
style_table(git_box)
git_meta = [
    ('형상관리 도구', 'Git / GitHub (원격 저장소) — Conventional Commits 규칙 적용'),
    ('원격 저장소(Repository)', 'github.com/roun0621-design/-1  (Private, 소유권 발주처 귀속)'),
    ('브랜치 전략', 'main(운영 반영) ← genspark_ai_developer(개발) — Pull Request 기반 병합'),
    ('형상 이력', '총 289 커밋 / 최초 2026-02-18 ~ 최종 2026-06-25 / 추적 파일 253개 (소스 약 83,746 LOC)'),
]
for i, (k, v) in enumerate(git_meta):
    set_cell_text(git_box.rows[i].cells[0], k, size=9, bold=True,
                  align=WD_ALIGN_PARAGRAPH.CENTER, shade_hex=LIGHT)
    set_cell_text(git_box.rows[i].cells[1], v, size=9)
git_box.columns[0].width = Cm(3.6)
git_box.columns[1].width = Cm(12.4)
add_para(doc, '', space_after=2)
add_para(doc,
         '※ 납품 방식 : 발주처가 GitHub 저장소의 소유권(Owner)을 이관받아 전체 소스·이력·산출물에 '
         '직접 접근하며, 전체 저장소 아카이브(.tar.gz)와 빌드 산출물(AAB)을 함께 전달함. '
         '아래 커밋 해시는 GitHub에서 직접 조회·검증 가능함.',
         size=9, color=GRAY, space_after=8)


def detail_block(doc, no, title, rows):
    """산출물 1건의 상세 증빙 블록 (제목 + 2열 표)."""
    p = add_para(doc, '', space_before=8, space_after=3)
    # 블록 제목이 뒤따르는 표와 분리되지 않도록
    p.paragraph_format.keep_with_next = True
    r = p.add_run(f'[{no}] {title}')
    set_kfont(r, size=11, bold=True, color=NAVY)
    t = doc.add_table(rows=len(rows), cols=2)
    style_table(t)
    for i, (k, v) in enumerate(rows):
        set_cell_text(t.rows[i].cells[0], k, size=9, bold=True,
                      align=WD_ALIGN_PARAGRAPH.CENTER, shade_hex=HEADER_FILL)
        set_cell_text(t.rows[i].cells[1], v, size=9)
    t.columns[0].width = Cm(3.2)
    t.columns[1].width = Cm(12.8)
    return t


# 산출물 1
detail_block(doc, 1, 'PWA 기반 앱 프로젝트 소스 일체 (Android TWA 래핑·AAB 빌드 설정 포함)', [
    ('납품 형태·위치',
     'GitHub 저장소 내 소스로 관리. PWA 핵심 : public/manifest.json · public/sw.js(Service Worker) · '
     'public/push.js. Android TWA 설정 및 Digital Asset Links : public/.well-known/assetlinks.json. '
     '빌드 산출물(서명 완료) : build/app-release-v2.aab (패키지 com.pacerise.node, versionCode 2 / v1.0.1).'),
    ('Git 형상관리',
     '관련 주요 커밋 — e5eb04a "assetlinks 에 Play 앱 서명키 지문 추가(TWA 검증 완성)", '
     '3ced214 "assetlinks.json 실제 값 입력", d5c078a "스토어(TWA) 준비 — manifest 보강 + assetlinks 서빙". '
     '서명 키 정보 : build/KEYSTORE_INFO.txt, 키스토어 : build/pacerise-upload.keystore.'),
    ('검증 근거',
     'AAB 파일 실재(약 1.0MB) 및 서명 키 지문이 assetlinks.json에 등록되어 TWA 검증 통과. '
     '실기기(Android) 풀스크린 구동 확인 — 증빙 화면 [5] 앱 설치 안내 참조.'),
])

# 산출물 2
detail_block(doc, 2, '앱 빌드·배포 가이드 (발주처 자체 빌드·업로드용)', [
    ('납품 형태·위치',
     '문서 산출물(HTML/PDF) : evidence/app_build_guide_report.html. '
     'Google Play Console 업로드 절차(AAB 업로드 → 내부테스트 → 프로덕션) 및 키 서명 안내 포함.'),
    ('Git 형상관리',
     'Play 스토어 자산 커밋 — 74fe711 "Play 스토어 그래픽이미지(1024x500) 템플릿 추가". '
     '스토어 자산 디렉터리 : playstore_assets/ (아카이브 playstore_assets_2026-06-15.tar.gz).'),
    ('검증 근거',
     '실제 빌드·스토어 업로드는 과업 범위상 발주처가 수행. 본 용역은 발주처가 자체 수행 가능하도록 '
     '가이드 문서 + 서명 키 + AAB를 일체 제공(과업지시서 SFR-001 산출정보 일치).'),
])

# 산출물 3
detail_block(doc, 3, 'AWS 클라우드 아키텍처 구성도·실측 IP', [
    ('납품 형태·위치',
     '문서 산출물 : evidence/aws_report.html (아키텍처 구성도·실측 배포 IP). '
     '운영 환경 : AWS 서울 리전(ap-northeast-2), Node.js 20 / Express, PM2 무중단 운영, '
     '운영 도메인 pace-rise-node.com 연결, 헬스체크 /api/health.'),
    ('Git 형상관리',
     '운영 백업·배포 관련 커밋 — 37a04ae "PostgreSQL pg_dump → S3 백업 스크립트 추가", '
     '101a606 "pg_backup .env를 __dirname 기준 로드(cron 대비)". 백업 모듈 : lib/backupS3.js.'),
    ('검증 근거',
     '운영 도메인 HTTP 200 정상 응답(실 서비스 가동 중), /api/health 응답 캡처. '
     '실 운영 대회 데이터는 공개 API /api/competitions 로 외부 확인 가능.'),
])

# 산출물 4
detail_block(doc, 4, 'SQLite → PostgreSQL 이관 검증 리포트', [
    ('납품 형태·위치',
     '스키마 파일 : db/schema.pg.sql (CREATE TABLE 40종 정의). '
     '이관 스크립트 : scripts/migrate_sqlite_to_postgres.js, scripts/sqlite_to_postgres_schema.js, '
     'scripts/test_db_postgres.js. 검증 리포트 : evidence/migration_report.html. '
     '이중 백엔드 구성 : 환경변수 DB_BACKEND(sqlite|postgres) — lib/db.js.'),
    ('Git 형상관리',
     '관련 주요 커밋 — 53a829b "PostgreSQL 호환 — db.prepare() → 비동기 db.get/all/run 일괄 마이그레이션", '
     'db48139 "운영 PG DB 호환성 회복 — datetime(now) 제거 + 멱등 컬럼 마이그레이션", '
     'd4be527 "상장·문자 테이블 PG 누락 복구". FK 위상정렬 이관 + 시퀀스 재설정 적용.'),
    ('검증 근거',
     '전 테이블 건수 대조 검증 : 34개 테이블 / 7,075행 → 34 PASS · 0 FAIL (전체 일치). '
     '/api/health 로 SQLite·PostgreSQL 양측 정상 응답 확인.'),
])

doc.add_page_break()

# 산출물 5
detail_block(doc, 5, "HTTPS(SSL/TLS) 적용 내역서", [
    ('납품 형태·위치',
     "문서 산출물 : evidence/https_report.html. Let's Encrypt 인증서로 운영 도메인 전 구간 "
     'HTTPS(SSL/TLS) 적용. 접근 인증 : JWT 기반 로그인 + 권한 분리(심판/운영/관리자) — '
     'lib/auth/jwt.js · lib/auth/middleware.js · lib/auth/migrations.js. '
     'API 호출 속도 제한 : 환경변수 RATE_LIMIT_MAX.'),
    ('Git 형상관리',
     '관련 주요 커밋 — 65bb5a9 "JWT/Refresh 기반 로그인 인프라 도입(DB 마이그레이션+헬퍼)", '
     '4517517 "runAuthMigrations PG 모드 스킵 원인 픽스", '
     'f107e76 "RATE_LIMIT_MAX env화 + HTTPS 점검범위 정직화".'),
    ('검증 근거',
     '운영 도메인 HTTPS 적용 후 HTTP 200 응답, 브라우저 자물쇠(보안 연결) 표시. '
     '※ 본 과업 보안 범위는 HTTPS 적용·접근 인증까지이며, 모의해킹·취약점 진단은 과업 범위 외(과업지시서 SER-001 명시).'),
])

# 산출물 6
detail_block(doc, 6, '‘노드(Node)’ 경기운영시스템 웹 UI/UX 개편 화면(전·후)·배포 URL', [
    ('납품 형태·위치',
     '개편 전·후 비교 문서 : evidence/web_before_after_report.html, '
     'evidence/web_improvement_detail.html. 배포 URL : https://pace-rise-node.com (운영 중). '
     '대회 목록 연맹별 그룹화·뱃지, RECENT 영역, 경기 운영 모니터(실시간 출석 집계) 등.'),
    ('Git 형상관리',
     '★ 개편 전·후를 git 이력으로 명확히 식별 — '
     '개편 전 기준 커밋 ca3d736 "노출용 대회 시스템 전면 구현" → 개편 후 main 브랜치 최신. '
     '관련 커밋 — c8fa386 "대회 홈 노출 강제 설정 home_visibility", '
     '57be4ec "자동 레이아웃 정리 — 빈 라운드 열 자동 숨김".'),
    ('검증 근거',
     '운영 서비스에서 직접 캡처한 개편 후 화면(증빙 [1]~[4]). '
     '개편 전 화면은 git checkout ca3d736 으로 재현 가능(형상관리로 전·후 추적성 확보).'),
])

# 산출물 7
detail_block(doc, 7, '전체 소스코드 일체 (소유권 발주처 귀속)', [
    ('납품 형태·위치',
     'GitHub 저장소 전체(github.com/roun0621-design/-1) + 전체 아카이브 evidence_정부지원_2026-06-19.tar.gz. '
     '서버 : server.js + lib/(33개 파일, 기능 모듈 routes/ 분리), 프론트 : public/(107개 파일), '
     '테스트 : tests/(22개 파일), 스크립트 : scripts/(61개 파일).'),
    ('Git 형상관리',
     '총 289 커밋, 추적 파일 253개, 소스 약 83,746 LOC. '
     'main ← genspark_ai_developer Pull Request 기반 병합(예: PR #4). '
     '소유권 : 용역계약서 제8·13조에 따라 결과물·지식재산권 일체 발주처(갑) 귀속.'),
    ('검증 근거',
     '저장소 commit 수·파일 수·LOC 는 GitHub 및 git 명령(git rev-list --count HEAD / git ls-files)으로 '
     '직접 검증 가능. 모듈화 개선 : 서버 기능 모듈 2 → 33개(QUR-001).'),
])

doc.add_page_break()

# ===== Ⅵ. 증빙 (품목별 증빙사진) =====
add_heading(doc, 'Ⅵ', '수행 결과 증빙 (실 운영 화면)')
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
    # 캡션이 이미지와 분리되어 페이지 끝에 고립되지 않도록
    cap_p.paragraph_format.keep_with_next = True
    r = cap_p.add_run(f'[{idx+1}] {cap}')
    set_kfont(r, size=10, bold=True, color=NAVY)
    pic_p = doc.add_paragraph()
    pic_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    pic_p.paragraph_format.space_after = Pt(6)
    # 캡션+이미지가 한 덩어리로 페이지를 넘어가도록 (caption keep_with_next + 이미지단락 keepLines)
    pPr = pic_p._p.get_or_add_pPr()
    keep = OxmlElement('w:keepLines')
    keep.set(qn('w:val'), 'true')
    pPr.append(keep)
    run = pic_p.add_run()
    run.add_picture(path, width=Cm(15.0))
    # 강제 페이지 나눔 제거 — keep_with_next/keepLines 로 자연스럽게 흐르게 함

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

