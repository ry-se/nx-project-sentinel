const path = require("path");

const python =
  process.platform === "win32"
    ? path.join(".venv", "Scripts", "python.exe")
    : path.join(".venv", "bin", "python");

const { spawnSync } = require("child_process");

const result = spawnSync(
  python,
  ["-m", "ruff", "check", "."],
  { stdio: "inherit" }
);

if (result.error) {
  console.error(result.error.message);
}

process.exit(result.status ?? 1);
