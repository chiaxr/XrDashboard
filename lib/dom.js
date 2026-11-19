// Tiny DOM builders. Text is always set with textContent / createTextNode — never HTML.

const SVG_NS = 'http://www.w3.org/2000/svg';

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/**
 * h('div', { class: 'x', style: { top: '4px' }, onclick: fn, dataset: {...} }, ...children)
 * Attribute values are set via setAttribute (never parsed as markup).
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  applyAttrs(el, attrs);
  append(el, children);
  return el;
}

export function s(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  applyAttrs(el, attrs);
  append(el, children);
  return el;
}

function applyAttrs(el, attrs) {
  if (!attrs) return;
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'style' && typeof v === 'object') {
      for (const [p, val] of Object.entries(v)) {
        if (val != null) el.style.setProperty(p, String(val));
      }
    } else if (k === 'dataset') {
      Object.assign(el.dataset, v);
    } else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2), v);
    } else {
      el.setAttribute(k, v === true ? '' : String(v));
    }
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function replace(el, ...children) {
  clear(el);
  append(el, children);
  return el;
}
