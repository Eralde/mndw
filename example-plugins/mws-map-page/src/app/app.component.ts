import {Component, Input, type OnInit, ViewChild, computed, effect, inject, signal} from '@angular/core';
import {MwsGraphComponent} from '../components/mws-graph/mws-graph.component';
import {findNodeById, hasUpdate} from '../domain/mws/map-builder';
import type {MwsNode} from '../domain/mws/mws.types';
import {NodePositionStore} from '../services/node-position.store';
import {MwsDataService} from '../services/mws-data.service';
import {MWS_MOCK_OPTIONS} from '../tokens';

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
  imports: [MwsGraphComponent],
})
export class AppComponent implements OnInit {
  @Input({required: true})
  public openNodeDrawer: (nodeId: string, title: string, onClose: () => void) => void = () => undefined;

  @ViewChild(MwsGraphComponent)
  private graph?: MwsGraphComponent;

  protected readonly data = inject(MwsDataService);
  protected readonly mockOptions = inject(MWS_MOCK_OPTIONS);
  protected readonly positions = inject(NodePositionStore);
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
  protected readonly summaryText = computed<string>(() => {
    const summary = this.summary();
    const segments = [`${summary.total} ${summary.total === 1 ? 'node' : 'nodes'}`];

    if (summary.offline > 0) {
      segments.push(`${summary.offline} offline`);
    }

    if (summary.clients > 0) {
      segments.push(`${summary.clients} ${summary.clients === 1 ? 'client' : 'clients'}`);
    }

    if (summary.updates > 0) {
      segments.push(`${summary.updates} ${summary.updates === 1 ? 'update' : 'updates'} available`);
    }

    const updatedAt = this.data.lastUpdatedAt();

    if (updatedAt !== null) {
      const age = Math.max(0, Math.floor((this.data.freshnessNow() - updatedAt) / 1000));

      segments.push(`updated ${age}s ago`);
    }

    return segments.join(' · ');
  });

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
  }

  protected onNodeSelected(nodeId: string): void {
    const node = findNodeById(this.data.roots(), nodeId);

    if (node === null) {
      return;
    }

    this.selectedNodeId.set(nodeId);
    this.openNodeDrawer(nodeId, node.name, () => this.selectedNodeId.set(null));
  }

  protected onNodePositionChanged(position: {id: string; x: number; y: number}): void {
    this.positions.set(position.id, {x: position.x, y: position.y});
  }

  protected toggleEditMode(): void {
    this.editMode.update((value) => !value);
  }

  protected autoLayout(): void {
    void this.positions.clear();
    this.graph?.resetView();
  }

  protected doneEditing(): void {
    this.editMode.set(false);
  }

  protected retry(): void {
    this.data.retry();
  }
}
