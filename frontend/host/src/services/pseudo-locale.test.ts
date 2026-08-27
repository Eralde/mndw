import {describe, expect, it} from 'vitest';
import {pseudoLocalize, pseudoLocalizeCatalog} from './pseudo-locale.js';

describe('pseudo locale', () => {
  it('adds brackets, accents, and deterministic expansion', () => {
    expect(pseudoLocalize('Settings')).toBe('[Ṡḗṫṫīṅġṡ~~~]');
  });

  it('transforms host catalog values without changing keys', () => {
    expect(pseudoLocalizeCatalog({title: 'Hello'})).toEqual({title: '[Ḧḗŀŀö~~]'});
  });

  it('transforms nested catalog values without changing their shape', () => {
    expect(pseudoLocalizeCatalog({menu: {title: 'Hello'}} as never)).toEqual({
      menu: {title: '[Ḧḗŀŀö~~]'},
    });
  });
});
