import { describe, it, expect } from 'vitest';
import { CompositeSnippetClient } from '@editmamei/api/snippet-client.ts';
import { makeSnippetClient } from '../fixtures/fake-snippet-client.ts';

describe('CompositeSnippetClient', () => {
  it("routes a declared 'own' snippet to the own client", async () => {
    const own = makeSnippetClient();
    const community = makeSnippetClient();
    const client = new CompositeSnippetClient(own, community, ['selectSubject', 'selectSky']);

    await client.build('selectSubject', { sampleAllLayers: true });

    expect(own.allBuilds().map((b) => b.name)).toEqual(['selectSubject']);
    expect(community.allBuilds()).toHaveLength(0);
    expect(own.lastBuild().params).toEqual({ sampleAllLayers: true });
  });

  it('routes a non-own (community) snippet to the community client', async () => {
    const own = makeSnippetClient();
    const community = makeSnippetClient();
    const client = new CompositeSnippetClient(own, community, ['selectSubject', 'selectSky']);

    // The Pro template handlers build community snippets like this one.
    await client.build('renderHistoryStatePreview', { historyIndex: 0 });

    expect(community.allBuilds().map((b) => b.name)).toEqual(['renderHistoryStatePreview']);
    expect(own.allBuilds()).toHaveLength(0);
  });

  it('routes a mixed sequence to the right client per name', async () => {
    const own = makeSnippetClient();
    const community = makeSnippetClient();
    const client = new CompositeSnippetClient(own, community, ['selectSubject', 'selectSky']);

    await client.build('selectSky');
    await client.build('getHistogram', { channel: 'luminosity' });
    await client.build('selectSubject');
    await client.build('deselect');

    expect(own.allBuilds().map((b) => b.name)).toEqual(['selectSky', 'selectSubject']);
    expect(community.allBuilds().map((b) => b.name)).toEqual(['getHistogram', 'deselect']);
  });

  it('returns the underlying client output verbatim', async () => {
    const own = makeSnippetClient();
    const community = makeSnippetClient();
    const client = new CompositeSnippetClient(own, community, ['selectSubject']);

    const jsx = await client.build('selectSubject', { selectionType: 'replace' });
    // FakeSnippetClient echoes name + params as JSON.
    expect(JSON.parse(jsx)).toMatchObject({ __snippet: 'selectSubject', selectionType: 'replace' });
  });

  it('treats an empty own-snippet set as community-only', async () => {
    const own = makeSnippetClient();
    const community = makeSnippetClient();
    const client = new CompositeSnippetClient(own, community, []);

    await client.build('selectSubject');

    expect(own.allBuilds()).toHaveLength(0);
    expect(community.allBuilds().map((b) => b.name)).toEqual(['selectSubject']);
  });
});
