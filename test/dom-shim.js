// A DOM small enough to read in one sitting, for testing the screens under
// vitest's `environment: 'node'`. No dependency is added for this: the screen
// code uses a dozen DOM calls, all of them listed here, and a shim keeps the
// "zero dependencies" rule while still putting the rendered markup under test.
//
// It is deliberately not a browser. It records structure and attributes, and
// serialises them back to HTML so a test can assert on what a browser would
// actually receive.

const VOID_TAGS = new Set(['link', 'meta', 'br', 'hr', 'img', 'input']);
// Attributes the screens set as properties rather than through setAttribute.
const PROPERTY_ATTRS = ['id', 'href', 'target', 'rel', 'type', 'src', 'alt', 'dateTime', 'tabIndex'];
const ATTR_NAME = { dateTime: 'datetime', tabIndex: 'tabindex' };

const escape = (value) => String(value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

class TextNode {
  constructor(text) { this.nodeValue = String(text); }
  get textContent() { return this.nodeValue; }
}

class Element {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.style = { cssText: '' };
    this._text = '';
  }

  set className(value) { this.attributes.class = value; }
  get className() { return this.attributes.class ?? ''; }

  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() {
    return this._text + this.children.map((child) => child.textContent).join('');
  }

  get childElementCount() { return this.children.filter((c) => c instanceof Element).length; }

  /** `node.firstChild` — what `clear()` in dom.js walks. */
  get firstChild() { return this.children[0] ?? null; }

  /** As in a real DOM, a node that already has a parent moves (phoneFrame() relies on it). */
  appendChild(child) {
    if (child.parentNode && child.parentNode !== this) child.parentNode.removeChild?.(child);
    else if (child.parentNode === this) this.children.splice(this.children.indexOf(child), 1);
    this.children.push(child); child.parentNode = this; return child;
  }

  removeChild(child) {
    const at = this.children.indexOf(child);
    if (at !== -1) this.children.splice(at, 1);
    child.parentNode = null;
    return child;
  }

  /** `node.remove()` — a real DOM method the screens use to take an element
   *  back off the page (the invoice's font stylesheet). */
  remove() { this.parentNode?.removeChild(this); }
  append(...nodes) { for (const node of nodes) if (node) this.appendChild(node); return this; }

  /** `node.replaceChildren(...)` — how the screens repaint a host in place. */
  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this._text = '';
    for (const node of nodes) if (node) this.appendChild(node);
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }

  /** Fire a listener the way a click would, for the tests that need one. */
  dispatch(type, event = {}) {
    for (const fn of this.listeners[type] ?? []) fn(event);
  }

  /** `node.dataset.x = …` — kept as a data-x attribute, as a browser does. */
  get dataset() {
    const kebab = (key) => String(key).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    this._dataset ??= new Proxy({}, {
      get: (_, key) => this.attributes[`data-${kebab(key)}`],
      set: (_, key, value) => { this.attributes[`data-${kebab(key)}`] = String(value); return true; },
    });
    return this._dataset;
  }

  /** `node.classList` — add, remove, toggle, contains, over the class attribute. */
  get classList() {
    const list = () => this.className.split(/\s+/).filter(Boolean);
    const write = (names) => { this.className = names.join(' '); };
    return {
      add: (...names) => write([...new Set([...list(), ...names])]),
      remove: (...names) => write(list().filter((n) => !names.includes(n))),
      contains: (name) => list().includes(name),
      toggle: (name, force) => {
        const want = force === undefined ? !list().includes(name) : Boolean(force);
        write(want ? [...new Set([...list(), name])] : list().filter((n) => n !== name));
        return want;
      },
    };
  }

  /** One compound selector, no combinators: tag, #id, .class, [attr], [attr="v"]. */
  matches(selector) {
    const parts = selector.match(/^[a-z0-9-]+|#[\w-]+|\.[\w-]+|\[[^\]]+\]/gi) ?? [];
    if (parts.join('') !== selector) throw new Error(`dom-shim: unsupported selector ${selector}`);
    const attrs = { ...this.attributes };
    for (const prop of PROPERTY_ATTRS) if (this[prop] !== undefined) attrs[ATTR_NAME[prop] ?? prop] = String(this[prop]);
    return parts.every((part) => {
      if (part[0] === '#') return attrs.id === part.slice(1);
      if (part[0] === '.') return this.classList.contains(part.slice(1));
      if (part[0] === '[') {
        const [, name, value] = /^\[([\w-]+)(?:="?([^"\]]*)"?)?\]$/.exec(part) ?? [];
        return value === undefined ? name in attrs : attrs[name] === value;
      }
      return this.tagName === part;
    });
  }

  querySelectorAll(selector) { return this.all().slice(1).filter((node) => node.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }

  /** Every element in this subtree, this one first. */
  all() {
    const out = [this];
    for (const child of this.children) if (child instanceof Element) out.push(...child.all());
    return out;
  }

  find(tagName) { return this.all().filter((node) => node.tagName === tagName); }

  get outerHTML() {
    const attrs = { ...this.attributes };
    for (const prop of PROPERTY_ATTRS) {
      if (this[prop] !== undefined) attrs[ATTR_NAME[prop] ?? prop] = this[prop];
    }
    const pairs = Object.entries(attrs)
      .map(([name, value]) => ` ${name}="${escape(value)}"`).join('');
    if (VOID_TAGS.has(this.tagName) && !this.children.length && !this._text) {
      return `<${this.tagName}${pairs}>`;
    }
    return `<${this.tagName}${pairs}>${this.innerHTML}</${this.tagName}>`;
  }

  get innerHTML() {
    return escape(this._text) + this.children
      .map((child) => (child instanceof Element ? child.outerHTML : escape(child.nodeValue)))
      .join('');
  }
}

class Fragment extends Element {
  constructor() { super(null); }
  get outerHTML() { return this.innerHTML; }
}

/** Install a fresh `document` (and `navigator`) on globalThis; returns it. */
export function installDom() {
  const head = new Element('head');
  const document = {
    head,
    documentElement: new Element('html'),
    body: new Element('body'),
    title: '',
    createElement: (tagName) => new Element(tagName),
    createTextNode: (text) => new TextNode(text),
    createDocumentFragment: () => new Fragment(),
    getElementById: (id) => head.all().find((node) => node.id === id) ?? null,
  };
  globalThis.document = document;
  globalThis.navigator ??= {};
  return document;
}

/** Serialise anything this shim produced. */
export const html = (node) => (node instanceof Element ? node.outerHTML : String(node ?? ''));

export { Element, Fragment, TextNode };
