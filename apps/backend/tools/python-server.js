const { spawnSync } = require('child_process');
const path = require('path');

const pythonPath =
  process.platform === 'win32'
    ? path.join('.venv', 'Scripts', 'python.exe')
    : path.join('.venv', 'bin', 'python');

const result = spawnSync(
  pythonPath,
  ['-m', 'uvicorn', 'app.main:app', '--reload', '--port', '8000'],
  { stdio: 'inherit' }
);

process.exit(result.status ?? 1);
