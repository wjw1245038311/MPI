// 工作树隔离（automation-worktree.ts）单测。
//
// 真实建 git 仓库（在临时目录里 git init + 一次提交）来验证：创建、分支命名、
// 非 git 目录报错、丢弃后分支与目录都没了。不 mock git —— mock 出来的
// 「worktree add 成功」证明不了真实 git 会接受我们的参数顺序。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

register(new URL("./electron-stub-loader.mjs", import.meta.url));
const { loadConfig } = await import("../src/main/config.ts");
const wt = await import("../src/main/automation-worktree.ts");

let checks = 0;
const ok = (label) => {
  checks++;
  return label;
};

// git 可用性
let gitOk = true;
try {
  execFileSync("git", ["--version"], { stdio: "ignore" });
} catch {
  gitOk = false;
}

if (!gitOk) {
  console.log("automation-worktree SKIP (git 不可用)");
} else {
  const dataDir = mkdtempSync(join(tmpdir(), "mpi-wt-config-"));
  const repoDir = mkdtempSync(join(tmpdir(), "mpi-wt-repo-"));
  const nonGitDir = mkdtempSync(join(tmpdir(), "mpi-wt-nongit-"));

  const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  try {
    loadConfig(dataDir); // worktree root 落在临时 config 目录下

    // ---- 非 git 目录：必须明确失败，不能静默降级 ----
    const notRepo = wt.createAutomationWorktree(nonGitDir, "task-x", "run-1");
    assert.equal(notRepo.ok, false, ok("非 git 目录创建失败"));
    assert.match(notRepo.reason, /不是 git 仓库/, ok("失败原因说明是缺少 git"));
    assert.equal(wt.isGitRepoRoot(nonGitDir), false, ok("isGitRepoRoot 对非 git 目录返回 false"));
    assert.equal(wt.isGitRepoRoot(join(nonGitDir, "nope")), false, ok("isGitRepoRoot 对不存在的目录返回 false"));

    // ---- 准备一个真实仓库 ----
    git(repoDir, ["init", "-q"]);
    git(repoDir, ["config", "user.email", "test@example.invalid"]);
    git(repoDir, ["config", "user.name", "Test"]);
    writeFileSync(join(repoDir, "a.txt"), "hello\n", "utf8");
    git(repoDir, ["add", "."]);
    git(repoDir, ["commit", "-q", "-m", "init"]);

    assert.equal(wt.isGitRepoRoot(repoDir), true, ok("isGitRepoRoot 对仓库根返回 true"));

    // 路径的**写法**不能影响判定。旧实现拿 `--show-toplevel` 的输出与入参比字符串，
    // 而 git 会把符号链接 / 8.3 短名解析成真实路径——CI runner 的 TMP 正是短名形式，
    // 这条在 CI 上就红了（run #44）。用指向仓库根的链接复现同一机制。
    const linkDir = join(dirname(repoDir), `${basename(repoDir)}-link`);
    let linkMade = false;
    try {
      symlinkSync(repoDir, linkDir, process.platform === "win32" ? "junction" : "dir");
      linkMade = true;
      assert.equal(
        wt.isGitRepoRoot(linkDir),
        true,
        ok("指向仓库根的链接也判为仓库根（不做路径字符串比对）"),
      );
    } catch (err) {
      if (err instanceof assert.AssertionError) throw err;
      console.log(`  （链接用例跳过：本机无法创建符号链接 —— ${(err && err.code) || err}）`);
    } finally {
      if (linkMade) {
        // rmdir 只移除链接本身，不动目标内容（rmSync recursive 对 junction 会进到目标里）
        try {
          rmdirSync(linkDir);
        } catch {
          rmSync(linkDir, { force: true });
        }
      }
    }
    // 子目录不是仓库根
    const sub = join(repoDir, "sub");
    mkdirSync(sub);
    assert.equal(wt.isGitRepoRoot(sub), false, ok("子目录不算仓库根（否则会在错误位置开工作树）"));

    // 干净/脏判定
    assert.equal(wt.repoHasUncommittedChanges(repoDir), false, ok("干净仓库无未提交改动"));
    writeFileSync(join(repoDir, "a.txt"), "changed\n", "utf8");
    assert.equal(wt.repoHasUncommittedChanges(repoDir), true, ok("改动后判定为脏"));
    git(repoDir, ["checkout", "--", "a.txt"]);

    // ---- 创建工作树 ----
    const created = wt.createAutomationWorktree(repoDir, "task-abc", "run-xyz");
    assert.equal(created.ok, true, `创建工作树成功${created.ok ? "" : "：" + created.reason}`);
    const tree = created.worktree;
    assert.ok(existsSync(tree.path), ok("工作树目录存在"));
    assert.ok(existsSync(join(tree.path, "a.txt")), ok("工作树里有 HEAD 的文件内容"));
    assert.equal(tree.branch, "mpi-auto/task-abc/run-xyz", ok("分支名带上任务与运行 id"));
    // 比「是不是同一个目录」，不比字符串：产品侧拿 git 的 --show-toplevel 记录源仓库，
    // 而 git 会把 8.3 短名 / 符号链接解析成真实路径（CI runner 的 TMP 就是
    // `C:\Users\RUNNER~1\…`，回的是 `…\runneradmin\…`）——归一化分隔符仍拦不住这种差异。
    const sameDir = (a, b) => {
      const key = (p) => {
        let q = p;
        try {
          q = realpathSync(p);
        } catch {
          /* 拿不到真实路径就退回原值 */
        }
        return q.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
      };
      return key(a) === key(b);
    };
    assert.ok(sameDir(tree.repo, repoDir), ok("记录源仓库路径（按真实路径比对，不受短名/链接形式影响）"));

    // 保证“入参写成链接形式”时也能开工作树、并且记录的仍是同一个仓库。
    // 注意：这条**不是** CI 那个短名问题的本地复现——本机目录本就是真实路径，
    // 把 sameDir 换回字符串比对它也照过。短名差异只存在于 runner（唯一证据是 run #45 的
    // actual `…runneradmin…` vs expected `…runner~1…`），因此它靠本次 CI 结果来验。
    const viaLink = join(dirname(repoDir), `${basename(repoDir)}-rec`);
    let recMade = false;
    try {
      symlinkSync(repoDir, viaLink, process.platform === "win32" ? "junction" : "dir");
      recMade = true;
      const via = wt.createAutomationWorktree(viaLink, "task-link", "run-link");
      assert.equal(via.ok, true, `通过链接路径入参也能开工作树${via.ok ? "" : "：" + via.reason}`);
      assert.ok(sameDir(via.worktree.repo, repoDir), ok("链接/短名形式的入参不会被当成另一个仓库"));
    } catch (err) {
      if (err instanceof assert.AssertionError) throw err;
      console.log(`  （短名复现用例跳过：${(err && err.code) || err}）`);
    } finally {
      if (recMade) {
        try {
          rmdirSync(viaLink);
        } catch {
          rmSync(viaLink, { force: true });
        }
      }
    }

    // 工作树是独立检出：在里面改文件不影响原仓库
    writeFileSync(join(tree.path, "a.txt"), "modified-in-worktree\n", "utf8");
    assert.equal(wt.repoHasUncommittedChanges(repoDir), false, ok("工作树里的改动不污染原仓库（隔离的核心）"));
    assert.equal(wt.repoHasUncommittedChanges(tree.path), true, ok("工作树自身能看到改动"));

    // 分支确实存在
    const branches = git(repoDir, ["branch", "--list"]);
    assert.match(branches, /mpi-auto\/task-abc\/run-xyz/, ok("分支已创建"));

    // git worktree list 里能查到
    const list = git(repoDir, ["worktree", "list"]);
    assert.ok(list.replace(/\\/g, "/").includes(tree.path.replace(/\\/g, "/")), ok("git 登记了该工作树"));

    // ---- 丢弃 ----
    wt.discardAutomationWorktree(tree);
    assert.equal(existsSync(tree.path), false, ok("丢弃后目录被删除"));
    const afterBranches = git(repoDir, ["branch", "--list"]);
    assert.doesNotMatch(afterBranches, /mpi-auto\/task-abc\/run-xyz/, ok("丢弃后分支也被删除（不留垃圾分支）"));
    const afterList = git(repoDir, ["worktree", "list"]);
    assert.ok(!afterList.replace(/\\/g, "/").includes(tree.path.replace(/\\/g, "/")), ok("git 登记已清理"));

    // ---- 同名 runId 重复创建：应清理残留后成功 ----
    const again = wt.createAutomationWorktree(repoDir, "task-abc", "run-dup");
    assert.equal(again.ok, true, ok("首次创建 run-dup"));
    wt.discardAutomationWorktree(again.worktree);
    const again2 = wt.createAutomationWorktree(repoDir, "task-abc", "run-dup");
    assert.equal(again2.ok, true, `同 runId 重复创建成功（残留被清理）：${again2.ok ? "" : again2.reason}`);
    wt.discardAutomationWorktree(again2.worktree);

    // ---- id 里的路径字符被安全化 ----
    const weird = wt.createAutomationWorktree(repoDir, "task/../evil", "run:1");
    assert.equal(weird.ok, true, `含路径字符的 id 仍可创建：${weird.ok ? "" : weird.reason}`);
    assert.ok(!weird.worktree.branch.includes(".."), ok("分支名里没有 .."));
    assert.ok(!/[/\\]evil[/\\]/.test(weird.worktree.path.replace(/\\/g, "/")), ok("工作树路径没有跑出配置目录"));
    wt.discardAutomationWorktree(weird.worktree);

    // ---- pruneWorktrees 不抛 ----
    wt.pruneWorktrees();
    checks++;
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(nonGitDir, { recursive: true, force: true });
  }

  console.log(`automation-worktree ok (${checks} 项断言通过)`);
}
