# Publishing `@viscerous/errata-plugin-sdk`

This project includes a local SDK package at `packages/errata-plugin-sdk`.

## Manual Publish (npm)

Authenticate interactively, then publish from the SDK package directory (not repo
root):

```bash
npm login
```

```bash
cd packages/errata-plugin-sdk && npm publish --access public
```

`npm login` opens a browser and supports passkeys/security keys, so no token has
to exist on disk or pass through shell history. Prefer it over
`NODE_AUTH_TOKEN=...` for hand publishes.

Notes:

- Package is configured with `publishConfig.access = public`.
- Publish target is npm registry (`https://registry.npmjs.org`).
- A hand publish produces **no provenance attestation** — only CI can generate
  one. Prefer the tag-triggered workflow for real releases.

## CI Publish (GitHub Actions)

Workflow file:

- `.github/workflows/publish-plugin-sdk.yml`

Triggers:

- manual (`workflow_dispatch`)
- tag push matching `sdk-v*` (example: `sdk-v0.1.1`)

Behavior:

- Validates tag version matches `packages/errata-plugin-sdk/package.json` version.
- Publishes from `packages/errata-plugin-sdk`.

### Authentication: trusted publishing (OIDC)

There is **no npm token and no GitHub secret**. npm authenticates the workflow by
its GitHub OIDC identity, which is what `permissions: id-token: write` in the
workflow is for — remove it and publishing breaks.

Configured once on npmjs.com, under the package's Settings → Trusted Publisher:

| Field | Value |
| --- | --- |
| Organization or user | `Viscerous` |
| Repository | `errata` |
| Workflow filename | `publish-plugin-sdk.yml` (filename only, not a path) |
| Environment | leave empty |
| Allowed actions | `npm publish` |

Two consequences worth knowing:

- The workflow upgrades npm before publishing, because trusted publishing needs
  npm >= 11.5.1 and Node 24 does not reliably bundle one that new. Without it the
  failure looks like an auth error rather than a version mismatch.
- Provenance attestations are generated automatically, so `--provenance` is not
  passed. Adding it back is redundant.

## Common Errors + Fixes

### CI publish fails with a 401/403, or "unable to authenticate"

Under trusted publishing this is almost never a credential problem, because there
is no credential. Check, in order:

- the trusted publisher on npmjs.com names workflow **`publish-plugin-sdk.yml`**
  — the filename alone, not `.github/workflows/publish-plugin-sdk.yml`
- `permissions: id-token: write` is still present in the workflow
- npm in the job is >= 11.5.1 (the upgrade step should guarantee this; an older
  npm ignores OIDC entirely and reports it as an auth failure)
- the tag was pushed to `Viscerous/errata`, not a different remote

### `E403` on a hand publish

Cause:

- the logged-in account does not own `@viscerous`, or the session expired

Fix:

- `npm whoami` to confirm the account, `npm login` to re-authenticate

### `Cannot read properties of null (reading 'prerelease')`

Cause:

- usually running `npm publish` from the wrong directory (repo root) instead of the SDK package folder

Fix:

- run publish from `packages/errata-plugin-sdk`

### `gitignore-fallback No .npmignore file found`

Cause:

- npm uses `.gitignore` when `.npmignore` is missing

Fix:

- optional; add `.npmignore` inside `packages/errata-plugin-sdk` if you need explicit publish file control

## Versioning Flow

1. Bump `packages/errata-plugin-sdk/package.json` version.
2. Publish manually, or push matching release tag:

```bash
git tag sdk-v0.1.1
git push origin sdk-v0.1.1
```

## Security Reminder

- Never commit npm tokens.
- If a token is ever shared in logs/chat, rotate/revoke it immediately.
