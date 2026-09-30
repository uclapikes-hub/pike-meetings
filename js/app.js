// ===================================================================
// PIKE Meeting Tracker — Main App  (Stage 2)
// ===================================================================
// Stage 2 ships:
//   - Meetings tab functional: create, list (upcoming + past toggle), QR, delete
//   - Roll Call tab functional: signed-in brother sees active meeting + scan/tap to mark present
//   - Bylaw enforcement: 4 mandatory meetings/quarter cap, 14-day warning
//   - Per-meeting QR window override (default 5 min after start)
//   - URL hash routing: #meeting=ID auto-opens Roll Call
//
// Stage 1 features preserved: auth, roles, quarter selector, settings, My Standing.
// ===================================================================

import {
  authApi, roster, meetings, attendance, absenceRequests,
  noShows, fines, settings, events, checkins, notifications,
  EXEC_EMAILS, APPROVER_EMAILS, SGT_AT_ARMS_EMAIL, TREASURER_EMAIL, SECRETARY_EMAIL,
  PRESIDENT_EMAIL, IVP_EMAIL,
} from "./data.js";
import {
  currentQuarter, formatQuarter, quartersFromRecords, getQuarterForDate,
} from "./quarters.js";

// ---------------- App state ----------------
const state = {
  user: null,
  roster: [],
  meetings: [],
  attendance: [],
  absenceRequests: [],
  noShows: [],
  fines: [],
  settings: {},
  events: [],     // Stage 5: from event tracker collection
  checkins: [],   // Stage 5: from event tracker collection
  notifications: [],  // Stage 5B: in-app notifications
  selectedQuarter: currentQuarter(),
  showPastMeetings: false,
};

let currentQrMeeting = null;
let currentQrCanvas  = null;
let rollCallTimer    = null;

const $ = id => document.getElementById(id);

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, ch => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;",
  })[ch]);
}

function toast(msg, isError) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.toggle("error", !!isError);
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2600);
}

function inQuarter(rec) {
  if (state.selectedQuarter === "all") return true;
  return rec.quarter === state.selectedQuarter;
}

const ROLE_LABELS = {
  exec: "Exec", sgt: "Sgt-at-Arms", treasurer: "Treasurer",
  vice_chair: "J-Board Vice Chair", brother: "Brother", guest: "Guest",
};

// ===================================================================
// TIME UTILITIES (for meeting QR windows)
// ===================================================================

// Build a Date object from "YYYY-MM-DD" + "HH:MM" in local time
function combineLocalDateTime(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const [y, m, d] = dateStr.split("-").map(Number);
  const [h, mn] = timeStr.split(":").map(Number);
  return new Date(y, m - 1, d, h, mn, 0, 0);
}

// QR window: opens 15 min before start, closes (start + windowMinutes)
function qrWindow(meeting) {
  const start = combineLocalDateTime(meeting.date, meeting.startTime);
  if (!start) return { opens: null, closes: null, isOpen: false, isPast: false };
  const windowMin = Number(meeting.qrWindowMinutes || 5);
  const opens  = new Date(start.getTime() - 15 * 60 * 1000);
  const closes = new Date(start.getTime() + windowMin * 60 * 1000);
  const now    = Date.now();
  return {
    opens,
    closes,
    start,
    isOpen: now >= opens.getTime() && now < closes.getTime(),
    isPast: now >= closes.getTime(),
    isFuture: now < opens.getTime(),
  };
}

function fmtTime(timeStr) {
  if (!timeStr) return "—";
  const [h, m] = timeStr.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const hh = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${hh}:${String(m).padStart(2, "0")} ${ampm}`;
}

function fmtDate(dateStr) {
  if (!dateStr) return "TBD";
  const [y, m, d] = dateStr.split("-");
  return `${m}/${d}/${y}`;
}

function fmtDateLong(dateStr) {
  if (!dateStr) return "TBD";
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

// "in 2 hours" / "23 minutes ago" style
function relativeTime(dateOrTimestamp) {
  const target = dateOrTimestamp instanceof Date ? dateOrTimestamp.getTime() : toMs(dateOrTimestamp);
  const diff = target - Date.now();
  const absMin = Math.round(Math.abs(diff) / 60000);
  if (absMin < 1) return diff > 0 ? "in less than a minute" : "just now";
  if (absMin < 60) return diff > 0 ? `in ${absMin} min` : `${absMin} min ago`;
  const absHr = Math.round(absMin / 60);
  if (absHr < 24) return diff > 0 ? `in ${absHr} hr` : `${absHr} hr ago`;
  const absDay = Math.round(absHr / 24);
  return diff > 0 ? `in ${absDay} day${absDay === 1 ? "" : "s"}` : `${absDay} day${absDay === 1 ? "" : "s"} ago`;
}

// ===================================================================
// AUTH UI
// ===================================================================
let _hasShownWelcomePulse = false;

// ===================================================================
// WELCOME BACK CARD
// Shows once per sign-in: what changed since this person's last visit.
// Last-visit time lives in this browser only (localStorage), never in
// Firestore, and every read/write is guarded so it can't break the app.
// ===================================================================
let _welcome = null; // { since: ms|null, dismissed: bool }

function startWelcomeBack(email) {
  const key = "pike-meetings:lastSeen:" + String(email || "").toLowerCase();
  let since = null;
  try { const v = Number(localStorage.getItem(key)); if (v > 0) since = v; } catch (e) {}
  try { localStorage.setItem(key, String(Date.now())); } catch (e) {}
  _welcome = { since, dismissed: false };
}

function toMs(v) {
  if (!v) return 0;
  if (typeof v === "number") return v;
  if (typeof v.toMillis === "function") return v.toMillis();
  if (v instanceof Date) return v.getTime();
  const n = Date.parse(v); return isNaN(n) ? 0 : n;
}

function renderWelcomeBack() {
  const el = $("welcome-back");
  if (!el) return;
  if (!state.user || !_welcome || _welcome.dismissed) { el.dataset.html = ""; el.innerHTML = ""; return; }

  const u = state.user;
  const me = u.rosterEntry;
  const since = _welcome.since;           // null = first visit on this device
  const isNew = t => since != null && toMs(t) > since;
  const firstName = me ? me.firstName : (u.email || "").split("@")[0];
  const now = Date.now();
  const items = [];
  const add = (num, label, detail, alert) => items.push({ num, label, detail, alert });

  // New meetings scheduled since last visit
  const newMtgs = state.meetings.filter(m => isNew(m.createdAt));
  if (newMtgs.length) {
    const mand = newMtgs.filter(m => m.mandatory).length;
    add(newMtgs.length, `New meeting${newMtgs.length === 1 ? "" : "s"} scheduled`,
        mand ? `${mand} mandatory` : newMtgs.map(m => m.title).slice(0, 2).join(", "), mand > 0);
  }

  if (me) {
    // Decisions on my absence requests
    const decided = state.absenceRequests.filter(r => r.brotherKey === me.key && r.status !== "pending" && isNew(r.reviewedAt));
    if (decided.length) {
      const ok = decided.filter(r => r.status === "approved").length;
      add(decided.length, "Absence request update" + (decided.length === 1 ? "" : "s"),
          `${ok} approved, ${decided.length - ok} denied`, decided.length - ok > 0);
    }
    // New no-shows recorded for me
    const ns = state.noShows.filter(n => n.brotherKey === me.key && isNew(n.timestamp));
    if (ns.length) add(ns.length, "New no-show" + (ns.length === 1 ? "" : "s"), ns[0].meetingTitle || "Chapter meeting", true);
    // Outstanding fines
    const owed = state.fines.filter(f => f.brotherKey === me.key && f.status === "pending");
    if (owed.length) {
      const total = owed.reduce((s, f) => s + (Number(f.amount) || 0), 0);
      add("$" + total, "Outstanding fine" + (owed.length === 1 ? "" : "s"), "Pay the Treasurer to clear it", true);
    }
  }

  // Officer queues (current, not just new)
  if (u.isApprover) {
    const pend = state.absenceRequests.filter(r => r.status === "pending").length;
    if (pend) add(pend, "Requests to review", "Absence Requests tab", false);
  }
  if (u.isSgt) {
    const ap = state.noShows.filter(n => n.appealStatus === "pending").length;
    if (ap) add(ap, "Appeals waiting", "Your review is needed", false);
  }
  if (u.isTreasurer) {
    const unpaid = state.fines.filter(f => f.status === "pending").length;
    if (unpaid) add(unpaid, "Unpaid fines", "Chapter-wide ledger", false);
  }

  // New Dispatch issue
  const newIssues = ((state.settings && state.settings.dispatch) ? Object.values(state.settings.dispatch) : [])
    .filter(i => i && i.status === "published" && since != null && (i.publishedAt || 0) > since);

  // Next meeting, always useful
  const next = state.meetings
    .map(m => ({ m, t: combineLocalDateTime(m.date, m.startTime).getTime() }))
    .filter(x => x.t > now)
    .sort((a, b) => a.t - b.t)[0];
  if (next) {
    const days = Math.round((next.t - now) / 86400000);
    add(days <= 0 ? "Today" : days + "d", "Next meeting",
        `${next.m.title} · ${fmtDateLong(next.m.date)}, ${fmtTime(next.m.startTime)}${next.m.mandatory ? " · mandatory" : ""}`,
        !!next.m.mandatory);
  }

  const sinceText = since == null
    ? "Here's where things stand."
    : `Here's what you missed since ${new Date(since).toLocaleDateString(undefined, { month: "short", day: "numeric" })}.`;
  const hasNews = items.some(i => i.label !== "Next meeting");
  // Nothing new since the last visit: stay out of the way instead of showing an empty recap
  if (!hasNews && since != null) { el.dataset.html = ""; el.innerHTML = ""; return; }

  const html = `
    <section class="welcome-card" aria-label="Welcome back">
      <button class="wb-close" type="button" aria-label="Dismiss" id="wb-close">&times;</button>
      <div class="wb-eyebrow">Iota Pi · Chapter Meetings</div>
      <div class="wb-title">${since == null ? "Hey" : "Welcome back"}, ${escapeHtml(firstName)}</div>
      <div class="wb-sub">${sinceText}</div>
      ${items.length ? `<div class="wb-grid">${items.map(i => `
        <div class="wb-item${i.alert ? " is-alert" : ""}">
          <div class="wb-num">${escapeHtml(String(i.num))}</div>
          <div><div class="wb-label">${escapeHtml(i.label)}</div>
          ${i.detail ? `<div class="wb-detail">${escapeHtml(i.detail)}</div>` : ""}</div>
        </div>`).join("")}</div>` : ""}
      ${!hasNews ? `<div class="wb-caught">You're all caught up. Nothing new since your last visit.</div>` : ""}
    </section>`;
  if (el.dataset.html === html) return;   // unchanged: don't replay the entrance animation
  el.dataset.html = html;
  el.innerHTML = html;
  $("wb-close").addEventListener("click", () => { _welcome.dismissed = true; el.dataset.html = ""; el.innerHTML = ""; });
}

authApi.onChange(user => {
  const wasSignedIn = !!state.user;
  state.user = user;

  if (user) {
    const label = ROLE_LABELS[user.role] || "User";
    $("auth-status").innerHTML =
      `<strong>${escapeHtml(user.email)}</strong> <span class="role-pill role-${user.role}">${label}</span>`;
    $("auth-signin").style.display = "none";
    $("auth-signout").style.display = "";

    // Welcome Back card: remember when this person last visited
    if (!wasSignedIn) startWelcomeBack(user.email);

    // Welcome pulse — fire once per session on first sign-in
    if (!wasSignedIn && !_hasShownWelcomePulse) {
      _hasShownWelcomePulse = true;
      document.body.classList.add("welcome-pulsing");
      setTimeout(() => document.body.classList.remove("welcome-pulsing"), 1700);
    }
  } else {
    $("auth-status").innerHTML = "Not signed in";
    $("auth-signin").style.display = "";
    $("auth-signout").style.display = "none";
    _hasShownWelcomePulse = false; // Reset for next sign-in
    _welcome = null;
  }

  document.body.classList.toggle("is-signed-in", !!user);
  document.body.classList.toggle("is-exec",      !!(user && user.isExec));
  document.body.classList.toggle("is-approver",  !!(user && user.isApprover));
  document.body.classList.toggle("is-sgt",       !!(user && user.isSgt));
  document.body.classList.toggle("is-treasurer", !!(user && user.isTreasurer));
  document.body.classList.toggle("is-vice-chair",!!(user && user.isViceChair));
  document.body.classList.toggle("is-brother",   !!(user && user.rosterEntry));
  document.body.classList.toggle("is-guest",     !!(user && !user.rosterEntry && !user.isExec));

  renderAll();
  // Fresh listeners for this account, then surface anything waiting for them
  try { startDataListeners(user ? user.email : null); } catch (e) { console.warn("Listener restart failed:", e); }
  try { showPendingNotifications(); updateFineAura(); } catch (e) {}
  try { updateAuthChrome(user); } catch (e) { console.warn("Welcome page skipped:", e); }
  try { maybeStartTour(); } catch (e) {}
});

$("auth-signin").addEventListener("click", async () => {
  try { await authApi.signIn(); toast("Signed in"); }
  catch (e) { console.error(e); toast("Sign-in failed", true); }
});
$("auth-signout").addEventListener("click", async () => {
  await authApi.signOut();
  toast("Signed out");
});

// ===================================================================
// SUBSCRIPTIONS
// ===================================================================
// Listeners are (re)started whenever the signed-in account changes. Firebase
// refuses signed-out reads of most collections, and a refused listener never
// retries, so without a restart nothing loaded after tapping Sign in until a refresh.
var _unsubs = [];
var _listenersFor;
function startDataListeners(forEmail) {
  if (_listenersFor === forEmail) return;
  _listenersFor = forEmail;
  _unsubs.forEach(u => { try { u && u(); } catch (e) {} });
  _unsubs = [];
  _unsubs.push(roster.subscribe(list => {
    state.roster = list;
    renderAll();
  }));
  _unsubs.push(meetings.subscribe(list => {
    state.meetings = list;
    renderQuarterSelectors();
    renderAll();
  }));
  _unsubs.push(attendance.subscribe(list => {
    state.attendance = list;
    renderAll();
  }));
  _unsubs.push(absenceRequests.subscribe(list => {
    state.absenceRequests = list;
    renderAll();
  }));
  _unsubs.push(noShows.subscribe(list => {
    state.noShows = list;
    renderAll();
  }));
  _unsubs.push(fines.subscribe(list => {
    state.fines = list;
    updateFineAura(); // Aura must reflect fine state changes immediately
    renderAll();
  }));
  _unsubs.push(settings.subscribe(s => {
    state.settings = s;
    renderSettings();
    renderDispatchSafe();
    try { renderWelcomeBack(); } catch (e) {}
  }));
  _unsubs.push(events.subscribe(list => {
    state.events = list;
    renderAll();
  }));
  _unsubs.push(checkins.subscribe(list => {
    state.checkins = list;
    renderAll();
  }));
  _unsubs.push(notifications.subscribe(list => {
    state.notifications = list;
    showPendingNotifications();
    updateFineAura();
    renderAll();
  }));
}
startDataListeners(state.user ? state.user.email : null);

// ===================================================================
// QUARTER SELECTOR
// ===================================================================
function renderQuarterSelectors() {
  const opts = quartersFromRecords(state.meetings, state.attendance, state.noShows, state.fines);
  const html = ['<option value="all">All quarters</option>'].concat(
    opts.map(q => `<option value="${q}">${formatQuarter(q)}</option>`)
  ).join("");
  document.querySelectorAll(".quarter-select").forEach(sel => {
    const v = sel.value || state.selectedQuarter;
    sel.innerHTML = html;
    sel.value = (opts.includes(v) || v === "all") ? v : state.selectedQuarter;
  });
}

document.querySelectorAll(".quarter-select").forEach(sel => {
  sel.addEventListener("change", e => {
    state.selectedQuarter = e.target.value;
    document.querySelectorAll(".quarter-select").forEach(other => {
      if (other !== e.target) other.value = e.target.value;
    });
    renderAll();
  });
});

// ===================================================================
// TABS
// ===================================================================
function activateTab(name) {
  document.querySelectorAll(".tab").forEach(t =>
    t.classList.toggle("active", t.dataset.tab === name)
  );
  document.querySelectorAll(".panel").forEach(p =>
    p.classList.toggle("active", p.id === "panel-" + name)
  );
}
document.querySelectorAll(".tab").forEach(t => {
  t.addEventListener("click", () => activateTab(t.dataset.tab));
});

// ===================================================================
// MASTER RENDER
// ===================================================================
function renderAll() {
  try { renderWelcomeBack(); } catch (e) { console.warn("Welcome card skipped:", e); }
  try { renderGetStartedMeetings(); } catch (e) { console.warn("Get Started skipped:", e); }
  renderMyStanding();
  renderRollCallTab();
  renderMeetingsTab();
  renderAbsenceTab();
  renderReportsTab();
  renderDispatchSafe();
  try { renderMeetingsCalendar(); } catch (e) { console.warn("Calendar skipped:", e); }
}

// ===================================================================
// MY STANDING
// ===================================================================
function renderMyStanding() {
  const card = $("standing-card");
  const guestCard = $("standing-guest");

  if (!state.user) {
    card.style.display = "none";
    guestCard.style.display = "";
    guestCard.innerHTML = `
      <div class="card-title">Sign in to view your standing</div>
      <div class="card-sub">Brothers and exec use the same Google sign-in</div>
      <p style="font-family: var(--font-body); font-size: 14px; line-height: 1.6;">
        Click <strong>Sign In with Google</strong> at the top of the page.
        Use the Gmail address the chapter has on file for you.
      </p>`;
    return;
  }

  if (!state.user.rosterEntry && !state.user.isExec) {
    card.style.display = "none";
    guestCard.style.display = "";
    guestCard.innerHTML = `
      <div class="card-title">Signed in as guest</div>
      <div class="card-sub">${escapeHtml(state.user.email)}</div>
      <p style="font-family: var(--font-body); font-size: 14px; line-height: 1.6;">
        You're signed in but your email isn't matched to anyone in the chapter roster.
        Ask any exec officer to update your roster entry's email to
        <code>${escapeHtml(state.user.email)}</code> in the
        <a href="https://uclapikes-hub.github.io/pike-attendance/" target="_blank" rel="noopener" style="color: var(--garnet); font-weight: 600;">event tracker's Roster tab</a>.
      </p>`;
    return;
  }

  guestCard.style.display = "none";
  card.style.display = "";

  const target = state.user.rosterEntry;
  const fullName = target ? `${target.firstName} ${target.lastName}` : state.user.email;
  const myAttendance  = target ? state.attendance.filter(a => a.brotherKey === target.key && inQuarter(a)) : [];
  const myAbsenceReqs = target ? state.absenceRequests.filter(r => r.brotherKey === target.key && inQuarter(r)) : [];
  const myNoShows     = target ? state.noShows.filter(n => n.brotherKey === target.key && inQuarter(n)) : [];
  const myFines       = target ? state.fines.filter(f => f.brotherKey === target.key && inQuarter(f) && f.status === "pending") : [];
  const fineTotal     = myFines.reduce((sum, f) => sum + (Number(f.amount) || 0), 0);

  const approved = myAbsenceReqs.filter(r => r.status === "approved").length;
  const pending  = myAbsenceReqs.filter(r => r.status === "pending").length;
  const remainingAbsences = Math.max(0, 3 - approved);
  const meetingsThisQuarter = state.meetings.filter(inQuarter).length;

  const standingClass = (myNoShows.length >= 3) ? "judicial"
                       : (myNoShows.length === 2) ? "danger"
                       : (myNoShows.length === 1) ? "warn" : "";
  const standingLabel = (myNoShows.length >= 3) ? "Judicial Review" :
                        (myNoShows.length === 2) ? "Fine + Sgt Notice" :
                        (myNoShows.length === 1) ? "Warning" : "Good Standing";

  card.className = `card ${standingClass}`;
  card.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:14px;">
      <div>
        <div class="card-title">Welcome, ${escapeHtml(fullName)}</div>
        <div class="card-sub">${escapeHtml(target?.status || ROLE_LABELS[state.user.role])} &middot; ${formatQuarter(state.selectedQuarter)}</div>
      </div>
    </div>

    <div class="standing-grid">
      <div class="standing-tile absences">
        <div class="num">${approved}/3</div>
        <div class="label">Free Absences Used</div>
        <div class="sub">${remainingAbsences} remaining</div>
      </div>
      <div class="standing-tile no-shows">
        <div class="num">${myNoShows.length}</div>
        <div class="label">No-Shows</div>
        <div class="sub">${myNoShows.length === 0 ? "Clean record" : standingLabel}</div>
      </div>
      <div class="standing-tile fines">
        <div class="num">$${fineTotal}</div>
        <div class="label">Outstanding Fines</div>
        <div class="sub">${myFines.length === 0 ? "None" : "Pay treasurer"}</div>
      </div>
      <div class="standing-tile standing">
        <div class="num" style="font-size: 22px; padding-top: 8px;">${standingLabel}</div>
        <div class="label">This Quarter</div>
        <div class="sub">${myAttendance.length} of ${meetingsThisQuarter} meetings attended</div>
      </div>
    </div>

    ${pending > 0 ? `
      <div class="role-notice" style="margin-top: 18px;">
        <strong>${pending} absence request${pending === 1 ? "" : "s"} pending review.</strong>
        Approvers (President / IVP / Secretary) will review before each meeting.
      </div>` : ""}

    ${myNoShows.length > 0 ? renderMyNoShowsList(myNoShows, myFines) : ""}
  `;

  // Wire up Appeal buttons
  card.querySelectorAll("[data-appeal]").forEach(b =>
    b.addEventListener("click", () => openAppealModal(b.dataset.appeal)));
}

function renderMyNoShowsList(myNoShows, myFines) {
  const sorted = [...myNoShows].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  const fineByMeeting = new Map(myFines.map(f => [f.meetingId, f]));
  return `
    <div style="margin-top: 22px; padding-top: 18px; border-top: 1px solid var(--light-gold);">
      <div style="font-family: var(--font-display); font-size: 18px; font-weight: 600; color: var(--garnet); margin-bottom: 10px;">
        Your No-Shows This Quarter
      </div>
      <div style="display: flex; flex-direction: column; gap: 8px;">
        ${sorted.map((n, idx) => {
          const fine = fineByMeeting.get(n.meetingId);
          const sequence = ["1st", "2nd", "3rd", "4th+"][Math.min(n.count - 1, 3)] || "";
          const consequenceLabel =
            n.count === 1 ? "Warning" :
            n.count === 2 ? `$${fine?.amount || 25} Fine + Sgt notice` :
            n.count >= 3  ? "Sgt-at-Arms / Judicial Board" : "";

          let appealStatus = "";
          if (n.appealed) {
            appealStatus = n.appealStatus === "pending" ? "Appeal pending" :
                          n.appealStatus === "overturned" ? "✓ Overturned" :
                          n.appealStatus === "upheld" ? "Appeal denied" : "";
          }

          return `
            <div style="padding: 12px 14px; background: white; border: 1px solid rgba(170,151,103,0.3); background-image: linear-gradient(color-mix(in srgb, var(--crimson) 7%, transparent), color-mix(in srgb, var(--crimson) 7%, transparent)); border-radius: 16px; display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; align-items: flex-start; border-radius: 14px;">
              <div style="flex: 1; min-width: 200px;">
                <div style="font-family: var(--font-ui); font-size: 11px; font-weight: 600; letter-spacing: 1px; color: var(--crimson); text-transform: uppercase;">
                  ${sequence} No-Show &middot; ${escapeHtml(consequenceLabel)}
                </div>
                <div style="font-family: var(--font-body); font-size: 13px; color: var(--slate); margin-top: 4px;">
                  ${escapeHtml(n.meetingTitle || "Meeting")} &middot; ${escapeHtml(fmtDate(n.meetingDate || ""))}
                </div>
                ${n.reason ? `<div style="font-family: var(--font-body); font-size: 11px; color: var(--knight-steel); margin-top: 3px; font-style: italic;">${escapeHtml(noShowReasonLabel(n.reason))}</div>` : ""}
                ${n.appealed && n.appealStatus !== "pending" && n.appealResolverNote ? `
                  <div style="margin-top: 6px; padding: 6px 10px; background: var(--light-gold); font-family: var(--font-body); font-size: 11px; font-style: italic; border-radius: 14px;">
                    <strong style="font-style: normal; color: var(--garnet);">Sgt note:</strong> ${escapeHtml(n.appealResolverNote)}
                  </div>` : ""}
              </div>
              <div style="display: flex; flex-direction: column; gap: 6px; align-items: flex-end;">
                ${appealStatus ? `
                  <span style="background: ${n.appealStatus === "overturned" ? "var(--garnet)" : "var(--knight-steel)"}; color: white; padding: 3px 8px; font-family: var(--font-ui); font-size: 9px; font-weight: 600; letter-spacing: 1.5px;">
                    ${escapeHtml(appealStatus)}
                  </span>
                ` : ""}
                ${!n.appealed ? `<button class="btn btn-ghost btn-small" data-appeal="${n.id}">Appeal</button>` : ""}
              </div>
            </div>`;
        }).join("")}
      </div>
    </div>`;
}

function noShowReasonLabel(reason) {
  const labels = {
    no_qr_scan:        "Did not scan QR",
    denied_request:    "Absence request denied",
    pending_at_start:  "Absence request not decided in time",
  };
  return labels[reason] || reason;
}

// ===================================================================
// ROLL CALL TAB  (Stage 2)
// ===================================================================
function renderRollCallTab() {
  const placeholder = $("roll-call-placeholder");
  if (!placeholder) return;

  // Find any meeting whose QR window is currently open
  const openNow = state.meetings.find(m => qrWindow(m).isOpen);
  // Find the next upcoming meeting (window not yet open)
  const upcoming = state.meetings
    .filter(m => qrWindow(m).isFuture)
    .sort((a, b) => qrWindow(a).start.getTime() - qrWindow(b).start.getTime())[0];

  // If a brother is signed-in and there's a meeting with an open window, that's the action surface
  if (openNow && state.user && state.user.rosterEntry) {
    const target = state.user.rosterEntry;
    const w = qrWindow(openNow);
    const alreadyMarked = state.attendance.some(a =>
      a.meetingId === openNow.id && a.brotherKey === target.key
    );
    const closesIn = relativeTime(w.closes);

    placeholder.innerHTML = `
      <div class="card warn" style="text-align: center;">
        <div class="card-sub" style="color: var(--crimson);">Roll Call Open</div>
        <div class="card-title" style="color: var(--crimson); font-size: 28px;">${escapeHtml(openNow.title)}</div>
        <div style="font-family: var(--font-body); font-size: 14px; color: var(--slate); margin-top: 6px;">
          ${escapeHtml(fmtDateLong(openNow.date))} &middot; ${fmtTime(openNow.startTime)}${openNow.location ? " &middot; " + escapeHtml(openNow.location) : ""}
        </div>
        <div style="font-family: var(--font-ui); font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--gold-ink); margin-top: 14px; font-weight: 600;">
          Window closes ${closesIn}
        </div>

        ${alreadyMarked ? `
          <div style="margin-top: 24px; padding: 18px; background: var(--light-gold); background-image: linear-gradient(color-mix(in srgb, var(--garnet) 7%, transparent), color-mix(in srgb, var(--garnet) 7%, transparent)); border-radius: 16px; border-radius: 14px;">
            <div style="font-family: var(--font-display); font-size: 22px; color: var(--garnet); font-weight: 600;">
              ✓ You're checked in
            </div>
            <div style="font-family: var(--font-body); font-size: 13px; color: var(--slate); margin-top: 6px;">
              Marked present at ${new Date(state.attendance.find(a => a.meetingId === openNow.id && a.brotherKey === target.key)?.timestamp).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'})}
            </div>
          </div>
        ` : `
          <button class="btn" id="rc-mark-present" style="margin-top: 24px; font-size: 14px; padding: 16px 36px;">
            Mark Me Present
          </button>
          ${openNow.mandatory ? `<div style="margin-top: 14px; font-family: var(--font-body); font-size: 12px; font-style: italic; color: var(--burgundy);">⚑ Mandatory meeting — bylaws require attendance</div>` : ""}
        `}
      </div>
    `;

    if (!alreadyMarked) {
      $("rc-mark-present").addEventListener("click", async () => {
        try {
          await attendance.markPresent({
            meetingId:  openNow.id,
            brotherKey: target.key,
            name:       `${target.firstName} ${target.lastName}`,
            email:      target.email,
            quarter:    openNow.quarter,
          });
          toast("Marked present — thanks, brother!");
        } catch (e) {
          console.error(e);
          toast("Could not mark present — check connection", true);
        }
      });
    }
    return;
  }

  // Brother signed in but no open window
  if (state.user && state.user.rosterEntry) {
    if (!state.meetings.length) {
      placeholder.innerHTML = `
        <div class="card">
          <div class="empty-coming-soon">
            <h3>No meetings scheduled yet</h3>
            <p style="margin-top: 12px;">Check back closer to the next chapter meeting.</p>
          </div>
        </div>`;
      return;
    }

    if (upcoming) {
      const w = qrWindow(upcoming);
      const opensIn = relativeTime(w.opens);
      const html = renderNextMeetingCard(upcoming, opensIn);
      // Skip redraw when nothing changed so the sun/moon animation doesn't restart every 30s
      if (placeholder.dataset.html === html && placeholder.querySelector(".nm-card")) return;
      placeholder.dataset.html = html;
      placeholder.innerHTML = html;
      return;
    }

    // Brother but only past meetings
    placeholder.innerHTML = `
      <div class="card">
        <div class="empty-coming-soon">
          <h3>No upcoming meetings</h3>
          <p style="margin-top: 12px;">No chapter meetings scheduled at the moment.</p>
        </div>
      </div>`;
    return;
  }

  // Not signed in or guest
  placeholder.innerHTML = `
    <div class="card">
      <div class="empty-coming-soon">
        <h3>Sign in to take roll</h3>
        <p style="margin-top: 12px;">When a chapter meeting is open for roll call, the "Mark Me Present" button will appear here.</p>
      </div>
    </div>`;
}

// ===================================================================
// NEXT MEETING CARD (clock face + week strip)
// ===================================================================
function renderNextMeetingCard(m, opensIn) {
  const start = combineLocalDateTime(m.date, m.startTime);
  const hour = start.getHours();
  const evening = hour >= 17 || hour < 6;
  const timeStr = fmtTime(m.startTime);                 // e.g. "7:00 PM"
  const [clock, ampm] = timeStr.split(" ");
  const dayStr = start.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

  // Week strip: Sunday-to-Saturday week containing the meeting
  const weekStart = new Date(start); weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  const todayKey = new Date().toDateString();
  const pad = n => String(n).padStart(2, "0");
  const keyOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const days = [...Array(7)].map((_, i) => {
    const d = new Date(weekStart); d.setDate(weekStart.getDate() + i);
    const mtgs = state.meetings.filter(x => x.date === keyOf(d));
    return {
      num: d.getDate(),
      name: d.toLocaleDateString(undefined, { weekday: "short" }).slice(0, 2),
      active: keyOf(d) === m.date,
      today: d.toDateString() === todayKey,
      dot: mtgs.length ? (mtgs.some(x => x.mandatory) ? "mand" : "on") : "",
    };
  });

  const icon = evening
    ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>`
    : `<span class="nm-sun"><span class="nm-sun-core"></span><span class="nm-sun-glow"></span></span>`;

  return `
    <div class="card nm-card${m.mandatory ? " is-mandatory" : ""}">
      <div class="nm-icon ${evening ? "is-moon" : "is-sun"}" title="${evening ? "Evening meeting" : "Daytime meeting"}">${icon}</div>
      <div class="card-sub">Next Meeting${m.mandatory ? " &middot; Mandatory" : ""}</div>
      <div class="card-title">${escapeHtml(m.title)}</div>
      <div class="nm-clock">
        <span class="nm-time">${escapeHtml(clock)}</span><span class="nm-ampm">${escapeHtml(ampm || "")}</span>
      </div>
      <div class="nm-day">${escapeHtml(dayStr)}${m.location ? " &middot; " + escapeHtml(m.location) : ""}</div>

      <div class="nm-week" role="list" aria-label="Meeting week">
        ${days.map(d => `
          <div class="nm-dayitem${d.active ? " is-active" : ""}${d.today ? " is-today" : ""}" role="listitem">
            <span class="nm-num">${d.num}</span>
            <span class="nm-name">${escapeHtml(d.name)}</span>
            <span class="nm-dot ${d.dot}"></span>
          </div>`).join("")}
      </div>

      ${(() => { const f = wxForecastAt(m.date, m.startTime);
        return f ? `<div class="nm-forecast">${wxIcon(f.kind)}<span><strong>${f.temp}°F</strong> · ${escapeHtml(f.label)} expected at meeting time</span></div>` : ""; })()}
      <div class="nm-pill">Roll call opens ${escapeHtml(opensIn)}</div>
      <div class="nm-note">The "Mark Me Present" button appears here automatically 15 minutes before start.</div>
    </div>`;
}

// Re-render Roll Call every 30 seconds so the window flips when timing changes
function startRollCallTimer() {
  if (rollCallTimer) clearInterval(rollCallTimer);
  rollCallTimer = setInterval(() => {
    renderRollCallTab();
    renderMyStanding();
    renderMeetingsTab();
    // Stage 4: also run the no-show processor (only fires for exec/sgt)
    processClosedMeetings().catch(e => console.warn("No-show processor:", e));
    autoDenyPendingPastStart().catch(e => console.warn("Auto-deny:", e));
  }, 30000);
}

// ===================================================================
// STAGE 4 — NO-SHOW PROCESSING
// ===================================================================
//
// IDEMPOTENT: re-running these functions doesn't create duplicates.
// Only fires for exec or Sgt-at-Arms (via Firestore rules + UI guard).
//
// Two phases run on the 30-second timer:
//   1. autoDenyPendingPastStart — flips pending requests to "denied"
//      once their meeting starts (so they correctly become no-shows)
//   2. processClosedMeetings — for each meeting whose QR window has
//      closed, generates no_show records for eligible brothers who
//      didn't scan and don't have an approved absence
//
// Auto-creates fine records when a brother's no-show count hits 2.
// ===================================================================

const FINE_AMOUNT_DEFAULT = 25;

function brotherIsEligible(brother) {
  // Only Active brothers + New Members are subject to attendance
  return brother.status === "Active" || brother.status === "New Member";
}

async function autoDenyPendingPastStart() {
  if (!state.user || (!state.user.isExec && !state.user.isSgt)) return;

  const now = Date.now();
  const pending = state.absenceRequests.filter(r => r.status === "pending");
  if (pending.length === 0) return;

  for (const req of pending) {
    const meeting = state.meetings.find(m => m.id === req.meetingId);
    if (!meeting) continue;
    const start = combineLocalDateTime(meeting.date, meeting.startTime);
    if (!start || start.getTime() > now) continue;

    // Meeting has started. Auto-deny.
    try {
      await absenceRequests.review(req.id, "denied",
        "Auto-denied: not reviewed before meeting start time.");
      console.log(`Auto-denied request for ${req.brotherName} / ${req.meetingTitle}`);
    } catch (e) {
      console.warn("Auto-deny failed (non-approver?):", e);
    }
  }
}

// Processing lock — prevents the timer from firing the processor while a
// previous run is still in progress. The cache-based idempotency check below
// is backed up by a direct Firestore query (noShows.exists) for safety.
let _processingLock = false;

async function processClosedMeetings() {
  if (!state.user || (!state.user.isExec && !state.user.isSgt)) return;
  if (_processingLock) return; // Another run still in progress
  _processingLock = true;

  try {
    // Closed meetings = QR window has passed
    const closedMeetings = state.meetings.filter(m => qrWindow(m).isPast);
    if (closedMeetings.length === 0) return;

    // Eligible brothers (Active + New Member only)
    const eligible = state.roster.filter(brotherIsEligible);
    if (eligible.length === 0) return;

    for (const meeting of closedMeetings) {
      const meetingId = meeting.id;
      const meetingQuarter = meeting.quarter;

      // Brothers who scanned for this meeting
      const present = new Set(
        state.attendance.filter(a => a.meetingId === meetingId).map(a => a.brotherKey)
      );

      // Cache-based existing no-shows (fast first pass)
      const existingNoShows = new Set(
        state.noShows.filter(n => n.meetingId === meetingId).map(n => n.brotherKey)
      );

      for (const brother of eligible) {
        if (present.has(brother.key)) continue;        // Marked present
        if (existingNoShows.has(brother.key)) continue; // Already in cache

        // Did this brother have an approved absence for this meeting?
        const myReq = state.absenceRequests.find(r =>
          r.meetingId === meetingId && r.brotherKey === brother.key
        );
        if (myReq && myReq.status === "approved") continue; // Excused

        // STRONG IDEMPOTENCY: direct Firestore query before creating.
        // This catches the cache-stale window where the subscription
        // hasn't yet reflected a no_show that's already in the database.
        const alreadyExists = await noShows.exists(brother.key, meetingId);
        if (alreadyExists) continue;

        // Determine reason for the no-show record
        let reason = "no_qr_scan";
        if (myReq && myReq.status === "denied") {
          reason = myReq.reviewerNote?.startsWith("Auto-denied")
            ? "pending_at_start"
            : "denied_request";
        }

        // Compute count: how many no-shows does this brother already have THIS QUARTER?
        const priorCount = state.noShows.filter(n =>
          n.brotherKey === brother.key &&
          n.quarter === meetingQuarter &&
          n.appealStatus !== "overturned"
        ).length;
        const newCount = priorCount + 1;

        try {
          const fullName = `${brother.firstName} ${brother.lastName}`;
          const noShowDocRef = await noShows.create({
            brotherKey: brother.key,
            brotherName: fullName,
            email: brother.email,
            meetingId,
            meetingTitle: meeting.title,
            meetingDate: meeting.date,
            reason,
          count: newCount,
          quarter: meetingQuarter,
        });
        console.log(`No-show recorded: ${brother.firstName} (count: ${newCount})`);

        // 2nd no-show triggers a $25 fine
        let fineAmount = Number(state.settings.fineAmount) || FINE_AMOUNT_DEFAULT;
        if (newCount === 2) {
          // Direct query for strong idempotency on fine creation too
          const fineExists = await fines.exists(brother.key, meetingId);
          if (!fineExists) {
            await fines.create({
              brotherKey: brother.key,
              brotherName: fullName,
              email: brother.email,
              amount: fineAmount,
              reason: "2nd no-show",
              meetingId,
              meetingTitle: meeting.title,
              meetingDate: meeting.date,
              quarter: meetingQuarter,
            });
            console.log(`Fine created: $${fineAmount} for ${brother.firstName}`);
          }
        }

        // Notify the affected brother
        const notifData = buildNoShowNotification(fullName, meeting, newCount, fineAmount);
        await notify(brother.email, "no_show", notifData.title, notifData.message, notifData.severity, noShowDocRef.id);

        // Notify Sgt-at-Arms on 3rd+ no-show
        if (newCount >= 3) {
          const sgtEmail = state.settings.sgtAtArmsEmail || SGT_AT_ARMS_EMAIL;
          await notify(
            sgtEmail,
            "sgt_alert",
            `Judicial review flagged: ${fullName}`,
            `${fullName} has reached ${newCount} no-shows this quarter (last: ${meeting.title} on ${fmtDate(meeting.date)}). Per Article VI bylaws, judicial review may be appropriate. The brother has also been notified.`,
            "judicial",
            noShowDocRef.id
          );
        }
      } catch (e) {
        console.warn(`No-show creation failed for ${brother.firstName}:`, e);
      }
    }
  }
  } finally {
    _processingLock = false;
  }
}

// Manually triggerable from the Meetings tab (exec button on past meetings)
async function manualProcessMeeting(meetingId) {
  const meeting = state.meetings.find(m => m.id === meetingId);
  if (!meeting) return toast("Meeting not found — refresh", true);
  if (!qrWindow(meeting).isPast) {
    return toast("Meeting hasn't ended yet", true);
  }

  // Snapshot before
  const noShowsBefore = state.noShows.filter(n => n.meetingId === meetingId).length;
  const eligible = state.roster.filter(brotherIsEligible);
  const presentSet = new Set(state.attendance.filter(a => a.meetingId === meetingId).map(a => a.brotherKey));
  const expectedNoShows = eligible.filter(b => !presentSet.has(b.key)).length;

  console.log("[Process Meeting]", {
    meetingId,
    title: meeting.title,
    quarter: meeting.quarter,
    eligibleBrothers: eligible.length,
    rosterTotal: state.roster.length,
    presentForMeeting: presentSet.size,
    existingNoShows: noShowsBefore,
    expectedNewNoShows: expectedNoShows - noShowsBefore,
  });

  // Diagnose common failure modes upfront
  if (eligible.length === 0) {
    return toast("No eligible brothers in roster (need status 'Active' or 'New Member')", true);
  }
  if (!meeting.quarter) {
    return toast("Meeting has no quarter set — re-create the meeting", true);
  }

  toast("Processing no-shows...");
  await autoDenyPendingPastStart();
  await processClosedMeetings();

  // Brief delay to let Firestore subscription update, then report
  setTimeout(() => {
    const noShowsAfter = state.noShows.filter(n => n.meetingId === meetingId).length;
    const created = noShowsAfter - noShowsBefore;
    if (created === 0) {
      if (expectedNoShows === 0) {
        toast("All eligible brothers were marked present — no no-shows to create");
      } else if (noShowsBefore === expectedNoShows) {
        toast(`Already up to date — ${noShowsBefore} no-show${noShowsBefore === 1 ? "" : "s"} on record`);
      } else {
        toast("No new no-shows created — check console for diagnostics", true);
      }
    } else {
      toast(`Created ${created} no-show${created === 1 ? "" : "s"}`);
    }
  }, 1500);
}

// ===================================================================
// STAGE 4 — APPEAL MODAL
// ===================================================================

let currentAppealNoShowId = null;

// ===================================================================
// STAGE 5B — IN-APP NOTIFICATIONS
// ===================================================================
// Notification generation, sign-in modal display, fine aura.
// ===================================================================

// Recipient notification creator. `relatedId` lets us avoid duplicates.
async function notify(recipientEmail, type, title, message, severity, relatedId) {
  if (!recipientEmail) return;
  // Idempotency: don't create duplicate notifications for the same source event
  if (relatedId) {
    const existing = state.notifications.find(n =>
      n.recipientEmail === recipientEmail &&
      n.type === type &&
      n.relatedId === relatedId
    );
    if (existing) return;
  }
  try {
    await notifications.create({
      recipientEmail: recipientEmail.toLowerCase(),
      type,
      title,
      message,
      severity, // "info" | "warning" | "danger" | "judicial"
      relatedId: relatedId || null,
    });
  } catch (e) {
    console.warn("Failed to create notification:", e);
  }
}

// Notification type → message templates
function buildNoShowNotification(brotherName, meeting, count, fineAmount) {
  if (count === 1) {
    return {
      title: "1st No-Show — Warning",
      message: `Hey ${brotherName.split(" ")[0]}, you missed ${meeting.title} on ${fmtDate(meeting.date)}. This is your first no-show this quarter — heads up that the 2nd one is a $${fineAmount} fine. If you had an excuse you didn't submit, you can appeal from your dashboard.`,
      severity: "warning",
    };
  }
  if (count === 2) {
    return {
      title: `2nd No-Show — $${fineAmount} Fine`,
      message: `${brotherName.split(" ")[0]}, your 2nd no-show this quarter triggered a $${fineAmount} fine. Pay the treasurer before quarter end. If you had legitimate grounds, file an appeal from your dashboard within a reasonable window.`,
      severity: "danger",
    };
  }
  return {
    title: "3rd No-Show — Judicial Review",
    message: `${brotherName.split(" ")[0]}, this is your 3rd no-show this quarter. Per chapter bylaws (Article VI), the Sgt-at-Arms will be notified and may bring this to the judicial board. Reach out to him directly if you want to discuss.`,
    severity: "judicial",
  };
}

// Whether a notification is pending acknowledgment for current user
function pendingNotificationsFor(email) {
  if (!email) return [];
  return state.notifications
    .filter(n => n.recipientEmail === email.toLowerCase() && !n.acknowledgedAt)
    .sort((a, b) => {
      // High severity first, then oldest first
      const severityOrder = { judicial: 0, danger: 1, warning: 2, info: 3 };
      const sa = severityOrder[a.severity] ?? 4;
      const sb = severityOrder[b.severity] ?? 4;
      if (sa !== sb) return sa - sb;
      return (a.createdAt || 0) - (b.createdAt || 0);
    });
}

// Show pending notifications as full-screen stacked modals
let _displayingNotification = false;
async function showPendingNotifications() {
  if (_displayingNotification) return;
  if (!state.user || !state.user.email) return;

  const pending = pendingNotificationsFor(state.user.email);
  if (pending.length === 0) {
    $("notif-modal").classList.remove("visible");
    return;
  }

  _displayingNotification = true;
  const n = pending[0];
  const remaining = pending.length - 1;

  $("notif-modal").className = `modal visible notif-${n.severity || "info"}`;
  $("notif-title").textContent = n.title || "Notification";
  $("notif-message").textContent = n.message || "";
  $("notif-meta").textContent = n.createdAt
    ? `${relativeTime(n.createdAt)}${remaining > 0 ? ` • ${remaining} more after this` : ""}`
    : (remaining > 0 ? `${remaining} more after this` : "");

  // Severity-aware acknowledgment label
  const ackLabel = n.severity === "judicial" ? "I Understand"
                 : n.severity === "danger"   ? "I Acknowledge"
                 : n.type === "dispatch"     ? "Read it"
                 : "Got It";
  $("notif-ack").dataset.go = n.type === "dispatch" && n.relatedId ? n.relatedId : "";
  $("notif-ack").textContent = ackLabel;
  $("notif-ack").dataset.id = n.id;

  _displayingNotification = false;
}

// Update fine aura — body class toggle that activates the multi-color glow
function updateFineAura() {
  if (!state.user || !state.user.rosterEntry) {
    document.body.classList.remove("has-active-fine");
    return;
  }
  const target = state.user.rosterEntry;
  const hasActiveFine = state.fines.some(f =>
    f.brotherKey === target.key && f.status === "pending"
  );
  document.body.classList.toggle("has-active-fine", hasActiveFine);
}

function openAppealModal(noShowId) {
  const ns = state.noShows.find(n => n.id === noShowId);
  if (!ns) return;
  currentAppealNoShowId = noShowId;
  $("appeal-meeting-title").textContent = ns.meetingTitle || "Meeting";
  $("appeal-meeting-meta").textContent =
    `${fmtDateLong(ns.meetingDate || "")} • ${noShowReasonLabel(ns.reason)}`;
  $("appeal-reason").value = "";
  $("appeal-modal").classList.add("visible");
  setTimeout(() => $("appeal-reason").focus(), 100);
}

async function submitAppeal() {
  const reason = $("appeal-reason").value.trim();
  if (reason.length < 20) {
    return toast("Be specific in your appeal (20+ characters)", true);
  }
  if (!currentAppealNoShowId) return;
  const ns = state.noShows.find(n => n.id === currentAppealNoShowId);
  try {
    await noShows.appeal(currentAppealNoShowId, reason);
    $("appeal-modal").classList.remove("visible");
    toast("Appeal submitted — Sgt-at-Arms will review");

    // Notify Sgt-at-Arms
    if (ns) {
      const sgtEmail = state.settings.sgtAtArmsEmail || SGT_AT_ARMS_EMAIL;
      await notify(
        sgtEmail,
        "appeal_submitted",
        `Appeal submitted: ${ns.brotherName}`,
        `${ns.brotherName} appealed their no-show for ${ns.meetingTitle || "a meeting"} on ${fmtDate(ns.meetingDate || "")}. Reason given: "${reason}". Review in the Absence Requests tab.`,
        "warning",
        currentAppealNoShowId
      );
    }

    currentAppealNoShowId = null;
  } catch (e) {
    console.error(e);
    toast("Could not submit appeal", true);
  }
}

// ===================================================================
// MEETINGS TAB  (Stage 2 — exec creates, everyone views)
// ===================================================================
function countMandatoryThisQuarter(quarter) {
  return state.meetings.filter(m => m.mandatory && m.quarter === quarter).length;
}

// Tracks whether the form has been built for the current user role.
// Only re-builds when the role changes (exec vs not-exec), NOT on Firestore updates.
let _meetingsFormBuiltFor = null; // "exec" | "non-exec" | null

function renderMeetingsTab() {
  const wrap = $("meetings-content");
  if (!wrap) return;

  const isExec = !!(state.user && state.user.isExec);
  const formKey = isExec ? "exec" : "non-exec";

  // ----- Build form ONCE per role state (preserves user input across re-renders) -----
  if (_meetingsFormBuiltFor !== formKey) {
    wrap.innerHTML = `
      <div id="meetings-form-container"></div>
      <div id="meetings-list-container"></div>
    `;
    const formContainer = $("meetings-form-container");
    if (isExec) {
      formContainer.innerHTML = renderCreateMeetingFormShell();
      $("mtg-create")?.addEventListener("click", handleCreateMeeting);
      ["mtg-date", "mtg-start", "mtg-mandatory"].forEach(id => {
        $(id)?.addEventListener("input", updateLeadTimeHint);
        $(id)?.addEventListener("change", updateLeadTimeHint);
      });
      ["mtg-repeat", "mtg-until", "mtg-date"].forEach(id => {
        $(id)?.addEventListener("input", () => updateRepeatPreview(id === "mtg-repeat" || id === "mtg-date"));
        $(id)?.addEventListener("change", () => updateRepeatPreview(id === "mtg-repeat" || id === "mtg-date"));
      });
      defaultMeetingDate();
      updateLeadTimeHint();
    } else {
      formContainer.innerHTML = "";
    }
    _meetingsFormBuiltFor = formKey;
  }

  // ----- Update mandatory-cap warning WITHOUT wiping the form -----
  if (isExec) updateMandatoryCapHint();

  // ----- Re-render the meeting list freely (this is the safe-to-rebuild part) -----
  const upcoming = state.meetings.filter(m => !qrWindow(m).isPast).filter(inQuarter);
  const past     = state.meetings.filter(m => qrWindow(m).isPast).filter(inQuarter);
  const sortAsc  = (a, b) => qrWindow(a).start - qrWindow(b).start;
  const sortDesc = (a, b) => qrWindow(b).start - qrWindow(a).start;
  upcoming.sort(sortAsc);
  past.sort(sortDesc);

  const showPast = state.showPastMeetings;
  const visible = showPast ? past : upcoming;

  $("meetings-list-container").innerHTML = `
    <div class="card">
      <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 14px;">
        <div>
          <div class="card-title">${showPast ? "Past Meetings" : "Upcoming Meetings"}</div>
          <div class="card-sub">${formatQuarter(state.selectedQuarter)} &middot; ${visible.length} meeting${visible.length === 1 ? "" : "s"}</div>
        </div>
        <div style="display: flex; gap: 8px;">
          <button class="btn btn-ghost btn-small" id="meetings-toggle">
            ${showPast ? "Show Upcoming" : `Show Past (${past.length})`}
          </button>
        </div>
      </div>

      ${visible.length === 0
        ? `<div class="empty">${showPast ? "No past meetings in this quarter." : (isExec ? "No upcoming meetings — create one above." : "No upcoming meetings.")}</div>`
        : `<div class="event-list" style="display: flex; flex-direction: column; gap: 10px; margin-top: 14px;">
            ${visible.map(m => renderMeetingRow(m, isExec)).join("")}
          </div>`}
    </div>
  `;

  // Wire list buttons (these are inside the dynamic container so safe to re-bind)
  $("meetings-toggle")?.addEventListener("click", () => {
    state.showPastMeetings = !state.showPastMeetings;
    renderMeetingsTab();
  });

  const listWrap = $("meetings-list-container");
  listWrap.querySelectorAll("[data-qr]").forEach(b =>
    b.addEventListener("click", () => openQrModal(b.dataset.qr)));
  listWrap.querySelectorAll("[data-del]").forEach(b =>
    b.addEventListener("click", () => deleteMeeting(b.dataset.del)));
  listWrap.querySelectorAll("[data-roll]").forEach(b =>
    b.addEventListener("click", () => openRollSheet(b.dataset.roll)));
  listWrap.querySelectorAll("[data-process]").forEach(b =>
    b.addEventListener("click", () => manualProcessMeeting(b.dataset.process)));
}

// Form shell — built once. The mandatory-cap text is in a child element we
// update separately so the inputs are never destroyed mid-typing.
function renderCreateMeetingFormShell() {
  return `
    <div class="card exec-only">
      <div class="card-title">Create Meeting</div>
      <div class="card-sub">Secretary: schedule a chapter meeting</div>

      <div class="mtg-tip">
        <div class="mtg-tip-label">Scheduling Tip</div>
        <div class="mtg-tip-body">
          Create chapter meetings <strong>more than 48 hours in advance</strong>, and ideally <strong>2 weeks ahead</strong>.
          Brothers can only submit absence requests through the app up to 48 hours before a meeting, so scheduling
          early gives them time to plan and request an excuse. Mandatory meetings require 14 days' notice (Article VI §12).
        </div>
      </div>

      <div class="row-2">
        <div>
          <label for="mtg-title">Meeting Title</label>
          <input type="text" id="mtg-title" placeholder="Weekly Chapter Meeting" autocomplete="off">
        </div>
        <div>
          <label for="mtg-date">Date</label>
          <input type="date" id="mtg-date">
        </div>
      </div>

      <div class="row-3">
        <div>
          <label for="mtg-start">Start Time</label>
          <input type="time" id="mtg-start" value="19:00">
        </div>
        <div>
          <label for="mtg-end">End Time</label>
          <input type="time" id="mtg-end" value="20:00">
        </div>
        <div>
          <label for="mtg-window">QR Window <span style="font-weight: normal; color: var(--gold-ink); text-transform: none; letter-spacing: 0;">(min after start)</span></label>
          <input type="number" id="mtg-window" value="5" min="1" max="60">
        </div>
      </div>

      <div id="mtg-leadtime" class="mtg-leadtime" aria-live="polite"></div>

      <label for="mtg-location">Location</label>
      <input type="text" id="mtg-location" placeholder="Chapter house living room" autocomplete="off">

      <div class="row-2 mtg-repeat-row">
        <div>
          <label for="mtg-repeat">Repeat</label>
          <select id="mtg-repeat">
            <option value="0">Does not repeat</option>
            <option value="7">Every week</option>
            <option value="14">Every 2 weeks</option>
          </select>
        </div>
        <div id="mtg-until-wrap" hidden>
          <label for="mtg-until">Until</label>
          <input type="date" id="mtg-until">
        </div>
      </div>
      <div id="mtg-repeat-preview" class="mtg-repeat-preview" aria-live="polite" hidden></div>

      <div id="mtg-mandatory-row" style="display: flex; align-items: center; gap: 12px; margin-top: 18px; padding: 12px 14px; background: var(--light-gold); background-image: linear-gradient(color-mix(in srgb, var(--burgundy) 7%, transparent), color-mix(in srgb, var(--burgundy) 7%, transparent)); border-radius: 16px; border-radius: 14px;">
        <input type="checkbox" id="mtg-mandatory" style="width: auto; margin: 0;">
        <label for="mtg-mandatory" id="mtg-mandatory-label" style="margin: 0; cursor: pointer;">
          Mandatory Meeting
        </label>
        <span id="mtg-mandatory-hint" style="font-family: var(--font-body); font-size: 12px; font-style: italic; color: var(--gold-ink);"></span>
      </div>

      <button class="btn" id="mtg-create">Create Meeting</button>
    </div>
  `;
}

// Updates the mandatory-cap row in place (does NOT touch the inputs).
function updateMandatoryCapHint() {
  const todayQ = currentQuarter();
  const mandCount = countMandatoryThisQuarter(todayQ);
  const mandFull = mandCount >= 4;

  const row = $("mtg-mandatory-row");
  const cb = $("mtg-mandatory");
  const lbl = $("mtg-mandatory-label");
  const hint = $("mtg-mandatory-hint");
  if (!row || !cb || !lbl || !hint) return;

  if (mandFull) {
    cb.disabled = true;
    cb.checked = false;
    row.style.opacity = "0.7"; // cap reached: dimmed instead of a side bar
    lbl.style.cursor = "not-allowed";
    lbl.style.color = "var(--knight-steel)";
    hint.textContent = `Bylaws limit mandatory meetings to 4 per quarter. ${formatQuarter(todayQ)} already has 4.`;
  } else {
    cb.disabled = false;
    row.style.opacity = "";
    lbl.style.cursor = "pointer";
    lbl.style.color = "";
    const remaining = 4 - mandCount;
    hint.textContent = `${remaining} mandatory slot${remaining === 1 ? "" : "s"} remaining this quarter (Article VI §12)`;
  }
}

async function handleCreateMeeting() {
  if (!state.user || !state.user.isExec) return toast("Sign in as exec", true);

  const title     = $("mtg-title").value.trim();
  const date      = $("mtg-date").value;
  const startTime = $("mtg-start").value;
  const endTime   = $("mtg-end").value;
  const location  = $("mtg-location").value.trim();
  const mandatory = $("mtg-mandatory").checked;
  const qrWin     = Math.max(1, Math.min(60, Number($("mtg-window").value) || 5));

  const repeatDays = Number($("mtg-repeat")?.value || 0);
  if (repeatDays) {
    if (mandatory) return toast("Recurring meetings can't be mandatory. Create mandatory meetings one at a time.", true);
    if (!title)     return toast("Meeting title is required", true);
    if (!startTime || !endTime) return toast("Start and end time are required", true);
    return createMeetingSeries({ title, startTime, endTime, location, qrWin, repeatDays });
  }

  if (!title)     return toast("Meeting title is required", true);
  if (!date)      return toast("Date is required", true);
  if (!startTime) return toast("Start time is required", true);
  if (!endTime)   return toast("End time is required", true);

  // Validate that end is after start
  const startDt = combineLocalDateTime(date, startTime);
  const endDt   = combineLocalDateTime(date, endTime);
  if (endDt.getTime() <= startDt.getTime()) {
    return toast("End time must be after start time", true);
  }

  // Compute the meeting's quarter from its date
  const [yr, mo, dy] = date.split("-").map(Number);
  const meetingQuarter = (() => {
    const m = mo - 1;
    if (m <= 2)  return `${yr}-winter`;
    if (m <= 5)  return `${yr}-spring`;
    if (m <= 7)  return `${yr}-summer`;
    return `${yr}-fall`;
  })();

  // Short-notice check: under 48 hours means brothers can't use the app to
  // request an absence. (Mandatory meetings get the stricter 14-day check below.)
  const hoursOut = (startDt.getTime() - Date.now()) / 3600000;
  if (!mandatory && hoursOut < 48) {
    const ok = confirm(
      `This meeting is less than 48 hours away, so brothers won't be able to submit ` +
      `absence requests through the app. They'll need to contact the secretary directly. ` +
      `Create anyway?`
    );
    if (!ok) return;
  }

  // Bylaw cap re-check for the quarter the meeting falls in (not just current)
  if (mandatory) {
    const inQuarterMandCount = state.meetings.filter(m => m.mandatory && m.quarter === meetingQuarter).length;
    if (inQuarterMandCount >= 4) {
      return toast(`${formatQuarter(meetingQuarter)} already has 4 mandatory meetings (bylaws cap)`, true);
    }

    // 14-day notice warning per Article VI §12
    const daysOut = (startDt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    if (daysOut < 14) {
      const ok = confirm(
        `Bylaws require 14 days advance notice for mandatory meetings (Article VI §12). ` +
        `This meeting is only ${Math.round(daysOut)} day${Math.round(daysOut) === 1 ? "" : "s"} out. ` +
        `Create anyway?`
      );
      if (!ok) return;
    }
  }

  try {
    const meetingRef = await meetings.create({
      title, date, startTime, endTime, location,
      mandatory, qrWindowMinutes: qrWin,
    });
    $("mtg-title").value = "";
    $("mtg-location").value = "";
    $("mtg-mandatory").checked = false;
    updateLeadTimeHint();
    toast("Meeting created");

    // If mandatory, notify the entire chapter (all eligible brothers)
    if (mandatory) {
      const eligible = state.roster.filter(brotherIsEligible);
      const meetingId = meetingRef; // meetings.create returns the ID directly
      const startTimeFmt = fmtTime(startTime);
      let notifSent = 0;
      for (const b of eligible) {
        if (!b.email) continue;
        try {
          await notify(
            b.email,
            "mandatory_meeting",
            `⚑ Mandatory Meeting: ${title}`,
            `Per Article VI §12, a MANDATORY meeting has been scheduled: ${title} on ${fmtDateLong(date)} at ${startTimeFmt}${location ? ` (${location})` : ""}. Attendance is required. If you can't attend, submit an absence request immediately — but exec verbal approval is required for mandatory meetings.`,
            "warning",
            typeof meetingId === "string" ? meetingId : null
          );
          notifSent++;
        } catch (e) {
          console.warn("Mandatory notif failed for", b.email, e);
        }
      }
      if (notifSent > 0) {
        toast(`Meeting created • ${notifSent} brothers notified`);
      }
    }
  } catch (e) {
    console.error(e);
    toast("Permission denied — exec sign-in required", true);
  }
}

function renderMeetingRow(m, isExec) {
  const w = qrWindow(m);
  const attendees = state.attendance.filter(a => a.meetingId === m.id);
  const isOpen   = w.isOpen;
  const isPast   = w.isPast;
  const isFuture = w.isFuture;

  let timingBadge;
  if (isOpen) {
    timingBadge = `<span style="background: var(--crimson); color: white; padding: 2px 8px; font-family: var(--font-ui); font-size: 10px; font-weight: 600; letter-spacing: 1px; border-radius: 14px;">QR OPEN — closes ${relativeTime(w.closes)}</span>`;
  } else if (isFuture) {
    timingBadge = `<span style="background: var(--khaki); color: var(--burgundy); padding: 2px 8px; font-family: var(--font-ui); font-size: 10px; font-weight: 600; letter-spacing: 1px; border-radius: 14px;">${relativeTime(w.start).toUpperCase()}</span>`;
  } else {
    timingBadge = `<span style="background: var(--knight-steel); color: white; padding: 2px 8px; font-family: var(--font-ui); font-size: 10px; font-weight: 600; letter-spacing: 1px; border-radius: 14px;">PAST</span>`;
  }

  return `
    <div class="event-row" style="display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; background: white; border: 1px solid rgba(170,151,103,0.3); border-radius: 14px; ${m.mandatory ? "background-image: linear-gradient(color-mix(in srgb, var(--burgundy) 7%, transparent), color-mix(in srgb, var(--burgundy) 7%, transparent)); border-radius: 16px;" : ""} gap: 12px; flex-wrap: wrap;">
      <div style="flex: 1; min-width: 220px;">
        <div style="font-family: var(--font-display); font-size: 18px; font-weight: 600; color: var(--garnet);">
          ${escapeHtml(m.title)} ${m.mandatory ? `<span style="font-family: var(--font-ui); font-size: 9px; letter-spacing: 1.5px; color: var(--burgundy); margin-left: 6px;">⚑ MANDATORY</span>` : ""}${m.seriesId ? `<span class="mtg-series-tag" title="Part of a recurring series">↻ ${m.repeatDays === 14 ? "Every 2 weeks" : "Weekly"}</span>` : ""}
        </div>
        <div style="font-family: var(--font-ui); font-size: 11px; color: var(--slate); letter-spacing: 1px; margin-top: 4px;">
          ${escapeHtml(fmtDate(m.date))} &middot; ${fmtTime(m.startTime)}–${fmtTime(m.endTime)}${m.location ? " &middot; " + escapeHtml(m.location) : ""}
        </div>
        <div style="margin-top: 6px;">
          ${timingBadge}
        </div>
      </div>
      <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
        <span style="background: var(--garnet); color: white; padding: 6px 12px; font-family: var(--font-ui); font-size: 11px; font-weight: 600; letter-spacing: 1px; border-radius: 14px;">
          ${attendees.length} present
        </span>
        <button class="btn btn-ghost btn-small" data-qr="${m.id}">QR</button>
        ${isExec ? `<button class="btn btn-ghost btn-small" data-roll="${m.id}">Roll</button>` : ""}
        ${isExec && isPast ? `<button class="btn btn-ghost btn-small" data-process="${m.id}">Process</button>` : ""}
        ${isExec ? `<button class="btn btn-danger btn-small" data-del="${m.id}">Delete</button>` : ""}
      </div>
    </div>
  `;
}

async function deleteMeeting(id) {
  const m = state.meetings.find(x => x.id === id);
  if (!m) return;
  const attCount = state.attendance.filter(a => a.meetingId === id).length;
  const reqCount = state.absenceRequests.filter(r => r.meetingId === id).length;
  const nsCount  = state.noShows.filter(n => n.meetingId === id).length;
  const fnCount  = state.fines.filter(f => f.meetingId === id).length;

  const parts = [];
  if (attCount) parts.push(`${attCount} attendance record${attCount === 1 ? "" : "s"}`);
  if (reqCount) parts.push(`${reqCount} absence request${reqCount === 1 ? "" : "s"}`);
  if (nsCount)  parts.push(`${nsCount} no-show record${nsCount === 1 ? "" : "s"}`);
  if (fnCount)  parts.push(`${fnCount} fine record${fnCount === 1 ? "" : "s"}`);

  const msg = parts.length === 0
    ? `Delete "${m.title}"?`
    : `Delete "${m.title}" and ALL associated data?\n\nThis will also remove:\n• ${parts.join("\n• ")}\n\nThis cannot be undone.`;

  if (!confirm(msg)) return;
  // Part of a recurring series? Offer to cancel the later ones too.
  const later = m.seriesId
    ? state.meetings.filter(x => x.seriesId === m.seriesId && x.id !== id && x.date > m.date).sort((a, b) => a.date.localeCompare(b.date))
    : [];
  const alsoLater = later.length > 0 && confirm(
    `"${m.title}" repeats. Also delete the ${later.length} later meeting${later.length === 1 ? "" : "s"} in this series ` +
    `(${fmtDateShort(later[0].date)}${later.length > 1 ? " to " + fmtDateShort(later[later.length - 1].date) : ""})?\n\n` +
    `OK deletes them too. Cancel deletes only this one.`
  );
  try {
    await meetings.remove(id);
    if (alsoLater) {
      for (const x of later) await meetings.remove(x.id);
      toast(`Deleted ${later.length + 1} meetings in the series`);
      return;
    }
    toast("Meeting and associated data deleted");
  } catch (e) {
    console.error(e);
    toast("Delete failed — check console", true);
  }
}

function openRollSheet(meetingId) {
  const m = state.meetings.find(x => x.id === meetingId);
  if (!m) return;
  const attendees = state.attendance.filter(a => a.meetingId === meetingId);
  const presentKeys = new Set(attendees.map(a => a.brotherKey));
  const eligible = state.roster.filter(b => b.status === "Active" || b.status === "New Member");

  const present = eligible.filter(b => presentKeys.has(b.key));
  const absent  = eligible.filter(b => !presentKeys.has(b.key));

  const sheet = $("roll-sheet-modal");
  $("roll-sheet-title").textContent = m.title;
  $("roll-sheet-meta").textContent =
    `${fmtDateLong(m.date)} • ${fmtTime(m.startTime)}–${fmtTime(m.endTime)} • ${present.length} present, ${absent.length} not yet`;

  $("roll-sheet-present").innerHTML = present.length
    ? present.map(b => `<div style="padding: 8px 14px; border-bottom: 1px solid var(--light-gold); font-family: var(--font-body); font-size: 13px; display: flex; justify-content: space-between;">
        <span>${escapeHtml(b.firstName + " " + b.lastName)}</span>
        <span style="font-family: var(--font-ui); font-size: 9px; letter-spacing: 1px; text-transform: uppercase; color: var(--garnet); font-weight: 600;">PRESENT</span>
      </div>`).join("")
    : `<div style="padding: 12px; font-family: var(--font-body); font-style: italic; color: var(--gold-ink);">No one has marked themselves present yet.</div>`;

  $("roll-sheet-absent").innerHTML = absent.length
    ? absent.map(b => `<div style="padding: 8px 14px; border-bottom: 1px solid var(--light-gold); font-family: var(--font-body); font-size: 13px; display: flex; justify-content: space-between;">
        <span>${escapeHtml(b.firstName + " " + b.lastName)}</span>
        <span style="font-family: var(--font-ui); font-size: 9px; letter-spacing: 1px; text-transform: uppercase; color: var(--memphis-brick);">${b.status === "New Member" ? "NM" : ""} ${qrWindow(m).isPast ? "ABSENT" : "—"}</span>
      </div>`).join("")
    : `<div style="padding: 12px; font-family: var(--font-body); font-style: italic; color: var(--gold-ink);">Everyone eligible has marked present.</div>`;

  sheet.classList.add("visible");
}

// ===================================================================
// PIKE QR: one crisp code with a proper quiet zone, a printable poster
// for Download, and a full-screen Present mode for projecting.
// ===================================================================
let _qrPresentTimer = null;

// Brand mark for the center of QR codes (preloaded once)
const _qrMark = new Image();
_qrMark.src = "assets/brand/symbol-gold.png";

// Branded QR: rounded finder "eyes", soft rounded-square modules, PIKE symbol badge in the center,
// white quiet zone. High error correction (H) keeps it scannable with the badge.
function pikeQrCanvas(text, px) {
  const tmp = document.createElement("div");
  const qr = new QRCode(tmp, { text, width: 64, height: 64, colorDark: "#000", colorLight: "#fff", correctLevel: QRCode.CorrectLevel.H });
  const model = qr._oQRCode;
  const N = model.getModuleCount();
  const m = Math.max(1, Math.floor(px / N));   // whole-pixel modules: crisp edges, no resampling seams
  px = m * N;
  const quiet = m * 4;                           // standard 4-module quiet zone
  const c = document.createElement("canvas");
  c.width = c.height = px + quiet * 2;
  const g = c.getContext("2d");
  g.fillStyle = "#ffffff"; g.fillRect(0, 0, c.width, c.height);
  const FG = "#79242F";
  const inFinder = (r, col) => (r < 7 && col < 7) || (r < 7 && col >= N - 7) || (r >= N - 7 && col < 7);
  // Center badge area (skip dots underneath)
  const badge = Math.round(N * 0.22) | 1;
  const b0 = Math.floor((N - badge) / 2), b1 = b0 + badge;
  const inBadge = (r, col) => r >= b0 && r < b1 && col >= b0 && col < b1;
  g.fillStyle = FG;
  for (let r = 0; r < N; r++) for (let col = 0; col < N; col++) {
    if (!model.isDark(r, col) || inFinder(r, col) || inBadge(r, col)) continue;
    // Soft rounded-square modules: rounded look, and they scan reliably at every size (round dots don't)
    const s = m;
    pikeRoundRect(g, quiet + (col + 0.5) * m - s / 2, quiet + (r + 0.5) * m - s / 2, s, s, s * 0.28); g.fill();
  }
  const eye = (r, col) => {
    const x = quiet + col * m, y = quiet + r * m;
    g.fillStyle = FG;      pikeRoundRect(g, x, y, 7 * m, 7 * m, 1.9 * m); g.fill();
    g.fillStyle = "#fff";  pikeRoundRect(g, x + m, y + m, 5 * m, 5 * m, 1.3 * m); g.fill();
    g.fillStyle = FG;      pikeRoundRect(g, x + 2 * m, y + 2 * m, 3 * m, 3 * m, 0.9 * m); g.fill();
  };
  eye(0, 0); eye(0, N - 7); eye(N - 7, 0);
  // Badge: white rounded square, thin gold ring, PIKE symbol
  const bx = quiet + b0 * m, bs = badge * m;
  g.fillStyle = "#ffffff"; pikeRoundRect(g, bx + m * 0.2, bx + m * 0.2, bs - m * 0.4, bs - m * 0.4, bs * 0.28); g.fill();
  g.strokeStyle = "#AA9767"; g.lineWidth = Math.max(1, m * 0.25); g.stroke();
  if (_qrMark.complete && _qrMark.naturalWidth) {
    const h = bs * 0.66, w = h * (_qrMark.naturalWidth / _qrMark.naturalHeight);
    g.drawImage(_qrMark, bx + (bs - w) / 2, bx + (bs - h) / 2, w, h);
  }
  return c;
}

function pikeRoundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

function pikeLoadImg(src) {
  return new Promise(res => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; });
}

// Printable 1200x1650 poster: PIKE header, title, details, big QR, instructions
async function pikeQrPoster(url, title, meta, instruction) {
  try { await Promise.all([document.fonts.load('600 72px "Cormorant Garamond"'), document.fonts.load('600 30px "Gantari"'), document.fonts.load('500 30px "Gantari"')]); } catch (e) {}
  const W = 1200, H = 1650, c = document.createElement("canvas"); c.width = W; c.height = H;
  const g = c.getContext("2d");
  g.fillStyle = "#F6EFE1"; g.fillRect(0, 0, W, H);
  const hdr = g.createLinearGradient(0, 0, W, 220); hdr.addColorStop(0, "#79242F"); hdr.addColorStop(1, "#572A31");
  g.fillStyle = hdr; g.fillRect(0, 0, W, 220);
  g.textAlign = "center";
  const wm = await pikeLoadImg("assets/brand/wordmark-reversed-lg.png");
  if (wm) { const ww = 380, wh = ww * wm.naturalHeight / wm.naturalWidth; g.drawImage(wm, (W - ww) / 2, 26, ww, wh); }
  else { g.fillStyle = "#AA9767"; g.font = '600 96px "Cormorant Garamond", Georgia, serif'; g.fillText("PIKE", W / 2, 118); }
  g.fillStyle = "rgba(255,255,255,0.8)"; g.font = '600 22px "Gantari", Arial, sans-serif';
  g.fillText("I O T A   P I   ·   U C L A", W / 2, 200);
  let size = 78; g.font = `600 ${size}px "Cormorant Garamond", Georgia, serif`;
  while (g.measureText(title).width > W - 140 && size > 40) { size -= 4; g.font = `600 ${size}px "Cormorant Garamond", Georgia, serif`; }
  g.fillStyle = "#79242F"; g.fillText(title, W / 2, 330);
  g.fillStyle = "#323E48"; g.font = '500 32px "Gantari", Arial, sans-serif'; g.fillText(meta, W / 2, 390);
  g.save(); g.shadowColor = "rgba(87,42,49,0.18)"; g.shadowBlur = 40; g.shadowOffsetY = 14;
  pikeRoundRect(g, 170, 450, 860, 860, 48); g.fillStyle = "#ffffff"; g.fill(); g.restore();
  g.imageSmoothingEnabled = false; g.drawImage(pikeQrCanvas(url, 700), 200, 480, 800, 800);
  g.fillStyle = "#323E48"; g.font = '600 36px "Gantari", Arial, sans-serif'; g.fillText(instruction, W / 2, 1410);
  g.fillStyle = "#72633E"; g.font = '500 26px "Gantari", Arial, sans-serif'; g.fillText("Open your phone camera and point it at the code.", W / 2, 1462);
  const sym = await pikeLoadImg("assets/brand/symbol-gold.png");
  if (sym) { const sh = 70, sw = sh * sym.naturalWidth / sym.naturalHeight; g.drawImage(sym, (W - sw) / 2, 1520, sw, sh); }
  return c;
}

// Draw the code into the modal (one canvas, no duplicates) and prep the poster
function pikeRenderQrModal(holder, url, title, meta, instruction) {
  holder.innerHTML = "";
  // Draw at the exact on-screen size for this screen's pixel density, so it is never resampled
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const cssW = Math.min(300, (holder.clientWidth || 300));
  const code = pikeQrCanvas(url, Math.round(cssW * dpr));
  code.className = "pike-qr-code";
  code.style.width = (code.width / dpr) + "px";   // 1 canvas pixel = 1 device pixel
  code.setAttribute("role", "img");
  code.setAttribute("aria-label", "QR code for " + title);
  holder.appendChild(code);
  currentQrCanvas = code;                       // fallback until the poster is ready
  pikeQrPoster(url, title, meta, instruction).then(p => { currentQrCanvas = p; }).catch(() => {});
}

// Full-screen Present mode for projecting at chapter
function pikeQrPresent(url, title, meta, statusFn) {
  pikeQrClosePresent();
  const el = document.createElement("div");
  el.id = "qr-present"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "QR code, presentation mode");
  el.innerHTML = `
    <button class="qp-close" type="button" aria-label="Exit presentation">&times;</button>
    <img class="qp-logo" src="assets/brand/wordmark-reversed.png" alt="PIKE">
    <div class="qp-title"></div>
    <div class="qp-meta"></div>
    <div class="qp-code"></div>
    <div class="qp-status"></div>
    <div class="qp-hint">Open your phone camera and point it at the code</div>`;
  el.querySelector(".qp-title").textContent = title;
  el.querySelector(".qp-meta").textContent = meta;
  el.querySelector(".qp-code").appendChild(pikeQrCanvas(url, 900));
  document.body.appendChild(el);
  const tick = () => { const s = statusFn ? statusFn() : ""; el.querySelector(".qp-status").textContent = s; el.querySelector(".qp-status").hidden = !s; };
  tick(); _qrPresentTimer = setInterval(tick, 15000);
  el.querySelector(".qp-close").addEventListener("click", pikeQrClosePresent);
  document.addEventListener("keydown", pikeQrEsc);
  try { if (el.requestFullscreen) el.requestFullscreen().catch(() => {}); } catch (e) {}
}
function pikeQrEsc(e) { if (e.key === "Escape") pikeQrClosePresent(); }
function pikeQrClosePresent() {
  const el = document.getElementById("qr-present");
  if (_qrPresentTimer) { clearInterval(_qrPresentTimer); _qrPresentTimer = null; }
  document.removeEventListener("keydown", pikeQrEsc);
  try { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); } catch (e) {}
  if (el) el.remove();
}

// ===================================================================
// QR CODE MODAL
// ===================================================================
function renderQr(meetingId) {
  const m = state.meetings.find(x => x.id === meetingId);
  const url = window.location.origin + window.location.pathname + "#meeting=" + meetingId;
  const meta = m ? `${fmtDateLong(m.date)} · ${fmtTime(m.startTime)}${m.location ? " · " + m.location : ""}` : "";
  pikeRenderQrModal($("qr-holder"), url, m ? m.title : "Chapter Meeting", meta, "Scan to mark yourself present");
}

function openQrModal(meetingId) {
  const m = state.meetings.find(x => x.id === meetingId);
  if (!m) return;
  currentQrMeeting = m;
  $("qr-meeting-title").textContent = m.title;
  $("qr-meeting-meta").textContent =
    `${fmtDateLong(m.date)} • ${fmtTime(m.startTime)} • ${m.location || ""}`;
  renderQr(meetingId);
  $("qr-modal").classList.add("visible");
}

$("qr-modal-close").addEventListener("click", () => $("qr-modal").classList.remove("visible"));
$("qr-modal").addEventListener("click", e => {
  if (e.target === $("qr-modal")) $("qr-modal").classList.remove("visible");
});
$("qr-download").addEventListener("click", () => {
  if (!currentQrCanvas || !currentQrMeeting) return;
  const a = document.createElement("a");
  a.href = currentQrCanvas.tagName === "CANVAS" ? currentQrCanvas.toDataURL("image/png") : currentQrCanvas.src;
  a.download = `pike-meeting-qr-${currentQrMeeting.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png`;
  a.click();
  toast("QR downloaded");
});
$("qr-present-btn").addEventListener("click", () => {
  if (!currentQrMeeting) return;
  const m = currentQrMeeting;
  const url = window.location.origin + window.location.pathname + "#meeting=" + m.id;
  const meta = `${fmtDateLong(m.date)} · ${fmtTime(m.startTime)}${m.location ? " · " + m.location : ""}`;
  pikeQrPresent(url, m.title, meta, () => {
    const w = qrWindow(m);
    if (w.isOpen) return "Roll call open · closes " + relativeTime(w.closes);
    if (w.isFuture) return "Roll call opens " + relativeTime(w.opens);
    return "Roll call closed";
  });
});
$("qr-copy-url").addEventListener("click", async () => {
  if (!currentQrMeeting) return;
  const url = window.location.origin + window.location.pathname + "#meeting=" + currentQrMeeting.id;
  try { await navigator.clipboard.writeText(url); toast("URL copied"); }
  catch { toast("Copy failed", true); }
});

// Roll Sheet modal close
$("roll-sheet-close").addEventListener("click", () => $("roll-sheet-modal").classList.remove("visible"));
$("roll-sheet-modal").addEventListener("click", e => {
  if (e.target === $("roll-sheet-modal")) $("roll-sheet-modal").classList.remove("visible");
});

// Appeal modal handlers (Stage 4)
$("appeal-modal-close").addEventListener("click", () => $("appeal-modal").classList.remove("visible"));
$("appeal-cancel").addEventListener("click", () => $("appeal-modal").classList.remove("visible"));
$("appeal-modal").addEventListener("click", e => {
  if (e.target === $("appeal-modal")) $("appeal-modal").classList.remove("visible");
});
$("appeal-submit").addEventListener("click", submitAppeal);

// Notification modal handler (Stage 5B) — acknowledge and show next
$("notif-ack").addEventListener("click", async () => {
  const id = $("notif-ack").dataset.id;
  if (!id) return;
  // Mark it read locally first, then move straight to the next pending notice
  // (or close). Hiding the modal after the save used to swallow the next notice.
  const go = $("notif-ack").dataset.go;
  if (go) {   // Chapter Update notice: open that update
    try { state.dispatchView = go; activateTab("dispatch"); renderDispatchSafe(); markUpdatesRead(go); window.scrollTo({ top: 0 }); } catch (e) {}
  }
  const n = state.notifications.find(x => x.id === id);
  const prev = n ? n.acknowledgedAt : null;
  if (n) n.acknowledgedAt = Date.now();
  $("notif-ack").dataset.id = "";
  showPendingNotifications();
  try {
    await notifications.acknowledge(id);
  } catch (e) {
    console.error(e);
    if (n) n.acknowledgedAt = prev;
    showPendingNotifications();
    toast("Could not acknowledge", true);
  }
});

// ===================================================================
// URL HASH ROUTING (#meeting=ID auto-opens Roll Call after QR scan)
// ===================================================================
function readHash() {
  const m = window.location.hash.match(/meeting=([\w-]+)/);
  return m ? m[1] : null;
}
window.addEventListener("hashchange", () => {
  const id = readHash();
  if (id) {
    activateTab("rollcall");
    const meeting = state.meetings.find(x => x.id === id);
    if (meeting) {
      state.selectedQuarter = meeting.quarter;
      document.querySelectorAll(".quarter-select").forEach(s => s.value = meeting.quarter);
      renderAll();
    }
  }
});

// ===================================================================
// ABSENCE / REPORTS placeholders (Stages 3-5)
// ===================================================================
// ===================================================================
// ABSENCE REQUESTS  (Stage 3)
// ===================================================================
//
// Same "stable form, dynamic list" pattern as the Meetings tab — the
// brother's submit form is built once per role state and never wiped,
// so typing isn't lost when other Firestore data updates.
//
// Approver queue (cards) and "my requests" list re-render freely.
// ===================================================================

let _absenceFormBuiltFor = null;

const REASON_LABELS = {
  academic: "Academic (midterm, exam, paper)",
  family:   "Family (event, emergency)",
  medical:  "Medical (appointment, illness)",
  work:     "Work (shift conflict)",
  other:    "Other",
};

// Returns hours between now and a meeting's start time (negative if past)
function hoursUntilMeeting(meeting) {
  const w = qrWindow(meeting);
  if (!w.start) return -Infinity;
  return (w.start.getTime() - Date.now()) / (60 * 60 * 1000);
}

// Meetings eligible for an absence request: in the future AND >48hr away
function eligibleMeetings() {
  return state.meetings
    .filter(m => hoursUntilMeeting(m) > 48)
    .sort((a, b) => qrWindow(a).start - qrWindow(b).start);
}

// Meetings within 48 hours (not eligible — too late to request)
function tooSoonMeetings() {
  return state.meetings
    .filter(m => {
      const h = hoursUntilMeeting(m);
      return h > 0 && h <= 48;
    })
    .sort((a, b) => qrWindow(a).start - qrWindow(b).start);
}

function renderAbsenceTab() {
  const wrap = $("absence-content");
  if (!wrap) return;

  const isApprover = !!(state.user && state.user.isApprover);
  const isSgt = !!(state.user && state.user.isSgt);
  const isBrother = !!(state.user && state.user.rosterEntry);
  const formKey = `${isApprover ? "approver" : "x"}|${isSgt ? "sgt" : "x"}|${isBrother ? "brother" : "x"}|${state.user?.email || "guest"}`;

  if (_absenceFormBuiltFor !== formKey) {
    wrap.innerHTML = `
      ${isSgt ? `<div id="appeals-queue-container"></div>` : ""}
      ${isApprover ? `<div id="approver-queue-container"></div>` : ""}
      ${isBrother ? renderAbsenceFormShell() : ""}
      <div id="my-requests-container"></div>
      ${!isBrother && !isApprover && !isSgt ? renderAbsenceGuestState() : ""}
    `;

    if (isBrother) {
      $("abs-submit")?.addEventListener("click", handleSubmitAbsenceRequest);
      $("abs-meeting")?.addEventListener("change", updateAbsenceFormGuards);
    }

    _absenceFormBuiltFor = formKey;
  }

  // ----- Update dynamic portions (these can re-render freely) -----
  if (isBrother) {
    updateAbsenceMeetingDropdown();
    updateAbsenceFormGuards();
    renderMyRequestsList();
  }
  if (isApprover) {
    renderApproverQueue();
  }
  if (isSgt) {
    renderAppealsQueue();
  }
}

function renderAbsenceGuestState() {
  return `
    <div class="card">
      <div class="empty-coming-soon">
        <h3>Sign in to submit absence requests</h3>
        <p style="margin-top: 12px;">
          Use your Gmail address (must match what's on the chapter roster).
          Approvers and exec officers will see the review queue here.
        </p>
      </div>
    </div>`;
}

// ----- Brother: submit form (built once, inputs preserved) -----
function renderAbsenceFormShell() {
  return `
    <div class="card">
      <div class="card-title">Request an Absence</div>
      <div class="card-sub">Submit at least 48 hours before the meeting</div>

      <label for="abs-meeting">Which Meeting</label>
      <select id="abs-meeting"></select>
      <div id="abs-too-soon-hint" style="display: none;"></div>

      <div id="abs-form-body">
        <label for="abs-reason">Reason</label>
        <select id="abs-reason">
          <option value="academic">${REASON_LABELS.academic}</option>
          <option value="family">${REASON_LABELS.family}</option>
          <option value="medical">${REASON_LABELS.medical}</option>
          <option value="work">${REASON_LABELS.work}</option>
          <option value="other">${REASON_LABELS.other}</option>
        </select>

        <label for="abs-description">
          Details
          <span style="font-weight: normal; text-transform: none; letter-spacing: 0; color: var(--gold-ink); font-style: italic; margin-left: 6px;">
            (be specific — at least one full sentence)
          </span>
        </label>
        <textarea id="abs-description" rows="4" placeholder="Example: I have a CS35L midterm from 7-9pm Tuesday in Boelter Hall. The professor confirmed makeups aren't allowed." autocomplete="off"></textarea>
        <div class="help" style="margin-top: 4px;">
          Have written proof? Email it directly to the secretary.
        </div>

        <div id="abs-mandatory-warning" style="display: none;"></div>

        <button class="btn" id="abs-submit">Submit Request</button>
      </div>

      <div id="abs-too-soon-message" style="display: none;"></div>
    </div>
  `;
}

function updateAbsenceMeetingDropdown() {
  const sel = $("abs-meeting");
  if (!sel) return;

  const eligible = eligibleMeetings();
  const previousValue = sel.value;

  if (eligible.length === 0) {
    sel.innerHTML = `<option value="">No upcoming meetings &gt;48 hours away</option>`;
    sel.disabled = true;
  } else {
    sel.disabled = false;
    sel.innerHTML = eligible.map(m => {
      const hrs = Math.round(hoursUntilMeeting(m));
      const days = Math.round(hrs / 24);
      const when = hrs < 48 ? `${hrs}hr away`
                  : days < 7 ? `${days} day${days === 1 ? "" : "s"} away`
                  : `${fmtDate(m.date)}`;
      const mand = m.mandatory ? " ⚑ MANDATORY" : "";
      return `<option value="${m.id}">${escapeHtml(m.title)} — ${when}${mand}</option>`;
    }).join("");

    // Preserve user's selection across re-renders if still valid
    if (previousValue && eligible.some(m => m.id === previousValue)) {
      sel.value = previousValue;
    }
  }

  // Show "too soon" hint if applicable
  const tooSoon = tooSoonMeetings();
  const hint = $("abs-too-soon-hint");
  if (hint) {
    if (tooSoon.length > 0) {
      const secEmail = state.settings.secretaryEmail || SECRETARY_EMAIL;
      hint.style.display = "block";
      hint.style.cssText = "margin-top: 8px; padding: 10px 14px; background: var(--khaki); background-image: linear-gradient(color-mix(in srgb, var(--burgundy) 7%, transparent), color-mix(in srgb, var(--burgundy) 7%, transparent)); border-radius: 16px; font-family: var(--font-body); font-size: 12px; font-style: italic;";
      const list = tooSoon.map(m => `<strong>${escapeHtml(m.title)}</strong> (${fmtDate(m.date)} at ${fmtTime(m.startTime)})`).join(", ");
      hint.innerHTML = `${tooSoon.length} meeting${tooSoon.length === 1 ? " is" : "s are"} less than 48 hours away (${list}). For those, contact the secretary directly: <a href="mailto:${secEmail}" style="color: var(--garnet); font-weight: 600;">${secEmail}</a>`;
    } else {
      hint.style.display = "none";
    }
  }
}

function updateAbsenceFormGuards() {
  const sel = $("abs-meeting");
  const formBody = $("abs-form-body");
  const tooSoonMsg = $("abs-too-soon-message");
  const mandWarn = $("abs-mandatory-warning");
  if (!sel || !formBody || !tooSoonMsg || !mandWarn) return;

  const meetingId = sel.value;
  const meeting = state.meetings.find(m => m.id === meetingId);
  const eligible = eligibleMeetings();

  // Edge case: no eligible meetings at all
  if (eligible.length === 0) {
    formBody.style.display = "none";
    const secEmail = state.settings.secretaryEmail || SECRETARY_EMAIL;
    tooSoonMsg.style.display = "block";
    tooSoonMsg.style.cssText = "display: block; margin-top: 18px; padding: 18px; background: var(--khaki); background-image: linear-gradient(color-mix(in srgb, var(--burgundy) 7%, transparent), color-mix(in srgb, var(--burgundy) 7%, transparent)); border-radius: 16px;";
    tooSoonMsg.innerHTML = `
      <div style="font-family: var(--font-display); font-size: 18px; color: var(--burgundy); font-weight: 600;">
        No meetings eligible for absence requests
      </div>
      <div style="font-family: var(--font-body); font-size: 14px; line-height: 1.6; margin-top: 8px;">
        All upcoming meetings are within 48 hours, or none are scheduled. For urgent excused absences, contact the secretary directly:
        <a href="mailto:${secEmail}" style="color: var(--garnet); font-weight: 600;">${secEmail}</a>
      </div>`;
    return;
  }

  formBody.style.display = "";
  tooSoonMsg.style.display = "none";

  // Mandatory warning
  if (meeting && meeting.mandatory) {
    mandWarn.style.display = "block";
    mandWarn.style.cssText = "display: block; margin-top: 14px; padding: 12px 14px; background: var(--light-gold); background-image: linear-gradient(color-mix(in srgb, var(--burgundy) 7%, transparent), color-mix(in srgb, var(--burgundy) 7%, transparent)); border-radius: 16px; font-family: var(--font-body); font-size: 13px; line-height: 1.5;";
    mandWarn.innerHTML = `
      <strong style="color: var(--burgundy);">⚑ This is a mandatory meeting.</strong>
      Bylaws require attendance unless explicitly excused by exec. You can submit, but it'll likely be denied unless you've already gotten verbal approval from a President / IVP / Secretary.`;
  } else {
    mandWarn.style.display = "none";
  }
}

async function handleSubmitAbsenceRequest() {
  if (!state.user || !state.user.rosterEntry) {
    return toast("You need to be in the chapter roster to submit", true);
  }

  const meetingId   = $("abs-meeting").value;
  const reason      = $("abs-reason").value;
  const description = $("abs-description").value.trim();

  if (!meetingId)  return toast("Pick a meeting", true);
  if (!reason)     return toast("Pick a reason", true);
  if (description.length < 20) return toast("Be more specific in the description (20+ characters)", true);

  const meeting = state.meetings.find(m => m.id === meetingId);
  if (!meeting) return toast("Meeting not found — refresh", true);
  if (hoursUntilMeeting(meeting) <= 48) {
    const secEmail = state.settings.secretaryEmail || SECRETARY_EMAIL;
    return toast(`Less than 48hr away — contact ${secEmail} directly`, true);
  }

  // Check for duplicate (same brother, same meeting, still pending or approved)
  const target = state.user.rosterEntry;
  const existing = state.absenceRequests.find(r =>
    r.meetingId === meetingId &&
    r.brotherKey === target.key &&
    (r.status === "pending" || r.status === "approved")
  );
  if (existing) {
    return toast("You already have a request for this meeting", true);
  }

  try {
    await absenceRequests.submit({
      meetingId,
      brotherKey: target.key,
      brotherName: `${target.firstName} ${target.lastName}`,
      email: target.email,
      reason,
      description,
      meetingTitle: meeting.title,
      meetingDate: meeting.date,
      meetingStartTime: meeting.startTime,
      mandatory: !!meeting.mandatory,
      quarter: meeting.quarter,
    });
    toast("Request submitted — approvers will review");
    // Clear form (but only the parts we want to clear; keep the meeting selected for context)
    $("abs-description").value = "";
  } catch (e) {
    console.error(e);
    toast("Could not submit — check connection", true);
  }
}

// ----- Brother: their own requests list (re-renders freely) -----
function renderMyRequestsList() {
  const wrap = $("my-requests-container");
  if (!wrap) return;

  const target = state.user?.rosterEntry;
  if (!target) {
    wrap.innerHTML = "";
    return;
  }

  const myReqs = state.absenceRequests
    .filter(r => r.brotherKey === target.key)
    .filter(inQuarter)
    .sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));

  if (myReqs.length === 0) {
    wrap.innerHTML = `
      <div class="card">
        <div class="card-title">My Requests</div>
        <div class="card-sub">${formatQuarter(state.selectedQuarter)}</div>
        <div class="empty">You haven't submitted any absence requests this quarter.</div>
      </div>`;
    return;
  }

  const pending  = myReqs.filter(r => r.status === "pending").length;
  const approved = myReqs.filter(r => r.status === "approved").length;
  const denied   = myReqs.filter(r => r.status === "denied").length;

  wrap.innerHTML = `
    <div class="card">
      <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 14px;">
        <div>
          <div class="card-title">My Requests</div>
          <div class="card-sub">${formatQuarter(state.selectedQuarter)} &middot; ${pending} pending, ${approved} approved, ${denied} denied</div>
        </div>
      </div>
      <div style="display: flex; flex-direction: column; gap: 10px; margin-top: 14px;">
        ${myReqs.map(r => renderMyRequestRow(r)).join("")}
      </div>
    </div>`;

  wrap.querySelectorAll("[data-cancel]").forEach(b => {
    b.addEventListener("click", () => handleCancelRequest(b.dataset.cancel));
  });
}

function renderMyRequestRow(r) {
  const submittedAgo = r.submittedAt ? relativeTime(r.submittedAt) : "—";
  const statusColor = r.status === "approved" ? "var(--garnet)"
                     : r.status === "denied"   ? "var(--memphis-brick)"
                     : "var(--true-gold)";
  const statusLabel = r.status === "approved" ? "APPROVED"
                     : r.status === "denied"   ? "DENIED"
                     : "PENDING";

  return `
    <div style="padding: 14px 18px; background: white; border: 1px solid rgba(170,151,103,0.3); background-image: linear-gradient(color-mix(in srgb, ${statusColor} 7%, transparent), color-mix(in srgb, ${statusColor} 7%, transparent)); border-radius: 16px;">
      <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 14px; flex-wrap: wrap;">
        <div style="flex: 1; min-width: 220px;">
          <div style="font-family: var(--font-display); font-size: 17px; font-weight: 600; color: var(--garnet);">
            ${escapeHtml(r.meetingTitle || "Meeting")}
          </div>
          <div style="font-family: var(--font-ui); font-size: 11px; color: var(--slate); margin-top: 3px;">
            ${escapeHtml(fmtDate(r.meetingDate))} &middot; ${fmtTime(r.meetingStartTime)} &middot; ${escapeHtml(REASON_LABELS[r.reason] || r.reason)}
          </div>
          <div style="font-family: var(--font-body); font-size: 13px; color: var(--slate); margin-top: 8px; line-height: 1.5;">
            ${escapeHtml(r.description)}
          </div>
          ${r.reviewerNote ? `
            <div style="margin-top: 8px; padding: 8px 12px; background: var(--light-gold); font-family: var(--font-body); font-size: 12px; font-style: italic; border-radius: 14px;">
              <strong style="font-style: normal; color: var(--garnet);">Approver note:</strong> ${escapeHtml(r.reviewerNote)}
            </div>
          ` : ""}
          <div style="font-family: var(--font-ui); font-size: 10px; color: var(--knight-steel); margin-top: 8px; letter-spacing: 1px;">
            Submitted ${submittedAgo}
          </div>
        </div>
        <div style="display: flex; flex-direction: column; gap: 8px; align-items: flex-end;">
          <span style="background: ${statusColor}; color: white; padding: 4px 10px; font-family: var(--font-ui); font-size: 10px; font-weight: 600; letter-spacing: 1.5px;">
            ${statusLabel}
          </span>
          ${r.status === "pending"
            ? `<button class="btn btn-ghost btn-small" data-cancel="${r.id}">Cancel</button>`
            : ""}
        </div>
      </div>
    </div>`;
}

async function handleCancelRequest(id) {
  if (!confirm("Cancel this absence request? You can re-submit before the 48-hour cutoff.")) return;
  try {
    await absenceRequests.cancel(id);
    toast("Request cancelled");
  } catch (e) {
    console.error(e);
    toast("Cancel failed — try again", true);
  }
}

// ----- Approver queue -----
function renderApproverQueue() {
  const wrap = $("approver-queue-container");
  if (!wrap) return;

  const pending = state.absenceRequests
    .filter(r => r.status === "pending")
    .sort((a, b) => {
      // Sort by meeting date (most urgent first)
      const aTime = combineLocalDateTime(a.meetingDate, a.meetingStartTime)?.getTime() || Infinity;
      const bTime = combineLocalDateTime(b.meetingDate, b.meetingStartTime)?.getTime() || Infinity;
      return aTime - bTime;
    });

  const recentlyReviewed = state.absenceRequests
    .filter(r => r.status !== "pending")
    .filter(inQuarter)
    .sort((a, b) => (b.reviewedAt || 0) - (a.reviewedAt || 0))
    .slice(0, 10);

  wrap.innerHTML = `
    <div class="card">
      <div class="card-title">Pending Review</div>
      <div class="card-sub">${pending.length} request${pending.length === 1 ? "" : "s"} awaiting decision</div>

      ${pending.length === 0
        ? `<div class="empty">No pending requests right now.</div>`
        : `<div style="display: flex; flex-direction: column; gap: 14px; margin-top: 14px;">
            ${pending.map(r => renderApproverCard(r)).join("")}
          </div>`}
    </div>

    ${recentlyReviewed.length > 0 ? `
      <div class="card">
        <div class="card-title" style="font-size: 18px;">Recently Reviewed</div>
        <div class="card-sub">Last 10 decisions this quarter</div>
        <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 14px;">
          ${recentlyReviewed.map(r => renderReviewedRow(r)).join("")}
        </div>
      </div>
    ` : ""}
  `;

  wrap.querySelectorAll("[data-approve]").forEach(b =>
    b.addEventListener("click", () => handleReviewDecision(b.dataset.approve, "approved")));
  wrap.querySelectorAll("[data-deny]").forEach(b =>
    b.addEventListener("click", () => handleReviewDecision(b.dataset.deny, "denied")));
}

function renderApproverCard(r) {
  const submittedAgo = r.submittedAt ? relativeTime(r.submittedAt) : "—";
  const meetingTime = combineLocalDateTime(r.meetingDate, r.meetingStartTime);
  const meetingAway = meetingTime ? relativeTime(meetingTime) : "—";

  return `
    <div style="padding: 18px 20px; background: white; border: 1px solid rgba(170,151,103,0.3); border-radius: 14px; ${r.mandatory ? "background-image: linear-gradient(color-mix(in srgb, var(--burgundy) 7%, transparent), color-mix(in srgb, var(--burgundy) 7%, transparent)); border-radius: 16px;" : "background-image: linear-gradient(color-mix(in srgb, var(--true-gold) 7%, transparent), color-mix(in srgb, var(--true-gold) 7%, transparent)); border-radius: 16px;"}">
      <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 12px;">
        <div style="flex: 1; min-width: 200px;">
          <div style="font-family: var(--font-display); font-size: 19px; font-weight: 600; color: var(--garnet);">
            ${escapeHtml(r.brotherName)} ${r.mandatory ? `<span style="font-family: var(--font-ui); font-size: 10px; letter-spacing: 1.5px; color: var(--burgundy); margin-left: 6px;">⚑ MANDATORY MTG</span>` : ""}
          </div>
          <div style="font-family: var(--font-ui); font-size: 11px; color: var(--slate); letter-spacing: 0.5px; margin-top: 3px;">
            ${escapeHtml(r.meetingTitle || "Meeting")} &middot; ${escapeHtml(fmtDate(r.meetingDate))} ${fmtTime(r.meetingStartTime)} (${meetingAway})
          </div>
        </div>
        <span style="background: var(--khaki); color: var(--burgundy); padding: 3px 9px; font-family: var(--font-ui); font-size: 9px; font-weight: 600; letter-spacing: 1.5px; border-radius: 14px;">
          ${escapeHtml((r.reason || "OTHER").toUpperCase())}
        </span>
      </div>

      <div style="font-family: var(--font-body); font-size: 14px; color: var(--slate); margin-top: 12px; line-height: 1.55; padding: 12px 14px; background: var(--paper); background-image: linear-gradient(color-mix(in srgb, var(--key-gold) 7%, transparent), color-mix(in srgb, var(--key-gold) 7%, transparent)); border-radius: 16px; border-radius: 14px;">
        ${escapeHtml(r.description)}
      </div>

      <div style="margin-top: 14px;">
        <label for="abs-note-${r.id}" style="margin: 0 0 4px;">Note <span style="font-weight: normal; text-transform: none; letter-spacing: 0; color: var(--gold-ink); font-style: italic;">(optional, brother sees this)</span></label>
        <input type="text" id="abs-note-${r.id}" placeholder="e.g. 'Approved — please email proof to secretary'" autocomplete="off">
      </div>

      <div style="display: flex; gap: 10px; margin-top: 14px; align-items: center; flex-wrap: wrap;">
        <button class="btn" data-approve="${r.id}">Approve</button>
        <button class="btn btn-danger" data-deny="${r.id}">Deny</button>
        <span style="flex: 1; text-align: right; font-family: var(--font-ui); font-size: 10px; color: var(--knight-steel); letter-spacing: 1px;">
          Submitted ${submittedAgo} by ${escapeHtml(r.email || "")}
        </span>
      </div>
    </div>`;
}

function renderReviewedRow(r) {
  const color = r.status === "approved" ? "var(--garnet)" : "var(--memphis-brick)";
  const reviewerShort = (r.reviewedBy || "").split("@")[0];
  return `
    <div style="padding: 10px 14px; background: white; background-image: linear-gradient(color-mix(in srgb, ${color} 7%, transparent), color-mix(in srgb, ${color} 7%, transparent)); border-radius: 16px; font-family: var(--font-body); font-size: 13px; display: flex; justify-content: space-between; align-items: center; gap: 14px; flex-wrap: wrap;">
      <div>
        <strong style="color: ${color};">${(r.status || "").toUpperCase()}</strong>
        &middot; ${escapeHtml(r.brotherName)}
        &middot; ${escapeHtml(r.meetingTitle || "Meeting")}
        &middot; <span style="color: var(--knight-steel); font-size: 12px;">${escapeHtml(REASON_LABELS[r.reason] || r.reason)}</span>
      </div>
      <span style="font-family: var(--font-ui); font-size: 10px; color: var(--knight-steel); letter-spacing: 1px;">
        by ${escapeHtml(reviewerShort)} ${r.reviewedAt ? relativeTime(r.reviewedAt) : ""}
      </span>
    </div>`;
}

async function handleReviewDecision(id, decision) {
  if (!state.user || !state.user.isApprover) {
    return toast("Only approvers can decide", true);
  }
  const req = state.absenceRequests.find(r => r.id === id);
  const noteInput = $(`abs-note-${id}`);
  const note = noteInput ? noteInput.value.trim() : "";
  try {
    await absenceRequests.review(id, decision, note);
    toast(`Request ${decision}`);

    // Notify the brother of the decision
    if (req && req.email) {
      const decisionLabel = decision === "approved" ? "Absence Approved" : "Absence Denied";
      const tone = decision === "approved" ? "info" : "warning";
      const body = decision === "approved"
        ? `Your absence request for ${req.meetingTitle || "the meeting"} on ${fmtDate(req.meetingDate || "")} has been approved.${note ? ` Note: "${note}"` : ""}`
        : `Your absence request for ${req.meetingTitle || "the meeting"} on ${fmtDate(req.meetingDate || "")} has been denied.${note ? ` Reason: "${note}"` : ""} If you don't attend, you'll get a no-show.`;
      await notify(req.email, "absence_decision", decisionLabel, body, tone, id);
    }
  } catch (e) {
    console.error(e);
    toast("Review failed — try again", true);
  }
}

// ===================================================================
// STAGE 4 — APPEALS QUEUE  (Sgt-at-Arms reviews)
// ===================================================================

function renderAppealsQueue() {
  const wrap = $("appeals-queue-container");
  if (!wrap) return;

  const pendingAppeals = state.noShows
    .filter(n => n.appealed && n.appealStatus === "pending")
    .filter(inQuarter)
    .sort((a, b) => (a.appealedAt || 0) - (b.appealedAt || 0));

  const recentAppeals = state.noShows
    .filter(n => n.appealed && n.appealStatus !== "pending")
    .filter(inQuarter)
    .sort((a, b) => (b.appealResolvedAt || 0) - (a.appealResolvedAt || 0))
    .slice(0, 10);

  if (pendingAppeals.length === 0 && recentAppeals.length === 0) {
    wrap.innerHTML = "";
    return;
  }

  wrap.innerHTML = `
    ${pendingAppeals.length > 0 ? `
      <div class="card judicial">
        <div class="card-title">No-Show Appeals</div>
        <div class="card-sub">${pendingAppeals.length} pending &middot; Sgt-at-Arms decides</div>
        <div style="display: flex; flex-direction: column; gap: 14px; margin-top: 14px;">
          ${pendingAppeals.map(n => renderAppealCard(n)).join("")}
        </div>
      </div>` : ""}

    ${recentAppeals.length > 0 ? `
      <div class="card">
        <div class="card-title" style="font-size: 18px;">Recent Appeals</div>
        <div class="card-sub">Last 10 decisions</div>
        <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 14px;">
          ${recentAppeals.map(n => renderAppealReviewedRow(n)).join("")}
        </div>
      </div>` : ""}
  `;

  wrap.querySelectorAll("[data-overturn]").forEach(b =>
    b.addEventListener("click", () => handleAppealDecision(b.dataset.overturn, "overturned")));
  wrap.querySelectorAll("[data-uphold]").forEach(b =>
    b.addEventListener("click", () => handleAppealDecision(b.dataset.uphold, "upheld")));
}

function renderAppealCard(n) {
  const submittedAgo = n.appealedAt ? relativeTime(n.appealedAt) : "—";
  const sequence = ["1st", "2nd", "3rd", "4th+"][Math.min(n.count - 1, 3)] || "";
  return `
    <div style="padding: 18px 20px; background: white; border: 1px solid rgba(170,151,103,0.3); background-image: linear-gradient(color-mix(in srgb, var(--dagger) 7%, transparent), color-mix(in srgb, var(--dagger) 7%, transparent)); border-radius: 16px; border-radius: 14px;">
      <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 12px;">
        <div style="flex: 1; min-width: 200px;">
          <div style="font-family: var(--font-display); font-size: 19px; font-weight: 600; color: var(--dagger);">
            ${escapeHtml(n.brotherName)}
          </div>
          <div style="font-family: var(--font-ui); font-size: 11px; color: var(--slate); letter-spacing: 0.5px; margin-top: 3px;">
            ${sequence} no-show &middot; ${escapeHtml(n.meetingTitle || "Meeting")} &middot; ${escapeHtml(fmtDate(n.meetingDate || ""))}
          </div>
          <div style="font-family: var(--font-ui); font-size: 10px; color: var(--knight-steel); margin-top: 3px; font-style: italic;">
            ${escapeHtml(noShowReasonLabel(n.reason))}
          </div>
        </div>
      </div>

      <div style="font-family: var(--font-body); font-size: 14px; color: var(--slate); margin-top: 12px; line-height: 1.55; padding: 12px 14px; background: var(--paper); background-image: linear-gradient(color-mix(in srgb, var(--key-gold) 7%, transparent), color-mix(in srgb, var(--key-gold) 7%, transparent)); border-radius: 16px; border-radius: 14px;">
        <div style="font-family: var(--font-ui); font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--garnet); font-weight: 600; margin-bottom: 4px;">Appeal reason</div>
        ${escapeHtml(n.appealReason || "")}
      </div>

      <div style="margin-top: 14px;">
        <label for="appeal-note-${n.id}" style="margin: 0 0 4px;">Note <span style="font-weight: normal; text-transform: none; letter-spacing: 0; color: var(--gold-ink); font-style: italic;">(brother sees this)</span></label>
        <input type="text" id="appeal-note-${n.id}" placeholder="e.g. 'Overturned — confirmed with health center'" autocomplete="off">
      </div>

      <div style="display: flex; gap: 10px; margin-top: 14px; align-items: center; flex-wrap: wrap;">
        <button class="btn" data-overturn="${n.id}">Overturn (remove no-show)</button>
        <button class="btn btn-danger" data-uphold="${n.id}">Uphold (no-show stands)</button>
        <span style="flex: 1; text-align: right; font-family: var(--font-ui); font-size: 10px; color: var(--knight-steel); letter-spacing: 1px;">
          Appealed ${submittedAgo}
        </span>
      </div>
    </div>`;
}

function renderAppealReviewedRow(n) {
  const color = n.appealStatus === "overturned" ? "var(--garnet)" : "var(--memphis-brick)";
  const reviewerShort = (n.appealResolvedBy || "").split("@")[0];
  return `
    <div style="padding: 10px 14px; background: white; background-image: linear-gradient(color-mix(in srgb, ${color} 7%, transparent), color-mix(in srgb, ${color} 7%, transparent)); border-radius: 16px; font-family: var(--font-body); font-size: 13px; display: flex; justify-content: space-between; align-items: center; gap: 14px; flex-wrap: wrap;">
      <div>
        <strong style="color: ${color};">${(n.appealStatus || "").toUpperCase()}</strong>
        &middot; ${escapeHtml(n.brotherName)}
        &middot; ${escapeHtml(n.meetingTitle || "Meeting")}
      </div>
      <span style="font-family: var(--font-ui); font-size: 10px; color: var(--knight-steel); letter-spacing: 1px;">
        by ${escapeHtml(reviewerShort)} ${n.appealResolvedAt ? relativeTime(n.appealResolvedAt) : ""}
      </span>
    </div>`;
}

async function handleAppealDecision(id, decision) {
  if (!state.user || (!state.user.isSgt && !state.user.isExec)) {
    return toast("Only Sgt-at-Arms can resolve appeals", true);
  }
  const ns = state.noShows.find(n => n.id === id);
  const noteInput = $(`appeal-note-${id}`);
  const note = noteInput ? noteInput.value.trim() : "";
  try {
    await noShows.resolveAppeal(id, decision, note);

    // If overturned, remove any associated fine
    if (decision === "overturned" && ns) {
      const associatedFine = state.fines.find(f =>
        f.brotherKey === ns.brotherKey &&
        f.meetingId === ns.meetingId &&
        f.status === "pending"
      );
      if (associatedFine) {
        try {
          await fines.waive(associatedFine.id, "Appeal overturned no-show");
        } catch (e) { console.warn("Could not waive associated fine:", e); }
      }
    }
    toast(`Appeal ${decision}`);

    // Notify the brother of the appeal outcome
    if (ns && ns.email) {
      const decisionLabel = decision === "overturned" ? "Appeal Overturned ✓" : "Appeal Denied";
      const body = decision === "overturned"
        ? `Your appeal of the no-show for ${ns.meetingTitle || "the meeting"} has been overturned. Any associated fine has been waived.${note ? ` Sgt note: "${note}"` : ""}`
        : `Your appeal of the no-show for ${ns.meetingTitle || "the meeting"} was denied. The no-show stands.${note ? ` Sgt note: "${note}"` : ""}`;
      const tone = decision === "overturned" ? "info" : "warning";
      await notify(ns.email, "appeal_resolved", decisionLabel, body, tone, id);
    }
  } catch (e) {
    console.error(e);
    toast("Could not resolve appeal", true);
  }
}

// ===================================================================
// REPORTS TAB  (Stage 4 — treasurer fine ledger; Stage 5 will add more)
// ===================================================================

function renderReportsTab() {
  const wrap = $("reports-content");
  if (!wrap) return;

  const isExec = !!(state.user && state.user.isExec);
  const isTreasurer = !!(state.user && state.user.isTreasurer);

  if (!isExec && !isTreasurer) {
    wrap.innerHTML = `
      <div class="card">
        <div class="empty-coming-soon">
          <h3>Exec Reports</h3>
          <p style="margin-top: 12px;">This area is for exec officers only.</p>
        </div>
      </div>`;
    return;
  }

  // Filter to selected quarter
  const pendingFines = state.fines.filter(f => f.status === "pending").filter(inQuarter);
  const paidFines    = state.fines.filter(f => f.status === "paid").filter(inQuarter);
  const waivedFines  = state.fines.filter(f => f.status === "waived").filter(inQuarter);

  const pendingTotal = pendingFines.reduce((sum, f) => sum + (Number(f.amount) || 0), 0);
  const paidTotal    = paidFines.reduce((sum, f) => sum + (Number(f.amount) || 0), 0);

  // Sort by date descending
  const sortByDate = (a, b) => (b.createdAt || 0) - (a.createdAt || 0);
  pendingFines.sort(sortByDate);
  paidFines.sort(sortByDate);

  wrap.innerHTML = `
    <div class="card danger">
      <div class="card-title">Treasurer's Fine Ledger</div>
      <div class="card-sub">${formatQuarter(state.selectedQuarter)} &middot; ${pendingFines.length} pending, ${paidFines.length} collected</div>

      <div class="standing-grid" style="margin-top: 14px;">
        <div class="standing-tile fines">
          <div class="num">$${pendingTotal}</div>
          <div class="label">Outstanding</div>
          <div class="sub">${pendingFines.length} brother${pendingFines.length === 1 ? "" : "s"}</div>
        </div>
        <div class="standing-tile absences">
          <div class="num">$${paidTotal}</div>
          <div class="label">Collected</div>
          <div class="sub">${paidFines.length} fine${paidFines.length === 1 ? "" : "s"}</div>
        </div>
        <div class="standing-tile no-shows">
          <div class="num">${waivedFines.length}</div>
          <div class="label">Waived</div>
          <div class="sub">via appeal</div>
        </div>
        <div class="standing-tile standing">
          <div class="num">$${pendingTotal + paidTotal}</div>
          <div class="label">Total Levied</div>
          <div class="sub">this quarter</div>
        </div>
      </div>

      ${pendingFines.length === 0
        ? `<div class="empty" style="margin-top: 18px;">No outstanding fines.</div>`
        : `<div style="margin-top: 22px;">
            <div style="font-family: var(--font-display); font-size: 18px; font-weight: 600; color: var(--memphis-brick); margin-bottom: 10px;">
              Pending Collection
            </div>
            <div style="display: flex; flex-direction: column; gap: 8px;">
              ${pendingFines.map(f => renderFineRow(f, "pending")).join("")}
            </div>
          </div>`}

      ${paidFines.length > 0 ? `
        <div style="margin-top: 22px;">
          <div style="font-family: var(--font-display); font-size: 16px; font-weight: 600; color: var(--garnet); margin-bottom: 10px;">
            Collected (Paid)
          </div>
          <div style="display: flex; flex-direction: column; gap: 6px;">
            ${paidFines.slice(0, 20).map(f => renderFineRow(f, "paid")).join("")}
          </div>
        </div>` : ""}
    </div>

    <div class="card judicial">
      <div class="card-title">&lt;50% Participation Watchlist</div>
      <div class="card-sub">Article VI §12 &middot; Combined meetings + chapter events &middot; ${formatQuarter(state.selectedQuarter)}</div>
      ${renderWatchlistSection()}
    </div>

    ${(isExec || (state.user && state.user.isSgt)) ? `
      <div class="card">
        <div class="card-title">Pending Acknowledgments</div>
        <div class="card-sub">Notifications brothers haven't seen yet &middot; Follow up if urgent</div>
        ${renderPendingAcksSection()}
      </div>
    ` : ""}

    <div class="card">
      <div class="card-title">Excel Reports</div>
      <div class="card-sub">Download as .xlsx &middot; Filtered to ${formatQuarter(state.selectedQuarter)}</div>
      <p style="font-family: var(--font-body); font-size: 13px; line-height: 1.5; color: var(--slate); margin-top: 8px; margin-bottom: 14px;">
        Each export pulls live data for the selected quarter. Hand to chapter standards / Sgt-at-Arms / treasurer / secretary as appropriate.
      </p>
      <div style="display: flex; flex-wrap: wrap; gap: 10px;">
        <button class="btn btn-ghost btn-small" data-export="attendance">Quarterly Attendance per Brother</button>
        <button class="btn btn-ghost btn-small" data-export="noshows">No-Show Ledger</button>
        <button class="btn btn-ghost btn-small" data-export="fines">Fine Ledger (Treasurer)</button>
        <button class="btn btn-ghost btn-small" data-export="absences">Absence Request History</button>
        <button class="btn btn-ghost btn-small" data-export="combined">Combined Participation Report</button>
      </div>
    </div>
  `;

  wrap.querySelectorAll("[data-paid]").forEach(b =>
    b.addEventListener("click", () => handleMarkFinePaid(b.dataset.paid)));
  wrap.querySelectorAll("[data-waive]").forEach(b =>
    b.addEventListener("click", () => handleWaiveFine(b.dataset.waive)));
  wrap.querySelectorAll("[data-export]").forEach(b =>
    b.addEventListener("click", () => exportReport(b.dataset.export)));
}

// ===================================================================
// STAGE 5 — PARTICIPATION WATCHLIST + EXCEL EXPORTS
// ===================================================================

// Per-brother participation data for the selected quarter.
// Combines meetings (this app) + chapter events (event tracker collection).
function computeParticipation() {
  const eligible = state.roster.filter(brotherIsEligible);
  const q = state.selectedQuarter;

  // Meetings in quarter
  const meetingsInQ = state.meetings.filter(m => q === "all" || m.quarter === q);
  const meetingAttIn = state.attendance.filter(a => q === "all" || a.quarter === q);

  // Events in quarter (from event tracker collection)
  // Event tracker doesn't always stamp `quarter` on events, so derive from date if missing
  const eventsInQ = state.events.filter(e => {
    if (q === "all") return true;
    if (e.quarter) return e.quarter === q;
    if (!e.date) return false;
    const [y, m] = e.date.split("-").map(Number);
    const month = m - 1;
    let derived;
    if (month <= 2)      derived = `${y}-winter`;
    else if (month <= 5) derived = `${y}-spring`;
    else if (month <= 7) derived = `${y}-summer`;
    else                 derived = `${y}-fall`;
    return derived === q;
  });
  const eventCheckinsIn = state.checkins.filter(c => {
    // Event tracker may stamp `quarter` or only `eventId`. Look up the event if needed.
    if (q === "all") return true;
    if (c.quarter) return c.quarter === q;
    const ev = eventsInQ.find(e => e.id === c.eventId);
    return !!ev;
  });

  return eligible.map(b => {
    const mAttended = meetingAttIn.filter(a => a.brotherKey === b.key).length;
    const eAttended = eventCheckinsIn.filter(c => c.brotherKey === b.key).length;
    const totalEvents = meetingsInQ.length + eventsInQ.length;
    const totalAttended = mAttended + eAttended;
    const ratio = totalEvents > 0 ? totalAttended / totalEvents : 1;

    const myNS  = state.noShows.filter(n => n.brotherKey === b.key && (q === "all" || n.quarter === q) && n.appealStatus !== "overturned");
    const myAbs = state.absenceRequests.filter(r => r.brotherKey === b.key && (q === "all" || r.quarter === q));
    const myFines = state.fines.filter(f => f.brotherKey === b.key && (q === "all" || f.quarter === q));

    return {
      brother: b,
      meetingsAttended: mAttended,
      meetingsTotal: meetingsInQ.length,
      eventsAttended: eAttended,
      eventsTotal: eventsInQ.length,
      totalAttended,
      totalEvents,
      ratio,
      onWatchlist: totalEvents >= 3 && ratio < 0.5,
      noShows: myNS.length,
      absencesApproved: myAbs.filter(r => r.status === "approved").length,
      finesPending: myFines.filter(f => f.status === "pending").reduce((s, f) => s + Number(f.amount || 0), 0),
      finesPaid:    myFines.filter(f => f.status === "paid").reduce((s, f) => s + Number(f.amount || 0), 0),
    };
  });
}

function renderPendingAcksSection() {
  // Unacknowledged notifications, sorted by severity then age (oldest first)
  const severityOrder = { judicial: 0, danger: 1, warning: 2, info: 3 };
  const pending = state.notifications
    .filter(n => !n.acknowledgedAt)
    .sort((a, b) => {
      const sa = severityOrder[a.severity] ?? 4;
      const sb = severityOrder[b.severity] ?? 4;
      if (sa !== sb) return sa - sb;
      return (a.createdAt || 0) - (b.createdAt || 0);
    });

  if (pending.length === 0) {
    return `
      <div style="margin-top: 14px; padding: 14px 18px; background: var(--light-gold); background-image: linear-gradient(color-mix(in srgb, var(--garnet) 7%, transparent), color-mix(in srgb, var(--garnet) 7%, transparent)); border-radius: 16px; border-radius: 14px;">
        <div style="font-family: var(--font-display); font-size: 16px; font-weight: 600; color: var(--garnet);">
          ✓ All notifications acknowledged
        </div>
        <div style="font-family: var(--font-body); font-size: 12px; color: var(--slate); margin-top: 4px;">
          Every brother has seen their notifications.
        </div>
      </div>`;
  }

  const grouped = { judicial: [], danger: [], warning: [], info: [] };
  pending.forEach(n => {
    const s = grouped[n.severity] ? n.severity : "info";
    grouped[s].push(n);
  });

  const severityColors = {
    judicial: "var(--dagger)",
    danger:   "var(--memphis-brick)",
    warning:  "var(--key-gold)",
    info:     "var(--garnet)",
  };

  return `
    <div style="margin-top: 14px;">
      <div style="font-family: var(--font-body); font-size: 13px; color: var(--slate); margin-bottom: 10px; line-height: 1.5;">
        ${pending.length} notification${pending.length === 1 ? "" : "s"} unread. Brothers see these as full-screen modals on next sign-in.
      </div>
      <div style="display: flex; flex-direction: column; gap: 6px;">
        ${pending.slice(0, 25).map(n => {
          const ageHours = n.createdAt ? Math.floor((Date.now() - n.createdAt) / 3600000) : 0;
          const ageLabel = ageHours < 1 ? "just now"
                         : ageHours < 24 ? `${ageHours}h ago`
                         : `${Math.floor(ageHours / 24)}d ago`;
          const stale = ageHours >= 48;
          const recipientShort = (n.recipientEmail || "").split("@")[0];
          return `
            <div style="padding: 10px 14px; background: white; background-image: linear-gradient(color-mix(in srgb, ${severityColors[n.severity] || "var(--garnet)"} 7%, transparent), color-mix(in srgb, ${severityColors[n.severity] || "var(--garnet)"} 7%, transparent)); border-radius: 16px; display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap;">
              <div style="flex: 1; min-width: 200px;">
                <div style="font-family: var(--font-body); font-size: 13px; line-height: 1.4;">
                  <strong style="color: ${severityColors[n.severity] || "var(--garnet)"};">${escapeHtml(n.title || "Notification")}</strong>
                  <span style="color: var(--knight-steel); font-size: 11px; margin-left: 6px;">→ ${escapeHtml(recipientShort)}</span>
                </div>
              </div>
              <span style="font-family: var(--font-ui); font-size: 9px; letter-spacing: 1.5px; color: ${stale ? "var(--memphis-brick)" : "var(--knight-steel)"}; ${stale ? "font-weight: 600;" : ""} text-transform: uppercase;">
                ${ageLabel}${stale ? " • stale" : ""}
              </span>
            </div>`;
        }).join("")}
        ${pending.length > 25 ? `<div style="font-family: var(--font-ui); font-size: 11px; color: var(--knight-steel); text-align: center; padding: 8px; letter-spacing: 1px;">+ ${pending.length - 25} more</div>` : ""}
      </div>
    </div>`;
}

function renderWatchlistSection() {
  const all = computeParticipation();
  const watchlist = all.filter(p => p.onWatchlist).sort((a, b) => a.ratio - b.ratio);

  if (state.events.length === 0 && state.meetings.length === 0) {
    return `<div class="empty">No meetings or events recorded yet this quarter.</div>`;
  }
  if (watchlist.length === 0) {
    return `
      <div style="margin-top: 14px; padding: 18px; background: var(--light-gold); background-image: linear-gradient(color-mix(in srgb, var(--garnet) 7%, transparent), color-mix(in srgb, var(--garnet) 7%, transparent)); border-radius: 16px; border-radius: 14px;">
        <div style="font-family: var(--font-display); font-size: 18px; font-weight: 600; color: var(--garnet);">
          ✓ No brothers below 50% this quarter
        </div>
        <div style="font-family: var(--font-body); font-size: 13px; color: var(--slate); margin-top: 6px;">
          Watchlist only flags brothers with 3+ chapter events on record. Below that threshold, the sample size is too small to meaningfully judge participation.
        </div>
      </div>`;
  }

  return `
    <div style="margin-top: 14px;">
      <div style="font-family: var(--font-body); font-size: 13px; color: var(--slate); margin-bottom: 10px; line-height: 1.5;">
        Brothers below 50% combined attendance (chapter meetings + chapter events) this quarter, per Article VI §12. Sgt-at-Arms / judicial board to review.
      </div>
      <div style="display: flex; flex-direction: column; gap: 8px;">
        ${watchlist.map(p => `
          <div style="padding: 12px 14px; background: white; background-image: linear-gradient(color-mix(in srgb, var(--dagger) 7%, transparent), color-mix(in srgb, var(--dagger) 7%, transparent)); border-radius: 16px; display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; border-radius: 14px;">
            <div style="flex: 1; min-width: 200px;">
              <div style="font-family: var(--font-display); font-size: 16px; font-weight: 600; color: var(--dagger);">
                ${escapeHtml(p.brother.firstName + " " + p.brother.lastName)}
                <span style="font-family: var(--font-ui); font-size: 9px; color: var(--knight-steel); letter-spacing: 1.5px; margin-left: 6px;">${escapeHtml((p.brother.status || "").toUpperCase())}</span>
              </div>
              <div style="font-family: var(--font-ui); font-size: 11px; color: var(--slate); margin-top: 3px;">
                ${p.totalAttended}/${p.totalEvents} attended &middot;
                ${p.meetingsAttended}/${p.meetingsTotal} meetings &middot;
                ${p.eventsAttended}/${p.eventsTotal} events
              </div>
            </div>
            <div style="text-align: right;">
              <div style="font-family: var(--font-display); font-size: 22px; font-weight: 700; color: var(--memphis-brick);">
                ${Math.round(p.ratio * 100)}%
              </div>
              <div style="font-family: var(--font-ui); font-size: 9px; letter-spacing: 1.5px; color: var(--memphis-brick); text-transform: uppercase; font-weight: 600;">
                Below 50%
              </div>
            </div>
          </div>`).join("")}
      </div>
    </div>`;
}

// ----- Excel exports -----
function exportReport(kind) {
  if (typeof XLSX === "undefined") {
    return toast("Excel library not loaded — refresh the page", true);
  }

  const q = state.selectedQuarter;
  const qLabel = formatQuarter(q).replace(/\s+/g, "-");
  const today = new Date().toISOString().slice(0, 10);

  let rows = [];
  let filename = "";

  switch (kind) {
    case "attendance": {
      const all = computeParticipation();
      rows = all.map(p => ({
        "Last Name":      p.brother.lastName,
        "First Name":     p.brother.firstName,
        "Status":         p.brother.status || "",
        "Email":          p.brother.email || "",
        "Meetings Total": p.meetingsTotal,
        "Meetings Attended": p.meetingsAttended,
        "Events Total":   p.eventsTotal,
        "Events Attended": p.eventsAttended,
        "Combined Total": p.totalEvents,
        "Combined Attended": p.totalAttended,
        "Attendance %":   p.totalEvents > 0 ? Math.round(p.ratio * 100) + "%" : "—",
        "Below 50%":      p.onWatchlist ? "YES" : "",
        "Free Absences Used": p.absencesApproved + "/3",
        "No-Shows":       p.noShows,
        "Fines Pending ($)": p.finesPending,
        "Fines Paid ($)": p.finesPaid,
      }));
      filename = `pike-attendance-per-brother-${qLabel}-${today}.xlsx`;
      break;
    }

    case "noshows": {
      const ns = state.noShows
        .filter(n => q === "all" || n.quarter === q)
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      rows = ns.map(n => ({
        "Brother":        n.brotherName || "",
        "Email":          n.email || "",
        "Meeting":        n.meetingTitle || "",
        "Meeting Date":   n.meetingDate || "",
        "Reason":         noShowReasonLabel(n.reason),
        "Count (1/2/3)":  n.count,
        "Quarter":        formatQuarter(n.quarter),
        "Recorded At":    n.timestamp ? new Date(n.timestamp).toLocaleString() : "",
        "Appealed":       n.appealed ? "Yes" : "",
        "Appeal Status":  n.appealStatus || "",
        "Appeal Reason":  n.appealReason || "",
        "Appeal Note":    n.appealResolverNote || "",
      }));
      filename = `pike-noshow-ledger-${qLabel}-${today}.xlsx`;
      break;
    }

    case "fines": {
      const fl = state.fines
        .filter(f => q === "all" || f.quarter === q)
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      rows = fl.map(f => ({
        "Brother":        f.brotherName || "",
        "Email":          f.email || "",
        "Amount ($)":     f.amount || 0,
        "Reason":         f.reason || "",
        "Meeting":        f.meetingTitle || "",
        "Meeting Date":   f.meetingDate || "",
        "Status":         (f.status || "").toUpperCase(),
        "Created":        f.createdAt ? new Date(f.createdAt).toLocaleString() : "",
        "Paid At":        f.paidAt ? new Date(f.paidAt).toLocaleString() : "",
        "Paid Marked By": f.paidMarkedBy || "",
        "Waived At":      f.waivedAt ? new Date(f.waivedAt).toLocaleString() : "",
        "Waive Reason":   f.waiveReason || "",
        "Quarter":        formatQuarter(f.quarter),
      }));
      filename = `pike-fine-ledger-${qLabel}-${today}.xlsx`;
      break;
    }

    case "absences": {
      const reqs = state.absenceRequests
        .filter(r => q === "all" || r.quarter === q)
        .sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));
      rows = reqs.map(r => ({
        "Brother":        r.brotherName || "",
        "Email":          r.email || "",
        "Meeting":        r.meetingTitle || "",
        "Meeting Date":   r.meetingDate || "",
        "Mandatory":      r.mandatory ? "Yes" : "",
        "Reason":         REASON_LABELS[r.reason] || r.reason || "",
        "Description":    r.description || "",
        "Status":         (r.status || "").toUpperCase(),
        "Submitted":      r.submittedAt ? new Date(r.submittedAt).toLocaleString() : "",
        "Reviewed":       r.reviewedAt ? new Date(r.reviewedAt).toLocaleString() : "",
        "Reviewed By":    r.reviewedBy || "",
        "Reviewer Note":  r.reviewerNote || "",
        "Quarter":        formatQuarter(r.quarter),
      }));
      filename = `pike-absence-requests-${qLabel}-${today}.xlsx`;
      break;
    }

    case "combined": {
      const all = computeParticipation()
        .sort((a, b) => a.ratio - b.ratio);
      rows = all.map(p => ({
        "Last Name":          p.brother.lastName,
        "First Name":         p.brother.firstName,
        "Status":             p.brother.status || "",
        "Email":              p.brother.email || "",
        "Meetings Attended":  `${p.meetingsAttended} / ${p.meetingsTotal}`,
        "Events Attended":    `${p.eventsAttended} / ${p.eventsTotal}`,
        "Combined Attended":  `${p.totalAttended} / ${p.totalEvents}`,
        "Participation %":    p.totalEvents > 0 ? Math.round(p.ratio * 100) + "%" : "—",
        "Watchlist (<50%)":   p.onWatchlist ? "FLAGGED" : "",
        "No-Shows":           p.noShows,
        "Outstanding Fines":  "$" + p.finesPending,
      }));
      filename = `pike-participation-combined-${qLabel}-${today}.xlsx`;
      break;
    }

    default:
      return toast("Unknown export type", true);
  }

  if (rows.length === 0) {
    return toast("No data to export for this quarter", true);
  }

  try {
    const ws = XLSX.utils.json_to_sheet(rows);
    // Auto-width columns based on header + max content length
    const headers = Object.keys(rows[0]);
    ws["!cols"] = headers.map(h => {
      const maxLen = Math.max(
        h.length,
        ...rows.map(r => String(r[h] ?? "").length)
      );
      return { wch: Math.min(Math.max(maxLen + 2, 10), 50) };
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, formatQuarter(q).slice(0, 30));
    XLSX.writeFile(wb, filename);
    toast(`Downloaded ${rows.length} row${rows.length === 1 ? "" : "s"}`);
  } catch (e) {
    console.error(e);
    toast("Export failed — check console", true);
  }
}

function renderFineRow(f, mode) {
  const ago = f.createdAt ? relativeTime(f.createdAt) : "";
  const paidAgo = f.paidAt ? relativeTime(f.paidAt) : "";

  return `
    <div style="padding: 10px 14px; background: white; background-image: linear-gradient(color-mix(in srgb, ${mode === "pending" ? "var(--memphis-brick)" : "var(--garnet)"} 7%, transparent), color-mix(in srgb, ${mode === "pending" ? "var(--memphis-brick)" : "var(--garnet)"} 7%, transparent)); border-radius: 16px; display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap;">
      <div style="flex: 1; min-width: 200px;">
        <div style="font-family: var(--font-body); font-size: 14px;">
          <strong>${escapeHtml(f.brotherName)}</strong>
          &middot; <span style="color: ${mode === "pending" ? "var(--memphis-brick)" : "var(--garnet)"}; font-weight: 600;">$${f.amount}</span>
          &middot; <span style="color: var(--slate); font-size: 12px;">${escapeHtml(f.reason || "")}</span>
        </div>
        <div style="font-family: var(--font-ui); font-size: 10px; color: var(--knight-steel); margin-top: 3px; letter-spacing: 0.5px;">
          ${escapeHtml(f.meetingTitle || "")} &middot; ${escapeHtml(fmtDate(f.meetingDate || ""))} &middot; created ${ago}
          ${mode === "paid" ? ` &middot; paid ${paidAgo}` : ""}
        </div>
      </div>
      ${mode === "pending" ? `
        <div style="display: flex; gap: 6px;">
          <button class="btn btn-small" data-paid="${f.id}">Mark Paid</button>
          <button class="btn btn-ghost btn-small" data-waive="${f.id}">Waive</button>
        </div>` : ""}
    </div>`;
}

async function handleMarkFinePaid(id) {
  if (!confirm("Mark this fine as paid? This action is logged.")) return;
  const fine = state.fines.find(f => f.id === id);
  try {
    await fines.markPaid(id);
    toast("Fine marked paid");

    // Notify the brother — receipt-style
    if (fine && fine.email) {
      await notify(
        fine.email,
        "fine_paid",
        "Fine Paid ✓",
        `Your $${fine.amount} fine for ${fine.meetingTitle || "missing a meeting"} has been marked paid by the treasurer. Receipt logged on ${new Date().toLocaleDateString()}.`,
        "info",
        id
      );
    }
  } catch (e) {
    console.error(e);
    toast("Update failed — treasurer/exec only", true);
  }
}

async function handleWaiveFine(id) {
  const reason = prompt("Reason for waiving this fine? (Optional but recommended)");
  if (reason === null) return; // user cancelled
  try {
    await fines.waive(id, reason || "");
    toast("Fine waived");
  } catch (e) {
    console.error(e);
    toast("Update failed — treasurer/exec only", true);
  }
}

// ===================================================================
// SETTINGS
// ===================================================================
function renderSettings() {
  $("setting-vc-email").value = state.settings.judicialViceChair || "";
  $("setting-sgt-email").value = state.settings.sgtAtArmsEmail || SGT_AT_ARMS_EMAIL;
  $("setting-treasurer-email").value = state.settings.treasurerEmail || TREASURER_EMAIL;
  $("setting-secretary-email").value = state.settings.secretaryEmail || SECRETARY_EMAIL;
  $("setting-president-email").value = state.settings.presidentEmail || PRESIDENT_EMAIL;
  $("setting-ivp-email").value = state.settings.ivpEmail || IVP_EMAIL;
  $("setting-fine-amount").value = state.settings.fineAmount || FINE_AMOUNT_DEFAULT;
  $("setting-notes").value = state.settings.notes || "";
}

$("settings-save").addEventListener("click", async () => {
  if (!state.user || !state.user.isExec) {
    return toast("Only exec can change settings", true);
  }
  try {
    await settings.save({
      judicialViceChair: $("setting-vc-email").value.trim().toLowerCase(),
      sgtAtArmsEmail:    $("setting-sgt-email").value.trim().toLowerCase(),
      treasurerEmail:    $("setting-treasurer-email").value.trim().toLowerCase(),
      secretaryEmail:    $("setting-secretary-email").value.trim().toLowerCase(),
      presidentEmail:    $("setting-president-email").value.trim().toLowerCase(),
      ivpEmail:          $("setting-ivp-email").value.trim().toLowerCase(),
      fineAmount:        Math.max(0, Math.min(500, Number($("setting-fine-amount").value) || FINE_AMOUNT_DEFAULT)),
      notes:             $("setting-notes").value.trim(),
    });
    toast("Settings saved");
  } catch (e) {
    console.error(e);
    toast("Save failed — exec sign-in required", true);
  }
});

// ===================================================================
// MAINTENANCE — Orphan cleanup
// ===================================================================
// Finds any no_show / fine / meeting_attendance / absence_request whose
// meetingId doesn't match an existing meeting, and deletes them.
// Idempotent. Safe to run anytime.
// ===================================================================
$("settings-cleanup-orphans").addEventListener("click", async () => {
  if (!state.user || !state.user.isExec) {
    return toast("Only exec can run cleanup", true);
  }

  const liveMeetingIds = new Set(state.meetings.map(m => m.id));

  // Find orphans across all four collections
  const orphanNoShows = state.noShows.filter(n => !liveMeetingIds.has(n.meetingId));
  const orphanFines   = state.fines.filter(f => !liveMeetingIds.has(f.meetingId));
  const orphanAtt     = state.attendance.filter(a => !liveMeetingIds.has(a.meetingId));
  const orphanReqs    = state.absenceRequests.filter(r => !liveMeetingIds.has(r.meetingId));

  const total = orphanNoShows.length + orphanFines.length + orphanAtt.length + orphanReqs.length;

  if (total === 0) {
    $("settings-cleanup-status").textContent = "No orphans found ✓";
    toast("No orphan records to clean up");
    return;
  }

  const summary = [];
  if (orphanNoShows.length) summary.push(`${orphanNoShows.length} no-show${orphanNoShows.length === 1 ? "" : "s"}`);
  if (orphanFines.length)   summary.push(`${orphanFines.length} fine${orphanFines.length === 1 ? "" : "s"}`);
  if (orphanAtt.length)     summary.push(`${orphanAtt.length} attendance record${orphanAtt.length === 1 ? "" : "s"}`);
  if (orphanReqs.length)    summary.push(`${orphanReqs.length} absence request${orphanReqs.length === 1 ? "" : "s"}`);

  const ok = confirm(
    `Found ${total} orphaned record${total === 1 ? "" : "s"}:\n\n• ${summary.join("\n• ")}\n\n` +
    `Delete them all? This cannot be undone.`
  );
  if (!ok) return;

  $("settings-cleanup-status").textContent = "Cleaning...";

  let deleted = 0;
  let failed = 0;

  // Use the same per-collection remove() methods we already have
  for (const r of orphanNoShows) {
    try { await noShows.remove(r.id); deleted++; }
    catch (e) { console.warn("noShow", r.id, e); failed++; }
  }
  for (const r of orphanFines) {
    try { await fines.remove(r.id); deleted++; }
    catch (e) { console.warn("fine", r.id, e); failed++; }
  }
  for (const r of orphanAtt) {
    try { await attendance.remove(r.id); deleted++; }
    catch (e) { console.warn("attendance", r.id, e); failed++; }
  }
  for (const r of orphanReqs) {
    try { await absenceRequests.cancel(r.id); deleted++; }
    catch (e) { console.warn("request", r.id, e); failed++; }
  }

  $("settings-cleanup-status").textContent = `Cleaned ${deleted}${failed ? " (" + failed + " failed)" : ""} ✓`;
  toast(`Cleaned up ${deleted} orphan record${deleted === 1 ? "" : "s"}${failed ? ` — ${failed} failed (see console)` : ""}`);
});

// ===================================================================
// MAINTENANCE — Deduplicate no-shows
// ===================================================================
// Finds (brotherKey, meetingId) pairs with multiple no_show records,
// keeps the earliest by timestamp, deletes the rest. Also waives any
// extra fines created by the duplicates.
// ===================================================================
$("settings-dedupe-noshows").addEventListener("click", async () => {
  if (!state.user || !state.user.isExec) {
    return toast("Only exec can run cleanup", true);
  }

  // Group no-shows by (brotherKey, meetingId)
  const groups = new Map();
  for (const n of state.noShows) {
    const key = `${n.brotherKey}|${n.meetingId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(n);
  }

  // Find duplicate groups
  const duplicates = [];
  for (const [key, list] of groups) {
    if (list.length > 1) {
      // Sort by timestamp ascending — keep first, mark rest for deletion
      list.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      duplicates.push({ keep: list[0], remove: list.slice(1) });
    }
  }

  // Find duplicate fines (more than one for same brother/meeting)
  const fineGroups = new Map();
  for (const f of state.fines) {
    const key = `${f.brotherKey}|${f.meetingId}`;
    if (!fineGroups.has(key)) fineGroups.set(key, []);
    fineGroups.get(key).push(f);
  }
  const dupeFines = [];
  for (const [key, list] of fineGroups) {
    if (list.length > 1) {
      list.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      dupeFines.push(...list.slice(1));
    }
  }

  const totalNoShows = duplicates.reduce((s, d) => s + d.remove.length, 0);
  const totalFines = dupeFines.length;
  const total = totalNoShows + totalFines;

  if (total === 0) {
    $("settings-dedupe-status").textContent = "No duplicates found ✓";
    toast("No duplicate no-shows or fines");
    return;
  }

  const ok = confirm(
    `Found duplicates:\n\n` +
    `• ${totalNoShows} duplicate no-show record${totalNoShows === 1 ? "" : "s"} ` +
    `(across ${duplicates.length} brother/meeting pair${duplicates.length === 1 ? "" : "s"})\n` +
    `• ${totalFines} duplicate fine record${totalFines === 1 ? "" : "s"}\n\n` +
    `Keep the earliest of each, delete the rest? Cannot be undone.`
  );
  if (!ok) return;

  $("settings-dedupe-status").textContent = "Deduplicating...";

  let deleted = 0;
  let failed = 0;

  for (const dup of duplicates) {
    for (const ns of dup.remove) {
      try { await noShows.remove(ns.id); deleted++; }
      catch (e) { console.warn("noShow", ns.id, e); failed++; }
    }
  }
  for (const f of dupeFines) {
    try { await fines.remove(f.id); deleted++; }
    catch (e) { console.warn("fine", f.id, e); failed++; }
  }

  $("settings-dedupe-status").textContent = `Removed ${deleted}${failed ? " (" + failed + " failed)" : ""} ✓`;
  toast(`Removed ${deleted} duplicate record${deleted === 1 ? "" : "s"}${failed ? ` — ${failed} failed (see console)` : ""}`);
});

// ===================================================================
// MAINTENANCE — Orphan notifications cleanup
// ===================================================================
// Notifications whose relatedId points to a record that no longer
// exists. Common cause: meeting deleted before Stage 5C cascade fix.
// ===================================================================
$("settings-cleanup-notifs").addEventListener("click", async () => {
  if (!state.user || !state.user.isExec) {
    return toast("Only exec can run cleanup", true);
  }

  // Build set of all live IDs that notifications might reference
  const liveIds = new Set();
  state.meetings.forEach(m => liveIds.add(m.id));
  state.noShows.forEach(n => liveIds.add(n.id));
  state.fines.forEach(f => liveIds.add(f.id));
  state.absenceRequests.forEach(r => liveIds.add(r.id));

  // Orphan = has a relatedId that's not in any live collection.
  // Notifications with no relatedId are kept (legacy/system messages).
  const orphans = state.notifications.filter(n =>
    n.relatedId && !liveIds.has(n.relatedId)
  );

  if (orphans.length === 0) {
    $("settings-cleanup-notifs-status").textContent = "No orphans found ✓";
    toast("No orphaned notifications");
    return;
  }

  const ok = confirm(
    `Found ${orphans.length} orphaned notification${orphans.length === 1 ? "" : "s"} ` +
    `(notifications whose source record was deleted). Delete them all? Cannot be undone.`
  );
  if (!ok) return;

  $("settings-cleanup-notifs-status").textContent = "Cleaning...";

  let deleted = 0;
  let failed = 0;

  // Batch deletes for performance with 500+ records
  for (let i = 0; i < orphans.length; i += 50) {
    const batch = orphans.slice(i, i + 50);
    await Promise.all(batch.map(n =>
      notifications.remove(n.id)
        .then(() => deleted++)
        .catch(e => { console.warn("notif", n.id, e); failed++; })
    ));
    // Show progress for big batches
    if (orphans.length > 100) {
      $("settings-cleanup-notifs-status").textContent = `Cleaning... ${deleted}/${orphans.length}`;
    }
  }

  $("settings-cleanup-notifs-status").textContent = `Cleaned ${deleted}${failed ? " (" + failed + " failed)" : ""} ✓`;
  toast(`Cleaned up ${deleted} orphan notification${deleted === 1 ? "" : "s"}${failed ? ` — ${failed} failed (see console)` : ""}`);
});

// ===================================================================
// NOW WIDGETS: live clock + Westwood weather (Open-Meteo, no API key)
// Self-contained. If the weather service is unreachable the weather
// card simply hides; nothing else on the page depends on it.
// ===================================================================
var _wx = null;   // latest weather payload (var: safe to read before init)
const NW_TZ = "America/Los_Angeles";
const NW_URL = "https://api.open-meteo.com/v1/forecast?latitude=34.0689&longitude=-118.4452" +
  "&current=temperature_2m,weather_code,is_day&daily=temperature_2m_max,temperature_2m_min" +
  "&hourly=temperature_2m,weather_code&temperature_unit=fahrenheit&timezone=America%2FLos_Angeles&forecast_days=16";

function wxDescribe(code, isDay) {
  const c = Number(code);
  if (c === 0) return { label: "Clear", kind: isDay ? "sun" : "moon" };
  if (c === 1) return { label: "Mostly clear", kind: isDay ? "sun" : "moon" };
  if (c === 2) return { label: "Partly cloudy", kind: isDay ? "sun-cloud" : "moon-cloud" };
  if (c === 3) return { label: "Overcast", kind: "cloud" };
  if (c === 45 || c === 48) return { label: "Fog", kind: "cloud" };
  if (c >= 51 && c <= 57) return { label: "Drizzle", kind: "rain" };
  if ((c >= 61 && c <= 67) || (c >= 80 && c <= 82)) return { label: "Rain", kind: "rain" };
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return { label: "Snow", kind: "rain" };
  if (c >= 95) return { label: "Thunderstorms", kind: "rain" };
  return { label: "—", kind: "cloud" };
}

function wxIcon(kind) {
  const sun  = `<span class="nw-sun"><span class="nw-sun-core"></span><span class="nw-sun-glow"></span></span>`;
  const moon = `<svg class="nw-moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>`;
  const cloud = cls => `<svg class="nw-cloud ${cls || ""}" viewBox="0 0 64 40" aria-hidden="true"><path d="M50 38H16a14 14 0 0 1-1.8-27.9A18 18 0 0 1 49 12a13 13 0 0 1 1 26z"/></svg>`;
  const drops = `<span class="nw-drops"><i></i><i></i><i></i></span>`;
  if (kind === "sun") return sun;
  if (kind === "moon") return moon;
  if (kind === "sun-cloud") return sun + cloud("is-front");
  if (kind === "moon-cloud") return moon + cloud("is-front");
  if (kind === "rain") return cloud("is-solo") + drops;
  return cloud("is-solo");
}

// Forecast for a specific local date + "HH:MM" (used by the Next Meeting card)
function wxForecastAt(dateStr, timeStr) {
  if (!_wx || !_wx.hourly || !dateStr) return null;
  const hr = String(timeStr || "19:00").slice(0, 2);
  const i = _wx.hourly.time.indexOf(`${dateStr}T${hr}:00`);
  if (i < 0) return null;
  const hour = Number(hr);
  return { temp: Math.round(_wx.hourly.temperature_2m[i]), ...wxDescribe(_wx.hourly.weather_code[i], hour >= 6 && hour < 18) };
}

function nwTick() {
  const el = document.getElementById("nw-time");
  if (!el) return;
  const now = new Date();
  const t = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: NW_TZ });
  const [clock, ampm] = t.split(" ");
  const h = Number(now.toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: NW_TZ }));
  const day = now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: NW_TZ });
  const night = h >= 18 || h < 6;
  el.querySelector(".nw-clock").textContent = clock;
  el.querySelector(".nw-ampm").textContent = ampm || "";
  el.querySelector(".nw-day").textContent = day;
  const ic = el.querySelector(".nw-time-icon");
  const want = night ? "moon" : "sun";
  if (ic.dataset.kind !== want) { ic.dataset.kind = want; ic.innerHTML = wxIcon(want); }
  el.classList.toggle("is-night", night);
}

function nwRenderWeather() {
  const card = document.getElementById("nw-weather");
  if (!card) return;
  if (!_wx || !_wx.current) { card.hidden = true; return; }
  const c = _wx.current;
  const d = wxDescribe(c.weather_code, c.is_day === 1);
  const hi = _wx.daily ? Math.round(_wx.daily.temperature_2m_max[0]) : null;
  const lo = _wx.daily ? Math.round(_wx.daily.temperature_2m_min[0]) : null;
  card.hidden = false;
  card.innerHTML = `
    <div class="nw-wx-art">${wxIcon(d.kind)}</div>
    <div class="nw-wx-head"><span class="nw-wx-place">Westwood</span><span class="nw-wx-sub">UCLA · Los Angeles</span></div>
    <div class="nw-wx-temp">${Math.round(c.temperature_2m)}<span>°F</span></div>
    <div class="nw-wx-meta">${hi != null ? `H ${hi}° · L ${lo}°` : ""}</div>
    <div class="nw-wx-pill">${escapeHtml(d.label)}</div>`;
}

async function nwFetchWeather() {
  try {
    const res = await fetch(NW_URL);
    if (!res.ok) throw new Error("HTTP " + res.status);
    _wx = await res.json();
  } catch (e) {
    console.warn("Weather unavailable:", e.message || e);
  }
  nwRenderWeather();
  if (typeof nwOnWeather === "function") { try { nwOnWeather(); } catch (e) {} }
}

function initNowWidgets() {
  const slot = document.getElementById("now-widgets");
  if (!slot) return;
  slot.innerHTML = `
    <div class="nw-row">
      <div class="nw-card nw-time" id="nw-time">
        <div class="nw-time-icon"></div>
        <div class="nw-label">Right now</div>
        <div><span class="nw-clock"></span><span class="nw-ampm"></span></div>
        <div class="nw-day"></div>
      </div>
      <div class="nw-card nw-weather" id="nw-weather" hidden></div>
    </div>`;
  nwTick();
  setInterval(nwTick, 15000);
  nwFetchWeather();
  setInterval(nwFetchWeather, 30 * 60 * 1000);
}


// When weather arrives, refresh the Next Meeting card so it can show the forecast
function nwOnWeather() { try { renderRollCallTab(); } catch (e) {} }
// ===================================================================
// GET STARTED GUIDE: step checklist with progress + troubleshooting
// ===================================================================
const GS_CHECK = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m8.5 12.5 2.3 2.3 4.7-5.1"/></svg>`;
const GS_OPEN  = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/></svg>`;

function pikeRenderGetStarted(el, cfg) {
  if (!el) return;
  const done = cfg.steps.filter(s => s.done).length;
  const total = cfg.steps.length;
  const pct = Math.round((done / total) * 100);
  const html = `
    <details class="gs-card" id="gs-details">
      <summary>
        <div class="gs-head">
          <span class="gs-eyebrow">${done === total ? "All set" : "Get started"}</span>
          <span class="gs-count">${done} of ${total} steps</span>
        </div>
        <div class="gs-title">${escapeHtml(cfg.title)}</div>
        <div class="gs-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></div>
      </summary>
      <ol class="gs-steps">
        ${cfg.steps.map(s => `
          <li class="${s.done ? "is-done" : ""}">
            <span class="gs-icon">${s.done ? GS_CHECK : GS_OPEN}</span>
            <span><span class="gs-label">${escapeHtml(s.label)}</span>
            ${s.detail ? `<span class="gs-detail">${escapeHtml(s.detail)}</span>` : ""}</span>
          </li>`).join("")}
      </ol>
      <div class="gs-help">
        <div class="gs-help-title">Having trouble?</div>
        <div class="gs-tips">
          ${cfg.tips.map(t => `<div class="gs-tip"><div class="gs-tip-q">${escapeHtml(t.q)}</div><div class="gs-tip-a">${escapeHtml(t.a)}</div></div>`).join("")}
        </div>
        <button class="btn btn-ghost btn-small gs-refresh" type="button">Refresh page</button>
      </div>
    </details>`;
  if (el.dataset.html === html) return;
  const prev = el.querySelector("#gs-details");
  const wasOpen = prev ? prev.open : null;
  el.dataset.html = html;
  el.innerHTML = html;
  const det = el.querySelector("#gs-details");
  det.open = wasOpen != null && el.dataset.touched === "1" ? wasOpen : !!cfg.startOpen;
  det.addEventListener("toggle", () => { el.dataset.touched = "1"; });
  el.querySelector(".gs-refresh").addEventListener("click", () => window.location.reload());
}

function renderGetStartedMeetings() {
  const u = state.user, me = u && u.rosterEntry;
  const upcoming = state.meetings.some(m => { const w = qrWindow(m); return w.isFuture || w.isOpen; });
  const checked = !!me && state.attendance.some(a => a.brotherKey === me.key && inQuarter(a));
  pikeRenderGetStarted($("get-started"), {
    title: "Checking in to chapter meetings",
    startOpen: !u,
    steps: [
      { label: "Sign in with your chapter Gmail", done: !!u,
        detail: u ? "" : "Tap Sign In with Google at the top. Use the Gmail the chapter has on file." },
      { label: "Get matched to the roster", done: !!me,
        detail: me ? "" : "Your Gmail has to be on the chapter roster. Ask an exec to add it in the Event Tracker's Roster tab." },
      { label: "Find your next meeting", done: upcoming,
        detail: upcoming ? "" : "Nothing is scheduled yet. Expecting one? Refresh the page." },
      { label: "Check in at roll call", done: checked,
        detail: checked ? "" : "Mark Me Present appears on this tab 15 minutes before start. Scanning the QR code at the meeting brings you here too." },
    ],
    tips: [
      { q: "Don't see your meeting?", a: "Refresh the page. New meetings appear as soon as the secretary posts them, but a tab left open can fall behind." },
      { q: "Mark Me Present isn't showing?", a: "Roll call only opens from 15 minutes before start until a few minutes after. Check the countdown on the Next Meeting card." },
      { q: "Sign-in popup won't open?", a: "Allow pop-ups for this site, or open the link in Safari or Chrome instead of an in-app browser (GroupMe, Instagram)." },
      { q: "Signed in with the wrong account?", a: "Tap Sign out at the top, then sign in with the Gmail the chapter has on file." },
    ],
  });
}
// ===================================================================
// THEME SWITCHER: System / Light / Dark (saved per browser)
// ===================================================================
const THEME_ICONS = {
  system: `<svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>`,
  light:  `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>`,
  dark:   `<svg viewBox="0 0 24 24"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/><path d="M19 3v4M21 5h-4"/></svg>`,
};
const THEME_ORDER = ["system", "light", "dark"];
function themeGet() { try { return localStorage.getItem("pike-theme") || "system"; } catch (e) { return "system"; } }
function themeApply(pref) {
  const dark = pref === "dark" || (pref === "system" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
}
function initThemeSwitcher() {
  const bar = document.querySelector(".auth-bar");
  if (!bar || document.querySelector(".theme-switch")) return;
  const wrap = document.createElement("div");
  wrap.className = "theme-switch"; wrap.setAttribute("role", "radiogroup"); wrap.setAttribute("aria-label", "Color theme");
  wrap.innerHTML = `<span class="ts-pill" aria-hidden="true"></span>` + THEME_ORDER.map(v =>
    `<button type="button" role="radio" data-theme-value="${v}" aria-label="${v[0].toUpperCase() + v.slice(1)} theme" title="${v[0].toUpperCase() + v.slice(1)}">${THEME_ICONS[v]}</button>`).join("");
  bar.insertBefore(wrap, bar.firstChild);
  const sync = () => {
    const pref = themeGet();
    wrap.querySelectorAll("button").forEach(b => b.setAttribute("aria-checked", String(b.dataset.themeValue === pref)));
    wrap.querySelector(".ts-pill").style.transform = `translateX(${THEME_ORDER.indexOf(pref) * 34}px)`;
  };
  wrap.addEventListener("click", e => {
    const b = e.target.closest("button[data-theme-value]"); if (!b) return;
    try { localStorage.setItem("pike-theme", b.dataset.themeValue); } catch (err) {}
    themeApply(b.dataset.themeValue); sync();
  });
  wrap.addEventListener("keydown", e => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const i = THEME_ORDER.indexOf(themeGet()), n = (i + (e.key === "ArrowRight" ? 1 : 2)) % 3;
    wrap.querySelectorAll("button")[n].click(); wrap.querySelectorAll("button")[n].focus();
  });
  try { window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (themeGet() === "system") themeApply("system"); }); } catch (e) {}
  themeApply(themeGet()); sync();
}

// ===================================================================
// MOBILE DOCK: floating bottom navigation that mirrors the tab bar.
// Each dock button just clicks the matching .tab, so app logic is shared.
// ===================================================================
const DOCK_ICONS = {
  rollcall:   '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  checkin:    '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  meetings:   '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  events:     '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M8 14h.01M12 14h.01M16 14h.01"/>',
  absence:    '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M10 14l4 4M14 14l-4 4"/>',
  reports:    '<path d="M3 3v18h18"/><path d="M7 16v-4M12 16V8M17 16v-7"/>',
  attendance: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  roster:     '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  dispatch:   '<path d="M4 4h13a1 1 0 0 1 1 1v13a2 2 0 0 0 2 2H6a2 2 0 0 1-2-2z"/><path d="M18 8h2v10a2 2 0 0 1-2 2"/><path d="M8 8h6M8 12h6M8 16h4"/>',
  settings:   '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
};
const DOCK_SHORT = { dispatch: "Updates", absence: "Absences", rollcall: "Roll Call", checkin: "Check In" };
function initDock() {
  const tabs = [...document.querySelectorAll(".tabs .tab")];
  if (!tabs.length || document.getElementById("pike-dock")) return;
  const dock = document.createElement("nav");
  dock.id = "pike-dock"; dock.setAttribute("aria-label", "Sections");
  dock.innerHTML = tabs.map(t => {
    const k = t.dataset.tab;
    return `<button type="button" class="dock-item" data-dock="${k}" aria-label="${escapeHtml(t.textContent.trim())}">
      <span class="dock-icon"><svg viewBox="0 0 24 24" aria-hidden="true">${DOCK_ICONS[k] || DOCK_ICONS.meetings}</svg></span>
      <span class="dock-label">${escapeHtml(DOCK_SHORT[k] || t.textContent.trim())}</span></button>`;
  }).join("");
  document.body.appendChild(dock);
  dock.addEventListener("click", e => {
    const b = e.target.closest(".dock-item"); if (!b) return;
    const t = document.querySelector(`.tabs .tab[data-tab="${b.dataset.dock}"]`);
    if (t) { t.click(); window.scrollTo({ top: 0, behavior: "smooth" }); }
  });
  const sync = () => {
    tabs.forEach(t => {
      const b = dock.querySelector(`[data-dock="${t.dataset.tab}"]`); if (!b) return;
      b.classList.toggle("is-active", t.classList.contains("active"));
      b.setAttribute("aria-current", t.classList.contains("active") ? "page" : "false");
      b.hidden = getComputedStyle(t).display === "none";   // mirror role-hidden tabs
    });
  };
  new MutationObserver(sync).observe(document.querySelector(".tabs"), { subtree: true, attributes: true, attributeFilter: ["class", "style"] });
  new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  sync();
}


// ===================================================================
// RECURRING MEETINGS
// A series is just ordinary meetings that share a seriesId, so roll call,
// absence requests, no-shows and fines work on each one exactly as before.
// ===================================================================
const SERIES_MAX = 26;
function _ymd(d) { const p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
function _addDays(ymd, n) { const [y, m, d] = ymd.split("-").map(Number); const dt = new Date(y, m - 1, d); dt.setDate(dt.getDate() + n); return _ymd(dt); }
function fmtDateShort(ymd) { const [y, m, d] = ymd.split("-").map(Number); return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" }); }

function seriesDates() {
  const first = $("mtg-date")?.value, until = $("mtg-until")?.value;
  const step = Number($("mtg-repeat")?.value || 0);
  if (!first || !step || !until || until < first) return first ? [first] : [];
  const out = [];
  for (let d = first; d <= until && out.length < SERIES_MAX; d = _addDays(d, step)) out.push(d);
  return out;
}

function updateRepeatPreview(resetUntil) {
  const step = Number($("mtg-repeat")?.value || 0);
  const wrap = $("mtg-until-wrap"), prev = $("mtg-repeat-preview"), until = $("mtg-until");
  const mand = $("mtg-mandatory"), mandRow = $("mtg-mandatory-row");
  if (!wrap || !prev || !until) return;
  wrap.hidden = !step; prev.hidden = !step;
  if (mandRow) mandRow.classList.toggle("is-off-for-series", !!step);
  if (mand && step) mand.checked = false;
  if (!step) { prev.textContent = ""; updateLeadTimeHint(); return; }
  const first = $("mtg-date")?.value;
  if (first && (resetUntil || !until.value || until.value < first)) until.value = _addDays(first, step * 9); // ~one quarter
  if (first) until.min = first;
  const dates = seriesDates();
  const taken = new Set(state.meetings.map(m => m.date));
  const dup = dates.filter(d => taken.has(d)).length;
  const capped = dates.length >= SERIES_MAX && _addDays(dates[dates.length - 1], step) <= until.value;
  const newCount = dates.length - dup;
  prev.innerHTML = dates.length
    ? `<strong>${newCount} new meeting${newCount === 1 ? "" : "s"}</strong>: ` +
      dates.map(d => taken.has(d)
        ? `<span class="mtg-date-chip is-skip" title="Already has a meeting">${fmtDateShort(d)}</span>`
        : `<span class="mtg-date-chip">${fmtDateShort(d)}</span>`).join(" · ") +
      (dup ? `<div class="mtg-repeat-note">${dup === 1 ? "The crossed-out date already has a meeting, so it will be skipped." : `The ${dup} crossed-out dates already have meetings, so they will be skipped.`}</div>` : "") +
      (capped ? `<div class="mtg-repeat-note">Capped at ${SERIES_MAX} meetings per series.</div>` : "") +
      `<div class="mtg-repeat-note">Recurring meetings can't be mandatory.</div>`
    : "Pick an end date on or after the first meeting.";
  updateLeadTimeHint();
}

async function createMeetingSeries({ title, startTime, endTime, location, qrWin, repeatDays }) {
  const dates = seriesDates();
  if (!dates.length) return toast("Pick a first date and an end date", true);
  const first = dates[0];
  if (combineLocalDateTime(first, endTime).getTime() <= combineLocalDateTime(first, startTime).getTime())
    return toast("End time must be after start time", true);
  const taken = new Set(state.meetings.map(m => m.date));
  const todo = dates.filter(d => !taken.has(d));
  if (!todo.length) return toast("Every one of those dates already has a meeting", true);
  const hoursOut = (combineLocalDateTime(todo[0], startTime).getTime() - Date.now()) / 3600000;
  const lead = hoursOut < 48 ? `\n\nHeads up: the first one is less than 48 hours away, so brothers can't request an absence for it in the app.` : "";
  if (!confirm(`Create ${todo.length} "${title}" meeting${todo.length === 1 ? "" : "s"}, ${repeatDays === 14 ? "every 2 weeks" : "every week"} at ${fmtTime(startTime)}, from ${fmtDateShort(todo[0])} to ${fmtDateShort(todo[todo.length - 1])}?${lead}`)) return;

  const seriesId = "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const btn = $("mtg-create"); if (btn) { btn.disabled = true; btn.textContent = "Creating…"; }
  let made = 0;
  try {
    for (const date of todo) {
      await meetings.create({ title, date, startTime, endTime, location, mandatory: false, qrWindowMinutes: qrWin, seriesId, repeatDays });
      made++;
    }
    $("mtg-title").value = ""; $("mtg-location").value = ""; $("mtg-repeat").value = "0";
    updateRepeatPreview(); updateLeadTimeHint();
    toast(`Created ${made} recurring meetings`);
  } catch (e) {
    console.error(e);
    toast(made ? `Created ${made} of ${todo.length}, then hit an error. Check the list.` : "Permission denied — exec sign-in required", true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Create Meeting"; }
  }
}


// ===================================================================
// THE DISPATCH: the chapter's weekly newsletter
// Exec writes an issue after chapter (recap, decisions, announcements,
// shoutouts). Brothers read the latest issue and browse the archive.
// Attendance numbers and "coming up" are filled in automatically.
// ===================================================================
let _dispatchEditorFor = null;   // which issue the editor was built for ("new" | id | null)
let _dispatchPaperHtml = "";

function dispatchIssues() {
  const map = (state.settings && state.settings.dispatch) || {};
  return Object.values(map).filter(i => i && i.id)
    .sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.publishedAt || b.updatedAt || 0) - (a.publishedAt || a.updatedAt || 0));
}
function dispatchPublished() { return dispatchIssues().filter(i => i.status === "published"); }

// Safe, tiny formatter: blank line = new paragraph, "- " lines = bullets, **bold**, *italic*
function dispatchInline(t) {
  return escapeHtml(t).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, "$1<em>$2</em>");
}
function dispatchFormat(text) {
  return String(text || "").trim().split(/\n\s*\n/).map(block => {
    const lines = block.split("\n").map(l => l.trim()).filter(Boolean);
    if (!lines.length) return "";
    if (lines.every(l => /^[-•*]\s+/.test(l)))
      return `<ul>${lines.map(l => `<li>${dispatchInline(l.replace(/^[-•*]\s+/, ""))}</li>`).join("")}</ul>`;
    return `<p>${lines.map(dispatchInline).join("<br>")}</p>`;
  }).join("");
}
function dispatchList(text) {
  const items = String(text || "").split("\n").map(l => l.trim().replace(/^[-•*]\s+/, "")).filter(Boolean);
  return items.length ? `<ul>${items.map(i => `<li>${dispatchInline(i)}</li>`).join("")}</ul>` : "";
}

function dispatchIssueNumber(issue) {
  const q = getQuarterForDate(issue.date);
  const same = dispatchPublished().filter(i => getQuarterForDate(i.date) === q)
    .sort((a, b) => a.date.localeCompare(b.date) || (a.publishedAt || 0) - (b.publishedAt || 0));
  const n = same.findIndex(i => i.id === issue.id);
  return { vol: formatQuarter(q), no: n >= 0 ? n + 1 : same.length + 1 };
}

function dispatchNumbers(issue) {
  const m = issue.meetingId ? state.meetings.find(x => x.id === issue.meetingId) : null;
  const cells = [];
  if (m) {
    const present = new Set(state.attendance.filter(a => a.meetingId === m.id).map(a => a.brotherKey)).size;
    const eligible = state.roster.filter(brotherIsEligible).length;
    const excused = state.absenceRequests.filter(r => r.meetingId === m.id && r.status === "approved").length;
    if (present || combineLocalDateTime(m.date, m.startTime).getTime() < Date.now()) {
      cells.push({ big: String(present), small: `of ${eligible} brothers present` });
      if (eligible) cells.push({ big: Math.round(present / eligible * 100) + "%", small: "attendance" });
      cells.push({ big: String(excused), small: `excused absence${excused === 1 ? "" : "s"}` });
    }
  }
  const after = issue.date || new Date().toISOString().slice(0, 10);
  const nextMtgs = state.meetings.filter(x => x.date > after).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 3)
    .map(x => ({ key: x.date + " " + (x.startTime || ""), when: fmtDateShort(x.date) + ", " + fmtTime(x.startTime), what: x.title + (x.mandatory ? " · mandatory" : "") }));
  const nextEvents = (state.events || []).filter(e => e.date && e.date > after).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 3)
    .map(e => ({ key: e.date + " 99", when: fmtDateShort(e.date), what: e.name + (e.type ? " · " + e.type : "") }));
  return { meeting: m, cells, upcoming: [...nextMtgs, ...nextEvents].sort((a, b) => a.key.localeCompare(b.key)).slice(0, 5) };
}

function renderDispatchPaper(issue) {
  const { vol, no } = dispatchIssueNumber(issue);
  const { meeting, cells, upcoming } = dispatchNumbers(issue);
  const dateLong = issue.date ? fmtDateLong(issue.date) : "";
  const sec = (title, body) => body ? `<section class="dp-section"><h3 class="dp-kicker">${title}</h3>${body}</section>` : "";
  return `
  <article class="dispatch-paper${issue.status !== "published" ? " is-draft" : ""}" aria-label="Chapter Updates">
    ${issue.status !== "published" ? `<div class="dp-draft-flag">Draft · only exec can see this</div>` : ""}
    <div class="dp-masthead">
      <div class="dp-topline"><span>UCLA · Iota Pi Chapter</span><span>Pi Kappa Alpha</span></div>
      <h2 class="dp-name">Chapter Updates</h2>
      <div class="dp-rule"></div>
      <div class="dp-issueline"><span>${escapeHtml(vol)} · No. ${no}</span><span>${escapeHtml(dateLong)}</span><span>${meeting ? escapeHtml(meeting.title) : "Chapter Edition"}</span></div>
    </div>
    <h1 class="dp-headline">${escapeHtml(issue.headline || "Untitled update")}</h1>
    ${issue.dek ? `<p class="dp-dek">${escapeHtml(issue.dek)}</p>` : ""}
    <div class="dp-byline">By ${escapeHtml(issue.author || "the Secretary")}</div>
    <div class="dp-body">
      <div class="dp-main">
        ${issue.recap ? `<section class="dp-section dp-recap"><h3 class="dp-kicker">The Recap</h3>${dispatchFormat(issue.recap)}</section>` : ""}
        ${sec("Motions &amp; Decisions", dispatchList(issue.decisions))}
        ${sec("Announcements", dispatchList(issue.announcements))}
        ${sec("Shoutouts", dispatchList(issue.shoutouts))}
      </div>
      <aside class="dp-side">
        ${cells.length ? `<section class="dp-box"><h3 class="dp-kicker">By the Numbers</h3>${cells.map(c => `<div class="dp-stat"><span class="dp-stat-big">${escapeHtml(c.big)}</span><span class="dp-stat-small">${escapeHtml(c.small)}</span></div>`).join("")}</section>` : ""}
        ${upcoming.length ? `<section class="dp-box"><h3 class="dp-kicker">Coming Up</h3><ul class="dp-upcoming">${upcoming.map(u => `<li><span class="dp-when">${escapeHtml(u.when)}</span>${escapeHtml(u.what)}</li>`).join("")}</ul></section>` : ""}
      </aside>
    </div>
    <div class="dp-foot"><img src="assets/brand/symbol-gold.png" alt="" class="dp-mark"><span>Courage to be More</span></div>
  </article>`;
}

function renderDispatchTab() {
  const toolbar = $("dispatch-toolbar"), paperWrap = $("dispatch-paper-wrap"), archive = $("dispatch-archive"), editor = $("dispatch-editor");
  if (!toolbar || !paperWrap) return;
  const isExec = !!(state.user && state.user.isExec);

  if (!state.user) {
    toolbar.innerHTML = ""; editor.innerHTML = ""; _dispatchEditorFor = null; archive.innerHTML = "";
    const html = `<div class="card dp-empty"><div class="card-title">Chapter Updates</div><div class="card-sub">Weekly recaps from chapter</div><p>Sign in to read the latest update.</p></div>`;
    if (_dispatchPaperHtml !== html) { paperWrap.innerHTML = html; _dispatchPaperHtml = html; }
    return;
  }

  const all = isExec ? dispatchIssues() : dispatchPublished();
  const published = dispatchPublished();
  const drafts = isExec ? all.filter(i => i.status !== "published") : [];
  let current = all.find(i => i.id === state.dispatchView) || published[0] || null;

  // Toolbar
  const tb = `
    <div class="dp-toolbar">
      ${isExec ? `<button class="btn" type="button" id="dp-new">✎ Write an update</button>` : ""}
      ${current ? `<button class="btn btn-ghost" type="button" id="dp-print">Print / Save PDF</button>
                   <button class="btn btn-ghost" type="button" id="dp-link">Copy link</button>` : ""}
      ${isExec && current ? `<button class="btn btn-ghost" type="button" id="dp-edit">Edit this update</button>` : ""}
    </div>
    ${drafts.length ? `<div class="dp-drafts"><span class="dp-drafts-label">Your drafts</span>${drafts.map(d => `<button type="button" class="dp-chip${current && current.id === d.id ? " is-on" : ""}" data-dp-view="${d.id}">${escapeHtml(d.headline || "Untitled")} · ${fmtDateShort(d.date)}</button>`).join("")}</div>` : ""}`;
  if (toolbar.dataset.html !== tb) {
    toolbar.dataset.html = tb; toolbar.innerHTML = tb;
    $("dp-new")?.addEventListener("click", () => openDispatchEditor("new"));
    $("dp-edit")?.addEventListener("click", () => openDispatchEditor(current.id));
    $("dp-print")?.addEventListener("click", () => { document.body.classList.add("printing-dispatch"); setTimeout(() => { window.print(); document.body.classList.remove("printing-dispatch"); }, 50); });
    $("dp-link")?.addEventListener("click", async () => {
      const url = location.origin + location.pathname + "#dispatch=" + current.id;
      try { await navigator.clipboard.writeText(url); toast("Link copied"); } catch (e) { prompt("Copy this link:", url); }
    });
    toolbar.querySelectorAll("[data-dp-view]").forEach(b => b.addEventListener("click", () => { state.dispatchView = b.dataset.dpView; renderDispatchTab(); }));
  }

  // Paper
  const paper = current ? renderDispatchPaper(current)
    : `<div class="card dp-empty"><div class="card-title">Chapter Updates</div><div class="card-sub">Weekly recaps from chapter</div>
       <p>${isExec ? "No updates yet. Write the first one after your next chapter meeting: a short recap, what was decided, announcements and shoutouts. Attendance numbers and upcoming meetings fill in on their own." : "No updates yet. The Secretary will post a recap after chapter."}</p></div>`;
  if (_dispatchPaperHtml !== paper) { paperWrap.innerHTML = paper; _dispatchPaperHtml = paper; }

  // Archive
  const arch = published.length > 1 || (published.length && current && current.status !== "published")
    ? `<div class="card dp-archive"><div class="card-title">Past Updates</div><div class="card-sub">${published.length} published</div>
        <ul class="dp-archive-list">${published.map(i => {
          const { vol, no } = dispatchIssueNumber(i);
          return `<li><button type="button" class="dp-archive-item${current && current.id === i.id ? " is-on" : ""}" data-dp-view="${i.id}">
            <span class="dp-archive-date">${fmtDateShort(i.date)}</span>
            <span class="dp-archive-head">${escapeHtml(i.headline || "Untitled")}</span>
            <span class="dp-archive-no">${escapeHtml(vol)} · No. ${no}</span></button></li>`; }).join("")}</ul></div>`
    : "";
  if (archive.dataset.html !== arch) {
    archive.dataset.html = arch; archive.innerHTML = arch;
    archive.querySelectorAll("[data-dp-view]").forEach(b => b.addEventListener("click", () => {
      state.dispatchView = b.dataset.dpView; renderDispatchTab(); markUpdatesRead(b.dataset.dpView);
      paperWrap.scrollIntoView({ behavior: "smooth", block: "start" });
    }));
  }

  if (!isExec && _dispatchEditorFor) { editor.innerHTML = ""; _dispatchEditorFor = null; }
}

function openDispatchEditor(which) {
  const editor = $("dispatch-editor"); if (!editor) return;
  const existing = which !== "new" ? dispatchIssues().find(i => i.id === which) : null;
  const today = new Date().toISOString().slice(0, 10);
  const covered = new Set(dispatchIssues().map(i => i.meetingId).filter(Boolean));
  const recent = state.meetings.filter(m => m.date <= today).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 12);
  const defMeeting = existing ? existing.meetingId : (recent.find(m => !covered.has(m.id)) || recent[0] || {}).id || "";
  const me = state.user.rosterEntry;
  const v = existing || {};
  _dispatchEditorFor = which;
  editor.innerHTML = `
    <div class="card dp-editor">
      <div class="card-title">${existing ? "Edit update" : "Write an update"}</div>
      <div class="card-sub">Keep it short. Brothers read this on their phones.</div>
      <div class="row-2">
        <div>
          <label for="dp-meeting">Chapter meeting it covers</label>
          <select id="dp-meeting">
            <option value="">None (special edition)</option>
            ${recent.map(m => `<option value="${m.id}"${m.id === defMeeting ? " selected" : ""}>${escapeHtml(m.title)} · ${fmtDateShort(m.date)}</option>`).join("")}
          </select>
        </div>
        <div>
          <label for="dp-date">Date</label>
          <input type="date" id="dp-date" value="${escapeHtml(v.date || (recent.find(m => m.id === defMeeting) || {}).date || today)}">
        </div>
      </div>
      <label for="dp-headline">Headline</label>
      <input type="text" id="dp-headline" maxlength="90" placeholder="Philanthropy week is here" value="${escapeHtml(v.headline || "")}">
      <label for="dp-dek">Subheadline <span class="dp-opt">(optional)</span></label>
      <input type="text" id="dp-dek" maxlength="160" placeholder="Plus: new member ed schedule and a formal date" value="${escapeHtml(v.dek || "")}">
      <label for="dp-recap">The recap</label>
      <textarea id="dp-recap" rows="6" placeholder="What happened at chapter. Leave a blank line between paragraphs. Use **bold** for emphasis.">${escapeHtml(v.recap || "")}</textarea>
      <div class="row-2">
        <div>
          <label for="dp-decisions">Motions &amp; decisions <span class="dp-opt">(one per line)</span></label>
          <textarea id="dp-decisions" rows="4" placeholder="Approved $300 for philanthropy supplies (18–4)">${escapeHtml(v.decisions || "")}</textarea>
        </div>
        <div>
          <label for="dp-announcements">Announcements <span class="dp-opt">(one per line)</span></label>
          <textarea id="dp-announcements" rows="4" placeholder="Dues are due Oct 15">${escapeHtml(v.announcements || "")}</textarea>
        </div>
      </div>
      <label for="dp-shoutouts">Shoutouts <span class="dp-opt">(one per line)</span></label>
      <textarea id="dp-shoutouts" rows="3" placeholder="Brother of the week: …">${escapeHtml(v.shoutouts || "")}</textarea>
      <label class="dp-notify"><input type="checkbox" id="dp-notify" ${existing && existing.status === "published" ? "" : "checked"}> Let brothers know when it's published</label>
      <div class="dp-editor-actions">
        <button class="btn" type="button" id="dp-publish">${existing && existing.status === "published" ? "Save changes" : "Publish"}</button>
        <button class="btn btn-ghost" type="button" id="dp-preview">Preview</button>
        ${!existing || existing.status !== "published" ? `<button class="btn btn-ghost" type="button" id="dp-save-draft">Save draft</button>` : ""}
        <button class="btn btn-ghost" type="button" id="dp-cancel">Close</button>
        ${existing ? `<button class="btn btn-danger" type="button" id="dp-delete">Delete</button>` : ""}
      </div>
    </div>`;
  $("dp-meeting").addEventListener("change", e => { const m = state.meetings.find(x => x.id === e.target.value); if (m) $("dp-date").value = m.date; });
  $("dp-cancel").addEventListener("click", closeDispatchEditor);
  $("dp-preview").addEventListener("click", () => {
    const draft = { ...(existing || {}), ...readDispatchForm(existing), status: existing ? existing.status : "draft" };
    $("dispatch-paper-wrap").innerHTML = renderDispatchPaper(draft); _dispatchPaperHtml = "";
    $("dispatch-paper-wrap").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $("dp-save-draft")?.addEventListener("click", () => saveDispatch(existing, "draft"));
  $("dp-publish").addEventListener("click", () => saveDispatch(existing, "published"));
  $("dp-delete")?.addEventListener("click", async () => {
    if (!confirm(`Delete "${existing.headline || "this update"}"? This can't be undone.`)) return;
    try { await settings.deleteDispatch(existing.id); state.dispatchView = null; closeDispatchEditor(); toast("Update deleted"); }
    catch (e) { console.error(e); toast("Couldn't delete. Exec sign-in required.", true); }
  });
  editor.scrollIntoView({ behavior: "smooth", block: "start" });
  $("dp-headline").focus({ preventScroll: true });
}
function closeDispatchEditor() { const ed = $("dispatch-editor"); if (ed) ed.innerHTML = ""; _dispatchEditorFor = null; _dispatchPaperHtml = ""; renderDispatchTab(); }

function readDispatchForm(existing) {
  const me = state.user && state.user.rosterEntry;
  return {
    meetingId: $("dp-meeting").value || "",
    date: $("dp-date").value || new Date().toISOString().slice(0, 10),
    headline: $("dp-headline").value.trim(),
    dek: $("dp-dek").value.trim(),
    recap: $("dp-recap").value.trim(),
    decisions: $("dp-decisions").value.trim(),
    announcements: $("dp-announcements").value.trim(),
    shoutouts: $("dp-shoutouts").value.trim(),
    author: (existing && existing.author) || (me ? `${me.firstName} ${me.lastName}` : (state.user.email || "").split("@")[0]),
    authorEmail: (existing && existing.authorEmail) || state.user.email || "",
  };
}

async function saveDispatch(existing, status) {
  if (!state.user || !state.user.isExec) return toast("Sign in as exec", true);
  const f = readDispatchForm(existing);
  if (!f.headline) return toast("Add a headline", true);
  if (status === "published" && !f.recap && !f.decisions && !f.announcements && !f.shoutouts)
    return toast("Write at least a recap or one announcement", true);
  const now = Date.now();
  const wasPublished = existing && existing.status === "published";
  const issue = {
    id: existing ? existing.id : "i" + now.toString(36),
    ...f, status,
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
    publishedAt: status === "published" ? (existing && existing.publishedAt) || now : null,
  };
  const notifyAll = status === "published" && !wasPublished && $("dp-notify")?.checked;
  const btns = [...document.querySelectorAll(".dp-editor-actions .btn")]; btns.forEach(b => b.disabled = true);
  try {
    await settings.saveDispatch(issue);
    state.dispatchView = issue.id;
    closeDispatchEditor();
    toast(status === "published" ? (wasPublished ? "Changes saved" : "Published") : "Draft saved");
    if (notifyAll) {
      const mine = String(state.user.email || "").toLowerCase();
      const list = state.roster.filter(brotherIsEligible).filter(b => b.email && String(b.email).toLowerCase() !== mine);
      let sent = 0;
      for (const b of list) {
        try { await notify(b.email, "dispatch", `📰 Chapter Update: ${issue.headline}`, issue.dek || (issue.recap || "").replace(/\s+/g, " ").slice(0, 160) || "A new chapter update is out. Open Chapter Updates to read it.", "info", issue.id); sent++; }
        catch (e) { console.warn("Dispatch notif failed for", b.email, e); }
      }
      if (sent) toast(`Published · ${sent} brother${sent === 1 ? "" : "s"} notified`);
    }
  } catch (e) {
    console.error(e);
    toast("Couldn't save. Exec sign-in required.", true);
  } finally { btns.forEach(b => b.disabled = false); }
}
function renderDispatchSafe() { try { renderDispatchTab(); } catch (e) { console.warn("Dispatch skipped:", e); } try { renderUpdatesTeaser(); } catch (e) { console.warn("Updates box skipped:", e); } }


// ---------- Landing-page box: latest chapter update + what you missed ----------
function _updReadKey() { return "pike-meetings:updatesRead:" + String((state.user && state.user.email) || "").toLowerCase(); }
function _updReadSet() { try { return new Set(JSON.parse(localStorage.getItem(_updReadKey()) || "[]")); } catch (e) { return new Set(); } }
// Mark one update as read (the one on screen). Older unread ones stay flagged until opened.
function markUpdatesRead(id) {
  if (!state.user) return;
  const pub = dispatchPublished();
  const target = id || state.dispatchView || (pub[0] && pub[0].id);
  if (!target || !pub.some(i => i.id === target)) return;
  const set = _updReadSet(); if (set.has(target)) return;
  set.add(target);
  try { localStorage.setItem(_updReadKey(), JSON.stringify([...set].slice(-200))); } catch (e) {}
  renderUpdatesTeaser();
}
function renderUpdatesTeaser() {
  const el = $("updates-teaser"); if (!el) return;
  const pub = state.user ? dispatchPublished() : [];
  if (!pub.length) { if (el.innerHTML) { el.innerHTML = ""; el.dataset.html = ""; } return; }
  const read = _updReadSet(), cutoff = Date.now() - 30 * 86400000;   // only flag the last 30 days
  const unread = pub.filter(i => !read.has(i.id) && (i.publishedAt || 0) > cutoff);
  const lead = unread[0] || pub[0];
  const snippet = lead.dek || String(lead.recap || "").replace(/[*_]/g, "").replace(/\s+/g, " ").slice(0, 120) + (String(lead.recap || "").length > 120 ? "…" : "");
  const tag = unread.length === 0 ? "Latest"
    : unread.length === 1 ? "New · you missed this"
    : `${unread.length} new · you missed these`;
  const more = unread.length > 1
    ? `<ul class="upd-more">${unread.slice(1, 3).map(i => `<li><button type="button" data-upd-open="${i.id}">${escapeHtml(i.headline || "Untitled update")}<span> · ${fmtDateShort(i.date)}</span></button></li>`).join("")}${unread.length > 3 ? `<li class="upd-more-count">+${unread.length - 3} more</li>` : ""}</ul>` : "";
  const html = `
    <section class="upd-teaser${unread.length ? " is-new" : ""}" aria-label="Chapter updates">
      <img class="upd-mark" src="assets/brand/symbol-gold.png" alt="">
      <div class="upd-body">
        <div class="upd-eyebrow"><span>Chapter Updates</span><span class="upd-tag">${escapeHtml(tag)}</span></div>
        <button type="button" class="upd-head" data-upd-open="${lead.id}">${escapeHtml(lead.headline || "Untitled update")}</button>
        <div class="upd-meta">${fmtDateShort(lead.date)}${snippet.trim() ? " · " + escapeHtml(snippet) : ""}</div>
        ${more}
      </div>
      <button type="button" class="btn btn-small upd-read" data-upd-open="${lead.id}">Read</button>
    </section>`;
  if (el.dataset.html === html) return;
  el.dataset.html = html; el.innerHTML = html;
  el.querySelectorAll("[data-upd-open]").forEach(b => b.addEventListener("click", () => {
    state.dispatchView = b.dataset.updOpen;
    activateTab("dispatch");
    renderDispatchSafe(); markUpdatesRead(b.dataset.updOpen);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }));
}
function renderUpdatesTeaserSafe() { try { renderUpdatesTeaser(); } catch (e) { console.warn("Updates box skipped:", e); } }
document.querySelector('.tab[data-tab="dispatch"]')?.addEventListener("click", () => setTimeout(() => markUpdatesRead(), 0));

// ===================================================================
// SIGNED-OUT WELCOME (split sign-in page)
// While Firebase is still checking who is signed in we show a quiet loader,
// so signed-in brothers never see the welcome page flash by.
// ===================================================================
const GOOGLE_G = '<svg class="g-icon" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"/><path fill="#FF3D00" d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"/><path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238A11.91 11.91 0 0 1 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"/><path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 0 1-4.087 5.571l6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"/></svg>';
let _heroBuilt = false;
function buildSigninHero() {
  const el = $("signin-hero"); if (!el || _heroBuilt) return;
  const fromQr = /meeting=/.test(location.hash);
  el.innerHTML = `
    <section class="hero" aria-label="Sign in">
      <div class="hero-left">
        <div class="hero-eyebrow hero-in d1">UCLA · Iota Pi Chapter</div>
        <h1 class="hero-title hero-in d2">Welcome, <em>brother.</em></h1>
        <p class="hero-desc hero-in d3">Sign in with the Gmail the chapter has on file to check in at chapter, see your standing and catch up on what you missed.</p>
        ${fromQr ? `<div class="hero-qr hero-in d3"><span class="hero-qr-dot"></span>You scanned a roll-call code. Sign in and you'll land right on check-in.</div>` : ""}
        <div class="hero-in d4" id="hero-signin-slot"></div>
        <p class="hero-help hero-in d5">Use the same Google account every time. Not recognized after signing in? Ask an exec to add your email to the roster.</p>
        <div class="hero-or hero-in d6"><span>Just checking in to an event?</span></div>
        <a class="hero-alt hero-in d7" href="https://uclapikes-hub.github.io/pike-attendance/"><span>Open the Event Tracker <span aria-hidden="true">→</span></span><small>No sign-in needed</small></a>
      </div>
      <div class="hero-right" aria-hidden="true">
        <img class="hero-crest" src="assets/brand/coa-outline-white.png" alt="">
        <div class="hero-brand hero-slide">
          <img class="hero-wordmark" src="assets/brand/wordmark-reversed.png" alt="">
          <div class="hero-sub">Chapter Meetings</div>
        </div>
        <div class="hero-cards">
          <div class="hero-card hero-pop d5"><span class="hc-icon"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M14 14h3v3M21 14v7h-7"/></svg></span><div><b>Scan in at chapter</b><span>Roll call takes one QR scan.</span></div></div>
          <div class="hero-card hero-pop d6"><span class="hc-icon"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M10 14l4 4M14 14l-4 4"/></svg></span><div><b>Can't make it?</b><span>Request an excused absence up to 48 hours before.</span></div></div>
          <div class="hero-card hero-pop d7"><span class="hc-icon"><svg viewBox="0 0 24 24"><path d="M4 4h13a1 1 0 0 1 1 1v13a2 2 0 0 0 2 2H6a2 2 0 0 1-2-2z"/><path d="M18 8h2v10a2 2 0 0 1-2 2"/><path d="M8 8h6M8 12h6M8 16h4"/></svg></span><div><b>Chapter Updates</b><span>A recap of every meeting and what's next.</span></div></div>
        </div>
      </div>
    </section>
    <div class="hero-loading" aria-live="polite"><span class="pike-spinner" aria-hidden="true"></span>Loading…</div>`;
  _heroBuilt = true;
}
function updateAuthChrome(user) {
  const resolved = !!(authApi.isResolved && authApi.isResolved());
  const out = !user && resolved;
  document.body.classList.toggle("auth-pending", !user && !resolved);
  document.body.classList.toggle("is-signed-out", out);
  const hero = $("signin-hero"), btn = $("auth-signin");
  if (!hero || !btn) return;
  if (!user) {
    buildSigninHero();
    hero.hidden = false;
    const slot = $("hero-signin-slot");
    if (slot && btn.parentElement !== slot) {
      slot.appendChild(btn);
      btn.innerHTML = GOOGLE_G + "<span>Continue with Google</span>";
    }
  } else {
    hero.hidden = true;
    const bar = document.querySelector(".auth-bar"), so = $("auth-signout");
    if (bar && btn.parentElement !== bar) { bar.insertBefore(btn, so); btn.textContent = "Sign In with Google"; }
  }
}

// ===================================================================
// CHAPTER CALENDAR: a month you swipe through, one day at a time.
// Dots mark meetings (garnet) and events (gold); tap a day for its agenda.
// ===================================================================
const _cal = { month: null, sel: null, lastScrollKey: "" };
function calYmd(d) { const p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
function calParse(ymd) { const [y, m, d] = ymd.split("-").map(Number); return new Date(y, m - 1, d); }
function calTime(t) {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number); const ap = h >= 12 ? "PM" : "AM";
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${ap}`;
}
function calEsc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

// items: [{ date:"YYYY-MM-DD", time:"19:00", title, where, kind:"meeting"|"event", tag, strong }]
function renderChapterCalendar(el, items, opts) {
  if (!el) return;
  opts = opts || {};
  const today = calYmd(new Date());
  if (!_cal.sel) _cal.sel = today;
  if (!_cal.month) { const d = calParse(_cal.sel); _cal.month = new Date(d.getFullYear(), d.getMonth(), 1); }
  const m0 = _cal.month, y = m0.getFullYear(), mo = m0.getMonth();
  const days = new Date(y, mo + 1, 0).getDate();
  const byDay = {};
  items.forEach(it => { if (it && it.date) (byDay[it.date] = byDay[it.date] || []).push(it); });
  Object.values(byDay).forEach(list => list.sort((a, b) => (a.time || "99").localeCompare(b.time || "99")));

  let strip = "";
  for (let i = 1; i <= days; i++) {
    const d = new Date(y, mo, i), key = calYmd(d), list = byDay[key] || [];
    const hasM = list.some(x => x.kind === "meeting"), hasE = list.some(x => x.kind === "event"), strong = list.some(x => x.strong);
    const cls = ["cal-day", key === _cal.sel ? "is-sel" : "", key === today ? "is-today" : "", key < today ? "is-past" : "", list.length ? "has-items" : ""].join(" ");
    const label = d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }) + (list.length ? `, ${list.length} item${list.length === 1 ? "" : "s"}` : "");
    strip += `<button type="button" class="${cls}" data-cal-day="${key}" aria-label="${calEsc(label)}" aria-pressed="${key === _cal.sel}">
      <span class="cal-dow">${d.toLocaleDateString(undefined, { weekday: "short" }).slice(0, 1)}</span>
      <span class="cal-num">${i}</span>
      <span class="cal-dots">${hasM ? `<i class="cal-dot is-m${strong ? " is-strong" : ""}"></i>` : ""}${hasE ? `<i class="cal-dot is-e"></i>` : ""}</span>
    </button>`;
  }

  const selList = byDay[_cal.sel] || [];
  const selDate = calParse(_cal.sel);
  const next = items.filter(it => it.date > _cal.sel).sort((a, b) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || "")))[0];
  const agenda = selList.length
    ? selList.map(it => `
      <div class="cal-item is-${it.kind}${it.strong ? " is-strong" : ""}">
        <div class="cal-time">${it.time ? calEsc(calTime(it.time)) : "All day"}</div>
        <div class="cal-what"><b>${calEsc(it.title)}</b>${it.where || it.tag ? `<span>${calEsc([it.where, it.tag].filter(Boolean).join(" · "))}</span>` : ""}</div>
        <span class="cal-kind">${it.kind === "meeting" ? "Meeting" : "Event"}</span>
      </div>`).join("")
    : `<div class="cal-empty">Nothing on the calendar${_cal.sel === today ? " today" : ""}.${next ? ` <button type="button" class="cal-jump" data-cal-jump="${next.date}">Next up: ${calEsc(next.title)} · ${calParse(next.date).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} →</button>` : ""}</div>`;
  const canAdd = opts.onAdd && opts.addLabel && _cal.sel >= today;

  const html = `
    <section class="cal" aria-label="Chapter calendar">
      <div class="cal-head">
        <div>
          <div class="cal-eyebrow">${calEsc(opts.eyebrow || "Chapter Calendar")}</div>
          <div class="cal-month">${m0.toLocaleDateString(undefined, { month: "long" })} <span>${y}</span></div>
        </div>
        <div class="cal-nav">
          <button type="button" class="cal-btn" data-cal-nav="-1" aria-label="Previous month"><svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg></button>
          <button type="button" class="cal-today" data-cal-nav="0">Today</button>
          <button type="button" class="cal-btn" data-cal-nav="1" aria-label="Next month"><svg viewBox="0 0 24 24"><path d="M9 18l6-6-6-6"/></svg></button>
        </div>
      </div>
      <div class="cal-strip-wrap"><div class="cal-strip">${strip}</div></div>
      <div class="cal-agenda">
        <div class="cal-agenda-head">
          <span class="cal-agenda-date">${selDate.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</span>
          <span class="cal-legend">${items.some(x => x.kind === "meeting") ? `<i class="cal-dot is-m"></i>Meeting` : ""}${items.some(x => x.kind === "event") ? `<i class="cal-dot is-e"></i>Event` : ""}</span>
        </div>
        ${agenda}
      </div>
      ${canAdd ? `<div class="cal-foot"><button type="button" class="cal-add" data-cal-add="${_cal.sel}"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>${calEsc(opts.addLabel)} ${selDate.toLocaleDateString(undefined, { month: "short", day: "numeric" })}</button></div>` : ""}
    </section>`;
  if (el.dataset.html !== html) {
    const prevWrap = el.querySelector(".cal-strip-wrap"), prevLeft = prevWrap ? prevWrap.scrollLeft : null;
    el.dataset.html = html; el.innerHTML = html;
    if (prevLeft != null && _cal.lastScrollKey === _cal.sel + "|" + y + mo) { const w2 = el.querySelector(".cal-strip-wrap"); if (w2) w2.scrollLeft = prevLeft; }
    el.querySelectorAll("[data-cal-day]").forEach(b => b.addEventListener("click", () => { _cal.sel = b.dataset.calDay; renderChapterCalendar(el, items, opts); }));
    el.querySelectorAll("[data-cal-nav]").forEach(b => b.addEventListener("click", () => {
      const step = Number(b.dataset.calNav);
      if (step === 0) { _cal.sel = today; const t = new Date(); _cal.month = new Date(t.getFullYear(), t.getMonth(), 1); }
      else {
        _cal.month = new Date(y, mo + step, 1);
        const sameDay = new Date(_cal.month.getFullYear(), _cal.month.getMonth(), 1);
        const first = items.filter(it => it.date && it.date.slice(0, 7) === calYmd(sameDay).slice(0, 7)).sort((a, b) => a.date.localeCompare(b.date))[0];
        _cal.sel = calYmd(_cal.month) <= today && today.slice(0, 7) === calYmd(_cal.month).slice(0, 7) ? today : (first ? first.date : calYmd(sameDay));
      }
      renderChapterCalendar(el, items, opts);
    }));
    el.querySelector("[data-cal-jump]")?.addEventListener("click", e => {
      _cal.sel = e.currentTarget.dataset.calJump; const d = calParse(_cal.sel); _cal.month = new Date(d.getFullYear(), d.getMonth(), 1);
      renderChapterCalendar(el, items, opts);
    });
    el.querySelector("[data-cal-add]")?.addEventListener("click", e => opts.onAdd(e.currentTarget.dataset.calAdd));
  }
  // Keep the chosen day in view (only when the choice or month changes, so we never fight the user's scrolling)
  const key = _cal.sel + "|" + y + mo;
  const wrap = el.querySelector(".cal-strip-wrap"), btn = el.querySelector(".cal-day.is-sel");
  if (_cal.lastScrollKey !== key && wrap && btn) {
    if (wrap.clientWidth > 0) {   // only once it's actually on screen
      _cal.lastScrollKey = key;
      wrap.scrollTo({ left: btn.offsetLeft - wrap.clientWidth / 2 + btn.offsetWidth / 2, behavior: "auto" });
    } else if (!_cal.waitingForLayout) {
      _cal.waitingForLayout = true;
      const tryAgain = () => { _cal.waitingForLayout = false; if (wrap.isConnected) renderChapterCalendar(el, items, opts); };
      if (window.ResizeObserver) { const ro = new ResizeObserver(() => { if (wrap.clientWidth > 0) { ro.disconnect(); tryAgain(); } }); ro.observe(wrap); }
      else setTimeout(tryAgain, 400);
    }
  }
}

function renderMeetingsCalendar() {
  const el = $("chapter-calendar"); if (!el) return;
  if (!state.user) { if (el.innerHTML) { el.innerHTML = ""; el.dataset.html = ""; } return; }
  const items = [
    ...state.meetings.map(m => ({ date: m.date, time: m.startTime, title: m.title, where: m.location, kind: "meeting", tag: m.mandatory ? "Mandatory" : "", strong: !!m.mandatory })),
    ...(state.events || []).map(e => ({ date: e.date, time: e.time || "", title: e.name, where: e.location, kind: "event", tag: e.type || "" })),
  ];
  const isExec = !!state.user.isExec;
  renderChapterCalendar(el, items, {
    addLabel: isExec ? "Schedule a meeting on" : "",
    onAdd: isExec ? (ymd => {
      activateTab("meetings");
      setTimeout(() => {
        const d = $("mtg-date"); if (!d) return;
        d.value = ymd; d.dispatchEvent(new Event("input", { bubbles: true })); d.dispatchEvent(new Event("change", { bubbles: true }));
        d.closest(".card")?.scrollIntoView({ behavior: "smooth", block: "start" });
        $("mtg-title")?.focus({ preventScroll: true });
      }, 60);
    }) : null,
  });
}

// ===================================================================
// FIRST-TIME WALKTHROUGH: a short, skippable tour on a brother's first
// sign-in on a device. Reopen any time with the "?" button up top.
// ===================================================================
const TOUR_KEY = "pike-meetings:tour:v1";
const TOUR_ICONS = {
  crest: '<img src="assets/brand/symbol-gold.png" alt="">',
  qr: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M14 14h3v3M21 14v7h-7"/></svg>',
  absence: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M10 14l4 4M14 14l-4 4"/></svg>',
  standing: '<svg viewBox="0 0 24 24"><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/></svg>',
  updates: '<svg viewBox="0 0 24 24"><path d="M4 4h13a1 1 0 0 1 1 1v13a2 2 0 0 0 2 2H6a2 2 0 0 1-2-2z"/><path d="M18 8h2v10a2 2 0 0 1-2 2"/><path d="M8 8h6M8 12h6M8 16h4"/></svg>',
  exec: '<svg viewBox="0 0 24 24"><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
};
function tourSteps() {
  const fine = Number((state.settings && state.settings.fineAmount) || FINE_AMOUNT_DEFAULT);
  const steps = [
    { icon: "crest", title: "Welcome to Chapter Meetings", text: "Your home base for chapter: roll call, absences, your standing and Chapter Updates. Here's the 30-second tour." },
    { icon: "qr", title: "Check in with one scan", text: "At chapter, point your phone camera at the code on the screen and open the link. Check-in closes a few minutes after the meeting starts, so be on time." },
    { icon: "absence", title: "Can't make it? Ask early.", text: "Send an absence request from the Absences tab at least 48 hours before the meeting. You'll get a notice here when it's approved or denied." },
    { icon: "standing", title: "Know where you stand", text: `Your standing shows absences used and any no-shows. A 2nd no-show in a quarter is a $${fine} fine, paid to the Treasurer.` },
    { icon: "updates", title: "Stay in the loop", text: "Chapter Updates recap every meeting, and new ones show up at the top of this page. The calendar shows what's coming up." },
  ];
  if (state.user && state.user.isExec) steps.push({ icon: "exec", title: "Your exec tools", text: "Create meetings (a whole quarter of weekly ones at once), show the QR, run roll call and publish Chapter Updates. The calendar's + button schedules a meeting on any day." });
  return steps;
}
let _tourStep = 0, _tourSteps = [], _tourLastFocus = null;
function renderTourStep() {
  const s = _tourSteps[_tourStep], last = _tourStep === _tourSteps.length - 1;
  $("tour-art").innerHTML = `<div class="tour-icon" key="${_tourStep}">${TOUR_ICONS[s.icon]}</div>`;
  $("tour-step").textContent = `${_tourStep + 1} of ${_tourSteps.length}`;
  $("tour-title").textContent = s.title;
  $("tour-text").textContent = s.text;
  $("tour-dots").innerHTML = _tourSteps.map((_, i) => `<button type="button" class="tour-dot${i === _tourStep ? " is-on" : ""}" data-tour-go="${i}" aria-label="Step ${i + 1}"></button>`).join("");
  $("tour-dots").querySelectorAll("[data-tour-go]").forEach(b => b.addEventListener("click", () => { _tourStep = Number(b.dataset.tourGo); renderTourStep(); }));
  $("tour-next").innerHTML = last ? "Let's go" : `Next <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`;
  $("tour-skip").style.visibility = last ? "hidden" : "";
  const body = document.querySelector("#tour .tour-body"); body.classList.remove("is-swap"); void body.offsetWidth; body.classList.add("is-swap");
}
function openTour() {
  _tourSteps = tourSteps(); _tourStep = 0; _tourLastFocus = document.activeElement;
  const t = $("tour"); t.hidden = false; requestAnimationFrame(() => t.classList.add("is-open"));
  document.body.classList.add("tour-open");
  renderTourStep(); $("tour-next").focus({ preventScroll: true });
}
function closeTour() {
  const t = $("tour"); t.classList.remove("is-open"); document.body.classList.remove("tour-open");
  setTimeout(() => { t.hidden = true; }, 220);
  try { localStorage.setItem(TOUR_KEY, "done"); } catch (e) {}
  if (_tourLastFocus && _tourLastFocus.focus) _tourLastFocus.focus({ preventScroll: true });
}
function initTour() {
  $("tour-next").addEventListener("click", () => { if (_tourStep < _tourSteps.length - 1) { _tourStep++; renderTourStep(); } else closeTour(); });
  $("tour-skip").addEventListener("click", closeTour);
  $("tour-skip-x").addEventListener("click", closeTour);
  $("tour").addEventListener("click", e => { if (e.target.id === "tour") closeTour(); });
  document.addEventListener("keydown", e => {
    if ($("tour").hidden) return;
    if (e.key === "Escape") closeTour();
    else if (e.key === "ArrowRight" && _tourStep < _tourSteps.length - 1) { _tourStep++; renderTourStep(); }
    else if (e.key === "ArrowLeft" && _tourStep > 0) { _tourStep--; renderTourStep(); }
  });
  // "?" button in the top bar to replay the tour
  const bar = document.querySelector(".auth-bar");
  if (bar && !$("tour-open")) {
    const b = document.createElement("button");
    b.id = "tour-open"; b.type = "button"; b.className = "tour-open-btn"; b.setAttribute("aria-label", "How this app works"); b.title = "How this app works";
    b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="M9.6 9.2a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.6"/><circle cx="12" cy="17" r=".6" fill="currentColor"/></svg>';
    b.addEventListener("click", openTour);
    bar.insertBefore(b, $("auth-status"));
  }
}
// First sign-in on this device: wait for any notice pop-ups to clear, then show the tour once.
let _tourQueued = false;
function maybeStartTour() {
  if (_tourQueued || !state.user || !(state.user.rosterEntry || state.user.isExec)) return;
  try { if (localStorage.getItem(TOUR_KEY) === "done") return; } catch (e) { return; }
  _tourQueued = true;
  let tries = 0;
  const attempt = () => {
    if (!state.user) { _tourQueued = false; return; }
    const busy = $("notif-modal")?.classList.contains("visible") || document.querySelector(".modal.visible");
    if (busy && tries++ < 60) return setTimeout(attempt, 700);
    openTour();
  };
  setTimeout(attempt, 1200);
}
// ===================================================================
// INIT
// ===================================================================
const preselectMeeting = readHash();
if (preselectMeeting) activateTab("rollcall");

renderQuarterSelectors();
renderAll();
startRollCallTimer();

// Default the date input on the create form to 2 weeks from today — the
// recommended lead time, so brothers have room to submit absence requests
// and mandatory meetings clear the 14-day notice rule.
function defaultMeetingDate(force) {
  const dateInput = $("mtg-date");
  if (!dateInput || (dateInput.value && !force)) return;
  const d = new Date();
  d.setDate(d.getDate() + 14);
  const pad = n => String(n).padStart(2, "0");
  dateInput.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Live readout under the date/time row: how far out the meeting is and
// what that means for absence requests.
function updateLeadTimeHint() {
  const el = $("mtg-leadtime");
  if (!el) return;
  const date  = $("mtg-date")?.value;
  const start = $("mtg-start")?.value;
  const mand  = $("mtg-mandatory")?.checked;
  if (!date || !start) { el.className = "mtg-leadtime"; el.textContent = ""; return; }

  const hours = (combineLocalDateTime(date, start).getTime() - Date.now()) / 3600000;
  const days  = hours / 24;
  const when  = hours < 48
    ? `${Math.max(0, Math.round(hours))} hour${Math.round(hours) === 1 ? "" : "s"} away`
    : `${Math.floor(days)} day${Math.floor(days) === 1 ? "" : "s"} away`;

  let level, msg;
  if (hours <= 0) {
    level = "bad";  msg = "This time has already passed.";
  } else if (hours < 48) {
    level = "bad";  msg = `${when}. Absence requests will be closed for this meeting, so brothers will have to contact the secretary directly.`;
  } else if (mand && days < 14) {
    level = "warn"; msg = `${when}. Mandatory meetings need 14 days' notice (Article VI §12).`;
  } else if (days < 14) {
    level = "warn"; msg = `${when}. Brothers have until 48 hours before to request an absence. Two weeks out is recommended.`;
  } else {
    level = "good"; msg = `${when}. Plenty of time for brothers to plan and submit absence requests.`;
  }
  el.className = "mtg-leadtime is-" + level;
  el.textContent = msg;
}

// Live clock + weather (never allowed to break the page)
try { initNowWidgets(); } catch (e) { console.warn("Now widgets skipped:", e); }

// Theme switcher
try { initThemeSwitcher(); } catch (e) { console.warn("Theme switcher skipped:", e); }

// Mobile dock
try { initDock(); } catch (e) { console.warn("Dock skipped:", e); }

// Open a specific Dispatch issue from a shared link (#dispatch=ID)
function openDispatchFromHash() {
  const m = window.location.hash.match(/dispatch=([\w-]+)/);
  if (!m) return;
  activateTab("dispatch");
  state.dispatchView = m[1];
  renderDispatchSafe();
  setTimeout(() => markUpdatesRead(m[1]), 0);
}
window.addEventListener("hashchange", openDispatchFromHash);
try { openDispatchFromHash(); } catch (e) { console.warn("Dispatch link skipped:", e); }
try { updateAuthChrome(state.user); } catch (e) { console.warn("Welcome page skipped:", e); }
try { initTour(); } catch (e) { console.warn("Walkthrough skipped:", e); }
