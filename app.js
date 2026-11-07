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
// ready for HR's decision (the manager step done, or none); fmtSent = the "sent" time — React since 3 Nov 2026 (react/src/core/helpers.ts)
const readyForHR = r => payEngine().readyForHR(r);
const fmtSent = ts => payEngine().fmtSent(ts);
// (waitingManager, deadlineMsg, mgrStep / mgrStage — the old request lists' manager line — are gone: every page draws its own, in React)

// ═════════════════════════════════════════════════════════
//  HELPERS
// ═════════════════════════════════════════════════════════
/** @type {(id: string) => any} element by id (typed loosely on purpose: forms, buttons, inputs …) */
const $ = id => document.getElementById(id);
// The core helpers moved to React on 3 Nov 2026 (react/src/core/helpers.ts — proven equal to this part's old code by core.golden.json):
// numbers and money, TODAY IN CAIRO, the payroll calendar (cycle start day, period dates and label, pay month of a day), who is on the
// payroll and the 30-day pay factor (must match payroll_calc, file 85), the look-ups. These old names forward there, synchronously
// (payEngine() of part4 says "reload the page (F5)" when react.js did not load).
const num = v => payEngine().num(v);
const fmt = v => payEngine().fmt(v);
const pad = n => payEngine().pad(n);
function todayStr(){ return payEngine().todayStr(); }
function thisMonth(){ return payEngine().thisMonth(); }
function cycleDay(){ return payEngine().cycleDay(); }
function periodStart(p){ return payEngine().periodStart(p); }
function periodEnd(p){ return payEngine().periodEnd(p); }
function cycleOf(date){ return payEngine().cycleOf(date); }
function periodLabel(p){ return payEngine().periodLabel(p); }
function daysBetweenIncl(a,b){ return payEngine().daysBetweenIncl(a, b); }
function onPayroll(e, p){ return payEngine().onPayroll(e, p); }
function employment(e, p){ return payEngine().employment(e, p); }
function periodIdx(p){ return payEngine().periodIdx(p); }
function empName(e){ return payEngine().empName(e); }
function lib(){ const l = window.supabase; return (l && typeof l.createClient === 'function') ? l : null; }
// (chip() and esc() are gone: no old screen draws HTML any more)
const NOPERM = "Your role doesn't allow this change";
// The message at the bottom right and the "Loading …" cover are React since 2 Nov 2026 (react/src/shell: the wording of database
// refusals, the colours, the 3.8 seconds). The old code keeps only the latest message / the cover's state, so nothing is lost
// when it is called before the React bundle has loaded.
const TOAST = { msg: '', type: 'ok', seq: 0 };
/** @param {unknown} msg @param {string} [type] 'ok' | 'warn' | 'err' */
function toast(msg, type='ok'){
  TOAST.msg = String(msg); TOAST.type = type; TOAST.seq += 1;
  if (typeof PKR !== 'undefined') PKR.toastShown();
}
const LOADING = { on: false, msg: 'Loading data…' };
// The page itself is React since 2 Nov 2026 (react/src/app). The old code says which of the four screens are shown — the same
// values it wrote before into style.display ('' = as the page starts, 'none', 'flex', 'block'); React draws them at once.
const SCREEN = { setup: '', login: 'none', app: 'none', self: 'none' };
/** @param {Partial<typeof SCREEN>} part */
function setScreens(part){ Object.assign(SCREEN, part); if (typeof PKR !== 'undefined') PKR.screensChanged(); }
/** @param {boolean} on @param {string} [msg] the words (kept when none is given) */
function loader(on, msg){ LOADING.on = on; if (msg) LOADING.msg = msg; if (typeof PKR !== 'undefined') PKR.loadingChanged(); }
// look-ups (React since 3 Nov 2026 — react/src/core/helpers.ts); elOrBlank / parseEmpInput / parseProjInput are gone (nothing used them)
/** @returns {Employee | undefined} */
function empById(id){ return payEngine().empById(id); }
/** the employee, or an empty record when the code is unknown (never undefined) @returns {Employee} */
function empOrBlank(id){ return payEngine().empOrBlank(id); }
/** @returns {SalaryElement | undefined} */
function elByCode(c){ return payEngine().elByCode(c); }
// The data loading is React since 2 Nov 2026 (react/src/data/load.ts: fetchAll in batches of 1,000, loadSettings, loadPeriodData with
// the menu counts and the undone check-outs, loadAll, loadSelf with the missions). These old names forward there, so every caller
// keeps working; the data is still kept here (S, settings, the …TableMissing flags, holidaySet, SD, SMIS).
/** the React bundle runs right after app.js; a question asked before it is there waits for it */
async function pkr(){
  if (typeof PKR === 'undefined' && document.readyState === 'loading') await new Promise(r => document.addEventListener('DOMContentLoaded', r, { once: true }));
  if (typeof PKR === 'undefined') throw new Error('The app could not load completely — reload the page (F5).');
  return PKR;
}
/**
 * @template {keyof DB['Tables'] | keyof DB['Views']} T
 * @param {T} table  a table or view of our database (checked)
 * @param {string} [orderCol]  @param {(q: any) => any} [filterFn]  extra filters, e.g. q => q.eq('period', p)
 * @returns {Promise<(T extends keyof DB['Tables'] ? Row<T> : DB['Views'][T & keyof DB['Views']]['Row'])[]>} every row
 */
async function fetchAll(table, orderCol, filterFn){ return /** @type {any} — typed above */ ((await pkr()).fetchAll(table, orderCol, filterFn)); }

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
// The frame (top bars + menus) is React since 2 Nov 2026 (react/src/frame). The old code keeps the counts behind the menu badges
// (one setter for all eleven: perm, lv, hr, ms, co, dq, rl, hra, loc, voice, aa) and the period the loaded data is for.
/** @type {Record<string, number>} */
const NAVB = {};
/** a menu badge's count changed (0 = hidden) @param {string} key @param {number} n */
function navBadge(key, n){ NAVB[key] = n; if (typeof PKR !== 'undefined') PKR.badgesChanged(); }   // only the menu redraws
let SHOWN_PERIOD = '';
const ROLE_LABEL = { admin:'Admin', hr:'HR', hr_officer:'HR Officer', employee:'Employee' };
const PAY_FIELDS = ['salary','housing','transport','daily_pay','hour_pay','delay_hour_pay','insurance_amount'];
const isOfficer = () => !!(ME && ME.role === 'hr_officer');
// Start-up and signing in are React since 2 Nov 2026 (react/src/session/session.ts: connecting, the sign-in card, who may enter,
// the role's powers on the page, the two-step code, the Cloudflare check, signing out). These old names forward there; the state
// stays here (sb, ME, SELF, SIGNIN, DB_HOST — and SEC in part23). startApp hides the connection card at once, as before.
/** @param {string} url @param {string} key */
async function startApp(url,key){ setScreens({ setup: 'none' }); return (await pkr()).startApp(url, key); }
/** @param {string} [msg] */
function showLogin(msg){ if (typeof PKR !== 'undefined') return PKR.showLogin(msg); pkr().then(k => k.showLogin(msg)); }   // at once, as before
/** @param {{ id: string, email?: string | null }} user */
async function afterLogin(user){ return (await pkr()).afterLogin(user); }
/** @param {any} me @param {any} user */
function showFirstLogin(me, user){ if (typeof PKR !== 'undefined') return PKR.showFirstLogin(me, user); pkr().then(k => k.showFirstLogin(me, user)); }
let SELF = null;
/** @param {any} me @param {any} user */
async function showSelf(me, user){ return (await pkr()).showSelf(me, user); }
async function signOut(){ return (await pkr()).signOut(); }
// (change password is a React window since 31 Oct 2026 — react/src/windows)
async function disconnect(){ return (await pkr()).disconnect(); }
// TURNSTILE_SITE_KEY = the PUBLIC site key of the Cloudflare check "Petrokima HR sign-in" (empty = no check). It stays HERE: desktop/build.js
// empties it for the on-prem copy (works without internet); react/src/session reads it through the bridge.
const TURNSTILE_SITE_KEY = '0x4AAAAAAFkp9jltaXJo9weC';   // widget "Petrokima HR sign-in" (public key)
/** @param {string} boxId @param {string} [lang] @returns {Promise<string | undefined>} */
async function captchaToken(boxId, lang){ return (await pkr()).captchaToken(boxId, lang); }

// ═════════════════════════════════════════════════════════
//  LOAD
// ═════════════════════════════════════════════════════════
async function loadSettings(){ return (await pkr()).loadSettings(); }
async function loadPeriodData(){ return (await pkr()).loadPeriodData(); }
async function loadAll(){ return (await pkr()).loadAll(); }

// the lists the typing boxes suggest from (dl-emp, dl-emp-mgr, dl-jobs, dl-proj) are React since 2 Nov 2026 (react/src/shell
// SharedLists): they follow S.employees / S.projects / the period by themselves; the old callers only ask for a redraw
function buildLists(){ if (typeof PKR !== 'undefined') PKR.render(); }

// Pages are prepared when they are opened (the payroll calculation, reports and labour cost are the heavy ones): which pages, with their
// redraws (React reads this list — react/src/legacy.ts navEnv). currentPage / renderPageIfNeeded / renderAll moved to React on 3 Nov 2026 (react/src/nav/nav.ts — proven to do the same by nav.golden.json); the old names forward to it
const PAGE_RENDER = { dashboard:()=>renderDashboard(), projects:()=>renderProjects(),
  loans:()=>renderLoans(), permissions:()=>renderPermissions(),
  leaves:()=>renderLeaves(), exempt:()=>renderExempt(), penalties:()=>renderPenalties(), holidays:()=>renderHolidays(), hrreq:()=>renderHrRequests(),
  reporting:()=>renderReporting(), history:()=>renderHistory(), parrules:()=>renderParRules(), approvals:()=>renderApprovals(), assign:()=>renderAssign(), calc:()=>renderCalc(), news:()=>renderNewsPage() };
let DIRTY = new Set();   // the pages to prepare again when they are opened (read and replaced by React)
function currentPage(){ return payEngine().currentPage(); }
/** @param {string} name */
function renderPageIfNeeded(name){ return payEngine().renderPageIfNeeded(name); }
function renderAll(){ return payEngine().renderAll(); }

// ═════════════════════════════════════════════════════════
//  PAYROLL ENGINE
// ═════════════════════════════════════════════════════════
// The payroll ENGINE moved to React on 2 Nov 2026 (react/src/engine/engine.ts — proven equal to this part's old code by engine.golden.json,
// and to the database's payroll_calc by tests/payroll and tests/loans). The old names forward to it SYNCHRONOUSLY, because the reports,
// the payroll page, the penalties and every screen showing a day's overtime / late / early call them that way. react.js is loaded
// right after app.js, so it is there before anything is calculated; if it is missing the app says so instead of paying wrongly.
// Only the names the old code and the screens still use are kept here.
function payEngine(){
  if (typeof PKR === 'undefined') throw new Error('The app could not load completely — reload the page (F5).');
  return PKR;
}
function fixedActive(row, p){ return payEngine().fixedActive(row, p); }
function loanDue(l, i){ return payEngine().loanDue(l, i); }
function loanEnd(l){ return payEngine().loanEnd(l); }
function loanInstalment(l, p){ return payEngine().loanInstalment(l, p); }
function missionsOn(empId, date){ return payEngine().missionsOn(empId, date); }
function attNoOut(a){ return payEngine().attNoOut(a); }
function dayRules(a, emp){ return payEngine().dayRules(a, emp); }
function empRates(emp, p){ return payEngine().empRates(emp, p); }
function autoAllowance(emp){ return payEngine().autoAllowance(emp); }
function approvedAllowance(emp){ return payEngine().approvedAllowance(emp); }
function currentRun(){ return payEngine().currentRun(); }
function snapToResult(l){ return payEngine().snapToResult(l); }
function computeAll(){ return payEngine().computeAll(); }

// ═════════════════════════════════════════════════════════
//  RENDER — DASHBOARD
// ═════════════════════════════════════════════════════════
// The dashboard is React since 31 Oct 2026 (react/src/dashboard). renderDashboard — the menu badges, the redraw, and what parts 22 / 24 / 26 / 33
// used to add (voice read once, 📍 badge, HR alerts read once + badge, the board member's lists) — moved to React on 3 Nov 2026 (react/src/badges/badges.ts — proven to do the same by badges.golden.json); the old names forward to it
function renderDashboard(){ return payEngine().renderDashboard(); }

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
// employeeSaved (a save in the React window: the record, pick-lists, redraws, leave balances, HR alerts), fixedAdded / fixedClosed —
// moved to React on 3 Nov 2026 (react/src/changes/changes.ts — proven to do the same by changes.golden.json); the old names forward to it
/** @param {Employee} row */
function employeeSaved(row){ return payEngine().employeeSaved(row); }
/** @param {Row<'employee_salary_elements'>} row */
function fixedAdded(row){ return payEngine().fixedAdded(row); }
/** @param {string} id */
function fixedClosed(id){ return payEngine().fixedClosed(id); }

// ═════════════════════════════════════════════════════════
//  ATTENDANCE
// ═════════════════════════════════════════════════════════
// The records list, the past date range and the entry window moved to React 31 Oct 2026 (react/src/attendance). The Calendar tab
// (part25) is still here; the fingerprint-machine import is React too (react/src/machine — part16 removed). The old code keeps the cycle's records (S.attendance).
function renderAttendance(){ if (typeof PKR !== 'undefined') PKR.render(); }
// attendanceSaved / attendanceClosed moved to React on 3 Nov 2026 (react/src/changes/changes.ts — proven to do the same by changes.golden.json); the old names forward to it
/** @param {AttendanceRow} saved */
function attendanceSaved(saved){ return payEngine().attendanceSaved(saved); }
/** @param {string} id */
function attendanceClosed(id){ return payEngine().attendanceClosed(id); }

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
// projectAdded / projectDeleted moved to React on 3 Nov 2026 (react/src/changes/changes.ts — proven to do the same by changes.golden.json); the old names forward to it
/** @param {Project} row */
function projectAdded(row){ return payEngine().projectAdded(row); }
/** @param {string} id */
function projectDeleted(id){ return payEngine().projectDeleted(id); }

// ═════════════════════════════════════════════════════════
//  MONTHLY ENTRIES  (one or more project lines per employee)
// ═════════════════════════════════════════════════════════
// projLabel ("P1 — Tower") moved to React on 3 Nov 2026 (react/src/changes/changes.ts — proven to do the same by changes.golden.json); the old names forward to it
function projLabel(code){ return payEngine().projLabel(code); }
// The page, the upload window and "New variable element" moved to React 30 Oct 2026 (react/src/monthly). The old code keeps
// the loaded amounts (S.monthly — payroll, reports) and the step after a change.
function renderMonthly(){ if (typeof PKR !== 'undefined') PKR.render(); }
// monthlyChanged (the amounts read again) / elementAdded moved to React on 3 Nov 2026 (react/src/changes/changes.ts — proven to do the same by changes.golden.json); the old names forward to it
function monthlyChanged(){ return payEngine().monthlyChanged(); }
/** @param {SalaryElement} row */
function elementAdded(row){ return payEngine().elementAdded(row); }

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
// loanSaved / loanDeleted / afterLoanChange moved to React on 3 Nov 2026 (react/src/changes/changes.ts — proven to do the same by changes.golden.json); the old names forward to it
/** @param {Loan} row */
function loanSaved(row){ return payEngine().loanSaved(row); }
/** @param {string} id */
function loanDeleted(id){ return payEngine().loanDeleted(id); }
function afterLoanChange(){ return payEngine().afterLoanChange(); }

// ═════════════════════════════════════════════════════════
//  PAYROLL RUN
// ═════════════════════════════════════════════════════════
// The page and the approval window moved to React 30 Oct 2026 (react/src/payroll); the engine (computeAll) on 2 Nov 2026 (react/src/engine);
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
// closeRecords / closeError moved to React on 3 Nov 2026 (react/src/changes/changes.ts — proven to do the same by changes.golden.json); the old names forward to it
/** @param {keyof DB['Tables']} table @param {Record<string, string | number>[]} keys @param {string} reason @param {boolean} [replacing] */
function closeRecords(table, keys, reason, replacing){ return payEngine().closeRecords(table, keys, reason, replacing); }
/** @param {string} m */
const closeError = m => payEngine().closeError(m);
// (the old "write the reason" window m-close is gone: React pages use react/src/shared/ReasonDialog / CloseDialog)

// ═════════════════════════════════════════════════════════
//  NAVIGATION & EVENTS
// ═════════════════════════════════════════════════════════
// showPage and the page-wide click handler (menu items, data-nav, data-open-report, the top-bar data-act buttons, data-emp rows) moved to React on 3 Nov 2026 (react/src/nav/nav.ts — proven to do the same by nav.golden.json); the old names forward to it
// (the click handler is registered by react/src/main.tsx — installNav)
/** @param {string} name */
function showPage(name){ return payEngine().showPage(name); }

// inputs
// (Esc closes the top React window — react/src/main.tsx; every window is React since 31 Oct 2026)

// (the top-bar clock is React since 2 Nov 2026 — react/src/frame)



// ═════════════════════════════════════════════════════════
//  REPORTS
// ═════════════════════════════════════════════════════════
// The Reports PAGE is React since 31 Oct 2026, the report CALCULATIONS since 2 Nov 2026 (react/src/reports/calc.ts — every report of
// this part and those parts 26, 37, 38 and 39 added; proven equal by reportcalc.golden.json). Kept here: three small helpers other
// parts use, and the old names, which forward to React SYNCHRONOUSLY (the bridge and the payroll page's project costs call them).
// activeEmps / inPeriod moved to React on 3 Nov 2026 (react/src/changes/changes.ts — proven to do the same by changes.golden.json); the old names forward to it
const activeEmps = () => payEngine().activeEmps();
/** @param {string | null | undefined} d */
const inPeriod = d => payEngine().inPeriod(d);
function projName(c){ if(!c) return '(unallocated)'; const p=S.projects.find(x=>String(x.id)===String(c)); return p ? (p.name||'') : ''; }
/** the reports as the page lists them */
function reportDefs(){ return payEngine().reportDefs(); }
/** pay figures: HR officers never see these @param {{ id: string, g: string }} r */
function MONEY_REPORT(r){ return payEngine().MONEY_REPORT(r); }
/** one report's columns and rows (other dates' lists swapped in while it runs)
 * @param {string} id @param {{ from: string, to: string, group: string, view: string }} p @param {any} D */
function reportBuild(id, p, D){ return payEngine().reportBuild(id, p, D); }
/** each employee's gross pay charged to projects (labour cost) */
function laborCost(){ return payEngine().laborCost(); }
function renderReports(){ if (typeof PKR !== 'undefined') PKR.render(); }
/** opens a report on the Reports page (dashboard banners) @param {string} id */
function openReport(id){ if (typeof PKR !== 'undefined') PKR.openReport(id); }

// ═════════════════════════════════════════════════════════
//  PERMISSIONS (late arrival / early leave)
// ═════════════════════════════════════════════════════════
// monthOf / permUsed moved to React on 3 Nov 2026 (react/src/calendar/helpers.ts); the old names forward to it
function monthOf(d){ return payEngine().monthOf(d); }   // quota follows the payroll cycle
function permUsed(empId, month, exceptId){ return payEngine().permUsed(empId, month, exceptId); }
// The page and its windows are React now (react/src/permissions, 30 Oct 2026). Kept here: the menu badge, the quota helpers above
// (also used elsewhere) and what a saved / decided / deleted permission changes in the rest of the app.
// renderPermissions (🕐 badge + redraw), permSaved / permDeleted / afterPermChange moved to React on 3 Nov 2026 (react/src/changes/changes.ts — proven to do the same by changes.golden.json); the old names forward to it
function renderPermissions(){ return payEngine().renderPermissions(); }
/** @param {Permission} row */
function permSaved(row){ return payEngine().permSaved(row); }
/** @param {string} id */
function permDeleted(id){ return payEngine().permDeleted(id); }
function afterPermChange(){ return payEngine().afterPermChange(); }

// ═════════════════════════════════════════════════════════
//  LEAVE HELPERS
// ═════════════════════════════════════════════════════════
// The leave helpers moved to React on 3 Nov 2026 (react/src/calendar/helpers.ts — proven equal to the old code by calhelpers.golden.json).
// The payroll engine, attendance, reports, self-service and the windows still call these names; they forward to it, synchronously.
function dObj(s){ return payEngine().dObj(s); }
function dStr(o){ return payEngine().dStr(o); }
function isHoliday(s){ return payEngine().isHoliday(s); }
function holidayOn(s){ return payEngine().holidayOn(s); }
function isWorkday(s){ return payEngine().isWorkday(s); }
function workdays(from, to){ return payEngine().workdays(from, to); }
function leaveDaysIn(l, a, b){ return payEngine().leaveDaysIn(l, a, b); }
function leaveOn(empId, date){ return payEngine().leaveOn(empId, date); }
function annualEntitlement(e){ return payEngine().annualEntitlement(e); }
function annualTaken(empId, exceptId){ return payEngine().annualTaken(empId, exceptId); }

// ═════════════════════════════════════════════════════════
//  VACATIONS PAGE
// ═════════════════════════════════════════════════════════
// The page and its window are React now (react/src/vacations, 30 Oct 2026). Kept here: the leave helpers above (payroll,
// attendance, reports and self-service use them) and what a saved / decided / deleted vacation changes in the rest of the app.
function renderLeaves(){ if (typeof PKR !== 'undefined') PKR.render(); }
// leaveSaved / leaveDeleted / afterLeaveChange moved to React on 3 Nov 2026 (react/src/changes/changes.ts — proven to do the same by changes.golden.json); the old names forward to it
/** @param {Leave} row */
function leaveSaved(row){ return payEngine().leaveSaved(row); }
/** @param {string} id */
function leaveDeleted(id){ return payEngine().leaveDeleted(id); }
function afterLeaveChange(){ return payEngine().afterLeaveChange(); }

// ═════════════════════════════════════════════════════════
//  EXCEPTION RULE PAGE — moved to React 30 Oct 2026 (react/src/exempt). The old code keeps only the step after a change.
// ═════════════════════════════════════════════════════════
function renderExempt(){ if (typeof PKR !== 'undefined') PKR.render(); }
// employeesFlagged moved to React on 3 Nov 2026 (react/src/changes/changes.ts — proven to do the same by changes.golden.json); the old names forward to it
/** @param {string[]} ids @param {'attendance_exempt' | 'project_staff'} field @param {boolean} value */
function employeesFlagged(ids, field, value){ return payEngine().employeesFlagged(ids, field, value); }

// ═════════════════════════════════════════════════════════
//  PENALTIES
// ═════════════════════════════════════════════════════════
// penaltyValue / penLabel moved to React on 3 Nov 2026 (react/src/calendar/helpers.ts); the old names forward to it
function penaltyValue(x, emp, dailyRate, hourRate){ return payEngine().penaltyValue(x, emp, dailyRate, hourRate); }
function penLabel(x){ return payEngine().penLabel(x); }
// The page and its window moved to React 30 Oct 2026 (react/src/penalties). The old code keeps penaltyValue / penLabel (payroll,
// reports) and the step after a change.
function renderPenalties(){ if (typeof PKR !== 'undefined') PKR.render(); }
// penaltySaved / penaltyDeleted / afterPenChange moved to React on 3 Nov 2026 (react/src/changes/changes.ts — proven to do the same by changes.golden.json); the old names forward to it
/** @param {Penalty} saved */
function penaltySaved(saved){ return payEngine().penaltySaved(saved); }
/** @param {string} id */
function penaltyDeleted(id){ return payEngine().penaltyDeleted(id); }
function afterPenChange(){ return payEngine().afterPenChange(); }

// ═════════════════════════════════════════════════════════
//  PUBLIC HOLIDAYS — the page is React now (react/src/holidays, 30 Oct 2026). The old code keeps the loaded
//  data: React hands every change to the two functions below, which update S.holidays + the holiday list used
//  by leaves, attendance and payroll, and redraw the screens that depend on holidays.
// ═════════════════════════════════════════════════════════
function renderHolidays(){ if (typeof PKR !== 'undefined') PKR.render(); }   // React draws the page from the current data
// holidaysAdded / holidayDeleted (the holiday list used by leaves, attendance and payroll follows) / afterHolChange moved to React on 3 Nov 2026 (react/src/changes/changes.ts — proven to do the same by changes.golden.json); the old names forward to it
/** @param {Holiday[]} rows */
function holidaysAdded(rows){ return payEngine().holidaysAdded(rows); }
/** @param {string} id */
function holidayDeleted(id){ return payEngine().holidayDeleted(id); }
function afterHolChange(){ return payEngine().afterHolChange(); }

// employee screens: hours as hours and minutes (1.5 → "1 h 30 m"); payroll and reports keep decimal hours
const fmtHM = v => { const tm = Math.round(num(v) * 60), h = Math.floor(tm / 60), m = tm % 60; return h && m ? `${h} h ${m} m` : h ? `${h} h` : `${m} m`; };
// ═════════════════════════════════════════════════════════
//  SELF-SERVICE (employee's own requests)
// ═════════════════════════════════════════════════════════
/** @type {{ emp: Employee | null, leaves: Leave[], perms: Permission[], reqs: HrRequest[], slips?: PayrollRunLine[],
 *   manager?: FnResult<'my_manager'>[number] | null, team?: AllowanceApproval[], teamLeaves?: Leave[], teamPerms?: Permission[],
 *   myTeam?: FnResult<'my_team'> }}} — the signed-in person's own data (self-service) */
let SD = { emp:null, leaves:[], perms:[], reqs:[] };
// (read by React since 2 Nov 2026 — react/src/data/load.ts loadSelf: his missions, the settings, holidays, his record, requests,
// payslips, manager and team into SD / SMIS, then renderSelf)
async function loadSelf(){ return (await pkr()).loadSelf(); }
function renderSelf(){
  // every self-service screen is React since 31 Oct 2026 (react/src/self, react/src/team): they draw from SD / SMIS
  if (typeof PKR !== 'undefined') PKR.render();
  // (the menu — ✅ Team approvals with its count, 👥 Team attendance — is React since 2 Nov 2026: react/src/frame teamMenu)
}
// The request windows (vacation, permission, HR request) and Cancel are React since 31 Oct 2026 (react/src/self/SelfDialogs).
/** a self-service part picked in the menu (React — react/src/frame SelfNav) @param {string} part */
function showSelfPart(part){
  // React shows that part (react/src/app) and the menu highlights it; Team attendance, Project costs and My attendance load when
  // opened, payslips lock again
  if (typeof PKR !== 'undefined') PKR.selfPageShown(part);
}
/** ← Back to HR app (self-service top bar) */
function backToHrApp(){ setScreens({ self: 'none', app: 'block' }); }

// ═════════════════════════════════════════════════════════
//  HR SIDE: vacation decisions, HR requests page, badges
// ═════════════════════════════════════════════════════════
// HR requests page: React now (react/src/hrreq, 30 Oct 2026). It draws from S.hrreq; the Handle window saves and calls this.
function renderHrRequests(){ if (typeof PKR !== 'undefined') PKR.render(); }
// hrRequestSaved (a request HR just handled) moved to React on 3 Nov 2026 (react/src/changes/changes.ts — proven to do the same by changes.golden.json); the old names forward to it
/** @param {HrRequest} row */
function hrRequestSaved(row){ return payEngine().hrRequestSaved(row); }
// updateBadges (🌴 vacations, 📨 HR requests, 💰 allowance approvals) moved to React on 3 Nov 2026 (react/src/badges/badges.ts — proven to do the same by badges.golden.json); the old names forward to it
function updateBadges(){ return payEngine().updateBadges(); }

// (a manager's decisions on his team's requests, allowances and missions are React since 31 Oct 2026 — react/src/team)
// (My payslips — the password lock and the list — is React since 31 Oct 2026: react/src/selfmore)

// ═════════════════════════════════════════════════════════
//  PAYROLL APPROVAL (permanent snapshot)
// ═════════════════════════════════════════════════════════
// The payroll helpers moved to React on 3 Nov 2026 (react/src/payroll/helpers.ts — proven equal to this part's old code by
// payhelpers.golden.json): the payslip format Approve sends (payrollLines, also used by the engine test tests/payroll/cmp.js), the
// comparison with the database's own calculation (payrollDiffs), the step after the database approved a month (payrollApproved),
// the CSV export and "Switch to …" (below). The old names forward to it (payEngine() of part4 says "reload the page" without react.js).
function nextPeriod(p){ return payEngine().nextPeriod(p); }
function payrollLines(run){ return payEngine().payrollLines(run); }
function payrollDiffs(mine, srv){ return payEngine().payrollDiffs(mine, srv); }
/** @param {string} p @param {any} sent @param {boolean} moveNext */
function payrollApproved(p, sent, moveNext){ return payEngine().payrollApproved(p, sent, moveNext); }

// ═════════════════════════════════════════════════════════
//  PAYROLL HISTORY
// ═════════════════════════════════════════════════════════
// The page itself moved to React 30 Oct 2026 (react/src/history). Kept here: the CSV export (also used by the Payroll Run page;
// the React page calls it through the bridge).
function renderHistory(){ if (typeof PKR !== 'undefined') PKR.render(); }
// (the approved payslip window is React since 31 Oct 2026 — react/src/windows; the bridge's showApprovedPayslip opens it)
function exportRunCsv(run, period){ return payEngine().exportRunCsv(run, period); }

// (renderLocks is gone: no page had a .lock-note box left — the React pages draw their own 🔒 notes)

// ═════════════════════════════════════════════════════════
//  REPORTING LINES — moved to React 30 Oct 2026 (react/src/reporting). The old code keeps the 🧭 menu badge and the step after a change.
// ═════════════════════════════════════════════════════════
// renderReporting (🧭 badge + redraw) / managerAssigned moved to React on 3 Nov 2026 (react/src/changes/changes.ts — proven to do the same by changes.golden.json); the old names forward to it
function renderReporting(){ return payEngine().renderReporting(); }
/** @param {string[]} ids @param {string} mid */
function managerAssigned(ids, mid){ return payEngine().managerAssigned(ids, mid); }

// ═════════════════════════════════════════════════════════
//  WARN WHEN TODAY IS OUTSIDE THE PERIOD ON SCREEN
// ═════════════════════════════════════════════════════════
// the notice is drawn by the React dashboard (react/src/dashboard) and the Attendance page
function renderPeriodHint(){ if (typeof PKR !== 'undefined') PKR.render(); }
function gotoCurrentPeriod(){ return payEngine().gotoCurrentPeriod(); }

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
// Moved to React on 3 Nov 2026 (react/src/data/helpers.ts — proven equal by datahelpers.golden.json); the old names forward to it.
function parseCsv(text){ return payEngine().parseCsv(text); }
function loadSheetJs(){ return payEngine().loadSheetJs(); }
const readAs = (file, how) => payEngine().readAs(file, how);
function readFile(file){ return payEngine().readFile(file); }
// heading of a column, compared loosely (case, spaces, _ - . ignored) — the manager team upload (part20) uses it
const H = s => payEngine().H(s);

// (Past attendance — any date range — moved to the React Attendance page, 31 Oct 2026.)

// ═════════════════════════════════════════════════════════
//  PROJECT ALLOWANCE RULES
// ═════════════════════════════════════════════════════════
function parRuleUse(){ return payEngine().parRuleUse(); }   // per rule: employees and amount in this payroll cycle — React since 3 Nov 2026 (react/src/data/helpers.ts)
// The page moved to React 30 Oct 2026 (react/src/parrules). The old code keeps parRuleUse (above, used through the bridge) and the
// step after a change.
function renderParRules(){ if (typeof PKR !== 'undefined') PKR.render(); }
// allowanceRuleSaved / allowanceRuleDeleted / afterAllowanceRuleChange moved to React on 3 Nov 2026 (react/src/changes/changes.ts — proven to do the same by changes.golden.json); the old names forward to it
/** @param {AllowanceRule} row */
function allowanceRuleSaved(row){ return payEngine().allowanceRuleSaved(row); }
/** @param {string} id */
function allowanceRuleDeleted(id){ return payEngine().allowanceRuleDeleted(id); }
function afterAllowanceRuleChange(){ return payEngine().afterAllowanceRuleChange(); }

// ═════════════════════════════════════════════════════════
//  ALLOWANCE APPROVALS — direct manager first, then HR; paid only when both approved
// ═════════════════════════════════════════════════════════
// aaCalculated / aaSame / aaRows moved to React on 3 Nov 2026 (react/src/data/helpers.ts); the old names forward to it
function aaCalculated(){ return payEngine().aaCalculated(); }   // every employee with an automatic amount this cycle
const aaSame = (a, b) => payEngine().aaSame(a, b);
function aaRows(){ return payEngine().aaRows(); }
// The page moved to React 30 Oct 2026 (react/src/approvals). The old code keeps aaRows (above — also used by the payroll
// approval window) and the step after a change.
function renderApprovals(){ if (typeof PKR !== 'undefined') PKR.render(); }
// allowanceApprovalsReplaced / allowanceApprovalsUpdated moved to React on 3 Nov 2026 (react/src/changes/changes.ts — proven to do the same by changes.golden.json); the old names forward to it
/** the period's approval rows read again after sending @param {AllowanceApproval[]} rows */
function allowanceApprovalsReplaced(rows){ return payEngine().allowanceApprovalsReplaced(rows); }
/** @param {AllowanceApproval[]} rows */
function allowanceApprovalsUpdated(rows){ return payEngine().allowanceApprovalsUpdated(rows); }

// (the department + unit filters of every page are React now — react/src/shared/OrgFilter; the Reports page was the last old one)

// (the phone sign-in attempts window is React since 31 Oct 2026 — react/src/windows; the Dashboard's 🚨 banner opens it)

// ═════════════════════════════════════════════════════════
//  PROJECT ASSIGNMENTS — moved to React 30 Oct 2026 (react/src/assign). The old code keeps the list (S.empProjects: employee
//  window, reports, bulk import) and updates it after the React page changed something.
// ═════════════════════════════════════════════════════════
function renderAssign(){ if (typeof PKR !== 'undefined') PKR.render(); }
// assignmentsAdded / assignmentRemoved moved to React on 3 Nov 2026 (react/src/changes/changes.ts — proven to do the same by changes.golden.json); the old names forward to it
/** @param {EmployeeProject[]} rows */
function assignmentsAdded(rows){ return payEngine().assignmentsAdded(rows); }
/** @param {string} empId @param {string} code */
function assignmentRemoved(empId, code){ return payEngine().assignmentRemoved(empId, code); }

// (a manager's "Your team's projects" window is React since 31 Oct 2026 — react/src/team)

// (the employee window's "📌 Assigned projects" is React now — react/src/employee)

// ═════════════════════════════════════════════════════════
//  ⬇ EXCEL — on every page (what the page shows, with its filters) and on every report (all rows)
// ═════════════════════════════════════════════════════════
// isLongCode / xlNum / tableToRows / exportPageExcel / todayISO moved to React on 3 Nov 2026 (react/src/nav/nav.ts — proven to do the same by nav.golden.json); the old names forward to it
const isLongCode = v => payEngine().isLongCode(v);
const xlNum = v => payEngine().xlNum(v);
/** @param {Element} tbl */
function tableToRows(tbl){ return payEngine().tableToRows(tbl); }
/** @param {HTMLElement} pageEl */
function exportPageExcel(pageEl){ return payEngine().exportPageExcel(pageEl); }
const todayISO = () => payEngine().todayISO();
// (every page draws its own ⬇ Excel in React — react/src/shared/ExcelButton calls exportPageExcel through the bridge)

// ═════════════════════════════════════════════════════════
//  PROJECT COSTS FOR ACCOUNTING — totals per project only (no names), published for approved months
// ═════════════════════════════════════════════════════════
// moved to React on 3 Nov 2026 (react/src/payroll/helpers.ts); the old names forward to it
function projectCostTotals(detail){ return payEngine().projectCostTotals(detail); }
function publishProjectCosts(period, detail, quiet){ return payEngine().publishProjectCosts(period, detail, quiet); }
// (the accountant's view — self-service → Project costs — is React since 31 Oct 2026: react/src/selfmore)

// (the menus — ☰ Collapse menu, folding a section heading, its red dot — are React since 2 Nov 2026: react/src/frame)

// PHONE / SMALL SCREENS: ☰ (React — react/src/frame AppTopBar) opens the menu over the page; the dark area beside it closes it (React,
// react/src/app); "a menu item picked closes it" is React since 3 Nov 2026 (react/src/nav/nav.ts installNav).

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
// calcRatesSaved moved to React on 3 Nov 2026 (react/src/changes/changes.ts — proven to do the same by changes.golden.json); the old names forward to it
function calcRatesSaved(stored){ return payEngine().calcRatesSaved(stored); }

// ═════════════════════════════════════════════════════════
//  ANNOUNCEMENTS · EMPLOYEE VOICE · BIRTHDAYS (desktop)
// ═════════════════════════════════════════════════════════
const V = { loaded: false };   // the dashboard loads the Employee voice badge once (read by React — react/src/badges)
// (the dashboard's 🎂 birthdays line is React now — react/src/dashboard)
// (self-service's 🎂 birthday card is React now — react/src/self SelfHead)

// ── announcements — the page is React now (react/src/news, 30 Oct 2026); it loads when opened ──
function renderNewsPage(){ if (typeof PKR !== 'undefined') PKR.render(); }

// ── employee voice — the page and its window are React now (react/src/voice, 30 Oct 2026) ──
// loadVoice (the menu badge — read once with the dashboard for admin / HR) and voiceChanged (after every answer: the badge, and the board
// member's card) moved to React on 3 Nov 2026 (react/src/badges/badges.ts — proven to do the same by badges.golden.json); the old names forward to it
function loadVoice(){ return payEngine().loadVoice(); }
function voiceChanged(){ return payEngine().voiceChanged(); }

// ── Basic salary changes (only after the board member approves), resignation ↔ Inactive, re-employment, employment history
//    and the blacklist: all in the employee window, React since 31 Oct 2026 (react/src/employee).

// ═════════════════════════════════════════════════════════
//  TWO-STEP SIGN-IN (TOTP) + AUDIT LOG   — database: 40-two-step-audit-tidyup.sql
// ═════════════════════════════════════════════════════════
const STAFF_ROLES = ['admin','hr','hr_officer'];
let SEC = { require_staff_mfa:false, enrolled:false, aal:'aal1', ready:false };

// the two two-step windows (React since 31 Oct 2026 — react/src/signin) must not close by clicking beside them or pressing Esc
// (kept here: these listeners must come before part28's / part29's, as they always did)
const twoStepOpen = () => !!document.querySelector('#m-code.open, #m-2fa.open');
document.addEventListener('click', e => { if (e.target && (/** @type {PageEl} */ (e.target).id === 'm-code' || /** @type {PageEl} */ (e.target).id === 'm-2fa')) e.stopImmediatePropagation(); }, true);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && twoStepOpen()) e.stopImmediatePropagation(); }, true);

// (loadSecurity, currentAal: React since 2 Nov 2026 — react/src/session/session.ts; verifiedFactor was unused and is gone)
/** @returns {Promise<typeof SEC>} */
async function loadSecurity(){ return (await pkr()).loadSecurity(); }
async function currentAal(){ return (await pkr()).currentAal(); }

// ── the 6-digit code window and the authenticator set-up window are React since 31 Oct 2026 (react/src/signin) ──
/** @param {{ title?: string, cancelText?: string }} [opts] @returns {Promise<boolean>} true when the code was right */
function askCode(opts = {}){ return /** @type {NonNullable<typeof PKR>} */ (PKR).askCode(opts); }
/** @param {{ forced?: boolean }} [opts] @returns {Promise<boolean>} true when an authenticator was set up */
function setupTwoStep(opts = {}){ return /** @type {NonNullable<typeof PKR>} */ (PKR).setupTwoStep(opts); }

// ── the two-step step after the password (Admin / HR / HR Officer) and after re-typing it: React (react/src/session) ──
async function mfaGate(){ return (await pkr()).mfaGate(); }
async function mfaAfterReauth(){ return (await pkr()).mfaAfterReauth(); }

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
// The Location checks PAGE is React since 30 Oct 2026 (react/src/locations — also the old part46 🧭 and part47 📍 cards).
// Kept here: LOC_FLAG (reports and the page use the names). locFlagged (the 📍 menu badge, now drawn by renderDashboard) and projectsPatched
// (site points changed on the React page: the loaded projects follow) moved to React on 3 Nov 2026 (react/src/badges/badges.ts — proven to do the same by badges.golden.json); the old names forward to it
const locFlagged = () => payEngine().locFlagged();
/** @param {(Partial<Project> & { id: string })[]} rows */
function projectsPatched(rows){ return payEngine().projectsPatched(rows); }

// ═════════════════════════════════════════════════════════
//  HR ALERTS · ANNUAL LEAVE BALANCE · CERTIFICATES   (database: 47-leave-entitlement-hr-alerts.sql)
//  Alerts: hr_alerts() / hr_alert_respond() · Balance: leave_balance(emp, year) / leave_balances(year) · Rules: save_hr_rules()
// ═════════════════════════════════════════════════════════
const HR_RULES_DEF = { leave_rules:{ start_year:2026, first_year_days:15, normal_days:21, senior_days:30, senior_insured_years:10, senior_age:50, emergency_days:7, wait_months:6, carry_cap:7 },
                       hr_alerts:{ contract_days:75, probation_days:30, id_days:30, cert_days:30, disability_days:30 } };
/** @type {{ list: any[], loaded: boolean, loading: boolean, missing: boolean }} — HR alerts (hr_alerts() package — not described yet) */
let HRA = { list:[], loaded:false, loading:false, missing:false };
let HR_RULES = JSON.parse(JSON.stringify(HR_RULES_DEF));
// (the HRA list and HR_RULES stay here: React reads them — react/src/legacy.ts. The HR alerts PAGE is React since 30 Oct 2026, react/src/hralerts.)
// canHRA / canHRW, loadHRAlerts, hraOpen / hraBadge, hrAlertsChanged, hrRulesSaved, employeePatched — and getLB / loadLeaveBalances below —
// moved to React on 3 Nov 2026 (react/src/badges/badges.ts — proven to do the same by badges.golden.json); the old names forward to it
const canHRA = () => payEngine().canHRA();
const canHRW = () => payEngine().canHRW();                      // leave / alert rules
function loadHRAlerts(){ return payEngine().loadHRAlerts(); }
const hraOpen = () => payEngine().hraOpen();
function hraBadge(){ return payEngine().hraBadge(); }
function hrAlertsChanged(){ return payEngine().hrAlertsChanged(); }
/** @param {typeof HR_RULES} rules */
function hrRulesSaved(rules){ return payEngine().hrRulesSaved(rules); }
/** @param {string} id @param {Partial<Employee>} patch */
function employeePatched(id, patch){ return payEngine().employeePatched(id, patch); }

// ═════════════ ANNUAL LEAVE BALANCE (from the database) ═════════════
const LB = new Map();                       // "emp|year" → balance
/** @type {{ year: number | null, rows: any[] }} — leave balances of all staff (leave_balances() packages) */
let LB_ALL = { year:null, rows:[] };
/** @param {string} emp @param {string | number} year @param {boolean} [force] */
function getLB(emp, year, force){ return payEngine().getLB(emp, year, force); }
// (lbTypes / lbText were removed 3 Nov 2026: nothing used them any more — the balance lines are React: react/src/vacations balanceView)
// (the vacation windows' balance hints are React now — react/src/vacations/LeaveDialog and react/src/self/SelfDialogs; so is
//  self-service's annual balance card — react/src/self)

// (the report "Annual leave balance" moved to React 2 Nov 2026 — react/src/reports/calc.ts; it reads LB_ALL through the bridge)
/** the leave balances of all staff for the report "Annual leave balance" (the React Reports page asks when it opens it) @param {number} y */
function loadLeaveBalances(y){ return payEngine().loadLeaveBalances(y); }

// (the employee window's leave balance and certificates are React now — react/src/employee; after a save there the bridge
//  employeeSaved clears LB and reloads the HR alerts)

// ═════════════════════════════════════════════════════════
//  HR OFFICERS SAVE EMPLOYEE MASTER DATA (database: 49-officer-edit-master-data.sql)
//  HR officers never read the employees table (pay fields) — they read employees_safe and save through
//  officer_save_employees(), which drops the pay fields. Every screen that saves an employee keeps working
//  unchanged: for an HR officer, sb.from('employees') is routed here.
// ═════════════════════════════════════════════════════════
// officerEmpWrite / officerPatch moved to React on 3 Nov 2026 (react/src/data/helpers.ts — proven to route every call the same way by
// datahelpers.golden.json); the old names forward to it.
function officerEmpWrite(kind, rec){ return payEngine().officerEmpWrite(kind, rec); }
function officerPatch(client){ return payEngine().officerPatch(client); }
// (officerPatch runs after connecting and before every sign-in check, and can-master is set after it — React since 2 Nov 2026:
//  react/src/session/session.ts startApp / afterLogin)

// ── HR officers: penalties in days / hours show no money — handled in the React Penalties page (bridge penaltyValue).

// ── the employee window's contract end preview is React now (react/src/employee — same rule as the database on Save)

// ═════════════════════════════════════════════════════════
//  AUTO SIGN-OUT after 10 minutes without activity (21 Oct 2026, desktop only)
//  · Activity = mouse, keyboard, scroll or touch in ANY open tab of the app (shared through localStorage).
//  · At 9 minutes a window warns "You will be signed out in 60 seconds" with a button to stay signed in.
//  · At 10 minutes the app signs out and shows the sign-in screen with an explanation.
// ═════════════════════════════════════════════════════════
// The timer is React since 2 Nov 2026 (react/src/session/idle.ts — the same 9 / 10 minutes, shared between tabs, checked on waking).
// These old names forward there (the "Are you still there?" window's buttons use them through the bridge).
function idleTouch(){ if (typeof PKR !== 'undefined') PKR.idleTouch(); }
async function idleSignOut(){ return (await pkr()).idleSignOut(); }
// (the sign-in screen explains why the user was signed out: React since 2 Nov 2026 — react/src/session/session.ts showLogin)
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
// isBoardViewer and loadBoardRequests (the card's lists, at most once a minute when the dashboard is drawn — renderDashboard) moved to React on 3 Nov 2026 (react/src/badges/badges.ts — proven to do the same by badges.golden.json); the old names forward to it
// (the card itself is React since 31 Oct 2026 — react/src/dashboard)
const isBoardViewer = () => payEngine().isBoardViewer();
/** @param {boolean} [force] */
function loadBoardRequests(force){ return payEngine().loadBoardRequests(force); }

// ═════════════════════════════════════════════════════════
//  OUTSIDE MISSIONS — HR final approval page (66, 22 Oct 2026)
//  The page is React now (react/src/missions, 30 Oct 2026); it loads fresh every time it is opened.
//  Kept here: the menu badge (missions waiting for HR, refreshed after the period data loads) and what an HR decision
//  changes elsewhere: an approved mission day has no late / early deduction → the payroll month is reloaded.
// ═════════════════════════════════════════════════════════
// moved to React on 3 Nov 2026 (react/src/badges/badges.ts — proven to do the same by badges.golden.json); the old names forward to it
/** @param {number} n */
function setMissionsBadge(n){ return payEngine().setMissionsBadge(n); }
function loadMissionsBadge(){ return payEngine().loadMissionsBadge(); }
/** @param {boolean} approved */
function missionDecided(approved){ return payEngine().missionDecided(approved); }
// (after every period load React asks for this count — react/src/data/load.ts loadPeriodData)

// ═════════════════════════════════════════════════════════
//  OUTSIDE MISSIONS in desktop SELF-SERVICE (66/68, 22 Oct 2026) — same rules as the phone:
//  employee asks → direct manager → HR · manager assigns → employee acknowledges (or straight to HR if he does not use the app) → HR
// ═════════════════════════════════════════════════════════
/** @type {{ mine: Mission[], team: Mission[], missing?: boolean }} — missions in self-service (read here, drawn by React) */
let SMIS = { mine: [], team: [] };
async function loadSelfMissions(){ return (await pkr()).loadSelfMissions(); }   // React since 2 Nov 2026 (react/src/data/load.ts; loadSelf reads them first)
// The missions on screen, the mission window and every mission button are React since 31 Oct 2026 (react/src/self, react/src/team).

// ═════════════════════════════════════════════════════════
//  REPORT "Returns after check-out and undone check-outs" (22 Oct 2026, with 71-undo-checkout.sql)
//  Hours rule: a period counts from check-in to check-out. "Switch site" closes one period and opens the next at the same minute,
//  so travel between sites is counted. A real check-out followed by a later check-in leaves a GAP that is not counted — this
//  report lists those days so HR can ask about them, plus check-outs the employee undid within 5 minutes (table checkout_undos).
// ═════════════════════════════════════════════════════════
S.undos = [];
// (the undone check-outs of the period are read after every period load into S.undos — react/src/data/load.ts loadPeriodData)
// (dayGaps and the report itself moved to React 2 Nov 2026 — react/src/reports/calc.ts)

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
// (the report "Birth date different from national ID" moved to React 2 Nov 2026 — react/src/reports/calc.ts)

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
// (the report "Missing employee data" moved to React 2 Nov 2026 — react/src/reports/calc.ts)

// ═════════════════════════════════════════════════════════
//  DATA REQUESTS — HR asks employees to update their own data on the phone (23 Oct 2026, 77 + 78)
//  The page and the "📝 New request" window are React now (react/src/datareq, 30 Oct 2026).
//  Kept here: the menu badge (answers waiting for review + changes employees made that nobody has seen yet, refreshed after
//  the period data loads).
// ═════════════════════════════════════════════════════════
// moved to React on 3 Nov 2026 (react/src/badges/badges.ts — proven to do the same by badges.golden.json); the old names forward to it
/** @param {number} n */
function setDataRequestsBadge(n){ return payEngine().setDataRequestsBadge(n); }
function loadDataRequestsBadge(){ return payEngine().loadDataRequestsBadge(); }
// (after every period load React asks for this count — react/src/data/load.ts loadPeriodData)
// (the employee window's "📝 Ask employee to update data" button is React now — react/src/employee)

// ═════════════════════════════════════════════════════════
//  CHECK-OUTS TO RECORD (24 Oct 2026, 80-checkout-requests.sql)   ·   page 🚪 Check-outs to record (Workforce)
//  The page is React now (react/src/checkouts, 30 Oct 2026); it loads fresh every time it is opened.
//  Kept here: the menu badge (requests waiting for HR, refreshed after the period data loads) and the reload of the payroll
//  month after HR recorded a check-out (the attendance record changed).
// ═════════════════════════════════════════════════════════
// moved to React on 3 Nov 2026 (react/src/badges/badges.ts — proven to do the same by badges.golden.json); the old names forward to it
/** @param {number} n */
function setCheckoutBadge(n){ return payEngine().setCheckoutBadge(n); }
function loadCheckoutBadge(){ return payEngine().loadCheckoutBadge(); }
function checkoutRecorded(){ return payEngine().checkoutRecorded(); }
// (after every period load React asks for this count — react/src/data/load.ts loadPeriodData)

// ═════════════════════════════════════════════════════════
//  BOOT
// ═════════════════════════════════════════════════════════
// Built-in connection: when the key below is filled in, everyone goes straight to the sign-in screen.
// The publishable key is public by design (logins + database rules protect the data). Never put the secret/service key here.
const EMBED_URL = 'https://hckkrzghxxhauotyqlqr.supabase.co';
const EMBED_KEY = 'sb_publishable_yyfkPLo6M7XDe3lwurctmw_6wsmB-2M';
(function boot(){
  const embedded = EMBED_KEY && !EMBED_KEY.startsWith('PASTE-');
  if (embedded){ localStorage.setItem('sb_url', EMBED_URL); localStorage.setItem('sb_key', EMBED_KEY); setScreens({ setup: 'none' }); }
  const url = embedded ? EMBED_URL : localStorage.getItem('sb_url'), key = embedded ? EMBED_KEY : localStorage.getItem('sb_key');
  // (the connection card is React — react/src/signin: it starts with the saved address and key, and shows SETUP_ERR)
  if (!lib()){ SETUP_ERR = 'The app could not load. Check your internet connection and reload.'; setScreens({ setup: 'flex' }); return; }
  if (url && key) startApp(url, key).catch(e => { SETUP_ERR = 'Auto-connect failed: '+e.message; if (typeof PKR !== 'undefined') PKR.render(); setScreens({ setup: 'flex', app: 'none' }); });
})();

