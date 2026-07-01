export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { sheetId, sheetName } = req.body;
    if (!sheetId || !sheetName) return res.status(400).json({ error: 'Missing sheetId or sheetName' });

    const email = process.env.GOOGLE_SERVICE_EMAIL;
    const rawKey = process.env.GOOGLE_PRIVATE_KEY;
    if (!email || !rawKey) return res.status(500).json({ error: 'Server not configured.' });

    const privateKey = rawKey.replace(/\\n/g, '\n');
    const token = await getAccessToken(email, privateKey);

    // Fetch with UNFORMATTED_VALUE to get raw numbers (including date serials)
    // and separately fetch FORMATTED_VALUE for text/string cells
    const [rawData, fmtData] = await Promise.all([
      fetchSheet(token, sheetId, sheetName, 'UNFORMATTED_VALUE'),
      fetchSheet(token, sheetId, sheetName, 'FORMATTED_VALUE'),
    ]);

    // Merge: use FORMATTED_VALUE by default, but detect date serials and convert
    const merged = mergeAndNormalizeDates(rawData, fmtData);

    res.status(200).json({ data: merged });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}

// Convert Excel/Google Sheets serial number to YYYY-MM-DD
function serialToISO(serial) {
  if (typeof serial !== 'number') return null;
  // Serial 25569 = 1970-01-01 (Unix epoch)
  // Serials in range 40000-70000 are dates 2009-2091
  if (serial < 40000 || serial > 70000) return null;
  const d = new Date((serial - 25569) * 86400 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Convert Chinese date string to YYYY-MM-DD
function cnDateToISO(s) {
  const m = s.match(/(\d{4})年(\d+)月(\d+)/);
  if (!m) return null;
  return `${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`;
}

// Convert DD/MM/YYYY to YYYY-MM-DD
function dmyToISO(s) {
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${String(m[2]).padStart(2,'0')}-${String(m[1]).padStart(2,'0')}`;
}

function normalizeDate(rawVal, fmtVal) {
  // Priority 1: raw value is a number → Excel date serial
  if (typeof rawVal === 'number') {
    const iso = serialToISO(rawVal);
    if (iso) return iso;
  }
  // Priority 2: formatted value is Chinese date
  if (typeof fmtVal === 'string' && fmtVal.includes('年')) {
    const iso = cnDateToISO(fmtVal);
    if (iso) return iso;
  }
  // Priority 3: formatted value is DD/MM/YYYY
  if (typeof fmtVal === 'string') {
    const iso = dmyToISO(fmtVal);
    if (iso) return iso;
  }
  // Priority 4: return formatted value as-is (text cells)
  return fmtVal !== undefined ? String(fmtVal) : '';
}

function mergeAndNormalizeDates(rawValues, fmtValues) {
  if (!rawValues || rawValues.length < 1) return [];
  const rows = rawValues.length;
  const cols = Math.max(...rawValues.map(r => r.length), ...fmtValues.map(r => r.length));

  const merged = [];
  for (let i = 0; i < rows; i++) {
    const rawRow = rawValues[i] || [];
    const fmtRow = fmtValues[i] || [];
    const mergedRow = [];
    for (let j = 0; j < Math.max(rawRow.length, fmtRow.length); j++) {
      const rawVal = rawRow[j];
      const fmtVal = fmtRow[j];
      mergedRow.push(normalizeDate(rawVal, fmtVal));
    }
    merged.push(mergedRow);
  }
  return merged;
}

async function getAccessToken(email, privateKey) {
  const crypto = await import('crypto');
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  })).toString('base64url');
  const unsigned = `${header}.${payload}`;
  const sign = crypto.default.createSign('RSA-SHA256');
  sign.update(unsigned);
  const sig = sign.sign(privateKey, 'base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const jwt = `${unsigned}.${sig}`;
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });
  const data = await tokenRes.json();
  if (!data.access_token) throw new Error('Auth failed: ' + JSON.stringify(data));
  return data.access_token;
}

async function fetchSheet(token, sheetId, sheetName, renderOption) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(sheetName)}?valueRenderOption=${renderOption}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Sheets API ${res.status}: ${body}`);
  }
  const json = await res.json();
  return json.values || [];
}
