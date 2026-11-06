# Build a device-name widget with RCI

Build a Svelte widget that reads `show.version`, edits `system.description`,
and confirms every write with a new device read. You will create the plugin in
a public Node.js project, test it without hardware, optionally try it on a
device, and produce an upload-ready ZIP. Device operations stay in RxJS
observables.

Start with the [project setup guide](/guides/project-setup). This tutorial is
independent of the [Hello tutorial](/tutorials/hello-widget). The tested
[`rci-device-name-widget` reference](https://github.com/Eralde/mndw/tree/master/plugins/examples/rci-device-name-widget)
is optional further reading.

## 1. Prepare and scaffold

Keep this project outside the mndw repository. From its directory, create a
widget with the CLI:

```sh
npx mndw create rci-device-name-widget --type widget --framework svelte
```

The scaffold includes `@mndw/sdk`, RxJS, Vitest, and the Svelte tooling in its
`devDependencies`. It also provides starter component tests; remove
`src/l10n.test.ts` and `src/table.test.ts` when section 5 replaces the starter
component.

<!-- docs-check: scaffold rci-device-name-widget --type widget --framework svelte -->
```text
rci-device-name-widget/
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

Run the starter tests from the project directory:

```sh
npm test
```

## 2. Set the manifest size and messages

Keep the generated plugin name, type, entry, and version in `manifest.json`.
Set its size, keeping the generated English and Russian locale declaration:

```json
"size": {"w": 4, "h": 4, "minW": 3, "minH": 3},
```

The scaffold creates both catalog files.

Replace `i18n/en.json` with this catalog:

<!-- docs-check: file plugins/examples/rci-device-name-widget/i18n/en.json -->
```json
{
  "title": "Device description",
  "field": {
    "label": "Device description",
    "placeholder": "Enter a device description"
  },
  "action": {
    "save": "Save",
    "restore": "Restore original",
    "retry": "Retry"
  },
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

Replace `i18n/ru.json` with the matching Russian catalog:

<!-- docs-check: file plugins/examples/rci-device-name-widget/i18n/ru.json -->
```json
{
  "title": "Описание устройства",
  "field": {
    "label": "Описание устройства",
    "placeholder": "Введите описание устройства"
  },
  "action": {
    "save": "Сохранить",
    "restore": "Восстановить исходное",
    "retry": "Повторить"
  },
  "status": {
    "loading": "Загрузка описания устройства…",
    "saving": "Сохранение описания устройства…",
    "loaded": "Описание устройства загружено.",
    "saved": "Описание подтверждено устройством."
  },
  "validation": {
    "empty": "Введите непустое описание устройства.",
    "too-long": "Описание должно содержать не более 64 символов."
  },
  "error": {
    "load": "Не удалось загрузить описание устройства.",
    "save": "Не удалось сохранить описание устройства.",
    "restore-empty": "Нет непустого исходного значения для восстановления."
  }
}
```

The generated manifest declares both locales. The host loads both catalogs
through `ctx.i18n`.

## 3. Isolate RCI requests in an adapter

Create `src/device-description.ts`. It exposes observable `read` and `write`
operations and turns device status errors into observable errors.

<!-- docs-check: file plugins/examples/rci-device-name-widget/src/device-description.ts -->
```ts
import type {PluginRciManager} from '@mndw/sdk';
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
  public constructor(message: string) {
    super(message);
    this.name = 'DeviceRciStatusError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function statusMessage(status: Record<string, unknown>): string {
  for (const key of ['message', 'error', 'msg', 'description']) {
    const value = status[key];

    if (typeof value === 'string' && value.trim() !== '') {
      return value;
    }
  }

  return 'Device rejected description.';
}

function throwForStatusError(response: unknown): void {
  if (!isRecord(response) || !Array.isArray(response.status)) {
    return;
  }

  const status = response.status.find((entry: unknown) => isRecord(entry) && entry.status === 'error');

  if (!isRecord(status)) {
    return;
  }

  throw new DeviceRciStatusError(statusMessage(status));
}

function normalizeDescription(response: unknown): string {
  if (typeof response === 'string') {
    return response.trim();
  }

  if (!isRecord(response)) {
    return '';
  }

  const selected = response.data !== null && response.data !== undefined ? response.data : response.description;

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

export function createDeviceDescriptionApi(rci: PluginRciManager): DeviceDescriptionApi {
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

`queue` returns an observable. `map` transforms a successful response;
throwing inside `map` sends an embedded RCI rejection down the observable's
error channel. Transport failures already use that channel. A successful HTTP
exchange alone does not prove the device accepted a write.

The adapter accepts these `show.version` results after the RCI manager has
extracted the query result:

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

A one-off read could use `firstValueFrom(rci.queue({path: 'show.version'}))`.
This tutorial keeps operations as streams because Save and Restore are user
intents that need validation, sequencing, cancellation, and read-back. See the
[RxJS guide](/guides/rxjs) for one-off calls and stream patterns.

## 4. Check the adapter without a device

Create `src/device-description.smoke.test.ts`:

<!-- docs-check: file plugins/examples/rci-device-name-widget/src/device-description.smoke.test.ts -->
```ts
import type {PluginRciManager} from '@mndw/sdk';
import {of} from 'rxjs';
import {expect, it, vi} from 'vitest';
import {createDeviceDescriptionApi} from './device-description.js';

it('reads the description and sends a write query', () => {
  const queue = vi.fn()
    .mockReturnValueOnce(of({description: ' Router '}))
    .mockReturnValueOnce(of({status: [{status: 'ok'}]}));
  const api = createDeviceDescriptionApi({queue} as unknown as PluginRciManager);
  const values: Array<string | void> = [];

  api.read().subscribe((value) => {
    values.push(value);
  });
  api.write('New').subscribe((value) => {
    values.push(value);
  });

  expect(queue.mock.calls).toEqual([
    [{path: 'show.version'}],
    [{path: 'system.description', data: 'New'}],
  ]);
  expect(values).toEqual(['Router', undefined]);
});
```

Run the package tests from the project directory:

```sh
npm test
```

**Checkpoint:** the test passes without a device. `of` emits mock responses
synchronously; the assertions check request shapes and emitted values. The
[reference adapter tests](https://github.com/Eralde/mndw/blob/master/plugins/examples/rci-device-name-widget/src/device-description.test.ts)
cover other response forms, status and transport errors, and validation
boundaries.

## 5. Build the component's read and write streams

Replace `src/App.svelte` with the following parts in order. The first three
form one `<script>` block; append the controls and styles afterwards. The full
file appears at the end of this section for reference.

Start with imports, state, and control handlers:

```svelte
<script lang="ts">
import {onDestroy, onMount} from 'svelte';
import {
  EMPTY,
  Subject,
  Subscription,
  catchError,
  defer,
  exhaustMap,
  filter,
  finalize,
  map,
  switchMap,
  tap,
} from 'rxjs';
import type {PluginI18n, PluginRciManager} from '@mndw/sdk';
import {createTranslator} from '@mndw/sdk/svelte';
import {
  type DescriptionValidation,
  DeviceRciStatusError,
  createDeviceDescriptionApi,
  validateDescription,
} from './device-description.js';

interface Props {
  rci: PluginRciManager;
  i18n: PluginI18n;
}

let {rci, i18n}: Props = $props();
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

let canSave = $derived.by(() => {
  const validation = validateDescription(description);

  return hasLoaded && !isLoading && !isSaving && validation.kind === 'valid'
    && validation.value !== confirmedDescription;
});

let canRestore = $derived.by(() => {
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

function getSaveError(error: unknown): string {
  return error instanceof DeviceRciStatusError
    ? error.message
    : translate('error.save');
}

function submitSave(): void {
  saveIntents.next(description);
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

Append the initial-read and Retry stream inside the same script:

<!-- docs-check: skip -->
```ts
subscriptions.add(
  loadIntents.pipe(
    exhaustMap(() =>
      defer(() => {
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
            saveSucceeded = false;
            validationMessage = '';
          }),
          catchError(() => {
            loadError = translate('error.load');

            return EMPTY;
          }),
          finalize(() => {
            isLoading = false;
          }),
        );
      })
    ),
  ).subscribe(),
);
```

`Subject.next()` expresses an intent. `exhaustMap` ignores extra intents while
the accepted read is pending. `defer` starts loading only when subscribed. The
inner `catchError` returns `EMPTY`, ending the failed attempt while keeping the
outer stream alive for Retry. `finalize` clears loading on completion, error,
or unsubscribe.

Append the Save/Restore stream and lifecycle hooks, then close the script:

```svelte
subscriptions.add(
  saveIntents.pipe(
    map((value) => validateDescription(value)),
    tap((validation) => {
      validationMessage = validation.kind === 'invalid'
        ? translate(validation.message)
        : '';
    }),
    filter((
      validation,
    ): validation is Extract<DescriptionValidation, {kind: 'valid'}> =>
      validation.kind === 'valid'
    ),
    exhaustMap(({value}) =>
      defer(() => {
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
            saveError = getSaveError(error);

            return EMPTY;
          }),
          finalize(() => {
            isSaving = false;
          }),
        );
      })
    ),
  ).subscribe(),
);

onMount(() => {
  loadIntents.next();
});

onDestroy(() => {
  loadIntents.complete();
  saveIntents.complete();
  subscriptions.unsubscribe();
});
</script>
```

The transaction is **validate → write → read back → display device value**.
`filter` blocks invalid input. `exhaustMap` prevents overlapping writes;
`switchMap` subscribes to the confirmation read after the write succeeds. Only
that read sets `saveSucceeded`. The returned device value is authoritative;
the widget displays it even if it differs from the submitted text.

Keeping `catchError` inside the transaction lets a later Save succeed after a
failure. If the write succeeds but read-back fails, the device may already
have changed; the UI reports an error and cannot claim a confirmed result.
Unsubscribing the aggregate cancels active observable subscriptions on
unmount. Completing a subject alone would not unsubscribe an active inner
request.

Append the controls and feedback:

```svelte
<section
  class="device-description"
  aria-labelledby="device-description-title"
>
  <h2 id="device-description-title">{$translator.t('title')}</h2>

  <label for="device-description-input">{$translator.t('field.label')}</label>
  <input
    id="device-description-input"
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
      onclick={submitSave}
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
    <p
      class="hint"
      data-testid="restore-empty"
    >
      {$translator.t('error.restore-empty')}
    </p>
  {/if}

  {#if isLoading}
    <p
      role="status"
      aria-live="polite"
    >
      {$translator.t('status.loading')}
    </p>
  {:else if loadError}
    <p
      class="error"
      role="alert"
      aria-live="polite"
    >
      {loadError}
    </p>
  {:else if isSaving}
    <p
      role="status"
      aria-live="polite"
    >
      {$translator.t('status.saving')}
    </p>
  {:else if saveError}
    <p
      class="error"
      role="alert"
      aria-live="polite"
    >
      {saveError}
    </p>
  {:else if validationMessage}
    <p
      class="error"
      role="alert"
      aria-live="polite"
    >
      {validationMessage}
    </p>
  {:else if saveSucceeded}
    <p
      role="status"
      aria-live="polite"
    >
      {$translator.t('status.saved')}
    </p>
  {:else if hasLoaded}
    <p
      role="status"
      aria-live="polite"
    >
      {$translator.t('status.loaded')}
    </p>
  {/if}
</section>
```

An empty original displays an explanation and disables Restore, but a new
valid value can still be saved. Restore uses the same validation, write, and
read-back pipeline as Save. This example uses native controls to keep attention
on RxJS; the [UI guide](/guides/ui-components) covers shared controls.

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

h2,
p {
  margin: 0;
}

h2 {
  font-size: var(--mndw-text-lg);
  font-weight: var(--mndw-weight-semibold);
}

label {
  font-size: var(--mndw-text-sm);
  font-weight: var(--mndw-weight-medium);
}

input {
  min-width: 0;
  padding: var(--mndw-space-2) var(--mndw-space-3);
  color: var(--mndw-text);
  background: var(--mndw-surface-raised);
  border: 1px solid var(--mndw-border);
  border-radius: var(--mndw-radius-md);
  font: inherit;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--mndw-space-2);
}

button {
  padding: var(--mndw-space-2) var(--mndw-space-3);
  color: var(--mndw-accent-contrast);
  background: var(--mndw-accent);
  border: 0;
  border-radius: var(--mndw-radius-md);
  cursor: pointer;
  font: inherit;
}

button:disabled,
input:disabled {
  cursor: not-allowed;
  opacity: 0.7;
}

.hint {
  color: var(--mndw-text-muted);
  font-size: var(--mndw-text-sm);
}

.error {
  color: var(--mndw-danger);
}
</style>
```

::: details Complete src/App.svelte
<!-- docs-check: file plugins/examples/rci-device-name-widget/src/App.svelte -->
```svelte
<script lang="ts">
import {onDestroy, onMount} from 'svelte';
import {
  EMPTY,
  Subject,
  Subscription,
  catchError,
  defer,
  exhaustMap,
  filter,
  finalize,
  map,
  switchMap,
  tap,
} from 'rxjs';
import type {PluginI18n, PluginRciManager} from '@mndw/sdk';
import {createTranslator} from '@mndw/sdk/svelte';
import {
  type DescriptionValidation,
  DeviceRciStatusError,
  createDeviceDescriptionApi,
  validateDescription,
} from './device-description.js';

interface Props {
  rci: PluginRciManager;
  i18n: PluginI18n;
}

let {rci, i18n}: Props = $props();
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

let canSave = $derived.by(() => {
  const validation = validateDescription(description);

  return hasLoaded && !isLoading && !isSaving && validation.kind === 'valid'
    && validation.value !== confirmedDescription;
});

let canRestore = $derived.by(() => {
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

function getSaveError(error: unknown): string {
  return error instanceof DeviceRciStatusError
    ? error.message
    : translate('error.save');
}

function submitSave(): void {
  saveIntents.next(description);
}

function restoreOriginal(): void {
  if (originalDescription !== undefined) {
    saveIntents.next(originalDescription);
  }
}

subscriptions.add(
  loadIntents.pipe(
    exhaustMap(() =>
      defer(() => {
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
            saveSucceeded = false;
            validationMessage = '';
          }),
          catchError(() => {
            loadError = translate('error.load');

            return EMPTY;
          }),
          finalize(() => {
            isLoading = false;
          }),
        );
      })
    ),
  ).subscribe(),
);

subscriptions.add(
  saveIntents.pipe(
    map((value) => validateDescription(value)),
    tap((validation) => {
      validationMessage = validation.kind === 'invalid'
        ? translate(validation.message)
        : '';
    }),
    filter((
      validation,
    ): validation is Extract<DescriptionValidation, {kind: 'valid'}> =>
      validation.kind === 'valid'
    ),
    exhaustMap(({value}) =>
      defer(() => {
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
            saveError = getSaveError(error);

            return EMPTY;
          }),
          finalize(() => {
            isSaving = false;
          }),
        );
      })
    ),
  ).subscribe(),
);

onMount(() => {
  loadIntents.next();
});

onDestroy(() => {
  loadIntents.complete();
  saveIntents.complete();
  subscriptions.unsubscribe();
});
</script>

<section
  class="device-description"
  aria-labelledby="device-description-title"
>
  <h2 id="device-description-title">{$translator.t('title')}</h2>

  <label for="device-description-input">{$translator.t('field.label')}</label>
  <input
    id="device-description-input"
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
      onclick={submitSave}
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
    <p
      class="hint"
      data-testid="restore-empty"
    >
      {$translator.t('error.restore-empty')}
    </p>
  {/if}

  {#if isLoading}
    <p
      role="status"
      aria-live="polite"
    >
      {$translator.t('status.loading')}
    </p>
  {:else if loadError}
    <p
      class="error"
      role="alert"
      aria-live="polite"
    >
      {loadError}
    </p>
  {:else if isSaving}
    <p
      role="status"
      aria-live="polite"
    >
      {$translator.t('status.saving')}
    </p>
  {:else if saveError}
    <p
      class="error"
      role="alert"
      aria-live="polite"
    >
      {saveError}
    </p>
  {:else if validationMessage}
    <p
      class="error"
      role="alert"
      aria-live="polite"
    >
      {validationMessage}
    </p>
  {:else if saveSucceeded}
    <p
      role="status"
      aria-live="polite"
    >
      {$translator.t('status.saved')}
    </p>
  {:else if hasLoaded}
    <p
      role="status"
      aria-live="polite"
    >
      {$translator.t('status.loaded')}
    </p>
  {/if}
</section>

<style>
.device-description {
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

label {
  font-size: var(--mndw-text-sm);
  font-weight: var(--mndw-weight-medium);
}

input {
  min-width: 0;
  padding: var(--mndw-space-2) var(--mndw-space-3);
  color: var(--mndw-text);
  background: var(--mndw-surface-raised);
  border: 1px solid var(--mndw-border);
  border-radius: var(--mndw-radius-md);
  font: inherit;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--mndw-space-2);
}

button {
  padding: var(--mndw-space-2) var(--mndw-space-3);
  color: var(--mndw-accent-contrast);
  background: var(--mndw-accent);
  border: 0;
  border-radius: var(--mndw-radius-md);
  cursor: pointer;
  font: inherit;
}

button:disabled,
input:disabled {
  cursor: not-allowed;
  opacity: 0.7;
}

.hint {
  color: var(--mndw-text-muted);
  font-size: var(--mndw-text-sm);
}

.error {
  color: var(--mndw-danger);
}
</style>
```
:::

## 6. Wire the host entry

Replace all of `src/index.ts`:

<!-- docs-check: file plugins/examples/rci-device-name-widget/src/index.ts -->
```ts
import {mount, unmount} from 'svelte';
import type {PluginContext, PluginInstance} from '@mndw/sdk';
import App from './App.svelte';

export function createInstance(container: HTMLElement, ctx: PluginContext): PluginInstance {
  const app = mount(App, {target: container, props: {rci: ctx.rciManager, i18n: ctx.i18n}});

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

Use this `vitest.config.ts`. It follows the Svelte scaffold and adds the DOM
environment required by the component test:

```ts
import {svelte} from '@sveltejs/vite-plugin-svelte';
import {defineConfig} from 'vitest/config';

export default defineConfig({
  plugins: [svelte({hot: false})],
  resolve: {conditions: ['browser']},
  test: {environment: 'happy-dom'},
});
```

Replace the starter tests `src/l10n.test.ts` and `src/table.test.ts` with this
smoke test at `src/App.smoke.test.ts`:

<!-- docs-check: file plugins/examples/rci-device-name-widget/src/App.smoke.test.ts -->
```ts
import type {PluginRciManager} from '@mndw/sdk';
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
    props: {rci: {queue} as unknown as PluginRciManager, i18n: createTestI18n(en)},
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

Run the package tests from the project directory:

```sh
npm test
```

**Checkpoint:** the adapter and UI smoke tests pass without a device. The UI
test checks initial read → trimmed write → confirmation read, and displays the
returned device value rather than the submitted input. RCI mocks remain
observables; `async` is used only for Svelte's `unmount` cleanup.

For broader coverage, see the optional
[reference component tests](https://github.com/Eralde/mndw/blob/master/plugins/examples/rci-device-name-widget/src/App.test.ts).
They use `Subject` to hold operations pending and check Restore, Retry,
overlapping clicks, failures, and unsubscribe on unmount.

## 8. Try a live device

> Save writes live `system.description`. Restore writes the first value read by
> this mounted widget. Record the current value outside the widget before
> editing, and use a device you are authorized to modify. An empty original
> cannot be restored by this example; use a non-empty starting description
> when testing the complete Save/Restore round trip.

Start development from the project directory with a reachable device URL:

```sh
npx mndw dev rci-device-name-widget --addr http://router.lan
```

Replace `http://router.lan` with your device URL. The explicit `--addr`
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

See the [RCI guide](/guides/rci-api) for request and response details and the
[development guide](/guides/local-development) for proxy and reload behavior.

## 9. Build an upload-ready ZIP

These commands need no device. Run them from the project directory:

```sh
npx mndw validate rci-device-name-widget
npx mndw pack rci-device-name-widget
npx mndw zip rci-device-name-widget
```

`pack` creates `rci-device-name-widget/dist/`. `zip` packs again and writes
`rci-device-name-widget/rci-device-name-widget.zip`. If `unzip` is available,
inspect the archive:

```sh
unzip -l rci-device-name-widget/rci-device-name-widget.zip
```

**Checkpoint:** `manifest.json`, `index.js`, `index.css`, `i18n/en.json`,
`mndw.lock.json`, and `mndw-artifact.json` are at their declared paths, with
`manifest.json` directly at the archive root. This plugin has no backend
executable to include. Upload the ZIP through the device's plugin-management
flow, then check its read-only initial state before Save.

The [packaging guide](/guides/validation-and-packaging) explains the artifact
contract. For further exercises, add another locale or tests for a failed
confirmation read using `throwError`, retaining the same Observable pipeline.
