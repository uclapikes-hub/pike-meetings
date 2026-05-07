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
  noShows, fines, settings,
  EXEC_EMAILS, APPROVER_EMAILS, SGT_AT_ARMS_EMAIL, TREASURER_EMAIL, SECRETARY_EMAIL,
  PRESIDENT_EMAIL, IVP_EMAIL,
} from "./data.js";
import {
  currentQuarter, formatQuarter, quartersFromRecords,
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
  const target = dateOrTimestamp instanceof Date ? dateOrTimestamp.getTime() : dateOrTimestamp;
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
authApi.onChange(user => {
  state.user = user;

  if (user) {
    const label = ROLE_LABELS[user.role] || "User";
    $("auth-status").innerHTML =
      `<strong>${escapeHtml(user.email)}</strong> <span class="role-pill role-${user.role}">${label}</span>`;
    $("auth-signin").style.display = "none";
    $("auth-signout").style.display = "";
  } else {
    $("auth-status").innerHTML = "Not signed in";
    $("auth-signin").style.display = "";
    $("auth-signout").style.display = "none";
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
roster.subscribe(list => {
  state.roster = list;
  renderAll();
});
meetings.subscribe(list => {
  state.meetings = list;
  renderQuarterSelectors();
  renderAll();
});
attendance.subscribe(list => {
  state.attendance = list;
  renderAll();
});
absenceRequests.subscribe(list => {
  state.absenceRequests = list;
  renderAll();
});
noShows.subscribe(list => {
  state.noShows = list;
  renderAll();
});
fines.subscribe(list => {
  state.fines = list;
  renderAll();
});
settings.subscribe(s => {
  state.settings = s;
  renderSettings();
});

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
  renderMyStanding();
  renderRollCallTab();
  renderMeetingsTab();
  renderAbsenceTab();
  renderReportsTab();
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
      <p style="font-family: Georgia, serif; font-size: 14px; line-height: 1.6;">
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
      <p style="font-family: Georgia, serif; font-size: 14px; line-height: 1.6;">
        You're signed in but your email isn't matched to anyone in the chapter roster.
        Ask any exec officer to update your roster entry's email to
        <code>${escapeHtml(state.user.email)}</code> in the
        <a href="https://uclapikes-hub.github.io/pike-attendance/" target="_blank" rel="noopener" style="color: var(--garnet); font-weight: bold;">event tracker's Roster tab</a>.
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
      <div style="font-family: 'Cormorant Garamond', Georgia, serif; font-size: 18px; font-weight: 600; color: var(--garnet); margin-bottom: 10px;">
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
            <div style="padding: 12px 14px; background: white; border: 1px solid rgba(170,151,103,0.3); border-left: 3px solid var(--crimson); display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; align-items: flex-start;">
              <div style="flex: 1; min-width: 200px;">
                <div style="font-family: Arial, sans-serif; font-size: 11px; font-weight: bold; letter-spacing: 1px; color: var(--crimson); text-transform: uppercase;">
                  ${sequence} No-Show &middot; ${escapeHtml(consequenceLabel)}
                </div>
                <div style="font-family: Georgia, serif; font-size: 13px; color: var(--slate); margin-top: 4px;">
                  ${escapeHtml(n.meetingTitle || "Meeting")} &middot; ${escapeHtml(fmtDate(n.meetingDate || ""))}
                </div>
                ${n.reason ? `<div style="font-family: Georgia, serif; font-size: 11px; color: var(--knight-steel); margin-top: 3px; font-style: italic;">${escapeHtml(noShowReasonLabel(n.reason))}</div>` : ""}
                ${n.appealed && n.appealStatus !== "pending" && n.appealResolverNote ? `
                  <div style="margin-top: 6px; padding: 6px 10px; background: var(--light-gold); font-family: Georgia, serif; font-size: 11px; font-style: italic;">
                    <strong style="font-style: normal; color: var(--garnet);">Sgt note:</strong> ${escapeHtml(n.appealResolverNote)}
                  </div>` : ""}
              </div>
              <div style="display: flex; flex-direction: column; gap: 6px; align-items: flex-end;">
                ${appealStatus ? `
                  <span style="background: ${n.appealStatus === "overturned" ? "var(--garnet)" : "var(--knight-steel)"}; color: white; padding: 3px 8px; font-family: Arial; font-size: 9px; font-weight: bold; letter-spacing: 1.5px;">
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
        <div style="font-family: Georgia, serif; font-size: 14px; color: var(--slate); margin-top: 6px;">
          ${escapeHtml(fmtDateLong(openNow.date))} &middot; ${fmtTime(openNow.startTime)}${openNow.location ? " &middot; " + escapeHtml(openNow.location) : ""}
        </div>
        <div style="font-family: Arial, sans-serif; font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--true-gold); margin-top: 14px; font-weight: bold;">
          Window closes ${closesIn}
        </div>

        ${alreadyMarked ? `
          <div style="margin-top: 24px; padding: 18px; background: var(--light-gold); border-left: 3px solid var(--garnet);">
            <div style="font-family: 'Cormorant Garamond', Georgia, serif; font-size: 22px; color: var(--garnet); font-weight: 600;">
              ✓ You're checked in
            </div>
            <div style="font-family: Georgia, serif; font-size: 13px; color: var(--slate); margin-top: 6px;">
              Marked present at ${new Date(state.attendance.find(a => a.meetingId === openNow.id && a.brotherKey === target.key)?.timestamp).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'})}
            </div>
          </div>
        ` : `
          <button class="btn" id="rc-mark-present" style="margin-top: 24px; font-size: 14px; padding: 16px 36px;">
            Mark Me Present
          </button>
          ${openNow.mandatory ? `<div style="margin-top: 14px; font-family: Georgia, serif; font-size: 12px; font-style: italic; color: var(--burgundy);">⚑ Mandatory meeting — bylaws require attendance</div>` : ""}
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
      placeholder.innerHTML = `
        <div class="card">
          <div class="card-sub">Next Meeting</div>
          <div class="card-title">${escapeHtml(upcoming.title)}</div>
          <div style="font-family: Georgia, serif; font-size: 14px; color: var(--slate); margin-top: 6px;">
            ${escapeHtml(fmtDateLong(upcoming.date))} &middot; ${fmtTime(upcoming.startTime)}${upcoming.location ? " &middot; " + escapeHtml(upcoming.location) : ""}
          </div>
          <div style="margin-top: 18px; padding: 14px; background: var(--light-gold); border-left: 3px solid var(--true-gold);">
            <div style="font-family: Arial, sans-serif; font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--garnet); font-weight: bold;">
              Roll call opens ${opensIn}
            </div>
            <div style="font-family: Georgia, serif; font-size: 13px; font-style: italic; color: var(--slate); margin-top: 4px;">
              The "Mark Me Present" button will appear here automatically when the window opens (15 min before start).
            </div>
          </div>
          ${upcoming.mandatory ? `<div style="margin-top: 12px; font-family: Georgia, serif; font-size: 12px; font-style: italic; color: var(--burgundy);">⚑ Mandatory meeting</div>` : ""}
        </div>
      `;
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

async function processClosedMeetings() {
  if (!state.user || (!state.user.isExec && !state.user.isSgt)) return;

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

    // Existing no-show records for this meeting
    const existingNoShows = new Set(
      state.noShows.filter(n => n.meetingId === meetingId).map(n => n.brotherKey)
    );

    for (const brother of eligible) {
      if (present.has(brother.key)) continue;        // Marked present
      if (existingNoShows.has(brother.key)) continue; // Already recorded

      // Did this brother have an approved absence for this meeting?
      const myReq = state.absenceRequests.find(r =>
        r.meetingId === meetingId && r.brotherKey === brother.key
      );
      if (myReq && myReq.status === "approved") continue; // Excused — no no-show

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
        // Don't count overturned appeals
        n.appealStatus !== "overturned"
      ).length;
      const newCount = priorCount + 1;

      try {
        await noShows.create({
          brotherKey: brother.key,
          brotherName: `${brother.firstName} ${brother.lastName}`,
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
        if (newCount === 2) {
          // Idempotency: only create if no existing pending fine for this meeting
          const existingFine = state.fines.find(f =>
            f.brotherKey === brother.key && f.meetingId === meetingId
          );
          if (!existingFine) {
            const amount = Number(state.settings.fineAmount) || FINE_AMOUNT_DEFAULT;
            await fines.create({
              brotherKey: brother.key,
              brotherName: `${brother.firstName} ${brother.lastName}`,
              email: brother.email,
              amount,
              reason: "2nd no-show",
              meetingId,
              meetingTitle: meeting.title,
              meetingDate: meeting.date,
              quarter: meetingQuarter,
            });
            console.log(`Fine created: $${amount} for ${brother.firstName}`);
          }
        }
      } catch (e) {
        console.warn(`No-show creation failed for ${brother.firstName}:`, e);
      }
    }
  }
}

// Manually triggerable from the Meetings tab (exec button on past meetings)
async function manualProcessMeeting(meetingId) {
  const meeting = state.meetings.find(m => m.id === meetingId);
  if (!meeting) return;
  if (!qrWindow(meeting).isPast) {
    return toast("Meeting hasn't ended yet", true);
  }
  toast("Processing no-shows...");
  await autoDenyPendingPastStart();
  await processClosedMeetings();
  toast("No-shows processed");
}

// ===================================================================
// STAGE 4 — APPEAL MODAL
// ===================================================================

let currentAppealNoShowId = null;

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
  try {
    await noShows.appeal(currentAppealNoShowId, reason);
    $("appeal-modal").classList.remove("visible");
    toast("Appeal submitted — Sgt-at-Arms will review");
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
      defaultMeetingDate();
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
          <label for="mtg-window">QR Window <span style="font-weight: normal; color: var(--true-gold); text-transform: none; letter-spacing: 0;">(min after start)</span></label>
          <input type="number" id="mtg-window" value="5" min="1" max="60">
        </div>
      </div>

      <label for="mtg-location">Location</label>
      <input type="text" id="mtg-location" placeholder="Chapter house living room" autocomplete="off">

      <div id="mtg-mandatory-row" style="display: flex; align-items: center; gap: 12px; margin-top: 18px; padding: 12px 14px; background: var(--light-gold); border-left: 3px solid var(--burgundy);">
        <input type="checkbox" id="mtg-mandatory" style="width: auto; margin: 0;">
        <label for="mtg-mandatory" id="mtg-mandatory-label" style="margin: 0; cursor: pointer;">
          Mandatory Meeting
        </label>
        <span id="mtg-mandatory-hint" style="font-family: Georgia, serif; font-size: 12px; font-style: italic; color: var(--true-gold);"></span>
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
    row.style.borderLeft = "3px solid var(--knight-steel)";
    lbl.style.cursor = "not-allowed";
    lbl.style.color = "var(--knight-steel)";
    hint.textContent = `Bylaws limit mandatory meetings to 4 per quarter. ${formatQuarter(todayQ)} already has 4.`;
  } else {
    cb.disabled = false;
    row.style.borderLeft = "3px solid var(--burgundy)";
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
    await meetings.create({
      title, date, startTime, endTime, location,
      mandatory, qrWindowMinutes: qrWin,
    });
    $("mtg-title").value = "";
    $("mtg-location").value = "";
    $("mtg-mandatory").checked = false;
    toast("Meeting created");
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
    timingBadge = `<span style="background: var(--crimson); color: white; padding: 2px 8px; font-family: Arial; font-size: 10px; font-weight: bold; letter-spacing: 1px;">QR OPEN — closes ${relativeTime(w.closes)}</span>`;
  } else if (isFuture) {
    timingBadge = `<span style="background: var(--khaki); color: var(--burgundy); padding: 2px 8px; font-family: Arial; font-size: 10px; font-weight: bold; letter-spacing: 1px;">${relativeTime(w.start).toUpperCase()}</span>`;
  } else {
    timingBadge = `<span style="background: var(--knight-steel); color: white; padding: 2px 8px; font-family: Arial; font-size: 10px; font-weight: bold; letter-spacing: 1px;">PAST</span>`;
  }

  return `
    <div class="event-row" style="display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; background: white; border: 1px solid rgba(170,151,103,0.3); ${m.mandatory ? "border-left: 3px solid var(--burgundy);" : ""} gap: 12px; flex-wrap: wrap;">
      <div style="flex: 1; min-width: 220px;">
        <div style="font-family: 'Cormorant Garamond', Georgia, serif; font-size: 18px; font-weight: 600; color: var(--garnet);">
          ${escapeHtml(m.title)} ${m.mandatory ? `<span style="font-family: Arial; font-size: 9px; letter-spacing: 1.5px; color: var(--burgundy); margin-left: 6px;">⚑ MANDATORY</span>` : ""}
        </div>
        <div style="font-family: Arial, sans-serif; font-size: 11px; color: var(--slate); letter-spacing: 1px; margin-top: 4px;">
          ${escapeHtml(fmtDate(m.date))} &middot; ${fmtTime(m.startTime)}–${fmtTime(m.endTime)}${m.location ? " &middot; " + escapeHtml(m.location) : ""}
        </div>
        <div style="margin-top: 6px;">
          ${timingBadge}
        </div>
      </div>
      <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
        <span style="background: var(--garnet); color: white; padding: 6px 12px; font-family: Arial; font-size: 11px; font-weight: bold; letter-spacing: 1px;">
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
  const cnt = state.attendance.filter(a => a.meetingId === id).length;
  const msg = cnt > 0
    ? `Delete "${m.title}" and its ${cnt} attendance record${cnt === 1 ? "" : "s"}? This cannot be undone.`
    : `Delete "${m.title}"?`;
  if (!confirm(msg)) return;
  try {
    await meetings.remove(id);
    toast("Meeting deleted");
  } catch (e) {
    console.error(e);
    toast("Permission denied", true);
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
    ? present.map(b => `<div style="padding: 8px 14px; border-bottom: 1px solid var(--light-gold); font-family: Georgia, serif; font-size: 13px; display: flex; justify-content: space-between;">
        <span>${escapeHtml(b.firstName + " " + b.lastName)}</span>
        <span style="font-family: Arial; font-size: 9px; letter-spacing: 1px; text-transform: uppercase; color: var(--garnet); font-weight: bold;">PRESENT</span>
      </div>`).join("")
    : `<div style="padding: 12px; font-family: Georgia, serif; font-style: italic; color: var(--true-gold);">No one has marked themselves present yet.</div>`;

  $("roll-sheet-absent").innerHTML = absent.length
    ? absent.map(b => `<div style="padding: 8px 14px; border-bottom: 1px solid var(--light-gold); font-family: Georgia, serif; font-size: 13px; display: flex; justify-content: space-between;">
        <span>${escapeHtml(b.firstName + " " + b.lastName)}</span>
        <span style="font-family: Arial; font-size: 9px; letter-spacing: 1px; text-transform: uppercase; color: var(--memphis-brick);">${b.status === "New Member" ? "NM" : ""} ${qrWindow(m).isPast ? "ABSENT" : "—"}</span>
      </div>`).join("")
    : `<div style="padding: 12px; font-family: Georgia, serif; font-style: italic; color: var(--true-gold);">Everyone eligible has marked present.</div>`;

  sheet.classList.add("visible");
}

// ===================================================================
// QR CODE MODAL
// ===================================================================
function renderQr(meetingId) {
  $("qr-holder").innerHTML = "";
  const url = window.location.origin + window.location.pathname + "#meeting=" + meetingId;
  new QRCode($("qr-holder"), {
    text: url, width: 240, height: 240,
    colorDark: "#79242F", colorLight: "#ffffff",
    correctLevel: QRCode.CorrectLevel.M,
  });
  currentQrCanvas = $("qr-holder").querySelector("canvas") || $("qr-holder").querySelector("img");
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
          <span style="font-weight: normal; text-transform: none; letter-spacing: 0; color: var(--true-gold); font-style: italic; margin-left: 6px;">
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
      hint.style.cssText = "margin-top: 8px; padding: 10px 14px; background: var(--khaki); border-left: 3px solid var(--burgundy); font-family: Georgia, serif; font-size: 12px; font-style: italic;";
      const list = tooSoon.map(m => `<strong>${escapeHtml(m.title)}</strong> (${fmtDate(m.date)} at ${fmtTime(m.startTime)})`).join(", ");
      hint.innerHTML = `${tooSoon.length} meeting${tooSoon.length === 1 ? " is" : "s are"} less than 48 hours away (${list}). For those, contact the secretary directly: <a href="mailto:${secEmail}" style="color: var(--garnet); font-weight: bold;">${secEmail}</a>`;
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
    tooSoonMsg.style.cssText = "display: block; margin-top: 18px; padding: 18px; background: var(--khaki); border-left: 3px solid var(--burgundy);";
    tooSoonMsg.innerHTML = `
      <div style="font-family: 'Cormorant Garamond', Georgia, serif; font-size: 18px; color: var(--burgundy); font-weight: 600;">
        No meetings eligible for absence requests
      </div>
      <div style="font-family: Georgia, serif; font-size: 14px; line-height: 1.6; margin-top: 8px;">
        All upcoming meetings are within 48 hours, or none are scheduled. For urgent excused absences, contact the secretary directly:
        <a href="mailto:${secEmail}" style="color: var(--garnet); font-weight: bold;">${secEmail}</a>
      </div>`;
    return;
  }

  formBody.style.display = "";
  tooSoonMsg.style.display = "none";

  // Mandatory warning
  if (meeting && meeting.mandatory) {
    mandWarn.style.display = "block";
    mandWarn.style.cssText = "display: block; margin-top: 14px; padding: 12px 14px; background: var(--light-gold); border-left: 3px solid var(--burgundy); font-family: Georgia, serif; font-size: 13px; line-height: 1.5;";
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
    <div style="padding: 14px 18px; background: white; border: 1px solid rgba(170,151,103,0.3); border-left: 3px solid ${statusColor};">
      <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 14px; flex-wrap: wrap;">
        <div style="flex: 1; min-width: 220px;">
          <div style="font-family: 'Cormorant Garamond', Georgia, serif; font-size: 17px; font-weight: 600; color: var(--garnet);">
            ${escapeHtml(r.meetingTitle || "Meeting")}
          </div>
          <div style="font-family: Arial, sans-serif; font-size: 11px; color: var(--slate); margin-top: 3px;">
            ${escapeHtml(fmtDate(r.meetingDate))} &middot; ${fmtTime(r.meetingStartTime)} &middot; ${escapeHtml(REASON_LABELS[r.reason] || r.reason)}
          </div>
          <div style="font-family: Georgia, serif; font-size: 13px; color: var(--slate); margin-top: 8px; line-height: 1.5;">
            ${escapeHtml(r.description)}
          </div>
          ${r.reviewerNote ? `
            <div style="margin-top: 8px; padding: 8px 12px; background: var(--light-gold); font-family: Georgia, serif; font-size: 12px; font-style: italic;">
              <strong style="font-style: normal; color: var(--garnet);">Approver note:</strong> ${escapeHtml(r.reviewerNote)}
            </div>
          ` : ""}
          <div style="font-family: Arial, sans-serif; font-size: 10px; color: var(--knight-steel); margin-top: 8px; letter-spacing: 1px;">
            Submitted ${submittedAgo}
          </div>
        </div>
        <div style="display: flex; flex-direction: column; gap: 8px; align-items: flex-end;">
          <span style="background: ${statusColor}; color: white; padding: 4px 10px; font-family: Arial; font-size: 10px; font-weight: bold; letter-spacing: 1.5px;">
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
    <div style="padding: 18px 20px; background: white; border: 1px solid rgba(170,151,103,0.3); ${r.mandatory ? "border-left: 3px solid var(--burgundy);" : "border-left: 3px solid var(--true-gold);"}">
      <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 12px;">
        <div style="flex: 1; min-width: 200px;">
          <div style="font-family: 'Cormorant Garamond', Georgia, serif; font-size: 19px; font-weight: 600; color: var(--garnet);">
            ${escapeHtml(r.brotherName)} ${r.mandatory ? `<span style="font-family: Arial; font-size: 10px; letter-spacing: 1.5px; color: var(--burgundy); margin-left: 6px;">⚑ MANDATORY MTG</span>` : ""}
          </div>
          <div style="font-family: Arial, sans-serif; font-size: 11px; color: var(--slate); letter-spacing: 0.5px; margin-top: 3px;">
            ${escapeHtml(r.meetingTitle || "Meeting")} &middot; ${escapeHtml(fmtDate(r.meetingDate))} ${fmtTime(r.meetingStartTime)} (${meetingAway})
          </div>
        </div>
        <span style="background: var(--khaki); color: var(--burgundy); padding: 3px 9px; font-family: Arial; font-size: 9px; font-weight: bold; letter-spacing: 1.5px;">
          ${escapeHtml((r.reason || "OTHER").toUpperCase())}
        </span>
      </div>

      <div style="font-family: Georgia, serif; font-size: 14px; color: var(--slate); margin-top: 12px; line-height: 1.55; padding: 12px 14px; background: var(--paper); border-left: 2px solid var(--key-gold);">
        ${escapeHtml(r.description)}
      </div>

      <div style="margin-top: 14px;">
        <label for="abs-note-${r.id}" style="margin: 0 0 4px;">Note <span style="font-weight: normal; text-transform: none; letter-spacing: 0; color: var(--true-gold); font-style: italic;">(optional, brother sees this)</span></label>
        <input type="text" id="abs-note-${r.id}" placeholder="e.g. 'Approved — please email proof to secretary'" autocomplete="off">
      </div>

      <div style="display: flex; gap: 10px; margin-top: 14px; align-items: center; flex-wrap: wrap;">
        <button class="btn" data-approve="${r.id}">Approve</button>
        <button class="btn btn-danger" data-deny="${r.id}">Deny</button>
        <span style="flex: 1; text-align: right; font-family: Arial; font-size: 10px; color: var(--knight-steel); letter-spacing: 1px;">
          Submitted ${submittedAgo} by ${escapeHtml(r.email || "")}
        </span>
      </div>
    </div>`;
}

function renderReviewedRow(r) {
  const color = r.status === "approved" ? "var(--garnet)" : "var(--memphis-brick)";
  const reviewerShort = (r.reviewedBy || "").split("@")[0];
  return `
    <div style="padding: 10px 14px; background: white; border-left: 3px solid ${color}; font-family: Georgia, serif; font-size: 13px; display: flex; justify-content: space-between; align-items: center; gap: 14px; flex-wrap: wrap;">
      <div>
        <strong style="color: ${color};">${(r.status || "").toUpperCase()}</strong>
        &middot; ${escapeHtml(r.brotherName)}
        &middot; ${escapeHtml(r.meetingTitle || "Meeting")}
        &middot; <span style="color: var(--knight-steel); font-size: 12px;">${escapeHtml(REASON_LABELS[r.reason] || r.reason)}</span>
      </div>
      <span style="font-family: Arial; font-size: 10px; color: var(--knight-steel); letter-spacing: 1px;">
        by ${escapeHtml(reviewerShort)} ${r.reviewedAt ? relativeTime(r.reviewedAt) : ""}
      </span>
    </div>`;
}

async function handleReviewDecision(id, decision) {
  if (!state.user || !state.user.isApprover) {
    return toast("Only approvers can decide", true);
  }
  const noteInput = $(`abs-note-${id}`);
  const note = noteInput ? noteInput.value.trim() : "";
  try {
    await absenceRequests.review(id, decision, note);
    toast(`Request ${decision}`);
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
    <div style="padding: 18px 20px; background: white; border: 1px solid rgba(170,151,103,0.3); border-left: 3px solid var(--dagger);">
      <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 12px;">
        <div style="flex: 1; min-width: 200px;">
          <div style="font-family: 'Cormorant Garamond', Georgia, serif; font-size: 19px; font-weight: 600; color: var(--dagger);">
            ${escapeHtml(n.brotherName)}
          </div>
          <div style="font-family: Arial, sans-serif; font-size: 11px; color: var(--slate); letter-spacing: 0.5px; margin-top: 3px;">
            ${sequence} no-show &middot; ${escapeHtml(n.meetingTitle || "Meeting")} &middot; ${escapeHtml(fmtDate(n.meetingDate || ""))}
          </div>
          <div style="font-family: Arial, sans-serif; font-size: 10px; color: var(--knight-steel); margin-top: 3px; font-style: italic;">
            ${escapeHtml(noShowReasonLabel(n.reason))}
          </div>
        </div>
      </div>

      <div style="font-family: Georgia, serif; font-size: 14px; color: var(--slate); margin-top: 12px; line-height: 1.55; padding: 12px 14px; background: var(--paper); border-left: 2px solid var(--key-gold);">
        <div style="font-family: Arial, sans-serif; font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--garnet); font-weight: bold; margin-bottom: 4px;">Appeal reason</div>
        ${escapeHtml(n.appealReason || "")}
      </div>

      <div style="margin-top: 14px;">
        <label for="appeal-note-${n.id}" style="margin: 0 0 4px;">Note <span style="font-weight: normal; text-transform: none; letter-spacing: 0; color: var(--true-gold); font-style: italic;">(brother sees this)</span></label>
        <input type="text" id="appeal-note-${n.id}" placeholder="e.g. 'Overturned — confirmed with health center'" autocomplete="off">
      </div>

      <div style="display: flex; gap: 10px; margin-top: 14px; align-items: center; flex-wrap: wrap;">
        <button class="btn" data-overturn="${n.id}">Overturn (remove no-show)</button>
        <button class="btn btn-danger" data-uphold="${n.id}">Uphold (no-show stands)</button>
        <span style="flex: 1; text-align: right; font-family: Arial; font-size: 10px; color: var(--knight-steel); letter-spacing: 1px;">
          Appealed ${submittedAgo}
        </span>
      </div>
    </div>`;
}

function renderAppealReviewedRow(n) {
  const color = n.appealStatus === "overturned" ? "var(--garnet)" : "var(--memphis-brick)";
  const reviewerShort = (n.appealResolvedBy || "").split("@")[0];
  return `
    <div style="padding: 10px 14px; background: white; border-left: 3px solid ${color}; font-family: Georgia, serif; font-size: 13px; display: flex; justify-content: space-between; align-items: center; gap: 14px; flex-wrap: wrap;">
      <div>
        <strong style="color: ${color};">${(n.appealStatus || "").toUpperCase()}</strong>
        &middot; ${escapeHtml(n.brotherName)}
        &middot; ${escapeHtml(n.meetingTitle || "Meeting")}
      </div>
      <span style="font-family: Arial; font-size: 10px; color: var(--knight-steel); letter-spacing: 1px;">
        by ${escapeHtml(reviewerShort)} ${n.appealResolvedAt ? relativeTime(n.appealResolvedAt) : ""}
      </span>
    </div>`;
}

async function handleAppealDecision(id, decision) {
  if (!state.user || (!state.user.isSgt && !state.user.isExec)) {
    return toast("Only Sgt-at-Arms can resolve appeals", true);
  }
  const noteInput = $(`appeal-note-${id}`);
  const note = noteInput ? noteInput.value.trim() : "";
  try {
    await noShows.resolveAppeal(id, decision, note);

    // If overturned, remove any associated fine
    if (decision === "overturned") {
      const ns = state.noShows.find(n => n.id === id);
      if (ns) {
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
    }
    toast(`Appeal ${decision}`);
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
            <div style="font-family: 'Cormorant Garamond', Georgia, serif; font-size: 18px; font-weight: 600; color: var(--memphis-brick); margin-bottom: 10px;">
              Pending Collection
            </div>
            <div style="display: flex; flex-direction: column; gap: 8px;">
              ${pendingFines.map(f => renderFineRow(f, "pending")).join("")}
            </div>
          </div>`}

      ${paidFines.length > 0 ? `
        <div style="margin-top: 22px;">
          <div style="font-family: 'Cormorant Garamond', Georgia, serif; font-size: 16px; font-weight: 600; color: var(--garnet); margin-bottom: 10px;">
            Collected (Paid)
          </div>
          <div style="display: flex; flex-direction: column; gap: 6px;">
            ${paidFines.slice(0, 20).map(f => renderFineRow(f, "paid")).join("")}
          </div>
        </div>` : ""}
    </div>

    <div class="card">
      <div class="empty-coming-soon">
        <span class="stage-tag">Stage 5 — Coming Soon</span>
        <h3>Excel Exports + 50% Watchlist</h3>
        <p style="margin-top: 12px; max-width: 480px; margin-left: auto; margin-right: auto; line-height: 1.6;">
          Quarterly attendance Excel reports, no-show ledger export, treasurer fine ledger as XLSX, and the &lt;50% participation watchlist (Article VI §12) covering both meetings AND events from the event tracker — all coming in Stage 5.
        </p>
      </div>
    </div>
  `;

  wrap.querySelectorAll("[data-paid]").forEach(b =>
    b.addEventListener("click", () => handleMarkFinePaid(b.dataset.paid)));
  wrap.querySelectorAll("[data-waive]").forEach(b =>
    b.addEventListener("click", () => handleWaiveFine(b.dataset.waive)));
}

function renderFineRow(f, mode) {
  const ago = f.createdAt ? relativeTime(f.createdAt) : "";
  const paidAgo = f.paidAt ? relativeTime(f.paidAt) : "";

  return `
    <div style="padding: 10px 14px; background: white; border-left: 3px solid ${mode === "pending" ? "var(--memphis-brick)" : "var(--garnet)"}; display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap;">
      <div style="flex: 1; min-width: 200px;">
        <div style="font-family: Georgia, serif; font-size: 14px;">
          <strong>${escapeHtml(f.brotherName)}</strong>
          &middot; <span style="color: ${mode === "pending" ? "var(--memphis-brick)" : "var(--garnet)"}; font-weight: bold;">$${f.amount}</span>
          &middot; <span style="color: var(--slate); font-size: 12px;">${escapeHtml(f.reason || "")}</span>
        </div>
        <div style="font-family: Arial, sans-serif; font-size: 10px; color: var(--knight-steel); margin-top: 3px; letter-spacing: 0.5px;">
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
  try {
    await fines.markPaid(id);
    toast("Fine marked paid");
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
// INIT
// ===================================================================
const preselectMeeting = readHash();
if (preselectMeeting) activateTab("rollcall");

renderQuarterSelectors();
renderAll();
startRollCallTimer();

// Default the date input on the create form to today (called when the form is built).
function defaultMeetingDate() {
  const dateInput = $("mtg-date");
  if (dateInput && !dateInput.value) dateInput.valueAsDate = new Date();
}
