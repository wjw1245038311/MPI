# MPI User Manual

Applies to: MPI 0.5.x (Windows x64 / macOS arm64)

This manual covers all major features of MPI. If you only need to get the first workflow running, start with [MPI-BEGINNER-GUIDE.md](MPI-BEGINNER-GUIDE.md); this document is organized as "interface → configuration → sessions → advanced features" and is meant for reference on demand.

---

## Table of Contents

1. [Getting to Know MPI](#1-getting-to-know-mpi)
2. [Installation and First Launch](#2-installation-and-first-launch)
3. [Interface Overview](#3-interface-overview)
4. [Configuring Models](#4-configuring-models)
5. [Projects and Sessions](#5-projects-and-sessions)
6. [Chatting with the Agent](#6-chatting-with-the-agent)
7. [Permission Modes](#7-permission-modes)
8. [Context Management](#8-context-management)
9. [File Preview and HTML Element References](#9-file-preview-and-html-element-references)
10. [Automations (Scheduled Tasks)](#10-automations-scheduled-tasks)
11. [Extensions: Skills / Packages / MCP](#11-extensions-skills-packages-mcp)
12. [Pi TUI Terminal Mode](#12-pi-tui-terminal-mode)
13. [Global Search (Ctrl+K)](#13-global-search-ctrlk)
14. [Archive and Trash](#14-archive-and-trash)
15. [Settings Reference](#15-settings-reference)
16. [Android Phone Remote Control](#16-android-phone-remote-control)
17. [Messaging Channels (Feishu)](#17-messaging-channels-feishu)
18. [Keyboard Shortcuts](#18-keyboard-shortcuts)
19. [Data and Configuration Locations](#19-data-and-configuration-locations)
20. [FAQ](#20-faq)

---

## 1. Getting to Know MPI

MPI is a standalone desktop client for the [Pi coding agent](https://github.com/earendil-works/pi) (a personal fork of Pi Studio, with no affiliation to or official endorsement by the Pi maintainers). It brings projects, sessions, model configuration, extensions, permission control, scheduled tasks and file preview into one desktop workspace.

A few key concepts:

| Concept | Description |
| --- | --- |
| **Project** | A local folder. Pi reads code, creates files and performs operations inside that directory. |
| **Session** | One continuous conversation with the agent, backed by a session file. A project can have multiple sessions. |
| **Permission mode** | The level controlling which operations Pi may perform automatically: Read-only / Strict / Sandbox / Full. |
| **Extensions** | pi's skills, extension packages (npm/git/local) and MCP servers, all managed in the "Extensions" panel. |

Relationship to terminal pi: MPI **shares the same agent configuration directory `~/.pi/agent`** with the command-line pi — models, API keys, extensions, skills and MCP config are common to both; an extension installed in the terminal is immediately available on desktop, and vice versa. Session files also live under that directory, so the terminal and the desktop client see the same session history.

Every installer ships a pinned Node.js + Pi runtime (`MPI-Runtime-*.tar.gz`) — **no separate Node.js installation needed**. On first launch MPI verifies and extracts the bundled runtime into the user data directory; later app updates reuse the extracted runtime without re-downloading.

---

## 2. Installation and First Launch

### 2.1 Installers

| Platform | File | Notes |
| --- | --- | --- |
| Windows x64 | `MPI-Setup-<version>.exe` | NSIS installer, double-click to run. |
| macOS (Apple Silicon) | `MPI-<version>-arm64.dmg` | Drag-to-install. |

Installers are **not code-signed yet**; the OS may show a security warning on first run — this is expected. Continue once you've confirmed the source is trustworthy.

### 2.2 Windows installation steps

1. Double-click `MPI-Setup-x.y.z.exe` to start the wizard.
2. If SmartScreen shows "Windows protected your PC": click **More info → Run anyway**.
3. Follow the wizard (the default install path is fine).
4. Launch MPI from the desktop shortcut or Start menu.

### 2.3 macOS installation steps

1. Double-click `MPI-x.y.z-arm64.dmg` and drag the MPI icon into "Applications".
2. Gatekeeper may block the first launch: in Applications, **right-click MPI → Open** and confirm; or allow it once under "System Settings → Privacy & Security".

### 2.4 Verifying the installer (optional)

If a `.exe.sha256` file with the same base name ships next to the installer, verify integrity first: run `Get-FileHash .\MPI-Setup-x.y.z.exe -Algorithm SHA256` in PowerShell and compare the output character by character with the sidecar file. You can also view verification steps inside the app: **Settings → About MPI → View changelog** (the modal footer includes "How to verify the install").

### 2.5 First launch

1. Start MPI; the first run extracts the bundled runtime, so give it a moment before the main window appears.
2. Open **Settings → Models & Providers** and add your first model (see [Section 4](#4-configuring-models)).
3. Click `+` next to "Projects" on the left to open a local folder as a project.
4. Click "New session" and send your first message.

### 2.6 Launch at startup

**Settings → General → Launch at startup**. When enabled, MPI starts automatically when you log in (on Windows this creates a shortcut in the Start menu's Startup folder). Unchecking removes it.

---

## 3. Interface Overview

The main window has four areas:

```
┌────────────────────────────────────────────────────────────┐
│ Title bar: brand · File/Edit/View/Help menus · status · ⚙ │
├──────────┬─────────────────────────────────┬───────────────┤
│ Sidebar  │ Session area (chat / TUI)       │ Preview pane  │
│ (left)   │ (center)                        │ (right, toggl)│
│ · Proj.  │ · Top bar: title/folder/actions │ · Markdown/HTML│
│ · Sess.  │ · Messages + tool cards         │   /code/img…  │
│ · Files  │ · Composer (attach/cmds/perms)  │               │
└──────────┴─────────────────────────────────┴───────────────┘
```

### 3.1 Title bar

- **Left menus**:
  - `File`: New session, Open folder…
  - `Edit`: Copy / Cut / Paste / Delete, Open settings…
  - `View`: Collapse/expand sidebar, Toggle preview panel
  - `Help`: User manual, About MPI
- **Center**: status text (current session name · model, or "Pi ready").
- **Right**: ⚙ open Settings; minimize / maximize / close window.

### 3.2 Sidebar (left)

Top to bottom:

1. **Top button row**: 🔍 global search (same as Ctrl+K), collapse sidebar.
2. **Quick entries**: three labeled buttons — "New session", "Automations" (clock icon), "Extensions" (plug icon) — opening a new session, the [automations panel](#10-automations-scheduled-tasks) and the [extensions panel](#11-extensions-skills-packages-mcp) respectively.
3. **Tabs**: `Sessions` / `Files`.
   - "Sessions" tab: project list + each project's session list.
   - "Files" tab: file tree of the current session's project; click any file to open it in the preview pane; **file rows can be dragged straight into the composer as attachments** (folders are not draggable).
4. **Project area**:
   - `+` button: open a folder (create/pick a project).
   - Each project row: name, session-count badge, `+` (new session in that project), star pin button.
   - Right-click a project: **Move up / Move down** (pinned items only), Open in File Explorer, Pin/Unpin project, Archive project.
5. **Session area**:
   - Top is the **pinned zone**, below it recent sessions sorted by activity time.
   - Each session row has a **permanent star button** on the right (outline = unpinned, filled = pinned); click to toggle; hovering also reveals archive and delete icons.
   - Right-click a session: **Move up / Move down** (pinned items only), Pin/Unpin session, Clone session, Delete.
   - **Drag sorting**: drag within the pinned zone to reorder; dragging a recent-zone entry into the pinned zone pins it at that position; dragging a pinned entry out to the end unpins it.
6. **Bottom usage row**: always shows "Today · Total" (token counts in compact k/M format). Hover for today/total breakdown, cost and total session count; refreshes automatically after each stream ends and polls every 60 seconds (terminal pi activity is counted too).

The sidebar width can be adjusted by dragging its right edge; double-click resets to default.

### 3.3 Session area (center)

**Top bar**:

- Left: session title (**double-click to rename**), working folder path (hover for the full path, click to open in File Explorer), connection status hint.
- Right buttons (left to right): ⭐ pin/unpin current session, ✎ rename, 📁 switch working folder, ＋ new session (start a fresh conversation in the current context), ⌨ **Terminal** (switch to Pi TUI, see [Section 12](#12-pi-tui-terminal-mode)), 👁 toggle preview.

**Message list**:

- User messages on the right (default avatar "Nobita"), agent replies on the left (default avatar "Doraemon"); avatars are customizable in Settings.
- **Tool cards**: every tool call by Pi (read file, run command, edit, …) produces a card you can expand to see arguments and results. Diffs from `edit`-type tools **auto-expand** into a git-style single-column view (context lines + colored `-`/`+` lines); multi-replacement edits show an "N replacements" badge in the header; once collapsed manually it won't force-open again.
- **File artifact chips**: files Pi writes/modifies appear as chips under the message; click to open them in the preview pane.
- **Dot navigation**: with ≥2 user messages, a vertical dot rail appears on the left of the chat area; hover for a message preview, click to jump.
- **Jump to latest**: after scrolling up away from the bottom, a circular double-arrow floating button appears at the bottom right; click to smooth-scroll back to the latest.
- While streaming, output auto-follows the bottom; manual scroll-up reading isn't yanked back — follow resumes near the bottom and settles at the very end of each turn.

**Composer**, left to right:

| Control | Purpose |
| --- | --- |
| `+` | Add file/image attachments |
| `/ Commands` | Open the slash-command menu (built-in commands, extension commands and skills) |
| Permission pill | Switch the current session's permission mode (four levels, see [Section 7](#7-permission-modes)) |
| Ring button | Context usage progress ring + detail popover (see [Section 8](#8-context-management)) |
| Model pill | Pick provider / model / thinking level, plus "Session tools" (completion sound toggle) |
| Send / Stop | Send the message; becomes a "Stop" button while the agent is running |

Above the composer, the current working folder is shown (click to switch project). Unsent input (text, images, attachments) is **saved as a draft per session** and restored when you reopen that session after an app restart.

### 3.4 Preview pane (right)

Toggle it from "Toggle preview" in the chat top bar (or the View menu). It renders/highlights Markdown, HTML, source code, images and common office documents — see [Section 9](#9-file-preview-and-html-element-references).

---

## 4. Configuring Models

MPI manages providers and models through Pi's shared `models.json` (in `~/.pi/agent`) — fully compatible with terminal pi.

### 4.1 Adding a provider

The **Settings → Models & Providers** page has two sections: **Preset providers** on top and **My providers** below.

- **Quick add from presets**: the top section lists common platforms as cards (Bailian pay-as-you-go API / Coding Plan, Zhipu GLM, DeepSeek, Kimi / Moonshot, Gemini, GPT / OpenAI), plus two entry points — "Custom config" and "Local deploy" (self-hosted services such as LM Studio or Ollama go through here). Clicking a platform card opens the add form prefilled with its URL, API type and first model; just enter your API key (adjust as needed) and add it. A preset that is already configured gets an accent outline, and if it is also the current default provider it shows a "Current" badge — clicking it then expands that provider's editor in the section below instead. The search box filters platforms by name; "Refresh presets" re-reads models.json to update each platform's status.
- **Custom config / Local deploy**: opens an empty (or Ollama-prefilled) add form for any API:

| Field | Notes |
| --- | --- |
| Provider name | Any custom name, e.g. `deepseek`, `openai`, `my-provider`. |
| API type | Choose per the vendor's docs: `openai-completions` / `openai-responses` / `anthropic-messages` / `google-generative-ai`. OpenAI-compatible services usually use an OpenAI-compatible type, but follow the vendor's documentation. |
| API URL | Base URL, e.g. `https://api.example.com/v1` (mind the `/v1` path). |
| API key | Paste the key directly or reference an environment variable like `$MY_API_KEY`. **Never put real keys into screenshots, commit history or shared docs.** |
| Model ID | The model ID the vendor actually uses; may be left empty and added later in the provider editor. |

Fill it in, click "Add provider", then "Save models". The model immediately appears in the composer's model selector.

- **My providers**: each configured provider shows as a compact card (name + model count + host) in the bottom section; clicking one expands its full editor below — base URL, API type, API key, request headers, advanced compat JSON and per-model settings. Renaming or deleting a provider happens there too.

### 4.2 Model card settings

One card per model; common options:

- **Thinking**: when on, MPI requests thinking levels from this model (off hides the thinking level control).
- **Images**: check when the model accepts image input.
- **Context length / Max output**: token counts per the vendor's docs.
- **Test availability**: one-click check that Base URL, API key and model ID actually work.

Advanced settings (expand on the card's right):

- `compat`: only change this if your vendor has special compatibility requirements; it must stay valid JSON.
- `thinkingLevelMap`: maps Pi's standard thinking levels to vendor levels item by item — no hand-written JSON needed. Each level can be "unspecified" (vendor default), "hide this level", or a specific standard/custom value.

### 4.3 Thinking levels

Pi's standard thinking levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` (shown in the UI as Off/Minimal/Low/Medium/High/X-High/Max). In the model selector popover, "Thinking level" is a row of labels + pill buttons that expand into a rounded option list; when a mapping is configured, options show hints like `Medium → mid`.

Note: the actually available levels also depend on the model's live capability list — levels the vendor doesn't declare won't appear in the current session's selector.

### 4.4 Thinking defaults

**Settings → Thinking Defaults**:

- **Default thinking depth**, **default provider / default model**: initial choices for new sessions (still switchable at any time inside a session).
- **Hide thinking blocks**: when on, thinking content is not shown in replies.

### 4.5 Troubleshooting "my config has no effect"

1. Open **Settings → Diagnostics & Config** to see the actual paths of `models.json`, `settings.json` and `auth.json`, and make sure you're editing the right file.
2. Common causes: misspelled model ID; Base URL missing/extra `/v1`; API type mismatched with the protocol; key without permission; "Thinking" not enabled on the model, so no levels appear.

### 4.6 User Profile

**Settings → User profile**: write a short self-introduction and preferences — who you are, your tech stack, how you want replies phrased (e.g. "concise, lead with the conclusion"). This text is appended to every session's system prompt so the agent knows your context from the very first message.

- Up to 4000 characters; saving it empty disables the injection.
- Applies to **new sessions**; already-open ones pick it up on reconnect (closing and reopening a session counts). Scheduled tasks use the same profile.
- Stored in MPI's app config directory (`config.json`); terminal pi is not affected.

---

## 5. Projects and Sessions

### 5.1 Opening a project

- The `+` next to the "Projects" heading in the sidebar — pick (or create) a local folder.
- The "Open project folder" button on the empty-state page.
- Menu: File → Open folder…

The selected folder becomes the current project and appears in the left list; the number next to a project name is the count of sessions found under it.

### 5.2 New session

Three entries, same effect (open a blank session under the current/specified project):

1. The "New session" button at the top of the sidebar (asks you to pick a folder first if no project exists).
2. The `+` on a project row.
3. Menu: File → New session.

A draft session that hasn't sent its first message can be moved to another project via "Switch working folder" in the chat top bar.

### 5.3 Rename / Pin / Sort

- **Rename**: double-click the session title, or click ✎ in the top bar.
- **Pin**: three equivalent ways — the permanent star button on the session row, the ⭐ button in the chat top bar, and "Pin session" from the right-click menu. Newly pinned items go to the end of the pinned zone.
- **Sort** (pinned items only): right-click "Move up / Move down", or drag directly within the pinned zone; order survives restarts. The recent zone is always auto-sorted by activity time.

### 5.4 Fork and Clone

| Action | Entry point | Behavior |
| --- | --- | --- |
| **Fork** | Hover any **user message** → "Fork" button | Branches a new session from **before** that prompt and auto-fills the forked prompt's text into the composer (editable before sending). The original session is marked as disconnected. Same behavior as TUI `/fork`. |
| **Clone** | Right-click a session in the sidebar → "Clone session" | **Fully copies** the current active branch into a new session file, including all history. |

Clicking fork/clone while a reply is streaming asks you to wait for it to finish.

### 5.5 Archive and Delete

- **Archive session**: hover the session row and click the archive icon (or right-click). Archived sessions disappear from the sidebar and default search; find them under "Settings → Archive & Trash" or Ctrl+K (with "Archive & trash" checked) and restore with one click.
- **Archive project**: right-click a project → "Archive project". All of its sessions are archived together; restoring works the same way.
- **Delete session**: hover and click the trash icon, or right-click "Delete". By default this moves it to the **trash** (recoverable); only deleting again from the trash is permanent. Turning off the trash switch in "Settings → General" makes deletes immediately permanent. See [Section 14](#14-archive-and-trash).

### 5.6 Other session behaviors

- **New session (top bar ＋)**: starts a fresh conversation in the current working context (same project, same permission settings).
- **Restart restore**: whichever session you were in when MPI quit is reopened automatically on next launch; if that session was archived/deleted in the meantime it's silently skipped.
- **Graceful shutdown**: if a task is running when you close a session or quit the app, MPI first aborts and waits for the write to land (a few seconds max) so session files aren't corrupted.

---

## 6. Chatting with the Agent

### 6.1 Basic input

- **Enter** sends; **Shift+Enter** inserts a newline.
- Pressing Enter while composing with a Chinese/Japanese IME confirms the candidate word and does **not** accidentally send.
- Better results when your prompt states four things: what to accomplish, where the target files/directories are, output format and constraints, and how to verify completion.

### 6.2 Attachments

Three ways, same effect (they appear in the attachment list above the composer and go out with the message):

1. Click `+` and pick files;
2. **Drag a file row from the sidebar "Files" tab straight into the composer** (the composer shows a highlight border while hovering; dropping the same file twice doesn't duplicate it; folders can't be dragged);
3. Drag files in from the system File Explorer, or paste an image directly.

### 6.3 Slash commands and skills

Click the `/ Commands` button or type `/` in the composer to open the menu (three categories: built-in commands, extension commands and skills). Common ones:

- `/compact [note]`: manually compact the context; you can add a note about what to focus on (same as the compact icon in the context popover).
- `/skill:name [args]`: explicitly invoke an installed skill.
- Slash commands shipped with extension packages also appear here.

### 6.4 Steering while running

While the agent is replying, the send button becomes "Stop", and two ways to add input are supported (hover the send button for hints):

- **Enter**: saved as a **pending follow-up** — queued to run after the current turn ends;
- **Alt+Enter**: **inserted into context immediately** (steer), influencing the in-flight task as soon as possible.

Queued messages show above the composer and can be "re-edited" or executed immediately via their button.

### 6.5 Drafts and send-failure protection

- Unsent text/images/attachments are persisted per session (last 40 kept) and restored automatically after restart; cleared on successful send, or when you delete down to the last character.
- **Any send failure** (connection failure, RPC error, …) will: roll back the displayed user bubble, restore the original text/images/attachments fully into the composer, and show an error toast — no lost input, no unresponsive "ghost messages".

### 6.6 Per-message actions

- Hover a **user message**: copy this message / Fork (see 5.4).
- Under agent replies: copy, helpful/not-helpful feedback.
- The "completion sound" toggle lives under "Session tools" in the model selector popover — plays a short beep when the agent finishes a task; can be turned off.

---

## 7. Permission Modes

MPI uses **permission gates** to control how Pi executes shell commands, writes files and performs extension operations. Each session is configured independently; the permission pill on the left of the composer switches it at any time (takes effect immediately, no session restart needed).

| Level | Behavior | Good for |
| --- | --- | --- |
| **Read-only** | Read operations run; any modifying operation is **blocked outright** with no confirmation prompt. | Pure Q&A and code analysis when you never want Pi to touch files. |
| **Strict** | Read commands auto-run; every write/delete/modify command needs confirmation. For write/edit tools you can pick "allow this tool for this thread" to avoid repeated prompts. | Frequent file changes with per-operation oversight. |
| **Sandbox (default)** | Low-risk in-project operations (e.g. `npm run build`) auto-run; dangerous commands, writes outside the project, etc. prompt for confirmation. | Everyday development — the recommended default. |
| **Full** | Nothing is intercepted. | Tasks/environments you explicitly trust. |

- **Default permission for new sessions**: a dropdown in Settings → General (Read-only/Strict/Sandbox/Full) controlling the initial level of subsequently created sessions; existing sessions keep their own settings.
- **Confirmation dialog**: when authorization is needed, a "Permission required" dialog shows the exact command and target path — review before allowing or denying. Beginners: read the command and its target location first.
- Automations can't wait for human approval, so they only offer **Sandbox / Full** (see [Section 10](#10-automations-scheduled-tasks)).

> Tip: permission gates greatly reduce accidental damage but don't replace OS-level isolation; pair them with a system sandbox for untrusted code environments.

---

## 8. Context Management

### 8.1 Usage ring

The **ring button** in the composer's bottom bar (left of the model selector) shows current context usage live: arc = share, color in four bands — ≤60% green / 60–74% yellow / 75–89% orange / ≥90% red. It loads on session switch, refreshes immediately after a stream ends or compaction completes, and polls every 15 seconds while running.

### 8.2 Context window popover

Click the ring to see: current model name, progress bar, "~used / total + percentage", **"Compactions N×"** (hover for the last one's time), a compaction suggestion colored by usage band, plus refresh and **compact icons** at the top right.

- ≤60%: no compaction needed yet
- 60–74%: long tasks may benefit from early compaction
- 75–89%: consider manual compaction to leave headroom
- ≥90%: strongly recommended to compact now
- After ≥3 cumulative compactions an extra warning appears: early details may be lost — write important conclusions into files or memory.

### 8.3 Compacting context

Three triggers:

1. The compact icon in the popover's top-right corner (same as `/compact`);
2. Typing `/compact [note]` in the composer;
3. **Automatic compaction** by pi when a long conversation hits its threshold (failures show a warning toast).

After compaction, token counts display as estimates (`~` prefix) until the next reply provides real numbers.

### 8.4 One-click repair for broken sessions

In rare cases a provider rejects an entire session history because of "blank tool results" or "orphaned tool_results", making the conversation impossible to continue. A red banner with a **"Repair and reload"** button then appears above the composer: MPI performs surgery on the session JSONL (placeholder replacement / stale compaction record cleanup), automatically backs up to `sessions/mpi-repair-backups/` before modifying, writes back idempotently and atomically, and reopens the session when done.

---

## 9. File Preview and HTML Element References

### 9.1 Opening files

- Click any file in the sidebar "Files" tab;
- Click a **file artifact chip** in a chat message;
- Click an attachment chip (view it inside MPI).

### 9.2 Supported types

| Type | Behavior |
| --- | --- |
| Markdown | Full rendering of headings, lists, tables, code blocks and images. |
| HTML | **Live preview** (sandboxed iframe) with zoom support (50%–200%, wheel/buttons). |
| Source code | Syntax highlighting + line numbers. |
| Images | Click to open in a lightbox. |
| Office documents, etc. | Best-effort rendering; for complex formats use the system's default app. |

### 9.3 Preview header buttons (left to right)

- **Show in File Explorer**: locates and selects the file (errors if it doesn't exist).
- **Refresh preview**: re-reads the file content.
- **Expand / Collapse**: let the preview take over the main workspace, or restore the side layout.
- **Close**.

The left edge is draggable to resize the preview width; double-click resets to default.

### 9.4 HTML element references (annotation mode)

When previewing an HTML file, a "Select an HTML element and reference it in the composer" button appears in the header:

1. Click it to enable **annotation mode** — hover highlights and click selects any element on the page;
2. The selected element's info (CSS selector, tag name, text, current styles, HTML snippet) is added automatically as an **HTML reference card** in the composer's attachment area — after sending, Pi knows exactly which element you mean; ideal for requests like "make this button red";
3. Annotation mode also has an **edit button**: with an element selected you can modify its content directly and write it back to the HTML source file (the status bar shows "Click an element / Editing");
4. Reference cards can be expanded for details or removed.

---

## 10. Automations (Scheduled Tasks)

The clock icon in the sidebar opens the "Automations" panel. **Scheduling only happens while MPI is running** — nothing executes while the app is closed.

### 10.1 Creating a task

Click `+` and fill in:

| Field | Notes |
| --- | --- |
| Task name | e.g. "Daily morning report". |
| Working folder | The project directory where the task runs (Pi works inside it). |
| Prompt | The full instruction to execute on schedule; installed skills can be used. |
| Repeat | **Hourly** (at minute N) / **Daily** (HH:mm) / **Weekly** (check weekdays + HH:mm). |
| Run permission | **Sandbox** (default — operations needing confirmation are blocked) or **Full**. Automations can't wait for human approval; grant Full only to tasks you explicitly trust. |

### 10.2 Managing tasks

- Each row shows name, schedule summary, last status (failures in red with the reason on hover), and an enable switch;
- "Run now" triggers one manual run; "Edit" modifies and saves; delete asks for confirmation.
- Task results appear as standalone sessions under the corresponding project, prefixed "Automation: xxx" (older "Automations: xxx" names created by previous versions are still recognized and localized with the UI language). Completion/failure shows a toast notification.

---

## 11. Extensions: Skills / Packages / MCP

The plug icon in the sidebar opens the "Extensions" panel (managing pi's extension packages and skills), with three top-level module tabs: **Skills N / Packages M / MCP K** (each with a count).

### 11.1 Skills

A skill is an instruction set in `SKILL.md` form that pi loads automatically at the right moments; it can also be invoked explicitly via `/skill:name`. Three sub-tabs:

- **My skills** (master-detail layout): left column has search + All/Enabled/Disabled filters + a list grouped by source directory; right column is the detail pane — badges, "Copy command" (puts `/skill:name` on the clipboard), enable/disable switch, rendered SKILL.MD preview and "Copy Markdown".
- **Skill marketplace**: browse and search the public [skills.sh](https://skills.sh/) catalog with one-click install into Pi; a fixed strip above the search box links to other marketplaces (虾评 / SkillHub / SkillsMP).
- **Stats**: total/enabled/disabled stat cards, distribution bars by source directory, and a disabled-skills list (one-click re-enable).

### 11.2 Extension packages

A pi extension is a code package installed from npm/git/local path that can add tools, commands and UI to pi. Two sub-tabs:

- **My packages**: top row "＋ Install package / Update all"; clicking ＋ expands an inline input (accepts `npm:<package>`, a `git:` URL or a local path; Enter installs). Left column lists grouped by npm/git/local + right detail pane (type/version badges, source and install directory, package.json notes, update/enable-disable/remove buttons).
- **Package marketplace**: searches the public npm registry (default query "pi extension", top 30 by relevance); left result list + right detail pane (version/license/weekly-downloads badges, npm page and repo links, README preview), one-click install via `npm:<package>`.

> Package installation uses MPI's **built-in npm**, so it works on machines without Node.js; installing from git sources requires Git to be installed on the system (a clear hint is shown when missing). If you manually configured `npmCommand` in `~/.pi/agent/settings.json`, MPI won't override it.

### 11.3 MCP

MCP (Model Context Protocol) servers provide pi with external tools and data sources. Two sub-tabs:

- **My MCP**: a dependency strip at the top shows whether the `pi-mcp-market` / `pi-mcp-adapter` extensions are enabled (missing ones can be installed with one click). The left column lists servers configured in `~/.pi/agent/mcp.json` (stdio/remote badges); right detail pane — copy command, enable/disable switch (only writes a disabled flag, reversible anytime), delete (with confirmation).
- **MCP marketplace**: browse the mcpmarket.cn public catalog (logo/author/stars/description) with keyword search and "Load more"; click a card for the overview sections and GitHub link.

> The MCP module depends on the `pi-mcp-market` extension; when it's missing you see an unavailable card + one-click install button. Actually connecting to and running servers also requires `pi-mcp-adapter`.

---

## 12. Pi TUI Terminal Mode

The "**Terminal**" button in the chat top bar switches the whole session area into an interactive pi terminal (xterm.js):

- It **shares the same session file and working directory** as GUI mode, with history shared both ways — messages sent in the terminal are visible after switching back to the GUI;
- If a reply is in progress when entering TUI, it's aborted first automatically;
- Ways out: click "Terminal" again, type `/exit` in the terminal, or switch to another session (the terminal process ends automatically);
- The terminal resizes with the window.

For users who prefer keyboard flow and want direct access to all of pi's TUI commands.

---

## 13. Global Search (Ctrl+K)

The 🔍 button at the top of the sidebar or **Ctrl+K** opens global session search:

- Type a keyword; it full-text matches titles and message content across all sessions;
- **"Archive & trash" checkbox**: when checked, archived sessions and trash entries are searched too; result rows carry status badges (Archived / Project archived / Trash) and each row has a "Restore" button that puts it straight back into the sidebar;
- Esc or the close key at the top right dismisses.

---

## 14. Archive and Trash

The **Settings → Archive & Trash** page manages three kinds of entries, all grouped by project (group headers show project name + count, collapsible); the search box at the top filters all three (substring match on title/project name/path):

| Section | Content | Actions |
| --- | --- | --- |
| Archived projects | Whole archived projects | Restore project. |
| Archived sessions | Individually archived sessions (archive time shown; full file path on hover) | Restore to the original project. |
| Trash | Deleted sessions (on by default; shows delete time + size used), with "Empty trash" in the header (with confirmation) | "Restore session" back to its project / "Delete forever" (with confirmation). |

Rules:

- **Archiving** is a reversible tidying operation and doesn't touch the files themselves;
- **Deleting** goes to the trash first by default (`<userData>/trash/`); only deleting again from the trash is permanent. Turning off the trash switch in "Settings → General" makes deletes immediately permanent (entries already in the trash can still be restored/emptied).

---

## 15. Settings Reference

**Settings** entries: ⚙ in the title bar, menu "Edit → Open settings…". Left tabs below.

### 15.1 General (default tab)

| Row | Notes |
| --- | --- |
| **Avatars** | Upload custom chat avatars for "User" and "MPI agent"; images are compressed locally to ≤192px before saving, never uploaded anywhere. Can "Restore defaults" (Nobita / Doraemon). |
| **Launch at startup** | Start MPI automatically when logging in. |
| **Trash** | Deleted sessions go to the trash first (recoverable); turning off makes deletes immediately permanent. |
| **Theme mode** | A "Follow system" checkbox + light/dark preview cards; click to switch instantly. |
| **Accent color** | 7 options: Follow theme (default), White, Light gray, Dark gray, Green, Red, Blue; the send button and selection highlights follow it. |
| **Diff display** | Two modes for edit-tool diffs — "Unified view / Split before-after", unified by default. |
| **Window zoom** | 50%–150%, shortcuts Ctrl+= / Ctrl+- (25% steps), Ctrl+0 to reset; persists across restarts. |

### 15.2 Models & Providers / Thinking Defaults / User Profile

See [Section 4](#4-configuring-models). The **User profile** tab (see 4.6) works the same way: edit, then click "Save"; a small dot on the tab indicates unsaved changes.

### 15.3 Archive & Trash

See [Section 14](#14-archive-and-trash).

### 15.4 Backup & Restore

Two independent backup targets, each with its own export/import pair:

**App settings**: exports MPI's app configuration (`config.json`: theme, language, pins, avatars, user profile, automations, remote signaling…) as a single JSON file (default name `mpi-config-backup-<date>.json`). Import first shows how many recognizable settings the file contains and asks for confirmation; on confirm it overwrites only those fields (everything else is kept). Model providers / thinking defaults live in `~/.pi/agent` (shared with terminal pi) and are not part of this backup; machine-specific items (pi path, window position) are never restored.

**Sessions**: tick the projects to export (select all / clear, each row shows session count and size), packaging their raw session JSONL files into a zip (`mpi-sessions-backup-<date>.zip`, project directory structure preserved). Import first reports "N new / M already present": by default only new sessions are imported and existing files are skipped; choose "Overwrite all" to restore from the backup instead. Imported sessions reappear under their original projects (the sidebar refreshes automatically).

Typical uses: migrating to a new PC, or taking a snapshot before big changes.

### 15.5 Diagnostics & Config

Shows Pi runtime status and the actual paths of each config file (`models.json` / `settings.json` / `auth.json`), clickable to open in File Explorer. Model/thinking settings are written to `~/.pi/agent` (shared with terminal pi); general settings live in the app's config directory — check here first when troubleshooting "I changed it but nothing happened".

### 15.6 About MPI

- **MPI app update**: current/latest version, source (GitHub Releases), "View changelog" (bundled changelog, no network needed; footer includes SHA256 install verification steps), and "Install and restart" when a new version is found.
- **Update Pi core**: manages the bundled pi runtime version. Update extensions in the "Extensions" panel instead.

### 15.7 Help menu (title bar)

- **User manual**: opens this manual in a preview tab (the English version is shown automatically under the English interface).
- **About MPI**: pops up a panel with the same app-update and Pi-core cards as above.

---

## 16. Android Phone Remote Control

> **Current status**: the UI entry for this feature is temporarily hidden in recent versions (to be restored after polish); below describes its designed capabilities, for reference.

MPI supports remotely viewing sessions from an Android companion app and performing approved control operations:

- **Pairing**: the desktop generates a QR code containing a short-lived ticket (expires in 5 minutes); scan it on the phone or paste an `mpi://pair?...` link to pair; approve/deny under "Pending devices" on the desktop.
- **Transport**: WSS signaling + STUN direct WebRTC. **The signaling service never receives prompts, code, sessions or file content**; TURN/relay candidates are deliberately rejected (P2P direct only).
- **Management**: view signaling connection status and the trusted-devices list; revoke devices anytime.

---

## 17. Messaging Channels (Feishu)

Message your MPI from Feishu: DM the bot or @-mention it in a group, and the message runs in a dedicated session under the bound project; the agent's reply streams back into that same message. The channel is online **only while MPI is running**.

### 17.1 Enabling the Channel

Open **Sidebar → Messaging channels** (the fourth item below "New session / Automations / Extensions") and fill in:

| Field | Description |
| --- | --- |
| Enable Feishu channel | Master switch; no connection is made while off |
| App ID / App Secret | Credentials of your custom app from the Feishu Open Platform (the secret stays on this machine and is never shown again) |
| Bound project | The folder where messages run; a dedicated session named "Feishu bridge" is created there automatically |
| Session permission | Sandbox (default, blocks operations that need confirmation) / Full access |

Click **Save configuration** to apply immediately. Status light at the top: gray = off, blinking amber = connecting/reconnecting, green = connected, red = failed (details below).

### 17.2 Creating a Feishu App (First Time)

> ⚠️ **Prerequisite: you need an enterprise/organization.** The Feishu Open Platform requires custom apps to live under an **enterprise tenant**, and WebSocket event push only works for enterprise custom apps. If your account is on the personal plan (no organization), create your own free enterprise first (individuals can create one, no business license needed — you become its admin). Otherwise you'll hit "connects fine but never receives messages" with no publish option in the console.

1. Sign in at [open.feishu.cn/app](https://open.feishu.cn/app) (create an enterprise first if you don't have one);
2. Create a **custom (enterprise) app**; note the App ID and App Secret on "Credentials & Basic Info";
3. Add the **Bot** capability under App Capabilities → Bots;
4. Enable scopes: `im:message.p2p_msg:readonly` (receive p2p messages), `im:message.group_at_msg:readonly` (receive group @-mentions of the bot), `im:message:send_as_bot` (send as the app);
5. On Events & Callbacks, choose **WebSocket long-connection mode** and subscribe to event `im.message.receive_v1`;
6. Create a version and publish it (or set a test availability scope first).

> Long-connection mode needs no public IP or tunneling — MPI connects straight to Feishu's WebSocket endpoint. The panel includes this guide as well.

### 17.3 Usage and Commands

- **DM**: send plain text to the bot;
- **Groups**: @-mention the bot (only messages that mention it are processed);
- Replies start with a "🤔 Working on it" placeholder, then stream updates as the agent works, finalizing when done; very long output is truncated (full result in the MPI session).
- Commands: `/new` starts a fresh session (the old one is kept), `/help` shows help;
- One message at a time — sending while busy gets a "still processing" notice.

### 17.4 Notes

- The channel is online only while MPI runs; messages sent while MPI is off (or the connection is down) are not received;
- Avoid driving the same dedicated session from both desktop and Feishu at once;
- Changing the bound project creates a new "Feishu bridge" session in the new project.

---

## 18. Keyboard Shortcuts

| Shortcut | Action |
| --- | --- |
| `Enter` | Send message; while the agent is running = save as pending follow-up |
| `Shift+Enter` | Newline in the composer (Enter during IME composition only confirms the candidate) |
| `Alt+Enter` | Insert into context immediately while running (steer) |
| `Ctrl+K` | Global session search |
| `Esc` | Close popovers / dismiss menus |
| `Ctrl+=` / `Ctrl+-` | Window zoom ±25% |
| `Ctrl+0` | Reset window zoom to 100% |

---

## 19. Data and Configuration Locations

| Content | Location (Windows) | Notes |
| --- | --- | --- |
| Pi agent config | `%USERPROFILE%\.pi\agent\` | `models.json`, `settings.json`, `auth.json`, extension/skill/MCP configs — **shared with terminal pi**. |
| Session files | `~/.pi/agent/sessions/` (organized by project) | JSONL format; broken-session repair backups in `sessions/mpi-repair-backups/`. |
| App config | `%APPDATA%\MPI\config.json` | General settings: theme, language, avatars, default permission, etc. |
| Drafts | `%APPDATA%\MPI\drafts.json` | Unsent input; LRU-kept, last 40. |
| Trash | `%APPDATA%\MPI\trash\` | Deleted session files. |
| Bundled runtime | `%APPDATA%\MPI\runtime\versions\…` | Extracted on first launch; the built-in npm used for package installs lives here too. |

Dev (development build) and production installs have independent config directories (`%APPDATA%\MPI Dev` ↔ `%APPDATA%\MPI`) and don't interfere with each other; a brand-new profile inherits language and theme from its sibling profile on first launch.

> API keys are user data: never commit `auth.json`, session files or screenshots containing keys to repositories, and don't share them.

---

## 20. FAQ

**Model selector shows "No available models"**
Go back to "Settings → Models & Providers" and confirm you saved; check API key, Base URL (mind `/v1`), API type and model ID one by one, using "Test availability" to pinpoint the problem. If it still fails, reopen the session once.

**`max` (or some level) is missing from thinking levels**
Make sure "Thinking" is enabled on the model card and `thinkingLevelMap` doesn't hide that level; even if visible in settings, a level the vendor's live capability list doesn't support won't be shown.

**New session didn't appear under the project**
Sessions are usually persisted only after the first message is sent. Send a task first, wait until Pi starts replying or finishes, then check the left list.

**Files tab isn't showing the current project**
The file tree follows the **current session's** project folder. Switch to the target session first, then look at the "Files" tab.

**Content was generated but preview didn't update / no file artifacts**
Confirm the artifact path in chat matches the current project; if Pi only pasted Markdown into the chat without writing a file, follow up with "please actually write that content to docs/result.md". Files modified by external programs just need the preview reopened.

**My input disappeared after a send failure?**
It shouldn't — any send failure fully restores text/images/attachments into the composer and shows an error toast (see 6.5). If you see unresponsive user bubbles in a session, that's legacy behavior from an older version; upgrading to the latest fixes it.

**Session suddenly can't continue; provider rejects history**
Check whether the red "one-click repair" banner appeared above the composer; if so, click repair (the original file is backed up automatically); if not, report the error message to the maintainers.

**Taskbar icon still old after upgrade/reinstall**
Windows caches icons by path; MPI already works around this with content hashing — a full app restart shows the new icon.

**Package install fails with `spawn npm ENOENT` / git-related errors**
Only possible on older versions: MPI now bundles npm, so installs work without Node.js; git-source installs require Git to be installed (a clear hint appears when missing). If you manually changed `npmCommand` in `settings.json`, make sure that command actually works.

**Do dev and production data mix?**
No. Their config directories are separate (`MPI Dev` / `MPI`), but they share the same `~/.pi/agent` — models, extensions and session history are common by design.

---

*This manual is written for MPI 0.5.x; UI wording follows the English interface (Chinese-interface terms are annotated where needed). For feature changes, refer to the changelog under "Settings → About MPI → View changelog".*
