import { useEffect, useState } from "react";
import { useStore } from "../store";
import type { AutomationRunSummary, AutomationTask, ModelsFile, ScheduleFrequency, TaskSchedule } from "../lib/types";
import { Plus, Clock, Folder, Play } from "./icons";
import { SidePanel } from "./SidePanel";

const DAY_NAMES = {
  en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  zh: ["日", "一", "二", "三", "四", "五", "六"],
} as const;
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Mon..Sun

const uid = () => `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

function newTask(): AutomationTask {
  return {
    id: uid(),
    name: "",
    cwd: "",
    prompt: "",
    schedule: { frequency: "daily", time: "09:00" },
    enabled: true,
    permission: "sandbox",
  };
}

function summarize(s: TaskSchedule, language: "en" | "zh"): string {
  if (language === "en") {
    if (s.frequency === "hourly") return `Hourly at minute ${s.minute ?? 0}`;
    if (s.frequency === "daily") return `Daily at ${s.time || "00:00"}`;
    const days = (s.days || []).map((d) => DAY_NAMES.en[d]).join(", ");
    return `Weekly on ${days || "—"} at ${s.time || "00:00"}`;
  }
  if (s.frequency === "hourly") return `每小时 第 ${s.minute ?? 0} 分钟`;
  if (s.frequency === "daily") return `每天 ${s.time || "00:00"}`;
  const days = (s.days || []).map((d) => DAY_NAMES.zh[d]).join("、");
  return `每周 ${days || "—"} ${s.time || "00:00"}`;
}

/** 「下次运行」的短描述：今天/明天只显示时刻，更远补上日期。 */
function formatNextRun(ts: number | undefined, language: "en" | "zh"): string | null {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return null;
  const when = new Date(ts);
  const now = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(when) - startOfDay(now)) / 86_400_000);
  const hhmm = `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
  if (days === 0) return language === "zh" ? `下次 ${hhmm}` : `Next ${hhmm}`;
  if (days === 1) return language === "zh" ? `下次明天 ${hhmm}` : `Next tomorrow ${hhmm}`;
  const mmdd = `${when.getMonth() + 1}/${when.getDate()}`;
  return language === "zh" ? `下次 ${mmdd} ${hhmm}` : `Next ${mmdd} ${hhmm}`;
}

/** 运行历史一行的简短描述（面板展开区用）。 */
function runStatusLabel(run: AutomationRunSummary, language: "en" | "zh"): string {
  switch (run.status) {
    case "ok":
      return language === "zh" ? "成功" : "OK";
    case "error":
      return language === "zh" ? "失败" : "Failed";
    case "aborted":
      return language === "zh" ? "已中止" : "Aborted";
    case "missed":
      return language === "zh" ? "已错过" : "Missed";
    default:
      return language === "zh" ? "未完成" : "Incomplete";
  }
}

function runTriggerLabel(run: AutomationRunSummary, language: "en" | "zh"): string {
  if (run.trigger === "manual") return language === "zh" ? "手动" : "Manual";
  if (run.trigger === "catchup") return language === "zh" ? "补跑" : "Catch-up";
  return language === "zh" ? "按时" : "Scheduled";
}

/** 运行耗时：不足 1 分钟给秒，否则分秒。 */
function runDuration(run: AutomationRunSummary): string | null {
  if (typeof run.finishedAt !== "number" || run.finishedAt <= run.startedAt) return null;
  const sec = Math.round((run.finishedAt - run.startedAt) / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, "0")}s`;
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" className={`set-toggle ${checked ? "on" : ""}`} aria-checked={checked} role="switch" onClick={() => onChange(!checked)}>
      <span className="set-toggle-knob" />
    </button>
  );
}

export function AutomationPanel() {
  const open = useStore((s) => s.automationOpen);
  const close = useStore((s) => s.closeAutomation);
  const tasks = useStore((s) => s.tasks);
  const saveTask = useStore((s) => s.saveTask);
  const deleteTask = useStore((s) => s.deleteTask);
  const runTaskNow = useStore((s) => s.runTaskNow);
  const language = useStore((s) => s.config?.language || "en");

  const [draft, setDraft] = useState<AutomationTask | null>(null);
  // Configured providers/models for the optional task-level model picker.
  const [models, setModels] = useState<ModelsFile | null>(null);
  /** 展开中的任务 id → 它的运行历史（undefined = 未加载）。 */
  const [runsByTask, setRunsByTask] = useState<Record<string, AutomationRunSummary[]>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [unreviewed, setUnreviewed] = useState(0);

  // 未查看失败数：面板关着时也要刷新（侧栏红点依赖同一来源）。
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      window.pi.automation
        .unreviewed()
        .then((n: number) => {
          if (alive) setUnreviewed(n);
        })
        .catch(() => {});
    };
    refresh();
    // 打开面板时与任务事件后各刷一次；窗口重新获得焦点时也刷（后台跑完回来）。
    window.addEventListener("focus", refresh);
    return () => {
      alive = false;
      window.removeEventListener("focus", refresh);
    };
  }, [open, tasks]);

  const loadRuns = async (taskId: string) => {
    try {
      const res = await window.pi.automation.getRuns(taskId);
      setRunsByTask((prev) => ({ ...prev, [taskId]: res.runs }));
      setUnreviewed(res.unreviewed);
    } catch {
      /* 历史是辅助信息，读失败不影响主流程 */
    }
  };

  useEffect(() => {
    if (!draft) return;
    let alive = true;
    window.pi.settings
      .getModels()
      .then((m: ModelsFile) => {
        if (alive) setModels(m);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [draft]);

  if (!open) return null;

  const patch = (p: Partial<AutomationTask>) => setDraft((d) => (d ? { ...d, ...p } : d));
  const patchSchedule = (p: Partial<TaskSchedule>) => setDraft((d) => (d ? { ...d, schedule: { ...d.schedule, ...p } } : d));

  const pickFolder = async () => {
    const p = await window.pi.app.showOpenDialog("folder");
    if (p && !Array.isArray(p)) patch({ cwd: p });
  };

  const save = async () => {
    if (!draft) return;
    if (!draft.name.trim()) return useStore.getState().pushToast("warning", "请填写任务名称");
    if (!draft.cwd) return useStore.getState().pushToast("warning", "请选择工作文件夹");
    if (!draft.prompt.trim()) return useStore.getState().pushToast("warning", "请填写要执行的提示词");
    await saveTask(draft);
    setDraft(null);
  };

  const toggleDay = (day: number) => {
    if (!draft) return;
    const days = new Set(draft.schedule.days || []);
    days.has(day) ? days.delete(day) : days.add(day);
    patchSchedule({ days: [...days].sort((a, b) => a - b) });
  };

  const setFreq = (frequency: ScheduleFrequency) => {
    if (frequency === "hourly") patchSchedule({ frequency, minute: draft?.schedule.minute ?? 0 });
    else patchSchedule({ frequency, time: draft?.schedule.time || "09:00", days: draft?.schedule.days || (frequency === "weekly" ? [1] : undefined) });
  };

  return (
    <SidePanel title={language === "zh" ? "定时任务" : "Automations"} icon={<Clock size={15} />} onClose={close}>
      <div className="plugins-body">
          {!draft && (
            <>
              <div className="plugins-install">
                <span className="muted">{language === "zh" ? `共 ${tasks.length} 个任务` : `${tasks.length} ${tasks.length === 1 ? "task" : "tasks"}`}</span>
                <button className="set-btn primary" onClick={() => setDraft(newTask())}>
                  <Plus size={14} /> {language === "zh" ? "新建任务" : "New task"}
                </button>
              </div>

              {tasks.length === 0 && <div className="set-empty">尚无定时任务。点“新建任务”创建一个。</div>}
              {unreviewed > 0 && (
                <div className="auto-unreviewed">
                  <span>
                    {language === "zh"
                      ? `${unreviewed} 条失败待查看`
                      : `${unreviewed} failed ${unreviewed === 1 ? "run" : "runs"} to review`}
                  </span>
                  <button
                    className="set-btn ghost"
                    onClick={() => {
                      void window.pi.automation.markReviewed().then((res: { unreviewed: number }) => setUnreviewed(res.unreviewed));
                    }}
                  >
                    {language === "zh" ? "全部标为已读" : "Mark all reviewed"}
                  </button>
                </div>
              )}
              {tasks.map((t) => (
                <div className="plugins-row auto-task" key={t.id}>
                  <div className="plugins-row-main">
                    <span className="plugins-row-name">
                      {t.name || (language === "zh" ? "未命名任务" : "Untitled task")}
                    </span>
                    <span className="auto-freq">{summarize(t.schedule, language)}</span>
                    <span className={`auto-freq ${t.permission === "full" ? "plugins-off" : ""}`}>
                      {t.permission === "full" ? (language === "zh" ? "完全权限" : "Full access") : language === "zh" ? "沙盒" : "Sandbox"}
                    </span>
                    {t.provider && t.modelId && (
                      <span className="auto-freq auto-model-badge" title={`${t.provider}/${t.modelId}`}>
                        🤖 {t.modelId}
                      </span>
                    )}
                    {t.lastStatus === "error" && (
                      <span className="plugins-off warn" title={t.lastError}>
                        {language === "zh" ? "上次失败" : "Last run failed"}
                      </span>
                    )}
                    {t.lastStatus === "missed" && (
                      <span
                        className="plugins-off warn"
                        title={
                          typeof t.lastMissedAt === "number"
                            ? `${language === "zh" ? "错过计划时刻" : "Missed scheduled slot"}: ${new Date(t.lastMissedAt).toLocaleString()}`
                            : undefined
                        }
                      >
                        {language === "zh" ? "已错过" : "Missed"}
                      </span>
                    )}
                    {t.isRunning ? (
                      <span className="auto-freq auto-running">
                        <span className="auto-spinner" aria-hidden="true" />
                        {language === "zh" ? "运行中" : "Running"}
                      </span>
                    ) : (
                      (() => {
                        const next = formatNextRun(t.nextRunAt ?? undefined, language);
                        return next ? <span className="muted auto-last">{next}</span> : null;
                      })()
                    )}
                    {t.lastRunAt && !t.isRunning && (
                      <span
                        className="muted auto-last auto-last-run"
                        title={`${language === "zh" ? "上次运行" : "Last run"}: ${new Date(t.lastRunAt).toLocaleString()}`}
                      >
                        {language === "zh" ? "上次 " : "Last "}
                        {new Date(t.lastRunAt).toLocaleString()}
                      </span>
                    )}
                  </div>
                  <div className="plugins-row-sub" title={t.cwd}>
                    📁 {t.cwd}
                  </div>
                  <div className="plugins-row-sub auto-prompt">{t.prompt}</div>
                  <div className="plugins-row-actions">
                    <button
                      className="set-iconbtn"
                      disabled={t.isRunning}
                      aria-busy={t.isRunning || undefined}
                      title={
                        t.isRunning
                          ? language === "zh" ? "正在运行，完成后可再次触发" : "Running; available again when it finishes"
                          : language === "zh" ? "立即运行" : "Run now"
                      }
                      onClick={() => runTaskNow(t.id)}
                    >
                      {t.isRunning ? <span className="auto-spinner" aria-hidden="true" /> : <Play size={14} />}
                    </button>
                    <Toggle checked={t.enabled} onChange={(v) => saveTask({ ...t, enabled: v })} />
                    <button
                      className="set-iconbtn"
                      aria-expanded={expanded === t.id}
                      title={language === "zh" ? "运行历史" : "Run history"}
                      onClick={() => {
                        const next = expanded === t.id ? null : t.id;
                        setExpanded(next);
                        // 展开时重新拉一次（可能刚刚跑过），并顺手把已看过该任务
                        // 失败结果的标记成已查看。
                        if (next) {
                          void loadRuns(next).then(() => {
                            const seen = runsByTask[next]?.filter((r) => r.status === "error" || r.status === "aborted").map((r) => r.id);
                            if (seen?.length) void window.pi.automation.markReviewed(seen).then((res: { unreviewed: number }) => setUnreviewed(res.unreviewed));
                          });
                        }
                      }}
                    >
                      ☰
                    </button>
                    <button
                      className="set-iconbtn"
                      title={language === "zh" ? "编辑" : "Edit"}
                      onClick={() => setDraft({ ...t })}
                    >
                      ✎
                    </button>
                    <button
                      className="set-iconbtn danger"
                      title={language === "zh" ? "删除" : "Delete"}
                      onClick={() => {
                        const zh = language === "zh";
                        useStore.getState().askConfirm({
                          title: zh ? "删除定时任务" : "Delete automation",
                          body: zh ? `删除任务 “${t.name}”？其调度配置会一并删除。` : `Delete task “${t.name}”? Its schedule is deleted too.`,
                          danger: true,
                          confirmLabel: zh ? "删除" : "Delete",
                          onConfirm: () => deleteTask(t.id),
                        });
                      }}
                    >
                      ×
                    </button>
                  </div>
                  {expanded === t.id && (
                    <div className="auto-history">
                      {(runsByTask[t.id] ?? []).length === 0 ? (
                        <div className="set-hint">{language === "zh" ? "还没有运行记录。" : "No runs yet."}</div>
                      ) : (
                        (runsByTask[t.id] ?? []).map((run) => (
                          <div className="auto-history-row" key={run.id}>
                            <span className={`auto-run-status ${run.status}`}>{runStatusLabel(run, language)}</span>
                            <span className="auto-run-when">{new Date(run.startedAt).toLocaleString()}</span>
                            <span className="auto-run-trigger">{runTriggerLabel(run, language)}</span>
                            {runDuration(run) && <span className="auto-run-dur">{runDuration(run)}</span>}
                            {run.status === "error" && run.error && (
                              <span className="auto-run-err" title={run.error}>
                                {run.error.slice(0, 60)}
                              </span>
                            )}
                            {run.sessionFile ? (
                              <button
                                className="set-btn ghost auto-run-open"
                                onClick={() => {
                                  const st = useStore.getState();
                                  void st.openThread(t.cwd, run.sessionFile!);
                                  st.closeAutomation();
                                }}
                              >
                                {language === "zh" ? "打开会话" : "Open session"}
                              </button>
                            ) : (
                              <span className="muted auto-run-nosession">
                                {language === "zh" ? "无会话" : "No session"}
                              </span>
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              ))}
            </>
          )}

          {draft && (
            <div className="auto-editor">
              <div className="set-row wide">
                <label className="set-label">{language === "zh" ? "任务名称" : "Task name"}</label>
                <div className="set-control">
                  <input className="set-input" placeholder="例如：每日晨报" value={draft.name} onChange={(e) => patch({ name: e.target.value })} />
                </div>
              </div>

              <div className="set-row wide">
                <label className="set-label">{language === "zh" ? "工作文件夹" : "Working folder"}</label>
                <div className="set-control">
                  <div className="auto-folder">
                    <input className="set-input" placeholder="选择任务运行的项目目录" value={draft.cwd} onChange={(e) => patch({ cwd: e.target.value })} />
                    <button className="set-btn" onClick={pickFolder}>
                      <Folder size={14} /> {language === "zh" ? "选择" : "Select"}
                    </button>
                  </div>
                </div>
              </div>

              <div className="set-row wide">
                <label className="set-label">{language === "zh" ? "提示词" : "Prompt"}</label>
                <div className="set-control">
                  <textarea
                    className="set-json"
                    style={{ minHeight: 110 }}
                    placeholder={language === "zh"
                      ? "要执行的指令，可调用技能，例如：\n/standup 生成今日 standup 报告并写入 docs/"
                      : "Instructions to run. Skills are supported, for example:\n/standup Create today's standup report in docs/"}
                    value={draft.prompt}
                    onChange={(e) => patch({ prompt: e.target.value })}
                  />
                  <div className="set-hint">
                    {language === "zh"
                      ? "触发时在该文件夹新建一个 pi 会话执行，完成后保存为可查看的会话。"
                      : "Each run starts a new Pi session in this folder and is saved as a viewable session."}
                  </div>
                </div>
              </div>

              <div className="set-row wide">
                <label className="set-label">{language === "zh" ? "模型（可选）" : "Model (optional)"}</label>
                <div className="set-control">
                  <div className="auto-model-row">
                    <select
                      className="set-select"
                      value={draft.provider || ""}
                      onChange={(e) => patch({ provider: e.target.value || undefined, modelId: undefined })}
                    >
                      <option value="">{language === "zh" ? "跟随默认模型" : "Follow default model"}</option>
                      {Object.keys(models?.providers || {})
                        .sort()
                        .map((p) => (
                          <option key={p} value={p}>{p}</option>
                        ))}
                    </select>
                    <select
                      className="set-select"
                      disabled={!draft.provider}
                      value={draft.modelId || ""}
                      onChange={(e) => patch({ modelId: e.target.value || undefined })}
                    >
                      <option value="">{language === "zh" ? "选择模型…" : "Choose a model…"}</option>
                      {(models?.providers[draft.provider || ""]?.models || [])
                        .slice()
                        .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id))
                        .map((m) => (
                          <option key={m.id} value={m.id}>{m.name || m.id}</option>
                        ))}
                    </select>
                  </div>
                  <div className="set-hint">
                    {language === "zh"
                      ? "留空则使用 pi 的默认模型。所选模型后来被删除时，任务会运行失败并提示（不会静默换模型）。"
                      : "Leave empty to use pi's default model. If the chosen model is removed later, runs fail with a clear error (no silent fallback)."}
                  </div>
                </div>
              </div>

              <div className="set-row wide">
                <label className="set-label">{language === "zh" ? "重复" : "Repeat"}</label>
                <div className="set-control">
                  <div className="auto-permission-block">
                    <strong>{language === "zh" ? "运行权限" : "Run permission"}</strong>
                    <div className="auto-freq-tabs">
                      <button
                        className={`set-btn ${draft.permission !== "full" ? "primary" : "ghost"}`}
                        onClick={() => patch({ permission: "sandbox" })}
                      >
                        {language === "zh" ? "沙盒" : "Sandbox"}
                      </button>
                      <button
                        className={`set-btn ${draft.permission === "full" ? "primary" : "ghost"}`}
                        onClick={() => patch({ permission: "full" })}
                      >
                        {language === "zh" ? "完全权限" : "Full access"}
                      </button>
                    </div>
                    <div className="set-hint">
                      {language === "zh"
                        ? "定时任务无法等待授权。沙盒会阻止需要确认的操作；完全权限仅用于你明确信任的任务。"
                        : "Automations cannot wait for approval. Sandbox blocks operations that require confirmation; use Full access only for explicitly trusted tasks."}
                    </div>
                  </div>
                  <div className="auto-freq-tabs">
                    {(["hourly", "daily", "weekly"] as ScheduleFrequency[]).map((f) => (
                      <button key={f} className={`set-btn ${draft.schedule.frequency === f ? "primary" : "ghost"}`} onClick={() => setFreq(f)}>
                        {f === "hourly"
                          ? language === "zh" ? "按小时" : "Hourly"
                          : f === "daily"
                            ? language === "zh" ? "每天" : "Daily"
                            : language === "zh" ? "每周" : "Weekly"}
                      </button>
                    ))}
                  </div>

                  {draft.schedule.frequency === "hourly" && (
                    <div className="auto-sched-line">
                      <span>{language === "zh" ? "每小时第" : "At minute"}</span>
                      <input
                        className="set-input num"
                        type="number"
                        min={0}
                        max={59}
                        style={{ width: 80 }}
                        value={draft.schedule.minute ?? 0}
                        onChange={(e) => patchSchedule({ minute: Math.max(0, Math.min(59, Number(e.target.value) || 0)) })}
                      />
                      <span>{language === "zh" ? "分钟执行" : "of every hour"}</span>
                    </div>
                  )}

                  {draft.schedule.frequency !== "hourly" && (
                    <div className="auto-sched-line">
                      <span>{language === "zh" ? "时刻" : "Time"}</span>
                      <input className="set-input" type="time" style={{ width: 130 }} value={draft.schedule.time || "09:00"} onChange={(e) => patchSchedule({ time: e.target.value })} />
                    </div>
                  )}

                  {draft.schedule.frequency === "weekly" && (
                    <div className="auto-days">
                      {WEEK_ORDER.map((d) => (
                        <button
                          key={d}
                          className={`auto-day ${(draft.schedule.days || []).includes(d) ? "on" : ""}`}
                          onClick={() => toggleDay(d)}
                        >
                          {DAY_NAMES[language][d]}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="auto-editor-actions">
                <button className="set-btn ghost" onClick={() => setDraft(null)}>
                  {language === "zh" ? "取消" : "Cancel"}
                </button>
                <button className="set-btn primary" onClick={save}>
                  {language === "zh" ? "保存任务" : "Save task"}
                </button>
              </div>
            </div>
          )}
      </div>
    </SidePanel>
  );
}
