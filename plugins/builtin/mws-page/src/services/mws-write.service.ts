import {Injectable, inject} from '@angular/core';
import type {BackendClient} from '@mndw/sdk';
import {MWSD_BACKEND} from '../tokens';
import {MwsDataService} from './mws-data.service';

export interface MwsWriteStatus {
  readonly status: string;
  readonly code: string;
  readonly ident: string;
  readonly message: string;
}

export interface MwsWriteStep {
  readonly step: string;
  readonly ok: boolean;
  readonly status: MwsWriteStatus[];
}

export interface MwsWriteResult {
  readonly ok: boolean;
  readonly steps: MwsWriteStep[];
}

@Injectable()
export class MwsWriteService {
  private readonly backend: BackendClient | null = inject(MWSD_BACKEND);
  private readonly data = inject(MwsDataService);

  public async setPower(
    nodeId: string,
    interfaceName: 'WifiMaster0' | 'WifiMaster1',
    power: number,
    persist = true,
  ): Promise<MwsWriteResult> {
    if (this.data.extraFeaturesAvailability() !== 'active') {
      throw new Error('mws-page extra features are unavailable');
    }

    if (this.backend === null) {
      throw new Error('mws-page write backend is unavailable');
    }

    const response = await this.backend.fetch('write', {
      body: {
        operation: 'wifi.set-power',
        nodeId,
        params: {interface: interfaceName, power, persist},
      },
    });

    if (!response.ok) {
      throw new Error(`mws-page write failed with HTTP ${response.status}`);
    }

    return await response.json() as MwsWriteResult;
  }
}
