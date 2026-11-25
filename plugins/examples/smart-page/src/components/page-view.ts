/** Which part of the page the narrow layout shows; the wide layout shows both and ignores this. */
export type PageViewName = 'list' | 'details';

/** The user's last explicit choice; null until they open a card or go back. */
export type PageViewChoice = PageViewName | null;

export interface PageViewInput {
  choice: PageViewChoice;
  deviceCount: number;
  /** The selected drive is in the snapshot, so there is something to show in the details view. */
  hasSelectedDevice: boolean;
}

/** A single drive opens its details directly; an explicit choice, including "back", wins afterwards. */
export function effectiveView({choice, deviceCount, hasSelectedDevice}: PageViewInput): PageViewName {
  if (!hasSelectedDevice) { return 'list'; }

  return choice ?? (deviceCount === 1 ? 'details' : 'list');
}
