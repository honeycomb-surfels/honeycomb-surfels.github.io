/** Cache only the source media used by the release edit; original hosted assets are not modified. */
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const folder = join(dirname(fileURLToPath(import.meta.url)), "assets");
const host = "https://pub-c45189ae5c7b4323bf573acdcd18ab1b.r2.dev";
const assets = [
  ["kitchen-ours.mp4", `${host}/nvs/mipnerf360/kitchen/ours.mp4?v=2`],
  ["garden-ours.mp4", `${host}/nvs_memory/mipnerf360/garden/ours.mp4?v=2`],
  ["skull.glb", `${host}/meshes/dtu/scan65/ours.glb?v=2`],
];
await mkdir(folder, { recursive: true });
for (const [name, url] of assets) {
  const destination = join(folder, name);
  if (await stat(destination).then((file) => file.size > 0, () => false)) continue;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  await writeFile(destination, bytes);
  process.stdout.write(`Cached ${name}: ${bytes.length} bytes\n`);
}
