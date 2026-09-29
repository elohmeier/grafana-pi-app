import type {
  WorkspaceApprovalDecision,
  WorkspaceApprovalRequest,
  WorkspaceApprovalService,
} from '../workspace/broker';

/** Pending approvals belong to the session; views can attach/detach without losing the decision. */
export class ApprovalChannel implements WorkspaceApprovalService {
  private pending?: WorkspaceApprovalRequest;
  private finish?: (approved: boolean, paths?: string[]) => void;
  private listeners = new Set<() => void>();
  getSnapshot = () => this.pending;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  /** `paths` lists the operations the reviewer kept; omitted, every operation is approved. */
  settle = (approved: boolean, paths?: string[]) => {
    this.finish?.(approved, paths);
  };

  request = (request: WorkspaceApprovalRequest, signal?: AbortSignal): Promise<WorkspaceApprovalDecision> => {
    if (this.pending) {
      return Promise.resolve({ approved: false, reason: 'Another approval is pending.' });
    }
    if (signal?.aborted) {
      return Promise.resolve({ approved: false, reason: 'Cancelled.' });
    }
    return new Promise((resolve) => {
      const abort = () => this.settle(false);
      this.pending = request;
      this.finish = (approved, paths) => {
        this.pending = undefined;
        this.finish = undefined;
        signal?.removeEventListener('abort', abort);
        resolve({
          approved,
          reason: approved ? undefined : 'Denied or cancelled.',
          ...(approved && paths ? { paths } : {}),
        });
        this.notify();
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.notify();
    });
  };

  private notify() {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
