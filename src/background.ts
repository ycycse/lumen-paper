import type { AiRequest, AiResponse, BridgeInfo, BridgeStatusRequest, BridgeStatusResponse, ModelListRequest, ModelListResponse, RuntimeMessage } from "./types";
import { DEFAULT_SETTINGS, getSettings, SETTINGS_KEY } from "./lib/storage";
import { sourceFaviconUrl } from "./lib/favicon";
import { modelsEndpoint, normalizeModelOptions } from "./lib/models";
import { codexRuntimePrompt } from "./lib/prompts";

const PDF_CONTENT_TYPE = /(?:^|;)\s*application\/pdf(?:;|$)/i;
const redirectingTabs = new Set<number>();

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  if (!stored[SETTINGS_KEY]) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
  }
});

chrome.runtime.onMessage.addListener(
  (message: RuntimeMessage, sender, sendResponse: (response: unknown) => void) => {
    void handleMessage(message, sender)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: humanError(error) }));
    return true;
  },
);

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "open-lumen") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await openInLumen(tab?.id, tab?.url);
});

// Chrome 151+ routes PDFs through mime_types_handler. Chrome 150 and earlier
// use this header observer as a graceful fallback for top-level GET requests.
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if ((chrome as typeof chrome & { mimeHandler?: unknown }).mimeHandler) return;
    if (details.tabId < 0 || details.type !== "main_frame" || details.method !== "GET") return;
    if (redirectingTabs.has(details.tabId)) return;
    const contentType = details.responseHeaders?.find(
      (header) => header.name.toLowerCase() === "content-type",
    )?.value;
    if (!contentType || !PDF_CONTENT_TYPE.test(contentType)) return;

    void maybeRedirectPdf(details.tabId, details.url);
  },
  { urls: ["http://*/*", "https://*/*", "file:///*"], types: ["main_frame"] },
  ["responseHeaders"],
);

async function handleMessage(message: RuntimeMessage, sender: chrome.runtime.MessageSender) {
  switch (message.type) {
    case "AI_REQUEST":
      return callAi(message.payload);
    case "LIST_MODELS":
      return listModels(message.payload);
    case "BRIDGE_STATUS":
      return readBridgeStatus(message.payload);
    case "OPEN_URL":
      await openInLumen(sender.tab?.id, message.url ?? sender.tab?.url);
      return { ok: true };
    case "OPEN_OPTIONS":
      await chrome.runtime.openOptionsPage();
      return { ok: true };
    case "OPEN_NATIVE": {
      const tabId = sender.tab?.id;
      if (tabId == null) throw new Error("找不到当前标签页");
      await chrome.storage.session.set({ [`lumen.nativeOnce.${tabId}`]: message.url });
      await chrome.tabs.update(tabId, { url: message.url });
      return { ok: true };
    }
  }
}

async function maybeRedirectPdf(tabId: number, url: string): Promise<void> {
  const settings = await getSettings();
  if (!settings.autoOpenPdfs) return;

  const nativeKey = `lumen.nativeOnce.${tabId}`;
  const nativeOnce = await chrome.storage.session.get(nativeKey);
  if (nativeOnce[nativeKey] === url) {
    await chrome.storage.session.remove(nativeKey);
    return;
  }
  await openInLumen(tabId, url, true);
}

async function openInLumen(tabId?: number, url?: string, fallback = false): Promise<void> {
  const query = new URLSearchParams();
  if (url && /^(https?|file):/i.test(url)) query.set("source", url);
  if (fallback) query.set("fallback", "1");
  if (tabId != null && url) {
    const currentTab = await chrome.tabs.get(tabId).catch(() => null);
    const favicon = sourceFaviconUrl(currentTab?.favIconUrl, url, currentTab?.url);
    if (favicon) query.set("favicon", favicon);
  } else {
    const favicon = sourceFaviconUrl(null, url);
    if (favicon) query.set("favicon", favicon);
  }
  const viewerUrl = chrome.runtime.getURL(`viewer.html?${query.toString()}`);
  if (tabId == null) {
    await chrome.tabs.create({ url: viewerUrl });
    return;
  }

  redirectingTabs.add(tabId);
  try {
    await chrome.tabs.update(tabId, { url: viewerUrl });
  } finally {
    setTimeout(() => redirectingTabs.delete(tabId), 1200);
  }
}

async function callAi(request: AiRequest): Promise<AiResponse> {
  const settings = await getSettings();
  if (settings.provider === "codex") return callCodexBridge(request, settings);
  return callCompatibleApi(request, settings);
}

async function callCompatibleApi(
  request: AiRequest,
  settings: Awaited<ReturnType<typeof getSettings>>,
): Promise<AiResponse> {
  const model = request.purpose === "summary" ? settings.summaryModel : settings.chatModel;
  if (!settings.endpoint || !model || !settings.apiKey) {
    return { ok: false, error: "请先在设置中填写 API endpoint、总结模型、聊天模型和 API key。" };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch(settings.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: request.system }, ...request.messages],
        temperature: request.temperature ?? 0.2,
      }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = data?.error?.message || data?.message || response.statusText;
      return { ok: false, error: `API ${response.status}: ${detail}` };
    }
    const content = normalizeContent(data?.choices?.[0]?.message?.content);
    return content ? { ok: true, content } : { ok: false, error: "API 返回中没有 message content。" };
  } catch (error) {
    return { ok: false, error: humanError(error) };
  } finally {
    clearTimeout(timeout);
  }
}

async function callCodexBridge(
  request: AiRequest,
  settings: Awaited<ReturnType<typeof getSettings>>,
): Promise<AiResponse> {
  if (!settings.bridgeUrl || !settings.bridgeToken) {
    return { ok: false, error: "请先启动 Codex bridge，并在设置中粘贴 pairing token。" };
  }
  const url = `${settings.bridgeUrl.replace(/\/$/, "")}/v1/chat`;
  const model = request.purpose === "summary" ? settings.codexSummaryModel : settings.codexChatModel;
  const mode = request.purpose === "summary" ? "reader" : settings.codexPermissionMode;
  const workspace = mode === "reader" ? "" : settings.codexWorkspace.trim();
  if (mode !== "reader" && !workspace.startsWith("/")) {
    return { ok: false, error: "Agent 和 Full Agent 需要在设置中填写绝对 workspace 路径。" };
  }
  const controller = new AbortController();
  const timeoutMs = mode === "reader" ? 210_000 : mode === "agent" ? 660_000 : 960_000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Lumen-Token": settings.bridgeToken,
      },
      body: JSON.stringify({
        ...request,
        model: model || undefined,
        agent: {
          mode,
          workspace: mode === "reader" ? undefined : workspace,
          runtimePrompt: codexRuntimePrompt(
            settings.codexRuntimePrompt,
            settings.codexWebSearch,
            settings.codexCalculations,
          ),
        },
        tools: {
          webSearch: settings.codexWebSearch,
          calculations: settings.codexCalculations,
        },
      }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      const rawError = String(data.error || "");
      const detail = legacyBridgeProfileError(rawError)
        ? "本机 Bridge 版本过旧。请重新运行设置页的安装命令；若旧 Bridge 仍占用终端，只需先 Ctrl-C 一次，再运行 lumen-paper-bridge start。"
        : bridgeResponseError(response.status, rawError) || `Codex bridge ${response.status}`;
      const error = response.status === 429
        ? "Codex 当前队列已满，请等待正在进行的解读完成后再试。"
        : detail;
      return { ok: false, error };
    }
    return {
      ok: true,
      content: String(data.content || ""),
      toolActivity: Array.isArray(data.toolActivity) ? data.toolActivity : undefined,
      runtime: data.runtime && typeof data.runtime === "object" ? data.runtime : undefined,
    };
  } catch (error) {
    return { ok: false, error: `无法连接 Codex bridge：${humanError(error)}` };
  } finally {
    clearTimeout(timeout);
  }
}

function legacyBridgeProfileError(value: string): boolean {
  return /(?:Agent mode|Full Agent) is locked|npm run bridge:(?:agent|full)/i.test(value);
}

async function listModels(request: ModelListRequest): Promise<ModelListResponse> {
  if (request.provider === "codex") return listCodexModels(request);
  if (!request.endpoint) return { ok: false, error: "请先填写 API endpoint。" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(modelsEndpoint(request.endpoint), {
      headers: request.apiKey ? { Authorization: `Bearer ${request.apiKey}` } : {},
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = data?.error?.message || data?.message || response.statusText;
      return { ok: false, error: `模型列表 ${response.status}: ${detail}` };
    }
    const models = normalizeModelOptions(data);
    return models.length
      ? { ok: true, models }
      : { ok: false, error: "接口没有返回可选模型，可继续手动输入。" };
  } catch (error) {
    return { ok: false, error: `无法读取模型列表：${humanError(error)}` };
  } finally {
    clearTimeout(timeout);
  }
}

async function listCodexModels(request: ModelListRequest): Promise<ModelListResponse> {
  if (!request.bridgeUrl || !request.bridgeToken) {
    return { ok: false, error: "请先启动 Bridge 并填写 pairing token。" };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const baseUrl = request.bridgeUrl.replace(/\/$/, "");
    const headers = { "X-Lumen-Token": request.bridgeToken };
    const response = await fetch(`${baseUrl}/v1/models`, {
      headers,
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      const rawError = String(data.error || "");
      return { ok: false, error: bridgeResponseError(response.status, rawError) || `Bridge ${response.status}` };
    }
    const models = normalizeModelOptions({ data: data.models });
    return models.length
      ? { ok: true, models }
      : { ok: false, error: "Codex 没有返回可选模型，可留空使用当前默认模型。" };
  } catch (error) {
    return { ok: false, error: `无法连接 Codex Bridge：${humanError(error)}` };
  } finally {
    clearTimeout(timeout);
  }
}

async function readBridgeStatus(request: BridgeStatusRequest): Promise<BridgeStatusResponse> {
  if (!request.bridgeUrl || !request.bridgeToken) {
    return { ok: false, error: "请先启动 Bridge 并填写 pairing token。" };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${request.bridgeUrl.replace(/\/$/, "")}/health`, {
      headers: { "X-Lumen-Token": request.bridgeToken },
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      const rawError = String(data.error || "");
      return { ok: false, error: bridgeResponseError(response.status, rawError) || `Bridge ${response.status}` };
    }
    const bridge = normalizeBridgeInfo(data);
    return bridge ? { ok: true, bridge } : { ok: false, error: "Bridge 没有返回有效版本信息。" };
  } catch (error) {
    return { ok: false, error: `无法读取 Bridge 状态：${humanError(error)}` };
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeBridgeInfo(value: unknown): BridgeInfo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as { version?: unknown; protocolVersion?: unknown; codex?: unknown };
  if (typeof candidate.version !== "string" || !Number.isInteger(candidate.protocolVersion)) return undefined;
  return {
    version: candidate.version,
    protocolVersion: candidate.protocolVersion as number,
    codex: typeof candidate.codex === "string" ? candidate.codex : undefined,
  };
}

function bridgeResponseError(status: number, rawError: string): string {
  if (status === 403 && /origin denied/i.test(rawError)) {
    return "当前 Bridge 不接受这份扩展。请重新运行设置页上方的安装命令更新 Bridge；pairing token 会保留。";
  }
  if (status === 401 && /invalid pairing token/i.test(rawError)) {
    return "Pairing token 无效，请运行 lumen-paper-bridge pair 后重新粘贴。";
  }
  return rawError;
}

function normalizeContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => (typeof item === "string" ? item : typeof item?.text === "string" ? item.text : ""))
      .join("");
  }
  return "";
}

function humanError(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "请求超时";
  if (error instanceof Error) return error.message;
  return String(error);
}
