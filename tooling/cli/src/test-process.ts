import {spawn} from 'node:child_process';

interface ProcessResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export function runProcess(
  command: string,
  args: readonly string[],
  options: {cwd: string; env?: NodeJS.ProcessEnv},
): Promise<ProcessResult> {
  return new Promise((resolve): void => {
    const child = spawn(command, [...args], {cwd: options.cwd, env: options.env});
    let stdout = '';
    let stderr = '';

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string): void => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string): void => {
      stderr += chunk;
    });
    child.once('error', (error: Error): void => {
      resolve({status: null, stdout, stderr: `${stderr}${error.message}`});
    });
    child.once('close', (status: number | null): void => {
      resolve({status, stdout, stderr});
    });
  });
}
