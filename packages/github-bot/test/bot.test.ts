import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateKeyPairSync, createHmac, createVerify } from "node:crypto";
import {
  appJwt,
  verifyWebhookSignature,
  parseBotCommand,
  renderSummaryComment,
  renderChecklistComment,
  installationToken,
} from "../src/bot.js";

describe("github bot (#0112-#0114)", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  it("mints a structurally valid RS256 app jwt", () => {
    const token = appJwt({ appId: "12345", privateKeyPem: pem, webhookSecret: "s" });
    const parts = token.split(".");
    assert.equal(parts.length, 3);
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64").toString());
    assert.equal(payload.iss, "12345");
    assert.ok(payload.exp > payload.iat);
    // Signature verifies with the public key
    const v = createVerify("RSA-SHA256");
    v.update(`${parts[0]}.${parts[1]}`);
    assert.equal(v.verify(publicKey, Buffer.from(parts[2]!, "base64")), true);
  });

  it("verifies webhook signatures and rejects forgeries", () => {
    const secret = "whsec";
    const body = JSON.stringify({ zen: "Design for failure." });
    const good = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
    assert.equal(verifyWebhookSignature(secret, body, good), true);
    assert.equal(verifyWebhookSignature(secret, body, "sha256=deadbeef"), false);
    assert.equal(verifyWebhookSignature("other", body, good), false);
    assert.equal(verifyWebhookSignature(secret, body + " ", good), false);
  });

  it("parses /qofeno commands only", () => {
    assert.deepEqual(parseBotCommand("/qofeno summarize"), { command: "summarize", argsText: "" });
    assert.deepEqual(parseBotCommand("/qofeno checklist please"), { command: "checklist", argsText: "please" });
    assert.equal(parseBotCommand("looks great!"), null);
    assert.equal(parseBotCommand(undefined), null);
  });

  it("renders honest summary/checklist comments", () => {
    const c = renderSummaryComment("Big refactor", 900, 40, 12);
    assert.match(c, /\*\*high\*\*/);
    assert.doesNotMatch(c, /ghp_[A-Za-z0-9]+/);
    assert.match(renderChecklistComment(), /Tests added\/updated/);
  });

  it("exchanges installation tokens via the API", async () => {
    let called = "";
    const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
      called = String(url);
      return new Response(JSON.stringify({ token: "ghs_test" }), { status: 201, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    const t = await installationToken({ appId: "1", privateKeyPem: pem, webhookSecret: "s", apiBase: "https://api.example.test" }, 42, fakeFetch);
    assert.equal(t, "ghs_test");
    assert.ok(called.includes("/app/installations/42/access_tokens"));
  });
});
