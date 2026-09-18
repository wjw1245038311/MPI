---
domain: FeishuMessaging
tags: [feishu, lark, websocket, remote-channel, messaging]
source: manual
---

# Feishu Messaging Domain

End-to-end flow of the Feishu (Lark) channel: from WebSocket event push to pi agent job execution and streaming reply. Spans `src/main/messaging/` (channel layer) into the main-process agent session layer.

## Context

- **Module paths:** `src/main/messaging/service.ts`, `src/main/messaging/channel-base.ts`, `src/main/messaging/feishu-text.ts`
- **Dependencies:** Lark SDK WSClient, app config store (`getConfig().feishuChannel`), pi agent session via the main-process IPC layer
- **Consumers:** app bootstrap calls `initMessaging`; settings UI starts/stops and reconfigures the channel

## Architecture

```
ChannelBase<S> (channel-base.ts)          abstract: config merge, status, job slot,
  |                                        command dispatch, runAgentTurn driver
  +-- FeishuMessagingService (service.ts) Lark WSClient lifecycle, handleIncoming,
  |                                      dedupe, text parse, runJob streaming
  +-- WeChat service (wechat-service.ts)  separate channel, same base contract
feishu-text.ts: parseTextContent / stripMentions   command-parse.ts: slash commands
```

## Data Flow

```
Lark cloud --WS push--> Lark.WSClient (EventDispatcher "im.message.receive_v1")
  --> FeishuMessagingService.handleIncoming(data)      [fire-and-forget; must ack within ~3s]
      - dedupe by message_id (seen set, reconnect re-push protection)
      - drop non-user senders (bot-to-bot traffic)
      - parseTextContent + stripMentions
  --> ChannelBase.dispatchCommand(text, reply)         [/start /stop etc.; true = handled]
  --> FeishuMessagingService.runJob(messageId, text)   [one job at a time; else "busy"]
      - ack reply ("thinking…")
      - runAgentTurn({ack, text, onSnapshot, deliver}) [ChannelBase drives the pi agent session]
          - onSnapshot -> throttled streaming update (STREAM_UPDATE_INTERVAL_MS), serialized via updateChain
          - deliver -> final reply; if finalize fails, fall back to a new message
```

## Key Claims

- [extracted] `FeishuMessagingService` is defined at `src/main/messaging/service.ts` and owns the Lark WebSocket lifecycle (start/stop/status).
- [extracted] `initMessaging` is defined at `src/main/messaging/service.ts` and is the single entry point that boots the channel from app config.
- [inferred] The WS event handler never awaits work because Feishu re-pushes events not acked within ~3s; all real processing is detached into handleIncoming/runJob.
- [inferred] Streaming updates are serialized through a promise chain (updateChain) so a slow in-flight update can never overwrite a newer snapshot — that race previously made replies look "swallowed".

## Boundaries

- This domain does **not** cover the WeChat channel (`wechat-service.ts` has its own runJob/handleIncoming).
- Does not cover pi agent session internals (main-process IPC/bridge) — only how the channel drives it via `runAgentTurn`.
- Command parsing details live in `command-parse.ts`, not here.

## Evidence

- `FeishuMessagingService` defined at `src/main/messaging/service.ts`
- `initMessaging` defined at `src/main/messaging/service.ts`
- `handleIncoming` defined at `src/main/messaging/service.ts`
- `runJob` defined at `src/main/messaging/service.ts`
- `dispatchCommand` defined at `src/main/messaging/channel-base.ts`
- `parseTextContent` defined at `src/main/messaging/feishu-text.ts`
