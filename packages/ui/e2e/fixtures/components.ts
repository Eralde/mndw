import '@mndw/sdk/tokens.css';
import '../../src/styles/kit.css';
import {defineMndwUi} from '../../src/index';

defineMndwUi();

const form = document.querySelector<HTMLFormElement>('#component-form');

if (!form) {
  throw new Error('component form missing');
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  document.documentElement.dataset.submitted = 'true';
  document.documentElement.dataset.formData = JSON.stringify([...new FormData(form).entries()]);
});

document.documentElement.dataset.ready = 'true';
