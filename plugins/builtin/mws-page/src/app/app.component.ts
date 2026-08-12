import {
  CUSTOM_ELEMENTS_SCHEMA,
  Component,
  type OnDestroy,
  type OnInit,
  ViewChild,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import type {Subscription} from 'rxjs';
import {MwsGraphComponent} from '../components/mws-graph/mws-graph.component';
import {MwsClientsTableComponent} from '../components/clients-table/clients-table.component';
import {MwsNodesTableComponent} from '../components/nodes-table/nodes-table.component';
import {findNodeById, hasUpdate} from '../domain/mws/map-builder';
import type {MwsNode} from '../domain/mws/mws.types';
import {NodePositionStore} from '../services/node-position.store';
import {MwsDataService} from '../services/mws-data.service';
import {openAutoLayoutConfirmation} from './auto-layout-confirmation';
import {MWS_MOCK_OPTIONS, MWS_PAGE_ROUTE, OVERLAY, TRANSLATOR} from '../tokens';
import type {NodeQuickFilter} from '../components/nodes-table/node-rows';

interface MapSummary {
  total: number;
  offline: number;
  clients: number;
  updates: number;
}

function walkForest(roots: MwsNode[], visit: (node: MwsNode) => void): void {
  const stack = [...roots];

  while (stack.length > 0) {
    const node = stack.pop();

    if (node === undefined) {
      continue;
    }

    visit(node);

    for (const child of node.children) {
      stack.push(child.node);
    }
  }
}

@Component({
  selector: 'mws-map-app',
  standalone: true,
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss'],
  imports: [MwsGraphComponent, MwsNodesTableComponent, MwsClientsTableComponent],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
})
export class AppComponent implements OnDestroy, OnInit {
  public readonly openNodeDrawer = input.required<
    (nodeId: string, title: string, onClose: () => void) => void
  >();

  @ViewChild(MwsGraphComponent)
  private graph?: MwsGraphComponent;

  protected readonly data = inject(MwsDataService);
  protected readonly translator = inject(TRANSLATOR);
  protected readonly mockOptions = inject(MWS_MOCK_OPTIONS);
  private readonly pageRoute = inject(MWS_PAGE_ROUTE, {optional: true});
  private readonly overlay = inject(OVERLAY);
  protected readonly positions = inject(NodePositionStore);
  protected readonly selectedTab = signal<'map' | 'nodes' | 'clients'>('map');
  protected readonly quickFilter = signal<NodeQuickFilter>('none');
  protected readonly editMode = signal(false);
  protected readonly selectedNodeId = signal<string | null>(null);
  protected readonly summary = computed<MapSummary>(() => {
    const result: MapSummary = {total: 0, offline: 0, clients: 0, updates: 0};

    walkForest(this.data.roots(), (node) => {
      result.total += 1;
      result.offline += node.isOnline ? 0 : 1;
      result.clients += node.clients.length;
      result.updates += hasUpdate(node) ? 1 : 0;
    });

    return result;
  });
  protected readonly mapUpdatedText = computed<string | null>(() => {
    const updatedAt = this.data.lastUpdatedAt();

    if (updatedAt !== null) {
      const age = Math.max(0, Math.floor((this.data.freshnessNow() - updatedAt) / 1000));

      return this.t('summary.map-updated', {seconds: age});
    }

    return null;
  });
  private pageRouteSubscription?: Subscription;

  public constructor() {
    effect(() => {
      const id = this.selectedNodeId();

      if (id !== null && findNodeById(this.data.roots(), id) === null) {
        this.selectedNodeId.set(null);
      }
    });
  }

  public ngOnInit(): void {
    this.data.start();
    void this.positions.load();

    const pageRoute = this.pageRoute;

    if (pageRoute !== null && pageRoute !== undefined) {
      this.pageRouteSubscription = pageRoute.childPath$.subscribe((childPath) => {
        this.selectedTab.set(childPath === '/clients' ? 'clients' : childPath === '/nodes' ? 'nodes' : 'map');

        if (childPath === '') {
          void pageRoute.navigate('/topology', {replace: true}).catch(() => undefined);
        }
      });
    }
  }

  public ngOnDestroy(): void {
    this.pageRouteSubscription?.unsubscribe();
  }

  protected t(key: string, values?: Record<string, unknown>): string {
    return this.translator.t(key, values);
  }

  protected onNodeSelected(nodeId: string): void {
    const node = findNodeById(this.data.roots(), nodeId);

    if (node === null) {
      return;
    }

    this.selectedNodeId.set(nodeId);
    this.openNodeDrawer()(nodeId, node.name, () => this.selectedNodeId.set(null));
  }

  protected onNodePositionChanged(position: {id: string; x: number; y: number}): void {
    this.positions.set(position.id, {x: position.x, y: position.y});
  }

  protected toggleEditMode(): void {
    this.editMode.update((value) => !value);
  }

  protected async autoLayout(): Promise<void> {
    const closed = await openAutoLayoutConfirmation(this.overlay, (key, values) => this.t(key, values));

    if (closed.result !== 'confirm') {
      return;
    }

    await this.positions.clear();
    this.graph?.resetView();
  }

  protected doneEditing(): void {
    this.editMode.set(false);
  }

  protected retry(): void {
    this.data.retry();
  }

  protected onTabChanged(event: Event): void {
    const rawValue = (event as CustomEvent<{value?: string}>).detail?.value;
    const value = rawValue === 'clients' || rawValue === 'nodes' ? rawValue : 'map';

    this.navigateToTab(value);
  }

  protected toggleQuickFilter(filter: Exclude<NodeQuickFilter, 'none'>): void {
    this.quickFilter.set(this.quickFilter() === filter ? 'none' : filter);
    this.navigateToTab('nodes');
  }

  protected isQuickFilterActive(filter: Exclude<NodeQuickFilter, 'none'>): boolean {
    return this.quickFilter() === filter;
  }

  private navigateToTab(value: 'map' | 'nodes' | 'clients'): void {
    this.selectedTab.set(value);

    if (this.pageRoute === null || this.pageRoute === undefined) {
      return;
    }

    const childPath = value === 'clients' ? '/clients' : value === 'nodes' ? '/nodes' : '/topology';

    void this.pageRoute.navigate(childPath).catch(() => undefined);
  }
}
