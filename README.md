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

لا تنشئ مجلد `dist` ولا تشغّل عملية build للموقع. ملفات النشر المباشر تشمل `index.html` و`styles.css` و`app.js` و`firebase-config.js` و`logo.jpeg` و`manifest.webmanifest` و`sw.js` وفيديو المقدمة `WhatsApp Video 2026-11-12 at 11.29.58 PM.mp4`.

إعداد Firebase للويب داخل `firebase-config.js` إعداد عميل عام وليس مفتاحاً سرياً؛ الحماية الفعلية تعتمد على Authentication وFirestore Security Rules. لا تضف مفاتيح Admin SDK أو كلمات المرور إلى ملفات الويب.

## Firebase الخلفي

قواعد Firestore مطلوبة للسماح بتسجيل الطلاب من العميل؛ انشر القواعد بعد مراجعتها:

```powershell
firebase login
firebase use YOUR_FIREBASE_PROJECT_ID
firebase deploy --only firestore:rules
```

إنشاء ملف الطالب وتحديث الصف والمسار يتمان مباشرةً عبر Firestore بعد تسجيل Google، ولا يحتاجان Cloud Functions. ما زالت بعض الميزات الأخرى تستخدم الدوال، مثل المحادثات والإعلانات والتحذيرات. لنشر هذه الدوال عند الحاجة:

```powershell
Push-Location functions
npm install
npm run build
Pop-Location
firebase deploy --only firestore,functions
```

تحتاج Cloud Functions إلى تفعيل خدمات Google Cloud المطلوبة في مشروع `af-masters`، وقد تتطلب خطة Firebase Blaze وربط الفوترة. إذا ظهر `SERVICE_DISABLED`، فعّل **Cloud Functions API** للمشروع ثم أعد أمر النشر.

يسجل المشرف من زر **المتابعة باستخدام Google** نفسه؛ تمنح قواعد Firestore صلاحية الإدارة فقط لمعرّفات UID المعتمدة في `firebase-config.js` و`firestore.rules`. دخول المشرف لا يحتاج تسجيل جهاز أو Cloud Function، ولا يفرض حداً لعدد الأجهزة. تظل Cloud Functions مستخدمة لعمليات أخرى مثل المحادثات والإعلانات والتحذيرات.

## المزايا والحدود

- تسجيل الطلاب عبر Google؛ يحفظ الطالب اسمه والهاتف والصف والمسار مباشرةً في `profiles/{uid}`. تمنع قواعد Firestore تعديل بيانات طالب آخر، وتحجز الاسم ورقم الهاتف لمنع التكرار.
- دخول الطلاب عبر Google فقط؛ لم يعد تسجيل الدخول بكود رقمي متاحاً. لا تفرض عملية دخول الطالب حداً للأجهزة أو موافقات الأجهزة.
- تظهر مقدمة الفيديو مرة في كل جلسة متصفح. يبدأ التشغيل بالصوت تلقائياً حيث يسمح المتصفح؛ إذا منع التشغيل التلقائي، يلزم الضغط على زر التشغيل، ولا يوجد تخطٍ.
- تحديث الصف والمسار يتم مباشرةً في Firestore. فتح المحتوى يتطلب إرسال رسالة واتساب إلى 10 أرقام مختلفة وتأكيد الإرسال يدوياً؛ لا يشترط تسجيل المستلمين.
- إضافة المنصات والفصول والدروس والامتحانات من حساب المشرف.
- أرقام واتساب تُحفظ كبصمات SHA-256 خاصة بكل حساب لمنع تكرار الرقم دون تخزينه كنص. المتصفح لا يستطيع التحقق من أن الرسالة أُرسلت فعلاً؛ التأكيد يدوي، لذلك لا يمكن ضمانه ضد التحايل.
- تواصل الطالب مع المشرف خاص، وشات الطلاب مشترك؛ الرسائل المؤقتة تُخفى عند انتهاء صلاحيتها وتُحذف دورياً من الخادم.
- يعمل Service Worker ضمن مسار الموقع، بما في ذلك مسار مستودع GitHub Pages.
- معرّف الجهاز مخزن في المتصفح ولا يمثل بصمة مادية مقاومة لتغيير بيانات المتصفح.
