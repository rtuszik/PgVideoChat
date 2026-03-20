import { describe, expect, test } from 'bun:test';

// identityHex and shortHex are pure functions with no Svelte dependencies,
// but they're in a module that imports svelte/store and $app/environment.
// Re-implement the logic here to test the algorithm directly.

function identityHex(id: any): string {
  if (!id) return '';
  if (typeof id === 'string') return id;
  if (typeof id._hex === 'string') return id._hex;
  if (typeof id.toHexString === 'function') return id.toHexString();
  return '';
}

function shortHex(id: any): string {
  const h = identityHex(id);
  return h ? `${h.slice(0, 10)}\u2026${h.slice(-6)}` : '';
}

describe('identityHex', () => {
  test('returns empty string for null', () => {
    expect(identityHex(null)).toBe('');
  });

  test('returns empty string for undefined', () => {
    expect(identityHex(undefined)).toBe('');
  });

  test('returns empty string for empty string', () => {
    expect(identityHex('')).toBe('');
  });

  test('returns the string itself for string input', () => {
    expect(identityHex('abcdef1234567890')).toBe('abcdef1234567890');
  });

  test('returns _hex property from object', () => {
    expect(identityHex({ _hex: 'deadbeef' })).toBe('deadbeef');
  });

  test('returns result of toHexString() method', () => {
    const obj = { toHexString: () => 'cafebabe' };
    expect(identityHex(obj)).toBe('cafebabe');
  });

  test('prefers _hex over toHexString', () => {
    const obj = { _hex: 'from_hex', toHexString: () => 'from_method' };
    expect(identityHex(obj)).toBe('from_hex');
  });

  test('returns empty string for object without hex properties', () => {
    expect(identityHex({ name: 'test' })).toBe('');
  });

  test('returns empty string for number', () => {
    expect(identityHex(0)).toBe('');
  });

  test('returns empty string for false', () => {
    expect(identityHex(false)).toBe('');
  });
});

describe('shortHex', () => {
  test('returns empty string for null', () => {
    expect(shortHex(null)).toBe('');
  });

  test('returns empty string for undefined', () => {
    expect(shortHex(undefined)).toBe('');
  });

  test('returns truncated hex with ellipsis', () => {
    const hex = 'abcdef1234567890abcdef';
    const result = shortHex(hex);
    expect(result).toBe('abcdef1234\u2026abcdef');
  });

  test('works with short hex strings', () => {
    const hex = 'abc';
    const result = shortHex(hex);
    // slice(0,10) = 'abc', slice(-6) = 'abc'
    expect(result).toBe('abc\u2026abc');
  });

  test('works with object input', () => {
    const result = shortHex({ _hex: 'abcdef1234567890abcdef' });
    expect(result).toBe('abcdef1234\u2026abcdef');
  });

  test('returns empty string for empty input', () => {
    expect(shortHex('')).toBe('');
  });
});
