import {afterEach, describe, expect, it, vi} from 'vitest';
import type {ReactiveController, ReactiveControllerHost} from 'lit';
import {setMndwUiLocale} from './i18n.js';
import {LocaleController} from './locale-controller.js';

class FakeHost implements ReactiveControllerHost {
  public readonly controllers: ReactiveController[] = [];
  public requestUpdateCount = 0;
  public readonly updateComplete = Promise.resolve(true);

  public addController(controller: ReactiveController): void {
    this.controllers.push(controller);
  }

  public removeController(controller: ReactiveController): void {
    const index = this.controllers.indexOf(controller);

    if (index !== -1) {
      this.controllers.splice(index, 1);
    }
  }

  public requestUpdate(): void {
    this.requestUpdateCount += 1;
  }

  public connect(): void {
    for (const controller of this.controllers) {
      controller.hostConnected?.();
    }
  }

  public disconnect(): void {
    for (const controller of this.controllers) {
      controller.hostDisconnected?.();
    }
  }
}

afterEach(() => {
  setMndwUiLocale('en');
});

describe('LocaleController', () => {
  it('registers itself with the host on construction', () => {
    const host = new FakeHost();
    const controller = new LocaleController(host);

    expect(host.controllers).toContain(controller);
  });

  it('runs applyLocale on connect without requesting an update', () => {
    const host = new FakeHost();
    const applyLocale = vi.fn();

    new LocaleController(host, {applyLocale});

    host.connect();

    expect(applyLocale).toHaveBeenCalledTimes(1);
    expect(host.requestUpdateCount).toBe(0);
  });

  it('runs applyLocale and requests an update on locale change', () => {
    const host = new FakeHost();
    const applyLocale = vi.fn();

    new LocaleController(host, {applyLocale});
    host.connect();

    setMndwUiLocale('ru');

    expect(applyLocale).toHaveBeenCalledTimes(2);
    expect(host.requestUpdateCount).toBe(1);
  });

  it('requests an update on locale change even without an applyLocale closure', () => {
    const host = new FakeHost();

    new LocaleController(host);
    host.connect();

    setMndwUiLocale('ru');

    expect(host.requestUpdateCount).toBe(1);
  });

  it('stops responding to locale changes after disconnect', () => {
    const host = new FakeHost();

    new LocaleController(host);
    host.connect();
    host.disconnect();

    setMndwUiLocale('ru');

    expect(host.requestUpdateCount).toBe(0);
  });
});
