import { randomBytes } from "node:crypto";

/** Prefixed, URL-safe, stable identifiers: `<prefix>_<32 hex>`. */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

export const ID = {
  session: "ses",
  message: "msg",
  memory: "mem",
  knowledgeCollection: "knc",
  knowledgeSource: "kns",
  chunk: "chk",
  providerConfig: "prv",
  grant: "grt",
  policyRule: "pol",
  workflow: "wfl",
  workflowRun: "wfr",
  agentRun: "agr",
  extension: "ext",
  audit: "aud",
  job: "job",
  blob: "blb",
  event: "evt",
  device: "dev",
  conflict: "cfl",
} as const;
