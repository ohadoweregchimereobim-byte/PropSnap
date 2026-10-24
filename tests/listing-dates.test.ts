import { describe, expect, it } from 'vitest';
import {
  cleanPortalChanges,
  rightmoveAddedDate,
  rightmovePriceChanges,
  zooplaListedOn,
  zooplaPriceChanges,
} from '../src/adapters/listing-dates';

describe('Rightmove dates', () => {
  it('reads the analytics "added" date', () => {
    expect(rightmoveAddedDate('20260918')).toBe('2026-09-18');
    expect(rightmoveAddedDate('20260231')).toBeNull();
    expect(rightmoveAddedDate('')).toBeNull();
    expect(rightmoveAddedDate(undefined)).toBeNull();
  });

  it('reads a reduction from the update reason, and nothing else', () => {
    const captured = new Date(2026, 9, 24, 10, 0);
    expect(rightmovePriceChanges('Reduced on 12/10/2026', captured)).toEqual([{ date: '2026-10-12', direction: 'down' }]);
    expect(rightmovePriceChanges('Reduced today', captured)).toEqual([{ date: '2026-10-24', direction: 'down' }]);
    expect(rightmovePriceChanges('Reduced yesterday', captured)).toEqual([{ date: '2026-10-23', direction: 'down' }]);
    expect(rightmovePriceChanges('Added on 18/09/2026', captured)).toEqual([]);
    // The saved overseas page has an empty reason
    expect(rightmovePriceChanges('', captured)).toEqual([]);
    expect(rightmovePriceChanges('Reduced on 31/02/2026', captured)).toEqual([]);
  });
});

describe('Zoopla dates', () => {
  it('reads publishedOn', () => {
    expect(zooplaListedOn('2026-03-06T16:13:52')).toBe('2026-03-06');
    expect(zooplaListedOn('soon')).toBeNull();
  });

  it('reads the price changes exactly as a saved page has them', () => {
    const json = '[{"isPriceDrop":true,"priceChangeDate":"2026-04-07T09:56:04"},{"isPriceDrop":true,"priceChangeDate":"2026-08-28T14:37:57"}]';
    expect(zooplaPriceChanges(json)).toEqual([{ date: '2026-04-07', direction: 'down' }, { date: '2026-08-28', direction: 'down' }]);
    expect(zooplaPriceChanges('[{"isPriceDrop":false,"priceChangeDate":"2026-05-01T09:00:00"},{"priceChangeDate":"2026-06-01"}]'))
      .toEqual([{ date: '2026-05-01', direction: 'up' }]);
    expect(zooplaPriceChanges('not json')).toEqual([]);
    expect(zooplaPriceChanges(null)).toEqual([]);
  });

  it('keeps one of each change, oldest first', () => {
    expect(cleanPortalChanges([
      { date: '2026-08-28', direction: 'down' },
      { date: '2026-04-07', direction: 'down' },
      { date: '2026-08-28', direction: 'down' },
      { date: 'x', direction: 'down' },
      { date: '2026-05-01', direction: 'sideways' },
    ])).toEqual([{ date: '2026-04-07', direction: 'down' }, { date: '2026-08-28', direction: 'down' }]);
  });
});
