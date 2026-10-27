#!/usr/bin/env bash
set -euo pipefail

# Pi-Apex Personal Host Installer (`scripts/install-personal.sh`)
# Installs `~/.local/bin/pi-apex` (or `--prefix <dir>`), optional `systemd --user`
# Mission-Control Cockpit unit, and optional VS Code / Cursor extension links (`--install-vscode`).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PREFIX="${HOME}/.local"
INSTALL_SYSTEMD=0
INSTALL_VSCODE=0
VSCODE_EXT_ROOT=""
COCKPIT_PORT=4310

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix)
      PREFIX="$2"
      shift 2
      ;;
    --prefix=*)
      PREFIX="${1#*=}"
      shift
      ;;
    --port)
      COCKPIT_PORT="$2"
      shift 2
      ;;
    --install-systemd-user)
      INSTALL_SYSTEMD=1
      shift
      ;;
    --install-vscode)
      INSTALL_VSCODE=1
      shift
      ;;
    --vscode-ext-dir)
      VSCODE_EXT_ROOT="$2"
      INSTALL_VSCODE=1
      shift 2
      ;;
    -h|--help)
      echo "Usage: $0 [--prefix ~/.local] [--port 4310] [--install-systemd-user] [--install-vscode] [--vscode-ext-dir <dir>]"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

# Prefer Node >= 22.19 from PATH or /tmp/node22/bin
if [[ -x "/tmp/node22/bin/node" ]]; then
  export PATH="/tmp/node22/bin:${PATH}"
fi

NODE_BIN="$(command -v node || true)"
if [[ -z "${NODE_BIN}" ]]; then
  echo "[install-personal] ERROR: Node.js (>= 22.19.0) not found on PATH." >&2
  exit 1
fi
NODE_DIR="$(dirname "${NODE_BIN}")"

echo "[install-personal] Building native Linux openat2 syscall broker..."
npm --prefix "${REPO_ROOT}" run build:native >/dev/null

chmod 0444 "${REPO_ROOT}/surfaces-immutable/GUARDRAILS.yaml" || true
chmod 0755 "${REPO_ROOT}/bin/pi-apex"

BIN_DIR="${PREFIX}/bin"
mkdir -p "${BIN_DIR}"

WRAPPER_PATH="${BIN_DIR}/pi-apex"
cat > "${WRAPPER_PATH}" <<EOF
#!/usr/bin/env bash
export PATH="${NODE_DIR}:\${PATH}"
exec "${NODE_BIN}" "${REPO_ROOT}/bin/pi-apex" "\$@"
EOF
chmod 0755 "${WRAPPER_PATH}"
echo "[install-personal] Installed CLI binary wrapper -> ${WRAPPER_PATH}"

if [[ "${INSTALL_SYSTEMD}" -eq 1 ]]; then
  SYSTEMD_USER_DIR="${PREFIX}/share/systemd/user"
  mkdir -p "${SYSTEMD_USER_DIR}"
  UNIT_PATH="${SYSTEMD_USER_DIR}/pi-apex-cockpit.service"
  cat > "${UNIT_PATH}" <<EOF
[Unit]
Description=Pi-Apex Mission-Control Operator Cockpit (Rings 0-8)
After=network.target

[Service]
Type=simple
WorkingDirectory=${REPO_ROOT}
Environment=PATH=${NODE_DIR}:/usr/local/bin:/usr/bin:/bin
ExecStart=${WRAPPER_PATH} --web --host 127.0.0.1 --port ${COCKPIT_PORT}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
  echo "[install-personal] Generated systemd user service -> ${UNIT_PATH}"
fi

if [[ "${INSTALL_VSCODE}" -eq 1 ]]; then
  EXT_SRC="${REPO_ROOT}/extensions/vscode-pi-apex"
  EXT_VER=$("${NODE_BIN}" -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version)' "${EXT_SRC}/package.json")
  if [[ -n "${VSCODE_EXT_ROOT}" ]]; then
    mkdir -p "${VSCODE_EXT_ROOT}"
    ln -sfn "${EXT_SRC}" "${VSCODE_EXT_ROOT}/pi-apex-personal.vscode-pi-apex-${EXT_VER}"
    echo "[install-personal] Linked VS Code / Cursor extension -> ${VSCODE_EXT_ROOT}/pi-apex-personal.vscode-pi-apex-${EXT_VER}"
  else
    for ide_dir in "${HOME}/.vscode/extensions" "${HOME}/.cursor/extensions"; do
      mkdir -p "${ide_dir}"
      ln -sfn "${EXT_SRC}" "${ide_dir}/pi-apex-personal.vscode-pi-apex-${EXT_VER}"
      echo "[install-personal] Linked VS Code / Cursor extension -> ${ide_dir}/pi-apex-personal.vscode-pi-apex-${EXT_VER}"
    done
  fi
fi

echo "[install-personal] Verifying installed pi-apex binary..."
"${WRAPPER_PATH}" --version
