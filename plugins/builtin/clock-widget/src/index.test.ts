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

  it('updates the visible clock and accessible label after a locale switch', () => {
    const host = document.createElement('div');
    const i18n = createTestI18n({title: 'Clock EN'});
    const fixture = createTestPluginContext({i18n});
    const setTileTitle = vi.fn();
    const context = Object.assign(Object.create(fixture.context), {setTileTitle});
    const instance = createInstance(host, context);
    const time = host.querySelector('[data-mndw-clock]');

    expect(time?.textContent).toBe(i18n.formatDate(new Date(), {timeStyle: 'medium'}));
    expect(setTileTitle).toHaveBeenLastCalledWith('Clock EN');
    i18n.setLocale('ru', {title: 'Часы RU'});

    expect(host.querySelector('[data-mndw-clock]')).toBe(time);
    expect(time?.textContent).toBe(i18n.formatDate(new Date(), {timeStyle: 'medium'}));
    expect(time?.getAttribute('aria-label')).toBe('Часы RU');
    expect(setTileTitle).toHaveBeenLastCalledWith('Часы RU');
    instance.unmount();
  });
});
