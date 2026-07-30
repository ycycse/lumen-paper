#!/usr/bin/env bash
set -euo pipefail

VERSION="__VERSION__"
ARCHIVE_SHA256="__BRIDGE_TARBALL_SHA256__"
REPOSITORY="ycycse/lumen-paper"
ARCHIVE_NAME="lumen-paper-codex-bridge-v${VERSION}.tar.gz"
ARCHIVE_URL="https://github.com/${REPOSITORY}/releases/download/v${VERSION}/${ARCHIVE_NAME}"
NO_START=0

usage() {
  cat <<EOF
Install Lumen Paper Codex Bridge v${VERSION} into your user account.

Usage:
  install-lumen-paper-bridge.sh [--no-start]

The installer never uses sudo. It verifies the versioned Release archive,
keeps the pairing token in a stable state directory, and starts one Bridge
process in the background unless --no-start is supplied.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-start) NO_START=1 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if [ -z "${HOME:-}" ]; then
  printf 'HOME is required for a user-only installation.\n' >&2
  exit 1
fi

if [ -n "${SUDO_USER:-}" ]; then
  printf 'Do not run this installer with sudo. It installs safely into your user account.\n' >&2
  exit 1
fi

export PATH="/opt/homebrew/bin:/usr/local/bin:${HOME}/.local/bin:${PATH:-/usr/bin:/bin}"

for TOOL in tar install; do
  if ! command -v "$TOOL" >/dev/null 2>&1; then
    printf '%s is required but was not found.\n' "$TOOL" >&2
    exit 1
  fi
done

CURL_BIN="${LUMEN_BRIDGE_CURL_BIN:-$(command -v curl || true)}"
NODE_BIN="${LUMEN_NODE_BIN:-$(command -v node || true)}"
CODEX_BIN="${LUMEN_CODEX_BIN:-$(command -v codex || true)}"
if [ -z "$CURL_BIN" ]; then
  printf 'curl is required but was not found.\n' >&2
  exit 1
fi
if [ -z "$NODE_BIN" ]; then
  printf 'Node.js 22+ was not found. Install Node, then run this command again.\n' >&2
  exit 1
fi
NODE_MAJOR="$($NODE_BIN -p 'Number(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  printf 'Node.js 22+ is required; found %s.\n' "$($NODE_BIN --version)" >&2
  exit 1
fi
if [ -z "$CODEX_BIN" ]; then
  printf 'Codex CLI was not found. Install Codex, run `codex login`, then retry.\n' >&2
  exit 1
fi
if ! "$CODEX_BIN" login status >/dev/null 2>&1; then
  printf 'Codex is not signed in. Run `codex login`, then retry.\n' >&2
  exit 1
fi

DATA_HOME="${XDG_DATA_HOME:-${HOME}/.local/share}"
INSTALL_ROOT="${LUMEN_BRIDGE_INSTALL_ROOT:-${DATA_HOME}/lumen-paper/bridge}"
VERSION_DIR="${INSTALL_ROOT}/versions/${VERSION}"
CURRENT_LINK="${INSTALL_ROOT}/current"
BIN_DIR="${LUMEN_BRIDGE_BIN_DIR:-${HOME}/.local/bin}"
COMMAND_LINK="${BIN_DIR}/lumen-paper-bridge"
APPLICATIONS_DIR="${LUMEN_BRIDGE_APPLICATIONS_DIR:-${HOME}/Applications}"
APPLICATION_LINK="${APPLICATIONS_DIR}/Start Lumen Paper Bridge.command"

umask 077
TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/lumen-paper-bridge.XXXXXX")"
cleanup() {
  rm -rf "$TEMP_ROOT"
}
trap cleanup EXIT

printf 'Downloading Lumen Paper Codex Bridge v%s…\n' "$VERSION"
"$CURL_BIN" --proto '=https' --tlsv1.2 -fL "$ARCHIVE_URL" -o "$TEMP_ROOT/$ARCHIVE_NAME"

if command -v shasum >/dev/null 2>&1; then
  ACTUAL_SHA256="$(shasum -a 256 "$TEMP_ROOT/$ARCHIVE_NAME" | awk '{print $1}')"
elif command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_SHA256="$(sha256sum "$TEMP_ROOT/$ARCHIVE_NAME" | awk '{print $1}')"
else
  printf 'A SHA-256 tool (shasum or sha256sum) is required.\n' >&2
  exit 1
fi

if [ "$ACTUAL_SHA256" != "$ARCHIVE_SHA256" ]; then
  printf 'Checksum mismatch. Expected %s, got %s. Nothing was installed.\n' "$ARCHIVE_SHA256" "$ACTUAL_SHA256" >&2
  exit 1
fi

tar -xzf "$TEMP_ROOT/$ARCHIVE_NAME" -C "$TEMP_ROOT"
SOURCE_DIR="$TEMP_ROOT/lumen-paper-codex-bridge-v${VERSION}"
for FILE in server.mjs version.mjs lumen-paper-bridge "Start Lumen Paper Bridge.command" README.md LICENSE PRIVACY.md SECURITY.md; do
  if [ ! -f "$SOURCE_DIR/$FILE" ]; then
    printf 'Release archive is incomplete: missing %s.\n' "$FILE" >&2
    exit 1
  fi
done

mkdir -p "$VERSION_DIR" "$BIN_DIR"
chmod 700 "$INSTALL_ROOT" "$INSTALL_ROOT/versions" "$VERSION_DIR" 2>/dev/null || true
install -m 600 "$SOURCE_DIR/server.mjs" "$VERSION_DIR/server.mjs"
install -m 600 "$SOURCE_DIR/version.mjs" "$VERSION_DIR/version.mjs"
install -m 700 "$SOURCE_DIR/lumen-paper-bridge" "$VERSION_DIR/lumen-paper-bridge"
install -m 700 "$SOURCE_DIR/Start Lumen Paper Bridge.command" "$VERSION_DIR/Start Lumen Paper Bridge.command"
install -m 600 "$SOURCE_DIR/README.md" "$VERSION_DIR/README.md"
install -m 600 "$SOURCE_DIR/LICENSE" "$VERSION_DIR/LICENSE"
install -m 600 "$SOURCE_DIR/PRIVACY.md" "$VERSION_DIR/PRIVACY.md"
install -m 600 "$SOURCE_DIR/SECURITY.md" "$VERSION_DIR/SECURITY.md"

if [ -e "$CURRENT_LINK" ] && [ ! -L "$CURRENT_LINK" ]; then
  printf 'Refusing to replace non-symlink path: %s\n' "$CURRENT_LINK" >&2
  exit 1
fi
ln -sfn "$VERSION_DIR" "$CURRENT_LINK"

if [ -e "$COMMAND_LINK" ] && [ ! -L "$COMMAND_LINK" ]; then
  printf 'Refusing to replace non-symlink command: %s\n' "$COMMAND_LINK" >&2
  exit 1
fi
ln -sfn "$CURRENT_LINK/lumen-paper-bridge" "$COMMAND_LINK"

mkdir -p "$APPLICATIONS_DIR"
if [ ! -e "$APPLICATION_LINK" ] || [ -L "$APPLICATION_LINK" ]; then
  ln -sfn "$CURRENT_LINK/Start Lumen Paper Bridge.command" "$APPLICATION_LINK"
else
  printf 'Kept existing Finder launcher: %s\n' "$APPLICATION_LINK"
fi

printf '\nInstalled without sudo:\n  %s\n' "$VERSION_DIR"
printf 'Command:\n  %s\n' "$COMMAND_LINK"
printf 'Finder launcher:\n  %s\n' "$APPLICATION_LINK"
printf '\n'

if [ "$NO_START" -eq 1 ]; then
  printf 'The Bridge was not started. Start it later with:\n  %s start\n' "$COMMAND_LINK"
  exit 0
fi

printf 'Starting or upgrading the background Bridge…\n'
"$COMMAND_LINK" restart
printf '\nInstallation complete. This terminal can be closed.\n'
printf 'Reader, Agent and Full Agent permissions are selected in Lumen settings.\n'
