import { reviewBatch } from './outreach-review.js';
import { renderDailyPlanner } from './outreach-planner.js';
import { el, hero, emptyState, attentionRow } from "../dom.js";
import { apiFetch } from "../api.js";
import { toast, openModal } from "../leads-ui.js";
const money = (c, currency) => new Intl.NumberFormat("en", { style: "currency", currency, maximumFractionDigits: 0 }).format(c / 100);
const send = (url, body, method = "POST") => apiFetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
function button(label, fn, primary = false) {
  const b = el("button", `btn small${primary ? " primary" : ""}`, label);
  b.type = "button";
  b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      await fn();
    } catch (e) {
      toast(e.message);
    } finally {
      b.disabled = false;
    }
  });
  return b;
}
function field(parent, label, value = "", type = "text") {
  const wrap = el("label", "ow-field");
  wrap.append(el("span", null, label));
  const input = el(type === "textarea" ? "textarea" : "input", "text-input");
  if (type !== "textarea") input.type = type;
  input.value = value;
  wrap.append(input);
  parent.append(wrap);
  return input;
}
function card(title, { fill = false, actions = [] } = {}) {
  const n = el("section", `card ow-card${fill ? " ow-fill" : ""}`);
  const head = el("div", "ow-head");
  head.append(el("h2", null, title), ...actions);
  n.append(head);
  return n;
}
function tile(label, value) {
  const t = el("div", "card ow-tile");
  t.append(el("span", "ow-tile-label", label), el("b", "ow-number", value));
  return t;
}
function alertsButton() {
  return button("Alerts", async () => {
    if (!("Notification" in window)) {
      toast("This browser cannot show alerts. On iPhone, add HQ to the Home Screen first.");
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission === "granted") {
      localStorage.setItem("hq.warm-alerts", "on");
      toast("You will get an alert for a warm reply while HQ is open");
    } else toast("Alerts were not turned on");
  });
}
function link(label, path, ctx) {
  const a = el("a", null, label);
  a.href = path;
  a.addEventListener("click", (e) => {
    e.preventDefault();
    ctx.navigate(path);
  });
  return a;
}
/** Andy's « Interested »: the reply (or lead) marked interested, the lead to « In talks »,
 *  the card off the list, with an Undo (attention.js). */
async function markInterested(item, ctx) {
  try {
    const out = await apiFetch("/api/outreach/attention/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refs: [item.number], action: "interested" }) });
    if (!out.done?.length) { toast(out.skipped?.[0]?.why || "Nothing changed"); return; }
    await ctx.refresh?.();
    toast(`${item.number} ${item.title}: interested`, { action: { label: "Undo", onClick: async () => {
      await apiFetch("/api/outreach/attention/undo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ undo: out.undo }) });
      toast("Undone"); await ctx.refresh?.();
    } } });
  } catch (e) { toast(e.message || "Could not mark it interested"); }
}
const CAN_BE_INTERESTED = new Set(["warm_reply", "check_conversation", "follow_up"]);
function queuePanel(queue, ctx) {
  const c = card("Needs your attention", { fill: true, actions: [alertsButton()] });
  const list = el("div", "ow-list");
  if (!queue.length) list.append(emptyState("You are up to date", "Nothing needs you right now."));
  for (const item of queue) {
    const due = item.due ? new Date(item.due.length === 10 ? `${item.due}T12:00:00` : item.due) : null;
    const overdue = due && due < Date.now();
    const row = attentionRow({ dot: overdue ? "d-bad" : item.kind === "warm_reply" ? "d-warn" : "d-idle", who: item.title, sub: [item.action, item.detail].filter(Boolean).join(" \xB7 "), when: due ? due.toLocaleString("en", { month: "short", day: "numeric", ...item.due.length > 10 ? { hour: "2-digit", minute: "2-digit" } : {} }) : "", onClick: () => ctx.navigate(item.href) });
    // The number first, in mono, big enough to read off the screen and dictate (« 14 is done »).
    if (item.number) { const num = el("span", "ow-num", item.number); num.setAttribute("aria-label", `Number ${item.number}`); row.insertBefore(num, row.children[1]); }
    if (item.number && item.uid && CAN_BE_INTERESTED.has(item.kind)) {
      const line = el("div", "ow-attn");
      const yes = el("button", "btn small", "Interested");
      yes.type = "button";
      yes.setAttribute("aria-label", `Mark ${item.title} interested`);
      yes.addEventListener("click", () => void markInterested(item, ctx));
      line.append(row, yes);
      list.append(line);
    } else list.append(row);
  }
  c.append(list);
  return c;
}
async function openTimeline(uid) {
  const { events } = await apiFetch(`/api/outreach/timeline?uid=${encodeURIComponent(uid)}`);
  const { modal, close } = openModal({ label: "Lead timeline", className: "ow-modal" });
  modal.append(el("h2", null, "What happened"), button("Close", close));
  const list = el("div", "ow-review");
  if (!events.length) list.append(emptyState("No recorded activity", "Unknown history is not counted as a send."));
  for (const e of events) {
    const item = el("article", "ow-message");
    item.append(el("h3", null, `${e.kind} \xB7 ${new Date(e.at).toLocaleString()}`), el("p", null, e.detail));
    if (e.kind === "sent" || e.kind === "reply") item.append(el("p", "hint", `From: ${e.sender || "unknown"} \xB7 To: ${e.sent_to || "unknown"} \xB7 Evidence: ${e.provenance || "legacy record"}`), el("b", null, e.subject || "Subject not recorded"), el("pre", null, e.body || "Exact message not recorded"));
    list.append(item);
  }
  modal.append(list);
}
async function renderOutreach(ctx) {
  const root = el("div", "ow-screen phone-frame");
  root.append(hero("Your", "outreach"));
  const tabs = el("div", "tabs ow-tabs");
  const body = el("div", "ow-body scroll-region");
  let active = new URLSearchParams(location.search).get("view") || "cockpit";
  const tabButtons = /* @__PURE__ */ new Map();
  const refresh = async () => {
    body.replaceChildren(el("p", "hint", "Loading\u2026"));
    for (const [key, b] of tabButtons) b.setAttribute("aria-selected", String(key === active));
    try {
      const out = el("div", "ow-stack ow-view");
      if (active === "cockpit" || active === "today") {
        const data = await apiFetch("/api/outreach/cockpit");
        if (active === "cockpit") {
          const warm = data.replies.filter((r) => ["interested", "wants_info", "wants_call", "asks_rate"].includes(r.intent)).reduce((n, r) => n + r.n, 0);
          const paid = data.paid.length ? data.paid.map((r) => money(r.cents, r.currency)).join(" + ") : money(0, "EUR");
          const tiles = el("div", "ow-tiles");
          tiles.append(
            tile("Sent today", String(data.sent.today)), tile("This week", String(data.sent.week)),
            tile("This month", String(data.sent.month)), tile("All time", String(data.sent.all)),
            tile("Interested", String(warm)), tile("Money received", paid),
          );
          out.append(tiles);
        }
        out.append(queuePanel(data.queue, { ...ctx, refresh }));
      } else if (active === "planner") {
        out.append(await renderDailyPlanner({ refresh, reviewBatch }));
      } else if (active === "sent" || active === "no_contact") {
        const c = card(active === "sent" ? "Who has been contacted" : "Closed or blocked, never emailed again", { fill: true });
        const list = el("div", "ow-list");
        let offset = 0;
        const load = async () => {
          const data = await apiFetch(`/api/outreach/contacts?state=${active}&offset=${offset}`);
          if (!offset && !data.contacts.length) list.append(emptyState(active === "sent" ? "Nobody yet" : "Nobody here", active === "sent" ? "Emails you send show up here." : "Closed and blocked leads show up here."));
          for (const r of data.contacts) {
            const row = el("div", "ow-planner-row");
            row.append(
              el("b", null, r.name),
              el("p", "hint", `${r.email || "No email"} \xB7 ${r.sends} emails \xB7 ${r.stage}`),
              el("p", null, r.reason || (r.follow_up ? `Next follow-up: ${r.follow_up}` : "No follow-up scheduled")),
              button("History", () => openTimeline(r.uid)),
              button("Open lead", () => ctx.navigate(`/leads?lead=${encodeURIComponent(r.uid)}`))
            );
            list.append(row);
          }
          offset += data.contacts.length;
          more.hidden = !data.more;
        };
        const more = button("Load more", load);
        await load();
        list.append(more);
        c.append(list);
        out.append(c);
      } else if (active === "batches") {
        const { batches } = await apiFetch("/api/outreach/batches");
        const c = card("Daily approvals", { fill: true });
        const list = el("div", "ow-list");
        c.append(list);
        if (!batches.length) list.append(emptyState("No batches yet", "Build one in Planner, then approve it here."));
        for (const b of batches) list.append(attentionRow({ dot: b.status === "approved" ? "d-ok" : "d-idle", who: `${b.day} \xB7 ${b.emails} emails`, sub: `${b.sender} \xB7 ${b.status}${b.approved_by ? ` \xB7 ${b.approved_by}` : ""}`, when: "Review", onClick: () => void reviewBatch(b.id, refresh).catch((e) => toast(e.message)) }));
        out.append(c);
      }
      body.replaceChildren(out);
    } catch (e) {
      body.replaceChildren(emptyState("Could not load outreach", e.message, button("Try again", refresh)));
    }
  };
  for (const [key, label] of [["cockpit", "Overview"], ["database", "Database"], ["today", "Needs action"], ["planner", "Planner"], ["batches", "Approvals"], ["sent", "Sent"], ["no_contact", "No contact"]]) {
    const b = button(label, async () => {
      if (key === "database") {
        ctx.navigate("/leads");
        return;
      }
      active = key;
      await refresh();
    });
    b.setAttribute("role", "tab");
    tabButtons.set(key, b);
    tabs.append(b);
  }
  tabs.setAttribute("role", "tablist");
  root.append(tabs, body);
  await refresh();
  const timer = setInterval(() => {
    if (!root.isConnected) {
      clearInterval(timer);
      return;
    }
    if (!["cockpit", "today"].includes(active) || document.querySelector(".scrim") || document.activeElement?.matches("input,textarea,select")) return;
    void refresh();
  }, 6e4);
  return root;
}
export {
  openTimeline,
  queuePanel,
  renderOutreach
};
