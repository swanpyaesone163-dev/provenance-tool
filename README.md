# Provenance MVP

A background tool that records your work as it happens into a tamper-evident log, signs it with your GitHub SSH key, and publishes a public web page proving when the log existed and that it hasn't been edited.

**What Provenance proves:** WHEN a log existed, WHAT it recorded, and that it has not been changed since it was signed.

**What Provenance does NOT prove:** It does NOT detect AI use and does not prove who typed the code.

## Prerequisites

1. **Git** installed and configured
2. **Node.js 20 or newer** (`node --version` to check)
3. **SSH key registered on GitHub as a Signing Key**
   - Generate one: `ssh-keygen -t ed25519 -C "your@email.com"`
   - Add the public key at https://github.com/settings/keys as a "Signing Key"
   - Configure Git: `git config --global user.signingkey ~/.ssh/id_ed25519`

## First Checks

Run these three commands to verify everything works:

```bash
npm test
```
Expected output: All tests pass (you may see "SKIP: ssh-keygen..." which is fine)

```bash
node scripts/e2e.js
```
Expected output: `E2E PASS` and a path to an HTML file you can open

```bash
node scripts/e2e.js --keep --out ./demo-output
```
Keeps the demo repo and copies the bundle to `./demo-output` for offline use

## Using Provenance

### Setup in Your Project

Navigate to your project repo:

```bash
cd /path/to/your/project
```

Set a shell variable for convenience (adjust the path to where you cloned provenance-mvp):

**macOS / Linux / Git Bash:**
```bash
P="node /full/path/to/provenance-mvp/provenance.js"
```

Initialize Provenance:

```bash
$P init --github YOUR_GITHUB_USERNAME
```

### Recording Your Work

**Start watching** file changes (run in one terminal, leave it running):

```bash
$P watch
```

Press Ctrl+C to stop watching.

**Add notes** to explain your work in your own words (run in another terminal):

```bash
$P note "Implemented user authentication with JWT tokens"
$P note "Refactored the API layer to use async/await"
```

**Make commits** as normal. The git hook automatically records them:

```bash
git add .
git commit -m "Add login feature"
```

**Check status** anytime:

```bash
$P status
```

### Publishing Your Log

When ready to publish:

```bash
$P publish
```

This bundles the log, signs it, timestamps it, generates the HTML page, commits everything to `docs/`, and pushes to your remote.

### Enable GitHub Pages

1. Go to your repo on GitHub
2. Settings → Pages
3. Source: **Deploy from a branch**
4. Branch: **main** (or master), folder: **/docs**
5. Save

Your page will be live at `https://YOUR_USERNAME.github.io/YOUR_REPO/` within a few minutes.

## The Tamper Demo

### On the web page

Click the **"Try to tamper"** button. The page recalculates the hash chain in your browser and shows the exact event where tampering was detected.

### With the CLI

Edit one line of `docs/provenance/log.jsonl` (change any text), then run:

```bash
$P verify
```

Expected output: `Chain: BROKEN - Event N: hash mismatch` and exit code 1.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `command not found` | Use the full path: `node /full/path/to/provenance.js` instead of `$P` |
| `ssh-keygen -Y` fails or "too old" | Update OpenSSH to 8.1 or newer. On macOS: `brew install openssh` |
| `Signing failed: passphrase` | Your key has a passphrase. Generate a new key without one: `ssh-keygen -t ed25519 -N "" -f ~/.ssh/provenance_key`, then `git config user.signingkey ~/.ssh/provenance_key` |
| `Push rejected` | Pull first: `git pull --rebase`, then `$P publish` again |
| GitHub Pages not updating | Check Settings → Pages. The URL appears there once deployed. First deploy takes 2-5 minutes |
| No internet for timestamp | Use `$P bundle --no-timestamp` and `$P publish --no-timestamp`. Signature verification still works offline |
| Offline demo needed | Run `node scripts/e2e.js --keep`, open the HTML file it prints |

## Privacy

- The log stores: file paths, file hashes (SHA-256), commit messages, and your notes
- The log **never** stores file contents
- **Never put secrets in notes** (passwords, API keys, tokens). Notes are public and searchable
- The generated page is public. Anyone with the URL can see your work timeline

## Limitations Versus the Full Plan

This MVP includes:
- ✅ Tamper-evident log with hash chain
- ✅ Signature with your GitHub SSH key
- ✅ Public web page with live verification
- ✅ OpenTimestamps pending proof
- ✅ CLI for all operations

Not yet implemented:
- ❌ IDE extension (VS Code, JetBrains)
- ❌ GitHub Action to auto-publish on push
- ❌ Append-only branch protection
- ❌ Timestamp upgrade to verified proof (pending proof is created; validate with the official OpenTimestamps client)
- ❌ Browser-based signature verification (signature checked by CLI only; browser verifies chain integrity)

## Commands Reference

```
init [--github <login>]       Initialize in this repo
note "<text>"                 Add a note (1-2000 chars)
watch [--duration <sec>]      Record file changes
status                        Show current state
bundle [--out <dir>]          Create signed bundle (default: docs/provenance)
  [--key <path>]              SSH key to sign with
  [--no-timestamp]            Skip timestamp proof
verify [dir]                  Check chain and signature
  [--github <login>]
  [--allowed-signers <file>]
  [--offline]                 Skip key fetch
  [--json]                    JSON output
report [dir] [--out <file>]   Generate HTML (default: docs/index.html)
publish                       Bundle + verify + report + commit + push
  [--no-push]                 Commit only, don't push
  [--no-timestamp]            Skip timestamp
```

## License

MIT
