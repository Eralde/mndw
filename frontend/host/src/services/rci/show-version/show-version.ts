import {RciQuery} from '@rci-tools/core';
import {Observable, map} from 'rxjs';
import {rciService} from '../../rci.service.js';
import {showVersionResponseSchema} from './show-version.schema.js';

interface FwBlock {
  exact: string;
  cdate: string;
}

interface NdwBlock {
  version: string;
}

export interface ShowVersion {
  release: string;
  sandbox?: string;
  title?: string;
  arch: string;
  ndm: FwBlock;
  bsp: FwBlock;
  ndw: {
    version?: string;
    features: string;
    components: string;
  };
  ndw3?: NdwBlock;
  ndw4?: NdwBlock;
  manufacturer: string;
  vendor: string;
  series: string;
  model: string;
  hw_version: string;
  hw_type?: string;
  hw_id: string;
  device: string;
  class?: string;
  region: string;
  description: string;
}

export const getShowVersion = (): Observable<ShowVersion> => {
  const query: RciQuery = {
    path: 'show.version',
  };

  return rciService.driver.queue(query)
    .pipe(
      map((response) => showVersionResponseSchema.parse(response)),
    );
};
