// @vitest-environment happy-dom
import {afterEach, describe, expect, it} from 'vitest';
import {createGeneratedAttribute, createLocalizedProperty} from './localized-property.js';

class LocalizedProbe extends HTMLElement {
  private currentLabel: string | undefined;

  public get label(): string | undefined {
    return this.currentLabel;
  }

  public set label(value: string | undefined) {
    this.currentLabel = value;
  }
}

const TAG = 'mndw-localized-probe';

if (!customElements.get(TAG)) {
  customElements.define(TAG, LocalizedProbe);
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('localized property tracking', () => {
  it('captures initial attributes and preserves later authored properties', () => {
    const element = document.createElement(TAG) as LocalizedProbe;

    element.setAttribute('label', 'Authored attribute');

    const state = createLocalizedProperty<string | undefined>(element, 'label');

    state.setGenerated('English default');
    expect(element.getAttribute('label')).toBe('Authored attribute');

    element.label = 'Authored property';
    state.setGenerated('Russian default');
    expect(element.label).toBe('Authored property');
  });

  it('tracks external attribute writes after connection', () => {
    const element = document.createElement(TAG) as LocalizedProbe;
    const state = createLocalizedProperty<string | undefined>(element, 'label');

    state.setGenerated('English default');
    element.setAttribute('label', 'Late authored attribute');
    state.setGenerated('Russian default');

    expect(element.getAttribute('label')).toBe('Late authored attribute');
  });

  it('keeps generated ARIA writes separate from authored values', () => {
    const element = document.createElement(TAG) as LocalizedProbe;
    const state = createGeneratedAttribute(element, 'aria-label');

    state.setGenerated('Generated English');
    state.setGenerated('Generated Russian');
    expect(element.getAttribute('aria-label')).toBe('Generated Russian');

    element.setAttribute('aria-label', 'Authored label');
    state.setGenerated('Generated next locale');
    expect(element.getAttribute('aria-label')).toBe('Authored label');
  });
});
