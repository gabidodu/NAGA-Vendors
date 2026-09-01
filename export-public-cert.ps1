# Export public certificate from PFX
param(
    [securestring]$PfxSecurePassword = (Read-Host "PFX password" -AsSecureString)
)

$pfxPath = "$PSScriptRoot\bc-app.pfx"
$cerPath = "$PSScriptRoot\bc-app.cer"
$pfxPassword = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($PfxSecurePassword)
)

# Try using openssl if available
$opensslPath = Get-Command openssl -ErrorAction SilentlyContinue

if ($opensslPath) {
    Write-Host "Using OpenSSL to extract certificate..."
    & openssl pkcs12 -in $pfxPath -clcerts -nokeys -out $cerPath -passin pass:$pfxPassword -passout pass: 2>$null
    
    if (Test-Path $cerPath) {
        # Get thumbprint from the certificate in cert store
        $cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($cerPath)
        Write-Host "✓ Public certificate exported to: $cerPath"
        Write-Host "✓ Thumbprint: $($cert.Thumbprint)"
        exit 0
    }
}

# Fallback: Use PowerShell certificate store
Write-Host "Using Windows Certificate Store..."
Import-PfxCertificate -FilePath $pfxPath -CertStoreLocation "Cert:\CurrentUser\My" -Password (ConvertTo-SecureString $pfxPassword -AsPlainText -Force) -Confirm:$false | Out-Null

# Get cert from store and export public key
$cert = Get-ChildItem "Cert:\CurrentUser\My" | Where-Object { $_.Thumbprint -eq "B2A1F11A6B7A8B4297C7A845A7640116F99411FB" } | Select-Object -First 1

if ($cert) {
    Export-Certificate -Cert $cert -FilePath $cerPath -Type CERT -Force | Out-Null
    Write-Host "✓ Public certificate exported to: $cerPath"
    Write-Host "✓ Thumbprint: $($cert.Thumbprint)"
} else {
    Write-Host "✗ Certificate not found in store"
    exit 1
}

