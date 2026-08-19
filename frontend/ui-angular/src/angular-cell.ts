import {
  type ApplicationRef,
  type ComponentRef,
  type EnvironmentInjector,
  type InputSignal,
  type Type,
  createComponent,
  reflectComponentType,
} from '@angular/core';
import type {CellContext, CellRenderer} from '@mndw/ui';

export interface AngularCellEnv {
  applicationRef: ApplicationRef;
  environmentInjector: EnvironmentInjector;
}

export type AngularInput<T> = T | InputSignal<T> | InputSignal<T | undefined>;

export interface AngularCellShape<Row, Value> {
  row?: AngularInput<Row>;
  value?: AngularInput<Value>;
  colId?: AngularInput<string>;
}

type CellInputName = 'row' | 'value' | 'colId';

const CELL_INPUT_NAMES: readonly CellInputName[] = ['row', 'value', 'colId'];

function reflectCellInputs<C>(Component: Type<C>): [CellInputName, string][] {
  const metadata = reflectComponentType(Component);

  if (metadata === null) {
    return [];
  }

  const reflected: [CellInputName, string][] = [];

  for (const input of metadata.inputs) {
    if ((CELL_INPUT_NAMES as readonly string[]).includes(input.propName)) {
      reflected.push([input.propName as CellInputName, input.templateName]);
    }
  }

  return reflected;
}

export function angularCell<Row, Value = unknown>() {
  return <C extends AngularCellShape<Row, Value>>(
    Component: Type<C>,
    env: AngularCellEnv,
  ): () => CellRenderer<Row, Value> => {
    const reflected = reflectCellInputs(Component);

    if (reflected.length === 0) {
      throw new Error('angularCell component must declare at least one of row, value, or colId as an input');
    }

    return () => {
      let componentRef: ComponentRef<C> | undefined;

      const apply = (context: CellContext<Row, Value>): void => {
        if (componentRef === undefined) {
          throw new Error('Cannot update a cell renderer before mount');
        }

        for (const [propName, templateName] of reflected) {
          componentRef.setInput(templateName, context[propName]);
        }

        componentRef.changeDetectorRef.detectChanges();
      };

      return {
        mount(context) {
          componentRef = createComponent(Component, {
            environmentInjector: env.environmentInjector,
            hostElement: context.node,
          });
          env.applicationRef.attachView(componentRef.hostView);
          apply(context);
        },
        update(context) {
          apply(context);
        },
        destroy() {
          if (componentRef !== undefined) {
            env.applicationRef.detachView(componentRef.hostView);
            componentRef.destroy();
            componentRef = undefined;
          }
        },
      };
    };
  };
}
