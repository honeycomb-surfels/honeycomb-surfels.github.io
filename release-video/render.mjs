/** Render the release edit to a 1080-square, 30 fps H.264 MP4. */
import { mkdtemp, mkdir, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { chromium } from "playwright";

const folder = dirname(fileURLToPath(import.meta.url));
const work = await mkdtemp(join(tmpdir(), "hexels-release-"));
const frames = join(work, "frames");
await mkdir(frames);
const browser = await chromium.launch({
  headless: true,
  args: ["--enable-unsafe-swiftshader"],
  executablePath: process.env.CHROME_EXECUTABLE,
});
try {
  const page = await browser.newPage({ viewport: { width: 1080, height: 1080 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const url = new URL("release-video/film.html?render=1", process.env.PREVIEW_ORIGIN ?? "http://127.0.0.1:8000/");
  await page.goto(url.href, { waitUntil: "load" });
  await page.evaluate(() => window.ready);
  const config = await page.evaluate(() => window.videoConfig);
  const output = join(folder, `${config.output}.mp4`);
  const frameCount = Math.round(config.duration * 30);
  for (let index = 0; index < frameCount; index += 1) {
    await page.evaluate((seconds) => window.renderAt(seconds), index / 30);
    const path = join(frames, `frame-${String(index).padStart(4, "0")}.png`);
    await page.locator("#scene").screenshot({ path, animations: "disabled" });
    if (index === Math.round(config.coverTime * 30)) await copyFile(path, join(folder, `${config.output}-cover.png`));
    if (index % 30 === 0) process.stdout.write(`Rendered ${index / 30} / ${config.duration} seconds\n`);
    if (errors.length) throw new Error(errors.join("\n"));
  }
  const encoded = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-framerate", "30", "-i", join(frames, "frame-%04d.png"),
    "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", output,
  ], { encoding: "utf8" });
  if (encoded.error || encoded.status !== 0) throw new Error(encoded.error?.message ?? encoded.stderr);
  process.stdout.write(`Saved ${output}\n`);
} finally {
  await browser.close();
  await rm(work, { recursive: true, force: true });
}
