import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import {
  GoogleAuthProvider,
  getAuth,
  onAuthStateChanged,
  signInWithCustomToken,
  signInWithPopup,
  signOut,
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import {
  addDoc,
  collection,
  collectionGroup,
  doc,
  getDoc,
  increment,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-functions.js";
import { adminUids, firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app);
const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });
const root = document.querySelector("#root");
const introOverlay = document.querySelector("#intro-overlay");
const introVideo = document.querySelector("#intro-video");
const introStartButton = document.querySelector("#intro-start");
const introMessage = document.querySelector("#intro-message");
const grades = ["الأول الثانوي", "الثاني الثانوي", "الثالث الثانوي"];
const tracks = ["عربي", "لغات"];
const state = {
  user: null,
  profile: null,
  admin: false,
  device: null,
  deviceError: "",
  adminLoginError: "",
  adminLoginRequested: false,
  adminDeviceCount: 0,
  authReady: false,
  introVisible: sessionStorage.getItem("af-master-intro-shown") !== "true",
  busy: false,
  error: "",
  notice: "",
  nav: "home",
  courses: [],
  lessons: [],
  selectedCourse: null,
  selectedLesson: null,
  chatMessages: [],
  announcements: [],
  warnings: [],
  students: [],
  deviceCounts: {},
  supportTarget: "",
  search: "",
  referralCode: new URLSearchParams(location.search).get("ref") || "",
  installPrompt: null,
  installed: false,
  modal: "",
  chatText: "",
};

const unsubscribers = new Map();
let resolvingAuth = false;

function h(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function latinDigits(value) {
  return String(value).replace(/[٠-٩۰-۹]/g, (digit) => {
    const codePoint = digit.codePointAt(0) || 0;
    return String(codePoint >= 0x06f0 ? codePoint - 0x06f0 : codePoint - 0x0660);
  });
}

function normalizeStudentName(value) {
  return String(value).normalize("NFKC").trim().replace(/\s+/g, " ");
}

function createStudentCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return `AF${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

function getDeviceId() {
  let id = localStorage.getItem("af-master-device-id");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("af-master-device-id", id);
  }
  return id;
}

function call(name, data) {
  return httpsCallable(functions, name)(data).then((result) => result.data);
}

function messageFromError(error) {
  const code = error?.code || "";
  const message = error?.message || "";
  if (code.includes("already-exists")) {
    return message.includes("رقم الهاتف")
      ? "رقم الهاتف مستخدم بالفعل."
      : "الاسم مسجل بالفعل. أضف اسم العائلة أو اسمك الرباعي.";
  }
  if (code.includes("unauthenticated")) return "سجّل الدخول مرة أخرى.";
  if (code.includes("resource-exhausted")) return message || "تم الوصول إلى الحد المسموح.";
  if (code.includes("permission-denied")) return message || "ليس لديك صلاحية لتنفيذ هذا الإجراء.";
  if (code.includes("unavailable")) return "تعذر الاتصال بالخدمة. تحقق من الإنترنت وحاول مجدداً.";
  if (code.includes("internal") || message.trim().toUpperCase() === "INTERNAL") {
    return "حدث خطأ أثناء تنفيذ العملية. حاول مرة أخرى.";
  }
  return message || "حدث خطأ غير متوقع. حاول مرة أخرى.";
}

function fail(error) {
  state.error = messageFromError(error);
  state.notice = "";
  render();
}

function notify(message) {
  state.notice = message;
  state.error = "";
  render();
}

function finishIntro() {
  if (!state.introVisible) return;
  state.introVisible = false;
  introOverlay.hidden = true;
  introOverlay.setAttribute("aria-hidden", "true");
  introVideo.pause();
  sessionStorage.setItem("af-master-intro-shown", "true");
}

function showIntroStart(message, buttonLabel = "تشغيل المقدمة بالصوت") {
  introMessage.textContent = message;
  introStartButton.textContent = buttonLabel;
  introStartButton.hidden = false;
}

async function playIntro() {
  introStartButton.hidden = true;
  try {
    introVideo.muted = false;
    introVideo.volume = 1;
    await introVideo.play();
    introMessage.textContent = "";
  } catch (error) {
    console.warn("Intro video playback was blocked.", error);
    showIntroStart("اضغط لبدء المقدمة بالصوت ومتابعة استخدام المنصة.");
  }
}

function timestampText(value, includeTime = false) {
  if (!value?.toDate) return "";
  return value.toDate().toLocaleString("ar-EG", includeTime
    ? { dateStyle: "short", timeStyle: "short" }
    : { dateStyle: "medium" });
}

function remainingReferrals() {
  return Math.max(10 - Number(state.profile?.referralCount || 0), 0);
}

function clearSubscriptions() {
  for (const unsubscribe of unsubscribers.values()) unsubscribe();
  unsubscribers.clear();
}

function listen(key, reference, next, error = fail) {
  unsubscribers.get(key)?.();
  unsubscribers.set(key, onSnapshot(reference, next, error));
}

function listenProfile(uid) {
  listen("profile", doc(db, "profiles", uid), (snapshot) => {
    state.profile = snapshot.exists() ? snapshot.data() : null;
    if (state.profile && state.device?.status === "active") {
      listenWarnings(uid);
      listenSharedData();
    }
    render();
  });
}

function listenWarnings(uid) {
  listen("warnings", query(
    collection(db, "profiles", uid, "warnings"),
    orderBy("createdAt", "desc"),
  ), (snapshot) => {
    state.warnings = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
    render();
  });
}

function listenSharedData() {
  if (!state.admin && !state.profile) return;
  const canReadCourses = state.admin || Number(state.profile.referralCount || 0) >= 10;
  if (!canReadCourses) {
    state.courses = [];
    unsubscribers.get("courses")?.();
    unsubscribers.delete("courses");
  } else {
  const coursesQuery = state.admin
    ? query(collection(db, "courses"), orderBy("createdAt", "desc"))
    : query(
      collection(db, "courses"),
      where("grade", "==", state.profile.grade),
      where("track", "==", state.profile.track),
    );
  listen("courses", coursesQuery, (snapshot) => {
    state.courses = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
    if (state.selectedCourse && !state.courses.some((course) => course.id === state.selectedCourse.id)) {
      state.selectedCourse = null;
    }
    render();
  });
  }
  listen("announcements", query(
    collection(db, "announcements"),
    where("expiresAt", ">", new Date()),
    orderBy("expiresAt", "asc"),
  ), (snapshot) => {
    state.announcements = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
    if (state.nav === "updates" && !state.admin) markAnnouncementsSeen();
    render();
  });

  if (state.admin) {
    listen("students", query(collection(db, "profiles"), orderBy("createdAt", "desc")), (snapshot) => {
      state.students = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
      render();
    });
    listen("deviceCounts", query(collectionGroup(db, "sessions"), where("active", "==", true)), (snapshot) => {
      const counts = {};
      for (const session of snapshot.docs) {
        const uid = session.ref.parent.parent?.id;
        if (uid) counts[uid] = (counts[uid] || 0) + 1;
      }
      state.deviceCounts = counts;
      state.adminDeviceCount = adminUids.reduce((total, uid) => total + (counts[uid] || 0), 0);
      render();
    });
  }
}

async function markAnnouncementsSeen() {
  if (!state.user || state.admin) return;
  try {
    await Promise.all(state.announcements.map(async (announcement) => {
      const seenRef = doc(db, "announcements", announcement.id, "seen", state.user.uid);
      if (!(await getDoc(seenRef)).exists()) await setDoc(seenRef, { seenAt: serverTimestamp() });
    }));
  } catch (error) {
    fail(error);
  }
}

function listenLessons(course) {
  if (!course) {
    state.lessons = [];
    unsubscribers.get("lessons")?.();
    unsubscribers.delete("lessons");
    return;
  }
  listen("lessons", query(
    collection(db, "lessons"),
    where("courseId", "==", course.id),
    where("grade", "==", course.grade),
    where("track", "==", course.track),
  ), (snapshot) => {
    state.lessons = snapshot.docs
      .map((item) => ({ id: item.id, ...item.data() }))
      .sort((a, b) => a.chapterNumber - b.chapterNumber);
    render();
  });
}

function listenChat() {
  if (!state.user || (!state.admin && !state.profile)) return;
  if (state.nav !== "chat" && state.nav !== "support") return;
  const roomId = state.nav === "chat"
    ? "students"
    : `support_${state.admin ? state.supportTarget : state.user.uid}`;
  if (state.nav === "support" && state.admin && !state.supportTarget) {
    state.chatMessages = [];
    render();
    return;
  }
  const messages = collection(db, "chatRooms", roomId, "messages");
  const items = [[], []];
  const update = () => {
    state.chatMessages = items.flat()
      .filter((message, index, list) => list.findIndex((item) => item.id === message.id) === index)
      .sort((a, b) => (a.createdAt?.toMillis() || 0) - (b.createdAt?.toMillis() || 0));
    render();
  };
  const filters = [
    where("expiresAt", ">", new Date()),
    where("expiresAt", "==", null),
  ];
  filters.forEach((filter, index) => {
    listen(`chat${index}`, query(messages, filter, orderBy("createdAt", "asc")), (snapshot) => {
      items[index] = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
      update();
    });
  });
}

async function establishAdminDevice(user, claims) {
  const deviceId = getDeviceId();
  const sessionReference = doc(db, "devices", user.uid, "sessions", deviceId);
  if (claims.deviceSession === deviceId) {
    const session = await getDoc(sessionReference);
    if (session.exists() && session.data().active === true) {
      state.device = { status: "active" };
      return;
    }
  }
  const result = await call("registerDevice", {
    deviceId,
    label: navigator.userAgent.slice(0, 96),
  });
  if (result.token) {
    state.device = { status: "active" };
    resolvingAuth = true;
    await signInWithCustomToken(auth, result.token);
    resolvingAuth = false;
  } else {
    state.device = { status: "active" };
  }
}

onAuthStateChanged(auth, async (user) => {
  if (resolvingAuth) return;
  clearSubscriptions();
  state.user = user;
  state.profile = null;
  state.device = null;
  state.deviceError = "";
  state.admin = false;
  state.courses = [];
  state.lessons = [];
  state.chatMessages = [];
  if (!user) {
    state.authReady = true;
    render();
    return;
  }
  state.authReady = false;
  render();
  try {
    const token = await user.getIdTokenResult();
    state.admin = (token.claims.admin === true && adminUids.includes(user.uid))
      || (adminUids.includes(user.uid) && token.signInProvider === "google.com");
    if (state.adminLoginRequested && !state.admin) {
      state.adminLoginRequested = false;
      await signOut(auth);
      state.adminLoginError = "حساب Google هذا غير موجود ضمن حسابات المشرف المعتمدة.";
      return;
    }
    if (state.admin) state.adminLoginRequested = false;
    if (!state.admin) {
      const profile = await getDoc(doc(db, "profiles", user.uid));
      if (profile.exists()) state.profile = profile.data();
    }
    if (state.admin) {
      await establishAdminDevice(user, token.claims);
      if (state.device?.status === "active") {
        listenSharedData();
        listenDeviceSession(user.uid);
      }
    } else if (state.profile) {
      state.device = { status: "active" };
      if (state.profile.isActive) {
        listenProfile(user.uid);
        listenSharedData();
      }
    }
  } catch (error) {
    state.deviceError = messageFromError(error);
  } finally {
    state.authReady = true;
    render();
  }
});

function listenDeviceSession(uid) {
  const deviceId = getDeviceId();
  listen("currentDevice", doc(db, "devices", uid, "sessions", deviceId), (snapshot) => {
    if (!snapshot.exists() || snapshot.data().active !== true) {
      state.deviceError = "تم إنهاء جلسة هذا الجهاز. سجّل الدخول من جديد للمتابعة.";
      render();
    }
  });
}

function brand() {
  return `<div class="brand"><img src="./logo.jpeg" alt="شعار AF MASTER"><span><b>AF MASTER</b><small>LEARN • GROW • WIN</small></span></div>`;
}

function loginView() {
  return `<div class="login-screen">
    <div class="login-glow glow-one"></div><div class="login-glow glow-two"></div>
    <div class="login-layout">
      <section class="login-story">${brand()}
        <div class="story-copy">
          <span class="eyebrow"><span>✦</span> رحلتك التعليمية تبدأ الآن</span>
          <h1>تعلّم بذكاء.<br><span>وتقدّم بثقة.</span></h1>
          <p>كل منصاتك، دروسك، وإجاباتك في مكان واحد. مساحة تعليمية مصممة لتوصلك لهدفك.</p>
          <div class="feature-strip">
            <div><span>▤</span><b>محتوى مرتب</b><small>منصة · فصل · درس</small></div>
            <div><span>ϟ</span><b>تعلّم أسرع</b><small>إجابات بنقرة واحدة</small></div>
            <div><span>♢</span><b>مساحتك آمنة</b><small>حساب خاص بك</small></div>
          </div>
        </div>
        <div class="story-foot"><span class="online-dot"></span> منصتك الذكية لكل خطوة</div>
      </section>
      <section class="login-card">
        <div class="login-icon">⌂</div><span class="eyebrow">أهلاً بك في مجتمعنا</span>
        <h2>ابدأ رحلتك</h2><p>سجّل دخولك بحساب Google للوصول إلى منصتك التعليمية.</p>
        ${state.error ? `<div class="inline-error">${h(state.error)}</div>` : ""}
        <button class="google-button" data-action="google-login" ${state.busy ? "disabled" : ""}>
          <span class="google-g">G</span><span>${state.busy ? "جارٍ تسجيل الدخول..." : "المتابعة باستخدام Google"}</span><span>←</span>
        </button>
        <div class="admin-login">
          <button class="admin-login-button" type="button" data-action="admin-login" ${state.busy ? "disabled" : ""}>
            <span>♢</span><span>${state.busy && state.adminLoginRequested ? "جارٍ التحقق من حساب المشرف..." : "تسجيل دخول المشرف عبر Google"}</span><span class="admin-chevron">←</span>
          </button>
          ${state.adminLoginError ? `<div class="inline-error">${h(state.adminLoginError)}</div>` : ""}
        </div>
        <div class="login-separator"><span>تسجيل آمن وسريع</span></div>
        <div class="login-note"><span>♢</span><span>بيانات حسابك محمية ولا نشاركها مع الآخرين.</span></div>
        <div class="login-footer">بالمتابعة، أنت توافق على استخدام المنصة بشكل مسؤول.</div>
      </section>
    </div>
  </div>`;
}

function registrationView() {
  return `<div class="registration-screen"><section class="registration-card">
    ${brand()}<div class="form-heading"><span class="eyebrow">خطوة أخيرة</span><h1>جهّز حسابك الدراسي</h1><p>أكمل بياناتك لنخصص لك المحتوى المناسب.</p></div>
    <div class="google-account"><span class="avatar">${h(state.user?.displayName?.slice(0, 1) || "ط")}</span><div><b>${h(state.user?.displayName)}</b><small>${h(state.user?.email)}</small></div><button class="text-button" data-action="logout">تغيير الحساب</button></div>
    ${state.error ? `<div class="inline-error">${h(state.error)}</div>` : ""}
    <form class="form-grid" data-form="register">
      <label>الاسم الثلاثي أو الرباعي<input name="fullName" minlength="8" required placeholder="مثال: أحمد محمد علي حسن"></label>
      <label>رقم الهاتف<input name="phone" type="tel" dir="ltr" required placeholder="+20 10 0000 0000"></label>
      <div class="form-row"><label>الصف الدراسي<select name="grade">${gradeOptions()}</select></label><label>المسار<select name="track">${trackOptions()}</select></label></div>
      ${state.referralCode ? `<div class="referral-tag">✓ دعوة صديق مضافة تلقائياً</div>` : ""}
      <button class="button button-primary button-wide" ${state.busy ? "disabled" : ""}>${state.busy ? "جارٍ إنشاء الحساب..." : "إنشاء حسابي ←"}</button>
    </form>
    <p class="registration-foot">♢ رقم هاتفك واسمك يُستخدمان لمنع تكرار الحسابات فقط.</p>
  </section></div>`;
}

function gradeOptions(selected = grades[0]) {
  return grades.map((grade) => `<option ${grade === selected ? "selected" : ""}>${h(grade)}</option>`).join("");
}

function trackOptions(selected = tracks[0]) {
  return tracks.map((track) => `<option ${track === selected ? "selected" : ""}>${h(track)}</option>`).join("");
}

function accessView(title, body) {
  return `<div class="center-screen"><div class="access-card">${brand()}<div class="access-icon">♢</div><h1>${h(title)}</h1><p>${h(body)}</p><button class="button button-outline button-wide" data-action="logout">تسجيل الخروج</button></div></div>`;
}

function sidebar() {
  const items = [
    ["home", "الرئيسية", "⌂"],
    ["learning", "التعلّم", "▤"],
    ["chat", "شات الطلاب", "◌"],
    ["support", state.admin ? "محادثات الطلاب" : "تواصل مع المشرف", "?"],
    ["updates", "إعلانات المشرف", "▧"],
    ...(state.admin ? [["admin", "إدارة المنصة", "♢"]] : []),
  ];
  return `<aside class="sidebar">${brand()}<div class="side-label">القائمة الرئيسية</div>
    <nav class="side-nav">${items.map(([id, label, icon]) => `<button class="nav-item ${state.nav === id ? "active" : ""}" data-nav="${id}"><span class="nav-icon">${icon}</span><span>${h(label)}</span>${id === "updates" && state.announcements.length ? `<span class="nav-count">${state.announcements.length}</span>` : ""}</button>`).join("")}</nav>
    <div class="sidebar-bottom"><div class="side-promo"><div class="promo-orb">✦</div><strong>مستقبلك يبدأ هنا</strong><span>خطوة صغيرة كل يوم تصنع فرقاً كبيراً.</span></div>
    ${state.installPrompt ? `<button class="install-link" data-action="install">▣ ثبّت التطبيق</button>` : ""}
    <button class="profile-mini" data-action="profile"><span class="avatar">${h(displayName().slice(0, 1))}</span><span class="mini-name"><b>${h(displayName())}</b><small>${state.admin ? "مشرف المنصة" : h(state.profile?.studentCode || "طالب")}</small></span><span>⌄</span></button></div></aside>`;
}

function displayName() {
  return state.profile?.fullName || state.user?.displayName || "مشرف AF MASTER";
}

function shell(content) {
  const navLabel = {
    home: "الرئيسية",
    learning: "التعلّم",
    chat: "شات الطلاب",
    support: state.admin ? "محادثات الطلاب" : "تواصل مع المشرف",
    updates: "إعلانات المشرف",
    admin: "إدارة المنصة",
  }[state.nav] || "الرئيسية";
  return `<div class="app-shell">${sidebar()}<main class="main-area">
    <header class="topbar"><div class="breadcrumb"><span>AF MASTER</span><span>←</span><b>${h(navLabel)}</b></div>
    <div class="top-actions">${state.installPrompt ? `<button class="button button-outline install-top" data-action="install">▣ تثبيت التطبيق</button>` : ""}<button class="icon-button" title="تسجيل الخروج" data-action="logout">↪</button><button class="profile-top" data-action="profile"><span class="avatar small">${h(displayName().slice(0, 1))}</span><span>${h(displayName().split(" ")[0])}</span></button></div></header>
    ${state.error || state.notice ? `<div class="toast ${state.error ? "toast-error" : ""}" role="status"><span>${h(state.error || state.notice)}</span><button data-action="dismiss">×</button></div>` : ""}
    <div class="page-content">${content}</div>
  </main></div>${modalView()}`;
}

function render() {
  if (!state.authReady) {
    root.innerHTML = `<div class="center-screen"><div class="loading-mark"><img src="./logo.jpeg" alt=""><span class="spinner"></span></div></div>`;
  } else if (!state.user) {
    root.innerHTML = loginView();
  } else if (state.deviceError) {
    root.innerHTML = accessView("تعذر تفعيل هذا الجهاز", state.deviceError);
  } else if (state.device?.status === "pending") {
    root.innerHTML = accessView("طلب موافقة المشرف", "وصلت إلى حد الأجهزة المسموح. أرسلنا طلباً للمشرف، وسيفتح هذا الجهاز تلقائياً عند الموافقة.");
  } else if (!state.admin && !state.profile) {
    root.innerHTML = registrationView();
  } else if (!state.admin && !state.profile.isActive) {
    root.innerHTML = accessView("الحساب موقوف", "تواصل مع المشرف لمعرفة تفاصيل إيقاف الحساب.");
  } else {
    root.innerHTML = shell(pageView());
  }
}

function pageView() {
  switch (state.nav) {
    case "learning": return learningView();
    case "chat": return chatView(false);
    case "support": return chatView(true);
    case "updates": return announcementsView();
    case "admin": return state.admin ? adminView() : dashboardView();
    default: return dashboardView();
  }
}

function statCard(icon, label, value, note, tint) {
  return `<article class="stat-card ${tint}"><div class="stat-top"><span class="stat-icon">${icon}</span><span class="stat-spark">↗</span></div><div class="stat-value">${h(value)}</div><div class="stat-label">${h(label)}</div><div class="stat-note">${h(note)}</div></article>`;
}

function courseCard(course, index) {
  const color = ["course-cyan", "course-purple", "course-blue"][index % 3];
  return `<button class="course-card ${color}" data-course="${h(course.id)}"><div class="course-card-top"><span class="course-icon">▤</span><span class="course-arrow">←</span></div><div class="course-card-copy"><span>${h(course.grade)} · ${h(course.track)}</span><h3>${h(course.title)}</h3><p>${h(course.description || "محتوى تعليمي منظم حسب الفصول والدروس.")}</p></div><div class="course-card-bottom"><span>ابدأ التعلّم</span><span class="course-dots">•••</span></div></button>`;
}

function emptyState(icon, title, body, action = "") {
  return `<div class="empty-state"><span class="empty-icon">${icon}</span><h3>${h(title)}</h3><p>${h(body)}</p>${action}</div>`;
}

function progressBlock() {
  const referrals = Math.min(Number(state.profile?.referralCount || 0), 10);
  return `<div class="referral-progress"><div class="progress-label"><span>الإحالات المؤكدة</span><b>${referrals} <small>/ 10</small></b></div><div class="progress-track"><span style="width:${referrals * 10}%"></span></div></div>`;
}

function dashboardView() {
  const firstName = displayName().split(" ")[0];
  const referrals = Number(state.profile?.referralCount || 0);
  const preview = state.courses.slice(0, 2);
  return `<div class="dashboard-page"><div class="welcome-banner"><div class="welcome-content"><span class="eyebrow"><span class="online-dot"></span> منصتك التعليمية في مكان واحد</span>
    <h1>${state.admin ? "أهلاً بك في لوحة الإشراف" : `أهلاً يا ${h(firstName)}،<br>جاهز لخطوتك الجاية؟`}</h1>
    <p>${state.admin ? "أدر المحتوى وتابع الطلاب من مكان واحد." : "اختار درس النهاردة وخلي هدفك أقرب."}</p>
    ${state.admin ? "" : `<button class="button button-light" data-nav="learning">ابدأ التعلّم ←</button>`}</div>
    <div class="welcome-art" aria-hidden="true"><div class="art-ring ring-a"></div><div class="art-ring ring-b"></div><div class="art-book">▤</div><div class="art-star star-a">✦</div><div class="art-star star-b">✧</div><div class="art-dot"></div></div><div class="banner-grain"></div></div>
    <div class="stat-grid">${statCard("▤", "المنصات المتاحة", String(state.courses.length).padStart(2, "0"), state.admin ? "في مكتبة المحتوى" : "جاهزة لتبدأ", "cyan")}${statCard("▧", "إعلانات جديدة", String(state.announcements.length).padStart(2, "0"), "من فريق الإشراف", "purple")}${statCard("⌂", state.admin ? "أجهزة المشرف النشطة" : "الصف الدراسي", state.admin ? String(state.adminDeviceCount) : state.profile.grade.replace(" الثانوي", ""), state.admin ? "بلا حد أقصى" : state.profile.track, "blue")}</div>
    ${state.admin ? "" : `${state.warnings.length ? `<section class="panel warning-panel"><div class="panel-heading"><div><span class="eyebrow">تنبيه من الإشراف</span><h2>ملاحظات على حسابك</h2></div></div>${state.warnings.map((warning) => `<article class="warning-row"><b>${h(warning.body)}</b><small>${h(timestampText(warning.createdAt, true))}</small></article>`).join("")}</section>` : ""}
    <div class="dashboard-columns"><section class="panel learning-panel"><div class="panel-heading"><div><span class="eyebrow">مساحة التعلّم</span><h2>منصاتك الدراسية</h2></div><button class="text-button" data-nav="learning">عرض الكل ←</button></div>
    ${preview.length ? `<div class="course-mini-grid">${preview.map(courseCard).join("")}</div>` : emptyState("▤", "لسه مفيش منصات", "سيظهر محتوى صفك هنا بمجرد إضافته من المشرف.")}</section>
    <section class="panel referral-panel"><div class="referral-top"><div class="referral-icon">♧</div><span class="pill">دعوة الأصدقاء</span></div><h2>تعلّموا مع بعض!</h2><p>شارك رابط دعوتك مع أصدقائك. تُحتسب الدعوة بعد تسجيل حساب جديد.</p>${progressBlock()}<button class="button button-outline button-wide" data-action="share">شارك رابط الدعوة</button><small class="referral-hint">لا نتحقق من إرسال رسالة واتساب؛ تحتسب الإحالات لحسابات جديدة فقط.</small></section></div>`}
    ${state.announcements.length ? `<section class="panel announcement-preview"><div class="panel-heading"><div><span class="eyebrow">آخر التحديثات</span><h2>رسائل المشرف</h2></div><span class="pill">${state.announcements.length} جديد</span></div><div class="announcement-list">${state.announcements.slice(0, 2).map((announcement) => `<article class="announcement-row"><span class="announcement-symbol">▧</span><div><b>${h(announcement.title)}</b><p>${h(announcement.body)}</p></div><span class="read-check">✓✓</span></article>`).join("")}</div></section>` : ""}
    ${state.installPrompt ? `<div class="install-banner"><span>▣</span><div><b>خلّي AF MASTER أقرب ليك</b><span>ثبّت المنصة على جهازك وافتحها بسهولة.</span></div><button class="button button-light" data-action="install">تثبيت ←</button></div>` : ""}${state.installed ? `<div class="installed-note">✓ تم تثبيت AF MASTER على جهازك.</div>` : ""}
  </div>`;
}

function chapterGroups() {
  const groups = new Map();
  for (const lesson of state.lessons) {
    groups.set(lesson.chapterNumber, [...(groups.get(lesson.chapterNumber) || []), lesson]);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]);
}

function learningView() {
  if (!state.admin && Number(state.profile?.referralCount || 0) < 10) {
    return `<div class="learning-page"><div class="page-title-row"><div><span class="eyebrow">مكتبتك التعليمية</span><h1>افتح منصات التعلّم</h1><p>ادعُ أصدقاءك للانضمام إلى AF MASTER.</p></div></div>
      <section class="unlock-card"><div class="unlock-art">♧</div><span class="eyebrow">معاً نتعلّم أفضل</span><h2>باقي لك ${remainingReferrals()} إحالات مؤكدة</h2><p>تُحتسب الإحالة عندما يسجل صديق جديد بحسابه ورقم هاتفه. لا يمكن للمنصة التحقق من إرسال رسائل واتساب نفسها.</p>${progressBlock()}<button class="button button-primary" data-action="share">شارك رابط الدعوة</button></section></div>`;
  }
  if (state.selectedLesson) return lessonView();
  if (state.selectedCourse) {
    const groups = chapterGroups();
    return `<div class="learning-page"><div class="learning-breadcrumb"><button class="text-button" data-action="back-courses">كل المنصات</button> ← <b>${h(state.selectedCourse.title)}</b></div>
      <div class="page-title-row course-title-row"><div><span class="eyebrow">${h(state.selectedCourse.grade)} · ${h(state.selectedCourse.track)}</span><h1>${h(state.selectedCourse.title)}</h1><p>${h(state.selectedCourse.description || "اختار الفصل أو المحتوى اللي حابب تراجعه.")}</p></div>${state.admin ? `<button class="button button-primary" data-action="add-lesson">＋ إضافة درس أو امتحان</button>` : ""}</div>
      ${groups.length ? `<div class="chapter-list">${groups.map(([number, items]) => `<section class="chapter-card"><div class="chapter-title"><span class="chapter-index">${String(number).padStart(2, "0")}</span><div><span class="eyebrow">الفصل ${number}</span><h2>${h(items[0]?.chapterTitle || `الفصل ${number}`)}</h2></div><span class="chapter-count">${items.length} محتوى</span></div><div class="chapter-lessons">${items.map((lesson, index) => `<button class="lesson-row" data-lesson="${h(lesson.id)}"><span class="lesson-index ${lesson.type === "exam" ? "exam-index" : ""}">${lesson.type === "exam" ? "▣" : String(index + 1).padStart(2, "0")}</span><span class="lesson-row-copy"><b>${h(lesson.title)}</b><small>${lesson.type === "exam" ? "امتحان ومراجعة" : `${lesson.entries?.length || 0} سؤال وإجابة`}</small></span><span>←</span></button>`).join("")}</div></section>`).join("")}</div>` : emptyState("▤", "الفصل ينتظر محتواه", "سيظهر الدرس والامتحان هنا بمجرد إضافتهما.", state.admin ? `<button class="button button-primary" data-action="add-lesson">＋ إضافة درس</button>` : "")}</div>`;
  }
  return `<div class="learning-page"><div class="page-title-row"><div><span class="eyebrow">مكتبتك التعليمية</span><h1>اختار منصتك وابدأ</h1><p>محتوى مرتب حسب الصف والمسار الدراسي.</p></div>${state.admin ? `<button class="button button-primary" data-action="add-course">＋ إضافة منصة</button>` : ""}</div>
    ${state.admin ? "" : `<div class="filter-chips"><span class="filter-chip">⌂ ${h(state.profile.grade)}</span><span class="filter-chip">${h(state.profile.track)}</span></div>`}
    ${state.courses.length ? `<div class="course-grid">${state.courses.map(courseCard).join("")}</div>` : emptyState("▤", state.admin ? "أضف أول منصة تعليمية" : "محتوى صفك قادم قريباً", state.admin ? "أنشئ منصة، ثم أضف الفصول والدروس والأسئلة." : "سيظهر المحتوى الذي يضيفه المشرف هنا.", state.admin ? `<button class="button button-primary" data-action="add-course">＋ إضافة منصة</button>` : "")}
  </div>`;
}

function lessonView() {
  const lesson = state.selectedLesson;
  if (lesson.type === "exam" && state.examLessonId !== lesson.id) {
    state.examEntries = [...(lesson.entries || [])];
    for (let index = state.examEntries.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(Math.random() * (index + 1));
      [state.examEntries[index], state.examEntries[swap]] = [state.examEntries[swap], state.examEntries[index]];
    }
    state.examLessonId = lesson.id;
  }
  const entries = lesson.type === "exam" ? state.examEntries : (lesson.entries || []);
  const position = state.lessons.findIndex((item) => item.id === lesson.id);
  return `<div class="learning-page"><div class="learning-breadcrumb"><button class="text-button" data-action="back-lessons">${h(state.selectedCourse?.title || "")}</button> ← <b>${h(lesson.title)}</b></div>
    <div class="lesson-heading"><div class="lesson-symbol">▤</div><div><span class="eyebrow">${lesson.type === "exam" ? "مراجعة واختبار" : `الفصل ${lesson.chapterNumber}`}</span><h1>${h(lesson.title)}</h1></div><span class="pill">${entries.length} سؤال</span></div>
    ${lesson.type === "exam" ? `<div class="exam-note">✦ قد تظهر الأسئلة بترتيب مختلف في الامتحان. راجع كل إجابة جيداً.</div>` : ""}
    <div class="qa-list">${entries.map((entry, index) => `<article class="qa-card"><div class="qa-number">س${String(index + 1).padStart(2, "0")}</div><div class="qa-body"><h3>${h(entry.question)}</h3><div class="answer-box"><span>الإجابة</span><p>${h(entry.answer)}</p></div></div><button class="copy-button" data-copy="${h(entry.answer)}"><span>▣</span><span>نسخ</span></button></article>`).join("")}</div>
    <div class="lesson-next"><span>✓✓ ${position === state.lessons.length - 1 ? "أنهيت آخر محتوى في هذه المنصة" : "أحسنت! أكملت هذا المحتوى"}</span><button class="button button-primary" data-action="next-lesson">${position === state.lessons.length - 1 ? "إنهاء" : "التالي"} ←</button></div></div>`;
}

function chatView(support) {
  const title = support ? (state.admin ? "محادثة خاصة مع الطالب" : "تواصل مع المشرف") : "شات الطلاب";
  const description = support
    ? (state.admin ? "هذه المحادثة خاصة بينك وبين الطالب." : "رسالتك خاصة ولا يراها إلا فريق الإشراف. سيصلك رد خلال 24 ساعة.")
    : "تواصل مع زملائك في مساحة واحدة. تُحذف الرسائل بعد 24 ساعة.";
  const targetSelector = support && state.admin ? `<div class="support-select"><label for="support-student">اختر الطالب للتواصل</label><select id="support-student" data-change="support-target"><option value="">اختر حساباً</option>${state.students.map((student) => `<option value="${h(student.id)}" ${state.supportTarget === student.id ? "selected" : ""}>${h(student.fullName)} · ${h(student.studentCode)}</option>`).join("")}</select></div>` : "";
  return `<section class="chat-page">${targetSelector}<div class="page-title-row"><div><span class="eyebrow">مساحة التواصل</span><h1>${title}</h1><p>${description}</p></div><span class="privacy-badge">♢ ${support ? "محادثة خاصة" : "رسائل مؤقتة"}</span></div>
    <div class="chat-card"><div class="chat-head"><div class="chat-head-icon">◌</div><div><b>${title}</b><small>${support ? "بين المشرف والطالب فقط" : "تُحذف الرسائل تلقائياً بعد 24 ساعة"}</small></div><span class="online-dot"></span></div>
    <div class="chat-stream">${state.chatMessages.length ? state.chatMessages.map((message) => `<div class="chat-message ${message.kind === "system" ? "system-message" : message.senderId === state.user.uid ? "mine" : ""}"><div class="message-meta"><b>${h(message.senderName)}</b><small>${h(timestampText(message.createdAt, true))}</small></div><p>${h(message.text)}</p>${state.admin && message.kind !== "system" ? `<button class="message-delete" data-delete-message="${h(message.id)}">×</button>` : ""}</div>`).join("") : emptyState("◌", "ابدأ المحادثة", state.admin && support && !state.supportTarget ? "اختر حساب طالب أولاً." : "اكتب أول رسالة وابدأ التواصل.")}</div>
    <form class="chat-composer" data-form="chat"><input name="text" value="${h(state.chatText)}" placeholder="اكتب رسالتك هنا..." maxlength="2000" ${state.admin && support && !state.supportTarget ? "disabled" : ""}><button class="send-button" ${state.busy ? "disabled" : ""}>➤</button></form></div></section>`;
}

function announcementsView() {
  return `<div class="announcements-page"><div class="page-title-row"><div><span class="eyebrow">من فريق AF MASTER</span><h1>الإعلانات والرسائل</h1><p>آخر الأخبار والتنبيهات المهمة للطلاب.</p></div><span class="privacy-badge">▧ ${state.announcements.length} رسالة</span></div>
    ${state.admin ? `<form class="panel announcement-form" data-form="announcement"><h2>إرسال إعلان جديد</h2><div class="form-row"><input name="title" required placeholder="عنوان الإعلان"><button class="button button-primary">إرسال للجميع →</button></div><textarea name="body" required rows="3" placeholder="اكتب رسالتك للطلاب..."></textarea></form>` : ""}
    ${state.announcements.length ? `<div class="announcement-list full-list">${state.announcements.map((announcement) => `<article class="announcement-card"><span class="announcement-symbol">▧</span><div class="announcement-card-copy"><div class="announcement-meta"><span>رسالة من المشرف</span><small>${h(timestampText(announcement.createdAt))}</small></div><h2>${h(announcement.title)}</h2><p>${h(announcement.body)}</p></div><span class="announcement-read">✓✓ تمت القراءة</span></article>`).join("")}</div>` : emptyState("▧", "لا توجد رسائل حالياً", "ستظهر هنا إعلانات المشرف الجديدة.")}</div>`;
}

function adminView() {
  const students = state.students
    .filter((student) => `${student.fullName} ${student.phone} ${student.studentCode} ${student.email || ""}`.toLowerCase().includes(state.search.toLowerCase()));
  return `<div class="admin-page"><div class="page-title-row"><div><span class="eyebrow">مركز التحكم</span><h1>إدارة المنصة</h1><p>تابع حسابات الطلاب وأدر محتوى المنصة.</p></div><span class="admin-badge">♢ صلاحيات المشرف</span></div>
    <div class="admin-metrics">${statCard("♧", "حسابات مسجلة", String(state.students.length).padStart(2, "0"), "طلاب على المنصة", "cyan")}${statCard("G", "تسجيل الطلاب", "Google", "حساب مرتبط بالطالب", "purple")}${statCard("▤", "منصات تعليمية", String(state.courses.length).padStart(2, "0"), "في مكتبة المحتوى", "blue")}</div>
    <section class="panel students-panel"><div class="panel-heading"><div><span class="eyebrow">قاعدة الحسابات</span><h2>حسابات الطلاب</h2></div><div class="search-field"><span>⌕</span><input data-change="search" value="${h(state.search)}" placeholder="ابحث بالاسم أو الكود"></div></div>
    <div class="student-table-wrap"><table class="student-table"><thead><tr><th>الطالب والبريد</th><th>كود الدعوة</th><th>الهاتف</th><th>الصف / المسار</th><th>الحالة</th><th>إجراءات</th></tr></thead><tbody>${students.map((student) => `<tr><td><div class="student-name"><span class="avatar tiny">${h(student.fullName?.slice(0, 1))}</span><span class="student-identity"><b>${h(student.fullName)}</b><small>${h(student.email)}</small></span></div></td><td><span class="code">${h(student.studentCode || "—")}</span></td><td dir="ltr">${h(student.phone)}</td><td>${h(student.grade)} · ${h(student.track)}</td><td><span class="status-pill ${student.isActive ? "status-active" : "status-banned"}">${student.isActive ? "نشط" : "محظور"}</span></td><td><div class="table-actions"><button title="تحذير" data-warning="${h(student.id)}">▧</button>${student.isActive ? `<button class="danger-icon" title="حظر" data-ban="${h(student.id)}">♢</button>` : ""}</div></td></tr>`).join("")}</tbody></table>${students.length ? "" : emptyState("♧", "لا توجد حسابات", "ستظهر الحسابات المسجلة هنا.")}</div></section></div>`;
}

function modalView() {
  if (!state.modal) return "";
  if (state.modal === "profile") {
    return `<div class="modal-backdrop" data-action="backdrop"><section class="modal-card"><div class="modal-heading"><h2>إعدادات الحساب</h2><button class="icon-button" data-action="close-modal">×</button></div>
      ${state.admin ? `<div class="profile-details"><div><span>الحساب</span><b>${h(state.user.email || "دخول آمن للمشرف")}</b></div><div><span>الدور</span><b>مشرف AF MASTER</b></div><button class="button button-outline" data-action="logout">تسجيل الخروج</button></div>` : `<form class="form-grid" data-form="school-info"><p class="muted">كود الدعوة: <b class="code">${h(state.profile.studentCode || "—")}</b></p><small>سجّل الدخول إلى حسابك باستخدام Google.</small><label>الصف الدراسي<select name="grade">${gradeOptions(state.profile.grade)}</select></label><label>المسار<select name="track">${trackOptions(state.profile.track)}</select></label><button class="button button-primary">حفظ التعديلات</button></form>`}</section></div>`;
  }
  if (state.modal === "course") {
    return `<div class="modal-backdrop" data-action="backdrop"><section class="modal-card"><div class="modal-heading"><h2>إضافة منصة جديدة</h2><button class="icon-button" data-action="close-modal">×</button></div><form class="form-grid" data-form="course"><label>اسم المنصة<input name="title" required placeholder="مثال: منصة الرياضيات"></label><label>وصف مختصر<input name="description" placeholder="محتوى المنصة"></label><div class="form-row"><label>الصف<select name="grade">${gradeOptions()}</select></label><label>المسار<select name="track">${trackOptions()}</select></label></div><button class="button button-primary">＋ إضافة المنصة</button></form></section></div>`;
  }
  if (state.modal === "lesson") {
    return `<div class="modal-backdrop" data-action="backdrop"><section class="modal-card"><div class="modal-heading"><h2>إضافة محتوى · ${h(state.selectedCourse?.title || "")}</h2><button class="icon-button" data-action="close-modal">×</button></div><form class="form-grid lesson-form" data-form="lesson">
      <div class="form-row"><label>رقم الفصل<input name="chapterNumber" type="number" min="1" value="1" required></label><label>اسم الفصل<input name="chapterTitle" required placeholder="اسم الفصل"></label></div>
      <label>اسم الدرس / الامتحان<input name="title" required placeholder="مثال: الدرس الأول"></label><label>نوع المحتوى<select name="type"><option value="lesson">درس</option><option value="exam">امتحان</option></select></label>
      <div class="question-fields">${Array.from({ length: 3 }, (_, index) => questionFields(index)).join("")}</div>
      <button type="button" class="text-button" data-action="add-question">＋ إضافة سؤال</button><button class="button button-primary">حفظ المحتوى</button></form></section></div>`;
  }
  return "";
}

function questionFields(index) {
  return `<div class="question-entry"><b>سؤال ${index + 1}</b><label>السؤال<textarea name="question-${index}" rows="2" ${index === 0 ? "required" : ""} placeholder="اكتب السؤال..."></textarea></label><label>الإجابة<textarea name="answer-${index}" rows="2" ${index === 0 ? "required" : ""} placeholder="اكتب الإجابة..."></textarea></label></div>`;
}

function currentFormData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

async function handleSubmit(event) {
  const form = event.target.closest("form[data-form]");
  if (!form) return;
  event.preventDefault();
  const data = currentFormData(form);
  state.busy = true;
  state.error = "";
  state.adminLoginError = "";
  render();
  try {
    switch (form.dataset.form) {
      case "register": {
        const fullName = normalizeStudentName(data.fullName);
        const normalizedName = fullName.toLowerCase();
        const phone = latinDigits(data.phone).replace(/[^\d+]/g, "");
        const grade = String(data.grade || "");
        const track = String(data.track || "");
        if (fullName.split(" ").length < 3 || fullName.length < 8 || fullName.includes("/")) {
          throw new Error("اكتب اسمك الثلاثي على الأقل.");
        }
        if (!/^\+?\d{8,15}$/.test(phone)) throw new Error("أدخل رقم هاتف صحيحاً.");
        if (!grades.includes(grade)) throw new Error("اختر صفاً دراسياً صحيحاً.");
        if (!tracks.includes(track)) throw new Error("اختر المسار الدراسي.");
        if (!state.user || adminUids.includes(state.user.uid)) {
          throw new Error("لا يمكن إنشاء حساب طالب بهذا الحساب.");
        }

        let referredByUid = null;
        const referralCodeUsed = state.referralCode.trim().toUpperCase() || null;
        if (referralCodeUsed) {
          if (!/^AF[A-F0-9]{8}$/.test(referralCodeUsed)) {
            throw new Error("كود الدعوة غير صالح.");
          }
          const referralSnapshot = await getDoc(doc(db, "referralCodes", referralCodeUsed));
          if (!referralSnapshot.exists()) throw new Error("كود الدعوة غير موجود.");
          referredByUid = referralSnapshot.data().uid;
          if (!referredByUid || referredByUid === state.user.uid) {
            throw new Error("لا يمكن استخدام كود الدعوة الخاص بحسابك.");
          }
        }

        const studentCode = createStudentCode();
        const profileRef = doc(db, "profiles", state.user.uid);
        const batch = writeBatch(db);
        batch.set(profileRef, {
          uid: state.user.uid,
          fullName,
          normalizedName,
          email: state.user.email || "",
          phone,
          grade,
          track,
          studentCode,
          referredByUid,
          referralCodeUsed,
          isActive: true,
          referralCount: 0,
          createdAt: serverTimestamp(),
        });
        batch.set(doc(db, "phoneNumbers", phone), {
          uid: state.user.uid,
          createdAt: serverTimestamp(),
        });
        batch.set(doc(db, "profileNames", normalizedName), { uid: state.user.uid });
        batch.set(doc(db, "referralCodes", studentCode), { uid: state.user.uid });
        if (referredByUid && referralCodeUsed) {
          batch.set(doc(db, "profiles", referredByUid, "referrals", state.user.uid), {
            referredUid: state.user.uid,
            referralCode: referralCodeUsed,
            createdAt: serverTimestamp(),
          });
          batch.update(doc(db, "profiles", referredByUid), {
            referralCount: increment(1),
          });
        }
        await batch.commit();
        const profile = await getDoc(profileRef);
        if (!profile.exists()) throw new Error("تم الحفظ لكن تعذر تحميل بيانات الحساب. أعد تحميل الصفحة.");
        state.profile = profile.data();
        state.device = { status: "active" };
        listenProfile(state.user.uid);
        listenSharedData();
        notify("تم إنشاء حسابك بنجاح.");
        break;
      }
      case "chat":
        await call("sendChatMessage", {
          roomType: state.nav === "support" ? "support" : "students",
          recipientUid: state.nav === "support" && state.admin ? state.supportTarget : "",
          text: String(data.text || "").trim(),
        });
        state.chatText = "";
        break;
      case "course":
        await addDoc(collection(db, "courses"), {
          title: String(data.title).trim(),
          description: String(data.description || "").trim(),
          grade: data.grade,
          track: data.track,
          createdAt: serverTimestamp(),
        });
        state.modal = "";
        notify("تمت إضافة المنصة بنجاح.");
        break;
      case "lesson": {
        const entries = [];
        for (let index = 0; index < 8; index += 1) {
          const question = String(data[`question-${index}`] || "").trim();
          const answer = String(data[`answer-${index}`] || "").trim();
          if (question && answer) entries.push({ question, answer });
        }
        if (!entries.length) throw new Error("أضف سؤالاً وإجابة واحدة على الأقل.");
        await addDoc(collection(db, "lessons"), {
          courseId: state.selectedCourse.id,
          grade: state.selectedCourse.grade,
          track: state.selectedCourse.track,
          chapterNumber: Number(data.chapterNumber),
          chapterTitle: String(data.chapterTitle).trim(),
          title: String(data.title).trim(),
          type: data.type,
          entries,
          createdAt: serverTimestamp(),
        });
        state.modal = "";
        notify("تمت إضافة المحتوى بنجاح.");
        break;
      }
      case "school-info":
        if (!grades.includes(String(data.grade)) || !tracks.includes(String(data.track))) {
          throw new Error("اختر الصف والمسار الدراسيين.");
        }
        await updateDoc(doc(db, "profiles", state.user.uid), {
          grade: data.grade,
          track: data.track,
        });
        state.profile = { ...state.profile, grade: data.grade, track: data.track };
        state.modal = "";
        notify("تم تحديث الصف والمسار الدراسي.");
        break;
      case "announcement":
        await call("createAnnouncement", { title: data.title, body: data.body });
        notify("تم إرسال الإعلان للطلاب. سيُحذف تلقائياً بعد 3 أيام.");
        break;
      default:
        break;
    }
  } catch (error) {
    console.error(`AF MASTER form submission failed (${form.dataset.form}).`, error);
    state.error = form.dataset.form === "register" && error?.code === "permission-denied"
      ? "الاسم أو رقم الهاتف مستخدم بالفعل، أو لم تُنشر قواعد التسجيل الجديدة في Firestore."
      : messageFromError(error);
  } finally {
    state.busy = false;
    render();
  }
}

async function logout() {
  try {
    const user = auth.currentUser;
    const token = user ? await user.getIdTokenResult() : null;
    if (token?.claims.deviceSession) await call("logoutDevice", { deviceId: getDeviceId() });
  } catch (error) {
    state.error = messageFromError(error);
  }
  await signOut(auth);
  state.device = null;
  state.deviceError = "";
  state.adminLoginRequested = false;
  state.modal = "";
  state.nav = "home";
}

async function loginWithGoogle(asAdmin = false) {
  state.busy = true;
  state.error = "";
  if (asAdmin) {
    state.adminLoginRequested = true;
    state.adminLoginError = "";
  }
  render();
  try {
    await signInWithPopup(auth, googleProvider);
  } catch (error) {
    if (asAdmin) {
      state.adminLoginRequested = false;
      state.adminLoginError = messageFromError(error);
    } else {
      fail(error);
    }
  } finally {
    state.busy = false;
    render();
  }
}

async function shareInvite() {
  const text = `انضم إلى AF MASTER وابدأ التعلم معي! ${location.origin}${location.pathname}?ref=${state.profile?.studentCode || ""}`;
  try {
    if (navigator.share) await navigator.share({ title: "AF MASTER", text });
    else {
      await navigator.clipboard.writeText(text);
      notify("تم نسخ رابط الدعوة. تُحتسب الإحالة بعد تسجيل صديقك بحساب جديد.");
    }
  } catch (error) {
    if (error.name !== "AbortError") fail(error);
  }
}

async function clickAction(action, target, originalTarget) {
  switch (action) {
    case "google-login":
      await loginWithGoogle();
      break;
    case "admin-login":
      await loginWithGoogle(true);
      break;
    case "logout": await logout(); break;
    case "dismiss": state.error = ""; state.notice = ""; render(); break;
    case "profile": state.modal = "profile"; render(); break;
    case "close-modal": state.modal = ""; render(); break;
    case "backdrop":
      if (originalTarget === target) { state.modal = ""; render(); }
      break;
    case "share": await shareInvite(); break;
    case "install":
      if (state.installPrompt) {
        await state.installPrompt.prompt();
        await state.installPrompt.userChoice;
        state.installPrompt = null;
        render();
      }
      break;
    case "add-course": state.modal = "course"; render(); break;
    case "add-lesson": state.modal = "lesson"; render(); break;
    case "add-question": {
      const form = target.closest("form");
      const fields = form.querySelector(".question-fields");
      const count = fields.querySelectorAll(".question-entry").length;
      if (count < 8) fields.insertAdjacentHTML("beforeend", questionFields(count));
      break;
    }
    case "back-courses":
      state.selectedCourse = null; state.selectedLesson = null; state.examLessonId = ""; listenLessons(null); render(); break;
    case "back-lessons": state.selectedLesson = null; render(); break;
    case "next-lesson": {
      const index = state.lessons.findIndex((lesson) => lesson.id === state.selectedLesson?.id);
      state.selectedLesson = state.lessons[index + 1] || null;
      render();
      break;
    }
    default: break;
  }
}

async function moderateStudent(uid, ban) {
  const student = state.students.find((item) => item.id === uid);
  if (!student) return;
  if (ban) {
    if (!window.confirm(`هل تريد حظر ${student.fullName}؟`)) return;
    try {
      await call("setStudentStatus", { uid, banned: true });
      notify("تم حظر الحساب.");
    } catch (error) { fail(error); }
  } else {
    const body = window.prompt(`اكتب سبب التحذير للطالب ${student.fullName}:`);
    if (!body) return;
    try {
      await call("createWarning", { uid, body });
      notify("تم إرسال التحذير للطالب.");
    } catch (error) { fail(error); }
  }
}

async function handleClick(event) {
  const navButton = event.target.closest("[data-nav]");
  if (navButton) {
    state.nav = navButton.dataset.nav;
    state.selectedLesson = null;
    if (state.nav === "learning") listenLessons(state.selectedCourse);
    if (state.nav === "chat" || state.nav === "support") listenChat();
    else {
      unsubscribers.get("chat0")?.();
      unsubscribers.get("chat1")?.();
      unsubscribers.delete("chat0");
      unsubscribers.delete("chat1");
    }
    if (state.nav === "updates") markAnnouncementsSeen();
    state.error = "";
    render();
    return;
  }
  const courseButton = event.target.closest("[data-course]");
  if (courseButton) {
    state.selectedCourse = state.courses.find((course) => course.id === courseButton.dataset.course) || null;
    state.selectedLesson = null;
    state.examLessonId = "";
    state.nav = "learning";
    listenLessons(state.selectedCourse);
    render();
    return;
  }
  const lessonButton = event.target.closest("[data-lesson]");
  if (lessonButton) {
    state.selectedLesson = state.lessons.find((lesson) => lesson.id === lessonButton.dataset.lesson) || null;
    state.examLessonId = "";
    render();
    return;
  }
  const copyButton = event.target.closest("[data-copy]");
  if (copyButton) {
    try {
      await navigator.clipboard.writeText(copyButton.dataset.copy);
      notify("تم نسخ الإجابة.");
    } catch (error) { fail(error); }
    return;
  }
  const deleteButton = event.target.closest("[data-delete-message]");
  if (deleteButton) {
    try {
      const roomId = state.nav === "chat" ? "students" : `support_${state.supportTarget}`;
      await call("deleteChatMessage", { roomId, messageId: deleteButton.dataset.deleteMessage });
      notify("تم حذف الرسالة.");
    } catch (error) { fail(error); }
    return;
  }
  const banButton = event.target.closest("[data-ban]");
  if (banButton) { await moderateStudent(banButton.dataset.ban, true); return; }
  const warningButton = event.target.closest("[data-warning]");
  if (warningButton) { await moderateStudent(warningButton.dataset.warning, false); return; }
  const action = event.target.closest("[data-action]");
  if (action) await clickAction(action.dataset.action, action, event.target);
}

root.addEventListener("click", handleClick);
root.addEventListener("submit", handleSubmit);
root.addEventListener("change", (event) => {
  const target = event.target;
  if (target.dataset.change === "support-target") {
    state.supportTarget = target.value;
    listenChat();
  }
});
root.addEventListener("input", (event) => {
  if (event.target.dataset.change === "search") {
    const selection = event.target.selectionStart;
    state.search = event.target.value;
    const position = selection;
    render();
    const search = root.querySelector('[data-change="search"]');
    search?.focus();
    search?.setSelectionRange(position, position);
  }
  if (event.target.name === "text") state.chatText = event.target.value;
});

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  state.installPrompt = event;
  render();
});
window.addEventListener("appinstalled", () => {
  state.installed = true;
  state.installPrompt = null;
  render();
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((error) => console.error("Service worker registration failed.", error));
  });
}

if (state.introVisible) {
  introOverlay.hidden = false;
  introOverlay.setAttribute("aria-hidden", "false");
  introVideo.addEventListener("ended", finishIntro, { once: true });
  introVideo.addEventListener("error", () => {
    showIntroStart("تعذر تحميل الفيديو. تحقق من اتصالك ثم أعد المحاولة.", "إعادة محاولة تشغيل المقدمة");
  });
  playIntro();
} else {
  introOverlay.hidden = true;
  introOverlay.setAttribute("aria-hidden", "true");
  introVideo.pause();
}

introStartButton.addEventListener("click", () => {
  if (introVideo.error) introVideo.load();
  playIntro();
});

render();
