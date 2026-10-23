@echo off
setlocal enableextensions
set "ROOT=%~dp0"

title BARQ LINK - Dual Cellular Live Operations Platform

echo ==========================================================
echo   BARQ LINK - DUAL CELLULAR INTELLIGENCE PLATFORM
echo   Stage 5: Live Hardware Interactive Controller (COM3 + COM4)
echo ==========================================================
echo.

echo 1. تشغيل المحرك الخلفي (Hardware Controller + Relay 5050 + REST 4000 + WS 4001)...
start "" "BARQ Backend Core" /D "%ROOT%backend" cmd /k "node server.js"

call :wait_for_backend

if not exist "%ROOT%backend\pinggy_endpoint.json" (
  echo 2. تشغيل نفق TCP العام لمودمات GSM (Pinggy Tunnel)...
  start "" "BARQ TCP Tunnel" /D "%ROOT%backend" cmd /k "node start_pinggy_sdk_tunnel.js"
) else (
  echo 2. نفق TCP موجود مسبقاً، سيتم تحديثه فقط إذا لزم الأمر...
  start "" "BARQ TCP Tunnel" /D "%ROOT%backend" cmd /k "node start_pinggy_sdk_tunnel.js"
)

call :wait_for_tunnel

echo 3. تشغيل واجهة التحكم التفاعلية (Frontend Dashboard على Port 5173)...
start "" "BARQ Frontend UI" /D "%ROOT%frontend" cmd /k "node server.cjs"

call :wait_for_frontend

echo 4. فتح لوحة التحكم في المتصفح...
start http://localhost:5173

echo.
echo ==========================================================
echo المنظومة تعمل الآن بنجاح على العتاد الحقيقي!
echo لوحة التحكم: http://localhost:5173
echo واجهة الـ API:   http://localhost:4000/api/nodes
echo منفذ الـ WS:    ws://localhost:4001
echo خادم Relay:     tcp://localhost:5050
echo ==========================================================
pause
exit /b 0

:wait_for_backend
  echo    انتظار جاهزية الـ Backend على http://localhost:4000...
  for /L %%I in (1,1,60) do (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; try { $r = Invoke-WebRequest -Uri 'http://localhost:4000/api/health' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 300) { exit 0 } } catch { } exit 1" >nul 2>&1
    if not errorlevel 1 goto :backend_ready
    timeout /t 1 /nobreak >nul
  )
  echo    تحذير: Backend لم يصبح جاهزاً خلال 60 ثانية، لكن التشغيل سيستمر...
  goto :backend_ready

:backend_ready
  echo    Backend جاهز.
  exit /b 0

:wait_for_tunnel
  echo    انتظار ظهور endpoint صالح للنفق Pinggy...
  for /L %%I in (1,1,60) do (
    if exist "%ROOT%backend\pinggy_endpoint.json" (
      powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; try { $j = Get-Content '%ROOT%backend\pinggy_endpoint.json' -Raw | ConvertFrom-Json; if ($j.host -and $j.port) { exit 0 } } catch { } exit 1" >nul 2>&1
      if not errorlevel 1 goto :tunnel_ready
    )
    timeout /t 1 /nobreak >nul
  )
  echo    تحذير: لم يظهر endpoint صالح للنفق بعد 60 ثانية، لكن التشغيل سيستمر...
  goto :tunnel_ready

:tunnel_ready
  echo    النفق جاهز، يتم متابعة التشغيل.
  exit /b 0

:wait_for_frontend
  echo    انتظار جاهزية الواجهة على http://localhost:5173...
  for /L %%I in (1,1,45) do (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; try { $r = Invoke-WebRequest -Uri 'http://localhost:5173' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 300) { exit 0 } } catch { } exit 1" >nul 2>&1
    if not errorlevel 1 goto :frontend_ready
    timeout /t 1 /nobreak >nul
  )
  echo    تحذير: الواجهة لم تصبح جاهزة خلال 45 ثانية، لكن التشغيل سيستمر...
  goto :frontend_ready

:frontend_ready
  echo    الواجهة جاهزة.
  exit /b 0
