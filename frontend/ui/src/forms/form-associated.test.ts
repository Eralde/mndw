import {beforeEach, describe, expect, it, vi} from 'vitest';
import {FormAssociatedController, FormLabelController, type FormValue} from './form-associated.js';

describe('FormLabelController', () => {
  it('assigns stable host-scoped IDs only to unlabeled labels', () => {
    const host = document.createElement('mndw-label-probe');
    const existing = document.createElement('label');
    const generated = document.createElement('label');

    existing.id = 'explicit-label';

    const controller = new FormLabelController(host);

    controller.sync([existing, generated]);

    const generatedId = generated.id;

    expect(generatedId).toMatch(/^mndw-mndw-label-probe-\d+-label-1$/);
    expect(existing.id).toBe('explicit-label');
    expect(host.getAttribute('aria-labelledby')).toBe(`explicit-label ${generatedId}`);

    controller.sync([existing, generated]);

    expect(generated.id).toBe(generatedId);

    controller.sync([generated, existing]);

    expect(generated.id).toBe(generatedId);
  });

  it('updates ElementInternals with label element references without cross-root queries', () => {
    const host = document.createElement('mndw-label-probe');
    const label = document.createElement('label');
    const labelledBy: Element[] = [];
    const internals = {
      set ariaLabelledByElements(value: Element[]) {
        labelledBy.splice(0, labelledBy.length, ...value);
      },
    } as unknown as ElementInternals;

    new FormLabelController(host).sync([label], internals);

    expect(labelledBy).toEqual([label]);
    expect(host.querySelector('label')).toBeNull();
  });
});

interface FakeInternals {
  form: HTMLFormElement | null;
  lastValue: FormValue;
  lastState: FormValue;
  validity: ValidityStateFlags;
  message: string;
  anchor: HTMLElement | undefined;
  setFormValue: (value: FormValue, state?: FormValue) => void;
  setValidity: (flags: ValidityStateFlags, message?: string, anchor?: HTMLElement) => void;
}

interface Harness {
  host: HTMLElement;
  internals: FakeInternals;
  controller: FormAssociatedController<HTMLElement>;
  explicitDisabled: {value: boolean};
  restored: ReturnType<typeof vi.fn>;
}

function createHarness(): Harness {
  const host = document.createElement('div');
  const explicitDisabled = {value: false};
  const restored = vi.fn();
  const internals: FakeInternals = {
    form: null,
    lastValue: null,
    lastState: null,
    validity: {},
    message: '',
    anchor: undefined,
    setFormValue(value, state) {
      this.lastValue = value;
      this.lastState = state ?? value;
    },
    setValidity(flags, message = '', anchor) {
      this.validity = flags;
      this.message = message;
      this.anchor = anchor;
    },
  };

  Object.defineProperty(host, 'attachInternals', {value: () => internals});

  const controller = new FormAssociatedController(host, {
    isExplicitlyDisabled: () => explicitDisabled.value,
    onReset: restored,
    onStateRestore: vi.fn(),
  });

  return {host, internals, controller, explicitDisabled, restored};
}

describe('FormAssociatedController', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  it('composes fieldset disabled state without losing explicit disabled state', () => {
    expect(harness.controller.effectiveDisabled).toBe(false);

    harness.explicitDisabled.value = true;
    expect(harness.controller.effectiveDisabled).toBe(true);

    harness.controller.formDisabledCallback(true);
    harness.explicitDisabled.value = false;
    expect(harness.controller.effectiveDisabled).toBe(true);

    harness.controller.formDisabledCallback(false);
    expect(harness.controller.effectiveDisabled).toBe(false);
  });

  it('notifies controls when effective disabled state changes', () => {
    const onDisabledChange = vi.fn();
    const controller = new FormAssociatedController(harness.host, {
      isExplicitlyDisabled: () => harness.explicitDisabled.value,
      onReset: vi.fn(),
      onStateRestore: vi.fn(),
      onDisabledChange,
    });

    controller.formDisabledCallback(true);
    expect(onDisabledChange).toHaveBeenLastCalledWith(true);

    controller.formDisabledCallback(false);
    expect(onDisabledChange).toHaveBeenLastCalledWith(false);
  });

  it('restores captured attributes through form reset', () => {
    harness.host.setAttribute('checked', '');
    harness.host.setAttribute('value', 'initial');
    harness.controller.captureInitialAttributes(['checked', 'value']);
    harness.host.removeAttribute('checked');
    harness.host.setAttribute('value', 'live');

    harness.controller.restoreInitialAttributes();

    expect(harness.host.hasAttribute('checked')).toBe(true);
    expect(harness.host.getAttribute('value')).toBe('initial');
  });

  it('calls the control reset callback without mutating live properties', () => {
    harness.controller.formResetCallback();

    expect(harness.restored).toHaveBeenCalledOnce();
  });

  it('forwards state restore callbacks', () => {
    const onStateRestore = vi.fn();
    const controller = new FormAssociatedController(harness.host, {
      isExplicitlyDisabled: () => false,
      onReset: vi.fn(),
      onStateRestore,
    });

    controller.formStateRestoreCallback('saved', 'restore');

    expect(onStateRestore).toHaveBeenCalledWith('saved', 'restore');
  });

  it('forwards null and empty values distinctly for FormData policy', () => {
    harness.controller.setFormValue(null);
    expect(harness.internals.lastValue).toBeNull();

    harness.controller.setFormValue('');
    expect(harness.internals.lastValue).toBe('');
  });

  it('synchronizes validity without passing a shadow anchor', () => {
    harness.controller.setValidity({valueMissing: true}, 'Value required');
    expect(harness.internals.validity).toEqual({valueMissing: true});
    expect(harness.internals.message).toBe('Value required');
    expect(harness.internals.anchor).toBeUndefined();

    harness.controller.clearValidity();
    expect(harness.internals.validity).toEqual({});
  });
});
