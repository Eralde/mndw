// @vitest-environment happy-dom
import {flushSync, mount, unmount} from 'svelte';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createTestI18n} from '@mndw/sdk/testing';
import {createTranslator} from '@mndw/sdk/svelte';
import {ALL_LOG_LEVELS} from './log-filters';
import type {LogLevel} from './log-types';
import LogLevelPills from './LogLevelPills.svelte';

function translator() {
  return createTranslator(createTestI18n({
    'filter.levels': 'Log levels',
    'level.info': 'Info',
    'level.warning': 'Warning',
    'level.error': 'Error',
    'level.critical': 'Critical',
    'level.debug': 'Debug',
    'level.notice': 'Notice',
  }));
}

describe('LogLevelPills', () => {
  let hosts: HTMLElement[] = [];

  afterEach(() => {
    for (const host of hosts) {
      host.remove();
    }

    hosts = [];
  });

  function createHost(): HTMLElement {
    const host = document.createElement('div');

    document.body.appendChild(host);
    hosts.push(host);

    return host;
  }

  it('renders every level as an active accessible pill', () => {
    const host = createHost();
    const app = mount(LogLevelPills, {
      target: host,
      props: {activeLevels: new Set(ALL_LOG_LEVELS), translator: translator(), onChange: vi.fn()},
    });

    flushSync();

    const group = host.querySelector('[role="group"]');

    const pills = [...host.querySelectorAll<HTMLElement>('mndw-button[data-level]')];

    expect(group?.getAttribute('aria-label')).toBe('Log levels');
    expect(pills).toHaveLength(ALL_LOG_LEVELS.length);
    expect(pills.map((pill) => pill.dataset.level)).toEqual(ALL_LOG_LEVELS);
    expect(pills.every((pill) => pill.dataset.active === 'true')).toBe(true);
    expect(pills.every((pill) => pill.getAttribute('aria-pressed') === 'true')).toBe(true);
    expect(host.querySelector(':scope > button')).toBeNull();

    void unmount(app);
  });

  it('emits a new set when toggling a level off and on', () => {
    const host = createHost();
    const onChange = vi.fn();
    const initialLevels = new Set<LogLevel>(ALL_LOG_LEVELS);
    const app = mount(LogLevelPills, {
      target: host,
      props: {activeLevels: initialLevels, translator: translator(), onChange},
    });

    flushSync();
    host.querySelector<HTMLElement>('[data-level="Info"]')?.click();

    const withoutInfo = onChange.mock.lastCall?.[0] as ReadonlySet<LogLevel>;

    expect(withoutInfo).not.toBe(initialLevels);
    expect(withoutInfo.has('Info')).toBe(false);

    void unmount(app);

    const secondHost = createHost();
    const secondApp = mount(LogLevelPills, {
      target: secondHost,
      props: {activeLevels: withoutInfo, translator: translator(), onChange},
    });

    flushSync();
    secondHost.querySelector<HTMLElement>('[data-level="Info"]')?.click();

    const withInfo = onChange.mock.lastCall?.[0] as ReadonlySet<LogLevel>;

    expect(withInfo.has('Info')).toBe(true);
    expect(withInfo).not.toBe(withoutInfo);

    void unmount(secondApp);
  });
});
