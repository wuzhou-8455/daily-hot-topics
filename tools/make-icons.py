"""生成应用图标（纯标准库，无需 Pillow）。

用法：
    python tools/make-icons.py

产出：
    build/icon.png   256x256  应用图标（electron-builder 会自动转 ico）
    build/tray.png    32x32   托盘图标
    build/tray@2x.png 64x64   高分屏托盘图标
"""

import os
import struct
import zlib

ASSET_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "build")
# 托盘图标必须放在被 app 打包的源码目录下（build/ 是 electron-builder 的 buildResources，
# 默认不会进 app.asar，运行时读不到）。
TRAY_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src", "main", "assets")

ACCENT = (200, 55, 45)
WHITE = (255, 255, 255)


def chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def write_png(path: str, width: int, height: int, rows) -> None:
    raw = b"".join(b"\x00" + b"".join(bytes(px) for px in row) for row in rows)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as fh:
        fh.write(png)


def inside_round_rect(x: float, y: float, x0: float, y0: float, x1: float, y1: float, r: float) -> bool:
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def smooth(alpha: float) -> int:
    return max(0, min(255, int(round(alpha * 255))))


def make_icon(size: int, pad_ratio: float = 0.06, radius_ratio: float = 0.22):
    """红底圆角方块 + 四根白色柱（呼应界面左上角的柱状图标）。"""
    pad = size * pad_ratio
    x0, y0 = pad, pad
    x1, y1 = size - pad, size - pad
    radius = size * radius_ratio

    # 柱子的相对几何（与 index.html 里的 svg path 同一套比例）
    bars = [
        (0.20, 0.42),
        (0.40, 0.72),
        (0.60, 0.46),
        (0.80, 0.62),
    ]
    bar_w = size * 0.085
    top_limit = 0.26
    bottom = 0.80

    rows = []
    for py in range(size):
        row = []
        for px in range(size):
            x, y = px + 0.5, py + 0.5
            inside = inside_round_rect(x, y, x0, y0, x1, y1, radius)

            # 圆角外做 1px 羽化，避免锯齿
            if not inside:
                near = inside_round_rect(x, y, x0 - 1, y0 - 1, x1 + 1, y1 + 1, radius + 1)
                row.append((*ACCENT, smooth(0.45) if near else 0))
                continue

            color = ACCENT
            ny = (y - y0) / (y1 - y0)
            nx = (x - x0) / (x1 - x0)
            for bx, bh in bars:
                left = bx - (bar_w / size) / 2
                right = bx + (bar_w / size) / 2
                if left <= nx <= right and top_limit <= ny <= bottom and ny >= bottom - bh:
                    color = WHITE
                    break
            row.append((*color, 255))
        rows.append(row)
    return rows


def main() -> None:
    os.makedirs(ASSET_DIR, exist_ok=True)
    os.makedirs(TRAY_DIR, exist_ok=True)
    targets = [
        (ASSET_DIR, "icon.png", 256, 0.05, 0.24),
        (ASSET_DIR, "tray.png", 32, 0.02, 0.22),
        (ASSET_DIR, "tray@2x.png", 64, 0.04, 0.22),
        # 运行时用的托盘图（随 app 一起打包）
        (TRAY_DIR, "tray.png", 32, 0.02, 0.22),
        (TRAY_DIR, "tray@2x.png", 64, 0.04, 0.22),
    ]
    for folder, name, size, pad, rad in targets:
        path = os.path.join(folder, name)
        write_png(path, size, size, make_icon(size, pad, rad))
        print(f"wrote {path} ({os.path.getsize(path)} bytes)")


if __name__ == "__main__":
    main()
