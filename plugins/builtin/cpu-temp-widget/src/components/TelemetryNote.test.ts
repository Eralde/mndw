// @vitest-environment happy-dom
import {afterEach, describe, expect, it, vi} from 'vitest';
import {type App as VueApp, createApp} from 'vue';
import {type TestPluginContext, createTestI18n, createTestPluginContext} from '@mndw/sdk/testing';
import enCatalog from '../../i18n/en.json';
import ruCatalog from '../../i18n/ru.json';
import TelemetryNote from './TelemetryNote.vue';

let host: HTMLElement;
let app: VueApp | null = null;
let fixture: TestPluginContext | null = null;

const mountNote = (
  options: {sessionConfigured?: boolean; lastPointTime?: string | null; href?: string} = {},
  catalog: Record<string, string> = {
    'telemetry-note.off-with-data': 'Telemetry collection is off. The chart shows data up to {time}.',
    'telemetry-note.off': 'Telemetry collection is off.',
    'telemetry-note.link': 'Turn it on in settings',
    'telemetry-note.no-session': 'Turn on background router access in settings to collect telemetry.',
    'telemetry-note.session-link': 'Open settings',
  },
): void => {
  host = document.createElement('div');
  document.body.append(host);
  fixture = createTestPluginContext({
    i18n: createTestI18n(catalog),
  });
  fixture.context.navigation.href = () => options.href;
  app = createApp(TelemetryNote, {
    sessionConfigured: options.sessionConfigured ?? true,
    lastPointTime: options.lastPointTime ?? null,
    navigation: fixture.context.navigation,
  });
  app.provide('mndw:plugin-i18n', fixture.context.i18n);
  app.mount(host);
};

afterEach(() => {
  app?.unmount();
  app = null;
  fixture?.unmount();
  fixture = null;
  host?.remove();
});

describe('TelemetryNote', () => {
  it('shows the formatted last point time and a Settings link', () => {
    mountNote({lastPointTime: '08.11 09:42', href: '/settings/general'});

    const note = host.querySelector('p[role="status"]');
    const link = host.querySelector<HTMLAnchorElement>('a');

    expect(note?.textContent).toContain('Telemetry collection is off. The chart shows data up to 08.11 09:42.');
    expect(link?.textContent).toBe('Turn it on in settings');
    expect(link?.getAttribute('href')).toBe('/settings/general');
  });

  it('uses the no-session message even when chart data exists', () => {
    mountNote({sessionConfigured: false, lastPointTime: '08.11 09:42', href: '/settings/general'});

    expect(host.querySelector('p[role="status"]')?.textContent).toContain(
      'Turn on background router access in settings to collect telemetry.',
    );
    expect(host.querySelector('a')?.textContent).toBe('Open settings');
  });

  it.each([
    ['English', enCatalog, 'Turn on background router access in settings to collect telemetry.'],
    ['Russian', ruCatalog, 'Чтобы собирать телеметрию, включите фоновый доступ к роутеру в настройках.'],
  ])('shows background router access guidance with the %s catalog', (_locale, catalog, expected) => {
    mountNote({sessionConfigured: false}, catalog);

    expect(host.querySelector('p[role="status"]')?.textContent).toContain(expected);
  });

  it('hides the Settings link when host navigation has no href', () => {
    mountNote({href: undefined});

    expect(host.querySelector('a')).toBeNull();
  });

  it('prevents the browser default only when host navigation handles the click', () => {
    mountNote({href: '/settings/general'});

    const link = host.querySelector<HTMLAnchorElement>('a');

    if (link === null || fixture === null) {
      throw new Error('Settings link was not rendered');
    }

    const handled = new MouseEvent('click', {bubbles: true, cancelable: true});

    link.dispatchEvent(handled);
    expect(handled.defaultPrevented).toBe(true);
    expect(fixture.navigationCalls).toEqual([{kind: 'settings', tab: 'general'}]);

    fixture.context.navigation.navigate = vi.fn(() => false);

    const unhandled = new MouseEvent('click', {bubbles: true, cancelable: true});

    link.dispatchEvent(unhandled);
    expect(unhandled.defaultPrevented).toBe(false);
  });
});
