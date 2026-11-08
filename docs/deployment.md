# Deployment

mndw is packaged for network devices as a per-architecture IPK. The package
contains the static host, built-in plugins, the `mndwd` binary, the device-port
discovery helper, and an init script.

## Device layout

The installed layout is centered under `/opt`:

```text
/opt/share/www/mndw/                         package-owned host SPA
/opt/share/www/mndw/plugins/                 package-owned built-in plugins
/opt/share/www/mndw/bin/mndw-self-update.sh  self-update helper
/opt/sbin/mndwd                              daemon binary
/opt/etc/init.d/                             daemon init script
/opt/var/lib/mndw/                           selected port, session state, staging
/opt/var/lib/mndw/frontend-port              mndwd's selected browser-facing port
/opt/var/lib/mndw/user-plugins/              durable uploaded user-plugin files
/opt/var/lib/mndw/state.json                 durable plugin metadata and manifests
/opt/var/lib/mndw/legacy/                    preserved legacy 80-mndw.conf files
/opt/tmp/mndw/plugin-runtime/                runtime sockets and leases
/opt/var/mndw/                               self-update lock, intent, pending, rollback
```

User plugins live separately from built-ins and are served by mndwd through its
`/user-plugins/` alias. The state directory is not replaced by an upgrade. A
legacy `80-mndw.conf` is moved to
`/opt/var/lib/mndw/legacy/` before unpacking the new package.

Approved user-plugin files are runtime data, not package-tracked files. During
an upgrade, `preinst` moves them from the legacy
`/opt/share/www/mndw/user-plugins/` directory because the mndwd alias serves
`/opt/var/lib/mndw/user-plugins/`. During removal, `postrm` performs the
same migration before deleting the old app root. `/opt/var/lib/mndw`, its
`state.json`, staging area, and user-plugin files survive remove and reinstall;
`purge` does not change this package-level data-preservation contract. Delete
plugins through management or deliberately remove their durable files for a
clean wipe.

## HTTP server

mndwd serves all browser-facing traffic from one listener:

- static SPA and plugin assets, with fallback to `index.html`;
- `/user-plugins/` alias for durable user-plugin files;
- transparent `/rci`, `/ci`, and `/auth` device proxy;
- session-gated `/api` and WebSocket plugin routes.

"Serve all" mode is enabled with `--frontend-dir`; `--frontend-listen` controls
the bind address and defaults to IPv4 `0.0.0.0`. At startup, mndwd selects the
persisted `frontend-port`, then the old `lighttpd-port` migration seed, then
`1189`, followed by remaining ports in the `1190..1289` fallback range. The
selected port is written atomically to `frontend-port`.
Request routing, listener ports, and upstream targets are owned by
[`contracts/routing.md`](../contracts/routing.md).

## Hosted OPKG feed and self-update

Hosted feed artifacts are published under architecture-specific paths:

```text
https://eralde.github.io/mndw-opkg-feed/aarch64-3.10/
https://eralde.github.io/mndw-opkg-feed/mips-3.4/
https://eralde.github.io/mndw-opkg-feed/mipsel-3.4/
```

Use hosted `add_repo.sh` bootstrap. It selects device's exact supported
architecture, installs published public key, creates `mndw-feed.conf` only
when absent, and runs `opkg update` plus `opkg install mndw`. Bootstrap does
not enable `check_signature`, so existing unrelated feeds keep current
behavior. Legacy `build/packaging/install.sh` is local-feed-only and must not
be copied to hosted feed.

The bootstrap command runs `opkg update`, installs `curl`, then downloads and
runs `add_repo.sh`.

Settings -> System update uses server-derived targets. Apply downloads one exact
target IPK into `/opt/var/mndw/pending/`, starts packaged helper with held lock,
and installs that exact path after daemon restart. Revert uses validated
`/opt/var/mndw/rollback/version` pointer and normalized IPK. Check and
apply/revert require normal management session; POST requests require
`X-Mndw-Csrf: 1`.

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

`install.sh` configures the feed, runs `opkg update`, and installs mndw. It no
longer writes a lighttpd ownership policy. On upgrade from an older lighttpd
HTTP server, `postinst` removes stale mndw-owned runtime artifacts, reports the
one-time removal notice when the old policy says mndw owned lighttpd, then
restarts `S70mndwd`. A failed restart retains the old `lighttpd-port` seed for
retry; a successful restart consumes it.

Installation starts mndwd and reports the selected dashboard URL after
`frontend-port` readiness. A deployment should verify:

1. the browser can reach the host;
2. authentication reaches the network device;
3. built-in plugins appear in the list;
4. upload, approval, and backend dispatch work.

Before starting mndwd, package init discovers the network-device HTTP port by probing
`/auth` on local listeners and checking for `x-ndw2-interactive` or
`x-ndw4-interactive` authentication. Set `MNDW_DEVICE_PORT=<port>` in
`/opt/etc/mndw.conf` when more than one listener matches. The discovered URL is
passed to mndwd as `--device-url`; no compatibility alias is supported.

After an upgrade or remove/reinstall, verify the frontend port, legacy backup,
durable user-plugin files, and `/opt/etc/mndw.conf`. A real-device smoke test is
mandatory even when local and CI tests pass. Release of this migration also
requires target Entware verification of opkg lifecycle ordering and that
`/opt/share/www` and `/opt/var/lib` share a filesystem; host shell tests do not
prove either condition.

For listener diagnostics, inspect the selected port, mndwd log, device
discovery, and live listeners:

```sh
cat /opt/var/lib/mndw/frontend-port
grep -a -- '--frontend-dir' /opt/var/log/mndwd.log
sh /opt/share/www/mndw/bin/mndw-device-port.sh detect 192.168.1.1
netstat -lnt 2>/dev/null
```

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
