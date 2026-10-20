---
id: rfc
description: >-
  Redacta un Request for Comments (RFC) para cambios de alto impacto antes de
  implementarlos. Úsalo para nuevas funcionalidades relevantes, cambios de
  contrato entre servicios, migraciones o cambios de infraestructura.
targets: all
---

# RFC (Request for Comments)

1. Determina el alcance (raíz si afecta a varios servicios, o el servicio concreto) y crea `docs/architecture/rfcs/RFC-XXXX-titulo-corto.md`.
2. Usa esta estructura:
   - **Metadatos:** fecha, estado (`Borrador`, `En revisión`, `Aprobado`, `Rechazado`, `Implementado`), autores y revisores.
   - **Resumen:** un párrafo con el cambio propuesto.
   - **Motivación:** el problema que resuelve y cómo se mide el éxito.
   - **Diseño propuesto:** componentes, contratos (APIs/eventos), datos y diagramas.
   - **Servicios afectados:** qué repos cambian y el orden de despliegue.
   - **Seguridad y privacidad:** amenazas, datos sensibles y controles.
   - **Resiliencia:** modos de fallo, timeouts, reintentos e idempotencia.
   - **Observabilidad:** métricas, logs, trazas y alertas.
   - **Plan de rollout y rollback:** feature flags, migraciones y cómo revertir.
   - **Alternativas y preguntas abiertas.**
3. Si el RFC se aprueba y fija una decisión duradera, deriva de él un ADR.
