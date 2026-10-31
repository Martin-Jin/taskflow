import { describe, it, expect } from 'vitest';
import { fuzzyFilterTasks } from '../../src/utils/fuzzyTaskSearch';

const tasks = [{ title: 'Start looking at flats' }, { title: 'Piano practice' }, { title: 'Stretch' }];

describe('fuzzyFilterTasks', () => {
  it('returns every task for an empty query', () => {
    expect(fuzzyFilterTasks(tasks, '', (t) => t.title)).toHaveLength(3);
  });

  it('ranks an exact substring above a scattered match', () => {
    const result = fuzzyFilterTasks(tasks, 'str', (t) => t.title).map((t) => t.title);
    expect(result[0]).toBe('Stretch');
  });

  it('matches letters in order, and drops titles that cannot match', () => {
    const result = fuzzyFilterTasks(tasks, 'pnp', (t) => t.title).map((t) => t.title);
    expect(result).toEqual(['Piano practice']);
  });
});
