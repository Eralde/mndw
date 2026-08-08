<script lang="ts">
import {onMount, tick} from 'svelte';
import type {BackendClient} from '@mndw/sdk';
import {isBackendMaintenanceClose} from '@mndw/sdk';
import {Terminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import {
  type TerminalInstance,
  connectToCli,
  killCli,
  spawnCli,
} from './cli.service.js';

interface Props {
  backend?: BackendClient;
}

let {
  backend,
}: Props = $props();

type PageState = 'idle' | 'starting' | 'connected' | 'error' | 'disconnected';

let state = $state<PageState>('idle');
let errorMessage = $state('');
let consoleChoice = $state<import('./cli.service.js').ConsoleChoice>('router');
let terminalElement = $state<HTMLDivElement | undefined>(undefined);
let terminalInstance: TerminalInstance | null = null;
let spawnDelayId: ReturnType<typeof setTimeout> | undefined;
let disconnectExpected = false;

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
    if (!backend) {
      throw new Error('Backend bindings are missing for terminal-page');
    }

    const spawnResult = await spawnCli(backend, consoleChoice);

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

    terminalInstance = connectToCli(
      backend,
      terminalElement,
      Terminal,
      FitAddon,
      (event) => {
        if (!disconnectExpected) {
          state = 'disconnected';
          errorMessage = isBackendMaintenanceClose(event)
            ? 'Session ended during update'
            : 'Connection lost';
        }
      },
    );
    requestAnimationFrame(() => {
      terminalInstance?.fitAddon.fit();
    });
  } catch (error) {
    clearSpawnDelay();
    state = 'error';
    errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[terminal-page] Failed to start terminal:', error);
  }
}

async function stopTerminal(): Promise<void> {
  disconnectExpected = true;
  clearSpawnDelay();
  disposeTerminal();
  if (backend) {
    await killCli(backend);
  }
  state = 'idle';
  disconnectExpected = false;
}

function retryTerminal(): void {
  void startTerminal();
}

function selectConsole(choice: import('./cli.service.js').ConsoleChoice): void {
  consoleChoice = choice;
  void startTerminal();
}

onMount(() => {
  return () => {
    disconnectExpected = true;
    clearSpawnDelay();
    disposeTerminal();
    if (backend) {
      void killCli(backend);
    }
  };
});
</script>

<div class="ttyd-terminal">
  {#if state === 'idle'}
    <div class="screen">
      <div class="console-choice">
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <mndw-button
          variant="primary"
          onclick={() => selectConsole('router')}
        >
          Router CLI
        </mndw-button>
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <mndw-button
          variant="primary"
          onclick={() => selectConsole('entware')}
        >
          Entware Shell
        </mndw-button>
      </div>
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
      <div
        class="mndw-alert mndw-alert--danger"
        role="alert"
      >
        {errorMessage}
      </div>
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <mndw-button
        variant="primary"
        onclick={retryTerminal}
      >
        Retry
      </mndw-button>
    </div>
  {:else if state === 'disconnected'}
    <div class="screen">
      <div
        class="mndw-alert mndw-alert--danger"
        role="alert"
      >
        Connection lost
      </div>
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <mndw-button
        variant="primary"
        onclick={retryTerminal}
      >
        Reconnect
      </mndw-button>
    </div>
  {:else}
    <div class="terminal-wrap">
      <div class="terminal-header">
        <span class="status">Connected</span>
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <mndw-button
          variant="secondary"
          onclick={stopTerminal}
        >
          Disconnect
        </mndw-button>
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
.ttyd-terminal {
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

.console-choice {
  display: flex;
  gap: 12px;
}

.ttyd-terminal :global(mndw-button) {
  font-family: inherit;
  font-size: 12px;
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

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
