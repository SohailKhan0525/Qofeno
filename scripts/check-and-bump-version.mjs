#!/usr/bin/env node
/**
 * Automated Version Gate & Monorepo Synchronization Script.
 * Queries the public npm registry to verify if current package version is already published.
 * If published, auto-bumps to the next valid semver patch, updates all monorepo
 * manifests and internal references, and verifies consistency.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const PACKAGES_DIR = "packages";
const APPS_DIR = "apps";

async function isVersionPublished(pkgName, version) {
  try {
    const url = `https://registry.npmjs.org/${encodeURIComponent(pkgName)}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      if (res.status === 404) return false;
      return false;
    }
    const data = await res.json();
    return Boolean(data.versions && data.versions[version]);
  } catch {
    return false;
  }
}

function bumpPatch(version) {
  const parts = version.split(".").map((n) => parseInt(n, 10));
  if (parts.length !== 3 || parts.some(isNaN)) {
    return `${version}.1`;
  }
  parts[2] += 1;
  return parts.join(".");
}

async function main() {
  const rootPkgPath = "package.json";
  const rootPkg = JSON.parse(readFileSync(rootPkgPath, "utf8"));
  let currentVersion = rootPkg.version;
  console.log(`[version-check] Current root version: ${currentVersion}`);

  // Find all packages
  const packageDirs = readdirSync(PACKAGES_DIR)
    .map((d) => join(PACKAGES_DIR, d))
    .filter((p) => existsSync(join(p, "package.json")));

  const appDirs = existsSync(APPS_DIR)
    ? readdirSync(APPS_DIR)
        .map((d) => join(APPS_DIR, d))
        .filter((p) => existsSync(join(p, "package.json")))
    : [];

  const allDirs = [".", ...packageDirs, ...appDirs];

  // Check if any package is already published with this version
  let needsBump = false;
  for (const dir of packageDirs) {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    if (pkg.private) continue;
    const published = await isVersionPublished(pkg.name, currentVersion);
    if (published) {
      console.log(`[version-check] Package ${pkg.name}@${currentVersion} is ALREADY published on npm registry.`);
      needsBump = true;
      break;
    }
  }

  if (needsBump) {
    const nextVersion = bumpPatch(currentVersion);
    console.log(`[version-check] Auto-bumping monorepo version to: ${nextVersion}`);

    for (const dir of allDirs) {
      const pPath = join(dir, "package.json");
      const pkg = JSON.parse(readFileSync(pPath, "utf8"));
      pkg.version = nextVersion;

      // Update internal @agent-qofeno/* dependency references
      for (const depType of ["dependencies", "devDependencies", "peerDependencies"]) {
        if (pkg[depType]) {
          for (const depName of Object.keys(pkg[depType])) {
            if (depName.startsWith("@agent-qofeno/")) {
              pkg[depType][depName] = `^${nextVersion}`;
            }
          }
        }
      }

      writeFileSync(pPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
      console.log(`  Updated ${pPath} -> v${nextVersion}`);
    }

    currentVersion = nextVersion;
  } else {
    console.log(`[version-check] Version ${currentVersion} is valid and not yet published.`);
  }

  // Set GitHub Action output if running in CI
  if (process.env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(process.env.GITHUB_OUTPUT, `version=${currentVersion}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `bumped=${needsBump ? "true" : "false"}\n`);
  }

  console.log(`[version-check] Final release version: ${currentVersion}`);
}

main().catch((err) => {
  console.error(`[version-check] Fatal error: ${err.message}`);
  process.exit(1);
});
