import {defineMndwVitestProject} from '@mndw/sdk/testing/vitest-project';

export default defineMndwVitestProject({environment: 'happy-dom', extraExclude: ['e2e/**']});
