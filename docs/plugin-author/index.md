---
layout: home

hero:
  name: mndw Plugin Author Guide
  text: Build a plugin in your own Node.js project
  tagline: Create, develop, validate, and package plugins with the mndw CLI.
  actions:
    - theme: brand
      text: Set up a project
      link: /guides/project-setup
    - theme: alt
      text: Build a Hello Widget
      link: /tutorials/hello-widget

features:
  - title: Start in your own project
    details: Install the CLI, scaffold a plugin, and run it locally without cloning the mndw repository.
    link: /guides/project-setup
    linkText: Set up a project
  - title: 'First plugin: Hello Widget'
    details: Build, test, and package a Svelte widget with a shell backend.
    link: /tutorials/hello-widget
    linkText: Start the tutorial
  - title: 'Device name with the RCI API'
    details: Use mndw's direct RCI API to read and update a device description through Observable APIs. The tutorial marks every live-device write.
    link: /tutorials/rci-device-name-widget
    linkText: Open the RCI tutorial
  - title: Guides and API reference
    details: Look up setup, Windows, plugin structure, lifecycle, styling, backends, local development, and packaging.
    link: /guides/plugin-anatomy
    linkText: Browse all guides
---

## Before you start

- Node.js 22 or newer.
- npm, pnpm, or Yarn.
- Go only if you choose a Go backend.
- A router reachable on your LAN for the RCI tutorial. The Hello Widget tutorial runs without a device.

## Choose a path

1. [Set up a plugin project](/guides/project-setup), then [build the Hello Widget](/tutorials/hello-widget). The tutorial
   creates a shell-backed plugin, runs it locally, and packages an upload ZIP.
2. Continue with the [RCI tutorial](/tutorials/rci-device-name-widget) when you have a reachable router. It reads and
   updates the device description, with a safety checkpoint before each write.
3. For updates that arrive over time, read [RxJS for plugin authors](/guides/rxjs) and the
   [frontend lifecycle guide](/guides/frontend-lifecycle).

## Guides

Start with [Windows](/guides/windows) if you develop on Windows. Learn the [plugin lifecycle](/guides/frontend-lifecycle),
or look up [RxJS for plugin authors](/guides/rxjs), [plugin anatomy](/guides/plugin-anatomy), [manifests](/guides/manifest), [styling and UI](/guides/styling-and-ui),
[UI components](/guides/ui-components), [backends](/guides/shell-backend), [RCI](/guides/rci-api), [local development](/guides/local-development),
and [packaging](/guides/validation-and-packaging). The [SDK API reference](/api/) documents exported types and helpers.
