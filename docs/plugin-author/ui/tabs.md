# `<mndw-tabs>`

The container owns an internal tab list, active value, and the child elements' ARIA state.

## Examples

### Tabs and panels

```html demo
<mndw-tabs value="network">
  <mndw-tab id="general">General</mndw-tab>
  <mndw-tab id="network">Network</mndw-tab>
  <mndw-tab id="advanced">Advanced</mndw-tab>
  <mndw-tab-panel for="general">Device details and name.</mndw-tab-panel>
  <mndw-tab-panel for="network">Address and connection settings.</mndw-tab-panel>
  <mndw-tab-panel for="advanced">Additional options.</mndw-tab-panel>
</mndw-tabs>
```

### Disabled tab

```html demo
<mndw-tabs value="general">
  <mndw-tab id="general">General</mndw-tab>
  <mndw-tab id="network">Network</mndw-tab>
  <mndw-tab id="advanced" disabled>Advanced</mndw-tab>
  <mndw-tab-panel for="general">Device details.</mndw-tab-panel>
  <mndw-tab-panel for="network">Connection settings.</mndw-tab-panel>
  <mndw-tab-panel for="advanced">Additional options.</mndw-tab-panel>
</mndw-tabs>
```

## Reference

`<mndw-tabs>` carries `value`, the active tab's `id`, and part `tablist`. It has no role of its own; the role is on
an internal wrapper around the tabs. `mndwchange` carries `{value: string}` and fires on user activation. Tabs are
view state, not form data.

`<mndw-tab>` carries a required `id` and `disabled`, with part `tab`. `<mndw-tab-panel>` carries `for`, pointing at
the tab id, receives a generated `mndw-tab-panel-N` id if none is supplied, and exposes part `panel`. The panel
points to its tab, not the reverse; a `for` on `<mndw-tab>` is invalid. The group writes roles, ARIA relationships,
and roving `tabindex`; inactive panels are hidden without being unmounted. It removes attributes it owns when a
child leaves or the group disconnects, and rewires when ids, panel targets, or child order change.

Arrow keys move focus and selection with wraparound. Home and End jump to the first and last enabled tab. Disabled
tabs are skipped. A panel without a matching tab stays hidden, a tab without an id is inert, and if panels share a
target the first in document order wins. Each malformed case is reported once. The group has no role of its own; an
internal wrapper with only tabs in its slot carries `role="tablist"`.
