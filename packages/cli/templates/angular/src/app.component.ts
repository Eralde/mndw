import {Component, input, signal} from '@angular/core';

@Component({
  selector: 'app-root',
  standalone: true,
  template: `
    <div style="padding:16px;font-family:sans-serif">
      <h3>__MNDW_LABEL__</h3>
      <p>Device: {{ deviceName() }}</p>
      <button (click)="count.set(count() + 1)">Clicked {{ count() }}</button>
    </div>
  `,
})
export class AppComponent {
  public readonly deviceName = input<string>('');
  protected readonly count = signal(0);
}
