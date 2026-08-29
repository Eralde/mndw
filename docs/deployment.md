# Deployment

mndw is packaged for router devices as a per-architecture IPK. The package
contains the static host, built-in plugins, the `mndwd` binary, lighttpd
configuration, and an init script.

## Device layout

The installed layout is centered under `/opt`:

```text
/opt/share/www/mndw/                 package-owned host SPA
/opt/share/www/mndw/plugins/         package-owned built-in plugins
/opt/sbin/mndwd                      daemon binary
/opt/etc/lighttpd/                   package-owned loader plus base lighttpd config
/opt/etc/init.d/                     daemon init script
/opt/var/lib/mndw/                   selected port, generated runtime config, staging
/opt/var/lib/mndw/user-plugins/      durable uploaded user-plugin files
/opt/var/lib/mndw/state.json         durable plugin metadata and manifests
/opt/var/lib/mndw/legacy/             preserved legacy 80-mndw.conf files
/opt/tmp/mndw/                       install-time lighttpd probe diagnostics on failure
```

User plugins live separately from built-ins. The local lighttpd override is a
package-owned loader and survives only as long as mndw is installed. Generated
runtime rules and selected-port state live outside `conf.d`; the state directory
is not replaced by an upgrade. A legacy `80-mndw.conf` is moved to
`/opt/var/lib/mndw/legacy/` before unpacking the new package.

Approved user-plugin files are runtime data, not package-tracked files. During
an upgrade, `preinst` moves them from the legacy
`/opt/share/www/mndw/user-plugins/` directory because the new lighttpd alias
serves `/opt/var/lib/mndw/user-plugins/`. During removal, `postrm` performs the
same migration before deleting the old app root. `/opt/var/lib/mndw`, its
`state.json`, staging area, and user-plugin files survive remove and reinstall;
`purge` does not change this package-level data-preservation contract. Delete
plugins through management or deliberately remove their durable files for a
clean wipe.

## lighttpd

The lighttpd configuration is intentionally thin:

- serve the SPA and static plugin assets;
- retain SPA fallback for browser routes.

Backend commands and service processes run behind `mndwd`; lighttpd only
provides the browser-facing static and proxy boundary. Backend operation does
not require lighttpd CGI, jq, or unzip.
Request routing, listener ports, and upstream targets are owned by
[`contracts/routing.md`](../contracts/routing.md).

## IPK pipeline

`pnpm build-ipk --arch <arch>` performs the following work:

1. install locked workspace dependencies;
2. build the host and shared bundles;
3. pack built-in plugins;
4. build `mndwd` for the selected architecture;
5. verify required staged files;
6. create root-owned ustar data and control archives;
7. emit an architecture-specific IPK.

The bare target map includes `aarch64`, `mips`, and `mipsel`. IPK package
surfaces use `aarch64-3.10`, `mips-3.4`, and `mipsel-3.4` respectively.
`--all` builds the supported set. The package feed contains one entry per
architecture.

The package depends on lighttpd and its proxy/rewrite modules.

Uploadable example archives are produced separately with
`pnpm build-example-plugins`: one archive for every direct example directory
with a manifest. Backend examples produce one target-labelled archive per
target; no-backend examples produce one archive. The UI can reject a known
target archive when `show.version.arch` identifies a different target; unknown
or renamed archives retain normal upload behavior. Backend uploads require
approval before activation; no-backend examples install directly.

Publishing an IPK/feed entry does not provision a device architecture. The
configured opkg architecture list and Entware feed must include the matching
kernel-suffixed target, including `mips-3.4` for big-endian MIPS.

## Install and upgrade

Installation starts `mndwd`, probes the complete lighttpd configuration, renders
runtime rules, validates the configuration, and restarts lighttpd. A deployment
should verify:

1. the browser can reach the host;
2. authentication reaches the router;
3. built-in plugins appear in the list;
4. upload, approval, and backend dispatch work.

Before starting mndwd, package init discovers the router HTTP port by probing
`/auth` on local listeners and checking for `x-ndw2-interactive` or
`x-ndw4-interactive` authentication. Set `MNDW_ROUTER_PORT=<port>` in
`/opt/etc/mndw.conf` when more than one listener matches. The generated
`/opt/var/lib/mndw/proxy-target.conf` and mndwd `--router-url` use that port.

If the base listener is unavailable, mndw prints a warning and renders an
override that scopes its rules to the selected listener. This decision is made
during install; rerun package configuration if listener ownership changes later.
After an upgrade, verify the generated runtime config, legacy backup, durable
user-plugin files, and `/opt/etc/mndw.conf`. A real-device smoke test is
mandatory even when local and CI tests pass. Release of this migration also
requires target Entware verification of opkg lifecycle ordering and that
`/opt/share/www` and `/opt/var/lib` share a filesystem; host shell tests do not
prove either condition.

## Security boundary

The daemon is the security boundary for executable plugin capabilities. In
production:

- management requires a valid router session;
- uploaded backend plugins are staged before approval;
- HTTP/WebSocket route access is gated by approval and enabled state;
- public route access is explicit and visible during review;
- request size, execution time, and concurrency are bounded;
- approved commands and service children run with the daemon's device privileges.

The service requires authentication for upload, approval, and shell execution;
unsafe management mutations also require `X-Mndw-Csrf: 1`. `--dev`
intentionally bypasses session checks but does not bypass that CSRF requirement,
so it must not be used as a production configuration.

## Device-like validation

The blocking CI target is a plain Alpine container using BusyBox `/bin/sh`,
with the daemon built for Linux amd64 and opkg stubbed. This catches shell
scripts that work on a development shell but fail on a router-like shell.

An optional Entware harness exercises real opkg installation when dependency
management changes. It is non-blocking because it downloads an external
toolchain and feed.
