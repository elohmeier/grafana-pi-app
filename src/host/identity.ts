import type { IdentityLink, LinkCode } from '../generated/api';
import { getBackendSrv, isFetchError } from './grafanaRuntime';

type Request = <T>(method: string, path: string, body?: unknown) => Promise<T>;

/**
 * Chat platform accounts linked to Grafana users, stored by the plugin backend
 * (`/identity` routes; see docs/identity.md). The host asks as its service
 * account; users confirm link codes in Grafana.
 */
export class IdentityService {
  /** Email matching is on, and the service account may look up users. */
  private emailLookup: boolean;

  constructor(
    private readonly request: Request,
    private readonly options: {
      emailMatch?: boolean;
      lookupUser?: (email: string) => Promise<{ uid: string; login: string } | undefined>;
    } = {}
  ) {
    this.emailLookup = Boolean(options.emailMatch && options.lookupUser);
  }

  /**
   * The Grafana user an account is linked to, or matched by its verified email when enabled.
   * Not cached: a link confirmed or removed in Grafana applies to the next message.
   */
  async resolve(
    platform: string,
    user: string,
    displayName: string,
    verifiedEmail?: string
  ): Promise<IdentityLink | undefined> {
    let link = await this.request<IdentityLink>(
      'GET',
      `/identity/links/${encodeURIComponent(platform)}/${encodeURIComponent(user)}`
    ).catch((error) => {
      if (status(error) === 404) {
        return undefined;
      }
      throw error;
    });
    if (!link && verifiedEmail && this.emailLookup && this.options.lookupUser) {
      const match = await this.options.lookupUser(verifiedEmail).catch((error) => {
        if (status(error) === 403 || status(error) === 401) {
          // The service account may not look up users; matching stays off.
          this.emailLookup = false;
        }
        return undefined;
      });
      if (match) {
        link = await this.request<IdentityLink>(
          'PUT',
          `/identity/links/${encodeURIComponent(platform)}/${encodeURIComponent(user)}`,
          {
            displayName,
            userUid: match.uid,
            userLogin: match.login,
            source: 'email',
          }
        );
      }
    }
    return link;
  }

  createCode(platform: string, user: string, displayName: string) {
    return this.request<LinkCode>('POST', '/identity/link-codes', { platform, platformUser: user, displayName });
  }

  async unlink(platform: string, user: string) {
    await this.request('DELETE', `/identity/links/${encodeURIComponent(platform)}/${encodeURIComponent(user)}`);
  }
}

function status(error: unknown) {
  return isFetchError(error) ? error.status : undefined;
}

/** Requests to the plugin's resources as the host's service account. */
export function pluginRequest(pluginId: string): Request {
  return async <T>(method: string, path: string, body?: unknown) =>
    (
      await new Promise<{ data: T }>((resolve, reject) =>
        getBackendSrv()
          .fetch<T>({ url: `/api/plugins/${pluginId}/resources${path}`, method, data: body })
          .subscribe({ next: resolve, error: reject })
      )
    ).data;
}

/** A Grafana user by email address; needs `users:read` for the host's service account. */
export async function lookupGrafanaUser(email: string) {
  const user = await getBackendSrv().get<{ uid?: string; login?: string; email?: string }>('/api/users/lookup', {
    loginOrEmail: email,
  });
  // The lookup also matches logins; only an exact email match links.
  return user.uid && user.login && user.email?.toLowerCase() === email.toLowerCase()
    ? { uid: user.uid, login: user.login }
    : undefined;
}
