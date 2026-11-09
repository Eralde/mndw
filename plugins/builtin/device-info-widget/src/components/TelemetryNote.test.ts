// @vitest-environment happy-dom
import type {HostNavigation} from '@mndw/sdk';
import {createTestI18n} from '@mndw/sdk/testing';
import {type App as VueApp, createApp} from 'vue';
import {afterEach, describe, expect, it, vi} from 'vitest';
import TelemetryNote from './TelemetryNote.vue';

const messages = {
  'telemetry-note.off-with-data': 'Telemetry collection is off. The chart shows data up to {time}.',
  'telemetry-note.off': 'Telemetry collection is off.',
  'telemetry-note.link': 'Turn it on in Settings',
  'telemetry-note.no-session': 'Set up a persistent RCI session to collect telemetry.',
  'telemetry-note.session-link': 'Open Settings',
};

let app: VueApp | undefined;
let host: HTMLElement | undefined;

function mountNote(options: {
  sessionConfigured?: boolean;
  lastPointTime?: string | null;
  href?: string | null;
  navigateResult?: boolean;
} = {}): {
  navigation: HostNavigation;
  href: ReturnType<typeof vi.fn>;
  navigate: ReturnType<typeof vi.fn>;
  link: HTMLAnchorElement | null;
} {
  host = document.createElement('div');
  document.body.append(host);

  const href = vi.fn(() => options.href === null ? undefined : options.href ?? '/settings/general');
  const navigate = vi.fn(() => options.navigateResult ?? true);
  const navigation: HostNavigation = {
    href,
    navigate,
  };
  const i18n = createTestI18n(messages);

  app = createApp(TelemetryNote, {
    sessionConfigured: options.sessionConfigured ?? true,
    lastPointTime: options.lastPointTime ?? null,
    navigation,
  });
  app.provide('mndw:plugin-i18n', i18n);
  app.mount(host);

  return {navigation, href, navigate, link: host.querySelector<HTMLAnchorElement>('a')};
}

afterEach(() => {
  app?.unmount();
  app = undefined;
  host?.remove();
  host = undefined;
});

describe('TelemetryNote', () => {
  it('shows the last point time and links to general settings', () => {
    const {link} = mountNote({lastPointTime: 'Sep 4'});

    expect(host?.querySelector('p.telemetry-note')?.getAttribute('role')).toBe('status');
    expect(host?.textContent).toContain('The chart shows data up to Sep 4.');
    expect(link?.getAttribute('href')).toBe('/settings/general');
    expect(link?.textContent).toBe('Turn it on in Settings');
  });

  it('uses the off copy when no point exists', () => {
    mountNote();

    expect(host?.textContent).toContain('Telemetry collection is off.');
    expect(host?.textContent).not.toContain('The chart shows data up to');
  });

  it('asks for a persistent session when none is configured', () => {
    const {link} = mountNote({sessionConfigured: false});

    expect(host?.textContent).toContain('Set up a persistent RCI session to collect telemetry.');
    expect(link?.textContent).toBe('Open Settings');
  });

  it('omits an unavailable Settings link', () => {
    const {link, href} = mountNote({href: null});

    expect(link).toBeNull();
    expect(href).toHaveBeenCalledWith({kind: 'settings', tab: 'general'});
  });

  it('prevents the link default only when navigation succeeds', () => {
    const {link, navigate} = mountNote({navigateResult: false});
    const click = new MouseEvent('click', {bubbles: true, cancelable: true});

    link?.dispatchEvent(click);

    expect(navigate).toHaveBeenCalledWith({kind: 'settings', tab: 'general'});
    expect(click.defaultPrevented).toBe(false);
  });
});
