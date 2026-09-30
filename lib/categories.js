/**
 * 预设分类。可以在「设置」页里增删改，改完立刻生效。
 *
 * hint 是给模型看的语义提示，会拼进识别提示词里。光给分类名（「娱乐」「购物」）
 * 模型只能靠猜边界；把典型商户和易混淆的情况写清楚，准确率差别很大。
 * 提示用英文写是因为商户名基本都是英文，模型对齐起来更稳。
 */
export const DEFAULT_CATEGORIES = [
  { name: '餐饮', color: '#e8663d',
    hint: 'restaurants, cafés, coffee shops, bars, fast food, bakeries, food delivery (DoorDash, Uber Eats, Grubhub), boba/juice' },
  { name: '超市日用', color: '#3d8ee8',
    hint: 'supermarkets and grocery stores (Trader Joe\'s, Safeway, Whole Foods, H Mart, 99 Ranch), Costco/Sam\'s Club, convenience stores, household supplies, cleaning products, toiletries' },
  { name: '交通', color: '#7c5ce8',
    hint: 'gas stations (Shell, Chevron, 76), parking, tolls, rideshare (Uber, Lyft), public transit, car wash, auto repair and maintenance, DMV fees' },
  { name: '购物', color: '#e8a33d',
    hint: 'clothing, shoes, electronics, furniture and home goods, general merchandise (Amazon, Target, Walmart non-grocery), beauty and cosmetics, gifts' },
  { name: '娱乐', color: '#d13d8e',
    hint: 'movie theaters, concerts, event and sports tickets, museums, bowling/arcades, video games, hobby supplies — NOT monthly streaming subscriptions, those go to 通讯订阅' },
  { name: '医疗健康', color: '#2fb0a0',
    hint: 'pharmacy (CVS, Walgreens prescriptions), doctor and dentist visits, hospital and lab bills, insurance copays, vision/glasses, gym memberships and fitness studios' },
  { name: '居住', color: '#8a7a5c',
    hint: 'rent, mortgage, HOA, electricity, water, natural gas, trash, home repairs and furnishings for a fixed residence, renters insurance' },
  { name: '通讯订阅', color: '#4aa3d9',
    hint: 'phone bill, home internet, and any recurring monthly subscription — streaming (Netflix, Spotify, YouTube Premium, Disney+), software and cloud (iCloud, Google One, Adobe, ChatGPT), news and memberships' },
  { name: '教育', color: '#5cb85c',
    hint: 'tuition, school and exam fees, textbooks, online courses, tutoring, student loans' },
  { name: '旅行', color: '#e85c8a',
    hint: 'flights and airlines, hotels and Airbnb, rental cars, travel booking sites, baggage fees, tourist attractions away from home' },
  { name: '还款转账', color: '#8f96a3',
    hint: 'credit card payments ("PAYMENT - THANK YOU"), transfers between your own accounts, Zelle/Venmo/PayPal transfers to people, ATM cash withdrawals, loan payments — money moved, not money spent' },
  { name: '其他', color: '#6b7280',
    hint: 'use only when nothing above plausibly fits' },
];

export const FALLBACK_CATEGORY = '其他';
