import { presentedEvidence } from './assistant';

describe('presented evidence', () => {
  it('takes images of a bash result with their titles and evidence presentations', () => {
    expect(
      presentedEvidence({
        content: [
          { type: 'text', text: '{"uid":"web"}' },
          { type: 'image', data: 'aW1n', mimeType: 'image/png' },
        ],
        details: {
          images: [{ title: 'Screenshot web panel 2', mimeType: 'image/png' }],
          presentations: [
            { version: 1, path: '/tmp/top.json', revision: 'r', title: 'Top hosts', view: 'table', data: [{ a: 1 }] },
            { version: 1, path: '/x', revision: 'r', title: 'Unknown', view: 'video', data: 1 },
          ],
        },
      })
    ).toEqual([
      { view: 'image', title: 'Screenshot web panel 2', mimeType: 'image/png', data: 'aW1n' },
      { view: 'table', title: 'Top hosts', data: [{ a: 1 }] },
    ]);
    expect(presentedEvidence({ content: [{ type: 'text', text: 'ok' }] })).toEqual([]);
  });
});
