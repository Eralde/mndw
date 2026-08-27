import {Component, inject, input, signal} from '@angular/core';
import {TRANSLATOR} from '@mndw/sdk/angular';

@Component({
  selector: 'app-root',
  standalone: true,
  template: `
    <div style="padding:var(--mndw-space-4);font-family:sans-serif">
      <h3 data-testid="l10n-probe" data-plugin-label="__MNDW_LABEL__">{{ translator.t('l10n.probe') }}</h3>
      <p>Device: {{ deviceName() }}</p>
      <button (click)="count.set(count() + 1)">{{ translator.t('l10n.button') }} {{ count() }}</button>
      <p>{{ translator.t('l10n.result') }}</p>
    </div>
  `,
})
export class AppComponent {
  protected readonly translator = inject(TRANSLATOR);
  public readonly deviceName = input('');
  protected readonly count = signal(0);
}
