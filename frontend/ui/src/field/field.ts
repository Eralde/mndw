import {type PropertyDeclarations, ReactiveElement} from '@lit/reactive-element';

export const MNDW_FIELD_TAG = 'mndw-field';
export const MNDW_LABEL_CHANGE_EVENT = 'mndwlabelchange';

export function dispatchLabelChange(target: EventTarget): void {
  target.dispatchEvent(new Event(MNDW_LABEL_CHANGE_EVENT, {bubbles: true, composed: true}));
}

/**
 * How a control supplies its own accessible name. Controls declare it as a static
 * `mndwLabelSource`; field reads that rather than inspecting content per tag.
 */
export type MndwLabelSource = 'slot' | 'label-property';

interface LabelSourceConstructor {
  mndwLabelSource?: MndwLabelSource;
  formAssociated?: boolean;
}

interface OwnedNodes {
  label: HTMLLabelElement;
  text: Text;
  marker: HTMLSpanElement;
  hint: HTMLElement;
  error: HTMLElement;
}

const NATIVE_LABELABLE = new Set(['button', 'input', 'meter', 'output', 'progress', 'select', 'textarea']);
const TOKEN_SEPARATOR = /\s+/u;

let nextFieldId = 0;

/** `instanceof Document` is unreliable across DOM implementations; probe the capability instead. */
function searchRoot(node: Node): Document | ShadowRoot | null {
  const root = node.getRootNode() as Document | ShadowRoot;

  return typeof root.querySelectorAll === 'function' ? root : null;
}

function tokensOf(control: Element, attribute: string): string[] {
  return (control.getAttribute(attribute) ?? '').split(TOKEN_SEPARATOR).filter((token) => token !== '');
}

export class MndwField extends ReactiveElement {
  public static readonly properties: PropertyDeclarations = {
    label: {type: String},
    hint: {type: String},
    error: {type: String},
    required: {type: Boolean, reflect: true},
  };

  declare public label: string;
  declare public hint: string;
  declare public error: string;
  declare public required: boolean;

  private readonly fieldId: string;
  private readonly observer: MutationObserver;
  private readonly ownedTokens = new Map<string, Set<string>>();
  private readonly ownedAttributes = new Map<string, string | null>();
  private ownedNodes: OwnedNodes | null = null;
  private control: Element | null = null;
  private ownsControlId = false;

  constructor() {
    super();
    nextFieldId += 1;
    this.fieldId = `mndw-field-${nextFieldId}`;
    this.label = '';
    this.hint = '';
    this.error = '';
    this.required = false;
    this.observer = new MutationObserver(this.onMutations);
  }

  public override connectedCallback(): void {
    super.connectedCallback();
    this.ownedNodes ??= this.createOwnedNodes();
    this.classList.add('mndw-field');
    this.addEventListener(MNDW_LABEL_CHANGE_EVENT, this.onLabelChange);
    this.observe();
    this.requestUpdate();
  }

  public override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.removeEventListener(MNDW_LABEL_CHANGE_EVENT, this.onLabelChange);
    this.observer.disconnect();
    this.releaseControl();
  }

  /** Field is a wiring wrapper: label, hint, error and the control share one tree. */
  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  protected override updated(): void {
    this.wire();
  }

  private createOwnedNodes(): OwnedNodes {
    const label = document.createElement('label');
    const text = document.createTextNode('');
    const marker = document.createElement('span');
    const hint = document.createElement('div');
    const error = document.createElement('div');

    label.className = 'mndw-field__label';
    label.id = `${this.fieldId}-label`;
    marker.className = 'mndw-field__required';
    marker.setAttribute('aria-hidden', 'true');
    marker.textContent = ' *';
    marker.hidden = true;
    label.append(text, marker);

    hint.className = 'mndw-field__hint';
    hint.id = `${this.fieldId}-hint`;
    hint.hidden = true;

    error.className = 'mndw-field__error';
    error.id = `${this.fieldId}-error`;
    error.setAttribute('role', 'alert');
    error.hidden = true;

    return {label, text, marker, hint, error};
  }

  private wire(): void {
    const nodes = this.ownedNodes;

    if (!nodes || !this.isConnected) {
      return;
    }

    this.placeOwnedNodes(nodes);

    const control = this.resolveControl(nodes);

    if (control !== this.control) {
      this.releaseControl();
      this.control = control;
      this.observe();
    }

    const showLabel = this.label.trim() !== '' && (control === null || !this.hasOwnLabel(control, nodes));

    nodes.text.textContent = this.label;
    nodes.marker.hidden = !this.required;
    nodes.label.hidden = !showLabel;
    nodes.hint.textContent = this.hint;
    nodes.hint.hidden = this.hint === '';
    nodes.error.textContent = this.error;
    nodes.error.hidden = this.error === '';

    if (!control) {
      nodes.label.removeAttribute('for');

      return;
    }

    this.syncControlId(control);
    this.syncLabelAssociation(control, nodes, showLabel);
    this.syncDescriptions(control, nodes);
    this.syncStates(control);
  }

  private placeOwnedNodes(nodes: OwnedNodes): void {
    if (this.firstChild !== nodes.label) {
      this.insertBefore(nodes.label, this.firstChild);
    }

    if (this.lastChild !== nodes.error) {
      this.appendChild(nodes.error);
    }

    if (nodes.error.previousSibling !== nodes.hint) {
      this.insertBefore(nodes.hint, nodes.error);
    }
  }

  private resolveControl(nodes: OwnedNodes): Element | null {
    for (const node of this.childNodes) {
      if (node.nodeType === Node.ELEMENT_NODE && !this.isOwnedNode(node, nodes)) {
        return node as Element;
      }
    }

    return null;
  }

  private syncControlId(control: Element): void {
    const generated = `${this.fieldId}-control`;

    if (control.id === '') {
      control.id = generated;
      this.ownsControlId = true;
    } else if (control.id !== generated) {
      this.ownsControlId = false;
    }
  }

  private syncLabelAssociation(control: Element, nodes: OwnedNodes, showLabel: boolean): void {
    if (showLabel && this.isLabelable(control)) {
      const previousFor = nodes.label.htmlFor;

      nodes.label.htmlFor = control.id;

      const tokensChanged = this.syncTokens(control, 'aria-labelledby', []);

      if (previousFor !== nodes.label.htmlFor || tokensChanged) {
        this.refreshAccessibleName(control);
      }

      return;
    }

    const hadFor = nodes.label.hasAttribute('for');

    nodes.label.removeAttribute('for');

    const tokensChanged = this.syncTokens(control, 'aria-labelledby', showLabel ? [nodes.label.id] : []);

    if (hadFor || tokensChanged) {
      this.refreshAccessibleName(control);
    }
  }

  private refreshAccessibleName(control: Element): void {
    const refresh = (control as Element & {refreshAccessibleName?: () => void}).refreshAccessibleName;

    refresh?.call(control);
  }

  private syncDescriptions(control: Element, nodes: OwnedNodes): void {
    const tokens: string[] = [];

    if (this.hint !== '') {
      tokens.push(nodes.hint.id);
    }

    if (this.error !== '') {
      tokens.push(nodes.error.id);
    }

    this.syncTokens(control, 'aria-describedby', tokens);
  }

  private syncStates(control: Element): void {
    if (this.error !== '') {
      this.setOwnedAttribute(control, 'aria-invalid', 'true');
    } else {
      this.clearOwnedAttribute(control, 'aria-invalid');
    }

    if (this.required) {
      this.setOwnedAttribute(control, 'required', '');
    } else {
      this.clearOwnedAttribute(control, 'required');
    }
  }

  /** Appends only field-owned tokens so a consumer's own list survives untouched. */
  private syncTokens(control: Element, attribute: string, tokens: readonly string[]): boolean {
    const owned = this.ownedTokens.get(attribute) ?? new Set<string>();
    const kept = tokensOf(control, attribute).filter((token) => !owned.has(token));
    const next = [...kept, ...tokens.filter((token) => !kept.includes(token))];

    if (tokens.length === 0) {
      this.ownedTokens.delete(attribute);
    } else {
      this.ownedTokens.set(attribute, new Set(tokens));
    }

    if (next.length === 0) {
      const changed = control.hasAttribute(attribute);

      control.removeAttribute(attribute);

      return changed;
    }

    const value = next.join(' ');
    const changed = control.getAttribute(attribute) !== value;

    if (changed) {
      control.setAttribute(attribute, value);
    }

    return changed;
  }

  private setOwnedAttribute(control: Element, attribute: string, value: string): void {
    if (!this.ownedAttributes.has(attribute)) {
      this.ownedAttributes.set(attribute, control.getAttribute(attribute));
    }

    if (control.getAttribute(attribute) !== value) {
      control.setAttribute(attribute, value);
    }
  }

  private clearOwnedAttribute(control: Element, attribute: string): void {
    if (!this.ownedAttributes.has(attribute)) {
      return;
    }

    const previous = this.ownedAttributes.get(attribute) ?? null;

    this.ownedAttributes.delete(attribute);

    if (previous === null) {
      control.removeAttribute(attribute);
    } else {
      control.setAttribute(attribute, previous);
    }
  }

  private releaseControl(): void {
    const control = this.control;

    if (!control) {
      return;
    }

    for (const attribute of [...this.ownedTokens.keys()]) {
      this.syncTokens(control, attribute, []);
    }

    for (const attribute of [...this.ownedAttributes.keys()]) {
      this.clearOwnedAttribute(control, attribute);
    }

    if (this.ownsControlId && control.id === `${this.fieldId}-control`) {
      control.removeAttribute('id');
    }

    this.ownedNodes?.label.removeAttribute('for');
    this.ownsControlId = false;
    this.control = null;
  }

  private hasOwnLabel(control: Element, nodes: OwnedNodes): boolean {
    if ((control.getAttribute('aria-label') ?? '').trim() !== '') {
      return true;
    }

    if (this.hasResolvedLabelledBy(control, nodes)) {
      return true;
    }

    if (this.associatedLabels(control, nodes).length > 0) {
      return true;
    }

    return this.hasControlLabelSource(control);
  }

  private hasResolvedLabelledBy(control: Element, nodes: OwnedNodes): boolean {
    const root = searchRoot(control);

    if (!root) {
      return false;
    }

    const targets = [...root.querySelectorAll<Element>('[id]')];
    const labelledBy = tokensOf(control, 'aria-labelledby');

    return labelledBy.some((token) => targets.some((target) => target.id === token && target !== nodes.label));
  }

  private associatedLabels(control: Element, nodes: OwnedNodes): HTMLLabelElement[] {
    const root = searchRoot(control);

    if (!root) {
      return [];
    }

    return [...root.querySelectorAll('label')].filter((label) =>
      label !== nodes.label && this.labelsControl(label, control)
    );
  }

  private labelsControl(label: HTMLLabelElement, control: Element): boolean {
    if (label.control === control) {
      return true;
    }

    // Form-associated custom elements are labelable by specification, but not every DOM
    // implementation resolves `label.control` for them; fall back to the `for` association.
    return label.control === null
      && label.htmlFor !== ''
      && label.htmlFor === control.id
      && this.isLabelable(control);
  }

  private hasControlLabelSource(control: Element): boolean {
    const source = (control.constructor as LabelSourceConstructor).mndwLabelSource;

    if (source === 'label-property') {
      const label = (control as Element & {label?: unknown}).label;

      return typeof label === 'string' && label.trim() !== '';
    }

    if (source === 'slot') {
      return (control.textContent ?? '').trim() !== '';
    }

    return false;
  }

  private isLabelable(control: Element): boolean {
    if (NATIVE_LABELABLE.has(control.localName)) {
      return control.localName !== 'input' || control.getAttribute('type') !== 'hidden';
    }

    return (control.constructor as LabelSourceConstructor).formAssociated === true;
  }

  private isOwnedNode(node: Node, nodes: OwnedNodes): boolean {
    return node === nodes.label
      || node === nodes.hint
      || node === nodes.error
      || nodes.label.contains(node)
      || nodes.hint.contains(node)
      || nodes.error.contains(node);
  }

  private observe(): void {
    if (!this.isConnected) {
      return;
    }

    this.observer.disconnect();
    this.observer.observe(this, {childList: true, subtree: true, characterData: true});

    const control = this.control;

    if (!control) {
      return;
    }

    this.observer.observe(control, {attributes: true, attributeFilter: ['id', 'aria-label', 'aria-labelledby']});

    const root = searchRoot(control);

    if (root) {
      this.observer.observe(root, {childList: true, subtree: true, attributes: true, attributeFilter: ['for']});
    }
  }

  private readonly onMutations = (records: MutationRecord[]): void => {
    const nodes = this.ownedNodes;

    if (!nodes) {
      return;
    }

    const relevant = records.some((record) => this.isRelevantMutation(record, nodes));

    if (relevant) {
      this.requestUpdate();
    }
  };

  private isRelevantMutation(record: MutationRecord, nodes: OwnedNodes): boolean {
    if (this.isOwnedNode(record.target, nodes) || this.isInAnotherField(record.target)) {
      return false;
    }

    if (record.type !== 'childList') {
      return true;
    }

    const changed = [...record.addedNodes, ...record.removedNodes];

    return changed.some((node) => !this.isOwnedNode(node, nodes) && !this.isInAnotherField(node));
  }

  private isInAnotherField(node: Node): boolean {
    const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
    const field = element?.closest(MNDW_FIELD_TAG);

    return field !== null && field !== undefined && field !== this;
  }

  private readonly onLabelChange = (): void => {
    this.requestUpdate();
  };
}

declare global {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- augmenting a DOM lib interface
  interface HTMLElementTagNameMap {
    'mndw-field': MndwField;
  }
}
