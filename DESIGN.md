---
name: alate
description: "Galley Proof: the agent-data repo as a newsprint proof sheet — ink on paper, red for corrections, blue for the reader's pencil."
colors:
  primary: "#c2311f"
  primary-wash: "#fbe8e4"
  secondary: "#2f6fd0"
  secondary-wash: "#e6eefa"
  paper: "#f7f7f4"
  sheet: "#ffffff"
  ink: "#161616"
  ink-soft: "#5b5b57"
  rule: "#d8d8d2"
  rule-soft: "#ebebe5"
  line-number: "#a8a8a1"
typography:
  display:
    fontFamily: "Source Serif 4, Georgia, serif"
    fontSize: "clamp(2rem, 4vw, 2.7rem)"
    fontWeight: 650
    lineHeight: 1.08
    letterSpacing: "-0.025em"
  headline:
    fontFamily: "Source Serif 4, Georgia, serif"
    fontSize: "clamp(1.6rem, 2.4vw, 2.15rem)"
    fontWeight: 650
    lineHeight: 1.12
    letterSpacing: "-0.022em"
  title:
    fontFamily: "Source Serif 4, Georgia, serif"
    fontSize: "1.3rem"
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "-0.015em"
  body:
    fontFamily: "Source Serif 4, Georgia, serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.55
  meta:
    fontFamily: "JetBrains Mono, ui-monospace, Consolas, monospace"
    fontSize: "0.78rem"
    fontWeight: 400
    lineHeight: 1.5
  code:
    fontFamily: "JetBrains Mono, ui-monospace, Consolas, monospace"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.75
rounded:
  none: "0"
spacing:
  xs: "0.25rem"
  sm: "0.5rem"
  md: "1rem"
  lg: "1.5rem"
  xl: "2.5rem"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: "0.62rem 1.1rem"
  button-primary-hover:
    backgroundColor: "#000000"
    textColor: "{colors.paper}"
    rounded: "{rounded.none}"
    padding: "0.62rem 1.1rem"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "0.62rem 1.1rem"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.primary}"
    rounded: "{rounded.none}"
    padding: "0.62rem 1.1rem"
  input-text:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.code}"
    rounded: "{rounded.none}"
    padding: "0.5rem 0.1rem"
---

# Design System: alate — Galley Proof

## Overview

**Creative North Star: "The Galley Proof"**

Every edit to agent-data is a correction on a galley proof. The page sits on a newsprint ground (`--paper`); the working surface is a white galley sheet. Black ink carries all structure. Two inks do the talking: proof red marks what changed or broke, non-repro blue marks where the reader acts — selection, focus, links, the open place. Sections separate by ruled hairlines, the way a proof sheet does, never by cards or panels.

The world refuses the code-editor default: no grey tree chrome, no tab strip, no blue action button. It also refuses the old dark catalog record. Density is print-like and confident: serif body text at comfortable measure (68–70ch max), mono reserved for paths, counts, versions, and the file text itself. Navigation is typographic — an underline or a 2px ink rule carries state, not a fill or a pill.

**Key Characteristics:**
- Newsprint paper ground with a single white sheet per view.
- Hairline rules (1px) for list separation, 2px solid ink for structural edges.
- Proof red (#c2311f) strictly for changes and errors; non-repro blue (#2f6fd0) strictly for interaction.
- Square corners everywhere; border-radius 0 on every element.
- Source Serif 4 for reading and headings; JetBrains Mono for paths, counts, versions, and file text.
- Depth comes from paper edges and washes, never from drop shadows.

## Colors

The palette is print: warm paper, near-black ink, and two working inks with pale washes for fills. Coolness lives only in the two inks; everything structural is warm grey.

### Primary
- **Proof Red** (#c2311f): changes, errors, dirty-file marks, "ready to update" states, the editor caret. It says *this differs* — never decoration, never links.
- **Proof Red Wash** (#fbe8e4): changed-line background in the editor, danger-button hover.

### Secondary
- **Non-Repro Blue** (#2f6fd0): links, focus rings, selection, active nav tab, the current file in the index, the focused editor inset. It says *you are here / you can act*.
- **Non-Repro Blue Wash** (#e6eefa): text selection background, current-file row background.

### Neutral
- **Newsprint** (#f7f7f4): page ground; masthead, press bar, and index chrome.
- **Galley Sheet** (#ffffff): the white working sheet — overview content and editor surface.
- **Ink** (#161616): body text, structural 2px rules, primary button fill, checked segment fill.
- **Ink Soft** (#5b5b57): secondary text, labels, placeholders, hints.
- **Rule** (#d8d8d2): 1px hairline list dividers, quiet borders.
- **Rule Soft** (#ebebe5): hover row background on index entries.
- **Line Number** (#a8a8a1): editor gutter numerals only.

### Named Rules
**The Two-Ink Rule.** Proof red marks change and error; non-repro blue marks interaction. Never swap them: a link is never red, an error is never blue, and neither ink appears as ordinary decoration.

**The Hairline Rule.** Separation is a rule, not a box. Lists, tables, key–value pairs, and margin marks divide with 1px `--rule`; only the sheet's top edge, the masthead, section heads, and the press bar earn 2px solid ink.

## Typography

**Display/Body Font:** Source Serif 4 (self-hosted woff2; Georgia fallback)
**Code/Label Font:** JetBrains Mono (self-hosted woff2; ui-monospace fallback)

**Character:** A serif proof sheet with a typewriter margin. The serif reads like print and carries all hierarchy through weight (650 vs 400), never through color. The mono is the working voice: every path, count, version, sha, and line of file text.

### Hierarchy
- **Display** (650, clamp(2rem, 4vw, 2.7rem), 1.08, -0.025em): onboarding headline only.
- **Headline** (650, clamp(1.6rem, 2.4vw, 2.15rem), 1.12): sheet h1 — view title, open file path.
- **Title** (650, 1.3rem, 1.2): overview section heads, always sitting on a 2px ink rule; wordmark (700, 1.45rem).
- **Body** (400, 1rem, 1.55): serif reading text; ledes capped at 68ch, notes at 70ch.
- **Label/Meta** (400–500, 0.78rem, mono): source line, counts, asides, table metadata. Counts use `tabular-nums`.
- **Code** (400, 0.8125rem, 1.75): file text in the editor and path fields; line-height 1.75 aligns the line-number gutter.

### Named Rules
**The Weight Rule.** Hierarchy comes from serif weight and rule thickness. Text is never colored to gain importance; only the Two-Ink Rule grants color.

## Layout

The page is a fixed masthead over a two-column desk: an 18.5rem file index (right hairline border) and the galley. The galley centers a sheet at max-width 76rem with 2rem/2.5rem padding. While editing, the desk becomes editor (1fr) plus a 15rem proof margin; the press bar pins under the galley. The index is a column of `<details>` groups, each headed by a 600-weight serif summary over a 1px ink rule (closed groups fall back to `--rule`).

Spacing sits on a rem rhythm of 0.25 / 0.5 / 1 / 1.5 / 2.5rem. Section blocks (`part`) stack at 2.6rem. Entry rows are three-column grids (name 12–22rem / description / right-aligned mono aside) with 1px rule dividers.

Responsive: at ≤900px the margin collapses to a stacked strip, the index becomes a slide-over drawer (width min(22rem, 88vw)), the source line hides, and the sheet tightens to 1rem side padding. At ≤520px the wordmark text drops, leaving the logo. `prefers-reduced-motion` removes all transitions.

## Elevation & Depth

Depth is paper on a desk, expressed by edges and washes — not by elevation. The sheet reads as a lighter, whiter paper than the ground; hairline 1px box-shadows built from `--rule` draw its side edges (an edge, not a glow). Focused editing adds an inset 1px blue-wash rim. Changed lines carry a red-wash band extended by matched box-shadows. Deleted-line boundaries are 2px red rules. There is no drop-shadow vocabulary.

### Named Rules
**The No-Shadow Rule.** Shadows never imply elevation. Any box-shadow value must draw an edge (hairline in `--rule`) or extend a wash; a soft blurred shadow has no place in this world. The mobile index drawer separates from the sheet with a 2px ink rule, not a shadow.

## Shapes

Square, always: `border-radius: 0` on buttons, inputs, segments, tables, sheets. Form language comes from rules and washes instead of corners: an input is a bottom border that thickens on focus; a segmented control is cells divided by 1px ink borders, the checked cell filled solid ink; markers are small rotated-square proof marks (0.42rem, 1.5px red border) in the index and the change list.

## Components

### Buttons
- **Shape:** square (0 radius), 1px solid ink border, serif 600 at 0.9375rem.
- **Primary:** ink fill, paper text, 0.62rem × 1.1rem padding. Hover: pure black fill. Active: 1px press down.
- **Quiet:** transparent, ink text, `--rule` border; hover darkens border to ink.
- **Danger:** transparent, red text and border (currentColor); hover fills red wash.
- **Disabled:** transparent, `--ink-soft` text, `--rule` border, no transform.
- **Linkish:** borderless blue underlined text button matching link metrics (offset 0.18em, 1px thick).

### Inputs / Fields
- **Style:** borderless except a 1px bottom border in `--ink-soft`; transparent on paper; mono 0.875rem.
- **Hover:** bottom border darkens to ink.
- **Focus:** bottom border becomes 2px blue (padding compensated), no outline, no glow.
- **Error:** message text in red below the field; the field keeps its underline.

### Navigation
Masthead tabs: 500-weight serif, full-height hit area, state carried by a 3px bottom border — transparent at rest, `--rule` on hover, blue on the current page (with blue text). Red mono counts sit beside a tab when work waits.

### Segmented Control
Inline row of cells divided by 1px ink borders. Checked cell: ink fill, paper text. Focus-visible: 2px blue outline on the cell. Labels are hidden for assistive tech; the visible cells are the control.

### Sheet (the galley)
White `--sheet` surface, max-width 76rem, top edge 2px ink while editing with hairline side edges. Inside: headline, mono meta line, serif lede, then ruled sections. This is the only "card" the world has, and it spans the column.

### Proof Margin (signature component)
A 15rem column beside the editor. Each mark: 2px red left border, 600-weight red serif text naming the change, then a mono quote of the old text prefixed `was: `. Marks align to changed lines via absolute `top`; they animate 150ms ease-out. This margin is the memorable moment — the user reads the push before making it.

### Editor (backdrop + textarea stack)
Transparent textarea stacked over a backdrop that draws line numbers (`tabular-nums`, gutter 3.6em) and per-line change bands. Identical metrics keep the layers aligned: mono 0.8125rem / 1.75, tab-size 4, pre-wrap. Caret is red — the pen, not the error.

### Updates Table
Full-width, collapsed borders. Header: 600 serif 0.82rem on paper, sticky, over a 2px ink rule. Rows divided by 1px rules; names and versions in mono with tabular numerals; "ready" states in red 600; errors in red mono.

## Do's and Don'ts

### Do:
- **Do** use `tabular-nums` on every mono count, version, and line number.
- **Do** separate with hairlines: 1px `--rule` between rows, 2px ink for structural edges only.
- **Do** mark change with red and interaction with blue, per the Two-Ink Rule.
- **Do** keep corners square (`border-radius: 0`) on every new control.
- **Do** keep focus visible: 2px blue outline with 2px offset, or the 2px blue underline on inputs.

### Don't:
- **Don't** add drop shadows or elevated cards; the sheet's paper edge and washes are the whole depth model.
- **Don't** use blue for errors or red for links, hover, or decoration.
- **Don't** round corners or add pill/chip fills; state lives in borders, rules, and washes.
- **Don't** introduce a third typeface or color text for hierarchy; use serif weight and rules.
- **Don't** replace text labels with color alone; category and state always name themselves in text.
- **Don't** lift an overlay with a soft shadow; the mobile drawer uses a 2px ink rule instead.
