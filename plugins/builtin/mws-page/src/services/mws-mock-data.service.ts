import {Injectable, inject} from '@angular/core';
import {createLargeMockSnapshot} from '../mock/large-mock-data';
import {MWS_MOCK_OPTIONS} from '../tokens';
import {MwsDataService} from './mws-data.service';

@Injectable()
export class MwsMockDataService extends MwsDataService {
  private readonly mockOptions = inject(MWS_MOCK_OPTIONS);

  public override start(): void {
    const snapshot = createLargeMockSnapshot(this.mockOptions.extenders, this.mockOptions.clients);

    this.setExtraFeaturesAvailability('unavailable');
    this.publishSnapshot(snapshot.version, snapshot.members, snapshot.hosts, snapshot.bridge);
  }
}
