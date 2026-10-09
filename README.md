# Honeycomb-Surfels: Compact Hexagonal Primitives for Efficient Scene Rendering and Reconstruction

Source of the project page <https://honeycomb-surfels.github.io/> for the paper by Prakhar Kaushik\*, Soumava Paul\*
and Alan Yuille (Johns Hopkins University; \* equal contribution).

Hexels (Honeycomb-Surfels) are planar hexagonal surface elements that carry a first-order (linear) color field, so
fewer, larger primitives can represent locally planar regions with smoothly varying appearance. The site is a static
page in the style of Nerfies: plain HTML, CSS and JavaScript modules, with no build step.

## Pages

- `index.html`, the project page: demo videos, the abstract, the method, a primitive visualization, a novel-view
  comparison player and scene gallery, the quantitative results, the Hexels variants, depth and normal renders,
  surface reconstruction, 2D image representation and the BibTeX entry.
- `theory.html`, "Why Hexels? The theory, animated": eight short animations, each beside its explanation and math.
- `viewer.html`, "Explore Hexels in 3D": a WebGL2 viewer (`viewer/`) that renders trained Hexels live on the
  visitor's own GPU, and opens Hexels models from disk without uploading them.

The pages read their data from `static/data/` and load videos, meshes and viewer models from the media host set in
`static/js/config.js`. `stats/` holds the optional visitor counter of the page footer (see `stats/README.md`).

## Preview locally

Serve the repository root over HTTP, since browsers refuse to load JavaScript modules and JSON from pages opened
from disk:

```bash
python -m http.server 8000
```

Then open <http://localhost:8000/>. Python's server ignores HTTP byte-range requests, so videos cannot seek and the
comparison player's paused frames fall back to the first frame; any static file server that answers byte ranges
avoids that. On `localhost` the pages look for media in local folders (`MEDIA_BASE_URL_LOCAL` in
`static/js/config.js` and `local_mirror` in `static/data/viewer_scenes.json`); add `?media=<media host URL>` to the
address to preview with hosted media instead.

## License

The code in this repository is released under the [MIT License](LICENSE). The page design follows the
[Nerfies project page template](https://github.com/nerfies/nerfies.github.io) and, as the page footer states, is
licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
