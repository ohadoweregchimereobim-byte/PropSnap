import { describe, expect, it } from 'vitest';
import { applyFloorAreaSetting, findFloorAreaInText } from '../src/adapters/floor-area-text';

const area = (...texts: string[]) => findFloorAreaInText(texts);

describe('findFloorAreaInText: the whole home', () => {
  it('reads a key feature that is just the size', () => {
    expect(area('624 sq ft')).toBe(58);
    expect(area('Approx. 624 Sq. Ft.')).toBe(58);
    expect(area('1,076 sqft')).toBe(100);
    expect(area('58m²')).toBe(58);
  });

  it('reads a size the description says is the home', () => {
    expect(area('A lovely 2 bed terraced house, approx. 624 sq ft, close to shops.')).toBe(58);
    expect(area('Total floor area: 58 sq m')).toBe(58);
    expect(area('The apartment extends to 72 square metres of living space.')).toBe(72);
    expect(area('Internal area 850 sq ft (79 sq m)')).toBe(79);
  });

  it('reads HTML descriptions', () => {
    expect(area('<p>Garden to rear.</p><p>Approx 624 sq ft</p>')).toBe(58);
    // Paragraphs must stay apart, or the garden would rule out the home's size
    expect(area('<p>Fully Furnished | £2,800 pcm</p><p>Approx. 550 sq ft</p><p>Private garden of 300 sq ft</p>')).toBe(51);
  });
});

describe('findFloorAreaInText: not the whole home', () => {
  it('ignores garden, plot and outside sizes', () => {
    expect(area('Garden of approx. 500 sq ft')).toBeNull();
    expect(area('Approx 650 sq ft of garden')).toBeNull();
    expect(area('Plot extends to 2,000 sq m')).toBeNull();
    expect(area('Detached garage 300 sq ft')).toBeNull();
  });

  it('ignores room sizes', () => {
    expect(area('Kitchen: 20 sq m')).toBeNull();
    expect(area('Bedroom 1 measuring 12ft x 10ft (120 sq ft)')).toBeNull();
    expect(area('Living room 12ft x 14ft')).toBeNull();
  });

  it('ignores a size with no sign it is the home', () => {
    expect(area('Just 400 sq ft from the station')).toBeNull();
  });

  it('gives no size when two sizes disagree', () => {
    expect(area('Approx 624 sq ft', 'Total floor area 900 sq ft')).toBeNull();
  });

  it('ignores sizes too small or too big for a home', () => {
    expect(area('Approx 50 sq ft')).toBeNull();
    expect(area('Approx 90,000 sq ft')).toBeNull();
  });

  it('handles no text', () => {
    expect(findFloorAreaInText([null, undefined, ''])).toBeNull();
  });
});

describe('applyFloorAreaSetting', () => {
  it("always prefers the site's own size", () => {
    expect(applyFloorAreaSetting({ floorAreaSqm: 80, floorAreaFromText: 58 }, true)).toMatchObject({ floorAreaSqm: 80, floorAreaSource: 'listing' });
  });

  it('uses the description size only when the setting is on', () => {
    expect(applyFloorAreaSetting({ floorAreaSqm: null, floorAreaFromText: 58 }, true)).toMatchObject({ floorAreaSqm: 58, floorAreaSource: 'text' });
    expect(applyFloorAreaSetting({ floorAreaSqm: null, floorAreaFromText: 58 }, false)).toMatchObject({ floorAreaSqm: null, floorAreaSource: null });
  });
});
