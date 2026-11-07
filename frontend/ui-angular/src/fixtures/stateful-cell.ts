import {Component, Input, type OnDestroy, type OnInit} from '@angular/core';

export interface StatefulRow {
  id: string;
  name: string;
}

export const angularCellLifecycle = {constructed: 0, mounted: 0, destroyed: 0};

@Component({
  selector: 'stateful-cell',
  template:
    '<button class="stateful-cell" (click)="count = count + 1">{{ count }}|{{ value }}|{{ row.name }}|{{ colId }}</button>',
})
export class StatefulCell implements OnInit, OnDestroy {
  @Input()
  public row!: StatefulRow;

  @Input()
  public value!: string;

  @Input()
  public colId!: string;

  public count = 0;

  constructor() {
    angularCellLifecycle.constructed += 1;
  }

  public ngOnInit(): void {
    angularCellLifecycle.mounted += 1;
  }

  public ngOnDestroy(): void {
    angularCellLifecycle.destroyed += 1;
  }
}
