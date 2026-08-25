/**
 * Dependency-free schema validation enforced at every trust boundary:
 * CLI args, tool arguments, extension messages, workflow definitions,
 * provider structured output, imported data.
 */
import type { ErrorIssue } from "./errors.js";
import { ErrorCode, QofenoError } from "./errors.js";

export interface ValidationIssue {
  path: string;
  message: string;
}

export abstract class Schema<T> {
  parse(value: unknown, maxDepth = 64): T {
    const issues: ValidationIssue[] = [];
    const out = this.safeParse(value, "$", issues, maxDepth);
    if (!out.ok) {
      throw new QofenoError({
        code: ErrorCode.VALIDATION_FAILED,
        message: `validation failed: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
        issues: issues as ErrorIssue[],
      });
    }
    return out.value;
  }

  safeParse(
    value: unknown,
    path: string,
    issues: ValidationIssue[],
    maxDepth: number,
  ): { ok: true; value: T } | { ok: false } {
    if (maxDepth <= 0) {
      issues.push({ path, message: "nested too deeply" });
      return { ok: false };
    }
    return this._parse(value, path, issues, maxDepth);
  }

  optional(): OptionalSchema<T> {
    return new OptionalSchema(this);
  }

  protected abstract _parse(
    value: unknown,
    path: string,
    issues: ValidationIssue[],
    maxDepth: number,
  ): { ok: true; value: T } | { ok: false };

  abstract describe(): JsonSchemaDescriptor;

  static literal<V extends string | number | boolean>(value: V): Schema<V> {
    return new LiteralSchema(value);
  }
}

export interface JsonSchemaDescriptor {
  type: "string" | "number" | "boolean" | "array" | "object";
  description?: string;
  enum?: unknown[];
  items?: JsonSchemaDescriptor;
  properties?: Record<string, JsonSchemaDescriptor>;
  required?: string[];
  additionalProperties?: boolean;
  minimum?: number;
  maximum?: number;
}

export class LiteralSchema<V extends string | number | boolean> extends Schema<V> {
  constructor(private value: V) {
    super();
  }
  protected _parse(v: unknown, path: string, issues: ValidationIssue[]) {
    if (v === this.value) return { ok: true as const, value: this.value };
    issues.push({ path, message: `must be ${JSON.stringify(this.value)}` });
    return { ok: false as const };
  }
  describe(): JsonSchemaDescriptor {
    const t = typeof this.value;
    if (t === "string") return { type: "string", enum: [this.value] };
    if (t === "number") return { type: "number", enum: [this.value] };
    return { type: "boolean", enum: [this.value] };
  }
}

export declare const __optionalBrand: unique symbol;

/** Branded wrapper marking a field as optional in ParsedShape inference. */
export class OptionalSchema<T> extends Schema<T | undefined> {
  declare readonly __optionalBrand: typeof __optionalBrand;
  constructor(private inner: Schema<T>) {
    super();
  }
  protected _parse(value: unknown, path: string, issues: ValidationIssue[], maxDepth: number) {
    if (value === undefined) return { ok: true as const, value: undefined };
    return this.inner.safeParse(value, path, issues, maxDepth);
  }
  describe(): JsonSchemaDescriptor {
    return this.inner.describe();
  }
}

export class StringSchema extends Schema<string> {
  constructor(private opts: { min?: number; max?: number; pattern?: RegExp; description?: string } = {}) {
    super();
  }
  protected _parse(v: unknown, path: string, issues: ValidationIssue[]) {
    if (typeof v !== "string") {
      issues.push({ path, message: "must be a string" });
      return { ok: false as const };
    }
    const o = this.opts;
    if (o.min !== undefined && v.length < o.min) {
      issues.push({ path, message: `must be at least ${o.min} characters` });
      return { ok: false as const };
    }
    if (o.max !== undefined && v.length > o.max) {
      issues.push({ path, message: `must be at most ${o.max} characters` });
      return { ok: false as const };
    }
    if (o.pattern && !o.pattern.test(v)) {
      issues.push({ path, message: "invalid format" });
      return { ok: false as const };
    }
    return { ok: true as const, value: v };
  }
  describe(): JsonSchemaDescriptor {
    return { type: "string", description: this.opts.description };
  }
}

export class NumberSchema extends Schema<number> {
  constructor(private opts: { min?: number; max?: number; int?: boolean; description?: string } = {}) {
    super();
  }
  protected _parse(v: unknown, path: string, issues: ValidationIssue[]) {
    if (typeof v !== "number" || Number.isNaN(v)) {
      issues.push({ path, message: "must be a number" });
      return { ok: false as const };
    }
    const o = this.opts;
    if (o.int && !Number.isInteger(v)) {
      issues.push({ path, message: "must be an integer" });
      return { ok: false as const };
    }
    if (o.min !== undefined && v < o.min) {
      issues.push({ path, message: `must be >= ${o.min}` });
      return { ok: false as const };
    }
    if (o.max !== undefined && v > o.max) {
      issues.push({ path, message: `must be <= ${o.max}` });
      return { ok: false as const };
    }
    return { ok: true as const, value: v };
  }
  describe(): JsonSchemaDescriptor {
    return { type: "number", description: this.opts.description };
  }
}

export class BooleanSchema extends Schema<boolean> {
  protected _parse(v: unknown, path: string, issues: ValidationIssue[]) {
    if (typeof v !== "boolean") {
      issues.push({ path, message: "must be a boolean" });
      return { ok: false as const };
    }
    return { ok: true as const, value: v };
  }
  describe(): JsonSchemaDescriptor {
    return { type: "boolean" };
  }
}

export class EnumSchema<V extends string> extends Schema<V> {
  constructor(private values: readonly V[]) {
    super();
  }
  protected _parse(v: unknown, path: string, issues: ValidationIssue[]) {
    if (typeof v === "string" && (this.values as readonly string[]).includes(v)) {
      return { ok: true as const, value: v as V };
    }
    issues.push({ path, message: `must be one of: ${this.values.join(", ")}` });
    return { ok: false as const };
  }
  describe(): JsonSchemaDescriptor {
    return { type: "string", enum: [...this.values] };
  }
}

export class ArraySchema<T> extends Schema<T[]> {
  constructor(
    private item: Schema<T>,
    private opts: { min?: number; max?: number; description?: string } = {},
  ) {
    super();
  }
  protected _parse(v: unknown, path: string, issues: ValidationIssue[], maxDepth: number) {
    if (!Array.isArray(v)) {
      issues.push({ path, message: "must be an array" });
      return { ok: false as const };
    }
    if (this.opts.max !== undefined && v.length > this.opts.max) {
      issues.push({ path, message: `at most ${this.opts.max} items` });
      return { ok: false as const };
    }
    if (this.opts.min !== undefined && v.length < this.opts.min) {
      issues.push({ path, message: `at least ${this.opts.min} items` });
      return { ok: false as const };
    }
    const out: T[] = [];
    let bad = false;
    for (let i = 0; i < v.length; i++) {
      const r = this.item.safeParse(v[i], `${path}[${i}]`, issues, maxDepth - 1);
      if (!r.ok) bad = true;
      else out.push(r.value);
    }
    return bad ? { ok: false as const } : { ok: true as const, value: out };
  }
  describe(): JsonSchemaDescriptor {
    return { type: "array", items: this.item.describe(), description: this.opts.description };
  }
}

export type ObjectShape = Record<string, Schema<unknown>>;

/** Required keys keep their value type; OptionalSchema fields become `?:`. */
export type ParsedShape<O extends ObjectShape> = {
  [K in keyof O]: O[K] extends Schema<infer U> ? U : never;
};

/** Extract the parsed output type from a schema's static type. */
export type SchemaOutput<S> = S extends Schema<infer T> ? T : never;

export class ObjectSchema<O extends ObjectShape> extends Schema<ParsedShape<O>> {
  constructor(
    private fields: O,
    private opts: { strict?: boolean; description?: string } = {},
  ) {
    super();
  }
  protected _parse(v: unknown, path: string, issues: ValidationIssue[], maxDepth: number) {
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      issues.push({ path, message: "must be an object" });
      return { ok: false as const };
    }
    const rec = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    let bad = false;
    for (const [key, schema] of Object.entries(this.fields)) {
      const present = key in rec && rec[key] !== undefined;
      const r = schema.safeParse(present ? rec[key] : undefined, `${path}.${key}`, issues, maxDepth - 1);
      if (!r.ok) bad = true;
      else if (present || r.value !== undefined) out[key] = r.value;
    }
    if (this.opts.strict) {
      const allowed = new Set(Object.keys(this.fields));
      for (const key of Object.keys(rec)) {
        if (!allowed.has(key)) {
          issues.push({ path: `${path}.${key}`, message: "unexpected property" });
          bad = true;
        }
      }
    }
    if (bad) return { ok: false as const };
    return { ok: true as const, value: out as ParsedShape<O> };
  }
  describe(): JsonSchemaDescriptor {
    const properties: Record<string, JsonSchemaDescriptor> = {};
    const required: string[] = [];
    for (const [k, sch] of Object.entries(this.fields)) {
      properties[k] = sch.describe();
      required.push(k);
    }
    return {
      type: "object",
      properties,
      required,
      additionalProperties: this.opts.strict !== true,
      description: this.opts.description,
    };
  }
}

export class RecordSchema extends Schema<Record<string, string>> {
  constructor(private opts: { maxEntries?: number; description?: string } = {}) {
    super();
  }
  protected _parse(v: unknown, path: string, issues: ValidationIssue[]) {
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      issues.push({ path, message: "must be an object" });
      return { ok: false as const };
    }
    const entries = Object.entries(v as Record<string, unknown>);
    if (this.opts.maxEntries !== undefined && entries.length > this.opts.maxEntries) {
      issues.push({ path, message: "too many entries" });
      return { ok: false as const };
    }
    const out: Record<string, string> = {};
    let bad = false;
    for (const [k, val] of entries) {
      if (typeof val !== "string") {
        issues.push({ path: `${path}.${k}`, message: "must be a string" });
        bad = true;
      } else out[k] = val;
    }
    return bad ? { ok: false as const } : { ok: true as const, value: out };
  }
  describe(): JsonSchemaDescriptor {
    return { type: "object", additionalProperties: { type: "string" } as never, description: this.opts.description };
  }
}

export class UnionSchema<T> extends Schema<T> {
  constructor(private members: Schema<T>[]) {
    super();
  }
  protected _parse(v: unknown, path: string, issues: ValidationIssue[], maxDepth: number) {
    for (const m of this.members) {
      const localIssues: ValidationIssue[] = [];
      const r = m.safeParse(v, path, localIssues, maxDepth - 1);
      if (r.ok) return r;
    }
    issues.push({ path, message: "did not match any allowed shape" });
    return { ok: false as const };
  }
  describe(): JsonSchemaDescriptor {
    return this.members[0]?.describe() ?? { type: "string" };
  }
}

export const s = {
  literal: <V extends string | number | boolean>(value: V) => Schema.literal(value),
  string: (opts?: ConstructorParameters<typeof StringSchema>[0]) => new StringSchema(opts),
  number: (opts?: ConstructorParameters<typeof NumberSchema>[0]) => new NumberSchema(opts),
  boolean: () => new BooleanSchema(),
  enum: <V extends string>(values: readonly V[]) => new EnumSchema(values),
  array: <T>(item: Schema<T>, opts?: ConstructorParameters<typeof ArraySchema<T>>[1]) =>
    new ArraySchema(item, opts),
  object: <O extends ObjectShape>(fields: O, opts?: { strict?: boolean; description?: string }) =>
    new ObjectSchema(fields, opts),
  record: (opts?: ConstructorParameters<typeof RecordSchema>[0]) => new RecordSchema(opts),
  union: <S extends Schema<unknown>[]>(
    ...members: S
  ) =>
    new UnionSchema<S[number] extends Schema<infer U> ? U : never>(
      members as Schema<S[number] extends Schema<infer U> ? U : never>[],
    ),
};
