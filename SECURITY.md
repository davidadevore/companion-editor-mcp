# Security

## Reporting

Report security issues privately through GitHub's "Report a vulnerability" on this repository's Security tab, not as a public issue.

## Threat model summary

| Threat                                          | Mitigation                                                                         |
| ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| LLM presses wrong button mid-show               | Allowlist, write gate, dry-run default, confirm on high risk                       |
| Hallucinated endpoint hits something unintended | Ground-truth API doc, fixed paths only, integer-validated inputs                   |
| Retry causes double-fire                        | No automatic retries, explicit unknown outcome on timeout                          |
| Prompt injection via tool output                | Tool outputs are data only, writes need explicit flags                             |
| Secret or rig layout leaks to GitHub            | gitleaks local and CI, allowlist file git-ignored                                  |
| Malicious dependency                            | Exact pins, two runtime deps, npm audit, Dependabot, install with --ignore-scripts |
| Compromised CI                                  | Read-only token, SHA-pinned actions, no secrets in CI                              |
| MCP server reachable from the network           | stdio only, private-range URL check, no listening socket                           |
| Log growth fills disk during an event           | 5 MB rotation with one backup file                                                 |

## Supported versions

- Node 22 or later
- Bitfocus Companion 5.1 (HTTP API as documented in docs/companion-api.md; config-edit and trigger tools verified on 5.1.0 and 5.1.1)
