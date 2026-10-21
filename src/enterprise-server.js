// Local enterprise adapter for ZedeX/trae-local-api f394031.
// Protocol constants verified against the installed official Trae CLI.
// Reuses ZedeX's Trae credential decoder; credentials stay in memory.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const express = require('express');
const crypto = require('crypto');
const fetch = require('node-fetch');
const { StringDecoder } = require('string_decoder');
const { decryptAuthData } = require('./trae-decrypt');
const path = require('path');
const os = require('os');
const { readReasoningCapabilities, chooseEffort } = require('./reasoning-effort');

const MODEL = process.env.DEFAULT_MODEL || 'qwen3.8-max';
const LEGACY_ALIASES = new Set(['claude-sonnet-5', 'claude-haiku-4-5-20251001']);
// These upstream models can drop their final output with stream:true.
// Request complete output while retaining client-facing SSE.
const BUFFERED_UPSTREAM_MODELS = new Set(['DeepSeek-V4.1-Flash', 'DeepSeek-V4.1-Flash-1017']);
const AUTH_DIR = process.env.TRAE_DATA_DIR || path.join(os.homedir(), 'AppData', 'Roaming', 'Trae CN');
const STATE_DIR = path.join(__dirname, '..', 'data');
const KEY = process.env.API_KEY;
const PORT = Number(process.env.PORT || 19900);
if (!KEY || KEY.length < 32) throw new Error('A random API_KEY of at least 32 characters is required.');
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('PORT must be an integer between 1 and 65535.');

function authInfo() {
  // Read each time so a login/refresh performed by Trae is picked up automatically.
  const a = decryptAuthData(AUTH_DIR);
  if (a.account?.scope !== 'saas') throw new Error('Expected a Trae CN enterprise account.');
  if (Date.parse(a.expiredAt) <= Date.now()) throw new Error('Trae login expired. Open Trae and sign in again.');
  const host = new URL(a.account.saasBootConfig.apiHost);
  if (host.origin !== 'https://console.enterprise.trae.cn') throw new Error('Unexpected enterprise API host; review the account configuration.');
  return { token: a.token, host: host.origin, expires: a.expiredAt };
}

function upstreamHeaders(token) {
  return { 'Content-Type': 'application/json', Authorization: 'Cloud-IDE-JWT ' + token,
    'X-App-Id': '7b3f9dc2-8a4e-5c6d-2f1b-9e4a3c5b7df0', 'X-IDE-Version-Code': '20260206', 'X-IDE-Version': '99.99.99', 'X-IDE-Function': 'chat' };
}
let catalogCache = null, catalogPromise = null;
function desktopAlias(id) { return id === MODEL ? 'claude-sonnet-5' : 'claude-sonnet-5-route-' + crypto.createHash('sha256').update(id).digest('hex').slice(0, 12); }
// These chat_model catalog entries emitted reasoning_content in direct probes.
const verifiedReasoningModels = new Set(['kimi-k2.8-preview', 'kimi-k2.7-code', 'DeepSeek-V4.1-Flash', 'DeepSeek-V4-Pro-Official', 'DeepSeek-V4-Flash-Official']);
async function getCatalog(force = false) {
  if (!force && catalogCache && Date.now() - catalogCache.fetchedAt < 300000) return catalogCache;
  if (catalogPromise) return catalogPromise;
  catalogPromise = (async () => {
    const auth = authInfo();
    const response = await fetch(auth.host + '/api/ide/v1/cli/get_config_list', { method: 'POST', headers: upstreamHeaders(auth.token), body: JSON.stringify({ function: 'chat' }), timeout: 20000 });
    if (!response.ok) throw new Error(`Trae model catalog HTTP ${response.status}`);
    const data = await response.json();
    if (data.code) throw new Error(`Trae model catalog error ${data.code}`);
    const models = [], excluded = [];
    const effortCapabilities = readReasoningCapabilities(AUTH_DIR);
    for (const entry of data.config_info_list || []) {
      const display = entry.display_config || {}, variant = entry.model_detail_list?.[0];
      if (!entry.config_switch || display.is_invisible_to_user || !display.display_name || !variant?.model_name || display.is_custom_model) {
        excluded.push({ id: entry.config_name, reason: !entry.config_switch ? 'disabled_by_upstream' : display.is_custom_model ? 'custom_provider_requires_separate_adapter' : 'hidden_or_internal' });
        continue;
      }
      const effort = effortCapabilities[entry.config_name];
      models.push({ id: entry.config_name, display_name: display.display_name, upstream_model: variant.model_name,
        reasoning_effort_options: effort?.options || [], default_reasoning_effort: effort?.default_level,
        effort_variants: (effort?.options || []).map(level => ({ id: entry.config_name + '@' + level, level, desktop_alias: desktopAlias(entry.config_name + '@' + level) })),
        desktop_alias: desktopAlias(entry.config_name), max_tokens: variant.max_tokens || 16000,
        prompt_max_tokens: variant.prompt_max_tokens || 100000, multimodal: display.multimodal === true, reasoning: display.model_capability === 'reasoning_model' || !!effort?.options?.length || verifiedReasoningModels.has(entry.config_name) });
    }
    if (!models.length) throw new Error('Trae returned no enabled models');
    catalogCache = { models, excluded, fetchedAt: Date.now() };
    // This file contains only model names and capabilities, never credentials or encrypted parameters.
    require('fs').mkdirSync(STATE_DIR, { recursive: true });
    require('fs').writeFileSync(path.join(STATE_DIR, 'model-catalog.json'), JSON.stringify(catalogCache, null, 2));
    return catalogCache;
  })();
  try { return await catalogPromise; } finally { catalogPromise = null; }
}

function authenticate(req, res, next) {
  const value = req.headers.authorization?.replace(/^Bearer /i, '') || req.headers['x-api-key'] || '';
  const received = Buffer.from(String(value)), expected = Buffer.from(KEY);
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
    return res.status(401).json({ type: 'error', error: { type: 'authentication_error', message: 'Invalid API key' } });
  }
  next();
}

function parts(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return (content || []).map(p => {
    if (p.type === 'text') return { type: 'text', text: p.text };
    if (p.type === 'image' && p.source?.type === 'base64') return { type: 'image_url', image_url: { url: `data:${p.source.media_type};base64,${p.source.data}` } };
    if (p.type === 'image' && p.source?.type === 'url') return { type: 'image_url', image_url: { url: p.source.url } };
    if (p.type === 'image_url') return p;
    throw new Error(`Unsupported content block: ${p.type}`);
  });
}

function anthropicMessages(body) {
  const out = [];
  if (body.system) out.push({ role: 'system', content: parts(body.system) });
  for (const m of body.messages) {
    if (typeof m.content === 'string') { out.push({ role: m.role, content: parts(m.content) }); continue; }
    const text = [], calls = [], results = [], thoughts = [];
    for (const p of m.content || []) {
      if (p.type === 'tool_use') calls.push({ id: p.id, type: 'function', function_call: { name: p.name, arguments: JSON.stringify(p.input || {}) } });
      else if (p.type === 'tool_result') results.push({ role: 'tool', tool_call_id: p.tool_use_id, content: parts(p.content || '') });
      else if (p.type === 'thinking' && p.thinking) thoughts.push(p.thinking);
      else if (p.type !== 'redacted_thinking') text.push(...parts([p]));
    }
    // Tool results must follow the assistant calls before the next user text.
    out.push(...results);
    if (text.length || calls.length) out.push({ role: m.role, content: text, ...(thoughts.length ? { reasoning_content: thoughts.join('') } : {}), ...(calls.length ? { tool_calls: calls } : {}) });
  }
  return out;
}

function openaiMessages(body) {
  return body.messages.map(m => ({ role: m.role === 'developer' ? 'system' : m.role,
    content: parts(m.content || ''), ...(m.reasoning_content ? { reasoning_content: m.reasoning_content } : {}), ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    ...(m.tool_calls?.length ? { tool_calls: m.tool_calls.map(t => ({ id: t.id, type: 'function', function_call: t.function })) } : {})
  }));
}

function prepare(body, protocol, catalog) {
  if (!body || !Array.isArray(body.messages) || !body.messages.length) throw new Error('messages must be a non-empty array');
  const model = body.model || MODEL;
  const target = LEGACY_ALIASES.has(model) ? MODEL : model;
  const selected = catalog.models.find(m => m.id === target || m.desktop_alias === target || 'claude-sonnet-trae-' + m.id.toLowerCase().replace(/[^a-z0-9-]/g, '-') === target || m.effort_variants?.some(v => v.id === target || v.desktop_alias === target));
  if (!selected) throw new Error(`Model is not enabled in the enterprise catalog: ${model}`);
  const messages = protocol === 'anthropic' ? anthropicMessages(body) : openaiMessages(body);
  const request = { model_name: selected.upstream_model, config_name: selected.id, user_input: '',
    session_id: crypto.randomUUID(), conversation_id: crypto.randomUUID(), messages, stream: !BUFFERED_UPSTREAM_MODELS.has(selected.id) };
  const requestedMax = body.max_completion_tokens ?? body.max_tokens;
  request.max_tokens = Number.isFinite(requestedMax) ? Math.max(1, Math.min(requestedMax, selected.max_tokens)) : selected.max_tokens;
  if (!selected.multimodal && messages.some(m => m.content?.some(p => p.type === 'image_url'))) throw new Error(`Image input is not enabled for ${selected.id} in the Trae enterprise catalog`);
  const pinned = selected.effort_variants?.find(v => v.id === target || v.desktop_alias === target)?.level;
  const effort = chooseEffort(body, selected, pinned);
  if (effort) request.reasoning_effort_level = effort;
  if (Number.isFinite(body.temperature)) request.temperature = body.temperature;
  if (Number.isFinite(body.top_p)) request.top_p = body.top_p;
  let tools = body.tools || [];
  const tc = body.tool_choice;
  if (tc === 'none' || tc?.type === 'none') tools = [];
  if (tools.length) {
    request.tools = tools.map(t => {
      const f = protocol === 'anthropic' ? { name: t.name, description: t.description || '', parameters: t.input_schema } : t.function;
      if (!f?.name || !f.parameters) throw new Error('A tool must have a name and a JSON input schema');
      return { type: 'function', function: { name: f.name, description: f.description || '', parameters: typeof f.parameters === 'string' ? f.parameters : JSON.stringify(f.parameters) } };
    });
    if (tc) request.tool_choice = typeof tc === 'string' ? tc : tc.type === 'any' ? 'required' : tc.type === 'tool' ? tc.name : tc.type === 'function' ? tc.function.name : 'auto';
  }
  return { request, model, actualModel: selected.id };
}

async function* sseEvents(body) {
  const decoder = new StringDecoder('utf8');
  let buffer = '', event = '', data = [];
  const parse = () => {
    if (!data.length) return null;
    const text = data.join('\n'); data = [];
    if (text === '[DONE]') return { event: 'done', data: { finish_reason: 'stop' } };
    // Trae also sends non-JSON progress/heartbeat events (e.g. ;Processing).
    if (!['output', 'error', 'token_usage', 'done'].includes(event)) return null;
    try { return { event, data: JSON.parse(text) }; }
    catch { throw new Error(`Malformed Trae ${event} event`); }
  };
  for await (const chunk of body) {
    buffer += decoder.write(chunk);
    let pos;
    while ((pos = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, pos).replace(/\r$/, ''); buffer = buffer.slice(pos + 1);
      if (!line) { const result = parse(); if (result) yield result; event = ''; }
      else if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
  }
  buffer += decoder.end();
  if (buffer.startsWith('data:')) data.push(buffer.slice(5).trimStart());
  const last = parse(); if (last) yield last;
}

function addCalls(calls, incoming, { complete = false } = {}) {
  for (const t of incoming || []) {
    // With upstream stream:false, Trae sends complete calls but can assign
    // index:0 to every call. Their IDs, not these repeated indexes, identify
    // separate operations. A repeated complete call replaces its snapshot.
    const known = complete && t.id ? [...calls].find(([, call]) => call.id === t.id) : undefined;
    const index = complete ? (known ? known[0] : calls.size) : (t.index ?? calls.size);
    let old = calls.get(index);
    if (!old) { old = { id: t.id || 'toolu_' + crypto.randomBytes(12).toString('hex'), name: '', arguments: '' }; calls.set(index, old); }
    if (t.id) old.id = t.id;
    const f = t.function_call || t.function || {};
    if (f.name) old.name = f.name;
    if (complete) {
      old.arguments = typeof f.arguments === 'string' ? f.arguments : (f.partial_arguments || '');
      continue;
    }
    // Enterprise output events carry deltas in arguments as well as partial_arguments.
    // Replacing this field discards earlier chunks of long tool calls.
    if (typeof f.arguments === 'string' && f.arguments) old.arguments += f.arguments;
    else if (typeof f.partial_arguments === 'string') old.arguments += f.partial_arguments;
  }
}

function usage(u = {}) {
  return { input_tokens: u.prompt_tokens || 0, output_tokens: u.completion_tokens || 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens || 0, cache_read_input_tokens: u.cache_read_input_tokens || 0 };
}
function stopReason(reason, hasTools) { return hasTools ? 'tool_use' : reason === 'length' ? 'max_tokens' : 'end_turn'; }

async function handle(req, res, protocol) {
  const begun = Date.now(), id = (protocol === 'anthropic' ? 'msg_' : 'chatcmpl_') + crypto.randomBytes(12).toString('hex');
  let prepared;
  let catalog;
  try { catalog = await getCatalog(); }
  catch (e) { return res.status(503).json({ type: 'error', error: { type: 'api_error', message: e.message } }); }
  try { prepared = prepare(req.body, protocol, catalog); }
  catch (e) { return res.status(400).json({ type: 'error', error: { type: 'invalid_request_error', message: e.message } }); }
  const { request, model, actualModel } = prepared;
  res.setHeader('X-Trae-Model', actualModel);
  res.setHeader('X-Trae-Reasoning-Effort', request.reasoning_effort_level || 'default');
  const stream = req.body.stream === true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  let started = false, text = '', reasoning = '', finish = null, tokenUsage = {}, calls = new Map();
  let blockIndex = -1, blockType = null;
  const writeEvent = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const writeOpenAI = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(begun / 1000), model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  const start = () => {
    if (started) return;
    started = true;
    res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    if (protocol === 'anthropic') writeEvent('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: usage() } });
    else writeOpenAI({ role: 'assistant', content: '' });
  };
  const closeBlock = () => {
    if (blockType) writeEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex });
    blockType = null;
  };
  const emitContent = (type, value) => {
    if (!stream || !value) return;
    start();
    if (protocol !== 'anthropic') { writeOpenAI(type === 'thinking' ? { reasoning_content: value } : { content: value }); return; }
    if (blockType !== type) {
      closeBlock(); blockType = type; blockIndex++;
      writeEvent('content_block_start', { type: 'content_block_start', index: blockIndex, content_block: type === 'thinking' ? { type, thinking: '' } : { type, text: '' } });
    }
    writeEvent('content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: type === 'thinking' ? { type: 'thinking_delta', thinking: value } : { type: 'text_delta', text: value } });
  };
  try {
    const auth = authInfo();
    const response = await fetch(auth.host + '/api/ide/v2/llm_raw_chat', {
      method: 'POST', signal: controller.signal,
      headers: upstreamHeaders(auth.token),
      body: JSON.stringify(request)
    });
    if (!response.ok) throw new Error(`Trae upstream HTTP ${response.status}`);
    for await (const evt of sseEvents(response.body)) {
      const d = evt.data;
      if (evt.event === 'error') throw new Error(`Trae upstream error ${d.code || 'unknown'}: ${d.message || 'Request failed'}`);
      if (evt.event === 'output') {
        const thought = d.reasoning_content || d.reasoning || '';
        if (thought) { reasoning += thought; emitContent('thinking', thought); }
        if (d.response) { text += d.response; emitContent('text', d.response); }
        addCalls(calls, d.tool_calls, { complete: !request.stream });
      } else if (evt.event === 'token_usage') tokenUsage = d;
      else if (evt.event === 'done') finish = d.finish_reason || 'stop';
    }
    if (!finish) throw new Error('Trae stream ended without a done event');
    if (!text && !calls.size) throw new Error('Trae returned no text or tool calls');
    const toolBlocks = [...calls.values()].map(c => {
      let input;
      try { input = JSON.parse(c.arguments || '{}'); }
      catch { throw new Error('Trae returned invalid tool argument JSON'); }
      return { type: 'tool_use', id: c.id, name: c.name, input };
    });
    if (toolBlocks.some(t => !t.name)) throw new Error('Trae returned an incomplete tool call');
    const u = usage(tokenUsage), reason = stopReason(finish, toolBlocks.length);
    if (stream) {
      start();
      if (protocol === 'anthropic') {
        closeBlock();
        toolBlocks.forEach((t, i) => {
          const index = ++blockIndex;
          writeEvent('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: t.id, name: t.name, input: {} } });
          writeEvent('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(t.input) } });
          writeEvent('content_block_stop', { type: 'content_block_stop', index });
        });
        writeEvent('message_delta', { type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage: u });
        writeEvent('message_stop', { type: 'message_stop' });
      } else {
        if (toolBlocks.length) writeOpenAI({ tool_calls: toolBlocks.map((t, index) => ({ index, id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.input) } })) });
        writeOpenAI({}, toolBlocks.length ? 'tool_calls' : finish);
        if (req.body.stream_options?.include_usage) res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(begun / 1000), model, choices: [], usage: { prompt_tokens: u.input_tokens, completion_tokens: u.output_tokens, total_tokens: u.input_tokens + u.output_tokens } })}\n\n`);
        res.write('data: [DONE]\n\n');
      }
      res.end();
    } else if (protocol === 'anthropic') res.json({ id, type: 'message', role: 'assistant', model, content: [...(reasoning ? [{ type: 'thinking', thinking: reasoning }] : []), ...(text ? [{ type: 'text', text }] : []), ...toolBlocks], stop_reason: reason, stop_sequence: null, usage: u });
    else res.json({ id, object: 'chat.completion', created: Math.floor(begun / 1000), model, choices: [{ index: 0, message: { role: 'assistant', content: text || null, ...(reasoning ? { reasoning_content: reasoning } : {}), ...(toolBlocks.length ? { tool_calls: toolBlocks.map(t => ({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.input) } })) } : {}) }, finish_reason: toolBlocks.length ? 'tool_calls' : finish }], usage: { prompt_tokens: u.input_tokens, completion_tokens: u.output_tokens, total_tokens: u.input_tokens + u.output_tokens } });
    console.log(JSON.stringify({ protocol, stream, model: actualModel, reasoning_effort_level: request.reasoning_effort_level || 'default', status: 'ok', tools: toolBlocks.length, duration_ms: Date.now() - begun }));
  } catch (e) {
    const error = { type: 'error', error: { type: 'api_error', message: e.name === 'AbortError' ? 'Request cancelled or timed out' : e.message } };
    if (!res.destroyed) {
      if (started) { writeEvent('error', error); res.end(); }
      else res.status(502).json(error);
    }
    console.error(JSON.stringify({ protocol, model: actualModel, reasoning_effort_level: request.reasoning_effort_level || 'default', upstream_stream: request.stream, status: 'error', message: error.error.message, duration_ms: Date.now() - begun }));
  } finally { clearTimeout(timeout); controller.abort(); }
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10mb' }));
app.get('/health', (req, res) => res.json({ status: 'ok', adapter: 'zedex-trae-cn-enterprise', default_model: MODEL, cached_models: catalogCache?.models.length || 0 }));
app.use(authenticate);
app.get('/v1/models', async (req, res) => {
  try {
    const catalog = await getCatalog(req.query.refresh === 'true');
    res.json({ object: 'list', data: catalog.models.map(m => ({ ...m, object: 'model', created: 0, owned_by: 'trae-enterprise' })), excluded: catalog.excluded });
  } catch (e) { res.status(503).json({ error: e.message }); }
});
app.get('/v1/status', (req, res) => {
  try { const a = authInfo(); res.json({ status: 'ok', edition: 'cn-enterprise', token_expires_at: a.expires, model: MODEL }); }
  catch (e) { res.status(503).json({ error: e.message }); }
});
app.post('/v1/messages', (req, res) => handle(req, res, 'anthropic'));
app.post('/v1/chat/completions', (req, res) => handle(req, res, 'openai'));
app.use((req, res) => res.status(404).json({ error: 'Endpoint not enabled in the enterprise adapter' }));
if (require.main === module) app.listen(PORT, '127.0.0.1', () => console.log(`Trae enterprise adapter listening on 127.0.0.1:${PORT}; model=${MODEL}`));
module.exports = { app, prepare, sseEvents, addCalls, desktopAlias };
