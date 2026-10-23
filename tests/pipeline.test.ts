import { describe, expect, it } from 'vitest';
import { cleanPipeline, followUpState, isDue, localDate, NOTES_MAX, statusLabel, type Pipeline } from '../src/services/pipeline';

const p = (extra: Partial<Pipeline>): Pipeline => ({ status: 'viewing', notes: '', followUp: null, updatedAt: '', ...extra });

describe('cleanPipeline', () => {
  it('keeps good values', () => {
    expect(cleanPipeline({ status: 'offer', notes: 'Offered £280k', followUp: '2026-10-30', updatedAt: 'x' }))
      .toEqual({ status: 'offer', notes: 'Offered £280k', followUp: '2026-10-30', updatedAt: 'x' });
  });

  it('drops bad values', () => {
    expect(cleanPipeline({ status: 'hacked', notes: 7, followUp: '30/10/2026', updatedAt: 1 })).toBeNull();
    expect(cleanPipeline({ status: 'hacked', notes: 'kept' })).toMatchObject({ status: 'new', notes: 'kept', followUp: null });
    expect(cleanPipeline(null)).toBeNull();
    expect(cleanPipeline('x')).toBeNull();
  });

  it('treats "New" with nothing else as no data, and cuts very long notes', () => {
    expect(cleanPipeline({ status: 'new', notes: '  ', followUp: null })).toBeNull();
    expect(cleanPipeline({ status: 'new', notes: 'a'.repeat(NOTES_MAX + 10) })!.notes).toHaveLength(NOTES_MAX);
  });
});

describe('follow-ups', () => {
  const today = '2026-10-23';

  it('says how near a follow-up is', () => {
    expect(followUpState(p({ followUp: '2026-10-20' }), today)).toBe('overdue');
    expect(followUpState(p({ followUp: '2026-10-23' }), today)).toBe('today');
    expect(followUpState(p({ followUp: '2026-10-30' }), today)).toBe('soon');
    expect(followUpState(p({ followUp: '2026-11-15' }), today)).toBe('later');
    expect(followUpState(p({}), today)).toBeNull();
    expect(followUpState(null, today)).toBeNull();
  });

  it('a closed deal has nothing due', () => {
    expect(followUpState(p({ status: 'bought', followUp: '2026-10-20' }), today)).toBeNull();
    expect(isDue(p({ status: 'passed', followUp: '2026-10-20' }), today)).toBe(false);
    expect(isDue(p({ followUp: '2026-10-23' }), today)).toBe(true);
  });

  it("uses the user's own date, not UTC", () => {
    expect(localDate(new Date(2026, 9, 23, 23, 30))).toBe('2026-10-23');
  });
});

describe('statusLabel', () => {
  it('names each stage', () => {
    expect(statusLabel('viewing')).toBe('Viewing booked');
    expect(statusLabel(undefined)).toBe('New');
  });
});
