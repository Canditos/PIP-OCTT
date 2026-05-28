# Manual de Setup — Novo PC / Novas Instâncias

## Índice
1. [Primeira vez (clone + setup)](#1-primeira-vez)
2. [Configurar OCTT novo](#2-configurar-octt-novo)
3. [Configurar CDS novo](#3-configurar-cds-novo)
4. [Configurar Jira novo](#4-configurar-jira-novo)
5. [Correr o servidor](#5-correr-o-servidor)
6. [Resolver problemas](#6-resolver-problemas)

---

## 1. Primeira vez

```powershell
# 1. Clonar
git clone https://github.com/Canditos/PIP-OCTT.git
cd PIP-OCTT

# 2. Instalar dependências
npm install

# 3. Download Playwright browsers (só precisa uma vez)
npx playwright install chromium

# 4. Criar config a partir do template
copy dashboard-config.example.json dashboard-config.json

# 5. Editar o ficheiro com os valores da tua instância
notepad dashboard-config.json
```

---

## 2. Configurar OCTT novo

### O que precisas:
- **URL** da instância OCTT (ex: `https://tua-empresa.octt.openchargealliance.org`)
- **API Token** (vai buscar ao Web UI do OCTT)

### No `dashboard-config.json`:

```json
{
  "octtBaseUrl": "https://tua-empresa.octt.openchargealliance.org",
  "octtToken": "8da84443f8a771885342c94f8dd450f15811b306435c33fae4928d424ae9a512",
  "octtOcppVersion": "ocpp1.6",
  "octtRole": "CS"
}
```

### Ou via env vars (útil para CI/CD):

```powershell
$env:OCTT_BASE_URL = "https://tua-empresa.octt.openchargealliance.org"
$env:OCTT_TOKEN = "8da84443f8a771885342c94f8dd450f15811b306435c33fae4928d424ae9a512"
```

### Verificar que funciona:
```powershell
curl http://localhost:3101/api/octt/check -Method POST
```

Resposta esperada:
```json
{ "ok": true, "configurations": ["AUT_SID_SAT", "..."] }
```

### Configurações críticas no OCTT:
- `maxTimeoutPeriod`: 70 (normal) / 600 (reboot tests)
- `longOperationTimeout`: 450 (normal) / 650 (reboot tests)
- O dashboard ajusta automático quando detecta reboot tests

---

## 3. Configurar CDS novo

### O que precisas:
- **IP** da Keysight SL1040A na rede
- **Porta** TCP (default: 51001)
- Cabo Ethernet ligado entre o PC e a CDS

### No `dashboard-config.json`:

```json
{
  "cdsIp": "192.168.100.10",
  "cdsPort": 51001
}
```

### Ou via env vars:

```powershell
$env:CDS_IP = "192.168.100.10"
$env:CDS_PORT = "51001"
```

### Verificar que funciona:
```powershell
curl http://localhost:3101/api/cds/check -Method POST `
  -Headers @{"Content-Type"="application/json"} `
  -Body '{"ip": "192.168.100.10", "port": 51001}'
```

Resposta esperada:
```json
{ "ok": true, "status": 1, "flags": ["Idle", "Waiting for plugin"] }
```

### Se não conectar:
1. `ping 192.168.100.10` — a CDS responde?
2. Firewall do Windows permite porta 51001?
3. Cabo Ethernet está ligado?
4. A CDS está ligada (led verde)?

### Configurar perfil na CDS (opcional):
```powershell
curl http://localhost:3101/api/cds/configure -Method POST `
  -Headers @{"Content-Type"="application/json"} `
  -Body '{"ip": "192.168.100.10", "port": 51001, "profile": "OCPP 1.6"}'
```

---

## 4. Configurar Jira novo

### O que precisas:
- **URL** do Jira Cloud (ex: `https://tua-empresa.atlassian.net`)
- **Email** da conta
- **API Token** (gerar em https://id.atlassian.com/manage/api-tokens)
- **Project Key** (ex: `CERT`, `PROJ`)

### No `dashboard-config.json`:

```json
{
  "jiraBaseUrl": "https://tua-empresa.atlassian.net",
  "jiraEmail": "tu@email.com",
  "jiraApiToken": "ATATT3...token...",
  "jiraProjectKey": "CERT"
}
```

### Verificar que funciona:
```powershell
curl http://localhost:3101/api/jira/check -Method POST
```

---

## 5. Correr o servidor

```powershell
npm run dev:cert
```

Acesso: http://localhost:3101

### Para correr em background (não fechar ao fechar terminal):

**PowerShell:**
```powershell
Start-Process -NoNewWindow -FilePath "npm" -ArgumentList "run dev:cert"
```

**Ou com task scheduler / nssm** para correr como serviço Windows:
```powershell
# Instalar nssm (uma vez)
winget install nssm

# Criar serviço
nssm install OCPPDashboard "C:\Program Files\nodejs\node.exe" `
  "C:\caminho\para\PIP-OCTT\node_modules\.bin\tsx" `
  "C:\caminho\para\PIP-OCTT\src\apps\certification-dashboard\server.ts"

# Iniciar
nssm start OCPPDashboard
```

---

## 6. Resolver problemas

### "ECONNREFUSED" na CDS
```
Causa: CDS não ligada, IP errado, ou firewall
Solução: ping IP, verificar cabo, verificar firewall
```

### "401 Unauthorized" no OCTT
```
Causa: Token expirado ou inválido
Solução: Gerar novo token no Web UI do OCTT
```

### "504 Gateway Timeout" no OCTT
```
Causa: Teste de reboot demora >10min, proxy do OCTT corta
Solução: O dashboard trata como "inconc" automaticamente
```

### "Playwright already running"
```
Causa: Tentaste correr 2 pipelines ao mesmo tempo
Solução: Espera o atual terminar ou faz POST /api/pipeline/stop-playwright
```

### Config encriptado não abre noutro PC
```
Causa: A chave AES deriva do hostname (diferente em cada PC)
Solução: 
  1. Apagar dashboard-config.json e recriar (setup pergunta TUDO)
  2. OU definir $env:ENCRYPTION_KEY igual nos dois PCs
```

### Dashboard não abre no browser
```
Causa: Servidor não está a correr
Solução: Correr npm run dev:cert e ver output
```

---

## Setup completo em 10 segundos (novo PC)

```powershell
git clone https://github.com/Canditos/PIP-OCTT.git
cd PIP-OCTT
.\start.cmd        # ou .\start.ps1
```

É só isto. O script faz **tudo automático:**
1. Verifica se Node.js está instalado
2. `npm install` se precisar
3. Instala Playwright Chromium browser
4. Cria `dashboard-config.json` a partir do template e abre para editares
5. Arranca o servidor
6. Abre o browser em `http://localhost:3101`
