#!/usr/bin/env python3
"""모바일 스크린샷 여러 장을 가로로 나란히 배치 → 1.4:1 가로형 카드."""
import sys
from PIL import Image

def combine(srcs, dst, ratio=1.4, gap_ratio=0.06, bg='#ffffff'):
    imgs = [Image.open(s).convert('RGB') for s in srcs]
    # 높이 통일
    H = max(im.size[1] for im in imgs)
    scaled = []
    for im in imgs:
        w, h = im.size
        nw = int(w * H / h)
        scaled.append(im.resize((nw, H), Image.LANCZOS))
    gap = int(H * gap_ratio)
    total_w = sum(im.size[0] for im in scaled) + gap * (len(scaled) - 1)
    # 캔버스 비율 맞추기 (좌우/상하 여백)
    pad = int(H * 0.06)
    content_w = total_w + pad * 2
    content_h = H + pad * 2
    # ratio 보정 (가로 더 넓히기)
    if content_w / content_h < ratio:
        content_w = int(content_h * ratio)
    else:
        content_h = int(content_w / ratio)
    canvas = Image.new('RGB', (content_w, content_h), bg)
    x = (content_w - total_w) // 2
    y = (content_h - H) // 2
    for im in scaled:
        canvas.paste(im, (x, y))
        x += im.size[0] + gap
    canvas.save(dst, 'PNG')
    print(f'combined {dst} {canvas.size} ratio={round(content_w/content_h,2)}')

if __name__ == '__main__':
    dst = sys.argv[1]
    srcs = sys.argv[2:]
    combine(srcs, dst)
