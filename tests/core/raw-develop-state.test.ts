import { describe, it, expect, beforeEach } from 'vitest';
import {
  markRawOpened,
  clearPendingRawDevelop,
  getPendingRawDevelop,
  __clearRawDevelopState,
} from '@editmamei/core/raw-develop-state.ts';

describe('raw-develop-state', () => {
  beforeEach(() => {
    __clearRawDevelopState();
  });

  it('starts empty', () => {
    expect(getPendingRawDevelop()).toBeNull();
  });

  it('markRawOpened stores the document identity', () => {
    markRawOpened('IMG_9265.dng', '/photos/IMG_9265.dng');
    expect(getPendingRawDevelop()).toEqual({
      documentName: 'IMG_9265.dng',
      filePath: '/photos/IMG_9265.dng',
    });
  });

  it('is a single slot — a second mark replaces the first', () => {
    markRawOpened('a.dng', '/a.dng');
    markRawOpened('b.nef', '/b.nef');
    expect(getPendingRawDevelop()?.documentName).toBe('b.nef');
  });

  it('clearPendingRawDevelop empties the slot', () => {
    markRawOpened('a.dng', '/a.dng');
    clearPendingRawDevelop();
    expect(getPendingRawDevelop()).toBeNull();
  });

  it('the test hook resets the slot', () => {
    markRawOpened('a.dng', '/a.dng');
    __clearRawDevelopState();
    expect(getPendingRawDevelop()).toBeNull();
  });
});
