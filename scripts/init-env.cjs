const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const destination = path.join(__dirname, '..', '.env');
try {
  fs.writeFileSync(destination, `API_KEY=${crypto.randomBytes(32).toString('hex')}\nPORT=19900\nDEFAULT_MODEL=qwen3.8-max\n`, { flag: 'wx', mode: 0o600 });
  console.log('Created .env with a random local API key. The key is not printed.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('.env already exists; left unchanged.');
}
