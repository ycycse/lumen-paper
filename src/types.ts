export type ProviderKind = "compatible" | "codex";
export type ChatMode = "paper" | "research";
export type CodexPermissionMode = "reader" | "agent" | "unrestricted";

export interface LumenSettings {
  provider: ProviderKind;
  endpoint: string;
  apiKey: string;
  summaryModel: string;
  chatModel: string;
  bridgeUrl: string;
  bridgeToken: string;
  codexSummaryModel: string;
  codexChatModel: string;
  codexWebSearch: boolean;
  codexCalculations: boolean;
  codexPermissionMode: CodexPermissionMode;
  codexWorkspace: string;
  chatMode: ChatMode;
  autoOpenPdfs: boolean;
  autoAnalyze: boolean;
  summaryPrompt: string;
  paperSystemPrompt: string;
  researchSystemPrompt: string;
  summaryTemplate: string;
  chatTemplate: string;
  quoteTemplate: string;
  explainTemplate: string;
  translateTemplate: string;
  challengeTemplate: string;
  codexRuntimePrompt: string;
  connectionTestPrompt: string;
  responseLanguage: "zh-CN" | "en" | "auto";
  storeConversations: boolean;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  prompt?: string;
  page?: number;
  quote?: string;
  toolActivity?: AgentToolActivity[];
  runtime?: AgentRuntimeReceipt;
  createdAt: number;
}

export interface AgentToolActivity {
  kind: "web_search" | "calculation";
  count: number;
}

export interface AgentRuntimeReceipt {
  mode: CodexPermissionMode;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  cwd: string;
  userConfigLoaded: boolean;
  rulesLoaded: boolean;
  webSearch: boolean;
}

export interface HighlightRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type HighlightColor = "citron" | "sky" | "coral" | "violet";

export interface Highlight {
  id: string;
  page: number;
  text: string;
  color: HighlightColor;
  rects: HighlightRect[];
  note: string;
  createdAt: number;
}

export interface EvidencePoint {
  claim: string;
  page: number;
}

export interface ReadingStep {
  label: string;
  page: number;
  why: string;
}

export interface PaperSummary {
  title: string;
  verdict: string;
  contributions: string[];
  method: string;
  evidence: EvidencePoint[];
  limitations: string[];
  readingPath: ReadingStep[];
  keywords: string[];
}

export interface PaperState {
  highlights: Highlight[];
  messages: ChatMessage[];
  summary: PaperSummary | null;
}

export interface AiRequest {
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  temperature?: number;
  purpose?: "summary" | "chat";
}

export interface AiResponse {
  ok: boolean;
  content?: string;
  toolActivity?: AgentToolActivity[];
  runtime?: AgentRuntimeReceipt;
  error?: string;
}

export interface ModelOption {
  id: string;
  name?: string;
  description?: string;
  isDefault?: boolean;
}

export interface BridgeInfo {
  version: string;
  protocolVersion: number;
  codex?: string;
}

export interface ModelListRequest {
  provider: ProviderKind;
  endpoint: string;
  apiKey: string;
  bridgeUrl: string;
  bridgeToken: string;
}

export interface ModelListResponse {
  ok: boolean;
  models?: ModelOption[];
  error?: string;
}

export interface BridgeStatusRequest {
  bridgeUrl: string;
  bridgeToken: string;
}

export interface BridgeStatusResponse {
  ok: boolean;
  bridge?: BridgeInfo;
  error?: string;
}

export type RuntimeMessage =
  | { type: "AI_REQUEST"; payload: AiRequest }
  | { type: "LIST_MODELS"; payload: ModelListRequest }
  | { type: "BRIDGE_STATUS"; payload: BridgeStatusRequest }
  | { type: "OPEN_URL"; url?: string }
  | { type: "OPEN_OPTIONS" }
  | { type: "OPEN_NATIVE"; url: string };

declare global {
  interface Window {
    __LUMEN_TEST_PDF__?: ArrayBuffer;
  }
}
