/**
 * MPI Mobile PWA — pairing view (S2.4). Home/thread views land in S4/S5.
 * Flow: paste mpi://pair link → relay WSS → pair.request → challenge → signed
 * hello → desktop approves → deviceToken stored; reconnects re-auth via hello.
 */
import { useEffect, useRef, useState } from "react";
import { IdbKeyStore } from "./lib/keystore-idb";
import type { KeyStore, PairingRecord } from "./lib/keystore";
import { createDeviceIdentity, randomSeedB64url } from "./lib/device-identity";
import { parsePairingLink, reauthenticate, runPairing, type PairingStage } from "./lib/pairing";
import { RelayClient } from "./lib/relay-client";

const STAGE_LABELS: Record<string, string> = {
  idle: "未连接",
  connecting: "连接中继…",
  open: "已连接",
  closed: "已断开",
  "waiting-challenge": "等待主机挑战…",
  "waiting-approval": "等待桌面端批准…（在 Windows 的 RemotePanel 点「允许」）",
  approved: "配对成功",
  error: "出错",
};

export default function App() {
  const storeRef = useRef<KeyStore>(new IdbKeyStore());
  const clientRef = useRef<RelayClient | null>(null);
  const [link, setLink] = useState("");
  const [stage, setStage] = useState<string>("idle");
  const [error, setError] = useState<string | null>(null);
  const [hostId, setHostId] = useState<string | null>(null);
  const [connState, setConnState] = useState("idle");

  // Auto-reconnect on load when a pairing with a stored token exists.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const device = await storeRef.current.getDevice();
        if (!device) return;
        const pairings = await storeRef.current.listPairings();
        const target = pairings.find((p) => p.deviceToken);
        if (!target || cancelled) return;
        startSession(target, device.seedB64url, device.name);
      } catch { /* storage unavailable */ }
    })();
    return () => {
      cancelled = true;
      clientRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** (Re)connect to a stored pairing and re-authenticate. */
  const startSession = (record: PairingRecord, seedB64url: string, name: string) => {
    clientRef.current?.close();
    const identity = createDeviceIdentity(seedB64url);
    const client = new RelayClient({ url: record.relayUrl, onStateChange: (s) => setConnState(s) });
    clientRef.current = client;
    setHostId(record.hostId);
    setError(null);
    if (!record.deviceToken) return;
    client.setHelloCreds(identity.deviceId, record.deviceToken);
    client.connect();
    // After the relay accepts the hello, the host issues a fresh challenge.
    void reauthenticate(client, record.hostId, identity, name).catch((e: Error) => setError(e.message));
  };

  const startPairing = async () => {
    let payload;
    try {
      payload = parsePairingLink(link);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    if (!payload.relayUrl) {
      setError("链接中没有中继地址（relayUrl）——请用桌面端生成的新版配对链接");
      return;
    }
    let device = await storeRef.current.getDevice();
    if (!device) {
      device = { seedB64url: randomSeedB64url(), name: "MPI PWA" };
      await storeRef.current.saveDevice(device);
    }
    const identity = createDeviceIdentity(device.seedB64url);

    clientRef.current?.close();
    const client = new RelayClient({ url: payload.relayUrl, onStateChange: (s) => setConnState(s) });
    clientRef.current = client;
    setError(null);
    try {
      const result = await runPairing(client, payload, identity, device.name, (s: PairingStage) => setStage(s));
      await storeRef.current.savePairing({
        hostId: payload.hostId,
        relayUrl: payload.relayUrl!,
        deviceId: identity.deviceId,
        deviceToken: result.deviceToken || null,
        pairedAt: Date.now(),
      });
      if (result.deviceToken) client.setHelloCreds(identity.deviceId, result.deviceToken);
      setHostId(payload.hostId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage("error");
    }
  };

  const disconnect = () => {
    clientRef.current?.close();
    setConnState("closed");
    setHostId(null);
    setStage("idle");
    setError(null);
  };

  return (
    <div className="app">
      <header className="app-header">
        <span className="app-logo" aria-hidden="true">M</span>
        <h1>MPI Mobile</h1>
      </header>
      <main className="app-main">
        {hostId ? (
          <div className="card">
            <div style={{ fontWeight: 600 }}>主机 {hostId}</div>
            <div className="status-line" aria-live="polite">
              <span className={`dot ${connState === "open" ? "ok" : connState === "closed" || stage === "error" ? "err" : ""}`} />
              {STAGE_LABELS[stage] ?? STAGE_LABELS[connState] ?? connState}
            </div>
            {error && <p className="hint" style={{ color: "var(--err)" }}>{error}</p>}
            <button onClick={disconnect}>断开</button>
          </div>
        ) : (
          <div className="card">
            <p style={{ margin: "0 0 10px" }}>粘贴桌面端生成的配对链接（mpi://pair?…）开始配对。</p>
            <textarea rows={4} value={link} onChange={(e) => setLink(e.target.value)} placeholder="mpi://pair?payload=…" spellCheck={false} />
            <div style={{ marginTop: 10 }}>
              <button onClick={() => void startPairing()} disabled={!link.trim() || stage === "connecting" || stage === "waiting-challenge" || stage === "waiting-approval"}>
                {stage === "waiting-approval" ? "等待批准…" : "连接并配对"}
              </button>
            </div>
            {(stage !== "idle" || error) && (
              <div className="status-line" aria-live="polite">
                <span className={`dot ${stage === "approved" ? "ok" : stage === "error" ? "err" : ""}`} />
                {STAGE_LABELS[stage] ?? stage}
                {error && <span style={{ color: "var(--err)" }}> · {error}</span>}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
