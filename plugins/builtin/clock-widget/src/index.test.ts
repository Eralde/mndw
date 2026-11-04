// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createTestI18n, createTestPluginContext} from '@mndw/sdk/testing';
import enCatalog from '../i18n/en.json';
import {createInstance} from './index';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-15T12:34:56'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createInstance', () => {
  it('keeps immediate rendering while using fixture ticks and cleaning up on unmount', () => {
    const host = document.createElement('div');
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const i18n = createTestI18n(enCatalog);
    const fixture = createTestPluginContext({i18n});
    const instance = createInstance(host, fixture.context);

    expect(host.querySelector<HTMLTimeElement>('[data-mndw-clock]')?.textContent)
      .toBe(i18n.formatDate(new Date(), {timeStyle: 'medium'}));
    expect(setIntervalSpy).not.toHaveBeenCalled();

    vi.setSystemTime(new Date('2026-07-15T12:35:56'));
    fixture.tick(1000);

    expect(host.querySelector<HTMLTimeElement>('[data-mndw-clock]')?.textContent)
      .toBe(i18n.formatDate(new Date(), {timeStyle: 'medium'}));

    instance.unmount();
    fixture.tick(2000);

    expect(host.innerHTML).toBe('');
  });

  it('updates the same probe and time surface after a locale switch', () => {
    const host = document.createElement('div');
    const i18n = createTestI18n({title: 'Clock EN', l10n: {probe: 'Clock English'}});
    const fixture = createTestPluginContext({i18n});
    const instance = createInstance(host, fixture.context);
    const probe = host.querySelector('[data-testid="l10n-probe"]');
    const time = host.querySelector('[data-mndw-clock]');

    expect(probe?.textContent).toBe('Clock English');
    i18n.setLocale('ru', {title: 'Часы RU', l10n: {probe: 'Часы русский'}});

    expect(host.querySelector('[data-testid="l10n-probe"]')).toBe(probe);
    expect(probe?.textContent).toBe('Часы русский');
    expect(host.querySelector('[data-mndw-clock]')).toBe(time);
    expect(time?.getAttribute('aria-label')).toBe('Часы RU');
    instance.unmount();
  });
});
