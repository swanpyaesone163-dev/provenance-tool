'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const {
  canonicalJSON,
  hashEvent,
  appendEvent,
  getGitDir,
  getRepoRoot,
  normalizePathForLog,
  containsSecret,
  safeWriteJSON
} = require('../provenance.js');

// ============================================================================
// TEST UTILITIES
// ============================================================================

async function createTestRepo() {
  const tmpBase = os.tmpdir();
  const repoName = `test repo ${Date.now()}`;
  const repoPath = path.join(tmpBase, repoName);
  fs.mkdirSync(repoPath, { recursive: true });

  await execFileAsync('git', ['init'], { cwd: repoPath });
  await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: repoPath });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath });

  return repoPath;
}

function cleanup(repoPath) {
  try {
    fs.rmSync(repoPath, { recursive: true, force: true });
  } catch {}
}

function normalizeForComparison(str) {
  return str.replace(/\r\n/g, '\n').trim();
}

// ============================================================================
// TESTS
// ============================================================================

test('canonicalJSON ignores key order', () => {
  const obj1 = { b: 2, a: 1 };
  const obj2 = { a: 1, b: 2 };
  assert.strictEqual(canonicalJSON(obj1), canonicalJSON(obj2));
  assert.strictEqual(canonicalJSON(obj1), '{"a":1,"b":2}');
});

test('canonicalJSON handles nested objects', () => {
  const obj = { z: { y: 3, x: 2 }, a: 1 };
  assert.strictEqual(canonicalJSON(obj), '{"a":1,"z":{"x":2,"y":3}}');
});

test('canonicalJSON handles arrays', () => {
  const obj = { arr: [3, 2, 1], val: 42 };
  assert.strictEqual(canonicalJSON(obj), '{"arr":[3,2,1],"val":42}');
});

test('hashEvent produces consistent hash', () => {
  const event = {
    v: 1,
    seq: 0,
    ts: '2024-01-01T00:00:00.000Z',
    type: 'note',
    data: { text: 'hello' },
    prev: '0'.repeat(64),
    hash: 'placeholder'
  };
  const hash1 = hashEvent(event);
  const hash2 = hashEvent(event);
  assert.strictEqual(hash1, hash2);
  assert.strictEqual(hash1.length, 64);
  assert.match(hash1, /^[0-9a-f]{64}$/);
});

test('appendEvent builds correct chain', async () => {
  const repoPath = await createTestRepo();
  try {
    const gitDir = await getGitDir(repoPath);
    const provenanceDir = path.join(gitDir, 'provenance');
    fs.mkdirSync(provenanceDir, { recursive: true });

    const event1 = await appendEvent(gitDir, 'note', { text: 'first' });
    assert.strictEqual(event1.seq, 0);
    assert.strictEqual(event1.prev, '0'.repeat(64));
    assert.strictEqual(event1.type, 'note');

    const event2 = await appendEvent(gitDir, 'note', { text: 'second' });
    assert.strictEqual(event2.seq, 1);
    assert.strictEqual(event2.prev, event1.hash);

    const event3 = await appendEvent(gitDir, 'note', { text: 'third' });
    assert.strictEqual(event3.seq, 2);
    assert.strictEqual(event3.prev, event2.hash);
  } finally {
    cleanup(repoPath);
  }
});

test('verify passes on good log', async () => {
  const repoPath = await createTestRepo();
  try {
    const gitDir = await getGitDir(repoPath);
    const provenanceDir = path.join(gitDir, 'provenance');
    fs.mkdirSync(provenanceDir, { recursive: true });

    await appendEvent(gitDir, 'note', { text: 'first' });
    await appendEvent(gitDir, 'note', { text: 'second' });

    const result = await execFileAsync(process.execPath, [
      path.resolve(__dirname, '../provenance.js'),
      'verify',
      path.join(provenanceDir, 'log.jsonl'),
      '--offline'
    ]);

    assert.match(result.stdout, /Chain: OK/);
  } finally {
    cleanup(repoPath);
  }
});

test('verify detects edited event', async () => {
  const repoPath = await createTestRepo();
  try {
    const gitDir = await getGitDir(repoPath);
    const provenanceDir = path.join(gitDir, 'provenance');
    fs.mkdirSync(provenanceDir, { recursive: true });

    await appendEvent(gitDir, 'note', { text: 'first' });
    await appendEvent(gitDir, 'note', { text: 'second' });
    await appendEvent(gitDir, 'note', { text: 'third' });

    const logPath = path.join(provenanceDir, 'log.jsonl');
    const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(l => l.trim());
    const event1 = JSON.parse(lines[1]);
    event1.data.text = 'TAMPERED';
    lines[1] = JSON.stringify(event1);
    fs.writeFileSync(logPath, lines.join('\n') + '\n');

    try {
      await execFileAsync(process.execPath, [
        path.resolve(__dirname, '../provenance.js'),
        'verify',
        logPath,
        '--offline'
      ]);
      assert.fail('Should have failed verification');
    } catch (err) {
      assert.strictEqual(err.code, 1);
      assert.match(err.stdout, /Event 1: hash mismatch/);
    }
  } finally {
    cleanup(repoPath);
  }
});

test('verify detects deleted line', async () => {
  const repoPath = await createTestRepo();
  try {
    const gitDir = await getGitDir(repoPath);
    const provenanceDir = path.join(gitDir, 'provenance');
    fs.mkdirSync(provenanceDir, { recursive: true });

    await appendEvent(gitDir, 'note', { text: 'first' });
    await appendEvent(gitDir, 'note', { text: 'second' });
    await appendEvent(gitDir, 'note', { text: 'third' });

    const logPath = path.join(provenanceDir, 'log.jsonl');
    const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(l => l.trim());
    lines.splice(1, 1);
    fs.writeFileSync(logPath, lines.join('\n') + '\n');

    try {
      await execFileAsync(process.execPath, [
        path.resolve(__dirname, '../provenance.js'),
        'verify',
        logPath,
        '--offline'
      ]);
      assert.fail('Should have failed verification');
    } catch (err) {
      assert.strictEqual(err.code, 1);
      assert.match(err.stdout, /Event 1: sequence number mismatch/);
    }
  } finally {
    cleanup(repoPath);
  }
});

test('verify detects reordered lines', async () => {
  const repoPath = await createTestRepo();
  try {
    const gitDir = await getGitDir(repoPath);
    const provenanceDir = path.join(gitDir, 'provenance');
    fs.mkdirSync(provenanceDir, { recursive: true });

    await appendEvent(gitDir, 'note', { text: 'first' });
    await appendEvent(gitDir, 'note', { text: 'second' });
    await appendEvent(gitDir, 'note', { text: 'third' });

    const logPath = path.join(provenanceDir, 'log.jsonl');
    const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(l => l.trim());
    [lines[1], lines[2]] = [lines[2], lines[1]];
    fs.writeFileSync(logPath, lines.join('\n') + '\n');

    try {
      await execFileAsync(process.execPath, [
        path.resolve(__dirname, '../provenance.js'),
        'verify',
        logPath,
        '--offline'
      ]);
      assert.fail('Should have failed verification');
    } catch (err) {
      assert.strictEqual(err.code, 1);
      assert.match(err.stdout, /Event 1: sequence number mismatch/);
    }
  } finally {
    cleanup(repoPath);
  }
});

test('concurrent appends maintain chain integrity', async () => {
  const repoPath = await createTestRepo();
  try {
    const gitDir = await getGitDir(repoPath);
    const provenanceDir = path.join(gitDir, 'provenance');
    fs.mkdirSync(provenanceDir, { recursive: true });

    const script = `
      const { appendEvent, getGitDir } = require('${path.resolve(__dirname, '../provenance.js').replace(/\\/g, '\\\\')}');
      (async () => {
        const gitDir = await getGitDir('${repoPath.replace(/\\/g, '\\\\')}');
        await appendEvent(gitDir, 'note', { text: 'concurrent-' + process.pid });
      })();
    `;

    const procs = [];
    for (let i = 0; i < 5; i++) {
      const proc = spawn(process.execPath, ['-e', script], { cwd: repoPath });
      procs.push(new Promise(resolve => proc.on('close', resolve)));
    }

    await Promise.all(procs);

    const logPath = path.join(provenanceDir, 'log.jsonl');
    const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(l => l.trim());
    assert.strictEqual(lines.length, 5);

    const events = lines.map(l => JSON.parse(l));
    for (let i = 0; i < events.length; i++) {
      assert.strictEqual(events[i].seq, i);
      const expectedPrev = i === 0 ? '0'.repeat(64) : events[i - 1].hash;
      assert.strictEqual(events[i].prev, expectedPrev);
      const computed = hashEvent(events[i]);
      assert.strictEqual(computed, events[i].hash);
    }
  } finally {
    cleanup(repoPath);
  }
});

test('secret-looking notes are refused', async () => {
  const repoPath = await createTestRepo();
  try {
    const gitDir = await getGitDir(repoPath);
    const provenanceDir = path.join(gitDir, 'provenance');
    fs.mkdirSync(provenanceDir, { recursive: true });

    const secrets = [
      '-----BEGIN PRIVATE KEY-----',
      'my token is ghp_abc123',
      'AKIAIOSFODNN7EXAMPLE',
      'sk-ant-api03-xyz'
    ];

    for (const secret of secrets) {
      try {
        await execFileAsync(process.execPath, [
          path.resolve(__dirname, '../provenance.js'),
          'note',
          secret
        ], { cwd: repoPath });
        assert.fail('Should have rejected secret');
      } catch (err) {
        assert.strictEqual(err.code, 1);
        assert.match(err.stderr, /secret/i);
      }
    }
  } finally {
    cleanup(repoPath);
  }
});

test('Windows backslash paths normalized', () => {
  const windowsPath = 'src\\components\\Button.jsx';
  const normalized = normalizePathForLog(windowsPath);
  assert.strictEqual(normalized, 'src/components/Button.jsx');
});

test('init is idempotent and hook has LF endings', async () => {
  const repoPath = await createTestRepo();
  try {
    const provenanceJs = path.resolve(__dirname, '../provenance.js');

    await execFileAsync(process.execPath, [provenanceJs, 'init', '--github', 'testuser'], { cwd: repoPath });
    await execFileAsync(process.execPath, [provenanceJs, 'init', '--github', 'testuser'], { cwd: repoPath });

    const hooksDir = (await execFileAsync('git', ['rev-parse', '--git-path', 'hooks'], { cwd: repoPath })).stdout.trim();
    const hookPath = path.resolve(repoPath, hooksDir, 'post-commit');
    const hookContent = fs.readFileSync(hookPath, 'utf8');

    assert.match(hookContent, /# provenance:start/);
    assert.match(hookContent, /# provenance:end/);
    assert.match(hookContent, /\|\| true/);

    const occurrences = (hookContent.match(/# provenance:start/g) || []).length;
    assert.strictEqual(occurrences, 1);

    assert.strictEqual(hookContent, hookContent.replace(/\r\n/g, '\n'));
    assert.match(hookContent, /node ".*provenance\.js" hook post-commit/);
  } finally {
    cleanup(repoPath);
  }
});

test('post-commit hook records commit', async () => {
  const repoPath = await createTestRepo();
  try {
    const provenanceJs = path.resolve(__dirname, '../provenance.js');

    await execFileAsync(process.execPath, [provenanceJs, 'init', '--github', 'testuser'], { cwd: repoPath });

    fs.writeFileSync(path.join(repoPath, 'test.txt'), 'hello world');
    await execFileAsync('git', ['add', 'test.txt'], { cwd: repoPath });
    await execFileAsync('git', ['commit', '-m', 'Test commit'], { cwd: repoPath });

    const gitDir = await getGitDir(repoPath);
    const logPath = path.join(gitDir, 'provenance', 'log.jsonl');
    assert.ok(fs.existsSync(logPath));

    const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(l => l.trim());
    assert.ok(lines.length > 0);

    const event = JSON.parse(lines[0]);
    assert.strictEqual(event.type, 'commit');
    assert.strictEqual(event.data.message, 'Test commit');
    assert.ok(event.data.files.includes('test.txt'));
  } finally {
    cleanup(repoPath);
  }
});

async function checkSshKeygenCapability() {
  const capTestDir = path.join(os.tmpdir(), `ssh cap test ${Date.now()}`);
  try {
    fs.mkdirSync(capTestDir, { recursive: true });
    const testKeyPath = path.join(capTestDir, 'testkey');
    const testFilePath = path.join(capTestDir, 'test.txt');
    fs.writeFileSync(testFilePath, 'test content');
    await execFileAsync('ssh-keygen', ['-t', 'ed25519', '-f', testKeyPath, '-N', '', '-C', 'test@test.com']);
    await execFileAsync('ssh-keygen', ['-Y', 'sign', '-f', testKeyPath, '-n', 'provenance', testFilePath]);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    try { fs.rmSync(capTestDir, { recursive: true, force: true }); } catch {}
  }
}

test('sign and verify with throwaway key gives valid', async () => {
  const cap = await checkSshKeygenCapability();
  if (!cap.ok) {
    console.log('SKIP: ssh-keygen signing not available:', cap.error);
    return;
  }

  const repoPath = await createTestRepo();
  try {
    const gitDir = await getGitDir(repoPath);
    const provenanceDir = path.join(gitDir, 'provenance');
    fs.mkdirSync(provenanceDir, { recursive: true });

    await appendEvent(gitDir, 'note', { text: 'signed note' });

    const keyPath = path.join(repoPath, 'testkey');
    await execFileAsync('ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-N', '', '-C', 'test@example.com']);

    const pubKey = fs.readFileSync(keyPath + '.pub', 'utf8').trim();
    const allowedSignersPath = path.join(repoPath, 'allowed_signers');
    fs.writeFileSync(allowedSignersPath, `testuser namespaces="provenance" ${pubKey}\n`);

    const logPath = path.join(provenanceDir, 'log.jsonl');
    await execFileAsync('ssh-keygen', ['-Y', 'sign', '-f', keyPath, '-n', 'provenance', logPath]);

    const result = await execFileAsync(process.execPath, [
      path.resolve(__dirname, '../provenance.js'),
      'verify',
      logPath,
      '--github', 'testuser',
      '--allowed-signers', allowedSignersPath
    ]);

    assert.match(result.stdout, /Signature: valid/);
  } finally {
    cleanup(repoPath);
  }
});

test('modifying log after signing gives invalid', async () => {
  const cap = await checkSshKeygenCapability();
  if (!cap.ok) {
    console.log('SKIP: ssh-keygen signing not available:', cap.error);
    return;
  }

  const repoPath = await createTestRepo();
  try {
    const gitDir = await getGitDir(repoPath);
    const provenanceDir = path.join(gitDir, 'provenance');
    fs.mkdirSync(provenanceDir, { recursive: true });

    await appendEvent(gitDir, 'note', { text: 'signed note' });

    const keyPath = path.join(repoPath, 'testkey');
    await execFileAsync('ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-N', '', '-C', 'test@example.com']);

    const pubKey = fs.readFileSync(keyPath + '.pub', 'utf8').trim();
    const allowedSignersPath = path.join(repoPath, 'allowed_signers');
    fs.writeFileSync(allowedSignersPath, `testuser namespaces="provenance" ${pubKey}\n`);

    const logPath = path.join(provenanceDir, 'log.jsonl');
    await execFileAsync('ssh-keygen', ['-Y', 'sign', '-f', keyPath, '-n', 'provenance', logPath]);

    // Tamper by modifying one byte of log.jsonl
    const logContent = fs.readFileSync(logPath, 'utf8');
    const tampered = logContent.replace('"signed note"', '"TAMPERED"');
    fs.writeFileSync(logPath, tampered);

    try {
      await execFileAsync(process.execPath, [
        path.resolve(__dirname, '../provenance.js'),
        'verify',
        logPath,
        '--github', 'testuser',
        '--allowed-signers', allowedSignersPath
      ]);
      assert.fail('Should have failed verification after tampering');
    } catch (err) {
      assert.match(err.stdout, /Signature: invalid/);
    }
  } finally {
    cleanup(repoPath);
  }
});

test('generated report HTML has no XSS vectors', async () => {
  const repoPath = await createTestRepo();
  try {
    const gitDir = await getGitDir(repoPath);
    const provenanceDir = path.join(gitDir, 'provenance');
    fs.mkdirSync(provenanceDir, { recursive: true });

    await appendEvent(gitDir, 'note', { text: '</script><script>alert(1)</script>' });

    const bundleDir = path.join(repoPath, 'docs', 'provenance');
    fs.mkdirSync(bundleDir, { recursive: true });

    const logPath = path.join(provenanceDir, 'log.jsonl');
    const bundleLogPath = path.join(bundleDir, 'log.jsonl');
    fs.copyFileSync(logPath, bundleLogPath);

    const meta = { v: 1, developer: 'testuser', repo: 'test', headHash: '0'.repeat(64), eventCount: 1, bundledAt: new Date().toISOString(), tool: 'provenance-mvp 0.1' };
    await safeWriteJSON(path.join(bundleDir, 'meta.json'), meta);
    await safeWriteJSON(path.join(bundleDir, 'verification.json'), { chain: { status: 'ok' }, signature: { status: 'missing' }, timestamp: { status: 'missing' } });

    await execFileAsync(process.execPath, [
      path.resolve(__dirname, '../provenance.js'),
      'report',
      bundleDir
    ], { cwd: repoPath });

    const htmlPath = path.join(repoPath, 'docs', 'index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');

    const scriptMatches = html.match(/<script>alert\(/g);
    assert.strictEqual(scriptMatches, null, 'HTML should not contain executable script injection');

    assert.ok(html.includes('\\u003c/script\\u003e'), 'HTML should contain escaped script tags');

    const httpMatches = html.match(/https?:\/\//g) || [];
    const githubLinks = httpMatches.filter(m => html.indexOf(m) > 0 && html.substring(html.indexOf(m) - 20, html.indexOf(m) + 30).includes('github.com'));
    const nonGithubLinks = httpMatches.length - githubLinks.length;
    assert.ok(nonGithubLinks === 0, 'HTML should not contain external resource references except GitHub profile links');
  } finally {
    cleanup(repoPath);
  }
});

test('containsSecret detects patterns', () => {
  assert.strictEqual(containsSecret('normal text'), false);
  assert.strictEqual(containsSecret('-----BEGIN PRIVATE KEY-----'), true);
  assert.strictEqual(containsSecret('my token: ghp_1234567890'), true);
  assert.strictEqual(containsSecret('AKIAIOSFODNN7EXAMPLE'), true);
  assert.strictEqual(containsSecret('sk-ant-api03-xyz'), true);
});
