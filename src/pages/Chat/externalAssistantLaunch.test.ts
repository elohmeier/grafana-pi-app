import { externalAssistantSessionTitle, renderExternalAssistantContextBlock } from './externalAssistantLaunch';

describe('external Assistant launch (via @grafana/assistant)', () => {
  describe('externalAssistantSessionTitle', () => {
    it('truncates a long prompt for the session title', () => {
      const prompt = 'a'.repeat(80);
      const title = externalAssistantSessionTitle(prompt);
      expect(title.length).toBeLessThanOrEqual(56);
      expect(title.endsWith('...')).toBe(true);
    });

    it('falls back to "New chat" for an empty prompt', () => {
      expect(externalAssistantSessionTitle('   ')).toBe('New chat');
    });

    it('keeps a short prompt as-is', () => {
      expect(externalAssistantSessionTitle('Investigate this alert')).toBe('Investigate this alert');
    });
  });

  describe('renderExternalAssistantContextBlock', () => {
    it('returns undefined when there is no context', () => {
      expect(renderExternalAssistantContextBlock(undefined)).toBeUndefined();
      expect(renderExternalAssistantContextBlock([])).toBeUndefined();
    });

    it('renders a ChatContextItem-shaped structured node defensively, by title/name/data only', () => {
      const context = [
        {
          node: {
            title: 'Alert: KubePodCrashLooping',
            data: { cluster: 'demo-cluster-aws', severity: 'critical', namespace: 'payments' },
          },
          occurrences: [],
        },
      ];

      const block = renderExternalAssistantContextBlock(context);
      expect(block).toContain('<assistant_launch_context>');
      expect(block).toContain('Alert: KubePodCrashLooping');
      expect(block).toContain('demo-cluster-aws');
      expect(block).toContain('critical');
    });

    it('falls back to name when title is missing, and to a generic label when neither is present', () => {
      const withName = renderExternalAssistantContextBlock([{ node: { name: 'some-node' } }]);
      expect(withName).toContain('some-node');

      const withNeither = renderExternalAssistantContextBlock([{ node: {} }]);
      expect(withNeither).toContain('Context item');
    });

    it('ignores malformed entries instead of throwing', () => {
      expect(renderExternalAssistantContextBlock([null, 'not-an-item', 42, { node: null }])).toBeUndefined();
    });
  });
});
