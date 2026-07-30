const LATIN_WORD = /[\p{Script=Latin}\p{N}]/u;
const FALLBACK_WORD = /[\p{Script=Latin}\p{M}\p{N}_'’]+/gu;
const INVISIBLE_OR_SPACE = /[\s\u200B\uFEFF]+/gu;

export function snapSelectionRangeToWords(range: Range, root: Node): Range {
  const snapped = range.cloneRange();
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return snapped;
  if (range.startContainer instanceof Text) {
    snapped.setStart(range.startContainer, snapOffset(range.startContainer.data, range.startOffset, "start"));
  }
  if (range.endContainer instanceof Text) {
    snapped.setEnd(range.endContainer, snapOffset(range.endContainer.data, range.endOffset, "end"));
  }
  return snapped;
}

export function normalizedSelectionText(range: Range): string {
  return range.toString().replace(INVISIBLE_OR_SPACE, " ").trim();
}

export function selectionText(range: Range, root: Node): string {
  const chunks: SelectionChunk[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    if (!(current instanceof Text) || !range.intersectsNode(current)) continue;
    const start = range.startContainer === current ? range.startOffset : 0;
    const end = range.endContainer === current ? range.endOffset : current.data.length;
    if (start >= end) continue;
    chunks.push({
      text: current.data.slice(start, end),
      node: current,
      rects: selectedRects(current, start, end),
    });
  }
  if (!chunks.length) return normalizedSelectionText(range);

  let value = chunks[0].text;
  for (let index = 1; index < chunks.length; index += 1) {
    value += separatorBetween(chunks[index - 1], chunks[index]) + chunks[index].text;
  }
  return value.replace(INVISIBLE_OR_SPACE, " ").trim();
}

type SelectionChunk = {
  text: string;
  node: Text;
  rects: DOMRect[];
};

function selectedRects(node: Text, start: number, end: number): DOMRect[] {
  const fragment = document.createRange();
  fragment.setStart(node, start);
  fragment.setEnd(node, end);
  if (typeof fragment.getClientRects === "function") {
    const rects = [...fragment.getClientRects()].filter(({ width, height }) => width > 0 && height > 0);
    if (rects.length) return rects;
  }
  const rect = node.parentElement?.getBoundingClientRect();
  return rect && rect.width > 0 && rect.height > 0 ? [rect] : [];
}

function separatorBetween(previous: SelectionChunk, next: SelectionChunk): string {
  if (/\s$/u.test(previous.text) || /^\s/u.test(next.text)) return "";
  const left = previous.text.at(-1) ?? "";
  const right = next.text[0] ?? "";
  if (!left || !right || noSpaceAround(left, right)) return "";
  if (hasLineBreakBetween(previous.node, next.node)) {
    if (/[-‐‑‒–—]$/u.test(previous.text)) return "";
    return isCjk(left) && isCjk(right) ? "" : " ";
  }

  const previousRect = previous.rects.at(-1);
  const nextRect = next.rects[0];
  if (!previousRect || !nextRect) {
    if (previous.node.parentElement === next.node.parentElement) return "";
    return isCjk(left) && isCjk(right) ? "" : " ";
  }

  const height = Math.max(1, Math.min(previousRect.height, nextRect.height));
  const verticalOverlap = Math.min(previousRect.bottom, nextRect.bottom) - Math.max(previousRect.top, nextRect.top);
  const sameLine = verticalOverlap >= height * .42;
  const direction = textDirection(previous, next);
  const gap = direction === "rtl"
    ? previousRect.left - nextRect.right
    : nextRect.left - previousRect.right;
  const adjacentThreshold = Math.max(.75, height * .1);
  if (sameLine) return gap > adjacentThreshold ? " " : "";

  // Superscripts and subscripts sit off the baseline but remain horizontally adjacent.
  if (Math.abs(gap) <= Math.max(1.5, height * .25)) return "";
  if (/[-‐‑‒–—]$/u.test(previous.text)) return "";
  return isCjk(left) && isCjk(right) ? "" : " ";
}

function hasLineBreakBetween(previous: Text, next: Text): boolean {
  try {
    const between = document.createRange();
    between.setStartAfter(previous);
    between.setEndBefore(next);
    return Boolean(between.cloneContents().querySelector("br"));
  } catch {
    return false;
  }
}

function noSpaceAround(left: string, right: string): boolean {
  return /[(\[{“‘]/u.test(left)
    || /[,.;:!?%\])}，。！？；：、”’]/u.test(right);
}

function textDirection(previous: SelectionChunk, next: SelectionChunk): "ltr" | "rtl" {
  const declared = previous.node.parentElement?.closest("span")?.dir
    || next.node.parentElement?.closest("span")?.dir;
  if (declared === "rtl") return "rtl";
  if (declared === "ltr") return "ltr";
  return /[\p{Script=Arabic}\p{Script=Hebrew}]/u.test(previous.text + next.text) ? "rtl" : "ltr";
}

function isCjk(value: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value);
}

function snapOffset(text: string, offset: number, edge: "start" | "end"): number {
  if (offset <= 0 || offset >= text.length) return offset;
  const segment = wordSegmentAt(text, offset);
  if (!segment || !LATIN_WORD.test(segment.text)) return offset;
  return edge === "start" ? segment.start : segment.end;
}

function wordSegmentAt(text: string, offset: number): { start: number; end: number; text: string } | null {
  if (typeof Intl.Segmenter === "function") {
    const segments = new Intl.Segmenter(undefined, { granularity: "word" }).segment(text);
    for (const segment of segments) {
      const start = segment.index;
      const end = start + segment.segment.length;
      if (segment.isWordLike && start < offset && offset < end) {
        return { start, end, text: segment.segment };
      }
    }
    return null;
  }
  for (const match of text.matchAll(FALLBACK_WORD)) {
    const start = match.index;
    const end = start + match[0].length;
    if (start < offset && offset < end) return { start, end, text: match[0] };
  }
  return null;
}
