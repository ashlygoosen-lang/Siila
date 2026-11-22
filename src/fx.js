// Exchange rates for showing rand amounts in a visitor's own currency. Payments are always charged in rand (ZAR).
// Rates come from ExchangeRate-API's open endpoint (free, attribution required), refreshed twice a day and cached.
const db = require('./db');

const CURRENCIES = {
  ZAR: ['South African rand', 'R'], USD: ['US dollar', '$'], EUR: ['Euro', '€'], GBP: ['British pound', '£'], AUD: ['Australian dollar', 'A$'],
  CAD: ['Canadian dollar', 'C$'], NZD: ['New Zealand dollar', 'NZ$'], CHF: ['Swiss franc', 'CHF '], AED: ['UAE dirham', 'AED '], SAR: ['Saudi riyal', 'SAR '],
  INR: ['Indian rupee', '₹'], CNY: ['Chinese yuan', '¥'], JPY: ['Japanese yen', '¥'], SGD: ['Singapore dollar', 'S$'], HKD: ['Hong Kong dollar', 'HK$'],
  NGN: ['Nigerian naira', '₦'], KES: ['Kenyan shilling', 'KSh '], GHS: ['Ghanaian cedi', 'GH₵'], EGP: ['Egyptian pound', 'E£'], MAD: ['Moroccan dirham', 'MAD '],
  BWP: ['Botswana pula', 'P'], NAD: ['Namibian dollar', 'N$'], ZMW: ['Zambian kwacha', 'K'], MZN: ['Mozambican metical', 'MT '], ZWG: ['Zimbabwe gold', 'ZiG '],
  SEK: ['Swedish krona', 'kr '], NOK: ['Norwegian krone', 'kr '], DKK: ['Danish krone', 'kr '], PLN: ['Polish złoty', 'zł '], BRL: ['Brazilian real', 'R$'], MXN: ['Mexican peso', 'MX$'],
};

// Countries for sign-up, with the currency we suggest for showing prices.
const COUNTRIES = [
  ['South Africa', 'ZAR'], ['United States', 'USD'], ['United Kingdom', 'GBP'], ['Germany', 'EUR'], ['Netherlands', 'EUR'], ['France', 'EUR'], ['Ireland', 'EUR'],
  ['Spain', 'EUR'], ['Portugal', 'EUR'], ['Italy', 'EUR'], ['Belgium', 'EUR'], ['Austria', 'EUR'], ['Finland', 'EUR'], ['Switzerland', 'CHF'], ['Sweden', 'SEK'],
  ['Norway', 'NOK'], ['Denmark', 'DKK'], ['Poland', 'PLN'], ['Canada', 'CAD'], ['Australia', 'AUD'], ['New Zealand', 'NZD'], ['United Arab Emirates', 'AED'],
  ['Saudi Arabia', 'SAR'], ['India', 'INR'], ['China', 'CNY'], ['Japan', 'JPY'], ['Singapore', 'SGD'], ['Hong Kong', 'HKD'], ['Brazil', 'BRL'], ['Mexico', 'MXN'],
  ['Nigeria', 'NGN'], ['Kenya', 'KES'], ['Ghana', 'GHS'], ['Egypt', 'EGP'], ['Morocco', 'MAD'], ['Botswana', 'BWP'], ['Namibia', 'NAD'], ['Zambia', 'ZMW'],
  ['Zimbabwe', 'USD'], ['Mozambique', 'MZN'], ['Lesotho', 'ZAR'], ['Eswatini', 'ZAR'], ['Malawi', 'USD'], ['Tanzania', 'USD'], ['Uganda', 'USD'], ['Rwanda', 'USD'],
  ['Other', 'USD'],
];

// Used only until the first live fetch succeeds. Shown as approximate.
const FALLBACK = { ZAR: 1, USD: 0.055, EUR: 0.048, GBP: 0.042, AUD: 0.085, CAD: 0.077, NZD: 0.095, CHF: 0.045, AED: 0.2, SAR: 0.21, INR: 4.8, CNY: 0.4, JPY: 8.5,
  SGD: 0.072, HKD: 0.43, NGN: 85, KES: 7.1, GHS: 0.7, EGP: 2.7, MAD: 0.51, BWP: 0.75, NAD: 1, ZMW: 1.4, MZN: 3.5, ZWG: 1.5, SEK: 0.53, NOK: 0.6, DKK: 0.36, PLN: 0.21, BRL: 0.31, MXN: 1.05 };

const URL = 'https://open.er-api.com/v6/latest/ZAR';
const TTL_MS = 12 * 3600 * 1000;

function cached() {
  const r = db.prepare("SELECT value, updated_at FROM cache_kv WHERE key = 'fx'").get();
  if (!r) return null;
  try { return { ...JSON.parse(r.value), fetched_at: r.updated_at }; } catch { return null; }
}

let inflight = null;
async function refresh(force = false) {
  const c = cached();
  if (!force && c && Date.now() - Date.parse(c.fetched_at + 'Z') < TTL_MS) return c;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const r = await fetch(URL, { signal: AbortSignal.timeout(10000), headers: { 'user-agent': 'TalentBridge (talentbridge.co.za)' } });
      const j = await r.json();
      if (j.result !== 'success' || !j.rates?.USD) throw new Error('bad response');
      const rates = Object.fromEntries(Object.keys(CURRENCIES).filter(k => j.rates[k]).map(k => [k, j.rates[k]]));
      db.prepare("INSERT INTO cache_kv (key, value, updated_at) VALUES ('fx', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
        .run(JSON.stringify({ rates, updated: j.time_last_update_utc || new Date().toUTCString() }));
    } catch (e) { console.warn('Exchange rates not refreshed:', e.message); }
    finally { inflight = null; }
    return cached();
  })();
  return inflight;
}

/** Rates as "1 ZAR = x CUR". live is false while we are on the built-in approximate rates. */
function rates() {
  const c = cached();
  if (c?.rates) return { base: 'ZAR', rates: { ...FALLBACK, ...c.rates }, updated: c.updated, live: true,
    source: { name: 'ExchangeRate-API', url: 'https://www.exchangerate-api.com', label: 'Rates by Exchange Rate API' } };
  return { base: 'ZAR', rates: FALLBACK, updated: null, live: false, source: { name: 'approximate', url: '', label: 'Approximate rates' } };
}

const currencyFor = (country) => (COUNTRIES.find(([n]) => n === country) || [, 'USD'])[1];

module.exports = { CURRENCIES, COUNTRIES, rates, refresh, currencyFor };
