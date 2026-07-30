import type { PaperSummary } from "../types";

export interface PageText {
  page: number;
  text: string;
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "are", "was", "were", "into",
  "what", "how", "why", "does", "paper", "model", "method", "using", "use", "can", "could",
  "一个", "这个", "论文", "什么", "如何", "为什么", "是否", "以及", "我们", "作者", "方法",
]);

export function normalizePageText(items: Array<{ str?: string; hasEOL?: boolean }>): string {
  let text = "";
  for (const item of items) {
    const value = item.str?.trim();
    if (!value) continue;
    text += `${value}${item.hasEOL ? "\n" : " "}`;
  }
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function selectSummaryPages(pages: PageText[], maxChars = 56_000): PageText[] {
  if (pages.length <= 12) return trimToBudget(pages, maxChars);
  const first = pages.slice(0, 8);
  const last = pages.slice(-4);
  const middleSignals = pages.filter(({ text, page }) => {
    if (page <= 8 || page > pages.length - 4) return false;
    return /\b(conclusion|discussion|experiment|evaluation|result|limitation)s?\b/i.test(text.slice(0, 800));
  });
  const unique = new Map<number, PageText>();
  [...first, ...middleSignals.slice(0, 5), ...last].forEach((page) => unique.set(page.page, page));
  return trimToBudget([...unique.values()].sort((a, b) => a.page - b.page), maxChars);
}

export function rankRelevantPages(query: string, pages: PageText[], limit = 5): PageText[] {
  const terms = tokenize(query);
  const scored = pages.map((page) => {
    const lower = page.text.toLowerCase();
    const score = terms.reduce((sum, term) => {
      const matches = lower.split(term).length - 1;
      return sum + Math.min(matches, 8) * (term.length > 5 ? 2 : 1);
    }, 0);
    return { page, score };
  });
  const selected = scored
    .sort((a, b) => b.score - a.score || a.page.page - b.page.page)
    .slice(0, limit)
    .map(({ page }) => page);
  if (!selected.some(({ page }) => page === 1) && pages[0]) selected.push(pages[0]);
  return trimToBudget(selected.sort((a, b) => a.page - b.page), 32_000);
}

export function hasRelevantPaperContext(query: string, pages: PageText[]): boolean {
  if (/\b(this|the)\s+paper\b|论文|本文|作者|文中|实验|消融|表格|图\s*\d|第\s*\d+\s*页/i.test(query)) return true;
  const terms = tokenize(query);
  if (!terms.length) return false;
  return terms.some((term) => pages.some(({ text }) => text.toLowerCase().includes(term)));
}

export function parseSummary(raw: string): PaperSummary {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("AI 没有返回可解析的摘要 JSON");
  const value = JSON.parse(raw.slice(start, end + 1)) as Partial<PaperSummary>;
  return {
    title: String(value.title || "Untitled paper"),
    verdict: String(value.verdict || ""),
    contributions: safeStrings(value.contributions),
    method: String(value.method || ""),
    evidence: Array.isArray(value.evidence)
      ? value.evidence
          .filter((item) => item && Number.isFinite(Number(item.page)))
          .map((item) => ({ claim: String(item.claim || ""), page: Number(item.page) }))
      : [],
    limitations: safeStrings(value.limitations),
    readingPath: Array.isArray(value.readingPath)
      ? value.readingPath
          .filter((item) => item && Number.isFinite(Number(item.page)))
          .map((item) => ({
            label: String(item.label || "Read"),
            page: Number(item.page),
            why: String(item.why || ""),
          }))
      : [],
    keywords: safeStrings(value.keywords),
  };
}

export function citationMarkdown(text: string): string {
  return text.replace(/\[\[p:(\d+)\]\]/g, "[p.$1](#lumen-page-$1)");
}

function tokenize(query: string): string[] {
  const english = query.toLowerCase().match(/[a-z0-9_-]{3,}/g) ?? [];
  const chinese = query.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  return [...new Set([...english, ...chinese].filter((term) => !STOPWORDS.has(term)))];
}

function trimToBudget(pages: PageText[], maxChars: number): PageText[] {
  const nonEmpty = pages.filter(({ text }) => text.trim());
  if (!nonEmpty.length) return [];
  const perPage = Math.max(1_500, Math.floor(maxChars / nonEmpty.length));
  return nonEmpty.map((page) => ({ ...page, text: page.text.slice(0, perPage) }));
}

function safeStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}
