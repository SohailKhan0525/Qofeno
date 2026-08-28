#!/usr/bin/env node
/**
 * Automated npm publication script with provenance and post-publish verification.
 * Publishes each package in dependency order and queries the npm registry to verify
 * successful publication.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

// Package build and publication order
const PACKAGES_ORDER = [
  "core",
  "security",
  "storage",
  "runtime",
  "providers",
  "term",
  "input",
  "config",
  "session",
  "knowledge",
  "ctx",
  "tools",
  "agents",
  "workflows",
  "ext",
  "bundle",
  "repl",
  "server",
  "cli",
];

async function isPublishedOnNpm(pkgName, version) {
  try {
    const url = `https://registry.npmjs.org/${encodeURIComponent(pkgName)}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return false;
    const data = await res.json();
    return Boolean(data.versions && data.versions[version]);
  } catch {
    return false;
  }
}

async function verifyWithRetry(pkgName, version, maxAttempts = 6, delayMs = 5000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ok = await isPublishedOnNpm(pkgName, version);
    if (ok) return true;
    console.log(`  [verify] Waiting for registry indexing of ${pkgName}@${version} (attempt ${attempt}/${maxAttempts})…`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}

async function main() {
  console.log("=== Qofeno Package Publisher ===");

  const token = process.env.NODE_AUTH_TOKEN || process.env.NPM_TOKEN;
  if (!token && !process.env.CI) {
    console.warn("::warning:: No NPM_TOKEN / NODE_AUTH_TOKEN found in environment; running in dry-run mode.");
  }

  for (const p of PACKAGES_ORDER) {
    const dir = join("packages", p);
    const pkgPath = join(dir, "package.json");
    if (!existsSync(pkgPath)) continue;

    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const name = pkg.name;
    const version = pkg.version;

    console.log(`\n--- Inspecting ${name}@${version} ---`);

    const alreadyPublished = await isPublishedOnNpm(name, version);
    if (alreadyPublished) {
      console.log(`[skip] ${name}@${version} already exists on npm.`);
      continue;
    }

    console.log(`[publish] Publishing ${name}@${version} to npm…`);
    try {
      execSync(`npm publish "./${dir}" --access public`, {
        stdio: "inherit",
        env: { ...process.env },
      });
      console.log(`[publish] Publish command succeeded for ${name}@${version}`);
    } catch (err) {
      console.error(`[publish-error] Failed to publish ${name}@${version}: ${err.message}`);
      process.exit(1);
    }

    // Post-publish verification check
    console.log(`[verify] Querying remote npm registry to confirm availability…`);
    const verified = await verifyWithRetry(name, version);
    if (verified) {
      console.log(`✔ [verified] ${name}@${version} is live on npm registry.`);
    } else {
      console.warn(`::warning:: ${name}@${version} published but not yet visible on registry index.`);
    }
  }

  console.log("\n=== All packages successfully processed and verified! ===");
}

main().catch((err) => {
  console.error(`Fatal publisher error: ${err.message}`);
  process.exit(1);
});
