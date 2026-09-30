/* 三个页面共用的一点点东西。没有框架，没有构建步骤。 */

export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

export async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; }
  catch { throw new Error(text.slice(0, 200) || `HTTP ${res.status}`); }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/* 金额一律以「分」在后端流转，前端只负责显示 */
export const money = (cents, cur = 'USD') => {
  // ¥ 给人民币；日元也用这个符号，会混，所以除了下面这几个都直接标币种代码
  const sym = { USD: '$', CNY: '¥', EUR: '€', GBP: '£', HKD: 'HK$' }[cur];
  const n = Math.abs(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
  const body = (cents < 0 ? '-' : '') + (sym || '') + n;
  return sym ? body : `${body} ${cur}`;
};

export const KIND_CN = { expense: '支出', refund: '退款', payment: '还款/转账' };
export const SOURCE_CN = { receipt: '小票', statement: '账单', manual: '手动' };

/** 2026-09-01 -> 9月1日；今天/昨天特殊显示 */
export function niceDate(iso, today) {
  if (!iso) return '';
  if (iso === today) return '今天';
  const y = new Date(Date.parse(today) - 86400000).toISOString().slice(0, 10);
  if (iso === y) return '昨天';
  const [, m, d] = iso.split('-');
  const sameYear = today && iso.slice(0, 4) === today.slice(0, 4);
  return sameYear ? `${+m}月${+d}日` : `${iso.slice(0, 4)}年${+m}月${+d}日`;
}

/** 顶部导航。current 是当前页。 */
export function mountNav(current, pending = 0) {
  const link = (href, label, badge) =>
    el('a', { href, class: current === href ? 'on' : '' },
      label, badge ? el('span', { class: 'dot' }, badge) : null);
  document.body.prepend(
    el('nav', {},
      el('span', { class: 'brand' }, '记账'),
      link('/', '账目', pending),
      link('/upload', '上传'),
      link('/settings', '设置'),
    )
  );
}

/** 页面顶部的一次性提示。kind: ok | info | warn | err */
export function flash(container, kind, content, { sticky = false } = {}) {
  const box = el('div', { class: `banner ${kind}` });
  if (typeof content === 'string') box.append(content); else box.append(content);
  container.prepend(box);
  if (!sticky) setTimeout(() => box.remove(), 9000);
  return box;
}

/** 环形图。data: [{name, cents, color}]，纯 SVG，不引任何图表库。 */
export function donut(data, { size = 168, thickness = 20, cur = 'USD', onSlice } = {}) {
  const total = data.reduce((s, d) => s + Math.max(0, d.cents), 0);
  const r = (size - thickness) / 2;
  const C = 2 * Math.PI * r;
  const NS = 'http://www.w3.org/2000/svg';

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.style.transform = 'rotate(-90deg)';

  const ring = (color, dash, offset, cls) => {
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', size / 2); c.setAttribute('cy', size / 2); c.setAttribute('r', r);
    c.setAttribute('fill', 'none'); c.setAttribute('stroke', color);
    c.setAttribute('stroke-width', thickness);
    if (dash) c.setAttribute('stroke-dasharray', dash);
    if (offset) c.setAttribute('stroke-dashoffset', offset);
    if (cls) c.setAttribute('class', cls);
    svg.append(c);
    return c;
  };

  ring(getComputedStyle(document.body).getPropertyValue('--border') || '#e5e7eb');

  if (total > 0) {
    let acc = 0;
    for (const d of data) {
      const v = Math.max(0, d.cents);
      if (!v) continue;
      const len = (v / total) * C;
      // 每段留 1.5px 缝隙，视觉上能分开
      const seg = ring(d.color || '#6b7280', `${Math.max(0, len - 1.5)} ${C}`, -acc);
      seg.style.cursor = onSlice ? 'pointer' : 'default';
      const pct = ((v / total) * 100).toFixed(1);
      const t = document.createElementNS(NS, 'title');
      t.textContent = `${d.name} ${money(v, cur)}（${pct}%）`;
      seg.append(t);
      if (onSlice) seg.addEventListener('click', () => onSlice(d));
      acc += len;
    }
  }

  const wrap = el('div', { class: 'donut' });
  wrap.style.position = 'relative';
  wrap.append(svg);
  wrap.append(el('div', {
    style: `position:absolute;inset:0;display:flex;flex-direction:column;
            align-items:center;justify-content:center;pointer-events:none;`,
  },
    el('div', { style: 'font-size:19px;font-weight:640;letter-spacing:-.01em' }, money(total, cur)),
    el('div', { class: 'tiny faint', style: 'margin-top:1px' }, `${data.length} 个分类`),
  ));
  return wrap;
}
