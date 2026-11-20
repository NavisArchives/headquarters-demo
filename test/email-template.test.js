import { describe, it, expect } from 'vitest';
import { buildDesignedEmail } from '../src/shared/email-template.js';

const BODY = "Back to creating, let me introduce myself\nHope all is well!\n\nI've spent the past few years travelling.\n\nPortfolio: https://andyssarchives.com\nTikTok: @fieldnote.studio\n\nHope to talk soon!\n\nAndy\nAndy's Archive\n+32 400 00 00 00\nNL · FR · EN";

describe('buildDesignedEmail', () => {
  it('loads the hero photo from a hosted URL, never embedded', () => {
    const html = buildDesignedEmail({ body: BODY, profile: {} });
    expect(html).toContain('<img src="https://');
    expect(html).not.toContain('data:image');
  });

  it('uses a custom hosted hero URL from the profile when given one', () => {
    const html = buildDesignedEmail({ body: BODY, profile: { hero: 'https://cdn.example.com/me.jpg' } });
    expect(html).toContain('<img src="https://cdn.example.com/me.jpg"');
    expect(html).not.toContain('data:image');
  });

  it('falls back to the default hosted hero when the profile hero is not an https URL', () => {
    const html = buildDesignedEmail({ body: BODY, profile: { hero: 'not-a-url' } });
    expect(html).toContain('<img src="https://leads.example.com/hero.jpg"');
    expect(html).not.toContain('data:image');
  });

  it('never contains an embedded image anywhere, across inputs', () => {
    const html = buildDesignedEmail({ body: BODY, profile: { hero: '' } });
    expect(html).not.toMatch(/data:image/i);
  });

  it('includes the pixel image when given a pixelUrl', () => {
    const html = buildDesignedEmail({ body: BODY, profile: {}, pixelUrl: 'https://hq.example.com/px/abc123.gif' });
    expect(html).toContain('<img src="https://hq.example.com/px/abc123.gif"');
    expect(html).toContain('width="1" height="1"');
  });

  it('omits the pixel image entirely when no pixelUrl is given', () => {
    const html = buildDesignedEmail({ body: BODY, profile: {} });
    expect(html).not.toContain('width="1" height="1"');
  });

  it('renders the PORTFOLIO and TIKTOK buttons when the body has a links block', () => {
    const html = buildDesignedEmail({ body: BODY, profile: { portfolio: 'https://andyssarchives.com', social: '@fieldnote.studio' } });
    expect(html).toContain('>Portfolio<');
    expect(html).toContain('TikTok @fieldnote.studio');
    expect(html).toContain('https://www.tiktok.com/@fieldnote.studio');
  });

  it('renders the studio name, heading and signature', () => {
    const html = buildDesignedEmail({ body: BODY, profile: { studio: "Andy's Archive", name: 'Andy' } });
    expect(html).toContain("Andy&#39;s Archive");
    expect(html).toContain('Back to creating, let me introduce myself');
    expect(html).toContain('<strong style="color:#2b2320;">Andy</strong>');
  });

  it('stays at the 680px card width', () => {
    const html = buildDesignedEmail({ body: BODY, profile: {} });
    expect(html).toContain('width="680"');
    expect(html).toContain('width:680px');
  });

  it('escapes the hero URL, so a quote in the profile cannot escape the attribute', () => {
    const html = buildDesignedEmail({
      body: BODY,
      profile: { hero: 'https://x.test/a.jpg" onerror="alert(1)" data-x="<b>', name: 'Andy' },
    });
    expect(html).toContain('src="https://x.test/a.jpg&quot; onerror=&quot;alert(1)&quot; data-x=&quot;&lt;b&gt;"');
    expect(html).not.toContain('onerror="alert(1)"');
    expect(html).not.toContain('data-x="<b>');
  });

  it('escapes HTML-significant characters in the body', () => {
    const html = buildDesignedEmail({ body: 'Heading\n\nA & B < C > D', profile: {} });
    expect(html).toContain('A &amp; B &lt; C &gt; D');
    expect(html).not.toContain('A & B < C > D');
  });
});
