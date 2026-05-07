// ===================================================================
// PIKE Meeting Tracker — Firestore Data Layer
// ===================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  getDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  serverTimestamp,
  query,
  orderBy,
  where,
  getDocs,
  writeBatch
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

import { firebaseConfig } from "./firebase-config.js";
import { currentQuarter, getQuarterForDate } from "./quarters.js";

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const fs   = getFirestore(app);
const provider = new GoogleAuthProvider();

// ===================================================================
// ROLE ALLOWLISTS
// (Mirrored in firestore.rules — must stay in sync)
// ===================================================================

export const EXEC_EMAILS = new Set([
  "uclapikes@gmail.com",
  "pthomsak@gmail.com",          // President
  "ryansalridge@gmail.com",      // Internal VP
  "davidbnavarrojr@gmail.com",   // Secretary
  "david.mescobedo20@gmail.com", // Treasurer
  "ryderrios.rio@gmail.com",     // Health & Safety
  "rileyo1294@gmail.com",        // External VP
  "jaredashman0209@gmail.com",   // Alumni Relations
  "kazimirov.timothy@gmail.com", // Brotherhood
  "nikkranjith21@gmail.com",     // Sgt-at-Arms
]);

export const APPROVER_EMAILS = new Set([
  "uclapikes@gmail.com",
  "pthomsak@gmail.com",
  "ryansalridge@gmail.com",
  "davidbnavarrojr@gmail.com",
]);

export const SGT_AT_ARMS_EMAIL = "nikkranjith21@gmail.com";
export const TREASURER_EMAIL   = "david.mescobedo20@gmail.com";
export const SECRETARY_EMAIL   = "davidbnavarrojr@gmail.com";
export const PRESIDENT_EMAIL   = "pthomsak@gmail.com";
export const IVP_EMAIL         = "ryansalridge@gmail.com";

// ===================================================================
// AUTH
// ===================================================================

let currentUser = null;
const authListeners = new Set();

function notifyAuth() {
  authListeners.forEach(cb => {
    try { cb(currentUser); } catch (e) { console.error(e); }
  });
}

async function resolveUser(firebaseUser) {
  if (!firebaseUser) return null;
  const email = (firebaseUser.email || "").toLowerCase();

  const isExec      = EXEC_EMAILS.has(email);
  const isApprover  = APPROVER_EMAILS.has(email);
  const isSgt       = email === SGT_AT_ARMS_EMAIL;
  const isTreasurer = email === TREASURER_EMAIL;

  // Look up the brother's roster entry by email
  let rosterEntry = null;
  try {
    const snap = await getDocs(
      query(collection(fs, "roster"), where("email", "==", email))
    );
    if (!snap.empty) {
      const d = snap.docs[0];
      rosterEntry = { key: d.id, ...d.data() };
    }
  } catch (e) {
    console.warn("Roster lookup failed:", e);
  }

  // Check if signed-in user is the (configurable) judicial vice chair
  let isViceChair = false;
  try {
    const settings = await getDoc(doc(fs, "settings", "main"));
    if (settings.exists()) {
      const data = settings.data();
      isViceChair = (data.judicialViceChair || "").toLowerCase() === email;
    }
  } catch (e) {
    // settings doc may not exist yet — that's fine
  }

  // Compute primary "role" for display (priority: exec > sgt > treasurer > vice chair > brother > guest)
  let role;
  if (isExec)            role = "exec";
  else if (isSgt)        role = "sgt";
  else if (isTreasurer)  role = "treasurer";
  else if (isViceChair)  role = "vice_chair";
  else if (rosterEntry)  role = "brother";
  else                   role = "guest";

  return {
    firebaseUser,
    email,
    rosterEntry,
    isExec,
    isApprover,
    isSgt,
    isTreasurer,
    isViceChair,
    role,
  };
}

onAuthStateChanged(auth, async (fbUser) => {
  currentUser = await resolveUser(fbUser);
  notifyAuth();
});

export const authApi = {
  current: () => currentUser,
  signIn:  () => signInWithPopup(auth, provider),
  signOut: () => signOut(auth),
  onChange(cb) {
    authListeners.add(cb);
    Promise.resolve().then(() => cb(currentUser));
    return () => authListeners.delete(cb);
  },
};

// ===================================================================
// ROSTER  (read-only here — managed in the event tracker)
// ===================================================================

export const roster = {
  subscribe(callback) {
    const q = query(collection(fs, "roster"), orderBy("lastName"));
    return onSnapshot(q, snap => {
      const list = snap.docs.map(d => ({ key: d.id, ...d.data() }));
      callback(list);
    });
  },
};

// ===================================================================
// MEETINGS
// ===================================================================

export const meetings = {
  subscribe(callback) {
    const q = query(collection(fs, "meetings"), orderBy("date", "desc"));
    return onSnapshot(q, snap => {
      const list = snap.docs.map(d => {
        const data = d.data();
        return {
          id: d.id,
          ...data,
          quarter: data.quarter || getQuarterForDate(data.date),
        };
      });
      callback(list);
    });
  },

  async create(meeting) {
    const ref = await addDoc(collection(fs, "meetings"), {
      ...meeting,
      quarter: getQuarterForDate(meeting.date),
      createdAt: serverTimestamp(),
      createdBy: currentUser?.email || null,
    });
    return ref.id;
  },

  async remove(id) {
    // Cascade: delete all data tied to this meeting
    const tasks = [];
    const att = await getDocs(query(collection(fs, "meeting_attendance"), where("meetingId", "==", id)));
    att.forEach(d => tasks.push({ ref: d.ref }));
    const reqs = await getDocs(query(collection(fs, "absence_requests"), where("meetingId", "==", id)));
    reqs.forEach(d => tasks.push({ ref: d.ref }));
    const ns = await getDocs(query(collection(fs, "no_shows"), where("meetingId", "==", id)));
    ns.forEach(d => tasks.push({ ref: d.ref }));
    const fn = await getDocs(query(collection(fs, "fines"), where("meetingId", "==", id)));
    fn.forEach(d => tasks.push({ ref: d.ref }));

    for (let i = 0; i < tasks.length; i += 400) {
      const batch = writeBatch(fs);
      tasks.slice(i, i + 400).forEach(t => batch.delete(t.ref));
      await batch.commit();
    }
    await deleteDoc(doc(fs, "meetings", id));
  },
};

// ===================================================================
// ATTENDANCE  (roll call scans)
// ===================================================================

export const attendance = {
  subscribe(callback) {
    const q = query(collection(fs, "meeting_attendance"), orderBy("timestamp", "desc"));
    return onSnapshot(q, snap => {
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      callback(list);
    });
  },

  async markPresent(payload) {
    return await addDoc(collection(fs, "meeting_attendance"), {
      meetingId:  payload.meetingId,
      brotherKey: payload.brotherKey,
      name:       payload.name,
      email:      payload.email,
      status:     "present",
      timestamp:  Date.now(),
      quarter:    payload.quarter || currentQuarter(),
    });
  },

  async remove(id) {
    await deleteDoc(doc(fs, "meeting_attendance", id));
  },
};

// ===================================================================
// ABSENCE REQUESTS
// ===================================================================

export const absenceRequests = {
  subscribe(callback) {
    const q = query(collection(fs, "absence_requests"), orderBy("submittedAt", "desc"));
    return onSnapshot(q, snap => {
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      callback(list);
    });
  },

  async submit(req) {
    return await addDoc(collection(fs, "absence_requests"), {
      ...req,
      status:      "pending",
      submittedAt: Date.now(),
      quarter:     req.quarter || currentQuarter(),
    });
  },

  async review(id, decision /* "approved" | "denied" */, note) {
    await updateDoc(doc(fs, "absence_requests", id), {
      status:       decision,
      reviewedAt:   Date.now(),
      reviewedBy:   currentUser?.email || null,
      reviewerNote: note || "",
    });
  },

  // Brother cancels their own pending request
  async cancel(id) {
    await deleteDoc(doc(fs, "absence_requests", id));
  },
};

// ===================================================================
// NO-SHOWS
// ===================================================================

export const noShows = {
  subscribe(callback) {
    const q = query(collection(fs, "no_shows"), orderBy("timestamp", "desc"));
    return onSnapshot(q, snap => {
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      callback(list);
    });
  },

  async create(record) {
    return await addDoc(collection(fs, "no_shows"), {
      ...record,
      timestamp: Date.now(),
      appealed: false,
      appealStatus: null,
      appealReason: null,
    });
  },

  async appeal(id, reason) {
    await updateDoc(doc(fs, "no_shows", id), {
      appealed: true,
      appealStatus: "pending",
      appealReason: reason,
      appealedAt: Date.now(),
      appealedBy: currentUser?.email || null,
    });
  },

  async resolveAppeal(id, decision /* "overturned" | "upheld" */, note) {
    await updateDoc(doc(fs, "no_shows", id), {
      appealStatus: decision,
      appealResolvedAt: Date.now(),
      appealResolvedBy: currentUser?.email || null,
      appealResolverNote: note || "",
    });
  },

  async remove(id) {
    await deleteDoc(doc(fs, "no_shows", id));
  },
};

// ===================================================================
// FINES
// ===================================================================

export const fines = {
  subscribe(callback) {
    const q = query(collection(fs, "fines"), orderBy("createdAt", "desc"));
    return onSnapshot(q, snap => {
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      callback(list);
    });
  },

  async create(fine) {
    return await addDoc(collection(fs, "fines"), {
      ...fine,
      status: "pending",
      createdAt: Date.now(),
    });
  },

  async markPaid(id) {
    await updateDoc(doc(fs, "fines", id), {
      status: "paid",
      paidAt: Date.now(),
      paidMarkedBy: currentUser?.email || null,
    });
  },

  async waive(id, reason) {
    await updateDoc(doc(fs, "fines", id), {
      status: "waived",
      waivedAt: Date.now(),
      waivedBy: currentUser?.email || null,
      waiveReason: reason || "",
    });
  },

  async remove(id) {
    await deleteDoc(doc(fs, "fines", id));
  },
};

// ===================================================================
// SETTINGS  (configurable — judicial vice chair email, etc.)
// ===================================================================

export const settings = {
  subscribe(callback) {
    return onSnapshot(doc(fs, "settings", "main"), snap => {
      callback(snap.exists() ? snap.data() : {});
    });
  },

  async save(data) {
    await setDoc(doc(fs, "settings", "main"), data, { merge: true });
  },
};
