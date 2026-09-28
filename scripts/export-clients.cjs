const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(root, '.env'), quiet: true });
const labels = { light: '轻', high: '高', extra_high: '极高' };
const variantIds = { light: 'low', high: 'high', extra_high: 'xhigh' };
(async () => {
  if (!process.env.API_KEY || process.env.API_KEY.length < 32) throw new Error('Run npm run setup first.');
  const port = Number(process.env.PORT || 19900);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
  const base = `http://127.0.0.1:${port}`;
  const response = await fetch(base + '/v1/models', { headers: { Authorization: 'Bearer ' + process.env.API_KEY }, signal: AbortSignal.timeout(25000) });
  if (!response.ok) throw new Error(`Local catalog request failed: HTTP ${response.status}`);
  const { data: models } = await response.json();
  const options = [], routes = {}, ocModels = {};
  for (const model of models) {
    const entries = [{ desktop_alias: model.desktop_alias, label: '默认' }, ...(model.effort_variants || []).map(v => ({ ...v, label: labels[v.level] }))];
    for (const entry of entries) {
      const label = `Trae / ${model.display_name} / ${entry.label}`;
      options.push({ model: entry.desktop_alias, label, description: 'Trae 企业模型与思考强度' });
      routes[entry.desktop_alias] = { model: entry.desktop_alias, labelOverride: label, supports1m: false };
    }
    ocModels[model.id] = {
      name: model.display_name, modelID: model.id,
      capabilities: { tools: true, input: model.multimodal ? ['text', 'image'] : ['text'], output: ['text'] },
      limit: { context: model.prompt_max_tokens + model.max_tokens, input: model.prompt_max_tokens, output: model.max_tokens },
      compatibility: { reasoningField: 'reasoning_content' },
      variants: [{ id: 'upstream' }, ...(model.reasoning_effort_options || []).map(level => ({ id: variantIds[level], body: { reasoning_effort_level: level } }))]
    };
  }
  const destination = path.join(root, 'generated');
  fs.mkdirSync(destination, { recursive: true });
  const save = (file, value) => fs.writeFileSync(path.join(destination, file), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  const defaultModel = models.find(m => m.id === (process.env.DEFAULT_MODEL || 'qwen3.8-max')) || models[0];
  if (!defaultModel) throw new Error('No enabled models.');
  save('claude-settings.local.json', { env: { ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: process.env.API_KEY }, model: defaultModel.desktop_alias, modelPicker: { options, replaceBuiltInOptions: true } });
  save('cc-switch-desktop.local.json', { name: 'Trae Enterprise / All Models', settings_config: { env: { ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: process.env.API_KEY } }, meta: { claudeDesktopMode: 'direct', claudeDesktopModelRoutes: routes } });
  save('opencode.local.json', { providers: { 'trae-enterprise': { name: 'Trae CN Enterprise (Local)', package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: base + '/v1', apiKey: process.env.API_KEY }, models: ocModels } }, model: 'trae-enterprise/' + defaultModel.id });
  console.log(`Exported ${models.length} models and ${options.length} Claude menu entries into generated/.`);
  console.log('These files contain your local API key. Keep them private; merge only the needed settings into your clients.');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
