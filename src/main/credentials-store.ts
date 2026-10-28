import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "./config";
import { readJsonRaw, writeJsonAtomic } from "./json-store";
import type {
  CredentialInput,
  CredentialKind,
  CredentialLevel,
  CredentialPatch,
  CredentialScope,
  CredentialSummary,
} from "../renderer/src/lib/types";
import { scopeMatches, secretEnvName, type SecretEnvMeta } from "../shared/credentials";

export type {
  CredentialInput,
  CredentialKind,
  CredentialLevel,
  CredentialPatch,
  CredentialScope,
  CredentialSummary,
};

/**
 * 凭据库（P1a）：密码 / token / passphrase / ssh-key 的加密落盘与增删改查。
 *
 * 硬约束（见 docs/CREDENTIALS-VAULT.md）：
 * - **值永不进对话、日志、快照、中继**。本模块不打印任何值，审计只记凭据名与动作。
 * - 加密委托给可注入的 cipher（真实实现 = Electron `safeStorage`，即 Windows DPAPI）：
 *   本文件**不 import electron**，由 ipc.ts 在启动时接线，测试注入假 cipher。
 * - **加密不可用时 fail-closed**：拒绝写入，绝不退化成明文落盘。
 *
 * 文件布局（都在应用配置目录，不进工程目录）：
 *   credentials.json         凭据记录（值是 `enc:<base64>` 密文）
 *   credentials-audit.jsonl  审计追加日志（只含 id/name/动作/时间）
 */

interface CredentialRecord extends CredentialSummary {
  /** `enc:<base64>`，由 cipher 生成。 */
  valueEnc: string;
}

interface CredentialsFile {
  version: 1;
  credentials: CredentialRecord[];
}

export type CredentialErrorCode =
  | "CRED_ENCRYPTION_UNAVAILABLE"
  | "CRED_NAME_INVALID"
  | "CRED_NAME_TAKEN"
  | "CRED_NOT_FOUND"
  | "CRED_VALUE_EMPTY"
  | "CRED_VALUE_TOO_LONG"
  | "CRED_KIND_INVALID"
  | "CRED_LEVEL_INVALID"
  | "CRED_SCOPE_INVALID";

export class CredentialError extends Error {
  /** 稳定错误码（渲染层据此出文案，不解析 message）。 */
  readonly code: CredentialErrorCode;

  constructor(code: CredentialErrorCode, message?: string) {
    super(message ?? code);
    this.name = "CredentialError";
    this.code = code;
  }
}

/** 加密适配器。真实实现包一层 `safeStorage`，测试注入假实现。 */
export interface CredentialCipher {
  available(): boolean;
  encrypt(plain: string): string;
  decrypt(blob: string): string;
}

const KINDS: CredentialKind[] = ["password", "token", "passphrase", "ssh-key"];
const LEVELS: CredentialLevel[] = ["silent", "confirm", "local-only"];
/** 引用名会出现在命令与提示词里：只允许小写 + 数字 + `._-`，首字符非符号。 */
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_VALUE_CHARS = 16384;

let cipher: CredentialCipher | null = null;
let cache: CredentialRecord[] | null = null;

/** 启动时由 ipc.ts 传入真实 safeStorage 适配器；传 null 用于测试重置。 */
export function configureCredentialCipher(next: CredentialCipher | null): void {
  cipher = next;
  cache = null;
}

function requireCipher(): CredentialCipher {
  if (!cipher || !cipher.available()) {
    throw new CredentialError(
      "CRED_ENCRYPTION_UNAVAILABLE",
      "本机加密不可用（safeStorage 未就绪），拒绝保存凭据——绝不退化为明文",
    );
  }
  return cipher;
}

export function credentialsFilePath(): string {
  return join(getConfigDir(), "credentials.json");
}

export function credentialsAuditPath(): string {
  return join(getConfigDir(), "credentials-audit.jsonl");
}

function isRecord(v: unknown): v is CredentialRecord {
  if (!v || typeof v !== "object") return false;
  const r = v as Partial<CredentialRecord>;
  return (
    typeof r.id === "string" &&
    typeof r.name === "string" &&
    typeof r.valueEnc === "string" &&
    r.valueEnc.startsWith("enc:") &&
    KINDS.includes(r.kind as CredentialKind) &&
    LEVELS.includes(r.level as CredentialLevel)
  );
}

function normalizeScope(raw: unknown): CredentialScope {
  if (raw && typeof raw === "object") {
    const s = raw as Partial<CredentialScope> & { root?: unknown };
    if (s.type === "global") return { type: "global" };
    if (s.type === "project" && typeof s.root === "string" && s.root.trim()) {
      return { type: "project", root: s.root.trim() };
    }
  }
  throw new CredentialError("CRED_SCOPE_INVALID", "scope 只能是 global，或 project + 非空 root");
}

function load(): CredentialRecord[] {
  if (cache) return cache;
  const out: CredentialRecord[] = [];
  const parsed = readJsonRaw(credentialsFilePath()) as Partial<CredentialsFile> | null;
  if (parsed && Array.isArray(parsed.credentials)) {
    for (const item of parsed.credentials) {
      if (!isRecord(item)) continue;
      out.push({
        ...item,
        scope: (() => {
          try {
            return normalizeScope(item.scope);
          } catch {
            return { type: "global" };
          }
        })(),
        useCount: typeof item.useCount === "number" ? item.useCount : 0,
      });
    }
  }
  cache = out;
  return out;
}

function persist(records: CredentialRecord[]): void {
  mkdirSync(getConfigDir(), { recursive: true });
  const payload: CredentialsFile = { version: 1, credentials: records };
  writeJsonAtomic(credentialsFilePath(), payload, { pretty: true });
  cache = records;
}

function newId(): string {
  return `cred_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** 审计：只记动作与名字，永不含值。写失败不影响主流程。 */
function audit(action: "create" | "update" | "delete" | "reveal" | "deny", rec: { id: string; name: string }, detail?: string): void {
  try {
    const line = JSON.stringify({ ts: Date.now(), action, id: rec.id, name: rec.name, ...(detail ? { detail } : {}) });
    mkdirSync(getConfigDir(), { recursive: true });
    appendFileSync(credentialsAuditPath(), `${line}\n`, "utf8");
    // 体积轮转（比如 2MB 截断）留到 P1c 的审计整理里做，这里只保证追加成功。
  } catch {
    /* 审计失败不阻塞使用 */
  }
}

function toSummary(rec: CredentialRecord): CredentialSummary {
  const { valueEnc: _omit, ...rest } = rec;
  return rest;
}

function assertName(name: string): string {
  const trimmed = String(name ?? "").trim().toLowerCase();
  if (!NAME_RE.test(trimmed)) {
    throw new CredentialError("CRED_NAME_INVALID", "名称只允许小写字母/数字/._-，2–64 位，首字符不能是符号");
  }
  return trimmed;
}

function assertKind(kind: unknown): CredentialKind {
  if (!KINDS.includes(kind as CredentialKind)) throw new CredentialError("CRED_KIND_INVALID");
  return kind as CredentialKind;
}

function assertLevel(level: unknown): CredentialLevel {
  if (!LEVELS.includes(level as CredentialLevel)) throw new CredentialError("CRED_LEVEL_INVALID");
  return level as CredentialLevel;
}

function assertValue(value: unknown): string {
  const v = typeof value === "string" ? value : "";
  if (!v) throw new CredentialError("CRED_VALUE_EMPTY", "值不能为空");
  if (v.length > MAX_VALUE_CHARS) throw new CredentialError("CRED_VALUE_TOO_LONG");
  return v;
}

function assertUnique(records: CredentialRecord[], name: string, exceptId?: string): void {
  if (records.some((r) => r.name === name && r.id !== exceptId)) {
    throw new CredentialError("CRED_NAME_TAKEN", `凭据名已存在：${name}`);
  }
}

export function listCredentials(): CredentialSummary[] {
  return load()
    .map(toSummary)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function createCredential(input: CredentialInput): CredentialSummary {
  const name = assertName(input?.name);
  const kind = assertKind(input?.kind);
  const level = assertLevel(input?.level);
  const scope = input?.scope === undefined ? { type: "global" as const } : normalizeScope(input.scope);
  const value = assertValue(input?.value);
  const records = load();
  assertUnique(records, name);
  const enc = requireCipher();
  const rec: CredentialRecord = {
    id: newId(),
    name,
    kind,
    level,
    scope,
    ...(typeof input.hint === "string" && input.hint.trim() ? { hint: input.hint.trim().slice(0, 200) } : {}),
    createdAt: Date.now(),
    useCount: 0,
    valueEnc: enc.encrypt(value),
  };
  persist([...records, rec]);
  audit("create", rec);
  return toSummary(rec);
}

export function updateCredential(id: string, patch: CredentialPatch): CredentialSummary {
  const records = load();
  const idx = records.findIndex((r) => r.id === id);
  if (idx < 0) throw new CredentialError("CRED_NOT_FOUND");
  const cur = records[idx];
  const name = patch?.name === undefined ? cur.name : assertName(patch.name);
  assertUnique(records, name, cur.id);
  const kind = patch?.kind === undefined ? cur.kind : assertKind(patch.kind);
  const level = patch?.level === undefined ? cur.level : assertLevel(patch.level);
  const scope = patch?.scope === undefined ? cur.scope : normalizeScope(patch.scope);
  let valueEnc = cur.valueEnc;
  if (patch?.value !== undefined) {
    valueEnc = requireCipher().encrypt(assertValue(patch.value));
  }
  const hint =
    patch?.hint === null
      ? undefined
      : typeof patch?.hint === "string" && patch.hint.trim()
        ? patch.hint.trim().slice(0, 200)
        : cur.hint;
  const next: CredentialRecord = {
    ...cur,
    name,
    kind,
    level,
    scope,
    valueEnc,
    ...(hint ? { hint } : {}),
  };
  if (!hint) delete (next as Partial<CredentialRecord>).hint;
  const copy = [...records];
  copy[idx] = next;
  persist(copy);
  audit("update", next);
  return toSummary(next);
}

export function deleteCredential(id: string): boolean {
  const records = load();
  const target = records.find((r) => r.id === id);
  if (!target) throw new CredentialError("CRED_NOT_FOUND");
  persist(records.filter((r) => r.id !== id));
  audit("delete", target);
  return true;
}

/**
 * 取明文。**只在「显示 / 复制」这一条路径上调用**，调用方负责先过闸门
 * （P1a 阶段闸门尚未接入，见 docs/CREDENTIALS-VAULT.md §5）。
 */
export function revealCredential(id: string): { name: string; kind: CredentialKind; value: string } {
  const records = load();
  const idx = records.findIndex((r) => r.id === id);
  if (idx < 0) throw new CredentialError("CRED_NOT_FOUND");
  const rec = records[idx];
  const value = requireCipher().decrypt(rec.valueEnc);
  const next: CredentialRecord = {
    ...rec,
    lastUsedAt: Date.now(),
    useCount: (rec.useCount || 0) + 1,
  };
  const copy = [...records];
  copy[idx] = next;
  try {
    persist(copy);
  } catch {
    /* 统计写入失败不该让「显示」失败 */
  }
  audit("reveal", next);
  return { name: rec.name, kind: rec.kind, value };
}

/** 测试用：丢弃内存缓存（不删文件）。 */
export function __resetCredentialsCache(): void {
  cache = null;
}

/**
 * 为某个项目根目录构建「可注入进程环境的凭据」（P1b）。
 *
 * - 只含 `level === "silent"`：`confirm` / `local-only` 需要逐次策略判断，
 *   只能走后续的 broker 工具（docs/CREDENTIALS-VAULT.md §7）；提前注入等于绕过策略。
 * - 作用域限定：`global` 全适用，`project` 只在根目录匹配时适用。
 * - 返回值里带明文值，**调用方只能把它交给 spawn 的 env，不得记录**。
 */
export function secretEnvForScope(root: string | undefined): {
  env: Record<string, string>;
  meta: SecretEnvMeta[];
} {
  const env: Record<string, string> = {};
  const meta: SecretEnvMeta[] = [];
  if (!cipher || !cipher.available()) return { env, meta };
  for (const rec of load()) {
    if (rec.level !== "silent") continue;
    if (!scopeMatches(rec.scope, root)) continue;
    const name = secretEnvName(rec.name);
    try {
      env[name] = cipher.decrypt(rec.valueEnc);
    } catch {
      continue; // 单条解密失败不影响其它凭据；不输出原因（避免日志里蹦出密文片段）
    }
    meta.push({ env: name, name: rec.name, ...(rec.hint ? { hint: rec.hint } : {}) });
  }
  return { env, meta };
}
