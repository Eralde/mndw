# Build a device-name widget with direct RCI

Build a Svelte widget that reads `show.version`, edits `system.description`,
and reads back the device's value after every write. You will create the
plugin, test it without hardware, optionally try a device, and produce an
upload-ready ZIP. All device work stays in RxJS observables.

This tutorial can be followed independently of the
[Hello tutorial](/tutorials/hello-widget). Every required file edit is shown;
the tested [`rci-device-name-widget` reference](https://github.com/Eralde/mndw/tree/main/plugins/examples/rci-device-name-widget)
is optional further reading. Your plugin will be named `my-device-name-widget`.

## 1. Prepare and scaffold

Use Node.js 22 and pnpm 10 in a clone of the mndw repository. Run every command
below from the repository root. Go 1.26.1 (pinned by `go.work`) is also needed
for `mndw dev`, which starts the local daemon from source. Automated tests and
packaging do not need a device.

```sh
node --version
pnpm --version
pnpm install
pnpm exec mndw create my-device-name-widget \
  --type widget \
  --framework svelte \
  --out plugins/examples/my-device-name-widget
```

Choose a new output directory. All file paths in edits below are relative to
`plugins/examples/my-device-name-widget/`.

Add these entries to the generated `package.json`'s `devDependencies`, keeping
its other dependencies and `test` script:

```json
"@rci-tools/core": "0.4.3",
"rxjs": "^7.8.0"
```

Then install and check the starter:

```sh
CI=1 pnpm install --no-frozen-lockfile
pnpm --filter @mndw/plugin-my-device-name-widget test
```

**Checkpoint:** the generated locale-reactivity test passes. This scaffold
has no `backend` declaration or shell script: the host supplies
`PluginContext.rciManager` for device requests. The package name used by pnpm
is `@mndw/plugin-my-device-name-widget`; the manifest name is
`my-device-name-widget`.

## 2. Add the manifest and messages

In `manifest.json`, keep the generated identity and entry, change `size`, and
add `i18n` as follows (these are top-level fields, not a whole manifest):

```json
"size": {"w": 4, "h": 4, "minW": 3, "minH": 3},
"i18n": {"defaultLocale": "en", "locales": {"en": "i18n/en.json"}}
```

Create `i18n/en.json`:

```json
{
  "title": "Device description",
  "field": {
    "label": "Device description",
    "placeholder": "Enter a device description"
  },
  "action": {"save": "Save", "restore": "Restore original", "retry": "Retry"},
  "status": {
    "loading": "Loading device description…",
    "saving": "Saving device description…",
    "loaded": "Device description loaded.",
    "saved": "Device description confirmed by device."
  },
  "validation": {
    "empty": "Enter a non-empty device description.",
    "too-long": "Description must be 64 characters or fewer."
  },
  "error": {
    "load": "Could not load the device description.",
    "save": "Could not save the device description.",
    "restore-empty": "No non-empty original value is available to restore."
  }
}
```

One English catalog is sufficient for this tutorial; add further locales to
the manifest when you create their catalogs. Validate before changing the UI:

```sh
pnpm exec mndw validate plugins/examples/my-device-name-widget
```

**Checkpoint:** validation succeeds with no backend routes declared.

## 3. Isolate RCI requests in an adapter

Create `src/device-description.ts` with the complete adapter below. It gives
the UI two operations: `read(): Observable<string>` and
`write(description): Observable<void>`.

```ts
import type {RciManager} from '@rci-tools/core';
import {type Observable, map} from 'rxjs';

export const MAX_DESCRIPTION_LENGTH = 64;
export type DescriptionValidation =
  | {readonly kind: 'valid'; readonly value: string}
  | {readonly kind: 'invalid'; readonly message: string};

export interface DeviceDescriptionApi {
  read(): Observable<string>;
  write(description: string): Observable<void>;
}

export class DeviceRciStatusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceRciStatusError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function throwForStatusError(response: unknown): void {
  if (!isRecord(response) || !Array.isArray(response.status)) {
    return;
  }
  const status: unknown = response.status.find((entry: unknown) => {
    return isRecord(entry) && entry.status === 'error';
  });
  if (!isRecord(status)) {
    return;
  }
  for (const key of ['message', 'error', 'msg', 'description']) {
    const value = status[key];
    if (typeof value === 'string' && value.trim() !== '') {
      throw new DeviceRciStatusError(value);
    }
  }
  throw new DeviceRciStatusError('Device rejected description.');
}

function normalizeDescription(response: unknown): string {
  if (typeof response === 'string') {
    return response.trim();
  }
  if (!isRecord(response)) {
    return '';
  }
  const selected = response.data !== null && response.data !== undefined
    ? response.data
    : response.description;
  return typeof selected === 'string' ? selected.trim() : '';
}

export function validateDescription(value: string): DescriptionValidation {
  const trimmed = value.trim();
  if (trimmed === '') {
    return {kind: 'invalid', message: 'validation.empty'};
  }
  if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
    return {kind: 'invalid', message: 'validation.too-long'};
  }
  return {kind: 'valid', value: trimmed};
}

export function createDeviceDescriptionApi(
  rci: RciManager,
): DeviceDescriptionApi {
  return {
    read() {
      return rci.queue({path: 'show.version'}).pipe(
        map((response: unknown) => {
          throwForStatusError(response);
          return normalizeDescription(response);
        }),
      );
    },
    write(description: string) {
      return rci.queue({path: 'system.description', data: description}).pipe(
        map((response: unknown) => {
          throwForStatusError(response);
          return undefined;
        }),
      );
    },
  };
}
```

`queue` returns an observable. `map` transforms a successful response; throwing
inside `map` sends an embedded RCI rejection down the observable's error
channel. Transport failures already use that channel. A successful HTTP
exchange alone does not prove the device accepted a write.

The adapter accepts these `show.version` result shapes after the RCI manager
has extracted the query result:

| Response | Description |
| --- | --- |
| `"  Router  "` | `"Router"` |
| `{"data":"  Router  "}` | `"Router"` |
| `{"description":"  Router  "}` | `"Router"` |
| `{"data":"A","description":"B"}` | `"A"` |
| `{"data":null,"description":"B"}` | `"B"` |
| `{"data":42,"description":"B"}` | `""` |
| Missing, non-string, or whitespace-only selected value | `""` |

A non-nullish `data` takes precedence even when its type is invalid. An empty
normalized value is a valid read result, but cannot be submitted as a write.
The 64-character limit is this example's input policy, measured with JavaScript
`String.length` after trimming.

## 4. Check the adapter without a device

Create `src/device-description.test.ts`:

```ts
import type {RciManager} from '@rci-tools/core';
import {of} from 'rxjs';
import {expect, it, vi} from 'vitest';
import {createDeviceDescriptionApi} from './device-description.js';

it('reads the description and sends a write query', () => {
  const queue = vi.fn()
    .mockReturnValueOnce(of({description: ' Router '}))
    .mockReturnValueOnce(of({status: [{status: 'ok'}]}));
  const api = createDeviceDescriptionApi({queue} as unknown as RciManager);
  const values: Array<string | void> = [];
  api.read().subscribe((value) => { values.push(value); });
  api.write('New').subscribe((value) => { values.push(value); });
  expect(queue.mock.calls).toEqual([
    [{path: 'show.version'}],
    [{path: 'system.description', data: 'New'}],
  ]);
  expect(values).toEqual(['Router', undefined]);
});
```

Run just this file; the generated starter test can remain until step 7:

```sh
pnpm --filter @mndw/plugin-my-device-name-widget \
  exec vitest run src/device-description.test.ts
```

**Checkpoint:** the test passes without contacting a device. `of` emits mock
responses synchronously; the assertions check request shapes and emitted values.
The optional
[reference adapter tests](https://github.com/Eralde/mndw/blob/main/plugins/examples/rci-device-name-widget/src/device-description.test.ts)
cover other response forms, status/transport errors, and validation boundaries.

## 5. Build the component's read and write streams

Replace `src/App.svelte` with the next five code blocks in order. The first
three form one `<script>` block; append markup and styles afterwards. Finish
all five before running the component.

Start with imports, state, and control handlers:

```svelte
<script lang="ts">
import {onDestroy, onMount} from 'svelte';
import {
  EMPTY, Subject, Subscription, catchError, defer, exhaustMap,
  filter, finalize, map, switchMap, tap,
} from 'rxjs';
import type {RciManager} from '@rci-tools/core';
import type {PluginI18n} from '@mndw/sdk';
import {createTranslator} from '@mndw/sdk/svelte';
import {
  type DescriptionValidation,
  DeviceRciStatusError,
  createDeviceDescriptionApi,
  validateDescription,
} from './device-description.js';

let {rci, i18n}: {rci: RciManager; i18n: PluginI18n} = $props();
const translator = $derived(createTranslator(i18n));
// svelte-ignore state_referenced_locally
const api = createDeviceDescriptionApi(rci);
let description = $state('');
let confirmedDescription = $state('');
let originalDescription = $state<string | undefined>(undefined);
let hasLoaded = $state(false);
let isLoading = $state(true);
let isSaving = $state(false);
let loadError = $state('');
let saveError = $state('');
let validationMessage = $state('');
let saveSucceeded = $state(false);
const loadIntents = new Subject<void>();
const saveIntents = new Subject<string>();
const subscriptions = new Subscription();

const canSave = $derived.by(() => {
  const validation = validateDescription(description);
  return hasLoaded && !isLoading && !isSaving && validation.kind === 'valid'
    && validation.value !== confirmedDescription;
});
const canRestore = $derived.by(() => {
  return hasLoaded && !isLoading && !isSaving
    && originalDescription !== undefined
    && originalDescription !== ''
    && originalDescription !== confirmedDescription;
});

function translate(key: string): string {
  return $translator.t(key);
}

function handleInput(): void {
  const validation = validateDescription(description);
  validationMessage = validation.kind === 'invalid'
    ? translate(validation.message)
    : '';
  saveError = '';
  saveSucceeded = false;
}

function restoreOriginal(): void {
  if (originalDescription !== undefined) {
    saveIntents.next(originalDescription);
  }
}
```

Keep three distinct values: editable `description`, last device-read
`confirmedDescription`, and first successfully read `originalDescription`.
The original belongs to this mounted instance; remounting captures it again.
Save needs a valid change. Restore needs a non-empty original different from
the confirmed value. Both remain disabled before a successful initial read.

Append the initial-read/Retry stream inside the same script:

```ts
subscriptions.add(loadIntents.pipe(
  exhaustMap(() => defer(() => {
    isLoading = true;
    loadError = '';
    return api.read().pipe(
      tap((deviceDescription) => {
        if (!hasLoaded) {
          originalDescription = deviceDescription;
        }
        confirmedDescription = deviceDescription;
        description = deviceDescription;
        hasLoaded = true;
        saveError = '';
        validationMessage = '';
        saveSucceeded = false;
      }),
      catchError(() => {
        loadError = translate('error.load');
        return EMPTY;
      }),
      finalize(() => { isLoading = false; }),
    );
  })),
).subscribe());
```

`Subject.next()` expresses an intent. `exhaustMap` ignores extra intents while
the accepted read is pending. `defer` starts loading only when subscribed.
The inner `catchError` returns `EMPTY`, ending the failed attempt while keeping
the outer stream alive for Retry. `finalize` clears loading on completion,
error, or unsubscribe.

Append the Save/Restore stream and lifecycle hooks, closing the script:

```svelte
subscriptions.add(saveIntents.pipe(
  map((value) => validateDescription(value)),
  tap((validation) => {
    validationMessage = validation.kind === 'invalid'
      ? translate(validation.message)
      : '';
  }),
  filter((
    validation,
  ): validation is Extract<DescriptionValidation, {kind: 'valid'}> => {
    return validation.kind === 'valid';
  }),
  exhaustMap(({value}) => defer(() => {
    isSaving = true;
    saveError = '';
    validationMessage = '';
    saveSucceeded = false;
    return api.write(value).pipe(
      switchMap(() => api.read()),
      tap((deviceDescription) => {
        confirmedDescription = deviceDescription;
        description = deviceDescription;
        saveSucceeded = true;
      }),
      catchError((error: unknown) => {
        saveError = error instanceof DeviceRciStatusError
          ? error.message
          : translate('error.save');
        return EMPTY;
      }),
      finalize(() => { isSaving = false; }),
    );
  })),
).subscribe());

onMount(() => { loadIntents.next(); });
onDestroy(() => {
  loadIntents.complete();
  saveIntents.complete();
  subscriptions.unsubscribe();
});
</script>
```

The transaction is **validate → write → read back → display device value**.
`filter` blocks invalid input. `exhaustMap` prevents overlapping writes;
`switchMap` subscribes to the confirmation read after the write emits success.
Only that read sets `saveSucceeded`. The returned device value is authoritative;
the widget displays it even if it differs from the submitted text.

Keeping `catchError` inside the transaction lets a later Save succeed after a
failure. If the write succeeds but read-back fails, the device may already
have changed; the UI reports an error and cannot claim a confirmed result.
Unsubscribing the aggregate cancels active observable subscriptions on unmount.
Completing a subject alone would not unsubscribe an active inner request.

Append the controls and feedback:

```svelte
<section class="device-description" aria-labelledby="description-title">
  <h2 id="description-title">{$translator.t('title')}</h2>
  <label for="description-input">{$translator.t('field.label')}</label>
  <input
    id="description-input"
    data-testid="description"
    type="text"
    placeholder={$translator.t('field.placeholder')}
    disabled={!hasLoaded || isLoading || isSaving}
    bind:value={description}
    oninput={handleInput}
  />
  <div class="actions">
    <button
      type="button"
      data-testid="save"
      disabled={!canSave}
      onclick={() => saveIntents.next(description)}
    >
      {$translator.t('action.save')}
    </button>
    <button
      type="button"
      data-testid="restore"
      disabled={!canRestore}
      onclick={restoreOriginal}
    >
      {$translator.t('action.restore')}
    </button>
    {#if loadError}
      <button
        type="button"
        data-testid="retry"
        disabled={isLoading}
        onclick={() => loadIntents.next()}
      >
        {$translator.t('action.retry')}
      </button>
    {/if}
  </div>
  {#if hasLoaded && originalDescription === ''}
    <p class="hint">{$translator.t('error.restore-empty')}</p>
  {/if}
  {#if isLoading}
    <p role="status" aria-live="polite">{$translator.t('status.loading')}</p>
  {:else if loadError || saveError || validationMessage}
    <p class="error" role="alert">
      {loadError || saveError || validationMessage}
    </p>
  {:else if isSaving}
    <p role="status" aria-live="polite">{$translator.t('status.saving')}</p>
  {:else if saveSucceeded}
    <p role="status" aria-live="polite">{$translator.t('status.saved')}</p>
  {:else if hasLoaded}
    <p role="status" aria-live="polite">{$translator.t('status.loaded')}</p>
  {/if}
</section>
```

An empty original displays an explanation and disables Restore, but a new valid
value can still be saved. Restore uses the same validation/write/read-back
pipeline as Save. This example uses native controls to keep attention on RxJS;
the [UI guide](/guides/ui-components) covers shared controls for further work.

Finish the component with token-based styles:

```svelte
<style>
.device-description {
  display: grid;
  gap: var(--mndw-space-3);
  padding: var(--mndw-space-4);
  color: var(--mndw-text);
  background: var(--mndw-surface);
  font-family: var(--mndw-font-sans);
}
h2, p { margin: 0; }
h2 { font-size: var(--mndw-text-lg); }
input {
  min-width: 0;
  padding: var(--mndw-space-2);
  color: var(--mndw-text);
  background: var(--mndw-surface-raised);
  border: 1px solid var(--mndw-border);
  border-radius: var(--mndw-radius-md);
  font: inherit;
}
.actions { display: flex; flex-wrap: wrap; gap: var(--mndw-space-2); }
button {
  padding: var(--mndw-space-2) var(--mndw-space-3);
  color: var(--mndw-accent-contrast);
  background: var(--mndw-accent);
  border: 0;
  border-radius: var(--mndw-radius-md);
  cursor: pointer;
  font: inherit;
}
button:disabled, input:disabled { cursor: not-allowed; opacity: 0.7; }
.hint { color: var(--mndw-text-muted); }
.error { color: var(--mndw-danger); }
</style>
```

## 6. Wire the host entry

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
    props: {rci: ctx.rciManager, i18n: ctx.i18n},
  });
  return {
    unmount(): void {
      void unmount(app);
    },
  };
}
```

The host owns authentication and transport. The plugin receives its RCI
manager rather than constructing device URLs or storing credentials.

## 7. Check the Save flow

Replace all of `vitest.config.ts`:

```ts
import {svelte} from '@sveltejs/vite-plugin-svelte';
import {defineConfig} from 'vitest/config';

export default defineConfig({
  plugins: [svelte({hot: false})],
  resolve: {conditions: ['browser']},
  test: {environment: 'happy-dom'},
});
```

Replace all of the generated `src/l10n.test.ts` with one smoke test.
This replaces the starter's obsolete `{ctx}` prop and counter assertions.

```ts
import type {RciManager} from '@rci-tools/core';
import {of} from 'rxjs';
import {flushSync, mount, unmount} from 'svelte';
import {expect, it, vi} from 'vitest';
import {createTestI18n} from '@mndw/sdk/testing';
import App from './App.svelte';
import en from '../i18n/en.json';

it('saves a new description and displays the read-back value', async () => {
  const queue = vi.fn()
    .mockReturnValueOnce(of({description: 'Original'}))
    .mockReturnValueOnce(of({status: [{status: 'ok'}]}))
    .mockReturnValueOnce(of({description: 'Confirmed by device'}));
  const root = document.createElement('div');
  document.body.append(root);
  const app = mount(App, {
    target: root,
    props: {rci: {queue} as unknown as RciManager, i18n: createTestI18n(en)},
  });
  try {
    flushSync();
    const input = root.querySelector<HTMLInputElement>('input');
    if (!input) {
      throw new Error('Missing input');
    }
    expect(input.value).toBe('Original');
    input.value = ' New ';
    input.dispatchEvent(new Event('input', {bubbles: true}));
    flushSync();
    root.querySelector<HTMLButtonElement>('[data-testid="save"]')?.click();
    flushSync();
    expect(queue.mock.calls).toEqual([
      [{path: 'show.version'}],
      [{path: 'system.description', data: 'New'}],
      [{path: 'show.version'}],
    ]);
    expect(input.value).toBe('Confirmed by device');
    expect(root.textContent).toContain(en.status.saved);
  } finally {
    await unmount(app);
    root.remove();
  }
});
```

```sh
pnpm --filter @mndw/plugin-my-device-name-widget test
```

**Checkpoint:** both test files pass without a device. The UI test checks
initial read → trimmed write → confirmation read, and displays the returned
device value rather than the submitted input. RCI mocks remain observables;
`async` is used only for Svelte's `unmount` cleanup.

For broader coverage, see the optional
[reference component tests](https://github.com/Eralde/mndw/blob/main/plugins/examples/rci-device-name-widget/src/App.test.ts).
They use `Subject` to hold operations pending and check Restore, Retry,
overlapping clicks, failures, and unsubscribe on unmount.

## 8. Try a live device

> Save writes live `system.description`. Restore writes the first value read
> by this mounted widget. Record the current value outside the widget before
> editing, and use a device you are authorized to modify. An empty original
> cannot be restored by this example; use a non-empty starting description
> when testing the complete Save/Restore round trip.

Start development with a reachable device base URL:

```sh
pnpm exec mndw dev plugins/examples/my-device-name-widget \
  --host-device http://router.lan
```

Replace `http://router.lan` with your device's URL. The explicit `--host-device`
overrides `MNDW_HOST_DEVICE`; without either, development uses a stub device.
Open the printed local URL and complete the host's normal device login flow.

1. Wait for “Device description loaded.” Record the displayed value.
2. Enter a temporary description, for example `Tutorial test`, and select Save.
3. Wait for “Device description confirmed by device.” The input now contains
   the value returned by the subsequent `show.version` read.
4. Select Restore original and wait for the same confirmation. Check that the
   input contains the value recorded in step 1.
5. Stop with Ctrl-C. A reload/remount captures a new original, so finish the
   round trip before editing frontend code or reloading the page.

| Symptom | Check next |
| --- | --- |
| Initial load fails, Retry appears | Check device URL, reachability, login, and dev terminal; then Retry. Save/Restore stay disabled. |
| Unexpected empty description | Check the adapter's accepted response forms and whether `data` shadows `description`. |
| Save disabled | Wait for loading/saving to finish; enter a trimmed non-empty value of at most 64 characters different from the confirmed value. |
| Restore disabled | Original is empty, unchanged, or loading/saving is active. |
| Device rejection text | Inspect the RCI `status` error; the adapter surfaces the device's message. |
| Generic Save error | Inspect transport and confirmation read. A write may have succeeded even if its follow-up read failed. |
| Retry/Save works once, then stops after an error | Keep `catchError` inside `exhaustMap`, so an error does not terminate the outer intent stream. |

See the [RCI guide](/guides/rci-api) for request/response details and the
[development guide](/guides/local-development) for proxy and reload behavior.

## 9. Build an upload-ready ZIP

These commands need no device:

```sh
pnpm --filter @mndw/plugin-my-device-name-widget test
pnpm exec mndw validate plugins/examples/my-device-name-widget
pnpm exec mndw pack plugins/examples/my-device-name-widget
pnpm exec mndw zip plugins/examples/my-device-name-widget
```

`pack` creates `plugins/examples/my-device-name-widget/dist/`. `zip` packs
again and writes `plugins/examples/my-device-name-widget/my-device-name-widget.zip`.
If `unzip` is available, inspect the archive:

```sh
unzip -l plugins/examples/my-device-name-widget/my-device-name-widget.zip
```

**Checkpoint:** `manifest.json`, `index.js`, `index.css`, `i18n/en.json`,
`mndw.lock.json`, and `mndw-artifact.json` are at their declared paths, with
`manifest.json` directly at the archive root. This plugin has no backend
executable to include. Upload `my-device-name-widget.zip` through the device's
plugin-management flow, then check its read-only initial state before Save.

The [packaging guide](/guides/validation-and-packaging) explains the artifact
contract. For further exercises, add another locale or tests for a failed
confirmation read using `throwError`, retaining the same Observable pipeline.
