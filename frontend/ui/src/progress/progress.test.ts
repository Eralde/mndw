// @vitest-environment happy-dom
import {afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {defineComponents, mount} from '../testing/index.js';
import {MNDW_PROGRESS_TAG, MndwProgress} from './progress.js';

defineComponents([MNDW_PROGRESS_TAG, MndwProgress]);

function bar(element: MndwProgress): HTMLElement {
  const found = element.shadowRoot?.querySelector<HTMLElement>('[part="bar"]');

  if (!found) {
    throw new Error('missing bar');
  }

  return found;
}

describe('<mndw-progress> bar geometry', () => {
  it('clamps the value into the range', async () => {
    const element = await mount('<mndw-progress value="150" max="100"></mndw-progress>', MNDW_PROGRESS_TAG);

    expect(bar(element).style.width).toBe('100%');

    element.value = -20;
    await element.updateComplete;

    expect(bar(element).style.width).toBe('0%');
  });

  it('falls back to the default max when max cannot describe a ratio', async () => {
    const element = await mount('<mndw-progress value="25" max="0"></mndw-progress>', MNDW_PROGRESS_TAG);

    expect(bar(element).style.width).toBe('25%');

    element.max = -50;
    await element.updateComplete;

    expect(bar(element).style.width).toBe('25%');

    element.max = Number.NaN;
    await element.updateComplete;

    expect(bar(element).style.width).toBe('25%');
  });

  it('is indeterminate without a finite value', async () => {
    const element = await mount('<mndw-progress value="nope"></mndw-progress>', MNDW_PROGRESS_TAG);

    expect(bar(element).classList.contains('indeterminate')).toBe(true);
    expect(bar(element).style.width).toBe('');

    element.value = 40;
    await element.updateComplete;

    expect(bar(element).classList.contains('indeterminate')).toBe(false);

    element.value = Number.POSITIVE_INFINITY;
    await element.updateComplete;

    expect(bar(element).classList.contains('indeterminate')).toBe(true);
    expect(bar(element).style.width).toBe('');
  });

  it('sizes the bar from value / max', async () => {
    const element = await mount('<mndw-progress value="30" max="60"></mndw-progress>', MNDW_PROGRESS_TAG);

    expect(bar(element).style.width).toBe('50%');

    element.max = 120;
    await element.updateComplete;

    expect(bar(element).style.width).toBe('25%');
  });
});

interface FakeInternals {
  role: string | null;
  ariaLabel: string | null;
  ariaValueNow: string | null;
  ariaValueMin: string | null;
  ariaValueMax: string | null;
  ariaBusy: string | null;
}

const INTERNALS_TAG = 'mndw-progress-internals-probe';
let latestInternals: FakeInternals | null = null;

function createFakeInternals(): ElementInternals & {record: FakeInternals} {
  const record: FakeInternals = {
    role: null,
    ariaLabel: null,
    ariaValueNow: null,
    ariaValueMin: null,
    ariaValueMax: null,
    ariaBusy: null,
  };

  return {
    record,
    set role(value: string | null) {
      record.role = value;
    },
    set ariaLabel(value: string | null) {
      record.ariaLabel = value;
    },
    set ariaValueNow(value: string | null) {
      record.ariaValueNow = value;
    },
    set ariaValueMin(value: string | null) {
      record.ariaValueMin = value;
    },
    set ariaValueMax(value: string | null) {
      record.ariaValueMax = value;
    },
    set ariaBusy(value: string | null) {
      record.ariaBusy = value;
    },
  } as unknown as ElementInternals & {record: FakeInternals};
}

// happy-dom has no `HTMLElement.prototype.attachInternals`, so the ARIA surface is covered against a
// stub for the duration of this block.
describe('<mndw-progress> ARIA', () => {
  let previous: PropertyDescriptor | undefined;

  beforeAll(() => {
    if (!customElements.get(INTERNALS_TAG)) {
      customElements.define(INTERNALS_TAG, class extends MndwProgress {});
    }
  });

  beforeEach(() => {
    previous = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'attachInternals');
    Object.defineProperty(HTMLElement.prototype, 'attachInternals', {
      configurable: true,
      writable: true,
      value(): ElementInternals {
        const internals = createFakeInternals();

        latestInternals = internals.record;

        return internals;
      },
    });
  });

  afterEach(() => {
    if (previous) {
      Object.defineProperty(HTMLElement.prototype, 'attachInternals', previous);
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, 'attachInternals');
    }

    latestInternals = null;
  });

  it('publishes the clamped value, range, and role for a determinate bar', async () => {
    document.body.innerHTML = `<${INTERNALS_TAG} value="120" max="100" label="Uploading"></${INTERNALS_TAG}>`;

    const element = document.body.firstElementChild as MndwProgress;

    await element.updateComplete;

    expect(latestInternals).toMatchObject({
      role: 'progressbar',
      ariaLabel: 'Uploading',
      ariaValueNow: '100',
      ariaValueMin: '0',
      ariaValueMax: '100',
      ariaBusy: null,
    });
    expect(element.hasAttribute('role')).toBe(false);
    expect(element.hasAttribute('aria-valuenow')).toBe(false);
    expect(element.hasAttribute('aria-busy')).toBe(false);
  });

  it('clears the values and marks a bar without a finite value busy', async () => {
    document.body.innerHTML = `<${INTERNALS_TAG} value="nope"></${INTERNALS_TAG}>`;

    const element = document.body.firstElementChild as MndwProgress;

    await element.updateComplete;

    expect(latestInternals).toMatchObject({
      role: 'progressbar',
      ariaValueNow: null,
      ariaValueMin: null,
      ariaValueMax: null,
      ariaBusy: 'true',
    });

    element.value = 40;
    await element.updateComplete;

    expect(latestInternals?.ariaValueNow).toBe('40');
    expect(latestInternals?.ariaBusy).toBeNull();
  });

  it('names the bar from label and drops the name when label is removed', async () => {
    document.body.innerHTML = `<${INTERNALS_TAG} value="10" label="Restoring backup"></${INTERNALS_TAG}>`;

    const element = document.body.firstElementChild as MndwProgress;

    await element.updateComplete;

    expect(latestInternals?.ariaLabel).toBe('Restoring backup');

    element.removeAttribute('label');
    await element.updateComplete;

    expect(latestInternals?.ariaLabel).toBeNull();
  });
});
