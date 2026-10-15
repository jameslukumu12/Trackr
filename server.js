const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL, URLSearchParams } = require('url');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/api/gmail/callback`;
const GOOGLE_PUBSUB_TOPIC = process.env.GOOGLE_PUBSUB_TOPIC || '';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || '';

const sessions = new Map();
const oauthStates = new Map();

function initialData() {
  return {
    profile: { name: 'Kimberley', email: '', goal: 25 },
    applications: [
      { id: crypto.randomUUID(), company: 'Deloitte', role: 'Technology Graduate Programme', location: 'Dublin', salary: '€32k–€35k', stage: 'Interview', dateApplied: '2026-10-02', deadline: '2026-10-20', link: '', notes: 'Prepare examples for teamwork and problem solving.', source: 'Manual', updatedAt: new Date().toISOString() },
      { id: crypto.randomUUID(), company: 'EY', role: 'Technology Consulting Graduate', location: 'Dublin', salary: '', stage: 'Assessment', dateApplied: '2026-10-05', deadline: '2026-10-16', link: '', notes: 'Online assessment pending.', source: 'Email Sync', updatedAt: new Date().toISOString() },
      { id: crypto.randomUUID(), company: 'KPMG', role: 'Digital Transformation Graduate', location: 'Dublin', salary: '', stage: 'Applied', dateApplied: '2026-10-08', deadline: '', link: '', notes: '', source: 'Manual', updatedAt: new Date().toISOString() },
      { id: crypto.randomUUID(), company: 'Accenture', role: 'Analyst Graduate Programme', location: 'Dublin', salary: '', stage: 'Saved', dateApplied: '', deadline: '2026-10-25', link: '', notes: '', source: 'Manual', updatedAt: new Date().toISOString() }
    ],
    contacts: [
      { id: crypto.randomUUID(), name: 'Aoife Murphy', company: 'Deloitte', title: 'Graduate Recruiter', email: 'aoife@example.com', notes: 'Met at university careers fair.' }
    ],
    documents: [
      { id: crypto.randomUUID(), name: 'Technology CV', type: 'CV', version: 'v3', updated: '2026-10-10' },
      { id: crypto.randomUUID(), name: 'Consulting Cover Letter', type: 'Cover Letter', version: 'v2', updated: '2026-10-09' }
    ],
    interviews: [
      { id: crypto.randomUUID(), company: 'Deloitte', role: 'Technology Graduate Programme', date: '2026-10-18', time: '14:00', format: 'Teams', notes: 'Competency interview' }
    ],
    emailEvents: [],
    gmail: { connected: false, email: '', accessToken: '', refreshToken: '', tokenExpiry: 0, historyId: '', watchExpiration: 0, lastSync: null }
  };
}

function readData() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!d || !Array.isArray(d.applications) || !Array.isArray(d.emailEvents) || !d.gmail) {
      const fresh = initialData(); writeData(fresh); return fresh;
    }
    return d;
  } catch { const d = initialData(); writeData(d); return d; }
}
function writeData(data) { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function redirect(res, location) { res.writeHead(302, { Location: location }); res.end(); }
function body(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 2e6) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function safeData(data) {
  const clone = JSON.parse(JSON.stringify(data));
  if (clone.gmail) {
    clone.gmail.accessToken = '';
    clone.gmail.refreshToken = '';
  }
  return clone;
}

function normalizeStage(stage) {
  const allowed = ['Saved','Applying','Applied','Assessment','Interview','Final Stage','Offer','Rejected'];
  return allowed.includes(stage) ? stage : 'Applied';
}

function inferEmailUpdate({ subject='', from='', snippet='', body='' }) {
  const text = `${subject} ${snippet} ${body}`.toLowerCase();
  let stage = null, confidence = 0.55, reason = 'Application-related email detected';
  const rules = [
    { re: /(delighted|pleased|happy) to (offer|confirm)|job offer|offer of employment|we would like to offer/, stage:'Offer', conf:.96, reason:'Offer wording detected' },
    { re: /(unfortunately|regret to inform|not progressed|not moving forward|unsuccessful|other candidates)/, stage:'Rejected', conf:.94, reason:'Rejection wording detected' },
    { re: /(final interview|final stage|assessment centre|assessment center)/, stage:'Final Stage', conf:.90, reason:'Final-stage wording detected' },
    { re: /(invite|invitation).*(interview)|interview.*(invite|scheduled|booking)|meet (with|our) team/, stage:'Interview', conf:.92, reason:'Interview invitation detected' },
    { re: /(online assessment|psychometric|aptitude test|video assessment|game-based assessment|complete.*assessment)/, stage:'Assessment', conf:.90, reason:'Assessment request detected' },
    { re: /(thank you for applying|application received|received your application|application has been submitted|we have received)/, stage:'Applied', conf:.87, reason:'Application confirmation detected' }
  ];
  for (const r of rules) if (r.re.test(text)) { stage=r.stage; confidence=r.conf; reason=r.reason; break; }

  let company = '';
  const domain = (from.match(/@([\w.-]+)/) || [])[1];
  if (domain) company = domain.split('.')[0].replace(/[-_]/g,' ').replace(/\b\w/g, c=>c.toUpperCase());
  const subjCompany = subject.match(/(?:at|with|from)\s+([A-Z][A-Za-z0-9& .'-]{2,40})/);
  if (subjCompany) company = subjCompany[1].trim();

  const dateMatch = `${subject} ${snippet} ${body}`.match(/\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+\d{4})\b/i);
  return { stage, confidence, reason, company, extractedDate: dateMatch ? dateMatch[1] : '' };
}

function matchApplication(apps, company, subject='') {
  const c = company.toLowerCase();
  let best = null;
  for (const a of apps) {
    const score = (c && (a.company.toLowerCase().includes(c) || c.includes(a.company.toLowerCase()))) ? 2 : 0;
    const roleWords = a.role.toLowerCase().split(/\W+/).filter(w=>w.length>4);
    const hits = roleWords.filter(w=>subject.toLowerCase().includes(w)).length;
    if (score + hits > (best?.score || 0)) best = { app:a, score:score+hits };
  }
  return best && best.score>0 ? best.app : null;
}

function processEmail(data, email) {
  const inf = inferEmailUpdate(email);
  const event = {
    id: crypto.randomUUID(),
    subject: email.subject || '(no subject)',
    from: email.from || '',
    snippet: email.snippet || '',
    receivedAt: email.receivedAt || new Date().toISOString(),
    company: inf.company,
    suggestedStage: inf.stage,
    confidence: inf.confidence,
    reason: inf.reason,
    status: 'ignored',
    applicationId: null
  };
  if (!inf.stage) { data.emailEvents.unshift(event); return event; }
  let app = matchApplication(data.applications, inf.company, email.subject || '');
  if (!app && inf.company) {
    app = { id: crypto.randomUUID(), company: inf.company, role: email.subject || 'Graduate opportunity', location:'', salary:'', stage:'Applied', dateApplied:new Date().toISOString().slice(0,10), deadline:'', link:'', notes:'Created automatically from email.', source:'Email Sync', updatedAt:new Date().toISOString() };
    data.applications.push(app);
  }
  if (app) {
    event.applicationId = app.id;
    if (inf.confidence >= .88) {
      app.stage = normalizeStage(inf.stage);
      app.updatedAt = new Date().toISOString();
      app.source = 'Email Sync';
      if (inf.extractedDate && ['Assessment','Interview','Final Stage'].includes(inf.stage)) app.deadline = inf.extractedDate;
      event.status = 'applied';
    } else event.status = 'review';
  }
  data.emailEvents.unshift(event);
  data.emailEvents = data.emailEvents.slice(0,100);
  return event;
}

async function refreshAccessToken(data) {
  const g = data.gmail;
  if (g.accessToken && Date.now() < (g.tokenExpiry || 0) - 60000) return g.accessToken;
  if (!g.refreshToken || !GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) throw new Error('Gmail is not connected');
  const params = new URLSearchParams({ client_id:GOOGLE_CLIENT_ID, client_secret:GOOGLE_CLIENT_SECRET, refresh_token:g.refreshToken, grant_type:'refresh_token' });
  const r = await fetch('https://oauth2.googleapis.com/token', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:params });
  const tok = await r.json();
  if (!r.ok) throw new Error(tok.error_description || 'Token refresh failed');
  g.accessToken = tok.access_token;
  g.tokenExpiry = Date.now() + tok.expires_in*1000;
  writeData(data);
  return g.accessToken;
}

async function gmailApi(data, endpoint, options={}) {
  const token = await refreshAccessToken(data);
  const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${endpoint}`, { ...options, headers:{ ...(options.headers||{}), Authorization:`Bearer ${token}`, 'Content-Type':'application/json' } });
  const out = await r.json();
  if (!r.ok) throw new Error(out.error?.message || 'Gmail API error');
  return out;
}

function decodeBase64Url(s='') { try { return Buffer.from(s.replace(/-/g,'+').replace(/_/g,'/'),'base64').toString('utf8'); } catch { return ''; } }
function extractPayloadText(payload) {
  if (!payload) return '';
  if (payload.body?.data) return decodeBase64Url(payload.body.data);
  for (const p of payload.parts || []) {
    if (p.mimeType === 'text/plain' && p.body?.data) return decodeBase64Url(p.body.data);
  }
  for (const p of payload.parts || []) {
    const t = extractPayloadText(p); if (t) return t;
  }
  return '';
}
async function syncGmail(data, limit=25) {
  const list = await gmailApi(data, `messages?maxResults=${limit}&q=${encodeURIComponent('newer_than:30d')}`);
  let processed = 0;
  for (const m of (list.messages || []).reverse()) {
    const msg = await gmailApi(data, `messages/${m.id}?format=full`);
    if (data.emailEvents.some(e=>e.gmailMessageId===m.id)) continue;
    const headers = Object.fromEntries((msg.payload?.headers || []).map(h=>[h.name.toLowerCase(), h.value]));
    const email = { subject:headers.subject||'', from:headers.from||'', snippet:msg.snippet||'', body:extractPayloadText(msg.payload), receivedAt:new Date(Number(msg.internalDate)||Date.now()).toISOString() };
    const event = processEmail(data, email); event.gmailMessageId = m.id; processed++;
  }
  data.gmail.lastSync = new Date().toISOString();
  writeData(data);
  return processed;
}

function serveStatic(req,res,urlPath) {
  let filePath = urlPath === '/' ? path.join(PUBLIC_DIR,'index.html') : path.join(PUBLIC_DIR, decodeURIComponent(urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(filePath);
    const map = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
    res.writeHead(200, {'Content-Type':map[ext]||'application/octet-stream'}); fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req,res) => {
  const u = new URL(req.url, PUBLIC_BASE_URL);
  try {
    if (u.pathname === '/api/data' && req.method === 'GET') return json(res,200,safeData(readData()));
    if (u.pathname === '/api/applications' && req.method === 'POST') {
      const d=readData(), x=await body(req); x.id=crypto.randomUUID(); x.stage=normalizeStage(x.stage||'Saved'); x.updatedAt=new Date().toISOString(); x.source='Manual'; d.applications.push(x); writeData(d); return json(res,201,x);
    }
    if (u.pathname.startsWith('/api/applications/') && req.method === 'PATCH') {
      const d=readData(), id=u.pathname.split('/').pop(), x=await body(req), a=d.applications.find(v=>v.id===id); if(!a)return json(res,404,{error:'Not found'}); Object.assign(a,x,{updatedAt:new Date().toISOString()}); if(x.stage)a.stage=normalizeStage(x.stage); writeData(d); return json(res,200,a);
    }
    if (u.pathname.startsWith('/api/applications/') && req.method === 'DELETE') {
      const d=readData(), id=u.pathname.split('/').pop(); d.applications=d.applications.filter(v=>v.id!==id); writeData(d); return json(res,200,{ok:true});
    }
    if (u.pathname === '/api/demo-email' && req.method === 'POST') {
      const d=readData(), x=await body(req), ev=processEmail(d,x); writeData(d); return json(res,200,ev);
    }
    if (u.pathname === '/api/email-events/review' && req.method === 'POST') {
      const d=readData(), x=await body(req), ev=d.emailEvents.find(e=>e.id===x.eventId); if(!ev)return json(res,404,{error:'Event not found'}); const app=d.applications.find(a=>a.id===ev.applicationId); if(x.action==='approve'&&app&&ev.suggestedStage){app.stage=ev.suggestedStage;app.updatedAt=new Date().toISOString();app.source='Email Sync';ev.status='applied';} else ev.status='ignored'; writeData(d); return json(res,200,{ok:true});
    }
    if (u.pathname === '/api/gmail/status' && req.method === 'GET') { const d=readData(); return json(res,200,{connected:d.gmail.connected,email:d.gmail.email,lastSync:d.gmail.lastSync,configured:!!(GOOGLE_CLIENT_ID&&GOOGLE_CLIENT_SECRET)}); }
    if (u.pathname === '/api/gmail/connect' && req.method === 'GET') {
      if(!GOOGLE_CLIENT_ID||!GOOGLE_CLIENT_SECRET) return json(res,400,{error:'Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to your environment first.'});
      const state=crypto.randomBytes(24).toString('hex'); oauthStates.set(state,Date.now());
      const q=new URLSearchParams({client_id:GOOGLE_CLIENT_ID,redirect_uri:GOOGLE_REDIRECT_URI,response_type:'code',scope:'openid email https://www.googleapis.com/auth/gmail.readonly',access_type:'offline',prompt:'consent',state});
      return redirect(res,`https://accounts.google.com/o/oauth2/v2/auth?${q}`);
    }
    if (u.pathname === '/api/gmail/callback' && req.method === 'GET') {
      const state=u.searchParams.get('state'), code=u.searchParams.get('code'); if(!state||!oauthStates.has(state)||!code){res.writeHead(400);return res.end('Invalid OAuth state');} oauthStates.delete(state);
      const params=new URLSearchParams({code,client_id:GOOGLE_CLIENT_ID,client_secret:GOOGLE_CLIENT_SECRET,redirect_uri:GOOGLE_REDIRECT_URI,grant_type:'authorization_code'});
      const tr=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:params}); const tok=await tr.json(); if(!tr.ok)throw new Error(tok.error_description||'OAuth failed');
      const pr=await fetch('https://www.googleapis.com/oauth2/v2/userinfo',{headers:{Authorization:`Bearer ${tok.access_token}`}}); const profile=await pr.json();
      const d=readData(); d.gmail={...d.gmail,connected:true,email:profile.email||'',accessToken:tok.access_token,refreshToken:tok.refresh_token||d.gmail.refreshToken,tokenExpiry:Date.now()+tok.expires_in*1000}; writeData(d);
      if(GOOGLE_PUBSUB_TOPIC){ try { const w=await gmailApi(d,'watch',{method:'POST',body:JSON.stringify({topicName:GOOGLE_PUBSUB_TOPIC,labelIds:['INBOX']})}); d.gmail.historyId=w.historyId||''; d.gmail.watchExpiration=Number(w.expiration)||0; writeData(d); } catch(e){ console.error('Watch setup failed:',e.message); } }
      return redirect(res,'/?gmail=connected');
    }
    if (u.pathname === '/api/gmail/sync' && req.method === 'POST') { const d=readData(); if(!d.gmail.connected)return json(res,400,{error:'Connect Gmail first'}); const count=await syncGmail(d); return json(res,200,{ok:true,processed:count}); }
    if (u.pathname === '/api/gmail/disconnect' && req.method === 'POST') { const d=readData(); d.gmail={connected:false,email:'',accessToken:'',refreshToken:'',tokenExpiry:0,historyId:'',watchExpiration:0,lastSync:null}; writeData(d); return json(res,200,{ok:true}); }
    if (u.pathname === '/api/gmail/push' && req.method === 'POST') {
      if(WEBHOOK_TOKEN && u.searchParams.get('token')!==WEBHOOK_TOKEN) return json(res,403,{error:'Forbidden'});
      const payload=await body(req); let decoded={}; try{decoded=JSON.parse(Buffer.from(payload.message?.data||'','base64').toString('utf8'));}catch{}
      const d=readData(); if(d.gmail.connected){ syncGmail(d,15).catch(e=>console.error('Push sync failed:',e.message)); }
      return json(res,200,{ok:true,received:decoded});
    }
    if (u.pathname.startsWith('/api/')) return json(res,404,{error:'Not found'});
    return serveStatic(req,res,u.pathname);
  } catch(e) { console.error(e); return json(res,500,{error:e.message||'Server error'}); }
});
server.listen(PORT,()=>console.log(`Trackr running at http://localhost:${PORT}`));
