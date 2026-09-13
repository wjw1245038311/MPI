/**
 * App Store — pure core (no fs/electron imports) so the strip-types test runner
 * can import it directly, mirroring voice.ts / trusted-tools conventions.
 *
 * An "app" is a declarative feature package: an `mpi-app.json` manifest plus a
 * config form. Enabling an app renders its `integrations.voiceStt` template with
 * the user's saved field values and writes the result into MPI's voice config;
 * disabling rolls back ONLY the fields that still equal what we wrote (field
 * fingerprint), so manual user edits are never clobbered.
 */
import type {
  AppConfigField,
  AppManifest,
  AppLocalizedText,
  AppCapability,
  AppServiceSpec,
  AppPiSpec,
  VoiceSttTemplate,
} from "../renderer/src/lib/types";

/** Stable app id: lowercase letters/digits/hyphens, e.g. `local-voice`. */
export const APP_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const FIELD_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const PLACEHOLDER_RE = /\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g;

/** v2: capabilities an app may declare (shown at install for consent). */
export const APP_CAPABILITIES = ["process", "network", "fs"] as const;
const SERVICE_ENTRY_RE = /\.(cjs|mjs|js)$/i;
const PI_EXT_RE = /\.(ts|cjs|mjs|js)$/i;

/**
 * A module path must stay inside the app directory: relative, no absolute path
 * (win or posix), no `~`, no `..` traversal, no NUL byte. Guards against a
 * manifest pointing the loader at an arbitrary system file.
 */
export function isSafeAppRelPath(p: string): boolean {
  if (!p || p.includes("\0")) return false;
  if (/^([a-zA-Z]:[\\/]|[\\/])/.test(p)) return false;
  if (p.startsWith("~")) return false;
  const segs = p.split(/[\\/]+/);
  return segs.every((s) => s !== ".." && s !== "");
}

export type ManifestValidation = { ok: true; manifest: AppManifest } | { ok: false; errors: string[] };

function isLocText(value: unknown): value is AppLocalizedText {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Type guard: true only when the object exists AND has at least one non-empty language. */
function locHasText(value: AppLocalizedText | undefined): value is AppLocalizedText {
  if (!value) return false;
  return Boolean((value.zh || "").trim() || (value.en || "").trim());
}

/** Pick the text for the UI language, falling back to the other one. */
export function pickLocText(value: AppLocalizedText | undefined, lang: "zh" | "en"): string {
  if (!value) return "";
  const primary = (lang === "zh" ? value.zh : value.en) || "";
  if (primary.trim()) return primary.trim();
  const fallback = (lang === "zh" ? value.en : value.zh) || "";
  return fallback.trim();
}

/** Validate + normalize a raw mpi-app.json payload. Never throws. */
export function validateAppManifest(raw: unknown): ManifestValidation {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["manifest must be a JSON object"] };
  }
  const m = raw as Record<string, unknown>;

  // id
  const id = typeof m.id === "string" ? m.id.trim() : "";
  if (!id) errors.push("missing id");
  else if (!APP_ID_RE.test(id)) errors.push(`invalid id "${id}" (expected lowercase letters/digits/hyphens)`);

  // localized name / description
  const name = isLocText(m.name) ? m.name : undefined;
  if (!locHasText(name)) errors.push("missing name (need {zh,en} with at least one non-empty)");
  const description = isLocText(m.description) ? m.description : undefined;
  if (!locHasText(description)) errors.push("missing description (need {zh,en} with at least one non-empty)");

  // version / category
  const version = typeof m.version === "string" ? m.version.trim().slice(0, 32) : "";
  if (!version) errors.push("missing version");
  const category = typeof m.category === "string" ? m.category.trim().slice(0, 32) : "";
  if (!category) errors.push("missing category");

  // optional guide
  let guide: AppLocalizedText | undefined;
  if (m.guide !== undefined) {
    if (!isLocText(m.guide) || !locHasText(m.guide)) errors.push("guide must be a localized text object");
    else guide = m.guide;
  }

  // config.fields
  const fields: AppConfigField[] = [];
  const fieldKeys = new Set<string>();
  const cfg = (m.config && typeof m.config === "object" && !Array.isArray(m.config) ? m.config : {}) as Record<
    string,
    unknown
  >;
  const rawFields = Array.isArray(cfg.fields) ? cfg.fields : null;
  if (!rawFields || rawFields.length === 0) {
    errors.push("config.fields must be a non-empty array");
  } else {
    for (const [i, rf] of rawFields.entries()) {
      const at = `config.fields[${i}]`;
      if (!rf || typeof rf !== "object" || Array.isArray(rf)) {
        errors.push(`${at} must be an object`);
        continue;
      }
      const f = rf as Record<string, unknown>;
      const key = typeof f.key === "string" ? f.key.trim() : "";
      if (!key) errors.push(`${at}.missing key`);
      else if (!FIELD_KEY_RE.test(key)) errors.push(`${at} invalid key "${key}"`);
      else if (fieldKeys.has(key)) errors.push(`${at} duplicate key "${key}"`);
      const label = isLocText(f.label) ? f.label : undefined;
      if (!locHasText(label)) errors.push(`${at}.missing label`);
      const type = typeof f.type === "string" ? f.type : "";
      if (type !== "url" && type !== "text" && type !== "password" && type !== "select") {
        errors.push(`${at} invalid type "${type}"`);
        continue; // no further field-level checks for a broken entry
      }
      const def = typeof f.default === "string" ? f.default : undefined;
      let options: AppConfigField["options"];
      if (type === "select") {
        const rawOptions = Array.isArray(f.options) ? f.options : null;
        if (!rawOptions || rawOptions.length === 0) {
          errors.push(`${at} select field needs a non-empty options array`);
        } else {
          options = [];
          for (const [j, ro] of rawOptions.entries()) {
            const o = (ro && typeof ro === "object" ? ro : {}) as Record<string, unknown>;
            const value = typeof o.value === "string" ? o.value.trim() : "";
            const optLabel = isLocText(o.label) ? o.label : undefined;
            if (!value || !locHasText(optLabel)) {
              errors.push(`${at}.options[${j}] needs value + label`);
              continue;
            }
            options.push({ value, label: optLabel });
          }
        }
      }
      const placeholder = isLocText(f.placeholder) ? f.placeholder : undefined;
      const hint = isLocText(f.hint) ? f.hint : undefined;
      if (key && FIELD_KEY_RE.test(key)) fieldKeys.add(key);
      fields.push({
        key,
        label: label || { en: key },
        type,
        ...(def !== undefined ? { default: def } : {}),
        ...(placeholder ? { placeholder } : {}),
        ...(hint ? { hint } : {}),
        ...(options && options.length > 0 ? { options } : {}),
      });
    }
  }

  // integrations.voiceStt (optional; v1 only supports the openai-compatible backend)
  let voiceStt: VoiceSttTemplate | undefined;
  const integ = (m.integrations && typeof m.integrations === "object" ? m.integrations : {}) as Record<
    string,
    unknown
  >;
  if (integ.voiceStt !== undefined) {
    const t = (integ.voiceStt && typeof integ.voiceStt === "object" ? integ.voiceStt : {}) as Record<string, unknown>;
    if (t.sttBackend !== "openai") {
      errors.push('integrations.voiceStt.sttBackend must be "openai" in v1');
    } else {
      const rendered: VoiceSttTemplate = { sttBackend: "openai" };
      for (const [k, v] of Object.entries(t)) {
        if (typeof v !== "string") {
          errors.push(`integrations.voiceStt.${k} must be a string`);
          continue;
        }
        for (const ph of v.matchAll(PLACEHOLDER_RE)) {
          if (!fieldKeys.has(ph[1])) errors.push(`integrations.voiceStt.${k} references unknown field {{${ph[1]}}}`);
        }
        rendered[k] = v;
      }
      voiceStt = rendered;
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  // v2: service module (main-process plugin with activate/deactivate)
  let service: AppServiceSpec | undefined;
  if (m.service !== undefined) {
    const s = (m.service && typeof m.service === "object" && !Array.isArray(m.service) ? m.service : null) as Record<
      string,
      unknown
    > | null;
    if (!s) errors.push("service must be an object");
    else {
      const entry = typeof s.entry === "string" ? s.entry.trim() : "";
      if (!entry) errors.push("service.entry is required");
      else if (!isSafeAppRelPath(entry)) errors.push(`service.entry must be a relative path inside the app (got "${entry}")`);
      else if (!SERVICE_ENTRY_RE.test(entry)) errors.push("service.entry must be a .js/.cjs/.mjs module");
      const autostart = typeof s.autostart === "boolean" ? s.autostart : undefined;
      let startCommandField: string | undefined;
      if (s.startCommandField !== undefined) {
        const k = typeof s.startCommandField === "string" ? s.startCommandField.trim() : "";
        if (!k || !fieldKeys.has(k)) errors.push("service.startCommandField must name an existing config field");
        else startCommandField = k;
      }
      if (entry && isSafeAppRelPath(entry) && SERVICE_ENTRY_RE.test(entry)) {
        service = {
          entry,
          ...(autostart !== undefined ? { autostart } : {}),
          ...(startCommandField ? { startCommandField } : {}),
        };
      }
    }
  }

  // v2: bundled pi extensions released into the user extension dir on enable
  let pi: AppPiSpec | undefined;
  if (m.pi !== undefined) {
    const p = (m.pi && typeof m.pi === "object" && !Array.isArray(m.pi) ? m.pi : null) as Record<
      string,
      unknown
    > | null;
    if (!p) errors.push("pi must be an object");
    else if (p.extensions !== undefined) {
      const list = Array.isArray(p.extensions) ? p.extensions : null;
      if (!list || list.length === 0) errors.push("pi.extensions must be a non-empty array");
      else {
        const exts: string[] = [];
        for (const [i, raw] of list.entries()) {
          const e = typeof raw === "string" ? raw.trim() : "";
          if (!e || !isSafeAppRelPath(e)) errors.push(`pi.extensions[${i}] must be a relative path inside the app`);
          else if (!PI_EXT_RE.test(e)) errors.push(`pi.extensions[${i}] must be a .ts/.js/.cjs/.mjs file`);
          else exts.push(e);
        }
        if (exts.length > 0) pi = { extensions: exts };
      }
    }
  }

  // v2: declared capabilities (whitelist)
  let capabilities: AppCapability[] | undefined;
  if (m.capabilities !== undefined) {
    if (!Array.isArray(m.capabilities)) errors.push("capabilities must be an array");
    else {
      const caps: AppCapability[] = [];
      for (const [i, raw] of m.capabilities.entries()) {
        const c = typeof raw === "string" ? raw : "";
        if (!(APP_CAPABILITIES as readonly string[]).includes(c)) errors.push(`capabilities[${i}] unknown capability "${c}"`);
        else if (!caps.includes(c as AppCapability)) caps.push(c as AppCapability);
      }
      if (caps.length > 0) capabilities = caps;
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  const manifest: AppManifest = {
    id,
    name: name!,
    version,
    category,
    description: description!,
    ...(guide ? { guide } : {}),
    config: { fields },
    ...(voiceStt ? { integrations: { voiceStt } } : {}),
    ...(service ? { service } : {}),
    ...(pi ? { pi } : {}),
    ...(capabilities ? { capabilities } : {}),
  };
  return { ok: true, manifest };
}

/** Replace `{{key}}` placeholders; missing/empty values render as empty string. */
export function renderTemplateString(template: string, values: Record<string, string>): string {
  return template.replace(PLACEHOLDER_RE, (_match, key: string) => (values[key] ?? "").trim());
}

/**
 * Render a voiceStt template into concrete VoiceConfig fields. Fields whose
 * rendered value is empty are dropped entirely (e.g. a blank API key for a
 * local endpoint must not persist as an empty string).
 */
export function renderVoicePatch(
  template: VoiceSttTemplate | undefined,
  values: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!template) return out;
  for (const [key, raw] of Object.entries(template)) {
    const rendered = renderTemplateString(raw, values).trim();
    if (rendered) out[key] = rendered;
  }
  return out;
}

/** Default form values from manifest field defaults (empty string when absent). */
export function defaultFieldValues(manifest: AppManifest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of manifest.config.fields) out[field.key] = field.default ?? "";
  return out;
}

/**
 * Field-level restore plan used when disabling/uninstalling an app. Starts from
 * the CURRENT voice config and reverts each applied key only while its value
 * still equals what we wrote — user edits win. A snapshot entry of `undefined`
 * means "the key did not exist before" → delete it on restore.
 */
export function computeRestorePlan(
  snapshot: Record<string, unknown>,
  applied: Record<string, string>,
  current: object | undefined,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...(current || {}) };
  for (const [key, value] of Object.entries(applied)) {
    if (result[key] !== value) continue; // user changed it — keep their edit
    if (Object.prototype.hasOwnProperty.call(snapshot, key) && snapshot[key] !== undefined) {
      result[key] = snapshot[key];
    } else {
      delete result[key];
    }
  }
  return result;
}
