/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { normalizedSelectionText, selectionText, snapSelectionRangeToWords } from "../src/lib/selection";

describe("PDF selection snapshots", () => {
  it("snaps partial Latin endpoints to the words the reader sees", () => {
    const root = document.createElement("div");
    root.textContent = "following the Moonlight [62] architecture. In all";
    const node = root.firstChild as Text;
    const range = document.createRange();
    range.setStart(node, "followin".length);
    range.setEnd(node, "following the Moonlight [62] archi".length);

    const snapped = snapSelectionRangeToWords(range, root);
    expect(normalizedSelectionText(snapped)).toBe("following the Moonlight [62] architecture");
  });

  it("preserves exact word boundaries, punctuation and CJK character selections", () => {
    const cases = [
      { text: "alpha, beta", start: 5, end: 6, expected: "," },
      { text: "alpha beta", start: 6, end: 10, expected: "beta" },
      { text: "这是一个测试", start: 1, end: 3, expected: "是一" },
    ];
    for (const item of cases) {
      const root = document.createElement("div");
      root.textContent = item.text;
      const range = document.createRange();
      range.setStart(root.firstChild!, item.start);
      range.setEnd(root.firstChild!, item.end);
      expect(normalizedSelectionText(snapSelectionRangeToWords(range, root))).toBe(item.expected);
    }
  });

  it("normalizes text-layer whitespace without changing visible characters", () => {
    const root = document.createElement("div");
    root.textContent = "Kimi\u200B  Linear\narchitecture";
    const range = document.createRange();
    range.selectNodeContents(root);
    expect(normalizedSelectionText(range)).toBe("Kimi Linear architecture");
  });

  it("restores spaces omitted between separate PDF.js text spans", () => {
    const root = document.createElement("div");
    root.innerHTML = "<span>discard</span><br role=\"presentation\"><span>nearly</span><span>,</span><span>all</span><span>of</span><span>them</span>";
    const range = document.createRange();
    range.selectNodeContents(root);
    expect(selectionText(range, root)).toBe("discard nearly, all of them");
  });

  it("honors an explicit PDF line break even when geometry resembles a superscript", () => {
    const root = document.createElement("div");
    root.innerHTML = "<span>short</span><br role=\"presentation\"><span>next</span>";
    const spans = [...root.querySelectorAll("span")];
    mockRect(spans[0], 0, 50, 0);
    mockRect(spans[1], 50, 25, 20);
    const range = document.createRange();
    range.selectNodeContents(root);
    expect(selectionText(range, root)).toBe("short next");
  });

  it("does not insert a space after a visible line-end hyphen", () => {
    const root = document.createElement("div");
    root.innerHTML = "<span>contin-</span><br role=\"presentation\"><span>ual</span>";
    const range = document.createRange();
    range.selectNodeContents(root);
    expect(selectionText(range, root)).toBe("contin-ual");
  });

  it("uses visual spacing to distinguish a split word from adjacent words", () => {
    const root = document.createElement("div");
    root.innerHTML = "<span>contin</span><span>ual</span><span>learning</span>";
    const spans = [...root.querySelectorAll("span")];
    mockRect(spans[0], 0, 30);
    mockRect(spans[1], 30, 15);
    mockRect(spans[2], 49, 38);
    const range = document.createRange();
    range.selectNodeContents(root);
    expect(selectionText(range, root)).toBe("continual learning");
  });

  it("uses visual gaps for separate CJK text items on the same line", () => {
    const root = document.createElement("div");
    root.innerHTML = "<span>方法</span><span>结果</span>";
    const spans = [...root.querySelectorAll("span")];
    mockRect(spans[0], 0, 24);
    mockRect(spans[1], 48, 24);
    const range = document.createRange();
    range.selectNodeContents(root);
    expect(selectionText(range, root)).toBe("方法 结果");
  });

  it("measures visual gaps in reading order for RTL text spans", () => {
    const root = document.createElement("div");
    root.innerHTML = "<span dir=\"rtl\">مرحبا</span><span dir=\"rtl\">بالعالم</span>";
    const spans = [...root.querySelectorAll("span")];
    mockRect(spans[0], 70, 20);
    mockRect(spans[1], 45, 20);
    const range = document.createRange();
    range.selectNodeContents(root);
    expect(selectionText(range, root)).toBe("مرحبا بالعالم");
  });
});

function mockRect(element: Element, left: number, width: number, top = 0) {
  Object.defineProperty(element, "getBoundingClientRect", {
    value: () => DOMRect.fromRect({ x: left, y: top, width, height: 12 }),
  });
}
