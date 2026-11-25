import type {BackendAvailability} from '../services/page-controller';

const STATUS_KEYS: Record<Exclude<BackendAvailability, 'available'>, string> = {
  'unknown': 'backend.checking',
  'unknown-id': 'backend.unknown-id',
  'not-approved': 'backend.not-approved',
  'disabled': 'backend.disabled',
  'starting': 'backend.starting',
  'unavailable': 'backend.unavailable',
  'incompatible': 'backend.incompatible',
};

/** The status line's text; null when the backend works, because the plain state says nothing the page does not show. */
export function backendStatusKey(availability: BackendAvailability): string | null {
  return availability === 'available' ? null : STATUS_KEYS[availability];
}

/** States that do not recover by retrying, so actions that need the backend stay disabled. */
export function isTerminalBackend(availability: BackendAvailability): boolean {
  return availability === 'unknown-id' || availability === 'not-approved' || availability === 'disabled'
    || availability === 'incompatible';
}
