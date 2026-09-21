# mem0 Bridge Server 本机部署手册（workstation）

> 记录 mem0 bridge 服务（:8000）在本机（workstation）的部署方式。
> 现状：2026-09-21 已停服（P5-5 退役），数据目录保留为只读归档；再部署照本手册执行即可。

## 1. 是什么 / 前置依赖

FastAPI + mem0ai **库模式**包一层 REST：把本机 LLM、embedding、嵌入式 Qdrant 组成记忆服务，客户端（pi-mem0-local 插件）经 `baseUrl` + `userId` 接入。

| 组件 | 地址/路径 | 用途 |
|---|---|---|
| LM Studio | `127.0.0.1:1234/v1`，模型 `qwen3.8-27b@q5_k_m` | LLM（记忆抽取） |
| llama-server | `127.0.0.1:1235/v1`，模型 `bge-base-zh-v1.5`（768 维） | embedding；看门狗 = 计划任务 `Mem0Embedding` |
| Python | `E:\MyWorkspace\Software\Python\python.exe` | 解释器；依赖 mem0ai / fastapi / uvicorn / qdrant_client |

两个前置服务必须先起来（各自有看门狗，一般开机自恢复）。

## 2. 部署步骤

### Step 1 · server 代码

`mem0_server.py` 放 `E:\MyWorkspace\Work\mem0-data\`。CONFIG 关键项：

```python
"llm":      lmstudio, model=qwen3.8-27b@q5_k_m, base_url=http://localhost:1234/v1, max_tokens=8192
"embedder": lmstudio, model=bge-base-zh-v1.5,   base_url=http://localhost:1235/v1, dims=768
"vector_store": qdrant 嵌入式, collection=mem0, path=E:\MyWorkspace\Work\mem0-data\qdrant
disable_telemetry=True
```

另有护栏：infer 入参 >16000 字符截尾（防远端设备长对话抽取超时）。数据目录 `qdrant/` 首次运行自动创建；复用现有归档时直接沿用该目录。

### Step 2 · 装依赖

mem0ai 用本地 wheel（`Work/mem0-data/mem0ai-3.1.7.tgz`，免外网），其余走 uv：

```bash
uv pip install --python E:/MyWorkspace/Software/Python/python.exe \
  fastapi uvicorn qdrant_client E:/MyWorkspace/Work/mem0-data/mem0ai-3.1.7.tgz
```

### Step 3 · 启动脚本

`E:\MyWorkspace\Agent\AgentSetting\scripts\startup\start-mem0-server.sh`（版本化在 AgentSetting 仓）。要点：

1. **先 unset 所有代理变量**——2026-09-18 的坑：uvicorn 继承控制台里的 v2rayN 代理（127.0.0.1:10808）后，httpx 连 localhost:1234/1235 也走代理，v2rayN 一停 mem0 全挂；
2. `export NO_PROXY="localhost,127.0.0.1,.local,10.*,workstation.tail38d5a.ts.net"` 兜底；
3. `exec python -m uvicorn mem0_server:app --host 0.0.0.0 --port 8000`，日志追加到同目录 `mem0_server.log` / `.log.err`。

### Step 4 · 看门狗计划任务

脚本 `watchdog-mem0-server.sh`（同目录）：`/health`=200 → 静默退出；否则清掉占用 :8000 的残留 python 进程 → **detached**（nohup）拉起启动脚本 → 等健康最多 60s，全程写 `mem0-watchdog.log`。

注册任务（定义文件 `Mem0Server.task.xml` 同目录；SYSTEM、系统启动触发 + 每 5 分钟重复）：

```bash
MSYS_NO_PATHCONV=1 schtasks /create /tn Mem0Server /xml <Mem0Server.task.xml 转 UTF-16 后> /f
```

⚠️ 任务动作**绝不 exec 服务进程**——计划任务有运行时长上限，exec 会让服务被连带杀掉；必须 detached 子进程方式启动。

### Step 5 · 验证

```bash
curl http://127.0.0.1:8000/health          # → {"status":"ok"}
# 写读测试（用后即删）：
curl -X POST http://127.0.0.1:8000/v1/memories -H 'Content-Type: application/json' \
     -d '{"text":"部署自检","userId":"deploy-test"}'   # → Stored 1 memory item(s)
curl "http://127.0.0.1:8000/v1/memories?query=部署自检&user_id=deploy-test"
curl -X DELETE "http://127.0.0.1:8000/v1/memories?user_id=deploy-test"
```

## 3. 日常操作

| 操作 | 命令（Git Bash） |
|---|---|
| 停服 | `MSYS_NO_PATHCONV=1 schtasks /change /tn "Mem0Server" /disable`，再 `taskkill /PID <pid> /T /F`（PID = `netstat -ano \| grep :8000`） |
| 起服 | `schtasks /change /tn "Mem0Server" /enable`（≤5 分钟自动拉起），或手动跑 Step 3 启动脚本立即起 |
| 日志 | `Work/mem0-data/mem0_server.log(.err)`、`mem0-watchdog.log`（自截断 500 行） |
| 全量导出 | `python scripts/mem0-export.py`（MPI 仓；先复制 qdrant 副本再读，输出 JSONL） |

## 4. 已知坑

1. **代理继承**：不要从带 v2rayN 代理变量的控制台直接起 uvicorn——一律走 Step 3 启动脚本。
2. **Qdrant 单写者锁**：服务运行期 `qdrant/.lock` 被占，离线读取会 AlreadyLocked；先复制目录（可跳过 `.lock`）再打开副本。
3. **`GET /v1/memories/all` 默认 top_k=20**，取不全——全量必须直读库（mem0-export.py）。
4. **看门狗不 exec 服务进程**（见 Step 4 ⚠️）。
