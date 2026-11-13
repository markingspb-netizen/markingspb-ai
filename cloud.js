// Markingspb AI — Google accounts and website publishing (Firebase).
// The Firebase settings come from the server (/api/config), which reads them
// from the FIREBASE_CONFIG setting on Render. Without it, this part stays off.

const V = '11.0.2';
const base = `https://www.gstatic.com/firebasejs/${V}/`;
let fb = null;
let user = null;
const listeners = [];

export async function initCloud() {
  let cfg = null;
  try { cfg = (await (await fetch('/api/config')).json()).firebase; } catch { /* offline */ }
  if (!cfg || !cfg.apiKey) return false;
  const [{ initializeApp }, A, F] = await Promise.all([
    import(base + 'firebase-app.js'),
    import(base + 'firebase-auth.js'),
    import(base + 'firebase-firestore.js'),
  ]);
  const app = initializeApp(cfg);
  const auth = A.getAuth(app);
  const db = F.getFirestore(app);
  fb = { A, F, auth, db };
  A.getRedirectResult(auth).catch(() => {});
  A.onAuthStateChanged(auth, (u) => { user = u; listeners.forEach((f) => f(u)); });
  return true;
}

export const cloudReady = () => !!fb;
export const currentUser = () => user;
export function onUser(f) { listeners.push(f); f(user); }

export async function signIn() {
  const provider = new fb.A.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    return (await fb.A.signInWithPopup(fb.auth, provider)).user;
  } catch (e) {
    if (e && (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment')) {
      await fb.A.signInWithRedirect(fb.auth, provider);
    }
    throw e;
  }
}

export const signOut = () => fb.A.signOut(fb.auth);

// ---------- email + password ----------
export async function signUpEmail(name, email, password) {
  const cred = await fb.A.createUserWithEmailAndPassword(fb.auth, email, password);
  if (name) {
    await fb.A.updateProfile(cred.user, { displayName: name });
    user = fb.auth.currentUser;
    listeners.forEach((f) => f(user));
  }
  return cred.user;
}
export async function signInEmail(email, password) {
  return (await fb.A.signInWithEmailAndPassword(fb.auth, email, password)).user;
}
export async function resetPassword(email) {
  await fb.A.sendPasswordResetEmail(fb.auth, email);
}

// ---------- chats saved in the account: users/<uid>/chats/<chatId> ----------
function chatData(c) {
  const clean = JSON.parse(JSON.stringify(c)); // also removes empty (undefined) fields
  // A Firestore document must stay under 1 MB: keep only the newest website code if it gets too big.
  let size = JSON.stringify(clean).length;
  if (size > 900000) {
    const withSite = clean.messages.filter((m) => m.site);
    for (const m of withSite.slice(0, -1)) {
      if (size <= 900000) break;
      size -= m.site.length; delete m.site;
    }
  }
  while (JSON.stringify(clean).length > 900000 && clean.messages.length > 2) clean.messages.shift();
  return clean;
}
export async function saveChatCloud(c) {
  if (!fb || !user || !c || !c.id) return;
  const { F, db } = fb;
  await F.setDoc(F.doc(db, 'users', user.uid, 'chats', c.id), chatData(c));
}
export async function deleteChatCloud(id) {
  if (!fb || !user) return;
  const { F, db } = fb;
  await F.deleteDoc(F.doc(db, 'users', user.uid, 'chats', id));
}
export async function loadChatsCloud() {
  if (!fb || !user) return [];
  const { F, db } = fb;
  const q = F.query(F.collection(db, 'users', user.uid, 'chats'), F.orderBy('updated', 'desc'), F.limit(60));
  const snap = await F.getDocs(q);
  return snap.docs.map((d) => ({ ...d.data(), id: d.id }));
}

// Save the website to Firestore. Same id = update the same public link.
export async function publishSite(html, title, id) {
  const { F, db } = fb;
  const ref = id ? F.doc(db, 'sites', id) : F.doc(F.collection(db, 'sites'));
  const data = { owner: user.uid, html, title: String(title || 'Website').slice(0, 120), updatedAt: F.serverTimestamp() };
  if (!id) data.createdAt = F.serverTimestamp();
  await F.setDoc(ref, data, { merge: true });
  return ref.id;
}
