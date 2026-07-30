# Changelog

## 0.1.17 — 2026-07-30

- Added System, Bookish and Custom local-font choices to the existing `Aa` menu.
- Persisted the selected font mode and custom family name locally across reader reloads.
- Applied font choices only to AI summaries, chat, notes and their composer while leaving PDF rendering untouched.
- Sanitized custom font names and added an automatic system-font fallback for missing or empty fonts.

## 0.1.16 — 2026-07-30

- Added persistent Comfortable, Wide and Full content-width modes to the existing `Aa` menu.
- Made Wide the default with smaller proportional gutters and a 1160px safety cap.
- Added a true Full mode with only 16px panel gutters and no fixed reading-column cap.
- Kept summary, chat and composer widths aligned in every mode.

## 0.1.15 — 2026-07-30

- Made summary, chat and composer widths grow continuously with the resizable AI panel.
- Replaced the fixed 620px reading column with proportional gutters and a much wider 920px safety cap.
- Kept all three AI surfaces aligned across narrow, medium and wide panel sizes.

## 0.1.14 — 2026-07-30

- Recalibrated Chinese/English mixed typography around the native macOS system font metrics.
- Increased AI body glyph size while tightening leading to remove the floating small-text feeling.
- Reduced the long-form reading measure to 620px and aligned summary, chat and composer widths.
- Rebalanced headings, paragraphs, lists, evidence rows, notes and metadata with a consistent spacing rhythm.
- Removed remaining sub-10px reading metadata where it affected legibility.

## 0.1.13 — 2026-07-30

- Added an explicit Focus mode with `F` / `Esc` shortcuts that temporarily hides AI and secondary controls without changing reader state.
- Added a subtle page-progress line and preserved the previous sidebar state when leaving Focus mode.
- Reworked the reader stage, paper shadows and AI panel with warmer, lower-stimulation materials.
- Increased AI text legibility and constrained long answers to a comfortable reading measure, even in a very wide sidebar.
- Honored `prefers-reduced-motion` for loading, thinking and page-jump animations.

## 0.1.12 — 2026-07-29

- Made research chat the default so questions are no longer forced into paper-only grounding.
- Added a visible Paper/Research context switch and stopped attaching arbitrary paper pages to unrelated questions.
- Added a complete editable Prompt Studio for every natural-language prompt injected by Lumen and the Bridge.
- Added Reader, Agent and explicitly unlocked Full Agent Codex runtime profiles with per-answer runtime receipts.
- Removed the hidden `bounded paper-reading agent` wrapper from the Bridge.
- Forced automatic Paper Brief generation to remain read-only even when chat uses Agent or Full Agent.
- Restricted Bridge origins to Lumen's stable extension ID and authenticated the health endpoint.

## 0.1.11 — 2026-07-29

- Added bounded Codex Web search and self-contained calculation verification.
- Displayed verified tool activity counts in AI answer cards.
- Kept Codex jobs independent across papers while deduplicating identical requests.
- Added dynamic model discovery and separate summary/chat model routing.
- Improved PDF loading, caching, typography, markdown rendering, resizing and page anchors.
- Preserved the source page favicon and paper title in the browser tab.

## 0.1.0 — 2026-07-28

- Initial Chrome extension MVP with PDF.js rendering, Paper Brief, anchored chat, highlights, BYO OpenAI-compatible API and local Codex bridge.
