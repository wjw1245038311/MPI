import { useCallback, useEffect, useState } from "react";
import { useStore } from "../store";
import { Markdown } from "../lib/markdown";
import { Close, Refresh, Sprout } from "./icons";

type KbFile = { path: string; size: number; mtime: number };
type Mem0Status = { online: boolean; baseUrl: string; userId: string; count: number | null };
type ZhiyaTab = "persona" | "assets" | "kb" | "mem0";

/** 知芽 Zhiya — the agent's brain & soul panel.
 * Four layers, top to bottom: persona (injected), assets (injected),
 * knowledge base (per-project .alexandria/knowledge/, queried on demand),
 * short-term memory (local mem0 server). */
export function ZhiyaPanel() {
  const open = useStore((s) => s.zhiyaOpen);
  const close = useStore((s) => s.closeZhiya);
  const language = useStore((s) => s.config?.language || "en");
  const zh = language === "zh";
  const cwd = useStore((s) => s.activeProjectCwd);

  // ---- persona + assets (injected into every session's system prompt) ----
  const [dir, setDir] = useState("");
  const [budget, setBudget] = useState(4000);
  const [persona, setPersona] = useState("");
  const [assets, setAssets] = useState("");
  const [initialPersona, setInitialPersona] = useState("");
  const [initialAssets, setInitialAssets] = useState("");
  const [saving, setSaving] = useState<null | "persona" | "assets">(null);

  // ---- knowledge base (per-project) ----
  const [kbExists, setKbExists] = useState(false);
  const [kbFiles, setKbFiles] = useState<KbFile[]>([]);
  const [selPath, setSelPath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState("");

  // ---- short-term memory (mem0) ----
  const [mem0, setMem0] = useState<Mem0Status | null>(null);

  // ---- top tab bar（顶部分栏，同 PluginsPanel 的 .plugin-tab 样式）----
  const [tab, setTab] = useState<ZhiyaTab>("persona");

  const personaDirty = persona !== initialPersona;
  const assetsDirty = assets !== initialAssets;

  const toast = useCallback((kind: "info" | "error", text: string) => {
    useStore.getState().pushToast(kind, text);
  }, []);

  const loadCore = useCallback(async () => {
    try {
      const d = await window.pi.zhiya.get();
      setDir(d.dir);
      setBudget(d.budget);
      setPersona(d.persona);
      setInitialPersona(d.persona);
      setAssets(d.assets);
      setInitialAssets(d.assets);
    } catch (e: any) {
      toast("error", (zh ? "加载知芽失败：" : "Failed to load Zhiya: ") + (e?.message || e));
    }
  }, [toast, zh]);

  const loadKb = useCallback(async () => {
    if (!cwd) return;
    try {
      const r = await window.pi.zhiya.listKb(cwd);
      setKbExists(r.exists);
      setKbFiles(r.files || []);
      // Keep the selection valid; default to Architecture.md, else first file.
      setSelPath((prev) => {
        if (prev && r.files.some((f) => f.path === prev)) return prev;
        const arch = r.files.find((f) => f.path === "Architecture.md");
        return arch?.path || r.files[0]?.path || null;
      });
    } catch {
      setKbExists(false);
      setKbFiles([]);
    }
  }, [cwd]);

  const loadMem0 = useCallback(async () => {
    try {
      setMem0(await window.pi.zhiya.mem0Status());
    } catch {
      setMem0(null);
    }
  }, []);

  useEffect(() => {
    if (open) {
      void loadCore();
      void loadMem0();
    }
  }, [open, loadCore, loadMem0]);

  useEffect(() => {
    if (open) void loadKb();
  }, [open, cwd, loadKb]);

  // Load the selected KB file's content.
  useEffect(() => {
    if (!open || !cwd || !selPath) return;
    let cancelled = false;
    window.pi.zhiya
      .getKbFile(cwd, selPath)
      .then((r) => {
        if (!cancelled) setFileContent(r.content);
      })
      .catch(() => {
        if (!cancelled) setFileContent("");
      });
    return () => {
      cancelled = true;
    };
  }, [open, cwd, selPath]);

  const savePersona = async () => {
    setSaving("persona");
    try {
      await window.pi.zhiya.setPersona(persona);
      setInitialPersona(persona);
      toast("info", zh ? "画像已保存，对新会话生效。" : "Persona saved. Applies to new sessions.");
    } catch (e: any) {
      toast("error", (zh ? "保存失败：" : "Save failed: ") + (e?.message || e));
    } finally {
      setSaving(null);
    }
  };

  const saveAssets = async () => {
    setSaving("assets");
    try {
      await window.pi.zhiya.setAssets(assets);
      setInitialAssets(assets);
      toast("info", zh ? "资产已保存，对新会话生效。" : "Assets saved. Applies to new sessions.");
    } catch (e: any) {
      toast("error", (zh ? "保存失败：" : "Save failed: ") + (e?.message || e));
    } finally {
      setSaving(null);
    }
  };

  const openObsidian = async () => {
    if (!cwd) return;
    try {
      const r = await window.pi.zhiya.openObsidian(cwd);
      if (!r.ok) toast("error", zh ? "无法打开 Obsidian（未安装或 URI 被拒绝）" : "Could not open Obsidian (not installed?)");
    } catch (e: any) {
      toast("error", (zh ? "打开失败：" : "Open failed: ") + (e?.message || e));
    }
  };

  if (!open) return null;

  const latestMtime = kbFiles.length ? Math.max(...kbFiles.map((f) => f.mtime)) : null;

  return (
    <div className="settings-backdrop" onMouseDown={close}>
      <div className="zhiya-modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <header className="zhiya-head">
          <div className="zhiya-head-title">
            <span className="set-brand-mark zhiya-sprout">
              <Sprout size={19} />
            </span>
            <div>
              <div className="zhiya-title">{zh ? "知芽 · 智能体的大脑与灵魂" : "Zhiya · the agent's brain & soul"}</div>
              <div className="zhiya-subtitle">
                {zh
                  ? "画像与资产注入每个会话；知识库按需检索；记忆随时间沉淀。"
                  : "Persona & assets injected into every session; knowledge queried on demand; memory settles over time."}
              </div>
            </div>
          </div>
          <button className="iconbtn" onClick={close} title={zh ? "关闭" : "Close"} aria-label={zh ? "关闭" : "Close"}>
            <Close size={16} />
          </button>
        </header>

        <div className="zhiya-tabs-row">
          <div className="plugins-module-tabs" role="tablist" aria-label={zh ? "知芽模块" : "Zhiya modules"}>
            <button type="button" role="tab" aria-selected={tab === "persona"} className={`plugin-tab${tab === "persona" ? " active" : ""}`} onClick={() => setTab("persona")}>
              {zh ? "人物画像" : "Persona"}
            </button>
            <button type="button" role="tab" aria-selected={tab === "assets"} className={`plugin-tab${tab === "assets" ? " active" : ""}`} onClick={() => setTab("assets")}>
              {zh ? "资产" : "Assets"}
            </button>
            <button type="button" role="tab" aria-selected={tab === "kb"} className={`plugin-tab${tab === "kb" ? " active" : ""}`} onClick={() => setTab("kb")}>
              {zh ? "知识库" : "Knowledge base"} <span className="tabs-count">{kbFiles.length}</span>
            </button>
            <button type="button" role="tab" aria-selected={tab === "mem0"} className={`plugin-tab${tab === "mem0" ? " active" : ""}`} onClick={() => setTab("mem0")}>
              {zh ? "短期记忆" : "Memory"}
              {typeof mem0?.count === "number" && <span className="tabs-count">{mem0.count}</span>}
            </button>
          </div>
        </div>

        <div className="zhiya-body">
          {tab === "persona" && (
          <section className="zhiya-sec zhiya-sec-fill">
            <div className="zhiya-sec-head">
              <h3>
                <span className="zhiya-num">1</span>
                {zh ? "人物画像" : "Persona"} <code>persona.md</code>
              </h3>
              <button
                className={`set-btn primary ${saving === "persona" ? "" : ""}`}
                onClick={savePersona}
                disabled={!personaDirty || !!saving}
              >
                {saving === "persona" ? <span className="spinner" /> : zh ? "保存画像" : "Save persona"}
                {personaDirty && !saving && <span className="set-dot" />}
              </button>
            </div>
            <textarea
              className="zhiya-editor"
              value={persona}
              onChange={(e) => setPersona(e.target.value)}
              spellCheck={false}
              placeholder={zh ? "你是谁、偏好什么……（Markdown；留空则不注入）" : "Who you are, what you prefer… (Markdown; empty = not injected)"}
            />
            <div className="zhiya-sec-foot">
              {zh
                ? `注入每个会话的系统提示词 · ${persona.length}/${budget} 字`
                : `Injected into every session's system prompt · ${persona.length}/${budget}`}
              {persona.length > budget && (
                <span className="zhiya-warn">{zh ? " ⚠ 超出预算，将被截断" : " ⚠ over budget, will be truncated"}</span>
              )}
            </div>
          </section>
          )}

          {tab === "assets" && (
          <section className="zhiya-sec zhiya-sec-fill">
            <div className="zhiya-sec-head">
              <h3>
                <span className="zhiya-num">2</span>
                {zh ? "资产" : "Assets"} <code>assets.md</code>
              </h3>
              <button className="set-btn primary" onClick={saveAssets} disabled={!assetsDirty || !!saving}>
                {saving === "assets" ? <span className="spinner" /> : zh ? "保存资产" : "Save assets"}
                {assetsDirty && !saving && <span className="set-dot" />}
              </button>
            </div>
            <textarea
              className="zhiya-editor zhiya-editor-sm"
              value={assets}
              onChange={(e) => setAssets(e.target.value)}
              spellCheck={false}
              placeholder={zh ? "本机服务与工具，一行一条……（Markdown；留空则不注入）" : "Local services & tools, one per line… (Markdown; empty = not injected)"}
            />
            <div className="zhiya-sec-foot">
              {zh
                ? `注入每个会话的系统提示词 · ${assets.length}/${budget} 字`
                : `Injected into every session's system prompt · ${assets.length}/${budget}`}
              {assets.length > budget && (
                <span className="zhiya-warn">{zh ? " ⚠ 超出预算，将被截断" : " ⚠ over budget, will be truncated"}</span>
              )}
            </div>
          </section>
          )}

          {tab === "kb" && (
          <section className="zhiya-sec zhiya-sec-fill">
            <div className="zhiya-sec-head">
              <h3>
                <span className="zhiya-num">3</span>
                {zh ? "知识库" : "Knowledge base"} <code>.alexandria/knowledge/</code>
              </h3>
              {kbExists && (
                <button className="set-btn ghost" onClick={openObsidian}>
                  {zh ? "在 Obsidian 中打开" : "Open in Obsidian"}
                </button>
              )}
            </div>
            {cwd ? (
              kbExists ? (
                <div className="zhiya-kb">
                  <ul className="zhiya-kb-list">
                    {kbFiles.map((f) => (
                      <li key={f.path} className={selPath === f.path ? "active" : ""} onClick={() => setSelPath(f.path)}>
                        {f.path}
                      </li>
                    ))}
                  </ul>
                  <div className="zhiya-kb-view">
                    {selPath ? (
                      <Markdown text={fileContent} />
                    ) : (
                      <span className="zhiya-dim">{zh ? "选择左侧文档查看" : "Pick a document on the left"}</span>
                    )}
                  </div>
                </div>
              ) : (
                <div className="zhiya-empty">
                  {zh
                    ? "当前项目还没有 .alexandria/knowledge/（尚未初始化知识库）。"
                    : "This project has no .alexandria/knowledge/ yet (knowledge base not initialized)."}
                </div>
              )
            ) : (
              <div className="zhiya-empty">{zh ? "打开一个项目后显示其知识库。" : "Open a project to see its knowledge base."}</div>
            )}
            {kbExists && (
              <div className="zhiya-sec-foot">
                {zh
                  ? `${kbFiles.length} 篇文档` +
                    (latestMtime ? ` · 最近更新 ${new Date(latestMtime).toLocaleString()}` : "")
                  : `${kbFiles.length} document(s)` +
                    (latestMtime ? ` · last updated ${new Date(latestMtime).toLocaleString()}` : "")}
              </div>
            )}
          </section>
          )}

          {tab === "mem0" && (
          <section className="zhiya-sec">
            <div className="zhiya-sec-head">
              <h3>
                <span className="zhiya-num">4</span>
                {zh ? "短期记忆" : "Short-term memory"} <code>mem0</code>
              </h3>
              <button className="set-btn ghost" onClick={loadMem0} title={zh ? "刷新状态" : "Refresh status"}>
                <Refresh size={13} /> {zh ? "刷新" : "Refresh"}
              </button>
            </div>
            {mem0 ? (
              <div className="zhiya-mem0">
                <span className={`zhiya-dot ${mem0.online ? "on" : "off"}`} />
                {mem0.online ? (
                  <span>
                    {zh ? "在线" : "Online"} · {mem0.baseUrl}
                    {typeof mem0.count === "number" && (
                      <>
                        {" "}· {mem0.count} {zh ? "条记忆" : "memories"}
                      </>
                    )}
                  </span>
                ) : (
                  <span className="zhiya-dim">
                    {zh ? "离线" : "Offline"}（{mem0.baseUrl}）
                  </span>
                )}
              </div>
            ) : (
              <span className="zhiya-dim">{zh ? "查询中…" : "Querying…"}</span>
            )}
            <div className="zhiya-sec-foot">
              {zh
                ? "agent 自动沉淀的临时事实；稳定的画像请写进上方 persona.md。"
                : "Transient facts the agent captures automatically; keep stable traits in persona.md above."}
            </div>
          </section>
          )}

          {/* file location hint */}
          <div className="zhiya-loc">
            {zh ? "文件位置：" : "Files live at "}
            <code>{dir}</code>
            {zh ? "（可用 Obsidian / VSCode 直接编辑，保存后新会话生效）" : " (edit directly in Obsidian/VSCode; new sessions pick up changes)"}
          </div>
        </div>
      </div>
    </div>
  );
}
