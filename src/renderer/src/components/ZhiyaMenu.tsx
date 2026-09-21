import type { ComponentType } from "react";
import { useStore, type ZhiyaModule } from "../store";
import { CheckSquare, Close, Files, Grid, Settings, Shield, Sparkle, Sprout } from "./icons";

const ITEMS: { id: ZhiyaModule; zh: string; en: string; Icon: ComponentType<{ size?: number }> }[] = [
  { id: "persona", zh: "人物画像", en: "Persona", Icon: Sprout },
  { id: "agreement", zh: "协作约定", en: "Agreement", Icon: Shield },
  { id: "workspace", zh: "工作空间", en: "Workspace", Icon: Grid },
  { id: "kb", zh: "知识库", en: "Knowledge base", Icon: Files },
  { id: "tasks", zh: "当前任务", en: "Current tasks", Icon: CheckSquare },
  { id: "pool", zh: "记忆池", en: "Memory pool", Icon: Sparkle },
];

/**
 * 知芽二级菜单：紧贴导航栏右侧的独立窄列（参考飞书）。
 * 只做"选模块"；内容去右侧（md→预览，任务/记忆池→侧板）。
 */
export function ZhiyaMenu() {
  const open = useStore((s) => s.zhiyaOpen);
  const module = useStore((s) => s.zhiyaModule);
  const select = useStore((s) => s.selectZhiyaModule);
  const openSettings = useStore((s) => s.openZhiyaSettings);
  const close = useStore((s) => s.closeZhiya);
  const zh = (useStore((s) => s.config?.language || "en")) === "zh";
  if (!open) return null;

  return (
    <nav className="zhiya-menu" aria-label={zh ? "知芽模块" : "Zhiya modules"}>
      <header className="zhiya-menu-head">
        <span className="zhiya-menu-mark">
          <Sprout size={16} />
        </span>
        <span className="zhiya-menu-title">{zh ? "知芽" : "Zhiya"}</span>
        <span className="zhiya-menu-spacer" />
        <button
          className="iconbtn"
          title={zh ? "知芽设置" : "Zhiya settings"}
          aria-label={zh ? "知芽设置" : "Zhiya settings"}
          onClick={() => openSettings()}
        >
          <Settings size={15} />
        </button>
        <button
          className="iconbtn"
          title={zh ? "关闭" : "Close"}
          aria-label={zh ? "关闭" : "Close"}
          onClick={() => close()}
        >
          <Close size={15} />
        </button>
      </header>
      <ul className="zhiya-menu-list">
        {ITEMS.map(({ id, zh: labelZh, en, Icon }) => (
          <li key={id}>
            <button
              type="button"
              className={`zhiya-menu-item${module === id ? " active" : ""}`}
              aria-current={module === id ? "true" : undefined}
              onClick={() => void select(id)}
            >
              <span className="ico">
                <Icon size={15} />
              </span>
              {zh ? labelZh : en}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
