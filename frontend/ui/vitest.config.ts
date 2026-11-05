import {defineMndwVitestProject} from '@mndw/sdk/testing/vitest-project';

export default defineMndwVitestProject({environment: 'node', extraExclude: ['e2e/**']});
