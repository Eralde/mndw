// @vitest-environment happy-dom
import {flushSync, mount, unmount} from 'svelte';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {LogLevel} from './log-types';
import {ALL_LOG_LEVELS, type FilterState} from './log-filters';
import LogFilters from './LogFilters.svelte';

const allLevels = new Set<LogLevel>(ALL_LOG_LEVELS);

describe('LogFilters', () => {
  let host: HTMLElement;

  afterEach(() => {
    host?.remove();
  });

  it('emits typed search and level changes and resets active filters', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);

    const state: FilterState = {query: '', levels: allLevels};
    const onChange = vi.fn();
    const app = mount(LogFilters, {
      target: host,
      props: {state, filteredCount: 2, totalCount: 6, onChange},
    });

    flushSync();

    const filterToggle = host.querySelector<HTMLElement>('mndw-button[data-filter-toggle]');

    expect(filterToggle?.getAttribute('aria-expanded')).toBe('false');
    expect(host.textContent).toContain('Showing 2 of 6 items');

    filterToggle?.click();
    flushSync();

    expect(filterToggle?.getAttribute('aria-expanded')).toBe('true');

    const input = host.querySelector('mndw-input');

    input?.dispatchEvent(new CustomEvent('mndwinput', {detail: {value: 'router'}, bubbles: true}));
    expect(onChange).toHaveBeenCalledWith({query: 'router', levels: allLevels});

    const errorPill = host.querySelector('[data-level="Error"]');

    errorPill?.click();

    const changedState = onChange.mock.lastCall?.[0] as FilterState;

    expect(changedState.query).toBe('');
    expect(changedState.levels.has('Error')).toBe(false);

    await unmount(app);
  });

  it('shows reset control only when filters are active', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);

    const onChange = vi.fn();
    const app = mount(LogFilters, {
      target: host,
      props: {state: {query: 'router', levels: allLevels}, filteredCount: 1, totalCount: 6, onChange},
    });

    flushSync();
    expect(host.querySelector('mndw-button[data-reset-filters]')).not.toBeNull();
    host.querySelector<HTMLElement>('mndw-button[data-reset-filters]')?.click();

    const resetState = onChange.mock.lastCall?.[0] as FilterState;

    expect(resetState.query).toBe('');
    expect([...resetState.levels]).toEqual([...allLevels]);

    await unmount(app);
  });
});
