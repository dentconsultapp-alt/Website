# DentConsult — Dental Clinic Collector (Google Places API New)

Collects publicly listed dental clinics for a target area (currently **Banjara
Hills, Hyderabad only**) using the official **Google Places API (New)**,
deduplicates, normalizes Indian phone numbers, and writes a CSV.

- No dependencies — uses Node 22+ built-in `fetch`.
- The API key is read **only** from the `GOOGLE_PLACES_API_KEY` environment
  variable. It is never printed, logged, or written to a file.

## 1. Create the API key (one time)

1. Go to <https://console.cloud.google.com/> and sign in.
2. Top bar → **Select a project** → **New Project** (name it e.g. `dentconsult-maps`) → **Create**.
3. Left menu → **APIs & Services → Library**. Search **“Places API (New)”** → open it → **Enable**.
4. Left menu → **APIs & Services → Credentials** → **+ Create Credentials → API key**.
5. Copy the key. (Recommended: click **Edit** on the key → under **API restrictions**
   choose **Restrict key → Places API (New)** so the key can only call this one API.)
6. Billing: Google requires a billing account enabled, but Places includes a large
   monthly free allowance — this Banjara Hills run stays well within it.

## 2. Add the key securely to your local environment

**Do not paste the key into chat and do not put it in any file that gets committed.**

macOS / Linux (current terminal only — nothing written to disk):
```bash
export GOOGLE_PLACES_API_KEY="paste-your-key-here"
```

Windows PowerShell:
```powershell
$env:GOOGLE_PLACES_API_KEY = "paste-your-key-here"
```

(If you want it to persist, add the `export ...` line to your `~/.zshrc` /
`~/.bashrc` — that file is outside this repo and is not committed.)

## 3. Verify the key works
```bash
node collect.mjs --verify
```
Expect: `✅ API key works.`

## 4. Run the Banjara Hills collection
```bash
node collect.mjs --area banjara
```
Output: `dentconsult_banjara_hills_dental_clinics.csv` in this folder, plus a
printed summary (raw listings, duplicates removed, unique clinics, with/without
phone, unique phone numbers, queries completed, any failed searches).

## Notes
- CSV columns: `Clinic Name | Phone Number | Address | Area | Website | Google Maps Link | Rating | Reviews`
- Dedup order: **Place ID → normalized phone (+ same name) → name + address.**
  Distinct branches (different address) are preserved.
- Text Search (New) returns up to ~60 results per query; all pages are fetched.
- Other Hyderabad regions are intentionally **not** enabled yet.
