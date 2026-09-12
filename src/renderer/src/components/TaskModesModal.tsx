import { useEffect, useState } from "react";
import { useStore } from "../store";
import type { PermissionLevel, TaskModeDef } from "../lib/types";
import { normalizeTaskModes, taskModeName, taskModeSummary } from "../lib/task-modes";
import { Close, Edit, Plus, Trash } from "./icons";

/** One-line parameter labels shared by the form selects. */
const PERMISSION_OPTIONS: { value: PermissionLevel; zh: string; en: string }[] = [
  { value: "readonly", zh: "只读", en: "Read-only" },
  { value: "strict", zh: "严格", en: "Strict" },
  { value: "sandbox", zh: "沙盒", en: "Sandbox" },
  { value: "full", zh: "完全权限", en: "Full access" },
];

const THINKING_OPTIONS: { value: string; zh: string; en: string }[] = [
  { value: "off", zh: "关闭", en: "Off" },
  { value: "minimal", zh: "最低", en: "Minimal" },
  { value: "low", zh: "低", en: "Low" },
  { value: "medium", zh: "中", en: "Medium" },
  { value: "high", zh: "高", en: "High" },
  { value: "xhigh", zh: "极高", en: "X-high" },
  { value: "max", zh: "最高", en: "Max" },
];

type FormState = { id: string | null; name: string; permission: string; thinking: string };

/** Management dialog for user-defined task modes (add / edit / delete).
 * Built-in short/long task modes can be re-parameterized but not deleted. */
export function TaskModesModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const config = useStore((s) => s.config);
  const saveTaskModes = useStore((s) => s.saveTaskModes);
  const language = useStore((s) => s.config?.language || "en");
  const zh = language === "zh";

  const modes = normalizeTaskModes(config?.taskModes);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);

  // Reset to the list view each time the dialog opens.
  useEffect(() => {
    if (open) setForm(null);
  }, [open]);

  // Esc closes even when focus is inside an input.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const startAdd = () => setForm({ id: null, name: "", permission: "sandbox", thinking: "" });
  const startEdit = (m: TaskModeDef) =>
    setForm({ id: m.id, name: m.name || "", permission: m.permission ?? "", thinking: m.thinking ?? "" });

  // Name must be unique among the OTHER modes (editing keeps its own name).
  const nameTaken = !!form && modes.some((m) => m.id !== form.id && m.name?.trim() === form.name.trim());
  const isBuiltinEdit = !!form?.id && modes.some((m) => m.id === form.id && m.builtin);
  const formNameValid = !form || isBuiltinEdit || (form.name.trim().length > 0 && !nameTaken);

  const save = async () => {
    if (!form || saving) return;
    setSaving(true);
    try {
      let next: TaskModeDef[];
      if (form.id) {
        // Edit existing (built-ins keep their fixed display name).
        next = modes.map((m) =>
          m.id === form.id
            ? { ...m, ...(form.name.trim() && !m.builtin ? { name: form.name.trim().slice(0, 40) } : {}), permission: (form.permission || undefined) as PermissionLevel | undefined, thinking: form.thinking || undefined }
            : m,
        );
      } else {
        next = [
          ...modes,
          { id: crypto.randomUUID(), name: form.name.trim().slice(0, 40), permission: (form.permission || undefined) as PermissionLevel | undefined, thinking: form.thinking || undefined },
        ];
      }
      const ok = await saveTaskModes(next);
      if (ok) setForm(null);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    const target = modes.find((m) => m.id === id);
    if (!target || target.builtin) return;
    await saveTaskModes(modes.filter((m) => m.id !== id));
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal tm-modal">
        <div className="tm-head">
          <span className="tm-title">{zh ? "任务模式" : "Task modes"}</span>
          <button className="iconbtn" title={zh ? "关闭" : "Close"} onClick={onClose}>
            <Close size={15} />
          </button>
        </div>

        {form ? (
          <div className="tm-form">
            <div className="tm-field">
              <label>{zh ? "名称" : "Name"}</label>
              {form.id && modes.some((m) => m.id === form.id && m.builtin) ? (
                <input value={taskModeName(modes.find((m) => m.id === form.id)!, language)} disabled />
              ) : (
                <>
                  <input
                    autoFocus
                    value={form.name}
                    maxLength={40}
                    placeholder={zh ? "例如：代码评审" : "e.g. Code review"}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                  {nameTaken && <small className="tm-error">{zh ? "名称已存在" : "Name already in use"}</small>}
                </>
              )}
            </div>
            <div className="tm-field">
              <label>{zh ? "权限级别" : "Permission"}</label>
              <select value={form.permission} onChange={(e) => setForm({ ...form, permission: e.target.value })}>
                <option value="">{zh ? "不改变（保持当前）" : "Leave unchanged"}</option>
                {PERMISSION_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {zh ? o.zh : o.en}
                  </option>
                ))}
              </select>
            </div>
            <div className="tm-field">
              <label>{zh ? "思考等级" : "Thinking level"}</label>
              <select value={form.thinking} onChange={(e) => setForm({ ...form, thinking: e.target.value })}>
                <option value="">{zh ? "不改变（保持当前）" : "Leave unchanged"}</option>
                {THINKING_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {zh ? o.zh : o.en}
                  </option>
                ))}
              </select>
            </div>
            <p className="tm-hint">
              {zh
                ? "应用该模式时会批量设置所选参数；「不改变」的参数保持会话当前值。模型不受任务模式影响。"
                : "Applying a mode sets the chosen parameters in one go; “leave unchanged” keeps the thread's current value. The model is not affected by task modes."}
            </p>
            <div className="tm-actions">
              <button className="btn" onClick={() => setForm(null)}>
                {zh ? "取消" : "Cancel"}
              </button>
              <button className="btn primary" disabled={!formNameValid || saving} onClick={() => void save()}>
                {saving ? (zh ? "保存中…" : "Saving…") : zh ? "保存" : "Save"}
              </button>
            </div>
          </div>
        ) : (
          <>
            <p className="tm-hint">
              {zh
                ? "任务模式 = 权限级别 + 思考等级的命名预设，点击输入框左下的模式按钮即可应用。内置模式可改参数、不可删除。"
                : "A task mode is a named preset of permission level + thinking level, applied from the pill in the composer. Built-ins can be re-parameterized but not deleted."}
            </p>
            <div className="tm-list">
              {modes.map((m) => (
                <div key={m.id} className="tm-row">
                  <div className="tm-row-main">
                    <span className="tm-row-name">
                      {taskModeName(m, language)}
                      {m.builtin && <small className="tm-builtin">{zh ? "内置" : "Built-in"}</small>}
                    </span>
                    <span className="tm-row-summary">{taskModeSummary(m, language)}</span>
                  </div>
                  <button className="iconbtn" title={zh ? "编辑参数" : "Edit parameters"} onClick={() => startEdit(m)}>
                    <Edit size={14} />
                  </button>
                  <button
                    className={`iconbtn ${m.builtin ? "disabled" : ""}`}
                    title={m.builtin ? (zh ? "内置模式不可删除" : "Built-in modes cannot be deleted") : zh ? "删除" : "Delete"}
                    disabled={!!m.builtin}
                    onClick={() => void remove(m.id)}
                  >
                    <Trash size={14} />
                  </button>
                </div>
              ))}
            </div>
            <div className="tm-actions">
              <button className="btn primary" onClick={startAdd}>
                <Plus size={13} /> {zh ? "新建模式" : "New mode"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
