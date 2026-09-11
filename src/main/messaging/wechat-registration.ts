import { getConfig, updateConfig } from "../config";
import * as ilink from "../weixin/ilink";
import { sanitizeWeChatConfig } from "./wechat-text";

/**
 * Personal-WeChat onboarding via iLink QR scan. The user scans the code with
 * mobile WeChat and confirms; the server issues a bot_token that is written
 * straight into config.json here in the main process — it never crosses IPC to
 * the renderer (same policy as Feishu registration).
 *
 * Flow: fetchQrCode → long-poll get_qrcode_status until "confirmed" (or up to
 * 3 QR refreshes on expiry). Some accounts require a numeric verification code
 * shown in WeChat; that round-trip is surfaced through events + submitVerifyCode.
 */

export interface WeChatRegQrReady {
  phase: "qr_ready";
  url: string;
}
export interface WeChatRegStatus {
  phase: "status";
  status: "polling" | "scanned";
}
export interface WeChatRegNeedVerifyCode {
  phase: "need_verifycode";
}
export interface WeChatRegSuccess {
  phase: "success";
  botId: string;
  userId?: string;
}
export interface WeChatRegError {
  phase: "error";
  code: string;
  description: string;
}
export type WeChatRegistrationEvent =
  | WeChatRegQrReady
  | WeChatRegStatus
  | WeChatRegNeedVerifyCode
  | WeChatRegSuccess
  | WeChatRegError;

const MAX_QR_REFRESH_COUNT = 3;
/** Overall onboarding deadline (QRs refresh a few times within it). */
const LOGIN_DEADLINE_MS = 15 * 60_000;

interface ActiveLogin {
  controller: AbortController;
  baseUrl: string; // effective polling host (may redirect)
  qrcode: string;
  pendingVerifyCode?: string;
}

let active: ActiveLogin | null = null;
/** Resolved when the renderer submits a verification code. */
let verifyCodeResolver: ((code: string) => void) | null = null;

export function startWeChatQrLogin(onEvent: (event: WeChatRegistrationEvent) => void): void {
  cancelWeChatQrLogin();
  const controller = new AbortController();
  active = { controller, baseUrl: "https://ilinkai.weixin.qq.com", qrcode: "" };

  void runLogin(controller.signal, onEvent).catch((err) => {
    if (controller.signal.aborted || active?.controller !== controller) return;
    const message = err instanceof Error ? err.message : String(err);
    console.error("[wechat] QR login failed:", message);
    onEvent({ phase: "error", code: "network", description: message });
  });
}

export function submitWeChatVerifyCode(code: string): void {
  const trimmed = code.trim();
  if (!trimmed) return;
  if (active) active.pendingVerifyCode = trimmed;
  verifyCodeResolver?.(trimmed);
  verifyCodeResolver = null;
}

/** Aborts an in-flight login. */
export function cancelWeChatQrLogin(): void {
  if (active) {
    try {
      active.controller.abort();
    } catch {
      // best effort
    }
    active = null;
  }
  verifyCodeResolver?.("");
  verifyCodeResolver = null;
}

async function runLogin(signal: AbortSignal, onEvent: (event: WeChatRegistrationEvent) => void): Promise<void> {
  const login = active!;
  const deadline = Date.now() + LOGIN_DEADLINE_MS;
  let qrRefreshCount = 0;
  let lastStatus: "polling" | "scanned" = "polling";

  let needNewQr = false;
  while (!signal.aborted && Date.now() < deadline) {
    // (Re)fetch the QR code.
    const qr = await ilink.fetchQrCode();
    if (signal.aborted) return;
    login.qrcode = qr.qrcode;
    needNewQr = false;
    onEvent({ phase: "qr_ready", url: qr.qrcode_img_content });

    while (!signal.aborted && Date.now() < deadline && !needNewQr) {
      const status = await ilink.pollQrStatus(login.baseUrl, login.qrcode, login.pendingVerifyCode, signal);
      if (signal.aborted) return;

      switch (status.status) {
        case "wait":
          break; // long-poll already waited; loop immediately

        case "scaned":
          if (login.pendingVerifyCode) login.pendingVerifyCode = undefined; // code accepted
          if (lastStatus !== "scanned") {
            lastStatus = "scanned";
            onEvent({ phase: "status", status: "scanned" });
          }
          break;

        case "need_verifycode": {
          onEvent({ phase: "need_verifycode" });
          // Wait for the user to type the code shown in WeChat.
          const code = await new Promise<string>((resolve) => {
            verifyCodeResolver = resolve;
          });
          if (signal.aborted) return;
          login.pendingVerifyCode = code || undefined;
          continue; // poll immediately with the submitted code
        }

        case "expired":
        case "verify_code_blocked": {
          qrRefreshCount++;
          if (qrRefreshCount > MAX_QR_REFRESH_COUNT) {
            onEvent({ phase: "error", code: "qr_exhausted", description: "二维码多次失效，连接流程已停止。请稍后再试。" });
            return;
          }
          login.pendingVerifyCode = undefined;
          lastStatus = "polling";
          needNewQr = true; // exit the poll loop → outer loop fetches a fresh QR
          break;
        }

        case "scaned_but_redirect": {
          if (status.redirect_host) {
            login.baseUrl = `https://${status.redirect_host}`;
          }
          break;
        }

        case "binded_redirect": {
          onEvent({ phase: "error", code: "already_bound", description: "该微信已绑定过，请先在其它设备/应用上解绑后再试。" });
          return;
        }

        case "confirmed": {
          if (!status.ilink_bot_id || !status.bot_token) {
            onEvent({ phase: "error", code: "bad_response", description: "登录成功但服务器未返回完整凭证，请重试。" });
            return;
          }
          // Persist credentials locally only — the token never reaches the renderer.
          const current = sanitizeWeChatConfig(getConfig().wechatChannel);
          updateConfig({
            wechatChannel: {
              ...current,
              botToken: status.bot_token.trim(),
              botId: status.ilink_bot_id.trim(),
              baseUrl: (status.baseurl || "https://ilinkai.weixin.qq.com").trim(),
              userId: (status.ilink_user_id ?? "").trim(),
              getUpdatesBuf: undefined, // fresh login → fresh cursor
            },
          });
          onEvent({ phase: "success", botId: status.ilink_bot_id.trim(), userId: status.ilink_user_id?.trim() || undefined });
          return;
        }
      }

      await sleep(1000, signal);
    }
  }

  if (!signal.aborted) {
    onEvent({ phase: "error", code: "timeout", description: "登录超时，请重试。" });
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    const onAbort = () => {
      clearTimeout(t);
      done();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
