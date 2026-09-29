import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { testIds } from '../../components/testIds';
import { ChangeSetReviewModal } from './ChangeSetReview';
import type { WorkspaceApprovalOperation, WorkspaceApprovalRequest } from './workspace/broker';

function operation(overrides: Partial<WorkspaceApprovalOperation>): WorkspaceApprovalOperation {
  return {
    operation: 'update',
    uid: 'x',
    path: '/grafana/dashboards/x/dashboard.json',
    additions: 1,
    deletions: 1,
    diff: '@@ -1 +1 @@\n-a\n+b\n',
    warnings: [],
    preexistingErrors: [],
    ...overrides,
  };
}

const request: WorkspaceApprovalRequest = {
  applyId: 'apply-123',
  digest: 'd',
  title: 'Apply changes to 1 dashboard and 2 alert rules',
  summary: '',
  groups: [],
  ungroupedChanges: 0,
  operations: [
    operation({ uid: 'checkout', title: 'Checkout', folderUid: 'ops', folderTitle: 'Operations' }),
    operation({
      kind: 'alertRule',
      uid: 'high-5xx',
      title: 'High 5xx',
      path: '/grafana/alert-rules/high-5xx/rule.json',
      folderUid: 'ops',
      folderTitle: 'Operations',
      group: 'checkout',
    }),
    operation({
      kind: 'alertRule',
      uid: 'high-latency',
      title: 'High latency',
      path: '/grafana/alert-rules/high-latency/rule.json',
      folderUid: 'ops',
      folderTitle: 'Operations',
      group: 'checkout',
    }),
  ],
};

describe('ChangeSetReviewModal', () => {
  it('lists dashboards and alert rules in separate sections, rules by folder and group', () => {
    render(<ChangeSetReviewModal request={request} onApprove={jest.fn()} onDeny={jest.fn()} />);
    expect(screen.getByText('1 dashboard and 2 alert rules')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Dashboards' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Alert rules' })).toBeInTheDocument();
    expect(screen.getByLabelText('Operations › checkout (2)')).toBeInTheDocument();
    expect(screen.getByText(/for alert rules, the assistant checks this right before saving/)).toBeInTheDocument();
  });

  it('approves the checked resources only', () => {
    const onApprove = jest.fn();
    render(<ChangeSetReviewModal request={request} onApprove={onApprove} onDeny={jest.fn()} />);
    fireEvent.click(screen.getByLabelText('Apply High latency'));
    fireEvent.click(screen.getByTestId(testIds.chat.toolConfirmationApprove));
    expect(onApprove).toHaveBeenCalledWith([
      '/grafana/dashboards/x/dashboard.json',
      '/grafana/alert-rules/high-5xx/rule.json',
    ]);
  });
});
