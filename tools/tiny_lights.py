"""Encode BSP30 lightmap charts for the compact viewer."""

import io
import math
import struct
import zlib

from PIL import Image


ATLAS_WIDTH = 512
# Signature, mode, original RGB byte count, dimensions byte count.
HEADER = struct.Struct("<4sBII")
BSP_LUMPS = struct.Struct("<30i")
FLOAT32 = struct.Struct("<f")
GRADIENT_MODE = 4
BRIGHTNESS_STEP = 6
GRADIENT_STEP = 20
# RGB chromaticity families normalized to red on a scale of 256.
LIGHT_TINTS = ((256, 256, 181), (256, 256, 214), (256, 256, 249), (256, 265, 288))


def _float32(value):
    return FLOAT32.unpack(FLOAT32.pack(value))[0]


def _charts(lumps, lighting_size):
    """Return (byte offset, width, height) for each stored style chart."""
    vertices = list(struct.iter_unpack("<3f", lumps[3]))
    axes = list(struct.iter_unpack("<8f8x", lumps[6]))
    edges = list(struct.iter_unpack("<2H", lumps[12]))
    surfedges = [edge for edge, in struct.iter_unpack("<i", lumps[13])]
    charts = []
    for edge, count, texinfo, styles, offset in struct.iter_unpack("<4xiHH4si", lumps[7]):
        if offset < 0:
            continue
        if count < 3 or edge < 0 or edge + count > len(surfedges) or texinfo >= len(axes):
            return []
        ring = surfedges[edge:edge + count]
        polygon = [vertices[edges[abs(index)][index < 0]] for index in ring]
        dimensions = []
        for axis in (axes[texinfo][:4], axes[texinfo][4:]):
            s, t, u, origin = axis
            # Round after the full projection to match BSP30 lightmap extents.
            values = [_float32(x * s + y * t + z * u + origin) for x, y, z in polygon]
            dimensions.append(math.ceil(max(values) / 16) - math.floor(min(values) / 16) + 1)
        width, height = dimensions
        stride = 3 * width * height
        for slot, style in enumerate(styles):
            if style == 255:
                break
            charts.append((offset + slot * stride, width, height))

    charts.sort()
    end = 0
    for offset, width, height in charts:
        if offset != end:
            return []
        end += 3 * width * height
    return charts if end == lighting_size else []


def _encode_dimensions(charts):
    metadata = bytearray()
    for _, width, height in charts:
        if width <= 16 and height <= 16 and (width, height) != (16, 16):
            metadata.append((width - 1) * 16 + height - 1)
        else:
            metadata.extend(struct.pack("<BHH", 255, width, height))
    return metadata


def _coordinate_basis(size):
    return [2 * i / (size - 1) - 1 for i in range(size)] if size > 1 else [0]


def _fit_gradients(samples, width, height, tint, norm):
    horizontal = _coordinate_basis(width)
    vertical = _coordinate_basis(height)
    norm_u = sum(u * u for u in horizontal)
    norm_v = sum(v * v for v in vertical)
    sum_u = sum_v = sum_uv = 0
    red, green, blue = tint
    for row, v in enumerate(vertical):
        offset = row * width * 3
        for column, u in enumerate(horizontal):
            at = offset + column * 3
            intensity = samples[at] * red + samples[at + 1] * green + samples[at + 2] * blue
            sum_u += intensity * u
            sum_v += intensity * v
            sum_uv += intensity * u * v
    gain = 256 / (norm * GRADIENT_STEP)
    x_grad = round(gain * sum_u / (height * norm_u)) if norm_u else 0
    y_grad = round(gain * sum_v / (width * norm_v)) if norm_v else 0
    xy_grad = round(gain * sum_uv / (norm_u * norm_v)) if norm_u and norm_v else 0
    # Small interaction terms cost bytes while changing mainly the far corners.
    return x_grad, y_grad, xy_grad if abs(xy_grad) >= 2 else 0


def _pack_gradients(lighting, charts, dimensions):
    # Store the color and three coefficient planes separately so the long runs
    # of zero coefficients on flat charts compress together.
    colors = bytearray()
    gradients = [bytearray(), bytearray(), bytearray()]
    norms = [sum(channel * channel for channel in tint) for tint in LIGHT_TINTS]
    for offset, width, height in charts:
        area = width * height
        samples = lighting[offset:offset + area * 3]
        rgb = [sum(samples[channel::3]) for channel in range(3)]
        weights = [sum(a * b for a, b in zip(rgb, tint)) for tint in LIGHT_TINTS]
        tint_id = max(range(len(LIGHT_TINTS)), key=lambda i: weights[i] ** 2 / norms[i])
        level = min(43, round(256 * weights[tint_id] / (norms[tint_id] * area * BRIGHTNESS_STEP)))
        colors.append((level << 2) | tint_id)
        coefficients = (0, 0, 0)
        if area >= 12 and weights[tint_id]:
            coefficients = _fit_gradients(samples, width, height, LIGHT_TINTS[tint_id], norms[tint_id])
        for plane, coefficient in zip(gradients, coefficients):
            plane.append(2 * coefficient if coefficient >= 0 else -2 * coefficient - 1)
    data = zlib.compress(b"".join([dimensions, colors, *gradients]), 9)
    return HEADER.pack(b"LM01", GRADIENT_MODE, len(lighting), len(dimensions)) + data


def pack_lights(bsp: bytes, quality: int) -> bytes:
    """Encode the RGB lump at quality 0–100. Quality 100 is lossless."""
    if not 0 <= quality <= 100:
        raise ValueError("Lightmap quality must be between 0 and 100.")
    if len(bsp) < 124 or struct.unpack_from("<i", bsp)[0] != 30:
        raise ValueError("Expected a BSP version 30 map.")
    directory = BSP_LUMPS.unpack_from(bsp, 4)
    lumps = []
    for offset, length in zip(directory[::2], directory[1::2]):
        if offset < 0 or length < 0 or offset + length > len(bsp):
            raise ValueError("Invalid BSP lump range.")
        lumps.append(memoryview(bsp)[offset:offset + length])
    lighting = lumps[8]

    # Chart atlases need independent, contiguous sample ranges. Preserve the
    # original bytes for other lump layouts or charts outside the atlas limits.
    def compressed_original():
        return HEADER.pack(b"LM01", 0, len(lighting), 0) + zlib.compress(lighting, 9)

    charts = _charts(lumps, len(lighting))
    if not charts or any(max(width, height) > 65535 for _, width, height in charts):
        return compressed_original()

    metadata = _encode_dimensions(charts)
    if quality == 0:
        return _pack_gradients(lighting, charts, metadata)

    if quality < 20:
        scale, webp_quality = 3, quality + 20
    elif quality < 40:
        scale, webp_quality = 2, quality + 12
    else:
        scale, webp_quality = 1, round(18 + (quality - 40) * 82 / 60)

    sampled = []
    for offset, width, height in charts:
        sample_width = (width + scale - 1) // scale
        sample_height = (height + scale - 1) // scale
        sampled.append((offset, width, height, sample_width, sample_height))

    placements = []
    x = y = row_height = 0
    # Python and JavaScript both retain source order for equal chart heights.
    for chart in sorted(sampled, key=lambda item: -item[4]):
        _, _, _, width, height = chart
        if width + 2 > ATLAS_WIDTH:
            return compressed_original()
        if x + width + 2 > ATLAS_WIDTH:
            x = 0
            y += row_height
            row_height = 0
        placements.append((x, y, chart))
        x += width + 2
        row_height = max(row_height, height + 2)
    if y + row_height > 16383:
        return compressed_original()

    atlas = Image.new("RGB", (ATLAS_WIDTH, y + row_height))
    for x, y, (offset, width, height, sample_width, sample_height) in placements:
        samples = bytes(lighting[offset:offset + 3 * width * height])
        chart = Image.frombytes("RGB", (width, height), samples)
        if scale > 1:
            chart = chart.resize((sample_width, sample_height), Image.Resampling.BILINEAR)
        # Extend each chart's own colors to protect adjacent charts during
        # lossy WebP's chroma subsampling.
        atlas.paste(chart, (x + 1, y + 1))
        atlas.paste(chart.crop((0, 0, 1, sample_height)), (x, y + 1))
        atlas.paste(
            chart.crop((sample_width - 1, 0, sample_width, sample_height)),
            (x + sample_width + 1, y + 1),
        )
        right = x + sample_width + 2
        bottom = y + sample_height
        atlas.paste(atlas.crop((x, y + 1, right, y + 2)), (x, y))
        atlas.paste(atlas.crop((x, bottom, right, bottom + 1)), (x, bottom + 1))

    with io.BytesIO() as encoded:
        atlas.save(encoded, format="WEBP", quality=webp_quality, method=6, lossless=quality == 100)
        dimensions = zlib.compress(metadata, 9)
        return HEADER.pack(b"LM01", scale, len(lighting), len(dimensions)) + dimensions + encoded.getvalue()
