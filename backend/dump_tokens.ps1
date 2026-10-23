$tokens = $null
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile('C:/Users/PC/.gemini/antigravity-ide/scratch/test_alpha_cloud_challenge.ps1', [ref]$tokens, [ref]$errors)
Write-Host "Errors count: $($errors.Count)"
foreach ($e in $errors) {
    Write-Host "ERROR at line $($e.Extent.StartLineNumber):$($e.Extent.StartColumnNumber) - $($e.Message)"
}
foreach ($t in $tokens) {
    if ($t.Kind -match 'String') {
        Write-Host "Token line $($t.Extent.StartLineNumber): $($t.Extent.Text)"
    }
}
