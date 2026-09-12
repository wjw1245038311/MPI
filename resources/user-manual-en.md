# MPI User Manual

Applies to: MPI 0.6.x (Windows x64 / macOS arm64)

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
14. [Pi TUI Terminal Mode](#14-pi-tui-terminal-mode)
15. [Global Search (Ctrl+K)](#15-global-search-ctrlk)
16. [Archive and Trash](#16-archive-and-trash)
17. [Settings Reference](#17-settings-reference)
18. [Android Phone Remote Control](#18-android-phone-remote-control)
19. [Messaging Channels (Feishu / WeChat)](#19-messaging-channels-feishu--wechat)
20. [Keyboard Shortcuts](#20-keyboard-shortcuts)
21. [Data and Configuration Locations](#21-data-and-configuration-locations)
22. [FAQ](#22-faq)

---

## 1. Getting to Know MPI

MPI is a standalone desktop client for the [Pi coding agent](https://github.com/earendil-works/pi). Projects, sessions, model configuration, extensions, permission control, scheduled tasks, todo tasks and file preview all live in one desktop workspace.

A few concepts you'll meet often:

| Concept | Description |
| --- | --- |
| Project | A local folder. Pi reads code, creates files and performs operations inside that directory. |
| Session | One continuous conversation with the agent, backed by a session file. A project can have multiple sessions. |
| Permission mode | The level controlling which operations Pi may perform automatically: Read-only / Strict / Sandbox / Full. |
| Extensions | pi's skills, extension packages (npm/git/local) and MCP servers, all managed in the "Extensions" panel. |

MPI shares the same agent configuration directory `~/.pi/agent` with terminal pi: models, API keys, extensions, skills and MCP config are common to both, so an extension installed on one side is immediately available on the other. Session files also live under that directory, which means the terminal and the desktop client see the same session history.

Every installer ships a pinned Node.js + Pi runtime (`MPI-Runtime-*.tar.gz`), so you don't need to install Node.js separately. On first launch MPI verifies and extracts the bundled runtime into the user data directory; later app updates reuse the extracted runtime without re-downloading anything.

---

## 2. Installation and First Launch

### 2.1 Installers

| Platform | File | Notes |
| --- | --- | --- |
| Windows x64 | `MPI-Setup-<version>.exe` | NSIS installer, double-click to run. |
| macOS (Apple Silicon) | `MPI-<version>-arm64.dmg` | Drag-to-install. |

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

If a `.exe.sha256` file with the same base name ships next to the installer, you can verify integrity first: run `Get-FileHash .\MPI-Setup-x.y.z.exe -Algorithm SHA256` in PowerShell and compare the output character by character with the sidecar file. You can also view the verification steps inside the app: **Settings → About MPI → View changelog** (the modal footer includes "How to verify the install").

### 2.5 First launch

1. Start MPI. The first run extracts the bundled runtime, so give it a moment before the main window appears.
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
2. Quick entry buttons: "New session", "Automations" (clock icon), "Todo tasks" (checked-box icon) and "Extensions" (plug icon). They open a new session, the [automations panel](#11-automations-scheduled-tasks), the [todo panel](#12-todo-tasks) and the [extensions panel](#13-extensions-skills--packages--mcp) respectively.
3. Tabs: `Sessions` / `Files`. The "Sessions" tab shows the project list plus each project's session list; the "Files" tab shows the file tree of the current session's project, and clicking any file opens it in the preview pane. File rows can be dragged straight into the composer as attachments (folders are not draggable).
4. Project area: the `+` button opens a folder (create or pick a project); each project row has its name, a session-count badge, a `+` (new session in that project) and a star pin button; right-clicking a project offers **Move up / Move down** (pinned items only), Open in File Explorer, Pin/Unpin project, Archive project.
5. Session area: pinned sessions on top, recent sessions below sorted by activity time. Each session row has a permanent star button on the right (outline = unpinned, filled = pinned); click to toggle; hovering also reveals archive and delete icons. Right-clicking a session offers **Move up / Move down** (pinned items only), Pin/Unpin session, Clone session, Delete. You can also drag to reorder: dragging within the pinned zone reorders it; dragging a recent-zone entry into the pinned zone pins it at that position; dragging a pinned entry out to the end unpins it.
6. Bottom usage row: always shows "Today · Total" (token counts in compact k/M format). Hover for today/total breakdown, cost and total session count. It refreshes automatically after each stream ends and polls every 60 seconds as well; terminal pi activity is counted too.

The sidebar width can be adjusted by dragging its right edge; double-click resets it to the default.

### 3.3 Session area (center)

Top bar:

- Left: session title (**double-click to rename**), working folder path (hover for the full path, click to open in File Explorer), connection status hint.
- Right buttons (left to right): ⭐ pin/unpin current session, ✎ rename, 📁 switch working folder, ＋ new session (start a fresh conversation in the current context), ⌨ **Terminal** (switch to Pi TUI, see [Section 14](#14-pi-tui-terminal-mode)), 👁 toggle preview.

Message list:

- User messages on the right (default avatar "Nobita"), agent replies on the left (default avatar "Doraemon"); avatars are customizable in Settings.
- Tool cards: every tool call by Pi (read file, run command, edit, …) produces a card you can expand to see arguments and results. Diffs from `edit`-type tools auto-expand into a git-style single-column view (context lines + colored `-`/`+` lines); multi-replacement edits show an "N replacements" badge in the header; once collapsed manually it won't force-open again.
- File artifact chips: files Pi writes or modifies appear as chips under the message; click to open them in the preview pane.
- Dot navigation: with 2 or more user messages, a vertical dot rail appears on the left of the chat area; hover for a message preview, click to jump.
- Jump to latest: after scrolling up away from the bottom, a circular double-arrow floating button appears at the bottom right; click to smooth-scroll back to the latest.
- While streaming, output auto-follows the bottom; manual scroll-up reading isn't yanked back, follow resumes near the bottom, and each turn ends with a smooth settle at the very end.

Composer, left to right:

| Control | Purpose |
| --- | --- |
| `+` | Add file/image attachments |
| `/ Commands` | Open the slash-command menu (built-in commands, extension commands and skills) |
| Permission pill | Switch the current session's permission mode (four levels, see [Section 8](#8-permission-modes)) |
| Ring button | Context usage progress ring + detail popover (see [Section 9](#9-context-management)) |
| Model pill | Pick provider / model / thinking level, plus "Session tools" (completion sound toggle) |
| Send / Stop | Send the message; becomes a "Stop" button while the agent is running |

Above the composer, the current working folder is shown (click to switch project). Unsent input (text, images, attachments) is saved as a draft per session and restored when you reopen that session after an app restart.

### 3.4 Preview pane (right)

Toggle it from "Toggle preview" in the chat top bar (or the View menu). It renders or highlights Markdown, HTML, source code, images and common office documents; see [Section 10](#10-file-preview-and-html-element-references) for details.

---

## 4. Configuring Models

MPI manages providers and models through Pi's shared `models.json` (in `~/.pi/agent`), fully compatible with terminal pi.

### 4.1 Adding a provider

The **Settings → Models & Providers** page has two sections: preset providers on top, my providers below.

- Quick add from presets: the top section lists common platforms as cards (Bailian pay-as-you-go API / Coding Plan, Zhipu GLM, DeepSeek, Kimi / Moonshot, Gemini, GPT / OpenAI), plus two entry points, "Custom config" and "Local deploy" (self-hosted services such as LM Studio or Ollama go through here). Clicking a platform card opens the add form prefilled with its URL, API type and first model; just enter your API key (adjust as needed) and add it. A preset that is already configured gets an accent outline; if it is also the current default provider it shows a "Current" badge, and clicking it then expands that provider's editor in the section below instead. The search box filters platforms by name; "Refresh presets" re-reads models.json to update each platform's status.
- Custom config / Local deploy: opens an empty (or Ollama-prefilled) add form for any API:

| Field | Notes |
| --- | --- |
| Provider name | Any custom name, e.g. `deepseek`, `openai`, `my-provider`. |
| API type | Choose per the vendor's docs: `openai-completions` / `openai-responses` / `anthropic-messages` / `google-generative-ai`. OpenAI-compatible services usually use an OpenAI-compatible type, but follow the vendor's documentation. |
| API URL | Base URL, e.g. `https://api.example.com/v1` (mind the `/v1` path). |
| API key | Paste the key directly or reference an environment variable like `$MY_API_KEY`. Never put real keys into screenshots, commit history or shared docs. |
| Model ID | The model ID the vendor actually uses; may be left empty and added later in the provider editor. |

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

**Settings → Thinking Defaults**:

- Default thinking depth, default provider / default model: initial choices for new sessions (still switchable at any time inside a session).
- Hide thinking blocks: when on, thinking content is not shown in replies.

### 4.6 Troubleshooting "my config has no effect"

1. Open **Settings → Diagnostics & Config** to see the actual paths of `models.json`, `settings.json` and `auth.json`, and make sure you're editing the right file.
2. Common causes: misspelled model ID; Base URL missing or with an extra `/v1`; API type mismatched with the protocol; key without permission; "Thinking" not enabled on the model, so no levels appear.

### 4.7 User Profile

**Settings → User profile**: write a short self-introduction and preferences: who you are, your tech stack, how you want replies phrased (e.g. "concise, lead with the conclusion"). This text is appended to every session's system prompt, so the agent knows your context from the very first message.

- Up to 4000 characters; saving it empty disables the injection.
- Applies to new sessions; already-open ones pick it up on reconnect (closing and reopening a session counts). Scheduled tasks use the same profile.
- Stored in MPI's app config directory (`config.json`); terminal pi is not affected.

---

## 5. Projects and Sessions

### 5.1 Opening a project

Three entry points: the `+` next to the "Projects" heading in the sidebar (pick or create a local folder), the "Open project folder" button on the empty-state page, and menu File → Open folder…. The selected folder becomes the current project and appears in the left list; the number next to a project name is the count of sessions found under it.

### 5.2 New session

Three entry points with the same effect (open a blank session under the current/specified project): the "New session" button at the top of the sidebar (asks you to pick a folder first if no project exists), the `+` on a project row, and menu File → New session.

A draft session that hasn't sent its first message can be moved to another project via "Switch working folder" in the chat top bar.

### 5.3 Rename / Pin / Sort

- Rename: double-click the session title, or click ✎ in the top bar.
- Pin: three equivalent ways, the permanent star button on the session row, the ⭐ button in the chat top bar, and "Pin session" from the right-click menu. Newly pinned items go to the end of the pinned zone.
- Sort (pinned items only): right-click "Move up / Move down", or drag directly within the pinned zone; order survives restarts. The recent zone is always auto-sorted by activity time.

### 5.4 Fork and Clone

| Action | Entry point | Behavior |
| --- | --- | --- |
| Fork | Hover any user message → "Fork" button | Branches a new session from before that prompt and auto-fills the forked prompt's text into the composer (editable before sending). The original session is marked as disconnected. Same behavior as TUI `/fork`. |
| Clone | Right-click a session in the sidebar → "Clone session" | Fully copies the current active branch into a new session file, including all history. |

Clicking fork/clone while a reply is streaming asks you to wait for it to finish.

### 5.5 Archive and Delete

- Archive session: hover the session row and click the archive icon (or right-click). Archived sessions disappear from the sidebar and default search; find them under "Settings → Archive & Trash" or Ctrl+K (with "Archive & trash" checked) and restore with one click.
- Archive project: right-click a project → "Archive project". All of its sessions are archived together; restoring works the same way.
- Delete session: hover and click the trash icon, or right-click "Delete". By default this moves it to the trash (recoverable); only deleting again from the trash is permanent. Turning off the trash switch in "Settings → General" makes deletes immediately permanent. See [Section 16](#16-archive-and-trash).

### 5.6 Other session behaviors

- New session (top bar ＋): starts a fresh conversation in the current working context (same project, same permission settings).
- Restart restore: whichever session you were in when MPI quit is reopened automatically on next launch; if that session was archived or deleted in the meantime it's silently skipped.
- Graceful shutdown: if a task is running when you close a session or quit the app, MPI first aborts and waits for the write to land (a few seconds max) so session files aren't corrupted.

---

## 6. Chatting with the Agent

### 6.1 Basic input

Enter sends; Shift+Enter inserts a newline. Pressing Enter while composing with a Chinese/Japanese IME only confirms the candidate word and doesn't accidentally send. Better results when your prompt states four things: what to accomplish, where the target files/directories are, output format and constraints, and how to verify completion.

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
- Under agent replies: copy, helpful/not-helpful feedback.
- The "completion sound" toggle lives under "Session tools" in the model selector popover; it plays a short beep when the agent finishes a task and can be turned off.

---

## 7. Voice System

MPI supports two-way voice interaction: **voice input** (speak → transcribed into the editor) and **voice output** (agent replies read aloud).

### 7.1 Voice Input (Transcription)

The microphone button sits right of "Add files" in the composer's bottom bar:

1. Click to start recording — the button turns red with a pulsing dot and an elapsed-time counter; recordings auto-stop at 3 minutes, Esc cancels (no text produced).
2. Click again to stop. The audio is converted locally to WAV and sent to your configured transcription service; the result is **appended to the editor** (never auto-sent) so you can review and edit it first.

The transcription service is configured under **Settings → General → Voice system**. Two backends:

| Backend | Description | Default model |
| --- | --- | --- |
| OpenAI-compatible | Any `/v1/audio/transcriptions` endpoint (OpenAI or compatible gateways) | whisper-1 |
| Gemini | Google's inline-audio API; only the API key is needed | gemini-2.5-flash |

For credentials you can either **reference an already-configured provider** from Models & Providers (its base URL/key are read live — rotating a key needs no re-save of voice settings) or enter a Base URL + API Key manually. The "Test connection" button sends a silent-audio probe to verify endpoint, key and model.

### 7.2 Voice Output (Read Aloud)

- **Per-message**: each agent reply has a speaker button in its footer; click to read that message aloud (the button becomes a stop icon), click again to stop immediately. Code blocks collapse into a single "(code block)" marker, links are read by their label only, and thinking content is never spoken.
- **Auto-read**: tick "Auto-read the agent's reply when a turn settles" under Settings → General → Voice system. The visible session's replies are then read automatically after each turn; background sessions stay silent.

Read-aloud uses the platform's built-in speech synthesis (on Windows: the voices installed with your OS — Chinese requires an installed zh voice), fully offline with no extra dependencies. Under **Settings → General → Voice system** you can pick the voice (default follows the UI language, preferring a matching-language voice), adjust the rate from 0.5× to 2×, and press "Preview" to audition.

---

## 8. Permission Modes

MPI uses permission gates to control how Pi executes shell commands, writes files and performs extension operations. Each session is configured independently; the permission pill on the left of the composer switches it at any time (takes effect immediately, no session restart needed).

| Level | Behavior | Good for |
| --- | --- | --- |
| Read-only | Read operations run; any modifying operation is blocked outright with no confirmation prompt. | Pure Q&A and code analysis when you never want Pi to touch files. |
| Strict | Read commands auto-run; every write/delete/modify command needs confirmation. For write/edit tools you can pick "allow this tool for this thread" to avoid repeated prompts. | Frequent file changes with per-operation oversight. |
| Sandbox (default) | Low-risk in-project operations (e.g. `npm run build`) auto-run; dangerous commands, writes outside the project, etc. prompt for confirmation. | Everyday development, the recommended default. |
| Full | Nothing is intercepted. | Tasks/environments you explicitly trust. |

- Default permission for new sessions: a dropdown in Settings → General (Read-only/Strict/Sandbox/Full) controlling the initial level of subsequently created sessions; existing sessions keep their own settings.
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

### 9.4 One-click repair for broken sessions

In rare cases a provider rejects an entire session history because of "blank tool results" or "orphaned tool_results", making the conversation impossible to continue. A red banner with a "Repair and reload" button then appears above the composer: MPI repairs the session file (placeholder replacement, cleanup of stale compaction records), automatically backs it up to `sessions/mpi-repair-backups/` before modifying, and reopens the session when done.

---

## 10. File Preview and HTML Element References

### 10.1 Opening files

Click any file in the sidebar "Files" tab; click a file artifact chip in a chat message; or click an attachment chip (view it inside MPI).

### 10.2 Supported types

| Type | Behavior |
| --- | --- |
| Markdown | Full rendering of headings, lists, tables, code blocks and images. |
| HTML | Live preview (sandboxed iframe) with zoom support (50%–200%, wheel/buttons). |
| Source code | Syntax highlighting + line numbers. |
| Images | Click to open in a lightbox. |
| Office documents, etc. | Best-effort rendering; for complex formats use the system's default app. |

### 10.3 Preview header buttons (left to right)

- Show in File Explorer: locates and selects the file (errors if it doesn't exist).
- Refresh preview: re-reads the file content.
- Expand / Collapse: let the preview take over the main workspace, or restore the side layout.
- Close.

The left edge is draggable to resize the preview width; double-click resets to default.

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

| Field | Notes |
| --- | --- |
| Task name | e.g. "Daily morning report". |
| Working folder | The project directory where the task runs (Pi works inside it). |
| Prompt | The full instruction to execute on schedule; installed skills can be used. |
| Repeat | Hourly (at minute N) / Daily (HH:mm) / Weekly (check weekdays + HH:mm). |
| Run permission | Sandbox (default, operations needing confirmation are blocked) or Full. Automations can't wait for human approval; grant Full only to tasks you explicitly trust. |

### 11.2 Managing tasks

Each row shows name, schedule summary, last status (failures in red with the reason on hover), and an enable switch. "Run now" triggers one manual run; "Edit" modifies and saves; delete asks for confirmation.

Task results appear as standalone sessions under the corresponding project, prefixed "Automation: xxx" (older "Automations: xxx" names created by previous versions are still recognized and localized with the UI language). Completion/failure shows a toast notification.

---

## 12. Todo Tasks

The checked-box icon in the sidebar opens the "Todo tasks" panel. Todos are tracked per project, with due dates (down to the minute), notes, file/image attachments and smart date parsing; the agent can also add todos from a conversation (marked with an AI badge).

### 12.1 Adding todos

Type into the input at the top of the panel and press Enter to create. With "All projects" selected on the left, pick the target project in the dropdown first; when a specific project is selected, new todos automatically belong to it.

Smart date parsing: you can write dates straight into the text. `send report tomorrow` becomes title "send report", due tomorrow (Chinese forms like `明天发周报`, `周五`, `9月30日`, `12-5` also work); if no date is recognized the todo has none. A time can accompany the date: `tomorrow 9am standup` → tomorrow 09:00; `14:30交报告`, `下午3点半评审`, `9am standup` all work. A bare time with no date means today (e.g. `14:30 submit report`).

Click a row to expand its inline editor: change title / note / due date and time (or clear them) and save, or delete directly (no confirmation dialog).

Attachments: the dashed box below the description is the attachment area (Feishu Bitable style), with a permanent ＋ tile on its left. Click it to open the system file picker; you can also drag & drop files/images straight into the editor (the dashed box highlights while dragging), or click inside the box and press `Ctrl+V` to paste. Up to 10 attachments per todo, 50 MB each. Adding the same file again (picking/pasting/dragging a file with the same name and size) is deduped automatically: only one copy is kept, with a notice. Existing attachments show as cards: images as thumbnails (click for a full-screen preview overlay, zoom in/out at top-right, Esc to close), other files with name and size (click to open with the default app); × appears on hover to remove. Attachments are stored as copies (deleting the original has no effect), by default under `%APPDATA%\MPI\todo-attachments\`; the location is changeable in Settings → General (existing attachments stay where they are).

### 12.2 Smart sections

The panel groups todos by time dimension, each chip showing a count: All / Today (includes overdue; overdue in red) / Tomorrow / This week (Mon–Sun) / Later (dates after this week) / No date / Done. In the "Done" section, "Clear done" at the bottom bulk-deletes completed items in the current scope.

### 12.3 Project scope and agent collaboration

Selecting a project in the left column filters to that project's todos; "All projects" shows everything with a project-name tag on each row. When the agent calls `mpi_todo_add` / `mpi_todo_list` during a conversation, items are written into this panel through an inbox mechanism (the main process watches and dedupes them). Such rows carry an AI badge; clicking it jumps straight to the source session. Data lives in `%APPDATA%\MPI\todos.json` (see [Section 21](#21-data-and-configuration-locations)); dev and production builds are independent.

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

- My MCP: a dependency strip at the top shows whether the `pi-mcp-market` / `pi-mcp-adapter` extensions are enabled (missing ones can be installed with one click). The left column lists servers configured in `~/.pi/agent/mcp.json` (stdio/remote badges); right detail pane has copy command, enable/disable switch (only writes a disabled flag, reversible anytime), delete (with confirmation).
- MCP marketplace: browse the mcpmarket.cn public catalog (logo/author/stars/description) with keyword search and "Load more"; click a card for the overview sections and GitHub link.

> The MCP module depends on the `pi-mcp-market` extension; when it's missing you see an unavailable card + one-click install button. Actually connecting to and running servers also requires `pi-mcp-adapter`.

### 13.4 Extension model pick (no popups)

Some extensions need a model and pop up to ask which one to use (the classic case: pi-web-access opens a browser curation window on every web search and asks which model should write the summary). With **Settings → General → "Extension model pick"** (on by default):

- **No popup**: MPI answers an extension's model-selection request automatically, using this conversation's current model. Unattended scheduled runs behave the same way.
- **Web searches skip the browser window**: pi-web-access switches to the `auto-summary` workflow — a search returns an AI summary directly instead of opening the curation page; a single call can still pass `workflow: "summary-review"` for interactive curation.
- **Summary follows the conversation model**: at the start of each turn MPI writes the current model into `~/.pi/web-search.json` (shared with terminal pi), so switching models takes effect immediately. The summary deadline is raised to 5 minutes so slow local models still produce a full summary. Before its first edit MPI backs up the file's original values and restores them exactly when you turn the switch off.

---

## 14. Pi TUI Terminal Mode

The "Terminal" button in the chat top bar switches the whole session area into an interactive pi terminal:

- It shares the same session file and working directory as GUI mode, with history shared both ways; messages sent in the terminal are visible after switching back to the GUI;
- If a reply is in progress when entering TUI, it's aborted first automatically;
- Ways out: click "Terminal" again, type `/exit` in the terminal, or switch to another session (the terminal process ends automatically);
- The terminal resizes with the window.

For users who prefer keyboard flow and want direct access to all of pi's TUI commands.

---

## 15. Global Search (Ctrl+K)

The 🔍 button at the top of the sidebar or Ctrl+K opens global session search: type a keyword, it full-text matches titles and message content across all sessions. Checking the "Archive & trash" checkbox also searches archived sessions and trash entries; result rows carry status badges (Archived / Project archived / Trash) and each row has a "Restore" button that puts it straight back into the sidebar. Esc or the close key at the top right dismisses.

### In-conversation message search (Ctrl+F)

The 🔍 button in the conversation toolbar, just left of the pin star icon, or Ctrl+F, opens a search bar scoped to the current session: type a keyword, it does case-insensitive substring matching against user messages and agent reply text in this session only (thinking blocks and tool-call arguments are excluded). The right side shows a "current/total" match counter, or "No matches" when nothing hits; while there are matches, non-matching messages dim and the currently displayed match gets a highlight ring plus a brief flash. Enter / ↓ jumps to the next match, Shift+Enter / ↑ to the previous one (wraps around at both ends), auto-scrolling so the match is centered. Esc or × closes the search bar.

---

## 16. Archive and Trash

The **Settings → Archive & Trash** page manages three kinds of entries, all grouped by project (group headers show project name + count, collapsible); the search box at the top filters all three (substring match on title/project name/path):

| Section | Content | Actions |
| --- | --- | --- |
| Archived projects | Whole archived projects | Restore project. |
| Archived sessions | Individually archived sessions (archive time shown; full file path on hover) | Restore to the original project. |
| Trash | Deleted sessions (on by default; shows delete time + size used), with "Empty trash" in the header (with confirmation) | "Restore session" back to its project / "Delete forever" (with confirmation). |

Rules: archiving is a reversible tidying operation and doesn't touch the files themselves. Deleting goes to the trash first by default (`<userData>/trash/`); only deleting again from the trash is permanent. Turning off the trash switch in "Settings → General" makes deletes immediately permanent (entries already in the trash can still be restored or emptied).

---

## 17. Settings Reference

**Settings** entries: ⚙ in the title bar, menu "Edit → Open settings…". Left tabs below.

### 17.1 General (default tab)

| Row | Notes |
| --- | --- |
| Avatars | Upload custom chat avatars for "User" and "MPI agent"; images are compressed locally to ≤192px before saving, never uploaded anywhere. Can "Restore defaults" (Nobita / Doraemon). |
| Launch at startup | Start MPI automatically when logging in. |
| Trash | Deleted sessions go to the trash first (recoverable); turning off makes deletes immediately permanent. |
| Voice system | Voice input (transcription service config + connection test) and voice output (voice / rate / preview / auto-read). See [Section 7](#7-voice-system). |
| Extension model pick | When an extension needs a model, MPI uses this conversation's current model automatically instead of popping up; web searches skip the browser curation window (see [13.4](#134-extension-model-pick-no-popups)). On by default; turning it off restores the per-use prompt and `~/.pi/web-search.json`. |
| Theme mode | A "Follow system" checkbox + light/dark preview cards; click to switch instantly. |
| Accent color | 7 options: Follow theme (default), White, Light gray, Dark gray, Green, Red, Blue; the send button and selection highlights follow it. |
| Diff display | Two modes for edit-tool diffs, "Unified view / Split before-after", unified by default. |
| Window zoom | 50%–150%, shortcuts Ctrl+= / Ctrl+- (25% steps), Ctrl+0 to reset; persists across restarts. |

### 17.2 User Profile

See [Section 4](#4-configuring-models) (4.7). Edit, then click "Save" to apply; a small dot on the tab indicates unsaved changes.

### 17.3 Models & Providers / Thinking Defaults

See [Section 4](#4-configuring-models). The top of the page has "Reload" and "Save models" buttons; model/thinking settings are written to `~/.pi/agent` (shared with terminal pi), and a small dot on the tab indicates unsaved changes.

### 17.4 Data Storage

Two independent data locations can be moved anywhere on this machine (system folder picker):

| Item | Default location | Contents |
| --- | --- | --- |
| Session storage location | `~/.pi/agent/sessions` | All pi session records (.jsonl). Changing it also syncs the `sessionDir` key in `~/.pi/agent/settings.json`, so terminal pi follows along. |
| Todo data location | `%APPDATA%\MPI` (app config dir) | `todos.json`, attachments (`todo-attachments\`) and the agent inbox (`todos-inbox\`). |

A change takes effect in two steps: picking a new folder only records the intent, an amber warning appears under the row ("Location changed; files move on next launch. Until then the app still reads the old location"), and after fully quitting MPI and restarting, all files are moved to the new location before the window opens. Migration rules:

- Session files sit flat in a custom directory (pi's sessionDir layout never nests per project); "Reset" re-nests them into `sessions/<project dir>/` using each file's header cwd;
- Path references inside settings that point at old sessions (permission records, drafts, trash index, AI-todo source-session links) are updated automatically;
- A pre-existing `todos.json` in the target is never clobbered: that part stays pending and retries on the next launch (other files still move); failed parts likewise stay pending;
- Attachments from old locations keep working after the move.

When a custom location is set, each row shows a "Reset" button; hover the path text to see the currently effective directory. Migration results are logged in the console (`[migration]`).

### 17.5 Archive & Trash

See [Section 16](#16-archive-and-trash).

### 17.6 Backup & Restore

Two independent backup targets, each with its own export/import pair:

App settings: exports MPI's app configuration (`config.json`: theme, language, pins, avatars, user profile, automations, remote signaling…) as a single JSON file (default name `mpi-config-backup-<date>.json`). Import first shows how many recognizable settings the file contains and asks for confirmation; on confirm it overwrites only those fields (everything else is kept). Model providers / thinking defaults live in `~/.pi/agent` (shared with terminal pi) and are not part of this backup; machine-specific items (pi path, window position) are never restored.

Sessions: tick the projects to export (select all / clear, each row shows session count and size), packaging their raw session JSONL files into a zip (`mpi-sessions-backup-<date>.zip`, project directory structure preserved). Import first reports "N new / M already present": by default only new sessions are imported and existing files are skipped; choose "Overwrite all" to restore from the backup instead. Imported sessions reappear under their original projects (the sidebar refreshes automatically).

Typical uses: migrating to a new PC, or taking a snapshot before big changes.

### 17.7 Diagnostics & Config

Shows Pi runtime status and the actual paths of each config file (`models.json` / `settings.json` / `auth.json`), clickable to open in File Explorer. Model/thinking settings are written to `~/.pi/agent` (shared with terminal pi); general settings live in the app's config directory; check here first when troubleshooting "I changed it but nothing happened".

### 17.8 About MPI

- MPI app update: current/latest version, source (GitHub Releases), "View changelog" (bundled changelog, no network needed; footer includes SHA256 install verification steps), and "Install and restart" when a new version is found.
- Update Pi core: manages the bundled pi runtime version. Update extensions in the "Extensions" panel instead.

---

## 18. Android Phone Remote Control

> Current status: the UI entry for this feature is temporarily hidden in recent versions (to be restored after polish); below describes its designed capabilities, for reference.

MPI supports remotely viewing sessions from an Android companion app and performing approved control operations:

- Pairing: the desktop generates a QR code containing a short-lived ticket (expires in 5 minutes); scan it on the phone or paste an `mpi://pair?...` link to pair; approve/deny under "Pending devices" on the desktop.
- Transport: WSS signaling + STUN direct WebRTC. The signaling service never receives prompts, code, sessions or file content; TURN/relay candidates are deliberately rejected (P2P direct only).
- Management: view signaling connection status and the trusted-devices list; revoke devices anytime.

---

## 19. Messaging Channels (Feishu / WeChat)

Message your MPI from Feishu or WeChat: DM the bot (Feishu also supports @-mentions in groups), and the message runs in a dedicated session under the bound project. Feishu replies stream back into that same message; WeChat shows a typing indicator while working, then delivers the result as a new message. Both channels are online only while MPI is running.

### 19.1 Enabling the Channel

Open **Sidebar → Messaging channels** (the fourth item below "New session / Automations / Extensions"). The left column lists the channels — Feishu / WeChat; click to switch.

Recommended: one-click setup via QR. Click "📱 Pick or create app via scan" in the quick-setup card and scan with mobile Feishu; on the confirm page choose either **an existing app** (reuse a bot already created under your enterprise — the page shows which scopes/events will be added and asks you to re-authorize) or **create a new one** (a bot app is created under your enterprise with scopes and event subscription pre-configured). Either way its credentials are written straight to local config. No console steps needed, and the App Secret never leaves this machine. If QR setup is unavailable for you, use the manual method below:

| Field | Description |
| --- | --- |
| Enable Feishu channel | Master switch; no connection is made while off |
| App ID / App Secret | Credentials of your custom app from the Feishu Open Platform (the secret stays on this machine and is never shown again) |
| Bound project | The folder where messages run; a dedicated session named "Feishu bridge" is created there automatically |
| Session permission | Sandbox (default, blocks operations that need confirmation) / Full access |

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

## 20. Keyboard Shortcuts

| Shortcut | Action |
| --- | --- |
| `Enter` | Send message; while the agent is running = save as pending follow-up |
| `Shift+Enter` | Newline in the composer (Enter during IME composition only confirms the candidate) |
| `Alt+Enter` | Insert into context immediately while running (steer) |
| `Ctrl+K` | Global session search |
| `Ctrl+F` | In-conversation message search (Enter/Shift+Enter for next/previous match, Esc to close) |
| `Esc` | Close popovers / dismiss menus |
| `Ctrl+=` / `Ctrl+-` | Window zoom ±25% |
| `Ctrl+0` | Reset window zoom to 100% |

---

## 21. Data and Configuration Locations

| Content | Location (Windows) | Notes |
| --- | --- | --- |
| Pi agent config | `%USERPROFILE%\.pi\agent\` | `models.json`, `settings.json`, `auth.json`, extension/skill/MCP configs, shared with terminal pi. |
| Session files | `~/.pi/agent/sessions/` (organized by project; changeable in Settings → Data Storage) | JSONL format; broken-session repair backups in `sessions/mpi-repair-backups/`. Location changes migrate automatically on next launch; terminal pi follows. |
| App config | `%APPDATA%\MPI\config.json` | General settings: theme, language, avatars, default permission, etc. |
| Drafts | `%APPDATA%\MPI\drafts.json` | Unsent input; last 40 kept. |
| Todo tasks | `%APPDATA%\MPI\todos.json` (changeable in Settings → Data Storage) | Per-project todos; agent writes arrive via the `todos-inbox/` inbox and are deduped on ingest. |
| Todo attachments | `%APPDATA%\MPI\todo-attachments\` (changeable in Settings → Data Storage) | Image/file attachments for todos, stored as copies; existing ones stay put after a location change and are cleaned up when a todo is deleted. |
| Trash | `%APPDATA%\MPI\trash\` | Deleted session files. |
| Bundled runtime | `%APPDATA%\MPI\runtime\versions\…` | Extracted on first launch; the built-in npm used for package installs lives here too. |

Dev (development build) and production installs have independent config directories (`%APPDATA%\MPI Dev` ↔ `%APPDATA%\MPI`) and don't interfere with each other; a brand-new profile inherits language and theme from its sibling profile on first launch.

> API keys are user data: never commit `auth.json`, session files or screenshots containing keys to repositories, and don't share them.

---

## 22. FAQ

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

**Taskbar icon still old after upgrade/reinstall**
Windows caches icons by path; MPI already works around this with content hashing. A full app restart shows the new icon.

**Package install fails with `spawn npm ENOENT` / git-related errors**
Only possible on older versions: MPI now bundles npm, so installs work without Node.js; git-source installs require Git to be installed (a clear hint appears when missing). If you manually changed `npmCommand` in `settings.json`, make sure that command actually works.

**Do dev and production data mix?**
No. Their config directories are separate (`MPI Dev` / `MPI`), but they share the same `~/.pi/agent`; models, extensions and session history are common by design.

---

*This manual is written for MPI 0.6.x; UI wording follows the English interface (Chinese-interface terms are annotated where needed). For feature changes, refer to the changelog under "Settings → About MPI → View changelog".*
