import type { NpmPackage } from "../renderer/src/lib/types";

const REGISTRY = "https://registry.npmjs.org";
/** Default search when the user has not typed anything — surfaces pi extensions. */
const DEFAULT_QUERY = "pi extension";
const SEARCH_SIZE = 30;
const REQUEST_TIMEOUT_MS = 12_000;
const README_LIMIT = 120_000;

interface SearchPayload {
  objects?: unknown[];
}

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
    throw new Error(`npm registry request failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  return JSON.parse(text) as T;
}

function normalizePackage(raw: any): NpmPackage | null {
  const pkg = raw?.package;
  const name = String(pkg?.name || "").trim();
  if (!name) return null;
  const keywords = Array.isArray(pkg.keywords) ? pkg.keywords.map((k: unknown) => String(k)).filter(Boolean).slice(0, 12) : [];
  let repository = "";
  if (typeof pkg.links?.repository === "string") {
    // `git+https://…` / `git@github.com:user/repo.git` → plain https URL where possible.
    const value = pkg.links.repository as string;
    repository = value.startsWith("git+") ? value.slice(4) : value.replace(/\.git$/, "");
  }
  return {
    name,
    version: String(pkg.version || "").trim(),
    description: String(pkg.description || "").trim(),
    keywords,
    license: typeof pkg.license === "string" && pkg.license ? pkg.license : undefined,
    date: String(pkg.date || ""),
    downloadsWeekly: Number.isFinite(Number(raw?.downloads?.weekly)) ? Number(raw.downloads.weekly) : 0,
    npmUrl: typeof pkg.links?.npm === "string" ? (pkg.links.npm as string) : `https://www.npmjs.com/package/${name}`,
    repository: repository || undefined,
  };
}

/** Search the public npm registry. An empty query falls back to a default that surfaces pi extensions. */
export async function searchNpmPackages(query: string): Promise<NpmPackage[]> {
  const q = query.trim() || DEFAULT_QUERY;
  const params = new URLSearchParams({ text: q, size: String(SEARCH_SIZE) });
  const payload = await readJson<SearchPayload>(`${REGISTRY}/-/v1/search?${params.toString()}`);
  return (Array.isArray(payload.objects) ? payload.objects : [])
    .map(normalizePackage)
    .filter((item): item is NpmPackage => !!item);
}

/** Fetch the registry document for one package and return its README markdown. */
export async function getNpmReadme(name: string): Promise<string> {
  const safe = name.trim();
  if (!safe || !/^[a-z0-9@._/-]+$/i.test(safe)) throw new Error("Invalid package name");
  // Scoped names must be encoded as `@scope%2Fname` in the registry document URL.
  const path = safe.startsWith("@") ? `@${encodeURIComponent(safe.slice(1))}` : encodeURIComponent(safe);
  const payload = await readJson<{ readme?: unknown }>(`${REGISTRY}/${path}`);
  return typeof payload.readme === "string" ? payload.readme.slice(0, README_LIMIT) : "";
}
