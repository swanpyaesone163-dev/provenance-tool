'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const crypto = require('crypto');

const execFileAsync = promisify(execFile);
const provenanceJs = path.resolve(__dirname, '../provenance.js');

// ============================================================================
// HELPERS
// ============================================================================

function tmpRepoPath() {
  return path.join(os.tmpdir(), `e2e test repo ${Date.now()}`);
}

async function run(cmd, args, opts) {
  const result = await execFileAsync(cmd, args, { timeout: 30000, ...opts });
  return result.stdout.trim();
}

async function prov(args, cwd) {
  return run(process.execPath, [provenanceJs, ...args], { cwd });
}

function expect(condition, label) {
  if (!condition) {
    console.log(`E2E FAIL: ${label}`);
    process.exit(1);
  }
  console.log(`  OK: ${label}`);
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const argv = process.argv.slice(2);
  const keepFlag = argv.includes('--keep');
  const outIdx = argv.indexOf('--out');
  const outDir = outIdx >= 0 ? argv[outIdx + 1] : null;

  const repoPath = tmpRepoPath();
  fs.mkdirSync(repoPath, { recursive: true });
  console.log('E2E repo:', repoPath);

  try {
    // Init git repo
    await run('git', ['init'], { cwd: repoPath });
    await run('git', ['config', 'user.name', 'E2E Tester'], { cwd: repoPath });
    await run('git', ['config', 'user.email', 'e2e@test.com'], { cwd: repoPath });

    // Init provenance
    await prov(['init', '--github', 'e2etester'], repoPath);
    console.log('  OK: init');

    // Create and commit files
    fs.writeFileSync(path.join(repoPath, 'hello.txt'), 'Hello World');
    fs.writeFileSync(path.join(repoPath, 'data.json'), '{"key": "value"}');
    await run('git', ['add', '.'], { cwd: repoPath });
    await run('git', ['commit', '-m', 'Initial commit'], { cwd: repoPath });
    console.log('  OK: first commit (hook should have fired)');

    // Check commit event recorded
    const gitDir = (await run('git', ['rev-parse', '--absolute-git-dir'], { cwd: repoPath }));
    const logPath = path.join(gitDir, 'provenance', 'log.jsonl');
    expect(fs.existsSync(logPath), 'log.jsonl exists after commit');

    let lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(l => l.trim());
    expect(lines.length >= 1, 'at least one event after commit');

    const firstEvent = JSON.parse(lines[0]);
    expect(firstEvent.type === 'commit', 'first event is a commit');

    // Second commit
    fs.writeFileSync(path.join(repoPath, 'second.txt'), 'second file');
    await run('git', ['add', '.'], { cwd: repoPath });
    await run('git', ['commit', '-m', 'Add second file'], { cwd: repoPath });
    console.log('  OK: second commit');

    // Add notes
    await prov(['note', 'I built the authentication module from scratch'], repoPath);
    await prov(['note', 'Planning to refactor the database layer next'], repoPath);
    console.log('  OK: notes added');

    // Watch for short duration
    const watchProc = spawn(process.execPath, [provenanceJs, 'watch', '--duration', '4'], {
      cwd: repoPath,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    // Wait for watcher to start
    await new Promise(resolve => setTimeout(resolve, 500));

    // Create and modify a file while watcher runs
    fs.writeFileSync(path.join(repoPath, 'watched.txt'), 'initial content');
    await new Promise(resolve => setTimeout(resolve, 2000));
    fs.writeFileSync(path.join(repoPath, 'watched.txt'), 'modified content');

    // Wait for watcher to stop
    await new Promise((resolve) => {
      watchProc.on('close', resolve);
    });
    console.log('  OK: watch completed');

    // Check log state
    lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(l => l.trim());
    expect(lines.length >= 4, `enough events in log (got ${lines.length})`);

    // Generate throwaway key
    const keyPath = path.join(repoPath, 'e2e_key');
    await run('ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-N', '', '-C', 'e2e@test.com']);
    await run('git', ['config', 'user.signingkey', keyPath], { cwd: repoPath });
    await run('git', ['config', 'provenance.githubLogin', 'e2etester'], { cwd: repoPath });

    const pubKey = fs.readFileSync(keyPath + '.pub', 'utf8').trim();
    const allowedSignersPath = path.join(repoPath, 'allowed_signers');
    fs.writeFileSync(allowedSignersPath, `e2etester namespaces="provenance" ${pubKey}\n`);
    console.log('  OK: test key generated');

    // Bundle
    await prov(['bundle', '--no-timestamp'], repoPath);
    console.log('  OK: bundle created');

    const bundleDir = path.join(repoPath, 'docs', 'provenance');
    expect(fs.existsSync(path.join(bundleDir, 'log.jsonl')), 'bundle log.jsonl exists');
    expect(fs.existsSync(path.join(bundleDir, 'meta.json')), 'bundle meta.json exists');
    expect(fs.existsSync(path.join(bundleDir, 'log.jsonl.sig')), 'bundle signature exists');

    // Verify (expect pass)
    const verifyResult = await prov(['verify', bundleDir, '--github', 'e2etester', '--allowed-signers', allowedSignersPath], repoPath);
    expect(verifyResult.includes('Chain: OK'), 'verify chain OK');
    expect(verifyResult.includes('Signature: valid'), 'verify signature valid');
    console.log('  OK: verification passed');

    // Tamper and verify (expect fail)
    const bundleLogPath = path.join(bundleDir, 'log.jsonl');
    const bundleContent = fs.readFileSync(bundleLogPath, 'utf8');
    const bundleLines = bundleContent.split('\n').filter(l => l.trim());
    const tamperedEvent = JSON.parse(bundleLines[0]);
    tamperedEvent.data.message = 'TAMPERED';
    bundleLines[0] = JSON.stringify(tamperedEvent);
    fs.writeFileSync(bundleLogPath, bundleLines.join('\n') + '\n');

    try {
      await prov(['verify', bundleDir, '--github', 'e2etester', '--allowed-signers', allowedSignersPath], repoPath);
      expect(false, 'tampered verify should fail');
    } catch (err) {
      expect(err.code === 1, 'tampered verify exits with code 1');
      expect(err.stdout.includes('BROKEN'), 'tampered verify reports BROKEN');
      console.log('  OK: tampered verification failed as expected');
    }

    // Restore good bundle for report
    fs.writeFileSync(bundleLogPath, bundleContent);
    await prov(['verify', bundleDir, '--github', 'e2etester', '--allowed-signers', allowedSignersPath], repoPath);

    // Generate report
    await prov(['report', bundleDir], repoPath);
    const reportPath = path.join(repoPath, 'docs', 'index.html');
    expect(fs.existsSync(reportPath), 'report HTML exists');

    const html = fs.readFileSync(reportPath, 'utf8');
    expect(html.includes('provenance-data'), 'report contains data');
    expect(!html.includes('<script>alert'), 'report has no XSS');
    console.log('  OK: report generated');

    // Copy output if requested
    if (outDir) {
      fs.mkdirSync(outDir, { recursive: true });
      const filesToCopy = ['docs/index.html', 'docs/provenance/log.jsonl', 'docs/provenance/meta.json', 'docs/provenance/verification.json', 'docs/provenance/log.jsonl.sig'];
      for (const f of filesToCopy) {
        const src = path.join(repoPath, f);
        const dst = path.join(outDir, f);
        if (fs.existsSync(src)) {
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          fs.copyFileSync(src, dst);
        }
      }
      console.log('Output copied to:', outDir);
    }

    console.log('');
    console.log('E2E PASS');
    console.log('Page:', reportPath);

    if (!keepFlag) {
      fs.rmSync(repoPath, { recursive: true, force: true });
    } else {
      console.log('Temp repo kept at:', repoPath);
    }
  } catch (err) {
    console.error('E2E FAIL:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
