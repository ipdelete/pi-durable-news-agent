#Requires -Version 5.1
<#
.SYNOPSIS
Prepare an existing Ubuntu WSL distribution for the news agent.
.DESCRIPTION
Installs system packages as WSL root and Node/Pi as the default Linux user.
Copies .env and optional .npmrc from this checkout only when absent in Linux.
Does not start the app, register cron jobs, or copy Pi credentials or databases.
.EXAMPLE
.\scripts\setup-wsl.ps1 -WhatIf
.EXAMPLE
.\scripts\setup-wsl.ps1 -Distribution Ubuntu
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [ValidateNotNullOrEmpty()]
    [string]$Distribution = 'Ubuntu',
    [ValidateNotNullOrEmpty()]
    [string]$Repository = 'https://github.com/ipdelete/pi-durable-news-agent.git',
    [ValidateNotNullOrEmpty()]
    [string]$Branch = 'feat/copilot-provider'
)

$ErrorActionPreference = 'Stop'

if (-not $PSCmdlet.ShouldProcess(
    $Distribution,
    "Install Linux dependencies and prepare ~/src/pi-durable-news-agent from $Repository ($Branch)"
)) {
    return
}

Get-Command wsl.exe -ErrorAction Stop | Out-Null
$sourceRepo = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $sourceRepo '.env') -PathType Leaf)) {
    throw 'Create .env in the Windows checkout before running setup. Its contents will not be printed.'
}

function Invoke-Wsl {
    param(
        [string[]]$LinuxCommand,
        [switch]$Root
    )
    $arguments = @('--distribution', $Distribution)
    if ($Root) {
        $arguments += @('--user', 'root')
    }
    & wsl.exe @arguments --exec @LinuxCommand
    if ($LASTEXITCODE -ne 0) {
        throw "WSL setup failed with exit code $LASTEXITCODE. Review the error above."
    }
}

# A temporary LF-only copy also works when Git checks out the helper with CRLF.
$temporaryScript = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
try {
    $helper = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'setup-wsl.sh'))
    [IO.File]::WriteAllText(
        $temporaryScript,
        $helper.Replace("`r`n", "`n"),
        [Text.UTF8Encoding]::new($false)
    )
    $linuxScript = (Invoke-Wsl -LinuxCommand @('wslpath', '-a', '-u', $temporaryScript)).Trim()
    $linuxSource = (Invoke-Wsl -LinuxCommand @('wslpath', '-a', '-u', $sourceRepo)).Trim()

    Invoke-Wsl -LinuxCommand @('bash', $linuxScript, 'inspect', $linuxSource, $Repository, $Branch)
    Invoke-Wsl -Root -LinuxCommand @('bash', $linuxScript, 'packages')
    Invoke-Wsl -LinuxCommand @('bash', $linuxScript, 'setup', $linuxSource, $Repository, $Branch)
}
finally {
    if (Test-Path -LiteralPath $temporaryScript) {
        Remove-Item -LiteralPath $temporaryScript
    }
}

Write-Host 'WSL setup complete. The app and its scheduled ticks have not been started.'
Write-Host "Open $Distribution, run 'pi', then /login and select GitHub Copilot if not already signed in."
Write-Host 'Cron still requires a running WSL distribution; this does not configure Windows startup.'
