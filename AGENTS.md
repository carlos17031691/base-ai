# Reglas de Arquitectura, Ledger y SDLC de JavaCash

Estas reglas se aplican de forma continua en todo el repositorio:

## 1. Integridad Financiera (Ledger)
- **Tipos de Datos:** El dinero se maneja EXCLUSIVAMENTE como enteros (unidad menor) o `DECIMAL` exacto. Prohibido usar `float` o `double`.
- **Partida Doble:** Toda operación debe generar un asiento donde los Débitos sumen exactamente igual a los Créditos.
- **Inmutabilidad:** Las correcciones se realizan con asientos compensatorios (`reverses_id`). Prohibido usar `UPDATE` o `DELETE` sobre saldos confirmados.
- **Concurrencia:** La verificación de fondos y el descuento de saldos deben ejecutarse en una sola transacción atómica.

## 2. Idempotencia y Resiliencia
- Todo endpoint de mutación (`POST`, `PUT`, `PATCH`) debe requerir y validar `Idempotency-Key`.
- Manejar explícitamente el estado `unknown` ante timeouts de proveedores externos.
- Prohibidos los reintentos automáticos a ciegas tras un timeout; se debe consultar primero el estado real en el proveedor externo.

## 3. Seguridad y Multi-tenancy (SDLC)
- Toda consulta a base de datos debe filtrar obligatoriamente por `tenant_id`.
- Prevenir vulnerabilidades BOLA, SSRF en webhooks, exposición de secretos y fugas de datos sensibles (PII/PCI) en logs.
