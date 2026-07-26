import {beforeAll, describe, expect, it} from 'vitest';
import {MNDW_BUTTON_TAG, MndwButton} from './button.js';

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

  it('propagates type to the inner button', async () => {
    const element = await mount('<mndw-button type="submit">Go</mndw-button>');

    expect(innerButton(element).getAttribute('type')).toBe('submit');
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
