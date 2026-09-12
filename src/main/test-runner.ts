/**
 * 功能测试运行器（dev-only「自动化测试」面板的执行侧）。
 *
 * - logic 用例：`node scripts/run-all-tests.mjs <filter>`（L1 快环）
 * - scenario 用例：`node scripts/e2e/harness.mjs <harnessCaseId>`，跑完读回
 *   tmp/research-e2e/run-<id>/result.json 与 logs/transcript.txt
 *
 * 仅在 dev（!app.isPackaged）可用；子进程输出按行回调，由 IPC 流式转发给面板。
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { LogicRunResult, ScenarioHistoryEntry, ScenarioResultFile, ScenarioRunResult } from "../renderer/src/lib/types";
import { listRegistryCases, type RegistryScan } from "./test-registry";

type LogFn = (line: string) => void;

/** dev 下 main bundle 位于 <repo>/out/main/ → ../.. 即仓库根。 */
function repoRoot(): string {
  const root = resolve(__dirname, "../..");
  if (!existsSync(join(root, "package.json")) || !existsSync(join(root, "scripts", "run-all-tests.mjs"))) {
    throw new Error(`无法定位仓库根目录：${root}（缺少 package.json / scripts/run-all-tests.mjs）`);
  }
  return root;
}

export function listTests(): RegistryScan {
  return listRegistryCases(repoRoot());
}

/** spawn + 逐行流式输出；返回退出码与完整输出（供面板落档）。 */
function runStream(args: string[], onLine: LogFn): Promise<{ code: number | null; output: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, args, { cwd: repoRoot(), windowsHide: true, env: process.env });
    let output = "";
    let buf = "";
    const feed = (chunk: string) => {
      const text = chunk.replace(/\r\n/g, "\n");
      output += text;
      buf += text;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        onLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    };
    child.stdout?.on("data", (d: Buffer) => feed(d.toString("utf8")));
    child.stderr?.on("data", (d: Buffer) => feed(d.toString("utf8")));
    child.on("error", (err) => {
      onLine(`✗ 无法启动进程：${err.message}`);
      resolvePromise({ code: null, output: `${output}\n${err.message}` });
    });
    child.on("close", (code) => {
      if (buf.trim()) onLine(buf.replace(/\n+$/, ""));
      resolvePromise({ code, output });
    });
  });
}

/** logic 用例：过滤跑 L1（run-all-tests.mjs 的过滤词与 registry logicTest 对应）。 */
export async function runLogicTest(logicTest: string, onLine: LogFn): Promise<LogicRunResult> {
  if (!/^[a-z0-9-]+$/i.test(logicTest)) {
    return { ok: false, exitCode: null, output: `非法 logicTest：${logicTest}` };
  }
  const res = await runStream([join(repoRoot(), "scripts", "run-all-tests.mjs"), logicTest], onLine);
  return { ok: res.code === 0, exitCode: res.code, output: res.output };
}

interface ScenarioArtifacts {
  result: ScenarioResultFile | null;
  transcript: string | null;
}

function readScenarioArtifacts(harnessCaseId: string): ScenarioArtifacts {
  const dir = join(repoRoot(), "tmp", "research-e2e", `run-${harnessCaseId}`);
  const resultPath = join(dir, "result.json");
  const transcriptPath = join(dir, "logs", "transcript.txt");
  let result: ScenarioResultFile | null = null;
  let transcript: string | null = null;
  try {
    if (existsSync(resultPath)) result = JSON.parse(readFileSync(resultPath, "utf8")) as ScenarioResultFile;
  } catch {
    /* 产物可能正在写入或被破坏，视作无 */
  }
  try {
    if (existsSync(transcriptPath)) transcript = readFileSync(transcriptPath, "utf8");
  } catch {
    /* 同上 */
  }
  return { result, transcript };
}

function statusOf(result: ScenarioResultFile | null): ScenarioRunResult["status"] {
  switch (result?.status) {
    case "pass":
    case "fail":
    case "timeout":
    case "error":
      return result.status;
    default:
      return "no-result";
  }
}

const ID_RE = /^[a-z0-9-]+$/i;

/** scenario 用例：跑 harness 后读回产物。真实通过与否依赖本地 relay（L3）。 */
export async function runScenarioCase(harnessCaseId: string, onLine: LogFn): Promise<ScenarioRunResult> {
  if (!ID_RE.test(harnessCaseId)) {
    return { ok: false, status: "error", exitCode: null, result: null, transcript: null, error: `非法 harnessCaseId：${harnessCaseId}` };
  }
  const harness = join(repoRoot(), "scripts", "e2e", "harness.mjs");
  if (!existsSync(harness)) {
    return { ok: false, status: "error", exitCode: null, result: null, transcript: null, error: `找不到 harness：${harness}` };
  }
  const res = await runStream([harness, harnessCaseId], onLine);
  const { result, transcript } = readScenarioArtifacts(harnessCaseId);
  const status = statusOf(result);
  return {
    ok: status === "pass",
    status,
    exitCode: res.code,
    result,
    transcript,
    ...(result ? {} : { error: "未找到 result.json（harness 可能未产出或已清理）" }),
  };
}

/** 只读回最近一次 scenario 产物（面板首次打开时加载历史）。 */
export function readScenarioResult(harnessCaseId: string): ScenarioRunResult {
  if (!ID_RE.test(harnessCaseId)) {
    return { ok: false, status: "error", exitCode: null, result: null, transcript: null, error: `非法 harnessCaseId：${harnessCaseId}` };
  }
  const { result, transcript } = readScenarioArtifacts(harnessCaseId);
  return { ok: result?.status === "pass", status: statusOf(result), exitCode: null, result, transcript };
}

/** harness 的历史汇总（tmp/research-e2e/results-summary.json）。 */
export function readScenarioHistory(): ScenarioHistoryEntry[] {
  const p = join(repoRoot(), "tmp", "research-e2e", "results-summary.json");
  if (!existsSync(p)) return [];
  try {
    const raw: unknown = JSON.parse(readFileSync(p, "utf8"));
    return Array.isArray(raw) ? (raw as ScenarioHistoryEntry[]) : [];
  } catch {
    return [];
  }
}
