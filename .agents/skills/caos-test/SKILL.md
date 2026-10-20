---
name: caos-test
description: >-
  Genera pruebas de caos financiero en tests/chaos/ inyectando fallos de red,
  timeouts, respuestas HTTP 5xx, webhooks duplicados/desordenados y
  concurrencia de saldo. Úsese cuando el usuario pida pruebas de caos o resiliencia.
---

# Generación de Pruebas de Caos Financiero

A partir del componente analizado, genera pruebas automatizadas (para el directorio `tests/chaos/`) que validen la resiliencia del sistema. Incluye los siguientes escenarios:
- El proveedor acepta la petición pero la conexión hace timeout antes de la respuesta.
- Se reciben webhooks duplicados (3 veces).
- Se reciben webhooks fuera de orden (ej. éxito antes de procesamiento).
- Concurrencia: Dos peticiones simultáneas intentando gastar el mismo saldo disponible.
