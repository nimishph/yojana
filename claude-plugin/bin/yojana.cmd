@echo off
rem yojana for Claude Code on Windows shells; see bin/yojana for the order it looks in.
setlocal
where bun >nul 2>nul || (
  echo yojana: needs Bun on the PATH ^(https://bun.sh^) 1>&2
  exit /b 2
)
if not defined YOJANA_AGENT set "YOJANA_AGENT=claude"
set "plugin=%~dp0.."
if defined YOJANA_HOME (
  if not exist "%YOJANA_HOME%\cli\src\main.ts" (
    echo yojana: no yojana checkout at %YOJANA_HOME% ^(no cli\src\main.ts^); unset YOJANA_HOME to use the bundled CLI 1>&2
    exit /b 2
  )
  bun "%YOJANA_HOME%\cli\src\main.ts" %*
  exit /b %ERRORLEVEL%
)
if exist "%plugin%\..\cli\src\main.ts" if exist "%plugin%\..\node_modules" (
  bun "%plugin%\..\cli\src\main.ts" %*
  exit /b %ERRORLEVEL%
)
bun "%plugin%\lib\yojana.js" %*
exit /b %ERRORLEVEL%
