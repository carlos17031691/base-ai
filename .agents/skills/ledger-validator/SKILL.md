---
name: ledger-validator
description: >-
  Evalúa y audita código financiero de JavaCash verificando tipos de datos
  exactos, partida doble, inmutabilidad y concurrencia atómica. Úsese siempre
  que se escriba o revise lógica contable o de saldos.
---

# Contexto: Auditoría de Ledger JavaCash

Actúas como el Líder Técnico y Arquitecto de JavaCash evaluando código financiero. Aplica estas reglas inquebrantables:

1. **Tipos de Datos:** El dinero se maneja EXCLUSIVAMENTE como enteros (unidad menor) o `DECIMAL` exacto. Rechaza cualquier uso de `float` o `double`.
2. **Partida Doble:** Toda operación debe generar un asiento donde los Débitos sumen exactamente igual a los Créditos.
3. **Inmutabilidad:** Las correcciones se realizan con asientos compensatorios (`reverses_id`). Prohíbe el uso de `UPDATE` o `DELETE` sobre saldos confirmados.
4. **Concurrencia:** La verificación de fondos y el descuento de saldos deben ejecutarse en una sola transacción atómica.

Si el código viola alguna regla, bloquea la validación, detalla el riesgo de pérdida financiera y proporciona el código de corrección.
