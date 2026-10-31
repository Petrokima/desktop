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
// The connection card, the sign-in card and the first sign-in are React since 31 Oct 2026 (react/src/signin). The old code only
// says which card to show (SIGNIN) and why the saved connection could not start (SETUP_ERR); what happens after signing in stays here.
/** @type {{ mode: 'login', msg?: string } | { mode: 'noaccess', kind: 'norole' | 'locked' | 'manager', email: string } | { mode: 'first', name: string, user: any }} */
let SIGNIN = { mode: 'login' };
let SETUP_ERR = '';
function signInCard(state){ SIGNIN = state; if (typeof PKR !== 'undefined') PKR.render(); }
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
  signInCard({ mode: 'login', msg: msg || undefined });
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
async function afterLogin(user){
  const { data } = await sb.from('app_users').select('*').eq('id', user.id);
  const me = data && data[0];
  /** @param {'norole' | 'locked' | 'manager'} kind */
  const stop = kind => { $('app').style.display='none'; $('login').style.display='flex'; signInCard({ mode: 'noaccess', kind, email: user.email }); };
  if (!me || !me.role) return stop('norole');
  if (!me.active) return stop('locked');
  if (me.must_change_password) return showFirstLogin(me, user);
  // Admin / HR / HR Officer: the 6-digit code (two-step sign-in) before staff powers
  if (STAFF_ROLES.includes(me.role) && !(await mfaGate(me, user))) return;
  if (me.role==='employee') return showSelf(me, user);
  if (me.role==='manager') return stop('manager');
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
  signInCard({ mode: 'first', name: me.full_name || user.email, user });
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
// (change password is a React window since 31 Oct 2026 — react/src/windows)
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
// (the payslip window is React since 31 Oct 2026 — react/src/windows; the bridge's showPayslip opens it)

// ═════════════════════════════════════════════════════════
//  SETTINGS
// ═════════════════════════════════════════════════════════
// The Settings page moved to React 31 Oct 2026 (react/src/settings): it reads and saves the settings itself. The old code
// still calls applySettingsUI() after it (re)loaded them, so the page shows the saved values again.
const DAYS=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
function applySettingsUI(){ if (typeof PKR !== 'undefined') PKR.settingsLoaded(); }

// (the confirm window is React since 31 Oct 2026 — react/src/windows; React pages call it through the bridge, legacy.confirm)
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
// (the old "write the reason" window m-close is gone: React pages use react/src/shared/ReasonDialog / CloseDialog)

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
  // a click beside an old window closed it; the React windows (role="dialog") close only with their own buttons or Esc
  if (t.classList && t.classList.contains('overlay') && !t.hasAttribute('role')) return t.classList.remove('open');
  const act = t.closest('[data-act]');
  if (act){ const a = act.dataset.act;
    if (a==='new-emp') return openEmp(null);
    if (a==='myprofile') return showSelf(ME, { email: ME.email });
    if (a==='goto-current') return gotoCurrentPeriod();
    if (a==='theme') return openTheme();
    if (a==='reload') return loadAll();
    if (a==='signout') return signOut();
    if (a==='chpass') return typeof PKR !== 'undefined' && PKR.openPassword();
    if (a==='disconnect'){ ev.preventDefault(); return disconnect(); }
  }
  const er = t.closest('[data-emp]'); if (er) return openEmp(er.dataset.emp || null);
});

// inputs
// (Esc closes the top React window — react/src/main.tsx; every window is React since 31 Oct 2026)

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
function renderSelf(){
  // every self-service screen is React since 31 Oct 2026 (react/src/self, react/src/team): they draw from SD / SMIS
  if (typeof PKR !== 'undefined') PKR.render();
  if (!SD.emp) return;
  // the menu: "✅ Team approvals" with everything waiting for me (the same count as react/src/team waitingCount), "👥 Team attendance"
  const myTeam = SD.myTeam || [], team = SD.team || [], mis = (typeof SMIS !== 'undefined' && SMIS.team) || [];
  const tReq = [...(SD.teamLeaves||[]), ...(SD.teamPerms||[])].sort((a,b) => (waitingManager(a)?0:1) - (waitingManager(b)?0:1)).slice(0, 60);
  const waiting = team.filter(a => a.status==='Pending manager').length + tReq.filter(waitingManager).length + mis.filter(m => m.status === 'Waiting for manager').length;
  $('self-team-nav').style.display = (team.length || tReq.length || myTeam.length || mis.length) ? '' : 'none';
  $('self-tatt-nav').style.display = myTeam.length ? '' : 'none';   // 87: direct managers see their team's attendance
  $('self-team-badge').style.display = waiting ? '' : 'none'; $('self-team-badge').textContent = String(waiting);
}
// The request windows (vacation, permission, HR request) and Cancel are React since 31 Oct 2026 (react/src/self/SelfDialogs).
document.querySelectorAll('[data-spage]').forEach(t => t.addEventListener('click', () => {
  document.querySelectorAll('[data-spage]').forEach(x=>x.classList.toggle('active', x===t));
  ['req','team','tatt','pcost','att','pay','prof'].forEach(k => $('self-'+k).style.display = t.dataset.spage===k ? '' : 'none');
  // every part is React since 31 Oct 2026: Team attendance, Project costs and My attendance load when opened, payslips lock again
  if (typeof PKR !== 'undefined') PKR.selfPageShown(String(t.dataset.spage));
}));
$('self-back').addEventListener('click', () => { $('self').style.display='none'; $('app').style.display='block'; });

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

// (a manager's decisions on his team's requests, allowances and missions are React since 31 Oct 2026 — react/src/team)
// (My payslips — the password lock and the list — is React since 31 Oct 2026: react/src/selfmore)

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
// The page itself moved to React 30 Oct 2026 (react/src/history). Kept here: the CSV export (also used by the Payroll Run page;
// the React page calls it through the bridge).
function renderHistory(){ if (typeof PKR !== 'undefined') PKR.render(); }
// (the approved payslip window is React since 31 Oct 2026 — react/src/windows; the bridge's showApprovedPayslip opens it)
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
// the window is React since 31 Oct 2026 (react/src/windows); the theme chosen is applied at start-up by boot.js
function openTheme(){ if (typeof PKR !== 'undefined') PKR.openTheme(); }

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

// (the phone sign-in attempts window is React since 31 Oct 2026 — react/src/windows; the Dashboard's 🚨 banner opens it)

// ═════════════════════════════════════════════════════════
//  PROJECT ASSIGNMENTS — moved to React 30 Oct 2026 (react/src/assign). The old code keeps the list (S.empProjects: employee
//  window, reports, bulk import) and updates it after the React page changed something.
// ═════════════════════════════════════════════════════════
function renderAssign(){ if (typeof PKR !== 'undefined') PKR.render(); }
/** @param {EmployeeProject[]} rows */
function assignmentsAdded(rows){ S.empProjects = S.empProjects.concat(rows); renderAssign(); }
/** @param {string} empId @param {string} code */
function assignmentRemoved(empId, code){ S.empProjects = S.empProjects.filter(x => !(String(x.emp_id)===String(empId) && x.project_code===code)); renderAssign(); }

// (a manager's "Your team's projects" window is React since 31 Oct 2026 — react/src/team)

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
// (the accountant's view — self-service → Project costs — is React since 31 Oct 2026: react/src/selfmore)

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
// (the manager's bulk upload of his team's project assignments is React since 31 Oct 2026 — react/src/team)

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
// (self-service's 🎂 birthday card is React now — react/src/self SelfHead)

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

// the two two-step windows (React since 31 Oct 2026 — react/src/signin) must not close by clicking beside them or pressing Esc
const twoStepOpen = () => !!document.querySelector('#m-code.open, #m-2fa.open');
document.addEventListener('click', e => { if (e.target && (/** @type {PageEl} */ (e.target).id === 'm-code' || /** @type {PageEl} */ (e.target).id === 'm-2fa')) e.stopImmediatePropagation(); }, true);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && twoStepOpen()) e.stopImmediatePropagation(); }, true);

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

// ── the 6-digit code window and the authenticator set-up window are React since 31 Oct 2026 (react/src/signin) ──
/** @param {{ title?: string, cancelText?: string }} [opts] @returns {Promise<boolean>} true when the code was right */
function askCode(opts = {}){ return /** @type {NonNullable<typeof PKR>} */ (PKR).askCode(opts); }
/** @param {{ forced?: boolean }} [opts] @returns {Promise<boolean>} true when an authenticator was set up */
function setupTwoStep(opts = {}){ return /** @type {NonNullable<typeof PKR>} */ (PKR).setupTwoStep(opts); }

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
// (the vacation windows' balance hints are React now — react/src/vacations/LeaveDialog and react/src/self/SelfDialogs; so is
//  self-service's annual balance card — react/src/self)

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
  if (typeof PKR !== 'undefined') PKR.idleWarning(null);           // the warning window (React — react/src/windows) closes
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
  // the warning window is React (react/src/windows): it shows the seconds left
  if (typeof PKR !== 'undefined') PKR.idleWarning(quiet >= IDLE_WARN_MS ? Math.max(1, Math.ceil((IDLE_LIMIT_MS - quiet) / 1000)) : null);
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
// (the "still there?" window is React — react/src/windows; its buttons call idleSignOut / idleTouch through the bridge)

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
/** @type {{ mine: Mission[], team: Mission[], missing?: boolean }} — missions in self-service (read here, drawn by React) */
let SMIS = { mine: [], team: [] };
async function loadSelfMissions(){
  const id = SELF.me && SELF.me.emp_id; if (!id) return;
  const [a, b] = await Promise.all([
    sb.from('employee_missions').select('*').eq('emp_id', id).order('created_at', { ascending: false }).limit(100),
    sb.from('employee_missions').select('*').eq('manager_id', id).neq('emp_id', id).order('created_at', { ascending: false }).limit(200)]);
  SMIS.missing = !!(a.error && /does not exist|schema cache/i.test(a.error.message));
  SMIS.mine = a.data || []; SMIS.team = b.data || [];
}
// The missions on screen, the mission window and every mission button are React since 31 Oct 2026 (react/src/self, react/src/team).
const _loadSelfMis = loadSelf;
// @ts-expect-error — loadSelf is deliberately extended here (the new version wraps the earlier one)
loadSelf = async function(){ try { await loadSelfMissions(); } catch (e) { console.warn(e); } return _loadSelfMis.apply(this, arguments); };

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
  // (the connection card is React — react/src/signin: it starts with the saved address and key, and shows SETUP_ERR)
  if (!lib()){ SETUP_ERR = 'The app could not load. Check your internet connection and reload.'; $('setup').style.display='flex'; return; }
  if (url && key) startApp(url, key).catch(e => { SETUP_ERR = 'Auto-connect failed: '+e.message; if (typeof PKR !== 'undefined') PKR.render(); $('setup').style.display='flex'; $('app').style.display='none'; });
})();

