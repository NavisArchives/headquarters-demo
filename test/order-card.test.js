// The order card draws with an order (audit A1: « eyebrow is not defined »),
// and a lead becomes one project, however often the button is pressed.
import { describe, it, expect } from 'vitest';
import { installDom } from './dom-shim.js';

installDom();
globalThis.requestAnimationFrame ??= (fn) => setTimeout(fn, 0);
globalThis.document.addEventListener ??= () => {};
globalThis.document.removeEventListener ??= () => {};
const { orderCard, orderForLead } = await import('../src/public/assets/screens/orders.js');

const ORDER = {
  id: 7, client_id: 3, client_name: 'A Client', slug: 'a-project', title: 'Site and care', status: 'open',
  started_on: '2026-11-01', currency: 'EUR', notes: 'Lead: clinics/a', lines: [], entries: [], prepayments: [], totals: {},
};

function stub() {
  globalThis.fetch = async (url) => {
    const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (String(url).startsWith('/api/finance/orders/7')) return reply({ order: ORDER });
    if (String(url).startsWith('/api/finance/orders?slug=')) return reply({ orders: [ORDER] });
    return reply({});
  };
}

describe('the order card', () => {
  it('draws an existing order, with its client in the eyebrow', async () => {
    stub();
    const errors = [];
    const card = await orderCard('a-project', { orderId: 7, onChange: () => {} }).catch((e) => { errors.push(e); return null; });
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toEqual([]);
    expect(card.textContent).toContain('A Client');
  });

  it('draws an order on a project page too (compact mode)', async () => {
    stub();
    const card = await orderCard('a-project', { compactEmpty: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(card.textContent).toContain('A Client');
  });
});

describe('a lead that is a project already', () => {
  const orders = [
    { id: 1, status: 'ended', notes: 'Lead: clinics/a' },
    { id: 2, status: 'open', notes: 'Site: https://a.example\nLead: clinics/a' },
    { id: 3, status: 'open', notes: 'Lead: clinics/ab' },
  ];
  it('finds its open order by the Lead line, never a near match or an ended one', () => {
    expect(orderForLead(orders, 'clinics/a')?.id).toBe(2);
    expect(orderForLead(orders, 'clinics/b')).toBeNull();
    expect(orderForLead([orders[0]], 'clinics/a')).toBeNull();
  });
});
