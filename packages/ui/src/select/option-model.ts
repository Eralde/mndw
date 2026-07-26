import {MNDW_OPTION_TAG} from './option.js';

export interface OptionModel {
  value: string;
  label: string;
  disabled: boolean;
}

export function readOptions(host: Element): OptionModel[] {
  const elements = host.querySelectorAll(MNDW_OPTION_TAG);

  return Array.from(elements, (element) => {
    const value = element.getAttribute('value') ?? '';
    const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();

    return {value, label: text === '' ? value : text, disabled: element.hasAttribute('disabled')};
  });
}
