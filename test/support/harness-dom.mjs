/**
 * A DOM shim that is just enough for public/harness.js: the elements its functions reach for
 * by id and by `querySelector`, and the small window/document surface it touches at load.
 *
 * This exists so a compaction can be driven through the page's own functions — `compactNow`,
 * `applyStatusFrame`, `renderCompactionPanel` — rather than only against strings of source
 * text. It is deliberately tiny: anything the harness does that is not about compaction has
 * no reason to work here.
 */

const listeners = new Map()

/** @param {string} selector */
function getEl(selector) {
  if (listeners.has(selector)) return listeners.get(selector)
  const el = {
    id: selector,
    // The panel and the note are the two things compaction actually paints.
    children: new Map(),
    hidden: false,
    disabled: false,
    textContent: '',
    innerHTML: '',
    dataset: {},
    style: {},
    attrs: {},
    classes: new Set(),
    listener: null,
  }
  el.setAttribute = (name, value) => {
    el.attrs[name] = value
    if (name === 'data-tone') el.dataset.tone = value
  }
  el.getAttribute = (name) => (name in el.attrs ? el.attrs[name] : null)
  el.removeAttribute = (name) => {
    delete el.attrs[name]
    if (name === 'data-tone') delete el.dataset.tone
  }
  el.classList = {
    add: (c) => el.classes.add(c),
    remove: (c) => el.classes.delete(c),
    toggle: (c, on) => (on ? el.classes.add(c) : el.classes.delete(c)),
    contains: (c) => el.classes.has(c),
  }
  el.addEventListener = (name, fn) => {
    el.listener = { name, fn }
  }
  // `querySelector` is how the panel finds its own button, toggle, badge and note: each is a
  // child keyed by the attribute the panel queries it by, so a lookup always finds the right
  // one without a real query engine.
  el.querySelector = (sel) => {
    const attr = sel.replace(/^\[(.*)\]$/, '$1')
    if (el.children.has(attr)) return el.children.get(attr)
    const child = getEl(attr)
    el.children.set(attr, child)
    return child
  }
  el.querySelectorAll = () => [...el.children.values()]
  listeners.set(selector, el)
  return el
}

export function installHarnessDom() {
  for (const id of [
    'hx-hint',
    'hx-compaction-panel',
    'hx-send',
    'hx-stop',
    'hx-input',
    'hx-transcript',
    'hx-status',
    'hx-context',
  ]) {
    getEl(id)
  }
  globalThis.document = {
    readyState: 'complete',
    getElementById: getEl,
    querySelector: getEl,
    querySelectorAll: () => [],
    addEventListener: () => {},
    createElement: () => getEl('new-' + Math.random()),
    body: { classList: getEl('body').classList, dataset: {} },
    documentElement: { dataset: {} },
  }
  globalThis.window = globalThis
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  }
  globalThis.EventSource = class {}
}

export { getEl }
