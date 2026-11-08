export function mount(root: HTMLElement): void {
  const field = document.createElement('mndw-field');
  const slider = document.createElement('mndw-slider');

  field.setAttribute('label', 'Transmit power');
  slider.setAttribute('name', 'power');
  slider.setAttribute('min', '0');
  slider.setAttribute('max', '20');
  slider.setAttribute('step', '5');
  slider.setAttribute('value', '10');
  slider.valueFormatter = (value): string => {
    return `${value} dBm`;
  };
  field.appendChild(slider);
  root.appendChild(field);
}
