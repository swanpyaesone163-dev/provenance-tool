# 3-Minute Demo Script: Provenance

A step-by-step guide to presenting Provenance during a hackathon demo.

## Pre-Demo Checklist (Do This Before Presenting)

- [ ] Connect to Wi-Fi or phone hotspot
- [ ] Have the GitHub Pages site already deployed and open in a browser tab
- [ ] Have the demo repo open in your terminal
- [ ] SSH key registered on GitHub as a Signing Key
- [ ] Run `node scripts/e2e.js --keep --out ./demo-output` as an offline fallback
- [ ] Open `./demo-output/docs/index.html` in a second browser tab (just in case)

## Demo Timeline (3 Minutes)

### Minute 0:00 – 0:45: The Problem & The Solution

**Say:**
> "In hackathons, student projects, and remote teams, proving you built something yourself is hard. AI tools make it easy to generate code, and commit histories can be faked or backdated.
>
> We built **Provenance**: a lightweight tool that runs in the background, records your real work as it happens into a tamper-evident log, signs it with your GitHub SSH key, and publishes a public verification page."

**Action:**
- Show the terminal with the demo project open.

---

### Minute 0:45 – 1:30: How It Works (Live Recording)

**Say:**
> "Let's see it in action. First, we start recording in the background."

**Type in Terminal 1:**
```bash
node /path/to/provenance.js watch
```

**Say:**
> "Now, while we write code, Provenance captures file changes. But more importantly, the developer can explain what they're doing in their own words."

**Type in Terminal 2:**
```bash
node /path/to/provenance.js note "Refactored the authentication flow to use JWT tokens"
```

**Say:**
> "When we commit, our post-commit hook automatically logs the commit metadata."

**Type in Terminal 2:**
```bash
echo "// new helper" >> utils.js
git add utils.js
git commit -m "Add utility functions for auth"
```

**Type in Terminal 2:**
```bash
node /path/to/provenance.js status
```

**Say:**
> "We can see our events: the file changes, the developer note, and the commit — all chained together cryptographically."

---

### Minute 1:30 – 2:30: Publishing & Live Verification (The Wow Moment)

**Say:**
> "Now let's publish the log to GitHub Pages."

**Type in Terminal 2:**
```bash
node /path/to/provenance.js publish
```

**Action:**
- Switch to the browser showing the GitHub Pages site.

**Say:**
> "Here is the public Provenance page. Notice three things:
> 1. **Integrity**: The browser is running SHA-256 in real time to verify that no event in the chain was altered.
> 2. **Signature**: Verified against the developer's public SSH keys fetched directly from GitHub.
> 3. **Timeline**: Commits, file saves, and the developer's explanations in their own words."

**Action: The Tamper Test**
- Click the **"Try to tamper"** button on the web page.
- The banner turns red immediately, naming the tampered event.

**Say:**
> "If anyone modifies even a single character in the log — like editing a note after the fact — the entire cryptographic chain breaks instantly."

- Click **"Restore"** to return it to green.

---

### Minute 2:30 – 2:50: The Honest Closing (Crucial!)

**Say:**
> "To be completely clear about what Provenance does:
>
> **Provenance proves WHEN a log existed, WHAT it recorded, and that it has not been changed since it was signed.**
>
> It does NOT detect AI use, and it does NOT prove who typed the code. But it gives reviewers, judges, and teammates a verifiable timeline of real work that cannot be retroactively faked."

---

### Minute 2:50 – 3:00: Q&A / Wrap Up

**Say:**
> "Anyone can verify this log with one command: `node provenance.js verify`. Thank you!"

---

## Fallback Plan (If Live Demo Fails)

If anything goes wrong (Wi-Fi drops, GitHub Pages slow, git error):

1. **Don't panic.**
2. Switch to the pre-rendered offline tab: `./demo-output/docs/index.html`
3. Show the live verification banner and the "Try to tamper" button.
4. Run `node scripts/e2e.js` in the terminal to show all automated checks passing.
