import {createTestI18n} from '@mndw/sdk/testing';
import enCatalog from '../i18n/en.json';

export function createI18n() {
  return createTestI18n(enCatalog);
}

export function createContainer(): HTMLElement {
  const container = document.createElement('div');

  document.body.append(container);

  return container;
}
