#!/usr/bin/env node
import { createServer } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { BRIDGE_PROTOCOL_VERSION, BRIDGE_VERSION } from "../bridge/version.mjs";

const extensionId = "plekdghigijomceniepcgmfjpekcnkjf";
const root = mkdtempSync(join(tmpdir(), "lumen-bridge-smoke-"));
const stateDir = join(root, "state");
const codexStub = join(root, "codex-stub");
const codexArgsPath = join(root, "codex-args");
const codexCwdPath = join(root, "codex-cwd");
const codexStdinPath = join(root, "codex-stdin");
const agentWorkspace = join(root, "Agent Workspace");
const workspaceFile = join(root, "not-a-directory");
mkdirSync(agentWorkspace);
writeFileSync(workspaceFile, "file\n");
writeFileSync(codexStub, `#!/bin/sh
set -eu
if [ "$1" = "--version" ]; then sleep "\${LUMEN_TEST_STATUS_DELAY:-0}"; echo "codex-cli smoke"; exit 0; fi
if [ "$1" = "login" ] && [ "$2" = "status" ]; then sleep "\${LUMEN_TEST_STATUS_DELAY:-0}"; echo "Logged in"; exit 0; fi
printf '%s\n' "$@" > "$LUMEN_TEST_CODEX_ARGS"
pwd > "$LUMEN_TEST_CODEX_CWD"
cat > "$LUMEN_TEST_CODEX_STDIN"
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"bridge smoke response"}}'
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
    LUMEN_TEST_CODEX_ARGS: codexArgsPath,
    LUMEN_TEST_CODEX_CWD: codexCwdPath,
    LUMEN_TEST_CODEX_STDIN: codexStdinPath,
    LUMEN_TEST_STATUS_DELAY: "3",
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
  const healthStartedAt = Date.now();
  const response = await waitForResponse(url, headers, 8_000);
  const healthElapsedMs = Date.now() - healthStartedAt;
  if (healthElapsedMs > 2_000) throw new Error(`Health endpoint blocked on Codex status for ${healthElapsedMs}ms`);
  const health = await response.json();
  if (!health.ok || health.version !== BRIDGE_VERSION || health.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
    throw new Error(`Unexpected health response: ${JSON.stringify(health)}`);
  }
  if (
    health.capabilities?.reader !== true
    || health.capabilities?.agent !== true
    || health.capabilities?.unrestricted !== true
    || health.capabilities?.workspace !== "per-request"
  ) throw new Error(`Bridge did not advertise all per-request profiles: ${JSON.stringify(health.capabilities)}`);
  if ((statSync(tokenPath).mode & 0o777) !== 0o600) throw new Error("Pairing token permissions must be 0600");

  const wrongOrigin = await fetch(url, { headers: { ...headers, Origin: "https://example.com" } });
  if (wrongOrigin.status !== 403) throw new Error(`Wrong origin returned ${wrongOrigin.status}, expected 403`);
  const wrongToken = await fetch(url, { headers: { ...headers, "X-Lumen-Token": "not-the-token" } });
  if (wrongToken.status !== 401) throw new Error(`Wrong token returned ${wrongToken.status}, expected 401`);

  const reader = await chat(headers, { mode: "reader", runtimePrompt: "reader smoke" });
  assertOk(reader, "Reader request");
  if (
    reader.body.runtime?.mode !== "reader"
    || reader.body.runtime?.sandbox !== "read-only"
    || reader.body.runtime?.userConfigLoaded !== false
    || reader.body.runtime?.rulesLoaded !== false
  ) throw new Error(`Unexpected Reader runtime: ${JSON.stringify(reader.body.runtime)}`);
  const readerArgs = capturedArgs();
  assertArgPair(readerArgs, "--sandbox", "read-only", "Reader sandbox");
  assertArgPair(readerArgs, "--ask-for-approval", "never", "Reader approvals");
  assertIncludes(readerArgs, "--ignore-user-config", "Reader user config isolation");
  assertIncludes(readerArgs, "--ignore-rules", "Reader rules isolation");
  assertExcludes(readerArgs, "--dangerously-bypass-approvals-and-sandbox", "Reader unrestricted flag");
  const readerWorkdir = readFileSync(codexCwdPath, "utf8").trim();
  if (!readerWorkdir.includes("lumen-codex-") || existsSync(readerWorkdir)) {
    throw new Error(`Reader did not use and clean up a temporary directory: ${readerWorkdir}`);
  }

  const canonicalWorkspace = realpathSync(agentWorkspace);
  const agent = await chat(headers, { mode: "agent", workspace: agentWorkspace, runtimePrompt: "agent smoke" });
  assertOk(agent, "Agent request");
  if (
    agent.body.runtime?.mode !== "agent"
    || agent.body.runtime?.sandbox !== "workspace-write"
    || agent.body.runtime?.cwd !== canonicalWorkspace
    || agent.body.runtime?.userConfigLoaded !== true
    || agent.body.runtime?.rulesLoaded !== true
  ) throw new Error(`Unexpected Agent runtime: ${JSON.stringify(agent.body.runtime)}`);
  const agentArgs = capturedArgs();
  assertArgPair(agentArgs, "--sandbox", "workspace-write", "Agent sandbox");
  assertArgPair(agentArgs, "-C", canonicalWorkspace, "Agent workspace");
  assertExcludes(agentArgs, "--ignore-user-config", "Agent user config");
  assertExcludes(agentArgs, "--ignore-rules", "Agent rules");
  assertExcludes(agentArgs, "--dangerously-bypass-approvals-and-sandbox", "Agent unrestricted flag");

  const unrestricted = await chat(headers, { mode: "unrestricted", workspace: agentWorkspace, runtimePrompt: "full smoke" });
  assertOk(unrestricted, "Full Agent request");
  if (
    unrestricted.body.runtime?.mode !== "unrestricted"
    || unrestricted.body.runtime?.sandbox !== "danger-full-access"
    || unrestricted.body.runtime?.cwd !== canonicalWorkspace
    || unrestricted.body.runtime?.userConfigLoaded !== true
    || unrestricted.body.runtime?.rulesLoaded !== true
  ) throw new Error(`Unexpected Full Agent runtime: ${JSON.stringify(unrestricted.body.runtime)}`);
  const unrestrictedArgs = capturedArgs();
  assertIncludes(unrestrictedArgs, "--dangerously-bypass-approvals-and-sandbox", "Full Agent unrestricted flag");
  assertArgPair(unrestrictedArgs, "-C", canonicalWorkspace, "Full Agent workspace");
  assertExcludes(unrestrictedArgs, "--sandbox", "Full Agent sandbox flag");
  assertExcludes(unrestrictedArgs, "--ask-for-approval", "Full Agent approval flag");

  await assertRejectedWorkspace(headers, { mode: "agent" }, "require agent.workspace");
  await assertRejectedWorkspace(headers, { mode: "agent", workspace: "." }, "absolute path");
  await assertRejectedWorkspace(headers, { mode: "unrestricted", workspace: join(root, "missing") }, "existing directory");
  await assertRejectedWorkspace(headers, { mode: "agent", workspace: workspaceFile }, "existing directory");
  await assertRejectedWorkspace(headers, { mode: "agent", workspace: resolve("/") }, "filesystem root");
  await assertRejectedWorkspace(headers, { mode: "reader", workspace: agentWorkspace }, "does not accept agent.workspace");
  await assertRejectedWorkspace(headers, { mode: "agent", workspace: `/${"a".repeat(4096)}` }, "Invalid agent profile");

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
  const envToken = "environment-token-smoke-value";
  const envTokenResult = spawnSync(launcher, ["token"], {
    env: { ...launcherEnv, LUMEN_BRIDGE_STATE_DIR: join(root, "missing-state"), LUMEN_BRIDGE_TOKEN: envToken },
    encoding: "utf8",
    timeout: 5_000,
  });
  if (envTokenResult.status !== 0 || envTokenResult.stdout.trim() !== envToken) {
    throw new Error(`Environment token was not honored: ${JSON.stringify(envTokenResult)}`);
  }

  process.stdout.write(`Bridge smoke passed: v${health.version}, protocol ${health.protocolVersion}, per-request profiles, workspaces, proxy bypass and token guards enforced\n`);
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

async function chat(headers, agent) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      system: "Bridge smoke system prompt",
      messages: [{ role: "user", content: "Verify the selected runtime." }],
      tools: { webSearch: false, calculations: true },
      agent,
    }),
  });
  return { status: response.status, body: await response.json() };
}

function assertOk(result, label) {
  if (result.status !== 200 || result.body.ok !== true || result.body.content !== "bridge smoke response") {
    throw new Error(`${label} failed: ${JSON.stringify(result)}`);
  }
}

async function assertRejectedWorkspace(headers, agent, expectedError) {
  const result = await chat(headers, agent);
  if (result.status !== 400 || result.body.ok !== false || !String(result.body.error).includes(expectedError)) {
    throw new Error(`Invalid workspace was not rejected with ${JSON.stringify(expectedError)}: ${JSON.stringify(result)}`);
  }
}

function capturedArgs() {
  return readFileSync(codexArgsPath, "utf8").trim().split("\n");
}

function assertIncludes(args, value, label) {
  if (!args.includes(value)) throw new Error(`${label} missing ${JSON.stringify(value)}: ${JSON.stringify(args)}`);
}

function assertExcludes(args, value, label) {
  if (args.includes(value)) throw new Error(`${label} unexpectedly included ${JSON.stringify(value)}: ${JSON.stringify(args)}`);
}

function assertArgPair(args, option, value, label) {
  const index = args.indexOf(option);
  if (index < 0 || args[index + 1] !== value) {
    throw new Error(`${label} expected ${JSON.stringify([option, value])}: ${JSON.stringify(args)}`);
  }
}
