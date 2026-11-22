import { describe, expect, it } from 'vitest';
import { DIGITAL_SIGNATURE_WARNING, inspectForEditing } from '../../src/inspect';
import { digitallySigned, mixedSizes, passwordProtected, rotated } from '../fixtures/fixtures';

describe('inspectForEditing', () => {
  it('accepts ordinary PDFs without warnings', async () => {
    for (const make of [mixedSizes, rotated]) {
      const r = await inspectForEditing(await make());
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.warnings).toEqual([]);
        expect(r.hasDigitalSignature).toBe(false);
      }
    }
  });
  it('detects a signature dictionary and warns', async () => {
    const r = await inspectForEditing(await digitallySigned());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.hasDigitalSignature).toBe(true);
      expect(r.warnings).toContain(DIGITAL_SIGNATURE_WARNING);
    }
  });
  it('reports encrypted files as not exportable before signing', async () => {
    const r = await inspectForEditing(await passwordProtected());
    expect(r).toMatchObject({ ok: false, kind: 'encrypted' });
  });
});
