import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * 锚定弹层：谁被点开，就在谁旁边出现。
 *
 * 为什么不用底部抽屉（2026-11-24 用户反馈「这种下拉方式太不好看了」）：
 *  1. 脱离触发点——从「41%」那颗 chip 点开的东西跑到屏幕另一头，视线要走一个来回；
 *  2. 宽屏下退化成通栏白条，只为放一根进度条；
 *  3. 权重错位：一个只读读数配得上全屏模态，比真操作还隆重。
 * 两份参照（MPI 桌面端 Composer.tsx 的 ctx-bar / 模型弹层、千问网页的 `均衡 ▾`）
 * 在这里的取向是一致的：小面板锚定触发控件。
 *
 * 硬约束（AGENTS.md）：createPortal(document.body) + position: fixed，
 * 不塞进 overflow:auto 容器——抽屉与消息区都会把它裁掉。
 */
type Props = {
  /** 触发元素。为 null 时不渲染。 */
  anchor: HTMLElement | null;
  onClose: () => void;
  /** 优先朝上（composer 的 chip 在屏幕底部）还是朝下（顶栏的 ⋯）。放不下会自动翻边。 */
  prefer?: "up" | "down";
  /** 弹层标题的 id，供 aria-labelledby 用。 */
  labelledBy?: string;
  children: ReactNode;
};

const GAP = 6;
const EDGE = 8;

export function Popover({ anchor, onClose, prefer = "up", labelledBy, children }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  // 首帧先摆在屏幕外：没有尺寸就没法判断该朝哪边，直接渲染会闪一下错位。
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: -9999, top: -9999 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!anchor || !el) return;
    const place = () => {
      const a = anchor.getBoundingClientRect();
      const p = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const below = () => ({ top: a.bottom + GAP, fits: a.bottom + GAP + p.height <= vh - EDGE });
      const above = () => ({ top: a.top - GAP - p.height, fits: a.top - GAP - p.height >= EDGE });
      const first = prefer === "up" ? above() : below();
      const alt = prefer === "up" ? below() : above();
      const chosen = first.fits || !alt.fits ? first : alt;
      // 水平默认与触发元素右端对齐（composer 的右侧 chip），越界则内收贴边。
      const left = Math.min(Math.max(EDGE, a.right - p.width), vw - p.width - EDGE);
      setPos({ left, top: chosen.top });
    };
    place();
    // 页面滚动或尺寸变化都要跟着走（弹层是 fixed，不重新算就会脱开触发点）。
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor, prefer]);

  // 点外部 / Esc 关闭。点触发元素本身不在这里关：它的 onClick 负责切换语义
  // （再点一次收起），如果这里也关一次，两次 setState 会互相抵消成「关不掉」。
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (ref.current?.contains(target) || anchor?.contains(target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchor, onClose]);

  // 打开时把焦点收进弹层：Esc 才一定收得到，读屏也能念出标题。
  useEffect(() => {
    if (!anchor) return;
    const el = ref.current;
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
  }, [anchor]);

  if (!anchor) return null;
  return createPortal(
    <div
      ref={ref}
      className="pop"
      role="dialog"
      aria-modal="false"
      aria-labelledby={labelledBy}
      tabIndex={-1}
      style={{ left: pos.left, top: pos.top }}
    >
      {children}
    </div>,
    document.body,
  );
}
