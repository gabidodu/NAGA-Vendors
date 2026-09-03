# Genereaza certificat nou (rotatie de securitate) pentru BC — inlocuieste bc-app.pfx expus
$cert = New-SelfSignedCertificate `
  -Type Custom `
  -Subject "CN=naga-vendors-app-v2" `
  -KeyUsage DigitalSignature `
  -FriendlyName "Naga Vendors BC App v2 (rotated)" `
  -NotAfter (Get-Date).AddYears(2) `
  -CertStoreLocation "Cert:\CurrentUser\My"

$thumbprint = $cert.Thumbprint

# Export public cert (DER, for upload to Entra)
$cerPath = "$PSScriptRoot\bc-app-v2.cer"
Export-Certificate -Cert $cert -FilePath $cerPath -Type CERT -Force | Out-Null

# Export private key as PKCS8 PEM (what BC_CERT_PEM needs) — written straight to file, never echoed
$rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($cert)
$pkcs8Bytes = $rsa.ExportPkcs8PrivateKey()
$pem = "-----BEGIN PRIVATE KEY-----`n"
$b64 = [Convert]::ToBase64String($pkcs8Bytes)
for ($i = 0; $i -lt $b64.Length; $i += 64) {
  $len = [Math]::Min(64, $b64.Length - $i)
  $pem += $b64.Substring($i, $len) + "`n"
}
$pem += "-----END PRIVATE KEY-----`n"
$keyPath = "$PSScriptRoot\bc-app-key-v2.pem"
Set-Content -Path $keyPath -Value $pem -NoNewline

Write-Host "THUMBPRINT=$thumbprint"
Write-Host "CER_PATH=$cerPath"
Write-Host "KEY_PATH=$keyPath"
Write-Host "KEY_BYTES=$((Get-Item $keyPath).Length)"
