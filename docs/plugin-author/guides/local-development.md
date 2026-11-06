# Local development

Run a plugin from source with the public CLI. Start in the plugins project that contains the plugin folder.

```sh
npx mndw dev hello-widget
```

The CLI starts a local `mndwd` daemon, the packaged host UI, and Vite serving your plugin source. Vite provides HMR
(hot module replacement) while you edit the frontend. A plugin remount resets its in-memory state.

Without a device address, the host uses a stub device. To use a router, pass its IP address, `host[:port]`, or HTTP(S)
URL with `--addr <device>`. The address overrides `MNDW_HOST_DEVICE` from your environment.

```sh
npx mndw dev hello-widget --addr 192.168.1.1
```

The local daemon listens on port `9090` by default. Vite serves the local UI on port `5173`. Set `--port` or
`--ui-port` if either port is already in use. The local host proxies device RCI and authentication requests through
the daemon, so use an address reachable from your computer.

## Reload behavior

Vite watches plugin frontend files and refreshes the running page as you edit. The plugin may remount, so its
in-memory state resets. The CLI also watches declared backend command files. It rebuilds Go backends when needed,
restarts a service after a successful build, then reloads the host. A failed build does not trigger a reload; fix the
error and save again.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| RCI requests use a stub response | Pass the router address with `--addr`, or set `MNDW_HOST_DEVICE`. Check that the address is reachable from your computer. |
| The local page does not load | Check the CLI output and try another `--ui-port` if port `5173` is busy. |
| The daemon does not start because its platform package is missing | Reinstall `@mndw/cli` with optional packages enabled. If npm reused a lockfile from another OS, follow the [platform package fix](/guides/project-setup). |
| A backend plugin fails on Windows | Run backend development in WSL. See the [Windows guide](/guides/windows). |
| A Go backend does not rebuild | Check the Go error in the terminal, fix it, and save the source again. |

The daemon port defaults to `9090`; set `--port` if another process is using it.

## Working in a clone of mndw

From the repository root, run `pnpm exec mndw dev plugins/examples/<name>`. Use `--out plugins/examples/<name>` to
scaffold a plugin there. Workspace dependencies use `workspace:*`. Go backend work uses Go, for example
`go run ./cmd/mndwd` from `daemon/mndwd`. See the [repository quick start](https://github.com/Eralde/mndw/blob/master/README.md#quick-start).
