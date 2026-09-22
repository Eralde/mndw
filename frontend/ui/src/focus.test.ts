import {afterEach, describe, expect, it} from 'vitest';
import {composedContains, createFocusTrap, deepActiveElement, tabbableElements} from './focus.js';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('deepActiveElement', () => {
  it('returns the focused element in the document tree', () => {
    const button = document.createElement('button');

    document.body.appendChild(button);
    button.focus();

    expect(deepActiveElement()).toBe(button);
  });

  it('pierces a shadow root', () => {
    const host = document.createElement('div');

    document.body.appendChild(host);

    const root = host.attachShadow({mode: 'open'});
    const button = document.createElement('button');

    root.appendChild(button);
    button.focus();

    expect(document.activeElement).toBe(host);
    expect(deepActiveElement()).toBe(button);
  });

  it('pierces nested shadow roots', () => {
    const outer = document.createElement('div');

    document.body.appendChild(outer);

    const outerRoot = outer.attachShadow({mode: 'open'});
    const inner = document.createElement('div');

    outerRoot.appendChild(inner);

    const innerRoot = inner.attachShadow({mode: 'open'});
    const button = document.createElement('button');

    innerRoot.appendChild(button);
    button.focus();

    expect(deepActiveElement()).toBe(button);
  });

  it('reports the body when nothing is focused', () => {
    expect(deepActiveElement()).toBe(document.body);
  });
});
function appendButton(id: string, parent: Node): HTMLButtonElement {
  const element = document.createElement('button');

  element.id = id;
  element.textContent = id;
  parent.appendChild(element);

  return element;
}

function pressTab(shiftKey = false): KeyboardEvent {
  const target = deepActiveElement() ?? document.body;
  const event = new KeyboardEvent('keydown', {key: 'Tab', shiftKey, bubbles: true, composed: true, cancelable: true});

  target.dispatchEvent(event);

  return event;
}

function ids(elements: readonly HTMLElement[]): string[] {
  return elements.map((element) => element.id);
}

describe('tabbableElements', () => {
  it('collects natural and tabindex focusables in document order', () => {
    const container = document.createElement('div');

    document.body.appendChild(container);
    appendButton('a', container);

    const link = document.createElement('a');

    link.id = 'b';
    link.href = '#';
    container.appendChild(link);

    const div = document.createElement('div');

    div.id = 'c';
    div.tabIndex = 0;
    container.appendChild(div);

    expect(ids(tabbableElements(container))).toEqual(['a', 'b', 'c']);
  });

  it('skips disabled controls including disabled fieldsets, negative tabindex, hidden, inert, and bare anchors', () => {
    const container = document.createElement('div');

    document.body.appendChild(container);
    appendButton('keep', container);
    appendButton('disabled', container).disabled = true;
    appendButton('negative', container).tabIndex = -1;

    const hidden = document.createElement('div');

    hidden.hidden = true;
    appendButton('in-hidden', hidden);
    container.appendChild(hidden);

    const inert = document.createElement('div');

    inert.setAttribute('inert', '');
    appendButton('in-inert', inert);
    container.appendChild(inert);

    const bareLink = document.createElement('a');

    bareLink.id = 'bare-link';
    container.appendChild(bareLink);

    const disabledFieldset = document.createElement('fieldset');

    disabledFieldset.disabled = true;
    appendButton('fieldset-disabled', disabledFieldset);
    container.appendChild(disabledFieldset);

    const hiddenInput = document.createElement('input');

    hiddenInput.id = 'hidden-input';
    hiddenInput.type = 'hidden';
    container.appendChild(hiddenInput);

    expect(ids(tabbableElements(container))).toEqual(['keep']);
  });

  it('includes contenteditable editing hosts but not nested editable regions', () => {
    const container = document.createElement('div');

    document.body.appendChild(container);

    const editor = document.createElement('div');

    editor.id = 'editor';
    editor.setAttribute('contenteditable', 'true');

    const nestedEditor = document.createElement('div');

    nestedEditor.id = 'nested-editor';
    nestedEditor.setAttribute('contenteditable', 'true');
    editor.appendChild(nestedEditor);
    container.appendChild(editor);

    expect(ids(tabbableElements(container))).toEqual(['editor']);
  });

  it('walks open shadow roots and slotted light children in composed order', () => {
    const container = document.createElement('div');

    document.body.appendChild(container);
    appendButton('before', container);

    const host = document.createElement('div');

    container.appendChild(host);

    const root = host.attachShadow({mode: 'open'});

    appendButton('shadow-first', root);
    root.appendChild(document.createElement('slot'));
    appendButton('shadow-last', root);
    appendButton('slotted', host);
    appendButton('after', container);

    expect(ids(tabbableElements(container))).toEqual(['before', 'shadow-first', 'slotted', 'shadow-last', 'after']);
  });

  it('does not include fallback controls when a slot has text-only assigned content', () => {
    const container = document.createElement('div');
    const host = document.createElement('div');
    const root = host.attachShadow({mode: 'open'});
    const slot = document.createElement('slot');
    const fallback = document.createElement('button');

    fallback.id = 'fallback';
    slot.appendChild(fallback);
    root.appendChild(slot);
    host.appendChild(document.createTextNode('assigned text'));
    container.appendChild(host);
    document.body.appendChild(container);

    expect(tabbableElements(container)).toEqual([]);
  });

  it('does not list a delegatesFocus host itself, only its inner control', () => {
    const container = document.createElement('div');

    document.body.appendChild(container);

    const host = document.createElement('div');

    host.id = 'host';
    container.appendChild(host);
    appendButton('inner', host.attachShadow({mode: 'open', delegatesFocus: true}));

    expect(ids(tabbableElements(container))).toEqual(['inner']);
  });
});

describe('composedContains', () => {
  it('crosses shadow boundaries upward', () => {
    const container = document.createElement('div');
    const host = document.createElement('div');

    document.body.appendChild(container);
    container.appendChild(host);

    const inner = appendButton('inner', host.attachShadow({mode: 'open'}));

    expect(composedContains(container, inner)).toBe(true);
    expect(composedContains(host, container)).toBe(false);
    expect(composedContains(container, null)).toBe(false);
  });
});

describe('createFocusTrap', () => {
  function setup(): {
    outside: HTMLButtonElement;
    container: HTMLDivElement;
    first: HTMLButtonElement;
    last: HTMLButtonElement;
  } {
    const outside = appendButton('outside', document.body);
    const container = document.createElement('div');

    document.body.appendChild(container);

    const first = appendButton('first', container);
    const last = appendButton('last', container);

    outside.focus();

    return {outside, container, first, last};
  }

  it('moves focus to the first tabbable on activation', () => {
    const {container, first} = setup();
    const trap = createFocusTrap(container);

    expect(deepActiveElement()).toBe(first);
    trap.deactivate();
  });

  it('remembers focus already inside the container at activation', () => {
    const {outside, container, last} = setup();

    last.focus();

    const trap = createFocusTrap(container);

    outside.focus();
    expect(deepActiveElement()).toBe(last);
    trap.deactivate();
  });

  it('honors initialFocus', () => {
    const {container, last} = setup();
    const trap = createFocusTrap(container, {initialFocus: () => last});

    expect(deepActiveElement()).toBe(last);
    trap.deactivate();
  });

  it('wraps Tab from the last element and Shift+Tab from the first', () => {
    const {container, first, last} = setup();
    const trap = createFocusTrap(container);

    last.focus();
    expect(pressTab().defaultPrevented).toBe(true);
    expect(deepActiveElement()).toBe(first);

    pressTab(true);
    expect(deepActiveElement()).toBe(last);
    trap.deactivate();
  });

  it('steps into shadow content', () => {
    const {container, first} = setup();
    const host = document.createElement('div');

    container.insertBefore(host, first.nextSibling);

    const inner = appendButton('inner', host.attachShadow({mode: 'open'}));
    const trap = createFocusTrap(container);

    pressTab();
    expect(deepActiveElement()).toBe(inner);
    trap.deactivate();
  });

  it('returns escaped focus to the last element focused inside the trap', () => {
    const {outside, container, last} = setup();
    const trap = createFocusTrap(container);

    last.focus();
    outside.focus();
    expect(deepActiveElement()).toBe(last);
    trap.deactivate();
  });

  it('falls back to the first tabbable when the last focused element is gone', () => {
    const {outside, container, first, last} = setup();
    const trap = createFocusTrap(container);

    last.focus();
    last.remove();
    outside.focus();
    expect(deepActiveElement()).toBe(first);
    trap.deactivate();
  });

  it('lets allowFocus targets hold focus outside the container', () => {
    const {outside, container} = setup();
    const trap = createFocusTrap(container, {allowFocus: (target) => target === outside});

    outside.focus();
    expect(deepActiveElement()).toBe(outside);
    trap.deactivate();
  });

  it('restores focus on deactivate unless restoreFocus is false', () => {
    const {outside, container} = setup();

    createFocusTrap(container).deactivate();
    expect(deepActiveElement()).toBe(outside);

    const trap = createFocusTrap(container, {restoreFocus: false});

    trap.deactivate();
    expect(deepActiveElement()).not.toBe(outside);
  });

  it('focuses the container itself when it has no tabbables', () => {
    const container = document.createElement('div');

    document.body.appendChild(container);

    const trap = createFocusTrap(container);

    expect(deepActiveElement()).toBe(container);
    expect(container.getAttribute('tabindex')).toBe('-1');
    trap.deactivate();
  });

  it('pauses the outer trap while a nested trap is active and resumes it afterwards', () => {
    const {container, first} = setup();
    const outer = createFocusTrap(container);
    const inner = document.createElement('div');

    container.appendChild(inner);

    const innerButton = appendButton('inner-button', inner);
    const nested = createFocusTrap(inner);

    expect(deepActiveElement()).toBe(innerButton);
    first.focus();
    expect(deepActiveElement()).toBe(innerButton);

    nested.deactivate();
    expect(deepActiveElement()).toBe(first);
    pressTab(true);
    expect(deepActiveElement()?.id).toBe('inner-button');
    outer.deactivate();
  });

  it('leaves Tab alone when a listener already handled it', () => {
    const {container, last} = setup();
    const trap = createFocusTrap(container);

    last.addEventListener('keydown', (event) => event.preventDefault());
    last.focus();
    pressTab();
    expect(deepActiveElement()).toBe(last);
    trap.deactivate();
  });

  it('is idempotent on deactivate', () => {
    const {outside, container} = setup();
    const trap = createFocusTrap(container);

    trap.deactivate();
    outside.focus();
    trap.deactivate();
    expect(deepActiveElement()).toBe(outside);
  });
});
