#!/usr/bin/env node
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { tmpdir } from "node:os";

class Cdp {
  constructor(url) {
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolvePromise, reject) => {
      this.socket.addEventListener("open", resolvePromise, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) {
        this.events.push(message);
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result.value;
  }
  close() { this.socket.close(); }
}

const defaultChromePaths = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
];
const chromePath = process.env.CHROME_BIN || defaultChromePaths.find((candidate) => existsSync(candidate));
if (!chromePath) {
  throw new Error("Chrome not found. Set CHROME_BIN to a Chrome or Chrome for Testing executable.");
}
const extensionDir = resolve("dist");
const manifest = JSON.parse(readFileSync(resolve(extensionDir, "manifest.json"), "utf8"));
const extensionHash = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32);
const expectedExtensionId = [...extensionHash].map((value) => String.fromCharCode(97 + Number.parseInt(value, 16))).join("");
const smokePdf = process.argv[2] || process.env.LUMEN_SMOKE_PDF;
if (!smokePdf) {
  throw new Error("Missing smoke PDF. Run: npm run smoke -- /absolute/path/to/paper.pdf");
}
const pdfPath = resolve(smokePdf);
const profileDir = mkdtempSync(`${tmpdir()}/lumen-chrome-`);
const screenshotPath = resolve("work/smoke-reader.png");
const focusScreenshotPath = resolve("work/smoke-focus-mode.png");
const notesScreenshotPath = resolve("work/smoke-highlights.png");
const smokeAnswer = [
  "## 核心判断",
  "",
  "这篇论文最强的 evidence 是真实软件任务上的交互效率，而不是单一 benchmark 涨点。",
  "",
  "- **主结果**：蒸馏后的策略保留了上下文经验带来的收益。",
  "- **效率**：达到同等表现时，环境交互次数显著减少。",
  "- **边界**：定性案例是 selected examples，不能单独证明普遍因果机制。",
  "",
  "> Reviewer 视角：重点核查 pass@1 对照、样本选择和跨任务迁移。",
  "",
  "| 证据 | 该看什么 |",
  "| --- | --- |",
  "| 主实验 | 平均收益与置信区间 |",
  "| 消融 | 去掉 distillation 后是否退化 |",
  "",
  "建议先读主结果表，再回到方法假设。[[p:1]]",
].join("\n");
let lastApiOrigin = "";
mkdirSync(resolve("work"), { recursive: true });

if (!existsSync(pdfPath)) throw new Error(`Missing smoke PDF: ${pdfPath}`);
const pdfBytes = readFileSync(pdfPath);
const pdfServer = createServer((request, response) => {
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
    });
    response.end();
  } else if (request.url === "/paper.pdf") {
    response.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": pdfBytes.length });
    response.end(pdfBytes);
  } else if (request.url === "/v1/chat/completions" && request.method === "POST") {
    lastApiOrigin = String(request.headers.origin || "");
    response.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    response.end(JSON.stringify({ choices: [{ message: { content: smokeAnswer } }] }));
  } else if (request.url === "/v1/models" && request.method === "GET") {
    response.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    response.end(JSON.stringify({ data: [
      { id: "smoke-summary", name: "Smoke Summary", description: "Stronger reading model", isDefault: true },
      { id: "smoke-chat", name: "Smoke Chat", description: "Faster conversation model" },
    ] }));
  } else {
    response.writeHead(404).end();
  }
});
await new Promise((resolvePromise) => pdfServer.listen(0, "127.0.0.1", resolvePromise));
const pdfPort = pdfServer.address().port;

const chrome = spawn(chromePath, [
  ...(process.env.LUMEN_HEADFUL === "1" ? [] : ["--headless=new"]),
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  `--user-data-dir=${profileDir}`,
  `--disable-extensions-except=${extensionDir}`,
  `--load-extension=${extensionDir}`,
  "--remote-debugging-address=127.0.0.1",
  "--remote-debugging-port=0",
  `chrome-extension://${expectedExtensionId}/popup.html`,
], { stdio: ["ignore", "ignore", "pipe"] });

let chromeErrors = "";
chrome.stderr.on("data", (chunk) => { chromeErrors += chunk.toString(); });

try {
  const portFile = resolve(profileDir, "DevToolsActivePort");
  await waitFor(() => existsSync(portFile), 15_000, "Chrome DevTools port");
  const [debugPort] = readFileSync(portFile, "utf8").split("\n");
  await waitFor(async () => (await targets(debugPort)).some((target) => target.type === "service_worker" && target.url.startsWith(`chrome-extension://${expectedExtensionId}/`)), 15_000, "extension service worker");
  const allTargets = await targets(debugPort);
  const worker = allTargets.find((target) => target.type === "service_worker" && target.url.startsWith(`chrome-extension://${expectedExtensionId}/`));
  if (!worker) throw new Error(`Extension service worker not found. Targets: ${JSON.stringify(allTargets)}`);
  const extensionId = new URL(worker.url).host;
  const pdfUrl = `http://127.0.0.1:${pdfPort}/paper.pdf`;
  const source = encodeURIComponent(pdfUrl);
  const mimeMode = process.env.LUMEN_SMOKE_MIME === "1";
  const viewerUrl = mimeMode ? pdfUrl : `chrome-extension://${extensionId}/viewer.html?source=${source}`;
  const workerCdp = new Cdp(worker.webSocketDebuggerUrl);
  await workerCdp.ready;
  await workerCdp.send("Runtime.enable");
  const extensionDiagnostic = await workerCdp.evaluate(`(() => ({
    url: chrome.runtime.getURL('viewer.html'),
    name: chrome.runtime.getManifest().name,
    version: chrome.runtime.getManifest().version,
    manifest: chrome.runtime.getManifest()
  }))()`);
  process.stdout.write(`Extension diagnostic: ${JSON.stringify(extensionDiagnostic)}\n`);
  await workerCdp.evaluate(`chrome.storage.local.set({ 'lumen.settings': {
    provider: 'compatible',
    endpoint: ${JSON.stringify(`http://127.0.0.1:${pdfPort}/v1/chat/completions`)},
    apiKey: 'smoke-key',
    model: 'smoke-model',
    bridgeUrl: 'http://127.0.0.1:43177',
    bridgeToken: '',
    codexModel: '',
    autoOpenPdfs: true,
    autoAnalyze: false,
    responseLanguage: 'zh-CN',
    storeConversations: true
  } })`);
  await workerCdp.evaluate(`chrome.tabs.create({ url: ${JSON.stringify(viewerUrl)} })`);
  const matchesViewer = (item) => item.type === "page" && (mimeMode ? item.url === pdfUrl : item.url.startsWith(`chrome-extension://${extensionId}/viewer.html`));
  await waitFor(async () => (await targets(debugPort)).some(matchesViewer), 10_000, "viewer tab");
  const target = (await targets(debugPort)).find(matchesViewer);
  workerCdp.close();
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Log.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

  await new Promise((resolvePromise) => setTimeout(resolvePromise, 2500));
  const diagnostic = await cdp.evaluate(`(() => ({
    href: location.href,
    title: document.title,
    root: document.querySelector('#root')?.innerText?.slice(0, 800),
    body: document.body?.innerText?.slice(0, 800),
    scripts: [...document.scripts].map(script => script.src),
    pages: document.querySelectorAll('.pdf-page').length
  }))()`);
  process.stdout.write(`Smoke diagnostic: ${JSON.stringify(diagnostic)}\n`);

  await waitFor(async () => {
    const result = await cdp.evaluate(`document.querySelectorAll('.pdf-page').length`);
    return Number(result) > 0;
  }, 45_000, "rendered PDF pages");

  const metrics = await cdp.evaluate(`(() => ({
    title: document.querySelector('.document-title')?.textContent,
    tabTitle: document.title,
    favicon: document.querySelector('link[rel="icon"]')?.getAttribute('href'),
    pages: document.querySelectorAll('.pdf-page').length,
    canvasWidth: document.querySelector('.pdf-page canvas')?.width,
    textSpans: document.querySelectorAll('.textLayer span').length,
    panel: Boolean(document.querySelector('.insight-panel')),
    onboarding: document.querySelector('.onboarding-panel h2')?.textContent,
    provider: document.querySelector('.provider-chip-label')?.textContent,
    bodyWidth: document.body.getBoundingClientRect().width
  }))()`);
  if (!metrics.pages || !metrics.canvasWidth || !metrics.textSpans || !metrics.panel || !metrics.tabTitle?.endsWith(' · Lumen')) {
    throw new Error(`Incomplete reader render: ${JSON.stringify(metrics)}`);
  }

  await cdp.evaluate(`document.querySelector('.focus-toggle')?.click()`);
  await waitFor(async () => Boolean(await cdp.evaluate(`document.querySelector('.reader-app')?.classList.contains('focus-mode')`)), 5_000, "focus mode");
  const focusModeActive = await cdp.evaluate(`({
    entered: document.querySelector('.reader-app')?.classList.contains('focus-mode'),
    panelHidden: !document.querySelector('.insight-panel'),
    exitVisible: getComputedStyle(document.querySelector('.focus-exit-button')).display !== 'none'
  })`);
  const focusCapture = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(focusScreenshotPath, Buffer.from(focusCapture.data, "base64"));
  await cdp.evaluate(`document.querySelector('.focus-exit-button')?.click()`);
  await waitFor(async () => !(await cdp.evaluate(`document.querySelector('.reader-app')?.classList.contains('focus-mode')`)), 5_000, "focus mode restore");
  const focusMode = { ...focusModeActive, restored: await cdp.evaluate(`Boolean(document.querySelector('.insight-panel'))`) };
  if (!focusMode.entered || !focusMode.panelHidden || !focusMode.exitVisible || !focusMode.restored) {
    throw new Error(`Focus mode failed: ${JSON.stringify(focusMode)}`);
  }
  metrics.focusMode = focusMode;

  const panelResize = await cdp.evaluate(`(() => {
    const panel = document.querySelector('.insight-panel');
    const handle = document.querySelector('.panel-resize-handle');
    const scroll = document.querySelector('.panel-scroll');
    if (!panel || !handle || !scroll) return null;
    const contentWidth = () => {
      const style = getComputedStyle(scroll);
      return scroll.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    };
    const before = panel.getBoundingClientRect().width;
    const contentBefore = contentWidth();
    const x = handle.getBoundingClientRect().left + 2;
    handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: x, pointerId: 1 }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x - 520, pointerId: 1 }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x - 520, pointerId: 1 }));
    return new Promise((resolvePromise) => requestAnimationFrame(() => requestAnimationFrame(() => resolvePromise({
      before,
      after: panel.getBoundingClientRect().width,
      contentBefore,
      contentAfter: contentWidth(),
      persisted: localStorage.getItem('lumen.reader.panelWidth')
    }))));
  })()`);
  if (
    !panelResize ||
    panelResize.after < 850 ||
    panelResize.contentAfter < panelResize.contentBefore + 250 ||
    Number(panelResize.persisted) !== panelResize.after
  ) {
    throw new Error(`Panel resize failed: ${JSON.stringify(panelResize)}`);
  }
  metrics.panelResize = panelResize;

  const readingWidthModes = await cdp.evaluate(`(async () => {
    const root = document.querySelector('.reader-app');
    const scroll = document.querySelector('.panel-scroll');
    const readableWidth = () => {
      const style = getComputedStyle(scroll);
      return scroll.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    };
    document.querySelector('.font-chip')?.click();
    await new Promise((resolvePromise) => requestAnimationFrame(resolvePromise));
    const options = [...document.querySelectorAll('.reading-width-options button')];
    const defaultWide = root?.classList.contains('reading-width-wide');
    const wideWidth = readableWidth();
    options.find((button) => button.textContent.includes('铺满'))?.click();
    await new Promise((resolvePromise) => requestAnimationFrame(resolvePromise));
    const fullWidth = readableWidth();
    const fullActive = root?.classList.contains('reading-width-full');
    const persistedFull = localStorage.getItem('lumen.reader.readingWidth');
    options.find((button) => button.textContent.includes('宽屏'))?.click();
    await new Promise((resolvePromise) => requestAnimationFrame(resolvePromise));
    const fontOptions = [...document.querySelectorAll('.reading-font-options button')];
    const documentFontBefore = getComputedStyle(document.querySelector('.document-title')).fontFamily;
    fontOptions.find((button) => button.textContent.includes('自定义'))?.click();
    await new Promise((resolvePromise) => requestAnimationFrame(resolvePromise));
    const customInput = document.querySelector('.custom-font-input');
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (customInput && valueSetter) {
      valueSetter.call(customInput, 'LXGW WenKai');
      customInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await new Promise((resolvePromise) => requestAnimationFrame(() => requestAnimationFrame(resolvePromise)));
    const customFontActive = root?.classList.contains('reading-font-custom');
    const persistedFontMode = localStorage.getItem('lumen.reader.readingFontMode');
    const persistedCustomFont = localStorage.getItem('lumen.reader.customReadingFont');
    const customFontVariable = root?.style.getPropertyValue('--custom-reading-font');
    const documentFontUnchanged = getComputedStyle(document.querySelector('.document-title')).fontFamily === documentFontBefore;
    fontOptions.find((button) => button.textContent.includes('系统'))?.click();
    await new Promise((resolvePromise) => requestAnimationFrame(resolvePromise));
    document.querySelector('.font-chip')?.click();
    return {
      options: options.length,
      defaultWide,
      wideWidth,
      fullWidth,
      fullActive,
      persistedFull,
      fontOptions: fontOptions.length,
      customInput: Boolean(customInput),
      customFontActive,
      persistedFontMode,
      persistedCustomFont,
      customFontVariable,
      documentFontUnchanged
    };
  })()`);
  if (
    readingWidthModes.options !== 3 ||
    !readingWidthModes.defaultWide ||
    !readingWidthModes.fullActive ||
    readingWidthModes.persistedFull !== 'full' ||
    readingWidthModes.fullWidth < readingWidthModes.wideWidth + 10 ||
    readingWidthModes.fontOptions !== 3 ||
    !readingWidthModes.customInput ||
    !readingWidthModes.customFontActive ||
    readingWidthModes.persistedFontMode !== 'custom' ||
    readingWidthModes.persistedCustomFont !== 'LXGW WenKai' ||
    !readingWidthModes.customFontVariable?.includes('LXGW WenKai') ||
    !readingWidthModes.documentFontUnchanged
  ) {
    throw new Error(`Reading width modes failed: ${JSON.stringify(readingWidthModes)}`);
  }
  metrics.readingWidthModes = readingWidthModes;

  await cdp.evaluate(`(() => {
    const span = document.querySelector('.textLayer span');
    if (!span) return false;
    const selection = getSelection();
    const range = document.createRange();
    range.selectNodeContents(span);
    selection.removeAllRanges();
    selection.addRange(range);
    span.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 420, clientY: 180 }));
    return true;
  })()`);
  await waitFor(async () => Boolean(await cdp.evaluate(`Boolean(document.querySelector('.selection-popover'))`)), 5_000, "selection toolbar");
  await cdp.evaluate(`document.querySelector('.highlight-control > button')?.click()`);
  await waitFor(async () => Number(await cdp.evaluate(`document.querySelectorAll('.saved-highlight').length`)) > 0, 5_000, "saved highlight overlay");
  metrics.selectionToolbar = true;
  metrics.savedHighlights = await cdp.evaluate(`document.querySelectorAll('.saved-highlight').length`);

  await cdp.evaluate(`document.querySelectorAll('.panel-tabs button')[2]?.click()`);
  await waitFor(async () => Number(await cdp.evaluate(`document.querySelectorAll('.note-card').length`)) > 0, 5_000, "notes tab after highlight");
  metrics.notesTab = await cdp.evaluate(`document.querySelector('.notes-panel h2')?.textContent`);
  await cdp.evaluate(`(() => {
    getSelection()?.removeAllRanges();
    document.querySelector('.selection-popover .popover-close')?.click();
    const handle = document.querySelector('.panel-resize-handle');
    handle?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    for (let index = 0; index < 3; index += 1) {
      handle?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    }
  })()`);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
  const notesCapture = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(notesScreenshotPath, Buffer.from(notesCapture.data, "base64"));

  await cdp.evaluate(`document.querySelectorAll('.panel-tabs button')[1]?.click()`);
  await waitFor(async () => Boolean(await cdp.evaluate(`Boolean(document.querySelector('.composer textarea'))`)), 5_000, "chat composer");
  await cdp.evaluate(`(() => {
    const textarea = document.querySelector('.composer textarea');
    if (!textarea) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, '这篇论文的核心证据是什么？');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await waitFor(async () => !(await cdp.evaluate(`document.querySelector('.composer button')?.disabled`)), 5_000, "enabled chat send");
  await cdp.evaluate(`document.querySelector('.composer button')?.click()`);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 2500));
  const actionState = await cdp.evaluate(`(() => ({
    rootAlive: Boolean(document.querySelector('.reader-app .topbar')),
    messages: document.querySelectorAll('.message').length,
    assistants: document.querySelectorAll('.message.assistant').length,
    toast: document.querySelector('.toast')?.textContent,
    body: document.body.innerText.slice(-500)
  }))()`);
  process.stdout.write(`Action diagnostic: ${JSON.stringify(actionState)}\n`);
  if (!actionState.rootAlive) {
    const relevantEvents = cdp.events.filter(({ method }) => method === "Runtime.exceptionThrown" || method === "Log.entryAdded");
    process.stdout.write(`Runtime events: ${JSON.stringify(relevantEvents, null, 2)}\n`);
  }
  if (!actionState.rootAlive || !actionState.assistants) throw new Error(`Chat action failed: ${JSON.stringify(actionState)}`);
  metrics.chatMessages = actionState.messages;
  metrics.rootAliveAfterActions = actionState.rootAlive;
  metrics.apiRequestOrigin = lastApiOrigin;
  if (lastApiOrigin !== `chrome-extension://${extensionId}`) {
    throw new Error(`Unexpected extension request Origin: ${lastApiOrigin || "<missing>"}`);
  }

  const fontBefore = await cdp.evaluate(`parseFloat(getComputedStyle(document.querySelector('.message.assistant')).fontSize)`);
  await cdp.evaluate(`document.querySelector('.font-chip')?.click()`);
  await waitFor(async () => Number(await cdp.evaluate(`document.querySelectorAll('.font-size-options button').length`)) === 4, 5_000, "font size menu");
  await cdp.evaluate(`document.querySelectorAll('.font-size-options button')[2]?.click()`);
  await waitFor(async () => (await cdp.evaluate(`localStorage.getItem('lumen.reader.aiFontScale')`)) === '1.22', 5_000, "font size persistence");
  await cdp.evaluate(`document.querySelector('.font-chip')?.click()`);
  await cdp.evaluate(`document.querySelector('[aria-label="增大 AI 字号"]')?.click()`);
  await waitFor(async () => (await cdp.evaluate(`localStorage.getItem('lumen.reader.aiFontScale')`)) === '1.32', 5_000, "custom font growth 132");
  await cdp.evaluate(`document.querySelector('[aria-label="增大 AI 字号"]')?.click()`);
  await waitFor(async () => (await cdp.evaluate(`localStorage.getItem('lumen.reader.aiFontScale')`)) === '1.42', 5_000, "custom font growth beyond presets");
  await cdp.evaluate(`document.querySelector('.font-chip')?.click()`);
  const fontAfter = await cdp.evaluate(`parseFloat(getComputedStyle(document.querySelector('.message.assistant')).fontSize)`);
  if (fontAfter <= fontBefore) throw new Error(`AI font did not grow: ${fontBefore} -> ${fontAfter}`);
  metrics.aiFontResize = { before: fontBefore, after: fontAfter, persisted: '1.42' };

  await cdp.evaluate(`(() => { const button = document.querySelector('[aria-label="放大"]'); for (let i = 0; i < 7; i += 1) button?.click(); })()`);
  await waitFor(async () => Number(String(await cdp.evaluate(`document.querySelector('.zoom-label')?.textContent`)).replace('%', '')) > 180, 5_000, "PDF zoom beyond old cap");
  metrics.pdfZoomBeyondOldCap = await cdp.evaluate(`document.querySelector('.zoom-label')?.textContent`);
  await cdp.evaluate(`(() => { const button = document.querySelector('[aria-label="缩小"]'); for (let i = 0; i < 7; i += 1) button?.click(); })()`);

  await cdp.evaluate(`document.querySelector('.provider-chip')?.click()`);
  await waitFor(async () => Number(await cdp.evaluate(`document.querySelectorAll('.provider-menu-item').length`)) === 2, 5_000, "provider menu");
  await cdp.evaluate(`document.querySelectorAll('.provider-menu-item')[0]?.click()`);
  await waitFor(async () => (await cdp.evaluate(`document.querySelector('.provider-chip-label')?.textContent`)) === 'Codex Plan', 5_000, "Codex provider switch");
  metrics.providerSwitch = await cdp.evaluate(`chrome.storage.local.get('lumen.settings').then((result) => result['lumen.settings'].provider)`);
  await cdp.evaluate(`document.querySelector('.provider-chip')?.click()`);
  await cdp.evaluate(`document.querySelectorAll('.provider-menu-item')[1]?.click()`);
  await waitFor(async () => (await cdp.evaluate(`document.querySelector('.provider-chip-label')?.textContent`)) === 'API', 5_000, "API provider switch");
  if (metrics.providerSwitch !== 'codex') throw new Error(`Provider switch was not persisted: ${metrics.providerSwitch}`);
  metrics.mimeHandlerMode = mimeMode;
  await cdp.evaluate(`document.querySelector('.font-chip')?.click()`);
  await waitFor(async () => Number(await cdp.evaluate(`document.querySelectorAll('.font-size-options button').length`)) === 4, 5_000, "README screenshot font reset");
  await cdp.evaluate(`(() => {
    document.querySelectorAll('.font-size-options button')[1]?.click();
    const handle = document.querySelector('.panel-resize-handle');
    handle?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    for (let index = 0; index < 3; index += 1) {
      handle?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    }
  })()`);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
  const capture = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(screenshotPath, Buffer.from(capture.data, "base64"));

  const optionsUrl = `chrome-extension://${extensionId}/options.html`;
  await cdp.evaluate(`chrome.tabs.create({ url: ${JSON.stringify(optionsUrl)} })`);
  await waitFor(async () => (await targets(debugPort)).some((item) => item.type === "page" && item.url === optionsUrl), 10_000, "options tab");
  const optionsTarget = (await targets(debugPort)).find((item) => item.type === "page" && item.url === optionsUrl);
  const optionsCdp = new Cdp(optionsTarget.webSocketDebuggerUrl);
  await optionsCdp.ready;
  await optionsCdp.send("Runtime.enable");
  await optionsCdp.send("Page.enable");
  await optionsCdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  await waitFor(async () => Number(await optionsCdp.evaluate(`document.querySelectorAll('.model-picker').length`)) === 2, 8_000, "model pickers");
  const migratedModels = await optionsCdp.evaluate(`[...document.querySelectorAll('.model-picker > input')].map((input) => input.value)`);
  await optionsCdp.evaluate(`document.querySelector('.model-picker > input')?.click()`);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1200));
  const catalogDiagnostic = await optionsCdp.evaluate(`({ menu: document.querySelector('.model-menu')?.innerText, options: document.querySelectorAll('.model-option').length })`);
  process.stdout.write(`Model catalog diagnostic: ${JSON.stringify(catalogDiagnostic)}\n`);
  await waitFor(async () => Number(await optionsCdp.evaluate(`document.querySelectorAll('.model-option').length`)) === 2, 8_000, "API model catalog");
  const catalogIds = await optionsCdp.evaluate(`[...document.querySelectorAll('.model-option code')].map((item) => item.textContent)`);
  await optionsCdp.evaluate(`[...document.querySelectorAll('.model-option')].find((item) => item.textContent.includes('smoke-summary'))?.click()`);
  await optionsCdp.evaluate(`document.querySelector('.save-button')?.click()`);
  await waitFor(async () => (await optionsCdp.evaluate(`document.querySelector('.save-button')?.textContent`)).includes('已保存'), 5_000, "saved split models");
  const storedModels = await optionsCdp.evaluate(`chrome.storage.local.get('lumen.settings').then((result) => ({ summary: result['lumen.settings'].summaryModel, chat: result['lumen.settings'].chatModel }))`);
  if (migratedModels[0] !== 'smoke-model' || migratedModels[1] !== 'smoke-model' || storedModels.summary !== 'smoke-summary' || storedModels.chat !== 'smoke-model') {
    throw new Error(`Model migration or independent selection failed: ${JSON.stringify({ migratedModels, storedModels })}`);
  }
  metrics.modelPicker = { migratedModels, catalogIds, storedModels };
  await optionsCdp.evaluate(`document.querySelectorAll('.provider-card')[1]?.click()`);
  await waitFor(async () => Number(await optionsCdp.evaluate(`document.querySelectorAll('.codex-tool-list .toggle-row').length`)) === 2, 5_000, "Codex agent tool toggles");
  metrics.codexAgentTools = await optionsCdp.evaluate(`[...document.querySelectorAll('.codex-tool-list .toggle-row')].map((row) => ({ label: row.querySelector('strong')?.textContent, checked: row.querySelector('input')?.checked }))`);
  metrics.permissionProfiles = await optionsCdp.evaluate(`[...document.querySelectorAll('.permission-card')].map((card) => ({ label: card.querySelector('strong')?.textContent, disabled: card.disabled }))`);
  metrics.promptEditors = await optionsCdp.evaluate(`document.querySelectorAll('.prompt-editor').length`);
  if (metrics.permissionProfiles.length !== 3 || metrics.promptEditors !== 10) {
    throw new Error(`Prompt Studio or permission profiles missing: ${JSON.stringify({ profiles: metrics.permissionProfiles, prompts: metrics.promptEditors })}`);
  }
  const optionsScreenshotPath = resolve("work/smoke-model-settings.png");
  const optionsCapture = await optionsCdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(optionsScreenshotPath, Buffer.from(optionsCapture.data, "base64"));
  await optionsCdp.evaluate(`document.querySelectorAll('.settings-card')[2]?.scrollIntoView({ block: 'start' })`);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
  const promptStudioScreenshotPath = resolve("work/smoke-prompt-studio.png");
  const promptStudioCapture = await optionsCdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(promptStudioScreenshotPath, Buffer.from(promptStudioCapture.data, "base64"));
  optionsCdp.close();
  process.stdout.write(`${JSON.stringify({ extensionId, pdf: basename(pdfPath), metrics, screenshotPath, focusScreenshotPath, notesScreenshotPath, optionsScreenshotPath, promptStudioScreenshotPath }, null, 2)}\n`);
  cdp.close();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : error}\n${chromeErrors.slice(-5000)}\n`);
  process.exitCode = 1;
} finally {
  chrome.kill("SIGTERM");
  pdfServer.close();
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
  rmSync(profileDir, { recursive: true, force: true });
}

async function targets(port) {
  return fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
}

async function waitFor(predicate, timeout, label) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeout) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError}` : ""}`);
}
