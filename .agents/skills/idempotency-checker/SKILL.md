---
name: idempotency-checker
description: >-
  Verifica idempotencia y resiliencia en controladores de API, integraciones
  con terceros y workers de colas. Úsese al revisar o crear endpoints de
  mutación, webhooks o integraciones externas.
---

# Contexto: Verificación de Idempotencia y Resiliencia

Al revisar controladores de API, integraciones con terceros o workers de colas, verifica lo siguiente:

1. Todo endpoint de mutación (`POST`, `PUT`, `PATCH`) debe requerir y validar una clave de idempotencia (`Idempotency-Key`).
2. El código debe manejar explícitamente el estado `unknown` ante timeouts de proveedores externos.
3. Prohíbe los reintentos automáticos a ciegas. Si hay un timeout, se debe consultar el estado real de la transacción en el tercero antes de tomar otra acción.
