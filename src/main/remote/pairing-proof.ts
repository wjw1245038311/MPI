/**
 * 配对证明（pairing proof）——把 **E2E 公钥绑进签名**，让中继无法换公钥做 MITM。
 *
 * 背景（2026-09-30 审计，见 docs/RELAY-SHARING.md §9）：内容层是 AES-GCM，但签名覆盖的文本是
 * `mpi-remote-v1|hostId|connectionId|challenge|deviceId` —— **不含任何 X25519 公钥**。而
 *   · 主机的 X25519 公钥是在 `pair.accepted`（**明文帧**）里注入的；
 *   · 设备的 X25519 公钥走 `pair.hello`（明文）且不在签名内。
 * ⇒ 一个不可信的中继可以把**自己的**公钥分别塞给两端，各自派生会话密钥，从而解开全部「加密」流量。
 *
 * v2 的做法：双方各自把**自己的** X25519 公钥写进被签名的文本：
 *   · 主机（在 pair.challenge 里）：`mpi-remote-v2-host|<hostId>|<connectionId>|<challenge>|<hostX25519Pub>`
 *   · 设备（在 pair.hello 里）：  `mpi-remote-v2-device|<hostId>|<connectionId>|<challenge>|<deviceId>|<deviceX25519Pub>`
 * 于是「换公钥」必然要伪造签名 —— 中继没有双方的 Ed25519 私钥，做不到。
 *
 * v1 仍然认识（只为兼容）：**但带 E2E 公钥却用 v1 签名的客户端一律拒绝**，否则中继只要把
 * `x25519Pub` 塞进一个 v1 客户端就完成降级。唯一的例外是显式设了
 * `MPI_ALLOW_UNBOUND_E2E=1`（旧客户端救急；会留下一条明确的诊断日志）。
 *
 * 抽成纯函数模块的原因：这是安全边界，必须能被单测钉住（尤其「公钥替换」那一条）。
 */
import { verifyText } from "./identity";

export interface HostProofInput {
  hostId: string;
  connectionId: string;
  challenge: string;
  hostX25519Pub: string;
}

export interface DeviceProofInput {
  hostId: string;
  connectionId: string;
  challenge: string;
  deviceId: string;
  deviceX25519Pub: string;
}

/** v2 主机证明文本（含主机 E2E 公钥）。 */
export const hostProofText = (input: HostProofInput): string =>
  `mpi-remote-v2-host|${input.hostId}|${input.connectionId}|${input.challenge}|${input.hostX25519Pub}`;

/** v2 设备证明文本（含设备 E2E 公钥）。 */
export const deviceProofText = (input: DeviceProofInput): string =>
  `mpi-remote-v2-device|${input.hostId}|${input.connectionId}|${input.challenge}|${input.deviceId}|${input.deviceX25519Pub}`;

/** v1 主机证明文本（不含公钥；只为识别旧客户端）。 */
export const legacyHostProofText = (input: Omit<HostProofInput, "hostX25519Pub">): string =>
  `mpi-remote-v1|${input.hostId}|${input.connectionId}|${input.challenge}`;

/** v1 设备证明文本（不含公钥；只为识别旧客户端）。 */
export const legacyDeviceProofText = (input: Omit<DeviceProofInput, "deviceX25519Pub">): string =>
  `mpi-remote-v1|${input.hostId}|${input.connectionId}|${input.challenge}|${input.deviceId}`;

export type DeviceProofMode = "bound" | "legacy";

export interface DeviceProofResult {
  ok: boolean;
  /** bound = 公钥已被签名覆盖（安全）；legacy = 旧客户端（无 E2E 或救急开关）。 */
  mode: DeviceProofMode;
  /** 拒绝/降级的原因（写进诊断日志用）。 */
  reason?: string;
}

/** 救急开关：允许「带公钥但只签了 v1」的旧客户端配对（会记录日志）。 */
export const allowUnboundE2E = (): boolean => process.env.MPI_ALLOW_UNBOUND_E2E === "1";

/**
 * 校验设备的 `pair.hello` 证明。
 *
 * @param deviceX25519Pub 设备在 hello 里声明的 E2E 公钥（可能为空 = 旧客户端，无 E2E）
 */
export function verifyDeviceProof(args: {
  publicKeyPem: string;
  signature: string;
  proof: DeviceProofInput;
}): DeviceProofResult {
  const { publicKeyPem, signature, proof } = args;
  if (!publicKeyPem || !signature) return { ok: false, mode: "legacy", reason: "missing-identity" };

  if (proof.deviceX25519Pub) {
    if (verifyText(publicKeyPem, deviceProofText(proof), signature)) return { ok: true, mode: "bound" };
    if (verifyText(publicKeyPem, legacyDeviceProofText(proof), signature)) {
      // 带公钥却没绑进签名 —— 中继换公钥就成功了；默认拒绝。
      if (allowUnboundE2E()) return { ok: true, mode: "legacy", reason: "unbound-e2e-allowed" };
      return { ok: false, mode: "legacy", reason: "e2e-key-not-signed" };
    }
    return { ok: false, mode: "legacy", reason: "signature-invalid" };
  }

  // 没声明 E2E 公钥（旧客户端）：只能走 v1；是否接受由调用方按 allowUnboundE2E 决定。
  if (verifyText(publicKeyPem, legacyDeviceProofText(proof), signature)) {
    return allowUnboundE2E()
      ? { ok: true, mode: "legacy", reason: "legacy-client" }
      : { ok: false, mode: "legacy", reason: "legacy-client-rejected" };
  }
  return { ok: false, mode: "legacy", reason: "signature-invalid" };
}

/**
 * 设备侧：校验主机在 `pair.challenge` 里给的证明，并返回被签名覆盖的主机 E2E 公钥。
 *
 * 返回 null 表示**签名没通过**（此时绝不能用 challenge/accepted 里的任何公钥——那正是中继想让你干的事）。
 * 手机端必须用这个函数的结果来决定 `hostX25519Pub`，而不是信 `pair.accepted` 里送来的那个。
 */
export function verifyHostProof(args: {
  publicKeyPem: string;
  signature: string;
  proof: Omit<HostProofInput, "hostX25519Pub">;
  declaredX25519Pub: string;
}): { mode: DeviceProofMode } | null {
  const { publicKeyPem, signature, proof, declaredX25519Pub } = args;
  if (!publicKeyPem || !signature || !declaredX25519Pub) return null;
  if (verifyText(publicKeyPem, hostProofText({ ...proof, hostX25519Pub: declaredX25519Pub }), signature)) {
    return { mode: "bound" };
  }
  if (allowUnboundE2E() && verifyText(publicKeyPem, legacyHostProofText(proof), signature)) {
    return { mode: "legacy" };
  }
  return null;
}
