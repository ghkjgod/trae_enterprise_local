const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { randomBytes } = require('node:crypto');
const key = randomBytes(32).toString('hex');
const bufferedDelay = Number(process.env.TRAE_TEST_BUFFER_DELAY_MS || 250);
process.env.API_KEY = key;
process.env.UPSTREAM_TIMEOUT_MS = String(Math.max(1000, bufferedDelay * 2));
process.env.SSE_HEARTBEAT_MS = bufferedDelay > 1000 ? '15000' : '40';

// Replace only the upstream transport/authentication in this test process.
// All client requests traverse the real HTTP handler; no account is accessed.
require('../src/trae-decrypt').decryptAuthData = () => ({
  token: 'synthetic-test-token', expiredAt: '2099-01-01T00:00:00Z',
  account: { scope: 'saas', saasBootConfig: { apiHost: 'https://console.enterprise.trae.cn' } },
});
require('../src/reasoning-effort').readReasoningCapabilities = () => ({});
const interrupted = new Set();
const completed = new Set();
function pause(ms, signal, label) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      interrupted.add(label);
      reject(Object.assign(new Error('Synthetic upstream aborted'), { name: 'AbortError' }));
    };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}
require('node-fetch');
require.cache[require.resolve('node-fetch')].exports = async (url, options) => {
  if (url.endsWith('/get_config_list')) return {
    ok: true, json: async () => ({ config_info_list: [{
      config_switch: true, config_name: 'DeepSeek-V4.1-Flash-1017',
      display_config: { display_name: 'Synthetic DeepSeek' },
      model_detail_list: [{ model_name: 'synthetic__dev', max_tokens: 32000, prompt_max_tokens: 168000 }],
    }] }),
  };
  assert.ok(url.endsWith('/llm_raw_chat'));
  const request = JSON.parse(options.body);
  assert.equal(request.stream, false);
  const label = request.messages[0].content[0].text;
  const delay = label === 'buffered' ? bufferedDelay : 10000;
  // Include waiting for response headers as well as waiting for its SSE body.
  await pause(Math.min(80, delay / 2), options.signal, label);
  return { ok: true, body: Readable.from((async function* () {
    await pause(delay, options.signal, label);
    completed.add(label);
    yield Buffer.from('event: output\ndata: ' + JSON.stringify({ tool_calls: [
      { index: 0, id: 'first', function_call: { name: 'read', arguments: '{"path":"a.txt"}' } },
      { index: 0, id: 'second', function_call: { name: 'read', arguments: '{"path":"b.txt"}' } },
    ] }) + '\n\nevent: done\ndata: {"finish_reason":"tool_calls"}\n\n');
  })()) };
};

const { app } = require('../src/enterprise-server');
let server, base;
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise(resolve => server.close(resolve)); });
const request = (label, stream, signal) => fetch(base + '/v1/chat/completions', {
  method: 'POST', signal,
  headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'DeepSeek-V4.1-Flash-1017', stream, messages: [{ role: 'user', content: label }] }),
});

test('buffered upstream sends heartbeats before complete independent tool calls', async () => {
  const response = await request('buffered', true);
  assert.equal(response.status, 200);
  assert.ok(!completed.has('buffered'), 'headers should arrive before the complete result');
  const body = await response.text();
  assert.ok(body.includes(': keep-alive\n\n'));
  assert.ok(body.includes('data: [DONE]'));
  assert.ok(!body.includes('event: error'));
  const events = body.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
  const calls = events.flatMap(event => event.choices[0].delta.tool_calls || []);
  assert.deepEqual(calls.map(call => [call.index, call.id, JSON.parse(call.function.arguments).path]), [
    [0, 'first', 'a.txt'], [1, 'second', 'b.txt'],
  ]);
  assert.ok(!interrupted.has('buffered'));
});

test('nonstreaming timeout returns HTTP 504 and an explicit upstream timeout code', async () => {
  const response = await request('timeout', false);
  assert.equal(response.status, 504);
  const error = (await response.json()).error;
  assert.equal(error.code, 'upstream_timeout');
  assert.match(error.message, /timed out after 1000 ms/);
  assert.ok(interrupted.has('timeout'));
});

test('streaming timeout emits an error after heartbeats and ends the response', async () => {
  const response = await request('stream-timeout', true);
  const body = await response.text();
  assert.ok(body.includes(': keep-alive'));
  assert.ok(body.includes('event: error'));
  assert.ok(body.includes('"code":"upstream_timeout"'));
  assert.ok(!body.includes('data: [DONE]'));
});

test('client cancellation aborts upstream work instead of waiting for its deadline', async () => {
  const controller = new AbortController();
  const response = await request('client-cancel', true, controller.signal);
  await response.body.getReader().read();
  controller.abort();
  for (let attempt = 0; attempt < 50 && !interrupted.has('client-cancel'); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(interrupted.has('client-cancel'));
});
