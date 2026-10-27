# Honeycomb-Surfels release video

`release.mp4` is the current 43-second, silent, 1080 × 1080 video at 30 fps.
`release-cover.png` is its cover. The animation and storyboard are editable HTML/CSS/JavaScript;
no video editor project or paid software is required.

## Preview

From the repository root, install Node.js 20 or later, Python 3 and FFmpeg, then run:

```bash
cd release-video
npm ci
npx playwright install chromium
npm run assets
cd ..
python3 -m http.server 8000
```

Keep the server running and open:

- [Finished video](http://localhost:8000/release-video/watch.html)
- [Editable animation](http://localhost:8000/release-video/film.html), with play and scrub controls
- [Storyboard](http://localhost:8000/release-video/flashcards/), with individual scenes and source notes

Serve the repository root: the video reuses the website's logo, theory animations and research figures.
`npm run assets` downloads the Kitchen and Garden clips and the Scan 65 mesh from the project's media host.
These cached files and `node_modules` are ignored by Git. The mesh preview also loads Three.js and its
Draco decoder from jsDelivr, so previewing and rendering require internet access.
The finished MP4 can be played independently.

## Edit

| File | Purpose |
| --- | --- |
| `flashcards/cards.js` | Scene copy, images, motion notes and research sources |
| `flashcards/cards.css` | Typography, colors and scene layouts on a 1080-square canvas |
| `film.js` | Scene order, start/end times, bee motion, fades and camera-clip timing |
| `film.css` | Layout rules specific to the animated video |
| `surface-stage.js` | Scan 65 mesh, camera and lighting |
| `flashcards/claims.json` | Research measurements used by the storyboard and FPS table |
| `flashcards/assets/` | Images and chart included with the editable source |
| `prepare-assets.mjs` | Download URLs for cached video/mesh sources |

Start with `flashcards/cards.js` for text changes. Open `film.html` to check the animated result.
When changing timing, update the `shots` array and `duration` in `film.js`, and the scrub control's
maximum and initial time display in `film.html`. `window.videoConfig` sets the output name and cover time.
The supplied render uses `release.mp4` and `release-cover.png` as stable output names.

## Export

With the preview server running, use a second terminal at the repository root:

```bash
npm --prefix release-video run render
```

The renderer captures the animation frame by frame, then encodes H.264/yuv420p with fast-start metadata.
It overwrites the current MP4 and cover and removes temporary frame files when finished.
For a different local server, set `PREVIEW_ORIGIN`. To use an installed Chrome instead of Playwright's
Chromium, set `CHROME_EXECUTABLE` to its executable path.

To refresh the storyboard PNGs and `flashcards/contact-sheet.png`:

```bash
npm --prefix release-video run flashcards
```

This exports still images only. It does not modify the MP4.

## Sequence

| Time | Scene |
| --- | --- |
| 0–1.45 s | Two bees on white |
| 1.45–4.8 s | Honeycomb contact/glints, title and full paper subtitle |
| 4.8–8.6 s | General 2D/3D primitive, edge-device direction and primitive-efficiency callout |
| 8.6–12.3 s | Matched-memory quality comparison and 82% less training VRAM |
| 12.3–16.1 s | Native throughput, up to 846 FPS, three-dataset Triangle comparison |
| 16.1–20.2 s | Matched-count V2: VRAM, FP32 deployment memory and rendering FPS |
| 20.2–24 s | Garden novel-view synthesis and matched-memory PSNR graph |
| 24–27.6 s | Image-GS, Hexels and reference images with RGB error maps |
| 27.6–31.2 s | Hexel anatomy, local color field and curved-surface tiling |
| 31.2–34.8 s | Scan 65 geometry, normals/depth and DTU reconstruction result |
| 34.8–38.9 s | Direct surface-cell extraction |
| 38.9–43 s | Training/rendering on the edge: direction and project URL |

See [research/source notes](flashcards/cards.md) for metric definitions, comparison settings and figure origins.
