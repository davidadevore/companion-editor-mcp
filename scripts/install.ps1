# companion-editor-mcp installer for Windows PowerShell.
# Clones the repo, installs dependencies, builds, creates a starter allowlist,
# and prints the MCP client config with absolute paths filled in.
#
# Usage (PowerShell):
#   irm https://raw.githubusercontent.com/davidadevore/companion-editor-mcp/main/scripts/install.ps1 | iex
# Options via environment:
#   COMPANION_EDITOR_MCP_DIR  install location (default: $HOME\companion-editor-mcp)
#   COMPANION_EDITOR_MCP_REPO git url (default: https://github.com/davidadevore/companion-editor-mcp.git)
#   COMPANION_URL      Companion base url baked into the printed config (default: http://127.0.0.1:8000)
$ErrorActionPreference = 'Stop'

$Repo = if ($env:COMPANION_EDITOR_MCP_REPO) { $env:COMPANION_EDITOR_MCP_REPO } else { 'https://github.com/davidadevore/companion-editor-mcp.git' }
$Dir = if ($env:COMPANION_EDITOR_MCP_DIR) { $env:COMPANION_EDITOR_MCP_DIR } else { Join-Path $HOME 'companion-editor-mcp' }
$CompanionUrl = if ($env:COMPANION_URL) { $env:COMPANION_URL } else { 'http://127.0.0.1:8000' }

function Say($m) { Write-Host "[companion-editor-mcp] $m" -ForegroundColor Cyan }
function Die($m) { Write-Host "[companion-editor-mcp] error: $m" -ForegroundColor Red; exit 1 }

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Die 'git is required. Install it from https://git-scm.com and rerun.' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die 'Node.js 22 or later is required. Install it from https://nodejs.org and rerun.' }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Die 'npm is required (it ships with Node.js).' }

$NodeMajor = [int](node -p 'process.versions.node.split(".")[0]')
if ($NodeMajor -lt 22) { Die "Node.js 22 or later is required, found $(node --version)." }

if (Test-Path (Join-Path $Dir '.git')) {
  Say "Updating existing install in $Dir"
  git -C $Dir pull --ff-only
  if ($LASTEXITCODE -ne 0) { Die 'git pull failed' }
} else {
  Say "Cloning into $Dir"
  git clone --depth 1 $Repo $Dir
  if ($LASTEXITCODE -ne 0) { Die 'git clone failed' }
}

Set-Location $Dir
Say 'Installing dependencies'
npm ci --no-fund --no-audit
if ($LASTEXITCODE -ne 0) { Die 'npm ci failed' }
Say 'Building'
npm run build --silent
if ($LASTEXITCODE -ne 0) { Die 'build failed' }

if (-not (Test-Path 'config\allowlist.json')) {
  Set-Content -Path 'config\allowlist.json' -Value "{`n  `"buttons`": [],`n  `"variables`": []`n}"
  Say 'Created an EMPTY config\allowlist.json. Nothing can be pressed until you add your own buttons.'
  Say 'See config\allowlist.example.json for the format.'
}
New-Item -ItemType Directory -Force -Path 'logs' | Out-Null

$Fwd = $Dir -replace '\\', '/'

Say 'Checking the server starts'
$env:COMPANION_ALLOWLIST_PATH = "$Fwd/config/allowlist.json"
$env:COMPANION_LOG_DIR = "$Fwd/logs"
$check = @'
const { spawn } = require("node:child_process");
const p = spawn(process.execPath, ["dist/index.js"], { stdio: ["pipe", "ignore", "pipe"] });
let err = "";
p.stderr.on("data", (d) => (err += d));
setTimeout(() => { p.kill(); process.exit(err.includes("started") ? 0 : 1); }, 1500);
p.on("exit", (c) => { if (c !== null && c !== 0) { process.stderr.write(err); process.exit(1); } });
'@
node -e $check
if ($LASTEXITCODE -ne 0) { Die 'The server did not start. See the message above.' }
Say 'Server starts and fails closed as expected'

@"

================================================================================
 Installed to: $Dir
 Based on companion-mcp by MyEvent Labs (MIT)
================================================================================

 1. Add your buttons to the allowlist. It starts EMPTY, so nothing can be
    pressed until you do. Use the page/row/column shown in Companion's button
    editor and check each one really exists on that page.
      $Dir\config\allowlist.json
    Format example: $Dir\config\allowlist.example.json

 2. Add this to your MCP client config (Claude Desktop, Cursor, Windsurf, etc.).
    Writes are DISABLED ("false"). To let the AI press allowlisted buttons,
    change COMPANION_ALLOW_WRITES to "true" and restart the client.

{
  "mcpServers": {
    "companion": {
      "command": "node",
      "args": ["$Fwd/dist/index.js"],
      "cwd": "$Fwd",
      "env": {
        "COMPANION_URL": "$CompanionUrl",
        "COMPANION_ALLOW_WRITES": "false",
        "COMPANION_ALLOWLIST_PATH": "$Fwd/config/allowlist.json",
        "COMPANION_LOG_DIR": "$Fwd/logs"
      }
    }
  }
}

 3. Restart your client and ask it to run the "ping" tool.

 Config file locations:
   Claude Desktop  Settings > Developer > Edit Config (claude_desktop_config.json)
   Cursor          %USERPROFILE%\.cursor\mcp.json
   VS Code         .vscode\mcp.json in a workspace (uses "servers" instead of "mcpServers")

 Full docs: $Dir\README.md
"@
