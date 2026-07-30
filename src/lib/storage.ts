import type { LumenSettings, PaperState } from "../types";
import {
  DEFAULT_CHALLENGE_TEMPLATE,
  DEFAULT_CHAT_TEMPLATE,
  DEFAULT_CODEX_RUNTIME_PROMPT,
  DEFAULT_CONNECTION_TEST_PROMPT,
  DEFAULT_EXPLAIN_TEMPLATE,
  DEFAULT_PAPER_SYSTEM_PROMPT,
  DEFAULT_QUOTE_TEMPLATE,
  DEFAULT_RESEARCH_SYSTEM_PROMPT,
  DEFAULT_SUMMARY_INSTRUCTIONS,
  DEFAULT_SUMMARY_TEMPLATE,
  DEFAULT_TRANSLATE_TEMPLATE,
} from "./prompts";

export const SETTINGS_KEY = "lumen.settings";

export const DEFAULT_SETTINGS: LumenSettings = {
  provider: "compatible",
  endpoint: "https://api.openai.com/v1/chat/completions",
  apiKey: "",
  summaryModel: "gpt-5.4-mini",
  chatModel: "gpt-5.4-mini",
  bridgeUrl: "http://127.0.0.1:43177",
  bridgeToken: "",
  codexSummaryModel: "",
  codexChatModel: "",
  codexWebSearch: true,
  codexCalculations: true,
  codexPermissionMode: "reader",
  codexWorkspace: "",
  chatMode: "research",
  autoOpenPdfs: true,
  autoAnalyze: true,
  summaryPrompt: DEFAULT_SUMMARY_INSTRUCTIONS,
  paperSystemPrompt: DEFAULT_PAPER_SYSTEM_PROMPT,
  researchSystemPrompt: DEFAULT_RESEARCH_SYSTEM_PROMPT,
  summaryTemplate: DEFAULT_SUMMARY_TEMPLATE,
  chatTemplate: DEFAULT_CHAT_TEMPLATE,
  quoteTemplate: DEFAULT_QUOTE_TEMPLATE,
  explainTemplate: DEFAULT_EXPLAIN_TEMPLATE,
  translateTemplate: DEFAULT_TRANSLATE_TEMPLATE,
  challengeTemplate: DEFAULT_CHALLENGE_TEMPLATE,
  codexRuntimePrompt: DEFAULT_CODEX_RUNTIME_PROMPT,
  connectionTestPrompt: DEFAULT_CONNECTION_TEST_PROMPT,
  responseLanguage: "zh-CN",
  storeConversations: true,
};

export const EMPTY_PAPER_STATE: PaperState = {
  highlights: [],
  messages: [],
  summary: null,
};

function hasChromeStorage(): boolean {
  return typeof chrome !== "undefined" && Boolean(chrome.storage?.local);
}

export async function getSettings(): Promise<LumenSettings> {
  if (!hasChromeStorage()) return DEFAULT_SETTINGS;
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(result[SETTINGS_KEY]);
}

export function normalizeSettings(value: unknown): LumenSettings {
  const stored = value && typeof value === "object"
    ? value as Partial<LumenSettings> & { model?: unknown; codexModel?: unknown }
    : {};
  const { model: legacyModel, codexModel: legacyCodexModel, ...current } = stored;
  const apiFallback = typeof legacyModel === "string" && legacyModel ? legacyModel : DEFAULT_SETTINGS.summaryModel;
  const codexFallback = typeof legacyCodexModel === "string" ? legacyCodexModel : "";
  return {
    ...DEFAULT_SETTINGS,
    ...current,
    summaryModel: current.summaryModel || apiFallback,
    chatModel: current.chatModel || apiFallback,
    codexSummaryModel: current.codexSummaryModel ?? codexFallback,
    codexChatModel: current.codexChatModel ?? codexFallback,
    codexPermissionMode: ["reader", "agent", "unrestricted"].includes(String(current.codexPermissionMode))
      ? current.codexPermissionMode as LumenSettings["codexPermissionMode"]
      : DEFAULT_SETTINGS.codexPermissionMode,
    codexWorkspace: typeof current.codexWorkspace === "string"
      ? current.codexWorkspace
      : DEFAULT_SETTINGS.codexWorkspace,
    chatMode: current.chatMode === "paper" ? "paper" : DEFAULT_SETTINGS.chatMode,
    summaryPrompt: current.summaryPrompt ?? DEFAULT_SETTINGS.summaryPrompt,
    paperSystemPrompt: current.paperSystemPrompt ?? DEFAULT_SETTINGS.paperSystemPrompt,
    researchSystemPrompt: current.researchSystemPrompt ?? DEFAULT_SETTINGS.researchSystemPrompt,
    summaryTemplate: current.summaryTemplate ?? DEFAULT_SETTINGS.summaryTemplate,
    chatTemplate: current.chatTemplate ?? DEFAULT_SETTINGS.chatTemplate,
    quoteTemplate: current.quoteTemplate ?? DEFAULT_SETTINGS.quoteTemplate,
    explainTemplate: current.explainTemplate ?? DEFAULT_SETTINGS.explainTemplate,
    translateTemplate: current.translateTemplate ?? DEFAULT_SETTINGS.translateTemplate,
    challengeTemplate: current.challengeTemplate ?? DEFAULT_SETTINGS.challengeTemplate,
    codexRuntimePrompt: current.codexRuntimePrompt ?? DEFAULT_SETTINGS.codexRuntimePrompt,
    connectionTestPrompt: current.connectionTestPrompt ?? DEFAULT_SETTINGS.connectionTestPrompt,
  };
}

export async function saveSettings(settings: LumenSettings): Promise<void> {
  if (!hasChromeStorage()) return;
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

export async function getPaperState(documentId: string): Promise<PaperState> {
  if (!hasChromeStorage()) return EMPTY_PAPER_STATE;
  const key = `lumen.paper.${documentId}`;
  const result = await chrome.storage.local.get(key);
  return { ...EMPTY_PAPER_STATE, ...(result[key] ?? {}) };
}

export async function savePaperState(documentId: string, state: PaperState): Promise<void> {
  if (!hasChromeStorage()) return;
  await chrome.storage.local.set({ [ `lumen.paper.${documentId}` ]: state });
}

export async function makeDocumentId(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .slice(0, 12)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function settingsAreReady(settings: LumenSettings): boolean {
  if (settings.provider === "codex") {
    return Boolean(settings.bridgeUrl && settings.bridgeToken);
  }
  return Boolean(settings.endpoint && settings.summaryModel && settings.chatModel && settings.apiKey);
}
