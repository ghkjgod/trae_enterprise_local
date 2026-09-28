process.env.API_KEY = require('crypto').randomBytes(32).toString('hex');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { sseEvents, prepare, addCalls, desktopAlias } = require('../src/enterprise-server');

test('All published desktop aliases resolve to their distinct enterprise models', () => {
  const catalog = { models: ['qwen3.8-max', 'test-glm', 'test-deepseek'].map(id => ({ id, upstream_model: id + '__test', desktop_alias: desktopAlias(id), max_tokens: 32000 })) };
  const aliases = catalog.models.map(m => desktopAlias(m.id));
  assert.equal(new Set(aliases).size, catalog.models.length);
  for (const m of catalog.models) {
    const result = prepare({ model: desktopAlias(m.id), messages: [{ role: 'user', content: 'OK' }] }, 'anthropic', catalog);
    assert.equal(result.request.config_name, m.id);
    assert.equal(result.request.model_name, m.upstream_model);
  }
});

test('SSE keeps multibyte UTF-8 intact across network boundaries', async () => {
  const bytes = Buffer.from('data: ;Processing\n\nevent: output\r\ndata: {"response":"中文🙂"}\r\n\r\nevent: done\ndata: {"finish_reason":"stop"}\n\n');
  const events = [];
  for await (const event of sseEvents(Readable.from([...bytes].map(b => Buffer.from([b]))))) events.push(event);
  assert.equal(events[0].data.response, '中文🙂');
  assert.equal(events[1].event, 'done');
});
test('Native tool calls retain complete arguments and fragmented arguments', () => {
  const calls = new Map();
  addCalls(calls, [{ index: 0, id: 'one', function_call: { name: 'read', partial_arguments: '{"p":' } }]);
  addCalls(calls, [{ index: 0, function_call: { partial_arguments: '"a"}' } }]);
  addCalls(calls, [{ index: 1, id: 'two', function_call: { name: 'echo', arguments: '{"v":2}' } }]);
  assert.deepEqual(JSON.parse(calls.get(0).arguments), { p: 'a' });
  assert.deepEqual(JSON.parse(calls.get(1).arguments), { v: 2 });
});
test('Recorded enterprise arguments deltas reconstruct a long Chinese tool call', () => {
  const input = JSON.stringify({ title: '测试文档', content: Array.from({ length: 40 }, (_, i) => (i + 1) + '. Synthetic garden sentence.').join('\n') });
  const batches = Array.from({ length: Math.ceil(input.length / 13) }, (_, i) => [{ index: 0, id: i ? '' : 'synthetic-call', function_call: { name: i ? '' : 'create_document', arguments: input.slice(i * 13, (i + 1) * 13) } }]);
  assert.ok(batches.length > 3);
  const calls = new Map();
  for (const batch of batches) addCalls(calls, batch);
  assert.equal(calls.size, 1);
  const call = [...calls.values()][0];
  assert.equal(call.name, 'create_document');
  const parsedInput = JSON.parse(call.arguments);
  assert.equal(parsedInput.title, '测试文档');
  assert.ok(parsedInput.content.startsWith('1.'));
  assert.ok(parsedInput.content.includes('40.'));
});
test('Interleaved argument deltas remain attached to each tool call index', () => {
  const calls = new Map();
  addCalls(calls, [{index:0,id:'a',function_call:{name:'read',arguments:'{"path":"'}},{index:1,id:'b',function_call:{name:'read',arguments:'{"path":"'}}]);
  addCalls(calls, [{index:1,id:'',function_call:{name:'',arguments:'second"}'}},{index:0,id:'',function_call:{name:'',arguments:'first"}'}}]);
  assert.deepEqual(JSON.parse(calls.get(0).arguments), {path:'first'});
  assert.deepEqual(JSON.parse(calls.get(1).arguments), {path:'second'});
  assert.equal(calls.get(0).id,'a');
});
test('Tool result IDs and JSON schema survive Anthropic conversion', () => {
  const result = prepare({ model: 'qwen3.8-max', tools: [{ name: 'read', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }], messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call1', name: 'read', input: { path: 'a' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call1', content: 'contents' }] }
  ] }, 'anthropic', { models: [{ id: 'qwen3.8-max', upstream_model: 'qwen3.8-max__dev', desktop_alias: 'claude-sonnet-5', max_tokens: 32000 }] });
  assert.equal(result.request.messages[1].tool_call_id, 'call1');
  assert.equal(result.request.messages[0].tool_calls[0].function_call.arguments, '{"path":"a"}');
  assert.deepEqual(JSON.parse(result.request.tools[0].function.parameters).required, ['path']);
});
test('Different models keep their own upstream variant, with no silent fallback', () => {
  const catalog = { models: [{ id: 'glm-5v-turbo', upstream_model: 'glm-5__v2', desktop_alias: 'claude-sonnet-trae-glm-5v-turbo', max_tokens: 16000 }] };
  const body = { model: 'claude-sonnet-trae-glm-5v-turbo', max_tokens: 64000, messages: [{ role: 'user', content: 'OK' }] };
  const result = prepare(body, 'anthropic', catalog);
  assert.equal(result.request.model_name, 'glm-5__v2');
  assert.equal(result.request.config_name, 'glm-5v-turbo');
  assert.equal(result.request.max_tokens, 16000);
  assert.throws(() => prepare({ ...body, model: 'minimax-m3' }, 'anthropic', catalog), /not enabled/);
});
