# Shams Academy

Sayt va Telegram Mini App Netlify Functions orqali ishlaydi. Foydalanuvchi
hisoblari, sessiyalar, koinlar, mukofotlar, guruhlar va davomat Netlify
Database (PostgreSQL) da saqlanadi. Sayt Supabase’dan foydalanmaydi.

## Muhim

- Parollar `scrypt` bilan xeshlanadi; ochiq parol ma’lumotlar bazasiga yozilmaydi.
- Faqat `HttpOnly`, `Secure` cookie ichidagi tasodifiy sessiya kaliti brauzerga
  beriladi; bazada uning xeshi saqlanadi.
- Birinchi superadminni faqat Netlify’dagi `SUPERADMIN_SETUP_KEY` maxfiy
  qiymatini bilgan kishi ro‘yxatdan o‘tayotganda sozlay oladi. Keyinchalik yana
  superadmin yaratish bloklanadi.
- Chatda ilgari yuborilgan Telegram bot tokeni oshkor bo‘lgan deb qarang.
  [@BotFather](https://t.me/BotFather) orqali uni bekor qilib, yangisini yarating.
  Yangi tokenni chatga yoki kodga yubormang.
- Oldingi Supabase yoki brauzer-local akkauntlari Netlify bazasiga avtomatik
  ko‘chirilmaydi. Netlify bazasi bo‘sh holatdan boshlanadi.
- Production deploy muvaffaqiyatli bo‘lib, yangi kirish shakli tekshirilmaguncha
  eski Supabase muhit sozlamalarini o‘chirmang; jonli eski versiya ularga
  tayanishi mumkin.

## Netlify bazasi va maxfiy sozlamalar

Netlify’da `shamsacademycoin` loyihasini oching.

1. **Data & storage → Database** bo‘limida Netlify Database yoqilganini tekshiring.
2. **Project configuration → Environment variables** bo‘limida
   `SUPERADMIN_SETUP_KEY` nomli secret qiymat yarating. O‘zingiz ishonchli
   parol menejerida saqlaydigan uzun va tasodifiy qiymat tanlang; uni chatga
   yubormang. Bu qiymat superadmin bo‘lib ro‘yxatdan o‘tish uchun bir marta
   kerak bo‘ladi.
3. Yangi deploy Netlify migrations papkasidagi kutayotgan migratsiyalarni
   avtomatik qo‘llaydi. Migratsiyani qo‘lda production bazada qayta ishlatmang.
4. Deploy muvaffaqiyatli tugagach, saytning **Ro‘yxatdan o‘tish** sahifasida
   o‘zingizning ism-familiyangiz, emailingiz va yangi parolingizni kiriting.
   Email tasdiqlash xati yuborilmaydi. `SUPERADMIN_SETUP_KEY` qiymatini faqat
   superadmin maydoniga kiriting. Hisob yaratilgach, bu maydon va keyingi
   superadminni ro‘yxatdan o‘tkazish bloklanadi.
5. Profil sahifasida email yoki parolni almashtirish mumkin. O‘zgarishlarni
   saqlash uchun amaldagi parol talab qilinadi.

### Superadmin kalitini yaratish

Linux/macOS terminalida:

```sh
openssl rand -base64 36
```

Windows PowerShell’da:

```powershell
[Convert]::ToBase64String((1..36 | ForEach-Object { Get-Random -Maximum 256 }))
```

Chiqqan qiymatni faqat Netlify’dagi environment variable’ga qo‘ying.

## Tekshirish va joylash

Loyiha papkasida:

```sh
npm install
npm test
npm run build
```

Netlify CLI’da loyiha hisobiga kirib, deploy qiling:

```sh
npx netlify-cli login
npx netlify-cli deploy --build --prod
```

Deploy jurnalida `0001_create_coin_tables` va `0002_create_coin_operations`
migratsiyalari muvaffaqiyatli yakunlanganini tekshiring. Birinchi migratsiya
jadvallarni, keyingisi balans, mukofot va davomat amallarini yaratadi. Deploy muvaffaqiyatsiz bo‘lsa, saytning kirish va ro‘yxatdan o‘tish
formalaridan foydalanmang. Avval Netlify deploy jurnalidagi xatoni tuzating.

Netlify’ning deploy uchun ajratilgan krediti tugasa, production deploy
vaqtincha to‘xtatilishi mumkin. Loyiha sahifasida ogohlantirish chiqsa,
Netlify kreditlari tiklanishini kuting. Lokal build muvaffaqiyatli bo‘lishi
production deploy ham muvaffaqiyatli bo‘ldi degani emas.

## Telegram bot

`netlify/functions/telegram-webhook.mjs` faylida bot tokeni yoki webhook
maxfiy kaliti bo‘lmasin. Ularni Netlify muhit sozlamalarida saqlang:
`TELEGRAM_BOT_TOKEN` va `TELEGRAM_WEBHOOK_SECRET`. Webhookni ulash uchun:

```sh
node scripts/set-telegram-webhook.mjs https://shamsacademycoin.netlify.app
```

Skript token va webhook maxfiy kalitini terminalda so‘raydi. Bot tokenini
[@BotFather](https://t.me/BotFather) orqali yangilaganingizdan keyin yangi
tokenni Netlify sozlamalariga ham kiriting. Telegram Mini App’ni bot
sozlamalaridan yoqing, so‘ng [@Shams_coin_bot](https://t.me/Shams_coin_bot)
orqali tekshiring.
