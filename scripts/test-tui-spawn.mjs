// Dev diagnostic: spawn an interactive pi TUI inside a node-pty PTY (the exact
// path src/main/tui.ts uses) and confirm the terminal actually renders output
// instead of crashing. Run with: node scripts/test-tui-spawn.mjs [cli.js]
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const pty = await import("node-pty");

// Same resolution order as pi-bridge in dev: explicit arg > global npm install.
const candidates = [
  process.argv[2],
  join(homedir(), "AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
].filter(Boolean);
const cli = candidates.find((c) => existsSync(c));
if (!cli) {
  console.error("[tui-spawn] pi cli.js not found; pass it as the first argument.");
  process.exit(1);
}
console.log("[tui-spawn] node:", process.execPath);
console.log("[tui-spawn] cli :", cli);

const term = pty.spawn(process.execPath, [cli], {
  name: "xterm-256color",
  cols: 100,
  rows: 30,
  cwd: process.cwd(),
  env: { ...process.env, TERM: "xterm-256color" },
});

let out = "";
let exited = null;
term.onData((d) => (out += d));
term.onExit(({ exitCode }) => {
  exited = exitCode;
  finish();
});

// Give the TUI a moment to paint, then send /exit cleanly.
setTimeout(() => term.write("/exit\r"), 4000);
const hardStop = setTimeout(finish, 15000);

function finish() {
  clearTimeout(hardStop);
  const bytes = out.length;
  // A real TUI emits ANSI/escape sequences and a non-trivial amount of text.
  const looksLikeTui = bytes > 200 && /\x1b\[/.test(out);
  console.log("[tui-spawn] output bytes:", bytes, "has-ansi:", /\x1b\[/.test(out), "exitCode:", exited);
  try { term.kill(); } catch {}
  process.exit(looksLikeTui ? 0 : 2);
}
