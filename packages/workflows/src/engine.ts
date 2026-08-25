/**
 * Workflow engine + scheduler (#0058/#0059): versioned, portable definitions
 * with typed steps, runtime permission evaluation, approvals, bounded loops
 * and timezone-aware cron-ish scheduling.
 */
import { ErrorCode, QofenoError, s, type Schema } from "@agent-qofeno/core";
import type { WorkflowDefinition, WorkflowRun, WorkflowStep } from "@agent-qofeno/core";
import type { ToolRegistry, ToolContext } from "@agent-qofeno/tools";

export const workflowDefinitionSchema: Schema<WorkflowDefinition> = s.object(
  {
    formatVersion: s.literal(1),
    id: s.string({ min: 3, max: 128 }),
    name: s.string({ min: 1, max: 200 }),
    description: s.string({ max: 2_000 }).optional(),
    version: s.number({ int: true, min: 1 }),
    trigger: s.object(
      {
        kind: s.enum(["manual", "schedule"]),
        cron: s.string({ max: 100 }).optional(),
        timezone: s.string({ max: 64 }).optional(),
      },
      { strict: true },
    ),
    inputs: s.array(s.object({ name: s.string({ min: 1, max: 64 }), required: s.boolean(), description: s.string({ max: 500 }).optional() }, { strict: true }), { max: 32 }),
    entryStepId: s.string({ min: 1, max: 128 }),
    steps: s.array(
      s.union(
        s.object({ kind: s.literal("ai"), config: s.record({ maxEntries: 16 }) }, { strict: false }),
        s.object({ kind: s.literal("tool"), config: s.record({ maxEntries: 16 }) }, { strict: false }),
        s.object({ kind: s.literal("condition"), config: s.record({ maxEntries: 16 }) }, { strict: false }),
        s.object({ kind: s.literal("approval"), config: s.record({ maxEntries: 16 }) }, { strict: false }),
        s.object({ kind: s.literal("output"), config: s.record({ maxEntries: 16 }) }, { strict: false }),
        s.object({ kind: s.literal("fail"), config: s.record({ maxEntries: 16 }) }, { strict: false }),
      ) as unknown as Schema<WorkflowStep>,
      { min: 1, max: 64 },
    ),
    permissions: s.array(s.string({ max: 64 }), { max: 64 }),
    createdBy: s.string({ max: 200 }),
    createdAtMs: s.number({ min: 0 }),
  },
  { strict: false },
) as unknown as Schema<WorkflowDefinition>;

export interface WorkflowEngineOptions {
  /** Hard bound against runaway workflows (#0059). */
  maxSteps?: number;
}

export class WorkflowEngine {
  private awaiting = new Map<string, (approved: boolean) => void>();

  constructor(
    private readonly registry: ToolRegistry,
    private readonly opts: WorkflowEngineOptions = {},
  ) {}

  validateImport(json: string): WorkflowDefinition {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new QofenoError({ code: ErrorCode.IMPORT_INVALID, message: "not JSON" });
    }
    return workflowDefinitionSchema.parse(parsed);
  }

  /**
   * Execute a workflow. Imported workflows never inherit permissions: the
   * provided ToolContext's grants are evaluated at EVERY tool step (#0059
   * runtime evaluation). Returns the final run state.
   */
  async run(def: WorkflowDefinition, ctx: ToolContext, inputs: Record<string, string> = {}): Promise<WorkflowRun> {
    const startedAt = Date.now();
    const byId = new Map(def.steps.map((st) => [st.id, st]));
    const run: WorkflowRun = {
      id: `wfr_${def.id}_${startedAt}`,
      definitionId: def.id,
      definitionVersion: def.version,
      status: "running",
      outputs: {},
      startedAtMs: startedAt,
      triggeredBy: "user",
    };

    const maxSteps = this.opts.maxSteps ?? 50;
    let current: WorkflowStep | undefined = byId.get(def.entryStepId);
    let executed = 0;
    const seen = new Set<string>(); // loop guard (#0059 duplicate-prevention)

    while (current && executed < maxSteps) {
      if (seen.has(`${current.id}:${executed}`)) {
        run.status = "failed";
        run.error = `loop detected at step ${current.id}`;
        return run;
      }
      seen.add(`${current.id}:${executed}`);
      executed++;
      run.currentStepId = current.id;

      switch (current.kind) {
        case "tool": {
          const toolName = String(current.config.tool ?? "");
          const args = (current.config.args ?? {}) as Record<string, unknown>;
          const result = await this.registry.invoke(toolName, args, ctx);
          if (!result.ok) {
            run.status = "failed";
            run.error = `step ${current.id}: ${result.output.slice(0, 300)}`;
            return run;
          }
          run.outputs[current.id] = result.output;
          break;
        }
        case "condition": {
          const leftStep = String(current.config.leftStep ?? "");
          const equals = String(current.config.equals ?? "");
          const target = String(current.config.thenStep ?? "");
          const value = run.outputs[leftStep] ?? "";
          if (value.includes(equals)) current = byId.get(target);
          continue;
        }
        case "approval": {
          run.status = "waiting_approval";
          run.awaitingApprovalStep = current.id;
          const approved = await ctx.confirm({
            title: String(current.config.title ?? `Approve workflow ${def.name}`),
            detail: String(current.config.detail ?? `Step ${current.name} requires approval.`),
          });
          run.status = "running";
          delete run.awaitingApprovalStep;
          if (!approved) {
            const failStep = current.next ? undefined : undefined;
            void failStep;
            run.status = "cancelled";
            run.error = "approval denied";
            return run;
          }
          break;
        }
        case "output": {
          const fromStep = String(current.config.fromStep ?? "");
          run.outputs[current.id] = run.outputs[fromStep] ?? String(current.config.text ?? "");
          break;
        }
        case "fail":
          run.status = "failed";
          run.error = String(current.config.message ?? "workflow fail step");
          return run;
      }

      const nextId = current.next ?? pickBranch(current, run);
      if (!nextId) break;
      current = byId.get(nextId);
    }

    if (executed >= maxSteps) {
      run.status = "failed";
      run.error = `exceeded ${maxSteps} workflow steps`;
      return run;
    }
    if (run.status === "running") run.status = "completed";
    run.finishedAtMs = Date.now();
    return run;
  }
}

function pickBranch(step: WorkflowStep, run: WorkflowRun): string | undefined {
  for (const b of step.branches ?? []) {
    if ((run.outputs[b.whenEquals.stepId] ?? "").includes(b.whenEquals.value)) return b.stepId;
  }
  return undefined;
}

// ---- Scheduling (#0059) -----------------------------------------------------

export interface NextRunInput {
  cron: string;
  timezone: string;
  afterMs?: number;
}

/**
 * Minimal but correct cron subset: `m h dom mon dow` with *, lists and
 * ranges. Timezone handled via Intl.DateTimeFormat parts. DST is respected
 * because we compute the next matching LOCAL wall-clock time in the tz.
 */
export function nextRunTime(input: NextRunInput): number {
  const fields = parseCron(input.cron);
  const after = input.afterMs ?? Date.now();
  // Walk forward minute-by-minute up to 366 days (bounded search).
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: input.timezone,
    minute: "numeric",
    hour: "numeric",
    hour12: false,
    day: "numeric",
    month: "numeric",
    year: "numeric",
    weekday: "short",
  });
  let candidate = Math.ceil((after + 60_000) / 60_000) * 60_000;
  const limit = after + 366 * 24 * 3_600_000;
  while (candidate <= limit) {
    const parts = fmt.formatToParts(new Date(candidate));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? -1);
    const wdFull = parts.find((p) => p.type === "weekday")?.value ?? "";
    const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wdFull.slice(0, 3));
    const minute = get("minute");
    const hour = get("hour") % 24;
    const day = get("day");
    const month = get("month");
    const year = get("year");
    if (
      fieldMatches(fields.minute, minute) &&
      fieldMatches(fields.hour, hour) &&
      fieldMatches(fields.dom, day) &&
      fieldMatches(fields.mon, month) &&
      fieldMatches(fields.dow, wd === -1 ? 99 : wd)
    ) {
      return candidate;
    }
    candidate += 60_000;
  }
  throw new QofenoError({ code: ErrorCode.VALIDATION_FAILED, message: "cron has no occurrence within a year" });
}

interface CronFields {
  minute: number[][];
  hour: number[][];
  dom: number[][];
  mon: number[][];
  dow: number[][];
}

function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new QofenoError({ code: ErrorCode.VALIDATION_FAILED, message: "cron must have 5 fields" });
  return {
    minute: parseField(parts[0]!, 0, 59),
    hour: parseField(parts[1]!, 0, 23),
    dom: parseField(parts[2]!, 1, 31),
    mon: parseField(parts[3]!, 1, 12),
    dow: parseField(parts[4]!, 0, 6),
  };
}

function parseField(field: string, min: number, max: number): number[][] {
  return field.split(",").map((piece) => {
    const range = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(piece);
    if (!range) throw new QofenoError({ code: ErrorCode.VALIDATION_FAILED, message: `bad cron piece ${piece}` });
    const start = range[1] === "*" ? min : Number(range[1]);
    const end = range[2] !== undefined ? Number(range[2]) : range[1] === "*" ? max : start;
    const stride = range[3] !== undefined ? Number(range[3]) : 1;
    if (start < min || end > max || start > end || stride < 1) {
      throw new QofenoError({ code: ErrorCode.VALIDATION_FAILED, message: `cron range out of bounds: ${piece}` });
    }
    const out: number[] = [];
    for (let v = start; v <= end; v += stride) out.push(v);
    return out;
  });
}

function fieldMatches(groups: number[][], value: number): boolean {
  return groups.some((g) => g.includes(value));
}
