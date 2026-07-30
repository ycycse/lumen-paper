#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { BRIDGE_VERSION } from "../bridge/version.mjs";

const root = mkdtempSync(join(tmpdir(), "lumen-bridge-installer-smoke-"));
const home = join(root, "home");
const installRoot = join(root, "data", "bridge");
const binDir = join(root, "bin");
const applicationsDir = join(root, "Applications");
const archive = resolve(`artifacts/lumen-paper-codex-bridge-v${BRIDGE_VERSION}.tar.gz`);
const installer = resolve("artifacts/install-lumen-paper-bridge.sh");
const curlStub = join(root, "curl-stub");
const codexStub = join(root, "codex-stub");

if (!existsSync(archive) || !existsSync(installer)) {
  throw new Error("Run npm run package:release before the installer smoke");
}

writeFileSync(curlStub, `#!/bin/sh
set -eu
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then output="$2"; shift 2; else shift; fi
done
test -n "$output"
cp "$LUMEN_TEST_ARCHIVE" "$output"
`);
writeFileSync(codexStub, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli installer-smoke"; exit 0; fi
if [ "$1" = "login" ] && [ "$2" = "status" ]; then echo "Logged in"; exit 0; fi
exit 0
`);
chmodSync(curlStub, 0o700);
chmodSync(codexStub, 0o700);

const env = {
  ...process.env,
  HOME: home,
  LUMEN_BRIDGE_INSTALL_ROOT: installRoot,
  LUMEN_BRIDGE_BIN_DIR: binDir,
  LUMEN_BRIDGE_APPLICATIONS_DIR: applicationsDir,
  LUMEN_BRIDGE_CURL_BIN: curlStub,
  LUMEN_NODE_BIN: process.execPath,
  LUMEN_CODEX_BIN: codexStub,
  LUMEN_TEST_ARCHIVE: archive,
};

try {
  run("bash", [installer, "--no-start"], env);
  const command = join(binDir, "lumen-paper-bridge");
  const finderLauncher = join(applicationsDir, "Start Lumen Paper Bridge.command");
  if (!existsSync(command) || !existsSync(finderLauncher)) throw new Error("Installer did not create both launchers");
  if (!readlinkSync(command).includes("/current/lumen-paper-bridge")) throw new Error("Command link does not follow current");

  const firstToken = runText(command, ["token"], env).trim();
  if (firstToken.length < 32) throw new Error("Installer launcher did not create a pairing token");
  run(command, ["doctor"], env);

  run("bash", [installer, "--no-start"], env);
  const secondToken = runText(command, ["token"], env).trim();
  if (secondToken !== firstToken) throw new Error("Reinstall changed the pairing token");

  process.stdout.write(`Installer smoke passed: v${BRIDGE_VERSION}, no sudo, launchers created, token preserved\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

function run(command, args, environment) {
  const result = spawnSync(command, args, { env: environment, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result;
}

function runText(command, args, environment) {
  return run(command, args, environment).stdout;
}
