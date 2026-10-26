# Local development

Run the CLI from the repository root while developing a plugin. The local
daemon is started from this checkout, so `mndw dev` requires Go 1.26.1, the
version pinned by `go.work`:

```bash
pnpm exec mndw dev plugins/examples/hello-widget
```

`mndw dev <plugin-dir>` starts an isolated local daemon and host and loads plugin source with HMR.
The local daemon uses a stub device by default, so the UI and backend can be exercised without
device RCI data. The local daemon listens on port `9090` by default; use `--port <port>` if that port
is already occupied. Stop the command with Ctrl-C to stop both processes.

To proxy RCI and authentication requests to a real Keenetic device, pass its base URL:

```bash
pnpm exec mndw dev plugins/examples/rci-device-name-widget \
  --host-device http://router.lan
```

Alternatively set `MNDW_HOST_DEVICE` in the environment before running the command. The explicit
`--host-device` value takes precedence. The URL must be reachable from the development machine. A
real device is optional; the [RCI tutorial](/tutorials/rci-device-name-widget) warns before writes.

## Reload behavior

Compatible frontend edits rebuild and remount the plugin. A malformed manifest, topology change, or
failed remount keeps the previous instance live or reports that a restart is needed. For exec
backends, the watcher follows the declared command file; edits to sourced helper files do not
trigger a rebuild unless that command file also changes. After a successful backend rebuild, the
host reloads. A failed rebuild is logged and does not replace the last working backend.

When something fails, check the terminal running `mndw dev` for local daemon/backend errors, then
the browser console for module, rendering, or frontend request errors. Common symptoms:

- `EADDRINUSE`: another process owns the selected local port; stop it or choose another `--port`.
- RCI/auth requests fail only in device-backed mode: check device URL, reachability, and login/auth
  state; without `--host-device`, the local stub is expected instead.
- Frontend shows old behavior after an edit: check the dev terminal for a failed rebuild; backend
  helper edits may not be watched unless the declared command changes.
- Backend request reports approval or disabled state: inspect the local plugin state and route
  declaration; development mode does not change the backend's trust boundary.

See the CLI's [live-reload contract](https://github.com/Eralde/mndw/blob/main/docs/ai/cli-workflow.md#live-reload-recipe)
for watcher boundaries and the [Hello widget source](https://github.com/Eralde/mndw/tree/main/plugins/examples/hello-widget)
for a small local target.
