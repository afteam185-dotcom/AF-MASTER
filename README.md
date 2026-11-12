# AF MASTER

تطبيق تعليمي عربي مباشر، مبني بملفات HTML وCSS وJavaScript عادية في جذر المشروع. واجهة الموقع لا تحتاج Node.js أو npm أو React أو Parcel أو خطوة build؛ ملفات Firebase SDK تُحمّل من CDN.

## تشغيل محلياً

افتح `index.html` في المتصفح، أو استخدم خادماً محلياً بسيطاً لدعم ES modules وService Worker:

```powershell
py -m http.server 8000
```

ثم افتح `http://localhost:8000`. تسجيل Google وميزات Firebase تحتاج اتصالاً بالإنترنت ونطاقاً مسموحاً في إعدادات Firebase Authentication.

## النشر على GitHub Pages

1. ادفع ملفات المشروع إلى فرع GitHub.
2. من **Settings → Pages** اختر **Deploy from a branch**، وحدد الفرع ومجلد **/(root)**.
3. فعّل **Google** كمزوّد تسجيل دخول، وأضف نطاق GitHub Pages إلى **Firebase Console → Authentication → Settings → Authorized domains**.

لا تنشئ مجلد `dist` ولا تشغّل عملية build للموقع. ملفات النشر المباشر هي `index.html` و`styles.css` و`app.js` و`firebase-config.js` و`logo.jpeg` و`manifest.webmanifest` و`sw.js`.

إعداد Firebase للويب داخل `firebase-config.js` إعداد عميل عام وليس مفتاحاً سرياً؛ الحماية الفعلية تعتمد على Authentication وFirestore Security Rules. لا تضف مفاتيح Admin SDK أو كلمات المرور إلى ملفات الويب.

## Firebase الخلفي

Cloud Functions وFirestore Rules تظل خدمات خلفية منفصلة عن موقع GitHub Pages. لنشرها:

```powershell
firebase login
firebase use YOUR_FIREBASE_PROJECT_ID
Push-Location functions
npm install
npm run build
Pop-Location
firebase deploy --only firestore,functions
```

يتم تسجيل المشرف عبر Google، وتُقبل فقط الحسابات ذات Firebase UID المدرج في `firebase-config.js` و`functions/src/index.ts`. حد الجلسات هو ثلاثة أجهزة إجمالاً لحسابات المشرف المعتمدة؛ أيقونة **تسجيل دخول المشرف** تظهر أسفل زر Google عند توفر جهاز، وتختفي عند امتلاء الأجهزة ثم تعود بعد تسجيل الخروج. تتطلب وظائف Cloud Scheduler حذف الرسائل والإعلانات دورياً خطة Firebase تدعمها.

## المزايا والحدود

- تسجيل دخول الطلاب بحساب Google، مع ملف يتضمن الاسم والهاتف والصف والمسار.
- دخول الطالب من الصفحة الرئيسية بكود سري من 14 رقماً؛ الحساب يجب أن يكون مسجلاً مسبقاً. احتفظ بالكود ولا تشاركه. الحسابات القديمة تحصل على كود رقمي عند تسجيل الدخول بـGoogle مرة واحدة.
- يسمح لكل طالب بجهازين نشطين؛ الجهاز الثالث ينتظر موافقة المشرف، وعند الموافقة تُنهى أقدم جلسة.
- إضافة المنصات والفصول والدروس والامتحانات من حساب المشرف.
- الإحالات تُحتسب عند تسجيل طالب جديد وفريد؛ لا يستطيع المتصفح إثبات إرسال رسائل WhatsApp أو وصولها. تفتح قراءة المحتوى بعد 10 إحالات مؤكدة.
- تواصل الطالب مع المشرف خاص، وشات الطلاب مشترك؛ الرسائل المؤقتة تُخفى عند انتهاء صلاحيتها وتُحذف دورياً من الخادم.
- يعمل Service Worker ضمن مسار الموقع، بما في ذلك مسار مستودع GitHub Pages.
- معرّف الجهاز مخزن في المتصفح ولا يمثل بصمة مادية مقاومة لتغيير بيانات المتصفح.
