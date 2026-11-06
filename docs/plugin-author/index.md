---
title: mndw
aside: false
---

<HomeHero />

## What is mndw

mndw is a modular web UI that you install on your router as an Entware package. It runs alongside the stock web
interface on its own port, and you sign in with the same router account.

Everything in mndw is a plugin: a **widget** tile on the dashboard or a whole **page**. Plugins read and change router
settings through the router's API. A plugin can also bring a backend (a shell script or a Go program) that runs on the
router.

mndw has two parts: the UI in your browser and `mndwd`, a small daemon on the router that serves the UI and plugins and
runs plugin backends.

## Install

You need [Entware](https://support.keenetic.com/titan/kn-1811/en/20980-installing-the-entware-repository-on-a-usb-drive.html)
installed on the router. In its shell:

```sh
curl -fsSL https://eralde.github.io/mndw-opkg-feed/add_repo.sh | sh
```

The script adds the mndw package feed for your router's architecture and installs mndw. When it finishes, it prints
the dashboard address. [Full install guide →](/install)

## Build your own plugin

1. [Set up a project](/guides/project-setup): Node.js 22+ and the `mndw` CLI
2. [Hello Widget](/tutorials/hello-widget): your first plugin, from scaffold to upload ZIP
3. [Device name](/tutorials/rci-device-name-widget): read and change a router setting through RCI

[Guides](/guides/plugin-anatomy) · [CLI commands](/reference/cli) · [SDK API](/api/)
