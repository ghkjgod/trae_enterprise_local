// Synchronize the authenticated enterprise catalog into the two local clients.
// No inference requests, account tokens, or API keys are written to the status log.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const cp = require('node:child_process');
const { DatabaseSync, backup } = require('node:sqlite');
const { syncDesktopVisibility } = require('./desktop-model-visibility.cjs');

const ROOT = path.resolve(__dirname, '..');
const PROVIDER = 'trae-enterprise';
const INTERVAL = 5 * 60 * 1000;
const LEVELS = { light: 'low', high: 'high', extra_high: 'xhigh' };

function buildModels(catalog, previous = {}) {
  if (!Array.isArray(catalog) || !catalog.length) throw new Error('Empty catalog; keeping existing client models.');
  const models = {};
  for (const model of catalog) {
    if (!model.id || !model.display_name || Object.hasOwn(models, model.id) ||
        !Number.isInteger(model.prompt_max_tokens) || model.prompt_max_tokens <= 0 ||
        !Number.isInteger(model.max_tokens) || model.max_tokens <= 0) {
      throw new Error('Invalid catalog; keeping existing client models.');
    }
    const old = previous[model.id] || {};
    models[model.id] = {
      ...old,
      name: model.display_name,
      modelID: model.id,
      capabilities: { ...old.capabilities, tools: true, input: model.multimodal ? ['text', 'image'] : ['text'], output: ['text'] },
      limit: { ...old.limit, context: model.prompt_max_tokens + model.max_tokens, input: model.prompt_max_tokens, output: model.max_tokens },
      compatibility: { ...old.compatibility, reasoningField: 'reasoning_content' },
      variants: [
        { id: 'upstream' },
        ...(model.reasoning_effort_options || []).filter(level => LEVELS[level])
          .map(level => ({ id: LEVELS[level], body: { reasoning_effort_level: level } })),
      ],
    };
  }
  return models;
}

function mergeConfig(config, catalog, baseURL) {
  const next = structuredClone(config);
  const old = next.providers?.[PROVIDER];
  if (!old) throw new Error('Missing native OpenCode Trae provider; leaving configuration unchanged.');
  next.providers[PROVIDER] = {
    ...old,
    settings: { ...old.settings, baseURL },
    models: buildModels(catalog, old.models),
  };
  // OpenCode 2.x gives the native entry precedence. Remove its stale duplicate.
  if (next.provider) delete next.provider[PROVIDER];
  return next;
}

function saveJson(file, value) {
  const temporary = file + '.' + process.pid + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function findCLI() {
  const folder = path.join(os.homedir(), 'AppData/Roaming/ai.opencode.desktop/cli');
  if (!fs.existsSync(folder)) return null;
  for (const version of fs.readdirSync(folder).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
    const executable = path.join(folder, version, 'opencode-cli.exe');
    if (fs.existsSync(executable)) return executable;
  }
  return null;
}

function portOpen(url) {
  return new Promise(resolve => {
    const socket = net.connect({ host: url.hostname, port: Number(url.port) });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(1500);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function reloadOpenCode() {
  const executable = findCLI();
  if (!executable) return 'waiting_for_client';
  const options = { cwd: os.homedir(), encoding: 'utf8', windowsHide: true, timeout: 20000 };
  const status = cp.spawnSync(executable, ['service', 'status'], options);
  const address = status.stdout?.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  if (status.status !== 0 || !address || !(await portOpen(new URL(address)))) return 'waiting_for_client';
  const result = cp.spawnSync(executable, ['reload'], options);
  if (result.status !== 0) throw new Error('OpenCode reload failed; automatic retry is pending.');
  return 'reloaded';
}

async function synchronize({ force = false } = {}) {
  require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });
  // Export/import the provider once before enabling automatic maintenance.
  // Do not create an empty CC Switch database when the client is absent.
  const file = path.join(os.homedir(), '.config/opencode/opencode.json');
  const database = path.join(os.homedir(), '.cc-switch/cc-switch.db');
  if (!fs.existsSync(file) || !fs.existsSync(database)) return { status: 'not_configured' };
  const stateFile = path.join(ROOT, 'data/model-sync-state.json');
  const state = readJson(stateFile, {});
  const now = Date.now();
  if (!force && now - (state.lastAttempt || 0) < INTERVAL) {
    if (state.models?.length) {
      const desktop = await syncDesktopVisibility(state.models);
      state.desktopVisibility = desktop;
      saveJson(stateFile, state);
      if (desktop.status === 'updated') return { status: 'ok', desktopVisibility: desktop };
    }
    return { status: 'not_due' };
  }
  state.lastAttempt = now;
  let db;
  try {
    const port = Number(process.env.PORT || 19900);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !process.env.API_KEY) throw new Error('Invalid local proxy configuration.');
    const baseURL = `http://127.0.0.1:${port}/v1`;
    const response = await fetch(baseURL + '/models?refresh=true', {
      headers: { Authorization: 'Bearer ' + process.env.API_KEY },
      signal: AbortSignal.timeout(25000),
    });
    if (!response.ok) throw new Error(`Catalog HTTP ${response.status}; keeping existing client models.`);
    const catalog = (await response.json()).data;
    buildModels(catalog); // Validate all entries before opening either writable target.
    const original = fs.readFileSync(file, 'utf8');
    const config = JSON.parse(original.replace(/^\uFEFF/, ''));
    const merged = mergeConfig(config, catalog, baseURL);
    const changed = JSON.stringify(config) !== JSON.stringify(merged);
    db = new DatabaseSync(database);
    db.exec('PRAGMA busy_timeout = 5000');
    const row = db.prepare('SELECT settings_config, meta FROM providers WHERE app_type = ? AND id = ?').get('opencode', PROVIDER);
    if (!row) throw new Error('CC Switch Trae provider is missing; keeping existing client configuration.');
    const settings = JSON.parse(row.settings_config);
    const nextSettings = {
      ...settings,
      name: merged.providers[PROVIDER].name,
      package: merged.providers[PROVIDER].package,
      settings: { ...settings.settings, ...merged.providers[PROVIDER].settings },
      models: buildModels(catalog, settings.models),
    };
    const nextMeta = { ...JSON.parse(row.meta || '{}'), opencodeConfigFormat: 'v2' };
    const databaseChanged = JSON.stringify(settings) !== JSON.stringify(nextSettings) || JSON.stringify(JSON.parse(row.meta || '{}')) !== JSON.stringify(nextMeta);
    if (changed || databaseChanged) {
      const destination = path.join(ROOT, 'data/model-sync-backups', new Date(now).toISOString().replace(/[:.]/g, '-'));
      fs.mkdirSync(destination, { recursive: true });
      fs.writeFileSync(path.join(destination, 'opencode.json'), original, { mode: 0o600 });
      await backup(db, path.join(destination, 'cc-switch.db'));
      state.reloadPending = true;
      state.backup = destination;
      saveJson(stateFile, state);
      db.exec('BEGIN IMMEDIATE');
      try {
        if (fs.readFileSync(file, 'utf8') !== original) throw new Error('OpenCode configuration changed during synchronization; retrying later.');
        const current = db.prepare('SELECT settings_config, meta FROM providers WHERE app_type = ? AND id = ?').get('opencode', PROVIDER);
        if (current?.settings_config !== row.settings_config || current?.meta !== row.meta) throw new Error('CC Switch provider changed during synchronization; retrying later.');
        if (databaseChanged) db.prepare('UPDATE providers SET settings_config = ?, meta = ? WHERE app_type = ? AND id = ?')
          .run(JSON.stringify(nextSettings), JSON.stringify(nextMeta), 'opencode', PROVIDER);
        if (changed) saveJson(file, merged);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      state.updatedAt = now;
    }
    state.reload = state.reloadPending ? await reloadOpenCode() : 'unchanged';
    if (state.reload === 'reloaded') state.reloadPending = false;
    state.lastSuccess = now;
    state.modelCount = catalog.length;
    state.models = catalog.map(model => model.id);
    state.desktopVisibility = await syncDesktopVisibility(state.models);
    state.status = 'ok';
    delete state.error;
    saveJson(stateFile, state);
    return { status: 'ok', changed: changed || databaseChanged, modelCount: catalog.length, reload: state.reload, desktopVisibility: state.desktopVisibility };
  } catch (error) {
    state.status = 'error';
    state.error = error.message;
    saveJson(stateFile, state);
    throw error;
  } finally {
    db?.close();
  }
}

if (require.main === module) {
  synchronize({ force: process.argv.includes('--force') })
    .then(result => { if (result.status !== 'not_due') console.log(JSON.stringify(result)); })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { buildModels, mergeConfig, synchronize };
