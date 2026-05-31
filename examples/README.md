# Mythos Router Examples

These examples show the integration surfaces that do not require a Mythos model key.

They are intentionally small and explicit:

| Example | Shows |
|---------|-------|
| [`external-agent-json`](external-agent-json/) | How an outside agent can validate contracts and submit structured file actions through `mythos swd apply` |
| [`mcp-stdio`](mcp-stdio/) | How MCP clients can launch Mythos as a local stdio tool server |
| [`project-policy`](project-policy/) | How a repo can define enforced SWD block/confirm rules with `.mythos/policy.json` |
| [`github-action`](github-action/) | How to run read-only `mythos verify --ci` in pull requests |

Safety notes:

- `mythos swd apply`, `mythos mcp`, and `mythos verify --ci` do not require `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `DEEPSEEK_API_KEY`.
- External-agent examples use structured file actions. Mythos validates schema/contracts, validates paths, reviews risk, snapshots files, verifies disk state, rolls back failed writes, and records receipts plus run outcomes for non-dry-run applies.
- Run mutating examples in a temporary directory first if you only want to inspect behavior.
- Sensitive files such as `.env`, `.npmrc`, `.git`, private keys, and wallet files remain blocked by default.
