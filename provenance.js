#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

// ============================================================================
// CANONICAL JSON AND HASHING
// Produce deterministic JSON for hashing: sorted keys, no whitespace
// ============================================================================

function canonicalJSON(obj) {
  if (obj === null) return 'null';
  if (typeof obj === 'boolean') return obj ? 'true' : 'false';
  if (typeof obj === 'number') {
    if (!Number.isFinite(obj)) throw new Error('Cannot canonicalize non-finite number');
    if (!Number.isInteger(obj)) throw new Error('Cannot canonicalize non-integer number');
    return String(obj);
  }
  if (typeof obj === 'string') return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalJSON).join(',') + ']';
  }
  if (typeof obj === 'object') {
    const keys = Object.keys(obj).sort();
    const pairs = keys.map(k => JSON.stringify(k) + ':' + canonicalJSON(obj[k]));
    return '{' + pairs.join(',') + '}';
  }
  throw new Error('Cannot canonicalize type: ' + typeof obj);
}

function hashEvent(event) {
  const { hash, ...eventWithoutHash } = event;
  const canonical = canonicalJSON(eventWithoutHash);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// ============================================================================
// PATH UTILITIES
// Normalize paths to forward slashes for cross-platform consistency
// ============================================================================

function normalizePathForLog(p) {
  return p.replace(/\\/g, '/');
}

function expandHome(filePath) {
  if (filePath.startsWith('~')) {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return filePath;
}

// ============================================================================
// GIT UTILITIES
// ============================================================================

async function getGitDir(repoRoot) {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--absolute-git-dir'], { cwd: repoRoot });
    return stdout.trim();
  } catch (err) {
    throw new Error('Not a git repository');
  }
}

async function getRepoRoot(cwd) {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd });
    return stdout.trim();
  } catch (err) {
    throw new Error('Not a git repository');
  }
}

async function getGitHubLogin(repoRoot) {
  try {
    const { stdout } = await execFileAsync('git', ['config', 'provenance.githubLogin'], { cwd: repoRoot });
    return stdout.trim();
  } catch (err) {
    // Try to extract from origin remote
    try {
      const { stdout: remote } = await execFileAsync('git', ['config', 'remote.origin.url'], { cwd: repoRoot });
      const url = remote.trim();
      const match = url.match(/github\.com[:/]([^/]+)\//);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }
}

async function getRepoName(repoRoot) {
  try {
    const { stdout } = await execFileAsync('git', ['config', 'remote.origin.url'], { cwd: repoRoot });
    const url = stdout.trim();
    const match = url.match(/([^/]+)(\.git)?$/);
    return match ? match[1].replace(/\.git$/, '') : 'unknown';
  } catch {
    return path.basename(repoRoot);
  }
}

// ============================================================================
// LOG LOCK AND APPEND
// Thread-safe log append with file locking
// ============================================================================

async function acquireLock(lockPath) {
  const maxRetries = 50;
  const retryDelay = 40;
  const staleLockMs = 10000;

  for (let i = 0; i < maxRetries; i++) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      return true;
    } catch (err) {
      if (err.code === 'EEXIST') {
        // Check if lock is stale
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > staleLockMs) {
            fs.unlinkSync(lockPath);
            continue;
          }
        } catch {}
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      } else {
        throw err;
      }
    }
  }
  throw new Error('Could not acquire log lock after 50 retries');
}

function releaseLock(lockPath) {
  try {
    fs.unlinkSync(lockPath);
  } catch {}
}

function getLastEvent(logPath) {
  if (!fs.existsSync(logPath)) {
    return null;
  }
  const content = fs.readFileSync(logPath, 'utf8');
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length === 0) return null;
  return JSON.parse(lines[lines.length - 1]);
}

async function appendEvent(gitDir, type, data) {
  const provenanceDir = path.join(gitDir, 'provenance');
  const logPath = path.join(provenanceDir, 'log.jsonl');
  const lockPath = path.join(provenanceDir, 'log.lock');

  await acquireLock(lockPath);
  try {
    const lastEvent = getLastEvent(logPath);
    const seq = lastEvent ? lastEvent.seq + 1 : 0;
    const prev = lastEvent ? lastEvent.hash : '0'.repeat(64);

    const event = {
      v: 1,
      seq,
      ts: new Date().toISOString(),
      type,
      data,
      prev
    };
    event.hash = hashEvent(event);

    const line = JSON.stringify(event) + '\n';
    fs.appendFileSync(logPath, line, 'utf8');
    return event;
  } finally {
    releaseLock(lockPath);
  }
}

// ============================================================================
// SECRET DETECTION
// Refuse notes that look like they contain secrets
// ============================================================================

const SECRET_PATTERNS = [
  '-----BEGIN',
  'ghp_',
  'github_pat_',
  'AKIA',
  'sk-ant-'
];

function containsSecret(text) {
  return SECRET_PATTERNS.some(pattern => text.includes(pattern));
}

// ============================================================================
// SAFE FILE WRITE WITH RETRY
// Write temp file then rename to avoid partial writes on Windows
// ============================================================================

async function safeWriteJSON(filePath, obj) {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.tmp-${path.basename(filePath)}-${Date.now()}`);
  const content = JSON.stringify(obj, null, 2);

  fs.writeFileSync(tmpPath, content, 'utf8');

  for (let i = 0; i < 5; i++) {
    try {
      fs.renameSync(tmpPath, filePath);
      return;
    } catch (err) {
      if (err.code === 'EPERM' && i < 4) {
        await new Promise(resolve => setTimeout(resolve, 50));
      } else {
        throw err;
      }
    }
  }
}

// ============================================================================
// COMMAND: init
// ============================================================================

async function cmdInit(args) {
  const repoRoot = await getRepoRoot(process.cwd());
  const gitDir = await getGitDir(repoRoot);

  let githubLogin = args.github;
  if (!githubLogin) {
    githubLogin = await getGitHubLogin(repoRoot);
  }
  if (!githubLogin) {
    console.error('Error: Could not determine GitHub login. Use --github <login>');
    process.exit(1);
  }

  const provenanceDir = path.join(gitDir, 'provenance');
  if (!fs.existsSync(provenanceDir)) {
    fs.mkdirSync(provenanceDir, { recursive: true });
  }

  const configPath = path.join(provenanceDir, 'config.json');
  if (!fs.existsSync(configPath)) {
    await safeWriteJSON(configPath, { v: 1, enabled: true, paused: false });
  }

  const repoName = await getRepoName(repoRoot);
  const metaPath = path.join(provenanceDir, 'meta.json');
  await safeWriteJSON(metaPath, { developer: githubLogin, repo: repoName });

  // Install hook
  const hooksDir = (await execFileAsync('git', ['rev-parse', '--git-path', 'hooks'], { cwd: repoRoot })).stdout.trim();
  const hookPath = path.join(hooksDir, 'post-commit');
  const provenanceJsPath = normalizePathForLog(path.resolve(__filename));
  const hookBlock = `# provenance:start\nnode "${provenanceJsPath}" hook post-commit || true\n# provenance:end\n`;

  if (fs.existsSync(hookPath)) {
    const existing = fs.readFileSync(hookPath, 'utf8');
    if (!existing.includes('# provenance:start')) {
      fs.appendFileSync(hookPath, '\n' + hookBlock, 'utf8');
    }
  } else {
    fs.writeFileSync(hookPath, '#!/bin/sh\n' + hookBlock, { mode: 0o755 });
  }

  // Ensure LF line endings in hook
  const hookContent = fs.readFileSync(hookPath, 'utf8');
  const normalized = hookContent.replace(/\r\n/g, '\n');
  fs.writeFileSync(hookPath, normalized, 'utf8');

  console.log('Provenance initialized successfully!');
  console.log('');
  console.log('Next steps:');
  console.log('  1. Start recording: node provenance.js watch');
  console.log('  2. Add context: node provenance.js note "Implemented feature X"');
  console.log('  3. Make commits normally (the hook will record them)');
  console.log('  4. Publish: node provenance.js publish');
}

// ============================================================================
// COMMAND: note
// ============================================================================

async function cmdNote(args) {
  const text = args.text;
  if (!text || text.length === 0) {
    console.error('Error: Note text is required');
    process.exit(1);
  }
  if (text.length > 2000) {
    console.error('Error: Note text must be 2000 characters or less');
    process.exit(1);
  }
  if (containsSecret(text)) {
    console.error('Error: Note appears to contain a secret (found pattern like -----BEGIN, ghp_, AKIA, etc.)');
    console.error('Secrets should never be recorded in the log. Please remove them and try again.');
    process.exit(1);
  }

  const repoRoot = await getRepoRoot(process.cwd());
  const gitDir = await getGitDir(repoRoot);

  await appendEvent(gitDir, 'note', { text });
  console.log('Note recorded');
}

// ============================================================================
// COMMAND: watch
// ============================================================================

async function cmdWatch(args) {
  const repoRoot = await getRepoRoot(process.cwd());
  const gitDir = await getGitDir(repoRoot);

  await appendEvent(gitDir, 'session_start', { tool: 'provenance-mvp 0.1' });
  console.log('Recording started. Press Ctrl+C to stop.');

  const ignorePatterns = ['.git', 'node_modules', 'docs/provenance', 'dist', 'build', 'coverage', '.next', 'provenance'];
  const debounceMap = new Map();
  const hashCache = new Map();

  function shouldIgnore(filePath) {
    const rel = path.relative(repoRoot, filePath);
    return ignorePatterns.some(pattern => rel.startsWith(pattern) || rel.includes(path.sep + pattern));
  }

  async function handleFileChange(filePath) {
    if (shouldIgnore(filePath)) return;

    const rel = normalizePathForLog(path.relative(repoRoot, filePath));
    let changeType = 'modified';
    let bytes = null;
    let sha256 = null;

    try {
      const stat = fs.statSync(filePath);
      if (stat.size > 10 * 1024 * 1024) {
        bytes = stat.size;
      } else {
        const content = fs.readFileSync(filePath);
        bytes = content.length;
        sha256 = crypto.createHash('sha256').update(content).digest('hex');

        const lastHash = hashCache.get(rel);
        if (lastHash === sha256) return;
        hashCache.set(rel, sha256);
      }

      if (!hashCache.has(rel) && !fs.existsSync(path.join(repoRoot, rel))) {
        changeType = 'created';
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        changeType = 'deleted';
        hashCache.delete(rel);
      } else {
        return;
      }
    }

    await appendEvent(gitDir, 'file', { path: rel, change: changeType, bytes, sha256 });
    console.log(`Recorded: ${changeType} ${rel}`);
  }

  function debounceChange(filePath) {
    const existing = debounceMap.get(filePath);
    if (existing) clearTimeout(existing);
    debounceMap.set(filePath, setTimeout(() => {
      debounceMap.delete(filePath);
      handleFileChange(filePath).catch(() => {});
    }, 1500));
  }

  const watcher = fs.watch(repoRoot, { recursive: true }, (eventType, filename) => {
    if (!filename) return;
    const fullPath = path.join(repoRoot, filename);
    debounceChange(fullPath);
  });

  const cleanup = async () => {
    watcher.close();
    await appendEvent(gitDir, 'session_end', { tool: 'provenance-mvp 0.1' });
    console.log('Recording stopped');
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  if (args.duration) {
    setTimeout(cleanup, args.duration * 1000);
  }
}

// ============================================================================
// COMMAND: hook post-commit
// ============================================================================

async function cmdHook(args) {
  try {
    if (process.env.PROVENANCE_SKIP === '1') {
      process.exit(0);
    }

    const repoRoot = await getRepoRoot(process.cwd());
    const gitDir = await getGitDir(repoRoot);
    const configPath = path.join(gitDir, 'provenance', 'config.json');

    if (!fs.existsSync(configPath)) {
      process.exit(0);
    }

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!config.enabled || config.paused) {
      process.exit(0);
    }

    const isFirstCommit = (await execFileAsync('git', ['rev-list', '--count', 'HEAD'], { cwd: repoRoot })).stdout.trim() === '1';
    const logArgs = isFirstCommit
      ? ['log', '-1', '--format=%H%n%s']
      : ['log', '-1', '--format=%H%n%s'];
    const { stdout: logOutput } = await execFileAsync('git', logArgs, { cwd: repoRoot });
    const lines = logOutput.trim().split('\n');
    const sha = lines[0];
    const message = lines.slice(1).join('\n').slice(0, 200);

    const diffArgs = isFirstCommit
      ? ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', 'HEAD']
      : ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'];
    const { stdout: filesOutput } = await execFileAsync('git', diffArgs, { cwd: repoRoot });
    const files = filesOutput.trim().split('\n').filter(f => f).map(normalizePathForLog);

    await appendEvent(gitDir, 'commit', {
      sha: sha.slice(0, 7),
      message,
      fileCount: files.length,
      files: files.slice(0, 20)
    });

    process.exit(0);
  } catch (err) {
    const repoRoot = await getRepoRoot(process.cwd()).catch(() => process.cwd());
    const gitDir = await getGitDir(repoRoot).catch(() => path.join(repoRoot, '.git'));
    const errorLog = path.join(gitDir, 'provenance', 'hook-errors.log');
    fs.appendFileSync(errorLog, new Date().toISOString() + ' ' + err.stack + '\n');
    process.exit(0);
  }
}

// ============================================================================
// COMMAND: status
// ============================================================================

async function cmdStatus(args) {
  const repoRoot = await getRepoRoot(process.cwd());
  const gitDir = await getGitDir(repoRoot);
  const provenanceDir = path.join(gitDir, 'provenance');
  const configPath = path.join(provenanceDir, 'config.json');
  const metaPath = path.join(provenanceDir, 'meta.json');
  const logPath = path.join(provenanceDir, 'log.jsonl');

  if (!fs.existsSync(configPath)) {
    console.log('Provenance is not initialized. Run: node provenance.js init');
    return;
  }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : {};

  console.log('Status:', config.enabled ? (config.paused ? 'paused' : 'enabled') : 'disabled');
  console.log('Developer:', meta.developer || 'unknown');

  if (fs.existsSync(logPath)) {
    const lastEvent = getLastEvent(logPath);
    const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(l => l.trim());
    console.log('Events:', lines.length);
    if (lastEvent) {
      console.log('Head hash:', lastEvent.hash.slice(0, 12));
      console.log('Last event:', new Date(lastEvent.ts).toLocaleString());
    }
  } else {
    console.log('Events: 0');
  }

  const hooksDir = (await execFileAsync('git', ['rev-parse', '--git-path', 'hooks'], { cwd: repoRoot })).stdout.trim();
  const hookPath = path.join(hooksDir, 'post-commit');
  const hookInstalled = fs.existsSync(hookPath) && fs.readFileSync(hookPath, 'utf8').includes('# provenance:start');
  console.log('Hook installed:', hookInstalled ? 'yes' : 'no');
}

// ============================================================================
// COMMAND: bundle
// ============================================================================

async function cmdBundle(args) {
  const repoRoot = await getRepoRoot(process.cwd());
  const gitDir = await getGitDir(repoRoot);
  const provenanceDir = path.join(gitDir, 'provenance');
  const logPath = path.join(provenanceDir, 'log.jsonl');
  const lockPath = path.join(provenanceDir, 'log.lock');

  if (!fs.existsSync(logPath)) {
    console.error('Error: No log found. Run watch or make some commits first.');
    process.exit(1);
  }

  const outDir = args.out || path.join(repoRoot, 'docs', 'provenance');
  fs.mkdirSync(outDir, { recursive: true });

  await acquireLock(lockPath);
  try {
    const logContent = fs.readFileSync(logPath, 'utf8');
    const outLogPath = path.join(outDir, 'log.jsonl');
    fs.writeFileSync(outLogPath, logContent, 'utf8');

    const events = logContent.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
    const lastEvent = events[events.length - 1];
    const metaSourcePath = path.join(provenanceDir, 'meta.json');
    const metaSource = fs.existsSync(metaSourcePath) ? JSON.parse(fs.readFileSync(metaSourcePath, 'utf8')) : {};

    const bundleMeta = {
      v: 1,
      developer: metaSource.developer || 'unknown',
      repo: metaSource.repo || 'unknown',
      headHash: lastEvent.hash,
      eventCount: events.length,
      bundledAt: new Date().toISOString(),
      tool: 'provenance-mvp 0.1'
    };
    await safeWriteJSON(path.join(outDir, 'meta.json'), bundleMeta);

    // Sign
    let keyPath = args.key;
    if (!keyPath) {
      try {
        const { stdout } = await execFileAsync('git', ['config', 'user.signingkey'], { cwd: repoRoot });
        keyPath = expandHome(stdout.trim().replace(/\.pub$/, ''));
      } catch {}
    }

    if (keyPath) {
      try {
        await execFileAsync('ssh-keygen', ['-Y', 'sign', '-f', keyPath, '-n', 'provenance', outLogPath]);
        console.log('Log signed');
      } catch (err) {
        console.log('Signing failed:', err.message);
        console.log('Make sure your SSH key exists, has no passphrase, and OpenSSH >= 8.1 is installed');
      }
    } else {
      console.log('No signing key configured. Set user.signingkey or use --key');
    }

    // Timestamp
    if (!args['no-timestamp']) {
      try {
        const headHashBytes = Buffer.from(lastEvent.hash, 'hex');
        const response = await fetch('https://alice.btc.calendar.opentimestamps.org/digest', {
          method: 'POST',
          headers: {
            'Accept': 'application/vnd.opentimestamps.v1',
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: headHashBytes,
          signal: AbortSignal.timeout(10000)
        });

        if (response.ok) {
          const calendarBytes = Buffer.from(await response.arrayBuffer());
          const magic = Buffer.from([0x00, 0x4f, 0x70, 0x65, 0x6e, 0x54, 0x69, 0x6d, 0x65, 0x73, 0x74, 0x61, 0x6d, 0x70, 0x73, 0x00, 0x00, 0x50, 0x72, 0x6f, 0x6f, 0x66, 0x00, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94]);
          const versionByte = Buffer.from([0x01]);
          const sha256Op = Buffer.from([0x08]);
          const otsFile = Buffer.concat([magic, versionByte, sha256Op, headHashBytes, calendarBytes]);
          fs.writeFileSync(path.join(outDir, 'log.jsonl.ots'), otsFile);
          console.log('Timestamp pending proof created');
        }
      } catch (err) {
        // Best effort, don't fail
      }
    }

    // Create .nojekyll if in docs
    if (outDir.includes('/docs')) {
      const docsDir = outDir.split('/docs')[0] + '/docs';
      fs.writeFileSync(path.join(docsDir, '.nojekyll'), '');
    }

    console.log('Bundle created:', outDir);
  } finally {
    releaseLock(lockPath);
  }
}

// ============================================================================
// COMMAND: verify
// ============================================================================

async function cmdVerify(args) {
  const inputDir = args.dir || path.join(await getRepoRoot(process.cwd()), 'docs', 'provenance');

  let logPath = inputDir;
  if (fs.statSync(inputDir).isDirectory()) {
    logPath = path.join(inputDir, 'log.jsonl');
  }

  if (!fs.existsSync(logPath)) {
    console.error('Error: Log file not found:', logPath);
    process.exit(2);
  }

  const result = {
    chain: { status: 'ok', events: 0, headHash: '', reason: '' },
    signature: { status: 'missing', principal: '', fingerprint: '', reason: '' },
    timestamp: { status: 'missing' }
  };

  // Chain verification
  try {
    const logContent = fs.readFileSync(logPath, 'utf8').replace(/\r\n/g, '\n').trim();
    const lines = logContent.split('\n').filter(l => l.trim());

    let expectedPrev = '0'.repeat(64);
    for (let i = 0; i < lines.length; i++) {
      const event = JSON.parse(lines[i]);
      if (event.seq !== i) {
        result.chain.status = 'broken';
        result.chain.reason = `Event ${i}: sequence number mismatch (expected ${i}, got ${event.seq})`;
        break;
      }
      if (event.prev !== expectedPrev) {
        result.chain.status = 'broken';
        result.chain.reason = `Event ${i}: prev hash mismatch`;
        break;
      }
      const computedHash = hashEvent(event);
      if (computedHash !== event.hash) {
        result.chain.status = 'broken';
        result.chain.reason = `Event ${i}: hash mismatch`;
        break;
      }
      expectedPrev = event.hash;
    }

    if (result.chain.status === 'ok') {
      result.chain.events = lines.length;
      result.chain.headHash = expectedPrev;
    }
  } catch (err) {
    result.chain.status = 'broken';
    result.chain.reason = 'Failed to parse log: ' + err.message;
  }

  // Check bundle meta matches chain
  const metaPath = path.join(path.dirname(logPath), 'meta.json');
  if (fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (result.chain.status === 'ok' && meta.headHash !== result.chain.headHash) {
      result.chain.status = 'broken';
      result.chain.reason = 'Bundle meta headHash does not match computed chain head';
    }
  }

  // Signature verification
  const sigPath = logPath + '.sig';
  if (fs.existsSync(sigPath)) {
    let githubLogin = args.github;
    if (!githubLogin && fs.statSync(inputDir).isDirectory()) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      githubLogin = meta.developer;
    }

    if (!githubLogin) {
      result.signature.status = 'unchecked';
      result.signature.reason = 'No GitHub login provided (use --github)';
    } else {
      let allowedSignersPath = args['allowed-signers'];
      if (!allowedSignersPath && !args.offline) {
        try {
          const keysUrl = `https://github.com/${githubLogin}.keys`;
          const apiUrl = `https://api.github.com/users/${githubLogin}/ssh_signing_keys`;

          const [keysResp, apiResp] = await Promise.all([
            fetch(keysUrl, { signal: AbortSignal.timeout(10000) }),
            fetch(apiUrl, { signal: AbortSignal.timeout(10000) })
          ]);

          const keys = [];
          if (keysResp.ok) {
            const keysText = await keysResp.text();
            keys.push(...keysText.trim().split('\n').filter(k => k));
          }
          if (apiResp.ok) {
            const apiKeys = await apiResp.json();
            keys.push(...apiKeys.map(k => k.key));
          }

          if (keys.length > 0) {
            const tmpAllowed = path.join(os.tmpdir(), `provenance-allowed-${Date.now()}`);
            const lines = keys.map(k => `${githubLogin} namespaces="provenance" ${k}`);
            fs.writeFileSync(tmpAllowed, lines.join('\n') + '\n');
            allowedSignersPath = tmpAllowed;
          } else {
            result.signature.status = 'unchecked';
            result.signature.reason = 'No public keys found for GitHub user';
          }
        } catch (err) {
          result.signature.status = 'unchecked';
          result.signature.reason = 'Could not fetch keys from GitHub: ' + err.message;
        }
      }

      if (allowedSignersPath) {
        try {
          const logContent = fs.readFileSync(logPath);
          const proc = spawn('ssh-keygen', ['-Y', 'verify', '-f', allowedSignersPath, '-I', githubLogin, '-n', 'provenance', '-s', sigPath], {
            stdio: ['pipe', 'pipe', 'pipe']
          });
          proc.stdin.write(logContent);
          proc.stdin.end();

          const stdout = await new Promise((resolve, reject) => {
            let out = '';
            let err = '';
            proc.stdout.on('data', d => out += d);
            proc.stderr.on('data', d => err += d);
            proc.on('close', code => resolve({ code, stdout: out, stderr: err }));
            proc.on('error', reject);
          });

          if (stdout.code === 0) {
            result.signature.status = 'valid';
            result.signature.principal = githubLogin;
            const fpMatch = stdout.stderr.match(/key ([A-F0-9:]+)/);
            if (fpMatch) result.signature.fingerprint = fpMatch[1];
            result.signature.reason = 'Signature is valid';
          } else {
            result.signature.status = 'invalid';
            result.signature.reason = 'Signature verification failed';
          }
        } catch (err) {
          result.signature.status = 'unchecked';
          result.signature.reason = 'ssh-keygen not available or too old (need >= 8.1)';
        }
      } else if (args.offline) {
        result.signature.status = 'unchecked';
        result.signature.reason = 'Offline mode, no allowed-signers file provided';
      }
    }
  }

  // Timestamp
  const otsPath = logPath + '.ots';
  if (fs.existsSync(otsPath)) {
    result.timestamp.status = 'pending';
  }

  // Write verification.json
  if (fs.statSync(inputDir).isDirectory()) {
    await safeWriteJSON(path.join(inputDir, 'verification.json'), result);
  }

  // Output
  if (args.json) {
    const outPath = args.out || (fs.statSync(inputDir).isDirectory() ? path.join(inputDir, 'verification.json') : null);
    if (outPath) {
      await safeWriteJSON(outPath, result);
    }
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('Chain:', result.chain.status === 'ok' ? `OK (${result.chain.events} events, head ${result.chain.headHash.slice(0, 12)})` : `BROKEN - ${result.chain.reason}`);
    console.log('Signature:', result.signature.status, result.signature.reason ? `- ${result.signature.reason}` : '');
    console.log('Timestamp:', result.timestamp.status === 'pending' ? 'Pending proof exists (validate with official OpenTimestamps client)' : 'Missing');
  }

  const exitCode = result.chain.status === 'ok' && result.signature.status !== 'invalid' ? 0 : 1;
  process.exit(exitCode);
}

// ============================================================================
// COMMAND: report
// ============================================================================

async function cmdReport(args) {
  const repoRoot = await getRepoRoot(process.cwd());
  const bundleDir = args.dir || path.join(repoRoot, 'docs', 'provenance');
  const outPath = args.out || path.join(repoRoot, 'docs', 'index.html');

  const metaPath = path.join(bundleDir, 'meta.json');
  const logPath = path.join(bundleDir, 'log.jsonl');
  const verificationPath = path.join(bundleDir, 'verification.json');

  if (!fs.existsSync(logPath)) {
    console.error('Error: Bundle not found. Run bundle first.');
    process.exit(1);
  }

  const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : {};
  const logContent = fs.readFileSync(logPath, 'utf8');
  const events = logContent.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  const verification = fs.existsSync(verificationPath) ? JSON.parse(fs.readFileSync(verificationPath, 'utf8')) : {};

  const data = { meta, events, verification };
  const dataJSON = JSON.stringify(data).replace(/</g, () => '\\u003c').replace(/>/g, () => '\\u003e');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Provenance Log - ${meta.developer || 'Developer'}</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: system-ui, -apple-system, sans-serif; line-height: 1.6; padding: 20px; background: #f5f5f5; color: #333; }
@media (prefers-color-scheme: dark) {
  body { background: #1a1a1a; color: #e0e0e0; }
  .card { background: #2a2a2a; border-color: #444; }
  .banner.ok { background: #1a3a1a; border-color: #4a8a4a; }
  .banner.broken { background: #3a1a1a; border-color: #8a4a4a; }
  .note { background: #2a2a3a; border-left-color: #6a6aaa; }
  button { background: #3a3a3a; border-color: #555; color: #e0e0e0; }
  button:hover { background: #4a4a4a; }
}
.container { max-width: 900px; margin: 0 auto; }
h1 { margin-bottom: 20px; }
.banner { padding: 20px; margin-bottom: 20px; border-radius: 8px; font-weight: bold; font-size: 1.1em; border: 2px solid; }
.banner.ok { background: #e8f5e9; border-color: #4caf50; color: #2e7d32; }
.banner.broken { background: #ffebee; border-color: #f44336; color: #c62828; }
.card { background: white; padding: 20px; margin-bottom: 20px; border-radius: 8px; border: 1px solid #ddd; }
.card h2 { margin-bottom: 10px; font-size: 1.3em; }
.check-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 15px; margin-bottom: 20px; }
.check { padding: 15px; border-radius: 6px; background: #fafafa; border: 1px solid #e0e0e0; }
@media (prefers-color-scheme: dark) { .check { background: #2a2a2a; border-color: #444; } }
.check h3 { font-size: 0.9em; text-transform: uppercase; color: #666; margin-bottom: 5px; }
.check .status { font-size: 1.2em; font-weight: bold; }
.status.valid, .status.ok { color: #4caf50; }
.status.invalid, .status.broken { color: #f44336; }
.status.pending, .status.missing, .status.unchecked { color: #ff9800; }
.timeline { margin-top: 20px; }
.event { padding: 12px; margin-bottom: 10px; border-left: 3px solid #ccc; background: #fafafa; border-radius: 4px; }
@media (prefers-color-scheme: dark) { .event { background: #2a2a2a; border-left-color: #555; } }
.event.commit { border-left-color: #2196f3; }
.event.session { border-left-color: #9c27b0; }
.note { background: #f3e5f5; border-left: 4px solid #9c27b0; padding: 15px; margin: 10px 0; font-style: italic; border-radius: 4px; }
.note strong { display: block; font-style: normal; margin-bottom: 5px; color: #7b1fa2; }
.event-time { font-size: 0.85em; color: #666; }
.file-group { cursor: pointer; color: #1976d2; }
.file-group:hover { text-decoration: underline; }
details { margin-top: 5px; }
button { padding: 10px 20px; margin: 5px; border: 1px solid #ccc; border-radius: 4px; background: white; cursor: pointer; font-size: 1em; }
button:hover { background: #f0f0f0; }
.info-box { background: #fff3cd; border: 1px solid #ffc107; padding: 15px; border-radius: 6px; margin: 20px 0; }
@media (prefers-color-scheme: dark) { .info-box { background: #3a3a1a; border-color: #aa8a00; } }
</style>
</head>
<body>
<div class="container">
<h1>Provenance Log</h1>
<div id="banner" class="banner"></div>
<div class="check-grid">
<div class="check">
<h3>Integrity</h3>
<div id="chain-status" class="status"></div>
<div id="chain-detail"></div>
</div>
<div class="check">
<h3>Signature</h3>
<div id="sig-status" class="status"></div>
<div id="sig-detail"></div>
</div>
<div class="check">
<h3>Timestamp</h3>
<div id="ts-status" class="status"></div>
<div id="ts-detail"></div>
</div>
</div>
<div class="card">
<h2>Summary</h2>
<p><strong>Developer:</strong> <a id="dev-link" href="" target="_blank"></a></p>
<p><strong>Repository:</strong> <span id="repo"></span></p>
<p><strong>Events:</strong> <span id="event-count"></span></p>
<p><strong>Period:</strong> <span id="period"></span></p>
<p><strong>Commits:</strong> <span id="commit-count"></span> | <strong>File saves:</strong> <span id="file-count"></span> | <strong>Notes:</strong> <span id="note-count"></span></p>
</div>
<div class="card">
<h2>Timeline</h2>
<button id="toggle-order">Show newest first</button>
<button id="tamper-btn">Try to tamper</button>
<button id="restore-btn" style="display:none;">Restore</button>
<div id="timeline" class="timeline"></div>
</div>
<div class="info-box">
<h3>What this proves, and what it does not</h3>
<p><strong>Provenance proves WHEN a log existed, WHAT it recorded, and that it has not been changed since it was signed. It does NOT detect AI use and does not prove who typed the code.</strong></p>
<h4 style="margin-top:15px;">How to verify this yourself</h4>
<pre style="background:#f5f5f5;padding:10px;border-radius:4px;overflow-x:auto;">node provenance.js verify docs/provenance</pre>
</div>
</div>
<script type="application/json" id="provenance-data">${dataJSON}</script>
<script>
const dataEl = document.getElementById('provenance-data');
const rawData = JSON.parse(dataEl.textContent);
let data = JSON.parse(JSON.stringify(rawData));

function canonicalJSON(obj) {
  if (obj === null) return 'null';
  if (typeof obj === 'boolean') return obj ? 'true' : 'false';
  if (typeof obj === 'number') return String(obj);
  if (typeof obj === 'string') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalJSON).join(',') + ']';
  if (typeof obj === 'object') {
    const keys = Object.keys(obj).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJSON(obj[k])).join(',') + '}';
  }
  return 'null';
}

async function hashEvent(event) {
  const {hash, ...rest} = event;
  const canonical = canonicalJSON(rest);
  const encoder = new TextEncoder();
  const data = encoder.encode(canonical);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyChain(events) {
  let expectedPrev = '0'.repeat(64);
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event.seq !== i) return {ok: false, reason: \`Event \${i}: sequence mismatch\`};
    if (event.prev !== expectedPrev) return {ok: false, reason: \`Event \${i}: prev mismatch\`};
    const computed = await hashEvent(event);
    if (computed !== event.hash) return {ok: false, reason: \`Event \${i}: hash mismatch\`};
    expectedPrev = event.hash;
  }
  return {ok: true, headHash: expectedPrev};
}

async function render() {
  const chainResult = await verifyChain(data.events);
  const banner = document.getElementById('banner');
  const chainStatus = document.getElementById('chain-status');
  const chainDetail = document.getElementById('chain-detail');

  if (chainResult.ok) {
    banner.textContent = 'Log intact: nothing edited since it was recorded';
    banner.className = 'banner ok';
    chainStatus.textContent = 'OK';
    chainStatus.className = 'status ok';
    chainDetail.textContent = \`\${data.events.length} events, head \${chainResult.headHash.slice(0,12)}\`;
  } else {
    banner.textContent = 'Log broken: ' + chainResult.reason;
    banner.className = 'banner broken';
    chainStatus.textContent = 'BROKEN';
    chainStatus.className = 'status broken';
    chainDetail.textContent = chainResult.reason;
  }

  const sig = data.verification.signature || {};
  const sigStatus = document.getElementById('sig-status');
  const sigDetail = document.getElementById('sig-detail');
  sigStatus.textContent = (sig.status || 'missing').toUpperCase();
  sigStatus.className = 'status ' + (sig.status || 'missing');
  sigDetail.innerHTML = sig.principal ? \`Signer: \${sig.principal}<br>Fingerprint: \${sig.fingerprint || 'n/a'}<br><small>Checked when published; run verify yourself to repeat it</small>\` : (sig.reason || '');

  const ts = data.verification.timestamp || {};
  const tsStatus = document.getElementById('ts-status');
  const tsDetail = document.getElementById('ts-detail');
  tsStatus.textContent = (ts.status || 'missing').toUpperCase();
  tsStatus.className = 'status ' + (ts.status || 'missing');
  tsDetail.textContent = ts.status === 'pending' ? 'Pending proof exists (validate with official OpenTimestamps client)' : 'No timestamp proof';

  const devLink = document.getElementById('dev-link');
  devLink.textContent = data.meta.developer || 'unknown';
  devLink.href = 'https://github.com/' + (data.meta.developer || '');
  document.getElementById('repo').textContent = data.meta.repo || 'unknown';
  document.getElementById('event-count').textContent = data.events.length;

  const times = data.events.map(e => new Date(e.ts));
  document.getElementById('period').textContent = times.length > 0 ? \`\${times[0].toLocaleDateString()} – \${times[times.length-1].toLocaleDateString()}\` : 'n/a';
  document.getElementById('commit-count').textContent = data.events.filter(e => e.type === 'commit').length;
  document.getElementById('file-count').textContent = data.events.filter(e => e.type === 'file').length;
  document.getElementById('note-count').textContent = data.events.filter(e => e.type === 'note').length;

  renderTimeline();
}

let reverseOrder = false;

function renderTimeline() {
  const timeline = document.getElementById('timeline');
  timeline.innerHTML = '';
  const events = reverseOrder ? [...data.events].reverse() : data.events;

  let fileBuffer = [];
  function flushFiles() {
    if (fileBuffer.length === 0) return;
    const div = document.createElement('div');
    div.className = 'event';
    const summary = document.createElement('div');
    summary.className = 'file-group';
    summary.textContent = \`\${fileBuffer.length} file save\${fileBuffer.length>1?'s':''}\`;
    const details = document.createElement('details');
    const detailsSum = document.createElement('summary');
    detailsSum.textContent = 'Show files';
    details.appendChild(detailsSum);
    fileBuffer.forEach(f => {
      const p = document.createElement('p');
      p.textContent = \`\${f.data.change} \${f.data.path}\`;
      const time = document.createElement('span');
      time.className = 'event-time';
      time.textContent = ' – ' + new Date(f.ts).toLocaleString();
      p.appendChild(time);
      details.appendChild(p);
    });
    div.appendChild(summary);
    div.appendChild(details);
    timeline.appendChild(div);
    fileBuffer = [];
  }

  events.forEach(e => {
    if (e.type === 'file') {
      fileBuffer.push(e);
      return;
    }
    flushFiles();

    if (e.type === 'note') {
      const note = document.createElement('div');
      note.className = 'note';
      const label = document.createElement('strong');
      label.textContent = "Developer's explanation";
      note.appendChild(label);
      const text = document.createTextNode(e.data.text);
      note.appendChild(text);
      const time = document.createElement('div');
      time.className = 'event-time';
      time.textContent = new Date(e.ts).toLocaleString();
      note.appendChild(time);
      timeline.appendChild(note);
    } else if (e.type === 'commit') {
      const div = document.createElement('div');
      div.className = 'event commit';
      const p = document.createElement('p');
      const strong = document.createElement('strong');
      strong.textContent = 'Commit ' + e.data.sha + ': ';
      p.appendChild(strong);
      p.appendChild(document.createTextNode(e.data.message));
      div.appendChild(p);
      const files = document.createElement('p');
      files.textContent = \`\${e.data.fileCount} file\${e.data.fileCount>1?'s':''} changed\`;
      div.appendChild(files);
      const time = document.createElement('div');
      time.className = 'event-time';
      time.textContent = new Date(e.ts).toLocaleString();
      div.appendChild(time);
      timeline.appendChild(div);
    } else if (e.type === 'session_start' || e.type === 'session_end') {
      const div = document.createElement('div');
      div.className = 'event session';
      div.textContent = e.type === 'session_start' ? 'Recording started' : 'Recording stopped';
      const time = document.createElement('div');
      time.className = 'event-time';
      time.textContent = new Date(e.ts).toLocaleString();
      div.appendChild(time);
      timeline.appendChild(div);
    }
  });
  flushFiles();
}

document.getElementById('toggle-order').addEventListener('click', () => {
  reverseOrder = !reverseOrder;
  document.getElementById('toggle-order').textContent = reverseOrder ? 'Show oldest first' : 'Show newest first';
  renderTimeline();
});

let tampered = false;
document.getElementById('tamper-btn').addEventListener('click', async () => {
  const firstNote = data.events.find(e => e.type === 'note');
  if (firstNote) {
    firstNote.data.text = firstNote.data.text + ' [TAMPERED]';
  } else {
    data.events[0].data = {...data.events[0].data, tampered: true};
  }
  tampered = true;
  document.getElementById('tamper-btn').style.display = 'none';
  document.getElementById('restore-btn').style.display = 'inline-block';
  await render();
});

document.getElementById('restore-btn').addEventListener('click', async () => {
  data = JSON.parse(JSON.stringify(rawData));
  tampered = false;
  document.getElementById('tamper-btn').style.display = 'inline-block';
  document.getElementById('restore-btn').style.display = 'none';
  await render();
});

render();
</script>
</body>
</html>`;

  fs.writeFileSync(outPath, html, 'utf8');
  console.log('Report generated:', outPath);
}

// ============================================================================
// COMMAND: publish
// ============================================================================

async function cmdPublish(args) {
  const repoRoot = await getRepoRoot(process.cwd());

  await cmdBundle({ out: args.out, 'no-timestamp': args['no-timestamp'] });
  await cmdVerify({ dir: args.out || path.join(repoRoot, 'docs', 'provenance') });
  await cmdReport({ out: args.out ? path.join(args.out, '..', 'index.html') : undefined });

  const docsDir = path.join(repoRoot, 'docs');
  const filesToAdd = [
    path.join(docsDir, 'provenance'),
    path.join(docsDir, 'index.html'),
    path.join(docsDir, '.nojekyll')
  ].filter(f => fs.existsSync(f));

  await execFileAsync('git', ['add', ...filesToAdd], { cwd: repoRoot });

  const statusOutput = await execFileAsync('git', ['status', '--porcelain'], { cwd: repoRoot });
  if (!statusOutput.stdout.trim()) {
    console.log('Nothing new to publish');
    return;
  }

  const lastEvent = getLastEvent(path.join(await getGitDir(repoRoot), 'provenance', 'log.jsonl'));
  const eventCount = lastEvent ? lastEvent.seq + 1 : 0;
  const message = `provenance: publish log (${eventCount} events)\n\nCo-Authored-By: Claude Code <noreply@anthropic.com>`;

  await execFileAsync('git', ['commit', '-m', message], {
    cwd: repoRoot,
    env: { ...process.env, PROVENANCE_SKIP: '1' }
  });

  console.log('Committed provenance bundle');

  if (!args['no-push']) {
    try {
      await execFileAsync('git', ['push'], { cwd: repoRoot });
      console.log('Pushed to remote');
    } catch (err) {
      console.log('Push failed. The commit is saved locally. Run `git push` manually when ready.');
    }
  }
}

// ============================================================================
// CLI PARSER AND MAIN
// ============================================================================

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--') && !arg.startsWith('-----') && arg.length > 2 && /^[a-zA-Z]/.test(arg.slice(2))) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(arg);
    }
  }
  return args;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    console.log('Provenance - tamper-evident work log');
    console.log('');
    console.log('Commands:');
    console.log('  init [--github <login>]     Initialize provenance in this repo');
    console.log('  note "<text>"               Add a developer note');
    console.log('  watch [--duration <sec>]    Record file changes');
    console.log('  status                      Show current status');
    console.log('  bundle [--out <dir>] [--key <path>] [--no-timestamp]');
    console.log('  verify [dir] [--github <login>] [--allowed-signers <file>] [--offline] [--json]');
    console.log('  report [dir] [--out <file>]');
    console.log('  publish [--no-push] [--no-timestamp]');
    console.log('  hook post-commit            (internal use by git hook)');
    process.exit(0);
  }

  const command = argv[0];
  const args = parseArgs(argv.slice(1));

  try {
    switch (command) {
      case 'init': await cmdInit(args); break;
      case 'note': args.text = args._[0]; await cmdNote(args); break;
      case 'watch': await cmdWatch(args); break;
      case 'hook': await cmdHook(args); break;
      case 'status': await cmdStatus(args); break;
      case 'bundle': await cmdBundle(args); break;
      case 'verify': args.dir = args._[0]; await cmdVerify(args); break;
      case 'report': args.dir = args._[0]; await cmdReport(args); break;
      case 'publish': await cmdPublish(args); break;
      default:
        console.error('Unknown command:', command);
        console.error('Run with --help to see available commands');
        process.exit(1);
    }
  } catch (err) {
    if (args.debug) {
      console.error(err.stack);
    } else {
      console.error('Error:', err.message);
    }
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  canonicalJSON,
  hashEvent,
  appendEvent,
  getGitDir,
  getRepoRoot,
  normalizePathForLog,
  containsSecret,
  safeWriteJSON
};
