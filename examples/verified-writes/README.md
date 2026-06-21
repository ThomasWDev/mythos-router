# Verified Writes — route any agent through SWD

This example shows the part of `mythos-router` that has nothing to do with which
model you run: **Strict Write Discipline (SWD) as a standalone verification
layer.** Any agent — Claude, GPT, a local model, or a hand-rolled script — can
emit file actions and let SWD verify them against the real filesystem with
SHA-256 snapshots, roll back anything that doesn't match what was claimed, and
write a tamper-evident receipt. The trust boundary is the filesystem, not the
model's self-report.

## Run the demo

```bash
npm run build
node examples/verified-writes/agent-hallucination-demo.mjs
```

It runs two batches against a throwaway repo, with **no API key and no provider
call**:

1. An **honest agent** claims two edits whose bytes match its claim → both
   verify, and a hash-chained receipt is written.
2. A **hallucinating agent** claims it changed `config.ts` (`INTENT: MUTATE`)
   but emits byte-identical content — a change it never actually made — paired
   with one genuine new file. SWD catches the hallucination and **rolls back the
   whole batch**, so the genuine sibling edit never lands half-applied.

```
Scenario 2 — agent hallucinates a change
  success: false
  ✘ CAUGHT MODIFY src/config.ts — Intent mismatch: Expected mutation but file remained identical.
  ✔ CREATE src/feature.ts — Verified: CREATE src/feature.ts
  rolled back: yes
  src/feature.ts exists after rollback? false
```

## The three ways to feed SWD (no Mythos model key)

### 1. Stdin / JSON — wrap any CLI agent

Have your agent print `[FILE_ACTION]` blocks (or a JSON envelope) and pipe it in:

```bash
your-agent --task "refactor auth" | mythos swd apply --stdin --json
```

Gate the apply behind a check that runs in an isolated copy first:

```bash
your-agent | mythos swd apply --stdin --json --check "npm test"
```

See [`../external-agent-json`](../external-agent-json/) for the accepted
formats and the JSON schema.

### 2. SDK — embed the engine

```ts
import { SWDEngine, parseActions, actionsFromToolCalls } from 'mythos-router';

const engine = new SWDEngine({ strict: true, enableRollback: true });

// From a text-emitting model:
const result = await engine.run(parseActions(modelOutput));

// From a model that uses native tool/function calling — same validation,
// same verification, just structured input instead of parsed text:
const fromTools = actionsFromToolCalls(toolCall.input.actions);
const result2 = await engine.run(fromTools);

if (!result.success) {
  console.error('Caught a bad write; rolled back:', result.rolledBack, result.errors);
}
```

`actionsFromToolCalls` lets a provider with structured tool calls (Anthropic,
OpenAI) hand SWD the same `FILE_ACTION` envelope as a JSON arguments object —
the path-safety rules are identical to the text parser, so neither input path
is a weaker door.

### 3. MCP — let a tool-using client drive SWD

```bash
mythos mcp config cursor   # prints a paste-ready MCP server entry
```

The client launches `mythos mcp` over stdio and calls the `swd_apply` /
`swd_dry_run` / `receipts_*` tools. Same SWD policy, rollback, and receipts as
the CLI. See [`../mcp-stdio`](../mcp-stdio/).

## Why this matters

Every coding agent can confidently report a file write that didn't happen the
way it thinks. SWD is the layer that checks. Because it verifies *effects* and
not *output format*, the same protocol works across every provider — and the
receipt it leaves is a hash-chained, tamper-evident record of what actually
touched disk.
