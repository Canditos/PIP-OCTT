# OCPP Certification Automation — MCP Architecture

> Automação end-to-end de testes OCPP/certificação com integração **OCTT**, **Keysight CDS** e **Jira Cloud** via MCP.

## Arquitectura

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│   OCTT MCP       │     │   CDS MCP        │     │   Jira MCP       │
│   (13 tools)     │     │   (14 tools)     │     │   (7 tools)      │
│   REST/HTTPS     │     │   TCP/SLEP       │     │   REST/HTTPS     │
└────────┬─────────┘     └────────┬─────────┘     └────────┬─────────┘
         │                        │                        │
         └────────────────┬───────┴────────────────────────┘
                          │
              ┌───────────┴───────────┐
              │     Orchestrator      │
              │  Lab → Test → Jira    │
              └───────────────────────┘
```

## Instalação

```bash
npm install
```

## Testes

```bash
npm test
```

## MCP Servers

Cada server corre independentemente via `stdio`:

```bash
# OCTT
npx tsx src/mcp-servers/octt/index.ts

# Keysight CDS
npx tsx src/mcp-servers/cds/index.ts

# Jira
npx tsx src/mcp-servers/jira/index.ts
```

## Configuração

1. Copiar `.env.example` para `.env`
2. Preencher as credenciais
3. Registar os servers no `mcp-config.json`

## Estrutura

```
src/
├── connectors/          # Clientes para sistemas externos
│   ├── octt/            # REST API do OCTT (OCA)
│   ├── cds/             # TCP/SLEP para Keysight CDS
│   └── jira/            # REST API do Jira Cloud
├── domain/              # Lógica de negócio
│   ├── dedup-engine.ts      # Deduplicação de issues
│   ├── severity-classifier.ts  # Classificação de severidade
│   ├── jira-mapper.ts       # Mapeamento OCTT → Jira
│   └── execution-summarizer.ts # Resumos de execução
├── mcp-servers/         # Servidores MCP (stdio transport)
│   ├── octt/            # 13 tools OCTT
│   ├── cds/             # 14 tools CDS
│   └── jira/            # 7 tools Jira
└── orchestrator/        # Coordenador E2E
    └── coordinator.ts   # Pipeline: Lab → Test → Jira
tests/                   # Testes unitários (Vitest)
```

## Tools MCP Disponíveis

### OCTT (13 tools)
| Tool | Descrição |
|------|-----------|
| `octt_list_configurations` | Listar configurações |
| `octt_get_configuration` | Obter configuração específica |
| `octt_start_session` | Iniciar sessão de teste |
| `octt_stop_session` | Parar sessão |
| `octt_list_testcases` | Listar test cases |
| `octt_execute_testcase` | Executar test case |
| `octt_stop_testcase` | Parar test case |
| `octt_get_reports` | Obter relatórios |
| `octt_get_reports_filtered` | Relatórios com filtros avançados |
| `octt_get_sut_status` | Estado da conexão SUT |
| `octt_list_versions` | Versões OCPP disponíveis |
| `octt_add_comment` | Adicionar comentário a log |
| `octt_download_reports` | Descarregar relatórios |

### CDS / Keysight (14 tools)
| Tool | Descrição |
|------|-----------|
| `cds_connect` | Conectar ao CDS via TCP |
| `cds_disconnect` | Desconectar |
| `cds_get_status` | Estado actual do CDS |
| `cds_read_pid` | Ler um PID específico |
| `cds_read_measurements` | Ler Tensão/corrente DC |
| `cds_reset` | Reset do CDS |
| `cds_start` | Iniciar simulação EV |
| `cds_stop` | Parar simulação |
| `cds_emergency_stop` | ⚠️ Paragem de emergência |
| `cds_configure` | Configurar CDS (spec, charge mode, sink) |
| `cds_configure_ev` | Configurar parâmetros EV (DC) |
| `cds_configure_ev_ac` | Configurar parâmetros EV (AC) |
| `cds_wait_status` | Esperar por um estado específico |
| `cds_write_pid` | Escrever um PID (com safety check) |

### Jira (7 tools)
| Tool | Descrição |
|------|-----------|
| `jira_search` | Pesquisar issues (JQL) |
| `jira_get_issue` | Obter issue específica |
| `jira_create_issue` | Criar issue |
| `jira_update_issue` | Actualizar campos |
| `jira_add_comment` | Adicionar comentário |
| `jira_transition_issue` | Transicionar estado |
| `jira_find_existing` | Verificar duplicados |
