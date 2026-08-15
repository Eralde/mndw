# Deployment

mndw is packaged for router devices as a per-architecture IPK. The package
contains the static host, built-in plugins, the `mndwd` binary, lighttpd
configuration, and an init script.

## Device layout

The installed layout is centered under `/opt`:

```text
/opt/share/www/mndw/       host SPA and built-in plugin assets
/opt/sbin/mndwd            daemon binary
/opt/etc/lighttpd/         package-owned loader plus base lighttpd config
/opt/etc/init.d/           daemon init script
/opt/var/lib/mndw/          selected port, generated runtime config, state, staging
/opt/var/lib/mndw/legacy/   preserved legacy 80-mndw.conf files
/opt/tmp/mndw/              install-time lighttpd probe diagnostics on failure
```

User plugins live separately from built-ins. The local lighttpd override is a
package-owned loader and survives only as long as mndw is installed. Generated
runtime rules and selected-port state live outside `conf.d`; the state directory
is not replaced by an upgrade. A legacy `80-mndw.conf` is moved to
`/opt/var/lib/mndw/legacy/` before unpacking the new package.

## lighttpd

The v3 lighttpd configuration is intentionally thin:

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
2. build the host, tokens, and shared bundles;
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
`pnpm build-example-plugins`: `device-traffic-widget.zip` and one
target-labelled ping archive per target. The UI can reject a known ping
archive when `show.version.arch` identifies a different target; unknown or
renamed archives retain normal upload behavior. Ping uploads require approval
before activation; the traffic widget has no backend and installs directly.

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

If the base listener is unavailable, mndw prints a warning and renders an
override that scopes its rules to the selected listener. This decision is made
during install; rerun package configuration if listener ownership changes later.
After an upgrade, verify the generated runtime config, legacy backup, and
`/opt/etc/mndw.conf`. A real-device smoke test is mandatory even when local and
CI tests pass.

## Security boundary

The daemon is the security boundary for executable plugin capabilities. In
production:

- management requires a valid router session;
- uploaded backend plugins are staged before approval;
- HTTP/WebSocket route access is gated by approval and enabled state;
- public route access is explicit and visible during review;
- request size, execution time, and concurrency are bounded;
- approved commands and service children run with the daemon's device privileges.

The old service allowed unauthenticated upload, approval, and shell execution;
v3 removes that default. `--dev` intentionally bypasses session checks, so it
must not be used as a production configuration.

## Device-like validation

The blocking CI target is a plain Alpine container using BusyBox `/bin/sh`,
with the daemon built for Linux amd64 and opkg stubbed. This catches shell
scripts that work on a development shell but fail on a router-like shell.

An optional Entware harness exercises real opkg installation when dependency
management changes. It is non-blocking because it downloads an external
toolchain and feed.
