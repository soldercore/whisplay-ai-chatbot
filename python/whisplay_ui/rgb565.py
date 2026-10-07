"""Fast RGB888 -> RGB565 (big-endian) conversion for partial LCD updates.

Byte order matches utils.ImageUtils.image_to_rgb565 (high byte first) but
returns `bytes` instead of a Python list, which is far cheaper to build.
"""
import numpy as np


def to_rgb565(image):
    """image: PIL image or an (h, w, 3) uint8 array."""
    if not isinstance(image, np.ndarray):
        image = np.asarray(image.convert("RGB"))
    arr = image.astype(np.uint16)
    value = ((arr[:, :, 0] >> 3) << 11) | ((arr[:, :, 1] >> 2) << 5) | (arr[:, :, 2] >> 3)
    return value.astype(">u2").tobytes()


def is_rgb565_exact(color):
    """True when an (r, g, b) colour survives the 565 round trip unchanged."""
    r, g, b = color[:3]
    return (
        ((r >> 3) << 3 | (r >> 5)) == r
        and ((g >> 2) << 2 | (g >> 6)) == g
        and ((b >> 3) << 3 | (b >> 5)) == b
    )
