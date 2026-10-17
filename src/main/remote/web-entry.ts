/**
 * 「网页版从哪打开」的**单一来源**（2026-10 定稿）。
 *
 * 产品模型收敛后只剩一条受支持的链路：
 *
 *   已激活的桌面端 ──Bearer 激活码──> 我的中继(ECS) ──同源──> 手机 App / 其它电脑浏览器
 *
 * 所以网页入口**只有一个可能**：中继自己托管的那个 origin（`https://<中继>:9443`）。
 * 页面与 `/ws` 同源 ⇒ 设备的「同源通道」必然可达（见 `mobile/pwa/src/lib/relay-select.ts`
 * 的 `sameOriginRelayUrl`），既不需要证书信任、也不需要逐条探测候选。
 *
 * 为什么不再有「本机托管的网页版」：本机托管要求 https（PWA 的 E2E 依赖 `crypto.subtle`，
 * 只在安全上下文可用），而 https 又需要自签证书 + 每台设备装根证书 + 一个**会随 DHCP 变化的
 * IP** —— 而 PWA 的设备身份绑在 origin 的 IndexedDB 上，IP 一变就是「一台新设备」。
 * 结论：本机托管最终只会制造设备列表垃圾，不再作为产品路径（配置字段保留读取兼容）。
 *
 * 探测只回答一个问题：**这个 origin 现在是否真的托管着 PWA**（`/manifest.webmanifest` 200）。
 * 探不到不等于入口不存在（中继可能只是这台机器暂时连不上），所以返回 `verified: false`
 * 而不是 null —— 让界面能说「未验证」，而不是把唯一的入口藏起来。
 */
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";

/** 探针路径：中继静态目录里一定有它（PWA 构建产物），且足够小。 */
export const WEB_ENTRY_PROBE_PATH = "/manifest.webmanifest";

/** 探测结果缓存（避免每次打开面板都打一次外网）。 */
export const WEB_ENTRY_TTL_MS = 5 * 60_000;

/** 单次探测超时（实测 ECS 37ms 可达，5s 足够）。 */
export const WEB_ENTRY_PROBE_TIMEOUT_MS = 5000;

export type WebEntrySource = "builtin" | "custom" | "local";

/** `any` = 中继（任何网络都能开）；`local` = 本机（同局域网/tailnet 更快，但不进公网）。 */
export type WebEntryScope = "any" | "local";

export interface WebEntry {
  /** `https://host[:port]`（不含路径；配对链接是 `<origin>/#pair=…`）。 */
  origin: string;
  /** 这个入口属于哪个中继/本机。 */
  source: WebEntrySource;
  /** 适用范围：决定界面给哪类设备用。 */
  scope: WebEntryScope;
  /** 探测通过 = 该 origin 现在确实返回了 PWA 的 manifest。 */
  verified: boolean;
}

/** `ws(s)://host[:port]/path` → 同 host 的 http(s) origin；解析失败或非 ws/http 返回 null。 */
export function httpOriginOf(url: string): string | null {
  try {
    const parsed = new URL(String(url || "").trim());
    const scheme = parsed.protocol === "wss:" ? "https:" : parsed.protocol === "ws:" ? "http:" : parsed.protocol;
    if (scheme !== "https:" && scheme !== "http:") return null;
    return `${scheme}//${parsed.host}`;
  } catch {
    return null;
  }
}

/**
 * 组装候选入口（**按优先级**，只含受支持的中继）：
 *   ① 自定义中继（用户自己部署 —— PWA 也得自己传，探不通就不 verified）
 *   ② 内置服务器（有激活码才算）
 * 局域网/本机入口不再入选（见文件头）。
 *
 * ⚠️ **只要 https**：中继在明文端口（内置服务器的 `ws://…:10445`）上也会返回静态文件，
 * 探针会“通过”，但那不是安全上下文 —— `crypto.subtle` 不可用，PWA 的 E2E 直接失效。
 * 所以入口必须从 `wss://` 解密出来，`ws://` 一律剔除。
 */
export function webEntryCandidates(input: {
  customRelayUrl?: string | null;
  builtinPhoneUrls?: readonly string[] | null;
  authCode?: string | null;
}): WebEntry[] {
  const out: WebEntry[] = [];
  const push = (raw: string | null | undefined, source: WebEntrySource, scope: WebEntryScope) => {
    const origin = httpOriginOf(String(raw || ""));
    if (!origin || !origin.startsWith("https://")) return;
    if (out.some((entry) => entry.origin === origin)) return;
    out.push({ origin, source, scope, verified: false });
  };
  const custom = String(input.customRelayUrl || "").trim();
  if (custom) push(custom, "custom", "any");
  if (String(input.authCode || "").trim()) {
    // 内置描述里的地址按"离设备最近"排序（tailnet TLS 在前、公网在后）；探到谁就用谁。
    for (const url of input.builtinPhoneUrls ?? []) push(url, "builtin", "any");
  }
  return out;
}

/**
 * 本机入口候选（`https://<内网IP|tailnet IP>:<tlsPort>`）。
 *
 * 它服务的是「同一局域网 / 同一 tailnet 里的浏览器」——不走公网、比中继快；代价是 origin 不稳定
 * （DHCP 一换内网 IP 就变 → 新设备记录），所以**只作可选入口**，不当默认二维码。
 * tailnet IP 是固定的，所以那个地址反倒适合长期用。
 */
export function localEntryCandidates(input: {
  addresses?: readonly string[] | null;
  tailnet?: string | null;
  tlsPort?: number | null;
  /** 局域网监听没开（绑 127.0.0.1）时，内网地址根本不可达。 */
  lanEnabled?: boolean;
}): WebEntry[] {
  if (input.lanEnabled === false) return [];
  const port = Number(input.tlsPort) > 0 ? Number(input.tlsPort) : 9443;
  const out: WebEntry[] = [];
  const push = (address: string | null | undefined) => {
    const ip = String(address || "").trim();
    if (!ip) return;
    const origin = `https://${ip}:${port}`;
    if (out.some((entry) => entry.origin === origin)) return;
    out.push({ origin, source: "local", scope: "local", verified: false });
  };
  // tailnet 在前：地址固定、不走公网，是长期使用的最优解。
  push(input.tailnet);
  for (const address of input.addresses ?? []) push(address);
  return out;
}

/** 只读一次响应体前 N 字节 —— 探针不需要整份 manifest。 */
function looksLikeManifest(body: string): boolean {
  const sample = body.slice(0, 4096).trim();
  if (!sample) return false;
  if (sample.startsWith("{") || sample.startsWith("[")) return true;
  // 有些静态服务器会给 .webmanifest 一个怪 content-type，但内容一定是 JSON。
  return /"name"\s*:/.test(sample);
}

export interface ProbeOptions {
  timeoutMs?: number;
  /** 自签中继的 CA（PEM）；不给就走系统信任链。 */
  ca?: string[];
  /** 测试注入；默认用 node:http(s).get（能传 `ca`，比 undici 简单）。 */
  requestImpl?: (url: string, opts: { timeoutMs: number; ca?: string[] }) => Promise<{ status: number; body: string }>;
}

/** 用 node:http(s) 取一次（支持自签 CA）。 */
function requestOnce(url: string, opts: { timeoutMs: number; ca?: string[] }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith("https:");
    const get = isHttps ? httpsGet : httpGet;
    const request = get(
      url,
      isHttps && opts.ca?.length ? { ca: opts.ca } : {},
      (response) => {
        const status = response.statusCode || 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          resolve({ status, body: "" });
          return;
        }
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          if (body.length < 8192) body += chunk;
        });
        response.on("end", () => resolve({ status, body }));
      },
    );
    request.setTimeout(opts.timeoutMs, () => {
      request.destroy(new Error("TIMEOUT"));
    });
    request.on("error", reject);
  });
}

/**
 * 探测单个入口：GET `<origin>/manifest.webmanifest`。
 * 返回 `verified` 标记（永不抛异常）——探不到只意味着"这台机器现在看不到它"。
 */
export async function probeWebEntry(entry: WebEntry, options: ProbeOptions = {}): Promise<WebEntry> {
  const timeoutMs = options.timeoutMs ?? WEB_ENTRY_PROBE_TIMEOUT_MS;
  const request = options.requestImpl ?? requestOnce;
  try {
    const { status, body } = await request(`${entry.origin}${WEB_ENTRY_PROBE_PATH}`, { timeoutMs, ca: options.ca });
    const verified = status === 200 && looksLikeManifest(body);
    return { ...entry, verified };
  } catch {
    return { ...entry, verified: false };
  }
}

/**
 * 在候选里挑「第一个探测通过」的入口；都没通过就返回第一个候选（`verified:false`），
 * 都不存在才返回 null —— 界面据 `verified` 决定是"直接用"还是"标未验证"。
 */
export async function resolveWebEntry(candidates: WebEntry[], options: ProbeOptions = {}): Promise<WebEntry | null> {
  if (!candidates.length) return null;
  for (const candidate of candidates) {
    const probed = await probeWebEntry(candidate, options);
    if (probed.verified) return probed;
  }
  return { ...candidates[0], verified: false };
}
