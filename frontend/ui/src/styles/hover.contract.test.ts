// @vitest-environment happy-dom
import {describe, expect, it} from 'vitest';
import {MndwButton} from '../button/button.js';
import {MndwCheckbox} from '../checkbox/checkbox.js';
import {MndwInput} from '../input/input.js';
import {MndwScrollArea} from '../scroll-area/scroll-area.js';
import {MndwSelect} from '../select/select.js';
import {MndwSelectPanel} from '../select/select-panel.js';
import {MndwSegment} from '../segmented/segment.js';
import {MndwSlider} from '../slider/slider.js';
import {MndwSwitch} from '../switch/switch.js';
import {MndwTab} from '../tabs/tab.js';
import {MndwTable} from '../table/table.js';
import {MndwColumnMenu} from '../table/column-menu.js';
import {MndwTextarea} from '../textarea/textarea.js';
import {accentHover, controlHover, fieldHover, surfaceHover, textHover} from './base.js';

function stylesText(styles: unknown): string {
  if (Array.isArray(styles)) {
    return styles.map(stylesText).join('\n');
  }

  return String(styles);
}

const hoverRules = [
  {element: 'primary button', part: 'button', styles: MndwButton.styles,
    selector: ':host([variant=\'primary\']) button:not(:disabled):hover', token: '--mndw-accent-hover', guarded: true},
  {element: 'secondary button', part: 'button', styles: MndwButton.styles,
    selector: ':host([variant=\'secondary\']) button:not(:disabled):hover', token: '--mndw-surface-hover',
    guarded: true},
  {element: 'ghost button', part: 'button', styles: MndwButton.styles,
    selector: ':host([variant=\'ghost\']) button:not(:disabled):hover', token: '--mndw-control-hover', guarded: true},
  {element: 'danger button', part: 'button', styles: MndwButton.styles,
    selector: ':host([variant=\'danger\']) button:not(:disabled):hover', token: '--mndw-danger', guarded: true},
  {element: 'input', part: 'field', styles: MndwInput.styles,
    selector:
      ':host(:not([disabled]):not([readonly]):not([invalid]):not([aria-invalid=\'true\'])) [part=\'field\']:hover',
    token: '--mndw-text-subtle', guarded: true},
  {element: 'password input toggle', part: 'password-toggle', styles: MndwInput.styles,
    selector:
      ':host(:not([disabled]):not([readonly]):not([invalid]):not([aria-invalid=\'true\'])) [part=\'password-toggle\']:hover',
    token: '--mndw-text', guarded: true},
  {element: 'textarea', part: 'field', styles: MndwTextarea.styles,
    selector:
      ':host(:not([disabled]):not([readonly]):not([invalid]):not([aria-invalid=\'true\'])) [part=\'field\']:hover',
    token: '--mndw-text-subtle', guarded: true},
  {element: 'select trigger', part: 'trigger', styles: MndwSelect.styles,
    selector: ':host(:not([disabled]):not([invalid]):not([aria-invalid=\'true\'])) [part=\'trigger\']:hover',
    token: '--mndw-text-subtle', guarded: true},
  {element: 'select option', part: 'option', styles: MndwSelectPanel.styles,
    selector: '.option:not([aria-disabled=\'true\']):hover', token: '--mndw-surface-hover', guarded: true},
  {element: 'checkbox box', part: 'box', styles: MndwCheckbox.styles,
    selector:
      ':host(:not([disabled]):not([aria-disabled=\'true\']):not([invalid]):not([aria-invalid=\'true\']):hover) [part=\'box\']',
    token: '--mndw-surface-hover', guarded: true},
  {
    element: 'checked checkbox box',
    part: 'box',
    styles: MndwCheckbox.styles,
    selector:
      ':host([checked]:not([disabled]):not([aria-disabled=\'true\']):not([invalid]):not([aria-invalid=\'true\']):hover) [part=\'box\']',
    token: '--mndw-accent-hover',
    guarded: true,
  },
  {element: 'switch track', part: 'track', styles: MndwSwitch.styles,
    selector:
      ':host(:not([disabled]):not([aria-disabled=\'true\']):not([invalid]):not([aria-invalid=\'true\']):hover) [part=\'track\']',
    token: '--mndw-surface-hover', guarded: true},
  {
    element: 'checked switch track',
    part: 'track',
    styles: MndwSwitch.styles,
    selector:
      ':host([checked]:not([disabled]):not([aria-disabled=\'true\']):not([invalid]):not([aria-invalid=\'true\']):hover) [part=\'track\']',
    token: '--mndw-accent-hover',
    guarded: true,
  },
  {element: 'slider track', part: 'track', styles: MndwSlider.styles,
    selector:
      ':host(:not([disabled]):not([aria-disabled=\'true\']):not([invalid]):not([aria-invalid=\'true\'])) [part=\'track\']:hover',
    token: '--mndw-surface-hover', guarded: true},
  {element: 'slider thumb', part: 'thumb', styles: MndwSlider.styles,
    selector:
      ':host(:not([disabled]):not([aria-disabled=\'true\']):not([invalid]):not([aria-invalid=\'true\'])) [part=\'thumb\']:hover',
    token: '--mndw-accent-hover', guarded: true},
  {element: 'unselected segment', part: 'segment', styles: MndwSegment.styles,
    selector: ':host([aria-checked=\'false\']:not([disabled]):not([aria-disabled=\'true\']):hover) [part=\'segment\']',
    token: '--mndw-control-hover', guarded: true},
  {element: 'selected segment', part: 'segment', styles: MndwSegment.styles,
    selector: ':host([aria-checked=\'true\']:not([disabled]):not([aria-disabled=\'true\']):hover) [part=\'segment\']',
    token: '--mndw-accent-hover', guarded: true},
  {element: 'tab', part: 'tab', styles: MndwTab.styles,
    selector: ':host(:not([disabled]):not([aria-disabled=\'true\']):hover) [part=\'tab\']',
    token: '--mndw-control-hover', guarded: true},
  {element: 'column menu option', part: 'option', styles: MndwColumnMenu.styles, selector: '[part=\'option\']:hover',
    token: '--mndw-surface-hover', guarded: false},
  {element: 'table row', part: 'cell', styles: MndwTable.styles, selector: '[part=\'row\']:hover [part~=\'cell\']',
    token: '--mndw-surface-hover', guarded: false},
  {element: 'scroll-area thumb', part: 'thumb', styles: MndwScrollArea.styles, selector: '.thumb:hover',
    token: '--mndw-scrollbar-thumb-hover', guarded: false},
] as const;

describe('interactive hover contract', () => {
  it.each(hoverRules)('$element $part has a token-backed hover rule', ({styles, selector, token, guarded}) => {
    const css = stylesText(styles);
    const start = css.indexOf(selector);

    expect(start, selector).toBeGreaterThanOrEqual(0);

    const open = css.indexOf('{', start);
    const close = css.indexOf('}', open);
    const body = css.slice(open + 1, close);

    expect(selector).toContain(':hover');
    expect(selector.split(/\s/u, 1)[0]).not.toMatch(/^:host.*:hover$/u);
    expect(body).toContain(token);

    if (guarded) {
      expect(selector).toMatch(
        /:not\(\[(?:disabled|readonly|invalid|aria-disabled='true'|aria-invalid='true')\]\)|:not\(:disabled\)/u,
      );
    }
  });

  it('keeps shared field, surface, accent, and text hover declarations on existing tokens', () => {
    expect(String(fieldHover)).toContain('var(--mndw-text-subtle)');
    expect(String(surfaceHover)).toContain('var(--mndw-surface-hover)');
    expect(String(controlHover)).toContain('var(--mndw-control-hover)');
    expect(String(accentHover)).toContain('var(--mndw-accent-hover)');
    expect(String(textHover)).toContain('var(--mndw-text)');
  });
});
