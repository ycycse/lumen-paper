import { describe, expect, it } from "vitest";
import { normalizeMathDelimiters } from "../src/lib/markdown";

describe("LaTeX Markdown delimiter normalization", () => {
  it("normalizes paired inline and display delimiters while preserving dollars", () => {
    const input = String.raw`Inline \(E = mc^2\) and $a+b$.

\[\sum_i x_i\]

Existing $$c+d$$ stays unchanged.`;
    expect(normalizeMathDelimiters(input)).toBe(
      String.raw`Inline $E = mc^2$ and $a+b$.

$$
\sum_i x_i
$$

Existing $$c+d$$ stays unchanged.`,
    );
  });

  it("supports display delimiters across ordinary lines", () => {
    const input = String.raw`Before
\[
\begin{aligned}
x &= 1 \\
y &= 2
\end{aligned}
\]
After`;
    const expected = String.raw`Before

$$
\begin{aligned}
x &= 1 \\
y &= 2
\end{aligned}
$$

After`;
    expect(normalizeMathDelimiters(input)).toBe(expected);
  });

  it("does not normalize inline code spans with arbitrary backtick lengths", () => {
    const singleBacktickCode = "`" + String.raw`\(code\)` + "`";
    const doubleBacktickCode = "``" + String.raw`\[code with ` + "`" + String.raw` tick\]` + "``";
    const input = [
      `${String.raw`Keep \(real\), `}${singleBacktickCode}, and ${doubleBacktickCode}.`,
      String.raw`Also $5 and $10 stay currency.`,
    ].join("\n");
    const expected = [
      `Keep $real$, ${singleBacktickCode}, and ${doubleBacktickCode}.`,
      String.raw`Also $5 and $10 stay currency.`,
    ].join("\n");
    expect(normalizeMathDelimiters(input)).toBe(expected);
  });

  it("does not normalize backtick or tilde fenced blocks", () => {
    const input = [
      String.raw`\(outside\)`,
      "```tex",
      String.raw`\(inside\) and \[inside\]`,
      "```",
      "~~~",
      String.raw`\(inside tilde\)`,
      "~~~~",
      String.raw`\[outside\]`,
    ].join("\n");
    const expected = [
      "$outside$",
      "```tex",
      String.raw`\(inside\) and \[inside\]`,
      "```",
      "~~~",
      String.raw`\(inside tilde\)`,
      "~~~~",
      "",
      "$$",
      "outside",
      "$$",
    ].join("\n");
    expect(normalizeMathDelimiters(input)).toBe(expected);
  });

  it("does not normalize four-column indented code", () => {
    const input = [
      String.raw`\(outside\)`,
      String.raw`    \(four spaces\)`,
      ` \t${String.raw`\[space tab\]`}`,
      `\t${String.raw`\(tab\)`}`,
      String.raw`\[outside\]`,
    ].join("\n");
    const expected = [
      "$outside$",
      String.raw`    \(four spaces\)`,
      ` \t${String.raw`\[space tab\]`}`,
      `\t${String.raw`\(tab\)`}`,
      "",
      "$$",
      "outside",
      "$$",
    ].join("\n");
    expect(normalizeMathDelimiters(input)).toBe(expected);
  });

  it("preserves unmatched and escaped bracket delimiters", () => {
    const inlineCode = "`" + String.raw`\(code\)` + "`";
    const crossingCode = "`crossing`";
    const input = [
      String.raw`Unmatched \(x and y\].`,
      String.raw`Escaped \\(x\\) and \\[y\\].`,
      `A protected ${inlineCode} prevents ${String.raw`\(pair `}${crossingCode}${String.raw` code\).`}`,
    ].join("\n");
    expect(normalizeMathDelimiters(input)).toBe(input);
  });

  it("leaves plain Markdown and currency byte-for-byte unchanged", () => {
    const input = "Cost is $5, not $10. **Bold**, [link](https://example.com), and [[p:3]].";
    expect(normalizeMathDelimiters(input)).toBe(input);
  });
});
