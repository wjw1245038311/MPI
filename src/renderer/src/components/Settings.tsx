import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { useStore } from "../store";
import type { ApiType, AppConfig, Diagnostics, ModelDef, ModelsFile, ObservedToolInfo, PermissionLevel, ProviderDef, ShellDiagnostics, ThinkingDefaults } from "../lib/types";
import { formatBytes } from "../lib/format";
import { sttTranscribeErrorText } from "../lib/stt";
import { speakMessage, ttsVoices } from "../lib/tts";
import { reasoningLevelLabel } from "../lib/reasoning";
import { translateUiText } from "../lib/i18n";
import { COMMON_EXTENSION_TOOLS, isTrustableToolName, toggleTrustedTool } from "../lib/trusted-tools";
import { classifyToolName } from "@repo-root/src/shared/tool-trust-meta";
import { EDGE_VOICES, defaultEdgeVoice } from "../lib/edge-voices";
import { Archive, Check, ChevronRight, Close, Edit, Plus, Refresh, Folder, Search, Trash } from "./icons";
import { AppUpdatePanel, PiCoreUpdatePanel } from "./AboutPanels";
import appIconUrl from "../../../../resources/icon.png";
import doraemonAvatarUrl from "../../../../resources/doraemon.jpeg";
import nobitaAvatarUrl from "../../../../resources/nobita.jpg";

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

const API_TYPES: ApiType[] = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"];
const THINK_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const TOKENS_PER_K = 1000;

function formatTokenLimitK(tokens?: number): string {
  const value = Number(tokens);
  if (!Number.isFinite(value)) return "";
  return String(Number((value / TOKENS_PER_K).toFixed(3)));
}

function TokenLimitInput({
  value,
  onChange,
  label,
  placeholder,
}: {
  value?: number;
  onChange: (value: number | undefined) => void;
  label: string;
  placeholder: string;
}) {
  const [draft, setDraft] = useState(() => formatTokenLimitK(value));
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(formatTokenLimitK(value));
  }, [editing, value]);

  const commit = () => {
    setEditing(false);
    const raw = draft.trim();
    if (raw === "") {
      onChange(undefined);
      return;
    }
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric >= 0) {
      onChange(Math.round(numeric * TOKENS_PER_K));
    } else {
      setDraft(formatTokenLimitK(value));
    }
  };

  return (
    <div className="set-token-input" title={label}>
      <input
        className="set-input num"
        type="number"
        min={0}
        step={0.1}
        placeholder={placeholder}
        value={draft}
        onFocus={() => setEditing(true)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        aria-label={label}
      />
      <span className="set-token-unit" aria-hidden="true">K</span>
    </div>
  );
}

function supportedThinkingLevels(model?: ModelDef): readonly string[] {
  // This is a desired global default, not the live model capability list.
  // Keep unmapped levels visible so models without an explicit map can still
  // choose max here; the live composer still narrows levels using Pi's
  // model-specific capability response.
  if (!model) return THINK_LEVELS;
  if (!model.reasoning) return ["off"];
  return THINK_LEVELS.filter((level) => model.thinkingLevelMap?.[level] !== null);
}
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

const Eye = ({ off }: { off?: boolean }) => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
    <circle cx="12" cy="12" r="3" />
    {off && <path d="M3 3l18 18" />}
  </svg>
);

/* ------------------------------------------------------------------ *
 * Small building blocks
 * ------------------------------------------------------------------ */

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" className={`set-toggle ${checked ? "on" : ""}`} aria-checked={checked} role="switch" onClick={() => onChange(!checked)}>
      <span className="set-toggle-knob" />
    </button>
  );
}

/** Accent color presets — CSS blocks keyed on <html data-accent> in styles.css.
 * "default" is the app's original muted palette (matches base :root values). */
/** Accent color presets — user-defined palette; CSS blocks keyed on <html data-accent>.
 * The default preset (empty circle) keeps the app's original per-theme look. */
const ACCENT_PRESETS = [
  { id: "default", zh: "跟随主题", en: "Follow theme", swatch: "" },
  { id: "white", zh: "白", en: "White", swatch: "#ffffff" },
  { id: "lightgray", zh: "浅灰", en: "Light gray", swatch: "#d2d2d7" },
  { id: "darkgray", zh: "深灰", en: "Dark gray", swatch: "#3a3a3c" },
  { id: "green", zh: "绿", en: "Green", swatch: "#34c759" },
  { id: "red", zh: "红", en: "Red", swatch: "#ff3b30" },
  { id: "blue", zh: "蓝", en: "Blue", swatch: "#007aff" },
] as const;

function Field({ label, hint, children, wide }: { label: string; hint?: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`set-row ${wide ? "wide" : ""}`}>
      <label className="set-label">{label}</label>
      <div className="set-control">
        {children}
        {hint && <div className="set-hint">{hint}</div>}
      </div>
    </div>
  );
}

/**
 * JSON editor for free-form advanced fields such as compat.
 * Single source of truth = the text the user sees; a successful parse is pushed
 * up via onChange, a failed parse is flagged via register() so Save can block.
 * Parent should pass a stable `path` and key the component by it so switching
 * objects remounts and re-seeds the text from the new value.
 */
function JsonField({
  value,
  onChange,
  path,
  register,
  placeholder,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  path: string;
  register: (path: string, ok: boolean) => void;
  placeholder?: string;
}) {
  const [text, setText] = useState(() => (value === undefined ? "" : JSON.stringify(value, null, 2)));
  const [valid, setValid] = useState(true);
  const edit = (t: string) => {
    setText(t);
    if (t.trim() === "") {
      setValid(true);
      register(path, true);
      onChange(undefined);
      return;
    }
    try {
      onChange(JSON.parse(t));
      setValid(true);
      register(path, true);
    } catch {
      setValid(false);
      register(path, false);
    }
  };
  return (
    <div className="set-json-wrap">
      <textarea
        className={`set-json ${valid ? "" : "err"}`}
        spellCheck={false}
        placeholder={placeholder || '{\n  "thinkingFormat": "qwen"\n}'}
        value={text}
        onChange={(e) => edit(e.target.value)}
      />
      {!valid && <div className="set-json-err">JSON 语法错误，保存前请修正</div>}
    </div>
  );
}

/** Trusted-tools picker filter tabs (Settings → Permissions). */
type ToolTrustFilter = "all" | "trusted" | "untrusted";

interface TrustPickerRow {
  name: string;
  trusted: boolean;
  /** Toggling trust makes sense here (trustable, or already trusted to remove). */
  actionable: boolean;
  subtitle?: string;
  badge?: string;
}

const MAP_UNSET = "__unset__";
const MAP_HIDDEN = "__hidden__";
const MAP_CUSTOM = "__custom__";

/** Configure the fixed Pi effort levels without asking users to edit JSON. */
function ThinkingLevelMapEditor({
  value,
  onChange,
  language,
}: {
  value?: Record<string, string | null>;
  onChange: (value: Record<string, string | null> | undefined) => void;
  language: "en" | "zh";
}) {
  const map = value || {};
  const isBuiltInLevel = (raw: string) => THINK_LEVELS.some((level) => level === raw);
  const choiceFor = (level: string) => {
    if (!Object.prototype.hasOwnProperty.call(map, level)) return MAP_UNSET;
    if (map[level] === null) return MAP_HIDDEN;
    return typeof map[level] === "string" && isBuiltInLevel(map[level] as string) ? map[level] : MAP_CUSTOM;
  };
  const emit = (next: Record<string, string | null>) => onChange(Object.keys(next).length ? next : undefined);
  const setChoice = (level: string, choice: string) => {
    const next = { ...map };
    if (choice === MAP_UNSET) delete next[level];
    else if (choice === MAP_HIDDEN) next[level] = null;
    else if (choice === MAP_CUSTOM) {
      const current = next[level];
      next[level] = typeof current === "string" && current.trim() ? current : level;
    } else next[level] = choice;
    emit(next);
  };
  const setCustom = (level: string, raw: string) => {
    const next = { ...map };
    if (raw.trim()) next[level] = raw.trim();
    else delete next[level];
    emit(next);
  };

  return (
    <div className="set-thinking-map">
      <div className="set-thinking-map-head">
        <span>{language === "zh" ? "Pi 档位" : "Pi level"}</span>
        <span>{language === "zh" ? "提供方设置" : "Provider setting"}</span>
      </div>
      {THINK_LEVELS.map((level) => {
        const choice = choiceFor(level);
        const raw = map[level];
        return (
          <div className="set-thinking-map-row" key={level}>
            <div className="set-thinking-map-level">
              <span>{reasoningLevelLabel(level, language)}</span>
              <code>{level}</code>
            </div>
            <div className="set-thinking-map-control">
              <select className="set-select" value={choice} onChange={(event) => setChoice(level, event.target.value)}>
                <option value={MAP_UNSET}>{language === "zh" ? "未指定（使用提供方默认）" : "Unspecified (provider default)"}</option>
                <option value={MAP_HIDDEN}>{language === "zh" ? "隐藏该档位" : "Hide this level"}</option>
                {THINK_LEVELS.map((providerLevel) => (
                  <option key={providerLevel} value={providerLevel}>
                    {reasoningLevelLabel(providerLevel, language)} ({providerLevel})
                  </option>
                ))}
                <option value={MAP_CUSTOM}>{language === "zh" ? "自定义提供方值" : "Custom provider value"}</option>
              </select>
              {choice === MAP_CUSTOM && (
                <input
                  className="set-input set-thinking-map-custom"
                  value={typeof raw === "string" ? raw : ""}
                  placeholder={language === "zh" ? "提供方档位" : "Provider level"}
                  onChange={(event) => setCustom(level, event.target.value)}
                />
              )}
            </div>
          </div>
        );
      })}
      <div className="set-hint">
        {language === "zh"
          ? "未指定不会写入该档位；隐藏会写入 null。自定义值用于供应商使用非标准档位名称的情况。"
          : "Unspecified omits the level; Hide writes null. Use a custom value for providers with non-standard level names."}
      </div>
    </div>
  );
}

/** Key/value list editor for provider `headers`. */
function KvList({ value, onChange }: { value?: Record<string, string>; onChange: (v: Record<string, string> | undefined) => void }) {
  const [rows, setRows] = useState(() => Object.entries(value || {}).map(([k, v], i) => ({ k, v, id: `r${i}` })));
  const emit = (next: typeof rows) => {
    const o: Record<string, string> = {};
    for (const r of next) if (r.k.trim()) o[r.k.trim()] = r.v;
    onChange(Object.keys(o).length ? o : undefined);
  };
  const update = (id: string, patch: Partial<{ k: string; v: string }>) => {
    const next = rows.map((r) => (r.id === id ? { ...r, ...patch } : r));
    setRows(next);
    emit(next);
  };
  const add = () => {
    const next = [...rows, { k: "", v: "", id: `r${Date.now()}` }];
    setRows(next);
  };
  const remove = (id: string) => {
    const next = rows.filter((r) => r.id !== id);
    setRows(next);
    emit(next);
  };
  return (
    <div className="set-kv">
      {rows.map((r) => (
        <div className="set-kv-row" key={r.id}>
        <input className="set-input" placeholder="请求头名称" value={r.k} onChange={(e) => update(r.id, { k: e.target.value })} />
          <input className="set-input" placeholder="值（支持 $ENV / !cmd）" value={r.v} onChange={(e) => update(r.id, { v: e.target.value })} />
          <button className="set-iconbtn danger" title="删除" onClick={() => remove(r.id)}>
            ×
          </button>
        </div>
      ))}
      <button className="set-addline" onClick={add}>
        <Plus size={13} /> 添加请求头
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Model row
 * ------------------------------------------------------------------ */

function ModelRow({
  m,
  i,
  pfx,
  providerId,
  provider,
  language,
  patch,
  remove,
  register,
}: {
  m: ModelDef;
  i: number;
  pfx: string;
  providerId: string;
  provider: ProviderDef;
  language: "en" | "zh";
  patch: (p: Partial<ModelDef>) => void;
  remove: () => void;
  register: (path: string, ok: boolean) => void;
}) {
  const [adv, setAdv] = useState(false);
  const [test, setTest] = useState<{ state: "idle" | "testing" | "ok" | "error"; message?: string; latencyMs?: number }>({ state: "idle" });
  const [testElapsed, setTestElapsed] = useState(0);
  // P1-11: on-demand contextWindow probe (重新探测 button).
  const [ctxProbe, setCtxProbe] = useState<{ state: "idle" | "probing" | "error" }>({ state: "idle" });
  const testFingerprint = JSON.stringify({
    providerId,
    baseUrl: provider.baseUrl,
    api: provider.api,
    apiKey: provider.apiKey,
    headers: provider.headers,
    compat: provider.compat,
    model: m,
  });
  useEffect(() => {
    setTest({ state: "idle" });
    setCtxProbe({ state: "idle" });
  }, [testFingerprint]);
  useEffect(() => {
    if (test.state !== "testing") return;
    const started = Date.now();
    setTestElapsed(0);
    const timer = window.setInterval(() => setTestElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [test.state]);

  const runAvailabilityTest = async () => {
    if (!m.id.trim()) {
      setTest({ state: "error", message: language === "zh" ? "请先填写模型 ID。" : "Enter a model ID first." });
      return;
    }
    setTest({ state: "testing" });
    try {
      const result = await window.pi.settings.testModel({ providerId, provider, modelId: m.id.trim() });
      setTest({
        state: result.ok ? "ok" : "error",
        message: result.message,
        latencyMs: result.latencyMs,
      });
    } catch (error: any) {
      setTest({ state: "error", message: error?.message || String(error) });
    }
  };
  const setInput = (t: "text" | "image", on: boolean) => {
    const cur = new Set<"text" | "image">((m.input || []) as ("text" | "image")[]);
    on ? cur.add(t) : cur.delete(t);
    const arr = [...cur];
    patch({ input: arr.length ? arr : undefined });
  };
  const has = (t: "text" | "image") => (m.input || []).includes(t);

  /* ---- P1-11 context auto-resolution UI ---- */
  const runCtxProbe = async () => {
    if (!m.id.trim()) return;
    setCtxProbe({ state: "probing" });
    try {
      const res = await window.pi.settings.resolveModelContext({ providerId, provider, model: m });
      if (res?.value) {
        // Explicit re-probe overwrites the current value.
        patch({ contextWindow: res.value, contextWindowAuto: true, contextWindowSource: res.source, contextWindowDetail: res.detail });
        setCtxProbe({ state: "idle" });
      } else if (m.contextWindow === undefined) {
        // Nothing found and nothing to keep — surface the miss on the badge.
        patch({ contextWindowSource: "none", contextWindowDetail: undefined });
        setCtxProbe({ state: "idle" });
      } else {
        // Keep the existing value; report that the probe failed.
        setCtxProbe({ state: "error" });
      }
    } catch {
      setCtxProbe({ state: "error" });
    }
  };
  const ctxAuto = !!m.contextWindowAuto;
  let ctxBadge: string | null = null;
  let ctxBadgeTitle: string | undefined;
  if (ctxProbe.state === "probing") {
    ctxBadge = language === "zh" ? "探测中…" : "Probing…";
  } else if (ctxProbe.state === "error") {
    ctxBadge = language === "zh" ? "探测失败（保留原值）" : "Probe failed (kept value)";
  } else if (ctxAuto) {
    const src = m.contextWindowSource as string | undefined;
    if (typeof m.contextWindowDetail === "string") ctxBadgeTitle = m.contextWindowDetail;
    if (!m.contextWindow && src !== "none") {
      // Empty + auto: resolution happens on save — the checkbox says it all.
    } else if (src === "catalog") {
      ctxBadge = language === "zh" ? "内置目录" : "Catalog";
    } else if (src === "api") {
      ctxBadge = language === "zh" ? "API 探测" : "Probed";
    } else if (!m.contextWindow) {
      ctxBadge = language === "zh" ? "未探测到 · 默认128K" : "Not found · default 128K";
    }
  }

  return (
    <div className="set-model">
      <div className="set-model-grid">
        <input
          className="set-input"
          autoFocus={i === (provider.models || []).length - 1 && !m.id}
          placeholder="模型 id（必填）"
          value={m.id || ""}
          onChange={(e) => patch({ id: e.target.value })}
        />
        <input className="set-input" placeholder="显示名称" value={m.name || ""} onChange={(e) => patch({ name: e.target.value || undefined })} />
        <label className="set-check" title="支持扩展思考">
          <Toggle checked={!!m.reasoning} onChange={(v) => patch({ reasoning: v })} />
          <span>思考</span>
        </label>
        <label className="set-check">
          <input type="checkbox" checked={has("image")} onChange={(e) => setInput("image", e.target.checked)} />
          <span>图像</span>
        </label>
        <div className="set-ctx-cell">
          <TokenLimitInput
            value={m.contextWindow}
            onChange={(value) => {
              patch({ contextWindow: value });
              // Manual entry takes over from auto resolution.
              if (value !== undefined && m.contextWindowAuto)
                patch({ contextWindowAuto: false, contextWindowSource: undefined, contextWindowDetail: undefined });
            }}
            label={language === "zh" ? "上下文长度（K 令牌）" : "Context length (K tokens)"}
            placeholder="128"
          />
          <label
            className="set-check set-ctx-auto"
            title={
              language === "zh"
                ? "留空时保存自动解析上下文长度（内置目录 → API 探测）；已有值则不解析"
                : "When empty, resolve automatically on save (built-in catalog → API probe); existing values are never re-resolved"
            }
          >
            <input
              type="checkbox"
              checked={ctxAuto}
              onChange={(e) =>
                patch(
                  e.target.checked
                    ? { contextWindowAuto: true }
                    : { contextWindowAuto: false, contextWindowSource: undefined, contextWindowDetail: undefined },
                )
              }
            />
            <span>{language === "zh" ? "自动" : "Auto"}</span>
          </label>
          {ctxBadge && (
            <span className={`set-ctx-badge ${ctxProbe.state !== "idle" ? "busy" : ""}`} title={ctxBadgeTitle ?? undefined}>
              {ctxBadge}
            </span>
          )}
          <button
            type="button"
            className="set-iconbtn set-ctx-reprobe"
            title={language === "zh" ? "重新探测上下文长度（覆盖当前值）" : "Re-probe context length (overwrites current value)"}
            onClick={() => void runCtxProbe()}
            disabled={!m.id.trim() || ctxProbe.state === "probing"}
          >
            {ctxProbe.state === "probing" ? <span className="spinner" /> : "↻"}
          </button>
        </div>
        <TokenLimitInput
          value={m.maxTokens}
          onChange={(value) => patch({ maxTokens: value })}
          label={language === "zh" ? "最大输出（K 令牌）" : "Max output (K tokens)"}
          placeholder="16"
        />
        <button className="set-iconbtn" title="高级" onClick={() => setAdv((v) => !v)}>
          ⚙
        </button>
        <button className="set-iconbtn danger" title="删除模型" onClick={remove}>
          ×
        </button>
      </div>
      <div className="set-model-testbar">
        <div className={`set-model-testresult ${test.state}`}>
          {test.state === "testing" && (
            <>
              <span className="spinner" />{" "}
              {language === "zh"
                ? `等待模型首次输出 · ${testElapsed} 秒`
                : `Waiting for the model's first output · ${testElapsed}s`}
            </>
          )}
          {test.state === "ok" && (
            <>
              <span className="set-model-testdot" />
              {language === "zh" ? `模型可用 · ${(Number(test.latencyMs || 0) / 1000).toFixed(1)} 秒` : `Available · ${(Number(test.latencyMs || 0) / 1000).toFixed(1)}s`}
            </>
          )}
          {test.state === "error" && (
            <>
              <span className="set-model-testdot" />
              <span title={test.message}>{test.message ? translateUiText(test.message, language) : ""}</span>
            </>
          )}
        </div>
        <button type="button" className="set-model-testbtn" onClick={runAvailabilityTest} disabled={test.state === "testing"}>
          {test.state === "testing" ? (language === "zh" ? "检查中" : "Testing") : language === "zh" ? "测试可用性" : "Test availability"}
        </button>
      </div>
      {adv && (
        <div className="set-model-adv">
          <Field
            label={language === "zh" ? "API 类型覆盖" : "API type override"}
            hint={language === "zh" ? "留空则继承提供商；切换 Anthropic 时地址仍填写带 /v1 的形式。" : "Leave empty to inherit the provider; enter Anthropic URLs with /v1 too."}
          >
            <select className="set-select" value={m.api || ""} onChange={(e) => patch({ api: (e.target.value || undefined) as ApiType | undefined })}>
              <option value="">{language === "zh" ? "（继承提供商）" : "(Inherit provider)"}</option>
              {API_TYPES.map((api) => (
                <option key={api} value={api}>
                  {api}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label={language === "zh" ? "基础地址" : "Base URL"}
            hint={language === "zh" ? "可选的模型级地址覆盖；界面统一填写带 /v1 的地址。" : "Optional model-level endpoint override; enter the URL with /v1."}
          >
            <input
              className="set-input"
              placeholder="https://api.example.com/v1"
              value={m.baseUrl || ""}
              onChange={(e) => patch({ baseUrl: e.target.value || undefined })}
            />
          </Field>
          <Field label="compat" hint="兼容性覆盖，如 thinkingFormat / supportsDeveloperRole 等">
            <JsonField key={`${pfx}:compat`} path={`${pfx}:compat`} value={m.compat} register={register} onChange={(v) => patch({ compat: v as Record<string, unknown> | undefined })} />
          </Field>
          <Field
            label="thinkingLevelMap"
            hint={language === "zh" ? "按 Pi 思考档位逐项选择提供方设置" : "Configure the provider setting for each Pi effort level"}
          >
            <ThinkingLevelMapEditor value={m.thinkingLevelMap} language={language} onChange={(v) => patch({ thinkingLevelMap: v })} />
          </Field>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * P1-12 Auto model switching (Settings → 模型与提供商)
 * ------------------------------------------------------------------ */

/** Mirror of main's DEFAULT_POLICY (src/main/model-autopilot.ts) — keep in sync. */
const AUTO_POLICY_DEFAULTS = {
  softDegradeFactor: 3,
  softDegradeMinMs: 15_000,
  softDegradeStreak: 2,
  recoveryIntervalMin: 5,
  cooldownMin: 10,
  strictNoDowngrade: false,
  notify: true,
};

interface AutoPoolEntry {
  provider: string;
  modelId: string;
  paid?: boolean;
  tierOverride?: "high" | "mid" | "low";
}

function AutoModelCard({ providers }: { providers: Record<string, ProviderDef> }) {
  const language = useStore((s) => s.config?.language || "en");
  const config = useStore((s) => s.config);
  const pushToast = useStore((s) => s.pushToast);
  const zh = language === "zh";

  const [pool, setPool] = useState<AutoPoolEntry[]>(() => config?.autoModels?.pool ?? []);
  const [policy, setPolicy] = useState(() => ({ ...AUTO_POLICY_DEFAULTS, ...(config?.autoModels?.policy ?? {}) }));
  const [initial, setInitial] = useState(
    () => JSON.stringify({ pool: config?.autoModels?.pool ?? [], policy: { ...AUTO_POLICY_DEFAULTS, ...(config?.autoModels?.policy ?? {}) } }),
  );
  const dirty = JSON.stringify({ pool, policy }) !== initial;
  const [saving, setSaving] = useState(false);

  const providerIds = Object.keys(providers).filter((id) => (providers[id]?.models ?? []).length > 0);

  const updateEntry = (i: number, p: Partial<AutoPoolEntry>) =>
    setPool((list) => list.map((e, idx) => (idx === i ? { ...e, ...p } : e)));
  const moveEntry = (i: number, dir: -1 | 1) =>
    setPool((list) => {
      const j = i + dir;
      if (j < 0 || j >= list.length) return list;
      const next = [...list];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const save = async () => {
    if (pool.some((e) => !e.provider || !e.modelId)) {
      pushToast("error", zh ? "候选池存在未填完的行（供应商 / 模型 ID）" : "Pool rows need both a provider and a model id");
      return;
    }
    setSaving(true);
    try {
      const next = await window.pi.app.setConfig({ autoModels: { pool, policy } });
      useStore.setState({ config: next });
      setInitial(JSON.stringify({ pool, policy }));
      pushToast("info", zh ? "自动模型配置已保存" : "Auto-model settings saved");
    } catch (e: any) {
      pushToast("error", (zh ? "保存失败：" : "Save failed: ") + (e?.message || e));
    } finally {
      setSaving(false);
    }
  };

  const num = (v: number, min: number) => Math.max(min, Math.round(v));

  return (
    <div className="set-card">
      <h3>{zh ? "自动模型（auto）" : "Auto model switching"}</h3>
      <p className="set-hint">
        {zh
          ? "在会话的模型下拉里开启 Auto 后，MPI 会按「免费优先 → 质量档高→低 → 延迟低→高」自动切换候选池中的模型：当前模型报错或连续过慢时切走，更优模型恢复后再切回。只切到不低于当前质量的档位；全部低于时才救急降级（带警告）。非 auto 会话不受任何影响。"
          : "With Auto enabled in a session's model dropdown, MPI switches between pool models by \u201cfree first → higher tier → lower latency\u201d: it leaves the current model on errors or sustained slowness and returns when a better one recovers. It never switches below the current quality tier unless nothing else is available (rescue, with a warning). Non-auto sessions are unaffected."}
      </p>

      <div className="set-autopool">
        {pool.length === 0 && (
          <div className="ft-empty">{zh ? "候选池为空——添加模型后，在会话里开启 Auto 才会生效。" : "Pool is empty — add models, then enable Auto in a session."}</div>
        )}
        {pool.map((entry, i) => (
          <div className="set-autopool-row" key={`${entry.provider}/${entry.modelId}:${i}`}>
            <select
              className="set-select"
              value={entry.provider}
              onChange={(e) => {
                const pid = e.target.value;
                updateEntry(i, { provider: pid, modelId: (providers[pid]?.models ?? [])[0]?.id ?? "" });
              }}
            >
              <option value="">{zh ? "— 供应商 —" : "— provider —"}</option>
              {providerIds.map((pid) => (
                <option key={pid} value={pid}>
                  {(providers[pid]?.name as string | undefined) ?? pid}
                </option>
              ))}
            </select>
            <select
              className="set-select"
              value={entry.modelId}
              onChange={(e) => updateEntry(i, { modelId: e.target.value })}
              disabled={!entry.provider}
            >
              <option value="">{zh ? "— 模型 —" : "— model —"}</option>
              {(providers[entry.provider]?.models ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name || m.id}
                </option>
              ))}
            </select>
            <label className="set-check" title={zh ? "收费端点：有免费候选时不会被选用" : "Billed endpoint: never picked while a free candidate is available"}>
              <input type="checkbox" checked={!!entry.paid} onChange={(e) => updateEntry(i, { paid: e.target.checked || undefined })} />
              <span>{zh ? "收费" : "Paid"}</span>
            </label>
            <select
              className="set-select set-autopool-tier"
              value={entry.tierOverride ?? ""}
              onChange={(e) => updateEntry(i, { tierOverride: (e.target.value || undefined) as AutoPoolEntry["tierOverride"] })}
              title={zh ? "质量档（默认自动推断）" : "Quality tier (auto-inferred by default)"}
            >
              <option value="">{zh ? "档位：自动" : "Tier: auto"}</option>
              <option value="high">High</option>
              <option value="mid">Mid</option>
              <option value="low">Low</option>
            </select>
            <button type="button" className="set-iconbtn" title={zh ? "上移（同档平手时优先）" : "Move up (tie-break preference)"} onClick={() => moveEntry(i, -1)} disabled={i === 0}>
              ↑
            </button>
            <button type="button" className="set-iconbtn" title={zh ? "下移" : "Move down"} onClick={() => moveEntry(i, 1)} disabled={i === pool.length - 1}>
              ↓
            </button>
            <button type="button" className="set-iconbtn danger" title={zh ? "移除" : "Remove"} onClick={() => setPool((list) => list.filter((_, idx) => idx !== i))}>
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          className="set-addline"
          onClick={() => setPool((list) => [...list, { provider: providerIds[0] ?? "", modelId: (providers[providerIds[0]]?.models ?? [])[0]?.id ?? "" }])}
        >
          ＋ {zh ? "添加候选模型" : "Add candidate model"}
        </button>
      </div>

      <div className="set-autopolicy">
        <label className="set-addprov-field">
          <span>{zh ? "慢速倍数（×中位数）" : "Slow factor (× median)"}</span>
          <input className="set-input num" type="number" min={1} step={0.5} value={policy.softDegradeFactor} onChange={(e) => setPolicy((p) => ({ ...p, softDegradeFactor: Number(e.target.value) || p.softDegradeFactor }))} />
        </label>
        <label className="set-addprov-field">
          <span>{zh ? "慢速阈值（秒）" : "Slow floor (s)"}</span>
          <input className="set-input num" type="number" min={1} value={Math.round(policy.softDegradeMinMs / 1000)} onChange={(e) => setPolicy((p) => ({ ...p, softDegradeMinMs: num(Number(e.target.value), 1) * 1000 }))} />
        </label>
        <label className="set-addprov-field">
          <span>{zh ? "连续次数" : "Streak (turns)"}</span>
          <input className="set-input num" type="number" min={1} value={policy.softDegradeStreak} onChange={(e) => setPolicy((p) => ({ ...p, softDegradeStreak: num(Number(e.target.value), 1) }))} />
        </label>
        <label className="set-addprov-field">
          <span>{zh ? "恢复探测（分钟）" : "Recovery probe (min)"}</span>
          <input className="set-input num" type="number" min={1} value={policy.recoveryIntervalMin} onChange={(e) => setPolicy((p) => ({ ...p, recoveryIntervalMin: num(Number(e.target.value), 1) }))} />
        </label>
        <label className="set-addprov-field">
          <span>{zh ? "切换冷却（分钟）" : "Switch cooldown (min)"}</span>
          <input className="set-input num" type="number" min={0} value={policy.cooldownMin} onChange={(e) => setPolicy((p) => ({ ...p, cooldownMin: num(Number(e.target.value), 0) }))} />
        </label>
        <label className="set-check">
          <input type="checkbox" checked={!policy.strictNoDowngrade} onChange={(e) => setPolicy((p) => ({ ...p, strictNoDowngrade: !e.target.checked }))} />
          <span>{zh ? "允许救急降级（带警告）" : "Allow rescue downgrade (warned)"}</span>
        </label>
        <label className="set-check">
          <input type="checkbox" checked={policy.notify !== false} onChange={(e) => setPolicy((p) => ({ ...p, notify: e.target.checked }))} />
          <span>{zh ? "切换时弹通知" : "Notify on switch"}</span>
        </label>
      </div>

      <button className="set-btn primary" onClick={() => void save()} disabled={!!saving || !dirty}>
        {saving ? <span className="spinner" /> : zh ? "保存自动模型配置" : "Save auto-model settings"}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Provider card
 * ------------------------------------------------------------------ */

function ProviderCard({
  k,
  def,
  language,
  rename,
  patch,
  del,
  register,
  addModel,
  updateModel,
  deleteModel,
}: {
  k: string;
  def: ProviderDef;
  language: "en" | "zh";
  rename: (name: string) => boolean;
  patch: (p: Partial<ProviderDef>) => void;
  del: () => void;
  register: (path: string, ok: boolean) => void;
  addModel: () => void;
  updateModel: (i: number, p: Partial<ModelDef>) => void;
  deleteModel: (i: number) => void;
}) {
  const [showKey, setShowKey] = useState(false);
  const [adv, setAdv] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [providerName, setProviderName] = useState(k);
  useEffect(() => {
    setProviderName(k);
    setRenaming(false);
  }, [k]);
  const submitRename = () => {
    if (rename(providerName)) setRenaming(false);
  };
  const models = def.models || [];
  return (
    <div className="set-card">
      <div className="set-card-head">
        {renaming ? (
          <form
            className="set-prov-rename"
            onSubmit={(event) => {
              event.preventDefault();
              submitRename();
            }}
          >
            <input
              className="set-input"
              autoFocus
              value={providerName}
              onChange={(event) => setProviderName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  setProviderName(k);
                  setRenaming(false);
                }
              }}
            />
            <button type="submit" className="set-iconbtn" title={language === "zh" ? "确认修改" : "Save name"}>
              <Check size={14} />
            </button>
            <button
              type="button"
              className="set-iconbtn"
              title={language === "zh" ? "取消" : "Cancel"}
              onClick={() => {
                setProviderName(k);
                setRenaming(false);
              }}
            >
              <Close size={14} />
            </button>
          </form>
        ) : (
          <>
            <span className="set-prov-id" title={k}>
              {k}
            </span>
            <button
              type="button"
              className="set-iconbtn set-prov-name-edit"
              title={language === "zh" ? "修改供应商名称" : "Rename provider"}
              onClick={() => setRenaming(true)}
            >
              <Edit size={13} />
            </button>
          </>
        )}
        <span className="set-prov-count">{models.length} 模型</span>
        <button className="set-iconbtn danger" title="删除提供商" onClick={del}>
          ×
        </button>
      </div>

      <Field
        label={language === "zh" ? "基础地址" : "Base URL"}
        hint={
          language === "zh"
            ? "界面统一填写带 /v1 的地址；Anthropic 写入 Pi 时会自动去掉末尾 /v1。"
            : "Enter URLs with /v1; Pi removes the trailing /v1 internally for Anthropic."
        }
      >
        <input className="set-input" placeholder="https://api.example.com/v1" value={def.baseUrl || ""} onChange={(e) => patch({ baseUrl: e.target.value || undefined })} />
      </Field>

      <Field label="API 类型">
        <select className="set-select" value={def.api || ""} onChange={(e) => patch({ api: (e.target.value || undefined) as ApiType | undefined })}>
          <option value="">{language === "zh" ? "（继承 / 未设）" : "(Inherit / not set)"}</option>
          {API_TYPES.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </Field>

      <Field label={language === "zh" ? "API 密钥" : "API Key"} hint="支持明文、环境变量 $MY_KEY、或 shell 命令 !cmd">
        <div className="set-keywrap">
          <input className="set-input" type={showKey ? "text" : "password"} placeholder="sk-... 或 $ENV_VAR 或 !command" value={def.apiKey || ""} onChange={(e) => patch({ apiKey: e.target.value || undefined })} />
          <button className="set-iconbtn" title={showKey ? "隐藏" : "显示"} onClick={() => setShowKey((v) => !v)}>
            <Eye off={!showKey} />
          </button>
        </div>
      </Field>

      <Field label={language === "zh" ? "请求头" : "Request headers"} hint="自定义请求头，值同样支持 $ENV / !cmd">
        <KvList value={def.headers as Record<string, string> | undefined} onChange={(v) => patch({ headers: v })} />
      </Field>

      <button className="set-adv-toggle" onClick={() => setAdv((v) => !v)}>
        <span style={{ transform: adv ? "rotate(90deg)" : "none", display: "inline-block", transition: "transform .15s" }}>›</span> 提供商级 compat（高级 JSON）
      </button>
      {adv && (
        <div className="set-adv-body">
          <JsonField key={`p:${k}:compat`} path={`p:${k}:compat`} value={def.compat} register={register} onChange={(v) => patch({ compat: v as Record<string, unknown> | undefined })} />
        </div>
      )}

      <div className="set-models-head">
        <span>模型</span>
        <button className="set-addline" onClick={addModel}>
          <Plus size={13} /> 添加模型
        </button>
      </div>
      {models.length === 0 && <div className="set-empty-mini">暂无模型，点击“添加模型”。</div>}
      {models.map((m, i) => (
        <ModelRow
          key={i}
          m={m}
          i={i}
          pfx={`m:${k}:${i}`}
          providerId={k}
          provider={def}
          language={language}
          patch={(p) => updateModel(i, p)}
          remove={() => deleteModel(i)}
          register={register}
        />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Main panel
 * ------------------------------------------------------------------ */

type Tab = "conversation" | "models" | "permissions" | "data" | "appearance" | "system";

/** Mirror of main's DataMigrationStatus (preload inlines the same shape). */
interface DataMigrationStatus {
  sessionStorageDir: string | null;
  defaultSessionsDir: string;
  effectiveSessionsDir: string;
  todoDataDir: string | null;
  effectiveTodosDir: string;
  pendingSessions: boolean;
  pendingTodos: boolean;
  lastSummary: {
    sessionsMoved?: number;
    sessionBytes?: number;
    todoFilesMoved?: number;
    todoBytes?: number;
    errors: string[];
  } | null;
}

interface NewProviderDraft {
  id: string;
  baseUrl: string;
  apiKey: string;
  api: ApiType;
  modelId: string;
}

const emptyNewProvider = (): NewProviderDraft => ({
  id: "",
  baseUrl: "",
  apiKey: "",
  api: "openai-completions",
  modelId: "",
});

/* ------------------------------------------------------------------ *
 * Preset provider templates ("预设供应商" grid)
 * ------------------------------------------------------------------ */

interface ProviderPreset {
  /** Provider id created when the user adds this preset. */
  key: string;
  name: string; // zh label (source language)
  enName: string;
  subtitle: string; // zh
  enSubtitle: string;
  monogram: string;
  color: string;
  baseUrl: string;
  api: ApiType;
  /** Optional first model id; empty = provider added without models. */
  modelId?: string;
}

const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    key: "bailian-api",
    name: "阿里云百炼 · API 按量付费",
    enName: "Bailian · Pay-as-you-go API",
    subtitle: "DashScope OpenAI 兼容端点",
    enSubtitle: "DashScope OpenAI-compatible endpoint",
    monogram: "百",
    color: "#ff6a00",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    api: "openai-completions",
    modelId: "qwen3-max",
  },
  {
    key: "bailian-coding",
    name: "阿里云百炼 · Coding Plan",
    enName: "Bailian · Coding Plan",
    subtitle: "Qwen 编程订阅套餐（sk-sp- 密钥）",
    enSubtitle: "Qwen coding subscription (sk-sp- key)",
    monogram: "码",
    color: "#ea580c",
    baseUrl: "https://coding.dashscope.aliyuncs.com/v1",
    api: "openai-completions",
    modelId: "qwen3-coder-plus",
  },
  {
    key: "zhipu",
    name: "智谱",
    enName: "Zhipu (GLM)",
    subtitle: "开放平台 OpenAI 兼容端点 · GLM 系列",
    enSubtitle: "Open platform, OpenAI-compatible endpoint · GLM models",
    monogram: "智",
    color: "#4f46e5",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    api: "openai-completions",
    modelId: "glm-5.3",
  },
  {
    // Key avoids clobbering pi's built-in "deepseek" provider catalog.
    key: "deepseek-api",
    name: "DeepSeek",
    enName: "DeepSeek",
    subtitle: "官方 API · deepseek-chat / deepseek-reasoner",
    enSubtitle: "Official API · deepseek-chat / deepseek-reasoner",
    monogram: "D",
    color: "#4f63d2",
    baseUrl: "https://api.deepseek.com/v1",
    api: "openai-completions",
    modelId: "deepseek-chat",
  },
  {
    key: "moonshot",
    name: "Kimi / Moonshot",
    enName: "Kimi / Moonshot",
    subtitle: "官方 API · kimi 系列模型",
    enSubtitle: "Official API · Kimi models",
    monogram: "K",
    color: "#1e3a8a",
    baseUrl: "https://api.moonshot.cn/v1",
    api: "openai-completions",
    modelId: "kimi-k3",
  },
  {
    key: "gemini",
    name: "Gemini",
    enName: "Gemini",
    subtitle: "Google 官方 API · gemini 系列模型",
    enSubtitle: "Official Google API · Gemini models",
    monogram: "G",
    color: "#4285f4",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    api: "google-generative-ai",
    modelId: "gemini-3.1-pro",
  },
  {
    // Key avoids clobbering pi's built-in "openai" provider catalog.
    key: "gpt",
    name: "GPT / OpenAI",
    enName: "GPT / OpenAI",
    subtitle: "官方 API · gpt-5 系列模型",
    enSubtitle: "Official API · GPT models",
    monogram: "O",
    color: "#111111",
    baseUrl: "https://api.openai.com/v1",
    api: "openai-completions",
    modelId: "gpt-5",
  },
];

/** Dashed entry card for self-hosted endpoints (Ollama / LM Studio / llama.cpp). */
const LOCAL_DEPLOY_PRESET: ProviderPreset = {
  key: "local",
  name: "本地部署",
  enName: "Local deploy",
  subtitle: "Ollama · LM Studio · llama.cpp 等自托管服务",
  enSubtitle: "Self-hosted services such as Ollama, LM Studio, llama.cpp",
  monogram: "+",
  color: "#52525b",
  baseUrl: "http://localhost:11434/v1",
  api: "openai-completions",
};

/** Host of a base URL ("" when unset/invalid) — used to match presets against configured providers. */
function hostOf(url?: string): string {
  try {
    const host = new URL(url || "").host;
    return host ? host.toLowerCase() : "";
  } catch {
    return "";
  }
}


/** Downscale an uploaded avatar to a small data URL so config.json stays tiny. */
async function downscaleImageFile(file: File, maxSize = 192): Promise<string> {
  const rawUrl = await new Promise<string>((resolveUrl, rejectUrl) => {
    const reader = new FileReader();
    reader.onload = () => resolveUrl(String(reader.result));
    reader.onerror = () => rejectUrl(new Error("read failed"));
    reader.readAsDataURL(file);
  });
  const image = await new Promise<HTMLImageElement>((resolveImg, rejectImg) => {
    const el = new Image();
    el.onload = () => resolveImg(el);
    el.onerror = () => rejectImg(new Error("decode failed"));
    el.src = rawUrl;
  });
  const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas unavailable");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, width, height);
  let dataUrl = canvas.toDataURL("image/png");
  // Photos can bloat as PNG; fall back to JPEG when the downscaled result is large.
  if (dataUrl.length > 400_000) {
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    dataUrl = canvas.toDataURL("image/jpeg", 0.85);
  }
  return dataUrl;
}

/* ------------------------------------------------------------------ *
 * Archive tab helpers
 * ------------------------------------------------------------------ */

/** Last path segment of a folder/file path (compact display name). */
function pathBase(p: string): string {
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
}

/** Second-to-last path segment — the sessions subdirectory a session file lives in. */
function pathDirName(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : "";
}

/** Human-friendly timestamp: today → HH:mm, this year → “Sep 8 14:30”, older → full date. */
function formatWhen(ts?: number, language?: string): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const locale = language === "zh" ? "zh-CN" : "en-US";
  const time = d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return time;
  if (d.getFullYear() === now.getFullYear()) {
    return `${d.toLocaleDateString(locale, { month: "short", day: "numeric" })} ${time}`;
  }
  return d.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
}

interface ArchiveGroup<T> {
  cwd: string;
  name: string;
  items: T[];
  latest: number;
}

/** Group rows by owning project (cwd); newest group and item first. */
function groupByCwd<T>(items: T[], getCwd: (item: T) => string, getTs: (item: T) => number | undefined): ArchiveGroup<T>[] {
  const map = new Map<string, ArchiveGroup<T>>();
  for (const item of items) {
    const cwd = getCwd(item);
    let group = map.get(cwd.toLowerCase());
    if (!group) {
      group = { cwd, name: pathBase(cwd), items: [], latest: 0 };
      map.set(cwd.toLowerCase(), group);
    }
    group.items.push(item);
    const ts = getTs(item) || 0;
    if (ts > group.latest) group.latest = ts;
  }
  for (const group of map.values()) {
    group.items.sort((a, b) => (getTs(b) || 0) - (getTs(a) || 0));
  }
  return [...map.values()].sort((a, b) => b.latest - a.latest);
}

/** Stable string key for a voice config (order-independent, ignores cleared keys). */
function canonVoice(v: Record<string, unknown> | undefined): string {
  if (!v) return "{}";
  return JSON.stringify(
    Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => [k, v[k]]),
  );
}

/** Every persisted voice key — sent on save so cleared fields really clear. */
const VOICE_KEYS = [
  "sttBackend",
  "sttProviderId",
  "sttBaseUrl",
  "sttApiKey",
  "sttModel",
  "ttsVoiceUri",
  "ttsBackend",
  "ttsEdgeVoice",
  "ttsRate",
  "ttsAutoRead",
] as const;

export function Settings() {
  const open = useStore((s) => s.settingsOpen);
  const close = useStore((s) => s.closeSettings);
  const pushToast = useStore((s) => s.pushToast);
  const config = useStore((s) => s.config);
  const restoreProject = useStore((s) => s.restoreProject);
  const restoreThread = useStore((s) => s.restoreThread);
  const loadTrash = useStore((s) => s.loadTrash);
  const trashEntries = useStore((s) => s.trashEntries);
  const restoreFromTrash = useStore((s) => s.restoreFromTrash);
  const purgeFromTrash = useStore((s) => s.purgeFromTrash);
  const emptyTrash = useStore((s) => s.emptyTrash);
  const refreshOpenThreadModels = useStore((s) => s.refreshOpenThreadModels);
  const projects = useStore((s) => s.projects);
  const language = config?.language || "en";

  const [tab, setTab] = useState<Tab>("conversation");
  // Auto-launch at system login — OS-level state (Electron login items), not
  // config.json; read live each time settings opens, edited as a draft.
  useEffect(() => {
    if (!open) return;
    window.pi.app
      .getAutoLaunch()
      .then((v) => {
        const seeded = { autoLaunch: v === true };
        setSysDraft(seeded);
        setInitialSys(JSON.stringify(seeded));
      })
      .catch(() => setInitialSys(JSON.stringify({ autoLaunch: false })));
  }, [open]);
  // Data storage locations (Settings → 数据管理): live status from main.
  const [migStatus, setMigStatus] = useState<DataMigrationStatus | null>(null);
  useEffect(() => {
    if (!open) return;
    window.pi.dataMigration.status().then(setMigStatus).catch(() => setMigStatus(null));
  }, [open]);
  const refreshMigStatus = () => window.pi.dataMigration.status().then(setMigStatus).catch(() => {});

  // Trash confirmation dialogs (per-item purge / empty-all).
  const [trashPurgeConfirm, setTrashPurgeConfirm] = useState<{ id: string; title: string } | null>(null);
  const [trashEmptyConfirm, setTrashEmptyConfirm] = useState(false);
  // Refresh the trash list whenever the archive tab is visible (deletes happen
  // in the sidebar, so there is no other signal to reload on).
  useEffect(() => {
    if (open && tab === "data") loadTrash();
  }, [open, tab, loadTrash]);
  // Archive tab: search query + collapsed project groups (lowercased cwd keys).
  const [archiveQuery, setArchiveQuery] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!open) setArchiveQuery("");
  }, [open]);
  const toggleGroup = useCallback((cwd: string) => {
    const key = cwd.toLowerCase();
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const archiveQueryTrimmed = archiveQuery.trim().toLowerCase();
  const matchesArchive = (...fields: Array<string | undefined>) =>
    !archiveQueryTrimmed || fields.some((f) => f && f.toLowerCase().includes(archiveQueryTrimmed));
  const filteredArchivedProjects = (config?.archivedProjects || []).filter((cwd) => matchesArchive(cwd));
  const filteredArchivedThreads = (config?.archivedThreads || []).filter((t) => matchesArchive(t.title, t.cwd, t.file));
  const filteredTrashEntries = trashEntries.filter((e) => matchesArchive(e.title, e.cwd, e.originalFile));
  const threadGroups = groupByCwd(filteredArchivedThreads, (t) => t.cwd || "", (t) => t.archivedAt);
  const trashGroups = groupByCwd(filteredTrashEntries, (e) => e.cwd || "", (e) => e.deletedAt);
  const archiveResultCount = filteredArchivedProjects.length + filteredArchivedThreads.length + filteredTrashEntries.length;
  const [draft, setDraft] = useState<ModelsFile>({ providers: {} });
  const [initialProviders, setInitialProviders] = useState("{}");
  const [thinking, setThinking] = useState<ThinkingDefaults>({});
  const [initialThinking, setInitialThinking] = useState("{}");
  // ---- Q&A style (config.qaMode; "inline" is the default) -------------------
  const [qaDraft, setQaDraft] = useState<"inline" | "manual">("inline");
  // ---- smart-compaction summary model (saved immediately; the extension re-reads
  // config.json on every compaction, so no restart is needed) -----------------
  const [scProvider, setScProvider] = useState("");
  const [scModelId, setScModelId] = useState("");
  // ---- 记忆模型（知芽记忆池用它做抽取/打分与 lesson 正文；未设置 = 本机 LM Studio）
  const [mmMode, setMmMode] = useState<"none" | "session" | "model">("none");
  const [mmProvider, setMmProvider] = useState("");
  const [mmModelId, setMmModelId] = useState("");
  const [invalidJson, setInvalidJson] = useState<Record<string, boolean>>({});
  // ---- trusted tools (“始终允许该工具”) + default permission ----------------
  // Permission settings are edited as a draft and only written on save, matching
  // the models/thinking/profile pattern. The trusted list is also written by the
  // approval card (“始终允许”); we re-seed on every open so it stays in sync.
  const [trustDraft, setTrustDraft] = useState("");
  const [permDraft, setPermDraft] = useState<{ defaultPermission: PermissionLevel; trustedTools: string[] }>({
    defaultPermission: "sandbox",
    trustedTools: [],
  });
  const [initialPerms, setInitialPerms] = useState("");
  const [dataDraft, setDataDraft] = useState<{ trashEnabled: boolean }>({ trashEnabled: true });
  const [initialData, setInitialData] = useState("");
  const [sysDraft, setSysDraft] = useState<{ autoLaunch: boolean }>({ autoLaunch: false });
  const [initialSys, setInitialSys] = useState("");
  const [voiceDraft, setVoiceDraft] = useState<NonNullable<AppConfig["voice"]>>({});
  const [initialVoice, setInitialVoice] = useState("{}");
  const setTrustedTools = (next: string[]) => setPermDraft((d) => ({ ...d, trustedTools: next }));
  const addTrustedTool = () => {
    const name = trustDraft.trim();
    if (!name) return;
    if (!isTrustableToolName(name)) {
      pushToast(
        "warning",
        language === "zh"
          ? `${name} 不能加入信任列表（bash / 写入 / 编辑工具永不被信任）。`
          : `${name} cannot be trusted (bash / write / edit are never trusted).`,
      );
      return;
    }
    setTrustDraft("");
    if (permDraft.trustedTools.includes(name)) return;
    setTrustedTools([...permDraft.trustedTools, name]);
  };

  // Trusted-tools picker data: tools observed in this profile's sessions (main
  // records every tool_execution_start + one-time backfill from history), so
  // users toggle from a searchable list instead of typing exact names.
  const [toolQuery, setToolQuery] = useState("");
  const [toolFilter, setToolFilter] = useState<ToolTrustFilter>("all");
  const [observedTools, setObservedTools] = useState<ObservedToolInfo[]>([]);
  useEffect(() => {
    if (tab !== "permissions") return;
    const listApi = window.pi.observedTools; // absent on older preloads
    if (!listApi) return;
    let alive = true;
    listApi
      .list()
      .then((list) => {
        if (alive) setObservedTools(list);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [tab]);

  // Candidate rows = observed ∪ currently trusted ∪ common presets, classified.
  const toolRows: TrustPickerRow[] = useMemo(() => {
    const names = new Set<string>();
    for (const t of observedTools) names.add(t.name);
    for (const t of permDraft.trustedTools) if (t.trim()) names.add(t.trim());
    for (const p of COMMON_EXTENSION_TOOLS) names.add(p.name);
    const q = toolQuery.trim().toLowerCase();
    return [...names]
      .filter((n) => !q || n.toLowerCase().includes(q))
      .sort((a, b) => a.localeCompare(b))
      .map<TrustPickerRow>((name) => {
        const kind = classifyToolName(name, permDraft.trustedTools);
        if (kind === "never-trustable") {
          return {
            name,
            trusted: false,
            actionable: false,
            badge: language === "zh" ? "始终需确认 · 不可信任" : "Always confirms · cannot be trusted",
          };
        }
        if (kind === "no-approval") {
          return { name, trusted: false, actionable: false, badge: language === "zh" ? "无需审批" : "No approval needed" };
        }
        const preset = COMMON_EXTENSION_TOOLS.find((p) => p.name === name);
        return {
          name,
          trusted: kind === "trusted",
          actionable: true,
          subtitle: preset ? (language === "zh" ? preset.zh : preset.en) : undefined,
        };
      });
  }, [observedTools, permDraft.trustedTools, toolQuery, language]);

  const toolCounts = useMemo(() => {
    let trusted = 0;
    for (const r of toolRows) if (r.trusted) trusted++;
    return { all: toolRows.length, trusted, untrusted: toolRows.length - trusted };
  }, [toolRows]);

  const visibleToolRows = useMemo(
    () => toolRows.filter((r) => (toolFilter === "all" ? true : toolFilter === "trusted" ? r.trusted : !r.trusted)),
    [toolRows, toolFilter],
  );
  const [saving, setSaving] = useState<null | "models" | "thinking" | "permissions" | "data" | "system" | "conversation">(null);
  const [flash, setFlash] = useState<null | "models" | "thinking" | "permissions" | "data" | "system" | "conversation">(null);
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  // Shell runtime card: seeded from diagnostics, replaceable by an explicit
  // re-check (which is what adopts a just-installed Git into settings.json).
  const [shellInfo, setShellInfo] = useState<ShellDiagnostics | null>(null);
  const [shellBusy, setShellBusy] = useState(false);
  const [paths, setPaths] = useState<{ agentDir: string; models: string; settings: string; auth: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [newProvider, setNewProvider] = useState<NewProviderDraft>(emptyNewProvider);
  // Models tab two-section layout: preset search query + which configured
  // provider is expanded into the full editor below the tile grid.
  const [presetQuery, setPresetQuery] = useState("");
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);

  // ---- Voice system (Settings → Conversation → 语音系统) -------------------------
  // STT credential sources come from models.json; TTS voices from the platform
  // speechSynthesis. Both load when settings opens.
  const [sttProviders, setSttProviders] = useState<{ id: string; baseUrl?: string }[]>([]);
  const [ttsVoiceList, setTtsVoiceList] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceTesting, setVoiceTesting] = useState(false);
  // Dev instances started before this feature shipped lack window.pi.voice —
  // guard call sites and tell the user to fully restart (see backupApi).
  const voiceApi = typeof window.pi?.voice === "object" && window.pi.voice ? window.pi.voice : null;
  useEffect(() => {
    if (!open) return;
    window.pi.settings
      .getModels()
      .then((m: ModelsFile) => setSttProviders(Object.entries(m.providers || {}).map(([id, p]) => ({ id, baseUrl: p.baseUrl }))))
      .catch(() => setSttProviders([]));
    const loadVoices = () => setTtsVoiceList(ttsVoices());
    loadVoices();
    // Voices often arrive asynchronously on first access; poll briefly.
    let tries = 0;
    const timer = window.setInterval(() => {
      tries += 1;
      if (ttsVoices().length > 0 || tries >= 6) {
        clearInterval(timer);
        loadVoices();
      }
    }, 500);
    return () => clearInterval(timer);
  }, [open]);
  // Voices matching the UI language first (stable sort keeps platform order).
  const sortedTtsVoices = useMemo(() => {
    const target = language === "zh" ? "zh" : "en";
    return [...ttsVoiceList].sort(
      (a, b) => Number((b.lang || "").toLowerCase().startsWith(target)) - Number((a.lang || "").toLowerCase().startsWith(target)),
    );
  }, [ttsVoiceList, language]);

  // ---- Backup & restore tab ---------------------------------------------
  // Project groups come from main (dirName = sessions subdirectory); the
  // friendly project name is decorated from the sidebar's live projects.
  const [bkGroups, setBkGroups] = useState<{ dirName: string; count: number; totalBytes: number }[] | null>(null);
  const [bkSelected, setBkSelected] = useState<ReadonlySet<string>>(new Set());
  const [bkBusy, setBkBusy] = useState<null | "exportConfig" | "importConfig" | "exportSessions" | "importSessions">(null);
  // Two-stage import previews: config patch (from pickConfigImport) and the
  // session zip summary (from pickSessionImport). null = no pending confirm.
  const [configImportPreview, setConfigImportPreview] = useState<{ fields: string[]; patch: Record<string, unknown> } | null>(null);
  const [sessionImportPreview, setSessionImportPreview] = useState<{ path: string; total: number; newCount: number; existingCount: number } | null>(null);
  // Dev instances started before this feature shipped lack window.pi.backup —
  // guard every call site and tell the user to fully restart (see reorderPinned).
  const backupApi = typeof window.pi?.backup === "object" && window.pi.backup ? window.pi.backup : null;
  useEffect(() => {
    if (!open || tab !== "data") return;
    setBkGroups(null);
    if (!backupApi) {
      setBkGroups([]);
      return;
    }
    backupApi
      .listSessions()
      .then((groups) => {
        setBkGroups(groups);
        setBkSelected(new Set(groups.map((g) => g.dirName)));
      })
      .catch(() => setBkGroups([]));
  }, [open, tab, backupApi]);
  const bkDirNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of projects) {
      for (const t of p.threads) {
        const dirName = pathDirName(t.file);
        if (dirName && !map.has(dirName)) map.set(dirName, p.name);
      }
    }
    return map;
  }, [projects]);
  const bkSelectedBytes = useMemo(
    () => (bkGroups || []).filter((g) => bkSelected.has(g.dirName)).reduce((sum, g) => sum + g.totalBytes, 0),
    [bkGroups, bkSelected],
  );
  const toggleBkDir = useCallback((dirName: string) => {
    setBkSelected((prev) => {
      const next = new Set(prev);
      if (next.has(dirName)) next.delete(dirName);
      else next.add(dirName);
      return next;
    });
  }, []);

  const backupUnavailableToast = () =>
    pushToast(
      "warning",
      language === "zh"
        ? "备份功能不可用：请完整重启 MPI（当前 dev 实例早于该功能启动）。"
        : "Backup unavailable: fully restart MPI (this dev instance predates the feature).",
    );

  const doExportConfig = async () => {
    if (!backupApi) return backupUnavailableToast();
    setBkBusy("exportConfig");
    try {
      const r = await backupApi.exportConfig();
      if (r === null) return; // user canceled the save dialog
      if (!r.ok) throw new Error(r.error || "unknown error");
      pushToast("info", language === "zh" ? `配置已导出：${r.path}` : `Config exported: ${r.path}`);
    } catch (e: any) {
      pushToast("error", (language === "zh" ? "导出失败：" : "Export failed: ") + (e?.message || e));
    } finally {
      setBkBusy(null);
    }
  };

  const doPickConfigImport = async () => {
    if (!backupApi) return backupUnavailableToast();
    setBkBusy("importConfig");
    try {
      const r = await backupApi.pickConfigImport();
      if (r === null) return;
      if (!r.ok) throw new Error(r.error);
      setConfigImportPreview({ fields: r.fields, patch: r.patch });
    } catch (e: any) {
      pushToast("error", (language === "zh" ? "读取备份失败：" : "Failed to read backup: ") + (e?.message || e));
    } finally {
      setBkBusy(null);
    }
  };

  const doApplyConfigImport = async () => {
    const preview = configImportPreview;
    if (!preview) return;
    setConfigImportPreview(null);
    setBkBusy("importConfig");
    try {
      // Reuse app:setConfig so warm-bridge / remote-host side effects run once.
      const next = await window.pi.app.setConfig(preview.patch as Record<string, unknown>);
      useStore.setState({ config: next });
      pushToast(
        "info",
        language === "zh"
          ? `已导入 ${preview.fields.length} 项设置。`
          : `Imported ${preview.fields.length} setting${preview.fields.length === 1 ? "" : "s"}.`,
      );
    } catch (e: any) {
      pushToast("error", (language === "zh" ? "导入失败：" : "Import failed: ") + (e?.message || e));
    } finally {
      setBkBusy(null);
    }
  };

  const doExportSessions = async () => {
    if (!backupApi) return backupUnavailableToast();
    const names = [...bkSelected];
    if (names.length === 0) return;
    setBkBusy("exportSessions");
    try {
      const r = await backupApi.exportSessions(names);
      if (r === null) return;
      if (!r.ok) throw new Error(r.error || "unknown error");
      pushToast(
        "info",
        language === "zh"
          ? `已导出 ${r.count} 个会话：${r.path}`
          : `Exported ${r.count} session${r.count === 1 ? "" : "s"}: ${r.path}`,
      );
    } catch (e: any) {
      pushToast("error", (language === "zh" ? "导出失败：" : "Export failed: ") + (e?.message || e));
    } finally {
      setBkBusy(null);
    }
  };

  const doPickSessionImport = async () => {
    if (!backupApi) return backupUnavailableToast();
    setBkBusy("importSessions");
    try {
      const r = await backupApi.pickSessionImport();
      if (r === null) return;
      if (!r.ok) throw new Error(r.error);
      setSessionImportPreview({ path: r.path, total: r.total, newCount: r.newCount, existingCount: r.existingCount });
    } catch (e: any) {
      pushToast("error", (language === "zh" ? "读取备份失败：" : "Failed to read backup: ") + (e?.message || e));
    } finally {
      setBkBusy(null);
    }
  };

  const doImportSessions = async (policy: "skip" | "overwrite") => {
    if (!backupApi) return backupUnavailableToast();
    const preview = sessionImportPreview;
    if (!preview) return;
    setSessionImportPreview(null);
    setBkBusy("importSessions");
    try {
      const r = await backupApi.importSessions({ path: preview.path, policy });
      if (!r.ok) throw new Error(r.error || "unknown error");
      pushToast(
        "info",
        language === "zh"
          ? (r.imported
              ? `已导入 ${r.imported} 个会话${r.skipped ? `，跳过 ${r.skipped} 个已存在` : ""}${r.overwritten ? `，覆盖 ${r.overwritten} 个` : ""}。`
              : r.overwritten
                ? `已按备份恢复（覆盖）${r.overwritten} 个会话。`
                : `没有可导入的会话（${r.skipped ?? 0} 个已存在）。`)
          : (r.imported
              ? `Imported ${r.imported} session${r.imported === 1 ? "" : "s"}${r.skipped ? `, skipped ${r.skipped} existing` : ""}${r.overwritten ? `, overwrote ${r.overwritten}` : ""}.`
              : r.overwritten
                ? `Restored (overwrote) ${r.overwritten} session${r.overwritten === 1 ? "" : "s"} from the backup.`
                : `Nothing to import (${r.skipped ?? 0} already present).`),
      );
    } catch (e: any) {
      pushToast("error", (language === "zh" ? "导入失败：" : "Import failed: ") + (e?.message || e));
    } finally {
      setBkBusy(null);
    }
  };

  const register = useCallback((p: string, ok: boolean) => setInvalidJson((s) => ({ ...s, [p]: ok })), []);

  useEffect(() => {
    if (!open) return;
    setTab("conversation");
    setInvalidJson({});
    setAdding(false);
    setNewProvider(emptyNewProvider());
    setPresetQuery("");
    setExpandedProvider(null);
    // Permission draft (default level + trusted tools) — seeded per open so
    // approval-card “始终允许” additions show up next time Settings opens.
    const seededPerms = {
      defaultPermission: (config?.defaultPermission || "sandbox") as PermissionLevel,
      trustedTools: [...(config?.trustedTools || [])],
    };
    setPermDraft(seededPerms);
    setInitialPerms(JSON.stringify(seededPerms));
    const seededData = { trashEnabled: config?.trashEnabled !== false };
    setDataDraft(seededData);
    setInitialData(JSON.stringify(seededData));
    const seededVoice = { ...(config?.voice || {}) };
    setVoiceDraft(seededVoice);
    setInitialVoice(canonVoice(seededVoice));
    setQaDraft(config?.qaMode || "inline");
    (async () => {
      try {
        const [models, think, d, p] = await Promise.all([
          window.pi.settings.getModels(),
          window.pi.settings.getThinking(),
          window.pi.settings.getDiagnostics(),
          window.pi.settings.getPaths(),
        ]);
        setDraft(clone(models));
        setInitialProviders(JSON.stringify(models.providers || {}));
        setThinking(think || {});
        setInitialThinking(JSON.stringify(think || {}));
        const scModel = useStore.getState().config?.smartCompact?.model;
        if (typeof scModel === "string" && scModel.includes("/")) {
          const [sp, ...sm] = scModel.split("/");
          setScProvider(sp);
          setScModelId(sm.join("/"));
        } else {
          setScProvider("");
          setScModelId("");
        }
        const mm = useStore.getState().config?.memoryModel;
        const mmModeRaw = mm?.mode ?? (mm?.provider && mm?.model ? "model" : "none");
        setMmMode(mmModeRaw === "session" ? "session" : mmModeRaw === "model" ? "model" : "none");
        setMmProvider(typeof mm?.provider === "string" ? mm.provider : "");
        setMmModelId(typeof mm?.model === "string" ? mm.model : "");
        setDiag(d);
        setShellInfo(d.shell ?? null);
        setPaths(p);
      } catch (e: any) {
        pushToast("error", "读取配置失败：" + (e?.message || e));
      }
    })();
  }, [open, pushToast]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") attemptClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, draft, thinking, initialProviders, initialThinking]);

  const modelDirty = useMemo(() => JSON.stringify(draft.providers) !== initialProviders, [draft.providers, initialProviders]);
  const thinkDirty = useMemo(() => JSON.stringify(thinking) !== initialThinking, [thinking, initialThinking]);
  const permDirty = useMemo(() => JSON.stringify(permDraft) !== initialPerms, [permDraft, initialPerms]);
  const dataDirty = useMemo(() => JSON.stringify(dataDraft) !== initialData, [dataDraft, initialData]);
  const sysDirty = useMemo(() => initialSys !== "" && JSON.stringify(sysDraft) !== initialSys, [sysDraft, initialSys]);
  const voiceDirty = useMemo(() => canonVoice(voiceDraft) !== initialVoice, [voiceDraft, initialVoice]);
  const qaDirty = useMemo(() => qaDraft !== (config?.qaMode || "inline"), [qaDraft, config]);
  // Re-sync the voice draft when main's persisted voice config changes behind us —
  // e.g. an app-store enable writes sttBaseUrl/sttModel while Settings is open.
  // Skipped while the user has unsaved voice edits so their draft stays intact;
  // without this, a stale draft flushed later would wipe values written by other writers.
  const persistedVoiceSig = canonVoice(config?.voice);
  useEffect(() => {
    if (!open || voiceDirty) return;
    const seeded = { ...(config?.voice || {}) };
    setVoiceDraft(seeded);
    setInitialVoice(canonVoice(seeded));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistedVoiceSig]);
  function attemptClose() {
    if (
      (modelDirty || thinkDirty || permDirty || dataDirty || sysDirty || voiceDirty || qaDirty) &&
      !window.confirm(language === "zh" ? "有未保存的更改，确定放弃并关闭？" : "Discard unsaved changes and close?")
    ) return;
    close();
  }

  /* ---- model mutations (spread preserves unknown fields) ---- */
  const updateProvider = (k: string, p: Partial<ProviderDef>) =>
    setDraft((d) => ({ ...d, providers: { ...d.providers, [k]: { ...d.providers[k], ...p } } }));
  const renameProvider = (from: string, rawName: string): boolean => {
    const to = rawName.trim();
    if (!to) {
      pushToast("warning", language === "zh" ? "供应商名称不能为空" : "Provider name cannot be empty.");
      return false;
    }
    if (to === from) return true;
    if (draft.providers[to]) {
      pushToast("error", language === "zh" ? "该供应商名称已存在" : "That provider name already exists.");
      return false;
    }
    setDraft((current) => ({
      ...current,
      providers: Object.fromEntries(
        Object.entries(current.providers).map(([key, value]) => (key === from ? [to, value] : [key, value])),
      ),
    }));
    setInvalidJson((current) =>
      Object.fromEntries(
        Object.entries(current).map(([path, valid]) => [
          path.replace(`p:${from}:`, `p:${to}:`).replace(`m:${from}:`, `m:${to}:`),
          valid,
        ]),
      ),
    );
    setExpandedProvider((cur) => (cur === from ? to : cur));
    return true;
  };
  const updateModel = (k: string, i: number, p: Partial<ModelDef>) =>
    setDraft((d) => {
      const prov = d.providers[k];
      const models = [...(prov.models || [])];
      models[i] = { ...models[i], ...p };
      return { ...d, providers: { ...d.providers, [k]: { ...prov, models } } };
    });
  const addModel = (k: string) => updateProvider(k, { models: [...(draft.providers[k].models || []), { id: "" }] });
  const deleteModel = (k: string, i: number) =>
    setDraft((d) => {
      const prov = d.providers[k];
      const models = (prov.models || []).filter((_, idx) => idx !== i);
      return { ...d, providers: { ...d.providers, [k]: { ...prov, models } } };
    });
  const deleteProvider = (k: string) => {
    const question = language === "zh" ? `删除提供商 “${k}” 及其全部模型？` : `Delete provider “${k}” and all of its models?`;
    if (!window.confirm(question)) return;
    setExpandedProvider((cur) => (cur === k ? null : cur));
    setDraft((d) => {
      const p = { ...d.providers };
      delete p[k];
      return { ...d, providers: p };
    });
  };
  const confirmAddProvider = () => {
    const id = newProvider.id.trim();
    const baseUrl = newProvider.baseUrl.trim();
    const modelId = newProvider.modelId.trim();
    if (!id) return pushToast("warning", language === "zh" ? "请输入供应商名称" : "Enter a provider name.");
    if (!baseUrl) return pushToast("warning", language === "zh" ? "请输入 API 地址" : "Enter the API URL.");
    if (draft.providers[id]) return pushToast("error", language === "zh" ? "该供应商名称已存在" : "That provider name already exists.");
    const provider: ProviderDef = {
      baseUrl,
      api: newProvider.api,
      apiKey: newProvider.apiKey.trim() || undefined,
      // Model ID is optional (local deploys often add models later).
      models: modelId ? [{ id: modelId, name: modelId }] : [],
    };
    setDraft((d) => ({ ...d, providers: { ...d.providers, [id]: provider } }));
    setAdding(false);
    setNewProvider(emptyNewProvider());
    // Reveal the new provider's editor so connection details can be refined right away.
    setExpandedProvider(id);
  };

  /* ---- models tab: preset grid + expanded provider helpers ---- */
  /** Provider key this preset maps to, or null when not configured yet.
   * Matches by provider id first, then by endpoint host (hand-written/renamed entries). */
  const configuredKeyFor = (preset: ProviderPreset): string | null => {
    if (draft.providers[preset.key]) return preset.key;
    const host = hostOf(preset.baseUrl);
    if (!host) return null;
    return Object.keys(draft.providers).find((k) => hostOf(draft.providers[k]?.baseUrl) === host) || null;
  };
  const openAddForm = (preset: ProviderPreset | null) => {
    setNewProvider(
      preset
        ? { id: preset.key, baseUrl: preset.baseUrl, apiKey: "", api: preset.api, modelId: preset.modelId || "" }
        : emptyNewProvider(),
    );
    setAdding(true);
  };
  /** Preset already configured? Expand its editor; otherwise open the prefilled add form. */
  const onPresetClick = (preset: ProviderPreset) => {
    const configuredKey = configuredKeyFor(preset);
    if (configuredKey) setExpandedProvider(configuredKey);
    else openAddForm(preset);
  };
  const reloadModels = async () => {
    if (
      modelDirty &&
      !window.confirm(
        language === "zh"
          ? "将丢弃未保存的模型编辑并重新读取 models.json，继续？"
          : "Discard unsaved model changes and reload models.json?",
      )
    ) return;
    const models = await window.pi.settings.getModels();
    setDraft(clone(models));
    setInitialProviders(JSON.stringify(models.providers || {}));
    setInvalidJson({});
  };

  /* ---- save ---- */
  const saveModels = async () => {
    if (Object.values(invalidJson).some((valid) => !valid)) return pushToast("error", "请先修正标红的高级 JSON 字段");
    setSaving("models");
    try {
      const saved = await window.pi.settings.saveModels(draft.providers);
      const savedModels = saved?.models as ModelsFile | undefined;
      if (savedModels) {
        setDraft(clone(savedModels));
        setInitialProviders(JSON.stringify(savedModels.providers || {}));
      } else {
        setInitialProviders(JSON.stringify(draft.providers));
      }
      await refreshOpenThreadModels();
      setFlash("models");
      setTimeout(() => setFlash(null), 1500);
      pushToast(
        "info",
        language === "zh"
          ? "模型配置已保存，新模型现在可在对话框中选择。"
          : "Model settings saved. New models are now available in the composer.",
      );
    } catch (e: any) {
      pushToast("error", "保存失败：" + (e?.message || e));
    } finally {
      setSaving(null);
    }
  };
  /** Write the voice draft to config.json (used by save + voice test/preview). */
  const flushVoice = async () => {
    const patch: Record<string, unknown> = {};
    for (const k of VOICE_KEYS) patch[k] = (voiceDraft as Record<string, unknown>)[k];
    const current = useStore.getState().config?.voice || {};
    const nextVoice: Record<string, unknown> = { ...current, ...patch };
    for (const k of Object.keys(nextVoice)) if (nextVoice[k] === undefined) delete nextVoice[k];
    const cfg = await window.pi.app.setConfig({ voice: nextVoice });
    useStore.setState({ config: cfg });
    const seeded = { ...(cfg?.voice || {}) };
    setVoiceDraft(seeded);
    setInitialVoice(canonVoice(seeded));
  };

  const saveConversation = async () => {
    setSaving("conversation");
    try {
      const res = await window.pi.settings.saveThinking(thinking as Record<string, unknown>);
      setThinking(res);
      setInitialThinking(JSON.stringify(res));
      if (qaDirty) {
        // config.json; main rebuilds the warm bridge so new sessions pick it up.
        const cfg = await window.pi.app.setConfig({ qaMode: qaDraft });
        useStore.setState({ config: cfg });
      }
      await flushVoice();
      setFlash("conversation");
      setTimeout(() => setFlash(null), 1500);
      pushToast("info", language === "zh" ? "对话设置已保存。" : "Conversation settings saved.");
    } catch (e: any) {
      pushToast("error", (language === "zh" ? "保存失败：" : "Save failed: ") + (e?.message || e));
    } finally {
      setSaving(null);
    }
  };

  /** Smart-compaction summary model → config.json (smartCompact.model). The
   * mpi-smart-compact extension re-reads the file on every compaction, so the
   * change applies from the next compaction without a restart. */
  const saveSmartCompact = async (provider?: string, modelId?: string) => {
    const model = provider && modelId ? `${provider}/${modelId}` : undefined;
    try {
      const next = await window.pi.app.setConfig({ smartCompact: model ? { model } : undefined });
      useStore.setState({ config: next });
    } catch (e: any) {
      pushToast("error", (language === "zh" ? "保存失败：" : "Save failed: ") + (e?.message || e));
    }
  };

  /** 记忆模型 → config.json（memoryModel）。主进程每次用前解析（dream 立即生效）；
   *  捕获扩展在**下一个会话**启动时才拿到新的端点环境变量。 */
  const saveMemoryModel = async (mode: "none" | "session" | "model", provider?: string, modelId?: string) => {
    const patch =
      mode === "session"
        ? { memoryModel: { mode } }
        : mode === "model" && provider && modelId
          ? { memoryModel: { mode, provider, model: modelId } }
          : { memoryModel: { mode: "none" } };
    try {
      const next = await window.pi.app.setConfig(patch);
      useStore.setState({ config: next });
    } catch (e: any) {
      pushToast("error", (language === "zh" ? "保存失败：" : "Save failed: ") + (e?.message || e));
    }
  };

  const savePermissions = async () => {
    setSaving("permissions");
    try {
      const next = await window.pi.app.setConfig({
        defaultPermission: permDraft.defaultPermission,
        trustedTools: permDraft.trustedTools.length ? permDraft.trustedTools : undefined,
      });
      useStore.setState({ config: next });
      const stored = {
        defaultPermission: (next?.defaultPermission || "sandbox") as PermissionLevel,
        trustedTools: [...(next?.trustedTools || [])],
      };
      setPermDraft(stored);
      setInitialPerms(JSON.stringify(stored));
      setFlash("permissions");
      setTimeout(() => setFlash(null), 1500);
      pushToast("info", language === "zh" ? "权限设置已保存。" : "Permission settings saved.");
    } catch (e: any) {
      pushToast("error", (language === "zh" ? "保存失败：" : "Save failed: ") + (e?.message || e));
    } finally {
      setSaving(null);
    }
  };

  // Avatar file-input refs — must stay above the early return (Rules of Hooks).
  const userAvatarInputRef = useRef<HTMLInputElement>(null);
  const agentAvatarInputRef = useRef<HTMLInputElement>(null);
  // Scroll the expanded provider editor into view when it opens.
  const detailRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!expandedProvider) return;
    const timer = window.setTimeout(
      () => detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
      30,
    );
    return () => window.clearTimeout(timer);
  }, [expandedProvider]);
  // The add form renders at the top of section 1; scroll to it when opened
  // from a button further down (e.g. “添加供应商” in section 2).
  const addFormRef = useRef<HTMLFormElement | null>(null);
  useEffect(() => {
    if (!adding) return;
    const timer = window.setTimeout(
      () => addFormRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
      30,
    );
    return () => window.clearTimeout(timer);
  }, [adding]);

  if (!open) return null;

  const providerKeys = Object.keys(draft.providers);
  const defaultModelDefs = thinking.defaultProvider ? draft.providers[thinking.defaultProvider]?.models || [] : [];
  const defaultModels = defaultModelDefs.map((m) => m.id);
  const selectedDefaultModel = defaultModelDefs.find((m) => m.id === thinking.defaultModel);
  const availableThinkingLevels = supportedThinkingLevels(selectedDefaultModel);

  // Preset grid search filter (matches zh/en names, subtitles and provider key).
  const presetQueryTrimmed = presetQuery.trim().toLowerCase();
  const visiblePresets = PROVIDER_PRESETS.filter(
    (p) =>
      !presetQueryTrimmed ||
      [p.name, p.enName, p.subtitle, p.enSubtitle, p.key].some((s) => s.toLowerCase().includes(presetQueryTrimmed)),
  );

  const changeLanguage = async (language: "en" | "zh") => {
    const next = await window.pi.app.setConfig({ language });
    useStore.setState({ config: next });
  };

  const changeTheme = async (theme: "dark" | "light" | "system") => {
    const next = await window.pi.app.setConfig({ theme });
    useStore.setState({ config: next });
  };

  const saveData = async () => {
    setSaving("data");
    try {
      const next = await window.pi.app.setConfig({ trashEnabled: dataDraft.trashEnabled });
      useStore.setState({ config: next });
      const stored = { trashEnabled: next?.trashEnabled !== false };
      setDataDraft(stored);
      setInitialData(JSON.stringify(stored));
      setFlash("data");
      setTimeout(() => setFlash(null), 1500);
      pushToast("info", language === "zh" ? "数据管理设置已保存。" : "Data settings saved.");
    } catch (e: any) {
      pushToast("error", (language === "zh" ? "保存失败：" : "Save failed: ") + (e?.message || e));
    } finally {
      setSaving(null);
    }
  };

  const changeExtAutoPickModel = async (extAutoPickModel: boolean) => {
    try {
      const next = await window.pi.app.setConfig({ extAutoPickModel });
      useStore.setState({ config: next });
    } catch (e: any) {
      pushToast("error", "保存扩展选模设置失败：" + (e?.message || e));
    }
  };

  // ---- Voice system handlers -------------------------------------------------
  // Edited as a draft (like permissions/data/system) and flushed by the
  // “保存对话设置” button; the voice test flushes first so it acts on exactly
  // what the user sees.
  const voiceCfg = voiceDraft;
  const setVoice = (patch: Record<string, unknown>) => setVoiceDraft((d) => ({ ...d, ...patch }));
  const sttManual = !voiceCfg?.sttProviderId || voiceCfg.sttProviderId === "__manual__";

  const testVoiceStt = async () => {
    if (!voiceApi) {
      pushToast("warning", language === "zh" ? "当前版本不支持语音系统，请完整重启应用" : "This build predates the voice system — fully restart the app");
      return;
    }
    setVoiceTesting(true);
    try {
      await flushVoice();
      const res = await voiceApi.test();
      if (res.ok) {
        pushToast("success", language === "zh" ? "连接成功：识别服务可用（静音测试无文本属正常）" : "Connected: the transcription service is reachable (empty text on a silent probe is expected)");
      } else {
        pushToast("error", sttTranscribeErrorText(res.error || "", language === "zh"));
      }
    } catch (e: any) {
      pushToast("error", `${language === "zh" ? "测试失败：" : "Test failed: "}${e?.message || e}`);
    } finally {
      setVoiceTesting(false);
    }
  };

  /** Speak a short sample with the currently selected voice/rate. */
  const previewTts = () => {
    void speakMessage("settings-preview", language === "zh" ? "你好，我是 MPI。语音朗读功能正常。" : "Hello from MPI. Voice output is working.", {
      voiceUri: voiceCfg?.ttsVoiceUri,
      rate: voiceCfg?.ttsRate,
      lang: language as "zh" | "en",
      backend: voiceCfg?.ttsBackend === "edge" ? "edge" : "system",
      edgeVoice: voiceCfg?.ttsEdgeVoice,
    }).then((res) => {
      const st = useStore.getState();
      if (res.fallback) {
        const d = res.detail ? (language === "zh" ? `（${res.detail}）` : ` (${res.detail})`) : "";
        st.pushToast("warning", language === "zh" ? `Edge 在线语音不可用，已回退系统语音${d}` : `Edge online voice unavailable — fell back to the system voice${d}`);
      } else if (!res.ok) {
        const d = res.detail ? (language === "zh" ? `（${res.detail}）` : ` (${res.detail})`) : "";
        st.pushToast("error", language === "zh" ? `朗读失败：没有可用的语音引擎${d}` : `Could not read aloud: no usable voice engine${d}`);
      }
    });
  };

  const changeDiffViewMode = async (diffViewMode: "unified" | "blocks") => {
    const next = await window.pi.app.setConfig({ diffViewMode });
    useStore.setState({ config: next });
  };

  // Data storage location changes only record intent — the actual file moves
  // run on next launch (runPendingDataMigrations in main/index.ts).
  const changeSessionsDir = async () => {
    try {
      const p = await window.pi.app.showOpenDialog("folder");
      if (!p) return; // user cancelled the picker
      const res = await window.pi.dataMigration.setSessionsDir(p);
      if (!res.ok) throw new Error(res.error || "unknown error");
      pushToast(
        "info",
        language === "zh"
          ? `已设置会话存储位置，下次启动时迁移 ${res.count} 个文件`
          : `Session storage location set — ${res.count} file(s) will move on next launch`,
      );
      await refreshMigStatus();
    } catch (e: any) {
      pushToast(
        "error",
        (language === "zh" ? "更改会话存储位置失败：" : "Failed to change session storage location: ") + (e?.message || e),
      );
    }
  };

  const resetSessionsDir = async () => {
    try {
      const res = await window.pi.dataMigration.setSessionsDir(null);
      if (!res.ok) throw new Error(res.error || "unknown error");
      pushToast(
        "info",
        language === "zh"
          ? `已恢复默认会话存储位置，下次启动时迁移 ${res.count} 个文件`
          : `Session storage reset to default — ${res.count} file(s) will move on next launch`,
      );
      await refreshMigStatus();
    } catch (e: any) {
      pushToast(
        "error",
        (language === "zh" ? "恢复默认会话存储位置失败：" : "Failed to reset session storage location: ") + (e?.message || e),
      );
    }
  };

  const changeTodosDir = async () => {
    try {
      const p = await window.pi.app.showOpenDialog("folder");
      if (!p) return; // user cancelled the picker
      const res = await window.pi.dataMigration.setTodosDir(p);
      if (!res.ok) throw new Error(res.error || "unknown error");
      pushToast(
        "info",
        language === "zh"
          ? `已设置待办数据位置，下次启动时迁移 ${res.count} 个文件`
          : `Todo data location set — ${res.count} file(s) will move on next launch`,
      );
      await refreshMigStatus();
    } catch (e: any) {
      pushToast(
        "error",
        (language === "zh" ? "更改待办数据位置失败：" : "Failed to change todo data location: ") + (e?.message || e),
      );
    }
  };

  const resetTodosDir = async () => {
    try {
      const res = await window.pi.dataMigration.setTodosDir(null);
      if (!res.ok) throw new Error(res.error || "unknown error");
      pushToast(
        "info",
        language === "zh"
          ? `已恢复默认待办数据位置，下次启动时迁移 ${res.count} 个文件`
          : `Todo data location reset to default — ${res.count} file(s) will move on next launch`,
      );
      await refreshMigStatus();
    } catch (e: any) {
      pushToast(
        "error",
        (language === "zh" ? "恢复默认待办数据位置失败：" : "Failed to reset todo data location: ") + (e?.message || e),
      );
    }
  };

  const changeAccent = async (accentTheme: (typeof ACCENT_PRESETS)[number]["id"]) => {
    const next = await window.pi.app.setConfig({ accentTheme });
    useStore.setState({ config: next });
  };

  const changeZoom = async (zoomPercent: number) => {
    try {
      const next = await window.pi.window.setZoom(zoomPercent);
      useStore.setState({ config: next });
    } catch (e: any) {
      // e.g. stale preload from a pre-restart dev session — surface it instead of failing silently.
      console.error("[zoom] setZoom failed:", e);
      useStore
        .getState()
        .pushToast(
          "warning",
          language === "zh"
            ? `缩放设置失败（${e?.message || e}），请重启应用后重试`
            : `Zoom change failed (${e?.message || e}); restart the app and try again`
        );
    }
  };

  const saveSystem = async () => {
    setSaving("system");
    try {
      const next = await window.pi.app.setAutoLaunch(sysDraft.autoLaunch);
      const stored = { autoLaunch: next === true };
      setSysDraft(stored);
      setInitialSys(JSON.stringify(stored));
      setFlash("system");
      setTimeout(() => setFlash(null), 1500);
      pushToast("info", language === "zh" ? "系统设置已保存。" : "System settings saved.");
    } catch (e: any) {
      pushToast("error", (language === "zh" ? "保存失败：" : "Save failed: ") + (e?.message || e));
    } finally {
      setSaving(null);
    }
  };

  // ---- custom avatars (user + agent), stored as downscaled data URLs -------
  const onAvatarPicked = async (event: ChangeEvent<HTMLInputElement>, kind: "user" | "agent") => {
    const file = event.target.files?.[0];
    event.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    try {
      const dataUrl = await downscaleImageFile(file);
      const next = await window.pi.app.setConfig(kind === "user" ? { userAvatar: dataUrl } : { agentAvatar: dataUrl });
      useStore.setState({ config: next });
    } catch (e: any) {
      pushToast(
        "error",
        language === "zh"
          ? `头像设置失败（${e?.message || e}），请换一张图片重试`
          : `Avatar update failed (${e?.message || e}); try another image`,
      );
    }
  };

  const resetAvatar = async (kind: "user" | "agent") => {
    const next = await window.pi.app.setConfig(kind === "user" ? { userAvatar: undefined } : { agentAvatar: undefined });
    useStore.setState({ config: next });
  };

  const openFile = async (abs: string) => {
    const r = await window.pi.settings.openPath(abs);
    if (r && r.ok === false) pushToast("error", "打开失败：" + (r.error || ""));
  };

  return (
    <div className="settings-backdrop" onMouseDown={attemptClose}>
      <div className="set-modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <aside className="set-side">
          <div className="set-brand">
            <span className="set-brand-mark set-brand-app-icon">
              <img src={appIconUrl} alt="" aria-hidden="true" />
            </span>
            <div className="set-brand-title">设置</div>
          </div>
          <nav className="set-tabs">
            {([
              ["conversation", language === "zh" ? "对话设置" : "Conversation"],
              ["models", "模型与提供商"],
              ["permissions", language === "zh" ? "权限与安全" : "Permissions & security"],
              ["data", language === "zh" ? "数据管理" : "Data management"],
              ["appearance", language === "zh" ? "外观" : "Appearance"],
              ["system", language === "zh" ? "系统与诊断" : "System & diagnostics"],
            ] as [Tab, string][]).map(([id, label]) => (
              <button key={id} className={`set-tab ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>
                <span className="set-tab-bar" />
                {label}
                {id === "models" && modelDirty && <span className="set-dot" />}
                {id === "conversation" && (thinkDirty || voiceDirty || qaDirty) && <span className="set-dot" />}
                {id === "permissions" && permDirty && <span className="set-dot" />}
                {id === "data" && dataDirty && <span className="set-dot" />}
                {id === "system" && sysDirty && <span className="set-dot" />}
              </button>
            ))}
          </nav>
          <div className="set-side-foot">
            {language === "zh" ? (
              <>
                模型与思考默认值写入 <code>~/.pi/agent</code>，与终端 pi 共享；其余设置存于应用配置目录。
              </>
            ) : (
              <>
                Model & thinking defaults are written to <code>~/.pi/agent</code> and shared with terminal pi; other settings live in the app config directory.
              </>
            )}
          </div>
        </aside>

        <section className="set-main">
          <header className="set-head">
            <h2>
              {tab === "conversation"
                ? language === "zh"
                  ? "对话设置"
                  : "Conversation"
                : tab === "models"
                    ? "模型与提供商"
                  : tab === "permissions"
                    ? language === "zh"
                      ? "权限与安全"
                      : "Permissions & security"
                    : tab === "data"
                      ? language === "zh"
                        ? "数据管理"
                        : "Data management"
                      : tab === "appearance"
                        ? language === "zh"
                          ? "外观"
                          : "Appearance"
                        : language === "zh"
                          ? "系统与诊断"
                          : "System & diagnostics"}
            </h2>
            <div className="set-head-actions">
              {tab === "models" && (
                <>
                  <button className="set-btn ghost" onClick={reloadModels} title="重新读取 models.json">
                    <Refresh size={14} /> 重新加载
                  </button>
                  <button className={`set-btn primary ${flash === "models" ? "saved" : ""}`} onClick={saveModels} disabled={!!saving}>
                    {saving === "models" ? <span className="spinner" /> : flash === "models" ? "已保存 ✓" : "保存模型配置"}
                    {modelDirty && flash !== "models" && <span className="set-dot" />}
                  </button>
                </>
              )}
              {tab === "conversation" && (
                <button className={`set-btn primary ${flash === "conversation" ? "saved" : ""}`} onClick={saveConversation} disabled={!!saving}>
                  {saving === "conversation" ? <span className="spinner" /> : flash === "conversation" ? (language === "zh" ? "已保存 ✓" : "Saved ✓") : language === "zh" ? "保存对话设置" : "Save conversation settings"}
                  {(thinkDirty || voiceDirty || qaDirty) && flash !== "conversation" && <span className="set-dot" />}
                </button>
              )}
              {tab === "permissions" && (
                <button className={`set-btn primary ${flash === "permissions" ? "saved" : ""}`} onClick={savePermissions} disabled={!!saving}>
                  {saving === "permissions" ? <span className="spinner" /> : flash === "permissions" ? (language === "zh" ? "已保存 ✓" : "Saved ✓") : language === "zh" ? "保存权限设置" : "Save permissions"}
                  {permDirty && flash !== "permissions" && <span className="set-dot" />}
                </button>
              )}
              {tab === "data" && (
                <button className={`set-btn primary ${flash === "data" ? "saved" : ""}`} onClick={saveData} disabled={!!saving}>
                  {saving === "data" ? <span className="spinner" /> : flash === "data" ? (language === "zh" ? "已保存 ✓" : "Saved ✓") : language === "zh" ? "保存数据设置" : "Save data settings"}
                  {dataDirty && flash !== "data" && <span className="set-dot" />}
                </button>
              )}
              {tab === "system" && (
                <button className={`set-btn primary ${flash === "system" ? "saved" : ""}`} onClick={saveSystem} disabled={!!saving || initialSys === ""}>
                  {saving === "system" ? <span className="spinner" /> : flash === "system" ? (language === "zh" ? "已保存 ✓" : "Saved ✓") : language === "zh" ? "保存系统设置" : "Save system settings"}
                  {sysDirty && flash !== "system" && <span className="set-dot" />}
                </button>
              )}
              <button className="set-iconbtn" title="关闭" onClick={attemptClose}>
                <Close size={16} />
              </button>
            </div>
          </header>

          <div className="set-body">
            {tab === "conversation" && (
              <div className="set-card">
                <Field
                  label={language === "zh" ? "问答方式" : "Q&A style"}
                  hint={
                    language === "zh"
                      ? "带选项的问题在对话里渲染成可点击的内联面板，点选后综合一条消息发出；「手动回答」则 agent 用编号文本提问、你打字作答。对新会话生效（已开会话重连后生效）。"
                      : "Multiple-choice questions render as a clickable inline panel in the chat; all picks are sent back as one message. “Manual answers” makes the agent ask numbered plain-text questions you answer by typing. Applies to new sessions (existing ones after reconnect)."
                  }
                >
                  <select className="set-select" value={qaDraft} onChange={(e) => setQaDraft(e.target.value as "inline" | "manual")}>
                    <option value="inline">{language === "zh" ? "内联快速选择（推荐）" : "Inline quick choice (recommended)"}</option>
                    <option value="manual">{language === "zh" ? "手动回答" : "Manual answers"}</option>
                  </select>
                </Field>
                <Field label="默认思考深度" hint="新建会话的初始思考等级；模型需 reasoning=true 才生效">
                  <select className="set-select" value={thinking.defaultThinkingLevel || "off"} onChange={(e) => setThinking((t) => ({ ...t, defaultThinkingLevel: e.target.value }))}>
                    {availableThinkingLevels.map((l) => (
                      <option key={l} value={l}>
                        {reasoningLevelLabel(l, config?.language || "en")}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="隐藏思考块">
                  <Toggle checked={!!thinking.hideThinkingBlock} onChange={(v) => setThinking((t) => ({ ...t, hideThinkingBlock: v }))} />
                </Field>
                <div className="set-hint" style={{ marginTop: 8 }}>
                  这些是全局默认值，写入 settings.json。单个模型的思考能力由该模型的“思考”开关与 compat 决定。
                </div>

                <Field
                  label={language === "zh" ? "语音系统" : "Voice system"}
                  hint={
                    language === "zh"
                      ? "输入框左侧的麦克风按钮：说话 → 转成文字填入输入框（需先配置识别服务，录音最长 3 分钟）。智能体回复右下角的喇叭按钮可朗读该条回复；开启自动朗读后，当前可见会话每轮结束会自动读出回复。"
                      : "The microphone button left of the editor: speak and it is transcribed into the draft (configure a transcription service first; recordings cap at 3 minutes). The speaker button on each agent reply reads that message aloud; with auto-read on, replies are read automatically when a turn settles in the visible session."
                  }
                >
                  <div className="voice-settings">
                    <div className="voice-subtitle">{language === "zh" ? "语音输入（识别）" : "Voice input (transcription)"}</div>
                    <div className="voice-row">
                      <span className="voice-label">{language === "zh" ? "识别服务" : "Service"}</span>
                      <select
                        className="set-select voice-select"
                        value={voiceCfg?.sttBackend || ""}
                        onChange={(e) => setVoice({ sttBackend: e.target.value || undefined })}
                      >
                        <option value="">{language === "zh" ? "未配置（麦克风按钮不可用）" : "Not configured (mic button disabled)"}</option>
                        <option value="openai">OpenAI 兼容 /audio/transcriptions</option>
                      </select>
                    </div>
                    {voiceCfg?.sttBackend && (
                      <>
                        <div className="voice-row">
                          <span className="voice-label">{language === "zh" ? "凭证来源" : "Credentials"}</span>
                          <select
                            className="set-select voice-select"
                            value={voiceCfg.sttProviderId || "__manual__"}
                            onChange={(e) => setVoice({ sttProviderId: e.target.value })}
                          >
                            <option value="__manual__">{language === "zh" ? "手动填写" : "Manual entry"}</option>
                            {sttProviders.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.id}
                                {(() => {
                                  try {
                                    return p.baseUrl ? `（${new URL(p.baseUrl).host}）` : "";
                                  } catch {
                                    return "";
                                  }
                                })()}
                              </option>
                            ))}
                          </select>
                        </div>
                        {sttManual ? (
                      <>
                        {voiceCfg.sttBackend === "openai" && (
                          <div className="voice-row">
                            <span className="voice-label">Base URL</span>
                            <input
                              className="set-input voice-input"
                              type="text"
                              placeholder="https://api.openai.com/v1"
                              value={voiceCfg.sttBaseUrl || ""}
                              onChange={(e) => setVoice({ sttBaseUrl: e.target.value })}
                            />
                          </div>
                        )}
                        {voiceCfg.sttBackend === "gemini" && (
                          <div className="voice-row">
                            <span className="voice-label">Base URL</span>
                            <input
                              className="set-input voice-input"
                              type="text"
                              placeholder={language === "zh" ? "留空 = Google 官方端点（代理才填）" : "empty = Google's endpoint (proxies only)"}
                              value={voiceCfg.sttBaseUrl || ""}
                              onChange={(e) => setVoice({ sttBaseUrl: e.target.value })}
                            />
                          </div>
                        )}
                        <div className="voice-row">
                          <span className="voice-label">API Key</span>
                          <input
                            className="set-input voice-input"
                            type="password"
                            placeholder="sk-…"
                            value={voiceCfg.sttApiKey || ""}
                            onChange={(e) => setVoice({ sttApiKey: e.target.value })}
                          />
                        </div>
                      </>
                        ) : (
                          <div className="voice-hint">
                            {language === "zh"
                              ? `使用「模型与提供商」中 ${voiceCfg.sttProviderId} 的地址与 key（修改后自动同步）`
                              : `Uses the base URL & key of provider “${voiceCfg.sttProviderId}” from Models (kept in sync automatically)`}
                          </div>
                        )}
                        <div className="voice-row">
                          <span className="voice-label">{language === "zh" ? "模型" : "Model"}</span>
                          <input
                            className="set-input voice-input"
                            type="text"
                            placeholder={voiceCfg.sttBackend === "gemini" ? "gemini-2.5-flash" : "whisper-1"}
                            value={voiceCfg.sttModel || ""}
                            onChange={(e) => setVoice({ sttModel: e.target.value })}
                          />
                        </div>
                        <div className="voice-row">
                          <button type="button" className="set-btn" disabled={voiceTesting} onClick={() => void testVoiceStt()}>
                            {voiceTesting ? (language === "zh" ? "测试中…" : "Testing…") : language === "zh" ? "测试连接" : "Test connection"}
                          </button>
                        </div>
                      </>
                    )}

                    <div className="voice-subtitle">{language === "zh" ? "语音输出（朗读）" : "Voice output (read aloud)"}</div>
                    <div className="voice-row">
                      <span className="voice-label">{language === "zh" ? "朗读引擎" : "Engine"}</span>
                      <select
                        className="set-select voice-select"
                        value={voiceCfg?.ttsBackend === "edge" ? "edge" : "system"}
                        onChange={(e) => {
                          const backend = e.target.value === "edge" ? "edge" : "system";
                          setVoice({
                            ttsBackend: backend,
                            ...(backend === "edge" && !voiceCfg?.ttsEdgeVoice
                              ? { ttsEdgeVoice: defaultEdgeVoice(language as "zh" | "en") }
                              : {}),
                          });
                        }}
                      >
                        <option value="system">{language === "zh" ? "系统语音（离线，默认）" : "System voice (offline, default)"}</option>
                        <option value="edge">{language === "zh" ? "Edge 在线神经语音（免费）" : "Edge online neural voice (free)"}</option>
                      </select>
                    </div>
                    {voiceCfg?.ttsBackend === "edge" && (
                      <div className="voice-hint">
                        {language === "zh"
                          ? "需联网，由微软 Edge 朗读服务合成；无需 API Key。若合成失败会自动回退到系统语音。"
                          : "Needs network access and is synthesized by Microsoft Edge's Read Aloud service; no API key required. Falls back to the system voice on failure."}
                      </div>
                    )}
                    <div className="voice-row">
                      <span className="voice-label">{language === "zh" ? "声音" : "Voice"}</span>
                      {voiceCfg?.ttsBackend === "edge" ? (
                        <select
                          className="set-select voice-select"
                          value={voiceCfg?.ttsEdgeVoice || defaultEdgeVoice(language as "zh" | "en")}
                          onChange={(e) => setVoice({ ttsEdgeVoice: e.target.value })}
                        >
                          {EDGE_VOICES.map((v) => (
                            <option key={v.shortName} value={v.shortName}>
                              {language === "zh" ? v.zh : v.en}（{v.lang}）
                            </option>
                          ))}
                        </select>
                      ) : (
                        <select
                          className="set-select voice-select"
                          value={voiceCfg?.ttsVoiceUri || ""}
                          onChange={(e) => setVoice({ ttsVoiceUri: e.target.value || undefined })}
                        >
                          <option value="">{language === "zh" ? "自动（跟随界面语言）" : "Auto (follow UI language)"}</option>
                          {sortedTtsVoices.map((v) => (
                            <option key={v.voiceURI} value={v.voiceURI}>
                              {v.name}（{v.lang}）
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                    <div className="voice-row">
                      <span className="voice-label">{language === "zh" ? "语速" : "Rate"}</span>
                      <input
                        type="range"
                        min={0.5}
                        max={2}
                        step={0.1}
                        value={voiceCfg?.ttsRate ?? 1}
                        onChange={(e) => setVoice({ ttsRate: Number(e.target.value) })}
                      />
                      <span className="voice-rate-value">{(voiceCfg?.ttsRate ?? 1).toFixed(1)}×</span>
                    </div>
                    <div className="voice-row">
                      <button type="button" className="set-btn ghost" onClick={previewTts}>
                        {language === "zh" ? "试听" : "Preview"}
                      </button>
                    </div>
                    <label className="theme-sys-check">
                      <input type="checkbox" checked={!!voiceCfg?.ttsAutoRead} onChange={(e) => setVoice({ ttsAutoRead: e.target.checked })} />
                      <span>{language === "zh" ? "任务完成后自动朗读智能体回复（仅当前可见会话）" : "Auto-read the agent's reply when a turn settles (visible session only)"}</span>
                    </label>
                  </div>
                </Field>

                <Field
                  label={language === "zh" ? "扩展选模" : "Extension model pick"}
                  hint={
                    language === "zh"
                      ? "扩展需要选择模型时（如 pi-web-access 联网搜索的摘要）不再弹窗询问，直接使用当前会话的模型；联网搜索也不再弹出浏览器整理窗口。设置写入 ~/.pi/web-search.json（与终端 pi 共享），关闭后恢复每次询问。"
                      : "When an extension needs to pick a model (e.g. the pi-web-access web search summary) it uses this conversation's current model directly instead of popping up, and web searches skip the browser curation window. Written to ~/.pi/web-search.json (shared with terminal pi); turning off restores the per-use prompt."
                  }
                >
                  <label className="theme-sys-check">
                    <input type="checkbox" checked={config?.extAutoPickModel !== false} onChange={(e) => void changeExtAutoPickModel(e.target.checked)} />
                    <span>{language === "zh" ? "扩展自动使用当前会话的模型（不弹窗）" : "Extensions auto-use this conversation's model (no popups)"}</span>
                  </label>
                </Field>
                <Field
                  label={language === "zh" ? "Diff 显示" : "Diff view"}
                  hint={
                    language === "zh"
                      ? "聊天中编辑类工具结果的展示方式；统一为 git 风格单栏 -/+ 视图。"
                      : "How edit-tool results render in the transcript; unified is a git-style single-column +/- view."
                  }
                >
                  <select
                    className="set-select"
                    value={config?.diffViewMode || "unified"}
                    onChange={(e) => changeDiffViewMode(e.target.value as "unified" | "blocks")}
                  >
                    <option value="unified">{language === "zh" ? "统一（单栏）" : "Unified (single column)"}</option>
                    <option value="blocks">{language === "zh" ? "前后分块" : "Before / after blocks"}</option>
                  </select>
                </Field>
              </div>
            )}

            {tab === "permissions" && (
              <div className="set-card">
                <Field
                  label={language === "zh" ? "新建会话默认权限" : "New session permission"}
                  hint={
                    language === "zh"
                      ? "仅影响之后新建的会话；已有会话保留各自设置，可随时在输入框左侧的权限菜单中切换。只读=修改直接阻止；严格=仅只读自动执行；沙盒=低风险明确操作自动执行、危险操作需确认；完全权限=不拦截。"
                      : "Applies to sessions created from now on; existing sessions keep their own level and can be switched anytime from the permission menu in the composer. Read-only blocks mutations; strict auto-runs only read-only; sandbox auto-runs low-risk explicit operations; full intercepts nothing."
                  }
                >
                  <select
                    className="set-select"
                    value={permDraft.defaultPermission}
                    onChange={(e) => setPermDraft((d) => ({ ...d, defaultPermission: e.target.value as PermissionLevel }))}
                  >
                    <option value="readonly">{language === "zh" ? "只读（修改直接阻止）" : "Read-only (mutations blocked)"}</option>
                    <option value="strict">{language === "zh" ? "严格（仅只读自动执行）" : "Strict (read-only auto-runs)"}</option>
                    <option value="sandbox">{language === "zh" ? "沙盒（低风险操作自动执行，默认）" : "Sandbox (low-risk auto-runs, default)"}</option>
                    <option value="full">{language === "zh" ? "完全权限" : "Full access"}</option>
                  </select>
                </Field>
                <Field
                  wide
                  label={language === "zh" ? "扩展工具信任列表（沙盒/严格下免审批）" : "Trusted extension tools (skip approval in sandbox/strict)"}
                  hint={
                    language === "zh"
                      ? "列出本机会话中出现过的扩展工具，打开开关后在沙盒/严格权限下不再弹审批；权限确认卡片上的「始终允许该工具」也会自动加入这里。只读 / 强制只读模式不受影响；bash 与文件写入/编辑工具不可被信任。（改动需点上方「保存权限设置」生效）"
                      : "Extension tools seen in this profile's sessions. Toggling one on skips approval under sandbox/strict permissions; the approval card's “Always allow this tool” also adds it here. Read-only / enforced read-only modes are unaffected; bash and file write/edit tools can never be trusted. (Changes apply after “Save permissions” above.)"
                  }
                >
                  <div className="trust-picker">
                    <div className="plugins-search">
                      <Search size={15} />
                      <input
                        value={toolQuery}
                        onChange={(e) => setToolQuery(e.target.value)}
                        placeholder={language === "zh" ? "搜索工具…" : "Search tools…"}
                        aria-label={language === "zh" ? "搜索工具" : "Search tools"}
                      />
                      {toolQuery && (
                        <button
                          type="button"
                          className="plugins-search-clear"
                          onClick={() => setToolQuery("")}
                          aria-label={language === "zh" ? "清除搜索" : "Clear search"}
                        >
                          ×
                        </button>
                      )}
                    </div>

                    <div className="skill-chips">
                      {(
                        [
                          ["all", language === "zh" ? `全部 ${toolCounts.all}` : `All ${toolCounts.all}`],
                          ["trusted", language === "zh" ? `已信任 ${toolCounts.trusted}` : `Trusted ${toolCounts.trusted}`],
                          [
                            "untrusted",
                            language === "zh" ? `未信任 ${toolCounts.untrusted}` : `Untrusted ${toolCounts.untrusted}`,
                          ],
                        ] as [ToolTrustFilter, string][]
                      ).map(([value, label]) => (
                        <button
                          key={value}
                          type="button"
                          className={`skill-chip${toolFilter === value ? " active" : ""}`}
                          onClick={() => setToolFilter(value)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>

                    <div className="trust-picker-list">
                      {visibleToolRows.length === 0 && (
                        <div className="set-empty-mini">
                          {language === "zh"
                            ? "没有匹配的工具。工具会在会话中被调用后出现在这里；也可以直接在下方手动添加。"
                            : "No matching tools. Tools appear here once they are used in a session; you can also add one manually below."}
                        </div>
                      )}
                      {visibleToolRows.map((row) => (
                        <div
                          key={row.name}
                          role="button"
                          tabIndex={0}
                          className={`skill-row${row.actionable ? "" : " static"}`}
                          onClick={() =>
                            row.actionable && setTrustedTools(toggleTrustedTool(permDraft.trustedTools, row.name))
                          }
                          onKeyDown={(e) => {
                            if (row.actionable && (e.key === "Enter" || e.key === " ")) {
                              e.preventDefault();
                              setTrustedTools(toggleTrustedTool(permDraft.trustedTools, row.name));
                            }
                          }}
                        >
                          <span className={`skill-dot ${row.trusted ? "on" : "off"}`} />
                          <div className="skill-row-main">
                            <div className="skill-row-name">{row.name}</div>
                            {row.subtitle && <div className="skill-row-desc">{row.subtitle}</div>}
                          </div>
                          {row.actionable ? (
                            <span className="skill-row-toggle" onClick={(e) => e.stopPropagation()}>
                              <Toggle
                                checked={row.trusted}
                                onChange={() => setTrustedTools(toggleTrustedTool(permDraft.trustedTools, row.name))}
                              />
                            </span>
                          ) : (
                            <span className="trust-picker-badge">{row.badge}</span>
                          )}
                        </div>
                      ))}
                    </div>

                    <div style={{ display: "flex", gap: 8 }}>
                      <input
                        className="set-input"
                        value={trustDraft}
                        placeholder={language === "zh" ? "手动添加工具名称，如 mem0_memory" : "Manually add a tool name, e.g. mem0_memory"}
                        onChange={(e) => setTrustDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") addTrustedTool();
                        }}
                      />
                      <button className="btn" onClick={addTrustedTool} disabled={!trustDraft.trim()}>
                        {language === "zh" ? "添加" : "Add"}
                      </button>
                    </div>
                  </div>
                </Field>
              </div>
            )}

            {tab === "appearance" && (
              <div className="set-card">
                <div className="set-note">
                  {language === "zh"
                    ? "这里的设置即时生效并自动保存，无需手动保存。"
                    : "These settings take effect immediately and are saved automatically — no manual save needed."}
                </div>
                <Field
                  label={language === "zh" ? "头像" : "Avatars"}
                  hint={
                    language === "zh"
                      ? "聊天消息左侧的头像（默认：用户=大雄、智能体=哆啦A梦）。上传的图片会自动压缩后保存；恢复默认回到内置角色。"
                      : "Avatars shown beside chat messages (defaults: User = Nobita, Agent = Doraemon). Uploaded images are downscaled before saving; reset restores the built-in characters."
                  }
                >
                  <div className="avatar-row">
                    <input ref={userAvatarInputRef} type="file" accept="image/*" hidden onChange={(e) => void onAvatarPicked(e, "user")} />
                    <input ref={agentAvatarInputRef} type="file" accept="image/*" hidden onChange={(e) => void onAvatarPicked(e, "agent")} />
                    <div className="avatar-slot">
                      <span className="avatar-preview">
                        {config?.userAvatar ? <img src={config.userAvatar} alt="" /> : <img src={nobitaAvatarUrl} alt="" />}
                      </span>
                      <div className="avatar-slot-actions">
                        <button type="button" className="set-btn" onClick={() => userAvatarInputRef.current?.click()}>
                          {language === "zh" ? "更换" : "Change"}
                        </button>
                        {config?.userAvatar && (
                          <button type="button" className="set-btn ghost" onClick={() => void resetAvatar("user")}>
                            {language === "zh" ? "恢复默认" : "Reset"}
                          </button>
                        )}
                      </div>
                      <span className="avatar-slot-label">{language === "zh" ? "用户" : "User"}</span>
                    </div>
                    <div className="avatar-slot">
                      <span className="avatar-preview">
                        {config?.agentAvatar ? <img src={config.agentAvatar} alt="" /> : <img src={doraemonAvatarUrl} alt="" />}
                      </span>
                      <div className="avatar-slot-actions">
                        <button type="button" className="set-btn" onClick={() => agentAvatarInputRef.current?.click()}>
                          {language === "zh" ? "更换" : "Change"}
                        </button>
                        {config?.agentAvatar && (
                          <button type="button" className="set-btn ghost" onClick={() => void resetAvatar("agent")}>
                            {language === "zh" ? "恢复默认" : "Reset"}
                          </button>
                        )}
                      </div>
                      <span className="avatar-slot-label">{language === "zh" ? "MPI 智能体" : "MPI Agent"}</span>
                    </div>
                  </div>
                </Field>
                <Field
                  label={language === "zh" ? "主题模式" : "Theme"}
                  hint={
                    language === "zh"
                      ? "勾选「跟随系统」后，应用随操作系统外观设置切换。"
                      : "When “Follow system” is on, the app follows the OS appearance setting."
                  }
                >
                  <div className="theme-picker">
                    <label className="theme-sys-check">
                      <input
                        type="checkbox"
                        checked={config?.theme === "system"}
                        onChange={(e) => changeTheme(e.target.checked ? "system" : "light")}
                      />
                      <span>{language === "zh" ? "跟随系统" : "Follow system"}</span>
                    </label>
                    <div className="theme-cards">
                      {(["light", "dark"] as const).map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          className={`theme-card ${config?.theme === mode ? "selected" : ""}`}
                          onClick={() => changeTheme(mode)}
                        >
                          <span className={`theme-mock ${mode}`} aria-hidden="true">
                            <i className="tm-rail" />
                            <span className="tm-body">
                              <i className="tm-line w60" />
                              <i className="tm-line w85 tm-accent" />
                              <i className="tm-line w45" />
                            </span>
                          </span>
                          <span className="theme-card-label">
                            <i className={`radio-dot ${config?.theme === mode ? "on" : ""}`} />
                            {mode === "light"
                              ? language === "zh"
                                ? "浅色"
                                : "Light"
                              : language === "zh"
                                ? "深色"
                                : "Dark"}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                </Field>
                <Field
                  label={language === "zh" ? "主题色" : "Accent color"}
                  hint={
                    language === "zh"
                      ? "改变应用强调色（高亮、选中态、发送按钮等）。"
                      : "Changes the app accent (highlights, selection, send button)."
                  }
                >
                  <div className="accent-swatches">
                    {ACCENT_PRESETS.map((a) => {
                      const selected = (config?.accentTheme || "default") === a.id;
                      return (
                        <button
                          key={a.id}
                          type="button"
                          className={`accent-swatch ${!a.swatch ? "empty" : ""} ${selected ? "selected" : ""}`.trim()}
                          style={a.swatch ? { background: a.swatch } : undefined}
                          title={language === "zh" ? a.zh : a.en}
                          onClick={() => changeAccent(a.id)}
                        >
                          {selected && <span className="accent-name">{language === "zh" ? a.zh : a.en}</span>}
                        </button>
                      );
                    })}
                  </div>
                </Field>
                <Field label={language === "zh" ? "语言" : "Language"}>
                  <select
                    className="set-select"
                    value={config?.language || "en"}
                    onChange={(e) => changeLanguage(e.target.value as "en" | "zh")}
                  >
                    <option value="en">{language === "zh" ? "英文" : "English"}</option>
                    <option value="zh">{language === "zh" ? "中文" : "Chinese"}</option>
                  </select>
                </Field>
                <Field
                  label={language === "zh" ? "窗口缩放" : "Window zoom"}
                  hint={
                    language === "zh"
                      ? "也可用快捷键 Ctrl+= / Ctrl+- 调整，Ctrl+0 恢复默认。"
                      : "Also adjustable via Ctrl+= / Ctrl+-; Ctrl+0 resets to default."
                  }
                >
                  <select
                    className="set-select"
                    value={config?.zoomPercent ?? 100}
                    onChange={(e) => changeZoom(Number(e.target.value))}
                  >
                    {[50, 75, 100, 125, 150].map((p) => (
                      <option key={p} value={p}>
                        {p === 100 ? `${p}%（${language === "zh" ? "默认" : "default"}）` : `${p}%`}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            )}


            {tab === "models" && (
              <>
                {/* ---- 第一段：预设供应商 ---- */}
                <div className="set-sec-head">
                  <div className="set-sec-title">{language === "zh" ? "预设供应商" : "Preset providers"}</div>
                  <div className="set-sec-actions">
                    <div className="archive-search-box preset-search">
                      <Search size={13} />
                      <input
                        className="archive-search-input"
                        placeholder={language === "zh" ? "搜索模型平台…" : "Search model platforms…"}
                        value={presetQuery}
                        onChange={(e) => setPresetQuery(e.target.value)}
                      />
                      {presetQuery && (
                        <button
                          className="archive-search-clear"
                          onClick={() => setPresetQuery("")}
                          aria-label={language === "zh" ? "清空搜索" : "Clear search"}
                        >
                          <Close size={12} />
                        </button>
                      )}
                    </div>
                    <button
                      className="set-btn ghost"
                      onClick={() => void reloadModels()}
                      title={language === "zh" ? "重新读取 models.json，更新各平台的配置状态" : "Reload models.json and refresh each platform's status"}
                    >
                      <Refresh size={14} /> {language === "zh" ? "刷新预设" : "Refresh presets"}
                    </button>
                  </div>
                </div>

                <div className="preset-grid">
                  <button type="button" className="preset-card dashed" onClick={() => openAddForm(null)}>
                    <Plus size={15} />
                    <span>{language === "zh" ? "自定义配置" : "Custom config"}</span>
                  </button>
                  <button type="button" className="preset-card dashed" onClick={() => openAddForm(LOCAL_DEPLOY_PRESET)}>
                    <Plus size={15} />
                    <span>{language === "zh" ? "本地部署" : "Local deploy"}</span>
                  </button>
                  {visiblePresets.map((preset) => {
                    const configuredKey = configuredKeyFor(preset);
                    const isCurrent = !!configuredKey && thinking.defaultProvider === configuredKey;
                    return (
                      <button
                        key={preset.key}
                        type="button"
                        className={`preset-card ${configuredKey ? "configured" : ""}`.trim()}
                        onClick={() => onPresetClick(preset)}
                      >
                        <span className="preset-icon" style={{ background: preset.color }} aria-hidden="true">
                          {preset.monogram}
                        </span>
                        <span className="preset-main">
                          <span className="preset-name">
                            {language === "zh" ? preset.name : preset.enName}
                            {isCurrent && (
                              <em className="preset-badge">{language === "zh" ? "当前" : "Current"}</em>
                            )}
                          </span>
                          <span className="preset-sub">
                            {hostOf(preset.baseUrl) || (language === "zh" ? "本地服务" : "local service")}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
                {presetQueryTrimmed && visiblePresets.length === 0 && (
                  <div className="set-empty-mini">{language === "zh" ? "没有匹配的平台。" : "No matching platforms."}</div>
                )}

                {adding && (
                  <form
                    ref={addFormRef}
                    className="set-addprov-card"
                    style={{ scrollMarginTop: 8 }}
                    onSubmit={(event) => {
                      event.preventDefault();
                      confirmAddProvider();
                    }}
                  >
                    <div className="set-addprov-head">
                      <div>
                        <div className="set-addprov-title">{language === "zh" ? "新增模型供应商" : "Add model provider"}</div>
                        <div className="set-addprov-sub">
                          {language === "zh"
                            ? "一次填写连接信息和首个模型，添加后仍可继续配置高级选项。"
                            : "Set up the connection and first model in one step. Advanced options remain editable afterward."}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="set-iconbtn"
                        title={language === "zh" ? "取消" : "Cancel"}
                        onClick={() => {
                          setAdding(false);
                          setNewProvider(emptyNewProvider());
                        }}
                      >
                        <Close size={15} />
                      </button>
                    </div>

                    <div className="set-addprov-grid">
                      <label className="set-addprov-field">
                        <span>{language === "zh" ? "供应商名称" : "Provider name"}</span>
                        <input
                          className="set-input"
                          autoFocus
                          placeholder="my-provider"
                          value={newProvider.id}
                          onChange={(event) => setNewProvider((value) => ({ ...value, id: event.target.value }))}
                        />
                      </label>
                      <label className="set-addprov-field">
                        <span>{language === "zh" ? "API 类型" : "API type"}</span>
                        <select
                          className="set-select"
                          value={newProvider.api}
                          onChange={(event) => setNewProvider((value) => ({ ...value, api: event.target.value as ApiType }))}
                        >
                          {API_TYPES.map((api) => (
                            <option key={api} value={api}>
                              {api}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="set-addprov-field wide">
                        <span>{language === "zh" ? "API 地址" : "API URL"}</span>
                        <input
                          className="set-input"
                          placeholder="https://api.example.com/v1"
                          value={newProvider.baseUrl}
                          onChange={(event) => setNewProvider((value) => ({ ...value, baseUrl: event.target.value }))}
                        />
                      </label>
                      <label className="set-addprov-field">
                        <span>{language === "zh" ? "API 密钥" : "API key"}</span>
                        <input
                          className="set-input"
                          type="password"
                          placeholder={language === "zh" ? "可留空，支持 $ENV_VAR" : "Optional; supports $ENV_VAR"}
                          value={newProvider.apiKey}
                          onChange={(event) => setNewProvider((value) => ({ ...value, apiKey: event.target.value }))}
                        />
                      </label>
                      <label className="set-addprov-field">
                        <span>{language === "zh" ? "模型 ID" : "Model ID"}</span>
                        <input
                          className="set-input"
                          placeholder={language === "zh" ? "model-id（可留空，稍后可补）" : "model id (optional)"}
                          value={newProvider.modelId}
                          onChange={(event) => setNewProvider((value) => ({ ...value, modelId: event.target.value }))}
                        />
                      </label>
                    </div>

                    <div className="set-addprov-actions">
                      <button
                        type="button"
                        className="set-btn ghost"
                        onClick={() => {
                          setAdding(false);
                          setNewProvider(emptyNewProvider());
                        }}
                      >
                        {language === "zh" ? "取消" : "Cancel"}
                      </button>
                      <button type="submit" className="set-btn primary">
                        {language === "zh" ? "添加供应商" : "Add provider"}
                      </button>
                    </div>
                  </form>
                )}

                {/* ---- 第二段：我的供应商（紧凑卡片，点击展开完整编辑区） ---- */}
                <div className="set-sec-head models-sec2">
                  <div className="set-sec-title">
                    {language === "zh" ? "我的供应商" : "My providers"}
                    {providerKeys.length > 0 && <span className="set-prov-count">{providerKeys.length}</span>}
                  </div>
                  <div className="set-sec-actions">
                    {!adding && (
                      <button className="set-btn ghost" onClick={() => openAddForm(null)}>
                        <Plus size={14} /> {language === "zh" ? "添加供应商" : "Add provider"}
                      </button>
                    )}
                    {expandedProvider && draft.providers[expandedProvider] && (
                      <button className="set-btn ghost" onClick={() => setExpandedProvider(null)}>
                        {language === "zh" ? "收起" : "Collapse"}
                      </button>
                    )}
                  </div>
                </div>

                {providerKeys.length === 0 ? (
                  !adding && (
                    <div className="set-empty">
                      {language === "zh"
                        ? "尚无提供商。从上方选择平台，或点「自定义配置」接入任意 API（OpenAI / Anthropic / Gemini 兼容端点、Ollama、代理等）。"
                        : "No providers yet. Pick a platform above, or use Custom config to connect any API (OpenAI / Anthropic / Gemini compatible endpoints, Ollama, proxies, etc.)."}
                    </div>
                  )
                ) : (
                  <>
                    <div className="preset-grid">
                      {providerKeys.map((k) => {
                        const def = draft.providers[k];
                        const modelCount = (def.models || []).length;
                        const isCurrent = thinking.defaultProvider === k;
                        return (
                          <button
                            key={k}
                            type="button"
                            className={`prov-tile ${expandedProvider === k ? "active" : ""}`.trim()}
                            onClick={() => setExpandedProvider((cur) => (cur === k ? null : k))}
                          >
                            <span className="prov-tile-top">
                              <span className="set-prov-id" title={k}>
                                {k}
                              </span>
                              {isCurrent && (
                                <em className="preset-badge">{language === "zh" ? "当前" : "Current"}</em>
                              )}
                            </span>
                            <span className="prov-tile-sub">
                              {language === "zh"
                                ? `${modelCount} 模型 · ${hostOf(def.baseUrl) || "未设地址"}`
                                : `${modelCount} model${modelCount === 1 ? "" : "s"} · ${hostOf(def.baseUrl) || "no URL set"}`}
                            </span>
                          </button>
                        );
                      })}
                    </div>

                    {expandedProvider && draft.providers[expandedProvider] && (
                      <div className="set-prov-detail" ref={detailRef}>
                        <ProviderCard
                          k={expandedProvider}
                          def={draft.providers[expandedProvider]}
                          language={language}
                          rename={(name) => renameProvider(expandedProvider, name)}
                          patch={(p) => updateProvider(expandedProvider, p)}
                          del={() => deleteProvider(expandedProvider)}
                          register={register}
                          addModel={() => addModel(expandedProvider)}
                          updateModel={(i, p) => updateModel(expandedProvider, i, p)}
                          deleteModel={(i) => deleteModel(expandedProvider, i)}
                        />
                      </div>
                    )}
                  </>
                )}
                {/* P1-12: auto model switching pool + policy */}
                <AutoModelCard providers={draft.providers} />

                <div className="set-card">
                  <Field label="默认提供商" hint="新建会话的初始提供商；写入 settings.json（~/.pi/agent），与终端 pi 共享。">
                    <select className="set-select" value={thinking.defaultProvider || ""} onChange={(e) => setThinking((t) => ({ ...t, defaultProvider: e.target.value || undefined, defaultModel: undefined }))}>
                      <option value="">（未设）</option>
                      {providerKeys.map((k) => (
                        <option key={k} value={k}>
                          {k}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="默认模型">
                    <select className="set-select" value={thinking.defaultModel || ""} onChange={(e) => setThinking((t) => ({ ...t, defaultModel: e.target.value || undefined }))} disabled={!thinking.defaultProvider}>
                      <option value="">（未设）</option>
                      {defaultModels.map((id) => (
                        <option key={id} value={id}>
                          {id}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field
                    label={language === "zh" ? "摘要模型（提供商）" : "Summary model (provider)"}
                    hint={
                      language === "zh"
                        ? "上下文压缩时优先用它做摘要；留空 = 跟随会话主模型。改动即时生效，无需重启。"
                        : "Preferred provider for context-compaction summaries; leave empty to follow the session's main model. Applies from the next compaction, no restart needed."
                    }
                  >
                    <select
                      className="set-select"
                      value={scProvider}
                      onChange={(e) => {
                        const p = e.target.value;
                        setScProvider(p);
                        setScModelId("");
                        void saveSmartCompact(p || undefined, undefined);
                      }}
                    >
                      <option value="">{language === "zh" ? "（默认：会话主模型）" : "(default: session main model)"}</option>
                      {providerKeys.map((k) => (
                        <option key={k} value={k}>
                          {k}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={language === "zh" ? "摘要模型" : "Summary model"}>
                    <select
                      className="set-select"
                      value={scModelId}
                      onChange={(e) => {
                        const m = e.target.value;
                        setScModelId(m);
                        void saveSmartCompact(scProvider || undefined, m || undefined);
                      }}
                      disabled={!scProvider}
                    >
                      <option value="">{language === "zh" ? "（未设）" : "(none)"}</option>
                      {(draft.providers[scProvider]?.models || []).map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.id}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field
                    label={language === "zh" ? "记忆模型" : "Memory model"}
                    hint={
                      language === "zh"
                        ? "知芽记忆池用它做抽取/打分与 lesson 正文。不设置 = 完全不调模型，只用基础记忆读写改（与 mem0 相同）；也可以跟随主模型或指定模型。改动对分诊立即生效，捕获扩展在下一个会话生效。"
                        : "Zhiya uses it for extraction/scoring and lesson drafting. Unset = no model at all, basic memory read/write only (same as mem0); you may also follow the session main model or pick one. Dream applies immediately; capture applies from the next session."
                    }
                  >
                    <select
                      className="set-select"
                      value={mmMode === "model" ? mmProvider || "" : mmMode}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === "none" || v === "session") {
                          setMmMode(v);
                          setMmProvider("");
                          setMmModelId("");
                          void saveMemoryModel(v);
                        } else {
                          // 只记本地状态，不写配置：mode "model" 必须 provider+model 齐全才能落盘
                          // （saveMemoryModel("model") 缺参会退化成 mode:"none"，把下拉框弹回「不设置」）。
                          // 真正保存发生在第二个下拉框选完型号时。
                          setMmMode("model");
                          setMmProvider(v);
                          setMmModelId("");
                        }
                      }}
                    >
                      <option value="none">{language === "zh" ? "（不设置：不使用模型）" : "(unset: no model)"}</option>
                      <option value="session">{language === "zh" ? "跟随主模型" : "Follow session main model"}</option>
                      {providerKeys.map((k) => (
                        <option key={k} value={k}>
                          {k}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field
                    label={language === "zh" ? "记忆模型（型号）" : "Memory model (id)"}
                    hint={
                      language === "zh"
                        ? "模型不可用时记忆功能不会报错：自动捕获停用，/memory-remember 与检索照常工作。"
                        : "If the model is unavailable the memory system degrades instead of failing: auto-capture stops, /memory-remember and recall keep working."
                    }
                  >
                    <select
                      className="set-select"
                      value={mmModelId}
                      onChange={(e) => {
                        const m = e.target.value;
                        setMmModelId(m);
                        void saveMemoryModel("model", mmProvider || undefined, m || undefined);
                      }}
                      disabled={mmMode !== "model" || !mmProvider}
                    >
                      <option value="">{language === "zh" ? "（未设）" : "(none)"}</option>
                      {(draft.providers[mmProvider]?.models || []).map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.id}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
              </>
            )}


            {tab === "data" && (
              <div className="set-card">
                <div className="set-card-title">{language === "zh" ? "存储位置" : "Storage locations"}</div>
                <Field
                  label={language === "zh" ? "会话存储位置" : "Session storage location"}
                  hint={
                    language === "zh"
                      ? "所有 pi 会话记录（.jsonl）的存放目录。更改后下次启动自动迁移，终端 pi 也会跟随新位置；旧文件在迁移完成前仍可正常读取。"
                      : "Where all pi session records (.jsonl) live. Changes migrate automatically on next launch; terminal pi follows the new location too, and old files stay readable until the move completes."
                  }
                >
                  <div className="set-path-row">
                    <span className="set-path-value" title={migStatus?.effectiveSessionsDir || ""}>
                      {migStatus ? migStatus.effectiveSessionsDir : "…"}
                    </span>
                    <button type="button" className="btn" onClick={() => void changeSessionsDir()}>
                      {language === "zh" ? "更改…" : "Change…"}
                    </button>
                    {migStatus?.sessionStorageDir && (
                      <button type="button" className="btn" onClick={() => void resetSessionsDir()}>
                        {language === "zh" ? "恢复默认" : "Reset"}
                      </button>
                    )}
                  </div>
                  {migStatus?.pendingSessions && (
                    <div className="set-hint">
                      {language === "zh"
                        ? "⚠ 位置已更改，文件将在下次启动时迁移。重启前应用仍读取旧位置。"
                        : "⚠ Location changed — files move on next launch. Until then the app still reads the old location."}
                    </div>
                  )}
                </Field>
                <Field
                  label={language === "zh" ? "待办数据位置" : "Todo data location"}
                  hint={
                    language === "zh"
                      ? "待办任务（todos.json）、附件与智能体收件箱的存放目录。更改后下次启动自动迁移；旧位置的附件仍可正常打开和删除。"
                      : "Where todo tasks (todos.json), attachments and the agent inbox live. Changes migrate automatically on next launch; attachments from old locations keep working."
                  }
                >
                  <div className="set-path-row">
                    <span className="set-path-value" title={migStatus?.effectiveTodosDir || ""}>
                      {migStatus ? migStatus.effectiveTodosDir : "…"}
                    </span>
                    <button type="button" className="btn" onClick={() => void changeTodosDir()}>
                      {language === "zh" ? "更改…" : "Change…"}
                    </button>
                    {migStatus?.todoDataDir && (
                      <button type="button" className="btn" onClick={() => void resetTodosDir()}>
                        {language === "zh" ? "恢复默认" : "Reset"}
                      </button>
                    )}
                  </div>
                  {migStatus?.pendingTodos && (
                    <div className="set-hint">
                      {language === "zh"
                        ? "⚠ 位置已更改，文件将在下次启动时迁移。重启前应用仍读取旧位置。"
                        : "⚠ Location changed — files move on next launch. Until then the app still reads the old location."}
                    </div>
                  )}
                </Field>
              </div>
            )}

            {tab === "data" && (
              <div className="set-card">
                <div className="set-card-title">{language === "zh" ? "归档与回收" : "Archive & trash"}</div>
                <Field
                  label={language === "zh" ? "回收站" : "Trash"}
                  hint={
                    language === "zh"
                      ? "开启后，删除的会话先移入回收站（设置 → 数据管理），可恢复；只有在那里删除才算永久删除。关闭后删除会立即永久生效。"
                      : "When on, deleted sessions go to the trash (Settings → Data management) and stay restorable; only deleting there removes them for good. When off, delete removes a session immediately."
                  }
                >
                  <label className="theme-sys-check">
                    <input type="checkbox" checked={dataDraft.trashEnabled} onChange={(e) => setDataDraft({ trashEnabled: e.target.checked })} />
                    <span>{language === "zh" ? "删除的会话先移入回收站（可恢复）" : "Deleted sessions go to the trash first (restorable)"}</span>
                  </label>
                </Field>

                {/* Search across archived projects, sessions and trash entries. */}
                <div className="archive-search-row">
                  <div className="archive-search-box">
                    <Search size={14} />
                    <input
                      className="archive-search-input"
                      value={archiveQuery}
                      onChange={(e) => setArchiveQuery(e.target.value)}
                      placeholder={language === "zh" ? "搜索归档项目、会话或回收站条目…" : "Search archived projects, sessions or trash…"}
                    />
                    {archiveQuery && (
                      <button
                        className="archive-search-clear"
                        onClick={() => setArchiveQuery("")}
                        aria-label={language === "zh" ? "清空搜索" : "Clear search"}
                      >
                        <Close size={12} />
                      </button>
                    )}
                  </div>
                  {archiveQueryTrimmed && (
                    <span className="archive-search-count">
                      {language === "zh"
                        ? `${archiveResultCount} 条结果`
                        : `${archiveResultCount} result${archiveResultCount === 1 ? "" : "s"}`}
                    </span>
                  )}
                </div>

                <div className="set-card-title">{language === "zh" ? "已归档项目" : "Archived projects"}</div>
                <div className="set-hint archived-project-hint">
                  {language === "zh"
                    ? "归档只会从导航栏、搜索和新建会话的项目列表中隐藏文件夹，不会删除文件夹或其中的会话。"
                    : "Archiving only hides the folder from the sidebar, search, and new-session project list. It does not delete the folder or its sessions."}
                </div>
                {filteredArchivedProjects.length === 0 ? (
                  <div className="set-empty">
                    {archiveQueryTrimmed
                      ? language === "zh" ? "没有匹配的归档项目。" : "No matching archived projects."
                      : language === "zh" ? "暂无归档项目。" : "No archived projects."}
                  </div>
                ) : (
                  <div className="archived-project-list">
                    {filteredArchivedProjects.map((cwd) => (
                      <div className="archived-project-row" key={cwd}>
                        <Folder size={17} />
                        <div className="archived-project-main">
                          <div className="archived-project-name">{pathBase(cwd)}</div>
                          <div className="archived-project-path" title={cwd}>{cwd}</div>
                        </div>
                        <button className="set-btn" onClick={() => restoreProject(cwd)}>
                          {language === "zh" ? "恢复项目" : "Restore project"}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="archived-thread-section">
                  <div className="set-card-title">{language === "zh" ? "已归档会话" : "Archived sessions"}</div>
                  <div className="set-hint archived-project-hint">
                    {language === "zh"
                      ? "归档只会隐藏会话，不会删除会话文件；恢复后会话会重新出现在所属项目下。"
                      : "Archiving only hides the session; it does not delete the session file. Restored sessions reappear under their project."}
                  </div>
                  {threadGroups.length === 0 ? (
                    <div className="set-empty">
                      {archiveQueryTrimmed
                        ? language === "zh" ? "没有匹配的归档会话。" : "No matching archived sessions."
                        : language === "zh" ? "暂无归档会话。" : "No archived sessions."}
                    </div>
                  ) : (
                    <div className="archive-group-list">
                      {threadGroups.map((group) => {
                        const expanded = archiveQueryTrimmed !== "" || !collapsedGroups.has(group.cwd.toLowerCase());
                        return (
                          <div className="archive-group" key={group.cwd}>
                            <button type="button" className="archive-group-head" onClick={() => toggleGroup(group.cwd)} title={group.cwd}>
                              <ChevronRight size={13} className={expanded ? "archive-chevron open" : "archive-chevron"} />
                              <Folder size={15} />
                              <span className="archive-group-name">{group.name}</span>
                              <span className="archive-group-count">{group.items.length}</span>
                            </button>
                            {expanded && (
                              <div className="archived-thread-list">
                                {group.items.map((thread) => (
                                  <div className="archived-thread-row" key={thread.file} title={`${thread.cwd}\n${thread.file}`}>
                                    <Archive size={17} />
                                    <div className="archived-thread-main">
                                      <div className="archived-thread-name" title={thread.title}>{thread.title || pathBase(thread.file)}</div>
                                      {thread.archivedAt ? (
                                        <div className="archived-thread-path">{formatWhen(thread.archivedAt, language)}</div>
                                      ) : null}
                                    </div>
                                    <button className="set-btn" onClick={() => restoreThread(thread.file)}>
                                      {language === "zh" ? "恢复会话" : "Restore"}
                                    </button>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
                <div className="archived-thread-section">
                  <div className="set-card-title trash-head-row">
                    <span>
                      {language === "zh" ? "回收站" : "Trash"}
                      {trashEntries.length > 0 && (
                        <span className="trash-count">
                          {` · ${trashEntries.length} ${language === "zh" ? "项" : trashEntries.length === 1 ? "item" : "items"} · ${formatBytes(trashEntries.reduce((sum, entry) => sum + (entry.sizeBytes || 0), 0))}`}
                        </span>
                      )}
                    </span>
                    {trashEntries.length > 0 && (
                      <button className="set-btn danger" onClick={() => setTrashEmptyConfirm(true)}>
                        {language === "zh" ? "清空回收站" : "Empty trash"}
                      </button>
                    )}
                  </div>
                  <div className="set-hint archived-project-hint">
                    {language === "zh"
                      ? "回收站中的会话不再出现在导航栏和搜索里；恢复后会回到所属项目。只有在这里删除才算永久删除。"
                      : "Trashed sessions are hidden from the sidebar and search; restore puts one back into its project. Only deleting here removes a session for good."}
                  </div>
                  {trashGroups.length === 0 ? (
                    <div className="set-empty">
                      {archiveQueryTrimmed
                        ? language === "zh" ? "没有匹配的回收站条目。" : "No matching trash entries."
                        : language === "zh" ? "回收站是空的。" : "Trash is empty."}
                    </div>
                  ) : (
                    <div className="archive-group-list">
                      {trashGroups.map((group) => {
                        const expanded = archiveQueryTrimmed !== "" || !collapsedGroups.has(group.cwd.toLowerCase());
                        return (
                          <div className="archive-group" key={group.cwd}>
                            <button type="button" className="archive-group-head" onClick={() => toggleGroup(group.cwd)} title={group.cwd}>
                              <ChevronRight size={13} className={expanded ? "archive-chevron open" : "archive-chevron"} />
                              <Folder size={15} />
                              <span className="archive-group-name">{group.name}</span>
                              <span className="archive-group-count">{group.items.length}</span>
                            </button>
                            {expanded && (
                              <div className="archived-thread-list">
                                {group.items.map((entry) => (
                                  <div className="archived-thread-row trash-row" key={entry.id} title={`${entry.cwd}\n${entry.originalFile}`}>
                                    <Trash size={17} />
                                    <div className="archived-thread-main">
                                      <div className="archived-thread-name" title={entry.title}>{entry.title || pathBase(entry.originalFile)}</div>
                                      <div className="archived-thread-path">
                                        {formatWhen(entry.deletedAt, language)} · {formatBytes(entry.sizeBytes)}
                                      </div>
                                    </div>
                                    <button className="set-btn" onClick={() => void restoreFromTrash(entry.id)}>
                                      {language === "zh" ? "恢复会话" : "Restore"}
                                    </button>
                                    <button
                                      className="set-btn danger"
                                      onClick={() => setTrashPurgeConfirm({ id: entry.id, title: entry.title || entry.originalFile })}
                                    >
                                      {language === "zh" ? "永久删除" : "Delete forever"}
                                    </button>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}

            {tab === "data" && (
              <div className="set-card">
                <div className="set-card-title">{language === "zh" ? "备份与恢复" : "Backup & restore"}</div>
                {/* App settings (config.json) */}
                <div className="set-card-title">{language === "zh" ? "应用设置" : "App settings"}</div>
                <div className="set-hint archived-project-hint">
                  {language === "zh"
                    ? "备份 MPI 的应用配置（主题、语言、置顶、头像、用户画像、定时任务等），导出为单个 JSON 文件。模型与提供商存于 ~/.pi/agent（与终端 pi 共享），不在备份范围内；机器相关项（pi 路径、窗口位置）导入时不会恢复。"
                    : "Backs up MPI's app settings (theme, language, pins, avatars, user profile, automations…) as a single JSON file. Model providers live in ~/.pi/agent (shared with terminal pi) and are not included; machine-specific items (pi path, window position) are never restored on import."}
                </div>
                <div className="set-diag-btns">
                  <button className="set-btn" disabled={!!bkBusy || !backupApi} onClick={() => void doExportConfig()}>
                    {bkBusy === "exportConfig" && <span className="spinner" />}
                    {language === "zh" ? "导出配置" : "Export config"}
                  </button>
                  <button className="set-btn" disabled={!!bkBusy || !backupApi} onClick={() => void doPickConfigImport()}>
                    {bkBusy === "importConfig" && <span className="spinner" />}
                    {language === "zh" ? "导入配置" : "Import config"}
                  </button>
                </div>

                {/* Sessions */}
                <div className="archived-thread-section">
                  <div className="set-card-title trash-head-row">
                    <span>
                      {language === "zh" ? "会话" : "Sessions"}
                      {bkGroups && bkGroups.length > 0 && (
                        <span className="trash-count">
                          {` · ${bkSelected.size}/${bkGroups.length} ${language === "zh" ? "个项目" : "projects"} · ${formatBytes(bkSelectedBytes)}`}
                        </span>
                      )}
                    </span>
                    {bkGroups && bkGroups.length > 0 && (
                      <div className="backup-select-actions">
                        <button
                          className="set-btn ghost"
                          onClick={() => setBkSelected(new Set(bkGroups.map((g) => g.dirName)))}
                        >
                          {language === "zh" ? "全选" : "Select all"}
                        </button>
                        <button className="set-btn ghost" onClick={() => setBkSelected(new Set())}>
                          {language === "zh" ? "清空" : "Clear"}
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="set-hint archived-project-hint">
                    {language === "zh"
                      ? "勾选要导出的项目（会话以原始 JSONL 打包为 zip，保留项目结构）；导入时恢复到原来的项目位置。已存在的文件默认跳过，也可选择覆盖。"
                      : "Tick the projects to export (sessions are zipped as raw JSONL, keeping project structure); import restores them to their original projects. Existing files are skipped by default — overwriting is optional."}
                  </div>
                  {bkGroups === null ? (
                    <div className="set-empty">
                      <span className="spinner" />
                    </div>
                  ) : bkGroups.length === 0 ? (
                    <div className="set-empty">{language === "zh" ? "暂无会话。" : "No sessions yet."}</div>
                  ) : (
                    <>
                      <div className="backup-project-list">
                        {bkGroups.map((g) => (
                          <label className="backup-project-row" key={g.dirName} title={g.dirName}>
                            <input
                              type="checkbox"
                              checked={bkSelected.has(g.dirName)}
                              onChange={() => toggleBkDir(g.dirName)}
                            />
                            <span className="backup-project-name">{bkDirNames.get(g.dirName) || g.dirName}</span>
                            <span className="backup-project-meta">
                              {g.count} {language === "zh" ? "个会话" : `session${g.count === 1 ? "" : "s"}`} ·{" "}
                              {formatBytes(g.totalBytes)}
                            </span>
                          </label>
                        ))}
                      </div>
                      <div className="set-diag-btns backup-actions">
                        <button
                          className="set-btn primary"
                          disabled={!!bkBusy || bkSelected.size === 0}
                          onClick={() => void doExportSessions()}
                        >
                          {bkBusy === "exportSessions" && <span className="spinner" />}
                          {language === "zh" ? `导出所选会话（${bkSelected.size}）` : `Export selected (${bkSelected.size})`}
                        </button>
                        <button className="set-btn" disabled={!!bkBusy} onClick={() => void doPickSessionImport()}>
                          {bkBusy === "importSessions" && <span className="spinner" />}
                          {language === "zh" ? "导入会话" : "Import sessions"}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}

            {tab === "system" && (
              <>
                <div className="set-card">
                  <Field
                    label={language === "zh" ? "开机自启动" : "Launch at startup"}
                    hint={
                      language === "zh"
                        ? "登录系统时自动启动 MPI（Windows 下通过开始菜单的启动项实现）。"
                        : "Starts MPI automatically when you sign in (uses the OS startup folder on Windows)."
                    }
                  >
                    <label className="theme-sys-check">
                      <input type="checkbox" checked={sysDraft.autoLaunch} disabled={initialSys === ""} onChange={(e) => setSysDraft({ autoLaunch: e.target.checked })} />
                      <span>{language === "zh" ? "登录系统时自动启动" : "Start automatically at sign-in"}</span>
                    </label>
                  </Field>
                </div>

                <AppUpdatePanel />
                <PiCoreUpdatePanel />

                <div className="set-card">
                  <div className="set-card-title">Pi 运行时</div>
                  {diag?.error && <div className="set-diag-err">⚠ {diag.error}</div>}
                  <div className="set-diag-grid">
                    <div className="set-diag-k">node</div>
                    <div className="set-diag-v">{diag?.node || "—"}</div>
                    <div className="set-diag-k">node 版本</div>
                    <div className="set-diag-v">{diag?.nodeVersion || "—"}</div>
                    <div className="set-diag-k">pi cli.js</div>
                    <div className="set-diag-v">{diag?.cli || "—"}</div>
                    <div className="set-diag-k">pi 版本</div>
                    <div className="set-diag-v">{diag?.piVersion || "—"}</div>
                  </div>
                </div>

                <div className="set-card">
                  <div className="set-card-title">{language === "zh" ? "Shell 运行时" : "Shell runtime"}</div>
                  {shellInfo?.needsInstall && (
                    <div className="set-diag-err">
                      ⚠
                      {language === "zh"
                        ? " 未检测到可用的 bash（Git Bash）：命令会回退到 PowerShell 执行。装上 Git for Windows 后点「重新检测」即可自动接管。"
                        : " No usable bash (Git Bash) found — commands fall back to PowerShell. Install Git for Windows, then click Re-check."}
                    </div>
                  )}
                  <div className="set-diag-grid">
                    <div className="set-diag-k">shell</div>
                    <div className="set-diag-v">
                      {shellInfo ? (shellInfo.kind === "bash" ? "Git Bash (POSIX bash)" : "PowerShell") : "—"}
                    </div>
                    <div className="set-diag-k">{language === "zh" ? "路径" : "path"}</div>
                    <div className="set-diag-v">{shellInfo?.path || "—"}</div>
                    <div className="set-diag-k">{language === "zh" ? "版本" : "version"}</div>
                    <div className="set-diag-v">{shellInfo?.version || "—"}</div>
                    <div className="set-diag-k">{language === "zh" ? "来源" : "source"}</div>
                    <div className="set-diag-v">{shellInfo?.source || "—"}</div>
                  </div>
                  {shellInfo?.configuredPathStale && (
                    <div className="set-hint" style={{ marginTop: 8 }}>
                      {language === "zh"
                        ? "settings.json 里的 shellPath 已失效，点「重新检测」会写回当前可用的路径。"
                        : "The shellPath in settings.json no longer exists; Re-check writes back the usable path."}
                    </div>
                  )}
                  <div className="set-diag-btns">
                    <button
                      className="set-btn ghost"
                      disabled={shellBusy}
                      onClick={async () => {
                        setShellBusy(true);
                        try {
                          const s = await window.pi.settings.recheckShell();
                          setShellInfo(s);
                        } finally {
                          setShellBusy(false);
                        }
                      }}
                    >
                      {shellBusy ? <span className="spinner" /> : language === "zh" ? "重新检测" : "Re-check"}
                    </button>
                    {shellInfo?.needsInstall && (
                      <button className="set-btn" onClick={() => void window.pi.settings.openGitDownload()}>
                        {language === "zh" ? "下载 Git for Windows" : "Get Git for Windows"}
                      </button>
                    )}
                  </div>
                  <div className="set-hint" style={{ marginTop: 8 }}>
                    {language === "zh"
                      ? "这是每次会话中命令实际运行的 shell，会话启动时会写入模型的系统提示，因此模型不会再自行改用 PowerShell（嵌套 shell 会带来编码乱码、引号吞噬与逐条审批）。"
                      : "This is the shell commands actually run in. It is written into the model's system prompt each session, so the model stops reaching for PowerShell (nested shells cause encoding mojibake, quote swallowing and an approval prompt per command)."}
                  </div>
                </div>

                <div className="set-card">
                  <div className="set-card-title">配置文件</div>
                  <div className="set-diag-grid">
                    <div className="set-diag-k">配置目录</div>
                    <div className="set-diag-v">{paths?.agentDir || diag?.agentDir || "—"}</div>
                    <div className="set-diag-k">settings.json</div>
                    <div className="set-diag-v">{paths?.settings || "—"}</div>
                    <div className="set-diag-k">models.json</div>
                    <div className="set-diag-v">{paths?.models || "—"}</div>
                    <div className="set-diag-k">auth.json</div>
                    <div className="set-diag-v">{paths?.auth || "—"}</div>
                  </div>
                  <div className="set-diag-btns">
                    <button className="set-btn ghost" onClick={() => window.pi.settings.openAgentDir()}>
                      打开配置目录
                    </button>
                    <button className="set-btn ghost" onClick={() => paths && openFile(paths.settings)}>
                      打开 settings.json
                    </button>
                    <button className="set-btn ghost" onClick={() => paths && openFile(paths.models)}>
                      打开 models.json
                    </button>
                    {paths && (
                      <button className="set-btn ghost" onClick={() => window.pi.settings.showItem(paths.models)} title="在资源管理器中显示">
                        在资源管理器显示
                      </button>
                    )}
                  </div>
                  <div className="set-hint" style={{ marginTop: 8 }}>
                    这些文件由桌面端与终端 pi 共享。在此面板保存会原子写回并保留你手写的高级字段；也可用上方按钮直接在外部编辑。
                  </div>
                </div>
              </>
            )}

          </div>
        </section>

        {trashPurgeConfirm && (
          <div className="modal-backdrop" onMouseDown={() => setTrashPurgeConfirm(null)}>
            <div
              className="modal thread-delete-confirm"
              onMouseDown={(event) => event.stopPropagation()}
              role="alertdialog"
              aria-modal="true"
            >
              <div className="modal-title">{language === "zh" ? "永久删除？" : "Delete forever?"}</div>
              <div className="modal-msg">
                {language === "zh"
                  ? `“${trashPurgeConfirm.title}”将从回收站中永久删除，无法恢复。`
                  : `“${trashPurgeConfirm.title}” will be permanently deleted from the trash and cannot be recovered.`}
              </div>
              <div className="modal-actions">
                <button className="btn" onClick={() => setTrashPurgeConfirm(null)}>{language === "zh" ? "取消" : "Cancel"}</button>
                <button
                  className="btn danger"
                  onClick={() => {
                    const item = trashPurgeConfirm;
                    setTrashPurgeConfirm(null);
                    void purgeFromTrash(item.id);
                  }}
                >
                  <Trash size={13} />
                  {language === "zh" ? "永久删除" : "Delete forever"}
                </button>
              </div>
            </div>
          </div>
        )}
        {trashEmptyConfirm && (
          <div className="modal-backdrop" onMouseDown={() => setTrashEmptyConfirm(false)}>
            <div
              className="modal thread-delete-confirm"
              onMouseDown={(event) => event.stopPropagation()}
              role="alertdialog"
              aria-modal="true"
            >
              <div className="modal-title">{language === "zh" ? "清空回收站？" : "Empty trash?"}</div>
              <div className="modal-msg">
                {language === "zh"
                  ? `回收站中的 ${trashEntries.length} 个会话将被永久删除，无法恢复。`
                  : `${trashEntries.length} session${trashEntries.length === 1 ? "" : "s"} in the trash will be permanently deleted and cannot be recovered.`}
              </div>
              <div className="modal-actions">
                <button className="btn" onClick={() => setTrashEmptyConfirm(false)}>{language === "zh" ? "取消" : "Cancel"}</button>
                <button
                  className="btn danger"
                  onClick={() => {
                    setTrashEmptyConfirm(false);
                    void emptyTrash();
                  }}
                >
                  <Trash size={13} />
                  {language === "zh" ? "清空" : "Empty trash"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Backup: confirm replacing app settings from a config backup. */}
        {configImportPreview && (
          <div className="modal-backdrop" onMouseDown={() => setConfigImportPreview(null)}>
            <div
              className="modal thread-delete-confirm"
              onMouseDown={(event) => event.stopPropagation()}
              role="alertdialog"
              aria-modal="true"
            >
              <div className="modal-title">{language === "zh" ? "导入应用设置？" : "Import app settings?"}</div>
              <div className="modal-msg">
                {language === "zh"
                  ? `备份文件包含 ${configImportPreview.fields.length} 项可识别的设置，将覆盖当前对应项（其余设置保持不变）。机器相关项（pi 路径、窗口位置）不会被恢复。`
                  : `The backup contains ${configImportPreview.fields.length} recognizable setting${
                      configImportPreview.fields.length === 1 ? "" : "s"
                    }. They will overwrite the current values (everything else stays). Machine-specific items (pi path, window position) are not restored.`}
              </div>
              <div className="modal-actions">
                <button className="btn" onClick={() => setConfigImportPreview(null)}>
                  {language === "zh" ? "取消" : "Cancel"}
                </button>
                <button
                  className="btn primary"
                  disabled={bkBusy !== null}
                  onClick={() => void doApplyConfigImport()}
                >
                  {bkBusy === "importConfig" && <span className="spinner" />}
                  {language === "zh" ? "导入" : "Import"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Backup: session zip summary — skip existing vs overwrite all. */}
        {sessionImportPreview && (
          <div className="modal-backdrop" onMouseDown={() => setSessionImportPreview(null)}>
            <div
              className="modal thread-delete-confirm"
              onMouseDown={(event) => event.stopPropagation()}
              role="alertdialog"
              aria-modal="true"
            >
              <div className="modal-title">{language === "zh" ? "导入会话？" : "Import sessions?"}</div>
              <div className="modal-msg">
                {language === "zh"
                  ? `备份包含 ${sessionImportPreview.total} 个会话：${sessionImportPreview.newCount} 个新会话，${sessionImportPreview.existingCount} 个已存在。`
                  : `The archive contains ${sessionImportPreview.total} session${
                      sessionImportPreview.total === 1 ? "" : "s"
                    }: ${sessionImportPreview.newCount} new, ${sessionImportPreview.existingCount} already present.`}
              </div>
              <div className="modal-actions">
                <button className="btn" onClick={() => setSessionImportPreview(null)}>
                  {language === "zh" ? "取消" : "Cancel"}
                </button>
                {sessionImportPreview.existingCount > 0 && (
                  <button
                    className="btn danger"
                    disabled={bkBusy !== null}
                    onClick={() => void doImportSessions("overwrite")}
                  >
                    {bkBusy === "importSessions" && <span className="spinner" />}
                    {language === "zh"
                      ? `覆盖全部（${sessionImportPreview.existingCount}）`
                      : `Overwrite all (${sessionImportPreview.existingCount})`}
                  </button>
                )}
                {sessionImportPreview.newCount > 0 && (
                  <button
                    className="btn primary"
                    disabled={bkBusy !== null}
                    onClick={() => void doImportSessions("skip")}
                  >
                    {language === "zh" ? `导入新会话（${sessionImportPreview.newCount}）` : `Import new (${sessionImportPreview.newCount})`}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
