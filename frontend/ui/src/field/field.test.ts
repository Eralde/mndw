import {describe, expect, it, vi} from 'vitest';
import {
  MNDW_FIELD_TAG,
  MNDW_LABEL_CHANGE_EVENT,
  MndwField,
  type MndwLabelSource,
  dispatchLabelChange,
} from './field.js';
import {defineComponents, mount as mountComponent, settle} from '../testing/index.js';

const LABEL_PROPERTY_TAG = 'field-test-label-property';
const SLOT_TAG = 'field-test-slot';
const PLAIN_TAG = 'field-test-plain';

class LabelPropertyControl extends HTMLElement {
  public static readonly formAssociated = true;
  public static readonly mndwLabelSource: MndwLabelSource = 'label-property';

  public label = '';
}

class SlotControl extends HTMLElement {
  public static readonly formAssociated = true;
  public static readonly mndwLabelSource: MndwLabelSource = 'slot';
}

class PlainControl extends HTMLElement {}

defineComponents(
  [MNDW_FIELD_TAG, MndwField],
  [LABEL_PROPERTY_TAG, LabelPropertyControl],
  [SLOT_TAG, SlotControl],
  [PLAIN_TAG, PlainControl],
);

it('dispatches the shared label-change event with field-crossing propagation', () => {
  const parent = document.createElement('div');
  const target = document.createElement('div');
  const listener = vi.fn<(event: Event) => void>();

  parent.append(target);
  parent.addEventListener(MNDW_LABEL_CHANGE_EVENT, listener);

  dispatchLabelChange(target);

  expect(listener).toHaveBeenCalledTimes(1);

  const event = listener.mock.calls[0]?.[0];

  expect(event?.type).toBe(MNDW_LABEL_CHANGE_EVENT);
  expect(event?.target).toBe(target);
  expect(event?.bubbles).toBe(true);
  expect(event?.composed).toBe(true);
});

async function mount(html: string): Promise<MndwField> {
  const element = await mountComponent(html, MNDW_FIELD_TAG);

  await settle(element);

  return element;
}

function labelNode(element: MndwField): HTMLLabelElement {
  const node = element.querySelector<HTMLLabelElement>('label.mndw-field__label');

  if (!node) {
    throw new Error('missing field label');
  }

  return node;
}

function hintNode(element: MndwField): HTMLElement {
  const node = element.querySelector<HTMLElement>('.mndw-field__hint');

  if (!node) {
    throw new Error('missing field hint');
  }

  return node;
}

function errorNode(element: MndwField): HTMLElement {
  const node = element.querySelector<HTMLElement>('.mndw-field__error');

  if (!node) {
    throw new Error('missing field error');
  }

  return node;
}

function describedBy(control: Element): string[] {
  return (control.getAttribute('aria-describedby') ?? '').split(/\s+/u).filter((token) => token !== '');
}

describe('<mndw-field> rendering', () => {
  it('renders into light DOM without a shadow root', async () => {
    const element = await mount('<mndw-field label="Host"><input id="host" /></mndw-field>');

    expect(element.shadowRoot).toBeNull();
    expect(element.classList.contains('mndw-field')).toBe(true);
  });

  it('creates exactly three owned nodes with the documented classes and role', async () => {
    const element = await mount('<mndw-field label="Host" hint="Hint" error="Broken"><input /></mndw-field>');

    expect(labelNode(element).className).toBe('mndw-field__label');
    expect(hintNode(element).className).toBe('mndw-field__hint');
    expect(errorNode(element).className).toBe('mndw-field__error mndw-alert mndw-alert--danger');
    expect(errorNode(element).getAttribute('role')).toBe('alert');
    expect(element.querySelectorAll('.mndw-field__label, .mndw-field__hint, .mndw-field__error')).toHaveLength(3);
  });

  it('keeps owned-node identity across updates and only changes text and visibility', async () => {
    const element = await mount('<mndw-field label="Host"><input /></mndw-field>');
    const label = labelNode(element);
    const hint = hintNode(element);
    const error = errorNode(element);

    expect(hint.hidden).toBe(true);
    expect(error.hidden).toBe(true);

    element.label = 'Host name';
    element.hint = 'Shown in the device list';
    element.error = 'Required';
    await settle(element);

    expect(labelNode(element)).toBe(label);
    expect(hintNode(element)).toBe(hint);
    expect(errorNode(element)).toBe(error);
    expect(label.textContent).toContain('Host name');
    expect(hint.textContent).toBe('Shown in the device list');
    expect(error.textContent).toBe('Required');
    expect(hint.hidden).toBe(false);
    expect(error.hidden).toBe(false);
  });

  it('places the owned nodes in label, control, hint, error order', async () => {
    const element = await mount('<mndw-field label="Host" hint="Hint"><input id="host" /></mndw-field>');
    const order = [...element.children].map((child) => child.className || child.id);

    expect(order).toEqual([
      'mndw-field__label',
      'host',
      'mndw-field__hint',
      'mndw-field__error mndw-alert mndw-alert--danger',
    ]);
  });

  it('hides its label when the label property is empty', async () => {
    const element = await mount('<mndw-field><input /></mndw-field>');

    expect(labelNode(element).hidden).toBe(true);
  });
});

describe('<mndw-field> control resolution', () => {
  it('selects the first Element child, skipping comments and whitespace', async () => {
    const element = await mount(
      '<mndw-field label="Host">\n  <!-- framework placeholder -->\n  <input id="host" />\n</mndw-field>',
    );

    expect(labelNode(element).htmlFor).toBe('host');
  });

  it('generates an id only when the control has none', async () => {
    const element = await mount('<mndw-field label="Host"><input /></mndw-field>');
    const control = element.querySelector('input');

    expect(control?.id).toMatch(/^mndw-field-\d+-control$/u);
    expect(labelNode(element).htmlFor).toBe(control?.id);
  });

  it('keeps a consumer-supplied id and points its label at it', async () => {
    const element = await mount('<mndw-field label="Host"><input id="chosen" /></mndw-field>');

    expect(element.querySelector('input')?.id).toBe('chosen');
    expect(labelNode(element).htmlFor).toBe('chosen');
  });

  it('restores its generated id when a consumer clears it', async () => {
    const element = await mount('<mndw-field label="Host"><input /></mndw-field>');
    const control = element.querySelector('input');

    if (!control) {
      throw new Error('missing control');
    }

    const generated = control.id;

    control.removeAttribute('id');
    await settle(element);

    expect(control.id).toBe(generated);
    expect(labelNode(element).htmlFor).toBe(generated);
  });

  it('re-points its label when a consumer replaces the id', async () => {
    const element = await mount('<mndw-field label="Host"><input /></mndw-field>');
    const control = element.querySelector('input');

    if (!control) {
      throw new Error('missing control');
    }

    control.id = 'consumer-id';
    await settle(element);

    expect(labelNode(element).htmlFor).toBe('consumer-id');
  });

  it('wires a control inserted after connection', async () => {
    const element = await mount('<mndw-field label="Host"></mndw-field>');
    const control = document.createElement('input');

    element.appendChild(control);
    await settle(element);

    expect(labelNode(element).htmlFor).toBe(control.id);
    expect(control.id).not.toBe('');
  });
});

describe('<mndw-field> label association', () => {
  it('associates its label with a form-associated custom control', async () => {
    const element = await mount(`<mndw-field label="Interface"><${SLOT_TAG}></${SLOT_TAG}></mndw-field>`);
    const control = element.querySelector(SLOT_TAG);

    expect(labelNode(element).hidden).toBe(false);
    expect(labelNode(element).htmlFor).toBe(control?.id);
    expect(control?.hasAttribute('aria-labelledby')).toBe(false);
  });

  it('falls back to aria-labelledby for a control that is not labelable', async () => {
    const element = await mount(`<mndw-field label="Group"><${PLAIN_TAG}></${PLAIN_TAG}></mndw-field>`);
    const control = element.querySelector(PLAIN_TAG);

    expect(labelNode(element).hasAttribute('for')).toBe(false);
    expect(control?.getAttribute('aria-labelledby')).toBe(labelNode(element).id);
  });

  it('renders no label when the control carries its own aria-label', async () => {
    const element = await mount('<mndw-field label="Host"><input aria-label="Host name" /></mndw-field>');

    expect(labelNode(element).hidden).toBe(true);
    expect(labelNode(element).hasAttribute('for')).toBe(false);
  });

  it('renders no label when a consumer aria-labelledby names the control', async () => {
    const element = await mount(
      '<mndw-field label="Host"><input aria-labelledby="outside" /></mndw-field><span id="outside">Outside</span>',
    );

    expect(labelNode(element).hidden).toBe(true);
  });

  it('ignores aria-labelledby tokens that do not resolve to a node', async () => {
    const element = await mount('<mndw-field label="Host"><input aria-labelledby="outside" /></mndw-field>');

    expect(labelNode(element).hidden).toBe(false);

    const outside = document.createElement('span');

    outside.id = 'outside';
    outside.textContent = 'Outside';
    document.body.appendChild(outside);
    await settle(element);

    expect(labelNode(element).hidden).toBe(true);

    outside.remove();
    await settle(element);

    expect(labelNode(element).hidden).toBe(false);
  });

  it('ignores its own label node when reading aria-labelledby', async () => {
    const element = await mount(`<mndw-field label="Group"><${PLAIN_TAG}></${PLAIN_TAG}></mndw-field>`);

    element.hint = 'Rewire';
    await settle(element);

    expect(labelNode(element).hidden).toBe(false);
  });
});

describe('<mndw-field> external label detection', () => {
  it('renders no label when a consumer label already targets the control', async () => {
    const element = await mount(
      '<label for="host" id="consumer-label">Consumer name</label>'
        + '<mndw-field label="Host"><input id="host" /></mndw-field>',
    );

    expect(labelNode(element).hidden).toBe(true);
  });

  it('renders its label again when the consumer label is removed', async () => {
    const element = await mount(
      '<label for="host" id="consumer-label">Consumer name</label>'
        + '<mndw-field label="Host"><input id="host" /></mndw-field>',
    );

    document.getElementById('consumer-label')?.remove();
    await settle(element);

    expect(labelNode(element).hidden).toBe(false);
    expect(labelNode(element).htmlFor).toBe('host');
  });

  it('suppresses its label when a consumer label is inserted after mount', async () => {
    const element = await mount('<mndw-field label="Host"><input id="host" /></mndw-field>');

    expect(labelNode(element).hidden).toBe(false);

    const consumerLabel = document.createElement('label');

    consumerLabel.htmlFor = 'host';
    consumerLabel.textContent = 'Consumer name';
    document.body.insertBefore(consumerLabel, element);
    await settle(element);

    expect(labelNode(element).hidden).toBe(true);
  });

  it('reacts to a consumer label repointing at another control', async () => {
    const element = await mount(
      '<label for="host" id="consumer-label">Consumer name</label>'
        + '<mndw-field label="Host"><input id="host" /></mndw-field><input id="other" />',
    );

    const consumerLabel = document.getElementById('consumer-label') as HTMLLabelElement;

    consumerLabel.htmlFor = 'other';
    await settle(element);

    expect(labelNode(element).hidden).toBe(false);
  });

  it('renders no label when a slot-source control carries its own content', async () => {
    const element = await mount(`<mndw-field label="Telemetry"><${SLOT_TAG}>Telemetry</${SLOT_TAG}></mndw-field>`);

    expect(labelNode(element).hidden).toBe(true);
  });

  it('labels a slot-source control whose content is whitespace only', async () => {
    const element = await mount(`<mndw-field label="Telemetry"><${SLOT_TAG}>   </${SLOT_TAG}></mndw-field>`);

    expect(labelNode(element).hidden).toBe(false);
  });

  it('renders no label when a label-property control declares its own label', async () => {
    const element = await mount(
      `<mndw-field label="Interface"><${LABEL_PROPERTY_TAG}></${LABEL_PROPERTY_TAG}></mndw-field>`,
    );
    const control = element.querySelector<LabelPropertyControl>(LABEL_PROPERTY_TAG);

    expect(labelNode(element).hidden).toBe(false);

    if (!control) {
      throw new Error('missing control');
    }

    control.label = 'Interface';
    control.dispatchEvent(new Event(MNDW_LABEL_CHANGE_EVENT, {bubbles: true, composed: true}));
    await settle(element);

    expect(labelNode(element).hidden).toBe(true);
  });
});

describe('<mndw-field> descriptions and state', () => {
  it('describes the control with hint and error ids', async () => {
    const element = await mount('<mndw-field label="Host" hint="Hint text"><input /></mndw-field>');
    const control = element.querySelector('input');

    if (!control) {
      throw new Error('missing control');
    }

    expect(describedBy(control)).toEqual([hintNode(element).id]);

    element.error = 'Too long';
    await settle(element);

    expect(describedBy(control)).toEqual([hintNode(element).id, errorNode(element).id]);
  });

  it('preserves consumer aria-describedby tokens and removes only its own', async () => {
    const element = await mount(
      '<mndw-field label="Host" hint="Hint"><input aria-describedby="consumer-note" /></mndw-field>',
    );
    const control = element.querySelector('input');

    if (!control) {
      throw new Error('missing control');
    }

    expect(describedBy(control)).toEqual(['consumer-note', hintNode(element).id]);

    element.hint = '';
    await settle(element);

    expect(describedBy(control)).toEqual(['consumer-note']);
  });

  it('removes aria-describedby entirely when only its own tokens were present', async () => {
    const element = await mount('<mndw-field label="Host" hint="Hint"><input /></mndw-field>');
    const control = element.querySelector('input');

    element.hint = '';
    await settle(element);

    expect(control?.hasAttribute('aria-describedby')).toBe(false);
  });
});

describe('<mndw-field> invalid and required state', () => {
  it('marks the control invalid while an error is present and restores the prior value', async () => {
    const element = await mount('<mndw-field label="Host"><input aria-invalid="false" /></mndw-field>');
    const control = element.querySelector('input');

    element.error = 'Required';
    await settle(element);

    expect(control?.getAttribute('aria-invalid')).toBe('true');

    element.error = '';
    await settle(element);

    expect(control?.getAttribute('aria-invalid')).toBe('false');
  });

  it('mirrors required onto the control and draws a hidden-from-name marker', async () => {
    const element = await mount('<mndw-field label="Host" required><input /></mndw-field>');
    const control = element.querySelector('input');
    const marker = labelNode(element).querySelector('[aria-hidden="true"]');

    expect(control?.hasAttribute('required')).toBe(true);
    expect(marker).not.toBeNull();
    expect((marker as HTMLElement).hidden).toBe(false);

    element.required = false;
    await settle(element);

    expect(control?.hasAttribute('required')).toBe(false);
    expect((marker as HTMLElement).hidden).toBe(true);
  });
});

describe('<mndw-field> ownership cleanup', () => {
  it('ignores owned-node mutations from another field', async () => {
    document.body.innerHTML = '<mndw-field id="first" label="First" hint="Hint"><input /></mndw-field>'
      + '<mndw-field id="second" label="Second" hint="Hint"><input /></mndw-field>';

    const first = document.querySelector<MndwField>('#first');
    const second = document.querySelector<MndwField>('#second');

    if (!first || !second) {
      throw new Error('missing field');
    }

    await settle(first);
    await settle(second);

    const secondRequestUpdate = vi.spyOn(second, 'requestUpdate');

    first.hint = 'Updated hint';
    await settle(first);
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(secondRequestUpdate).not.toHaveBeenCalled();
  });

  it('cleans the outgoing control when the control is replaced', async () => {
    const element = await mount('<mndw-field label="Host" hint="Hint" error="Broken"><input /></mndw-field>');
    const outgoing = element.querySelector('input');

    if (!outgoing) {
      throw new Error('missing control');
    }

    const generatedId = outgoing.id;
    const incoming = document.createElement('input');

    element.replaceChild(incoming, outgoing);
    await settle(element);

    expect(outgoing.hasAttribute('aria-describedby')).toBe(false);
    expect(outgoing.hasAttribute('aria-invalid')).toBe(false);
    expect(outgoing.id).toBe('');
    expect(incoming.id).toBe(generatedId);
    expect(describedBy(incoming)).toEqual([hintNode(element).id, errorNode(element).id]);
  });

  it('removes only the attributes it wrote when disconnected', async () => {
    const element = await mount(
      '<mndw-field label="Host" hint="Hint" error="Broken" required>'
        + '<input id="kept" aria-describedby="consumer-note" /></mndw-field>',
    );
    const control = element.querySelector('input');

    if (!control) {
      throw new Error('missing control');
    }

    element.remove();
    await settle(element);

    expect(control.id).toBe('kept');
    expect(describedBy(control)).toEqual(['consumer-note']);
    expect(control.hasAttribute('aria-invalid')).toBe(false);
    expect(control.hasAttribute('required')).toBe(false);
  });
});
