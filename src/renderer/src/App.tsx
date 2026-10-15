import { useEffect, useState } from "react";
import { useStore } from "./store";
import { usePiEvents } from "./lib/usePiEvents";
import { startDiagWatch } from "./lib/diag-watch";
import { installShortcuts } from "./lib/shortcuts";
import { unlockAudio } from "./lib/sound";
import { TitleBar } from "./components/TitleBar";
import { Sidebar } from "./components/Sidebar";
import { Chat } from "./components/Chat";
import { Preview } from "./components/Preview";
import { Toasts } from "./components/Toasts";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { ExtUiModal } from "./components/ExtUiModal";
import { Settings } from "./components/Settings";
import { SearchModal } from "./components/SearchModal";
import { PluginsPanel } from "./components/PluginsPanel";
import { AppStorePanel } from "./components/AppStorePanel";
import { AutomationPanel } from "./components/AutomationPanel";
import { TodoPanel } from "./components/TodoPanel";
import { MessagingPanel } from "./components/MessagingPanel";
import { ZhiyaMenu } from "./components/ZhiyaMenu";
import { ZhiyaSidePanel } from "./components/ZhiyaSidePanel";
import { Folder, Plus, Smartphone } from "./components/icons";
import { ImageCopyMenu } from "./components/ImageCopyMenu";
import { MessageQuoteMenu } from "./components/MessageQuoteMenu";
import { LanguageBridge } from "./components/LanguageBridge";
import { RemotePanel } from "./components/RemotePanel";
import appIconUrl from "../../../resources/icon.png";

export default function App() {
  const bootstrap = useStore((s) => s.bootstrap);
  const activeThreadId = useStore((s) => s.activeThreadId);
  const previewOpen = useStore((s) => s.previewOpen);
  const previewExpanded = useStore((s) => s.previewExpanded);
  const todoPanelOpen = useStore((s) => s.todoPanelOpen);
  const automationOpen = useStore((s) => s.automationOpen);
  const pluginsOpen = useStore((s) => s.pluginsOpen);
  const appsOpen = useStore((s) => s.appsOpen);
  const messagingOpen = useStore((s) => s.messagingOpen);
  const zhiyaPanelOpen = useStore((s) => s.zhiyaPanelOpen);
  const sidePanelExpanded = useStore((s) => s.sidePanelExpanded);
  const sidePanelOpen = todoPanelOpen || automationOpen || pluginsOpen || appsOpen || messagingOpen || zhiyaPanelOpen;
  const projects = useStore((s) => s.projects);
  const runtime = useStore((s) => s.runtime);
  const theme = useStore((s) => s.config?.theme || "light");
  const accentTheme = useStore((s) => s.config?.accentTheme || "default");
  const language = useStore((s) => s.config?.language || "en");
  const [remoteOpen, setRemoteOpen] = useState(false);
  usePiEvents();

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const resolved = theme === "system" ? (media.matches ? "dark" : "light") : theme;
      document.documentElement.dataset.theme = resolved;
      document.documentElement.style.colorScheme = resolved;
    };

    applyTheme();
    if (theme !== "system") return;
    media.addEventListener?.("change", applyTheme);
    return () => media.removeEventListener?.("change", applyTheme);
  }, [theme]);

  // Accent color preset: CSS blocks keyed on <html data-accent> override the
  // --accent / --accent-soft (and dark-theme send) variables.
  useEffect(() => {
    document.documentElement.dataset.accent = accentTheme;
  }, [accentTheme]);

  // 全局快捷键见下方 installShortcuts（注册表在 lib/shortcuts.ts）。

  // Prime the WebAudio context on the first user gesture so the completion
  // chime can play later without a fresh gesture requirement.
  useEffect(() => unlockAudio(), []);

  // Field diagnostics (ext-ui queue / streaming flips / window focus) →
  // userData/logs/mpi-diag.log; see lib/diag-watch.ts for what it captures.
  useEffect(() => startDiagWatch(), []);

  // Dock-back for popped-out previews while the panel is CLOSED: Preview's own
  // zone-check listener only exists while it is mounted, so a release over the
  // main window would otherwise be dropped silently (the floating window just
  // stays open). With no visible tab strip there is no zone to miss — accept
  // any release point inside the main window; openPreview re-opens the panel.
  useEffect(() => {
    return window.pi.app.onPreviewDockCandidate(({ path }) => {
      const st = useStore.getState();
      if (st.previewOpen) return; // panel visible → Preview's zone check owns docking
      void st.openPreview(path, st.activeProjectCwd || undefined);
      void window.pi.app.closePreviewWindow(path).catch(() => {});
    });
  }, []);

  const newTask = async () => {
    let cwd: string | null = useStore.getState().activeProjectCwd;
    if (!cwd) {
      const p = await window.pi.app.showOpenDialog("folder");
      if (!p || Array.isArray(p)) return;
      await window.pi.app.openProject(p);
      await useStore.getState().refreshProjects();
      useStore.getState().setActiveProject(p);
      cwd = p;
    }
    if (cwd) await useStore.getState().openThread(cwd);
  };

  /** 缩放（沿用原有 Feishu 风格：Ctrl+= / Ctrl+- / Ctrl+0，由主进程持久化）。 */
  const zoomTo = (next: number) => {
    const cur = useStore.getState().config?.zoomPercent ?? 100;
    if (next === cur) return;
    window.pi.window
      .setZoom(next)
      .then((cfg: any) => useStore.setState({ config: cfg }))
      .catch((err) => console.error("[zoom] setZoom failed:", err));
  };

  // 全局快捷键。搜索与缩放是原有行为（含在输入框里也生效），新增三个高频入口：
  // 新建会话、打开设置、Esc 停止生成。
  useEffect(() => {
    const st = () => useStore.getState();
    const zoomPct = () => st().config?.zoomPercent ?? 100;
    // Esc 只在「当前会话正在生成、且没有别的弹层需要这个键」时用来中止。
    const canAbort = () => {
      const s = st();
      const t = s.activeThreadId ? s.threads[s.activeThreadId] : undefined;
      return !!t?.isStreaming && !s.settingsOpen && !s.searchOpen && !s.confirmAsk && s.extuiQueue.length === 0;
    };
    return installShortcuts([
      { id: "search", combo: "Ctrl+K", allowInInput: true, run: () => st().openSearch() },
      { id: "new-task", combo: "Ctrl+N", run: () => newTask() },
      { id: "settings", combo: "Ctrl+,", when: () => !st().settingsOpen, run: () => st().openSettings() },
      { id: "zoom-in", combo: "Ctrl+=", allowInInput: true, when: () => zoomPct() < 150, run: () => zoomTo(Math.min(150, zoomPct() + 25)) },
      { id: "zoom-out", combo: "Ctrl+-", allowInInput: true, when: () => zoomPct() > 50, run: () => zoomTo(Math.max(50, zoomPct() - 25)) },
      { id: "zoom-reset", combo: "Ctrl+0", allowInInput: true, when: () => zoomPct() !== 100, run: () => zoomTo(100) },
      {
        id: "abort",
        combo: "Escape",
        when: canAbort,
        run: () => {
          const id = st().activeThreadId;
          if (id) void st().abortThread(id);
        },
      },
    ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="app">
      <LanguageBridge />
      <ImageCopyMenu />
      <MessageQuoteMenu />
      <TitleBar />
      <div
        className={`body${previewExpanded && !sidePanelOpen ? " preview-expanded" : ""}${sidePanelExpanded && sidePanelOpen ? " side-panel-expanded" : ""}`}
      >
        <Sidebar onOpenRemote={() => setRemoteOpen(true)} remoteOpen={remoteOpen} />
        <ZhiyaMenu />
        {activeThreadId ? (
          <Chat />
        ) : (
          <section className="main">
            <div className="empty-state">
              <div>
                <div className="empty-state-app-icon">
                  <img src={appIconUrl} alt="" aria-hidden="true" />
                </div>
                <h2>MPI</h2>
                <p style={{ maxWidth: 420, margin: "0 auto 16px" }}>
                  终端 pi 的 Windows 桌面端：完整继承模型、运行框架与扩展功能。左侧选择项目与会话，右侧预览文件。
                </p>
                {!runtime?.ok && runtime && <p style={{ color: "#b23a2c" }}>未检测到 pi：{runtime.error}</p>}
                <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
                  <button className="btn primary" onClick={newTask}>
                    <Plus size={14} /> 新建会话
                  </button>
                  <button className="btn" onClick={() => useStore.getState().openProjectFolder()}>
                    <Folder size={14} /> 打开项目文件夹
                  </button>
                </div>
                {projects.length === 0 && <p className="muted" style={{ marginTop: 14 }}>尚未打开任何项目。</p>}
              </div>
            </div>
          </section>
        )}
        {todoPanelOpen && <TodoPanel />}
        {automationOpen && <AutomationPanel />}
        {pluginsOpen && <PluginsPanel />}
        {appsOpen && <AppStorePanel />}
        {messagingOpen && <MessagingPanel />}
        {zhiyaPanelOpen && <ZhiyaSidePanel />}
        {previewOpen && !sidePanelOpen && <Preview />}
      </div>
      <Toasts />
      <ExtUiModal />
      <SearchModal />
      <Settings />
      {remoteOpen && (
        <div className="settings-backdrop" onMouseDown={() => setRemoteOpen(false)}>
          <div className="set-modal" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
            <section className="set-main" style={{ width: "min(900px, 94vw)" }}>
              <header className="set-head">
                <h2><Smartphone size={16} style={{ verticalAlign: "-3px", marginRight: 8 }} />{language === "zh" ? "Android 手机远程控制" : "Android remote companion"}</h2>
                <button className="set-iconbtn" onClick={() => setRemoteOpen(false)} aria-label={language === "zh" ? "关闭远程设置" : "Close remote settings"}>×</button>
              </header>
              <div className="set-body">
                <RemotePanel language={language} />
              </div>
            </section>
          </div>
        </div>
      )}
      {/* 确认框放最后：与 .settings-backdrop 这类无 z-index 的弹层同层时，靠 DOM 顺序保证在最上 */}
      <ConfirmDialog />
    </div>
  );
}
