import {type Locator, type Page, expect, test} from '@playwright/test';

interface HostSemantics {
  role: string | null;
  name: string;
  checked: string | null;
  expanded: string | null;
  disabled: string | null;
}

interface FocusOwnership {
  documentActive: string | null;
  shadowActive: string | null;
}

interface FormAssociatedControlCase {
  name: string;
  selector: string;
  innerSelector?: string;
}

async function hostSemantics(component: Locator): Promise<HostSemantics> {
  return component.evaluate((element) => {
    return {
      role: element.getAttribute('role'),
      name: element.getAttribute('aria-label') ?? '',
      checked: element.getAttribute('aria-checked'),
      expanded: element.getAttribute('aria-expanded'),
      disabled: element.getAttribute('aria-disabled'),
    };
  });
}

async function focusOwnership(component: Locator): Promise<FocusOwnership> {
  return component.evaluate((element) => ({
    documentActive: document.activeElement?.tagName ?? null,
    shadowActive: element.shadowRoot?.activeElement?.tagName ?? null,
  }));
}

async function setHostDisabled(control: Locator, disabled: boolean): Promise<void> {
  await control.evaluate(async (element, nextDisabled) => {
    const host = element as HTMLElement & {disabled: boolean; updateComplete: Promise<unknown>};

    host.disabled = nextDisabled;
    await host.updateComplete;
  }, disabled);
}

async function clickWithMouse(page: Page, target: Locator): Promise<void> {
  const box = await target.boundingBox();

  if (!box) {
    throw new Error(`cannot click target: ${await target.evaluate((element) => element.outerHTML)}`);
  }

  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

const FORM_ASSOCIATED_CONTROLS: readonly FormAssociatedControlCase[] = [
  {name: 'button', selector: '#button', innerSelector: 'button'},
  {name: 'input', selector: '#form-input', innerSelector: 'input'},
  {name: 'textarea', selector: '#form-textarea', innerSelector: 'textarea'},
  {name: 'checkbox', selector: '#checkbox'},
  {name: 'select', selector: '#select'},
  {name: 'switch', selector: '#theme-switch'},
  {name: 'slider', selector: '#volume'},
  {name: 'segmented', selector: '#range'},
] as const;

test.beforeEach(async ({page}) => {
  await page.goto('/e2e/fixtures/components.html');
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
});

test('registers existing components and loads tokens and class styles', async ({page}) => {
  const state = await page.evaluate(() => {
    const card = document.querySelector<HTMLElement>('[data-testid="card"]');

    if (!card) {
      throw new Error('missing class-layer card');
    }

    return {
      registered: [
        'mndw-button',
        'mndw-checkbox',
        'mndw-option',
        'mndw-scroll-area',
        'mndw-select',
      ].every((tag) => customElements.get(tag) !== undefined),
      accent: getComputedStyle(document.documentElement).getPropertyValue('--mndw-accent')
        .trim(),
      classStyles: getComputedStyle(card).borderRadius,
    };
  });

  expect(state.registered).toBe(true);
  expect(state.accent).not.toBe('');
  expect(state.classStyles).not.toBe('');
  await expect(page.locator('#button')).toBeAttached();
  await expect(page.locator('mndw-checkbox').first()).toBeAttached();
  await expect(page.locator('#select')).toBeAttached();
  await expect(page.locator('mndw-option')).toHaveCount(4);
  await expect(page.locator('mndw-scroll-area')).toBeAttached();
});

test('renders reusable charts, accessibility state, and responsive geometry', async ({page}) => {
  const line = page.locator('#line-chart-fixture-element');
  const bar = page.locator('#bar-chart-fixture-element');

  await expect(line).toHaveAttribute('role', 'img');
  await expect(line).toHaveAttribute('aria-label', /Upload: latest/);
  await expect(bar).toHaveAttribute('role', 'img');
  await expect(bar).toHaveAttribute('aria-label', /Throughput: latest/);
  await expect(line.locator('svg')).toBeVisible();
  await expect(bar.locator('svg')).toBeVisible();
  await expect(line.locator('[part="grid"]')).toBeAttached();
  await expect(line.locator('[part="axis"]')).toHaveCount(2);
  await expect(bar.locator('[part="tooltip"]')).toBeAttached();

  await page.locator('#line-chart-fixture').evaluate((element) => {
    element.style.width = '399px';
  });
  await page.locator('#bar-chart-fixture').evaluate((element) => {
    element.style.width = '299px';
  });

  await expect.poll(async () => line.locator('svg').getAttribute('width')).toBe('399');
  await expect.poll(async () => bar.locator('svg').getAttribute('width')).toBe('299');
});

test('queries semantic control state from hosts', async ({page}) => {
  const checkbox = await hostSemantics(page.locator('#checkbox'));
  const select = await hostSemantics(page.locator('#select'));

  expect(checkbox).toMatchObject({role: 'checkbox', checked: 'false', disabled: 'false'});
  expect(select).toMatchObject({role: 'combobox', expanded: 'false', disabled: 'false'});
  await expect(page.getByRole('checkbox', {name: 'Feature'})).toBeVisible();
  await expect(page.getByRole('combobox', {name: 'Interface', exact: true})).toBeVisible();
  await expect(page.getByRole('combobox', {name: 'Field interface', exact: true})).toBeVisible();
});

test('keeps a checkbox host geometrically stable across checked-state changes', async ({page}) => {
  const checkbox = page.locator('#inline-checkbox');

  await expect(checkbox).toBeAttached();

  async function setState(checked: boolean, indeterminate: boolean): Promise<void> {
    await checkbox.evaluate(
      async (element, next) => {
        const host = element as HTMLElement & {
          checked: boolean;
          indeterminate: boolean;
          updateComplete: Promise<unknown>;
        };

        host.checked = next.checked;
        host.indeterminate = next.indeterminate;
        await host.updateComplete;
      },
      {checked, indeterminate},
    );
  }

  async function rect(): Promise<{left: number; top: number; width: number; height: number}> {
    const box = await checkbox.boundingBox();

    if (!box) {
      throw new Error('checkbox has no bounding box');
    }

    return {left: box.x, top: box.y, width: box.width, height: box.height};
  }

  // unchecked -> checked -> indeterminate -> unchecked
  await setState(false, false);

  const baseline = await rect();

  await setState(true, false);
  expect(await rect()).toEqual(baseline);

  await setState(false, true);
  expect(await rect()).toEqual(baseline);

  await setState(false, false);
  expect(await rect()).toEqual(baseline);
});

test('keeps native button focus inside its shadow tree', async ({page}) => {
  const button = page.locator('#button');

  await button.evaluate((element) => {
    const nativeButton = element.shadowRoot?.querySelector<HTMLButtonElement>('button');

    if (!nativeButton) {
      throw new Error('missing native button');
    }

    nativeButton.focus();
  });

  await expect.poll(async () => focusOwnership(button)).toEqual({
    documentActive: 'MNDW-BUTTON',
    shadowActive: 'BUTTON',
  });
});

test('re-enables native button after host disabled property is cleared', async ({page}) => {
  const button = page.locator('#button');

  await button.evaluate(async (element) => {
    const control = element as HTMLElement & {disabled: boolean; updateComplete: Promise<unknown>};

    control.disabled = true;
    await control.updateComplete;
    control.disabled = false;
    await control.updateComplete;
  });

  await expect(button.locator('button')).not.toBeDisabled();
});

test('re-enables every form-associated control after explicit disabled state is cleared', async ({page}) => {
  for (const currentCase of FORM_ASSOCIATED_CONTROLS) {
    const control = page.locator(currentCase.selector);

    await setHostDisabled(control, true);

    if (currentCase.innerSelector) {
      await expect(control.locator(currentCase.innerSelector)).toBeDisabled();
    } else {
      await expect(control, currentCase.name).toHaveAttribute('aria-disabled', 'true');
    }

    await setHostDisabled(control, false);

    if (currentCase.innerSelector) {
      await expect(control.locator(currentCase.innerSelector)).not.toBeDisabled();
    } else {
      await expect(control, currentCase.name).toHaveAttribute('aria-disabled', 'false');
    }
  }

  await expect(page.locator('#range mndw-segment').first()).toHaveAttribute('aria-disabled', 'false');
  await expect(page.locator('#range mndw-segment').first()).toHaveAttribute('tabindex', '0');
});

test('re-enabled custom controls accept real pointer input', async ({page}) => {
  const button = page.locator('#button');

  await setHostDisabled(button, true);
  await setHostDisabled(button, false);
  await button.evaluate((element) => {
    element.addEventListener('click', () => element.setAttribute('data-pointer-activated', 'true'), {once: true});
  });
  await clickWithMouse(page, button);
  await expect(button).toHaveAttribute('data-pointer-activated', 'true');

  const checkbox = page.locator('#checkbox');

  await setHostDisabled(checkbox, true);
  await setHostDisabled(checkbox, false);
  await clickWithMouse(page, checkbox);
  await expect(checkbox).toHaveAttribute('aria-checked', 'true');

  const switchControl = page.locator('#theme-switch');

  await setHostDisabled(switchControl, true);
  await setHostDisabled(switchControl, false);
  await page.locator('#field-switch label').click();
  await expect(switchControl).toHaveAttribute('aria-checked', 'true');

  const segmented = page.locator('#range');

  await setHostDisabled(segmented, true);
  await setHostDisabled(segmented, false);

  const daySegment = page.locator('#range mndw-segment')
    .first()
    .locator('[part="segment"]');

  await clickWithMouse(page, daySegment);
  await expect.poll(async () => segmented.evaluate((element) => (element as HTMLElement & {value: string}).value)).toBe(
    'day',
  );

  const select = page.locator('#select');

  await setHostDisabled(select, true);
  await setHostDisabled(select, false);
  await select.locator('[part="trigger"]').click();
  await expect(select).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(select).toHaveAttribute('aria-expanded', 'false');
});

test('activates checkbox from its external label and focuses the host', async ({page}) => {
  await page.getByText('Enable feature', {exact: true}).click();

  await expect(page.locator('#checkbox')).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => page.evaluate(() => document.activeElement?.id ?? null)).toBe('checkbox');
});

test('submits selected custom-element values and omits empty or unmatched select values', async ({page}) => {
  await page.locator('#checkbox').evaluate((element) => {
    (element as HTMLElement & {checked: boolean}).checked = true;
  });
  await page.locator('#select').evaluate((element) => {
    (element as HTMLElement & {value: string}).value = 'wired';
  });
  await page.locator('#submit-button').click();

  await expect(page.locator('html')).toHaveAttribute('data-submitted', 'true');
  await expect.poll(async () => page.locator('html').getAttribute('data-form-data')).toContain('feature');

  const submitted = JSON.parse((await page.locator('html').getAttribute('data-form-data')) ?? '[]') as string[][];

  expect(submitted).toContainEqual(['feature', 'enabled']);
  expect(submitted).toContainEqual(['interface', 'wired']);

  await page.locator('#checkbox').evaluate((element) => {
    (element as HTMLElement & {checked: boolean}).checked = false;
  });
  await page.locator('#select').evaluate((element) => {
    (element as HTMLElement & {value: string}).value = 'not-an-option';
  });
  await page.locator('#submit-button').click();

  const omitted = JSON.parse((await page.locator('html').getAttribute('data-form-data')) ?? '[]') as string[][];

  expect(omitted).not.toContainEqual(['feature', 'enabled']);
  expect(omitted).not.toContainEqual(['interface', 'not-an-option']);
});

test('resets custom-element state and handles button submit/reset actions', async ({page}) => {
  await page.locator('#checkbox').evaluate((element) => {
    (element as HTMLElement & {checked: boolean}).checked = true;
  });
  await page.locator('#select').evaluate((element) => {
    (element as HTMLElement & {value: string}).value = 'wired';
  });
  await page.locator('#reset-button').click();

  await expect.poll(async () =>
    page.locator('#checkbox').evaluate((element) => (element as HTMLElement & {checked: boolean}).checked)
  ).toBe(false);
  await expect.poll(async () =>
    page.locator('#select').evaluate((element) => (element as HTMLElement & {value: string}).value)
  ).toBe('wired');

  await page.locator('#submit-button').click();
  await expect(page.locator('html')).toHaveAttribute('data-submitted', 'true');
});

test('forwards panel classes from select host to the overlay layer', async ({page}) => {
  await page.locator('#select').evaluate((element) => element.setAttribute('panel-class', 'demo-panel'));
  await page.locator('#select').click();

  await expect(page.locator('.demo-panel')).toBeVisible();
  await page.keyboard.press('Escape');
});

test('updates effective disabled state when fieldset disabled toggles', async ({page}) => {
  await page.locator('#fieldset').evaluate((element) => element.setAttribute('disabled', ''));
  await page.locator('#secondary-fieldset').evaluate((element) => element.setAttribute('disabled', ''));
  await expect(page.locator('#checkbox')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('#select')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('#theme-switch')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('#volume')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('#range')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('#range mndw-segment').first()).toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('#button').locator('button')).toBeDisabled();
  await expect(page.locator('#submit-button').locator('button')).toBeDisabled();
  await expect(page.locator('#reset-button').locator('button')).toBeDisabled();
  await expect(page.locator('#form-input').locator('input')).toBeDisabled();
  await expect(page.locator('#form-textarea').locator('textarea')).toBeDisabled();

  await page.locator('#checkbox').evaluate((element) => {
    (element as HTMLElement & {disabled: boolean}).disabled = true;
  });
  await page.locator('#fieldset').evaluate((element) => element.removeAttribute('disabled'));
  await page.locator('#secondary-fieldset').evaluate((element) => element.removeAttribute('disabled'));
  await expect(page.locator('#checkbox')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('#select')).toHaveAttribute('aria-disabled', 'false');
  await expect(page.locator('#theme-switch')).toHaveAttribute('aria-disabled', 'false');
  await expect(page.locator('#volume')).toHaveAttribute('aria-disabled', 'false');
  await expect(page.locator('#range')).toHaveAttribute('aria-disabled', 'false');
  await expect(page.locator('#button').locator('button')).not.toBeDisabled();
  await expect(page.locator('#submit-button').locator('button')).not.toBeDisabled();
  await expect(page.locator('#reset-button').locator('button')).not.toBeDisabled();
  await expect(page.locator('#form-input').locator('input')).not.toBeDisabled();
  await expect(page.locator('#form-textarea').locator('textarea')).not.toBeDisabled();

  await page.locator('#checkbox').evaluate((element) => {
    (element as HTMLElement & {disabled: boolean}).disabled = false;
  });
  await expect(page.locator('#checkbox')).toHaveAttribute('aria-disabled', 'false');
});

test('names a native control from its field label and activates it on click', async ({page}) => {
  const control = page.locator('#native-input');

  await expect(control).toHaveAccessibleName('Host name');
  await expect(control).toHaveAccessibleDescription('Shown in the device list.');

  await page.locator('#field-native label').click();

  await expect.poll(() => page.evaluate(() => document.activeElement?.id ?? null)).toBe('native-input');
});

test('describes and invalidates the control while a field error is present', async ({page}) => {
  const control = page.locator('#native-input');

  await page.locator('#field-native').evaluate(async (element) => {
    (element as HTMLElement & {error: string}).error = 'Host name is already in use.';
    await (element as HTMLElement & {updateComplete: Promise<unknown>}).updateComplete;
  });

  await expect(control).toHaveAttribute('aria-invalid', 'true');
  await expect(control).toHaveAccessibleDescription('Shown in the device list. Host name is already in use.');
  await expect(page.getByRole('alert')).toHaveText('Host name is already in use.');

  await page.locator('#field-native').evaluate(async (element) => {
    (element as HTMLElement & {error: string}).error = '';
    await (element as HTMLElement & {updateComplete: Promise<unknown>}).updateComplete;
  });

  await expect(control).not.toHaveAttribute('aria-invalid', 'true');
  await expect(control).toHaveAccessibleDescription('Shown in the device list.');
});

test('names a self-labelling checkbox once inside a labelled field', async ({page}) => {
  const checkbox = page.locator('#telemetry-checkbox');

  await expect(page.getByRole('checkbox', {name: 'Enable telemetry', exact: true})).toBeVisible();
  await expect(page.locator('#field-checkbox label')).toBeHidden();

  await checkbox.evaluate(async (element) => {
    (element as HTMLElement & {checked: boolean}).checked = true;
    await (element as HTMLElement & {updateComplete: Promise<unknown>}).updateComplete;
  });

  await expect(page.getByRole('checkbox', {name: 'Enable telemetry', exact: true})).toBeVisible();
  await expect(page.locator('#field-checkbox label')).toBeHidden();
});

test('suppresses and restores field label around a select label source', async ({page}) => {
  const field = page.locator('#field-select-label');
  const select = page.locator('#select-label');

  await expect(select).toHaveAccessibleName('Select label');
  await expect(field.locator('label.mndw-field__label')).toBeHidden();

  await select.evaluate(async (element) => {
    (element as HTMLElement & {label: string}).label = '';
    await (element as HTMLElement & {updateComplete: Promise<unknown>}).updateComplete;
  });

  await expect(select).toHaveAccessibleName('Field select label');
  await expect(field.locator('label.mndw-field__label')).toBeVisible();

  await select.evaluate(async (element) => {
    (element as HTMLElement & {label: string}).label = 'Select label';
    await (element as HTMLElement & {updateComplete: Promise<unknown>}).updateComplete;
  });

  await expect(select).toHaveAccessibleName('Select label');
  await expect(field.locator('label.mndw-field__label')).toBeHidden();
});

test('suppresses its own label when a consumer label already names the control', async ({page}) => {
  await expect(page.locator('#external-input')).toHaveAccessibleName('External name');
  await expect(page.locator('#field-external label.mndw-field__label')).toBeHidden();
});

test('types into the delegated native input and reports value and events on the host', async ({page}) => {
  const control = page.getByRole('textbox', {name: 'Router name'});

  await page.evaluate(() => {
    const host = document.querySelector('#text-input');
    const seen: string[][] = [];

    Object.assign(window, {mndwEvents: seen});
    host?.addEventListener('mndwinput', (event) => {
      seen.push(['input', (event as CustomEvent<{value: string}>).detail.value]);
    });
    host?.addEventListener('mndwchange', (event) => {
      seen.push(['change', (event as CustomEvent<{value: string}>).detail.value]);
    });
  });

  await control.pressSequentially('wan');
  await expect
    .poll(async () =>
      page.locator('#text-input').evaluate((element) => (element as HTMLElement & {value: string}).value)
    )
    .toBe('wan');

  await control.press('Enter');

  const afterEnter = await page.evaluate(() => (window as unknown as {mndwEvents: string[][]}).mndwEvents);

  expect(afterEnter).toEqual([['input', 'w'], ['input', 'wa'], ['input', 'wan'], ['change', 'wan']]);

  await control.blur();

  const afterBlur = await page.evaluate(() => (window as unknown as {mndwEvents: string[][]}).mndwEvents);

  expect(afterBlur).toHaveLength(afterEnter.length);
});

test('keeps caret, selection, and IME composition working in the native input', async ({page}) => {
  const control = page.getByRole('textbox', {name: 'Router name'});

  await control.fill('router');
  await control.evaluate((element) => {
    (element as HTMLInputElement).setSelectionRange(2, 5);
  });

  expect(
    await control.evaluate((element) => {
      const input = element as HTMLInputElement;

      return {start: input.selectionStart, end: input.selectionEnd, selected: input.value.slice(2, 5)};
    }),
  ).toEqual({start: 2, end: 5, selected: 'ute'});

  const composed = await page.locator('#text-input').evaluate(async (host) => {
    const input = host.shadowRoot?.querySelector('input');

    if (!input) {
      throw new Error('missing inner input');
    }

    input.focus();
    input.dispatchEvent(new CompositionEvent('compositionstart', {bubbles: true}));
    input.value = 'ルーター';
    input.dispatchEvent(new Event('input', {bubbles: true, composed: true}));
    input.dispatchEvent(new CompositionEvent('compositionend', {bubbles: true, data: 'ルーター'}));
    await (host as HTMLElement & {updateComplete: Promise<unknown>}).updateComplete;

    return (host as HTMLElement & {value: string}).value;
  });

  expect(composed).toBe('ルーター');
});

test('masks a password type and steps a number type natively', async ({page}) => {
  expect(
    await page.locator('#password-input').evaluate((host) => host.shadowRoot?.querySelector('input')?.type),
  ).toBe('password');

  const port = page.getByRole('spinbutton', {name: 'Listen port', exact: true});

  // The field's required marker is aria-hidden, so it must not reach the forwarded name.
  await expect(port).toHaveAccessibleName('Listen port');
  await expect(page.locator('#field-port label .mndw-field__required')).toBeVisible();

  await port.fill('10');
  await port.press('ArrowUp');

  await expect
    .poll(async () =>
      page.locator('#port-input').evaluate((element) => (element as HTMLElement & {value: string}).value)
    )
    .toBe('11');
});

test('names the input from its field label, follows ARIA precedence, and never forwards an empty name', async ({page}) => {
  const control = page.getByRole('textbox', {name: 'Router name'});

  await expect(control).toHaveAccessibleName('Router name');
  await expect(control).toHaveAccessibleDescription('Shown to other devices.');

  await page.locator('#field-input label').click();
  await expect
    .poll(() => page.locator('#text-input').evaluate((element) => element.shadowRoot?.activeElement?.tagName ?? null))
    .toBe('INPUT');

  await page.locator('#text-input').evaluate((element) => element.setAttribute('aria-label', 'Consumer name'));
  await expect(page.getByRole('textbox', {name: 'Consumer name'})).toBeVisible();

  await page.locator('#text-input').evaluate((element) => element.removeAttribute('aria-label'));
  await expect(page.getByRole('textbox', {name: 'Router name'})).toBeVisible();

  expect(
    await page.locator('#bare-input').evaluate((host) =>
      host.shadowRoot?.querySelector('input')?.hasAttribute('aria-label')
    ),
  ).toBe(false);
});

test('announces a field error on the inner input and clears it again', async ({page}) => {
  const control = page.getByRole('textbox', {name: 'Router name'});

  await page.locator('#field-input').evaluate(async (element) => {
    (element as HTMLElement & {error: string}).error = 'That name is taken.';
    await (element as HTMLElement & {updateComplete: Promise<unknown>}).updateComplete;
  });

  await expect(control).toHaveAttribute('aria-invalid', 'true');
  await expect(control).toHaveAccessibleDescription('Shown to other devices. That name is taken.');

  await page.locator('#field-input').evaluate(async (element) => {
    (element as HTMLElement & {error: string}).error = '';
    await (element as HTMLElement & {updateComplete: Promise<unknown>}).updateComplete;
  });

  await expect(control).not.toHaveAttribute('aria-invalid', 'true');
  await expect(control).toHaveAccessibleDescription('Shown to other devices.');
});

test('submits, resets, and disables the input through its host', async ({page}) => {
  await page.locator('#submit-button').click();

  const empty = JSON.parse((await page.locator('html').getAttribute('data-form-data')) ?? '[]') as string[][];

  expect(empty).toContainEqual(['device', '']);

  await page.getByRole('textbox', {name: 'Device name'}).fill('router');
  await page.locator('#submit-button').click();

  const filled = JSON.parse((await page.locator('html').getAttribute('data-form-data')) ?? '[]') as string[][];

  expect(filled).toContainEqual(['device', 'router']);

  await page.locator('#reset-button').click();
  await expect
    .poll(async () =>
      page.locator('#form-input').evaluate((element) => (element as HTMLElement & {value: string}).value)
    )
    .toBe('');

  await page.locator('#fieldset').evaluate((element) => element.setAttribute('disabled', ''));
  await expect
    .poll(async () =>
      page.locator('#form-input').evaluate((element) => element.shadowRoot?.querySelector('input')?.disabled ?? null)
    )
    .toBe(true);
});

test('keeps newlines in the textarea and commits only on blur', async ({page}) => {
  const control = page.getByRole('textbox', {name: 'Release notes'});

  await expect(control).toHaveAccessibleName('Release notes');
  await expect(control).toHaveAccessibleDescription('Markdown is supported.');

  await page.evaluate(() => {
    const host = document.querySelector('#notes-textarea');
    const seen: string[][] = [];

    Object.assign(window, {mndwEvents: seen});
    host?.addEventListener('mndwinput', (event) => {
      seen.push(['input', (event as CustomEvent<{value: string}>).detail.value]);
    });
    host?.addEventListener('mndwchange', (event) => {
      seen.push(['change', (event as CustomEvent<{value: string}>).detail.value]);
    });
  });

  await control.pressSequentially('first');
  await control.press('Enter');
  await control.pressSequentially('second');

  const beforeBlur = await page.evaluate(() => (window as unknown as {mndwEvents: string[][]}).mndwEvents);

  expect(beforeBlur.some(([kind]) => kind === 'change')).toBe(false);
  expect(await control.inputValue()).toBe('first\nsecond');

  await control.blur();

  const afterBlur = await page.evaluate(() => (window as unknown as {mndwEvents: string[][]}).mndwEvents);

  expect(afterBlur.filter(([kind]) => kind === 'change')).toEqual([['change', 'first\nsecond']]);
  await expect
    .poll(async () =>
      page.locator('#notes-textarea').evaluate((element) => (element as HTMLElement & {value: string}).value)
    )
    .toBe('first\nsecond');
});

test('grows an autosizing textarea with its content and keeps rows sizing otherwise', async ({page}) => {
  const autosizing = page.getByRole('textbox', {name: 'Autosizing notes'});
  const height = async (): Promise<number> => (await autosizing.boundingBox())?.height ?? 0;

  expect(
    await page.locator('#autosize-textarea').evaluate((host) =>
      host.shadowRoot?.querySelector('textarea')?.hasAttribute('rows')
    ),
  ).toBe(false);

  const before = await height();

  await autosizing.pressSequentially('one');
  await autosizing.press('Enter');
  await autosizing.pressSequentially('two');
  await autosizing.press('Enter');
  await autosizing.pressSequentially('three');

  await expect.poll(height).toBeGreaterThan(before);

  expect(
    await page.locator('#notes-textarea').evaluate((host) =>
      host.shadowRoot?.querySelector('textarea')?.getAttribute('rows')
    ),
  ).toBe('3');
});

test('submits and disables the textarea through its host', async ({page}) => {
  await page.getByRole('textbox', {name: 'Comment'}).fill('looks good');
  await page.locator('#submit-button').click();

  const submitted = JSON.parse((await page.locator('html').getAttribute('data-form-data')) ?? '[]') as string[][];

  expect(submitted).toContainEqual(['comment', 'looks good']);

  await page.locator('#fieldset').evaluate((element) => element.setAttribute('disabled', ''));
  await expect
    .poll(async () =>
      page.locator('#form-textarea').evaluate((element) =>
        element.shadowRoot?.querySelector('textarea')?.disabled ?? null
      )
    )
    .toBe(true);
});

test('toggles a switch from the host with keyboard and label click', async ({page}) => {
  const control = page.getByRole('switch', {name: 'Dark theme'});

  await expect(control).toBeVisible();
  await expect(control).not.toBeChecked();

  await page.evaluate(() => {
    const host = document.querySelector('#theme-switch');
    const seen: boolean[] = [];

    Object.assign(window, {mndwSwitchEvents: seen});
    host?.addEventListener('mndwchange', (event) => {
      seen.push((event as CustomEvent<{checked: boolean}>).detail.checked);
    });
  });

  await page.locator('#field-switch label').click();

  await expect(control).toBeChecked();
  await expect.poll(() => page.evaluate(() => document.activeElement?.id ?? null)).toBe('theme-switch');

  await page.keyboard.press(' ');
  await expect(control).not.toBeChecked();

  await page.keyboard.press('Enter');
  await expect(control).toBeChecked();

  expect(await page.evaluate(() => (window as unknown as {mndwSwitchEvents: boolean[]}).mndwSwitchEvents))
    .toEqual([true, false, true]);

  expect(
    await page.locator('#theme-switch').evaluate((host) => host.shadowRoot?.querySelector('[tabindex], button, input')),
  ).toBeNull();
});

test('drives a segmented group with roving tabindex and arrow keys', async ({page}) => {
  const group = page.getByRole('radiogroup', {name: 'Range'});
  const day = page.getByRole('radio', {name: 'Day'});
  const week = page.getByRole('radio', {name: 'Week'});
  const month = page.getByRole('radio', {name: 'Month'});

  await expect(group).toBeVisible();
  await expect(group).toHaveAttribute('tabindex', '-1');
  await expect(month).toHaveAttribute('aria-disabled', 'true');
  await expect(day).toHaveAttribute('tabindex', '0');

  await day.click();

  await expect(day).toBeChecked();
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('value') ?? null)).toBe('day');

  await page.keyboard.press('ArrowRight');

  await expect(week).toBeChecked();
  await expect(day).not.toBeChecked();
  await expect(week).toHaveAttribute('tabindex', '0');
  await expect(day).toHaveAttribute('tabindex', '-1');

  // Forward from the last enabled segment wraps, and the disabled one is never landed on.
  await page.keyboard.press('ArrowRight');

  await expect(day).toBeChecked();
  await expect(month).not.toBeChecked();

  await page.keyboard.press('End');

  await expect(week).toBeChecked();

  expect(await page.locator('#range').evaluate((element) => (element as HTMLElement & {value: string}).value))
    .toBe('week');
});

test('drives a slider with the keyboard and a real pointer drag', async ({page}) => {
  const control = page.getByRole('slider', {name: 'Volume'});

  await expect(control).toBeVisible();
  await expect(control).toHaveAttribute('aria-valuenow', '30');
  await expect(control).toHaveAttribute('aria-valuemin', '0');
  await expect(control).toHaveAttribute('aria-valuemax', '100');
  await expect(control).toHaveAttribute('aria-orientation', 'horizontal');
  await expect(control).not.toHaveAttribute('aria-valuetext', /.*/);

  await page.evaluate(() => {
    const host = document.querySelector('#volume');
    const inputs: number[] = [];
    const changes: number[] = [];

    Object.assign(window, {mndwSliderInputs: inputs, mndwSliderChanges: changes});
    host?.addEventListener('mndwinput', (event) => {
      inputs.push((event as CustomEvent<{value: number}>).detail.value);
    });
    host?.addEventListener('mndwchange', (event) => {
      changes.push((event as CustomEvent<{value: number}>).detail.value);
    });
  });

  // A label click reaches the host, which is the focus target and the keyboard surface.
  await page.locator('#field-volume label').click();
  await expect.poll(() => page.evaluate(() => document.activeElement?.id ?? null)).toBe('volume');

  await page.keyboard.press('ArrowRight');
  await expect(control).toHaveAttribute('aria-valuenow', '40');

  await page.keyboard.press('Home');
  await expect(control).toHaveAttribute('aria-valuenow', '0');

  await page.keyboard.press('End');
  await expect(control).toHaveAttribute('aria-valuenow', '100');

  await page.keyboard.press('PageDown');
  await expect(control).toHaveAttribute('aria-valuenow', '90');

  // Keyboard commits on the same keystroke as the input it reports.
  expect(await page.evaluate(() => (window as unknown as {mndwSliderChanges: number[]}).mndwSliderChanges))
    .toEqual([40, 0, 100, 90]);

  const track = await page.locator('#volume [part="track"]').boundingBox();

  if (!track) {
    throw new Error('missing slider track');
  }

  const middle = track.y + (track.height / 2);

  await page.mouse.move(track.x + (track.width / 2), middle);
  await page.mouse.down();
  await expect(control).toHaveAttribute('aria-valuenow', '50');

  await page.mouse.move(track.x + (track.width * 0.7), middle);
  await page.mouse.move(track.x + (track.width * 0.2), middle);
  await page.mouse.up();

  await expect(control).toHaveAttribute('aria-valuenow', '20');

  const events = await page.evaluate(() => ({
    inputs: (window as unknown as {mndwSliderInputs: number[]}).mndwSliderInputs,
    changes: (window as unknown as {mndwSliderChanges: number[]}).mndwSliderChanges,
  }));

  // The drag reports continuously but commits exactly once, on release.
  expect(events.inputs.slice(4)).toEqual([50, 70, 20]);
  expect(events.changes).toEqual([40, 0, 100, 90, 20]);

  expect(
    await page.locator('#volume').evaluate((host) => host.shadowRoot?.querySelector('[tabindex], button, input')),
  ).toBeNull();
});

test('drives tabs with automatic activation and reciprocal relationships', async ({page}) => {
  const general = page.getByRole('tab', {name: 'General'});
  const network = page.getByRole('tab', {name: 'Network'});
  const advanced = page.getByRole('tab', {name: 'Advanced'});

  await expect(page.getByRole('tablist')).toBeVisible();
  await expect(page.locator('#settings-tabs')).not.toHaveAttribute('role', /.*/);

  await expect(general).toHaveAttribute('aria-selected', 'true');
  await expect(general).toHaveAttribute('aria-controls', /^mndw-tab-panel-\d+$/);
  await expect(network).toHaveAttribute('aria-controls', 'network-panel');
  await expect(advanced).toHaveAttribute('aria-disabled', 'true');

  // Only the active panel is in the accessibility tree; the others carry `hidden`.
  await expect(page.getByRole('tabpanel')).toHaveCount(1);
  await expect(page.getByRole('tabpanel')).toHaveText('General body');
  await expect(page.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'tab-general');

  await general.click();
  await page.keyboard.press('ArrowRight');

  await expect(network).toHaveAttribute('aria-selected', 'true');
  await expect(general).toHaveAttribute('aria-selected', 'false');
  await expect(page.getByRole('tabpanel')).toHaveText('Network body');
  await expect(page.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'tab-network');
  await expect.poll(() => page.evaluate(() => document.activeElement?.id ?? null)).toBe('tab-network');

  // `advanced` is disabled, so forward from the last enabled tab wraps rather than landing on it.
  await page.keyboard.press('ArrowRight');

  await expect(general).toHaveAttribute('aria-selected', 'true');
  await expect(advanced).toHaveAttribute('aria-selected', 'false');

  await expect(page.locator('mndw-tab-panel[for="ghost"]')).toBeHidden();
});

test('owns only its own token in a tooltip trigger description', async ({page}) => {
  const trigger = page.locator('#restart-trigger');
  const tooltip = page.locator('#restart-tip');

  await expect(tooltip).toHaveAttribute('role', 'tooltip');
  await expect(trigger).toHaveAttribute('aria-describedby', 'restart-hint restart-tip');
  await expect(trigger).toHaveAccessibleDescription(/Restarts the device immediately/);
  await expect(trigger).toHaveAccessibleDescription(/Consumer description/);

  await tooltip.evaluate((element) => {
    (element as HTMLElement & {text: string}).text = '';
  });

  await expect(trigger).toHaveAttribute('aria-describedby', 'restart-hint');
  await expect(tooltip).not.toHaveAttribute('role', /.*/);
  await expect(trigger).toHaveAccessibleDescription(/Consumer description/);
  await expect(trigger).not.toHaveAccessibleDescription(/Restarts the device immediately/);
});

test('shows a tooltip on hover and flips it away from the viewport edge', async ({page}) => {
  const tooltip = page.locator('#edge-tip');
  const bubble = page.locator('#edge-tip [part="tooltip"]');

  await expect(tooltip).not.toHaveAttribute('open', /.*/);
  await expect.poll(() => bubble.evaluate((element) => getComputedStyle(element).opacity)).toBe('0');

  await page.locator('#edge-trigger').hover();

  await expect(tooltip).toHaveAttribute('open', '');
  // Requested `top`, but the trigger is pinned to the top edge, so the only side that fits is below.
  await expect(tooltip).toHaveAttribute('data-placement', 'bottom');
  await expect.poll(() => bubble.evaluate((element) => getComputedStyle(element).opacity)).toBe('1');

  const box = await bubble.boundingBox();
  const anchor = await page.locator('#edge-trigger').boundingBox();

  if (!box || !anchor) {
    throw new Error('missing tooltip geometry');
  }

  expect(box.y).toBeGreaterThan(anchor.y + anchor.height);

  await page.mouse.move(0, 400);

  await expect(tooltip).not.toHaveAttribute('open', /.*/);
});

test('hides a tooltip on Escape without consuming the key', async ({page}) => {
  const tooltip = page.locator('#restart-tip');

  await page.locator('#restart-trigger').focus();

  await expect(tooltip).toHaveAttribute('open', '');

  await page.evaluate(() => {
    const escapes: boolean[] = [];

    Object.assign(window, {mndwEscapes: escapes});
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        escapes.push(event.defaultPrevented);
      }
    });
  });

  await page.keyboard.press('Escape');

  await expect(tooltip).not.toHaveAttribute('open', /.*/);
  // The tooltip dismisses on Escape but leaves the key for anything else listening.
  expect(await page.evaluate(() => (window as unknown as {mndwEscapes: boolean[]}).mndwEscapes)).toEqual([false]);
});

test('focuses invalid select host when form validity is reported', async ({page}) => {
  const result = await page.locator('#field-select').evaluate(async (element) => {
    (element as HTMLElement & {required: boolean}).required = true;
    await (element as HTMLElement & {updateComplete: Promise<unknown>}).updateComplete;

    const form = element.closest('form');

    if (!form) {
      throw new Error('missing component form');
    }

    return {valid: form.reportValidity(), activeId: document.activeElement?.id ?? null};
  });

  expect(result).toEqual({valid: false, activeId: 'field-select'});
});

async function tableRowTexts(table: Locator): Promise<string[]> {
  return table.evaluate((element) => {
    const shadow = element.shadowRoot;

    if (shadow === null) {
      return [];
    }

    return [...shadow.querySelectorAll('tbody tr')].map((row) => row.textContent ?? '');
  });
}

async function sortedColumn(table: Locator): Promise<string> {
  return table.evaluate((element) => {
    const header = element.shadowRoot?.querySelector('th[aria-sort]');
    const button = header?.querySelector('button[data-sort-column]');
    const columnId = button?.getAttribute('data-sort-column');
    const aria = header?.getAttribute('aria-sort');
    const direction = aria === 'ascending' ? 'asc' : aria === 'descending' ? 'desc' : '';

    return header === null || header === undefined || columnId === null || columnId === undefined
      ? ''
      : `${columnId}|${direction}`;
  });
}

async function valueCellText(table: Locator): Promise<string> {
  return table.evaluate((element) => {
    const cells = [...(element.shadowRoot?.querySelectorAll('tbody tr td') ?? [])];

    return cells[4]?.textContent ?? '';
  });
}

async function clickSortButton(table: Locator, columnId: string): Promise<void> {
  await table.locator(`button[data-sort-column="${columnId}"]`).click();
}

async function selectAllState(table: Locator): Promise<{checked: boolean; indeterminate: boolean}> {
  return table.evaluate((element) => {
    const checkbox = element.shadowRoot?.querySelector('mndw-checkbox[data-select-all]') as
      | (HTMLElement & {checked: boolean; indeterminate: boolean})
      | null;

    return {checked: checkbox?.checked ?? false, indeterminate: checkbox?.indeterminate ?? false};
  });
}

async function focusedOption(menu: Locator): Promise<string | null> {
  return menu.evaluate((element) => element.shadowRoot?.activeElement?.getAttribute('data-column-id') ?? null);
}

async function ariaChecked(menu: Locator, columnId: string): Promise<string | null> {
  return menu.evaluate((element, id) => {
    const button = [...(element.shadowRoot?.querySelectorAll('button[data-column-id]') ?? [])]
      .find((candidate) => candidate.getAttribute('data-column-id') === id);

    return button?.getAttribute('aria-checked') ?? null;
  }, columnId);
}

async function tableHasColumn(table: Locator, columnId: string): Promise<boolean> {
  return table.evaluate(
    (element, id) => element.shadowRoot?.querySelector(`button[data-sort-column="${id}"]`) !== null,
    columnId,
  );
}

async function triggerFocused(table: Locator): Promise<boolean> {
  return table.evaluate((element) => element.shadowRoot?.activeElement?.getAttribute('part') === 'column-menu-trigger');
}

async function reorderIntents(page: Page): Promise<{key: string; beforeKey: string | null}[]> {
  return page.evaluate(() =>
    (window as unknown as {__fixtureReorderIntents: {key: string; beforeKey: string | null}[]}).__fixtureReorderIntents
  );
}

test.describe('mndw-table', () => {
  test.use({viewport: {width: 1280, height: 2400}});

  test('renders native table semantics with a caption, scoped headers, and a light-DOM cell', async ({page}) => {
    const semantics = await page.locator('#table-fixture').evaluate((element) => {
      const shadow = element.shadowRoot;
      const headers = [...(shadow?.querySelectorAll('th') ?? [])];

      return {
        hasTable: shadow?.querySelector('table') !== null,
        hasThead: shadow?.querySelector('thead') !== null,
        hasTbody: shadow?.querySelector('tbody') !== null,
        caption: shadow?.querySelector('caption')?.textContent ?? null,
        headerCount: headers.length,
        headerScopesCol: headers.every((header) => header.getAttribute('scope') === 'col'),
        rowCount: shadow?.querySelectorAll('tbody tr').length ?? 0,
        customCell: element.querySelector('a.fixture-link')?.textContent ?? null,
      };
    });

    expect(semantics).toEqual({
      hasTable: true,
      hasThead: true,
      hasTbody: true,
      caption: 'Device fixtures',
      headerCount: 9,
      headerScopesCol: true,
      rowCount: 5,
      customCell: 'Open',
    });
  });

  test('sorts on header click with controlled write-back and indicators', async ({page}) => {
    const locator = page.locator('#table-fixture');

    await expect.poll(async () => sortedColumn(locator)).toBe('name|asc');
    await expect.poll(async () => tableRowTexts(locator)).toEqual([
      expect.stringContaining('Alpha'),
      expect.stringContaining('Beta'),
      expect.stringContaining('Delta'),
      expect.stringContaining('Epsilon'),
      expect.stringContaining('Gamma'),
    ]);

    await clickSortButton(locator, 'value');
    await expect.poll(async () => sortedColumn(locator)).toBe('value|asc');
    await expect.poll(async () => valueCellText(locator)).toBe('0');

    await clickSortButton(locator, 'value');
    await expect.poll(async () => sortedColumn(locator)).toBe('value|desc');
    await expect.poll(async () => valueCellText(locator)).toBe('780');

    await clickSortButton(locator, 'value');
    await expect.poll(async () => sortedColumn(locator)).toBe('');
  });

  test('reflects select-all checked and indeterminate states through controlled write-back', async ({page}) => {
    const locator = page.locator('#table-fixture');

    await expect.poll(async () => selectAllState(locator)).toEqual({checked: false, indeterminate: false});

    await locator.locator('mndw-checkbox[data-row-key="dev-1"]').click();
    await expect.poll(async () => selectAllState(locator)).toEqual({checked: false, indeterminate: true});

    await locator.locator('mndw-checkbox[data-select-all]').click();
    await expect.poll(async () => selectAllState(locator)).toEqual({checked: true, indeterminate: false});

    await locator.locator('mndw-checkbox[data-select-all]').click();
    await expect.poll(async () => selectAllState(locator)).toEqual({checked: false, indeterminate: false});
  });

  test('emits row reorder intent and resets order optimistically without a consumer write-back', async ({page}) => {
    const locator = page.locator('#table-fixture');

    await clickSortButton(locator, 'name');
    await clickSortButton(locator, 'name');
    await expect.poll(async () => sortedColumn(locator)).toBe('');

    const handles = locator.locator('button[part="drag-handle"]');
    const handle = handles.first();

    await handle.focus();
    await page.keyboard.press('ArrowDown');

    await expect.poll(async () => reorderIntents(page)).toEqual([{key: 'dev-1', beforeKey: 'dev-3'}]);
    await expect.poll(async () => tableRowTexts(locator)).toEqual([
      expect.stringContaining('Alpha'),
      expect.stringContaining('Beta'),
      expect.stringContaining('Gamma'),
      expect.stringContaining('Delta'),
      expect.stringContaining('Epsilon'),
    ]);
  });

  test('column menu focuses, toggles, and closes via keyboard', async ({page}) => {
    const locator = page.locator('#table-fixture');

    await locator.locator('[part="column-menu-trigger"]').click();

    const menu = page.locator('mndw-column-menu');

    await expect(menu).toBeVisible();
    await expect.poll(async () => focusedOption(menu)).toBe('model');

    await page.keyboard.press('ArrowDown');
    await expect.poll(async () => focusedOption(menu)).toBe('status');

    await page.keyboard.press('Space');
    await expect.poll(async () => ariaChecked(menu, 'status')).toBe('false');
    await expect.poll(async () => tableHasColumn(locator, 'status')).toBe(false);

    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect.poll(async () => triggerFocused(locator)).toBe(true);

    await locator.locator('[part="column-menu-trigger"]').click();

    const reopened = page.locator('mndw-column-menu');

    await expect(reopened).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(reopened).toHaveCount(0);
    await expect.poll(async () => triggerFocused(locator)).toBe(false);
  });

  test('keeps the non-hideable column locked while hiding hideable ones', async ({page}) => {
    const locator = page.locator('#table-fixture');

    await locator.locator('[part="column-menu-trigger"]').click();

    const menu = page.locator('mndw-column-menu');

    await expect(menu).toBeVisible();

    const optionIds = await menu.evaluate((element) => {
      return [...(element.shadowRoot?.querySelectorAll('button[data-column-id]') ?? [])]
        .map((button) => button.getAttribute('data-column-id'));
    });

    expect(optionIds).toEqual(['model', 'status', 'value', 'link', 'note', 'detail']);
    expect(optionIds).not.toContain('name');

    await page.keyboard.press('Space');
    await expect.poll(async () => tableHasColumn(locator, 'model')).toBe(false);
    await expect.poll(async () => tableHasColumn(locator, 'name')).toBe(true);
  });

  test('contains horizontal overflow inside the viewport rather than the page', async ({page}) => {
    const dimensions = await page.evaluate(() => {
      const table = document.querySelector('#table-fixture');

      if (!table?.shadowRoot) {
        return null;
      }

      const viewport = table.shadowRoot.querySelector('[part="viewport"]');
      const tablePart = table.shadowRoot.querySelector('table');

      if (!viewport || !tablePart) {
        return null;
      }

      return {
        viewportClientWidth: viewport.clientWidth,
        viewportScrollWidth: viewport.scrollWidth,
        pageScrollWidth: document.documentElement.scrollWidth,
        windowWidth: window.innerWidth,
      };
    });

    expect(dimensions).not.toBeNull();

    if (dimensions === null) {
      throw new Error('table fixture geometry unavailable');
    }

    expect(dimensions.viewportScrollWidth).toBeGreaterThan(dimensions.viewportClientWidth);
    expect(dimensions.pageScrollWidth).toBeLessThanOrEqual(dimensions.windowWidth);
  });

  test('keeps the pinned first column fixed while the table scrolls horizontally', async ({page}) => {
    const table = page.locator('#table-sticky-fixture');
    const viewport = table.locator('[part="viewport"]');
    const firstHeader = table.locator('[part~="header-cell"]').first();
    const secondHeader = table.locator('[part~="header-cell"]').nth(1);

    await firstHeader.waitFor();

    const viewportLeft = await viewport.evaluate((element) => element.getBoundingClientRect().left);
    const firstBefore = await firstHeader.evaluate((element) => element.getBoundingClientRect().left);
    const secondBefore = await secondHeader.evaluate((element) => element.getBoundingClientRect().left);

    await viewport.evaluate((element) => {
      element.scrollLeft = 240;
    });
    await expect.poll(async () => viewport.evaluate((element) => element.scrollLeft)).toBe(240);

    const firstAfter = await firstHeader.evaluate((element) => element.getBoundingClientRect().left);
    const secondAfter = await secondHeader.evaluate((element) => element.getBoundingClientRect().left);

    expect(Math.abs(firstAfter - firstBefore)).toBeLessThan(2);
    expect(Math.abs(firstAfter - viewportLeft)).toBeLessThan(2);
    expect(secondAfter - secondBefore).toBeLessThan(-100);
  });

  test('keeps the header fixed while the table scrolls vertically', async ({page}) => {
    const table = page.locator('#table-sticky-fixture');
    const viewport = table.locator('[part="viewport"]');
    const headerCell = table.locator('[part~="header-cell"]').nth(1);
    const firstBody = table.locator('[part="row"] [part~="cell"]').nth(1);

    await headerCell.waitFor();

    const viewportTop = await viewport.evaluate((element) => element.getBoundingClientRect().top);
    const before = await headerCell.evaluate((element) => element.getBoundingClientRect().top);
    const bodyBefore = await firstBody.evaluate((element) => element.getBoundingClientRect().top);

    await viewport.evaluate((element) => {
      element.scrollTop = 300;
    });
    await expect.poll(async () => viewport.evaluate((element) => element.scrollTop)).toBe(300);

    const after = await headerCell.evaluate((element) => element.getBoundingClientRect().top);
    const bodyAfter = await firstBody.evaluate((element) => element.getBoundingClientRect().top);

    expect(Math.abs(after - before)).toBeLessThan(2);
    expect(Math.abs(after - viewportTop)).toBeLessThan(2);
    expect(bodyAfter - bodyBefore).toBeLessThan(-100);
  });
});
