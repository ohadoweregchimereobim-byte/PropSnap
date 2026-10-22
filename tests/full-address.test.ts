import { describe, expect, it } from 'vitest';
import { fullAddressOf } from '../src/services/epc-api';

describe('fullAddressOf', () => {
  it('shows the town once when the certificate repeats it', () => {
    expect(fullAddressOf({ addressLines: ['7 MILTON GROVE', 'NEW MILTON'], postTown: 'NEW MILTON' })).toBe('7 MILTON GROVE, NEW MILTON');
    expect(fullAddressOf({ addressLines: ['7 Milton Grove', 'New Milton'], postTown: 'NEW MILTON' })).toBe('7 Milton Grove, New Milton');
  });

  it('keeps every part when nothing repeats', () => {
    expect(fullAddressOf({ addressLines: ['Crossley Towers', 'Mockbeggar'], postTown: 'RINGWOOD' })).toBe('Crossley Towers, Mockbeggar, RINGWOOD');
    expect(fullAddressOf({ addressLines: ['10 Dovercourt House', 'Ferry Court'], postTown: '' })).toBe('10 Dovercourt House, Ferry Court');
  });
});
