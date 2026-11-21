import { describe, it, expect } from 'vitest';
import { linkedPanelUri, PanelRegistry, PANEL_MIME } from '@editmamei/core/panels.ts';

const page = (uri: string, html = '<!doctype html><p>hi</p>') => ({
  uri,
  name: 'test-panel',
  title: 'Test panel',
  html,
});

const linking = (uri: string) => ({ _meta: { ui: { resourceUri: uri } } });

describe('linkedPanelUri', () => {
  it('reads the nested key, then the flat one, and nothing else', () => {
    expect(linkedPanelUri(linking('ui://a/p.html'))).toBe('ui://a/p.html');
    expect(linkedPanelUri({ _meta: { 'ui/resourceUri': 'ui://a/q.html' } })).toBe('ui://a/q.html');
    expect(linkedPanelUri({})).toBeUndefined();
    expect(linkedPanelUri({ _meta: { ui: { resourceUri: 7 } } })).toBeUndefined();
  });
});

describe('PanelRegistry', () => {
  it('serves a page only while a tool links to it', () => {
    const panels = new PanelRegistry();
    panels.register([
      page('ui://editmamei/a.html'),
      { ...page('ui://editmamei/b.html'), name: 'b' },
    ]);

    expect(panels.resources([])).toEqual([]);
    expect(panels.read('ui://editmamei/a.html', [])).toBeNull();

    const tools = [linking('ui://editmamei/a.html'), {}];
    expect(panels.resources(tools)).toEqual([
      {
        uri: 'ui://editmamei/a.html',
        name: 'test-panel',
        title: 'Test panel',
        mimeType: PANEL_MIME,
      },
    ]);
    expect(panels.read('ui://editmamei/a.html', tools)).toEqual({
      contents: [
        { uri: 'ui://editmamei/a.html', mimeType: PANEL_MIME, text: '<!doctype html><p>hi</p>' },
      ],
    });
    expect(panels.read('ui://editmamei/b.html', tools)).toBeNull();
  });

  it('refuses malformed and duplicate pages, and registers none of a refused batch', () => {
    const panels = new PanelRegistry();
    expect(() => panels.register([page('https://example.com/a.html')])).toThrow(/ui:\/\//);
    expect(() => panels.register([page('ui://editmamei/../x')])).toThrow(/ui:\/\//);
    expect(() =>
      panels.register([{ ...page('ui://editmamei/a.html'), name: 'has space' }])
    ).toThrow(/name/);
    expect(() => panels.register([{ ...page('ui://editmamei/a.html'), title: '' }])).toThrow(
      /title/
    );
    expect(() => panels.register([page('ui://editmamei/a.html', '')])).toThrow(/page/);

    expect(() => panels.register([page('ui://editmamei/ok.html'), page('bad')])).toThrow();
    expect(panels.resources([linking('ui://editmamei/ok.html')])).toEqual([]);

    panels.register([page('ui://editmamei/a.html')]);
    expect(() => panels.register([page('ui://editmamei/a.html')])).toThrow(/already/);
  });
});
