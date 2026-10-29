# MPI User Manual

Applies to: MPI 0.13.x (Windows x64 / macOS arm64)

This manual covers all major features of MPI, organized as "interface → configuration → sessions → advanced features", so you can jump straight to the section you need. If you just want to get your first workflow running quickly, start with the beginner guide [MPI-BEGINNER-GUIDE.md](MPI-BEGINNER-GUIDE.md) in the repo instead.

---

## Table of Contents

1. [Getting to Know MPI](#1-getting-to-know-mpi)
2. [Installation and First Launch](#2-installation-and-first-launch)
3. [Interface Overview](#3-interface-overview)
4. [Configuring Models](#4-configuring-models)
5. [Projects and Sessions](#5-projects-and-sessions)
6. [Chatting with the Agent](#6-chatting-with-the-agent)
7. [Voice System](#7-voice-system)
8. [Permission Modes](#8-permission-modes)
9. [Context Management](#9-context-management)
10. [File Preview and HTML Element References](#10-file-preview-and-html-element-references)
11. [Automations (Scheduled Tasks)](#11-automations-scheduled-tasks)
12. [Todo Tasks](#12-todo-tasks)
13. [Extensions: Skills / Packages / MCP](#13-extensions-skills--packages--mcp)
14. [Terminal and Pi TUI](#14-terminal-and-pi-tui)
15. [Global Search (Ctrl+K)](#15-global-search-ctrlk)
16. [Archive and Trash](#16-archive-and-trash)
17. [Settings Reference](#17-settings-reference)
18. [Phone Remote Control (web / Android)](#18-phone-remote-control-web--android)
19. [Messaging Channels (Feishu / WeChat)](#19-messaging-channels-feishu--wechat)
20. [App Store](#20-app-store)
21. [Keyboard Shortcuts](#21-keyboard-shortcuts)
22. [Data and Configuration Locations](#22-data-and-configuration-locations)
23. [FAQ](#23-faq)

---

## 1. Getting to Know MPI

MPI is a standalone desktop client for the [Pi coding agent](https://github.com/earendil-works/pi). Projects, sessions, model configuration, extensions, permission control, scheduled tasks, todo tasks and file preview all live in one desktop workspace.

A few concepts you'll meet often:

| Concept         | Description                                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| Project         | A local folder. Pi reads code, creates files and performs operations inside that directory.                 |
| Session         | One continuous conversation with the agent, backed by a session file. A project can have multiple sessions. |
| Permission mode | The level controlling which operations Pi may perform automatically: Read-only / Strict / Sandbox / Full.   |
| Extensions      | pi's skills, extension packages (npm/git/local) and MCP servers, all managed in the "Extensions" panel.     |

MPI shares the same agent configuration directory `~/.pi/agent` with terminal pi: models, API keys, extensions, skills and MCP config are common to both, so an extension installed on one side is immediately available on the other. Session files also live under that directory, which means the terminal and the desktop client see the same session history.

Every installer ships a pinned Node.js + Pi runtime (`MPI-Runtime-*.tar.gz`), so you don't need to install Node.js separately. On first launch MPI verifies and extracts the bundled runtime into the user data directory; later app updates reuse the extracted runtime without re-downloading anything.

---

## 2. Installation and First Launch

### 2.1 Installers

| Platform              | File                      | Notes                                |
| --------------------- | ------------------------- | ------------------------------------ |
| Windows x64           | `MPI-Setup-<version>.exe` | NSIS installer, double-click to run. |
| macOS (Apple Silicon) | `MPI-<version>-arm64.dmg` | Drag-to-install.                     |

The installers are not code-signed yet, so the OS may show a security warning on first run. That's expected; continue once you've confirmed the source is trustworthy.

### 2.2 Windows installation steps

1. Double-click `MPI-Setup-x.y.z.exe` to start the wizard.
2. If SmartScreen shows "Windows protected your PC", click **More info → Run anyway**.
3. Follow the wizard (the default install path is fine).
4. Launch MPI from the desktop shortcut or Start menu.

### 2.3 macOS installation steps

1. Double-click `MPI-x.y.z-arm64.dmg` and drag the MPI icon into "Applications".
2. Gatekeeper may block the first launch: in Applications, right-click MPI → **Open** and confirm; or allow it once under "System Settings → Privacy & Security".

### 2.4 Verifying the installer (optional)

If a `.exe.sha256` file with the same base name ships next to the installer, you can verify integrity first: run `Get-FileHash .\MPI-Setup-x.y.z.exe -Algorithm SHA256` in PowerShell and compare the output character by character with the sidecar file. You can also view the verification steps inside the app: **Settings → System & diagnostics → App update → View changelog** (the modal footer includes "How to verify the install").

### 2.5 First launch

1. Start MPI. The first run extracts the bundled runtime, so give it a moment before the main window appears.
2. Open **Settings → Models & Providers** and add your first model (see [Section 4](#4-configuring-models)).
3. Click `+` next to "Projects" on the left to open a local folder as a project.
4. Click "New session" and send your first message.

### 2.6 Launch at startup

**Settings → System & diagnostics → Launch at startup**. When enabled, MPI starts automatically when you log in (on Windows this creates a shortcut in the Start menu's Startup folder). Unchecking removes it.

---

## 3. Interface Overview

The main window has four areas:

```
┌────────────────────────────────────────────────────────────┐
│ Title bar: brand · File/Edit/View/Help menus · status · ⚙ │
├──────────┬─────────────────────────────────┬───────────────┤
│ Sidebar  │ Session area (chat)             │ Right slot    │
│ (left)   │ (center)                        │ (toggleable,  │
│ Sessions │ · Top bar: title/folder/actions │  one at a time)│
│ Projects │ · Messages + tool cards         │ · Preview     │
│ Files    │ · Composer (attach/cmds/perms)  │ · Terminal    │
└──────────┴─────────────────────────────────┴───────────────┘
```

### 3.1 Title bar

- Left menus:
  - `File`: New session, Open folder…
  - `Edit`: Copy / Cut / Paste / Delete, Open settings…
  - `View`: Collapse/expand sidebar, Toggle preview panel
  - `Help`: User manual, About MPI
- Center: status text (current session name · model, or "Pi ready").
- Right: ⚙ open Settings; minimize / maximize / close window.

### 3.2 Sidebar (left)

Top to bottom:

1. Top button row: 🔍 global search (same as Ctrl+K), collapse sidebar.
2. Quick entry buttons: "Hand off to new chat", "Automations" (clock icon), "Todo tasks" (checked-box icon) and "Extensions" (plug icon). They start a new conversation, the [automations panel](#11-automations-scheduled-tasks), the [todo panel](#12-todo-tasks) and the [extensions panel](#13-extensions-skills--packages--mcp) respectively. "Hand off to new chat" is described in [5.2](#52-new-sessions-and-hand-off).
3. Three tabs: `Sessions` / `Projects` / `Files`.
   - **Sessions**: every session across **all projects**, grouped by date (no need to switch project first), with pinned-project tiles and pinned-session stamps on top.
   - **Projects**: the project list. Each row has its name, a session-count badge, a `+` (new session in that project) and a star pin button; right-click offers **Move up / Move down** (pinned items only), Open in File Explorer, Pin/Unpin project, Archive project and **Update project path** (re-point a folder that has moved).
   - **Files**: the file tree of the current session's project; clicking any file opens it on the right. File rows can be dragged straight into the composer as attachments (folders are not draggable).

The `+` button (inside the Projects tab) opens a folder: create or pick a project.

**What the Sessions tab contains** (top to bottom):

- **Pinned project tiles**: pinned projects laid out like an avatar wall (4–5 per row); hover for an info card, click to jump to that project's most recent session.
- **Pinned session stamps**: pinned sessions rendered as round stamps (6 per row, unfilled with a double ring); hover for an info card, click to jump straight there. A pinned session appears **only here**, never duplicated in the list below.
- **Date-grouped list**: the remaining sessions grouped by activity (Today / Yesterday / This week / Earlier), each row showing a relative time (e.g. "3 hours ago"); older sessions are visually toned down.

Session row actions: hovering reveals pin / archive / delete icons; the right-click menu is grouped by meaning (move up/down, pin, clone, export, batch operations, reveal in folder, delete) with an icon per item. Pinned items can be dragged to reorder inside the pinned zone, and entries can be dragged into or out of it.

**"Reclaimed" marker**: sessions idle for a long time get their process stopped to free memory (2 hours by default, described under "Settings → System & diagnostics"). Such sessions show a "reclaimed" marker; opening one restarts it automatically with history and drafts intact.

**Batch operations**: right-click any session → "Batch operations" to enter multi-select. Select with checkboxes (Shift+click selects a range); the top bar shows the selected count, "Select all", Archive, Delete, Export and an exit button. Batch archive runs immediately; batch delete asks for confirmation; batch export produces **one session pack**. Pinned stamps are not part of batch selection.

6. Bottom usage row: always shows "Today · Total" (token counts in compact k/M format). Hover for today/total breakdown, cost and total session count. It refreshes automatically after each stream ends and polls every 60 seconds as well; terminal pi activity is counted too.

The sidebar width can be adjusted by dragging its right edge; double-click resets it to the default.

### 3.3 Session area (center)

Top bar:

- Left: session title (**double-click to rename**; a tooltip says so), working folder path (hover for the full path, click to open in File Explorer; right-click to switch the session's working folder), connection status hint.
- Right buttons (left to right): 🔍 in-session search (Ctrl+F), ⭐ pin/unpin current session, 🔀 **hand off to a new chat** (click = write a handoff document first, then open a new session; long-press 600 ms or right-click = new session in place), ⌨ **Terminal** (open the integrated terminal in the right slot, see [Section 14](#14-terminal-and-pi-tui)), 👁 toggle preview.

> The old top-bar "rename" and "switch working folder" buttons were removed: rename by double-clicking the title, switch folders by right-clicking the path line under the title (or from above the composer).

Message list:

- User messages on the right (default avatar "Nobita"), agent replies on the left (default avatar "Doraemon"); avatars are customizable in Settings.
- Tool cards: every tool call by Pi (read file, run command, edit, …) produces a card you can expand to see arguments and results. Diffs from `edit`-type tools auto-expand into a git-style single-column view (context lines + colored `-`/`+` lines); multi-replacement edits show an "N replacements" badge in the header; once collapsed manually it won't force-open again.
- File artifact chips: files Pi writes or modifies appear as chips under the message; click to open them in the preview pane. With many files the list is **collapsed by default** (same interaction as tool cards) so it doesn't push the conversation down; the expanded/collapsed state is remembered.
- Dot navigation: with 2 or more user messages, a vertical dot rail appears on the left of the chat area; hover for a message preview (hovering also reveals the full input text), click to jump.
- Long-task ring: bottom-left of the composer. A tool call or file transfer that runs longer than ~10 seconds makes it appear, showing a ring progress and elapsed time; click for the current list. It only watches **the current session**, so activity elsewhere never pollutes it, and the ring colour escalates the longer it runs — at a glance you can tell "slow" from "stuck".
- Jump to latest: after scrolling up away from the bottom, a circular double-arrow floating button appears at the bottom right; click to smooth-scroll back to the latest.
- While streaming, output auto-follows the bottom; manual scroll-up reading isn't yanked back, follow resumes near the bottom, and each turn ends with a smooth settle at the very end.

Composer, left to right:

| Control             | Purpose                                                                                                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `+`                 | Add file/image attachments                                                                                                                                                              |
| `/ Commands`        | Open the slash-command menu (built-in commands, extension commands and skills)                                                                                                          |
| Task mode pill (⚡) | One-click preset of "permission + thinking + behaviour instructions" (Balanced/Iterate/Research/Review, plus custom), see [6.8](#68-task-modes-switch-how-the-agent-works-in-one-click) |
| Permission pill     | Switch the current session's permission mode (four levels, see [Section 8](#8-permission-modes))                                                                                        |
| Ring button         | Context usage progress ring + detail popover (see [Section 9](#9-context-management))                                                                                                   |
| Model pill          | Pick provider / model / thinking level, plus "Session tools" (completion sound toggle)                                                                                                  |
| Send / Stop         | Send the message; becomes a "Stop" button while the agent is running                                                                                                                    |

Above the composer, the current working folder is shown (click to switch project). Unsent input (text, images, attachments) is saved as a draft per session and restored when you reopen that session after an app restart.

### 3.4 Right slot (preview / terminal)

Toggle it from "Toggle preview" in the chat top bar (or the View menu). It renders or highlights Markdown, HTML, source code, images and common office documents; see [Section 10](#10-file-preview-and-html-element-references) for details. The same slot also hosts the integrated terminal (see [Section 14](#14-terminal-and-pi-tui)); only one panel is shown at a time.

---

## 4. Configuring Models

MPI manages providers and models through Pi's shared `models.json` (in `~/.pi/agent`), fully compatible with terminal pi.

### 4.1 Adding a provider

The **Settings → Models & Providers** page has two sections: preset providers on top, my providers below.

- Quick add from presets: the top section lists common platforms as cards (Bailian pay-as-you-go API / Coding Plan, Zhipu GLM, DeepSeek, Kimi / Moonshot, Gemini, GPT / OpenAI), plus two entry points, "Custom config" and "Local deploy" (self-hosted services such as LM Studio or Ollama go through here). Clicking a platform card opens the add form prefilled with its URL, API type and first model; just enter your API key (adjust as needed) and add it. A preset that is already configured gets an accent outline; if it is also the current default provider it shows a "Current" badge, and clicking it then expands that provider's editor in the section below instead. The search box filters platforms by name; "Refresh presets" re-reads models.json to update each platform's status.
- Custom config / Local deploy: opens an empty (or Ollama-prefilled) add form for any API:

| Field         | Notes                                                                                                                                                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider name | Any custom name, e.g. `deepseek`, `openai`, `my-provider`.                                                                                                                                                                        |
| API type      | Choose per the vendor's docs: `openai-completions` / `openai-responses` / `anthropic-messages` / `google-generative-ai`. OpenAI-compatible services usually use an OpenAI-compatible type, but follow the vendor's documentation. |
| API URL       | Base URL, e.g. `https://api.example.com/v1` (mind the `/v1` path).                                                                                                                                                                |
| API key       | Paste the key directly or reference an environment variable like `$MY_API_KEY`. Never put real keys into screenshots, commit history or shared docs.                                                                              |
| Model ID      | The model ID the vendor actually uses; may be left empty and added later in the provider editor.                                                                                                                                  |

Fill it in, click "Add provider", then "Save models". The model immediately appears in the composer's model selector.

- My providers: each configured provider shows as a compact card (name + model count + host) in the bottom section; clicking one expands its full editor below, covering base URL, API type, API key, request headers, advanced compat JSON and per-model settings. Renaming or deleting a provider happens there too.

### 4.2 Model card settings

One card per model; common options:

- Thinking: when on, MPI requests thinking levels from this model (off hides the thinking level control).
- Images: check when the model accepts image input.
- Context length / Max output: token counts per the vendor's docs; or check "Auto" and leave it empty, in which case MPI resolves them on save (pi runtime's built-in model catalog first, then a provider API probe: OpenRouter-style `/models`, LM Studio native endpoint, Ollama) and shows a source badge next to the input (Catalog / Probed). Unresolved values fall back to Pi's default 128K. Existing values are never re-resolved on save; the "↻" button explicitly re-probes and overwrites the current value (useful after changing a local model's num_ctx).
- Test availability: one-click check that Base URL, API key and model ID actually work.

Advanced settings (expand on the card's right):

- `compat`: only change this if your vendor has special compatibility requirements; it must stay valid JSON.
- `thinkingLevelMap`: maps Pi's standard thinking levels to vendor levels item by item, no hand-written JSON needed. Each level can be "unspecified" (vendor default), "hide this level", or a specific standard/custom value.

### 4.3 Auto model switching

**Settings → Models & Providers → "Auto model" card**: configure the candidate pool first. Add models from any provider (add / remove / reorder; order is a tie-break preference within the same tier), check **Paid** on billed endpoints, and override the quality tier if needed (auto-inferred by default: frontier-model table → parameter-size signals → catalog cost band). The policy knobs live here too (slow factor / slow floor in seconds / streak turns / recovery probe interval / switch cooldown / allow rescue downgrade / notify on switch); the defaults work out of the box.

Per-session toggle: the model dropdown in the composer has an **Auto (auto switch)** entry at the top; clicking it enables auto mode for that session:

- MPI picks models by free first → higher quality tier → lower latency; on a brand-new empty session it immediately selects the best healthy candidate as the initial model.
- Health is collected from normal conversation (time-to-first-token + error classification) with zero extra API calls; candidates are actively probed only when a switch decision is needed (minimal request, 20s timeout, max 3 probes per model per hour).
- When the current model errors or stays too slow, MPI switches to the best available candidate and shows a toast; while in fallback it re-probes better candidates every 5 minutes and switches back once they recover (after the cooldown).
- It only switches to tiers at least as good as the current one; if nothing qualifies it may "rescue downgrade" (with a warning, or forbidden entirely in strict mode). Billed models are used only when no healthy free candidate meets the floor (noted in the toast).
- Switches happen between turns only and never interrupt streaming. Manually selecting a specific model exits auto for that session; non-auto sessions have zero overhead (no monitoring, no probes).

A green dot on the pill means auto is active (amber = warning state: billed model used or downgraded); after a switch the context ring refreshes to the new model's window.

### 4.4 Thinking levels

Pi's standard thinking levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` (shown in the UI as Off/Minimal/Low/Medium/High/X-High/Max). In the model selector popover, "Thinking level" is a row of labels + pill buttons that expand into a rounded option list; when a mapping is configured, options show hints like `Medium → mid`.

Note: the actually available levels also depend on the model's live capability list. Levels the vendor doesn't declare won't appear in the current session's selector.

### 4.5 Thinking defaults

**Settings → Conversation → Default thinking depth**:

- Default thinking depth, default provider / default model: initial choices for new sessions (still switchable at any time inside a session).
- Hide thinking blocks: when on, thinking content is not shown in replies.

### 4.6 Troubleshooting "my config has no effect"

1. Open **Settings → System & diagnostics** to see the actual paths of `models.json`, `settings.json` and `auth.json`, and make sure you're editing the right file.
2. Common causes: misspelled model ID; Base URL missing or with an extra `/v1`; API type mismatched with the protocol; key without permission; "Thinking" not enabled on the model, so no levels appear.

### 4.7 User profile (now part of Zhiya)

The old "Settings → User profile" tab is gone: the profile text now lives as a file at `~/.pi/agent/zhiya/persona.md`, so editing it with an external editor (Obsidian / VSCode) works too — new sessions pick up the latest content.

- Injection behavior is unchanged: the text is still appended to every session's system prompt (4 KB truncation guard), so the agent knows your context from the first message.
- Entry point: sidebar "Zhiya" → Persona (the same menu also has Agreement / Workspace / Knowledge base / Current tasks / Memory pool / Project memory).
- A profile written in older versions is migrated automatically (the file contains a "migrated from the old User profile setting" section).
- Stored under `~/.pi/agent/zhiya/`, leaving terminal pi's other settings untouched.

---

## 5. Projects and Sessions

### 5.1 Opening a project

Three entry points: the `+` next to the "Projects" heading in the sidebar (pick or create a local folder), the "Open project folder" button on the empty-state page, and menu File → Open folder…. The selected folder becomes the current project and appears in the left list; the number next to a project name is the count of sessions found under it.

### 5.2 New sessions and "hand off"

**Plain new session** (blank conversation), three equivalent entry points: the `+` at the top of the Projects tab, the `+` on a project row, and menu File → New session. With no project open you're asked to pick a folder first.

**Hand off to a new chat** (the 🔀 button in the chat top bar) — for when the current session is too long and you want a fresh one that hasn't lost its memory:

1. Click 🔀. MPI asks **the current session itself** to write a handoff document (fixed structure: Goal / Done / Key decisions / Next steps). This genuinely runs one model turn — a few seconds up to a minute.
2. When it finishes, a new session opens automatically, titled with the handoff document's own H1, and its first prompt just points at that document.
3. The new session inherits the old one's **task mode / model / thinking level / permission** (in that order), so nothing has to be reconfigured.

One button, two meanings:

| Action                             | Effect                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------- |
| Click                              | Hand off: write the document first, then open the new session.                              |
| Long-press (600 ms) or right-click | **New session in place**: a blank session with no document (the old "New session" meaning). |

Details:

- While a handoff is in flight the button greys out and reads "Handoff in progress… (the new session opens automatically)", so double-clicking can't break a running handoff.
- If the current session was never written to disk (a draft with no messages), 🔀 behaves like "new session in place".
- The writing instructions for the handoff document live in "Handoff document instructions" and are editable (Settings → Conversation → handoff instructions, see [17.1](#171-conversation-default-tab)).

A draft session that hasn't sent its first message can be moved to another project by right-clicking the folder path line under the title.

### 5.3 Rename / Pin / Sort

- Rename: **double-click the session title** (the ✎ button in the top bar was removed).
- Pin: three equivalent ways, the permanent star button on the session row, the ⭐ button in the chat top bar, and "Pin session" from the right-click menu. Newly pinned items go to the end of the pinned zone, and pinned sessions appear as round stamps at the top of the Sessions tab.
- Sort (pinned items only): right-click "Move up / Move down", or drag directly within the pinned zone; order survives restarts. The list zone is always auto-sorted by activity time.

### 5.4 Fork and Clone

| Action | Entry point                                            | Behavior                                                                                                                                                                                                          |
| ------ | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fork   | Hover any user message → "Fork" button                 | Branches a new session from before that prompt and auto-fills the forked prompt's text into the composer (editable before sending). The original session is marked as disconnected. Same behavior as TUI `/fork`. |
| Clone  | Right-click a session in the sidebar → "Clone session" | Fully copies the current active branch into a new session file, including all history.                                                                                                                            |

Clicking fork/clone while a reply is streaming asks you to wait for it to finish.

### 5.5 Archive and Delete

- Archive session: hover the session row and click the archive icon (or right-click). Archived sessions disappear from the sidebar and default search; find them under "Settings → Data management → Archive & Trash" or Ctrl+K (with "Archive & trash" checked) and restore with one click.
- Archive project: right-click a project → "Archive project". All of its sessions are archived together; restoring works the same way.
- Delete session: hover and click the trash icon, or right-click "Delete". By default this moves it to the trash (recoverable); only deleting again from the trash is permanent. Turning off the trash switch in "Settings → Data management" makes deletes immediately permanent. See [Section 16](#16-archive-and-trash).
- Handling several at once: right-click → "Batch operations", see the "Batch operations" part of [3.2](#32-sidebar-left).

### 5.6 Exporting a session pack

Right-click a session → "Export" produces a **zip session pack** (not a human-readable Markdown file):

- It contains the raw session file byte-for-byte plus the attachments that session used, keeping the project folder structure.
- On another machine, pick that zip under "Settings → Data management → Import sessions" to import it directly; the session returns to its original project and its attachments come along.
- Batch export combines several sessions into one pack.

How the export routes compare:

| Route                                         | Output                     | Importable back into MPI       |
| --------------------------------------------- | -------------------------- | ------------------------------ |
| Right-click a session → Export                | single-session zip         | yes                            |
| Batch operations → Export                     | multi-session zip          | yes                            |
| Settings → Data management → Backup & restore | full/selective session zip | yes (with an overwrite policy) |

### 5.7 Other session behaviors

- New session in place (top-bar 🔀 long-press or right-click, project row `+`): starts a fresh conversation in the current working context (same project).
- Restart restore: whichever session you were in when MPI quit is reopened automatically on next launch; if that session was archived or deleted in the meantime it's silently skipped.
- Graceful shutdown: if a task is running when you close a session or quit the app, MPI first aborts and waits for the write to land (a few seconds max) so session files aren't corrupted.
- Process reclaim: sessions idle for a long time get their process stopped to save memory and show as "reclaimed" in the list; opening one restarts it with history and drafts intact.

---

## 6. Chatting with the Agent

### 6.1 Basic input

Enter sends; Shift+Enter inserts a newline. Pressing Enter while composing with a Chinese/Japanese IME only confirms the candidate word and doesn't accidentally send. Better results when your prompt states four things: what to accomplish, where the target files/directories are, output format and constraints, and how to verify completion.

**Every session carries two "delivery discipline" rules** (hard rules appended to the system prompt, no need to restate them):

1. Ask when it should — don't present assumptions as conclusions. When you explicitly ask for "list the uncertainties first", it must first gather what's missing, what each option would cost, and its recommended default, then give the parts it can start on.
2. Separate "what the document says" from "its own inference": when claiming something violates or satisfies a rule it must cite the source; if the basis is inferred rather than written, it must say so explicitly.

### 6.2 Attachments

Three ways with the same effect (they appear in the attachment list above the composer and go out with the message): click `+` and pick files; drag a file row from the sidebar "Files" tab straight into the composer (the composer shows a highlight border while hovering, dropping the same file twice doesn't duplicate it, folders can't be dragged); or drag files in from the system File Explorer, or paste an image directly.

### 6.3 Slash commands and skills

Click the `/ Commands` button or type `/` in the composer to open the menu (three categories: built-in commands, extension commands and skills). Common ones:

- `/compact [note]`: manually compact the context; you can add a note about what to focus on (same as the compact icon in the context popover).
- `/skill:name [args]`: explicitly invoke an installed skill.
- Slash commands shipped with extension packages also appear here.

### 6.4 Steering while running

While the agent is replying, the send button becomes "Stop", and two ways to add input are supported (hover the send button for hints): Enter saves a pending follow-up that runs after the current turn ends; Alt+Enter inserts into context immediately (steer) so it influences the in-flight task as soon as possible.

Queued messages show above the composer and can be re-edited or executed immediately via their button.

### 6.5 Drafts and send-failure protection

Unsent text/images/attachments are persisted per session (last 40 kept) and restored automatically after restart; they're cleared on successful send, or when you delete down to the last character.

Any send failure (connection failure, RPC error, …) rolls back the displayed user bubble, restores the original text/images/attachments fully into the composer, and shows an error toast. No lost input, no unresponsive "ghost messages".

### 6.6 Per-message actions

- Hover a user message: copy this message / Fork (see 5.4).
- Under agent replies: copy, 👍 helpful / 👎 not helpful (with an optional note; click again to retract).
- **Select text and right-click** (the menu only appears for a chat-area selection): Quote to composer / Add as todo / Hand off to new session. A quote carries its location inside the conversation, not just dead text; "Hand off to new session" sends that text as the new session's first prompt.
- Sidebar session rows can be **dragged into the composer** — the session is attached as a reference so you don't have to paste the transcript by hand.
- The "completion sound" toggle lives under "Session tools" in the model selector popover; it plays a short beep when the agent finishes a task and can be turned off.
- The "Thinking · Ns" timer counts the **whole turn** (switching sessions doesn't reset it), so coming back still shows how long it has actually been running.

### 6.7 Question choice panels (choices)

Sometimes the agent doesn't just ask a question — it lays out a **clickable panel** inside its reply (e.g. "pick one of these plans"). The panel renders inline at the end of the reply, not as a code block.

How to use it:

- **Answer each question**: click one option per question. Click another to change your mind.
- **Skip** (the small button at each question's title): skip a question you don't want to answer. Skipped questions are **not sent back to the model** (the line is omitted), so it can't treat a non-answer as a real choice. Skipped questions can be un-skipped.
- **Other / custom answer**: each question has an "Other (type your own answer)…" field for an option that isn't listed.
- **Note** (at the bottom of the panel): add a remark for the whole group, placed after the last question; it stays visible after submitting and can be clicked to edit.
- **Submit**: the button only enables once every question is answered or skipped (otherwise it tells you how many are outstanding). Submitting combines your picks into **one** message (starting with "My choices:"), after which the panel freezes and shows your selections.

Things that happen under the hood (nothing you need to do):

- If the model writes a malformed panel, MPI **retries once automatically** instead of dumping raw text at you.
- When several panels appear in one reply only the last is rendered; empty code fences are no longer reported as "invalid format".
- The submit button locks immediately, so double-clicking can't send twice.

### 6.8 Task modes (switch how the agent works in one click)

A task mode is a named preset of "permission level + thinking depth + optional behaviour instructions", switched from the ⚡ button to the left of the permission pill in the composer (takes effect immediately; it does not affect model selection). Open the dropdown: each row shows its name and a parameter summary (e.g. "Sandbox · Low thinking"), the ⓘ at the row end reveals the full parameters and instructions, and "Manage task modes…" at the bottom creates / edits custom modes.

Four built-ins:

| Mode                   | Parameters                             | Use                                                                                                                                            |
| ---------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Balanced** (default) | Sandbox · low thinking                 | Everyday development; the recommended default, applied to new sessions automatically.                                                          |
| **Iterate**            | Full access · low thinking · with spec | Runs long tasks through the loop-dev workflow: reconnoitre, split, present a plan and wait for approval, then execute and verify step by step. |
| **Research**           | Enforced read-only · medium thinking   | Investigate only: presents a sourced research report and waits for your confirmation before implementing.                                      |
| **Review**             | Enforced read-only · x-high thinking   | Review only: lists issues by severity with fix suggestions, without changing code.                                                             |

- **Enforced read-only**: while Research / Review is active, every write operation is blocked by the system regardless of the permission level (a safety floor you cannot bypass by raising permissions). Once the agent has produced a plan and needs to act, it may pop a "mode switch request" card; clicking "Approve and switch" lifts the enforced read-only for that session in real time and continues execution (denying or closing keeps it read-only); to research and act over the long term, copy the parameters into a custom mode.
- **Custom modes**: the management modal lets you create modes and edit their parameters and instructions; instructions can be a block of text or point at an external markdown "spec" file, injected into the system prompt every turn while active (live; edit the file to update). Built-ins can be re-parameterized but not deleted.
- Applying a mode sets the chosen parameters in one go; parameters set to "leave unchanged" keep the session's current value.

---

## 7. Voice System

MPI supports two-way voice interaction: **voice input** (speak → transcribed into the editor) and **voice output** (agent replies read aloud).

### 7.1 Voice Input (Transcription)

The microphone button sits right of "Add files" in the composer's bottom bar:

1. Click to start recording — the button turns red with a pulsing dot and an elapsed-time counter; recordings auto-stop at 3 minutes, Esc cancels (no text produced).
2. Click again to stop. The audio is converted locally to WAV and sent to your configured transcription service; the result is **appended to the editor** (never auto-sent) so you can review and edit it first.

**Set up first**: under Settings → Conversation → Voice system, pick **OpenAI-compatible /audio/transcriptions** as the service, then fill in Base URL and model name. The microphone stays disabled until you do.

MPI **does not bundle or host** a transcription service. Two common options:

| Option           | How                                                                                                                                                                                                  | Good for                                               |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Cloud service    | Enter the provider's Base URL + model + API Key (any OpenAI-compatible service)                                                                                                                      | Nothing to install, but needs network access and quota |
| Local deployment | Run an OpenAI-compatible service on this machine first (e.g. sherpa-onnx + SenseVoice, FunASR, whisper.cpp, Speaches), point Base URL at it (e.g. `http://127.0.0.1:8800/v1`) and use its model name | Fully offline, no quota                                |

For credentials you can either **reference an already-configured provider** from Models & Providers (its base URL/key are read live — rotating a key needs no re-save of voice settings) or enter a Base URL + API Key manually. **For a local address (`127.0.0.1` / `localhost` / `::1`) the API Key may be left empty**; remote services require one.

The "Test connection" button sends a silent-audio probe to verify endpoint, key and model (an empty transcript on a silent probe is normal).

### 7.2 Voice Output (Read Aloud)

- **Per-message**: each agent reply has a speaker button in its footer (icon + label) reading "Read aloud"; click to read that message aloud, and the button switches to "Stop" which stays clickable **for the whole duration**, so one click always stops it. Code blocks collapse into a single "(code block)" marker, links are read by their label only, and thinking content is never spoken.
- **Auto-read**: tick "Auto-read the agent's reply when a turn settles" under Settings → Conversation → Voice system. The visible session's replies are then read automatically after each turn; background sessions stay silent.

There are two read-aloud engines (Settings → Conversation → Voice system → Voice output):

- **System voice (offline, default)**: uses the platform's built-in speech synthesis (on Windows: the voices installed with your OS — Chinese requires an installed zh voice), fully offline with no extra dependencies.
- **Edge online neural voice (free)**: synthesized by Microsoft Edge's Read Aloud service for more natural voices. Offers 13 curated Chinese/English neural voices (Mandarin / Taiwan / Cantonese / US & UK English), needs no API key, but **requires network access**. If synthesis fails (offline or service unavailable) it automatically falls back to the system voice and tells you once that it has done so.

With either engine you can pick the voice (default follows the UI language, preferring a matching-language voice), adjust the rate from 0.5× to 2×, and press "Preview" to audition.

If nothing is audible: switch to "System voice" and try again (sound means the problem is Edge's network/service side); if system voice is silent too, check that the OS has the voice installed (Windows: Settings → Time & language → Language → Speech).

---

## 8. Permission Modes

MPI uses permission gates to control how Pi executes shell commands, writes files and performs extension operations. Each session is configured independently; the permission pill on the left of the composer switches it at any time (takes effect immediately, no session restart needed).

| Level             | Behavior                                                                                                                                                                     | Good for                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Read-only         | Read operations run; any modifying operation is blocked outright with no confirmation prompt.                                                                                | Pure Q&A and code analysis when you never want Pi to touch files. |
| Strict            | Read commands auto-run; every write/delete/modify command needs confirmation. For write/edit tools you can pick "allow this tool for this thread" to avoid repeated prompts. | Frequent file changes with per-operation oversight.               |
| Sandbox (default) | Low-risk in-project operations (e.g. `npm run build`) auto-run; dangerous commands, writes outside the project, etc. prompt for confirmation.                                | Everyday development, the recommended default.                    |
| Full              | Nothing is intercepted.                                                                                                                                                      | Tasks/environments you explicitly trust.                          |

- Default permission for new sessions: a dropdown in Settings → Permissions & security (Read-only/Strict/Sandbox/Full) controlling the initial level of subsequently created sessions; existing sessions keep their own settings. Task modes (see [6.8](#68-task-modes-switch-how-the-agent-works-in-one-click)) also set the permission and thinking levels in one go; Research / Review are enforced read-only.
- Trusted tools: Settings → Permissions & security has a searchable "Trusted extension tools" list — it automatically shows the extension tools seen in this profile's sessions (search box + All/Trusted/Untrusted tabs); toggle one on to stop it prompting under sandbox/strict (e.g. `mem0_memory`), or type a name at the bottom to add one manually. `bash` and file write/edit tools are marked "always confirms" and can never be trusted; read-only tools like read/web_search need no approval, so they have no toggle; read-only modes are unaffected.
- **Enforced read-only blocks more than you'd expect**: under Research / Review, besides file writes, **network requests, non-whitelisted commands, sub-agents and most extension tools** are blocked too. The honest behaviour is to tell you up front "the current task mode cannot do this" instead of first trying a pile of commands and then explaining. In that case just switch modes — no need to change permissions.
- Confirmation dialog: when authorization is needed, a "Permission required" dialog shows the exact command and target path; review it before allowing or denying. Beginners should read the command and its target location first.
- Automations can't wait for human approval, so they only offer Sandbox / Full (see [Section 11](#11-automations-scheduled-tasks)).

> Tip: permission gates greatly reduce accidental damage but don't replace OS-level isolation; pair them with a system sandbox for untrusted code environments.

---

## 9. Context Management

### 9.1 Usage ring

The ring button in the composer's bottom bar (left of the model selector) shows current context usage live: arc = share, color in four bands, ≤60% green / 60–74% yellow / 75–89% orange / ≥90% red. It loads on session switch, refreshes immediately after a stream ends or compaction completes, and polls every 15 seconds while running.

### 9.2 Context window popover

Click the ring to see: current model name, progress bar, "~used / total + percentage", "Compactions N×" (hover for the last one's time), a compaction suggestion colored by usage band, plus refresh and compact icons at the top right.

- ≤60%: no compaction needed yet
- 60–74%: long tasks may benefit from early compaction
- 75–89%: consider manual compaction to leave headroom
- ≥90%: strongly recommended to compact now
- After 3 or more cumulative compactions an extra warning appears: early details may be lost, so write important conclusions into files or memory.

### 9.3 Compacting context

Three triggers: the compact icon in the popover's top-right corner (same as `/compact`); typing `/compact [note]` in the composer; and pi's automatic compaction when a long conversation hits its threshold (failures show a warning toast).

After compaction, token counts display as estimates (`~` prefix) until the next reply provides real numbers.

**The old messages are still readable after compaction**: compaction doesn't delete them — they're fenced off by a divider, with an "earlier conversation" section above it. That section is collapsed by default (long histories load without a hitch) and expands on click; in-conversation search (Ctrl+F) searches inside it too.

**Use a cheaper model for summaries if you want to save money**: "Settings → Models & providers → Summary model" (provider + model, two rows). Leave it empty to follow the session's main model; a common setup is a pricey cloud model for the main work and a cheap flash model for compaction. Takes effect on the next compaction, no restart needed.

### 9.4 One-click repair for broken sessions

In rare cases a provider rejects an entire session history because of "blank tool results" or "orphaned tool_results", making the conversation impossible to continue. A red banner with a "Repair and reload" button then appears above the composer: MPI repairs the session file (placeholder replacement, cleanup of stale compaction records), automatically backs it up to `sessions/mpi-repair-backups/` before modifying, and reopens the session when done.

---

## 10. File Preview and HTML Element References

### 10.1 Opening files

Click any file in the sidebar "Files" tab; click a file artifact chip in a chat message; or click an attachment chip (view it inside MPI).

The file tree is a lazy-loaded cache and only refreshes automatically after each agent turn. If you changed files by hand or created some in an external tool, right-click a directory and choose "Refresh this folder" (right-clicking the root refreshes the whole tree).

### 10.2 Supported types

| Type                   | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Markdown               | Full rendering of headings, lists, tables, code blocks and images, inline HTML (e.g. README screenshot grids) and ```mermaid fence diagrams (lazy-loaded; invalid syntax falls back to the raw code instead of leaving a broken error graph); relative image paths in the document are loaded from disk automatically; clicking a link to a local file opens that file right in the preview, while http(s) links open in the external browser. |
| PDF                    | Inline paginated preview with page navigation and zoom — no external reader needed.                                                                                                                                                                                                                                                                                                                                                            |
| HTML                   | Live preview (sandboxed iframe) with zoom support (50%–200%, wheel/buttons).                                                                                                                                                                                                                                                                                                                                                                   |
| Source code            | Syntax highlighting + line numbers.                                                                                                                                                                                                                                                                                                                                                                                                            |
| Images                 | Click to open in a lightbox; images inside the chat also have a right-click "Copy image" to paste elsewhere.                                                                                                                                                                                                                                                                                                                                   |
| Office documents, etc. | Best-effort rendering; for complex formats use the system's default app.                                                                                                                                                                                                                                                                                                                                                                       |

### 10.3 Preview header buttons (left to right)

- Show in File Explorer: locates and selects the file (errors if it doesn't exist).
- Refresh preview: re-reads the file content.
- Expand / Collapse: let the preview take over the main workspace, or restore the side layout.
- Close.

Tab right-click menu (same as VS Code): Close, Close Others, Close All. The left edge is draggable to resize the preview width; double-click resets to default.

### 10.4 HTML element references (annotation mode)

When previewing an HTML file, a "Select an HTML element and reference it in the composer" button appears in the header:

1. Click it to enable annotation mode: hover highlights elements, click selects any element on the page;
2. The selected element's info (CSS selector, tag name, text, current styles, HTML snippet) is added automatically as an HTML reference card in the composer's attachment area. After sending, Pi knows exactly which element you mean; ideal for requests like "make this button red";
3. Annotation mode also has an edit button: with an element selected you can modify its content directly and write it back to the HTML source file (the status bar shows "Click an element / Editing");
4. Reference cards can be expanded for details or removed.

---

## 11. Automations (Scheduled Tasks)

The clock icon in the sidebar opens the "Automations" panel. Note: scheduling only happens while MPI is running; nothing executes while the app is closed.

### 11.1 Creating a task

Click `+` and fill in:

| Field          | Notes                                                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Task name      | e.g. "Daily morning report".                                                                                                                                                               |
| Working folder | The project directory where the task runs (Pi works inside it).                                                                                                                            |
| Prompt         | The full instruction to execute on schedule; installed skills can be used.                                                                                                                 |
| Repeat         | Hourly (at minute N) / Daily (HH:mm) / Weekly (check weekdays + HH:mm).                                                                                                                    |
| Run permission | Sandbox (default, operations needing confirmation are blocked) or Full. Automations can't wait for human approval; grant Full only to tasks you explicitly trust.                          |
| Model          | Optional. Empty = use the current default model; filling it pins this task to that provider/model, which suits "a cheap model for mechanical work". List rows show a model badge per task. |

> Automations run unattended, so anything requiring human interaction counts as a failure instead of waiting forever; only notification-type operations are always allowed.

### 11.2 Managing tasks

Each row shows name, schedule summary, last status (failures in red with the reason on hover), and an enable switch. "Run now" triggers one manual run; "Edit" modifies and saves; delete asks for confirmation.

Task results appear as standalone sessions under the corresponding project, prefixed "Automation: xxx" (older "Automations: xxx" names created by previous versions are still recognized and localized with the UI language). Completion/failure shows a toast notification.

---

## 12. Todo Tasks

The checked-box icon in the sidebar opens the "Todo tasks" panel. Todos are tracked per project, with due dates (down to the minute), notes, file/image attachments and smart date parsing; the agent can also add todos from a conversation (marked with an AI badge).

### 12.1 Adding todos

Type into the input at the top of the panel and press Enter to create. With "All projects" selected on the left, pick the target project in the dropdown first; when a specific project is selected, new todos automatically belong to it.

You can also select text in a chat and right-click "Add as todo" — the todo keeps the **location of its source session**, so you can jump back to that conversation later.

Smart date parsing: you can write dates straight into the text. `send report tomorrow` becomes title "send report", due tomorrow (Chinese forms like `明天发周报`, `周五`, `9月30日`, `12-5` also work); if no date is recognized the todo has none. A time can accompany the date: `tomorrow 9am standup` → tomorrow 09:00; `14:30交报告`, `下午3点半评审`, `9am standup` all work. A bare time with no date means today (e.g. `14:30 submit report`).

Click a row to expand its inline editor: change title / note / due date and time (or clear them) and save, or delete directly (no confirmation dialog).

Attachments: the dashed box below the description is the attachment area (Feishu Bitable style), with a permanent ＋ tile on its left. Click it to open the system file picker; you can also drag & drop files/images straight into the editor (the dashed box highlights while dragging), or click inside the box and press `Ctrl+V` to paste. Up to 10 attachments per todo, 50 MB each. Adding the same file again (picking/pasting/dragging a file with the same name and size) is deduped automatically: only one copy is kept, with a notice. Existing attachments show as cards: images as thumbnails (click for a full-screen preview overlay, zoom in/out at top-right, Esc to close), other files with name and size (click to open with the default app); × appears on hover to remove. Attachments are stored as copies (deleting the original has no effect), by default under `%APPDATA%\MPI\todo-attachments\`; the location is changeable in Settings → Data management (existing attachments stay where they are).

### 12.2 Smart sections

The panel groups todos by time dimension, each chip showing a count: All / Today (includes overdue; overdue in red) / Tomorrow / This week (Mon–Sun) / Later (dates after this week) / No date / Done. In the "Done" section, "Clear done" at the bottom bulk-deletes completed items in the current scope.

### 12.3 Project scope and agent collaboration

Selecting a project in the left column filters to that project's todos; "All projects" shows everything with a project-name tag on each row. When the agent calls `mpi_todo_add` / `mpi_todo_list` during a conversation, items are written into this panel through an inbox mechanism (the main process watches and dedupes them). Such rows carry an AI badge; clicking it jumps straight to the source session. Data lives in `%APPDATA%\MPI\todos.json` (see [Section 22](#22-data-and-configuration-locations)); dev and production builds are independent.

---

## 13. Extensions: Skills / Packages / MCP

The plug icon in the sidebar opens the "Extensions" panel (managing pi's extension packages and skills), with three top-level module tabs: Skills N / Packages M / MCP K (each with a count).

### 13.1 Skills

A skill is an instruction set in `SKILL.md` form that pi loads automatically at the right moments; it can also be invoked explicitly via `/skill:name`. Three sub-tabs:

- My skills (master-detail layout): left column has search + All/Enabled/Disabled filters + a list grouped by source directory; right column is the detail pane with badges, "Copy command" (puts `/skill:name` on the clipboard), enable/disable switch, rendered SKILL.MD preview and "Copy Markdown".
- Skill marketplace: browse and search the public [skills.sh](https://skills.sh/) catalog with one-click install into Pi; a fixed strip above the search box links to other marketplaces (虾评 / SkillHub / SkillsMP).
- Stats: total/enabled/disabled stat cards, distribution bars by source directory, and a disabled-skills list (one-click re-enable).

### 13.2 Extension packages

A pi extension is a code package installed from npm/git/local path that can add tools, commands and UI to pi. Two sub-tabs:

- My packages: top row "＋ Install package / Update all"; clicking ＋ expands an inline input (accepts `npm:<package>`, a `git:` URL or a local path; Enter installs). Left column lists grouped by npm/git/local + right detail pane (type/version badges, source and install directory, package.json notes, update/enable-disable/remove buttons).
- Package marketplace: searches the public npm registry (default query "pi extension", top 30 by relevance); left result list + right detail pane (version/license/weekly-downloads badges, npm page and repo links, README preview), one-click install via `npm:<package>`.

> Package installation uses MPI's built-in npm, so it works on machines without Node.js; installing from git sources requires Git to be installed on the system (a clear hint is shown when missing). If you manually configured `npmCommand` in `~/.pi/agent/settings.json`, MPI won't override it.

### 13.3 MCP

MCP (Model Context Protocol) servers provide pi with external tools and data sources. Two sub-tabs:

- My MCP: the left column lists servers configured in `~/.pi/agent/mcp.json` (stdio / remote badges, plus an exposure badge); the right detail pane has copy command, an enable/disable switch (writes the `enabled: false` flag pi understands, reversible anytime) and delete (with confirmation).
- MCP marketplace: browse the mcpmarket.cn public catalog (logo/author/stars/description) with keyword search and "Load more"; click a card for the overview sections and GitHub link.

> **MCP is built into pi** (pi ≥ 0.99): the `pi-mcp-adapter` extension is no longer needed and the panel no longer asks for it. Run `/reload` in a session to pick up config edits; `/mcp` shows connections and OAuth sign-in. Two notes: ① a legacy `disabled: true` written by older MPI builds is rewritten automatically to `enabled: false`; ② the built-in default `exposure` is `codemode`, so the model does not see a pile of `mcp__*` tools upfront — add `"exposure": "direct"` to a server entry when you want its tools declared directly.

### 13.4 Extension model pick (no popups)

Some extensions need a model and pop up to ask which one to use (the classic case: pi-web-access opens a browser curation window on every web search and asks which model should write the summary). With **Settings → Conversation → "Extension model pick"** (on by default):

- **No popup**: MPI answers an extension's model-selection request automatically, using this conversation's current model. Unattended scheduled runs behave the same way.
- **Web searches skip the browser window**: pi-web-access switches to the `auto-summary` workflow — a search returns an AI summary directly instead of opening the curation page; a single call can still pass `workflow: "summary-review"` for interactive curation.
- **Summary follows the conversation model**: at the start of each turn MPI writes the current model into `~/.pi/web-search.json` (shared with terminal pi), so switching models takes effect immediately. The summary deadline is raised to 5 minutes so slow local models still produce a full summary. Before its first edit MPI backs up the file's original values and restores them exactly when you turn the switch off.

### 13.5 Zhiya (persona / memory pool / project memory)

The **Zhiya** button at the bottom of the sidebar opens a narrow menu column (available in every build, not just dev):

| Module         | Purpose                                                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Persona        | `~/.pi/agent/zhiya/persona.md`, injected into every session's system prompt — see [4.7](#47-user-profile-now-part-of-zhiya). |
| Agreement      | A markdown of collaboration rules — a good place for hard rules like "always ask before X".                                  |
| Workspace      | A markdown describing your workspace layout.                                                                                 |
| Knowledge base | Browse the current project's `.alexandria/knowledge/` (file tree + MD preview).                                              |
| Current tasks  | Shows running tasks in the side panel.                                                                                       |
| Memory pool    | Browse / search / batch-process memory entries in the side panel.                                                            |
| Project memory | Manage the "dozen rules per project" — coarser than the memory pool; approved rules go into the project knowledge base.      |

Markdown modules open in the right-hand preview (editing them with Obsidian / VSCode works too); list modules (current tasks / memory pool / project memory) open in the right-hand side panel.

**The memory system has its own manual**: menu "Help → Memory system manual" (`resources/memory-manual.md`, shipped with the installer). It covers commands, the triage/proposal mechanism, file locations and troubleshooting; only the three most common concepts are here:

- **Memory pool** = the raw stream (one sentence per entry, raw material); **project memory** = finished products (one operation per entry, goes into the system prompt).
- **Automatic capture needs a model**: pick one under "Settings → Models & providers" → **Memory model** (below summary model) and the agent will start recording lessons from conversations automatically. Unset = no model calls at all: writing/searching/archiving still work, but there's no auto-capture and importance falls back to a default score. Changes apply to triage **immediately**, but auto-capture needs a **new session**.
- **Archiving is not deleting**: `/memory-forget` only moves an entry into the archive directory, recoverable at any time.

---

## 14. Terminal and Pi TUI

The right slot hosts two kinds of panels: **preview** and the **integrated terminal** — one at a time (the width is draggable, and the panel can be expanded or closed).

### 14.1 Integrated terminal (the default entry)

The **⌨ Terminal** button in the chat top bar opens a real terminal in the right slot:

- It runs **your own shell** (Git Bash on Windows), not pi — use it to type commands, watch output, and enter things that can't go through the composer (passwords, account logins).
- The working directory **follows the current session**: switching sessions changes the directory instead of leaving a shell in the old one.
- The panel header has "Reopen (clear + new shell)"; the width behaves like any other right-slot panel.
- Click the top-bar button again to close it (only one panel occupies the slot at a time).

### 14.2 Pi TUI (the older interactive mode, optional)

Older versions switched the whole session area into an interactive pi terminal; that is no longer the default entry. If you prefer it, it still shares the same session:

- Same session file and working directory, with history shared both ways; messages sent in the terminal are visible after switching back to the GUI;
- If a reply is in progress, it's aborted first automatically;
- Ways out: type `/exit` in the terminal, or switch to another session;
- The terminal resizes with the window.

> In short: **inspect files, read output, run commands → the integrated terminal**; **use pi's own TUI commands (`/fork`, `/model`, …) → Pi TUI**. They don't conflict.

---

## 15. Global Search (Ctrl+K)

The 🔍 button at the top of the sidebar or Ctrl+K opens global session search: type a keyword, it full-text matches titles and message content across all sessions. Checking the "Archive & trash" checkbox also searches archived sessions and trash entries; result rows carry status badges (Archived / Project archived / Trash) and each row has a "Restore" button that puts it straight back into the sidebar. Esc or the close key at the top right dismisses.

### 15.1 In-conversation search (Ctrl+F)

The 🔍 button at the far left of the conversation toolbar, or Ctrl+F, opens a search bar scoped to the current session:

- **It searches the entire history**, including "earlier conversation" that has already been compacted (when a hit is there, that whole segment is expanded and jumped to).
- **Navigation is per message** (no longer split into fragments); Enter / ↓ next, Shift+Enter / ↑ previous (wraps at both ends), auto-scrolling to the hit.
- The right side shows a "current/total" counter, or "No matches". Non-matching messages dim while the current match gets a highlight ring and a brief flash.
- Esc or × closes it, returning to normal reading (highlights removed).
- Thinking blocks and tool-call arguments are never searched.

### 15.2 Left message rail

The vertical dot rail on the left of the conversation shows a 20-character preview per row by default; **hovering (or tabbing to) a row pops up the full input text**, so long messages are readable without opening them. In compacted sessions the pre-compaction segment is part of the rail too.

---

## 16. Archive and Trash

The **Settings → Data management → Archive & Trash** page manages three kinds of entries, all grouped by project (group headers show project name + count, collapsible); the search box at the top filters all three (substring match on title/project name/path):

| Section           | Content                                                                                                               | Actions                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Archived projects | Whole archived projects                                                                                               | Restore project.                                                              |
| Archived sessions | Individually archived sessions (archive time shown; full file path on hover)                                          | Restore to the original project.                                              |
| Trash             | Deleted sessions (on by default; shows delete time + size used), with "Empty trash" in the header (with confirmation) | "Restore session" back to its project / "Delete forever" (with confirmation). |

Rules: archiving is a reversible tidying operation and doesn't touch the files themselves. Deleting goes to the trash first by default (`<userData>/trash/`); only deleting again from the trash is permanent. Turning off the trash switch in "Settings → Data management" makes deletes immediately permanent (entries already in the trash can still be restored or emptied).

Extras: several sessions can be handled at once (right-click → "Batch operations" for batch archive / delete / export, see [3.2](#32-sidebar-left)); exports produce **session packs** (zip) that import back into MPI, the same as [5.6](#56-exporting-a-session-pack).

> Quitting MPI also stops any app-store service that is still running (nothing is left behind in the background).

---

## 17. Settings Reference

**Settings** entries: ⚙ in the title bar, menu "Edit → Open settings…". There are 8 tabs: **Conversation / Models & providers / Permissions & security / Credentials / Server / Data management / Appearance / System & diagnostics**.

> **Draft + explicit save**: every tab except "Appearance" is "edit then save" — changes land in a draft, a save button appears in the tab header and a small dot marks the tab, and nothing is written until you click save (a "Saved ✓" confirmation appears); closing settings with unsaved changes warns first. The Appearance tab takes effect immediately and auto-saves — no manual save needed.

### 17.1 Conversation (default tab)

| Item                   | Notes                                                                                                                                                                                                                                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default thinking depth | Initial thinking level for new sessions; the model must support reasoning for it to apply.                                                                                                                                                                                                               |
| Hide thinking blocks   | When on, the agent's thinking is not shown — you only see the final reply.                                                                                                                                                                                                                               |
| Voice system           | Voice input (transcription service config + connection test) and voice output (system / Edge engine, voice / rate / preview / auto-read). See [Section 7](#7-voice-system).                                                                                                                              |
| Extension model pick   | When an extension needs a model, MPI uses this conversation's current model automatically instead of popping up; web searches skip the browser curation window (see [13.4](#134-extension-model-pick-no-popups)). On by default; turning it off restores the per-use prompt and `~/.pi/web-search.json`. |
| Diff display           | Two modes for edit-tool diffs, "Unified view / Split before-after", unified by default.                                                                                                                                                                                                                  |
| Handoff instructions   | The writing requirements given to the agent when it writes a handoff document (multi-line, editable). The default is already trimmed to 4 lines and no longer names a file path — MPI locates the file itself. See [5.2](#52-new-sessions-and-hand-off).                                                 |
| Default provider       | Initial provider for new sessions (written to `~/.pi/agent/settings.json`, shared with terminal pi).                                                                                                                                                                                                     |
| Default model          | Initial model for new sessions.                                                                                                                                                                                                                                                                          |

### 17.2 Credentials (local vault)

Stores **local-only** passwords / tokens / key passphrases (encrypted by the OS — DPAPI on Windows). Values **never leave this machine**. Use it for things the agent needs to get work done but that you don't want written into transcripts, logs or snapshots.

**Requirements and limits** (easy to get wrong):

| Field | Rule                                                                                             |
| ----- | ------------------------------------------------------------------------------------------------ |
| Name  | 2–64 chars, lowercase letters / digits / `._-` only (e.g. `aliyun-prod-root`); must be unique    |
| Kind  | Password / token / key passphrase / SSH key                                                      |
| Scope | Global, or limited to one project / directory                                                    |
| Value | Cannot be empty; if OS encryption is unavailable MPI **refuses to save** (no plaintext fallback) |

**Levels (what a remote session may do)**:

| Level           | Meaning                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Remote OK       | Remote sessions may use it directly (good for read-only / least-privilege accounts). Injected as an environment variable when the session starts. |
| Remote: confirm | Using it remotely requires one confirmation on your phone.                                                                                        |
| Local only      | Refused for every remote origin; local use only.                                                                                                  |

**How it is used**:

- The agent never sees the plaintext. It knows which credentials exist, whether they're usable and why not (e.g. "refused: local only"), and calls `mpi_secret_run` to run a single command with the value handed over as the environment variable `MPI_SECRET_VALUE` — **the value never enters the conversation**.
- "Remote: confirm" / "Local only" credentials run only after you approve the "run this command" card (shown on both desktop and phone).
- The list only shows a mask; clicking "Show" hides the plaintext again after **15 seconds** (so it doesn't sit on screen), and every reveal/copy is audited.
- Deleting asks for confirmation; a deleted credential is immediately invisible to the agent.

### 17.3 Server

Configure how phones / the web client reach this machine. Two cards:

- **Relay settings**: the built-in relay by default (fill in an activation code under "Activation" first); or tick "Custom relay (use my own)" and run your own — enter the relay address (`ws(s)://<host>:<port>/ws`) and access token, then click "Verify connectivity"; it counts as working once it reports the channel is reachable. The panel also carries a step-by-step "How to set up your own relay".
- **Activation**: device ID / device name / activation code. Without activation only the LAN and local relay work.

Notes: the relay only forwards data frames and never parses content (end-to-end encrypted); the token is sent only with host registration and mirror requests — it is not embedded in the pairing QR code and never sent to phones. Closing settings with unsaved changes warns you — previously editing without saving and restarting silently reverted to the old config.

### 17.4 Models & Providers

See [Section 4](#4-configuring-models). The top of the page has "Reload" and "Save models" buttons; model settings are written to `~/.pi/agent` (shared with terminal pi).

### 17.5 Permissions & Security

| Item                           | Notes                                                                                                                                                                                                                                                                      |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New session permission         | Read-only / Strict / Sandbox / Full, the initial level of subsequently created sessions. See [Section 8](#8-permission-modes).                                                                                                                                             |
| Trusted extension tools        | Searchable list of the extension tools seen in this profile's sessions, with All/Trusted/Untrusted tabs and toggles to trust/untrust in one click; a manual name input sits at the bottom as fallback.                                                                     |
| Trusted tools (always allowed) | The "Trusted" tab of the list shows everything currently trusted; click a row or its toggle to remove it. Trusted extension tools skip approval under sandbox/strict (e.g. `mem0_memory`). Read-only is unaffected; `bash` and file write/edit tools can never be trusted. |

Click "Save permissions" in the tab header to apply.

### 17.6 Data Management

Three sections: **Storage locations**, **Archive & Trash**, and **Backup & restore**, plus the trash switch.

| Item              | Notes                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trash             | Deleted sessions go to the trash first (recoverable); turning off makes deletes immediately permanent. See [Section 16](#16-archive-and-trash).                                                                                                                                                                                                                                                    |
| Storage locations | Two independent locations can be moved anywhere: **Session storage location** (default `~/.pi/agent/sessions`, all pi session records `.jsonl`; changing it also syncs `sessionDir` in `~/.pi/agent/settings.json` so terminal pi follows) and **Todo data location** (default app config dir `%APPDATA%\MPI`, holding `todos.json`, attachments `todo-attachments\`, agent inbox `todos-inbox\`). |
| Archive & Trash   | See [Section 16](#16-archive-and-trash).                                                                                                                                                                                                                                                                                                                                                           |
| Backup & restore  | Two independent targets (app settings / sessions), each with export/import (below).                                                                                                                                                                                                                                                                                                                |

A change takes effect in two steps: picking a new folder only records the intent, an amber warning appears under the row ("Location changed; files move on next launch. Until then the app still reads the old location"), and after fully quitting MPI and restarting, all files are moved to the new location before the window opens. Migration rules:

- Session files sit flat in a custom directory (pi's sessionDir layout never nests per project); "Reset" re-nests them into `sessions/<project dir>/` using each file's header cwd;
- Path references inside settings that point at old sessions (permission records, drafts, trash index, AI-todo source-session links) are updated automatically;
- A pre-existing `todos.json` in the target is never clobbered: that part stays pending and retries on the next launch (other files still move); failed parts likewise stay pending;
- Attachments from old locations keep working after the move.

When a custom location is set, each row shows a "Reset" button; hover the path text to see the currently effective directory. Migration results are logged in the console (`[migration]`).

Backup & restore (two independent targets):

- **App settings**: exports the app configuration (`config.json`: theme, language, pins, avatars, user profile, automations, remote signaling…) as a single JSON file (default name `mpi-config-backup-<date>.json`). Import first shows how many recognizable settings the file contains and asks for confirmation; on confirm it overwrites only those fields (everything else is kept). Model providers / thinking defaults live in `~/.pi/agent` (shared with terminal pi) and are not part of this backup; machine-specific items (pi path, window position) are never restored.
- **Sessions**: tick the projects to export (select all / clear, each row shows session count and size), packaging their raw session JSONL files into a zip (`mpi-sessions-backup-<date>.zip`, project directory structure preserved). Import first reports "N new / M already present": by default only new sessions are imported and existing files are skipped; choose "Overwrite all" to restore from the backup instead. Imported sessions reappear under their original projects (the sidebar refreshes automatically).

Typical uses: migrating to a new PC, or taking a snapshot before big changes.

### 17.7 Appearance

This tab takes effect immediately and auto-saves — no manual save needed.

| Item         | Notes                                                                                                                                                                              |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Avatars      | Upload custom chat avatars for "User" and "MPI agent"; images are compressed locally to ≤192px before saving, never uploaded anywhere. Can "Restore defaults" (Nobita / Doraemon). |
| Theme mode   | A "Follow system" checkbox + light/dark preview cards; click to switch instantly.                                                                                                  |
| Accent color | 7 options: Follow theme (default), White, Light gray, Dark gray, Green, Red, Blue; the send button and selection highlights follow it.                                             |
| Language     | UI language (Chinese / English).                                                                                                                                                   |
| Window zoom  | 50%–150%, shortcuts Ctrl+= / Ctrl+- (25% steps), Ctrl+0 to reset; persists across restarts.                                                                                        |

### 17.8 System & Diagnostics

| Item                 | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Launch at startup    | Start MPI automatically when logging in (on Windows via the Start menu's Startup folder).                                                                                                                                                                                                                                                                                                                                                                                |
| App update           | Current/latest version, "View changelog" (bundled changelog, no network needed; footer includes SHA256 install verification steps), and "Install and restart" when a new version is found. **Download order**: when "Server" is set to the built-in server with an activation code, the relay mirror is tried first and GitHub is the fallback if it's unreachable or serves an older version; a custom server doesn't mirror installers, so it goes straight to GitHub. |
| Update Pi core       | Manages the bundled pi runtime version. Update extensions in the "Extensions" panel instead.                                                                                                                                                                                                                                                                                                                                                                             |
| Idle session reclaim | Session processes idle for more than 2 hours are stopped to free memory (a built-in default, no setting exposed); the list shows "reclaimed" and opening one restarts it with history and drafts intact.                                                                                                                                                                                                                                                                 |
| Pi runtime           | Shows node, node version, pi cli.js, pi version and other runtime status.                                                                                                                                                                                                                                                                                                                                                                                                |
| Config files         | Actual paths of each config file (`models.json` / `settings.json` / `auth.json`), clickable to open in File Explorer. Model/thinking settings are written to `~/.pi/agent` (shared with terminal pi); other settings live in the app config directory; check here first when troubleshooting "I changed it but nothing happened".                                                                                                                                        |

### 17.9 Developer-build-only features (not visible to regular users)

Visible only in unpackaged **development builds**; the released build has none of these entries, so regular users can skip this.

- **Developer tools**: the dropdown right of "Help" in the title bar, with three items:
  - **Automated tests**: opens the test panel, listing cases grouped by feature; run logic cases, simulate scenario cases with a real session, and browse history.
  - **One-click dev release**: the maintainer flow for starting a release review (shows version, worktree status, GitHub token, etc.).
  - **Write user manual**: opens a new session that syncs this manual from the changelog via the project's user-manual skill.

> These are maintainer tools, not part of the regular user-facing feature set.

---

## 18. Phone Remote Control (web / Android)

Entry: the phone icon at the bottom of the sidebar ("Phone remote control (cloud relay)"). The panel has just two blocks — **pairing** and **devices**.

### 18.1 Pairing

Opening the panel generates a QR code automatically (with a countdown; the ticket expires after **5 minutes** — click "Regenerate" when it does). On the phone:

1. Scan the code (or copy the "another computer" link into that machine's browser); the app link can also be pasted into the Android app's pairing box.
2. After the desktop (or the phone) confirms, the device appears under "Trusted devices".

One known trap: **a ticket can only exchange for one device identity**, so a QR code handed to a second phone fails — each phone scans its own.

### 18.2 Device management

- **Pending**: appears only when something is waiting; approve or deny each one.
- **Trusted devices**: online first; rename or revoke at any time. The same phone doesn't bind twice (devices are recognised by public key, and an offline device with the same name is replaced).
- The status line at the top has a "Diagnostics" fold: the address the phone will connect to, the LAN entry, the LAN switch and raw error codes — check here first when a connection fails.

### 18.3 Transport and security

- Phones don't connect to the desktop directly; they go through the **relay** (configured under [Settings → Server](#173-server)), which only forwards data frames and never parses content.
- The host does **identity pinning**, so the relay can't impersonate your desktop by swapping public keys.
- Permissions are more conservative on the phone: even when the desktop is sandbox/full, **sensitive commands still need confirmation on the phone**, and enforced read-only (task modes) is never bypassed there.

### 18.4 Session config syncs both ways (permission / model / task mode / thinking level)

Change it on the phone and the desktop updates immediately; change it on the desktop and the phone does too. All four settings travel over the same broadcast:

| Direction       | Action                                                             | Result                                                                               |
| --------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Phone → desktop | Switch permission, model, task mode or thinking level on the phone | Written to the desktop config and the live permission gate; the desktop UI refreshes |
| Desktop → phone | Change the same four on the desktop (or let the agent change them) | The phone's chips and task mode follow without reopening the session                 |
| Phone → phone   | Several pages open on the same phone                               | The newer page takes over the write lease and the older one backs off                |

Two details worth knowing:

- **The phone only shows two permission levels**: "sandbox" and "full". Read-only or strict on the desktop is collapsed into one of those two on the phone; check the desktop for the exact level.
- **Only one device can modify a session at a time**: write operations need the write lease (30 seconds by default, renewed on every write). If another device holds an unexpired lease you'll be told "this session is being operated on by another device". The lease is released when the connection drops.

> In practice you can hand a task to the desktop and then loosen or tighten its permissions from your phone on the road, without going back to the machine.

### 18.4 What you can do from the phone

The web client (PWA) and the Android app behave the same: the conversation is the home screen (no separate session list up front), you can switch sessions, send text / images / video / audio (attachments go direct; large videos are fetched only when opened, and viewed videos are cached locally so the second open doesn't re-download), fill in multi-question choice panels, "hand off to a new chat", approve permission prompts, rename / pin / delete sessions, and switch permission / model / task mode / thinking level (synced both ways with the desktop in real time, see [18.4](#184-session-config-syncs-both-ways-permission--model--task-mode--thinking-level)).

A few phone-only conveniences:

- **Context usage is visible too**: the same usage ring appears on the phone and it can start a compaction.
- **New version prompts**: the web client shows "New version · tap to refresh" instead of leaving you on stale code.
- **Drag and paste attachments**: the web client accepts dragged files and pasted images too.
- **Foreground re-sync**: coming back to the page fetches only the delta instead of resetting the whole view (events that happened while disconnected aren't lost).

> The Android shell adds a top-right `⋮` menu, QR pairing, native recording and APK self-update.

---

## 19. Messaging Channels (Feishu / WeChat)

Message your MPI from Feishu or WeChat: DM the bot (Feishu also supports @-mentions in groups), and the message runs in a dedicated session under the bound project. Feishu replies stream back into that same message; WeChat shows a typing indicator while working, then delivers the result as a new message. Both channels are online only while MPI is running.

### 19.1 Enabling the Channel

Open **Sidebar → Messaging channels** (the fourth item below "New session / Automations / Extensions"). The left column lists the channels — Feishu / WeChat; click to switch.

Recommended: one-click setup via QR. Click "📱 Pick or create app via scan" in the quick-setup card and scan with mobile Feishu; on the confirm page choose either **an existing app** (reuse a bot already created under your enterprise — the page shows which scopes/events will be added and asks you to re-authorize) or **create a new one** (a bot app is created under your enterprise with scopes and event subscription pre-configured). Either way its credentials are written straight to local config. No console steps needed, and the App Secret never leaves this machine. If QR setup is unavailable for you, use the manual method below:

| Field                 | Description                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Enable Feishu channel | Master switch; no connection is made while off                                                                           |
| App ID / App Secret   | Credentials of your custom app from the Feishu Open Platform (the secret stays on this machine and is never shown again) |
| Bound project         | The folder where messages run; a dedicated session named "Feishu bridge" is created there automatically                  |
| Session permission    | Sandbox (default, blocks operations that need confirmation) / Full access                                                |

Click **Save configuration** to apply immediately. Status light at the top: gray = off, blinking amber = connecting/reconnecting, green = connected, red = failed (details below).

**WeChat**: click "📱 Connect WeChat via scan" in the quick-setup card and confirm with mobile WeChat (some accounts are asked for a numeric verification code); credentials are saved automatically — no enterprise setup or callback URL needed. Then pick the bound project, flip the master switch, and **Save configuration**. Once bound, the masked bot id is shown and "Re-scan to connect" replaces the current binding; the status light works as for Feishu.

### 19.2 Creating a Feishu App (First Time)

> ⚠️ Prerequisite: you need an enterprise/organization. The Feishu Open Platform requires custom apps to live under an enterprise tenant, and WebSocket event push only works for enterprise custom apps. If your account is on the personal plan (no organization), create your own free enterprise first (individuals can create one, no business license needed; you become its admin). Otherwise you'll hit "connects fine but never receives messages" with no publish option in the console.

1. Sign in at [open.feishu.cn/app](https://open.feishu.cn/app) (create an enterprise first if you don't have one);
2. Create a custom (enterprise) app; note the App ID and App Secret on "Credentials & Basic Info";
3. Add the Bot capability under App Capabilities → Bots;
4. Enable scopes: `im:message.p2p_msg:readonly` (receive p2p messages), `im:message.group_at_msg:readonly` (receive group @-mentions of the bot), `im:message:send_as_bot` (send as the app);
5. On Events & Callbacks, choose WebSocket long-connection mode and subscribe to event `im.message.receive_v1`;
6. Create a version and publish it (or set a test availability scope first).

> Long-connection mode needs no public IP or tunneling; MPI connects straight to Feishu's WebSocket endpoint. The panel includes this guide as well.

### 19.3 Usage and Commands

- DM: send plain text to the bot;
- Groups: @-mention the bot (only messages that mention it are processed; requires `im:message.group_at_msg:readonly` and adding the bot to the group);
- If the bound folder isn't an MPI project yet (no sessions), saving the config auto-pins it in the sidebar so you can see where Feishu chats land;
- Replies start with a "🤔 Working on it" placeholder, then stream updates as the agent works, finalizing when done; very long output is truncated (full result in the MPI session).

The WeChat channel supports **p2P text messages only** (no groups; images/files not yet): DM the bot with plain text, a typing indicator shows while working, and the result arrives as a new message. One WeChat account binds to one MPI instance.

Commands (Feishu / WeChat alike): `/new` starts a fresh session (the old one is kept), `/list` lists recent sessions in this project, `/use <n>` switches to that session (e.g. `/use 2`; a session id also works), `/help` shows help. The active session is remembered and restored after restart (falls back to the channel's dedicated session if it no longer exists).

Feishu MCP: the "Enable Feishu MCP" button at the bottom of the form writes the official `@larksuiteoapi/lark-mcp` (npx stdio) into `~/.pi/agent/mcp.json` using the current channel credentials, so agents in sessions can call Feishu APIs directly (default tool set: messages / docs / calendar / Bitable…). Applies to new sessions; manage it under Extensions → My MCP. Requires local Node.js ≥ 20.

One message at a time: sending while busy gets a "still processing" notice.

### 19.4 Notes

- The channel is online only while MPI runs; messages sent while MPI is off (or the connection is down) are not received;
- Avoid driving the same dedicated session from both desktop and the chat app at once;
- Changing the bound project creates a new dedicated session in the new project ("Feishu bridge" / "WeChat bridge");
- The WeChat channel is Tencent's gray-release personal-WeChat bot: if scanning does nothing or reports unavailability, your account may not be in the rollout scope yet; when credentials expire the channel stops on its own and the panel asks you to re-scan.

---

## 20. App Store

The **App Store** is MPI's **application-loading platform** (think WeChat mini-programs): MPI only handles **import, install, host, and uninstall**. Everything that makes up an app — manifest, service code, runtime dependencies, models — is prepared by its developer and imported as a package; **the MPI installer ships no app payload**. An app is a **self-contained package** that may include ①**a service module** (runs in the MPI main process to probe/start a service and report status + logs), ②**Pi extensions** (injected into new sessions when enabled), and ③**its own runtime and models** (bundled in the package, ready to use on import). Enabling writes the corresponding settings (disabling restores them exactly — fields you edited by hand are never clobbered) and loads the app's service and extensions.

> **Trust notice**: apps with a service module or extensions run with full MPI main-process privileges (the same trust model as Pi plugins — there is no sandbox in this round). That's why **installing an app that declares capabilities shows a confirmation dialog** listing what it asks for (e.g. “Start and manage child processes”, “Make network requests”). Only install apps from sources you trust.

> How this differs from **Extensions**: Extensions manage general Pi skills / packages / MCP servers; apps in the App Store wire up features of the MPI client itself and may ship their own extensions. The two don't interfere.

### 20.1 Opening and Importing Apps

1. Click **App Store** in the left sidebar (below “Extensions”).
2. Import an app in one of two ways:
   - **Install from zip**: pick a self-contained `.zip` prepared by the developer (manifest + service + runtime + model).
   - **Load folder**: pick an already-extracted app folder (containing `mpi-app.json`); use this when you want to edit the app's files yourself.
3. After import a card appears: app name, version, category, description, and current state (Installed / Enabled).
4. Click any card to open its detail page with the setup guide and config form; use the arrow at the top-left to go back.

### 20.2 The First App: Local Voice Service (works right after install)

This app connects **offline speech recognition** to MPI's voice input (the microphone button), enabling fully offline dictation. It **bundles its own runtime and model**: on enable it **starts a local recognition service** using the sherpa-onnx runtime and SenseVoiceSmall model inside the package — nothing for you to install or deploy beforehand.

**Steps**:

1. Install **Local Voice Service** from zip (the first time shows a **capability confirmation** listing “Start and manage child processes” and “Make network requests”; confirm to continue).
2. The form on the detail page is best **left at its defaults**:
   - **External endpoint**: empty = use the app's bundled service; if you already run your own OpenAI-compatible STT server, put its `/v1` root here (e.g. `http://127.0.0.1:8820/v1`) and the app will **not** start the bundled service, only probe it.
   - **Bundled service port**: default `8800`; if it's taken the app picks a free port automatically.
   - **Model**: default `SenseVoiceSmall`.
3. Click **Enable app** → the detail page shows a **service status** (Starting / Running / Error / Stopped) and a **Show log** button. The first start loads the model and may take ten-plus seconds; when it reads **Running** the app is wired in.
4. Open Settings → Conversation → Voice System to double-check: the transcription service is OpenAI-compatible and points at `http://127.0.0.1:8800/v1`. From then on the microphone button uses this bundled service.
5. If the status shows **Error**, click **Show log** for the reason, and **Restart** to retry.

### 20.3 Building / Packaging Your Own App

An app package is a **self-contained zip** whose root needs at minimum one `mpi-app.json` (manifest + config form, plus optional service / Pi extensions / capability declarations). To ship a runtime and model, use the conventional `runtime/` and `model/` folders; a service module can launch its bundled Node service directly via `host.execPath` + `ELECTRON_RUN_AS_NODE`, with no external node/python.

- Reference implementation and docs: `examples/apps/local-voice/` in the repo (see its `README.md` for the packaging flow).
- One-command packaging: `node scripts/build-app-pack.mjs --app=examples/apps/local-voice` (prepares the current-platform runtime and model and produces `<id>-<platform>-<arch>.zip`).
- Once you have the zip, import it in the App Store via **Install from zip**.

> App packages run with full MPI main-process privileges (no sandbox). Only install packages from sources you trust.

### 20.4 Disabling and Uninstalling

- **Disable (restore settings)**: rolls back only the fields this app wrote; a field you edited by hand after enabling keeps your edit and is not reverted. It also **stops any service process the app launched** (the bundled service stops with it) and unloads the app's own Pi extensions (new sessions no longer load them; extensions you keep in `~/.pi/agent` are untouched).
- **Uninstall**: asks for confirmation. Removes the installed files and saved form values; if the app was enabled, it disables first and restores settings.

### 20.5 Troubleshooting

**Service status stays Error / Stopped**
Open **Show log** to read the probe/start result. If you're using the bundled service, make sure the package's `runtime/` and `model/` are present (the zip may be incomplete); if you set an external endpoint, connection refused usually means the server isn't running or the port is wrong. Fix it and click **Restart**.

**Voice input still uses the old service after enabling**
The app writes to Settings → Conversation → Voice System; if you changed the transcription service manually afterwards (e.g. switched back to the cloud), MPI follows your latest manual choice — by design. To use the local service again, enable the app once more.

**The list is empty**
That just means no app has been imported yet. Click **Install from zip** or **Load folder** at the top to import your first app.

---

## 21. Keyboard Shortcuts

| Shortcut            | Action                                                                                                                                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Enter`             | Send message; while the agent is running = save as pending follow-up                                                                                                                                      |
| `Shift+Enter`       | Newline in the composer (Enter during IME composition only confirms the candidate)                                                                                                                        |
| `Alt+Enter`         | Insert into context immediately while running (steer)                                                                                                                                                     |
| `Ctrl+N`            | New session in place in the current project (prompts for a folder first if none is open). To keep context, use the top-bar 🔀 "hand off to a new chat" instead (see [5.2](#52-new-sessions-and-hand-off)) |
| `Ctrl+K`            | Global session search                                                                                                                                                                                     |
| `Ctrl+F`            | In-conversation search (includes compacted "earlier conversation"; Enter/Shift+Enter for next/previous match, Esc to close)                                                                               |
| `Ctrl+,`            | Open settings                                                                                                                                                                                             |
| `Esc`               | Close popovers / dismiss menus; **while the agent is running and focus is outside the composer = stop this turn**                                                                                         |
| `Ctrl+=` / `Ctrl+-` | Window zoom ±25%                                                                                                                                                                                          |
| `Ctrl+0`            | Reset window zoom to 100%                                                                                                                                                                                 |

---

## 22. Data and Configuration Locations

| Content          | Location (Windows)                                                                                           | Notes                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pi agent config  | `%USERPROFILE%\.pi\agent\`                                                                                   | `models.json`, `settings.json`, `auth.json`, extension/skill/MCP configs, shared with terminal pi.                                                         |
| Session files    | `~/.pi/agent/sessions/` (organized by project; changeable in Settings → Data management → Storage locations) | JSONL format; broken-session repair backups in `sessions/mpi-repair-backups/`. Location changes migrate automatically on next launch; terminal pi follows. |
| App config       | `%APPDATA%\MPI\config.json`                                                                                  | General settings: theme, language, avatars, default permission, etc.                                                                                       |
| Drafts           | `%APPDATA%\MPI\drafts.json`                                                                                  | Unsent input; last 40 kept.                                                                                                                                |
| Todo tasks       | `%APPDATA%\MPI\todos.json` (changeable in Settings → Data management → Storage locations)                    | Per-project todos; agent writes arrive via the `todos-inbox/` inbox and are deduped on ingest.                                                             |
| Todo attachments | `%APPDATA%\MPI\todo-attachments\` (changeable in Settings → Data management → Storage locations)             | Image/file attachments for todos, stored as copies; existing ones stay put after a location change and are cleaned up when a todo is deleted.              |
| Trash            | `%APPDATA%\MPI\trash\`                                                                                       | Deleted session files.                                                                                                                                     |
| Memory pool      | `~/.pi/agent/zhiya/pool/`                                                                                    | Source of truth for Zhiya memories (entries / proposals / index); not in git. See "Help → Memory system manual".                                           |
| Persona etc.     | `~/.pi/agent/zhiya/`                                                                                         | `persona.md` (persona), agreement and workspace markdown files; editable with an external editor.                                                          |
| Bundled runtime  | `%APPDATA%\MPI\runtime\versions\…`                                                                           | Extracted on first launch; the built-in npm used for package installs lives here too.                                                                      |

Dev (development build) and production installs have independent config directories (`%APPDATA%\MPI Dev` ↔ `%APPDATA%\MPI`) and don't interfere with each other; a brand-new profile inherits language and theme from its sibling profile on first launch.

> API keys are user data: never commit `auth.json`, session files or screenshots containing keys to repositories, and don't share them.

---

## 23. FAQ

**Model selector shows "No available models"**
Go back to "Settings → Models & Providers" and confirm you saved; check API key, Base URL (mind `/v1`), API type and model ID one by one, using "Test availability" to pinpoint the problem. If it still fails, reopen the session once.

**`max` (or some level) is missing from thinking levels**
Make sure "Thinking" is enabled on the model card and `thinkingLevelMap` doesn't hide that level; even if visible in settings, a level the vendor's live capability list doesn't support won't be shown.

**New session didn't appear under the project**
Sessions are usually persisted only after the first message is sent. Send a task first, wait until Pi starts replying or finishes, then check the left list.

**Files tab isn't showing the current project**
The file tree follows the current session's project folder. Switch to the target session first, then look at the "Files" tab.

**Content was generated but preview didn't update / no file artifacts**
Confirm the artifact path in chat matches the current project; if Pi only pasted Markdown into the chat without writing a file, follow up with "please actually write that content to docs/result.md". Files modified by external programs just need the preview reopened.

**My input disappeared after a send failure?**
It shouldn't: any send failure fully restores text/images/attachments into the composer and shows an error toast (see 6.5). If you see unresponsive user bubbles in a session, that's legacy behavior from an older version; upgrading to the latest fixes it.

**Session suddenly can't continue; provider rejects history**
Check whether the red "one-click repair" banner appeared above the composer; if so, click repair (the original file is backed up automatically); if not, report the error message to the maintainers.

**"Hand off to a new chat" spins forever / no new session appears**
A handoff genuinely runs one model turn (writing the document), so tens of seconds is normal — the button reads "Handoff in progress…". If nothing happens after a minute or two, check whether the current session is nearly out of context (compact first) or whether the model service is unreachable (look for an error banner). It never damages the original session. If you just want a blank session quickly, long-press / right-click the same button for "new session in place".

**A session in the list shows "reclaimed"**
Expected: after 2 hours idle the process is stopped to save memory; opening it restarts automatically with history and drafts intact.

**A credential won't save**
Names must be 2–64 chars using lowercase letters / digits / `._-` only, and the value can't be empty. "Encryption unavailable" means OS-level encryption isn't available in this environment (some stripped-down systems / missing keyring); MPI **refuses to save** rather than fall back to plaintext — that's deliberate.

**Taskbar icon still old after upgrade/reinstall**
Windows caches icons by path; MPI already works around this with content hashing. A full app restart shows the new icon.

**Package install fails with `spawn npm ENOENT` / git-related errors**
Only possible on older versions: MPI now bundles npm, so installs work without Node.js; git-source installs require Git to be installed (a clear hint appears when missing). If you manually changed `npmCommand` in `settings.json`, make sure that command actually works.

**Do dev and production data mix?**
No. Their config directories are separate (`MPI Dev` / `MPI`), but they share the same `~/.pi/agent`; models, extensions and session history are common by design.

---

_This manual is written for MPI 0.13.x; UI wording follows the English interface (Chinese-interface terms are annotated where needed). For feature changes, refer to the changelog under "Settings → System & diagnostics → App update → View changelog"._
