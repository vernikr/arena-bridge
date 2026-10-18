#!/usr/bin/env python3
"""Turn the flat app icon into a macOS icon: the area around the squircle becomes transparent."""

import numpy as np
from PIL import Image
from scipy import ndimage

SRC = "macos/ArenaBridge/Resources/AppIcon.png"
DST = "macos/ArenaBridge/Resources/AppIcon.png"
SIZE = 1024

im = Image.open(SRC).convert("RGB")
a = np.asarray(im).astype(np.int16)
r, g, b = a[..., 0], a[..., 1], a[..., 2]
low = a.min(axis=2)
high = a.max(axis=2)

# the flat background: light and neutral
background = (low >= 188) & ((high - low) <= 34)

# keep only the background that touches the border, so the light parts inside stay
labels, count = ndimage.label(background)
border = set(labels[0, :]) | set(labels[-1, :]) | set(labels[:, 0]) | set(labels[:, -1])
border.discard(0)
outside = np.isin(labels, list(border)) if border else np.zeros_like(background)

luma = (0.299 * r + 0.587 * g + 0.114 * b)
bg_luma = 238.0
edge_luma = 45.0
coverage = np.clip((bg_luma - luma) / (bg_luma - edge_luma), 0.0, 1.0)

alpha = np.full(luma.shape, 255.0)
alpha[outside] = 0.0

# the one-pixel band around the cut gets the soft coverage, so the edge is not jagged
band = ndimage.binary_dilation(outside, iterations=4) & ~outside
alpha[band] = coverage[band] * 255.0

rgba = np.dstack([a.astype(np.uint8), alpha.astype(np.uint8)])
out = Image.fromarray(rgba, "RGBA").resize((SIZE, SIZE), Image.LANCZOS)
out.save(DST)

print("saved", DST, out.size, "transparent corners:",
      out.getpixel((0, 0))[3], out.getpixel((SIZE - 1, SIZE - 1))[3])
