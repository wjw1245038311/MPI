import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { Minus, Square, Close, Settings as SettingsIcon } from "./icons";
import { AppUpdatePanel, PiCoreUpdatePanel } from "./AboutPanels";
import { DevReleasePanel } from "./DevReleasePanel";
import { TestPanel } from "./TestPanel";
import appIconUrl from "../../../../resources/icon.png";

type MenuId = "file" | "edit" | "view" | "help" | "devtools";

interface MenuItem {
  label: string;
  onClick?: () => void;
  sep?: boolean;
}

export function TitleBar() {
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const openSettings = useStore((s) => s.openSettings);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const language = useStore((s) => s.config?.language || "en");

  const [menu, setMenu] = useState<MenuId | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // close dropdown on outside click
  useEffect(() => {
    if (!menu) return;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const [aboutOpen, setAboutOpen] = useState(false);
  const [devReleaseOpen, setDevReleaseOpen] = useState(false);
  const [testPanelOpen, setTestPanelOpen] = useState(false);
  // Dev-only toolbar entries: the whole 「开发工具」 menu is hidden in packaged builds.
  const [isDev, setIsDev] = useState(false);
  useEffect(() => {
    window.pi.app
      .isDev()
      .then(setIsDev)
      .catch(() => undefined);
  }, []);

  const st = () => useStore.getState();
  const act = (fn: () => void) => () => {
    setMenu(null);
    fn();
  };

  // Dev-only: open a fresh session inside the MPI repo and ask the agent to run
  // the user-manual skill (cwd = repo root so .pi/skills/user-manual is found).
  const openManualSync = async () => {
    const root = await window.pi.app.getDevRepoRoot().catch(() => null);
    if (!root) {
      useStore.getState().pushToast("error", "用户手册编写仅在开发模式可用");
      return;
    }
    const s = useStore.getState();
    const id = await s.openThread(root, undefined, undefined, "用户手册同步");
    if (!id) return;
    await s.sendPrompt(
      id,
      "请按 user-manual skill 同步 MPI 用户手册：先读 .pi/manual-sync.json 与 changelog.md，" +
        "运行 `node scripts/manual-sync.mjs --report`，列出用户可见变更与建议章节并等我确认；" +
        "确认后中英文同步修改 resources/user-manual.md 与 resources/user-manual-en.md，最后更新水印。",
    );
  };

  // Open the bundled user manual in a preview tab (main resolves its path).
  const openManual = async () => {
    try {
      const p: string | null = await window.pi.app.getUserManualPath();
      if (p) {
        // Dev repo root as projectRoot so relative links inside the manual
        // (e.g. MPI-BEGINNER-GUIDE.md at the repo root) can resolve; packaged
        // builds get null and fall back to the manual's own directory.
        const root = await window.pi.app.getDevRepoRoot().catch(() => null);
        void useStore.getState().openPreview(p, root ?? undefined);
      } else st().pushToast("error", language === "zh" ? "未找到使用手册文件" : "User manual file not found");
    } catch (e: any) {
      const msg = e?.message || String(e);
      st().pushToast("error", language === "zh" ? "打开使用手册失败：" + msg : `Could not open the user manual: ${msg}`);
    }
  };

  const MENUS: { id: MenuId; label: string; items: MenuItem[] }[] = [
    {
      id: "file",
      label: "文件",
      items: [
        { label: "新建会话", onClick: act(() => st().newTask()) },
        { label: "打开文件夹…", onClick: act(() => st().openProjectFolder()) },
      ],
    },
    {
      id: "edit",
      label: "编辑",
      items: [
        { label: "复制", onClick: act(() => st().editAction("copy")) },
        { label: "剪切", onClick: act(() => st().editAction("cut")) },
        { label: "粘贴", onClick: act(() => st().editAction("paste")) },
        { label: "删除", onClick: act(() => st().editAction("delete")) },
        { label: "", sep: true },
        { label: "进入设置…", onClick: act(() => st().openSettings()) },
      ],
    },
    {
      id: "view",
      label: "视图",
      items: [
        { label: sidebarOpen ? "折叠导航栏" : "展开导航栏", onClick: act(toggleSidebar) },
        { label: "切换预览面板", onClick: act(() => st().togglePreview()) },
      ],
    },
    {
      id: "help",
      label: "帮助",
      items: [
        { label: language === "zh" ? "使用手册" : "User manual", onClick: act(() => void openManual()) },
        { label: "", sep: true },
        { label: "关于 MPI", onClick: act(() => setAboutOpen(true)) },
      ],
    },
  ];

  return (
    <>
    <div className="titlebar">
      <div className="tb-brand">
        <img className="tb-brand-icon" src={appIconUrl} alt="" aria-hidden="true" />
        MPI
      </div>
      <div className="tb-menu" ref={menuRef}>
        {MENUS.map((m) => (
          <div className="tb-menu-wrap" key={m.id}>
            <button className={`tb-menu-btn ${menu === m.id ? "open" : ""}`} onClick={() => setMenu((cur) => (cur === m.id ? null : m.id))}>
              {m.label}
            </button>
            {menu === m.id && (
              <div className="tb-dropdown">
                {m.items.map((it, i) =>
                  it.sep ? (
                    <div className="tb-dd-sep" key={i} />
                  ) : (
                    <button className="tb-dd-item" key={i} onClick={it.onClick}>
                      {it.label}
                    </button>
                  ),
                )}
              </div>
            )}
          </div>
        ))}
        {isDev && (
          <div className="tb-menu-wrap">
            <button className={`tb-menu-btn ${menu === "devtools" ? "open" : ""}`} onClick={() => setMenu((cur) => (cur === "devtools" ? null : "devtools"))}>
              开发工具
            </button>
            {menu === "devtools" && (
              <div className="tb-dropdown tb-dd-dev">
                <button className="tb-dd-item" onClick={act(() => setTestPanelOpen(true))}>
                  自动化测试
                </button>
                <button className="tb-dd-item" onClick={act(() => setDevReleaseOpen(true))}>
                  dev 一键发布
                </button>
                <button className="tb-dd-item" onClick={act(() => void openManualSync())}>
                  用户手册编写
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="tb-spacer" />
      <button className="tb-settings-btn" onClick={openSettings} title={language === "zh" ? "设置" : "Settings"} aria-label={language === "zh" ? "设置" : "Settings"}>
        <SettingsIcon size={15} />
      </button>
      <div className="tb-win">
        <button className="tb-win-btn" onClick={() => window.pi.window.minimize()} title={language === "zh" ? "最小化" : "Minimize"} aria-label={language === "zh" ? "最小化" : "Minimize"}>
          <Minus size={14} />
        </button>
        <button className="tb-win-btn" onClick={() => window.pi.window.maximize()} title={language === "zh" ? "最大化" : "Maximize"} aria-label={language === "zh" ? "最大化" : "Maximize"}>
          <Square size={12} />
        </button>
        <button className="tb-win-btn close" onClick={() => window.pi.window.close()} title={language === "zh" ? "关闭" : "Close"} aria-label={language === "zh" ? "关闭" : "Close"}>
          <Close size={14} />
        </button>
      </div>
    </div>

    {aboutOpen && (
      <div className="modal-backdrop" onMouseDown={() => setAboutOpen(false)}>
        <div className="modal about-modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
          <div className="about-modal-head">
            <span>关于 MPI</span>
            <button className="iconbtn" onClick={() => setAboutOpen(false)} title={language === "zh" ? "关闭" : "Close"} aria-label={language === "zh" ? "关闭" : "Close"}>
              <Close size={14} />
            </button>
          </div>
          <AppUpdatePanel />
          <PiCoreUpdatePanel />
        </div>
      </div>
    )}
    {devReleaseOpen && (
      <div className="modal-backdrop" onMouseDown={() => setDevReleaseOpen(false)}>
        <div className="modal about-modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
          <div className="about-modal-head">
            <span>开发专用工具 · dev 一键发版</span>
            <button className="iconbtn" onClick={() => setDevReleaseOpen(false)} title={language === "zh" ? "关闭" : "Close"} aria-label={language === "zh" ? "关闭" : "Close"}>
              <Close size={14} />
            </button>
          </div>
          <DevReleasePanel />
        </div>
      </div>
    )}
    {testPanelOpen && (
      <div className="modal-backdrop" onMouseDown={() => setTestPanelOpen(false)}>
        <div className="modal test-modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
          <div className="about-modal-head">
            <span>开发专用工具 · 自动化测试</span>
            <button className="iconbtn" onClick={() => setTestPanelOpen(false)} title={language === "zh" ? "关闭" : "Close"} aria-label={language === "zh" ? "关闭" : "Close"}>
              <Close size={14} />
            </button>
          </div>
          <TestPanel />
        </div>
      </div>
    )}
    </>
  );
}
