export function shadowOf(el: HTMLElement): ShadowRoot {
  const root = el.shadowRoot;

  if (root === null) {
    throw new Error('expected open shadow root');
  }

  return root;
}

export function shadowQuery<T extends Element>(el: HTMLElement, selector: string): T {
  const node = shadowOf(el).querySelector<T>(selector);

  if (node === null) {
    throw new Error(`expected shadow element: ${selector}`);
  }

  return node;
}

export function shadowQueryAll<T extends Element>(el: HTMLElement, selector: string): T[] {
  return [...shadowOf(el).querySelectorAll<T>(selector)];
}

export function nonNull<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${what}`);
  }

  return value;
}

export function clearBody(): void {
  document.body.innerHTML = '';
}
