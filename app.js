import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import {
  EmailAuthProvider,
  GoogleAuthProvider,
  connectAuthEmulator,
  getAuth,
  linkWithCredential,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import {
  addDoc,
  collection,
  collectionGroup,
  connectFirestoreEmulator,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  increment,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import { adminUids, firebaseConfig } from "./firebase-config.js";

const useEmulators = ["localhost", "127.0.0.1"].includes(location.hostname)
  && new URLSearchParams(location.search).get("emulator") === "1";
const app = initializeApp(useEmulators
  ? {
    ...firebaseConfig,
    apiKey: "demo-api-key",
    authDomain: "demo-af-master.firebaseapp.com",
    projectId: "demo-af-master",
  }
  : firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
if (useEmulators) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
}
const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });
const root = document.querySelector("#root");
const introOverlay = document.querySelector("#intro-overlay");
const introVideo = document.querySelector("#intro-video");
const introStartButton = document.querySelector("#intro-start");
const introMessage = document.querySelector("#intro-message");
const grades = ["الأول الثانوي", "الثاني الثانوي", "الثالث الثانوي"];
const tracks = ["عربي", "لغات"];
const courseTrackOptions = ["عربي", "لغات", "كلاهما"];
const state = {
  user: null,
  profile: null,
  admin: false,
  device: null,
  deviceError: "",
  adminDeviceCount: 0,
  studentLoginCode: null,
  authReady: false,
  introVisible: true,
  busy: false,
  error: "",
  notice: "",
  nav: "home",
  courses: [],
  catalogCount: 0,
  studentCount: 0,
  chapters: [],
  lessons: [],
  selectedCourse: null,
  selectedChapterId: "",
  selectedLesson: null,
  chatMessages: [],
  supportRooms: [],
  supportRoom: null,
  supportPreviews: {},
  supportDraftOpen: false,
  announcements: [],
  warnings: [],
  students: [],
  deviceCounts: {},
  supportTarget: "",
  search: "",
  referralCode: new URLSearchParams(location.search).get("ref") || "",
  whatsappShareDraft: null,
  installPrompt: null,
  installed: false,
  modal: "",
  editingCourseId: null,
  editingChapterId: null,
  editingLessonId: null,
  chatText: "",
};

const unsubscribers = new Map();
let sharedDataSubscriptionKey = null;
let announcementExpiryTimer = null;
let chatExpiryTimer = null;
let supportReplyTimer = null;
const supportHistoryUpdates = new Set();
const supportHistoryRooms = new Set();
const supportPreviewLoads = new Set();

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

function createNumericLoginCode() {
  const digits = [];
  while (digits.length < 24) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    for (const byte of bytes) {
      if (byte >= 250) continue;
      digits.push(String(byte % 10));
      if (digits.length === 24) break;
    }
  }
  return digits.join("");
}

function loginEmailForCode(code) {
  return `${code}@${app.options.projectId}.firebaseapp.com`;
}

function linkedLoginCode(user) {
  const provider = user?.providerData?.find((item) => item.providerId === "password");
  const email = provider?.email || "";
  const suffix = `@${app.options.projectId}.firebaseapp.com`;
  const code = email.endsWith(suffix) ? email.slice(0, -suffix.length) : "";
  return /^\d{24}$/.test(code) ? code : null;
}

async function linkNumericLoginCode(user, code) {
  if (linkedLoginCode(user) === code) return user;
  if (user.providerData.some((item) => item.providerId === "password")) {
    throw new Error("هذا الحساب مرتبط بالفعل بطريقة دخول أخرى بكلمة مرور، ولا يمكن استبدالها تلقائياً.");
  }
  const credential = EmailAuthProvider.credential(loginEmailForCode(code), code);
  const result = await linkWithCredential(user, credential);
  return result.user;
}

async function saveNumericLoginCode(uid, code) {
  if (!/^\d{24}$/.test(code)) throw new Error("كود الدخول غير صالح.");
  const codeRef = doc(db, "profiles", uid, "privateAuth", "login");
  const existing = await getDoc(codeRef);
  if (existing.exists() && existing.data().loginCode !== code) {
    throw new Error("يوجد كود دخول مختلف محفوظ لهذا الحساب.");
  }
  if (existing.exists()) return;
  const batch = writeBatch(db);
  batch.set(codeRef, {
    loginCode: code,
    createdAt: serverTimestamp(),
  });
  batch.set(doc(db, "loginCodes", code), {
    uid,
    createdAt: serverTimestamp(),
  });
  await batch.commit();
}

function normalizeWhatsAppNumber(value) {
  let number = latinDigits(value).replace(/\D/g, "");
  if (number.startsWith("00")) number = number.slice(2);
  if (/^01\d{9}$/.test(number)) number = `20${number.slice(1)}`;
  else if (/^1\d{9}$/.test(number)) number = `20${number}`;
  if (!/^\d{8,15}$/.test(number)) {
    throw new Error("أدخل رقم واتساب صحيحاً مع مفتاح الدولة.");
  }
  return number;
}

async function hashWhatsAppNumber(number) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(number));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function messageFromError(error) {
  const code = error?.code || "";
  const message = error?.message || "";
  if (code === "auth/too-many-requests") return "محاولات كثيرة. انتظر قليلاً ثم حاول مرة أخرى.";
  if (code === "auth/operation-not-allowed") {
    return "فعّل مزوّد Email/Password في إعدادات Firebase Authentication لتفعيل الدخول بالكود.";
  }
  if (code === "auth/requires-recent-login") return "سجّل الدخول إلى Google مجدداً ثم أعد تفعيل كود الدخول.";
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

function loginCodeSetupError(error) {
  if (error?.code === "auth/operation-not-allowed") {
    return "فعّل مزوّد Email/Password في إعدادات Firebase Authentication لتفعيل الدخول بالكود.";
  }
  if (error?.code === "permission-denied" || error?.code === "firestore/permission-denied") {
    return "تعذر حفظ كود الدخول. انشر قواعد Firestore المحدّثة ثم أعد المحاولة.";
  }
  return messageFromError(error);
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
  return Math.max(10 - Number(state.profile?.whatsappShareCount || 0), 0);
}

function normalizeCourseFilterValues(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === "string") {
    return value.split(/[،,]/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function courseFilterLabel(value) {
  const values = normalizeCourseFilterValues(value);
  if (!values.length) return "الكل";
  if (values.length === 1) return values[0];
  return values.join(" / ");
}

function courseMatchesProfile(course) {
  const currentProfile = state.profile;
  if (!currentProfile) return true;
  const allowedGrades = normalizeCourseFilterValues(course?.grade);
  const allowedTracks = normalizeCourseFilterValues(course?.track);
  const gradeMatch = !allowedGrades.length || allowedGrades.includes(currentProfile.grade);
  const trackMatch = !allowedTracks.length || allowedTracks.includes(currentProfile.track) || allowedTracks.includes("كلاهما");
  return gradeMatch && trackMatch;
}

function courseAudienceKeys(course) {
  const allowedGrades = normalizeCourseFilterValues(course.grade);
  const allowedTracks = normalizeCourseFilterValues(course.track);
  const expandedTracks = allowedTracks.includes("كلاهما") ? tracks : allowedTracks;
  return allowedGrades.flatMap((grade) =>
    expandedTracks.map((track) => `${grade}|${track}`));
}

function currentAudienceKey(profile) {
  return `${profile.grade}|${profile.track}`;
}

const audienceMigrations = new Set();
const migratedAudienceCourses = new Set();
function audienceCourseRef(audienceKey, courseId) {
  return doc(db, "studentCatalog", audienceKey, "courses", courseId);
}

function audienceContentRef(audienceKey, courseId, collectionName, contentId) {
  return doc(db, "studentCatalog", audienceKey, "courses", courseId, collectionName, contentId);
}

async function commitAudienceIndexOperations(operations) {
  for (let offset = 0; offset < operations.length; offset += 450) {
    const batch = writeBatch(db);
    for (const operation of operations.slice(offset, offset + 450)) {
      if (operation.delete) batch.delete(operation.ref);
      else batch.set(operation.ref, operation.data);
    }
    await batch.commit();
  }
}

async function syncAudienceIndex(course, chapters, lessons, previousAudienceKeys = []) {
  const audienceKeys = courseAudienceKeys(course);
  const currentKeys = new Set(audienceKeys);
  const staleKeys = new Set(previousAudienceKeys.filter((key) => !currentKeys.has(key)));
  const operations = [];

  for (const audienceKey of audienceKeys) {
    operations.push({
      ref: audienceCourseRef(audienceKey, course.id),
      data: { ...course, audienceKeys },
    });
  }
  for (const [collectionName, snapshot] of [["chapters", chapters], ["lessons", lessons]]) {
    for (const item of snapshot.docs) {
      const itemData = item.data();
      const itemKeys = Array.isArray(itemData.audienceKeys) && itemData.audienceKeys.length
        ? itemData.audienceKeys
        : previousAudienceKeys;
      itemKeys.forEach((key) => {
        if (!currentKeys.has(key)) staleKeys.add(key);
      });
      for (const audienceKey of audienceKeys) {
        operations.push({
          ref: audienceContentRef(audienceKey, course.id, collectionName, item.id),
          data: { ...itemData, audienceKeys },
        });
      }
      for (const audienceKey of itemKeys) {
        if (!currentKeys.has(audienceKey)) {
          operations.push({
            ref: audienceContentRef(audienceKey, course.id, collectionName, item.id),
            delete: true,
          });
        }
      }
    }
  }
  for (const audienceKey of staleKeys) {
    operations.push({ ref: audienceCourseRef(audienceKey, course.id), delete: true });
  }
  await commitAudienceIndexOperations(operations);
}

async function syncAudienceItems(course, collectionName, documents) {
  const audienceKeys = courseAudienceKeys(course);
  if (!audienceKeys.length) return;
  const currentKeys = new Set(audienceKeys);
  const operations = [];
  for (const item of documents) {
    const itemData = item.data();
    const previousKeys = Array.isArray(itemData.audienceKeys) ? itemData.audienceKeys : [];
    for (const audienceKey of audienceKeys) {
      operations.push({
        ref: audienceContentRef(audienceKey, course.id, collectionName, item.id),
        data: { ...itemData, audienceKeys },
      });
    }
    for (const audienceKey of previousKeys) {
      if (!currentKeys.has(audienceKey)) {
        operations.push({
          ref: audienceContentRef(audienceKey, course.id, collectionName, item.id),
          delete: true,
        });
      }
    }
  }
  await commitAudienceIndexOperations(operations);
}

async function migrateCourseAudience(course) {
  const audienceKeys = courseAudienceKeys(course);
  const previousCourse = state.courses.find((item) => item.id === course.id);
  const previousAudienceKeys = previousCourse
    ? courseAudienceKeys(previousCourse)
    : Array.isArray(course.audienceKeys) ? course.audienceKeys : audienceKeys;
  const migrationKey = `${course.id}:${JSON.stringify([audienceKeys, course.grade, course.track])}:${course.title}:${course.description || ""}`;
  if (!audienceKeys.length || audienceMigrations.has(migrationKey) || migratedAudienceCourses.has(migrationKey)) return;
  audienceMigrations.add(migrationKey);
  try {
    const updates = [];
    if (JSON.stringify(course.audienceKeys || []) !== JSON.stringify(audienceKeys)) {
      updates.push(updateDoc(doc(db, "courses", course.id), { audienceKeys }));
    }
    const [chapters, lessons] = await Promise.all([
      getDocs(query(collection(db, "chapters"), where("courseId", "==", course.id))),
      getDocs(query(collection(db, "lessons"), where("courseId", "==", course.id))),
    ]);
    for (const snapshot of [chapters, lessons]) {
      for (let offset = 0; offset < snapshot.docs.length; offset += 450) {
        const batch = writeBatch(db);
        let changed = false;
        for (const item of snapshot.docs.slice(offset, offset + 450)) {
          if (JSON.stringify(item.data().audienceKeys || []) === JSON.stringify(audienceKeys)) continue;
          batch.update(item.ref, { audienceKeys });
          changed = true;
        }
        if (changed) updates.push(batch.commit());
      }
    }
    await Promise.all(updates);
    await syncAudienceIndex(course, chapters, lessons, previousAudienceKeys);
    migratedAudienceCourses.add(migrationKey);
  } catch (error) {
    console.error(`Could not update audience filters for course ${course.id}.`, error);
    fail(error);
  } finally {
    audienceMigrations.delete(migrationKey);
  }
}

function learnCatalogCount() {
  return Number(state.catalogCount || 0);
}

function studentCommunityCount() {
  return Math.max(0, Number(state.studentCount) || 0) * 3;
}

function clearSubscriptions() {
  for (const unsubscribe of unsubscribers.values()) unsubscribe();
  unsubscribers.clear();
  sharedDataSubscriptionKey = null;
  window.clearTimeout(announcementExpiryTimer);
  window.clearTimeout(chatExpiryTimer);
  window.clearTimeout(supportReplyTimer);
  announcementExpiryTimer = null;
  chatExpiryTimer = null;
  supportReplyTimer = null;
}

function listen(key, reference, next, error = fail) {
  unsubscribers.get(key)?.();
  unsubscribers.set(key, onSnapshot(reference, next, error));
}

let publicStatsWrite = "";
let publicStatsSync = Promise.resolve();
function syncPublicStats() {
  const counts = {
    courseCount: Math.max(0, Number(state.catalogCount) || 0),
    studentCount: Math.max(0, Number(state.studentCount) || 0),
  };
  const signature = `${counts.courseCount}:${counts.studentCount}`;
  if (publicStatsWrite === signature) return;
  publicStatsWrite = signature;
  publicStatsSync = publicStatsSync.then(() => setDoc(doc(db, "publicStats", "catalog"), {
    ...counts,
    updatedAt: serverTimestamp(),
  })).catch((error) => {
    if (publicStatsWrite === signature) publicStatsWrite = "";
    console.error("Could not sync public platform statistics.", error);
    fail(error);
  });
}

function listenCatalogCount() {
  listen("catalog-count", doc(db, "publicStats", "catalog"), (snapshot) => {
    state.catalogCount = snapshot.exists()
      ? Math.max(0, Number(snapshot.data().courseCount) || 0)
      : 0;
    state.studentCount = snapshot.exists()
      ? Math.max(0, Number(snapshot.data().studentCount) || 0)
      : 0;
    render();
  });
}

function supportReplyDeadline(room) {
  const repliedAt = room?.adminReplyAt?.toMillis?.();
  return repliedAt ? repliedAt + 24 * 60 * 60 * 1000 : 0;
}

function supportReplyExpired(room) {
  return Boolean(room && room.awaitingAdminReply === false
    && supportReplyDeadline(room) > 0
    && supportReplyDeadline(room) <= Date.now());
}

function scheduleSupportReplyDeadline() {
  window.clearTimeout(supportReplyTimer);
  supportReplyTimer = null;
  const deadline = supportReplyDeadline(state.supportRoom);
  if (state.supportRoom?.awaitingAdminReply === false && deadline > Date.now()) {
    supportReplyTimer = window.setTimeout(() => {
      supportReplyTimer = null;
      render();
    }, deadline - Date.now() + 50);
  }
}

async function preserveSupportHistory(messages) {
  const expiring = messages.filter((message) =>
    message.data().expiresAt != null && !supportHistoryUpdates.has(message.id));
  for (const message of expiring) supportHistoryUpdates.add(message.id);
  try {
    for (let offset = 0; offset < expiring.length; offset += 450) {
      const batch = writeBatch(db);
      for (const message of expiring.slice(offset, offset + 450)) {
        batch.update(message.ref, { expiresAt: null });
      }
      await batch.commit();
    }
  } catch (error) {
    console.error("Could not preserve existing support chat history.", error);
    fail(error);
    return false;
  } finally {
    for (const message of expiring) supportHistoryUpdates.delete(message.id);
  }
  return true;
}

async function preserveSupportRoomHistory(room) {
  if (supportHistoryRooms.has(room.id)) return;
  supportHistoryRooms.add(room.id);
  try {
    const snapshot = await getDocs(collection(db, "chatRooms", room.id, "messages"));
    if (!(await preserveSupportHistory(snapshot.docs))) supportHistoryRooms.delete(room.id);
  } catch (error) {
    supportHistoryRooms.delete(room.id);
    console.error(`Could not preserve support history for ${room.id}.`, error);
    fail(error);
  }
}

async function loadSupportPreview(room) {
  if (room.latestMessage || supportPreviewLoads.has(room.id)) return;
  supportPreviewLoads.add(room.id);
  try {
    const snapshot = await getDocs(query(
      collection(db, "chatRooms", room.id, "messages"),
      orderBy("createdAt", "desc"),
      limit(1),
    ));
    const latest = snapshot.docs[0];
    if (latest) {
      state.supportPreviews = {
        ...state.supportPreviews,
        [room.id]: latest.data(),
      };
      render();
    }
  } catch (error) {
    console.error(`Could not load preview for support room ${room.id}.`, error);
    fail(error);
  } finally {
    supportPreviewLoads.delete(room.id);
  }
}

function listenSupportInbox() {
  if (!state.admin) return;
  listen("support-inbox", query(collection(db, "chatRooms"), orderBy("updatedAt", "desc")), (snapshot) => {
    state.supportRooms = snapshot.docs
      .filter((item) => item.data().roomType === "support")
      .map((item) => ({ id: item.id, ...item.data() }));
    for (const room of state.supportRooms) {
      loadSupportPreview(room);
      preserveSupportRoomHistory(room);
    }
    render();
  });
}

function listenProfile(uid) {
  listen("profile", doc(db, "profiles", uid), (snapshot) => {
    state.profile = snapshot.exists() ? snapshot.data() : null;
    if (state.profile && state.device?.status === "active") {
      if (state.profile.isActive) {
        if (!unsubscribers.has("warnings")) listenWarnings(uid);
        if (!unsubscribers.has("student-login-code")) listenStudentLoginCode(uid);
      } else {
        state.warnings = [];
        state.chatMessages = [];
        state.supportRooms = [];
        state.supportRoom = null;
        state.supportPreviews = {};
        state.supportDraftOpen = false;
        state.studentLoginCode = null;
        unsubscribers.get("warnings")?.();
        unsubscribers.delete("warnings");
        unsubscribers.get("student-login-code")?.();
        unsubscribers.delete("student-login-code");
        for (const key of ["chat0", "chat1"]) {
          unsubscribers.get(key)?.();
          unsubscribers.delete(key);
        }
        for (const key of ["support-room", "support-inbox"]) {
          unsubscribers.get(key)?.();
          unsubscribers.delete(key);
        }
        state.supportRoom = null;
        state.supportRooms = [];
        window.clearTimeout(chatExpiryTimer);
        chatExpiryTimer = null;
        window.clearTimeout(supportReplyTimer);
        supportReplyTimer = null;
      }
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

function listenStudentLoginCode(uid) {
  listen("student-login-code", doc(db, "profiles", uid, "privateAuth", "login"), (snapshot) => {
    const storedCode = snapshot.exists() ? snapshot.data().loginCode : null;
    const authCode = linkedLoginCode(state.user);
    state.studentLoginCode = storedCode || authCode;
    render();
    if (!storedCode && authCode) {
      saveNumericLoginCode(uid, authCode).catch(fail);
    }
  });
}

function listenAnnouncements() {
  const announcementsQuery = state.admin
    ? query(collection(db, "announcements"), orderBy("createdAt", "desc"))
    : query(
      collection(db, "announcements"),
      where("hidden", "==", false),
      orderBy("createdAt", "desc"),
    );
  listen("announcements", announcementsQuery, (snapshot) => {
    state.announcements = snapshot.docs
        .filter((item) => state.admin || item.data().hidden !== true)
      .map((item) => ({ id: item.id, ...item.data() }));
    if (state.nav === "updates" && !state.admin) markAnnouncementsSeen();
    render();
  });
}

function listenSharedData() {
  const subscriptionKey = state.admin
    ? `admin:${state.user?.uid || ""}`
    : `student:${state.user?.uid || ""}:${state.profile?.grade || ""}:${state.profile?.track || ""}:${state.profile?.isActive || false}:${state.profile?.whatsappShareCount || 0}`;
  if (sharedDataSubscriptionKey === subscriptionKey) return;
  sharedDataSubscriptionKey = subscriptionKey;
  if (!state.admin && (!state.profile || !state.profile.isActive)) {
    state.courses = [];
    state.catalogCount = 0;
    state.studentCount = 0;
    state.announcements = [];
    window.clearTimeout(announcementExpiryTimer);
    announcementExpiryTimer = null;
    for (const key of [...unsubscribers.keys()]) {
      if (key === "announcements" || key === "courses" || key === "courses-student" || key === "catalog-count") {
        unsubscribers.get(key)?.();
        unsubscribers.delete(key);
      }
    }
    return;
  }
  listenCatalogCount();
  const canReadCourses = state.admin || Number(state.profile.whatsappShareCount || 0) >= 10;
  for (const key of [...unsubscribers.keys()]) {
    if (key === "courses" || key === "courses-student") {
      unsubscribers.get(key)?.();
      unsubscribers.delete(key);
    }
  }
  if (!canReadCourses) {
    state.courses = [];
  } else {
    const updateCourses = (records) => {
      const sortedRecords = records.slice().sort((a, b) =>
        (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
      state.courses = state.admin ? sortedRecords : sortedRecords.filter((course) => courseMatchesProfile(course));
      if (state.admin) {
        state.catalogCount = records.length;
        syncPublicStats();
      }
      if (state.selectedCourse) {
        state.selectedCourse = state.courses.find((course) => course.id === state.selectedCourse.id) || null;
        if (!state.selectedCourse) {
          state.selectedChapterId = "";
          state.selectedLesson = null;
          listenLessons(null);
        }
      }
      render();
    };
    if (state.admin) {
      listen("courses", query(collection(db, "courses")), (snapshot) => {
        const records = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
        records.forEach((course) => migrateCourseAudience(course));
        updateCourses(records);
      });
    } else {
      listen("courses-student", query(
        collection(db, "courses"),
        where("audienceKeys", "array-contains", currentAudienceKey(state.profile)),
      ), (snapshot) => {
        updateCourses(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })));
      });
    }
  }
  listenAnnouncements();

  if (state.admin) {
    listen("students", query(collection(db, "profiles")), (snapshot) => {
      state.students = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
        .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
      state.studentCount = state.students.length;
      syncPublicStats();
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
    state.chapters = [];
    state.lessons = [];
    for (const key of ["chapters", "lessons"]) {
      unsubscribers.get(key)?.();
      unsubscribers.delete(key);
    }
    return;
  }
  state.chapters = [];
  state.lessons = [];
  const audienceKey = !state.admin && state.profile ? currentAudienceKey(state.profile) : "";
  const chapterCollection = collection(db, "chapters");
  const lessonCollection = collection(db, "lessons");
  const chapterQuery = state.admin
    ? query(chapterCollection, where("courseId", "==", course.id))
    : query(
      chapterCollection,
      where("courseId", "==", course.id),
      where("audienceKeys", "array-contains", audienceKey),
    );
  const lessonQuery = state.admin
    ? query(lessonCollection, where("courseId", "==", course.id))
    : query(
      lessonCollection,
      where("courseId", "==", course.id),
      where("audienceKeys", "array-contains", audienceKey),
    );
  listen("chapters", chapterQuery, (snapshot) => {
    state.chapters = snapshot.docs
      .map((item) => ({ id: item.id, ...item.data() }))
      .sort((a, b) => Number(a.number) - Number(b.number)
        || Number(a.type === "exam") - Number(b.type === "exam"));
    if (state.admin) {
      syncAudienceItems(course, "chapters", snapshot.docs).catch(fail);
      migrateCourseAudience(course);
    }
    sortCourseLessons();
    render();
  });
  listen("lessons", lessonQuery, (snapshot) => {
    state.lessons = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
    if (state.admin) {
      syncAudienceItems(course, "lessons", snapshot.docs).catch(fail);
      migrateCourseAudience(course);
    }
    sortCourseLessons();
    render();
  });
}

function sortCourseLessons() {
  const chapterRank = (lesson) => {
    const linkedIndex = state.chapters.findIndex((chapter) => chapter.id === lesson.chapterId);
    if (linkedIndex >= 0) return linkedIndex;
    const number = Number(lesson.chapterNumber || 0);
    const type = lesson.type === "exam" ? "exam" : "chapter";
    const matchingIndex = state.chapters.findIndex((chapter) =>
      Number(chapter.number) === number && chapter.type === type);
    if (matchingIndex >= 0) return matchingIndex;
    const chapterIndex = state.chapters.findIndex((chapter) =>
      Number(chapter.number) === number && chapter.type === "chapter");
    return chapterIndex >= 0 ? chapterIndex : state.chapters.length + number;
  };
  state.lessons.sort((a, b) => {
    const rankA = chapterRank(a);
    const rankB = chapterRank(b);
    if (rankA !== rankB) return rankA - rankB;
    const orderA = Number(a.sortOrder ?? a.createdAt?.toMillis?.() ?? 0);
    const orderB = Number(b.sortOrder ?? b.createdAt?.toMillis?.() ?? 0);
    if (orderA !== orderB) return orderA - orderB;
    const createdA = a.createdAt?.toMillis?.() || 0;
    const createdB = b.createdAt?.toMillis?.() || 0;
    return createdA - createdB;
  });
}

function listenChat(preserveMessages = false) {
  if (!state.user || (!state.admin && !state.profile?.isActive)) return;
  if (state.nav !== "chat" && state.nav !== "support") return;
  if (state.nav !== "support") {
    unsubscribers.get("support-inbox")?.();
    unsubscribers.delete("support-inbox");
  }
  for (const key of ["chat0", "chat1", "support-room"]) {
    unsubscribers.get(key)?.();
    unsubscribers.delete(key);
  }
  window.clearTimeout(chatExpiryTimer);
  chatExpiryTimer = null;
  window.clearTimeout(supportReplyTimer);
  supportReplyTimer = null;
  if (!preserveMessages) state.chatMessages = [];
  state.supportRoom = null;
  state.supportDraftOpen = false;
  const roomId = state.nav === "chat"
    ? "students"
    : `support_${state.admin ? state.supportTarget : state.user.uid}`;
  if (state.nav === "support" && state.admin && !state.supportTarget) {
    state.chatMessages = [];
    listenSupportInbox();
    return;
  }
  unsubscribers.get("support-inbox")?.();
  unsubscribers.delete("support-inbox");
  if (state.nav === "support") {
    listen("support-room", doc(db, "chatRooms", roomId), (snapshot) => {
      state.supportRoom = snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null;
      if (!state.admin && state.supportRoom?.awaitingAdminReply === false && !state.supportRoom.adminReplyAt) {
        const lastAdminMessage = [...state.chatMessages].reverse()
          .find((message) => message.kind === "admin");
        if (lastAdminMessage?.createdAt) {
          state.supportRoom = { ...state.supportRoom, adminReplyAt: lastAdminMessage.createdAt };
        }
      }
      scheduleSupportReplyDeadline();
      render();
    });
  }
  const messages = collection(db, "chatRooms", roomId, "messages");
  const updateMessages = (documents) => {
    const previousStream = root.querySelector(".chat-stream");
    const previousTop = previousStream?.scrollTop || 0;
    const wasNearBottom = !previousStream
      || previousStream.scrollHeight - previousTop - previousStream.clientHeight < 100;
    const streamTop = previousStream?.getBoundingClientRect().top || 0;
    const visibleAnchors = previousStream
      ? [...previousStream.querySelectorAll("[data-chat-message]")]
        .map((element) => ({
          id: element.dataset.chatMessage,
          offset: element.getBoundingClientRect().top - streamTop,
          bottom: element.getBoundingClientRect().bottom,
        }))
        .filter((anchor) => anchor.bottom > streamTop)
      : [];
    state.chatMessages = documents.map((item) => ({ id: item.id, ...item.data() }))
      .sort((a, b) => (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0));
    if (state.nav === "support" && !state.admin
      && state.supportRoom?.awaitingAdminReply === false
      && !state.supportRoom.adminReplyAt) {
      const lastAdminMessage = [...state.chatMessages].reverse()
        .find((message) => message.kind === "admin");
      if (lastAdminMessage?.createdAt) {
        state.supportRoom = { ...state.supportRoom, adminReplyAt: lastAdminMessage.createdAt };
        scheduleSupportReplyDeadline();
      }
    }
    render();
    if (wasNearBottom) {
      const currentStream = root.querySelector(".chat-stream");
      if (currentStream) currentStream.scrollTop = currentStream.scrollHeight;
    } else {
      const currentStream = root.querySelector(".chat-stream");
      if (!currentStream) return;
      const currentTop = currentStream.getBoundingClientRect().top;
      const currentMessages = [...currentStream.querySelectorAll("[data-chat-message]")];
      const anchor = visibleAnchors.find((item) =>
        currentMessages.some((element) => element.dataset.chatMessage === item.id));
      const currentAnchor = anchor && currentMessages.find((element) =>
        element.dataset.chatMessage === anchor.id);
      if (currentAnchor) {
        currentStream.scrollTop += currentAnchor.getBoundingClientRect().top - currentTop - anchor.offset;
      } else {
        currentStream.scrollTop = previousTop;
      }
    }
  };
  if (state.nav === "support") {
    listen("chat0", query(messages, orderBy("createdAt", "asc")), (snapshot) => {
      updateMessages(snapshot.docs);
      preserveSupportHistory(snapshot.docs);
    });
    return;
  }
  const activeMessagesQuery = query(
    messages,
    where("expiresAt", ">", Timestamp.fromDate(new Date(Date.now() + 1000))),
    orderBy("expiresAt", "asc"),
    orderBy("createdAt", "asc"),
  );
  listen("chat0", activeMessagesQuery, (snapshot) => {
    updateMessages(snapshot.docs);
    window.clearTimeout(chatExpiryTimer);
    const nextExpiry = state.chatMessages
      .map((message) => message.expiresAt?.toMillis?.() || 0)
      .filter((timestamp) => timestamp > Date.now())
      .sort((a, b) => a - b)[0];
    if (nextExpiry) {
      chatExpiryTimer = window.setTimeout(() => {
        chatExpiryTimer = null;
        if (state.nav === "chat") listenChat(true);
      }, Math.max(0, nextExpiry - Date.now() + 50));
    }
  });
}

async function writeChatMessage(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 2000) throw new Error("اكتب رسالة صالحة.");

  const support = state.nav === "support";
  const isAdminSender = state.admin;
  const recipientUid = support
    ? (isAdminSender ? state.supportTarget : state.user.uid)
    : "";
  if (support && isAdminSender && !recipientUid) {
    throw new Error("حدد حساب الطالب أولاً.");
  }

  const roomId = support ? `support_${recipientUid}` : "students";
  const messagesRef = collection(db, "chatRooms", roomId, "messages");
  const messageRef = doc(messagesRef);
  const expiresAt = Timestamp.fromDate(new Date(Date.now() + 24 * 60 * 60 * 1000));
  const message = {
    senderId: state.user.uid,
    senderName: isAdminSender ? "مشرف AF MASTER" : state.profile.fullName,
    text,
    kind: isAdminSender ? "admin" : "student",
    createdAt: serverTimestamp(),
    expiresAt: support ? null : expiresAt,
  };

  if (support && !isAdminSender) {
    const roomRef = doc(db, "chatRooms", roomId);
    const systemMessageRef = doc(messagesRef);
    await runTransaction(db, async (transaction) => {
      const roomSnapshot = await transaction.get(roomRef);
      const startNewTurn = !roomSnapshot.exists()
        || roomSnapshot.data().awaitingAdminReply !== true;
      transaction.set(roomRef, {
        roomType: "support",
        studentUid: state.user.uid,
        updatedAt: serverTimestamp(),
        awaitingAdminReply: true,
        adminReplyAt: null,
        latestMessage: text,
        latestMessageAt: serverTimestamp(),
        latestSenderId: state.user.uid,
        latestSenderName: state.profile.fullName,
        lastMessageId: messageRef.id,
      }, { merge: true });
      transaction.set(messageRef, message);
      if (startNewTurn) {
        transaction.set(systemMessageRef, {
          senderId: "system",
          senderName: "AF MASTER",
          text: "تم استلام رسالتك، وسيتم الرد عليك خلال 24 ساعة.",
          kind: "system",
          createdAt: serverTimestamp(),
          expiresAt: null,
        });
      }
    });
    state.supportDraftOpen = false;
    return;
  }

  if (support && isAdminSender) {
    const roomRef = doc(db, "chatRooms", roomId);
    await runTransaction(db, async (transaction) => {
      const roomSnapshot = await transaction.get(roomRef);
      if (!roomSnapshot.exists()) throw new Error("لم يبدأ الطالب هذه المحادثة بعد.");
      transaction.set(roomRef, {
        roomType: "support",
        studentUid: recipientUid,
        updatedAt: serverTimestamp(),
        awaitingAdminReply: false,
        adminReplyAt: serverTimestamp(),
        latestMessage: text,
        latestMessageAt: serverTimestamp(),
        latestSenderId: state.user.uid,
        latestSenderName: "مشرف AF MASTER",
        lastMessageId: messageRef.id,
      }, { merge: true });
      transaction.set(messageRef, message);
    });
    return;
  }

  await addDoc(messagesRef, message);
}

function startStudentSession(user, profile) {
  state.user = user;
  state.admin = false;
  state.profile = profile;
  state.device = { status: "active" };
  state.deviceError = "";
  maybeShowShareReturnConfirmation();
  listenProfile(user.uid);
  listenSharedData();
}

onAuthStateChanged(auth, async (user) => {
  clearSubscriptions();
  state.user = user;
  state.profile = null;
  state.studentLoginCode = null;
  state.device = null;
  state.deviceError = "";
  state.admin = false;
  state.courses = [];
  state.chapters = [];
  state.lessons = [];
  state.selectedCourse = null;
  state.selectedChapterId = "";
  state.selectedLesson = null;
  state.chatMessages = [];
  state.supportRooms = [];
  state.supportRoom = null;
  state.supportPreviews = {};
  state.supportDraftOpen = false;
  if (!user) {
    state.authReady = true;
    render();
    return;
  }
  if (state.modal === "code-login") state.modal = "";
  state.authReady = false;
  render();
  try {
    const token = await user.getIdTokenResult();
    const isAdminAccount = adminUids.includes(user.uid);
    if (isAdminAccount && token.signInProvider !== "google.com") {
      await signOut(auth);
      state.error = "انتهت جلسة المشرف القديمة. سجّل الدخول مجدداً من زر Google.";
      return;
    }
    state.admin = isAdminAccount && token.signInProvider === "google.com";
    if (!state.admin) {
      const profile = await getDoc(doc(db, "profiles", user.uid));
      if (profile.exists()) startStudentSession(user, profile.data());
    }
    if (state.admin) {
      state.device = { status: "active" };
      listenSharedData();
    }
  } catch (error) {
    state.deviceError = messageFromError(error);
  } finally {
    state.authReady = true;
    render();
  }
});

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
        ${state.error && state.modal !== "code-login" ? `<div class="inline-error">${h(state.error)}</div>` : ""}
        <button class="google-button" data-action="google-login" ${state.busy ? "disabled" : ""}>
          <span class="google-g">G</span><span>${state.busy ? "جارٍ تسجيل الدخول..." : "المتابعة باستخدام Google"}</span><span>←</span>
        </button>
        <button class="button button-outline button-wide" data-action="code-login">دخول الطالب بالكود الرقمي</button>
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
    <p class="registration-foot">♢ رقم هاتفك واسمك يُستخدمان لمنع تكرار الحسابات. سيُنشأ لك كود دخول رقمي طويل احتفظ به بسرية.</p>
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
    root.innerHTML = `${loginView()}${modalView()}`;
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
  return `<button class="course-card ${color}" data-course="${h(course.id)}"><div class="course-card-top"><span class="course-icon">▤</span><span class="course-arrow">←</span></div><div class="course-card-copy"><span>${h(courseFilterLabel(course.grade))} · ${h(courseFilterLabel(course.track))}</span><h3>${h(course.title)}</h3><p>${h(course.description || "محتوى تعليمي منظم حسب الفصول والدروس.")}</p></div><div class="course-card-bottom"><span>ابدأ التعلّم</span><span class="course-dots">•••</span></div></button>`;
}

function emptyState(icon, title, body, action = "") {
  return `<div class="empty-state"><span class="empty-icon">${icon}</span><h3>${h(title)}</h3><p>${h(body)}</p>${action}</div>`;
}

function progressBlock() {
  const shares = Math.min(Number(state.profile?.whatsappShareCount || 0), 10);
  return `<div class="referral-progress"><div class="progress-label"><span>أرقام واتساب المختلفة</span><b>${shares} <small>/ 10</small></b></div><div class="progress-track"><span style="width:${shares * 10}%"></span></div></div>`;
}

function dashboardView() {
  const firstName = displayName().split(" ")[0];
  const preview = state.courses.slice(0, 2);
  const courseCountValue = state.admin ? (state.courses.length || 0) : learnCatalogCount();
  const studentCrowdValue = studentCommunityCount();
  return `<div class="dashboard-page"><div class="welcome-banner"><div class="welcome-content"><span class="eyebrow"><span class="online-dot"></span> منصتك التعليمية في مكان واحد</span>
    <h1>${state.admin ? "أهلاً بك في لوحة الإشراف" : `أهلاً يا ${h(firstName)}،<br>جاهز لخطوتك الجاية؟`}</h1>
    <p>${state.admin ? "أدر المحتوى وتابع الطلاب من مكان واحد." : "اختار درس النهاردة وخلي هدفك أقرب."}</p>
    ${state.admin ? "" : `<button class="button button-light" data-nav="learning">ابدأ التعلّم ←</button>`}</div>
    <div class="welcome-art" aria-hidden="true"><div class="art-ring ring-a"></div><div class="art-ring ring-b"></div><div class="art-book">▤</div><div class="art-star star-a">✦</div><div class="art-star star-b">✧</div><div class="art-dot"></div></div><div class="banner-grain"></div></div>
    <div class="stat-grid">${statCard("▤", "المنصات المتاحة", String(courseCountValue).padStart(2, "0"), state.admin ? "في مكتبة المحتوى" : "متاحة للطلاب", "cyan")}${statCard("▧", "إعلانات جديدة", String(state.announcements.length).padStart(2, "0"), "من فريق الإشراف", "purple")}${statCard("◌", state.admin ? "أجهزة المشرف النشطة" : "طلابنا", state.admin ? String(state.adminDeviceCount) : String(studentCrowdValue), state.admin ? "بلا حد أقصى" : "3× العدد الحقيقي", "blue")}</div>
    ${state.admin ? "" : `${state.warnings.length ? `<section class="panel warning-panel"><div class="panel-heading"><div><span class="eyebrow">تنبيه من الإشراف</span><h2>ملاحظات على حسابك</h2></div></div>${state.warnings.map((warning) => `<article class="warning-row"><b>${h(warning.body)}</b><small>${h(timestampText(warning.createdAt, true))}</small></article>`).join("")}</section>` : ""}
    <div class="dashboard-columns"><section class="panel learning-panel"><div class="panel-heading"><div><span class="eyebrow">مساحة التعلّم</span><h2>منصاتك الدراسية</h2></div><button class="text-button" data-nav="learning">عرض الكل ←</button></div>
    ${preview.length ? `<div class="course-mini-grid">${preview.map(courseCard).join("")}</div>` : emptyState("▤", "لسه مفيش منصات", "سيظهر محتوى صفك هنا بمجرد إضافته من المشرف.")}</section>
    <section class="panel referral-panel"><div class="referral-top"><div class="referral-icon">♧</div><span class="pill">شارك عبر واتساب</span></div><h2>ساعد أصحابك يعرفوا المنصة</h2><p>أضف 10 أرقام مختلفة. مش مطلوب من أصحابك يسجلوا أو يعملوا حساب.</p>${progressBlock()}<button class="button button-outline button-wide" data-action="share" ${remainingReferrals() ? "" : "disabled"}>${remainingReferrals() ? "أضف رقم صديق" : "اكتمل المطلوب ✓"}</button><small class="referral-hint">يُحتسب كل رقم صحيح مرة واحدة لحسابك. إرسال الرسالة على واتساب متاح لكنه غير مطلوب.</small></section></div>`}
    ${state.announcements.length ? `<section class="panel announcement-preview"><div class="panel-heading"><div><span class="eyebrow">آخر التحديثات</span><h2>رسائل المشرف</h2></div><span class="pill">${state.announcements.length} جديد</span></div><div class="announcement-list">${state.announcements.slice(0, 2).map((announcement) => `<article class="announcement-row"><span class="announcement-symbol">▧</span><div><b>${h(announcement.title)}</b><p>${h(announcement.body)}</p></div><span class="read-check">✓✓</span></article>`).join("")}</div></section>` : ""}
    ${state.installPrompt ? `<div class="install-banner"><span>▣</span><div><b>خلّي AF MASTER أقرب ليك</b><span>ثبّت المنصة على جهازك وافتحها بسهولة.</span></div><button class="button button-light" data-action="install">تثبيت ←</button></div>` : ""}${state.installed ? `<div class="installed-note">✓ تم تثبيت AF MASTER على جهازك.</div>` : ""}
  </div>`;
}

function chapterGroups() {
  const groups = state.chapters.map((chapter) => ({
    ...chapter,
    number: Number(chapter.number || 0),
    title: chapter.title || `الفصل ${chapter.number}`,
    type: chapter.type || "chapter",
    lessons: [],
    isLegacy: false,
  }));
  const chaptersById = new Map(groups.map((chapter) => [chapter.id, chapter]));
  const legacyGroups = new Map();
  for (const lesson of state.lessons) {
    const number = Number(lesson.chapterNumber || 0);
    const legacyType = lesson.type === "exam" ? "exam" : "chapter";
    const linkedChapter = chaptersById.get(lesson.chapterId)
      || groups.find((chapter) => chapter.number === number && chapter.type === legacyType)
      || groups.find((chapter) => chapter.number === number && chapter.type === "chapter");
    if (linkedChapter) {
      linkedChapter.lessons.push(lesson);
      continue;
    }
    const key = String(number);
    if (!legacyGroups.has(key)) {
      legacyGroups.set(key, {
        id: `legacy:${key}`,
        number,
        title: lesson.chapterTitle || `الفصل ${number}`,
        type: "chapter",
        lessons: [],
        isLegacy: true,
      });
    }
    legacyGroups.get(key).lessons.push(lesson);
  }
  return [...groups, ...legacyGroups.values()]
    .sort((a, b) => a.number - b.number || a.title.localeCompare(b.title));
}

function learningView() {
  if (!state.admin && Number(state.profile?.whatsappShareCount || 0) < 10) {
    return `<div class="learning-page"><div class="page-title-row"><div><span class="eyebrow">مكتبتك التعليمية</span><h1>افتح منصات التعلّم</h1><p>أضف أرقام واتساب مختلفة لفتح المنصات.</p></div></div>
      <section class="unlock-card"><div class="unlock-art">♧</div><span class="eyebrow">مش لازم أصحابك يسجلوا</span><h2>باقي لك ${remainingReferrals()} أرقام مختلفة</h2><p>أضف أرقام واتساب لعشرة أشخاص مختلفين. يُفتح المحتوى فور إضافة الرقم العاشر؛ لا يُشترط أن يرسل أصدقاؤك أي شيء أو ينشئوا حساباً.</p>${progressBlock()}<button class="button button-primary" data-action="share">أضف رقم صديق</button></section></div>`;
  }
  if (state.selectedLesson) return lessonView();
  if (state.selectedCourse) {
    const groups = chapterGroups();
    return `<div class="learning-page"><div class="learning-breadcrumb"><button class="text-button" data-action="back-courses">كل المنصات</button> ← <b>${h(state.selectedCourse.title)}</b></div>
      <div class="page-title-row course-title-row"><div><span class="eyebrow">${h(courseFilterLabel(state.selectedCourse.grade))} · ${h(courseFilterLabel(state.selectedCourse.track))}</span><h1>${h(state.selectedCourse.title)}</h1><p>${h(state.selectedCourse.description || "اختار الفصل أو المحتوى اللي حابب تراجعه.")}</p></div>${state.admin ? `<div class="course-title-actions"><button class="button button-outline" data-action="edit-course">تعديل المنصة</button><button class="button button-outline course-delete-button" data-action="delete-course" ${state.busy ? "disabled" : ""}>حذف المنصة</button><button class="button button-primary" data-action="add-chapter">＋ إضافة فصل</button></div>` : ""}</div>
      ${groups.length ? `<div class="chapter-list">${groups.map((chapter, chapterIndex) => `<section class="chapter-card"><div class="chapter-title"><span class="chapter-index">${chapter.type === "exam" ? "E" : String(chapter.number || chapterIndex + 1).padStart(2, "0")}</span><div><span class="eyebrow">${chapter.type === "exam" ? "امتحانات" : `الفصل ${chapter.number || chapterIndex + 1}`}</span><h2>${h(chapter.title)}</h2></div><span class="chapter-count">${chapter.lessons.length} محتوى</span>${state.admin && !chapter.isLegacy ? `<button class="text-button chapter-edit" data-action="edit-chapter" data-chapter="${h(chapter.id)}">تعديل الفصل</button>` : ""}</div><div class="chapter-lessons">${chapter.lessons.map((lesson, index) => `<div class="lesson-row-wrap"><button class="lesson-row" data-lesson="${h(lesson.id)}"><span class="lesson-index ${lesson.type === "exam" ? "exam-index" : ""}">${lesson.type === "exam" ? "▣" : String(index + 1).padStart(2, "0")}</span><span class="lesson-row-copy"><b>${h(lesson.title)}</b><small>${lesson.type === "exam" ? "امتحان ومراجعة" : `${lesson.entries?.length || 0} سؤال وإجابة`}</small></span><span>←</span></button>${state.admin ? `<div class="lesson-tools"><button class="text-button" data-action="move-lesson-up" data-lesson="${h(lesson.id)}">↑</button><button class="text-button" data-action="move-lesson-down" data-lesson="${h(lesson.id)}">↓</button><button class="text-button danger" data-action="edit-lesson" data-lesson="${h(lesson.id)}">تعديل</button><button class="text-button danger" data-action="delete-lesson" data-lesson="${h(lesson.id)}">حذف</button></div>` : ""}</div>`).join("")}${chapter.lessons.length ? "" : `<p class="chapter-empty">لا توجد دروس في هذا الفصل بعد.</p>`}${state.admin && !chapter.isLegacy ? `<button class="text-button chapter-add-lesson" data-action="add-lesson" data-chapter="${h(chapter.id)}">＋ إضافة درس أو امتحان لهذا الفصل</button>` : ""}</div></section>`).join("")}</div>` : emptyState("▤", "لم تُضف فصولاً بعد", "أنشئ فصول المنصة ثم أضف الدروس والامتحانات داخل كل فصل.", state.admin ? `<button class="button button-primary" data-action="add-chapter">＋ إضافة أول فصل</button>` : "")}</div>`;
  }
  return `<div class="learning-page"><div class="page-title-row"><div><span class="eyebrow">مكتبتك التعليمية</span><h1>اختار منصتك وابدأ</h1><p>محتوى مرتب حسب الصف والمسار الدراسي.</p></div>${state.admin ? `<button class="button button-primary" data-action="add-course">＋ إضافة منصة</button>` : ""}</div>
    ${state.admin ? "" : `<div class="filter-chips"><span class="filter-chip">⌂ ${h(state.profile.grade)}</span><span class="filter-chip">${h(state.profile.track)}</span></div>`}
    ${state.courses.length ? `<div class="course-grid">${state.courses.map(courseCard).join("")}</div>` : emptyState("▤", state.admin ? "أضف أول منصة تعليمية" : "محتوى صفك قادم قريباً", state.admin ? "أنشئ منصة، ثم أضف الفصول والدروس والأسئلة." : "سيظهر المحتوى الذي يضيفه المشرف هنا.", state.admin ? `<button class="button button-primary" data-action="add-course">＋ إضافة منصة</button>` : "")}
  </div>`;
}

function lessonView() {
  const lesson = state.selectedLesson;
  const chapter = state.chapters.find((item) => item.id === lesson.chapterId)
    || state.chapters.find((item) =>
      Number(item.number) === Number(lesson.chapterNumber)
      && (item.type === (lesson.type === "exam" ? "exam" : "chapter") || item.type === "chapter"));
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
  return `<div class="learning-page"><div class="learning-breadcrumb"><button class="text-button" data-action="back-lessons">${h(state.selectedCourse?.title || "")}</button> ← <b>${h(lesson.title)}</b>${state.admin ? `<button class="text-button danger" data-action="edit-lesson" data-lesson="${h(lesson.id)}">تعديل الدرس</button>` : ""}</div>
    <div class="lesson-heading"><div class="lesson-symbol">▤</div><div><span class="eyebrow">${lesson.type === "exam" ? "مراجعة واختبار" : h(chapter?.title || lesson.chapterTitle || `الفصل ${lesson.chapterNumber}`)}</span><h1>${h(lesson.title)}</h1></div><span class="pill">${entries.length} سؤال</span></div>
    ${lesson.type === "exam" ? `<div class="exam-note">✦ قد تظهر الأسئلة بترتيب مختلف في الامتحان. راجع كل إجابة جيداً.</div>` : ""}
    <div class="qa-list">${entries.map((entry, index) => `<article class="qa-card"><div class="qa-number">س${String(index + 1).padStart(2, "0")}</div><div class="qa-body"><h3>${h(entry.question)}</h3><div class="answer-box"><span>الإجابة</span><p>${h(entry.answer)}</p></div></div><button class="copy-button" data-copy="${h(entry.answer)}"><span>▣</span><span>نسخ</span></button></article>`).join("")}</div>
    <div class="lesson-next"><span>✓✓ ${position === state.lessons.length - 1 ? "أنهيت آخر محتوى في هذه المنصة" : "أحسنت! أكملت هذا المحتوى"}</span><button class="button button-primary" data-action="next-lesson">${position === state.lessons.length - 1 ? "إنهاء" : "التالي"} ←</button></div></div>`;
}

function chatView(support) {
  if (support && state.admin && !state.supportTarget) return supportInboxView();
  const title = support ? (state.admin
    ? state.students.find((student) => student.id === state.supportTarget)?.fullName || "محادثة الطالب"
    : "تواصل مع المشرف") : "شات الطلاب";
  const ended = support && !state.admin && supportReplyExpired(state.supportRoom);
  const canSend = !support || (state.admin
    ? Boolean(state.supportRoom)
    : state.supportRoom ? (!ended || state.supportDraftOpen) : state.supportDraftOpen);
  const supportNotice = !support ? "" : !state.supportRoom && !state.admin
    ? `<div class="support-ended"><b>تواصل مع المشرف</b><span>ابدأ دردشة خاصة، وسيصلك الرد هنا مع الاحتفاظ بسجل المحادثة.</span><button class="button button-primary" data-action="start-support-chat">بدء دردشة جديدة</button></div>`
    : !state.supportRoom ? "" : state.admin
    ? `<div class="support-status">${state.supportRoom.awaitingAdminReply ? "الطالب بانتظار ردك." : supportReplyExpired(state.supportRoom) ? "انتهت مهلة الرد؛ سجل المحادثة محفوظ." : "تم إرسال ردك، وبانتظار رد الطالب."}</div>`
    : ended
      ? `<div class="support-ended" role="status"><b>تم إنهاء الدردشات</b><span>مرّت 24 ساعة دون رد. سجل المحادثة السابقة محفوظ ويمكنك بدء دردشة جديدة في أي وقت.</span>${state.supportDraftOpen ? `<small>اكتب رسالتك الجديدة لإعادة فتح التواصل.</small>` : `<button class="button button-primary" data-action="start-support-chat">بدء دردشة جديدة</button>`}</div>`
      : state.supportRoom.awaitingAdminReply
        ? `<div class="support-status">تم استلام رسالتك، وسيتم الرد عليك خلال 24 ساعة.</div>`
        : `<div class="support-status">رد المشرف بانتظارك. يمكنك الرد خلال 24 ساعة للمتابعة.</div>`;
  const backButton = support && state.admin
    ? `<button class="button button-outline" data-action="back-support-inbox">← صندوق الوارد</button>` : "";
  const description = support
    ? (state.admin ? "محادثة خاصة دائمة بينك وبين الطالب." : "محادثتك خاصة ومحفوظة كسجل دائم بينك وبين المشرف.")
    : "تواصل مع زملائك في مساحة واحدة. تُحذف رسائل الشات العام بعد 24 ساعة.";
  return `<section class="chat-page ${support ? "support-chat" : "student-chat"}"><div class="page-title-row"><div><span class="eyebrow">مساحة التواصل</span><h1>${h(title)}</h1><p>${description}</p></div><div class="chat-page-actions">${backButton}<span class="privacy-badge">♢ ${support ? "سجل خاص محفوظ" : "رسائل مؤقتة"}</span></div></div>
    <div class="chat-card"><div class="chat-head"><div class="chat-head-icon">◌</div><div><b>${h(title)}</b><small>${support ? "سجل المحادثة محفوظ للطرفين" : "تُحذف رسائل الشات العام بعد 24 ساعة"}</small></div><span class="online-dot"></span></div>
    ${supportNotice}
    <div class="chat-stream" aria-label="رسائل المحادثة">${state.chatMessages.length ? state.chatMessages.map((message) => {
      const messageClass = message.kind === "system"
        ? "system-message"
        : message.senderId === state.user.uid
          ? "mine chat-message-own"
          : "peer chat-message-other";
      return `<div class="chat-message ${messageClass}" data-chat-message="${h(message.id)}"><div class="message-meta"><b>${h(message.senderName)}</b><small>${h(timestampText(message.createdAt, true))}</small></div><p>${h(message.text)}</p>${state.admin && !support && message.kind !== "system" ? `<button class="message-delete" data-delete-message="${h(message.id)}">×</button>` : ""}</div>`;
    }).join("") : emptyState("◌", "ابدأ المحادثة", "اكتب أول رسالة وابدأ التواصل.")}</div>
    <form class="chat-composer" data-form="chat"><input name="text" value="${h(state.chatText)}" placeholder="${ended && state.supportDraftOpen ? "اكتب رسالتك لبدء دردشة جديدة..." : "اكتب رسالتك هنا..."}" maxlength="2000" ${!canSend ? "disabled" : ""}><button class="send-button" ${state.busy || !canSend ? "disabled" : ""} aria-label="إرسال الرسالة">➤</button></form></div></section>`;
}

function supportInboxView() {
  const studentsById = new Map(state.students.map((student) => [student.id, student]));
  const rooms = state.supportRooms.map((room) => ({
    ...room,
    student: studentsById.get(room.studentUid),
    preview: room.latestMessage
      ? { text: room.latestMessage, senderId: room.latestSenderId, createdAt: room.latestMessageAt }
      : state.supportPreviews[room.id],
  }));
  return `<section class="chat-page support-inbox-page"><div class="page-title-row"><div><span class="eyebrow">صندوق الوارد</span><h1>محادثات الطلاب</h1><p>اختر محادثة للانتقال مباشرة إلى سجل الطالب والرد عليه.</p></div><span class="privacy-badge">♢ ${rooms.length} محادثة</span></div>
    <div class="support-inbox">${rooms.length ? rooms.map((room) => `<button class="support-inbox-row" data-support-target="${h(room.studentUid)}"><span class="support-avatar">${h((room.student?.fullName || room.studentUid).slice(0, 1))}</span><span class="support-inbox-copy"><span class="support-inbox-title"><b>${h(room.student?.fullName || "طالب")}</b><small>${h(room.student?.studentCode || "")}</small></span><span class="support-inbox-preview">${room.preview ? `${room.preview.senderId === state.user.uid ? "أنت: " : ""}${h(room.preview.text || "")}` : "افتح المحادثة لعرض الرسائل السابقة"}</span></span><span class="support-inbox-meta"><small>${h(timestampText(room.preview?.createdAt || room.updatedAt, true))}</small><b class="${room.awaitingAdminReply ? "inbox-waiting" : "inbox-replied"}">${room.awaitingAdminReply ? "بانتظار ردك" : "تم الرد"}</b></span><span class="support-inbox-arrow">←</span></button>`).join("") : emptyState("◌", "لا توجد محادثات بعد", "ستظهر هنا رسائل الطلاب الجديدة تلقائياً.")}</div></section>`;
}

function announcementsView() {
  return `<div class="announcements-page"><div class="page-title-row"><div><span class="eyebrow">من فريق AF MASTER</span><h1>الإعلانات والرسائل</h1><p>آخر الأخبار والتنبيهات المهمة للطلاب.</p></div><span class="privacy-badge">▧ ${state.announcements.length} رسالة</span></div>
    ${state.admin ? `<form class="panel announcement-form" data-form="announcement"><h2>إرسال إعلان جديد</h2><div class="form-row"><input name="title" required placeholder="عنوان الإعلان"><button class="button button-primary">إرسال للجميع →</button></div><textarea name="body" required rows="3" placeholder="اكتب رسالتك للطلاب..."></textarea></form>` : ""}
    ${state.announcements.length ? `<div class="announcement-list full-list">${state.announcements.map((announcement) => `<article class="announcement-card"><span class="announcement-symbol">▧</span><div class="announcement-card-copy"><div class="announcement-meta"><span>${state.admin && announcement.hidden ? "مخفي عن الطلاب" : "رسالة من المشرف"}</span><small>${h(timestampText(announcement.createdAt))}</small></div><h2>${h(announcement.title)}</h2><p>${h(announcement.body)}</p></div>${state.admin ? `<button class="text-button" data-action="toggle-announcement" data-announcement="${h(announcement.id)}">${announcement.hidden ? "إظهار للطلاب" : "إخفاء عن الطلاب"}</button>` : `<span class="announcement-read">✓✓ تمت القراءة</span>`}</article>`).join("")}</div>` : emptyState("▧", "لا توجد رسائل حالياً", "ستظهر هنا إعلانات المشرف الجديدة.")}</div>`;
}

function adminView() {
  const students = state.students
    .filter((student) => `${student.fullName} ${student.phone} ${student.studentCode} ${student.email || ""}`.toLowerCase().includes(state.search.toLowerCase()));
  return `<div class="admin-page"><div class="page-title-row"><div><span class="eyebrow">مركز التحكم</span><h1>إدارة المنصة</h1><p>تابع حسابات الطلاب وأدر محتوى المنصة.</p></div><span class="admin-badge">♢ صلاحيات المشرف</span></div>
    <div class="admin-metrics">${statCard("♧", "حسابات مسجلة", String(state.students.length).padStart(2, "0"), "طلاب على المنصة", "cyan")}${statCard("G", "تسجيل الطلاب", "Google", "حساب مرتبط بالطالب", "purple")}${statCard("▤", "منصات تعليمية", String(state.courses.length).padStart(2, "0"), "في مكتبة المحتوى", "blue")}</div>
    <section class="panel students-panel"><div class="panel-heading"><div><span class="eyebrow">قاعدة الحسابات</span><h2>حسابات الطلاب</h2></div><div class="search-field"><span>⌕</span><input data-change="search" value="${h(state.search)}" placeholder="ابحث بالاسم أو الكود"></div></div>
    <div class="student-table-wrap"><table class="student-table"><thead><tr><th>الطالب والبريد</th><th>كود الدعوة</th><th>الهاتف</th><th>الصف / المسار</th><th>الحالة</th><th>إجراءات</th></tr></thead><tbody>${students.map((student) => `<tr><td><div class="student-name"><span class="avatar tiny">${h(student.fullName?.slice(0, 1))}</span><span class="student-identity"><b>${h(student.fullName)}</b><small>${h(student.email)}</small></span></div></td><td><span class="code">${h(student.studentCode || "—")}</span></td><td dir="ltr">${h(student.phone)}</td><td>${h(student.grade)} · ${h(student.track)}</td><td><span class="status-pill ${student.isActive ? "status-active" : "status-banned"}">${student.isActive ? "نشط" : "محظور"}</span></td><td><div class="table-actions"><button title="تحذير" data-warning="${h(student.id)}">▧</button>${student.isActive ? `<button class="danger-icon" title="حظر" data-ban="${h(student.id)}">♢</button>` : ""}</div></td></tr>`).join("")}</tbody></table>${students.length ? "" : emptyState("♧", "لا توجد حسابات", "ستظهر الحسابات المسجلة هنا.")}</div></section></div>`;
}

function maybeShowShareReturnConfirmation() {
  const params = new URLSearchParams(location.search);
  if (params.get("wa") !== "1" || !state.user || !state.profile?.isActive) return;
  state.modal = "whatsapp-share-added";
  state.notice = "تم إرسال الدعوة عبر واتساب بنجاح. وبمجرد الرجوع للمنصة سيتم تأكيدها تلقائياً.";
  state.whatsappShareDraft = {
    url: `https://wa.me/?text=${encodeURIComponent(`انضم إلى AF MASTER وابدأ التعلم معي! ${location.origin}${location.pathname}?ref=${state.profile?.studentCode || ""}`)}`,
  };
}

function modalView() {
  if (!state.admin && state.profile?.isActive && !state.profile.whatsappChannelJoined) {
    return `<div class="modal-backdrop"><section class="modal-card channel-modal" role="dialog" aria-modal="true" aria-labelledby="channel-modal-title">
      <div class="channel-icon" aria-hidden="true">◉</div>
      <span class="eyebrow">خليك قريب من AF MASTER</span>
      <h2 id="channel-modal-title">اشترك في قناة واتساب</h2>
      <p class="muted">اشترك على القناة عشان يوصلك كل جديد، إحنا مش بنرخم عليك بس عشان تبقى عارف إحنا فين!</p>
      <a class="button channel-button" href="https://whatsapp.com/channel/0029VbE2SzLJkK776ZAkwG23" target="_blank" rel="noopener noreferrer"><span aria-hidden="true">◉</span> افتح قناة AF MASTER على واتساب</a>
      ${state.error ? `<div class="inline-error" role="alert">${h(state.error)}</div>` : ""}
      <button class="button button-primary button-wide" data-action="confirm-channel-subscription" ${state.busy ? "disabled" : ""}>${state.busy ? "جارٍ حفظ التأكيد..." : "اشتركت، متابعة ←"}</button>
      <small class="channel-note">بعد التأكيد لن تظهر لك هذه الخطوة مرة أخرى.</small>
    </section></div>`;
  }
  if (!state.modal) return "";
  if (state.modal === "code-login") {
    return `<div class="modal-backdrop" data-action="backdrop"><section class="modal-card"><div class="modal-heading"><h2>تسجيل الدخول بالكود</h2><button class="icon-button" data-action="close-modal">×</button></div><p class="muted">أدخل كود الدخول الرقمي المكوّن من 24 رقماً.</p><form class="form-grid" data-form="code-login"><label>كود الطالب<input name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9٠-٩۰-۹]{24}" maxlength="24" minlength="24" required dir="ltr" placeholder="••••••••••••••••••••••••"></label>${state.error ? `<div class="inline-error">${h(state.error)}</div>` : ""}<button class="button button-primary" ${state.busy ? "disabled" : ""}>${state.busy ? "جارٍ التحقق..." : "دخول آمن ←"}</button></form></section></div>`;
  }
  if (state.modal === "student-login-code" && state.studentLoginCode) {
    const activeCode = linkedLoginCode(state.user) === state.studentLoginCode;
    return `<div class="modal-backdrop" data-action="backdrop"><section class="modal-card"><div class="modal-heading"><h2>كود دخولك الرقمي</h2><button class="icon-button" data-action="close-modal">×</button></div><p class="muted">${activeCode ? "احتفظ بهذا الكود بسرية؛ يمكن استخدامه وحده للدخول إلى حسابك." : "احفظ الكود، ثم فعّل تسجيل الدخول به. استخدم Google إلى أن يظهر تأكيد التفعيل."}</p><div class="profile-details"><div><span>كود الطالب — 24 رقمًا</span><b class="code" dir="ltr">${h(state.studentLoginCode)}</b></div></div><div class="form-grid"><button type="button" class="button button-outline" data-copy="${h(state.studentLoginCode)}">نسخ الكود</button>${activeCode ? "" : `<button class="button button-primary" data-action="enable-code-login" ${state.busy ? "disabled" : ""}>تفعيل كود الدخول</button>`}</div>${state.error ? `<div class="inline-error">${h(state.error)}</div>` : ""}</section></div>`;
  }
  if (state.modal === "whatsapp-share") {
    return `<div class="modal-backdrop" data-action="backdrop"><section class="modal-card"><div class="modal-heading"><h2>أضف رقم صديق</h2><button class="icon-button" data-action="close-modal">×</button></div><p class="muted">أدخل رقم واتساب بصيغة صحيحة ومختلفاً. يُحتسب الرقم فور إضافته؛ إرسال الرسالة أو تسجيل الصديق غير مطلوب.</p><form class="form-grid" data-form="whatsapp-share"><label>رقم واتساب مع مفتاح الدولة<input name="phone" type="tel" inputmode="tel" autocomplete="tel" required placeholder="+20 10 1234 5678 أو 01012345678"></label><small class="referral-hint">نتحقق من صيغة الرقم وتكراره في حسابك فقط، ولا نستطيع تأكيد أنه رقم فعّال دون تحقق خارجي.</small>${state.error ? `<div class="inline-error">${h(state.error)}</div>` : ""}<button class="button button-primary" ${state.busy ? "disabled" : ""}>${state.busy ? "جارٍ حفظ الرقم..." : "إضافة الرقم ←"}</button></form></section></div>`;
  }
  if (state.modal === "whatsapp-share-added" && state.whatsappShareDraft) {
    const finished = remainingReferrals() === 0;
    return `<div class="modal-backdrop" data-action="backdrop"><section class="modal-card"><div class="modal-heading"><h2>${finished ? "اكتمل العدد المطلوب!" : "تمت إضافة الرقم"}</h2><button class="icon-button" data-action="close-modal">×</button></div><p class="muted">${finished ? "اكتملت الأرقام العشرة، وفتحت لك منصات التعلّم." : `تم تسجيل رقم مختلف. باقي ${remainingReferrals()} أرقام.`} ${finished ? "" : "لا يلزم أن يسجل أصحابك في المنصة."}</p><div class="form-grid"><a class="button button-outline button-wide" href="${h(state.whatsappShareDraft.url)}" target="_blank" rel="noopener noreferrer">إرسال الدعوة عبر واتساب (اختياري)</a><button class="button button-primary button-wide" data-action="change-whatsapp-number" ${finished ? "disabled" : ""}>${finished ? "تم — ابدأ التعلّم" : "إضافة رقم آخر"}</button></div></section></div>`;
  }
  if (state.modal === "profile") {
    const loginCode = state.studentLoginCode || linkedLoginCode(state.user);
    const codeEnabled = Boolean(loginCode && linkedLoginCode(state.user) === loginCode);
    return `<div class="modal-backdrop" data-action="backdrop"><section class="modal-card"><div class="modal-heading"><h2>إعدادات الحساب</h2><button class="icon-button" data-action="close-modal">×</button></div>
      ${state.admin ? `<div class="profile-details"><div><span>الحساب</span><b>${h(state.user.email || "دخول آمن للمشرف")}</b></div><div><span>الدور</span><b>مشرف AF MASTER</b></div><button class="button button-outline" data-action="logout">تسجيل الخروج</button></div>` : `<form class="form-grid" data-form="school-info"><p class="muted">كود الدعوة: <b class="code">${h(state.profile.studentCode || "—")}</b></p><div class="profile-details"><div><span>كود الدخول الرقمي (سري)</span><b class="code" dir="ltr">${h(loginCode || "غير مفعّل")}</b></div><small>لا تشارك كود الدخول مع أي شخص.</small><button type="button" class="button button-outline" data-action="enable-code-login" ${state.busy || codeEnabled ? "disabled" : ""}>${codeEnabled ? "كود الدخول مفعّل ✓" : loginCode ? "تفعيل كود الدخول" : "إنشاء كود دخول رقمي"}</button>${loginCode ? `<button type="button" class="text-button" data-copy="${h(loginCode)}">نسخ كود الدخول</button>` : ""}</div><label>الصف الدراسي<select name="grade">${gradeOptions(state.profile.grade)}</select></label><label>المسار<select name="track">${trackOptions(state.profile.track)}</select></label><button class="button button-primary">حفظ التعديلات</button></form>`}</section></div>`;
  }
  if (state.modal === "course") {
    const course = state.courses.find((item) => item.id === state.editingCourseId) || state.selectedCourse;
    const editing = Boolean(state.editingCourseId && course);
    const selectedGrades = normalizeCourseFilterValues(editing ? course.grade : grades);
    const selectedTracks = normalizeCourseFilterValues(editing ? course.track : [tracks[0]]);
    return `<div class="modal-backdrop" data-action="backdrop"><section class="modal-card"><div class="modal-heading"><h2>${editing ? "تعديل المنصة" : "إضافة منصة جديدة"}</h2><button class="icon-button" data-action="close-modal">×</button></div><form class="form-grid" data-form="course"><label>اسم المنصة<input name="title" required value="${editing ? h(course.title) : ""}" placeholder="مثال: منصة الرياضيات"></label><label>وصف مختصر<input name="description" value="${editing ? h(course.description || "") : ""}" placeholder="محتوى المنصة"></label><div class="multi-check-list"><label>الصفوف المتاحة</label><div class="check-grid">${grades.map((grade) => `<label class="check-item"><input type="checkbox" name="grade" value="${h(grade)}" ${selectedGrades.includes(grade) ? "checked" : ""}> <span>${h(grade)}</span></label>`).join("")}</div></div><div class="multi-check-list"><label>المسارات المتاحة</label><div class="check-grid">${courseTrackOptions.map((track) => `<label class="check-item"><input type="checkbox" name="track" value="${h(track)}" ${selectedTracks.includes(track) ? "checked" : ""}> <span>${h(track)}</span></label>`).join("")}</div></div><button class="button button-primary">${editing ? "حفظ التعديلات" : "＋ إضافة المنصة"}</button></form></section></div>`;
  }
  if (state.modal === "chapter") {
    const chapter = state.chapters.find((item) => item.id === state.editingChapterId);
    const editing = Boolean(chapter);
    const nextNumber = Math.max(0, ...state.chapters.map((item) => Number(item.number) || 0)) + 1;
    return `<div class="modal-backdrop" data-action="backdrop"><section class="modal-card"><div class="modal-heading"><h2>${editing ? "تعديل الفصل" : "إضافة فصل للمنصة"}</h2><button class="icon-button" data-action="close-modal">×</button></div><p class="muted">${h(state.selectedCourse?.title || "")}</p><form class="form-grid" data-form="chapter"><div class="form-row"><label>الترتيب<input name="number" type="number" min="1" value="${editing ? h(chapter.number) : nextNumber}" required></label><label>نوع الفصل<select name="type"><option value="chapter" ${editing && chapter.type === "exam" ? "" : "selected"}>فصل دراسي</option><option value="exam" ${editing && chapter.type === "exam" ? "selected" : ""}>قسم الامتحانات</option></select></label></div><label>اسم الفصل / القسم<input name="title" required maxlength="100" value="${editing ? h(chapter.title) : ""}" placeholder="${editing && chapter.type === "exam" ? "الامتحانات" : "مثال: Chapter 1 — الحركة"}"></label><button class="button button-primary">${editing ? "حفظ الفصل" : "＋ إضافة الفصل"}</button></form></section></div>`;
  }
  if (state.modal === "lesson") {
    const lesson = state.lessons.find((item) => item.id === state.editingLessonId) || null;
    const selectedChapter = state.chapters.find((item) => item.id === state.selectedChapterId) || state.chapters[0];
    const chapterId = lesson?.chapterId || selectedChapter?.id || "";
    const titleValue = lesson?.title || "";
    const typeValue = lesson?.type || "lesson";
    const entries = lesson?.entries || [];
    const inputCount = Math.max(3, entries.length || 3);
    return `<div class="modal-backdrop" data-action="backdrop"><section class="modal-card"><div class="modal-heading"><h2>${lesson ? "تعديل درس أو امتحان" : "إضافة درس أو امتحان"}</h2><button class="icon-button" data-action="close-modal">×</button></div><p class="muted">${h(state.selectedCourse?.title || "")}</p>${state.chapters.length ? `<form class="form-grid lesson-form" data-form="lesson">
      <label>الفصل<select name="chapterId" required>${state.chapters.map((chapter) => `<option value="${h(chapter.id)}" ${chapterId === chapter.id ? "selected" : ""}>${h(chapter.title)}</option>`).join("")}</select></label>
      <label>اسم الدرس / الامتحان<input name="title" required placeholder="مثال: الدرس الأول" value="${h(titleValue)}"></label><label>نوع المحتوى<select name="type"><option value="lesson" ${typeValue === "lesson" ? "selected" : ""}>درس</option><option value="exam" ${typeValue === "exam" ? "selected" : ""}>امتحان</option></select></label>
      <div class="question-fields">${Array.from({ length: inputCount }, (_, index) => questionFields(index, entries[index]?.question || "", entries[index]?.answer || "")).join("")}</div>
      <button type="button" class="text-button" data-action="add-question">＋ إضافة سؤال</button><button class="button button-primary">${lesson ? "حفظ التعديلات" : "حفظ المحتوى"}</button></form>` : `<div class="empty-state"><p>أنشئ فصلاً أولاً، ثم أضف الدروس والامتحانات بداخله.</p><button class="button button-primary" data-action="add-chapter">＋ إضافة فصل</button></div>`}</section></div>`;
  }
  return "";
}

function questionFields(index, question = "", answer = "") {
  return `<div class="question-entry"><b>سؤال ${index + 1}</b><label>السؤال<textarea name="question-${index}" rows="2" ${index === 0 ? "required" : ""} placeholder="اكتب السؤال...">${h(question)}</textarea></label><label>الإجابة<textarea name="answer-${index}" rows="2" ${index === 0 ? "required" : ""} placeholder="اكتب الإجابة...">${h(answer)}</textarea></label></div>`;
}

function currentFormData(form) {
  const result = {};
  for (const [key, value] of new FormData(form).entries()) {
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      const existing = result[key];
      result[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
      continue;
    }
    result[key] = value;
  }
  Object.keys(result).forEach((key) => {
    if (Array.isArray(result[key]) && result[key].length === 1) result[key] = result[key][0];
  });
  return result;
}

async function handleSubmit(event) {
  const form = event.target.closest("form[data-form]");
  if (!form) return;
  event.preventDefault();
  const data = currentFormData(form);
  state.busy = true;
  state.error = "";
  render();
  try {
    switch (form.dataset.form) {
      case "code-login": {
        const code = latinDigits(data.code).trim();
        if (!/^\d{24}$/.test(code)) throw new Error("أدخل كود الدخول المكوّن من 24 رقماً.");
        const credential = await signInWithEmailAndPassword(auth, loginEmailForCode(code), code);
        await credential.user.getIdToken(true);
        const profileSnapshot = await getDoc(doc(db, "profiles", credential.user.uid));
        if (!profileSnapshot.exists()) {
          throw new Error("تم تسجيل الدخول بالكود، لكن لم نعثر على ملف الطالب المرتبط به. تواصل مع المشرف.");
        }
        state.modal = "";
        state.error = "";
        startStudentSession(credential.user, profileSnapshot.data());
        break;
      }
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
        const loginCode = createNumericLoginCode();
        const profileRef = doc(db, "profiles", state.user.uid);
        const batch = writeBatch(db);
        batch.set(doc(db, "publicStats", "catalog"), {
          studentCount: increment(1),
          updatedAt: serverTimestamp(),
        }, { merge: true });
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
          whatsappShareCount: 0,
          whatsappChannelJoined: false,
          lastWhatsAppShareId: null,
          createdAt: serverTimestamp(),
        });
        batch.set(doc(db, "profiles", state.user.uid, "privateAuth", "login"), {
          loginCode,
          createdAt: serverTimestamp(),
        });
        batch.set(doc(db, "loginCodes", loginCode), {
          uid: state.user.uid,
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
        state.studentLoginCode = loginCode;
        state.modal = "student-login-code";
        try {
          state.user = await linkNumericLoginCode(state.user, loginCode);
          await saveNumericLoginCode(state.user.uid, loginCode);
          notify("تم إنشاء حسابك وتفعيل كود الدخول الرقمي.");
        } catch (error) {
          console.error("Student login-code activation failed after account creation.", error);
          state.error = loginCodeSetupError(error);
        }
        break;
      }
      case "whatsapp-share": {
        const phone = normalizeWhatsAppNumber(data.phone);
        if (state.profile?.phone && normalizeWhatsAppNumber(state.profile.phone) === phone) {
          throw new Error("اكتب رقم شخص آخر، وليس رقمك.");
        }
        const recipientHash = await hashWhatsAppNumber(phone);
        const profileRef = doc(db, "profiles", state.user.uid);
        const shareRef = doc(db, "profiles", state.user.uid, "whatsappShares", recipientHash);
        const [profileSnapshot, existingShare] = await Promise.all([
          getDoc(profileRef),
          getDoc(shareRef),
        ]);
        if (!profileSnapshot.exists()) throw new Error("تعذر العثور على ملف الطالب.");
        if (existingShare.exists()) throw new Error("تمت إضافة هذا الرقم من قبل. أدخل رقماً مختلفاً.");
        const currentCount = Number(profileSnapshot.data().whatsappShareCount || 0);
        if (currentCount >= 10) throw new Error("اكتمل العدد المطلوب بالفعل.");
        const text = `انضم إلى AF MASTER وابدأ التعلم معي! ${location.origin}${location.pathname}?ref=${state.profile?.studentCode || ""}&wa=1`;
        const waUrl = `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
        const batch = writeBatch(db);
        batch.update(profileRef, {
          whatsappShareCount: increment(1),
          lastWhatsAppShareId: recipientHash,
        });
        batch.set(shareRef, {
          recipientHash,
          createdAt: serverTimestamp(),
        });
        await batch.commit();
        const nextCount = currentCount + 1;
        state.profile = {
          ...profileSnapshot.data(),
          whatsappShareCount: nextCount,
          lastWhatsAppShareId: recipientHash,
        };
        state.whatsappShareDraft = { url: waUrl };
        state.modal = "whatsapp-share-added";
        state.error = "";
        listenSharedData();
        const shareWindow = window.open(waUrl, "_blank", "noopener,noreferrer");
        if (!shareWindow) {
          state.notice = "تم حفظ الرقم بنجاح. تستطيع إرسال الدعوة يدوياً عبر الزر في الشاشة التالية.";
        }
        notify(nextCount >= 10
          ? "اكتمل العدد! منصات التعلّم أصبحت متاحة."
          : `تمت إضافة الرقم. باقي ${10 - nextCount} أرقام مختلفة.`);
        break;
      }
      case "chat":
        await writeChatMessage(data.text);
        state.chatText = "";
        break;
      case "course": {
        const title = String(data.title || "").trim();
        const description = String(data.description || "").trim();
        if (!title) throw new Error("اكتب اسم المنصة.");
        const selectedGrades = normalizeCourseFilterValues(data.grade);
        const selectedTracks = normalizeCourseFilterValues(data.track);
        if (!selectedGrades.length || !selectedTracks.length) {
          throw new Error("اختر صفاً واحداً على الأقل ومساراً واحداً على الأقل.");
        }
        const gradeValue = selectedGrades.length > 1 ? selectedGrades : selectedGrades[0];
        const trackValue = selectedTracks.length > 1 ? selectedTracks : selectedTracks[0];
        const audienceKeys = courseAudienceKeys({ grade: gradeValue, track: trackValue });
        let notice;
        if (state.editingCourseId) {
          await updateDoc(doc(db, "courses", state.editingCourseId), {
            title,
            description,
            grade: gradeValue,
            track: trackValue,
            audienceKeys,
          });
          if (state.selectedCourse?.id === state.editingCourseId) {
            state.selectedCourse = {
              ...state.selectedCourse,
              title,
              description,
              grade: gradeValue,
              track: trackValue,
              audienceKeys,
            };
          }
          notice = "تم تحديث المنصة.";
        } else {
          await addDoc(collection(db, "courses"), {
            title,
            description,
            grade: gradeValue,
            track: trackValue,
            audienceKeys,
            createdAt: serverTimestamp(),
          });
          notice = "تمت إضافة المنصة بنجاح.";
        }
        state.modal = "";
        state.editingCourseId = null;
        notify(notice);
        break;
      }
      case "chapter": {
        const number = Number(data.number);
        const title = String(data.title || "").trim();
        const type = String(data.type || "");
        if (!Number.isInteger(number) || number < 1 || number > 999) {
          throw new Error("أدخل ترتيباً صحيحاً للفصل.");
        }
        if (!title || title.length > 100) throw new Error("اكتب اسماً صحيحاً للفصل.");
        if (!["chapter", "exam"].includes(type)) throw new Error("اختر نوع الفصل.");
        const duplicate = state.chapters.some((chapter) =>
          chapter.id !== state.editingChapterId
          && Number(chapter.number) === number
          && chapter.type === type);
        if (duplicate) throw new Error("يوجد فصل بهذا الترتيب والنوع بالفعل.");
        const chapterData = { number, title, type };
        if (state.editingChapterId) {
          await updateDoc(doc(db, "chapters", state.editingChapterId), chapterData);
          state.notice = "تم تحديث الفصل.";
        } else {
          await addDoc(collection(db, "chapters"), {
            ...chapterData,
            courseId: state.selectedCourse.id,
            grade: state.selectedCourse.grade,
            track: state.selectedCourse.track,
            audienceKeys: state.selectedCourse.audienceKeys || courseAudienceKeys(state.selectedCourse),
            createdAt: serverTimestamp(),
          });
          state.notice = "تمت إضافة الفصل. يمكنك الآن إضافة الدروس والامتحانات بداخله.";
        }
        state.error = "";
        state.editingChapterId = null;
        state.modal = "";
        render();
        break;
      }
      case "lesson": {
        const entries = [];
        for (let index = 0; index < 8; index += 1) {
          const question = String(data[`question-${index}`] || "").trim();
          const answer = String(data[`answer-${index}`] || "").trim();
          if (question && answer) entries.push({ question, answer });
        }
        if (!entries.length) throw new Error("أضف سؤالاً وإجابة واحدة على الأقل.");
        const title = String(data.title || "").trim();
        if (!title) throw new Error("اكتب اسم الدرس أو الامتحان.");
        if (!["lesson", "exam"].includes(String(data.type))) throw new Error("اختر نوع محتوى صحيحاً.");
        const chapter = state.chapters.find((item) => item.id === data.chapterId);
        if (!chapter) throw new Error("اختر فصلاً صحيحاً.");
        const payload = {
          courseId: state.selectedCourse.id,
          chapterId: chapter.id,
          grade: state.selectedCourse.grade,
          track: state.selectedCourse.track,
          audienceKeys: state.selectedCourse.audienceKeys || courseAudienceKeys(state.selectedCourse),
          chapterNumber: chapter.number,
          chapterTitle: chapter.title,
          title,
          type: data.type,
          entries,
          sortOrder: Number(data.sortOrder || Date.now()),
        };
        if (state.editingLessonId) {
          await updateDoc(doc(db, "lessons", state.editingLessonId), payload);
          notify("تم تحديث المحتوى بنجاح.");
        } else {
          await addDoc(collection(db, "lessons"), {
            ...payload,
            createdAt: serverTimestamp(),
            sortOrder: Number(Date.now()),
          });
          notify("تمت إضافة المحتوى بنجاح.");
        }
        state.editingLessonId = null;
        state.modal = "";
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
      case "announcement": {
        const title = String(data.title || "").trim();
        const body = String(data.body || "").trim();
        if (!title || title.length > 120 || !body || body.length > 3000) {
          throw new Error("أكمل عنوان الإعلان ومحتواه.");
        }
        await addDoc(collection(db, "announcements"), {
          title,
          body,
          createdAt: serverTimestamp(),
          createdBy: state.user.uid,
          hidden: false,
        });
        notify("تم إرسال الإعلان للطلاب. سيظل ظاهراً حتى يخفيه المشرف.");
        break;
      }
      default:
        break;
    }
  } catch (error) {
    console.error(`AF MASTER form submission failed (${form.dataset.form}).`, error);
    state.error = form.dataset.form === "code-login"
      && ["auth/invalid-credential", "auth/user-not-found", "auth/wrong-password", "auth/invalid-email"].includes(error?.code)
      ? "كود الدخول غير صحيح أو لم يتم تفعيله لهذا الحساب."
      : form.dataset.form === "register" && error?.code === "permission-denied"
      ? "الاسم أو رقم الهاتف مستخدم بالفعل، أو لم تُنشر قواعد التسجيل الجديدة في Firestore."
      : form.dataset.form === "whatsapp-share" && error?.code === "permission-denied"
        ? "تعذر إضافة الرقم. تأكد من نشر قواعد Firestore الخاصة بالمشاركة."
      : messageFromError(error);
  } finally {
    state.busy = false;
    render();
  }
}

async function logout() {
  try {
    await signOut(auth);
  } catch (error) {
    fail(error);
    return;
  }
  state.device = null;
  state.deviceError = "";
  state.modal = "";
  state.nav = "home";
}

async function loginWithGoogle() {
  state.busy = true;
  state.error = "";
  render();
  try {
    await signInWithPopup(auth, googleProvider);
  } catch (error) {
    fail(error);
  } finally {
    state.busy = false;
    render();
  }
}

async function enableStudentCodeLogin() {
  if (!state.user || !state.profile || state.admin) {
    throw new Error("سجّل الدخول إلى حساب الطالب أولاً.");
  }
  state.busy = true;
  state.error = "";
  render();
  let code = null;
  try {
    code = state.studentLoginCode || linkedLoginCode(state.user) || createNumericLoginCode();
    state.studentLoginCode = code;
    state.user = await linkNumericLoginCode(auth.currentUser || state.user, code);
    await saveNumericLoginCode(state.user.uid, code);
    notify("تم تفعيل الدخول بالكود الرقمي. احتفظ به بسرية.");
  } catch (error) {
    console.error("Student code-login setup failed.", error);
    let setupError = error;
    if (code && !state.user.providerData.some((item) => item.providerId === "password")) {
      try {
        await saveNumericLoginCode(state.user.uid, code);
      } catch (saveError) {
        console.error("Student login code could not be saved to Firestore.", saveError);
        setupError = saveError;
      }
    }
    state.error = loginCodeSetupError(setupError);
  } finally {
    state.busy = false;
    render();
  }
}

async function deleteCourseAndContent(course) {
  const courseId = course.id;
  const [chapterSnapshot, lessonSnapshot] = await Promise.all([
    getDocs(query(collection(db, "chapters"), where("courseId", "==", courseId))),
    getDocs(query(collection(db, "lessons"), where("courseId", "==", courseId))),
  ]);
  const contentRefs = [
    doc(db, "courses", courseId),
    ...chapterSnapshot.docs.map((item) => item.ref),
    ...lessonSnapshot.docs.map((item) => item.ref),
  ];
  for (const audienceKey of courseAudienceKeys(course)) {
    contentRefs.push(audienceCourseRef(audienceKey, courseId));
    for (const chapter of chapterSnapshot.docs) {
      contentRefs.push(audienceContentRef(audienceKey, courseId, "chapters", chapter.id));
    }
    for (const lesson of lessonSnapshot.docs) {
      contentRefs.push(audienceContentRef(audienceKey, courseId, "lessons", lesson.id));
    }
  }
  for (let offset = 0; offset < contentRefs.length; offset += 450) {
    const batch = writeBatch(db);
    for (const contentRef of contentRefs.slice(offset, offset + 450)) {
      batch.delete(contentRef);
    }
    await batch.commit();
  }
}

async function deleteLessonAndAudienceCopies(lessonId) {
  const lesson = state.lessons.find((item) => item.id === lessonId);
  if (!lesson) throw new Error("تعذر العثور على الدرس المطلوب حذفه.");
  const audienceKeys = courseAudienceKeys(state.selectedCourse || lesson);
  const batch = writeBatch(db);
  batch.delete(doc(db, "lessons", lessonId));
  for (const audienceKey of audienceKeys) {
    batch.delete(audienceContentRef(audienceKey, lesson.courseId, "lessons", lessonId));
  }
  await batch.commit();
}

async function clickAction(action, target, originalTarget) {
  switch (action) {
    case "google-login":
      await loginWithGoogle();
      break;
    case "code-login":
      state.modal = "code-login";
      state.error = "";
      render();
      break;
    case "enable-code-login":
      await enableStudentCodeLogin();
      break;
    case "confirm-channel-subscription":
      if (state.busy || state.admin || !state.user || !state.profile?.isActive || state.profile.whatsappChannelJoined) break;
      state.busy = true;
      state.error = "";
      render();
      try {
        await updateDoc(doc(db, "profiles", state.user.uid), { whatsappChannelJoined: true });
        state.profile = { ...state.profile, whatsappChannelJoined: true };
        notify("تم حفظ تأكيد الاشتراك. أهلاً بك في AF MASTER!");
      } catch (error) {
        console.error("WhatsApp channel subscription confirmation failed.", error);
        state.error = messageFromError(error);
      } finally {
        state.busy = false;
        render();
      }
      break;
    case "toggle-announcement": {
      if (!state.admin || !target.dataset.announcement) break;
      const announcement = state.announcements.find((item) => item.id === target.dataset.announcement);
      if (!announcement) break;
      try {
        await updateDoc(doc(db, "announcements", announcement.id), { hidden: !announcement.hidden });
        notify(announcement.hidden ? "تم إظهار الإعلان للطلاب." : "تم إخفاء الإعلان عن الطلاب.");
      } catch (error) { fail(error); }
      break;
    }
    case "start-support-chat":
      if (state.admin || state.nav !== "support" || !state.profile?.isActive) break;
      state.supportDraftOpen = true;
      render();
      root.querySelector('.chat-composer input[name="text"]')?.focus();
      break;
    case "back-support-inbox":
      if (!state.admin) break;
      state.supportTarget = "";
      state.chatText = "";
      state.chatMessages = [];
      listenChat();
      render();
      break;
    case "logout": await logout(); break;
    case "dismiss": state.error = ""; state.notice = ""; render(); break;
    case "profile": state.modal = "profile"; render(); break;
    case "edit-course":
      if (!state.admin || !state.selectedCourse) break;
      state.editingCourseId = state.selectedCourse.id;
      state.modal = "course";
      render();
      break;
    case "delete-course": {
      if (!state.admin || !state.selectedCourse || state.busy) break;
      const course = state.selectedCourse;
      if (!window.confirm(`سيتم حذف المنصة "${course.title}" وجميع فصولها ودروسها. هل تريد المتابعة؟`)) break;
      state.busy = true;
      state.error = "";
      render();
      try {
        await deleteCourseAndContent(course);
        state.selectedCourse = null;
        state.selectedChapterId = "";
        state.selectedLesson = null;
        listenLessons(null);
        notify("تم حذف المنصة وفصولها ودروسها.");
      } catch (error) {
        console.error(`Could not delete course ${course.id}.`, error);
        fail(error);
      } finally {
        state.busy = false;
        render();
      }
      break;
    }
    case "edit-chapter":
      if (!state.admin || !state.chapters.some((chapter) => chapter.id === target.dataset.chapter)) break;
      state.editingChapterId = target.dataset.chapter;
      state.modal = "chapter";
      render();
      break;
    case "edit-lesson":
      if (!state.admin || !target.dataset.lesson) break;
      state.editingLessonId = target.dataset.lesson;
      state.selectedChapterId = state.lessons.find((lesson) => lesson.id === target.dataset.lesson)?.chapterId || state.selectedChapterId;
      state.modal = "lesson";
      render();
      break;
    case "delete-lesson":
      if (!state.admin || !target.dataset.lesson) break;
      if (!window.confirm("هل تريد حذف هذا الدرس؟")) break;
      try {
        await deleteLessonAndAudienceCopies(target.dataset.lesson);
        notify("تم حذف الدرس.");
      } catch (error) { fail(error); }
      break;
    case "move-lesson-up":
    case "move-lesson-down": {
      if (!state.admin || !target.dataset.lesson) break;
      const lessonId = target.dataset.lesson;
      const sortedLessons = [...state.lessons].sort((a, b) => {
        const rankA = Number(a.sortOrder ?? a.createdAt?.toMillis?.() ?? 0);
        const rankB = Number(b.sortOrder ?? b.createdAt?.toMillis?.() ?? 0);
        return rankA - rankB;
      });
      const index = sortedLessons.findIndex((lesson) => lesson.id === lessonId);
      if (index < 0) break;
      const targetIndex = action === "move-lesson-up" ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= sortedLessons.length) break;
      const current = sortedLessons[index];
      const swap = sortedLessons[targetIndex];
      const currentOrder = Number(current.sortOrder ?? current.createdAt?.toMillis?.() ?? 0);
      const swapOrder = Number(swap.sortOrder ?? swap.createdAt?.toMillis?.() ?? 0);
      await Promise.all([
        updateDoc(doc(db, "lessons", current.id), { sortOrder: swapOrder }),
        updateDoc(doc(db, "lessons", swap.id), { sortOrder: currentOrder }),
      ]);
      notify("تم تحديث ترتيب الدروس.");
      break;
    }
    case "close-modal":
      state.modal = "";
      state.whatsappShareDraft = null;
      state.editingCourseId = null;
      state.editingChapterId = null;
      state.editingLessonId = null;
      state.error = "";
      render();
      break;
    case "backdrop":
      if (originalTarget === target) {
        state.modal = "";
        state.whatsappShareDraft = null;
        state.editingCourseId = null;
        state.editingChapterId = null;
        state.editingLessonId = null;
        state.error = "";
        render();
      }
      break;
    case "share":
      if (remainingReferrals() === 0) return;
      state.modal = "whatsapp-share";
      state.error = "";
      render();
      break;
    case "change-whatsapp-number":
      state.modal = "whatsapp-share";
      state.whatsappShareDraft = null;
      state.error = "";
      render();
      break;
    case "install":
      if (state.installPrompt) {
        await state.installPrompt.prompt();
        await state.installPrompt.userChoice;
        state.installPrompt = null;
        render();
      }
      break;
    case "add-course":
      state.editingCourseId = null;
      state.modal = "course";
      render();
      break;
    case "add-chapter":
      if (!state.admin || !state.selectedCourse) break;
      state.editingChapterId = null;
      state.modal = "chapter";
      render();
      break;
    case "add-lesson":
      if (!state.admin || !state.selectedCourse) break;
      state.selectedChapterId = target.dataset.chapter || "";
      state.editingLessonId = null;
      state.modal = "lesson";
      render();
      break;
    case "add-question": {
      const form = target.closest("form");
      const fields = form.querySelector(".question-fields");
      const count = fields.querySelectorAll(".question-entry").length;
      if (count < 8) fields.insertAdjacentHTML("beforeend", questionFields(count));
      break;
    }
    case "back-courses":
      state.selectedCourse = null; state.selectedChapterId = ""; state.selectedLesson = null; state.examLessonId = ""; listenLessons(null); render(); break;
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
      await updateDoc(doc(db, "profiles", uid), {
        isActive: false,
        statusUpdatedAt: serverTimestamp(),
      });
      notify("تم حظر الحساب.");
    } catch (error) { fail(error); }
  } else {
    const body = window.prompt(`اكتب سبب التحذير للطالب ${student.fullName}:`);
    if (!body) return;
    try {
      const cleanBody = body.trim();
      if (cleanBody.length < 4 || cleanBody.length > 500) {
        throw new Error("اكتب سبب التحذير بطول يتراوح بين 4 و500 حرف.");
      }
      await addDoc(collection(db, "profiles", uid, "warnings"), {
        body: cleanBody,
        createdAt: serverTimestamp(),
        createdBy: state.user.uid,
      });
      notify("تم إرسال التحذير للطالب.");
    } catch (error) { fail(error); }
  }
}

async function handleClick(event) {
  const navButton = event.target.closest("[data-nav]");
  if (navButton) {
    state.nav = navButton.dataset.nav;
    state.selectedLesson = null;
    if (state.admin && state.nav === "support") {
      state.supportTarget = "";
      state.chatText = "";
    }
    if (state.nav === "learning") listenLessons(state.selectedCourse);
    if (state.nav === "chat" || state.nav === "support") listenChat();
    else {
      unsubscribers.get("chat0")?.();
      unsubscribers.get("chat1")?.();
      unsubscribers.get("support-room")?.();
      unsubscribers.get("support-inbox")?.();
      unsubscribers.delete("chat0");
      unsubscribers.delete("chat1");
      unsubscribers.delete("support-room");
      unsubscribers.delete("support-inbox");
      window.clearTimeout(chatExpiryTimer);
      chatExpiryTimer = null;
      window.clearTimeout(supportReplyTimer);
      supportReplyTimer = null;
    }
    if (state.nav === "updates") markAnnouncementsSeen();
    state.error = "";
    render();
    return;
  }
  const supportRoomButton = event.target.closest("[data-support-target]");
  if (supportRoomButton && state.admin) {
    state.supportTarget = supportRoomButton.dataset.supportTarget;
    state.chatText = "";
    state.nav = "support";
    listenChat();
    render();
    return;
  }
  const courseButton = event.target.closest("[data-course]");
  if (courseButton) {
    state.selectedCourse = state.courses.find((course) => course.id === courseButton.dataset.course) || null;
    state.selectedChapterId = "";
    state.selectedLesson = null;
    state.examLessonId = "";
    state.nav = "learning";
    listenLessons(state.selectedCourse);
    render();
    return;
  }
  const lessonButton = event.target.closest(".lesson-row[data-lesson]");
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
      notify("تم النسخ إلى الحافظة.");
    } catch (error) { fail(error); }
    return;
  }
  const deleteButton = event.target.closest("[data-delete-message]");
  if (deleteButton) {
    try {
      const roomId = state.nav === "chat" ? "students" : `support_${state.supportTarget}`;
      await deleteDoc(doc(db, "chatRooms", roomId, "messages", deleteButton.dataset.deleteMessage));
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
