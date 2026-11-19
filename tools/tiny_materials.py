"""Encode the authored map materials in one compact AVIF atlas."""

from io import BytesIO
from pathlib import Path
from struct import Struct, iter_unpack, unpack_from

from PIL import Image


HEADER = Struct("<4sH")
RECORD = Struct("<16sHHBB")
MIP_HEADER = Struct("<16s6I")
WAD_ENTRY = Struct("<3IBB2x16s")
HIDDEN = {"aaatrigger", "clip", "hint", "skip", "null", "origin", "bevel", "nodraw"}


def name_of(raw):
    return raw.split(b"\0", 1)[0].decode("ascii").lower()


def load_wad(path):
    data = memoryview(path.read_bytes())
    magic, count, directory = unpack_from("<4sII", data)
    if magic != b"WAD3":
        raise ValueError(f"Expected a WAD3 file at {path}")
    return {
        name_of(name): data[start:start + length]
        for start, length, _, kind, compression, name in WAD_ENTRY.iter_unpack(
            data[directory:directory + count * WAD_ENTRY.size]
        )
        if not compression and kind in {0x43, 0x44}
    }


def bsp_materials(path):
    data = memoryview(path.read_bytes())
    version, = unpack_from("<i", data)
    if version != 30:
        raise ValueError(f"Expected a version 30 BSP at {path}")
    start, length = unpack_from("<II", data, 20)
    textures = data[start:start + length]
    count, = unpack_from("<I", textures)
    for offset, in iter_unpack("<i", textures[4:4 + count * 4]):
        if offset >= 0:
            texture = textures[offset:]
            yield name_of(MIP_HEADER.unpack_from(texture)[0]), texture


def material_image(name, texture, max_size):
    _, width, height, base, _, _, smallest = MIP_HEADER.unpack_from(texture)
    palette_start = smallest + max(1, width >> 3) * max(1, height >> 3)
    palette_size, = unpack_from("<H", texture, palette_start)
    palette = bytes(texture[palette_start + 2:palette_start + 2 + 3 * palette_size])
    image = Image.frombytes("P", (width, height), bytes(texture[base:base + width * height]))
    image.putpalette(palette)
    if "{" in name:
        image.info["transparency"] = 255
        image = image.convert("RGBA")
    else:
        image = image.convert("RGB")
    image.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
    return image


def material_uses(path):
    data = path.read_bytes()
    def lump(i):
        start, length = unpack_from("<II", data, 4+8*i)
        return data[start:start+length]
    names = [n for n, _ in bsp_materials(path)]
    axes = [r[8] for r in iter_unpack("<8f2i", lump(6))]
    from collections import Counter
    return Counter(names[axes[f[4]]] for f in iter_unpack("<HHiHH4Bi", lump(7)))


def pack_materials(directory, max_size, quality, adaptive=False):
    """Return compact material data for a project with stock WAD3/BSP inputs."""
    if not 1 <= max_size <= 255 or not 0 <= quality <= 100:
        raise ValueError("Invalid maximum image size or quality")
    assets = Path(directory) / "assets"
    wads = [load_wad(assets / name) for name in ("cs_dust.wad", "base-textures.wad")]
    materials = {}
    for name, descriptor in bsp_materials(assets / "de_dust2.bsp"):
        if name in HIDDEN or name.startswith("sky"):
            continue
        if MIP_HEADER.unpack_from(descriptor)[3]:
            materials[name] = descriptor
        elif name not in materials:
            for wad in wads:
                if name in wad:
                    materials[name] = wad[name]
                    break
            else:
                raise ValueError(f"Missing mip texture {name}")
    uses = material_uses(assets / "de_dust2.bsp") if adaptive else {}
    images=[]
    for name, texture in materials.items():
        if adaptive and not uses[name]:
            continue
        dimension=max_size
        if adaptive:
            dimension = max_size if uses[name]>=70 or name in {"sandwlldoor","sandwllwndw"} else (56 if uses[name]>=8 else 32)
        images.append((name, material_image(name, texture, dimension)))
    columns = 6
    sheet = Image.new("RGB", (columns * max_size, ((len(images) + columns - 1) // columns) * max_size))
    records = []
    for i, (name, image) in enumerate(images):
        x, y = (i % columns) * max_size, (i // columns) * max_size
        sheet.paste(image, (x, y))
        records.append(RECORD.pack(name.encode("ascii"), x, y, *image.size))
    encoded = BytesIO()
    sheet.save(encoded, format="AVIF", quality=quality, speed=3, max_threads=1)
    return HEADER.pack(b"TMT2", len(images)) + b"".join(records) + encoded.getvalue()
