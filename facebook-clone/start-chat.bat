@echo off
title Facebook Clone - NPC chat stack
cd /d "%~dp0"
echo.
echo   Starting the NPC chat stack (bridge + tunnel + deploy)...
echo   Keep this window OPEN.
echo.
node start-chat.mjs
pause
