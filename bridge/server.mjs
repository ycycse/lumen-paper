#!/usr/bin/env node
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { BRIDGE_PROTOCOL_VERSION, BRIDGE_VERSION } from "./version.mjs";

const bridgeDir = dirname(fileURLToPath(import.meta.url));
const configuredStateDir = String(process.env.LUMEN_BRIDGE_STATE_DIR || "").trim();
if (configuredStateDir && !isAbsolute(configuredStateDir)) {
  throw new Error("LUMEN_BRIDGE_STATE_DIR must be an absolute path");
}
const stateDir = configuredStateDir ? resolve(configuredStateDir) : bridgeDir;
if (configuredStateDir) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
}
const tokenPath = join(stateDir, ".token");
const host = process.env.LUMEN_BRIDGE_HOST || "127.0.0.1";
const port = Number(process.env.LUMEN_BRIDGE_PORT || 43177);
const codexBin = process.env.LUMEN_CODEX_BIN || "codex";
const extensionId = process.env.LUMEN_EXTENSION_ID || "plekdghigijomceniepcgmfjpekcnkjf";
const allowedOrigin = `chrome-extension://${extensionId}`;
const maxBodyBytes = 2 * 1024 * 1024;
const maxConcurrentJobs = 4;
const bridgeOptions = parseBridgeOptions(process.argv.slice(2));
if (!["127.0.0.1", "::1", "localhost"].includes(host)) {
  throw new Error("LUMEN_BRIDGE_HOST must remain loopback-only");
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("LUMEN_BRIDGE_PORT must be an integer between 1 and 65535");
}
const token = ensureToken();
if (bridgeOptions.printToken) {
  process.stdout.write(`${token}\n`);
  process.exit(0);
}
const jobsByFingerprint = new Map();
let modelsCache = { expiresAt: 0, models: [] };
let codexStatusCache = { value: "checking", expiresAt: 0, refreshing: false };

const server = createServer(async (request, response) => {
  setSecurityHeaders(request, response);
  if (request.method === "OPTIONS") {
    if (!allowOrigin(request.headers.origin)) return json(response, 403, { ok: false, error: "Origin denied" });
    response.writeHead(204);
    return response.end();
  }
  if (request.method === "GET" && request.url === "/health") {
    if (!allowOrigin(request.headers.origin)) return json(response, 403, { ok: false, error: "Origin denied" });
    if (!validToken(request.headers["x-lumen-token"])) return json(response, 401, { ok: false, error: "Invalid pairing token" });
    return json(response, 200, {
      ok: true,
      service: "lumen-codex-bridge",
      version: BRIDGE_VERSION,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      busy: jobsByFingerprint.size > 0,
      activeJobs: [...jobsByFingerprint.values()].map(({ id, startedAt }) => ({
        id,
        activeForMs: Date.now() - startedAt,
      })),
      codex: cachedCodexStatus(),
      capabilities: bridgeCapabilities(),
    });
  }
  if (request.method === "GET" && request.url === "/v1/models") {
    if (!allowOrigin(request.headers.origin)) return json(response, 403, { ok: false, error: "Origin denied" });
    if (!validToken(request.headers["x-lumen-token"])) return json(response, 401, { ok: false, error: "Invalid pairing token" });
    try {
      const models = await listCodexModels();
      return json(response, 200, { ok: true, models });
    } catch (error) {
      return json(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (request.method !== "POST" || request.url !== "/v1/chat") {
    return json(response, 404, { ok: false, error: "Not found" });
  }
  if (!allowOrigin(request.headers.origin)) return json(response, 403, { ok: false, error: "Origin denied" });
  if (!validToken(request.headers["x-lumen-token"])) return json(response, 401, { ok: false, error: "Invalid pairing token" });

  try {
    const body = JSON.parse(await readBody(request));
    validateBody(body);
    const result = await scheduleCodex(body);
    return json(response, 200, { ok: true, ...result });
  } catch (error) {
    if (error instanceof QueueFullError) {
      return json(response, 429, {
        ok: false,
        error: `Codex 当前已有 ${maxConcurrentJobs} 个并行阅读任务，请稍候再试。`,
        retryAfterMs: 3000,
      });
    }
    if (error instanceof RequestValidationError || error instanceof SyntaxError) {
      return json(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return json(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

server.on("error", (error) => {
  if (error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE") {
    process.stderr.write(`Lumen Bridge could not start: http://${host}:${port} is already in use.\n`);
  } else {
    process.stderr.write(`Lumen Bridge could not start: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exitCode = 1;
});

server.listen(port, host, () => {
  const status = cachedCodexStatus();
  process.stdout.write(`\nLumen Codex bridge v${BRIDGE_VERSION}\n`);
  process.stdout.write(`  URL:   http://${host}:${port}\n`);
  process.stdout.write(`  Codex: ${status}\n`);
  process.stdout.write(`  Origin: ${allowedOrigin}\n`);
  process.stdout.write("  Modes: reader, agent, unrestricted (selected per request)\n");
  if (process.env.LUMEN_BRIDGE_PRINT_TOKEN === "0") {
    process.stdout.write("  Pairing token: hidden; run `lumen-paper-bridge pair` locally to copy it.\n");
  } else {
    process.stdout.write(`  Pairing token (paste once in Lumen settings):\n\n  ${token}\n\n`);
  }
  process.stdout.write(`The token is stored in ${tokenPath} with user-only permissions.\n`);
});

function ensureToken() {
  if (process.env.LUMEN_BRIDGE_TOKEN) return validatedToken(process.env.LUMEN_BRIDGE_TOKEN, "LUMEN_BRIDGE_TOKEN");
  if (existsSync(tokenPath)) {
    chmodSync(tokenPath, 0o600);
    return validatedToken(readFileSync(tokenPath, "utf8"), tokenPath);
  }
  const value = randomBytes(32).toString("base64url");
  writeFileSync(tokenPath, `${value}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(tokenPath, 0o600);
  return value;
}

function validatedToken(value, source) {
  const normalized = String(value).trim();
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(normalized)) {
    throw new Error(`Invalid pairing token in ${source}`);
  }
  return normalized;
}

function cachedCodexStatus() {
  if (codexStatusCache.expiresAt <= Date.now() && !codexStatusCache.refreshing) {
    void refreshCodexStatus();
  }
  return codexStatusCache.value;
}

async function refreshCodexStatus() {
  codexStatusCache.refreshing = true;
  try {
    const version = await captureCodex(["--version"], 5_000);
    const auth = await captureCodex(["login", "status"], 8_000);
    const authText = `${auth.stdout} ${auth.stderr}`.trim();
    codexStatusCache.value = `${(version.stdout || version.stderr).trim()} · ${authText || "auth unknown"}`;
    codexStatusCache.expiresAt = Date.now() + 60_000;
  } catch (error) {
    codexStatusCache.value = `unavailable (${error instanceof Error ? error.message : String(error)})`;
    codexStatusCache.expiresAt = Date.now() + 15_000;
  } finally {
    codexStatusCache.refreshing = false;
  }
}

function captureCodex(args, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(codexBin, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`codex ${args.join(" ")} timed out`));
    }, timeoutMs);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolvePromise({ stdout, stderr });
    };
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", finish);
    child.on("close", (code) => finish(code === 0 ? null : new Error(`codex ${args.join(" ")} exited ${code}`)));
  });
}

async function listCodexModels() {
  if (modelsCache.expiresAt > Date.now() && modelsCache.models.length) return modelsCache.models;
  const models = await queryCodexModels();
  modelsCache = { expiresAt: Date.now() + 5 * 60_000, models };
  return models;
}

function queryCodexModels() {
  return new Promise((resolve, reject) => {
    const child = spawn(codexBin, ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => finish(new Error("读取 Codex 模型列表超时")), 12_000);

    const finish = (error, models) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      if (error) reject(error);
      else resolve(models);
    };

    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const handleLine = (line) => {
      if (!line.trim()) return;
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id === 1) {
        if (message.error) return finish(new Error(message.error.message || "Codex app-server 初始化失败"));
        send({ jsonrpc: "2.0", method: "initialized", params: {} });
        send({ jsonrpc: "2.0", id: 2, method: "model/list", params: { limit: 100, includeHidden: false } });
      }
      if (message.id === 2) {
        if (message.error) return finish(new Error(message.error.message || "Codex 模型列表读取失败"));
        const models = Array.isArray(message.result?.data) ? message.result.data : [];
        return models.length
          ? finish(null, models)
          : finish(new Error("Codex 没有返回可选模型"));
      }
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const lines = stdout.split("\n");
      stdout = lines.pop() || "";
      lines.forEach(handleLine);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 100_000) stderr = stderr.slice(-100_000);
    });
    child.on("error", finish);
    child.stdin.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (!settled) finish(new Error(`Codex app-server exited ${code}: ${lastLines(stderr)}`));
    });
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "lumen-paper", title: "Lumen Paper", version: BRIDGE_VERSION },
        capabilities: { experimentalApi: true },
      },
    });
  });
}

function validateBody(body) {
  if (!body || typeof body !== "object") throw new RequestValidationError("Invalid JSON body");
  if (typeof body.system !== "string" || body.system.length > 20_000) throw new RequestValidationError("Invalid system prompt");
  if (!Array.isArray(body.messages) || body.messages.length > 16) throw new RequestValidationError("Invalid messages");
  for (const message of body.messages) {
    if (!message || !["user", "assistant"].includes(message.role) || typeof message.content !== "string") {
      throw new RequestValidationError("Invalid message");
    }
  }
  if (body.model != null && !/^[a-zA-Z0-9._:-]{1,100}$/.test(body.model)) throw new RequestValidationError("Invalid model name");
  if (body.tools != null && (
    typeof body.tools !== "object"
    || (body.tools.webSearch != null && typeof body.tools.webSearch !== "boolean")
    || (body.tools.calculations != null && typeof body.tools.calculations !== "boolean")
  )) throw new RequestValidationError("Invalid tool policy");
  if (body.agent != null && (
    typeof body.agent !== "object"
    || !["reader", "agent", "unrestricted"].includes(body.agent.mode)
    || (body.agent.workspace != null && (typeof body.agent.workspace !== "string" || body.agent.workspace.length > 4096))
    || (body.agent.runtimePrompt != null && (typeof body.agent.runtimePrompt !== "string" || body.agent.runtimePrompt.length > 20_000))
  )) throw new RequestValidationError("Invalid agent profile");
  validateRequestWorkspace(body);
}

function validateRequestWorkspace(body) {
  const mode = body.agent?.mode || "reader";
  const requestedWorkspace = body.agent?.workspace;
  if (mode === "reader") {
    if (requestedWorkspace != null && requestedWorkspace.trim()) {
      throw new RequestValidationError("Reader mode does not accept agent.workspace");
    }
    return;
  }
  if (typeof requestedWorkspace !== "string" || !requestedWorkspace.trim()) {
    throw new RequestValidationError("Agent and Full Agent require agent.workspace with an existing absolute directory");
  }
  if (!isAbsolute(requestedWorkspace)) {
    throw new RequestValidationError("agent.workspace must be an absolute path");
  }
  let workspace;
  try {
    workspace = realpathSync(requestedWorkspace);
    if (!statSync(workspace).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new RequestValidationError("agent.workspace must point to an existing directory");
  }
  if (dirname(workspace) === workspace) throw new RequestValidationError("agent.workspace must not be a filesystem root");
  body.agent.workspace = workspace;
}

function scheduleCodex(body) {
  const mode = body.agent?.mode || "reader";
  const reusable = mode === "reader";
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({
      system: body.system,
      messages: body.messages,
      model: body.model || null,
      temperature: body.temperature ?? null,
      purpose: body.purpose || null,
      tools: body.tools || null,
      agent: body.agent || null,
    }))
    .digest("hex");
  const shortId = fingerprint.slice(0, 8);
  const existing = reusable ? jobsByFingerprint.get(fingerprint) : null;
  if (existing) {
    log(`join  ${shortId} · reused existing request`);
    return existing.promise;
  }
  if (jobsByFingerprint.size >= maxConcurrentJobs) throw new QueueFullError();

  const startedAt = Date.now();
  const jobKey = reusable ? fingerprint : `${fingerprint}:${randomBytes(6).toString("hex")}`;
  const job = (async () => {
    log(`start ${shortId} · ${mode} · ${body.messages.length} message(s) · ${requestChars(body).toLocaleString()} chars`);
    try {
      const result = await runCodex(body);
      const toolLabel = result.toolActivity.length
        ? ` · ${result.toolActivity.map(({ kind, count }) => `${kind}×${count}`).join(" · ")}`
        : "";
      log(`done  ${shortId} · ${formatDuration(Date.now() - startedAt)}${toolLabel}`);
      return result;
    } catch (error) {
      log(`fail  ${shortId} · ${formatDuration(Date.now() - startedAt)} · ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  })();
  jobsByFingerprint.set(jobKey, { id: shortId, startedAt, promise: job });
  void job.finally(() => {
    if (jobsByFingerprint.get(jobKey)?.promise === job) jobsByFingerprint.delete(jobKey);
  }).catch(() => undefined);
  return job;
}

class QueueFullError extends Error {}
class RequestValidationError extends Error {}

function requestChars(body) {
  return body.system.length + body.messages.reduce((total, message) => total + message.content.length, 0);
}

function formatDuration(milliseconds) {
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

function log(message) {
  process.stdout.write(`[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] ${message}\n`);
}

function runCodex(body) {
  const mode = body.agent?.mode || "reader";
  const ownsWorkdir = mode === "reader";
  const workdir = ownsWorkdir ? mkdtempSync(join(tmpdir(), "lumen-codex-")) : body.agent.workspace;
  const webSearch = body.tools?.webSearch !== false;
  const args = [];
  if (webSearch) args.push("--search");
  if (mode === "unrestricted") {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    args.push("--sandbox", mode === "agent" ? "workspace-write" : "read-only", "--ask-for-approval", "never");
  }
  args.push("exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "--color", "never",
    "-C", workdir,
  );
  if (mode === "reader") {
    args.push(
      "--ignore-user-config",
      "--ignore-rules",
      "--config", 'shell_environment_policy.inherit="core"',
    );
  }
  if (!webSearch) args.push("--config", 'web_search="disabled"');
  if (body.model) args.push("--model", body.model);
  args.push("-");

  const transcript = body.messages
    .map((message) => `${message.role.toUpperCase()}:\n${message.content}`)
    .join("\n\n");
  const system = [body.system, body.agent?.runtimePrompt].filter((value) => typeof value === "string" && value.length).join("\n\n");
  const prompt = `SYSTEM:\n${system}\n\n${transcript}`;
  const runtime = runtimeReceipt(mode, workdir, webSearch);

  return new Promise((resolve, reject) => {
    const child = spawn(codexBin, args, {
      cwd: workdir,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    const timeoutMs = mode === "reader" ? 175_000 : mode === "agent" ? 10 * 60_000 : 15 * 60_000;
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 2_000_000) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 500_000) stderr = stderr.slice(-500_000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      cleanup();
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      cleanup();
      if (code === 0 && stdout.trim()) {
        try { resolve({ ...parseCodexOutput(stdout), runtime }); }
        catch (error) { reject(error); }
      }
      else reject(new Error(signal ? `Codex timed out (${signal})` : `Codex exited ${code}: ${lastLines(stderr)}`));
    });
    child.stdin.end(prompt);
  });

  function cleanup() {
    if (!ownsWorkdir) return;
    try { rmSync(workdir, { recursive: true, force: true }); } catch { /* best effort temp cleanup */ }
  }
}

function parseCodexOutput(output) {
  let content = "";
  let webSearchCount = 0;
  let calculationCount = 0;
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const item = event.item;
    if (event.type !== "item.completed" || !item) continue;
    if (item.type === "agent_message" && typeof item.text === "string") content = item.text.trim();
    if (item.type === "web_search") webSearchCount += 1;
    if (item.type === "command_execution" && item.status === "completed") calculationCount += 1;
  }
  if (!content) throw new Error("Codex completed without a final agent message");
  const toolActivity = [];
  if (webSearchCount) toolActivity.push({ kind: "web_search", count: webSearchCount });
  if (calculationCount) toolActivity.push({ kind: "calculation", count: calculationCount });
  return { content, toolActivity };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        reject(new Error("Request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function setSecurityHeaders(request, response) {
  const origin = request.headers.origin;
  if (allowOrigin(origin) && origin) response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Lumen-Token");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

function allowOrigin(origin) {
  return origin === allowedOrigin;
}

function parseBridgeOptions(argv) {
  let printToken = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--allow-agent") continue;
    else if (argument === "--print-token") printToken = true;
    else if (argument === "--allow-unrestricted") continue;
    else if (argument === "--workspace") {
      if (!argv[index + 1]) throw new Error("--workspace requires a path");
      index += 1;
    } else throw new Error(`Unknown bridge option: ${argument}`);
  }
  return { printToken };
}

function bridgeCapabilities() {
  return {
    reader: true,
    agent: true,
    unrestricted: true,
    workspace: "per-request",
    origin: allowedOrigin,
  };
}

function runtimeReceipt(mode, workdir, webSearch) {
  return {
    mode,
    sandbox: mode === "unrestricted" ? "danger-full-access" : mode === "agent" ? "workspace-write" : "read-only",
    cwd: workdir,
    userConfigLoaded: mode !== "reader",
    rulesLoaded: mode !== "reader",
    webSearch,
  };
}

function validToken(value) {
  if (typeof value !== "string") return false;
  const left = Buffer.from(value);
  const right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
}

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function lastLines(value) {
  return value.trim().split("\n").slice(-8).join("\n") || "no error output";
}

process.on("SIGINT", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
