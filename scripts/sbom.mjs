#!/usr/bin/env node
// CycloneDX 1.5 SBOM over the workspace manifest graph (no third-party deps).
import { readFileSync, readdirSync, existsSync } from "node:fs";

const components = [];
for (const dir of ["", ...readdirSync("packages"), "apps/app"]) {
  const p = dir ? `${dir}/package.json` : "package.json";
  if (!existsSync(p)) continue;
  const j = JSON.parse(readFileSync(p, "utf8"));
  components.push({
    type: "library",
    "bom-ref": `${j.name ?? "qofeno-root"}@${j.version ?? "0.0.0"}`,
    name: j.name ?? "qofeno-root",
    version: j.version ?? "0.0.0",
    licenses: [{ license: { id: j.license ?? "Apache-2.0" } }],
    properties: Object.entries(j.dependencies ?? {}).map(([k, v]) => ({ name: `dep:${k}`, value: String(v) })),
  });
}
process.stdout.write(
  JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.5", serialNumber: `urn:uuid:${crypto.randomUUID()}`, components }, null, 2),
);
