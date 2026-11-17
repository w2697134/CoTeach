# 把尺子截的每一页拼成一张总览图（一行 4 页），人看一眼整套课件好不好看
#   python tools/slide-measure/sheet.py <截图目录> <输出.png>
import sys
from pathlib import Path
from PIL import Image, ImageDraw

src, out = Path(sys.argv[1]), Path(sys.argv[2])
pages = sorted(src.glob('page-*.png'))
if not pages:
    raise SystemExit('没有截图')
W, H, GAP, COLS = 480, 270, 12, 4
rows = (len(pages) + COLS - 1) // COLS
sheet = Image.new('RGB', (COLS * W + (COLS + 1) * GAP, rows * (H + 22) + (rows + 1) * GAP), (238, 240, 246))
draw = ImageDraw.Draw(sheet)
for k, f in enumerate(pages):
    im = Image.open(f).convert('RGB').resize((W, H), Image.LANCZOS)
    x = GAP + (k % COLS) * (W + GAP)
    y = GAP + (k // COLS) * (H + 22 + GAP)
    sheet.paste(im, (x, y + 20))
    draw.text((x, y + 2), f.stem.replace('page-', '第 ') + ' 页', fill=(90, 96, 120))
sheet.save(out)
print(out, sheet.size)
