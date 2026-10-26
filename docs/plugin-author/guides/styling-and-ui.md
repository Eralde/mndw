# Styling and UI

## Theme-aware styles

The host supplies CSS custom properties named `--mndw-*`, including colors, spacing, typography,
and radii. Prefer them to copied literal theme values: they follow the active theme and imported
device palette. Scope selectors to a plugin root so component rules do not leak into the host or
other plugins.

```css
.status-widget {
  display: grid;
  gap: var(--mndw-space-3);
  padding: var(--mndw-space-4);
  color: var(--mndw-text);
  background: var(--mndw-surface);
  font-family: var(--mndw-font-sans);
}
```

Use CSS tokens for rendered colors. If JavaScript needs a color (for example, to draw on canvas),
read `context.getTokens()` and refresh it when `onPaletteChange` fires. `onThemeChange` reports the
active theme; both subscription methods return cleanup functions. Do not read the generated default
`MNDW_TOKENS` constant for live device overrides. Token names and types are maintained in
[`frontend/sdk/src/tokens.css`](https://github.com/Eralde/mndw/blob/main/frontend/sdk/src/tokens.css)
and [`tokens.ts`](https://github.com/Eralde/mndw/blob/main/frontend/sdk/src/tokens.ts); the CSS is
generated and must not be edited by hand.

## Shared UI elements

Use `@mndw/ui` components for controls, charts, and tables it provides. Shared components give
plugins a consistent visual style and accessible interaction behavior. The package is a
host-provided shared dependency; use the custom elements directly. The host is the only code that
registers them because `customElements.define` is page-global. See the
[component guide](/guides/ui-components) for the catalog and plugin examples, or the
[`@mndw/ui` README](https://github.com/Eralde/mndw/blob/main/frontend/ui/README.md) for detailed APIs.

The [Hello widget](https://github.com/Eralde/mndw/tree/main/plugins/examples/hello-widget) is a
small example of scoped CSS using host tokens.
