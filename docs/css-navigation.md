# CSS navigation and ownership guide
This repo has two discovery commands. Use them before any CSS edit.

## Commands

```bash
npm run css:locate -- .value-chip         # class: all rules, load order, !important, TSX hits, tokens
npm run css:locate -- --theme-chip-bg     # token: value + var chain per theme
npm run css:locate -- config.css          # file: route, rule counts, shared classes, top TSX users
npm run css:locate -- ConfigPage.tsx      # component: CSS imports + where its matching rules live
npm run css:map                           # regenerate docs/css-map.md (ownership/hotspot report)
```

`css:locate` is read-only. It answers, in one shot:
- which CSS files/rules target a class, in startup/lazy load order;
- which rules use `!important` and their specificity;
- which TSX files/elements use the class;
- which tokens the declarations depend on and their resolved value per theme;
- co-occurring classes and the component that owns the CSS file.

## Ownership rules (new/changed CSS)

1. Every shared primitive has exactly one owner file. Variants are explicit modifier
   classes in the same owner or an explicitly documented domain override.
2. Before adding a rule to a domain file, run `css:locate` for every class in the
   selector. If the class is already styled in more than one file, add an owner note
   instead of a new competing rule.
3. No new literal paint: use semantic tokens or the fixed palette
   (`--fixed-*`). No new `#hex`/`rgba()` in component CSS.
4. No new `!important`. Existing ones need a `css:locate` justification comment.
5. New component styles should be co-located with the component or in its domain
   file, never in an unrelated partial.
6. After edits: `npm run css:audit`. Budgets live in `scripts/css-budgets.json`.

## Current hotspots (from css:map)

- `.value-chip` / `.value-chip-active`: 7 files each.
- `.config-launch-dock`, `.segment-switch`: 5 files each.
- `!important`: config.css 137, fusion-display.css 76, chrome.css 62, catalog.css 56.

Recommended first ownership target: `.value-chip` / `.value-chip-active` (highest
fan-out and TSX usage), then `.segment-switch`, then the config `!important` cluster.
