import { describe, it, expect } from 'vitest';
import { buildAttachmentPath } from '../../src/services/attachmentService';

describe('buildAttachmentPath', () => {
  it('uses the uid-scoped personal path when sharedProjectId is absent', () => {
    const path = buildAttachmentPath('uid1', 'task1', 'report.pdf', undefined);
    expect(path).toMatch(/^users\/uid1\/attachments\/task1\/\d+_report\.pdf$/);
  });

  it('uses the uid-scoped personal path when sharedProjectId is null', () => {
    const path = buildAttachmentPath('uid1', 'task1', 'report.pdf', null);
    expect(path).toMatch(/^users\/uid1\/attachments\/task1\/\d+_report\.pdf$/);
  });

  it('uses the project-scoped path when sharedProjectId is present, ignoring uid', () => {
    const path = buildAttachmentPath('uid1', 'task1', 'report.pdf', 'proj123');
    expect(path).toMatch(/^sharedProjects\/proj123\/attachments\/task1\/\d+_report\.pdf$/);
    expect(path).not.toContain('uid1');
  });

  it('keeps the filename verbatim (including any special characters) at the end of the path', () => {
    const path = buildAttachmentPath('uid1', 'task1', 'my file (1).png', 'proj123');
    expect(path.endsWith('my file (1).png')).toBe(true);
  });
});
