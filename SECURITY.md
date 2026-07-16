# Security Policy — AgentForge Markets

AgentForge Markets is a **devnet-only** research project: trustless, agent-settled
prediction markets on Solana, where every outcome settles against the data
provider's own on-chain Merkle proof. This document is the disclosure policy
referenced by the program's embedded on-chain `security.txt`.

> **Devnet only.** The `forge_markets` program is deployed to Solana **devnet**
> and handles **no** mainnet value. Devnet SOL has no monetary worth. Nothing
> here should be treated as a mainnet-hardened, audited system.

## Scope

- **Program:** `forge_markets`
- **Program ID (devnet):** `7Pvo6SEh1zBa1Euvj5QQ4td9GpfsQosTpxhqwWtWUFt6`
- **Source:** https://github.com/GeckoVision/agent-forge

In scope: the on-chain program (`program/`) and the agent runtime (`backend/`).
Out of scope: third-party dependencies, the upstream data-provider oracle, and
any devnet infrastructure we do not control.

## Reporting a vulnerability

Please report suspected vulnerabilities **privately** first:

1. **Preferred —** open a GitHub Security Advisory:
   https://github.com/GeckoVision/agent-forge/security
2. Or open an issue for non-sensitive reports:
   https://github.com/GeckoVision/agent-forge/issues

Include: affected instruction or component, a description of the impact, and
reproduction steps or a proof-of-concept transaction (devnet signatures welcome).

## Disclosure

- We aim to acknowledge a report within a few business days.
- Please give us a reasonable window to investigate and ship a fix before any
  public disclosure. Do not exploit an issue beyond what is needed to demonstrate
  it, and do not access or modify data that is not yours.

## Bounty

As a devnet-only research project that custodies no real value, AgentForge Markets
does **not** operate a paid bug-bounty program. Verified reports will be credited
in the acknowledgements at our discretion.

## Preferred languages

English (`en`).
