"""확장 아이콘(PNG) 생성 — 개발용 도구. 실행 : python3 tools/make-icons.py

Pillow 가 필요하다. 만들어진 PNG 는 저장소에 함께 올리므로 사용자는 실행할 필요가 없다.
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent.parent / "extension" / "icons"
BG = (47, 93, 98, 255)  # 차분한 청록
FG = (255, 255, 255, 255)
FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/Library/Fonts/Arial Bold.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
]


def font(size):
    for f in FONT_CANDIDATES:
        if Path(f).exists():
            return ImageFont.truetype(f, size)
    return ImageFont.load_default()


def make(size):
    scale = 8  # 크게 그린 뒤 줄여서 가장자리를 부드럽게
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = round(s * 0.04)
    d.rounded_rectangle([pad, pad, s - pad, s - pad], radius=round(s * 0.22), fill=BG)
    f = font(round(s * 0.66))
    box = d.textbbox((0, 0), "$", font=f)
    w, h = box[2] - box[0], box[3] - box[1]
    d.text(((s - w) / 2 - box[0], (s - h) / 2 - box[1]), "$", font=f, fill=FG)
    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for n in (16, 32, 48, 128):
        make(n).save(OUT / f"icon{n}.png")
        print("만듦 :", OUT / f"icon{n}.png")
