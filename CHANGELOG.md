# Changelog

All notable changes to mndw. One version covers the daemon, the IPK and every `@mndw/*` npm package.

Each version has up to two parts:

- **For users:** what changed on the dashboard and in the builtin plugins.
- **For plugin authors:** what changed in the SDK, `@mndw/ui`, the CLI and the manifest. Breaking changes come
  first.

A part with nothing in it is left out.

## Unreleased

### For users

- Clients widget: the RSSI of wireless clients is colored green, orange or red, with the level in a tooltip.
  The two thresholds are set in the widget settings (default −65 and −75 dBm). A client whose router reports no
  RSSI now shows «—» instead of 0.
- MWS map: each node shows its link speed above its card, as in the Nodes tab (hidden when zoomed far out).
  The RSSI thresholds that color wireless links are set with the new dBm button on the map toolbar.
- Event log: IP address changes on the router now appear. They were never delivered before, because the router
  hook sent malformed data. Each entry names the interface.
- The router's CPU is no longer loaded every 10 seconds: mndw reads new device log entries through one background
  log reader instead of downloading the whole log each time.
- A plugin backend waiting for a free slot now starts as soon as one frees up, including when it was busy at the
  moment the slot was freed. Before, it could stay waiting until the next change in the plugin list.
- A plugin backend enabled again or updated while it was still stopping now starts once the stop finishes.
  Before, it stayed stopped until the next change in the plugin list.
- A plugin backend restarted with new settings keeps its slot; before, a waiting plugin could sometimes take it. A
  plugin backend that has stopped retrying after repeated crashes now frees its slot for a waiting plugin.

### For plugin authors

- New smart-page example: a page with a Go service backend that finds drives with Entware's `smartctl`
  (`backend.packages: ["smartmontools"]`) and shows their S.M.A.R.T. health, key counters and attributes. It
  searches for drives when opened, asks before a read that may wake a sleeping HDD (not for SSD or NVMe; the answer
  can be remembered per drive) and lets the user override the device type of a USB bridge. Archives for aarch64,
  mips and mipsel come from `pnpm build-example-plugins`.
- Reinstalling a plugin without changing its version now loads the new files: the browser no longer keeps the old
  `index.js`, styles or translations, and Settings asks to reload the page if the plugin was already loaded. The
  plugin list reports `installedAt` for each installed plugin.
- `<mndw-line-chart>` and `<mndw-bar-chart>` work on touch screens: a tap or a horizontal drag shows the tooltip,
  it stays until a tap outside the chart, and a vertical swipe still scrolls the page.
- `net.ip_changed` events now reach plugins on a router; before, the hook's malformed data was rejected. The
  payload gains `interface` (the router's interface name, such as `WifiMaster0/WifiStation0`) and `systemName`
  (such as `apcli0`), and `link` is the link state (`up` or `down`), not an interface name.

## 0.4.1 — 2026-11-23

### For users

- The init script reports service state with `status` and now waits for the router to be ready before starting
  mndw after a reboot, including when Entware is installed on internal storage.
- Full removal: the new `mndw-cleanup` command deletes what `opkg remove mndw` keeps for a reinstall (data,
  settings, keys, the feed setup and caches), and after a second question the packages your plugins installed. Run
  `mndw-cleanup && opkg remove --autoremove mndw`.

## 0.4.0 — 2026-11-23

### For users

- DNS Lookup: the address list now fills the card when you make the card taller, instead of stopping at a fixed
  height.
- Telemetry: removing background router access (deleting the token or turning off tokenless access) now turns
  background telemetry off and records it in the audit log. Before, telemetry stayed on and its switch was locked.
  Settings shows the change without a reload, and telemetry cannot be turned on without router access.
- CPU temperature and device info: the controls in the widget header are more compact and line up with each
  other.
- Confirmation dialogs share one look: Cancel first, then the action button, with the button labels in your
  language. System Log (clear log) and MWS (reset map layout) use the same dialog as the rest of the
  dashboard.
- Event Logger: pick a category (Internet, Wi-Fi, USB & storage, Router, mndw); each card remembers its choice.
  Each event reads as a sentence, such as "WAN connected: eth3, 203.0.113.7", and the raw data is still one click
  away. Identical events in a row collapse into one line with a count; the downloaded log keeps every event.
  New events now appear at the bottom, like a terminal; the list follows them unless you have scrolled up to read.
- New Ports widget: the router's ports in a row as on the case, with link state. Under each port it shows the
  port's name, speed and duplex; in the card settings you choose which rows to show and in what order, adding
  traffic totals and rates, errors, dropped packets and blank rows. A port that runs slower than it can is marked.
  Long names wrap onto two lines. Hover a port with a link to see its traffic and the devices connected to it.
  Click the name under a port to rename it; the name is saved on the router.
- Links now share one style, text colour with an underline: in Settings, in the empty plugin list, on "Update in
  Settings" in Entware packages, on the MWS page and in the CPU temperature and device info widgets.

### For plugin authors

- 0.4 has no breaking changes, but it adds API that 0.3 hosts do not have, so update `@mndw/sdk` and `@mndw/ui` to
  `^0.4.0`. A plugin built for 0.3 still loads on a 0.4 host and shows the "Built for another SDK version" badge in
  Settings → Plugins until you rebuild it. See
  [Upgrading to 0.4](https://eralde.github.io/mndw/guides/upgrading-to-0-4).
- Plugins can show toasts with `ctx.toast` (`show`, `success`, `info`, `warning`, `error`, `dismiss(key)`). The
  host adds the plugin's name to each toast, keeps `key` within the plugin instance, drops toasts past 8 per
  10 seconds with a console warning, and closes toasts that have an action when the plugin unmounts.
  ([7ae650e](https://github.com/Eralde/mndw/commit/7ae650e0a129027bbe92a91d5ec6bcb5728cb60d))
- Plugins can ask a yes/no question with `await ctx.overlay.confirm({title, message, confirmLabel, danger})`. The
  host draws the dialog; every way of closing it other than the confirm button returns `false`.
  `ctx.overlay.open` takes a new `role: 'alertdialog'` option for urgent dialogs of your own. `@mndw/sdk/testing`
  records toast calls and can preset the answer of `overlay.confirm` in plugin tests.
  ([7ae650e](https://github.com/Eralde/mndw/commit/7ae650e0a129027bbe92a91d5ec6bcb5728cb60d))
- `ctx.device.info.switchports.list[]` entries have three new flags from the device's port map:
  - `isReversed`: the port is mounted upside down on the device body, so a drawing of the case should flip it;
  - `isCombo`: a combo port with an Ethernet socket and an SFP cage, Ethernet first;
  - `isComboInverted`: a combo port with the SFP cage first.

  Each flag is `false` when the device does not say.
  ([c01a62c](https://github.com/Eralde/mndw/commit/c01a62ced61be936828507a16199f31d5691bcfd))
- A widget's `onResize` is now called once right after mount with the tile's size in grid units, so a saved small
  tile can pick its compact layout at once. Later resizes still call it; the mobile layout does not.
  ([03faf5e](https://github.com/Eralde/mndw/commit/03faf5ea478df858ab7ac28fd30b2753bea9d30e))
- New `<mndw-switchport>` element: a drawing of a router port as on the case. It draws Ethernet in blue, gray or
  orange, SFP, DSL, and combo ports (Ethernet then SFP, or SFP then Ethernet) with the active medium highlighted.
  It also shows the link LED, a port mounted upside down, and selected or disabled states. It only draws: wrap it
  in your own button and give that button the accessible name.
  ([db245b2](https://github.com/Eralde/mndw/commit/db245b2e1bad392dbb0a924b130f49422a463f31),
  [a23434f](https://github.com/Eralde/mndw/commit/a23434f1d696eb4f20bb919d823b9beba7b77b30))
- New `<mndw-radio-group>` with `<mndw-radio>` children: a form field with `name`, `value`, `required`, `disabled`,
  `size` and `orientation` (vertical by default). Arrow keys move and select, and it fires `mndwchange` on user
  selection. Use it instead of `<mndw-segmented>` for longer labels or more options.
  ([2751117](https://github.com/Eralde/mndw/commit/275111788adb28ae71a5c6b5127adc6d30624479))
- New `<mndw-progress>` element: a bar for a known `value` out of `max`, or an indeterminate bar without a
  value. It sets `role="progressbar"` and the `aria-value*` attributes for screen readers.
  ([8aaf145](https://github.com/Eralde/mndw/commit/8aaf145448c9532d1784f8fefe9e8c8a9d6e2c65))
- `@mndw/ui` controls take a `size` attribute: `size="sm"` makes `<mndw-button>`, `<mndw-input>`,
  `<mndw-select>` and `<mndw-segmented>` 28px tall instead of 32px, so compact controls line up in a widget
  header. `<mndw-icon>` takes `size="sm" | "md" | "lg" | "xl"` (1–2rem); without it the icon still follows the
  text size. The `MndwControlSize` and `MndwIconSize` types are exported from `@mndw/ui`.
  ([6acc3b0](https://github.com/Eralde/mndw/commit/6acc3b00385a534e9c84668e2e2623f54a20aa2c))
- `size="sm"` now also works on `<mndw-tabs>`, `<mndw-textarea>`, `<mndw-slider>`, `<mndw-checkbox>` and
  `<mndw-switch>`. Tabs and slider take the 28px row height; textarea gets smaller padding; checkbox and switch get
  a smaller indicator and keep their `md` look unchanged.
  ([1646e15](https://github.com/Eralde/mndw/commit/1646e15fd0152b99a47daffa7c6bb9c85ce4deb6),
  [2751117](https://github.com/Eralde/mndw/commit/275111788adb28ae71a5c6b5127adc6d30624479))
- `<mndw-segmented>` now has the same outer height as the other controls, with an even inset around the
  segments. Before, it was taller than a button next to it.
  ([6acc3b0](https://github.com/Eralde/mndw/commit/6acc3b00385a534e9c84668e2e2623f54a20aa2c))
- `<mndw-line-chart>` takes `value-ticks` to choose roughly how many dashed value lines to draw (d3 rounds them,
  so 5 on 0–100 gives 20, 40, 60, 80, 100) and `value-axis` to draw the vertical axis line.
  ([c266d2e](https://github.com/Eralde/mndw/commit/c266d2ecf1cb4af3645c63f65aad45a455624313))
- `@mndw/ui/styles.css` has a `.mndw-link` class for text links on a native `<a>`. It uses the text colour and an
  underline, keeps the colour on hover, and shows the focus ring on `:focus-visible`.
  ([aff4a11](https://github.com/Eralde/mndw/commit/aff4a113920c83ddfeecaea9d9719e6e928d7f75))
- `mndw create` for a Svelte plugin now adds a `tsconfig.json`, so ESLint type-checks the plugin's `.ts` and
  `.svelte` files with the plugin's own project. A Svelte plugin made earlier can add the same file.
  ([0ae185e](https://github.com/Eralde/mndw/commit/0ae185edd0126f5218991929449e696064bd77ba))
- New iperf-widget example: a speed test tile with a Go service backend that runs Entware's `iperf3`
  (`backend.packages: ["iperf3"]`) and streams download, upload and ping over a WebSocket route. The tile shows a
  gauge, a per-second chart and the last 10 results, and picks one of three layouts from its own height. Archives
  for aarch64, mips and mipsel come from `pnpm build-example-plugins`.
  ([093c058](https://github.com/Eralde/mndw/commit/093c058e3661f0b686d72074526e8e98b98cc502))
- The ping-widget example keeps its controls aligned at any card width. The poll interval moved next to "Refresh
  now", and in a narrow card the table drops the Avg column and shows the host label above its address.
  ([2394bac](https://github.com/Eralde/mndw/commit/2394bac264768ce0ecd222d67d050c7f6cd9dc61))
- The RCI device-description example and its tutorial show `ctx.overlay.confirm` (asking before "Restore
  original") and `ctx.toast` (reporting a confirmed save), and explain when an error stays next to the field
  instead. ([e302733](https://github.com/Eralde/mndw/commit/e3027330ac0ecc19a53ffdf4e845587d12d5da6d))
- The Hello and RCI tutorials now start by installing `@mndw/cli` in the project. Without it, `npx mndw create`
  fails with `E404`. ([ca5d066](https://github.com/Eralde/mndw/commit/ca5d066c14c4bfa8003e93064005c2505dd3b7cb))

## 0.3.3 — 2026-11-20

### For users

- Signing in from Firefox works again. Firefox hides the router's login challenge from `fetch`, so login and
  every router request now go through XMLHttpRequest.

### For plugin authors

- The host provides `@rci-tools/core` 0.6.1 instead of 0.6.0. Its `XHRTransport` keeps every
  `WWW-Authenticate` challenge that Firefox merges into one header. Plugins built against 0.6.0 keep working:
  the compatibility level stays `0.6`.
  ([8636ff6](https://github.com/Eralde/mndw/commit/8636ff681ae9944286008b16eb66b32c62c850e8))

## 0.3.2 — 2026-11-20

### For users

- Entware, packages:
  - **Actions.** The table stays on screen while opkg works: the busy row shows its progress, and other actions
    wait until it finishes. The "N packages loaded" message is gone.
  - **Search and descriptions.** Search matches descriptions too, and each description shows under the package
    name.
  - **Toolbar rows:**
    - a box saying when the package list was last updated, with "Check for updates" (yellow once the list is over
      an hour old);
    - the tabs with the search;
    - a selection row that always stays in place, offering only the actions that apply, with counts, and "Clear
      selection".
  - **After a failed action.** The list reloads, so it shows what opkg actually did. If the reload fails, a
    warning with "Retry" appears above the table.
  - **Details.** Statuses are translated, and the expanded row has padding.
- Entware, protection: lighttpd (the package and its service) is no longer protected and can be updated, removed,
  stopped or restarted. mndw stays protected: its row shows a "Protected" label and a link to Settings → "Update
  mndw", and bulk Update skips it.
- Entware, services: a running service shows Stop and Restart, and a stopped one shows Start. States are
  translated, and protected services show a "Protected" label instead of disabled buttons.
- Entware, page: one "Entware" heading sits above the tabs. On a narrow screen the tables fit without sideways
  scrolling: version, status, state and autostart move under the name.

## 0.3.1 — 2026-11-20

### For users

- "+ Add Widget": each widget is laid out the same way, with the name on the left and the description on the
  right; the size is no longer shown. The panel is wider, and the keyboard focus ring is no longer cut off at its
  edges.
- Main menu: a thin line replaces the "PLUGINS" heading above plugin pages.
- Settings: the last tab is called "Update mndw". The plugin risk warning is split into three paragraphs, and
  the installed plugin list no longer repeats the plugin ID under its name.
- Russian: the widget page is called «Дашборд» instead of «Панель управления».
- Device info: the history range switcher and the settings button share one row, with the button on the right
  as in the other widgets. The row stays in place while data loads.
- System log: the "Filter" button has a border and lines up with the counter next to it.
- MWS map: an offline node that is hovered or selected is outlined in its own muted red instead of the accent
  colour.

## 0.3.0 — 2026-11-19

### For users

- Settings → Plugins: the list of what a plugin asks for is now called "Capabilities" («Доступы»). Grants
  already given on the router are kept after the upgrade.
- The daemon log no longer grows without limit. It now lives in RAM at `/tmp/mndwd.log`, capped at about
  1 MB (current file plus `.1`), and repeated lines collapse into "last message repeated N times". The old
  `/opt/var/log/mndwd.log` is removed on upgrade. Crash output goes to `/opt/var/log/mndwd.crash.log`; the
  previous run's trace is kept as `.1`.
- The daemon no longer logs "event log poll failed" every 10 s when background router access is not set up:
  the router event poller waits until it is. Ordinary HTTP requests and requests the browser cancelled are no
  longer logged.
- The Add widget dialog shows each widget's description and its size (columns × rows). After you add a widget,
  the dashboard scrolls to it and briefly highlights it.
- Plugin names in the sidebar, settings and the Add widget dialog are shown in the dashboard language when the
  plugin provides a translation.
- A form field with an error now has a red border and a red focus ring, not only the message under it.
- "Clear controller access" in Settings asks for confirmation first.
- If the browser cannot store dashboard changes (storage full or blocked), a warning says so instead of
  losing them silently on reload.
- Fixed: a slow router reply from before you saved a new controller token could mark the new token invalid
  and drop background router sessions.
- A widget that fails to start now shows an error with Retry instead of an empty tile.
- A disabled, deleted or upgraded plugin's styles are removed once nothing uses them; before, they stayed in the
  page until reload and could restyle other parts of the dashboard.
- The daemon's settings files are written so that a power cut cannot leave them half-written or lose the last
  change. If `state.json` is unreadable, it is kept as `state.json.bak-<time>` (earlier copies are kept too) and the
  daemon refuses to start if it cannot make that copy; an unreadable palette falls back to the default palette.

### For plugin authors

See "Upgrading to 0.3" for the migration steps. Change `@mndw/sdk` and `@mndw/ui` to `^0.3.0`.

- **Breaking.** `PluginContext` is grouped: `storage` → `storage.instance`, `sharedStorage` →
  `storage.shared`, `theme`/`theme$`/`palette`/`palette$` → `appearance.*`, `deviceInfo` → `device.info`,
  `rciManager` → `device.rci`, `createTicker()` → `timers.createTicker()`. `ctx.locale` and `ctx.locale$`
  are gone; `i18n.change$` is now `i18n.locale$`: it emits the current locale on subscribe, then each new
  locale after its catalog is applied. https://github.com/Eralde/mndw/commit/eb80a32
- **Breaking.** The manifest field `permissions` is now `capabilities` (values unchanged); the old field is a
  validation error. `BackendBlocker.permission` is now `capability`, and the SDK vocabulary exports use
  capability names. https://github.com/Eralde/mndw/commit/eb80a32
- **Breaking.** The manifest rejects unknown fields: a typo such as `capabilites` now fails with
  `manifest contains unknown field "capabilites"` instead of being ignored. The same holds inside `size`.
  `$schema` (a string) is allowed for editors and is not part of the validated manifest. https://github.com/Eralde/mndw/commit/9bc60b4
- **Breaking.** The manifest field `icon` is removed; an old manifest fails validation with
  `icon was removed in 0.3`. The field `fixedHeight` is removed the same way (`fixedHeight was removed in
  0.3`); it never had any effect. New optional `description` (1–160 characters). Catalogs can translate the
  name and description with the reserved keys `manifest.label` and `manifest.description`.
  https://github.com/Eralde/mndw/commit/2c0d394 https://github.com/Eralde/mndw/commit/d5c2098
- **Breaking.** `@mndw/sdk/refresh` is removed. Use `ctx.timers.createRefreshLoop({load, intervalMs,
  onSuccess, onError})`: `load` gets an `AbortSignal` that aborts on `stop()` and when the plugin is disposed,
  and every loop stops with the plugin. https://github.com/Eralde/mndw/commit/889497e
- **Breaking.** `ctx.backend` and `ctx.events` are always present, and a widget context always has
  `setTileTitle`. Without a manifest backend, `fetch`/`call`/`status` reject with `BACKEND_NOT_DECLARED`.
  These three report every error, including unknown ids and the wrong transport, by rejecting, never by a
  synchronous throw. `socket()` still throws for author errors; for a backend that is not approved or is
  disabled it returns a closed socket with close code `BackendSocketCloseCode.notApproved` (4001) or
  `.disabled` (4002). `ctx.events.select$()` errors for a topic outside the manifest capabilities and names
  the one to add; `*` still narrows silently. The test double records titles in `fixture.tileTitles`.
  https://github.com/Eralde/mndw/commit/c88c35c
- **Breaking.** `@mndw/sdk` no longer exports `createPluginRci`, `PLUGIN_RCI_MANAGER_METHODS`,
  `PluginRciManagerMethod` or the Zod schemas `pluginCapabilitySchema`, `eventCapabilitySchema` and
  `persistentRciCapabilitySchema`; check values with `isPersistentRciCapability` and `EVENT_CAPABILITY_PATTERN`.
  Zod is no longer part of the plugin-facing API. https://github.com/Eralde/mndw/commit/c5fe6f7
- **Breaking.** `createAngularPluginInstance` returns `Promise<PluginInstance>`: it resolves once the component is
  mounted and rejects (after cleaning up) if mounting fails. Return it from `createInstance`; the host then shows
  the error with Retry. https://github.com/Eralde/mndw/commit/c5fe6f7
- New `ctx.device.rci.query(q, {signal})`: the promise form of `queue()`, with the same typed results.
  Aborting stops waiting only: a queued request is still sent, and a write is not rolled back.
  `RciQuery`, `RciBackgroundProcess` and `RciResponseHelper` are now exported from `@mndw/sdk`, so a plugin
  no longer needs its own `@rci-tools/core` dependency. `@rci-tools/core` is part of the plugin contract:
  its breaking changes come with a minor mndw version. https://github.com/Eralde/mndw/commit/ad0b9d8
- `createTestPluginContext` gives the plugin a lifetime-bound view of `options.i18n`; keep your own
  `createTestI18n()` reference to switch locales in tests. https://github.com/Eralde/mndw/commit/eb80a32
- The router's manifest check now agrees with `mndw validate` on fields that do not belong to the plugin type:
  `size` on a page and `route` on a widget are ignored and dropped, whatever their value.
  Before, the router rejected such a manifest when the field had the wrong shape, and kept it otherwise.
  https://github.com/Eralde/mndw/commit/0a4a6b8
- `@mndw/ui` `mndw-input`, `mndw-textarea`, `mndw-select` and `mndw-slider` show a danger border and focus
  ring when `invalid` or `aria-invalid="true"` is set. https://github.com/Eralde/mndw/commit/09eed50

## 0.2.0 — 2026-11-18

### For users

- The daemon reads each request body in full, after the login check, within size and time limits. A slow or
  stalled client can no longer hold a connection open. Idle keep-alive connections close after 120 s. At most
  16 bodies are read at once. When all slots are busy, the daemon answers 503 `SERVER_BUSY` with
  `Retry-After: 1`.
- Requests to the device through the dashboard (`/auth`, `/rci`, `/ci`) have the same protection: the body is
  read in full (16 KiB for `/auth` and `/ci`, 1 MiB for `/rci`, 15 s) before it goes to the device, with its own
  16 slots so these requests cannot block dashboard settings.
- Dashboard: a widget whose plugin failed to load keeps its tile, in the same place and size, with Retry and
  Remove. Tiles of a disabled plugin or one waiting for approval are hidden and come back when it runs again.
  Tiles of a deleted plugin are removed together with their data. If the plugin list itself does not load, the
  dashboard does not change the saved layout.
- CPU temperature and device info widgets: when a refresh fails after data was shown, the data stays and a note
  says "Not updated since 14:32 · Retry" (with the date once it is not today). Retry reloads at once. In device
  info the note covers both the live values and the 7d/30d chart, and without a fresh answer from the router the
  uptime is shown as an estimate ("≈"). The CPU temperature error screen has Retry too.
- Terminal page: shows "Connecting…" until the terminal really answers, instead of "Connected" after a fixed
  second. If it does not connect within 3 s, the page says so and offers Retry. Keys typed while connecting are
  not lost: input opens once the terminal is ready. The console can be switched in every state, also after an
  error, without leaving the page.
- System log page: shows whether the live log is connected. When the stream drops, the page reconnects by itself
  after 1, 2, 5, 10 and then every 30 s, or at once with Reconnect, and fills in the lines it missed. Errors of
  the stream, the first load and Clear are shown separately, and a stream error goes away once lines arrive.
- System log page: the "Clear system log" confirmation is translated, including its screen-reader label. Before,
  it was in English in every language.
- When plugins fail to load, one notification names them and offers Retry; it updates as plugins recover and
  says "Plugins loaded" once all of them do. A page plugin that failed to load keeps its menu item, with a
  warning icon, and its address opens a placeholder with Retry instead of "not found"; after a successful retry
  the page opens in place. The notification goes away on logout.
- Settings → Plugins: a plugin that failed to load is marked "Failed to load", with the reason in plain words
  (it did not load within 15 seconds, or its file did not load or has an error) and a Retry button.
- Packages → Services: shows "Loading…" while the list loads, instead of "No services".
- Packages: the Cancel button of the remove/update confirmation is translated. Settings: a saved controller token
  shows "Token is set" in the field instead of `<TOKEN SET>`.
- Settings → Plugins: counts of endpoints and websockets use correct Russian forms ("2 конечные точки"), the
  plugin type is translated, and "Built-in" is shown once instead of a raw "Source: builtin" next to it.
- Settings: the controller token check says in words whether the token is valid, rejected or the device is
  unreachable, instead of a raw code; a failed check is shown as an alert.
- Packages: the metadata age is shown in minutes, hours or days ("3 days ago") instead of only minutes.
- Disabling or deleting a plugin no longer waits until queued services have started.
- Stopping the daemon respects its time limit: plugins that ignore the stop signal are killed in time, and
  pending restarts of failed services no longer fire after the plugin was stopped or removed.
- When more plugin services are enabled than the daemon runs at once (8), the builtin ones (terminal, DNS lookup)
  now always get a slot first, as documented; before, the order depended on timing. A service waiting for a slot
  stays "starting" until it starts.
- The daemon no longer spins a CPU core when the RCI session socket keeps failing to accept connections: it
  retries after 5 ms, backing off to 1 s.
- Dashboard on a phone, Arrange widgets: the new order is applied only with Save. Escape, × and a tap outside
  close the panel and keep the old order; before, any way of closing applied it.
- A plugin backend keeps its service slot until its old process has really exited, so a slow or stuck
  process no longer lets another service start over the limit. A plugin re-enabled, restarted or
  reconfigured while its old process is still stopping now starts once that process exits instead of
  staying stopped. This also covers a process that is still being launched or whose start was cancelled.
  When the daemon stops, it waits up to 2 s more for such processes to exit, then cleans up after them; a
  plugin that exited during that wait is no longer reported as failed to stop. The stop phase now takes up
  to 19 s at defaults.
- `mndwd` has 16 fewer command-line options: fine-grained timeouts and limits (exec, request body, HTTP drain,
  service stop, persistent RCI session, telemetry sync) are fixed at their previous defaults. The router
  package never set them; `mndwd --help` lists the remaining options.
- Settings → Plugins: enabling, disabling, approving, installing and deleting a plugin take effect at once,
  without reloading the page. The menu and the dashboard tiles update, and an open page of a removed plugin
  returns to the dashboard. A reload is asked for only when a newer version of a loaded plugin is installed.
  Built-in plugins can now be disabled too (not deleted).
- Settings → Plugins: each row shows one message coloured by meaning, service states are plain words
  ("Running", "Restarting after a failure"), and technical details are under Diagnostics. The upload and
  approval dialogs show the same risk text: plugins run with full access, and permissions are not a sandbox.
- Dashboard: a removed widget can be brought back with Undo for 8 seconds; its saved data is deleted only
  after that. Add widget and Arrange widgets open as standard dialogs. The dashboard draws each widget's title
  once; built-in widgets no longer repeat it inside the tile.
- Settings: "Persistent RCI session" is now "Background router access", with a plain description;
  extenders are one collapsed block with problems shown outside it. The telemetry setting is always shown and
  is disabled, with a link, while background access is off. Language moved to the "Interface" section.
- Packages: each package has one action by its status (Install, Update or Remove); bulk actions appear only
  when packages are selected; one "Check for updates" button shows when the list was last checked; a failed
  list load has Retry; search has a label.
- Login page: a small, muted hint under the fields says to use the router's administrator login and password.
- Russian translation: «ретрансляторы» instead of «расширители», and «сессия» instead of «сеанс».
- Texts: English labels use sentence case, one style of quotes and `…` throughout. "System update" is now
  "mndw update", the packages page is "Entware packages", and the upload limit reads "10 MiB". Widgets that
  need telemetry point to "Background router access" in settings.
- Settings: a hint under the controller token says where to create one (the router's Users & Access page or
  its command line).
- The result of an action (saved, failed to save, no update available) is shown as a notification; repeated
  failures do not stack up, and an error notification stays until closed. Problems you still have to fix stay
  next to where they are, in red with Retry; explanations that are not errors are grey.
- An empty plugin list, package list or service list says what to do next: upload a plugin, or
  "Show all packages" after a search with no results.
- CPU temperature and device info widgets: when telemetry collection is off, the chart keeps the stored history
  and a note above it says collection is off and up to which time the data goes, with a link to Settings.
  Without background router access the note says to set it up instead. The note appears and goes away
  as soon as the setting changes, in this tab or another one. In the device info widget this applies to the 7d
  and 30d ranges.
- Settings → Plugins: an installed plugin built for a different `@mndw/sdk` version than the dashboard provides
  is marked "Built for another SDK version", with the full warning below its name. Before, the warning showed
  only on upload.
- Device info widget: on a wide tile the labels of both identity blocks share one column, with a little more
  space before the values.
- MWS page: the "Settings" links in the extra-features setup notice and popover get their address from the
  dashboard, instead of a fixed path.
- Security: the daemon no longer serves plugin backend files or plugin update backups over HTTP, and
  `/user-plugins/` needs a login. Update backups are removed after a successful update and when the plugin is
  deleted. The daemon no longer follows redirects for the browser.
- Installing on a router without curl no longer fails: the package depends on `wget-ssl`, and a broken HTTP
  client is reported by name instead of as "no `/auth` on any port".
- Settings → Plugins: an uploaded plugin with a backend shows "waiting for approval" instead of "disabled".
  Uploading the same ZIP again works.
- The plugin list can no longer hang while loading: after 15 s it shows an error with Retry. A page plugin
  shows "Loading…" after a short pause, an error with Retry if it fails, and "taking too long" with Retry after
  10 s.
- The dashboard says why it is empty: the plugin list failed to load, no enabled plugin has widgets, or no
  widget was added yet (with Add widget). Removing a widget that is still loading closes it cleanly, and
  removing a tile that never loaded deletes its saved data too.
- A login attempt that failed in the background no longer logs you out of a newer session. The login page has
  Retry, and the collapsed sidebar works with a screen reader.
- Palette settings, widget errors and page dependency notices are translated; raw error text no longer appears
  on screen. The backend approval dialog warns what an approved backend can do.
- Terminal page: each console type has its own terminal server, so closing one tab or switching the console no
  longer ends the sessions in other tabs.
- Widgets: Clients shows when its list is stale; the traffic chart keeps polling after errors and no longer
  cancels slow polls; Device info copy works over plain HTTP or says it failed; two DNS lookup widgets no longer
  share element ids. The MWS page puts a setting back when saving it fails.
- Tooltips stay open while the pointer moves onto them, and their text can be selected and copied. Selects mark
  only the chosen option and work again after being disabled; Escape in a table column menu returns focus to its
  button.

### For plugin authors

- **Breaking.** `ctx.backend.call(id)` is the main way to call a plugin backend: it returns the decoded result
  (JSON, text or `Blob` by `Content-Type`, or `as`) or throws. Every platform failure, including
  `SCRIPT_FAILED`, `SCRIPT_TIMEOUT` and `BACKEND_BUSY`, is now a `BackendError` with `message`, `code`,
  `status`, `retryable` and `details`, from both `call` and `fetch`. `fetch` still returns your backend's own
  response, any status and any JSON. The daemon marks its own errors with `X-Mndw-Error: 1` and strips that
  header from plugin responses. See "Upgrading to 0.2". https://github.com/Eralde/mndw/commit/74ce747
  https://github.com/Eralde/mndw/commit/84d5f6b
- **Breaking.** Backend lifecycle errors (`BackendStarting`, `BackendUnavailable`, `BackendIncompatible`,
  `BackendMaintenance`, `BackendBlocked`, `BackendBadGateway`) no longer carry the deprecated `daemonCode`. Read
  `code` instead; it holds the same value. https://github.com/Eralde/mndw/commit/4129db8
- **Breaking.** `backend.command` and every `backend.routes[].command` must live under `backend/`; the
  validators reject other paths. The daemon never serves `backend/` over HTTP.
  https://github.com/Eralde/mndw/commit/3a5134b
- **Breaking.** The host draws a widget's tile title. Set it with `ctx.setTileTitle?.(ctx.i18n.t('title'))`,
  update it when the locale changes, and do not draw a second title inside the widget. Pages keep their own
  `<h2>`. https://github.com/Eralde/mndw/commit/2dee2df
- **Breaking.** The host sets `data-theme` on the plugin container; plugins no longer set it themselves.
  `mndw validate` warns about CSS selectors outside the plugin's `.<name>` root (allowlist:
  `mndw.cssSelectorAllowlist` in `package.json`). Node.js 22 or newer is required (`engines`).
  https://github.com/Eralde/mndw/commit/a8065b3
- **Breaking for hand-written contexts.** `PluginContext` gains `navigation`, `telemetry.gathering$` and
  `signal` (below), and its members are `readonly`. A context built by hand must provide them;
  `createTestPluginContext` already does. https://github.com/Eralde/mndw/commit/74ce747
- **Breaking for code that mutates events.** Events are frozen before delivery and their SDK types are
  `readonly`. A `*` request no longer widens a narrower grant: a plugin granted `events:wan` that asks for `*`
  gets only `wan`. A topic added while the history replays now arrives at once.
  https://github.com/Eralde/mndw/commit/ea351dc
- **New minor.** Move `@mndw/sdk`, `@mndw/ui`, your UI adapter and `@mndw/cli` to `^0.2.0`; `@mndw/ui` now peers
  on `@mndw/sdk` `^0.2.0`, and `mndw create` writes `^0.2.0`. The
  [Upgrading to 0.2](https://eralde.github.io/mndw/guides/upgrading-to-0-2) guide lists every change to make in a
  0.1 plugin. https://github.com/Eralde/mndw/commit/8f0e1a0
- `ctx.signal` is aborted with a standard `AbortError` when the host disposes the plugin context, so a plugin
  can cancel backend calls, async setup and its own retry loops. The context is now disposed even while
  `createInstance` is still pending. https://github.com/Eralde/mndw/commit/e2fb8e0
- `ctx.navigation` links a plugin to host pages without hard-coded paths. `href(target)` returns the URL and
  `navigate(target)` opens it. A target is the dashboard, packages, settings (optionally a tab) or an installed
  page plugin, with an optional child path. For an unknown target `href` returns `undefined` and `navigate`
  returns `false`. `createTestPluginContext` records the calls in `navigationCalls`.
  https://github.com/Eralde/mndw/commit/f2de0a3
- `ctx.telemetry.gathering$` tells a plugin whether the dashboard is collecting telemetry. It emits the current
  state once it is known, then every change: from Settings in this tab, or from another tab through the daemon
  event `telemetry.gathering_changed`. It completes when the plugin unmounts. In `createTestPluginContext` pass
  `{telemetry: {gathering$}}`; the default never emits. https://github.com/Eralde/mndw/commit/2450417
- Plugin backends: a GET or HEAD request with a body gets 400. A request body that does not arrive within 15 s
  gets 408 `REQUEST_TIMEOUT`. Service backends now receive the request body fully buffered (up to
  `-max-request-bytes`) instead of streamed. https://github.com/Eralde/mndw/commit/006da0d
- Service backends: when your service fails after it started sending a response, the daemon aborts the
  connection instead of appending a JSON error to a partial 200. Failures before the response starts still get a
  502 JSON error. https://github.com/Eralde/mndw/commit/672af3c
- `go-httpsocket`: `Serve` now waits up to 10 s for in-flight requests to finish before it returns, so a service
  no longer exits in the middle of a request. https://github.com/Eralde/mndw/commit/85d4848
- `mndw create` templates are minimal: a title, one backend call and a button. The table example lives in the
  UI components guide. Svelte: `mndwSvelteWarningFilter` from `@mndw/sdk/svelte` hides the false a11y warning
  on `<mndw-button>` in tests and the editor; `mndw pack` and `mndw dev` use the same filter. Clearer manifest
  errors for `gridColumns`, `version` and empty `routes`. `mndw build-backend [plugin-dir]` takes an optional
  plugin directory. https://github.com/Eralde/mndw/commit/a8065b3
- `mndw pack` minifies production bundles (JS, CSS, workers) and strips source comments, so packed plugins no
  longer carry build-machine paths; legal `/*! */` comments stay. `--dev` output stays readable. Templates and
  examples no longer render the hidden `l10n-probe` element. https://github.com/Eralde/mndw/commit/6c38039
- `<mndw-line-chart>` and `<mndw-bar-chart>` take a `tooltipFormatter` property. It gets the hovered time and
  the raw value of each series, and returns a title and rows for the tooltip, or `null` to hide it. If it throws,
  the chart logs the error and shows the default tooltip. The tooltip is now placed by its measured size, so a
  wide one stays inside the chart. https://github.com/Eralde/mndw/commit/5073b3f
- `<mndw-tooltip>` is hoverable and its text can be copied; `hideDelay` / `hide-delay` (default 300 ms) sets how
  long it stays after the pointer leaves. https://github.com/Eralde/mndw/commit/ac57243
- `@mndw/ui` fixes: `<mndw-select>` marks only the chosen option as selected and re-enables its trigger, closing
  the popup when disabled; `<mndw-button>` forwards ARIA state attributes to its inner button; the table column
  menu returns focus to its trigger on Escape. https://github.com/Eralde/mndw/commit/ba47655
  https://github.com/Eralde/mndw/commit/2558e09 https://github.com/Eralde/mndw/commit/6825af0
  https://github.com/Eralde/mndw/commit/ff1cb05
- `LoadState`: `unsupported.reason` explains missing data or a missing capability, not a failure. Show it as
  muted `role="status"` text; keep red `role="alert"` with Retry for real failures (styling guide).
  https://github.com/Eralde/mndw/commit/2dee2df
- Built-in plugins can be disabled like uploaded ones; the manifest they ship with stays authoritative. The
  manifest guide says plainly that permissions describe what a plugin asks for and are not a sandbox.
  https://github.com/Eralde/mndw/commit/3cb422d
- Docs: `storage` and `sharedStorage` are described as what they are today (browser `localStorage`, per
  browser, not readable by the backend, not isolated between plugins); every `PluginContext` member is
  documented; the styling guide has a "Texts" section (sentence case, `…`, “…”/«…» quotes, verbs on buttons);
  the author guides match the current scaffold and examples. https://github.com/Eralde/mndw/commit/2420d12
  https://github.com/Eralde/mndw/commit/ecf6edf https://github.com/Eralde/mndw/commit/f3e6337

## 0.1.6 — 2026-11-08

### For users

- Drop-down lists and the table column menu work fully from the keyboard, following the WAI-ARIA Authoring
  Practices: arrows, Home/End, Page Up/Down, typing the first letters, Enter or Space to choose, Escape to close,
  and Tab picks the highlighted option and moves on.
- After switching the language, focus stays on the language menu.
- Segmented controls (for example, a chart's range selector) can be reached with Tab; the arrow keys then pick a
  segment.
- Event logger widget: on a narrow tile the filter field takes its own line and the buttons move below it,
  instead of the field shrinking to nothing.
- The install command works on a clean Entware: it installs `wget-ssl` and `ca-bundle` first, because the feed is
  served over HTTPS and Entware's default `wget` has none. Without an HTTPS-capable `wget`, the bootstrap script
  now says so before it changes anything, instead of failing later inside `opkg update`.
- mndw no longer hangs for minutes on start while looking for the router's web port when `wget-ssl` is
  installed: each port is probed once.
- Terminal page: installing or updating mndw now also installs `ttyd`, which the terminal needs. Before, the page
  failed with "failed to start terminal" on a router without it. If `ttyd` is removed later, the page says so and
  shows `opkg install ttyd`.
- The login page puts focus in the username field when it opens.
- MWS page: long node names no longer run past the card on the first load.
- Clients widget: the refresh interval in the settings shows the value you pick, not the one it opened with.

### For plugin authors

- **Breaking:** `<mndw-slider>` drops `value-text`. Set the `valueFormatter` property, `(value: number) => string`,
  instead: the slider applies it on every change to the visible value and to `aria-valuetext`. Without a formatter
  it shows the number and leaves `aria-valuetext` to `aria-valuenow`. https://github.com/Eralde/mndw/commit/41833f3
- **Breaking:** `<mndw-select>`'s trigger is now a `button[aria-haspopup=listbox]` instead of a `role=combobox`
  host, and the list uses `aria-activedescendant` with type-ahead. The table column menu uses `role=menu` with
  `menuitemcheckbox` items: Space toggles and keeps it open, Enter toggles and closes. Tests or styles that
  select `[role=combobox]` need updating. https://github.com/Eralde/mndw/commit/79e7461
- **Changed defaults:** `<mndw-line-chart>` and `<mndw-bar-chart>` now format values as plain locale-aware
  numbers and round the Y axis up from the data, with no 5000 floor. For traffic, set
  `valueFormatter = formatSpeed` and `valueDomain = {min: 0, max: getSpeedUpperLimit(max)}` (both exported from
  `@mndw/ui`). `<mndw-bar-chart>` now takes `valueDomain`. https://github.com/Eralde/mndw/commit/36d1331
- SDK: every backend error extends the new `BackendError` and has `code` and `id`; switch on `err.code`. The
  lifecycle errors' `daemonCode` is deprecated and goes away in 0.2.0. Telemetry `unit` is the open type
  `TelemetryUnit`: an unknown unit no longer breaks decoding; use `isKnownTelemetryUnit()` and show other units
  as received. https://github.com/Eralde/mndw/commit/aa6be18
- `mndw create --backend go` writes current `tsx`, `vitest` and `happy-dom` ranges instead of fixed old ones.
  https://github.com/Eralde/mndw/commit/b3c1b77
- `<mndw-segmented>`, `<mndw-tabs>`, `<mndw-checkbox>` follow the APG keys. Segmented: all four arrows and Space,
  no Home/End or Enter, `aria-orientation="horizontal"`, and no `tabindex` on the host (it hid the group from
  Tab). Tabs: Up/Down are left to the page. Checkbox: only Space toggles. Modal drawers set `aria-modal="true"`.
  https://github.com/Eralde/mndw/commit/bfc8b34
- `<mndw-select>` and the table column menu move focus into the list even while the overlay is still being
  positioned: the host and fallback overlays hide an unpositioned popover with `opacity` instead of `visibility`.
  The select's focus ring has rounded corners, like the other form controls. https://github.com/Eralde/mndw/commit/e3aebc8, https://github.com/Eralde/mndw/commit/5624299
- A builtin plugin's `backend.packages` are now installed with mndw: the IPK and the feed index declare them as
  opkg `Depends`. Uploaded plugins keep getting theirs on approval. https://github.com/Eralde/mndw/commit/faebd12

## 0.1.5 — 2026-11-07

### For users

- Hover states on tabs, segmented controls and ghost buttons are easier to see.
- Clients widget: the status dot no longer shrinks, the "Last seen" column is hidden by default, and the widget
  fits narrower tiles.
- CPU temperature widget: the chart fills the tile, and the range selector no longer squeezes it.
- Device info widget: two columns on wide tiles, and the load chart no longer jumps while loading.
- DNS lookup and event logger widgets: a larger default size (4×6).
- MWS page, map:
  - node cards are easier to read;
  - an offline node says "Offline";
  - icons on the card show an available update and telemetry or remote-control problems;
  - one rounded focus ring.
- MWS page, node drawer:
  - the name with a Rename button next to it;
  - backhaul shown with the node details;
  - the Status tab is now Telemetry, and it explains when there is no data.
- MWS page, other tabs:
  - Nodes: the controller comes first;
  - Settings: a clearer layout;
  - Transition log: Download CSV is disabled while the log is empty.
- The daemon now logs why a controller test failed, and warns when the front-door port was busy and a fallback
  port was used. A wrong listen address is reported as such instead of "no port available".

### For plugin authors

- New theme token `--mndw-control-hover`. A saved palette without it still loads, and the value is derived from
  `surface`. https://github.com/Eralde/mndw/commit/c000d9d
- `@mndw/ui`:
  - `mndwIconHref(name)` and `subscribeMndwIconSprite(callback)` draw sprite icons inside your own SVG;
  - new icons `activity`, `circle-arrow-up` and `unlink`;
  - `<mndw-table label>` names the table for screen readers;
  - number cells use tabular figures instead of the monospace font;
  - the `<mndw-field>` error is plain red text;
  - fixed the bar-chart hover index and the heat-strip shading;
  - the icon sprite URL is shared by all copies of `@mndw/ui` on the page, so plugins see icons in the dev host
    too.

  https://github.com/Eralde/mndw/commit/e9bf104
