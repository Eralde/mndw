# `<mndw-button>`

Buttons support four visual variants and native button types.

## Examples

### Variants

```html demo
<mndw-button variant="primary">Primary</mndw-button>
<mndw-button variant="secondary">Secondary</mndw-button>
<mndw-button variant="ghost">Ghost</mndw-button>
<mndw-button variant="danger">Danger</mndw-button>
```

### Disabled

```html demo
<mndw-button variant="primary" disabled>Save changes</mndw-button>
```

### With an icon

```html demo
<mndw-button variant="secondary"><mndw-icon name="settings"></mndw-icon>Settings</mndw-button>
```

### Icon only

```html demo
<mndw-button variant="ghost" aria-label="Settings"><mndw-icon name="settings"></mndw-icon></mndw-button>
```

## Reference

`variant` accepts `primary`, `secondary`, `ghost`, or `danger`; it defaults to `secondary`. `type` accepts `button`,
`submit`, or `reset` and defaults to `button`. `disabled` disables the control. The inner native button exposes
`part="button"`; `aria-label` names it when its slotted content is only an icon.

`danger` is for destructive actions and uses a tinted `--mndw-danger-bg` background with `--mndw-danger` text and
border. It is not a solid fill; the palette does not define a validated contrast pair for a solid danger background.

The inner native button is in the shadow root. The component uses `ElementInternals` only to reach its containing
form: `type="submit"` calls `requestSubmit()` and `type="reset"` calls `reset()`. It contributes no name/value pair
and is not a native submitter. Use a native `<button>` when submitter data is required.
