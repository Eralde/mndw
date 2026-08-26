import {defineMndwUi, setMndwUiLocale} from '../index.js';
import {setOverlayProvider} from '../overlay.js';

// This module statically imports UI components and is intended for DOM-capable
// consumers. The side-effecting ./setup module is DOM-less-safe because it
// guards its dynamic import. Once this module is loaded, the custom-elements
// guard makes repeated registration safe.
export function defineMndwTestComponents(): void {
  if (typeof customElements === 'undefined') {
    return;
  }

  defineMndwUi();
}

export function resetUiTestState(): void {
  setMndwUiLocale('en');
  setOverlayProvider(undefined);
  document.body.innerHTML = '';
}
