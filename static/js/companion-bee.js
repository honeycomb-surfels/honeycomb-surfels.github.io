/**
 * A decorative bee taking a smooth random walk in the viewport, occasionally visiting a nearby author.
 * @param {SVGSVGElement} logo The existing inline title artwork.
 * @param {HTMLElement|null} author Prakhar's author block, which may trade places with its neighbor.
 * @param {MediaQueryList} reducedMotion The page's shared motion preference.
 */
export function setupCompanionBee(logo, author, reducedMotion) {
  if (!author) return;

  const drawing = logo.querySelector(".hxl-bee");
  const perch = drawing.cloneNode(true);
  perch.setAttribute("class", "hxl-companion-perch");
  perch.setAttribute("transform", "translate(-18.52 -7) rotate(-18)");
  logo.append(perch);

  // Reuse the logo artwork, with a separate clip ID so both bees keep their stripes.
  const flyer = document.createElementNS(logo.namespaceURI, "svg");
  flyer.setAttribute("class", "hx-companion-bee");
  flyer.setAttribute("viewBox", "-24 -24 48 48");
  flyer.setAttribute("aria-hidden", "true");
  flyer.setAttribute("focusable", "false");
  flyer.setAttribute("stroke-linecap", "round");
  flyer.setAttribute("stroke-linejoin", "round");
  const clip = logo.querySelector("#hxl-body").cloneNode(true);
  clip.id = "hx-companion-body";
  const defs = document.createElementNS(logo.namespaceURI, "defs");
  defs.append(clip);
  const bee = drawing.cloneNode(true);
  bee.removeAttribute("transform");
  bee.querySelector('[clip-path]').setAttribute("clip-path", "url(#hx-companion-body)");
  flyer.append(defs, bee);
  document.body.append(flyer);

  const wings = bee.querySelector(".hxl-wings");
  const [hingeX, hingeY] = wings.dataset.hinge.split(" ").map(Number);
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
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

  /** Logo coordinates keep the resting bee attached to the lower-left honeycomb at every screen size. */
  function perchPosition() {
    const matrix = logo.getScreenCTM();
    if (!matrix) return { x: 32, y: 32, size: 30 };
    const point = new DOMPoint(-18.52, -7).matrixTransform(matrix);
    return { x: point.x, y: point.y, size: 48 * Math.hypot(matrix.a, matrix.b) };
  }

  function tick(time) {
    const dt = lastTime ? Math.min(time - lastTime, 50) : 0;
    lastTime = time;
    elapsed += dt;
    if (elapsed < 1800) {
      const position = perchPosition();
      x = position.x;
      y = position.y;
      perchSize = position.size;
      // Do not leave the companion behind if the reader scrolls away during its initial rest.
      if (y < 0 || y > window.innerHeight) {
        elapsed = 1800;
        x = document.documentElement.clientWidth / 2;
        y = window.innerHeight / 2;
      }
    }
    if (elapsed >= 1800) {
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
        const name = author.getBoundingClientRect();
        const distance = Math.hypot(name.left + name.width / 2 - x, name.top - 24 - y);
        if (name.top > 48 && name.bottom < window.innerHeight - 48 && distance < 240) visitUntil = elapsed + 2200;
      }
      if (elapsed < visitUntil) {
        const name = author.getBoundingClientRect();
        if (name.top > 48 && name.bottom < window.innerHeight - 48) {
          const pull = 1 - Math.exp(-seconds * 2);
          vx += ((name.left + name.width / 2 - x) * 1.5 - vx) * pull;
          vy += ((name.top - 24 - y) * 1.5 - vy) * pull;
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
      const lift = Math.min(1, (elapsed - 1800) / 700);
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

  /** Reduced motion leaves the second bee perched; hidden tabs do no animation work. */
  function syncMotion() {
    cancelAnimationFrame(frame);
    lastTime = 0;
    if (reducedMotion.matches) {
      elapsed = 0;
      vx = 0;
      vy = 0;
      nextVisitAt = 2500;
      visitUntil = 0;
      perch.style.display = "";
      flyer.style.visibility = "hidden";
      return;
    }
    if (document.hidden) return;
    // A deep link or a quick scroll skips the perch when the logo is already out of view.
    const position = perchPosition();
    if (!elapsed && (position.y < 0 || position.y > window.innerHeight)) {
      elapsed = 1800;
      x = document.documentElement.clientWidth / 2;
      y = window.innerHeight / 2;
    }
    frame = requestAnimationFrame(tick);
  }

  // Coordinates are viewport-relative: scrolling changes the scenery, never the bee's position.
  window.addEventListener("resize", () => {
    x = clamp(x, 24, document.documentElement.clientWidth - 24);
    y = clamp(y, 24, window.innerHeight - 24);
  });
  reducedMotion.addEventListener("change", syncMotion);
  document.addEventListener("visibilitychange", syncMotion);
  syncMotion();
}
