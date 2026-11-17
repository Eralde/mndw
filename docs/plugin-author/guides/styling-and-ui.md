# Styling and UI

## Theme-aware styles

The host supplies CSS custom properties named `--mndw-*`, including colors, spacing, typography,
and radii. Prefer them to copied literal theme values: they follow the active theme and imported
device palette. Scope every plugin selector under a root class named after the plugin,
`.<plugin-name>`, so component rules do not leak into the host or other plugins. The host adds
`data-theme` to the plugin container; plugin code should not set it.

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

Use the plugin class in every framework. For a plugin named `status-widget`, the selector prefix is
`.status-widget`:

```svelte
<div class="status-widget">
  <p class="status">Online</p>
</div>

<style>
  :global(.status-widget) .status {
    color: var(--mndw-success);
  }
</style>
```

```vue
<template>
  <div class="status-widget"><p class="status">Online</p></div>
</template>

<style scoped>
.status-widget .status {
  color: var(--mndw-success);
}
</style>
```

```css
/* Angular component stylesheet */
.status-widget .status {
  color: var(--mndw-success);
}
```

```css
/* Vanilla TypeScript stylesheet */
.status-widget .status {
  color: var(--mndw-success);
}
```

## Status and errors

Disabled features, unsupported devices, and empty data are neutral statuses. For an SDK `LoadState` with
`status: 'unsupported'`, `reason` explains why the capability or data is unavailable; show that explanation with
`role="status"` and muted text, not as a failed request. The cpu-temp-widget follows this pattern for unsupported
temperature data and uses `TelemetryNote.vue` for disabled telemetry and missing session setup. Reserve
`role="alert"` and red styling for failures the user can act on, and provide a Retry action when retrying can resolve
the failure.

Keep global resets and element-only selectors out of plugin CSS. `mndw validate` warns when built
CSS contains selectors outside the plugin prefix. Third-party selectors can be listed in
`package.json` under `mndw.cssSelectorAllowlist`; see [validation and packaging](validation-and-packaging.md).

Use CSS tokens for rendered colors. If JavaScript needs colors (for example, to draw on canvas), read
the current palette from `ctx.palette` and subscribe to `ctx.palette$` to update it when the applied
palette changes. `ctx.theme` returns the current theme name; `ctx.theme$` emits it on subscribe and on
later changes. Do not read the generated default `MNDW_TOKENS` constant for live device overrides.
Token names and types are maintained in
[`frontend/sdk/src/tokens.css`](https://github.com/Eralde/mndw/blob/master/frontend/sdk/src/tokens.css)
and [`tokens.ts`](https://github.com/Eralde/mndw/blob/master/frontend/sdk/src/tokens.ts); the CSS is
generated and must not be edited by hand.

## Shared UI elements

Use `@mndw/ui` components for controls, charts, and tables it provides. Shared components give
plugins a consistent visual style and accessible interaction behavior. The package is a
host-provided shared dependency; use the custom elements directly. The host is the only code that
registers them because `customElements.define` is page-global. See the
[component guide](/ui/) for the catalog, examples, properties, events, and styling hooks.

The [Hello widget](https://github.com/Eralde/mndw/tree/master/plugins/examples/hello-widget) is a
small example of scoped CSS using host tokens.

## Texts

Use sentence case for English labels and titles, keep product names capitalized, and use `…` for ellipses. Use
English curly quotes (`“…”`) and Russian guillemets (`«…»`) in localized strings. Write button labels as actions and
render icons in markup instead of including icon glyphs in translated text.
