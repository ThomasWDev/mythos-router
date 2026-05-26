# Contributing to mythos-router

Thanks for your interest in contributing. This guide covers human and AI-assisted changes to the Mythos Router CLI.

---

## Getting Started

```bash
git clone https://github.com/thewaltero/mythos-router.git
cd mythos-router
npm install
```

Provider keys are only needed for `mythos chat` and `mythos run`.

```bash
cp .env.example .env
# Add ANTHROPIC_API_KEY, OPENAI_API_KEY, or DEEPSEEK_API_KEY if you want model-backed chat/run.
```

Model-free SWD entry points such as `mythos swd apply` and `mythos mcp` do not require provider keys. External agents bring their own model/key and submit structured file actions to Mythos.

### Dev Mode

```bash
npx tsx src/cli.ts chat
npx tsx src/cli.ts run "explain this repo"
npx tsx src/cli.ts verify --dry-run
npx tsx src/cli.ts skills check
npx tsx src/cli.ts learn --dry-run
npx tsx src/cli.ts receipts
npx tsx src/cli.ts mcp
```

### Build And Test

```bash
npm test
npm run build
npx tsc --noEmit
```

---

## Project Conventions

Read [AGENTS.md](./AGENTS.md) before writing code. The core rules:

1. **Zero external runtime dependencies** beyond `@anthropic-ai/sdk` and `commander`.
2. **ESM only** - no CommonJS.
3. **Vanilla ANSI** - no chalk, no ink, no terminal UI dependency.
4. **Config stays centralized** in `src/config.ts` where possible.
5. **SWD is non-negotiable** - model and external-agent file writes must go through Strict Write Discipline.
6. **Dry-run safety** - every filesystem mutation path must respect `dryRun`.
7. **External-agent input fails closed** - malformed actions, traversal, sensitive paths, unsafe command surfaces, and oversized writes must be rejected or require explicit opt-in.
8. **Receipts must not leak secrets** - redact or omit sensitive local data from receipt output.

---

## Making Changes

### Before You Start

- Check existing [issues](https://github.com/thewaltero/mythos-router/issues) to avoid duplicate work.
- For major changes, open an issue first and describe the proposed behavior.
- Keep PRs focused. One security fix or feature is easier to review than a broad rewrite.

### Pull Request Checklist

- [ ] Tests pass with `npm test`.
- [ ] Build passes with `npm run build`.
- [ ] No new runtime dependency unless it is clearly justified.
- [ ] File writes still go through SWD.
- [ ] Dry-run behavior is covered if filesystem code changed.
- [ ] Sensitive paths remain blocked by default.
- [ ] High-impact command-surface files still require confirmation unless explicitly allowed.
- [ ] Project policy behavior is tested if `.mythos/policy.json`, SWD review, or path matching changed.
- [ ] Receipt behavior is tested if receipt storage, markdown, JSON, or redaction changed.
- [ ] Changelog is updated for user-facing changes.

### Commit Style

Use clear, descriptive commit messages:

```text
fix: block nested sensitive paths
feat: add MCP config helper
security: harden receipt markdown escaping
test: cover project policy path normalization
```

---

## AI-Assisted Contributions

AI-assisted PRs are welcome, but they must meet the same bar as human code.

### Requirements For AI-Generated PRs

1. **Type check and tests must pass** - include the commands you ran.
2. **No phantom imports** - do not add imports for packages that are not declared.
3. **No SWD bypass** - filesystem mutations must stay behind SWD verification.
4. **No hidden behavior** - avoid minified code, encoded payloads, broad scripts, or surprise network calls.
5. **Preserve local-first boundaries** - MCP uses stdio and must not open ports or start daemons.
6. **Explain security-sensitive changes** - especially policy, path validation, receipts, git, scripts, or CI changes.

### What Makes A Good PR

- Small scope with a clear reason.
- Tests for the changed behavior.
- No unrelated formatting churn.
- Matches existing TypeScript and CLI style.
- Mentions the exact user-facing behavior in the changelog when needed.

### What Gets Rejected

- PRs that add runtime dependencies without a strong reason.
- PRs that weaken SWD verification or rollback.
- PRs that loosen sensitive-path protections.
- PRs that add install, publish, workflow, or shell behavior without review.
- PRs that modify `MEMORY.md` semantics without updating the memory system.
- Cosmetic churn that makes future audits harder.

---

## Project Structure

```text
src/
  cli.ts                 Commander.js entry point
  config.ts              Constants, provider validation, budget defaults, pricing
  client.ts              Provider facade and direct-client compatibility path
  budget.ts              Session budget limiter
  swd.ts                 Strict Write Discipline engine, parser, verification, rollback
  swd-cli.ts             SWD terminal presentation
  receipts.ts            Local SWD trust receipts and drift verification
  receipt-markdown.ts    PR-ready receipt markdown formatter
  security-policy.ts     Built-in SWD sensitive path and command-surface review
  project-policy.ts      Repo-local .mythos/policy.json enforcement
  mcp.ts                 MCP stdio adapter for SWD, receipts, and skills
  mcp-config.ts          Paste-ready MCP client config helper
  skills.ts              Skill pack loading, validation, and prompt assembly
  learn.ts               Repo-local skill generation
  memory.ts              MEMORY.md manager and SQLite FTS index
  metrics.ts             Local budget and session metrics
  providers/             Provider orchestration, pricing, telemetry
  commands/              CLI command implementations
test/
  *.test.ts              Node test runner coverage
docs/
  *.md                   User and integration docs
```

---

## Questions

Open an [issue](https://github.com/thewaltero/mythos-router/issues) or reach out on [X](https://x.com/thewaltero).
