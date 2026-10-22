#!/usr/bin/env bash
# companion-editor-mcp installer for macOS and Linux.
# Clones the repo, installs dependencies, builds, creates a starter allowlist,
# and prints the MCP client config with absolute paths filled in.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/davidadevore/companion-editor-mcp/main/scripts/install.sh | bash
# Options via environment:
#   COMPANION_EDITOR_MCP_DIR  install location (default: $HOME/companion-editor-mcp)
#   COMPANION_EDITOR_MCP_REPO git url (default: https://github.com/davidadevore/companion-editor-mcp.git)
#   COMPANION_URL      Companion base url baked into the printed config (default: http://127.0.0.1:8000)
set -euo pipefail

REPO="${COMPANION_EDITOR_MCP_REPO:-https://github.com/davidadevore/companion-editor-mcp.git}"
DIR="${COMPANION_EDITOR_MCP_DIR:-$HOME/companion-editor-mcp}"
CURL="${COMPANION_URL:-http://127.0.0.1:8000}"

say() { printf '\033[1;36m[companion-editor-mcp]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[companion-editor-mcp] error:\033[0m %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || die "git is required. Install it from https://git-scm.com and rerun."
command -v node >/dev/null 2>&1 || die "Node.js 22 or later is required. Install it from https://nodejs.org and rerun."
command -v npm >/dev/null 2>&1 || die "npm is required (it ships with Node.js)."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "Node.js 22 or later is required, found $(node --version)."

if [ -d "$DIR/.git" ]; then
  say "Updating existing install in $DIR"
  git -C "$DIR" pull --ff-only
else
  say "Cloning into $DIR"
  git clone --depth 1 "$REPO" "$DIR"
fi

cd "$DIR"
# On Git Bash for Windows, Node needs a Windows style path, not /c/Users/...
if command -v cygpath >/dev/null 2>&1; then
  DIR="$(cygpath -m "$DIR")"
fi
say "Installing dependencies"
npm ci --no-fund --no-audit
say "Building"
npm run build --silent

if [ ! -f config/allowlist.json ]; then
  printf '{
  "buttons": [],
  "variables": []
}
' > config/allowlist.json
  say "Created an EMPTY config/allowlist.json. Nothing can be pressed until you add your own buttons."
  say "See config/allowlist.example.json for the format."
fi
mkdir -p logs

say "Checking the server starts"
if COMPANION_ALLOWLIST_PATH="$DIR/config/allowlist.json" COMPANION_LOG_DIR="$DIR/logs" \
   node -e '
     const { spawn } = require("node:child_process");
     const p = spawn(process.execPath, ["dist/index.js"], { stdio: ["pipe", "ignore", "pipe"] });
     let err = "";
     p.stderr.on("data", (d) => (err += d));
     setTimeout(() => { p.kill(); process.exit(err.includes("started") ? 0 : 1); }, 1500);
     p.on("exit", (c) => { if (c !== null && c !== 0) { process.stderr.write(err); process.exit(1); } });
   '; then
  say "Server starts and fails closed as expected"
else
  die "The server did not start. See the message above."
fi

cat <<EOF

================================================================================
 Installed to: $DIR
 Based on companion-mcp by MyEvent Labs (MIT)
================================================================================

 1. Add your buttons to the allowlist. It starts EMPTY, so nothing can be
    pressed until you do. Use the page/row/column shown in Companion's button
    editor and check each one really exists on that page.
      $DIR/config/allowlist.json
    Format example: $DIR/config/allowlist.example.json

 2. Add this to your MCP client config (Claude Desktop, Cursor, Windsurf, etc.).
    Writes are DISABLED ("false"). To let the AI press allowlisted buttons,
    change COMPANION_ALLOW_WRITES to "true" and restart the client.

{
  "mcpServers": {
    "companion": {
      "command": "node",
      "args": ["$DIR/dist/index.js"],
      "cwd": "$DIR",
      "env": {
        "COMPANION_URL": "$CURL",
        "COMPANION_ALLOW_WRITES": "false",
        "COMPANION_ALLOWLIST_PATH": "$DIR/config/allowlist.json",
        "COMPANION_LOG_DIR": "$DIR/logs"
      }
    }
  }
}

 3. Restart your client and ask it to run the "ping" tool.

 Config file locations:
   Claude Desktop  Settings > Developer > Edit Config (claude_desktop_config.json)
   Cursor          ~/.cursor/mcp.json
   VS Code         .vscode/mcp.json in a workspace (uses "servers" instead of "mcpServers")

 Full docs: $DIR/README.md
EOF
