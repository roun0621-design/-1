# -*- coding: utf-8 -*-
"""
결과보고서 — 발주처 제공 HWP 양식(결과보고서(양식).hwp) 구조를 그대로 따라 작성.

양식 구조(원본 그대로):
  [표지]  결 과 보 고 서 / 용역완료일 : / 주식회사 OOO (인)
  [본문]  결 과 보 고 서
          1. 용역 개요   (용역명/용역기간/용역금액/용역목적)
          2. 용역 수행 내용
               1) 추진 경과 (일정/내용/비고 표)
               2) 주요 수행 내용 (가~마)
          3. 용역 결과물 (납품물 리스트)
          4. 용역 결과물 사진

내용은 PACE RISE : Node 용역(육상경기 운영플랫폼(COS) 모바일 앱 개발 및
웹·인프라 고도화) 실제 수행 내역으로 채움. (양식의 제조업 예시 문구는 본 용역에
맞게 치환하되, 항목 체계·번호·표 형식은 양식과 동일하게 유지)
"""
import os
from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

# ───────────────────────── 설정 ─────────────────────────
BASE = '/home/user/webapp'
IMG = os.path.join(BASE, 'evidence', '품목별증빙사진')
OUT_DIR = os.path.join(BASE, 'evidence', '결과보고서')
OUT = os.path.join(OUT_DIR, '결과보고서_PACE-RISE_Node_양식.docx')
FONT = '맑은 고딕'

# 양식 색상 : 표지/제목 줄·강조는 파란색, 본문 글씨는 검정
BLUE = RGBColor(0x00, 0x00, 0xCC)     # 양식 표지의 파란 강조색
BLACK = RGBColor(0x00, 0x00, 0x00)
LINE_BLUE = '2E5BFF'                   # 표지 가로줄(파란)
LABEL_FILL = 'F2F2F2'                  # 표 라벨 음영(연회색)


# ───────────────────────── 헬퍼 ─────────────────────────
def kfont(run, size=None, bold=None, color=None):
    run.font.name = FONT
    rpr = run._element.get_or_add_rPr()
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


def para(doc, text='', size=11, bold=False, color=None, align=None,
         after=6, before=0, indent=None, keep=False):
    p = doc.add_paragraph()
    if align is not None:
        p.alignment = align
    pf = p.paragraph_format
    pf.space_after = Pt(after)
    pf.space_before = Pt(before)
    if indent is not None:
        pf.left_indent = Cm(indent)
    if keep:
        pf.keep_with_next = True
    if text:
        r = p.add_run(text)
        kfont(r, size=size, bold=bold, color=color)
    return p


def hbar(p, color=LINE_BLUE, sz='18', pos='bottom'):
    """문단에 가로 줄(테두리) 추가 — 양식 표지의 파란 줄 재현."""
    pPr = p._p.get_or_add_pPr()
    pbdr = pPr.find(qn('w:pBdr'))
    if pbdr is None:
        pbdr = OxmlElement('w:pBdr')
        pPr.append(pbdr)
    edge = OxmlElement(f'w:{pos}')
    edge.set(qn('w:val'), 'single')
    edge.set(qn('w:sz'), sz)
    edge.set(qn('w:space'), '6')
    edge.set(qn('w:color'), color)
    pbdr.append(edge)


def shade(cell, hexcolor):
    tcpr = cell._tc.get_or_add_tcPr()
    sh = OxmlElement('w:shd')
    sh.set(qn('w:val'), 'clear')
    sh.set(qn('w:fill'), hexcolor)
    tcpr.append(sh)


def cell_text(cell, text, size=10.5, bold=False, color=None, align=None,
              fill=None, vcenter=True):
    cell.text = ''
    p = cell.paragraphs[0]
    if align is not None:
        p.alignment = align
    for i, line in enumerate(str(text).split('\n')):
        if i > 0:
            p = cell.add_paragraph()
            if align is not None:
                p.alignment = align
        r = p.add_run(line)
        kfont(r, size=size, bold=bold, color=color)
    if fill:
        shade(cell, fill)
    if vcenter:
        tcpr = cell._tc.get_or_add_tcPr()
        va = OxmlElement('w:vAlign')
        va.set(qn('w:val'), 'center')
        tcpr.append(va)


def style_table(table, border='808080'):
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    tbl = table._tbl
    borders = OxmlElement('w:tblBorders')
    for e in ('top', 'left', 'bottom', 'right', 'insideH', 'insideV'):
        el = OxmlElement(f'w:{e}')
        el.set(qn('w:val'), 'single')
        el.set(qn('w:sz'), '6')
        el.set(qn('w:space'), '0')
        el.set(qn('w:color'), border)
        borders.append(el)
    tbl.tblPr.append(borders)
    for row in table.rows:
        trPr = row._tr.get_or_add_trPr()
        cant = OxmlElement('w:cantSplit')
        cant.set(qn('w:val'), 'true')
        trPr.append(cant)


def section_title(doc, num, title):
    """양식의 <번호> 제목 형식 : 좌측 사각 번호 + 제목."""
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(16)
    p.paragraph_format.space_after = Pt(8)
    p.paragraph_format.keep_with_next = True
    r1 = p.add_run(f'{num}. ')
    kfont(r1, size=14, bold=True, color=BLACK)
    r2 = p.add_run(title)
    kfont(r2, size=14, bold=True, color=BLACK)
    hbar(p, color=LINE_BLUE, sz='12', pos='bottom')
    return p


# ───────────────────────── 문서 시작 ─────────────────────────
doc = Document()
st = doc.styles['Normal']
st.font.name = FONT
st.font.size = Pt(11)
st.element.rPr.rFonts.set(qn('w:eastAsia'), FONT)

sec = doc.sections[0]
sec.top_margin = Cm(2.2)
sec.bottom_margin = Cm(2.0)
sec.left_margin = Cm(2.3)
sec.right_margin = Cm(2.3)

# ===== 표지 (양식과 동일 : 파란 줄 + 제목 + 파란 줄 + 완료일 + 업체) =====
for _ in range(4):
    para(doc, '', after=2)

# 위쪽 파란 줄
top_line = para(doc, '', after=0)
hbar(top_line, color=LINE_BLUE, sz='20', pos='bottom')

para(doc, '결  과  보  고  서', size=34, bold=True, color=BLACK,
     align=WD_ALIGN_PARAGRAPH.CENTER, after=0, before=18)

# 아래쪽 파란 줄
bot_line = para(doc, '', after=0, before=18)
hbar(bot_line, color=LINE_BLUE, sz='20', pos='bottom')

for _ in range(9):
    para(doc, '', after=2)

# 용역완료일 (라벨 검정 + 값 파란 — 양식과 동일)
p = para(doc, '', align=WD_ALIGN_PARAGRAPH.CENTER, after=10)
r = p.add_run('용역완료일 : ')
kfont(r, size=15, bold=True, color=BLACK)
r = p.add_run('2026. 6. 18.')
kfont(r, size=15, bold=True, color=BLUE)

for _ in range(7):
    para(doc, '', after=2)

# 업체 (앞 검정 + 업체명 파란 — 양식과 동일)
p = para(doc, '', align=WD_ALIGN_PARAGRAPH.CENTER, after=4)
r = p.add_run('주식회사 ')
kfont(r, size=15, bold=True, color=BLACK)
r = p.add_run('에스피씨티솔루션')
kfont(r, size=15, bold=True, color=BLUE)
r = p.add_run(' (인)')
kfont(r, size=15, bold=True, color=BLACK)

doc.add_page_break()

# ===== 본문 제목 =====
para(doc, '결  과  보  고  서', size=20, bold=True, color=BLACK,
     align=WD_ALIGN_PARAGRAPH.CENTER, after=18, before=4)

# ───────────────────────── 1. 용역 개요 ─────────────────────────
section_title(doc, '1', '용역 개요')
overview = [
    ('1. 용 역 명', '육상경기 운영플랫폼(COS) 모바일 앱 개발 및 웹·인프라 고도화'),
    ('2. 용역기간', '2026. 4. 28. ~ 2026. 6. 18.'),
    ('3. 용역금액', '금20,000,000원(VAT 별도) / 부가가치세 포함 금22,000,000원'),
    ('4. 용역목적', 'COS(Competition Operating System) 모바일 확장 및 클라우드·보안·웹(노드) '
                  '사용성 고도화 — 육상경기 운영 전 과정을 모바일·웹에서 안정적으로 처리'),
]
t = doc.add_table(rows=len(overview), cols=2)
style_table(t)
for i, (k, v) in enumerate(overview):
    cell_text(t.rows[i].cells[0], k, size=10.5, bold=True,
              align=WD_ALIGN_PARAGRAPH.CENTER, fill=LABEL_FILL)
    cell_text(t.rows[i].cells[1], v, size=10.5)
t.columns[0].width = Cm(3.4)
t.columns[1].width = Cm(12.6)
para(doc, '', after=4)

# ───────────────────────── 2. 용역 수행 내용 ─────────────────────────
section_title(doc, '2', '용역 수행 내용')

para(doc, '1. 추진 경과', size=11.5, bold=True, color=BLACK, after=6, before=2, keep=True)
prog = [
    ('일정', '내용', '비고'),
    ('2026. 4. 28.', '용역 계약 체결', ''),
    ('2026. 4. 29.', '착수회의 진행 · 과업 범위/요구사항 확정', ''),
    ('2026. 5. 초', 'AWS 클라우드 환경 구성 · SQLite→PostgreSQL 마이그레이션 설계', ''),
    ('2026. 5. 중', 'PWA 기반 모바일 앱 구축 · 웹(노드) UI/UX 개편 · 보안(HTTPS/인증) 적용', ''),
    ('2026. 5.~6.', '실 대회 운영 검증(다수 동시접속) · AOS/iOS 실기기 구동 확인', '실 운영 검증'),
    ('2026. 6. 18.', '최종 결과보고서 제출 및 용역 종료', ''),
]
pt = doc.add_table(rows=len(prog), cols=3)
style_table(pt)
for i, row in enumerate(prog):
    for j, v in enumerate(row):
        cell_text(pt.rows[i].cells[j], v, size=10,
                  bold=(i == 0),
                  align=(WD_ALIGN_PARAGRAPH.CENTER if (i == 0 or j != 1) else None),
                  fill=(LABEL_FILL if i == 0 else None))
pt.columns[0].width = Cm(3.0)
pt.columns[1].width = Cm(9.6)
pt.columns[2].width = Cm(3.4)
para(doc, '', after=6)

para(doc, '2. 주요 수행 내용', size=11.5, bold=True, color=BLACK, after=6, before=4, keep=True)


def subblock(title, items):
    para(doc, title, size=11, bold=True, color=BLACK, after=4, before=4,
         indent=0.3, keep=True)
    for it in items:
        para(doc, '- ' + it, size=10.5, color=BLACK, after=3, indent=0.8)


subblock('가. 모바일 앱(AOS/iOS) 개발', [
    '의뢰기관 요구사항을 바탕으로 COS의 모바일 확장 사양(기능·화면·기기 대응)을 검토하고 설계안을 도출함',
    'PWA(Progressive Web App) 기반으로 모바일을 최적화하고, Android는 TWA 래핑으로 네이티브 앱(AAB) 빌드·서명(v1.0.1)을 구성함',
    'iOS는 Safari 홈화면 설치(PWA)를 지원하도록 구성하였으며, 앱 프로젝트 소스와 빌드·배포 가이드를 제공함(스토어 업로드는 발주처가 수행)',
    '주요 5개 페이지에 공통 반응형 CSS를 적용하여 PC·태블릿·모바일 Cross-Device 환경에 대응함',
])
subblock('나. AWS 클라우드 환경 구성 및 DB 마이그레이션', [
    '대규모 데이터의 안정적 처리를 위해 AWS 서울 리전(ap-northeast-2)에 운영 인스턴스를 배포하고, PM2 무중단 운영·헬스체크(/api/health)를 구성함',
    'SQLite → PostgreSQL 15 로의 스키마 이행 및 이중 백엔드(DB_BACKEND) 구성을 완료함',
    'FK(외래키) 위상정렬 기반으로 데이터를 이관하고, 34개 테이블/7,075행 전수 대조 검증을 수행하여 34 PASS · 0 FAIL(전체 일치)을 확인함',
])
subblock('다. 보안(SSL/TLS) 적용 및 접근 인증', [
    "Let's Encrypt 인증서로 운영 도메인 전 구간에 HTTPS(SSL/TLS) 엔드투엔드 암호화를 적용함(HTTP 200 정상 응답)",
    'JWT 기반 로그인·권한 분리(심판/운영/관리자)와 API 호출 속도 제한을 적용하여 접근 인증을 강화함',
    '웹 취약점 점검을 수행하고 확인된 사항을 조치함(과업 보안 범위 : HTTPS 적용·접근 인증)',
])
subblock('라. 웹(노드) UI/UX 개편 및 배포', [
    "‘노드(Node)’ 경기운영시스템을 태스크 플로우(Task Flow) 기반으로 화면 개편함",
    '대회 목록의 연맹별 그룹화·뱃지 체계, RECENT(최근 대회) 영역, 실시간 출석 집계 모니터 등을 도입함',
    '개편 결과를 운영 도메인(pace-rise-node.com)에 배포하여 실서비스로 운영 중이며, git 이력으로 개편 전·후 추적성을 확보함',
])
subblock('마. 검증 및 결과', [
    '시스템을 실제 대회에 도입·운영하여 다수 동시접속(동시 50~500) 환경에서 에러율 0%·동시 200 기준 p95 약 400ms 의 안정성을 확인함',
    'AOS/iOS 실기기에서의 정상 구동을 확인하였으며, vitest 단위·회귀 테스트를 통과함',
    '본 용역의 모든 요구사항(과업지시서 기준)을 충족하였고, 기능·안정성·보안 기준을 만족함',
])
para(doc, '', after=4)

# ───────────────────────── 3. 용역 결과물 ─────────────────────────
section_title(doc, '3', '용역 결과물')
para(doc, '※ 납품물 리스트 (산출물 형태·위치 명시)', size=10, color=BLACK, after=6)
deliv = [
    ('구분', '납품물', '형태 / 위치'),
    ('1', 'PWA 기반 앱 프로젝트 소스 일체 (Android TWA 래핑·AAB 빌드 설정 포함)',
     'GitHub 소스 + build/app-release.aab'),
    ('2', '앱 빌드·배포 가이드 (Google Play 업로드용)', 'evidence/app_build_guide_report.html'),
    ('3', 'AWS 클라우드 아키텍처 구성도·실측 IP', 'evidence/aws_report.html'),
    ('4', 'SQLite→PostgreSQL 이관 검증 리포트 (34테이블/7,075행)',
     'db/schema.pg.sql + migration_report.html'),
    ('5', "HTTPS(SSL/TLS) 적용 내역서 (Let's Encrypt 인증서)", 'evidence/https_report.html'),
    ('6', '‘노드’ 경기운영시스템 웹 UI/UX 개편 화면(전·후)·배포 URL',
     'web_before_after + pace-rise-node.com'),
    ('7', '전체 소스코드 일체 (253파일/약 83,746행/289커밋, 소유권 발주처 귀속)',
     'github.com/roun0621-design/-1'),
]
dt = doc.add_table(rows=len(deliv), cols=3)
style_table(dt)
for i, row in enumerate(deliv):
    for j, v in enumerate(row):
        cell_text(dt.rows[i].cells[j], v, size=9.5,
                  bold=(i == 0),
                  align=(WD_ALIGN_PARAGRAPH.CENTER if (i == 0 or j == 0) else None),
                  fill=(LABEL_FILL if i == 0 else None))
dt.columns[0].width = Cm(1.4)
dt.columns[1].width = Cm(9.4)
dt.columns[2].width = Cm(5.2)
para(doc, '', after=4)

# ───────────────────────── 4. 용역 결과물 사진 ─────────────────────────
section_title(doc, '4', '용역 결과물 사진')
para(doc, '※ 운영 서비스(pace-rise-node.com)에서 직접 캡처한 실제 화면', size=10, color=BLACK, after=8)

images = [
    ('01_메인화면_대회목록.png', '메인화면 – 연맹별 대회목록(그룹화·뱃지·RECENT 영역)'),
    ('02_경기운영_대시보드_KAAF배.png', '경기운영 대시보드 – 실시간 기록 확인·제어'),
    ('03_경기운영_대시보드_제80회.png', '경기운영 대시보드 – 부문별 운영 화면'),
    ('04_경기시간표_259경기.png', '경기시간표 – 다일치 타임테이블·결과 연동'),
    ('05_앱설치안내_PWA.png', '앱 설치 안내 – PWA(Android Chrome / iOS Safari 홈화면 추가)'),
    ('06_모바일반응형화면.png', '모바일 반응형 화면 – PWA Cross-Device 대응'),
]
for fn, cap in images:
    path = os.path.join(IMG, fn)
    if not os.path.exists(path):
        continue
    cp = para(doc, '', after=2, before=8, keep=True)
    r = cp.add_run('▷ ' + cap)
    kfont(r, size=10.5, bold=True, color=BLACK)
    pic_p = doc.add_paragraph()
    pic_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    pic_p.paragraph_format.space_after = Pt(6)
    pPr = pic_p._p.get_or_add_pPr()
    keep = OxmlElement('w:keepLines')
    keep.set(qn('w:val'), 'true')
    pPr.append(keep)
    pic_p.add_run().add_picture(path, width=Cm(15.0))

# ===== 결재/날인 (양식 표지 항목 보강) =====
para(doc, '', after=14, before=10)
para(doc,
     '상기와 같이 본 용역(육상경기 운영플랫폼(COS) 모바일 앱 개발 및 웹·인프라 고도화)을 '
     '계약 내용에 따라 성실히 수행하여 완료하였기에 그 결과를 보고합니다.',
     size=11, color=BLACK, align=WD_ALIGN_PARAGRAPH.CENTER, after=24)
para(doc, '2026. 6. 18.', size=13, bold=True, color=BLACK,
     align=WD_ALIGN_PARAGRAPH.CENTER, after=16)
p = para(doc, '', align=WD_ALIGN_PARAGRAPH.CENTER, after=4)
r = p.add_run('주식회사 에스피씨티솔루션      대표  김 동 식   (인)')
kfont(r, size=12, bold=True, color=BLACK)
para(doc, '주식회사 페이스라이즈 귀하', size=11, color=BLACK,
     align=WD_ALIGN_PARAGRAPH.CENTER, after=4)

os.makedirs(OUT_DIR, exist_ok=True)
doc.save(OUT)
print('saved:', OUT)
