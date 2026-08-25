import { startBot } from "./bot.js";

const appId = process.env.QOFENO_GH_APP_ID;
const key = process.env.QOFENO_GH_PRIVATE_KEY?.replace(/\\n/g, "\n");
const secret = process.env.QOFENO_GH_WEBHOOK_SECRET;

if (!appId || !key || !secret) {
  console.error(
    "qofeno-bot requires QOFENO_GH_APP_ID, QOFENO_GH_PRIVATE_KEY (PEM) and QOFENO_GH_WEBHOOK_SECRET.\n" +
      "Create a GitHub App at https://github.com/settings/apps/new with minimum permissions:\n" +
      "  contents:read, issues:write, pull_requests:write; subscribe to issue_comment.",
  );
  process.exit(21);
}

await startBot({ appId, privateKeyPem: key, webhookSecret: secret, port: Number(process.env.QOFENO_GH_PORT ?? 7932) });
console.log(`qofeno-bot listening on :${Number(process.env.QOFENO_GH_PORT ?? 7932)}/webhook`);
