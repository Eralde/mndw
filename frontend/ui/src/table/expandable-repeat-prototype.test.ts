// @vitest-environment happy-dom
import {LitElement, html} from 'lit';
import {repeat} from 'lit/directives/repeat.js';
import {afterEach, expect, it} from 'vitest';

class ProtoTable extends LitElement {
  public items: {key: string}[] = [];
  public expanded = new Set<string>();

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  protected override render(): unknown {
    return html`<table><tbody>${
      repeat(
        this.items,
        (item) => item.key,
        (item) =>
          html`
        <tr data-row-key=${item.key}><td>${item.key}</td></tr>
        ${this.expanded.has(item.key) ? html`<tr data-detail-key=${item.key}><td>detail-${item.key}</td></tr>` : ''}
      `,
      )
    }</tbody></table>`;
  }
}

customElements.define('proto-table', ProtoTable);

afterEach(() => {
  document.body.innerHTML = '';
});

it('keyed repeat survives insert/remove/reorder with expanded rows', async () => {
  const el = document.createElement('proto-table') as ProtoTable;

  el.items = [{key: 'a'}, {key: 'b'}, {key: 'c'}];
  el.expanded = new Set(['b']);
  document.body.appendChild(el);
  await el.updateComplete;
  expect(el.querySelector('[data-detail-key="b"]')).not.toBeNull();

  el.items = [{key: 'c'}, {key: 'a'}, {key: 'b'}];
  el.requestUpdate();
  await el.updateComplete;

  const keys = [...el.querySelectorAll('tr[data-row-key]')].map((row) => row.getAttribute('data-row-key'));

  expect(keys).toEqual(['c', 'a', 'b']);

  const bRow = el.querySelector('tr[data-row-key="b"]');

  expect(bRow?.nextElementSibling?.getAttribute('data-detail-key')).toBe('b');

  el.items = [{key: 'c'}, {key: 'a'}];
  el.requestUpdate();
  await el.updateComplete;
  expect(el.querySelector('[data-detail-key="b"]')).toBeNull();
});
