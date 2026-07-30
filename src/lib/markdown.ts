/**
 * Normalize LaTeX-style bracket delimiters for remark-math without touching
 * Markdown code. Existing dollar delimiters are intentionally left alone.
 */
export function normalizeMathDelimiters(markdown: string): string {
  if (!markdown.includes("\\")) return markdown;

  const protectedCharacters = markdownCodeMask(markdown);
  const lineEnding = markdown.includes("\r\n") ? "\r\n" : "\n";
  let normalized = "";
  let index = 0;

  while (index < markdown.length) {
    const delimiter = openingDelimiterAt(markdown, protectedCharacters, index);
    if (!delimiter) {
      normalized += markdown[index];
      index += 1;
      continue;
    }

    const closingIndex = findClosingDelimiter(
      markdown,
      protectedCharacters,
      index + 2,
      delimiter.close,
    );
    if (closingIndex < 0) {
      normalized += markdown.slice(index, index + 2);
      index += 2;
      continue;
    }

    const content = markdown.slice(index + 2, closingIndex);
    if (delimiter.display) {
      normalized += paragraphBoundaryBefore(normalized, lineEnding);
      normalized += `$$${lineEnding}`;
      normalized += trimOuterLineEndings(content);
      normalized += `${lineEnding}$$`;
      normalized += paragraphBoundaryAfter(markdown, closingIndex + 2, lineEnding);
    } else {
      normalized += `$${content}$`;
    }
    index = closingIndex + 2;
  }

  return normalized;
}

interface Delimiter {
  close: ")" | "]";
  display: boolean;
}

function openingDelimiterAt(markdown: string, protectedCharacters: boolean[], index: number): Delimiter | null {
  if (
    protectedCharacters[index] ||
    protectedCharacters[index + 1] ||
    markdown[index] !== "\\" ||
    isEscapedBackslash(markdown, index)
  ) {
    return null;
  }
  if (markdown[index + 1] === "(") return { close: ")", display: false };
  if (markdown[index + 1] === "[") return { close: "]", display: true };
  return null;
}

function paragraphBoundaryBefore(output: string, lineEnding: string): string {
  if (!output || /(?:\r\n|\n|\r){2}$/.test(output)) return "";
  if (/(?:\r\n|\n|\r)$/.test(output)) return lineEnding;
  return lineEnding + lineEnding;
}

function paragraphBoundaryAfter(markdown: string, index: number, lineEnding: string): string {
  if (index >= markdown.length || /^(?:\r\n|\n|\r){2}/.test(markdown.slice(index))) return "";
  if (/^(?:\r\n|\n|\r)/.test(markdown.slice(index))) return lineEnding;
  return lineEnding + lineEnding;
}

function trimOuterLineEndings(value: string): string {
  return value
    .replace(/^(?:\r\n|\n|\r)+/, "")
    .replace(/(?:\r\n|\n|\r)+$/, "");
}

function findClosingDelimiter(
  markdown: string,
  protectedCharacters: boolean[],
  start: number,
  close: ")" | "]",
): number {
  for (let index = start; index < markdown.length - 1; index += 1) {
    // A math pair must not cross an inline or block code region. Otherwise the
    // converted dollar pair could make code part of the formula.
    if (protectedCharacters[index]) return -1;
    if (
      markdown[index] === "\\" &&
      markdown[index + 1] === close &&
      !protectedCharacters[index + 1] &&
      !isEscapedBackslash(markdown, index)
    ) {
      return index;
    }
  }
  return -1;
}

function isEscapedBackslash(value: string, index: number): boolean {
  let precedingBackslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    precedingBackslashes += 1;
  }
  return precedingBackslashes % 2 === 1;
}

function markdownCodeMask(markdown: string): boolean[] {
  const protectedCharacters = Array<boolean>(markdown.length).fill(false);
  markBlockCode(markdown, protectedCharacters);
  markInlineCode(markdown, protectedCharacters);
  return protectedCharacters;
}

function markBlockCode(markdown: string, protectedCharacters: boolean[]): void {
  let fence: { marker: "`" | "~"; length: number } | null = null;
  let lineStart = 0;

  while (lineStart < markdown.length) {
    const newline = markdown.indexOf("\n", lineStart);
    const lineEnd = newline < 0 ? markdown.length : newline;
    const protectedEnd = newline < 0 ? lineEnd : lineEnd + 1;
    const line = markdown.slice(lineStart, lineEnd).replace(/\r$/, "");

    if (fence) {
      markRange(protectedCharacters, lineStart, protectedEnd);
      if (isClosingFence(line, fence)) fence = null;
    } else {
      const openingFence = parseOpeningFence(line);
      if (openingFence) {
        fence = openingFence;
        markRange(protectedCharacters, lineStart, protectedEnd);
      } else if (isIndentedCodeLine(line)) {
        markRange(protectedCharacters, lineStart, protectedEnd);
      }
    }

    if (newline < 0) break;
    lineStart = newline + 1;
  }
}

function parseOpeningFence(line: string): { marker: "`" | "~"; length: number } | null {
  const match = /^( {0,3})(`{3,}|~{3,})/.exec(line);
  if (!match) return null;
  const run = match[2];
  return { marker: run[0] as "`" | "~", length: run.length };
}

function isClosingFence(line: string, fence: { marker: "`" | "~"; length: number }): boolean {
  const match = /^( {0,3})(`+|~+)[ \t]*$/.exec(line);
  return Boolean(match && match[2][0] === fence.marker && match[2].length >= fence.length);
}

function isIndentedCodeLine(line: string): boolean {
  let columns = 0;
  for (const character of line) {
    if (character === " ") {
      columns += 1;
    } else if (character === "\t") {
      columns += 4 - (columns % 4);
    } else {
      break;
    }
    if (columns >= 4) return true;
  }
  return false;
}

function markInlineCode(markdown: string, protectedCharacters: boolean[]): void {
  let index = 0;
  while (index < markdown.length) {
    if (protectedCharacters[index] || markdown[index] !== "`") {
      index += 1;
      continue;
    }

    const runLength = countRun(markdown, index, "`");
    const closingIndex = findClosingBacktickRun(markdown, protectedCharacters, index + runLength, runLength);
    if (closingIndex < 0) {
      index += runLength;
      continue;
    }

    markRange(protectedCharacters, index, closingIndex + runLength);
    index = closingIndex + runLength;
  }
}

function findClosingBacktickRun(
  markdown: string,
  protectedCharacters: boolean[],
  start: number,
  expectedLength: number,
): number {
  let index = start;
  while (index < markdown.length) {
    if (protectedCharacters[index]) return -1;
    if (markdown[index] !== "`") {
      index += 1;
      continue;
    }
    const runLength = countRun(markdown, index, "`");
    if (runLength === expectedLength) return index;
    index += runLength;
  }
  return -1;
}

function countRun(value: string, start: number, character: string): number {
  let end = start;
  while (end < value.length && value[end] === character) end += 1;
  return end - start;
}

function markRange(mask: boolean[], start: number, end: number): void {
  for (let index = start; index < end; index += 1) mask[index] = true;
}
