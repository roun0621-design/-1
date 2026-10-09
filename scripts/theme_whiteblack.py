#!/usr/bin/env python3
"""
증빙 자료 HTML을 화이트 배경 + 블랙 글씨 테마로 변환하고
Audiowide(회사 폰트)를 브랜드/영문/숫자 요소에 적용한다.
폰트 깨짐 방지: 로컬 base64 @font-face CSS를 <link>로 주입 + 시스템 설치도 병행.
"""
import re, sys, os

FONT_LINK = '<link rel="stylesheet" href="fonts/audiowide_face.css">'

# 한글 본문 폰트(깔끔) + 라틴/숫자는 페이지 내에서 .brand 클래스로 Audiowide 지정
BODY_FONT = "'Noto Sans CJK KR','NanumSquare','Malgun Gothic',sans-serif"

# 헤더(그라데이션 컬러바) 공통 주입 CSS: 화이트/블랙 강제
INJECT_CSS = """
  /* ===== WHITE/BLACK THEME OVERRIDE (회사 표준) ===== */
  body { background:#ffffff !important; color:#111111 !important; -webkit-print-color-adjust:exact; print-color-adjust:exact; font-family:%s !important; }
  .brand, .mono-bd { font-family:'Audiowide',sans-serif !important; letter-spacing:0.5px; }
  .header { background:#ffffff !important; color:#000000 !important; border:1.5px solid #111111 !important; border-radius:8px !important; }
  .header h1 { color:#000000 !important; }
  .header p { color:#333333 !important; }
  .header .meta span { background:#ffffff !important; color:#111111 !important; border:1px solid #111111 !important; }
  .header::before { content:''; display:block; position:absolute; }
  .section, .stat, .wrap { background:#ffffff !important; color:#111111 !important; border:1px solid #d9d9d9 !important; box-shadow:none !important; }
  .stitle, .section-title, .stitle .num, .section-title .num { color:#000000 !important; }
  .stitle .num, .section-title .num, .toc .no, .no { background:#111111 !important; color:#ffffff !important; font-family:'Audiowide',sans-serif !important; }
  th { background:#f2f2f2 !important; color:#000000 !important; }
  td, th { border-color:#dddddd !important; }
  .chip { background:#ffffff !important; color:#111111 !important; border:1px solid #111111 !important; }
  pre, .health { background:#f7f7f7 !important; color:#111111 !important; border:1px solid #cccccc !important; }
  pre .c { color:#888888 !important; }
  pre .k { color:#000000 !important; font-weight:700; }
  .health .lbl { color:#555555 !important; }
  .note { background:#ffffff !important; border-left:4px solid #111111 !important; border:1px solid #111111 !important; color:#222222 !important; }
  .footer { color:#555555 !important; border-top:1px solid #cccccc !important; }
  .shot { border:1px solid #cccccc !important; }
  .shot .cap, .ba-label, .ba-label.before, .ba-label.after, .imp-head .badge,
  .cloud-label, .region-tag, .tag.real, .tag.guide, .badge {
     background:#111111 !important; color:#ffffff !important; border-color:#111111 !important; }
  .ba-label.before { background:#777777 !important; }
  .imp-head { background:#f2f2f2 !important; color:#000000 !important; }
  .stat .num, .stat-num { color:#000000 !important; }
  td .ok, .ok { background:#111111 !important; color:#ffffff !important; }
  .arch { background:#fafafa !important; border:1.5px dashed #999999 !important; }
  /* 잔여 컬러 토큰 무력화: AWS/HTTPS/전후비교 등 */
  .header h1 .aws { color:#000000 !important; }
  .box, .box.ec2, .box.db, .box.user { background:#ffffff !important; border:1.5px solid #111111 !important; box-shadow:none !important; }
  .box .svc { color:#000000 !important; }
  .box .desc { color:#444444 !important; }
  .region { border:1.5px solid #111111 !important; }
  .region-tag { background:#ffffff !important; color:#111111 !important; border:1px solid #111111 !important; }
  .cloud-label { background:#111111 !important; color:#ffffff !important; }
  .arrow { color:#111111 !important; }
  .guide { background:#ffffff !important; border-left:4px solid #111111 !important; border:1px solid #111111 !important; }
  .guide b { color:#000000 !important; }
  .ok { background:#111111 !important; color:#ffffff !important; }
  .flow { background:#f7f7f7 !important; color:#222222 !important; }
  .head { background:#ffffff !important; color:#000000 !important; border-bottom:1.5px solid #111111 !important; }
  tfoot td { background:#f2f2f2 !important; color:#000000 !important; border-top:1.5px solid #111111 !important; }
  td.t { color:#000000 !important; }
  .ba-label.after, .imp-head .badge, .badge { background:#111111 !important; color:#ffffff !important; }
""" % BODY_FONT


def transform(path):
    with open(path, encoding='utf-8') as f:
        html = f.read()

    # 1) 폰트 <link> 주입 (중복 방지)
    if 'audiowide_face.css' not in html:
        html = html.replace('<meta charset="UTF-8">',
                             '<meta charset="UTF-8">\n' + FONT_LINK, 1)
        if FONT_LINK not in html:  # meta 없을 경우 <head> 뒤에
            html = re.sub(r'(<head[^>]*>)', r'\1\n' + FONT_LINK, html, count=1)

    # 2) 오버라이드 CSS를 </style> 직전에 주입 (중복 방지)
    if 'WHITE/BLACK THEME OVERRIDE' not in html:
        html = html.replace('</style>', INJECT_CSS + '\n</style>', 1)

    # 3) 브랜드/도메인 텍스트에 Audiowide(.brand) 적용 (HTML 본문에서만, CSS 영역 제외)
    if '<body' in html:
        head, body = html.split('<body', 1)
        body = '<body' + body
        # 이미 감싸진 것 방지: span class="brand" 내부는 건드리지 않도록 단순 치환
        def wrap(text, target):
            # 이미 .brand로 감싼 경우 스킵
            if 'class="brand">' + target in text:
                return text
            # 파일명(.png) 등 오탐 방지: 토큰 뒤가 영숫자/하이픈/점이면 건드리지 않음
            pat = re.escape(target) + r'(?![\w.-])'
            return re.sub(pat, '<span class="brand">%s</span>' % target, text)
        # 긴 토큰부터 치환 (substring 충돌 방지)
        for token in ['PACE RISE : Node', 'pace-rise-node.com', 'pace-rise.com',
                      'Competition Operating System']:
            body = wrap(body, token)
        html = head + body

    with open(path, encoding='utf-8', mode='w') as f:
        f.write(html)
    print('themed:', path)


if __name__ == '__main__':
    for p in sys.argv[1:]:
        transform(p)
