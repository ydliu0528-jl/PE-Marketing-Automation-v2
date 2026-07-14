export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { sheetId, sheetName } = req.body;
    if (!sheetId || !sheetName) return res.status(400).json({ error: 'Missing params' });

    const email = process.env.GOOGLE_SERVICE_EMAIL;
    const rawKey = process.env.GOOGLE_PRIVATE_KEY;
    if (!email || !rawKey) return res.status(500).json({ error: 'Not configured' });

    const privateKey = rawKey.replace(/\\n/g, '\n');
    const token = await getAccessToken(email, privateKey);
    const data = await fetchSheet(token, sheetId, sheetName);
    res.status(200).json({ data });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}

async function fetchSheet(token, sheetId, sheetName) {
  // Use FORMATTED_VALUE - dates return as display strings
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(sheetName)}?valueRenderOption=FORMATTED_VALUE`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Sheets API ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.values || [];
}

async function getAccessToken(email, privateKey) {
  const crypto = await import('crypto');
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600, iat: now,
  })).toString('base64url');
  const unsigned = `${header}.${payload}`;
  const sign = crypto.default.createSign('RSA-SHA256');
  sign.update(unsigned);
  const sig = sign.sign(privateKey, 'base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const jwt = `${unsigned}.${sig}`;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('Auth failed: ' + JSON.stringify(d));
  return d.access_token;
}
