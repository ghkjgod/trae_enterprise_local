const fs = require('fs');
const { execFileSync } = require('child_process');
const path = require('path');
const root = path.join(__dirname, '..');
const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
if (!files.length) throw new Error('No tracked/staged files. Stage the intended public files first.');
const deniedPaths = /(^|\/)(node_modules|runtime|data|generated|logs|service-logs|backups|\.ssh)(\/|$)|backup-|\.local\.|\.(db|sqlite|vscdb|pem|pfx|key|log|pid)(-|$)|(^|\/)(storage\.json|\.env(?:\..*)?)$/i;
const patterns = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ['api-secret', /\bsk-[A-Za-z0-9_-]{24,}\b/],
  ['credential-url', /https?:\/\/[^\s/@:]+:[^\s/@]+@/],
  ['personal-windows-path', /[A-Z]:[\\/]+Users[\\/]+(?!Public[\\/]|<)[A-Za-z0-9_.-]+[\\/]/i]
];
let failures = 0;
for (const file of files) {
  if (file !== '.env.example' && deniedPaths.test(file)) { console.error(`Private/runtime path: ${file}`); failures++; }
  const absolute = path.join(root, file);
  if (fs.lstatSync(absolute).isSymbolicLink()) { console.error(`Review symlink before publishing: ${file}`); failures++; continue; }
  const buffer = fs.readFileSync(absolute);
  if (buffer.includes(0)) { console.error(`Unexpected binary file: ${file}`); failures++; continue; }
  const text = buffer.toString('utf8');
  for (const [name, pattern] of patterns) if (pattern.test(text)) { console.error(`${name}: ${file}`); failures++; }
}
console.log(`Reviewed ${files.length} tracked/staged text files; findings=${failures}. Matched values are never printed.`);
process.exitCode = failures ? 1 : 0;
