import { useEffect } from "react";
import { useStore } from "../store";

/**
 * Subscribes to the main-process push channels exactly once at the app root.
 * Events are fanned into the zustand store by threadId.
 */
export function usePiEvents() {
  const handleEvent = useStore((s) => s.handleEvent);
  const handleExtUi = useStore((s) => s.handleExtUi);
  const handleExit = useStore((s) => s.handleExit);
  const handleError = useStore((s) => s.handleError);

  useEffect(() => {
    const u1 = window.pi.on.event((p) => handleEvent(p.threadId, p.event));
    const u2 = window.pi.on.extui((p) => handleExtUi(p.threadId, p.request));
    const u3 = window.pi.on.exit((p) => handleExit(p.threadId, p));
    const u4 = window.pi.on.error((p) => handleError(p.threadId, p.message));
    const u7 = window.pi.on.focusThread((p) => {
      const threadId = typeof p?.threadId === "string" ? p.threadId : "";
      if (!threadId) return;
      const focus = () => {
        const state = useStore.getState();
        if (state.threads[threadId]) {
          state.setActiveThread(threadId);
          return true;
        }
        const target = state.projects
          .map((project) => ({ project, thread: project.threads.find((item) => item.file.toLowerCase() === threadId.toLowerCase()) }))
          .find((item) => !!item.thread);
        if (!target?.thread) return false;
        void state.goToThread(target.project.cwd, target.thread.file);
        return true;
      };
      if (!focus()) void useStore.getState().refreshProjects().then(focus);
    });
    const u5 = window.pi.on.automation((p) => {
      const st = useStore.getState();
      if (p.type === "done") {
        st.refreshProjects();
        st.loadTasks();
        if (p.ok) st.pushToast("info", `定时任务完成：${p.name}`);
        else st.pushToast("error", `定时任务失败：${p.name}${p.error ? " · " + p.error : ""}`);
      }
    });
    // A dev instance started before the messaging module has an old preload
    // without this API — skip silently instead of breaking event wiring.
    const u8 = typeof window.pi.on.messaging === "function"
      ? window.pi.on.messaging((p) => useStore.setState({ messagingState: p }))
      : () => undefined;
    // Same old-preload guard as the Feishu channel above.
    const u10 = typeof window.pi.on.messagingWechat === "function"
      ? window.pi.on.messagingWechat((p) => useStore.setState({ wechatState: p }))
      : () => undefined;
    // P1-12 auto model switch / warning notifications (toast + pill health dot).
    const u11 = typeof window.pi.on.autoModel === "function"
      ? window.pi.on.autoModel((p) => {
          const st = useStore.getState();
          if (!st.threads[p.threadId]) return;
          const status: "ok" | "warn" = p.kind === "switch" && !p.downgraded && !p.usedPaid ? "ok" : "warn";
          useStore.setState((s) => {
            const t = s.threads[p.threadId];
            if (!t) return s;
            // pi does NOT stream model_select to the RPC client (it only reaches
            // extension handlers) — keep the pill's effective model in sync from
            // this notification instead, preferring the full ModelDef so name /
            // contextWindow survive the switch.
            const nextModel =
              p.kind === "switch" && p.to
                ? t.models?.find((m) => m.provider === p.to!.provider && m.id === p.to!.id) ?? { ...p.to }
                : undefined;
            return {
              threads: {
                ...s.threads,
                [p.threadId]: { ...t, autoStatus: status, ...(nextModel ? { model: nextModel } : {}) },
              },
            };
          });
          if (st.config?.autoModels?.policy?.notify === false) return;
          const zh = st.config?.language === "zh";
          let msg: string;
          if (p.kind === "warn") {
            switch (p.reason) {
              case "all-unavailable":
                msg = zh ? "所有候选模型均不可用，保持当前模型。" : "All candidate models are unavailable; keeping the current model.";
                break;
              case "no-candidates":
                msg = zh ? "自动模型池为空或候选均已移除。" : "The auto-model pool is empty or all candidates were removed.";
                break;
              case "strict-no-downgrade":
                msg = zh ? "只有更低质量的模型可用；严格模式禁止降档，保持当前模型。" : "Only lower-quality models are available; strict mode forbids downgrading, keeping the current model.";
                break;
              default:
                msg = zh ? "自动切换失败（set_model 报错）。" : "Auto-switch failed (set_model error).";
            }
          } else {
            const from = p.from?.id ?? "?";
            const to = p.to?.id ?? "?";
            let base: string;
            switch (p.reason) {
              case "soft-degrade":
                base = zh ? `已自动切换：${from} → ${to}（响应过慢）` : `Auto-switched: ${from} → ${to} (responding too slowly)`;
                break;
              case "recovery":
                base = zh ? `已自动切换：${from} → ${to}（更优模型恢复可用）` : `Auto-switched: ${from} → ${to} (better model recovered)`;
                break;
              case "initial":
                base = zh ? `auto 模式已选用：${to}` : `Auto mode selected: ${to}`;
                break;
              default:
                base = zh ? `已自动切换：${from} → ${to}（原模型不可用）` : `Auto-switched: ${from} → ${to} (current model unavailable)`;
            }
            if (p.usedPaid) base += zh ? "（无免费候选，使用收费模型）" : " (no free candidate available, using a billed model)";
            else if (p.downgraded) base += zh ? "（无同档可用，已降级到较低质量模型）" : " (nothing at this tier available, downgraded to a lower-quality model)";
            msg = base;
          }
          st.pushToast(p.kind === "warn" ? "warning" : "info", msg);
        })
      : () => undefined;
    // Agent-initiated permission switch approved on its confirmation card:
    // main already flipped the gate + cleared the enforced task mode — sync
    // the pills and tell the user what changed.
    const u12 = typeof window.pi.on.modeSwitched === "function"
      ? window.pi.on.modeSwitched((p) => {
          const st = useStore.getState();
          if (!st.threads[p.threadId]) return;
          useStore.setState((s) => {
            const t = s.threads[p.threadId];
            if (!t) return s;
            return { threads: { ...s.threads, [p.threadId]: { ...t, permission: p.permission, taskMode: undefined } } };
          });
          const zh = st.config?.language === "zh";
          const names: Record<string, string> = {
            readonly: zh ? "只读" : "Read-only",
            strict: zh ? "严格" : "Strict",
            sandbox: zh ? "沙盒" : "Sandbox",
            full: zh ? "完全权限" : "Full access",
          };
          st.pushToast(
            "info",
            zh
              ? `已按 agent 请求切换到「${names[p.permission] ?? p.permission}」权限，强制只读已解除`
              : `Switched to “${names[p.permission] ?? p.permission}” per the agent's request; enforced read-only lifted`,
          );
        })
      : () => undefined;
    const u6 = window.pi.on.projectsChanged(() => {
      void useStore.getState().refreshProjects();
    });
    // A dev instance started before the todos module has an old preload without
    // this API — skip silently instead of breaking event wiring.
    const u9 = typeof window.pi.on.todoChanged === "function"
      ? window.pi.on.todoChanged(() => void useStore.getState().loadTodos())
      : () => undefined;
    return () => {
      u1();
      u2();
      u3();
      u4();
      u7();
      u5();
      u6();
      u8();
      u9();
      u10();
      u11();
      u12();
    };
  }, [handleEvent, handleExtUi, handleExit, handleError]);
}
