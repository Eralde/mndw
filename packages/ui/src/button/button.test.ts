import {beforeAll, describe, expect, it} from 'vitest';
import {MNDW_BUTTON_TAG, MndwButton, type MndwButtonVariant} from './button.js';

beforeAll(() => {
  if (!customElements.get(MNDW_BUTTON_TAG)) {
    customElements.define(MNDW_BUTTON_TAG, MndwButton);
  }
});

async function mount(html: string): Promise<MndwButton> {
  document.body.innerHTML = html;

  const element = document.body.firstElementChild as MndwButton;

  await element.updateComplete;

  return element;
}

function innerButton(element: MndwButton): HTMLButtonElement {
  const found = element.shadowRoot?.querySelector('button');

  if (!found) {
    throw new Error('missing inner button');
  }

  return found;
}

describe('<mndw-button>', () => {
  it('defaults to the secondary variant', async () => {
    const element = await mount('<mndw-button>Cancel</mndw-button>');

    expect(element.variant).toBe('secondary');
    expect(element.getAttribute('variant')).toBe('secondary');
  });

  it('exposes the inner button as a part', async () => {
    const element = await mount('<mndw-button>Save</mndw-button>');

    expect(innerButton(element).getAttribute('part')).toBe('button');
  });

  it('reads variant from the attribute', async () => {
    const element = await mount('<mndw-button variant="ghost">Gear</mndw-button>');

    expect(element.variant).toBe('ghost');
  });

  it('disables the inner button and blocks pointer events', async () => {
    const element = await mount('<mndw-button disabled>Apply</mndw-button>');

    expect(innerButton(element).disabled).toBe(true);
    expect(element.hasAttribute('disabled')).toBe(true);
  });

  it('re-enables the inner button when host disabled state is cleared', async () => {
    const element = await mount('<mndw-button disabled>Apply</mndw-button>');

    element.disabled = false;
    await element.updateComplete;

    expect(element.disabled).toBe(false);
    expect(innerButton(element).disabled).toBe(false);
  });

  it('keeps the inner button presentational for every host type', async () => {
    const element = await mount('<mndw-button type="submit">Go</mndw-button>');

    expect(innerButton(element).getAttribute('type')).toBe('button');
  });

  it('is form-associated and accepts reset as a host type', async () => {
    const element = await mount('<mndw-button type="reset">Reset</mndw-button>');

    expect(MndwButton.formAssociated).toBe(true);
    expect(element.type).toBe('reset');
  });

  it('lets native clicks bubble out of the shadow root', async () => {
    const element = await mount('<mndw-button>Retry</mndw-button>');
    let seen = 0;

    document.body.addEventListener('click', () => {
      seen += 1;
    });
    innerButton(element).click();

    expect(seen).toBe(1);
  });

  it('lets the consumer resize it from outside', async () => {
    // Typography is `inherit` on the inner button and tokenised on :host, so an ordinary
    // font-size on the element wins. Both plugins' gear buttons rely on this — a declaration
    // on the inner element would beat any external rule and there would be no way to make an
    // icon button larger without reaching through ::part().
    const element = await mount('<mndw-button variant="ghost">&#9881;</mndw-button>');

    element.style.fontSize = '18px';

    expect(getComputedStyle(element).fontSize).toBe('18px');
    expect(MndwButton.styles.cssText).toContain('font-size: inherit');
  });
});

/** The variant selector carries single quotes of its own, hence the template literal. */
function variantRule(variant: MndwButtonVariant, state = ''): string {
  return `:host([variant='${variant}']) button${state}`;
}

describe('<mndw-button> danger variant', () => {
  it('accepts danger as a fourth variant', () => {
    const variants: MndwButtonVariant[] = ['primary', 'secondary', 'ghost', 'danger'];

    expect(variants).toHaveLength(4);
  });

  it('reflects danger the way the shipped variants do', async () => {
    const element = await mount('<mndw-button variant="danger">Delete</mndw-button>');

    expect(element.variant).toBe('danger');
    expect(element.getAttribute('variant')).toBe('danger');

    element.variant = 'secondary';
    await element.updateComplete;

    expect(element.getAttribute('variant')).toBe('secondary');
  });

  it('leaves the default and the shipped variants untouched', async () => {
    const element = await mount('<mndw-button>Cancel</mndw-button>');
    const {cssText} = MndwButton.styles;

    expect(element.variant).toBe('secondary');
    expect(cssText).toContain(variantRule('primary'));
    expect(cssText).toContain(variantRule('secondary'));
    expect(cssText).toContain(variantRule('ghost'));
  });

  it('keeps the inner button native under the danger variant', async () => {
    const element = await mount('<mndw-button variant="danger">Delete</mndw-button>');
    const inner = innerButton(element);
    let seen = 0;

    expect(MndwButton.shadowRootOptions.delegatesFocus).toBe(true);
    expect(inner.localName).toBe('button');
    expect(inner.getAttribute('type')).toBe('button');
    expect(inner.disabled).toBe(false);

    document.body.addEventListener('click', () => {
      seen += 1;
    });
    inner.click();

    expect(seen).toBe(1);
  });

  it('still gates activation while a danger button is disabled', async () => {
    const element = await mount('<mndw-button variant="danger" disabled>Delete</mndw-button>');

    expect(innerButton(element).disabled).toBe(true);
  });

  it('tints danger from the emitted tokens rather than filling it solid', () => {
    const {cssText} = MndwButton.styles;

    expect(cssText).toContain(variantRule('danger'));
    expect(cssText).toContain(variantRule('danger', ':hover'));
    expect(cssText).toContain('var(--mndw-danger-bg)');
    expect(cssText).toContain('var(--mndw-danger)');
    // The palette models `danger` as a foreground and emits no contrast pair for it, so a solid
    // danger fill would be an unvalidated colour combination.
    expect(cssText).not.toContain('--mndw-danger-contrast');
  });
});
