import {describe, expect, it} from 'vitest';
import {stubGraphGeometry} from './mws-graph-test-support';

describe('stubGraphGeometry', () => {
  it('provides deterministic layout dimensions', () => {
    const element = document.createElement('div');

    stubGraphGeometry(element, {width: 800, height: 600});

    expect(element.clientWidth).toBe(800);
    expect(element.clientHeight).toBe(600);
    expect(element.getBoundingClientRect().width).toBe(800);
    expect(element.getBoundingClientRect().height).toBe(600);
  });
});
