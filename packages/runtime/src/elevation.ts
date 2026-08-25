/**
 * Elevation detection (#0187/#0188) and workspace trust state.
 * Running an autonomous agent as root is dangerous; we surface it loudly and
 * tighten defaults instead of encouraging it.
 */
import { userInfo } from "node:os";

export function isElevated(): boolean {
  try {
    if (process.platform === "win32") {
      // net session requires admin privileges.
      return false; // Conservative: do not claim elevation without proof on Windows.
    }
    return userInfo().uid === 0;
  } catch {
    return false;
  }
}

export function elevatedWarning(): string | null {
  if (!isElevated()) return null;
  return "Running as root/administrator. Tool permissions are enforced, but mistakes have system-wide reach. Prefer running qofeno as a normal user.";
}
