/**
 * Hardware detection (#LOCAL MODELS): CPU/RAM/GPU/accelerator discovery with
 * honest fallbacks. Used to score the machine and recommend locally-runnable
 * models. Never guesses capabilities it cannot observe.
 */
import { execFile } from "./process.js";
import { cpus, totalmem, arch, platform } from "node:os";

export interface HardwareReport {
  platform: NodeJS.Platform;
  arch: string;
  cpuCores: number;
  cpuModel: string;
  ramTotalGb: number;
  gpu?: { vendor: "nvidia" | "amd" | "apple" | "intel" | "unknown"; name: string; vramGb?: number };
  accelerator: "cuda" | "rocm" | "metal" | "cpu";
  /** 0–100 practical score for local LLM inference. Set by detectHardware(). */
  score: number;
  tier: HardwareTier;
}

export type HardwareTier = "minimal" | "entry" | "mid" | "high" | "extreme";

async function tryCmd(file: string, args: string[], timeoutMs = 4000): Promise<string | null> {
  try {
    const r = await execFile(file, args, { timeoutMs });
    return r.code === 0 ? r.stdout : null;
  } catch {
    return null;
  }
}

export async function detectHardware(): Promise<HardwareReport> {
  // Built incrementally; score/tier assigned before return.

  const cpusList = cpus();
  const ramGb = totalmem() / 1024 ** 3;
  const report: Omit<HardwareReport, "score" | "tier"> & { score?: number; tier?: HardwareTier } = {
    platform: platform(),
    arch: arch(),
    cpuCores: cpusList.length || 1,
    cpuModel: cpusList[0]?.model?.trim().slice(0, 80) || "unknown CPU",
    ramTotalGb: Math.round(ramGb * 10) / 10,
    accelerator: "cpu",
  };

  // GPU discovery — best effort per platform, honest absence otherwise.
  if (process.platform === "darwin") {
    const info = await tryCmd("system_profiler", ["SPDisplaysDataType", "-json"], 6000);
    if (info) {
      try {
        const parsed = JSON.parse(info) as { SPDisplaysDataType?: Array<{ sppci_model?: string; spdisplays_vram_shared?: string }> };
        const gpu0 = parsed.SPDisplaysDataType?.[0];
        if (gpu0?.sppci_model) {
          const name = String(gpu0.sppci_model);
          report.gpu = { vendor: /apple/i.test(name) ? "apple" : "intel", name };
          report.accelerator = "metal";
        }
      } catch {
        /* keep cpu-only */
      }
    }
  } else {
    const nvidia = await tryCmd("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"]);
    if (nvidia) {
      const [name, vram] = nvidia.split("\n")[0]!.split(",").map((x) => x.trim());
      report.gpu = { vendor: "nvidia", name: name ?? "NVIDIA GPU", vramGb: vram ? Math.round(Number(vram) / 1024 * 10) / 10 : undefined };
      report.accelerator = "cuda";
    } else {
      const rocm = await tryCmd("rocm-smi", ["--showproductname", "--showvramusage"]);
      if (rocm && /Card series|Instinct|Radeon/i.test(rocm)) {
        report.gpu = { vendor: "amd", name: (rocm.match(/Card series:\s*(.+)/)?.[1] ?? "AMD GPU").trim() };
        report.accelerator = "rocm";
      }
    }
  }

  // Scoring: RAM dominates for local inference; cores and accelerator assist.
  let score = 0;
  score += Math.min(50, report.ramTotalGb * 3.2);          // up to 50 pts @ ~16GB
  score += Math.min(20, report.cpuCores * 1.6);            // up to 20 pts @ ~12 cores
  if (report.accelerator === "cuda") score += 22;
  else if (report.accelerator === "metal") score += 16;
  else if (report.accelerator === "rocm") score += 12;
  if (report.arch === "arm64") score += 6;

  const finalScore = Math.max(0, Math.min(100, Math.round(score)));
  const finalTier: HardwareTier =
    finalScore >= 85 ? "extreme" :
    finalScore >= 62 ? "high" :
    finalScore >= 38 ? "mid" :
    finalScore >= 18 ? "entry" : "minimal";
  return { ...report, score: finalScore, tier: finalTier };
}

export interface ModelRecommendation {
  id: string;              // ollama pull name
  label: string;
  paramsB: string;
  diskGbApprox: number;
  minRamGb: number;
  why: string;
  hfUrl: string;           // Hugging Face page for upstream weights/details
}

/**
 * Curated, currently-real Ollama library entries mapped to hardware tiers,
 * each linked to its Hugging Face upstream. Sizes are approximate library
 * figures shown honestly as approximations.
 */
export function recommendModels(hw: HardwareReport): ModelRecommendation[] {
  const table: Array<ModelRecommendation & { tiers: HardwareTier[] }> = [
    { id: "qwen2.5:0.5b",   label: "Qwen2.5 0.5B",    paramsB: "0.5B", diskGbApprox: 0.4,  minRamGb: 2,  why: "ultra-light chat, runs anywhere",                 hfUrl: "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct",   tiers: ["minimal", "entry", "mid", "high", "extreme"] },
    { id: "smollm2:1.7b",   label: "SmolLM2 1.7B",    paramsB: "1.7B", diskGbApprox: 1.8,  minRamGb: 4,  why: "strong small model, good quality/speed balance",  hfUrl: "https://huggingface.co/HuggingFaceTB/SmolLM2-1.7B-Instruct", tiers: ["entry", "mid", "high", "extreme"] },
    { id: "qwen2.5-coder:1.5b", label: "Qwen2.5-Coder 1.5B", paramsB: "1.5B", diskGbApprox: 1.6, minRamGb: 4, why: "coding-tuned small model",                     hfUrl: "https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct", tiers: ["entry", "mid", "high", "extreme"] },
    { id: "llama3.2:3b",    label: "Llama 3.2 3B",    paramsB: "3B",   diskGbApprox: 2.9,  minRamGb: 6,  why: "solid general assistant",                          hfUrl: "https://huggingface.co/meta-llama/Llama-3.2-3B-Instruct", tiers: ["mid", "high", "extreme"] },
    { id: "qwen2.5-coder:7b", label: "Qwen2.5-Coder 7B", paramsB: "7B", diskGbApprox: 4.7,  minRamGb: 9,  why: "excellent coding model for its size",             hfUrl: "https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct",  tiers: ["high", "extreme"] },
    { id: "llama3.1:8b",    label: "Llama 3.1 8B",    paramsB: "8B",   diskGbApprox: 4.9,  minRamGb: 9,  why: "strong general-purpose 8B",                        hfUrl: "https://huggingface.co/meta-llama/Llama-3.1-8B-Instruct", tiers: ["high", "extreme"] },
    { id: "qwen2.5:14b",    label: "Qwen2.5 14B",     paramsB: "14B",  diskGbApprox: 9.0,  minRamGb: 16, why: "near-frontier quality locally",                    hfUrl: "https://huggingface.co/Qwen/Qwen2.5-14B-Instruct",       tiers: ["extreme"] },
  ];
  return table.filter((m) => m.tiers.includes(hw.tier)).map(({ tiers: _t, ...m }) => m);
}
