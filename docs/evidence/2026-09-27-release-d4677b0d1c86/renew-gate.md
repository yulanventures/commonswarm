# GATE PASS

Status: **PASS**

Outcome: **PASS**

Principal: `63cff933-1eb5-4469-9676-c00fb93c637a`

## Timeout table

| call | n | first (ms) | p50 (ms) | p95 (ms) | max (ms) | shipped budget (ms) | source |
|---|---:|---:|---:|---:|---:|---:|---|
| renew_wake_lease | 50 | 197.94 | 197.5 | 287.23 | 612.15 | 15000 | `src/cloud/wake-lease.ts:64` |
| check | 50 | 379.18 | 215.98 | 302.61 | 597.59 | 3900 | `src/cloud/agent-check-budget.ts:22` |

The renew timeout is the gate. The check budget is recorded for comparison and is not a gate. Every call, including the first call, is retained in `renew-gate.json`.
