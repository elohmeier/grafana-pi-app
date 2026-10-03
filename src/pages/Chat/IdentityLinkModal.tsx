import React, { useEffect, useState } from 'react';
import { config, locationService } from '@grafana/runtime';
import { Alert, Button, ConfirmModal, Modal } from '@grafana/ui';
import type { IdentityLink } from '../../generated/api';
import { pluginResourceFetch } from './domain/client';

const LINK_PARAM = 'link';

type State =
  | { status: 'idle' }
  | { status: 'confirm'; code: string; link: IdentityLink }
  | { status: 'done'; link: IdentityLink }
  | { status: 'error'; message: string };

const PLATFORMS: Record<string, string> = { mattermost: 'Mattermost', webex: 'Webex' };

/**
 * `?link=CODE` from the assistant host's direct message: links the chat
 * account the code was made for to the signed-in Grafana user after asking.
 * See docs/identity.md.
 */
export function IdentityLinkModal() {
  const [state, setState] = useState<State>({ status: 'idle' });

  useEffect(() => {
    const code = new URLSearchParams(locationService.getLocation().search).get(LINK_PARAM)?.trim();
    if (!code) {
      return;
    }
    locationService.partial({ [LINK_PARAM]: null }, true);
    pluginResourceFetch<IdentityLink>(`/identity/link-codes/${encodeURIComponent(code)}`).then(
      (link) => setState({ status: 'confirm', code, link }),
      () =>
        setState({
          status: 'error',
          message: 'This link is invalid or expired. Ask the assistant for a new one with "link".',
        })
    );
  }, []);

  const close = () => setState({ status: 'idle' });
  const platform = (link: IdentityLink) => PLATFORMS[link.platform] ?? link.platform;
  const user = config.bootData.user.login;

  if (state.status === 'confirm') {
    return (
      <ConfirmModal
        isOpen
        title="Link chat account"
        body={`Link the ${platform(state.link)} account ${state.link.displayName} to your Grafana user ${user}? The assistant then knows that messages from this account are yours.`}
        confirmText="Link account"
        confirmVariant="primary"
        onDismiss={close}
        onConfirm={() =>
          pluginResourceFetch<IdentityLink>(`/identity/link-codes/${encodeURIComponent(state.code)}/confirm`, {
            method: 'POST',
          }).then(
            (link) => setState({ status: 'done', link }),
            (error) => setState({ status: 'error', message: error instanceof Error ? error.message : String(error) })
          )
        }
      />
    );
  }
  if (state.status === 'done' || state.status === 'error') {
    return (
      <Modal isOpen title="Link chat account" onDismiss={close}>
        {state.status === 'done' ? (
          <Alert severity="success" title="Linked">
            The {platform(state.link)} account {state.link.displayName} is linked to your Grafana user{' '}
            {state.link.userLogin}.
          </Alert>
        ) : (
          <Alert severity="error" title="Not linked">
            {state.message}
          </Alert>
        )}
        <Modal.ButtonRow>
          <Button onClick={close}>Close</Button>
        </Modal.ButtonRow>
      </Modal>
    );
  }
  return null;
}
