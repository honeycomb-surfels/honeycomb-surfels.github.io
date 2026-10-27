"""Audit release claims from local website data and the current paper, then draw a static chart.

Run from any directory; paths default to this repository and its sibling hexel_arxiv folder.
Only the flashcard claims.json and benchmark.svg outputs are written.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
from statistics import mean
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = Path(__file__).resolve().parent
DATASETS = ("tanks_and_temples", "mipnerf360", "dtu")
METRICS = ("train_min", "vram_gib", "fps", "psnr", "ssim", "lpips", "deployment_mb", "primitives_k")


def paper_row(path: Path, prefix: str, columns: int) -> dict[str, dict[str, float]]:
    """Read one numeric LaTeX row, with three dataset blocks in the paper's order."""
    line = next(line for line in path.read_text().splitlines() if line.startswith(prefix + " &"))
    values = []
    for cell in line.split("&")[1:]:
        cell = re.sub(r"\\cellcolor\{[^}]*\}", "", cell)
        numbers = re.findall(r"-?\d+(?:\.\d+)?", cell)
        if len(numbers) != 1:
            raise ValueError(f"Expected one value in {path.name}: {cell}")
        values.append(float(numbers[0]))
    if len(values) != columns * 3:
        raise ValueError(f"Unexpected row width in {path.name}: {len(values)}")
    return {dataset: dict(zip(METRICS[:columns], values[i * columns:(i + 1) * columns])) for i, dataset in enumerate(DATASETS)}


def comparison(ours: dict[str, float], baseline: dict[str, float]) -> dict[str, Any]:
    """Use savings relative to 2DGS and ratio of FPS, never percentage-point shortcuts."""
    result: dict[str, Any] = {
        "psnr_gain_db": ours["psnr"] - baseline["psnr"],
        "ssim_gain": ours["ssim"] - baseline["ssim"],
        "lpips_reduction": baseline["lpips"] - ours["lpips"],
        "training_vram_reduction_pct": 100 * (1 - ours["vram_gib"] / baseline["vram_gib"]),
        "rendering_fps_ratio": ours["fps"] / baseline["fps"],
        "ours": ours, "2dgs": baseline,
    }
    for key in ("deployment_mb", "memory_mb"):
        if key in ours and key in baseline:
            result[f"{key}_reduction_pct"] = 100 * (1 - ours[key] / baseline[key])
    result["nonlower_psnr"] = result["psnr_gain_db"] >= 0
    result["all_quality_metrics_nonworse"] = all(result[k] >= 0 for k in ("psnr_gain_db", "ssim_gain", "lpips_reduction"))
    return result


def website_audit() -> dict[str, Any]:
    """Keep scene maxima and ratio-of-dataset-means separate, including quality filters."""
    audit = {}
    for setting, filename in (("native", "nvs_metrics.json"), ("matched_memory", "nvs_metrics_memory.json"), ("matched_count_v3", "nvs_metrics_count.json")):
        page = json.loads((ROOT / "static/data" / filename).read_text())["page"]
        rows = {}
        for scene, methods in page["scenes"].items():
            pair = [{key: row[key]["value"] for key in ("psnr", "ssim", "lpips", "vram_gib", "memory_mb", "fps")} for row in (methods["ours"], methods["2dgs"])]
            rows[scene] = comparison(*pair)
        maxima = {}
        for quality in ("all_scenes", "nonlower_psnr", "all_quality_metrics_nonworse"):
            eligible = {scene: row for scene, row in rows.items() if quality == "all_scenes" or row[quality]}
            maxima[quality] = {}
            for metric in ("training_vram_reduction_pct", "memory_mb_reduction_pct", "rendering_fps_ratio"):
                if eligible:
                    scene = max(eligible, key=lambda name: eligible[name][metric])
                    maxima[quality][metric] = {"scene": scene, **eligible[scene]}
        means = {}
        for dataset in DATASETS:
            scenes = [row for scene, row in rows.items() if scene.startswith(dataset + "/")]
            pair = [{key: mean(row[method][key] for row in scenes) for key in scenes[0][method]} for method in ("ours", "2dgs")]
            means[dataset] = {"scene_count": len(scenes), **comparison(*pair)}
        audit[setting] = {"source": f"static/data/{filename}", "footnote": page["footnote"], "scene_count": len(rows), "maxima": maxima, "dataset_means": means}
        if setting in ("native", "matched_memory"):
            audit[setting]["kitchen"] = rows["mipnerf360/kitchen"]
    return audit


def draw_benchmark(rows: dict[str, Any], destination: Path) -> None:
    """Draw dataset-mean matched-memory PSNR as paired dots; no fabricated Pareto curves."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    labels = ("Tanks & Temples", "Mip-NeRF 360", "DTU")
    with plt.rc_context({"font.family": "sans-serif", "font.sans-serif": ["Arial", "DejaVu Sans"], "font.size": 17, "svg.fonttype": "none", "axes.spines.top": False, "axes.spines.right": False, "axes.spines.left": False}):
        fig, ax = plt.subplots(figsize=(10.4, 4.1))
        fig.patch.set_alpha(0); ax.set_facecolor("none")
        for y, dataset in enumerate(DATASETS):
            row = rows[dataset]
            a, b = row["ours"]["psnr"], row["2dgs"]["psnr"]
            ax.plot([b, a], [y, y], color="#ddd4c5", linewidth=5, zorder=1)
            ax.scatter(b, y, s=160, color="#458da5", marker="o", zorder=3, label="2DGS" if y == 0 else None)
            ax.scatter(a, y, s=210, color="#a46d12", marker="h", zorder=4, label="Hexels" if y == 0 else None)
            ax.text(31.2, y, f"+{row['psnr_gain_db']:.2f}", ha="right", va="center", color="#80530a", fontweight="bold", fontsize=20)
        ax.set_yticks(range(3), labels, fontsize=18)
        ax.set_ylim(2.6, -0.65); ax.set_xlim(15, 31.7)
        ax.set_xticks([15, 20, 25, 30]); ax.set_xlabel("PSNR (dB)  ·  higher is better", fontsize=17, labelpad=10)
        ax.tick_params(axis="y", length=0, pad=12); ax.tick_params(axis="x", labelsize=16)
        ax.grid(axis="x", color="#e9e2d7", linewidth=0.8); ax.set_axisbelow(True)
        ax.legend(loc="upper center", bbox_to_anchor=(0.5, 1.22), ncol=2, frameon=False, fontsize=17)
        fig.subplots_adjust(left=0.25, right=0.98, bottom=0.23, top=0.82)
        fig.savefig(destination, transparent=True)
        plt.close(fig)


def main() -> None:
    """Generate an inspectable evidence snapshot; never edit or execute the paper project."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--paper-root", type=Path, default=ROOT.parent / "hexel_arxiv")
    args = parser.parse_args()
    paper = args.paper_root.resolve()
    files = {"matched_memory": ("table1_main.tex", 6, "\\textbf{Hexels V1}"), "matched_count_v2": ("table2_main.tex", 7, "\\textbf{Hexels V2}"), "native_v2": ("table3_main.tex", 8, "\\textbf{Hexels V2}"), "native_v3": ("table3_main.tex", 8, "\\textbf{Hexels V3}")}
    evidence: dict[str, Any] = {"comparison": "Hexels vs 2DGS", "paper": {}, "website": website_audit()}
    for setting, (filename, columns, prefix) in files.items():
        path = paper / "tables" / filename
        ours, baseline = paper_row(path, prefix, columns), paper_row(path, "2DGS", columns)
        # Matched-memory tables do not report deployment size; do not invent numeric placeholders.
        evidence["paper"][setting] = {"source": path.relative_to(paper).as_posix(), "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "precision": "calculated from rounded paper table cells", "dataset_means": {dataset: comparison(ours[dataset], baseline[dataset]) for dataset in DATASETS}}
    current = evidence["paper"]["matched_count_v2"]["dataset_means"]
    if not all(row["all_quality_metrics_nonworse"] for row in current.values()):
        raise ValueError("Matched-count V2 does not support the proposed quality statement")
    selected = {}
    for metric in ("training_vram_reduction_pct", "deployment_mb_reduction_pct", "rendering_fps_ratio"):
        dataset = max(current, key=lambda key: current[key][metric])
        selected[metric] = {"dataset": dataset, "value": current[dataset][metric]}
    evidence["recommended_dataset_claims"] = {"setting": "matched_count_v2", "scope": "maximum of three dataset means, not a single scene or one joint result", "metrics": selected}
    triangle = paper_row(paper / "tables/table3_main.tex", "Triangle Spl.", 8)
    hardware = json.loads((ROOT / "static/data/explorer.json").read_text())["values"]
    speed = {}
    for dataset in DATASETS:
        ours = evidence["paper"]["native_v2"]["dataset_means"][dataset]["ours"]["fps"]
        baseline = triangle[dataset]["fps"]
        speed[dataset] = {"hexels_v2_fps": ours, "triangle_fps": baseline, "ratio": ours / baseline, "triangle_ada_scenes": hardware[dataset]["triangle"]["ada_scenes"], "scenes": hardware[dataset]["triangle"]["scenes"]}
    evidence["native_triangle_fps"] = {"source": "tables/table3_main.tex", "rows": speed, "all_datasets_higher_measured_fps": all(row["ratio"] > 1 for row in speed.values()), "scope": "Native configurations, dataset means. Hexels V2 uses RTX A5000; Triangle uses RTX 6000 Ada on all Mip-NeRF 360 and Tanks and Temples scenes, RTX A5000 on DTU. Different quality/configuration; not a hardware-matched or equal-quality speedup."}
    candidates = ("3DGS", "3D Convex", "BBSplat", "Nexels", "2DGS", "Triangle Spl.", "MeshSplatting")
    table1 = paper / "tables/table1_main.tex"
    peers = {name: paper_row(table1, name, 6) for name in candidates}
    evidence["matched_memory_best_psnr"] = {}
    for dataset in DATASETS:
        ours = evidence["paper"]["matched_memory"]["dataset_means"][dataset]["ours"]["psnr"]
        evidence["matched_memory_best_psnr"][dataset] = ours > max(row[dataset]["psnr"] for row in peers.values())
        # The website retains unrounded PSNR values; its VRAM/storage definitions can differ.
        for method in ("ours", "2dgs"):
            precise = evidence["website"]["matched_memory"]["dataset_means"][dataset][method]["psnr"]
            rounded = evidence["paper"]["matched_memory"]["dataset_means"][dataset][method]["psnr"]
            if abs(precise - rounded) > 0.0051:
                raise ValueError(f"Website/paper PSNR mismatch for {dataset}/{method}")
    (OUTPUT / "claims.json").write_text(json.dumps(evidence, indent=2) + "\n")
    draw_benchmark(evidence["website"]["matched_memory"]["dataset_means"], OUTPUT / "assets/benchmark.svg")
    print(json.dumps(evidence["recommended_dataset_claims"], indent=2))


if __name__ == "__main__":
    main()
