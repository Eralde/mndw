import {
  ApplicationRef,
  Component,
  EnvironmentInjector,
  Input,
  type InputSignal,
  type InputSignalWithTransform,
  type Type,
  input,
} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {describe, expect, expectTypeOf, it, vi} from 'vitest';
import {StatefulCell, angularCellLifecycle} from './fixtures/stateful-cell.js';
import {type AngularCellEnv, type AngularCellShape, type AngularInput, angularCell} from './angular-cell.js';

interface TestRow {
  id: string;
  name: string;
}

@Component({selector: 'full-cell', template: '<span class="cell">{{ row.name }}|{{ value }}|{{ colId }}</span>'})
class FullCell {
  @Input()
  public row!: TestRow;
  @Input()
  public value!: string;
  @Input()
  public colId!: string;
}

@Component({selector: 'row-only-cell', template: '<span class="cell">{{ row.name }}</span>'})
class RowOnlyCell {
  @Input()
  public row!: TestRow;
}

@Component({selector: 'alias-cell', template: '<span class="cell">{{ row.name }}</span>'})
class AliasCell {
  @Input('myRow')
  public row!: TestRow;
}

@Component({selector: 'required-cell', template: '<span class="cell">{{ row().name }}</span>'})
class RequiredCell {
  public readonly row = input.required<TestRow>();
}

@Component({selector: 'optional-cell', template: '<span class="cell">{{ row()?.name }}</span>'})
class OptionalCell {
  public readonly row = input<TestRow>();
}

@Component({selector: 'empty-cell', template: '<span class="cell">static</span>'})
class EmptyCell {}

function env(): AngularCellEnv {
  return {
    applicationRef: TestBed.inject(ApplicationRef),
    environmentInjector: TestBed.inject(EnvironmentInjector),
  };
}

function compileComponent<T>(component: Type<T>): void {
  const fixture = TestBed.createComponent(component);

  fixture.destroy();
}

function context(row: TestRow = {id: 'a', name: 'A'}): {node: HTMLElement; row: TestRow; value: string; colId: string} {
  return {node: document.createElement('div'), row, value: 'V', colId: 'name'};
}

function resetStatefulCellLifecycle(): void {
  const fixture = TestBed.createComponent(StatefulCell);

  fixture.destroy();
  angularCellLifecycle.constructed = 0;
  angularCellLifecycle.mounted = 0;
  angularCellLifecycle.destroyed = 0;
}

type IsAssignable<A, B> = A extends B ? true : false;

describe('angularCell types', () => {
  it('types AngularInput as a plain value or an optional/required signal', () => {
    expectTypeOf<AngularInput<TestRow>>().toEqualTypeOf<
      TestRow | InputSignal<TestRow> | InputSignal<TestRow | undefined>
    >();
  });

  it('accepts decorator, required, and optional signal input components', () => {
    expectTypeOf<IsAssignable<FullCell, AngularCellShape<TestRow, string>>>().toEqualTypeOf<true>();
    expectTypeOf<IsAssignable<RequiredCell, AngularCellShape<TestRow, string>>>().toEqualTypeOf<true>();
    expectTypeOf<IsAssignable<OptionalCell, AngularCellShape<TestRow, string>>>().toEqualTypeOf<true>();
  });

  it('rejects a signal transform whose write type excludes the row type', () => {
    expectTypeOf<IsAssignable<InputSignalWithTransform<TestRow, string>, AngularInput<TestRow>>>().toEqualTypeOf<
      false
    >();
  });
});

describe('angularCell runtime', () => {
  it('mounts a component into the parked node and sets declared inputs', () => {
    compileComponent(FullCell);

    const renderer = angularCell<TestRow, string>()(FullCell, env())();
    const ctx = context();

    renderer.mount(ctx);

    expect(ctx.node.textContent).toBe('A|V|name');
  });

  it('sets only the declared subset of inputs', () => {
    compileComponent(RowOnlyCell);

    const renderer = angularCell<TestRow, string>()(RowOnlyCell, env())();
    const ctx = context();

    renderer.mount(ctx);

    expect(ctx.node.textContent).toBe('A');
  });

  it('maps a template alias to the component property', () => {
    compileComponent(AliasCell);

    const renderer = angularCell<TestRow, string>()(AliasCell, env())();
    const ctx = context();

    renderer.mount(ctx);

    expect(ctx.node.textContent).toBe('A');
  });

  it('updates the component in place on same-key changes', () => {
    compileComponent(FullCell);

    const renderer = angularCell<TestRow, string>()(FullCell, env())();
    const ctx = context();

    renderer.mount(ctx);
    renderer.update({...ctx, row: {id: 'a', name: 'A2'}, value: 'V2'});

    expect(ctx.node.textContent).toBe('A2|V2|name');
  });

  it('throws a deterministic error when no cell input is declared', () => {
    compileComponent(EmptyCell);

    expect(() => angularCell<TestRow, string>()(EmptyCell, env())).toThrow(/row.*value.*colId/);
  });

  it('attaches once and detaches on teardown', () => {
    compileComponent(FullCell);

    const appRef = TestBed.inject(ApplicationRef);
    const attachSpy = vi.spyOn(appRef, 'attachView');
    const detachSpy = vi.spyOn(appRef, 'detachView');

    const renderer = angularCell<TestRow, string>()(FullCell, env())();
    const ctx = context();

    renderer.mount(ctx);
    renderer.destroy();

    expect(attachSpy).toHaveBeenCalledTimes(1);
    expect(detachSpy).toHaveBeenCalledTimes(1);
  });
});

describe('angularCell stateful lifecycle', () => {
  it('keeps local state and component instance across update', () => {
    resetStatefulCellLifecycle();

    const renderer = angularCell<TestRow, string>()(StatefulCell, env())();
    const ctx = context();

    renderer.mount(ctx);

    const button = ctx.node.querySelector<HTMLButtonElement>('.stateful-cell');

    button?.click();

    renderer.update({...ctx, row: {...ctx.row, name: 'A updated'}, value: 'V2'});

    expect(ctx.node.querySelector('.stateful-cell')).toBe(button);
    expect(ctx.node.textContent).toBe('1|V2|A updated|name');
    expect(angularCellLifecycle.constructed).toBe(1);
    expect(angularCellLifecycle.mounted).toBe(1);

    renderer.destroy();
  });

  it('destroys exactly once and remounts with fresh local state', () => {
    resetStatefulCellLifecycle();

    const renderer = angularCell<TestRow, string>()(StatefulCell, env())();
    const ctx = context();

    renderer.mount(ctx);
    ctx.node.querySelector<HTMLButtonElement>('.stateful-cell')?.click();
    renderer.destroy();
    renderer.destroy();

    expect(angularCellLifecycle.destroyed).toBe(1);

    renderer.mount(ctx);

    expect(ctx.node.textContent).toBe('0|V|A|name');
    expect(angularCellLifecycle.constructed).toBe(2);
    expect(angularCellLifecycle.mounted).toBe(2);

    renderer.destroy();

    expect(angularCellLifecycle.destroyed).toBe(2);
  });
});
