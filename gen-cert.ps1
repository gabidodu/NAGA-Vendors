# Genereaza certificat auto-semnat pentru BC
$cert = New-SelfSignedCertificate `
  -Type Custom `
  -Subject "CN=naga-vendors-app" `
  -KeyUsage DigitalSignature `
  -FriendlyName "Naga Vendors BC App" `
  -NotAfter (Get-Date).AddYears(2) `
  -CertStoreLocation "Cert:\CurrentUser\My"

Write-Host "Certificat creat"
Write-Host "Thumbprint: $($cert.Thumbprint)"

# Export la PFX cu o parola generata aleator (nu e stocata nicaieri — Business Central auth
# foloseste PEM-ul + thumbprint-ul, nu parola PFX-ului; e nevoie de ea doar daca reimporti
# manual certificatul in alta parte)
$certPath = "$PSScriptRoot\bc-app.pfx"
$randomBytes = New-Object byte[] 24
[System.Security.Cryptography.RandomNumberGenerator]::Fill($randomBytes)
$plainPassword = [Convert]::ToBase64String($randomBytes)
$password = ConvertTo-SecureString -String $plainPassword -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath $certPath -Password $password | Out-Null

Write-Host "Certificat salvat la: $certPath"
Write-Host "Parola PFX (salveaz-o doar daca ai nevoie sa reimporti manual): $plainPassword"

# Afiseaza thumbprint
$cert.Thumbprint
