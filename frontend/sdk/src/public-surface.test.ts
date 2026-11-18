import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {describe, expect, it} from 'vitest';

const EXPECTED_TYPE_EXPORTS = [
  'BackendApprovalStatus',
  'BackendBlocker',
  'BackendClient',
  'BackendCallOptions',
  'BackendErrorCode',
  'BackendFetchOptions',
  'BackendSocketOptions',
  'BackendStatus',
  'BackendStatusOptions',
  'BackendStatusState',
  'DeviceInfo',
  'DeviceInfoData',
  'DeviceUsb',
  'EventSource',
  'EventTopic',
  'HostNavigation',
  'HostTarget',
  'HistoryStatus',
  'KnownTelemetryUnit',
  'LoadState',
  'MndwEvent',
  'MndwPlugin',
  'MndwThemeName',
  'OverlayAnchor',
  'OverlayCloseEvent',
  'OverlayCloseReason',
  'OverlayKind',
  'OverlayLayer',
  'OverlayLayerOptions',
  'OverlayMount',
  'OverlayOpenOptions',
  'OverlayPlacement',
  'OverlayService',
  'OverlaySession',
  'PagePluginContext',
  'PageRoute',
  'PageRouteErrorCode',
  'PaletteTokenMap',
  'PersistentRciCapability',
  'PluginContext',
  'PluginEventFacade',
  'PluginI18n',
  'PluginInstance',
  'PluginTelemetry',
  'PluginRciManager',
  'PluginRciManagerMethod',
  'PluginResizeSize',
  'PluginStorage',
  'PluginTimers',
  'ProjectRange',
  'ProjectedBand',
  'ProjectedBandPoint',
  'ProjectedChartColor',
  'ProjectedPoint',
  'ProjectedSegment',
  'ProjectedSeries',
  'ProjectedSnapshot',
  'ProjectedValueDomain',
  'RefreshLoop',
  'RefreshLoopOptions',
  'Switchport',
  'Switchports',
  'TelemetryClient',
  'TelemetryGathering',
  'TelemetryClock',
  'TelemetryClockState',
  'TelemetryUnit',
  'ThemeName',
  'Ticker',
  'TickerTick',
  'TokenName',
  'Translator',
  'WidgetPluginContext',
];

const EXPECTED_RUNTIME_EXPORTS = [
  'BackendError',
  'BackendBadGateway',
  'BackendBlocked',
  'BackendDisabled',
  'BackendIncompatible',
  'BackendMaintenance',
  'BackendNotApproved',
  'BackendStarting',
  'BackendStatusQueryError',
  'BackendTransportMismatch',
  'BackendUnavailable',
  'BackendUnknownId',
  'EVENT_CAPABILITY_PATTERN',
  'MNDW_SCALE',
  'MNDW_TOKENS',
  'PERSISTENT_RCI_CAPABILITIES',
  'KNOWN_TELEMETRY_UNITS',
  'PLUGIN_RCI_MANAGER_METHODS',
  'PageRouteError',
  'SDK_VERSION',
  'TelemetryError',
  'eventCapabilitySchema',
  'historyStatus',
  'isBackendMaintenanceClose',
  'isKnownTelemetryUnit',
  'isPersistentRciCapability',
  'persistentRciCapabilitySchema',
  'pluginCapabilitySchema',
];

const EXPECTED_SUBPATHS = [
  '.',
  './angular',
  './bind-locale',
  './manifest.schema.json',
  './internal/timers',
  './rrd',
  './svelte',
  './testing',
  './testing/vitest-project',
  './tokens',
  './tokens.css',
  './vue',
];

const EXPECTED_PUBLISHED_SUBPATHS = EXPECTED_SUBPATHS.filter((subpath) => subpath !== './internal/timers');

describe('SDK public surface', () => {
  it('exports exactly the public types and values', () => {
    const indexPath = fileURLToPath(new URL('./index.ts', import.meta.url));
    const program = ts.createProgram([indexPath], {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      noEmit: true,
    });
    const sourceFile = program.getSourceFile(indexPath);

    expect(sourceFile).toBeDefined();

    if (!sourceFile) {
      throw new Error(`Could not load SDK entry point: ${indexPath}`);
    }

    const moduleSymbol = program.getTypeChecker().getSymbolAtLocation(sourceFile);

    expect(moduleSymbol).toBeDefined();

    if (!moduleSymbol) {
      throw new Error(`Could not find SDK entry point module symbol: ${indexPath}`);
    }

    const exports = program
      .getTypeChecker()
      .getExportsOfModule(moduleSymbol)
      .map((symbol) => symbol.getName())
      .sort();

    expect(exports).toEqual([...EXPECTED_RUNTIME_EXPORTS, ...EXPECTED_TYPE_EXPORTS].sort());
  });

  it('exports exactly the public runtime values', async () => {
    const runtime = await import('./index.js');

    expect(Object.keys(runtime).sort()).toEqual([...EXPECTED_RUNTIME_EXPORTS].sort());
  });

  it('exposes exactly the public subpaths', () => {
    const packagePath = fileURLToPath(new URL('../package.json', import.meta.url));
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as {
      exports: Record<string, unknown>;
      publishConfig: {exports: Record<string, unknown>};
    };

    expect(Object.keys(packageJson.exports).sort()).toEqual([...EXPECTED_SUBPATHS].sort());
    expect(Object.keys(packageJson.publishConfig.exports).sort()).toEqual([...EXPECTED_PUBLISHED_SUBPATHS].sort());
    expect(packageJson.publishConfig.exports).not.toHaveProperty('./internal/timers');
  });
});
