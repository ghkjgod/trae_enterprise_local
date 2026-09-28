const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');
const { promisify } = require('util');
const exec = promisify(execFile);

test('Setup preserves existing keys; client export uses synthetic authenticated catalog', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-public-test-'));
  const scripts = path.join(folder, 'scripts'); fs.mkdirSync(scripts);
  for (const name of ['init-env.cjs', 'export-clients.cjs']) fs.copyFileSync(path.join(__dirname, '..', 'scripts', name), path.join(scripts, name));
  let server;
  try {
    const setup = path.join(scripts, 'init-env.cjs');
    await exec(process.execPath, [setup]);
    const first = fs.readFileSync(path.join(folder, '.env'), 'utf8');
    const key = first.match(/^API_KEY=(.+)$/m)[1]; assert.equal(key.length, 64);
    await exec(process.execPath, [setup]); assert.equal(fs.readFileSync(path.join(folder, '.env'), 'utf8'), first);
    server = http.createServer((req, res) => {
      assert.equal(req.headers.authorization, 'Bearer ' + key);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'synthetic-model', display_name: 'Synthetic Model', desktop_alias: 'claude-sonnet-5-route-test', multimodal: false, prompt_max_tokens: 1000, max_tokens: 100, reasoning_effort_options: ['light', 'high'], effort_variants: [{ id: 'synthetic-model@light', level: 'light', desktop_alias: 'claude-sonnet-5-route-test-light' }, { id: 'synthetic-model@high', level: 'high', desktop_alias: 'claude-sonnet-5-route-test-high' }] }] }));
    });
    server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const result = await exec(process.execPath, [path.join(scripts, 'export-clients.cjs')], { env: { ...process.env, PORT: String(server.address().port), API_KEY: key, NODE_PATH: path.join(__dirname, '..', 'node_modules') } });
    assert.ok(!result.stdout.includes(key));
    const read = name => JSON.parse(fs.readFileSync(path.join(folder, 'generated', name), 'utf8'));
    assert.equal(read('claude-settings.local.json').modelPicker.options.length, 3);
    assert.equal(Object.keys(read('cc-switch-desktop.local.json').meta.claudeDesktopModelRoutes).length, 3);
    const model = read('opencode.local.json').providers['trae-enterprise'].models['synthetic-model'];
    assert.deepEqual(model.variants[1], { id: 'low', body: { reasoning_effort_level: 'light' } });
    assert.equal(model.variants.length, 3);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    const absolute = path.resolve(folder), temp = path.resolve(os.tmpdir());
    if (path.dirname(absolute) !== temp || !path.basename(absolute).startsWith('trae-public-test-')) throw new Error('Unsafe test cleanup path');
    fs.rmSync(absolute, { recursive: true, force: true });
  }
});
