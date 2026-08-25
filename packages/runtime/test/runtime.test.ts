import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectCapabilities } from "../src/capabilities.js";
import { execFile, execShell, childEnv } from "../src/process.js";
import { isElevated } from "../src/elevation.js";

describe("capability detection", () => {
  it("never crashes and returns sane defaults", () => {
    const caps = detectCapabilities();
    assert.ok(caps.columns >= 20);
    assert.ok(caps.rows >= 5);
    assert.equal(typeof caps.interactive, "boolean");
    if (process.env.CI) assert.equal(caps.ciEnvironment, true);
    if (process.env.NO_COLOR) assert.equal(caps.colorEnabled, false);
  });
});

describe("process supervisor", () => {
  it("captures stdout/stderr/exit codes", async () => {
    const r = await execFile(process.execPath, ["-e", "console.log('out'); console.error('err')"]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /out/);
    assert.match(r.stderr, /err/);
    assert.equal(r.timedOut, false);
  });

  it("enforces timeouts and reports them honestly (#0170)", async () => {
    const r = await execFile(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { timeoutMs: 400 });
    assert.equal(r.timedOut, true);
    assert.notEqual(r.signal, null);
  });

  it("truncates oversized output at the cap", async () => {
    const r = await execFile(process.execPath, ["-e", "for(let i=0;i<100000;i++) console.log('x'.repeat(80))"], { maxOutputBytes: 4096 });
    assert.equal(r.truncated, true);
    assert.ok(Buffer.byteLength(r.stdout) < 8192);
  });

  it("propagates cancellation", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    const r = await execFile(process.execPath, ["-e", "setInterval(()=>{},50)"], { signal: ac.signal });
    assert.ok(r.signal !== null || r.code !== 0);
  });

  it("cleanEnv strips secrets from child environment", async () => {
    process.env.QOFENO_TEST_SECRET = "supersecret123";
    const r = await execFile(process.execPath, ["-e", "console.log(JSON.stringify(process.env))"], { cleanEnv: true });
    const env = JSON.parse(r.stdout.trim()) as Record<string, string>;
    assert.equal(env.QOFENO_TEST_SECRET, undefined);
    assert.ok(env.PATH !== undefined);
    delete process.env.QOFENO_TEST_SECRET;
    void childEnv;
  });

  it("shell execution runs through the user shell", async () => {
    const r = await execShell("echo hello-shell");
    assert.equal(r.code, 0);
    assert.match(r.stdout, /hello-shell/);
  });

  it("missing binaries fail with a helpful error", async () => {
    await assert.rejects(execFile("qofeno-definitely-not-a-binary-xyz", []), /cannot execute|Could not run/i);
  });
});

describe("elevation detection", () => {
  it("returns a boolean without throwing on any platform", () => {
    assert.equal(typeof isElevated(), "boolean");
  });
});
