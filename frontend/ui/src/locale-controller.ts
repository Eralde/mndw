import type {ReactiveController, ReactiveControllerHost} from 'lit';
import {subscribeMndwUiLocale} from './i18n.js';

export interface LocaleControllerOptions {
  applyLocale?: () => void;
}

/**
 * Subscribes a Lit host to the mndw UI locale store. Runs `applyLocale` (if
 * provided) once on connect to localize first paint, and again on every locale
 * change, requesting a host update only on change. Unsubscribes on disconnect,
 * so teardown cannot be forgotten.
 */
export class LocaleController implements ReactiveController {
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly options: LocaleControllerOptions = {},
  ) {
    host.addController(this);
  }

  public hostConnected(): void {
    this.options.applyLocale?.();
    this.unsubscribe = subscribeMndwUiLocale(() => {
      this.options.applyLocale?.();
      this.host.requestUpdate();
    });
  }

  public hostDisconnected(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
