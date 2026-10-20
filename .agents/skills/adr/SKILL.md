---
name: adr
description: >-
  Estructura un Architecture Decision Record (ADR) inmutable en
  docs/architecture/adrs/ documentando el qué, por qué y cómo de una decisión
  técnica. Úsese cuando el usuario pida documentar una decisión de arquitectura
  o crear un ADR.
---

# Generación de ADR (Architecture Decision Record)

Crea un documento de Architecture Decision Record inmutable en Markdown para el directorio `docs/architecture/adrs/` (con nomenclatura `ADR-XXXX-titulo-corto.md`) que incluya:
- **Título y Metadatos**: Fecha, Estado (`Propuesto`, `Aceptado`, `Deprecado`, `Reemplazado por ADR-YYYY`) y Autores.
- **Contexto y Problema**: Qué fuerza técnica, de negocio o regulatoria motiva esta decisión (el *por qué*).
- **Decisión**: Qué cambio arquitectónico o técnico se adopta de manera concreta (el *qué* y el *cómo*).
- **Impacto en Ledger, Resiliencia y Seguridad**: Efectos sobre integridad contable, idempotencia, aislamiento por `tenant_id` y cumplimiento (PCI/PII).
- **Consecuencias**: Compromisos (trade-offs) positivos, negativos y riesgos asociados.
- **Alternativas Consideradas**: Opciones evaluadas y razones técnicas o financieras por las cuales se descartaron.
