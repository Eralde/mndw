import {afterEach, describe, expect, it, vi} from 'vitest';
import type {PluginContext, Translator} from '@mndw/sdk';
import {openSettingsDialog} from './open-settings-dialog.js';

describe('openSettingsDialog', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens a host-managed modal with widget-local controls', () => {
    const open = vi.fn();
    const translator = {t: vi.fn((key: string) => key)} as unknown as Translator;
    const ctx = {overlay: {open}} as unknown as PluginContext;
    const onChange = vi.fn();

    openSettingsDialog(ctx, {cpu: true}, onChange, translator);

    expect(open).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'modal',
      title: 'settings',
      closeOnOutsideClick: true,
    }));
  });
});
