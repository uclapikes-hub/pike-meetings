// ===================================================================
// FIREBASE CONFIG — UCLA PIKE Meeting Tracker
// -------------------------------------------------------------------
// SHARED with the event tracker (Option A). Same Firebase project,
// different app pulling from the same data.
// -------------------------------------------------------------------
// These values are NOT secret. Real security comes from firestore.rules.
// ===================================================================

export const firebaseConfig = {
  apiKey:            "AIzaSyD86mt7WFi2EY4Woe7DX3UC2eC2bPkw2nw",
  authDomain:        "pike-attendance.firebaseapp.com",
  projectId:         "pike-attendance",
  storageBucket:     "pike-attendance.firebasestorage.app",
  messagingSenderId: "625298103532",
  appId:             "1:625298103532:web:75c8a920f8b200163199c9"
};

export const CHAPTER_NAME = "Pi Kappa Alpha — UCLA";
export const APP_NAME     = "Chapter Meetings";
