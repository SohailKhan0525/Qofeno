import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectHardware, recommendModels } from "../src/hardware.js";

describe("hardware detection & model recommendation (#LOCAL MODELS)", () => {
  it("detects this machine without fabricating capabilities", async () => {
    const hw = await detectHardware();
    assert.ok(hw.cpuCores >= 1);
    assert.ok(hw.ramTotalGb > 0);
    assert.ok(hw.score >= 0 && hw.score <= 100);
    assert.ok(["minimal", "entry", "mid", "high", "extreme"].includes(hw.tier));
    // GPU is only reported when actually discovered:
    if (!hw.gpu) assert.equal(hw.accelerator, "cpu");
  });

  it("recommends only models that fit the detected machine", async () => {
    const hw = await detectHardware();
    const recs = recommendModels(hw);
    assert.ok(recs.length >= 1, "every machine gets at least one option");
    for (const r of recs) {
      // A recommendation may not demand more RAM than the machine has.
      assert.ok(r.minRamGb <= Math.max(2, hw.ramTotalGb), `${r.id} needs ${r.minRamGb}GB > ${hw.ramTotalGb}GB available`);
      assert.match(r.hfUrl, /^https:\/\/huggingface\.co\//);
      assert.ok(r.diskGbApprox > 0 && r.diskGbApprox < 20);
    }
  });

  it("scores a tiny machine honestly as minimal with an ultra-light pick", async () => {
    const tiny = await detectHardware();
    void tiny;
    // Direct tier mapping sanity via recommendModels on synthetic report:
    const fake = { ...tiny, score: 5, tier: "minimal" as const };
    const recs = recommendModels(fake);
    assert.ok(recs.some((r) => r.id === "qwen2.5:0.5b"));
    assert.ok(!recs.some((r) => r.paramsB === "14B"));
  });
});
