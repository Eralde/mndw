import type {OverlayService} from '@mndw/sdk';
import {MNDW_BUTTON_TAG, MndwButton} from './button/button.js';
import {MNDW_CHECKBOX_TAG, MndwCheckbox} from './checkbox/checkbox.js';
import {adaptOverlayService} from './overlay-adapter.js';
import {setOverlayProvider} from './overlay.js';
import {MNDW_OPTION_TAG, MndwOption} from './select/option.js';
import {MNDW_SELECT_PANEL_TAG, MndwSelectPanel} from './select/select-panel.js';
import {MNDW_SELECT_TAG, MndwSelect} from './select/select.js';

export {MNDW_BUTTON_TAG, MndwButton} from './button/button.js';
export type {MndwButtonVariant} from './button/button.js';
export {MNDW_CHECKBOX_TAG, MndwCheckbox} from './checkbox/checkbox.js';
export type {MndwCheckboxChangeDetail} from './checkbox/checkbox.js';
export {MNDW_OPTION_TAG, MndwOption} from './select/option.js';
export {MNDW_SELECT_PANEL_TAG, MndwSelectPanel} from './select/select-panel.js';
export {MNDW_SELECT_TAG, MndwSelect} from './select/select.js';
export type {MndwSelectChangeDetail} from './select/select.js';
export {MNDW_OPTION_CHANGE_EVENT} from './select/option.js';
export type {UiCloseReason, UiLayer, UiLayerOptions, UiLayerPresentation, UiOverlayProvider} from './overlay.js';

export interface MndwUiDeps {
  overlay?: OverlayService;
}

const REGISTRY: [string, CustomElementConstructor][] = [
  [MNDW_BUTTON_TAG, MndwButton],
  [MNDW_CHECKBOX_TAG, MndwCheckbox],
  [MNDW_OPTION_TAG, MndwOption],
  [MNDW_SELECT_PANEL_TAG, MndwSelectPanel],
  [MNDW_SELECT_TAG, MndwSelect],
];

export function defineMndwUi(deps?: MndwUiDeps): void {
  if (deps?.overlay) {
    setOverlayProvider(adaptOverlayService(deps.overlay));
  }

  for (const [tag, constructor] of REGISTRY) {
    if (!customElements.get(tag)) {
      customElements.define(tag, constructor);
    }
  }
}
