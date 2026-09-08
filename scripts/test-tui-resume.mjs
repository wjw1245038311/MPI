// Dev diagnostic: spawn interactive pi with --session <existing JSONL created
// by RPC mode> inside a node-pty PTY and dump the rendered text, to verify the
// TUI resumes an MPI session file without errors. Run:
//   node scripts/test-tui-resume.mjs <session.jsonl>
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const pty = await import("node-pty");
const cli = join(homedir(), "AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const session = process.argv[2];
if (!existsSync(session)) { console.error("no session file:", session); process.exit(1); }
console.log("[resume] cli:", cli);
console.log("[resume] session:", session);
const term = pty.spawn(process.execPath, [cli, "--session", session], {
  name: "xterm-256color", cols: 100, rows: 30, cwd: process.cwd(),
  env: { ...process.env, TERM: "xterm-256color" },
});
let out = "";
term.onData((d) => (out += d));
term.onExit(({ exitCode }) => { console.log("[resume] EXITED code=", exitCode); finish(); });
setTimeout(() => term.write("/exit\r"), 8000);
const hardStop = setTimeout(finish, 25000);
function finish() {
  clearTimeout(hardStop);
  const plain = out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*/g, "");
  console.log("[resume] bytes:", out.length, "has-ansi:", /\x1b\[/.test(out));
  const errHits = plain.match(/error|failed|cannot|unknown|invalid|not found/gi) || [];
  console.log("[resume] error-ish hits:", JSON.stringify(errHits.slice(0, 8)));
  console.log("---- last 1500 chars (ANSI stripped) ----");
  console.log(plain.slice(-1500));
  try { term.kill(); } catch {}
  setTimeout(() => process.exit(0), 300);
}
