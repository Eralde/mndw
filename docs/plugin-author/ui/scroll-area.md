# `<mndw-scroll-area>`

Provides a native scrolling viewport with a bespoke scrollbar when content overflows.

## Examples

### Fixed-height content

```html demo
<mndw-scroll-area style="height: 180px; width: min(100%, 420px)">
  <div style="padding: 12px">
    <p>Connected clients</p>
    <p>Living room display · 192.168.1.24</p>
    <p>Work laptop · 192.168.1.31</p>
    <p>Phone · 192.168.1.42</p>
    <p>Media player · 192.168.1.55</p>
    <p>Printer · 192.168.1.68</p>
    <p>Tablet · 192.168.1.77</p>
  </div>
</mndw-scroll-area>
```

## Reference

The component provides a native scrolling viewport and displays its bespoke scrollbar when content overflows. Set a
bounded height on the host when the surrounding page needs an independently scrolling region. The viewport owns
scroll interaction and remains the accessible surface; scrollbar chrome is `aria-hidden`.

Style its `viewport`, `scrollbar`, `track`, and `thumb` parts. Scrollbar variables are `--mndw-scrollbar-size`,
`--mndw-scrollbar-thumb`, `--mndw-scrollbar-thumb-hover`, `--mndw-scrollbar-track`, `--mndw-scrollbar-radius`, and
`--mndw-scrollbar-thumb-min-size` (default `1.5rem`). Generator defaults inherit from ancestor overrides.

Call `refresh()` after content changes that observers cannot see. Use `viewportElement` to access the native viewport
for direct `scrollTop` or `scrollTo` operations. In a select panel, these same parts are forwarded by the panel and
the nested scroll area owns option scrolling.
