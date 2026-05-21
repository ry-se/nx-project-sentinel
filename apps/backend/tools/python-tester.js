const { spawnSync } = require("child_process");
const path = require("path");

const pythonPath =
  process.platform === "win32"
    ? path.join(".venv", "Scripts", "python.exe")
    : path.join(".venv", "bin", "python");

const result = spawnSync(
  pythonPath,
  ["-m", "pytest"],
  { stdio: "inherit" }
);

const exitCode = result.status;

if (exitCode === 5) {
  process.exit(0);
}

process.exit(exitCode);