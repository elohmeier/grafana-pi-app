import { getBackendSrv, isFetchError } from '@grafana/runtime';
import { lastValueFrom } from 'rxjs';
import { PLUGIN_ID } from '../../../constants';
import { compactParams } from '../domain/result';
import { createChatLogClient, type ChatLogClient } from './chatLogClient';

let client: ChatLogClient | undefined;

/**
 * The chat log API of this plugin's backend, called as the current Grafana
 * user. backendSrv renews an expired session before a request fails.
 */
export function grafanaChatLog(): ChatLogClient {
  client ??= createChatLogClient(async ({ method, path, params, body }) => {
    try {
      const response = await lastValueFrom(
        getBackendSrv().fetch<unknown>({
          url: `/api/plugins/${PLUGIN_ID}/resources${path}`,
          method,
          params: params ? compactParams(params) : undefined,
          data: body,
          showErrorAlert: false,
          showSuccessAlert: false,
        })
      );
      return { status: response.status, data: response.data };
    } catch (error) {
      if (isFetchError(error) && error.status > 0) {
        return { status: error.status, data: error.data };
      }
      throw error;
    }
  });
  return client;
}
