import {describe, expect, it} from 'vitest';
import {EVENT_CATEGORIES, categoryForTopic, isEventCategory, matchesCategory} from './categories.js';

const EXPECTED_CATEGORIES = {
  'wan.connected': 'internet',
  'wan.disconnected': 'internet',
  'net.ip_changed': 'internet',
  'net.dhcp_lease': 'internet',
  'net.dns_changed': 'internet',
  'wifi.client_join': 'wifi',
  'wifi.client_leave': 'wifi',
  'usb.attached': 'storage',
  'usb.detached': 'storage',
  'fs.mounted': 'storage',
  'fs.unmounted': 'storage',
  'storage.low': 'storage',
  'clock.synced': 'router',
  'schedule.fired': 'router',
  'button.pressed': 'router',
  'auth.login': 'router',
  'firmware.available': 'router',
  'firewall.rebuilt': 'router',
  'plugin.installed': 'mndw',
  'plugin.removed': 'mndw',
  'plugin.approved': 'mndw',
  'plugin.started': 'mndw',
  'plugin.stopped': 'mndw',
  'daemon.started': 'mndw',
  'daemon.stopping': 'mndw',
  'daemon.updated': 'mndw',
  'telemetry.gathering_changed': 'mndw',
} as const;

describe('event categories', () => {
  it('maps every schema topic to its category', () => {
    for (const [topic, category] of Object.entries(EXPECTED_CATEGORIES)) {
      expect(categoryForTopic(topic), topic).toBe(category);
    }
  });

  it('matches only the chosen category, and always matches under All', () => {
    expect(matchesCategory('wan.connected', 'internet')).toBe(true);
    expect(matchesCategory('wan.connected', 'wifi')).toBe(false);
    expect(matchesCategory('wan.connected', 'all')).toBe(true);
  });

  it('shows unknown topics only under All', () => {
    expect(categoryForTopic('future.topic')).toBeNull();

    for (const category of EVENT_CATEGORIES) {
      expect(matchesCategory('future.topic', category), category).toBe(category === 'all');
    }
  });

  it('rejects stored values that are not categories', () => {
    expect(isEventCategory('wifi')).toBe(true);
    expect(isEventCategory('All')).toBe(false);
    expect(isEventCategory('future')).toBe(false);
    expect(isEventCategory(null)).toBe(false);
  });
});
