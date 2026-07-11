# Threat Model — mythos-router

> Scope: the local CLI and its model-free SWD layer (`chat`, `run`,
> `swd apply`, the MCP adapter, `verify --ci`). This document states what
> mythos-router defends against, what it deliberately does **not**, and where
> the trust boundaries are. For coordinated disclosure see [SECURITY.md](./SECURITY.md).

## Trust model in one paragraph

mythos-router treats **model output as untrusted**. An LLM (or any external
agent) proposes file actions; the tool's job is to make sure those proposals
cannot quietly corrupt your working tree, exfiltrate secrets, or touch
sensitive files. It does this by validating every action, checking it against
policy, applying it under Strict Write Discipline (pre/post SHA-256
snapshots), and rolling back anything whose on-disk result doesn't match what
was claimed. The human operator and the operator's own machine/shell are
**trusted**; the model and external-agent input are not.

## Assets being protected

- The working tree's integrity (no silent or hallucinated edits).
- Secrets and credentials on disk (`.env`, keys, wallet files, etc.).
- Command-execution surfaces (CI workflows, package manifests, shell scripts).
- The audit trail (receipts and run records that say what actually happened).

## What is in scope (defended)

**1. Hallucinated / mismatched edits — Strict Write Discipline.**
Every file operation the model claims is verified against the real filesystem
using pre- and post-operation SHA-256 snapshots. A claim that doesn't match
reality triggers a Correction Turn; repeated failure yields to the human. The
budget ledger records *actual* provider token usage, not estimates.

**2. Untrusted external-agent input — schema + path safety.**
`swd apply` / MCP `swd_apply` accept structured actions from agents that hold
their own model key. That input is size-limited and schema-validated before
execution, and paths must resolve to safe project-relative locations
(traversal is rejected).

**3. Sensitive files — fail-closed blocklist.**
The security policy blocks writes to, among others: `.env*`, `.npmrc`,
`.git/`, `.ssh/`, `id_rsa` / `id_ed25519`, `*.pem|key|p12|pfx`, `wallet.dat`,
`seed*.txt`, and `secrets*` paths. These cannot be overridden by a project
`policy.json`. Built-in protection always wins.

**4. Command-execution surfaces — confirm-gated.**
High-impact paths (`package.json`, lockfiles, `.github/workflows/`,
`Dockerfile`, shell scripts, build configs, `Makefile`, `.husky/`, etc.)
require human confirmation, or explicit `--allow-risky` in external-agent
flows. Deletes are likewise opt-in.

**5. Pre-apply checks — isolated workspace gate.**
`--check` / `--run-checks` mirror the project into a throwaway temp directory
and run the checks there, applying to the real tree only if every check
passes. Concretely the sandbox:
  - is created with `mkdtemp` (0700 perms) and `realpath`-resolved so the jail
    comparison is immune to `/tmp` → `/private/tmp` symlink quirks;
  - rejects path traversal and refuses to dereference project symlinks into the
    copy (a copied symlink cannot escape the jail);
  - mirrors Git-tracked and non-ignored files, honors `.gitignore` and
    `.mythosignore`, excludes common secret material, and only *symlinks* a
    project-local `node_modules` (so checks run without a reinstall, but writes
    can't reach the real modules tree);
  - caps the mirror at 20,000 files and each check at a 120s timeout;
  - redacts secrets from captured check output before display or receipts;
  - is always removed in a `finally` block.

**6. Untrusted cloned repos — no implicit execution.**
A cloned repository's `.mythos/policy.json` cannot, by itself, cause command
execution. Checks run only on explicit operator opt-in (`--run-checks`) and
never during `--dry-run`.

**7. Recoverable filesystem transactions.**
Before the first mutating SWD action, Mythos durably records the batch's
before-state, intended after-state, rollback backups, and progress under
`.mythos/transactions/`. On restart, `mythos doctor` reports interrupted
journals and `mythos doctor --repair` recovers only inactive owners. Recovery
refuses to overwrite a path that drifted from both the recorded before-state
and Mythos's exact intended after-state.

**8. Locally tamper-evident audit trail.**
Receipts and run records store paths, hashes, provider/agent id, budget, git
state, and verification result — but not raw file contents. Receipt appends are
serialized by a repository-scoped lock and receipt/HEAD files are committed with
same-directory atomic writes. Verification checks receipt self-integrity before
opening referenced paths, applies the repository path jail, and streams file
hashes to detect drift without loading complete targets into memory.

## What is explicitly OUT of scope (residual risk)

- **The local receipt chain is not an authenticity signature.** It detects
  accidental edits, gaps, forks, duplicate sequences, and partial local
  rewrites. An actor able to rewrite every receipt and the local HEAD pointer
  can construct a new self-consistent chain. Use signed or externally anchored
  attestations when independent authenticity is required.
- **Check commands are NOT a security sandbox.** `--check` / `policy.json`
  `checks` run *caller-trusted* shell commands with the local user's
  permissions. The temp-dir isolation protects your real working tree from a
  bad *apply*; it does **not** contain a malicious *command*. Only ever pass
  commands you already trust (`npm test`, `npm run build`, `tsc --noEmit`).
- **No OS/container/network isolation.** mythos-router is not a jail, VM, or
  seccomp sandbox. A process it launches has whatever access your shell has.
- **The model provider is trusted with your prompt.** Content you send goes to
  the configured provider under your key, subject to their terms. SWD verifies
  *file effects*, not what the provider does with your text.
- **Secret redaction is best-effort.** It targets known patterns; a novel
  secret format in check output may not be caught. Don't rely on it as your
  only control.
- **`--no-budget` / `--allow-risky` / expert flags** intentionally remove guard
  rails. That is the operator's call and their responsibility.

## Reporting

Please report suspected vulnerabilities privately per [SECURITY.md](./SECURITY.md)
rather than opening a public issue.
