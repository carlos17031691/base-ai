---
name: "adr"
description: "Crea un Architecture Decision Record (ADR) inmutable que documenta el qué, el por qué y el cómo de una decisión técnica. Úsalo cuando se pida documentar una decisión de arquitectura o crear un ADR."
---
<!-- generado por base-ai: no editar. Fuente: .ai/ -->

# ADR (Architecture Decision Record)

1. Determina el alcance: si la decisión es **transversal**, va en la raíz; si es **propia de un servicio**, va en `src/<nombre>/`.
2. Calcula el siguiente número disponible en `docs/architecture/adrs/` y crea `ADR-XXXX-titulo-corto.md`.
3. Usa esta estructura:
   - **Título y metadatos:** fecha, estado (`Propuesto`, `Aceptado`, `Deprecado`, `Reemplazado por ADR-YYYY`) y autores.
   - **Contexto y problema:** las fuerzas técnicas, de negocio o regulatorias que motivan la decisión.
   - **Decisión:** qué se adopta y cómo, de forma concreta y verificable.
   - **Impacto:** efectos en seguridad, resiliencia, rendimiento, costo y operación.
   - **Consecuencias:** trade-offs positivos, negativos y riesgos, con sus mitigaciones.
   - **Alternativas consideradas:** opciones evaluadas y por qué se descartaron.
4. Los ADR aceptados son inmutables: para cambiar una decisión, crea un ADR nuevo y marca el anterior como `Reemplazado por`.
