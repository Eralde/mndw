import {
  ContentChildren,
  Directive,
  ElementRef,
  type EmbeddedViewRef,
  Input,
  QueryList,
  type Signal,
  TemplateRef,
  ViewContainerRef,
  inject,
} from '@angular/core';
import type {CellContext, CellRenderer, Column} from '@mndw/ui';

export interface MndwCellTemplateContext<Row, Value> {
  $implicit: Row;
  row: Row;
  value: Value;
  colId: string;
}

@Directive({
  selector: '[mndwCell]',
  standalone: true,
})
export class MndwCellDirective<Row = unknown, Value = unknown> {
  @Input('mndwCell')
  public id = '';

  @Input()
  public mndwCellRows?: Signal<readonly Row[]> | readonly Row[];

  private readonly templateRef = inject(TemplateRef<MndwCellTemplateContext<Row, Value>>);
  private readonly viewContainerRef = inject(ViewContainerRef);

  public static ngTemplateContextGuard<Row, Value>(
    _directive: MndwCellDirective<Row, Value>,
    _context: unknown,
  ): _context is MndwCellTemplateContext<Row, Value> {
    return true;
  }

  public createRendererFactory(): () => CellRenderer<Row, Value> {
    const templateRef = this.templateRef;
    const viewContainerRef = this.viewContainerRef;

    return () => {
      const context: MndwCellTemplateContext<Row, Value> = {
        $implicit: undefined as unknown as Row,
        row: undefined as unknown as Row,
        value: undefined as unknown as Value,
        colId: '',
      };
      let view: EmbeddedViewRef<MndwCellTemplateContext<Row, Value>> | undefined;

      const assign = (cellContext: CellContext<Row, Value>): void => {
        context.$implicit = cellContext.row;
        context.row = cellContext.row;
        context.value = cellContext.value;
        context.colId = cellContext.colId;
      };

      return {
        mount(cellContext) {
          assign(cellContext);
          view = viewContainerRef.createEmbeddedView(templateRef, context);

          for (const node of view.rootNodes) {
            cellContext.node.appendChild(node);
          }

          view.detectChanges();
        },
        update(cellContext) {
          if (view === undefined) {
            return;
          }

          assign(cellContext);
          view.detectChanges();
        },
        destroy() {
          view?.destroy();
          view = undefined;
        },
      };
    };
  }
}

@Directive({
  selector: 'mndw-table',
  standalone: true,
})
export class MndwTableDirective {
  @Input()
  public columns: Column<unknown>[] = [];

  @ContentChildren(MndwCellDirective)
  private readonly cells!: QueryList<MndwCellDirective>;

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement as HTMLElement & {
    columns: Column<unknown>[];
  };
  private readonly factories = new Map<string, () => CellRenderer>();

  public ngAfterContentInit(): void {
    this.cells.changes.subscribe(() => {
      this.applyColumns();
    });
    this.applyColumns();
  }

  public ngOnChanges(): void {
    this.applyColumns();
  }

  private applyColumns(): void {
    if (this.cells === undefined) {
      return;
    }

    for (const cell of this.cells) {
      if (!this.factories.has(cell.id)) {
        this.factories.set(cell.id, cell.createRendererFactory());
      }
    }

    this.host.columns = this.columns.map((column) => {
      const factory = this.factories.get(column.id);

      return factory === undefined ? column : {...column, renderer: factory};
    });
  }
}
