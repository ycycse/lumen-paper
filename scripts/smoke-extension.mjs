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
const bridgeRequestBodies = [];
mkdirSync(resolve("work"), { recursive: true });

if (!existsSync(pdfPath)) throw new Error(`Missing smoke PDF: ${pdfPath}`);
const pdfBytes = readFileSync(pdfPath);
const pdfServer = createServer((request, response) => {
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Lumen-Token",
    });
    response.end();
  } else if (request.url === "/paper.pdf") {
    response.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": pdfBytes.length });
    response.end(pdfBytes);
  } else if (request.url === "/v1/chat/completions" && request.method === "POST") {
    lastApiOrigin = String(request.headers.origin || "");
    response.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    response.end(JSON.stringify({ choices: [{ message: { content: smokeAnswer } }] }));
  } else if (request.url === "/v1/chat" && request.method === "POST") {
    void readJsonBody(request).then((body) => {
      bridgeRequestBodies.push(body);
      response.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      response.end(JSON.stringify({ ok: true, content: smokeAnswer }));
    }).catch((error) => {
      response.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      response.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    });
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

  const summaryRuntimeProbe = await cdp.evaluate(`(async () => {
    const key = 'lumen.settings';
    const stored = await chrome.storage.local.get(key);
    await chrome.storage.local.set({ [key]: {
      ...stored[key],
      provider: 'codex',
      bridgeUrl: ${JSON.stringify(`http://127.0.0.1:${pdfPort}`)},
      bridgeToken: 'smoke-bridge-token',
      codexPermissionMode: 'unrestricted',
      codexWorkspace: '/tmp/must-not-reach-summary'
    } });
    const response = await chrome.runtime.sendMessage({
      type: 'AI_REQUEST',
      payload: {
        system: 'Summary isolation probe',
        messages: [{ role: 'user', content: 'Summarize safely.' }],
        purpose: 'summary'
      }
    });
    await chrome.storage.local.set({ [key]: stored[key] });
    return response;
  })()`);
  await waitFor(() => bridgeRequestBodies.length === 1, 5_000, "summary Reader request body");
  const summaryAgent = bridgeRequestBodies[0]?.agent;
  if (
    !summaryRuntimeProbe?.ok
    || summaryAgent?.mode !== "reader"
    || Object.prototype.hasOwnProperty.call(summaryAgent || {}, "workspace")
  ) {
    throw new Error(`Automatic summary escaped Reader isolation: ${JSON.stringify({ response: summaryRuntimeProbe, agent: summaryAgent })}`);
  }

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
  metrics.summaryRuntime = { mode: summaryAgent.mode, workspaceSent: false };
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
    const spans = [...document.querySelectorAll('.textLayer span')]
      .filter((span) => span.textContent?.trim());
    if (!spans.length) return false;
    const abstractStart = spans.findIndex((span) => span.textContent?.includes('AI agents encounter'));
    const startIndex = abstractStart >= 0 ? abstractStart : 0;
    const startSpan = spans[startIndex];
    const endSpan = spans[Math.min(spans.length - 1, startIndex + 3)];
    const startNode = startSpan.firstChild;
    const endNode = endSpan.firstChild;
    if (!(startNode instanceof Text) || !(endNode instanceof Text)) return false;
    window.__lumenSmokeSelectedSpans = spans.slice(startIndex, startIndex + 4);
    const selection = getSelection();
    const range = document.createRange();
    range.setStart(startNode, Math.min(3, Math.max(0, startNode.data.length - 1)));
    range.setEnd(endNode, Math.max(1, endNode.data.length - 4));
    window.__lumenSmokeSelectionRange = range.cloneRange();
    selection.removeAllRanges();
    selection.addRange(range);
    startSpan.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 420, clientY: 180 }));
    return true;
  })()`);
  await waitFor(async () => Boolean(await cdp.evaluate(`Boolean(document.querySelector('.selection-popover'))`)), 5_000, "selection toolbar");
  await cdp.evaluate(`document.querySelector('.highlight-control > button')?.click()`);
  await waitFor(async () => Number(await cdp.evaluate(`document.querySelectorAll('.saved-highlight').length`)) > 0, 5_000, "saved highlight overlay");
  await waitFor(
    async () => Boolean(await cdp.evaluate(`[
      ...document.querySelectorAll('.saved-highlight')
    ].every((highlight) => highlight.dataset.inkAligned === 'true')`)),
    5_000,
    "canvas-aligned highlight overlay",
  );
  metrics.selectionToolbar = true;
  metrics.savedHighlights = await cdp.evaluate(`document.querySelectorAll('.saved-highlight').length`);
  metrics.savedHighlightVisual = await cdp.evaluate(`(() => {
    const highlights = [...document.querySelectorAll('.saved-highlight')];
    const highlight = highlights[0];
    if (!highlight) return null;
    const style = getComputedStyle(highlight);
    const alphaValues = [...style.backgroundImage.matchAll(/rgba?\\(([^)]+)\\)/g)]
      .map((match) => Number(match[1].split(',').at(-1)?.trim()))
      .filter(Number.isFinite);
    const originalClassName = highlight.className;
    const palette = Object.fromEntries(['citron', 'sky', 'coral', 'violet'].map((color) => {
      highlight.className = 'saved-highlight ' + color;
      return [color, getComputedStyle(highlight).getPropertyValue('--highlight-ink').trim()];
    }));
    highlight.className = originalClassName;
    const selectedTextRects = (window.__lumenSmokeSelectedSpans || []).flatMap((span) => {
      const selectionRange = window.__lumenSmokeSelectionRange;
      const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
      const rects = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!selectionRange?.intersectsNode(node)) continue;
        const selectedStart = selectionRange.startContainer === node ? selectionRange.startOffset : 0;
        const selectedEnd = selectionRange.endContainer === node ? selectionRange.endOffset : node.data.length;
        const selectedText = node.data.slice(selectedStart, selectedEnd);
        const leading = selectedText.match(/^[\\s\\u200B\\uFEFF]+/u)?.[0].length ?? 0;
        const trailing = selectedText.match(/[\\s\\u200B\\uFEFF]+$/u)?.[0].length ?? 0;
        if (selectedStart + leading >= selectedEnd - trailing) continue;
        const range = document.createRange();
        range.setStart(node, selectedStart + leading);
        range.setEnd(node, selectedEnd - trailing);
        rects.push(...range.getClientRects());
      }
      return rects;
    });
    const canvasInkBounds = (item, left, top, right, bottom) => {
      const canvas = item.closest('.pdf-page')?.querySelector('canvas');
      const context = canvas?.getContext('2d');
      const canvasRect = canvas?.getBoundingClientRect();
      if (!canvas || !context || !canvasRect?.width || !canvasRect.height) return null;
      const scaleX = canvas.width / canvasRect.width;
      const scaleY = canvas.height / canvasRect.height;
      const x = Math.max(0, Math.floor((left - canvasRect.left) * scaleX));
      const y = Math.max(0, Math.floor((top - canvasRect.top) * scaleY));
      const endX = Math.min(canvas.width, Math.ceil((right - canvasRect.left) * scaleX));
      const endY = Math.min(canvas.height, Math.ceil((bottom - canvasRect.top) * scaleY));
      const width = endX - x;
      const height = endY - y;
      if (width <= 0 || height <= 0) return null;
      const pixels = context.getImageData(x, y, width, height).data;
      let first = width;
      let last = -1;
      for (let pixelY = 0; pixelY < height; pixelY += 1) {
        for (let pixelX = 0; pixelX < width; pixelX += 1) {
          const offset = (pixelY * width + pixelX) * 4;
          if (
            pixels[offset + 3] > 0 &&
            pixels[offset] < 180 &&
            pixels[offset + 1] < 180 &&
            pixels[offset + 2] < 180
          ) {
            first = Math.min(first, pixelX);
            last = Math.max(last, pixelX);
          }
        }
      }
      if (last < 0) return null;
      return {
        left: canvasRect.left + (x + first) / scaleX,
        right: canvasRect.left + (x + last + 1) / scaleX,
      };
    };
    const edgeMeasurements = highlights.map((item) => {
      const rect = item.getBoundingClientRect();
      const matchingText = selectedTextRects.filter((textRect) => {
        const verticalOverlap = Math.min(rect.bottom, textRect.bottom) - Math.max(rect.top, textRect.top);
        return verticalOverlap >= Math.min(rect.height, textRect.height) * .5 &&
          textRect.right >= rect.left - 2 && textRect.left <= rect.right + 2;
      });
      if (!matchingText.length) return null;
      const textLeft = Math.min(...matchingText.map((textRect) => textRect.left));
      const textTop = Math.min(...matchingText.map((textRect) => textRect.top));
      const textRight = Math.max(...matchingText.map((textRect) => textRect.right));
      const textBottom = Math.max(...matchingText.map((textRect) => textRect.bottom));
      const ink = canvasInkBounds(item, textLeft, textTop, textRight, textBottom);
      return {
        overhang: Math.max(0, textLeft - rect.left, rect.right - textRight),
        inset: Math.max(0, rect.left - textLeft, textRight - rect.right),
        leftInkOverhang: ink ? Math.max(0, ink.left - rect.left) : null,
        rightInkOverhang: ink ? Math.max(0, rect.right - ink.right) : null,
        leftInkInset: ink ? Math.max(0, rect.left - ink.left) : null,
        rightInkInset: ink ? Math.max(0, ink.right - rect.right) : null,
      };
    }).filter(Boolean);
    return {
      gradient: style.backgroundImage.includes('linear-gradient'),
      solidFill: style.backgroundColor,
      blend: style.mixBlendMode,
      ink: style.getPropertyValue('--highlight-ink').trim(),
      maxAlpha: alphaValues.length ? Math.max(...alphaValues) : null,
      palette,
      maxHorizontalOverhang: edgeMeasurements.length
        ? Math.max(...edgeMeasurements.map((measurement) => measurement.overhang))
        : null,
      maxHorizontalInset: edgeMeasurements.length
        ? Math.max(...edgeMeasurements.map((measurement) => measurement.inset))
        : null,
      maxLeftInkOverhang: edgeMeasurements.some((measurement) => measurement.leftInkOverhang !== null)
        ? Math.max(...edgeMeasurements.map((measurement) => measurement.leftInkOverhang ?? 0))
        : null,
      maxRightInkOverhang: edgeMeasurements.some((measurement) => measurement.rightInkOverhang !== null)
        ? Math.max(...edgeMeasurements.map((measurement) => measurement.rightInkOverhang ?? 0))
        : null,
      maxLeftInkInset: edgeMeasurements.some((measurement) => measurement.leftInkInset !== null)
        ? Math.max(...edgeMeasurements.map((measurement) => measurement.leftInkInset ?? 0))
        : null,
      maxRightInkInset: edgeMeasurements.some((measurement) => measurement.rightInkInset !== null)
        ? Math.max(...edgeMeasurements.map((measurement) => measurement.rightInkInset ?? 0))
        : null,
    };
  })()`);
  if (
    metrics.savedHighlights < 3 ||
    !metrics.savedHighlightVisual?.gradient ||
    metrics.savedHighlightVisual.solidFill !== "rgba(0, 0, 0, 0)" ||
    metrics.savedHighlightVisual.blend !== "multiply" ||
    metrics.savedHighlightVisual.ink !== "192, 207, 115" ||
    metrics.savedHighlightVisual.maxAlpha === null ||
    metrics.savedHighlightVisual.maxAlpha > .3 ||
    metrics.savedHighlightVisual.maxHorizontalOverhang === null ||
    metrics.savedHighlightVisual.maxHorizontalOverhang > .5 ||
    metrics.savedHighlightVisual.maxHorizontalInset === null ||
    metrics.savedHighlightVisual.maxHorizontalInset > 30 ||
    metrics.savedHighlightVisual.maxLeftInkOverhang === null ||
    metrics.savedHighlightVisual.maxLeftInkOverhang > 1.5 ||
    metrics.savedHighlightVisual.maxRightInkOverhang === null ||
    metrics.savedHighlightVisual.maxRightInkOverhang > 1.5 ||
    metrics.savedHighlightVisual.maxLeftInkInset === null ||
    metrics.savedHighlightVisual.maxLeftInkInset > 2 ||
    metrics.savedHighlightVisual.maxRightInkInset === null ||
    metrics.savedHighlightVisual.maxRightInkInset > 2 ||
    JSON.stringify(metrics.savedHighlightVisual.palette) !== JSON.stringify({
      citron: "192, 207, 115",
      sky: "120, 173, 191",
      coral: "214, 146, 128",
      violet: "158, 143, 189",
    })
  ) {
    throw new Error(`Saved highlight visual failed: ${JSON.stringify({
      rects: metrics.savedHighlights,
      visual: metrics.savedHighlightVisual,
    })}`);
  }

  await cdp.evaluate(`(() => {
    const button = document.querySelector('[aria-label="缩小"]');
    for (let index = 0; index < 4; index += 1) button?.click();
  })()`);
  await waitFor(async () => (await cdp.evaluate(`document.querySelector('.zoom-label')?.textContent`)) === '72%', 5_000, "72% PDF zoom");
  await waitFor(
    async () => Boolean(await cdp.evaluate(`[
      ...document.querySelectorAll('.textLayer span')
    ].some((candidate) => candidate.textContent?.includes('run, and discard'))`)),
    5_000,
    "72% text layer",
  );
  const narrowSelectionStarted = await cdp.evaluate(`(() => {
    const span = [...document.querySelectorAll('.textLayer span')]
      .find((candidate) => candidate.textContent?.includes('run, and discard'));
    const node = span?.firstChild;
    if (!(node instanceof Text)) return false;
    const offset = node.data.indexOf(',');
    if (offset < 0) return false;
    const range = document.createRange();
    range.setStart(node, offset);
    range.setEnd(node, offset + 1);
    window.__lumenSmokeNarrowRange = range.cloneRange();
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    span.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 420, clientY: 180 }));
    return true;
  })()`);
  if (!narrowSelectionStarted) throw new Error("Could not create narrow punctuation selection");
  await waitFor(async () => Boolean(await cdp.evaluate(`Boolean(document.querySelector('.selection-popover'))`)), 5_000, "narrow selection toolbar");
  await cdp.evaluate(`document.querySelector('.highlight-control > button')?.click()`);
  await waitFor(
    async () => Number(await cdp.evaluate(`document.querySelectorAll('.saved-highlight').length`)) > metrics.savedHighlights,
    5_000,
    "narrow saved highlight",
  );
  await waitFor(
    async () => Boolean(await cdp.evaluate(`[
      ...document.querySelectorAll('.saved-highlight')
    ].every((highlight) => highlight.dataset.inkAligned === 'true')`)),
    5_000,
    "canvas-aligned narrow highlight",
  );
  metrics.narrowHighlight = await cdp.evaluate(`(() => {
    const highlight = [...document.querySelectorAll('.saved-highlight')].at(-1);
    const expected = window.__lumenSmokeNarrowRange?.getBoundingClientRect();
    const actual = highlight?.getBoundingClientRect();
    if (!expected || !actual) return null;
    return {
      expectedWidth: expected.width,
      actualWidth: actual.width,
      retainedRatio: actual.width / expected.width,
      overhang: Math.max(0, expected.left - actual.left, actual.right - expected.right),
    };
  })()`);
  if (
    !metrics.narrowHighlight ||
    metrics.narrowHighlight.expectedWidth > 5 ||
    metrics.narrowHighlight.actualWidth <= .5 ||
    metrics.narrowHighlight.retainedRatio < .72 ||
    metrics.narrowHighlight.retainedRatio > 1 ||
    metrics.narrowHighlight.overhang > .5
  ) {
    throw new Error(`Narrow highlight failed: ${JSON.stringify(metrics.narrowHighlight)}`);
  }
  await cdp.evaluate(`(() => {
    const button = document.querySelector('[aria-label="放大"]');
    for (let index = 0; index < 4; index += 1) button?.click();
  })()`);
  await waitFor(async () => (await cdp.evaluate(`document.querySelector('.zoom-label')?.textContent`)) === '112%', 5_000, "restore PDF zoom");

  await cdp.evaluate(`document.querySelectorAll('.panel-tabs button')[2]?.click()`);
  await waitFor(async () => Number(await cdp.evaluate(`document.querySelectorAll('.note-card').length`)) === 2, 5_000, "notes tab after highlights");
  await cdp.evaluate(`document.querySelectorAll('.note-card .delete-note')[1]?.click()`);
  await waitFor(async () => Number(await cdp.evaluate(`document.querySelectorAll('.note-card').length`)) === 1, 5_000, "remove narrow smoke highlight");
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
  await optionsCdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1250, deviceScaleFactor: 1, mobile: false });
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
  metrics.bridgeService = await optionsCdp.evaluate(`(() => {
    const setup = document.querySelector('.codex-setup');
    const serviceCommands = [...document.querySelectorAll('.bridge-service code')].map((item) => item.textContent?.trim());
    const copy = setup?.textContent || '';
    return {
      serviceCommands,
      hasAgentStartCommand: /lumen-paper-bridge\\s+agent/.test(copy),
      hasFullStartCommand: /lumen-paper-bridge\\s+full/.test(copy),
      hasLegacyPackageCommand: /bridge:(agent|full)/.test(copy)
    };
  })()`);
  if (
    metrics.bridgeService.serviceCommands.length !== 1 ||
    metrics.bridgeService.serviceCommands[0] !== '~/.local/bin/lumen-paper-bridge start' ||
    metrics.bridgeService.hasAgentStartCommand ||
    metrics.bridgeService.hasFullStartCommand ||
    metrics.bridgeService.hasLegacyPackageCommand
  ) {
    throw new Error(`Single Bridge start contract failed: ${JSON.stringify(metrics.bridgeService)}`);
  }
  metrics.permissionModes = await optionsCdp.evaluate(`[...document.querySelectorAll('.permission-card')].map((card) => ({ label: card.querySelector('strong')?.textContent, disabled: card.disabled }))`);
  await optionsCdp.evaluate(`document.querySelectorAll('.permission-card')[1]?.click()`);
  await waitFor(async () => Boolean(await optionsCdp.evaluate(`Boolean(document.querySelector('.codex-workspace input'))`)), 5_000, "Agent workspace input");
  await optionsCdp.evaluate(`(() => {
    const input = document.querySelector('.codex-workspace input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!input || !setter) return false;
    setter.call(input, '/tmp/lumen-workspace');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await optionsCdp.evaluate(`document.querySelector('.save-button')?.click()`);
  await waitFor(async () => (await optionsCdp.evaluate(`document.querySelector('.save-button')?.textContent`)).includes('已保存'), 5_000, "saved Agent workspace");
  metrics.agentWorkspace = await optionsCdp.evaluate(`chrome.storage.local.get('lumen.settings').then((result) => ({ mode: result['lumen.settings'].codexPermissionMode, workspace: result['lumen.settings'].codexWorkspace }))`);
  if (metrics.agentWorkspace.mode !== 'agent' || metrics.agentWorkspace.workspace !== '/tmp/lumen-workspace') {
    throw new Error(`Agent workspace was not persisted: ${JSON.stringify(metrics.agentWorkspace)}`);
  }
  metrics.promptEditors = await optionsCdp.evaluate(`document.querySelectorAll('.prompt-editor').length`);
  if (metrics.permissionModes.length !== 3 || metrics.promptEditors !== 10) {
    throw new Error(`Prompt Studio or permission modes missing: ${JSON.stringify({ modes: metrics.permissionModes, prompts: metrics.promptEditors })}`);
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

function readJsonBody(request) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try { resolvePromise(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch (error) { reject(error); }
    });
    request.on("error", reject);
  });
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
