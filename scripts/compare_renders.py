#!/usr/bin/env python3
"""Compares RAW default renders across apps from one desktop screenshot.

the owner tiles two reference RAW editors (ref-a, ref-b) and Heeler
horizontally on one monitor, loads the same RAW in all three, and
screenshots the whole desktop. This script finds the three photo
viewports, registers them against each other (scale AND offset: apps
disagree about fit zoom, and some honor an in-camera aspect crop that
others ignore, so the panes do not show identical extents), and reports
where Heeler's tone diverges over the region every app actually
displays: overall EV, EV by brightness band, and highlight clipping. One
screenshot in, numbers out; the crops are saved next to the report so a
wrong detection is caught by eye.

Usage:
    python scripts/compare_renders.py "reference/comparisons/shot.png"
    python scripts/compare_renders.py shot.png --apps ref-a,ref-b,heeler --ref ref-b

The app keys only name the panes, left to right, in the report and the
crop files: ref-a and ref-b are the two reference editors, heeler is
Heeler.
"""

from __future__ import annotations

import argparse
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image

# Detection tuning. All on the 1/4-scale mask, all in 0-255 luma.
BRIGHT = 45  # what counts as "photo-bright" against app chrome A photo's BRIGHT
# seed can be much shorter than the photo: on a dusk frame only the
# sky clears the threshold, and a half-dark landscape seeds at ~0.3 of
# the desktop (the owner's canyon screenshot: two panes at 0.31/0.32
# were refused). grow_edges exists to creep the box down over the dark
# half, so the seed bar stays modest and growth does the rest.
MIN_H_FRAC = 0.22  # a viewer photo's bright SEED is at least this tall
MIN_W_FRAC = 0.06  # and at least this wide
EDGE_STD = 3.0  # line luminance std above this reads as photo, not chrome
EDGE_CORR = 0.25  # a photo line correlates at least this much with its neighbor


def luma(rgb: np.ndarray) -> np.ndarray:
    return 0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2]


def srgb_to_linear(u8: np.ndarray) -> np.ndarray:
    c = u8.astype(np.float64) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def resize_arr(a: np.ndarray, w: int, h: int) -> np.ndarray:
    mode = "F" if a.dtype != np.uint8 else None
    im = Image.fromarray(a if a.ndim == 3 else a.astype(np.float32), mode=mode if a.ndim == 2 else None)
    return np.asarray(im.resize((max(1, w), max(1, h)), Image.LANCZOS))


# --- finding the three photo panes -----------------------------------------


def erode(mask: np.ndarray, iterations: int = 1) -> np.ndarray:
    """3x3 erosion. Panel text and slider tracks are bright but thin;
    one pass disconnects them so a photo cannot chain to the next
    window's photo through a line of antialiased label pixels."""
    m = mask
    for _ in range(iterations):
        p = np.pad(m, 1, constant_values=False)
        m = (
            p[1:-1, 1:-1]
            & p[:-2, 1:-1] & p[2:, 1:-1] & p[1:-1, :-2] & p[1:-1, 2:]
            & p[:-2, :-2] & p[:-2, 2:] & p[2:, :-2] & p[2:, 2:]
        )
    return m


def components(mask: np.ndarray) -> list[tuple[int, int, int, int, int]]:
    """Connected components by BFS: (area, x0, y0, x1, y1), no scipy needed."""
    h, w = mask.shape
    seen = np.zeros_like(mask, dtype=bool)
    out = []
    for sy in range(h):
        for sx in range(w):
            if not mask[sy, sx] or seen[sy, sx]:
                continue
            area, x0, y0, x1, y1 = 0, sx, sy, sx, sy
            q = deque([(sy, sx)])
            seen[sy, sx] = True
            while q:
                y, x = q.popleft()
                area += 1
                x0, x1 = min(x0, x), max(x1, x)
                y0, y1 = min(y0, y), max(y1, y)
                for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                    if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        q.append((ny, nx))
            out.append((area, x0, y0, x1, y1))
    return out


def line_corr(a: np.ndarray, b: np.ndarray) -> float:
    a = a - a.mean()
    b = b - b.mean()
    denom = float(np.sqrt((a * a).sum() * (b * b).sum()))
    return 0.0 if denom == 0 else float((a * b).sum() / denom)


def trim_backdrop(lum: np.ndarray, x0: int, y0: int, x1: int, y1: int) -> tuple[int, int, int, int]:
    """Shrinks a bbox over a viewer backdrop that got included in it.

    One reference editor (ref-a) mats its photo on mid-gray, bright enough to join the
    photo's component. Backdrop is the only thing here that is both
    uniform AND mid-dark: blown sky is uniform but white, vegetation is
    dark but textured. An edge is trimmed only while its border line
    stays uniform and near the corner chrome's level.
    """

    def chrome(edge_patches: list[np.ndarray]) -> float | None:
        means = [p.mean() for p in edge_patches]
        if all(p.std() < 4 for p in edge_patches) and all(m < 120 for m in means):
            return float(np.mean(means))
        return None

    p = 6  # corner patch, quarter-scale pixels
    for _ in range(2):  # settle: trimming one axis tightens the other's corners
        tone = chrome([lum[y0:y0 + p, x0:x0 + p], lum[y0:y0 + p, x1 - p:x1]])
        while tone is not None and y1 - y0 > p and lum[y0, x0:x1].std() < 4 and abs(lum[y0, x0:x1].mean() - tone) < 10:
            y0 += 1
        tone = chrome([lum[y1 - p:y1, x0:x0 + p], lum[y1 - p:y1, x1 - p:x1]])
        while tone is not None and y1 - y0 > p and lum[y1 - 1, x0:x1].std() < 4 and abs(lum[y1 - 1, x0:x1].mean() - tone) < 10:
            y1 -= 1
        tone = chrome([lum[y0:y0 + p, x0:x0 + p], lum[y1 - p:y1, x0:x0 + p]])
        while tone is not None and x1 - x0 > p and lum[y0:y1, x0].std() < 4 and abs(lum[y0:y1, x0].mean() - tone) < 10:
            x0 += 1
        tone = chrome([lum[y0:y0 + p, x1 - p:x1], lum[y1 - p:y1, x1 - p:x1]])
        while tone is not None and x1 - x0 > p and lum[y0:y1, x1 - 1].std() < 4 and abs(lum[y0:y1, x1 - 1].mean() - tone) < 10:
            x1 -= 1
    return x0, y0, x1, y1


def grow_edges(lum: np.ndarray, x0: int, y0: int, x1: int, y1: int) -> tuple[int, int, int, int]:
    """Extends a bright-pixel bbox over the photo's dark edges.

    The bright mask misses a dark render's vegetation and shadow at the
    photo's borders (Heeler's default is the dark one today; that is
    the point of the whole exercise). A photo line varies AND
    correlates with the line beside it, because scenes are continuous;
    chrome is flat, and a status bar varies but correlates with
    nothing above it. One odd line inside a photo is allowed (strata
    edges dip below the gate); two failures in a row is the border.
    Bounded to 40% growth so a runaway cannot eat the window.
    """
    h, w = lum.shape

    def photo_like(new: np.ndarray, inside: np.ndarray) -> bool:
        return new.std() > EDGE_STD and line_corr(new, inside) > EDGE_CORR

    def creep(pos: int, limit: int, hi: int, line) -> int:
        grown = 0
        while grown < limit:
            if pos + 1 <= hi and photo_like(line(pos + 1), line(pos)):
                pos += 1
                grown += 1
            elif pos + 2 <= hi and photo_like(line(pos + 2), line(pos)):
                pos += 2
                grown += 2
            else:
                break
        return pos

    limit_y = int((y1 - y0) * 0.4)
    limit_x = int((x1 - x0) * 0.4)
    y1 = creep(y1, limit_y, h - 1, lambda y: lum[y, x0:x1])
    y0 = -creep(-y0, limit_y, 0, lambda y: lum[-y, x0:x1])
    x1 = creep(x1, limit_x, w - 1, lambda x: lum[y0:y1, x])
    x0 = -creep(-x0, limit_x, 0, lambda x: lum[y0:y1, -x])
    return x0, y0, x1, y1


def find_panes(rgb: np.ndarray, expected: int) -> list[tuple[int, int, int, int]]:
    """The `expected` photo viewports, left to right, full-res coords."""
    scale = 4
    small = rgb[::scale, ::scale]
    lum_small = luma(small)
    mask = erode(lum_small > BRIGHT, 2)
    h, w = mask.shape
    panes = [
        c
        for c in components(mask)
        if (c[4] - c[2]) >= h * MIN_H_FRAC and (c[3] - c[1]) >= w * MIN_W_FRAC
    ]
    panes.sort(key=lambda c: -c[0])
    panes = sorted(panes[:expected], key=lambda c: c[1])
    if len(panes) < expected:
        raise SystemExit(
            f"found {len(panes)} photo panes, expected {expected}: "
            "is the same image loaded and visible in every app?"
        )
    out = []
    for _, x0, y0, x1, y1 in panes:
        tx0, ty0, tx1, ty1 = trim_backdrop(lum_small, x0, y0, x1 + 1, y1 + 1)
        gx0, gy0, gx1, gy1 = grow_edges(lum_small, tx0, ty0, tx1 - 1, ty1 - 1)
        out.append((gx0 * scale, gy0 * scale, (gx1 + 1) * scale, (gy1 + 1) * scale))
    return out


# --- registering panes against the reference --------------------------------


def gradient_map(a: np.ndarray) -> np.ndarray:
    """Edge magnitude: tone sliders move luminance wholesale, but edges
    stay where the scene put them. Used as a sanity signal in delta mode."""
    g = np.zeros_like(a)
    g[:, 1:] += np.abs(np.diff(a, axis=1))
    g[1:, :] += np.abs(np.diff(a, axis=0))
    return g


def register(ref_l: np.ndarray, img_l: np.ndarray) -> tuple[float, int, int, float]:
    """(scale, dx, dy, corr) placing img over ref, in ref pixels.

    Apps disagree about fit zoom, and about extent: one may honor an
    in-camera aspect crop that another ignores, so img may cover only
    part of ref (or spill past it). Search scale x offset for the best
    luminance correlation over the overlap; coarse at 160px wide, then
    refined. The scale is relative to img pre-resized to ref's width.
    """
    rh, rw = ref_l.shape
    ih, iw = img_l.shape
    hn = round(ih * rw / iw)  # img at ref width

    ws = 160
    f = rw / ws
    ref_s = resize_arr(ref_l, ws, round(rh / f))
    img_s0 = resize_arr(img_l, ws, round(hn / f))

    def ncc_at(im: np.ndarray, dx: int, dy: int) -> float:
        h1, w1 = im.shape
        ox0, oy0 = max(0, dx), max(0, dy)
        ox1, oy1 = min(ref_s.shape[1], dx + w1), min(ref_s.shape[0], dy + h1)
        if ox1 - ox0 < ws * 0.5 or oy1 - oy0 < ref_s.shape[0] * 0.4:
            return -1.0
        a = ref_s[oy0:oy1, ox0:ox1]
        b = im[oy0 - dy:oy1 - dy, ox0 - dx:ox1 - dx]
        return line_corr(a.ravel(), b.ravel())

    best = (-2.0, 1.0, 0, 0)
    for s in np.linspace(0.75, 1.3, 23):
        im = resize_arr(img_s0, round(img_s0.shape[1] * s), round(img_s0.shape[0] * s))
        span_x = range(-im.shape[1] // 3, ref_s.shape[1] - im.shape[1] * 2 // 3, 2)
        span_y = range(-im.shape[0] // 3, ref_s.shape[0] - im.shape[0] * 2 // 3, 2)
        for dy in span_y:
            for dx in span_x:
                c = ncc_at(im, dx, dy)
                if c > best[0]:
                    best = (c, float(s), dx, dy)
    # Refine offsets at single-pixel working-scale steps.
    c0, s, dx0, dy0 = best
    im = resize_arr(img_s0, round(img_s0.shape[1] * s), round(img_s0.shape[0] * s))
    for dy in range(dy0 - 2, dy0 + 3):
        for dx in range(dx0 - 2, dx0 + 3):
            c = ncc_at(im, dx, dy)
            if c > best[0]:
                best = (c, s, dx, dy)
    c0, s, dx, dy = best
    return s, round(dx * f), round(dy * f), c0


def place(crop: np.ndarray, ref_shape: tuple[int, int], s: float) -> np.ndarray:
    """The crop resized into ref coordinates at registered scale."""
    rh, rw = ref_shape
    hn = round(crop.shape[0] * rw / crop.shape[1])
    return resize_arr(crop, round(rw * s), round(hn * s))


# --- the comparison itself ---------------------------------------------------


BANDS = [(0, 25, "shadows   (0-25%)"), (25, 50, "low mids (25-50%)"),
         (50, 75, "high mids(50-75%)"), (75, 95, "brights  (75-95%)"),
         (95, 100, "highlights(95%+) ")]


# --- CIELAB color difference (ICC WP27/WP22 methodology) ---------------------


def linear_rgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    """Linear sRGB (D65) to CIELAB, vectorized. Lab is where 'how
    different does this look' lives; RGB distance is not that."""
    m = np.array([
        [0.4124564, 0.3575761, 0.1804375],
        [0.2126729, 0.7151522, 0.0721750],
        [0.0193339, 0.1191920, 0.9503041],
    ])
    xyz = rgb @ m.T
    white = np.array([0.95047, 1.0, 1.08883])  # D65, sRGB's native white
    t = xyz / white
    f = np.where(t > (6 / 29) ** 3, np.cbrt(t), t / (3 * (6 / 29) ** 2) + 4 / 29)
    lab = np.empty_like(f)
    lab[..., 0] = 116 * f[..., 1] - 16
    lab[..., 1] = 500 * (f[..., 0] - f[..., 1])
    lab[..., 2] = 200 * (f[..., 1] - f[..., 2])
    return lab


def wp22_grade(mean_de: float) -> str:
    """WP22's instrument-agreement bands, repurposed: two independent
    renderers agreeing to 0.5-2.0 mean dE is NORMAL; zero is not the bar."""
    if mean_de < 0.2:
        return "excellent (indistinguishable implementations)"
    if mean_de < 0.5:
        return "very good"
    if mean_de < 2.0:
        return "normal for independent implementations"
    return "large: a deliberate look difference or a defect"


def lab_stats(ref_srgb_u8: np.ndarray, app_srgb_u8: np.ndarray) -> str:
    """dE*ab statistics over 4x4 block means, with signed channel deltas
    (a consistent signed db* is a transfer or white-point bug that a
    scalar mean hides) and a near-neutral subset (casts in grays show
    below the dE that passes elsewhere)."""
    ref_lin = np.stack([block_mean(srgb_to_linear(ref_srgb_u8[..., c])) for c in range(3)], axis=-1)
    app_lin = np.stack([block_mean(srgb_to_linear(app_srgb_u8[..., c])) for c in range(3)], axis=-1)
    ref_lab = linear_rgb_to_lab(ref_lin)
    app_lab = linear_rgb_to_lab(app_lin)
    d = app_lab - ref_lab
    de = np.sqrt((d ** 2).sum(axis=-1))
    lines = [
        f"    dE*ab mean {de.mean():.2f}  RMS {np.sqrt((de ** 2).mean()):.2f}  "
        f"p95 {np.percentile(de, 95):.2f}  max {de.max():.2f}   [{wp22_grade(float(de.mean()))}]",
        f"    signed bias dL* {d[..., 0].mean():+.2f}  da* {d[..., 1].mean():+.2f}  db* {d[..., 2].mean():+.2f}",
    ]
    chroma = np.sqrt(ref_lab[..., 1] ** 2 + ref_lab[..., 2] ** 2)
    neutral = chroma < 12
    if neutral.sum() > 50:
        lines.append(
            f"    near-neutrals ({int(neutral.sum())} px): dE {de[neutral].mean():.2f}  "
            f"da* {d[..., 1][neutral].mean():+.2f}  db* {d[..., 2][neutral].mean():+.2f}"
        )
    return "\n".join(lines)


def block_mean(a: np.ndarray, k: int = 4) -> np.ndarray:
    h, w = (a.shape[0] // k) * k, (a.shape[1] // k) * k
    return a[:h, :w].reshape(h // k, k, w // k, k).mean(axis=(1, 3))


def ev_diff(y_app: np.ndarray, y_ref: np.ndarray, sel: np.ndarray) -> float:
    """Median exposure difference over `sel`, in stops. Floors tiny
    values: log2 of near-black is noise amplified to nonsense."""
    floor = 1e-4
    a = np.maximum(y_app[sel], floor)
    r = np.maximum(y_ref[sel], floor)
    return float(np.median(np.log2(a / r)))


def report(names: list[str], commons: list[np.ndarray], ref_idx: int) -> str:
    # Full-res linear luminance for clipping; 4x4 block means for the
    # band comparison. Registration is good to a few pixels, not one,
    # and per-pixel ratios on fine texture read jitter as exposure.
    ys_full = [luma(srgb_to_linear(c[..., :3])) for c in commons]
    ys = [block_mean(y) for y in ys_full]
    y_ref = ys[ref_idx]
    cuts = np.percentile(y_ref, [b for b, _, _ in BANDS] + [100])
    lines = [f"reference: {names[ref_idx]}", ""]
    lines.append(f"{'':>12}  mean EV   clipped")
    for name, y_full in zip(names, ys_full):
        clip = float(np.mean(y_full >= 0.985)) * 100
        lines.append(f"{name:>12}  {np.log2(max(y_full.mean(), 1e-6)):+7.2f}   {clip:5.1f}%")
    lines.append("")
    lines.append("EV vs reference, by reference brightness band:")
    lines.append(f"{'band':<20}" + "".join(f"{n:>12}" for i, n in enumerate(names) if i != ref_idx))
    for (lo, hi, label), c0, c1 in zip(BANDS, cuts[:-1], cuts[1:]):
        sel = (y_ref >= c0) & (y_ref <= c1 if hi == 100 else y_ref < c1)
        row = f"{label:<20}"
        for i, y in enumerate(ys):
            if i == ref_idx:
                continue
            row += f"{ev_diff(y, y_ref, sel):+11.2f} "
        lines.append(row)
    lines.append("")
    lines.append("CIELAB color difference vs reference:")
    for i, name in enumerate(names):
        if i == ref_idx:
            continue
        lines.append(f"  {name}:")
        lines.append(lab_stats(commons[ref_idx][..., :3], commons[i][..., :3]))
    return "\n".join(lines)


def delta_report(names: list[str], shot_rgb: np.ndarray, baseline: Path, out: Path) -> str:
    """Each app against ITS OWN default render: what did the slider do?

    Slider units are not comparable across vendors (one
    editor's highlights -50 is a different amount of medicine than another's),
    so the meaningful comparison is each app's response measured from its
    own baseline: which bands moved, in which direction, by how much.
    Bands are percentiles of each app's own baseline luminance.

    The panes are found ONCE, on the baseline screenshot, and those same
    pixel boxes crop every setting shot: the windows have not moved
    between shots of one session, and re-detecting on a render a slider
    has crushed to near-black is how a wrong pane ends up measured. The
    edge-map correlation printed per app is the tripwire for the one
    thing this cannot survive, a window moved mid-session.
    """
    if not baseline.is_file():
        raise SystemExit(f"--baseline {baseline} must be the scene's all-defaults screenshot")
    base_rgb = np.asarray(Image.open(baseline).convert("RGB"))
    boxes = find_panes(base_rgb, len(names))

    cols: dict[str, list[float]] = {}
    clips: dict[str, tuple[float, float]] = {}
    for name, (x0, y0, x1, y1) in zip(names, boxes):
        b = base_rgb[y0:y1, x0:x1]
        n = shot_rgb[y0:y1, x0:x1]
        Image.fromarray(n).save(out / f"{name}.png")
        # Same desktop coordinates, so alignment is identity. The edge
        # maps still have to agree on where the scene's structure sits.
        gb = gradient_map(block_mean(luma(b.astype(np.float64))))
        gn = gradient_map(block_mean(luma(n.astype(np.float64))))
        sanity = line_corr(gb.ravel(), gn.ravel())
        flag = "  <- check the crops: did a window move?" if sanity < 0.3 else ""
        print(f"{name}: edge agreement {sanity:.3f}{flag}")
        yb_full = luma(srgb_to_linear(b))
        yn_full = luma(srgb_to_linear(n))
        clips[name] = (float(np.mean(yb_full >= 0.985)) * 100, float(np.mean(yn_full >= 0.985)) * 100)
        yb, yn = block_mean(yb_full), block_mean(yn_full)
        cuts = np.percentile(yb, [b0 for b0, _, _ in BANDS] + [100])
        col = []
        for (lo, hi, _), c0, c1 in zip(BANDS, cuts[:-1], cuts[1:]):
            sel = (yb >= c0) & (yb <= c1 if hi == 100 else yb < c1)
            col.append(ev_diff(yn, yb, sel))
        cols[name] = col

    lines = ["EV change from each app's own default, by that app's brightness band:", ""]
    lines.append(f"{'band':<20}" + "".join(f"{n:>12}" for n in names))
    for i, (_, _, label) in enumerate(BANDS):
        lines.append(f"{label:<20}" + "".join(f"{cols[n][i]:+11.2f} " for n in names))
    lines.append("")
    lines.append(f"{'clipped %':<20}" + "".join(
        f"{clips[n][0]:5.1f}->{clips[n][1]:4.1f} " for n in names))
    lines.append("")
    lines.append("CIELAB change from each app's own default:")
    for name, (x0, y0, x1, y1) in zip(names, boxes):
        lines.append(f"  {name}:")
        lines.append(lab_stats(base_rgb[y0:y1, x0:x1], shot_rgb[y0:y1, x0:x1]))
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("screenshot", type=Path)
    ap.add_argument("--apps", default="ref-a,ref-b,heeler",
                    help="window order, left to right (ref-a and ref-b are the "
                    "two reference editors, heeler is Heeler)")
    ap.add_argument("--ref", default="ref-b",
                    help="which app the EV bands compare against")
    ap.add_argument("--baseline", type=Path, default=None,
                    help="the scene's all-defaults screenshot (or a directory of "
                    "{app}.png crops); switches to delta mode, comparing each app "
                    "against its own default render")
    ap.add_argument("--out", type=Path, default=None,
                    help="where crops and the report go (default: alongside the screenshot)")
    args = ap.parse_args()

    names = [n.strip() for n in args.apps.split(",")]
    if args.ref not in names:
        raise SystemExit(f"--ref {args.ref} is not one of {names}")
    rgb = np.asarray(Image.open(args.screenshot).convert("RGB"))

    if args.baseline:
        out = args.out or args.screenshot.parent / args.screenshot.stem.replace(" ", "_")
        out.mkdir(parents=True, exist_ok=True)
        text = delta_report(names, rgb, args.baseline, out)
        (out / "report.txt").write_text(text, encoding="utf-8")
        print()
        print(text)
        print()
        print(f"crops and report in {out}")
        return

    boxes = find_panes(rgb, len(names))
    crops = [rgb[y0:y1, x0:x1] for x0, y0, x1, y1 in boxes]
    ref_idx = names.index(args.ref)
    ref = crops[ref_idx]
    ref_l = luma(ref.astype(np.float64))

    # Register every pane onto the reference, then compare only the
    # rectangle every app displays. Different extents otherwise smear
    # sky EV into vegetation EV and the bands become fiction.
    placed: list[tuple[np.ndarray, int, int]] = []
    rect = (0, 0, ref.shape[1], ref.shape[0])
    for i, crop in enumerate(crops):
        if i == ref_idx:
            placed.append((ref, 0, 0))
            continue
        s, dx, dy, corr = register(ref_l, luma(crop.astype(np.float64)))
        img = place(crop, ref.shape[:2], s)
        placed.append((img, dx, dy))
        print(f"{names[i]}: scale {s:.3f} offset ({dx},{dy}) corr {corr:.3f}")
        rect = (max(rect[0], dx), max(rect[1], dy),
                min(rect[2], dx + img.shape[1]), min(rect[3], dy + img.shape[0]))
    x0, y0, x1, y1 = rect
    if x1 - x0 < 50 or y1 - y0 < 50:
        raise SystemExit(f"registration produced a degenerate common region {rect}")
    cover = 100.0 * (x1 - x0) * (y1 - y0) / (ref.shape[0] * ref.shape[1])
    print(f"common region: {x1 - x0}x{y1 - y0} ({cover:.0f}% of {names[ref_idx]}'s view)")

    commons = [img[y0 - dy:y1 - dy, x0 - dx:x1 - dx] for img, dx, dy in placed]

    out = args.out or args.screenshot.parent / args.screenshot.stem.replace(" ", "_")
    out.mkdir(parents=True, exist_ok=True)
    for name, c in zip(names, commons):
        Image.fromarray(c.astype(np.uint8)).save(out / f"{name}.png")
    Image.fromarray(np.concatenate(commons, axis=1).astype(np.uint8)).save(out / "side-by-side.png")

    text = report(names, commons, ref_idx)
    (out / "report.txt").write_text(text, encoding="utf-8")
    print()
    print(text)
    print()
    print(f"crops and report in {out}")


if __name__ == "__main__":
    main()
