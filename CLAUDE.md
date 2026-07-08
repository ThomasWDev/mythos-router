# mythos-router — Claude Code project rules

Local-first CLI power tool built around Strict Write Discipline (SWD): every file
action an agent claims is verified against the real filesystem via SHA-256 snapshots,
rolled back on mismatch, and recorded in a hash-chained receipt.

## Stack
- TypeScript on Node.js 22+ (`engines.node >= 22.0.0`), ESM only (`"type": "module"`).
- Runtime deps are intentionally minimal: `@anthropic-ai/sdk` + `commander`. Do NOT add others.
- `tsx` for dev/test; `tsc` compiles `src/` → `dist/`. TypeScript 6, target ES2024, `strict: true`.
- No chalk / ink — all terminal output is vanilla ANSI.

## Test
- Full suite: `npm test` (= `node --import tsx --test "test/**/*.test.ts"`).
- With coverage: `npm run test:coverage` (adds `--experimental-test-coverage`).
- Provider keys are NOT needed for tests or model-free SWD paths.

## Lint / typecheck gate
- No ESLint / Prettier / Biome in this repo. The typecheck IS the gate.
- Typecheck (no emit): `npx tsc --noEmit`.
- Build gate (emits `dist/`): `npm run build` (= `tsc`).
- CI also runs `node dist/cli.js verify --ci` (Memory/codebase drift) after build.

## Branch & deploy model
- `main` is the protected default and the only CI branch. Branch off `main`, PR back to `main`.
- CI (`.github/workflows/ci.yml`) runs on push + PR to `main`: build → `verify --ci` → `npm test`
  → coverage, on matrix ubuntu/windows/macos × Node 22/24.
- This is a FORK of `thewaltero/mythos-router` (`upstream`); `origin` is `ThomasWDev/mythos-router`.
  `sync-upstream.yml` merges upstream `main` → fork `main` daily (09:00 UTC) — avoid force-pushes to
  `main` and expect it to move under you; rebase before opening a PR.
- No server deploy: this ships as an npm package (`bin: mythos`). `prepublishOnly` runs the build.

## Tests live in
- `test/**/*.test.ts` (node:test runner). Source lives in `src/`; SDK entry is `src/index.ts`.

## Gotchas
- SWD is non-negotiable: all filesystem mutations go through the SWD engine (`src/swd.ts`), never raw `fs` writes in feature code.
- Every mutation path must respect `dryRun` before touching disk.
- `MEMORY.md` is sacred — never delete it; only append or compress via `dream`.
- System prompt, budget defaults, and pricing constants all live in `src/config.ts` — don't scatter them.
- External-agent input fails closed: reject path traversal, sensitive paths, oversized writes, unsafe commands unless explicitly opted in.
- Receipts must not leak secrets; MCP is stdio-only — never open ports or start daemons.
- Update `CHANGELOG.md` for any user-facing change (per CONTRIBUTING PR checklist).

Global rules: ~/.claude/CLAUDE.md (HARD RULES apply)
