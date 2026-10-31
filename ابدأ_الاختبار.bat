@echo off
chcp 65001 >nul
setlocal
set "ROOT=%~dp0"
title BARQ - اختبار الضوء عبر الشريحة

echo.
echo ============================================
echo   BARQ - تشغيل الاختبار
echo ============================================
echo.

echo [1] تشغيل السيرفر على 4000 و TCP 5050...
start "BARQ Server" /D "%ROOT%backend" cmd /k "node server.js"

echo     انتظار السيرفر...
for /L %%I in (1,1,40) do (
  powershell -NoProfile -Command "try { (Invoke-WebRequest -Uri http://127.0.0.1:4000/api/health -UseBasicParsing -TimeoutSec 1).StatusCode | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
  if not errorlevel 1 goto server_ok
  timeout /t 1 /nobreak >nul
)

:server_ok
echo [2] فتح نفق الإنترنت للمودم...
start "BARQ Tunnel" /D "%ROOT%backend" cmd /k "node start_pinggy_sdk_tunnel.js"

timeout /t 8 /nobreak >nul
echo [3] تحديث عنوان السيرفر داخل كود الأردوينو...
cd /d "%ROOT%backend"
node patch_firmware_endpoint.js

echo [4] فتح الواجهة...
start http://localhost:4000

echo.
echo جاهز. الواجهة: http://localhost:4000
echo لا تغلق نافذتي Server و Tunnel.
echo بعد ذلك ارفع firmware\arduino_led_gprs\arduino_led_gprs.ino على الأردوينو.
echo.
pause
