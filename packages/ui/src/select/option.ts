export const MNDW_OPTION_TAG = 'mndw-option';
export const MNDW_OPTION_CHANGE_EVENT = 'mndwoptionchange';

export class MndwOption extends HTMLElement {
  public static observedAttributes: string[] = ['value', 'disabled'];

  private observer: MutationObserver | null = null;
  private skipNextTextMutation = false;

  public override get textContent(): string {
    return super.textContent;
  }

  public override set textContent(next: string) {
    const previous = super.textContent;

    super.textContent = next;

    if (previous !== next) {
      this.skipNextTextMutation = true;
      this.announce();
    }
  }

  public get value(): string {
    return this.getAttribute('value') ?? '';
  }

  public set value(next: string) {
    this.setAttribute('value', next);
  }

  public get disabled(): boolean {
    return this.hasAttribute('disabled');
  }

  public set disabled(next: boolean) {
    this.toggleAttribute('disabled', next);
  }

  public connectedCallback(): void {
    if (!this.observer && typeof MutationObserver !== 'undefined') {
      const observer = new MutationObserver(() => {
        if (this.skipNextTextMutation) {
          this.skipNextTextMutation = false;

          return;
        }

        this.announce();
      });

      if (typeof observer.observe === 'function') {
        this.observer = observer;
        observer.observe(this, {characterData: true, childList: true, subtree: true});
      }
    }
  }

  public disconnectedCallback(): void {
    this.observer?.disconnect();
  }

  public attributeChangedCallback(_name: string, previous: string | null, next: string | null): void {
    if (previous === next) {
      return;
    }

    this.announce();
  }

  private announce(): void {
    this.dispatchEvent(new CustomEvent(MNDW_OPTION_CHANGE_EVENT, {bubbles: true, composed: false}));
  }
}
