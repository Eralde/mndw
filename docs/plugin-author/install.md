# Install mndw

## Prerequisites

Install Entware (OPKG) on the router and make sure you have shell access to it. Follow the
[Entware installation guide](https://support.keenetic.com/titan/kn-1811/en/20980-installing-the-entware-repository-on-a-usb-drive.html);
this guide covers installing mndw after Entware is ready. A clean Entware install has no downloader with HTTPS support,
so the command below installs `curl` first.

## Install

Run this command in the OPKG shell:

```sh
opkg update && opkg install curl && curl -fsSL https://eralde.github.io/mndw-opkg-feed/add_repo.sh | sh
```

The script detects the router architecture (`aarch64-3.10`, `mips-3.4`, or `mipsel-3.4`), installs the feed's public
key, adds the feed configuration if it is not there yet, runs `opkg update`, and installs the `mndw` package. The feed
source is [mndw-opkg-feed](https://github.com/Eralde/mndw-opkg-feed).

## Open the dashboard

The installer prints the dashboard address. When port 1189 is free, it is typically `http://<router>:1189`. To find
the selected port later, run:

```sh
cat /opt/var/lib/mndw/frontend-port
```

Sign in with the router account.

## Upgrade

In the dashboard, open **Settings → System update**. From a terminal, update the package lists and upgrade mndw:

```sh
opkg update && opkg upgrade mndw
```

First-time installs use the `curl` command above. For an existing installation, run `opkg update && opkg upgrade mndw`.

## Install your own plugin

From your plugins project, run `npx mndw zip hello-widget` on the plugin folder, then upload the ZIP through plugin management in the dashboard. A plugin
with a backend must be approved before it can run; a plugin without a backend installs directly. See
[Validation and packaging](/guides/validation-and-packaging) for how to prepare the ZIP.

## Troubleshooting

If automatic port detection selects the wrong listener, set `MNDW_DEVICE_PORT=<port>` in `/opt/etc/mndw.conf`.
