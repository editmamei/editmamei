import type { SnippetClient } from '@editmamei/api/snippet-client.ts';

interface BuildCall {
  name: string;
  params: Record<string, unknown>;
}

/**
 * In-process SnippetClient stand-in for unit tests.
 *
 * Records every build() call. Returns a JSON string containing both the
 * snippet name and all params, so existing `.toContain(value)` assertions on
 * the human-facing text response still pass when the value appears inside the
 * params object.
 */
export class FakeSnippetClient implements SnippetClient {
  private calls: BuildCall[] = [];

  async build(name: string, params: Record<string, unknown> = {}): Promise<string> {
    this.calls.push({ name, params });
    return JSON.stringify({ __snippet: name, ...params });
  }

  lastBuild(): BuildCall {
    if (this.calls.length === 0) {
      throw new Error('FakeSnippetClient: no build() calls recorded');
    }
    return this.calls[this.calls.length - 1];
  }

  allBuilds(): BuildCall[] {
    return this.calls;
  }

  reset(): void {
    this.calls = [];
  }
}

export function makeSnippetClient(): FakeSnippetClient {
  return new FakeSnippetClient();
}
