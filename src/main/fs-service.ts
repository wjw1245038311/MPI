import { existsSync, readdirSync, statSync, type Dirent } from "node:fs";
import { extname, join, resolve, sep } from "node:path";

/**
 * Lazy file-tree listing for the sidebar "Files" tab. Only direct children are
 * returned; the renderer expands folders on demand.
 */

const IGNORE = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "out",
  "dist",
  "dist-win",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "coverage",
  ".pnpm-store",
  "__pycache__",
  ".venv",
  "venv",
]);

export interface FileNode {
  name: string;
  /** Path relative to the project cwd, using forward slashes. */
  rel: string;
  abs: string;
  isDir: boolean;
  ext: string;
  size: number;
}

function assertInside(cwd: string, target: string): string {
  const c = resolve(cwd);
  const t = resolve(target);
  if (t !== c && !t.startsWith(c + sep)) {
    throw new Error("Path escapes project root");
  }
  return t;
}

export function listDir(cwd: string, rel?: string): FileNode[] {
  const base = rel && rel.length ? assertInside(cwd, join(cwd, rel)) : resolve(cwd);
  if (!existsSync(base)) return [];
  const st = statSync(base);
  if (!st.isDirectory()) return [];
  const entries = readdirSync(base, { withFileTypes: true });
  const nodes: FileNode[] = [];
  for (const e of entries) {
    if (IGNORE.has(e.name)) continue;
    if (e.name.startsWith(".") && e.name !== ".env") {
      // hide dotfiles except .env; keep tree uncluttered
      if (e.name === ".gitignore" || e.name === ".editorconfig") {
        /* allow a couple of common ones */
      } else continue;
    }
    const abs = join(base, e.name);
    let size = 0;
    let isDir = e.isDirectory();
    try {
      const s = statSync(abs);
      size = s.size;
      isDir = s.isDirectory();
    } catch {
      /* skip unreadable */
      continue;
    }
    const relPath = (rel ? rel + "/" : "") + e.name;
    nodes.push({
      name: e.name,
      rel: relPath,
      abs,
      isDir,
      ext: isDir ? "" : extname(e.name).toLowerCase(),
      size,
    });
  }
  nodes.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
  return nodes;
}

/** Cap on directory entries scanned per query — huge monorepos truncate
 * instead of stalling the menu. IGNOREd subtrees are never entered. */
const SEARCH_MAX_ENTRIES = 30_000;
const SEARCH_MAX_DEPTH = 12;

export interface FileMatch {
  name: string;
  /** Path relative to the project cwd, forward slashes (dirs without trailing slash). */
  rel: string;
  abs: string;
  isDir: boolean;
  ext: string;
}

/**
 * Project-wide file search for the composer "@" mention menu.
 *
 * Ranks case-insensitively in tiers (lower wins): exact basename, basename
 * prefix, relative-path prefix ("src/comp"), basename substring, path
 * substring. Within a tier: shallower first, then shorter rel, then name.
 * An empty query returns the top level of the project (dirs first) so a bare
 * "@" already shows something useful. Symlinks are skipped (cycle safety).
 */
export function searchProjectFiles(cwd: string, query: string, limit = 50): FileMatch[] {
  const root = resolve(cwd);
  if (!existsSync(root)) return [];
  const q = query.trim().toLowerCase();

  interface Candidate extends FileMatch {
    depth: number;
    tier: number;
  }
  const found: Candidate[] = [];
  let scanned = 0;
  // A query containing "/" is a path prefix — non-matching subtrees can be
  // pruned. Plain name queries (substring search) must walk everything.
  const pathQuery = q.includes("/");

  const consider = (e: Dirent, dir: string, relPrefix: string, depth: number): boolean => {
    if (IGNORE.has(e.name)) return false;
    if (e.isSymbolicLink()) return false;
    // Same dotfile policy as listDir.
    if (e.name.startsWith(".")) {
      if (e.name !== ".env" && e.name !== ".gitignore" && e.name !== ".editorconfig") return false;
    }
    const abs = join(dir, e.name);
    const isDir = e.isDirectory();
    const relPath = relPrefix ? `${relPrefix}/${e.name}` : e.name;
    if (q) {
      const base = e.name.toLowerCase();
      const relLower = relPath.toLowerCase();
      let tier = -1;
      if (base === q) tier = 0;
      else if (base.startsWith(q)) tier = 1;
      else if (relLower.startsWith(q) || relLower.startsWith(q + "/")) tier = 2;
      else if (base.includes(q)) tier = 3;
      else if (relLower.includes(q)) tier = 4;
      if (tier < 0) {
        // No match here. Plain-name queries need the full walk (substring can
        // hide anywhere); only path-prefix queries may prune subtrees.
        return isDir && (!pathQuery || q.startsWith(relLower + "/"));
      }
      found.push({ name: e.name, rel: relPath, abs, isDir, ext: isDir ? "" : extname(e.name).toLowerCase(), depth, tier });
    } else {
      // Bare "@": only the top level is interesting.
      if (depth === 1) found.push({ name: e.name, rel: relPath, abs, isDir, ext: isDir ? "" : extname(e.name).toLowerCase(), depth, tier: 0 });
    }
    return isDir;
  };

  const walk = (dir: string, relPrefix: string, depth: number) => {
    if (depth > SEARCH_MAX_DEPTH || scanned >= SEARCH_MAX_ENTRIES) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip
    }
    for (const e of entries) {
      if (scanned >= SEARCH_MAX_ENTRIES) return;
      scanned++;
      const descend = consider(e, dir, relPrefix, depth);
      if (descend && q === "") continue; // bare "@" never descends
      if (descend) walk(join(dir, e.name), relPrefix ? `${relPrefix}/${e.name}` : e.name, depth + 1);
    }
  };

  walk(root, "", 1);

  found.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.depth !== b.depth) return a.depth - b.depth;
    if (a.rel.length !== b.rel.length) return a.rel.length - b.rel.length;
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

  // For path-prefix queries the user typed a directory they want to browse:
  // keep that dir itself ahead of its deep descendants.
  return found.slice(0, limit);
}
