# Shell backend

Use an `exec` backend for short, request-scoped work: one declared command handles one HTTP request
and exits. Use a `service` backend for a long-running process, retained in-memory state, or WebSocket
connections; read the [service backend guide](https://github.com/Eralde/mndw/blob/master/docs/service-backend.md)
for that protocol. Backend approval is a trust boundary: approved commands run with daemon/device
privileges. Approve only code you trust.

On Windows, run backend development commands from WSL. See the [Windows setup guide](/guides/windows)
before continuing.

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

That is the actual endpoint in the [Hello widget](https://github.com/Eralde/mndw/blob/master/plugins/examples/hello-widget/backend/main.sh).
Its UI uses the route id with the typed client:

```ts
if (ctx.backend === undefined) {
  throw new Error('This plugin needs its declared backend');
}

const payload = await ctx.backend.call<{message: string}>('hello', {as: 'json', signal: ctx.signal});
console.info(payload.message);
```

`call()` decodes JSON and turns platform errors and non-OK plugin responses into `BackendError`; its
`message`, `code`, `id`, `status`, `retryable`, and `details` fields describe the failure. `fetch()` also
throws `BackendError` for platform errors, but returns the plugin's raw response, including its own
non-OK responses. The daemon marks platform errors with `X-Mndw-Error: 1`; plugin backends may return any
JSON, including an `error.code` object, without being mistaken for a platform error. A declared ID can
still become unavailable after the UI loads. Use `fetch()` when the plugin needs raw headers, exact
status/body handling, or a streaming body; otherwise prefer `call()`. Session access is the default;
public HTTP routes are limited to `GET` and `HEAD`, and public access does not bypass backend approval.
GET and HEAD requests that include a body are rejected with `400 BAD_REQUEST`.

## Troubleshooting

- A route ID error usually means the UI ID and manifest `id` differ; call the ID, not the URL path.
- Approval/disabled errors are daemon state, not malformed JSON. Check plugin approval and whether
  the route is enabled.
- Invalid JSON or a response with headers in its body usually means stdout contains a debug line,
  the CGI header separator is missing, or JSON was assembled without escaping.
- A command that works from an interactive shell may still fail if it is missing from the package,
  has the wrong relative path, or is not executable. Run `npx mndw validate hello-widget` then
  `npx mndw pack hello-widget`.

For a hands-on walkthrough, follow the [Hello widget tutorial](/tutorials/hello-widget). RCI calls
use `ctx.rciManager` and go through the host rather than a plugin backend. See the
[RCI API guide](/guides/rci-api).

From the plugins project, pass the plugin folder to validate and package the backend:

```bash
npx mndw validate hello-widget
npx mndw pack hello-widget
```
