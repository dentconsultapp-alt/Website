#!/usr/bin/env node
/**
 * DentConsult — Google Places API (New) dental-clinic collector.
 *
 * Collects publicly listed dental clinics for a target area using the
 * Places API (New) Text Search endpoint, deduplicates, normalizes Indian
 * phone numbers, and writes a CSV.
 *
 * Usage:
 *   GOOGLE_PLACES_API_KEY=... node collect.mjs --verify        # key sanity check
 *   GOOGLE_PLACES_API_KEY=... node collect.mjs --area banjara  # full run (default area)
 *
 * The API key is read ONLY from the GOOGLE_PLACES_API_KEY environment
 * variable. It is never printed, logged, or written to any file.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const SEARCH_TEXT_URL = 'https://places.googleapis.com/v1/places:searchText';

// ---- Area definitions -------------------------------------------------------
// Only Banjara Hills is enabled for now, per instructions. Adding a new area
// later is just another entry here.
const AREAS = {
  banjara: {
    label: 'Banjara Hills, Hyderabad',
    area: 'Banjara Hills',
    // Approx. centre of Banjara Hills; biases (does not hard-restrict) results.
    center: { latitude: 17.4126, longitude: 78.4392 },
    radius: 3000, // metres
    queries: [
      'Dental clinics in Banjara Hills Hyderabad',
      'Dentist in Banjara Hills Hyderabad',
      'Dental hospital in Banjara Hills Hyderabad',
      'Dental implant clinic in Banjara Hills Hyderabad',
      'Orthodontist in Banjara Hills Hyderabad',
      'Endodontist in Banjara Hills Hyderabad',
      'Pediatric dentist in Banjara Hills Hyderabad',
      'Prosthodontist in Banjara Hills Hyderabad',
      'Periodontist in Banjara Hills Hyderabad',
    ],
  },
};

// Fields we ask Google to return. Text Search (New) can return contact + rating
// fields directly, so no separate Place Details call is needed.
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.nationalPhoneNumber',
  'places.internationalPhoneNumber',
  'places.websiteUri',
  'places.rating',
  'places.userRatingCount',
  'places.googleMapsUri',
  'places.primaryType',
  'nextPageToken',
].join(',');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Phone normalization (India) -------------------------------------------
/**
 * Normalize an Indian phone number to a consistent canonical form.
 * Returns { canonical, display } or null if it can't be parsed.
 *   canonical: digits only in E.164-ish form without '+', e.g. 919876543210
 *              (used for dedup comparison)
 *   display:   pretty form, e.g. "+91 98765 43210" (mobile) or "+91 40 12345678"
 */
function normalizeIndianPhone(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/[^\d+]/g, '');
  // Drop a leading '+' for processing; remember it existed.
  digits = digits.replace(/^\+/, '');
  // Strip international/trunk prefixes down to the national number.
  if (digits.startsWith('0091')) digits = digits.slice(4);
  else if (digits.startsWith('91') && digits.length > 10) digits = digits.slice(2);
  else if (digits.startsWith('0')) digits = digits.replace(/^0+/, '');

  if (digits.length < 8 || digits.length > 12) {
    // Unexpected length — keep original as-is rather than mangle it.
    return { canonical: '91' + digits, display: String(raw).trim() };
  }

  const canonical = '91' + digits;
  let display;
  if (digits.length === 10 && /^[6-9]/.test(digits)) {
    // Mobile: +91 XXXXX XXXXX
    display = `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;
  } else {
    // Landline or other: keep grouped simply as +91 <rest>
    display = `+91 ${digits}`;
  }
  return { canonical, display };
}

// ---- Places API calls -------------------------------------------------------
async function textSearch(textQuery, area, pageToken) {
  const body = {
    textQuery,
    languageCode: 'en',
    regionCode: 'IN',
    pageSize: 20,
    locationBias: {
      circle: { center: area.center, radius: area.radius },
    },
  };
  if (pageToken) body.pageToken = pageToken;

  const res = await fetch(SEARCH_TEXT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': API_KEY,
      'X-Goog-FieldMask': FIELD_MASK,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { _raw: text };
  }
  return { status: res.status, json };
}

/** Run one query with full pagination (Text Search New caps at ~60 results). */
async function runQuery(textQuery, area) {
  const collected = [];
  let pageToken;
  let page = 0;
  do {
    const { status, json } = await textSearch(textQuery, area, pageToken);
    if (status !== 200) {
      const msg = json?.error?.message || json?._raw || `HTTP ${status}`;
      throw new Error(`API error (${status}) on "${textQuery}": ${msg}`);
    }
    const places = json.places || [];
    collected.push(...places);
    pageToken = json.nextPageToken;
    page += 1;
    // Google requires a brief delay before a page token becomes valid.
    if (pageToken) await sleep(2200);
  } while (pageToken && page < 3);
  return collected;
}

// ---- Record shaping & dedup -------------------------------------------------
function toRecord(place, area) {
  const phoneRaw = place.internationalPhoneNumber || place.nationalPhoneNumber || '';
  const norm = normalizeIndianPhone(phoneRaw);
  return {
    placeId: place.id || '',
    name: place.displayName?.text || '',
    phoneDisplay: norm ? norm.display : 'Not Available',
    phoneCanonical: norm ? norm.canonical : '',
    address: place.formattedAddress || '',
    area: area.area,
    website: place.websiteUri || '',
    mapsLink: place.googleMapsUri || (place.id ? `https://www.google.com/maps/place/?q=place_id:${place.id}` : ''),
    rating: place.rating != null ? String(place.rating) : '',
    reviews: place.userRatingCount != null ? String(place.userRatingCount) : '',
  };
}

function normKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Deduplicate: Place ID first, then normalized phone, then name+address.
 * Preserves distinct branches (same phone but different name+address is only
 * merged when the phone matches AND names are effectively the same).
 */
function dedupe(records) {
  const byPlaceId = new Map();
  const byPhone = new Map();
  const byNameAddr = new Map();
  const unique = [];
  let removed = 0;

  for (const r of records) {
    // 1) Exact same Place ID => same listing.
    if (r.placeId && byPlaceId.has(r.placeId)) {
      merge(byPlaceId.get(r.placeId), r);
      removed++;
      continue;
    }

    // 2) Same normalized phone AND same normalized name => same clinic.
    //    (Phone alone is not enough — a chain HQ line can span branches — so we
    //     also require the name to match, which protects distinct branches.)
    const nameK = normKey(r.name);
    const phoneHit = r.phoneCanonical && byPhone.get(r.phoneCanonical);
    if (phoneHit && normKey(phoneHit.name) === nameK) {
      merge(phoneHit, r);
      removed++;
      continue;
    }

    // 3) Same normalized name + address => same clinic.
    const naK = nameK + '|' + normKey(r.address);
    if (byNameAddr.has(naK)) {
      merge(byNameAddr.get(naK), r);
      removed++;
      continue;
    }

    unique.push(r);
    if (r.placeId) byPlaceId.set(r.placeId, r);
    if (r.phoneCanonical && !byPhone.has(r.phoneCanonical)) byPhone.set(r.phoneCanonical, r);
    byNameAddr.set(naK, r);
  }
  return { unique, removed };
}

/** Fill blank fields on the kept record from a duplicate (keep first non-empty). */
function merge(keep, dup) {
  for (const k of ['phoneDisplay', 'phoneCanonical', 'website', 'rating', 'reviews', 'mapsLink', 'address']) {
    const cur = keep[k];
    if ((!cur || cur === 'Not Available') && dup[k] && dup[k] !== 'Not Available') {
      keep[k] = dup[k];
    }
  }
}

// ---- CSV --------------------------------------------------------------------
function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(records) {
  const header = ['Clinic Name', 'Phone Number', 'Address', 'Area', 'Website', 'Google Maps Link', 'Rating', 'Reviews'];
  const lines = [header.join(',')];
  for (const r of records) {
    lines.push([
      r.name,
      r.phoneDisplay || 'Not Available',
      r.address,
      r.area,
      r.website,
      r.mapsLink,
      r.rating,
      r.reviews,
    ].map(csvCell).join(','));
  }
  return lines.join('\n') + '\n';
}

// ---- Main -------------------------------------------------------------------
async function verify() {
  const area = AREAS.banjara;
  const { status, json } = await textSearch('Dental clinic in Banjara Hills Hyderabad', area);
  if (status !== 200) {
    const msg = json?.error?.message || json?._raw || `HTTP ${status}`;
    console.error(`❌ Key check FAILED (HTTP ${status}): ${msg}`);
    if (json?.error?.status) console.error(`   status: ${json.error.status}`);
    process.exitCode = 1;
    return;
  }
  const n = (json.places || []).length;
  console.log('✅ API key works. Places API (New) responded successfully.');
  console.log(`   Sample query returned ${n} result(s) on the first page.`);
  if (n > 0) {
    const p = json.places[0];
    console.log(`   e.g. "${p.displayName?.text}" — ${p.formattedAddress || 'no address'}`);
  }
}

async function run(areaKey) {
  const area = AREAS[areaKey];
  if (!area) {
    console.error(`Unknown area "${areaKey}". Known: ${Object.keys(AREAS).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n=== Collecting dental clinics: ${area.label} ===\n`);
  const allRaw = [];
  const perQuery = [];
  const failed = [];

  for (const q of area.queries) {
    try {
      const places = await runQuery(q, area);
      perQuery.push({ q, count: places.length });
      for (const p of places) allRaw.push(toRecord(p, area));
      console.log(`  ✓ ${places.length.toString().padStart(3)}  ${q}`);
      await sleep(400); // be gentle between queries
    } catch (e) {
      failed.push({ q, error: e.message });
      console.log(`  ✗   0  ${q}  — ${e.message}`);
    }
  }

  const { unique, removed } = dedupe(allRaw);

  // Ensure phone display consistency.
  for (const r of unique) if (!r.phoneDisplay) r.phoneDisplay = 'Not Available';

  const withPhone = unique.filter((r) => r.phoneDisplay && r.phoneDisplay !== 'Not Available');
  const withoutPhone = unique.filter((r) => !r.phoneDisplay || r.phoneDisplay === 'Not Available');
  const uniquePhones = new Set(withPhone.map((r) => r.phoneCanonical)).size;

  const csv = toCsv(unique);
  const outPath = join(__dirname, 'dentconsult_banjara_hills_dental_clinics.csv');
  writeFileSync(outPath, csv, 'utf8');

  // ---- Summary ----
  console.log('\n=== SUMMARY ===');
  console.log(`Target area:               ${area.label}`);
  console.log(`Search queries completed:  ${perQuery.length} / ${area.queries.length}`);
  console.log(`Total raw listings:        ${allRaw.length}`);
  console.log(`Duplicates removed:        ${removed}`);
  console.log(`Unique clinics:            ${unique.length}`);
  console.log(`Clinics WITH phone:        ${withPhone.length}`);
  console.log(`Clinics WITHOUT phone:     ${withoutPhone.length}`);
  console.log(`Unique phone numbers:      ${uniquePhones}`);
  if (failed.length) {
    console.log(`\nFailed/blocked searches:   ${failed.length}`);
    for (const f of failed) console.log(`  - ${f.q} :: ${f.error}`);
  } else {
    console.log(`Failed/blocked searches:   0`);
  }
  console.log(`\nCSV written to: ${outPath}`);
}

(async () => {
  if (!API_KEY) {
    console.error('❌ GOOGLE_PLACES_API_KEY is not set in the environment.');
    console.error('   Set it first, e.g.  export GOOGLE_PLACES_API_KEY="your-key"');
    process.exitCode = 1;
    return;
  }
  const args = process.argv.slice(2);
  if (args.includes('--verify')) {
    await verify();
    return;
  }
  const areaIdx = args.indexOf('--area');
  const areaKey = areaIdx >= 0 ? args[areaIdx + 1] : 'banjara';
  await run(areaKey);
})();
