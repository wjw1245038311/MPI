/**
 * 附件「中继分片上传」（2026-10-09）：把字节搬运从**只支持 HTTP 直连**扩展到**走加密通道分片**。
 *
 * ## 为什么需要
 *
 * 直连（`attachment-server.ts`）要求主机有一个**公网可达的 HTTP 入口**：Tailscale serve、
 * 反向隧道、或已备案域名。新装的机器（如 MiniBox）什么都没有，而旧那套公网隧道又因为
 * 「企业网对主机**单条 TCP 上行**限速 ~0.8MB/s」被废弃（见 `Service/att-public/README.md`）。
 *
 * 走中继则天然可用，而且**快**：
 *
 * ```
 * 手机 ──上行──> ECS 中继 ──下行──> 主机        ← 手机上传走这条
 *                    实测 ECS → 主机 = 11 MB/s（限速卡的是主机**上行**，这里是下行）
 * ```
 *
 * 代价只是字节经 ECS 转一圈（主机侧出网，实测带宽充足），换来「任何主机、零配置可用」。
 *
 * ## 与直连的关系
 *
 * 两条路**共用同一套授权与落盘逻辑**：能力令牌同样由 `attachment.url`（mode=write）签发，
 * 收齐后同样走 `chat-attachment-store` 的内容寻址校验 / 去重 / 工作区降落。所以客户端的
 * 行为完全一致，只是把 `PUT` 换成了分片请求。
 *
 * 中继通道本身已经是 E2E 加密的，所以分片**不再**套一层应用层加密（那是给明文的 HTTP
 * 直连用的，见 `attachment-crypto.ts`）。
 */
import {
  abandonUpload,
  completeUploadedVideo,
  finalizeUploadedObject,
  materializeIntoWorkspace,
  writeUploadChunk,
} from "../chat-attachment-store";
import type { AttachmentTokenStore } from "./attachment-tokens";

export interface RelayUploadDeps {
  /** 与 HTTP 直连共用同一个令牌表。 */
  tokens: AttachmentTokenStore;
  /** 「降落到工作区」用：会话 → 工作目录（拿不到返回 null）。 */
  workspaceDirFor?: (threadId: string) => Promise<string | null>;
  /** 字节收齐并登记后回调（主机据此让会话快照认得这个附件）。 */
  onUploadComplete?: (info: { name: string; size: number; threadId: string; deviceId: string }) => void;
  log?: (line: string) => void;
}

export interface RelayUploadInput {
  /** `attachment.url`（mode=write）签发的写令牌。 */
  token: string;
  /** 本片在文件中的字节偏移 —— 与直连的 `Content-Range` 同语义。 */
  offset: number;
  /** 本片明文，base64（中继通道已加密，不再套应用层加密）。 */
  dataBase64: string;
  /** 客户端声明这是最后一片（总长不可知时靠它收尾）。 */
  last: boolean;
}

export interface RelayUploadResult {
  /** 已收字节数（累计）。 */
  received: number;
  done: boolean;
  /** 收齐时的成品名（内容寻址时是 key）。 */
  name?: string;
  size?: number;
  workspacePath?: string;
  workspaceName?: string;
}

/**
 * 收一片（或最后一片）。抛错即客户端可读的失败原因（service 层会包成 error envelope）。
 *
 * 分片临时文件的命名与直连保持一致（`part-<token>` 或附件名）——**两条路可以交替续传同一个
 * 令牌**，比如先直传几片、网络变了再走中继接着传。
 */
export async function uploadAttachmentChunk(
  deps: RelayUploadDeps,
  input: RelayUploadInput,
): Promise<RelayUploadResult> {
  const entry = deps.tokens.get(input.token);
  if (!entry || entry.mode !== "write") throw new Error("invalid or expired upload token");

  if (!Number.isFinite(input.offset) || input.offset < 0) throw new Error("offset must be a non-negative number");
  const plain = Buffer.from(String(input.dataBase64 ?? ""), "base64");
  if (plain.length === 0) throw new Error("chunk is empty");

  const total = entry.size ?? null;
  if (total !== null && input.offset + plain.length > total) throw new Error("chunk exceeds declared size");

  const partName = entry.sha256 ? `part-${entry.token}` : entry.name;
  entry.received = Math.max(entry.received, writeUploadChunk(partName, input.offset, plain));

  const done = input.last || (total !== null && entry.received >= total);
  deps.log?.(
    `attachment-relay chunk name=${entry.name.slice(0, 36)} off=${input.offset} len=${plain.length} cum=${entry.received}/${total ?? "?"}`,
  );
  if (!done) return { received: entry.received, done: false };

  // ---- 收齐：与 attachment-server 的 PUT 收尾逐条对齐 ----
  let finalName = entry.name;
  let finalSize = entry.received;
  if (entry.sha256) {
    // 内容寻址：主机自己算一遍落盘明文的 SHA-256 与客户端声明的比对，不符一律拒。
    const finalized = finalizeUploadedObject(partName, entry.sha256, {
      ...(entry.mimeType ? { mime: entry.mimeType } : {}),
      ...(entry.label ? { label: entry.label } : {}),
    });
    if (!finalized.ok) {
      abandonUpload(partName);
      deps.log?.(`attachment-relay rejected reason=${finalized.reason} expect=${entry.sha256.slice(0, 12)}`);
      throw new Error(finalized.reason === "checksum" ? "upload checksum mismatch" : "upload could not be finalized");
    }
    finalName = finalized.key;
    finalSize = finalized.size;
    deps.log?.(
      `attachment-relay done key=${finalized.key.slice(0, 16)} size=${finalized.size}${finalized.deduped ? " deduped=1" : ""}`,
    );
  } else {
    const completed = completeUploadedVideo(entry.name);
    if (!completed) {
      deps.log?.(`attachment-relay finalize failed name=${entry.name.slice(0, 36)}`);
      throw new Error("could not finalize upload");
    }
    finalSize = completed.size;
    deps.log?.(`attachment-relay done name=${entry.name.slice(0, 36)} size=${completed.size}`);
  }

  deps.onUploadComplete?.({ name: finalName, size: finalSize, threadId: entry.threadId, deviceId: entry.deviceId });

  // 「降落到工作区」：与直连一样用**令牌里的名字**（内容寻址时它就是 key）。
  let workspace: { abs: string; name: string } | null = null;
  if (entry.workspace) {
    const workspaceDir = (await deps.workspaceDirFor?.(entry.threadId)) || null;
    workspace = workspaceDir ? materializeIntoWorkspace({ name: entry.name, workspaceDir }) : null;
    deps.log?.(
      `attachment-relay workspace ${workspace ? `ok name=${workspace.name.slice(0, 40)}` : "failed"} thread=${entry.threadId}`,
    );
  }

  return {
    received: entry.received,
    done: true,
    name: finalName,
    size: finalSize,
    ...(workspace ? { workspacePath: workspace.abs, workspaceName: workspace.name } : {}),
  };
}
