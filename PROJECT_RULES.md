# Project rules (read at the start of every session)

Project: Provenance, a tool that records a developer's work as a signed, timestamped, hash-chained log.
Stack: TypeScript, Node 20+, npm workspaces monorepo, vitest for tests, esbuild for bundling. Plain HTML/CSS/JS for the website (no frameworks).

Rules:
1. Read SPEC.md before changing anything. SPEC.md is the contract. Never change it unless I explicitly ask.
2. Only edit files inside the package folder I name. If a change is needed elsewhere, tell me instead of making it.
3. Never write your own hashing, canonical JSON, or redaction code. Always import them from @provenance/core. (One exception: the extension may use Node's built-in crypto to compute diffHash, see SPEC.md section 15.4.)
4. Do not add a new dependency without asking me first, and explain why it is needed in one sentence.
5. Work in small steps. After each step, run the tests and show me the result.
6. Explain what you did in plain English. I am not a programmer.
7. Never delete files or run destructive commands without asking first.
8. If something in my request is unclear or conflicts with SPEC.md, ask one question before writing code.
9. Keep each package's CONTEXT.md up to date when you finish a task.
10. Cross-platform: the team uses Windows, macOS, and Linux (CI). Build paths with path.join or path.resolve, never hard-coded slashes. When a path is written into a log, meta file, or git hook, always use forward slashes.
11. npm scripts and tests must not use shell-specific syntax (VAR=value command, rm -rf, cp, mv). Use small Node scripts instead. Ask before adding a helper dependency.
12. Start processes with execFile or spawn WITHOUT a shell. Never start npm or npx from code (on Windows they are .cmd files and fail); use process.execPath to run node scripts. git and ssh-keygen are fine.
13. Replacing a file by renaming over an existing one can fail on Windows (EPERM) when another process has the file open. Retry up to 5 times with 50 ms between attempts.
14. Test with temp folders from os.tmpdir() whose names contain a space. Never depend on file permission bits (they do nothing on Windows) or on CRLF versus LF line endings (normalize before comparing). Import paths must match the exact upper/lower case of file names, because Linux is case sensitive and Windows and macOS are not.
15. Expand "~" manually using os.homedir(). Never assume a home folder layout.
