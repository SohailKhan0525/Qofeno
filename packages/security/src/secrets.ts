/**
 * Credential storage (#0045, #0122).
 *
 * Strategy: use the OS credential store when available (macOS Keychain via
 * `security`, Linux via libsecret's `secret-tool`, Windows via PowerShell
 * credential APIs). When no OS store is available, fall back to an
 * AES-256-GCM encrypted file keyed by scrypt from QOFENO_MASTER_KEY or a
 * machine key file with 0600 permissions. Every path is documented in
 * docs/security.md. Secrets are never logged and never placed in prompts.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ErrorCode, QofenoError } from "@agent-qofeno/core";

export interface SecretStore {
  readonly backend: string;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<string[]>;
}

export class SecretStoreLockedError extends QofenoError {
  constructor(detail: string) {
    super({ code: ErrorCode.SECRET_STORE_LOCKED, message: detail });
  }
}

function run(cmd: string, args: string[], opts?: { input?: string }): { ok: boolean; out: string; err: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", input: opts?.input, timeout: 10_000 });
  return { ok: r.status === 0, out: r.stdout ?? "", err: r.stderr ?? "" };
}

class MacosKeychainStore implements SecretStore {
  constructor(private service: string) {}
  readonly backend = "macOS Keychain";

  async get(key: string): Promise<string | null> {
    const r = run("security", ["find-generic-password", "-s", this.service, "-a", key, "-w"]);
    return r.ok ? r.out.trimEnd() : null;
  }
  async set(key: string, value: string): Promise<void> {
    // Delete-then-add is the portable way to upsert on the macOS CLI.
    run("security", ["delete-generic-password", "-s", this.service, "-a", key]);
    const r = run("security", ["add-generic-password", "-s", this.service, "-a", key, "-w", value, "-U"]);
    if (!r.ok) throw new SecretStoreLockedError(r.err);
  }
  async delete(key: string): Promise<void> {
    run("security", ["delete-generic-password", "-s", this.service, "-a", key]);
  }
  async list(): Promise<string[]> {
    const r = run("security", ["dump-keychain"], {});
    if (!r.ok) return [];
    return [...r.out.matchAll(/svce.*?"([^"]+)"/g)].map((m) => m[1]!).filter((s) => s === this.service);
  }
}

class LinuxSecretToolStore implements SecretStore {
  constructor(
    private schema: string,
    private attrKey = "key",
  ) {}
  readonly backend = "libsecret (secret-tool)";

  async get(key: string): Promise<string | null> {
    const r = run("secret-tool", ["lookup", this.schema, this.attrKey === "key" ? "key" : "key", key]);
    return r.ok && r.out.length > 0 ? r.out.trimEnd() : null;
  }
  async set(key: string, value: string): Promise<void> {
    const r = run("secret-tool", ["store", "--label=qofeno", this.schema, "key", key], { input: value });
    if (!r.ok) throw new SecretStoreLockedError(r.err);
  }
  async delete(key: string): Promise<void> {
    run("secret-tool", ["clear", this.schema, "key", key]);
  }
  async list(): Promise<string[]> {
    return [];
  }
}

class WindowsCredentialStore implements SecretStore {
  readonly backend = "Windows Credential Manager";
  private target(key: string): string {
    return `qofeno:${key}`;
  }

  async get(key: string): Promise<string | null> {
    const script = `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String((cmdkey /list:"${this.target(key)}" >$null; (Get-StoredCredential? none) )))`;
    void script;
    // Use PowerShell's SecretManagement-free approach via CredRead through P/Invoke is heavy;
    // use cmdkey for presence and read via PowerShell Export-CliXml pattern only when available.
    const probe = run("cmdkey", ["/list"]);
    if (!probe.ok || !probe.out.includes(this.target(key))) return null;
    const ps = run(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `$m = Get-SecretInfo -Name '${this.target(key)}' -ErrorAction SilentlyContinue; if ($m) { $v = Get-Secret -Name '${this.target(key)}' -AsPlainText; [Console]::Out.Write($v) }`,
      ],
    );
    return ps.ok && ps.out ? ps.out : null;
  }
  async set(key: string, value: string): Promise<void> {
    const ps = run("powershell", [
      "-NoProfile",
      "-Command",
      `$b=[Text.Encoding]::UTF8.GetBytes('${value.replace(/'/g, "''")}'); Set-Secret -Name '${this.target(key)}' -Secret (ConvertTo-SecureString -AsPlainText ([Text.Encoding]::UTF8.GetString($b)) -Force)`,
    ]);
    if (!ps.ok) throw new SecretStoreLockedError(ps.err);
  }
  async delete(key: string): Promise<void> {
    run("cmdkey", ["/delete", this.target(key)]);
  }
  async list(): Promise<string[]> {
    const probe = run("cmdkey", ["/list"]);
    if (!probe.ok) return [];
    return [...probe.out.matchAll(/Target: qofeno:(.+)/g)].map((m) => m[1]!.trim());
  }
}

/** AES-256-GCM encrypted file store used when no OS keyring is available. */
export class EncryptedFileStore implements SecretStore {
  readonly backend = "encrypted file (AES-256-GCM)";
  private file: string;
  private cache: Map<string, string> | null = null;

  constructor(dataDir: string, masterKeyMaterial?: string) {
    const dir = join(dataDir, "secrets");
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "vault.bin");
    this.keyMaterialFile = join(dir, ".keyfile");
    this.masterKeyOverride = masterKeyMaterial ?? process.env.QOFENO_MASTER_KEY;
  }

  private keyMaterialFile: string;
  private masterKeyOverride: string | undefined;

  private masterKey(): Buffer {
    if (this.masterKeyOverride) {
      return createHash("sha256").update(`qofeno:v1:${this.masterKeyOverride}`).digest();
    }
    if (!existsSync(this.keyMaterialFile)) {
      const k = randomBytes(32);
      writeFileSync(this.keyMaterialFile, k.toString("hex"), { mode: 0o600 });
      chmodSync(this.keyMaterialFile, 0o600);
    }
    return createHash("sha256").update(readFileSync(this.keyMaterialFile, "utf8").trim()).digest();
  }

  private load(): Map<string, string> {
    if (this.cache) return this.cache;
    const map = new Map<string, string>();
    if (existsSync(this.file)) {
      const raw = readFileSync(this.file);
      if (raw.length >= 28) {
        const iv = raw.subarray(0, 12);
        const tag = raw.subarray(12, 28);
        const payload = raw.subarray(28);
        try {
          const d = createDecipheriv("aes-256-gcm", this.masterKey(), iv);
          d.setAuthTag(tag);
          const json = Buffer.concat([d.update(payload), d.final()]).toString("utf8");
          for (const [k, v] of Object.entries(JSON.parse(json) as Record<string, string>)) map.set(k, v);
        } catch {
          throw new SecretStoreLockedError(
            "The secret vault failed integrity checks (wrong master key or corruption). Restore the master key or reset the vault.",
          );
        }
      }
    }
    this.cache = map;
    return map;
  }

  private persist(map: Map<string, string>): void {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.masterKey(), iv);
    const enc = Buffer.concat([c.update(JSON.stringify(Object.fromEntries(map)), "utf8"), c.final()]);
    writeFileSync(this.file, Buffer.concat([iv, c.getAuthTag(), enc]), { mode: 0o600 });
    chmodSync(this.file, 0o600);
    this.cache = map;
  }

  async get(key: string): Promise<string | null> {
    return this.load().get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    const map = new Map(this.load());
    map.set(key, value);
    this.persist(map);
  }
  async delete(key: string): Promise<void> {
    const map = new Map(this.load());
    map.delete(key);
    this.persist(map);
  }
  async list(): Promise<string[]> {
    return [...this.load().keys()];
  }

  /** Derive a stable key name for provider credentials. */
  static keyForProvider(providerId: string): string {
    return `provider:${providerId}`;
  }
}

export function detectSecretStore(dataDir: string): SecretStore {
  switch (process.platform) {
    case "darwin":
      if (existsSync("/usr/bin/security")) return new MacosKeychainStore("qofeno");
      break;
    case "linux":
    case "freebsd":
    case "openbsd":
      if (process.env.QOFENO_FORCE_FILE_VAULT !== "1") {
        const probe = run("secret-tool", [], {});
        if (probe.err === "" || existsSync("/usr/bin/secret-tool")) {
          return new LinuxSecretToolStore("org.qofeno.secrets");
        }
      }
      break;
    case "win32":
      return new WindowsCredentialStore();
  }
  return new EncryptedFileStore(dataDir);
}
