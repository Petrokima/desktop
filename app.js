// @ts-check — checked by TypeScript (tsconfig.json); keep it free of type errors
// ═════════════════════════════════════════════════════════
//  ERROR REPORTING (30 Oct 2026) — keep IDENTICAL in desktop/src/part0err.js and mobile/index.html (checked automatically)
//  Unexpected errors on staff PCs and phones are reported to Sentry (EU), the standard error-monitoring service, through
//  our Supabase function error-report (it adds the real Sentry address; until Mohammed sets it, reports are dropped).
//  No personal data: no names, no e-mails, no ID numbers, no typed text, no page content; web addresses without their
//  query part; the login is sent only as its internal number (UUID) and role. Off when the library is missing (on-prem copy).
// ═════════════════════════════════════════════════════════
const PK_ERR = (function(){
  const lib = window.Sentry, off = { user(){}, capture(){} };
  if (!lib || typeof lib.init !== 'function' || !/^https:$/.test(location.protocol) && location.hostname !== 'localhost') return off;
  const scrub = s => typeof s !== 'string' ? s : s
    .replace(/\b[23]\d{13}\b/g, '[id]').replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g, '[token]').replace(/sb_(publishable|secret)_[\w-]+/g, '[key]');
  const bare = u => { try { const x = new URL(u, location.href); return x.origin + x.pathname; } catch(e){ return ''; } };
  try {
    lib.init({
      dsn: 'https://public@o0.ingest.sentry.io/0',                       // placeholder — the real address is added by error-report
      tunnel: 'https://hckkrzghxxhauotyqlqr.supabase.co/functions/v1/error-report',
      release: typeof APP_BUILD !== 'undefined' ? 'pk-phone@' + (APP_BUILD ? 'android-' + APP_BUILD : 'web') : 'pk-desktop@web',
      environment: location.hostname === 'localhost' ? 'android-app' : location.hostname,
      sendDefaultPii: false, maxBreadcrumbs: 30, attachStacktrace: true,
      beforeBreadcrumb(b){
        if (b.category === 'console' || b.category === 'ui.input') return null;          // never what people type or logs
        if (b.data){ if (b.data.url) b.data.url = bare(b.data.url); if (b.data.from) b.data.from = bare(b.data.from); if (b.data.to) b.data.to = bare(b.data.to); }
        if (b.message) b.message = scrub(b.message);
        return b;
      },
      beforeSend(e){
        if (e.request){ e.request = { url: bare(e.request.url || '') }; }
        if (e.message) e.message = scrub(e.message);
        (e.exception && e.exception.values || []).forEach(v => { v.value = scrub(v.value); });
        if (e.user) e.user = { id: e.user.id };
        delete e.extra;
        return e;
      }
    });
  } catch(e){ return off; }
  // a page part blocked by the browser security policy is reported too (once per kind), so a blocked feature is noticed at once
  const seenCsp = new Set();
  document.addEventListener('securitypolicyviolation', ev => {
    const k = ev.violatedDirective + ' ' + bare(ev.blockedURI || 'inline'); if (seenCsp.has(k) || seenCsp.size > 20) return; seenCsp.add(k);
    try { lib.withScope(s => { s.setTag('where', 'security-policy'); s.setLevel('warning'); lib.captureMessage('Blocked by the security policy: ' + k); }); } catch(e){}
  });
  return {
    user(u){ try { lib.setUser(u && u.id ? { id: u.id } : null); lib.setTag('role', (u && u.role) || 'none'); } catch(e){} },
    capture(err, where){ try { lib.withScope(s => { if (where) s.setTag('where', String(where)); lib.captureException(err); }); } catch(e){} }
  };
})();

// @ts-check — checked by TypeScript (tsconfig.json); keep it free of type errors
// ═════════════════════════════════════════════════════════
//  STATE
// ═════════════════════════════════════════════════════════
let sb = null;
/** The data loaded for the current payroll cycle — rows straight from the database (types: types/globals.d.ts).
 * @type {{ employees: Employee[], projects: Project[], attendance: AttendanceRow[], elements: SalaryElement[], fixed: FixedElement[],
 *          monthly: MonthlyEntry[], loans: Loan[], permissions: Permission[], leaves: Leave[], penalties: Penalty[], holidays: Holiday[],
 *          hrreq: HrRequest[], runs: PayrollRun[], runLines: PayrollRunLine[], clocks: ClockEvent[], devices: EmployeeDevice[],
 *          parRules: AllowanceRule[], allowAppr: AllowanceApproval[], phoneAlerts: PhoneAlert[], empProjects: EmployeeProject[],
 *          missions: Mission[], [more: string]: any }} */
const S = { employees:[], projects:[], attendance:[], elements:[], fixed:[], monthly:[], loans:[], permissions:[], leaves:[], penalties:[], holidays:[], hrreq:[], runs:[], runLines:[], clocks:[], devices:[], parRules:[], allowAppr:[], phoneAlerts:[], empProjects:[], missions:[] };
let permTableMissing = false, leaveTableMissing = false, penTableMissing = false, holTableMissing = false, hrTableMissing = false, runsTableMissing = false, parTableMissing = false, apprTableMissing = false, assignTableMissing = false;
let holidaySet = new Set();
const DEFAULTS = {
  companyName:'Petrokima Engineering & Contracting S.A.E.', period:'',
  hoursPerDay:8, daysPerMonth:30, otMultiplier:1.5,
  cycleStartDay:21, shiftStart:'08:00', lateAfter:'09:00', eveningShiftAfter:'14:00', otThreshold:1, otMode:'threshold', permissionsPerMonth:2, permissionMaxHours:2,
  autoAbsentFrom:'', weekendDays:[5,6], annualLeaveDefault:21, casualCountsAnnual:'yes', noProjectMode:'everyone', requestFlow:'hr', permDeadlineMin:30, annualNoticeDays:1, acctMinEmployees:3, codeUnpaid:40, codeProjAllow:12, codeAbsent:41, codeHoliday:42, holidayExtraDays:1,
  siRateEG:11, siRateSA:10,
  codeOT:5, codeSI:15, codeLoan:6, codeDelay:4, codePenalty:2
};
let settings = { ...DEFAULTS };
let attDayFilter = null;   // null = whole range
let ATT_RANGE = null;      // null = the current payroll cycle; otherwise { from, to, rows, clocks } loaded for viewing past attendance
const attRows   = () => ATT_RANGE ? ATT_RANGE.rows   : S.attendance;
const attClocks = () => ATT_RANGE ? ATT_RANGE.clocks : S.clocks;
// manager step on vacation / permission requests
const waitingManager = r => r.status==='Pending' && r.manager_status==='Pending';
const readyForHR     = r => r.status==='Pending' && r.manager_status!=='Pending';
const fmtSent = ts => ts ? new Date(ts).toLocaleString('en-GB', { weekday:'short', day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' }) : '';
// readable message for the request deadlines enforced by the database
function deadlineMsg(m){ m = String(m||'');
  if (/LATE_REQUEST/.test(m)) return 'Too late: ' + m.replace(/^.*LATE_REQUEST:\s*/, '');
  if (/ADVANCE_NOTICE/.test(m)) return m.replace(/^.*ADVANCE_NOTICE:\s*/, '') + ' — for today, choose Casual (emergency) leave.';
  if (/PAST_DATE/.test(m)) return m.replace(/^.*PAST_DATE:\s*/, '');
  return m; }
function mgrStep(r){
  const sent = (r.source==='Self-service' || r.source==='Mobile') ? `<div style="font-size:11px;color:var(--muted)">🕒 sent ${esc(fmtSent(r.created_at || r.requested_at))}</div>` : '';
  return sent + mgrStage(r); }
function mgrStage(r){
  if (!r.manager_status) return r.status==='Pending' && (r.source==='Self-service' || r.source==='Mobile') ? '<div style="font-size:11px;color:var(--warn)">no direct manager — HR decides</div>' : '';
  const m = empName(empById(r.manager_id)) || r.manager_by || r.manager_id;
  if (r.manager_status==='Pending') return `<div style="font-size:11px;color:var(--warn)">⏳ waiting for manager: ${esc(m)}</div>`;
  if (r.manager_status==='Approved') return `<div style="font-size:11px;color:var(--accent2)">✓ manager ${esc(r.manager_by||m)} approved${r.manager_note?` — “${esc(r.manager_note)}”`:''}</div>`;
  return `<div style="font-size:11px;color:var(--danger)">✕ manager ${esc(r.manager_by||m)} rejected${r.manager_note?` — “${esc(r.manager_note)}”`:''}</div>`;
}
let monLines = {};          // emp_id -> [{project:'code — name', amount:'…'}] for the selected element
let monDirty = new Set();   // emp_ids with unsaved changes
let monEl = null;           // element code monLines was built for

// ═════════════════════════════════════════════════════════
//  HELPERS
// ═════════════════════════════════════════════════════════
/** @type {(id: string) => any} element by id (typed loosely on purpose: forms, buttons, inputs …) */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
const fmt = v => num(v).toLocaleString('en-US', { minimumFractionDigits:0, maximumFractionDigits:2 });
const pad = n => String(n).padStart(2,'0');
function todayStr(){ const d=new Date(); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
function thisMonth(){ const d=new Date(); return `${d.getFullYear()}-${pad(d.getMonth()+1)}`; }
// Payroll cycle: period 'YYYY-MM' runs from day <cycleStartDay> of the previous month to the day before it in this month.
// cycleStartDay 21 → September = 21 Aug … 20 Sep.  cycleStartDay 1 → calendar month.
function cycleDay(){ const d = Math.round(num(settings.cycleStartDay)); return (d>=2 && d<=28) ? d : 1; }
function periodStart(p){ const sd=cycleDay(), [y,m]=p.split('-').map(Number);
  if (sd===1) return `${p}-01`; const d=new Date(y, m-2, sd); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(sd)}`; }
function periodEnd(p){ const sd=cycleDay(), [y,m]=p.split('-').map(Number);
  return sd===1 ? `${p}-${pad(new Date(y,m,0).getDate())}` : `${p}-${pad(sd-1)}`; }
function cycleOf(date){ if(!date) return ''; const sd=cycleDay(), [y,m,d]=String(date).split('-').map(Number);
  if (sd===1 || d < sd) return `${y}-${pad(m)}`; const n=new Date(y, m, 1); return `${n.getFullYear()}-${pad(n.getMonth()+1)}`; }
function periodLabel(p){ const f=s=>{ const [y,m,d]=s.split('-').map(Number); return `${d} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m-1]}`; };
  return `${p} (${f(periodStart(p))} → ${f(periodEnd(p))})`; }
function daysBetweenIncl(a,b){ const [y1,m1,d1]=a.split('-').map(Number), [y2,m2,d2]=b.split('-').map(Number);
  return Math.round((new Date(y2,m2-1,d2).getTime() - new Date(y1,m1-1,d1).getTime())/86400000) + 1; }
// Who is on this period's payroll: employed at any point in the cycle (includes leavers who resigned inside it)
function onPayroll(e, p){
  const s=periodStart(p), en=periodEnd(p);
  if (e.employment_date && e.employment_date > en) return false;
  if (e.resignation_date) return e.resignation_date >= s;
  return e.status !== 'Inactive';
}
// Days employed in the cycle and the pay factor on a 30-day basis (full cycle = 1)
function employment(e, p){
  const s=periodStart(p), en=periodEnd(p);
  const from = (e.employment_date && e.employment_date > s) ? e.employment_date : s;
  const to   = (e.resignation_date && e.resignation_date < en) ? e.resignation_date : en;
  if (to < from) return { days:0, len:daysBetweenIncl(s,en), factor:0, partial:true, from, to };
  if (from===s && to===en) return { days:daysBetweenIncl(s,en), len:daysBetweenIncl(s,en), factor:1, partial:false, from, to };
  // 85: a cycle has 28–31 days; pay is reduced by the days NOT employed on a 30-day basis (1 − missing ÷ 30).
  // MUST match payroll_calc (file 85).
  const days = daysBetweenIncl(from, to), base = num(settings.daysPerMonth) || 30, len = daysBetweenIncl(s, en);
  return { days, len, factor: Math.max(0, Math.min(1, 1 - (len - days)/base)), partial:true, from, to,
           joiner: from!==s, leaver: to!==en };
}
function periodIdx(p){ const [y,m]=String(p).split('-').map(Number); return y*12+(m-1); }
function empName(e){ return e ? (e.name_en || e.name_ar || e.id) : ''; }
function lib(){ const l = window.supabase; return (l && typeof l.createClient === 'function') ? l : null; }
function chip(s){
  const m={Active:'c-green',Present:'c-green',Verified:'c-green',Insured:'c-green',Permanent:'c-blue',Temporary:'c-orange',Contract:'c-grey',
           Pending:'c-orange',Approved:'c-green',Rejected:'c-red',Cancelled:'c-grey',Completed:'c-green','In progress':'c-blue','Waiting for manager':'c-orange','Waiting for HR':'c-blue','Half Day':'c-orange','Annual Leave':'c-orange','Sick Leave':'c-orange',Inactive:'c-grey',Absent:'c-red',Holiday:'c-blue','Non insured':'c-grey',Settled:'c-grey',Suspended:'c-orange'};
  return s ? `<span class="chip ${m[s]||'c-grey'}">${esc(s)}</span>` : '';
}
const NOPERM = "Your role doesn't allow this change";
function toast(msg, type='ok'){
  msg = String(msg);
  if (/row-level security|permission denied/i.test(msg)) msg = NOPERM;
  const t=$('toast'), c={ok:['var(--accent2)','#0f1117'],warn:['var(--warn)','#fff'],err:['var(--danger)','#fff']}[type]||['var(--accent2)','#0f1117'];
  t.style.background=c[0]; t.style.color=c[1]; t.textContent=msg; t.style.transform='translateY(0)'; t.style.opacity='1';
  clearTimeout(t._h); t._h=setTimeout(()=>{ t.style.transform='translateY(90px)'; t.style.opacity='0'; }, 3800);
}
function loader(on, msg){ $('loader').style.display = on ? 'flex' : 'none'; if(msg) $('loader-msg').textContent = msg; }
function openM(id){ $(id).classList.add('open'); }
function closeM(id){ $(id).classList.remove('open'); }
/** @returns {Employee | undefined} */
function empById(id){ return S.employees.find(e => String(e.id) === String(id)); }
/** the employee, or an empty record when the code is unknown (never undefined) @returns {Employee} */
function empOrBlank(id){ return empById(id) || /** @type {Employee} */ ({}); }
/** @returns {SalaryElement | undefined} */
function elByCode(c){ return S.elements.find(e => Number(e.code) === Number(c)); }
/** the salary element, or an empty one when the code is unknown @returns {SalaryElement} */
function elOrBlank(c){ return elByCode(c) || /** @type {SalaryElement} */ ({}); }
function parseEmpInput(v){ const id = String(v||'').split(' — ')[0].trim(); return empById(id) ? id : null; }
function parseProjInput(v){ const id = String(v||'').split(' — ')[0].trim(); return S.projects.find(p=>String(p.id)===id) ? id : null; }

// Fetch every row of a table in batches of 1000 (Supabase's per-request cap)
// Tables with a unique "id" get it as a second sort key, so batches of 1,000 never overlap or skip rows
const TIEBREAK = new Set(['attendance','payroll_period_elements','attendance_permissions','employee_leaves','employee_penalties',
                          'employee_salary_elements','employee_loans','hr_requests','clock_events']);
async function fetchAll(table, orderCol, filterFn){
  const size = 1000;
  const page = (from, withCount) => {
    let q = withCount ? sb.from(table).select('*', { count:'exact' }) : sb.from(table).select('*');
    if (filterFn) q = filterFn(q);
    if (orderCol) q = q.order(orderCol, { ascending:true });
    if (TIEBREAK.has(table) && orderCol !== 'id') q = q.order('id', { ascending:true });
    return q.range(from, from + size - 1);
  };
  const first = await page(0, true);
  if (first.error) throw new Error(`${table}: ${first.error.message}`);
  let out = first.data || [];
  if (out.length < size) return out;
  if (typeof first.count === 'number'){
    // we know how many rows there are: fetch the remaining batches 4 at a time instead of one by one
    const froms = []; for (let f = size; f < first.count; f += size) froms.push(f);
    const parts = new Array(froms.length); let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, froms.length) }, async () => {
      while (next < froms.length){ const k = next++; const r = await page(froms[k]);
        if (r.error) throw new Error(`${table}: ${r.error.message}`); parts[k] = r.data || []; }
    }));
    return out.concat(...parts);
  }
  for (let from = size; ; from += size){                        // row count unknown: one batch at a time
    const r = await page(from); if (r.error) throw new Error(`${table}: ${r.error.message}`);
    out = out.concat(r.data || []); if (!r.data || r.data.length < size) break;
  }
  return out;
}
async function chunked(rows, fn, size=500){ for(let i=0;i<rows.length;i+=size){ const r = await fn(rows.slice(i,i+size)); if (r && r.error) throw r.error; } }

// ═════════════════════════════════════════════════════════
//  CONNECTION
// ═════════════════════════════════════════════════════════
async function connectFromForm(){
  const err=$('setup-err'), show=m=>{ err.innerHTML=m; err.style.display='block'; };
  err.style.display='none';
  const url=$('cfg-url').value.trim().replace(/\/+$/,''), key=$('cfg-key').value.trim();
  if(!lib()) return show('The app could not load. Check your internet connection and reload.');
  if(!url||!key) return show('Both fields are required.');
  // cloud (https://xxxx.supabase.co) or our own server in an emergency (http://192.168.1.20:8000)
  if(!/^https?:\/\/[a-z0-9.-]+(:\d{2,5})?$/i.test(url)) return show('URL should look like <b>https://xxxxxxxx.supabase.co</b> or, for our own server, <b>http://192.168.1.20:8000</b>');
  const btn=$('btn-connect'); btn.disabled=true; btn.textContent='Connecting…';
  try{
    const c = lib().createClient(url,key);
    const { error } = await c.from('employees').select('id').limit(1);
    if(error) throw error;
    localStorage.setItem('sb_url',url); localStorage.setItem('sb_key',key);
    await startApp(url,key);
  }catch(e){ show('Connection failed: '+esc(e.message||e)); }
  btn.disabled=false; btn.textContent='Connect & Launch';
}

let ME = null;
const ROLE_LABEL = { admin:'Admin', hr:'HR', hr_officer:'HR Officer', employee:'Employee' };
const PAY_FIELDS = ['salary','housing','transport','daily_pay','hour_pay','delay_hour_pay','insurance_amount'];
const isOfficer = () => !!(ME && ME.role === 'hr_officer');
async function startApp(url,key){
  sb = lib().createClient(url,key);
  $('setup').style.display='none';
  $('s-db').textContent = 'Connected to ' + url.replace(/^https?:\/\//,'');
  const { data } = await sb.auth.getSession();
  if (data && data.session) await afterLogin(data.session.user); else showLogin();
}
function showLogin(msg){
  $('app').style.display='none'; $('login').style.display='flex';
  $('login-form').style.display='block'; $('login-noaccess').style.display='none';
  const e=$('login-err'); if(msg){ e.innerHTML=msg; e.style.display='block'; } else e.style.display='none';
  setTimeout(()=>$('li-email').focus(),50);
}
// ── CAPTCHA on every password sign-in (Cloudflare Turnstile, 25 Oct 2026) ──
//  TURNSTILE_SITE_KEY = the PUBLIC site key of the widget "Petrokima HR sign-in". Empty = no CAPTCHA (nothing is shown, nothing sent).
//  Supabase checks the token only once "CAPTCHA protection" is switched on (Authentication → Attack Protection); before that it is ignored.
//  Each token is good for one sign-in: a fresh one is taken for every attempt. Usually nothing is shown; Cloudflare shows a small box
//  to tick only when it is not sure the person is human.
const TURNSTILE_SITE_KEY = '0x4AAAAAAFkp9jltaXJo9weC';   // widget "Petrokima HR sign-in" (public key)
let tsLoad = null;
function loadTurnstile(){
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (tsLoad) return tsLoad;
  tsLoad = new Promise((res, rej) => {
    const s = document.createElement('script'); s.async = true;
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.onload = () => window.turnstile ? res(window.turnstile) : rej(new Error('captcha-load'));
    s.onerror = () => { tsLoad = null; rej(new Error('captcha-load')); };
    document.head.appendChild(s);
    setTimeout(() => { if (!window.turnstile) { tsLoad = null; rej(new Error('captcha-load-timeout')); } }, 15000);   // never wait for ever
  });
  return tsLoad;
}
async function captchaToken(boxId, lang){
  if (!TURNSTILE_SITE_KEY) return undefined;
  const box = document.getElementById(boxId); if (!box) return undefined;
  const ts = await loadTurnstile();
  return new Promise((resolve, reject) => {
    let id = null, done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); setTimeout(() => { try { ts.remove(id); } catch(e){} box.style.display = 'none'; }, 0); fn(v); };
    const timer = setTimeout(() => finish(reject, new Error('captcha-timeout')), 90000);
    box.innerHTML = ''; box.style.display = 'block';
    id = ts.render(box, { sitekey: TURNSTILE_SITE_KEY, action: 'signin', appearance: 'interaction-only', language: lang || 'auto',
      callback: tok => finish(resolve, tok),
      'error-callback': code => { finish(reject, new Error('captcha-failed ' + code)); return true; },
      'timeout-callback': () => finish(reject, new Error('captcha-timeout')) });
  });
}
const LOGIN_DOMAIN = 'petrokima.local';
function loginName(v){ v=String(v||'').trim(); return v.includes('@') ? v.toLowerCase() : v.toLowerCase().replace(/[^a-z0-9._-]/g,'') + '@' + LOGIN_DOMAIN; }
let lastTempPass = '';
async function doLogin(){
  const email=loginName($('li-email').value), pass=$('li-pass').value;
  if(!email||!pass) return showLogin('Enter your email and password.');
  const b=$('btn-login'); b.disabled=true; b.textContent='Signing in…';
  let cap; try { cap = await captchaToken('li-cap', 'en'); } catch(e){ cap = undefined; }   // check unavailable: Supabase decides
  const { data, error } = await sb.auth.signInWithPassword({ email, password:pass, options: cap ? { captchaToken: cap } : undefined });
  b.disabled=false; b.textContent='Sign in';
  if (error) return showLogin(/invalid/i.test(error.message) ? 'Wrong employee code / email or password.' : /captcha/i.test(error.message) ? 'The security check did not complete. Check the internet connection and try again.' : esc(error.message));
  lastTempPass = pass; $('li-pass').value=''; await afterLogin(data.user);
}
async function afterLogin(user){
  const { data } = await sb.from('app_users').select('*').eq('id', user.id);
  const me = data && data[0];
  const stop = html => { $('app').style.display='none'; $('login').style.display='flex'; $('login-form').style.display='none';
    $('login-err').style.display='none'; $('login-noaccess').style.display='block';
    $('login-noaccess').innerHTML = `<div class="alert a-warn" style="margin:0 0 14px">${html}</div><button class="btn btn-ghost" data-act="signout" style="width:100%;justify-content:center">Sign out</button>`; };
  if (!me || !me.role) return stop(`Signed in as <b>${esc(user.email)}</b>, but this account has not been given access yet. Ask the administrator to assign you a role.`);
  if (!me.active) return stop(`The account <b>${esc(user.email)}</b> is locked or deactivated. Contact the administrator.`);
  if (me.must_change_password) return showFirstLogin(me, user);
  // Admin / HR / HR Officer: the 6-digit code (two-step sign-in) before staff powers
  if (STAFF_ROLES.includes(me.role) && !(await mfaGate(me, user))) return;
  if (me.role==='employee') return showSelf(me, user);
  if (me.role==='manager') return stop(`Manager access to the desktop app arrives in Phase 2 with reporting lines. Your account is ready.`);
  ME = { ...me, email:user.email };
  PK_ERR.user(ME);                                    // error reports carry only the login's number and role
  const r = me.role;
  document.body.classList.toggle('can-hr',    r==='admin' || r==='hr');
  document.body.classList.toggle('can-pay',   r==='admin' || r==='finance');
  document.body.classList.toggle('can-set',   r==='admin' || r==='finance');
  document.body.classList.toggle('can-admin', r==='admin');
  document.body.classList.toggle('can-var',   ['admin','hr','finance','hr_officer'].includes(r));   // variable (monthly) entries
  document.body.classList.toggle('is-officer', r==='hr_officer');
  $('me-name').textContent = me.full_name || user.email; $('me-role').textContent = ROLE_LABEL[r];
  if (me.full_name) localStorage.setItem('approver', me.full_name);   // review fix: never the previous user's name on a shared PC
  $('btn-myprofile').style.display = me.emp_id ? '' : 'none';
  $('login').style.display='none'; $('app').style.display='block';
  await loadAll();
}
function showFirstLogin(me, user){
  $('app').style.display='none'; $('self').style.display='none'; $('login').style.display='flex';
  ['login-form','login-noaccess'].forEach(id=>$(id).style.display='none'); $('login-first').style.display='block';
  $('login-err').style.display='none'; $('fl-name').textContent = me.full_name || user.email;
  ['fl-year','fl-p1','fl-p2'].forEach(id=>$(id).value=''); setTimeout(()=>$('fl-year').focus(),50);
  $('btn-first').onclick = async () => {
    const yr=$('fl-year').value.trim(), a=$('fl-p1').value, b=$('fl-p2').value, err=$('login-err');
    const show = m => { err.innerHTML=m; err.style.display='block'; };
    err.style.display='none';
    if (a.length < 8) return show('The new password must be at least 8 characters.');
    if (a !== b) return show('The two passwords do not match.');
    if (a === lastTempPass) return show('Choose a password different from the temporary one.');
    const btn=$('btn-first'); btn.disabled=true; btn.textContent='Saving…';
    if (!/^\d{4}$/.test(yr)) return show('Enter the year you were born (4 digits, e.g. 1988).');
    const { data, error } = await sb.rpc('complete_first_login', { p_nid_last4:null, p_new_password:a, p_birth_year:yr });
    btn.disabled=false; btn.textContent='Set my password';
    if (error) return show(esc(error.message));
    if (data !== 'ok') return show(esc(data));
    lastTempPass=''; err.style.display='none'; $('login-first').style.display='none'; toast('Password set — welcome!');
    await afterLogin(user);
  };
}
let SELF = null;
async function showSelf(me, user){
  setTimeout(() => { const n = $('self-pcost-nav'); if (n) n.style.display = me && me.acct_reports ? '' : 'none'; }, 0);
  $('app').style.display='none'; $('login').style.display='none'; $('self').style.display='block';
  SELF = { me, user };
  $('self-back').style.display = me.role!=='employee' ? '' : 'none';
  $('self-role').textContent = ROLE_LABEL[me.role] || 'Employee';
  $('self-name').textContent = me.full_name || user.email;
  await loadSelf();
}
async function signOut(){ try { await sb.auth.signOut(); } catch(e){} location.reload(); }
async function changePassword(){
  const a=$('pw1').value, b=$('pw2').value;
  if (a.length < 8) return toast('Use at least 8 characters','warn');
  if (a !== b) return toast('The two passwords do not match','warn');
  const { error } = await sb.auth.updateUser({ password:a });
  if (error) return toast(error.message,'err');
  $('pw1').value=''; $('pw2').value=''; closeM('m-pass'); toast('Password changed');
}
async function disconnect(){ try { if (sb) await sb.auth.signOut(); } catch(e){} localStorage.removeItem('sb_url'); localStorage.removeItem('sb_key'); location.reload(); }

// ═════════════════════════════════════════════════════════
//  LOAD
// ═════════════════════════════════════════════════════════
async function loadSettings(){
  const { data } = await sb.from('settings').select('*').eq('key','payroll');
  settings = { ...DEFAULTS, ...((data && data[0] && data[0].value) || {}) };
  if(!settings.period) settings.period = thisMonth();
}

async function loadPeriodData(){
  const p = settings.period, y = p.slice(0,4), ps = periodStart(p), pe = periodEnd(p);
  loader(true, 'Loading period ' + p + '…');
  const soft = (promise, onFail) => promise.catch(e => { console.warn(e.message); if (onFail) onFail(); return null; });
  const [att, mon, perm, lv, pen, hol, runs, clocks, devices, hrreq, par, appr, phal, eproj, miss] = await Promise.all([
    fetchAll('attendance','date', q => q.gte('date', ps).lte('date', pe)),
    fetchAll('payroll_period_elements','emp_id', q => q.eq('period', p)),
    soft(fetchAll('attendance_permissions','date', q => q.gte('date', ps).lte('date', pe))),
    soft(fetchAll('employee_leaves','date_from', q => q.lte('date_from', pe > `${y}-12-31` ? pe : `${y}-12-31`).gte('date_to', ps < `${y}-01-01` ? ps : `${y}-01-01`))),   // whole year AND the whole cycle (a January cycle starts in December)
    soft(fetchAll('employee_penalties','incident_date', q => q.gte('apply_period', `${y}-01`).lte('apply_period', `${y}-12`))),
    soft(fetchAll('public_holidays','date')),
    soft(fetchAll('payroll_runs','period')),
    soft(fetchAll('clock_events','at', q => q.gte('local_date', ps).lte('local_date', pe))),
    soft(fetchAll('employee_devices','emp_id')),
    soft(fetchAll('hr_requests','created_at')),
    soft(fetchAll('project_allowance_rules','created_at')),
    soft(fetchAll('allowance_approvals','emp_id', q => q.eq('period', p))),
    soft(fetchAll('phone_alerts','last_at')),
    soft(fetchAll('employee_projects','emp_id')),
    soft(fetchAll('employee_missions','date_from', q => q.gte('date_to', ps).lte('date_from', pe))) ]);
  S.attendance = att; S.monthly = mon;
  S.permissions = perm || []; permTableMissing = perm === null;
  S.leaves = lv || [];        leaveTableMissing = lv === null;
  S.penalties = pen || [];    penTableMissing = pen === null;
  S.holidays = hol || [];     holTableMissing = hol === null;
  holidaySet = new Set(S.holidays.map(h => h.date));
  S.runs = runs || [];        runsTableMissing = runs === null;
  S.runLines = S.runs.some(r => r.period === p) ? (await soft(fetchAll('payroll_run_lines','emp_id', q => q.eq('period', p)))) || [] : [];
  S.clocks = clocks || []; S.devices = devices || [];
  S.hrreq = hrreq || [];      hrTableMissing = hrreq === null;
  S.parRules = par || [];     parTableMissing = par === null;
  S.allowAppr = appr || [];   apprTableMissing = appr === null;
  S.phoneAlerts = (phal || []).sort((a,b) => String(b.last_at).localeCompare(String(a.last_at)));
  S.empProjects = eproj || [];  assignTableMissing = eproj === null;
  S.missions = miss || [];
}

async function loadAll(){
  try{
    loader(true,'Loading settings…');   await loadSettings();
    loader(true,'Loading employees, projects, salary structure and the period — all at once…');
    const t0 = performance.now();
    const [emps, projs, els, fx, ln] = await Promise.all([
      fetchAll(isOfficer() ? 'employees_safe' : 'employees','id'),          // HR Officers never receive pay figures
      fetchAll('projects','id'),
      fetchAll('salary_elements','sort_order'),
      fetchAll('employee_salary_elements','emp_id'),
      fetchAll('employee_loans','created_at'),
      loadPeriodData() ]);
    S.employees = emps; S.projects = projs; S.elements = els; S.fixed = fx; S.loans = ln;
    LOAD_MS = Math.round(performance.now() - t0);
    buildLists(); applySettingsUI(); renderAll();
    toast(`Loaded ${S.employees.length} employees · ${S.projects.length.toLocaleString()} projects · ${S.attendance.length.toLocaleString()} attendance records in ${(LOAD_MS/1000).toFixed(1)} s`);
  }catch(e){
    toast('Load error — ' + e.message, 'err'); console.error(e);
  }finally{ loader(false); }
}

function buildLists(){
  const act = S.employees.filter(e => e.status !== 'Inactive' || onPayroll(e, settings.period));
  // the label repeats code + name: Firefox shows and searches only the label (Chrome shows both)
  $('dl-emp').innerHTML = act.map(e => `<option value="${esc(e.id)} — ${esc(empName(e))}" label="${esc(e.id)} — ${esc(empName(e))}${e.name_ar && e.name_ar !== empName(e) ? ' · ' + esc(e.name_ar) : ''}"></option>`).join('');
  $('dl-emp-mgr') ? null : document.body.insertAdjacentHTML('beforeend','<datalist id="dl-emp-mgr"></datalist>');
  if (!$('dl-jobs')) document.body.insertAdjacentHTML('beforeend','<datalist id="dl-jobs"></datalist>');
  $('dl-jobs').innerHTML = [...new Set(S.employees.filter(e=>e.status!=='Inactive').map(e=>String(e.job_name||'').trim()).filter(Boolean))].sort().map(j=>`<option value="${esc(j)}">`).join('');
  $('dl-emp-mgr').innerHTML = S.employees.filter(e=>e.status!=='Inactive').map(e=>`<option value="${esc(e.id)} — ${esc(empName(e))}" label="${esc(e.id)} — ${esc(empName(e))}${e.job_name ? ' · ' + esc(e.job_name) : ''}"></option>`).join('');
  $('dl-proj').innerHTML = S.projects.filter(p => p.status !== 'Inactive' && p.status !== 'Completed')
                            .map(p => `<option value="${esc(p.id)} — ${esc(p.name||'')}"></option>`).join('');
  const depts = [...new Set(S.employees.map(e=>e.department).filter(Boolean))].sort();
  const units = [...new Set(S.employees.map(e=>e.unit).filter(Boolean))].sort();
  const dOpts = '<option value="">All departments</option>' + depts.map(d=>`<option>${esc(d)}</option>`).join('');
  ['emp-dept','mon-dept','pay-dept','rep-dept','lv-dept','ex-dept','rl-dept','ms-dept','dq-dept','co-dept','loan-dept'].forEach(id => { const v=$(id).value; $(id).innerHTML=dOpts; $(id).value=v; });
  const uv=$('emp-unit').value; $('emp-unit').innerHTML='<option value="">All units</option>'+units.map(u=>`<option>${esc(u)}</option>`).join(''); $('emp-unit').value=uv;
  const mEls = S.elements.filter(e => e.input_method==='Monthly' && e.active!==false);
  const mv=$('mon-el').value;
  $('mon-el').innerHTML = mEls.length ? mEls.map(e=>`<option value="${e.code}">${e.element_type==='Deduction'?'(−)':'(+)'} ${e.code} · ${esc(e.name_en)}${e.name_ar?' · '+esc(e.name_ar):''}</option>`).join('') : '<option value="">No variable elements yet — create one</option>';
  if(mv) $('mon-el').value = mv;
}

// Pages are prepared when they are opened (the payroll calculation, reports and labour cost are the heavy ones)
const PAGE_RENDER = { dashboard:()=>renderDashboard(), employees:()=>renderEmployees(), attendance:()=>renderAttendance(), projects:()=>renderProjects(),
  monthly:()=>renderMonthly(), loans:()=>renderLoans(), payroll:()=>renderPayroll(), reports:()=>renderReports(), permissions:()=>renderPermissions(),
  leaves:()=>renderLeaves(), exempt:()=>renderExempt(), penalties:()=>renderPenalties(), holidays:()=>renderHolidays(), hrreq:()=>renderHrRequests(),
  reporting:()=>renderReporting(), history:()=>renderHistory(), parrules:()=>renderParRules(), approvals:()=>renderApprovals(), assign:()=>renderAssign(), bulk:()=>renderBulk(), calc:()=>renderCalc(), news:()=>renderNewsPage(), voice:()=>renderVoicePage() };
let DIRTY = new Set(), LOAD_MS = 0;
function currentPage(){ const p = document.querySelector('.page.active'); return p ? p.id.replace('page-','') : 'dashboard'; }
function renderPageIfNeeded(name){ if (DIRTY.has(name) && PAGE_RENDER[name]) { DIRTY.delete(name); PAGE_RENDER[name](); } }
function renderAll(){
  $('period-badge').textContent = 'Period ' + periodLabel(settings.period);
  DIRTY = new Set(Object.keys(PAGE_RENDER));
  // always kept current: the dashboard, the menu badges, lock and period notices
  renderPageIfNeeded('dashboard'); renderPageIfNeeded('reporting'); renderLocks(); renderPeriodHint();
  renderPageIfNeeded(currentPage());
}

// @ts-check — checked by TypeScript (tsconfig.json); keep it free of type errors
// ═════════════════════════════════════════════════════════
//  PAYROLL ENGINE
// ═════════════════════════════════════════════════════════
// 85 (Mohammed's rule 1B): a pay change applies to WHOLE pay cycles — the package in force on the cycle's LAST day is paid
// for the whole cycle, so a mid-cycle change can never pay two salaries. New dates are moved to cycle boundaries by the
// database (trg_a_cycle_dates). MUST match payroll_calc (file 85).
function fixedActive(row, p){
  const e = periodEnd(p);
  return row.effective_from <= e && (!row.effective_to || row.effective_to >= e);
}
// Is an instalment of loan l due in month number i (year*12 + month-1)?  Postponed months (62) are skipped and the loan
// runs that many months longer. MUST stay identical to _pk_loan_due() in the database (file 62).
const PER_RE = /^\d{4}-\d{1,2}$/;
function loanPostponedIdx(l){ return [...new Set((Array.isArray(l.postponed)?l.postponed:[]).filter(x=>PER_RE.test(String(x))).map(periodIdx))]; }
function loanDue(l, i){
  const pp = loanPostponedIdx(l);
  if (pp.includes(i)) return false;
  if (!PER_RE.test(String(l.start_period||''))) return true;
  const s = periodIdx(l.start_period);
  return i >= s && (i - s - pp.filter(x => x >= s && x < i).length) < num(l.periods);
}
function loanEnd(l){            // 'YYYY-MM' of the last instalment
  if (!PER_RE.test(String(l.start_period||''))) return '';
  const s = periodIdx(l.start_period);
  for (let g = s + num(l.periods) + 240; g >= s; g--) if (loanDue(l, g)) return `${Math.floor(g/12)}-${pad(g%12+1)}`;
  return '';
}
// 85: the payroll recovers (loan − amount already settled) and never more; the last instalment absorbs the rounding
// (10,000 ÷ 3 → 3,333.33 · 3,333.33 · 3,333.34). MUST stay identical to _pk_loan_pay() in the database (file 85).
function loanInstalment(l, p){
  if (l.status !== 'Active') return 0;
  const i = periodIdx(p);
  if (!loanDue(l, i)) return 0;
  const r2 = x => Math.round(x * 100) / 100;
  const inst = r2(num(l.installment) || (num(l.loan_amount) / Math.max(1,num(l.periods))));
  const target = r2(Math.max(0, num(l.loan_amount) - num(l.amount_settled)));
  if (!PER_RE.test(String(l.start_period||''))) return r2(Math.min(inst, target));
  const s = periodIdx(l.start_period); let k = 0;
  for (let g = s; g <= i; g++) if (loanDue(l, g)) k++;            // this is instalment number k
  const paid = r2(Math.min((k - 1) * inst, target)), rem = r2(target - paid);
  if (rem <= 0) return 0;
  if (k === num(l.periods) && rem <= inst + 1) return rem;
  return r2(Math.min(inst, rem));
}
// 86: balance still to recover at the START of period p = (loan − settled) − what the payroll recovered in earlier months.
// null when the loan has no start month. MUST stay identical to _pk_loan_left() in the database (file 86).
function loanLeft(l, p){
  if (!PER_RE.test(String(l.start_period||''))) return null;
  const r2 = x => Math.round(x * 100) / 100, s = periodIdx(l.start_period), i = periodIdx(p), act = { ...l, status:'Active' };
  let paid = 0;
  for (let g = s; g < i; g++) paid += loanInstalment(act, `${Math.floor(g/12)}-${pad(g%12+1)}`);
  return r2(Math.max(0, r2(Math.max(0, num(l.loan_amount) - num(l.amount_settled))) - r2(paid)));
}

// Daily attendance rules — each instance is calculated separately:
//   overtime : hours beyond the standard day, only once the minimum is reached
//   late     : first check-in after the latest allowed arrival
//   early    : hours short of the standard day that are NOT already explained by lateness
// An approved permission waives up to the permission's hours of late or early time on that day.
// Employees flagged attendance_exempt get no overtime and no deductions.
// an approved outside mission covers this day (66) — late / early are not deducted. MUST match payroll_calc (file 66).
function missionsOn(empId, date){ return (S.missions||[]).filter(m => m.status==='Approved' && String(m.emp_id)===String(empId) && m.date_from<=date && m.date_to>=date); }
function missionOn(empId, date){ return missionsOn(empId, date).length > 0; }
// 85: a mission WITHOUT times covers the whole day (no late/early, and the day is never absent); a mission WITH times
// excuses at most its own hours — late first, then early. MUST match payroll_calc (file 85).
function missionCover(empId, date){
  const ms = missionsOn(empId, date); if (!ms.length) return null;
  if (ms.some(m => !m.time_from || !m.time_to)) return { full:true, hours:0 };
  return { full:false, hours: Math.round(ms.reduce((s,m) => s + Math.max(0, toMin(m.time_to) - toMin(m.time_from)) / 60, 0) * 100) / 100 };
}
const isWeekend = d => (settings.weekendDays||[]).includes(dObj(d).getDay());
function approvedPerms(empId, date){ return S.permissions.filter(p => p.status==='Approved' && String(p.emp_id)===String(empId) && p.date===date); }
// a day still waiting for its check-out: a forgotten phone check-out, or a line left open on an earlier day.
// Its hours are not counted until the check-out is recorded or HR settles it on the Attendance page.
function attNoOut(a){ return !!a && (a.projects||[]).some(x => x.forgotten || (x.in && !x.out && !x.missing && a.date < todayStr())); }
function dayRules(a, emp){
  const r = { ot:0, late:0, early:0, lateRaw:0, earlyRaw:0, waived:0, exempt: !!(emp && emp.attendance_exempt) };
  if (!a || r.exempt || !(a.status==='Present' || a.status==='Half Day')) return r;
  if (leaveOn(emp ? emp.id : a.emp_id, a.date)) { r.onLeave = true; return r; }
  // a missing punch, a forgotten phone check-out, or an implausibly long day: no deductions or overtime until HR corrects it
  if ((a.projects||[]).some(x => x.missing || x.review || x.forgotten) || attNoOut(a)) { r.missing = true; r.noOut = attNoOut(a); return r; }
  const std = num(settings.hoursPerDay), tot = num(a.total_hours);
  const extra = Math.round((tot - std) * 100) / 100, thr = num(settings.otThreshold);
  if (extra > 0 && extra >= thr) r.ot = settings.otMode==='after' ? Math.max(0, extra - thr) : extra;
  // holidays — and (85, rule 3B) weekend days: overtime only, never late / early deductions, no extra weekend pay
  if (isHoliday(a.date) || isWeekend(a.date)) { r.holiday = isHoliday(a.date); r.weekend = !r.holiday; ['ot','late','early','lateRaw','earlyRaw','waived'].forEach(k => r[k] = Math.round(r[k]*100)/100); return r; }
  if (a.status==='Present'){
    const evening = a.check_in && toMin(a.check_in) >= toMin(settings.eveningShiftAfter || '14:00');   // evening / night shift
    r.evening = !!evening;
    if (a.check_in && !evening){ const lm = toMin(a.check_in) - toMin(settings.lateAfter || '09:00'); if (lm > 0) r.lateRaw = lm/60; }
    const onSiteNow = a.date === todayStr() && (a.projects||[]).some(x => x.in && !x.out && !x.forgotten);
    r.earlyRaw = onSiteNow ? 0 : Math.max(0, (std - tot) - r.lateRaw);   // the day is not over yet
    r.inProgress = onSiteNow;
    let wl = 0, we = 0; const cap = num(settings.permissionMaxHours) || 2;
    approvedPerms(emp ? emp.id : a.emp_id, a.date).forEach(p => {
      const h = Math.min(num(p.hours), cap);
      if (p.type==='Late arrival') wl = Math.max(wl, Math.min(r.lateRaw, h));
      if (p.type==='Early leave')  we = Math.max(we, Math.min(r.earlyRaw, h));
    });
    const mc = missionCover(emp ? emp.id : a.emp_id, a.date);
    if (mc && mc.full) { wl = r.lateRaw; we = r.earlyRaw; r.mission = true; }
    else if (mc) { const wlM = Math.min(r.lateRaw, mc.hours), weM = Math.min(r.earlyRaw, Math.max(0, mc.hours - wlM));
                   wl = Math.max(wl, wlM); we = Math.max(we, weM); r.mission = true; }
    r.late = r.lateRaw - wl; r.early = r.earlyRaw - we; r.waived = wl + we;
  }
  ['ot','late','early','lateRaw','earlyRaw','waived'].forEach(k => r[k] = Math.round(r[k]*100)/100);
  return r;
}

// One source of truth for an employee's rates — used by the payroll engine and every screen.
function empBasic(emp, p){
  const b = S.fixed.filter(r => String(r.emp_id)===String(emp.id) && fixedActive(r, p||settings.period))
                   .filter(r => { const el=elByCode(r.element_code); return el && el.is_basic; })
                   .reduce((s,r)=>s+num(r.amount),0);
  return b || num(emp.salary);
}
function empRates(emp, p){
  const basic = empBasic(emp, p), days = num(settings.daysPerMonth)||30, hrs = num(settings.hoursPerDay)||8;
  const hourly = num(emp.hour_pay) || basic/days/hrs;
  return { basic, daily: num(emp.daily_pay) || basic/days, hourly, delay: num(emp.delay_hour_pay) || hourly,
           dailyFromBasic: !num(emp.daily_pay), hourlyFromBasic: !num(emp.hour_pay) };
}

// ── Project Allowance rules: the most specific active rule wins ──
function allowanceRule(emp, code){
  if (!code || !emp) return null;
  const R = S.parRules.filter(r => r.active !== false), job = String(emp.job_name||'').trim().toLowerCase();
  const isEmp = r => r.applies_to==='employee' && String(r.emp_id)===String(emp.id);
  const isJob = r => r.applies_to==='job' && job && String(r.job_name||'').trim().toLowerCase()===job;
  return R.find(r => isEmp(r) && r.project_code===code) || R.find(r => isEmp(r) && !r.project_code)
      || R.find(r => isJob(r) && r.project_code===code) || R.find(r => isJob(r) && !r.project_code) || null;
}
// one allowance per day: the project with most hours that day among those with a rule
function autoAllowance(emp){
  const byDay = {};
  const ps = periodStart(settings.period), pe = periodEnd(settings.period);
  S.attendance.filter(a => String(a.emp_id)===String(emp.id) && a.date >= ps && a.date <= pe && (a.status==='Present' || a.status==='Half Day')).forEach(a => {
    const h = {}; (a.projects||[]).forEach(x => { if (x.code) h[x.code] = (h[x.code]||0) + num(x.hours); });
    let best = byDay[a.date] || null;
    Object.entries(h).forEach(([c, hr]) => { const r = allowanceRule(emp, c); if (r && (!best || hr > best.h)) best = { c, h:hr, r }; });
    if (best) byDay[a.date] = best;
  });
  const g = {};
  Object.values(byDay).forEach(b => { const k = b.c + '|' + b.r.id; (g[k] = g[k] || { project:b.c, rule:b.r.id, rate:num(b.r.amount_per_day), days:0 }).days++; });
  return Object.values(g).map(x => ({ ...x, amount: Math.round(x.days * x.rate * 100) / 100 }));
}
// the automatic allowance is paid only when the manager AND HR have approved it — and only the approved amount
function allowanceApproval(emp){ return S.allowAppr.find(a => String(a.emp_id)===String(emp.id) && a.period===settings.period) || null; }
function approvedAllowance(emp){ const a = allowanceApproval(emp); return a && a.status==='Approved' ? a : null; }
function computeEmployee(emp){
  const p = settings.period, lines = [];
  const add = (code, name, type, amount, note) => { if (Math.abs(amount) > 0.004) lines.push({ code, name, type, amount: Math.round(amount*100)/100, note }); };

  // days employed in the cycle — fixed additions are paid pro-rata on a 30-day basis
  const emp_ = employment(emp, p);

  // fixed elements
  const fx = S.fixed.filter(r => String(r.emp_id)===String(emp.id) && fixedActive(r,p));
  const basicRows = fx.filter(r => { const el=elByCode(r.element_code); return el && el.is_basic; });
  let basic = basicRows.reduce((s,r)=>s+num(r.amount),0);
  if (!basic) basic = num(emp.salary);
  const proNote = emp_.partial ? `${emp_.days} of ${emp_.len} days (${emp_.from} → ${emp_.to})` : '';
  fx.forEach(r => {
    const el = elByCode(r.element_code); if (!el || el.active===false) return;
    let amt = el.calc_method==='PercentOfBasic' ? basic*num(r.amount)/100 : num(r.amount);
    if (el.element_type==='Addition' && emp_.partial) amt *= emp_.factor;
    add(el.code, el.name_en, el.element_type, amt, el.element_type==='Addition' ? proNote : '');
  });
  if (!basicRows.length && basic) add(0, 'Basic salary (employee record)', 'Addition', basic * emp_.factor, proNote);

  // monthly variable elements
  S.monthly.filter(m => String(m.emp_id)===String(emp.id)).forEach(m => {
    const el = elByCode(m.element_code); if (!el) return;
    add(el.code, el.name_en, el.element_type, num(m.amount), m.project_code ? 'Project ' + projLabel(m.project_code) : '');
  });

  // Project Allowance — automatic, from attendance at projects and the rules
  const paEl = elByCode(num(settings.codeProjAllow) || 12);
  const appr = approvedAllowance(emp);
  if (paEl && appr) (appr.details || []).forEach(x =>
    { add(paEl.code, paEl.name_en + ' — automatic', paEl.element_type, x.amount, `${x.days} day${x.days===1?'':'s'} × ${fmt(x.rate)} at ${projLabel(x.project)}`); if (lines.length) lines[lines.length-1].project = x.project; });

  // overtime (calculated)
  const att = S.attendance.filter(a => String(a.emp_id)===String(emp.id));
  const rules = att.map(a => dayRules(a, emp));
  const otH = rules.reduce((s,r)=>s+r.ot,0), lateH = rules.reduce((s,r)=>s+r.late,0), earlyH = rules.reduce((s,r)=>s+r.early,0), waivedH = rules.reduce((s,r)=>s+r.waived,0);
  const hourly = num(emp.hour_pay) || (basic / (num(settings.daysPerMonth)||30) / (num(settings.hoursPerDay)||8));
  const elOT = elByCode(settings.codeOT);
  add(settings.codeOT, elOT ? elOT.name_en : 'Overtime', 'Addition', hourly * num(settings.otMultiplier) * otH, otH ? `${fmt(otH)} h × ${fmt(hourly)} × ${settings.otMultiplier}` : '');

  // delay hours (calculated) — per hour cost, no multiplier
  const delayRate = num(emp.delay_hour_pay) || hourly;
  const elDelay = elByCode(settings.codeDelay);
  const delayNote = [lateH?`${fmt(lateH)} h late`:'', earlyH?`${fmt(earlyH)} h early/short`:''].filter(Boolean).join(' + ');
  add(settings.codeDelay, elDelay ? elDelay.name_en : 'Delay hours', 'Deduction', (lateH + earlyH) * delayRate,
      delayNote ? `${delayNote} × ${fmt(delayRate)}${waivedH?` (${fmt(waivedH)} h waived by permission)`:''}` : '');

  // unpaid leave (85) — daily pay × CALENDAR days of approved unpaid leave inside the employed part of the cycle (max 30)
  const ud = new Set();
  S.leaves.filter(l => String(l.emp_id)===String(emp.id) && l.status==='Approved' && l.leave_type==='Unpaid').forEach(l => {
    const a0 = l.date_from > emp_.from ? l.date_from : emp_.from, b0 = l.date_to < emp_.to ? l.date_to : emp_.to;
    for (let d = dObj(a0), g = 0; dStr(d) <= b0 && g < 400; d.setDate(d.getDate()+1), g++) ud.add(dStr(d));
  });
  const unpaidDays = Math.min(ud.size, num(settings.daysPerMonth)||30);
  const dailyRate = num(emp.daily_pay) || basic/(num(settings.daysPerMonth)||30);

  // absence — one day's pay per unexcused absent working day (an "Absent" record, or 85 / rule 2A: a past working day
  // with NO attendance record, leave or full-day mission; not for attendance-exempt staff; from settings.autoAbsentFrom)
  const fullMission = d => { const mc = missionCover(emp.id, d); return !!(mc && mc.full); };
  const absSet = new Set(att.filter(a => a.status==='Absent' && isWorkday(a.date) && !leaveOn(emp.id, a.date) && !fullMission(a.date)).map(a => a.date));
  let autoAbs = 0;
  if (!emp.attendance_exempt && emp_.to >= emp_.from) {
    const af = String(settings.autoAbsentFrom || ''), autoFrom = /^\d{4}-\d{2}-\d{2}$/.test(af) ? af : '';
    const today = todayStr(), had = new Set(att.map(a => a.date));
    for (let d = dObj(emp_.from), g = 0; dStr(d) <= emp_.to && g < 400; d.setDate(d.getDate()+1), g++) {
      const ds = dStr(d);
      if (ds >= today || (autoFrom && ds < autoFrom) || !isWorkday(ds) || had.has(ds) || leaveOn(emp.id, ds) || fullMission(ds)) continue;
      if (!absSet.has(ds)) { absSet.add(ds); autoAbs++; }
    }
  }
  const absentDates = [...absSet].sort();
  const elAbs = elByCode(settings.codeAbsent);
  add(settings.codeAbsent, elAbs ? elAbs.name_en : 'Absence', 'Deduction', absentDates.length * dailyRate,
      absentDates.length ? `${absentDates.length} day${absentDates.length>1?'s':''} × ${fmt(dailyRate)} (${absentDates.map(d=>d.slice(5)).join(', ')})` : '');

  // public holiday work (calculated) — extra day's pay for each holiday worked
  const holWorked = att.filter(a => isHoliday(a.date) && (a.status==='Present' || a.status==='Half Day'));
  const holDays = [...new Set(holWorked.map(a=>a.date))].reduce((s,d)=> s + (holWorked.some(a=>a.date===d && a.status==='Present') ? 1 : 0.5), 0);
  const holX = num(settings.holidayExtraDays) || 1, elHol = elByCode(settings.codeHoliday);
  add(settings.codeHoliday, elHol ? elHol.name_en : 'Public holiday work', 'Addition', holDays * dailyRate * holX,
      holDays ? `${fmt(holDays)} holiday day${holDays===1?'':'s'} × ${fmt(dailyRate)}${holX!==1?` × ${holX}`:''}` : '');

  // penalties — approved penalties assigned to this payroll
  const pens = S.penalties.filter(x => String(x.emp_id)===String(emp.id) && x.status==='Approved' && x.apply_period===p);
  const penAmt = pens.reduce((s,x)=>s+penaltyValue(x, emp, dailyRate, num(emp.hour_pay)||hourly),0);
  const elPen = elByCode(settings.codePenalty);
  add(settings.codePenalty, elPen ? elPen.name_en : 'Penalties', 'Deduction', penAmt,
      pens.length ? pens.map(x=>`${x.incident_date.slice(5)}: ${penLabel(x)}`).join(' · ') : '');
  const elUnpaid = elByCode(settings.codeUnpaid);
  add(settings.codeUnpaid, elUnpaid ? elUnpaid.name_en : 'Unpaid leave', 'Deduction', unpaidDays * dailyRate, unpaidDays ? `${fmt(unpaidDays)} day${unpaidDays===1?'':'s'} × ${fmt(dailyRate)}` : '');

  // social insurance (calculated)
  const saudi = String(emp.entity||'').toLowerCase().includes('saudi');
  const insured = String(emp.insurance||'').toLowerCase() === 'insured';
  const siRate = saudi ? num(settings.siRateSA) : num(settings.siRateEG);
  const elSI = elByCode(settings.codeSI);
  // 85: in Egypt the insurance wage is kept within the legal minimum and maximum (Net ↔ Gross calculator rates, 2026: 2,700–16,700)
  const siRaw = num(emp.insurance_amount), CR = calcRates(), siLo = num(CR.siMin) || 2700, siHi = num(CR.siMax) || 16700;
  const siBase = (!saudi && siRaw > 0) ? Math.min(Math.max(siRaw, siLo), siHi) : siRaw;
  if (insured) add(settings.codeSI, elSI ? elSI.name_en : 'Social insurance', 'Deduction', siBase * siRate / 100,
                   `${fmt(siBase)} × ${siRate}%` + (siBase !== siRaw ? ` (insurance wage ${fmt(siRaw)} kept within ${fmt(siLo)}–${fmt(siHi)})` : ''));

  // loans
  const elLoan = elByCode(settings.codeLoan);
  // 86: an employee who leaves in this cycle repays the whole remaining balance from the final pay — but never more than
  // leaves net pay at zero (at least the normal instalments); the rest is shown as still owed. MUST match payroll_calc (file 86).
  const myLoans = S.loans.filter(l => String(l.emp_id)===String(emp.id));
  const regLoans = myLoans.reduce((s,l)=>s+loanInstalment(l,p),0);
  let loanAmt = regLoans, loanOwed = 0, loanNote = '';
  if (emp.resignation_date && emp.resignation_date <= periodEnd(p)) {
    const full = Math.round(myLoans.reduce((s,l) => {
      const left = (l.status==='Active' || l.status==='Suspended') ? loanLeft(l, p) : null;
      return s + (left === null ? loanInstalment(l,p) : left); }, 0) * 100) / 100;
    if (full > regLoans + 0.004) {
      const netBefore = Math.round((lines.filter(x=>x.type==='Addition').reduce((s,x)=>s+x.amount,0) - lines.filter(x=>x.type==='Deduction').reduce((s,x)=>s+x.amount,0)) * 100) / 100;
      loanAmt = Math.max(regLoans, Math.min(full, Math.max(0, netBefore)));
      loanOwed = Math.round((full - loanAmt) * 100) / 100;
      loanNote = `Final pay: remaining loan balance ${fmt(full)}` + (loanOwed > 0.004 ? ` — ${fmt(loanAmt)} deducted, ${fmt(loanOwed)} still owed (collect from the end-of-service settlement)` : '');
    }
  }
  add(settings.codeLoan, elLoan ? elLoan.name_en : 'Loans', 'Deduction', loanAmt, loanNote || undefined);

  // totals
  const gross = lines.filter(l=>l.type==='Addition').reduce((s,l)=>s+l.amount,0);
  const ded = lines.filter(l=>l.type==='Deduction').reduce((s,l)=>s+l.amount,0);
  const pick = code => lines.filter(l=>String(l.code)===String(code)).reduce((s,l)=>s+l.amount,0);
  const basicLine = lines.filter(l => l.code===0 || (elOrBlank(l.code)).is_basic).reduce((s,l)=>s+l.amount,0);
  const ot = pick(settings.codeOT), si = pick(settings.codeSI), loans = pick(settings.codeLoan), delay = pick(settings.codeDelay);
  const absence = pick(settings.codeAbsent), penalty = pick(settings.codePenalty), holiday = pick(settings.codeHoliday);
  return { emp, lines, basic: basicLine, absence, absentDays: absentDates.length, autoAbsentDays: autoAbs, unpaidDays, loanOwed, penalty, holiday, holDays, days: emp_.days, factor: emp_.factor, partial: emp_.partial, joiner: !!emp_.joiner, leaver: !!emp_.leaver,
           ot, otH, lateH, earlyH, waivedH, delay, gross, si, loans, ded,
           otherAdd: gross - basicLine - ot, otherDed: ded - si - loans, net: gross - ded,
           hasPackage: fx.length > 0 };
}
function currentRun(){ return S.runs.find(r => r.period === settings.period) || null; }
function snapToResult(l){
  const live = empOrBlank(l.emp_id);
  return { otherAdd:0, otherDed:0, basic:0, ot:0, si:0, loans:0, delay:0, absence:0, penalty:0, holiday:0, days:0, ...(l.summary||{}),
    emp: { ...live, id:l.emp_id, name_en:l.name_en, name_ar:l.name_ar, department:l.department, unit:l.unit, entity:l.entity,
           payment_method:l.payment_method, bank_branch:l.bank_branch, bank_account:l.bank_account },
    lines: l.lines || [], gross:num(l.gross), ded:num(l.deductions), net:num(l.net), snapshot:true, hasPackage:true };
}
// Approved months are read from the permanent snapshot, never recalculated
function computeAll(){
  if (currentRun() && S.runLines.length) return S.runLines.map(snapToResult);
  return S.employees.filter(e => onPayroll(e, settings.period)).map(computeEmployee);
}

// ═════════════════════════════════════════════════════════
//  RENDER — DASHBOARD
// ═════════════════════════════════════════════════════════
function renderDashboard(){
  const today = todayStr(), act = S.employees.filter(e=>e.status!=='Inactive');
  $('dash-date').textContent = new Date().toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  $('st-emp').textContent = act.length; $('st-emp-sub').textContent = `${S.employees.length - act.length} inactive on file`;
  const tAtt = S.attendance.filter(a=>a.date===today);
  $('st-today').textContent = tAtt.length; $('st-today-sub').textContent = act.length ? `${(tAtt.length/act.length*100).toFixed(1)}% of active staff` : '';
  $('st-proj').textContent = S.projects.length.toLocaleString();
  updateBadges();
  const pP = S.permissions.filter(readyForHR).length, pL = S.leaves.filter(readyForHR).length,
        pR = S.hrreq.filter(r=>r.status==='Pending'||r.status==='In progress').length;
  const al = (n, what, page, icon) => n ? `<div class="alert a-warn" style="cursor:pointer;margin-bottom:10px" data-nav="${page}">${icon} <b>${n}</b> ${what}${n>1?'s':''} waiting — click to review</div>` : '';
  const pAA = S.allowAppr.filter(a => a.status==='Pending HR').length;
  const pPA = S.phoneAlerts.filter(a => !a.reviewed && a.kind==='other_employee_phone').length;
  const pC = S.clocks.filter(c => c.offline && (c.applied===false || c.clock_suspect || /corrected/.test(c.time_method || ''))).length;
  $('dash-alert').innerHTML = al(pL,'vacation request','leaves','🌴') + al(pP,'permission request','permissions','✋') + al(pR,'HR request','hrreq','📨')
    + al(pAA,'project allowance approval','approvals','✅')
    + (pPA ? `<div class="alert a-alarm" style="margin-bottom:10px;cursor:pointer" data-open-phal="1">🚨 <b>${pPA}</b> attempt${pPA>1?'s':''} to sign in on <b>another employee's phone</b> — click to review</div>` : '')
    + (pC ? `<div class="alert a-warn" style="margin-bottom:10px;cursor:pointer" data-open-report="att-review">📴 <b>${pC}</b> offline check-in${pC>1?'s':''} need${pC>1?'':'s'} review — click to open the report</div>` : '');
  $('st-net').textContent = fmt(computeAll().reduce((s,r)=>s+r.net,0));
  const map = {};
  tAtt.forEach(a => (a.projects||[]).forEach(x => { map[x.code] = map[x.code] || {h:0,n:0}; map[x.code].h += num(x.hours); map[x.code].n++; }));
  const rows = Object.entries(map).sort((a,b)=>b[1].h-a[1].h).map(([c,v]) => {
    const p = S.projects.find(x=>String(x.id)===String(c));
    return `<tr><td class="mono">${esc(c)}</td><td class="strong">${esc(p?p.name:'')}</td><td class="num">${v.n}</td><td class="num">${fmt(v.h)}</td></tr>`;
  });
  $('dash-tbl').innerHTML = rows.join('') || '<tr><td colspan="4" class="empty">No attendance logged today yet</td></tr>';
}

// ═════════════════════════════════════════════════════════
//  RENDER — EMPLOYEES
// ═════════════════════════════════════════════════════════
function renderEmployees(){
  const q=$('emp-q').value.trim().toLowerCase(), d=$('emp-dept').value, u=$('emp-unit').value, st=$('emp-status').value;
  const list = S.employees.filter(e =>
    (!st || (e.status||'Active')===st) && orgMatch(e,'emp') &&
    (!q || [e.id,e.name_ar,e.name_en,e.job_name,e.national_id].some(v => String(v||'').toLowerCase().includes(q))));
  const act = S.employees.filter(e=>e.status!=='Inactive').length;
  $('emp-sub').textContent = `${act} active · ${S.employees.length - act} inactive · ${S.employees.length} total`;
  $('emp-tbl').innerHTML = list.map(e => `<tr class="click" data-emp="${esc(e.id)}">
    <td class="mono">${esc(e.id)}</td><td class="ar strong">${esc(e.name_ar)}</td><td class="strong">${esc(e.name_en)}</td>
    <td>${esc(e.department)}</td><td>${esc(e.unit)}</td><td>${esc(e.job_name)}</td>
    <td>${e.manager_id ? esc(empName(empById(e.manager_id))||e.manager_id) : (e.top_of_org ? '<span class="chip c-blue">Top</span>' : (e.status!=='Inactive' ? '<span class="chip c-orange">not set</span>' : ''))}</td>
    <td>${chip(e.contract_type)}</td><td>${chip(e.insurance)}</td><td>${chip(e.status||'Active')}${e.attendance_exempt?' <span class="chip c-blue">Exception</span>':''}${e.blacklisted?' <span class="chip c-red" title="On the blacklist — cannot be re-employed">⛔ Blacklist</span>':''}</td></tr>`).join('')
    || '<tr><td colspan="10" class="empty">No employees match these filters</td></tr>';
  $('emp-foot').textContent = `Showing ${list.length} of ${S.employees.length}. Click any row to view or edit.`;
}

// @ts-check — checked by TypeScript (tsconfig.json); keep it free of type errors
// ═════════════════════════════════════════════════════════
//  EMPLOYEE MODAL
// ═════════════════════════════════════════════════════════
/** the employee window: [section, [[field, label, kind, options?], …]] @type {Array<[string, any[][]]>} */
const EMP_FIELDS = [
  ['Identity', [['id','Code','text'],['name_ar','Arabic name','text','ar'],['name_en','English name','text']]],
  ['Organisation', [['department','Department','pick','dept'],['unit','Unit','pick','unit'],['entity','Entity','select',['Petrokima Egypt HQ','Petrokima Saudi Branch','Affiliate — Cairo']],
                    ['job_name','Job name','text'],['job_type','Job type','text'],['status','Status','select',['Active','Inactive']],
                    ['manager_id','Direct manager','manager']]],
  ['Contact', [['mobile','Personal mobile','text'],['personal_email','Personal e-mail','email'],['business_phone','Business phone (optional)','text'],['email','Work e-mail (optional)','text'],['address','Address','text']]],
  ['Contract', [['contract_type','Contract type','select',['Permanent','Temporary','Contract']],['contract_start_date','Contract start','date'],
                ['employment_date','Employment date','date'],['probation_end_date','Probation end (blank = automatic: employment date + 3 months)','date'],
                ['contract_end_date','Contract end (blank = automatic: one year after the start, the day before — 1 Sep 2026 → 31 Aug 2027; not for Permanent)','date'],['resignation_date','Resignation date','date']]],
  ['Attendance rules', [['attendance_exempt','Exception rule — no delay deduction and no overtime','bool'],['annual_leave_days','Annual leave days / year — special case only (blank = automatic 15 / 21 / 30)','number'],
                        ['leave_opening_days','Leave balance carried into the first system year (days)','number'],
                        ['leave_early_ok','May request annual / emergency leave before 6 months of service (HR exception)','bool'],
                        ['project_staff','Site staff — must check in at a project from the phone (fingerprint-machine punches kept as records only)','bool']]],
  ['Pay rates & payment', [['daily_pay','Daily pay','number'],['hour_pay','Hour pay','number'],['delay_hour_pay','Delay hour pay','number'],
                 ['payment_method','Payment method','select',['Bank','Cash']],['bank_account','Bank account','text'],['bank_branch','Bank','text']]],
  ['Insurance', [['insurance','Insurance','select',['Insured','Non insured']],['insurance_number','Insurance number','text'],
                 ['insurance_title','Insurance title','text'],['insurance_amount','Insurable amount','number'],['insurance_date','Insurance date (Petrokima)','date'],
                 ['insurance_date_before','Insurance date before Petrokima (first insured — counts towards 10 years)','date']]],
  ['Personal', [['birth_date','Birth date','date'],['gender','Gender','select',['Male','Female']],['marital_status','Marital status','select',['Single','Married','Divorced','Widowed']],
                ['religion','Religion','text'],['nationality','Nationality','text'],['military_status','Military status','select',['','Finished','Exempt','Postponed','Not Applicable']],
                ['national_id','National ID','text'],['national_id_expiry','National ID expiry','date']]],
  ['Disability', [['has_disability','Has a disability card','bool'],['disability_card_no','Disability card number','text'],['disability_card_expiry','Disability card expiry','date']]],
  ['Education', [['university','University','pick','univ'],['college','College','pick','coll'],['certification','Certification','text'],['graduation_date','Graduation date','date']]],
  ['Notes', [['notes','Notes','textarea']]]
];
let editingEmp = null;

// Next employee code: highest numeric code on record (active or not) + 1. Falls back to prefix + number patterns.
function nextEmpCode(ids){
  ids = (ids || S.employees.map(e=>String(e.id))).map(String);
  const nums = ids.filter(x=>/^\d+$/.test(x)).map(Number);
  if (nums.length) return String(Math.max(...nums) + 1);
  /** @type {{p:string, n:number, w:number} | null} */ let best=null; ids.forEach(x=>{ const m=x.match(/^(.*?)(\d+)$/); if(m){ const n=+m[2]; if(!best||n>best.n) best={p:m[1],n,w:m[2].length}; } });
  return best ? best.p + String(best.n+1).padStart(best.w,'0') : '1';
}
function openEmp(id){
  const e = id ? empById(id) : null; editingEmp = e ? e.id : null;
  $('emp-m-title').textContent = e ? `${empName(e)} — ${e.id}` : 'New employee';
  $('emp-form').innerHTML = EMP_FIELDS.map(([sec, fields]) => `<div class="sec">${sec}</div><div class="grid3">` +
    fields.map(([k,label,type,opt]) => {
      const v = e ? (e[k] ?? '') : (k==='status'?'Active':k==='entity'?'Petrokima Egypt HQ':k==='id'?nextEmpCode():'');
      const ro = (k==='id') ? 'readonly' : '';
      if (k==='id' && !e) label = 'Code (automatic — next in sequence)';
      const dir = opt==='ar' ? 'dir="rtl"' : '';
      let ctl;
      if (type==='manager'){
        const m = v ? empById(v) : null;
        ctl = `<input data-f="manager_id" list="dl-emp-mgr" placeholder="Type code or name…" value="${m ? esc(m.id+' — '+empName(m)) : esc(v)}">
          <label style="display:flex;gap:6px;align-items:center;font-size:12px;margin-top:6px;color:var(--label);cursor:pointer"><input type="checkbox" id="emp-top" ${e&&e.top_of_org?'checked':''}> Top of the organisation (no manager)</label>`;
        label = e ? 'Direct manager' : 'Direct manager — required';
      }
      else if (type==='bool') ctl = `<select data-f="${k}"><option ${v===true?'':'selected'}>No</option><option ${v===true?'selected':''}>Yes</option></select>`;
      else if (type==='select'){ const opts=[...opt]; if (v && !opts.includes(v)) opts.push(v);
        ctl = `<select data-f="${k}">${opts.map(o=>`<option ${o===v?'selected':''}>${esc(o)}</option>`).join('')}</select>`; }
      else if (type==='pick') ctl = pickSelect(k, opt, v, opt==='unit' ? pickNorm(e ? e.department : '') : '');
      else if (type==='textarea') ctl = `<textarea data-f="${k}">${esc(v)}</textarea>`;
      else ctl = `<input type="${type}" data-f="${k}" value="${esc(v)}" ${ro} ${dir}>`;
      return `<div class="field ${type==='textarea'?'full':''}"><label>${label}</label>${ctl}</div>`;
    }).join('') + `</div>`).join('');
  if (e && !e.manager_id && !e.top_of_org && e.status!=='Inactive')
    $('emp-form').insertAdjacentHTML('afterbegin','<div class="alert a-warn" style="margin-bottom:6px">This employee has no direct manager yet — set one in the Organisation section.</div>');
  if (isOfficer()) PAY_FIELDS.forEach(k => { const f = document.querySelector(`#emp-form [data-f="${k}"]`); if (f) f.closest('.field').remove(); });
  renderEmpDevice();
  renderPackage();
  openM('m-emp');
}

function renderPackage(){
  const box = $('emp-pkg');
  if (!editingEmp){ box.innerHTML = '<div style="font-size:12px;color:var(--muted)">Save the employee first, then reopen to assign salary elements.</div>'; return; }
  const all = S.fixed.filter(r => String(r.emp_id)===String(editingEmp)).sort((a,b)=>num(a.element_code)-num(b.element_code) || String(a.effective_from).localeCompare(String(b.effective_from)));
  const fixedEls = S.elements.filter(e => e.input_method==='Fixed' && e.active!==false);
  const p = settings.period, ps = periodStart(p), pe = periodEnd(p);
  // amounts that ended before this payroll period are history — kept for past payrolls, shown separately
  const ended = r => r.effective_to && r.effective_to < ps;
  const current = all.filter(r => !ended(r)), history = all.filter(ended).sort((a,b)=>String(b.effective_to).localeCompare(String(a.effective_to)));
  const row = (r, old) => { const el = elOrBlank(r.element_code);
    const state = old ? '<span class="chip c-grey">Ended</span>' : r.effective_from > pe ? `<span class="chip c-blue">Starts ${esc(r.effective_from)}</span>` : fixedActive(r,p) ? '<span class="chip c-green">Yes</span>' : '<span class="chip c-grey">No</span>';
    return `<tr${old?' style="opacity:.6"':''}><td class="mono">${r.element_code}</td><td class="strong">${esc(el.name_en||'?')}</td><td>${el.element_type==='Deduction'?'<span class="neg">Deduction</span>':'<span class="pos">Addition</span>'}</td>
      <td class="num">${fmt(r.amount)}${el.calc_method==='PercentOfBasic'?' %':''}</td><td class="mono">${esc(r.effective_from)}</td><td class="mono">${esc(r.effective_to||'—')}</td>
      <td>${state}</td><td><button class="icon-btn" data-del-fixed="${r.id}" title="Remove">🗑</button></td></tr>`; };
  const head = `<thead><tr><th>Code</th><th>Element</th><th>Type</th><th class="num">Amount</th><th>From</th><th>To</th><th>In period</th><th></th></tr></thead>`;
  box.innerHTML = `<div class="tbl-wrap"><table>${head}<tbody>
    ${current.map(r => row(r, false)).join('') || '<tr><td colspan="8" class="empty" style="padding:18px">No current fixed elements</td></tr>'}
    </tbody></table></div>
    ${history.length ? `<details style="margin-top:10px"><summary style="cursor:pointer;font-size:12px;color:var(--muted)">Previous amounts — history (${history.length}) · kept so earlier payrolls stay correct</summary>
      <div class="tbl-wrap" style="margin-top:6px"><table>${head}<tbody>${history.map(r => row(r, true)).join('')}</tbody></table></div></details>` : ''}
    <div class="grid3" style="margin-top:12px;align-items:end">
      <div class="field"><label>Element</label><select id="pk-el">${fixedEls.map(e=>`<option value="${e.code}">${e.code} · ${esc(e.name_en)}</option>`).join('')}</select></div>
      <div class="field"><label>Amount</label><input type="number" id="pk-amt"></div>
      <div class="field"><label>Effective from</label><input type="date" id="pk-from" value="${ps}"></div>
      <div class="field"><label>Effective to (optional)</label><input type="date" id="pk-to"></div>
      <div class="field"><button class="btn btn-ghost" id="pk-add">+ Add element</button></div>
    </div>`;
}

async function addPackageRow(){
  const code = num($('pk-el').value), amt = $('pk-amt').value, from = $('pk-from').value, to = $('pk-to').value;
  if (!code || amt==='' || !from) return toast('Element, amount and start date are required','warn');
  if ((elOrBlank(code)).is_basic) return openSalaryRequest(editingEmp, code, num(amt), from);   // basic salary → board approval
  const rec = { emp_id: editingEmp, element_code: code, amount: num(amt), effective_from: from, effective_to: to || null };
  const { data, error } = await sb.from('employee_salary_elements').insert(rec).select();
  if (error) return toast(error.message.includes('duplicate') ? 'This element already starts on that date for this employee' : error.message, 'err');
  if (!(data && data.length)) return toast(NOPERM,'err'); S.fixed.push(data[0]); renderPackage(); renderPayroll(); renderDashboard();
  const sv = data[0];   // 85: the database moves dates to whole pay cycles
  toast(sv.effective_from !== from || (to && sv.effective_to !== to)
    ? `Element added — salary changes apply to whole pay cycles, so it runs from ${sv.effective_from}${sv.effective_to ? ' to ' + sv.effective_to : ''}` : 'Element added');
}

async function saveEmp(){
  const rec = {};
  document.querySelectorAll('#emp-form [data-f]').forEach(/** @param {HTMLInputElement} el */ el => {
    const k = el.dataset.f; let v = /** @type {string | number | boolean | null} */ (el.value.trim());
    const def = EMP_FIELDS.flatMap(s=>s[1]).find(f=>f[0]===k);
    if (def && def[2]==='manager') v = v ? String(v).split(' — ')[0].trim() : null;
    else if (def && def[2]==='bool') v = (v==='Yes');
    else if (def && (def[2]==='date' || def[2]==='number') && v==='') v = null;
    else if (def && def[2]==='number') v = num(v);
    rec[k] = v;
  });
  if (!rec.id) return toast('Code is required','warn');
  if (!rec.name_ar && !rec.name_en) return toast('Enter an Arabic or English name','warn');
  rec.top_of_org = !!($('emp-top') && $('emp-top').checked);
  if (rec.top_of_org) rec.manager_id = null;
  const mgrBox = /** @type {HTMLInputElement} */ (document.querySelector('#emp-form [data-f="manager_id"]'));
  if (rec.manager_id && !empById(rec.manager_id)) { mgrBox.focus(); return toast(`Manager “${rec.manager_id}” not found — pick from the suggestions`,'warn'); }
  if (rec.manager_id && editingEmp && String(rec.manager_id)===String(editingEmp)) { mgrBox.focus(); return toast('An employee cannot be their own manager','warn'); }
  if (rec.manager_id && empById(rec.manager_id).status==='Inactive') { mgrBox.focus(); return toast('That manager is inactive — choose an active employee','warn'); }
  if (!editingEmp && !rec.manager_id && !rec.top_of_org) { mgrBox.focus(); mgrBox.scrollIntoView && mgrBox.scrollIntoView({block:'center'});
    return toast('Choose the new employee’s direct manager (or tick “Top of the organisation”)','warn'); }
  if (!editingEmp && empById(rec.id)) rec.id = nextEmpCode();
  const btn=$('emp-save'); btn.disabled=true; btn.textContent='Saving…';
  let res, bumped = false;
  if (editingEmp) res = await sb.from('employees').update(rec).eq('id', editingEmp).select();
  else {
    for (let attempt = 0; attempt < 4; attempt++){
      res = await sb.from('employees').insert(rec).select();
      if (!res.error || !/duplicate|already exists|23505/i.test(`${res.error.message} ${res.error.code||''}`)) break;
      // someone else took this code a moment ago — fetch the latest codes and take the next one
      const fresh = await fetchAll('employees','id'); rec.id = nextEmpCode(fresh.map(x=>String(x.id))); bumped = true;
    }
  }
  btn.disabled=false; btn.textContent='Save employee';
  const { data, error } = res;
  if (error) return toast(error.message.replace(/^.*?(This would create|An employee cannot)/,'$1'),'err');
  if (!(data && data.length)) return toast(NOPERM,'err');
  const i = S.employees.findIndex(e => String(e.id)===String(rec.id));
  if (i>=0) S.employees[i] = data[0]; else S.employees.push(data[0]);
  const wasNew = !editingEmp; editingEmp = rec.id;
  buildLists(); renderEmployees(); renderPayroll(); renderDashboard();
  toast(wasNew ? `Employee created with code ${rec.id}${bumped?' (the previous number had just been taken)':''} — you can now add salary elements below` : 'Employee saved');
  if (wasNew) openEmp(rec.id); else closeM('m-emp');
}

// ═════════════════════════════════════════════════════════
//  ATTENDANCE
// ═════════════════════════════════════════════════════════
// 92: when did the offline tap(s) of this line really reach the server (shown to HR before confirming the time)
function offlineSentNote(a, x){
  const hm = v => new Date(v).toLocaleTimeString('en-GB', { timeZone:'Africa/Cairo', hour:'2-digit', minute:'2-digit' });
  const hits = (S.clocks || []).filter(c => String(c.emp_id) === String(a.emp_id) && c.offline && c.local_date === a.date && (c.local_time === x.in || c.local_time === x.out) && c.received_at);
  return hits.map(c => ` ${c.event_type === 'out' ? 'Check-out' : 'Check-in'} ${c.local_time} reached the server at ${hm(c.received_at)}.`).join('');
}
function renderAttendance(){
  const q = $('att-q').value.trim().toLowerCase();
  const base = attRows().filter(a => (!attDayFilter || a.date===attDayFilter) && orgMatch(empById(a.emp_id),'att') &&
      (!q || [a.emp_id,a.emp_name].some(v=>String(v||'').toLowerCase().includes(q))));
  const st = stFill('att-status', base.map(a => a.status));
  const list = base.filter(a => !st || a.status===st)
    .sort((a,b)=> (b.date||'').localeCompare(a.date||''));
  const shown = list.slice(0,500);
  $('att-tbl').innerHTML = shown.map(a => `<tr class="click" data-att-edit="${a.id}">
    <td class="strong">${esc(a.emp_name||a.emp_id)} <span class="mono" style="color:var(--muted)">${esc(a.emp_id)}</span></td>
    <td class="mono">${esc(a.date)}${a.source==='Mobile'?' <span title="Recorded from the mobile app">📱</span>':a.source==='Machine'?' <span title="Imported from the HQ fingerprint machine">🖐</span>':a.source==='Combined'?' <span title="Phone and fingerprint machine combined: first punch to last punch">📱🖐</span>':''}${isHoliday(a.date)?' <span class="chip c-blue" title="Public holiday">Holiday</span>':''}</td><td class="mono">${esc(a.check_in||'—')}</td><td class="mono">${attNoOut(a) ? '<span class="neg" title="No check-out recorded — open the record and enter the time the employee left">⚠ missing</span>' : esc(a.check_out||'—')}</td>
    <td class="num">${attNoOut(a) ? '<span style="color:var(--muted)" title="Not calculated until the check-out is recorded or settled by HR">—</span>' : fmt(a.total_hours)}</td>
    <td style="white-space:normal">${(a.projects||[]).map(x=>x.missing ? `<span class="tag" style="border-color:rgba(217,79,79,.5);color:var(--danger)" title="Only one punch on the machine — add the missing time">⚠ ${esc(x.code || 'No project')} · ${esc(x.in)} · missing punch</span>`
      : x.review && x.why === 'offline' ? `<span class="tag" style="border-color:rgba(224,123,57,.5);color:var(--warn)" title="Tapped with no internet and sent late — the time comes from the phone.${offlineSentNote(a, x)} Check it, correct if needed, and save: until then this day has no deductions and no overtime">⚠ ${esc(x.code || 'No project')} · ${esc(x.in)}–${esc(x.out || '?')} · offline time to confirm</span>`
      : x.review ? `<span class="tag" style="border-color:rgba(224,123,57,.5);color:var(--warn)" title="More than 16 hours between first and last punch — check and correct">⚠ ${esc(x.code || 'No project')} · ${esc(x.in)}–${esc(x.out)} · ${fmt(x.hours)}h to check</span>`
      : x.forgotten ? `<span class="tag" style="border-color:rgba(217,79,79,.5);color:var(--danger)" title="Checked in from the phone but never checked out — open the record and enter the check-out time">⚠ ${esc(x.code || 'No project')} · ${esc(x.in)}–? missing check-out</span>`
      : !x.out && x.in && a.date < todayStr() ? `<span class="tag" style="border-color:rgba(217,79,79,.5);color:var(--danger)" title="No check-out recorded — open the record and enter the check-out time">⚠ ${esc(x.code || 'No project')} · ${esc(x.in)}–? missing check-out</span>`
      : !x.out && x.in ? `<span class="tag" style="border-color:rgba(34,197,160,.5);color:var(--accent2)">${esc(x.code || 'No project')} · ${esc(x.in)}–on site</span>`
      : `<span class="tag"${x.src==='Machine'?' title="Time recorded only by the fingerprint machine"':''}>${x.src==='Machine'?'🖐 ':''}${esc(x.code || 'No project')}${x.in?` · ${esc(x.in)}–${esc(x.out)}`:''} · ${fmt(x.hours)}h</span>`).join('')||'—'}</td>
    <td style="white-space:normal;min-width:120px">${mapLinks(a.emp_id, a.date)}</td>
    ${(()=>{ const r=dayRules(a, empById(a.emp_id)); if (r.exempt) return `<td class="num">—</td><td class="num" colspan="2" style="text-align:center"><span class="chip c-blue">Exception</span></td>`;
      const cellD=(net,raw)=> net ? `<span class="neg">${fmt(net)}</span>` : (raw ? `<span class="chip c-green" title="${fmt(raw)} h waived by approved permission">waived</span>` : '—');
      return `<td class="num">${r.ot?`<span style="color:var(--warn)">+${fmt(r.ot)}</span>`:'—'}</td><td class="num">${cellD(r.late,r.lateRaw)}</td><td class="num">${cellD(r.early,r.earlyRaw)}</td>`; })()}
    <td>${chip(a.status)}</td><td><button class="icon-btn" data-del-att="${a.id}">🗑</button></td></tr>`).join('')
    || '<tr><td colspan="12" class="empty">No attendance records for this selection</td></tr>';
  const rangeTxt = ATT_RANGE ? `${ATT_RANGE.from} → ${ATT_RANGE.to}` : 'Payroll cycle ' + periodLabel(settings.period);
  $('att-foot').textContent = `${attDayFilter ? 'Day '+attDayFilter : rangeTxt}: ${list.length.toLocaleString()} records${list.length>500?' (showing latest 500 — pick a day or search to narrow)':''}.`;
  $('att-range-note').textContent = ATT_RANGE ? '📅 Viewing past attendance — the payroll cycle is not changed' : '';
  if (!ATT_RANGE && !$('att-from').value){ $('att-from').value = periodStart(settings.period); $('att-to').value = periodEnd(settings.period); }
}

function toMin(t){ if(!t) return null; const [h,m]=String(t).split(':').map(Number); return h*60+m; }
function segHours(tin, tout){
  const a=toMin(tin), b=toMin(tout); if(a===null||b===null) return 0;
  let d=b-a; if(d<0) d+=1440; return Math.round(d/60*100)/100;
}
function addSplit(code='', tin='', tout=''){
  const rows=[...document.querySelectorAll('#a-splits .split')];
  const st = settings.shiftStart || '08:00';
  if (!tin) tin = rows.length ? (/** @type {HTMLInputElement} */ (rows[rows.length-1].querySelector('[data-s="out"]')).value || '') : st;
  if (!tout && !rows.length){ const m=(toMin(st)+Math.round(num(settings.hoursPerDay)*60))%1440; tout=`${pad(Math.floor(m/60))}:${pad(m%60)}`; }
  const d=document.createElement('div');
  d.className='split'; d.style='display:grid;grid-template-columns:1fr 104px 104px 58px 32px;gap:8px;margin-bottom:8px;align-items:center';
  d.innerHTML = `<input class="inp" style="width:100%" list="dl-proj" data-s="proj" placeholder="Type project code or name…" value="${esc(code)}">
    <input class="inp" style="width:100%" type="time" data-s="in" value="${esc(tin)}">
    <input class="inp" style="width:100%" type="time" data-s="out" value="${esc(tout)}">
    <span class="mono" data-s="hrs" style="text-align:right;color:var(--text)">—</span>
    <button class="icon-btn" data-rm-split title="Remove line">🗑</button>`;
  $('a-splits').appendChild(d); checkSplits();
}
function readSplits(){
  return [...document.querySelectorAll('#a-splits .split')].map(r => ({
    row:r, proj:/** @type {HTMLInputElement} */ (r.querySelector('[data-s="proj"]')).value.trim(),
    tin:/** @type {HTMLInputElement} */ (r.querySelector('[data-s="in"]')).value, tout:/** @type {HTMLInputElement} */ (r.querySelector('[data-s="out"]')).value }));
}
function checkSplits(){
  const L=readSplits(), msgs=[]; let total=0;
  L.forEach(l => { const h=segHours(l.tin,l.tout); l.row.querySelector('[data-s="hrs"]').textContent = h ? fmt(h) : '—'; total+=h; });
  const timed = L.filter(l=>l.tin&&l.tout).map(l=>({...l,a:toMin(l.tin),b:toMin(l.tout)})).filter(l=>l.b>l.a).sort((x,y)=>x.a-y.a);
  L.filter(l => l.tin && !l.tout).forEach(l => msgs.push(`<span class="neg">⚠ ${esc(l.proj || 'No project')} from ${esc(l.tin)} has no check-out — enter the time the employee left, then Save. The day's hours are not counted until then.</span>`));
  for (let i=1;i<timed.length;i++) if (timed[i].a < timed[i-1].b) msgs.push(`<span class="neg">⚠ ${timed[i-1].tin}–${timed[i-1].tout} overlaps ${timed[i].tin}–${timed[i].tout}</span>`);
  const first = timed.length ? timed[0].tin : '', last = timed.length ? timed.reduce((m,l)=>l.b>toMin(m)?l.tout:m, timed[0].tout) : '';
  const emp = empById(parseEmpInput($('a-emp').value));
  const R = dayRules({ status:$('a-status').value, total_hours:total, check_in:first, date:$('a-date').value, emp_id: emp?emp.id:null }, emp);
  const extra = Math.max(0, total - num(settings.hoursPerDay));
  const lv = emp ? leaveOn(emp.id, $('a-date').value) : null, hol = holidayOn($('a-date').value);
  $('a-check').innerHTML = (hol ? `<div class="alert a-info" style="margin:0 0 8px">📅 <b>${esc(hol.name)}</b> is a public holiday. Working today earns ${num(settings.holidayExtraDays)||1} extra day's pay; no late/early deduction applies.</div>` : '') + (lv ? `<div class="alert a-warn" style="margin:0 0 8px">🌴 ${esc(empName(emp))} is on <b>${esc(lv.leave_type)}</b> leave ${esc(lv.date_from)} → ${esc(lv.date_to)}. No late/early deduction applies on this day.</div>` : '') + (L.length ? `<b style="color:var(--text)">${fmt(total)} h</b> across ${L.length} line${L.length>1?'s':''}` +
      (first ? ` · day check-in <b>${first}</b>, check-out <b>${last}</b>` : '') +
      (R.exempt ? ` · <span class="chip c-blue">Exception rule — no overtime or delay</span>`
        : (R.ot ? ` · <span style="color:var(--warn)">overtime ${fmt(R.ot)} h</span>` : (extra>0 ? ` · ${fmt(extra)} h extra (below the ${fmt(settings.otThreshold)} h overtime minimum)` : '')) +
          (R.late ? ` · <span class="neg">late ${fmt(R.late)} h</span>` : '') +
          (R.early ? ` · <span class="neg">early/short ${fmt(R.early)} h</span>` : '') +
          (R.waived ? ` · <span class="pos">${fmt(R.waived)} h waived by approved permission</span>` : '')) : '') + (msgs.length ? '<br>'+msgs.join('<br>') : '');
}
function toggleWork(){ const s=$('a-status').value; $('a-work').style.display = (s==='Present'||s==='Half Day') ? 'block' : 'none'; }
let editingAtt = null;
function openAtt(rec){
  editingAtt = rec ? rec.id : null;
  $('a-title').textContent = rec ? 'Edit attendance' : 'Log attendance';
  const e = rec ? empById(rec.emp_id) : null;
  $('a-emp').value = rec ? `${rec.emp_id} — ${empName(e) || rec.emp_name || ''}` : '';
  $('a-date').value = rec ? rec.date : todayStr();
  $('a-status').value = rec ? (rec.status||'Present') : 'Present';
  $('a-notes').value = rec ? (rec.notes||'') : '';
  $('a-splits').innerHTML='';
  if (rec && (rec.projects||[]).length){
    rec.projects.forEach(x => addSplit(projLabel(x.code), x.in || '', x.out || ''));
    // legacy records stored hours only: keep the day's times on a single line
    if (rec.projects.length===1 && !rec.projects[0].in){ const r=$('a-splits').querySelector('.split');
      r.querySelector('[data-s="in"]').value = rec.check_in||''; r.querySelector('[data-s="out"]').value = rec.check_out||''; }
  } else addSplit();
  toggleWork(); checkSplits(); openM('m-att'); if(!rec) setTimeout(()=>$('a-emp').focus(),50);
}
async function saveAtt(){
  const empId = parseEmpInput($('a-emp').value);
  if (!empId) return toast('Pick an employee from the list','warn');
  const date = $('a-date').value; if(!date) return toast('Date is required','warn');
  const status=$('a-status').value, working = status==='Present'||status==='Half Day';
  let segs=[]; const empRec = empById(empId);
  if (working){
    for (const l of readSplits()){
      if (!l.proj && !l.tin && !l.tout) continue;
      const code = (!l.proj && empRec && !empRec.project_staff) ? '' : parseProjInput(l.proj);
      if (code === null) return toast(l.proj ? `"${l.proj}" is not a valid project — pick it from the suggestions` : 'Every line needs a project (site staff must always work at a project)','warn');
      if (!l.tin || !l.tout) return toast(`Enter both check-in and check-out for ${code || 'the no-project line'}`,'warn');
      const h=segHours(l.tin,l.tout); if (!h) return toast(`Check-out must be after check-in for ${code || 'the no-project line'}`,'warn');
      segs.push({ code, in:l.tin, out:l.tout, hours:h });
    }
    if (!segs.length) return toast('Add at least one project line with times','warn');
    const s=[...segs].sort((x,y)=>toMin(x.in)-toMin(y.in));
    for (let i=1;i<s.length;i++) if (toMin(s[i].in) < toMin(s[i-1].out) && toMin(s[i-1].out) > toMin(s[i-1].in))
      return toast(`${s[i-1].code} ${s[i-1].in}–${s[i-1].out} overlaps ${s[i].code} ${s[i].in}–${s[i].out}`,'warn');
  }
  if (!editingAtt){
    const dup = S.attendance.find(a => String(a.emp_id)===empId && a.date===date);
    if (dup && !confirm(`${empId} already has a record on ${date}. Save a second one anyway?`)) return;
  }
  const total = segs.reduce((t,x)=>t+x.hours,0);
  const sorted=[...segs].sort((x,y)=>toMin(x.in)-toMin(y.in));
  const e = empById(empId);
  const rec = { emp_id:empId, emp_name:empName(e), date, status, projects:segs, notes:$('a-notes').value.trim(),
    check_in: sorted.length ? sorted[0].in : null,
    check_out: sorted.length ? sorted.reduce((m,x)=>toMin(x.out)>toMin(m)?x.out:m, sorted[0].out) : null,
    total_hours: Math.round(total*100)/100, ot_hours: 0 };
  rec.ot_hours = dayRules(rec, e).ot;
  const btn=$('a-save'); btn.disabled=true;
  const res = editingAtt ? await sb.from('attendance').update(rec).eq('id',editingAtt).select()
                         : await sb.from('attendance').insert(rec).select();
  btn.disabled=false;
  if (res.error) return toast(res.error.message,'err');
  if (!(res.data && res.data.length)) return toast(NOPERM,'err'); 
  const saved=res.data[0], inPeriod = date>=periodStart(settings.period) && date<=periodEnd(settings.period);
  S.attendance = S.attendance.filter(a=>a.id!==saved.id); if (inPeriod) S.attendance.push(saved);
  if (ATT_RANGE){ ATT_RANGE.rows = ATT_RANGE.rows.filter(a=>a.id!==saved.id); if (date>=ATT_RANGE.from && date<=ATT_RANGE.to) ATT_RANGE.rows.push(saved); }
  closeM('m-att'); renderAttendance(); renderDashboard(); renderPayroll(); renderReports();
  toast(editingAtt ? 'Attendance updated' : 'Attendance saved');
}

$('a-date').addEventListener('change', checkSplits);

// ═════════════════════════════════════════════════════════
//  PROJECTS
// ═════════════════════════════════════════════════════════
function renderProjects(){
  const q=$('proj-q').value.trim().toLowerCase();
  const base = q ? S.projects.filter(p=>[p.id,p.name,p.client,p.location].some(v=>String(v||'').toLowerCase().includes(q))) : S.projects;
  const st = stFill('proj-status', base.map(p => p.status));
  const list = st ? base.filter(p => p.status===st) : base;
  const shown = list.slice(0,300);
  $('proj-sub').textContent = `${S.projects.length.toLocaleString()} records loaded`;
  $('proj-tbl').innerHTML = shown.map(p=>`<tr><td class="mono">${esc(p.id)}</td><td class="strong" ${/[\u0600-\u06FF]/.test(p.name||'')?'dir="rtl"':''}>${esc(p.name)}</td>
    <td>${esc(p.client)}</td><td>${esc(p.country)}</td><td>${esc(p.location||'—')}</td><td>${chip(p.status)}</td>
    <td><button class="icon-btn" data-del-proj="${esc(p.id)}">🗑</button></td></tr>`).join('') || '<tr><td colspan="7" class="empty">No match</td></tr>';
  $('proj-foot').textContent = `${list.length.toLocaleString()} match${list.length===1?'':'es'}${list.length>300?' — showing first 300, refine your search to narrow':''}.`;
}
async function saveProj(){
  const id=$('p-id').value.trim(), name=$('p-name').value.trim();
  if(!id||!name) return toast('Code and name are required','warn');
  if(S.projects.find(p=>String(p.id)===id)) return toast('That code already exists','warn');
  const rec={ id, name, client:$('p-client').value.trim(), country:$('p-country').value, location:$('p-loc').value.trim(), start_date:$('p-start').value||null, status:'Active' };
  const { data, error } = await sb.from('projects').insert(rec).select();
  if(error) return toast(error.message,'err');
  if (!(data && data.length)) return toast(NOPERM,'err'); S.projects.push(data[0]); buildLists(); renderProjects(); closeM('m-proj'); toast('Project created');
  ['p-id','p-name','p-client','p-loc','p-start'].forEach(i=>$(i).value='');
}

// ═════════════════════════════════════════════════════════
//  MONTHLY ENTRIES  (one or more project lines per employee)
// ═════════════════════════════════════════════════════════
function projLabel(code){ if(!code) return ''; const p=S.projects.find(x=>String(x.id)===String(code)); return p ? `${p.id} — ${p.name||''}` : String(code); }
function resetMonthly(){ monLines={}; monDirty=new Set(); monEl=null; }
function buildMonLines(code){
  monLines = {}; monDirty = new Set(); monEl = code;
  S.monthly.filter(m=>num(m.element_code)===code).forEach(m => {
    (monLines[m.emp_id] = monLines[m.emp_id] || []).push({ project: projLabel(m.project_code), amount: String(m.amount ?? '') });
  });
}
function linesFor(empId){ return monLines[empId] || [{ project:'', amount:'' }]; }
function monUpdateFooter(){
  const code=num($('mon-el').value);
  const saved = S.monthly.filter(m=>num(m.element_code)===code);
  const total = saved.reduce((s,m)=>s+num(m.amount),0);
  const n = monDirty.size;
  const emps = new Set(saved.map(m=>String(m.emp_id))).size;
  $('mon-foot').innerHTML = `Period <b>${periodLabel(settings.period)}</b> · ${emps} employee${emps===1?'':'s'} · ${saved.length} saved line${saved.length===1?'':'s'} · total ${fmt(total)} EGP`
    + (n ? ` · <span style="color:var(--warn)">unsaved changes for ${n} employee${n>1?'s':''}</span>` : '');
  $('mon-save').textContent = n ? `Save changes (${n})` : 'Save changes';
}
let MON_MODE = 'emp', MON_PROJ = '';            // 'emp' = by employee (all lines), 'proj' = one project's line per employee
const lineProj = ln => parseProjInput(ln.project) || (String(ln.project||'').trim()==='' ? '' : null);
function projDays(empId, code){ return new Set(S.attendance.filter(a => String(a.emp_id)===String(empId) && (a.projects||[]).some(x => x.code===code)).map(a => a.date)).size; }
function renderMonthly(){ if (MON_MODE==='proj') return renderMonthlyByProject();
  const code = num($('mon-el').value), q=$('mon-q').value.trim().toLowerCase(), d=$('mon-dept').value;
  if (!code){ $('mon-tbl').innerHTML='<tr><td colspan="7" class="empty">No variable elements yet — click “+ New variable element”</td></tr>'; monUpdateFooter(); return; }
  if (monEl !== code) buildMonLines(code);
  const el = elByCode(code) || {};
  const list = Object.keys(monLines).filter(id => monLines[id].length).map(id => empById(id) || { id, name_en:'(unknown employee)' })
    .filter(e => orgMatch(e,'mon') && (!q || [e.id,e.name_ar,e.name_en].some(v=>String(v||'').toLowerCase().includes(q))))
    .sort((a,b)=>String(a.id).localeCompare(String(b.id),undefined,{numeric:true}));
  $('mon-tbl').innerHTML = list.map(e => {
    const L = monLines[e.id], id = esc(e.id);
    return L.map((ln,i) => `<tr${i?' style="background:rgba(59,111,212,.04)"':''}>
      ${i===0 ? `<td class="mono">${id}</td><td class="ar">${esc(e.name_ar)}</td><td class="strong">${esc(e.name_en)}</td><td>${esc(e.department)}</td>`
              : `<td></td><td></td><td style="color:var(--muted);font-size:12px">↳ split line ${i+1}</td><td></td>`}
      <td><input class="inp" style="width:260px" list="dl-proj" placeholder="Project (optional)…" data-me="${id}" data-mi="${i}" data-mf="p" value="${esc(ln.project)}"></td>
      <td class="num"><input class="inp" style="width:120px;text-align:right" type="number" step="0.01" data-me="${id}" data-mi="${i}" data-mf="a" value="${esc(ln.amount)}"></td>
      <td style="white-space:nowrap">${i===0?`<button class="btn btn-ghost btn-sm" data-mon-add="${id}" title="Split across another project">+ Project</button> `:''}<button class="icon-btn" data-mon-rm="${id}" data-mi="${i}" title="${L.length===1?'Remove this employee':'Remove this line'}">🗑</button></td></tr>`).join('');
  }).join('') || `<tr><td colspan="7" class="empty">No ${el.element_type==='Deduction'?'deductions':'amounts'} entered for “${esc(el.name_en||'')}” this period.<br>Type an employee code or name in the box above and click <b>+ Add employee</b>.</td></tr>`;
  monUpdateFooter();
}
function monAddEmployee(){
  const id = parseEmpInput($('mon-pick').value);
  if (!id) return toast('Pick an employee from the suggestions','warn');
  if (!onPayroll(empById(id), settings.period)) return toast(`${id} is not on the ${settings.period} payroll`,'warn');
  if (MON_MODE==='proj'){ if (!MON_PROJ) return toast('Choose the project first','warn'); monEnsureProjLine(id); }
  else if (!(monLines[id] && monLines[id].length)) monLines[id] = [{ project:'', amount:'' }];
  $('mon-pick').value=''; $('mon-q').value=''; $('mon-dept').value='';
  renderMonthly();
  const inp = document.querySelector(`[data-me="${String(id).replace(/["\\]/g,'\\$&')}"][data-mf="a"]`); if (inp) { inp.focus(); if (inp.scrollIntoView) inp.scrollIntoView({block:'center'}); }
}
function monInput(el){
  const emp=el.dataset.me, i=num(el.dataset.mi), f=el.dataset.mf;
  if (!monLines[emp]) monLines[emp] = [{ project:'', amount:'' }];
  monLines[emp][i][f==='p'?'project':'amount'] = el.value;
  monDirty.add(emp); monUpdateFooter();
}
function monAddLine(emp){ monLines[emp] = linesFor(emp).slice(); monLines[emp].push({ project:'', amount:'' }); monDirty.add(emp); renderMonthly(); }
function monRemoveLine(emp,i){ monLines[emp] = (monLines[emp]||[]).filter((_,k)=>k!==i); monDirty.add(emp); renderMonthly(); }
function onMonElementChange(){
  if (monDirty.size && !confirm('You have unsaved changes for this element. Discard them?')){ $('mon-el').value = monEl; return; }
  $('mon-pick').value='';
  resetMonthly(); renderMonthly();
}
async function saveMonthly(){
  if (!monDirty.size) return toast('No changes to save','warn');
  const code = num($('mon-el').value), emps=[...monDirty], rows=[], problems=[];
  emps.forEach(emp => {
    const seen = new Set();
    linesFor(emp).forEach((ln,i) => {
      const amt = String(ln.amount).trim(), ptxt = String(ln.project).trim();
      if (amt==='' && ptxt==='') return;
      if (amt==='') { if (MON_MODE==='proj') return; return problems.push(`${emp}: line ${i+1} has a project but no amount`); }   // by project: empty = no allowance
      let pcode = null;
      if (ptxt){ pcode = parseProjInput(ptxt); if(!pcode) return problems.push(`${emp}: "${ptxt}" is not a valid project — pick it from the suggestions`); }
      const key = pcode || '(none)';
      if (seen.has(key)) return problems.push(`${emp}: the same project appears twice`);
      seen.add(key);
      rows.push({ emp_id:emp, element_code:code, period:settings.period, project_code:pcode, amount:num(amt) });
    });
  });
  if (problems.length) return toast(problems.slice(0,2).join(' · ') + (problems.length>2?` (+${problems.length-2} more)`:''),'warn');
  const btn=$('mon-save'); btn.disabled=true; btn.textContent='Saving…';
  try{
    // replace each changed employee's lines for this element and period
    await chunked(emps, ids => sb.from('payroll_period_elements').delete().eq('element_code',code).eq('period',settings.period).in('emp_id',ids), 200);
    if (rows.length) await chunked(rows, r => sb.from('payroll_period_elements').insert(r));
    S.monthly = await fetchAll('payroll_period_elements','emp_id', q=>q.eq('period',settings.period));
    resetMonthly(); renderMonthly(); renderPayroll(); renderDashboard();
    toast(`Saved ${rows.length} line${rows.length===1?'':'s'} for ${emps.length} employee${emps.length===1?'':'s'}`);
  }catch(e){ toast(e.message,'err'); }
  btn.disabled=false; monUpdateFooter();
}

// ═════════════════════════════════════════════════════════
//  LOANS
// ═════════════════════════════════════════════════════════
function renderLoans(){
  const p=settings.period;
  const out = S.loans.reduce((s,l)=>s+Math.max(0,num(l.loan_amount)-num(l.amount_settled)),0);
  const thisP = S.loans.reduce((s,l)=>s+loanInstalment(l,p),0);
  $('loan-sub').textContent = `${S.loans.length} loans · outstanding ${fmt(out)} EGP · deducting ${fmt(thisP)} EGP in ${p}`;
  const q = ($('loan-q').value||'').trim().toLowerCase();
  const base = S.loans.filter(l => { const e=empById(l.emp_id)||{};
    return orgMatch(e,'loan') && (!q || [l.emp_id, e.name_en, e.name_ar, l.reference].some(v=>String(v||'').toLowerCase().includes(q))); });
  const st = stFill('loan-status', base.map(l => l.status));
  const list = base.filter(l => !st || l.status===st);
  $('loan-foot').textContent = `${list.length} of ${S.loans.length} loan${S.loans.length===1?'':'s'} shown` + (list.length ? ` · outstanding ${fmt(list.reduce((s,l)=>s+Math.max(0,num(l.loan_amount)-num(l.amount_settled)),0))} EGP · this period ${fmt(list.reduce((s,l)=>s+loanInstalment(l,p),0))} EGP` : '');
  $('loan-tbl').innerHTML = list.map(l => { const e=empById(l.emp_id); const inst=loanInstalment(l,p);
    return `<tr><td class="strong">${esc(empName(e)||l.emp_id)} <span class="mono" style="color:var(--muted)">${esc(l.emp_id)}</span></td>
      <td class="mono">${esc(l.reference||'—')}</td><td class="num">${fmt(l.loan_amount)}</td><td class="num">${esc(l.periods)}</td>
      <td class="num">${fmt(l.installment)}</td><td class="mono">${esc(l.start_period)}${loanEndCell(l)}</td><td class="num">${fmt(l.amount_settled)}</td>
      <td class="num">${fmt(num(l.loan_amount)-num(l.amount_settled))}</td>
      <td>${inst?`<span class="chip c-orange">−${fmt(inst)}</span>`:'<span class="chip c-grey">none</span>'}</td>
      <td>${chip(l.status)}</td><td style="white-space:nowrap">${l.status==='Active'?`<button class="icon-btn" data-lpp="${l.id}" title="Postpone an instalment">⏸️</button>`:''}<button class="icon-btn" data-del-loan="${l.id}">🗑</button></td></tr>`; }).join('')
    || `<tr><td colspan="11" class="empty">${S.loans.length ? 'No loans for this selection' : 'No loans recorded'}</td></tr>`;
}
// "ends 2027-03" under the first deduction month, plus one chip per postponed month (✕ = undo)
function loanEndCell(l){
  const pp = (Array.isArray(l.postponed)?l.postponed:[]).slice().sort();
  const end = loanEnd(l);
  return (end ? `<div style="font-size:11px;color:var(--muted)">ends ${esc(end)}</div>` : '') +
    pp.map(m => `<span class="chip c-blue lpp-chip" title="Instalment postponed — not deducted in ${esc(m)}">⏸️ ${esc(m)}<button data-lpp-undo="${esc(l.id)}|${esc(m)}" title="Undo: deduct in ${esc(m)} again">✕</button></span>`).join('');
}
let LPP = null;
function approvedPeriods(){ return new Set((S.runs||[]).map(r => r.period)); }
function openLoanPostpone(id){
  const l = S.loans.find(x => String(x.id) === String(id)); if (!l) return;
  const e = empById(l.emp_id), done = approvedPeriods(), from = periodIdx(settings.period), opts = [];
  for (let i = from; i < from + 36 && opts.length < 18; i++){
    const p = `${Math.floor(i/12)}-${pad(i%12+1)}`;
    if (!done.has(p) && loanDue(l, i)) opts.push(p);
  }
  if (!opts.length) return toast('This loan has no instalment left to postpone from '+settings.period+' onwards','warn');
  LPP = l;
  $('lpp-info').innerHTML = `<b>${esc(empName(e)||l.emp_id)}</b> <span class="mono" style="color:var(--muted)">${esc(l.emp_id)}</span> · loan ${fmt(l.loan_amount)} EGP · instalment ${fmt(loanInstalment(l, opts[0]))} EGP`;
  $('lpp-month').innerHTML = opts.map(p => `<option value="${p}">${p}${p===settings.period?' (this payroll)':''}</option>`).join('');
  $('lpp-note').value = '';
  lppPreview(); openM('m-lpp');
}
function lppPreview(){
  if (!LPP) return;
  const m = $('lpp-month').value, before = loanEnd(LPP), after = loanEnd({ ...LPP, postponed:[...(LPP.postponed||[]), m] });
  $('lpp-preview').textContent = `No deduction in ${m}. The instalment amount stays the same; the last instalment moves from ${before} to ${after}.`;
}
async function refreshLoan(id){
  const { data } = await sb.from('employee_loans').select('*').eq('id', id);
  if (data && data[0]) S.loans = S.loans.map(x => String(x.id) === String(id) ? data[0] : x);
  renderLoans(); renderPayroll(); renderDashboard();
}
async function saveLoanPostpone(){
  if (!LPP) return;
  const note = $('lpp-note').value.trim();
  if (!note) return toast('Write who approved the postponement','warn');
  const m = $('lpp-month').value;
  const { data, error } = await sb.rpc('postpone_loan_instalment', { p_loan: LPP.id, p_period: m, p_note: note });
  if (error) return toast(error.message,'err');
  closeM('m-lpp'); await refreshLoan(LPP.id);
  toast(`Postponed: no deduction in ${m}. The loan now ends ${data||loanEnd(LPP)}.`);
}
function undoLoanPostpone(key){
  const [id, m] = key.split('|');
  confirmDel(`Undo the postponement? The instalment will be deducted in ${m} again.`, async () => {
    const { error } = await sb.rpc('undo_loan_postponement', { p_loan: id, p_period: m });
    if (error) throw error;
    await refreshLoan(id); toast(`${m} will be deducted again`);
  });
  $('del-title').textContent = 'Undo postponement'; $('del-ok').textContent = 'Undo'; $('del-ok').className = 'btn btn-primary';
}
function loanPreview(){
  const a=num($('l-amt').value), n=num($('l-per').value), s=$('l-start').value;
  if(!a||!n||!s){ $('l-preview').textContent=''; return; }
  const endI = periodIdx(s)+n-1, y=Math.floor(endI/12), m=endI%12+1;
  $('l-preview').textContent = `Instalment ${fmt(a/n)} EGP per month, from ${s} to ${y}-${pad(m)}.`;
}
async function saveLoan(){
  const empId=parseEmpInput($('l-emp').value); if(!empId) return toast('Pick an employee from the list','warn');
  const a=num($('l-amt').value), n=num($('l-per').value), s=$('l-start').value;
  if(!a||!n||!s) return toast('Amount, months and first deduction month are required','warn');
  const rec={ emp_id:empId, loan_amount:a, periods:n, start_period:s, amount_settled:num($('l-set').value), reference:$('l-ref').value.trim(), status:'Active' };
  const { data, error } = await sb.from('employee_loans').insert(rec).select();
  if(error) return toast(error.message,'err');
  if (!(data && data.length)) return toast(NOPERM,'err'); S.loans.push(data[0]); closeM('m-loan'); renderLoans(); renderPayroll(); renderDashboard(); toast('Loan saved');
}

// ═════════════════════════════════════════════════════════
//  PAYROLL RUN
// ═════════════════════════════════════════════════════════
let lastRun = [];
function renderPayroll(){
  lastRun = computeAll();
  const q=$('pay-q').value.trim().toLowerCase(), d=$('pay-dept').value;
  const list = lastRun.filter(r => orgMatch(r.emp,'pay') && (!q||[r.emp.id,r.emp.name_ar,r.emp.name_en].some(v=>String(v||'').toLowerCase().includes(q))));
  const T = k => lastRun.reduce((s,r)=>s+r[k],0);
  const noPkg = lastRun.filter(r=>!r.hasPackage).length;
  const pj=lastRun.filter(r=>r.joiner).length, pl=lastRun.filter(r=>r.leaver).length;
  $('pay-sub').textContent = `Period ${periodLabel(settings.period)} · ${lastRun.length} employees on payroll${pj?` · ${pj} joiner${pj>1?'s':''}`:''}${pl?` · ${pl} leaver${pl>1?'s':''}`:''}`;
  const run = currentRun();
  $('pay-status').innerHTML = run
    ? `<div class="alert a-info" style="border-color:rgba(34,197,160,.4);background:rgba(34,197,160,.08);color:var(--accent2)">🔒 <b>Approved and locked</b> on ${esc(String(run.approved_at).slice(0,16).replace('T',' '))} by <b>${esc(run.approved_by)}</b>. These are the permanent approved figures — they are read from the payroll history and will never be recalculated.</div>`
    : '';
  $('pay-approve').style.display = run ? 'none' : '';
  $('pay-note').style.display = run ? 'none' : '';
  $('pay-note').innerHTML = (noPkg ? `<b>${noPkg} of ${lastRun.length}</b> active employees have no fixed salary elements yet — their pay shows as zero until you import or add their package. ` : '')
    + `Salary changes apply to whole pay cycles (the package in force on the cycle's last day). Joiners and leavers: fixed additions are reduced by the days not employed ÷ ${num(settings.daysPerMonth)||30}. A past working day with no attendance, leave or mission is an absent day${/^\d{4}-\d{2}-\d{2}$/.test(String(settings.autoAbsentFrom||'')) ? ' (counted from ' + esc(settings.autoAbsentFrom) + ')' : ''}; weekends are never deducted. Unpaid leave is deducted per calendar day. Overtime: hours beyond ${settings.hoursPerDay} a day, only when at least ${settings.otThreshold} h, paid at ${settings.otMultiplier}× hour pay. Late (after ${settings.lateAfter}) and early/short hours are each deducted at delay hour pay, less up to ${settings.permissionMaxHours} h per approved permission (${settings.permissionsPerMonth} a month). Exception employees get no overtime and no deductions. Penalties are not yet captured and show as zero. Payroll taxes are not calculated.`;
  $('pay-stats').innerHTML = [['Gross',T('gross')],['Social insurance',T('si')],['Loans',T('loans')],['Other deductions',T('otherDed')],['Net payroll',T('net')]]
    .map(([l,v])=>`<div class="stat"><div class="stat-label">${l}</div><div class="stat-value" style="font-size:19px">${fmt(v)}</div></div>`).join('');
  renderPayTable(list);     // part32.js: compact / expanded view + per-column search
}
function openSlip(id){
  const r = lastRun.find(x=>String(x.emp.id)===String(id)) || computeEmployee(empById(id));
  $('slip-title').textContent = `${empName(r.emp)} — ${periodLabel(settings.period)}`;
  const line = l => `<div class="pay-line"><span>${l.code!==0?`<span class="mono" style="color:var(--muted)">${l.code}</span> `:''}${esc(l.name)}${l.note?`<div style="font-size:11px;color:var(--muted)">${esc(l.note)}</div>`:''}</span><span class="mono ${l.type==='Deduction'?'neg':'pos'}">${l.type==='Deduction'?'−':''}${fmt(l.amount)}</span></div>`;
  const adds=r.lines.filter(l=>l.type==='Addition'), deds=r.lines.filter(l=>l.type==='Deduction');
  $('slip-body').innerHTML = `
    <div style="font-size:12px;color:var(--muted);margin-bottom:14px">${esc(r.emp.name_ar||'')} · ${esc(r.emp.department||'')} · ${esc(r.emp.unit||'')} · ${esc(r.emp.entity||'')}</div>
    <div class="sec">Additions</div>${adds.map(line).join('')||'<div style="color:var(--muted);font-size:12px">None</div>'}
    <div class="pay-line total"><span>Gross</span><span class="mono">${fmt(r.gross)}</span></div>
    <div class="sec">Deductions</div>${deds.map(line).join('')||'<div style="color:var(--muted);font-size:12px">None</div>'}
    <div class="pay-line total"><span>Total deductions</span><span class="mono neg">${fmt(r.ded)}</span></div>
    <div class="pay-line total" style="font-size:16px"><span>Net pay</span><span class="mono pos">${fmt(r.net)} EGP</span></div>`;
  openM('m-slip');
}
function exportPayroll(){ exportRunCsv(lastRun.length ? lastRun : computeAll(), settings.period); }

// ── new variable element ──
function openNewVar(){
  const next = Math.max(0, ...S.elements.map(e=>num(e.code))) + 1;
  $('vr-code').value=next; $('vr-type').value='Addition'; $('vr-en').value=''; $('vr-ar').value=''; $('vr-tax').value='true'; $('vr-ins').value='false'; $('vr-notes').value='';
  openM('m-var'); setTimeout(()=>$('vr-en').focus(),50);
}
async function saveNewVar(){
  const code=num($('vr-code').value), en=$('vr-en').value.trim(), type=$('vr-type').value;
  if (!code || code<1) return toast('Enter a code number','warn');
  if (elByCode(code)) return toast(`Code ${code} is already used by “${elByCode(code).name_en}”`,'warn');
  if (!en) return toast('Enter the English name','warn');
  if (S.elements.some(e=>String(e.name_en).trim().toLowerCase()===en.toLowerCase())) return toast('An element with this name already exists','warn');
  const rec = { code, name_en:en, name_ar:$('vr-ar').value.trim()||null, element_type:type, input_method:'Monthly', calc_method:'Amount', is_basic:false,
                taxable:$('vr-tax').value==='true', insurable:$('vr-ins').value==='true', active:true, sort_order: type==='Addition' ? 8 : 30, notes:$('vr-notes').value.trim()||null };
  const b=$('vr-save'); b.disabled=true;
  const { data, error } = await sb.from('salary_elements').insert(rec).select();
  b.disabled=false;
  if (error) return toast(/duplicate/i.test(error.message) ? `Code ${code} is already used` : error.message, 'err');
  if (!(data && data.length)) return toast(NOPERM,'err');
  S.elements.push(data[0]); buildLists(); $('mon-el').value = code; resetMonthly(); renderMonthly();
  closeM('m-var'); toast(`“${en}” created as a variable ${type==='Addition'?'addition':'deduction'} — now add the employees`);
  setTimeout(()=>$('mon-pick').focus(),50);
}
$('mon-add-btn').addEventListener('click', monAddEmployee);
$('mon-pick').addEventListener('keydown', e => { if (e.key==='Enter') monAddEmployee(); });
$('vr-type').addEventListener('change', () => { $('vr-tax').value = $('vr-type').value==='Addition' ? 'true' : 'false'; });
$('vr-save').addEventListener('click', saveNewVar);

// ── By project: pick one project, list every employee with a line for it, one amount each ──
function renderMonthlyByProject(){
  const code = num($('mon-el').value), q=$('mon-q').value.trim().toLowerCase(), d=$('mon-dept').value;
  if (!code){ $('mon-tbl').innerHTML='<tr><td colspan="7" class="empty">No variable elements yet — click “+ New variable element”</td></tr>'; monUpdateFooter(); return; }
  if (monEl !== code) buildMonLines(code);
  if (!MON_PROJ){ $('mon-tbl').innerHTML='<tr><td colspan="7" class="empty">Choose the project above to see and enter the amounts for its employees.</td></tr>'; monUpdateFooter(); return; }
  const rows = [];
  Object.entries(monLines).forEach(([id, L]) => L.forEach((ln, i) => { if (lineProj(ln) === MON_PROJ) rows.push({ id, i, ln, e: empById(id) || { id, name_en:'(unknown)' } }); }));
  const shown = rows.filter(r => orgMatch(r.e,'mon') && (!q || [r.e.id, r.e.name_ar, r.e.name_en].some(v => String(v||'').toLowerCase().includes(q))))
                    .sort((a,b) => String(a.id).localeCompare(String(b.id), undefined, { numeric:true }));
  const total = shown.reduce((s,r) => s + num(r.ln.amount), 0);
  $('mon-tbl').innerHTML = shown.map(r => `<tr><td class="mono">${esc(r.id)}</td><td class="ar">${esc(r.e.name_ar)}</td><td class="strong">${esc(r.e.name_en)}</td><td>${esc(r.e.department)}</td>
      <td style="color:var(--label);font-size:12px">${esc(projLabel(MON_PROJ))} · <b>${projDays(r.id, MON_PROJ)}</b> day(s) worked here this cycle</td>
      <td class="num"><input class="inp" style="width:120px;text-align:right" type="number" step="0.01" data-me="${esc(r.id)}" data-mi="${r.i}" data-mf="a" value="${esc(r.ln.amount)}"></td>
      <td><button class="icon-btn" data-mon-rm="${esc(r.id)}" data-mi="${r.i}" title="Remove this employee from the project">🗑</button></td></tr>`).join('')
    || `<tr><td colspan="7" class="empty">No one has an amount for ${esc(projLabel(MON_PROJ))} yet. Add employees one by one above, or click <b>+ Everyone who worked here</b>.</td></tr>`;
  monUpdateFooter();
  $('mon-foot').innerHTML += ` · <b>${esc(projLabel(MON_PROJ))}</b>: ${shown.length} employee${shown.length===1?'':'s'}, total ${fmt(total)}`;
}
function monEnsureProjLine(id){
  if (!monLines[id]) monLines[id] = [];
  if (!monLines[id].some(ln => lineProj(ln) === MON_PROJ)){ monLines[id].push({ project: projLabel(MON_PROJ), amount:'' }); return true; }
  return false;
}
function setMonMode(mode){
  MON_MODE = mode;
  $('mm-emp').className = 'btn btn-sm ' + (mode==='emp' ? 'btn-primary' : 'btn-ghost');
  $('mm-proj').className = 'btn btn-sm ' + (mode==='proj' ? 'btn-primary' : 'btn-ghost');
  $('mp-box').style.display = mode==='proj' ? 'inline-flex' : 'none';
  renderMonthly();
}
$('mm-emp').addEventListener('click', () => setMonMode('emp'));
$('mm-proj').addEventListener('click', () => setMonMode('proj'));
$('mp-proj').addEventListener('change', () => { const c = parseProjInput($('mp-proj').value); if ($('mp-proj').value.trim() && !c) return toast('Pick the project from the suggestions','warn'); MON_PROJ = c || ''; renderMonthly(); });
$('mp-attended').addEventListener('click', () => {
  if (!MON_PROJ) return toast('Choose the project first','warn');
  const ids = [...new Set(S.attendance.filter(a => (a.projects||[]).some(x => x.code===MON_PROJ)).map(a => String(a.emp_id)))].filter(id => onPayroll(empById(id), settings.period));
  if (!ids.length) return toast(`Nobody has attendance at ${projLabel(MON_PROJ)} in this payroll cycle`,'warn');
  let added = 0; ids.forEach(id => { if (monEnsureProjLine(id)) added++; });
  renderMonthly(); toast(added ? `${added} employee${added>1?'s':''} added — enter their amounts, then Save` : 'Everyone who worked here is already listed');
});
$('mp-fill-go').addEventListener('click', () => {
  const v = $('mp-fill').value; if (v==='' || num(v) <= 0) return toast('Type the amount first','warn');
  let n = 0; document.querySelectorAll('#mon-tbl [data-mf="a"]').forEach(inp => { inp.value = v; monInput(inp); n++; });
  toast(`${fmt(num(v))} entered for ${n} employee${n===1?'':'s'} — click Save changes to keep it`);
});

// ═════════════════════════════════════════════════════════
//  SETTINGS
// ═════════════════════════════════════════════════════════
const SET_MAP = [['s-company','companyName','t'],['s-period','period','t'],['s-cycle','cycleStartDay'],['s-hours','hoursPerDay'],['s-shift','shiftStart','t'],['s-late','lateAfter','t'],['s-evening','eveningShiftAfter','t'],['s-ot-thr','otThreshold'],['s-ot-mode','otMode','t'],['s-perm-n','permissionsPerMonth'],['s-reqflow','requestFlow','t'],['s-perm-deadline','permDeadlineMin','n'],['s-acct-min','acctMinEmployees','n'],['s-annual-notice','annualNoticeDays','n'],['s-annual','annualLeaveDefault'],['s-casual','casualCountsAnnual','t'],['s-c-unpaid','codeUnpaid'],['s-c-absent','codeAbsent'],['s-c-holiday','codeHoliday'],['s-hol-x','holidayExtraDays'],['s-perm-h','permissionMaxHours'],['s-days','daysPerMonth'],['s-otm','otMultiplier'],
  ['s-auto-abs','autoAbsentFrom','t'],['s-si-eg','siRateEG'],['s-si-sa','siRateSA'],['s-c-ot','codeOT'],['s-c-si','codeSI'],['s-c-loan','codeLoan'],['s-c-delay','codeDelay'],['s-c-pen','codePenalty']];
const DAYS=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
function applySettingsUI(){
  SET_MAP.forEach(([id,k]) => $(id).value = settings[k] ?? '');
  const w = settings.weekendDays || [];
  cycleHint();
  $('s-weekend').innerHTML = DAYS.map((d,i)=>`<label style="display:flex;gap:5px;align-items:center;cursor:pointer"><input type="checkbox" data-wd="${i}" ${w.includes(i)?'checked':''}>${d}</label>`).join('');
}
async function saveSettings(){
  const oldPeriod = settings.period, oldCycle = settings.cycleStartDay;
  SET_MAP.forEach(([id,k,t]) => settings[k] = t==='t' ? $(id).value.trim() : num($(id).value));
  settings.weekendDays = [...document.querySelectorAll('#s-weekend [data-wd]')].filter(c=>c.checked).map(c=>num(c.dataset.wd));
  if(!settings.period) settings.period = thisMonth();
  const { data, error } = await sb.from('settings').upsert({ key:'payroll', value:settings }).select();
  if(error) return toast(error.message,'err');
  if (!(data && data.length)) return toast(NOPERM,'err');
  if (settings.period !== oldPeriod || settings.cycleStartDay !== oldCycle){ resetMonthly(); await loadPeriodData(); loader(false); }
  renderAll(); toast('Settings saved');
}

// ═════════════════════════════════════════════════════════
//  DELETE
// ═════════════════════════════════════════════════════════
function confirmDel(msg, fn){
  $('del-msg').textContent = msg; $('del-ok').textContent='Delete'; $('del-ok').className='btn btn-danger'; $('del-title').textContent='Confirm delete';
  $('del-ok').onclick = async () => { $('del-ok').disabled=true; try{ await fn(); closeM('m-del'); }catch(e){ toast(e.message,'err'); } $('del-ok').disabled=false; };
  openM('m-del');
}
async function del(table, id){ const { data, error } = await sb.from(table).delete().eq('id', id).select(); if(error) throw error; if(!(data && data.length)) throw new Error(NOPERM); }

// ═════════════════════════════════════════════════════════
//  NAVIGATION & EVENTS
// ═════════════════════════════════════════════════════════
function showPage(name){
  renderPageIfNeeded(name);
  document.querySelectorAll('.page').forEach(p=>p.classList.toggle('active', p.id==='page-'+name));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.toggle('active', n.dataset.page===name));
  window.scrollTo(0,0);
}

document.addEventListener('click', async ev => {
  const t = ev.target;
  const nav = t.closest('[data-page]'); if (nav && nav.classList.contains('nav-item')) return showPage(nav.dataset.page);
  const nv = t.closest('[data-nav]'); if (nv) return showPage(nv.dataset.nav);
  const orp = t.closest('[data-open-report]'); if (orp) { showPage('reports'); return openReport(orp.dataset.openReport); }
  const cl = t.closest('[data-close]'); if (cl) return closeM(cl.dataset.close);
  if (t.classList && t.classList.contains('overlay')) return t.classList.remove('open');
  const act = t.closest('[data-act]');
  if (act){ const a = act.dataset.act;
    if (a==='new-emp') return openEmp(null);
    if (a==='new-att') return openAtt(null);
    if (a==='new-proj') return openM('m-proj');
    if (a==='new-perm') return openPerm();
    if (a==='new-leave') return openLeave(null);
    if (a==='new-pen') return openPen(null);
    if (a==='new-hol') return openHol();
    if (a==='myprofile') return showSelf(ME, { email: ME.email });
    if (a==='new-var') return openNewVar();
    if (a==='goto-current') return gotoCurrentPeriod();
    if (a==='theme') return openTheme();
    if (a==='self-leave') return openSelfLeave();
    if (a==='self-perm') return openSelfPerm();
    if (a==='self-hr') return openSelfHr();
    if (a==='new-loan'){ ['l-emp','l-amt','l-per','l-ref'].forEach(i=>$(i).value=''); $('l-set').value='0'; $('l-start').value=settings.period; loanPreview(); return openM('m-loan'); }
    if (a==='reload') return loadAll();
    if (a==='signout') return signOut();
    if (a==='chpass') return openM('m-pass');
    if (a==='disconnect'){ ev.preventDefault(); return disconnect(); }
  }
  const er = t.closest('[data-emp]'); if (er) return openEmp(er.dataset.emp);
  const sl = t.closest('[data-slip]'); if (sl) return openSlip(sl.dataset.slip);
  if (t.closest('[data-rm-split]')){ t.closest('.split').remove(); return checkSplits(); }
  const df = t.closest('[data-del-fixed]');
  if (df){ const id=df.dataset.delFixed; return confirmDel('Remove this salary element from the employee?', async()=>{ await del('employee_salary_elements',id); S.fixed=S.fixed.filter(r=>r.id!==id); renderPackage(); renderPayroll(); renderDashboard(); toast('Element removed'); }); }
  const da = t.closest('[data-del-att]');
  if (da){ const id=da.dataset.delAtt; return confirmDel('Delete this attendance record?', async()=>{ await del('attendance',id); S.attendance=S.attendance.filter(r=>r.id!==id); if (ATT_RANGE) ATT_RANGE.rows=ATT_RANGE.rows.filter(r=>r.id!==id); renderAttendance(); renderDashboard(); renderPayroll(); renderReports(); toast('Deleted'); }); }
  const dp = t.closest('[data-del-proj]');
  if (dp){ const id=dp.dataset.delProj; return confirmDel(`Delete project ${id}? Attendance already logged against it keeps the code.`, async()=>{ await del('projects',id); S.projects=S.projects.filter(p=>String(p.id)!==id); buildLists(); renderProjects(); toast('Deleted'); }); }
  const ae = t.closest('[data-att-edit]'); if (ae && !t.closest('[data-del-att]')) { const r=attRows().find(x=>String(x.id)===ae.dataset.attEdit); if(r) return openAtt(r); }
  const lp = t.closest('[data-lpp]'); if (lp) return openLoanPostpone(lp.dataset.lpp);
  const lu = t.closest('[data-lpp-undo]'); if (lu) return undoLoanPostpone(lu.dataset.lppUndo);
  const dl = t.closest('[data-del-loan]');
  if (dl){ const id=dl.dataset.delLoan; return confirmDel('Delete this loan record?', async()=>{ await del('employee_loans',id); S.loans=S.loans.filter(l=>l.id!==id); renderLoans(); renderPayroll(); renderDashboard(); toast('Deleted'); }); }
});

// inputs
['emp-q','emp-dept','emp-unit','emp-status'].forEach(id => $(id).addEventListener('input', renderEmployees));
['proj-q'].forEach(id => $(id).addEventListener('input', renderProjects));
['pay-q','pay-dept'].forEach(id => $(id).addEventListener('input', renderPayroll));
['mon-q','mon-dept'].forEach(id => $(id).addEventListener('input', renderMonthly));
$('mon-el').addEventListener('change', onMonElementChange);
$('att-q').addEventListener('input', renderAttendance);
$('att-day').addEventListener('change', e => { attDayFilter = e.target.value || null; renderAttendance(); });
$('att-all').addEventListener('click', () => { attDayFilter = null; $('att-day').value=''; renderAttendance(); });
$('mon-tbl').addEventListener('input', e => { const el=e.target.closest('[data-me]'); if(el) monInput(el); });
$('mon-tbl').addEventListener('click', e => {
  const a=e.target.closest('[data-mon-add]'); if(a) return monAddLine(a.dataset.monAdd);
  const r=e.target.closest('[data-mon-rm]');  if(r) return monRemoveLine(r.dataset.monRm, num(r.dataset.mi));
});
$('a-status').addEventListener('change', () => { toggleWork(); checkSplits(); });
$('a-emp').addEventListener('input', checkSplits);
$('a-splits').addEventListener('input', checkSplits);
['l-amt','l-per','l-start'].forEach(id => $(id).addEventListener('input', loanPreview));
$('a-add-split').addEventListener('click', () => addSplit());
$('a-save').addEventListener('click', saveAtt);
$('emp-save').addEventListener('click', saveEmp);
$('emp-pkg').addEventListener('click', e => { if (e.target.id==='pk-add') addPackageRow(); });
$('p-save').addEventListener('click', saveProj);
$('l-save').addEventListener('click', saveLoan);
$('lpp-save').addEventListener('click', saveLoanPostpone);
$('lpp-month').addEventListener('change', lppPreview);
$('mon-save').addEventListener('click', saveMonthly);
$('pay-export').addEventListener('click', exportPayroll);
$('set-save').addEventListener('click', saveSettings);
$('btn-connect').addEventListener('click', connectFromForm);
document.addEventListener('keydown', e => { if (e.key==='Escape') document.querySelectorAll('.overlay.open').forEach(o=>o.classList.remove('open')); });

setInterval(()=>{ $('clock').textContent = new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}); }, 1000);


function cycleHint(){
  const keep = settings.cycleStartDay, kp = settings.period;
  settings.cycleStartDay = num($('s-cycle').value); settings.period = $('s-period').value || kp;
  $('s-cycle-hint').textContent = settings.period ? `Period ${periodLabel(settings.period)}` : '';
  settings.cycleStartDay = keep; settings.period = kp;
}
['s-cycle','s-period'].forEach(id => $(id).addEventListener('input', cycleHint));

// @ts-check — checked by TypeScript (tsconfig.json); keep it free of type errors
// ═════════════════════════════════════════════════════════
//  REPORTS
// ═════════════════════════════════════════════════════════
const C = (k,l,t='text',s=false) => ({k,l,t,s});
const activeEmps = () => S.employees.filter(e => e.status!=='Inactive');
const daysUntil = d => d ? Math.round((new Date(d+'T00:00:00').getTime() - new Date(todayStr()+'T00:00:00').getTime())/86400000) : null;
const inPeriod = d => d && d >= periodStart(settings.period) && d <= periodEnd(settings.period);
function projName(c){ if(!c) return '(unallocated)'; const p=S.projects.find(x=>String(x.id)===String(c)); return p ? (p.name||'') : ''; }
function groupBy(arr, fn){ const m={}; arr.forEach(x=>{ const k=fn(x)||'(blank)'; (m[k]=m[k]||[]).push(x); }); return m; }

// Labour cost: each employee's gross pay is charged to projects in proportion to attendance hours.
// Monthly amounts entered against a specific project go straight to that project instead.
function laborCost(){
  const detail=[];
  computeAll().forEach(r => {
    const id=String(r.emp.id), hrs={}, direct={};
    S.attendance.filter(a=>String(a.emp_id)===id).forEach(a=>(a.projects||[]).forEach(x=>{ hrs[x.code]=(hrs[x.code]||0)+num(x.hours); }));
    S.monthly.filter(m=>String(m.emp_id)===id && m.project_code).forEach(m=>{ const el=elByCode(m.element_code); if(el && el.element_type==='Addition') direct[m.project_code]=(direct[m.project_code]||0)+num(m.amount); });
    if (!r.snapshot){ const ap = approvedAllowance(r.emp); if (ap) (ap.details||[]).forEach(x => { direct[x.project] = (direct[x.project]||0) + num(x.amount); }); }
    if (r.snapshot) r.lines.filter(l => /— automatic$/.test(l.name) && l.project).forEach(l => { direct[l.project] = (direct[l.project]||0) + l.amount; });
    const directTot = Object.values(direct).reduce((s,v)=>s+v,0), pool = r.gross - directTot;
    const totH = Object.values(hrs).reduce((s,v)=>s+v,0);
    const codes = new Set([...Object.keys(hrs), ...Object.keys(direct)]);
    if (!totH && Math.abs(pool)>0.004) codes.add('');
    codes.forEach(c => { const h=hrs[c]||0, share = totH ? h/totH : (c===''?1:0), alloc=pool*share, d=direct[c]||0;
      detail.push({ emp:r.emp, code:c, hours:h, share, alloc, direct:d, total:alloc+d }); });
  });
  return detail;
}

const REPORTS = [
  // ── ATTENDANCE ──────────────────────────────────────────
  { id:'att-daily', g:'Attendance', t:'Daily attendance register',
    d:'Every attendance record between the two dates, with each project line and its times. For one day, click “Today” or type the same date in both boxes.',
    build:p => ({ cols:[C('date','Date','date'),C('code','Code','id'),C('name','Employee','strong'),C('department','Department'),C('status','Status'),C('in','Check-in','mono'),C('out','Check-out','mono'),C('hours','Hours','num',true),C('ot','OT','num',true),C('late','Late','num',true),C('early','Early','num',true),C('split','Project lines')],
      rows:S.attendance.slice().sort((x,y)=>String(x.date).localeCompare(String(y.date))||String(x.emp_id).localeCompare(String(y.emp_id),undefined,{numeric:true})).map(a=>{ const e=empOrBlank(a.emp_id), R=dayRules(a,e); return { date:a.date, code:a.emp_id, name:a.emp_name||empName(e), department:e.department, status:a.status,
        in:a.check_in, out:attNoOut(a) ? 'MISSING' : a.check_out, hours:attNoOut(a) ? 0 : num(a.total_hours), ot:R.ot, late:R.late, early:R.early, split:(a.projects||[]).map(x=>`${x.code}${x.in?' '+x.in+'–'+x.out:''} (${fmt(x.hours)}h)`).join(' | ') }; }) }) },
  { id:'att-missing', g:'Attendance', t:'Missing attendance',
    d:'Working days between the two dates on which an employee has no attendance record, no approved vacation and no approved mission — use it to chase supervisors before payroll closes. Weekends, public holidays and future days are skipped. For one day, click “Today” or type the same date in both boxes.',
    build:p => { const days=[], end = p.to < todayStr() ? p.to : todayStr();
      for (const d=dObj(p.from); dStr(d)<=end; d.setDate(d.getDate()+1)) { const x=dStr(d); if (isWorkday(x)) days.push(x); }
      const cols=[C('date','Date','date'),C('dow','Day'),C('code','Code','id'),C('name_ar','Arabic name','ar'),C('name_en','English name','strong'),C('department','Department'),C('unit','Unit'),C('job','Job')];
      if (!days.length) return { cols, rows:[], note:'No working day to check between these dates (weekends, public holidays and future days are skipped)' };
      const has=new Set(S.attendance.map(a=>String(a.emp_id)+'|'+a.date)), rows=[];
      days.forEach(x => S.employees.forEach(e => {
        const emp = (!e.employment_date || String(e.employment_date).slice(0,10)<=x) && (e.status!=='Inactive' || (e.resignation_date && String(e.resignation_date).slice(0,10)>=x));
        if (!emp || has.has(String(e.id)+'|'+x) || leaveOn(e.id,x) || missionsOn(e.id,x).length) return;
        rows.push({ date:x, dow:DAYS[dObj(x).getDay()], code:e.id, name_ar:e.name_ar, name_en:e.name_en, department:e.department, unit:e.unit, job:e.job_name }); }));
      return { cols, rows, note:`${days.length} working day${days.length===1?'':'s'} checked` }; } },
  { id:'att-monthly', g:'Attendance', t:'Monthly attendance summary',
    d:'One line per active employee between the two dates: days by status, total hours and overtime. Employees with zero records stand out.',
    build:p => ({ cols:[C('code','Code','id'),C('name','Employee','strong'),C('department','Department'),C('records','Records','int',true),C('present','Present','int',true),C('half','Half day','int',true),C('annual','Annual leave','int',true),C('sick','Sick leave','int',true),C('absent','Absent','int',true),C('hours','Hours','num',true),C('ot','OT hours','num',true),C('late','Late hours','num',true),C('early','Early hours','num',true),C('waived','Waived','num',true),C('vac','Vacation days','num',true),C('unpaid','of which unpaid','num',true)],
      rows:activeEmps().map(e=>{ const A=S.attendance.filter(a=>String(a.emp_id)===String(e.id)), c=s=>A.filter(a=>a.status===s).length, R=A.map(a=>dayRules(a,e));
        return { code:e.id, name:empName(e), department:e.department, records:A.length, present:c('Present'), half:c('Half Day'), annual:c('Annual Leave'), sick:c('Sick Leave'), absent:c('Absent'),
          hours:A.reduce((s,a)=>s+(attNoOut(a)?0:num(a.total_hours)),0), ot:R.reduce((s,r)=>s+r.ot,0), late:R.reduce((s,r)=>s+r.late,0), early:R.reduce((s,r)=>s+r.early,0), waived:R.reduce((s,r)=>s+r.waived,0),
          vac:S.leaves.filter(l=>String(l.emp_id)===String(e.id)&&l.status==='Approved').reduce((s,l)=>s+leaveDaysIn(l,p.from,p.to),0),
          unpaid:S.leaves.filter(l=>String(l.emp_id)===String(e.id)&&l.status==='Approved'&&l.leave_type==='Unpaid').reduce((s,l)=>s+leaveDaysIn(l,p.from,p.to),0) }; }) }) },
  { id:'att-leave', g:'Attendance', t:'Absence & leave',
    d:'Employees with any absence, leave or half day between the two dates, with the dates.',
    build:() => ({ cols:[C('code','Code','id'),C('name','Employee','strong'),C('department','Department'),C('absent','Absent','int',true),C('annual','Annual','int',true),C('sick','Sick','int',true),C('half','Half day','int',true),C('dates','Dates')],
      rows:activeEmps().map(e=>{ const A=S.attendance.filter(a=>String(a.emp_id)===String(e.id) && a.status!=='Present'), c=s=>A.filter(a=>a.status===s).length;
        return A.length ? { code:e.id, name:empName(e), department:e.department, absent:c('Absent'), annual:c('Annual Leave'), sick:c('Sick Leave'), half:c('Half Day'),
          dates:A.sort((x,y)=>x.date.localeCompare(y.date)).map(a=>`${a.date.slice(5)} ${a.status}`).join(', ') } : null; }).filter(Boolean) }) },
  { id:'att-ot', g:'Attendance', t:'Overtime', param:'view',
    d:'Overtime between the two dates: on each day, the hours above the standard day (after the minimum-hours rule), valued at the multiplier × hour pay. The “Days” column shows each date; choose “One line per day” for the full detail (check-in, check-out, hours worked). Exception employees are excluded; a day with a missing punch or a time to confirm counts only after HR corrects it.',
    build:p => { const mult=num(settings.otMultiplier), D=[];
      S.attendance.forEach(a=>{ const e=empById(a.emp_id); if(!e) return; const R=dayRules(a,e); if(!(R.ot>0)) return; D.push({ a, e, R, rate:empRates(e).hourly }); });
      D.sort((x,y)=>x.a.date.localeCompare(y.a.date) || String(x.e.id).localeCompare(String(y.e.id),undefined,{numeric:true}));
      const kind = x => x.R.holiday ? 'Public holiday' : x.R.weekend ? 'Weekend' : 'Working day', r2 = v => Math.round(v*100)/100;
      if (p.view==='day') return { cols:[C('date','Date','date'),C('dow','Day'),C('code','Code','id'),C('name','Employee','strong'),C('department','Department'),C('unit','Unit'),C('in','Check-in','mono'),C('out','Check-out','mono'),C('worked','Hours worked','num',true),C('std','Standard day','num'),C('kind','Day type'),C('hours','OT hours','num',true),C('rate','Hour pay','num'),C('mult','Multiplier','num'),C('value','OT value','num',true)],
        rows:D.map(x=>({ date:x.a.date, dow:DAYS[dObj(x.a.date).getDay()], code:x.e.id, name:empName(x.e), department:x.e.department, unit:x.e.unit, in:x.a.check_in, out:x.a.check_out, worked:num(x.a.total_hours),
          std:num(settings.hoursPerDay), kind:kind(x), hours:x.R.ot, rate:x.rate, mult, value:r2(x.R.ot*x.rate*mult) })) };
      const G={}; D.forEach(x=>{ const g=G[x.e.id]=G[x.e.id]||{ e:x.e, rate:x.rate, h:0, days:[] }; g.h+=x.R.ot; g.days.push(`${x.a.date.slice(8,10)}/${x.a.date.slice(5,7)} ${fmt(x.R.ot)}h`); });
      return { cols:[C('code','Code','id'),C('name','Employee','strong'),C('department','Department'),C('unit','Unit'),C('n','Days','int',true),C('days','Days with overtime (date · hours)'),C('hours','OT hours','num',true),C('rate','Hour pay','num'),C('mult','Multiplier','num'),C('value','OT value','num',true)],
        rows:Object.values(G).map(g=>({ code:g.e.id, name:empName(g.e), department:g.e.department, unit:g.e.unit, n:g.days.length, days:g.days.join(' · '), hours:r2(g.h), rate:g.rate, mult, value:r2(g.h*g.rate*mult) })) }; } },

  { id:'att-late', g:'Attendance', t:'Late arrivals & early leaves',
    d:'Every day with late arrival or short hours, the part waived by an approved permission, and the deduction at delay hour pay. Exception employees are excluded.',
    build:() => ({ cols:[C('date','Date','date'),C('code','Code','id'),C('name','Employee','strong'),C('department','Department'),C('in','In','mono'),C('out','Out','mono'),C('worked','Worked','num'),C('late','Late','num',true),C('early','Early','num',true),C('waived','Waived','num',true),C('net','Deducted hours','num',true),C('rate','Delay hour pay','num'),C('ded','Deduction','num',true)],
      rows:S.attendance.map(a=>{ const e=empById(a.emp_id); if(!e) return null; const R=dayRules(a,e); if(!R.lateRaw && !R.earlyRaw) return null;
        const rate=num(e.delay_hour_pay)||num(e.hour_pay), net=R.late+R.early;
        return { date:a.date, code:a.emp_id, name:empName(e), department:e.department, in:a.check_in, out:a.check_out, worked:num(a.total_hours), late:R.lateRaw, early:R.earlyRaw, waived:R.waived, net, rate, ded:net*rate }; })
        .filter(Boolean).sort((a,b)=>a.date.localeCompare(b.date)) }) },
  { id:'att-perm', g:'Attendance', t:'Permission requests',
    d:'All late-arrival and early-leave permission requests between the two dates with their decision, and how many each employee has used.',
    build:() => ({ cols:[C('date','Date','date'),C('code','Code','id'),C('name','Employee','strong'),C('department','Department'),C('type','Type'),C('hours','Hours','num',true),C('reason','Reason'),C('status','Status'),C('by','Decided by'),C('used','Approved this month','int')],
      rows:S.permissions.map(p=>{ const e=empOrBlank(p.emp_id); return { date:p.date, code:p.emp_id, name:empName(e), department:e.department, type:p.type, hours:num(p.hours), reason:p.reason, status:p.status, by:p.decided_by, used:permUsed(p.emp_id, monthOf(p.date)) }; })
        .sort((a,b)=>a.date.localeCompare(b.date)) }) },
  { id:'att-exempt', g:'Attendance', t:'Exception employees',
    d:'Employees on the exception rule — no delay deduction and no overtime. Change this on the employee record.',
    build:() => ({ cols:[C('code','Code','id'),C('name_ar','Arabic name','ar'),C('name','English name','strong'),C('department','Department'),C('unit','Unit'),C('job','Job')],
      rows:activeEmps().filter(e=>e.attendance_exempt).map(e=>({ code:e.id, name_ar:e.name_ar, name:e.name_en, department:e.department, unit:e.unit, job:e.job_name })) }) },

  { id:'lv-register', g:'Vacations', t:'Vacation register',
    d:'Every approved vacation overlapping the two dates, with the days that fall inside them.',
    build:p => { const ps=p.from, pe=p.to;
      return { cols:[C('code','Code','id'),C('name','Employee','strong'),C('department','Department'),C('type','Type'),C('from','From','date'),C('to','To','date'),C('days','Total days','num',true),C('inp','Days in range','num',true),C('reason','Reason'),C('by','Entered by')],
        rows:S.leaves.filter(l=>l.status==='Approved' && l.date_from<=pe && l.date_to>=ps).map(l=>{ const e=empOrBlank(l.emp_id); return { code:l.emp_id, name:empName(e), department:e.department, type:l.leave_type, from:l.date_from, to:l.date_to, days:num(l.days), inp:leaveDaysIn(l,ps,pe), reason:l.reason, by:l.entered_by }; })
          .sort((a,b)=>a.from.localeCompare(b.from)) }; } },
  { id:'lv-balance', g:'Vacations', t:'Annual leave balance',
    d:'Entitlement, days taken and days remaining for the year of the current period. Casual leave counts against annual leave unless switched off in Settings.',
    build:() => { const y=settings.period.slice(0,4), take=(id,t)=>S.leaves.filter(l=>String(l.emp_id)===String(id)&&l.status==='Approved'&&l.leave_type===t).reduce((s,l)=>s+leaveDaysIn(l,`${y}-01-01`,`${y}-12-31`),0);
      return { cols:[C('code','Code','id'),C('name','Employee','strong'),C('department','Department'),C('ent','Entitlement','num',true),C('annual','Annual taken','num',true),C('casual','Casual taken','num',true),C('rem','Remaining','num',true),C('sick','Sick taken','num',true),C('unpaid','Unpaid taken','num',true)],
        rows:activeEmps().map(e=>({ code:e.id, name:empName(e), department:e.department, ent:annualEntitlement(e), annual:take(e.id,'Annual'), casual:take(e.id,'Casual'), rem:annualEntitlement(e)-annualTaken(e.id), sick:take(e.id,'Sick'), unpaid:take(e.id,'Unpaid') })) }; } },
  { id:'lv-today', g:'Vacations', t:'Who is on vacation',
    d:'Employees on approved vacation at any time between the two dates. For one day, click “Today” or type the same date in both boxes.',
    build:p => ({ cols:[C('code','Code','id'),C('name','Employee','strong'),C('department','Department'),C('job','Job'),C('type','Type'),C('from','From','date'),C('to','To','date'),C('inr','Days in range','num',true),C('back','Back on','date')],
      rows:S.leaves.filter(l=>l.status==='Approved' && l.date_from<=p.to && l.date_to>=p.from).map(l=>{ const e=empOrBlank(l.emp_id); const b=dObj(l.date_to); do { b.setDate(b.getDate()+1); } while(!isWorkday(dStr(b)));
        return { code:l.emp_id, name:empName(e), department:e.department, job:e.job_name, type:l.leave_type, from:l.date_from, to:l.date_to, inr:leaveDaysIn(l,p.from,p.to), back:dStr(b) }; }) }) },

  { id:'att-absence', g:'Attendance', t:'Absence deductions',
    d:'Unexcused absent days in the payroll cycle and the deduction at daily pay. Weekends, public holidays and days covered by approved leave are not deducted.',
    build:() => ({ cols:[C('code','Code','id'),C('name','Employee','strong'),C('department','Department'),C('days','Absent days','int',true),C('dates','Dates'),C('rate','Daily pay','num'),C('ded','Deduction','num',true)],
      rows:computeAll().filter(r=>r.absentDays).map(r=>{ const l=r.lines.find(x=>String(x.code)===String(settings.codeAbsent))||{};
        return { code:r.emp.id, name:empName(r.emp), department:r.emp.department, days:r.absentDays, dates:(String(l.note||'').match(/\((.*)\)/)||[])[1]||'', rate:empRates(r.emp).daily, ded:r.absence }; }) }) },
  { id:'pay-penalties', g:'Payroll', t:'Penalties',
    d:'Penalties whose incident date falls between the two dates, with their value, the payroll they are deducted in, who requested them and who recorded them.',
    build:() => ({ cols:[C('date','Incident','date'),C('code','Code','id'),C('name','Employee','strong'),C('department','Department'),C('pen','Penalty'),C('amt','Amount','num',true),C('per','Payroll','mono'),C('reason','Reason'),C('req','Requested by'),C('rec','Recorded by'),C('status','Status')],
      rows:S.penalties.map(x=>{ const e=empOrBlank(x.emp_id); return { date:x.incident_date, code:x.emp_id, name:empName(e), department:e.department, pen:penLabel(x), amt:x.status==='Approved'?penaltyValue(x):0, per:x.apply_period, reason:x.reason, req:x.requested_by, rec:x.recorded_by, status:x.status }; })
        .sort((a,b)=>a.date.localeCompare(b.date)) }) },
  { id:'pay-holiday', g:'Payroll', t:'Public holiday work',
    d:'Employees who worked on a public holiday between the two dates and the extra pay they receive.',
    build:() => { const R=[]; S.attendance.filter(a=>isHoliday(a.date) && (a.status==='Present'||a.status==='Half Day')).forEach(a=>{ const e=empById(a.emp_id)||/** @type {Employee} */ ({id:a.emp_id}), rate=empRates(e).daily, x=num(settings.holidayExtraDays)||1, f=a.status==='Present'?1:0.5;
        R.push({ date:a.date, hol:(holidayOn(a.date)||/** @type {Holiday} */ ({})).name, code:a.emp_id, name:empName(e), department:e.department, hours:num(a.total_hours), rate, pay:rate*x*f }); });
      return { cols:[C('date','Date','date'),C('hol','Holiday'),C('code','Code','id'),C('name','Employee','strong'),C('department','Department'),C('hours','Hours worked','num',true),C('rate','Daily pay','num'),C('pay','Extra pay','num',true)], rows:R.sort((a,b)=>a.date.localeCompare(b.date)) }; } },

  { id:'att-mobile', g:'Attendance', t:'Mobile check-in log',
    d:'Every check-in and check-out tapped on the mobile app between the two dates — time, site and GPS location. Taps made with no internet are marked offline: their time comes from the phone clock, corrected by the server when the phone reconnected. This log is permanent and cannot be edited.',
    build:() => ({ cols:[C('date','Date','date'),C('time','Time','mono'),C('code','Code','id'),C('name','Employee','strong'),C('department','Department'),C('ev','Event'),C('site','Site','id'),C('sname','Site name'),C('acc','GPS accuracy (m)','int'),C('dist','Distance from site'),C('warn','Location warnings'),C('map','Location','link'),C('how','Recorded'),C('state','Status')],
      rows:S.clocks.map(c=>{ const e=empOrBlank(c.emp_id); return { date:c.local_date, time:c.local_time, code:c.emp_id, name:empName(e), department:e.department, ev:c.event_type==='in'?'Check in':'Check out',
        how: (c.offline ? `📴 offline · sent ${String(c.received_at||'').slice(0,16).replace('T',' ')} UTC` : 'online') + (c.location_exempt ? ' · ⚠ no location (exception)' : ''),
        state: /corrected/.test(c.time_method||'') ? '⚠ phone clock was wrong — time corrected' : 'OK',
        site:c.project_code||'', sname:c.project_code?projName(c.project_code):(c.event_type==='in'?'No project':''), acc:c.accuracy, map: mapUrl(c) || '',
        dist: c.distance_m != null ? (c.distance_m >= 1000 ? (c.distance_m/1000).toFixed(1)+' km' : c.distance_m+' m') : '',
        warn: (c.location_flags||[]).map(f => (typeof LOC_FLAG !== 'undefined' && LOC_FLAG[f] ? LOC_FLAG[f][0] : f)).join(', ') + (c.applied === false ? (c.location_flags && c.location_flags.length ? ' · ' : '') + 'kept for review: ' + (c.review_note||'') : '') }; })
        .sort((a,b)=>(a.date+a.time).localeCompare(b.date+b.time)) }) },
  { id:'att-review', g:'Attendance', t:'Offline check-ins to review',
    d:'Check-ins made with no internet and sent later. The Petrokima Android app (new version) also sends the phone\'s “time since switched on” counter, which the user cannot change: the server then records the REAL time (✓ verified), and if the phone clock had been changed it shows ⚠ Phone clock was changed and tells HR. Without the counter (iPhone, older apps, or the phone restarted) the time comes from the phone clock: the server compares it with its own when the phone reconnects and corrects any difference. A tap that reached the server more than 5 minutes after its time is marked ⏳ HR to confirm: that day has no deductions or overtime until HR checks the time on the Attendance page and saves it, and the month cannot be approved before. Taps more than 72 hours old, or earlier than one already recorded, are refused and stay on the phone — HR records those manually.',
    build:() => ({ cols:[C('state','Status','strong'),C('date','Date','date'),C('time','Time recorded','mono'),C('claimed','Phone showed','mono'),C('recv','Sent (Cairo time)','mono'),C('delay','Hours until sent','num'),C('code','Code','id'),C('name','Employee'),C('ev','Event'),C('site','Site','id'),C('map','Location','link')],
      rows:S.clocks.filter(c=>c.offline).map(c=>{ const e=empOrBlank(c.emp_id), corr=/corrected/.test(c.time_method||''), delay = c.received_at ? (new Date(c.received_at).getTime()-new Date(c.at).getTime())/3600000 : null;
        const tz = String(e.entity||'').toLowerCase().includes('saudi') ? 'Asia/Riyadh' : 'Africa/Cairo', changed = /clock was changed/.test(c.time_method || ''), verified = /counter \(verified\)/.test(c.time_method || '');
        return { state: changed ? '⚠ Phone clock was changed — real time recorded' : /^Offline — sent/.test(c.review_note || '') ? ((c.location_flags||[]).includes('phone_restarted') ? '⏳ HR to confirm (phone restarted)' : '⏳ HR to confirm the time') : verified ? '✓ Real time verified' : corr ? '⚠ Phone clock was wrong' : 'OK', date:c.local_date, time:c.local_time,
          claimed: (c.phone_said_at || c.client_at) ? new Date(c.phone_said_at || c.client_at).toLocaleString('en-GB',{ timeZone: tz, hour:'2-digit', minute:'2-digit', day:'2-digit', month:'short' }) : '',
          recv: c.received_at ? new Date(c.received_at).toLocaleString('en-GB',{ timeZone: tz, hour:'2-digit', minute:'2-digit', day:'2-digit', month:'short' }) : '', delay: delay==null ? '' : Math.round(delay*100)/100,
          code:c.emp_id, name:empName(e), ev:c.event_type==='in'?'Check in':'Check out', site:c.project_code||'(no project)', map:mapUrl(c)||'' }; })
        .sort((a,b)=>Number(/^(OK|✓)/.test(a.state))-Number(/^(OK|✓)/.test(b.state)) || (a.date+a.time).localeCompare(b.date+b.time)) }) },

  { id:'att-fix', g:'Attendance', t:'Missing punches to correct',
    d:'Days with only one fingerprint-machine punch, days over 16 hours, offline phone taps sent late (time to confirm), and phone check-ins with no check-out on a past day. They carry no deductions or overtime until HR opens the record on the Attendance page, checks the times and saves. The month cannot be approved while any remain.',
    build:() => { const R=[]; S.attendance.forEach(a => (a.projects||[]).forEach(x => { if (x.missing || x.review || x.forgotten || (x.in && !x.out && a.date < todayStr())) { const e=empOrBlank(a.emp_id);
        R.push({ issue: x.missing ? 'Missing punch' : x.review ? (x.why === 'offline' ? 'Offline time to confirm' : 'Over 16 hours') : 'Missing phone check-out', source: a.source==='Machine' ? 'Fingerprint machine' : a.source==='Mobile' ? 'Phone' : (a.source||''),
                 date:a.date, code:a.emp_id, name:empName(e), department:e.department, in:x.in||'', out:x.out||'', hours:x.hours }); } }));
      return { cols:[C('issue','Issue','strong'),C('source','Source'),C('date','Date','date'),C('code','Code','id'),C('name','Employee'),C('department','Department'),C('in','In','mono'),C('out','Out','mono'),C('hours','Hours','num')],
        rows:R.sort((a,b)=>a.date.localeCompare(b.date)||String(a.code).localeCompare(String(b.code),undefined,{numeric:true})) }; } },
  { id:'att-open', g:'Attendance', t:'Open and forgotten check-ins',
    d:'Employees still checked in, and phone check-ins with no check-out on a past day (a check-in on the next day never closes them). Correct forgotten ones on the Attendance page before closing payroll.',
    build:() => { const R=[]; S.attendance.forEach(a => (a.projects||[]).forEach(x => { if (!x.out && x.in) { const e=empOrBlank(a.emp_id);
        R.push({ state: a.date===todayStr() && !x.forgotten ? 'On site now' : 'Missing check-out — needs correction', date:a.date, code:a.emp_id, name:empName(e), department:e.department, site:x.code, sname:projName(x.code), since:x.in }); } }));
      return { cols:[C('state','Status','strong'),C('date','Date','date'),C('code','Code','id'),C('name','Employee'),C('department','Department'),C('site','Site','id'),C('sname','Site name'),C('since','Checked in','mono')],
        rows:R.sort((a,b)=>a.state.localeCompare(b.state)||a.date.localeCompare(b.date)) }; } },

  { id:'hr-assignments', g:'HR', t:'Project assignments',
    d:'Which projects each employee is assigned to (they can check in only at these). Who assigned each project and when.',
    build:() => ({ cols:[C('code','Code','id'),C('name','Employee','strong'),C('department','Department'),C('unit','Unit'),C('job','Job'),C('pcode','Project','mono'),C('pname','Project name'),C('by','Assigned by'),C('role','As'),C('when','When','mono')],
      rows:S.empProjects.map(a => { const e = empOrBlank(a.emp_id); return { code:a.emp_id, name:empName(e), department:e.department, unit:e.unit, job:e.job_name,
        pcode:a.project_code, pname:projName(a.project_code), by:a.assigned_by, role:a.assigned_role, when:fmtSent(a.assigned_at) }; })
        .sort((x,y) => String(x.code).localeCompare(String(y.code), undefined, { numeric:true }) || String(x.pcode).localeCompare(String(y.pcode))) }) },
  { id:'att-phone-alerts', g:'Attendance', t:'Phone sign-in attempts',
    d:'Refused sign-ins on the phone app: someone using another employee\'s phone (🚨), or an employee on a phone that is not his registered one. Repeated tries within 30 minutes count as one entry.',
    build:() => ({ cols:[C('when','Last attempt','mono'),C('kind','What happened','strong'),C('code','Tried by','id'),C('name','Name'),C('owner','Phone belongs to'),C('label','Phone'),C('tries','Tries','num'),C('status','Review')],
      rows:S.phoneAlerts.map(a => ({ when:fmtSent(a.last_at), _date:String(a.last_at||'').slice(0,10), kind: a.kind==='other_employee_phone' ? '🚨 Another employee\'s phone' : 'ℹ Unregistered phone',
        code:a.attempted_emp_id, name:a.attempted_name || empName(empById(a.attempted_emp_id)), owner: a.owner_emp_id ? `${a.owner_emp_id} ${a.owner_name || empName(empById(a.owner_emp_id))}` : '—',
        label:a.device_label || '', tries:a.attempts, status: a.reviewed ? `✓ ${a.reviewed_by || ''}${a.review_note ? ' — ' + a.review_note : ''}` : 'Open' })) }) },
  { id:'att-phones', g:'Attendance', t:'Registered phones',
    d:'Which phone each active employee uses for the mobile app, when it was registered and last used. Reset a phone from the employee record.',
    build:() => ({ cols:[C('code','Code','id'),C('name','Employee','strong'),C('department','Department'),C('state','Phone'),C('label','Device'),C('reg','Registered','date'),C('seen','Last used','mono')],
      rows:activeEmps().map(e=>{ const d=S.devices.find(x=>String(x.emp_id)===String(e.id)); return { code:e.id, name:empName(e), department:e.department, state:d?'Registered':'Not yet',
        label:d?d.device_label:'', reg:d?String(d.registered_at).slice(0,10):'', seen:d?String(d.last_seen).slice(0,16).replace('T',' '):'' }; })
        .sort((a,b)=>a.state.localeCompare(b.state)||String(a.code).localeCompare(String(b.code),undefined,{numeric:true})) }) },

  // ── PROJECTS & COST ─────────────────────────────────────
  { id:'prj-hours', g:'Projects & cost', t:'Labour hours by project',
    d:'Hours worked on each project between the two dates, with the number of people and attendance days.',
    build:() => { const m={}; S.attendance.forEach(a=>(a.projects||[]).forEach(x=>{ const r=m[x.code]=m[x.code]||{h:0,e:new Set(),d:0}; r.h+=num(x.hours); r.e.add(String(a.emp_id)); r.d++; }));
      return { cols:[C('code','Project','id'),C('name','Name','strong'),C('hours','Hours','num',true),C('emps','Employees','int'),C('lines','Attendance lines','int',true),C('avg','Avg hours / employee','num')],
        rows:Object.entries(m).sort((a,b)=>b[1].h-a[1].h).map(([c,r])=>({ code:c, name:projName(c), hours:r.h, emps:r.e.size, lines:r.d, avg:r.h/r.e.size })) }; } },
  { id:'prj-cost', g:'Projects & cost', t:'Labour cost by project',
    d:'Each employee\'s gross pay charged to projects in proportion to their attendance hours; monthly amounts entered against a project go straight to it. Employees with no attendance fall under "(unallocated)". Employer social insurance is not included.',
    build:() => { const agg={}; laborCost().forEach(x=>{ const r=agg[x.code]=agg[x.code]||{h:0,a:0,d:0,e:new Set()}; r.h+=x.hours; r.a+=x.alloc; r.d+=x.direct; r.e.add(String(x.emp.id)); });
      return { cols:[C('code','Project','id'),C('name','Name','strong'),C('emps','Employees','int'),C('hours','Hours','num',true),C('alloc','Allocated pay','num',true),C('direct','Direct allowances','num',true),C('total','Total cost','num',true),C('cph','Cost / hour','num')],
        rows:Object.entries(agg).map(([c,r])=>({ code:c||'—', name:projName(c), emps:r.e.size, hours:r.h, alloc:r.a, direct:r.d, total:r.a+r.d, cph:r.h?(r.a+r.d)/r.h:0 })).sort((a,b)=>b.total-a.total) }; } },
  { id:'prj-cost-detail', g:'Projects & cost', t:'Labour cost detail (employee × project)',
    d:'The line-by-line allocation behind the labour cost report — one row per employee per project. Ideal for pivoting.',
    build:() => ({ cols:[C('code','Employee','id'),C('name','Name','strong'),C('department','Department'),C('pcode','Project','id'),C('pname','Project name'),C('hours','Hours','num',true),C('share','Share','pct'),C('alloc','Allocated pay','num',true),C('direct','Direct','num',true),C('total','Total','num',true)],
      rows:laborCost().map(x=>({ code:x.emp.id, name:empName(x.emp), department:x.emp.department, pcode:x.code||'—', pname:projName(x.code), hours:x.hours, share:x.share, alloc:x.alloc, direct:x.direct, total:x.total })) }) },
  { id:'prj-log', g:'Projects & cost', t:'Project site log',
    d:'Every project line between the two dates with its check-in and check-out — who was on which site, and when. Search by project code to see one site.',
    build:() => ({ cols:[C('date','Date','date'),C('pcode','Project','id'),C('pname','Project name'),C('code','Employee','id'),C('name','Name','strong'),C('in','Check-in','mono'),C('out','Check-out','mono'),C('hours','Hours','num',true)],
      rows:S.attendance.flatMap(a=>(a.projects||[]).map(x=>({ date:a.date, pcode:x.code, pname:projName(x.code), code:a.emp_id, name:a.emp_name, department:(empOrBlank(a.emp_id)).department, in:x.in||'', out:x.out||'', hours:num(x.hours) })))
        .sort((a,b)=>a.date.localeCompare(b.date)||String(a.pcode).localeCompare(String(b.pcode))) }) },

  // ── PAYROLL ─────────────────────────────────────────────
  { id:'pay-register', g:'Payroll', t:'Payroll register',
    d:'Pay for every active employee in the period. For one column per salary element, use Export CSV on the Payroll Run page.',
    build:() => ({ cols:[C('code','Code','id'),C('name_ar','Arabic name','ar'),C('name','English name','strong'),C('department','Department'),C('days','Days paid'),C('basic','Basic','num',true),C('oadd','Other add.','num',true),C('ot','OT','num',true),C('hol','Holiday work','num',true),C('gross','Gross','num',true),C('si','Soc. ins.','num',true),C('loans','Loans','num',true),C('delay','Late & early','num',true),C('abs','Absence','num',true),C('pen','Penalties','num',true),C('oded','Other ded.','num',true),C('net','Net','num',true)],
      rows:computeAll().map(r=>({ code:r.emp.id, name_ar:r.emp.name_ar, name:r.emp.name_en, department:r.emp.department, days:r.partial?`${r.days} / ${num(settings.daysPerMonth)||30}${r.joiner?' joiner':''}${r.leaver?' leaver':''}`:'full', basic:r.basic, oadd:r.otherAdd-r.holiday, ot:r.ot, hol:r.holiday, gross:r.gross, si:r.si, loans:r.loans, delay:r.delay, abs:r.absence, pen:r.penalty, oded:r.otherDed-r.delay-r.absence-r.penalty, net:r.net })) }) },
  { id:'pay-summary', g:'Payroll', t:'Payroll summary by group', param:'group',
    d:'Headcount and pay totals grouped by department, unit, entity or contract type.',
    build:p => { const G=groupBy(computeAll(), r=>r.emp[p.group]); const T=(L,k)=>L.reduce((s,r)=>s+r[k],0);
      return { cols:[C('grp','Group','strong'),C('n','Headcount','int',true),C('basic','Basic','num',true),C('gross','Gross','num',true),C('si','Soc. ins.','num',true),C('loans','Loans','num',true),C('oded','Other ded.','num',true),C('net','Net','num',true),C('avg','Avg net','num')],
        rows:Object.entries(G).map(([k,L])=>({ grp:k, n:L.length, basic:T(L,'basic'), gross:T(L,'gross'), si:T(L,'si'), loans:T(L,'loans'), oded:T(L,'otherDed'), net:T(L,'net'), avg:T(L,'net')/L.length })).sort((a,b)=>b.net-a.net) }; } },
  { id:'pay-elements', g:'Payroll', t:'Salary element summary',
    d:'Total of each salary element for the period — use it to reconcile with the general ledger.',
    build:() => { const m={}; computeAll().forEach(r=>r.lines.forEach(l=>{ const k=String(l.code); const x=m[k]=m[k]||{name:l.name,type:l.type,n:new Set(),amt:0}; x.amt+=l.amount; x.n.add(String(r.emp.id)); }));
      return { cols:[C('code','Code','id'),C('name','Element','strong'),C('type','Type'),C('n','Employees','int'),C('add','Additions','num',true),C('ded','Deductions','num',true)],
        rows:Object.entries(m).map(([c,x])=>({ code:c==='0'?'—':c, name:x.name, type:x.type, n:x.n.size, add:x.type==='Addition'?x.amt:0, ded:x.type==='Deduction'?x.amt:0 })).sort((a,b)=>(a.type===b.type?0:a.type==='Addition'?-1:1)||num(a.code)-num(b.code)) }; } },
  { id:'pay-si', g:'Payroll', t:'Social insurance',
    d:'Insured employees with their insurable amount and employee share for the period.',
    build:() => ({ cols:[C('code','Code','id'),C('name','Employee','strong'),C('department','Department'),C('insno','Insurance no.','id'),C('entity','Entity'),C('base','Insurable amount','num',true),C('rate','Rate %','num'),C('share','Employee share','num',true)],
      rows:computeAll().filter(r=>String(r.emp.insurance||'').toLowerCase()==='insured').map(r=>{ const sa=String(r.emp.entity||'').toLowerCase().includes('saudi');
        return { code:r.emp.id, name:empName(r.emp), department:r.emp.department, insno:r.emp.insurance_number, entity:r.emp.entity, base:num(r.emp.insurance_amount), rate:sa?num(settings.siRateSA):num(settings.siRateEG), share:r.si }; }) }) },
  { id:'pay-bank', g:'Payroll', t:'Bank transfer & cash list',
    d:'Net pay by payment method, bank and account — the list you send to the bank or hand to the cashier.',
    build:() => { const R=computeAll().map(r=>({ code:r.emp.id, name_ar:r.emp.name_ar, name:r.emp.name_en, department:r.emp.department, method:r.emp.payment_method||'(not set)', bank:(r.emp.bank_branch||'').trim(), account:r.emp.bank_account, net:r.net }))
        .sort((a,b)=>a.method.localeCompare(b.method)||a.bank.localeCompare(b.bank)||String(a.code).localeCompare(String(b.code),undefined,{numeric:true}));
      const G=groupBy(R,r=>r.method);
      return { cols:[C('code','Code','id'),C('name_ar','Arabic name','ar'),C('name','English name','strong'),C('method','Method'),C('bank','Bank'),C('account','Account','id'),C('net','Net pay','num',true)], rows:R,
        note:Object.entries(G).map(([k,L])=>`${k}: ${L.length} employees, ${fmt(L.reduce((s,r)=>s+r.net,0))} EGP`).join(' · ') }; } },
  { id:'pay-loans', g:'Payroll', t:'Loans',
    d:'All staff loans with the amount settled, the balance outstanding and this period\'s deduction.',
    build:() => ({ cols:[C('code','Code','id'),C('name','Employee','strong'),C('department','Department'),C('ref','Reference','mono'),C('amt','Loan','num',true),C('months','Months','int'),C('inst','Instalment','num'),C('start','First deduction','mono'),C('settled','Settled','num',true),C('out','Outstanding','num',true),C('now','This period','num',true),C('end','Last instalment','mono'),C('pp','Postponed months'),C('status','Status')],
      rows:S.loans.map(l=>{ const e=empOrBlank(l.emp_id); return { code:l.emp_id, name:empName(e), department:e.department, ref:l.reference, amt:num(l.loan_amount), months:num(l.periods), inst:num(l.installment),
        start:l.start_period, settled:num(l.amount_settled), out:num(l.loan_amount)-num(l.amount_settled), now:loanInstalment(l,settings.period), end:loanEnd(l), pp:(l.postponed||[]).join(', '), status:l.status }; }) }) },

  // ── HR ──────────────────────────────────────────────────
  { id:'hr-headcount', g:'HR', t:'Headcount analysis', param:'group',
    d:'Active headcount split by gender, contract type and insurance status.',
    build:p => { const G=groupBy(activeEmps(), e=>e[p.group]); const c=(L,k,v)=>L.filter(e=>String(e[k]||'').toLowerCase()===v.toLowerCase()).length;
      return { cols:[C('grp','Group','strong'),C('n','Active','int',true),C('m','Male','int',true),C('f','Female','int',true),C('perm','Permanent','int',true),C('temp','Temporary','int',true),C('con','Contract','int',true),C('ins','Insured','int',true),C('nins','Not insured','int',true)],
        rows:Object.entries(G).map(([k,L])=>({ grp:k, n:L.length, m:c(L,'gender','Male'), f:c(L,'gender','Female'), perm:c(L,'contract_type','Permanent'), temp:c(L,'contract_type','Temporary'), con:c(L,'contract_type','Contract'), ins:c(L,'insurance','Insured'), nins:c(L,'insurance','Non insured') })).sort((a,b)=>b.n-a.n) }; } },
  { id:'hr-master', g:'HR', t:'Employee master list',
    d:'Every employee (active and inactive) with every field on file. Export for a complete HR extract.',
    build:() => { const F=EMP_FIELDS.flatMap(s=>s[1]).filter(f => !isOfficer() || !PAY_FIELDS.includes(f[0]));
      return { cols:F.map(([k,l,t])=>C(k,l, k==='name_ar'?'ar' : ['id','national_id','insurance_number','bank_account'].includes(k)?'id' : t==='number'?'num' : t==='date'?'date':'text')),
        rows:[...S.employees].sort((a,b)=>String(a.id).localeCompare(String(b.id),undefined,{numeric:true})).map(e=>Object.fromEntries(F.map(([k])=>[k, k==='manager_id' ? (e.manager_id ? `${e.manager_id} — ${empName(empById(e.manager_id))}` : (e.top_of_org?'(top of organisation)':'')) : e[k]]))) }; } },
  { id:'hr-movement', g:'HR', t:'Joiners & leavers',
    d:'Employees whose employment date or resignation date falls between the two dates. “Days paid” is shown for dates inside the current payroll cycle.',
    build:() => ({ cols:[C('type','Movement','strong'),C('code','Code','id'),C('name','Employee'),C('department','Department'),C('job','Job'),C('contract','Contract'),C('date','Date','date'),C('paid','Days paid','int')],
      rows:[...S.employees.filter(e=>e.employment_date).map(e=>({type:'Joiner',e,date:String(e.employment_date).slice(0,10)})),
            ...S.employees.filter(e=>e.resignation_date).map(e=>({type:'Leaver',e,date:String(e.resignation_date).slice(0,10)}))]
        .sort((a,b)=>a.date.localeCompare(b.date))
        .map(x=>({ type:x.type, code:x.e.id, name:empName(x.e), department:x.e.department, job:x.e.job_name, contract:x.e.contract_type, date:x.date, paid:inPeriod(x.date) ? employment(x.e, settings.period).days : null })) }) },
  { id:'hr-alerts', g:'HR', t:'Probation & ID expiry alerts',
    d:'Probation periods ending within 30 days, and national IDs expired or expiring within 60 days (active employees).',
    build:() => { const R=[]; activeEmps().forEach(e=>{
        const p=daysUntil(e.probation_end_date); if (p!==null && p>=0 && p<=30) R.push({alert:'Probation ending',e,date:e.probation_end_date,days:p});
        const n=daysUntil(e.national_id_expiry); if (n!==null && n<=60) R.push({alert:n<0?'National ID expired':'National ID expiring',e,date:e.national_id_expiry,days:n}); });
      return { cols:[C('alert','Alert','strong'),C('code','Code','id'),C('name','Employee'),C('department','Department'),C('date','Date','date'),C('days','Days left','int')],
        rows:R.sort((a,b)=>a.days-b.days).map(x=>({ alert:x.alert, code:x.e.id, name:empName(x.e), department:x.e.department, date:x.date, days:x.days })) }; } },
  { id:'hr-quality', g:'HR', t:'Data quality checks',
    d:'Gaps that will cause wrong payslips or rejected bank transfers. Fix these before going live.',
    build:() => { const R=[], add=(issue,e)=>R.push({issue,code:e.id,name:empName(e),department:e.department});
      const pkg=new Set(S.fixed.filter(r=>fixedActive(r,settings.period)).map(r=>String(r.emp_id)));
      activeEmps().forEach(e=>{
        if(!pkg.has(String(e.id))) add('No fixed salary package this period',e);
        if(!num(e.hour_pay)) add('No hour pay — overtime falls back to basic ÷ days ÷ hours',e);
        const ins=String(e.insurance||'').toLowerCase()==='insured';
        if(ins && !e.insurance_number) add('Insured but no insurance number',e);
        if(ins && !num(e.insurance_amount)) add('Insured but insurable amount is zero',e);
        if(String(e.payment_method||'').toLowerCase()==='bank' && !e.bank_account) add('Paid by bank but no account number',e);
        if(!e.payment_method) add('No payment method',e);
        if(!e.national_id) add('Missing national ID',e);
        else if(String(e.nationality||'Egyptian').toLowerCase().startsWith('egypt') && !/^\d{14}$/.test(String(e.national_id))) add('National ID is not 14 digits',e);
        if(!e.department) add('No department',e);
        if(!e.manager_id && !e.top_of_org) add('No direct manager',e);
        if(S.attendance.some(a=>String(a.emp_id)===String(e.id) && attNoOut(a))) add('Missing phone check-out in this cycle',e);
      });
      return { cols:[C('issue','Issue','strong'),C('code','Code','id'),C('name','Employee'),C('department','Department')], rows:R,
        note:Object.entries(groupBy(R,r=>r.issue)).map(([k,L])=>`${k}: ${L.length}`).join(' · ') }; } },
];

let repCur = null, repData = null;
const MONEY_REPORT = r => r.g==='Payroll' || r.id==='prj-cost' || r.id==='prj-cost-detail';
const MONEY_COLS = ['rate','value','ded','mult'];
function reportAllowed(r){
  const role = ME && ME.role;
  if (role==='admin' || role==='finance') return true;
  if (role==='hr_officer' && MONEY_REPORT(r)) return false;
  const a = ME && ME.allowed_reports;
  return Array.isArray(a) ? a.includes(r.id) : true;          // no list saved yet = all (for HR); HR Officers start with an empty list
}
function renderReportList(){
  const mine = REPORTS.filter(reportAllowed), G=groupBy(mine, r=>r.g);
  if (repCur && !mine.some(r=>r.id===repCur)) { repCur=null; $('rep-view').style.display='none'; $('rep-empty').style.display='block'; }
  $('rep-list').innerHTML = Object.entries(G).map(([g,L]) => `<div class="nav-label">${esc(g)}</div>` +
    L.map(r=>`<div class="nav-item ${r.id===repCur?'active':''}" data-rep="${r.id}" style="font-size:12.5px">${esc(r.t)}</div>`).join('')).join('');
  if (!mine.length) $('rep-list').innerHTML = '<div style="padding:14px;font-size:13px;color:var(--muted)">No reports have been assigned to you yet. Ask the administrator.</div>';
  $('rep-sub').textContent = `${mine.length} report${mine.length===1?'':'s'} · period ${periodLabel(settings.period)} (change it in Settings) · all figures calculated live from the database`;
}
function openReport(id){
  const r0 = REPORTS.find(x=>x.id===id);
  if (!r0 || !reportAllowed(r0)) return toast('This report has not been assigned to you','warn');
  repCur=id; const r=r0;
  $('rep-empty').style.display='none'; $('rep-view').style.display='block';
  $('rep-title').textContent=r.t; $('rep-desc').textContent=r.d;
  $('rep-mode').style.display = r.param==='view' ? '' : 'none';
  $('rep-group').style.display = r.param==='group' ? '' : 'none';
  $('rep-q').value=''; renderReportList(); runReport();
}
function runReport(){
  if (!repCur) return;
  const r=REPORTS.find(x=>x.id===repCur), mode=repDatesMode(r);
  repDateBar(mode);
  const msg = t => { $('rep-head').innerHTML=''; $('rep-foot').innerHTML=''; $('rep-body').innerHTML=`<tr><td class="empty">${t}</td></tr>`; $('rep-note').textContent=''; repData=null; };
  const rg = mode==='range' ? repRange() : null;
  if (mode==='range' && rg.error) return msg(esc(rg.error));
  const D = mode==='range' ? repRangeData(rg) : null;
  if (D && D.wait) return msg(esc(D.wait));
  let data; try{ data=repWithData(D, () => r.build({ from:rg?rg.from:periodStart(settings.period), to:rg?rg.to:periodEnd(settings.period), group:$('rep-group').value||'department', view:$('rep-mode').value||'emp' })); }
  catch(e){ console.error(e); $('rep-body').innerHTML=`<tr><td class="empty">Could not build this report: ${esc(e.message)}</td></tr>`; return; }
  if (rg) data.rows = data.rows.filter(x => { const d = x._date || x.date; return !(typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d)) || (d.slice(0,10) >= rg.from && d.slice(0,10) <= rg.to); });
  const d=$('rep-dept').value, q=$('rep-q').value.trim().toLowerCase();
  data.rows = data.rows.filter(x => repOrgMatch(x) &&
                                    (!q || Object.values(x).some(v => typeof v!=='object' && String(v??'').toLowerCase().includes(q))));
  if (isOfficer()) data.cols = data.cols.filter(c => !MONEY_COLS.includes(c.k) && !PAY_FIELDS.includes(c.k));
  data.allCols = data.cols;                                        // ☰ Columns: the user's choice for this report
  const hide = repHiddenCols(r.id), kept = data.cols.filter(c => !hide.includes(c.k));
  data.cols = kept.length ? kept : data.cols.slice(0, 1);
  repData=data; renderRepColsBtn();
  const cell=(c,v)=>{ if(c.t==='link') return /^https?:/.test(String(v||'')) ? `<td><a class="maplink" href="${esc(v)}" target="_blank" rel="noopener">📍 Open map</a></td>` : `<td style="color:var(--muted)">no location</td>`;
    if(v===null||v===undefined||v==='') return `<td${c.t==='num'||c.t==='int'||c.t==='pct'?' class="num"':''}></td>`;
    if(c.t==='num') return `<td class="num">${fmt(v)}</td>`; if(c.t==='int') return `<td class="num">${Math.round(num(v))}</td>`;
    if(c.t==='pct') return `<td class="num">${(num(v)*100).toFixed(1)}%</td>`; if(c.t==='ar') return `<td class="ar">${esc(v)}</td>`;
    if(c.t==='link') return /^https?:/.test(String(v)) ? `<td><a class="maplink" href="${esc(v)}" target="_blank" rel="noopener">📍 Open map</a></td>` : `<td style="color:var(--muted)">no location</td>`;
    if(['id','mono','date'].includes(c.t)) return `<td class="mono">${esc(v)}</td>`; if(c.t==='strong') return `<td class="strong">${esc(v)}</td>`;
    return `<td style="white-space:normal;min-width:120px">${esc(v)}</td>`; };
  const numCls=c=>['num','int','pct'].includes(c.t)?' class="num"':'';
  $('rep-head').innerHTML = '<tr>'+data.cols.map(c=>`<th${numCls(c)}>${esc(c.l)}</th>`).join('')+'</tr>';
  const shown=data.rows.slice(0,1000);
  $('rep-body').innerHTML = shown.map(x=>'<tr>'+data.cols.map(c=>cell(c,x[c.k])).join('')+'</tr>').join('') || `<tr><td colspan="${data.cols.length}" class="empty">Nothing to report for this selection</td></tr>`;
  const hasSum=data.cols.some(c=>c.s);
  $('rep-foot').innerHTML = hasSum && data.rows.length ? '<tr>'+data.cols.map((c,i)=>{ if(c.s){ const t=data.rows.reduce((s,x)=>s+num(x[c.k]),0); return `<td class="num strong" style="border-top:1px solid var(--accent)">${c.t==='int'?Math.round(t):fmt(t)}</td>`; }
      return `<td class="strong" style="border-top:1px solid var(--accent)">${i===0?'Total':''}</td>`; }).join('')+'</tr>' : '';
  $('rep-note').textContent = `${data.rows.length} row${data.rows.length===1?'':'s'}${data.rows.length>1000?' (showing first 1,000 — the export contains all)':''}` + (data.note?' · '+data.note:'');
}
function exportReport(){
  if (!repData || !repData.rows.length) return toast('Nothing to export','warn');
  const r=REPORTS.find(x=>x.id===repCur);
  const q=v=>{ let s=String(v??''); if (/^[=+@\t\r]/.test(s) || /^-[^\d.]/.test(s)) s="'"+s;   // review fix: never let a cell run as an Excel formula
    return /[",\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s; };
  const val=(c,v)=>{ if(v===null||v===undefined) return '';
    if(c.t==='num') return (Math.round(num(v)*100)/100).toFixed(2); if(c.t==='int') return Math.round(num(v)); if(c.t==='pct') return (num(v)*100).toFixed(2);
    if((c.t==='id' && String(v).length>0) || /^\d{10,}$/.test(String(v).trim())) return `="${String(v).trim().replace(/"/g,'')}"`;   // keeps codes and long numbers (national ID, mobile…) as text in Excel
    return v; };
  const lines=[repData.cols.map(c=>q(c.l)).join(','), ...repData.rows.map(x=>repData.cols.map(c=>{ const v=val(c,x[c.k]); return String(v).startsWith('="')?v:q(v); }).join(','))];
  const extra = (repDatesMode(r)==='range' && !repRange().error ? `-${repRange().from}-to-${repRange().to}` : '-'+settings.period) + (r.param==='group' ? '-'+$('rep-group').value : r.param==='view' ? '-'+$('rep-mode').value : '');
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob(['\uFEFF'+lines.join('\n')],{type:'text/csv;charset=utf-8'}));
  a.download=`petrokima-${r.id}${extra}.csv`; a.click(); toast('Report exported');
}
function renderReports(){ renderReportList(); if (repCur) runReport(); }

$('rep-list').addEventListener('click', e => { const i=e.target.closest('[data-rep]'); if(i) openReport(i.dataset.rep); });
['rep-mode','rep-group','rep-dept'].forEach(id => $(id).addEventListener('change', runReport));
$('rep-q').addEventListener('input', runReport);
$('rep-export').addEventListener('click', exportReport);

// ── ☰ Columns: choose which columns a report shows and exports (remembered per report on this computer) ──
function repHiddenCols(id){ try { return JSON.parse(localStorage.getItem('pk_repcols_' + id) || '[]'); } catch(e) { return []; } }
function renderRepColsBtn(){
  if (!repData || !repData.allCols) return;
  const hide = repHiddenCols(repCur), n = repData.allCols.filter(c => !hide.includes(c.k)).length;
  $('rep-cols-btn').textContent = n < repData.allCols.length ? `☰ Columns (${n} of ${repData.allCols.length})` : '☰ Columns';
  $('rep-cols-list').innerHTML = repData.allCols.map(c => `<label style="display:flex;gap:8px;align-items:center;padding:4px 2px;font-size:13px;cursor:pointer">
      <input type="checkbox" data-repcol="${esc(c.k)}" ${hide.includes(c.k) ? '' : 'checked'}> ${esc(c.l)}</label>`).join('');
}
function setRepHidden(list){ localStorage.setItem('pk_repcols_' + repCur, JSON.stringify(list)); runReport(); }
$('rep-cols-btn').addEventListener('click', e => { e.stopPropagation(); const p = $('rep-cols-pop'); p.style.display = p.style.display === 'none' ? 'block' : 'none'; });
$('rep-cols-pop').addEventListener('click', e => e.stopPropagation());
document.addEventListener('click', () => { const p = $('rep-cols-pop'); if (p) p.style.display = 'none'; });
$('rep-cols-list').addEventListener('change', () => {
  const hide = [.../** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll('#rep-cols-list [data-repcol]'))].filter(x => !x.checked).map(x => x.dataset.repcol);
  if (hide.length === repData.allCols.length) { toast('Keep at least one column','warn'); return renderRepColsBtn(); }
  setRepHidden(hide);
});
$('rep-cols-all').addEventListener('click', e => { e.preventDefault(); setRepHidden([]); });
$('rep-cols-none').addEventListener('click', e => { e.preventDefault(); setRepHidden(repData.allCols.slice(1).map(c => c.k)); });

// ═════════════════════════════════════════════════════════
//  PERMISSIONS (late arrival / early leave)
// ═════════════════════════════════════════════════════════
function monthOf(d){ return cycleOf(d); }   // quota follows the payroll cycle
function permUsed(empId, month, exceptId){
  return S.permissions.filter(p => String(p.emp_id)===String(empId) && p.status==='Approved' && monthOf(p.date)===month && p.id!==exceptId).length;
}
function renderPermissions(){
  const limit = num(settings.permissionsPerMonth)||2;
  $('perm-missing').innerHTML = permTableMissing ? '<div class="alert a-warn">The permissions table does not exist yet. Run <b>attendance-permissions.sql</b> in the database SQL Editor, then click ⟳ Refresh.</div>' : '';
  const pend = S.permissions.filter(readyForHR).length;
  $('perm-badge').style.display = pend ? '' : 'none'; $('perm-badge').textContent = pend;
  $('perm-sub').textContent = `Period ${periodLabel(settings.period)} · each employee may have ${limit} approved permission${limit>1?'s':''} per payroll cycle, up to ${settings.permissionMaxHours} h each · ${pend} pending`;
  const st=$('perm-status').value, q=$('perm-q').value.trim().toLowerCase();
  const list = S.permissions.filter(p => (!st || p.status===st) && orgMatch(empById(p.emp_id),'perm') &&
      (!q || [p.emp_id, empName(empById(p.emp_id)), (empById(p.emp_id)||{}).name_ar].some(v=>String(v||'').toLowerCase().includes(q))))
    .sort((a,b)=> (a.status==='Pending'?0:1)-(b.status==='Pending'?0:1) || String(b.date).localeCompare(String(a.date)));
  $('perm-tbl').innerHTML = list.map(p => { const e=empById(p.emp_id)||{}, used=permUsed(p.emp_id, monthOf(p.date));
    return `<tr><td class="mono">${esc(p.date)}</td><td class="strong">${esc(empName(e)||p.emp_id)} <span class="mono" style="color:var(--muted)">${esc(p.emp_id)}</span></td>
      <td>${esc(e.department)}</td><td>${esc(p.type)}</td><td class="num">${fmt(p.hours)}</td><td style="white-space:normal;min-width:140px">${esc(p.reason||'')}</td>
      <td><span class="chip ${used>=limit?'c-red':'c-grey'}">${used} of ${limit}</span></td><td>${esc(p.source||'')}</td>
      <td>${chip(p.status)}${mgrStep(p)}</td><td>${esc(p.decided_by||'')}${p.decision_note?`<div style="font-size:11px;color:var(--muted)">${esc(p.decision_note)}</div>`:''}</td>
      <td>${readyForHR(p) ? `<button class="btn btn-ghost btn-sm" data-decide="${p.id}">Decide</button>` : ''}
          <button class="icon-btn" data-del-perm="${p.id}" title="Delete">🗑</button></td></tr>`; }).join('')
    || `<tr><td colspan="11" class="empty">No ${st?st.toLowerCase()+' ':''}requests this period</td></tr>`;
  $('perm-foot').textContent = `${list.length} request${list.length===1?'':'s'} shown · approvals are limited by the database, so the mobile app follows the same rule`;
}
function permQuotaHint(){
  const emp=parseEmpInput($('pr-emp').value), d=$('pr-date').value, limit=num(settings.permissionsPerMonth)||2;
  if(!emp||!d){ $('pr-quota').innerHTML=''; return; }
  const used=permUsed(emp, monthOf(d));
  $('pr-quota').innerHTML = used>=limit ? `<span class="neg">This employee has already used ${used} of ${limit} permissions in ${monthOf(d)} — it can be saved as Pending but cannot be approved.</span>`
                                        : `<span class="pos">${used} of ${limit} permissions used in ${monthOf(d)}.</span>`;
}
function openPerm(){
  if (permTableMissing) return toast('Run attendance-permissions.sql first','warn');
  $('pr-emp').value=''; $('pr-date').value=todayStr(); $('pr-type').value='Late arrival';
  $('pr-hours').value=settings.permissionMaxHours; $('pr-max').textContent=`${settings.permissionMaxHours} h`; $('pr-status').value='Pending'; $('pr-reason').value='';
  permQuotaHint(); openM('m-perm'); setTimeout(()=>$('pr-emp').focus(),50);
}
async function savePerm(){
  const emp=parseEmpInput($('pr-emp').value); if(!emp) return toast('Pick an employee from the list','warn');
  const date=$('pr-date').value, hours=num($('pr-hours').value), max=num(settings.permissionMaxHours)||2;
  if(!date) return toast('Date is required','warn');
  if(hours<=0 || hours>max) return toast(`Hours must be between 0.25 and ${max}`,'warn');
  const rec={ emp_id:emp, date, type:$('pr-type').value, hours, reason:$('pr-reason').value.trim(), status:$('pr-status').value, source:'Desktop' };
  if (rec.status==='Approved'){ rec.decided_by = localStorage.getItem('approver') || 'HR'; rec.decided_at = new Date().toISOString(); }
  const { data, error } = await sb.from('attendance_permissions').insert(rec).select();
  if (error) return toast(error.message.includes('duplicate') ? 'This employee already has an open request of that type on that date' : error.message, 'err');
  if (!(data && data.length)) return toast(NOPERM,'err'); if (inPeriod(date)) S.permissions.push(data[0]);
  closeM('m-perm'); afterPermChange(); toast(rec.status==='Approved' ? 'Permission approved' : 'Request saved as Pending');
}
let deciding = null;
function openDecide(id){
  const p=S.permissions.find(x=>x.id===id); if(!p) return; deciding=p;
  const e=empById(p.emp_id)||{}, used=permUsed(p.emp_id, monthOf(p.date)), limit=num(settings.permissionsPerMonth)||2;
  const att=S.attendance.find(a=>String(a.emp_id)===String(p.emp_id) && a.date===p.date), R=att?dayRules(att,e):null;
  $('dc-body').innerHTML = `<b style="color:var(--text)">${esc(empName(e))}</b> (${esc(p.emp_id)}) · ${esc(e.department||'')}<br>
    ${esc(p.type)} on <b>${esc(p.date)}</b> for <b>${fmt(p.hours)} h</b>${p.reason?` — “${esc(p.reason)}”`:''}<br>
    ${att ? `Attendance that day: ${esc(att.check_in||'?')} → ${esc(att.check_out||'?')}, ${fmt(att.total_hours)} h${R?` · late ${fmt(R.lateRaw)} h · early ${fmt(R.earlyRaw)} h`:''}` : 'No attendance recorded for that day yet.'}<br>
    Approved this month: <span class="chip ${used>=limit?'c-red':'c-green'}">${used} of ${limit}</span>${used>=limit?' — <span class="neg">limit reached, approval will be refused</span>':''}`;
  $('dc-by').value = localStorage.getItem('approver') || ''; $('dc-note').value='';
  openM('m-decide');
}
async function decide(status){
  const by=$('dc-by').value.trim(); if(!by) return toast('Enter who is making the decision','warn');
  localStorage.setItem('approver', by);
  const upd={ status, decided_by:by, decided_at:new Date().toISOString(), decision_note:$('dc-note').value.trim()||null };
  const { data, error } = await sb.from('attendance_permissions').update(upd).eq('id', deciding.id).select();
  if (error) return toast(error.message.replace(/^.*?Monthly limit/,'Monthly limit'), 'err');
  if (!(data && data.length)) return toast(NOPERM,'err'); const i=S.permissions.findIndex(x=>x.id===deciding.id); S.permissions[i]=data[0];
  closeM('m-decide'); afterPermChange(); toast(status==='Approved' ? 'Approved — deduction waived' : 'Rejected');
}
function afterPermChange(){ renderPermissions(); renderAttendance(); renderPayroll(); renderDashboard(); renderReports(); }

$('perm-status').addEventListener('change', renderPermissions);
$('perm-q').addEventListener('input', renderPermissions);
['pr-emp','pr-date'].forEach(id=>$(id).addEventListener('input', permQuotaHint));
$('pr-save').addEventListener('click', savePerm);
$('dc-approve').addEventListener('click', ()=>decide('Approved'));
$('dc-reject').addEventListener('click', ()=>decide('Rejected'));
$('perm-tbl').addEventListener('click', e => {
  const d=e.target.closest('[data-decide]'); if(d) return openDecide(d.dataset.decide);
  const x=e.target.closest('[data-del-perm]');
  if(x){ const id=x.dataset.delPerm; confirmDel('Delete this permission request?', async()=>{ await del('attendance_permissions',id); S.permissions=S.permissions.filter(p=>p.id!==id); afterPermChange(); toast('Deleted'); }); }
});

// ═════════════════════════════════════════════════════════
//  LEAVE HELPERS
// ═════════════════════════════════════════════════════════
function dObj(s){ const [y,m,d]=String(s).split('-').map(Number); return new Date(y, m-1, d); }
function dStr(o){ return `${o.getFullYear()}-${pad(o.getMonth()+1)}-${pad(o.getDate())}`; }
function isHoliday(s){ return holidaySet.has(s); }
function holidayOn(s){ return S.holidays.find(h => h.date===s) || null; }
function isWorkday(s){ return !(settings.weekendDays||[]).includes(dObj(s).getDay()) && !isHoliday(s); }
function workdays(from, to){
  if (!from || !to || to < from) return 0;
  let n=0, d=dObj(from), end=dObj(to), guard=0;
  while (d <= end && guard++ < 800){ if (isWorkday(dStr(d))) n++; d.setDate(d.getDate()+1); }
  return n;
}
// Leave days of one leave record that fall between a and b (inclusive), pro-rated when HR edited the day count
function leaveDaysIn(l, a, b){
  const s = l.date_from > a ? l.date_from : a, e = l.date_to < b ? l.date_to : b;
  if (e < s) return 0;
  const full = workdays(l.date_from, l.date_to); if (!full) return 0;
  return Math.round(num(l.days) * workdays(s, e) / full * 100) / 100;
}
function leaveOn(empId, date){
  if (!date) return null;
  return S.leaves.find(l => l.status==='Approved' && String(l.emp_id)===String(empId) && l.date_from<=date && l.date_to>=date) || null;
}
function annualEntitlement(e){ return (e && e.annual_leave_days!==null && e.annual_leave_days!==undefined && e.annual_leave_days!=='') ? num(e.annual_leave_days) : num(settings.annualLeaveDefault); }
function annualTaken(empId, exceptId){
  const y = settings.period.slice(0,4), types = settings.casualCountsAnnual==='no' ? ['Annual'] : ['Annual','Casual'];
  return S.leaves.filter(l => String(l.emp_id)===String(empId) && l.status==='Approved' && types.includes(l.leave_type) && l.id!==exceptId)
                 .reduce((s,l)=>s+leaveDaysIn(l, `${y}-01-01`, `${y}-12-31`),0);
}

// ═════════════════════════════════════════════════════════
//  VACATIONS PAGE
// ═════════════════════════════════════════════════════════
function renderLeaves(){
  $('lv-missing').innerHTML = leaveTableMissing ? '<div class="alert a-warn">The vacations table does not exist yet. Run <b>vacations-and-exceptions.sql</b> in the database SQL Editor, then click ⟳ Refresh.</div>' : '';
  const scope=$('lv-scope').value, t=$('lv-type').value, d=$('lv-dept').value, q=$('lv-q').value.trim().toLowerCase();
  const ps=periodStart(settings.period), pe=periodEnd(settings.period);
  const base = S.leaves.filter(l => { const e=empById(l.emp_id)||{};
      return (scope==='year' || (l.date_from<=pe && l.date_to>=ps)) && (!t || l.leave_type===t) && orgMatch(e,'lv') &&
             (!q || [l.emp_id, e.name_en, e.name_ar].some(v=>String(v||'').toLowerCase().includes(q))); });
  const st = stFill('lv-stf', base.map(l => l.status));
  const list = base.filter(l => !st || l.status===st)
    .sort((a,b)=>String(b.date_from).localeCompare(String(a.date_from)));
  const inP = S.leaves.filter(l=>l.status==='Approved').reduce((s,l)=>s+leaveDaysIn(l,ps,pe),0);
  $('lv-sub').textContent = `${S.leaves.filter(l=>l.status==='Approved').length} approved vacations in ${settings.period.slice(0,4)} · ${fmt(inP)} leave days in ${settings.period} · weekends: ${(settings.weekendDays||[]).map(i=>DAYS[i]).join(', ')||'none'}`;
  $('lv-tbl').innerHTML = list.map(l => { const e=empById(l.emp_id)||{}, ip=leaveDaysIn(l,ps,pe);
    const tc = {Annual:'c-blue',Casual:'c-blue',Sick:'c-orange',Unpaid:'c-red','Other paid':'c-grey'}[l.leave_type]||'c-grey';
    return `<tr class="click" data-leave="${l.id}"><td class="strong">${esc(empName(e)||l.emp_id)} <span class="mono" style="color:var(--muted)">${esc(l.emp_id)}</span></td>
      <td>${esc(e.department)}</td><td><span class="chip ${tc}">${esc(l.leave_type)}</span></td><td class="mono">${esc(l.date_from)}</td><td class="mono">${esc(l.date_to)}</td>
      <td class="num">${fmt(l.days)}</td><td class="num">${ip?fmt(ip):'—'}</td><td style="white-space:normal;min-width:120px">${esc(l.reason||'')}</td>
      <td>${chip(l.status)}${mgrStep(l)}</td><td>${esc(l.decided_by||l.entered_by||'')}${l.source==='Self-service'?' <span class="chip c-blue">employee request</span>':''}</td>
      <td style="white-space:nowrap">${readyForHR(l)?`<button class="btn btn-success btn-sm" data-lv-approve="${l.id}">Approve</button> <button class="btn btn-ghost btn-sm" data-lv-reject="${l.id}">Reject</button> `:''}<button class="icon-btn" data-del-leave="${l.id}" title="Delete">🗑</button></td></tr>`; }).join('')
    || '<tr><td colspan="11" class="empty">No vacations for this selection</td></tr>';
  $('lv-foot').textContent = `${list.length} vacation${list.length===1?'':'s'} shown · click a row to edit`;
}
let editingLeave = null;
function leaveHint(){
  const emp=parseEmpInput($('lv-emp').value), e=empById(emp), f=$('lv-from').value, t=$('lv-to').value, type=$('lv-t').value;
  const out=[];
  if (f && t && t < f) out.push('<span class="neg">“To” is before “From”.</span>');
  if (f && t && t >= f){ const cal=Math.round((dObj(t)-dObj(f))/86400000)+1, wd=workdays(f,t);
    out.push(`${cal} calendar day${cal>1?'s':''}, ${wd} working day${wd===1?'':'s'} (weekends excluded).`); }
  if (e && (type==='Annual' || (type==='Casual' && settings.casualCountsAnnual!=='no'))){
    const ent=annualEntitlement(e), taken=annualTaken(emp, editingLeave), req=num($('lv-days').value), left=ent-taken-req;
    out.push(`Annual balance ${settings.period.slice(0,4)}: entitlement ${fmt(ent)} · taken ${fmt(taken)} · this request ${fmt(req)} → <b class="${left<0?'neg':'pos'}">${fmt(left)} remaining</b>${left<0?' — exceeds the balance':''}`);
  }
  if (type==='Unpaid' && e) out.push(`Unpaid: deducts ${fmt(num(e.daily_pay)||0)} (daily pay) per day in the payroll period it falls in.`);
  if (e && f && t) { const clash=S.leaves.find(l=>l.id!==editingLeave && l.status==='Approved' && String(l.emp_id)===emp && l.date_from<=t && l.date_to>=f);
    if (clash) out.push(`<span class="neg">Overlaps an approved ${esc(clash.leave_type)} leave ${clash.date_from} → ${clash.date_to}.</span>`); }
  $('lv-hint').innerHTML = out.join('<br>');
}
function recalcLeaveDays(){ const f=$('lv-from').value, t=$('lv-to').value; if (f && t && t>=f) $('lv-days').value = workdays(f,t); leaveHint(); }
function openLeave(l){
  if (leaveTableMissing) return toast('Run vacations-and-exceptions.sql first','warn');
  editingLeave = l ? l.id : null; $('lv-m-title').textContent = l ? 'Edit vacation' : 'Add vacation';
  const e = l ? empById(l.emp_id) : null;
  $('lv-emp').value = l ? `${l.emp_id} — ${empName(e)}` : '';
  $('lv-t').value = l ? l.leave_type : 'Annual'; $('lv-status').value = l ? l.status : 'Approved';
  $('lv-from').value = l ? l.date_from : todayStr(); $('lv-to').value = l ? l.date_to : todayStr();
  $('lv-days').value = l ? l.days : workdays(todayStr(), todayStr());
  $('lv-by').value = l ? (l.entered_by||'') : (localStorage.getItem('approver')||''); $('lv-reason').value = l ? (l.reason||'') : '';
  leaveHint(); openM('m-leave'); if(!l) setTimeout(()=>$('lv-emp').focus(),50);
}
async function saveLeave(){
  const emp=parseEmpInput($('lv-emp').value); if(!emp) return toast('Pick an employee from the list','warn');
  const f=$('lv-from').value, t=$('lv-to').value; if(!f||!t) return toast('From and To dates are required','warn');
  if (t < f) return toast('“To” cannot be before “From”','warn');
  const days=num($('lv-days').value); if (days<=0) return toast('Leave days must be more than zero','warn');
  const by=$('lv-by').value.trim(); if (by) localStorage.setItem('approver', by);
  const rec={ emp_id:emp, leave_type:$('lv-t').value, date_from:f, date_to:t, days, status:$('lv-status').value, reason:$('lv-reason').value.trim()||null, entered_by:by||null, source:'Desktop' };
  const btn=$('lv-save'); btn.disabled=true;
  const res = editingLeave ? await sb.from('employee_leaves').update(rec).eq('id',editingLeave).select()
                           : await sb.from('employee_leaves').insert(rec).select();
  btn.disabled=false;
  if (res.error) return toast(res.error.message.replace(/^.*?(Overlaps)/,'$1'),'err');
  if (!(res.data && res.data.length)) return toast(NOPERM,'err'); const saved=res.data[0]; S.leaves = S.leaves.filter(x=>x.id!==saved.id);
  const y=settings.period.slice(0,4); if (saved.date_from<=`${y}-12-31` && saved.date_to>=`${y}-01-01`) S.leaves.push(saved);
  closeM('m-leave'); afterLeaveChange(); toast(editingLeave ? 'Vacation updated' : 'Vacation added');
}
function afterLeaveChange(){ renderLeaves(); renderAttendance(); renderPayroll(); renderDashboard(); renderReports(); }

$('lv-tbl').addEventListener('click', e => {
  const ap=e.target.closest('[data-lv-approve]'), rj=e.target.closest('[data-lv-reject]');
  if (ap || rj) return decideLeave((ap||rj).dataset[ap?'lvApprove':'lvReject'], ap ? 'Approved' : 'Rejected');
  const x=e.target.closest('[data-del-leave]');
  if (x){ const id=x.dataset.delLeave; return confirmDel('Delete this vacation?', async()=>{ await del('employee_leaves',id); S.leaves=S.leaves.filter(l=>l.id!==id); afterLeaveChange(); toast('Deleted'); }); }
  const r=e.target.closest('[data-leave]'); if (r){ const l=S.leaves.find(x=>x.id===r.dataset.leave); if(l) openLeave(l); }
});
['lv-scope','lv-type','lv-dept'].forEach(id=>$(id).addEventListener('change', renderLeaves));
$('lv-q').addEventListener('input', renderLeaves);
['lv-from','lv-to'].forEach(id=>$(id).addEventListener('change', recalcLeaveDays));
['lv-emp','lv-t','lv-days'].forEach(id=>$(id).addEventListener('input', leaveHint));
$('lv-save').addEventListener('click', saveLeave);

// ═════════════════════════════════════════════════════════
//  EXCEPTION RULE PAGE
// ═════════════════════════════════════════════════════════
let exOnSel = new Set(), exOffSel = new Set();
let EX_FIELD = 'attendance_exempt';
function renderExempt(){
  const act = activeEmps(), q1=$('ex-on-q').value.trim().toLowerCase();
  const match = (e,q) => !q || [e.id,e.name_ar,e.name_en,e.job_name].some(v=>String(v||'').toLowerCase().includes(q));
  const on = act.filter(e=>e[EX_FIELD]).sort((a,b)=>String(a.department).localeCompare(String(b.department))||String(a.job_name).localeCompare(String(b.job_name)));
  const onShown = on.filter(e=>match(e,q1));
  exOnSel = new Set([...exOnSel].filter(id=>on.some(e=>String(e.id)===id)));
  $('ex-on-title').textContent = `${EX_FIELD==='project_staff' ? 'Site staff' : 'On the exception rule'} (${on.length})`;
  $('ex-sub').textContent = EX_FIELD==='project_staff' ? 'Site staff must check in at a project from the phone. Their fingerprint-machine punches are kept as records only and do not count.' : 'Employees here get no delay deduction and no overtime';
  $('ex-on-tbl').innerHTML = onShown.map(e=>`<tr><td><input type="checkbox" data-ex-on="${esc(e.id)}" ${exOnSel.has(String(e.id))?'checked':''}></td><td class="mono">${esc(e.id)}</td>
    <td class="ar">${esc(e.name_ar)}</td><td class="strong">${esc(e.name_en)}</td><td>${esc(e.department)}</td><td>${esc(e.job_name)}</td>
    <td><button class="btn btn-ghost btn-sm" data-ex-rm="${esc(e.id)}">Remove</button></td></tr>`).join('')
    || '<tr><td colspan="7" class="empty">Nobody is on the exception rule</td></tr>';
  $('ex-remove-sel').disabled = !exOnSel.size; $('ex-remove-sel').textContent = exOnSel.size ? `Remove selected (${exOnSel.size})` : 'Remove selected';
  const q=$('ex-q').value.trim().toLowerCase(), job=$('ex-job').value.trim().toLowerCase(), d=$('ex-dept').value;
  const off = act.filter(e=>!e[EX_FIELD] && match(e,q) && (!job || String(e.job_name||'').toLowerCase().includes(job)) && orgMatch(e,'ex'));
  exOffSel = new Set([...exOffSel].filter(id=>act.some(e=>String(e.id)===id && !e[EX_FIELD])));
  $('ex-off-tbl').innerHTML = off.slice(0,500).map(e=>`<tr><td><input type="checkbox" data-ex-off="${esc(e.id)}" ${exOffSel.has(String(e.id))?'checked':''}></td><td class="mono">${esc(e.id)}</td>
    <td class="ar">${esc(e.name_ar)}</td><td class="strong">${esc(e.name_en)}</td><td>${esc(e.department)}</td><td>${esc(e.job_name)}</td></tr>`).join('')
    || '<tr><td colspan="6" class="empty">No employees match</td></tr>';
  $('ex-off-all').checked = off.length>0 && off.every(e=>exOffSel.has(String(e.id)));
  $('ex-add-sel').disabled = !exOffSel.size; $('ex-add-sel').textContent = exOffSel.size ? `Add selected (${exOffSel.size})` : 'Add selected';
  $('ex-foot').textContent = `${off.length} active employee${off.length===1?'':'s'} not ${EX_FIELD==='project_staff' ? 'marked as site staff' : 'on the rule'} match these filters${off.length>500?' (showing 500)':''} · tick the box in the header to select all shown`;
}
async function setExempt(ids, value){
  if (!ids.length) return;
  try{
    let changed = 0;
    await chunked(ids, async chunk => { const r = await sb.from('employees').update({ [EX_FIELD]:value }).in('id', chunk).select('id'); changed += (r.data||[]).length; return r; }, 200);
    if (!changed) throw new Error(NOPERM);
    S.employees.forEach(e => { if (ids.includes(String(e.id))) e[EX_FIELD] = value; });
    exOnSel.clear(); exOffSel.clear();
    renderExempt(); renderEmployees(); renderAttendance(); renderPayroll(); renderDashboard(); renderReports();
    toast(`${ids.length} employee${ids.length>1?'s':''} ${value?'added to':'removed from'} ${EX_FIELD==='project_staff' ? 'site staff' : 'the exception rule'}`);
  }catch(e){ toast(e.message,'err'); }
}
$('ex-on-tbl').addEventListener('change', e => { const c=e.target.closest('[data-ex-on]'); if(!c) return; c.checked?exOnSel.add(c.dataset.exOn):exOnSel.delete(c.dataset.exOn); renderExempt(); });
$('ex-off-tbl').addEventListener('change', e => { const c=e.target.closest('[data-ex-off]'); if(!c) return; c.checked?exOffSel.add(c.dataset.exOff):exOffSel.delete(c.dataset.exOff); renderExempt(); });
$('ex-on-tbl').addEventListener('click', e => { const b=e.target.closest('[data-ex-rm]'); if(b) setExempt([b.dataset.exRm], false); });
$('ex-on-all').addEventListener('change', e => { document.querySelectorAll('[data-ex-on]').forEach(c=>{ e.target.checked?exOnSel.add(c.dataset.exOn):exOnSel.delete(c.dataset.exOn); }); renderExempt(); });
$('ex-off-all').addEventListener('change', e => { document.querySelectorAll('[data-ex-off]').forEach(c=>{ e.target.checked?exOffSel.add(c.dataset.exOff):exOffSel.delete(c.dataset.exOff); }); renderExempt(); });
$('ex-remove-sel').addEventListener('click', () => confirmDel(EX_FIELD==='project_staff' ? `Remove ${exOnSel.size} employee${exOnSel.size>1?'s':''} from site staff? Their fingerprint-machine punches will count again and they may check in without a project.` : `Remove ${exOnSel.size} employee${exOnSel.size>1?'s':''} from the exception rule? They will get overtime and delay deductions again.`, ()=>setExempt([...exOnSel], false)));
$('ex-kind').addEventListener('change', () => { EX_FIELD = $('ex-kind').value; exOnSel = new Set(); exOffSel = new Set(); renderExempt(); });
$('ex-add-sel').addEventListener('click', () => setExempt([...exOffSel], true));
['ex-q','ex-job','ex-on-q'].forEach(id=>$(id).addEventListener('input', renderExempt));
$('ex-dept').addEventListener('change', renderExempt);

// ═════════════════════════════════════════════════════════
//  PENALTIES
// ═════════════════════════════════════════════════════════
function penaltyValue(x, emp, dailyRate, hourRate){
  emp = emp || empById(x.emp_id); if (!emp) return x.penalty_type==='Amount' ? num(x.quantity) : 0;
  const R = (dailyRate===undefined || hourRate===undefined) ? empRates(emp) : null;
  const d = dailyRate ?? R.daily, h = hourRate ?? R.hourly;
  if (x.penalty_type==='Hours') return num(x.quantity) * h;
  if (x.penalty_type==='Days')  return num(x.quantity) * d;
  return num(x.quantity);
}
function penLabel(x){ return x.penalty_type==='Amount' ? `${fmt(x.quantity)} EGP` : `${fmt(x.quantity)} ${x.penalty_type==='Hours'?'hour':'day'}${num(x.quantity)===1?'':'s'}`; }
function renderPenalties(){
  $('pn-missing').innerHTML = penTableMissing ? '<div class="alert a-warn">The penalties table does not exist yet. Run <b>absence-penalties-holidays.sql</b> in the database SQL Editor, then click ⟳ Refresh.</div>' : '';
  const scope=$('pn-scope').value, st=$('pn-status').value, q=$('pn-q').value.trim().toLowerCase();
  const list = S.penalties.filter(x => { const e=empById(x.emp_id)||{};
      return (scope==='year' || x.apply_period===settings.period) && (!st || x.status===st) && orgMatch(e,'pn') &&
             (!q || [x.emp_id,e.name_en,e.name_ar].some(v=>String(v||'').toLowerCase().includes(q))); })
    .sort((a,b)=>String(b.incident_date).localeCompare(String(a.incident_date)));
  const thisP = S.penalties.filter(x=>x.status==='Approved' && x.apply_period===settings.period);
  $('pn-sub').textContent = `${thisP.length} approved penalt${thisP.length===1?'y':'ies'} deducted in the ${periodLabel(settings.period)} payroll · total ${fmt(thisP.reduce((s,x)=>s+penaltyValue(x),0))} EGP`;
  $('pn-tbl').innerHTML = list.map(x => { const e=empById(x.emp_id)||{};
    return `<tr class="click" data-pen="${x.id}"><td class="mono">${esc(x.incident_date)}</td><td class="strong">${esc(empName(e)||x.emp_id)} <span class="mono" style="color:var(--muted)">${esc(x.emp_id)}</span></td>
      <td>${esc(e.department)}</td><td>${esc(penLabel(x))}</td><td class="num neg">${fmt(penaltyValue(x))}</td><td class="mono">${esc(x.apply_period)}</td>
      <td style="white-space:normal;min-width:140px">${esc(x.reason||'')}</td><td>${esc(x.requested_by||'')}</td><td>${esc(x.recorded_by||'')}</td><td>${chip(x.status)}</td>
      <td><button class="icon-btn" data-del-pen="${x.id}" title="Delete">🗑</button></td></tr>`; }).join('')
    || '<tr><td colspan="11" class="empty">No penalties for this selection</td></tr>';
  $('pn-foot').textContent = `${list.length} shown · amounts for hours and days use the employee's own hour pay and daily pay · click a row to edit`;
}
let editingPen = null;
function penHint(){
  const t=$('pn-type').value; $('pn-qty-l').textContent = t==='Amount' ? 'Amount (EGP)' : t==='Hours' ? 'Number of hours' : 'Number of days';
  const e=empById(parseEmpInput($('pn-emp').value)), qty=num($('pn-qty').value), out=[];
  if (e && qty){ const v=penaltyValue({penalty_type:t, quantity:qty}, e);
    const R=empRates(e);
    out.push(`Deduction: <b class="neg">${fmt(v)} EGP</b>${t==='Hours'?` (${fmt(qty)} h × hour pay ${fmt(R.hourly)})`:t==='Days'?` (${fmt(qty)} d × daily pay ${fmt(R.daily)})`:''}`);
    if ((t==='Hours' && R.hourlyFromBasic) || (t==='Days' && R.dailyFromBasic)) out.push(`<span style="color:var(--warn)">No ${t==='Hours'?'hour':'daily'} pay on file for this employee — calculated from basic salary ÷ ${num(settings.daysPerMonth)||30}${t==='Hours'?' ÷ '+(num(settings.hoursPerDay)||8):''}.</span>`); }
  const d=$('pn-date').value, per=$('pn-period').value;
  if (d && per && per!==cycleOf(d)) out.push(`The incident belongs to the ${cycleOf(d)} payroll; it will be deducted in <b>${per}</b> instead.`);
  if (e && per){ const same=S.penalties.filter(x=>x.id!==editingPen && String(x.emp_id)===String(e.id) && x.status==='Approved' && x.apply_period===per);
    if (same.length) out.push(`Already ${same.length} approved penalt${same.length===1?'y':'ies'} for this employee in ${per}: ${fmt(same.reduce((s,x)=>s+penaltyValue(x),0))} EGP.`); }
  $('pn-hint').innerHTML = out.join('<br>');
}
function openPen(x){
  if (penTableMissing) return toast('Run absence-penalties-holidays.sql first','warn');
  editingPen = x ? x.id : null; $('pn-m-title').textContent = x ? 'Edit penalty' : 'Record penalty';
  const e = x ? empById(x.emp_id) : null;
  $('pn-emp').value = x ? `${x.emp_id} — ${empName(e)}` : '';
  $('pn-date').value = x ? x.incident_date : todayStr(); $('pn-period').value = x ? x.apply_period : cycleOf(todayStr());
  $('pn-type').value = x ? x.penalty_type : 'Days'; $('pn-qty').value = x ? x.quantity : '';
  $('pn-req').value = x ? (x.requested_by||'') : ''; $('pn-rec').value = x ? (x.recorded_by||'') : (localStorage.getItem('approver')||'');
  $('pn-st').value = x ? x.status : 'Approved'; $('pn-reason').value = x ? (x.reason||'') : '';
  penHint(); openM('m-pen'); if(!x) setTimeout(()=>$('pn-emp').focus(),50);
}
async function savePen(){
  const emp=parseEmpInput($('pn-emp').value); if(!emp) return toast('Pick an employee from the list','warn');
  const d=$('pn-date').value, per=$('pn-period').value, qty=num($('pn-qty').value);
  if(!d||!per) return toast('Incident date and payroll month are required','warn');
  if(qty<=0) return toast('Enter an amount, hours or days greater than zero','warn');
  if(!$('pn-req').value.trim()) return toast('Enter the manager who requested the penalty','warn');
  const rec=$('pn-rec').value.trim(); if(rec) localStorage.setItem('approver', rec);
  const row={ emp_id:emp, incident_date:d, apply_period:per, penalty_type:$('pn-type').value, quantity:qty,
    requested_by:$('pn-req').value.trim(), recorded_by:rec||null, status:$('pn-st').value, reason:$('pn-reason').value.trim()||null };
  const btn=$('pn-save'); btn.disabled=true;
  const res = editingPen ? await sb.from('employee_penalties').update(row).eq('id',editingPen).select() : await sb.from('employee_penalties').insert(row).select();
  btn.disabled=false;
  if (res.error) return toast(res.error.message,'err');
  if (!(res.data && res.data.length)) return toast(NOPERM,'err'); const saved=res.data[0]; S.penalties=S.penalties.filter(x=>x.id!==saved.id);
  if (saved.apply_period.slice(0,4)===settings.period.slice(0,4)) S.penalties.push(saved);
  closeM('m-pen'); afterPenChange(); toast(editingPen ? 'Penalty updated' : 'Penalty recorded');
}
function afterPenChange(){ renderPenalties(); renderPayroll(); renderDashboard(); renderReports(); }
$('pn-tbl').addEventListener('click', e => {
  const x=e.target.closest('[data-del-pen]');
  if (x){ const id=x.dataset.delPen; return confirmDel('Delete this penalty?', async()=>{ await del('employee_penalties',id); S.penalties=S.penalties.filter(p=>p.id!==id); afterPenChange(); toast('Deleted'); }); }
  const r=e.target.closest('[data-pen]'); if(r){ const p=S.penalties.find(z=>z.id===r.dataset.pen); if(p) openPen(p); }
});
['pn-scope','pn-status'].forEach(id=>$(id).addEventListener('change', renderPenalties));
$('pn-q').addEventListener('input', renderPenalties);
['pn-emp','pn-qty','pn-type','pn-period'].forEach(id=>$(id).addEventListener('input', penHint));
$('pn-date').addEventListener('change', () => { $('pn-period').value = cycleOf($('pn-date').value); penHint(); });
$('pn-save').addEventListener('click', savePen);

// ═════════════════════════════════════════════════════════
//  PUBLIC HOLIDAYS
// ═════════════════════════════════════════════════════════
function renderHolidays(){
  $('hd-missing').innerHTML = holTableMissing ? '<div class="alert a-warn">The holidays table does not exist yet. Run <b>absence-penalties-holidays.sql</b> in the database SQL Editor, then click ⟳ Refresh.</div>' : '';
  const years = [...new Set([settings.period.slice(0,4), String(Number(settings.period.slice(0,4))+1), ...S.holidays.map(h=>h.date.slice(0,4))])].sort();
  const cur = $('hd-year').value || settings.period.slice(0,4);
  $('hd-year').innerHTML = years.map(y=>`<option ${y===cur?'selected':''}>${y}</option>`).join('');
  const list = S.holidays.filter(h=>h.date.startsWith(cur)).sort((a,b)=>a.date.localeCompare(b.date));
  $('hd-sub').textContent = `${list.length} holiday day${list.length===1?'':'s'} in ${cur}`;
  $('hd-tbl').innerHTML = list.map(h => { const worked = new Set(S.attendance.filter(a=>a.date===h.date && (a.status==='Present'||a.status==='Half Day')).map(a=>a.emp_id)).size;
    const inLoaded = h.date>=periodStart(settings.period) && h.date<=periodEnd(settings.period);
    return `<tr><td class="mono">${esc(h.date)}</td><td>${DAYS[dObj(h.date).getDay()]}</td><td class="strong">${esc(h.name)}</td><td class="mono">${cycleOf(h.date)}</td>
      <td class="num">${inLoaded ? (worked||'—') : '<span style="color:var(--muted)">other period</span>'}</td>
      <td><button class="icon-btn" data-del-hol="${h.id}" title="Delete">🗑</button></td></tr>`; }).join('')
    || `<tr><td colspan="6" class="empty">No public holidays entered for ${cur}</td></tr>`;
}
function holHint(){
  const d=$('hd-date').value, n=Math.max(1,Math.min(10,num($('hd-days').value)||1)); if(!d){ $('hd-hint').textContent=''; return; }
  const dates=[]; const o=dObj(d); for(let i=0;i<n;i++){ dates.push(dStr(o)); o.setDate(o.getDate()+1); }
  const dup=dates.filter(x=>isHoliday(x));
  $('hd-hint').innerHTML = `Adds: ${dates.map(x=>`${x} (${DAYS[dObj(x).getDay()]})`).join(', ')}` + (dup.length?`<br><span class="neg">Already a holiday: ${dup.join(', ')} — these will be skipped.</span>`:'');
}
function openHol(){
  if (holTableMissing) return toast('Run absence-penalties-holidays.sql first','warn');
  $('hd-date').value=''; $('hd-days').value=1; $('hd-name').value=''; holHint(); openM('m-hol');
}
async function saveHol(){
  const d=$('hd-date').value, name=$('hd-name').value.trim(), n=Math.max(1,Math.min(10,num($('hd-days').value)||1));
  if(!d||!name) return toast('Date and name are required','warn');
  const rows=[]; const o=dObj(d); for(let i=0;i<n;i++){ const s=dStr(o); if(!isHoliday(s)) rows.push({ date:s, name }); o.setDate(o.getDate()+1); }
  if(!rows.length) return toast('Those dates are already holidays','warn');
  const { data, error } = await sb.from('public_holidays').insert(rows).select();
  if (error) return toast(error.message,'err');
  S.holidays.push(...data); holidaySet = new Set(S.holidays.map(h=>h.date)); $('hd-year').value = d.slice(0,4);
  closeM('m-hol'); afterHolChange(); toast(`${data.length} holiday day${data.length>1?'s':''} added`);
}
function afterHolChange(){ renderHolidays(); renderLeaves(); renderAttendance(); renderPayroll(); renderDashboard(); renderReports(); }
$('hd-year').addEventListener('change', renderHolidays);
['hd-date','hd-days'].forEach(id=>$(id).addEventListener('input', holHint));
$('hd-save').addEventListener('click', saveHol);
$('hd-tbl').addEventListener('click', e => { const x=e.target.closest('[data-del-hol]');
  if (x){ const id=x.dataset.delHol; confirmDel('Delete this public holiday? Leave day counts already saved are not changed.', async()=>{ await del('public_holidays',id); S.holidays=S.holidays.filter(h=>h.id!==id); holidaySet=new Set(S.holidays.map(h=>h.date)); afterHolChange(); toast('Deleted'); }); } });

let SUPER = {};
let ACCT_FLAGS = {};
// ═════════════════════════════════════════════════════════
//  USERS & ROLES (admin only)
// ═════════════════════════════════════════════════════════
let USERS = [];
async function loadUsers(){
  if (!ME || ME.role!=='admin') return;
  const { data, error } = await sb.rpc('admin_list_users');
  if (error){ $('us-tbl').innerHTML = `<tr><td colspan="7" class="empty">${esc(error.message)}</td></tr>`; return; }
  USERS = data || [];
  const fl = await sb.from('app_users').select('id,acct_reports,super_admin');           // who may open Project cost reports · who is super admin
  ACCT_FLAGS = Object.fromEntries((fl.data || []).map(x => [x.id, !!x.acct_reports]));
  SUPER = Object.fromEntries((fl.data || []).map(x => [x.id, !!x.super_admin]));
  renderUsers();
}
function renderUsers(){
  const roles = ['','admin','hr','hr_officer','employee'];
  const q=$('us-q').value.trim().toLowerCase(), rf=$('us-role').value, st=$('us-state').value;
  const withLogin = new Set(USERS.map(u=>String(u.emp_id||'')).filter(Boolean));
  const gap = S.employees.filter(e=>e.status!=='Inactive' && !withLogin.has(String(e.id))).length;
  $('us-gap').innerHTML = gap ? `<b>${gap}</b> active employee${gap>1?'s':''} ha${gap>1?'ve':'s'} no login yet.` : 'Every active employee has a login.';
  const list = USERS.filter(u => (!q || [u.email,u.full_name,u.emp_id].some(v=>String(v||'').toLowerCase().includes(q))) &&
      (!rf || (rf==='none' ? !u.role : u.role===rf)) &&
      (!st || (st==='pending' && u.active && u.must_change_password) || (st==='locked' && !u.active) || (st==='ready' && u.active && !u.must_change_password)));
  const pend = USERS.filter(u=>u.active && u.must_change_password).length;
  $('us-count').textContent = `${USERS.length} users · ${pend} still to set a password · showing ${Math.min(list.length,300)}${list.length>300?' of '+list.length:''}`;
  $('us-tbl').innerHTML = list.slice(0,300).map(u => { const me = u.id===ME.id;
    const pw = !u.active ? '<span class="chip c-red">locked</span>' : u.must_change_password ? '<span class="chip c-orange">not set yet</span>' : '<span class="chip c-green">set</span>';
    return `<tr data-uid="${u.id}">
      <td class="strong" title="${esc(u.email)}">${/@petrokima\.local$/i.test(u.email||'') ? esc(u.email.replace(/@petrokima\.local$/i,'')) + ' <span style="font-weight:400;font-size:11px;color:var(--label)">code</span>' : esc(u.email)}${me?' <span class="chip c-blue">you</span>':''}</td>
      <td><input class="inp" style="width:170px" data-u="name" value="${esc(u.full_name||'')}"></td>
      <td><select class="sel" data-u="role" ${me?'disabled':''}>${roles.map(r=>`<option value="${r}" ${r===(u.role||'')?'selected':''}>${r?ROLE_LABEL[r]:'— no access —'}</option>`).join('')}</select></td>
      <td><input class="inp" style="width:200px" list="dl-emp-all" data-u="emp" placeholder="Code — name" value="${u.emp_id?esc(u.emp_id+' — '+empName(empById(u.emp_id))):''}"></td>
      <td><input type="checkbox" data-u="active" ${u.active?'checked':''} ${me?'disabled':''}></td>
      <td style="text-align:center"><input type="checkbox" data-u-acct="${u.id}" ${ACCT_FLAGS[u.id]?'checked':''} title="Project cost reports (totals per project, no names)"></td>
      <td>${pw}</td>
      <td style="white-space:nowrap">${typeof twoStepCell === 'function' ? twoStepCell(u) : ''}</td>
      <td class="mono">${u.last_sign_in_at ? esc(String(u.last_sign_in_at).slice(0,16).replace('T',' ')) : '<span style="color:var(--muted)">never</span>'}</td>
      <td style="white-space:nowrap"><button class="btn btn-primary btn-sm" data-u-save>Save</button>${me?'':` <button class="btn btn-ghost btn-sm" data-u-reset title="Reset to the temporary password">Reset password</button> <button class="btn btn-ghost btn-sm" data-u-random title="Give this person a new random one-time password (they then enter their year of birth and choose their own password)">🎲 Random password</button>`}${['hr','hr_officer'].includes(u.role) ? ` <button class="btn btn-ghost btn-sm" data-u-reps title="Choose which reports this user can open">📊 Reports (${Array.isArray(u.allowed_reports) ? u.allowed_reports.length : 'all'})</button>` : ''}</td></tr>`; }).join('')
    || '<tr><td colspan="10" class="empty">No users match</td></tr>';
  let dl = document.getElementById('dl-emp-all');
  if (!dl){ dl=document.createElement('datalist'); dl.id='dl-emp-all'; document.body.appendChild(dl); }
  if (dl.options.length !== S.employees.length) dl.innerHTML = S.employees.map(e=>`<option value="${esc(e.id)} — ${esc(empName(e))}"></option>`).join('');
}
async function createLogins(){
  const temp=$('us-temp').value, onlyTxt=$('us-only').value.trim(), only = onlyTxt ? onlyTxt.split(' — ')[0].trim() : null;
  if (temp && temp.length < 8) return toast('A typed temporary password must be at least 8 characters — or leave the box empty to use the standard first password (HR procedure)','warn');
  if (only && !empById(only)) return toast(`Employee "${only}" not found`,'warn');
  const withLogin = new Set(USERS.map(u=>String(u.emp_id||'')).filter(Boolean));
  const waiting = only ? 1 : S.employees.filter(e=>e.status!=='Inactive' && !withLogin.has(String(e.id))).length;
  const target = only ? `employee ${only}` : `${waiting} active employee${waiting===1?'':'s'} without a login`;
  confirmDel(`Create logins for ${target}? New logins start switched OFF: tick “Active” for an employee when you give him his login. They will sign in with their employee code and ${temp ? 'the temporary password you typed' : 'the standard first password from the HR procedure (employees without a national ID are skipped)'}, then must choose their own password. Logins are created in batches of 25 — keep this window open until it finishes.`, async () => {
    const b=$('us-create'); b.disabled=true; let total=0, rounds=0;
    try{
      while (rounds++ < 200){
        b.textContent = only ? 'Creating…' : (waiting > total ? `Creating… ${total} of ${waiting}` : `Creating… ${total} created`);
        const { data, error } = await sb.rpc('create_employee_logins', { p_password: temp || null, p_only_emp: only, p_limit: 25 });
        if (error) throw error;
        total += num(data);
        if (!num(data) || only) break;
      }
    } catch(e){
      toast(`Stopped after ${total} login${total===1?'':'s'}: ${e.message}. Click the button again to continue — nothing is duplicated.`,'err');
      b.disabled=false; b.textContent='Create employee logins'; await loadUsers(); return;
    }
    b.disabled=false; b.textContent='Create employee logins'; $('us-only').value='';
    await loadUsers();
    const left = only ? 0 : S.employees.filter(e=>e.status!=='Inactive' && !new Set(USERS.map(u=>String(u.emp_id||''))).has(String(e.id))).length;
    toast(total ? `Created ${total} login${total>1?'s':''} — switched OFF until you tick “Active” when you hand the login to the employee${left?` · ${left} could not be created (a login with that code already exists)`:''}` : 'Nothing to create — they already have logins', left ? 'warn' : 'ok');
  });
  $('del-title').textContent='Please confirm'; $('del-ok').textContent='Create'; $('del-ok').className='btn btn-success';
}
async function resetUser(tr){
  const u=USERS.find(x=>x.id===tr.dataset.uid), temp=$('us-temp').value;
  if (temp && temp.length < 8) { $('us-temp').focus(); return toast('A typed temporary password must be at least 8 characters — or leave the box empty','warn'); }
  confirmDel(`Reset ${u.email}? ${temp ? 'Their password becomes the one you typed.' : 'Their password goes back to the standard first password (HR procedure).'} They must choose a new password at next sign-in.`, async () => {
    const { error } = await sb.rpc('admin_reset_password', { p_user:u.id, p_temp: temp || null });
    if (error) throw error; toast(`${u.email} reset — ${temp ? 'tell them the temporary password' : 'they sign in with the standard first password (HR procedure)'}`); await loadUsers();
  });
  $('del-title').textContent='Please confirm'; $('del-ok').textContent='Reset'; $('del-ok').className='btn btn-danger';
}
// ── 🎲 random one-time password for one selected login (19 Oct 2026) ──
// Same server rule as Reset password with a typed password: must_change_password = true, so at the next sign-in
// the person enters the YEAR OF BIRTH (as usual) and must choose a new password.
function makeRandomPassword(){
  const L='ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz', D='23456789', ALL=L+D;   // no 0/O, 1/l/I look-alikes
  const pick = set => { const b=new Uint8Array(1), lim=256-(256%set.length); do crypto.getRandomValues(b); while(b[0]>=lim); return set[b[0]%set.length]; };
  for(;;){
    const chars=[]; for(let i=0;i<8;i++) chars.push(pick(ALL));
    const pw=chars.slice(0,4).join('')+'-'+chars.slice(4).join('');
    if (/[A-Za-z]/.test(pw) && /[0-9]/.test(pw)) return pw;
  }
}
function randomUser(tr){
  const u=USERS.find(x=>x.id===tr.dataset.uid); if(!u) return;
  const who = (u.emp_id ? u.emp_id+' — '+empName(empById(u.emp_id)) : (u.full_name||u.email));
  confirmDel(`Give ${who} a new random password? Their current password stops working at once. At the next sign-in they type the new password, then their year of birth, then choose their own password.`, async () => {
    const pw = makeRandomPassword();
    const { error } = await sb.rpc('admin_reset_password', { p_user:u.id, p_temp: pw });
    if (error) throw error;
    const e = u.emp_id ? empById(u.emp_id) : null, code = String(u.email||'').endsWith('@petrokima.local') ? u.email.split('@')[0] : u.email;
    $('rp-who').textContent = who; $('rp-code').textContent = code; $('rp-pw').textContent = pw;
    $('rp-note').textContent = (e && !e.birth_date) ? '⚠ This employee has no date of birth on record, so the year-of-birth question will NOT be asked. Add the date of birth on the employee window first if you want that check.' : '';
    setTimeout(()=>openM('m-rndpw'), 0);
    loadUsers();
  });
  $('del-title').textContent='🎲 Random password'; $('del-ok').textContent='Generate'; $('del-ok').className='btn btn-danger';
}
$('rp-copy') && $('rp-copy').addEventListener('click', async () => {
  const t=`Sign-in: ${$('rp-code').textContent}\nTemporary password: ${$('rp-pw').textContent}\nAt first sign-in enter your year of birth, then choose your own password.\nاسم الدخول: ${$('rp-code').textContent}\nكلمة المرور المؤقتة: ${$('rp-pw').textContent}\nعند أول دخول اكتب سنة ميلادك ثم اختر كلمة مرور جديدة.`;
  try { await navigator.clipboard.writeText(t); toast('Copied — paste it into WhatsApp or a message to the employee'); } catch(_) { toast('Copy failed — select the password and copy it by hand','warn'); }
});
async function saveUser(tr){
  const u = USERS.find(x=>x.id===tr.dataset.uid); if(!u) return;
  const role = tr.querySelector('[data-u="role"]').value, name = tr.querySelector('[data-u="name"]').value.trim();
  const empTxt = tr.querySelector('[data-u="emp"]').value.trim(), emp = empTxt ? String(empTxt).split(' — ')[0].trim() : '';
  if (emp && !empById(emp)) return toast(`Employee "${emp}" not found — pick from the list`,'warn');
  const active = tr.querySelector('[data-u="active"]').checked;
  const { error } = await sb.rpc('admin_set_user', { p_id:u.id, p_role: u.id===ME.id ? 'admin' : role, p_full_name:name, p_emp_id:emp, p_active: u.id===ME.id ? true : active });
  if (error) return toast(error.message,'err');
  // a new HR Officer starts with no reports until the admin assigns some
  if (role==='hr_officer' && !Array.isArray(u.allowed_reports)) await sb.from('app_users').update({ allowed_reports: [] }).eq('id', u.id);
  toast(`${u.email} saved${role?` as ${ROLE_LABEL[role]}`:' — no access'}${role==='hr_officer' && !Array.isArray(u.allowed_reports) ? ' — now choose their reports with 📊 Reports' : ''}`);
  if (u.id===ME.id){ ME.full_name=name; $('me-name').textContent=name||ME.email; }
  loadUsers();
}
$('us-tbl').addEventListener('click', e => { const b=e.target.closest('[data-u-save]'); if(b) return saveUser(b.closest('tr'));
  const r=e.target.closest('[data-u-reset]'); if(r) return resetUser(r.closest('tr'));
  const rn=e.target.closest('[data-u-random]'); if(rn) return randomUser(rn.closest('tr'));
  const rp=e.target.closest('[data-u-reps]'); if(rp) return openReps(rp.closest('tr').dataset.uid); });
// ── which reports each HR user may open (admin only) ──
let repsUser = null;
function openReps(uid){
  const u = USERS.find(x=>x.id===uid); if (!u) return; repsUser = u;
  const off = u.role==='hr_officer', cur = Array.isArray(u.allowed_reports) ? new Set(u.allowed_reports) : new Set(REPORTS.map(r=>r.id));
  $('rp-title').textContent = `Reports for ${u.full_name || u.email} · ${ROLE_LABEL[u.role]}`;
  $('rp-note').innerHTML = off ? 'Salary reports (Payroll group and labour cost) can never be opened by an HR Officer. In the other reports, pay rates and deduction amounts are hidden automatically.'
                               : (Array.isArray(u.allowed_reports) ? '' : 'This user can currently open <b>all</b> reports. Untick the ones they should not see.');
  $('rp-list').innerHTML = Object.entries(groupBy(REPORTS, r=>r.g)).map(([g,L]) => `<div class="sec" style="margin-top:6px">${esc(g)}</div>` +
    L.map(r => { const blocked = off && MONEY_REPORT(r);
      return `<label style="display:flex;gap:8px;align-items:center;padding:5px 2px;font-size:13px;${blocked?'opacity:.45;cursor:not-allowed':'cursor:pointer'}">
        <input type="checkbox" data-rp="${r.id}" ${blocked?'disabled':''} ${!blocked && cur.has(r.id)?'checked':''}> ${esc(r.t)}${blocked?' <span style="font-size:11px;color:var(--muted)">(salary — not for HR Officers)</span>':''}</label>`; }).join('')).join('');
  openM('m-reps');
}
async function saveReps(){
  const ids = [...document.querySelectorAll('[data-rp]:checked')].map(c => c.dataset.rp);
  const { data, error } = await sb.from('app_users').update({ allowed_reports: ids }).eq('id', repsUser.id).select();
  if (error) return toast(error.message,'err'); if (!(data && data.length)) return toast(NOPERM,'err');
  closeM('m-reps'); toast(`${repsUser.full_name || repsUser.email} can now open ${ids.length} report${ids.length===1?'':'s'}`); loadUsers();
}
$('rp-all').addEventListener('click', () => document.querySelectorAll('[data-rp]:not(:disabled)').forEach(c => c.checked = true));
$('rp-none').addEventListener('click', () => document.querySelectorAll('[data-rp]').forEach(c => c.checked = false));
$('rp-save').addEventListener('click', saveReps);
$('us-create').addEventListener('click', createLogins);
['us-q'].forEach(id=>$(id).addEventListener('input', renderUsers));
['us-role','us-state'].forEach(id=>$(id).addEventListener('change', renderUsers));
$('us-refresh').addEventListener('click', loadUsers);
$('btn-login').addEventListener('click', doLogin);
['li-email','li-pass'].forEach(id => $(id).addEventListener('keydown', e => { if (e.key==='Enter') doLogin(); }));
$('pw-save').addEventListener('click', changePassword);
document.querySelector('[data-page="users"]').addEventListener('click', loadUsers);

// the "Project cost reports" permission (works for any user, including an employee account)
document.addEventListener('change', async e => {
  const c = e.target.closest('[data-u-acct]'); if (!c) return;
  const u = USERS.find(x => x.id === c.dataset.uAcct);
  const { data, error } = await sb.from('app_users').update({ acct_reports: c.checked }).eq('id', c.dataset.uAcct).select('id');
  if (error || !(data && data.length)){ c.checked = !c.checked; return toast(error ? error.message : NOPERM, 'err'); }
  ACCT_FLAGS[c.dataset.uAcct] = c.checked;
  toast(`${(u && (u.full_name || u.email)) || 'User'} ${c.checked ? 'can now open Project costs (totals per project, no names)' : 'can no longer open Project costs'}`);
});

// employee screens: hours as hours and minutes (1.5 → "1 h 30 m"); payroll and reports keep decimal hours
const fmtHM = v => { const tm = Math.round(num(v) * 60), h = Math.floor(tm / 60), m = tm % 60; return h && m ? `${h} h ${m} m` : h ? `${h} h` : `${m} m`; };
// ═════════════════════════════════════════════════════════
//  SELF-SERVICE (employee's own requests)
// ═════════════════════════════════════════════════════════
let SD = { emp:null, leaves:[], perms:[], reqs:[] };
async function loadSelf(){
  const id = SELF.me.emp_id;
  try {
    await loadSettings();
    try { S.holidays = await fetchAll('public_holidays','date'); holidaySet = new Set(S.holidays.map(h=>h.date)); } catch(e){}
    const [emp, lv, pm, rq, sl, mg, tm, tlv, tpm, myt] = await Promise.all([
      sb.from('employees').select('*').eq('id', id),
      fetchAll('employee_leaves','date_from', q=>q.eq('emp_id', id)).catch(()=>[]),
      fetchAll('attendance_permissions','date', q=>q.eq('emp_id', id)).catch(()=>[]),
      fetchAll('hr_requests','created_at', q=>q.eq('emp_id', id)).catch(()=>[]),
      fetchAll('payroll_run_lines','period', q=>q.eq('emp_id', id)).catch(()=>[]),
      sb.rpc('my_manager').then(r=>r.data||[], ()=>[]),
      fetchAll('allowance_approvals','submitted_at', q=>q.eq('manager_id', id)).catch(()=>[]),
      fetchAll('employee_leaves','date_from', q=>q.eq('manager_id', id)).catch(()=>[]),
      fetchAll('attendance_permissions','date', q=>q.eq('manager_id', id)).catch(()=>[]),
      sb.rpc('my_team').then(r=>r.data||[], ()=>[]) ]);
    SD = { emp: emp.data && emp.data[0], leaves: lv, perms: pm, reqs: rq, slips: sl, manager: (mg||[])[0] || null, team: tm || [],
           teamLeaves: (tlv||[]).filter(l => String(l.emp_id)!==String(id)), teamPerms: (tpm||[]).filter(p => String(p.emp_id)!==String(id)), myTeam: myt || [] };
  } catch(e){ toast(e.message,'err'); }
  renderSelf();
}
function selfYearDays(types, status){
  const y = todayStr().slice(0,4);
  return SD.leaves.filter(l => types.includes(l.leave_type) && l.status===status).reduce((s,l)=>s+leaveDaysIn(l, `${y}-01-01`, `${y}-12-31`),0);
}
function selfAnnualTypes(){ return settings.casualCountsAnnual==='no' ? ['Annual'] : ['Annual','Casual']; }
function renderSelf(){
  const e = SD.emp;
  if (!e){ $('self-title').textContent='My profile'; $('self-sub').textContent=''; $('self-body').innerHTML='<div class="empty">Your employee record could not be found. Please contact HR.</div>'; $('self-list').innerHTML=''; $('self-stats').innerHTML=''; return; }
  $('self-title').textContent = e.name_en || e.name_ar || e.id;
  $('self-sub').textContent = `${e.id} · ${e.job_name||''} · ${e.department||''}${e.unit?' · '+e.unit:''}`;
  // balances
  const ent = annualEntitlement(e), taken = selfYearDays(selfAnnualTypes(),'Approved'), pend = selfYearDays(selfAnnualTypes(),'Pending');
  const cyc = cycleOf(todayStr()), lim = num(settings.permissionsPerMonth)||2;
  const used = SD.perms.filter(p=>p.status==='Approved' && cycleOf(p.date)===cyc).length, pPend = SD.perms.filter(p=>p.status==='Pending').length;
  const open = SD.leaves.filter(l=>l.status==='Pending').length + pPend + SD.reqs.filter(r=>r.status==='Pending'||r.status==='In progress').length;
  const card = (label, value, sub) => `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value">${value}</div><div class="stat-sub">${sub}</div></div>`;
  $('self-stats').innerHTML =
    card(`Annual leave ${todayStr().slice(0,4)}`, fmt(ent - taken), `remaining of ${fmt(ent)}${pend?` · ${fmt(pend)} pending`:''}`) +
    card('Permissions this cycle', `${used} / ${lim}`, `${periodLabel(cyc)}${pPend?` · ${pPend} pending`:''}`) +
    card('Sick leave this year', fmt(selfYearDays(['Sick'],'Approved')), 'days approved') +
    card('Open requests', open, open ? 'waiting for HR' : 'nothing pending');
  // one list of everything
  const items = [
    ...SD.leaves.map(l => ({ kind:'leave', id:l.id, at:l.created_at, what:`🌴 ${l.leave_type} leave`, detail:`${l.date_from} → ${l.date_to} · ${fmt(l.days)} day${num(l.days)===1?'':'s'}${l.reason?' · '+l.reason:''}`, status: waitingManager(l) ? 'Waiting for manager' : l.status==='Pending' && l.manager_status==='Approved' ? 'Waiting for HR' : l.status, reply:[l.decided_by?`by ${l.decided_by}`:'', l.decision_note||''].filter(Boolean).join(' — ') })),
    ...SD.perms.map(p => ({ kind:'perm', id:p.id, at:p.requested_at, what:`✋ ${p.type}`, detail:`${p.date} · ${fmtHM(p.hours)}${p.reason?' · '+p.reason:''}`, status: waitingManager(p) ? 'Waiting for manager' : p.status==='Pending' && p.manager_status==='Approved' ? 'Waiting for HR' : p.status, reply:[p.decided_by?`by ${p.decided_by}`:'', p.decision_note||''].filter(Boolean).join(' — ') })),
    ...SD.reqs.map(r => ({ kind:'req', id:r.id, at:r.created_at, what:`📨 ${r.request_type}`, detail:r.details||'', status:r.status, reply:[r.hr_response||'', r.handled_by?`(${r.handled_by})`:''].filter(Boolean).join(' ') })),
  ].sort((a,b)=>String(b.at||'').localeCompare(String(a.at||'')));
  $('self-list').innerHTML = items.map(x => `<tr><td class="mono" style="white-space:nowrap">${esc(fmtSent(x.at))}</td><td class="strong">${esc(x.what)}</td>
    <td style="white-space:normal;min-width:200px">${esc(x.detail)}</td><td>${chip(x.status)}</td><td style="white-space:normal;min-width:160px">${esc(x.reply)}</td>
    <td>${['Pending','Waiting for manager','Waiting for HR'].includes(x.status)?`<button class="btn btn-ghost btn-sm" data-self-cancel="${x.kind}:${x.id}">Cancel</button>`:''}</td></tr>`).join('')
    || '<tr><td colspan="6" class="empty">You have not made any requests yet</td></tr>';
  // team approvals (managers only)
  const team = (SD.team||[]).slice().sort((a,b) => (a.status==='Pending manager' ? 0 : 1) - (b.status==='Pending manager' ? 0 : 1) || String(b.period).localeCompare(String(a.period)));
  const tReq = [...(SD.teamLeaves||[]).map(l => ({ kind:'leave', r:l, when:l.date_from })), ...(SD.teamPerms||[]).map(x => ({ kind:'perm', r:x, when:x.date }))]
    .sort((a,b) => (waitingManager(a.r)?0:1) - (waitingManager(b.r)?0:1) || String(b.when).localeCompare(String(a.when))).slice(0, 60);
  const waiting = team.filter(a => a.status==='Pending manager').length + tReq.filter(x => waitingManager(x.r)).length;
  $('self-team-nav').style.display = (team.length || tReq.length || (SD.myTeam||[]).length) ? '' : 'none';
  $('self-tatt-nav').style.display = (SD.myTeam||[]).length ? '' : 'none';   // 87: direct managers see their team's attendance
  $('self-tproj-card').style.display = (SD.myTeam||[]).length ? '' : 'none';
  $('self-tproj-tbl').innerHTML = (SD.myTeam||[]).map(m => `<tr><td class="strong">${esc(m.name_en || m.name_ar || m.id)} <span class="mono" style="color:var(--muted)">${esc(m.id)}</span></td><td>${esc(m.job_name||'')}</td>
      <td class="num">${m.projects || '<span style="color:var(--muted)">none — any project</span>'}</td><td><button class="btn btn-ghost btn-sm" data-tproj="${esc(m.id)}">Manage</button></td></tr>`).join('');
  $('self-treq-tbl').innerHTML = tReq.map(({kind, r}) => { const st = waitingManager(r) ? '<span class="chip c-orange">Waiting for you</span>' : r.manager_status==='Approved' && r.status==='Pending' ? '<span class="chip c-blue">Approved by you — waiting for HR</span>' : chip(r.status);
    return `<tr><td class="strong">${esc(r.emp_name||r.emp_id)} <span class="mono" style="color:var(--muted)">${esc(r.emp_id)}</span></td>
      <td>${kind==='leave' ? `🌴 ${esc(r.leave_type)} leave` : `✋ ${esc(r.type)}`}</td>
      <td class="mono">${kind==='leave' ? `${esc(r.date_from)} → ${esc(r.date_to)} · ${fmt(r.days)} d` : `${esc(r.date)} · ${fmtHM(r.hours)}`}<div style="font-size:11px;color:var(--muted)">🕒 sent ${esc(fmtSent(r.created_at || r.requested_at))}</div></td>
      <td style="white-space:normal;font-size:12px">${esc(r.reason||'')}</td><td>${st}${r.manager_note?`<div style="font-size:12px">💬 ${esc(r.manager_note)}</div>`:''}</td>
      <td style="white-space:nowrap">${waitingManager(r) ? `<button class="btn btn-success btn-sm" data-treq-ok="${kind}:${r.id}">Approve</button> <button class="btn btn-ghost btn-sm" data-treq-no="${kind}:${r.id}">Reject</button>` : ''}</td></tr>`; }).join('')
    || '<tr><td colspan="6" class="empty">No vacation or permission requests from your team</td></tr>';
  $('self-team-badge').style.display = waiting ? '' : 'none'; $('self-team-badge').textContent = waiting;
  const stTxt = { 'Pending manager':'<span class="chip c-orange">Waiting for you</span>', 'Pending HR':'<span class="chip c-blue">Approved by you — waiting for HR</span>', 'Approved':'<span class="chip c-green">Approved — will be paid</span>', 'Rejected':'<span class="chip c-red">Rejected</span>' };
  $('self-team-tbl').innerHTML = team.map(a => `<tr><td class="strong">${esc(a.emp_name||a.emp_id)} <span class="mono" style="color:var(--muted)">${esc(a.emp_id)}</span>${a.job_name?`<div style="font-size:12px;color:var(--muted)">${esc(a.job_name)}</div>`:''}</td>
      <td>${esc(periodLabel(a.period))}</td><td style="font-size:12px;white-space:normal">${(a.details||[]).map(x => `${x.days} day${x.days>1?'s':''} × ${fmt(x.rate)} at ${esc(x.project_name || x.project)}`).join('<br>')}</td>
      <td class="num strong">${fmt(a.amount)}</td><td>${stTxt[a.status]||esc(a.status)}${a.manager_note?`<div style="font-size:12px">💬 ${esc(a.manager_note)}</div>`:''}${a.hr_note?`<div style="font-size:12px">HR: ${esc(a.hr_note)}</div>`:''}</td>
      <td style="white-space:nowrap">${a.status==='Pending manager' ? `<button class="btn btn-success btn-sm" data-team-ok="${a.id}">Approve</button> <button class="btn btn-ghost btn-sm" data-team-no="${a.id}">Reject</button>` : ''}</td></tr>`).join('')
    || '<tr><td colspan="6" class="empty">Nothing to approve</td></tr>';
  // payslips tab
  const slips = [...(SD.slips||[])].sort((a,b)=>String(b.period).localeCompare(String(a.period)));
  $('self-slips').innerHTML = slips.map(l => `<tr><td class="strong">${esc(periodLabel(l.period))}</td><td class="num">${fmt(l.gross)}</td><td class="num neg">${fmt(l.deductions)}</td>
    <td class="num pos strong">${fmt(l.net)}</td><td><button class="btn btn-ghost btn-sm" data-self-slip="${esc(l.period)}">View payslip</button></td></tr>`).join('')
    || '<tr><td colspan="5" class="empty">No approved payslips yet — they appear here once HR and Finance approve a payroll month</td></tr>';
  // profile tab
  const skip = new Set(['attendance_exempt','annual_leave_days','daily_pay','hour_pay','delay_hour_pay']);
  $('self-body').innerHTML = EMP_FIELDS.filter(([sec])=>sec!=='Attendance rules').map(([sec, fields]) => {
    const rows = fields.filter(([k])=>!skip.has(k)).map(([k,label]) => `<div class="field"><label>${esc(label)}</label>
      <div style="padding:8px 0;color:var(--text);${k==='name_ar'?'direction:rtl;text-align:right':''}">${k==='manager_id' ? (SD.manager ? esc(`${SD.manager.name_en||SD.manager.name_ar} — ${SD.manager.job_name||''}`) : '<span style="color:var(--muted)">—</span>') : (esc(e[k] ?? '') || '<span style="color:var(--muted)">—</span>')}</div></div>`).join('');
    return rows ? `<div class="sec">${esc(sec)}</div><div class="grid3">${rows}</div>` : '';
  }).join('');
}
// ── vacation request ──
function slHint(){
  const f=$('sl-from').value, t=$('sl-to').value, type=$('sl-type').value, days=num($('sl-days').value), out=[];
  if (f && t && t < f) out.push('<span class="neg">“To” is before “From”.</span>');
  if (f && t && t >= f){ const cal=Math.round((dObj(t)-dObj(f))/86400000)+1, wd=workdays(f,t);
    out.push(`${cal} calendar day${cal>1?'s':''} · <b>${wd} working day${wd===1?'':'s'}</b> (weekends and public holidays are not counted)`); }
  if (f && f < todayStr()) out.push('<span style="color:var(--warn)">These dates are in the past — HR will review them.</span>');
  if (selfAnnualTypes().includes(type) && SD.emp){
    const ent=annualEntitlement(SD.emp), taken=selfYearDays(selfAnnualTypes(),'Approved'), pend=selfYearDays(selfAnnualTypes(),'Pending'), left=ent-taken-pend-days;
    out.push(`Annual balance: ${fmt(ent)} − ${fmt(taken)} taken${pend?` − ${fmt(pend)} pending`:''} − ${fmt(days)} this request = <b class="${left<0?'neg':'pos'}">${fmt(left)} left</b>${left<0?' — more than your balance; HR may reject it':''}`); }
  if (type==='Unpaid') out.push('Unpaid leave is deducted from your salary at your daily rate.');
  if (type==='Sick') out.push('Please keep your medical report — HR may ask for it.');
  if (f && t){ const c = SD.leaves.find(l => (l.status==='Approved'||l.status==='Pending') && l.date_from<=t && l.date_to>=f);
    if (c) out.push(`<span class="neg">Overlaps your ${c.status.toLowerCase()} ${c.leave_type} leave ${c.date_from} → ${c.date_to}.</span>`); }
  $('sl-hint').innerHTML = out.join('<br>');
}
function slRecalc(){ const f=$('sl-from').value, t=$('sl-to').value; if (f && t && t>=f) $('sl-days').value = workdays(f,t) || ''; slHint(); }
function openSelfLeave(){
  $('sl-type').value='Annual'; $('sl-from').value=todayStr(); $('sl-to').value=todayStr(); $('sl-reason').value='';
  slRecalc(); openM('m-sl');
}
async function sendSelfLeave(){
  const f=$('sl-from').value, t=$('sl-to').value, days=num($('sl-days').value);
  if (!f || !t) return toast('Choose the From and To dates','warn');
  if (t < f) return toast('“To” cannot be before “From”','warn');
  if (days <= 0) return toast('The request has no working days — check the dates','warn');
  if (SD.leaves.some(l => (l.status==='Approved'||l.status==='Pending') && l.date_from<=t && l.date_to>=f)) return toast('These dates overlap another vacation of yours','warn');
  const rec = { emp_id:SELF.me.emp_id, leave_type:$('sl-type').value, date_from:f, date_to:t, days, status:'Pending', source:'Self-service',
                reason:$('sl-reason').value.trim()||null, entered_by: SELF.me.full_name || SELF.me.emp_id };
  await selfSend('employee_leaves', rec, 'm-sl', 'sl-send', SD.emp && SD.emp.manager_id ? 'Vacation request sent to your direct manager' : 'Vacation request sent to HR');
}
// ── permission request ──
function spHint(){
  const d=$('sp-date').value, lim=num(settings.permissionsPerMonth)||2; if (!d){ $('sp-hint').innerHTML=''; return; }
  const cyc=cycleOf(d), used=SD.perms.filter(p=>p.status==='Approved' && cycleOf(p.date)===cyc).length, pend=SD.perms.filter(p=>p.status==='Pending' && cycleOf(p.date)===cyc).length;
  $('sp-hint').innerHTML = `This date is in the <b>${periodLabel(cyc)}</b> payroll cycle: ${used} of ${lim} permissions approved${pend?`, ${pend} pending`:''}.` +
    (used>=lim ? `<br><span class="neg">You have used all ${lim} permissions for this cycle — this request would have to be rejected.</span>` : '') +
    (isHoliday(d) ? '<br>This date is a public holiday.' : !isWorkday(d) ? '<br><span style="color:var(--warn)">This date is a weekend day.</span>' : '');
}
function openSelfPerm(){
  $('sp-date').value=todayStr(); $('sp-type').value='Late arrival'; $('sp-hours').value=settings.permissionMaxHours||2; $('sp-max').textContent=`${settings.permissionMaxHours||2} h`; $('sp-reason').value='';
  spHint(); openM('m-sp');
}
async function sendSelfPerm(){
  const d=$('sp-date').value, h=num($('sp-hours').value), max=num(settings.permissionMaxHours)||2;
  if (!d) return toast('Choose the date','warn');
  if (h<=0 || h>max) return toast(`Hours must be between 0.25 and ${max}`,'warn');
  if (SD.perms.some(p=>p.date===d && p.type===$('sp-type').value && (p.status==='Pending'||p.status==='Approved'))) return toast('You already have this request for that date','warn');
  await selfSend('attendance_permissions', { emp_id:SELF.me.emp_id, date:d, type:$('sp-type').value, hours:h, reason:$('sp-reason').value.trim()||null, status:'Pending', source:'Self-service' },
                 'm-sp', 'sp-send', SD.emp && SD.emp.manager_id ? 'Permission request sent to your direct manager' : 'Permission request sent to HR');
}
// ── other HR request ──
function openSelfHr(){ $('sh-type').value='HR letter'; $('sh-details').value=''; openM('m-sh'); }
async function sendSelfHr(){
  const det=$('sh-details').value.trim();
  if (!det && ['Update my personal data','Loan request','Other','HR letter'].includes($('sh-type').value)) return toast('Please add the details HR will need','warn');
  await selfSend('hr_requests', { emp_id:SELF.me.emp_id, request_type:$('sh-type').value, details:det||null, status:'Pending' }, 'm-sh', 'sh-send', 'Request sent to HR');
}
async function selfSend(table, rec, modal, btnId, okMsg){
  const b=$(btnId); b.disabled=true;
  const { data, error } = await sb.from(table).insert(rec).select();
  b.disabled=false;
  if (error) return toast(/duplicate/i.test(error.message) ? 'You already have an open request of this kind for that date' : deadlineMsg(error.message), 'err');
  if (!(data && data.length)) return toast(NOPERM,'err');
  closeM(modal); toast(okMsg); await loadSelf();
}
async function selfCancel(key){
  const [kind, id] = key.split(':'), table = { leave:'employee_leaves', perm:'attendance_permissions', req:'hr_requests' }[kind];
  confirmDel('Cancel this request?', async () => {
    const { data, error } = await sb.from(table).update({ status:'Cancelled' }).eq('id', id).select();
    if (error) throw error;
    if (!(data && data.length)) throw new Error('This request can no longer be cancelled — HR has already decided it.');
    toast('Request cancelled'); await loadSelf();
  });
  $('del-title').textContent='Please confirm'; $('del-ok').textContent='Cancel request';
}
$('self-list').addEventListener('click', e => { const b=e.target.closest('[data-self-cancel]'); if(b) selfCancel(b.dataset.selfCancel); });
document.querySelectorAll('[data-spage]').forEach(t => t.addEventListener('click', () => {
  document.querySelectorAll('[data-spage]').forEach(x=>x.classList.toggle('active', x===t));
  ['req','team','tatt','pcost','att','pay','prof'].forEach(k => $('self-'+k).style.display = t.dataset.spage===k ? '' : 'none');
  lockSelfPay();                                                     // payslips need the password every time
  if (t.dataset.spage === 'pcost') loadProjectCosts();
  if (t.dataset.spage === 'tatt') { if (!$('ta-from').value) { $('ta-from').value = periodStart(cycleOf(todayStr())); $('ta-to').value = todayStr(); } loadTeamAtt(); }   // part42
}));
$('self-back').addEventListener('click', () => { $('self').style.display='none'; $('app').style.display='block'; });
['sl-from','sl-to'].forEach(id=>$(id).addEventListener('change', slRecalc));
['sl-type','sl-days'].forEach(id=>$(id).addEventListener('input', slHint));
$('sl-send').addEventListener('click', sendSelfLeave);
['sp-date','sp-type'].forEach(id=>$(id).addEventListener('input', spHint));
$('sp-send').addEventListener('click', sendSelfPerm);
$('sh-send').addEventListener('click', sendSelfHr);

// ═════════════════════════════════════════════════════════
//  HR SIDE: vacation decisions, HR requests page, badges
// ═════════════════════════════════════════════════════════
async function decideLeave(id, status){
  const l = S.leaves.find(x=>x.id===id); if (!l) return;
  const e = empById(l.emp_id), by = localStorage.getItem('approver') || (ME && ME.full_name) || 'HR';
  const go = async () => {
    const { data, error } = await sb.from('employee_leaves').update({ status, decided_by:by, decided_at:new Date().toISOString() }).eq('id', id).select();
    if (error) throw new Error(error.message.replace(/^.*?(Overlaps|You cannot)/,'$1'));
    if (!(data && data.length)) throw new Error(NOPERM);
    S.leaves = S.leaves.map(x => x.id===id ? data[0] : x); afterLeaveChange();
    toast(`${empName(e)}: ${l.leave_type} leave ${status.toLowerCase()}`);
  };
  confirmDel(`${status==='Approved'?'Approve':'Reject'} ${empName(e)}'s ${l.leave_type} leave ${l.date_from} → ${l.date_to} (${fmt(l.days)} day${num(l.days)===1?'':'s'})?`, go);
  $('del-title').textContent='Please confirm'; $('del-ok').textContent = status==='Approved' ? 'Approve' : 'Reject'; $('del-ok').className = status==='Approved' ? 'btn btn-success' : 'btn btn-danger';
}
function renderHrRequests(){
  $('hq-missing').innerHTML = hrTableMissing ? '<div class="alert a-warn">The HR requests table does not exist yet. Run <b>self-service.sql</b> in the database SQL Editor, then click ⟳ Refresh.</div>' : '';
  const st=$('hq-status').value, ty=$('hq-type').value, q=$('hq-q').value.trim().toLowerCase();
  const list = S.hrreq.filter(r => { const e=empById(r.emp_id)||{};
      return orgMatch(e,'hq') && (st==='open' ? (r.status==='Pending'||r.status==='In progress') : (!st || r.status===st)) && (!ty || r.request_type===ty) &&
             (!q || [r.emp_id, e.name_en, e.name_ar].some(v=>String(v||'').toLowerCase().includes(q))); })
    .sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)));
  const open = S.hrreq.filter(r=>r.status==='Pending'||r.status==='In progress').length;
  $('hq-sub').textContent = `${open} open request${open===1?'':'s'} · ${S.hrreq.length} in total`;
  $('hq-tbl').innerHTML = list.map(r => { const e=empById(r.emp_id)||{};
    return `<tr><td class="mono">${esc(String(r.created_at||'').slice(0,10))}</td><td class="strong">${esc(empName(e)||r.emp_id)} <span class="mono" style="color:var(--muted)">${esc(r.emp_id)}</span></td>
      <td>${esc(e.department)}</td><td>${esc(r.request_type)}</td><td style="white-space:normal;min-width:180px">${esc(r.details||'')}</td><td>${chip(r.status)}</td>
      <td style="white-space:normal;min-width:150px">${esc(r.hr_response||'')}</td><td>${esc(r.handled_by||'')}</td>
      <td>${(r.status==='Pending'||r.status==='In progress')?`<button class="btn btn-ghost btn-sm" data-hr-handle="${r.id}">Handle</button>`:''}</td></tr>`; }).join('')
    || '<tr><td colspan="9" class="empty">No requests for this selection</td></tr>';
  $('hq-foot').textContent = `${list.length} shown`;
}
let handling = null;
function openHandle(id){
  const r=S.hrreq.find(x=>x.id===id); if(!r) return; handling=r; const e=empById(r.emp_id)||{};
  $('hq-body').innerHTML = `<b style="color:var(--text)">${esc(empName(e))}</b> (${esc(r.emp_id)}) · ${esc(e.department||'')}<br><b>${esc(r.request_type)}</b> — submitted ${esc(String(r.created_at).slice(0,10))}<br>${esc(r.details||'(no details)')}`;
  $('hq-st').value = r.status==='Pending' ? 'In progress' : 'Completed'; $('hq-reply').value = r.hr_response||''; $('hq-by').value = localStorage.getItem('approver') || (ME&&ME.full_name) || '';
  openM('m-hq');
}
async function saveHandle(){
  const by=$('hq-by').value.trim(); if(!by) return toast('Enter who is handling the request','warn'); localStorage.setItem('approver', by);
  const st=$('hq-st').value, reply=$('hq-reply').value.trim();
  if ((st==='Completed'||st==='Rejected') && !reply) return toast('Add a short reply so the employee knows the outcome','warn');
  const { data, error } = await sb.from('hr_requests').update({ status:st, hr_response:reply||null, handled_by:by, handled_at:new Date().toISOString() }).eq('id', handling.id).select();
  if (error) return toast(error.message.replace(/^.*?(You cannot)/,'$1'),'err');
  if (!(data && data.length)) return toast(NOPERM,'err');
  S.hrreq = S.hrreq.map(x => x.id===handling.id ? data[0] : x);
  closeM('m-hq'); renderHrRequests(); renderDashboard(); toast(`Request marked ${st.toLowerCase()}`);
}
function updateBadges(){
  const b=(id,n)=>{ const el=$(id); if(!el) return; el.style.display=n?'':'none'; el.textContent=n; };
  b('lv-badge', S.leaves.filter(readyForHR).length);
  b('hr-badge', S.hrreq.filter(r=>r.status==='Pending'||r.status==='In progress').length);
  b('aa-badge', S.allowAppr.filter(a=>a.status==='Pending HR').length);
}
$('hq-tbl').addEventListener('click', e => { const b=e.target.closest('[data-hr-handle]'); if(b) openHandle(b.dataset.hrHandle); });
['hq-status','hq-type'].forEach(id=>$(id).addEventListener('change', renderHrRequests));
$('hq-q').addEventListener('input', renderHrRequests);
$('hq-save').addEventListener('click', saveHandle);

// the manager approves or rejects a team member's Project Allowance
async function teamDecide(id, approve){
  let note = null;
  if (!approve){ note = prompt('Reason for rejecting (HR and the employee record will show it):'); if (note === null) return; }
  const { error } = await sb.rpc('manager_decide_allowance', { p_id:id, p_approve:approve, p_note:note });
  if (error) return toast(error.message,'err');
  toast(approve ? 'Approved — sent to HR for the final approval' : 'Rejected'); await loadSelf();
}
$('self-team-tbl').addEventListener('click', e => { const ok=e.target.closest('[data-team-ok]'); if (ok) return teamDecide(ok.dataset.teamOk, true);
  const no=e.target.closest('[data-team-no]'); if (no) return teamDecide(no.dataset.teamNo, false); });

async function teamReqDecide(key, approve){
  const [kind, id] = key.split(':'); let note = null;
  if (!approve){ note = prompt('Reason for rejecting (the employee will see it):'); if (note === null) return; }
  const { data, error } = await sb.rpc('manager_decide_request', { p_kind:kind, p_id:id, p_approve:approve, p_note:note });
  if (error) return toast(error.message,'err');
  toast(approve ? (/final/.test(data) ? 'Approved' : 'Approved — sent to HR for the final approval') : 'Rejected'); await loadSelf();
}
$('self-treq-tbl').addEventListener('click', e => { const ok=e.target.closest('[data-treq-ok]'); if (ok) return teamReqDecide(ok.dataset.treqOk, true);
  const no=e.target.closest('[data-treq-no]'); if (no) return teamReqDecide(no.dataset.treqNo, false); });

// ── payslips are shown only after the employee re-enters his password ──
function lockSelfPay(){ $('self-pay-card').style.display = 'none'; $('self-pay-lock').style.display = ''; $('self-pay-pass').value = ''; $('self-pay-err').textContent = ''; }
async function unlockSelfPay(){
  const pw = $('self-pay-pass').value; if (!pw) return;
  $('self-pay-go').disabled = true;
  // the account that is signed in right now — never a value left over from an earlier sign-in
  const email = ((((await sb.auth.getSession()).data || {}).session || {}).user || {}).email || (SELF.me && SELF.me.email);
  let cap; try { cap = await captchaToken('sp-cap', 'en'); } catch(e){ cap = undefined; }
  const { error } = await sb.auth.signInWithPassword({ email, password: pw, options: cap ? { captchaToken: cap } : undefined });
  $('self-pay-go').disabled = false;
  if (error){ $('self-pay-err').textContent = /invalid|credentials/i.test(error.message) ? 'Wrong password' : error.message; return; }
  if (!(await mfaAfterReauth())) { $('self-pay-err').textContent = 'The 6-digit code is needed to open payslips'; return; }
  $('self-pay-lock').style.display = 'none'; $('self-pay-card').style.display = ''; $('self-pay-pass').value = '';
}
$('self-pay-go').addEventListener('click', unlockSelfPay);
$('self-pay-pass').addEventListener('keydown', e => { if (e.key === 'Enter') unlockSelfPay(); });
$('self-pay-relock').addEventListener('click', lockSelfPay);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && $('self-pay-card').style.display !== 'none') lockSelfPay(); });

// @ts-check — checked by TypeScript (tsconfig.json); keep it free of type errors
// ═════════════════════════════════════════════════════════
//  PAYROLL APPROVAL (permanent snapshot)
// ═════════════════════════════════════════════════════════
function nextPeriod(p){ const [y,m]=p.split('-').map(Number); return m===12 ? `${y+1}-01` : `${y}-${pad(m+1)}`; }
function payrollLines(run){
  const keys = ['basic','otherAdd','ot','otH','si','loans','otherDed','days','factor','partial','joiner','leaver','hasPackage','delay','absence','absentDays','autoAbsentDays','unpaidDays','loanOwed','penalty','holiday','holDays','lateH','earlyH','waivedH'];
  return run.map(r => ({ emp_id:String(r.emp.id), name_en:r.emp.name_en||null, name_ar:r.emp.name_ar||null, department:r.emp.department||null, unit:r.emp.unit||null,
    entity:r.emp.entity||null, payment_method:r.emp.payment_method||null, bank_branch:(r.emp.bank_branch||'').trim()||null, bank_account:r.emp.bank_account||null,
    gross:Math.round(r.gross*100)/100, deductions:Math.round(r.ded*100)/100, net:Math.round(r.net*100)/100,
    summary:Object.fromEntries(keys.map(k=>[k, r[k] ?? null])), lines:r.lines }));
}
// Compare the desktop's payroll with the database's own calculation (payroll_calc) — shown in the approval window
function payrollDiffs(mine, srv){
  const key = l => `${l.code}|${l.type}`, sum = ls => { const m = {}; (ls||[]).forEach(l => { m[key(l)] = (m[key(l)]||0) + num(l.amount); }); return m; };
  const S2 = new Map((srv||[]).map(x => [String(x.emp_id), x])), out = [];
  mine.forEach(c => { const s = S2.get(c.emp_id);
    if (!s) { out.push({ emp:c.emp_id, what:'not in the database calculation' }); return; }
    S2.delete(c.emp_id);
    const a = sum(c.lines), b = sum(s.lines);
    new Set([...Object.keys(a), ...Object.keys(b)]).forEach(k => { if (Math.abs((a[k]||0) - (b[k]||0)) > 0.005) {
      const [code, type] = k.split('|'), el = elByCode(code);
      out.push({ emp:c.emp_id, what:`${(el && el.name_en) || 'element ' + code} (${type}): desktop ${fmt(a[k]||0)} · database ${fmt(b[k]||0)}` }); } });
    if (Math.abs(num(c.net) - num(s.net)) > 0.005) out.push({ emp:c.emp_id, what:`net: desktop ${fmt(c.net)} · database ${fmt(s.net)}` });
  });
  S2.forEach((s, id) => out.push({ emp:id, what:'only in the database calculation' }));
  return out;
}
async function checkWithDatabase(){
  const box = $('ap-check'); if (!box) return;
  box.innerHTML = '<div class="alert a-info" style="margin:12px 0 0">🔍 Checking against the database calculation…</div>';
  const { data, error } = await sb.rpc('payroll_calc', { p_period: settings.period });
  if (error) { box.innerHTML = `<div class="alert a-warn" style="margin:12px 0 0">🔍 The database calculation is not available yet (${esc(error.message)}). Run <b>57-payroll-server-calculation.sql</b> first — approval needs it.</div>`; return; }
  const d = payrollDiffs(payrollLines(computeAll()), (data && data.employees) || []);
  box.innerHTML = d.length
    ? `<div class="alert a-warn" style="margin:12px 0 0">🔍 <b>${d.length} difference${d.length>1?'s':''}</b> between the desktop and the database — the database will refuse this approval:<br>• ${d.slice(0,12).map(x => `${esc(x.emp)} ${esc(empName(empById(x.emp)) || '')}: ${esc(x.what)}`).join('<br>• ')}${d.length>12?`<br>… and ${d.length-12} more`:''}</div>`
    : `<div class="alert a-info" style="margin:12px 0 0">🔍 ✓ The database calculated the same payroll — every employee and every amount matches.</div>`;
}
function openApprove(){
  if (runsTableMissing) return toast('Run managers-and-payroll-history.sql first','warn');
  if (currentRun()) return toast(`The ${settings.period} payroll is already approved`,'warn');
  const run = computeAll(), T=k=>run.reduce((s,r)=>s+num(r[k]),0);
  const ps=periodStart(settings.period), pe=periodEnd(settings.period);
  const warn = [];
  const pL=S.leaves.filter(l=>l.status==='Pending' && l.date_from<=pe && l.date_to>=ps).length;
  const pP=S.permissions.filter(p=>p.status==='Pending').length;
  const noPkg=run.filter(r=>!r.hasPackage).length, zero=run.filter(r=>num(r.net)<=0).length;
  if (pL) warn.push(`${pL} vacation request${pL>1?'s':''} in this cycle still pending`);
  if (pP) warn.push(`${pP} permission request${pP>1?'s':''} still pending`);
  if (noPkg) warn.push(`${noPkg} employee${noPkg>1?'s have':' has'} no fixed salary package`);
  if (zero) warn.push(`${zero} employee${zero>1?'s have':' has'} zero or negative net pay`);
  const openAA = typeof aaRows === 'function' ? aaRows().filter(r => r.calc.amount > 0 && r.state !== 'Approved' && r.state !== 'Rejected') : [];
  if (openAA.length) warn.push(`${openAA.length} automatic project allowance${openAA.length>1?'s are':' is'} not yet approved by manager and HR — ${fmt(openAA.reduce((s,r)=>s+r.calc.amount,0))} EGP will NOT be paid`);
  const chg = typeof aaRows === 'function' ? aaRows().filter(r => r.state==='Approved' && r.changed).length : 0;
  if (chg) warn.push(`${chg} approved allowance${chg>1?'s':''} changed since approval — the approved amount is what will be paid`);
  $('ap-body').innerHTML = `<div style="font-size:15px;color:var(--text);margin-bottom:8px"><b>${esc(periodLabel(settings.period))}</b></div>
    <div class="pay-line"><span>Employees</span><span class="mono">${run.length}</span></div>
    <div class="pay-line"><span>Gross</span><span class="mono">${fmt(T('gross'))}</span></div>
    <div class="pay-line"><span>Deductions</span><span class="mono neg">${fmt(T('ded'))}</span></div>
    <div class="pay-line total"><span>Net payroll</span><span class="mono pos">${fmt(T('net'))} EGP</span></div>
    ${warn.length ? `<div class="alert a-warn" style="margin:12px 0 0">Check before approving:<br>• ${warn.join('<br>• ')}</div>` : '<div class="alert a-info" style="margin:12px 0 0">No open items found.</div>'}
    <div style="margin-top:12px">Approval saves every payslip permanently. <b>It cannot be undone, changed or deleted</b> — not even by the administrator. Attendance, monthly entries, penalties and approved leave for this cycle will be locked. Corrections go into the next payroll.</div>`;
  $('ap-type-l').textContent = `Type ${settings.period} to confirm`; $('ap-type').value=''; $('ap-next').checked=true;
  if (!$('ap-check')) $('ap-body').insertAdjacentHTML('afterend', '<div id="ap-check"></div>');
  openM('m-approve'); setTimeout(()=>$('ap-type').focus(),50);
  checkBlockers();
  checkWithDatabase();
}
// 85 (rule 5A): the database refuses approval while the cycle is open or attendance is unsettled — show what is left
async function checkBlockers(){
  if (!$('ap-block')) $('ap-body').insertAdjacentHTML('afterend', '<div id="ap-block"></div>');
  const box = $('ap-block'), go = $('ap-go'); box.innerHTML = ''; go.disabled = false; go.title = '';
  const { data, error } = await sb.rpc('payroll_blockers', { p_period: settings.period });
  if (error) { box.innerHTML = /function|schema/i.test(error.message) ? '<div class="alert a-warn" style="margin:12px 0 0">Run <b>85-payroll-rules.sql</b> first — approval needs it.</div>' : ''; return; }
  if (!(data && data.length)) return;
  go.disabled = true; go.title = 'Settle the items listed first';
  box.innerHTML = `<div class="alert a-danger" style="margin:12px 0 0;border-color:rgba(217,79,79,.5);background:rgba(217,79,79,.08);color:var(--danger)">⛔ <b>This month cannot be approved yet:</b><br>• ${data.map(x => esc(x.text)).join('<br>• ')}</div>`;
}
async function doApprove(){
  const p = settings.period;
  if ($('ap-type').value.trim() !== p) return toast(`Type ${p} exactly to confirm`,'warn');
  const lines = payrollLines(computeAll());
  const costDetail = laborCost();                                     // project totals, published after approval
  const b=$('ap-go'); b.disabled=true; b.textContent='Approving…';
  // 57-payroll-server-calculation.sql: the DATABASE calculates and stores the payroll; these lines are only a cross-check
  // (the database refuses the approval when its own numbers differ)
  const { data, error } = await sb.rpc('approve_payroll', { p_period:p, p_check:lines });
  b.disabled=false; b.textContent='Approve and lock';
  if (error) return toast(error.message,'err');
  closeM('m-approve');
  toast(`${periodLabel(p)} approved and locked — ${data.headcount} employees, net ${fmt(data.net)} EGP`);
  await publishProjectCosts(p, costDetail, true);
  if ($('ap-next').checked){
    settings.period = nextPeriod(p);
    const r = await sb.from('settings').upsert({ key:'payroll', value:settings }).select();
    if (r.error || !(r.data && r.data.length)) toast('Approved — but the period could not be moved; change it in Settings','warn');
    applySettingsUI();
  }
  resetMonthly(); await loadPeriodData(); loader(false); renderAll();
}
$('pay-approve').addEventListener('click', openApprove);
$('ap-go').addEventListener('click', doApprove);
$('ap-type').addEventListener('keydown', e => { if (e.key==='Enter') doApprove(); });

// ═════════════════════════════════════════════════════════
//  PAYROLL HISTORY
// ═════════════════════════════════════════════════════════
let HIST = { period:null, lines:[] };
function renderHistory(){
  $('hs-missing').innerHTML = runsTableMissing ? '<div class="alert a-warn">The payroll history tables do not exist yet. Run <b>managers-and-payroll-history.sql</b>, then click ⟳ Refresh.</div>' : '';
  const runs = [...S.runs].sort((a,b)=>String(b.period).localeCompare(String(a.period)));
  $('hs-tbl').innerHTML = runs.map(r => `<tr class="click" data-hist="${esc(r.period)}"><td class="strong">🔒 ${esc(periodLabel(r.period))}</td><td class="num">${r.headcount}</td>
    <td class="num">${fmt(r.gross)}</td><td class="num neg">${fmt(r.deductions)}</td><td class="num pos strong">${fmt(r.net)}</td>
    <td>${esc(r.approved_by)}</td><td class="mono">${esc(String(r.approved_at).slice(0,16).replace('T',' '))}</td><td><button class="btn btn-ghost btn-sm">Open</button></td></tr>`).join('')
    || '<tr><td colspan="8" class="empty">No payroll month has been approved yet. Approve one from the Payroll Run page.</td></tr>';
  if (HIST.period) renderHistLines();
}
async function openHistory(p){
  HIST = { period:p, lines: p===settings.period && S.runLines.length ? S.runLines : await fetchAll('payroll_run_lines','emp_id', q=>q.eq('period', p)) };
  $('hs-view').style.display=''; $('hs-q').value=''; renderHistLines();
  if ($('hs-view').scrollIntoView) $('hs-view').scrollIntoView({block:'start'});
}
function renderHistLines(){
  const r = S.runs.find(x=>x.period===HIST.period); if (!r) return;
  const q=$('hs-q').value.trim().toLowerCase();
  const list = HIST.lines.filter(l => orgMatch({ department:l.department, unit:l.unit },'hs') && (!q || [l.emp_id,l.name_en,l.name_ar,l.department].some(v=>String(v||'').toLowerCase().includes(q))))
                         .sort((a,b)=>String(a.emp_id).localeCompare(String(b.emp_id),undefined,{numeric:true}));
  $('hs-title').textContent = `🔒 ${periodLabel(HIST.period)} — approved by ${r.approved_by}`;
  $('hs-lines').innerHTML = list.map(l => `<tr class="click" data-hslip="${esc(l.emp_id)}"><td class="mono">${esc(l.emp_id)}</td><td class="strong">${esc(l.name_en||l.name_ar||'')}</td>
    <td>${esc(l.department||'')}</td><td>${esc(l.payment_method||'')}${l.bank_branch?' · '+esc(l.bank_branch):''}</td>
    <td class="num">${fmt(l.gross)}</td><td class="num neg">${fmt(l.deductions)}</td><td class="num pos strong">${fmt(l.net)}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">No match</td></tr>';
  $('hs-foot').textContent = `${list.length} of ${HIST.lines.length} payslips · click a row for the full payslip · this record is permanent`;
}
function showSnapSlip(line, period){
  const r = snapToResult(line);
  $('slip-title').textContent = `${line.name_en||line.name_ar||line.emp_id} — ${periodLabel(period)} 🔒`;
  const row = l => `<div class="pay-line"><span>${l.code!==0&&l.code!=='TAX'?`<span class="mono" style="color:var(--muted)">${esc(l.code)}</span> `:''}${esc(l.name)}${l.note?`<div style="font-size:11px;color:var(--muted)">${esc(l.note)}</div>`:''}</span><span class="mono ${l.type==='Deduction'?'neg':'pos'}">${l.type==='Deduction'?'−':''}${fmt(l.amount)}</span></div>`;
  const adds=r.lines.filter(l=>l.type==='Addition'), deds=r.lines.filter(l=>l.type==='Deduction');
  $('slip-body').innerHTML = `<div style="font-size:12px;color:var(--muted);margin-bottom:14px">${esc(line.name_ar||'')} · ${esc(line.department||'')} · ${esc(line.unit||'')} · approved payslip</div>
    <div class="sec">Additions</div>${adds.map(row).join('')||'<div style="color:var(--muted);font-size:12px">None</div>'}
    <div class="pay-line total"><span>Gross</span><span class="mono">${fmt(r.gross)}</span></div>
    <div class="sec">Deductions</div>${deds.map(row).join('')||'<div style="color:var(--muted);font-size:12px">None</div>'}
    <div class="pay-line total"><span>Total deductions</span><span class="mono neg">${fmt(r.ded)}</span></div>
    <div class="pay-line total" style="font-size:16px"><span>Net pay</span><span class="mono pos">${fmt(r.net)} EGP</span></div>`;
  openM('m-slip');
}
function exportRunCsv(run, period){
  const codes = [...new Set(run.flatMap(r=>r.lines.map(l=>String(l.code))))];
  const pick = c => run.flatMap(r=>r.lines).find(x=>String(x.code)===c) || {};
  codes.sort((a,b)=> (pick(a).type===pick(b).type?0:pick(a).type==='Addition'?-1:1) || (num(a)-num(b)));
  const hdr = ['Code','Arabic Name','English Name','Department','Unit','Entity','Payment','Bank','Account', ...codes.map(c=>`${c} ${pick(c).name||''} (${pick(c).type==='Deduction'?'-':'+'})`), 'Gross','Total Deductions','Net'];
  const q = v => { let s=String(v??''); if (/^[=+@\t\r]/.test(s) || /^-[^\d.]/.test(s)) s="'"+s;   // never an Excel formula
    return /[",\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s; };
  const rows = run.map(r => [r.emp.id, r.emp.name_ar, r.emp.name_en, r.emp.department, r.emp.unit, r.emp.entity, r.emp.payment_method, (r.emp.bank_branch||'').trim(),
    r.emp.bank_account ? `="${String(r.emp.bank_account).replace(/"/g,'')}"` : '',
    ...codes.map(c => r.lines.filter(l=>String(l.code)===c).reduce((s,l)=>s+l.amount,0).toFixed(2)), r.gross.toFixed(2), r.ded.toFixed(2), r.net.toFixed(2)]);
  const csv = '\uFEFF' + [hdr, ...rows].map(r=>r.map(v=>String(v).startsWith('="')?v:q(v)).join(',')).join('\n');
  const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));
  a.download=`petrokima-payroll-${period}${S.runs.some(x=>x.period===period)?'-approved':'-draft'}.csv`; a.click(); toast('Payroll exported');
}
$('hs-tbl').addEventListener('click', e => { const r=e.target.closest('[data-hist]'); if(r) openHistory(r.dataset.hist); });
$('hs-lines').addEventListener('click', e => { const r=e.target.closest('[data-hslip]'); if(r){ const l=HIST.lines.find(x=>String(x.emp_id)===r.dataset.hslip); if(l) showSnapSlip(l, HIST.period); } });
$('hs-q').addEventListener('input', renderHistLines);
$('hs-export').addEventListener('click', () => exportRunCsv(HIST.lines.map(snapToResult), HIST.period));
$('self-slips').addEventListener('click', e => { const b=e.target.closest('[data-self-slip]'); if(b){ const l=(SD.slips||[]).find(x=>x.period===b.dataset.selfSlip); if(l) showSnapSlip(l, l.period); } });

// Lock notices on pages whose data belongs to an approved cycle
function renderLocks(){
  const run = currentRun();
  document.querySelectorAll('.lock-note').forEach(el => el.innerHTML = run
    ? `<div class="alert a-warn">🔒 The <b>${esc(periodLabel(run.period))}</b> payroll is approved and locked. Records in this cycle can no longer be added, changed or deleted — the database refuses it. Switch to an open period in Settings to keep working.</div>` : '');
}

// ═════════════════════════════════════════════════════════
//  REPORTING LINES
// ═════════════════════════════════════════════════════════
let rlSel = new Set();
function renderReporting(){
  const act = activeEmps(), q=$('rl-q').value.trim().toLowerCase(), d=$('rl-dept').value;
  const none = act.filter(e => !e.manager_id && !e.top_of_org);
  const shown = none.filter(e => orgMatch(e,'rl') && (!q || [e.id,e.name_ar,e.name_en,e.job_name].some(v=>String(v||'').toLowerCase().includes(q))));
  rlSel = new Set([...rlSel].filter(id => none.some(e=>String(e.id)===id)));
  const b=$('rl-badge'); b.style.display = none.length ? '' : 'none'; b.textContent = none.length;
  $('rl-sub').textContent = `${act.length - none.length} of ${act.length} active employees have a direct manager${none.length?` · ${none.length} still to assign`:' ✓'}`;
  $('rl-none-title').textContent = `Employees without a direct manager (${none.length})`;
  $('rl-none').innerHTML = shown.slice(0,500).map(e => `<tr><td><input type="checkbox" data-rl="${esc(e.id)}" ${rlSel.has(String(e.id))?'checked':''}></td><td class="mono">${esc(e.id)}</td>
    <td class="ar">${esc(e.name_ar)}</td><td class="strong">${esc(e.name_en)}</td><td>${esc(e.department)}</td><td>${esc(e.unit)}</td><td>${esc(e.job_name)}</td></tr>`).join('')
    || `<tr><td colspan="7" class="empty">${none.length ? 'No employees match these filters' : 'Every active employee has a direct manager ✓'}</td></tr>`;
  $('rl-all').checked = shown.length>0 && shown.every(e=>rlSel.has(String(e.id)));
  $('rl-assign').disabled = !rlSel.size; $('rl-assign').textContent = rlSel.size ? `Assign to selected (${rlSel.size})` : 'Assign to selected';
  // teams
  const mq=$('rl-mq').value.trim().toLowerCase(), teams={};
  act.forEach(e => { if (e.manager_id) (teams[e.manager_id] = teams[e.manager_id] || []).push(e); });
  const rows = Object.entries(teams).map(([mid, L]) => ({ m: empById(mid) || /** @type {Employee} */ ({ id:mid }), L }))
    .filter(x => !mq || [x.m.id, x.m.name_en, x.m.name_ar, x.m.job_name].some(v=>String(v||'').toLowerCase().includes(mq)))
    .sort((a,b)=>b.L.length-a.L.length);
  $('rl-teams').innerHTML = rows.map(x => `<tr><td class="mono">${esc(x.m.id)}</td><td class="strong">${esc(empName(x.m))}</td><td>${esc(x.m.job_name||'')}</td><td>${esc(x.m.department||'')}</td>
    <td class="num">${x.L.length}</td><td style="white-space:normal;max-width:420px;font-size:12px;color:var(--label)">${x.L.slice(0,12).map(e=>esc(empName(e))).join(', ')}${x.L.length>12?` … +${x.L.length-12}`:''}</td></tr>`).join('')
    || '<tr><td colspan="6" class="empty">No reporting lines yet</td></tr>';
}
async function assignManager(){
  const mid = String($('rl-mgr').value||'').split(' — ')[0].trim(), m = empById(mid);
  if (!m) return toast('Choose the manager from the suggestions','warn');
  const ids = [...rlSel].filter(id => id !== mid);
  if (!ids.length) return toast('Select at least one employee (a manager cannot report to themselves)','warn');
  const b=$('rl-assign'); b.disabled=true; b.textContent='Assigning…';
  try {
    let changed = 0;
    await chunked(ids, async chunk => { const r = await sb.from('employees').update({ manager_id:mid, top_of_org:false }).in('id', chunk).select('id'); changed += (r.data||[]).length; return r; }, 100);
    if (!changed) throw new Error(NOPERM);
    S.employees.forEach(e => { if (ids.includes(String(e.id))) { e.manager_id = mid; e.top_of_org = false; } });
    rlSel.clear(); $('rl-mgr').value='';
    renderReporting(); renderEmployees(); renderReports();
    toast(`${changed} employee${changed>1?'s':''} now report${changed>1?'':'s'} to ${empName(m)}`);
  } catch(e){ toast(String(e.message).replace(/^.*?(This would create|An employee cannot)/,'$1'),'err'); }
  b.disabled=false; renderReporting();
}
$('rl-none').addEventListener('change', e => { const c=e.target.closest('[data-rl]'); if(!c) return; c.checked?rlSel.add(c.dataset.rl):rlSel.delete(c.dataset.rl); renderReporting(); });
$('rl-all').addEventListener('change', e => { document.querySelectorAll('[data-rl]').forEach(/** @param {HTMLInputElement} c */ c=>{ /** @type {HTMLInputElement} */ (e.target).checked?rlSel.add(c.dataset.rl):rlSel.delete(c.dataset.rl); }); renderReporting(); });
['rl-q','rl-mq'].forEach(id=>$(id).addEventListener('input', renderReporting));
$('rl-dept').addEventListener('change', renderReporting);
$('rl-assign').addEventListener('click', assignManager);

// ═════════════════════════════════════════════════════════
//  WARN WHEN TODAY IS OUTSIDE THE PERIOD ON SCREEN
// ═════════════════════════════════════════════════════════
function renderPeriodHint(){
  const today = todayStr(), p = settings.period, cur = cycleOf(today);
  const outside = today < periodStart(p) || today > periodEnd(p);
  const html = outside ? `<div class="alert a-warn">📅 Today (${today}) belongs to the <b>${esc(periodLabel(cur))}</b> payroll period, but the app is showing <b>${esc(periodLabel(p))}</b> — today's attendance and phone check-ins are not included on this screen.
      <button class="btn btn-primary btn-sm" data-act="goto-current" style="margin-inline-start:10px">Switch to ${cur}</button>
      <span class="ro-set-inline"> Ask Finance or the administrator to move the period in Settings.</span></div>` : '';
  document.querySelectorAll('.period-note').forEach(el => el.innerHTML = html);
}
async function gotoCurrentPeriod(){
  const cur = cycleOf(todayStr()), old = settings.period;
  settings.period = cur;
  const r = await sb.from('settings').upsert({ key:'payroll', value:settings }).select();
  if (r.error || !(r.data && r.data.length)) { settings.period = old; return toast(r.error ? r.error.message : NOPERM, 'err'); }
  applySettingsUI(); resetMonthly(); await loadPeriodData(); loader(false); renderAll();
  toast(`Now showing ${periodLabel(cur)}`);
}

// ═════════════════════════════════════════════════════════
//  PHONE LOCATIONS & REGISTERED PHONES
// ═════════════════════════════════════════════════════════
function mapUrl(c){ return (c && c.lat != null && c.lng != null) ? `https://www.google.com/maps?q=${c.lat},${c.lng}` : null; }
function mapLinks(empId, date){
  const ev = attClocks().filter(c => String(c.emp_id)===String(empId) && c.local_date===date).sort((a,b)=>String(a.local_time).localeCompare(String(b.local_time)));
  if (!ev.length) return '<span style="color:var(--muted)">—</span>';
  return ev.map(c => { const u = mapUrl(c), off = !!c.offline, corr = /corrected/.test(c.time_method || '');
    const lbl = `${off ? (corr ? '<span style="color:var(--danger)">📴⚠</span> ' : '📴 ') : ''}${c.event_type==='in'?'In':'Out'} ${esc(c.local_time)}${c.event_type==='in' ? ' · ' + esc(c.project_code || 'no project') : ''}`;
    const tip = [`Open on Google Maps — accuracy about ${c.accuracy ?? '?'} m`,
                 off ? `Recorded with no internet; sent ${String(c.received_at||'').slice(0,16).replace('T',' ')} UTC; time from the ${c.time_method || 'phone clock'}` : '',
                 corr ? 'The phone clock was wrong when it reconnected, and the server corrected this time — review it' : ''].filter(Boolean).join('\n');
    return u ? `<a class="maplink" href="${u}" target="_blank" rel="noopener" title="${esc(tip)}">📍 ${lbl}</a>`
             : c.location_exempt ? `<span style="color:var(--warn);white-space:nowrap" title="No location — allowed by an exception the administrator set">⌀ ${lbl} · no location (exception)</span>`
             : `<span style="color:var(--muted);white-space:nowrap" title="No location recorded">⌀ ${lbl}</span>`; }).join('<br>');
}

function renderEmpDevice(){
  const box = $('emp-dev'); if (!box) return;
  if (!editingEmp){ box.textContent = 'The employee registers their phone the first time they sign in to the mobile app.'; return; }
  const d = S.devices.find(x => String(x.emp_id)===String(editingEmp));
  box.innerHTML = d
    ? `📱 <b style="color:var(--text)">${esc(d.device_label || 'Phone')}</b> registered ${esc(String(d.registered_at).slice(0,10))} · last used ${esc(String(d.last_seen).slice(0,16).replace('T',' '))}
       <button class="btn btn-ghost btn-sm" data-dev-reset="${esc(editingEmp)}" style="margin-inline-start:10px">Reset phone</button>
       <div style="font-size:12px;color:var(--muted);margin-top:4px">Reset only when the employee has genuinely changed or lost their phone. Their next sign-in registers the new phone.</div>`
    : 'No phone registered yet — it is registered automatically the first time the employee signs in to the mobile app.';
}
async function resetDevice(empId){
  const e = empById(empId);
  confirmDel(`Reset the registered phone of ${empName(e)} (${empId})? They will be able to sign in on a new phone, and the old phone will stop working for them.`, async () => {
    const { data, error } = await sb.from('employee_devices').delete().eq('emp_id', empId).select();
    if (error) throw error; if (!(data && data.length)) throw new Error(NOPERM);
    S.devices = S.devices.filter(x => String(x.emp_id)!==String(empId)); renderEmpDevice(); renderReports();
    toast(`${empName(e)} can now register a new phone`);
  });
  $('del-title').textContent='Please confirm'; $('del-ok').textContent='Reset phone';
}
document.addEventListener('click', e => { const b = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-dev-reset]')); if (b) resetDevice(b.dataset.devReset); });

// ═════════════════════════════════════════════════════════
//  COLOUR THEMES
// ═════════════════════════════════════════════════════════
const THEMES = [
  { id:'dark',     name:'Dark',          note:'The original look',              sw:['#0f1117','#1e2336','#3b6fd4','#22c5a0','#e8ecf4'] },
  { id:'light',    name:'Light',         note:'Best in bright offices',         sw:['#f2f4f8','#ffffff','#2f5fc4','#0e8a6b','#161a26'] },
  { id:'navy',     name:'Navy',          note:'Softer dark blue',               sw:['#0a1730','#12284f','#4d8bf5','#2fd3a8','#eaf1ff'] },
  { id:'contrast', name:'High contrast', note:'Maximum readability',            sw:['#000000','#121212','#3d8bff','#35e0a1','#ffffff'] } ];
function setTheme(id){
  document.documentElement.dataset.theme = id;
  try { localStorage.setItem('pk_theme', id); } catch(e){}
  renderThemeList();
}
function renderThemeList(){
  const cur = document.documentElement.dataset.theme || 'dark';
  $('theme-list').innerHTML = THEMES.map(t => `<button class="theme-card ${t.id===cur?'on':''}" data-theme-pick="${t.id}">
      <b>${esc(t.name)}</b>${t.id===cur?' ✓':''}<div class="theme-sw">${t.sw.map(c=>`<span style="background:${c}"></span>`).join('')}</div>
      <div style="font-size:12px;color:var(--muted)">${esc(t.note)}</div></button>`).join('');
}
function openTheme(){ renderThemeList(); openM('m-theme'); }
document.addEventListener('click', e => { const b = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-theme-pick]')); if (b) setTheme(b.dataset.themePick); });

// ═════════════════════════════════════════════════════════
//  BULK UPLOAD — variable (monthly) additions and deductions
// ═════════════════════════════════════════════════════════
let BULK = { rows:[], file:'' };
const varElements = () => S.elements.filter(e => e.input_method==='Monthly' && e.active!==false);
function openBulk(){
  if (currentRun()) return toast(`The ${periodLabel(settings.period)} payroll is approved and locked — switch to an open period first`,'warn');
  if (!varElements().length) return toast('Create a variable element first (+ New variable element)','warn');
  BULK = { rows:[], file:'' }; $('bk-file').value=''; $('bk-fname').textContent=''; $('bk-rows').innerHTML=''; $('bk-summary').innerHTML='';
  $('bk-import').disabled = true; $('bk-import').textContent='Import';
  $('bk-title').textContent = `Bulk upload — variable additions and deductions · ${periodLabel(settings.period)}`;
  $('bk-elements').innerHTML = `<div class="tbl-wrap"><table><thead><tr><th>element_code</th><th>Name</th><th>Type</th></tr></thead><tbody>${varElements().map(e=>`<tr><td class="mono">${e.code}</td><td>${esc(e.name_en)}${e.name_ar?' · '+esc(e.name_ar):''}</td><td>${e.element_type==='Deduction'?'<span class="neg">Deduction (−)</span>':'<span class="pos">Addition (+)</span>'}</td></tr>`).join('')}</tbody></table></div>`;
  openM('m-bulk');
}
function downloadTemplate(){
  const els = varElements(), emps = S.employees.filter(e => onPayroll(e, settings.period)).slice(0, 3);
  const rows = [['employee_code','employee_name','element_code','amount','project_code']];
  emps.forEach((e,i) => rows.push([e.id, empName(e), els[i % els.length].code, (i+1)*500, i===0 && S.projects[0] ? S.projects[0].id : '']));
  const q = v => { const s=String(v??''); return /[",\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s; };
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob(['\uFEFF'+rows.map(r=>r.map(q).join(',')).join('\n')],{type:'text/csv;charset=utf-8'}));
  a.download=`petrokima-variable-elements-template-${settings.period}.csv`; a.click();
}
// ── reading the file ──
function parseCsv(text){
  text = text.replace(/^\uFEFF/, '');
  const first = text.split(/\r?\n/)[0] || '', delim = (first.split(';').length > first.split(',').length) ? ';' : ',';
  const out=[]; let row=[], cell='', inQ=false;
  for (let i=0;i<text.length;i++){
    const c=text[i];
    if (inQ){ if (c==='"'){ if (text[i+1]==='"'){ cell+='"'; i++; } else inQ=false; } else cell+=c; }
    else if (c==='"') inQ=true;
    else if (c===delim){ row.push(cell); cell=''; }
    else if (c==='\n' || c==='\r'){ if (c==='\r' && text[i+1]==='\n') i++; row.push(cell); out.push(row); row=[]; cell=''; }
    else cell+=c;
  }
  if (cell!=='' || row.length){ row.push(cell); out.push(row); }
  return out;
}
function loadSheetJs(){
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return new Promise((res, rej) => { const s=document.createElement('script'); s.src='vendor/xlsx.js?v=0.18.5';   // served from our own site
    s.onload=()=>res(window.XLSX); s.onerror=()=>rej(new Error('Could not load the Excel reader — reload the page, or save the sheet as CSV UTF-8')); document.head.appendChild(s); });
}
// FileReader works in every browser, including older office PCs
const readAs = (file, how) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error('The file could not be read')); how==='text' ? r.readAsText(file, 'UTF-8') : r.readAsArrayBuffer(file); });
async function readFile(file){
  if (/\.(xlsx|xls)$/i.test(file.name)){
    const XL = await loadSheetJs(), wb = XL.read(new Uint8Array(await readAs(file, 'buffer')), { type:'array' });
    return XL.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header:1, raw:true, defval:'' });
  }
  return parseCsv(await readAs(file, 'text'));
}
// ── checking every row ──
const H = s => String(s||'').toLowerCase().replace(/[\s_\-.]/g,'');
const COLS = { emp:['employeecode','empcode','empid','employeeid','employee','code','كودالموظف','الكود'], el:['elementcode','element','elementid','elcode','كودالبند','البند'],
               amt:['amount','value','المبلغ','القيمة'], proj:['projectcode','project','site','sitecode','كودالمشروع','المشروع'] };
function checkRows(grid){
  const rows = grid.filter(r => r.some(c => String(c).trim()!==''));
  if (rows.length < 2) throw new Error('The file has no data rows');
  const head = rows[0].map(H), find = k => head.findIndex(h => COLS[k].includes(h));
  const ix = { emp:find('emp'), el:find('el'), amt:find('amt'), proj:find('proj') };
  const missing = ['emp','el','amt'].filter(k => ix[k] < 0).map(k => ({ emp:'employee_code', el:'element_code', amt:'amount' }[k]));
  if (missing.length) throw new Error(`Column${missing.length>1?'s':''} not found: ${missing.join(', ')}. The first row must contain the column names from the template.`);
  const seen = {};
  return rows.slice(1).map((r, n) => {
    const line = n + 2, cell = i => i < 0 ? '' : String(r[i] ?? '').trim();
    let code = cell(ix.emp).replace(/\.0+$/, ''), elc = cell(ix.el).replace(/\.0+$/, ''), proj = cell(ix.proj);
    const amtTxt = cell(ix.amt).replace(/[,\s]|EGP|ج\.م/gi, ''), amount = Number(amtTxt);
    const e = empById(code), el = S.elements.find(x => String(x.code)===elc), p = proj ? S.projects.find(x => String(x.id).toLowerCase()===proj.toLowerCase()) : null;
    let err = '';
    if (!code) err = 'Employee code is empty';
    else if (!e) err = `Employee ${code} not found`;
    else if (!onPayroll(e, settings.period)) err = `${empName(e)} is not on the ${settings.period} payroll`;
    else if (!elc) err = 'Element code is empty';
    else if (!el) err = `Element ${elc} not found`;
    else if (el.input_method !== 'Monthly') err = `Element ${elc} (${el.name_en}) is not a variable element`;
    else if (el.active === false) err = `Element ${elc} is inactive`;
    else if (amtTxt==='' || !isFinite(amount)) err = 'Amount is missing or not a number';
    else if (amount <= 0) err = 'Amount must be more than zero';
    else if (proj && !p) err = `Project ${proj} not found`;
    const key = `${code}|${elc}|${p ? p.id : ''}`;
    if (!err && seen[key]) err = `Same employee, element and project as row ${seen[key]}`;
    if (!err) seen[key] = line;
    return { line, code, name: e ? empName(e) : '', elc, elName: el ? el.name_en : '', elType: el ? el.element_type : '', proj: p ? p.id : proj, amount: isFinite(amount) ? amount : null, err };
  });
}
async function onBulkFile(){
  const f = $('bk-file').files[0]; if (!f) return;
  $('bk-fname').textContent = f.name; $('bk-summary').innerHTML = '<div class="loading"><div class="spin"></div> Reading the file…</div>'; $('bk-rows').innerHTML='';
  try { BULK = { rows: checkRows(await readFile(f)), file: f.name }; }
  catch(e){ BULK = { rows:[], file:f.name }; $('bk-summary').innerHTML = `<div class="alert a-warn">${esc(e.message)}</div>`; $('bk-import').disabled = true; return; }
  const ok = BULK.rows.filter(r=>!r.err), bad = BULK.rows.length - ok.length;
  const add = ok.filter(r=>r.elType==='Addition').reduce((s,r)=>s+r.amount,0), ded = ok.filter(r=>r.elType==='Deduction').reduce((s,r)=>s+r.amount,0);
  $('bk-summary').innerHTML = `<div class="alert ${bad?'a-warn':'a-info'}"><b>${ok.length}</b> row${ok.length===1?'':'s'} ready · <b>${new Set(ok.map(r=>r.code)).size}</b> employees · additions <b>${fmt(add)}</b> · deductions <b>${fmt(ded)}</b>${bad?` · <b class="neg">${bad} row${bad>1?'s':''} with problems will be skipped</b> — fix them in your file and upload again if needed`:''}</div>`;
  $('bk-rows').innerHTML = BULK.rows.sort((a,b)=>(!!b.err)-(!!a.err) || a.line-b.line).map(r => `<tr${r.err?' style="background:rgba(217,79,79,.07)"':''}><td class="mono">${r.line}</td><td class="mono">${esc(r.code)}</td><td class="strong">${esc(r.name)}</td>
    <td>${esc(r.elc)}${r.elName?' · '+esc(r.elName):''}</td><td class="mono">${esc(r.proj||'')}</td><td class="num ${r.elType==='Deduction'?'neg':''}">${r.amount==null?'':fmt(r.amount)}</td>
    <td>${r.err ? `<span class="neg">✗ ${esc(r.err)}</span>` : '<span class="pos">✓</span>'}</td></tr>`).join('');
  $('bk-import').disabled = !ok.length;
  $('bk-import').textContent = ok.length ? `Import ${ok.length} row${ok.length===1?'':'s'}${bad?` (skip ${bad})`:''}` : 'Nothing to import';
}
async function doBulkImport(){
  const ok = BULK.rows.filter(r=>!r.err); if (!ok.length) return;
  if (currentRun()) return toast('This payroll period is approved and locked','err');
  const b=$('bk-import'); b.disabled=true; b.textContent='Importing…';
  const byEl = {}; ok.forEach(r => (byEl[r.elc] = byEl[r.elc] || []).push(r));
  try {
    for (const [elc, rows] of Object.entries(byEl)){
      const emps = [...new Set(rows.map(r=>r.code))];
      await chunked(emps, ids => sb.from('payroll_period_elements').delete().eq('element_code', num(elc)).eq('period', settings.period).in('emp_id', ids), 200);
      await chunked(rows.map(r => ({ emp_id:r.code, element_code:num(elc), period:settings.period, amount:r.amount, project_code:r.proj||null })),
                    chunk => sb.from('payroll_period_elements').insert(chunk), 500);
    }
  } catch(e){
    b.disabled=false; b.textContent='Try again';
    return toast(`Import stopped: ${e.message}. Nothing is duplicated — you can upload the same file again.`,'err');
  }
  S.monthly = await fetchAll('payroll_period_elements','emp_id', q=>q.eq('period', settings.period));
  resetMonthly(); $('mon-el').value = Object.keys(byEl)[0]; renderMonthly(); renderPayroll(); renderDashboard(); renderReports();
  closeM('m-bulk');
  toast(`Imported ${ok.length} amount${ok.length===1?'':'s'} for ${new Set(ok.map(r=>r.code)).size} employees across ${Object.keys(byEl).length} element${Object.keys(byEl).length===1?'':'s'}`);
}
$('mon-bulk').addEventListener('click', openBulk);
$('bk-template').addEventListener('click', downloadTemplate);
$('bk-file').addEventListener('change', onBulkFile);
$('bk-import').addEventListener('click', doBulkImport);

// ═════════════════════════════════════════════════════════
//  HQ FINGERPRINT MACHINE (ZKTeco) — import punches into attendance
// ═════════════════════════════════════════════════════════
let MI = { punches:[], days:[], file:'' };
const pad2 = n => String(n).padStart(2,'0');
function miParseTime(s){
  s = String(s||'').trim(); let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/))) return new Date(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +(m[6]||0));
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?/))){      // M/d/yyyy h:mm AM (ZKTeco software export)
    let h = +m[4]; const ap = (m[7]||'').toUpperCase(); if (ap==='PM' && h<12) h+=12; if (ap==='AM' && h===12) h=0;
    return new Date(+m[3], +m[1]-1, +m[2], h, +m[5], +(m[6]||0)); }
  return null;
}
const miDay = d => `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
const miHM  = d => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const miTS  = d => `${miDay(d)} ${miHM(d)}:${pad2(d.getSeconds())}`;
// read the file: machine log (tab separated: pin, time, verify, machine, pin, I/O, …) or a CSV export with a header row
function miReadPunches(text){
  const lines = text.replace(/^\uFEFF/,'').split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) throw new Error('The file is empty');
  const delim = lines[0].includes('\t') ? '\t' : (lines[0].split(';').length > lines[0].split(',').length ? ';' : ',');
  let rows = lines.map(l => l.split(delim).map(c => c.replace(/^"|"$/g,'').trim()));
  let ix = { pin:0, ts:1, verify:2, machine:3, io:5 };
  const head = rows[0].map(h => h.toLowerCase().replace(/[\s_]/g,''));
  if (!miParseTime(rows[0][1]) && head.some(h => ['pin','acno','acno.','userid','no.','enrollnumber'].includes(h))){
    const f = names => head.findIndex(h => names.includes(h));
    ix = { pin: f(['pin','acno','acno.','userid','no.','enrollnumber','badgenumber']), ts: f(['stime','time','checktime','datetime','date/time']),
           verify: f(['verifyflag','verifycode','verify']), machine: f(['machinename','machine','sensorid','deviceid']), io: f(['checktype','state','inout','status']) };
    if (ix.pin < 0 || ix.ts < 0) throw new Error('Could not find the ID and time columns in this file');
    rows = rows.slice(1);
  }
  const out = [], bad = [];
  rows.forEach((r, n) => { const t = miParseTime(r[ix.ts]), pin = String(r[ix.pin]||'').replace(/\.0+$/,'').trim();
    if (!t || !pin) { bad.push(n+1); return; }
    out.push({ pin, t, io: String(r[ix.io]||'').trim().toUpperCase().charAt(0), machine: ix.machine>=0 ? r[ix.machine]||'' : '', verify: ix.verify>=0 ? r[ix.verify]||'' : '' }); });
  if (!out.length) throw new Error('No punches could be read from this file');
  return { punches: out, badLines: bad.length };
}
// turn punches into one record per person per day (rules explained in the import window)
function miBuildDays(punches){
  const seen = new Set(), byPin = {};
  punches.forEach(p => { const k = p.pin + '|' + p.t.getTime(); if (seen.has(k)) return; seen.add(k); (byPin[p.pin] = byPin[p.pin] || []).push(p); });
  const days = []; let repeats = 0; const dupes = punches.length - seen.size;
  Object.entries(byPin).forEach(([pin, list]) => {
    list.sort((a,b) => a.t - b.t);
    const clean = []; list.forEach(p => { if (clean.length && (p.t - clean[clean.length-1].t) < 60000) repeats++; else clean.push(p); });
    const byDay = new Map(); clean.forEach(p => { const d = miDay(p.t); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(p); });
    const keys = [...byDay.keys()].sort();
    keys.forEach(d => {                                   // clean night shift: evening "In" alone, then "Out" next morning
      const nd = miDay(new Date(new Date(d+'T12:00:00').getTime() + 86400000));
      const a = byDay.get(d), b = byDay.get(nd);
      if (a && a.length===1 && b && b.length){ const last=a[0], first=b[0];
        if (last.io==='I' && last.t.getHours()>=15 && first.io==='O' && first.t.getHours()<12 && (first.t-last.t) <= 16*3600000) a.push(b.shift()); }
    });
    keys.forEach(d => { const p = byDay.get(d); if (!p || !p.length) return;
      const first = p[0].t, last = p[p.length-1].t, hours = Math.round((last-first)/36000)/100;
      days.push({ pin, date:d, first, last, n:p.length, hours, missing: p.length===1, review: p.length>1 && hours > 16 }); });
  });
  return { days, repeats, dupes };
}
function miLocked(date){ return S.runs.find(r => date >= r.period_start && date <= r.period_end); }
function openMachineImport(){
  MI = { punches:[], days:[], file:'' };
  $('mi-from').value = periodStart(settings.period); $('mi-to').value = periodEnd(settings.period);
  $('mi-proj').value=''; $('mi-file').value=''; $('mi-fname').textContent=''; $('mi-summary').innerHTML=''; $('mi-rows').innerHTML=''; $('mi-foot').textContent='';
  $('mi-go').disabled = true; $('mi-go').textContent = 'Import';
  openM('m-mi');
}
async function miPreview(){
  const f = $('mi-file').files[0]; if (!f) return;
  $('mi-fname').textContent = f.name; $('mi-summary').innerHTML = '<div class="loading"><div class="spin"></div> Reading the punches…</div>';
  let parsed; try { parsed = miReadPunches(await readAs(f, 'text')); } catch(e){ $('mi-summary').innerHTML = `<div class="alert a-warn">${esc(e.message)}</div>`; return; }
  const from = $('mi-from').value, to = $('mi-to').value;
  const { days, repeats, dupes } = miBuildDays(parsed.punches);
  const inRange = days.filter(d => d.date >= from && d.date <= to);
  // what is already in the system for these dates
  let existing = [];
  try { existing = await fetchAll('attendance','date', q => q.gte('date', from).lte('date', to)); } catch(e){ $('mi-summary').innerHTML = `<div class="alert a-warn">${esc(e.message)}</div>`; return; }
  const exMap = new Map(existing.map(a => [a.emp_id + '|' + a.date, a]));
  inRange.forEach(d => { const e = empById(d.pin), ex = exMap.get(d.pin + '|' + d.date), lk = miLocked(d.date);
    d.emp = e; d.existing = ex;
    d.result = !e ? 'unknown' : lk ? 'locked'
      : e.project_staff ? (ex && ex.source==='Machine' ? 'site-remove' : ex && ex.source==='Combined' ? 'site-restore' : 'site')   // site staff: records only
      : !ex ? 'new' : ex.source==='Machine' ? 'replace'
      : (ex.source==='Mobile' || ex.source==='Combined') ? 'combine'                                                                  // phone + machine: first to last
      : 'kept'; });                                                                                                                   // typed in by HR: untouched
  const pins = new Set(inRange.map(d => d.pin));
  MI = { punches: parsed.punches.filter(p => { const d = miDay(p.t); return d >= from && d <= to && empById(p.pin); }), days: inRange, file: f.name };
  const cnt = k => inRange.filter(d => d.result===k).length, unknownPins = [...new Set(inRange.filter(d=>d.result==='unknown').map(d=>d.pin))];
  const willWrite = inRange.filter(d => d.result==='new' || d.result==='replace');
  $('mi-summary').innerHTML = `<div class="alert a-info" style="line-height:1.8">
    <b>${parsed.punches.length.toLocaleString()}</b> punches read${parsed.badLines?` (${parsed.badLines} unreadable lines skipped)`:''} · <b>${dupes.toLocaleString()}</b> duplicate lines ignored · <b>${repeats.toLocaleString()}</b> repeat taps merged ·
    <b>${inRange.length.toLocaleString()}</b> person-days between ${from} and ${to} for <b>${pins.size}</b> IDs<br>
    ✅ <b>${cnt('new')}</b> new records · 🔁 <b>${cnt('replace')}</b> replace an earlier machine import ·
    📱🖐 <b>${cnt('combine')}</b> combined with phone check-ins (first punch to last) · ✋ <b>${cnt('kept')}</b> kept (typed in by HR) ·
    👷 <b>${cnt('site')+cnt('site-remove')+cnt('site-restore')}</b> site staff — punches kept as records only · 🔒 <b>${cnt('locked')}</b> in an approved month (skipped)<br>
    ⚠ <b>${willWrite.filter(d=>d.missing).length}</b> with a missing punch · ⚠ <b>${willWrite.filter(d=>d.review).length}</b> over 16 hours — both flagged for HR, no deductions until corrected
    ${unknownPins.length ? `<br>❓ <b>${unknownPins.length}</b> machine ID${unknownPins.length>1?'s':''} not found among employee codes, skipped: <b>${unknownPins.slice(0,15).join(', ')}</b>${unknownPins.length>15?' …':''}` : ''}</div>`;
  const label = { new:'✅ New', replace:'🔁 Replace', combine:'📱🖐 Combined with phone', kept:'✋ Kept — typed in by HR', locked:'🔒 Approved month', unknown:'❓ Unknown ID',
                  site:'👷 Site staff — records only', 'site-remove':'👷 Site staff — earlier machine record removed', 'site-restore':'👷 Site staff — machine lines removed' };
  const show = inRange.slice().sort((a,b) => (b.missing||b.review) - (a.missing||a.review) || a.date.localeCompare(b.date)).slice(0, 400);
  $('mi-rows').innerHTML = show.map(d => `<tr><td class="mono">${d.date}</td><td class="mono">${esc(d.pin)}</td><td>${esc(d.emp ? empName(d.emp) : '')}</td>
    <td class="mono">${miHM(d.first)}</td><td class="mono">${d.missing ? '<span class="neg">missing</span>' : miHM(d.last) + (miDay(d.last)!==d.date ? ' <span style="color:var(--muted)">(+1)</span>' : '')}</td>
    <td class="num">${d.missing ? '' : fmt(d.hours)}</td><td>${label[d.result]}${d.missing && ['new','replace'].includes(d.result) ? ' · ⚠ missing punch' : ''}${d.review && ['new','replace'].includes(d.result) ? ' · ⚠ over 16 h' : ''}</td></tr>`).join('');
  $('mi-foot').textContent = inRange.length > 400 ? `Showing 400 of ${inRange.length.toLocaleString()} days — flagged days first` : '';
  const changes = willWrite.length + inRange.filter(d => ['combine','site-remove','site-restore'].includes(d.result)).length;
  $('mi-go').disabled = !changes && !MI.punches.length;
  $('mi-go').textContent = changes ? `Import ${changes.toLocaleString()} days` : 'Store the punches only';
}
async function miImport(){
  if (!MI.days.length && !MI.punches.length) return;
  const b = $('mi-go'); b.disabled = true;
  const proj = parseProjInput($('mi-proj').value) || '';
  if ($('mi-proj').value.trim() && !proj) { b.disabled=false; return toast('Pick the project from the suggestions, or leave it empty','warn'); }
  const by = (ME && (ME.full_name || ME.email)) || 'HR';
  try {
    // 1. keep the original punches (duplicates are ignored)
    b.textContent = 'Saving original punches…';
    const raw = MI.punches.map(p => ({ pin:p.pin, punched_at: miTS(p.t), machine: p.machine || null, verify: p.verify || null, io: p.io || null, imported_by: by }));
    const uniq = [...new Map(raw.map(r => [r.pin + '|' + r.punched_at, r])).values()];
    await chunked(uniq, chunk => sb.from('machine_punches').upsert(chunk, { onConflict:'pin,punched_at', ignoreDuplicates:true }), 1000);
    // 2. attendance: replace earlier machine records, add new ones
    const write = MI.days.filter(d => d.result==='new' || d.result==='replace');
    b.textContent = `Writing ${write.length.toLocaleString()} attendance days…`;
    const oldIds = write.filter(d => d.result==='replace').map(d => d.existing.id);
    if (oldIds.length) await chunked(oldIds, ids => sb.from('attendance').delete().in('id', ids), 200);
    const recs = write.map(d => ({ emp_id:d.pin, emp_name: empName(d.emp), date:d.date, status:'Present',
      check_in: miHM(d.first), check_out: d.missing ? null : miHM(d.last), total_hours: d.missing ? 0 : d.hours, ot_hours: 0, source:'Machine',
      notes: d.missing ? 'Fingerprint machine: only one punch — add the missing time' : d.review ? 'Fingerprint machine: over 16 hours — check' : null,
      projects: [{ code: proj, in: miHM(d.first), out: d.missing ? null : miHM(d.last), hours: d.missing ? 0 : d.hours, src:'Machine',
                   ...(d.missing ? { missing:true } : {}), ...(d.review ? { review:true } : {}) }] }));
    await chunked(recs, chunk => sb.from('attendance').insert(chunk), 500);
    // phone + machine on the same day: first punch to last, phone project lines kept
    const combos = MI.days.filter(d => d.result==='combine');
    b.textContent = `Combining ${combos.length} days with phone check-ins…`;
    for (const d of combos){ const { data, error } = await sb.from('attendance').update(miCombine(d.existing, d, proj)).eq('id', d.existing.id).select(); if (error) throw error; if (!(data && data.length)) throw new Error(NOPERM); }
    // site staff: their machine punches do not count
    for (const d of MI.days.filter(x => x.result==='site-remove')){ const { error } = await sb.from('attendance').delete().eq('id', d.existing.id); if (error) throw error; }
    for (const d of MI.days.filter(x => x.result==='site-restore')){ const { data, error } = await sb.from('attendance').update(miPhoneOnly(d.existing)).eq('id', d.existing.id).select(); if (error) throw error; if (!(data && data.length)) throw new Error(NOPERM); }
    closeM('m-mi');
    await loadPeriodData(); loader(false); renderAll();
    toast(`Imported ${write.length.toLocaleString()} days, combined ${combos.length} with phone check-ins, stored ${uniq.length.toLocaleString()} original punches from ${MI.file}`);
  } catch(e){
    b.disabled = false; b.textContent = 'Try again';
    toast(`Import stopped: ${e.message}. Nothing is duplicated — you can import the same file again.`, 'err');
  }
}
$('mi-open').addEventListener('click', openMachineImport);
$('mi-file').addEventListener('change', miPreview);
['mi-from','mi-to'].forEach(id => $(id).addEventListener('change', () => { if ($('mi-file').files[0]) miPreview(); }));
$('mi-go').addEventListener('click', miImport);

// ── combining a phone record with the machine punches of the same day ──
const miMin = t => { const [h,m] = String(t).split(':').map(Number); return h*60 + m; };
const miHHm = m => { m = ((Math.floor(m) % 1440) + 1440) % 1440; return `${pad2(Math.floor(m/60))}:${pad2(m%60)}`; };
const miSegHours = segs => Math.round(segs.filter(x => x.out).reduce((t,x) => t + num(x.hours), 0) * 100) / 100;
function miCombine(ex, d, proj){
  const base = new Date(d.date + 'T00:00:00'), mFirst = (d.first - base)/60000, mLast = (d.last - base)/60000;
  const phone = (ex.projects || []).filter(x => x.src !== 'Machine').map(x => ({ ...x }));
  let pFirst = Infinity, pLast = -Infinity;
  phone.forEach(x => { if (!x.in) return; const i = miMin(x.in); pFirst = Math.min(pFirst, i);
    if (x.out){ let o = miMin(x.out); if (o < i) o += 1440; pLast = Math.max(pLast, o); } else pLast = Math.max(pLast, i); });
  // a phone line left open is closed by a later machine punch
  phone.forEach(x => { if (x.in && (!x.out) && !x.missing){ const i = miMin(x.in);
    if (mLast > i){ x.out = miHHm(mLast); x.hours = Math.round((mLast - i)/60*100)/100; delete x.forgotten; x.closedBy = 'Machine'; pLast = Math.max(pLast, mLast); } } });
  const segs = [];
  if (!isFinite(pFirst)) { segs.push({ code:proj, in:miHHm(mFirst), out: mLast > mFirst ? miHHm(mLast) : null, hours: Math.max(0, Math.round((mLast-mFirst)/60*100)/100), src:'Machine' }); }
  else {
    if (mFirst < pFirst) segs.push({ code:proj, in:miHHm(mFirst), out:miHHm(pFirst), hours:Math.round((pFirst-mFirst)/60*100)/100, src:'Machine' });   // before the first phone tap
    segs.push(...phone);
    if (mLast > pLast) segs.push({ code:proj, in:miHHm(pLast), out:miHHm(mLast), hours:Math.round((mLast-pLast)/60*100)/100, src:'Machine' });         // after the last phone tap
  }
  // first sign-in from either source, last sign-out from either source; hours = the whole span between them
  const first = Math.min(mFirst, isFinite(pFirst) ? pFirst : mFirst);
  let lastOut = mLast;
  phone.forEach(x => { if (x.in && x.out){ let o = miMin(x.out); if (o < miMin(x.in)) o += 1440; lastOut = Math.max(lastOut, o); } });
  const span = lastOut > first ? Math.round((lastOut - first)/60*100)/100 : 0;
  return { check_in: miHHm(first), check_out: span > 0 ? miHHm(lastOut) : null, total_hours: span > 0 ? span : miSegHours(segs), projects: segs,
           source: 'Combined', notes: 'Phone + fingerprint machine — first punch to last punch' };
}
function miPhoneOnly(ex){
  const phone = (ex.projects || []).filter(x => x.src !== 'Machine').map(x => { const y = { ...x }; if (y.closedBy==='Machine'){ y.out = null; y.hours = 0; delete y.closedBy; } return y; });
  const ins = phone.filter(x => x.in).map(x => x.in).sort(), outs = phone.filter(x => x.out).map(x => x.out).sort();
  return { projects: phone, check_in: ins[0] || null, check_out: outs[outs.length-1] || null, total_hours: miSegHours(phone), source: 'Mobile', notes: null };
}

// ═════════════════════════════════════════════════════════
//  PAST ATTENDANCE — any date range, without changing the payroll cycle
// ═════════════════════════════════════════════════════════
async function loadAttRange(){
  const from = $('att-from').value, to = $('att-to').value;
  if (!from || !to) return toast('Choose both dates','warn');
  if (to < from) return toast('“To” is before “From”','warn');
  if ((new Date(to) - new Date(from)) / 86400000 > 400) return toast('Please choose at most about one year at a time','warn');
  const b = $('att-load'); b.disabled = true; b.textContent = 'Loading…';
  try {
    const [rows, clocks] = await Promise.all([
      fetchAll('attendance','date', q => q.gte('date', from).lte('date', to)),
      fetchAll('clock_events','at', q => q.gte('local_date', from).lte('local_date', to)).catch(() => []) ]);
    ATT_RANGE = { from, to, rows, clocks }; attDayFilter = null; $('att-day').value = '';
    renderAttendance();
    toast(`${rows.length.toLocaleString()} attendance records from ${from} to ${to}`);
  } catch(e){ toast(e.message,'err'); }
  b.disabled = false; b.textContent = 'Show';
}
function backToCycle(){ ATT_RANGE = null; attDayFilter = null; $('att-day').value=''; $('att-from').value = periodStart(settings.period); $('att-to').value = periodEnd(settings.period); renderAttendance(); }
$('att-load').addEventListener('click', loadAttRange);
$('att-cur').addEventListener('click', backToCycle);

// ═════════════════════════════════════════════════════════
//  PROJECT ALLOWANCE RULES
// ═════════════════════════════════════════════════════════
let parEditing = null;
function parRuleUse(){         // per rule: employees and amount in this payroll cycle
  const use = {};
  S.employees.filter(e => onPayroll(e, settings.period)).forEach(e => autoAllowance(e).forEach(x => {
    const u = use[x.rule] = use[x.rule] || { emps:new Set(), days:0, amount:0 }; u.emps.add(e.id); u.days += x.days; u.amount += x.amount; }));
  return use;
}
function renderParRules(){
  $('par-missing').innerHTML = parTableMissing ? '<div class="alert a-warn">The rules table does not exist yet. Run <b>project-allowance.sql</b>, then click ⟳ Refresh.</div>' : '';
  const q = $('par-q').value.trim().toLowerCase(), use = currentRun() ? {} : parRuleUse();
  const who = r => r.applies_to==='employee' ? `👤 ${esc(empName(empById(r.emp_id)) || r.emp_id)} <span class="mono" style="color:var(--muted)">${esc(r.emp_id)}</span>` : `🧰 All “${esc(r.job_name)}”`;
  const parSt = r => r.active===false ? 'Paused' : 'Active';
  const base = S.parRules.filter(r => !q || [r.emp_id, empName(empById(r.emp_id)), r.job_name, r.project_code, projName(r.project_code), r.notes].some(v => String(v||'').toLowerCase().includes(q)))
    .sort((a,b) => (a.applies_to===b.applies_to ? 0 : a.applies_to==='employee' ? -1 : 1) || String(a.project_code||'~').localeCompare(String(b.project_code||'~')));
  const st = stFill('par-status', base.map(parSt));
  const list = base.filter(r => !st || parSt(r)===st);
  $('par-tbl').innerHTML = list.map(r => { const u = use[r.id];
    return `<tr${r.active===false?' style="opacity:.55"':''}><td>${who(r)}</td><td>${r.project_code ? esc(projLabel(r.project_code)) : '<span class="chip c-blue">Any project</span>'}</td>
      <td class="num strong">${fmt(r.amount_per_day)}</td>
      <td>${currentRun() ? '<span style="color:var(--muted)">approved month</span>' : u ? `${u.emps.size} employee${u.emps.size>1?'s':''} · ${u.days} day${u.days>1?'s':''} · <b>${fmt(u.amount)}</b>` : '<span style="color:var(--muted)">—</span>'}</td>
      <td>${r.active===false ? '<span class="chip c-grey">Paused</span>' : '<span class="chip c-green">Active</span>'}</td><td style="white-space:normal">${esc(r.notes||'')}</td>
      <td style="white-space:nowrap"><button class="btn btn-ghost btn-sm" data-par-edit="${r.id}">Edit</button> <button class="icon-btn" data-par-del="${r.id}" title="Delete">🗑</button></td></tr>`; }).join('')
    || `<tr><td colspan="7" class="empty">${S.parRules.length ? 'No rules for this selection' : 'No rules yet — click “+ New rule”.'}</td></tr>`;
  const tot = Object.values(use).reduce((s,u) => s + u.amount, 0);
  const paid = S.allowAppr.filter(a => a.status==='Approved').reduce((s,a) => s + num(a.amount), 0);
  $('par-foot').innerHTML = `${S.parRules.length} rule${S.parRules.length===1?'':'s'}${currentRun() ? '' : ` · calculated this cycle: <b>${fmt(tot)}</b> EGP · approved by manager and HR (paid): <b>${fmt(paid)}</b> EGP — <a href="#" data-nav="approvals" style="color:var(--link)">go to approvals</a>`}`;
}
function parShowType(){ const emp = $('par-type').value==='employee'; $('par-emp-f').style.display = emp ? '' : 'none'; $('par-job-f').style.display = emp ? 'none' : ''; parHint(); }
function parHint(){
  const type=$('par-type').value, amt=num($('par-amt').value), proj=parseProjInput($('par-proj').value);
  let n=0; if (type==='job'){ const j=$('par-job').value.trim().toLowerCase(); n = activeEmps().filter(e=>String(e.job_name||'').trim().toLowerCase()===j).length; }
  $('par-hint').textContent = type==='job' ? `${n} active employee${n===1?'':'s'} currently have this job title.` : '';
  if (amt) $('par-hint').textContent += ` Each qualifying day adds ${fmt(amt)} EGP${proj ? ' at ' + projLabel(proj) : ' at any project'}.`;
}
function openParRule(id){
  const r = id ? S.parRules.find(x => x.id===id) : null; parEditing = r ? r.id : null;
  $('par-title').textContent = r ? 'Edit project allowance rule' : 'New project allowance rule';
  $('par-type').value = r ? r.applies_to : 'employee';
  $('par-emp').value = r && r.emp_id ? `${r.emp_id} — ${empName(empById(r.emp_id))}` : '';
  $('par-job').value = r ? (r.job_name||'') : ''; $('par-proj').value = r && r.project_code ? projLabel(r.project_code) : '';
  $('par-amt').value = r ? r.amount_per_day : ''; $('par-active').value = r && r.active===false ? 'false' : 'true'; $('par-notes').value = r ? (r.notes||'') : '';
  parShowType(); openM('m-par');
}
async function saveParRule(){
  const type=$('par-type').value, amt=num($('par-amt').value), ptxt=$('par-proj').value.trim(), proj = ptxt ? parseProjInput(ptxt) : null;
  const empId = type==='employee' ? parseEmpInput($('par-emp').value) : null, job = type==='job' ? $('par-job').value.trim() : null;
  if (type==='employee' && !empById(empId)) return toast('Pick the employee from the suggestions','warn');
  if (type==='job' && !job) return toast('Enter the job title','warn');
  if (ptxt && !proj) return toast('Pick the project from the suggestions, or leave it empty for any project','warn');
  if (!(amt > 0)) return toast('Enter the amount per day','warn');
  const same = S.parRules.find(x => x.id !== parEditing && x.applies_to===type && String(x.emp_id||'')===String(empId||'')
                && String(x.job_name||'').trim().toLowerCase()===String(job||'').trim().toLowerCase() && (x.project_code||'')===(proj||''));
  if (same) return toast(`A rule for ${type==='employee' ? empName(empById(empId)) : '“'+job+'”'} at ${proj ? projLabel(proj) : 'any project'} already exists (${fmt(same.amount_per_day)} a day) — edit that one instead`,'warn');
  const rec = { applies_to:type, emp_id:empId, job_name:job, project_code:proj, amount_per_day:amt, active: $('par-active').value==='true',
                notes: $('par-notes').value.trim() || null, ...(parEditing ? {} : { created_by: (ME && (ME.full_name||ME.email)) || null }) };
  const res = parEditing ? await sb.from('project_allowance_rules').update(rec).eq('id', parEditing).select() : await sb.from('project_allowance_rules').insert(rec).select();
  if (res.error) return toast(/duplicate|idx_par_unique/i.test(res.error.message) ? 'A rule for the same employee/job and project already exists — edit that one instead' : res.error.message, 'err');
  if (!(res.data && res.data.length)) return toast(NOPERM,'err');
  S.parRules = S.parRules.filter(x => x.id !== res.data[0].id).concat(res.data);
  closeM('m-par'); renderParRules(); DIRTY.add('payroll'); DIRTY.add('reports'); renderDashboard();
  toast(parEditing ? 'Rule updated' : 'Rule added — the payroll now includes it');
}
$('par-new').addEventListener('click', () => openParRule(null));
$('par-save').addEventListener('click', saveParRule);
$('par-type').addEventListener('change', parShowType);
['par-job','par-amt','par-proj'].forEach(id => $(id).addEventListener('input', parHint));
$('par-q').addEventListener('input', renderParRules);
$('par-tbl').addEventListener('click', e => {
  const ed = e.target.closest('[data-par-edit]'); if (ed) return openParRule(ed.dataset.parEdit);
  const dl = e.target.closest('[data-par-del]');
  if (dl) { const id = dl.dataset.parDel; confirmDel('Delete this rule? The automatic allowance it gives will disappear from payrolls that are not yet approved.', async () => {
    const { data, error } = await sb.from('project_allowance_rules').delete().eq('id', id).select(); if (error) throw error; if (!(data && data.length)) throw new Error(NOPERM);
    S.parRules = S.parRules.filter(x => x.id !== id); renderParRules(); DIRTY.add('payroll'); DIRTY.add('reports'); toast('Rule deleted'); }); }
});

// ═════════════════════════════════════════════════════════
//  ALLOWANCE APPROVALS — direct manager first, then HR; paid only when both approved
// ═════════════════════════════════════════════════════════
function aaCalculated(){                       // every employee with an automatic amount this cycle
  return S.employees.filter(e => onPayroll(e, settings.period)).map(e => {
    const parts = autoAllowance(e); const amount = Math.round(parts.reduce((s,x) => s + x.amount, 0) * 100) / 100;
    const details = parts.map(x => ({ project:x.project, project_name: projName(x.project), days:x.days, rate:x.rate, amount:x.amount }));
    return { emp:e, amount, details };
  }).filter(x => x.amount > 0);
}
const aaWorking = d => (d||[]).map(x => `${x.days}d × ${fmt(x.rate)} @ ${x.project}`).join(' + ');
const aaSame = (a, b) => Math.abs(num(a) - num(b)) < 0.005;
function aaRows(){
  const calc = new Map(aaCalculated().map(x => [String(x.emp.id), x]));
  const rows = [];
  calc.forEach((c, id) => rows.push({ emp:c.emp, calc:c, rec: S.allowAppr.find(a => String(a.emp_id)===id) }));
  S.allowAppr.forEach(a => { if (!calc.has(String(a.emp_id))) rows.push({ emp: empById(a.emp_id) || { id:a.emp_id, name_en:a.emp_name }, calc:{ amount:0, details:[] }, rec:a }); });
  rows.forEach(r => { r.state = r.rec ? r.rec.status : 'Not sent'; r.changed = !!r.rec && !aaSame(r.rec.amount, r.calc.amount); });
  return rows;
}
function renderApprovals(){
  $('aa-missing').innerHTML = apprTableMissing ? '<div class="alert a-warn">The approvals table does not exist yet. Run <b>allowance-approvals.sql</b>, then click ⟳ Refresh.</div>' : '';
  if (currentRun()) { $('aa-sub').textContent = `${periodLabel(settings.period)} is approved and locked — its allowances are final`; }
  const rows = aaRows(), st = $('aa-status').value, q = $('aa-q').value.trim().toLowerCase();
  const count = s => rows.filter(r => r.state===s).length, sum = s => rows.filter(r => r.state===s).reduce((t,r) => t + num(r.rec ? r.rec.amount : r.calc.amount), 0);
  const card = (l, n, v, sub) => `<div class="stat"><div class="stat-label">${l}</div><div class="stat-value">${n}</div><div class="stat-sub">${sub || fmt(v) + ' EGP'}</div></div>`;
  $('aa-stats').innerHTML = card('Not sent yet', count('Not sent'), sum('Not sent')) + card('Waiting for manager', count('Pending manager'), sum('Pending manager'))
    + card('Waiting for HR', count('Pending HR'), sum('Pending HR')) + card('Approved — will be paid', count('Approved'), sum('Approved')) + card('Rejected', count('Rejected'), sum('Rejected'));
  const noMgr = rows.filter(r => r.state==='Not sent' && !r.emp.manager_id);
  $('aa-nomgr').innerHTML = noMgr.length ? `<div class="alert a-warn">⚠ <b>${noMgr.length}</b> employee${noMgr.length>1?'s have':' has'} no direct manager, so ${noMgr.length>1?'their allowances':'the allowance'} cannot be sent: <b>${noMgr.slice(0,12).map(r => esc(r.emp.id + ' ' + empName(r.emp))).join(', ')}</b>${noMgr.length>12?' …':''}. Set the manager on <a href="#" data-nav="reporting" style="color:var(--link)">Reporting lines</a>.</div>` : '';
  const chipFor = r => r.state==='Not sent' ? '<span class="chip c-grey">Not sent</span>' : r.state==='Pending manager' ? '<span class="chip c-orange">Waiting for manager</span>'
    : r.state==='Pending HR' ? '<span class="chip c-blue">Waiting for HR</span>' : r.state==='Approved' ? '<span class="chip c-green">Approved</span>' : '<span class="chip c-red">Rejected</span>';
  const list = rows.filter(r => orgMatch(r.emp,'aa') && (!st || (st==='changed' ? r.changed : r.state===st)) && (!q || [r.emp.id, empName(r.emp), r.rec && r.rec.emp_name].some(v => String(v||'').toLowerCase().includes(q))))
    .sort((a,b) => ['Pending HR','Not sent','Pending manager','Rejected','Approved'].indexOf(a.state) - ['Pending HR','Not sent','Pending manager','Rejected','Approved'].indexOf(b.state) || String(a.emp.id).localeCompare(String(b.emp.id), undefined, { numeric:true }));
  const locked = !!currentRun(), mine = id => ME && ME.emp_id && String(ME.emp_id)===String(id);
  $('aa-tbl').innerHTML = list.map(r => { const a = r.rec, m = empById((a && a.manager_id) || r.emp.manager_id);
    const act = locked ? '' : r.state==='Pending HR' && !mine(r.emp.id) ? `<button class="btn btn-success btn-sm" data-aa-ok="${a.id}">Approve</button> <button class="btn btn-ghost btn-sm" data-aa-no="${a.id}">Reject</button>`
      : (r.changed || r.state==='Rejected') && r.calc.amount > 0 && r.emp.manager_id ? `<button class="btn btn-ghost btn-sm" data-aa-resend="${esc(r.emp.id)}" title="Send the current amount to the manager again">↻ Re-send</button>` : '';
    return `<tr><td class="strong">${esc(empName(r.emp) || (a && a.emp_name) || r.emp.id)} <span class="mono" style="color:var(--muted)">${esc(r.emp.id)}</span></td>
      <td>${m ? esc(empName(m)) : '<span class="neg">none</span>'}</td><td style="font-size:12px;color:var(--label);white-space:normal;min-width:180px">${esc(aaWorking(r.calc.details))}</td>
      <td class="num">${fmt(r.calc.amount)}</td><td class="num strong">${a ? fmt(a.amount) : '—'}${r.changed ? ' <span class="chip c-orange" title="Attendance changed after it was sent">changed</span>' : ''}</td>
      <td>${chipFor(r)}</td>
      <td style="font-size:12px;white-space:normal;min-width:120px">${a && a.manager_at ? `${esc(a.manager_by||'')} · ${esc(String(a.manager_at).slice(0,10))}${a.manager_note?`<br>💬 ${esc(a.manager_note)}`:''}` : ''}</td>
      <td style="font-size:12px;white-space:normal;min-width:120px">${a && a.hr_at ? `${esc(a.hr_by||'')} · ${esc(String(a.hr_at).slice(0,10))}${a.hr_note?`<br>💬 ${esc(a.hr_note)}`:''}` : ''}</td>
      <td style="white-space:nowrap">${act}${mine(r.emp.id) && r.state==='Pending HR' ? '<span style="font-size:11px;color:var(--muted)">another HR user must approve your own</span>' : ''}</td></tr>`; }).join('')
    || '<tr><td colspan="9" class="empty">No automatic allowances this cycle. Add rules on the Project allowance rules page.</td></tr>';
  $('aa-foot').textContent = `${list.length} shown · only “Approved” amounts are paid, exactly as approved`;
  $('aa-send').disabled = locked; $('aa-approve-all').disabled = locked || !count('Pending HR');
}
async function aaSend(){
  if (currentRun()) return toast('This payroll month is approved and locked','warn');
  const by = (ME && (ME.full_name || ME.email)) || 'HR';
  const rows = aaRows(), inserts = [], resends = [];
  rows.forEach(r => {
    if (!r.calc.amount || !r.emp.manager_id) return;
    const base = { emp_id:String(r.emp.id), emp_name: empName(r.emp), job_name: r.emp.job_name || null, period: settings.period, amount: r.calc.amount, details: r.calc.details, manager_id: r.emp.manager_id, submitted_by: by };
    if (!r.rec) inserts.push({ ...base, status:'Pending manager' });
    else if (r.rec.status==='Pending manager' && (r.changed || String(r.rec.manager_id)!==String(r.emp.manager_id))) resends.push({ id:r.rec.id, rec:base });
  });
  const skipped = rows.filter(r => !r.rec && r.calc.amount && !r.emp.manager_id).length;
  const later = rows.filter(r => r.rec && r.rec.status!=='Pending manager' && r.changed).length;
  if (!inserts.length && !resends.length) return toast(`Nothing new to send${skipped ? ` · ${skipped} without a direct manager` : ''}${later ? ` · ${later} changed after a decision — use ↻ Re-send on those rows` : ''}`, 'warn');
  confirmDel(`Send ${inserts.length + resends.length} allowance${inserts.length+resends.length>1?'s':''} to the employees' direct managers for approval? (${fmt(inserts.concat(resends.map(x=>x.rec)).reduce((s,x)=>s+num(x.amount),0))} EGP)`, async () => {
    if (inserts.length) await chunked(inserts, c => sb.from('allowance_approvals').insert(c), 200);
    for (const x of resends){ const { error } = await sb.from('allowance_approvals').update({ ...x.rec, status:'Pending manager' }).eq('id', x.id); if (error) throw error; }
    S.allowAppr = await fetchAll('allowance_approvals','emp_id', q => q.eq('period', settings.period));
    renderApprovals(); renderDashboard();
    toast(`${inserts.length + resends.length} sent to managers${skipped ? ` · ${skipped} not sent (no direct manager)` : ''}`);
  });
  $('del-title').textContent='Please confirm'; $('del-ok').textContent='Send'; $('del-ok').className='btn btn-primary';
}
async function aaHrDecide(ids, approve, note){
  const by = (ME && (ME.full_name || ME.email)) || 'HR';
  const { data, error } = await sb.from('allowance_approvals').update({ status: approve ? 'Approved' : 'Rejected', hr_by:by, hr_at:new Date().toISOString(), hr_note: note || null }).in('id', ids).select();
  if (error) return toast(error.message.replace(/^.*?(You cannot|HR can approve|Only the)/,'$1'),'err');
  if (!(data && data.length)) return toast(NOPERM,'err');
  data.forEach(d => { S.allowAppr = S.allowAppr.map(a => a.id===d.id ? d : a); });
  renderApprovals(); renderDashboard(); DIRTY.add('payroll'); DIRTY.add('reports');
  toast(`${data.length} allowance${data.length>1?'s':''} ${approve ? 'approved — included in the payroll' : 'rejected'}`);
}
async function aaResend(empId){
  const r = aaRows().find(x => String(x.emp.id)===String(empId)); if (!r || !r.rec) return;
  const by = (ME && (ME.full_name || ME.email)) || 'HR';
  const { data, error } = await sb.from('allowance_approvals').update({ status:'Pending manager', amount:r.calc.amount, details:r.calc.details, manager_id:r.emp.manager_id,
    emp_name: empName(r.emp), submitted_by:by, submitted_at:new Date().toISOString() }).eq('id', r.rec.id).select();
  if (error) return toast(error.message,'err'); if (!(data && data.length)) return toast(NOPERM,'err');
  S.allowAppr = S.allowAppr.map(a => a.id===data[0].id ? data[0] : a); renderApprovals(); renderDashboard(); DIRTY.add('payroll');
  toast(`${empName(r.emp)}: ${fmt(r.calc.amount)} sent to the manager again`);
}
$('aa-send').addEventListener('click', aaSend);
$('aa-approve-all').addEventListener('click', () => {
  const ids = S.allowAppr.filter(a => a.status==='Pending HR' && !(ME && ME.emp_id && String(ME.emp_id)===String(a.emp_id))).map(a => a.id);
  if (!ids.length) return toast('Nothing is waiting for HR (your own allowance must be approved by another HR user)','warn');
  const tot = S.allowAppr.filter(a => ids.includes(a.id)).reduce((s,a) => s + num(a.amount), 0);
  confirmDel(`Approve ${ids.length} allowance${ids.length>1?'s':''} already approved by the managers (${fmt(tot)} EGP)?`, () => aaHrDecide(ids, true));
  $('del-title').textContent='Please confirm'; $('del-ok').textContent='Approve all'; $('del-ok').className='btn btn-success';
});
$('aa-tbl').addEventListener('click', e => {
  const ok = e.target.closest('[data-aa-ok]'); if (ok) return aaHrDecide([ok.dataset.aaOk], true);
  const no = e.target.closest('[data-aa-no]'); if (no) { const note = prompt('Reason for rejecting (the employee\'s manager and HR will see it):'); if (note === null) return; return aaHrDecide([no.dataset.aaNo], false, note.trim() || 'Rejected by HR'); }
  const rs = e.target.closest('[data-aa-resend]'); if (rs) return aaResend(rs.dataset.aaResend);
});
['aa-status'].forEach(id => $(id).addEventListener('change', renderApprovals));
$('aa-q').addEventListener('input', renderApprovals);

// ═════════════════════════════════════════════════════════
//  DEPARTMENT + UNIT FILTERS — on every page that lists employees
// ═════════════════════════════════════════════════════════
const ORG_PAGES = { emp:()=>renderEmployees(), att:()=>renderAttendance(), perm:()=>renderPermissions(), lv:()=>renderLeaves(), pn:()=>renderPenalties(),
  hq:()=>renderHrRequests(), ex:()=>renderExempt(), rl:()=>renderReporting(), mon:()=>renderMonthly(), pay:()=>renderPayroll(), aa:()=>renderApprovals(),
  hs:()=>renderHistLines(), as:()=>renderAssign(), rep:()=>{ if (repCur) runReport(); } };
// does this employee match the department and unit chosen on page p?
function orgMatch(e, p){
  const d = ($(p+'-dept') || {}).value || '', u = ($(p+'-unit') || {}).value || '';
  if (!d && !u) return true; e = e || {};
  return (!d || e.department === d) && (!u || e.unit === u);
}
// reports: use the row's own department/unit, or look the employee up by code
function repOrgMatch(x){
  const d = $('rep-dept').value, u = $('rep-unit') ? $('rep-unit').value : '';
  if (!d && !u) return true;
  let dep = 'department' in x ? x.department : undefined, un = 'unit' in x ? x.unit : undefined;
  if ((d && dep === undefined) || (u && un === undefined)){
    const e = empById(x.code ?? x.emp_id ?? x.id);
    if (e){ if (dep === undefined) dep = e.department; if (un === undefined) un = e.unit; }
  }
  return (!d || dep === undefined || dep === d) && (!u || un === undefined || un === u);   // rows not about one employee (e.g. project totals) stay
}
function orgDeptOptions(){ return '<option value="">All departments</option>' + [...new Set(S.employees.map(e=>e.department).filter(Boolean))].sort().map(d=>`<option>${esc(d)}</option>`).join(''); }
function orgFillUnits(p){
  const sel = $(p+'-unit'); if (!sel) return;
  const d = $(p+'-dept') ? $(p+'-dept').value : '', keep = sel.value;
  const units = [...new Set(S.employees.filter(e => !d || e.department === d).map(e => e.unit).filter(Boolean))].sort();
  sel.innerHTML = `<option value="">${d ? 'All units in this department' : 'All units'}</option>` + units.map(u => `<option>${esc(u)}</option>`).join('');
  sel.value = units.includes(keep) ? keep : '';
}
// add the boxes where they are missing, once
(function orgInject(){
  Object.keys(ORG_PAGES).forEach(p => {
    if (!$(p+'-dept')){ const q = $(p+'-q'); if (!q) return; q.insertAdjacentHTML('beforebegin', `<select class="sel" id="${p}-dept"><option value="">All departments</option></select>`); }
    if (!$(p+'-unit')) $(p+'-dept').insertAdjacentHTML('afterend', `<select class="sel" id="${p}-unit"><option value="">All units</option></select>`);
    $(p+'-dept').addEventListener('change', () => { orgFillUnits(p); ORG_PAGES[p](); });
    $(p+'-unit').addEventListener('change', () => ORG_PAGES[p]());
  });
})();
// keep the lists filled whenever employee data is (re)loaded
const _orgBuildLists = buildLists;
buildLists = function(){
  _orgBuildLists.apply(this, arguments);
  const opts = orgDeptOptions();
  Object.keys(ORG_PAGES).forEach(p => { const ds = $(p+'-dept'); if (!ds) return;
    if (ds.options.length <= 1){ const v = ds.value; ds.innerHTML = opts; ds.value = v; }
    orgFillUnits(p); });
};

// ═════════════════════════════════════════════════════════
//  PHONE SIGN-IN ATTEMPTS — review window
// ═════════════════════════════════════════════════════════
function openPhoneAlerts(){
  const open = S.phoneAlerts.filter(a => !a.reviewed).sort((a,b) => (a.kind==='other_employee_phone' ? 0 : 1) - (b.kind==='other_employee_phone' ? 0 : 1) || String(b.last_at).localeCompare(String(a.last_at)));
  const canReview = ME && ['admin','hr'].includes(ME.role);
  $('phal-tbl').innerHTML = open.map(a => `<tr><td class="mono" style="white-space:nowrap">${esc(fmtSent(a.last_at))}</td>
      <td class="strong">${a.kind==='other_employee_phone' ? '🚨 Another employee\'s phone' : 'ℹ Unregistered phone'}</td>
      <td>${esc(a.attempted_emp_id || '')} ${esc(a.attempted_name || empName(empById(a.attempted_emp_id)) || '')}</td>
      <td>${a.owner_emp_id ? esc(a.owner_emp_id + ' ' + (a.owner_name || empName(empById(a.owner_emp_id)) || '')) : '—'}</td>
      <td>${esc(a.device_label || '')}</td><td class="num">${a.attempts}</td>
      <td>${canReview ? `<input class="inp" style="width:170px" placeholder="e.g. spoke to both" data-phal-note="${a.id}">` : ''}</td>
      <td>${canReview ? `<button class="btn btn-success btn-sm" data-phal-ok="${a.id}">Mark reviewed</button>` : ''}</td></tr>`).join('')
    || '<tr><td colspan="8" class="empty">Nothing to review</td></tr>';
  openM('m-phal');
}
async function reviewPhoneAlert(id){
  const note = (document.querySelector(`[data-phal-note="${id}"]`) || {}).value || '';
  const { data, error } = await sb.from('phone_alerts').update({ reviewed:true, reviewed_by:(ME && (ME.full_name || ME.email)) || 'HR', reviewed_at:new Date().toISOString(), review_note: note.trim() || null }).eq('id', id).select();
  if (error) return toast(error.message, 'err'); if (!(data && data.length)) return toast(NOPERM, 'err');
  S.phoneAlerts = S.phoneAlerts.map(a => a.id === id ? data[0] : a);
  renderDashboard(); openPhoneAlerts(); toast('Marked as reviewed');
}
document.addEventListener('click', e => {
  if (e.target.closest('[data-open-phal]')) return openPhoneAlerts();
  const ok = e.target.closest('[data-phal-ok]'); if (ok) return reviewPhoneAlert(ok.dataset.phalOk);
});

// ═════════════════════════════════════════════════════════
//  PROJECT ASSIGNMENTS — HR / admin page
// ═════════════════════════════════════════════════════════
let asSel = null, asTicked = new Set();
const asCount = id => S.empProjects.filter(x => String(x.emp_id) === String(id)).length;
function renderAssign(){
  $('as-missing').innerHTML = assignTableMissing ? '<div class="alert a-warn">The assignments table does not exist yet. Run <b>project-assignments.sql</b>, then click ⟳ Refresh.</div>' : '';
  const q = $('as-q').value.trim().toLowerCase(), show = $('as-show').value;
  const list = activeEmps().filter(e => orgMatch(e,'as') && (!q || [e.id, e.name_en, e.name_ar, e.job_name].some(v => String(v||'').toLowerCase().includes(q))))
    .map(e => ({ e, n: asCount(e.id) })).filter(x => !show || (show==='with' ? x.n : !x.n))
    .sort((a,b) => (b.n>0) - (a.n>0) || String(a.e.id).localeCompare(String(b.e.id), undefined, { numeric:true }));
  $('as-tbl').innerHTML = list.slice(0, 400).map(({e,n}) => `<tr class="clickable${asSel===String(e.id)?' sel':''}" data-as-emp="${esc(e.id)}" style="cursor:pointer${asSel===String(e.id)?';background:var(--hover)':''}">
      <td class="as-chk"><input type="checkbox" data-as-tick="${esc(e.id)}"${asTicked.has(String(e.id))?' checked':''}></td>
      <td class="mono">${esc(e.id)}</td><td class="strong">${esc(empName(e))}</td><td>${esc(e.department||'')}</td><td>${esc(e.unit||'')}</td><td>${esc(e.job_name||'')}</td>
      <td>${esc(empName(empById(e.manager_id)) || '')}</td><td class="num">${n ? `<b>${n}</b>` : '<span style="color:var(--muted)">any</span>'}</td></tr>`).join('')
    || '<tr><td colspan="8" class="empty">No employees match</td></tr>';
  const withN = new Set(S.empProjects.map(x => String(x.emp_id))).size;
  $('as-foot').textContent = `${list.length} shown${list.length>400?' (first 400 — narrow the filters)':''} · ${withN} employee${withN===1?'':'s'} with assigned projects · ${S.empProjects.length} assignments in total`;
  $('as-bulk-go').textContent = `Add to ticked (${asTicked.size})`;
  renderAssignDetail();
}
function renderAssignDetail(){
  if (!asSel){ $('as-detail').style.display = 'none'; return; }
  const e = empById(asSel) || { id: asSel }, rows = S.empProjects.filter(x => String(x.emp_id) === String(asSel)).sort((a,b) => String(a.project_code).localeCompare(String(b.project_code)));
  $('as-detail').style.display = '';
  $('as-detail-title').innerHTML = `📌 ${esc(empName(e))} <span class="mono" style="color:var(--muted)">${esc(e.id)}</span> — ${rows.length ? `${rows.length} project${rows.length>1?'s':''}: can check in only at these` : 'no projects: can check in at any project'}`;
  $('as-proj-tbl').innerHTML = rows.map(r => `<tr><td class="mono">${esc(r.project_code)}</td><td>${esc(projName(r.project_code) || '')}</td>
      <td>${esc(r.assigned_by || '')} <span class="chip c-grey">${esc(r.assigned_role || '')}</span></td><td class="mono">${esc(fmtSent(r.assigned_at))}</td>
      <td><button class="icon-btn" data-as-rm="${esc(r.project_code)}" title="Remove">🗑</button></td></tr>`).join('')
    || '<tr><td colspan="5" class="empty">No projects assigned — add one above</td></tr>';
}
async function assignProjects(empIds, code){
  const recs = empIds.filter(id => !S.empProjects.some(x => String(x.emp_id)===String(id) && x.project_code===code)).map(id => ({ emp_id:String(id), project_code:code }));
  if (!recs.length) return toast('Already assigned', 'warn');
  const { data, error } = await sb.from('employee_projects').insert(recs).select();
  if (error) return toast(error.message, 'err'); if (!(data && data.length)) return toast(NOPERM, 'err');
  S.empProjects = S.empProjects.concat(data); renderAssign();
  toast(`${projLabel(code)} added for ${data.length} employee${data.length>1?'s':''}`);
}
async function unassignProject(empId, code){
  const { data, error } = await sb.from('employee_projects').delete().eq('emp_id', empId).eq('project_code', code).select();
  if (error) return toast(error.message, 'err'); if (!(data && data.length)) return toast(NOPERM, 'err');
  S.empProjects = S.empProjects.filter(x => !(String(x.emp_id)===String(empId) && x.project_code===code)); renderAssign(); toast('Project removed');
}
$('as-q').addEventListener('input', renderAssign);
$('as-show').addEventListener('change', renderAssign);
$('as-tbl').addEventListener('click', e => {
  const tk = e.target.closest('[data-as-tick]'); if (tk){ tk.checked ? asTicked.add(tk.dataset.asTick) : asTicked.delete(tk.dataset.asTick); $('as-bulk-go').textContent = `Add to ticked (${asTicked.size})`; return; }
  const r = e.target.closest('[data-as-emp]'); if (r){ asSel = r.dataset.asEmp; renderAssign(); }
});
$('as-all').addEventListener('change', () => { document.querySelectorAll('#as-tbl [data-as-tick]').forEach(c => { c.checked = $('as-all').checked; c.checked ? asTicked.add(c.dataset.asTick) : asTicked.delete(c.dataset.asTick); }); $('as-bulk-go').textContent = `Add to ticked (${asTicked.size})`; });
$('as-add-go').addEventListener('click', () => { const c = parseProjInput($('as-add-proj').value); if (!c) return toast('Pick the project from the suggestions','warn'); assignProjects([asSel], c).then(() => $('as-add-proj').value=''); });
$('as-bulk-go').addEventListener('click', () => { const c = parseProjInput($('as-bulk-proj').value); if (!c) return toast('Pick the project from the suggestions','warn'); if (!asTicked.size) return toast('Tick the employees first','warn');
  confirmDel(`Add ${projLabel(c)} to ${asTicked.size} employee${asTicked.size>1?'s':''}?`, () => assignProjects([...asTicked], c));
  $('del-title').textContent='Please confirm'; $('del-ok').textContent='Add'; $('del-ok').className='btn btn-primary'; });
$('as-proj-tbl').addEventListener('click', e => { const rm = e.target.closest('[data-as-rm]'); if (rm) confirmDel(`Remove ${projLabel(rm.dataset.asRm)} from ${empName(empById(asSel))}?`, () => unassignProject(asSel, rm.dataset.asRm)); });

// ── a manager on the desktop (My requests → Team approvals) ──
let tprojEmp = null, tprojT;
async function openTeamProj(empId){
  tprojEmp = empId; const m = (SD.myTeam||[]).find(x => x.id === empId) || { id: empId };
  const { data, error } = await sb.rpc('team_projects', { p_emp: empId }); if (error) return toast(error.message, 'err');
  $('tproj-title').textContent = `📌 ${m.name_en || m.name_ar || empId} — ${(data||[]).length ? 'can check in only at these projects' : 'no projects: any project'}`;
  $('tproj-tbl').innerHTML = (data||[]).map(p => `<tr><td class="mono">${esc(p.id)}</td><td>${esc(p.name||'')}</td><td>${esc(p.assigned_by||'')}</td><td><button class="icon-btn" data-tproj-rm="${esc(p.id)}" title="Remove">🗑</button></td></tr>`).join('')
    || '<tr><td colspan="4" class="empty">No projects yet</td></tr>';
  $('tproj-tbl').dataset.have = JSON.stringify((data||[]).map(p => p.id));
  $('tproj-q').value=''; $('tproj-res').innerHTML=''; openM('m-tproj');
}
async function teamProjChangeDesk(code, add){
  const res = add ? await sb.from('employee_projects').insert({ emp_id: tprojEmp, project_code: code }).select()
                  : await sb.from('employee_projects').delete().eq('emp_id', tprojEmp).eq('project_code', code).select();
  if (res.error) return toast(res.error.message, 'err'); if (!(res.data && res.data.length)) return toast(NOPERM, 'err');
  toast(add ? 'Project added' : 'Project removed');
  const r = await sb.rpc('my_team'); if (SD) SD.myTeam = r.data || SD.myTeam; renderSelf(); openTeamProj(tprojEmp);
}
$('tproj-q').addEventListener('input', () => { clearTimeout(tprojT); tprojT = setTimeout(async () => {
  const q = $('tproj-q').value.trim(); if (q.length < 2){ $('tproj-res').innerHTML=''; return; }
  const r = await sb.rpc('find_projects', { p_q: q }), have = new Set(JSON.parse($('tproj-tbl').dataset.have || '[]'));
  $('tproj-res').innerHTML = (r.data||[]).filter(p => !have.has(p.id)).map(p => `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border)"><span><b class="mono">${esc(p.id)}</b> ${esc(p.name||'')}</span><button class="btn btn-primary btn-sm" data-tproj-add="${esc(p.id)}">+ Add</button></div>`).join('') || '<div style="color:var(--muted);font-size:13px">No matching projects</div>';
}, 300); });
document.addEventListener('click', e => {
  const tp = e.target.closest('[data-tproj]'); if (tp) return openTeamProj(tp.dataset.tproj);
  const ta = e.target.closest('[data-tproj-add]'); if (ta) return teamProjChangeDesk(ta.dataset.tprojAdd, true);
  const tr = e.target.closest('[data-tproj-rm]'); if (tr) return teamProjChangeDesk(tr.dataset.tprojRm, false);
});

// ═════════════════════════════════════════════════════════
//  EMPLOYEE RECORD — the projects this employee may check in at
// ═════════════════════════════════════════════════════════
const _openEmpWithProjects = openEmp;
openEmp = function(id){
  _openEmpWithProjects.apply(this, arguments);
  const box = $('emp-proj'); if (!box) return;
  if (!id){ box.innerHTML = '<span style="color:var(--muted)">Save the employee first.</span>'; return; }
  const rows = S.empProjects.filter(x => String(x.emp_id) === String(id)).sort((a,b) => String(a.project_code).localeCompare(String(b.project_code)));
  box.innerHTML = (rows.length ? `<div style="margin-bottom:6px;color:var(--label)">Can check in <b>only</b> at these ${rows.length} project${rows.length>1?'s':''}:</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px">${rows.map(r => `<span class="tag" title="Assigned by ${esc(r.assigned_by||'')} · ${esc(fmtSent(r.assigned_at))}">${esc(r.project_code)}${projName(r.project_code) ? ' · ' + esc(projName(r.project_code)) : ''}</span>`).join('')}</div>`
    : '<span style="color:var(--muted)">No projects assigned — can check in at any project.</span>')
    + ` <a href="#" data-goto-assign="${esc(id)}" style="color:var(--link);margin-inline-start:8px">Manage on the Project assignments page →</a>`;
};
document.addEventListener('click', e => { const g = e.target.closest('[data-goto-assign]'); if (!g) return; e.preventDefault();
  closeM('m-emp'); asSel = g.dataset.gotoAssign; showPage('assign'); renderAssign(); });

// ═════════════════════════════════════════════════════════
//  ⬇ EXCEL — on every page (what the page shows, with its filters) and on every report (all rows)
// ═════════════════════════════════════════════════════════
// long number codes (national ID, mobile, bank account, insurance no. …) stay TEXT so Excel shows every digit
const isLongCode = v => /^\d{10,}$/.test(String(v).trim());
const xlNum = v => { const s = String(v).replace(/,/g,'').trim(); if (isLongCode(String(v).trim())) return String(v).trim();
  return /^-?\d+(\.\d+)?$/.test(s) && s.length < 16 && !/^0\d/.test(s) ? Number(s) : v; };
function tableToRows(tbl){
  const heads = [...tbl.querySelectorAll('thead th')], keep = heads.map(th => th.textContent.trim() !== '');
  const out = [heads.filter((_,i) => keep[i]).map(th => th.textContent.trim())];
  tbl.querySelectorAll('tbody tr').forEach(tr => {
    if (tr.style.display === 'none') return;   // hidden by a status filter (part43)
    const tds = [...tr.children]; if (tds.length === 1 && tds[0].classList.contains('empty')) return;
    out.push(tds.filter((_,i) => keep[i] !== false).map(td => { const c = td.cloneNode(true); c.querySelectorAll('button,input,select').forEach(x => x.remove());
      return xlNum(c.textContent.replace(/\s+/g,' ').trim()); }));
  });
  return out;
}
async function exportPageExcel(pageEl){
  const tables = [...pageEl.querySelectorAll('table')].filter(t => t.offsetParent !== null || t.closest('.card'));
  const visible = tables.filter(t => t.querySelectorAll('tbody tr').length && getComputedStyle(t.closest('.card') || t).display !== 'none');
  if (!visible.length) return toast('Nothing to export on this page','warn');
  const XL = await loadSheetJs(), wb = XL.utils.book_new();
  visible.forEach((t, i) => { const card = t.closest('.card'), title = card && card.querySelector('.toolbar-title') ? card.querySelector('.toolbar-title').textContent.trim() : '';
    XL.utils.book_append_sheet(wb, XL.utils.aoa_to_sheet(tableToRows(t)), (title || `Sheet ${i+1}`).replace(/[\\/?*\[\]:]/g,' ').slice(0,31) || `Sheet ${i+1}`); });
  const name = (pageEl.querySelector('.page-title') || {}).textContent || pageEl.id.replace('page-','');
  XL.writeFile(wb, `petrokima-${name.trim().toLowerCase().replace(/[^a-z0-9]+/g,'-')}-${todayISO()}.xlsx`);
  toast('Excel file downloaded');
}
async function exportReportExcel(){
  const rep = repCur && REPORTS.find(x => x.id === repCur);
  if (!rep || !repData) return toast('Open a report first','warn');
  const XL = await loadSheetJs();
  const aoa = [repData.cols.map(c => c.l)].concat(repData.rows.map(r => repData.cols.map(c => { const v = r[c.k];
    if (v == null) return ''; if (typeof v === 'number') return Number.isInteger(v) && isLongCode(v) ? String(v) : v;
    return xlNum(String(v).replace(/<[^>]*>/g,'')); })));
  const wb = XL.utils.book_new(); XL.utils.book_append_sheet(wb, XL.utils.aoa_to_sheet(aoa), rep.t.replace(/[\\/?*\[\]:]/g,' ').slice(0,31));
  XL.writeFile(wb, `petrokima-${rep.id}-${todayISO()}.xlsx`); toast('Report downloaded as Excel');
}
const todayISO = () => new Date().toISOString().slice(0,10);
(function addExcelButtons(){
  document.querySelectorAll('.page').forEach(pg => {
    if (pg.id === 'page-reports' || pg.id === 'page-dashboard') return;
    const head = pg.querySelector('.page-header'); if (!head || head.querySelector('[data-xl]')) return;
    const b = document.createElement('button'); b.className = 'btn btn-ghost'; b.dataset.xl = '1'; b.textContent = '⬇ Excel'; b.title = 'Download what this page shows (with the current filters) as an Excel file';
    const grp = head.querySelector('.btn-group'); if (grp) grp.insertBefore(b, grp.firstChild); else head.appendChild(b);
  });
})();
document.addEventListener('click', e => { const b = e.target.closest('[data-xl]'); if (b) exportPageExcel(b.closest('.page')); });
$('rep-xlsx').addEventListener('click', exportReportExcel);

// ═════════════════════════════════════════════════════════
//  PROJECT COSTS FOR ACCOUNTING — totals per project only (no names), published for approved months
// ═════════════════════════════════════════════════════════
function projectCostTotals(detail){
  const g = {};
  detail.forEach(d => { const code = d.code || '(unallocated)';
    const x = g[code] = g[code] || { project_code:code, project_name: d.code ? (projName(d.code) || d.code) : 'No attendance recorded', emps:new Set(), hours:0, allocated:0, direct:0, total:0 };
    if (Math.abs(d.total) > 0.004 || d.hours > 0) x.emps.add(String(d.emp.id));
    x.hours += num(d.hours); x.allocated += num(d.alloc); x.direct += num(d.direct); x.total += num(d.total); });
  const r2 = v => Math.round(v * 100) / 100;
  return Object.values(g).filter(x => x.emps.size).map(x => ({ project_code:x.project_code, project_name:x.project_name, employees:x.emps.size,
    hours:r2(x.hours), allocated:r2(x.allocated), direct:r2(x.direct), total:r2(x.total) }));
}
async function publishProjectCosts(period, detail, quiet){
  const rows = projectCostTotals(detail).map(x => ({ ...x, period, published_by:(ME && (ME.full_name || ME.email)) || 'unknown' }));
  const del = await sb.from('project_costs').delete().eq('period', period);
  if (del.error) return toast('Project costs not published: ' + del.error.message, 'err');
  if (!rows.length) return quiet ? null : toast('No project costs to publish for ' + periodLabel(period), 'warn');
  const { data, error } = await sb.from('project_costs').insert(rows).select('project_code');
  if (error) return toast('Project costs not published: ' + error.message, 'err');
  toast(`${periodLabel(period)}: project costs published for Accounting — ${data.length} project line${data.length>1?'s':''}, total ${fmt(rows.reduce((s,r)=>s+r.total,0))} EGP`);
}
$('pay-publish').addEventListener('click', () => {
  if (!currentRun()) return toast('Approve the payroll first — only approved months can be published','warn');
  confirmDel(`Publish the project cost totals of ${periodLabel(settings.period)} to Accounting? This replaces what was published for this month before.`, () => publishProjectCosts(settings.period, laborCost()));
  $('del-title').textContent='Please confirm'; $('del-ok').textContent='Publish'; $('del-ok').className='btn btn-primary';
});
// show the button only for an approved month
const _renderPayrollPublish = renderPayroll;
renderPayroll = function(){ const r = _renderPayrollPublish.apply(this, arguments); $('pay-publish').style.display = currentRun() ? '' : 'none'; return r; };

// ── the accountant's view (My requests → Project costs) ──
let PC_ROWS = [];
async function loadProjectCosts(){
  const per = await sb.rpc('acct_cost_periods');
  if (per.error) { $('pc-tbl').innerHTML = `<tr><td colspan="6" class="empty">${esc(per.error.message)}</td></tr>`; return; }
  const keep = $('pc-period').value;
  $('pc-period').innerHTML = (per.data||[]).map(x => `<option value="${esc(x.period)}">${esc(periodLabel(x.period))}</option>`).join('') || '<option value="">No months published yet</option>';
  if (keep && (per.data||[]).some(x => x.period === keep)) $('pc-period').value = keep;
  await showProjectCosts();
}
async function showProjectCosts(){
  const p = $('pc-period').value;
  if (!p){ PC_ROWS = []; $('pc-tbl').innerHTML = '<tr><td colspan="6" class="empty">No approved months have been published yet</td></tr>'; $('pc-foot').textContent=''; return; }
  const { data, error } = await sb.rpc('acct_project_costs', { p_period: p });
  if (error) { $('pc-tbl').innerHTML = `<tr><td colspan="6" class="empty">${esc(error.message)}</td></tr>`; return; }
  PC_ROWS = data || [];
  $('pc-tbl').innerHTML = PC_ROWS.map(r => `<tr><td class="mono">${esc(r.project_code || '—')}</td><td class="strong" style="white-space:normal">${esc(r.project_name || '')}${r.note ? `<div style="font-size:11px;color:var(--muted)">${esc(r.note)}</div>` : ''}</td>
      <td class="num">${r.people}</td><td class="num">${fmt(r.hours)}</td><td class="num strong">${r.total == null ? '<span style="color:var(--muted)">withheld</span>' : fmt(r.total)}</td>
      <td class="num">${r.total != null && num(r.hours) > 0 ? fmt(num(r.total) / num(r.hours)) : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">Nothing published for this month</td></tr>';
  const tot = PC_ROWS.reduce((s,r) => s + num(r.total), 0);
  $('pc-foot').textContent = `${periodLabel(p)} · ${PC_ROWS.length} line${PC_ROWS.length===1?'':'s'} · total shown ${fmt(tot)} EGP`;
}
$('pc-period').addEventListener('change', showProjectCosts);
$('pc-xlsx').addEventListener('click', async () => {
  if (!PC_ROWS.length) return toast('Nothing to download','warn');
  const XL = await loadSheetJs(), p = $('pc-period').value;
  const aoa = [['Project','Name','People','Hours','Total cost (EGP)','Cost per hour','Note']].concat(PC_ROWS.map(r => [r.project_code || '', r.project_name || '', r.people, num(r.hours),
    r.total == null ? '' : num(r.total), r.total != null && num(r.hours) > 0 ? Math.round(num(r.total)/num(r.hours)*100)/100 : '', r.note || '']));
  const wb = XL.utils.book_new(); XL.utils.book_append_sheet(wb, XL.utils.aoa_to_sheet(aoa), 'Project costs ' + p);
  XL.writeFile(wb, `petrokima-project-costs-${p}.xlsx`); toast('Project costs downloaded');
});

// ═════════════════════════════════════════════════════════
//  SIDEBAR — collapse to icons / expand (remembered on this computer)
// ═════════════════════════════════════════════════════════
(function sidebarToggle(){
  // split each menu item into its icon and its name, so the name can be hidden
  document.querySelectorAll('.sidebar .nav-item').forEach(it => {
    const tn = [...it.childNodes].find(n => n.nodeType === 3 && n.textContent.trim()); if (!tn) return;
    const m = tn.textContent.trim().match(/^(\S+)\s+([\s\S]+)$/); if (!m) return;
    const ico = document.createElement('span'); ico.className = 'nav-ico'; ico.textContent = m[1];
    const txt = document.createElement('span'); txt.className = 'nav-txt'; txt.textContent = m[2];
    it.insertBefore(ico, tn); it.insertBefore(txt, tn); it.removeChild(tn);
    if (!it.title) it.title = m[2].trim();                  // the name appears when hovering over the icon
  });
  const apply = mini => {
    document.body.classList.toggle('nav-mini', mini);
    document.querySelectorAll('.nav-toggle').forEach(b => { b.title = mini ? 'Expand menu' : 'Collapse menu';
      b.innerHTML = mini ? '<span>☰</span>' : '<span>☰</span><span class="nav-txt">Collapse menu</span>'; });
  };
  document.querySelectorAll('.sidebar').forEach(sb => {
    const b = document.createElement('button'); b.className = 'nav-toggle'; b.type = 'button';
    b.addEventListener('click', () => { const mini = !document.body.classList.contains('nav-mini'); localStorage.setItem('pk_nav_mini', mini ? '1' : '0'); apply(mini); if (window.paintNavSections) window.paintNavSections(); });
    sb.insertBefore(b, sb.firstChild);
  });
  apply(localStorage.getItem('pk_nav_mini') === '1');
})();

// ═════════════════════════════════════════════════════════
//  SIDEBAR SECTIONS — click a heading (e.g. WORKFORCE) to fold / unfold its pages (remembered)
// ═════════════════════════════════════════════════════════
(function sidebarSections(){
  const KEY = 'pk_nav_closed';
  const closed = new Set(JSON.parse(localStorage.getItem(KEY) || '[]'));
  const groups = [];                                         // [{ label, key, items[] }]
  document.querySelectorAll('.sidebar').forEach((sb, si) => {
    let cur = null;
    [...sb.children].forEach(el => {
      if (el.classList.contains('nav-label')){
        const key = si + ':' + el.textContent.trim().toLowerCase();
        el.insertAdjacentHTML('beforeend', '<span class="sec-dot" title="Something is waiting in this section"></span><span class="sec-arrow"></span>');
        cur = { label: el, key, items: [] }; groups.push(cur);
        el.addEventListener('click', () => { closed.has(key) ? closed.delete(key) : closed.add(key); localStorage.setItem(KEY, JSON.stringify([...closed])); paint(); });
      } else if (cur && el.classList.contains('nav-item')) cur.items.push(el);
    });
  });
  function paint(){
    groups.forEach(g => {
      const shut = closed.has(g.key);
      g.label.classList.toggle('sec-closed', shut);
      g.label.querySelector('.sec-arrow').textContent = shut ? '▸' : '▾';
      g.label.title = shut ? 'Show this section' : 'Fold this section';
      const mini = document.body.classList.contains('nav-mini');      // icon-only menu: headings are hidden, so show every icon
      g.items.forEach(it => it.classList.toggle('sec-hide', shut && !mini));
      const alert = g.items.some(it => [...it.querySelectorAll('.chip')].some(c => c.style.display !== 'none' && c.textContent.trim() && c.textContent.trim() !== '0'));
      g.label.classList.toggle('has-alert', alert);
    });
  }
  paint();
  // keep the red dots current whenever the counters change
  if (typeof updateBadges === 'function'){ const _ub = updateBadges; updateBadges = function(){ const r = _ub.apply(this, arguments); paint(); return r; }; }
  window.paintNavSections = paint;
})();

// ═════════════════════════════════════════════════════════
//  PHONE / SMALL SCREENS — ☰ opens the menu over the page; picking a page closes it
// ═════════════════════════════════════════════════════════
$('menu-btn').addEventListener('click', () => document.body.classList.toggle('nav-open'));
$('nav-backdrop').addEventListener('click', () => document.body.classList.remove('nav-open'));
document.addEventListener('click', e => { if (e.target.closest('#app .sidebar .nav-item[data-page]')) document.body.classList.remove('nav-open'); });
// users list: mark the super admin
const _renderUsersSA = renderUsers;
renderUsers = function(){ const r = _renderUsersSA.apply(this, arguments);
  document.querySelectorAll('#us-tbl tr').forEach(tr => { const cb = tr.querySelector('[data-u-acct]'); if (cb && SUPER[cb.dataset.uAcct]){
    const cell = tr.querySelector('td'); if (cell && !cell.querySelector('.sa-badge')) cell.insertAdjacentHTML('beforeend', ' <span class="chip c-red sa-badge" title="Full authority — only she can make or remove administrators">👑 Super admin</span>'); } });
  return r; };

// ═════════════════════════════════════════════════════════
//  BULK UPLOAD — one page for every kind of data (template → upload → preview → save)
// ═════════════════════════════════════════════════════════
// ── reading cell values (Excel dates and times come as numbers) ──
const BU = { type:null, rows:[], file:'', results:null };
const buTxt = v => (v === null || v === undefined) ? '' : String(v).trim();
function buDate(v){
  if (v === '' || v == null) return '';
  if (typeof v === 'number' && v > 20000 && v < 80000){ const d = new Date(Math.round((v - 25569) * 86400000)); return d.toISOString().slice(0,10); }
  const s = buTxt(v);
  const real = (y, mo, d) => { const o = new Date(y, mo - 1, d); return o.getFullYear() === y && o.getMonth() === mo - 1 && o.getDate() === d ? `${y}-${pad(mo)}-${pad(d)}` : null; };   // a date that exists
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/); if (m) return real(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/); if (m) return real(+m[3], +m[2], +m[1]);     // day/month/year
  return null;
}
function buTime(v){
  if (v === '' || v == null) return '';
  if (typeof v === 'number'){ const f = v % 1, mins = Math.round(f * 1440); return `${pad(Math.floor(mins/60) % 24)}:${pad(mins % 60)}`; }
  const m = buTxt(v).match(/^(\d{1,2})[:.](\d{2})(?::\d{2})?\s*(am|pm|ص|م)?$/i); if (!m) return null;
  let h = +m[1]; const ap = (m[3]||'').toLowerCase(); if ((ap==='pm'||ap==='م') && h < 12) h += 12; if ((ap==='am'||ap==='ص') && h === 12) h = 0;
  return h < 24 && +m[2] < 60 ? `${pad(h)}:${m[2]}` : null;
}
function buMonth(v){ if (v === '' || v == null) return ''; const d = buDate(v); if (d) return d.slice(0,7); const m = buTxt(v).match(/^(\d{4})[-/](\d{1,2})$/); return m ? `${m[1]}-${pad(+m[2])}` : null; }
function buNum(v){ if (v === '' || v == null) return ''; const n = Number(String(v).replace(/,/g,'').trim()); return isFinite(n) ? n : null; }
function buBool(v){ const s = buTxt(v).toLowerCase(); if (!s) return ''; if (['yes','y','true','1','نعم','x','✓'].includes(s)) return true; if (['no','n','false','0','لا'].includes(s)) return false; return null; }
function buPick(v, opts){ const s = buTxt(v); if (!s) return ''; const hit = opts.find(o => o.toLowerCase() === s.toLowerCase()); return hit ?? null; }
const buEmp = v => { const id = buTxt(v).replace(/\.0$/,''); return id && empById(id) ? id : null; };
const buProj = v => { const s = buTxt(v); if (!s) return ''; const p = S.projects.find(x => String(x.id).toLowerCase() === s.toLowerCase()); return p ? p.id : (parseProjInput(s) || null); };
const meName = () => (ME && (ME.full_name || ME.email)) || 'HR';

// ── the kinds of data ──
// col: [key, heading, kind, required, allowed values / note]
const EMP_SKIP = ['id'];
function empCols(){
  const out = [['id','Code','code',true,'Existing code = update only the filled-in columns · new code = new employee']];
  EMP_FIELDS.forEach(([, fs]) => fs.forEach(f => { if (EMP_SKIP.includes(f[0])) return; if (f[0]==='location_exempt' && !(ME && ME.role==='admin')) return; if (isOfficer() && PAY_FIELDS.includes(f[0])) return;
    const kind = f[2]==='manager' ? 'emp' : f[2]==='select' ? 'pick' : f[2]==='number' ? 'num' : f[2]==='bool' ? 'bool' : f[2]==='date' ? 'date' : 'text';
    out.push([f[0], f[1].replace(/\s*\(.*\)\s*/,'').replace(/ — .*/,''), kind, false, kind==='pick' ? f[3].filter(Boolean) : kind==='bool' ? 'Yes / No' : kind==='emp' ? 'Manager\'s employee code' : '']); }));
  return out;
}
const BU_TYPES = {
  employees: { t:'Employees', roles:['admin','hr','hr_officer'], d:'Add new employees or update existing ones. For an existing code, only the columns you fill in are changed — blank cells keep what is there.',
    cols: empCols, async prepare(){},
    check(v){ const id = buTxt(v.id).replace(/\.0$/,''); if (!id) return err('Code is required');
      const rec = {}; for (const [k,,kind,,opts] of empCols()){ if (k==='id') continue; const raw = v[k]; if (raw === '' || raw == null) continue;
        const val = kind==='date' ? buDate(raw) : kind==='num' ? buNum(raw) : kind==='bool' ? buBool(raw) : kind==='pick' ? buPick(raw, opts) : kind==='emp' ? buEmp(raw) : buTxt(raw);
        if (val === null) return err(`“${raw}” is not valid for ${k.replace(/_/g,' ')}${kind==='pick' ? ' — use: ' + opts.join(', ') : ''}`); rec[k] = val; }
      if (rec.manager_id && rec.manager_id === id) return err('An employee cannot be his own manager');
      if (empById(id)) return Object.keys(rec).length ? ok('update', `${empName(empById(id))}: ${Object.keys(rec).length} field(s)`, { id, rec }) : skip('Nothing filled in to change');
      if (!rec.name_en && !rec.name_ar) return err('A new employee needs an English or Arabic name');
      return ok('new', rec.name_en || rec.name_ar, { id, rec:{ ...rec, id, status: rec.status || 'Active' } }); },
    async save(x){ return x.kind==='update' ? sb.from('employees').update(x.data.rec).eq('id', x.data.id).select('id') : sb.from('employees').insert(x.data.rec).select('id'); } },

  attendance: { t:'Attendance (hand entries)', roles:['admin','hr','hr_officer'], d:'One row per employee per day. Overnight shifts are fine (check-out earlier than check-in = next day). Days that already have a record are skipped unless you tick “Replace existing records”. Approved payroll months cannot be changed.',
    cols: () => [['emp','Employee code','emp',true],['date','Date','date',true],['in','Check-in','time',false,'e.g. 08:00 (required when Present)'],['out','Check-out','time',false,'e.g. 17:00'],
                 ['project','Project code','proj',false,'blank = no project'],['status','Status','pick',false,['Present','Half Day','Annual Leave','Sick Leave','Absent']],['notes','Notes','text',false]],
    async prepare(rows){ const dates = [...new Set(rows.map(r => buDate(r.date)).filter(Boolean))]; BU.existing = new Map();
      for (let i = 0; i < dates.length; i += 60){ const { data } = await sb.from('attendance').select('id,emp_id,date,source').in('date', dates.slice(i, i+60)); (data||[]).forEach(a => BU.existing.set(a.emp_id + '|' + a.date, a)); } },
    check(v){ const emp = buEmp(v.emp); if (!emp) return err(`Employee code “${buTxt(v.emp)}” not found`);
      const date = buDate(v.date); if (!date) return err(`Date “${buTxt(v.date)}” is not a valid date`);
      const status = buPick(v.status, ['Present','Half Day','Annual Leave','Sick Leave','Absent']); if (status === null) return err(`Status “${buTxt(v.status)}” is not valid`);
      const st = status || 'Present', tin = buTime(v.in), tout = buTime(v.out); if (tin === null || tout === null) return err('Check-in / check-out must be a time like 08:30');
      if ((st==='Present' || st==='Half Day') && !tin) return err('Check-in time is required');
      const proj = buProj(v.project); if (proj === null) return err(`Project “${buTxt(v.project)}” not found`);
      let hours = 0; if (tin && tout){ let m = toMin(tout) - toMin(tin); if (m < 0) m += 1440; hours = Math.round(m/60*100)/100; }
      const e = empById(emp), segs = tin ? [{ code: proj || '', in: tin, out: tout || null, hours }] : [];
      const rec = { emp_id:emp, emp_name:empName(e), date, status:st, projects:segs, check_in:tin || null, check_out:tout || null, total_hours:hours, notes:buTxt(v.notes) || null, source:'Desktop' };
      rec.ot_hours = (() => { try { return dayRules(rec, e).ot || 0; } catch(_) { return 0; } })();
      const ex = BU.existing.get(emp + '|' + date);
      if (ex && !$('bu-replace').checked) return skip(`Already has a ${ex.source || ''} record on ${date} — tick “Replace existing records” to overwrite`);
      return ok(ex ? 'update' : 'new', `${empName(e)} · ${date} · ${tin || st}${tout ? '–' + tout : ''}${proj ? ' · ' + proj : ''}`, { id: ex && ex.id, rec }); },
    async save(x){ return x.kind==='update' ? sb.from('attendance').update(x.data.rec).eq('id', x.data.id).select('id') : sb.from('attendance').insert(x.data.rec).select('id'); } },

  leaves: { t:'Vacations', roles:['admin','hr','hr_officer'], d:'Working days are counted automatically (weekends and public holidays excluded) unless you fill in Days. Overlapping vacations and approved payroll months are refused.',
    cols: () => [['emp','Employee code','emp',true],['type','Leave type','pick',true,['Annual','Casual','Sick','Unpaid','Other paid']],['from','From','date',true],['to','To','date',false,'blank = same day'],
                 ['days','Days','num',false,'blank = counted automatically'],['status','Status','pick',false,['Approved','Pending','Rejected','Cancelled']],['reason','Reason','text',false]],
    check(v){ const emp = buEmp(v.emp); if (!emp) return err(`Employee code “${buTxt(v.emp)}” not found`);
      const type = buPick(v.type, ['Annual','Casual','Sick','Unpaid','Other paid']); if (!type) return err(`Leave type “${buTxt(v.type)}” — use Annual, Casual, Sick, Unpaid or Other paid`);
      const f = buDate(v.from), t = buDate(v.to) || f; if (!f || t === null) return err('From / To must be valid dates'); if (t < f) return err('“To” is before “From”');
      const dd = buNum(v.days); if (dd === null) return err('Days must be a number'); const days = dd === '' ? workdays(f, t) : dd; if (!(days > 0)) return err('No working days between these dates');
      const status = buPick(v.status, ['Approved','Pending','Rejected','Cancelled']); if (status === null) return err(`Status “${buTxt(v.status)}” is not valid`);
      return ok('new', `${empName(empById(emp))} · ${type} · ${f}${t!==f ? ' → ' + t : ''} · ${days} day(s)`, { rec:{ emp_id:emp, leave_type:type, date_from:f, date_to:t, days, status:status || 'Approved', reason:buTxt(v.reason) || null, entered_by:meName(), source:'Desktop' } }); },
    async save(x){ return sb.from('employee_leaves').insert(x.data.rec).select('id'); } },

  permissions: { t:'Permissions', roles:['admin','hr','hr_officer'], d:'Late-arrival / early-leave permissions. The limit per payroll cycle and the maximum hours still apply.',
    cols: () => [['emp','Employee code','emp',true],['date','Date','date',true],['type','Type','pick',true,['Late arrival','Early leave']],['hours','Hours','num',true],
                 ['status','Status','pick',false,['Approved','Pending']],['reason','Reason','text',false]],
    check(v){ const emp = buEmp(v.emp); if (!emp) return err(`Employee code “${buTxt(v.emp)}” not found`);
      const date = buDate(v.date); if (!date) return err('Date is not valid'); const type = buPick(v.type, ['Late arrival','Early leave']); if (!type) return err('Type must be “Late arrival” or “Early leave”');
      const h = buNum(v.hours), max = num(settings.permissionMaxHours) || 2; if (!(h > 0) || h > max) return err(`Hours must be more than 0 and at most ${max}`);
      const status = buPick(v.status, ['Approved','Pending']); if (status === null) return err('Status must be Approved or Pending');
      const rec = { emp_id:emp, date, type, hours:h, reason:buTxt(v.reason) || null, status:status || 'Approved', source:'Desktop' };
      if (rec.status === 'Approved'){ rec.decided_by = meName(); rec.decided_at = new Date().toISOString(); }
      return ok('new', `${empName(empById(emp))} · ${date} · ${type} ${h} h`, { rec }); },
    async save(x){ return sb.from('attendance_permissions').insert(x.data.rec).select('id'); } },

  penalties: { t:'Penalties', roles:['admin','hr','hr_officer'], d:'Type: Amount (EGP), Hours (of pay) or Days (of pay). Payroll month as YYYY-MM.',
    cols: () => [['emp','Employee code','emp',true],['date','Incident date','date',true],['period','Payroll month','month',true,'e.g. 2026-10'],['type','Type','pick',true,['Amount','Hours','Days']],
                 ['qty','Quantity','num',true],['req','Requested by','text',true],['status','Status','pick',false,['Approved','Pending','Rejected','Cancelled']],['reason','Reason','text',false]],
    check(v){ const emp = buEmp(v.emp); if (!emp) return err(`Employee code “${buTxt(v.emp)}” not found`);
      const d = buDate(v.date), per = buMonth(v.period); if (!d) return err('Incident date is not valid'); if (!per) return err('Payroll month must look like 2026-10');
      const type = buPick(v.type, ['Amount','Hours','Days']); if (!type) return err('Type must be Amount, Hours or Days'); const q = buNum(v.qty); if (!(q > 0)) return err('Quantity must be more than zero');
      if (!buTxt(v.req)) return err('“Requested by” is required'); const status = buPick(v.status, ['Approved','Pending','Rejected','Cancelled']); if (status === null) return err('Status is not valid');
      return ok('new', `${empName(empById(emp))} · ${per} · ${q} ${type}`, { rec:{ emp_id:emp, incident_date:d, apply_period:per, penalty_type:type, quantity:q, requested_by:buTxt(v.req), recorded_by:meName(), status:status || 'Approved', reason:buTxt(v.reason) || null } }); },
    async save(x){ return sb.from('employee_penalties').insert(x.data.rec).select('id'); } },

  holidays: { t:'Public holidays', roles:['admin','hr'], d:'One row per day off.',
    cols: () => [['date','Date','date',true],['name','Holiday name','text',true]],
    check(v){ const d = buDate(v.date); if (!d) return err('Date is not valid'); if (!buTxt(v.name)) return err('Name is required');
      if (isHoliday(d)) return skip(`${d} is already a holiday (${holidayOn(d).name})`); return ok('new', `${d} · ${buTxt(v.name)}`, { rec:{ date:d, name:buTxt(v.name) } }); },
    async save(x){ return sb.from('public_holidays').insert(x.data.rec).select('id'); } },

  projects: { t:'Projects', roles:['admin','hr'], d:'New code = new project · existing code = update the filled-in columns.',
    cols: () => [['id','Project code','text',true],['name','Project name','text',false,'required for a new project'],['client','Client','text',false],['country','Country','pick',false,['Egypt','Saudi Arabia']],
                 ['location','Location','text',false],['start','Start date','date',false],['status','Status','pick',false,['Active','Inactive','Completed']]],
    check(v){ const id = buTxt(v.id); if (!id) return err('Project code is required');
      const rec = {}; if (buTxt(v.name)) rec.name = buTxt(v.name); if (buTxt(v.client)) rec.client = buTxt(v.client); if (buTxt(v.location)) rec.location = buTxt(v.location);
      const c = buPick(v.country, ['Egypt','Saudi Arabia']); if (c === null) return err('Country must be Egypt or Saudi Arabia'); if (c) rec.country = c;
      const sd = buDate(v.start); if (sd === null) return err('Start date is not valid'); if (sd) rec.start_date = sd;
      const st = buPick(v.status, ['Active','Inactive','Completed']); if (st === null) return err('Status must be Active, Inactive or Completed'); if (st) rec.status = st;
      const ex = S.projects.find(p => String(p.id).toLowerCase() === id.toLowerCase());
      if (ex) return Object.keys(rec).length ? ok('update', `${ex.id} · ${Object.keys(rec).join(', ')}`, { id:ex.id, rec }) : skip('Nothing filled in to change');
      if (!rec.name) return err('A new project needs a name'); return ok('new', `${id} · ${rec.name}`, { rec:{ ...rec, id, status: rec.status || 'Active' } }); },
    async save(x){ return x.kind==='update' ? sb.from('projects').update(x.data.rec).eq('id', x.data.id).select('id') : sb.from('projects').insert(x.data.rec).select('id'); } },

  assignments: { t:'Project assignments', roles:['admin','hr'], d:'Employees with assigned projects can check in only at those projects.',
    cols: () => [['emp','Employee code','emp',true],['project','Project code','proj',true]],
    check(v){ const emp = buEmp(v.emp); if (!emp) return err(`Employee code “${buTxt(v.emp)}” not found`); const p = buProj(v.project); if (!p) return err(`Project “${buTxt(v.project)}” not found`);
      if (S.empProjects.some(x => String(x.emp_id)===emp && x.project_code===p)) return skip('Already assigned');
      return ok('new', `${empName(empById(emp))} → ${p}`, { rec:{ emp_id:emp, project_code:p } }); },
    async save(x){ return sb.from('employee_projects').insert(x.data.rec).select('emp_id'); } },

  reporting: { t:'Reporting lines (direct managers)', roles:['admin','hr','hr_officer'], d:'Sets each employee\'s direct manager. Circular reporting lines are refused.',
    cols: () => [['emp','Employee code','emp',true],['mgr','Direct manager code','emp',true]],
    check(v){ const emp = buEmp(v.emp), mgr = buEmp(v.mgr); if (!emp) return err(`Employee code “${buTxt(v.emp)}” not found`); if (!mgr) return err(`Manager code “${buTxt(v.mgr)}” not found`);
      if (emp === mgr) return err('An employee cannot be his own manager'); if (String(empById(emp).manager_id||'') === mgr) return skip('Already reports to this manager');
      return ok('update', `${empName(empById(emp))} → ${empName(empById(mgr))}`, { id:emp, rec:{ manager_id:mgr, top_of_org:false } }); },
    async save(x){ return sb.from('employees').update(x.data.rec).eq('id', x.data.id).select('id'); } },

  fixed: { t:'Fixed salary package', roles:['admin','finance'], d:'Fixed salary elements per employee with the date they start (and end).',
    cols: () => [['emp','Employee code','emp',true],['el','Element code','num',true,'a Fixed element from Salary elements'],['amt','Amount','num',true],['from','Effective from','date',true],['to','Effective to','date',false],
                 ['why','Reason','text',false,'required for BASIC salary rows — they go to the board member for approval']],
    check(v){ const emp = buEmp(v.emp); if (!emp) return err(`Employee code “${buTxt(v.emp)}” not found`);
      const el = elByCode(buNum(v.el)); if (!el) return err(`Element “${buTxt(v.el)}” not found`); if (el.input_method !== 'Fixed') return err(`${el.code} · ${el.name_en} is not a Fixed element`);
      const a = buNum(v.amt); if (a === null || a === '') return err('Amount is required'); const f = buDate(v.from), t = buDate(v.to); if (!f) return err('Effective from is not valid'); if (t === null) return err('Effective to is not valid');
      if (el.is_basic){
        if (!buTxt(v.why)) return err('Basic salary changes need a reason — they go to the board member for approval');
        return ok('new', `💼 Request to board: ${empName(empById(emp))} · basic salary ${fmt(a)} from ${f}`, { request:true, rec:{ emp_id:emp, element_code:el.code, new_amount:a, effective_from:f, reason:buTxt(v.why) } });
      }
      return ok('new', `${empName(empById(emp))} · ${el.code} ${el.name_en} · ${fmt(a)} from ${f}`, { rec:{ emp_id:emp, element_code:el.code, amount:a, effective_from:f, effective_to:t || null } }); },
    async save(x){ return x.data.request ? sb.from('salary_change_requests').insert(x.data.rec).select('id') : sb.from('employee_salary_elements').insert(x.data.rec).select('id'); } },

  loans: { t:'Loans', roles:['admin','finance'], d:'Instalment = amount ÷ months, deducted from the first deduction month onwards.',
    cols: () => [['emp','Employee code','emp',true],['amt','Loan amount','num',true],['months','Months','num',true],['start','First deduction month','month',true,'e.g. 2026-11'],['settled','Already settled','num',false],['ref','Reference','text',false]],
    check(v){ const emp = buEmp(v.emp); if (!emp) return err(`Employee code “${buTxt(v.emp)}” not found`);
      const a = buNum(v.amt), n = buNum(v.months), s = buMonth(v.start); if (!(a > 0)) return err('Loan amount must be more than zero'); if (!(n > 0)) return err('Months must be more than zero'); if (!s) return err('First deduction month must look like 2026-11');
      return ok('new', `${empName(empById(emp))} · ${fmt(a)} over ${n} months from ${s}`, { rec:{ emp_id:emp, loan_amount:a, periods:n, start_period:s, amount_settled:buNum(v.settled) || 0, reference:buTxt(v.ref) || null, status:'Active' } }); },
    async save(x){ return sb.from('employee_loans').insert(x.data.rec).select('id'); } },
};
const BU_KEYS = { employees:d=>d.id, attendance:d=>d.rec.emp_id+'|'+d.rec.date, leaves:d=>d.rec.emp_id+'|'+d.rec.date_from+'|'+d.rec.leave_type, permissions:d=>d.rec.emp_id+'|'+d.rec.date+'|'+d.rec.type,
  holidays:d=>d.rec.date, projects:d=>(d.id||d.rec.id), assignments:d=>d.rec.emp_id+'|'+d.rec.project_code, reporting:d=>d.id, fixed:d=>d.rec.emp_id+'|'+d.rec.element_code+'|'+d.rec.effective_from };
function markDuplicates(type, rows){ const kf = BU_KEYS[type]; if (!kf) return rows; const seen = new Map();
  rows.forEach(r => { if (!['new','update'].includes(r.res.kind)) return; const k = String(kf(r.res.data)).toLowerCase();
    if (seen.has(k)) r.res = { kind:'skip', label:r.res.label, msg:`Same as row ${seen.get(k)} in this file` }; else seen.set(k, r.n); });
  return rows; }
const ok = (kind, label, data) => ({ kind, label, data }), err = m => ({ kind:'error', msg:m }), skip = m => ({ kind:'skip', msg:m });
const buAllowed = k => ME && BU_TYPES[k].roles.includes(ME.role);

// ── page ──
function renderBulk(){
  const types = Object.keys(BU_TYPES).filter(buAllowed);
  if (!BU.type || !types.includes(BU.type)) BU.type = types[0] || null;
  $('bu-type').innerHTML = types.map(k => `<option value="${k}" ${k===BU.type?'selected':''}>${esc(BU_TYPES[k].t)}</option>`).join('');
  if (!BU.type){ $('bu-desc').textContent = 'Your role cannot bulk-upload data.'; return; }
  const T = BU_TYPES[BU.type];
  $('bu-desc').textContent = T.d;
  $('bu-replace-box').style.display = BU.type === 'attendance' ? '' : 'none';
  $('bu-cols').innerHTML = T.cols().map(([k,l,kind,req,opts]) => `<tr><td class="strong">${esc(l)}</td><td>${req ? '<span class="chip c-orange">required</span>' : '<span style="color:var(--muted)">optional</span>'}</td>
      <td style="white-space:normal;font-size:12px;color:var(--label)">${Array.isArray(opts) ? 'One of: ' + esc(opts.join(', ')) : esc(opts || ({date:'Date (e.g. 2026-10-05 or 05/10/2026)',time:'Time (e.g. 08:30)',month:'Month (e.g. 2026-10)',num:'Number',bool:'Yes / No',emp:'Employee code',proj:'Project code'}[kind] || 'Text'))}</td></tr>`).join('');
  renderBulkPreview();
}
function renderBulkPreview(){
  const R = BU.rows, has = R.length;
  $('bu-preview').style.display = has ? '' : 'none'; if (!has) return;
  const c = k => R.filter(r => r.res.kind === k).length;
  $('bu-summary').innerHTML = `<b>${esc(BU.file)}</b> · ${R.length} row${R.length>1?'s':''}: <span class="chip c-green">✅ ${c('new')} new</span> <span class="chip c-blue">🔁 ${c('update')} update</span>
    <span class="chip c-grey">⏭ ${c('skip')} skipped</span> <span class="chip c-red">✗ ${c('error')} with problems</span>`;
  const show = $('bu-filter').value;
  $('bu-rows').innerHTML = R.filter(r => !show || (show==='problems' ? ['error','skip'].includes(r.res.kind) : r.res.kind===show)).slice(0, 500).map(r => {
    const chip = { new:'<span class="chip c-green">New</span>', update:'<span class="chip c-blue">Update</span>', skip:'<span class="chip c-grey">Skip</span>', error:'<span class="chip c-red">Problem</span>',
                   saved:'<span class="chip c-green">✓ Saved</span>', failed:'<span class="chip c-red">✗ Not saved</span>' }[r.res.kind];
    return `<tr><td class="mono">${r.n}</td><td>${chip}</td><td style="white-space:normal">${esc(r.res.label || '')}</td><td style="white-space:normal;color:${['error','failed'].includes(r.res.kind)?'var(--danger)':'var(--muted)'}">${esc(r.res.msg || '')}</td></tr>`; }).join('');
  const n = c('new') + c('update'); $('bu-save').disabled = !n; $('bu-save').textContent = n ? `Save ${n} row${n>1?'s':''}` : 'Nothing to save';
  $('bu-errors').style.display = R.some(r => ['error','skip','failed'].includes(r.res.kind)) ? '' : 'none';
}
async function buTemplate(){
  const T = BU_TYPES[BU.type], cols = T.cols(), XL = await loadSheetJs(), wb = XL.utils.book_new();
  const head = cols.map(c => c[1]);
  const sample = cols.map(([k,,kind,,opts]) => kind==='emp' ? (k==='mgr' || k==='manager_id' ? '' : (S.employees[0] || {}).id || '1001') : kind==='date' ? todayISO() : kind==='time' ? (k==='in' ? '08:00' : '17:00') : kind==='month' ? settings.period
                      : kind==='num' ? '' : kind==='bool' ? '' : Array.isArray(opts) ? '' : '');
  XL.utils.book_append_sheet(wb, XL.utils.aoa_to_sheet([head, sample]), 'Data');
  XL.utils.book_append_sheet(wb, XL.utils.aoa_to_sheet([['Column','Required','What to enter']].concat(cols.map(([k,l,kind,req,opts]) => [l, req ? 'required' : 'optional', Array.isArray(opts) ? 'One of: ' + opts.join(', ') : (opts || kind)]))), 'Instructions');
  XL.writeFile(wb, `petrokima-upload-template-${BU.type}.xlsx`); toast('Template downloaded — fill in the “Data” sheet (row 2 is only an example; delete it)');
}
async function buFile(){
  const f = $('bu-file').files[0]; if (!f) return;
  try {
    const grid = (await readFile(f)).filter(r => r.some(v => buTxt(v) !== ''));
    if (grid.length < 2) return toast('The file has no data rows','warn');
    const T = BU_TYPES[BU.type], cols = T.cols();
    const idx = {}; grid[0].forEach((h, i) => { const hh = H(h); const c = cols.find(([k,l]) => H(l) === hh || H(k) === hh); if (c && idx[c[0]] === undefined) idx[c[0]] = i; });
    const missing = cols.filter(c => c[3] && idx[c[0]] === undefined).map(c => c[1]);
    if (missing.length) return toast(`Missing column${missing.length>1?'s':''}: ${missing.join(', ')} — use the template headings`, 'err');
    const rows = grid.slice(1).map((r, i) => ({ n: i + 2, v: Object.fromEntries(cols.map(([k]) => [k, idx[k] === undefined ? '' : r[idx[k]]])) }));
    if (T.prepare) await T.prepare(rows.map(r => r.v));
    BU.rows = markDuplicates(BU.type, rows.map(r => ({ ...r, res: T.check(r.v) }))); BU.file = f.name; $('bu-filter').value = '';
    renderBulkPreview();
  } catch(e){ toast(e.message, 'err'); }
  $('bu-file').value = '';
}
async function buSave(){
  const T = BU_TYPES[BU.type], todo = BU.rows.filter(r => ['new','update'].includes(r.res.kind));
  const b = $('bu-save'); b.disabled = true; let saved = 0, failed = 0;
  for (let i = 0; i < todo.length; i++){
    const r = todo[i]; b.textContent = `Saving ${i+1} of ${todo.length}…`;
    try { const { data, error } = await T.save(r.res);
      if (error || !(data && data.length)){ r.res = { ...r.res, kind:'failed', msg: error ? error.message.replace(/^.*?:\s(?=[A-Z])/,'') : NOPERM }; failed++; }
      else { r.res = { ...r.res, kind:'saved', msg:'' }; saved++; } }
    catch(e){ r.res = { ...r.res, kind:'failed', msg:e.message }; failed++; }
  }
  renderBulkPreview(); $('bu-save').disabled = true; $('bu-save').textContent = 'Saved';
  await loadAll().catch(() => {});                                   // refresh the app's data, then show the result
  toast(`${saved} row${saved===1?'':'s'} saved${failed ? ` · ${failed} not saved — see the list and “Download problems”` : ''}`, failed ? 'warn' : undefined);
}
async function buErrors(){
  const T = BU_TYPES[BU.type], cols = T.cols(), bad = BU.rows.filter(r => ['error','skip','failed'].includes(r.res.kind));
  const XL = await loadSheetJs(), wb = XL.utils.book_new();
  XL.utils.book_append_sheet(wb, XL.utils.aoa_to_sheet([cols.map(c => c[1]).concat(['Row in your file','Problem'])].concat(bad.map(r => cols.map(([k]) => r.v[k] ?? '').concat([r.n, r.res.msg || ''])))), 'Problems');
  XL.writeFile(wb, `petrokima-upload-problems-${BU.type}-${todayISO()}.xlsx`);
}
$('bu-type').addEventListener('change', () => { BU.type = $('bu-type').value; BU.rows = []; renderBulk(); });
$('bu-template').addEventListener('click', buTemplate);
$('bu-file').addEventListener('change', buFile);
$('bu-save').addEventListener('click', () => confirmDel(`Save ${BU.rows.filter(r => ['new','update'].includes(r.res.kind)).length} row(s) of ${BU_TYPES[BU.type].t}?`, buSave) || ($('del-title').textContent='Please confirm', $('del-ok').textContent='Save', $('del-ok').className='btn btn-primary'));
$('bu-filter').addEventListener('change', renderBulkPreview);
$('bu-errors').addEventListener('click', buErrors);
$('bu-replace').addEventListener('change', () => { if (BU.rows.length && BU.type==='attendance'){ const T = BU_TYPES.attendance; BU.rows = markDuplicates('attendance', BU.rows.map(r => ({ ...r, res: T.check(r.v) }))); renderBulkPreview(); } });

// ═════════════════════════════════════════════════════════
//  MANAGER — bulk upload of his own team's project assignments (My requests → Team approvals)
// ═════════════════════════════════════════════════════════
let MBU = [];
async function mbuTemplate(){
  const XL = await loadSheetJs(), wb = XL.utils.book_new(), team = (SD && SD.myTeam) || [];
  XL.utils.book_append_sheet(wb, XL.utils.aoa_to_sheet([['Employee code','Project code']].concat(team.slice(0,1).map(m => [m.id, '']))), 'Data');
  XL.utils.book_append_sheet(wb, XL.utils.aoa_to_sheet([['Your team (codes you can use)','Name','Job']].concat(team.map(m => [m.id, m.name_en || m.name_ar || '', m.job_name || '']))), 'My team');
  XL.writeFile(wb, 'petrokima-team-projects-template.xlsx'); toast('Template downloaded — the “My team” sheet lists the codes you can use');
}
async function mbuFile(){
  const f = $('mbu-file').files[0]; if (!f) return;
  try {
    const grid = (await readFile(f)).filter(r => r.some(v => buTxt(v) !== '')); if (grid.length < 2) return toast('The file has no data rows','warn');
    const hdr = grid[0].map(H), ie = hdr.findIndex(h => ['employeecode','employee','code','empcode','كودالموظف'].includes(h)), ip = hdr.findIndex(h => ['projectcode','project','كودالمشروع','المشروع'].includes(h));
    if (ie < 0 || ip < 0) return toast('Use the template headings: Employee code, Project code','err');
    const team = new Map(((SD && SD.myTeam) || []).map(m => [String(m.id), m])), found = new Map(), seen = new Map();
    const codes = [...new Set(grid.slice(1).map(r => buTxt(r[ip])).filter(Boolean))];
    const have = new Set();                                            // projects each team member already has
    for (const e of [...new Set(grid.slice(1).map(r => buTxt(r[ie]).replace(/\.0$/,'')).filter(x => team.has(x)))]){
      const r = await sb.rpc('team_projects', { p_emp: e }); (r.data || []).forEach(p => have.add(e + '|' + String(p.id).toLowerCase())); }
    for (const c of codes){ const r = await sb.rpc('find_projects', { p_q: c }); const hit = (r.data || []).find(p => String(p.id).toLowerCase() === c.toLowerCase()); found.set(c.toLowerCase(), hit || null); }
    MBU = grid.slice(1).map((r, i) => { const emp = buTxt(r[ie]).replace(/\.0$/,''), pc = buTxt(r[ip]), m = team.get(emp), p = found.get(pc.toLowerCase());
      let res;
      if (!m) res = { kind:'error', msg:`${emp || '(blank)'} is not in your team` };
      else if (!pc) res = { kind:'error', msg:'Project code is missing' };
      else if (!p) res = { kind:'error', msg:`Project “${pc}” not found (or not active)` };
      else if (have.has(emp + '|' + String(p.id).toLowerCase())) res = { kind:'skip', label:`${m.name_en || m.name_ar || emp} → ${p.id}`, msg:'Already assigned' };
      else { const k = emp + '|' + p.id; res = seen.has(k) ? { kind:'skip', msg:`Same as row ${seen.get(k)}` } : { kind:'new', emp, code:p.id, label:`${m.name_en || m.name_ar || emp} → ${p.id} · ${p.name || ''}` }; seen.set(k, i + 2); }
      return { n: i + 2, res }; });
    mbuRender(); openM('m-mbu');
  } catch(e){ toast(e.message, 'err'); }
  $('mbu-file').value = '';
}
function mbuRender(){
  const c = k => MBU.filter(r => r.res.kind === k).length;
  $('mbu-summary').innerHTML = `<span class="chip c-green">✅ ${c('new')} to add</span> <span class="chip c-grey">⏭ ${c('skip')} skipped</span> <span class="chip c-red">✗ ${c('error')} with problems</span>${c('saved') ? ` <span class="chip c-green">✓ ${c('saved')} saved</span>` : ''}`;
  $('mbu-rows').innerHTML = MBU.map(r => `<tr><td class="mono">${r.n}</td><td>${{ new:'<span class="chip c-green">Add</span>', skip:'<span class="chip c-grey">Skip</span>', error:'<span class="chip c-red">Problem</span>', saved:'<span class="chip c-green">✓ Saved</span>', failed:'<span class="chip c-red">✗ Not saved</span>' }[r.res.kind]}</td>
    <td>${esc(r.res.label || '')}</td><td style="color:${['error','failed'].includes(r.res.kind)?'var(--danger)':'var(--muted)'}">${esc(r.res.msg || '')}</td></tr>`).join('');
  $('mbu-save').disabled = !c('new'); $('mbu-save').textContent = c('new') ? `Save ${c('new')}` : 'Nothing to save';
}
async function mbuSave(){
  const todo = MBU.filter(r => r.res.kind === 'new'); $('mbu-save').disabled = true;
  for (const r of todo){
    const { data, error } = await sb.from('employee_projects').insert({ emp_id: r.res.emp, project_code: r.res.code }).select('emp_id');
    if (error && (error.code === '23505' || /duplicate/i.test(error.message))) r.res = { ...r.res, kind:'skip', msg:'Already assigned' };
    else if (error || !(data && data.length)) r.res = { ...r.res, kind:'failed', msg: error ? error.message : NOPERM };
    else r.res = { ...r.res, kind:'saved', msg:'' };
  }
  mbuRender(); const s = MBU.filter(r => r.res.kind === 'saved').length;
  toast(`${s} assignment${s===1?'':'s'} added for your team`); const t = await sb.rpc('my_team'); if (SD) SD.myTeam = t.data || SD.myTeam; renderSelf();
}
$('mbu-template').addEventListener('click', mbuTemplate);
$('mbu-file').addEventListener('change', mbuFile);
$('mbu-save').addEventListener('click', mbuSave);

// ═════════════════════════════════════════════════════════
//  NET ↔ GROSS CALCULATOR (Egypt) — standalone tool, does not change the payroll
//  2026 defaults: personal exemption 20,000 · brackets per Law 91/2005 as amended (incl. losing lower brackets
//  above 600,000) · social insurance 11% employee / 18.75% employer on a wage of 2,700–16,700 · martyrs' fund 0.05%
// ═════════════════════════════════════════════════════════
const CALC_DEFAULTS = { year: 2026, exemption: 20000, siEmp: 11, siEr: 18.75, siMin: 2700, siMax: 16700, martyrs: 0.05, round10: true,
  // the normal ladder: [upper limit of the bracket, rate %]
  brackets: [[40000, 0], [55000, 10], [70000, 15], [200000, 20], [400000, 22.5], [1200000, 25], [Infinity, 27.5]],
  // higher incomes lose the lower brackets: above this annual taxable income, tax starts from this bracket
  skip: [[600000, 1], [700000, 2], [800000, 3], [900000, 4], [1200000, 5]] };
let calcRates = () => ({ ...CALC_DEFAULTS, ...((settings && settings.calcRates) || {}) });
// annual tax on annual taxable income (after the personal exemption)
function annualTax(n, R){
  R = R || calcRates(); if (!(n > 0)) return { tax:0, rows:[] };
  let start = 0; R.skip.forEach(([lim, idx]) => { if (n > lim) start = idx; });
  let tax = 0, prev = 0; const rows = [];
  R.brackets.forEach(([up, rate], i) => {
    const lo = i < start ? null : (i === start ? 0 : prev); prev = up;
    if (lo === null) return;
    const top = Math.min(n, up); if (top <= lo) return;
    const part = (top - lo) * rate / 100; tax += part; rows.push({ from: lo, to: top, rate, tax: part });
  });
  return { tax, rows };
}
// gross → net for one month
function grossToNet(gross, o = {}){
  const R = o.rates || calcRates();
  const insured = o.insured !== false;
  const baseIns = o.insWage > 0 ? o.insWage : gross;
  const insWage = insured ? Math.min(Math.max(baseIns, R.siMin), R.siMax) : 0;
  const siEmp = insured ? insWage * R.siEmp / 100 : 0;
  const exempt = Math.max(0, num(o.exempt));
  const monthlyTaxable = Math.max(0, gross - siEmp - exempt);
  let annualTaxable = Math.max(0, monthlyTaxable * 12 - R.exemption);
  if (R.round10) annualTaxable = Math.floor(annualTaxable / 10) * 10;
  const at = annualTax(annualTaxable, R);
  const tax = at.tax / 12, martyrs = gross * R.martyrs / 100;
  const net = gross - siEmp - tax - martyrs;
  const siEr = insured ? insWage * R.siEr / 100 : 0;
  return { gross, insWage, siEmp, exempt, monthlyTaxable, annualTaxable, annualTax: at.tax, rows: at.rows, tax, martyrs, net, siEr, cost: gross + siEr };
}
// net → gross: the gross that leaves exactly this net (to the piastre)
function netToGross(net, o = {}){
  if (!(net > 0)) return grossToNet(0, o);
  let lo = net, hi = net * 2 + 100000;
  while (grossToNet(hi, o).net < net) hi *= 2;
  for (let i = 0; i < 80 && hi - lo > 0.001; i++){ const mid = (lo + hi) / 2; if (grossToNet(mid, o).net < net) lo = mid; else hi = mid; }
  const exact = Math.round(hi * 100) / 100, whole = Math.ceil(exact - 1e-9);
  const w = grossToNet(whole, o);                            // prefer a whole-pound gross when it leaves the same net
  return Math.abs(w.net - net) <= 0.01 ? w : grossToNet(exact, o);
}

// ── the page ──
let CC_DIR = 'g2n';
const ccFmt = v => (Math.round(v * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function ccOpts(){ return { insured: $('cc-ins').checked, insWage: num($('cc-insw').value), exempt: num($('cc-ex').value) }; }
function renderCalc(){
  const R = calcRates();
  $('cc-rates-note').innerHTML = `Rates for <b>${R.year}</b>: personal exemption ${fmt(R.exemption)} · insurance ${R.siEmp}% (employee) on a wage of ${fmt(R.siMin)}–${fmt(R.siMax)} · martyrs' fund ${R.martyrs}% of gross.`;
  $('cc-insw-box').style.display = $('cc-ins').checked ? '' : 'none';
  ccFillRates(R); ccCalc();
}
function ccCalc(){
  const amt = num($('cc-amt').value), o = ccOpts();
  if (!(amt > 0)){ $('cc-out').innerHTML = '<tr><td class="empty">Type an amount on the left</td></tr>'; $('cc-br').innerHTML = ''; return; }
  const r = CC_DIR === 'g2n' ? grossToNet(amt, o) : netToGross(amt, o);
  const row = (l, v, strong, note) => `<tr${strong ? ' style="background:var(--hover)"' : ''}><td${strong ? ' class="strong"' : ''}>${l}${note ? `<div style="font-size:11px;color:var(--muted)">${note}</div>` : ''}</td><td class="num${strong ? ' strong' : ''}" style="font-size:${strong ? 18 : 14}px">${ccFmt(v)}</td></tr>`;
  const R = calcRates();
  $('cc-out').innerHTML =
      row('Gross salary', r.gross, CC_DIR === 'n2g', CC_DIR === 'n2g' ? 'the gross needed for the net you entered' : '')
    + (o.insured ? row('Insurance wage (أجر الاشتراك)', r.insWage, false, `kept within ${fmt(R.siMin)}–${fmt(R.siMax)}`) : '')
    + row(`− Social insurance, employee (${R.siEmp}%)`, -r.siEmp)
    + row('− Wage tax (ضريبة كسب العمل)', -r.tax, false, `${ccFmt(r.annualTax)} a year on ${fmt(r.annualTaxable)} taxable (after the ${fmt(R.exemption)} exemption)`)
    + row(`− Martyrs' families fund (${R.martyrs}%)`, -r.martyrs)
    + row('Net salary', r.net, true, CC_DIR === 'n2g' ? 'check: equals the net you entered' : '')
    + (o.insured ? row(`Employer's social insurance (${R.siEr}%)`, r.siEr, false, 'paid by the company, on top of the gross') : '')
    + row('Total monthly cost to the company', r.cost, true);
  $('cc-br').innerHTML = r.rows.map(b => `<tr><td class="mono">${fmt(b.from)} – ${fmt(b.to)}</td><td class="num">${b.rate}%</td><td class="num">${ccFmt(b.tax)}</td></tr>`).join('')
    + `<tr style="background:var(--hover)"><td class="strong">Total for the year (÷ 12 = ${ccFmt(r.tax)} a month)</td><td></td><td class="num strong">${ccFmt(r.annualTax)}</td></tr>`;
}
function ccFillRates(R){
  ['year','exemption','martyrs','siEmp','siEr','siMin','siMax'].forEach(k => { const el = $('cr-' + k); if (document.activeElement !== el) el.value = R[k]; });
  if (document.activeElement !== $('cr-brackets')) $('cr-brackets').value = R.brackets.map(([u, r]) => `${u === Infinity || u === null ? 'above' : u}, ${r}`).join('\n');
  if (document.activeElement !== $('cr-skip')) $('cr-skip').value = R.skip.map(([a, i]) => `${a}, ${i + 1}`).join('\n');
}
function ccReadRates(){
  const brackets = $('cr-brackets').value.split('\n').map(l => l.split(',').map(x => x.trim())).filter(p => p.length === 2 && p[1] !== '')
    .map(([u, r]) => [/above|∞|فوق/i.test(u) ? Infinity : Number(u), Number(r)]);
  const skip = $('cr-skip').value.split('\n').map(l => l.split(',').map(x => x.trim())).filter(p => p.length === 2 && p[1] !== '').map(([a, i]) => [Number(a), Number(i) - 1]);
  const R = { year: num($('cr-year').value), exemption: num($('cr-exemption').value), martyrs: num($('cr-martyrs').value), siEmp: num($('cr-siEmp').value),
              siEr: num($('cr-siEr').value), siMin: num($('cr-siMin').value), siMax: num($('cr-siMax').value), round10: true, brackets, skip };
  const bad = brackets.some(([u, r], i) => !(u > 0) || !(r >= 0) || (i && u <= brackets[i-1][0])) || brackets[brackets.length - 1][0] !== Infinity
           || skip.some(([a, i]) => !(a > 0) || !(i >= 0) || i >= brackets.length) || !(R.siMax > R.siMin);
  if (bad) throw new Error('Check the rates: brackets must go up, the last line must be “above, rate”, and the insurance minimum must be below the maximum.');
  return R;
}
async function ccSave(){
  let R; try { R = ccReadRates(); } catch(e){ return toast(e.message, 'warn'); }
  const old = settings.calcRates; settings.calcRates = { ...R, brackets: R.brackets.map(([u, r]) => [u === Infinity ? null : u, r]) };
  const { data, error } = await sb.from('settings').upsert({ key:'payroll', value:settings }).select();
  if (error || !(data && data.length)){ settings.calcRates = old; return toast(error ? error.message : NOPERM, 'err'); }
  toast(`Rates for ${R.year} saved`); renderCalc();
}
// stored rates keep "above" as null — turn it back into Infinity
const _calcRatesRaw = calcRates;
calcRates = function(){ const R = _calcRatesRaw(); return { ...R, brackets: R.brackets.map(([u, r]) => [u === null ? Infinity : u, r]) }; };
$('cc-g2n').addEventListener('click', () => { CC_DIR = 'g2n'; $('cc-g2n').className = 'btn btn-sm btn-primary'; $('cc-n2g').className = 'btn btn-sm btn-ghost'; $('cc-amt-l').textContent = 'Monthly gross salary (EGP)'; ccCalc(); });
$('cc-n2g').addEventListener('click', () => { CC_DIR = 'n2g'; $('cc-n2g').className = 'btn btn-sm btn-primary'; $('cc-g2n').className = 'btn btn-sm btn-ghost'; $('cc-amt-l').textContent = 'Agreed monthly net salary (EGP)'; ccCalc(); });
['cc-amt','cc-insw','cc-ex'].forEach(id => $(id).addEventListener('input', ccCalc));
$('cc-ins').addEventListener('change', () => { $('cc-insw-box').style.display = $('cc-ins').checked ? '' : 'none'; ccCalc(); });
$('cc-save').addEventListener('click', ccSave);
$('cc-reset').addEventListener('click', () => { ccFillRates({ ...CALC_DEFAULTS }); toast('2026 defaults filled in — click Save rates to keep them'); });

// ═════════════════════════════════════════════════════════
//  WAGE-TAX SETTLEMENT WORKBOOK — check, year-to-date reconciliation, planning benchmark (internal analysis)
//  Reads the monthly settlement sheets (B code · C name · J months · K/L/M pay · N gross · P insurance · U period tax).
// ═════════════════════════════════════════════════════════
let ST = null;                                             // { sheets: { name: rows[] } }
const stN = v => { const x = Number(String(v ?? '').replace(/,/g, '')); return isFinite(x) ? x : 0; };
const stF = v => (Math.round(v * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function stRead(ws){
  const rows = XLSX.utils.sheet_to_json(ws, { header: 'A', defval: null, raw: true }), out = [];
  for (let i = 4; i < rows.length; i++){
    const r = rows[i]; const a = String(r.A ?? '');
    if (/الإجمال|الاجمال|total/i.test(a)) break;               // the totals row ends the list
    const code = String(r.B ?? '').trim(), name = String(r.C ?? '').trim();
    if (!code || !name) continue;
    const gross = r.N != null ? stN(r.N) : stN(r.K) + stN(r.L) + stN(r.M);
    out.push({ code, name, months: stN(r.J) || 1, gross, ins: r.P != null ? stN(r.P) : stN(r.W), sheetTax: stN(r.U) });
  }
  return out;
}
function stTax(gross, ins, months){                         // tax for the period, current rules
  const R = calcRates();
  let annual = Math.max(0, (gross - ins) * 12 / (months || 1) - R.exemption);
  if (R.round10) annual = Math.floor(annual / 10) * 10;
  return { annual, tax: annualTax(annual, R).tax * (months || 1) / 12 };
}
$('st-file').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  $('st-out').innerHTML = '<div class="empty">Reading the workbook…</div>';
  try {
    await loadSheetJs();
    const wb = XLSX.read(new Uint8Array(await readAs(f, 'buffer')), { type: 'array' });
    const sheets = {};
    wb.SheetNames.forEach(n => { const rows = stRead(wb.Sheets[n]); if (rows.length) sheets[n] = rows; });
    const names = Object.keys(sheets);
    if (!names.length) throw new Error('No settlement sheets found — the employee list must start on row 5 (code in column B, name in column C).');
    ST = { sheets, file: f.name };
    $('st-sheet').innerHTML = names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('') + (names.length > 1 ? `<option value="__all">All months (year to date)</option>` : '');
    $('st-sheet').value = names[names.length - 1]; $('st-sheet').style.display = '';
    stRender();
  } catch (err) { $('st-out').innerHTML = `<div class="alert a-warn">${esc(err.message)}</div>`; }
});
$('st-sheet').addEventListener('change', () => stRender());
function stRender(){
  if (!ST) return;
  const sel = $('st-sheet').value;
  if (sel === '__all') return stRenderYTD();
  const rows = ST.sheets[sel].map(r => { const c = stTax(r.gross, r.ins, r.months); return { ...r, annual: c.annual, calcTax: c.tax, diff: r.sheetTax - c.tax }; });
  const tot = k => rows.reduce((s, r) => s + r[k], 0), bad = rows.filter(r => Math.abs(r.diff) > 1);
  // planning benchmark — totals only
  const H = rows.filter(r => r.gross > 0).length, taxable = rows.reduce((s, r) => s + Math.max(0, r.gross - r.ins), 0);
  const per = H ? taxable / H : 0, even = H ? H * stTax(per, 0, 1).tax : 0, actual = tot('calcTax');
  const byTax = [...rows].sort((a, b) => b.calcTax - a.calcTax), top10 = byTax.slice(0, 10).reduce((s, r) => s + r.calcTax, 0);
  const bands = [[0, 10000, 'up to 10,000'], [10000, 20000, '10,000 – 20,000'], [20000, 50000, '20,000 – 50,000'], [50000, 100000, '50,000 – 100,000'], [100000, Infinity, 'above 100,000']]
    .map(([lo, hi, l]) => { const b = rows.filter(r => r.gross > lo && r.gross <= hi); const g = b.reduce((s, r) => s + r.gross, 0), t = b.reduce((s, r) => s + r.calcTax, 0);
      return `<tr><td>${l}</td><td class="num">${b.length}</td><td class="num">${stF(g)}</td><td class="num">${stF(t)}</td><td class="num">${g ? (t / g * 100).toFixed(1) + '%' : '—'}</td><td class="num">${actual ? (t / actual * 100).toFixed(1) + '%' : '—'}</td></tr>`; }).join('');
  $('st-out').innerHTML = `
    <div class="stats" style="margin:6px 0 14px">
      <div class="stat"><div class="stat-label">Employees · ${esc(sel)}</div><div class="stat-value">${rows.length}</div></div>
      <div class="stat"><div class="stat-label">Total gross</div><div class="stat-value">${stF(tot('gross'))}</div></div>
      <div class="stat"><div class="stat-label">Tax in the sheet</div><div class="stat-value">${stF(tot('sheetTax'))}</div></div>
      <div class="stat"><div class="stat-label">Tax — current rules</div><div class="stat-value">${stF(actual)}</div><div class="stat-sub">${bad.length ? `<b style="color:var(--danger)">${bad.length} line(s) differ</b>` : 'all lines match ✓'}</div></div>
    </div>
    <div class="toolbar-title" style="margin:6px 0">📊 Planning benchmark (totals only)</div>
    <div class="alert a-info" style="margin-bottom:10px;line-height:1.7">If the same total taxable payroll (<b>${stF(taxable)}</b>) were spread evenly over the same <b>${H}</b> employees (<b>${stF(per)}</b> each a month), the total monthly tax would be <b>${stF(even)}</b> instead of <b>${stF(actual)}</b> — a theoretical difference of <b>${stF(actual - even)}</b> a month (${actual ? ((actual - even) / actual * 100).toFixed(1) : 0}%).
      The <b>10 highest-taxed employees</b> carry <b>${actual ? (top10 / actual * 100).toFixed(1) : 0}%</b> of the total tax.
      <div style="font-size:12px;color:var(--muted);margin-top:4px">A theoretical benchmark of how pay concentration drives tax. Each employee is always taxed on the pay he actually receives.</div></div>
    <div class="tbl-wrap" style="margin-bottom:16px"><table><thead><tr><th>Monthly gross band</th><th class="num">Employees</th><th class="num">Gross</th><th class="num">Tax</th><th class="num">Effective rate</th><th class="num">Share of total tax</th></tr></thead><tbody>${bands}</tbody></table></div>
    <div class="toolbar"><span class="toolbar-title">✅ Check per employee — ${esc(sel)}</span><label style="font-size:13px;margin-inline-start:auto"><input type="checkbox" id="st-only"> show only lines that differ</label></div>
    <div class="tbl-wrap"><table><thead><tr><th>Code</th><th>Name</th><th class="num">Gross</th><th class="num">Insurance</th><th class="num">Annual tax base</th><th class="num">Tax in sheet</th><th class="num">Tax — current rules</th><th class="num">Difference</th></tr></thead>
      <tbody id="st-rows">${stRows(rows, false)}</tbody></table></div>`;
  $('st-only').onchange = () => { $('st-rows').innerHTML = stRows(rows, $('st-only').checked); };
}
function stRows(rows, onlyBad){
  return rows.filter(r => !onlyBad || Math.abs(r.diff) > 1).map(r => `<tr${Math.abs(r.diff) > 1 ? ' style="background:rgba(214,69,69,.08)"' : ''}><td class="mono">${esc(r.code)}</td><td>${esc(r.name)}</td>
    <td class="num">${stF(r.gross)}</td><td class="num">${stF(r.ins)}</td><td class="num">${stF(r.annual)}</td><td class="num">${stF(r.sheetTax)}</td><td class="num">${stF(r.calcTax)}</td>
    <td class="num"${Math.abs(r.diff) > 1 ? ' style="color:var(--danger);font-weight:700"' : ''}>${Math.abs(r.diff) > 1 ? stF(r.diff) : '✓'}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">No differences ✓</td></tr>';
}
function stRenderYTD(){
  const by = {};
  Object.entries(ST.sheets).forEach(([sheet, rows]) => rows.forEach(r => {
    const x = by[r.code] || (by[r.code] = { code: r.code, name: r.name, months: 0, taxable: 0, gross: 0, withheld: 0 });
    x.name = r.name; x.months += r.months; x.gross += r.gross; x.taxable += Math.max(0, r.gross - r.ins); x.withheld += r.sheetTax;
  }));
  const list = Object.values(by).map(x => { const c = stTax(x.taxable, 0, x.months); return { ...x, due: c.tax, diff: x.withheld - c.tax }; }).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  const over = list.filter(x => x.diff > 1), under = list.filter(x => x.diff < -1), s = k => list.reduce((t, x) => t + x[k], 0);
  $('st-out').innerHTML = `
    <div class="stats" style="margin:6px 0 14px">
      <div class="stat"><div class="stat-label">Months · employees</div><div class="stat-value">${Object.keys(ST.sheets).length} · ${list.length}</div></div>
      <div class="stat"><div class="stat-label">Tax withheld (sheets)</div><div class="stat-value">${stF(s('withheld'))}</div></div>
      <div class="stat"><div class="stat-label">Tax due on year-to-date pay</div><div class="stat-value">${stF(s('due'))}</div></div>
      <div class="stat"><div class="stat-label">Over / under withheld</div><div class="stat-value" style="font-size:18px">${over.length} over · ${under.length} under</div><div class="stat-sub">net ${stF(s('withheld') - s('due'))}</div></div>
    </div>
    <div class="alert a-info" style="margin-bottom:10px">Year-to-date method: each employee's pay for all months is annualised together, the tax due for the months worked is compared with what was withheld month by month. <b>Over-withheld</b> amounts can be corrected by withholding less in the remaining months; <b>under-withheld</b> amounts should be collected before year end.</div>
    <div class="tbl-wrap"><table><thead><tr><th>Code</th><th>Name</th><th class="num">Months</th><th class="num">Gross YTD</th><th class="num">Withheld YTD</th><th class="num">Due YTD</th><th class="num">Over (+) / under (−)</th></tr></thead><tbody>
      ${list.map(x => `<tr${Math.abs(x.diff) > 1 ? ' style="background:' + (x.diff > 0 ? 'rgba(59,111,212,.07)' : 'rgba(214,69,69,.08)') + '"' : ''}><td class="mono">${esc(x.code)}</td><td>${esc(x.name)}</td><td class="num">${(+x.months.toFixed(2))}</td>
        <td class="num">${stF(x.gross)}</td><td class="num">${stF(x.withheld)}</td><td class="num">${stF(x.due)}</td><td class="num" style="font-weight:700;color:${x.diff > 1 ? 'var(--link)' : x.diff < -1 ? 'var(--danger)' : 'inherit'}">${Math.abs(x.diff) > 1 ? stF(x.diff) : '✓'}</td></tr>`).join('')}</tbody></table></div>`;
}

// ═════════════════════════════════════════════════════════
//  ANNOUNCEMENTS · EMPLOYEE VOICE · BIRTHDAYS (desktop)
// ═════════════════════════════════════════════════════════
const V = { news:[], reads:[], fb:[], hire:[], train:[], act:[] };
const vDate = ts => ts ? new Date(ts).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' }) : '';
const vChip = s => `<span class="chip ${({'Waiting for board':'c-orange','Waiting for HR':'c-blue',Approved:'c-green',Cancelled:'c-grey',New:'c-orange','In review':'c-blue','In progress':'c-blue',Closed:'c-green',Done:'c-green',Rejected:'c-red'})[s]||'c-grey'}">${esc(s)}</span>`;
const vName = id => { const e = empById(id); return e ? `${empName(e)} (${id})` : id; };
// ── birthdays ──
const isBirthdayToday = d => { if (!d) return false; const t = new Date(), b = String(d).slice(5,10), m = String(t.getMonth()+1).padStart(2,'0'), day = String(t.getDate()).padStart(2,'0');
  return b === `${m}-${day}` || (b === '02-29' && `${m}-${day}` === '02-28' && new Date(t.getFullYear(), 1, 29).getMonth() !== 1); };
function renderBirthdays(){
  const box = $('dash-bday'); if (!box) return;
  const L = (S.employees || []).filter(e => e.status !== 'Inactive' && isBirthdayToday(e.birth_date));
  box.innerHTML = L.length ? `<div class="alert a-info" style="margin-bottom:14px">🎂 <b>Birthdays today:</b> ${L.map(e => esc(`${empName(e)} (${e.id})${e.department ? ' — ' + e.department : ''}`)).join(' · ')}. Their phone app shows “Petrokima family wishes you a happy birthday”.</div>` : '';
}
const _renderDashboardB = renderDashboard;
renderDashboard = function(){ const r = _renderDashboardB.apply(this, arguments); renderBirthdays(); if (ME && ['admin','hr'].includes(ME.role) && !V.loaded){ V.loaded = true; loadVoice().catch(() => {}); } return r; };
async function renderSelfBirthday(){
  const box = $('self-bday'); if (!box) return;
  const r = await sb.rpc('my_birthday_today').then(x => x, () => ({}));
  box.innerHTML = r && r.data ? `<div class="card" style="background:linear-gradient(135deg,#ee2624,#b4151a);color:#fff;text-align:center;padding:22px;margin-bottom:16px">
      <div style="font-size:42px">🎂</div><div style="font-size:20px;font-weight:800;margin-top:6px">Petrokima family wishes you a happy birthday 🎉</div>
      <div style="opacity:.9;margin-top:4px">عائلة بتروكيما تتمنى لك عيد ميلاد سعيد</div></div>` : '';
}
const _showSelfB = showSelf;
showSelf = async function(){ const r = await _showSelfB.apply(this, arguments); renderSelfBirthday(); return r; };

// ── announcements ──
async function loadNews(){
  const [a, r] = await Promise.all([sb.from('announcements').select('*').order('created_at', { ascending:false }), fetchAll('announcement_reads', 'ann_id')]);
  V.news = a.data || []; V.reads = r || [];
}
async function renderNewsPage(){
  const depts = [...new Set((S.employees || []).filter(e => e.status !== 'Inactive').map(e => e.department).filter(Boolean))].sort();
  const keep = $('an-dept').value; $('an-dept').innerHTML = '<option value="">Everyone</option>' + depts.map(d => `<option ${d===keep?'selected':''}>${esc(d)}</option>`).join('');
  await loadNews();
  const active = (S.employees || []).filter(e => e.status !== 'Inactive');
  $('an-tbl').innerHTML = V.news.map(a => { const aud = a.department ? active.filter(e => e.department === a.department).length : active.length, rd = V.reads.filter(x => x.ann_id === a.id).length;
    return `<tr><td class="mono">${esc(vDate(a.created_at))}</td><td>${a.kind==='decision' ? '📜 Decision' : '📢 Announcement'}</td><td class="strong" style="white-space:normal">${esc(a.title)}</td>
      <td>${esc(a.department || 'Everyone')}</td><td>${a.attachment_path ? `<a href="#" data-an-att="${esc(a.attachment_path)}" style="color:var(--link)">📎 ${esc(a.attachment_name || 'file')}</a>` : ''}</td>
      <td class="num">${rd} / ${aud}</td><td><button class="btn btn-ghost btn-sm" data-an-del="${esc(a.id)}">🗑</button></td></tr>`; }).join('') || '<tr><td colspan="7" class="empty">Nothing published yet</td></tr>';
}
async function publishNews(){
  const title = $('an-title').value.trim(); if (!title) return toast('Write a title','warn');
  const f = $('an-file').files[0]; if (f && f.size > 20 * 1024 * 1024) return toast('The attachment is larger than 20 MB','warn');
  const b = $('an-go'); b.disabled = true; b.textContent = 'Publishing…';
  try {
    let path = null, name = null;
    if (f){
      name = f.name; path = `${new Date().getFullYear()}/${(crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36))}-${f.name.replace(/[^A-Za-z0-9._-]+/g, '_')}`;
      const up = await sb.storage.from('announcements').upload(path, f, { contentType: f.type || 'application/octet-stream', upsert:false });
      if (up.error) throw new Error('Attachment not uploaded: ' + up.error.message);
    }
    const { data, error } = await sb.from('announcements').insert({ kind:$('an-kind').value, title, body:$('an-body').value.trim(), department:$('an-dept').value || null,
      attachment_path:path, attachment_name:name, created_by:(ME && (ME.full_name || ME.email)) || 'HR' }).select();
    if (error || !(data && data.length)){ if (path) await sb.storage.from('announcements').remove([path]); throw new Error(error ? error.message : NOPERM); }
    ['an-title','an-body'].forEach(i => $(i).value = ''); $('an-file').value = '';
    toast(`Published to ${$('an-dept').value || 'everyone'} — it appears in the 📢 tab of the phone app`); renderNewsPage();
  } catch(e){ toast(e.message, 'err'); }
  b.disabled = false; b.textContent = '📢 Publish';
}
document.addEventListener('click', async e => {
  const at = e.target.closest('[data-an-att]'); if (at){ e.preventDefault(); const { data, error } = await sb.storage.from('announcements').createSignedUrl(at.dataset.anAtt, 600); if (error) return toast(error.message,'err'); window.open(data.signedUrl, '_blank'); return; }
  const del = e.target.closest('[data-an-del]'); if (del){ const a = V.news.find(x => x.id === del.dataset.anDel); if (!a) return;
    confirmDel(`Delete “${a.title}”? Employees will no longer see it.`, async () => {
      const { error } = await sb.from('announcements').delete().eq('id', a.id); if (error) throw error;
      if (a.attachment_path) await sb.storage.from('announcements').remove([a.attachment_path]);
      toast('Announcement deleted'); renderNewsPage(); }); }
});
$('an-go').addEventListener('click', publishNews);

// ── employee voice ──
async function loadVoice(){
  const [f, h, t, m] = await Promise.all([sb.rpc('feedback_inbox'), sb.from('hiring_requests').select('*').order('created_at', { ascending:false }),
    sb.from('training_requests').select('*').order('created_at', { ascending:false }), sb.from('manager_actions').select('*').order('created_at', { ascending:false })]);
  V.fb = f.data || []; V.hire = h.data || []; V.train = t.data || []; V.act = m.data || [];
  const open = V.fb.filter(x => x.status !== 'Closed').length + V.hire.filter(x => x.status === 'New').length + V.train.filter(x => x.status === 'New').length + V.act.filter(x => x.status === 'Waiting for HR').length;
  const b = $('voice-badge'); if (b){ b.textContent = open; b.style.display = open ? '' : 'none'; }
}
async function renderVoicePage(){
  await loadVoice();
  const k = $('vo-kind').value, st = $('vo-st').value;
  const fb = V.fb.filter(x => (!k || x.kind === k) && (!st || (st === 'open' ? x.status !== 'Closed' : x.status === 'Closed')));
  $('vo-fb').innerHTML = fb.map(x => `<tr data-vo="fb:${esc(x.id)}" style="cursor:pointer"><td class="mono">${esc(vDate(x.created_at))}</td><td>${x.kind==='complaint' ? '⚠️ Complaint' : '💡 Suggestion'}</td>
      <td>${x.anonymous ? '🕶 <i>Anonymous</i>' : esc(x.emp_name ? `${x.emp_name} (${x.emp_id})` : vName(x.emp_id))}</td><td class="strong" style="white-space:normal">${esc(x.subject)}</td><td style="white-space:normal;max-width:320px">${esc(x.body)}</td>
      <td>${vChip(x.status)}</td><td style="white-space:normal;max-width:240px">${esc(x.reply || '')}${x.replied_by ? `<div style="font-size:11px;color:var(--muted)">— ${esc(x.replied_by)}</div>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">Nothing here</td></tr>';
  $('vo-hire').innerHTML = V.hire.map(x => `<tr data-vo="hire:${esc(x.id)}" style="cursor:pointer"><td class="mono">${esc(vDate(x.created_at))}</td><td>${esc(vName(x.manager_emp))}</td><td class="num">${x.headcount}</td>
      <td class="strong">${esc(x.job_name)}</td><td style="white-space:normal;max-width:340px">${esc(x.job_description)}${x.notes ? `<div style="font-size:12px;color:var(--muted)">${esc(x.notes)}</div>` : ''}</td>
      <td class="mono">${esc(x.needed_by || '')}</td><td>${vChip(x.status)}</td><td style="white-space:nowrap;font-size:12px">HR ${x.hr_closed ? '✔' : '—'} · Manager ${x.mgr_closed ? '✔' : '—'}</td><td style="white-space:normal">${esc(x.hr_note || '')}${x.close_note ? `<div style="font-size:11px;color:var(--muted)">${esc(x.close_note)}</div>` : ''}</td></tr>`).join('') || '<tr><td colspan="9" class="empty">No requests</td></tr>';
  $('vo-act').innerHTML = V.act.map(x => `<tr data-vo="act:${esc(x.id)}" style="cursor:pointer${x.status === 'Waiting for HR' ? ';background:rgba(224,123,57,.08)' : ''}"><td class="mono">${esc(vDate(x.created_at))}</td>
      <td>${x.kind === 'penalty' ? '⚖️ Penalty' : '💰 ' + esc(x.element_name || 'Incentive')}</td><td>${esc(x.emp_name ? `${x.emp_name} (${x.emp_id})` : vName(x.emp_id))}</td>
      <td class="num">${fmt(x.quantity)} ${x.action_type === 'Amount' ? 'EGP' : x.action_type === 'Days' ? 'day(s)' : 'hour(s)'}${x.amount != null && x.action_type !== 'Amount' ? `<div style="font-size:11px;color:var(--muted)">= ${fmt(x.amount)} EGP</div>` : ''}</td><td class="mono">${esc(x.apply_period)}</td>
      <td style="white-space:normal;max-width:300px">${esc(x.reason)}</td><td>${esc(x.manager_name || vName(x.manager_emp))}</td>
      <td style="white-space:normal;font-size:12px">${x.board_by ? `${esc(x.board_by)}${x.board_note ? ': ' + esc(x.board_note) : ''}` : ''}</td><td>${vChip(x.status)}</td></tr>`).join('') || '<tr><td colspan="9" class="empty">No requests</td></tr>';
  $('vo-train').innerHTML = V.train.map(x => `<tr data-vo="train:${esc(x.id)}" style="cursor:pointer"><td class="mono">${esc(vDate(x.created_at))}</td><td>${esc(vName(x.manager_emp))}</td>
      <td style="white-space:normal;max-width:260px">${(x.emp_ids || []).map(id => esc(vName(id))).join(', ')}</td><td class="strong">${esc(x.topic)}</td><td style="white-space:normal;max-width:300px">${esc(x.details || '')}</td>
      <td class="mono">${esc(x.preferred_date || '')}</td><td>${vChip(x.status)}</td><td style="white-space:normal">${esc(x.hr_note || '')}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">No requests</td></tr>';
}
let VO_CUR = null;
document.addEventListener('click', e => {
  const r = e.target.closest('[data-vo]'); if (!r) return;
  const [kind, id] = r.dataset.vo.split(':'), x = (kind === 'fb' ? V.fb : kind === 'hire' ? V.hire : kind === 'act' ? V.act : V.train).find(y => y.id === id); if (!x) return;
  VO_CUR = { kind, x };
  $('mv-close').style.display = kind === 'hire' && x.status !== 'Closed' && !x.hr_closed ? '' : 'none';
  $('mv-reject').style.display = 'none'; $('mv-save').style.display = ''; $('mv-st').closest('.field').style.display = '';
  if (kind === 'act'){
    $('mv-title').textContent = `${x.kind === 'penalty' ? '⚖️ Penalty' : '💰 ' + (x.element_name || 'Incentive')} — ${x.emp_name || x.emp_id}`;
    $('mv-info').textContent = `Requested by: ${x.manager_name || x.manager_emp} · ${vDate(x.created_at)}\n${fmt(x.quantity)} ${x.action_type === 'Amount' ? 'EGP' : x.action_type === 'Days' ? 'day(s) of pay' : 'hour(s) of pay'} · payroll month ${x.apply_period}${x.incident_date ? ' · incident ' + x.incident_date : ''}\nReason: ${x.reason}\n\nBoard member: ${x.board_by ? x.board_by + (x.board_note ? ' — ' + x.board_note : '') : 'not yet'}\nStatus: ${x.status}`;
    $('mv-st').closest('.field').style.display = 'none'; $('mv-note-l').textContent = 'HR note'; $('mv-note').value = x.hr_note || '';
    const can = x.status === 'Waiting for HR'; $('mv-save').style.display = can ? '' : 'none'; $('mv-reject').style.display = can ? '' : 'none';
    $('mv-save').textContent = can ? '✔ Approve & record' : 'Save'; openM('m-voice'); return;
  }
  $('mv-save').textContent = 'Save';
  $('mv-title').textContent = kind === 'fb' ? `${x.kind === 'complaint' ? '⚠️ Complaint' : '💡 Suggestion'} — ${x.subject}` : kind === 'hire' ? `👥 ${x.headcount} × ${x.job_name}` : `🎓 ${x.topic}`;
  $('mv-info').textContent = kind === 'fb' ? `From: ${x.anonymous ? '🕶 Anonymous (the employee chose not to show the name)' : x.emp_name ? x.emp_name + ' (' + x.emp_id + ')' : vName(x.emp_id)} · ${vDate(x.created_at)}\n\n${x.body}`
    : kind === 'hire' ? `Manager: ${vName(x.manager_emp)} · ${vDate(x.created_at)}\nJob description: ${x.job_description}${x.needed_by ? '\nNeeded by: ' + x.needed_by : ''}${x.notes ? '\nNotes: ' + x.notes : ''}`
    : `Manager: ${vName(x.manager_emp)} · ${vDate(x.created_at)}\nEmployees: ${(x.emp_ids || []).map(vName).join(', ')}${x.details ? '\nDetails: ' + x.details : ''}${x.preferred_date ? '\nPreferred date: ' + x.preferred_date : ''}`;
  const sts = kind === 'fb' ? ['New','In review','Closed'] : kind === 'hire' ? (x.status === 'Closed' ? ['Closed'] : ['New','In progress']) : ['New','In progress','Done','Rejected'];
  $('mv-st').innerHTML = sts.map(s => `<option ${s === x.status ? 'selected' : ''}>${s}</option>`).join('');
  $('mv-note-l').textContent = kind === 'fb' ? 'Reply (the employee sees it in the app)' : 'HR note (the manager sees it in the app)';
  $('mv-note').value = (kind === 'fb' ? x.reply : x.hr_note) || '';
  openM('m-voice');
});
$('mv-save').addEventListener('click', async () => {
  if (!VO_CUR) return; const { kind, x } = VO_CUR;
  if (kind === 'act') return decideAct(true);
  if (kind === 'fb'){
    const { error } = await sb.rpc('answer_feedback', { p_id:x.id, p_status:$('mv-st').value, p_reply:$('mv-note').value.trim() || null });
    if (error) return toast(error.message, 'err');
  } else {
    const table = kind === 'hire' ? 'hiring_requests' : 'training_requests';
    const { data, error } = await sb.from(table).update({ status:$('mv-st').value, hr_note:$('mv-note').value.trim() || null }).eq('id', x.id).select();
    if (error || !(data && data.length)) return toast(error ? error.message : NOPERM, 'err');
  }
  closeM('m-voice'); toast('Saved — visible in the app'); renderVoicePage();
});
['vo-kind','vo-st'].forEach(id => $(id).addEventListener('change', renderVoicePage));

async function decideAct(ok){
  const { x } = VO_CUR;
  const { data, error } = await sb.rpc('decide_manager_action', { p_id:x.id, p_approve:ok, p_note:$('mv-note').value.trim() || null });
  if (error) return toast(error.message, 'err');
  closeM('m-voice'); toast(data || 'Saved'); renderVoicePage();
}
$('mv-reject').addEventListener('click', () => decideAct(false));
$('mv-close').addEventListener('click', async () => {
  const { x } = VO_CUR;
  const { data, error } = await sb.rpc('close_hiring_request', { p_id:x.id, p_note:$('mv-note').value.trim() || null });
  if (error) return toast(error.message, 'err');
  closeM('m-voice'); toast(data === 'Closed' ? 'Closed — both HR and the manager agreed' : 'You agreed to close — waiting for the manager to confirm'); renderVoicePage();
});

// ═════════════════════════════════════════════════════════
//  BASIC SALARY CHANGES — only after the board member approves
// ═════════════════════════════════════════════════════════
let SR_CUR = null; V.sal = [];
function currentBasic(empId, onDate){
  const rows = (S.fixed || []).filter(r => String(r.emp_id) === String(empId) && (elByCode(r.element_code) || {}).is_basic
    && r.effective_from <= onDate && (!r.effective_to || r.effective_to >= onDate)).sort((a,b) => String(b.effective_from).localeCompare(String(a.effective_from)));
  return rows.length ? num(rows[0].amount) : null;
}
function openSalaryRequest(empId, code, amount, from){
  const e = empById(empId); if (!e) return toast('Save the employee first','warn');
  SR_CUR = { empId, code };
  $('sr-who').innerHTML = `<b>${esc(empName(e))}</b> (${esc(empId)}) · ${esc((elByCode(code) || {}).name_en || 'Basic salary')}`;
  const f = from || todayISO(); $('sr-from').value = f;
  const cur = currentBasic(empId, f); $('sr-cur').value = cur == null ? '—' : fmt(cur);
  $('sr-new').value = amount || ''; $('sr-reason').value = '';
  openM('m-salreq');
}
$('sr-from').addEventListener('change', () => { if (SR_CUR){ const c = currentBasic(SR_CUR.empId, $('sr-from').value); $('sr-cur').value = c == null ? '—' : fmt(c); } });
$('sr-go').addEventListener('click', async () => {
  const amt = num($('sr-new').value), from = $('sr-from').value, reason = $('sr-reason').value.trim();
  if (!(amt > 0) || !from || !reason) return toast('Enter the new basic salary, the date and the reason','warn');
  const { data, error } = await sb.from('salary_change_requests').insert({ emp_id: SR_CUR.empId, element_code: SR_CUR.code, new_amount: amt, effective_from: from, reason }).select();
  if (error || !(data && data.length)) return toast(error ? error.message : NOPERM, 'err');
  closeM('m-salreq');
  const sf = data[0].effective_from;   // 85: whole pay cycles
  toast(sf !== from ? `Sent to the board member — salary changes apply to whole pay cycles, so it starts ${sf} once approved` : 'Sent to the board member for approval — the new basic salary applies once approved');
  renderSalaryPending(SR_CUR.empId);
});
async function renderSalaryPending(empId){
  const box = $('emp-sal-pending'); if (!box) return; box.innerHTML = '';
  if (!empId || !(ME && ['admin','hr','finance'].includes(ME.role))) return;
  const { data } = await sb.from('salary_change_requests').select('*').eq('emp_id', empId).order('created_at', { ascending:false }).limit(3);
  const w = (data || []).find(r => r.status === 'Waiting for board'), last = (data || []).find(r => r.status !== 'Waiting for board' && r.status !== 'Cancelled');
  box.innerHTML = (w ? `<div class="alert a-warn" style="margin:10px 0">💼 Basic salary change to <b>${fmt(w.new_amount)}</b> from ${esc(w.effective_from)} is <b>waiting for the board member's approval</b> (requested by ${esc(w.requested_by || '')}).</div>` : '')
    + (last && !w ? `<div style="font-size:12px;color:var(--muted);margin:8px 0">Last basic salary request: ${fmt(last.new_amount)} from ${esc(last.effective_from)} — ${esc(last.status)}${last.board_by ? ' by ' + esc(last.board_by) : ''}</div>` : '')
    + `<button class="btn btn-ghost btn-sm" style="margin:6px 0" data-sal-req="${esc(empId)}">💼 Request basic salary change</button>`;
}
document.addEventListener('click', e => { const b = e.target.closest('[data-sal-req]'); if (!b) return;
  const basic = (S.elements || []).find(x => x.is_basic && x.active !== false); openSalaryRequest(b.dataset.salReq, basic ? basic.code : null, null, null); });
const _openEmpSal = openEmp;
openEmp = function(id){ const r = _openEmpSal.apply(this, arguments); renderSalaryPending(id); return r; };
// list on the Employee voice page
const _loadVoiceSal = loadVoice;
loadVoice = async function(){ await _loadVoiceSal.apply(this, arguments); const r = await sb.from('salary_change_requests').select('*').order('created_at', { ascending:false }); V.sal = r.data || []; };
const _renderVoiceSal = renderVoicePage;
renderVoicePage = async function(){ await _renderVoiceSal.apply(this, arguments);
  $('vo-sal').innerHTML = V.sal.map(x => `<tr><td class="mono">${esc(vDate(x.created_at))}</td><td>${esc(x.emp_name ? `${x.emp_name} (${x.emp_id})` : vName(x.emp_id))}</td>
      <td class="num">${x.current_amount == null ? '—' : fmt(x.current_amount)}</td><td class="num strong">${fmt(x.new_amount)}</td><td class="mono">${esc(x.effective_from)}</td>
      <td style="white-space:normal;max-width:280px">${esc(x.reason)}</td><td>${esc(x.requested_by || '')}</td>
      <td style="white-space:normal;font-size:12px">${x.board_by ? esc(x.board_by) + (x.board_note ? ': ' + esc(x.board_note) : '') : ''}</td><td>${vChip(x.status)}</td>
      <td>${x.status === 'Waiting for board' ? `<button class="btn btn-ghost btn-sm" data-sal-cancel="${esc(x.id)}">Cancel</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="10" class="empty">No requests</td></tr>';
};
document.addEventListener('click', async e => { const b = e.target.closest('[data-sal-cancel]'); if (!b) return;
  const { error } = await sb.rpc('cancel_salary_change', { p_id: b.dataset.salCancel }); if (error) return toast(error.message, 'err');
  toast('Request cancelled'); renderVoicePage(); });

// ═════════════════════════════════════════════════════════
//  RESIGNATION · RE-EMPLOYMENT · EMPLOYMENT HISTORY · BLACKLIST (employee window)
// ═════════════════════════════════════════════════════════
const ff = k => document.querySelector(`#emp-form [data-f="${k}"]`);
// resignation date and Inactive go together
document.addEventListener('change', e => {
  const f = e.target.closest('#emp-form [data-f]'); if (!f) return;
  if (f.dataset.f === 'resignation_date' && f.value && ff('status') && ff('status').value !== 'Inactive'){
    ff('status').value = 'Inactive'; toast('Status set to Inactive — a resignation date always goes with Inactive');
  }
  if (f.dataset.f === 'status' && f.value === 'Inactive' && ff('resignation_date') && !ff('resignation_date').value){
    ff('resignation_date').focus(); toast('Enter the resignation date — it is required when making an employee Inactive', 'warn');
  }
});
const _saveEmpLife = saveEmp;
saveEmp = async function(){
  const st = ff('status'), rd = ff('resignation_date');
  if (st && rd){
    const e = editingEmp && empById(editingEmp);
    if (e && e.status === 'Inactive' && st.value === 'Active'){ st.value = 'Inactive'; return openRehire(e.id); }   // re-employment has its own window
    if (st.value === 'Inactive' && !rd.value){ rd.focus(); return toast('Enter the resignation date when making an employee Inactive','warn'); }
    if (rd.value && st.value !== 'Inactive') st.value = 'Inactive';
  }
  return _saveEmpLife.apply(this, arguments);
};
// the Save button was linked to the original function — link it to the checked one
$('emp-save').removeEventListener('click', _saveEmpLife);
$('emp-save').addEventListener('click', () => saveEmp());
let ML = null;
async function renderEmpLife(id){
  const box = $('emp-life'); if (!box) return; box.innerHTML = '';
  if (!id) return void (box.innerHTML = '<span style="color:var(--muted)">Save the employee first.</span>');
  const e = empById(id); if (!e) return;
  const { data } = await sb.from('employment_history').select('*').eq('emp_id', id).order('employment_date', { ascending:true });
  const rows = (data || []).map(h => `<tr><td class="mono">${esc(h.employment_date || '—')}</td><td class="mono">${esc(h.resignation_date || '—')}</td><td>${esc(h.job_name || '')}</td><td>${esc(h.department || '')}</td><td style="color:var(--muted);font-size:12px">${esc(h.note || '')}</td></tr>`);
  rows.push(`<tr style="background:var(--hover)"><td class="mono">${esc(e.employment_date || '—')}</td><td class="mono">${e.status === 'Inactive' ? esc(e.resignation_date || '—') : '<b>current</b>'}</td><td>${esc(e.job_name || '')}</td><td>${esc(e.department || '')}</td><td style="font-size:12px">${e.status === 'Inactive' ? 'Last period' : 'Current period'}</td></tr>`);
  const canHR = ME && ['admin','hr','hr_officer'].includes(ME.role), sup = !!(ME && ME.super_admin);
  box.innerHTML = (e.blacklisted ? `<div class="alert a-alarm" style="margin:6px 0 10px">⛔ <b>On the blacklist — cannot be re-employed.</b> ${esc(e.blacklist_reason || '')}${e.blacklisted_by ? ` <span style="color:var(--muted)">(${esc(e.blacklisted_by)}${e.blacklisted_at ? ', ' + esc(String(e.blacklisted_at).slice(0,10)) : ''})</span>` : ''}</div>` : '')
    + `<div class="tbl-wrap"><table><thead><tr><th>Employed from</th><th>Resigned on</th><th>Job</th><th>Department</th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`
    + `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">`
    + (canHR && e.status === 'Inactive' && !e.blacklisted ? `<button class="btn btn-primary btn-sm" data-life="rehire">↩ Re-employ under this code</button>` : '')
    + (canHR ? `<button class="btn btn-ghost btn-sm" data-life="past">＋ Add a past period</button>` : '')
    + (sup ? (e.blacklisted ? `<button class="btn btn-ghost btn-sm" data-life="unblack">Remove from blacklist</button>` : `<button class="btn btn-danger btn-sm" data-life="black">⛔ Add to blacklist</button>`) : '')
    + `</div>`;
}
function lifeModal(kind, title, info, fields){
  ML = { kind, id: editingEmp }; $('ml-title').textContent = title; $('ml-info').innerHTML = info;
  $('ml-fields').innerHTML = fields.map(([k, l, t, v]) => `<div class="field${t==='textarea' ? ' full' : ''}"><label>${l}</label>${t === 'textarea' ? `<textarea class="inp" id="ml-${k}" rows="3">${esc(v || '')}</textarea>` : `<input class="inp" id="ml-${k}" type="${t}" value="${esc(v || '')}">`}</div>`).join('');
  openM('m-life');
}
function openRehire(id){
  const e = empById(id); if (!e) return; editingEmp = id;
  lifeModal('rehire', '↩ Re-employ under the same code', `<b>${esc(empName(e))}</b> (${esc(id)}) left on <b>${esc(e.resignation_date || '—')}</b>. The previous period (${esc(e.employment_date || '—')} → ${esc(e.resignation_date || '—')}, ${esc(e.job_name || '')}) is saved to the employment history automatically.`,
    [['from','New employment date *','date',''], ['job','Job name','text', e.job_name], ['dept','Department','text', e.department]]);
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-life]'); if (!b) return; const emp = empById(editingEmp); if (!emp) return;
  const k = b.dataset.life;
  if (k === 'rehire') return openRehire(emp.id);
  if (k === 'past') return lifeModal('past', '＋ Add a past period', 'For an earlier period with Petrokima under this code (from the old files).', [['from','Employed from','date',''], ['to','Resigned on','date',''], ['job','Job name','text',''], ['dept','Department','text',''], ['note','Note','textarea','']]);
  if (k === 'black') return lifeModal('black', '⛔ Add to blacklist', `<b>${esc(empName(emp))}</b> (${esc(emp.id)}) will never be re-employed — not under this code and not under a new one with the same national ID.`, [['reason','Reason * (kept on his record)','textarea','']]);
  if (k === 'unblack') return lifeModal('unblack', 'Remove from blacklist', `Remove <b>${esc(empName(emp))}</b> (${esc(emp.id)}) from the blacklist? He could then be re-employed.`, []);
});
$('ml-go').addEventListener('click', async () => {
  if (!ML) return; const id = ML.id, v = k => ($('ml-' + k) ? $('ml-' + k).value.trim() : '');
  let res;
  if (ML.kind === 'rehire'){
    if (!v('from')) return toast('Enter the new employment date','warn');
    res = await sb.from('employees').update({ status:'Active', resignation_date:null, employment_date:v('from'), job_name:v('job') || null, department:v('dept') || null }).eq('id', id).select();
  } else if (ML.kind === 'past'){
    if (!v('from') && !v('to')) return toast('Enter at least one date','warn');
    res = await sb.from('employment_history').insert({ emp_id:id, employment_date:v('from') || null, resignation_date:v('to') || null, job_name:v('job') || null, department:v('dept') || null, note:v('note') || 'Added by hand', recorded_by:(ME && (ME.full_name || ME.email)) || 'HR' }).select();
  } else if (ML.kind === 'black'){
    if (!v('reason')) return toast('Write the reason','warn');
    res = await sb.from('employees').update({ blacklisted:true, blacklist_reason:v('reason') }).eq('id', id).select();
  } else {
    res = await sb.from('employees').update({ blacklisted:false }).eq('id', id).select();
  }
  if (res.error || !(res.data && res.data.length)) return toast(res.error ? res.error.message : NOPERM, 'err');
  if (ML.kind !== 'past'){ const i = S.employees.findIndex(x => String(x.id) === String(id)); if (i >= 0) S.employees[i] = { ...S.employees[i], ...res.data[0] }; }
  closeM('m-life');
  toast({ rehire:'Re-employed under the same code — the previous period is in his employment history', past:'Past period added', black:'Added to the blacklist', unblack:'Removed from the blacklist' }[ML.kind]);
  if (ML.kind === 'rehire' || ML.kind === 'black' || ML.kind === 'unblack'){ openEmp(id); if (typeof renderEmployees === 'function') renderEmployees(); } else renderEmpLife(id);
});
const _openEmpLife = openEmp;
openEmp = function(id){ const r = _openEmpLife.apply(this, arguments); renderEmpLife(id); return r; };

// ═════════════════════════════════════════════════════════
//  TWO-STEP SIGN-IN (TOTP) + AUDIT LOG   — database: 40-two-step-audit-tidyup.sql
// ═════════════════════════════════════════════════════════
const STAFF_ROLES = ['admin','hr','hr_officer'];
let SEC = { require_staff_mfa:false, enrolled:false, aal:'aal1', ready:false };

// the two two-step windows must not close by clicking beside them or pressing Esc
document.addEventListener('click', e => { if (e.target && (e.target.id === 'm-code' || e.target.id === 'm-2fa')) e.stopImmediatePropagation(); }, true);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && ($('m-code').classList.contains('open') || $('m-2fa').classList.contains('open'))) e.stopImmediatePropagation(); }, true);

async function loadSecurity(){
  try {
    const { data, error } = await sb.rpc('my_security_status');
    if (error) throw error;
    SEC = { ...data, ready:true };
  } catch (e) { SEC = { require_staff_mfa:false, enrolled:false, aal:'aal1', ready:false }; }   // database update 40 not run yet
  return SEC;
}
async function verifiedFactor(){
  const { data, error } = await sb.auth.mfa.listFactors();
  if (error) throw error;
  return ((data && data.totp) || []).find(f => f.status === 'verified') || null;
}
async function currentAal(){
  const { data } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
  return data || { currentLevel:'aal1', nextLevel:'aal1' };
}

// ── ask for the 6-digit code (resolves true when the session is upgraded) ──
function askCode(opts = {}){
  return new Promise(resolve => {
    $('code-title').textContent = opts.title || 'Enter your 6-digit code';
    $('code-cancel').textContent = opts.cancelText || 'Sign out';
    $('code-in').value = ''; $('code-err').style.display = 'none';
    openM('m-code'); setTimeout(() => $('code-in').focus(), 50);
    const done = ok => { closeM('m-code'); $('code-ok').onclick = $('code-cancel').onclick = $('code-in').onkeydown = null; resolve(ok); };
    const go = async () => {
      const code = $('code-in').value.replace(/\D/g, '');
      if (code.length !== 6){ $('code-err').textContent = 'Type the 6 digits shown in your authenticator app.'; $('code-err').style.display = 'block'; return; }
      $('code-ok').disabled = true; $('code-ok').textContent = 'Checking…';
      try {
        const f = await verifiedFactor(); if (!f) throw new Error('No authenticator is set up for this account.');
        const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: f.id, code });
        if (error) throw error;
        done(true);
      } catch (e) {
        $('code-err').textContent = /invalid|expired|code/i.test(e.message || '') ? 'Wrong or expired code — wait for the next code in the app and try again.' : (e.message || String(e));
        $('code-err').style.display = 'block'; $('code-in').value = ''; $('code-in').focus();
      } finally { $('code-ok').disabled = false; $('code-ok').textContent = 'Continue'; }
    };
    $('code-ok').onclick = go;
    $('code-in').onkeydown = e => { if (e.key === 'Enter') go(); };
    $('code-cancel').onclick = () => done(false);
  });
}

// ── set up an authenticator (resolves true when verified) ──
let tfaPending = null;
function setupTwoStep(opts = {}){
  return new Promise(async resolve => {
    $('tfa-err').style.display = 'none'; $('tfa-code').value = ''; $('tfa-qr').removeAttribute('src'); $('tfa-secret').textContent = '…';
    $('tfa-cancel').textContent = opts.forced ? 'Sign out' : 'Cancel';
    $('tfa-x').style.display = opts.forced ? 'none' : '';
    openM('m-2fa');
    const fail = m => { $('tfa-err').innerHTML = m; $('tfa-err').style.display = 'block'; };
    const finish = ok => { closeM('m-2fa'); $('tfa-confirm').onclick = $('tfa-cancel').onclick = $('tfa-x').onclick = $('tfa-code').onkeydown = null; resolve(ok); };
    const cancel = async () => {
      if (tfaPending) { try { await sb.auth.mfa.unenroll({ factorId: tfaPending }); } catch (e) {} tfaPending = null; }
      finish(false);
    };
    $('tfa-cancel').onclick = cancel; $('tfa-x').onclick = cancel;
    try {
      // remove half-finished set-ups from earlier attempts
      const { data: fl } = await sb.auth.mfa.listFactors();
      for (const f of ((fl && fl.all) || []).filter(f => f.status !== 'verified')) { try { await sb.auth.mfa.unenroll({ factorId: f.id }); } catch (e) {} }
      const { data, error } = await sb.auth.mfa.enroll({ factorType:'totp', issuer:'Petrokima HR', friendlyName:'Petrokima HR ' + new Date().toISOString().slice(0,16) });
      if (error) throw error;
      tfaPending = data.id;
      $('tfa-qr').src = data.totp.qr_code;
      $('tfa-secret').textContent = (data.totp.secret || '').replace(/(.{4})/g, '$1 ').trim();
      setTimeout(() => $('tfa-code').focus(), 50);
    } catch (e) {
      return fail(/disabled|not enabled/i.test(e.message || '')
        ? 'Two-step sign-in is switched off in the database settings. Please ask the administrator to turn it on.'
        : esc(e.message || String(e)));
    }
    const go = async () => {
      const code = $('tfa-code').value.replace(/\D/g, '');
      if (code.length !== 6) return fail('Type the 6 digits shown in the app.');
      $('tfa-confirm').disabled = true; $('tfa-confirm').textContent = 'Checking…';
      const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: tfaPending, code });
      $('tfa-confirm').disabled = false; $('tfa-confirm').textContent = 'Confirm';
      if (error) { $('tfa-code').value = ''; return fail('That code did not match — wait for the next code in the app and try again.'); }
      tfaPending = null; toast('Two-step sign-in is set up ✔'); finish(true);
    };
    $('tfa-confirm').onclick = go;
    $('tfa-code').onkeydown = e => { if (e.key === 'Enter') go(); };
  });
}

// ── called by afterLogin for Admin / HR / HR Officer. true = carry on, false = stop (a window took over) ──
async function mfaGate(me, user){
  let lvl;
  try { lvl = await currentAal(); } catch (e) { return true; }
  if (lvl.currentLevel === 'aal2') { await loadSecurity(); return true; }
  if (lvl.nextLevel === 'aal2') {                       // has an authenticator → always ask for the code
    const ok = await askCode();
    if (!ok) { signOut(); return false; }
    await loadSecurity(); return true;
  }
  await loadSecurity();
  if (SEC.require_staff_mfa) {                          // required but not set up yet → must set it up now
    const ok = await setupTwoStep({ forced:true });
    if (!ok) { signOut(); return false; }
    await loadSecurity(); return true;
  }
  if (SEC.ready) setTimeout(() => toast('Protect your account: set up two-step sign-in (Users & roles → 📱, or ask the administrator).', 'warn'), 1500);
  return true;
}

// after re-typing the password (payslips), a staff session must enter the code again
async function mfaAfterReauth(){
  try {
    const lvl = await currentAal();
    if (lvl.currentLevel === 'aal1' && lvl.nextLevel === 'aal2') return await askCode({ title:'Enter your 6-digit code', cancelText:'Cancel' });
  } catch (e) {}
  return true;
}

// ── Users & roles: the two-step card and the 2-step column ──
let MFA_USERS = {};
async function loadTwoStepAdmin(){
  await loadSecurity();
  const st = $('tfa-status');
  if (!SEC.ready) { st.innerHTML = '<span class="chip c-orange">not available yet</span> The database update <b>40-two-step-audit-tidyup.sql</b> has not been run.'; ['tfa-setup-me','tfa-on','tfa-off'].forEach(id => $(id).style.display = 'none'); return; }
  const r = await sb.rpc('admin_mfa_status');
  MFA_USERS = Object.fromEntries(((r && r.data) || []).map(x => [x.user_id, x]));
  const staff = USERS.filter(u => STAFF_ROLES.includes(u.role) && u.active);
  const missing = staff.filter(u => !MFA_USERS[u.id]);
  st.innerHTML = (SEC.require_staff_mfa
      ? '<span class="chip c-green">REQUIRED</span> Staff accounts get their staff powers only after the 6-digit code. '
      : '<span class="chip c-orange">not required yet</span> Staff can set it up now; switch the requirement on when everyone is ready. ')
    + `<br><b>${staff.length - missing.length} of ${staff.length}</b> active staff accounts have set it up.`
    + (missing.length ? ` Still to set up: ${missing.map(u => esc(u.full_name || u.email)).join(', ')}.` : ' ✔ Everyone is ready.')
    + (SEC.enrolled ? '<br>Your own account: <b>set up ✔</b>' + (SEC.aal === 'aal2' ? ' and signed in with the code.' : ' — sign out and in again with the code.') : '<br>Your own account: <b>not set up yet</b>.');
  $('tfa-setup-me').style.display = SEC.enrolled ? 'none' : '';
  $('tfa-on').style.display  = SEC.require_staff_mfa ? 'none' : '';
  $('tfa-off').style.display = SEC.require_staff_mfa ? '' : 'none';
  renderUsers();
}
function twoStepCell(u){
  if (!STAFF_ROLES.includes(u.role)) return '<span style="color:var(--muted)">—</span>';
  if (!SEC.ready) return '';
  return MFA_USERS[u.id] ? `<span class="chip c-green">on</span>${u.id !== ME.id ? ` <button class="btn btn-ghost btn-sm" data-u-mfa title="Lost phone: remove the authenticator so they can set it up again">Reset</button>` : ''}`
                         : '<span class="chip c-orange">not set up</span>';
}
$('tfa-setup-me').addEventListener('click', async () => {
  if (await setupTwoStep()) { toast('Done — next time you sign in, type the code after your password'); loadTwoStepAdmin(); }
});
$('tfa-on').addEventListener('click', () => {
  if (!SEC.enrolled) return toast('First set up your own two-step sign-in (📱 button), sign out and sign in again with the code', 'warn');
  if (SEC.aal !== 'aal2') return toast('Sign out and sign in again with your 6-digit code first', 'warn');
  const staff = USERS.filter(u => STAFF_ROLES.includes(u.role) && u.active), missing = staff.filter(u => !MFA_USERS[u.id]);
  confirmDel(`Require two-step sign-in for all Admin, HR and HR Officer accounts?` + (missing.length
      ? ` ${missing.length} of them (${missing.map(u => u.full_name || u.email).join(', ')}) have not set it up — they will be asked to scan the QR code at their next sign-in.` : ''),
    async () => { const { error } = await sb.rpc('set_require_staff_mfa', { p_on:true }); if (error) throw error; toast('Two-step sign-in is now REQUIRED for staff'); loadTwoStepAdmin(); });
  $('del-title').textContent = 'Please confirm'; $('del-ok').textContent = 'Require it'; $('del-ok').className = 'btn btn-success';
});
$('tfa-off').addEventListener('click', () => {
  confirmDel('Switch the two-step requirement OFF? Staff accounts will again get their powers with the password alone. Only do this in an emergency.',
    async () => { const { error } = await sb.rpc('set_require_staff_mfa', { p_on:false }); if (error) throw error; toast('Requirement switched off', 'warn'); loadTwoStepAdmin(); });
  $('del-title').textContent = 'Please confirm'; $('del-ok').textContent = 'Switch off'; $('del-ok').className = 'btn btn-danger';
});
$('us-tbl').addEventListener('click', e => {
  const b = e.target.closest('[data-u-mfa]'); if (!b) return;
  const u = USERS.find(x => x.id === b.closest('tr').dataset.uid); if (!u) return;
  confirmDel(`Reset two-step sign-in for ${u.full_name || u.email}? Use this when they lost or changed their phone. At their next sign-in they scan a new QR code.`,
    async () => { const { error } = await sb.rpc('admin_reset_mfa', { p_user:u.id }); if (error) throw error; toast('Two-step sign-in reset'); loadTwoStepAdmin(); });
  $('del-title').textContent = 'Please confirm'; $('del-ok').textContent = 'Reset'; $('del-ok').className = 'btn btn-danger';
});

// ═════════════════════════════════════════════════════════
//  AUDIT LOG (admin only)
// ═════════════════════════════════════════════════════════
const AUDIT_AREAS = {
  employees:'Employees', employee_salary_elements:'Fixed package (salary elements)', salary_elements:'Salary element list', app_users:'Logins & roles',
  payroll_period_elements:'Monthly entries', payroll_runs:'Payroll approval', salary_change_requests:'Basic salary requests', manager_actions:'Manager penalty / incentive requests',
  employee_loans:'Loans', employee_penalties:'Penalties', employment_history:'Employment history', project_allowance_rules:'Project allowance rules',
  public_holidays:'Public holidays', settings:'Settings', attendance:'Attendance (staff edits)', employee_leaves:'Vacations (staff edits)',
  attendance_permissions:'Permissions (staff edits)', two_step_sign_in:'Two-step sign-in' };
const AUDIT_ACT = { INSERT:['Added','c-green'], UPDATE:['Changed','c-blue'], DELETE:['Deleted','c-red'] };
let AUDIT = [];
(function initAuditFilters(){
  const ymd = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const t = new Date(), f = new Date(); f.setDate(f.getDate() - 30);
  $('au-from').value = ymd(f); $('au-to').value = ymd(t);
  $('au-tbl').innerHTML = '<tr><td colspan="7" class="empty">Click ⟳ Refresh</td></tr>';
  $('au-area').innerHTML = '<option value="">All areas</option>' + Object.entries(AUDIT_AREAS).map(([k,v]) => `<option value="${k}">${esc(v)}</option>`).join('');
})();
function auditVal(v){
  if (v === null || v === undefined || v === '') return '<span style="color:var(--muted)">(empty)</span>';
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (s.length > 80) s = s.slice(0, 77) + '…';
  return esc(s);
}
function auditWhat(a){
  if (a.action === 'UPDATE' && a.changed) return a.changed.map(c => `<div><b>${esc(c.replace(/_/g,' '))}</b>: ${auditVal((a.old_data||{})[c])} → ${auditVal((a.new_data||{})[c])}</div>`).join('');
  const d = a.action === 'DELETE' ? a.old_data : a.new_data; if (!d) return '';
  const keys = ['name_en','name_ar','full_name','role','element_code','element_name','amount','new_amount','installment','loan_amount','penalty_type','quantity','status','date','name','user','factors_removed'].filter(k => d[k] !== undefined && d[k] !== null && d[k] !== '');
  return keys.slice(0,5).map(k => `<span style="margin-right:10px"><b>${esc(k.replace(/_/g,' '))}</b>: ${auditVal(d[k])}</span>`).join('');
}
async function loadAudit(){
  if (!ME || ME.role !== 'admin') return;
  const from = $('au-from').value, to = $('au-to').value;
  $('au-tbl').innerHTML = '<tr><td colspan="7" class="empty">Loading…</td></tr>';
  let q = sb.from('audit_log').select('*').order('at', { ascending:false }).limit(2000);
  // dates are the viewer's own calendar days (Cairo time on company PCs)
  if (from) q = q.gte('at', new Date(from + 'T00:00:00').toISOString());
  if (to) { const d = new Date(to + 'T00:00:00'); d.setDate(d.getDate() + 1); q = q.lt('at', d.toISOString()); }
  const area = $('au-area').value; if (area) q = q.eq('tbl', area);
  if ($('au-act').value) q = q.eq('action', $('au-act').value);
  if ($('au-emp').value.trim()) q = q.eq('emp_id', $('au-emp').value.trim());
  const { data, error } = await q;
  if (error) { AUDIT = []; $('au-count').textContent = 'Changes';
    $('au-tbl').innerHTML = `<tr><td colspan="7" class="empty">${/audit_log/.test(error.message) ? 'The audit log is not available yet — run database update 40-two-step-audit-tidyup.sql' : esc(error.message)}</td></tr>`; return; }
  AUDIT = data || []; renderAudit();
}
function renderAudit(){
  const qq = $('au-q').value.trim().toLowerCase();
  const list = AUDIT.filter(a => !qq || [a.user_name, a.user_role, a.row_key, a.emp_id, (a.changed||[]).join(' '), JSON.stringify(a.old_data||''), JSON.stringify(a.new_data||'')].join(' ').toLowerCase().includes(qq));
  $('au-count').textContent = `${list.length.toLocaleString()} change${list.length === 1 ? '' : 's'}${AUDIT.length >= 2000 ? ' (first 2,000 — narrow the dates)' : ''}`;
  $('au-tbl').innerHTML = list.map(a => { const [lbl, cls] = AUDIT_ACT[a.action] || [a.action, 'c-blue'];
    const e = a.emp_id ? empById(a.emp_id) : null;
    return `<tr><td class="mono" style="white-space:nowrap">${esc(new Date(a.at).toLocaleString('en-GB', { timeZone:'Africa/Cairo', day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' }))}</td>
      <td>${esc(a.user_name || '')}${a.user_role ? ` <span class="chip c-blue">${esc(ROLE_LABEL[a.user_role] || a.user_role)}</span>` : ''}${a.aal === 'aal2' ? ' <span title="signed in with the 6-digit code">🔐</span>' : ''}</td>
      <td>${esc(AUDIT_AREAS[a.tbl] || a.tbl)}</td><td><span class="chip ${cls}">${lbl}</span></td>
      <td class="mono">${esc(a.tbl === 'app_users' || a.tbl === 'two_step_sign_in' || /^[0-9a-f-]{36}$/.test(a.row_key || '') ? '' : (a.row_key || ''))}</td>
      <td>${a.emp_id ? esc(a.emp_id + (e ? ' — ' + empName(e) : '')) : ''}</td>
      <td style="font-size:12px;line-height:1.6;max-width:520px">${auditWhat(a)}</td></tr>`; }).join('')
    || '<tr><td colspan="7" class="empty">No changes recorded for these filters</td></tr>';
}
$('au-load').addEventListener('click', loadAudit);
['au-from','au-to','au-act'].forEach(id => $(id).addEventListener('change', loadAudit));
$('au-area').addEventListener('change', loadAudit);
$('au-emp').addEventListener('change', loadAudit);
$('au-q').addEventListener('input', renderAudit);
document.querySelector('[data-page="audit"]').addEventListener('click', loadAudit);
document.querySelector('[data-page="users"]').addEventListener('click', () => setTimeout(loadTwoStepAdmin, 400));
$('us-refresh').addEventListener('click', () => setTimeout(loadTwoStepAdmin, 400));

// ═════════════════════════════════════════════════════════
//  LOCATION CHECKS — site boundaries, fake GPS, suspicious check-ins   (database: 41-location-integrity.sql)
// ═════════════════════════════════════════════════════════
const LOC_FLAG = {
  outside_site:     ['Outside the site', 'c-orange'],
  outside_office:   ['Away from his office', 'c-orange'],
  fake_gps:         ['Fake-location app', 'c-red'],
  same_point:       ['Same exact point as another day', 'c-orange'],
  perfect_accuracy: ['"Perfect" GPS accuracy', 'c-orange'],
  impossible_travel:['Impossible travel speed', 'c-red'],
  browser_android:  ['Browser instead of app', 'c-blue'],
  old_app:          ['Old app version', 'c-blue'],
  no_site_point:    ['Project has no map point', 'c-orange'],
  gps_unchecked:    ['Fake-GPS check not done', 'c-blue'],
  away_allowed:     ['Away — allowed', 'c-blue'],
  clock_changed:    ['Phone clock was changed', 'c-red'],
  phone_restarted:  ['Phone restarted offline — time not verified', 'c-orange'] };
let LOC_RULES = { outside:'flag', default_radius:300, block_mock:true, android_app_only:false };
let WORK_LOCS = [], wlMissing = false;
const fmtDist = m => m == null ? '' : (m >= 1000 ? (m/1000).toFixed(1) + ' km' : Math.round(m) + ' m');
const locFlagged = () => S.clocks.filter(c => (Array.isArray(c.location_flags) && c.location_flags.length) || (c.applied === false && c.mock_location));

async function loadLocationData(){
  const [r, w] = await Promise.all([
    sb.from('settings').select('value').eq('key','location_rules'),
    sb.from('work_locations').select('*').order('name') ]);
  if (r.data && r.data[0] && r.data[0].value) LOC_RULES = { ...LOC_RULES, ...r.data[0].value };
  await loadOfficeEmps();
  wlMissing = !!w.error; WORK_LOCS = w.data || [];
}
function renderLocations(){
  $('lr-outside').value = LOC_RULES.outside || 'flag';
  $('lr-radius').value = num(LOC_RULES.default_radius) || 300;
  $('lr-apponly').checked = !!LOC_RULES.android_app_only;
  $('lr-anywhere').checked = LOC_RULES.unassigned_anywhere !== false;   // 91: default on
  $('lr-minbuild').value = num(LOC_RULES.min_android_build) || 0;
  $('lr-note').textContent = wlMissing ? 'Database update 41-location-integrity.sql has not been run yet — these checks are not active.' : '';
  renderLocWarnings(); renderSites(); renderOffices();
}
PAGE_RENDER.locations = () => { loadLocationData().then(renderLocations, renderLocations); };

// ── warnings ──
function renderLocWarnings(){
  const kind = $('lw-kind').value, q = $('lw-q').value.trim().toLowerCase();
  const list = locFlagged().filter(c => {
    const fl = c.location_flags || [];
    if (kind === 'held' ? c.applied !== false : kind && !fl.includes(kind)) return false;
    if (!q) return true; const e = empById(c.emp_id) || {};
    return [c.emp_id, empName(e), c.project_code, projName(c.project_code)].some(v => String(v||'').toLowerCase().includes(q));
  }).sort((a,b) => String(b.at).localeCompare(String(a.at)));
  $('lw-count').textContent = `${list.length} check-in${list.length===1?'':'s'} with location warnings`;
  $('lw-tbl').innerHTML = list.slice(0, 500).map(c => { const e = empById(c.emp_id) || {}, u = mapUrl(c);
    return `<tr><td class="mono">${esc(c.local_date||'')}</td><td class="mono">${esc(c.local_time||'')}</td>
      <td><span class="mono">${esc(c.emp_id)}</span> ${esc(empName(e))}</td><td>${c.event_type==='in'?'Check in':'Check out'}</td>
      <td>${c.project_code ? `<span class="mono">${esc(c.project_code)}</span> ${esc(projName(c.project_code))}` : '<span style="color:var(--muted)">no project</span>'}</td>
      <td class="num">${c.distance_m != null ? esc(fmtDist(c.distance_m)) + (c.site_radius_m ? `<div style="font-size:11px;color:var(--muted)">allowed ${c.site_radius_m} m</div>` : '') : ''}</td>
      <td>${(c.location_flags||[]).map(f => `<span class="chip ${(LOC_FLAG[f]||[])[1]||'c-blue'}" style="margin:1px">${esc((LOC_FLAG[f]||[f])[0])}</span>`).join(' ')}${c.accuracy!=null?`<div style="font-size:11px;color:var(--muted)">GPS accuracy ${c.accuracy} m</div>`:''}</td>
      <td>${c.applied === false ? `<span class="chip c-red">kept for review</span><div style="font-size:11px;color:var(--muted)">${esc(c.review_note||'')}</div>` : '<span class="chip c-green">counted</span>'}</td>
      <td>${u ? `<a href="${u}" target="_blank" rel="noopener">map ↗</a>` : ''}</td>
      <td>${c.project_code && c.lat != null ? `<button class="btn btn-ghost btn-sm" data-loc-pin="${esc(c.id)}" title="Make this check-in's point the site's map point">📌 Set as site point</button>` : ''}</td></tr>`; }).join('')
    || '<tr><td colspan="10" class="empty">No location warnings in this period</td></tr>';
}
$('lw-kind').addEventListener('change', renderLocWarnings);
$('lw-q').addEventListener('input', renderLocWarnings);
$('lw-tbl').addEventListener('click', e => { const b = e.target.closest('[data-loc-pin]'); if (!b) return;
  const c = S.clocks.find(x => String(x.id) === b.dataset.locPin); if (!c) return;
  confirmDel(`Use this check-in (${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}) as the map point of site ${c.project_code} — ${projName(c.project_code)}? Only do this if you are sure the employee was really at the site.`,
    async () => { await saveSite(c.project_code, c.lat, c.lng, null); toast('Site map point saved'); renderSites(); });
  $('del-title').textContent = 'Please confirm'; $('del-ok').textContent = 'Use this point'; $('del-ok').className = 'btn btn-primary';
});

// ── sites ──
function parseLatLng(txt){
  const s = String(txt || ''), m = s.match(/(-?\d{1,2}\.\d+)\s*[, ]\s*(-?\d{1,3}\.\d+)/);       // "30.0444, 31.2357" or a Maps link with @30.04,31.23
  return m ? { lat: Number(m[1]), lng: Number(m[2]) } : null;
}
const validLatLng = (a, b) => isFinite(a) && isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180 && !(a === 0 && b === 0);
async function saveSite(code, lat, lng, radius){
  const row = { site_lat: lat, site_lng: lng }; if (radius !== null) row.site_radius_m = radius;
  const { data, error } = await sb.from('projects').update(row).eq('id', code).select('id');
  if (error) throw error; if (!(data && data.length)) throw new Error(NOPERM);
  const p = S.projects.find(x => String(x.id) === String(code)); if (p) Object.assign(p, row);
}
function renderSites(){
  const show = $('ls-show').value, q = $('ls-q').value.trim().toLowerCase();
  const used = {}; S.clocks.forEach(c => { if (c.project_code) used[c.project_code] = (used[c.project_code] || 0) + 1; });
  (S.empProjects || []).forEach(a => { if (!(a.project_code in used)) used[a.project_code] = 0; });
  let list = S.projects.filter(p => {
    const has = p.site_lat != null && p.site_lng != null, u = String(p.id) in used;
    if (show === 'used' && !u) return false; if (show === 'mapped' && !has) return false; if (show === 'missing' && (!u || has)) return false;
    return !q || String(p.id).toLowerCase().includes(q) || String(p.name||'').toLowerCase().includes(q);
  }).sort((a,b) => (used[b.id]||0) - (used[a.id]||0) || String(a.id).localeCompare(String(b.id)));
  const mapped = S.projects.filter(p => p.site_lat != null).length;
  $('ls-count').textContent = `Site locations — ${mapped} site${mapped===1?'':'s'} mapped · showing ${Math.min(list.length,300)}${list.length>300?' of '+list.length:''}`;
  $('ls-tbl').innerHTML = list.slice(0,300).map(p => `<tr data-site="${esc(p.id)}">
      <td class="mono">${esc(p.id)}</td><td>${esc(p.name||'')}${p.site_set_by && p.site_lat != null ? `<div style="font-size:11px;color:var(--muted)">${p.site_set_how === 'phone' ? '📱' : '🖥'} set by ${esc(p.site_set_by)} · ${esc(dmyShow(String(p.site_set_at || '').slice(0, 10)))}</div>` : ''}</td>
      <td><input class="inp" style="width:150px" data-s="lat" value="${p.site_lat != null ? esc(p.site_lat) : ''}" placeholder="paste lat, lng"></td>
      <td><input class="inp" style="width:120px" data-s="lng" value="${p.site_lng != null ? esc(p.site_lng) : ''}"></td>
      <td><input class="inp" style="width:80px" type="number" min="50" max="5000" step="50" data-s="rad" value="${p.site_radius_m != null ? p.site_radius_m : ''}" placeholder="${num(LOC_RULES.default_radius)||300}"></td>
      <td class="num">${used[p.id] || ''}</td>
      <td style="white-space:nowrap"><button class="btn btn-primary btn-sm" data-s-save>Save</button>${p.site_lat != null ? ` <a class="btn btn-ghost btn-sm" href="https://www.google.com/maps?q=${p.site_lat},${p.site_lng}" target="_blank" rel="noopener">map ↗</a> <button class="btn btn-ghost btn-sm" data-s-clear title="Remove the map point (site no longer checked)">✕</button>` : ''}</td></tr>`).join('')
    || '<tr><td colspan="7" class="empty">No sites match</td></tr>';
}
$('ls-show').addEventListener('change', renderSites);
$('ls-q').addEventListener('input', renderSites);
$('ls-tbl').addEventListener('input', e => {         // pasting "30.04, 31.23" into Latitude fills both boxes
  const i = e.target.closest('[data-s="lat"]'); if (!i || !/[ ,]/.test(i.value.trim())) return;
  const ll = parseLatLng(i.value); if (!ll) return;
  i.value = ll.lat; i.closest('tr').querySelector('[data-s="lng"]').value = ll.lng;
});
$('ls-tbl').addEventListener('click', async e => {
  const tr = e.target.closest('tr[data-site]'); if (!tr) return; const code = tr.dataset.site;
  if (e.target.closest('[data-s-clear]')) {
    try { const { data, error } = await sb.from('projects').update({ site_lat:null, site_lng:null, site_radius_m:null }).eq('id', code).select('id');
      if (error) throw error; if (!(data && data.length)) throw new Error(NOPERM);
      const p = S.projects.find(x => String(x.id) === code); if (p) Object.assign(p, { site_lat:null, site_lng:null, site_radius_m:null });
      toast('Map point removed — this site is no longer checked'); renderSites(); } catch (err) { toast(err.message, 'err'); }
    return;
  }
  if (!e.target.closest('[data-s-save]')) return;
  let lat = tr.querySelector('[data-s="lat"]').value.trim(), lng = tr.querySelector('[data-s="lng"]').value.trim();
  const ll = parseLatLng(lat + (lng ? ',' + lng : '')); if (ll) { lat = ll.lat; lng = ll.lng; } else { lat = Number(lat); lng = Number(lng); }
  const radTxt = tr.querySelector('[data-s="rad"]').value.trim(), rad = radTxt === '' ? null : Math.round(Number(radTxt));
  if (!validLatLng(lat, lng)) return toast('Enter a valid latitude and longitude (e.g. 30.04442 and 31.23571)', 'warn');
  if (rad !== null && !(rad >= 50 && rad <= 5000)) return toast('Radius must be between 50 and 5,000 metres', 'warn');
  try { await saveSite(code, lat, lng, rad); toast(`Site ${code} saved`); renderSites(); } catch (err) { toast(err.message, 'err'); }
});
$('ls-bulk-save').addEventListener('click', async () => {
  const lines = $('ls-bulk').value.split(/\r?\n/).map(l => l.trim()).filter(Boolean), bad = []; let ok = 0;
  $('ls-bulk-save').disabled = true;
  for (const l of lines){
    const parts = l.split(/[\t,;]+/).map(x => x.trim()).filter(x => x !== '');
    const code = parts[0], lat = Number(parts[1]), lng = Number(parts[2]), rad = parts[3] ? Math.round(Number(parts[3])) : null;
    if (!code || !S.projects.some(p => String(p.id) === code)) { bad.push(`${code || l}: unknown site code`); continue; }
    if (!validLatLng(lat, lng)) { bad.push(`${code}: latitude/longitude not valid`); continue; }
    if (rad !== null && !(rad >= 50 && rad <= 5000)) { bad.push(`${code}: radius must be 50–5,000 m`); continue; }
    try { await saveSite(code, lat, lng, rad); ok++; } catch (err) { bad.push(`${code}: ${err.message}`); }
  }
  $('ls-bulk-save').disabled = false;
  $('ls-bulk-note').innerHTML = `<b>${ok}</b> saved` + (bad.length ? ` · <span style="color:var(--red)">${bad.length} not saved: ${esc(bad.slice(0,8).join(' · '))}${bad.length>8?' …':''}</span>` : '');
  if (ok && !bad.length) $('ls-bulk').value = '';
  renderSites();
});

// ── offices ──
function renderOffices(){
  $('wl-tbl').innerHTML = wlMissing ? '<tr><td colspan="6" class="empty">Run database update 41-location-integrity.sql first</td></tr>'
    : WORK_LOCS.map(w => `<tr data-wl="${esc(w.id)}">
      <td><input class="inp" style="width:200px" data-w="name" value="${esc(w.name)}"></td>
      <td><input class="inp" style="width:150px" data-w="lat" value="${esc(w.lat)}"></td>
      <td><input class="inp" style="width:120px" data-w="lng" value="${esc(w.lng)}"></td>
      <td><input class="inp" style="width:80px" type="number" min="50" max="5000" step="50" data-w="rad" value="${w.radius_m}"></td>
      <td><input type="checkbox" data-w="active" ${w.active ? 'checked' : ''}></td>
      <td>${w.id === 'new' ? '' : `<button class="btn btn-ghost btn-sm" data-w-emps title="Employees who check in and out at this office">👥 ${(n => n + (n === 1 ? ' employee' : ' employees'))(OFFICE_EMPS.filter(x => x.location_id === w.id).length)}</button>`}</td>
      <td style="white-space:nowrap"><button class="btn btn-primary btn-sm" data-w-save>Save</button> <a class="btn btn-ghost btn-sm" href="https://www.google.com/maps?q=${w.lat},${w.lng}" target="_blank" rel="noopener">map ↗</a> <button class="btn btn-ghost btn-sm" data-w-del>Delete</button></td></tr>`).join('')
    || '<tr><td colspan="7" class="empty">No offices yet — click + Add office</td></tr>';
}
$('wl-tbl').addEventListener('input', e => {
  const i = e.target.closest('[data-w="lat"]'); if (!i || !/[ ,]/.test(i.value.trim())) return;
  const ll = parseLatLng(i.value); if (!ll) return; i.value = ll.lat; i.closest('tr').querySelector('[data-w="lng"]').value = ll.lng;
});
$('wl-tbl').addEventListener('click', async e => {
  const tr = e.target.closest('tr[data-wl]'); if (!tr) return; const id = tr.dataset.wl;
  if (e.target.closest('[data-w-del]')) {
    confirmDel('Delete this office? Check-ins without a project will no longer be compared with it.', async () => {
      const { data, error } = await sb.from('work_locations').delete().eq('id', id).select('id'); if (error) throw error; if (!(data && data.length)) throw new Error(NOPERM);
      WORK_LOCS = WORK_LOCS.filter(w => w.id !== id); renderOffices(); toast('Office deleted'); });
    return;
  }
  if (e.target.closest('[data-w-emps]')) return openOfficeEmps(id);
  if (!e.target.closest('[data-w-save]')) return;
  const g = k => tr.querySelector(`[data-w="${k}"]`);
  const row = { name: g('name').value.trim(), lat: Number(g('lat').value), lng: Number(g('lng').value), radius_m: Math.round(Number(g('rad').value)), active: g('active').checked };
  if (!row.name) return toast('Give the office a name', 'warn');
  if (!validLatLng(row.lat, row.lng)) return toast('Enter a valid latitude and longitude', 'warn');
  if (!(row.radius_m >= 50 && row.radius_m <= 5000)) return toast('Radius must be between 50 and 5,000 metres', 'warn');
  const q = id === 'new' ? sb.from('work_locations').insert(row).select() : sb.from('work_locations').update(row).eq('id', id).select();
  const { data, error } = await q; if (error) return toast(error.message, 'err'); if (!(data && data.length)) return toast(NOPERM, 'err');
  if (id === 'new') WORK_LOCS = WORK_LOCS.filter(w => w.id !== 'new').concat(data); else WORK_LOCS = WORK_LOCS.map(w => w.id === id ? data[0] : w);
  renderOffices(); toast('Office saved');
});
$('wl-add').addEventListener('click', () => {
  if (wlMissing) return toast('Run database update 41-location-integrity.sql first', 'warn');
  if (WORK_LOCS.some(w => w.id === 'new')) return;
  WORK_LOCS = WORK_LOCS.concat({ id:'new', name:'', lat:'', lng:'', radius_m:200, active:true }); renderOffices();
});

// ── rules ──
$('lr-save').addEventListener('click', async () => {
  const rad = Math.round(Number($('lr-radius').value));
  if (!(rad >= 50 && rad <= 5000)) return toast('Default radius must be between 50 and 5,000 metres', 'warn');
  const minb = Math.round(Number($('lr-minbuild').value || 0));
  if (!(minb >= 0)) return toast('The oldest app build must be 0 or a positive number', 'warn');
  const value = { ...LOC_RULES, outside: $('lr-outside').value, default_radius: rad, block_mock: true, android_app_only: $('lr-apponly').checked, min_android_build: minb, unassigned_anywhere: $('lr-anywhere').checked };
  const { data, error } = await sb.from('settings').upsert({ key:'location_rules', value }).select('key');
  if (error) return toast(error.message, 'err'); if (!(data && data.length)) return toast('Only an administrator can change these rules', 'err');
  LOC_RULES = value; toast('Location rules saved');
});

// ── dashboard alert + menu badge ──
const _renderDashboardBase = renderDashboard;
renderDashboard = function(){
  _renderDashboardBase();
  const flagged = locFlagged(), n = flagged.length, held = flagged.filter(c => c.applied === false).length;
  const el = $('loc-badge'); if (el) { el.style.display = n ? '' : 'none'; el.textContent = n; }
  if (n) $('dash-alert').insertAdjacentHTML('beforeend', `<div class="alert ${flagged.some(c => (c.location_flags||[]).includes('fake_gps') || (c.location_flags||[]).includes('impossible_travel')) ? 'a-alarm' : 'a-warn'}" style="margin-bottom:10px;cursor:pointer" data-nav="locations">📍 <b>${n}</b> check-in${n>1?'s':''} with location warnings this period${held ? ` (${held} kept for review, not counted)` : ''} — click to review</div>`);
};

// ── employees fixed to an office (67) ──
let OFFICE_EMPS = [], OFFICE_EMPS_MISSING = false, WLE = null;
async function loadOfficeEmps(){
  const { data, error } = await sb.from('employee_work_locations').select('*');
  OFFICE_EMPS_MISSING = !!error; OFFICE_EMPS = data || [];
}
function openOfficeEmps(id){
  if (OFFICE_EMPS_MISSING) return toast('Run database file 67-employees-fixed-to-office.sql first', 'warn');
  const w = WORK_LOCS.find(x => x.id === id); if (!w) return;
  WLE = w; $('wle-title').textContent = `👥 Employees of ${w.name}`; $('wle-codes').value = ''; $('wle-q').value = ''; $('wle-note').textContent = '';
  const depts = [...new Set(S.employees.filter(e => e.status !== 'Inactive').map(e => e.department).filter(Boolean))].sort();
  $('wle-dept').innerHTML = '<option value="">Choose a department…</option>' + depts.map(d => `<option>${esc(d)}</option>`).join('');
  wleUnits();
  renderOfficeEmps(); openM('m-wlemp');
}
function renderOfficeEmps(){
  if (!WLE) return;
  const q = $('wle-q').value.trim().toLowerCase();
  const mine = OFFICE_EMPS.filter(x => x.location_id === WLE.id);
  const rows = mine.map(x => ({ x, e: empById(x.emp_id) || { id: x.emp_id } }))
    .filter(({ e }) => !q || [e.id, e.name_en, e.name_ar, e.department].some(v => String(v || '').toLowerCase().includes(q)))
    .sort((a, b) => String(a.e.id).localeCompare(String(b.e.id), undefined, { numeric: true }));
  $('wle-count').textContent = `${mine.length} employee${mine.length === 1 ? '' : 's'}`;
  $('wle-tbl').innerHTML = rows.map(({ e }) => { const other = OFFICE_EMPS.filter(y => y.emp_id === e.id && y.location_id !== WLE.id).map(y => (WORK_LOCS.find(w => w.id === y.location_id) || {}).name).filter(Boolean);
    return `<tr><td class="mono">${esc(e.id)}</td><td class="strong">${esc(empName(e))}</td><td>${esc(e.department || '')}</td><td>${esc(other.join(', '))}</td>
      <td><button class="btn btn-ghost btn-sm" data-wle-rm="${esc(e.id)}">✕ Remove</button></td></tr>`; }).join('')
    || '<tr><td colspan="5" class="empty">No employees yet — add a department or paste employee codes above</td></tr>';
  renderOffices();
}
async function addOfficeEmps(ids, label){
  const have = new Set(OFFICE_EMPS.filter(x => x.location_id === WLE.id).map(x => x.emp_id));
  const known = new Set(S.employees.map(e => String(e.id)));
  const unknown = ids.filter(i => !known.has(i)), add = [...new Set(ids.filter(i => known.has(i) && !have.has(i)))];
  if (!add.length) { $('wle-note').innerHTML = `Nothing new to add${unknown.length ? ` · <span class="neg">unknown codes: ${esc(unknown.slice(0, 15).join(', '))}</span>` : ''}`; return; }
  const by = (ME && (ME.full_name || ME.email)) || null;
  const { data, error } = await sb.from('employee_work_locations').insert(add.map(emp_id => ({ emp_id, location_id: WLE.id, added_by: by }))).select();
  if (error) return toast(error.message, 'err'); if (!(data && data.length)) return toast(NOPERM, 'err');
  OFFICE_EMPS = OFFICE_EMPS.concat(data);
  $('wle-note').innerHTML = `<span class="pos">✔ ${data.length} added${label ? ' from ' + esc(label) : ''}</span>${unknown.length ? ` · <span class="neg">not found: ${esc(unknown.slice(0, 15).join(', '))}${unknown.length > 15 ? ' …' : ''}</span>` : ''}`;
  renderOfficeEmps();
}
$('wle-codes-add').addEventListener('click', () => {
  const ids = $('wle-codes').value.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
  if (!ids.length) return toast('Paste one or more employee codes', 'warn');
  addOfficeEmps(ids).then(() => { $('wle-codes').value = ''; });
});
// department → its units; the count of active employees the button would add
const wlePick = () => { const d = $('wle-dept').value, u = $('wle-unit').value;
  return S.employees.filter(e => e.status !== 'Inactive' && e.department === d && (!u || (u === '(no unit)' ? !e.unit : e.unit === u))); };
function wleUnits(){
  const d = $('wle-dept').value, act = S.employees.filter(e => e.status !== 'Inactive' && e.department === d);
  const units = [...new Set(act.map(e => e.unit).filter(Boolean))].sort();
  $('wle-unit').innerHTML = `<option value="">${d ? 'All units' : '— unit —'}</option>` + units.map(u => `<option>${esc(u)}</option>`).join('')
    + (d && act.some(e => !e.unit) ? '<option value="(no unit)">(no unit)</option>' : '');
  $('wle-unit').disabled = !d; wleCount();
}
function wleCount(){ $('wle-dept-n').textContent = $('wle-dept').value ? `${wlePick().length} active employee(s) will be added` : ''; }
$('wle-dept').addEventListener('change', wleUnits);
$('wle-unit').addEventListener('change', wleCount);
$('wle-dept-add').addEventListener('click', () => {
  const d = $('wle-dept').value, u = $('wle-unit').value; if (!d) return toast('Choose a department', 'warn');
  addOfficeEmps(wlePick().map(e => String(e.id)), u ? `${d} · ${u}` : d);
});
$('wle-q').addEventListener('input', renderOfficeEmps);
$('wle-tbl').addEventListener('click', async e => {
  const b = e.target.closest('[data-wle-rm]'); if (!b) return;
  const id = b.dataset.wleRm;
  const { data, error } = await sb.from('employee_work_locations').delete().eq('emp_id', id).eq('location_id', WLE.id).select();
  if (error) return toast(error.message, 'err'); if (!(data && data.length)) return toast(NOPERM, 'err');
  OFFICE_EMPS = OFFICE_EMPS.filter(x => !(x.emp_id === id && x.location_id === WLE.id)); renderOfficeEmps(); toast('Removed');
});

// ═════════════════════════════════════════════════════════
//  ATTENDANCE CALENDAR — monthly / weekly view of one employee
//  HR: Attendance page → 📅 Calendar (any employee) · Employee: self-service → 🗓 My attendance (own only, RLS)
// ═════════════════════════════════════════════════════════
const CAL_WD = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const CAL_START = 6;                                   // weeks start on Saturday
const calISO = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const calDate = s => { const [y,m,d] = s.split('-').map(Number); return new Date(y, m-1, d); };
const calAdd = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const calWeekStart = d => calAdd(d, -((d.getDay() - CAL_START + 7) % 7));

function makeAttCalendar(p, opts){
  const st = { view: 'month', anchor: new Date(), emp: null, rows: [], leaves: [], loading: false, token: 0 };
  const range = () => {
    if (st.view === 'week') { const a = calWeekStart(st.anchor); return [a, calAdd(a, 6)]; }
    const first = new Date(st.anchor.getFullYear(), st.anchor.getMonth(), 1), last = new Date(st.anchor.getFullYear(), st.anchor.getMonth() + 1, 0);
    return [calWeekStart(first), calAdd(calWeekStart(last), 6)];
  };
  async function load(){
    const emp = opts.getEmp(); st.emp = emp;
    if (!emp) { $(p+'-grid').innerHTML = `<div class="empty" style="padding:30px">${esc(opts.emptyText || 'Choose an employee')}</div>`; $(p+'-sum').textContent = ''; label(); return; }
    const [a, b] = range(), from = calISO(a), to = calISO(b), tk = ++st.token;
    $(p+'-grid').innerHTML = '<div class="empty" style="padding:30px">Loading…</div>'; label();
    const [att, lv, who] = await Promise.all([
      sb.from('attendance').select('*').eq('emp_id', emp.id).gte('date', from).lte('date', to).order('date'),
      sb.from('employee_leaves').select('*').eq('emp_id', emp.id).lte('date_from', to).gte('date_to', from),
      opts.who ? sb.rpc('attendance_entered_by', { p_emp: emp.id, p_from: from, p_to: to }).then(r => r.error ? [] : (r.data || []), () => []) : Promise.resolve([]) ]);
    if (tk !== st.token) return;                                       // a newer request is on its way
    if (att.error) { $(p+'-grid').innerHTML = `<div class="empty" style="padding:30px">${esc(att.error.message)}</div>`; return; }
    st.rows = att.data || []; st.leaves = (lv && lv.data) || []; st.who = who || [];
    render();
  }
  function label(){
    const [a, b] = range();
    $(p+'-label').textContent = st.view === 'week'
      ? `${a.toLocaleDateString('en-GB', { day:'numeric', month:'short' })} – ${b.toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' })}`
      : st.anchor.toLocaleDateString('en-GB', { month:'long', year:'numeric' });
    $(p+'-vm').classList.toggle('on', st.view === 'month'); $(p+'-vw').classList.toggle('on', st.view === 'week');
    if (opts.title) $(p+'-title').textContent = opts.title(st.emp);
  }
  function dayInfo(ds){
    const rows = st.rows.filter(r => r.date === ds);
    const ins = rows.map(r => r.check_in).filter(Boolean).sort(), outs = rows.map(r => r.check_out).filter(Boolean).sort();
    const noOut = rows.some(attNoOut);                                // missing check-out: hours not counted until settled
    const hours = rows.reduce((s, r) => s + (attNoOut(r) ? 0 : num(r.total_hours)), 0);
    const segs = rows.flatMap(r => Array.isArray(r.projects) ? r.projects : []);
    const leave = st.leaves.find(l => l.date_from <= ds && l.date_to >= ds && !/reject|cancel/i.test(l.status || ''));
    return { rows, in: ins[0] || '', out: noOut ? '' : (outs.length ? outs[outs.length - 1] : ''), hours, segs, leave, noOut,
             open: !noOut && segs.some(s => s.in && !s.out), status: rows.map(r => r.status).find(Boolean) || '' };
  }
  // 🖐 fingerprint machine · 📱 phone · ✍ typed / changed by HR (who + when from the audit log, staff only) — 20 Oct 2026
  function daySource(ds, rows){
    if (!rows.length) return null;
    const segs = rows.flatMap(r => Array.isArray(r.projects) ? r.projects : []);
    const machine = rows.some(r => /machine|combined/i.test(r.source || '')) || segs.some(s => /machine/i.test(s.src || ''));
    const phone   = rows.some(r => /mobile|combined/i.test(r.source || ''));
    const handRow = rows.some(r => !/machine|mobile|combined/i.test(r.source || ''));
    const who = (st.who || []).filter(w => w.day === ds), ins = who.find(w => w.action === 'INSERT'), upd = who.find(w => w.action === 'UPDATE');
    const when = w => new Date(w.at).toLocaleString('en-GB', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' });
    const hand = handRow || !!upd, icons = [], tip = [];
    if (machine) { icons.push('🖐'); tip.push('🖐 Fingerprint machine' + (ins && !handRow ? ` — imported by ${ins.by_name} · ${when(ins)}` : '')); }
    if (phone)   { icons.push('📱'); tip.push('📱 Phone check-in'); }
    if (hand)    { icons.push('✍');
      if (handRow) tip.push(ins ? `✍ Entered by ${ins.by_name} · ${when(ins)}` : '✍ Entered by HR');
      if (upd)     tip.push(`✍ Changed by ${upd.by_name} · ${when(upd)}`); }
    return icons.length ? { icons: icons.join(''), tip: tip.join('\n') } : null;
  }
  function cell(ds, inMonth, big){
    const d = calDate(ds), today = calISO(new Date()), x = dayInfo(ds), emp = st.emp || {};
    const weekend = (settings.weekendDays || []).includes(d.getDay()), hol = typeof holidayOn === 'function' ? holidayOn(ds) : null;
    const before = emp.employment_date && ds < emp.employment_date, after = emp.resignation_date && ds > emp.resignation_date;
    let body = '';
    if (x.rows.length && (x.in || x.out || x.hours || x.noOut)) {
      const late = x.in && x.in > (settings.lateAfter || '09:00') && x.in < (settings.eveningShiftAfter || '14:00');
      body += `<div class="calv-time">In <b>${esc(x.in || '—')}</b>${late ? ' <span class="chip c-orange" style="padding:1px 6px">late</span>' : ''}</div>`
           +  (x.noOut ? `<div class="calv-time" style="color:var(--danger)" title="No check-out recorded — HR must enter it">Out <b>⚠ missing</b></div>`
                       : `<div class="calv-time">Out <b>${esc(x.out || (x.open ? 'open' : '—'))}</b></div>`)
           +  `<div class="calv-hrs"${x.noOut ? ' style="color:var(--muted);font-weight:500" title="Not calculated until the check-out is recorded or settled by HR"' : ''}>${x.noOut ? 'not counted' : x.hours ? esc(fmtHM(x.hours)) : '—'}</div>`;
      if (big && x.segs.length) body += `<div class="calv-prj">${x.segs.map(s => `${esc(s.code || 'No project')} ${esc(s.in || '')}–${esc(s.out || (x.noOut ? '?' : '…'))}${s.hours ? ' · ' + esc(fmtHM(s.hours)) : ''}`).join('<br>')}</div>`;
    } else if (x.rows.length && x.status) {
      body += `<span class="chip c-grey">${esc(x.status)}</span>`;
    }
    if (x.leave) body += `<span class="chip ${/approved/i.test(x.leave.status || '') ? 'c-blue' : 'c-grey'}">🌴 ${esc(x.leave.leave_type || 'Leave')}${/approved/i.test(x.leave.status || '') ? '' : ' (pending)'}</span>`;
    else if (hol && !x.rows.length) body += `<span class="chip c-green">📅 ${esc(hol.name || 'Holiday')}</span>`;
    else if (weekend && !x.rows.length) body += `<span style="color:var(--muted)">Weekend</span>`;
    else if (!x.rows.length && ds < today && !before && !after && inMonth) body += `<span class="chip c-red">No attendance</span>`;
    const cls = ['calv-cell', inMonth ? '' : 'out', ds === today ? 'today' : '', weekend ? 'wk' : '', big ? 'week' : ''].join(' ');
    const src = daySource(ds, x.rows);
    return `<div class="${cls}"><div class="calv-d"><span>${big ? CAL_WD[d.getDay()] + ' ' : ''}${d.getDate()}${big ? ' ' + d.toLocaleDateString('en-GB', { month:'short' }) : ''}</span>${src ? `<span class="calv-src" title="${esc(src.tip)}">${src.icons}</span>` : ''}</div>${body}</div>`;
  }
  function render(){
    const [a, b] = range(), big = st.view === 'week', month = st.anchor.getMonth();
    let html = '<div class="calv-grid">';
    for (let i = 0; i < 7; i++) html += `<div class="calv-hd">${CAL_WD[(CAL_START + i) % 7]}</div>`;
    for (let d = new Date(a); d <= b; d = calAdd(d, 1)) html += cell(calISO(d), big || d.getMonth() === month, big);
    $(p+'-grid').innerHTML = html + '</div>';
    // totals for the days shown (the month itself in month view)
    const days = []; for (let d = new Date(a); d <= b; d = calAdd(d, 1)) if (big || d.getMonth() === month) days.push(calISO(d));
    const info = days.map(dayInfo), worked = info.filter(x => x.hours > 0 || x.in), noOut = info.filter(x => x.noOut).length;
    const total = info.reduce((s, x) => s + x.hours, 0), lvDays = info.filter(x => x.leave && /approved/i.test(x.leave.status || '')).length;
    const today = calISO(new Date()), emp = st.emp || {};
    const missing = days.filter((ds, i) => !info[i].rows.length && !info[i].leave && ds < today && isWorkday(ds)
                                     && !(emp.employment_date && ds < emp.employment_date) && !(emp.resignation_date && ds > emp.resignation_date)).length;
    $(p+'-sum').innerHTML = `<b>${worked.length}</b> day${worked.length === 1 ? '' : 's'} worked · <b>${esc(fmtHM(total))}</b> in total`
      + (info.some(x => x.hours > 0) ? ` · average ${esc(fmtHM(total / info.filter(x => x.hours > 0).length))} a day` : '')
      + (noOut ? ` · <span style="color:var(--danger)"><b>${noOut}</b> day${noOut === 1 ? '' : 's'} with a missing check-out (not counted)</span>` : '')
      + (lvDays ? ` · <b>${lvDays}</b> leave day${lvDays === 1 ? '' : 's'}` : '')
      + (missing ? ` · <span style="color:var(--danger)"><b>${missing}</b> working day${missing === 1 ? '' : 's'} with no attendance</span>` : '');
  }
  const move = n => { if (st.view === 'week') st.anchor = calAdd(st.anchor, 7 * n); else st.anchor = new Date(st.anchor.getFullYear(), st.anchor.getMonth() + n, 1); load(); };
  $(p+'-prev').addEventListener('click', () => move(-1));
  $(p+'-next').addEventListener('click', () => move(1));
  $(p+'-today').addEventListener('click', () => { st.anchor = new Date(); load(); });
  $(p+'-vm').addEventListener('click', () => { st.view = 'month'; load(); });
  $(p+'-vw').addEventListener('click', () => { st.view = 'week'; load(); });
  return { load, st };
}

// ── HR: Attendance page → Calendar tab ──
const HR_CAL = makeAttCalendar('hc', {
  getEmp: () => { const v = $('hc-emp').value.trim(); return v ? empById(v.split(' — ')[0].trim()) || null : null; },
  emptyText: 'Type an employee code or name in the box above to see their attendance calendar',
  title: e => e ? `${e.id} — ${empName(e)}` : 'Employee calendar', who: true });
$('hc-emp').addEventListener('change', () => HR_CAL.load());
function attTab(cal){
  $('att-cal-wrap').style.display = cal ? '' : 'none'; $('att-list-card').style.display = cal ? 'none' : '';
  $('att-tab-cal').classList.toggle('on', cal); $('att-tab-list').classList.toggle('on', !cal);
  if (cal) {                                           // start with the employee typed in the records search, if it is one
    if (!$('hc-emp').value.trim()) { const q = $('att-q').value.trim(), e = q && (empById(q) || S.employees.find(x => empName(x).toLowerCase() === q.toLowerCase()));
      if (e) $('hc-emp').value = `${e.id} — ${empName(e)}`; }
    HR_CAL.load();
  }
}
$('att-tab-list').addEventListener('click', () => attTab(false));
$('att-tab-cal').addEventListener('click', () => attTab(true));

// ── Employee: self-service → My attendance ──
const SELF_CAL = makeAttCalendar('sc', {
  getEmp: () => (typeof SD !== 'undefined' && SD && SD.emp) || null,
  emptyText: 'Your employee record could not be found. Please contact HR.' });
document.querySelector('[data-spage="att"]').addEventListener('click', () => SELF_CAL.load());

// ═════════════════════════════════════════════════════════
//  HR ALERTS · ANNUAL LEAVE BALANCE · CERTIFICATES   (database: 47-leave-entitlement-hr-alerts.sql)
//  Alerts: hr_alerts() / hr_alert_respond() · Balance: leave_balance(emp, year) / leave_balances(year) · Rules: save_hr_rules()
// ═════════════════════════════════════════════════════════
const HRA_KIND = { contract:['📄 Contract renewal','c-orange'], probation:['⏳ End of probation','c-blue'], id:['🪪 National ID expiry','c-red'],
                   cert:['🎓 Certificate expiry','c-orange'], disability:['♿ Disability card expiry','c-orange'] };
const HRA_DEC = { seen:'Handled', renew:'Renew', not_renew:'Do not renew', confirm:'Confirm', not_confirm:'Do not confirm' };
const HR_RULES_DEF = { leave_rules:{ start_year:2026, first_year_days:15, normal_days:21, senior_days:30, senior_insured_years:10, senior_age:50, emergency_days:7, wait_months:6, carry_cap:7 },
                       hr_alerts:{ contract_days:75, probation_days:30, id_days:30, cert_days:30, disability_days:30 } };
let HRA = { list:[], loaded:false, loading:false, missing:false };
let HR_RULES = JSON.parse(JSON.stringify(HR_RULES_DEF));
const canHRA = () => !!(ME && ['admin','hr','hr_officer'].includes(ME.role));
const canHRW = () => !!(ME && ['admin','hr'].includes(ME.role));                      // leave / alert rules
const canEditMaster = () => !!(ME && ['admin','hr','hr_officer'].includes(ME.role));   // employee master data (HR officers too — 49)
// same as the database: one year later; 29 Feb → 28 Feb
function addYearISO(s, n = 1){ const [y, m, d] = s.split('-').map(Number), x = new Date(y + n, m - 1, d); if (x.getMonth() !== m - 1) x.setDate(0);
  return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,'0')}-${String(x.getDate()).padStart(2,'0')}`; }

async function loadHRAlerts(){
  if (!canHRA()) return;
  HRA.loading = true;
  const [a, r] = await Promise.all([ sb.rpc('hr_alerts'), sb.from('settings').select('*').in('key', ['leave_rules','hr_alerts']),
                                    typeof loadDocRequests === 'function' ? loadDocRequests().catch(()=>{}) : null ]);
  HRA.loading = false; HRA.loaded = true;
  HRA.missing = !!a.error; HRA.list = Array.isArray(a.data) ? a.data : [];
  (r.data || []).forEach(x => { if (HR_RULES_DEF[x.key]) HR_RULES[x.key] = { ...HR_RULES_DEF[x.key], ...(x.value || {}) }; });
  hraBadge();
}
const hraOpen = () => HRA.list.filter(a => !a.done);
function hraBadge(){ const n = hraOpen().length, el = $('hra-badge'); if (el){ el.style.display = n ? '' : 'none'; el.textContent = n; } }
const hraDays = n => { n = Number(n); return n < 0 ? `<span class="neg">${-n} day${n === -1 ? '' : 's'} ago</span>` : n === 0 ? '<span class="neg">today</span>' : `in ${n} day${n === 1 ? '' : 's'}`; };
const hraKey = a => [a.kind, a.emp_id, a.ref_id || '', a.due].join('|');
const hraFind = k => HRA.list.find(a => hraKey(a) === k);
function hraResp(a){
  return (a.responses || []).map(r => `<div style="font-size:12px;margin-bottom:3px"><span class="chip ${/^(not_|seen)/.test(r.decision) ? 'c-grey' : 'c-green'}" style="padding:1px 6px">${esc(HRA_DEC[r.decision] || r.decision)}</span>
      ${r.role === 'manager' ? 'Manager' : 'HR'}: ${esc(r.name || r.emp || '')}${r.note ? ` — ${esc(r.note)}` : ''}</div>`).join('') || '<span style="color:var(--muted)">—</span>';
}
function renderHRAlerts(){
  const noStart = S.employees.filter(e => e.status !== 'Inactive' && (e.contract_type || '') !== 'Permanent' && !e.contract_start_date && !e.contract_end_date);
  $('hra-missing').innerHTML = HRA.missing
    ? '<div class="alert a-warn" style="margin-bottom:12px">Database update <b>47-leave-entitlement-hr-alerts.sql</b> has not been run yet — alerts are not available.</div>'
    : noStart.length ? `<div class="alert a-warn" style="margin-bottom:12px">📄 <b>${noStart.length}</b> temporary / contract employee${noStart.length === 1 ? ' has' : 's have'} no contract start date, so no renewal alert can be made for ${noStart.length === 1 ? 'him' : 'them'}.
        Open the employee → <b>Contract</b> → enter <b>Contract start</b> and save (the end date fills in by itself).
        <details style="margin-top:6px"><summary style="cursor:pointer">Show them</summary><div style="margin-top:6px;line-height:1.9">${noStart.map(e => `<a href="#" data-hra-emp="${esc(e.id)}">${esc(e.id)} ${esc(empName(e))}</a>`).join(' · ')}</div></details></div>` : '';
  const k = $('hra-kind').value, showDone = $('hra-done').checked, q = $('hra-q').value.trim().toLowerCase();
  const list = HRA.list.filter(a => (!k || a.kind === k) && (showDone || !a.done)
                                 && (!q || [a.emp_id, a.name_en, a.name_ar].some(v => String(v || '').toLowerCase().includes(q))));
  $('hra-count').textContent = `${list.length} alert${list.length === 1 ? '' : 's'}${showDone ? '' : ' to handle'}`;
  $('hra-tbl').innerHTML = list.map(a => { const kd = HRA_KIND[a.kind] || [a.kind, 'c-grey'], key = esc(hraKey(a));
    let btns;
    if (a.kind === 'contract') btns = (canEditMaster() ? `<button class="btn btn-success btn-sm" data-hra-act="renew" data-k="${key}">Renew 1 year</button> ` : '')
                                    + `<button class="btn btn-ghost btn-sm" data-hra-act="not_renew" data-k="${key}">Not renewing</button>`;
    else if (a.kind === 'probation') btns = `<button class="btn btn-success btn-sm" data-hra-act="confirm" data-k="${key}">Confirm</button> <button class="btn btn-ghost btn-sm" data-hra-act="not_confirm" data-k="${key}">Do not confirm</button>`;
    else btns = (a.kind === 'id' && typeof hraDocCell === 'function' ? hraDocCell(a) : '')
              + (canEditMaster() ? `<button class="btn btn-ghost btn-sm" data-hra-emp="${esc(a.emp_id)}">Update the date</button> ` : '') + `<button class="btn btn-ghost btn-sm" data-hra-act="seen" data-k="${key}">Mark handled</button>`;
    return `<tr${a.done ? ' style="opacity:.6"' : ''}><td><span class="chip ${kd[1]}">${kd[0]}</span>${a.detail ? `<div style="font-size:12px;margin-top:4px">${esc(a.kind === 'disability' ? 'Card ' + a.detail : a.detail)}</div>` : ''}</td>
      <td class="strong"><a href="#" data-hra-emp="${esc(a.emp_id)}">${esc(a.name_en || a.name_ar || a.emp_id)}</a> <span class="mono" style="color:var(--muted)">${esc(a.emp_id)}</span>${a.job ? `<div style="font-size:12px;color:var(--muted);font-weight:400">${esc(a.job)}</div>` : ''}</td>
      <td>${esc(a.department || '')}</td><td class="mono">${esc(a.due)}</td><td style="white-space:nowrap">${hraDays(a.days_left)}</td>
      <td style="white-space:normal;min-width:190px">${hraResp(a)}</td><td style="white-space:nowrap">${a.done ? '<span class="chip c-green">handled</span>' : btns}</td></tr>`; }).join('')
    || `<tr><td colspan="7" class="empty">${HRA.loaded ? 'Nothing needs attention' : 'Loading…'}</td></tr>`;
  renderHRRules();
}
function renderHRRules(){
  const L = HR_RULES.leave_rules, A = HR_RULES.hr_alerts;
  const set = (id, v) => { const el = $(id); if (el && document.activeElement !== el) el.value = v; };
  set('lrl-first', L.first_year_days); set('lrl-normal', L.normal_days); set('lrl-senior', L.senior_days); set('lrl-senyears', L.senior_insured_years); set('lrl-senage', L.senior_age);
  set('lrl-emerg', L.emergency_days); set('lrl-wait', L.wait_months); set('lrl-cap', L.carry_cap); set('lrl-start', L.start_year);
  set('hal-contract', A.contract_days); set('hal-probation', A.probation_days); set('hal-id', A.id_days); set('hal-cert', A.cert_days); set('hal-dis', A.disability_days);
  const ro = !canHRW();
  document.querySelectorAll('#hra-rules input').forEach(i => { i.disabled = ro; });
  $('hra-save-rules').style.display = ro ? 'none' : '';
  $('hra-rules-note').textContent = ro ? 'View only — HR or an administrator can change these rules.' : '';
}
PAGE_RENDER.hralerts = () => { renderHRAlerts(); loadHRAlerts().then(renderHRAlerts, renderHRAlerts); };
['hra-kind','hra-done'].forEach(id => $(id).addEventListener('change', renderHRAlerts));
$('hra-q').addEventListener('input', renderHRAlerts);
$('hra-refresh').addEventListener('click', () => loadHRAlerts().then(() => { renderHRAlerts(); toast('Alerts refreshed'); }));
$('hra-save-rules').addEventListener('click', async () => {
  const n = id => Number($(id).value);
  const L = { ...HR_RULES.leave_rules, first_year_days:n('lrl-first'), normal_days:n('lrl-normal'), senior_days:n('lrl-senior'), senior_insured_years:Math.round(n('lrl-senyears')), senior_age:Math.round(n('lrl-senage')),
              emergency_days:n('lrl-emerg'), wait_months:Math.round(n('lrl-wait')), carry_cap:n('lrl-cap'), start_year:Math.round(n('lrl-start')) };
  const A = { ...HR_RULES.hr_alerts, contract_days:Math.round(n('hal-contract')), probation_days:Math.round(n('hal-probation')), id_days:Math.round(n('hal-id')),
              cert_days:Math.round(n('hal-cert')), disability_days:Math.round(n('hal-dis')) };
  if ([L.first_year_days, L.normal_days, L.senior_days, L.emergency_days, L.carry_cap, L.wait_months].some(v => !(v >= 0)) || !(L.senior_insured_years >= 1) || !(L.senior_age >= 18) || !(L.start_year >= 2000))
    return toast('Check the leave rules — every box needs a number', 'warn');
  if (Object.values(A).some(v => !(v >= 1 && v <= 400))) return toast('Alert days must be between 1 and 400', 'warn');
  for (const [key, value] of [['leave_rules', L], ['hr_alerts', A]]){
    const { error } = await sb.rpc('save_hr_rules', { p_key:key, p_value:value });
    if (error) return toast(error.message, 'err');
  }
  HR_RULES = { leave_rules:L, hr_alerts:A }; LB.clear(); LB_ALL.year = null;
  await loadHRAlerts(); renderHRAlerts(); toast('Rules saved');
});
// decisions
let HRA_PICK = null;
document.addEventListener('click', e => {
  const em = e.target.closest('[data-hra-emp]'); if (em){ e.preventDefault(); return openEmp(em.dataset.hraEmp); }
  const b = e.target.closest('[data-hra-act]'); if (!b) return;
  const a = hraFind(b.dataset.k); if (!a) return;
  const act = b.dataset.hraAct, nm = `<b>${esc(a.name_en || a.name_ar || a.emp_id)}</b> (${esc(a.emp_id)})`;
  HRA_PICK = { a, act };
  const info = {
    renew: `${nm}'s contract ends on <b>${esc(a.due)}</b>. Renewing sets the new contract <b>${esc(addDaysISO(a.due, 1))} → ${esc(addYearISO(a.due))}</b> (one year, ending the day before) on the employee record.`,
    not_renew: `${nm}'s contract ends on <b>${esc(a.due)}</b>. Record that it will <b>not</b> be renewed. (Nothing else changes — when he leaves, make him Inactive with the resignation date as usual.)`,
    confirm: `${nm}'s probation ends on <b>${esc(a.due)}</b>. Record that he is <b>confirmed</b> in his job.`,
    not_confirm: `${nm}'s probation ends on <b>${esc(a.due)}</b>. Record that he is <b>not confirmed</b>.`,
    seen: `${HRA_KIND[a.kind] ? HRA_KIND[a.kind][0] : a.kind} for ${nm} on <b>${esc(a.due)}</b>. Mark it handled — it leaves the list. Tip: entering the new expiry date on the employee also clears it.`
  }[act];
  const mgr = (a.responses || []).filter(r => r.role === 'manager');
  $('hra-m-title').textContent = { renew:'Renew contract for 1 year', not_renew:'Contract will not be renewed', confirm:'Confirm after probation', not_confirm:'Not confirmed after probation', seen:'Mark handled' }[act];
  $('hra-m-info').innerHTML = info + (mgr.length ? `<div style="margin-top:8px">Manager's recommendation: ${hraResp({ responses:mgr })}</div>` : '');
  $('hra-m-note').value = '';
  $('hra-m-btns').innerHTML = `<button class="btn btn-ghost" data-close="m-hra">Cancel</button><button class="btn ${/^not_/.test(act) ? 'btn-danger' : 'btn-primary'}" id="hra-m-go">${esc($('hra-m-title').textContent)}</button>`;
  openM('m-hra');
});
document.addEventListener('click', async e => {
  if (!e.target.closest('#hra-m-go') || !HRA_PICK) return;
  const { a, act } = HRA_PICK, btn = $('hra-m-go'); btn.disabled = true;
  try {
    if (act === 'renew'){
      const upd = { contract_start_date:addDaysISO(a.due, 1), contract_end_date:addYearISO(a.due) };   // next day → one year later, the day before
      const res = await sb.from('employees').update(upd).eq('id', a.emp_id).select();
      if (res.error) throw res.error; if (!(res.data && res.data.length)) throw new Error(NOPERM);
      const i = S.employees.findIndex(x => String(x.id) === String(a.emp_id)); if (i >= 0) S.employees[i] = { ...S.employees[i], ...res.data[0] };
    }
    const { error } = await sb.rpc('hr_alert_respond', { p_kind:a.kind, p_emp:a.emp_id, p_ref:a.ref_id || '', p_due:a.due, p_decision:act, p_note:$('hra-m-note').value.trim() || null });
    if (error) throw error;
    closeM('m-hra'); toast(act === 'renew' ? `Contract renewed until ${addYearISO(a.due)}` : 'Saved');
    await loadHRAlerts(); renderHRAlerts(); renderDashboard();
  } catch (err){ toast(err.message || String(err), 'err'); }
  btn.disabled = false;
});
// dashboard alert + menu badge (loads once after sign-in, again when the page is opened)
const _renderDashboard26 = renderDashboard;
renderDashboard = function(){
  const r = _renderDashboard26.apply(this, arguments);
  if (canHRA() && !HRA.loaded && !HRA.loading) loadHRAlerts().then(() => renderDashboard(), () => {});
  const open = hraOpen(), n = open.length, late = open.filter(a => Number(a.days_left) < 0).length;
  hraBadge();
  if (n && $('dash-alert')){
    const by = Object.entries(open.reduce((m, a) => (m[a.kind] = (m[a.kind] || 0) + 1, m), {})).map(([k, c]) => `${c} ${(HRA_KIND[k] || [k])[0].replace(/^\S+\s/, '').toLowerCase()}`).join(' · ');
    $('dash-alert').insertAdjacentHTML('beforeend', `<div class="alert ${late ? 'a-alarm' : 'a-warn'}" style="margin-bottom:10px;cursor:pointer" data-nav="hralerts">🔔 <b>${n} HR alert${n === 1 ? '' : 's'}</b> need${n === 1 ? 's' : ''} attention${late ? ` — ${late} already past the date` : ''}: ${esc(by)}. <u>Open HR alerts</u></div>`);
  }
  return r;
};

// ═════════════ ANNUAL LEAVE BALANCE (from the database) ═════════════
const LB = new Map();                       // "emp|year" → balance
let LB_ALL = { year:null, rows:[] };
async function getLB(emp, year, force){
  const k = `${emp}|${year}`; if (!force && LB.has(k)) return LB.get(k);
  const { data, error } = await sb.rpc('leave_balance', { p_emp:String(emp), p_year:Number(year) });
  if (error) { LB.set(k, null); return null; }
  LB.set(k, data); return data;
}
const lbTypes = () => settings.casualCountsAnnual === 'no' ? ['Annual'] : ['Annual','Casual'];
// one line explaining the balance, with the days of a request taken off
function lbText(b, reqDays, type, alreadyIn){
  const y = b.year, add = alreadyIn || 0, left = num(b.remaining) + add - reqDays;
  const out = [`Annual balance ${y}: <b>${fmt(b.entitlement)}</b> earned this year (now ${fmt(b.rate_today)} days a year)${num(b.carry_in) ? ` ${num(b.carry_in) < 0 ? '−' : '+'} ${fmt(Math.abs(num(b.carry_in)))} from last year` : ''} − ${fmt(num(b.taken) - add)} taken${num(b.pending) ? ` (${fmt(b.pending)} pending)` : ''}${reqDays ? ` − ${fmt(reqDays)} this request` : ''} → <b class="${left < 0 ? 'neg' : 'pos'}">${fmt(left)} remaining</b>${left < 0 ? ' — exceeds the balance' : ''}`];
  if (num(b.carry_in) > 0 && b.this_year_left != null){
    // the request uses this year's days first; carried days only after those are used up
    const yl = num(b.this_year_left) + add, useYear = Math.min(Math.max(yl, 0), reqDays), useCarry = reqDays - useYear;
    out.push(`<span style="color:var(--muted)">Of the remaining: this year's days ${fmt(yl - useYear)} · carried days ${fmt(num(b.carry_left) - useCarry)} (carried days are used only after this year's days)</span>`); }
  if (type === 'Casual'){ const el = num(b.emergency_cap) - num(b.emergency_taken) - num(b.emergency_pending) + (alreadyIn || 0) - reqDays;
    out.push(`Emergency leave ${y}: ${fmt(b.emergency_cap)} days allowed · <b class="${el < 0 ? 'neg' : 'pos'}">${fmt(el)} left</b> after this request${el < 0 ? ' — over the emergency limit' : ''}`); }
  return out;
}
leaveHint = function(){
  const emp = parseEmpInput($('lv-emp').value), e = empById(emp), f = $('lv-from').value, t = $('lv-to').value, type = $('lv-t').value, out = [];
  if (f && t && t < f) out.push('<span class="neg">“To” is before “From”.</span>');
  if (f && t && t >= f){ const cal = Math.round((dObj(t) - dObj(f)) / 86400000) + 1, wd = workdays(f, t);
    out.push(`${cal} calendar day${cal > 1 ? 's' : ''}, ${wd} working day${wd === 1 ? '' : 's'} (weekends excluded).`); }
  if (e && (type === 'Annual' || type === 'Casual')){
    const y = (f || todayStr()).slice(0, 4), b = LB.get(`${emp}|${y}`);
    if (b === undefined){ out.push('<span style="color:var(--muted)">Annual balance: loading…</span>'); getLB(emp, y).then(() => leaveHint()); }
    else if (b === null) out.push('<span style="color:var(--muted)">Annual balance not available (database update 47 not run yet).</span>');
    else {
      const self = editingLeave && S.leaves.find(l => l.id === editingLeave && l.status === 'Approved');
      const inYear = l => leaveDaysIn(l, `${y}-01-01`, `${y}-12-31`);
      const addAnnual = self && lbTypes().includes(self.leave_type) ? inYear(self) : 0, addEm = self && self.leave_type === 'Casual' ? inYear(self) : 0;
      const req = num($('lv-days').value);
      if (type === 'Annual' || lbTypes().includes('Casual')) out.push(...lbText(b, req, type, addAnnual).slice(0, 1));
      if (type === 'Casual') out.push(lbText(b, req, 'Casual', addEm)[1]);
      if (f && b.eligible_from && f < b.eligible_from && !b.early_ok)
        out.push(`<span style="color:var(--warn)">⚠ Before ${esc(b.eligible_from)} — within the first ${num(HR_RULES.leave_rules.wait_months) || 6} months of service. The employee cannot request this himself; as HR you may still enter it.</span>`);
    }
  }
  if (type === 'Unpaid' && e) out.push(`Unpaid: deducts ${fmt(num(e.daily_pay) || 0)} (daily pay) per day in the payroll period it falls in.`);
  if (e && f && t){ const clash = S.leaves.find(l => l.id !== editingLeave && l.status === 'Approved' && String(l.emp_id) === emp && l.date_from <= t && l.date_to >= f);
    if (clash) out.push(`<span class="neg">Overlaps an approved ${esc(clash.leave_type)} leave ${clash.date_from} → ${clash.date_to}.</span>`); }
  $('lv-hint').innerHTML = out.join('<br>');
};
const _openLeave26 = openLeave;
openLeave = function(){ LB.clear(); LB_ALL.year = null; return _openLeave26.apply(this, arguments); };

// employee self-service: own balance
slHint = function(){
  const f = $('sl-from').value, t = $('sl-to').value, type = $('sl-type').value, days = num($('sl-days').value), out = [];
  if (f && t && t < f) out.push('<span class="neg">“To” is before “From”.</span>');
  if (f && t && t >= f){ const cal = Math.round((dObj(t) - dObj(f)) / 86400000) + 1, wd = workdays(f, t);
    out.push(`${cal} calendar day${cal > 1 ? 's' : ''} · <b>${wd} working day${wd === 1 ? '' : 's'}</b> (weekends and public holidays are not counted)`); }
  if (f && f < todayStr()) out.push('<span style="color:var(--warn)">These dates are in the past — HR will review them.</span>');
  if (SD.emp && (type === 'Annual' || type === 'Casual')){
    const y = (f || todayStr()).slice(0, 4), b = LB.get(`${SD.emp.id}|${y}`);
    if (b === undefined){ out.push('<span style="color:var(--muted)">Annual balance: loading…</span>'); getLB(SD.emp.id, y).then(() => slHint()); }
    else if (b){
      const lines = lbText(b, days, type, 0);
      if (type === 'Annual' || lbTypes().includes('Casual')) out.push(lines[0].replace(' — exceeds the balance', ' — more than your balance; HR may reject it'));
      if (type === 'Casual') out.push(lines[1].replace(' — over the emergency limit', ' — over your emergency limit; it will not be accepted'));
      if (f && b.eligible_from && f < b.eligible_from && !b.early_ok)
        out.push(`<span class="neg">You can request annual or emergency leave from <b>${esc(b.eligible_from)}</b> (after ${num(HR_RULES.leave_rules.wait_months) || 6} months of service). Ask HR if you need an exception.</span>`);
    }
  }
  if (type === 'Unpaid') out.push('Unpaid leave is deducted from your salary at your daily rate.');
  if (type === 'Sick') out.push('Please keep your medical report — HR may ask for it.');
  if (f && t){ const c = SD.leaves.find(l => (l.status === 'Approved' || l.status === 'Pending') && l.date_from <= t && l.date_to >= f);
    if (c) out.push(`<span class="neg">Overlaps your ${c.status.toLowerCase()} ${c.leave_type} leave ${c.date_from} → ${c.date_to}.</span>`); }
  $('sl-hint').innerHTML = out.join('<br>');
};
const _openSelfLeave26 = openSelfLeave;
openSelfLeave = function(){ LB.clear(); return _openSelfLeave26.apply(this, arguments); };
const _renderSelf26 = renderSelf;
renderSelf = function(){
  const r = _renderSelf26.apply(this, arguments);
  if (SD && SD.emp){ const y = todayStr().slice(0, 4), id = SD.emp.id;
    const paint = b => { const c = document.querySelector('#self-stats .stat'); if (!c || !b) return;
      c.innerHTML = `<div class="stat-label">Annual leave ${y}</div><div class="stat-value">${fmt(num(b.remaining) - num(b.pending))}</div>
        <div class="stat-sub">left of ${fmt(num(b.entitlement) + num(b.carry_in))}${num(b.pending) ? ` · ${fmt(b.pending)} pending` : ''} · emergency ${fmt(Math.max(0, num(b.emergency_cap) - num(b.emergency_taken) - num(b.emergency_pending)))} left${b.eligible_from > todayStr() && !b.early_ok ? `<br>leave can be requested from ${esc(b.eligible_from)}` : ''}</div>`; };
    const b = LB.get(`${id}|${y}`); if (b !== undefined) paint(b); else getLB(id, y).then(paint);
  }
  return r;
};

// report: Annual leave balance
const repLB = REPORTS.find(r => r.id === 'lv-balance');
if (repLB){
  repLB.d = 'For the year of the current period: days earned (15 / 21 / 30 a year by service and insurance, part-year when joining), carried in from last year, taken, pending and remaining — plus the emergency days allowed and used.';
  repLB.build = () => {
    const y = Number(settings.period.slice(0, 4)), by = new Map((LB_ALL.rows || []).map(b => [String(b.emp_id), b]));
    const take = (id, t) => S.leaves.filter(l => String(l.emp_id) === String(id) && l.status === 'Approved' && l.leave_type === t).reduce((s, l) => s + leaveDaysIn(l, `${y}-01-01`, `${y}-12-31`), 0);
    return { cols:[C('code','Code','id'),C('name','Employee','strong'),C('department','Department'),C('rate','Days a year now','num'),C('carry','Carried in','num',true),C('ent','Earned this year','num',true),
                   C('taken','Taken','num',true),C('pend','Pending','num',true),C('rem','Remaining','num',true),C('emcap','Emergency allowed','num',true),C('emused','Emergency taken','num',true),
                   C('from','May request from','date'),C('sick','Sick taken','num',true),C('unpaid','Unpaid taken','num',true)],
      rows: LB_ALL.year === y ? activeEmps().map(e => { const b = by.get(String(e.id)) || {};
        return { code:e.id, name:empName(e), department:e.department, rate:num(b.rate_today), carry:num(b.carry_in), ent:num(b.entitlement), taken:num(b.taken), pend:num(b.pending),
                 rem:num(b.remaining), emcap:num(b.emergency_cap), emused:num(b.emergency_taken), from:b.eligible_from || '', sick:take(e.id, 'Sick'), unpaid:take(e.id, 'Unpaid') }; }) : [],
      note: LB_ALL.year === y ? '' : 'Loading the balances…' };
  };
}
const _openReport26 = openReport;
openReport = function(id){
  const r = _openReport26.apply(this, arguments);
  const y = Number(settings.period.slice(0, 4));
  if (id === 'lv-balance' && LB_ALL.year !== y)
    sb.rpc('leave_balances', { p_year:y }).then(({ data, error }) => { if (error) return toast(error.message, 'err'); LB_ALL = { year:y, rows:data || [] }; if (repCur === 'lv-balance') runReport(); });
  return r;
};

// ═════════════ EMPLOYEE WINDOW: leave balance + certificates ═════════════
async function renderEmpLeave(id){
  const box = $('emp-lbal'); if (!box) return;
  if (!id){ box.innerHTML = '<span style="color:var(--muted)">Save the employee first.</span>'; return; }
  box.innerHTML = '<span style="color:var(--muted)">Loading…</span>';
  const y = todayStr().slice(0, 4), b = await getLB(id, y, true);
  if (String(editingEmp) !== String(id)) return;
  if (!b){ box.innerHTML = '<span style="color:var(--muted)">Not available — database update 47 has not been run yet.</span>'; return; }
  const L = HR_RULES.leave_rules;
  box.innerHTML = `<div class="grid3" style="gap:10px">
      <div><div style="color:var(--muted);font-size:12px">${y} balance</div><div style="font-size:20px;font-weight:700" class="${num(b.remaining) < 0 ? 'neg' : ''}">${fmt(b.remaining)} days</div>
        <div style="font-size:12px">${fmt(b.entitlement)} earned${num(b.carry_in) ? ` · ${fmt(b.carry_in)} from last year` : ''} · ${fmt(b.taken)} taken${num(b.pending) ? ` · ${fmt(b.pending)} pending` : ''}${num(b.carry_in) > 0 && b.this_year_left != null ? `<br>left: ${fmt(b.this_year_left)} this year's + ${fmt(b.carry_left)} carried (used last)` : ''}</div></div>
      <div><div style="color:var(--muted);font-size:12px">Emergency leave ${y}</div><div style="font-size:20px;font-weight:700">${fmt(Math.max(0, num(b.emergency_cap) - num(b.emergency_taken)))} left</div>
        <div style="font-size:12px">${fmt(b.emergency_cap)} allowed · ${fmt(b.emergency_taken)} taken</div></div>
      <div><div style="color:var(--muted);font-size:12px">Earning now</div><div style="font-size:20px;font-weight:700">${fmt(b.rate_today)} days / year</div>
        <div style="font-size:12px">${b.override != null ? 'special case set on this employee' : `${fmt(L.normal_days)} from ${esc(b.normal_from || '—')}${b.senior_from ? ` · ${fmt(L.senior_days)} from ${esc(b.senior_from)}${b.senior_reason === 'age' ? ` (age ${L.senior_age || 50})` : b.senior_reason === 'insurance' ? ` (${L.senior_insured_years} insured years)` : ''}` : ` · ${fmt(L.senior_days)} after ${L.senior_insured_years} insured years or age ${L.senior_age || 50}`}`}</div></div>
    </div>
    <div style="font-size:12px;margin-top:8px;color:${b.eligible_from > todayStr() && !b.early_ok ? 'var(--warn)' : 'var(--muted)'}">May request annual / emergency leave from <b>${esc(b.eligible_from || '—')}</b>${b.early_ok ? ' — HR exception: allowed before that' : ''}.</div>`;
}
let CERTS = [], CERT_EDIT = null;
async function renderCerts(id){
  const box = $('emp-certs'); if (!box) return;
  if (!id){ box.innerHTML = '<span style="color:var(--muted)">Save the employee first.</span>'; return; }
  const { data, error } = await sb.from('employee_certificates').select('*').eq('emp_id', id).order('expiry_date', { ascending:true, nullsFirst:false });
  if (String(editingEmp) !== String(id)) return;
  if (error){ box.innerHTML = '<span style="color:var(--muted)">Not available — database update 47 has not been run yet.</span>'; return; }
  CERTS = data || [];
  const today = todayStr(), soon = addDaysISO(today, num(HR_RULES.hr_alerts.cert_days) || 30);
  box.innerHTML = (CERTS.length ? `<div class="tbl-wrap"><table><thead><tr><th>Certificate</th><th>Issued by</th><th>Number</th><th>Issued</th><th>Expires</th><th>Scan</th><th></th></tr></thead><tbody>${CERTS.map(c => `<tr>
      <td class="strong">${esc(c.name)}${c.notes ? `<div style="font-size:12px;color:var(--muted);font-weight:400">${esc(c.notes)}</div>` : ''}</td><td>${esc(c.issuer || '')}</td><td class="mono">${esc(c.cert_no || '')}</td>
      <td class="mono">${esc(c.issue_date || '')}</td>
      <td class="mono">${c.expiry_date ? esc(c.expiry_date) + (c.expiry_date < today ? ' <span class="chip c-red">expired</span>' : c.expiry_date <= soon ? ' <span class="chip c-orange">soon</span>' : '') : '<span style="color:var(--muted)">no expiry</span>'}</td>
      <td>${c.file_path ? `<a href="#" data-cert-file="${esc(c.file_path)}">📎 open</a>` : '—'}</td>
      <td style="white-space:nowrap">${canEditMaster() ? `<button class="icon-btn" data-cert-edit="${c.id}" title="Edit">✎</button><button class="icon-btn" data-cert-del="${c.id}" title="Remove">🗑</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`
    : '<span style="color:var(--muted)">No certificates recorded.</span>')
    + (canEditMaster() ? `<div style="margin-top:8px"><button class="btn btn-ghost btn-sm" id="cert-add">＋ Add certificate</button></div>` : '');
}
function addDaysISO(s, n){ const [y, m, d] = s.split('-').map(Number), x = new Date(y, m - 1, d + n);
  return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,'0')}-${String(x.getDate()).padStart(2,'0')}`; }
function openCert(c){
  CERT_EDIT = c ? c.id : null;
  $('cert-title').textContent = c ? 'Edit certificate' : 'Add certificate';
  $('cert-name').value = c ? c.name || '' : ''; $('cert-issuer').value = c ? c.issuer || '' : ''; $('cert-no').value = c ? c.cert_no || '' : '';
  $('cert-issue').value = c ? c.issue_date || '' : ''; $('cert-exp').value = c ? c.expiry_date || '' : ''; $('cert-notes').value = c ? c.notes || '' : '';
  $('cert-file').value = ''; $('cert-file-now').textContent = c && c.file_path ? 'A scan is attached — choose a new file only to replace it.' : '';
  openM('m-cert'); setTimeout(() => $('cert-name').focus(), 50);
}
document.addEventListener('click', async e => {
  if (e.target.closest('#cert-add')) return openCert(null);
  const ed = e.target.closest('[data-cert-edit]'); if (ed) return openCert(CERTS.find(c => c.id === ed.dataset.certEdit));
  const dl = e.target.closest('[data-cert-del]');
  if (dl){ const c = CERTS.find(x => x.id === dl.dataset.certDel); if (!c) return;
    return confirmDel(`Remove the certificate “${c.name}”?`, async () => { await del('employee_certificates', c.id); if (c.file_path) await sb.storage.from('certificates').remove([c.file_path]);
      toast('Certificate removed'); renderCerts(editingEmp); loadHRAlerts().then(hraBadge); }); }
  const f = e.target.closest('[data-cert-file]');
  if (f){ e.preventDefault(); const { data, error } = await sb.storage.from('certificates').createSignedUrl(f.dataset.certFile, 600);
    if (error || !data) return toast(error ? error.message : 'Could not open the file', 'err'); window.open(data.signedUrl, '_blank'); }
});
$('cert-save').addEventListener('click', async () => {
  const id = editingEmp; if (!id) return;
  const rec = { emp_id:String(id), name:$('cert-name').value.trim(), issuer:$('cert-issuer').value.trim() || null, cert_no:$('cert-no').value.trim() || null,
                issue_date:$('cert-issue').value || null, expiry_date:$('cert-exp').value || null, notes:$('cert-notes').value.trim() || null };
  if (!rec.name) return toast('Enter the certificate name', 'warn');
  if (rec.issue_date && rec.expiry_date && rec.expiry_date < rec.issue_date) return toast('The expiry date is before the issue date', 'warn');
  const file = $('cert-file').files[0];
  if (file && file.size > 10 * 1024 * 1024) return toast('The file is larger than 10 MB', 'warn');
  const btn = $('cert-save'); btn.disabled = true;
  try {
    if (file){ const path = `${id}/${Date.now()}-${file.name.replace(/[^A-Za-z0-9._-]+/g, '_')}`;
      const up = await sb.storage.from('certificates').upload(path, file, { upsert:false });
      if (up.error) throw up.error; rec.file_path = path; }
    if (!CERT_EDIT) rec.created_by = (ME && (ME.full_name || ME.email)) || null;
    const res = CERT_EDIT ? await sb.from('employee_certificates').update(rec).eq('id', CERT_EDIT).select() : await sb.from('employee_certificates').insert(rec).select();
    if (res.error) throw res.error; if (!(res.data && res.data.length)) throw new Error(NOPERM);
    closeM('m-cert'); toast('Certificate saved'); renderCerts(id); loadHRAlerts().then(hraBadge);
  } catch (err){ toast(err.message || String(err), 'err'); }
  btn.disabled = false;
});
const _openEmp26 = openEmp;
openEmp = function(id){ const r = _openEmp26.apply(this, arguments); renderEmpLeave(id); renderCerts(id); return r; };
// after an employee is saved, dates may have been filled in by the database (probation, contract end) — alerts follow
const _saveEmp26 = saveEmp;
saveEmp = async function(){ const r = await _saveEmp26.apply(this, arguments); LB.clear(); if (canHRA()) loadHRAlerts().then(hraBadge); return r; };
// the original hint functions were attached directly — attach the new ones too (they run last and replace the text)
['lv-emp','lv-t','lv-days'].forEach(id => $(id).addEventListener('input', () => leaveHint()));
['sl-type','sl-days'].forEach(id => $(id).addEventListener('input', () => slHint()));

// ═════════════════════════════════════════════════════════
//  HR OFFICERS SAVE EMPLOYEE MASTER DATA (database: 49-officer-edit-master-data.sql)
//  HR officers never read the employees table (pay fields) — they read employees_safe and save through
//  officer_save_employees(), which drops the pay fields. Every screen that saves an employee keeps working
//  unchanged: for an HR officer, sb.from('employees') is routed here.
// ═════════════════════════════════════════════════════════
function officerEmpWrite(kind, rec){
  const b = { ids:null,
    eq(c, v){ if (c === 'id') b.ids = [String(v)]; return b; },
    in(c, v){ if (c === 'id') b.ids = (v || []).map(String); return b; },
    select(){ return b; },
    then(res, rej){ return run().then(res, rej); } };
  async function run(){
    const recs = [].concat(rec || []);
    if (kind === 'insert'){
      const out = [];
      for (const r of recs){ const { data, error } = await sb.rpc('officer_save_employees', { p_ids:null, p_rec:r, p_insert:true });
        if (error) return { data:null, error }; out.push(...(data || [])); }
      return { data:out, error:null };
    }
    if (!b.ids || !b.ids.length) return { data:null, error:{ message:'Choose the employee to change' } };
    const { data, error } = await sb.rpc('officer_save_employees', { p_ids:b.ids, p_rec:recs[0] || {}, p_insert:false });
    return { data: error ? null : (data || []), error };
  }
  return b;
}
function officerPatch(client){
  if (!client || client.__officerPatch) return;
  const orig = client.from.bind(client);
  client.from = t => {
    if (t !== 'employees' || !isOfficer()) return orig(t);
    return { select: (...a) => orig('employees_safe').select(...a),          // reading: the version without pay fields
             update: rec => officerEmpWrite('update', rec),
             insert: rec => officerEmpWrite('insert', rec),
             upsert: rec => officerEmpWrite('insert', rec),
             delete: () => orig('employees').delete() };                      // still refused by the database
  };
  client.__officerPatch = true;
}
const _startApp27 = startApp;
startApp = async function(){ const r = await _startApp27.apply(this, arguments); officerPatch(sb); return r; };
const _afterLogin27 = afterLogin;
afterLogin = async function(){ officerPatch(sb); return _afterLogin27.apply(this, arguments); };
// HR officers: show the employee Save / New employee / Bulk upload controls (pay stays hidden)
const _afterLogin27b = afterLogin;
afterLogin = async function(){ const r = await _afterLogin27b.apply(this, arguments);
  document.body.classList.toggle('can-master', !!(ME && ['admin','hr','hr_officer'].includes(ME.role))); return r; };

// ── HR officers enter attendance, vacations, permissions, penalties (50). Penalties in days / hours of pay:
//    officers see the days / hours only — the money value would reveal the employee's pay.
const _renderPenalties27 = renderPenalties;
renderPenalties = function(){
  const r = _renderPenalties27.apply(this, arguments);
  if (!isOfficer()) return r;
  document.querySelectorAll('#pn-tbl tr[data-pen]').forEach(tr => { const x = S.penalties.find(p => String(p.id) === tr.dataset.pen);
    if (x && x.penalty_type !== 'Amount'){ const c = tr.children[4]; if (c){ c.textContent = '—'; c.title = 'Worked out in the payroll from the employee\'s pay'; } } });
  const thisP = S.penalties.filter(x => x.status === 'Approved' && x.apply_period === settings.period), amt = thisP.filter(x => x.penalty_type === 'Amount');
  $('pn-sub').textContent = `${thisP.length} approved penalt${thisP.length === 1 ? 'y' : 'ies'} in the ${periodLabel(settings.period)} payroll · ${fmt(amt.reduce((s, x) => s + num(x.quantity), 0))} EGP in fixed amounts`
    + (thisP.length > amt.length ? ` + ${thisP.length - amt.length} in days / hours of pay (worked out in the payroll)` : '');
  $('pn-foot').textContent = 'Click a row to edit · penalties in days or hours are turned into money by the payroll';
  return r;
};
const _penHint27 = penHint;
penHint = function(){
  if (!isOfficer()) return _penHint27.apply(this, arguments);
  const t = $('pn-type').value; $('pn-qty-l').textContent = t === 'Amount' ? 'Amount (EGP)' : t === 'Hours' ? 'Number of hours' : 'Number of days';
  const e = empById(parseEmpInput($('pn-emp').value)), qty = num($('pn-qty').value), out = [];
  if (e && qty) out.push(t === 'Amount' ? `Deduction: <b class="neg">${fmt(qty)} EGP</b>` : `Deduction: <b class="neg">${fmt(qty)} ${t === 'Hours' ? 'hour' : 'day'}${qty === 1 ? '' : 's'} of pay</b> (the payroll works out the amount)`);
  const d = $('pn-date').value, per = $('pn-period').value;
  if (d && per && per !== cycleOf(d)) out.push(`The incident belongs to the ${cycleOf(d)} payroll; it will be deducted in <b>${per}</b> instead.`);
  if (e && per){ const same = S.penalties.filter(x => x.id !== editingPen && String(x.emp_id) === String(e.id) && x.status === 'Approved' && x.apply_period === per);
    if (same.length) out.push(`Already ${same.length} approved penalt${same.length === 1 ? 'y' : 'ies'} for this employee in ${per}: ${same.map(penLabel).join(', ')}.`); }
  $('pn-hint').innerHTML = out.join('<br>');
};
// the vacation hint: no "deducts … daily pay" figure for officers
const _leaveHint27 = leaveHint;
leaveHint = function(){ const r = _leaveHint27.apply(this, arguments);
  if (isOfficer()) $('lv-hint').innerHTML = $('lv-hint').innerHTML.replace(/Unpaid: deducts [^<]*?per day in the payroll period it falls in\./, 'Unpaid: deducted in the payroll at the employee\'s daily pay.');
  return r; };
['pn-emp','pn-qty','pn-type','pn-period'].forEach(id => $(id).addEventListener('input', () => penHint()));

// ── employee window: show the contract end as soon as the start is typed (the database applies the same rule on Save)
function contractEndPreview(ev){
  const f = k => document.querySelector(`#emp-form [data-f="${k}"]`);
  const type = f('contract_type'), start = f('contract_start_date'), end = f('contract_end_date'); if (!type || !start || !end) return;
  let note = end.parentElement.querySelector('.ce-note');
  if (!note){ note = document.createElement('div'); note.className = 'ce-note'; note.style.cssText = 'font-size:11px;margin-top:4px;color:var(--muted)'; end.parentElement.appendChild(note); }
  if (type.value === 'Permanent'){ note.textContent = 'Permanent contract — no end date and no renewal alert. Choose Temporary or Contract for a one-year contract.'; return; }
  if (start.value && (!end.value || end.dataset.auto === '1') && (ev && (ev.target === start || ev.target === type))){
    end.value = addYearISO(addDaysISO(start.value, -1)); end.dataset.auto = '1';          // 1 Sep 2026 → 31 Aug 2027
  }
  note.textContent = start.value ? 'One year after the start, ending the day before.' : 'Enter the contract start — the end fills in by itself.';
}
document.addEventListener('input', e => { if (e.target.closest && e.target.closest('#emp-form') && /^(contract_type|contract_start_date)$/.test(e.target.dataset.f || '')) contractEndPreview(e); });
document.addEventListener('change', e => { if (e.target.closest && e.target.closest('#emp-form') && /^(contract_type|contract_start_date|contract_end_date)$/.test(e.target.dataset.f || '')){
  if (e.target.dataset.f === 'contract_end_date') e.target.dataset.auto = ''; else contractEndPreview(e); } });
const _openEmp27 = openEmp;
openEmp = function(){ const r = _openEmp27.apply(this, arguments); contractEndPreview(null); return r; };

// ═════════════════════════════════════════════════════════
//  FIT TO SCREEN WIDTH (16 Oct 2026)
//  One button in the top bar (HR app and self-service): shrinks the open page so wide tables fit the screen
//  without sideways scrolling. Click again for normal size. Remembered on this computer.
// ═════════════════════════════════════════════════════════
(function fitWidth(){
  const KEY = 'pk_fit_width';
  let on = false; try { on = localStorage.getItem(KEY) === '1'; } catch (e) {}
  const btns = [];
  document.querySelectorAll('.topbar-right').forEach(bar => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn btn-ghost btn-sm fit-btn';
    b.title = 'Fit wide tables to the screen width (click again for normal size)';
    const chip = bar.querySelector('.user-chip');
    chip ? bar.insertBefore(b, chip) : bar.appendChild(b);
    b.addEventListener('click', () => { on = !on; try { localStorage.setItem(KEY, on ? '1' : '0'); } catch (e) {} label(); fit(); });
    btns.push(b);
  });
  function label(){ btns.forEach(b => { b.textContent = on ? '↔ Normal size' : '↔ Fit width'; b.classList.toggle('btn-primary', on); b.classList.toggle('btn-ghost', !on); }); }

  const targets = () => [...document.querySelectorAll('#app .page.active, #self .main')].filter(el => el.offsetParent !== null);
  function fit(){
    document.querySelectorAll('#app .page:not(.active)').forEach(p => { p.style.zoom = ''; });
    targets().forEach(el => {
      el.style.zoom = '';
      if (!on) return;
      let z = 1;
      for (let i = 0; i < 4; i++) {                     // shrinking changes the layout a little, so measure again
        const avail = el.clientWidth;
        let need = el.scrollWidth;
        el.querySelectorAll('.tbl-wrap, .calv').forEach(w => {
          if (w.offsetParent !== null && w.scrollWidth > w.clientWidth + 2) need = Math.max(need, avail + (w.scrollWidth - w.clientWidth));
        });
        if (need <= avail + 2) break;
        z = Math.max(0.5, z * avail / need * 0.995);
        el.style.zoom = z.toFixed(3);
        if (z === 0.5) break;
      }
    });
  }
  window.fitWidthNow = fit;
  let t = null; const later = () => { clearTimeout(t); t = setTimeout(fit, 120); };
  window.addEventListener('resize', later);
  document.addEventListener('click', ev => { if (ev.target.closest('[data-page],[data-nav],[data-spage],.tab,.seg button')) later(); }, true);
  const mo = new MutationObserver(later);
  document.querySelectorAll('#app .main, #self .main').forEach(m => mo.observe(m, { childList: true, subtree: true }));
  label(); later();
})();

// ═════════════════════════════════════════════════════════
//  AUTO SIGN-OUT after 10 minutes without activity (21 Oct 2026, desktop only)
//  · Activity = mouse, keyboard, scroll or touch in ANY open tab of the app (shared through localStorage).
//  · At 9 minutes a window warns "You will be signed out in 60 seconds" with a button to stay signed in.
//  · At 10 minutes the app signs out and shows the sign-in screen with an explanation.
// ═════════════════════════════════════════════════════════
const IDLE_LIMIT_MS = 10 * 60 * 1000, IDLE_WARN_MS = 9 * 60 * 1000, IDLE_KEY = 'pk_last_active';
let idleLast = Date.now(), idleOut = false;
function idleStore(t){ try { localStorage.setItem(IDLE_KEY, String(t)); } catch(e){} }
function idleRead(){ try { return Number(localStorage.getItem(IDLE_KEY)) || 0; } catch(e){ return 0; } }
function idleSignedIn(){ return !!(typeof ME !== 'undefined' && ME && sb); }
function idleTouch(){
  const now = Date.now();
  if (now - idleLast > 5000) { idleLast = now; idleStore(now); }     // write at most every 5 s
  else idleLast = now;
  const w = $('m-idle'); if (w && w.classList.contains('open')) closeM('m-idle');
}
['mousemove','mousedown','keydown','wheel','scroll','touchstart'].forEach(ev => document.addEventListener(ev, idleTouch, { passive:true, capture:true }));
async function idleSignOut(){
  if (idleOut) return; idleOut = true;
  try { sessionStorage.setItem('pk_idle_out', '1'); } catch(e){}
  try { await sb.auth.signOut(); } catch(e){}
  location.reload();
}
function idleCheck(){
  if (!idleSignedIn() || idleOut) return;
  const last = Math.max(idleLast, idleRead()), quiet = Date.now() - last;
  if (quiet >= IDLE_LIMIT_MS) return idleSignOut();
  const w = $('m-idle');
  if (quiet >= IDLE_WARN_MS && w) {
    $('idle-sec').textContent = Math.max(1, Math.ceil((IDLE_LIMIT_MS - quiet) / 1000));
    if (!w.classList.contains('open')) openM('m-idle');
  } else if (w && w.classList.contains('open')) closeM('m-idle');
}
setInterval(idleCheck, 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) idleCheck(); });   // a computer waking from sleep
// the sign-in screen explains why the user was signed out
const showLoginBeforeIdle = showLogin;
showLogin = function(msg){
  let idle = false; try { idle = sessionStorage.getItem('pk_idle_out') === '1'; sessionStorage.removeItem('pk_idle_out'); } catch(e){}
  showLoginBeforeIdle(msg || (idle ? 'You were signed out automatically after 10 minutes without activity. Please sign in again.' : undefined));
};
// buttons of the "still there?" window (no onclick= in the page: the security policy forbids code inside the page)
$('idle-out').addEventListener('click', () => idleSignOut());
$('idle-stay').addEventListener('click', () => idleTouch());

// ═════════════════════════════════════════════════════════
//  DROP-DOWN LISTS for the employee window (21 Oct 2026)
//  University and College: the lists HR provided (Universities.xlsx, Faculty.xlsx) + any value already used on an
//  employee. Department: values in use. Unit: units already used in the chosen department. Every list ends with
//  "➕ Other…" to type a new value (it then appears in the list for everyone).
// ═════════════════════════════════════════════════════════
const PICK_UNIVERSITIES = ["جامعة القاهرة", "معهد الجزيرة العالى", "دبلوم المدارس الثانوية الفنية التجارية", "جامعة حلوان", "جامعة عين شمس", "الاكاديمية المصرية للهندسة و التكنولوجيا المتقدمة", "الاكاديمية العربية للعلووم والتكنولوجيا والنقل البحري", "جامعة 6 أكتوبر", "مودرن اكاديمى بالمعادى", "جامعة المنيا", "دبلوم المدارس الفنية الصناعية", "معهد العالى للإدارة و التكنولوجيا - شبرامنت", "شهادة قياس مستوى المهارة", "معهد الجزيرة العالى للحاسب الالى و نظم المعلومات الادارية", "معهد العباسية للحاسبات الآلية و العلوم التجارية", "ثانوية عامة", "دبلوم المدارس الثانوية الفنية للإدارة و الخدمات", "معهد القاهرة العالى للغات و الترجمه الفورية و العلوم الادارية", "جامعة المنوفية", "جامعة طنطا", "محو امية", "دبلوم المدارس الثانوية الفنية الزراعية", "مرحلة التعليم الاساسي", "معهد طيبة العالي لتكنولوجيا الادارة و المعلومات", "معهد الفراعنة العالي للحاسب الالي و نظم المعلومات و الادارة", "المعهد العالي للدراسات النوعية", "دبلوم المدارس الثانوية الفنية للشئون الفندقية والخدمات السياحية", "بدون مؤهل", "جامعة بنها", "الجامعة العمالية", "المعهد العالى للحاسبات و المعلومات و تكنولوجيا الادارة", "المعهد العالى للدراسات المتطورة", "جامعة المنصورة", "المعهد العالى للهندسة و التكنولوجيا", "الاكاديمية العربية للعلوم و التكنولوجيا و النقل البحرى", "معهد هندسة و تكنولوجيا الطيران", "المعهد الفنى الصناعى", "وزارة الانتاج الحربى", "المجمع التكنولوجى المتكامل", "المعهد الفني التجاري بالروضة", "معهد المدينة العالى للهندسة و التكنولوجيا - شبرامنت", "الازهر الشريف", "المعهد الفنى التجارى", "الجامعة الالمانية بالقاهرة", "المعهد العالى للدراسات التعاونية و الادارية", "الجهاز القومى لتنظيم الاتصالات", "جامعة الاهرام الكندية", "معهد طيبة العالى للهندسة", "جامعة الزقازيق", "جامعة الفيوم", "جامعة الاسكندرية", "المعهد التكنولوجى العالى", "جامعة بورسعيد", "جامعة مصر للعلوم و التكنولوجيا", "جامعة اكتوبر للعلوم الحديثة والاداب", "الجامعة الامريكية بالقاهرة", "جامعة السويس", "المعهد العالي للهندسة والتكنولوجيا بطنطا", "جامعة النيل", "جامعة سيجي الماليزية", "معهد اكتوبر العالى للهندسة و التكنولوجيا", "دبلوم التلمذة الصناعية", "معهد فني صناعي", "جامعة الازهر", "المعهد العالى للتعاون الزراعى", "المعهد العالي للهندسة بالشروق", "معهد القاهرة الجديدة للعلوم الاداربة و الحاسب الالي", "معهد الاهرامات العالي للهندسة والتكنولوجيا", "معهد الجيزة العالى للهندسة و التكنولوجيا", "ثانوي فني للصم و ضعاف السمع", "التكنولوجيا بالصحافة", "معهد الشروق", "جامعة حورس", "جاممة جنوب الوادي", "المعهد العالي للدراسات التعاونية و الادارية", "جامعة اسوان", "معهد الفراعنة العالي للسياحة و الفادق", "وزارة التجارة و الصناعه", "المعهد الفني التجاري", "معهد فني تجاري"];
const PICK_COLLEGES = ["نظم معلومات", "دبلوم تجارة", "بكالوريوس هندسة القوى و الالات الكهربية", "بكالوريوس فى الهندسة الميكانيكية", "بكالوريوس تجارة", "بكالوريوس الهندسة فى الميكاترونيات", "بكالوريوس فى الهندسة و التكنولوجيا", "دبلوم صنايع", "نظم المعلومات الادارية", "كهربائى", "بكالوريوس اعلام", "بكالوريوس فى التعليم الصناعى", "ليسانس حقوق", "دبلوم شئون فندقية", "ليسانس آداب", "ليسانس الالسن", "بكالوريوس فى الهندسة الإلكترونية", "بكالوريوس فى العلوم فى الهندسة الكهربائية", "محو امية", "دبلوم زراعة", "الاعدادية", "بكالوريوس العلوم التجارية", "الابتدائية", "دبلوم سياحة وفنادق", "بكالوريوس إدارة صناعية", "بكالوريوس فى الهندسة الكهربية و التحكم الآلى", "دبلوم المعاهد الفنيه الصناعية", "بكالوريوس هندسة الالكترونيات و الاتصالات الكهربية", "دبلوم تدريب مهنى", "بكالوريوس فى تكنولوجيا الكهرباء و الالكترونيات", "بكالوريوس الهندسة الكهربية و الحاسبات", "ثانوى ازهرى", "بكالوريوس اخصائى رقابة الجودة", "دبلوم المعاهد الفنية التجارية", "مشغل لاسلكى", "بكالوريوس ادارة", "بكالوريوس هندسة الحاسبات و الالكترونيات", "بكالوريوس هندسة اتصالات و كهروفيزياء", "بكالوريوس حاسبات و معلومات", "بكالوريوس فى العلوم شعبه فيزياء", "بكالوريوس في تكنولوجيا المعلومات", "بكالوريوس فى علوم الحاسب", "بكالوريوس ادارة الأعمال", "بكالوريوس هندسة انتاج", "بكالوريوس زراعه", "بكالوريوس تربية رياضية", "ليسانس اداب", "بكالوريوس هندسة الكهروميكانيكا", "بكالوريوس فى هندسة الاتصالات و الالكترونيات", "دبلوم الثانوي الفني للصم و ضعاف السمع", "معهد فني صناعي", "المعهد الدولي العالي للاعلام", "بكالوريوس الدراسات التعاونية و الادارية", "ادارة الاعمال السياحية", "دبلوم التلمذة الصناعية"];
const PICK_OTHER = '__other__';
const pickNorm = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
function pickOptions(src, dept){
  const used = k => (S.employees || []).map(e => pickNorm(e[k]));
  let list = src === 'univ' ? [...PICK_UNIVERSITIES, ...used('university')]
           : src === 'coll' ? [...PICK_COLLEGES, ...used('college')]
           : src === 'dept' ? used('department')
           : (S.employees || []).filter(e => !dept || pickNorm(e.department) === dept).map(e => pickNorm(e.unit));
  list = [...new Set(list.filter(Boolean))];
  const ar = src === 'univ' || src === 'coll';
  return list.sort((a, b) => a.localeCompare(b, ar ? 'ar' : 'en'));
}
function pickSelect(k, src, v, dept){
  v = pickNorm(v);
  const opts = pickOptions(src, dept); if (v && !opts.includes(v)) opts.unshift(v);
  const dir = (src === 'univ' || src === 'coll') ? ' dir="rtl"' : '';
  return `<select data-f="${k}" data-pick="${src}"${dir}><option value="">—</option>${opts.map(o => `<option${o === v ? ' selected' : ''}>${esc(o)}</option>`).join('')}`
       + `<option value="${PICK_OTHER}">➕ Other — type a new one…</option></select>`;
}
// choosing "Other" turns the list into a text box; changing the department refreshes the unit list
document.addEventListener('change', e => {
  const el = e.target; if (!el.closest || !el.closest('#emp-form') || !el.dataset || !el.dataset.pick) return;
  if (el.value === PICK_OTHER) {
    const inp = document.createElement('input'); inp.type = 'text'; inp.dataset.f = el.dataset.f;
    inp.placeholder = 'Type the new ' + (el.closest('.field').querySelector('label') || {}).textContent.toLowerCase() + '…';
    if (el.dir) inp.dir = el.dir; el.replaceWith(inp); inp.focus(); return;
  }
  if (el.dataset.pick === 'dept') {
    const u = document.querySelector('#emp-form [data-f="unit"]');
    if (u && u.tagName === 'SELECT') { const keep = pickOptions('unit', el.value).includes(u.value) ? u.value : ''; u.outerHTML = pickSelect('unit', 'unit', keep, el.value); }   // a unit of another department is cleared
  }
});

// ═════════════════════════════════════════════════════════
//  DOCUMENT REQUESTS from the HR alerts page (61-document-requests.sql, 21 Oct 2026)
//  National ID alerts: "📄 Request new ID" → the employee answers from the phone with a photo + the new expiry date →
//  HR views the copy, Accepts (the employee's ID expiry date is updated, the alert disappears) or Returns it with a note.
// ═════════════════════════════════════════════════════════
let DOCS = { byEmp: new Map(), missing: false }, DOC_PICK = null;
async function loadDocRequests(){
  const r = await sb.from('doc_requests').select('*').eq('kind', 'national_id').neq('status', 'Cancelled').order('requested_at', { ascending:false });
  DOCS.missing = !!r.error; DOCS.byEmp = new Map();
  (r.data || []).forEach(d => { if (!DOCS.byEmp.has(d.emp_id)) DOCS.byEmp.set(d.emp_id, d); });     // latest per employee
}
const docOpen = d => d && ['Requested', 'Submitted', 'Returned'].includes(d.status);
const docDay = t => t ? new Date(t).toLocaleDateString('en-GB', { day:'numeric', month:'short' }) : '';
// the status line + buttons shown on a national-ID alert row
function hraDocCell(a){
  if (DOCS.missing) return '';
  const d = DOCS.byEmp.get(a.emp_id);
  if (d && d.status === 'Submitted') return `<div style="margin-bottom:4px"><span class="chip c-blue">📄 Copy received ${esc(docDay(d.submitted_at))}</span></div>
      <button class="btn btn-ghost btn-sm" data-doc-view="${esc(d.id)}">👁 View copy</button> <button class="btn btn-success btn-sm" data-doc-ok="${esc(d.id)}">✓ Accept</button> <button class="btn btn-ghost btn-sm" data-doc-back="${esc(d.id)}">↩ Return</button> `;
  if (docOpen(d)) return `<div style="margin-bottom:4px"><span class="chip c-orange" title="${esc(d.review_note || '')}">📄 ${d.status === 'Returned' ? 'Returned' : 'Requested'} ${esc(docDay(d.status === 'Returned' ? d.reviewed_at : d.requested_at))} — waiting for the employee</span></div>
      <button class="btn btn-ghost btn-sm" data-doc-cancel="${esc(d.id)}">Cancel request</button> `;
  return `<button class="btn btn-primary btn-sm" data-doc-req="${esc(a.emp_id)}">📄 Request new ID</button> `;
}
function docModal(title, html, okText, okClass, onOk){
  $('doc-m-title').textContent = title; $('doc-m-body').innerHTML = html;
  $('doc-m-ok').textContent = okText; $('doc-m-ok').className = 'btn ' + okClass;
  $('doc-m-ok').onclick = async () => { $('doc-m-ok').disabled = true; try { await onOk(); } catch(e){ toast(e.message, 'err'); } $('doc-m-ok').disabled = false; };
  openM('m-doc');
}
const DOC_MSG = 'Your national ID card has expired (or expires soon). Please send a photo of the renewed card. · بطاقة الرقم القومي منتهية أو قاربت على الانتهاء — يرجى إرسال صورة البطاقة الجديدة.';
function docRequest(emps){
  const n = emps.length, who = n === 1 ? `<b>${esc(empName(empById(emps[0])) || emps[0])}</b> (${esc(emps[0])})` : `<b>${n}</b> employees`;
  docModal('📄 Request the renewed national ID',
    `<p style="color:var(--label)">${who} will get a request in the phone app (and a notification) to attach a photo of the new ID card and its expiry date.</p>
     <div class="field"><label>Message to the employee (optional)</label><textarea id="doc-msg" rows="3">${esc(DOC_MSG)}</textarea></div>`,
    n === 1 ? 'Send request' : `Send ${n} requests`, 'btn-primary', async () => {
      const { data, error } = await sb.rpc('request_documents', { p_emps: emps, p_kind: 'national_id', p_message: $('doc-msg').value.trim() });
      if (error) throw error;
      closeM('m-doc'); toast(`${data} request${data === 1 ? '' : 's'} sent${data < n ? ` · ${n - data} skipped (already asked, or not active)` : ''}`);
      await loadDocRequests(); renderHRAlerts();
    });
}
document.addEventListener('click', async e => {
  const rq = e.target.closest('[data-doc-req]'); if (rq) return docRequest([rq.dataset.docReq]);
  if (e.target.closest('#hra-doc-all')) {
    const emps = [...new Set([...document.querySelectorAll('#hra-tbl [data-doc-req]')].map(b => b.dataset.docReq))];
    return emps.length ? docRequest(emps) : toast('Every national-ID alert listed already has a request', 'warn');
  }
  const vw = e.target.closest('[data-doc-view]');
  if (vw) { const d = [...DOCS.byEmp.values()].find(x => x.id === vw.dataset.docView); if (!d) return;
    const { data, error } = await sb.storage.from('employee-docs').createSignedUrl(d.file_path, 600);
    return error ? toast(error.message, 'err') : window.open(data.signedUrl, '_blank', 'noopener'); }
  const ok = e.target.closest('[data-doc-ok]');
  if (ok) { const d = [...DOCS.byEmp.values()].find(x => x.id === ok.dataset.docOk); if (!d) return;
    return docModal('✓ Accept the new ID',
      `<p style="color:var(--label)"><b>${esc(empName(empById(d.emp_id)) || d.emp_id)}</b> (${esc(d.emp_id)}) sent the copy on ${esc(docDay(d.submitted_at))}. Check the photo first (👁 View copy).</p>
       <div class="field"><label>New national ID expiry date (as typed by the employee — correct it if the card shows another date)</label><input type="date" id="doc-exp" value="${esc(d.new_expiry || '')}"></div>`,
      'Accept and update the date', 'btn-success', async () => {
        const { error } = await sb.rpc('review_document', { p_id: d.id, p_accept: true, p_new_expiry: $('doc-exp').value || null, p_note: null });
        if (error) throw error;
        const emp = empById(d.emp_id); if (emp) emp.national_id_expiry = $('doc-exp').value;
        closeM('m-doc'); toast('Accepted — the national ID expiry date is updated'); await loadDocRequests(); await loadHRAlerts(); renderHRAlerts();
      }); }
  const bk = e.target.closest('[data-doc-back]');
  if (bk) { const d = [...DOCS.byEmp.values()].find(x => x.id === bk.dataset.docBack); if (!d) return;
    return docModal('↩ Return to the employee',
      `<p style="color:var(--label)">The employee is asked to send it again, with your note.</p>
       <div class="field"><label>What is wrong? (the employee sees this)</label><textarea id="doc-note" rows="3" placeholder="e.g. The photo is not clear — please take it again in good light · الصورة غير واضحة"></textarea></div>`,
      'Return', 'btn-danger', async () => {
        const { error } = await sb.rpc('review_document', { p_id: d.id, p_accept: false, p_new_expiry: null, p_note: $('doc-note').value.trim() });
        if (error) throw error;
        closeM('m-doc'); toast('Returned to the employee'); await loadDocRequests(); renderHRAlerts();
      }); }
  const cn = e.target.closest('[data-doc-cancel]');
  if (cn) return confirmDel('Cancel this document request? The employee will no longer see it.', async () => {
    const { error } = await sb.rpc('cancel_document_request', { p_id: cn.dataset.docCancel }); if (error) throw error;
    toast('Request cancelled'); await loadDocRequests(); renderHRAlerts(); });
});

// ═════════════════════════════════════════════════════════
//  PAYROLL RUN TABLE — compact / expanded view + a search box under every column (21 Oct 2026)
//   · Compact: Basic, Other add., OT, Gross, Soc. Ins., Loans, Other ded., Net (as before).
//   · Expanded: one column per addition element, Gross, one column per deduction element, Total ded., Net.
//   · Number boxes accept  >1000   <500   >=0   =0   1000-2000   or plain digits (contains). Text boxes: contains.
//   · The last row totals the rows that are showing.
// ═════════════════════════════════════════════════════════
let PAY_EXP = (() => { try { return localStorage.getItem('payExpanded') === '1'; } catch (e) { return false; } })();
let PAY_F = {}, PAY_SIG = '', PAY_LIST = [];

function payElCols(list, type){
  const M = new Map();
  list.forEach(r => (r.lines || []).forEach(l => {
    if (l.type !== type) return;
    const k = String(l.code);
    if (!M.has(k)) { const el = elByCode(l.code);
      M.set(k, { code: num(l.code), name: l.code === 0 ? 'Basic (employee record)' : (el && el.name_en) || String(l.name || '').replace(/ — automatic$/, '') }); }
  }));
  return [...M.entries()].sort((a, b) => a[1].code - b[1].code).map(([k, x]) => ({
    k: (type === 'Addition' ? 'a' : 'd') + k, t: (x.code ? x.code + ' · ' : '') + x.name, n: 1, neg: type === 'Deduction', el: 1,
    v: r => (r.lines || []).filter(l => l.type === type && String(l.code) === k).reduce((s, l) => s + num(l.amount), 0) }));
}
function payCols(list){
  const name = { k: 'name', t: 'Name', v: r => empName(r.emp), s: r => [r.emp.name_en, r.emp.name_ar].join(' '),
                 h: r => `${esc(empName(r.emp))}${r.joiner ? ' <span class="chip c-blue">Joiner</span>' : ''}${r.leaver ? ' <span class="chip c-orange">Leaver</span>' : ''}`, cls: 'strong' };
  const days = { k: 'days', t: 'Days', v: r => r.partial ? String(r.days) : 'full',
                 h: r => r.partial ? `<span style="color:var(--warn)">${esc(r.days)}</span>` : 'full', cls: 'num' };
  const head = [{ k: 'code', t: 'Code', v: r => String(r.emp.id), cls: 'mono' }, name, { k: 'dept', t: 'Department', v: r => r.emp.department || '' }];
  const N = (k, t, f, o = {}) => ({ k, t, v: f, n: 1, ...o });
  if (!PAY_EXP) return [...head, days,
    N('basic', 'Basic', r => r.basic), N('oadd', 'Other add.', r => r.otherAdd), N('ot', 'OT', r => r.ot),
    N('gross', 'Gross', r => r.gross, { b: 1 }), N('si', 'Soc. Ins.', r => r.si, { neg: 1 }), N('loans', 'Loans', r => r.loans, { neg: 1 }),
    N('oded', 'Other ded.', r => r.otherDed, { neg: 1 }), N('net', 'Net', r => r.net, { b: 1, pos: 1 })];
  return [...head, { k: 'unit', t: 'Unit', v: r => r.emp.unit || '' }, days,
    ...payElCols(list, 'Addition'), N('gross', 'Gross', r => r.gross, { b: 1, tot: 1 }),
    ...payElCols(list, 'Deduction'), N('ded', 'Total ded.', r => r.ded, { neg: 1, tot: 1 }), N('net', 'Net', r => r.net, { b: 1, pos: 1, tot: 1 })];
}
function payNumMatch(val, f){
  f = f.replace(/,/g, '').replace(/\s+/g, ''); let m;
  if ((m = f.match(/^(>=|<=|>|<|=)(-?\d+(?:\.\d+)?)$/))) { const x = +m[2];
    return { '>': val > x + 0.004, '<': val < x - 0.004, '>=': val >= x - 0.004, '<=': val <= x + 0.004, '=': Math.abs(val - x) < 0.005 }[m[1]]; }
  if ((m = f.match(/^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/))) return val >= +m[1] - 0.004 && val <= +m[2] + 0.004;
  return String(Math.round(val * 100) / 100).includes(f);
}
function payRowMatch(r, cols){
  return cols.every(c => {
    const f = String(PAY_F[c.k] || '').trim(); if (!f) return true;
    if (c.n) return payNumMatch(num(c.v(r)), f);
    return String(c.s ? c.s(r) : c.v(r)).toLowerCase().includes(f.toLowerCase());
  });
}
function payCell(c, r){
  if (c.h) return `<td class="${c.cls || ''}">${c.h(r)}</td>`;
  if (!c.n) return `<td class="${c.cls || ''}">${esc(c.v(r))}</td>`;
  const v = num(c.v(r));
  return `<td class="num${c.b ? ' strong' : ''}${c.neg && v ? ' neg' : ''}${c.pos ? ' pos' : ''}">${v || c.b ? fmt(v) : '—'}</td>`;
}
function renderPayTable(list){
  PAY_LIST = list;
  const cols = payCols(lastRun);                       // columns from the whole run, so they don't jump while filtering
  const sig = (PAY_EXP ? 'x' : 'c') + cols.map(c => c.k).join(',');
  $('pay-table').classList.toggle('pay-expanded', PAY_EXP);
  $('pay-exp').textContent = PAY_EXP ? '⊟ Compact view' : '⊞ Expanded view';
  if (sig !== PAY_SIG) {
    PAY_SIG = sig;
    Object.keys(PAY_F).forEach(k => { if (!cols.some(c => c.k === k)) delete PAY_F[k]; });
    $('pay-thead').innerHTML = `<tr>${cols.map(c => `<th class="${c.n ? 'num' : ''}${c.el ? ' pay-el' : ''}${c.tot ? ' pay-tot' : ''}" title="${esc(c.t)}">${esc(c.t)}</th>`).join('')}</tr>
      <tr class="pay-filter">${cols.map(c => `<th><input data-pf="${c.k}" value="${esc(PAY_F[c.k] || '')}" placeholder="filter" title="${c.n ? 'Numbers: >1000  <500  =0  1000-2000  or digits' : 'Type part of the text'}"></th>`).join('')}</tr>`;
  }
  const rows = list.filter(r => payRowMatch(r, cols));
  $('pay-tbl').innerHTML = rows.map(r => `<tr class="click" data-slip="${esc(r.emp.id)}">${cols.map(c => payCell(c, r)).join('')}</tr>`).join('')
    || `<tr><td colspan="${cols.length}" class="empty">No employees match</td></tr>`;
  $('pay-tfoot').innerHTML = rows.length ? `<tr>${cols.map((c, i) => i === 0 ? `<td class="strong">Total</td>`
      : i === 1 ? `<td style="color:var(--muted)">${rows.length} employee${rows.length > 1 ? 's' : ''}</td>`
      : c.n ? `<td class="num strong">${fmt(rows.reduce((s, r) => s + num(c.v(r)), 0))}</td>` : '<td></td>').join('')}</tr>` : '';
  const nf = Object.values(PAY_F).filter(v => String(v).trim()).length;
  $('pay-fclear').style.display = nf ? '' : 'none';
  $('pay-foot').textContent = `Showing ${rows.length} of ${lastRun.length}${nf ? ` · ${nf} column filter${nf > 1 ? 's' : ''} on` : ''}. The cards above total all employees; the last table row totals the rows showing.`;
}
$('pay-exp').addEventListener('click', () => {
  PAY_EXP = !PAY_EXP; try { localStorage.setItem('payExpanded', PAY_EXP ? '1' : '0'); } catch (e) {}
  renderPayTable(PAY_LIST);
});
$('pay-fclear').addEventListener('click', () => {
  PAY_F = {}; document.querySelectorAll('#pay-thead [data-pf]').forEach(i => i.value = ''); renderPayTable(PAY_LIST);
});
$('pay-thead').addEventListener('input', ev => {
  const i = ev.target.closest('[data-pf]'); if (!i) return;
  PAY_F[i.dataset.pf] = i.value; renderPayTable(PAY_LIST);
});

// ═════════════════════════════════════════════════════════
//  BOARD MEMBER DASHBOARD — pending requests from managers, in three groups (22 Oct 2026)
//  Shown only to the super admin / board approver (Dalia). Read-only overview; a row opens the same
//  detail window as the Employee voice page.
//   1. Hiring requests (any manager)                — status New / In progress
//   2. Other requests from the DIRECTORS            — penalties / incentives / variable elements (waiting for the
//   3. Other requests from the other managers          board member or HR) and training requests (New / In progress)
// ═════════════════════════════════════════════════════════
const DIRECTORS = ['189', '212', '333', '748'];   // Hamdy Ragab · Ghadeer Nassar · Khaled Aman · Tamer Nour (employee codes)
let BRD = { at: 0, busy: false };
const isBoardViewer = () => !!(ME && (ME.super_admin || ME.board_approver));

async function loadBoardRequests(force){
  if (BRD.busy || (!force && Date.now() - BRD.at < 60000)) return false;
  BRD.busy = true;
  try {
    const [h, t, m] = await Promise.all([
      sb.from('hiring_requests').select('*').in('status', ['New', 'In progress']).order('created_at', { ascending: false }),
      sb.from('training_requests').select('*').in('status', ['New', 'In progress']).order('created_at', { ascending: false }),
      sb.from('manager_actions').select('*').in('status', ['Waiting for board', 'Waiting for HR']).order('created_at', { ascending: false })]);
    const merge = (arr, rows) => { const ids = new Set(rows.map(r => r.id)); return [...rows, ...arr.filter(r => !ids.has(r.id))]; };
    V.hire = merge(V.hire, h.data || []); V.train = merge(V.train, t.data || []); V.act = merge(V.act, m.data || []);   // the row click reuses V
    BRD.hire = h.data || []; BRD.train = t.data || []; BRD.act = m.data || []; BRD.at = Date.now();
    return true;
  } finally { BRD.busy = false; }
}
function boardRow(kind, x){
  const who = kind === 'act' ? (x.manager_name ? `${x.manager_name} (${x.manager_emp})` : vName(x.manager_emp)) : vName(x.manager_emp);
  const what = kind === 'hire' ? `👥 <b>${esc(x.headcount)} × ${esc(x.job_name)}</b>${x.needed_by ? ` <span style="color:var(--muted)">· needed by ${esc(x.needed_by)}</span>` : ''}`
    : kind === 'train' ? `🎓 Training: <b>${esc(x.topic)}</b> <span style="color:var(--muted)">· ${(x.emp_ids || []).length} employee${(x.emp_ids || []).length === 1 ? '' : 's'}</span>`
    : `${x.kind === 'penalty' ? '⚖️ Penalty' : '💰 ' + esc(x.element_name || 'Incentive')} for <b>${esc(x.emp_name || vName(x.emp_id))}</b>
       <span style="color:var(--muted)">· ${fmt(x.quantity)} ${x.action_type === 'Amount' ? 'EGP' : x.action_type === 'Days' ? 'day(s)' : 'hour(s)'} · ${esc(x.apply_period || '')}</span>`;
  const mine = kind === 'act' && x.status === 'Waiting for board';
  return `<tr data-vo="${kind}:${esc(x.id)}" style="cursor:pointer${mine ? ';background:rgba(224,123,57,.08)' : ''}">
    <td class="mono" style="white-space:nowrap">${esc(vDate(x.created_at))}</td><td>${esc(who)}</td><td style="white-space:normal">${what}</td>
    <td>${mine ? '<span class="chip c-orange">Waiting for your approval</span>' : vChip(x.status)}</td></tr>`;
}
function boardGroup(icon, title, rows, empty){
  return `<div class="sec" style="margin:14px 0 6px">${icon} ${title} <span class="chip ${rows.length ? 'c-orange' : 'c-grey'}" style="margin-left:6px">${rows.length}</span></div>
    ${rows.length ? `<div class="tbl-wrap"><table><thead><tr><th style="width:110px">Sent</th><th style="width:240px">From</th><th>Request</th><th style="width:190px">Status</th></tr></thead>
      <tbody>${rows.join('')}</tbody></table></div>` : `<div style="font-size:12px;color:var(--muted);padding:4px 0 6px">${empty}</div>`}`;
}
function renderBoardRequests(){
  const box = $('dash-board'); if (!box) return;
  if (!isBoardViewer()) { box.innerHTML = ''; return; }
  if (!BRD.at) { box.innerHTML = ''; return; }
  const isDir = id => DIRECTORS.includes(String(id));
  const byDate = (a, b) => String(b.x.created_at).localeCompare(String(a.x.created_at));
  const other = [...BRD.train.map(x => ({ k: 'train', x })), ...BRD.act.map(x => ({ k: 'act', x }))].sort(byDate);
  const hire = BRD.hire.map(x => boardRow('hire', x));
  const dir = other.filter(o => isDir(o.x.manager_emp)).map(o => boardRow(o.k, o.x));
  const mgr = other.filter(o => !isDir(o.x.manager_emp)).map(o => boardRow(o.k, o.x));
  const waiting = BRD.act.filter(x => x.status === 'Waiting for board').length;
  box.innerHTML = `<div class="card" style="padding:16px 18px;margin-bottom:16px">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
      <div class="toolbar-title">📋 Pending requests from managers</div>
      <div style="font-size:12px;color:var(--muted)">${waiting ? `<b style="color:var(--warn)">${waiting} waiting for your approval</b> (approve on the phone app → Approvals) · ` : ''}click a row for details</div></div>
    ${boardGroup('👥', 'Hiring requests from managers', hire, 'No open hiring requests.')}
    ${boardGroup('⭐', 'Other requests from directors', dir, 'Nothing pending from the directors.')}
    ${boardGroup('🧑‍💼', 'Other requests from other managers', mgr, 'Nothing pending from other managers.')}
  </div>`;
}
const _renderDashboardBoard = renderDashboard;
renderDashboard = function(){
  const r = _renderDashboardBoard.apply(this, arguments);
  if (isBoardViewer()) { renderBoardRequests(); loadBoardRequests(false).then(ch => { if (ch) renderBoardRequests(); }).catch(() => {}); }
  else { const b = $('dash-board'); if (b) b.innerHTML = ''; }
  return r;
};

// ═════════════════════════════════════════════════════════
//  OUTSIDE MISSIONS — HR final approval page (66, 22 Oct 2026)
//  The employee asks (→ direct manager → HR) or the manager assigns (→ employee acknowledges → HR) on the phone.
//  HR / HR officers give the final approval here. An approved mission day: no late / early deduction,
//  no "outside the site" warning, and the mission's project is allowed for check-in.
// ═════════════════════════════════════════════════════════
let MS = { rows: [], loaded: false };
const msStatusChip = s => `<span class="chip ${({'Waiting for HR':'c-orange','Waiting for manager':'c-blue','Waiting for employee':'c-blue',Approved:'c-green',Rejected:'c-red',Cancelled:'c-grey'})[s] || 'c-grey'}">${esc(s)}</span>`;
const msWhen = m => `${m.date_from}${m.date_to !== m.date_from ? ' → ' + m.date_to : ''}${m.time_from ? ` · ${String(m.time_from).slice(0,5)}–${String(m.time_to).slice(0,5)}` : ''}`;
async function loadMissions(){
  const { data, error } = await sb.from('employee_missions').select('*').order('created_at', { ascending: false }).limit(1000);
  if (error) { MS.rows = []; MS.error = /does not exist|schema cache/i.test(error.message) ? 'missing' : error.message; return; }
  MS.rows = data || []; MS.error = null; MS.loaded = true;
  const n = MS.rows.filter(m => m.status === 'Waiting for HR').length, b = $('ms-badge');
  if (b) { b.style.display = n ? '' : 'none'; b.textContent = n; }
}
async function renderMissions(){
  await loadMissions();
  if (MS.error) { $('ms-tbl').innerHTML = `<tr><td colspan="9" class="empty">${MS.error === 'missing' ? 'Missions are not set up yet — run database file 66-outside-missions.sql in the database SQL Editor.' : esc(MS.error)}</td></tr>`; return; }
  const st = $('ms-status').value, q = $('ms-q').value.trim().toLowerCase();
  const rows = MS.rows.filter(m => {
    if (st === 'open' ? !['Waiting for HR', 'Waiting for manager', 'Waiting for employee'].includes(m.status) : st && m.status !== st) return false;
    const e = empById(m.emp_id) || {};
    if (!orgMatch(e, 'ms')) return false;
    return !q || [m.emp_id, e.name_en, e.name_ar, m.place, m.purpose, m.project_code].some(v => String(v || '').toLowerCase().includes(q));
  });
  const wait = MS.rows.filter(m => m.status === 'Waiting for HR').length;
  $('ms-sub').textContent = `${wait} waiting for HR approval · ${MS.rows.length} in total`;
  $('ms-tbl').innerHTML = rows.map(m => { const e = empById(m.emp_id) || { id: m.emp_id, name_en: m.emp_name }, mg = m.manager_id ? empById(m.manager_id) : null;
    const step = m.origin === 'manager'
      ? `Assigned by ${esc(mg ? empName(mg) : m.manager_id)}${m.no_app ? ' · <span class="chip c-grey">employee does not use the app</span>' : m.ack_at ? ` · <span class="pos">✔ acknowledged ${esc(String(m.ack_at).slice(0,16).replace('T',' '))}</span>` : ' · not acknowledged yet'}`
      : (m.manager_id ? `Asked by the employee · manager ${m.manager_by ? (m.status === 'Rejected' && !m.hr_by ? '✕ rejected' : '✔ approved') + ' by ' + esc(m.manager_by) : esc(mg ? empName(mg) : m.manager_id) + ' — not decided'}` : 'Asked by the employee · no direct manager');
    return `<tr><td class="mono" style="white-space:nowrap">${esc(String(m.created_at).slice(0,10))}</td>
      <td class="strong">${esc(empName(e) || m.emp_id)} <span class="mono" style="color:var(--muted)">${esc(m.emp_id)}</span><div style="font-size:11px;color:var(--muted)">${esc(e.department || '')}</div></td>
      <td class="mono" style="white-space:nowrap">${esc(msWhen(m))}</td>
      <td style="white-space:normal;max-width:260px"><b>${esc(m.place)}</b>${m.purpose ? `<div style="font-size:12px;color:var(--muted)">${esc(m.purpose)}</div>` : ''}</td>
      <td class="mono">${esc(m.project_code || '—')}</td>
      <td style="white-space:normal;max-width:260px;font-size:12px">${step}${m.manager_note ? `<div>💬 ${esc(m.manager_note)}</div>` : ''}</td>
      <td>${msStatusChip(m.status)}${m.hr_by ? `<div style="font-size:11px;color:var(--muted)">${esc(m.hr_by)}</div>` : ''}${m.hr_note ? `<div style="font-size:11px">💬 ${esc(m.hr_note)}</div>` : ''}</td>
      <td style="white-space:nowrap">${m.status === 'Waiting for HR' ? `<button class="btn btn-success btn-sm" data-ms-ok="${m.id}">✓ Approve</button> <button class="btn btn-ghost btn-sm" data-ms-no="${m.id}">✕ Reject</button>` : ''}</td></tr>`; }).join('')
    || '<tr><td colspan="8" class="empty">No missions match</td></tr>';
  $('ms-foot').textContent = `${rows.length} shown. Approving makes the day(s) count without late / early deductions; the employee still checks in and out on the phone.`;
}
async function msDecide(id, ok){
  let note = null;
  if (!ok) { note = prompt('Reason for rejecting (the employee and his manager will see it):'); if (note === null) return; if (!note.trim()) return toast('Write the reason', 'warn'); }
  const { error } = await sb.rpc('hr_decide_mission', { p_id: id, p_approve: ok, p_note: note });
  if (error) return toast(error.message, 'err');
  toast(ok ? 'Mission approved — the employee and his manager are notified' : 'Mission rejected — the employee and his manager are notified');
  await renderMissions();
  // fix 25 Oct: loadPeriodData() shows the "Loading period…" cover — always hide it again (it stayed on screen for ever)
  if (ok) { try { await loadPeriodData(); } catch(e){ toast('Reload error — ' + e.message, 'err'); } finally { loader(false); } DIRTY.add('payroll'); DIRTY.add('reports'); }
}
PAGE_RENDER.missions = () => renderMissions();
$('ms-tbl').addEventListener('click', e => {
  const a = e.target.closest('[data-ms-ok]'); if (a) { a.disabled = true; return msDecide(a.dataset.msOk, true); }
  const r = e.target.closest('[data-ms-no]'); if (r) return msDecide(r.dataset.msNo, false);
});
['ms-status', 'ms-dept'].forEach(id => $(id).addEventListener('change', renderMissions));
$('ms-q').addEventListener('input', () => { clearTimeout(MS.t); MS.t = setTimeout(renderMissions, 250); });
const _loadPeriodDataMs = loadPeriodData;
loadPeriodData = async function(){ const r = await _loadPeriodDataMs.apply(this, arguments); loadMissions().catch(() => {}); return r; };
// always fresh when the page is opened (new requests arrive from phones all day)
const _showPageMs = showPage;
showPage = function(name){ const r = _showPageMs.apply(this, arguments); if (name === 'missions') renderMissions(); return r; };

// ═════════════════════════════════════════════════════════
//  OUTSIDE MISSIONS in desktop SELF-SERVICE (66/68, 22 Oct 2026) — same rules as the phone:
//  employee asks → direct manager → HR · manager assigns → employee acknowledges (or straight to HR if he does not use the app) → HR
// ═════════════════════════════════════════════════════════
let SMIS = { mine: [], team: [], assign: false, part: false };
const smisWhen = m => `${m.date_from}${m.date_to !== m.date_from ? ' → ' + m.date_to : ''}${m.time_from ? ` · ${String(m.time_from).slice(0,5)}–${String(m.time_to).slice(0,5)}` : ''}`;
function smisStatus(m, asManager){
  if (m.origin === 'manager' && m.status === 'Waiting for HR')
    return `<span class="chip c-blue">${m.no_app ? 'Sent to HR — does not use the app' : asManager ? 'Acknowledged — waiting for HR' : 'You acknowledged — waiting for HR'}</span>`;
  if (m.status === 'Waiting for manager') return `<span class="chip c-orange">${asManager ? 'Waiting for you' : 'Waiting for your manager'}</span>`;
  if (m.status === 'Waiting for employee') return `<span class="chip c-orange">${asManager ? 'Waiting for the employee to acknowledge' : 'Waiting for you to acknowledge'}</span>`;
  return chip(m.status);
}
async function loadSelfMissions(){
  const id = SELF.me && SELF.me.emp_id; if (!id) return;
  const [a, b] = await Promise.all([
    sb.from('employee_missions').select('*').eq('emp_id', id).order('created_at', { ascending: false }).limit(100),
    sb.from('employee_missions').select('*').eq('manager_id', id).neq('emp_id', id).order('created_at', { ascending: false }).limit(200)]);
  SMIS.missing = !!(a.error && /does not exist|schema cache/i.test(a.error.message));
  SMIS.mine = a.data || []; SMIS.team = b.data || [];
}
function renderSelfMissions(){
  $('smis-new').style.display = SMIS.missing ? 'none' : '';
  // assigned to me, waiting for my acknowledgement
  const ack = SMIS.mine.filter(m => m.status === 'Waiting for employee');
  $('smis-ack').innerHTML = ack.map(m => `<div class="alert a-warn" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
      <div style="flex:1;min-width:240px">🚗 <b>Your manager assigned you a mission:</b> ${esc(m.place)} · ${esc(smisWhen(m))}${m.project_code ? ' · ' + esc(m.project_code) : ''}${m.purpose ? `<div style="font-size:12px">💬 ${esc(m.purpose)}</div>` : ''}</div>
      <button class="btn btn-success btn-sm" data-smis-ack="${esc(m.id)}">✋ I undertake this mission</button></div>`).join('');
  // my missions inside "My requests"
  const rows = SMIS.mine.map(m => `<tr><td class="mono" style="white-space:nowrap">${esc(fmtSent(m.created_at))}</td><td class="strong">🚗 Outside mission${m.origin === 'manager' ? '<div style="font-size:11px;color:var(--muted)">assigned by your manager</div>' : ''}</td>
      <td style="white-space:normal;min-width:200px">${esc(m.place)} · ${esc(smisWhen(m))}${m.project_code ? ' · ' + esc(m.project_code) : ''}${m.purpose ? ' · ' + esc(m.purpose) : ''}</td>
      <td>${smisStatus(m, false)}</td><td style="white-space:normal;min-width:160px">${esc([m.manager_note, m.hr_note].filter(Boolean).join(' · '))}</td>
      <td>${m.origin === 'employee' && ['Waiting for manager', 'Waiting for HR'].includes(m.status) ? `<button class="btn btn-ghost btn-sm" data-smis-cancel="${esc(m.id)}">Cancel</button>` : ''}</td></tr>`).join('');
  const tb = $('self-list');
  if (rows) { if (/class="empty"/.test(tb.innerHTML)) tb.innerHTML = ''; tb.insertAdjacentHTML('afterbegin', rows); }
  // the manager's team
  const myTeam = SD.myTeam || [];
  $('smis-card').style.display = (myTeam.length || SMIS.team.length) && !SMIS.missing ? '' : 'none';
  $('smis-assign').style.display = myTeam.length ? '' : 'none';
  const L = SMIS.team.slice().sort((a, b) => ((a.status === 'Waiting for manager' ? 0 : 1) - (b.status === 'Waiting for manager' ? 0 : 1)) || String(b.created_at).localeCompare(String(a.created_at)));
  $('smis-tbl').innerHTML = L.slice(0, 100).map(m => { const mine = m.status === 'Waiting for manager';
    return `<tr><td class="strong">${esc(m.emp_name || m.emp_name_ar || m.emp_id)} <span class="mono" style="color:var(--muted)">${esc(m.emp_id)}</span>
        <div style="font-size:11px;color:var(--muted)">${m.origin === 'manager' ? 'assigned by you' : 'requested by the employee'} · ${esc(fmtSent(m.created_at))}</div></td>
      <td class="mono" style="white-space:nowrap">${esc(smisWhen(m))}</td>
      <td style="white-space:normal;max-width:280px"><b>${esc(m.place)}</b>${m.purpose ? `<div style="font-size:12px;color:var(--muted)">${esc(m.purpose)}</div>` : ''}</td>
      <td class="mono">${esc(m.project_code || '—')}</td>
      <td>${smisStatus(m, true)}${m.hr_note ? `<div style="font-size:12px">HR: ${esc(m.hr_note)}</div>` : ''}</td>
      <td style="white-space:nowrap">${mine ? `<button class="btn btn-success btn-sm" data-smis-ok="${esc(m.id)}">Approve</button> <button class="btn btn-ghost btn-sm" data-smis-no="${esc(m.id)}">Reject</button>` : ''}
        ${m.origin === 'manager' && ['Waiting for employee', 'Waiting for HR'].includes(m.status) ? `<button class="btn btn-ghost btn-sm" data-smis-cancel="${esc(m.id)}">Cancel</button>` : ''}</td></tr>`; }).join('')
    || '<tr><td colspan="6" class="empty">No missions yet — use “Assign a mission”</td></tr>';
  const w = SMIS.team.filter(m => m.status === 'Waiting for manager').length;
  if (w) { const b = $('self-team-badge'), n = (b.style.display === 'none' ? 0 : Number(b.textContent) || 0) + w; b.style.display = ''; b.textContent = n; $('self-team-nav').style.display = ''; }
  if (SMIS.team.length) $('self-team-nav').style.display = '';
}
function openSelfMission(assign){
  SMIS.assign = assign;
  $('smis-title').textContent = assign ? '🚗 Assign a mission to your team' : '🚗 Request an outside mission';
  $('smis-who-box').style.display = assign ? '' : 'none';
  const team = SD.myTeam || [];
  $('smis-all-l').textContent = `Select all (${team.length})`; $('smis-all').checked = false;
  $('smis-who').innerHTML = team.map(m => `<label style="display:flex;gap:8px;align-items:center;padding:5px 0"><input type="checkbox" class="smis-w" value="${esc(m.id)}" style="width:auto">
      <span>${esc(m.name_en || m.name_ar || m.id)} <span class="mono" style="color:var(--muted)">${esc(m.id)}</span>${m.job_name ? ` <span style="font-size:12px;color:var(--muted)">· ${esc(m.job_name)}</span>` : ''}</span></label>`).join('');
  $('smis-cnt').textContent = '0 chosen';
  ['smis-f', 'smis-t', 'smis-d'].forEach(i => $(i).value = todayStr());
  ['smis-pl', 'smis-pu', 'smis-pr'].forEach(i => $(i).value = '');
  smisKind(false); openM('m-smis');
}
function smisKind(p){ SMIS.part = p; $('smis-full').style.display = p ? 'none' : ''; $('smis-part').style.display = p ? '' : 'none';
  $('smis-k-full').className = 'btn btn-sm ' + (p ? 'btn-ghost' : 'btn-primary'); $('smis-k-part').className = 'btn btn-sm ' + (p ? 'btn-primary' : 'btn-ghost'); }
function smisCount(){ const n = document.querySelectorAll('.smis-w:checked').length, all = document.querySelectorAll('.smis-w').length;
  $('smis-cnt').textContent = `${n} chosen`; $('smis-all').checked = n > 0 && n === all; }
async function sendSelfMission(){
  const p = SMIS.part, f = p ? $('smis-d').value : $('smis-f').value, to = p ? $('smis-d').value : $('smis-t').value;
  const tf = p ? $('smis-tf').value : null, tt = p ? $('smis-tt').value : null, pl = $('smis-pl').value.trim();
  if (!f || !to || to < f) return toast('The end date must be on or after the start date', 'warn');
  if (p && (!tf || !tt || tt <= tf)) return toast('The end time must be after the start time', 'warn');
  if (!pl) return toast('Write where the mission is', 'warn');
  const who = SMIS.assign ? [...document.querySelectorAll('.smis-w:checked')].map(c => c.value) : null;
  if (SMIS.assign && !who.length) return toast('Choose at least one employee', 'warn');
  const args = { p_from: f, p_to: to, p_time_from: tf, p_time_to: tt, p_place: pl, p_purpose: $('smis-pu').value.trim() || null, p_project: $('smis-pr').value.trim() || null };
  $('smis-go').disabled = true;
  const { error } = SMIS.assign ? await sb.rpc('assign_mission', { p_emps: who, ...args }) : await sb.rpc('request_mission', args);
  $('smis-go').disabled = false;
  if (error) return toast(error.message.replace(/^[A-Z_]+:\s*/, ''), 'err');
  closeM('m-smis');
  toast(SMIS.assign ? 'Mission sent — app users acknowledge it; the others go straight to HR' : (SD.manager ? 'Mission request sent to your direct manager' : 'Mission request sent to HR'));
  await loadSelf();
}
async function smisRpc(name, args, msg){
  const { error } = await sb.rpc(name, args);
  if (error) return toast(error.message.replace(/^[A-Z_]+:\s*/, ''), 'err');
  toast(msg); await loadSelf();
}
$('smis-new').addEventListener('click', () => openSelfMission(false));
$('smis-assign').addEventListener('click', () => openSelfMission(true));
$('smis-k-full').addEventListener('click', () => smisKind(false));
$('smis-k-part').addEventListener('click', () => smisKind(true));
$('smis-all').addEventListener('change', () => { document.querySelectorAll('.smis-w').forEach(c => c.checked = $('smis-all').checked); smisCount(); });
$('smis-who').addEventListener('change', smisCount);
$('smis-go').addEventListener('click', sendSelfMission);
document.addEventListener('click', e => {
  const a = e.target.closest('[data-smis-ack]'); if (a) { a.disabled = true; return smisRpc('acknowledge_mission', { p_id: a.dataset.smisAck }, 'Thank you — your manager and HR are notified'); }
  const ok = e.target.closest('[data-smis-ok]'); if (ok) { ok.disabled = true; return smisRpc('manager_decide_mission', { p_id: ok.dataset.smisOk, p_approve: true }, 'Approved — sent to HR'); }
  const no = e.target.closest('[data-smis-no]'); if (no) { const note = prompt('Reason for rejecting (the employee will see it):'); if (note === null) return; if (!note.trim()) return toast('Write the reason', 'warn');
    return smisRpc('manager_decide_mission', { p_id: no.dataset.smisNo, p_approve: false, p_note: note.trim() }, 'Rejected — the employee is notified'); }
  const cx = e.target.closest('[data-smis-cancel]'); if (cx) { const id = cx.dataset.smisCancel;
    confirmDel('Cancel this mission?', async () => { const { error } = await sb.rpc('cancel_mission', { p_id: id }); if (error) throw new Error(error.message.replace(/^[A-Z_]+:\s*/, '')); toast('Mission cancelled'); await loadSelf(); });
    $('del-title').textContent = 'Please confirm'; $('del-ok').textContent = 'Cancel mission'; }
});
const _loadSelfMis = loadSelf;
loadSelf = async function(){ try { await loadSelfMissions(); } catch (e) { console.warn(e); } return _loadSelfMis.apply(this, arguments); };
const _renderSelfMis = renderSelf;
renderSelf = function(){ const r = _renderSelfMis.apply(this, arguments); try { if (SD.emp) renderSelfMissions(); } catch (e) { console.warn(e); } return r; };

// ═════════════════════════════════════════════════════════
//  EMPLOYEE VOICE — one "Show: Open / Closed / All cases" filter for every section (22 Oct 2026)
//  Nothing was ever deleted: closed complaints were only hidden by the old "Open" filter of the first table, and the other
//  tables showed everything mixed. Now every section follows the same filter and its title shows "n open · n closed".
//  Choice remembered in localStorage pk_voice_show.
// ═════════════════════════════════════════════════════════
const VO_OPEN = {
  fb:    s => s === 'New' || s === 'In review',
  act:   s => s === 'Waiting for board' || s === 'Waiting for HR',
  sal:   s => s === 'Waiting for board',
  hire:  s => s === 'New' || s === 'In progress',
  train: s => s === 'New' || s === 'In progress'
};
(function(){ try { const v = localStorage.getItem('pk_voice_show'); if (v !== null && $('vo-st')) $('vo-st').value = v; } catch(e){} })();
$('vo-st').addEventListener('change', () => { try { localStorage.setItem('pk_voice_show', $('vo-st').value); } catch(e){} });

function voiceFilterSection(kind, tbodyId, list, cols){
  const tb = $(tbodyId); if (!tb) return;
  const show = $('vo-st').value, isOpen = VO_OPEN[kind];
  const nOpen = list.filter(x => isOpen(x.status)).length, nClosed = list.length - nOpen;
  const rows = [...tb.querySelectorAll('tr')].filter(r => !r.querySelector('td.empty'));
  let shown = 0;
  rows.forEach((r, i) => {
    let x = null;
    if (r.dataset.vo) { const id = r.dataset.vo.split(':').slice(1).join(':'); x = list.find(y => String(y.id) === id); }
    else x = list[i];                                     // basic-salary rows have no data-vo: same order as the list
    const ok = !x || !show || (show === 'open' ? isOpen(x.status) : !isOpen(x.status));
    r.style.display = ok ? '' : 'none'; if (ok) shown++;
  });
  tb.querySelectorAll('tr.vo-none').forEach(r => r.remove());
  if (rows.length && !shown) tb.insertAdjacentHTML('beforeend', `<tr class="vo-none"><td colspan="${cols}" class="empty">${show === 'open' ? 'No open cases — choose “Closed cases” or “All cases” above to see the history' : 'No closed cases yet'}</td></tr>`);
  const card = tb.closest('.card'), title = card && card.querySelector('.toolbar-title');
  if (title) { let c = title.querySelector('.vo-count'); if (!c) { c = document.createElement('span'); c.className = 'vo-count'; c.style.cssText = 'font-size:12px;font-weight:400;color:var(--muted);margin-left:8px'; title.appendChild(c); }
    c.textContent = `${nOpen} open · ${nClosed} closed`; }
}
const _renderVoiceShow = renderVoicePage;
renderVoicePage = async function(){
  const r = await _renderVoiceShow.apply(this, arguments);
  const k = $('vo-kind').value;
  voiceFilterSection('fb', 'vo-fb', (V.fb || []).filter(x => !k || x.kind === k), 7);
  voiceFilterSection('act', 'vo-act', V.act || [], 9);
  voiceFilterSection('sal', 'vo-sal', V.sal || [], 10);
  voiceFilterSection('hire', 'vo-hire', V.hire || [], 9);
  voiceFilterSection('train', 'vo-train', V.train || [], 8);
  return r;
};

// ═════════════════════════════════════════════════════════
//  REPORT "Returns after check-out and undone check-outs" (22 Oct 2026, with 71-undo-checkout.sql)
//  Hours rule: a period counts from check-in to check-out. "Switch site" closes one period and opens the next at the same minute,
//  so travel between sites is counted. A real check-out followed by a later check-in leaves a GAP that is not counted — this
//  report lists those days so HR can ask about them, plus check-outs the employee undid within 5 minutes (table checkout_undos).
// ═════════════════════════════════════════════════════════
S.undos = [];
const _loadPeriodDataUndo = loadPeriodData;
loadPeriodData = async function(){
  const r = await _loadPeriodDataUndo.apply(this, arguments);
  try { const p = settings.period, q = await sb.from('checkout_undos').select('*').gte('date', periodStart(p)).lte('date', periodEnd(p));
        S.undos = q.error ? [] : (q.data || []); } catch(e){ S.undos = []; }
  return r;
};
const hmMin = s => { const m = /^(\d{1,2}):(\d{2})/.exec(String(s || '')); return m ? +m[1] * 60 + +m[2] : null; };
function dayGaps(a){
  const segs = (a.projects || []).filter(x => x.in && x.out && !x.forgotten).map(x => ({ x, i: hmMin(x.in), o: hmMin(x.out) }))
    .filter(s => s.i !== null && s.o !== null).sort((p, q) => p.i - q.i);
  const gaps = [];
  for (let k = 1; k < segs.length; k++) { const g = segs[k].i - segs[k - 1].o; if (g > 0) gaps.push({ from: segs[k - 1].x.out, to: segs[k].x.in, min: g }); }
  return { segs, gaps };
}
REPORTS.push({ id:'att-returns', g:'Attendance', t:'Returns after check-out and undone check-outs',
  d:'Days where an employee checked out and later checked in again (the time away is NOT counted in his hours), and check-outs the employee undid within 5 minutes. Switching site is not a gap — travel between sites is counted.',
  build:() => {
    const und = {}; (S.undos || []).forEach(u => { const k = u.emp_id + '|' + u.date; (und[k] = und[k] || []).push(u.out_time); });
    const R = [];
    S.attendance.forEach(a => {
      const { segs, gaps } = dayGaps(a), u = und[a.emp_id + '|' + a.date] || [];
      if (!gaps.length && !u.length) return;
      const e = empById(a.emp_id) || {}, away = gaps.reduce((s, g) => s + g.min, 0);
      R.push({ date:a.date, code:a.emp_id, name:empName(e), department:e.department, unit:e.unit,
        periods: segs.map(s => `${s.x.in}–${s.x.out}${s.x.code ? ' ' + s.x.code : ''}`).join(' · '), n: segs.length,
        gapsTxt: gaps.map(g => `${g.from} → ${g.to}`).join(' · '), away: away / 60, longest: gaps.length ? Math.max(...gaps.map(g => g.min)) / 60 : 0,
        hours: num(a.total_hours), undone: u.length ? `↩ ${u.length} (at ${u.sort().join(', ')})` : '' });
    });
    return { cols:[C('date','Date','date'),C('code','Code','id'),C('name','Employee','strong'),C('department','Department'),C('unit','Unit'),
        C('periods','Periods (check-in – check-out)'),C('n','Periods','int'),C('gapsTxt','Away (out → back in)'),C('away','Time away (h)','num',true),
        C('longest','Longest absence (h)','num'),C('hours','Hours counted','num'),C('undone','Undone check-outs')],
      rows: R.sort((p, q) => p.date.localeCompare(q.date) || String(p.code).localeCompare(String(q.code), undefined, { numeric:true })) };
  } });

// ═════════════════════════════════════════════════════════
//  BIRTH DATE FROM THE EGYPTIAN NATIONAL ID (23 Oct 2026, with 73-birth-date-from-national-id.sql)
//  ID (14 digits): 1st digit 2 = 1900s, 3 = 2000s; digits 2–7 = YYMMDD. The database fills an EMPTY birth date on save;
//  the employee window fills it as soon as the ID is typed (only when the birth date box is empty), and the report
//  "Birth date different from national ID" lists records where the two disagree, for HR to check against the ID card.
// ═════════════════════════════════════════════════════════
function birthFromNid(nid){
  const s = String(nid || '').replace(/\D/g, '');
  if (s.length !== 14 || !/^[23]/.test(s)) return null;
  const y = (s[0] === '2' ? 1900 : 2000) + +s.slice(1, 3), m = +s.slice(3, 5), d = +s.slice(5, 7);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (m < 1 || m > 12 || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
document.addEventListener('input', e => {
  const f = e.target.closest && e.target.closest('#emp-form [data-f="national_id"]'); if (!f) return;
  const b = document.querySelector('#emp-form [data-f="birth_date"]'); if (!b) return;
  const v = birthFromNid(f.value), field = b.closest('.field');
  let note = field.querySelector('.bd-note');
  if (v && (!b.value || b.dataset.auto === '1')) {
    b.value = v; b.dataset.auto = '1';
    if (!note) { note = document.createElement('div'); note.className = 'bd-note'; note.style.cssText = 'font-size:11px;color:var(--muted);margin-top:4px'; field.appendChild(note); }
    note.textContent = 'Filled from the national ID';
  } else if (!v && b.dataset.auto === '1') { b.value = ''; delete b.dataset.auto; if (note) note.textContent = ''; }
});
document.addEventListener('input', e => {                    // HR typed the birth date himself → stop auto-filling it
  const b = e.target.closest && e.target.closest('#emp-form [data-f="birth_date"]'); if (!b) return;
  delete b.dataset.auto; const n = b.closest('.field').querySelector('.bd-note'); if (n) n.textContent = '';
});
REPORTS.push({ id:'emp-birth-id', g:'HR', t:'Birth date different from national ID',
  d:'Employees whose recorded birth date does not match the date written in their Egyptian national ID (digits 2–7). Check the ID card: either the birth date or the ID number was typed wrong. A wrong birth date affects the leave entitlement at age 50, the first-sign-in question and the birthday greeting.',
  build:() => {
    const rows = (S.employees || []).map(e => ({ e, idb: birthFromNid(e.national_id) }))
      .filter(x => x.idb && x.e.birth_date && String(x.e.birth_date).slice(0, 10) !== x.idb)
      .map(({ e, idb }) => ({ code:e.id, name:empName(e), status:e.status, department:e.department, rec:String(e.birth_date).slice(0, 10), idb,
        diff: String(e.birth_date).slice(0, 4) !== idb.slice(0, 4) ? 'Year differs' : String(e.birth_date).slice(5, 7) !== idb.slice(5, 7) ? 'Month differs' : 'Day differs' }));
    return { cols:[C('code','Code','id'),C('name','Employee','strong'),C('status','Status'),C('department','Department'),
        C('rec','Recorded birth date','date'),C('idb','Birth date in the national ID','date'),C('diff','Difference')],
      rows: rows.sort((a, b) => String(a.code).localeCompare(String(b.code), undefined, { numeric:true })) };
  } });

// ── National ID: exactly 14 digits (with 74-national-id-14-digits.sql) ──
// The box keeps digits only (spaces / dashes / letters typed are dropped), stops at 14, and shows "n / 14 digits".
// Saving is refused in the window AND in the database when it is not exactly 14 digits.
function nidHint(f){
  const field = f.closest('.field'); let h = field.querySelector('.nid-hint');
  if (!h) { h = document.createElement('div'); h.className = 'nid-hint'; h.style.cssText = 'font-size:11px;margin-top:4px'; field.appendChild(h); }
  const n = f.value.length; h.textContent = `${n} / 14 digits`; h.style.color = n === 14 ? 'var(--muted)' : 'var(--warn)';
}
document.addEventListener('input', e => {
  const f = e.target.closest && e.target.closest('#emp-form [data-f="national_id"]'); if (!f) return;
  const clean = f.value.replace(/\D/g, '').slice(0, 14); if (clean !== f.value) f.value = clean;
  nidHint(f);
}, true);                                                     // runs before the birth-date filler above
const _openEmpNid = openEmp;
openEmp = function(){
  const r = _openEmpNid.apply(this, arguments);
  const f = document.querySelector('#emp-form [data-f="national_id"]');
  if (f) { f.setAttribute('maxlength', '14'); f.setAttribute('inputmode', 'numeric'); f.setAttribute('autocomplete', 'off'); nidHint(f); }
  return r;
};
const _saveEmpNid = saveEmp;
saveEmp = async function(){
  const f = document.querySelector('#emp-form [data-f="national_id"]');
  if (f && !/^\d{14}$/.test(f.value.replace(/[\s-]/g, ''))) {
    f.focus(); f.scrollIntoView && f.scrollIntoView({ block:'center' });
    return toast(`The national ID must be exactly 14 digits — it has ${f.value.replace(/\D/g, '').length}`, 'warn');
  }
  return _saveEmpNid.apply(this, arguments);
};

// ═════════════════════════════════════════════════════════
//  EMPLOYEE WINDOW — no field may be skipped when it applies (23 Oct 2026, with 75-employee-required-fields.sql)
//  Same rule as the database function employee_missing(); the database refuses NEW employees with gaps, this window
//  refuses Save for any employee (new or existing) until his gaps are filled, marks the empty boxes in red and lists them.
//  Always-required boxes get a red *. Report "Missing employee data" lists every active employee with gaps.
// ═════════════════════════════════════════════════════════
const REQ_ALWAYS = [['name_ar','Arabic name'],['name_en','English name'],['department','Department'],['unit','Unit'],['entity','Entity'],
  ['job_name','Job name'],['job_type','Job type'],['mobile','Personal mobile'],['personal_email','Personal e-mail'],['address','Address'],['contract_type','Contract type'],
  ['employment_date','Employment date'],['birth_date','Birth date'],['gender','Gender'],['marital_status','Marital status'],
  ['religion','Religion'],['nationality','Nationality'],['national_id','National ID'],['national_id_expiry','National ID expiry'],
  ['insurance','Insurance'],['payment_method','Payment method'],['university','University'],['college','College'],['graduation_date','Graduation date']];
const reqBlank = v => v === null || v === undefined || String(v).trim() === '' || String(v) === PICK_OTHER;
function employeeMissing(r, withPay){
  const m = [];
  REQ_ALWAYS.forEach(([k, l]) => { if (reqBlank(r[k])) m.push([k, l]); });
  if (reqBlank(r.manager_id) && !r.top_of_org) m.push(['manager_id','Direct manager']);
  if (r.contract_type !== 'Permanent' && reqBlank(r.contract_start_date)) m.push(['contract_start_date','Contract start']);
  if (r.gender === 'Male' && reqBlank(r.military_status)) m.push(['military_status','Military status']);
  if (r.insurance === 'Insured') {
    if (reqBlank(r.insurance_number)) m.push(['insurance_number','Insurance number']);
    if (reqBlank(r.insurance_title)) m.push(['insurance_title','Insurance title']);
    if (reqBlank(r.insurance_date)) m.push(['insurance_date','Insurance date']);
    if (withPay && reqBlank(r.insurance_amount)) m.push(['insurance_amount','Insurable amount']);
  }
  if (r.payment_method === 'Bank') {
    if (reqBlank(r.bank_account)) m.push(['bank_account','Bank account']);
    if (reqBlank(r.bank_branch)) m.push(['bank_branch','Bank']);
  }
  if (r.has_disability === true) {
    if (reqBlank(r.disability_card_no)) m.push(['disability_card_no','Disability card number']);
    if (reqBlank(r.disability_card_expiry)) m.push(['disability_card_expiry','Disability card expiry']);
  }
  return m;
}
function empFormRecord(){
  const e = editingEmp ? (empById(editingEmp) || {}) : {}, r = { ...e };
  document.querySelectorAll('#emp-form [data-f]').forEach(el => {
    const k = el.dataset.f, def = EMP_FIELDS.flatMap(s => s[1]).find(f => f[0] === k);
    r[k] = def && def[2] === 'bool' ? el.value === 'Yes' : el.value;
  });
  r.top_of_org = !!($('emp-top') && $('emp-top').checked);
  return r;
}
function reqMark(){
  REQ_ALWAYS.forEach(([k]) => { const f = document.querySelector(`#emp-form [data-f="${k}"]`), lab = f && f.closest('.field').querySelector('label');
    if (lab && !lab.querySelector('.req')) lab.insertAdjacentHTML('beforeend', ' <span class="req" style="color:var(--danger,#d33)">*</span>'); });
}
const _openEmpReq = openEmp;
openEmp = function(){
  const r = _openEmpReq.apply(this, arguments);
  reqMark();
  if (editingEmp) { const miss = employeeMissing(empFormRecord(), !isOfficer());
    if (miss.length) $('emp-form').insertAdjacentHTML('afterbegin', `<div class="alert a-warn req-banner" style="margin-bottom:6px">Missing data (${miss.length}): ${esc(miss.map(x => x[1]).join(', '))} — fill these in before saving.</div>`); }
  return r;
};
document.addEventListener('input', e => { const f = e.target.closest && e.target.closest('#emp-form .field.req-miss'); if (f) f.classList.remove('req-miss'); }, true);
document.addEventListener('change', e => { const f = e.target.closest && e.target.closest('#emp-form .field.req-miss'); if (f) f.classList.remove('req-miss'); }, true);
const _saveEmpReq = saveEmp;
saveEmp = async function(){
  const pe = document.querySelector('#emp-form [data-f="personal_email"]');
  if (pe) { pe.value = pe.value.replace(/\s/g, '').toLowerCase();
    if (pe.value && !/^[^@]+@[^@]+\.[a-z]{2,}$/.test(pe.value)) { pe.closest('.field').classList.add('req-miss'); pe.focus();
      return toast('The personal e-mail is not a valid e-mail address (example: name@gmail.com)', 'warn'); } }
  const miss = employeeMissing(empFormRecord(), !isOfficer());
  document.querySelectorAll('#emp-form .field.req-miss').forEach(f => f.classList.remove('req-miss'));
  if (miss.length) {
    let first = null;
    miss.forEach(([k]) => { const el = document.querySelector(`#emp-form [data-f="${k}"]`); if (el) { el.closest('.field').classList.add('req-miss'); first = first || el; } });
    if (first) { first.focus(); first.scrollIntoView && first.scrollIntoView({ block:'center' }); }
    return toast(`Fill in before saving (${miss.length}): ${miss.map(x => x[1]).join(', ')}`, 'warn');
  }
  return _saveEmpReq.apply(this, arguments);
};
document.head.insertAdjacentHTML('beforeend', '<style>#emp-form .field.req-miss input,#emp-form .field.req-miss select,#emp-form .field.req-miss textarea{border-color:#d33;box-shadow:0 0 0 2px rgba(221,51,51,.18)}#emp-form .field.req-miss label{color:#d33}</style>');
REPORTS.push({ id:'emp-missing', g:'HR', t:'Missing employee data',
  d:'Active employees with empty fields that apply to them. HR cannot save an employee until these are filled; new employees cannot be added with gaps.',
  build:() => {
    const pay = !isOfficer();
    const rows = (S.employees || []).filter(e => e.status !== 'Inactive').map(e => ({ e, m: employeeMissing(e, pay) })).filter(x => x.m.length)
      .map(({ e, m }) => ({ code:e.id, name:empName(e), department:e.department, unit:e.unit, n:m.length, fields:m.map(x => x[1]).join(', ') }));
    return { cols:[C('code','Code','id'),C('name','Employee','strong'),C('department','Department'),C('unit','Unit'),C('n','Missing','int'),C('fields','Fields to fill')],
      rows: rows.sort((a, b) => b.n - a.n || String(a.code).localeCompare(String(b.code), undefined, { numeric:true })) };
  } });

// ═════════════════════════════════════════════════════════
//  DATA REQUESTS — HR asks employees to update their own data on the phone (23 Oct 2026, 77-data-update-requests.sql)
//  Page 📝 Data requests (Workforce): list + review (Accept → saved on the record / Return with a note / Cancel).
//  "📝 New request" window: employees by department + unit or by codes, optionally only those missing the chosen
//  fields; fields from data_fields(); message. Employee window: "📝 Ask to update data" (this employee, his missing fields).
//  Personal mobile / e-mail / address are saved at once when the employee answers; the rest waits for HR here.
// ═════════════════════════════════════════════════════════
let DQ = { rows: [], fields: null, t: null };
const dqChip = s => `<span class="chip ${({Answered:'c-orange',Requested:'c-blue',Returned:'c-blue',Accepted:'c-green',Completed:'c-green',Cancelled:'c-grey'})[s] || 'c-grey'}">${esc(
  ({Answered:'Waiting for your review',Requested:'Waiting for the employee',Returned:'Returned to the employee',Accepted:'Accepted — saved',Completed:'Saved',Cancelled:'Cancelled'})[s] || s)}</span>`;
async function dqFields(){
  if (DQ.fields) return DQ.fields;
  const { data, error } = await sb.rpc('data_fields');
  DQ.fields = error ? [] : (data || []); return DQ.fields;
}
const dqLabel = k => ((DQ.fields || []).find(f => f.key === k) || { en: k }).en;
const dqDirect = k => !!((DQ.fields || []).find(f => f.key === k) || {}).direct;
async function loadDreqs(){
  await dqFields();
  const { data, error } = await sb.from('data_requests').select('*').order('requested_at', { ascending: false }).limit(2000);
  if (error) { DQ.rows = []; DQ.error = /does not exist|schema cache/i.test(error.message) ? 'missing' : error.message; }
  else { DQ.rows = data || []; DQ.error = null; }
  const n = DQ.rows.filter(r => r.status === 'Answered').length, b = $('dq-badge');
  if (b) { b.style.display = n ? '' : 'none'; b.textContent = n; }
}
function dqAnswer(r){
  if (!r.answer) return '<span style="color:var(--muted)">—</span>';
  return Object.keys(r.answer).map(k => {
    const was = r.before ? r.before[k] : null, now = r.answer[k], pend = r.pending && k in r.pending;
    return `<div style="font-size:12px;white-space:nowrap"><b>${esc(dqLabel(k))}:</b> ${was ? `<span style="color:var(--muted);text-decoration:line-through">${esc(String(was).slice(0, 40))}</span> → ` : ''}<span class="${pend ? '' : 'pos'}">${esc(String(now).slice(0, 60))}</span>${pend ? '' : ' <span style="color:var(--muted)">(saved)</span>'}</div>`;
  }).join('');
}
async function renderDreqs(){
  await loadDreqs();
  if (DQ.error) { $('dq-tbl').innerHTML = `<tr><td colspan="7" class="empty">${DQ.error === 'missing' ? 'Data requests are not set up yet — run database file 77-data-update-requests.sql.' : esc(DQ.error)}</td></tr>`; return; }
  const st = $('dq-status').value, q = $('dq-q').value.trim().toLowerCase();
  const rows = DQ.rows.filter(r => {
    if (st === 'open' ? !['Requested','Returned'].includes(r.status) : st === 'done' ? !['Accepted','Completed'].includes(r.status) : st && r.status !== st) return false;
    const e = empById(r.emp_id) || {};
    if (!orgMatch(e, 'dq')) return false;
    return !q || [r.emp_id, r.emp_name, e.name_en, e.name_ar].some(v => String(v || '').toLowerCase().includes(q));
  });
  const wait = DQ.rows.filter(r => r.status === 'Answered').length, open = DQ.rows.filter(r => ['Requested','Returned'].includes(r.status)).length;
  $('dq-sub').textContent = `${wait} waiting for your review · ${open} waiting for the employee · personal mobile, e-mail and address are saved at once; everything else waits for your review here.`;
  $('dq-tbl').innerHTML = rows.map(r => { const e = empById(r.emp_id) || { id: r.emp_id, name_en: r.emp_name };
    return `<tr><td class="mono" style="white-space:nowrap">${esc(String(r.requested_at).slice(0, 10))}<div style="font-size:11px;color:var(--muted)">${esc(r.requested_by || '')}</div></td>
      <td class="strong">${esc(empName(e) || r.emp_name || r.emp_id)} <span class="mono" style="color:var(--muted)">${esc(r.emp_id)}</span><div style="font-size:11px;color:var(--muted)">${esc(e.department || '')}</div></td>
      <td style="white-space:normal;max-width:220px;font-size:12px">${esc((r.fields || []).map(dqLabel).join(', '))}</td>
      <td style="white-space:normal;max-width:200px;font-size:12px">${esc(r.message || '')}</td>
      <td>${dqChip(r.status)}${r.review_note ? `<div style="font-size:11px">💬 ${esc(r.review_note)}</div>` : ''}${r.reviewed_by ? `<div style="font-size:11px;color:var(--muted)">${esc(r.reviewed_by)}</div>` : ''}</td>
      <td>${dqAnswer(r)}</td>
      <td style="white-space:nowrap">${r.status === 'Answered' ? `<button class="btn btn-success btn-sm" data-dq-ok="${r.id}">✓ Accept</button> <button class="btn btn-ghost btn-sm" data-dq-ret="${r.id}">↩ Return</button> ` : ''}${['Requested','Returned','Answered'].includes(r.status) ? `<button class="btn btn-ghost btn-sm" data-dq-cancel="${r.id}" title="Cancel this request">✕</button>` : ''}</td></tr>`; }).join('')
    || '<tr><td colspan="7" class="empty">Nothing here</td></tr>';
  $('dq-foot').textContent = `${rows.length} shown.`;
}
async function dqReview(id, ok){
  let note = null;
  if (!ok) { note = prompt('What should the employee correct? (he will see this note on his phone)'); if (note === null) return; if (!note.trim()) return toast('Write what needs to be corrected', 'warn'); }
  const { error } = await sb.rpc('review_data_request', { p_id: id, p_accept: ok, p_note: note });
  if (error) return toast(error.message.replace(/^[A-Z_]+: ?/, ''), 'err');
  toast(ok ? 'Accepted — saved on the employee record; the employee is notified' : 'Returned — the employee is notified');
  if (ok) { try { await loadAll(); } catch(e){} }
  renderDreqs();
}
async function dqCancel(id){
  if (!confirm('Cancel this request? The employee will no longer see it.')) return;
  const { error } = await sb.rpc('cancel_data_request', { p_id: id });
  if (error) return toast(error.message, 'err');
  toast('Request cancelled'); renderDreqs();
}
PAGE_RENDER.dreq = () => renderDreqs();
$('dq-tbl').addEventListener('click', e => {
  const a = e.target.closest('[data-dq-ok]'); if (a) { a.disabled = true; return dqReview(a.dataset.dqOk, true); }
  const r = e.target.closest('[data-dq-ret]'); if (r) return dqReview(r.dataset.dqRet, false);
  const c = e.target.closest('[data-dq-cancel]'); if (c) return dqCancel(c.dataset.dqCancel);
});
['dq-status', 'dq-dept'].forEach(id => $(id).addEventListener('change', renderDreqs));
$('dq-q').addEventListener('input', () => { clearTimeout(DQ.t); DQ.t = setTimeout(renderDreqs, 250); });
const _showPageDq = showPage;
showPage = function(name){ const r = _showPageDq.apply(this, arguments); if (name === 'dreq') renderDreqs(); return r; };
const _loadPeriodDataDq = loadPeriodData;
loadPeriodData = async function(){ const r = await _loadPeriodDataDq.apply(this, arguments); loadDreqs().catch(() => {}); return r; };

// ── New request window ──
const dqBlank = v => v === null || v === undefined || String(v).trim() === '';
function dqTargets(){
  const codes = $('dqn-codes').value.split(/[\s,;]+/).map(x => x.trim()).filter(Boolean);
  const fields = [...document.querySelectorAll('#dqn-fields input:checked')].map(x => x.value);
  let list;
  if (codes.length) list = codes.map(c => empById(c)).filter(Boolean);
  else { const d = $('dqn-dept').value, u = $('dqn-unit').value;
    list = d ? (S.employees || []).filter(e => e.department === d && (!u || (u === '__none__' ? !e.unit : e.unit === u))) : []; }
  list = list.filter(e => e.status !== 'Inactive');
  if ($('dqn-missing').checked && fields.length) list = list.filter(e => fields.some(k => dqBlank(e[k])));
  return { list, fields, unknown: codes.filter(c => !empById(c)) };
}
function dqCount(){
  const { list, fields, unknown } = dqTargets();
  $('dqn-count').innerHTML = `<b>${list.length}</b> employee${list.length === 1 ? '' : 's'} will receive the request${fields.length ? '' : ' — choose at least one field'}`
    + (unknown.length ? ` · <span style="color:var(--warn)">unknown codes: ${esc(unknown.join(', '))}</span>` : '');
}
function dqUnits(){
  const d = $('dqn-dept').value, units = [...new Set((S.employees || []).filter(e => e.department === d && e.status !== 'Inactive').map(e => e.unit).filter(Boolean))].sort();
  $('dqn-unit').innerHTML = `<option value="">All units</option>${units.map(u => `<option>${esc(u)}</option>`).join('')}<option value="__none__">(no unit)</option>`;
}
async function openDataRequest(empId, preFields){
  const fields = await dqFields();
  if (!fields.length) return toast('Data requests are not set up yet — run database file 77-data-update-requests.sql.', 'warn');
  const depts = [...new Set((S.employees || []).filter(e => e.status !== 'Inactive').map(e => e.department).filter(Boolean))].sort();
  $('dqn-dept').innerHTML = `<option value="">— choose —</option>${depts.map(d => `<option>${esc(d)}</option>`).join('')}`; dqUnits();
  $('dqn-codes').value = empId || ''; $('dqn-msg').value = '';
  $('dqn-missing').checked = !empId;
  $('dqn-fields').innerHTML = fields.map(f => `<label style="display:flex;gap:6px;align-items:center;cursor:pointer"><input type="checkbox" value="${esc(f.key)}"${(preFields || []).includes(f.key) ? ' checked' : ''}> ${esc(f.en)}${f.direct ? ' <span style="color:var(--muted);font-size:11px">(saved at once)</span>' : ''}</label>`).join('');
  dqCount(); openM('m-dreq');
}
['dqn-codes', 'dqn-msg'].forEach(id => $(id).addEventListener('input', dqCount));
$('dqn-dept').addEventListener('change', () => { dqUnits(); dqCount(); });
['dqn-unit', 'dqn-missing'].forEach(id => $(id).addEventListener('change', dqCount));
$('dqn-fields').addEventListener('change', dqCount);
$('dq-new').addEventListener('click', () => openDataRequest('', []));
$('dqn-send').addEventListener('click', async () => {
  const { list, fields } = dqTargets();
  if (!fields.length) return toast('Choose at least one field', 'warn');
  if (!list.length) return toast('No employee matches — choose a department or type codes', 'warn');
  const b = $('dqn-send'); b.disabled = true; b.textContent = 'Sending…';
  const { data, error } = await sb.rpc('request_data_update', { p_emps: list.map(e => String(e.id)), p_fields: fields, p_msg: $('dqn-msg').value.trim() || null });
  b.disabled = false; b.textContent = 'Send';
  if (error) return toast(error.message.replace(/^[A-Z_]+: ?/, ''), 'err');
  closeM('m-dreq');
  toast(`Sent to ${data.sent} employee${data.sent === 1 ? '' : 's'}${data.skipped ? ` · ${data.skipped} skipped (inactive or already have an open request)` : ''} — they are notified on the phone`);
  if (document.querySelector('#page-dreq.active, #page-dreq.on')) renderDreqs(); else loadDreqs().catch(() => {});
});

// ── Employee window: "📝 Ask to update data" ──
const _openEmpDq = openEmp;
openEmp = function(){
  const r = _openEmpDq.apply(this, arguments);
  const foot = $('emp-save') && $('emp-save').parentElement;
  if (foot && !foot.querySelector('#emp-dq')) foot.insertAdjacentHTML('afterbegin', '<button class="btn btn-ghost" id="emp-dq" style="margin-right:auto">📝 Ask employee to update data</button>');
  const b = $('emp-dq'); if (b) b.style.display = editingEmp && canHRA() ? '' : 'none';
  return r;
};
document.addEventListener('click', async e => {
  if (!e.target.closest || !e.target.closest('#emp-dq')) return;
  const emp = empById(editingEmp); if (!emp) return;
  const fields = await dqFields();
  const miss = fields.map(f => f.key).filter(k => dqBlank(emp[k]) && !(k === 'military_status' && emp.gender !== 'Male') && !((k === 'bank_account' || k === 'bank_branch') && emp.payment_method !== 'Bank'));
  openDataRequest(String(emp.id), miss);
});

// ── Changes made by employees themselves (78-employee-self-changes.sql) ──
let SC = { rows: [] };
async function loadSelfChanges(){
  const { data, error } = await sb.from('employee_self_changes').select('*').order('changed_at', { ascending: false }).limit(1000);
  SC.rows = error ? [] : (data || []); SC.missing = !!error && /does not exist|schema cache/i.test(error.message);
  const unseen = SC.rows.filter(r => !r.seen_at).length, c = $('sc-count');
  if (c) { c.style.display = unseen ? '' : 'none'; c.textContent = `${unseen} not seen`; }
  const wait = (DQ.rows || []).filter(r => r.status === 'Answered').length, b = $('dq-badge');
  if (b) { const n = wait + unseen; b.style.display = n ? '' : 'none'; b.textContent = n; }
}
function renderSelfChanges(){
  const tb = $('sc-tbl'); if (!tb) return;
  if (SC.missing) { tb.innerHTML = '<tr><td colspan="7" class="empty">Not set up yet — run database file 78-employee-self-changes.sql.</td></tr>'; return; }
  const only = $('sc-show').value === 'unseen', q = $('dq-q').value.trim().toLowerCase();
  const rows = SC.rows.filter(r => (!only || !r.seen_at) && orgMatch(empById(r.emp_id) || {}, 'dq')
    && (!q || [r.emp_id, r.emp_name].some(v => String(v || '').toLowerCase().includes(q))));
  tb.innerHTML = rows.map(r => { const e = empById(r.emp_id) || {};
    return `<tr><td class="mono" style="white-space:nowrap">${esc(String(r.changed_at).slice(0, 16).replace('T', ' '))}</td>
      <td class="strong">${esc(r.emp_name || empName(e) || r.emp_id)} <span class="mono" style="color:var(--muted)">${esc(r.emp_id)}</span><div style="font-size:11px;color:var(--muted)">${esc(e.department || '')}</div></td>
      <td>${esc(dqLabel(r.field))}</td><td style="color:var(--muted)">${esc(r.old_value || '—')}</td><td class="strong">${esc(r.new_value || '—')}</td>
      <td style="font-size:12px">${esc(r.source)}</td>
      <td style="white-space:nowrap;font-size:12px">${r.seen_at ? `✓ ${esc(r.seen_by || '')}<div style="color:var(--muted)">${esc(String(r.seen_at).slice(0, 10))}</div>` : `<button class="btn btn-ghost btn-sm" data-sc-seen="${r.id}">✓ Seen</button>`}</td></tr>`; }).join('')
    || `<tr><td colspan="7" class="empty">${only ? 'Nothing new — every change has been seen' : 'No changes yet'}</td></tr>`;
  SC.shown = rows.filter(r => !r.seen_at).map(r => r.id);
}
async function scSeen(ids){
  if (!ids.length) return toast('Nothing to mark', 'warn');
  const { data, error } = await sb.rpc('mark_self_changes_seen', { p_ids: ids });
  if (error) return toast(error.message, 'err');
  toast(`${data} change${data === 1 ? '' : 's'} marked as seen`);
  await loadSelfChanges(); renderSelfChanges();
}
$('sc-tbl').addEventListener('click', e => { const b = e.target.closest('[data-sc-seen]'); if (b) { b.disabled = true; scSeen([b.dataset.scSeen]); } });
$('sc-show').addEventListener('change', renderSelfChanges);
$('sc-all').addEventListener('click', () => scSeen(SC.shown || []));
['dq-dept'].forEach(id => $(id).addEventListener('change', renderSelfChanges));
$('dq-q').addEventListener('input', () => { clearTimeout(SC.t); SC.t = setTimeout(renderSelfChanges, 250); });
const _renderDreqsSc = renderDreqs;
renderDreqs = async function(){ const r = await _renderDreqsSc.apply(this, arguments); await loadSelfChanges(); renderSelfChanges(); return r; };
const _loadDreqsSc = loadDreqs;
loadDreqs = async function(){ const r = await _loadDreqsSc.apply(this, arguments); await loadSelfChanges().catch(() => {}); return r; };

// ═════════════════════════════════════════════════════════
//  CHECK-OUTS TO RECORD (24 Oct 2026, 80-checkout-requests.sql)   ·   page 🚪 Check-outs to record (Workforce)
//  · "Tried": the phone refused a check-out away from the employee's office/site (file 79) and sent the try here.
//  · "Left": still checked in but found away from his office from 10 min after the check-in (Android background watch,
//    or the app opened away from the office).
//  HR records the check-out with one click at the time of the try (the time can be changed) → record_checkout_request
//  closes the open period in the attendance record; or rejects it with a reason. The employee is notified either way.
//  If the employee checks out normally later, the request closes by itself ("Employee checked out himself").
// ═════════════════════════════════════════════════════════
let CO = { rows: [], t: null };
const coChip = s => `<span class="chip ${({ Waiting:'c-orange', Recorded:'c-green', Rejected:'c-red', 'Checked out':'c-grey' })[s] || 'c-grey'}">${esc(
  ({ Waiting:'Waiting for HR', Recorded:'Recorded', Rejected:'Rejected', 'Checked out':'Employee checked out himself' })[s] || s)}</span>`;
const coDist = m => m == null ? '' : m >= 1000 ? `${Math.round(m / 100) / 10} km` : `${m} m`;
async function loadCoReqs(){
  const { data, error } = await sb.from('checkout_requests').select('*').order('tried_at', { ascending: false }).limit(2000);
  if (error) { CO.rows = []; CO.error = /does not exist|schema cache/i.test(error.message) ? 'missing' : error.message; }
  else { CO.rows = data || []; CO.error = null; }
  const n = CO.rows.filter(r => r.status === 'Waiting').length, b = $('co-badge');
  if (b) { b.style.display = n ? '' : 'none'; b.textContent = n; }
}
async function renderCoReqs(){
  await loadCoReqs();
  if (CO.error) { $('co-tbl').innerHTML = `<tr><td colspan="8" class="empty">${CO.error === 'missing' ? 'Not set up yet — run database file 80-checkout-requests.sql.' : esc(CO.error)}</td></tr>`; return; }
  const st = $('co-status').value, q = $('co-q').value.trim().toLowerCase();
  const rows = CO.rows.filter(r => (!st || r.status === st) && orgMatch(empById(r.emp_id) || {}, 'co')
    && (!q || [r.emp_id, r.emp_name, r.place].some(v => String(v || '').toLowerCase().includes(q))));
  const wait = CO.rows.filter(r => r.status === 'Waiting').length;
  $('co-sub').textContent = `${wait} waiting for HR · employees who tried to check out away from their office or site, or left it while still checked in. Record the check-out with one click, or reject it.`;
  $('co-tbl').innerHTML = rows.map(r => { const e = empById(r.emp_id) || { id: r.emp_id, name_en: r.emp_name };
    const what = r.kind === 'left'
      ? `🚶 Left without checking out<div style="font-size:11px;color:var(--muted)">${r.how === 'background' ? 'found by the Android app' : 'found when he opened the app'}</div>`
      : '🚪 Tried to check out away';
    return `<tr><td class="mono" style="white-space:nowrap">${esc(r.att_date)}</td>
      <td class="strong">${esc(empName(e) || r.emp_name || r.emp_id)} <span class="mono" style="color:var(--muted)">${esc(r.emp_id)}</span><div style="font-size:11px;color:var(--muted)">${esc(e.department || '')}</div></td>
      <td style="font-size:12px">${what}<div style="font-size:11px;color:var(--muted)">checked in ${esc(r.seg_in)}${r.seg_code ? ' · ' + esc(r.seg_code) : ''}</div></td>
      <td style="font-size:12px;white-space:nowrap"><b class="mono">${esc(r.local_time || '')}</b> · ${esc(coDist(r.distance_m))} from ${esc(r.place || '?')}${r.lat != null ? ` · <a href="https://www.google.com/maps?q=${Number(r.lat)},${Number(r.lng)}" target="_blank" rel="noopener">map</a>` : ''}</td>
      <td style="white-space:normal;max-width:180px;font-size:12px">${r.message ? '💬 ' + esc(r.message) : '<span style="color:var(--muted)">—</span>'}</td>
      <td>${coChip(r.status)}${r.reason ? `<div style="font-size:11px">💬 ${esc(r.reason)}</div>` : ''}${r.handled_by ? `<div style="font-size:11px;color:var(--muted)">${esc(r.handled_by)}</div>` : ''}</td>
      <td>${r.status === 'Waiting' ? `<input type="time" class="inp" style="width:128px" data-co-time="${r.id}" value="${esc(r.local_time || '')}">` : `<span class="mono">${esc(r.out_time || '')}</span>`}</td>
      <td style="white-space:nowrap">${r.status === 'Waiting' ? `<button class="btn btn-success btn-sm" data-co-ok="${r.id}">✓ Record</button><br><button class="btn btn-ghost btn-sm" data-co-no="${r.id}" style="margin-top:4px">✕ Reject</button>` : ''}</td></tr>`; }).join('')
    || `<tr><td colspan="8" class="empty">${st === 'Waiting' ? 'Nothing waiting — every check-out has been handled' : 'Nothing here'}</td></tr>`;
  $('co-foot').textContent = `${rows.length} shown. “Record” closes the open period in the attendance record at the time shown (you can change it). The employee is notified on the phone.`;
}
async function coRecord(id, btn){
  const inp = document.querySelector(`[data-co-time="${id}"]`), t = inp ? inp.value : '';
  if (!/^\d\d:\d\d$/.test(t)) { btn.disabled = false; return toast('Enter the check-out time', 'warn'); }
  const { error } = await sb.rpc('record_checkout_request', { p_id: id, p_out: t });
  btn.disabled = false;
  if (error) return toast(error.message.replace(/^[A-Z_]+: ?/, ''), 'err');
  toast(`Check-out recorded at ${t} — the employee is notified`);
  try { await loadPeriodData(); } catch(e){} finally { loader(false); }   // fix 25 Oct: hide the "Loading period…" cover
  renderCoReqs();
}
async function coReject(id){
  const why = prompt('Why is this check-out not recorded? (the employee sees this on his phone)');
  if (why === null) return; if (!why.trim()) return toast('Write the reason', 'warn');
  const { error } = await sb.rpc('reject_checkout_request', { p_id: id, p_reason: why.trim() });
  if (error) return toast(error.message.replace(/^[A-Z_]+: ?/, ''), 'err');
  toast('Rejected — the employee is notified'); renderCoReqs();
}
PAGE_RENDER.coreq = () => renderCoReqs();
$('co-tbl').addEventListener('click', e => {
  const a = e.target.closest('[data-co-ok]'); if (a) { a.disabled = true; return coRecord(a.dataset.coOk, a); }
  const r = e.target.closest('[data-co-no]'); if (r) return coReject(r.dataset.coNo);
});
['co-status', 'co-dept'].forEach(id => $(id).addEventListener('change', renderCoReqs));
$('co-q').addEventListener('input', () => { clearTimeout(CO.t); CO.t = setTimeout(renderCoReqs, 250); });
const _showPageCo = showPage;
showPage = function(name){ const r = _showPageCo.apply(this, arguments); if (name === 'coreq') renderCoReqs(); return r; };
const _loadPeriodDataCo = loadPeriodData;
loadPeriodData = async function(){ const r = await _loadPeriodDataCo.apply(this, arguments); loadCoReqs().catch(() => {}); return r; };

// ═════════════════════════════════════════════════════════
//  TEAM ATTENDANCE — direct managers see their direct reports (database file 87: team_attendance)
//  Today: who is in (since when, where), who left, on leave / mission, no record yet.
//  Period: per person — present days, late arrivals, short days, working days with no record, leave, mission, hours;
//  click a person for the day-by-day list. No pay and no GPS points are ever loaded.
// ═════════════════════════════════════════════════════════
let TA = { view:'today', data:null, open:null, q:'' };
const taMin = t => { if (!t) return null; const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };
const taDays = (a, b) => { const out = []; for (let d = dObj(a), g = 0; dStr(d) <= b && g < 400; d.setDate(d.getDate() + 1), g++) out.push(dStr(d)); return out; };
const taName = m => m ? (m.name_en || m.name_ar || m.id) : '';
const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

async function loadTeamAtt(){
  const box = $('ta-body'); if (!box) return;
  const today = todayStr();
  let from = today, to = today;
  if (TA.view === 'period') {
    from = $('ta-from').value || periodStart(cycleOf(today)); to = $('ta-to').value || today;
    if (to < from) return toast('The end date is before the start date', 'warn');
  }
  box.innerHTML = '<div class="empty">Loading your team\'s attendance…</div>';
  const { data, error } = await sb.rpc('team_attendance', { p_from: from, p_to: to });
  if (error) { box.innerHTML = `<div class="alert a-warn">${/function|schema/i.test(error.message) ? 'This page needs <b>87-team-attendance.sql</b> — ask the administrator.' : esc(error.message)}</div>`; return; }
  TA.data = data; TA.open = null; renderTeamAtt();
}

// what happened for one person on one day
function taDay(d, m, D){
  const R = D.rules, wk = (R.weekendDays || []).map(Number), today = D.today;
  const rec = D.days.filter(x => x.emp_id === m.id && x.date === d);
  const leave = D.leaves.find(l => l.emp_id === m.id && l.from <= d && l.to >= d);
  const ms = D.missions.filter(x => x.emp_id === m.id && x.from <= d && x.to >= d);
  const hol = D.holidays.find(h => h.date === d), weekend = wk.includes(dObj(d).getDay());
  const lines = rec.flatMap(r => r.lines || []), flags = [...new Set(lines.map(l => l.flag).filter(Boolean))];
  const working = rec.some(r => r.status === 'Present' || r.status === 'Half Day');
  const ins = lines.map(l => l.in).filter(Boolean).sort(), outs = lines.map(l => l.out).filter(Boolean).sort();
  const open = lines.some(l => l.in && !l.out);
  const hours = rec.reduce((s, r) => s + num(r.total_hours), 0);
  const firstIn = ins[0] || (rec[0] && rec[0].check_in) || '', lastOut = open ? '' : (outs[outs.length - 1] || (rec[0] && rec[0].check_out) || '');
  const employed = (!m.employment_date || d >= m.employment_date) && (!m.resignation_date || d <= m.resignation_date);
  let state = '', late = 0, short = 0;
  if (!employed) state = 'not employed';
  else if (working) {
    state = open && d === today ? 'in' : open ? 'no check-out' : 'present';
    if (!weekend && !hol && !m.exempt && rec.some(r => r.status === 'Present')) {
      const lim = taMin(R.lateAfter), eve = taMin(R.eveningShiftAfter), fi = taMin(firstIn);
      if (fi != null && fi < eve) late = Math.max(0, fi - lim);
      if (!open && !flags.length) short = Math.max(0, Math.round((num(R.hoursPerDay) - hours) * 60) - late);
    }
    if (ms.some(x => !x.time_from)) { late = 0; short = 0; }        // a full-day mission excuses the day
  }
  else if (rec.some(r => r.status === 'Absent')) state = 'absent';
  else if (leave) state = 'leave';
  else if (ms.length) state = 'mission';
  else if (hol) state = 'holiday';
  else if (weekend) state = 'weekend';
  else if (d < today && !m.exempt) state = 'no record';
  else if (d === today) state = 'not yet';
  return { d, rec, leave, ms, hol, weekend, lines, flags, state, firstIn, lastOut, hours, late, short,
           sites: [...new Set(lines.map(l => l.code ? (l.code + (l.site ? ' — ' + l.site : '')) : 'No project'))] };
}
function taChip(x){
  const c = { in:'c-green', present:'c-green', 'no check-out':'c-orange', absent:'c-red', 'no record':'c-red', leave:'c-blue', mission:'c-blue', holiday:'c-grey', weekend:'c-grey', 'not yet':'c-grey', 'not employed':'c-grey' }[x.state] || 'c-grey';
  const label = x.state === 'in' ? `In since ${x.firstIn}` : x.state === 'present' ? (x.lastOut ? `Left ${x.lastOut}` : 'Present')
    : x.state === 'leave' ? `On ${x.leave.type} leave` : x.state === 'mission' ? `Mission · ${x.ms[0].place || ''}`
    : x.state === 'holiday' ? (x.hol.name || 'Holiday') : x.state === 'not yet' ? 'No check-in yet' : x.state[0].toUpperCase() + x.state.slice(1);
  return `<span class="chip ${c}">${esc(label)}</span>`;
}
const taNote = x => [x.late ? `late ${fmtHM(x.late / 60)}` : '', x.short ? `short ${fmtHM(x.short / 60)}` : '',
  ...x.flags, ...x.ms.filter(m => m.time_from).map(m => `mission ${String(m.time_from).slice(0,5)}–${String(m.time_to).slice(0,5)}`)].filter(Boolean).join(' · ');

function renderTeamAtt(){
  const D = TA.data, box = $('ta-body'); if (!D) return;
  const q = TA.q.trim().toLowerCase();
  const members = (D.members || []).filter(m => !q || [m.id, m.name_en, m.name_ar, m.job_name].some(v => String(v || '').toLowerCase().includes(q)));
  if (!(D.members || []).length) { box.innerHTML = '<div class="empty">Nobody reports directly to you in the HR system. If this is wrong, ask HR to set you as their direct manager.</div>'; return; }
  if (TA.view === 'today') {
    const rows = members.map(m => ({ m, x: taDay(D.today, m, D) }));
    const n = s => rows.filter(r => r.x.state === s).length;
    $('ta-sum').innerHTML = `<b>${rows.length}</b> in your team · <b>${n('in')}</b> in now · <b>${n('present')}</b> left · <b>${n('leave') + n('mission')}</b> on leave or mission · <b>${n('not yet')}</b> no check-in yet`;
    box.innerHTML = `<div class="tbl-wrap"><table><thead><tr><th>Employee</th><th>Today</th><th>In</th><th>Out</th><th class="num">Hours</th><th>Where</th><th>Notes</th></tr></thead><tbody>${
      rows.map(({ m, x }) => `<tr><td class="strong">${esc(taName(m))} <span class="mono" style="color:var(--muted)">${esc(m.id)}</span><div style="font-size:11.5px;color:var(--muted)">${esc(m.job_name || '')}</div></td>
        <td>${taChip(x)}</td><td class="mono">${esc(x.firstIn)}</td><td class="mono">${esc(x.lastOut)}</td><td class="num">${x.hours ? fmtHM(x.hours) : ''}</td>
        <td>${esc(x.sites.join(', '))}</td><td style="font-size:12px;color:var(--warn)">${esc(taNote(x))}</td></tr>`).join('')
      || '<tr><td colspan="7" class="empty">Nobody matches the search</td></tr>'}</tbody></table></div>`;
    return;
  }
  const days = taDays(D.from, D.to);
  const rows = members.map(m => {
    const xs = days.map(d => taDay(d, m, D));
    const c = s => xs.filter(x => x.state === s).length;
    return { m, xs, present: c('present') + c('in') + c('no check-out'), norec: c('no record') + c('absent'), leave: c('leave'), mission: c('mission'),
             lateN: xs.filter(x => x.late).length, lateM: xs.reduce((s, x) => s + x.late, 0), shortN: xs.filter(x => x.short).length, shortM: xs.reduce((s, x) => s + x.short, 0),
             issues: xs.filter(x => x.flags.length || x.state === 'no check-out').length, hours: xs.reduce((s, x) => s + x.hours, 0) };
  });
  const T = k => rows.reduce((s, r) => s + r[k], 0);
  $('ta-sum').innerHTML = `${esc(D.from)} → ${esc(D.to)} · <b>${rows.length}</b> people · <b>${T('norec')}</b> working day${T('norec') === 1 ? '' : 's'} with no record · <b>${T('lateN')}</b> late arrival${T('lateN') === 1 ? '' : 's'} · <b>${T('issues')}</b> day${T('issues') === 1 ? '' : 's'} for HR to settle. Click a name for the day-by-day list.`;
  box.innerHTML = `<div class="tbl-wrap"><table><thead><tr><th>Employee</th><th class="num">Present</th><th class="num">No record</th><th class="num">Late</th><th class="num">Short days</th><th class="num">Leave</th><th class="num">Mission</th><th class="num">Hours</th><th class="num">To settle</th></tr></thead><tbody>${
    rows.map(r => `<tr class="click" data-ta-emp="${esc(r.m.id)}"><td class="strong">${TA.open === r.m.id ? '▾' : '▸'} ${esc(taName(r.m))} <span class="mono" style="color:var(--muted)">${esc(r.m.id)}</span><div style="font-size:11.5px;color:var(--muted)">${esc(r.m.job_name || '')}</div></td>
      <td class="num">${r.present}</td><td class="num" style="${r.norec ? 'color:var(--danger);font-weight:600' : ''}">${r.norec}</td>
      <td class="num">${r.lateN ? `${r.lateN} · ${fmtHM(r.lateM / 60)}` : '0'}</td><td class="num">${r.shortN ? `${r.shortN} · ${fmtHM(r.shortM / 60)}` : '0'}</td>
      <td class="num">${r.leave}</td><td class="num">${r.mission}</td><td class="num">${fmtHM(r.hours)}</td><td class="num" style="${r.issues ? 'color:var(--warn);font-weight:600' : ''}">${r.issues}</td></tr>`
      + (TA.open === r.m.id ? `<tr><td colspan="9" style="background:var(--bg2,rgba(127,127,127,.06))"><table style="width:100%"><thead><tr><th>Date</th><th>Day</th><th>Status</th><th>In</th><th>Out</th><th class="num">Hours</th><th>Where</th><th>Notes</th></tr></thead><tbody>${
          r.xs.filter(x => x.state !== 'not employed').map(x => `<tr><td class="mono">${esc(x.d)}</td><td>${DOW[dObj(x.d).getDay()]}</td><td>${taChip(x)}</td><td class="mono">${esc(x.firstIn)}</td><td class="mono">${esc(x.lastOut)}</td>
            <td class="num">${x.hours ? fmtHM(x.hours) : ''}</td><td>${esc(x.sites.join(', '))}</td><td style="font-size:12px;color:var(--warn)">${esc(taNote(x))}</td></tr>`).join('')}</tbody></table></td></tr>` : '')).join('')
    || '<tr><td colspan="9" class="empty">Nobody matches the search</td></tr>'}</tbody></table></div>`;
}

function taSetView(v){
  TA.view = v;
  $('ta-v-today').classList.toggle('on', v === 'today'); $('ta-v-period').classList.toggle('on', v === 'period');
  $('ta-range').style.display = v === 'period' ? 'flex' : 'none';
  loadTeamAtt();
}
function taCycle(back){
  const c = cycleOf(todayStr()), [y, mo] = c.split('-').map(Number), p = back ? (mo === 1 ? `${y - 1}-12` : `${y}-${pad(mo - 1)}`) : c;
  $('ta-from').value = periodStart(p); $('ta-to').value = back ? periodEnd(p) : todayStr(); loadTeamAtt();
}
$('ta-v-today').addEventListener('click', () => taSetView('today'));
$('ta-v-period').addEventListener('click', () => taSetView('period'));
$('ta-this').addEventListener('click', () => taCycle(false));
$('ta-last').addEventListener('click', () => taCycle(true));
['ta-from', 'ta-to'].forEach(id => $(id).addEventListener('change', loadTeamAtt));
$('ta-refresh').addEventListener('click', loadTeamAtt);
$('ta-q').addEventListener('input', e => { TA.q = e.target.value; renderTeamAtt(); });
$('ta-body').addEventListener('click', e => { const r = e.target.closest('[data-ta-emp]'); if (!r) return; TA.open = TA.open === r.dataset.taEmp ? null : r.dataset.taEmp; renderTeamAtt(); });

// ═════════════════════════════════════════════════════════
//  STATUS FILTERS (26 Oct 2026) — "All statuses" box on every table with a Status column
//  · pages with their own data filter call stFill() from their render function
//    (Vacations, Attendance, Projects, Loans, Project allowance rules)
//  · smaller tables (self-service, Employee voice) are filtered on screen by domStatusFilter()
//  Each option shows how many rows have that status with the page's other filters applied.
// ═════════════════════════════════════════════════════════
const ST_ORDER = ['Waiting for you','Waiting for manager','Waiting for employee','Waiting for board','Waiting for HR','Waiting','Pending',
  'Pending manager','Pending HR','Requested','Answered','New','In review','In progress','Approved','Active','Present','Recorded','Completed',
  'Accepted','Closed','Rejected','Returned','Cancelled'];
function stSort(a, b){
  const ia = ST_ORDER.indexOf(a), ib = ST_ORDER.indexOf(b);
  if (ia !== ib) return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
  return String(a).localeCompare(String(b));
}
// fills the status box with the statuses found in vals (with counts); keeps the current choice; returns it
function stFill(id, vals){
  const sel = $(id); if (!sel) return '';
  const keep = sel.value, cnt = {};
  vals.forEach(v => { if (v != null && v !== '') cnt[v] = (cnt[v] || 0) + 1; });
  if (keep && !(keep in cnt)) cnt[keep] = 0;   // a chosen status with no rows stays chosen (shows 0)
  const keys = Object.keys(cnt).sort(stSort);
  sel.innerHTML = `<option value="">All statuses (${vals.length})</option>` + keys.map(k => `<option value="${esc(k)}">${esc(k)} (${cnt[k]})</option>`).join('');
  sel.value = keep;
  sel.classList.toggle('st-on', !!keep);
  return keep;
}
[['lv-stf', () => renderLeaves()], ['att-status', () => renderAttendance()], ['proj-status', () => renderProjects()],
 ['par-status', () => renderParRules()], ['loan-status', () => renderLoans()], ['loan-dept', () => renderLoans()]]
  .forEach(([id, fn]) => { const el = $(id); if (el) el.addEventListener('change', fn); });
if ($('loan-q')) $('loan-q').addEventListener('input', () => renderLoans());

// on-screen filter for a table body: adds the box to the card's toolbar and re-applies whenever the rows are redrawn
function stCellText(td){
  if (!td) return '';
  const c = td.querySelector('.chip');
  return (c ? c.textContent : (td.firstChild ? td.firstChild.textContent || '' : '')).replace(/\s+/g, ' ').trim();
}
function domStatusFilter(tbodyId){
  const tb = $(tbodyId); if (!tb || tb.dataset.stf) return;
  const table = tb.closest('table'), card = tb.closest('.card');
  const col = [...table.querySelectorAll('thead th')].findIndex(th => th.textContent.trim() === 'Status');
  if (col < 0 || !card) return;
  tb.dataset.stf = '1';
  let bar = card.querySelector('.toolbar');
  if (!bar){ bar = document.createElement('div'); bar.className = 'toolbar'; card.insertBefore(bar, card.firstChild); }
  let right = bar.querySelector('.toolbar-right');
  if (!right){ right = document.createElement('div'); right.className = 'toolbar-right'; right.style.marginLeft = 'auto'; bar.appendChild(right); }
  const sel = document.createElement('select');
  sel.className = 'sel'; sel.id = tbodyId + '-st'; sel.title = 'Filter by status';
  right.insertBefore(sel, right.firstChild);
  let obs;
  const apply = () => {
    tb.querySelectorAll('tr.st-none').forEach(r => r.remove());
    const rows = [...tb.children].filter(r => r.tagName === 'TR' && r.children.length > col && !r.querySelector(':scope > td.empty'));
    const st = stFill(sel.id, rows.map(r => stCellText(r.children[col])));
    let shown = 0;
    rows.forEach(r => { const ok = !st || stCellText(r.children[col]) === st; r.style.display = ok ? '' : 'none'; if (ok) shown++; });
    if (rows.length && !shown){
      const tr = document.createElement('tr'); tr.className = 'st-none';
      tr.innerHTML = `<td colspan="${table.querySelectorAll('thead th').length}" class="empty">Nothing with the status “${esc(st)}” — choose “All statuses”</td>`;
      tb.appendChild(tr);
    }
    if (obs) obs.takeRecords();   // our own changes must not trigger another round
  };
  sel.addEventListener('change', apply);
  obs = new MutationObserver(apply);
  obs.observe(tb, { childList: true });
  apply();
}
['self-list', 'smis-tbl', 'self-treq-tbl', 'self-team-tbl', 'vo-fb', 'vo-act', 'vo-sal', 'vo-hire', 'vo-train'].forEach(domStatusFilter);

// ═════════════════════════════════════════════════════════
//  DATES TYPED AS DAY-MONTH-YEAR (26 Oct 2026) — Mohammed: "type dates like 26102026, 01012026"
//  Every <input type="date"> of the desktop app becomes a text box that accepts
//    26102026 · 26/10/2026 · 26-10-2026 · 26.10.2026 · 261026 (→ 2026) · 2026-10-26 (pasted)
//  and shows 26/10/2026. Its .value still reads and writes yyyy-mm-dd, so every screen keeps working
//  unchanged ('' while the date is incomplete or impossible). The 📅 icon at the right opens the calendar.
//  Boxes added later (windows, forms drawn by code) are converted automatically.
// ═════════════════════════════════════════════════════════
const DMY_NATIVE = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
function dmyIso(y, m, d){
  y = +y; m = +m; d = +d;
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1) return null;
  const last = new Date(y, m, 0).getDate();
  if (d > last) return null;
  return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}
// text typed by the user → 'yyyy-mm-dd', '' (empty) or null (not a date)
function dmyParse(t){
  const s = String(t == null ? '' : t).trim();
  if (!s) return '';
  let m;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) return dmyIso(m[1], m[2], m[3]);
  if ((m = /^(\d{1,2})[\/.\-\s](\d{1,2})[\/.\-\s](\d{4}|\d{2})$/.exec(s))) return dmyIso(m[3].length === 2 ? '20' + m[3] : m[3], m[2], m[1]);
  if ((m = /^(\d{2})(\d{2})(\d{4})$/.exec(s))) return dmyIso(m[3], m[2], m[1]);
  if ((m = /^(\d{2})(\d{2})(\d{2})$/.exec(s))) return dmyIso('20' + m[3], m[2], m[1]);
  return null;
}
function dmyShow(iso){ const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; }

function dmyConvert(el){
  if (!el || el.dataset.dmy || el.type !== 'date') return;
  const iso = DMY_NATIVE.get.call(el);
  el.dataset.dmy = '1';
  el.type = 'text';
  el.classList.add('dmy');
  el.setAttribute('inputmode', 'numeric');
  el.setAttribute('autocomplete', 'off');
  if (!el.placeholder) el.placeholder = 'dd/mm/yyyy';
  el.maxLength = 10; el.size = 10;
  if (!el.title) el.title = 'Type the date as day month year, e.g. 26102026 or 26/10/2026 — or click 📅';
  Object.defineProperty(el, 'value', {
    configurable: true,
    get(){ const v = dmyParse(DMY_NATIVE.get.call(el)); return v || ''; },
    set(v){ const s = v == null ? '' : String(v); const p = dmyParse(s); DMY_NATIVE.set.call(el, p ? dmyShow(p) : s); el.classList.toggle('dmy-bad', p === null); el._dmyLast = el.value; }
  });
  el.value = iso;
}
function dmyConvertAll(root){
  if (!root || !root.querySelectorAll) return;
  if (root.matches && root.matches('input[type="date"]')) dmyConvert(root);
  root.querySelectorAll('input[type="date"]').forEach(dmyConvert);
}
dmyConvertAll(document);
new MutationObserver(list => list.forEach(m => m.addedNodes.forEach(n => { if (n.nodeType === 1) dmyConvertAll(n); })))
  .observe(document.body, { childList: true, subtree: true });

// while typing: only digits and separators; when a complete date is typed it is shown as 26/10/2026 and the screen updates at once
document.addEventListener('input', e => {
  const el = e.target; if (!el || !el.dataset || !el.dataset.dmy) return;
  const raw = DMY_NATIVE.get.call(el), clean = raw.replace(/[^\d\/.\-\s]/g, '');
  if (clean !== raw) DMY_NATIVE.set.call(el, clean);
  const p = dmyParse(clean);
  el.classList.remove('dmy-bad');
  if (p && (/^\d{8}$/.test(clean) || /^\d{1,2}[\/.\-\s]\d{1,2}[\/.\-\s]\d{4}$/.test(clean))){
    DMY_NATIVE.set.call(el, dmyShow(p));
    if (el._dmyLast !== p){ el._dmyLast = p; el.dispatchEvent(new Event('change', { bubbles: true })); }
  }
}, true);
// leaving the box: tidy it or mark it red
document.addEventListener('blur', e => {
  const el = e.target; if (!el || !el.dataset || !el.dataset.dmy) return;
  const raw = DMY_NATIVE.get.call(el), p = dmyParse(raw);
  if (p) { DMY_NATIVE.set.call(el, dmyShow(p)); el.classList.remove('dmy-bad'); }
  else el.classList.toggle('dmy-bad', p === null);
}, true);
// the native "change" of a text box fires on blur — skip it when nothing really changed
document.addEventListener('change', e => {
  const el = e.target; if (!el || !el.dataset || !el.dataset.dmy || !e.isTrusted) return;
  const v = el.value;
  if (el._dmyLast === v) { e.stopImmediatePropagation(); return; }
  el._dmyLast = v;
}, true);

// 📅 calendar: one hidden native date box placed over the clicked box
const DMY_PICK = document.createElement('input');
DMY_PICK.type = 'date'; DMY_PICK.dataset.dmy = 'native'; DMY_PICK.tabIndex = -1;
DMY_PICK.style.cssText = 'position:fixed;opacity:0;pointer-events:none;width:1px;height:1px;border:0;padding:0';
document.body.appendChild(DMY_PICK);
let DMY_FOR = null;
DMY_PICK.addEventListener('change', () => {
  if (!DMY_FOR) return; const v = DMY_NATIVE.get.call(DMY_PICK);
  DMY_FOR.value = v; DMY_FOR._dmyLast = v; DMY_FOR.dispatchEvent(new Event('change', { bubbles: true }));
  DMY_FOR.dispatchEvent(new Event('input', { bubbles: true }));
});
document.addEventListener('click', e => {
  const el = e.target; if (!el || !el.dataset || el.dataset.dmy !== '1' || el.disabled || el.readOnly) return;
  const r = el.getBoundingClientRect();
  if (e.clientX < r.right - 30) return;                       // only the icon area opens the calendar
  DMY_FOR = el;
  DMY_PICK.style.left = r.left + 'px'; DMY_PICK.style.top = r.bottom + 'px';
  DMY_NATIVE.set.call(DMY_PICK, el.value || '');
  try { DMY_PICK.showPicker(); } catch(_) { DMY_PICK.focus(); }
});
document.head.insertAdjacentHTML('beforeend', `<style>
input.dmy{padding-right:30px!important;min-width:128px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%238a93a6' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='3' y='4' width='18' height='18' rx='2'/%3E%3Cpath d='M16 2v4M8 2v4M3 10h18'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 9px center;font-variant-numeric:tabular-nums}
input.dmy.dmy-bad{border-color:#d33!important;box-shadow:0 0 0 2px rgba(221,51,51,.18)}
input.dmy:disabled{opacity:.55;cursor:not-allowed}
</style>`);
// a date typed wrongly must never be saved as "no date": Save / Approve buttons next to a red date box refuse until it is fixed
document.addEventListener('click', e => {
  const btn = e.target.closest && e.target.closest('.btn-primary,.btn-success'); if (!btn) return;
  const scope = btn.closest('.modal') || btn.closest('.page') || btn.closest('#self') || document;
  const bad = [...scope.querySelectorAll('input.dmy')].find(el => el.offsetParent !== null && dmyParse(DMY_NATIVE.get.call(el)) === null);
  if (!bad) return;
  e.preventDefault(); e.stopImmediatePropagation();
  bad.classList.add('dmy-bad'); bad.focus();
  toast(`“${DMY_NATIVE.get.call(bad)}” is not a real date — type day month year, e.g. 26102026`, 'warn');
}, true);

// @ts-check — checked by TypeScript (tsconfig.json); keep it free of type errors
// ═════════════════════════════════════════════════════════
//  REPORTS: FROM / TO DATES (26 Oct 2026) — Mohammed: "all reports must have a filter by date from date to date"
//  · 'range' reports (attendance, vacations, permissions, phone taps, projects, penalties, joiners…) use the two dates.
//    Inside the current payroll cycle they use the data already loaded; any other dates (up to 400 days) are loaded
//    from the database for the report only — the payroll cycle is not changed. Rows with a date are kept only when
//    the date is inside the range; summaries are calculated from the days inside the range only.
//  · 'cycle' reports (pay, labour cost, absence deductions, loans) always cover one whole payroll cycle.
//  · 'none' reports are lists of today's situation (master list, headcount, balances, data checks…).
// ═════════════════════════════════════════════════════════
const REP_DATES = {
  'att-absence':'cycle', 'prj-cost':'cycle', 'prj-cost-detail':'cycle', 'pay-register':'cycle', 'pay-summary':'cycle',
  'pay-elements':'cycle', 'pay-si':'cycle', 'pay-bank':'cycle', 'pay-loans':'cycle',
  'att-exempt':'none', 'lv-balance':'none', 'hr-assignments':'none', 'att-phones':'none', 'hr-headcount':'none',
  'hr-master':'none', 'hr-alerts':'none', 'hr-quality':'none', 'emp-birth-id':'none', 'emp-missing':'none' };
function repDatesMode(r){ return (r && (r.dates || REP_DATES[r.id])) || 'range'; }

let REP_RANGE = null;                       // the dates the user chose (kept while cycle / today-only reports are open)
function repCycleRange(p){ p = p || settings.period; return { from: periodStart(p), to: periodEnd(p) }; }
function repRange(){
  const f = $('rep-from'), t = $('rep-to');
  if (!REP_RANGE) REP_RANGE = repCycleRange();
  const from = f.value, to = t.value;
  const raw = el => el.dataset.dmy ? DMY_NATIVE.get.call(el) : '';
  if (!from && /\S/.test(raw(f))) return { error:'The “From” date is not a real date — type it as day month year, e.g. 21102026.' };
  if (!to && /\S/.test(raw(t))) return { error:'The “To” date is not a real date — type it as day month year, e.g. 20112026.' };
  const r = { from: from || REP_RANGE.from, to: to || REP_RANGE.to };
  if (r.to < r.from) return { error:'“To” is before “From”.' };
  if ((dObj(r.to).getTime() - dObj(r.from).getTime()) / 86400000 > 400) return { error:'Please choose at most about one year (400 days) at a time.' };
  return r;
}
function repDateBar(mode){
  const f = $('rep-from'), t = $('rep-to'), btns = ['rep-today','rep-cyc','rep-prev'];
  if (!REP_RANGE) REP_RANGE = repCycleRange();
  const on = mode === 'range';
  [f, t, ...btns.map(id => $(id))].forEach(el => el.disabled = !on);
  if (on){
    if (f.dataset.shown !== 'range'){ f.value = REP_RANGE.from; t.value = REP_RANGE.to; }
    const c = repCycleRange(), r = repRange();
    $('rep-dnote').textContent = r.error ? '' : (r.from >= c.from && r.to <= c.to ? '' : '📅 Dates outside the current payroll cycle — loaded for this report only; the payroll cycle is not changed.');
  } else if (mode === 'cycle'){
    const c = repCycleRange(); f.value = c.from; t.value = c.to;
    $('rep-dnote').textContent = `Pay figures always cover one whole payroll cycle (${periodLabel(settings.period)}). To see another cycle, change it in Settings.`;
  } else {
    $('rep-dnote').textContent = 'This list shows today\'s situation — dates do not apply.';
  }
  f.dataset.shown = on ? 'range' : mode;
}
function repSetRange(from, to){ REP_RANGE = { from, to }; $('rep-from').value = from; $('rep-to').value = to; runReport(); }
['from','to'].forEach(k => $('rep-' + k).addEventListener('change', () => {
  const el = $('rep-' + k), v = el.value; REP_RANGE = REP_RANGE || repCycleRange();
  if (v) REP_RANGE = { ...REP_RANGE, [k]: v };
  else if (!/\S/.test(el.dataset.dmy ? DMY_NATIVE.get.call(el) : '')) el.value = REP_RANGE[k];   // emptied → back to the last date
  runReport(); }));
$('rep-today').addEventListener('click', () => repSetRange(todayStr(), todayStr()));
$('rep-cyc').addEventListener('click', () => { const c = repCycleRange(); repSetRange(c.from, c.to); });
$('rep-prev').addEventListener('click', () => { const i = periodIdx(settings.period) - 1, c = repCycleRange(`${Math.floor(i/12)}-${pad(i%12+1)}`); repSetRange(c.from, c.to); });

// data for the range: the loaded cycle when the range is inside it, otherwise loaded once (kept 5 minutes)
let REPR = null, REPR_BUSY = null;
function repRangeData(rg){
  const c = repCycleRange(), inR = d => !!d && String(d).slice(0,10) >= rg.from && String(d).slice(0,10) <= rg.to;
  let src;
  if (rg.from >= c.from && rg.to <= c.to)
    src = { attendance:S.attendance, clocks:S.clocks, permissions:S.permissions, leaves:S.leaves, missions:S.missions, penalties:S.penalties, undos:S.undos || [] };
  else if (REPR && REPR.period === settings.period && REPR.from <= rg.from && REPR.to >= rg.to && Date.now() - REPR.at < 5*60*1000) src = REPR;
  else { repLoadRange(rg); return { wait:`Loading attendance from ${dmyShow(rg.from)} to ${dmyShow(rg.to)}…` }; }
  return { attendance: src.attendance.filter(a => inR(a.date)), clocks: src.clocks.filter(x => inR(x.local_date)),
           permissions: src.permissions.filter(x => inR(x.date)), leaves: src.leaves, missions: src.missions,
           penalties: src.penalties, undos: src.undos.filter(u => inR(u.date)) };
}
async function repLoadRange(rg){
  const key = rg.from + '|' + rg.to; if (REPR_BUSY === key) return; REPR_BUSY = key;
  const soft = pr => pr.catch(e => { console.warn(e.message); return []; });
  try {
    const [attendance, clocks, permissions, leaves, missions, penalties, undos] = await Promise.all([
      fetchAll('attendance','date', q => q.gte('date', rg.from).lte('date', rg.to)),
      soft(fetchAll('clock_events','at', q => q.gte('local_date', rg.from).lte('local_date', rg.to))),
      soft(fetchAll('attendance_permissions','date', q => q.gte('date', rg.from).lte('date', rg.to))),
      soft(fetchAll('employee_leaves','date_from', q => q.lte('date_from', rg.to).gte('date_to', rg.from))),
      soft(fetchAll('employee_missions','date_from', q => q.gte('date_to', rg.from).lte('date_from', rg.to))),
      soft(fetchAll('employee_penalties','incident_date', q => q.gte('incident_date', rg.from).lte('incident_date', rg.to))),
      soft(fetchAll('checkout_undos','date', q => q.gte('date', rg.from).lte('date', rg.to))) ]);
    REPR = { from:rg.from, to:rg.to, at:Date.now(), period:settings.period, attendance, clocks, permissions, leaves, missions, penalties, undos };
  } catch(e){ toast('Could not load these dates — ' + e.message, 'err'); REPR_BUSY = null; return; }
  REPR_BUSY = null;
  if (repCur) runReport();
}
// the report is built with the range's data in place of the cycle's, then everything is put back
function repWithData(D, fn){
  if (!D) return fn();
  const keys = ['attendance','clocks','permissions','leaves','missions','penalties','undos'], old = {};
  keys.forEach(k => { old[k] = S[k]; S[k] = D[k]; });
  try { return fn(); } finally { keys.forEach(k => { S[k] = old[k]; }); }
}

// ═════════════════════════════════════════════════════════
//  MAY CHECK IN AWAY FROM OFFICE / SITE (26 Oct 2026, database 89-location-free-employees.sql)
//  Location checks page → card 🧭: the employees whose away check-ins are accepted even when the rule is "Refuse it".
// ═════════════════════════════════════════════════════════
let LOC_FREE = [], lfMissing = false;
async function loadLocFree(){
  const r = await sb.from('location_free_employees').select('*').order('added_at');
  lfMissing = !!r.error; LOC_FREE = r.data || [];
}
function renderLocFree(){
  if (!$('lf-tbl')) return;
  $('lf-title').textContent = `🧭 May check in away from office / site (${LOC_FREE.length})`;
  const rows = LOC_FREE.slice().sort((a, b) => String(a.emp_id).localeCompare(String(b.emp_id), undefined, { numeric:true }));
  $('lf-tbl').innerHTML = lfMissing ? '<tr><td colspan="6" class="empty">Database update 89-location-free-employees.sql has not been run yet.</td></tr>'
    : rows.map(x => { const e = empById(x.emp_id) || {};
      return `<tr><td class="strong">${esc(empName(e) || x.emp_id)} <span class="mono" style="color:var(--muted)">${esc(x.emp_id)}</span></td><td>${esc(e.job_name || '')}</td>
        <td style="white-space:normal">${esc(x.note || '')}</td><td>${esc(x.added_by || '')}</td><td class="mono">${esc(dmyShow(String(x.added_at || '').slice(0, 10)))}</td>
        <td><button class="btn btn-ghost btn-sm no-officer" data-lf-del="${esc(x.emp_id)}">Remove</button></td></tr>`; }).join('')
    || '<tr><td colspan="6" class="empty">Nobody — everyone follows the rule above.</td></tr>';
}
async function setLocFree(emp, on, note){
  const { data, error } = await sb.rpc('set_location_free', { p_emp: emp, p_on: on, p_note: note || null });
  if (error) return toast(error.message, 'err');
  toast(on ? `${empName(empById(emp)) || emp} may now check in away from office / site` : `${empName(empById(emp)) || emp} follows the location rule again`);
  await loadLocFree(); renderLocFree();
  return data;
}
$('lf-add').addEventListener('click', async () => {
  const emp = parseEmpInput($('lf-emp').value);
  if (!emp) return toast('Pick the employee from the suggestions', 'warn');
  if (LOC_FREE.some(x => String(x.emp_id) === emp)) return toast('Already on the list', 'warn');
  await setLocFree(emp, true, $('lf-note').value.trim());
  $('lf-emp').value = ''; $('lf-note').value = '';
});
$('lf-tbl').addEventListener('click', e => {
  const b = e.target.closest('[data-lf-del]'); if (!b) return;
  const emp = b.dataset.lfDel;
  if (b.dataset.sure !== '1'){ b.dataset.sure = '1'; b.textContent = 'Click again to remove'; b.classList.add('btn-danger'); setTimeout(() => { if (b.isConnected){ b.dataset.sure = ''; b.textContent = 'Remove'; b.classList.remove('btn-danger'); } }, 4000); return; }
  setLocFree(emp, false);
});
// loaded and drawn with the rest of the Location checks page
const _loadLocationData46 = loadLocationData;
loadLocationData = async function(){ await Promise.all([_loadLocationData46.apply(this, arguments), loadLocFree().catch(() => { lfMissing = true; })]); };
const _renderLocations46 = renderLocations;
renderLocations = function(){ _renderLocations46.apply(this, arguments); renderLocFree(); };
PAGE_RENDER.locations = () => { loadLocationData().then(renderLocations, renderLocations); };

// ═════════════════════════════════════════════════════════
//  WHO MAY SET SITE LOCATIONS FROM THE PHONE + latest changes (26 Oct 2026, database 91-site-points-office-rule.sql)
//  Location checks → card 📍: HR chooses trusted employees; they save a project's map point on the phone where they stand.
// ═════════════════════════════════════════════════════════
let SP_SETTERS = [], SP_LOG = [], spwMissing = false;
async function loadSitePointData(){
  const [a, b] = await Promise.all([
    sb.from('site_point_setters').select('*').order('added_at'),
    sb.from('site_point_log').select('*').order('at', { ascending:false }).limit(30) ]);
  spwMissing = !!a.error; SP_SETTERS = a.data || []; SP_LOG = b.data || [];
}
function renderSitePointCard(){
  if (!$('spw-tbl')) return;
  $('spw-title').textContent = `📍 May set site locations from the phone (${SP_SETTERS.length})`;
  $('spw-tbl').innerHTML = spwMissing ? '<tr><td colspan="6" class="empty">Database update 91-site-points-office-rule.sql has not been run yet.</td></tr>'
    : SP_SETTERS.slice().sort((a, b) => String(a.emp_id).localeCompare(String(b.emp_id), undefined, { numeric:true })).map(x => { const e = empById(x.emp_id) || {};
      return `<tr><td class="strong">${esc(empName(e) || x.emp_id)} <span class="mono" style="color:var(--muted)">${esc(x.emp_id)}</span></td><td>${esc(e.job_name || '')}</td>
        <td style="white-space:normal">${esc(x.note || '')}</td><td>${esc(x.added_by || '')}</td><td class="mono">${esc(dmyShow(String(x.added_at || '').slice(0, 10)))}</td>
        <td><button class="btn btn-ghost btn-sm no-officer" data-spw-del="${esc(x.emp_id)}">Remove</button></td></tr>`; }).join('')
    || '<tr><td colspan="6" class="empty">Nobody yet — add a trusted employee (e.g. a site engineer).</td></tr>';
  const ll = (a, b) => a == null ? '—' : `${Number(a).toFixed(5)}, ${Number(b).toFixed(5)}`;
  $('spl-tbl').innerHTML = SP_LOG.map(l => { const p = S.projects.find(x => String(x.id) === String(l.project_code)) || {};
      const what = l.new_lat == null ? 'Point removed' : l.old_lat == null ? `New point ${ll(l.new_lat, l.new_lng)}` : `Moved ${ll(l.old_lat, l.old_lng)} → ${ll(l.new_lat, l.new_lng)}`;
      return `<tr><td class="mono" style="white-space:nowrap">${esc(dmyShow(String(l.at).slice(0, 10)))} ${esc(String(l.at).slice(11, 16))}</td>
        <td><span class="mono">${esc(l.project_code)}</span> ${esc(p.name || '')}</td><td style="white-space:normal">${esc(what)}${l.new_radius ? ` · ${l.new_radius} m` : ''}</td>
        <td>${esc(l.set_by_name || '')}${l.set_by_emp ? ` <span class="mono" style="color:var(--muted)">${esc(l.set_by_emp)}</span>` : ''}</td>
        <td>${l.how === 'phone' ? '📱 Phone' : l.how === 'removed' ? '✕ Removed' : '🖥 Desktop'}</td><td class="num">${l.accuracy != null ? '±' + l.accuracy + ' m' : ''}</td>
        <td style="white-space:normal">${esc(l.note || '')}</td>
        <td>${l.new_lat != null ? `<a class="maplink" href="https://www.google.com/maps?q=${l.new_lat},${l.new_lng}" target="_blank" rel="noopener">📍 Open map</a>` : ''}</td></tr>`; }).join('')
    || '<tr><td colspan="8" class="empty">No site location has been set or changed yet.</td></tr>';
}
async function setSitePointSetter(emp, on, note){
  const { error } = await sb.rpc('set_site_point_setter', { p_emp: emp, p_on: on, p_note: note || null });
  if (error) return toast(error.message, 'err');
  toast(on ? `${empName(empById(emp)) || emp} can now set site locations from the phone` : `${empName(empById(emp)) || emp} can no longer set site locations`);
  await loadSitePointData(); renderSitePointCard();
}
$('spw-add').addEventListener('click', async () => {
  const emp = parseEmpInput($('spw-emp').value);
  if (!emp) return toast('Pick the employee from the suggestions', 'warn');
  if (SP_SETTERS.some(x => String(x.emp_id) === emp)) return toast('Already on the list', 'warn');
  await setSitePointSetter(emp, true, $('spw-note').value.trim());
  $('spw-emp').value = ''; $('spw-note').value = '';
});
$('spw-tbl').addEventListener('click', e => {
  const b = e.target.closest('[data-spw-del]'); if (!b) return;
  if (b.dataset.sure !== '1'){ b.dataset.sure = '1'; b.textContent = 'Click again to remove'; setTimeout(() => { if (b.isConnected){ b.dataset.sure = ''; b.textContent = 'Remove'; } }, 4000); return; }
  setSitePointSetter(b.dataset.spwDel, false);
});
// loaded with the Location checks page; the projects are re-read so points set on phones show who set them
const _loadLocationData47 = loadLocationData;
loadLocationData = async function(){
  await Promise.all([_loadLocationData47.apply(this, arguments), loadSitePointData().catch(() => { spwMissing = true; }),
    sb.from('projects').select('id,site_lat,site_lng,site_radius_m,site_set_by,site_set_at,site_set_how').not('site_lat', 'is', null)
      .then(r => { (r.data || []).forEach(x => { const p = S.projects.find(y => String(y.id) === String(x.id)); if (p) Object.assign(p, x); }); }, () => {}) ]);
};
const _renderLocations47 = renderLocations;
renderLocations = function(){ _renderLocations47.apply(this, arguments); renderSitePointCard(); };
PAGE_RENDER.locations = () => { loadLocationData().then(renderLocations, renderLocations); };

// ═════════════════════════════════════════════════════════
//  BOOT
// ═════════════════════════════════════════════════════════
// Built-in connection: when the key below is filled in, everyone goes straight to the sign-in screen.
// The publishable key is public by design (logins + database rules protect the data). Never put the secret/service key here.
const EMBED_URL = 'https://hckkrzghxxhauotyqlqr.supabase.co';
const EMBED_KEY = 'sb_publishable_yyfkPLo6M7XDe3lwurctmw_6wsmB-2M';
(function boot(){
  const embedded = EMBED_KEY && !EMBED_KEY.startsWith('PASTE-');
  if (embedded){ localStorage.setItem('sb_url', EMBED_URL); localStorage.setItem('sb_key', EMBED_KEY); $('setup').style.display = 'none'; }
  const url = embedded ? EMBED_URL : localStorage.getItem('sb_url'), key = embedded ? EMBED_KEY : localStorage.getItem('sb_key');
  if (url) $('cfg-url').value = url; if (key) $('cfg-key').value = key;
  if (!lib()){ const e=$('setup-err'); e.textContent='The app could not load. Check your internet connection and reload.'; e.style.display='block'; return; }
  if (url && key) startApp(url, key).catch(e => { const x=$('setup-err'); x.textContent='Auto-connect failed: '+e.message; x.style.display='block'; $('setup').style.display='flex'; $('app').style.display='none'; });
})();

