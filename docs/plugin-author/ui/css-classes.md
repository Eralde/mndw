# CSS classes

The shared class layer styles host and plugin light DOM. Use semantic HTML and keep accessible names, roles, and state on the markup.

## Examples

### Status card

```html demo
<article class="mndw-card">
  <header class="mndw-toolbar" aria-label="Device status">
    <h3>Gateway</h3>
    <span class="mndw-badge mndw-badge--success">Online</span>
  </header>
  <p><span class="mndw-status-dot mndw-status-dot--success" aria-hidden="true"></span> Connected to the network</p>
  <p><span class="mndw-status-dot mndw-status-dot--warning" aria-hidden="true"></span> Update available</p>
  <div class="mndw-progress" role="progressbar" aria-label="Applying update" aria-busy="true"></div>
</article>
```

### Alerts

```html demo
<div class="mndw-alert mndw-alert--danger" role="alert">
  <div class="mndw-alert__title">Connection failed</div>
  <div class="mndw-alert__body">Check the network connection and retry.</div>
</div>
<div class="mndw-alert mndw-alert--success" role="status">
  <div class="mndw-alert__title">Settings saved</div>
  <div class="mndw-alert__body">Changes are active.</div>
</div>
<div class="mndw-alert mndw-alert--warning" role="status">
  <div class="mndw-alert__title">Low storage</div>
  <div class="mndw-alert__body">Some history may be removed.</div>
</div>
<div class="mndw-alert mndw-alert--info" role="status">
  <div class="mndw-alert__title">Scheduled maintenance</div>
  <div class="mndw-alert__body">The service will restart tonight.</div>
</div>
```

### Empty and busy states

```html demo
<div class="mndw-empty" role="status">
  <strong>No connected clients</strong>
  <span>Clients appear here after they join the network.</span>
</div>
<p role="status" aria-busy="true">
  <span class="mndw-spinner" aria-hidden="true"></span>
  Loading client details…
</p>
```

### Field and table

```html demo
<div class="mndw-field">
  <label class="mndw-field__label" for="network-name">Network name</label>
  <mndw-input id="network-name" value="Home" aria-describedby="network-name-hint network-name-error" aria-invalid="true"></mndw-input>
  <span class="mndw-field__hint" id="network-name-hint">Shown to nearby devices.</span>
  <span class="mndw-field__error" id="network-name-error" role="alert">Choose a different name.</span>
</div>

<table class="mndw-table mndw-table--sticky-head">
  <caption>Recent connections</caption>
  <thead>
    <tr><th scope="col" aria-sort="descending">Device</th><th scope="col">Status</th></tr>
  </thead>
  <tbody>
    <tr><td>Office laptop</td><td>Connected</td></tr>
    <tr><td>Living room display</td><td>Idle</td></tr>
  </tbody>
</table>
```

## Reference

- `.mndw-card` and `.mndw-toolbar` style semantic containers. Add a role and accessible name to a toolbar only when its interaction model needs them.
- `.mndw-alert` supports `--danger`, `--success`, `--warning`, and `--info`; its title and body use `.mndw-alert__title` and `.mndw-alert__body`. Markup owns its role and live-region behavior.
- `.mndw-badge` and `.mndw-status-dot` support `--danger`, `--success`, `--warning`, and `--info`. Add `aria-hidden="true"` to decorative dots.
- `.mndw-progress` is indeterminate; consumer markup supplies progress semantics and busy state. `.mndw-spinner` is decorative and adds no role.
- `.mndw-empty` styles an empty-state container; consumer markup supplies its heading and status semantics.
- `.mndw-field` groups a label, control, hint, and error. Use `.mndw-field__label`, `.mndw-field__hint`, and `.mndw-field__error`; wire IDs with `for` and `aria-describedby`, and set `aria-invalid` when needed.
- `.mndw-field` styles layout and labels; it does not paint a native input's border or background. Use a UI control such as `<mndw-input>` or style native form controls in consumer CSS.
- `.mndw-table` styles native table markup. `.mndw-table--sticky-head` opts into a sticky header, and native `aria-sort` communicates sort state.
- Native `[hidden]` controls visibility; no state classes are provided.

Host pages import `@mndw/sdk/tokens.css` and `@mndw/ui/styles.css` once.
