# Shell backend

Use an `exec` backend for short, request-scoped work: one declared command handles one HTTP request
and exits. Use a `service` backend for a long-running process, retained in-memory state, or WebSocket
connections; read the [service backend guide](https://github.com/Eralde/mndw/blob/main/docs/service-backend.md)
for that protocol. Backend approval is a trust boundary: approved commands run with daemon/device
privileges. Approve only code you trust.

## Declare a route

Each exec route maps a unique UI-facing `id` to an HTTP method, a relative route `path`, and a
command file relative to the plugin root:

```json
{
  "backend": {
    "kind": "exec",
    "routes": [
      {
        "id": "hello",
        "transport": "http",
        "method": "GET",
        "path": "hello",
        "command": "backend/main.sh"
      }
    ]
  }
}
```

The daemon invokes the command for each request and expects a CGI-style response on stdout: headers,
a blank line, then the response body. Send JSON with a content type and valid JSON encoding. Prefer a
JSON serializer over string concatenation when values can contain quotes, backslashes, or newlines.
Write diagnostics to stderr, not stdout, and exit non-zero on command failure. Keep the script
executable in the source tree; the packer stages declared commands as executable files.

```sh
#!/bin/sh
printf 'Content-Type: application/json\r\n\r\n'
printf '{"message":"hello from hello-widget"}\n'
```

That is the actual endpoint in the [Hello widget](https://github.com/Eralde/mndw/blob/main/plugins/examples/hello-widget/backend/main.sh).
Its UI uses the route id with the typed client:

```ts
const response = await context.backend?.fetch('hello');
if (response === undefined || !response.ok) {
  throw new Error('Greeting request failed');
}
const payload: unknown = await response.json();
```

Handle `BackendNotApproved`, `BackendDisabled`, and `BackendUnavailable` separately so users can
tell approval, disabled capability, and runtime connectivity apart. A declared ID can still be
unavailable when state changes after the UI loads. Session access is the default; public HTTP routes
are limited to `GET` and `HEAD`, and public access does not bypass backend approval.

## Troubleshooting

- A route ID error usually means the UI ID and manifest `id` differ; call the ID, not the URL path.
- Approval/disabled errors are daemon state, not malformed JSON. Check plugin approval and whether
  the route is enabled.
- Invalid JSON or a response with headers in its body usually means stdout contains a debug line,
  the CGI header separator is missing, or JSON was assembled without escaping.
- A command that works from an interactive shell may still fail if it is missing from the package,
  has the wrong relative path, or is not executable. Run `mndw validate` then `mndw pack`.

For a hands-on walkthrough, follow the [Hello widget tutorial](/tutorials/hello-widget). Direct RCI
calls use `context.rciManager`; they are not declared as shell/service backend routes. See the
[direct RCI guide](/guides/rci-api).
