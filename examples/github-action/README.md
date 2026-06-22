# GitHub Action

Add a read-only Mythos verification gate to pull requests. `mythos verify --ci`
does not call a model provider and does not require API keys — it reviews the
PR diff for risk surfaces and checks receipt integrity + the append-only receipt
chain.

## Reusable action (recommended — 4 lines)

This repo ships a composite action at its root (`action.yml`), so you can drop
the gate in without copying a whole workflow:

```yaml
# .github/workflows/mythos.yml
name: Mythos Verify
on: pull_request
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0          # needed so Mythos can diff against the base
      - uses: thewaltero/mythos-router@v1
        with:
          strict: true            # optional: fail on warnings too
```

Pin to a tag (`@v1`, `@v1.21.0`) for stability. Inputs: `strict`,
`working-directory`, `version` (which npm version to run), `base` (diff ref),
`json`, and `node-version`.

## Copy-a-workflow alternative

If you'd rather not depend on the action, the standalone workflows below do the
same thing by calling the CLI directly.

It reviews PR/diff changes for risk surfaces such as:

- package scripts and npm lifecycle hooks
- GitHub Actions workflows
- shell/deploy/Docker surfaces
- `.env`, `.npmrc`, private-key-like files, and high-confidence secrets
- `.mythos/policy.json` changes
- changed Mythos receipts

## Workflow

Copy [`mythos-verify.yml`](mythos-verify.yml) into:

```text
.github/workflows/mythos-verify.yml
```

The workflow uses:

```bash
npx -y mythos-router@latest verify --ci
```

For stricter repositories, change the final command to:

```bash
npx -y mythos-router@latest verify --ci --strict
```

`--strict` fails CI on warnings as well as high-severity findings.
