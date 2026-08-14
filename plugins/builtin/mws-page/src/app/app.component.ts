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
import {ExtraFeaturesBannerStore} from '../services/extra-features-banner.store';
import {MwsDataService} from '../services/mws-data.service';
import {openAutoLayoutConfirmation} from './auto-layout-confirmation';
import {type ExtraFeaturesPopoverController, openExtraFeaturesPopover} from './extra-features-popover';
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
  private readonly bannerStore = inject(ExtraFeaturesBannerStore);
  protected readonly positions = inject(NodePositionStore);
  protected readonly selectedTab = signal<'map' | 'nodes' | 'clients'>('map');
  protected readonly quickFilter = signal<NodeQuickFilter>('none');
  protected readonly editMode = signal(false);
  protected readonly selectedNodeId = signal<string | null>(null);
  protected readonly popoverOpen = signal(false);
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
  private popoverController: ExtraFeaturesPopoverController | null = null;

  public constructor() {
    effect(() => {
      const id = this.selectedNodeId();

      if (id !== null && findNodeById(this.data.roots(), id) === null) {
        this.selectedNodeId.set(null);
      }
    });
    effect(() => {
      const availability = this.data.extraFeaturesAvailability();

      this.popoverController?.update(availability);
    });
  }

  public ngOnInit(): void {
    this.data.start();
    void this.bannerStore.load();
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
    this.popoverController?.close();
    this.popoverController = null;
  }

  protected extraFeaturesTone(): 'neutral' | 'info' | 'success' | 'warning' {
    const state = this.data.extraFeaturesPresentation();

    return state === 'active'
      ? 'success'
      : state === 'incompatible'
      ? 'warning'
      : state === 'checking' || state === 'starting'
      ? 'info'
      : 'neutral';
  }

  protected extraFeaturesBadgeText(): string {
    return this.t(`extra-features.badge.${this.data.extraFeaturesPresentation()}`);
  }

  protected extraFeaturesIcon(): string {
    const state = this.data.extraFeaturesPresentation();

    return state === 'active'
      ? '✓'
      : state === 'incompatible'
      ? '!'
      : state === 'checking' || state === 'starting'
      ? '…'
      : 'i';
  }

  protected showExtraFeaturesSetup(): boolean {
    return this.data.extraFeaturesPresentation() === 'unavailable'
      && this.bannerStore.loaded()
      && !this.bannerStore.dismissed();
  }

  protected dismissExtraFeaturesBanner(): void {
    this.bannerStore.dismiss();
  }

  protected openExtraFeatures(event: Event): void {
    const anchor = event.currentTarget;

    if (!(anchor instanceof HTMLElement)) {
      return;
    }

    if (this.popoverController !== null) {
      this.popoverController.close();

      return;
    }

    const controller = openExtraFeaturesPopover(
      this.overlay,
      anchor,
      this.data.extraFeaturesAvailability(),
      (key, values) => this.t(key, values),
    );

    this.popoverController = controller;
    this.popoverOpen.set(true);
    void controller.closed.then(() => {
      if (this.popoverController === controller) {
        this.popoverController = null;
        this.popoverOpen.set(false);
      }
    });
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
