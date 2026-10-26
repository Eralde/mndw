---
layout: home

hero:
  name: mndw Plugin Author Guide
  text: Build a plugin from source to ZIP
  tagline: Start with a working example, develop against the host, then validate and package your own plugin.
  actions:
    - theme: brand
      text: Start with a shell-backed widget
      link: /tutorials/hello-widget
    - theme: alt
      text: Browse the guides
      link: /guides/plugin-anatomy

features:
  - title: 'First plugin: Hello Widget'
    details: Scaffold a Svelte widget, call a declared shell-backed route, handle backend states, and make an upload-ready ZIP.
    link: /tutorials/hello-widget
    linkText: Start the tutorial
  - title: 'Device name with the RCI API'
    details: Use mndw's direct RCI API to read and update a device description through Observable APIs. The tutorial marks every live-device write.
    link: /tutorials/rci-device-name-widget
    linkText: Open the RCI tutorial
  - title: Focused reference guides
    details: Look up plugin structure, manifests, lifecycle, styling, backends, local development, and packaging.
    link: /guides/plugin-anatomy
    linkText: Browse all guides
---

This guide is for contributors working in a clone of the mndw repository. The
`mndw` CLI, SDK, and tested example plugins are provided by the workspace; the
tutorials do not assume a public global CLI installation.

## Prerequisites

- Node.js 22
- pnpm 10
- Go 1.26.1 to run the source-checkout daemon used by `mndw dev`
- A clone of this repository, with dependencies installed using `pnpm install`
- A POSIX `sh` on the machine running the shell-backend example

Start with the shell-backed tutorial if you are new to plugin development. It
does not require a device. Continue to the RCI tutorial only when you have a
reachable supported device and are ready to change its live description.

## Choose a path

1. [Build a shell-backed Hello Widget](/tutorials/hello-widget) — create
   `plugins/examples/my-hello-widget`, run it locally, test it, then validate,
   pack, and zip it. The completed reference implementation is
   [`plugins/examples/hello-widget`](https://github.com/Eralde/mndw/tree/main/plugins/examples/hello-widget).
2. [Build a device-name widget with direct RCI](/tutorials/rci-device-name-widget)
   — another part of the API mndw provides to plugins, alongside declared
   backend routes. Save and Restore both write live device configuration; the
   tutorial includes safety checkpoints before each.

For a single topic, jump to the [plugin anatomy](/guides/plugin-anatomy),
[manifest](/guides/manifest), [frontend lifecycle](/guides/frontend-lifecycle),
[styling and UI](/guides/styling-and-ui), [shell backend](/guides/shell-backend),
[RCI API](/guides/rci-api), [local development](/guides/local-development), or
[validation and packaging](/guides/validation-and-packaging) guide.
