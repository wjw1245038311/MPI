# mpi-pwa — MPI 手机版（React PWA）

设计文档：[`docs/MOBILE-DESIGN.md`](../../docs/MOBILE-DESIGN.md) §6。

与桌面端同栈（Vite + React + TS）。经自建云中继（`mobile/relay`）连接 Windows
主机；协议类型来自 [`../shared/protocol.ts`](../shared/protocol.ts)（桌面
`src/main/remote/protocol.ts` 的 vendored copy，等价性由 `npm test -- pwa-shared` 守护）。

## 运行 / 构建

```bash
cd mobile/pwa && npm install
npm run dev      # http://localhost:5173
npm run build    # tsc + vite → dist/（静态文件，S8 随 relay 同机 serve）
```

## 结构

- `src/lib/relay-client.ts` — WSS 客户端核心（浏览器/Node 原生 WebSocket 通用；
  hello 重连凭据、指数退避自动重连、帧订阅）。**先订阅 onFrame 再 connect()，
  否则可能丢帧。**
- `src/lib/device-identity.ts` — noble Ed25519 身份：SPKI PEM / deviceId 派生与
  桌面 identity.ts **字节兼容**（e2e 测试守护）。
- `src/lib/pairing.ts` — mpi://pair 链接解析 + 配对/重认证编排。
- `src/lib/keystore*.ts` — IndexedDB 持久化（设备 seed、每主机 token）。

## 测试

```bash
npm test -- pwa        # 仓库根目录：pwa-shared（协议等价）+ pwa-pairing（全链路 e2e）
```
