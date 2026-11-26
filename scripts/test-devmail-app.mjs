/** devmail 应用自测（L1）——不走 MPI：直接import 真实 app-store-core 校验清单，
 *  再驱动 lib/core.cjs + pi 扩展 + service 模块跑一遍完整收发/归档闭环。
 *
 * 覆盖的失败模式（都踩过或必然会踩）：
 *   1. 清单被 app-store 校验器拒绝 → 装不进去
 *   2. 设备名解析错（thinkbook16p / maxbox COMPUTERNAME 都是 WJW）→ 读错信箱
 *   3. 归档覆盖历史（同名已归档）→ 丢信
 *   4. 播报重复（每轮都念一遍未读）→ 吵
 *   5. 共享不可达时抛异常 → 打断会话
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..", "examples", "apps", "private", "devmail");
const require = createRequire(import.meta.url);

// 应用源码在 examples/apps/private/ 下（.gitignore 忽略：含设备名与内网地址）。
// 别的设备/CI clone 下来没有这个目录 —— 跳过而不是报错，否则全量测试会被一个
// 私有应用拖红。
if (!existsSync(join(APP, "mpi-app.json"))) {
  console.log("SKIP devmail app tests: examples/apps/private/devmail is not present (private app, not in git)");
  process.exit(0);
}

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`PASS ${name}`);
}

/**
 * 解析「应用自带的 pi 运行时」目录：`<userData>/runtime/versions/<版本>/pi`。
 *
 * 为什么不再写死路径（2026-11-25）：原来这两处硬编码了本机的 `versions/1.5.0`，
 * 一是换设备必红，二是内置运行时一升，启动时的 `cleanupRuntimeVersions()` 会把旧目录删掉，
 * 于是 `npm test -- devmail` 跟着红。现在先按 `package.json` 的 `piRuntimeVersion` 找，
 * 再退到本机最高可用版本（这里只用到 jiti 与 typebox，不涉版本特定行为）。
 */
function resolveManagedPiRuntimeDir() {
  const want = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8")).piRuntimeVersion;
  const roots = [];
  const appData = process.env.APPDATA?.trim();
  if (appData) for (const name of ["MPI", "MPI Dev"]) roots.push(join(appData, name, "runtime", "versions"));
  for (const key of ["MPI_USER_DATA_DIR", "MPI_CONFIG_DIR"]) {
    const dir = process.env[key]?.trim();
    if (dir) roots.push(join(dir, "runtime", "versions"));
  }
  // 只要 jiti（加载 .ts 扩展）与 dist/index.js（typebox 的宿主解析点）在就够了
  const usable = (dir) =>
    existsSync(join(dir, "node_modules", "jiti", "lib", "jiti.mjs")) && existsSync(join(dir, "dist", "index.js"));
  for (const root of roots) {
    const exact = join(root, want, "pi");
    if (usable(exact)) return exact;
  }
  for (const root of roots) {
    let versions = [];
    try {
      versions = readdirSync(root).sort();
    } catch {
      continue; // 这台设备没装过应用运行时，看下一个根
    }
    for (const v of versions.reverse()) {
      const candidate = join(root, v, "pi");
      if (usable(candidate)) return candidate;
    }
  }
  throw new Error(
    `没找到可用的 pi 运行时（期望版本 ${want}）。查找过：${roots.join(" | ")}。` +
      "先启动一次 MPI 让它解压内置运行时，或把 MPI_USER_DATA_DIR 指到含 runtime/versions 的目录。",
  );
}

/** 建一个临时共享根 + 空信箱。 */
function makeShare(devices = ["thinkbook16p", "workstation"]) {
  const root = mkdtempSync(join(tmpdir(), "devmail-share-"));
  for (const d of devices) mkdirSync(join(root, "inbox", "mail", d), { recursive: true });
  return root;
}

function writeMail(share, device, name, fields) {
  const body = [
    `# ${fields.title}`,
    `- 发件：${fields.from || "workstation"}`,
    `- 收件：${device}`,
    `- 时间：${fields.time || "2026-11-25 10:00"}`,
    `- 类型：${fields.type || "通知"}`,
    `- 优先级：${fields.priority || "普通"}`,
    "",
    fields.body || "正文",
    "",
  ].join("\n");
  writeFileSync(join(share, "inbox", "mail", device, name), body);
}

// —— 1. 清单校验 ——
{
  const { validateAppManifest } = await import(pathToFileURL(join(HERE, "..", "src", "main", "app-store-core.ts")).href);
  const raw = JSON.parse(readFileSync(join(APP, "mpi-app.json"), "utf8"));
  const res = validateAppManifest(raw);
  assert.equal(res.ok, true, `清单校验失败：${JSON.stringify(res.errors || [])}`);
  assert.equal(res.manifest.service.entry, "service/index.cjs");
  assert.deepEqual(res.manifest.pi.extensions, ["pi/extension.ts"]);
  ok("清单通过 app-store-core 校验（service + pi.extensions 路径合法）");

  // 包内声明的文件必须真的存在，否则装完扩展静默不加载。
  for (const rel of [res.manifest.service.entry, ...res.manifest.pi.extensions]) {
    assert.ok(existsSync(join(APP, rel)), `清单声明了不存在的文件：${rel}`);
  }
  ok("清单声明的入口文件都在包里");
}

// —— 2. 真实走一遍应用商店：从 zip 安装 → 启用 → 扩展出现在 pi 的加载列表 ——
{
  const sandbox = mkdtempSync(join(tmpdir(), "devmail-install-"));
  process.env.MPI_TEST_USER_DATA = join(sandbox, "userData");
  process.env.MPI_TEST_APP_PATH = join(HERE, "..");
  // 主进程模块 import 了 electron，测试里用桩代替（同 test-app-store.mjs）。
  const { register } = await import("node:module");
  register(new URL("./electron-stub-loader.mjs", import.meta.url));

  const { loadConfig } = await import(pathToFileURL(join(HERE, "..", "src", "main", "config.ts")).href);
  loadConfig(process.env.MPI_TEST_USER_DATA);
  const store = await import(pathToFileURL(join(HERE, "..", "src", "main", "app-store.ts")).href);
  store.setRuntimeDeps({
    loadModule: async () => ({ activate: async () => ({}), deactivate: async () => {} }),
    spawnProcess: () => null,
    killProcess: () => {},
    now: () => "2026-11-25T00:00:00.000Z",
  });

  // 用系统 bsdtar 现打一个包（与 pack.cjs 同一路径，避免依赖 dist/ 里的旧产物）
  const { spawnSync } = await import("node:child_process");
  const zipPath = join(sandbox, "devmail.zip");
  const tar = join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  const packed = spawnSync(tar, ["-a", "-cf", zipPath, "-C", APP, "mpi-app.json", "lib", "pi", "service", "cli"], {
    windowsHide: true,
  });
  assert.equal(packed.status, 0, "bsdtar 打包失败");

  await store.installAppFromZip(zipPath);
  let apps = store.listApps();
  assert.equal(apps.length, 1, "安装后应当只有一个应用");
  assert.equal(apps[0].id, "devmail");
  assert.equal(apps[0].enabled, false, "安装后默认不启用（要用户自己确认）");
  const installedDir = join(process.env.MPI_TEST_USER_DATA, "apps", "devmail");
  for (const rel of ["mpi-app.json", "lib/core.cjs", "pi/extension.ts", "service/index.cjs", "cli/devmail.mjs"]) {
    assert.ok(existsSync(join(installedDir, rel)), `zip 里缺 ${rel}`);
  }
  ok("安装：从 zip 装进 userData/apps/devmail，载荷完整");

  await store.setAppEnabled("devmail", true);
  const extPaths = store.getAppExtensionPaths();
  assert.ok(
    extPaths.some((p) => p.includes("devmail") && p.endsWith("extension.ts")),
    `启用后扩展没进加载列表：${JSON.stringify(extPaths)}`,
  );
  const check = store.checkAppExtensions("devmail");
  assert.equal(check.ok, true, `声明的扩展文件缺失：${check.missing.join(", ")}`);
  ok("启用：pi 扩展进入 bridge 加载列表，声明的文件都存在");

  // 从**安装后**的目录加载扩展：验证 ../lib/core.cjs 这类相对导入在
  // <userData>/apps/devmail/pi/ 下能解析（源码树里能跑不代表装完能跑）。
  {
    const PI_RUNTIME = resolveManagedPiRuntimeDir();
    const { createRequire: cr } = await import("node:module");
    const { createJiti } = await import(pathToFileURL(join(PI_RUNTIME, "node_modules/jiti/lib/jiti.mjs")).href);
    const reqPi = cr(join(PI_RUNTIME, "dist/index.js"));
    const jiti = createJiti(join(PI_RUNTIME, "dist/index.js"), {
      moduleCache: false,
      virtualModules: { typebox: reqPi("typebox"), "@earendil-works/pi-coding-agent": {} },
    });
    const factory = await jiti.import(join(installedDir, "pi", "extension.ts"), { default: true });
    assert.equal(typeof factory, "function", "安装后的扩展加载失败（相对导入 / TS 解析）");
    const names = [];
    factory({ registerTool: (t) => names.push(t.name), on: () => {} });
    assert.deepEqual(names.sort(), ["mail_archive", "mail_check", "mail_send"]);
    ok("安装后的扩展能从 userData/apps/devmail 真实加载（相对导入可用）");
  }

  // 停用 → 扩展从列表消失（否则改了代码/卸载后还会被调）
  await store.setAppEnabled("devmail", false);
  assert.ok(!store.getAppExtensionPaths().some((p) => p.includes("devmail")), "停用后扩展仍被加载");
  ok("停用：扩展从加载列表移除");

  await store.uninstallApp("devmail");
  assert.equal(store.listApps().length, 0);
  assert.ok(!existsSync(installedDir), "卸载后应用目录还在");
  ok("卸载：应用目录与注册表项一起清掉");

  rmSync(sandbox, { recursive: true, force: true });
}

// —— 3. 设备名解析优先级 ——
{
  const core = require(join(APP, "lib", "core.cjs"));
  const dataDir = mkdtempSync(join(tmpdir(), "devmail-cfg-"));

  // 显式配置最高优先级（同 COMPUTERNAME=WJW 的两台只能靠它）
  core.writeConfig(dataDir, { deviceName: "maxbox" });
  assert.equal(core.resolveDeviceName(core.readConfig(dataDir)), "maxbox");

  // 空配置 + 环境变量
  core.writeConfig(dataDir, { deviceName: "" });
  const prevEnv = process.env.DEVMAIL_DEVICE;
  process.env.DEVMAIL_DEVICE = "minibox";
  assert.equal(core.resolveDeviceName(core.readConfig(dataDir)), "minibox");

  // 环境变量也不设 → 落到启发式（本机 COMPUTERNAME 是 WIN-… → workstation）
  delete process.env.DEVMAIL_DEVICE;
  const guessed = core.resolveDeviceName(core.readConfig(dataDir));
  assert.ok(guessed.length > 0, "启发式至少要给出一个名字");

  if (prevEnv === undefined) delete process.env.DEVMAIL_DEVICE;
  else process.env.DEVMAIL_DEVICE = prevEnv;
  ok("设备名解析：配置 > 环境变量 > 本机文件 > 启发式");
}

// —— 4. 发信 → 收信 → 归档 闭环（含避让同名归档）——
{
  const core = require(join(APP, "lib", "core.cjs"));
  const share = makeShare(["workstation", "thinkbook16p"]);
  const cfg = { shareRoot: share, deviceName: "workstation" };

  const sent = core.sendMessage(cfg, { to: "thinkbook16p", subject: "测试标题 含空格", body: "第一行\n第二行" });
  assert.equal(sent.sent.length, 1);
  assert.deepEqual(sent.errors, []);

  const inbox = join(share, "inbox", "mail", "thinkbook16p");
  const names = readdirSync(inbox);
  assert.equal(names.length, 1);
  // shell 版命名规则：时间戳-发件-标题（去空白与非法字符，24 字符截断）
  assert.match(names[0], /^\d{8}-\d{4}-workstation-.+\.md$/);
  const text = readFileSync(join(inbox, names[0]), "utf8");
  assert.ok(text.includes("- 发件：workstation"), "信头缺发件");
  assert.ok(text.includes("- 收件：thinkbook16p"), "信头缺收件");
  assert.ok(text.includes("第一行\n第二行"), "正文被改写");
  ok("发信：文件名与信头模板与 shell 版一致");

  // 收件方视角看到 1 条未读，信头解析正确
  const peer = { shareRoot: share, deviceName: "thinkbook16p" };
  const snap = core.snapshot(peer);
  assert.equal(snap.count, 1);
  const header = core.readHeader(peer, snap.names[0]);
  assert.equal(header.title, "测试标题 含空格");
  assert.equal(header.from, "workstation");
  ok("收信：未读计数与信头解析正确");

  // 归档进 _processed/<device>
  const arch = core.archiveMessages(peer, snap.names);
  assert.deepEqual(arch.failed, []);
  assert.equal(core.snapshot(peer).count, 0);
  assert.deepEqual(readdirSync(join(share, "inbox", "mail", "_processed", "thinkbook16p")), [snap.names[0]]);
  ok("归档：移入 _processed/<本机设备>/，信箱归零");

  // 同名再归档一次（-ReadAll 跑两遍 / 老信重发）不能覆盖已有归档
  writeMail(share, "thinkbook16p", snap.names[0], { title: "同名的第二封" });
  const arch2 = core.archiveMessages(peer, [snap.names[0]]);
  assert.deepEqual(arch2.failed, []);
  const processed = readdirSync(join(share, "inbox", "mail", "_processed", "thinkbook16p")).sort();
  assert.equal(processed.length, 2, `归档被覆盖了：${processed.join(", ")}`);
  assert.ok(processed.some((n) => n.includes("-1.md")), `没有加后缀避让：${processed.join(", ")}`);
  ok("归档：同名时加 -1 后缀，绝不覆盖历史归档");

  rmSync(share, { recursive: true, force: true });
}

// —— 5. 参数校验与共享不可达 ——
{
  const core = require(join(APP, "lib", "core.cjs"));
  const share = makeShare(["workstation", "minibox"]);

  assert.throws(() => core.sendMessage({ shareRoot: share, deviceName: "workstation" }, { to: "nope", subject: "x" }), /收件方/);
  assert.throws(() => core.sendMessage({ shareRoot: share, deviceName: "workstation" }, { to: "minibox", subject: "" }), /标题/);
  assert.throws(
    () => core.sendMessage({ shareRoot: share, deviceName: "workstation" }, { to: "minibox", subject: "x", type: "瞎写" }),
    /类型/,
  );
  ok("发信参数校验：收件方 / 标题 / 类型");

  // -To all 排除自己
  const all = core.sendMessage({ shareRoot: share, deviceName: "workstation" }, { to: "all", subject: "广播" });
  assert.deepEqual(
    all.sent.map((s) => s.to),
    ["minibox", "thinkbook16p", "maxbox"],
    "all 应当是除本机外的全部设备",
  );
  ok("发信 -To all：排除本机自身");

  // 共享不可达 → 返回结构化失败，不抛异常（否则会打断 pi 会话）
  const dead = core.snapshot({ shareRoot: join(tmpdir(), "definitely-not-here-devmail"), deviceName: "workstation" });
  assert.equal(dead.ok, false);
  assert.ok(dead.reason, "失败时必须给出原因");
  ok("共享不可达：返回 { ok:false, reason }，不抛异常");

  rmSync(share, { recursive: true, force: true });
}

// —— 6. pi 扩展：注册三个工具 + 播报只做一次 ——
{
  const PI_RUNTIME = resolveManagedPiRuntimeDir();
  const { createJiti } = await import(pathToFileURL(join(PI_RUNTIME, "node_modules/jiti/lib/jiti.mjs")).href);
  const reqPi = createRequire(join(PI_RUNTIME, "dist/index.js"));
  const jiti = createJiti(join(PI_RUNTIME, "dist/index.js"), {
    moduleCache: false,
    virtualModules: { typebox: reqPi("typebox"), "@earendil-works/pi-coding-agent": {} },
  });
  const factory = await jiti.import(join(APP, "pi", "extension.ts"), { default: true });
  assert.equal(typeof factory, "function", "扩展默认导出必须是函数");

  const tools = [];
  const handlers = {};
  factory({ registerTool: (t) => tools.push(t), on: (e, f) => ((handlers[e] = handlers[e] || []), handlers[e].push(f)) });

  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ["mail_archive", "mail_check", "mail_send"],
  );
  assert.ok(handlers.session_start?.length, "缺少 session_start 自查钩子");
  assert.ok(handlers.before_agent_start?.length, "缺少 before_agent_start 播报钩子");
  ok("pi 扩展：注册 mail_check / mail_send / mail_archive 与会话开始钩子");

  // dataDir 由扩展按自身位置推导（…/apps/<id>/pi → …/apps/data/<id>），
  // 测试里直接写源码树下的同名位置，跑完清掉。
  const dataDir = join(APP, "..", "data", "devmail");
  const created = !existsSync(dataDir);
  const share = makeShare(["thinkbook16p"]);
  mkdirSync(dataDir, { recursive: true });
  const backup = existsSync(join(dataDir, "config.json")) ? readFileSync(join(dataDir, "config.json"), "utf8") : null;

  try {
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ shareRoot: share, deviceName: "thinkbook16p", notifyOnSessionStart: true }));
    writeMail(share, "thinkbook16p", "20261125-1000-workstation-a.md", { title: "第一封" });
    writeMail(share, "thinkbook16p", "20261125-1001-workstation-b.md", { title: "第二封" });

    handlers.session_start[0]();
    const first = await handlers.before_agent_start[0]();
    assert.ok(first?.message, "有未读时必须播报");
    assert.equal(first.message.display, false, "播报必须是 display:false（不要往用户界面塞系统提示）");
    assert.ok(first.message.content.includes("第一封") && first.message.content.includes("第二封"));

    const second = await handlers.before_agent_start[0]();
    assert.equal(second, undefined, "同一批未读不能重复播报");
    ok("pi 扩展：有未读才播报，同一批只播一次，display:false");

    // 归档一封 → 未读集合变化 → 允许再播报一次
    await tools.find((t) => t.name === "mail_archive").execute("t", { names: ["20261125-1000-workstation-a.md"] });
    const third = await handlers.before_agent_start[0]();
    assert.ok(third?.message, "未读集合变化后应重新播报");
    ok("pi 扩展：未读集合变化后重新播报");

    // 信箱清空 → 不播报
    await tools.find((t) => t.name === "mail_archive").execute("t", {});
    assert.equal(await handlers.before_agent_start[0](), undefined, "空信箱不该播报");
    ok("pi 扩展：信箱为空时不播报");

    // 关掉开关 → 不播报
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ shareRoot: share, deviceName: "thinkbook16p", notifyOnSessionStart: "off" }));
    writeMail(share, "thinkbook16p", "20261125-1002-workstation-c.md", { title: "第三封" });
    handlers.session_start[0]();
    assert.equal(await handlers.before_agent_start[0](), undefined, "开关关闭后不该播报");
    ok("pi 扩展：notifyOnSessionStart=off 时不自查不播报");

    // 工具在配置缺失时也要给出可读错误，而不是崩
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ shareRoot: join(tmpdir(), "nope-devmail-x"), deviceName: "thinkbook16p" }));
    const out = await tools.find((t) => t.name === "mail_check").execute("t", {});
    assert.match(out.content[0].text, /读取信箱失败/);
    ok("pi 扩展：共享不可达时工具返回可读错误而非抛异常");
  } finally {
    if (backup === null) rmSync(join(dataDir, "config.json"), { force: true });
    else writeFileSync(join(dataDir, "config.json"), backup);
    if (created) {
      const parent = join(APP, "..", "data");
      if (readdirSync(parent).length === 0) rmSync(parent, { recursive: true, force: true });
    }
    rmSync(share, { recursive: true, force: true });
  }
}

// —— 7. service 模块：表单值 → config.json，轮询开关 ——
{
  const svc = require(join(APP, "service", "index.cjs"));
  const dataDir = mkdtempSync(join(tmpdir(), "devmail-svc-"));
  const share = makeShare(["thinkbook16p"]);
  writeMail(share, "thinkbook16p", "20261125-1100-workstation-a.md", { title: "给服务的信" });

  const logs = [];
  const statuses = [];
  const host = {
    app: { id: "devmail", dir: APP, dataDir, version: "1.0.0" },
    getFieldValues: () => ({ deviceName: "thinkbook16p", shareRoot: share, pollMinutes: "0", notifyOnSessionStart: "on" }),
    status: (s, d) => statuses.push([s, d]),
    log: (l) => logs.push(l),
  };

  await svc.activate(host);
  const written = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8"));
  assert.equal(written.deviceName, "thinkbook16p");
  assert.equal(written.shareRoot, share);
  assert.equal(written.notifyOnSessionStart, true);
  assert.ok(statuses.some(([s, d]) => s === "ready" && /1 条未读/.test(d)), `状态没上报未读数：${JSON.stringify(statuses)}`);
  assert.ok(logs.some((l) => /轮询未启用/.test(l)), "pollMinutes=0 时应说明不轮询");
  ok("service：表单值落 config.json，未读数写进 status");

  await svc.deactivate();

  // 设备名填错（共享可达但信箱目录不存在）→ error，且提示指向设备名
  const host2 = {
    app: { id: "devmail", dir: APP, dataDir, version: "1.0.0" },
    getFieldValues: () => ({ deviceName: "typo-device", shareRoot: share, pollMinutes: "0" }),
    status: (s, d) => statuses.push([s, d]),
    log: (l) => logs.push(l),
  };
  await svc.activate(host2);
  assert.ok(
    statuses.some(([s, d]) => s === "error" && /设备名/.test(d)),
    `设备名填错时应报 error 并点名设备名：${JSON.stringify(statuses)}`,
  );
  await svc.deactivate();
  ok("service：设备名填错时报 error 并指向设备名");

  rmSync(dataDir, { recursive: true, force: true });
  rmSync(share, { recursive: true, force: true });
}

// —— 8. CLI 包装脚本：装/查/卸都能跑，装完能真跑 ——
{
  const { spawnSync } = await import("node:child_process");
  const box = mkdtempSync(join(tmpdir(), "devmail-shim-"));
  const appDataDir = join(box, "appdata", "MPI Dev", "apps", "devmail");
  mkdirSync(dirname(appDataDir), { recursive: true });
  // 模拟「已装好」：拷一份 app 到假 userData
  cpSync(APP, appDataDir, { recursive: true, filter: (src) => !src.includes(`${sep}dist`) });
  const env = { ...process.env, APPDATA: join(box, "appdata"), HOME: join(box, "home") };
  mkdirSync(env.HOME, { recursive: true });

  const script = join(APP, "cli", "install-shim.sh");
  const run = (...args) => spawnSync("bash", [script, ...args], { env, encoding: "utf8" });

  const installed = run();
  assert.equal(installed.status, 0, `install-shim 失败：${installed.stderr}`);
  const shim = join(env.HOME, "bin", "devmail");
  assert.ok(existsSync(shim), "包装脚本没生成");

  // 包装脚本要指向「安装后的 app 目录」，不是源码树。
  // 脚本会把 Windows 路径转成 /c/… 形式，比较时两边都归一。
  const posixOf = (p) => p.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
  const content = readFileSync(shim, "utf8");
  assert.ok(content.includes(posixOf(appDataDir)), `包装脚本没指向已安装的 app 目录：\n${content}`);

  const status = spawnSync("bash", [shim, "status"], { env, encoding: "utf8" });
  assert.equal(status.status, 0, `包装脚本跑不起来：${status.stderr}`);
  assert.match(status.stdout, /本机设备名/);
  ok("CLI 包装脚本：安装指向已装 app、装完能直接跑 status");

  assert.equal(run("--uninstall").status, 0);
  assert.ok(!existsSync(shim), "--uninstall 没删掉包装脚本");
  ok("CLI 包装脚本：--uninstall 删除干净");

  rmSync(box, { recursive: true, force: true });
}

// —— 9. 设备字面量不泄漏到接口 + bodyFile + 标题截断告警 ——
// 对应 minibox 2026-11-26《设备字面量泄漏审计》的 A/B/C 三条。
{
  const PI_RUNTIME = resolveManagedPiRuntimeDir();
  const { createJiti } = await import(pathToFileURL(join(PI_RUNTIME, "node_modules/jiti/lib/jiti.mjs")).href);
  const reqPi = createRequire(join(PI_RUNTIME, "dist/index.js"));
  const jiti = createJiti(join(PI_RUNTIME, "dist/index.js"), {
    moduleCache: false,
    virtualModules: { typebox: reqPi("typebox"), "@earendil-works/pi-coding-agent": {} },
  });
  const factory = await jiti.import(join(APP, "pi", "extension.ts"), { default: true });

  const tools = [];
  factory({ registerTool: (t) => tools.push(t), on: () => {} });

  // A：工具描述与参数描述里不得出现盘符，也不得写死某一设备的目录布局。
  // 同一句描述在四台设备上必须同样成立，否则 agent 会去本地翻一个不存在的目录。
  {
    const texts = [];
    for (const t of tools) {
      texts.push(`${t.name}: ${t.description}`);
      const schema = JSON.stringify(t.parameters ?? {});
      texts.push(`${t.name}(params): ${schema}`);
    }
    const joined = texts.join("\n");
    assert.ok(!/[A-Za-z]:[\\/]/.test(joined), `工具描述里不应出现盘符字面量：${joined.match(/[A-Za-z]:[\\/][^\s,"]*/g)?.[0]}`);
    assert.ok(!/Share\/inbox|inbox\/mail/.test(joined), "描述不应写死信箱目录布局");
    ok("接口描述：无盘符、无写死的信箱目录布局（审计 A）");
  }

  const dataDir = join(APP, "..", "data", "devmail");
  mkdirSync(dataDir, { recursive: true });
  const share = makeShare(["workstation"]);
  const backup = existsSync(join(dataDir, "config.json")) ? readFileSync(join(dataDir, "config.json"), "utf8") : null;

  try {
    writeFileSync(
      join(dataDir, "config.json"),
      JSON.stringify({ shareRoot: share, deviceName: "thinkbook16p", notifyOnSessionStart: "off" }),
    );
    const send = tools.find((t) => t.name === "mail_send");

    // C：标题超 24 字符→ 必须告警，不能静默截断
    const longSubject = "这是一个明显超过二十四个字符上限的长标题，应当被截断并告警";
    const r1 = await send.execute("t", { to: "workstation", subject: longSubject, body: "正文" });
    assert.match(r1.content[0].text, /已投递 1 封/);
    assert.match(r1.content[0].text, /⚠.*标题超过 24 字符/, "标题被截时必须告警（审计 C）");
    ok("发信：标题超 24 字符时告警，不静默截断");

    // 短标题不该误告警
    const r2 = await send.execute("t", { to: "workstation", subject: "短标题", body: "正文" });
    assert.doesNotMatch(r2.content[0].text, /⚠/, "短标题不应出现截断告警");
    ok("发信：未超限的标题不误告警");

    // B：bodyFile——长正文不需要在上下文里重复一遍
    const bodyFile = join(tmpdir(), `devmail-body-${Date.now()}.md`);
    writeFileSync(bodyFile, "# 完整主题\n\n这段正文是从文件读进来的。\n", "utf8");
    const r3 = await send.execute("t", { to: "workstation", subject: "带文件的信", bodyFile });
    assert.match(r3.content[0].text, /已投递 1 封/);
    const inboxDir = join(share, "inbox", "mail", "workstation");
    const landed = readdirSync(inboxDir).find((f) => f.includes("带文件的信"));
    assert.ok(landed, "bodyFile 发的信应落进对方信箱");
    assert.match(readFileSync(join(inboxDir, landed), "utf8"), /这段正文是从文件读进来的/);
    rmSync(bodyFile, { force: true });
    ok("发信：bodyFile 能读到文件内容（审计 B）");

    // body 与 bodyFile 同时给 → 报错而不是静默丢一个
    const r4 = await send.execute("t", { to: "workstation", subject: "两个都给", body: "A", bodyFile: bodyFile });
    assert.match(r4.content[0].text, /只能给一个/);
    ok("发信：body 与 bodyFile 互斥，两者都给时报错");

    // bodyFile 不存在 → 可读错误
    const r5 = await send.execute("t", { to: "workstation", subject: "文件不存在", bodyFile: join(tmpdir(), "nope-devmail-body.md") });
    assert.match(r5.content[0].text, /读不到正文文件/);
    ok("发信：bodyFile 不存在时给可读错误");

    // 两个正文都为空 → 不能发出一封空信
    const r6 = await send.execute("t", { to: "workstation", subject: "空正文", body: "   " });
    assert.match(r6.content[0].text, /正文为空/);
    ok("发信：空正文被拒（body 不再是必填，需要自己守住）");
  } finally {
    if (backup === null) rmSync(join(dataDir, "config.json"), { force: true });
    else writeFileSync(join(dataDir, "config.json"), backup);
    rmSync(share, { recursive: true, force: true });
  }
}

// —— 10. 设备名「从哪一级来的」可报出来（maxbox 第三条）——
{
  const core = require(join(APP, "lib", "core.cjs"));
  const dataDir = mkdtempSync(join(tmpdir(), "devmail-src-"));
  const prevEnv = process.env.DEVMAIL_DEVICE;
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  const prevName = process.env.COMPUTERNAME;
  try {
    // 1) 配置优先
    core.writeConfig(dataDir, { deviceName: "maxbox" });
    delete process.env.DEVMAIL_DEVICE;
    assert.deepEqual(core.resolveDeviceSource(core.readConfig(dataDir)), { name: "maxbox", source: "config" });

    // 2) 环境变量
    core.writeConfig(dataDir, { deviceName: "" });
    process.env.DEVMAIL_DEVICE = "minibox";
    assert.equal(core.resolveDeviceSource(core.readConfig(dataDir)).source, "env");
    delete process.env.DEVMAIL_DEVICE;

    // 3) ~/.devmail-device
    const fakeHome = mkdtempSync(join(tmpdir(), "devmail-home-"));
    writeFileSync(join(fakeHome, ".devmail-device"), "thinkbook16p\n");
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    assert.equal(core.resolveDeviceSource(core.readConfig(dataDir)).source, "file");

    // 4) 启发式（名字在四台里）
    rmSync(join(fakeHome, ".devmail-device"));
    process.env.COMPUTERNAME = "MINI-BOX";
    const hit = core.resolveDeviceSource(core.readConfig(dataDir));
    assert.deepEqual(hit, { name: "minibox", source: "heuristic" });

    // 5) 启发式落空（thinkbook16p 与 maxbox 的 WJW 就落在这）——名字仍给出来，但 source 说清是猜的
    process.env.COMPUTERNAME = "WJW";
    const miss = core.resolveDeviceSource(core.readConfig(dataDir));
    assert.equal(miss.name, "wjw");
    assert.equal(miss.source, "unknown");
    assert.ok(!core.DEVICES.includes(miss.name), "WJW 不应该被当成四台里的任何一台");
    assert.ok(core.DEVICE_SOURCE_LABELS[miss.source].includes("猜"), "落空时的中文描述要说清是猜的");

    ok("设备名解析：每一级都能报出来源，落空时标 unknown 不乱贴");
    rmSync(fakeHome, { recursive: true, force: true });
  } finally {
    if (prevEnv === undefined) delete process.env.DEVMAIL_DEVICE;
    else process.env.DEVMAIL_DEVICE = prevEnv;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevProfile;
    if (prevName === undefined) delete process.env.COMPUTERNAME;
    else process.env.COMPUTERNAME = prevName;
    rmSync(dataDir, { recursive: true, force: true });
  }
}

// —— 11. 信箱里的 .md 附件不再冒充未读（maxbox 第四条）——
{
  const core = require(join(APP, "lib", "core.cjs"));
  const share = makeShare(["workstation"]);
  const cfg = { shareRoot: share, deviceName: "workstation" };
  const inbox = join(share, "inbox", "mail", "workstation");

  // 名字合约定的信 → 算未读
  writeMail(share, "workstation", "20261126-1000-minibox-a.md", { title: "合约定的信" });
  // 名字不合约定、但带信头（手写的）→ 仍算未读
  writeMail(share, "workstation", "随手写的一封.md", { title: "没按约定命名" });
  // 名字与信头都不合（maxbox 碰到的就是这种）→ 归非消息文件
  writeFileSync(join(inbox, "strata-iq3_s.sample-20261028.README.md"), "# 附件说明\n\n这是随信带的样本说明。\n");
  // 非 .md 附件→照旧归非消息文件
  writeFileSync(join(inbox, "config.bak.json"), "{}");

  assert.ok(core.isMessageFileName("20261126-1000-minibox-a.md"), "合约定的名字应判为消息");
  assert.ok(!core.isMessageFileName("随手写的一封.md"), "不合约定的名字不应判为消息");

  const res = core.listInbox(cfg);
  assert.ok(res.ok);
  const names = res.files.map((f) => f.name).sort();
  assert.deepEqual(names, ["20261126-1000-minibox-a.md", "随手写的一封.md"], `未读只应包含真消息：${JSON.stringify(names)}`);
  assert.ok(res.others.includes("strata-iq3_s.sample-20261028.README.md"), ".md 附件应计入非消息文件");
  assert.ok(res.others.includes("config.bak.json"), "非 .md 附件仍计入非消息文件");
  assert.equal(core.snapshot(cfg).count, 2, "未读计数不应把附件算进去");
  ok("列未读：名字或信头认一个，两头都不沾的只计数不占未读");

  rmSync(share, { recursive: true, force: true });
}

// —— 12. 表单空值不抹掉手写的设备名，并且旧 config 留 bak ——
{
  const svc = require(join(APP, "service", "index.cjs"));
  const core = require(join(APP, "lib", "core.cjs"));
  const dataDir = mkdtempSync(join(tmpdir(), "devmail-sync-"));
  const share = makeShare(["maxbox"]);

  // 手动装：只写了 config.json，面板从没打开过 → 表单递过来的是清单默认值
  core.writeConfig(dataDir, { shareRoot: share, deviceName: "maxbox", pollMinutes: "0", notifyOnSessionStart: false });
  const logs = [];
  const statuses = [];
  // 表单与手写 config 只在一项上不同（pollMinutes），这样同时能测到「内容真变了才留 bak」
  const host = {
    app: { id: "devmail", dir: APP, dataDir, version: "1.0.3" },
    getFieldValues: () => ({ deviceName: "", shareRoot: share, pollMinutes: "15", notifyOnSessionStart: "off" }),
    status: (s, d) => statuses.push([s, d]),
    log: (l) => logs.push(l),
  };
  await svc.activate(host);
  await svc.deactivate();

  const written = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8"));
  assert.equal(written.deviceName, "maxbox", "表单留空不应抹掉手写的设备名");
  assert.equal(written.pollMinutes, "15", "表单给了值就用表单的");
  assert.ok(logs.some((l) => /沿用 config.json 现值/.test(l)), "保留时应记一行日志");
  const bak = readFileSync(join(dataDir, "config.json.bak"), "utf8");
  assert.ok(bak.includes('"deviceName": "maxbox"') && bak.includes('"pollMinutes": "0"'), `旧内容应完整留在 .bak：${bak}`);
  // 其余项仍表单优先（shareRoot 留空 = 用内置默认，这是标签里写明的语义）
  assert.equal(written.shareRoot, share, "shareRoot 仍表单优先");
  assert.equal(written.notifyOnSessionStart, false, "开关项没有「未填」这种取值，仍表单优先");
  assert.equal(core.resolveShareRoot({ shareRoot: "" }), core.DEFAULT_SHARE_ROOT, "shareRoot 空串等价于内置默认");
  ok("service：设备名为空时保留现值并留 bak，其余项表单优先");

  // 用户在面板里填了 → 以表单为准（能改得动）
  const host2 = {
    app: { id: "devmail", dir: APP, dataDir, version: "1.0.3" },
    getFieldValues: () => ({ deviceName: "workstation", shareRoot: share, pollMinutes: "0", notifyOnSessionStart: "off" }),
    status: (s, d) => statuses.push([s, d]),
    log: (l) => logs.push(l),
  };
  await svc.activate(host2);
  await svc.deactivate();
  assert.equal(JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).deviceName, "workstation", "表单填了就应该生效");
  ok("service：面板填了设备名仍以表单为准（保留只限空值）");

  // 名字不在四台里 → 状态里给出可操作的下一步（不是只问一句“填错了？”）
  const host3 = {
    app: { id: "devmail", dir: APP, dataDir, version: "1.0.3" },
    // shareRoot 给临时共享：这一段只测「设备名落空时的提示」，不去碰真网络
    getFieldValues: () => ({ deviceName: "", shareRoot: share, pollMinutes: "0", notifyOnSessionStart: "off" }),
    status: (s, d) => statuses.push([s, d]),
    log: (l) => logs.push(l),
  };
  core.writeConfig(dataDir, { shareRoot: share, deviceName: "" });
  // 把三级兜底都掉空：环境变量、~/.devmail-device（本机真有这份文件，必须换掉 HOME）、启发式落空
  const prevEnv = process.env.DEVMAIL_DEVICE;
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  const prevName = process.env.COMPUTERNAME;
  const emptyHome = mkdtempSync(join(tmpdir(), "devmail-nohome-"));
  delete process.env.DEVMAIL_DEVICE;
  process.env.HOME = emptyHome;
  process.env.USERPROFILE = emptyHome;
  process.env.COMPUTERNAME = "WJW";
  try {
    await svc.activate(host3);
    await svc.deactivate();
  } finally {
    if (prevEnv === undefined) delete process.env.DEVMAIL_DEVICE;
    else process.env.DEVMAIL_DEVICE = prevEnv;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevProfile;
    if (prevName === undefined) delete process.env.COMPUTERNAME;
    else process.env.COMPUTERNAME = prevName;
    rmSync(emptyHome, { recursive: true, force: true });
  }
  const hint = statuses.filter(([, d]) => /手填设备名|应用设置/.test(d));
  assert.ok(hint.length > 0, `名字不对时应说清该改哪儿：${JSON.stringify(statuses.slice(-3))}`);
  ok("service：设备名不是四台里时，状态文案直接指向「该改哪儿」");

  rmSync(dataDir, { recursive: true, force: true });
  rmSync(share, { recursive: true, force: true });
}

console.log(`\n${passed} checks passed`);
