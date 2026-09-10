import * as Lark from "@larksuiteoapi/node-sdk";
import { getConfig, updateConfig } from "../config";
import { sanitizeFeishuConfig } from "./feishu-text";

/**
 * One-click Feishu app creation via QR scan (official node-sdk `registerApp`,
 * OAuth 2.0 Device Authorization Grant / RFC 8628). The user scans the
 * verification URL with mobile Feishu and confirms; the platform creates a
 * self-built bot app under their tenant and returns App ID + Secret directly
 * to this process — no developer-console steps, no vendor backend involved.
 *
 * Security: the returned secret is written straight into config.json here in
 * the main process and never crosses IPC to the renderer (same policy as
 * manual entry). The success event only carries client_id + user info.
 */

export interface RegistrationQrReady {
  phase: "qr_ready";
  url: string;
  /** Seconds until the verification URL expires. */
  expireIn: number;
}
export interface RegistrationStatus {
  phase: "status";
  status: "polling" | "slow_down" | "domain_switched";
}
export interface RegistrationSuccess {
  phase: "success";
  clientId: string;
  openId?: string;
  tenantBrand?: "feishu" | "lark";
}
export interface RegistrationError {
  phase: "error";
  /** access_denied | expired_token | abort | ... */
  code: string;
  description: string;
}
export type RegistrationEvent = RegistrationQrReady | RegistrationStatus | RegistrationSuccess | RegistrationError;

let controller: AbortController | null = null;

/**
 * Starts a fresh registration flow (cancelling any in-flight one). Events are
 * delivered via `onEvent`; the promise-based SDK result is folded into them.
 */
export function startAppRegistration(onEvent: (event: RegistrationEvent) => void): void {
  cancelAppRegistration();
  const c = new AbortController();
  controller = c;

  Lark.registerApp({
    signal: c.signal,
    source: "mpi",
    appPreset: {
      name: "MPI 智能助手",
      desc: "由 MPI 桌面端自动创建，用于在飞书里与本地 MPI 会话对话。",
    },
    // Additive on top of the platform base template (bot capability + common
    // agent scopes). If the tenant's gray-scale ignores addons, the default
    // template still covers single/group chat receive/send.
    addons: {
      scopes: {
        tenant: ["im:message.p2p_msg:readonly", "im:message.group_at_msg:readonly", "im:message:send_as_bot"],
      },
      events: { items: { tenant: ["im.message.receive_v1"] } },
    },
    // Always create a new app — never let the flow overwrite an existing one.
    createOnly: true,
    onQRCodeReady: (info) => {
      if (controller !== c) return;
      onEvent({ phase: "qr_ready", url: info.url, expireIn: info.expireIn });
    },
    onStatusChange: (info) => {
      if (controller !== c) return;
      onEvent({ phase: "status", status: info.status });
    },
  })
    .then((result) => {
      controller = null;
      // Persist credentials locally only — the secret never reaches the renderer.
      const current = sanitizeFeishuConfig(getConfig().feishuChannel);
      updateConfig({
        feishuChannel: { ...current, appId: result.client_id.trim(), appSecret: result.client_secret.trim() },
      });
      onEvent({
        phase: "success",
        clientId: result.client_id,
        openId: result.user_info?.open_id,
        tenantBrand: result.user_info?.tenant_brand,
      });
    })
    .catch((err: unknown) => {
      controller = null;
      if (c.signal.aborted) return; // user cancelled — nothing to report
      const e = err as { code?: string; description?: string; message?: string };
      onEvent({ phase: "error", code: e?.code ?? "unknown", description: e?.description || e?.message || String(err) });
    });
}

/** Aborts an in-flight registration (QR expires naturally otherwise). */
export function cancelAppRegistration(): void {
  if (!controller) return;
  try {
    controller.abort();
  } catch {
    // best effort
  }
  controller = null;
}
