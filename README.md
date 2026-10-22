# companion-editor-mcp

Let an AI assistant read and, when you allow it, control [Bitfocus Companion](https://bitfocus.io/companion) 5.1 through a small, security-gated [MCP](https://modelcontextprotocol.io) server.

Built for live-event operators. The AI can only touch buttons and variables you have put on an allowlist, every write defaults to a dry run, and nothing is written until you turn writes on.

Based on [companion-mcp](https://github.com/duncanunderwood/companion-mcp) by MyEvent Labs, extended with trigger editing, feedback styling and Companion 5.1 support. MIT licensed.

- [Quick start](#quick-start)
- [Safety model](#safety-model)
- [Allowlist](#allowlist)
- [Connect your AI client](#connect-your-ai-client)
- [Settings](#settings)
- [Tools](#tools)
- [Config-edit tools (experimental)](#config-edit-tools-experimental)
- [Audit log](#audit-log)
- [Before a show](#before-a-show)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## Quick start

You need Node.js 22 or later, git, and Companion 5.1 running on this machine or your private network.

**1. Enable Companion's HTTP API.** In the Companion web UI: Settings, HTTP, turn on **HTTP API**. Note the port (default `8000`).

**2. Install.** One line, macOS or Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/davidadevore/companion-editor-mcp/main/scripts/install.sh | bash
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/davidadevore/companion-editor-mcp/main/scripts/install.ps1 | iex
```

The installer clones to `~/companion-editor-mcp`, builds, creates an empty allowlist, checks the server starts, and prints a ready-made client config with your paths filled in. Set `COMPANION_EDITOR_MCP_DIR` first to install elsewhere. Prefer to do it by hand? `git clone`, `npm ci`, `npm run build`.

**3. Add buttons to the allowlist.** Edit `~/companion-editor-mcp/config/allowlist.json` (see [Allowlist](#allowlist)). Until you do, nothing can be pressed.

**4. Connect your AI client.** Paste the config the installer printed into your client (see [Connect your AI client](#connect-your-ai-client)), restart the client, and ask it to run `ping`.

**5. Turn writes on when you want them.** Change `COMPANION_ALLOW_WRITES` from `"false"` to `"true"` in the client config and restart the client. Turn it back off after the show.

If you use an AI assistant with a terminal, you can paste this instead of steps 2 and 4:

```
Install companion-editor-mcp from https://github.com/davidadevore/companion-editor-mcp using
scripts/install.sh (macOS/Linux) or scripts/install.ps1 (Windows), then add the JSON it
prints to my MCP client config and tell me where you put it. Leave writes disabled.
```

## Safety model

- **Read-only by default.** Nothing is written unless `COMPANION_ALLOW_WRITES=true`.
- **Allowlist.** Only buttons, variables and connections you list can be written. Anything else is refused, whatever the AI asks.
- **Dry run by default.** Every write tool reports what it would send unless the AI passes `dry_run: false`.
- **Confirm for high risk.** Buttons marked `high` and all connection or config edits also need `confirm: true`.
- **One attempt, no retries.** On timeout, reset or server error it reports "outcome unknown" instead of guessing or retrying.
- **Cooldown.** The same target cannot be written twice within 2 seconds, or while a write is in flight.
- **Audit log first.** An "attempt" line is written before every real write. If the log cannot be written, writes are refused.
- **Private network only.** Refuses to talk to a public address unless `COMPANION_ALLOW_REMOTE=true`.
- **No open ports.** It is a local process your AI client launches over stdio.
- **Documented API only** for live control. The optional config-edit tools use Companion's internal API and sit behind a second flag.

## Allowlist

`config/allowlist.json` is the list of things the AI may write. It is git-ignored, so your rig layout is never committed. The installer creates it empty:

```json
{ "buttons": [], "variables": [] }
```

Add only buttons that really exist. Open each one in the Companion button editor and copy the page, row and column from there. Full example (`config/allowlist.example.json`):

```json
{
  "buttons": [
    { "page": 1, "row": 0, "column": 0, "label": "Program: Camera 1", "risk": "low" },
    { "page": 1, "row": 3, "column": 7, "label": "STREAM STOP", "risk": "high" }
  ],
  "variables": ["cue", "speaker_name"],
  "connections": ["replace-with-id-from-list_connections"],
  "surfaces_rescan": false,
  "pages_create": false
}
```

| Field                     | Meaning                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `buttons[].page`          | Page number, 1 to 99                                                                                         |
| `buttons[].row`, `column` | 0-based grid position as shown in the button editor, 0 to 31                                                 |
| `buttons[].label`         | Your description. Shown to the AI and written to the log                                                     |
| `buttons[].risk`          | `low`: acts on `dry_run: false`. `high`: also needs `confirm: true`                                          |
| `variables`               | Custom variable names the AI may set. Empty or missing forbids all                                           |
| `connections`             | Connection ids (from `list_connections`) the AI may restart, enable or disable. Always needs `confirm: true` |
| `surfaces_rescan`         | `true` allows `rescan_surfaces`. Default `false`                                                             |
| `pages_create`            | `true` allows `create_page`. Default `false`                                                                 |
| `triggers_edit`           | `true` allows the trigger write tools (`create_trigger`, `update_trigger`, ...). Default `false`             |

**Allow everything.** Instead of the object, the whole file can be the string `"all"`. Every button (as `low` risk), variable and connection is then permitted, and `surfaces_rescan`, `pages_create` and `triggers_edit` are on. The write flags and `confirm` rules still apply.

Rules: no duplicates, no unknown keys, names use letters, digits, `_` and `-`. A missing or invalid file stops the server with a clear message.

If you move or delete a button in Companion, update the allowlist before the next show. A press on an empty slot does nothing; a press on a slot you later reused fires whatever is there now.

## Connect your AI client

All clients need the same three things: `node`, the path to `dist/index.js`, and the environment variables. Replace `/abs/path/companion-editor-mcp` with your install path (the installer prints this already filled in). On Windows use forward slashes in JSON, or double every backslash.

### Claude Desktop, Cursor, Windsurf, Cline and most others

Add this inside the `mcpServers` object of the client's config file (Claude Desktop: Settings, Developer, Edit Config. Cursor: `~/.cursor/mcp.json`. Windsurf: `~/.codeium/windsurf/mcp_config.json`).

```json
"companion": {
  "command": "node",
  "args": ["/abs/path/companion-editor-mcp/dist/index.js"],
  "env": {
    "COMPANION_URL": "http://127.0.0.1:8000",
    "COMPANION_ALLOW_WRITES": "false",
    "COMPANION_ALLOWLIST_PATH": "/abs/path/companion-editor-mcp/config/allowlist.json",
    "COMPANION_LOG_DIR": "/abs/path/companion-editor-mcp/logs"
  }
}
```

Windows example of the path form: `"C:\\Users\\you\\companion-editor-mcp\\dist\\index.js"`.

Fully quit and reopen the client afterwards; servers are only launched at startup. Closing the window is not enough. Claude Desktop keeps running in the background, so force it from a terminal:

Windows:

```powershell
taskkill /IM Claude.exe /F
```

macOS:

```bash
pkill -x Claude
```

Then open the client again.

### Claude Code (CLI)

```bash
claude mcp add companion --scope user \
  -e COMPANION_URL=http://127.0.0.1:8000 \
  -e COMPANION_ALLOW_WRITES=false \
  -e COMPANION_ALLOWLIST_PATH=$HOME/companion-editor-mcp/config/allowlist.json \
  -e COMPANION_LOG_DIR=$HOME/companion-editor-mcp/logs \
  -- node $HOME/companion-editor-mcp/dist/index.js
```

Windows PowerShell: same command with `` ` `` instead of `\` at line ends and `$env:USERPROFILE\companion-editor-mcp\...` instead of `$HOME/companion-editor-mcp/...`. Check with `claude mcp list`, remove with `claude mcp remove companion`.

### VS Code (Copilot agent mode)

`.vscode/mcp.json` in a workspace, same fields under `"servers"` with `"type": "stdio"` added.

### Check it works

Ask the client to run `ping`. Expected:

```
companion-editor-mcp is running. Writes disabled. Config edits disabled. Companion at 127.0.0.1:8000.
```

Then `list_allowlist` should show your buttons, and `get_custom_variable` with a variable you have should return its value.

### Turning writes on and off

Change `"COMPANION_ALLOW_WRITES": "false"` to `"true"` (or `-e COMPANION_ALLOW_WRITES=true` for Claude Code, after `claude mcp remove companion`) and restart the client. `ping` then says `Writes ENABLED`. Set it back to `"false"` after the show.

## Settings

All are environment variables. All are optional.

| Variable                       | Default                   | Meaning                                                                               |
| ------------------------------ | ------------------------- | ------------------------------------------------------------------------------------- |
| `COMPANION_URL`                | `http://127.0.0.1:8000`   | Companion base URL. Scheme and host only                                              |
| `COMPANION_ALLOW_WRITES`       | `false`                   | `true` enables all write tools                                                        |
| `COMPANION_ALLOW_CONFIG_EDITS` | `false`                   | `true` (with writes) enables the [config-edit tools](#config-edit-tools-experimental) |
| `COMPANION_ALLOW_REMOTE`       | `false`                   | `true` allows a `COMPANION_URL` outside loopback and private ranges                   |
| `COMPANION_ALLOWLIST_PATH`     | `./config/allowlist.json` | Path to the allowlist. Must end in `.json`                                            |
| `COMPANION_TIMEOUT_MS`         | `3000`                    | Per request timeout, 100 to 30000                                                     |
| `COMPANION_LOG_DIR`            | `./logs`                  | Where the audit log goes                                                              |

Any invalid value, including an empty string, stops the server at startup with a message on stderr.

## Tools

Read tools work whenever the server runs. Write tools need `COMPANION_ALLOW_WRITES=true`, an allowlist entry, and `dry_run: false`.

| Tool                    | Writes | What it does                                                                      |
| ----------------------- | ------ | --------------------------------------------------------------------------------- |
| `ping`                  | no     | Liveness. Reports write and config-edit state. No Companion request               |
| `list_allowlist`        | no     | Shows everything the write tools may touch                                        |
| `get_custom_variable`   | no     | Read `$(custom:name)`                                                             |
| `get_module_variable`   | no     | Read `$(label:name)` from a connection                                            |
| `list_connections`      | no     | All connections with id, module and status                                        |
| `get_connection_status` | no     | One connection by id                                                              |
| `press_button`          | yes    | Press and release an allowlisted button                                           |
| `button_action`         | yes    | `down`, `up`, `rotate_left` or `rotate_right` on an allowlisted button            |
| `set_button_step`       | yes    | Set the current step (1-based) of a multi-step button                             |
| `set_button_style`      | yes    | Change text, text colour, background colour and/or size                           |
| `set_custom_variable`   | yes    | Set an allowlisted custom variable (text, 1 to 1000 characters)                   |
| `connection_action`     | yes    | `restart`, `enable` or `disable` an allowlisted connection. Needs `confirm: true` |
| `rescan_surfaces`       | yes    | Rescan for USB surfaces. Needs `"surfaces_rescan": true`                          |

Every tool returns a one-line summary plus structured data. Refusals and errors come back as errors with a plain reason, never a stack trace. A press result of `ok` means Companion accepted the request, not that the device acted; confirm by reading a variable back.

This covers every command in Companion's documented HTTP API. Commands that exist only on other transports (surface page changes on TCP/UDP) are not available.

## Config-edit tools (experimental)

Five more tools edit Companion's configuration instead of pressing things. They need **both** `COMPANION_ALLOW_WRITES=true` and `COMPANION_ALLOW_CONFIG_EDITS=true`.

| Tool            | What it does                                                                                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_button`    | Read a button's control id, type, feedbacks and actions with entity ids and options                                                                                              |
| `create_button` | Create an empty button at an allowlisted slot. Replaces anything there, so needs `confirm: true`                                                                                 |
| `delete_button` | Delete the button at an allowlisted slot. Needs `confirm: true`                                                                                                                  |
| `update_button` | Apply operations in order: `add_action`, `add_feedback`, `set_options`, `remove_entity`, `set_feedback_style`, `remove_feedback_style`. Removing an entity needs `confirm: true` |
| `create_page`   | Insert empty pages at a position. Needs `"pages_create": true` and `confirm: true`                                                                                               |

**Feedback colours.** `set_feedback_style` sets what a feedback changes on the button while it is active: `bgcolor` and `color` as `#rrggbb`, and `text`. They are stored as style overrides on the button's default `box0` (background) and `text0` (text) layers. Setting a property again replaces its override in place. `remove_feedback_style` takes `properties: ["bgcolor", "color", "text"]`. `get_button` shows each feedback's `styleOverrides` and the button's `layers`.

### Trigger tools

Reads need `COMPANION_ALLOW_CONFIG_EDITS=true`. Writes also need `COMPANION_ALLOW_WRITES=true` and `"triggers_edit": true` in the allowlist. All writes default to `dry_run: true`.

| Tool             | What it does                                                                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list_triggers`  | Every trigger: control id, name, enabled, event description, collection, last run                                                                                                                |
| `get_trigger`    | One trigger's events, conditions and actions with their ids and options                                                                                                                          |
| `create_trigger` | New empty trigger with a name, always created disabled                                                                                                                                           |
| `clone_trigger`  | Companion's own clone of a trigger                                                                                                                                                               |
| `delete_trigger` | Delete a trigger. Needs `confirm: true`                                                                                                                                                          |
| `update_trigger` | Operations in order: `set_name`, `set_enabled`, `add_event`, `set_event_options`, `remove_event`, `add_action`, `add_condition`, `set_entity_options`, `set_condition_inverted`, `remove_entity` |

Removing an event or entity, and `set_enabled: true` (the trigger can then fire on its own), need `confirm: true`. Event options are plain values (for example `{ "seconds": 60 }` for `interval`, `{ "variableId": "custom:cue" }` for `variable_changed`). Actions and conditions inside logic groups are not supported yet.

**Why experimental.** Companion's HTTP API cannot do any of this, so these use the internal admin API that Companion's own web UI uses. It is undocumented and unauthenticated. The calls here were first taken from the Companion 5.0.7 source, then updated for 5.1 from the 5.1.0 web UI's own calls and read-only snapshots of a live 5.1.0 instance. Every config-edit, feedback-style and trigger write was then run end to end against a Companion 5.1.1 test instance. Every response is validated, so if a Companion update changes the internal API the tools fail with "unexpected shape" rather than doing something odd. Verify them once on a test Companion (script below) before trusting them, and keep config edits off on show days.

Tips:

- Call `get_button` first so you know existing entity ids.
- Action and feedback ids (for example `program`, `tally`) come from the connection module. `list_connections` gives the connection id.
- New actions go to step 1, action set `down`, unless you pass `set: "up" | "rotate_left" | "rotate_right"`.
- `update_button` does not change the button's own text or colours. Use `set_button_style`. It does set the colours a feedback applies (`set_feedback_style`).
- Inserting a page renumbers the pages after it. Review the allowlist afterwards.

**Verify once on a test instance.** Put a `low` entry at a slot you can sacrifice (say page 1, row 3, column 7) and `"pages_create": true` in the allowlist, start with both flags `true`, then:

| Step | Do                                                                                       | Expect                                                                        |
| ---- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1    | `ping`                                                                                   | `Config edits ENABLED`                                                        |
| 2    | `get_button` on an empty slot, then on a real button                                     | `found: false`, then the button's control id and entities matching the editor |
| 3    | `create_button` at the sacrificial slot, `dry_run: false, confirm: true`                 | New empty button appears in the editor                                        |
| 4    | `update_button` with one `add_action` for a connection you have                          | Action appears on the button's Down step. `get_button` shows its entity id    |
| 5    | `update_button` with `set_options` on that id, then `remove_entity` with `confirm: true` | Option changes, then the action disappears                                    |
| 6    | `set_button_style` text `TEST`                                                           | Text changes                                                                  |
| 7    | `delete_button`, `confirm: true`                                                         | Slot is empty                                                                 |
| 8    | `create_page` at the end with one name, `confirm: true`                                  | New page appears. Delete it in the Companion UI afterwards                    |

If any step reports "unexpected shape" or "Companion rejected", stop and open an issue with your Companion version.

## Audit log

`<COMPANION_LOG_DIR>/companion-editor-mcp.jsonl`, one JSON object per line:

```json
{
  "ts": "2026-01-01T10:00:00.000Z",
  "tool": "press_button",
  "args": { "page": 1, "row": 0, "column": 0, "dry_run": false, "confirm": false },
  "outcome": "ok",
  "allowed": true,
  "dryRun": false,
  "detail": "pressed \"Program: Camera 1\" at 1/0/0. Companion accepted the press.",
  "durationMs": 12
}
```

`outcome` is `attempt` (written before a real write), `ok`, `refused` or `error`. Variable values are never logged. Secrets-looking keys are redacted. The file is created mode 0600, rotates at 5 MB and keeps 5 backups.

## Before a show

1. Companion is 5.1 with the HTTP API enabled.
2. Allowlist matches the current page layout.
3. `COMPANION_URL` points at the show instance, not a test machine.
4. Writes on only for the event, off afterwards. Config edits off.
5. Dry run every button you plan to use (`press_button` with the default `dry_run: true`) and check the labels.
6. Log directory is writable with free space.
7. `ping` reports the expected write state and host.

First-time check on a test instance (never the show network): with writes off, `ping`, `get_custom_variable`, and a `press_button` with `dry_run: false` (expect "writes are disabled"). With writes on: a dry-run press (nothing fires), a real press (fires), a high-risk press without then with `confirm` (refused, then fires), a press off the allowlist (refused), `set_custom_variable` then read it back.

## Troubleshooting

| Message                                             | Fix                                                                                                                                                       |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allowlist file is missing or unreadable`           | Create `config/allowlist.json` (`{ "buttons": [], "variables": [] }`) or point `COMPANION_ALLOWLIST_PATH` at it with an absolute path                     |
| `COMPANION_URL must be loopback or a private range` | Use Companion's private LAN address, or set `COMPANION_ALLOW_REMOTE=true` if you understand the risk                                                      |
| `Companion HTTP API is disabled (403)`              | Settings, HTTP, enable HTTP API                                                                                                                           |
| `could not reach Companion`                         | Wrong host or port, Companion not running, or a firewall. Test: `curl http://127.0.0.1:8000/api/custom-variable/cue/value`                                |
| `unexpected Companion response 404` on a read       | Something other than Companion is on that port, or a different Companion version                                                                          |
| `Companion reports no button at ...`                | The allowlist entry points at an empty slot                                                                                                               |
| `writes are disabled`                               | Set `COMPANION_ALLOW_WRITES` to `"true"` and restart the client                                                                                           |
| `config edits are disabled`                         | Set both `COMPANION_ALLOW_WRITES` and `COMPANION_ALLOW_CONFIG_EDITS` to `"true"`                                                                          |
| `audit log is not writable`                         | `COMPANION_LOG_DIR` does not exist or is read-only                                                                                                        |
| Tools do not appear in the client                   | Paths not absolute, or the client was not fully restarted. Run `node /abs/path/companion-editor-mcp/dist/index.js` in a terminal to see the startup error |

## Development

```bash
npm test                 # vitest, 170 tests incl. end to end over stdio against mocks
npm run check            # everything CI runs: typecheck, lint, format, build, coverage, audit, secret scan
npx husky                # optional pre-commit and pre-push hooks (needs gitleaks on PATH)
```

`docs/companion-api.md` is the ground truth for the HTTP API; `src/companion-config.ts` documents the internal procedures used. `AGENTS.md` holds the rules for humans and AI agents working on the code. This is a stdio process launched by an MCP client; it has no web output and is not meant to be hosted.

## Credits

Based on [companion-mcp](https://github.com/duncanunderwood/companion-mcp) by MyEvent Labs (MIT). Maintained by [davidadevore](https://github.com/davidadevore). Companion is a product of Bitfocus AS; this project is not affiliated with or endorsed by Bitfocus.
