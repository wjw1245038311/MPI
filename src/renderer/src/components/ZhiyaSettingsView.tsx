import { useEffect, useState } from "react";
import { useStore } from "../store";

type Providers = Record<string, { models?: { id: string }[] }>;

/**
 * 知芽设置侧板：母版目录 + 记忆模型 + 巩固（dream）。
 * 原来散在 ZhiyaPanel 模态底部与设置页，这里收成一处。
 */
export function ZhiyaSettingsView({ zh }: { zh: boolean }) {
  const config = useStore((s) => s.config);
  const [masterDir, setMasterDir] = useState<string | null>(null);
  const [dirInput, setDirInput] = useState("");
  const [editDir, setEditDir] = useState(false);
  const [providers, setProviders] = useState<Providers>({});
  const [kbEdit, setKbEdit] = useState(false);
  const [kbInput, setKbInput] = useState("");
  const [mmMode, setMmMode] = useState<"none" | "session" | "model">("none");
  const [mmProvider, setMmProvider] = useState("");
  const [mmModelId, setMmModelId] = useState("");

  const toast = (kind: "info" | "warning" | "error", text: string) => useStore.getState().pushToast(kind, text);

  useEffect(() => {
    void (async () => {
      try {
        const d = await window.pi.zhiya.get();
        setMasterDir(d.masterDir);
        setDirInput(d.masterDir || "");
      } catch {
        /* ignore */
      }
      try {
        const models = await window.pi.settings.getModels();
        setProviders((models?.providers as Providers) || {});
      } catch {
        /* ignore */
      }
    })();
  }, []);

  useEffect(() => {
    const mm = config?.memoryModel;
    const raw = mm?.mode ?? (mm?.provider && mm?.model ? "model" : "none");
    setMmMode(raw === "session" ? "session" : raw === "model" ? "model" : "none");
    setMmProvider(typeof mm?.provider === "string" ? mm.provider : "");
    setMmModelId(typeof mm?.model === "string" ? mm.model : "");
  }, [config?.memoryModel]);

  const saveMasterDir = async (value: string) => {
    try {
      const r = await window.pi.zhiya.setMasterDir(value);
      if (!r.ok) {
        toast("error", zh ? "目录无效或不存在" : "Invalid or missing directory");
        return;
      }
      setMasterDir(r.masterDir);
      setDirInput(r.masterDir || "");
      toast(
        "info",
        r.masterDir ? (zh ? "已设置母版目录。" : "Master dir set.") : zh ? "已重置为自动探测。" : "Reset to auto-detection.",
      );
    } catch (e: any) {
      toast("error", (zh ? "设置失败：" : "Set failed: ") + (e?.message || e));
    }
  };

  useEffect(() => {
    setKbInput(config?.knowledgeDir || "");
  }, [config?.knowledgeDir]);

  const pickFolder = async (): Promise<string | null> => {
    try {
      return await window.pi.app.showOpenDialog("folder");
    } catch (e: any) {
      toast("error", (zh ? "选择目录失败：" : "Pick dir failed: ") + (e?.message || e));
      return null;
    }
  };

  const saveKbDir = async (value: string) => {
    try {
      const next = await window.pi.app.setConfig({ knowledgeDir: value.trim() });
      useStore.setState({ config: next });
      setKbEdit(false);
      toast("info", zh ? "已保存知识库目录。" : "Knowledge dir saved.");
    } catch (e: any) {
      toast("error", (zh ? "保存失败：" : "Save failed: ") + (e?.message || e));
    }
  };

  const browse = async () => {
    const p = await pickFolder();
    if (p) setDirInput(p);
  };

  const browseKb = async () => {
    const p = await pickFolder();
    if (p) setKbInput(p);
  };

  const saveMemoryModel = async (mode: "none" | "session" | "model", provider?: string, modelId?: string) => {
    const patch =
      mode === "session"
        ? { memoryModel: { mode } }
        : mode === "model" && provider && modelId
          ? { memoryModel: { mode, provider, model: modelId } }
          : { memoryModel: { mode: "none" as const } };
    try {
      const next = await window.pi.app.setConfig(patch);
      useStore.setState({ config: next });
    } catch (e: any) {
      toast("error", (zh ? "保存失败：" : "Save failed: ") + (e?.message || e));
    }
  };

  const saveDream = async (patch: { zhiyaDreamAuto?: boolean; zhiyaDreamLlmClassify?: boolean }) => {
    try {
      const next = await window.pi.app.setConfig(patch);
      useStore.setState({ config: next });
    } catch (e: any) {
      toast("error", (zh ? "保存失败：" : "Save failed: ") + (e?.message || e));
    }
  };

  const providerKeys = Object.keys(providers);

  return (
    <div className="zhiya-view">
      <div className="zhiya-settings-sec">
        <div className="mempool-sub">{zh ? "母版目录（git 真相源）" : "Master directory"}</div>
        <div className="zhiya-dim">
          {zh
            ? "人物画像 / 协作约定 / 工作空间的根目录；留空 = 自动探测。换电脑 clone 后设一次即可。"
            : "Root of persona / agreement / workspace; empty = auto-detect. Set once after cloning on a new machine."}
        </div>
        <div className="zhiya-setting-row">
          <code>{masterDir || (zh ? "（未探测到）" : "(not found)")}</code>
        </div>
        {!editDir ? (
          <div className="zhiya-setting-actions">
            <button
              className="set-btn ghost"
              onClick={() => {
                setDirInput(masterDir || "");
                setEditDir(true);
              }}
            >
              {zh ? "修改" : "Edit"}
            </button>
            <button className="set-btn ghost" onClick={() => void saveMasterDir("")}>
              {zh ? "重置为自动探测" : "Reset to auto"}
            </button>
          </div>
        ) : (
          <div className="zhiya-setting-actions">
            <input
              className="set-input zhiya-dir-input"
              value={dirInput}
              onChange={(e) => setDirInput(e.target.value)}
              placeholder={zh ? "母版根目录绝对路径" : "Master root absolute path"}
              spellCheck={false}
            />
            <button className="set-btn ghost" onClick={browse}>
              {zh ? "浏览…" : "Browse…"}
            </button>
            <button className="set-btn primary" onClick={() => void saveMasterDir(dirInput)}>
              {zh ? "保存" : "Save"}
            </button>
            <button className="set-btn ghost" onClick={() => setEditDir(false)}>
              {zh ? "取消" : "Cancel"}
            </button>
          </div>
        )}
      </div>

      <div className="zhiya-settings-sec">
        <div className="mempool-sub">{zh ? "知识库目录" : "Knowledge base dir"}</div>
        <div className="zhiya-dim">
          {zh
            ? "目录里放 md 文件即可；留空 = 每个项目自己的 .alexandria/knowledge（跟项目走）。"
            : "Point at a folder of md files; empty = each project's own .alexandria/knowledge."}
        </div>
        <div className="zhiya-setting-row">
          <code>
            {(config?.knowledgeDir || "").trim() ||
              (zh ? "（未设：用项目内的 .alexandria/knowledge）" : "(unset: per-project .alexandria/knowledge)")}
          </code>
        </div>
        {!kbEdit ? (
          <div className="zhiya-setting-actions">
            <button
              className="set-btn ghost"
              onClick={() => {
                setKbInput(config?.knowledgeDir || "");
                setKbEdit(true);
              }}
            >
              {zh ? "修改" : "Edit"}
            </button>
            <button className="set-btn ghost" onClick={() => void saveKbDir("")}>
              {zh ? "重置为项目内" : "Reset to per-project"}
            </button>
          </div>
        ) : (
          <div className="zhiya-setting-actions">
            <input
              className="set-input zhiya-dir-input"
              value={kbInput}
              onChange={(e) => setKbInput(e.target.value)}
              placeholder={zh ? "知识库目录绝对路径" : "Knowledge dir absolute path"}
              spellCheck={false}
            />
            <button className="set-btn ghost" onClick={browseKb}>
              {zh ? "浏览…" : "Browse…"}
            </button>
            <button className="set-btn primary" onClick={() => void saveKbDir(kbInput)}>
              {zh ? "保存" : "Save"}
            </button>
            <button className="set-btn ghost" onClick={() => setKbEdit(false)}>
              {zh ? "取消" : "Cancel"}
            </button>
          </div>
        )}
      </div>

      <div className="zhiya-settings-sec">
        <div className="mempool-sub">{zh ? "记忆模型" : "Memory model"}</div>
        <div className="zhiya-dim">
          {zh
            ? "记忆池用它做抽取/打分与 lesson 正文。不设置 = 完全不调模型，只用基础读写（同 mem0）。"
            : "Used for extraction/scoring and lesson drafting. Unset = no model at all, basic read/write only."}
        </div>
        <div className="zhiya-setting-actions">
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
                setMmMode("model");
                setMmProvider(v);
                setMmModelId("");
                void saveMemoryModel("model");
              }
            }}
          >
            <option value="none">{zh ? "（不设置：不使用模型）" : "(unset: no model)"}</option>
            <option value="session">{zh ? "跟随主模型" : "Follow session main model"}</option>
            {providerKeys.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <select
            className="set-select"
            value={mmModelId}
            disabled={mmMode !== "model" || !mmProvider}
            onChange={(e) => {
              const m = e.target.value;
              setMmModelId(m);
              void saveMemoryModel("model", mmProvider || undefined, m || undefined);
            }}
          >
            <option value="">{zh ? "（未设）" : "(none)"}</option>
            {(providers[mmProvider]?.models || []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="zhiya-settings-sec">
        <div className="mempool-sub">{zh ? "巩固（dream）" : "Consolidation (dream)"}</div>
        <label className="zhiya-toggle">
          <input
            type="checkbox"
            checked={config?.zhiyaDreamAuto === true}
            onChange={(e) => void saveDream({ zhiyaDreamAuto: e.target.checked })}
          />
          <span>{zh ? "自动跑巩固（默认关：只记账并提示）" : "Auto-run consolidation (default off)"}</span>
        </label>
        <label className="zhiya-toggle">
          <input
            type="checkbox"
            checked={config?.zhiyaDreamLlmClassify === true}
            onChange={(e) => void saveDream({ zhiyaDreamLlmClassify: e.target.checked })}
          />
          <span>{zh ? "六题判定调模型（默认关，用启发式）" : "Model-based triage (default off, heuristic)"}</span>
        </label>
      </div>
    </div>
  );
}
