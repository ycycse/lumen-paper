#!/usr/bin/env node
import { createServer } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { BRIDGE_PROTOCOL_VERSION, BRIDGE_VERSION } from "../bridge/version.mjs";

const legacyExtensionId = "plekdghigijomceniepcgmfjpekcnkjf";
const randomExtensionId = Array.from(randomBytes(32), (byte) => String.fromCharCode(97 + (byte & 0x0f))).join("");
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
if [ "$1" = "app-server" ] && [ "$2" = "--stdio" ]; then
  while IFS= read -r line; do
    case "$line" in
      *'"id":1'*) printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{}}' ;;
      *'"id":2'*) printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"data":[{"id":"gpt-smoke","displayName":"GPT Smoke"}]}}'; exit 0 ;;
    esac
  done
  exit 0
fi
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
  const legacyOrigin = `chrome-extension://${legacyExtensionId}`;
  const randomOrigin = `chrome-extension://${randomExtensionId}`;
  const url = `http://127.0.0.1:${port}/health`;
  const headers = { Origin: legacyOrigin, "X-Lumen-Token": token };
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

  const randomOriginModels = await fetch(`http://127.0.0.1:${port}/v1/models`, {
    headers: { ...headers, Origin: randomOrigin },
  });
  if (randomOriginModels.status !== 200) {
    throw new Error(`Random valid Chrome extension origin returned ${randomOriginModels.status}, expected 200`);
  }
  if (randomOriginModels.headers.get("access-control-allow-origin") !== randomOrigin) {
    throw new Error("Random valid Chrome extension origin was not echoed in Access-Control-Allow-Origin");
  }
  const randomOriginModelsBody = await randomOriginModels.json();
  if (!randomOriginModelsBody.ok || randomOriginModelsBody.models?.[0]?.id !== "gpt-smoke") {
    throw new Error(`Unexpected model response for random valid Chrome extension origin: ${JSON.stringify(randomOriginModelsBody)}`);
  }

  const wrongOrigin = await fetch(url, { headers: { ...headers, Origin: "https://example.com" } });
  if (wrongOrigin.status !== 403) throw new Error(`Wrong origin returned ${wrongOrigin.status}, expected 403`);
  if (wrongOrigin.headers.has("access-control-allow-origin")) throw new Error("Wrong origin received an Access-Control-Allow-Origin header");
  const malformedOrigins = [
    `chrome-extension://${"a".repeat(31)}`,
    `chrome-extension://${"a".repeat(33)}`,
    `chrome-extension://${"q".repeat(32)}`,
    `${randomOrigin}/path`,
    `${randomOrigin}:43177`,
    "null",
  ];
  for (const origin of malformedOrigins) {
    const malformed = await fetch(url, { headers: { ...headers, Origin: origin } });
    if (malformed.status !== 403 || malformed.headers.has("access-control-allow-origin")) {
      throw new Error(`Malformed extension origin was not rejected: ${origin}`);
    }
  }
  const missingOrigin = await fetch(url, { headers: { "X-Lumen-Token": token } });
  if (missingOrigin.status !== 403 || missingOrigin.headers.has("access-control-allow-origin")) {
    throw new Error("Missing Origin was not rejected");
  }
  const wrongToken = await fetch(url, {
    headers: { ...headers, Origin: randomOrigin, "X-Lumen-Token": "not-the-token" },
  });
  if (wrongToken.status !== 401) throw new Error(`Wrong token returned ${wrongToken.status}, expected 401`);

  const preflight = await fetch(`http://127.0.0.1:${port}/v1/models`, {
    method: "OPTIONS",
    headers: {
      Origin: randomOrigin,
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "X-Lumen-Token",
    },
  });
  if (preflight.status !== 204) throw new Error(`Valid extension preflight returned ${preflight.status}, expected 204`);
  if (preflight.headers.get("access-control-allow-origin") !== randomOrigin) {
    throw new Error("Valid extension preflight did not echo its Origin");
  }
  if (!headerIncludes(preflight, "access-control-allow-methods", "GET")) {
    throw new Error("Valid extension preflight did not allow GET");
  }
  if (!headerIncludes(preflight, "access-control-allow-headers", "X-Lumen-Token")) {
    throw new Error("Valid extension preflight did not allow X-Lumen-Token");
  }
  if (preflight.headers.has("access-control-allow-credentials")) {
    throw new Error("Bridge preflight must not allow credentials");
  }

  for (const headers of [
    { Origin: randomOrigin, "Access-Control-Request-Method": "DELETE" },
    { Origin: randomOrigin, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "X-Unexpected" },
  ]) {
    const deniedPreflight = await fetch(`http://127.0.0.1:${port}/v1/models`, { method: "OPTIONS", headers });
    if (deniedPreflight.status !== 403) throw new Error(`Unexpected preflight was not rejected: ${JSON.stringify(headers)}`);
  }

  const wrongOriginPreflight = await fetch(`http://127.0.0.1:${port}/v1/models`, {
    method: "OPTIONS",
    headers: { Origin: "https://example.com", "Access-Control-Request-Method": "GET" },
  });
  if (wrongOriginPreflight.status !== 403) {
    throw new Error(`Wrong-origin preflight returned ${wrongOriginPreflight.status}, expected 403`);
  }
  if (wrongOriginPreflight.headers.has("access-control-allow-origin")) {
    throw new Error("Wrong-origin preflight received an Access-Control-Allow-Origin header");
  }

  const reader = await chat({ ...headers, Origin: randomOrigin }, { mode: "reader", runtimePrompt: "reader smoke" });
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

function headerIncludes(response, name, expectedValue) {
  return (response.headers.get(name) || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .includes(expectedValue.toLowerCase());
}
