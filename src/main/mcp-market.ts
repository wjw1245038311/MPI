import type { McpMarketDetail, McpMarketItem, McpMarketOverview, McpMarketPage } from "../renderer/src/lib/types";

/**
 * mcpmarket.cn — public MCP server directory (https://mcpmarket.cn).
 * Unauthenticated JSON API:
 *   GET /api/clients?page=N&per_page=M[&search=term]  → { clients, page, pages, per_page, total }
 *   GET /api/servers/{id}                             → full detail incl. zh/en overview
 */

const BASE = "https://mcpmarket.cn";
export const MCP_MARKET_PAGE_SIZE = 24;
const REQUEST_TIMEOUT_MS = 12_000;

function withTimeout(url: string): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: { accept: "application/json" } });
}

async function readJson<T>(url: string): Promise<T> {
  const response = await withTimeout(url);
  const text = await response.text();
  if (!response.ok) {
    let detail = "";
    try {
      const payload = JSON.parse(text) as { message?: string; error?: string };
      detail = payload.message || payload.error || "";
    } catch {
      detail = text.slice(0, 180);
    }
    throw new Error(`mcpmarket.cn request failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  return JSON.parse(text) as T;
}

function str(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

/** List API returns a plain string; the detail API returns `{ en, zh }`. */
function descriptionParts(raw: unknown): { en?: string; zh?: string } | undefined {
  if (typeof raw === "string") {
    const value = raw.trim();
    return value ? { en: value, zh: value } : undefined;
  }
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const en = str(obj.en);
    const zh = str(obj.zh);
    return en || zh ? { en, zh } : undefined;
  }
  return undefined;
}

function overviewParts(raw: unknown): McpMarketOverview | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const out: McpMarketOverview = {};
  for (const key of ["what_is", "key_features", "how_to_use", "use_cases", "where_to_use"] as const) {
    const value = str(obj[key]);
    if (value) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeItem(raw: any): McpMarketItem | null {
  const id = str(raw?._id);
  const name = str(raw?.alias) || str(raw?.name);
  if (!id || !name) return null;
  const desc = descriptionParts(raw?.description);
  return {
    id,
    name,
    by: str(raw?.by),
    description: desc?.zh || desc?.en,
    stars: Number.isFinite(Number(raw?.stars)) ? Number(raw.stars) : undefined,
    url: str(raw?.url),
    logo: str(raw?.logo),
    featured: raw?.featured === true,
  };
}

/** Search the directory. Empty query returns the default listing (page 1). */
export async function searchMcpMarket(query: string, page = 1): Promise<McpMarketPage> {
  const params = new URLSearchParams({ page: String(Math.max(1, page)), per_page: String(MCP_MARKET_PAGE_SIZE) });
  const q = query.trim();
  if (q) params.set("search", q);
  const payload = await readJson<{ clients?: unknown[]; page?: number; pages?: number; total?: number }>(
    `${BASE}/api/clients?${params.toString()}`
  );
  const items = (Array.isArray(payload.clients) ? payload.clients : [])
    .map(normalizeItem)
    .filter((item): item is McpMarketItem => !!item);
  return {
    items,
    total: Number.isFinite(Number(payload.total)) ? Number(payload.total) : items.length,
    pages: Number.isFinite(Number(payload.pages)) ? Number(payload.pages) : 1,
    page: Number.isFinite(Number(payload.page)) ? Number(payload.page) : Math.max(1, page),
  };
}

/** Fetch the full detail (zh/en overview included) for one directory entry. */
export async function getMcpMarketDetail(id: string): Promise<McpMarketDetail> {
  const safe = id.trim();
  if (!safe || !/^[a-zA-Z0-9_-]+$/.test(safe)) throw new Error("Invalid server id");
  const payload = await readJson<any>(`${BASE}/api/servers/${encodeURIComponent(safe)}`);
  const base = normalizeItem(payload);
  if (!base) throw new Error("mcpmarket.cn returned an unrecognized entry");
  const desc = descriptionParts(payload?.description);
  return {
    ...base,
    description: desc?.zh || desc?.en || base.description,
    categories: Array.isArray(payload?.categories) ? payload.categories.map((c: unknown) => String(c)).filter(Boolean) : undefined,
    mcpType: Array.isArray(payload?.mcp_type) ? payload.mcp_type.map((t: unknown) => String(t)).filter(Boolean) : undefined,
    descriptionEn: desc?.en,
    descriptionZh: desc?.zh,
    overviewEn: overviewParts(payload?.overview?.en),
    overviewZh: overviewParts(payload?.overview?.zh),
  };
}
