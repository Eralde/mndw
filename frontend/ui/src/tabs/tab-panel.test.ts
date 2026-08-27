import {describe, expect, it} from 'vitest';
import {defineComponents, mount} from '../testing/index.js';
import {MNDW_TAB_PANEL_TAG, MndwTabPanel} from './tab-panel.js';

defineComponents([MNDW_TAB_PANEL_TAG, MndwTabPanel]);

describe('<mndw-tab-panel>', () => {
  it('reads and reflects the tab it points at', async () => {
    const element = await mount('<mndw-tab-panel for="general">Body</mndw-tab-panel>', MNDW_TAB_PANEL_TAG);

    expect(element.for).toBe('general');

    element.for = 'network';
    await element.updateComplete;

    expect(element.getAttribute('for')).toBe('network');
  });

  it('generates a stable id when the consumer supplies none', async () => {
    const element = await mount('<mndw-tab-panel for="general">Body</mndw-tab-panel>', MNDW_TAB_PANEL_TAG);
    const generated = element.id;

    expect(generated).toMatch(/^mndw-tab-panel-\d+$/u);

    element.for = 'network';
    await element.updateComplete;

    expect(element.id).toBe(generated);
  });

  it('keeps a consumer id', async () => {
    const element = await mount('<mndw-tab-panel id="mine" for="general">Body</mndw-tab-panel>', MNDW_TAB_PANEL_TAG);

    expect(element.id).toBe('mine');
  });

  it('gives consecutive panels distinct ids', async () => {
    document.body.innerHTML = `
      <mndw-tab-panel for="a">A</mndw-tab-panel>
      <mndw-tab-panel for="b">B</mndw-tab-panel>
    `;

    const panels = [...document.body.querySelectorAll<MndwTabPanel>(MNDW_TAB_PANEL_TAG)];

    await Promise.all(panels.map(async (panel) => panel.updateComplete));

    expect(panels[0].id).not.toBe(panels[1].id);
  });

  it('exposes the panel part and slots its content', async () => {
    const element = await mount('<mndw-tab-panel for="general">Body</mndw-tab-panel>', MNDW_TAB_PANEL_TAG);
    const part = element.shadowRoot?.querySelector('[part="panel"]');

    expect(part).not.toBeNull();
    expect(part?.querySelector('slot')).not.toBeNull();
  });

  it('carries no semantics of its own — the group writes them', async () => {
    const element = await mount('<mndw-tab-panel for="general">Body</mndw-tab-panel>', MNDW_TAB_PANEL_TAG);

    expect(element.hasAttribute('role')).toBe(false);
    expect(element.hasAttribute('aria-labelledby')).toBe(false);
  });

  it('collapses out of flow while hidden', async () => {
    const element = await mount('<mndw-tab-panel for="general">Body</mndw-tab-panel>', MNDW_TAB_PANEL_TAG);

    expect(MndwTabPanel.styles.cssText).toContain(':host([hidden])');
    expect(element.hidden).toBe(false);
  });

  it('insets panel content with small uniform padding', () => {
    expect(MndwTabPanel.styles.cssText).toMatch(/padding:\s*var\(--mndw-space-3\);/u);
    expect(MndwTabPanel.styles.cssText).not.toContain('padding: var(--mndw-space-3) 0;');
  });
});
