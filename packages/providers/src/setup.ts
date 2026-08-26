/**
 * Guided local-model setup (`qofeno setup`): detect → show installed models →
 * recommend by hardware score → consent-gated pull → verify. Every step is
 * real; nothing is downloaded without explicit user approval (#LOCAL MODELS).
 */
import { execFile } from "@agent-qofeno/runtime";
import { OllamaProvider } from "@agent-qofeno/providers";
import { detectHardware, recommendModels, type HardwareReport, type ModelRecommendation } from "@agent-qofeno/runtime";

export interface SetupStep {
  kind: "info" | "warn" | "action" | "success" | "error";
  text: string;
}

export interface SetupCallbacks {
  say(step: SetupStep): void;
  /** Ask a yes/no question; false aborts. */
  confirm(title: string, detail?: string): Promise<boolean>;
}

export interface SetupResult {
  status: "model-ready" | "pulled" | "no-ollama" | "aborted" | "failed";
  modelId?: string;
}

export class LocalModelSetup {
  private ollama = new OllamaProvider({ id: "ollama" });

  async run(cb: SetupCallbacks): Promise<SetupResult> {
    // 1) Hardware report.
    const hw = await detectHardware();
    cb.say({
      kind: "info",
      text: `Hardware: ${hw.cpuCores} cores (${hw.cpuModel}), ${hw.ramTotalGb} GB RAM, ${hw.arch}` +
        (hw.gpu ? `, GPU: ${hw.gpu.name}${hw.gpu.vramGb ? ` ~${hw.gpu.vramGb}GB` : ""} [${hw.accelerator}]` : ", no discrete GPU detected") +
        ` — score ${hw.score}/100 (${hw.tier})`,
    });

    // 2) Installed models?
    const health = await this.ollama.health();
    if (health.status !== "healthy") {
      cb.say({
        kind: "error",
        text: "Ollama is not running. Install it from https://ollama.com and start it with `ollama serve`, then re-run `qofeno setup`.",
      });
      return { status: "no-ollama" };
    }
    const installed = await this.ollama.listModels();
    if (installed.length > 0) {
      cb.say({ kind: "success", text: `Found ${installed.length} installed local model(s):` });
      for (const m of installed) {
        cb.say({ kind: "info", text: `  • ${m.modelId}${m.resourceHint ? ` (~${m.resourceHint})` : ""}` });
      }
      const useExisting = await cb.confirm("Use an installed model?", "You can also pull a new one.");
      if (useExisting) {
        return { status: "model-ready", modelId: `ollama:${installed[0]!.modelId}` };
      }
    }

    // 3) Recommendations scored for THIS machine.
    const recs = recommendModels(hw);
    if (recs.length === 0) {
      cb.say({ kind: "warn", text: "This machine is below the practical floor for local inference. Hosted providers or a beefier machine are recommended." });
      return { status: "aborted" };
    }
    cb.say({ kind: "info", text: "Recommended for your hardware (approximate download sizes shown before you decide):" });
    recs.forEach((r, i) => {
      cb.say({ kind: "info", text: `  [${i + 1}] ${r.label} (${r.paramsB}, ~${r.diskGbApprox} GB disk, needs ≥${r.minRamGb} GB RAM)\n      why: ${r.why}\n      upstream weights & license: ${r.hfUrl}` });
    });

    // 4) Choice + explicit size/consent gate.
    const pick = await cb.confirm(`Pull recommendation [1] ${recs[0]!.label}?`, `~${recs[0]!.diskGbApprox} GB will be downloaded by YOUR ollama install to its own storage. Qofeno never downloads models itself.`);
    if (!pick) {
      cb.say({ kind: "info", text: "Aborted — nothing was downloaded. Run `ollama pull <model>` manually anytime." });
      return { status: "aborted" };
    }

    // 5) Pull through ollama CLI (the user's tool), with honest streaming-free wait.
    const choice: ModelRecommendation = recs[0]!;
    cb.say({ kind: "action", text: `Running: ollama pull ${choice.id} (this can take a while; progress is printed by ollama)` });
    try {
      const r = await execFile("ollama", ["pull", choice.id], { timeoutMs: 3_600_000 });
      if (r.code !== 0) {
        cb.say({ kind: "error", text: `Pull failed: ${r.stderr.trim().slice(0, 300) || `exit ${r.code}`}` });
        return { status: "failed" };
      }
    } catch (e) {
      cb.say({ kind: "error", text: `Could not run \`ollama\`. Is it on PATH? ${(e as Error).message.slice(0, 200)}` });
      return { status: "failed" };
    }

    // 6) Verify the model actually exists now (never claim unverified success).
    const after = await this.ollama.listModels();
    const got = after.find((m) => m.modelId === choice.id || m.modelId.startsWith(choice.id));
    if (!got) {
      cb.say({ kind: "error", text: "Pull reported success but the model is not listed — reporting honestly instead of assuming." });
      return { status: "failed" };
    }
    cb.say({ kind: "success", text: `Ready: ollama:${got.modelId}. Set it as default with:\n  qofeno config set model "ollama:${got.modelId}"` });
    return { status: "pulled", modelId: `ollama:${got.modelId}` };
  }
}
