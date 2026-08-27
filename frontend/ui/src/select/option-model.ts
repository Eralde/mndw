import {MNDW_OPTION_TAG} from './option.js';

export interface OptionModel {
  value: string;
  label: string;
  labelNodes: Node[];
  disabled: boolean;
}

export function readOptions(host: Element): OptionModel[] {
  const elements = host.querySelectorAll(MNDW_OPTION_TAG);

  return Array.from(elements, (element) => {
    const value = element.getAttribute('value') ?? '';
    const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
    const labelNodes = Array.from(element.childNodes, (node) => node.cloneNode(true));

    return {value, label: text === '' ? value : text, labelNodes, disabled: element.hasAttribute('disabled')};
  });
}
