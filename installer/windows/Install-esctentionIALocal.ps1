[CmdletBinding()]
param(
  [string]$Repository = 'louisastori/ExtentionsIA',
  [string]$ReleaseTag = 'latest',
  [string]$VsixPath,
  [string]$VsixUrl,
  [string]$Model = 'gemma4:26b',
  [string]$OllamaInstallDir,
  [switch]$ForceOllamaInstall,
  [switch]$SkipVsixInstall,
  [switch]$SkipOllamaInstall,
  [switch]$SkipModelPull
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-Step {
  param([string]$Message)
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Invoke-JsonRequest {
  param(
    [Parameter(Mandatory = $true)][string]$Uri
  )

  return Invoke-RestMethod -Uri $Uri -Headers @{
    'Accept' = 'application/vnd.github+json'
    'User-Agent' = 'esctentionIALocal-bootstrapper'
  }
}

function Download-File {
  param(
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][string]$OutFile
  )

  Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing
  return $OutFile
}

function Resolve-CodeCli {
  $candidates = @(
    'code.cmd',
    'code',
    'code-insiders.cmd',
    'code-insiders',
    (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\bin\code.cmd'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code Insiders\bin\code-insiders.cmd')
  ) | Where-Object { $_ }

  foreach ($candidate in $candidates) {
    try {
      $command = Get-Command $candidate -ErrorAction Stop
      return $command.Path
    } catch {
      if (Test-Path $candidate) {
        return (Resolve-Path $candidate).Path
      }
    }
  }

  throw "Impossible de trouver la CLI VS Code. Installe VS Code et verifie que la commande 'code' est disponible."
}

function Resolve-OllamaCli {
  $candidates = @(
    'ollama',
    (Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe')
  ) | Where-Object { $_ }

  foreach ($candidate in $candidates) {
    try {
      $command = Get-Command $candidate -ErrorAction Stop
      return $command.Path
    } catch {
      if (Test-Path $candidate) {
        return (Resolve-Path $candidate).Path
      }
    }
  }

  return $null
}

function Test-OllamaReachable {
  try {
    Invoke-RestMethod -Uri 'http://localhost:11434/api/version' -Method Get -TimeoutSec 2 | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Wait-Ollama {
  param([int]$TimeoutSeconds = 60)

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-OllamaReachable) {
      return
    }

    Start-Sleep -Milliseconds 500
  }

  throw 'Ollama ne repond pas sur http://localhost:11434 apres le delai imparti.'
}

function Install-Ollama {
  param([string]$InstallDir)

  Write-Step 'Installation d''Ollama'
  $installerScript = Join-Path ([System.IO.Path]::GetTempPath()) 'ollama-install.ps1'
  Download-File -Url 'https://ollama.com/install.ps1' -OutFile $installerScript | Out-Null

  $previousInstallDir = $env:OLLAMA_INSTALL_DIR
  try {
    if ($InstallDir) {
      $env:OLLAMA_INSTALL_DIR = $InstallDir
    }

    & $installerScript
  } finally {
    if ($null -ne $previousInstallDir) {
      $env:OLLAMA_INSTALL_DIR = $previousInstallDir
    } else {
      Remove-Item Env:OLLAMA_INSTALL_DIR -ErrorAction SilentlyContinue
    }

    Remove-Item $installerScript -Force -ErrorAction SilentlyContinue
  }
}

function Start-OllamaIfNeeded {
  $ollamaCli = Resolve-OllamaCli
  if (-not $ollamaCli) {
    throw "Impossible de trouver l'executable Ollama apres installation."
  }

  if (Test-OllamaReachable) {
    return $ollamaCli
  }

  Write-Step 'Demarrage d''Ollama'
  Start-Process -FilePath $ollamaCli -ArgumentList 'serve' -WindowStyle Hidden | Out-Null
  Wait-Ollama
  return $ollamaCli
}

function Get-ReleaseAssetUrl {
  param(
    [Parameter(Mandatory = $true)][string]$Repo,
    [Parameter(Mandatory = $true)][string]$Tag
  )

  $releaseApiUrl = if ($Tag -eq 'latest') {
    "https://api.github.com/repos/$Repo/releases/latest"
  } else {
    "https://api.github.com/repos/$Repo/releases/tags/$Tag"
  }

  $release = Invoke-JsonRequest -Uri $releaseApiUrl
  $vsixAsset = $release.assets | Where-Object { $_.name -like '*.vsix' } | Select-Object -First 1
  if (-not $vsixAsset) {
    throw "Aucun asset .vsix n'a ete trouve dans la release '$Tag' du depot '$Repo'."
  }

  return $vsixAsset.browser_download_url
}

function Resolve-Vsix {
  param(
    [string]$ExplicitPath,
    [string]$ExplicitUrl,
    [string]$Repo,
    [string]$Tag
  )

  if ($ExplicitPath) {
    if (-not (Test-Path $ExplicitPath)) {
      throw "Le fichier VSIX specifie est introuvable : $ExplicitPath"
    }

    return (Resolve-Path $ExplicitPath).Path
  }

  $downloadUrl = if ($ExplicitUrl) {
    $ExplicitUrl
  } else {
    Get-ReleaseAssetUrl -Repo $Repo -Tag $Tag
  }

  $targetPath = Join-Path ([System.IO.Path]::GetTempPath()) 'esctentionIALocal.vsix'
  Write-Step "Telechargement du package VS Code depuis $downloadUrl"
  Download-File -Url $downloadUrl -OutFile $targetPath | Out-Null
  return $targetPath
}

function Install-Vsix {
  param(
    [Parameter(Mandatory = $true)][string]$CliPath,
    [Parameter(Mandatory = $true)][string]$PackagePath
  )

  Write-Step 'Installation de l''extension VS Code'
  & $CliPath '--install-extension' $PackagePath '--force'
}

function Install-Model {
  param(
    [Parameter(Mandatory = $true)][string]$CliPath,
    [Parameter(Mandatory = $true)][string]$ModelName
  )

  Write-Step "Telechargement du modele $ModelName"
  & $CliPath 'pull' $ModelName
}

Write-Step 'Preparation du bootstrap Windows'
$downloadedVsix = $null

try {
  if (-not $SkipVsixInstall) {
    $codeCli = Resolve-CodeCli
    $resolvedVsix = Resolve-Vsix -ExplicitPath $VsixPath -ExplicitUrl $VsixUrl -Repo $Repository -Tag $ReleaseTag
    if ($resolvedVsix -like (Join-Path ([System.IO.Path]::GetTempPath()) '*')) {
      $downloadedVsix = $resolvedVsix
    }

    Install-Vsix -CliPath $codeCli -PackagePath $resolvedVsix
  }

  $ollamaCli = Resolve-OllamaCli
  if (-not $SkipOllamaInstall -and ($ForceOllamaInstall -or -not $ollamaCli)) {
    Install-Ollama -InstallDir $OllamaInstallDir
    $ollamaCli = $null
  }

  if (-not $SkipOllamaInstall -or -not $SkipModelPull) {
    $ollamaCli = Start-OllamaIfNeeded
  }

  if (-not $SkipModelPull) {
    Install-Model -CliPath $ollamaCli -ModelName $Model
  }

  Write-Host ''
  Write-Host 'Installation terminee.' -ForegroundColor Green
  if (-not $SkipVsixInstall) {
    Write-Host "- Extension installee dans VS Code"
  }
  if (-not $SkipOllamaInstall) {
    Write-Host "- Ollama installe et demarre"
  }
  if (-not $SkipModelPull) {
    Write-Host "- Modele disponible : $Model"
  }
} finally {
  if ($downloadedVsix -and (Test-Path $downloadedVsix)) {
    Remove-Item $downloadedVsix -Force -ErrorAction SilentlyContinue
  }
}
