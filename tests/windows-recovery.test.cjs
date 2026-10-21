const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { execFileSync } = require('node:child_process');

test('Windows recovery restarts a stalled owned process, preserves healthy PID, and respects manual stop', { skip: process.platform !== 'win32', timeout: 90000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-recovery-test-'));
  const repo = path.join(__dirname, '..');
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  fs.mkdirSync(path.join(root, 'src'));
  for (const script of ['Start-TraeAPI.ps1', 'Stop-TraeAPI.ps1']) fs.copyFileSync(path.join(repo, script), path.join(root, script));
  fs.writeFileSync(path.join(root, '.env'), `PORT=${port}\n`);
  // Synthetic local health server: no credentials, Trae installation, or upstream calls.
  fs.writeFileSync(path.join(root, 'src', 'enterprise-server.js'), `
    const fs = require('fs');
    fs.rmSync('stall', {force:true});
    require('http').createServer((req,res)=>{
      if (fs.existsSync('stall')) return;
      res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify({adapter:'zedex-trae-cn-enterprise',status:'ok'}));
    }).listen(${port},'127.0.0.1');
  `);
  const env = { ...process.env };
  const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH';
  env[pathKey] = path.dirname(process.execPath) + path.delimiter + (env[pathKey] || '');
  // Detached Start-Process descendants can inherit pipe handles on Windows.
  const run = (script, ...args) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(root, script), ...args], { env, timeout: 35000, stdio: 'ignore' });
  const pidFile = path.join(root, 'data', 'service.pid.json');
  const record = () => JSON.parse(fs.readFileSync(pidFile, 'utf8').replace(/^\uFEFF/, ''));
  try {
    run('Start-TraeAPI.ps1');
    const first = record().pid;
    run('Start-TraeAPI.ps1', '-Scheduled');
    assert.equal(record().pid, first, 'healthy process must not restart');
    fs.writeFileSync(path.join(root, 'stall'), '');
    run('Start-TraeAPI.ps1', '-Scheduled');
    assert.notEqual(record().pid, first, 'unresponsive owned process must restart');
    const owned = record();
    // A PID recycled for another process must never be killed.
    fs.writeFileSync(pidFile, JSON.stringify({ ...owned, pid: process.pid }));
    assert.throws(() => run('Stop-TraeAPI.ps1'));
    fs.writeFileSync(pidFile, JSON.stringify(owned));
    run('Stop-TraeAPI.ps1');
    run('Start-TraeAPI.ps1', '-Scheduled');
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) }));
    // The recorded PID can be reused after exit. Start must ignore that record
    // and recover the absent proxy while leaving this test process alive.
    fs.writeFileSync(pidFile, JSON.stringify({ ...owned, pid: process.pid }));
    run('Start-TraeAPI.ps1');
    assert.notEqual(record().pid, process.pid);
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
  } finally {
    try { run('Stop-TraeAPI.ps1'); } catch {}
    // Only remove the exact temporary directory created above.
    if (path.dirname(path.resolve(root)) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('trae-recovery-test-')) fs.rmSync(root, { recursive: true, force: true });
  }
});
