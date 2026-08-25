import { s } from "./schema.js";
import type { DataClassification } from "./classification.js";

/**
 * Policy engine independent of any AI prompt. A policy decision is final even
 * when the model requested the action (#18).
 *
 * Precedence (deterministic):
 *   1. deny > confirm > allow
 *   2. more specific condition sets win over broader ones
 *   3. no matching rule => caller-provided default (privileged actions default deny)
 */

export type PolicyEffect = "allow" | "deny" | "confirm";

export interface PolicyConditions {
  tools?: string[];
  permissions?: string[];
  destinations?: string[];
  minClassification?: DataClassification;
  untrustedWorkspaceOnly?: boolean;
}

export interface PolicyRule {
  id: string;
  effect: PolicyEffect;
  description?: string;
  enabled: boolean;
  layer: "built-in" | "user" | "project" | "organization";
  conditions: PolicyConditions;
}

export interface PolicyInput {
  action: string;
  toolId?: string;
  permission?: string;
  classification: DataClassification;
  networkDestination?: string;
  workspaceTrusted: boolean;
  interactive: boolean;
}

export interface PolicyDecision {
  effect: PolicyEffect;
  matchedRuleId: string;
  reason: string;
}

export interface PolicyEngine {
  evaluate(rules: PolicyRule[], input: PolicyInput): Promise<PolicyDecision>;
}

const conditionsSchema = s.object(
  {
    tools: s.array(s.string({ max: 256 }), { max: 256 }).optional(),
    permissions: s.array(s.string({ max: 64 }), { max: 64 }).optional(),
    destinations: s.array(s.string({ max: 253 }), { max: 128 }).optional(),
    minClassification: s.enum(["public", "private", "sensitive", "local-only"]).optional(),
    untrustedWorkspaceOnly: s.boolean().optional(),
  },
  { strict: true },
);

export const policyRuleSchema = s.object(
  {
    id: s.string({ min: 1, max: 128 }),
    effect: s.enum(["allow", "deny", "confirm"]),
    description: s.string({ max: 512 }).optional(),
    enabled: s.boolean(),
    layer: s.enum(["built-in", "user", "project", "organization"]),
    conditions: conditionsSchema,
  },
  { strict: true },
);

function specificity(rule: PolicyRule): number {
  const c = rule.conditions;
  let n = 0;
  if (c.tools?.length) n += 8;
  if (c.permissions?.length) n += 4;
  if (c.destinations?.length) n += 2;
  if (c.minClassification) n += 1;
  if (c.untrustedWorkspaceOnly !== undefined) n += 1;
  return n;
}

function ruleMatches(rule: PolicyRule, input: PolicyInput): boolean {
  const c = rule.conditions;
  if (c.untrustedWorkspaceOnly === true && input.workspaceTrusted) return false;
  if (c.tools && c.tools.length > 0) {
    if (!input.toolId || !c.tools.includes(input.toolId)) return false;
  }
  if (c.permissions && c.permissions.length > 0) {
    if (!input.permission || !c.permissions.includes(input.permission)) return false;
  }
  if (c.destinations && c.destinations.length > 0) {
    if (!input.networkDestination) return false;
    const hit = c.destinations.some((d) =>
      d.startsWith("*.") ? input.networkDestination!.endsWith(d.slice(1)) || input.networkDestination === d.slice(2) : input.networkDestination === d,
    );
    if (!hit) return false;
  }
  if (c.minClassification) {
    const rank = { public: 0, private: 1, sensitive: 2, "local-only": 3 } as const;
    if (rank[input.classification] < rank[c.minClassification]) return false;
  }
  return true;
}

export class RulePolicyEngine implements PolicyEngine {
  constructor(
    private readonly defaultDecision: PolicyDecision = {
      effect: "deny",
      matchedRuleId: "default",
      reason: "No policy allowed this action.",
    },
  ) {}

  async evaluate(rules: PolicyRule[], input: PolicyInput): Promise<PolicyDecision> {
    void this.defaultDecision;
    const matches = rules.filter((r) => r.enabled && ruleMatches(r, input));
    if (matches.length === 0) return this.defaultDecision;
    const effectRank = (e: PolicyEffect) => (e === "deny" ? 3 : e === "confirm" ? 2 : 1);
    let best = matches[0]!;
    for (const m of matches.slice(1)) {
      const ba = effectRank(best.effect);
      const bm = effectRank(m.effect);
      if (bm > ba || (bm === ba && specificity(m) > specificity(best))) best = m;
    }
    return {
      effect: best.effect,
      matchedRuleId: best.id,
      reason: best.description ?? `policy ${best.id}`,
    };
  }
}
