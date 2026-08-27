import {appState} from '../state/app.svelte.js';
import {hostT as translateHost} from './locale.service.js';

export function hostT(key: string, values?: Record<string, unknown>): string {
  return translateHost(key, values, appState.locale);
}
