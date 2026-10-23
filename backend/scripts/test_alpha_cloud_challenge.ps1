# BARQ LINK - Stage 4: Cloud Gateway End-to-End Cellular TCP Verification Script
# Tests ALPHA (COM3) -> Cellular GPRS -> Public Gateway -> ChallengeServer -> Verification Response

param (
    [string]$Port = "COM3",
    [string]$GatewayHost = "",
    [int]$GatewayPort = 0,
    [string]$NodeId = "ALPHA",
    [string]$Apn = "internet"
)

if (-not $GatewayHost -or $GatewayPort -eq 0) {
    Write-Host "Usage: .\test_alpha_cloud_challenge.ps1 -GatewayHost [Host_or_IP] -GatewayPort [Port]" -ForegroundColor Red
    exit 1
}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " BARQ LINK - STAGE 4: CLOUD GATEWAY CELLULAR TCP TEST" -ForegroundColor Cyan
Write-Host " NODE: $NodeId on $Port -> GATEWAY: $GatewayHost`:$GatewayPort" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. Resolve Host IP to avoid 2G cellular DNS timeout
$targetIp = $GatewayHost
if ($GatewayHost -notmatch '^\d+\.\d+\.\d+\.\d+$') {
    Write-Host "`nResolving DNS for $GatewayHost on local host..." -ForegroundColor Gray
    try {
        $ips = [System.Net.Dns]::GetHostAddresses($GatewayHost)
        $targetIp = $ips[0].IPAddressToString
        Write-Host "  Resolved IP: $targetIp" -ForegroundColor Green
    } catch {
        Write-Host "  Could not resolve IP locally, will use hostname directly." -ForegroundColor Yellow
        $targetIp = $GatewayHost
    }
}

# 2. Open Serial Port
Write-Host "`n[1/6] Opening Serial Port $Port at 9600 Baud..." -ForegroundColor Yellow
$sp = New-Object System.IO.Ports.SerialPort($Port, 9600, [System.IO.Ports.Parity]::None, 8, [System.IO.Ports.StopBits]::One)
$sp.ReadTimeout = 4000
$sp.WriteTimeout = 4000
$sp.DtrEnable = $true
$sp.RtsEnable = $true

try {
    $sp.Open()
    Start-Sleep -Milliseconds 400
} catch {
    Write-Host "[-] Failed to open $Port : $_" -ForegroundColor Red
    Write-Host "[!] Ensure no other process holds $Port." -ForegroundColor Yellow
    exit 1
}

function Exec-AT([string]$cmd, [int]$waitMs = 500) {
    $sp.DiscardInBuffer()
    $sp.Write($cmd + "`r`n")
    Start-Sleep -Milliseconds $waitMs
    $resp = ""
    try { $resp = $sp.ReadExisting() } catch {}
    return $resp
}

function Wait-For-Pattern([string]$targetPattern, [int]$timeoutSec = 25) {
    $accumulated = ""
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt $timeoutSec) {
        try {
            $chunk = $sp.ReadExisting()
            if ($chunk) {
                $accumulated += $chunk
                if ($accumulated.Contains($targetPattern)) {
                    return @{ Success = $true; Buffer = $accumulated; ElapsedMs = $sw.ElapsedMilliseconds }
                }
                if ($accumulated.Contains("ERROR") -or $accumulated.Contains("CLOSED") -or $accumulated.Contains("CONNECT FAIL")) {
                    return @{ Success = $false; Buffer = $accumulated; Error = "MODEM_ERROR"; ElapsedMs = $sw.ElapsedMilliseconds }
                }
            }
        } catch {}
        Start-Sleep -Milliseconds 150
    }
    return @{ Success = $false; Buffer = $accumulated; Error = "TIMEOUT"; ElapsedMs = $sw.ElapsedMilliseconds }
}

try {
    # 3. Check Signal & Cellular Registration
    Write-Host "`n[2/6] Verifying SIM and Cellular Registration..." -ForegroundColor Yellow
    Exec-AT "ATE0" 300 | Out-Null
    $csq = Exec-AT "AT+CSQ" 400
    Write-Host "  Signal: $(($csq).Trim())" -ForegroundColor Gray
    
    $creg = Exec-AT "AT+CREG?" 400
    Write-Host "  Network: $(($creg).Trim())" -ForegroundColor Gray

    # 4. Activate GPRS Data Context
    Write-Host ('`n[3/6] Activating GPRS Data Context on APN "' + $Apn + '"...') -ForegroundColor Yellow
    Exec-AT "AT+QIDEACT" 600 | Out-Null

    # Attach to GPRS
    Write-Host "  Attaching to GPRS packet service (AT+CGATT=1)..." -ForegroundColor Gray
    Exec-AT "AT+CGATT=1" 500 | Out-Null
    $gattAttached = $false
    for ($i = 0; $i -lt 10; $i++) {
        $gatt = Exec-AT "AT+CGATT?" 500
        if ($gatt -match '\+CGATT:\s*1') { $gattAttached = $true; break }
        Start-Sleep -Milliseconds 1000
    }
    if (-not $gattAttached) {
        Write-Host "[-] GPRS Attach (CGATT) timed out!" -ForegroundColor Red
        exit 1
    }
    Write-Host "  [+] GPRS Attached successfully (CGATT: 1)" -ForegroundColor Green

    Exec-AT "AT+QIFGCNT=0" 300 | Out-Null
    $qicsgpCmd = 'AT+QICSGP=1,"' + $Apn + '"'
    Exec-AT $qicsgpCmd 300 | Out-Null
    Exec-AT "AT+QIREGAPP" 400 | Out-Null
    
    $sp.DiscardInBuffer()
    $sp.Write("AT+QIACT`r`n")
    $actRes = Wait-For-Pattern "OK" 20
    if (-not $actRes.Success) {
        Write-Host "[-] GPRS Activation failed! Response: $(($actRes).Buffer)" -ForegroundColor Red
        exit 1
    }
    
    $localIp = Exec-AT "AT+QILOCIP" 500
    $carrierIp = ($localIp -split "`r`n" | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' }) | Select-Object -First 1
    Write-Host "  [+] GPRS ACTIVE! Assigned Carrier IP: $carrierIp" -ForegroundColor Green

    # 5. Open TCP Connection to Cloud Gateway
    Write-Host "`n[4/6] Opening TCP Socket to $targetIp`:$GatewayPort..." -ForegroundColor Yellow
    $sp.DiscardInBuffer()
    $qiopenCmd = 'AT+QIOPEN="TCP","' + $targetIp + '",' + $GatewayPort
    $sp.Write($qiopenCmd + "`r`n")
    
    $connRes = Wait-For-Pattern "CONNECT OK" 30
    if (-not $connRes.Success) {
        Write-Host "[-] TCP Connection failed! Buffer: $(($connRes).Buffer)" -ForegroundColor Red
        exit 1
    }
    Write-Host "  [+] TCP SOCKET ESTABLISHED (CONNECT OK) in $(($connRes).ElapsedMs) ms!" -ForegroundColor Green

    # 6. Send Unique Challenge Payload
    $corrId = "CH-" + (Get-Random -Minimum 100000 -Maximum 999999)
    $payloadObj = @{
        proto = "BARQ-CHALLENGE-v1"
        nodeId = $NodeId
        seq = 1
        corrId = $corrId
        time = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
        echo = "BARQ_AIR_PROBE_REAL"
    }
    $jsonPayload = (ConvertTo-Json $payloadObj -Compress) + "`r`n"
    $payloadBytes = [System.Text.Encoding]::UTF8.GetBytes($jsonPayload)
    $len = $payloadBytes.Length

    Write-Host "`n[5/6] Sending Challenge Payload - bytes: $len over TCP..." -ForegroundColor Yellow
    Write-Host "  corrId : $corrId" -ForegroundColor Cyan
    Write-Host "  Payload: $jsonPayload" -ForegroundColor Cyan

    $sp.DiscardInBuffer()
    $sp.Write("AT+QISEND=$len`r`n")
    $promptRes = Wait-For-Pattern ">" 10
    if (-not $promptRes.Success) {
        Write-Host "[-] Did not receive '>' prompt from modem! Buffer: $(($promptRes).Buffer)" -ForegroundColor Red
        exit 1
    }

    # Transmit exact bytes
    $swRoundTrip = [System.Diagnostics.Stopwatch]::StartNew()
    $sp.BaseStream.Write($payloadBytes, 0, $payloadBytes.Length)
    $sp.BaseStream.Flush()

    $sendRes = Wait-For-Pattern "SEND OK" 20
    if (-not $sendRes.Success) {
        Write-Host "[-] Send failed! Buffer: $(($sendRes).Buffer)" -ForegroundColor Red
        exit 1
    }
    Write-Host "  [+] Payload transmitted to cellular tower (SEND OK) in $(($sendRes).ElapsedMs) ms" -ForegroundColor Green

    # 7. Await Correlated Response from ChallengeServer
    Write-Host "`n[6/6] Awaiting Server Verification Response from Gateway..." -ForegroundColor Yellow
    $recvRes = Wait-For-Pattern "ACK_CHALLENGE_VERIFIED" 30
    $totalRtt = $swRoundTrip.ElapsedMilliseconds

    if ($recvRes.Success) {
        $matched = $recvRes.Buffer.Contains($corrId)
        Write-Host "`n==========================================================" -ForegroundColor Green
        if ($matched) {
            Write-Host " [PASS] REAL CELLULAR INTERNET ROUND-TRIP VERIFIED!" -ForegroundColor Green
            Write-Host " Status        : END-TO-END PASS" -ForegroundColor Green
            Write-Host " Correlation ID: $corrId (MATCHED)" -ForegroundColor Green
            Write-Host " Total RTT     : $totalRtt ms" -ForegroundColor Green
            Write-Host " Carrier IP    : $carrierIp" -ForegroundColor Green
            Write-Host " Server ACK Buffer:`n$(($recvRes).Buffer.Trim())" -ForegroundColor Cyan
        } else {
            Write-Host " [WARN] Server response received but corrId mismatch!" -ForegroundColor Yellow
            Write-Host " Status        : ROUND-TRIP INCOMPLETE (CORRID MISMATCH)" -ForegroundColor Yellow
            Write-Host " Expected corrId: $corrId" -ForegroundColor Yellow
            Write-Host " Server Buffer : $(($recvRes).Buffer.Trim())" -ForegroundColor Yellow
        }
        Write-Host "==========================================================" -ForegroundColor Green
    } else {
        Write-Host "[-] Did not receive correlated server response within timeout. Buffer: $(($recvRes).Buffer)" -ForegroundColor Red
    }

    # Clean close
    Write-Host "`nClosing TCP socket and PDP context..." -ForegroundColor Gray
    Exec-AT "AT+QICLOSE" 1000 | Out-Null
    Exec-AT "AT+QIDEACT" 1000 | Out-Null
    Write-Host "  [+] Socket closed and PDP deactivated cleanly." -ForegroundColor Green

} finally {
    if ($sp -and $sp.IsOpen) {
        $sp.Close()
        Write-Host "Serial port $Port closed." -ForegroundColor Gray
    }
}
