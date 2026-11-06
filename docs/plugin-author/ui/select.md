# `<mndw-select>`

Uses slotted `<mndw-option>` children and emits `mndwchange`.

## Examples

### Options

```html demo
<mndw-select label="Network" name="network">
  <mndw-option value="lan">LAN</mndw-option>
  <mndw-option value="guest">Guest</mndw-option>
  <mndw-option value="iot">IoT</mndw-option>
</mndw-select>
```

### Preselected value

```html demo
<mndw-select label="Address family" value="ipv4">
  <mndw-option value="ipv4">IPv4</mndw-option>
  <mndw-option value="ipv6">IPv6</mndw-option>
</mndw-select>
```

### Disabled option

```html demo
<mndw-select label="Connection">
  <mndw-option value="wired">Wired</mndw-option>
  <mndw-option value="wireless" disabled>Wireless (unavailable)</mndw-option>
</mndw-select>
```

### Rich option label

```html demo
<mndw-select label="Interface">
  <mndw-option value="lan"><mndw-icon name="settings"></mndw-icon> LAN <span>1 Gbps</span></mndw-option>
  <mndw-option value="wifi"><mndw-icon name="arrow-right"></mndw-icon> Wi-Fi 5 GHz</mndw-option>
</mndw-select>
```

## Reference

`<mndw-select>` is form-associated. Its properties are `value`, `placeholder`, `label`, `name`, `disabled`, `required`,
`invalid`, and `panelClass` (attribute `panel-class`). `value` is state and does not reflect; the authored `value`
attribute is the form-reset default. An empty or unmatched select is omitted from `FormData`; a disabled `<fieldset>`
disables it. User selection emits `mndwchange` with `detail: {value: string}`. The host carries `role="combobox"`,
focus, and the accessible name, so an external `<label for>` works. `<mndw-field>` treats `label` as the control's own
name and leaves its label hidden when that property is non-empty.

The select opens an anchored popover above `600px` and a full-width bottom sheet at or below that width. Presentation
is chosen when the panel opens; close and reopen after resizing across the breakpoint. Long option lists scroll inside
the panel. The select owns the panel and restores focus to its trigger after dismissal. In sheet mode, Tab dismisses
the panel and restores focus to the trigger; Escape also closes it.

`<mndw-option>` provides declarative option data through reflected `value` and `disabled` attributes and supports rich
label content. Child text, nested markup, and option-attribute changes notify the select so it can refresh its options.
Rich option nodes are cloned into the panel; content is not parsed from an HTML string. The panel exposes `listbox` and
`option` parts, and the select exposes `trigger`, `value`, and `indicator` parts.

The internal `<mndw-select-panel>` is portaled and owned by the select. `panel-class` supplies a class name to the
overlay wrapper; it does not make a selector global. Define the global CSS selector for that class to style the
wrapper and panel parts. The overlay wrapper owns width and height bounds, while the panel owns its visual chrome and
nested `<mndw-scroll-area>` owns option scrolling. Without an overlay provider, standalone use falls back to a fixed
position panel.
