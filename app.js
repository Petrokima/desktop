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

// ═════════════════════════════════════════════════════════
//  STATE
// ═════════════════════════════════════════════════════════
/** @type {AppDb} — the database connection (typed: every table, column and database function is checked) */
let sb = /** @type {any} — set at start-up, before anything reads from the database */ (null);
let DB_HOST = '';                // the database's address, e.g. abc.supabase.co (set by startApp)
/** The data loaded for the current payroll cycle — rows straight from the database (types: types/globals.d.ts).
 * @type {{ employees: Employee[], projects: Project[], attendance: AttendanceRow[], elements: SalaryElement[], fixed: FixedElement[],
 *          monthly: MonthlyEntry[], loans: Loan[], permissions: Permission[], leaves: Leave[], penalties: Penalty[], holidays: Holiday[],
 *          hrreq: HrRequest[], runs: PayrollRun[], runLines: PayrollRunLine[], clocks: ClockEvent[], devices: EmployeeDevice[],
 *          parRules: AllowanceRule[], allowAppr: AllowanceApproval[], phoneAlerts: PhoneAlert[], empProjects: EmployeeProject[],
 *          missions: Mission[], undos?: Row<'checkout_undos'>[] }}   (undos: filled by part37) */
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
/** @type {typeof DEFAULTS & { calcRates?: any }} — company settings; calcRates = the payroll calculator's own rates (part21) */
let settings = { ...DEFAULTS };
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

// ═════════════════════════════════════════════════════════
//  HELPERS
// ═════════════════════════════════════════════════════════
/** @type {(id: string) => any} element by id (typed loosely on purpose: forms, buttons, inputs …) */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
const fmt = v => num(v).toLocaleString('en-US', { minimumFractionDigits:0, maximumFractionDigits:2 });
const pad = n => String(n).padStart(2,'0');
// Today in CAIRO (YYYY-MM-DD), whatever time zone the computer is set to — the database's payroll uses Cairo time too, so both
// agree on which days are past (absences). Before 31 Oct 2026 this used the computer's zone: from midnight to 2 a.m. Cairo a PC
// set to UTC was still on "yesterday" and the payroll check against the database differed.
const CAIRO_DAY = new Intl.DateTimeFormat('en-CA', { timeZone:'Africa/Cairo', year:'numeric', month:'2-digit', day:'2-digit' });
function todayStr(){ return CAIRO_DAY.format(new Date()); }
function thisMonth(){ return todayStr().slice(0,7); }
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
/**
 * @template {keyof DB['Tables'] | keyof DB['Views']} T
 * @param {T} table  a table or view of our database (checked)
 * @param {string} [orderCol]  @param {(q: any) => any} [filterFn]  extra filters, e.g. q => q.eq('period', p)
 * @returns {Promise<(T extends keyof DB['Tables'] ? Row<T> : DB['Views'][T & keyof DB['Views']]['Row'])[]>} every row
 */
async function fetchAll(table, orderCol, filterFn){
  const size = 1000;
  const page = (from, withCount) => {
    const db = /** @type {any} — table chosen by the caller; the result type is given above */ (sb);
    let q = withCount ? db.from(table).select('*', { count:'exact' }) : db.from(table).select('*');
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
  DB_HOST = url.replace(/^https?:\/\//,'');          // shown on the Settings page (React: react/src/settings)
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
  settings = { ...DEFAULTS, .../** @type {Partial<typeof settings>} — the saved settings package */ ((data && data[0] && data[0].value) || {}) };
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
    S.employees = /** @type {Employee[]} — HR officers get the safe view: the same rows without pay and bank columns */ (emps); S.projects = projs; S.elements = els; S.fixed = fx; S.loans = ln;
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
}

// Pages are prepared when they are opened (the payroll calculation, reports and labour cost are the heavy ones)
const PAGE_RENDER = { dashboard:()=>renderDashboard(), projects:()=>renderProjects(),
  loans:()=>renderLoans(), permissions:()=>renderPermissions(),
  leaves:()=>renderLeaves(), exempt:()=>renderExempt(), penalties:()=>renderPenalties(), holidays:()=>renderHolidays(), hrreq:()=>renderHrRequests(),
  reporting:()=>renderReporting(), history:()=>renderHistory(), parrules:()=>renderParRules(), approvals:()=>renderApprovals(), assign:()=>renderAssign(), calc:()=>renderCalc(), news:()=>renderNewsPage() };
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
  return { full:false, hours: Math.round(ms.reduce((s,m) => s + Math.max(0, toMin(/** @type {string} */ (m.time_to)) - toMin(/** @type {string} */ (m.time_from))) / 60, 0) * 100) / 100 };
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
// The dashboard is React since 31 Oct 2026 (react/src/dashboard). Kept here: the menu badges, which follow every change; parts 22 / 24 /
// 26 / 33 extend this with their badges and the loading of voice, HR alerts and the board member's requests.
function renderDashboard(){ updateBadges(); if (typeof PKR !== 'undefined') PKR.render(); }

// ═════════════════════════════════════════════════════════
//  RENDER — EMPLOYEES
// ═════════════════════════════════════════════════════════
// The list moved to React 31 Oct 2026 (react/src/employees); the employee window (part5) still calls this after a save.
function renderEmployees(){ if (typeof PKR !== 'undefined') PKR.render(); }

// ═════════════════════════════════════════════════════════
//  EMPLOYEE WINDOW — the boxes (React draws the window: react/src/employee)
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
// The employee WINDOW is React since 31 Oct 2026 (react/src/employee — the form, Save with its checks, phone, salary package,
// basic salary requests, projects, employment history, leave balance, certificates). Kept here: the list of boxes above (also
// used by self-service, Bulk upload and reports) and what the React window tells the old code after a change.
/** opens the employee window (rows, dashboard, reports, "+ Add Employee"); no id = a new employee @param {string | null} id */
function openEmp(id){ if (typeof PKR !== 'undefined') PKR.openEmployee(id == null || id === '' ? null : String(id)); }
/** a save in the React window: the loaded record, pick-lists, Employees, Payroll, Dashboard; leave balances read again and the
 *  HR alerts follow (the database may have filled in dates: probation, contract end) @param {Employee} row */
function employeeSaved(row){
  const i = S.employees.findIndex(e => String(e.id) === String(row.id));
  if (i >= 0) S.employees[i] = row; else S.employees.push(row);
  LB.clear(); buildLists(); renderEmployees(); renderPayroll(); renderDashboard();
  if (canHRA()) loadHRAlerts().then(hraBadge, () => {});
}
/** a fixed salary element added / closed in the window: payroll and dashboard follow @param {Row<'employee_salary_elements'>} row */
function fixedAdded(row){ S.fixed.push(row); renderPayroll(); renderDashboard(); }
/** @param {string} id */
function fixedClosed(id){ S.fixed = S.fixed.filter(r => r.id !== id); renderPayroll(); renderDashboard(); }

// ═════════════════════════════════════════════════════════
//  ATTENDANCE
// ═════════════════════════════════════════════════════════
// The records list, the past date range and the entry window moved to React 31 Oct 2026 (react/src/attendance). The Calendar tab
// (part25) is still here; the fingerprint-machine import is React too (react/src/machine — part16 removed). The old code keeps the cycle's records (S.attendance).
function renderAttendance(){ if (typeof PKR !== 'undefined') PKR.render(); }
/** a record saved in the React window: kept when it is in the loaded payroll cycle; payroll, dashboard and reports follow @param {AttendanceRow} saved */
function attendanceSaved(saved){
  const inPeriod = saved.date >= periodStart(settings.period) && saved.date <= periodEnd(settings.period);
  S.attendance = S.attendance.filter(a => a.id !== saved.id); if (inPeriod) S.attendance.push(saved);
  renderAttendance(); renderDashboard(); renderPayroll(); renderReports();
}
/** a day closed (with a reason) on the React page @param {string} id */
function attendanceClosed(id){ S.attendance = S.attendance.filter(r => r.id !== id); renderAttendance(); renderDashboard(); renderPayroll(); renderReports(); }

// Time 'HH:MM' → minutes after midnight; a missing time → null.
/** @overload @param {string} t  a filled-in time @returns {number} */
/** @overload @param {string | null | undefined} t  a time that may be missing @returns {number | null} */
/** @param {string | null | undefined} t */
function toMin(t){ if(!t) return null; const [h,m]=String(t).split(':').map(Number); return h*60+m; }

// ═════════════════════════════════════════════════════════
//  PROJECTS
// ═════════════════════════════════════════════════════════
// The page is React now (react/src/projects, 30 Oct 2026). The old code keeps the loaded data; React hands changes here.
function renderProjects(){ if (typeof PKR !== 'undefined') PKR.render(); }
/** @param {Project} row  a project created by the React page */
function projectAdded(row){ S.projects.push(row); buildLists(); renderProjects(); }
/** @param {string} id  a project deleted by the React page */
function projectDeleted(id){ S.projects = S.projects.filter(p=>String(p.id)!==id); buildLists(); renderProjects(); }

// ═════════════════════════════════════════════════════════
//  MONTHLY ENTRIES  (one or more project lines per employee)
// ═════════════════════════════════════════════════════════
function projLabel(code){ if(!code) return ''; const p=S.projects.find(x=>String(x.id)===String(code)); return p ? `${p.id} — ${p.name||''}` : String(code); }
// The page, the upload window and "New variable element" moved to React 30 Oct 2026 (react/src/monthly). The old code keeps
// the loaded amounts (S.monthly — payroll, reports) and the step after a change.
function renderMonthly(){ if (typeof PKR !== 'undefined') PKR.render(); }
/** after the React page saved or uploaded amounts: read the period's amounts again; payroll, dashboard and reports follow */
async function monthlyChanged(){
  S.monthly = await fetchAll('payroll_period_elements','emp_id', q=>q.eq('period',settings.period));
  renderPayroll(); renderDashboard(); renderReports(); renderMonthly();
}
/** a new variable element created by the React page @param {SalaryElement} row */
function elementAdded(row){ S.elements.push(row); buildLists(); renderMonthly(); }

// ═════════════════════════════════════════════════════════
//  LOANS
// ═════════════════════════════════════════════════════════
// The page and its two windows moved to React 30 Oct 2026 (react/src/loans). The loan arithmetic stays in part4 (= database
// _pk_loan_*); the old code keeps the list and the step after a change.
function renderLoans(){ if (typeof PKR !== 'undefined') PKR.render(); }
function approvedPeriods(){ return new Set((S.runs||[]).map(r => r.period)); }
/** months that may still be postponed: from the loaded payroll on, not approved, an instalment due — at most 18 @param {Loan} l */
function loanPostponeOptions(l){
  const done = approvedPeriods(), from = periodIdx(settings.period), opts = [];
  for (let i = from; i < from + 36 && opts.length < 18; i++){
    const p = `${Math.floor(i/12)}-${pad(i%12+1)}`;
    if (!done.has(p) && loanDue(l, i)) opts.push(p);
  }
  return opts;
}
/** a loan added or read again after a postponement @param {Loan} row */
function loanSaved(row){ S.loans = S.loans.some(x => String(x.id) === String(row.id)) ? S.loans.map(x => String(x.id) === String(row.id) ? row : x) : S.loans.concat([row]); afterLoanChange(); }
/** @param {string} id */
function loanDeleted(id){ S.loans = S.loans.filter(l => l.id !== id); afterLoanChange(); }
function afterLoanChange(){ renderLoans(); renderPayroll(); renderDashboard(); }

// ═════════════════════════════════════════════════════════
//  PAYROLL RUN
// ═════════════════════════════════════════════════════════
// The page and the approval window moved to React 30 Oct 2026 (react/src/payroll). The engine (computeAll, part4) stays here;
// "redraw the payroll" now means: React draws again (the payroll is recalculated when the page shows).
function renderPayroll(){ if (typeof PKR !== 'undefined') PKR.render(); }
/** the payslip window for one row of the Payroll Run page (live or approved snapshot) @param {any} r */
function openSlip(r){
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

// ═════════════════════════════════════════════════════════
//  SETTINGS
// ═════════════════════════════════════════════════════════
// The Settings page moved to React 31 Oct 2026 (react/src/settings): it reads and saves the settings itself. The old code
// still calls applySettingsUI() after it (re)loaded them, so the page shows the saved values again.
const DAYS=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
function applySettingsUI(){ if (typeof PKR !== 'undefined') PKR.settingsLoaded(); }

// ═════════════════════════════════════════════════════════
//  DELETE
// ═════════════════════════════════════════════════════════
function confirmDel(msg, fn){
  $('del-msg').textContent = msg; $('del-ok').textContent='Delete'; $('del-ok').className='btn btn-danger'; $('del-title').textContent='Confirm delete';
  $('del-ok').onclick = async () => { $('del-ok').disabled=true; try{ await fn(); closeM('m-del'); }catch(e){ toast(e.message,'err'); } $('del-ok').disabled=false; };
  openM('m-del');
}
// ── Records are never deleted (database file 100, Mohammed 30 Oct 2026): they are CANCELLED (vacations, permissions, penalties,
//    loans, HR requests, allowance approvals — the row stays, marked Cancelled) or CLOSED (everything else — the row is kept in the
//    register of closed records, then leaves the list). Always with a reason.
/** @param {keyof DB['Tables']} table @param {Record<string, string | number>[]} keys @param {string} reason @param {boolean} [replacing] */
async function closeRecords(table, keys, reason, replacing){
  const { data, error } = await sb.rpc('close_records', { p_tbl: table, p_keys: keys, p_reason: reason, p_replacing: !!replacing });
  if (error) throw new Error(closeError(error.message));
  return data;
}
/** the database's own explanation without its code word, e.g. "NOT_CLOSED: Nothing was…" → "Nothing was…" @param {string} m */
const closeError = m => String(m).replace(/^.*?\b(NO_DELETE|CLOSE_REASON|NOT_CLOSED|CANCEL_REASON|CANCELLED|CLOSE_KEYS|CLOSE_TABLE): ?/, '');
/** the "write the reason" window: title, what will happen, button text, then action(reason) — closes itself when the action worked
 * @param {string} title @param {string} msg @param {string} ok @param {(reason: string) => Promise<void>} action */
function askReason(title, msg, ok, action){
  $('cls-title').textContent = title; $('cls-msg').textContent = msg; $('cls-ok').textContent = ok;
  $('cls-reason').value = ''; $('cls-miss').style.display = 'none';
  $('cls-ok').onclick = async () => {
    const reason = $('cls-reason').value.trim();
    if (reason.length < 3) { $('cls-miss').style.display = ''; return; }
    $('cls-ok').disabled = true;
    try { await action(reason); closeM('m-close'); } catch (e) { toast(e.message, 'err'); }
    $('cls-ok').disabled = false;
  };
  openM('m-close'); setTimeout(() => $('cls-reason').focus(), 50);
}

// ═════════════════════════════════════════════════════════
//  NAVIGATION & EVENTS
// ═════════════════════════════════════════════════════════
function showPage(name){
  renderPageIfNeeded(name);
  document.querySelectorAll('.page').forEach(p=>p.classList.toggle('active', p.id==='page-'+name));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.toggle('active', n.dataset.page===name));
  window.scrollTo(0,0);
  if (typeof PKR !== 'undefined') PKR.pageShown(name);   // React screens that load fresh data when opened
}

document.addEventListener('click', async ev => {
  const t = /** @type {PageEl} */ (ev.target);
  const nav = t.closest('[data-page]'); if (nav && nav.classList.contains('nav-item')) return showPage(nav.dataset.page);
  const nv = t.closest('[data-nav]'); if (nv) return showPage(nv.dataset.nav);
  const orp = t.closest('[data-open-report]'); if (orp) { showPage('reports'); return openReport(orp.dataset.openReport || ''); }
  const cl = t.closest('[data-close]'); if (cl) return closeM(cl.dataset.close);
  if (t.classList && t.classList.contains('overlay')) return t.classList.remove('open');
  const act = t.closest('[data-act]');
  if (act){ const a = act.dataset.act;
    if (a==='new-emp') return openEmp(null);
    if (a==='myprofile') return showSelf(ME, { email: ME.email });
    if (a==='goto-current') return gotoCurrentPeriod();
    if (a==='theme') return openTheme();
    if (a==='self-leave') return openSelfLeave();
    if (a==='self-perm') return openSelfPerm();
    if (a==='self-hr') return openSelfHr();
    if (a==='reload') return loadAll();
    if (a==='signout') return signOut();
    if (a==='chpass') return openM('m-pass');
    if (a==='disconnect'){ ev.preventDefault(); return disconnect(); }
  }
  const er = t.closest('[data-emp]'); if (er) return openEmp(er.dataset.emp || null);
});

// inputs
$('btn-connect').addEventListener('click', connectFromForm);
document.addEventListener('keydown', e => { if (e.key==='Escape') document.querySelectorAll('.overlay.open').forEach(o=>o.classList.remove('open')); });

setInterval(()=>{ $('clock').textContent = new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}); }, 1000);



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
        .filter(x => x !== null).sort((a,b)=>a.date.localeCompare(b.date)) }) },
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
        .sort((a,b)=>(String(a.date)+String(a.time)).localeCompare(String(b.date)+String(b.time))) }) },
  { id:'att-review', g:'Attendance', t:'Offline check-ins to review',
    d:'Check-ins made with no internet and sent later. The Petrokima Android app (new version) also sends the phone\'s “time since switched on” counter, which the user cannot change: the server then records the REAL time (✓ verified), and if the phone clock had been changed it shows ⚠ Phone clock was changed and tells HR. Without the counter (iPhone, older apps, or the phone restarted) the time comes from the phone clock: the server compares it with its own when the phone reconnects and corrects any difference. A tap that reached the server more than 5 minutes after its time is marked ⏳ HR to confirm: that day has no deductions or overtime until HR checks the time on the Attendance page and saves it, and the month cannot be approved before. Taps more than 72 hours old, or earlier than one already recorded, are refused and stay on the phone — HR records those manually.',
    build:() => ({ cols:[C('state','Status','strong'),C('date','Date','date'),C('time','Time recorded','mono'),C('claimed','Phone showed','mono'),C('recv','Sent (Cairo time)','mono'),C('delay','Hours until sent','num'),C('code','Code','id'),C('name','Employee'),C('ev','Event'),C('site','Site','id'),C('map','Location','link')],
      rows:S.clocks.filter(c=>c.offline).map(c=>{ const e=empOrBlank(c.emp_id), corr=/corrected/.test(c.time_method||''), delay = c.received_at ? (new Date(c.received_at).getTime()-new Date(c.at).getTime())/3600000 : null;
        const tz = String(e.entity||'').toLowerCase().includes('saudi') ? 'Asia/Riyadh' : 'Africa/Cairo', changed = /clock was changed/.test(c.time_method || ''), verified = /counter \(verified\)/.test(c.time_method || '');
        return { state: changed ? '⚠ Phone clock was changed — real time recorded' : /^Offline — sent/.test(c.review_note || '') ? ((c.location_flags||[]).includes('phone_restarted') ? '⏳ HR to confirm (phone restarted)' : '⏳ HR to confirm the time') : verified ? '✓ Real time verified' : corr ? '⚠ Phone clock was wrong' : 'OK', date:c.local_date, time:c.local_time,
          claimed: (c.phone_said_at || c.client_at) ? new Date(/** @type {string} */ (c.phone_said_at || c.client_at)).toLocaleString('en-GB',{ timeZone: tz, hour:'2-digit', minute:'2-digit', day:'2-digit', month:'short' }) : '',
          recv: c.received_at ? new Date(c.received_at).toLocaleString('en-GB',{ timeZone: tz, hour:'2-digit', minute:'2-digit', day:'2-digit', month:'short' }) : '', delay: delay==null ? '' : Math.round(delay*100)/100,
          code:c.emp_id, name:empName(e), ev:c.event_type==='in'?'Check in':'Check out', site:c.project_code||'(no project)', map:mapUrl(c)||'' }; })
        .sort((a,b)=>Number(/^(OK|✓)/.test(a.state))-Number(/^(OK|✓)/.test(b.state)) || (String(a.date)+String(a.time)).localeCompare(String(b.date)+String(b.time))) }) },

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

// The Reports PAGE is React since 31 Oct 2026 (react/src/reports — list, dates, filters, columns, table, exports). Kept here: the
// report definitions above (+ those added by parts 26, 37, 38, 39) and their calculations, which use the payroll / attendance engine.
const MONEY_REPORT = r => r.g==='Payroll' || r.id==='prj-cost' || r.id==='prj-cost-detail';
/** one report's columns and rows. For dates outside the loaded payroll cycle the page passes that range's data (attendance, phone
 *  taps, permissions, vacations, missions, penalties, undone check-outs): it is swapped into S only while the report is built.
 * @param {string} id @param {{ from: string, to: string, group: string, view: string }} p @param {any} D */
function reportBuild(id, p, D){
  const r = REPORTS.find(x => x.id === id); if (!r) throw new Error('This report no longer exists');
  if (!D) return r.build(p);
  /** @type {(keyof typeof S)[]} */ const keys = ['attendance','clocks','permissions','leaves','missions','penalties','undos'];
  const old = {};
  keys.forEach(k => { old[k] = S[k]; S[k] = D[k]; });
  try { return r.build(p); } finally { keys.forEach(k => { S[k] = old[k]; }); }
}
function renderReports(){ if (typeof PKR !== 'undefined') PKR.render(); }
/** opens a report on the Reports page (dashboard banners) @param {string} id */
function openReport(id){ if (typeof PKR !== 'undefined') PKR.openReport(id); }

// ═════════════════════════════════════════════════════════
//  PERMISSIONS (late arrival / early leave)
// ═════════════════════════════════════════════════════════
function monthOf(d){ return cycleOf(d); }   // quota follows the payroll cycle
function permUsed(empId, month, exceptId){
  return S.permissions.filter(p => String(p.emp_id)===String(empId) && p.status==='Approved' && monthOf(p.date)===month && p.id!==exceptId).length;
}
// The page and its windows are React now (react/src/permissions, 30 Oct 2026). Kept here: the menu badge, the quota helpers above
// (also used elsewhere) and what a saved / decided / deleted permission changes in the rest of the app.
function renderPermissions(){
  const pend = S.permissions.filter(readyForHR).length;
  $('perm-badge').style.display = pend ? '' : 'none'; $('perm-badge').textContent = String(pend);
  if (typeof PKR !== 'undefined') PKR.render();
}
/** a permission saved (new) or decided in the React page @param {Permission} row */
function permSaved(row){
  const i = S.permissions.findIndex(x => x.id === row.id);
  if (i >= 0) S.permissions[i] = row; else if (inPeriod(row.date)) S.permissions.push(row);
  afterPermChange();
}
/** @param {string} id */
function permDeleted(id){ S.permissions = S.permissions.filter(p => p.id !== id); afterPermChange(); }
function afterPermChange(){ renderPermissions(); renderAttendance(); renderPayroll(); renderDashboard(); renderReports(); }

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
// The page and its window are React now (react/src/vacations, 30 Oct 2026). Kept here: the leave helpers above (payroll,
// attendance, reports and self-service use them) and what a saved / decided / deleted vacation changes in the rest of the app.
function renderLeaves(){ if (typeof PKR !== 'undefined') PKR.render(); }
/** a vacation saved, edited or decided in the React page (kept only when it touches the loaded year) @param {Leave} row */
function leaveSaved(row){
  S.leaves = S.leaves.filter(x => x.id !== row.id);
  const y = settings.period.slice(0,4); if (row.date_from <= `${y}-12-31` && row.date_to >= `${y}-01-01`) S.leaves.push(row);
  afterLeaveChange();
}
/** @param {string} id */
function leaveDeleted(id){ S.leaves = S.leaves.filter(l => l.id !== id); afterLeaveChange(); }
function afterLeaveChange(){ renderLeaves(); renderAttendance(); renderPayroll(); renderDashboard(); renderReports(); }

// ═════════════════════════════════════════════════════════
//  EXCEPTION RULE PAGE — moved to React 30 Oct 2026 (react/src/exempt). The old code keeps only the step after a change.
// ═════════════════════════════════════════════════════════
function renderExempt(){ if (typeof PKR !== 'undefined') PKR.render(); }
/** the React page switched a yes/no column for these employees → keep the loaded data and redraw the pages that use it
 * @param {string[]} ids @param {'attendance_exempt' | 'project_staff'} field @param {boolean} value */
function employeesFlagged(ids, field, value){
  S.employees.forEach(e => { if (ids.includes(String(e.id))) e[field] = value; });
  renderExempt(); renderEmployees(); renderAttendance(); renderPayroll(); renderDashboard(); renderReports();
}

// ═════════════════════════════════════════════════════════
//  PENALTIES
// ═════════════════════════════════════════════════════════
function penaltyValue(x, emp, dailyRate, hourRate){
  emp = emp || empById(x.emp_id); if (!emp) return x.penalty_type==='Amount' ? num(x.quantity) : 0;
  const R = (dailyRate===undefined || hourRate===undefined) ? empRates(emp) : null;
  const d = dailyRate ?? /** @type {NonNullable<typeof R>} */ (R).daily, h = hourRate ?? /** @type {NonNullable<typeof R>} */ (R).hourly;
  if (x.penalty_type==='Hours') return num(x.quantity) * h;
  if (x.penalty_type==='Days')  return num(x.quantity) * d;
  return num(x.quantity);
}
function penLabel(x){ return x.penalty_type==='Amount' ? `${fmt(x.quantity)} EGP` : `${fmt(x.quantity)} ${x.penalty_type==='Hours'?'hour':'day'}${num(x.quantity)===1?'':'s'}`; }
// The page and its window moved to React 30 Oct 2026 (react/src/penalties). The old code keeps penaltyValue / penLabel (payroll,
// reports) and the step after a change.
function renderPenalties(){ if (typeof PKR !== 'undefined') PKR.render(); }
/** a penalty saved in the React window — kept only when it belongs to the loaded year (as before) @param {Penalty} saved */
function penaltySaved(saved){
  S.penalties = S.penalties.filter(x => x.id !== saved.id);
  if (saved.apply_period.slice(0,4) === settings.period.slice(0,4)) S.penalties.push(saved);
  afterPenChange();
}
/** @param {string} id */
function penaltyDeleted(id){ S.penalties = S.penalties.filter(p => p.id !== id); afterPenChange(); }
function afterPenChange(){ renderPenalties(); renderPayroll(); renderDashboard(); renderReports(); }

// ═════════════════════════════════════════════════════════
//  PUBLIC HOLIDAYS — the page is React now (react/src/holidays, 30 Oct 2026). The old code keeps the loaded
//  data: React hands every change to the two functions below, which update S.holidays + the holiday list used
//  by leaves, attendance and payroll, and redraw the screens that depend on holidays.
// ═════════════════════════════════════════════════════════
function renderHolidays(){ if (typeof PKR !== 'undefined') PKR.render(); }   // React draws the page from the current data
/** @param {Holiday[]} rows  new holiday days saved by the React page */
function holidaysAdded(rows){ S.holidays.push(...rows); holidaySet = new Set(S.holidays.map(h=>h.date)); afterHolChange(); }
/** @param {string} id  a holiday deleted by the React page */
function holidayDeleted(id){ S.holidays = S.holidays.filter(h=>h.id!==id); holidaySet = new Set(S.holidays.map(h=>h.date)); afterHolChange(); }
function afterHolChange(){ renderHolidays(); renderLeaves(); renderAttendance(); renderPayroll(); renderDashboard(); renderReports(); }

// ═════════════════════════════════════════════════════════
//  USERS & ROLES (admin only) — the page is React now (react/src/users, 30 Oct 2026); it loads when opened.
//  Kept here: the sign-in and change-password buttons.
// ═════════════════════════════════════════════════════════
$('btn-login').addEventListener('click', doLogin);
['li-email','li-pass'].forEach(id => $(id).addEventListener('keydown', e => { if (e.key==='Enter') doLogin(); }));
$('pw-save').addEventListener('click', changePassword);

// employee screens: hours as hours and minutes (1.5 → "1 h 30 m"); payroll and reports keep decimal hours
const fmtHM = v => { const tm = Math.round(num(v) * 60), h = Math.floor(tm / 60), m = tm % 60; return h && m ? `${h} h ${m} m` : h ? `${h} h` : `${m} m`; };
// ═════════════════════════════════════════════════════════
//  SELF-SERVICE (employee's own requests)
// ═════════════════════════════════════════════════════════
/** @type {{ emp: Employee | null, leaves: Leave[], perms: Permission[], reqs: HrRequest[], slips?: PayrollRunLine[],
 *   manager?: FnResult<'my_manager'>[number] | null, team?: AllowanceApproval[], teamLeaves?: Leave[], teamPerms?: Permission[],
 *   myTeam?: FnResult<'my_team'> }}} — the signed-in person's own data (self-service) */
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
  /** @type {{ kind: string, r: any, when: string }[]} — r is a leave or a permission (see kind) */
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
  if (f && t && t >= f){ const cal=Math.round((dObj(t).getTime()-dObj(f).getTime())/86400000)+1, wd=workdays(f,t);
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
/** @param {'attendance_permissions' | 'employee_leaves' | 'hr_requests'} table — where the request is saved */
async function selfSend(table, rec, modal, btnId, okMsg){
  const b=$(btnId); b.disabled=true;
  const { data, error } = await /** @type {any} — table chosen by the caller (checked above) */ (sb).from(table).insert(rec).select();
  b.disabled=false;
  if (error) return toast(/duplicate/i.test(error.message) ? 'You already have an open request of this kind for that date' : deadlineMsg(error.message), 'err');
  if (!(data && data.length)) return toast(NOPERM,'err');
  closeM(modal); toast(okMsg); await loadSelf();
}
async function selfCancel(key){
  const [kind, id] = key.split(':'), table = /** @type {Record<string, 'attendance_permissions' | 'employee_leaves' | 'hr_requests'>} */ ({ leave:'employee_leaves', perm:'attendance_permissions', req:'hr_requests' })[kind];
  confirmDel('Cancel this request?', async () => {
    const { data, error } = await sb.from(table).update({ status:'Cancelled' }).eq('id', id).select();
    if (error) throw error;
    if (!(data && data.length)) throw new Error('This request can no longer be cancelled — HR has already decided it.');
    toast('Request cancelled'); await loadSelf();
  });
  $('del-title').textContent='Please confirm'; $('del-ok').textContent='Cancel request';
}
$('self-list').addEventListener('click', e => { const b=/** @type {PageEl} */ (e.target).closest('[data-self-cancel]'); if(b) selfCancel(b.dataset.selfCancel); });
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
// HR requests page: React now (react/src/hrreq, 30 Oct 2026). It draws from S.hrreq; the Handle window saves and calls this.
function renderHrRequests(){ if (typeof PKR !== 'undefined') PKR.render(); }
/** a request HR just handled (React Handle window) → the list, the dashboard and the menu badge @param {HrRequest} row */
function hrRequestSaved(row){ S.hrreq = S.hrreq.map(x => x.id === row.id ? row : x); renderHrRequests(); renderDashboard(); }
function updateBadges(){
  const b=(id,n)=>{ const el=$(id); if(!el) return; el.style.display=n?'':'none'; el.textContent=n; };
  b('lv-badge', S.leaves.filter(readyForHR).length);
  b('hr-badge', S.hrreq.filter(r=>r.status==='Pending'||r.status==='In progress').length);
  b('aa-badge', S.allowAppr.filter(a=>a.status==='Pending HR').length);
}

// the manager approves or rejects a team member's Project Allowance
async function teamDecide(id, approve){
  let note = null;
  if (!approve){ note = prompt('Reason for rejecting (HR and the employee record will show it):'); if (note === null) return; }
  const { error } = await sb.rpc('manager_decide_allowance', { p_id:id, p_approve:approve, p_note:note });
  if (error) return toast(error.message,'err');
  toast(approve ? 'Approved — sent to HR for the final approval' : 'Rejected'); await loadSelf();
}
$('self-team-tbl').addEventListener('click', e => { const ok=/** @type {PageEl} */ (e.target).closest('[data-team-ok]'); if (ok) return teamDecide(ok.dataset.teamOk, true);
  const no=/** @type {PageEl} */ (e.target).closest('[data-team-no]'); if (no) return teamDecide(no.dataset.teamNo, false); });

async function teamReqDecide(key, approve){
  const [kind, id] = key.split(':'); let note = null;
  if (!approve){ note = prompt('Reason for rejecting (the employee will see it):'); if (note === null) return; }
  const { data, error } = await sb.rpc('manager_decide_request', { p_kind:kind, p_id:id, p_approve:approve, p_note:note });
  if (error) return toast(error.message,'err');
  toast(approve ? (/final/.test(data) ? 'Approved' : 'Approved — sent to HR for the final approval') : 'Rejected'); await loadSelf();
}
$('self-treq-tbl').addEventListener('click', e => { const ok=/** @type {PageEl} */ (e.target).closest('[data-treq-ok]'); if (ok) return teamReqDecide(ok.dataset.treqOk, true);
  const no=/** @type {PageEl} */ (e.target).closest('[data-treq-no]'); if (no) return teamReqDecide(no.dataset.treqNo, false); });

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

// ═════════════════════════════════════════════════════════
//  PAYROLL APPROVAL (permanent snapshot)
// ═════════════════════════════════════════════════════════
function nextPeriod(p){ const [y,m]=p.split('-').map(Number); return m===12 ? `${y+1}-01` : `${y}-${pad(m+1)}`; }
// The payroll engine's payslip format (what Approve sends for the database to cross-check) and the comparison with the database's
// own calculation — used by the React approval window (bridge) and by the engine test (tests/payroll/cmp.js).
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
// The approval window moved to React 30 Oct 2026 (react/src/payroll/ApproveDialog.tsx). After the DATABASE approved the month:
/** publish the project costs taken before approving, move to the next period if asked, read everything again
 *  @param {string} p @param {any} costDetail @param {boolean} moveNext */
async function payrollApproved(p, costDetail, moveNext){
  await publishProjectCosts(p, costDetail, true);
  if (moveNext){
    settings.period = nextPeriod(p);
    const r = await sb.from('settings').upsert({ key:'payroll', value:settings }).select();
    if (r.error || !(r.data && r.data.length)) toast('Approved — but the period could not be moved; change it in Settings','warn');
    applySettingsUI();
  }
  await loadPeriodData(); loader(false); renderAll();
}

// ═════════════════════════════════════════════════════════
//  PAYROLL HISTORY
// ═════════════════════════════════════════════════════════
// The page itself moved to React 30 Oct 2026 (react/src/history). Kept here: the approved payslip window and the CSV export
// (both also used by the Payroll Run page; the React page calls them through the bridge).
function renderHistory(){ if (typeof PKR !== 'undefined') PKR.render(); }
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
$('self-slips').addEventListener('click', e => { const b=/** @type {PageEl} */ (e.target).closest('[data-self-slip]'); if(b){ const l=(SD.slips||[]).find(x=>x.period===b.dataset.selfSlip); if(l) showSnapSlip(l, l.period); } });

// Lock notices on pages whose data belongs to an approved cycle
function renderLocks(){
  const run = currentRun();
  document.querySelectorAll('.lock-note').forEach(el => el.innerHTML = run
    ? `<div class="alert a-warn">🔒 The <b>${esc(periodLabel(run.period))}</b> payroll is approved and locked. Records in this cycle can no longer be added, changed or deleted — the database refuses it. Switch to an open period in Settings to keep working.</div>` : '');
}

// ═════════════════════════════════════════════════════════
//  REPORTING LINES — moved to React 30 Oct 2026 (react/src/reporting). The old code keeps the 🧭 menu badge and the step after a change.
// ═════════════════════════════════════════════════════════
function renderReporting(){
  const n = activeEmps().filter(e => !e.manager_id && !e.top_of_org).length;
  const b=$('rl-badge'); b.style.display = n ? '' : 'none'; b.textContent = String(n);
  if (typeof PKR !== 'undefined') PKR.render();
}
/** the React page gave these employees a manager → keep the loaded data and redraw what uses it
 * @param {string[]} ids @param {string} mid */
function managerAssigned(ids, mid){
  S.employees.forEach(e => { if (ids.includes(String(e.id))) { e.manager_id = mid; e.top_of_org = false; } });
  renderReporting(); renderEmployees(); renderReports();
}

// ═════════════════════════════════════════════════════════
//  WARN WHEN TODAY IS OUTSIDE THE PERIOD ON SCREEN
// ═════════════════════════════════════════════════════════
// the notice is drawn by the React dashboard (react/src/dashboard) and the Attendance page
function renderPeriodHint(){ if (typeof PKR !== 'undefined') PKR.render(); }
async function gotoCurrentPeriod(){
  const cur = cycleOf(todayStr()), old = settings.period;
  settings.period = cur;
  const r = await sb.from('settings').upsert({ key:'payroll', value:settings }).select();
  if (r.error || !(r.data && r.data.length)) { settings.period = old; return toast(r.error ? r.error.message : NOPERM, 'err'); }
  applySettingsUI(); await loadPeriodData(); loader(false); renderAll();
  toast(`Now showing ${periodLabel(cur)}`);
}

// ═════════════════════════════════════════════════════════
//  PHONE LOCATIONS & REGISTERED PHONES
// ═════════════════════════════════════════════════════════
function mapUrl(c){ return (c && c.lat != null && c.lng != null) ? `https://www.google.com/maps?q=${c.lat},${c.lng}` : null; }

/** a phone reset in the employee window (React): forgotten here; reports follow @param {string} empId */
function deviceReset(empId){ S.devices = S.devices.filter(x => String(x.emp_id) !== String(empId)); renderReports(); }

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
//  READING AN EXCEL / CSV FILE — shared by Bulk upload, the Monthly entries upload (both React now) and the manager team upload
// ═════════════════════════════════════════════════════════
// The Monthly entries upload window itself moved to React 30 Oct 2026 (react/src/monthly/UploadDialog.tsx).
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
// heading of a column, compared loosely (case, spaces, _ - . ignored) — the manager team upload (part20) uses it
const H = s => String(s||'').toLowerCase().replace(/[\s_\-.]/g,'');

// (Past attendance — any date range — moved to the React Attendance page, 31 Oct 2026.)

// ═════════════════════════════════════════════════════════
//  PROJECT ALLOWANCE RULES
// ═════════════════════════════════════════════════════════
function parRuleUse(){         // per rule: employees and amount in this payroll cycle
  const use = {};
  S.employees.filter(e => onPayroll(e, settings.period)).forEach(e => autoAllowance(e).forEach(x => {
    const u = use[x.rule] = use[x.rule] || { emps:new Set(), days:0, amount:0 }; u.emps.add(e.id); u.days += x.days; u.amount += x.amount; }));
  return use;
}
// The page moved to React 30 Oct 2026 (react/src/parrules). The old code keeps parRuleUse (above, used through the bridge) and the
// step after a change.
function renderParRules(){ if (typeof PKR !== 'undefined') PKR.render(); }
/** @param {AllowanceRule} row */
function allowanceRuleSaved(row){ S.parRules = S.parRules.filter(x => x.id !== row.id).concat([row]); afterAllowanceRuleChange(); }
/** @param {string} id */
function allowanceRuleDeleted(id){ S.parRules = S.parRules.filter(x => x.id !== id); afterAllowanceRuleChange(); }
function afterAllowanceRuleChange(){ renderParRules(); DIRTY.add('payroll'); DIRTY.add('reports'); renderDashboard(); }

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
const aaSame = (a, b) => Math.abs(num(a) - num(b)) < 0.005;
function aaRows(){
  const calc = new Map(aaCalculated().map(x => [String(x.emp.id), x]));
  const rows = [];
  calc.forEach((c, id) => rows.push({ emp:c.emp, calc:c, rec: S.allowAppr.find(a => String(a.emp_id)===id) }));
  S.allowAppr.forEach(a => { if (!calc.has(String(a.emp_id))) rows.push({ emp: empById(a.emp_id) || /** @type {Employee} */ ({ id:a.emp_id, name_en:a.emp_name }), calc:{ amount:0, details:[] }, rec:a }); });
  rows.forEach(r => { r.state = r.rec ? r.rec.status : 'Not sent'; r.changed = !!r.rec && !aaSame(r.rec.amount, r.calc.amount); });
  return rows;
}
// The page moved to React 30 Oct 2026 (react/src/approvals). The old code keeps aaRows (above — also used by the payroll
// approval window) and the step after a change.
function renderApprovals(){ if (typeof PKR !== 'undefined') PKR.render(); }
/** the period's approval rows read again after sending @param {AllowanceApproval[]} rows */
function allowanceApprovalsReplaced(rows){ S.allowAppr = rows; renderApprovals(); renderDashboard(); }
/** rows changed by an HR decision or a re-send @param {AllowanceApproval[]} rows */
function allowanceApprovalsUpdated(rows){
  rows.forEach(d => { S.allowAppr = S.allowAppr.map(a => a.id === d.id ? d : a); });
  renderApprovals(); renderDashboard(); DIRTY.add('payroll'); DIRTY.add('reports');
}

// (the department + unit filters of every page are React now — react/src/shared/OrgFilter; the Reports page was the last old one)

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
  if (/** @type {PageEl} */ (e.target).closest('[data-open-phal]')) return openPhoneAlerts();
  const ok = /** @type {PageEl} */ (e.target).closest('[data-phal-ok]'); if (ok) return reviewPhoneAlert(ok.dataset.phalOk);
});

// ═════════════════════════════════════════════════════════
//  PROJECT ASSIGNMENTS — moved to React 30 Oct 2026 (react/src/assign). The old code keeps the list (S.empProjects: employee
//  window, reports, bulk import) and updates it after the React page changed something.
// ═════════════════════════════════════════════════════════
function renderAssign(){ if (typeof PKR !== 'undefined') PKR.render(); }
/** @param {EmployeeProject[]} rows */
function assignmentsAdded(rows){ S.empProjects = S.empProjects.concat(rows); renderAssign(); }
/** @param {string} empId @param {string} code */
function assignmentRemoved(empId, code){ S.empProjects = S.empProjects.filter(x => !(String(x.emp_id)===String(empId) && x.project_code===code)); renderAssign(); }

// ── a manager on the desktop (My requests → Team approvals) ──
let tprojEmp = null, tprojT;
async function openTeamProj(empId){
  tprojEmp = empId; const m = (SD.myTeam||[]).find(x => x.id === empId) || /** @type {FnResult<'my_team'>[number]} */ ({ id: empId });
  const { data, error } = await sb.rpc('team_projects', { p_emp: empId }); if (error) return toast(error.message, 'err');
  $('tproj-title').textContent = `📌 ${m.name_en || m.name_ar || empId} — ${(data||[]).length ? 'can check in only at these projects' : 'no projects: any project'}`;
  $('tproj-tbl').innerHTML = (data||[]).map(p => `<tr><td class="mono">${esc(p.id)}</td><td>${esc(p.name||'')}</td><td>${esc(p.assigned_by||'')}</td><td><button class="icon-btn" data-tproj-rm="${esc(p.id)}" title="Close (a reason is required)">⊘</button></td></tr>`).join('')
    || '<tr><td colspan="4" class="empty">No projects yet</td></tr>';
  $('tproj-tbl').dataset.have = JSON.stringify((data||[]).map(p => p.id));
  $('tproj-q').value=''; $('tproj-res').innerHTML=''; openM('m-tproj');
}
async function teamProjChangeDesk(code, add){
  if (!add) return askReason('Remove project', `Remove project ${code} from this employee? The assignment is kept on record with your reason.`, 'Remove', async reason => {
    await closeRecords('employee_projects', [{ emp_id: String(tprojEmp), project_code: code }], reason);
    toast('Project removed');
    const r = await sb.rpc('my_team'); if (SD) SD.myTeam = r.data || SD.myTeam; renderSelf(); openTeamProj(/** @type {string} */ (tprojEmp));
  });
  const res = await sb.from('employee_projects').insert({ emp_id: tprojEmp, project_code: code }).select();
  if (res.error) return toast(res.error.message, 'err'); if (!(res.data && res.data.length)) return toast(NOPERM, 'err');
  toast('Project added');
  const r = await sb.rpc('my_team'); if (SD) SD.myTeam = r.data || SD.myTeam; renderSelf(); openTeamProj(tprojEmp);
}
$('tproj-q').addEventListener('input', () => { clearTimeout(tprojT); tprojT = setTimeout(async () => {
  const q = $('tproj-q').value.trim(); if (q.length < 2){ $('tproj-res').innerHTML=''; return; }
  const r = await sb.rpc('find_projects', { p_q: q }), have = new Set(JSON.parse($('tproj-tbl').dataset.have || '[]'));
  $('tproj-res').innerHTML = (r.data||[]).filter(p => !have.has(p.id)).map(p => `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border)"><span><b class="mono">${esc(p.id)}</b> ${esc(p.name||'')}</span><button class="btn btn-primary btn-sm" data-tproj-add="${esc(p.id)}">+ Add</button></div>`).join('') || '<div style="color:var(--muted);font-size:13px">No matching projects</div>';
}, 300); });
document.addEventListener('click', e => {
  const tp = /** @type {PageEl} */ (e.target).closest('[data-tproj]'); if (tp) return openTeamProj(tp.dataset.tproj);
  const ta = /** @type {PageEl} */ (e.target).closest('[data-tproj-add]'); if (ta) return teamProjChangeDesk(ta.dataset.tprojAdd, true);
  const tr = /** @type {PageEl} */ (e.target).closest('[data-tproj-rm]'); if (tr) return teamProjChangeDesk(tr.dataset.tprojRm, false);
});

// (the employee window's "📌 Assigned projects" is React now — react/src/employee)

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
const todayISO = () => new Date().toISOString().slice(0,10);
(function addExcelButtons(){
  document.querySelectorAll('.page').forEach(pg => {
    if (pg.id === 'page-reports' || pg.id === 'page-dashboard') return;
    if (pg.querySelector('[id^="react-"]')) return;          // React pages draw their own ⬇ Excel (react/src/shared/ExcelButton)
    const head = pg.querySelector('.page-header'); if (!head || head.querySelector('[data-xl]')) return;
    const b = document.createElement('button'); b.className = 'btn btn-ghost'; b.dataset.xl = '1'; b.textContent = '⬇ Excel'; b.title = 'Download what this page shows (with the current filters) as an Excel file';
    const grp = head.querySelector('.btn-group'); if (grp) grp.insertBefore(b, grp.firstChild); else head.appendChild(b);
  });
})();
document.addEventListener('click', e => { const b = /** @type {PageEl} */ (e.target).closest('[data-xl]'); if (b) exportPageExcel(b.closest('.page')); });

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
  try { await closeRecords('project_costs', [{ period }], 'Replaced by publishing the project costs again', true); }
  catch (e) { return toast('Project costs not published: ' + e.message, 'err'); }
  if (!rows.length) return quiet ? null : toast('No project costs to publish for ' + periodLabel(period), 'warn');
  const { data, error } = await sb.from('project_costs').insert(rows).select('project_code');
  if (error) return toast('Project costs not published: ' + error.message, 'err');
  toast(`${periodLabel(period)}: project costs published for Accounting — ${data.length} project line${data.length>1?'s':''}, total ${fmt(rows.reduce((s,r)=>s+r.total,0))} EGP`);
}
// ── the accountant's view (My requests → Project costs) ──
/** @type {FnResult<'acct_project_costs'>} — project costs of the chosen month */
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
  // spreadsheet rows: a heading row, then text and numbers
  const aoa = /** @type {any[][]} */ ([['Project','Name','People','Hours','Total cost (EGP)','Cost per hour','Note']]).concat(PC_ROWS.map(r => [r.project_code || '', r.project_name || '', r.people, num(r.hours),
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
    const tn = [...it.childNodes].find(n => n.nodeType === 3 && String(n.textContent).trim()); if (!tn) return;
    const m = String(tn.textContent).trim().match(/^(\S+)\s+([\s\S]+)$/); if (!m) return;
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
  if (typeof updateBadges === 'function'){
    const _ub = updateBadges;
    // @ts-expect-error — updateBadges is deliberately extended here (the new version wraps the earlier one)
    updateBadges = function(){ const r = _ub.apply(this, arguments); paint(); return r; };
  }
  window.paintNavSections = paint;
})();

// ═════════════════════════════════════════════════════════
//  PHONE / SMALL SCREENS — ☰ opens the menu over the page; picking a page closes it
// ═════════════════════════════════════════════════════════
$('menu-btn').addEventListener('click', () => document.body.classList.toggle('nav-open'));
$('nav-backdrop').addEventListener('click', () => document.body.classList.remove('nav-open'));
document.addEventListener('click', e => { if (/** @type {PageEl} */ (e.target).closest('#app .sidebar .nav-item[data-page]')) document.body.classList.remove('nav-open'); });

// ═════════════════════════════════════════════════════════
//  BULK UPLOAD — one page for every kind of data (template → upload → preview → save)
// ═════════════════════════════════════════════════════════
// The Bulk upload PAGE is React since 30 Oct 2026 (react/src/bulk — rules proven equal by bulk.golden.json).
// Kept here: the employee columns (they follow the employee window's EMP_FIELDS; bridge bulkContext) and, below,
// the managers' own bulk upload of their team's project assignments (self-service).
const buTxt = v => (v === null || v === undefined) ? '' : String(v).trim();
// ── the kinds of data ──
// col: [key, heading, kind, required, allowed values / note]
const EMP_SKIP = ['id'];
/** @returns {[string, string, string, boolean, any][]} code, title, kind, required, choices/help */
function empCols(){
  /** @type {[string, string, string, boolean, any][]} */
  const out = [['id','Code','code',true,'Existing code = update only the filled-in columns · new code = new employee']];
  EMP_FIELDS.forEach(([, fs]) => fs.forEach(f => { if (EMP_SKIP.includes(f[0])) return; if (f[0]==='location_exempt' && !(ME && ME.role==='admin')) return; if (isOfficer() && PAY_FIELDS.includes(f[0])) return;
    const kind = f[2]==='manager' ? 'emp' : f[2]==='select' ? 'pick' : f[2]==='number' ? 'num' : f[2]==='bool' ? 'bool' : f[2]==='date' ? 'date' : 'text';
    out.push([f[0], f[1].replace(/\s*\(.*\)\s*/,'').replace(/ — .*/,''), kind, false, kind==='pick' ? f[3].filter(Boolean) : kind==='bool' ? 'Yes / No' : kind==='emp' ? 'Manager\'s employee code' : '']); }));
  return out;
}
// ═════════════════════════════════════════════════════════
//  MANAGER — bulk upload of his own team's project assignments (My requests → Team approvals)
// ═════════════════════════════════════════════════════════
/** @type {any[]} — manager bulk-assign rows read from the uploaded spreadsheet */
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
// The calculator page (and the wage-tax settlement check) moved to React 30 Oct 2026 (react/src/calc — same arithmetic, proven by
// 97 recorded cases). The old code keeps the saved rates: the payroll reads the insurance-wage limits from calcRates() (part4).
// stored rates keep "above" as null — turn it back into Infinity
const _calcRatesRaw = calcRates;
calcRates = function(){ const R = _calcRatesRaw(); return { ...R, brackets: R.brackets.map(([u, r]) => [u === null ? Infinity : u, r]) }; };
function renderCalc(){ if (typeof PKR !== 'undefined') PKR.render(); }
/** the React page saved new rates (already stored in the database) — keep them; payroll and reports recalculated when opened */
function calcRatesSaved(stored){ settings.calcRates = stored; renderCalc(); DIRTY.add('payroll'); DIRTY.add('reports'); }

// ═════════════════════════════════════════════════════════
//  ANNOUNCEMENTS · EMPLOYEE VOICE · BIRTHDAYS (desktop)
// ═════════════════════════════════════════════════════════
const V = { loaded: false };   // the dashboard loads the Employee voice badge once
// (the dashboard's 🎂 birthdays line is React now — react/src/dashboard)
const _renderDashboardB = renderDashboard;
// @ts-expect-error — renderDashboard is deliberately extended here (the new version wraps the earlier one)
renderDashboard = function(){ const r = _renderDashboardB.apply(this, arguments); if (ME && ['admin','hr'].includes(ME.role) && !V.loaded){ V.loaded = true; loadVoice().catch(() => {}); } return r; };
async function renderSelfBirthday(){
  const box = $('self-bday'); if (!box) return;
  const r = await sb.rpc('my_birthday_today').then(x => x, () => (/** @type {{ data?: boolean }} */ ({})));
  box.innerHTML = r && r.data ? `<div class="card" style="background:linear-gradient(135deg,#ee2624,#b4151a);color:#fff;text-align:center;padding:22px;margin-bottom:16px">
      <div style="font-size:42px">🎂</div><div style="font-size:20px;font-weight:800;margin-top:6px">Petrokima family wishes you a happy birthday 🎉</div>
      <div style="opacity:.9;margin-top:4px">عائلة بتروكيما تتمنى لك عيد ميلاد سعيد</div></div>` : '';
}
const _showSelfB = showSelf;
// @ts-expect-error — showSelf is deliberately extended here (the new version wraps the earlier one)
showSelf = async function(){ const r = await _showSelfB.apply(this, arguments); renderSelfBirthday(); return r; };

// ── announcements — the page is React now (react/src/news, 30 Oct 2026); it loads when opened ──
function renderNewsPage(){ if (typeof PKR !== 'undefined') PKR.render(); }

// ── employee voice — the page and its window are React now (react/src/voice, 30 Oct 2026); kept here: the menu badge ──
// (loaded once with the dashboard for admin / HR, and again after every answer through the bridge voiceChanged)
async function loadVoice(){
  const [f, h, t, m] = await Promise.all([sb.rpc('feedback_inbox'), sb.from('hiring_requests').select('status'),
    sb.from('training_requests').select('status'), sb.from('manager_actions').select('status')]);
  const open = (f.data || []).filter(x => x.status !== 'Closed').length + (h.data || []).filter(x => x.status === 'New').length
    + (t.data || []).filter(x => x.status === 'New').length + (m.data || []).filter(x => x.status === 'Waiting for HR').length;
  const b = $('voice-badge'); if (b){ b.textContent = String(open); b.style.display = open ? '' : 'none'; }
}
/** after an answer in the React window: the badge, and the board member's dashboard card when it is shown */
async function voiceChanged(){
  await loadVoice().catch(() => {});
  if (typeof isBoardViewer === 'function' && isBoardViewer() && await loadBoardRequests(true) && typeof PKR !== 'undefined') PKR.render();
}

// ── Basic salary changes (only after the board member approves), resignation ↔ Inactive, re-employment, employment history
//    and the blacklist: all in the employee window, React since 31 Oct 2026 (react/src/employee).

// ═════════════════════════════════════════════════════════
//  TWO-STEP SIGN-IN (TOTP) + AUDIT LOG   — database: 40-two-step-audit-tidyup.sql
// ═════════════════════════════════════════════════════════
const STAFF_ROLES = ['admin','hr','hr_officer'];
let SEC = { require_staff_mfa:false, enrolled:false, aal:'aal1', ready:false };

// the two two-step windows must not close by clicking beside them or pressing Esc
document.addEventListener('click', e => { if (e.target && (/** @type {PageEl} */ (e.target).id === 'm-code' || /** @type {PageEl} */ (e.target).id === 'm-2fa')) e.stopImmediatePropagation(); }, true);
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

// ── Users & roles: the two-step card and the 2-step column are React now (react/src/users, 30 Oct 2026);
//    it uses loadSecurity() and setupTwoStep() above through the bridge.

// ═════════════════════════════════════════════════════════
//  AUDIT LOG (admin only) — the page is React now (react/src/audit, 30 Oct 2026); it loads when opened.
// ═════════════════════════════════════════════════════════

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
const locFlagged = () => S.clocks.filter(c => (Array.isArray(c.location_flags) && c.location_flags.length) || (c.applied === false && c.mock_location));
// The Location checks PAGE is React since 30 Oct 2026 (react/src/locations — also the old part46 🧭 and part47 📍 cards).
// Kept here: LOC_FLAG (reports use the names), the dashboard banner + menu badge, and this bridge helper:
/** site points changed on the React page (or the latest points read again): the loaded projects follow
 * @param {(Partial<Project> & { id: string })[]} rows */
function projectsPatched(rows){
  rows.forEach(x => { const p = S.projects.find(y => String(y.id) === String(x.id)); if (p) Object.assign(p, x); });
  if (typeof PKR !== 'undefined') PKR.render();
}

// ── menu badge (the dashboard banner is React now — react/src/dashboard) ──
const _renderDashboardBase = renderDashboard;
// @ts-expect-error — renderDashboard is deliberately extended here (the new version wraps the earlier one)
renderDashboard = function(){
  _renderDashboardBase();
  const n = locFlagged().length, el = $('loc-badge'); if (el) { el.style.display = n ? '' : 'none'; el.textContent = String(n); }
};

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
  /** @type {{ view: string, anchor: Date, emp: Employee | null, rows: AttendanceRow[], leaves: Leave[], loading: boolean, token: number, who?: any[] }} */
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
    const d = calDate(ds), today = calISO(new Date()), x = dayInfo(ds), emp = st.emp || /** @type {Employee} */ ({});
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
    const today = calISO(new Date()), emp = st.emp || /** @type {Employee} */ ({});
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

// (HR's Calendar tab on the Attendance page is React since 31 Oct 2026 — react/src/attendance/AttCalendar.tsx, proven equal by
//  calendar.golden.json. This factory still draws the employees' own "My attendance" calendar below.)
// ── Employee: self-service → My attendance ──
const SELF_CAL = makeAttCalendar('sc', {
  getEmp: () => (typeof SD !== 'undefined' && SD && SD.emp) || null,
  emptyText: 'Your employee record could not be found. Please contact HR.' });
document.querySelector('[data-spage="att"]')?.addEventListener('click', () => SELF_CAL.load());

// ═════════════════════════════════════════════════════════
//  HR ALERTS · ANNUAL LEAVE BALANCE · CERTIFICATES   (database: 47-leave-entitlement-hr-alerts.sql)
//  Alerts: hr_alerts() / hr_alert_respond() · Balance: leave_balance(emp, year) / leave_balances(year) · Rules: save_hr_rules()
// ═════════════════════════════════════════════════════════
const HRA_KIND = { contract:['📄 Contract renewal','c-orange'], probation:['⏳ End of probation','c-blue'], id:['🪪 National ID expiry','c-red'],
                   cert:['🎓 Certificate expiry','c-orange'], disability:['♿ Disability card expiry','c-orange'] };
const HRA_DEC = { seen:'Handled', renew:'Renew', not_renew:'Do not renew', confirm:'Confirm', not_confirm:'Do not confirm' };
const HR_RULES_DEF = { leave_rules:{ start_year:2026, first_year_days:15, normal_days:21, senior_days:30, senior_insured_years:10, senior_age:50, emergency_days:7, wait_months:6, carry_cap:7 },
                       hr_alerts:{ contract_days:75, probation_days:30, id_days:30, cert_days:30, disability_days:30 } };
/** @type {{ list: any[], loaded: boolean, loading: boolean, missing: boolean }} — HR alerts (hr_alerts() package — not described yet) */
let HRA = { list:[], loaded:false, loading:false, missing:false };
let HR_RULES = JSON.parse(JSON.stringify(HR_RULES_DEF));
const canHRA = () => !!(ME && ['admin','hr','hr_officer'].includes(ME.role));
const canHRW = () => !!(ME && ['admin','hr'].includes(ME.role));                      // leave / alert rules

async function loadHRAlerts(){
  if (!canHRA()) return;
  HRA.loading = true;
  const [a, r] = await Promise.all([ sb.rpc('hr_alerts'), sb.from('settings').select('*').in('key', ['leave_rules','hr_alerts']) ]);
  HRA.loading = false; HRA.loaded = true;
  HRA.missing = !!a.error; HRA.list = Array.isArray(a.data) ? a.data : [];
  (r.data || []).forEach(x => { if (HR_RULES_DEF[x.key]) HR_RULES[x.key] = { ...HR_RULES_DEF[x.key], .../** @type {object} — the saved alert rule */ (x.value || {}) }; });
  hraBadge();
  if (typeof PKR !== 'undefined') PKR.render();
}
const hraOpen = () => HRA.list.filter(a => !a.done);
function hraBadge(){ const n = hraOpen().length, el = $('hra-badge'); if (el){ el.style.display = n ? '' : 'none'; el.textContent = n; } }
// The HR alerts PAGE is React since 30 Oct 2026 (react/src/hralerts, incl. the national-ID requests of the old part31).
// Kept here: the list (HRA) for the dashboard banner + menu badge, the rules (HR_RULES) used by leave balances.
// Bridge for React: after a decision / document review the list is read again and the dashboard redrawn.
async function hrAlertsChanged(){ await loadHRAlerts(); renderDashboard(); }
/** @param {typeof HR_RULES} rules */
function hrRulesSaved(rules){ HR_RULES = rules; LB.clear(); LB_ALL.year = null; }
/** an employee's record changed outside the employee window (contract renewed, new ID expiry accepted) @param {string} id @param {Partial<Employee>} patch */
function employeePatched(id, patch){
  const i = S.employees.findIndex(x => String(x.id) === String(id));
  if (i >= 0) S.employees[i] = { ...S.employees[i], ...patch };
}
// menu badge, and the alerts loaded once after sign-in (the dashboard banner is React now — react/src/dashboard)
const _renderDashboard26 = renderDashboard;
// @ts-expect-error — renderDashboard is deliberately extended here (the new version wraps the earlier one)
renderDashboard = function(){
  const r = _renderDashboard26.apply(this, arguments);
  if (canHRA() && !HRA.loaded && !HRA.loading) loadHRAlerts().then(() => renderDashboard(), () => {});
  hraBadge();
  return r;
};

// ═════════════ ANNUAL LEAVE BALANCE (from the database) ═════════════
const LB = new Map();                       // "emp|year" → balance
/** @type {{ year: number | null, rows: any[] }} — leave balances of all staff (leave_balances() packages) */
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
// (the vacation window's balance hint is React now — react/src/vacations/LeaveDialog; lbText above stays for self-service)

// employee self-service: own balance
// @ts-expect-error — slHint is deliberately extended here (the new version wraps the earlier one)
slHint = function(){
  const f = $('sl-from').value, t = $('sl-to').value, type = $('sl-type').value, days = num($('sl-days').value), out = [];
  if (f && t && t < f) out.push('<span class="neg">“To” is before “From”.</span>');
  if (f && t && t >= f){ const cal = Math.round((dObj(t).getTime() - dObj(f).getTime()) / 86400000) + 1, wd = workdays(f, t);
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
// @ts-expect-error — openSelfLeave is deliberately extended here (the new version wraps the earlier one)
openSelfLeave = function(){ LB.clear(); return _openSelfLeave26.apply(this, arguments); };
const _renderSelf26 = renderSelf;
// @ts-expect-error — renderSelf is deliberately extended here (the new version wraps the earlier one)
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
/** the leave balances of all staff for the report "Annual leave balance" (the React Reports page asks when it opens it) @param {number} y */
async function loadLeaveBalances(y){
  const { data, error } = await sb.rpc('leave_balances', { p_year:y });
  if (error) return toast(error.message, 'err');
  LB_ALL = { year:y, rows:data || [] }; renderReports();
}

// (the employee window's leave balance and certificates are React now — react/src/employee; after a save there the bridge
//  employeeSaved clears LB and reloads the HR alerts)
// the original hint functions were attached directly — attach the new ones too (they run last and replace the text)
['sl-type','sl-days'].forEach(id => $(id).addEventListener('input', () => slHint()));

// ═════════════════════════════════════════════════════════
//  HR OFFICERS SAVE EMPLOYEE MASTER DATA (database: 49-officer-edit-master-data.sql)
//  HR officers never read the employees table (pay fields) — they read employees_safe and save through
//  officer_save_employees(), which drops the pay fields. Every screen that saves an employee keeps working
//  unchanged: for an HR officer, sb.from('employees') is routed here.
// ═════════════════════════════════════════════════════════
function officerEmpWrite(kind, rec){
  const b = { ids: /** @type {string[] | null} */ (null),
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
// @ts-expect-error — startApp is deliberately extended here (the new version wraps the earlier one)
startApp = async function(){ const r = await _startApp27.apply(this, arguments); officerPatch(sb); return r; };
const _afterLogin27 = afterLogin;
// @ts-expect-error — afterLogin is deliberately extended here (the new version wraps the earlier one)
afterLogin = async function(){ officerPatch(sb); return _afterLogin27.apply(this, arguments); };
// HR officers: show the employee Save / New employee / Bulk upload controls (pay stays hidden)
const _afterLogin27b = afterLogin;
// @ts-expect-error — afterLogin is deliberately extended here (the new version wraps the earlier one)
afterLogin = async function(){ const r = await _afterLogin27b.apply(this, arguments);
  document.body.classList.toggle('can-master', !!(ME && ['admin','hr','hr_officer'].includes(ME.role))); return r; };

// ── HR officers: penalties in days / hours show no money — handled in the React Penalties page (bridge penaltyValue).

// ── the employee window's contract end preview is React now (react/src/employee — same rule as the database on Save)

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
  document.addEventListener('click', ev => { if (/** @type {PageEl} */ (ev.target).closest('[data-page],[data-nav],[data-spage],.tab,.seg button')) later(); }, true);
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
// @ts-expect-error — showLogin is deliberately extended here (the new version wraps the earlier one)
showLogin = function(msg){
  let idle = false; try { idle = sessionStorage.getItem('pk_idle_out') === '1'; sessionStorage.removeItem('pk_idle_out'); } catch(e){}
  showLoginBeforeIdle(msg || (idle ? 'You were signed out automatically after 10 minutes without activity. Please sign in again.' : undefined));
};
// buttons of the "still there?" window (no onclick= in the page: the security policy forbids code inside the page)
$('idle-out').addEventListener('click', () => idleSignOut());
$('idle-stay').addEventListener('click', () => idleTouch());

// ═════════════════════════════════════════════════════════
//  BOARD MEMBER DASHBOARD — pending requests from managers, in three groups (22 Oct 2026)
//  Shown only to the super admin / board approver (Dalia). Read-only overview; a row opens the same
//  detail window as the Employee voice page.
//   1. Hiring requests (any manager)                — status New / In progress
//   2. Other requests from the DIRECTORS            — penalties / incentives / variable elements (waiting for the
//   3. Other requests from the other managers          board member or HR) and training requests (New / In progress)
// ═════════════════════════════════════════════════════════
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
    BRD.hire = h.data || []; BRD.train = t.data || []; BRD.act = m.data || []; BRD.at = Date.now();
    return true;
  } finally { BRD.busy = false; }
}
// The card itself is React since 31 Oct 2026 (react/src/dashboard — the three groups, DIRECTORS, rows that open the Employee voice
// window). Kept here: loading its lists (bridge boardRequests), at most once a minute when the dashboard is drawn.
const _renderDashboardBoard = renderDashboard;
// @ts-expect-error — renderDashboard is deliberately extended here (the new version wraps the earlier one)
renderDashboard = function(){
  const r = _renderDashboardBoard.apply(this, arguments);
  if (isBoardViewer()) loadBoardRequests(false).then(ch => { if (ch && typeof PKR !== 'undefined') PKR.render(); }).catch(() => {});
  return r;
};

// ═════════════════════════════════════════════════════════
//  OUTSIDE MISSIONS — HR final approval page (66, 22 Oct 2026)
//  The page is React now (react/src/missions, 30 Oct 2026); it loads fresh every time it is opened.
//  Kept here: the menu badge (missions waiting for HR, refreshed after the period data loads) and what an HR decision
//  changes elsewhere: an approved mission day has no late / early deduction → the payroll month is reloaded.
// ═════════════════════════════════════════════════════════
/** @param {number} n */
function setMissionsBadge(n){ const b = $('ms-badge'); if (b) { b.style.display = n ? '' : 'none'; b.textContent = String(n); } }
async function loadMissionsBadge(){
  const { count, error } = await sb.from('employee_missions').select('id', { count: 'exact', head: true }).eq('status', 'Waiting for HR');
  if (!error) setMissionsBadge(count || 0);
}
/** called by the React page after HR approved or rejected a mission @param {boolean} approved */
async function missionDecided(approved){
  if (!approved) return;
  // fix 25 Oct: loadPeriodData() shows the "Loading period…" cover — always hide it again (it stayed on screen for ever)
  try { await loadPeriodData(); } catch(e){ toast('Reload error — ' + /** @type {Error} */ (e).message, 'err'); } finally { loader(false); }
  DIRTY.add('payroll'); DIRTY.add('reports');
}
const _loadPeriodDataMs = loadPeriodData;
// @ts-expect-error — loadPeriodData is deliberately extended here (the new version wraps the earlier one)
loadPeriodData = async function(){ const r = await _loadPeriodDataMs.apply(this, arguments); loadMissionsBadge().catch(() => {}); return r; };

// ═════════════════════════════════════════════════════════
//  OUTSIDE MISSIONS in desktop SELF-SERVICE (66/68, 22 Oct 2026) — same rules as the phone:
//  employee asks → direct manager → HR · manager assigns → employee acknowledges (or straight to HR if he does not use the app) → HR
// ═════════════════════════════════════════════════════════
/** @type {{ mine: Mission[], team: Mission[], assign: boolean, part: boolean, missing?: boolean }} — missions in self-service */
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
  if (SMIS.assign && !(who || []).length) return toast('Choose at least one employee', 'warn');
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
  const a = /** @type {PageEl} */ (e.target).closest('[data-smis-ack]'); if (a) { a.disabled = true; return smisRpc('acknowledge_mission', { p_id: a.dataset.smisAck }, 'Thank you — your manager and HR are notified'); }
  const ok = /** @type {PageEl} */ (e.target).closest('[data-smis-ok]'); if (ok) { ok.disabled = true; return smisRpc('manager_decide_mission', { p_id: ok.dataset.smisOk, p_approve: true }, 'Approved — sent to HR'); }
  const no = /** @type {PageEl} */ (e.target).closest('[data-smis-no]'); if (no) { const note = prompt('Reason for rejecting (the employee will see it):'); if (note === null) return; if (!note.trim()) return toast('Write the reason', 'warn');
    return smisRpc('manager_decide_mission', { p_id: no.dataset.smisNo, p_approve: false, p_note: note.trim() }, 'Rejected — the employee is notified'); }
  const cx = /** @type {PageEl} */ (e.target).closest('[data-smis-cancel]'); if (cx) { const id = /** @type {string} */ (cx.dataset.smisCancel);
    confirmDel('Cancel this mission?', async () => { const { error } = await sb.rpc('cancel_mission', { p_id: id }); if (error) throw new Error(error.message.replace(/^[A-Z_]+:\s*/, '')); toast('Mission cancelled'); await loadSelf(); });
    $('del-title').textContent = 'Please confirm'; $('del-ok').textContent = 'Cancel mission'; }
});
const _loadSelfMis = loadSelf;
// @ts-expect-error — loadSelf is deliberately extended here (the new version wraps the earlier one)
loadSelf = async function(){ try { await loadSelfMissions(); } catch (e) { console.warn(e); } return _loadSelfMis.apply(this, arguments); };
const _renderSelfMis = renderSelf;
// @ts-expect-error — renderSelf is deliberately extended here (the new version wraps the earlier one)
renderSelf = function(){ const r = _renderSelfMis.apply(this, arguments); try { if (SD.emp) renderSelfMissions(); } catch (e) { console.warn(e); } return r; };

// ═════════════════════════════════════════════════════════
//  REPORT "Returns after check-out and undone check-outs" (22 Oct 2026, with 71-undo-checkout.sql)
//  Hours rule: a period counts from check-in to check-out. "Switch site" closes one period and opens the next at the same minute,
//  so travel between sites is counted. A real check-out followed by a later check-in leaves a GAP that is not counted — this
//  report lists those days so HR can ask about them, plus check-outs the employee undid within 5 minutes (table checkout_undos).
// ═════════════════════════════════════════════════════════
S.undos = [];
const _loadPeriodDataUndo = loadPeriodData;
// @ts-expect-error — loadPeriodData is deliberately extended here (the new version wraps the earlier one)
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
      const e = empOrBlank(a.emp_id), away = gaps.reduce((s, g) => s + g.min, 0);
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
//  the employee window (React) fills it as soon as the ID is typed (only when the birth date box is empty), and the report
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
REPORTS.push({ id:'emp-birth-id', g:'HR', t:'Birth date different from national ID',
  d:'Employees whose recorded birth date does not match the date written in their Egyptian national ID (digits 2–7). Check the ID card: either the birth date or the ID number was typed wrong. A wrong birth date affects the leave entitlement at age 50, the first-sign-in question and the birthday greeting.',
  build:() => {
    const rows = (S.employees || []).map(e => ({ e, idb: birthFromNid(e.national_id) }))
      .filter(x => x.idb && x.e.birth_date && String(x.e.birth_date).slice(0, 10) !== x.idb)
      .map(({ e, idb }) => ({ code:e.id, name:empName(e), status:e.status, department:e.department, rec:String(e.birth_date).slice(0, 10), idb,
        diff: String(e.birth_date).slice(0, 4) !== /** @type {string} — rows without one were filtered out */ (idb).slice(0, 4) ? 'Year differs' : String(e.birth_date).slice(5, 7) !== /** @type {string} */ (idb).slice(5, 7) ? 'Month differs' : 'Day differs' }));
    return { cols:[C('code','Code','id'),C('name','Employee','strong'),C('status','Status'),C('department','Department'),
        C('rec','Recorded birth date','date'),C('idb','Birth date in the national ID','date'),C('diff','Difference')],
      rows: rows.sort((a, b) => String(a.code).localeCompare(String(b.code), undefined, { numeric:true })) };
  } });

// ── National ID: exactly 14 digits (with 74-national-id-14-digits.sql) — the employee window (React) keeps digits only, stops at 14,
// shows "n / 14 digits" and refuses Save otherwise; the database refuses it too.

// ═════════════════════════════════════════════════════════
//  EMPLOYEE WINDOW — no field may be skipped when it applies (23 Oct 2026, with 75-employee-required-fields.sql)
//  Same rule as the database function employee_missing(); the database refuses NEW employees with gaps, the employee window
//  (React — react/src/employee, bridge employeeMissing / requiredFields) refuses Save for any employee until his gaps are filled,
//  marks the empty boxes in red and lists them; always-required boxes get a red *. Report "Missing employee data" lists every
//  active employee with gaps.
// ═════════════════════════════════════════════════════════
const REQ_ALWAYS = [['name_ar','Arabic name'],['name_en','English name'],['department','Department'],['unit','Unit'],['entity','Entity'],
  ['job_name','Job name'],['job_type','Job type'],['mobile','Personal mobile'],['personal_email','Personal e-mail'],['address','Address'],['contract_type','Contract type'],
  ['employment_date','Employment date'],['birth_date','Birth date'],['gender','Gender'],['marital_status','Marital status'],
  ['religion','Religion'],['nationality','Nationality'],['national_id','National ID'],['national_id_expiry','National ID expiry'],
  ['insurance','Insurance'],['payment_method','Payment method'],['university','University'],['college','College'],['graduation_date','Graduation date']];
const PICK_OTHER = '__other__';    // the drop-downs' "➕ Other" choice (React window) never counts as filled in
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
//  DATA REQUESTS — HR asks employees to update their own data on the phone (23 Oct 2026, 77 + 78)
//  The page and the "📝 New request" window are React now (react/src/datareq, 30 Oct 2026).
//  Kept here: the menu badge (answers waiting for review + changes employees made that nobody has seen yet, refreshed after
//  the period data loads).
// ═════════════════════════════════════════════════════════
/** @param {number} n */
function setDataRequestsBadge(n){ const b = $('dq-badge'); if (b) { b.style.display = n ? '' : 'none'; b.textContent = String(n); } }
async function loadDataRequestsBadge(){
  const [a, c] = await Promise.all([
    sb.from('data_requests').select('id', { count: 'exact', head: true }).eq('status', 'Answered'),
    sb.from('employee_self_changes').select('id', { count: 'exact', head: true }).is('seen_at', null)]);
  if (!a.error) setDataRequestsBadge((a.count || 0) + (c.error ? 0 : (c.count || 0)));
}
const _loadPeriodDataDq = loadPeriodData;
// @ts-expect-error — loadPeriodData is deliberately extended here (the new version wraps the earlier one)
loadPeriodData = async function(){ const r = await _loadPeriodDataDq.apply(this, arguments); loadDataRequestsBadge().catch(() => {}); return r; };
// (the employee window's "📝 Ask employee to update data" button is React now — react/src/employee)

// ═════════════════════════════════════════════════════════
//  CHECK-OUTS TO RECORD (24 Oct 2026, 80-checkout-requests.sql)   ·   page 🚪 Check-outs to record (Workforce)
//  The page is React now (react/src/checkouts, 30 Oct 2026); it loads fresh every time it is opened.
//  Kept here: the menu badge (requests waiting for HR, refreshed after the period data loads) and the reload of the payroll
//  month after HR recorded a check-out (the attendance record changed).
// ═════════════════════════════════════════════════════════
/** @param {number} n */
function setCheckoutBadge(n){ const b = $('co-badge'); if (b) { b.style.display = n ? '' : 'none'; b.textContent = String(n); } }
async function loadCheckoutBadge(){
  const { count, error } = await sb.from('checkout_requests').select('id', { count: 'exact', head: true }).eq('status', 'Waiting');
  if (!error) setCheckoutBadge(count || 0);
}
/** called by the React page after HR recorded a check-out */
async function checkoutRecorded(){
  try { await loadPeriodData(); } catch(e){} finally { loader(false); }   // fix 25 Oct: hide the "Loading period…" cover
}
const _loadPeriodDataCo = loadPeriodData;
// @ts-expect-error — loadPeriodData is deliberately extended here (the new version wraps the earlier one)
loadPeriodData = async function(){ const r = await _loadPeriodDataCo.apply(this, arguments); loadCheckoutBadge().catch(() => {}); return r; };

// ═════════════════════════════════════════════════════════
//  TEAM ATTENDANCE — direct managers see their direct reports (database file 87: team_attendance)
//  Today: who is in (since when, where), who left, on leave / mission, no record yet.
//  Period: per person — present days, late arrivals, short days, working days with no record, leave, mission, hours;
//  click a person for the day-by-day list. No pay and no GPS points are ever loaded.
// ═════════════════════════════════════════════════════════
/** @type {{ view: string, data: any, open: any, q: string }} — team attendance (team_attendance() package) */
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
      if (fi != null && fi < (eve ?? 0)) late = Math.max(0, fi - (lim ?? 0));   // a missing rule time counts as 00:00 (as before)
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
$('ta-q').addEventListener('input', e => { TA.q = /** @type {PageEl} */ (e.target).value; renderTeamAtt(); });
$('ta-body').addEventListener('click', e => { const r = /** @type {PageEl} */ (e.target).closest('[data-ta-emp]'); if (!r) return; TA.open = TA.open === r.dataset.taEmp ? null : r.dataset.taEmp; renderTeamAtt(); });

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
['self-list', 'smis-tbl', 'self-treq-tbl', 'self-team-tbl'].forEach(domStatusFilter);   // Employee voice: React (own status boxes)

// ═════════════════════════════════════════════════════════
//  DATES TYPED AS DAY-MONTH-YEAR (26 Oct 2026) — Mohammed: "type dates like 26102026, 01012026"
//  Every <input type="date"> of the desktop app becomes a text box that accepts
//    26102026 · 26/10/2026 · 26-10-2026 · 26.10.2026 · 261026 (→ 2026) · 2026-10-26 (pasted) · 0 + Tab = today
//  and shows 26/10/2026. Its .value still reads and writes yyyy-mm-dd, so every screen keeps working
//  unchanged ('' while the date is incomplete or impossible). The 📅 icon at the right opens the calendar.
//  Boxes added later (windows, forms drawn by code) are converted automatically.
// ═════════════════════════════════════════════════════════
const DMY_NATIVE = /** @type {{ get: () => string, set: (v: string) => void }} — always present on input fields */ (Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value'));
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
  const el = /** @type {PageEl} */ (e.target); if (!el || !el.dataset || el.dataset.dmy !== '1') return;   // '1' = converted here (React boxes: 'react')
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
  const el = /** @type {PageEl} */ (e.target); if (!el || !el.dataset || el.dataset.dmy !== '1') return;
  const raw = DMY_NATIVE.get.call(el);
  if (raw.trim() === '0') {                                   // "0" + Tab = today (Mohammed, 30 Oct 2026)
    const t = new Date(), iso = `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-${String(t.getDate()).padStart(2,'0')}`;
    el.value = iso; el.classList.remove('dmy-bad'); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return;
  }
  const p = dmyParse(raw);
  if (p) { DMY_NATIVE.set.call(el, dmyShow(p)); el.classList.remove('dmy-bad'); }
  else el.classList.toggle('dmy-bad', p === null);
}, true);
// the native "change" of a text box fires on blur — skip it when nothing really changed
document.addEventListener('change', e => {
  const el = /** @type {PageEl} */ (e.target); if (!el || !el.dataset || el.dataset.dmy !== '1' || !e.isTrusted) return;
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
  const el = /** @type {PageEl} */ (e.target); if (!el || !el.dataset || el.dataset.dmy !== '1' || el.disabled || el.readOnly) return;
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
  const btn = /** @type {PageEl} */ (e.target).closest && /** @type {PageEl} */ (e.target).closest('.btn-primary,.btn-success'); if (!btn) return;
  const scope = btn.closest('.modal') || btn.closest('.page') || btn.closest('#self') || document;
  const bad = [...scope.querySelectorAll('input.dmy')].find(el => el.offsetParent !== null && dmyParse(DMY_NATIVE.get.call(el)) === null);
  if (!bad) return;
  e.preventDefault(); e.stopImmediatePropagation();
  bad.classList.add('dmy-bad'); bad.focus();
  toast(`“${DMY_NATIVE.get.call(bad)}” is not a real date — type day month year, e.g. 26102026`, 'warn');
}, true);

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

