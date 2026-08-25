/** Domain objects with stable identity, lifecycle and validation helpers. */
import type { DataClassification } from "./classification.js";

export interface MemoryRecord {
  id: string;
  content: string;
  scope: "global" | "project" | "session";
  projectRoot?: string;
  sessionId?: string;
  provenance: "user" | "conversation" | "imported" | "workflow";
  createdAtMs: number;
  expiresAtMs?: number;
  classification: DataClassification;
}

export interface KnowledgeCollection {
  id: string;
  name: string;
  projectRoot?: string;
  classification: DataClassification;
  createdAtMs: number;
}

export interface KnowledgeSource {
  id: string;
  collectionId: string;
  kind: "file" | "text" | "url";
  title: string;
  externalUrl?: string;
  sizeBytes: number;
  sha256: string;
  indexState: "pending" | "indexed" | "failed" | "stale";
  chunkCount: number;
  lastIndexedAtMs?: number;
  indexingError?: string;
}

export interface KnowledgeChunk {
  id: string;
  sourceId: string;
  collectionId: string;
  ordinal: number;
  text: string;
  startChar: number;
  endChar: number;
  /** Optional embedding vector produced by a provider embed() call. */
  embedding?: number[];
}

export interface RetrievedChunk {
  chunk: KnowledgeChunk;
  sourceTitle: string;
  score: number;
  retrieval: "keyword" | "semantic" | "hybrid";
}

// ---- Workflows -----------------------------------------------------------------

export type WorkflowStepKind = "ai" | "tool" | "condition" | "approval" | "output" | "fail";

export interface WorkflowStep {
  id: string;
  kind: WorkflowStepKind;
  name: string;
  config: Record<string, unknown>;
  /** Next step id; condition steps use branches. */
  next?: string;
  branches?: { whenEquals: { stepId: string; value: string }; stepId: string }[];
}

export interface WorkflowTrigger {
  kind: "manual" | "schedule";
  cron?: string;
  timezone?: string;
}

export interface WorkflowDefinition {
  formatVersion: 1;
  id: string;
  name: string;
  description?: string;
  version: number;
  trigger: WorkflowTrigger;
  inputs: { name: string; required: boolean; description?: string }[];
  entryStepId: string;
  steps: WorkflowStep[];
  permissions: string[];
  createdBy: string;
  createdAtMs: number;
}

export interface WorkflowRun {
  id: string;
  definitionId: string;
  definitionVersion: number;
  status: "pending" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled";
  currentStepId?: string;
  outputs: Record<string, string>;
  awaitingApprovalStep?: string;
  error?: string;
  startedAtMs: number;
  finishedAtMs?: number;
  triggeredBy: string;
}

// ---- Agents ----------------------------------------------------------------------

export interface AgentActivity {
  atMs: number;
  summary: string;
}

export interface AgentRun {
  id: string;
  goal: string;
  role?: string;
  status: "running" | "completed" | "failed" | "cancelled" | "waiting_permission";
  stepsTaken: number;
  maxSteps: number;
  activity: AgentActivity[];
  result?: string;
  error?: string;
  startedAtMs: number;
  finishedAtMs?: number;
}

// ---- Extensions / plugins -----------------------------------------------------------

export interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: 1;
  description?: string;
  author?: string;
  /** Declared permission requirements; enforced at the host boundary. */
  permissions: string[];
  /** Entry kinds this extension provides. */
  provides: Array<{
    kind: "command" | "skill" | "hook" | "tool" | "provider" | "subagent";
    ref: string;
    name: string;
  }>;
  mcpServers?: McpServerSpec[];
}

export interface McpServerSpec {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface InstalledExtension {
  manifest: ExtensionManifest;
  installedPath: string;
  enabled: boolean;
  trusted: boolean;
  installedAtMs: number;
}

// ---- Jobs ------------------------------------------------------------------------------

export interface JobRecord {
  id: string;
  kind: "index" | "export" | "import" | "backup" | "workflow-run" | "agent-run";
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  progressDone: number;
  progressTotal: number;
  cancellable: boolean;
  error?: string;
  startedAtMs: number;
}
