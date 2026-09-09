# Security Policy

`cokacremote` is intentionally an unrestricted remote-development MCP server. An authenticated client can execute commands and modify files with the permissions of the service account, so vulnerabilities involving authentication, OAuth, host validation, request isolation, process control, path handling, or unintended remote access are especially important.

## Reporting a vulnerability

Please do **not** open a public issue for a suspected security vulnerability. Use GitHub's private vulnerability reporting / Security Advisory flow for this repository so details can be reviewed before public disclosure.

Include, when possible:

- affected commit/version;
- deployment mode (Linux/Windows, proxy/tunnel, OAuth or Bearer authentication);
- reproduction steps and expected vs. observed behavior;
- impact and whether host-level command/file access is possible;
- logs or request examples with credentials, tokens, private keys, hostnames, and personal data removed.

## Deployment responsibility

This project deliberately does not provide a sandbox or command/path allowlist. Operators should run it only for trusted clients, use HTTPS or a private authenticated network, protect OAuth/Bearer credentials, keep the service account's privileges no broader than necessary, and review the warning/security sections in the README before exposing an endpoint.
