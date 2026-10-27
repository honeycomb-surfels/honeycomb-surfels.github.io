# Storyboard and research sources

The [storyboard](index.html) contains eleven scenes used by the release video.
[contact-sheet.png](contact-sheet.png) shows the sequence; `stills/` contains individual 1080-square PNGs.
The first scene also has a [bee-only opening keyframe](index.html?card=01&beat=bees).
Edit copy and scene images in `cards.js`, layout in `cards.css`, and animation timing in `../film.js`.
The parent [README](../README.md) documents setup and export.

## Scene sources

| Scene | Content and source |
| --- | --- |
| 01 | Two bees on white for 1.45 seconds, then the Honeycomb-Surfels title. Original website logo; touched cells glint and bob. |
| 02 | A general primitive for efficient 2D and 3D representation. A conceptual device and a brief right-side primitive-efficiency callout. |
| 03 | Whole-scene 2DGS/Hexels comparison from `static/images/teaser_web.webp`. 82% less peak training VRAM at matched model memory for this Kitchen example. |
| 04 | Native Hexels V2 throughput from paper Table 3, with a Kitchen camera clip and three dataset means versus Triangle Splatting. |
| 05 | Up to 86% less training VRAM, 49% less FP32 deployment memory and 2.3× rendering FPS: matched primitive-count V2, paper Table 2. |
| 06 | Complete Garden camera clip and matched-FP32-model-memory PSNR graph. Paper Table 1 and the website's unrounded PSNR data. |
| 07 | Full Image-GS, Hexels and reference images with RGB MAE maps and shared scale from `figures/image_comparison_2d.pdf`. Image fitting with 10K primitives for a 2048 × 2048 image. |
| 08 | Hexel anatomy and surface-tiling animations from `static/anim/`; finite hexagonal support and a local spatial color field. |
| 09 | Scan 65 geometry, normals and depth from the website's surface viewer. Mean surface-reconstruction result across 15 DTU scans. |
| 10 | Reference, native boundaries and colored cells from `figures/skull_toy_combined.pdf`; paper Applications section and surface-cell appendix. |
| 11 | “Train it. Render it. On the edge.” The direction toward privacy-preserving, high-quality 2D/3D representation on local everyday devices. |

## Comparison settings

The stored [claims.json](claims.json) retains the measurements, source-table hashes and calculations.
Paths under `tables/` refer to the paper repository; paths under `static/` refer to this website.
Training VRAM, deployment storage and renderer model memory are distinct quantities.

- **Scene 03:** `static/data/nvs_metrics_memory.json`, `mipnerf360/kitchen`: 0.884765625 vs
  4.876953125 GiB peak training VRAM gives 82% less, rounded. Renderer-read models are both
  19.30936 MB. This comparison supports equal model memory, rather than a model-memory reduction.
- **Scene 04:** native dataset-mean FPS for Hexels V2 / Triangle Splatting is 386.9 / 121.4
  on Tanks and Temples, 375.0 / 85.8 on Mip-NeRF 360, and 845.6 / 278.7 on DTU.
  “Up to 846 FPS” rounds the DTU mean; it is not the Kitchen scene's FPS.
  Hexels uses RTX A5000; Triangle uses RTX 6000 Ada on the first two datasets and A5000 on DTU.
  Native configurations have different quality and hardware. The caption lists both GPUs for the comparison.
- **Scene 05:** the maxima of three matched-count V2 dataset means are 85.63% less peak training
  VRAM, 48.71% less uncompressed FP32 deployment storage and 2.318× FPS relative to 2DGS.
  All three datasets have higher PSNR/SSIM and lower LPIPS. The maxima need not occur together.
- **Scene 06:** matched-memory PSNR gains over 2DGS are 4.53 / 6.99 / 7.38 dB across Tanks and
  Temples / Mip-NeRF 360 / DTU. The graph uses unrounded website inputs checked against the paper's
  rounded Table 1 cells. It is a dataset comparison, not a fitted Pareto curve.
- **Scene 09:** `static/data/surface_vis.json` gives mean Chamfer distances of 0.9784742701 vs
  1.3752799435 mm: 28.9% lower error across 15 DTU scans relative to memory-matched 2DGS.
  The percentage is a dataset mean, not the illustrated Scan 65 score.

Scene 02's “No hacks. No quantization needed. Pure efficiency at the primitive level” refers to the
main fixed-population, uncompressed FP32 results. Optional compression/quantization is studied separately.

Direct surface-cell extraction maps six canonical boundary vertices into world space with differentiable
geometry and color attached to the parent Hexel. “Constant-time” describes work per retained Hexel;
exporting N cells takes O(N). These cells are separate from the fused-mesh evaluation in scene 09.
Generation, segmentation and representation learning are potential downstream applications.

The device imagery and “THE DIRECTION” ending express future local training/rendering.
Phone training and phone FPS have not been measured; the imagery contains no measured phone result or app UI.

## Updating measurements

The stored figures and data are sufficient to edit and render the video without the paper checkout.
To regenerate the measurement snapshot and benchmark graph, install Matplotlib and supply the paper repository:

```bash
python3 -m pip install matplotlib
python3 release-video/flashcards/build_evidence.py --paper-root ../hexel_arxiv
```

Run from the website repository root, or pass another path to the paper checkout.
The script reads the paper's tables, checks the comparison settings and writes only `claims.json` and
`assets/benchmark.svg` in this directory. Source-paper paths in the output remain relative to its root.
