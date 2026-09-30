/**
 * 账期。默认每月 15 号开始算一期：8/15 – 9/14 是一期，9/15 起算下一期。
 *
 * 一期用它的「起始日期」标识（YYYY-MM-DD），区间是左闭右开 [start, nextStart)。
 * 15 号归入新的一期 —— 否则相邻两期会在 15 号重叠，那天的账要么算两次要么算不清。
 *
 * 起始日设成 1 就退化成自然月。
 */

const pad = n => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();   // m 是 1-based

/** 起始日设 31 而当月没有 31 号时，钳到月末 */
const clamp = (y, m, day) => Math.min(Math.max(1, day), daysInMonth(y, m));

export function normalizeStartDay(v) {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? Math.min(31, Math.max(1, n)) : 1;
}

/** 某一天属于哪一期，返回那一期的起始日期 */
export function periodStartOf(iso, startDay) {
  const [y, m, d] = iso.split('-').map(Number);
  const s = clamp(y, m, startDay);
  if (d >= s) return ymd(y, m, s);
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  return ymd(py, pm, clamp(py, pm, startDay));
}

/**
 * 前后挪 delta 期。注意是从 (年,月) 重新钳起始日算的，不是在日期上加减天数 ——
 * 这样 1/31 → 2/28 → 3/31 能正确回到 31 号，而不是一路被钳死在 28 号。
 */
export function shiftPeriod(startISO, delta, startDay) {
  const [y, m] = startISO.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + delta, 1));
  const yy = t.getUTCFullYear(), mm = t.getUTCMonth() + 1;
  return ymd(yy, mm, clamp(yy, mm, startDay));
}

/** 下一期的起始日（本期的开区间右端） */
export const periodEndExclusive = (startISO, startDay) => shiftPeriod(startISO, 1, startDay);

/** 本期最后一天（闭区间右端），给用户看和给 SQL 的 BETWEEN 用 */
export const periodEndInclusive = (startISO, startDay) =>
  new Date(Date.parse(periodEndExclusive(startISO, startDay)) - 86400000)
    .toISOString().slice(0, 10);

/** 「8月15日 – 9月14日」；跨年时带上年份；起始日是 1 就显示成「2026 年 9 月」 */
export function periodLabel(startISO, startDay, today) {
  const [sy, sm, sd] = startISO.split('-').map(Number);
  if (startDay === 1) return `${sy} 年 ${sm} 月`;
  const [ey, em, ed] = periodEndInclusive(startISO, startDay).split('-').map(Number);
  const crossYear = today && (sy !== Number(today.slice(0, 4)) || ey !== Number(today.slice(0, 4)));
  const prefix = crossYear ? `${sy} 年 ` : '';
  return `${prefix}${sm}月${sd}日 – ${em}月${ed}日`;
}

/** 覆盖 [fromISO, toISO] 的所有账期，按时间倒序（新的在前） */
export function periodsBetween(fromISO, toISO, startDay) {
  const first = periodStartOf(fromISO, startDay);
  const out = [];
  let cur = periodStartOf(toISO, startDay);
  while (cur >= first && out.length < 600) {
    out.push(cur);
    cur = shiftPeriod(cur, -1, startDay);
  }
  return out;
}
