const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.API_KEY = require('crypto').randomBytes(32).toString('hex');
const { app } = require('../src/enterprise-server');
test('Health is local; model and chat APIs reject missing or wrong credentials', async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await fetch(base + '/health');
    assert.equal((await health.json()).status, 'ok');
    for (const route of ['/v1/models', '/v1/messages', '/v1/chat/completions']) {
      const response = await fetch(base + route, { method: route === '/v1/models' ? 'GET' : 'POST', headers: { Authorization: 'Bearer incorrect', 'Content-Type': 'application/json' }, ...(route !== '/v1/models' ? { body: '{}' } : {}) });
      assert.equal(response.status, 401);
    }
    const missing = await fetch(base + '/v1/models');
    assert.equal(missing.status, 401);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
