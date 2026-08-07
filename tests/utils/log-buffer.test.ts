import { describe, it, expect } from 'vitest';
import { LogRingBuffer, sharedLogBuffer, recordLogLine } from '@editmamei/utils/log-buffer.ts';

describe('LogRingBuffer', () => {
  it('returns lines oldest-to-newest before reaching capacity', () => {
    const buf = new LogRingBuffer(5);
    buf.push('a');
    buf.push('b');
    buf.push('c');
    expect(buf.snapshot()).toEqual(['a', 'b', 'c']);
    expect(buf.size).toBe(3);
  });

  it('overwrites the oldest line once capacity is exceeded', () => {
    const buf = new LogRingBuffer(3);
    buf.push('a');
    buf.push('b');
    buf.push('c');
    buf.push('d'); // evicts 'a'
    buf.push('e'); // evicts 'b'
    expect(buf.snapshot()).toEqual(['c', 'd', 'e']);
    expect(buf.size).toBe(3);
  });

  it('wraps correctly across multiple full cycles', () => {
    const buf = new LogRingBuffer(2);
    for (const l of ['1', '2', '3', '4', '5']) buf.push(l);
    expect(buf.snapshot()).toEqual(['4', '5']);
  });

  it('clear() drops all retained lines', () => {
    const buf = new LogRingBuffer(3);
    buf.push('x');
    buf.push('y');
    buf.clear();
    expect(buf.snapshot()).toEqual([]);
    expect(buf.size).toBe(0);
  });

  it('clamps a non-positive capacity to at least 1 (no modulo-by-zero)', () => {
    const buf = new LogRingBuffer(0);
    buf.push('only');
    buf.push('latest');
    expect(buf.snapshot()).toEqual(['latest']);
  });

  it('recordLogLine writes into the shared buffer and never throws', () => {
    sharedLogBuffer.clear();
    expect(() => recordLogLine('boot line')).not.toThrow();
    expect(sharedLogBuffer.snapshot()).toContain('boot line');
    sharedLogBuffer.clear();
  });
});
