import {
  ArrowLeft,
  BookOpen,
  Calculator,
  Check,
  ChevronDown,
  ExternalLink,
  FileText,
  Focus,
  Highlighter,
  Languages,
  LoaderCircle,
  MessageCircle,
  Minus,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Search,
  Send,
  Settings,
  ShieldQuestion,
  Sparkles,
  Terminal,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { getDocument, TextLayer } from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist/types/src/display/api";
import { normalizeMathDelimiters } from "../lib/markdown";
import { chatPrompt, chatSystemPrompt, selectionPrompt, summaryPrompt } from "../lib/prompts";
import {
  citationMarkdown,
  hasRelevantPaperContext,
  normalizePageText,
  parseSummary,
  rankRelevantPages,
  selectSummaryPages,
  type PageText,
} from "../lib/paper";
import { getCachedPdf, putCachedPdf, putCachedPdfIndex } from "../lib/pdf-cache";
import { sourceFaviconUrl } from "../lib/favicon";
import {
  EMPTY_PAPER_STATE,
  getPaperState,
  getSettings,
  makeDocumentId,
  savePaperState,
  saveSettings,
  settingsAreReady,
} from "../lib/storage";
import type {
  AiRequest,
  AiResponse,
  ChatMessage,
  Highlight,
  HighlightColor,
  LumenSettings,
  PaperState,
  ProviderKind,
} from "../types";

type PanelTab = "overview" | "chat" | "notes";
type LoadState = "idle" | "loading" | "ready" | "error";
type ReadingWidthMode = "comfortable" | "wide" | "full";
type ReadingFontMode = "system" | "serif" | "custom";
const DEFAULT_PANEL_WIDTH = 396;
const PANEL_WIDTH_KEY = "lumen.reader.panelWidth";
const DEFAULT_AI_FONT_SCALE = 1.1;
const AI_FONT_SCALE_KEY = "lumen.reader.aiFontScale";
const READING_WIDTH_KEY = "lumen.reader.readingWidth";
const READING_FONT_MODE_KEY = "lumen.reader.readingFontMode";
const CUSTOM_READING_FONT_KEY = "lumen.reader.customReadingFont";
const AI_FONT_OPTIONS = [
  { value: .96, label: "紧凑" },
  { value: 1.1, label: "标准" },
  { value: 1.22, label: "舒适" },
  { value: 1.36, label: "大字" },
] as const;
const READING_WIDTH_OPTIONS: Array<{ value: ReadingWidthMode; label: string; detail: string }> = [
  { value: "comfortable", label: "舒适", detail: "长文" },
  { value: "wide", label: "宽屏", detail: "自适应" },
  { value: "full", label: "铺满", detail: "Full" },
];
const READING_FONT_OPTIONS: Array<{ value: ReadingFontMode; label: string; detail: string }> = [
  { value: "system", label: "系统", detail: "苹方" },
  { value: "serif", label: "书卷", detail: "宋体" },
  { value: "custom", label: "自定义", detail: "本机" },
];

interface SelectionState {
  page: number;
  text: string;
  rects: Highlight["rects"];
  top: number;
  left: number;
}

interface SourceInfo {
  url: string;
  name: string;
  mimeHandler: boolean;
}

interface IndexProgress {
  current: number;
  total: number;
}

export function ViewerApp() {
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [loadProgress, setLoadProgress] = useState("等待论文");
  const [error, setError] = useState("");
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pages, setPages] = useState<PageText[]>([]);
  const [indexProgress, setIndexProgress] = useState<IndexProgress | null>(null);
  const [source, setSource] = useState<SourceInfo | null>(null);
  const [documentId, setDocumentId] = useState("");
  const [paperState, setPaperState] = useState<PaperState>(EMPTY_PAPER_STATE);
  const [settings, setSettings] = useState<LumenSettings | null>(null);
  const [scale, setScale] = useState(1.12);
  const [currentPage, setCurrentPage] = useState(1);
  const [panelOpen, setPanelOpen] = useState(true);
  const [focusMode, setFocusMode] = useState(false);
  const [panelWidth, setPanelWidth] = useState(readPanelWidth);
  const [panelResizing, setPanelResizing] = useState(false);
  const [providerMenuOpen, setProviderMenuOpen] = useState(false);
  const [fontMenuOpen, setFontMenuOpen] = useState(false);
  const [aiFontScale, setAiFontScale] = useState(readAiFontScale);
  const [readingWidthMode, setReadingWidthMode] = useState(readReadingWidthMode);
  const [readingFontMode, setReadingFontMode] = useState(readReadingFontMode);
  const [customReadingFont, setCustomReadingFont] = useState(readCustomReadingFont);
  const [tab, setTab] = useState<PanelTab>("overview");
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [chatBusy, setChatBusy] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const paperStageRef = useRef<HTMLElement>(null);
  const summaryAttempted = useRef(false);
  const summaryBusyRef = useRef(false);
  const chatBusyRef = useRef(false);
  const panelWidthRef = useRef(panelWidth);
  const panelBeforeFocusRef = useRef(panelOpen);
  const loadGenerationRef = useRef(0);

  const configured = Boolean(settings && settingsAreReady(settings));
  const readingProgress = pdf ? Math.min(100, Math.max(0, currentPage / pdf.numPages * 100)) : 0;

  const enterFocusMode = useCallback(() => {
    panelBeforeFocusRef.current = panelOpen;
    setFocusMode(true);
    setPanelOpen(false);
    setProviderMenuOpen(false);
    setFontMenuOpen(false);
  }, [panelOpen]);

  const exitFocusMode = useCallback((restorePanel = true) => {
    setFocusMode(false);
    if (restorePanel && panelBeforeFocusRef.current) setPanelOpen(true);
  }, []);

  const showPanel = useCallback((nextTab: PanelTab) => {
    setFocusMode(false);
    setTab(nextTab);
    setPanelOpen(true);
  }, []);

  const updateAiFontScale = useCallback((value: number) => {
    setAiFontScale(value);
    try { localStorage.setItem(AI_FONT_SCALE_KEY, String(value)); } catch { /* optional preference */ }
  }, []);

  const updateReadingWidthMode = useCallback((value: ReadingWidthMode) => {
    setReadingWidthMode(value);
    try { localStorage.setItem(READING_WIDTH_KEY, value); } catch { /* optional preference */ }
  }, []);

  const updateReadingFontMode = useCallback((value: ReadingFontMode) => {
    setReadingFontMode(value);
    try { localStorage.setItem(READING_FONT_MODE_KEY, value); } catch { /* optional preference */ }
  }, []);

  const updateCustomReadingFont = useCallback((value: string) => {
    const next = sanitizeFontName(value);
    setCustomReadingFont(next);
    try { localStorage.setItem(CUSTOM_READING_FONT_KEY, next); } catch { /* optional preference */ }
  }, []);

  const switchProvider = useCallback(async (provider: ProviderKind) => {
    if (!settings || provider === settings.provider) {
      setProviderMenuOpen(false);
      return;
    }
    const next = { ...settings, provider };
    setSettings(next);
    setProviderMenuOpen(false);
    setError("");
    try {
      await saveSettings(next);
    } catch (cause) {
      setSettings(settings);
      setError(`切换 AI 入口失败：${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }, [settings]);

  const switchChatMode = useCallback(async (chatMode: LumenSettings["chatMode"]) => {
    if (!settings || chatMode === settings.chatMode) return;
    const next = { ...settings, chatMode };
    setSettings(next);
    setError("");
    try {
      await saveSettings(next);
    } catch (cause) {
      setSettings(settings);
      setError(`切换对话模式失败：${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }, [settings]);

  const updatePanelWidth = useCallback((value: number, persist = false) => {
    const next = clampPanelWidth(value);
    panelWidthRef.current = next;
    setPanelWidth(next);
    if (persist) {
      try { localStorage.setItem(PANEL_WIDTH_KEY, String(next)); } catch { /* optional preference */ }
    }
  }, []);

  const startPanelResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || window.innerWidth <= 760) return;
    event.preventDefault();
    setPanelResizing(true);

    const onMove = (moveEvent: PointerEvent) => updatePanelWidth(window.innerWidth - moveEvent.clientX);
    const onEnd = () => {
      setPanelResizing(false);
      updatePanelWidth(panelWidthRef.current, true);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  }, [updatePanelWidth]);

  const resizePanelWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      updatePanelWidth(panelWidthRef.current + 32, true);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      updatePanelWidth(panelWidthRef.current - 32, true);
    } else if (event.key === "Home") {
      event.preventDefault();
      updatePanelWidth(DEFAULT_PANEL_WIDTH, true);
    }
  };

  useEffect(() => {
    const keepPanelOnScreen = () => updatePanelWidth(panelWidthRef.current);
    window.addEventListener("resize", keepPanelOnScreen);
    return () => window.removeEventListener("resize", keepPanelOnScreen);
  }, [updatePanelWidth]);

  const commitPaperState = useCallback(
    (updater: (current: PaperState) => PaperState) => {
      setPaperState((current) => {
        const next = updater(current);
        if (documentId) {
          const persisted = settings?.storeConversations ? next : { ...next, messages: [] };
          void savePaperState(documentId, persisted);
        }
        return next;
      });
    },
    [documentId, settings?.storeConversations],
  );

  const loadBytes = useCallback(async (buffer: ArrayBuffer, nextSource: SourceInfo, cachedPages?: PageText[] | null) => {
    const generation = ++loadGenerationRef.current;
    const byteLength = buffer.byteLength;
    setLoadState("loading");
    setLoadProgress("正在打开论文…");
    setError("");
    setPdf(null);
    setPages([]);
    setIndexProgress(null);
    setSource(nextSource);
    summaryAttempted.current = false;
    let nextPdf: PDFDocumentProxy;
    try {
      const task = getDocument({ data: new Uint8Array(buffer) });
      nextPdf = await task.promise;
      if (generation !== loadGenerationRef.current) return;
      setPdf(nextPdf);
      const metadata = await nextPdf.getMetadata().catch(() => null);
      const metadataTitle = metadata?.info && "Title" in metadata.info ? String(metadata.info.Title || "") : "";
      const name = metadataTitle || nextSource.name || "Research paper";
      document.title = `${name} · Lumen`;
      const id = await makeDocumentId(`${nextSource.url}|${name}|${byteLength}`);
      if (generation !== loadGenerationRef.current) return;
      setDocumentId(id);
      setPaperState(await getPaperState(id));
      setSource({ ...nextSource, name });
      setLoadState("ready");

      if (cachedPages?.length === nextPdf.numPages) {
        setPages(cachedPages);
        return;
      }
    } catch (cause) {
      if (generation !== loadGenerationRef.current) return;
      setLoadState("error");
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }

    const extracted: PageText[] = [];
    setIndexProgress({ current: 0, total: nextPdf.numPages });
    await yieldToReader();
    try {
      for (let pageNumber = 1; pageNumber <= nextPdf.numPages; pageNumber += 1) {
        if (generation !== loadGenerationRef.current) return;
        const page = await nextPdf.getPage(pageNumber);
        const content = await page.getTextContent();
        extracted.push({
          page: pageNumber,
          text: normalizePageText(content.items as Array<{ str?: string; hasEOL?: boolean }>),
        });
        setIndexProgress({ current: pageNumber, total: nextPdf.numPages });
        await yieldToReader();
      }
      if (generation !== loadGenerationRef.current) return;
      setPages(extracted);
      setIndexProgress(null);
      void putCachedPdfIndex(nextSource.url, extracted).catch(() => undefined);
    } catch (cause) {
      if (generation !== loadGenerationRef.current) return;
      setPages(extracted);
      setIndexProgress(null);
      setError(`PDF 已打开，但原文索引只完成了 ${extracted.length}/${nextPdf.numPages} 页：${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }, []);

  useEffect(() => {
    applySourceFavicon();
    void getSettings().then(setSettings);
    void discoverSource(loadBytes).catch((cause) => {
      setLoadState("error");
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [loadBytes]);

  useEffect(() => {
    if (!providerMenuOpen && !fontMenuOpen) return;
    const closeMenu = (event: PointerEvent) => {
      if (!(event.target as Element | null)?.closest(".provider-switch, .font-switch")) {
        setProviderMenuOpen(false);
        setFontMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setProviderMenuOpen(false);
        setFontMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeMenu);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeMenu);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [fontMenuOpen, providerMenuOpen]);

  useEffect(() => {
    const onFocusShortcut = (event: KeyboardEvent) => {
      if (event.key === "Escape" && focusMode) {
        event.preventDefault();
        exitFocusMode();
        return;
      }
      if (
        !pdf ||
        event.key.toLowerCase() !== "f" ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isEditableTarget(event.target)
      ) return;
      event.preventDefault();
      if (focusMode) exitFocusMode();
      else enterFocusMode();
    };
    document.addEventListener("keydown", onFocusShortcut);
    return () => document.removeEventListener("keydown", onFocusShortcut);
  }, [enterFocusMode, exitFocusMode, focusMode, pdf]);

  const runSummary = useCallback(async () => {
    if (!settings || summaryBusyRef.current) return;
    if (!pages.length) {
      setError("原文索引仍在后台建立，完成后即可生成解读。");
      return;
    }
    if (!settingsAreReady(settings)) {
      showPanel("overview");
      return;
    }
    summaryBusyRef.current = true;
    setSummaryBusy(true);
    setError("");
    try {
      const response = await requestAi({
        system: settings.paperSystemPrompt,
        purpose: "summary",
        messages: [
          {
            role: "user",
            content: summaryPrompt(
              selectSummaryPages(pages),
              settings.responseLanguage,
              settings.summaryPrompt,
              settings.summaryTemplate,
            ),
          },
        ],
        temperature: 0.15,
      });
      if (!response.ok || !response.content) throw new Error(response.error || "摘要失败");
      const summary = parseSummary(response.content);
      commitPaperState((state) => ({ ...state, summary }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      summaryBusyRef.current = false;
      setSummaryBusy(false);
    }
  }, [commitPaperState, pages, settings, showPanel]);

  useEffect(() => {
    if (
      loadState === "ready" &&
      pages.length > 0 &&
      settings?.autoAnalyze &&
      configured &&
      !paperState.summary &&
      !summaryAttempted.current
    ) {
      summaryAttempted.current = true;
      void runSummary();
    }
  }, [configured, loadState, pages.length, paperState.summary, runSummary, settings?.autoAnalyze]);

  useEffect(() => {
    const onMouseUp = (event: MouseEvent) => {
      if ((event.target as Element | null)?.closest(".selection-popover")) return;
      window.setTimeout(() => {
        const selected = window.getSelection();
        const text = selected?.toString().trim();
        if (!selected || !text || selected.rangeCount === 0) {
          setSelection(null);
          return;
        }
        const range = selected.getRangeAt(0);
        const node = range.commonAncestorContainer instanceof Element
          ? range.commonAncestorContainer
          : range.commonAncestorContainer.parentElement;
        const pageElement = node?.closest<HTMLElement>(".pdf-page");
        if (!pageElement) return;
        const page = Number(pageElement.dataset.page);
        const pageRect = pageElement.getBoundingClientRect();
        const clientRects = preciseSelectionRects(range, pageElement).filter(
          (rect) => rect.width > 1 && rect.height > 1 && intersects(rect, pageRect),
        );
        if (!clientRects.length) return;
        const rects = clientRects.map((rect) => ({
          x: clamp01((rect.left - pageRect.left) / pageRect.width),
          y: clamp01((rect.top - pageRect.top) / pageRect.height),
          width: clamp01(rect.width / pageRect.width),
          height: clamp01(rect.height / pageRect.height),
        }));
        const lastRect = clientRects.at(-1)!;
        setSelection({
          page,
          text: text.slice(0, 4000),
          rects,
          top: Math.min(window.innerHeight - 64, lastRect.bottom + 10),
          left: Math.min(window.innerWidth - 310, Math.max(12, lastRect.left)),
        });
      }, 0);
    };
    document.addEventListener("mouseup", onMouseUp);
    return () => document.removeEventListener("mouseup", onMouseUp);
  }, []);

  const addHighlight = (color: HighlightColor = "citron") => {
    if (!selection) return;
    const highlight: Highlight = {
      id: crypto.randomUUID(),
      page: selection.page,
      text: selection.text,
      color,
      rects: selection.rects,
      note: "",
      createdAt: Date.now(),
    };
    commitPaperState((state) => ({ ...state, highlights: [...state.highlights, highlight] }));
    window.getSelection()?.removeAllRanges();
    setSelection(null);
  };

  const askAboutSelection = async (action: "explain" | "translate" | "challenge") => {
    if (!selection || chatBusyRef.current) return;
    if (!configured) {
      showPanel("overview");
      return;
    }
    const chosen = selection;
    const label = action === "explain" ? "解释这段" : action === "translate" ? "翻译这段" : "挑战这段";
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: label,
      page: chosen.page,
      quote: chosen.text,
      createdAt: Date.now(),
    };
    commitPaperState((state) => ({ ...state, messages: [...state.messages, userMessage] }));
    setSelection(null);
    window.getSelection()?.removeAllRanges();
    showPanel("chat");
    chatBusyRef.current = true;
    setChatBusy(true);
    setError("");
    try {
      const pageContext = pages.find(({ page }) => page === chosen.page)?.text ?? "";
      const response = await requestAi({
        system: settings!.paperSystemPrompt,
        purpose: "chat",
        messages: [{
          role: "user",
          content: selectionPrompt(action, chosen.page, chosen.text, pageContext, {
            explain: settings!.explainTemplate,
            translate: settings!.translateTemplate,
            challenge: settings!.challengeTemplate,
          }),
        }],
      });
      if (!response.ok || !response.content) throw new Error(response.error || "AI 请求失败");
      commitPaperState((state) => ({
        ...state,
        messages: [
          ...state.messages,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: response.content!,
            page: chosen.page,
            toolActivity: response.toolActivity,
            runtime: response.runtime,
            createdAt: Date.now(),
          },
        ],
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      chatBusyRef.current = false;
      setChatBusy(false);
    }
  };

  const askChat = async () => {
    const question = chatInput.trim();
    if (!question || chatBusyRef.current || !settings) return;
    if (!pages.length && settings.chatMode === "paper") {
      setError("原文索引仍在后台建立，请稍后再提问。");
      return;
    }
    if (!configured) {
      setTab("overview");
      return;
    }
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: question,
      createdAt: Date.now(),
    };
    const history = paperState.messages;
    setChatInput("");
    commitPaperState((state) => ({ ...state, messages: [...state.messages, userMessage] }));
    chatBusyRef.current = true;
    setChatBusy(true);
    setError("");
    try {
      const attachPaper = settings.chatMode === "paper" || hasRelevantPaperContext(question, pages);
      const relevant = attachPaper ? rankRelevantPages(question, pages) : [];
      const response = await requestAi({
        system: chatSystemPrompt(settings.chatMode, settings.paperSystemPrompt, settings.researchSystemPrompt),
        purpose: "chat",
        messages: chatPrompt(question, relevant, history, settings.chatTemplate),
      });
      if (!response.ok || !response.content) throw new Error(response.error || "AI 请求失败");
      commitPaperState((state) => ({
        ...state,
        messages: [
          ...state.messages,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: response.content!,
            toolActivity: response.toolActivity,
            runtime: response.runtime,
            createdAt: Date.now(),
          },
        ],
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      chatBusyRef.current = false;
      setChatBusy(false);
    }
  };

  const openFile = async (file: File) => {
    await loadBytes(await file.arrayBuffer(), {
      url: `local:${file.name}:${file.lastModified}`,
      name: file.name.replace(/\.pdf$/i, ""),
      mimeHandler: false,
    });
  };

  const goToPage = (page: number) => {
    if (!Number.isInteger(page) || page < 1 || (pdf && page > pdf.numPages)) return;
    const stage = paperStageRef.current;
    const target = stage?.querySelector<HTMLElement>(`.pdf-page[data-page="${page}"]`);
    if (!stage || !target) return;
    const top = target.getBoundingClientRect().top - stage.getBoundingClientRect().top + stage.scrollTop - 18;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    stage.scrollTo({ top: Math.max(0, top), behavior: reduceMotion ? "auto" : "smooth" });
    setCurrentPage(page);
    target.classList.remove("page-target");
    void target.offsetWidth;
    target.classList.add("page-target");
    window.setTimeout(() => target.classList.remove("page-target"), 1100);
  };

  const openNative = async () => {
    const mimeHandler = (chrome as typeof chrome & { mimeHandler?: { abortAndFallbackToNativeHandler: () => Promise<void> } }).mimeHandler;
    if (source?.mimeHandler && mimeHandler) {
      await mimeHandler.abortAndFallbackToNativeHandler();
      return;
    }
    if (source?.url && /^(https?|file):/i.test(source.url)) {
      await chrome.runtime.sendMessage({ type: "OPEN_NATIVE", url: source.url });
    }
  };

  return (
    <div
      className={`reader-app reading-width-${readingWidthMode} reading-font-${readingFontMode} ${panelResizing ? "panel-resizing" : ""} ${focusMode ? "focus-mode" : ""}`}
      style={{
        "--panel-width": `${panelWidth}px`,
        "--ai-font-scale": aiFontScale,
        "--custom-reading-font": customReadingFontValue(customReadingFont),
      } as CSSProperties}
    >
      <header className="topbar">
        {pdf && (
          <div className="reading-progress" role="progressbar" aria-label="论文阅读进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(readingProgress)}>
            <span style={{ width: `${readingProgress}%` }} />
          </div>
        )}
        <div className="brand-lockup">
          <span className="brand-mark"><img src={chrome.runtime.getURL("icons/icon-32.png")} alt="" /></span>
          <span>Lumen</span>
        </div>
        <div className="document-title" title={source?.name}>{source?.name || "AI paper reader"}</div>
        <div className="toolbar-actions">
          {pdf && (
            <>
              <button className="icon-button zoom-control" onClick={() => setScale((value) => Math.max(.7, value - .1))} aria-label="缩小"><Minus size={17} /></button>
              <span className="zoom-label">{Math.round(scale * 100)}%</span>
              <button className="icon-button zoom-control" onClick={() => setScale((value) => roundScale(value + .1))} aria-label="放大"><Plus size={17} /></button>
              <span className="page-counter">{currentPage} / {pdf.numPages}</span>
            </>
          )}
          {pdf && <button className="icon-button focus-toggle" onClick={enterFocusMode} aria-label="进入专注模式" title="专注阅读 (F)"><Focus size={17} /></button>}
          <div className="font-switch">
            <button
              className="font-chip"
              onClick={() => {
                setProviderMenuOpen(false);
                setFontMenuOpen((value) => !value);
              }}
              aria-haspopup="menu"
              aria-expanded={fontMenuOpen}
              title={`AI 字号 ${Math.round(aiFontScale * 100)}% · ${readingWidthLabel(readingWidthMode)} · ${readingFontLabel(readingFontMode, customReadingFont)}`}
            >Aa</button>
            {fontMenuOpen && (
              <div className="font-menu" role="menu">
                <div><strong>AI 内容字号</strong><small>解读、交流和笔记</small></div>
                <div className="font-size-options">
                  {AI_FONT_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      className={Math.abs(aiFontScale - option.value) < .01 ? "active" : ""}
                      onClick={() => {
                        updateAiFontScale(option.value);
                        setFontMenuOpen(false);
                      }}
                    ><span style={{ fontSize: `${option.value}em` }}>Aa</span><small>{option.label}</small></button>
                  ))}
                </div>
                <div className="font-size-stepper">
                  <button onClick={() => updateAiFontScale(Math.max(.7, roundScale(aiFontScale - .1)))} aria-label="减小 AI 字号">−</button>
                  <span>{Math.round(aiFontScale * 100)}%</span>
                  <button onClick={() => updateAiFontScale(roundScale(aiFontScale + .1))} aria-label="增大 AI 字号">+</button>
                </div>
                <div className="reading-width-control">
                  <div className="font-menu-subhead"><strong>内容宽度</strong><small>跟随侧栏伸缩</small></div>
                  <div className="reading-width-options" role="group" aria-label="AI 内容宽度">
                    {READING_WIDTH_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        className={readingWidthMode === option.value ? "active" : ""}
                        onClick={() => updateReadingWidthMode(option.value)}
                        aria-pressed={readingWidthMode === option.value}
                      ><strong>{option.label}</strong><small>{option.detail}</small></button>
                    ))}
                  </div>
                </div>
                <div className="reading-font-control">
                  <div className="font-menu-subhead"><strong>阅读字体</strong><small>仅 AI 内容</small></div>
                  <div className="reading-font-options" role="group" aria-label="AI 阅读字体">
                    {READING_FONT_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        className={readingFontMode === option.value ? "active" : ""}
                        onClick={() => updateReadingFontMode(option.value)}
                        aria-pressed={readingFontMode === option.value}
                      ><strong>{option.label}</strong><small>{option.detail}</small></button>
                    ))}
                  </div>
                  {readingFontMode === "custom" && (
                    <>
                      <input
                        className="custom-font-input"
                        value={customReadingFont}
                        onChange={(event) => updateCustomReadingFont(event.target.value)}
                        placeholder="例如：霞鹜文楷"
                        aria-label="自定义字体名称"
                        autoComplete="off"
                        spellCheck={false}
                      />
                      <small className="custom-font-note">填写本机已安装字体；找不到时自动回退到系统字体。</small>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
          {settings && (
            <div className="provider-switch">
              <button
                className="provider-chip"
                onClick={() => {
                  setFontMenuOpen(false);
                  setProviderMenuOpen((value) => !value);
                }}
                aria-haspopup="menu"
                aria-expanded={providerMenuOpen}
                title={`当前使用：${settings.provider === "codex" ? "Codex Plan" : "自定义 API"}`}
              >
                <span className={`provider-dot ${configured ? "ready" : "missing"}`} />
                <span className="provider-chip-label">{settings.provider === "codex" ? "Codex Plan" : "API"}</span>
                <ChevronDown size={13} />
              </button>
              {providerMenuOpen && (
                <div className="provider-menu" role="menu">
                  <div className="provider-menu-caption">AI 推理入口</div>
                  <ProviderMenuItem
                    active={settings.provider === "codex"}
                    ready={settingsAreReady({ ...settings, provider: "codex" })}
                    icon={<Terminal size={15} />}
                    title="Codex Plan"
                    detail={modelPairLabel(settings.codexSummaryModel, settings.codexChatModel, "Codex 默认")}
                    onClick={() => void switchProvider("codex")}
                  />
                  <ProviderMenuItem
                    active={settings.provider === "compatible"}
                    ready={settingsAreReady({ ...settings, provider: "compatible" })}
                    icon={<Sparkles size={15} />}
                    title="自定义 API"
                    detail={modelPairLabel(settings.summaryModel, settings.chatModel, "OpenAI-compatible")}
                    onClick={() => void switchProvider("compatible")}
                  />
                  <button
                    className="provider-menu-settings"
                    onClick={() => {
                      setProviderMenuOpen(false);
                      void chrome.runtime.openOptionsPage();
                    }}
                  ><Settings size={14} /> 管理连接配置</button>
                </div>
              )}
            </div>
          )}
          <button className="icon-button settings-control" onClick={() => chrome.runtime.openOptionsPage()} aria-label="设置"><Settings size={17} /></button>
          <button className="icon-button panel-control" onClick={() => setPanelOpen((value) => !value)} aria-label="切换侧栏">
            {panelOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
          </button>
          <button className="focus-exit-button" onClick={() => exitFocusMode()} aria-label="退出专注模式"><X size={14} /> 退出专注 <kbd>Esc</kbd></button>
        </div>
      </header>

      <main className={`main-layout ${panelOpen ? "panel-visible" : ""}`}>
        <section ref={paperStageRef} className="paper-stage">
          {loadState === "idle" && <EmptyReader onUpload={() => fileInputRef.current?.click()} />}
          {loadState === "loading" && (
            <div className="loading-reader">
              <LoaderCircle className="spin" size={26} />
              <strong>{loadProgress}</strong>
              <span>内容只在本机解析；配置 AI 后才会发送必要的文本片段。</span>
            </div>
          )}
          {loadState === "error" && (
            <div className="error-reader">
              <ShieldQuestion size={28} />
              <strong>这份 PDF 没能打开</strong>
              <p>{error}</p>
              <button className="primary-button" onClick={() => fileInputRef.current?.click()}><Upload size={16} /> 从本机选择</button>
            </div>
          )}
          {pdf && loadState === "ready" && (
            <div className="page-stack">
              {Array.from({ length: pdf.numPages }, (_, index) => (
                <PdfPage
                  key={index + 1}
                  pdf={pdf}
                  pageNumber={index + 1}
                  scale={scale}
                  highlights={paperState.highlights.filter(({ page }) => page === index + 1)}
                  onVisible={setCurrentPage}
                />
              ))}
            </div>
          )}
          <input
            ref={fileInputRef}
            className="visually-hidden"
            type="file"
            accept="application/pdf,.pdf"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void openFile(file);
            }}
          />
        </section>

        {panelOpen && (
          <aside className="insight-panel" aria-label="AI 阅读助手">
            <div
              className="panel-resize-handle"
              role="separator"
              aria-label="调整解读栏宽度"
              aria-orientation="vertical"
              aria-valuemin={320}
              aria-valuemax={Math.max(320, window.innerWidth - 48)}
              aria-valuenow={Math.round(panelWidth)}
              tabIndex={0}
              title="向左拖动放大 · 双击恢复默认"
              onPointerDown={startPanelResize}
              onKeyDown={resizePanelWithKeyboard}
              onDoubleClick={() => updatePanelWidth(DEFAULT_PANEL_WIDTH, true)}
            />
            <div className="panel-tabs" role="tablist" aria-label="AI 阅读工具">
              <PanelTabButton active={tab === "overview"} onClick={() => setTab("overview")} icon={<Sparkles size={15} />} label="解读" />
              <PanelTabButton active={tab === "chat"} onClick={() => setTab("chat")} icon={<MessageCircle size={15} />} label="交流" />
              <PanelTabButton active={tab === "notes"} onClick={() => setTab("notes")} icon={<Highlighter size={15} />} label="划线" />
            </div>
            {tab === "overview" && (
              <OverviewPanel
                configured={configured}
                summary={paperState.summary}
                busy={summaryBusy}
                onAnalyze={() => void runSummary()}
                onSettings={() => chrome.runtime.openOptionsPage()}
                onPage={goToPage}
                source={source}
                onNative={openNative}
                indexProgress={indexProgress}
              />
            )}
            {tab === "chat" && (
              <ChatPanel
                messages={paperState.messages}
                busy={chatBusy}
                value={chatInput}
                configured={configured}
                onChange={setChatInput}
                onSend={() => void askChat()}
                onPage={goToPage}
                onSettings={() => chrome.runtime.openOptionsPage()}
                mode={settings?.chatMode || "research"}
                permissionMode={settings?.provider === "codex" ? settings.codexPermissionMode : null}
                onModeChange={(mode) => void switchChatMode(mode)}
              />
            )}
            {tab === "notes" && (
              <NotesPanel
                highlights={paperState.highlights}
                onPage={goToPage}
                onDelete={(id) => commitPaperState((state) => ({
                  ...state,
                  highlights: state.highlights.filter((item) => item.id !== id),
                }))}
                onNote={(id, note) => commitPaperState((state) => ({
                  ...state,
                  highlights: state.highlights.map((item) => item.id === id ? { ...item, note } : item),
                }))}
              />
            )}
          </aside>
        )}
      </main>

      {selection && (
        <SelectionPopover
          selection={selection}
          onHighlight={addHighlight}
          onAction={(action) => void askAboutSelection(action)}
          onClose={() => setSelection(null)}
        />
      )}
      {error && loadState !== "error" && (
        <div className="toast" role="alert"><span>{error}</span><button onClick={() => setError("")}><X size={15} /></button></div>
      )}
    </div>
  );
}

function readPanelWidth() {
  try {
    const saved = Number(localStorage.getItem(PANEL_WIDTH_KEY));
    if (Number.isFinite(saved) && saved > 0) return clampPanelWidth(saved);
  } catch { /* use default */ }
  return clampPanelWidth(DEFAULT_PANEL_WIDTH);
}

function readAiFontScale() {
  try {
    const saved = Number(localStorage.getItem(AI_FONT_SCALE_KEY));
    if (Number.isFinite(saved) && saved >= .7) return saved;
  } catch { /* use default */ }
  return DEFAULT_AI_FONT_SCALE;
}

function readReadingWidthMode(): ReadingWidthMode {
  try {
    const saved = localStorage.getItem(READING_WIDTH_KEY);
    if (saved === "comfortable" || saved === "wide" || saved === "full") return saved;
  } catch { /* use default */ }
  return "wide";
}

function readReadingFontMode(): ReadingFontMode {
  try {
    const saved = localStorage.getItem(READING_FONT_MODE_KEY);
    if (saved === "system" || saved === "serif" || saved === "custom") return saved;
  } catch { /* use default */ }
  return "system";
}

function readCustomReadingFont(): string {
  try {
    return sanitizeFontName(localStorage.getItem(CUSTOM_READING_FONT_KEY) || "");
  } catch { /* use default */ }
  return "";
}

function ProviderMenuItem({ active, ready, icon, title, detail, onClick }: {
  active: boolean;
  ready: boolean;
  icon: React.ReactNode;
  title: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button className={`provider-menu-item ${active ? "active" : ""}`} role="menuitemradio" aria-checked={active} onClick={onClick}>
      <span className="provider-menu-icon">{icon}</span>
      <span><strong>{title}</strong><small>{detail} · {ready ? "已配置" : "未配置"}</small></span>
      {active && <Check size={14} />}
    </button>
  );
}

function clampPanelWidth(value: number) {
  if (typeof window === "undefined") return DEFAULT_PANEL_WIDTH;
  const min = Math.min(320, Math.max(260, window.innerWidth - 320));
  const max = Math.max(min, window.innerWidth - 48);
  return Math.round(Math.min(max, Math.max(min, value)));
}

function roundScale(value: number) {
  return Math.round(value * 100) / 100;
}

function readingWidthLabel(mode: ReadingWidthMode): string {
  if (mode === "full") return "铺满";
  if (mode === "comfortable") return "舒适行宽";
  return "宽屏行宽";
}

function readingFontLabel(mode: ReadingFontMode, customFont: string): string {
  if (mode === "serif") return "书卷字体";
  if (mode === "custom") return sanitizeFontName(customFont).trim() || "自定义字体";
  return "系统字体";
}

function sanitizeFontName(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f"'\\;{}<>]/g, "").slice(0, 80);
}

function customReadingFontValue(value: string): string {
  const name = sanitizeFontName(value).trim();
  if (!name) return "var(--font-reading-system)";
  return `"${name}", var(--font-reading-system)`;
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

function modelPairLabel(summaryModel: string, chatModel: string, fallback: string): string {
  if (!summaryModel && !chatModel) return fallback;
  if (summaryModel === chatModel) return summaryModel || fallback;
  return `解读 ${summaryModel || fallback} · 交流 ${chatModel || fallback}`;
}

function permissionModeLabel(mode: LumenSettings["codexPermissionMode"]): string {
  if (mode === "unrestricted") return "Full Agent";
  if (mode === "agent") return "Agent";
  return "Reader";
}

function PdfPage({
  pdf,
  pageNumber,
  scale,
  highlights,
  onVisible,
}: {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  highlights: Highlight[];
  onVisible: (page: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState<PDFPageProxy | null>(null);
  const [nearViewport, setNearViewport] = useState(pageNumber <= 2);
  const [canvasRevision, setCanvasRevision] = useState(0);
  const [alignedHighlightRects, setAlignedHighlightRects] = useState<Record<string, Highlight["rects"][number]>>({});
  const highlightsRef = useRef(highlights);
  highlightsRef.current = highlights;
  const highlightGeometryKey = highlights.map((highlight) => (
    `${highlight.id}:${highlight.rects.map((rect) => `${rect.x},${rect.y},${rect.width},${rect.height}`).join(";")}`
  )).join("|");

  useEffect(() => {
    if (nearViewport) return;
    const element = containerRef.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        setNearViewport(true);
        observer.disconnect();
      },
      { rootMargin: "1200px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [nearViewport]);

  useEffect(() => {
    if (!nearViewport) return;
    let active = true;
    void pdf.getPage(pageNumber).then((value) => active && setPage(value));
    return () => { active = false; };
  }, [nearViewport, pageNumber, pdf]);

  useEffect(() => {
    if (!page || !canvasRef.current || !textRef.current || !containerRef.current) return;
    let active = true;
    const viewport = page.getViewport({ scale });
    const outputScale = window.devicePixelRatio || 1;
    const canvas = canvasRef.current;
    const textContainer = textRef.current;
    const container = containerRef.current;
    container.style.width = `${viewport.width}px`;
    container.style.height = `${viewport.height}px`;
    container.style.setProperty("--scale-factor", String(viewport.scale));
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return;
    const renderTask = page.render({
      canvasContext: context,
      viewport,
      transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
    });
    void renderTask.promise
      .then(() => { if (active) setCanvasRevision((revision) => revision + 1); })
      .catch(() => undefined);
    let textLayer: TextLayer | undefined;
    textContainer.replaceChildren();
    void page.getTextContent().then((content) => {
      textLayer = new TextLayer({ textContentSource: content, container: textContainer, viewport });
      return textLayer.render();
    });
    return () => {
      active = false;
      renderTask.cancel();
      textLayer?.cancel();
    };
  }, [page, scale]);

  useEffect(() => {
    const container = containerRef.current;
    if (!page || canvasRevision === 0 || !container) return;
    const pageRect = container.getBoundingClientRect();
    const next: Record<string, Highlight["rects"][number]> = {};
    for (const highlight of highlightsRef.current) {
      const rawRects = highlight.rects.map((rect) => new DOMRect(
        pageRect.left + rect.x * pageRect.width,
        pageRect.top + rect.y * pageRect.height,
        rect.width * pageRect.width,
        rect.height * pageRect.height,
      ));
      const alignedRects = alignSelectionRectsToCanvasInk(rawRects, container);
      alignedRects.forEach((rect, index) => {
        next[`${highlight.id}:${index}`] = {
          x: clamp01((rect.left - pageRect.left) / pageRect.width),
          y: clamp01((rect.top - pageRect.top) / pageRect.height),
          width: clamp01(rect.width / pageRect.width),
          height: clamp01(rect.height / pageRect.height),
        };
      });
    }
    setAlignedHighlightRects(next);
  }, [canvasRevision, highlightGeometryKey, page, scale]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => entry.isIntersecting && entry.intersectionRatio > .35 && onVisible(pageNumber),
      { threshold: [.35, .65] },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [onVisible, pageNumber]);

  return (
    <div
      ref={containerRef}
      className={`pdf-page ${page ? "" : "page-placeholder"}`}
      data-page={pageNumber}
      style={page ? undefined : { width: `${612 * scale}px`, height: `${792 * scale}px` }}
    >
      <canvas ref={canvasRef} />
      <div ref={textRef} className="textLayer" />
      <div className="highlight-layer" aria-hidden="true">
        {highlights.flatMap((highlight) => highlight.rects.map((rect, index) => {
          const rectKey = `${highlight.id}:${index}`;
          const displayRect = alignedHighlightRects[rectKey] ?? rect;
          const edgeInset = `min(${roundScale(.45 * scale)}px, ${displayRect.width * 3}%)`;
          return (
            <span
              key={rectKey}
              className={`saved-highlight ${highlight.color}`}
              data-ink-aligned={Boolean(alignedHighlightRects[rectKey])}
              style={{
                left: `calc(${displayRect.x * 100}% + ${edgeInset})`,
                top: `${displayRect.y * 100}%`,
                width: `calc(${displayRect.width * 100}% - ${edgeInset} - ${edgeInset})`,
                height: `${displayRect.height * 100}%`,
              }}
            />
          );
        }))}
      </div>
      <span className="page-number">{pageNumber}</span>
    </div>
  );
}

function OverviewPanel({ configured, summary, busy, onAnalyze, onSettings, onPage, source, onNative, indexProgress }: {
  configured: boolean;
  summary: PaperState["summary"];
  busy: boolean;
  onAnalyze: () => void;
  onSettings: () => void;
  onPage: (page: number) => void;
  source: SourceInfo | null;
  onNative: () => Promise<void>;
  indexProgress: IndexProgress | null;
}) {
  if (!configured) {
    return (
      <div className="panel-scroll onboarding-panel">
        <div className="onboarding-orb"><Sparkles size={23} /></div>
        <h2>把 AI 放在页边，<br />别放在阅读前面。</h2>
        <p>配置任意 OpenAI-compatible API，或连接本机 Codex CLI 使用你的 ChatGPT Codex 额度。</p>
        <button className="primary-button wide" onClick={onSettings}><Settings size={16} /> 配置 AI</button>
        <div className="privacy-note"><Check size={14} /> PDF 在本机解析；只发送回答所需的文本片段。</div>
      </div>
    );
  }
  if (busy) {
    return (
      <div className="panel-scroll summary-loading">
        <div className="eyebrow"><Sparkles size={13} /> PAPER BRIEF</div>
        <h2>正在建立论文的<br />阅读地图</h2>
        <div className="skeleton-line w90" /><div className="skeleton-line w70" />
        <div className="skeleton-card" /><div className="skeleton-card short" />
      </div>
    );
  }
  if (!summary) {
    return (
      <div className="panel-scroll empty-summary">
        <div className="onboarding-orb"><BookOpen size={23} /></div>
        <h2>先判断值不值得读</h2>
        <p>{indexProgress
          ? `论文已经可以阅读，正在后台建立原文索引 ${indexProgress.current}/${indexProgress.total}。`
          : "生成贡献、机制、证据、局限和最短阅读路径。所有判断都回到原文页码。"}</p>
        <button className="primary-button wide" onClick={onAnalyze} disabled={Boolean(indexProgress)}>
          <Sparkles size={16} /> {indexProgress ? "正在建立原文索引" : "生成论文解读"}
        </button>
        {source?.url && /^(https?|file):/i.test(source.url) && (
          <button className="quiet-button wide" onClick={() => void onNative()}><ExternalLink size={15} /> 用 Chrome 原生阅读器打开</button>
        )}
      </div>
    );
  }
  return (
    <div className="panel-scroll summary-panel">
      <div className="eyebrow"><Sparkles size={13} /> PAPER BRIEF</div>
      <h1>{summary.title}</h1>
      <p className="verdict">{summary.verdict}</p>

      <SummarySection title="真正的贡献" items={summary.contributions} />
      <section className="summary-section">
        <h3>机制</h3>
        <p>{summary.method}</p>
      </section>
      <section className="summary-section">
        <h3>证据账本</h3>
        <div className="evidence-list">
          {summary.evidence.map((item, index) => (
            <button key={index} className="evidence-row" onClick={() => onPage(item.page)}>
              <span>{item.claim}</span><b>p.{item.page}</b>
            </button>
          ))}
        </div>
      </section>
      <SummarySection title="值得质疑" items={summary.limitations} tone="critical" />
      <section className="summary-section">
        <h3>最短阅读路径</h3>
        <div className="reading-path">
          {summary.readingPath.map((item, index) => (
            <button key={index} onClick={() => onPage(item.page)}>
              <span className="path-index">{index + 1}</span>
              <span><strong>{item.label}</strong><small>{item.why}</small></span>
              <b>p.{item.page}</b>
            </button>
          ))}
        </div>
      </section>
      <div className="keyword-row">{summary.keywords.map((word) => <span key={word}>{word}</span>)}</div>
      <button className="quiet-button wide" onClick={onAnalyze}><Sparkles size={14} /> 重新生成</button>
    </div>
  );
}

function ChatPanel({ messages, busy, value, configured, mode, permissionMode, onChange, onSend, onPage, onSettings, onModeChange }: {
  messages: ChatMessage[];
  busy: boolean;
  value: string;
  configured: boolean;
  mode: LumenSettings["chatMode"];
  permissionMode: LumenSettings["codexPermissionMode"] | null;
  onChange: (value: string) => void;
  onSend: () => void;
  onPage: (page: number) => void;
  onSettings: () => void;
  onModeChange: (mode: LumenSettings["chatMode"]) => void;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  // Newer Chromium builds may return a Promise from scrollIntoView(). An
  // implicit return here makes React treat that Promise as an effect cleanup,
  // then crash the whole reader when messages change or this tab unmounts.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [busy, messages]);
  return (
    <div className="chat-layout">
      <div className="chat-mode-bar">
        <div className="chat-mode-switch" aria-label="对话语境">
          <button className={mode === "paper" ? "active" : ""} onClick={() => onModeChange("paper")}>论文</button>
          <button className={mode === "research" ? "active" : ""} onClick={() => onModeChange("research")}>研究</button>
        </div>
        <span>{mode === "paper" ? "以当前论文为边界" : "论文只是可选上下文"}</span>
        {permissionMode && <b className={`permission-badge ${permissionMode}`}>{permissionModeLabel(permissionMode)}</b>}
      </div>
      <div className="chat-scroll">
        {!messages.length && (
          <div className="chat-empty">
            <MessageCircle size={24} />
            <h2>从“哪里不可信”开始</h2>
            <p>试试：作者最强的 evidence 是什么？这个方法在哪个 regime 会失效？</p>
          </div>
        )}
        {messages.map((message) => (
          <div key={message.id} className={`message ${message.role}`}>
            {message.quote && <blockquote className="message-quote">{message.quote}</blockquote>}
            {message.role === "assistant" ? (
              <>
                <div className="assistant-kicker"><Sparkles size={12} /> Lumen</div>
                {message.toolActivity?.length ? (
                  <div className="agent-tool-activity">
                    {message.toolActivity.map((activity) => (
                      <span key={activity.kind}>
                        {activity.kind === "web_search" ? <Search size={11} /> : <Calculator size={11} />}
                        {activity.kind === "web_search" ? "Web search" : "计算验证"}{activity.count > 1 ? ` ×${activity.count}` : ""}
                      </span>
                    ))}
                  </div>
                ) : null}
                {message.runtime && (
                  <div className="runtime-receipt" title={`cwd: ${message.runtime.cwd}`}>
                    {permissionModeLabel(message.runtime.mode)} · {message.runtime.sandbox}
                  </div>
                )}
                <Markdown text={message.content} onPage={onPage} />
              </>
            ) : <p>{message.content}</p>}
            {message.page && <button className="page-chip" onClick={() => onPage(message.page!)}>p.{message.page}</button>}
          </div>
        ))}
        {busy && <div className="message assistant thinking"><span /><span /><span /></div>}
        <div ref={bottomRef} />
      </div>
      {configured ? (
        <div className="composer">
          <textarea
            value={value}
            rows={1}
            placeholder={mode === "paper" ? "问这篇论文…" : "问论文，也可以问外部世界…"}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                onSend();
              }
            }}
          />
          <button onClick={onSend} disabled={!value.trim() || busy} aria-label="发送"><Send size={16} /></button>
          <span>Enter 发送 · Shift Enter 换行</span>
        </div>
      ) : (
        <button className="configure-inline" onClick={onSettings}><Settings size={15} /> 配置 AI 后开始交流</button>
      )}
    </div>
  );
}

function NotesPanel({ highlights, onPage, onDelete, onNote }: {
  highlights: Highlight[];
  onPage: (page: number) => void;
  onDelete: (id: string) => void;
  onNote: (id: string, note: string) => void;
}) {
  return (
    <div className="panel-scroll notes-panel">
      <div className="eyebrow"><Highlighter size={13} /> YOUR MARGINS</div>
      <h2>{highlights.length ? `${highlights.length} 条划线` : "划线会留在页边"}</h2>
      {!highlights.length && <p className="muted">在原文中选中文字，即可高亮、解释、翻译或发起 reviewer challenge。</p>}
      {[...highlights].sort((a, b) => a.page - b.page).map((item) => (
        <article className={`note-card ${item.color}`} key={item.id}>
          <button className="note-page" onClick={() => onPage(item.page)}>p.{item.page}</button>
          <blockquote>{item.text}</blockquote>
          <textarea
            value={item.note}
            placeholder="写下你的判断…"
            onChange={(event) => onNote(item.id, event.target.value)}
          />
          <button className="delete-note" onClick={() => onDelete(item.id)}><X size={13} /> 删除</button>
        </article>
      ))}
    </div>
  );
}

function SelectionPopover({ selection, onHighlight, onAction, onClose }: {
  selection: SelectionState;
  onHighlight: (color?: HighlightColor) => void;
  onAction: (action: "explain" | "translate" | "challenge") => void;
  onClose: () => void;
}) {
  const [palette, setPalette] = useState(false);
  return (
    <div className="selection-popover" role="toolbar" aria-label="选中文字操作" style={{ top: selection.top, left: selection.left }}>
      <div className="selection-page">p.{selection.page}</div>
      <button onClick={() => onAction("explain")}><Sparkles size={14} /> 解释</button>
      <button onClick={() => onAction("translate")}><Languages size={14} /> 翻译</button>
      <button onClick={() => onAction("challenge")}><ShieldQuestion size={14} /> 质疑</button>
      <div className="highlight-control">
        <button onClick={() => onHighlight()}><Highlighter size={14} /> 划线</button>
        <button className="palette-toggle" onClick={() => setPalette((value) => !value)}><ChevronDown size={12} /></button>
        {palette && (
          <div className="color-palette">
            {(["citron", "sky", "coral", "violet"] as HighlightColor[]).map((color) => (
              <button key={color} className={color} onClick={() => onHighlight(color)} aria-label={color} />
            ))}
          </div>
        )}
      </div>
      <button className="popover-close" onClick={onClose}><X size={13} /></button>
    </div>
  );
}

function EmptyReader({ onUpload }: { onUpload: () => void }) {
  return (
    <div className="empty-reader">
      <div className="paper-ghost"><FileText size={34} /></div>
      <div className="eyebrow">LUMEN PAPER</div>
      <h1>读论文，不离开论文。</h1>
      <p>拖入 PDF，或直接在 Chrome 打开一篇论文。Lumen 会安静地待在页边，直到你需要它。</p>
      <button className="primary-button" onClick={onUpload}><Upload size={16} /> 选择 PDF</button>
      <small>Chrome 150 支持 URL 自动接管；Chrome 151+ 使用原生 PDF handler。</small>
    </div>
  );
}

function PanelTabButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return <button type="button" role="tab" aria-selected={active} className={active ? "active" : ""} onClick={onClick}>{icon}{label}</button>;
}

function SummarySection({ title, items, tone = "normal" }: { title: string; items: string[]; tone?: "normal" | "critical" }) {
  return (
    <section className={`summary-section ${tone}`}>
      <h3>{title}</h3>
      <ul>{items.map((item, index) => <li key={index}>{item}</li>)}</ul>
    </section>
  );
}

function Markdown({ text, onPage }: { text: string; onPage: (page: number) => void }) {
  const markdown = useMemo(() => citationMarkdown(normalizeMathDelimiters(text)), [text]);
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { trust: false, strict: false, throwOnError: false, maxExpand: 1000 }]]}
        components={{
          a: ({ href, children }) => {
            if (href?.startsWith("#lumen-page-")) {
              const page = Number(href.replace("#lumen-page-", ""));
              return <button type="button" className="inline-citation" onClick={() => onPage(page)}>{children}</button>;
            }
            return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
          },
          table: ({ children }) => <div className="markdown-table-wrap"><table>{children}</table></div>,
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}

async function discoverSource(
  load: (buffer: ArrayBuffer, source: SourceInfo, cachedPages?: PageText[] | null) => Promise<void>,
): Promise<void> {
  if (window.__LUMEN_TEST_PDF__) {
    await load(window.__LUMEN_TEST_PDF__, { url: "test:paper", name: "Test paper", mimeHandler: false });
    return;
  }
  const params = new URLSearchParams(location.search);
  const sourceUrl = params.get("source");
  if (sourceUrl) {
    const cached = await getCachedPdf(sourceUrl).catch(() => null);
    if (cached) {
      await load(cached.bytes, {
        url: sourceUrl,
        name: fileNameFromUrl(sourceUrl),
        mimeHandler: false,
      }, cached.pages);
      return;
    }
    const buffer = await fetchPdfBuffer(sourceUrl);
    await putCachedPdf(sourceUrl, buffer).catch(() => undefined);
    await load(buffer, {
      url: sourceUrl,
      name: fileNameFromUrl(sourceUrl),
      mimeHandler: false,
    });
    return;
  }

  const mimeHandler = (chrome as typeof chrome & {
    mimeHandler?: { getStreamInfo: () => Promise<{ streamUrl: string; originalUrl: string }> };
  }).mimeHandler;
  if (mimeHandler) {
    try {
      const info = await mimeHandler.getStreamInfo();
      const cached = await getCachedPdf(info.originalUrl).catch(() => null);
      if (cached) {
        await load(cached.bytes, {
          url: info.originalUrl,
          name: fileNameFromUrl(info.originalUrl),
          mimeHandler: true,
        }, cached.pages);
        return;
      }
      const buffer = await fetchPdfBuffer(info.streamUrl);
      await putCachedPdf(info.originalUrl, buffer).catch(() => undefined);
      await load(buffer, {
        url: info.originalUrl,
        name: fileNameFromUrl(info.originalUrl),
        mimeHandler: true,
      });
      return;
    } catch {
      // A normal viewer.html navigation has no MIME stream; fall through.
    }
  }
}

async function fetchPdfBuffer(url: string): Promise<ArrayBuffer> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`无法读取 PDF（HTTP ${response.status}）`);
    return await response.arrayBuffer();
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") {
      throw new Error("读取 PDF 超时，请检查论文来源是否仍可访问。");
    }
    throw cause;
  } finally {
    window.clearTimeout(timeout);
  }
}

function yieldToReader(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

function applySourceFavicon(): void {
  const params = new URLSearchParams(location.search);
  const sourceUrl = params.get("source");
  const favicon = sourceFaviconUrl(params.get("favicon"), sourceUrl);
  if (!favicon) return;
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) return;
  const fallback = `${chrome.runtime.getURL("icons/icon.svg")}?v=3`;
  link.addEventListener("error", () => { link.href = fallback; }, { once: true });
  link.removeAttribute("type");
  link.removeAttribute("sizes");
  link.href = favicon;
}

async function requestAi(payload: AiRequest): Promise<AiResponse> {
  if (!chrome?.runtime?.sendMessage) return { ok: false, error: "扩展后台未连接" };
  return chrome.runtime.sendMessage({ type: "AI_REQUEST", payload }) as Promise<AiResponse>;
}

function fileNameFromUrl(value: string): string {
  try {
    const pathname = new URL(value).pathname;
    return decodeURIComponent(pathname.split("/").filter(Boolean).at(-1) || "Research paper").replace(/\.pdf$/i, "");
  } catch {
    return "Research paper";
  }
}

function preciseSelectionRects(range: Range, pageElement: HTMLElement): DOMRect[] {
  const textLayer = pageElement.querySelector(".textLayer");
  if (!textLayer) return [...range.getClientRects()];

  const rects: DOMRect[] = [];
  const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    if (!(current instanceof Text) || !range.intersectsNode(current)) continue;
    const start = range.startContainer === current ? range.startOffset : 0;
    const end = range.endContainer === current ? range.endOffset : current.data.length;
    const selectedText = current.data.slice(start, end);
    const leadingWhitespace = selectedText.match(/^[\s\u200B\uFEFF]+/u)?.[0].length ?? 0;
    const trailingWhitespace = selectedText.match(/[\s\u200B\uFEFF]+$/u)?.[0].length ?? 0;
    const visibleStart = start + leadingWhitespace;
    const visibleEnd = end - trailingWhitespace;
    if (visibleStart >= visibleEnd) continue;

    const characterRange = document.createRange();
    characterRange.setStart(current, visibleStart);
    characterRange.setEnd(current, visibleEnd);
    rects.push(...characterRange.getClientRects());
  }

  return rects.length ? mergeSelectionLineRects(rects) : [...range.getClientRects()];
}

function alignSelectionRectsToCanvasInk(rects: DOMRect[], pageElement: HTMLElement): DOMRect[] {
  const canvas = pageElement.querySelector<HTMLCanvasElement>("canvas");
  const context = canvas?.getContext("2d");
  const canvasRect = canvas?.getBoundingClientRect();
  if (!canvas || !context || !canvasRect?.width || !canvasRect.height) return rects;

  const scaleX = canvas.width / canvasRect.width;
  const scaleY = canvas.height / canvasRect.height;
  return rects.map((rect) => {
    const x = Math.max(0, Math.floor((rect.left - canvasRect.left) * scaleX));
    const y = Math.max(0, Math.floor((rect.top - canvasRect.top) * scaleY));
    const endX = Math.min(canvas.width, Math.ceil((rect.right - canvasRect.left) * scaleX));
    const endY = Math.min(canvas.height, Math.ceil((rect.bottom - canvasRect.top) * scaleY));
    const width = endX - x;
    const height = endY - y;
    if (width <= 0 || height <= 0) return rect;

    let pixels: Uint8ClampedArray;
    try {
      pixels = context.getImageData(x, y, width, height).data;
    } catch {
      return rect;
    }
    let first = width;
    let last = -1;
    for (let pixelY = 0; pixelY < height; pixelY += 1) {
      for (let pixelX = 0; pixelX < width; pixelX += 1) {
        const offset = (pixelY * width + pixelX) * 4;
        const luminance = pixels[offset] * .2126 + pixels[offset + 1] * .7152 + pixels[offset + 2] * .0722;
        if (pixels[offset + 3] > 0 && luminance < 200) {
          first = Math.min(first, pixelX);
          last = Math.max(last, pixelX);
        }
      }
    }
    if (last < 0) return rect;

    const inkLeft = Math.max(rect.left, canvasRect.left + (x + first) / scaleX);
    const inkRight = Math.min(rect.right, canvasRect.left + (x + last + 1) / scaleX);
    if (inkRight <= inkLeft) return rect;
    const minimumWidth = rect.width * .8;
    if (inkRight - inkLeft >= minimumWidth) {
      return new DOMRect(inkLeft, rect.top, inkRight - inkLeft, rect.height);
    }

    const center = (inkLeft + inkRight) / 2;
    const left = Math.max(rect.left, Math.min(center - minimumWidth / 2, rect.right - minimumWidth));
    return new DOMRect(left, rect.top, minimumWidth, rect.height);
  });
}

function mergeSelectionLineRects(rects: DOMRect[]): DOMRect[] {
  const ordered = rects
    .map((rect) => new DOMRect(rect.left, rect.top, rect.width, rect.height))
    .sort((a, b) => a.top - b.top || a.left - b.left);
  const merged: DOMRect[] = [];

  for (const rect of ordered) {
    const previous = merged.at(-1);
    if (!previous) {
      merged.push(rect);
      continue;
    }
    const verticalOverlap = Math.min(previous.bottom, rect.bottom) - Math.max(previous.top, rect.top);
    const sameLine = verticalOverlap >= Math.min(previous.height, rect.height) * .55;
    const horizontalGap = rect.left - previous.right;
    const joinDistance = Math.max(previous.height, rect.height) * .75;
    if (!sameLine || horizontalGap > joinDistance) {
      merged.push(rect);
      continue;
    }
    const left = Math.min(previous.left, rect.left);
    const top = Math.min(previous.top, rect.top);
    const right = Math.max(previous.right, rect.right);
    const bottom = Math.max(previous.bottom, rect.bottom);
    merged[merged.length - 1] = new DOMRect(left, top, right - left, bottom - top);
  }

  return merged;
}

function intersects(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
