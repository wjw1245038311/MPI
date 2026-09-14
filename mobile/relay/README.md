# mpi-relay — MPI 手机版云中继（S0 原型）

设计文档：[`docs/MOBILE-DESIGN.md`](../../docs/MOBILE-DESIGN.md) §3/§4.3/§12.4。

无业务逻辑的不透明帧路由器：Windows host uplink ↔ 手机 PWA socket。
**不解析、不解密、不落盘应用帧**（protocol v1 envelope，后续为 `{e,n,c}` E2E 密文）；
中继可见的只有 hostId / deviceId / 在线状态等路由元数据。

## 运行

```bash
cd mobile/relay && npm install
npm start                      # ws://0.0.0.0:9001/ws + http GET /healthz
RELAY_PORT=8443 RELAY_HOST=0.0.0.0 npm start
```

环境变量：`RELAY_PORT`（默认 9001，0=临时端口）、`RELAY_HOST`、
`RELAY_PING_MS`（默认 20000）、`RELAY_DEAD_MS`（默认 60000）。

## 帧协议（S0 明文骨架）

同一 WSS socket 上按 `type` 区分控制帧与应用数据帧。

| type | 方向 | 说明 |
| --- | --- | --- |
| `host.register` `{hostId}` | host→relay | 首帧；重复注册替换旧 uplink（旧端收 `replaced` + close 4006） |
| `ticket.register` `{ticket, expiresAt?}` | host→relay | 配对票据上报，默认 TTL 5min、一次性 |
| `pair.approved` `{deviceId, deviceToken}` | host→relay | 批准配对：绑定 deviceId↔hostId 并存 token（供 hello 重连） |
| `device.revoke` `{deviceId}` | host→relay | 撤销设备：删路由，在线端收 `revoked` + close 4002 |
| `push.request` | host→relay | S7 WebPush；S0 回 `PUSH_NOT_CONFIGURED` |
| `hello` `{deviceId, deviceToken}` | device→relay | 首帧；token 匹配即绑定，替换旧 socket |
| `pair.request` `{ticket, deviceId, name?}` | device→relay | 首帧；按 ticket 原样转发给对应 host uplink（S1 映射进 RemoteHost.handleHello） |
| 数据帧（其余一切） | 双向 | device→绑定 host 直接转；host→device 必须带明文 `to: "<deviceId>"`，整对象原样透传 |

relay → 端 的控制回复：`relay.ok` / `relay.error {code}` / `offline {who, hostId|deviceId}` /
`revoked` / `replaced`。错误码：`INVALID_JSON`、`NO_ROUTE`、`UNKNOWN_DEVICE`、
`DEVICE_OFFLINE`、`HOST_OFFLINE`、`NOT_AUTHENTICATED`、`TICKET_INVALID`、`TICKET_EXPIRED`、
`INVALID_TICKET`、`INVALID_TOKEN`、`TICKET_TABLE_FULL`、`PAYLOAD_TOO_LARGE`(2MB)。

心跳：relay 每 `RELAY_PING_MS` ping，连续 `RELAY_DEAD_MS/PING_MS` 次无 pong → terminate；
socket close 时清路由并向对端发 `offline`。被替换的旧 socket 关闭**不**触发 offline。

## 测试

```bash
npm run test:relay-s0          # 仓库根目录执行（scripts/test-relay-s0.mjs）
```

覆盖 S0.1-S0.3 全部验收点，见 `tests/registry/logic-relay.json`。
