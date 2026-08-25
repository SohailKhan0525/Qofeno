/**
 * Central error taxonomy. Every failure crossing a boundary is a QofenoError:
 * machine-readable `code`, user-safe `userMessage` (never contains secrets),
 * and an honest `retryable` flag so retries never duplicate side effects.
 */
export enum ErrorCode {
  VALIDATION_FAILED = "validation_failed",
  PERMISSION_DENIED = "permission_denied",
  POLICY_DENIED = "policy_denied",
  CONFIRMATION_REQUIRED = "confirmation_required",
  NOT_FOUND = "not_found",
  CONFLICT = "conflict",
  CANCELLED = "cancelled",
  TIMEOUT = "timeout",
  QUOTA_EXCEEDED = "quota_exceeded",
  RATE_LIMITED = "rate_limited",
  PROVIDER_UNAVAILABLE = "provider_unavailable",
  PROVIDER_ERROR = "provider_error",
  CAPABILITY_UNSUPPORTED = "capability_unsupported",
  MODEL_UNAVAILABLE = "model_unavailable",
  SECRET_STORE_LOCKED = "secret_store_locked",
  IMPORT_INVALID = "import_invalid",
  BACKUP_INVALID = "backup_invalid",
  EXTENSION_ERROR = "extension_error",
  PLATFORM_UNSUPPORTED = "platform_unsupported",
  AUTH_FAILED = "auth_failed",
  STORAGE_ERROR = "storage_error",
  WORKSPACE_UNTRUSTED = "workspace_untrusted",
  INTERNAL = "internal",
}

export interface ErrorIssue {
  path: string;
  message: string;
}

export class QofenoError extends Error {
  readonly code: ErrorCode;
  readonly userMessage: string;
  readonly retryable: boolean;
  readonly exitCode: number;
  readonly issues?: ErrorIssue[];
  override readonly cause?: unknown;

  constructor(opts: {
    code: ErrorCode;
    message: string;
    userMessage?: string;
    retryable?: boolean;
    issues?: ErrorIssue[];
    cause?: unknown;
  }) {
    super(opts.message, { cause: opts.cause });
    this.name = "QofenoError";
    this.code = opts.code;
    this.userMessage =
      opts.userMessage ?? DEFAULT_USER_MESSAGES[opts.code] ?? "An unexpected error occurred.";
    this.retryable = opts.retryable ?? false;
    this.exitCode = exitCodeFor(opts.code);
    this.issues = opts.issues;
    this.cause = opts.cause;
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      error: this.userMessage,
      retryable: this.retryable,
      ...(this.issues ? { issues: this.issues } : {}),
    };
  }
}

function exitCodeFor(code: ErrorCode): number {
  switch (code) {
    case ErrorCode.VALIDATION_FAILED:
      return 2;
    case ErrorCode.PERMISSION_DENIED:
    case ErrorCode.POLICY_DENIED:
    case ErrorCode.CONFIRMATION_REQUIRED:
    case ErrorCode.WORKSPACE_UNTRUSTED:
      return 3;
    case ErrorCode.NOT_FOUND:
      return 4;
    case ErrorCode.CONFLICT:
      return 5;
    case ErrorCode.CANCELLED:
      return 130;
    case ErrorCode.TIMEOUT:
      return 124;
    case ErrorCode.PROVIDER_UNAVAILABLE:
    case ErrorCode.PROVIDER_ERROR:
    case ErrorCode.MODEL_UNAVAILABLE:
      return 20;
    case ErrorCode.SECRET_STORE_LOCKED:
    case ErrorCode.AUTH_FAILED:
      return 21;
    case ErrorCode.STORAGE_ERROR:
      return 22;
    case ErrorCode.RATE_LIMITED:
      return 23;
    default:
      return 1;
  }
}

const DEFAULT_USER_MESSAGES: Record<ErrorCode, string> = {
  [ErrorCode.VALIDATION_FAILED]: "The input was invalid.",
  [ErrorCode.PERMISSION_DENIED]: "Permission denied. Review active rules with `qofeno permissions`.",
  [ErrorCode.POLICY_DENIED]: "Blocked by security policy. Inspect policies with `qofeno config policy`.",
  [ErrorCode.CONFIRMATION_REQUIRED]: "This action requires confirmation and none was given.",
  [ErrorCode.NOT_FOUND]: "Not found.",
  [ErrorCode.CONFLICT]: "The item changed concurrently; nothing was overwritten.",
  [ErrorCode.CANCELLED]: "Cancelled.",
  [ErrorCode.TIMEOUT]: "The operation exceeded its time limit and was stopped.",
  [ErrorCode.QUOTA_EXCEEDED]: "A configured limit was reached.",
  [ErrorCode.RATE_LIMITED]: "Rate limited; retry later.",
  [ErrorCode.PROVIDER_UNAVAILABLE]: "The AI provider is unreachable. Nothing was lost; retry when ready.",
  [ErrorCode.PROVIDER_ERROR]: "The AI provider reported an error.",
  [ErrorCode.CAPABILITY_UNSUPPORTED]: "The selected model does not support this capability.",
  [ErrorCode.MODEL_UNAVAILABLE]: "The selected model is unavailable. Choose another with /model.",
  [ErrorCode.SECRET_STORE_LOCKED]: "The credential store is locked or unavailable.",
  [ErrorCode.IMPORT_INVALID]: "The imported data failed validation and was not applied.",
  [ErrorCode.BACKUP_INVALID]: "The backup failed validation.",
  [ErrorCode.EXTENSION_ERROR]: "An extension failed and was contained.",
  [ErrorCode.PLATFORM_UNSUPPORTED]: "This capability is not available on this platform.",
  [ErrorCode.AUTH_FAILED]: "Authentication failed.",
  [ErrorCode.STORAGE_ERROR]: "A storage error occurred. Existing data was preserved.",
  [ErrorCode.WORKSPACE_UNTRUSTED]: "This workspace is untrusted; restrictive defaults apply. Trust it explicitly to continue.",
  [ErrorCode.INTERNAL]: "An internal error occurred.",
};

export function isQofenoError(e: unknown): e is QofenoError {
  return e instanceof QofenoError;
}
