#!/usr/bin/env python3
"""증빙 이미지를 양식 칸(가로 ratio:1)에 맞게 흰 배경 레터박스 처리."""
import sys
from PIL import Image

RATIO = 1.4  # width / height (양식 칸 비율)
PAD = 0.035  # 내부 여백 비율

def fit(src, dst, ratio=RATIO):
    im = Image.open(src).convert('RGB')
    w, h = im.size
    pad = int(min(w, h) * PAD)
    cw, ch = w + pad * 2, h + pad * 2
    # 정확히 ratio 비율이 되도록 부족한 쪽을 늘림
    if cw / ch < ratio:
        cw = int(round(ch * ratio))
    else:
        ch = int(round(cw / ratio))
    canvas = Image.new('RGB', (cw, ch), '#ffffff')
    canvas.paste(im, ((cw - w) // 2, (ch - h) // 2))
    canvas.save(dst, 'PNG')
    print(f'fit {dst} {canvas.size} ratio={round(cw/ch,3)}')

if __name__ == '__main__':
    fit(sys.argv[1], sys.argv[2], float(sys.argv[3]) if len(sys.argv) > 3 else RATIO)
