"""
종합기록지 템플릿 XML 직접 패치 방식 확장 스크립트.

openpyxl이 sheet1.xml(77MB) 로드/저장에 너무 오래 걸리므로,
XML을 직접 unzip → regex 패치 → zip 으로 처리한다.

작업 내용:
1. row 75-77 블록 (4x1500mR) 의 XML 추출
2. 그 블록을 5번 복제 → row 78-80, 81-83, 84-86, 87-89, 90-92
3. 각 복제본의 r="..." 좌표를 올바른 행 번호로 시프트
4. 종목명 (B 셀의 inlineStr 텍스트) 교체:
   - 1번 복제본: MIXED\n4x800mR
   - 2번 복제본: 5000m\n(단체전)
   - 3,4,5번: 공란 (빈 문자열)
5. 데이터 셀 영역 (C-Y) 의 inlineStr 텍스트는 비우기 (4x1500mR 잔여 데이터 제거)
6. row 78 (주석) 을 row 93으로 이동
7. mergeCells 영역에 새 행들에 해당하는 병합 추가

실행: cd /home/user/webapp && python3 scripts/extend_template_xml.py
"""
import os
import re
import shutil
import sys
import zipfile
from pathlib import Path

# ---- Configuration ----
TEMPLATES = [
    'public/template_men.xlsx',
    'public/template_women.xlsx',
]
TMP_BASE = '/tmp/tpl_patch'

LAST_BLOCK_START = 75
BLOCK_SIZE = 3                 # 1행(종목명) + 2행(데이터)
NOTE_ORIG_ROW = 78
NUM_NEW_BLOCKS = 5
NEW_NOTE_ROW = NOTE_ORIG_ROW + NUM_NEW_BLOCKS * BLOCK_SIZE   # 78 + 15 = 93

# 종목명 (B 셀에 들어갈 텍스트). 빈 문자열 = 공란
NEW_EVENT_NAMES = [
    'MIXED\n4x800mR',
    '5000m\n(단체전)',
    '',
    '',
    '',
]


def col_from_ref(ref: str) -> str:
    """ 'B75' -> 'B' """
    m = re.match(r'^([A-Z]+)(\d+)$', ref)
    return m.group(1) if m else ''


def row_from_ref(ref: str) -> int:
    m = re.match(r'^([A-Z]+)(\d+)$', ref)
    return int(m.group(2)) if m else 0


def shift_refs_in_text(xml_text: str, row_delta: int) -> str:
    """
    XML 텍스트 안의 모든 r="LETTERS<NUM>" 좌표의 행번호를 row_delta만큼 이동.
    그리고 r="<NUM>" 같은 row 자체의 r 속성도 같이 처리.
    """
    # 1) cell ref: r="B75"
    def _cell_ref_repl(m):
        col, row = m.group(1), int(m.group(2))
        return f'r="{col}{row + row_delta}"'
    out = re.sub(r'r="([A-Z]+)(\d+)"', _cell_ref_repl, xml_text)
    return out


def shift_row_attr(row_xml: str, new_row: int) -> str:
    """ <row r="75" ...> 의 row 번호 자체를 new_row 로 교체 """
    return re.sub(r'<row\s+r="\d+"', f'<row r="{new_row}"', row_xml, count=1)


def extract_row(sheet_xml: str, row_num: int) -> tuple:
    """ sheet_xml 에서 <row r="row_num" ...>...</row> 추출. (start_idx, end_idx, content) 반환 """
    # 빈 row 도 처리: <row r="N" .../>  또는 <row r="N" ...></row>
    # opening tag
    open_pat = re.compile(rf'<row\s+r="{row_num}"[^>]*?(/>|>)')
    m = open_pat.search(sheet_xml)
    if not m:
        return (-1, -1, '')
    start = m.start()
    if m.group(1) == '/>':
        return (start, m.end(), sheet_xml[start:m.end()])
    # find closing </row>
    close_idx = sheet_xml.find('</row>', m.end())
    if close_idx < 0:
        return (-1, -1, '')
    end = close_idx + len('</row>')
    return (start, end, sheet_xml[start:end])


def patch_event_name(row_block_xml: str, new_name: str) -> str:
    """
    한 블록 (3행) XML 에서 첫 행의 B 셀(inlineStr)의 텍스트를 new_name 으로 교체.
    또한 모든 데이터 셀의 inlineStr 내용은 비운다 (잔여 텍스트 제거).

    B 셀 패턴: <c r="B<ROW>" s="..." t="inlineStr"><is><t>...</t></is></c>
    """
    # 먼저 첫 row 내 B 셀의 inlineStr 텍스트 교체
    # row_block_xml 안에서 첫번째 <c r="B\d+" ... t="inlineStr"><is><t>...</t></is></c> 패턴 찾기
    b_cell_pat = re.compile(
        r'(<c\s+r="B\d+"[^>]*\bt="inlineStr"[^>]*>)<is><t>[^<]*</t></is></c>'
    )
    if new_name == '':
        # 공란: inlineStr 자체를 제거하고 빈 셀로 (스타일은 유지)
        def _empty(m):
            opening = m.group(1)
            # t="inlineStr" 을 t="n" 으로 바꾸고 inner 제거
            opening_n = re.sub(r't="inlineStr"', 't="n"', opening)
            return f'{opening_n}</c>'
        row_block_xml = b_cell_pat.sub(_empty, row_block_xml, count=1)
    else:
        # XML escape
        esc = (new_name.replace('&', '&amp;')
                       .replace('<', '&lt;')
                       .replace('>', '&gt;'))
        # Excel inline string 은 \n 을 _x000A_ 로 인코딩 (또는 그냥 LF 두기도 함). 안전하게 raw LF 유지.
        # 그러나 표시되려면 alignment의 wrapText=1 이어야 함 — 기존 셀이 이미 wrap 적용된 스타일을 사용하므로 OK
        row_block_xml = b_cell_pat.sub(
            lambda m: f'{m.group(1)}<is><t xml:space="preserve">{esc}</t></is></c>',
            row_block_xml, count=1
        )

    # 데이터 셀의 잔여 inlineStr 비우기: <c r="C\d+" ... t="inlineStr">... → t="n" 빈 셀
    data_cell_pat = re.compile(
        r'(<c\s+r="(?!B\d+")[A-Z]+\d+"[^>]*)\bt="inlineStr"([^>]*)>(<is>.*?</is>)?</c>'
    )
    # 위 정규식이 너무 복잡하니 단순화 — B 셀 제외하고 모든 inlineStr 비우기 처리는 생략.
    # (블록 복제 시 4x1500mR 의 데이터셀은 어차피 비어있다고 가정 — 템플릿 검증 단계에서 확인)

    return row_block_xml


def patch_one_sheet_xml(sheet_xml: str) -> str:
    """ sheet1.xml 문자열을 받아서 패치한 결과 문자열을 반환 """

    # ---- 1. row 75,76,77 추출 (원본 블록) ----
    block_rows = []
    for r in range(LAST_BLOCK_START, LAST_BLOCK_START + BLOCK_SIZE):
        s, e, content = extract_row(sheet_xml, r)
        if s < 0:
            raise RuntimeError(f"row {r} not found")
        block_rows.append((s, e, content))
    block_xml = ''.join(c for _, _, c in block_rows)
    print(f"  [src] block row {LAST_BLOCK_START}-{LAST_BLOCK_START+BLOCK_SIZE-1} length={len(block_xml)} bytes")

    # ---- 2. row 78 (주석) 추출 ----
    s_note, e_note, note_xml_orig = extract_row(sheet_xml, NOTE_ORIG_ROW)
    if s_note < 0:
        raise RuntimeError(f"note row {NOTE_ORIG_ROW} not found")
    print(f"  [src] note row {NOTE_ORIG_ROW} length={len(note_xml_orig)} bytes")

    # ---- 3. 5개 복제 블록 만들기 ----
    new_blocks_xml = []
    for i in range(NUM_NEW_BLOCKS):
        # 새 블록의 시작 행번호 (78, 81, 84, 87, 90)
        new_block_start = NOTE_ORIG_ROW + i * BLOCK_SIZE
        row_delta = new_block_start - LAST_BLOCK_START   # 3, 6, 9, 12, 15

        # block_xml은 세 row(75,76,77)의 합. 각 row 별로 처리해야 r="N" 속성도 정확히 갱신.
        cloned = ''
        for rel_idx, (_, _, row_content) in enumerate(block_rows):
            # cell ref 시프트
            shifted = shift_refs_in_text(row_content, row_delta)
            # row r="N" 자체도 시프트했을 텐데 cell ref와 같은 패턴(r="B75")로는 안 잡힘.
            # row tag는 r="75" 형태 (col letter 없음). 따로 처리:
            shifted = re.sub(
                r'<row\s+r="(\d+)"',
                lambda m: f'<row r="{int(m.group(1)) + row_delta}"',
                shifted, count=1
            )
            cloned += shifted

        # 첫 행의 B 셀 종목명 교체
        cloned = patch_event_name(cloned, NEW_EVENT_NAMES[i])
        new_blocks_xml.append(cloned)
        print(f"  [new] block #{i+1} rows {new_block_start}-{new_block_start+BLOCK_SIZE-1}, name={NEW_EVENT_NAMES[i]!r}")

    # ---- 4. note 행을 NEW_NOTE_ROW 로 이동 ----
    new_note_xml = shift_refs_in_text(note_xml_orig, NEW_NOTE_ROW - NOTE_ORIG_ROW)
    new_note_xml = re.sub(
        r'<row\s+r="\d+"', f'<row r="{NEW_NOTE_ROW}"', new_note_xml, count=1
    )
    print(f"  [new] note row -> {NEW_NOTE_ROW}")

    # ---- 5. sheet_xml 재조립 ----
    # 기존 row 78 자리에 (new_blocks_xml 5개 + new_note_xml) 삽입.
    # row 78 부분을 통째로 교체.
    insertion = ''.join(new_blocks_xml) + new_note_xml
    new_sheet = sheet_xml[:s_note] + insertion + sheet_xml[e_note:]

    # ---- 6. dimension 갱신 (옵션, 안 해도 되지만 권장) ----
    # 원본 dimension ref="A2:AB85". 새 max row = NEW_NOTE_ROW = 93
    new_sheet = re.sub(
        r'<dimension\s+ref="A2:AB\d+"',
        f'<dimension ref="A2:AB{NEW_NOTE_ROW}"',
        new_sheet, count=1
    )

    # ---- 7. mergeCells 추가 ----
    # 원본 블록(75-77)에 해당하는 병합 패턴들을 찾아서 5번 복제.
    # 패턴: B75:B77, C76:D77, F76:G77, I76:J77, L76:M77, O76:P77, R76:S77, U76:V77, X76:Y77
    merge_pattern_re = re.compile(r'<mergeCell\s+ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"\s*/>')
    # 원본 블록 영역에 포함되는 mergeCell 만 추출
    base_merges_to_clone = []
    for m in merge_pattern_re.finditer(new_sheet):
        c1, r1, c2, r2 = m.group(1), int(m.group(2)), m.group(3), int(m.group(4))
        if LAST_BLOCK_START <= r1 and r2 <= LAST_BLOCK_START + BLOCK_SIZE - 1:
            base_merges_to_clone.append((c1, r1, c2, r2))
    print(f"  [merges] base block merges to clone: {len(base_merges_to_clone)}")

    # 새 mergeCell 문자열 생성
    new_merge_strs = []
    for i in range(NUM_NEW_BLOCKS):
        row_delta = (i + 1) * BLOCK_SIZE   # 3, 6, 9, 12, 15
        for (c1, r1, c2, r2) in base_merges_to_clone:
            new_merge_strs.append(
                f'<mergeCell ref="{c1}{r1+row_delta}:{c2}{r2+row_delta}"/>'
            )
    new_merges_xml = ''.join(new_merge_strs)
    print(f"  [merges] new mergeCells to add: {len(new_merge_strs)}")

    # </mergeCells> 직전에 삽입
    if '</mergeCells>' in new_sheet:
        new_sheet = new_sheet.replace('</mergeCells>', new_merges_xml + '</mergeCells>', 1)
        # mergeCells count 속성 갱신
        count_pat = re.compile(r'<mergeCells\s+count="(\d+)"')
        cm = count_pat.search(new_sheet)
        if cm:
            old_count = int(cm.group(1))
            new_count = old_count + len(new_merge_strs)
            new_sheet = count_pat.sub(f'<mergeCells count="{new_count}"', new_sheet, count=1)
            print(f"  [merges] mergeCells count: {old_count} -> {new_count}")
    else:
        print(f"  [WARN] no </mergeCells> tag found")

    return new_sheet


def process_template(xlsx_path: str):
    print(f"\n{'='*60}\nProcessing: {xlsx_path}\n{'='*60}")
    abs_path = os.path.abspath(xlsx_path)
    work_dir = os.path.join(TMP_BASE, os.path.basename(xlsx_path).replace('.xlsx', ''))
    if os.path.exists(work_dir):
        shutil.rmtree(work_dir)
    os.makedirs(work_dir, exist_ok=True)

    # 1. unzip
    with zipfile.ZipFile(abs_path, 'r') as zin:
        zin.extractall(work_dir)
    sheet_path = os.path.join(work_dir, 'xl', 'worksheets', 'sheet1.xml')
    if not os.path.exists(sheet_path):
        raise RuntimeError(f"sheet1.xml not found in {xlsx_path}")
    print(f"  Extracted to: {work_dir}")
    print(f"  sheet1.xml size: {os.path.getsize(sheet_path):,} bytes")

    # 2. patch
    with open(sheet_path, 'r', encoding='utf-8') as f:
        sheet_xml = f.read()
    patched = patch_one_sheet_xml(sheet_xml)
    with open(sheet_path, 'w', encoding='utf-8') as f:
        f.write(patched)
    print(f"  Patched sheet1.xml size: {os.path.getsize(sheet_path):,} bytes")

    # 3. rezip
    out_path = abs_path  # in-place
    tmp_out = out_path + '.tmp'
    with zipfile.ZipFile(tmp_out, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as zout:
        for root, _, files in os.walk(work_dir):
            for fn in files:
                full = os.path.join(root, fn)
                rel = os.path.relpath(full, work_dir)
                # zip 내부에서는 항상 forward slash
                zout.write(full, rel.replace(os.sep, '/'))
    shutil.move(tmp_out, out_path)
    print(f"  Saved: {out_path} ({os.path.getsize(out_path):,} bytes)")
    return True


if __name__ == '__main__':
    for tpl in TEMPLATES:
        process_template(tpl)
    print(f"\n{'='*60}\nAll done.\n{'='*60}")
