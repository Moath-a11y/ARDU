@echo off
chcp 65001 >nul
setlocal EnableExtensions
set "ROOT=%~dp0"
set "CLI=%ROOT%tools\arduino-cli.exe"
set "CFG=%ROOT%tools\arduino-data\arduino-cli.yaml"
set "SKETCH=%ROOT%firmware\arduino_led_gprs"
set "LOGDIR=%ROOT%logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
for /f %%I in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "STAMP=%%I"
set "LOG=%LOGDIR%\upload-%STAMP%.txt"

echo BARQ LINK - رفع Firmware > "%LOG%"
echo الوقت: %DATE% %TIME% >> "%LOG%"
echo.

echo ============================================
echo   BARQ LINK — فحص ثم تجميع ثم رفع
echo ============================================
echo سجل العمليات: %LOG%
echo.

if not exist "%CLI%" (
  echo [فشل] Arduino CLI غير موجود في tools\arduino-cli.exe
  echo [فشل] Arduino CLI غير موجود >> "%LOG%"
  goto fail_keep
)

"%CLI%" version >> "%LOG%" 2>&1
echo [1] Arduino CLI موجود.

"%CLI%" --config-file "%CFG%" board list > "%TEMP%\barq-boards.txt" 2>>"%LOG%"
type "%TEMP%\barq-boards.txt" >> "%LOG%"
findstr /C:"COM4" "%TEMP%\barq-boards.txt" >nul
if errorlevel 1 (
  echo [فشل] COM4 غير ظاهر في قائمة Arduino CLI.
  echo [فشل] COM4 غير ظاهر >> "%LOG%"
  type "%TEMP%\barq-boards.txt"
  goto fail_keep
)
findstr /C:"COM4" "%TEMP%\barq-boards.txt" | findstr /I "Uno UNO" >nul
if errorlevel 1 (
  echo [تحذير] COM4 ظاهر لكن اسم اللوحة قد لا يكون Uno. راجع السجل.
  echo [تحذير] تحقق اسم اللوحة >> "%LOG%"
) else (
  echo [2] اكتُشفت Arduino Uno على COM4.
)

echo [3] تجميع firmware\arduino_led_gprs ...
"%CLI%" --config-file "%CFG%" compile --fqbn arduino:avr:uno "%SKETCH%" >> "%LOG%" 2>&1
if errorlevel 1 (
  echo [فشل] الترجمة فشلت. التفاصيل في السجل.
  type "%LOG%"
  goto fail_keep
)
echo [3] الترجمة نجحت.

echo [4] محاولة رفع أولى على COM4 بدون RESET...
"%CLI%" --config-file "%CFG%" upload -p COM4 --fqbn arduino:avr:uno "%SKETCH%" >> "%LOG%" 2>&1
if not errorlevel 1 (
  echo [نجاح] Arduino CLI أكد نجاح الرفع.
  echo UPLOAD_OK >> "%LOG%"
  goto ok_keep
)

findstr /I /C:"not in sync" /C:"stk500" /C:"unable to open port" "%LOG%" >nul
if not errorlevel 1 (
  echo.
  echo [تشخيص] فشل البوتلودر: not in sync / المنفذ لم يدخل وضع البرمجة.
  echo السبب المحتمل: أسلاك على D0/D1، أو زر RESET غير مضغوط، أو مكثف DTR.
  echo.
  echo ============================================
  echo   وضع الرفع اليدوي — اضغط RESET الآن
  echo ============================================
  echo أبقي هذه النافذة مفتوحة.
  echo خلال 90 ثانية اضغط زر RESET الأحمر على الأردوينو
  echo واترك USB موصول. لا تفصل الأسلاك بعد بدء العد.
  echo.
  echo انتظار 5 ثوان ثم بدء الرفع...
  timeout /t 5 /nobreak >nul
  echo [5] رفع مع مهلة انتظار البوتلودر...
  "%CLI%" --config-file "%CFG%" upload -p COM4 --fqbn arduino:avr:uno "%SKETCH%" >> "%LOG%" 2>&1
  if not errorlevel 1 (
    echo [نجاح] الرفع نجح بعد وضع RESET.
    echo UPLOAD_OK_AFTER_RESET_WINDOW >> "%LOG%"
    goto ok_keep
  )
  echo [فشل] الرفع لم ينجح حتى بعد نافذة RESET.
  echo UPLOAD_FAIL_BOOTLOADER >> "%LOG%"
  goto fail_keep
)

echo [فشل] رفع غير متوقع. راجع السجل.
goto fail_keep

:ok_keep
echo.
echo النتيجة: نجاح الرفع. السجل: %LOG%
echo لا تفصل USB قبل ما تأكد أن الليد بدأ يومض بعد إعادة التشغيل.
pause
exit /b 0

:fail_keep
echo.
echo النتيجة: لم ينجح الرفع. السجل: %LOG%
echo النافذة تبقى مفتوحة. بعد ما تفصل D0/D1 وتجهز RESET شغّل هذا الملف مرة ثانية.
pause
exit /b 1
