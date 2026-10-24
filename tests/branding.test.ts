import { describe, expect, it } from 'vitest';
import { cleanBranding, DEFAULT_COLOUR, headingColour, isBranded, logoProblem, LOGO_MAX_CHARS } from '../src/services/branding';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('branding', () => {
  it('keeps good values and tidies text', () => {
    const b = cleanBranding({ company: '  Acme   Property  Sourcing ', contact: '029 2000 0000\r\nhello@example.com', colour: '#0F766E', logo: PNG });
    expect(b).toEqual({ company: 'Acme Property Sourcing', contact: '029 2000 0000\nhello@example.com', colour: '#0f766e', logo: PNG });
    expect(isBranded(b)).toBe(true);
  });

  it('drops bad colours, SVG and other logos, and oversized images', () => {
    const b = cleanBranding({ company: 5, colour: 'red', logo: 'data:image/svg+xml;base64,PHN2Zz4=' });
    expect(b).toEqual({ company: '', contact: '', colour: DEFAULT_COLOUR, logo: null });
    expect(isBranded(b)).toBe(false);
    expect(cleanBranding({ logo: `data:image/png;base64,${'A'.repeat(LOGO_MAX_CHARS)}` }).logo).toBeNull();
    expect(cleanBranding({ logo: 'javascript:alert(1)' }).logo).toBeNull();
    expect(cleanBranding(null)).toEqual({ company: '', contact: '', colour: DEFAULT_COLOUR, logo: null });
  });

  it('says why a logo file cannot be used', () => {
    expect(logoProblem({ type: 'image/png', size: 50_000 })).toBeNull();
    expect(logoProblem({ type: 'image/svg+xml', size: 1_000 })).toMatch(/PNG/);
    expect(logoProblem({ type: 'image/jpeg', size: 400_000 })).toMatch(/290 KB/);
  });

  it('uses the brand colour for headings only when it reads well on white', () => {
    expect(headingColour('#1d4ed8')).toBe('#1d4ed8');
    expect(headingColour('#FDE047')).toBe('#0f172a');
    expect(headingColour('nope')).toBe('#0f172a');
  });
});
