import { useStore } from "../store";
import { SidePanel } from "./SidePanel";
import { ZhiyaTasksView } from "./ZhiyaTasksView";
import { ZhiyaSettingsView } from "./ZhiyaSettingsView";
import { MemoryPoolTab } from "./MemoryPoolTab";
import { CheckSquare, Settings, Sparkle } from "./icons";

/**
 * 知芽的右侧侧板：内容由 zhiyaModule 决定。
 * md 类（画像/约定/工作空间/知识库）不走这里——它们直接开预览。
 */
export function ZhiyaSidePanel() {
  const open = useStore((s) => s.zhiyaPanelOpen);
  const module = useStore((s) => s.zhiyaModule);
  const close = useStore((s) => s.closeZhiyaPanel);
  const zh = (useStore((s) => s.config?.language || "en")) === "zh";
  if (!open) return null;

  if (module === "pool") {
    return (
      <SidePanel title={zh ? "记忆池" : "Memory pool"} icon={<Sparkle size={15} />} onClose={close}>
        <MemoryPoolTab zh={zh} />
      </SidePanel>
    );
  }
  if (module === "settings") {
    return (
      <SidePanel title={zh ? "知芽设置" : "Zhiya settings"} icon={<Settings size={15} />} onClose={close}>
        <ZhiyaSettingsView zh={zh} />
      </SidePanel>
    );
  }
  return (
    <SidePanel title={zh ? "当前任务" : "Current tasks"} icon={<CheckSquare size={15} />} onClose={close}>
      <ZhiyaTasksView zh={zh} />
    </SidePanel>
  );
}
