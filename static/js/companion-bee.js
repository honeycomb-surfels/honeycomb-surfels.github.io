/**
 * The wander bee: a second bee that leaves the title logo and takes a smooth random walk in the viewport, now and then
 * visiting the name of one of the two co-first authors. Visits alternate between them, starting with either at random,
 * so both names get the same number of visits. The bee is off by default; a switch at the top right of the page header
 * turns it on, which makes it rest on the logo for a moment and take off, and off again. Under reduced motion the
 * switch is hidden and the bee never flies.
 * @param {SVGSVGElement} logo The existing inline title artwork.
 * @param {HTMLElement[]} authors The co-first authors' name blocks, which trade places on screen.
 * @param {MediaQueryList} reducedMotion The page's shared motion preference.
 */
export function setupCompanionBee(logo, authors, reducedMotion) {
  const header = logo.closest(".hero")?.querySelector(".hero-body");
  if (authors.length < 2 || !header) return;

  const drawing = logo.querySelector(".hxl-bee");
  const perch = drawing.cloneNode(true);
  perch.setAttribute("class", "hxl-companion-perch");
  perch.setAttribute("transform", "translate(-18.52 -7) rotate(-18)");
  perch.style.display = "none";
  logo.append(perch);

  // Reuse the logo artwork, with a separate clip ID so both bees keep their stripes.
  const flyer = beeArtwork(logo, drawing, "hx-companion-body", "-24 -24 48 48");
  flyer.setAttribute("class", "hx-companion-bee");
  const bee = flyer.lastElementChild;
  document.body.append(flyer);

  const wings = bee.querySelector(".hxl-wings");
  const [hingeX, hingeY] = wings.dataset.hinge.split(" ").map(Number);
  const REST_MS = 900; // on the logo before take-off
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  let active = false;
  let frame = 0;
  let lastTime = 0;
  let elapsed = 0;
  let x = 0;
  let y = 0;
  let facing = 1;
  let bank = -18;
  let perchSize = 30;
  let vx = 0;
  let vy = 0;
  let nextVisitAt = 2500;
  let visitUntil = 0;
  let visiting = null;
  let nextAuthor = Math.random() < 0.5 ? 0 : 1;

  /** Logo coordinates keep the resting bee attached to the lower-left honeycomb at every screen size. */
  function perchPosition() {
    const matrix = logo.getScreenCTM();
    if (!matrix) return { x: 32, y: 32, size: 30 };
    const point = new DOMPoint(-18.52, -7).matrixTransform(matrix);
    return { x: point.x, y: point.y, size: 48 * Math.hypot(matrix.a, matrix.b) };
  }

  /** The name's spot to hover over, if it is far enough inside the viewport. */
  function nameSpot(block) {
    const name = block.getBoundingClientRect();
    if (name.top <= 48 || name.bottom >= window.innerHeight - 48) return null;
    return { x: name.left + name.width / 2, y: name.top - 24 };
  }

  function tick(time) {
    const dt = lastTime ? Math.min(time - lastTime, 50) : 0;
    lastTime = time;
    elapsed += dt;
    if (elapsed < REST_MS) {
      const position = perchPosition();
      x = position.x;
      y = position.y;
      perchSize = position.size;
      // Do not leave the companion behind if the reader scrolls away during its rest.
      if (y < 0 || y > window.innerHeight) {
        elapsed = REST_MS;
        x = document.documentElement.clientWidth / 2;
        y = window.innerHeight / 2;
      }
    }
    if (elapsed >= REST_MS) {
      perch.style.display = "none";
      flyer.style.visibility = "visible";
      const seconds = dt / 1000;
      // Correlated Brownian velocity: random kicks with damping keep the walk smooth and frame-rate independent.
      const keep = Math.exp(-seconds / 1.25);
      const noise = 90 * Math.sqrt(1 - keep * keep) * Math.sqrt(-2 * Math.log(Math.max(Number.EPSILON, Math.random())));
      const angle = 2 * Math.PI * Math.random();
      vx = vx * keep + noise * Math.cos(angle);
      vy = vy * keep + noise * Math.sin(angle);
      if (elapsed >= nextVisitAt) {
        nextVisitAt = elapsed + 12000 + Math.random() * 16000;
        const spot = nameSpot(authors[nextAuthor]);
        // A visit that cannot happen now keeps its author for the next chance, so the turns stay even.
        if (spot && Math.hypot(spot.x - x, spot.y - y) < 240) {
          visiting = authors[nextAuthor];
          visitUntil = elapsed + 2200;
          nextAuthor = 1 - nextAuthor;
        }
      }
      if (elapsed < visitUntil) {
        const spot = nameSpot(visiting);
        if (spot) {
          const pull = 1 - Math.exp(-seconds * 2);
          vx += ((spot.x - x) * 1.5 - vx) * pull;
          vy += ((spot.y - y) * 1.5 - vy) * pull;
        } else visitUntil = 0;
      }
      const nextX = x + vx * seconds;
      const nextY = y + vy * seconds;
      if (nextX < 24) vx = Math.abs(vx);
      if (nextX > document.documentElement.clientWidth - 24) vx = -Math.abs(vx);
      if (nextY < 24) vy = Math.abs(vy);
      if (nextY > window.innerHeight - 24) vy = -Math.abs(vy);
      const ease = 1 - Math.exp(-dt / 160);
      if (Math.abs(vx) > 8) facing += ((vx < 0 ? 1 : -1) - facing) * ease;
      const tilt = -Math.sign(facing) * clamp(vy * 0.12, -16, 16);
      bank += (tilt - bank) * ease;
      x = clamp(nextX, 24, document.documentElement.clientWidth - 24);
      y = clamp(nextY, 24, window.innerHeight - 24);
      const lift = Math.min(1, (elapsed - REST_MS) / 700);
      const size = perchSize * (1 - lift) + 36 * lift;
      flyer.style.width = `${size}px`;
      flyer.style.height = `${size}px`;
      flyer.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
      // Mirror horizontally to face the flight; a small bank keeps the wings above the body.
      bee.setAttribute("transform", `rotate(${bank}) scale(${facing} 1)`);
      const flap = 0.65 + 0.35 * Math.cos(elapsed * Math.PI / 45);
      wings.setAttribute("transform", `translate(${hingeX} ${hingeY}) scale(1 ${flap}) translate(${-hingeX} ${-hingeY})`);
    }
    frame = requestAnimationFrame(tick);
  }

  /** Run the walk while the bee is out and motion is allowed; hidden tabs do no animation work. */
  function syncMotion() {
    cancelAnimationFrame(frame);
    lastTime = 0;
    if (!active || reducedMotion.matches) {
      elapsed = 0;
      vx = 0;
      vy = 0;
      nextVisitAt = 2500;
      visitUntil = 0;
      perch.style.display = "none";
      flyer.style.visibility = "hidden";
      return;
    }
    if (document.hidden) return;
    if (!elapsed) {
      perch.style.display = "";
      // A deep link or a quick scroll skips the perch when the logo is already out of view.
      const position = perchPosition();
      if (position.y < 0 || position.y > window.innerHeight) {
        elapsed = REST_MS;
        x = document.documentElement.clientWidth / 2;
        y = window.innerHeight / 2;
      }
    }
    frame = requestAnimationFrame(tick);
  }

  /* The switch: off by default, at the top right of the page header. Its bee faces the label. */
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "hx-wander-toggle";
  const label = document.createElement("span");
  const icon = beeArtwork(logo, drawing, "hx-wander-icon-body", "-13 -19 33 27");
  icon.lastElementChild.setAttribute("transform", "scale(-1 1)");
  toggle.append(icon, label);
  header.append(toggle);
  const render = () => {
    toggle.classList.toggle("is-on", active);
    label.textContent = active ? "Turn off Wander Bee" : "Turn on Wander Bee";
  };
  toggle.addEventListener("click", () => {
    active = !active;
    render();
    syncMotion();
  });
  render();

  // Coordinates are viewport-relative: scrolling changes the scenery, never the bee's position.
  window.addEventListener("resize", () => {
    x = clamp(x, 24, document.documentElement.clientWidth - 24);
    y = clamp(y, 24, window.innerHeight - 24);
  });
  reducedMotion.addEventListener("change", syncMotion);
  document.addEventListener("visibilitychange", syncMotion);
}

/** A standalone SVG of the logo's bee in its own frame, with its own clip ID so its stripes survive the copy. */
function beeArtwork(logo, drawing, clipId, viewBox) {
  const svg = document.createElementNS(logo.namespaceURI, "svg");
  svg.setAttribute("viewBox", viewBox);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const clip = logo.querySelector("#hxl-body").cloneNode(true);
  clip.id = clipId;
  const defs = document.createElementNS(logo.namespaceURI, "defs");
  defs.append(clip);
  const bee = drawing.cloneNode(true);
  bee.removeAttribute("transform");
  bee.removeAttribute("class");
  bee.querySelector("[clip-path]").setAttribute("clip-path", `url(#${clipId})`);
  svg.append(defs, bee);
  return svg;
}
