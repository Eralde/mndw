import type {MwsDataService} from './mws-data.service';

// @ts-expect-error MwsDataService status signals are read-only.
export type FacadeSetterMustNotExist = MwsDataService['extraFeaturesAvailability']['set'];
