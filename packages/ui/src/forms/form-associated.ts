export type FormValue = string | File | FormData | null;
export type FormRestoreMode = 'autocomplete' | 'restore';

export interface FormAssociatedOptions {
  isExplicitlyDisabled: () => boolean;
  onReset: () => void;
  onStateRestore: (state: FormValue, mode: FormRestoreMode) => void;
  onDisabledChange?: (effectiveDisabled: boolean) => void;
}

export class FormAssociatedController<Host extends HTMLElement> {
  public readonly internals: ElementInternals | null;

  private readonly host: Host;
  private readonly options: FormAssociatedOptions;
  private fieldsetDisabled = false;
  private initialAttributes: Map<string, string | null> | null = null;

  constructor(host: Host, options: FormAssociatedOptions) {
    this.host = host;
    this.options = options;
    this.internals = typeof host.attachInternals === 'function' ? host.attachInternals() : null;
  }

  public get form(): HTMLFormElement | null {
    return this.internals?.form ?? null;
  }

  public get labels(): HTMLLabelElement[] {
    const labels = this.internals?.labels;

    return labels ? Array.from(labels) as HTMLLabelElement[] : [];
  }

  public get effectiveDisabled(): boolean {
    return this.options.isExplicitlyDisabled() || this.fieldsetDisabled;
  }

  public captureInitialAttributes(attributes: readonly string[]): void {
    if (this.initialAttributes) {
      return;
    }

    this.initialAttributes = new Map(attributes.map((attribute) => [attribute, this.host.getAttribute(attribute)]));
  }

  public restoreInitialAttributes(): void {
    if (!this.initialAttributes) {
      return;
    }

    for (const [attribute, value] of this.initialAttributes) {
      if (value === null) {
        this.host.removeAttribute(attribute);
      } else {
        this.host.setAttribute(attribute, value);
      }
    }
  }

  public formDisabledCallback(disabled: boolean): void {
    this.fieldsetDisabled = disabled;
    this.options.onDisabledChange?.(this.effectiveDisabled);
  }

  public formResetCallback(): void {
    this.restoreInitialAttributes();
    this.options.onReset();
  }

  public formStateRestoreCallback(state: FormValue, mode: FormRestoreMode): void {
    this.options.onStateRestore(state, mode);
  }

  public setFormValue(value: FormValue, state?: FormValue): void {
    if (!this.internals) {
      return;
    }

    if (state === undefined) {
      this.internals.setFormValue(value);
    } else {
      this.internals.setFormValue(value, state);
    }
  }

  public setValidity(flags: ValidityStateFlags, message = ''): void {
    if (!this.internals) {
      return;
    }

    if (Object.keys(flags).length === 0) {
      this.internals.setValidity({});
    } else {
      this.internals.setValidity(flags, message);
    }
  }

  public clearValidity(): void {
    this.setValidity({});
  }
}
