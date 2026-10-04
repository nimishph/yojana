@echo off
rem yojana for Claude Code on Windows shells; see bin/yojana.
setlocal
if not defined YOJANA_AGENT set "YOJANA_AGENT=claude"
if defined YOJANA_HOME (set "here=%YOJANA_HOME%") else (set "here=%~dp0..\..")
if not exist "%here%\cli\src\main.ts" (
  echo yojana: no yojana checkout at %here% ^(no cli\src\main.ts^); set YOJANA_HOME to one ^(see its README^) 1>&2
  exit /b 2
)
bun "%here%\cli\src\main.ts" %*
