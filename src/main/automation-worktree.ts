import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "./config";
import { appendDiagLog } from "./diag-log";

/**
 * 定时任务的工作树隔离。
 *
 * 解决的问题：无人值守任务直接在项目目录里改文件，可能带 full 权限。夜里跑到
 * 一半失败、或者改出一堆半成品，用户第二天打开工作区就是一个烂摊子。
 *
 * 做法：在 git 仓库里用 `git worktree add` 开一份独立检出 + 独立分支，任务在
 * 那份检出里跑；工作区本身不动。跑完保留分支与目录，让用户自己决定「查看 diff /
 * 合并 / 丢弃」——自动合并回主干不是定时任务该做的事。
 *
 * 边界：
 *   - 只对 git 工作目录生效（`git rev-parse --git-dir` 成功）；非 git 目录直接
 *     报错而不是静默降级——静默降级正好打破了隔离的意义。
 *   - 不做自动清理：删掉工作树等于删掉用户的改动现场。只在「同一任务的上一次
 *     尝试失败后重试」时丢弃上一次的半成品（见 discardAutomationWorktree）。
 */

export interface AutomationWorktree {
  /** 工作树绝对路径（任务的 cwd 指向它）。 */
  path: string;
  /** 创建的分支名。 */
  branch: string;
  /** 源仓库工作目录。 */
  repo: string;
}

export type WorktreeResult =
  | { ok: true; worktree: AutomationWorktree }
  | { ok: false; reason: string };

/** 工作树根目录：放配置目录下，避免污染用户项目。 */
function worktreeRoot(): string {
  const root = join(getConfigDir(), "mpi-worktrees");
  mkdirSync(root, { recursive: true });
  return root;
}

function git(cwd: string, args: string[], timeoutMs = 20_000): { ok: boolean; out: string; err: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: timeoutMs, windowsHide: true });
  return {
    ok: r.status === 0,
    out: (r.stdout || "").trim(),
    err: (r.stderr || r.error?.message || "").trim(),
  };
}

/**
 * 该目录是否是某个 git 工作树的根（而不是仓库的子目录）。
 *
 * 不用「拿 `--show-toplevel` 的输出与入参比字符串」：git 会把符号链接与 8.3 短名解析成
 * 真实路径，而入参常常就是那种形式（CI runner 的 TMP 是 `C:\Users\RUNNER~1\…`，git 回的是
 * 长路径）→ 字符串必不相等 → 把真仓库误判为「不是 git 仓库」，工作树隔离被无理由地拒绝。
 * 改成直接问 git 自己在不在根上：`--show-prefix` 在仓库根输出空串，在子目录输出 `sub/`。
 */
export function isGitRepoRoot(dir: string): boolean {
  if (!existsSync(dir)) return false;
  const inside = git(dir, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.out !== "true") return false;
  const prefix = git(dir, ["rev-parse", "--show-prefix"]);
  return prefix.ok && prefix.out === "";
}

/** 仓库是否干净（有未提交改动时开工作树会让人困惑，但不阻止，只提示）。 */
export function repoHasUncommittedChanges(dir: string): boolean {
  const r = git(dir, ["status", "--porcelain"]);
  return r.ok && r.out.length > 0;
}

/**
 * 创建一次运行专用工作树。
 *
 * 分支名 `mpi-auto/<taskId>/<runId>`：带上 runId 让每次运行独立，
 * 也便于用户在 `git branch` 列表里按前缀一眼认出这些是自动任务产物。
 */
export function createAutomationWorktree(repoDir: string, taskId: string, runId: string): WorktreeResult {
  if (!existsSync(repoDir)) return { ok: false, reason: `工作目录不存在：${repoDir}` };
  const top = git(repoDir, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) {
    return { ok: false, reason: "该目录不是 git 仓库（定时任务的工作树隔离需要 git）" };
  }
  const repo = top.out;
  // 安全化 id：git 拒绝含 `..` 的分支名（安全化后 `task/../evil` 会变成
  // `task-..-evil`，仍然被拒），所以连续点号也要压掉。同时去掉路径分隔符与
  // Windows 保留字符，避开工件树目录跳到别处。
  const safe = (s: string) =>
    s
      .replace(/[/\\:*?"<>|]/g, "-")
      .replace(/\.{2,}/g, ".")
      .replace(/^[.-]+|[.-]+$/g, "")
      .slice(0, 40) || "x";
  const branch = `mpi-auto/${safe(taskId)}/${safe(runId)}`;
  const dir = join(worktreeRoot(), safe(taskId), safe(runId));

  try {
    mkdirSync(join(worktreeRoot(), safe(taskId)), { recursive: true });
  } catch (e: any) {
    return { ok: false, reason: `无法创建工作树目录：${e?.message || e}` };
  }
  if (existsSync(dir)) {
    // 上一次同 runId 的残留（极少见）：直接复用前先清掉，避免 add 失败。
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (e: any) {
      return { ok: false, reason: `无法清理残留工作树：${e?.message || e}` };
    }
  }

  const add = git(repo, ["worktree", "add", "-b", branch, dir, "HEAD"], 60_000);
  if (!add.ok) {
    return { ok: false, reason: add.err.split("\n")[0] || "git worktree add 失败" };
  }
  // 子模块不自动初始化：任务通常不需要；需要时会自己在工作树里跑 submodule update。
  appendDiagLog(`worktree created repo=${repo} branch=${branch}`);
  return { ok: true, worktree: { path: dir, branch, repo } };
}

/**
 * 丢弃一个工作树（含分支）。
 *
 * 只用于「同一次运行的失败重试」：上一次尝试的半成品不该带进下一次。
 * 正常完成的工作树一律保留，让用户自己决定去留。
 */
export function discardAutomationWorktree(worktree: AutomationWorktree): void {
  const remove = git(worktree.repo, ["worktree", "remove", "--force", worktree.path], 30_000);
  if (!remove.ok) {
    // worktree remove 失败时至少清掉目录登记，否则 `git worktree list` 会留僵尸。
    git(worktree.repo, ["worktree", "prune"]);
  }
  // 分支留着会把 `git branch` 塞满，且它的提交已经没人引用了（工作树被删）。
  git(worktree.repo, ["branch", "-D", worktree.branch]);
  appendDiagLog(`worktree discarded path=${worktree.path} branch=${worktree.branch}`);
}

/** 清理登记信息（应用启动时调一次，回收崩溃留下的僵尸条目）。 */
export function pruneWorktrees(): void {
  try {
    const root = join(getConfigDir(), "mpi-worktrees");
    if (!existsSync(root)) return;
    // 逐个任务目录找 repo：登记在 .git/worktrees 下，只能靠 git 自己 prune。
    // 这里只处理「工作树目录已不存在」的情况；具体仓库由 git prune 兜底。
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    for (const taskDir of readdirSync(root)) {
      const full = join(root, taskDir);
      for (const runDir of readdirSync(full)) {
        const p = join(full, runDir);
        if (!existsSync(join(p, ".git"))) continue;
        const common = git(p, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
        if (!common.ok) continue;
        const repo = common.out.replace(/[/\\]\.git$/, "");
        if (repo && existsSync(repo)) git(repo, ["worktree", "prune"]);
      }
    }
  } catch {
    /* 清理失败不影响主流程 */
  }
}
