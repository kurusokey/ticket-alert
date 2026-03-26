#!/usr/bin/env python3
"""Generate PNG icons from SVG for PWA. Run: python3 icons/generate-pngs.py"""
from PIL import Image, ImageDraw, ImageFont
import os

BASE = os.path.dirname(os.path.abspath(__file__))
BG = (10, 10, 15)

for size, name in [(192, "icon-192.png"), (512, "icon-512.png")]:
    img = Image.new("RGBA", (size, size), BG + (255,))
    draw = ImageDraw.Draw(img)
    margin = int(size * 0.15)
    ticket_color = (249, 115, 22)
    x0, y0 = margin, int(size * 0.25)
    x1, y1 = size - margin, int(size * 0.75)
    draw.rounded_rectangle([x0, y0, x1, y1], radius=int(size * 0.06), fill=ticket_color)
    notch_x = x0 + int((x1 - x0) * 0.33)
    notch_r = int(size * 0.045)
    draw.ellipse([notch_x - notch_r, y0 - notch_r, notch_x + notch_r, y0 + notch_r], fill=BG + (255,))
    draw.ellipse([notch_x - notch_r, y1 - notch_r, notch_x + notch_r, y1 + notch_r], fill=BG + (255,))
    try:
        font_go = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", int(size * 0.1))
        font_fmt = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", int(size * 0.16))
    except Exception:
        font_go = ImageFont.load_default()
        font_fmt = ImageFont.load_default()
    stub_cx = x0 + (notch_x - x0) // 2
    cy = (y0 + y1) // 2
    bb = draw.textbbox((0, 0), "go", font=font_go)
    draw.text((stub_cx - (bb[2] - bb[0]) // 2, cy - (bb[3] - bb[1]) // 2), "go", fill=BG + (255,), font=font_go)
    main_cx = notch_x + (x1 - notch_x) // 2
    bb2 = draw.textbbox((0, 0), "FMT", font=font_fmt)
    draw.text((main_cx - (bb2[2] - bb2[0]) // 2, cy - (bb2[3] - bb2[1]) // 2), "FMT", fill=(255, 255, 255, 255), font=font_fmt)
    path = os.path.join(BASE, name)
    img.save(path, "PNG")
    print(f"Created {path}")
