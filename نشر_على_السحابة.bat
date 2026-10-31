@echo off
REM ════════════════════════════════════════════════════════════
REM  BARQ LINK · نشر السيرفر على Fly.io (مرة واحدة = رابط دائم)
REM  شغّل هذا الملف من مجلد المشروع بعد تثبيت flyctl
REM ════════════════════════════════════════════════════════════

setlocal
set FLYCTL=%USERPROFILE%\.fly\bin\flyctl.exe
set APP_NAME=barq-link

echo.
echo ╔══════════════════════════════════════════╗
echo ║      BARQ LINK · نشر على Fly.io         ║
echo ║  الرابط الثابت: barq-link.fly.dev        ║
echo ╚══════════════════════════════════════════╝
echo.

REM التحقق من وجود flyctl
if not exist "%FLYCTL%" (
    echo [!] flyctl غير موجود. يُنزَّل الآن...
    mkdir "%USERPROFILE%\.fly\bin" 2>nul
    powershell -Command "& {$r=Invoke-WebRequest 'https://api.github.com/repos/superfly/flyctl/releases/latest' -UseBasicParsing; $url=($r.Content|ConvertFrom-Json).assets|Where-Object{$_.name -like '*Windows_x86_64*'}|Select-Object -ExpandProperty browser_download_url; Invoke-WebRequest -Uri $url -OutFile '$env:TEMP\flyctl.zip' -UseBasicParsing; Expand-Archive '$env:TEMP\flyctl.zip' '%USERPROFILE%\.fly\bin' -Force}"
    if not exist "%FLYCTL%" (
        echo [✗] فشل تنزيل flyctl. قم بتنزيله يدوياً من:
        echo     https://fly.io/docs/hands-on/install-flyctl/
        pause
        exit /b 1
    )
    echo [✓] flyctl جاهز
)

echo [1/5] تسجيل الدخول إلى Fly.io...
"%FLYCTL%" auth login
if %ERRORLEVEL% neq 0 (
    echo [✗] فشل تسجيل الدخول
    pause
    exit /b 1
)

echo.
echo [2/5] إنشاء التطبيق (مرة واحدة فقط)...
"%FLYCTL%" apps create %APP_NAME% --machines 2>nul
echo     (إذا ظهر خطأ 'already exists' فهذا طبيعي)

echo.
echo [3/5] ضبط المتغيرات السرية (Telegram)...
echo.
echo     أدخل TELEGRAM_BOT_TOKEN الخاص بك (أو اضغط Enter للتخطي):
set /p TG_TOKEN=    > 

if not "%TG_TOKEN%"=="" (
    echo     أدخل TELEGRAM_CHAT_ID الخاص بك:
    set /p TG_CHAT=    > 
    "%FLYCTL%" secrets set TELEGRAM_BOT_TOKEN=%TG_TOKEN% TELEGRAM_CHAT_ID=%TG_CHAT% -a %APP_NAME%
    echo     [✓] تيليغرام مضبوط
) else (
    echo     [i] تخطّي تيليغرام
)

echo.
echo [4/5] رفع ونشر الكود على Fly.io...
"%FLYCTL%" deploy --app %APP_NAME%
if %ERRORLEVEL% neq 0 (
    echo [✗] فشل النشر - تحقق من الأخطاء أعلاه
    pause
    exit /b 1
)

echo.
echo [5/5] التحقق من الحالة...
"%FLYCTL%" status -a %APP_NAME%

echo.
echo ══════════════════════════════════════════════════════
echo  ✅ النشر اكتمل بنجاح!
echo.
echo  🌐 واجهة الويب:    https://barq-link.fly.dev
echo  📡 TCP للأردوينو: barq-link.fly.dev:5050
echo.
echo  ثبّت هذه القيم في الفيرموير:
echo    SERVER_HOST = "barq-link.fly.dev"
echo    SERVER_PORT = 5050
echo ══════════════════════════════════════════════════════
pause
