type UpdateCompleteElement = HTMLElement & {updateComplete: Promise<unknown>};

type UpdateCompleteTagName = {
  [K in keyof HTMLElementTagNameMap]: HTMLElementTagNameMap[K] extends UpdateCompleteElement ? K : never;
}[keyof HTMLElementTagNameMap];

export function defineComponents(...entries: [string, CustomElementConstructor][]): void {
  for (const [tag, constructor] of entries) {
    if (!customElements.get(tag)) {
      customElements.define(tag, constructor);
    }
  }
}

export function mount<K extends UpdateCompleteTagName>(
  html: string,
  tag: K,
): Promise<HTMLElementTagNameMap[K]>;

export async function mount(html: string, tag: string): Promise<UpdateCompleteElement> {
  document.body.innerHTML = html;

  const element = document.body.querySelector<UpdateCompleteElement>(tag);

  if (!element) {
    throw new Error(`missing ${tag}`);
  }

  await element.updateComplete;

  return element;
}

export async function settle(element: UpdateCompleteElement, turns: 1 | 2 = 1): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    await element.updateComplete;
  }
}

export async function press(
  element: UpdateCompleteElement,
  key: string,
  from?: EventTarget,
): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', {key, bubbles: true, composed: true, cancelable: true});

  (from ?? element).dispatchEvent(event);
  await element.updateComplete;

  return event;
}
