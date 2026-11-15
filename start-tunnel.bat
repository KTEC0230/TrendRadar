@echo off
chcp 65001 >nul
echo ============================================
echo  JingLiu Cloudflare Tunnel
echo ============================================
echo  After it starts, find the line:
echo    https://xxxx-xxxx.trycloudflare.com
echo  Copy that address into the App settings
echo  (Backend URL). Token stays the same.
echo  NOTE: address changes on every restart.
echo  Stop: close this window or Ctrl+C
echo ============================================
echo.

"C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://127.0.0.1:8807
pause
