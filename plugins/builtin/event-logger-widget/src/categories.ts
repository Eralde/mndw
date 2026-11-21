import type {EventTopic} from '@mndw/sdk';

export const EVENT_CATEGORIES = ['all', 'internet', 'wifi', 'storage', 'router', 'mndw'] as const;

export type EventCategory = (typeof EVENT_CATEGORIES)[number];

/**
 * Exhaustive by construction: adding a topic to the SDK schema fails type-checking until it is placed in a category.
 * An unknown runtime topic (a newer daemon) is intentionally missing from this map.
 */
const CATEGORY_BY_TOPIC: Readonly<Record<EventTopic, EventCategory>> = {
  'wan.connected': 'internet',
  'wan.disconnected': 'internet',
  'net.ip_changed': 'internet',
  'net.dhcp_lease': 'internet',
  'net.dns_changed': 'internet',
  'wifi.client_join': 'wifi',
  'wifi.client_leave': 'wifi',
  'firewall.rebuilt': 'router',
  'usb.attached': 'storage',
  'usb.detached': 'storage',
  'fs.mounted': 'storage',
  'fs.unmounted': 'storage',
  'clock.synced': 'router',
  'schedule.fired': 'router',
  'button.pressed': 'router',
  'auth.login': 'router',
  'firmware.available': 'router',
  'plugin.installed': 'mndw',
  'plugin.removed': 'mndw',
  'plugin.approved': 'mndw',
  'plugin.started': 'mndw',
  'plugin.stopped': 'mndw',
  'daemon.started': 'mndw',
  'daemon.stopping': 'mndw',
  'daemon.updated': 'mndw',
  'storage.low': 'storage',
  'telemetry.gathering_changed': 'mndw',
};

export function isEventCategory(value: string | null | undefined): value is EventCategory {
  return typeof value === 'string' && (EVENT_CATEGORIES as readonly string[]).includes(value);
}

/** Returns null when this build does not know the topic; such rows appear only under All. */
export function categoryForTopic(topic: string): EventCategory | null {
  const categories = CATEGORY_BY_TOPIC as Readonly<Record<string, EventCategory | undefined>>;

  return categories[topic] ?? null;
}

export function matchesCategory(topic: string, category: EventCategory): boolean {
  return category === 'all' || categoryForTopic(topic) === category;
}
