"""Build the standalone fullscreen-ray game archive."""

import argparse
from pathlib import Path
from tempfile import NamedTemporaryFile
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


ROOT = Path(__file__).resolve().parents[1]
FOLDER = "dust2-game"
FILES = (
    "app.js",
    "bsp.js",
    "challenge.js",
    "gamma.js",
    "gl-resources.js",
    "index.html",
    "mesh.js",
    "movement.js",
    "ray-materials.js",
    "ray-renderer.js",
    "ray-tree.js",
    "serve.py",
    "style.css",
    "touch.css",
    "touch.js",
    "assets/de_dust2.bsp",
    "assets/cs_dust.wad",
    "assets/base-textures.wad",
    "assets/ak-front.avif",
    "assets/bk.png",
    "assets/dn.png",
    "assets/ft.png",
    "assets/lf.png",
    "assets/rt.png",
    "assets/up.png",
    "shaders/fullscreen.vert.glsl",
    "shaders/scene-ray.frag.glsl",
)
README = """# Dust II · Counter-Strike 1.5

Open a terminal in this folder and run:

```sh
python3 serve.py
```

Open http://127.0.0.1:8155/ in a WebGL 2 browser. Select a team spawn, then
choose free exploration or a timed run from A site to B site.

Move with WASD, look with the mouse, jump with Space, crouch with C or Ctrl,
reset with R, and open the menu with Esc. On touch screens, drag on the left
to move and on the right to look.

The editable shader sources are in `shaders/`. Reload the page after editing.

Level design by Dave Johnston. Textures by MacMan.
"""


def replace_once(source, old, new):
    head, found, tail = source.partition(old)
    if not found or old in tail:
        raise ValueError(f"Expected one occurrence of {old!r} in the game source")
    return head + new + tail


def pack_file(name):
    path = ROOT / ("reference.html" if name == "index.html" else name)
    if name == "app.js":
        app = path.read_text(encoding="utf-8")
        app = replace_once(app, 'import { createRenderer } from "./renderer.js";\n', "")
        app = replace_once(
            app,
            """  const factory =
    new URLSearchParams(location.search).get("renderer") === "raster"
      ? createRenderer
      : createRayRenderer;
  renderer = await factory(""",
            "  renderer = await createRayRenderer(",
        )
        app = replace_once(
            app,
            """  if (factory === createRenderer) {
    el("pipeline-name").textContent = "RASTER REFERENCE / WEBGL 2";
    el("shader-link").href = "shaders/bsp.frag.glsl";
  }
""",
            "",
        )
        app = app.replace('["cs_dust", "base-textures", "decals"]', '["cs_dust", "base-textures"]')
        if '["cs_dust", "base-textures"]' not in app:
            raise ValueError("Expected the Dust and base textures in the game source")
        return app.encode("utf-8")
    if name == "index.html":
        html = path.read_text(encoding="utf-8")
        html = replace_once(html, '<a href="qa/" target="_blank">Map comparisons ↗</a>', "")
        return html.encode("utf-8")
    return path.read_bytes()


def write_archive(output):
    files = {name: pack_file(name) for name in FILES}
    files["README.md"] = README.encode("utf-8")
    with NamedTemporaryFile(dir=output.parent, delete=False) as temp:
        path = Path(temp.name)
    try:
        with ZipFile(path, "w") as archive:
            for name, data in sorted(files.items()):
                entry = ZipInfo(f"{FOLDER}/{name}", date_time=(1980, 1, 1, 0, 0, 0))
                entry.create_system = 3
                entry.external_attr = 0o100644 << 16
                archive.writestr(entry, data, compress_type=ZIP_DEFLATED, compresslevel=9)
        path.chmod(0o644)
        path.replace(output)
    finally:
        path.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", nargs="?", type=Path, default=ROOT / f"{FOLDER}.zip")
    args = parser.parse_args()
    write_archive(args.output)
    print(f"{args.output} ({args.output.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
