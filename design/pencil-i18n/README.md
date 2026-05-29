# PassShare i18n Pencil Design (Issue #130)

Machine-readable design inputs for Pencil.dev multilingual frame generation.

## Contents

| File | Purpose |
|------|---------|
| `frames-manifest.yaml` | 30 frames (5 screens × 3 locales × 2 widths) |
| `locale-copy.json` | Generated copy per frame (`pnpm run design:export-copy`) |
| `tokens.json` | Design tokens extracted from `shared/styles/tokens.css` |
| `checklist-results.json` | jp-ui-contracts 7-item pass record |

## Regenerate copy

```bash
pnpm run design:export-copy
```

## Pencil `.pen` file

Binary `.pen` files require the **Pencil MCP** extension (`user-highagency.pencildev-extension-pencil`).

When Pencil MCP is available:

1. Open `design/pencil-i18n/passshare-i18n.pen` in Pencil
2. Run `/user-godd-a/design` with `target: i18n`
3. Use `locale-copy.json` strings and `tokens.json` variables
4. Create frames per `frames-manifest.yaml` (1440px desktop + 375px mobile)
5. Generate Lucide-style icons via Pencil `G()` — **no emoji**

Until MCP is connected, implementation CSS + Playwright visual regression (`e2e/web/i18n-visual.spec.ts`) serve as the design-code alignment gate.

## Screens

Aligned with Visual Regression SSOT:

- `/` landing
- `/docs` documentation index
- `/app/login` sign-in
- `/faq` FAQ
- `/terms` terms of service

## Locales

`ja`, `en`, `ru` — Must languages per [production-i18n.md](../../documents/spec/production-i18n.md).
