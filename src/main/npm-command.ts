/**
 * Pure decision logic for MPI's management of Pi's `npmCommand` setting and
 * for classifying "required tool missing" failures. Kept free of electron/fs
 * imports so it can be unit-tested with plain Node (see scripts/test-npm-command.mjs).
 */

export type NpmCommandAction = "write" | "clear" | "noop";

export interface NpmCommandDecision {
  action: NpmCommandAction;
  /** Value to store in settings.json `npmCommand` when action is "write". */
  value?: string[];
}

function normalizePath(p: string): string {
  return p.replace(/\//g, "\\").toLowerCase();
}

/** Case/slash-insensitive prefix check (Windows paths). */
export function pathStartsWith(path: string, base: string): boolean {
  const b = normalizePath(base);
  if (!b) return false;
  return normalizePath(path).startsWith(b);
}

/**
 * True when an existing `npmCommand` value was written by MPI (its node binary
 * lives under the app-managed runtime dir). User-configured values such as
 * mise/asdf wrappers or a system Node install are left untouched.
 */
export function isManagedNpmCommand(cmd: unknown, runtimeBase: string): boolean {
  if (!Array.isArray(cmd) || cmd.length === 0 || typeof cmd[0] !== "string") return false;
  return pathStartsWith(cmd[0], runtimeBase);
}

/**
 * Decide how MPI should manage the `npmCommand` entry in pi's settings.json so
 * extension package install/remove/update works on machines without Node.js:
 *
 * - bundledNpmCli === null (legacy/dev/PATH runtime carries no npm): clear a
 *   stale managed value so Pi falls back to the system npm; never touch a
 *   user-configured value.
 * - bundled npm present: write [node, npm-cli.js] unless the setting already
 *   holds exactly that, or the user configured an explicit command themselves.
 */
export function decideNpmCommand(opts: {
  settings: Record<string, unknown>;
  nodePath: string;
  bundledNpmCli: string | null;
  runtimeBase: string;
}): NpmCommandDecision {
  const current = opts.settings.npmCommand;
  if (!opts.bundledNpmCli) {
    return isManagedNpmCommand(current, opts.runtimeBase) ? { action: "clear" } : { action: "noop" };
  }
  const desired = [opts.nodePath, opts.bundledNpmCli];
  if (Array.isArray(current) && current.length === desired.length && current.every((v, i) => v === desired[i])) {
    return { action: "noop" };
  }
  // Absent or managed values are ours to manage; an explicit user value wins.
  if (current !== undefined && !isManagedNpmCommand(current, opts.runtimeBase)) return { action: "noop" };
  return { action: "write", value: desired };
}

/**
 * Classify a failed pi CLI run as "required tool missing" when the captured
 * output shows a spawn ENOENT for npm or git. The `Error: spawn <tool> ENOENT`
 * marker is ASCII-stable across locales (the surrounding cmd.exe text is not).
 */
export function classifyMissingTool(output: string): "npm" | "git" | null {
  if (/spawn\s+(?:npm|npx)\s+ENOENT/i.test(output)) return "npm";
  if (/spawn\s+git\s+ENOENT/i.test(output)) return "git";
  return null;
}
