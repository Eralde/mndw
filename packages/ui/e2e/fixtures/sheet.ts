import '@mndw/sdk/tokens.css';
import {defineMndwUi} from '../../src/index';

defineMndwUi();

const select = document.createElement('mndw-select') as HTMLElement & {label: string};

select.label = 'Choose interface';

const optionCount = Number(new URLSearchParams(location.search).get('count') ?? '80');

for (let index = 1; index <= optionCount; index++) {
  const option = document.createElement('mndw-option') as HTMLElement & {value: string};

  option.value = `option-${index}`;
  option.textContent = `Interface ${index}`;
  select.appendChild(option);
}

document.body.appendChild(select);
document.documentElement.dataset.ready = 'true';
