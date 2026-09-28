const path = require('path');
const os = require('os');
const LEVELS = new Set(['light', 'high', 'extra_high']);

// Read only model capability metadata from the installed enterprise client.
// cli/get_config_list omits this metadata. Do not persist the source rows:
// their other fields can contain credentials for custom providers.
function readReasoningCapabilities(dataDir = path.join(os.homedir(), 'AppData/Roaming/Trae CN')) {
  let db;
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(path.join(dataDir, 'User/globalStorage/state.vscdb'), { readOnly: true });
    const rows = db.prepare("SELECT value FROM ItemTable WHERE key LIKE '%AI.agent.model.model_list_map'").all();
    const out = {};
    for (const row of rows) {
      const data = JSON.parse(row.value);
      for (const model of data.solo_agent || data.builder_v3 || []) {
        const config = model.reasoning_effort_config;
        if (typeof model.name !== 'string' || !config) continue;
        const options = config.support_thinking === true ? (config.options || []).filter(x => LEVELS.has(x)) : [];
        out[model.name] = { options, default_level: options.includes(config.default_level) ? config.default_level : undefined };
      }
    }
    return out;
  } catch {
    // Missing/locked metadata must not invent capabilities or interrupt normal chat.
    return {};
  } finally { if (db) db.close(); }
}

function normalizeEffort(value) {
  const map = { low: 'light', light: 'light', medium: 'high', high: 'high', xhigh: 'extra_high', max: 'extra_high', extra_high: 'extra_high' };
  if (typeof value !== 'string' || !Object.hasOwn(map, value)) throw new Error('Unsupported reasoning effort; use low/light, high, or xhigh/extra_high');
  return map[value];
}

function chooseEffort(body, selected, pinnedLevel) {
  // An explicitly selected model+effort variant takes precedence over a client's
  // automatic/default output_config. This keeps Desktop's model menu authoritative.
  const value = pinnedLevel ?? body.reasoning_effort_level ?? body.output_config?.effort ?? body.reasoning_effort ?? body.reasoning?.effort;
  const options = selected.reasoning_effort_options || [];
  if (value == null) return selected.default_reasoning_effort;
  const level = normalizeEffort(value);
  if (!options.includes(level)) throw new Error(`Reasoning effort ${level} is not available for ${selected.id}; supported: ${options.join(', ') || 'model default only'}`);
  return level;
}

module.exports = { readReasoningCapabilities, normalizeEffort, chooseEffort };
