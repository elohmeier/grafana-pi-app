import { HostStore } from './store';

describe('host store', () => {
  it('forgets threads, episodes, and analyses unused for the retention period, but not pending runs', async () => {
    const saved: unknown[] = [];
    const store = new HostStore({ load: async () => undefined, save: async (state) => void saved.push(state) }, 1000);
    const old = Date.now() - 2000;
    const pending = { channelId: 'c', threadId: 't', postId: 'p', prompt: 'why?', startedAt: old };
    await store.setThread('old', { createdAt: old, lastAnswerAt: old });
    await store.setThread('answered', { createdAt: old, lastAnswerAt: Date.now() });
    await store.setThread('pending', { createdAt: old, pending });
    await store.setEpisode('old', {
      channelId: 'c',
      threadId: 't',
      status: 'resolved',
      fingerprints: [],
      startedAt: old,
      updatedAt: old,
    });
    await store.setLastAnalysis('old', old);
    await store.setLastAnalysis('new', Date.now());
    expect(store.threads().map(([key]) => key)).toEqual(['answered', 'pending']);
    expect(store.episode('old')).toBeUndefined();
    expect(store.lastAnalysis('old')).toBeUndefined();
    expect(store.lastAnalysis('new')).toBeDefined();
    expect(saved.at(-1)).toMatchObject({ episodes: {}, analyses: { new: expect.any(Number) } });
  });
});
