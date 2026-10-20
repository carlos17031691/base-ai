---
name: rfc
description: >-
  Genera la plantilla Request for Comments (RFC) en docs/architecture/rfcs/
  exigiendo contexto, impacto en el Ledger, seguridad (BOLA, Tenant, AML),
  plan de rollback y diagrama de arquitectura. Úsese cuando el usuario pida
  crear o redactar un RFC.
---

# Generación de RFC (Request for Comments)

Crea una plantilla estructurada en Markdown para el directorio `docs/architecture/rfcs/` que incluya:
- Título y Responsable.
- Problema y Objetivo de negocio.
- Diseño propuesto (diagrama sugerido en Mermaid, estados y datos).
- Impacto Financiero y Contable (Ledger).
- Seguridad y Cumplimiento (BOLA, Tenant, AML).
- Plan de despliegue y reversión (Rollback).
- Alternativas descartadas.
