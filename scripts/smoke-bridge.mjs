#!/usr/bin/env node
import { createServer } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { BRIDGE_PROTOCOL_VERSION, BRIDGE_VERSION } from "../bridge/version.mjs";

const extensionId = "plekdghigijomceniepcgmfjpekcnkjf";
const root = mkdtempSync(join(tmpdir(), "lumen-bridge-smoke-"));
const stateDir = join(root, "state");
const codexStub = join(root, "codex-stub");
writeFileSync(codexStub, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli smoke"; exit 0; fi
if [ "$1" = "login" ] && [ "$2" = "status" ]; then echo "Logged in"; exit 0; fi
exit 0
`);
chmodSync(codexStub, 0o700);

const port = await freePort();
const child = spawn(process.execPath, [resolve("bridge/server.mjs")], {
  env: {
    ...process.env,
    LUMEN_BRIDGE_PORT: String(port),
    LUMEN_BRIDGE_STATE_DIR: stateDir,
    LUMEN_CODEX_BIN: codexStub,
    LUMEN_BRIDGE_PRINT_TOKEN: "0",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

try {
  const tokenPath = join(stateDir, ".token");
  await waitFor(() => existsSync(tokenPath), 5_000, "pairing token");
  const token = readFileSync(tokenPath, "utf8").trim();
  const origin = `chrome-extension://${extensionId}`;
  const url = `http://127.0.0.1:${port}/health`;
  const headers = { Origin: origin, "X-Lumen-Token": token };
  const response = await waitForResponse(url, headers, 8_000);
  const health = await response.json();
  if (!health.ok || health.version !== BRIDGE_VERSION || health.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
    throw new Error(`Unexpected health response: ${JSON.stringify(health)}`);
  }
  if ((statSync(tokenPath).mode & 0o777) !== 0o600) throw new Error("Pairing token permissions must be 0600");

  const wrongOrigin = await fetch(url, { headers: { ...headers, Origin: "https://example.com" } });
  if (wrongOrigin.status !== 403) throw new Error(`Wrong origin returned ${wrongOrigin.status}, expected 403`);
  const wrongToken = await fetch(url, { headers: { ...headers, "X-Lumen-Token": "not-the-token" } });
  if (wrongToken.status !== 401) throw new Error(`Wrong token returned ${wrongToken.status}, expected 401`);

  const launcher = resolve("bridge/lumen-paper-bridge");
  const launcherEnv = {
    ...process.env,
    HOME: root,
    LUMEN_BRIDGE_PORT: String(port),
    LUMEN_BRIDGE_STATE_DIR: stateDir,
    LUMEN_NODE_BIN: process.execPath,
    LUMEN_CODEX_BIN: codexStub,
    NO_PROXY: "",
    no_proxy: "",
    HTTP_PROXY: "http://127.0.0.1:9",
    http_proxy: "http://127.0.0.1:9",
  };
  const statusResult = spawnSync(launcher, ["status"], { env: launcherEnv, encoding: "utf8", timeout: 5_000 });
  if (statusResult.status !== 0) {
    throw new Error(`Launcher status did not bypass the HTTP proxy: ${statusResult.stderr || statusResult.stdout}`);
  }
  const mismatchResult = spawnSync(launcher, ["agent", "--workspace", root], { env: launcherEnv, encoding: "utf8", timeout: 5_000 });
  if (mismatchResult.status !== 3 || !mismatchResult.stderr.includes("does not match")) {
    throw new Error(`Reader-to-Agent mismatch was not rejected: ${JSON.stringify(mismatchResult)}`);
  }
  const envToken = "environment-token-smoke-value";
  const envTokenResult = spawnSync(launcher, ["token"], {
    env: { ...launcherEnv, LUMEN_BRIDGE_STATE_DIR: join(root, "missing-state"), LUMEN_BRIDGE_TOKEN: envToken },
    encoding: "utf8",
    timeout: 5_000,
  });
  if (envTokenResult.status !== 0 || envTokenResult.stdout.trim() !== envToken) {
    throw new Error(`Environment token was not honored: ${JSON.stringify(envTokenResult)}`);
  }

  process.stdout.write(`Bridge smoke passed: v${health.version}, protocol ${health.protocolVersion}, proxy bypass and profile/token guards enforced\n`);
} finally {
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolvePromise) => child.once("close", resolvePromise)),
    new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000)),
  ]);
  rmSync(root, { recursive: true, force: true });
}

if (child.exitCode != null && child.exitCode !== 0) {
  throw new Error(`Bridge exited ${child.exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
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

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`Timed out waiting for ${label}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
}

async function waitForResponse(url, headers, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await fetch(url, { headers });
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 80));
    }
  }
  throw new Error(`Timed out waiting for Bridge\nstdout:\n${stdout}\nstderr:\n${stderr}`);
}
