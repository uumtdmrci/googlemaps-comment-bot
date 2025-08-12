// trigger.js (ESM)
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const nodeExe = process.execPath;
const botPath = path.join(__dirname, 'bot.js');

console.log('[TRIGGER] start -> node', botPath);

const child = spawn(nodeExe, [botPath], {
  cwd: __dirname,
  stdio: 'inherit',
  shell: false
});

child.on('exit', (code) => {
  console.log('[TRIGGER] exit code =', code);
  process.exit(code ?? 0);
});