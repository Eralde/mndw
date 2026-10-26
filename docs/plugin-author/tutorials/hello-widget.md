# Build a shell-backed Hello Widget

Build a Svelte widget that runs a shell command through mndw's backend client,
displays its JSON greeting, and handles failures. Finish with a ZIP ready for
the device's plugin uploader. No router is needed for this tutorial.

Every required edit is shown below. The tested
[`hello-widget` reference](https://github.com/Eralde/mndw/tree/main/plugins/examples/hello-widget)
is optional reading; you will build `my-hello-widget` alongside it.

## 1. Prepare the workspace

Use a clone of the mndw repository with Node.js 22 and pnpm 10. Local development
also needs Go 1.26.1, pinned by `go.work`, because the CLI runs the local daemon
from source. The backend needs POSIX `sh`.

Run these commands from the repository root:

```sh
node --version
pnpm --version
go version
pnpm install
```

Check for Node `v22.x`, pnpm `10.x`, and Go `go1.26.1`. Keep every terminal in
the repository root throughout this tutorial. `pnpm exec mndw` uses the
workspace CLI; no global installation is required.

## 2. Create and test the starter

Create a new widget with a shell backend:

```sh
pnpm exec mndw create my-hello-widget \
  --type widget \
  --framework svelte \
  --backend sh \
  --out plugins/examples/my-hello-widget
```

The output directory must not already exist. All file paths mentioned in edits
below are relative to `plugins/examples/my-hello-widget/`.

In its generated `package.json`, add this entry to `devDependencies`, keeping
all existing dependencies and scripts:

```json
"@mndw/ui": "workspace:*"
```

Then install the new workspace package and run its starter test:

```sh
CI=1 pnpm install --no-frozen-lockfile
pnpm --filter @mndw/plugin-my-hello-widget test
```

**Checkpoint:** the generated locale-reactivity test passes. The package name
is `@mndw/plugin-my-hello-widget`, while the manifest's plugin name is
`my-hello-widget`. Filtered test commands use the package name.

Your starting files include:

```text
my-hello-widget/
  backend/main.sh       # command executed for a backend request
  manifest.json         # plugin identity, entry, size, backend route
  package.json          # dependencies and test script
  src/App.svelte        # widget UI
  src/index.ts          # host-to-Svelte entry and teardown
  src/l10n.test.ts       # starter test, replaced later
  vitest.config.ts      # Svelte test compiler configuration
```

Try the starter before changing it:

```sh
pnpm exec mndw dev plugins/examples/my-hello-widget
```

Open the URL printed in the terminal. The generated counter/localization UI
should render. Ctrl-C stops the host and daemon. Stop them before continuing;
we will restart after completing the component.

## 3. Understand the shell route

The scaffold's `manifest.json` already contains:

```json
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
```

`kind: "exec"` means a fresh command runs for each request. `command` names
the file relative to the plugin root; `path` declares the HTTP endpoint.
Frontend code calls `backend.fetch('hello')` using the route **id**. The client
resolves the URL and applies the host's backend authorization rules.

Replace `backend/main.sh` with this minimal response, keeping its executable bit:

```sh
#!/bin/sh
set -eu
printf 'Content-Type: application/json\r\n\r\n'
printf '{"message":"hello from my-hello-widget"}\n'
```

Run it directly to inspect its output:

```sh
sh plugins/examples/my-hello-widget/backend/main.sh
```

**Checkpoint:** output contains a `Content-Type: application/json` header,
a blank line, then `{"message":"hello from my-hello-widget"}`. The blank
line separates headers from body. Keep diagnostics on stderr and preserve the
script's executable bit; stdout becomes the HTTP response. If an editor loses
the executable bit, restore it with:

```sh
chmod +x plugins/examples/my-hello-widget/backend/main.sh
```

## 4. Declare UI translations

Create `i18n/en.json` with this entire catalog:

```json
{
  "title": "Hello Widget",
  "action": {"greet": "Get greeting", "loading": "Loading greeting…"},
  "status": {"idle": "Ready to say hello.", "loading": "Loading greeting…"},
  "error": {
    "backend-missing": "Backend is not available for this plugin.",
    "backend-not-approved": "Approve the backend before running it.",
    "backend-disabled": "Enable the backend before running it.",
    "backend-unavailable": "Backend is temporarily unavailable.",
    "greeting-failed": "Could not load the greeting."
  }
}
```

Add this top-level field to `manifest.json`, preserving every generated field
(including `name`, `entry`, `size`, and `backend`):

```json
"i18n": {"defaultLocale": "en", "locales": {"en": "i18n/en.json"}}
```

Use a comma between adjacent JSON fields. One locale is enough to complete the
tutorial; additional catalogs can be declared under `locales` later. The host
loads these messages and exposes them through `ctx.i18n`.

```sh
pnpm exec mndw validate plugins/examples/my-hello-widget
```

**Checkpoint:** validation succeeds. A catalog error at this point usually
means invalid JSON or a path that does not match the file you created.

## 5. Pass host services into Svelte

Replace all of `src/index.ts`:

```ts
import {mount, unmount} from 'svelte';
import type {PluginContext, PluginInstance} from '@mndw/sdk';
import App from './App.svelte';

export function createInstance(
  container: HTMLElement,
  ctx: PluginContext,
): PluginInstance {
  const app = mount(App, {
    target: container,
    props: {backend: ctx.backend, i18n: ctx.i18n},
  });

  return {
    unmount(): void {
      void unmount(app);
    },
  };
}
```

The host calls `createInstance` with a container and `PluginContext`. Pass only
the services the component needs. When the host removes the widget, its
`unmount()` delegates to Svelte so component cleanup runs too.

## 6. Build the greeting component

Replace all of `src/App.svelte` with the next three blocks in order. Start with
the script, append the markup, then append the style. They form one file.

```svelte
<script lang="ts">
import {onDestroy} from 'svelte';
import {
  type BackendClient, type PluginI18n,
  BackendDisabled, BackendNotApproved, BackendUnavailable,
} from '@mndw/sdk';
import {createTranslator} from '@mndw/sdk/svelte';

let {backend, i18n}: {
  backend: BackendClient | undefined;
  i18n: PluginI18n;
} = $props();
const translator = $derived(createTranslator(i18n));
let state = $state<'idle' | 'loading' | 'success' | 'error'>('idle');
let message = $state('');
let disposed = false;

function errorMessage(error: unknown): string {
  if (error instanceof BackendNotApproved) {
    return $translator.t('error.backend-not-approved');
  }
  if (error instanceof BackendDisabled) {
    return $translator.t('error.backend-disabled');
  }
  if (error instanceof BackendUnavailable) {
    return $translator.t('error.backend-unavailable');
  }
  return $translator.t('error.greeting-failed');
}

function readGreeting(payload: unknown): string | undefined {
  if (
    payload === null || typeof payload !== 'object' || Array.isArray(payload)
  ) {
    return undefined;
  }
  const candidate = (payload as Record<string, unknown>).message;
  return typeof candidate === 'string' && candidate.trim() !== ''
    ? candidate.trim()
    : undefined;
}

async function loadGreeting(): Promise<void> {
  if (state === 'loading') {
    return;
  }
  if (!backend) {
    state = 'error';
    message = $translator.t('error.backend-missing');
    return;
  }
  state = 'loading';
  message = '';
  try {
    const response = await backend.fetch('hello');
    if (!response.ok) {
      throw new Error('Hello backend returned a non-OK response');
    }
    const payload: unknown = await response.json();
    const greeting = readGreeting(payload);
    if (greeting === undefined) {
      throw new Error('Hello backend returned an invalid greeting');
    }
    if (!disposed) {
      state = 'success';
      message = greeting;
    }
  } catch (error) {
    if (!disposed) {
      state = 'error';
      message = errorMessage(error);
    }
  }
}

onDestroy(() => {
  disposed = true;
});
</script>
```

`backend.fetch` returns a standard `Response`. A resolved request can still
have a non-OK HTTP status, and valid JSON can still have the wrong shape, so
check both. Treat untrusted response data as `unknown` until validated.

The loading guard prevents concurrent clicks. `disposed` stops a late response
from updating state after unmount; it does not cancel the underlying request.
`createTranslator` returns a Svelte store; `$translator.t(...)` tracks locale
changes through the SDK bridge.

Append the markup:

```svelte
<section class="hello-widget" aria-labelledby="hello-title">
  <h2 id="hello-title">{$translator.t('title')}</h2>
  <mndw-button
    variant="primary"
    type="button"
    data-testid="greet"
    disabled={state === 'loading'}
    onclick={() => void loadGreeting()}
  >
    {state === 'loading'
      ? $translator.t('action.loading')
      : $translator.t('action.greet')}
  </mndw-button>
  <p
    class:error={state === 'error'}
    role={state === 'error' ? 'alert' : 'status'}
    aria-live="polite"
  >
    {state === 'success' || state === 'error'
      ? message
      : state === 'loading'
        ? $translator.t('status.loading')
        : $translator.t('status.idle')}
  </p>
</section>
```

The host registers `<mndw-button>` from `@mndw/ui`. Use it directly in plugin
code. An alert announces failures, while the status region announces loading
and results. `data-testid` attributes give tests stable selectors.

Append the style, using the host's theme tokens:

```svelte
<style>
.hello-widget {
  display: grid;
  gap: var(--mndw-space-3);
  padding: var(--mndw-space-4);
  color: var(--mndw-text);
  background: var(--mndw-surface);
  font-family: var(--mndw-font-sans);
}
h2, p { margin: 0; }
h2 { font-size: var(--mndw-text-lg); }
mndw-button { justify-self: start; }
.error { color: var(--mndw-danger); }
</style>
```

Restart the development host:

```sh
pnpm exec mndw dev plugins/examples/my-hello-widget
```

**Checkpoint:** the widget starts with “Ready to say hello.” Select **Get
greeting**; it should show `hello from my-hello-widget`. During the request,
the button is disabled. A local response may arrive too quickly to observe
loading. Stop the host with Ctrl-C.

## 7. Test your component without a daemon

DOM tests need their own custom-element registration. Create `vitest.setup.ts`:

```ts
import '@mndw/ui/testing/setup';
```

Replace all of `vitest.config.ts`:

```ts
import {svelte} from '@sveltejs/vite-plugin-svelte';
import {defineConfig} from 'vitest/config';

export default defineConfig({
  plugins: [svelte({hot: false})],
  resolve: {conditions: ['browser']},
  test: {environment: 'happy-dom', setupFiles: ['./vitest.setup.ts']},
});
```

Replace all of the generated `src/l10n.test.ts` with one smoke test. The
starter's `{ctx}` prop and counter selectors no longer match the new component.

```ts
import {flushSync, mount, unmount} from 'svelte';
import {expect, it, vi} from 'vitest';
import type {BackendClient} from '@mndw/sdk';
import {createTestI18n} from '@mndw/sdk/testing';
import App from './App.svelte';
import en from '../i18n/en.json';

it('calls the route id and displays its greeting', async () => {
  const fetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({message: 'Hello test'})),
  );
  const root = document.createElement('div');
  document.body.append(root);
  const app = mount(App, {
    target: root,
    props: {
      backend: {fetch} as unknown as BackendClient,
      i18n: createTestI18n(en),
    },
  });
  try {
    flushSync();
    root.querySelector<HTMLElement>('[data-testid="greet"]')?.click();
    await vi.waitFor(() => expect(root.textContent).toContain('Hello test'));
    expect(fetch).toHaveBeenCalledWith('hello');
  } finally {
    await unmount(app);
    root.remove();
  }
});
```

Run your package's tests:

```sh
pnpm --filter @mndw/plugin-my-hello-widget test
```

**Checkpoint:** the test passes without a router or daemon. `mount` renders the
component, `flushSync` applies Svelte updates, and `vi.waitFor` observes the
asynchronous fetch result. The button is a custom element, so query it as
`HTMLElement`.

For broader coverage, see the optional
[reference component tests](https://github.com/Eralde/mndw/blob/main/plugins/examples/hello-widget/src/App.test.ts):
backend availability errors, malformed responses, duplicate clicks, and cleanup
while a request is pending.

## 8. Diagnose failures

| Visible symptom | Check next |
| --- | --- |
| `Backend is not available for this plugin.` | Confirm `src/index.ts` passes `ctx.backend` and the manifest still declares `backend`. |
| `Approve the backend before running it.` | Approve this plugin's backend through plugin management. |
| `Enable the backend before running it.` | Enable the approved backend through plugin management. |
| `Backend is temporarily unavailable.` | Inspect the dev terminal or device backend state; retry when available. |
| `Could not load the greeting.` | Check HTTP status, shell exit/output, JSON validity, and non-empty `message`. |
| Button does not work in tests | Check `vitest.setup.ts` and `setupFiles`; shared elements need registration in isolated tests. |
| Tests still mention `ctx` or `l10n-probe` | Replace the generated starter test with the new test above. |
| Dev server reports `EADDRINUSE` | Choose another daemon port, for example append `--port 9091` to `mndw dev`. |

The browser console helps diagnose frontend rendering and module errors. The
terminal running `mndw dev` contains daemon/backend failures. The
[shell backend guide](/guides/shell-backend) explains the CGI contract further.

## 9. Produce the upload ZIP

Run from the repository root:

```sh
pnpm --filter @mndw/plugin-my-hello-widget test
pnpm exec mndw validate plugins/examples/my-hello-widget
pnpm exec mndw pack plugins/examples/my-hello-widget
pnpm exec mndw zip plugins/examples/my-hello-widget
```

`validate` checks the source manifest, entry, and catalogs. `pack` creates the
loadable directory `plugins/examples/my-hello-widget/dist/`. `zip` packs again
and creates `plugins/examples/my-hello-widget/my-hello-widget.zip`.

If `unzip` is available, inspect the archive:

```sh
unzip -l plugins/examples/my-hello-widget/my-hello-widget.zip
unzip -Z -v plugins/examples/my-hello-widget/my-hello-widget.zip
```

**Checkpoint:** `manifest.json` is directly at the archive root. Alongside it,
expect `index.js`, `index.css` for this styled component, `i18n/en.json`,
`backend/main.sh`, `mndw.lock.json`, and `mndw-artifact.json`. The verbose
listing should show executable Unix permissions for `backend/main.sh`.

Upload `my-hello-widget.zip` through the device's plugin-management flow, then
review and approve/enable its shell backend before requesting a greeting.
Rebuild the ZIP after source edits; do not edit `dist/` by hand.

Continue with the [direct RCI tutorial](/tutorials/rci-device-name-widget) to
read and update a device setting using RxJS. The
[packaging guide](/guides/validation-and-packaging) explains the artifact
contract, and the [UI guide](/guides/ui-components) covers shared controls.
