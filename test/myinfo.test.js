import { describe, it, expect } from 'vitest';
import { DEFAULT_MYINFO, LANGS, mergeMyInfo, fieldsFor } from '../src/shared/myinfo.js';

describe('My info defaults', () => {
  it('never puts the full name in a text a form would show a client', () => {
    for (const f of fieldsFor(DEFAULT_MYINFO)) {
      if (f.group === 'person' && f.key === 'inbox') continue;
      expect(f.value, f.label).not.toMatch(/Huizenga/);
    }
  });

  it('keeps the two brands apart', () => {
    const { archive, realis } = DEFAULT_MYINFO.brands;
    expect(archive.email).toBe('contact@fieldnote.example');
    expect(realis.email).toBe('hello@kestrelstudio.example');
    for (const lang of LANGS) {
      expect(realis.about[lang]).not.toMatch(/UGC|Fieldnote/i);
      expect(realis.about[lang]).toContain('Kestrel Studio');
      expect(archive.about[lang]).not.toContain('Kestrel');
    }
    expect(realis.about.EN).toMatch(/architects and clinics/);
  });

  it('lists the channels with working links', () => {
    for (const c of DEFAULT_MYINFO.channels) expect(c.url).toMatch(/^https:\/\//);
    expect(DEFAULT_MYINFO.channels.map((c) => c.label)).toContain('Instagram');
  });

  it('merges a saved copy over the defaults, field by field', () => {
    const merged = mergeMyInfo({ person: { phone: '+32 1' }, brands: { realis: { short: { EN: 'x' } } } });
    expect(merged.person.phone).toBe('+32 1');
    expect(merged.person.name).toBe('Sam');
    expect(merged.brands.realis.short.EN).toBe('x');
    expect(merged.brands.realis.short.FR).toBe(DEFAULT_MYINFO.brands.realis.short.FR);
    expect(merged.brands.archive.about.EN).toBe(DEFAULT_MYINFO.brands.archive.about.EN);
    expect(mergeMyInfo(null)).toEqual(DEFAULT_MYINFO);
  });
});
