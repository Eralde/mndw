import {appState} from '../state/app.svelte.js';
import {translateHostMessage} from './locale.service.svelte.js';

export function hostT(key: string, values?: Record<string, unknown>): string {
  return translateHostMessage(key, values, appState.locale);
}
