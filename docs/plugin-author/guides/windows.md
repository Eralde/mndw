# Windows

On Windows x64, you can create plugins, validate and package them, and run `mndw dev` for plugins without a backend.
You can also build an upload ZIP for a plugin with a backend:

```sh
npx mndw create hello-widget
npx mndw dev hello-widget
npx mndw validate hello-widget
npx mndw pack hello-widget
npx mndw zip hello-widget
```

`mndw zip` reads backend command paths from the manifest and marks those files `0755` in the ZIP. The archive therefore
keeps backend commands executable when you create it on Windows and upload it to the router.

## Develop a plugin with a backend

On Windows, `mndw dev` stops before starting a plugin backend and prints:

> `mndw dev: plugins with a backend need WSL on Windows. Open a WSL terminal and run mndw dev there.`

Use WSL for backend development:

1. Install WSL and a Linux distribution.
2. Install Node.js and your package manager inside that distribution.
3. Keep the project in the WSL filesystem, such as `~/projects/my-plugins`, not under `/mnt/c/`.
4. Run the same `mndw` commands from the WSL terminal. Use the router's same IP address or URL with `--addr`; it must
   be reachable from WSL.

The published daemon packages support Windows x64. Windows on ARM64 (`win32/arm64`) is not supported.
