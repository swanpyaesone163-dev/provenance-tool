# Provenance SPEC v1

This file is the contract between all packages. Do not change it without telling the whole team.

## 1. Purpose
Provenance records a developer's work as an append-only, hash-chained event log. On push, the log is signed with the developer's Git key and its head is timestamped by OpenTimestamps. A public page lets anyone verify it.

## 2. Scope
One developer, one machine, one chain per repository.

## 3. Where files live
- Live log (local only): `<git-dir>/provenance/log.jsonl`, found with `git rev-parse --git-path provenance`. It is never inside the working tree.
- Published bundle: orphan branch `provenance-log` containing `log.jsonl`, `log.jsonl.sig`, `log.jsonl.ots`, `meta.json`.
- `verification.json` is produced by CI at build time and shown on the site. It is not stored in the branch.

## 4. Log format
UTF-8, LF line endings, one JSON object per line, file ends with a newline.

Each line is a LogEntry with exactly these fields, in this order:
```
{ "v": 1, "seq": 0, "ts": "2026-09-22T09:14:00.000Z", "type": "commit",
  "branch": "session-refresh", "data": { ... }, "prev": "<64 hex>", "hash": "<64 hex>" }
```
- `v`: integer, always 1.
- `seq`: integer, starts at 0, increases by exactly 1.
- `ts`: UTC ISO 8601 with milliseconds and trailing `Z`.
- `type`: one of `commit`, `command`, `diff`, `test_run`, `checkpoint`.
- `branch`: git branch name, or `null`.
- `prev`: hash of the previous entry. For seq 0 it is 64 zeros (GENESIS_PREV).
- `hash`: see section 5.

## 5. Canonical JSON and hash rule
Canonical JSON: object keys sorted alphabetically at every level; no whitespace; arrays keep their order; strings escaped exactly as `JSON.stringify` does; only integers allowed as numbers (no floats, NaN, Infinity); `undefined` is an error.

Hash rule: `hash = lowercase hex SHA-256 of the UTF-8 bytes of canonicalize(entry without the "hash" field)`. The entry still includes `prev`.

## 6. Event data
All paths are relative to the repo root and use forward slashes. All numbers are integers.
- `commit`: `{ sha, message, filesChanged, insertions, deletions }`
- `command`: `{ command, exitCode, durationMs }` (command is passed through redactCommand before logging)
- `diff`: `{ files: [{ path, added, removed }], diffHash }` (diffHash is a SHA-256 of the diff text; raw code is never stored)
- `test_run`: `{ command, passed, failed, total }`
- `checkpoint`: `{ trigger, question, answer }`; trigger is `large_diff`, `tests_recovered`, `commit`, or `manual`; answer is a string or `null` if skipped. One checkpoint event is written when the question is answered or skipped, never before.

## 7. Redaction
`redactCommand(text)` replaces with `[REDACTED]`: Authorization/Bearer header values; tokens starting `ghp_`, `gho_`, `github_pat_`; AWS keys starting `AKIA`; the value in `NAME=value` where NAME contains KEY, SECRET, TOKEN, PASSWORD or PASSWD; the value after `--password`, `--token`, `--secret`; the `user:password` part of URLs. The rest of the command stays unchanged.

## 8. Verification
`verifyChain(entries)` checks, in order for each entry: schema, seq (no gaps), prev (equals previous hash), hash (recomputed). First failure stops the check and returns `{ ok: false, brokenAt: seq, reason }` where reason is `bad_schema`, `seq_gap`, `prev_mismatch`, or `hash_mismatch`. Timestamps going backwards give a warning only.

## 9. Active span
`activeSpanMs` = sum of gaps between consecutive events that are 15 minutes or shorter. Longer gaps count as idle.

## 10. Writing and locking
Every process (extension, git hooks, CLI) appends only through `appendEvent` in `@provenance/core/node`. It takes an exclusive lock file `log.lock` in the log folder, reads the last entry, appends one line, then releases the lock. Nobody writes to `log.jsonl` any other way.

## 11. Bundle files
`meta.json`:
```
{ "v": 1, "repo": "owner/name", "branch": "session-refresh", "developer": "github-login",
  "headSeq": 13, "headHash": "<64 hex>", "events": 14, "publishedAt": "ISO",
  "signingKey": { "type": "ssh-ed25519", "fingerprint": "SHA256:..." }, "toolVersion": "0.1.0" }
```
`log.jsonl.sig`: signature over the exact bytes of `log.jsonl` made with the developer's Git-configured SSH (or GPG) key.
`log.jsonl.ots`: OpenTimestamps proof for the 32-byte head hash.
`verification.json` (written by CI):
```
{ "v": 1, "checkedAt": "ISO",
  "chain": { "ok": true, "events": 14 },
  "signature": { "status": "valid | invalid | unchecked", "signer": "github-login", "keyFingerprint": "SHA256:..." },
  "timestamp": { "status": "pending | confirmed | missing | invalid", "bitcoinBlock": null, "attestedAt": null } }
```

## 12. CLI
`provenance verify [path]`: exit 0 chain ok, 1 chain broken, 2 usage or file error. `--json` prints machine-readable output. Other commands (init, publish) are added by other packages in `src/commands/`.

## 13. Golden test vector
(filled in after Prompt 5: the canonical string and the hash of the sample entry)

## 14. Public API of @provenance/core
Pure (browser-safe): `canonicalize`, `hashEntry`, `createEntry`, `serializeEntry`, `parseLog`, `verifyChain`, `summarize`, `formatDuration`, `redactCommand`, `GENESIS_PREV`, types.
Node-only (`@provenance/core/node`): `resolveLogDir`, `readLog`, `appendEvent`.

## 15. Addendum v1.1 (extends and, where it conflicts, overrides the sections named)

### 15.1 Project config (extends section 3)
`<git-dir>/provenance/config.json` holds `{"v":1,"enabled":false,"paused":false}`. The extension and the git hooks record events only when `enabled` is true and `paused` is false. `readConfig(dir)` returns these defaults if the file is missing. `writeConfig(dir, patch)` merges the patch and writes atomically (temporary file, then rename).

### 15.2 Publish queue (extends section 3)
`publish.queue.json` in the log folder records a failed publish: `{"attempts":0,"lastError":"","lastAttemptAt":"ISO"}`. It is removed after a successful publish.

### 15.3 Commit events (extends section 6)
`commit.sha` is the first 7 characters of the commit hash. `commit.message` is the subject line only, at most 200 characters.

### 15.4 Diff hashing (extends section 6)
`diff.diffHash` is the lowercase hex SHA-256 of the diff text, computed with Node's built-in `crypto`. This is the only place outside `@provenance/core` where hashing is allowed. The hash chain always uses `@provenance/core`.

### 15.5 Signature and timestamp (extends section 11)
- The signature namespace is `provenance`. `log.jsonl.sig` signs the exact bytes of `log.jsonl`.
- `log.jsonl.ots` is an OpenTimestamps proof for the raw 32-byte head hash (the SHA-256 digest), not for a file.
- If a timestamp cannot be created, the bundle is published without `log.jsonl.ots` and verification reports the timestamp status `missing`.

### 15.6 The provenance-log branch (extends sections 3 and 11)
The branch `provenance-log` is append-only. Every publish adds a commit whose parent is the remote tip when one exists. It is never force-pushed. It contains only `log.jsonl`, `log.jsonl.sig`, `log.jsonl.ots` (when available) and `meta.json`. `verification.json` and the built site are never committed to it. The only later commit allowed is an upgraded `log.jsonl.ots` made by CI.

### 15.7 Developer identity (extends section 11)
`meta.developer` is the value of `git config provenance.githubLogin`; if unset, the owner part of the `origin` remote URL.

### 15.8 CLI commands (extends section 12)
- `provenance verify [path]`: exit 0 chain ok, 1 broken, 2 usage or file error; `--json`.
- `provenance check-bundle <dir> [--github <login>] [--allowed-signers <file>] [--offline] [--upgrade] [--json] [--out <file>]`: writes `verification.json`. Exit 0 when the chain is ok and the signature is not invalid; 1 when the chain is broken or the signature is invalid; 2 on usage error. Public keys come from `https://api.github.com/users/<login>/ssh_signing_keys` and `https://github.com/<login>.keys`.
- `provenance build-site <bundle-dir> --out <dir>`: builds the verification page.
- `provenance publish`: signs, timestamps and publishes the bundle now.
- `provenance hooks install|uninstall|status` and `provenance hook <name>`: manage and run the git hooks (hooks never block git and always exit 0).
- `provenance init [--github <login>] [--dry-run] [--force]`: enables the project, installs hooks, writes the workflow file and the README badge block between `<!-- provenance:start -->` and `<!-- provenance:end -->`.
- `provenance doctor [--json]`: checks the setup.
- `provenance badge <verification.json> --out <file.svg>`: writes the status badge.

### 15.9 CI (extends section 3)
`.github/workflows/provenance.yml` triggers on push to the default branch, on a 3-hour schedule, and on manual run. It reads the `provenance-log` branch, runs `check-bundle` and `build-site`, and deploys to GitHub Pages. A `check-bundle` exit code of 1 does not stop deployment; the page shows the failure.

### 15.10 Public API additions to @provenance/core/node
`readConfig`, `writeConfig` (see 15.1).
