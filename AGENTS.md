# companion-editor-mcp

Purpose: MCP server wrapping the Bitfocus Companion 5.0.7 HTTP API for live-event use.
Audience: a single operator per install. Not a public npm package, but anyone may clone and run it.

## Stack

TypeScript (strict), Node 22+, @modelcontextprotocol/sdk, zod, vitest, eslint, prettier.
stdio transport only. No web framework. No extra runtime dependencies without asking.

## Non-negotiable rules

1. Live-control tools use only endpoints listed in docs/companion-api.md. Config-edit tools (src/companion-config.ts) may use the internal tRPC procedures listed in that file's header, taken from Companion v5.0.7 source, and nothing else. Never invent endpoints or procedures. If one is missing, stop and ask.
2. Read-only by default. Writes require COMPANION_ALLOW_WRITES=true. Config edits additionally require COMPANION_ALLOW_CONFIG_EDITS=true.
3. Button presses only for locations on the allowlist (config/allowlist.json). Everything else is refused with a clear error.
4. All write and press tools default to dry_run: true. A real action needs dry_run: false explicitly.
5. High-risk allowlist entries also require confirm: true.
6. Never retry a write or press automatically. One attempt, then report.
7. Fail closed: invalid config, unreachable Companion, or malformed response means an error result, never a guess.
8. Every tool call is logged as JSON lines (timestamp, tool, sanitised args, outcome, allowed/refused) to logs/.
9. Never log secrets, tokens or full env.
10. All tool inputs validated with zod. Reject unknown keys. Bound string lengths and numeric ranges.
11. Build request URLs from validated integers and fixed paths only. Never interpolate raw strings into URLs.
12. Companion URL must be loopback or RFC1918 private range unless COMPANION_ALLOW_REMOTE=true.

## Code quality bar

- tsc strict, noUncheckedIndexedAccess, no `any`.
- eslint (typescript-eslint strict + eslint-plugin-security), prettier.
- vitest coverage thresholds: 85% lines, 90% on src/safety.ts.
- No dead code, no TODOs left in merged code.
- Small pure functions. Side effects confined to companion-client.ts and logger.ts.

## Working rules

- Keep it small. Do not add anything not asked for.
- One phase per branch. Commit messages follow Conventional Commits.
- Before finishing a phase run: npm run check (typecheck, lint, test, audit, secrets).
- When unsure, ask. Do not guess.

## Style

- No em dashes or en dashes anywhere (code, comments, docs, commit messages). Use hyphens.
