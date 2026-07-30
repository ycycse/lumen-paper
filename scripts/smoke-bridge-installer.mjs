#!/usr/bin/env node
import { createServer } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { BRIDGE_PROTOCOL_VERSION, BRIDGE_VERSION } from "../bridge/version.mjs";

const root = mkdtempSync(join(tmpdir(), "lumen-bridge-installer-smoke-"));
const home = join(root, "home");
const installRoot = join(root, "data", "bridge");
const binDir = join(root, "bin");
const applicationsDir = join(root, "Applications");
const stateDir = join(root, "state");
const clipboardPath = join(root, "clipboard");
const archive = resolve(`artifacts/lumen-paper-codex-bridge-v${BRIDGE_VERSION}.tar.gz`);
const installer = resolve("artifacts/install-lumen-paper-bridge.sh");
const curlStub = join(root, "curl-stub");
const codexStub = join(root, "codex-stub");
const pbcopyStub = join(binDir, "pbcopy");
const port = await freePort();
mkdirSync(binDir, { recursive: true });

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
writeFileSync(pbcopyStub, `#!/bin/sh
set -eu
cat > "$LUMEN_TEST_CLIPBOARD"
`);
chmodSync(pbcopyStub, 0o700);

const env = {
  ...process.env,
  HOME: home,
  PATH: `${binDir}:${process.env.PATH || "/usr/bin:/bin"}`,
  LUMEN_BRIDGE_INSTALL_ROOT: installRoot,
  LUMEN_BRIDGE_BIN_DIR: binDir,
  LUMEN_BRIDGE_APPLICATIONS_DIR: applicationsDir,
  LUMEN_BRIDGE_STATE_DIR: stateDir,
  LUMEN_BRIDGE_PORT: String(port),
  LUMEN_BRIDGE_CURL_BIN: curlStub,
  LUMEN_NODE_BIN: process.execPath,
  LUMEN_CODEX_BIN: codexStub,
  LUMEN_TEST_ARCHIVE: archive,
  LUMEN_TEST_CLIPBOARD: clipboardPath,
};

try {
  const firstInstall = run("bash", [installer], env, 15_000);
  const command = join(binDir, "lumen-paper-bridge");
  const finderLauncher = join(applicationsDir, "Start Lumen Paper Bridge.command");
  if (!existsSync(command) || !existsSync(finderLauncher)) throw new Error("Installer did not create both launchers");
  if (!readlinkSync(command).includes("/current/lumen-paper-bridge")) throw new Error("Command link does not follow current");

  const tokenPath = join(stateDir, ".token");
  const firstToken = readFileSync(tokenPath, "utf8").trim();
  if (firstToken.length < 32) throw new Error("Installer launcher did not create a pairing token");
  if ((statSync(tokenPath).mode & 0o777) !== 0o600) throw new Error("Installed pairing token permissions must be 0600");
  if (readFileSync(clipboardPath, "utf8").trim() !== firstToken) throw new Error("Installer did not copy the pairing token");
  assertTokenHidden(firstInstall, firstToken, "first install");
  if (!firstInstall.stdout.includes("Installation complete") || !firstInstall.stdout.includes("terminal can be closed")) {
    throw new Error(`Installer did not clearly return control to the shell:\n${firstInstall.stdout}`);
  }

  const health = await waitForHealth(firstToken, 8_000);
  if (
    health.version !== BRIDGE_VERSION
    || health.protocolVersion !== BRIDGE_PROTOCOL_VERSION
    || health.capabilities?.reader !== true
    || health.capabilities?.agent !== true
    || health.capabilities?.unrestricted !== true
  ) throw new Error(`Unexpected installed Bridge health: ${JSON.stringify(health)}`);

  const status = run(command, ["status"], env);
  if (!status.stdout.includes("PID") || !status.stdout.includes("Log:")) {
    throw new Error(`Installed status omitted managed process details:\n${status.stdout}`);
  }
  assertTokenHidden(status, firstToken, "status");
  run(command, ["doctor"], env);

  const secondInstall = run("bash", [installer], env, 15_000);
  const secondToken = readFileSync(tokenPath, "utf8").trim();
  if (secondToken !== firstToken) throw new Error("Reinstall changed the pairing token");
  if (readFileSync(clipboardPath, "utf8").trim() !== firstToken) throw new Error("Reinstall did not copy the stable pairing token");
  assertTokenHidden(secondInstall, firstToken, "reinstall");
  await waitForHealth(firstToken, 8_000);

  const logPath = join(stateDir, "bridge.log");
  if (!existsSync(logPath)) throw new Error("Installed Bridge did not create its managed log");
  if (readFileSync(logPath, "utf8").includes(firstToken)) throw new Error("Managed Bridge log leaked the pairing token");

  for (const obsoleteMode of ["agent", "full"]) {
    const obsoleteResult = spawnSync(command, [obsoleteMode, "--workspace", root], { env, encoding: "utf8", timeout: 5_000 });
    const obsoleteOutput = `${obsoleteResult.stdout || ""}\n${obsoleteResult.stderr || ""}`;
    if (
      obsoleteResult.status !== 2
      || !obsoleteOutput.includes("no longer a separate server mode")
      || !obsoleteOutput.includes("choose Reader, Agent or Full Agent in Lumen settings")
      || !obsoleteOutput.includes("npm and sudo are not needed")
    ) throw new Error(`Installed ${obsoleteMode} command did not explain the unified Bridge: ${JSON.stringify(obsoleteResult)}`);
  }

  const sudoResult = spawnSync(command, ["status"], { env: { ...env, SUDO_USER: "installer-smoke" }, encoding: "utf8", timeout: 5_000 });
  if (sudoResult.status === 0 || !sudoResult.stderr.includes("Do not run") || !sudoResult.stderr.includes("sudo")) {
    throw new Error(`Installed command did not reject sudo-style execution: ${JSON.stringify(sudoResult)}`);
  }

  writeFileSync(pbcopyStub, "#!/bin/sh\nexit 1\n");
  chmodSync(pbcopyStub, 0o700);
  const clipboardFailure = run(command, ["start"], env);
  if (!clipboardFailure.stderr.includes("Could not access the macOS clipboard") || !clipboardFailure.stderr.includes("lumen-paper-bridge token")) {
    throw new Error(`Clipboard failure did not preserve the running Bridge with a recovery hint: ${JSON.stringify(clipboardFailure)}`);
  }
  assertTokenHidden(clipboardFailure, firstToken, "clipboard failure");
  await waitForHealth(firstToken, 8_000);

  run(command, ["stop"], env);
  const concurrentStarts = await Promise.all([
    runAsync(command, ["start"], env, 20_000),
    runAsync(command, ["start"], env, 20_000),
  ]);
  if (concurrentStarts.some((result) => result.code !== 0)) {
    throw new Error(`Concurrent starts did not serialize cleanly: ${JSON.stringify(concurrentStarts)}`);
  }
  await waitForHealth(firstToken, 8_000);
  const concurrentPid = readFileSync(join(stateDir, "bridge.pid"), "utf8").trim();
  if (!/^\d+$/.test(concurrentPid)) throw new Error(`Concurrent start wrote an invalid PID: ${concurrentPid}`);
  run(command, ["stop"], env);
  const stoppedStatus = spawnSync(command, ["status"], { env, encoding: "utf8", timeout: 5_000 });
  if (stoppedStatus.status === 0 || !stoppedStatus.stderr.includes("not reachable")) {
    throw new Error(`Installed Bridge did not stop cleanly: ${JSON.stringify(stoppedStatus)}`);
  }

  process.stdout.write(`Installer smoke passed: v${BRIDGE_VERSION}, returns after background start, health/stop work, token copied without leakage and preserved\n`);
} finally {
  const command = join(binDir, "lumen-paper-bridge");
  if (existsSync(command)) spawnSync(command, ["stop"], { env, encoding: "utf8", timeout: 6_000 });
  rmSync(root, { recursive: true, force: true });
}

function run(command, args, environment, timeout = 10_000) {
  const result = spawnSync(command, args, { env: environment, encoding: "utf8", timeout });
  if (result.status !== 0) {
    throw new Error(`${command} exited ${result.status}${result.error ? ` (${result.error.message})` : ""}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result;
}

function runAsync(command, args, environment, timeoutMs) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { env: environment, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ code: -1, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
}

function assertTokenHidden(result, token, label) {
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (output.includes(token)) throw new Error(`${label} leaked the pairing token`);
  if (/npm run bridge:(?:agent|full)/.test(output)) throw new Error(`${label} recommended a source-only npm command`);
}

async function freePort() {
  const probe = createServer();
  await new Promise((resolvePromise, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = probe.address();
  const value = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolvePromise) => probe.close(resolvePromise));
  return value;
}

async function waitForHealth(token, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${port}/health`;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        headers: {
          Origin: "chrome-extension://plekdghigijomceniepcgmfjpekcnkjf",
          "X-Lumen-Token": token,
        },
      });
      if (response.ok) return await response.json();
    } catch {
      // The background launcher may still be starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 80));
  }
  throw new Error("Timed out waiting for the installed background Bridge");
}
