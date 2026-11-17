import {CUSTOM_ELEMENTS_SCHEMA, Component, InjectionToken, inject, input, signal} from '@angular/core';
import type {PluginContext} from '@mndw/sdk';
import {TRANSLATOR} from '@mndw/sdk/angular';

export const PLUGIN_CONTEXT = new InjectionToken<PluginContext>('PLUGIN_CONTEXT');

@Component({
  selector: 'app-root',
  standalone: true,
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `
    <section class="__MNDW_NAME__" [attr.aria-labelledby]="isPage ? 'plugin-title' : null"
      style="padding:var(--mndw-space-4);font-family:var(--mndw-font-sans);color:var(--mndw-text);background:var(--mndw-surface)">
      @if (isPage) {
        <h2 id="plugin-title">{{ translator.t('l10n.title') }}</h2>
      }
      <p>Device: {{ deviceName() }}</p>
      <mndw-button variant="primary" type="button" (click)="load()">
        {{ translator.t('l10n.button') }}
      </mndw-button>
      <p data-testid="l10n-result" role="status" aria-live="polite">
        @if (backendError()) {
          {{ translator.t('l10n.error') }}
        } @else if (backendMessage() !== undefined) {
          {{ translator.t('l10n.result') }}: {{ backendMessage() }}
        } @else {
          {{ translator.t('l10n.result') }}
        }
      </p>
    </section>
  `,
})
export class AppComponent {
  private readonly ctx = inject(PLUGIN_CONTEXT);
  protected readonly isPage = this.ctx.kind === 'page';
  protected readonly translator = inject(TRANSLATOR);
  public readonly deviceName = input('');
  protected readonly backendMessage = signal<string | undefined>(undefined);
  protected readonly backendError = signal(false);

  protected async load(): Promise<void> {
    if (this.ctx.backend === undefined) {
      this.backendError.set(true);

      return;
    }

    try {
      const response = await this.ctx.backend.call<{message: string}>('hello', {as: 'json'});
      this.backendMessage.set(response.message);
      this.backendError.set(false);
    } catch {
      this.backendMessage.set(undefined);
      this.backendError.set(true);
    }
  }
}
