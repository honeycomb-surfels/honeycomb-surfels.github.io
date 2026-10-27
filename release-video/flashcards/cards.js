/** Static storyboard cards with explicit evidence and an optional, isolated logo-contact preview. */
const params = new URLSearchParams(location.search);
const selectedId = params.get("card");
if (selectedId) document.body.classList.add("single");
if (params.has("export")) document.body.classList.add("export");
const image = (src, alt) => `<img src="${src}" alt="${alt}">`;
const crop = (src, alt, box, width, height) => `<div class="frame crop" style="height:${height}px" data-box="${box.join(",")}" data-width="${width}">${image(src, alt)}</div>`;
const logo = (hero = false) => `<div class="logo-slot ${hero ? "hero-logo" : "mini-logo"}" aria-hidden="true"></div>`;
const footer = `<div class="footer">honeycomb-surfels.github.io<span>Hexels</span></div>`;
const head = (id) => `<div class="topline"><div class="small-brand">${logo()}Honeycomb-Surfels</div><span class="card-no">${id} / 11</span></div>`;
const figs = "../../static/images/";
const title = (first, second = "") => `<h2>${first}${second ? `<br><span class="accent">${second}</span>` : ""}</h2>`;
const cards = [
  {
    id:"02", kind:"hook", name:"A general primitive, then learning and viewing 3D scenes on the edge",
    content:`<p class="kicker">HEXELS</p><h2 class="general-statement">A general primitive for efficient<br>2D and 3D representation.</h2><div class="edge-sentence"><span class="edge-lead">Towards efficient learning and viewing</span><strong class="edge-scene">3D scenes</strong><span class="edge-location">on the edge.</span></div><aside class="primitive-callout"><p>No hacks.<br>No quantization<br>needed.</p><p>Pure efficiency at<br>the primitive level.</p></aside><div class="phone">${image("assets/native-ours.jpg", "A rendered 3D scene inside an illustrative phone outline")}</div><p class="hook-benefits">Sharper detail. Less memory. Less training VRAM.</p>`,
    motion:"Follow the identity reveal with the general-primitive sentence. Resolve into a sentence about learning and viewing: 3D scenes is largest, on the edge is a smaller emphasis. The right-hand primitive-efficiency callout fades in, holds, then fades out. Retain a conceptual device image, without a fabricated training UI.",
    evidence:"Edge deployment is a direction in the paper. There are no phone-training measurements. The three benefits are established in different controlled comparisons, detailed in cards 03–06. The primitive-efficiency callout refers to the main fixed-population, uncompressed FP32 experiments, not the separate optional compression/quantization study.",
  },
  {
    id:"01", kind:"identity", name:"Bees on white, then the Honeycomb-Surfels identity",
    content:`${logo(true)}${title("Honeycomb-Surfels")}<p class="dek">Compact Hexagonal Primitives for<br>Efficient Scene Rendering and Reconstruction</p><div class="intro-hexels">Introducing Hexels.</div>`,
    motion:"Begin with the linked bee-only white frame for 1.45 seconds, before any title or footer. The bees then touch the honeycomb; its cells glint and bob as on the website, followed by this title reveal. This is the first numbered scene.",
    evidence:"Brand and logo reuse the project website. The optional “Preview bee contact” button auditions only this detail; it does not play a video or advance the cards.",
  },
  {
    id:"03", kind:"quality", name:"Whole-scene detail and the scene's actual VRAM saving",
    content:`<p class="kicker">COMPACT 3D</p>${title("Sharper detail.", "Smaller training footprint.")}<div class="pair"><div>${crop(figs+"teaser_web.webp","2DGS full toy reconstruction",[9,66,542,441],457,336)}<p class="label">2DGS</p></div><div>${crop(figs+"teaser_web.webp","Hexels full toy reconstruction",[565,66,542,441],457,336)}<p class="label ours">Hexels (ours)</p></div></div><div class="stats"><div class="metric accent">82%<small>less peak training VRAM</small></div></div><p class="source">This scene · matched model memory · vs 2DGS</p>`,
    motion:"Hold both full toy views at the same scale. No wheel zoom. Bring the 82% proof in after the scene is readable; keep the final comparison still for a short beat. The wider up-to claim belongs to card 05, with its own benchmark scope.",
    evidence:"Website scene metrics: 0.884765625 vs 4.876953125 GiB peak training VRAM, equal model memory of 19.30936 MB. The image is the existing matched-memory teaser.",
  },
  {
    id:"04", kind:"speed", name:"Higher rendering throughput across three native datasets",
    content:`<p class="kicker">NATIVE RENDERING BENCHMARKS</p>${title("High rendering throughput.")}<div class="fps-hero"><div><span class="up-to">UP TO</span><strong><span id="peak-fps">846</span> FPS</strong></div><p>DTU mean<br>Hexels V2</p></div><div class="speed-scene">${image("assets/native-ours.jpg","Native Kitchen render as a 3D scene example")}</div><p class="scene-caption">Native Kitchen</p><div id="native-fps-table" class="native-fps-table"></div><p class="source">Native configurations · dataset-mean FPS<br>GPU benchmarks: RTX A5000 / RTX 6000 Ada</p>`,
    motion:"Use a moderate, smoothly rotating Kitchen example. Lead with the higher DTU dataset-mean FPS, then show Hexels V2 and Triangle Splatting's measured native results across all three datasets. No playback-explanation sentence on the frame.",
    evidence:"Current paper Table 3: Hexels V2 vs Triangle Splatting is 386.9 vs 121.4 FPS on Tanks and Temples, 375.0 vs 85.8 on Mip-NeRF 360, and 845.6 vs 278.7 on DTU. Hexels uses RTX A5000; Triangle's first two datasets use RTX 6000 Ada. These native configurations differ in quality; this is a measured throughput comparison, not an equal-quality/hardware-matched speedup. The Kitchen picture is an example, not an 846-FPS Kitchen measurement.",
  },
  {
    id:"05", kind:"limits", name:"One consistent set of up-to benchmark claims",
    content:`<p class="kicker">EFFICIENCY AT MATCHED PRIMITIVE COUNTS</p>${title("A smaller budget.", "Better measured quality.")}<div class="limit-list"><div class="limit-row"><div class="limit-number"><small>UP TO</small>86%</div><div class="limit-copy">less peak<br>training VRAM</div></div><div class="limit-row"><div class="limit-number"><small>UP TO</small>49%</div><div class="limit-copy">less FP32<br>deployment memory</div></div><div class="limit-row"><div class="limit-number"><small>UP TO</small>2.3×</div><div class="limit-copy">rendering FPS<br>with higher PSNR / SSIM<br>and lower LPIPS</div></div></div><p class="source">Hexels V2 vs 2DGS · maxima of three dataset means<br>34 scenes · matched primitive counts · uncompressed FP32</p>`,
    motion:"Reveal one number at a time, giving each a brief hold. This is a claim-selection card: it may be split across earlier scenes in the eventual cut, while retaining the matched-count V2 qualifier.",
    evidence:"Current paper Table 2: Mip-NeRF 360 gives 85.63% VRAM and 48.71% deployment-size reductions. DTU gives 2.318× FPS. Values are rounded; maxima come from different dataset means. All three quality metrics improve on all three datasets.",
  },
  {
    id:"06", kind:"benchmark", name:"One-line NVS title, real scene plus quantitative context",
    content:`${title("Efficient novel-view synthesis.")}<div class="garden">${image("assets/garden.jpg","Complete, centered Garden novel-view synthesis frame")}</div>${image("assets/benchmark.svg","Dataset-mean PSNR at matched model memory, Hexels compared with 2DGS").replace("<img ",'<img class="chart" ')}<p class="source">Matched FP32 model memory · 34 scenes · plot: Hexels vs 2DGS</p>`,
    motion:"Use a slow Garden camera move above the graph. Add the matched-memory dots and their gains together. Keep the heading on one line; replace “move the camera, keep the scene” with the actual budget/quality evidence.",
    evidence:"Paper Table 1: best mean PSNR among all compared methods on each of the three datasets. The plot shows the 2DGS pair: gains of 4.53 / 6.99 / 7.38 dB. Unrounded website PSNR values agree with the paper's rounded cells; the 6.99 gain is also stated in the paper text. This is not the matched-primitive-count experiment.",
  },
  {
    id:"07", kind:"image2d", name:"General primitive; full 2D reconstruction and ground truth",
    content:`<p class="kicker">A GENERAL PRIMITIVE</p>${title("2D images.", "3D scenes. One primitive.")}<p class="source image-context">Image fitting · 10K primitives · 2048 × 2048 image</p><div class="image-grid"><div><div class="frame">${image("assets/2d-image-gs.jpeg","Full Image-GS reconstruction")}</div><p class="label">Image-GS</p></div><div><div class="frame">${image("assets/2d-hexels.jpeg","Full Hexels reconstruction")}</div><p class="label">Hexels</p></div><div><div class="frame">${image("assets/2d-ground-truth.jpeg","Full ground-truth image")}</div><p class="label">Ground truth</p></div></div><div class="error-grid"><div><p class="error-label">RGB error</p>${image("assets/2d-image-gs-error.jpeg","Image-GS RGB error against ground truth")}</div><div><p class="error-label">RGB error</p>${image("assets/2d-hexels-error.jpeg","Hexels RGB error against ground truth")}</div><div class="error-legend"><p>RGB MAE ↓</p>${image("assets/2d-error-scale.png","RGB error scale from zero to 0.10 or greater")}<div class="error-ticks"><span>0</span><span>0.05</span><span>0.10+</span></div><p>Lower is better.</p></div></div>`,
    motion:"Show the entire Image-GS reconstruction, Hexels reconstruction and reference at the same scale, with their actual RGB error maps beneath. Hold this comparison once. Keep the 10K/2048 context quiet, without treating it as the headline.",
    evidence:"Actual full-image panels, RGB MAE maps and shared color scale extracted from the paper's image_comparison_2d.pdf. The source describes 2048×2048 inputs with 10K final primitives. Its embedded panels are 640-square; no generated detail or fabricated error maps are used.",
  },
  {
    id:"08", kind:"primitive", name:"Explain why the primitive helps",
    content:`<p class="kicker">EFFICIENCY BY DESIGN</p>${title("Use the structure", "already in the world.")}<div class="anatomy-crop">${crop("assets/hexel-anatomy.png","A Hexel's planar support and spatial color field",[140,185,590,540],520,475)}</div><div class="primitive-points"><p><strong>Finite</strong><br>hexagonal support</p><p><strong>Color varies</strong><br>within each primitive</p><p><strong>Fewer, larger</strong><br>primitives</p></div><p class="dek">Hexagonal support. A local color field.</p><p class="source">Locally planar regions with smoothly varying appearance.</p>`,
    motion:"Show one Hexel, its local color variation, then its place on the curved surface. Let the boundaries and gradient carry the idea. Keep the theory animation short and visually led; this is the mechanism behind efficiency.",
    evidence:"Paper Section 3 and the existing anatomy/surface animations. V1 has 20 learned scalars per Hexel vs 58 for the evaluated 2DGS primitive; this does not mean all variants have the same parameter count.",
  },
  {
    id:"09", kind:"geometry", name:"Reconstruction produces geometry for 3D tasks",
    content:`<p class="kicker">3D SURFACE RECONSTRUCTION</p>${title("Geometry for", "downstream 3D.")}<div class="geo-grid"><div>${image(figs+"geometry/dtu_scan65_0032_rgb.webp","Reconstructed skull appearance")}<p>Appearance</p></div><div>${image(figs+"geometry/dtu_scan65_0032_normal.webp","Reconstructed surface normals")}<p>Normals</p></div><div>${image(figs+"geometry/dtu_scan65_0032_depth.webp","Reconstructed depth")}<p>Depth</p></div></div><div class="geo-proof">28.9% lower surface error</div><p class="source">Vs memory-matched 2DGS · mean Chamfer distance<br>15 DTU scans · example shown: Scan 65</p>`,
    motion:"Resolve appearance into normals and depth, keeping the scene and framing stable. Hold the geometry outputs long enough to read them. The percentage is the dataset mean, not this individual view's score.",
    evidence:"Existing geometry-view assets and surface_vis.json. This fused-mesh evaluation is separate from direct surface-cell decoding on the next card.",
  },
  {
    id:"10", kind:"cells", name:"Direct surface-cell extraction and its application path",
    content:`<p class="kicker">NATIVE HEXEL SURFACE CELLS</p>${title("Constant-time differentiable", "surface extraction.")}<p class="dek">No depth fusion or voxel grids.</p><div class="cell-grid"><div>${crop("assets/surface-cells.png","Reference skull image from the paper",[5,61,589,660],301,335)}<p class="label">Reference</p></div><div>${crop("assets/surface-cells.png","Native exported Hexel edges",[605,61,589,660],301,335)}<p class="label">Cell boundaries</p></div><div>${crop("assets/surface-cells.png","Directly exported colored Hexel surface cells",[1206,61,589,660],301,335)}<p class="label">Colored cells</p></div></div><div class="cell-explanation">Each cell keeps geometry, color and its parent Hexel.</div><p class="source">Potential uses: 3D generation, segmentation<br>and representation learning.</p>`,
    motion:"Move from the reference to wireframe to colored cells. Highlight one cell's six vertices, then its associated color. The cells are explicit surface polygons, not a voxel grid or a claim of constant-time extraction of an entire scene.",
    evidence:"Actual paper figure skull_toy_combined.pdf; Section Applications and Appendix surface_cell_export. Six canonical d=0 vertices map analytically into world space; differentiable geometry and color stay attached to their parent. The listed downstream tasks are future applications in the paper, not benchmarked demos.",
  },
  {
    id:"11", kind:"closing", name:"Return to the edge-device vision: learning and rendering",
    content:`<p class="kicker">THE DIRECTION</p>${title("Train it. Render it.", "On the edge.")}<p class="dek">Towards privacy-preserving, high-quality<br>2D and 3D representation<br>on local everyday devices.</p><div class="device-pair"><div class="phone">${image("assets/2d-hexels.jpeg","2D representation shown in a conceptual device frame")}</div><div class="phone">${image("assets/native-ours.jpg","3D representation shown in a conceptual device frame")}</div></div><div class="cta">Explore Hexels.</div>`,
    motion:"Bring 2D and 3D into the same restrained device motif used in the opening. Reprise the bee-contact glint, settle the logo and hold the URL. End on learning plus rendering, rather than an inference-only message.",
    evidence:"Forward direction supported by the paper's resource-constrained reconstruction discussion. Phone training has not been measured. Avoid fake app interfaces, measured phone FPS, privacy guarantees or a release-date promise.",
  },
].sort((a,b)=>a.id.localeCompare(b.id));

const detailFrames = [
  {card:"01",beat:"bees",file:"card-01-opening.png",name:"Opening: bees only on white, before the title",kind:"opening-beat",content:`<div class="logo-slot opening-bee opening-first" aria-hidden="true"></div><div class="logo-slot opening-bee opening-second" aria-hidden="true"></div>`},
];

/** Reframe source figures without changing their scientific pixels. */
function fitCrops() {
  for (const node of document.querySelectorAll("[data-box]")) {
    const [x,y,w,h] = node.dataset.box.split(",").map(Number);
    const img = node.querySelector("img"), scale = Math.min(node.clientWidth/w, node.clientHeight/h);
    Object.assign(img.style, {width:`${img.naturalWidth*scale}px`, height:`${img.naturalHeight*scale}px`, left:`${(node.clientWidth-w*scale)/2-x*scale}px`, top:`${(node.clientHeight-h*scale)/2-y*scale}px`,clipPath:`inset(${y*scale}px ${(img.naturalWidth-x-w)*scale}px ${(img.naturalHeight-y-h)*scale}px ${x*scale}px)`});
  }
}

function inlineLogo(source, slot, index) {
  const svg = source.cloneNode(true), prefix = `flash-${index}-`;
  svg.querySelector("title")?.remove(); svg.removeAttribute("width"); svg.removeAttribute("height");
  for (const node of svg.querySelectorAll("[id]")) node.id = prefix + node.id;
  for (const node of svg.querySelectorAll("[fill],[clip-path]")) for (const attr of ["fill","clip-path"]) {
    const value = node.getAttribute(attr);
    if (value?.startsWith("url(#")) node.setAttribute(attr, value.replace("url(#", `url(#${prefix}`));
  }
  if (slot.classList.contains("opening-bee")) {
    svg.setAttribute("viewBox","-24 -24 48 48");
    svg.querySelector(".hxl-cells").remove(); svg.querySelector(".hxl-lap").remove();
    svg.querySelector(".hxl-bee").setAttribute("transform",slot.classList.contains("opening-first")?"rotate(-8) scale(-1 1)":"rotate(8)");
    slot.append(svg); return;
  }
  const second = svg.querySelector(".hxl-bee").cloneNode(true);
  second.setAttribute("transform","translate(-21 -6) rotate(-10) scale(-0.82 0.82)");
  second.classList.add("second-bee"); svg.append(second);
  for (const cell of svg.querySelectorAll(".hxl-cell")) {
    const glint = cell.cloneNode(false); glint.classList.remove("hxl-cell"); glint.classList.add("cell-glint");
    glint.setAttribute("fill","#fff4cc"); glint.setAttribute("opacity",cell.dataset.cell === "right" ? "0" : "0.55");
    cell.after(glint);
  }
  slot.append(svg);
}

/** Audition a cell-contact beat only; the storyboard itself has no autoplay or scene transitions. */
function previewContact() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  for (const slot of document.querySelectorAll(".hero-logo")) {
    const svg = slot.querySelector("svg"), bee = svg.querySelector(".second-bee");
    bee.animate([{transform:"translate(-21px,-6px) rotate(-10deg) scale(-.82,.82)"},{transform:"translate(-27px,-24px) rotate(-4deg) scale(-.82,.82)"},{transform:"translate(-21px,-6px) rotate(-10deg) scale(-.82,.82)"}],{duration:650,easing:"ease-in-out"});
    const cell = svg.querySelector('[data-cell="left"].hxl-cell'), glint = svg.querySelector('[data-cell="left"].cell-glint');
    const b=cell.getBBox(), x=b.x+b.width/2, y=b.y+b.height/2;
    const frames=[1,1.09,.97,1.01,1].map((scale)=>({transform:`translate(${x}px,${y}px) scale(${scale}) translate(${-x}px,${-y}px)`}));
    cell.animate(frames,{duration:600,easing:"ease-in-out"});
    glint.animate(frames.map((frame,i)=>({...frame,opacity:[.15,.65,.3,.1,.55][i]})),{duration:600,easing:"ease-in-out"});
  }
}

window.ready = (async () => {
  const [response, evidence] = await Promise.all([fetch("../../static/images/logo.svg"),fetch("claims.json").then((r)=>r.json())]);
  if (!Object.values(evidence.matched_memory_best_psnr).every(Boolean)) throw new Error("The matched-memory best-PSNR caption needs review");
  if (!response.ok) throw new Error("Could not load the project logo");
  const source=new DOMParser().parseFromString(await response.text(),"image/svg+xml").documentElement;
  const shown=selectedId ? cards.filter((card)=>card.id===selectedId) : cards;
  if (!shown.length) throw new Error("Unknown card; open index.html to view the storyboard");
  document.getElementById("board").innerHTML=shown.map((card)=>{
    const detail=detailFrames.find((item)=>item.card===card.id&&item.beat===params.get("beat"));
    const content=detail?.kind==="opening-beat" ? detail.content : head(card.id)+(detail?.content??card.content)+footer;
    const links=detailFrames.filter((item)=>item.card===card.id).map((item)=>`<a href="?card=${card.id}&beat=${item.beat}">${item.name}</a>`).join("");
    return `<article class="review" id="card-${card.id}"><a class="card-link" href="?card=${card.id}" aria-label="Open card ${card.id}: ${card.name}"><div class="viewport"><div class="artboard ${card.kind} ${detail?.kind??""}" data-card="${card.id}">${content}</div></div></a><div class="notes"><h3>${card.id}. ${card.name}</h3><p class="detail-links">${links}</p><p class="direction"><strong>Motion:</strong> ${card.motion}</p><p><strong>Basis:</strong> ${card.evidence}</p><p><a href="stills/${detail?.file??`card-${card.id}.png`}">1080-square PNG</a></p></div></article>`;
  }).join("");
  const speedTable=document.getElementById("native-fps-table");
  if (speedTable) {
    const speed=evidence.native_triangle_fps;
    if (!speed.all_datasets_higher_measured_fps) throw new Error("The native Triangle speed comparison needs review");
    const labels={tanks_and_temples:"Tanks & Temples",mipnerf360:"Mip-NeRF 360",dtu:"DTU"};
    const rows=Object.entries(speed.rows);
    speedTable.innerHTML=`<table aria-label="Native dataset-mean rendering frames per second"><thead><tr><th>Dataset</th><th>Hexels V2</th><th>Triangle Splatting</th></tr></thead><tbody>${rows.map(([id,row])=>`<tr><td>${labels[id]}</td><td>${Math.round(row.hexels_v2_fps)}</td><td>${Math.round(row.triangle_fps)}</td></tr>`).join("")}</tbody></table>`;
    document.getElementById("peak-fps").textContent=Math.round(Math.max(...rows.map(([,row])=>row.hexels_v2_fps)));
  }
  [...document.querySelectorAll(".logo-slot")].forEach((slot,i)=>inlineLogo(source,slot,i));
  const resize=()=>document.querySelectorAll(".viewport").forEach((node)=>{node.querySelector(".artboard").style.transform=`scale(${node.clientWidth/1080})`;});
  new ResizeObserver(resize).observe(document.getElementById("board")); resize();
  await Promise.all([...document.images].map((img)=>img.decode())); await document.fonts.ready; fitCrops();
  const m=evidence.website.matched_memory.maxima.all_scenes.training_vram_reduction_pct;
  const c=evidence.website.matched_count_v3.maxima.all_scenes.training_vram_reduction_pct;
  document.getElementById("claim-summary").innerHTML=`<p><strong>Recommended:</strong> card 05 uses the current paper's matched-count V2 dataset means: up to 86% less VRAM, 49% less FP32 deployment size and about 2.3× rendering FPS, with better PSNR/SSIM/LPIPS on all three datasets. These maxima need not occur together.</p><div class="table-wrap"><table><thead><tr><th>Candidate</th><th>Scope</th><th>Use</th></tr></thead><tbody><tr><td>${m.training_vram_reduction_pct.toFixed(2)}% less VRAM</td><td>Website scene audit · Bonsai · matched-memory V1</td><td>Optional scene maximum, not the current paper's dataset mean.</td></tr><tr><td>${c.training_vram_reduction_pct.toFixed(2)}% less VRAM</td><td>Website scene audit · Kitchen · matched-count V3</td><td>Different variant/budget. Do not merge with a lower-memory V2 claim.</td></tr><tr><td>70.95% less renderer memory; 3.56× FPS</td><td>Website native Stump</td><td>Exclude from equal-quality headlines: PSNR is 1.38 dB lower.</td></tr><tr><td>About 97% less FP32 deployment storage</td><td>Paper native Mip-NeRF 360 · fixed V2 vs native 2DGS</td><td>Trade-off: mean PSNR is 1.76 dB lower. Not an equal-quality result.</td></tr></tbody></table></div><p>Model memory, FP32 deployment storage and peak training VRAM are distinct quantities. The paper and website use different storage definitions in places. All exact inputs, maxima, quality filters and paper source hashes are in <a href="claims.json">claims.json</a>.</p>`;
  document.getElementById("touch").addEventListener("click",()=>{
    if (document.querySelector(".hero-logo")) previewContact();
    else location.href="?card=01&touch=1";
  });
  if (params.has("touch")) previewContact();
  document.getElementById("status").textContent=`${shown.length} still card${shown.length===1?"":"s"} ready. No video rendered. Click a card to inspect it; use ← / → in single-card view.`;
  window.storyboardCards=cards.map(({id,name,motion,evidence})=>({id,name,motion,evidence}));
  window.storyboardDetails=detailFrames.map(({card,beat,file,name})=>({card,beat,file,name}));
  window.previewContact=previewContact;
  if (selectedId) document.addEventListener("keydown",(event)=>{
    if (!["ArrowLeft","ArrowRight"].includes(event.key)) return;
    const next=cards.findIndex((card)=>card.id===selectedId)+(event.key==="ArrowRight"?1:-1);
    if (cards[next]) location.href=`?card=${cards[next].id}`;
  });
})();
window.ready.catch((error)=>{document.getElementById("status").textContent=error.message;});
