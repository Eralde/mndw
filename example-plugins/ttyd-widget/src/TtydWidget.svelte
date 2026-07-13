<script lang="ts">
import {onMount, tick} from 'svelte';
import {Terminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import {
  type SpawnResult,
  type TerminalInstance,
  connectToCli,
  killCli,
  spawnCli,
} from './cli.service.js';

interface Props {
  spawnEndpoint?: string;
  killEndpoint?: string;
  websocketPath?: string;
}

let {
  spawnEndpoint,
  killEndpoint,
  websocketPath,
}: Props = $props();

type WidgetState = 'idle' | 'starting' | 'connected' | 'error' | 'disconnected';

let state = $state<WidgetState>('idle');
let errorMessage = $state('');
let terminalElement = $state<HTMLDivElement | undefined>(undefined);
let terminalInstance: TerminalInstance | null = null;
let spawnDelayId: ReturnType<typeof setTimeout> | undefined;
let disconnectExpected = false;
const spawnCliWithEndpoint = spawnCli as unknown as (
  endpoint: string,
) => Promise<SpawnResult>;
const killCliWithEndpoint = killCli as unknown as (
  endpoint: string,
) => Promise<{success: boolean}>;
const connectToCliWithEndpoint = connectToCli as unknown as (
  websocketPath: string,
  element: HTMLElement,
  TerminalCtor: typeof Terminal,
  FitAddonCtor: typeof FitAddon,
  onDisconnect?: () => void,
) => TerminalInstance;
const handleWindowResize = (): void => {
  terminalInstance?.fitAddon.fit();
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    spawnDelayId = setTimeout(() => {
      resolve();
    }, ms);
  });
}

function clearSpawnDelay(): void {
  if (!spawnDelayId) {
    return;
  }

  clearTimeout(spawnDelayId);
  spawnDelayId = undefined;
}

function disposeTerminal(): void {
  window.removeEventListener('resize', handleWindowResize);
  terminalInstance?.dispose();
  terminalInstance = null;
}

async function startTerminal(): Promise<void> {
  clearSpawnDelay();
  disconnectExpected = false;
  disposeTerminal();

  state = 'starting';
  errorMessage = '';

  try {
    if (!spawnEndpoint || !killEndpoint || !websocketPath) {
      throw new Error('Backend bindings are missing for ttyd-widget');
    }

    const spawnResult = await spawnCliWithEndpoint(spawnEndpoint);

    if (!spawnResult.success) {
      throw new Error(spawnResult.error || 'Failed to start terminal service');
    }

    await sleep(1000);
    clearSpawnDelay();

    state = 'connected';
    await tick();

    if (!terminalElement) {
      throw new Error('Terminal container is not available');
    }

    terminalInstance = connectToCliWithEndpoint(
      websocketPath,
      terminalElement,
      Terminal,
      FitAddon,
      () => {
        if (!disconnectExpected) {
          state = 'disconnected';
        }
      },
    );
    requestAnimationFrame(() => {
      terminalInstance?.fitAddon.fit();
    });
    window.addEventListener('resize', handleWindowResize);
  } catch (error) {
    clearSpawnDelay();
    state = 'error';
    errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[ttyd-widget] Failed to start terminal:', error);
  }
}

async function stopTerminal(): Promise<void> {
  disconnectExpected = true;
  clearSpawnDelay();
  disposeTerminal();
  if (killEndpoint) {
    await killCliWithEndpoint(killEndpoint);
  }
  state = 'idle';
  disconnectExpected = false;
}

function retryTerminal(): void {
  void startTerminal();
}

onMount(() => {
  return () => {
    disconnectExpected = true;
    clearSpawnDelay();
    disposeTerminal();
    if (killEndpoint) {
      void killCliWithEndpoint(killEndpoint);
    }
  };
});
</script>

<div class="ttyd-widget">
  {#if state === 'idle'}
    <div class="screen">
      <button
        class="primary"
        onclick={startTerminal}
      >
        Start Terminal
      </button>
    </div>
  {:else if state === 'starting'}
    <div class="screen">
      <div
        class="spinner"
        aria-hidden="true"
      >
      </div>
      <span>Starting terminal...</span>
    </div>
  {:else if state === 'error'}
    <div class="screen">
      <div class="error">{errorMessage}</div>
      <button
        class="primary"
        onclick={retryTerminal}
      >
        Retry
      </button>
    </div>
  {:else if state === 'disconnected'}
    <div class="screen">
      <div class="error">Connection lost</div>
      <button
        class="primary"
        onclick={retryTerminal}
      >
        Reconnect
      </button>
    </div>
  {:else}
    <div class="terminal-wrap">
      <div class="terminal-header">
        <span class="status">Connected</span>
        <button
          class="secondary"
          onclick={stopTerminal}
        >
          Disconnect
        </button>
      </div>
      <div
        class="terminal-content"
        bind:this={terminalElement}
      >
      </div>
    </div>
  {/if}
</div>

<style>
.ttyd-widget {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  contain: layout paint;
  color: #ebedf0;
  background: #13161c;
  font-family: 'SF Mono', 'Menlo', 'Monaco', monospace;
}

.screen {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 16px;
  text-align: center;
}

.primary,
.secondary {
  border: 0;
  border-radius: 6px;
  padding: 8px 14px;
  font-size: 12px;
  cursor: pointer;
}

.primary {
  background: #2f81f7;
  color: #ffffff;
}

.primary:hover {
  background: #1f6feb;
}

.secondary {
  background: #30363d;
  color: #c9d1d9;
}

.secondary:hover {
  background: #3d444d;
}

.terminal-wrap {
  display: flex;
  flex-direction: column;
  flex: 1 1 0%;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  contain: layout paint;
}

.terminal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 10px;
  background: #1f242d;
  border-bottom: 1px solid #2a3039;
}

.status {
  font-size: 11px;
  color: #7ee787;
}

.terminal-content {
  flex: 1 1 0%;
  height: 0;
  min-height: 0;
  padding: 0;
  overflow: hidden;
  overflow-anchor: none;
  contain: layout paint;
  box-sizing: border-box;
}

.terminal-content :global(.xterm) {
  width: 100%;
  height: 100%;
}

.terminal-content :global(.xterm),
.terminal-content :global(.xterm-screen),
.terminal-content :global(.xterm-viewport) {
  height: 100%;
}

.terminal-content :global(.xterm-viewport) {
  overflow-anchor: none;
}

.spinner {
  width: 20px;
  height: 20px;
  border-radius: 9999px;
  border: 2px solid #2a3039;
  border-top-color: #2f81f7;
  animation: spin 0.8s linear infinite;
}

.error {
  color: #ff7b72;
  font-size: 12px;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
