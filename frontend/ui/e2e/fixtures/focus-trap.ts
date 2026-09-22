import '@mndw/sdk/tokens.css';
import '../../src/styles/kit.css';
import iconSpriteUrl from '../../src/icon/generated/sprite.svg?url&no-inline';
import {type FocusTrap, createFocusTrap, deepActiveElement, defineMndwUi} from '../../src/index';

declare global {
  interface Window {
    __focusedId: () => string | null;
  }
}

defineMndwUi({iconSpriteUrl});

class ShadowCard extends HTMLElement {
  constructor() {
    super();

    const root = this.attachShadow({mode: 'open'});

    root.innerHTML = '<button id="shadow-before">Shadow before</button><slot></slot>'
      + '<button id="shadow-after">Shadow after</button>';
  }
}

customElements.define('shadow-card', ShadowCard);

window.__focusedId = () => {
  let node: Node | null = deepActiveElement();

  while (node) {
    if (node instanceof Element && node.id) {
      return node.id;
    }

    node = node instanceof ShadowRoot ? node.host : node.parentNode;
  }

  return null;
};

const open: {element: HTMLElement; trap: FocusTrap}[] = [];

function openTrap(id: string): void {
  const element = document.getElementById(id);

  if (!element) {
    throw new Error(`missing #${id}`);
  }

  element.hidden = false;
  open.push({element, trap: createFocusTrap(element)});
}

document.getElementById('open-outer')?.addEventListener('click', () => openTrap('outer'));
document.getElementById('open-inner')?.addEventListener('click', () => openTrap('inner'));
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') {
    return;
  }

  const top = open.pop();

  if (!top) {
    return;
  }

  top.element.hidden = true;
  top.trap.deactivate();
});

document.documentElement.dataset.ready = 'true';
