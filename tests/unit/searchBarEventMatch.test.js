import { describe, it, expect } from 'vitest';
import { eventMatchesQuery } from '../../src/components/Common/SearchBar';

describe('eventMatchesQuery — Calendar Events group in SearchBar', () => {
  function event(overrides = {}) {
    return {
      id: 'evt_1',
      title: 'Dentist Appointment',
      date: '2026-08-20',
      startTime: '15:00',
      endTime: '16:00',
      isFreeTime: false,
      isRecurring: false,
      googleEventId: null,
      source: 'google',
      ...overrides,
    };
  }

  it('empty/whitespace query matches everything, mirroring taskMatchesQuery', () => {
    expect(eventMatchesQuery(event(), '')).toBe(true);
    expect(eventMatchesQuery(event(), '   ')).toBe(true);
    expect(eventMatchesQuery(event(), undefined)).toBe(true);
  });

  it('matches by title substring', () => {
    expect(eventMatchesQuery(event(), 'dentist')).toBe(true);
    expect(eventMatchesQuery(event(), 'appointment')).toBe(true);
  });

  it('matches by description substring', () => {
    expect(eventMatchesQuery(event({ description: 'Annual cleaning and checkup' }), 'cleaning')).toBe(true);
  });

  it('matches by location substring', () => {
    expect(eventMatchesQuery(event({ location: 'Downtown Dental Clinic' }), 'downtown')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(eventMatchesQuery(event(), 'DENTIST')).toBe(true);
    expect(eventMatchesQuery(event({ location: 'Downtown Clinic' }), 'CLINIC')).toBe(true);
  });

  it('does not match unrelated text, and tolerates missing optional fields', () => {
    expect(eventMatchesQuery(event(), 'standup')).toBe(false);
    expect(eventMatchesQuery(event(), 'clinic')).toBe(false); // no description/location set
  });
});
