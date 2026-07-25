import {Component, Input, type OnInit, inject} from '@angular/core';
import {MwsGraphComponent} from '../components/mws-graph/mws-graph.component';
import {findNodeById} from '../domain/mws/map-builder';
import {MwsDataService} from '../services/mws-data.service';
import {MWS_MOCK_OPTIONS} from '../tokens';

@Component({
  selector: 'mws-map-app',
  standalone: true,
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss'],
  imports: [MwsGraphComponent],
})
export class AppComponent implements OnInit {
  @Input({required: true})
  public openNodeDrawer: (nodeId: string, title: string) => void = () => undefined;

  protected readonly data = inject(MwsDataService);
  protected readonly mockOptions = inject(MWS_MOCK_OPTIONS);

  public ngOnInit(): void {
    this.data.start();
  }

  protected onNodeSelected(nodeId: string): void {
    const node = findNodeById(this.data.roots(), nodeId);

    this.openNodeDrawer(nodeId, node?.name ?? nodeId);
  }

  protected retry(): void {
    this.data.retry();
  }
}
