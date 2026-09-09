import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { useStore } from "../store";
import type { ApiType, Diagnostics, ModelDef, ModelsFile, PermissionLevel, ProviderDef, ThinkingDefaults } from "../lib/types";
import { formatBytes } from "../lib/format";
import { reasoningLevelLabel } from "../lib/reasoning";
import { translateUiText } from "../lib/i18n";
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
  const testFingerprint = JSON.stringify({
    providerId,
    baseUrl: provider.baseUrl,
    api: provider.api,
    apiKey: provider.apiKey,
    headers: provider.headers,
    compat: provider.compat,
    model: m,
  });
  useEffect(() => setTest({ state: "idle" }), [testFingerprint]);
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
        <TokenLimitInput
          value={m.contextWindow}
          onChange={(value) => patch({ contextWindow: value })}
          label={language === "zh" ? "上下文长度（K 令牌）" : "Context length (K tokens)"}
          placeholder="128"
        />
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

type Tab = "general" | "models" | "thinking" | "archive" | "diag" | "update";

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
    key: "lm-studio",
    name: "LM Studio",
    enName: "LM Studio",
    subtitle: "本机 OpenAI 兼容服务 · 端口 1234",
    enSubtitle: "Local OpenAI-compatible service on port 1234",
    monogram: "L",
    color: "#52525b",
    baseUrl: "http://localhost:1234/v1",
    api: "openai-completions",
  },
  {
    key: "deepseek",
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
    key: "minimax",
    name: "MiniMax",
    enName: "MiniMax",
    subtitle: "Token Plan 订阅 · OpenAI 兼容端点",
    enSubtitle: "Token Plan subscription · OpenAI-compatible endpoint",
    monogram: "M",
    color: "#d97706",
    baseUrl: "https://api.minimaxi.com/v1",
    api: "openai-completions",
    modelId: "MiniMax-M2",
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
  const language = config?.language || "en";

  const [tab, setTab] = useState<Tab>("general");
  // Auto-launch at system login — OS-level state (Electron login items), not
  // config.json; read live each time settings opens. null = still loading.
  const [autoLaunch, setAutoLaunchState] = useState<boolean | null>(null);
  useEffect(() => {
    if (!open) return;
    window.pi.app.getAutoLaunch().then(setAutoLaunchState).catch(() => setAutoLaunchState(null));
  }, [open]);
  // Trash confirmation dialogs (per-item purge / empty-all).
  const [trashPurgeConfirm, setTrashPurgeConfirm] = useState<{ id: string; title: string } | null>(null);
  const [trashEmptyConfirm, setTrashEmptyConfirm] = useState(false);
  // Refresh the trash list whenever the archive tab is visible (deletes happen
  // in the sidebar, so there is no other signal to reload on).
  useEffect(() => {
    if (open && tab === "archive") loadTrash();
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
  const [invalidJson, setInvalidJson] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState<null | "models" | "thinking">(null);
  const [flash, setFlash] = useState<null | "models" | "thinking">(null);
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  // Mirrors the changelog modal state inside AppUpdatePanel (Escape guard).
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [paths, setPaths] = useState<{ agentDir: string; models: string; settings: string; auth: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [newProvider, setNewProvider] = useState<NewProviderDraft>(emptyNewProvider);
  // Models tab two-section layout: preset search query + which configured
  // provider is expanded into the full editor below the tile grid.
  const [presetQuery, setPresetQuery] = useState("");
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);

  const register = useCallback((p: string, ok: boolean) => setInvalidJson((s) => ({ ...s, [p]: ok })), []);

  useEffect(() => {
    if (!open) return;
    setTab("general");
    setInvalidJson({});
    setAdding(false);
    setNewProvider(emptyNewProvider());
    setPresetQuery("");
    setExpandedProvider(null);
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
        setDiag(d);
        setPaths(p);
      } catch (e: any) {
        pushToast("error", "读取配置失败：" + (e?.message || e));
      }
    })();
  }, [open, pushToast]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // The changelog modal owns Escape while it is open (its own listener closes it).
      if (e.key === "Escape" && !changelogOpen) attemptClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, draft, thinking, initialProviders, initialThinking, changelogOpen]);

  const modelDirty = useMemo(() => JSON.stringify(draft.providers) !== initialProviders, [draft.providers, initialProviders]);
  const thinkDirty = useMemo(() => JSON.stringify(thinking) !== initialThinking, [thinking, initialThinking]);
  function attemptClose() {
    if (
      (modelDirty || thinkDirty) &&
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
  const saveThinking = async () => {
    setSaving("thinking");
    try {
      const res = await window.pi.settings.saveThinking(thinking as Record<string, unknown>);
      setThinking(res);
      setInitialThinking(JSON.stringify(res));
      setFlash("thinking");
      setTimeout(() => setFlash(null), 1500);
      pushToast("info", "思考默认值已保存到 settings.json。");
    } catch (e: any) {
      pushToast("error", "保存失败：" + (e?.message || e));
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

  const changeTrashEnabled = async (trashEnabled: boolean) => {
    try {
      const next = await window.pi.app.setConfig({ trashEnabled });
      useStore.setState({ config: next });
    } catch (e: any) {
      pushToast("error", "保存回收站设置失败：" + (e?.message || e));
    }
  };

  const changeDiffViewMode = async (diffViewMode: "unified" | "blocks") => {
    const next = await window.pi.app.setConfig({ diffViewMode });
    useStore.setState({ config: next });
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

  const changeAutoLaunch = async (enabled: boolean) => {
    try {
      const next = await window.pi.app.setAutoLaunch(enabled);
      setAutoLaunchState(next);
    } catch (e: any) {
      pushToast(
        "error",
        language === "zh"
          ? `开机自启动设置失败：${e?.message || e}`
          : `Failed to change auto-launch: ${e?.message || e}`,
      );
    }
  };

  const changeDefaultPermission = async (defaultPermission: PermissionLevel) => {
    const next = await window.pi.app.setConfig({ defaultPermission });
    useStore.setState({ config: next });
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
            <div>
              <div className="set-brand-title">设置</div>
              <div className="set-brand-sub">MPI</div>
            </div>
          </div>
          <nav className="set-tabs">
            {([
              ["general", language === "zh" ? "通用设置" : "General"],
              ["models", "模型与提供商"],
              ["thinking", "思考默认值"],
              ["archive", language === "zh" ? "归档回收" : "Archive & trash"],
              ["diag", "诊断与配置"],
              ["update", language === "zh" ? "关于 MPI" : "About MPI"],
            ] as [Tab, string][]).map(([id, label]) => (
              <button key={id} className={`set-tab ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>
                <span className="set-tab-bar" />
                {label}
                {id === "models" && modelDirty && <span className="set-dot" />}
                {id === "thinking" && thinkDirty && <span className="set-dot" />}
              </button>
            ))}
          </nav>
          <div className="set-side-foot">
            模型/思考设置写入 <code>~/.pi/agent</code>，与终端 pi 共享；通用设置存于应用配置目录。
          </div>
        </aside>

        <section className="set-main">
          <header className="set-head">
            <h2>
              {tab === "general"
                ? language === "zh"
                  ? "通用设置"
                  : "General"
                : tab === "models"
                  ? "模型与提供商"
                : tab === "thinking"
                  ? "思考默认值"
                    : tab === "archive"
                      ? "已归档项目"
                      : tab === "update"
                      ? language === "zh"
                        ? "关于 MPI"
                        : "About MPI"
                        : "诊断与配置文件"}
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
              {tab === "thinking" && (
                <button className={`set-btn primary ${flash === "thinking" ? "saved" : ""}`} onClick={saveThinking} disabled={!!saving}>
                  {saving === "thinking" ? <span className="spinner" /> : flash === "thinking" ? "已保存 ✓" : "保存思考默认值"}
                  {thinkDirty && flash !== "thinking" && <span className="set-dot" />}
                </button>
              )}
              <button className="set-iconbtn" title="关闭" onClick={attemptClose}>
                <Close size={16} />
              </button>
            </div>
          </header>

          <div className="set-body">
            {tab === "general" && (
              <div className="set-card">
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
                  label={language === "zh" ? "开机自启动" : "Launch at startup"}
                  hint={
                    language === "zh"
                      ? "登录系统时自动启动 MPI（Windows 下通过开始菜单的启动项实现）。"
                      : "Starts MPI automatically when you sign in (uses the OS startup folder on Windows)."
                  }
                >
                  <label className="theme-sys-check">
                    <input type="checkbox" checked={autoLaunch === true} onChange={(e) => void changeAutoLaunch(e.target.checked)} />
                    <span>{language === "zh" ? "登录系统时自动启动" : "Start automatically at sign-in"}</span>
                  </label>
                </Field>
                <Field
                  label={language === "zh" ? "回收站" : "Trash"}
                  hint={
                    language === "zh"
                      ? "开启后，删除的会话先移入回收站（设置 → 归档回收），可恢复；只有在那里删除才算永久删除。关闭后删除会立即永久生效。"
                      : "When on, deleted sessions go to the trash (Settings → Archive & trash) and stay restorable; only deleting there removes them for good. When off, delete removes a session immediately."
                  }
                >
                  <label className="theme-sys-check">
                    <input type="checkbox" checked={config?.trashEnabled !== false} onChange={(e) => void changeTrashEnabled(e.target.checked)} />
                    <span>{language === "zh" ? "删除的会话先移入回收站（可恢复）" : "Deleted sessions go to the trash first (restorable)"}</span>
                  </label>
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
                    value={config?.defaultPermission || "sandbox"}
                    onChange={(e) => changeDefaultPermission(e.target.value as PermissionLevel)}
                  >
                    <option value="readonly">{language === "zh" ? "只读（修改直接阻止）" : "Read-only (mutations blocked)"}</option>
                    <option value="strict">{language === "zh" ? "严格（仅只读自动执行）" : "Strict (read-only auto-runs)"}</option>
                    <option value="sandbox">{language === "zh" ? "沙盒（低风险操作自动执行，默认）" : "Sandbox (low-risk auto-runs, default)"}</option>
                    <option value="full">{language === "zh" ? "完全权限" : "Full access"}</option>
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
              </>
            )}

            {tab === "thinking" && (
              <div className="set-card">
                <Field label="默认思考深度" hint="新建会话的初始思考等级；模型需 reasoning=true 才生效">
                  <select className="set-select" value={thinking.defaultThinkingLevel || "off"} onChange={(e) => setThinking((t) => ({ ...t, defaultThinkingLevel: e.target.value }))}>
                    {availableThinkingLevels.map((l) => (
                      <option key={l} value={l}>
                        {reasoningLevelLabel(l, config?.language || "en")}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="默认提供商">
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
                <Field label="隐藏思考块">
                  <Toggle checked={!!thinking.hideThinkingBlock} onChange={(v) => setThinking((t) => ({ ...t, hideThinkingBlock: v }))} />
                </Field>
                <div className="set-hint" style={{ marginTop: 8 }}>
                  这些是全局默认值，写入 settings.json。单个模型的思考能力由该模型的“思考”开关与 compat 决定。
                </div>
              </div>
            )}

            {tab === "archive" && (
              <div className="set-card">
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

            {tab === "diag" && (
              <>
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

            {tab === "update" && (
              <>
                <AppUpdatePanel onChangelogOpenChange={setChangelogOpen} />
                <PiCoreUpdatePanel />
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

      </div>
    </div>
  );
}
