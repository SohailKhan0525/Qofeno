/**
 * Interactive Onboarding Wizard (#ONBOARDING).
 * Detects hardware, inspects local runtimes & models, provides Hugging Face
 * recommendations scored for the detected machine, prompts for provider keys,
 * explains privacy/trust boundaries, and saves user configuration.
 */
import { createInterface } from "node:readline";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { Stylizer } from "@agent-qofeno/term";
import { detectHardware, recommendModels } from "@agent-qofeno/runtime";
import { detectSecretStore } from "@agent-qofeno/security";
import { LocalModelSetup } from "@agent-qofeno/providers";
import type { Bundle } from "@agent-qofeno/bundle";

function promptText(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolveP) => {
    rl.question(prompt, (ans) => {
      rl.close();
      resolveP(ans.trim());
    });
  });
}

async function promptHidden(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolveP) => {
    (rl as unknown as { question(q: string, cb: (a: string) => void, opts?: { silent?: boolean }): void }).question("", (ans) => {
      rl.close();
      process.stdout.write("\n");
      resolveP(ans.trim());
    }, { silent: true });
  });
}

export async function runOnboarding(bundle: Bundle, st: Stylizer): Promise<number> {
  process.stdout.write("\n");
  process.stdout.write(st.primary("╔════════════════════════════════════════════════════════════╗\n"));
  process.stdout.write(st.primary("║             Welcome to QOFENO Terminal AI Agent            ║\n"));
  process.stdout.write(st.primary("╚════════════════════════════════════════════════════════════╝\n\n"));

  process.stdout.write(st.accent("── 1. Privacy & Architecture ────────────────────────────────\n"));
  process.stdout.write(
    "  • Local-first & Provider-neutral: You own your sessions, data, and keys.\n" +
    "  • Zero Telemetry: No tracking, no external data exfiltration.\n" +
    "  • Security Boundary: Tool execution requires deterministic permission gates.\n" +
    "  • Two Products: Terminal CLI and Qofeno App (Web/Desktop/Mobile).\n\n"
  );

  process.stdout.write(st.accent("── 2. Hardware Detection ────────────────────────────────────\n"));
  const hw = await detectHardware();
  process.stdout.write(`  OS / Arch:   ${hw.platform} (${hw.arch})\n`);
  process.stdout.write(`  CPU:         ${hw.cpuCores} cores (${hw.cpuModel})\n`);
  process.stdout.write(`  Memory:      ${hw.ramTotalGb} GB RAM\n`);
  process.stdout.write(`  GPU / VRAM:  ${hw.gpu ? `${hw.gpu.name} (~${hw.gpu.vramGb ?? 0}GB, ${hw.accelerator})` : "Integrated / CPU inference"}\n`);
  process.stdout.write(`  Capability:  Score ${hw.score}/100 [Tier: ${hw.tier.toUpperCase()}]\n\n`);

  process.stdout.write(st.accent("── 3. Local Runtime & Model Discovery ───────────────────────\n"));
  const models = await bundle.providers.allModels();
  if (models.length > 0) {
    process.stdout.write(st.success(`  ✓ Found ${models.length} active model(s):\n`));
    for (const m of models) {
      process.stdout.write(`    • ${m.id} (${m.destination})\n`);
    }
  } else {
    process.stdout.write(st.warning("  ! No running local models found on this device.\n"));
  }

  process.stdout.write("\n" + st.accent("── 4. Hardware-Aware Model Recommendations ─────────────────\n"));
  const recs = recommendModels(hw);
  if (recs.length > 0) {
    process.stdout.write("  Models optimized for your device specifications:\n");
    recs.forEach((r, i) => {
      process.stdout.write(`  [${i + 1}] ${st.primary(r.label)} (${r.paramsB}, ~${r.diskGbApprox}GB disk, needs ≥${r.minRamGb}GB RAM)\n`);
      process.stdout.write(`      Why: ${r.why}\n`);
      process.stdout.write(`      HF:  ${r.hfUrl}\n`);
    });
  }

  process.stdout.write("\n" + st.accent("── 5. Setup Action ──────────────────────────────────────────\n"));
  process.stdout.write("  [1] Run guided Ollama local model pull\n");
  process.stdout.write("  [2] Configure OpenRouter API key (unified cloud models)\n");
  process.stdout.write("  [3] Configure Google Gemini API key\n");
  process.stdout.write("  [4] Configure Anthropic API key\n");
  process.stdout.write("  [5] Configure OpenAI API key\n");
  process.stdout.write("  [6] Skip configuration and start interactive CLI\n\n");

  const choice = await promptText(st.accent("  Select option [1-6] (default 6): "));
  const userConfigPath = join(bundle.paths.config, "user.json");
  const currentCfg = existsSync(userConfigPath) ? JSON.parse(await readFile(userConfigPath, "utf8")) : {};
  const secrets = detectSecretStore(bundle.paths.credentials);

  if (choice === "1") {
    const setup = new LocalModelSetup();
    const result = await setup.run({
      say: (step) => {
        const line = step.text.replace(/^/gm, "  ");
        process.stdout.write((step.kind === "error" ? st.error(line) : step.kind === "success" ? st.success(line) : step.kind === "warn" ? st.warning(line) : line) + "\n");
      },
      confirm: async (title, detail) => {
        process.stdout.write(st.warning(`\n? ${title}\n`));
        if (detail) process.stdout.write(st.muted(`  ${detail}\n`));
        const ans = await promptText(st.accent("  Proceed? [y/N]: "));
        return /^y(es)?$/i.test(ans.trim());
      },
    });
    if ((result.status === "pulled" || result.status === "model-ready") && result.modelId) {
      currentCfg.model = result.modelId;
      await writeFile(userConfigPath, JSON.stringify(currentCfg, null, 2), { mode: 0o600 });
      process.stdout.write(st.success(`\n✓ Configured default model: ${result.modelId}\n`));
    }
  } else if (choice === "2") {
    const key = await promptHidden(st.accent("  Enter OpenRouter API Key: "));
    if (key) {
      const providers = currentCfg.providers ?? [];
      const id = `openrouter-1`;
      providers.push({ id, kind: "openrouter", credentialRef: `provider:${id}` });
      currentCfg.providers = providers;
      currentCfg.model = `${id}:anthropic/claude-3.5-sonnet`;
      await secrets.set(`provider:${id}`, key);
      await writeFile(userConfigPath, JSON.stringify(currentCfg, null, 2), { mode: 0o600 });
      process.stdout.write(st.success(`\n✓ Saved OpenRouter provider and API key in ${secrets.backend}.\n`));
    }
  } else if (choice === "3") {
    const key = await promptHidden(st.accent("  Enter Google Gemini API Key: "));
    if (key) {
      const providers = currentCfg.providers ?? [];
      const id = `gemini-1`;
      providers.push({ id, kind: "gemini", credentialRef: `provider:${id}` });
      currentCfg.providers = providers;
      currentCfg.model = `${id}:gemini-2.0-flash`;
      await secrets.set(`provider:${id}`, key);
      await writeFile(userConfigPath, JSON.stringify(currentCfg, null, 2), { mode: 0o600 });
      process.stdout.write(st.success(`\n✓ Saved Google Gemini provider and API key in ${secrets.backend}.\n`));
    }
  } else if (choice === "4") {
    const key = await promptHidden(st.accent("  Enter Anthropic API Key: "));
    if (key) {
      const providers = currentCfg.providers ?? [];
      const id = `anthropic-1`;
      providers.push({ id, kind: "anthropic", credentialRef: `provider:${id}` });
      currentCfg.providers = providers;
      currentCfg.model = `${id}:claude-sonnet-4-5`;
      await secrets.set(`provider:${id}`, key);
      await writeFile(userConfigPath, JSON.stringify(currentCfg, null, 2), { mode: 0o600 });
      process.stdout.write(st.success(`\n✓ Saved Anthropic provider and API key in ${secrets.backend}.\n`));
    }
  } else if (choice === "5") {
    const key = await promptHidden(st.accent("  Enter OpenAI API Key: "));
    if (key) {
      const providers = currentCfg.providers ?? [];
      const id = `openai-1`;
      providers.push({ id, kind: "openai", credentialRef: `provider:${id}` });
      currentCfg.providers = providers;
      currentCfg.model = `${id}:gpt-4o`;
      await secrets.set(`provider:${id}`, key);
      await writeFile(userConfigPath, JSON.stringify(currentCfg, null, 2), { mode: 0o600 });
      process.stdout.write(st.success(`\n✓ Saved OpenAI provider and API key in ${secrets.backend}.\n`));
    }
  }

  currentCfg.onboardingCompleted = true;
  await writeFile(userConfigPath, JSON.stringify(currentCfg, null, 2), { mode: 0o600 });
  process.stdout.write("\n" + st.success("Setup complete! You can re-run this anytime with `qofeno onboarding`.") + "\n\n");
  return 0;
}
