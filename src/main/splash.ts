import { BrowserWindow } from "electron";

/**
 * 启动遮罩（2026-11-03，参考 DSH Desktop v0.13.0「遮罩覆盖内容出现前的空白帧」）。
 *
 * 主窗口是 `show: false` + `ready-to-show` 才显示，冷启动（asar 首读、pi 运行时
 * 解压、扩展开启）期间桌面上一片空白，用户会以为没启动。这里先用一个极轻的
 * 无边框窗口占位：纯内联 HTML（不读磁盘、不依赖 preload、不打包额外资源），
 * 主窗口 ready-to-show 或加载失败时立刻销毁。
 *
 * 刻意不做的事：不写「进度百分比」（没有真实进度可报），不做淡出动画
 * （销毁时机由主窗口决定，动画会让副窗口多活几百毫秒）。
 */
const SPLASH_HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8" />
<style>
  html,body{margin:0;height:100%;background:#0e0f12;color:#e8eaf0;
    font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;
    -webkit-user-select:none;user-select:none;overflow:hidden;cursor:default}
  .wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px}
  .mark{font-size:30px;font-weight:600;letter-spacing:.14em;
    background:linear-gradient(120deg,#e8eaf0,#8ea0c8);-webkit-background-clip:text;background-clip:text;color:transparent}
  .dots{display:flex;gap:6px}
  .dots i{width:6px;height:6px;border-radius:50%;background:#4a5163;animation:pulse 1.2s ease-in-out infinite}
  .dots i:nth-child(2){animation-delay:.16s}
  .dots i:nth-child(3){animation-delay:.32s}
  .hint{font-size:11px;color:#6d7488;letter-spacing:.05em;min-height:14px}
  @keyframes pulse{0%,80%,100%{opacity:.25;transform:scale(.85)}40%{opacity:1;transform:scale(1)}}
  @media (prefers-reduced-motion: reduce){.dots i{animation:none;opacity:.6}}
</style></head>
<body><div class="wrap">
  <div class="mark">MPI</div>
  <div class="dots"><i></i><i></i><i></i></div>
  <div class="hint" id="hint"></div>
</div>
<script>
  // 快速启动时不闪「正在启动」，慢启动（>600ms）才出现，避免固定文案造成“卡住”的错觉。
  setTimeout(function () {
    var el = document.getElementById('hint');
    if (el) el.textContent = navigator.language && navigator.language.indexOf('zh') === 0 ? '正在启动…' : 'Starting…';
  }, 600);
</script>
</body></html>`;

export function createSplashWindow(): BrowserWindow {
  const splash = new BrowserWindow({
    width: 380,
    height: 210,
    frame: false,
    resizable: false,
    movable: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    backgroundColor: "#0e0f12",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  splash.once("ready-to-show", () => {
    if (!splash.isDestroyed()) splash.show();
  });
  void splash.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(SPLASH_HTML));
  return splash;
}

/** 幂等销毁（调用方不需要知道窗口是否还活着）。 */
export function closeSplashWindow(splash: BrowserWindow | null): void {
  if (!splash || splash.isDestroyed()) return;
  try {
    splash.destroy();
  } catch {
    /* 已经在关闭途中 */
  }
}
