@echo off
setlocal enableextensions
set "ROOT=%~dp0"
title BARQ LINK - تحكم الضوء عبر الشريحة

echo تشغيل السيرفر البسيط (واجهة 4000 + TCP 5050)...
start "BARQ Server" /D "%ROOT%backend" cmd /k "node server.js"

echo انتظار الجاهزية...
for /L %%I in (1,1,30) do (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; try { $r = Invoke-WebRequest -Uri 'http://localhost:4000/api/health' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -ge 200) { exit 0 } } catch { } exit 1" >nul 2>&1
  if not errorlevel 1 goto ready
  timeout /t 1 /nobreak >nul
)

:ready
start http://localhost:4000
echo الواجهة: http://localhost:4000
echo منفذ الأردوينو TCP: 5050
echo.
echo افتح جدار النار للمنفذ 5050 إذا الجهاز سيتصل من الشريحة عبر الإنترنت.
pause
