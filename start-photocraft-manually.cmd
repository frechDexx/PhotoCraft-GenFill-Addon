@echo off
rem Starts PhotoCraft by hand with the control port open (GenFill normally does this for you).
rem Set PHOTOCRAFT_DIR to the folder that contains photocraft.exe, and keep PORT in sync with config.json.
set "PHOTOCRAFT_DIR=C:\Program Files\PhotoCraft"
set "PORT=47821"
set "TOKEN=%~dp0control-token.txt"
set "EXCHANGE=%~dp0exchange"

if not exist "%PHOTOCRAFT_DIR%\photocraft.exe" (
  echo photocraft.exe not found in "%PHOTOCRAFT_DIR%". Edit PHOTOCRAFT_DIR in this file.
  pause
  exit /b 1
)
if not exist "%EXCHANGE%" mkdir "%EXCHANGE%"
set "PHOTOCRAFT_AUTOMATION_READ_ROOT=%EXCHANGE%"
set "PHOTOCRAFT_AUTOMATION_WRITE_ROOT=%EXCHANGE%"
start "" "%PHOTOCRAFT_DIR%\photocraft.exe" --control %PORT% --control-token-file "%TOKEN%" --automation-read-root "%EXCHANGE%" --automation-write-root "%EXCHANGE%"
