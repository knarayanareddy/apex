#!/usr/bin/env bash
set -euo pipefail

# Packages a clean, deterministic, self-contained personal release tarball:
#   /home/user/pi-apex-v3.6.0-personal.tar.gz
#   /home/user/pi-apex-v3.6.0-personal.tar.gz.sha256

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
OUT_DIR="${1:-/home/user}"

for item in package.json package-lock.json tsconfig.json SPEC_BIBLE.md ARCHITECTURE.md PERSONAL_QUICKSTART.md \
  bin/pi-apex scripts/bootstrap-host.sh scripts/install-personal.sh scripts/package-release.sh scripts/build-native.mjs src/native/pty_pid1_supervisor.c surfaces-immutable/GUARDRAILS.yaml; do
  if [[ ! -f "${REPO_ROOT}/${item}" ]]; then
    echo "[package-release] PACKAGE_INPUT_MISSING: ${item}" >&2
    exit 1
  fi
done
for item in bin extensions scripts src surfaces surfaces-immutable test; do
  if [[ ! -d "${REPO_ROOT}/${item}" ]]; then
    echo "[package-release] PACKAGE_INPUT_MISSING: ${item}" >&2
    exit 1
  fi
done

VERSION="$(grep -oE '"version":[[:space:]]*"[^"]+"' "${REPO_ROOT}/package.json" | head -n1 | sed -E 's/.*"([^"]+)"/\1/')"
ARCHIVE_NAME="pi-apex-v${VERSION}-personal.tar.gz"
ARCHIVE_PATH="${OUT_DIR}/${ARCHIVE_NAME}"
SHA_PATH="${ARCHIVE_PATH}.sha256"

if [[ -e "${ARCHIVE_PATH}" || -e "${SHA_PATH}" ]]; then
  echo "[package-release] Refusing to overwrite existing release output" >&2
  exit 1
fi

STAGE_TMP="$(mktemp -d)"
trap 'rm -rf "${STAGE_TMP}"' EXIT

STAGE_PKG="${STAGE_TMP}/pi-apex-harness"
mkdir -p "${STAGE_PKG}"

for item in \
  package.json \
  package-lock.json \
  tsconfig.json \
  SPEC_BIBLE.md \
  ARCHITECTURE.md \
  PERSONAL_QUICKSTART.md \
  bin \
  extensions \
  scripts \
  src \
  surfaces \
  surfaces-immutable \
  test
do
  cp -a "${REPO_ROOT}/${item}" "${STAGE_PKG}/"
done

# Strip compiled native .node binary from portable source archive (rebuilt cleanly by install-personal.sh / npm test)
rm -f "${STAGE_PKG}/src/native/linux_fs_bridge.node"
rm -f "${STAGE_PKG}/src/native/apex_pty_pid1"
rm -rf "${STAGE_PKG}/surfaces/skills"
chmod 0444 "${STAGE_PKG}/surfaces-immutable/GUARDRAILS.yaml"
chmod 0755 "${STAGE_PKG}/bin/pi-apex" "${STAGE_PKG}/scripts/bootstrap-host.sh" "${STAGE_PKG}/scripts/install-personal.sh" "${STAGE_PKG}/scripts/package-release.sh"

mkdir -p "${OUT_DIR}"
# These are path exclusions, not a content-based secret scan. Never include
# workspace state, private key files, sessions, or host-specific native addons.
EXCLUDES=(
  '--exclude=*/.harness' '--exclude=*/node_modules' '--exclude=*/.venv'
  '--exclude=*/.env' '--exclude=*/.env.*' '--exclude=*/.npmrc' '--exclude=*/.netrc'
  '--exclude=*/.pypirc' '--exclude=*/.pgpass' '--exclude=*/id_rsa' '--exclude=*/id_ed25519'
  '--exclude=*/id_ecdsa' '--exclude=*/id_dsa' '--exclude=*.pem' '--exclude=*.key'
  '--exclude=*.p12' '--exclude=*.pfx' '--exclude=*.jsonl' '--exclude=*.node'
)
if tar --help 2>&1 | grep -q -- "--sort="; then
  tar --sort=name --mtime='UTC 2026-10-26' --owner=0 --group=0 --numeric-owner \
    "${EXCLUDES[@]}" -czf "${ARCHIVE_PATH}" -C "${STAGE_TMP}" pi-apex-harness
else
  tar "${EXCLUDES[@]}" -czf "${ARCHIVE_PATH}" -C "${STAGE_TMP}" pi-apex-harness
fi

if command -v sha256sum >/dev/null 2>&1; then
  (cd "${OUT_DIR}" && sha256sum "${ARCHIVE_NAME}" > "${SHA_PATH}")
else
  (cd "${OUT_DIR}" && shasum -a 256 "${ARCHIVE_NAME}" > "${SHA_PATH}")
fi

echo "[package-release] Created ${ARCHIVE_PATH} ($(du -h "${ARCHIVE_PATH}" | cut -f1))"
echo "[package-release] SHA-256: $(cat "${SHA_PATH}")"
