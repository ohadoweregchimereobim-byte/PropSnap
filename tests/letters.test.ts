import { describe, expect, it } from 'vitest';
import type { PropertyListing } from '../src/adapters/types';
import {
  cleanLetterSettings,
  DEFAULT_LETTER_SETTINGS,
  DEFAULT_TEMPLATES,
  fillTemplate,
  letterFor,
  recipientLines,
  streetOf,
} from '../src/services/letters';
import { BUILT_IN_LABELS, cleanActivity, timeline } from '../src/services/crm';

function listing(extra: Partial<PropertyListing> = {}): PropertyListing {
  return {
    listingId: '1', source: 'zoopla', url: 'https://www.zoopla.co.uk/1',
    displayAddress: 'Woolaston Avenue, Cardiff', postcode: 'CF23 6EZ', postcodePartial: 'CF23',
    fullAddress: '6 WOOLASTON AVENUE, CARDIFF', addressConfidence: 'exact',
    price: 290_000, priceQualifier: null, currency: 'GBP', listingType: 'sale', bedrooms: 3, propertyType: 'Terraced',
    agentName: null, agentPhone: null, agentBranch: null, latitude: null, longitude: null,
    tenure: null, furnished: null, deposit: null, epcRating: null, capturedAt: '2026-10-24T09:00:00Z',
    ...extra,
  };
}

const branding = { company: 'Acme Homes', contact: '029 2000 0000\nhello@acme.example' };
const today = new Date('2026-10-24T12:00:00Z');

describe('addresses', () => {
  it('lays out the address for an envelope window, postcode last', () => {
    expect(recipientLines('FLAT 3, 10 HIGH STREET, CARDIFF', 'CF10 1AA')).toEqual(['The Owner', 'Flat 3', '10 High Street', 'Cardiff', 'CF10 1AA']);
    expect(recipientLines('6 WOOLASTON AVENUE, CARDIFF CF23 6EZ', 'cf23 6ez')).toEqual(['The Owner', '6 Woolaston Avenue', 'Cardiff', 'CF23 6EZ']);
    expect(recipientLines('12A HEOL Y DERI, RHIWBINA, CARDIFF', null)).toEqual(['The Owner', '12A Heol Y Deri', 'Rhiwbina', 'Cardiff']);
  });

  it('finds the street, skipping a flat number', () => {
    expect(streetOf('FLAT 3, 10 HIGH STREET, CARDIFF')).toBe('High Street');
    expect(streetOf('6 WOOLASTON AVENUE, CARDIFF')).toBe('Woolaston Avenue');
    expect(streetOf('12')).toBe('your street');
  });
});

describe('templates', () => {
  it('fills placeholders, ignoring case, and leaves unknown ones', () => {
    expect(fillTemplate('On {Street} from {your name}, {other}', { street: 'High Street', 'your name': 'Sam' })).toBe('On High Street from Sam, {other}');
  });

  it('every built-in letter says how to stop more letters', () => {
    for (const t of DEFAULT_TEMPLATES) expect(t.body).toMatch(/rather not hear from me again/);
  });

  it('checks saved settings and brings back a missing built-in letter', () => {
    const s = cleanLetterSettings({
      templates: [{ id: 'buyer', name: '  My buyer letter ', body: 'Hello {street}' }, { id: 'buyer', name: 'dup', body: 'x' }, { id: 'bad', body: '  ' }],
      templateId: 'gone', senderName: '  Sam   Jones ', signOff: '',
    });
    expect(s.templates.map((t) => t.id)).toEqual(['buyer', 'on-market', 'landlord']);
    expect(s.templates[0]).toEqual({ id: 'buyer', name: 'My buyer letter', body: 'Hello {street}' });
    expect(s.templateId).toBe('buyer');
    expect(s.senderName).toBe('Sam Jones');
    expect(s.signOff).toBe('Kind regards');
    expect(cleanLetterSettings(null)).toEqual(DEFAULT_LETTER_SETTINGS);
  });
});

describe('letterFor', () => {
  const settings = { ...DEFAULT_LETTER_SETTINGS, senderName: 'Sam Jones' };

  it('writes to the owner at a sure address', () => {
    const letter = letterFor(listing(), [], settings, branding, today);
    expect(letter.ok).toBe(true);
    if (!letter.ok) return;
    expect(letter.recipient).toEqual(['The Owner', '6 Woolaston Avenue', 'Cardiff', 'CF23 6EZ']);
    expect(letter.date).toBe('24 October 2026');
    expect(letter.body).toContain('to buy a home on Woolaston Avenue');
    expect(letter.senderName).toBe('Sam Jones');
    expect(letterFor(listing({ addressConfidence: 'user_choice' }), [], settings, branding, today).ok).toBe(true);
  });

  it('never writes to a best guess, a home with no full address, or one marked Do not contact', () => {
    const guess = letterFor(listing({ addressConfidence: 'best_guess' }), [], settings, branding, today);
    expect(guess).toMatchObject({ ok: false, why: expect.stringMatching(/best guess/) });
    expect(letterFor(listing({ fullAddress: null, addressConfidence: null }), [], settings, branding, today)).toMatchObject({ ok: false, why: expect.stringMatching(/No full address/) });
    expect(letterFor(listing(), ['do NOT contact'], settings, branding, today)).toMatchObject({ ok: false, why: expect.stringMatching(/Do not contact/) });
  });

  it('fills the address and contact into a letter that uses them', () => {
    const custom = { ...settings, templates: [{ id: 'x', name: 'X', body: 'About {address}. Call {contact}. {company}' }], templateId: 'x' };
    const letter = letterFor(listing(), [], custom, branding, today);
    expect(letter.ok && letter.body).toBe('About 6 Woolaston Avenue, Cardiff, CF23 6EZ. Call 029 2000 0000, hello@acme.example. Acme Homes');
  });
});

describe('letters in the timeline and labels', () => {
  it('offers "Do not contact" as a label', () => {
    expect(BUILT_IN_LABELS).toContain('Do not contact');
  });

  it('keeps a letter entry and shows it as "Letter sent"', () => {
    const [entry] = cleanActivity([{ id: 'l', at: '2026-10-24T12:00:00Z', kind: 'letter', text: 'A buyer for your home' }]);
    expect(entry).toMatchObject({ kind: 'letter', text: 'A buyer for your home' });
    expect(timeline([entry!], null)[0]).toMatchObject({ title: 'Letter sent', text: 'A buyer for your home', id: 'l' });
  });
});
