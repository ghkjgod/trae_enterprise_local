const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const { DatabaseSync, backup } = require('node:sqlite');

function addDiscoveredModels(preferences, ids) {
  if (!Array.isArray(preferences.user)) throw new Error('Unrecognized desktop model preferences.');
  const next = structuredClone(preferences);
  const known = new Set(next.user.filter(x => x.providerID === 'trae-enterprise').map(x => x.modelID));
  const added = [];
  for (const id of ids) {
    if (typeof id !== 'string' || !id || known.has(id)) continue;
    next.user.push({ providerID: 'trae-enterprise', modelID: id, visibility: 'show' });
    known.add(id);
    added.push(id);
  }
  return { next, added };
}

function desktopClosed() {
  const r = cp.spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/tasklist.exe'),
    ['/FI', 'IMAGENAME eq OpenCode.exe', '/FO', 'CSV', '/NH'],
    { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  return r.status === 0 && !/^"OpenCode\.exe"/im.test(r.stdout);
}

async function syncDesktopVisibility(ids) {
  const file = path.join(os.homedir(), 'AppData/Roaming/ai.opencode.desktop/drafts.sqlite');
  if (!fs.existsSync(file)) return { status: 'desktop_not_installed' };
  let db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare('SELECT value FROM state WHERE name = ? AND key = ?').get('opencode.global.dat', 'model');
    if (!row) return { status: 'desktop_not_initialized' };
    const { next, added } = addDiscoveredModels(JSON.parse(row.value), ids);
    if (!added.length) return { status: 'unchanged' };
    // The renderer holds these preferences in memory. Updating the database
    // while it runs could be overwritten by its next save; retry after exit.
    if (!desktopClosed()) return { status: 'waiting_for_desktop_exit', pendingModels: added };
    const target = path.resolve(__dirname, '../data/model-sync-backups', new Date().toISOString().replace(/[:.]/g, '-'));
    fs.mkdirSync(target, { recursive: true });
    await backup(db, path.join(target, 'desktop-preferences.sqlite'));
    db.close();
    db = new DatabaseSync(file);
    db.exec('PRAGMA busy_timeout = 3000; BEGIN IMMEDIATE');
    try {
      if (!desktopClosed()) {
        db.exec('ROLLBACK');
        return { status: 'waiting_for_desktop_exit', pendingModels: added };
      }
      const result = db.prepare('UPDATE state SET value = ?, updated_at = ? WHERE name = ? AND key = ? AND value = ?')
        .run(JSON.stringify(next), Date.now(), 'opencode.global.dat', 'model', row.value);
      if (result.changes !== 1) throw new Error('Desktop preferences changed; retrying next check.');
      db.exec('COMMIT');
      return { status: 'updated', added, backup: target };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally { db.close(); }
}

module.exports = { addDiscoveredModels, syncDesktopVisibility };
