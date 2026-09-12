/**
 * 功能测试注册表（dev-only「自动化测试」面板的数据源）。
 *
 * 约定：`tests/registry/<file>.json` 每个文件声明一个可运行用例。
 * 本模块是主进程侧纯逻辑（仅依赖 node 内置模块），可被 L1 直接测试。
 * 面板通过 IPC `tests:list` 拿到解析结果，因此**新增用例只需落文件、无需改 UI**。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RegistryParseError, RegistryScan, TestCaseKind, TestRegistryCase } from "../renderer/src/lib/types";

export type { RegistryParseError, RegistryScan, TestCaseKind, TestRegistryCase } from "../renderer/src/lib/types";

export const REGISTRY_DIR_REL = join("tests", "registry");

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/** 纯校验 + 归一化。未知字段被丢弃，缺字段/类型错误逐条返回。 */
export function parseRegistryCase(
  raw: unknown,
): { ok: true; value: TestRegistryCase } | { ok: false; errors: string[] } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ["用例必须是 JSON 对象"] };
  }
  const o = raw as Record<string, unknown>;
  const errors: string[] = [];

  if (!isNonEmptyString(o.id)) errors.push("id 必须是非空字符串");
  else if (!ID_RE.test(o.id)) errors.push(`id 不合法（只允许小写字母数字与连字符）：${o.id}`);

  if (!isNonEmptyString(o.title)) errors.push("title 必须是非空字符串");
  if (!isNonEmptyString(o.feature)) errors.push("feature 必须是非空字符串");
  if (!isNonEmptyString(o.source)) errors.push("source 必须是非空字符串");
  if (!isNonEmptyString(o.passCriteria)) errors.push("passCriteria 必须是非空字符串");

  if (o.kind !== "logic" && o.kind !== "scenario") {
    errors.push(`kind 必须是 "logic" 或 "scenario"（实际：${String(o.kind)}）`);
  } else if (o.kind === "logic") {
    if (!isNonEmptyString(o.logicTest)) errors.push("kind=logic 需要非空 logicTest（run-all-tests 过滤词）");
  } else {
    if (!isNonEmptyString(o.harnessCaseId)) errors.push("kind=scenario 需要非空 harnessCaseId");
  }

  if (o.description !== undefined && !isNonEmptyString(o.description)) errors.push("description 若提供必须是非空字符串");
  if (o.preprompt !== undefined && !isNonEmptyString(o.preprompt)) errors.push("preprompt 若提供必须是非空字符串");

  if (o.assertions !== undefined) {
    if (!Array.isArray(o.assertions) || o.assertions.length === 0) errors.push("assertions 若提供必须是非空字符串数组");
    else if (o.assertions.some((a) => !isNonEmptyString(a))) errors.push("assertions 每项必须是非空字符串");
  }

  if (o.repeat !== undefined) {
    if (typeof o.repeat !== "number" || !Number.isInteger(o.repeat) || o.repeat < 1) {
      errors.push("repeat 若提供必须是 >=1 的整数");
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      id: o.id as string,
      title: o.title as string,
      feature: o.feature as string,
      kind: o.kind as TestCaseKind,
      source: o.source as string,
      passCriteria: o.passCriteria as string,
      ...(isNonEmptyString(o.description) ? { description: o.description } : {}),
      ...(isNonEmptyString(o.logicTest) ? { logicTest: o.logicTest } : {}),
      ...(isNonEmptyString(o.harnessCaseId) ? { harnessCaseId: o.harnessCaseId } : {}),
      ...(isNonEmptyString(o.preprompt) ? { preprompt: o.preprompt } : {}),
      ...(Array.isArray(o.assertions) ? { assertions: o.assertions as string[] } : {}),
      ...(typeof o.repeat === "number" ? { repeat: o.repeat } : {}),
    },
  };
}

/** 扫描 `<root>/tests/registry/*.json`。坏文件进 errors，不阻断其余用例。 */
export function listRegistryCases(root: string): RegistryScan {
  const dir = join(root, REGISTRY_DIR_REL);
  if (!existsSync(dir)) return { cases: [], errors: [] };

  const cases: TestRegistryCase[] = [];
  const errors: RegistryParseError[] = [];
  const seen = new Set<string>();

  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  for (const file of files) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(dir, file), "utf8"));
    } catch (e) {
      errors.push({ file, errors: [`JSON 解析失败：${e instanceof Error ? e.message : String(e)}`] });
      continue;
    }
    const parsed = parseRegistryCase(raw);
    if (!parsed.ok) {
      errors.push({ file, errors: parsed.errors });
      continue;
    }
    if (seen.has(parsed.value.id)) {
      errors.push({ file, errors: [`id 重复：${parsed.value.id}`] });
      continue;
    }
    seen.add(parsed.value.id);
    cases.push(parsed.value);
  }

  cases.sort((a, b) => a.feature.localeCompare(b.feature) || a.id.localeCompare(b.id));
  return { cases, errors };
}
