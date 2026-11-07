// @vitest-environment happy-dom
import {describe, expect, it, vi} from 'vitest';
import {defineComponents, mount} from '../testing/index.js';
import {MNDW_SEGMENT_CHANGE_EVENT, MNDW_SEGMENT_TAG, MndwSegment} from './segment.js';

defineComponents([MNDW_SEGMENT_TAG, MndwSegment]);

describe('<mndw-segment>', () => {
  it('applies the documented defaults', async () => {
    const element = await mount('<mndw-segment></mndw-segment>', MNDW_SEGMENT_TAG);

    expect(element.value).toBe('');
    expect(element.disabled).toBe(false);
  });

  it('reflects value and disabled as configuration', async () => {
    const element = await mount('<mndw-segment value="day"></mndw-segment>', MNDW_SEGMENT_TAG);

    expect(element.value).toBe('day');

    element.value = 'week';
    element.disabled = true;
    await element.updateComplete;

    expect(element.getAttribute('value')).toBe('week');
    expect(element.hasAttribute('disabled')).toBe(true);
  });

  it('renders slotted content inside its segment part', async () => {
    const element = await mount('<mndw-segment value="day">Day</mndw-segment>', MNDW_SEGMENT_TAG);
    const root = element.shadowRoot;

    expect(root?.querySelector('[part="segment"]')).not.toBeNull();
    expect(root?.querySelector('[part="segment"] slot')).not.toBeNull();
    expect(element.textContent).toBe('Day');
  });

  it('keeps no interactive descendant inside the shadow root', async () => {
    const element = await mount('<mndw-segment value="day">Day</mndw-segment>', MNDW_SEGMENT_TAG);

    expect(element.shadowRoot?.querySelector('button, input, a, [tabindex]')).toBeNull();
  });

  it('uses the validated accent pair for selected segments and an accent hover', () => {
    const cssText = String(MndwSegment.styles);

    expect(cssText).toMatch(
      /:host\(\[aria-checked='true'\]\)\s+\[part='segment'\]\s*\{[^}]*background:\s*var\(--mndw-accent\);[^}]*color:\s*var\(--mndw-accent-contrast\);/u,
    );
    expect(cssText).toContain(
      ':host([aria-checked=\'true\']:not([disabled]):not([aria-disabled=\'true\']):hover) [part=\'segment\']',
    );
    expect(cssText).toMatch(/:host\(\[aria-checked='true'[^\n]*\n[^}]*background:\s*var\(--mndw-accent-hover\);/u);
    expect(cssText).toContain(
      ':host([aria-checked=\'false\']:not([disabled]):not([aria-disabled=\'true\']):hover) [part=\'segment\']',
    );
    expect(cssText).toContain('var(--mndw-control-hover)');
  });

  it('announces configuration changes so its group can rewire', async () => {
    const element = await mount('<mndw-segment value="day">Day</mndw-segment>', MNDW_SEGMENT_TAG);
    const announced = vi.fn();

    element.addEventListener(MNDW_SEGMENT_CHANGE_EVENT, announced);

    element.value = 'week';
    await element.updateComplete;

    expect(announced).toHaveBeenCalledTimes(1);

    element.disabled = true;
    await element.updateComplete;

    expect(announced).toHaveBeenCalledTimes(2);
    expect((announced.mock.calls[0][0] as Event).bubbles).toBe(true);
  });

  it('does not announce its first render', async () => {
    document.body.innerHTML = '<div id="host"></div>';

    const parent = document.getElementById('host');
    const announced = vi.fn();

    parent?.addEventListener(MNDW_SEGMENT_CHANGE_EVENT, announced);

    const element = document.createElement(MNDW_SEGMENT_TAG);

    element.setAttribute('value', 'day');
    parent?.appendChild(element);
    await element.updateComplete;

    expect(announced).not.toHaveBeenCalled();
  });
});
