/**
 * App Store — main-process service that lets MPI load third-party "apps"
 * (WeChat-mini-program style). MPI is only the platform: an app is delivered by
 * its developer as a zip package (or an unpacked directory) containing an
 * `mpi-app.json` manifest plus whatever the app needs (service module, bundled
 * runtime, models, pi extensions, assets). MPI validates the manifest, extracts
 * the package into <userData>/apps/<id>, and hosts the app's declared service
 * lifecycle. No app payload is baked into MPI itself.
 *
 *   <userData>/apps/
 *     registry.json        { apps: { <id>: { installed, enabled, snapshot?, applied?, status? } } }
 *     configs/<id>.json    saved form values (Record<fieldKey,string>)
 *     <id>/                extracted app files
 *
 * Enabling an app renders its integrations.voiceStt template with the saved
 * field values and merges the result into config.voice. The pre-apply voice
 * object is snapshotted; disabling rolls back ONLY fields that still equal
 * what we wrote (computeRestorePlan), so manual user edits survive.
 */
import { app } from "electron";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { AppManifest, AppStoreEntry, AppRuntimeStatus, AppVoiceTestResult } from "../renderer/src/lib/types";
import { computeRestorePlan, defaultFieldValues, renderVoicePatch, validateAppManifest } from "./app-store-core";
import {
  activateService,
  appendAppLog,
  deactivateService,
  defaultRuntimeDeps,
  readAppLog,
  resolveServiceEntry,
  type RuntimeDeps,
} from "./app-runtime";
import { getConfig, updateConfig, type VoiceConfig } from "./config";
import { testStt } from "./voice";
import { extractZip, listZipEntries, readZipEntry } from "./zip";

const MANIFEST_NAME = "mpi-app.json";
const APP_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

function appsDir(): string {
  const dir = join(app.getPath("userData"), "apps");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

interface RegistryEntry {
  installed?: boolean;
  enabled?: boolean;
  /** config.voice captured right before the app was enabled. */
  snapshot?: Record<string, unknown>;
  /** The exact voice fields written by this app (rendered template). */
  applied?: Record<string, string>;
  /** v2: last service status (persisted so the UI can show it after restart). */
  status?: AppRuntimeStatus;
  /** v2: last error detail (mirrors status.detail when state === "error"). */
  lastError?: string;
}

interface Registry {
  apps?: Record<string, RegistryEntry>;
}

function registryPath(): string {
  return join(appsDir(), "registry.json");
}

function readRegistry(): Registry {
  try {
    const parsed = JSON.parse(readFileSync(registryPath(), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Registry;
  } catch {
    // missing/corrupt registry = nothing installed
  }
  return {};
}

function writeRegistry(reg: Registry): void {
  writeFileSync(registryPath(), JSON.stringify(reg, null, 2), "utf8");
}

function configPathFor(id: string): string {
  const dir = join(appsDir(), "configs");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, `${id}.json`);
}

/**
 * Drop saved form values when the app version changes — a new version may have
 * different defaults (e.g. the endpoint default changed), and stale values from
 * an older install would otherwise override the new behavior. Same-version
 * reinstalls keep the user's values.
 */
function resetConfigIfUpgraded(id: string, prevVersion: string | undefined, nextVersion: string): void {
  if (prevVersion && prevVersion !== nextVersion) {
    try {
      rmSync(configPathFor(id), { force: true });
    } catch {
      /* best effort */
    }
  }
}

/** App-owned data dir (models, caches); removed on uninstall. */
function appDataDir(id: string): string {
  const dir = join(appsDir(), "data", id);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/* -------------------- v2: service runtime wiring -------------------- */

/** id -> managed child pids (service modules that declared the "process" capability). */
const managedProcesses = new Map<string, Set<number>>();

/** Injectable runtime deps (tests override spawn/load/kill). */
let runtimeDeps: RuntimeDeps = defaultRuntimeDeps;
export function setRuntimeDeps(deps: RuntimeDeps): void {
  runtimeDeps = deps;
}

function processesFor(id: string): Set<number> {
  let set = managedProcesses.get(id);
  if (!set) {
    set = new Set();
    managedProcesses.set(id, set);
  }
  return set;
}

/** Merge-mutate one registry entry, re-reading first so concurrent status writes survive. */
function updateRegistryEntry(id: string, mutate: (e: RegistryEntry) => void): RegistryEntry {
  const reg = readRegistry();
  if (!reg.apps) reg.apps = {};
  const entry: RegistryEntry = reg.apps[id] || { installed: true };
  mutate(entry);
  reg.apps[id] = entry;
  writeRegistry(reg);
  return entry;
}

function persistStatus(id: string, status: AppRuntimeStatus): void {
  updateRegistryEntry(id, (e) => {
    e.status = status;
    if (status.state === "error") e.lastError = status.detail;
    else delete e.lastError;
  });
}

/** Everything the runtime needs for one installed app. */
function runtimeHooks(id: string, manifest: AppManifest) {
  return {
    manifest,
    dir: join(appsDir(), id),
    dataDir: appDataDir(id),
    userData: app.getPath("userData"),
    fieldValues: getAppConfig(id),
    processes: processesFor(id),
    deps: runtimeDeps,
    setStatus: (s: AppRuntimeStatus) => persistStatus(id, s),
    log: (line: string) => appendAppLog(appsDir(), id, `[${new Date().toISOString()}] ${line}`),
  };
}

/** Read + validate an installed app's manifest from <userData>/apps/<id>. */
export function loadManifest(id: string): AppManifest | null {
  if (!APP_ID_RE.test(id)) return null;
  const path = join(appsDir(), id, MANIFEST_NAME);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const v = validateAppManifest(raw);
    if (!v.ok) {
      console.warn(`[app-store] invalid manifest for "${id}": ${v.errors.join("; ")}`);
      return null;
    }
    return v.manifest;
  } catch (e) {
    console.warn(`[app-store] cannot read manifest for "${id}":`, e);
    return null;
  }
}

/** Every installed app merged with its enable/status state. */
export function listApps(): AppStoreEntry[] {
  const reg = readRegistry();
  const out: AppStoreEntry[] = [];
  for (const [id, e] of Object.entries(reg.apps || {})) {
    if (!e?.installed || !APP_ID_RE.test(id)) continue;
    const manifest = loadManifest(id);
    if (!manifest) continue;
    out.push({
      ...manifest,
      installed: true,
      enabled: !!e.enabled,
      ...(e.status ? { status: e.status } : {}),
    });
  }
  return out;
}

function requireInstalled(id: string): AppManifest {
  if (!APP_ID_RE.test(id)) throw new Error("Invalid app id");
  const manifest = loadManifest(id);
  if (!manifest) throw new Error(`Unknown app: ${id}`);
  const reg = readRegistry();
  if (!reg.apps?.[id]?.installed) throw new Error("App is not installed");
  return manifest;
}

/**
 * Install an app from an unpacked directory: validate its manifest, copy the
 * whole directory into <userData>/apps/<id>, and register it (a fresh install
 * starts disabled). The source may be the developer's working folder.
 */
export function installAppFromDir(dirPath: string): AppStoreEntry {
  const src = resolve(dirPath);
  const manifestPath = join(src, MANIFEST_NAME);
  if (!existsSync(manifestPath)) throw new Error("Not an app directory (mpi-app.json missing)");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e) {
    throw new Error(`Cannot read app manifest: ${e instanceof Error ? e.message : String(e)}`);
  }
  const v = validateAppManifest(raw);
  if (!v.ok) throw new Error(`Invalid app manifest: ${v.errors.join("; ")}`);
  const manifest = v.manifest;
  const dest = join(appsDir(), manifest.id);
  if (src === dest || dest.startsWith(src + sep) || src.startsWith(dest + sep)) {
    throw new Error("Cannot install an app into itself");
  }
  const prevVersion = loadManifest(manifest.id)?.version;
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true });
  resetConfigIfUpgraded(manifest.id, prevVersion, manifest.version);
  const reg = readRegistry();
  if (!reg.apps) reg.apps = {};
  reg.apps[manifest.id] = { installed: true, enabled: false };
  writeRegistry(reg);
  return { ...manifest, installed: true, enabled: false };
}

/**
 * Install an app from a zip package: validate the manifest inside the archive,
 * extract it (streaming) into <userData>/apps/<id>, and register it. A single
 * wrapping folder around the manifest is tolerated and stripped.
 */
export async function installAppFromZip(zipPath: string): Promise<AppStoreEntry> {
  const path = resolve(zipPath);
  if (!existsSync(path)) throw new Error("Package file not found");
  const entries = listZipEntries(path);
  // Root manifest preferred; otherwise the shallowest <dir>/mpi-app.json.
  const candidates = entries
    .filter((e) => e.name === MANIFEST_NAME || e.name.endsWith("/" + MANIFEST_NAME))
    .sort((a, b) => a.name.length - b.name.length);
  const manifestEntry = candidates[0];
  if (!manifestEntry) throw new Error("Not an app package (mpi-app.json missing)");
  const base = manifestEntry.name.includes("/") ? manifestEntry.name.slice(0, manifestEntry.name.lastIndexOf("/")) : "";
  const manifestBuf = readZipEntry(path, manifestEntry.name);
  if (!manifestBuf) throw new Error("Cannot read app manifest from package");
  let raw: unknown;
  try {
    raw = JSON.parse(manifestBuf.toString("utf8"));
  } catch (e) {
    throw new Error(`Cannot parse app manifest: ${e instanceof Error ? e.message : String(e)}`);
  }
  const v = validateAppManifest(raw);
  if (!v.ok) throw new Error(`Invalid app manifest: ${v.errors.join("; ")}`);
  const manifest = v.manifest;
  const dest = join(appsDir(), manifest.id);
  const staging = join(appsDir(), `.staging-${manifest.id}-${Date.now()}`);
  try {
    await extractZip(path, staging, base);
    if (!existsSync(join(staging, MANIFEST_NAME))) throw new Error("Package is missing mpi-app.json after extraction");
    const prevVersion = loadManifest(manifest.id)?.version;
    rmSync(dest, { recursive: true, force: true });
    renameSync(staging, dest);
    resetConfigIfUpgraded(manifest.id, prevVersion, manifest.version);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  const reg = readRegistry();
  if (!reg.apps) reg.apps = {};
  reg.apps[manifest.id] = { installed: true, enabled: false };
  writeRegistry(reg);
  return { ...manifest, installed: true, enabled: false };
}

/** Disable (restoring voice config) then remove the app dir + saved values. */
export async function uninstallApp(id: string): Promise<void> {
  const manifest = requireInstalled(id);
  const reg = readRegistry();
  if (reg.apps?.[id]?.enabled) await disableApp(id, manifest);
  rmSync(join(appsDir(), id), { recursive: true, force: true });
  rmSync(join(appsDir(), "data", id), { recursive: true, force: true });
  try {
    rmSync(configPathFor(id));
  } catch {
    // no saved values — fine
  }
  updateRegistryEntry(id, () => {});
  const reg2 = readRegistry();
  if (reg2.apps) {
    delete reg2.apps[id];
    writeRegistry(reg2);
  }
}

/** Saved form values for an app, merged over the manifest defaults. */
export function getAppConfig(id: string): Record<string, string> {
  const manifest = requireInstalled(id);
  const values = defaultFieldValues(manifest);
  try {
    const saved = JSON.parse(readFileSync(configPathFor(id), "utf8"));
    if (saved && typeof saved === "object" && !Array.isArray(saved)) {
      for (const field of manifest.config.fields) {
        const v = (saved as Record<string, unknown>)[field.key];
        if (typeof v === "string") values[field.key] = v;
      }
    }
  } catch {
    // no saved values yet — defaults stand
  }
  return values;
}

/** Persist form values. Only declared field keys are kept, as strings. */
export function saveAppConfig(id: string, rawValues: Record<string, unknown>): Record<string, string> {
  const manifest = requireInstalled(id);
  const out: Record<string, string> = {};
  for (const field of manifest.config.fields) {
    const v = rawValues?.[field.key];
    out[field.key] = typeof v === "string" ? v : "";
  }
  writeFileSync(configPathFor(id), JSON.stringify(out, null, 2), "utf8");
  return out;
}

/** Apply an app's declarative template plus its service module's returned patch. */
async function enableApp(id: string, manifest: AppManifest): Promise<void> {
  const template = manifest.integrations?.voiceStt;
  const values = getAppConfig(id);
  let applied: Record<string, string> = template ? renderVoicePatch(template, values) : {};
  const current = getConfig().voice || {};
  const snapshot: Record<string, unknown> = { ...current };

  // v2: a service module may compute its own patch (and takes precedence per field).
  if (manifest.service) {
    const res = await activateService(runtimeHooks(id, manifest));
    if (res.voice && Object.keys(res.voice).length > 0) applied = { ...applied, ...res.voice };
  }

  if (Object.keys(applied).length > 0) {
    // Template/service keys are validated VoiceConfig field names; cast is safe.
    updateConfig({ voice: { ...current, ...(applied as Partial<VoiceConfig>) } });
  }
  updateRegistryEntry(id, (e) => {
    e.installed = true;
    e.enabled = true;
    e.snapshot = snapshot;
    e.applied = applied;
  });
}

/** Deactivate the service, reap its processes, then roll back what we wrote. */
async function disableApp(id: string, manifest: AppManifest): Promise<void> {
  const entry = readRegistry().apps?.[id] || { installed: true };
  if (manifest.service) await deactivateService(runtimeHooks(id, manifest));

  // Only touch config when we actually wrote something on enable.
  if (entry.applied && Object.keys(entry.applied).length > 0) {
    const current = getConfig().voice || {};
    const plan = computeRestorePlan(entry.snapshot || {}, entry.applied, current);
    if (Object.keys(plan).length > 0) updateConfig({ voice: plan as VoiceConfig });
    else updateConfig({ voice: undefined });
  }
  updateRegistryEntry(id, (e) => {
    delete e.snapshot;
    delete e.applied;
    e.enabled = false;
  });
}

/** Enable/disable an installed app (applies or rolls back its config wiring). */
export async function setAppEnabled(id: string, enabled: boolean): Promise<AppStoreEntry> {
  const manifest = requireInstalled(id);
  if (enabled) await enableApp(id, manifest);
  else await disableApp(id, manifest);
  const entry = readRegistry().apps?.[id] || {};
  return {
    ...(loadManifest(id) as AppManifest),
    installed: true,
    enabled: !!entry.enabled,
    ...(entry.status ? { status: entry.status } : {}),
  };
}

/**
 * Re-activate services for enabled apps on MPI startup. Unlike enableApp this
 * NEVER rewrites config or re-snapshots (the values are already applied) — it
 * only brings the service process back to life.
 */
export async function activateAutostartApps(): Promise<void> {
  const reg = readRegistry();
  for (const [id, entry] of Object.entries(reg.apps || {})) {
    if (!entry?.enabled) continue;
    const manifest = loadManifest(id);
    if (!manifest?.service || manifest.service.autostart === false) continue;
    try {
      await activateService(runtimeHooks(id, manifest));
    } catch (e) {
      console.warn(`[app-store] autostart failed for ${id}:`, e);
    }
  }
}

/** Restart an enabled app's service without touching config (retry/restart button). */
export async function restartAppService(id: string): Promise<AppStoreEntry> {
  const manifest = requireInstalled(id);
  if (!manifest.service) throw new Error("App has no service module");
  if (!readRegistry().apps?.[id]?.enabled) throw new Error("App is not enabled");
  await deactivateService(runtimeHooks(id, manifest));
  await activateService(runtimeHooks(id, manifest));
  const entry = readRegistry().apps?.[id] || {};
  return {
    ...(loadManifest(id) as AppManifest),
    installed: true,
    enabled: !!entry.enabled,
    ...(entry.status ? { status: entry.status } : {}),
  };
}

/** Reap every managed child process (called when MPI quits). */
export function killAllManagedProcesses(): void {
  for (const pids of managedProcesses.values()) {
    for (const pid of pids) runtimeDeps.killProcess(pid);
    pids.clear();
  }
}

/** Rolling log lines for an installed app (empty when none). */
export function getAppLogs(id: string): string[] {
  return readAppLog(appsDir(), id);
}

/**
 * Absolute paths of pi extensions shipped by enabled apps, for the bridge
 * spawn list. We point straight at the installed app dir (no copy) so:
 *   - relative imports inside the app keep working,
 *   - uninstall (rm the app dir) removes the extension with it,
 *   - user-authored extensions are never touched.
 * Disable only drops the app from this list; already-running threads keep the
 * extension until their next spawn (documented).
 */
export function getAppExtensionPaths(): string[] {
  const reg = readRegistry();
  const out: string[] = [];
  for (const [id, entry] of Object.entries(reg.apps || {})) {
    if (!entry?.enabled) continue;
    const manifest = loadManifest(id);
    if (!manifest?.pi?.extensions?.length) continue;
    const dir = join(appsDir(), id);
    for (const rel of manifest.pi.extensions) {
      const abs = resolveServiceEntry(dir, rel);
      if (abs && existsSync(abs) && !out.includes(abs)) out.push(abs);
    }
  }
  return out;
}

/** Whether an app's declared extension files are all present (UI hint). */
export function checkAppExtensions(id: string): { ok: boolean; missing: string[] } {
  const manifest = loadManifest(id);
  const missing: string[] = [];
  if (!manifest?.pi?.extensions?.length) return { ok: true, missing };
  const dir = join(appsDir(), id);
  for (const rel of manifest.pi.extensions) {
    const abs = resolveServiceEntry(dir, rel);
    if (!abs || !existsSync(abs)) missing.push(rel);
  }
  return { ok: missing.length === 0, missing };
}

/**
 * Probe a DRAFT voice configuration (manifest template + given field values)
 * without touching the saved config — powers the store's Test Connection button.
 */
export async function testAppVoice(id: string, rawValues: Record<string, unknown>): Promise<AppVoiceTestResult> {
  const manifest = loadManifest(id);
  if (!manifest) throw new Error(`Unknown app: ${id}`);
  const template = manifest.integrations?.voiceStt;
  if (!template) throw new Error("This app has no voice integration");

  // Merge over defaults so a partial draft still resolves (e.g. only the key changed).
  const values = { ...defaultFieldValues(manifest) };
  for (const field of manifest.config.fields) {
    const v = rawValues?.[field.key];
    if (typeof v === "string") values[field.key] = v;
  }
  const patch = renderVoicePatch(template, values);
  const draft: VoiceConfig = { ...(patch as Partial<VoiceConfig>) };
  // Apps that ship a service and leave the endpoint blank run their own bundled
  // server on enable — there is nothing to probe yet, so don't report the
  // misleading "missing base URL / API key" error.
  if (manifest.service && !String((patch as Record<string, unknown>).sttBaseUrl || "").trim()) {
    return { ok: false, error: "voice.stt.app-bundled" };
  }
  return testStt({ cfg: draft, providers: {} });
}
