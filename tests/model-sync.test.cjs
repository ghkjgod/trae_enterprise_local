process.env.API_KEY = require('crypto').randomBytes(32).toString('hex');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildModels, mergeConfig } = require('../scripts/sync-opencode-models.cjs');
const { addDiscoveredModels } = require('../scripts/desktop-model-visibility.cjs');
const catalog = [{
  id: 'DeepSeek-V4.1-Flash-1017', display_name: 'DeepSeek-V4.1-Flash-1017',
  max_tokens: 32000, prompt_max_tokens: 168000, multimodal: false,
  reasoning_effort_options: ['light', 'high', 'extra_high'],
}];

test('discovers a previously unknown model and its upstream effort levels', () => {
  const model = buildModels(catalog)['DeepSeek-V4.1-Flash-1017'];
  assert.equal(model.modelID, catalog[0].id);
  assert.equal(model.limit.context, 200000);
  assert.deepEqual(model.capabilities.input, ['text']);
  assert.deepEqual(model.variants.map(v => v.id), ['upstream', 'low', 'high', 'xhigh']);
  assert.equal(model.variants[3].body.reasoning_effort_level, 'extra_high');
});

test('preserves other providers, credentials, defaults and custom provider settings', () => {
  const config = {
    model: 'other/existing', small_model: 'other/small',
    provider: { 'trae-enterprise': { models: { obsolete: {} } }, other: { options: { apiKey: 'fixture' } } },
    providers: { 'trae-enterprise': { name: 'Trae', settings: { apiKey: '{file:trae-api-key}', timeout: 80000 }, models: {} }, other: { models: {} } },
  };
  const merged = mergeConfig(config, catalog, 'http://127.0.0.1:19900/v1');
  assert.equal(merged.model, config.model);
  assert.equal(merged.small_model, config.small_model);
  assert.deepEqual(merged.provider.other, config.provider.other);
  assert.deepEqual(merged.providers.other, config.providers.other);
  assert.equal(merged.providers['trae-enterprise'].settings.apiKey, '{file:trae-api-key}');
  assert.equal(merged.providers['trae-enterprise'].settings.timeout, 80000);
  assert.equal(merged.provider['trae-enterprise'], undefined);
  assert.ok(config.provider['trae-enterprise']); // Input remains unmodified.
});

test('rejects an empty, malformed or duplicate catalog before updating clients', () => {
  for (const value of [[], undefined, [{}], [...catalog, ...catalog], [{ ...catalog[0], max_tokens: -1 }]]) {
    assert.throws(() => buildModels(value));
  }
});

test('repeated sync is stable and removes models hidden by the enterprise catalog', () => {
  const models = buildModels(catalog, { retired: {} });
  assert.deepEqual(Object.keys(models), [catalog[0].id]);
  assert.deepEqual(buildModels(catalog, models), models);
});

test('Both DeepSeek V4.1 versions use complete upstream responses while other models retain streaming', () => {
  const { prepare } = require('../src/enterprise-server');
  const models = [...catalog, { ...catalog[0], id: 'DeepSeek-V4.1-Flash' }, { ...catalog[0], id: 'glm-5.3-flash' }].map(m => ({ ...m, upstream_model: m.id + '__dev' }));
  const body = { model: catalog[0].id, stream: true, messages: [{ role: 'user', content: 'fixture' }] };
  assert.equal(prepare(body, 'openai', { models }).request.stream, false);
  assert.equal(prepare({ ...body, model: 'DeepSeek-V4.1-Flash' }, 'openai', { models }).request.stream, false);
  assert.equal(prepare({ ...body, model: 'glm-5.3-flash' }, 'openai', { models }).request.stream, true);
});

test('new desktop models become visible without changing existing choices or recent models', () => {
  const previous = {
    user: [{ providerID: 'trae-enterprise', modelID: 'existing', visibility: 'hide' }],
    recent: [{ providerID: 'other', modelID: 'chosen' }],
    variant: { 'other/chosen': 'high' },
  };
  const { next, added } = addDiscoveredModels(previous, ['existing', 'DeepSeek-V4.1-Flash-1017']);
  assert.deepEqual(added, ['DeepSeek-V4.1-Flash-1017']);
  assert.equal(next.user[0].visibility, 'hide');
  assert.equal(next.user[1].visibility, 'show');
  assert.deepEqual(next.recent, previous.recent);
  assert.deepEqual(next.variant, previous.variant);
  assert.deepEqual(addDiscoveredModels(next, ['existing', 'DeepSeek-V4.1-Flash-1017']).added, []);
  assert.equal(previous.user.length, 1);
});
