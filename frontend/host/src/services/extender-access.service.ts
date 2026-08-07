import {fetchWithDeadline} from './pristine-fetch.js';

export interface ExtenderAccessState {
  enabled: boolean;
}

export interface IntakeCredentials {
  username: string;
  password: string;
}

const ACCESS_URL = '/api/mndw/extender-access';
const CREDENTIALS_URL = '/api/plugins/mws-page/credentials';
const FORGET_URL = '/api/plugins/mws-page/forget';

async function readJSON<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`mwsd request failed with status ${response.status}`);
  }

  const payload: unknown = await response.json();

  if (payload && typeof payload === 'object' && 'ok' in payload && 'data' in payload) {
    return (payload as {data: T}).data;
  }

  return payload as T;
}

export class ExtenderAccessService {
  public async getExtenderAccess(): Promise<ExtenderAccessState> {
    return await readJSON<ExtenderAccessState>(
      await fetchWithDeadline(ACCESS_URL, {
        headers: {'X-Mndw-Csrf': '1'},
      }),
    );
  }

  public async setExtenderAccess(enabled: boolean): Promise<ExtenderAccessState> {
    return await readJSON<ExtenderAccessState>(
      await fetchWithDeadline(ACCESS_URL, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json', 'X-Mndw-Csrf': '1'},
        body: JSON.stringify({enabled}),
      }),
    );
  }

  public async postCredentials(credentials: IntakeCredentials): Promise<void> {
    await readJSON<unknown>(
      await fetchWithDeadline(CREDENTIALS_URL, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'X-Mndw-Csrf': '1'},
        body: JSON.stringify(credentials),
      }),
    );
  }

  public async postForget(): Promise<void> {
    await readJSON<unknown>(
      await fetchWithDeadline(FORGET_URL, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'X-Mndw-Csrf': '1'},
        body: '{}',
      }),
    );
  }
}

export const extenderAccessService = new ExtenderAccessService();
