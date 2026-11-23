# Upgrading to 0.4

Version 0.4 adds `ctx.toast`, `ctx.overlay.confirm`, switchport flags, and new `@mndw/ui` elements. It has no breaking
changes. The [package versioning guide](/guides/project-setup#package-versioning) explains how 0.x package ranges
work.

## Update package ranges

Change both SDK and UI packages to `^0.4.0`:

```json
{
  "dependencies": {
    "@mndw/sdk": "^0.3.0",
    "@mndw/ui": "^0.3.0"
  }
}
```

```json
{
  "dependencies": {
    "@mndw/sdk": "^0.4.0",
    "@mndw/ui": "^0.4.0"
  }
}
```

An installed plugin built for SDK 0.3 shows the **Built for another SDK version** warning badge in **Settings → Plugins**
when the host provides SDK 0.4. The SDK version difference can show this badge even when the plugin uses no new APIs;
the plugin still loads, but may misbehave with this host. Rebuilding it with the new ranges removes the badge. A plugin
that uses `ctx.toast` or `ctx.overlay.confirm` needs a 0.4 host.

## Check behaviour changes

`onResize` is now called once right after mount with the tile's size (not in the mobile layout), so a widget that assumed
the first call comes from a user resize must handle it.

`<mndw-segmented>` now has the same outer height as other controls.
