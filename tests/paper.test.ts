import { describe, expect, it } from "vitest";
import { defaultUrlTransform } from "react-markdown";
import {
  citationMarkdown,
  hasRelevantPaperContext,
  normalizePageText,
  parseSummary,
  rankRelevantPages,
  selectSummaryPages,
} from "../src/lib/paper";
import {
  DEFAULT_CHAT_TEMPLATE,
  DEFAULT_SUMMARY_TEMPLATE,
  chatPrompt,
  renderPromptTemplate,
  summaryPrompt,
} from "../src/lib/prompts";
import { sourceFaviconUrl } from "../src/lib/favicon";
import { modelsEndpoint, normalizeModelOptions } from "../src/lib/models";
import { normalizeSettings } from "../src/lib/storage";

describe("paper text helpers", () => {
  it("preserves explicit PDF line endings without noisy spaces", () => {
    expect(normalizePageText([
      { str: "A method", hasEOL: true },
      { str: "with evidence" },
    ])).toBe("A method\nwith evidence");
  });

  it("keeps the beginning, conclusion and signaled result pages", () => {
    const pages = Array.from({ length: 20 }, (_, index) => ({
      page: index + 1,
      text: index === 13 ? "Results\nstrong ablation evidence" : `body ${index + 1}`,
    }));
    const selected = selectSummaryPages(pages, 20_000).map(({ page }) => page);
    expect(selected).toContain(1);
    expect(selected).toContain(14);
    expect(selected).toContain(20);
  });

  it("ranks pages lexically and still carries the first page", () => {
    const ranked = rankRelevantPages("speculative decoding latency", [
      { page: 1, text: "title and abstract" },
      { page: 2, text: "training setup" },
      { page: 3, text: "speculative decoding reduces latency and latency variance" },
    ], 1);
    expect(ranked.map(({ page }) => page)).toEqual([1, 3]);
  });

  it("extracts summary JSON even when a provider adds prose", () => {
    const summary = parseSummary(`Here:\n{
      "title":"X","verdict":"Y","contributions":["C"],"method":"M",
      "evidence":[{"claim":"E","page":2}],"limitations":["L"],
      "readingPath":[{"label":"R","page":3,"why":"W"}],"keywords":["K"]
    }\nDone`);
    expect(summary.title).toBe("X");
    expect(summary.evidence[0]).toEqual({ claim: "E", page: 2 });
  });

  it("turns model page anchors into internal links", () => {
    expect(citationMarkdown("claim [[p:12]]")).toBe("claim [p.12](#lumen-page-12)");
    expect(defaultUrlTransform("#lumen-page-12")).toBe("#lumen-page-12");
    expect(defaultUrlTransform("lumen-page://12")).toBe("");
  });

  it("keeps the fixed summary contract while accepting reader preferences", () => {
    const prompt = summaryPrompt(
      [{ page: 1, text: "abstract" }],
      "zh-CN",
      "重点审查数据泄漏",
      DEFAULT_SUMMARY_TEMPLATE,
    );
    expect(prompt).toContain("重点审查数据泄漏");
    expect(prompt).toContain('"evidence"');
    expect(prompt).toContain("--- PAGE 1 ---");
    expect(summaryPrompt([], "zh-CN", "", "")).toBe("");
  });

  it("does not recursively expand template-looking paper content", () => {
    expect(renderPromptTemplate("Q={{question}}", { question: "{{paper_pages}}" })).toBe("Q={{paper_pages}}");
  });

  it("keeps unrelated research chat free of arbitrary paper excerpts", () => {
    const pages = [{ page: 1, text: "robot control with flow matching" }];
    expect(hasRelevantPaperContext("Kimi K3 最近有什么变化？", pages)).toBe(false);
    const messages = chatPrompt("Kimi K3 最近有什么变化？", [], [], DEFAULT_CHAT_TEMPLATE);
    expect(messages[0].content).toContain("No paper excerpts attached");
  });

  it("preserves the source page favicon without leaking a previous site's icon", () => {
    expect(sourceFaviconUrl(
      "https://static.arxiv.org/icons/favicon.ico",
      "https://arxiv.org/pdf/2501.00001",
      "https://arxiv.org/abs/2501.00001",
    )).toBe("https://static.arxiv.org/icons/favicon.ico");
    expect(sourceFaviconUrl(
      "https://google.com/favicon.ico",
      "https://arxiv.org/pdf/2501.00001",
      "https://google.com/search?q=paper",
    )).toBe("https://arxiv.org/favicon.ico");
    expect(sourceFaviconUrl(null, "file:///tmp/paper.pdf")).toBe("");
  });

  it("derives a standard models endpoint from compatible chat APIs", () => {
    expect(modelsEndpoint("https://api.openai.com/v1/chat/completions")).toBe("https://api.openai.com/v1/models");
    expect(modelsEndpoint("https://openrouter.ai/api/v1/chat/completions?x=1")).toBe("https://openrouter.ai/api/v1/models");
    expect(modelsEndpoint("http://localhost:11434/v1/responses")).toBe("http://localhost:11434/v1/models");
  });

  it("normalizes and prioritizes model catalog entries", () => {
    expect(normalizeModelOptions({ data: [
      { id: "slow", displayName: "Slow" },
      { id: "fast", displayName: "Fast", isDefault: true },
      { id: "fast" },
    ] })).toEqual([
      { id: "fast", name: "Fast", description: undefined, isDefault: true },
      { id: "slow", name: "Slow", description: undefined, isDefault: false },
    ]);
  });

  it("migrates the former single model setting into summary and chat models", () => {
    const settings = normalizeSettings({ model: "legacy-api", codexModel: "legacy-codex" });
    expect(settings.summaryModel).toBe("legacy-api");
    expect(settings.chatModel).toBe("legacy-api");
    expect(settings.codexSummaryModel).toBe("legacy-codex");
    expect(settings.codexChatModel).toBe("legacy-codex");
    expect(settings.codexWebSearch).toBe(true);
    expect(settings.codexCalculations).toBe(true);
    expect(settings.chatMode).toBe("research");
    expect(settings.codexPermissionMode).toBe("reader");
    expect(settings.codexWorkspace).toBe("");
  });

  it("preserves the workspace used by Codex Agent requests", () => {
    const settings = normalizeSettings({ codexWorkspace: "/tmp/lumen-workspace" });
    expect(settings.codexWorkspace).toBe("/tmp/lumen-workspace");
  });

  it("preserves explicitly empty prompt fields during migration", () => {
    const settings = normalizeSettings({ researchSystemPrompt: "", codexRuntimePrompt: "" });
    expect(settings.researchSystemPrompt).toBe("");
    expect(settings.codexRuntimePrompt).toBe("");
  });
});
