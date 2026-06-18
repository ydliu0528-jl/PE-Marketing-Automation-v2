// api/sheets.js - Vercel Serverless Function
// Handles Google Sheets auth server-side so private key is never exposed

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { sheetId, sheetName } = req.body;
    if (!sheetId || !sheetName) return res.status(400).json({ error: 'Missing sheetId or sheetName' });

    // Read from Vercel environment variables (set in Vercel dashboard)
    const email = process.env.GOOGLE_SERVICE_EMAIL;
    const rawKey = process.env.GOOGLE_PRIVATE_KEY;
    if (!email || !rawKey) return res.status(500).json({ error: 'Server not configured. Add GOOGLE_SERVICE_EMAIL and GOOGLE_PRIVATE_KEY to Vercel environment variables.' });

    // Vercel stores \n as literal \n in env vars - fix that
    const privateKey = rawKey.replace(/\\n/g, '\n');

    const token = await getAccessToken(email, privateKey);
    const data = await fetchSheetData(token, sheetId, sheetName);
    res.status(200).json({ data });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}

async function getAccessToken(email, privateKey) {
  const { SignJWT, importPKCS8 } = await import('jose');
  const key = await importPKCS8(privateKey, 'RS256');
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt()
    .setIssuer(email)
    .setAudience('https://oauth2.googleapis.com/token')
    .setExpirationTime('1h')
    .setSubject(email)
    .sign(key);

  // Add scope to payload
  const parts = jwt.split('.');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  payload.scope = 'https://www.googleapis.com/auth/spreadsheets.readonly';
  const newPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const unsigned = parts[0] + '.' + newPayload;

  const crypto = await import('crypto');
  const sign = crypto.default.createSign('RSA-SHA256');
  sign.update(unsigned);
  const sig = sign.sign(privateKey, 'base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const finalJwt = unsigned + '.' + sig;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${finalJwt}`
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error('Google auth failed: ' + JSON.stringify(tokenData));
  return tokenData.access_token;
}

async function fetchSheetData(token, sheetId, sheetName) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(sheetName)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Sheets API error: ${res.status}`);
  const json = await res.json();
  return json.values || [];
}
