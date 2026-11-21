// @vitest-environment happy-dom
import {describe, expect, it} from 'vitest';
import {defineComponents, mount} from '../testing/index.js';
import {MNDW_RADIO_TAG, MndwRadio} from './radio.js';

defineComponents([MNDW_RADIO_TAG, MndwRadio]);

describe('<mndw-radio>', () => {
  it('applies the documented defaults', async () => {
    const element = await mount('<mndw-radio>Day</mndw-radio>', MNDW_RADIO_TAG);

    expect(element.value).toBe('');
    expect(element.disabled).toBe(false);
    expect(element.getAttribute('role')).toBeNull();
    expect(element.getAttribute('tabindex')).toBeNull();
  });

  it('reflects value and disabled', async () => {
    const element = await mount('<mndw-radio value="day">Day</mndw-radio>', MNDW_RADIO_TAG);

    expect(element.getAttribute('value')).toBe('day');

    element.value = 'week';
    element.disabled = true;
    await element.updateComplete;

    expect(element.getAttribute('value')).toBe('week');
    expect(element.hasAttribute('disabled')).toBe(true);
  });

  it('exposes the circle, dot, and label parts', async () => {
    const element = await mount('<mndw-radio value="day">Day</mndw-radio>', MNDW_RADIO_TAG);
    const circle = element.shadowRoot?.querySelector('[part="circle"]');

    expect(circle).not.toBeNull();
    expect(circle?.getAttribute('aria-hidden')).toBe('true');
    expect(element.shadowRoot?.querySelector('[part="dot"]')).not.toBeNull();
    expect(element.shadowRoot?.querySelector('slot[part="label"]')).not.toBeNull();
  });

  it('reveals the filled dot from the group-written aria-checked', () => {
    const cssText = MndwRadio.styles.cssText;

    expect(cssText).toMatch(/\[part='dot'\]\s*\{[^}]*visibility: hidden;/);
    expect(cssText).toContain(':host([aria-checked=\'true\']) [part=\'dot\']');
    expect(cssText).toMatch(
      /:host\(\[aria-checked='true'\]\)\s+\[part='circle'\]\s*\{[^}]*background: var\(--mndw-accent\);/,
    );
    expect(cssText).toContain('width: var(--_mndw-radio-indicator-size, 1.125rem)');
  });

  it('uses the checkbox disabled look for its own and group-written disabled state', () => {
    const cssText = MndwRadio.styles.cssText;

    expect(cssText).toContain(':host([disabled]),');
    expect(cssText).toContain(':host([aria-disabled=\'true\'])');
    expect(cssText).toContain('pointer-events: none');
    expect(cssText).toMatch(/:host\(\[disabled\]\)\s*\{[^}]*color: var\(--mndw-text-muted\);[^}]*opacity: 0.65;/);
  });
});
