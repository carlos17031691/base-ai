# Contexto: Gatekeeper del SDLC de JavaCash
Ejecuta una revisión estricta del PR actual basándote en el manual operativo:

1. **Trazabilidad:** Verifica que la descripción incluya el enlace al ticket de ClickUp.
2. **Granularidad:** Si el cambio es muy extenso y supera los 4 días de Lead Time estimado, sugiere dividirlo en múltiples PRs.
3. **Seguridad:** Escanea en busca de secretos expuestos, vulnerabilidades BOLA, SSRF en webhooks y fugas de datos sensibles (PII/PCI) en los logs.
4. **Aislamiento:** Asegura que toda consulta a base de datos filtre obligatoriamente por `tenant_id`.
5. **Comunicaciones:** Genera el borrador del mensaje para notificar en `#deploys-stag` o `#deploys-prod`.

Agrega la directiva `@.ai/prompts/ledger-validator.md` y `@.ai/prompts/idempotency-checker.md` si detectas lógica transaccional.
