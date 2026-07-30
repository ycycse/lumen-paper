/* @vitest-environment jsdom */

import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { describe, expect, it } from "vitest";
import { normalizeMathDelimiters } from "../src/lib/markdown";
import { citationMarkdown } from "../src/lib/paper";

function renderMarkdown(markdown: string) {
  return new DOMParser().parseFromString(renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[[rehypeKatex, { trust: false, strict: false, throwOnError: false, maxExpand: 1000 }]]}
    >
      {citationMarkdown(normalizeMathDelimiters(markdown))}
    </ReactMarkdown>,
  ), "text/html");
}

describe("assistant Markdown math rendering", () => {
  it("renders both model-style and Markdown-style inline and display math", () => {
    const document = renderMarkdown([
      "Inline \\(L_{\\mathrm{val}}=f(C)\\) and $\\Delta L / \\Delta C$.",
      "",
      "\\[\\text{模型规模 }N,\\quad \\text{训练数据 }D\\]",
      "",
      "$$",
      "\\mathcal{L}=\\mathbb{E}[R]",
      "$$",
    ].join("\n"));

    expect(document.querySelectorAll(".katex")).toHaveLength(4);
    expect(document.querySelectorAll(".katex-display")).toHaveLength(2);
    expect(document.querySelector(".katex-html")?.textContent?.replace(/\u200b/g, "")).toContain("Lval=f(C)");
  });

  it("keeps code literal while page citations remain interactive links", () => {
    const document = renderMarkdown("Code: `\\(not_math\\)`. Formula: \\(x^2\\). [[p:7]]");
    const code = document.querySelector("code");

    expect(code?.textContent).toBe("\\(not_math\\)");
    expect(code?.querySelector(".katex")).toBeNull();
    expect(document.querySelector('a[href="#lumen-page-7"]')?.textContent).toBe("p.7");
  });

  it("shows invalid TeX without crashing and rejects trusted links", () => {
    const document = renderMarkdown("Bad: $\\notARealCommand{$. Unsafe: $\\href{javascript:alert(1)}{open}$");

    expect(document.querySelector(".katex-error")).not.toBeNull();
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
  });
});
