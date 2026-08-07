import {describe, expect, it, vi} from 'vitest';
import type {ServiceInjector} from '@mndw/sdk';
import {createReadonlyInjector, createServiceFacade} from './service-facade.js';

describe('createServiceFacade', () => {
  it('forwards an allowlisted method to the target with this and args', () => {
    const target = {
      value: 7,
      add(this: {value: number}, n: number): number {
        return this.value + n;
      },
    };
    const facade = createServiceFacade(target, ['add']);

    expect(facade.add(3)).toBe(10);
  });

  it('omits methods not in the allowlist', () => {
    const target = {a(): void {}, b(): void {}};
    const facade = createServiceFacade(target, ['a']);

    expect(typeof facade.a).toBe('function');
    expect((facade as unknown as Record<string, unknown>).b).toBeUndefined();
  });

  it('skips allowlisted names that are not functions on the target', () => {
    const target = {a(): void {}, notFn: 5};
    const facade = createServiceFacade(target, ['a', 'notFn']);

    expect((facade as unknown as Record<string, unknown>).notFn).toBeUndefined();
  });

  it('is frozen: reassigning a method throws in strict mode', () => {
    const target = {a(): void {}};
    const facade = createServiceFacade(target, ['a']);

    expect(() => {
      (facade as unknown as Record<string, unknown>).a = (): string => 'evil';
    }).toThrow(TypeError);
  });

  it('does not let facade mutation reach the target', () => {
    const original = (): string => 'ok';
    const target = {a: original};
    const facade = createServiceFacade(target, ['a']);

    expect(() => {
      (facade as unknown as Record<string, unknown>).a = (): string => 'evil';
    }).toThrow(TypeError);
    expect(target.a).toBe(original);
  });

  it('has a null prototype so it cannot hand the plugin Object.prototype', () => {
    const target = {a(): void {}};
    const facade = createServiceFacade(target, ['a']);

    expect(Object.getPrototypeOf(facade)).toBeNull();
  });
});

describe('createReadonlyInjector', () => {
  it('delegates get and has to the underlying injector', () => {
    const get = vi.fn((_token: string | symbol) => 'svc') as unknown as ServiceInjector['get'];
    const has = vi.fn((_token: string | symbol): boolean => true) as ServiceInjector['has'];
    const view = createReadonlyInjector({get, has});

    expect(view.get('token')).toBe('svc');
    expect(view.has('token')).toBe(true);
    expect(get).toHaveBeenCalledWith('token');
    expect(has).toHaveBeenCalledWith('token');
  });

  it('does not expose register', () => {
    const view = createReadonlyInjector({get: vi.fn(), has: vi.fn()});

    expect((view as unknown as Record<string, unknown>).register).toBeUndefined();
  });

  it('is frozen', () => {
    const view = createReadonlyInjector({get: vi.fn(), has: vi.fn()});

    expect(() => {
      (view as unknown as Record<string, unknown>).register = (): void => {};
    }).toThrow(TypeError);
  });

  it('has a null prototype', () => {
    const view = createReadonlyInjector({get: vi.fn(), has: vi.fn()});

    expect(Object.getPrototypeOf(view)).toBeNull();
  });
});
