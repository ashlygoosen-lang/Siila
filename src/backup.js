const fs = require('fs');
const path = require('path');
const db = require('./db');

async function backup() {
  const file = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'siira.db');
  if (file === ':memory:') return null;
  const dir = path.join(path.dirname(file), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const name = `siira-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16)}.db`;
  await db.backup(path.join(dir, name));
  fs.readdirSync(dir).filter(f => f.endsWith('.db')).sort().slice(0, -14).forEach(f => fs.unlinkSync(path.join(dir, f))); // keep 14
  return name;
}
module.exports = { backup };
if (require.main === module) backup().then(n => console.log('Backup written:', n));
