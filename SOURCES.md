# Counter-Strike 1.5 and Dust II sources

## Release identification

- Valve released the Counter-Strike 1.5 Half-Life mod on June 12, 2002, alongside the Half-Life 1.1.1.0 update. The same announcement identifies the separate update for owners of the standalone Counter-Strike retail edition as 1.0.0.5. [Shacknews release notice](https://www.shacknews.com/article/20930/half-lifecounter-strike-updates)
- The August 2002 GameStar demo disc directory lists `Cs\CsV15full.exe` as the full Counter-Strike 1.5 mod installer. [GameStar disc directory, page 123](https://download.gamestar.de/public/31200/31269/08_2002_cddvd.pdf)
- Two surviving mirrors label the full Windows mod installer `csv15full.exe` and report MD5 `eedcfcf6545cef92f26fb9a7fdd77c42`. ModDB reports 127,194,009 bytes, which matches an October 2002 directory listing. [ModDB](https://www.moddb.com/downloads/counter-strike-15) · [Repeat Offender](https://files.repeatoffender.net/details.php?file=20) · [October 2002 mailing list archive](https://groups.google.com/g/fido7.ru.unix.bsd/c/eaeJj8ALt5Q)

## Source file verification

The files from the `cs15_retail` preservation branch at commit `f5837cb509ef09f9352ec8960258893a4c8bf2df` were compared against the full Windows mod installer from the HL.la10cy mirror. The installer measured 127,194,009 bytes and its MD5 matched the published value above. Its measured SHA-256 is `2963e480b02e5e29b2577d897ce99355d863d7db580b5d670e070baa2be3a0e5`. REWise 0.4.0 extracted the original files without starting the installer. [Preservation branch](https://github.com/Ch0wW/counterstrike-betas/tree/f5837cb509ef09f9352ec8960258893a4c8bf2df) · [Installer mirror](https://hl.la10cy.net/downloads/client/won/) · [REWise source](https://codeberg.org/CYBERDEV/REWise)

The following project files match the installer byte for byte.

| File | SHA-256 |
| --- | --- |
| `assets/de_dust2.bsp` | `15945389528d113562ede0a2c80647ebfa799079ed1c05a25379bcf84e4e9286` |
| `assets/cs_dust.wad` | `f6f5b83318d5445a0c44b1c783dfcb04dba568e5670c9271cf1f93071787fa19` |
| `assets/decals.wad` | `c9e852b60197177f1e6f54992c3f0e886425ab6e6cafe9f1b1e5e6b3bf80850c` |
| `assets/Desbk.tga` | `fc59b40b15ca79ee2c8896fe105f56a5e417f1701535a286b862547470e28b70` |
| `assets/Desdn.tga` | `7c8b2a82350af60257003114899f81859d3929cdff48eea6cbf10e1c77fe9ff4` |
| `assets/Desft.tga` | `b88bb20225f781f41a5d65e6e984e658390a7e5a8754db74372479638f94e003` |
| `assets/Deslf.tga` | `e162c7371d74a94d8b9ae01381861e5f4677fa0d31d0eda4c331d928b5943cc7` |
| `assets/Desrt.tga` | `a97fec049ec866a5281015f7711cb114b9c7fb7012dae89978a6c7d449b00ab5` |
| `assets/Desup.tga` | `f726e6882bdb6a768e83036646169f738eed69ae05b35954300ef05278733f22` |
| `qa/overview.bmp` | `9ec191f1c124e928f5aff77fc080dbafcb90146b25463d8d04d8da13d64fbf0a` |

The map description `assets/de_dust2.txt` and radar configuration `qa/overview.txt` match after converting CRLF line endings to LF. The PNG conversions of the six sky faces and radar bitmap preserve all RGB pixel values. The sky PNGs are opaque so WebGL can use the RGB data in the TGA files, which have a zero alpha channel.

The mod relies on a base Half-Life `halflife.wad`. `assets/base-textures.wad` contains the eight mip textures referenced by the BSP from that WAD. All eight lump bodies match the copy distributed by HLDM.cz byte for byte. The full mirror WAD has measured SHA-256 `38ababf773463fdf6133005d13e543098fc42392b458057f239469b764691300`. The subset has SHA-256 `66654e48b8d80f4ee05b2b5ba70a76038d2f93c479b4dbb08c5e50014100ae15`. [HLDM.cz file listing](https://valve.hldm.cz/?dir=.%2F)

## Map history and footage

- Map designer Dave Johnston dates the first Dust II release to Counter-Strike 1.1 in March 2001 and reports that its layout received no further tweaks during the original Counter-Strike releases. The overview in his article is explicitly from CS 1.6. The article also distinguishes prerelease screenshots and later engine versions. [Dave Johnston’s Dust II development history](https://www.johnsto.co.uk/design/making-dust2/)
- A gameplay recording labeled Counter-Strike 1.5 reaches `de_dust2` at 24:50. The recording is a later capture and its version identification comes from the uploader. [Counter-Strike 1.5 gameplay at 24:50](https://www.youtube.com/watch?v=zlel15ov8iM&t=1490s)
- A contemporary July 2002 demo entry independently documents `de_dust2` in CS 1.5. The archive has retained the listing and comments. [ESReality demo listing](https://esreality.com/post/198265/zex-drax-vs-pub/)
- Noclip’s documentary interviews Johnston and begins its Dust II chapter at 22:00. It provides context on the map’s development and shows several generations of Counter-Strike. [Noclip documentary at 22:00](https://www.youtube.com/watch?v=FWWhxfGq_yk&t=1320s)

## Shared BSP revision

The verified 1.5 BSP also matches the preserved 1.1, 1.3 and 1.4 files and Counter-Strike Steam depot 11 manifests `4720911300072406946` (2020 legacy build) and `3018093494972814332` (2023 build). All measured files have the same 2,057,288 bytes and SHA-256. The original installer establishes the 1.5 provenance. The map hash alone cannot distinguish these releases. Condition Zero, Source, Global Offensive and CS2 assets did not supply the map or materials for this project. [CS 1.1](https://github.com/Ch0wW/counterstrike-betas/tree/e988f2945a12804164bca5f6286c9223a3258b96) · [CS 1.3](https://github.com/Ch0wW/counterstrike-betas/tree/f192da8871a29c8717b4ee1cc093d6ee644a0288) · [CS 1.4](https://github.com/Ch0wW/counterstrike-betas/tree/d6de3ef75abc83d25358c6857ad80759564672da) · [Steam depot](https://steamdb.info/depot/11/)

## First-person rifle artwork

The tiny edition samples a transparent view of the original Counter-Strike 1.5 rifle fore-end. The source is `cstrike/models/v_ak47.mdl` from the verified installer above. Run `python3 tools/render_ak_front.py /path/to/v_ak47.mdl` with NumPy and AVIF-enabled Pillow to regenerate the artwork from the model’s textured triangles. It uses the original forearm.bmp and barrel.bmp materials.
