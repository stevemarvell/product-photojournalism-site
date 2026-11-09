"""ImageRenderer on Pillow, and the in-process ImageProcessor."""

import io
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor

from PIL import Image, ImageOps, UnidentifiedImageError

from api.application import RenderedImage
from api.domain import WEB_WIDTHS, ImageProcessingError

# A small file can declare billions of pixels (a decompression bomb). Pillow itself only
# warns between its MAX_IMAGE_PIXELS and twice that, so the renderer checks the declared
# size against its own limit before decoding anything, and fails the image. 64 million
# pixels covers the largest common camera sensors (61 MP) and keeps decoding within a
# few hundred MB. Configurable as IMAGE_MAX_PIXELS.
DEFAULT_MAX_PIXELS = 64_000_000
JPEG_QUALITY = 82


class PillowImageRenderer:
    """Re-encodes from decoded pixels only.

    Nothing from the original's metadata block is carried over: the output is built from
    the pixel data and saved with no `exif`, `icc_profile` or `xmp`, and the orientation
    tag is applied to the pixels first so the picture still stands the right way up.
    """

    def __init__(
        self, widths: tuple[int, ...] = WEB_WIDTHS, max_pixels: int = DEFAULT_MAX_PIXELS
    ) -> None:
        self._widths = widths
        self._max_pixels = max_pixels

    def render(self, data: bytes) -> RenderedImage:
        try:
            with Image.open(io.BytesIO(data)) as opened:
                if opened.width * opened.height > self._max_pixels:
                    raise ImageProcessingError("image has too many pixels")
                opened.load()
                upright = ImageOps.exif_transpose(opened) or opened
                rgb = _flatten(upright)
        except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as e:
            raise ImageProcessingError("not a readable image") from e
        width, height = rgb.size
        # Never upscale: only widths the original reaches, and its own width if it is
        # narrower than the smallest.
        widths = sorted({w for w in self._widths if w <= width}) or [width]
        versions = []
        for target in widths:
            resized = (
                rgb
                if target == width
                else rgb.resize((target, max(1, round(height * target / width))), Image.LANCZOS)
            )
            out = io.BytesIO()
            # Rebuild from the pixels: a fresh image object carries no info dict at all.
            clean = Image.frombytes("RGB", resized.size, resized.tobytes())
            clean.save(out, "JPEG", quality=JPEG_QUALITY, optimize=True)
            versions.append((target, out.getvalue()))
        return RenderedImage(width, height, tuple(versions))


def _flatten(image: Image.Image) -> Image.Image:
    """RGB pixels, with transparency laid on white (JPEG has none)."""
    if image.mode in ("RGBA", "LA", "P"):
        rgba = image.convert("RGBA")
        base = Image.new("RGB", rgba.size, "white")
        base.paste(rgba, mask=rgba.getchannel("A"))
        return base
    return image.convert("RGB")


class InProcessImageProcessor:
    """Runs `work(organisation_id, image_id)` on a thread of this process.

    Fine for a local run. On a serverless host a thread may be frozen once the response
    is sent, which is why this sits behind the ImageProcessor port (spec section 13).
    """

    def __init__(self, work: Callable[[str, str], None]) -> None:
        self._work = work
        self._pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="image")

    def enqueue(self, organisation_id: str, image_id: str) -> None:
        self._pool.submit(self._work, organisation_id, image_id)
