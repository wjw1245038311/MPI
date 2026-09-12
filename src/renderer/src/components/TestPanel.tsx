import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  LogicRunResult,
  RegistryScan,
  ScenarioHistoryEntry,
  ScenarioRunResult,
  TestRegistryCase,
  TestRunLogLine,
} from "../lib/types";

/**
 * 功能测试面板（dev-only，从标题栏「开发工具 → 自动化测试」打开）。
 *
 * 数据源：
 *  - 注册表 tests/registry/*.json（主进程解析，经 tests:list）
 *  - logic 用例：跑 L1（tests:runLogic），输出流式
 *  - scenario 用例：跑 harness（tests:runScenario），产物渲染成模拟对话
 *
 * 文案中文、不走 i18n（与其它 dev 工具一致）。
 */

type TBlock = { kind: "user" | "assistant" | "note"; text: string };

function parseTranscript(text: string): TBlock[] {
  const blocks: TBlock[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("### USER")) blocks.push({ kind: "user", text: "" });
    else if (line.startsWith("### ASSISTANT")) blocks.push({ kind: "assistant", text: "" });
    else if (line.startsWith("[")) blocks.push({ kind: "note", text: line });
    else {
      const last = blocks[blocks.length - 1];
      if (last) last.text += (last.text ? "\n" : "") + line;
    }
  }
  return blocks.map((b) => ({ ...b, text: b.text.trim() })).filter((b) => b.text.length > 0);
}

function statusLabel(result: ScenarioRunResult): string {
  switch (result.status) {
    case "pass":
      return "通过";
    case "fail":
      return "失败";
    case "timeout":
      return "超时";
    case "error":
      return "错误";
    default:
      return "无结果";
  }
}

export function TestPanel() {
  const [scan, setScan] = useState<RegistryScan | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [logs, setLogs] = useState<Record<string, string[]>>({});
  const [logicResults, setLogicResults] = useState<Record<string, LogicRunResult>>({});
  const [scenarioResults, setScenarioResults] = useState<Record<string, ScenarioRunResult>>({});
  const [history, setHistory] = useState<ScenarioHistoryEntry[]>([]);
  const logRef = useRef<HTMLPreElement | null>(null);

  const loadHistory = useCallback(() => {
    window.pi.tests
      .history()
      .then(setHistory)
      .catch(() => undefined);
  }, []);

  // 载入注册表
  useEffect(() => {
    let alive = true;
    window.pi.tests
      .list()
      .then((res) => {
        if (!alive) return;
        setScan(res);
        setSelectedId((cur) => cur ?? res.cases[0]?.id ?? null);
      })
      .catch((e: unknown) => {
        if (alive) setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  // 订阅流式日志
  useEffect(() => {
    return window.pi.on.testLog((p: TestRunLogLine) => {
      setLogs((cur) => ({ ...cur, [p.caseId]: [...(cur[p.caseId] ?? []), p.line] }));
    });
  }, []);

  // 载入历史汇总（scenario 用例展示）
  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  // 选中 scenario 用例时，尝试载入最近一次产物
  const selected = useMemo(
    () => scan?.cases.find((c) => c.id === selectedId) ?? null,
    [scan, selectedId],
  );

  useEffect(() => {
    if (!selected || selected.kind !== "scenario" || !selected.harnessCaseId) return;
    if (scenarioResults[selected.id]) return;
    let alive = true;
    window.pi.tests
      .readResult({ harnessCaseId: selected.harnessCaseId })
      .then((res) => {
        if (alive && res.transcript) setScenarioResults((cur) => ({ ...cur, [selected.id]: res }));
      })
      .catch(() => {
        /* 无历史产物属正常 */
      });
    return () => {
      alive = false;
    };
  }, [selected, scenarioResults]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs, runningId]);

  const grouped = useMemo(() => {
    const map = new Map<string, TestRegistryCase[]>();
    for (const c of scan?.cases ?? []) {
      const arr = map.get(c.feature) ?? [];
      arr.push(c);
      map.set(c.feature, arr);
    }
    return [...map.entries()];
  }, [scan]);

  const runLogic = useCallback(async (c: TestRegistryCase) => {
    if (!c.logicTest) return;
    setRunningId(c.id);
    setLogs((cur) => ({ ...cur, [c.id]: [] }));
    try {
      const res = await window.pi.tests.runLogic({ caseId: c.id, logicTest: c.logicTest });
      setLogicResults((cur) => ({ ...cur, [c.id]: res }));
    } catch (e: unknown) {
      setLogicResults((cur) => ({
        ...cur,
        [c.id]: { ok: false, exitCode: null, output: e instanceof Error ? e.message : String(e) },
      }));
    } finally {
      setRunningId(null);
    }
  }, []);

  const runScenario = useCallback(async (c: TestRegistryCase) => {
    if (!c.harnessCaseId) return;
    setRunningId(c.id);
    setLogs((cur) => ({ ...cur, [c.id]: [] }));
    try {
      const res = await window.pi.tests.runScenario({ caseId: c.id, harnessCaseId: c.harnessCaseId });
      setScenarioResults((cur) => ({ ...cur, [c.id]: res }));
      loadHistory();
    } catch (e: unknown) {
      setScenarioResults((cur) => ({
        ...cur,
        [c.id]: {
          ok: false,
          status: "error",
          exitCode: null,
          result: null,
          transcript: null,
          error: e instanceof Error ? e.message : String(e),
        },
      }));
    } finally {
      setRunningId(null);
    }
  }, []);

  const logicResult = selected ? logicResults[selected.id] : undefined;
  const scenarioResult = selected ? scenarioResults[selected.id] : undefined;
  const caseLog = selected ? logs[selected.id] ?? [] : [];
  const blocks = scenarioResult?.transcript ? parseTranscript(scenarioResult.transcript) : [];
  const historyForCase = selected?.harnessCaseId
    ? history.filter((h) => h.case === selected.harnessCaseId).slice().reverse()
    : [];

  return (
    <div className="test-panel">
      <div className="test-panel-head">
        <div>
          <div className="test-panel-title">自动化测试</div>
          <div className="test-panel-sub">
            注册表 <code>tests/registry/*.json</code> · 新增用例只需落文件，无需改 UI
          </div>
        </div>
        <button
          className="set-btn"
          onClick={() => {
            setLoadError(null);
            window.pi.tests.list().then(setScan).catch((e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)));
          }}
        >
          刷新
        </button>
      </div>

      {loadError && <div className="test-banner error">载入注册表失败：{loadError}</div>}
      {scan && scan.errors.length > 0 && (
        <div className="test-banner warn">
          {scan.errors.length} 个注册表文件有问题：
          <ul>
            {scan.errors.map((e) => (
              <li key={e.file}>
                <code>{e.file}</code>：{e.errors.join("；")}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="test-panel-body">
        <div className="test-list">
          {grouped.length === 0 && <div className="test-empty">暂无用例</div>}
          {grouped.map(([feature, cases]) => (
            <div key={feature} className="test-group">
              <div className="test-group-name">{feature}</div>
              {cases.map((c) => (
                <button
                  key={c.id}
                  className={`test-list-item ${c.id === selectedId ? "active" : ""}`}
                  onClick={() => setSelectedId(c.id)}
                >
                  <span className={`test-badge ${c.kind}`}>{c.kind === "logic" ? "逻辑" : "场景"}</span>
                  <span className="test-list-title">{c.title}</span>
                  {runningId === c.id && <span className="test-spin">…</span>}
                </button>
              ))}
            </div>
          ))}
        </div>

        <div className="test-detail">
          {!selected && <div className="test-empty">左侧选择一个用例查看详情</div>}
          {selected && (
            <>
              <div className="test-detail-title">
                <span className={`test-badge ${selected.kind}`}>{selected.kind === "logic" ? "逻辑" : "场景"}</span>
                {selected.title}
              </div>
              <div className="test-meta">
                <div>
                  <b>来源：</b>
                  {selected.source}
                </div>
                <div>
                  <b>ID：</b>
                  <code>{selected.id}</code>
                  {selected.repeat && selected.repeat > 1 ? `（建议重复 ${selected.repeat} 次）` : ""}
                </div>
              </div>
              {selected.description && <div className="test-desc">{selected.description}</div>}

              {selected.preprompt && (
                <div className="test-section">
                  <div className="test-section-title">场景提示词</div>
                  <pre className="test-code">{selected.preprompt}</pre>
                </div>
              )}
              {selected.assertions && selected.assertions.length > 0 && (
                <div className="test-section">
                  <div className="test-section-title">断言点</div>
                  <ul className="test-asserts">
                    {selected.assertions.map((a, i) => (
                      <li key={i}>{a}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="test-section">
                <div className="test-section-title">通过标准</div>
                <div className="test-desc">{selected.passCriteria}</div>
              </div>

              <div className="test-actions">
                {selected.kind === "logic" && (
                  <button className="set-btn primary" disabled={runningId !== null} onClick={() => runLogic(selected)}>
                    {runningId === selected.id ? "运行中…" : "运行"}
                  </button>
                )}
                {selected.kind === "scenario" && (
                  <button className="set-btn primary" disabled={runningId !== null} onClick={() => runScenario(selected)}>
                    {runningId === selected.id ? "模拟中…" : "新建会话模拟"}
                  </button>
                )}
                {selected.kind === "scenario" && (
                  <span className="test-hint">在一次性沙盒项目里跑真实 agent（依赖本地 relay，约 1–3 分钟）</span>
                )}
              </div>

              {(logicResult || runningId === selected.id) && (
                <div className="test-section">
                  <div className="test-section-title">
                    运行输出
                    {logicResult && (
                      <span className={`test-status ${logicResult.ok ? "pass" : "fail"}`}>
                        {logicResult.ok ? "通过" : "失败"}（exit {String(logicResult.exitCode)}）
                      </span>
                    )}
                  </div>
                  <pre className="test-log" ref={logRef}>
                    {caseLog.join("\n") || "（等待输出…）"}
                  </pre>
                </div>
              )}

              {scenarioResult && (
                <div className="test-section">
                  <div className="test-section-title">
                    模拟结果
                    <span className={`test-status ${scenarioResult.ok ? "pass" : "fail"}`}>
                      {statusLabel(scenarioResult)}
                    </span>
                  </div>
                  {scenarioResult.error && <div className="test-banner error">{scenarioResult.error}</div>}
                  {scenarioResult.result?.checks && (
                    <ul className="test-checks">
                      {Object.entries(scenarioResult.result.checks).map(([key, value]) => (
                        <li key={key} className={value ? "ok" : "bad"}>
                          <span>{value ? "✓" : "✗"}</span>
                          <code>{key}</code>
                          <span className="test-check-val">{String(value)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {blocks.length > 0 && (
                    <div className="test-transcript">
                      {blocks.map((b, i) => (
                        <div key={i} className={`test-bubble ${b.kind}`}>
                          {b.text}
                        </div>
                      ))}
                    </div>
                  )}
                  {historyForCase.length > 0 && (
                    <div className="test-section">
                      <div className="test-section-title">历史运行（最近优先）</div>
                      <ul className="test-history">
                        {historyForCase.map((h, i) => (
                          <li key={i}>
                            <span className={`test-status ${h.status === "pass" ? "pass" : "fail"}`}>
                              {h.status ?? "未知"}
                            </span>
                            <code>{h.model ?? "?"}</code>
                            <span className="test-check-val">
                              被拦 {h.blockedEvidence ?? 0} · 切换卡 {h.modeSwitchRequests ?? 0}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {caseLog.length > 0 && (
                    <details className="test-log-details">
                      <summary>harness 原始日志</summary>
                      <pre className="test-log">{caseLog.join("\n")}</pre>
                    </details>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
