@echo off
rem Runs GenFill with a visible console, so errors are easy to see.
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies ...
  call npm install --no-audit --no-fund || (pause & exit /b 1)
)
call npm start
pause
