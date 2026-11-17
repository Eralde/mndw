# Build a shell-backed Hello Widget

Build a Svelte widget that calls a shell backend, displays its JSON greeting,
and handles failures. Finish with a ZIP ready for the device's plugin uploader.
No router is needed for this tutorial.

Every required edit is shown below. The tested
[`hello-widget` reference](https://github.com/Eralde/mndw/tree/master/plugins/examples/hello-widget)
is optional reading; you will build `hello-widget` in your own Node.js project.

## 1. Prepare the project

Start with the [project setup guide](/guides/project-setup) to install the CLI
and choose npm, pnpm, or Yarn. Keep the project outside the mndw repository.

On Windows, run shell-backend and `mndw dev` commands in WSL; read the
[Windows guide](/guides/windows) first.

## 2. Create and test the starter

Run the command from your project directory:

```sh
npx mndw create hello-widget --type widget --framework svelte --backend sh
```

Your project now contains:

<!-- docs-check: scaffold hello-widget --type widget --framework svelte --backend sh -->
```text
hello-widget/
  backend/
    main.sh
  i18n/
    en.json
    ru.json
  manifest.json
  package.json
  src/
    App.svelte
    TableNameCell.svelte
    index.ts
    l10n.test.ts
    table.test.ts
  vitest.config.ts
```

The starter tests in `src/l10n.test.ts` and `src/table.test.ts` cover the
scaffold component. You will remove them when replacing that component in
section 6.

Run the starter test from `hello-widget/`:

```sh
npm test
```

## 3. Understand the shell route

The generated `manifest.json` declares this route:

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

`kind: "exec"` runs a fresh command for each request. The `command` path is
relative to the plugin root; `path` declares the HTTP endpoint. Frontend code
calls `backend.call('hello', {as: 'json'})` with the route **id**. The client resolves the URL and applies the host's
backend authorization rules.

Replace `backend/main.sh` with this response, keeping its executable bit:

<!-- docs-check: file plugins/examples/hello-widget/backend/main.sh -->
```sh
#!/bin/sh
# GET /hello exec endpoint for the hello-widget example.
printf 'Content-Type: application/json\r\n\r\n'
printf '{"message":"hello from hello-widget"}\n'
```

Run from `hello-widget/`:

```sh
sh backend/main.sh
```

**Checkpoint:** output contains a `Content-Type: application/json` header,
a blank line, then `{"message":"hello from hello-widget"}`. Keep diagnostics
on stderr; stdout becomes the HTTP response.

## 4. Declare UI translations

The scaffold already declares English and Russian locales in `manifest.json`
and creates both catalog files. Replace `i18n/en.json` with this catalog:

<!-- docs-check: file plugins/examples/hello-widget/i18n/en.json -->
```json
{
  "title": "Hello Widget",
  "action": {
    "greet": "Get greeting",
    "loading": "Loading greeting…"
  },
  "status": {
    "idle": "Ready to say hello.",
    "loading": "Loading greeting…"
  },
  "error": {
    "backend-missing": "Backend is not available for this plugin.",
    "backend-not-approved": "Approve the backend before running it.",
    "backend-disabled": "Enable the backend before running it.",
    "backend-unavailable": "Backend is temporarily unavailable.",
    "greeting-failed": "Could not load the greeting."
  }
}
```

Replace `i18n/ru.json` with the matching Russian catalog:

<!-- docs-check: file plugins/examples/hello-widget/i18n/ru.json -->
```json
{
  "title": "Виджет приветствия",
  "action": {
    "greet": "Получить приветствие",
    "loading": "Загружаем приветствие…"
  },
  "status": {
    "idle": "Готовы поздороваться.",
    "loading": "Загружаем приветствие…"
  },
  "error": {
    "backend-missing": "Серверная часть плагина недоступна.",
    "backend-not-approved": "Одобрите серверную часть перед запуском.",
    "backend-disabled": "Включите серверную часть перед запуском.",
    "backend-unavailable": "Серверная часть временно недоступна.",
    "greeting-failed": "Не удалось загрузить приветствие."
  }
}
```

The host loads both catalogs and exposes their messages through `ctx.i18n`.

## 5. Pass host services into Svelte

Replace all of `src/index.ts`:

<!-- docs-check: file plugins/examples/hello-widget/src/index.ts -->
```ts
import {mount, unmount} from 'svelte';
import type {PluginContext, PluginInstance} from '@mndw/sdk';
import {bindLocale} from '@mndw/sdk/bind-locale';
import App from './App.svelte';

export function createInstance(container: HTMLElement, ctx: PluginContext): PluginInstance {
  const app = mount(App, {target: container, props: {backend: ctx.backend, i18n: ctx.i18n, signal: ctx.signal}});
  const unsubscribeLocale = bindLocale(ctx.i18n, () => {
    if (ctx.kind === 'widget') {
      ctx.setTileTitle?.(ctx.i18n.t('title'));
    }
  });

  return {
    unmount(): void {
      unsubscribeLocale();
      void unmount(app);
    },
  };
}
```

The host calls `createInstance` with a container and `PluginContext`. Pass only
the services the component needs, including `ctx.signal` for request cancellation. When the host removes the widget,
`setTileTitle` updates the host's widget title on mount and locale changes. `unmount()` removes the locale listener and
delegates to Svelte so component cleanup runs too.

## 6. Build the greeting component

Replace all of `src/App.svelte` with these three parts in order. The script
validates backend responses and ignores completions after the host aborts the context.

<!-- docs-check: file plugins/examples/hello-widget/src/App.svelte -->
```svelte
<script lang="ts">
import {type BackendClient, BackendError, type PluginI18n} from '@mndw/sdk';
import {createTranslator} from '@mndw/sdk/svelte';

interface Props {
  backend: BackendClient | undefined;
  i18n: PluginI18n;
  signal: AbortSignal;
}

type ViewState = 'idle' | 'loading' | 'success' | 'error';

let {backend, i18n, signal}: Props = $props();
const translator = $derived(createTranslator(i18n));
let state = $state<ViewState>('idle');
let message = $state('');

async function loadGreeting(): Promise<void> {
  if (state === 'loading') { return; }
  if (!backend) {
    state = 'error';
    message = $translator.t('error.backend-missing');
    return;
  }
  state = 'loading';
  message = '';
  try {
    const payload = await backend.call<{message?: unknown}>('hello', {
      as: 'json',
      signal,
    });
    if (signal.aborted) { return; }
    const greeting = typeof payload.message === 'string'
      ? payload.message.trim()
      : '';
    if (greeting === '') {
      throw new Error('Hello backend returned an invalid greeting');
    }
    state = 'success';
    message = greeting;
  } catch (error) {
    if (signal.aborted) { return; }
    const code = error instanceof BackendError ? error.code : undefined;
    state = 'error';
    message = code === 'NOT_APPROVED'
      ? $translator.t('error.backend-not-approved')
      : code === 'DISABLED'
      ? $translator.t('error.backend-disabled')
      : code === 'BACKEND_STARTING' || code === 'BACKEND_UNAVAILABLE'
          || code === 'BACKEND_MAINTENANCE'
      ? $translator.t('error.backend-unavailable')
      : $translator.t('error.greeting-failed');
  }
}
</script>
```

`backend.call` decodes JSON and rejects non-OK responses as `BackendError`; keep untrusted response data typed as
`unknown` until validated. Passing `signal` cancels the request when the host disposes the context. The loading guard
prevents concurrent clicks.

The markup uses the shared button and announces loading, results, and failures
through live regions.

<!-- docs-check: file plugins/examples/hello-widget/src/App.svelte -->
```svelte
<section
  class="hello-widget"
>
  <mndw-button
    variant="primary"
    type="button"
    data-testid="greet"
    disabled={state === 'loading'}
    onclick={() => void loadGreeting()}
  >
    {
      state === 'loading'
      ? $translator.t('action.loading')
      : $translator.t('action.greet')
    }
  </mndw-button>
  <p
    class:error={state === 'error'}
    role={state === 'error' ? 'alert' : 'status'}
    aria-live="polite"
  >
    {
      state === 'success' || state === 'error'
      ? message
      : state === 'loading'
      ? $translator.t('status.loading')
      : $translator.t('status.idle')
    }
  </p>
</section>
```

Append the style to use the host's theme tokens:

<!-- docs-check: file plugins/examples/hello-widget/src/App.svelte -->
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

h2,
p {
  margin: 0;
}

h2 {
  font-size: var(--mndw-text-lg);
  font-weight: var(--mndw-weight-semibold);
}

mndw-button {
  justify-self: start;
}

.error {
  color: var(--mndw-danger);
}
</style>
```

The host aborts `ctx.signal` when it disposes the context, and the component checks that signal before updating state.
`createTranslator` returns a Svelte store, so `$translator.t(...)` follows locale changes.

Remove `src/l10n.test.ts` and `src/table.test.ts`; both mount the starter
component, which this tutorial replaced. Restart the development host from the
project directory:

```sh
npx mndw dev hello-widget
```

**Checkpoint:** the widget starts with “Ready to say hello.” Select **Get
greeting**; it should show `hello from hello-widget`. No device is needed for
this local flow. Stop the host with Ctrl-C.

## 7. Test your component without a daemon

Create `vitest.setup.ts` to register shared custom elements in the test DOM:

<!-- docs-check: file plugins/examples/hello-widget/vitest.setup.ts -->
```ts
import '@mndw/ui/testing/setup';
```

Replace all of `vitest.config.ts` with the scaffold configuration plus the DOM
setup:

```ts
import {svelte} from '@sveltejs/vite-plugin-svelte';
import {defineConfig} from 'vitest/config';

export default defineConfig({
  plugins: [svelte({hot: false})],
  resolve: {
    conditions: ['browser'],
  },
  test: {environment: 'happy-dom', setupFiles: ['./vitest.setup.ts']},
});
```

Svelte may print accessibility warnings about `<mndw-button>` click handlers;
they are harmless because the element delegates clicks to a native button.

Create `src/App.smoke.test.ts`:

<!-- docs-check: file plugins/examples/hello-widget/src/App.smoke.test.ts -->
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

Run the package tests from `hello-widget/`:

```sh
npm test
```

**Checkpoint:** the smoke test passes without a router or daemon. It mounts
the component, clicks the button, and checks the backend route id and greeting.

For broader coverage, see the optional
[reference component tests](https://github.com/Eralde/mndw/blob/master/plugins/examples/hello-widget/src/App.test.ts):
backend availability errors, malformed responses, duplicate clicks, and
cleanup while a request is pending.

## 8. Diagnose failures

| Visible symptom | Check next |
| --- | --- |
| `Backend is not available for this plugin.` | Confirm `src/index.ts` passes `ctx.backend` and the manifest declares `backend`. |
| `Approve the backend before running it.` | Approve this plugin's backend through plugin management. |
| `Enable the backend before running it.` | Enable the approved backend through plugin management. |
| `Backend is temporarily unavailable.` | Inspect the dev terminal or device backend state; retry when available. |
| `Could not load the greeting.` | Check HTTP status, shell output, JSON validity, and non-empty `message`. |
| Button does not work in tests | Check `vitest.setup.ts` and `setupFiles`; shared elements need registration in isolated tests. |
| Tests still mention `ctx` or `l10n-probe` | Remove both generated starter tests after replacing the component. |
| Dev server reports `EADDRINUSE` | Choose another daemon port, for example `npx mndw dev hello-widget --port 9091`. |

The browser console helps diagnose frontend rendering and module errors. The
terminal running `mndw dev` contains daemon/backend failures. The
[shell backend guide](/guides/shell-backend) explains the CGI contract further.

## 9. Produce the upload ZIP

Run from the project directory:

```sh
npx mndw zip hello-widget
```

`zip` builds the plugin and creates an uploadable archive. The archive includes
the manifest, frontend bundle, locale catalog, backend command, and lock
metadata. The [packaging guide](/guides/validation-and-packaging) explains the
artifact contract and version compatibility.

Upload `hello-widget.zip` through the device's plugin-management flow, then
review and approve/enable its shell backend before requesting a greeting.
Rebuild the ZIP after source edits; do not edit `dist/` by hand.

Continue with the [RCI tutorial](/tutorials/rci-device-name-widget) to
read and update a device setting. The [UI guide](/guides/ui-components) covers
shared controls.
