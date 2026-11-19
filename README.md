# Dust II shader game

[Play Dust II](https://gokayfem.github.io/dust2-shader/). The 99,476-byte standalone game opens directly at T spawn. WASD moves, Space jumps, C crouches, click or F fires, and Esc opens the menu.

## Rebuild the published game

The compact build uses the original map and collision data, downsized original textures, and a two-pass GLSL renderer. The build embeds the game and its assets in the root `index.html`. The GLSL lives in `shaders/`, the compact runtime in `tiny/`, and the packaging code in `tools/`.

From the repository root, with Python 3, Pillow 11.3.0 with AVIF support and esbuild 0.25.12 on PATH, run

```sh
python3 tools/build_tiny.py --matched compact --material-size 96 --material-quality 26 --output index.html
python3 serve.py
```

Open [the local game](http://127.0.0.1:8155/). The build also writes an offline ZIP. Map and artwork credits are in [SOURCES.md](SOURCES.md).
