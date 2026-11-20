// Home redraws after the mail sync only when nothing would be lost (audit 13).
import { describe, it, expect } from 'vitest';
import { installDom } from './dom-shim.js';

installDom();
const { homeIsBusy } = await import('../src/public/assets/screens/hq.js');

const body = { tagName: 'BODY' };
const docWith = ({ open = false, active = body } = {}) => ({ body, activeElement: active, querySelector: () => (open ? {} : null) });
const rootWith = (fields = []) => ({ querySelectorAll: () => fields });
const field = (value, defaultValue = '', type = 'text', tagName = 'INPUT') => ({ value, defaultValue, type, tagName });

describe('when Home may redraw', () => {
  it('redraws when nothing is open, focused or typed', () => {
    expect(homeIsBusy(rootWith([field('')]), docWith())).toBe(false);
  });
  it('waits while a dialog or pop-up is open', () => {
    expect(homeIsBusy(rootWith(), docWith({ open: true }))).toBe(true);
  });
  it('waits while the cursor is in a field', () => {
    expect(homeIsBusy(rootWith(), docWith({ active: { tagName: 'TEXTAREA' } }))).toBe(true);
    expect(homeIsBusy(rootWith(), docWith({ active: { tagName: 'DIV', isContentEditable: true } }))).toBe(true);
  });
  it('waits while a field holds unsaved text, even unfocused', () => {
    expect(homeIsBusy(rootWith([field('Call the accountant')]), docWith())).toBe(true);
    expect(homeIsBusy(rootWith([field('on', 'off', 'checkbox')]), docWith())).toBe(false);
  });
});
