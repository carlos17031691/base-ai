---
description: "Revisa código o un pull request con criterios de corrección, seguridad, calidad y aislamiento entre servicios. Úsalo antes de un merge o cuando se pida una revisión."
---
<!-- generado por base-ai: no editar. Fuente: .ai/ -->

# Revisión de código / PR

Revisa el diff y reporta los hallazgos ordenados por severidad (**Bloqueante**, **Importante**, **Sugerencia**), cada uno con archivo, línea y una propuesta concreta.

Lista de verificación:
1. **Corrección:** el código hace lo que dice; se cubren los casos borde y los errores.
2. **Tests:** existen, son significativos y cubren el cambio; el CI está en verde.
3. **Seguridad:** no hay secretos, las entradas se validan, no hay inyecciones, la autorización es correcta y no se filtran datos sensibles en los logs.
4. **Resiliencia:** timeouts, reintentos seguros e idempotencia donde aplique.
5. **Aislamiento:** no hay dependencias por ruta hacia la raíz ni hacia otros servicios; los contratos se mantienen compatibles o están versionados.
6. **Mantenibilidad:** legibilidad, nombres, duplicación y consistencia con las convenciones del servicio.
7. **Operación:** observabilidad suficiente y runbook o documentación actualizados.
8. **Gobernanza:** si hay una decisión arquitectónica o un cambio de alto impacto, existe su ADR o RFC.
9. **Archivos generados:** no se editaron a mano archivos `generado por base-ai`.

Termina con un veredicto: **Aprobar**, **Aprobar con cambios** o **Solicitar cambios**.
