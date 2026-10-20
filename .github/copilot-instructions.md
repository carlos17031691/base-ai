<!-- generado por base-ai: no editar. Fuente: .ai/ -->

# Reglas globales para agentes de IA

> Fuente única (ver ADR-0001). Se exporta a AGENTS.md, CLAUDE.md, .cursor/rules y Copilot. Los servicios pueden extender estas reglas con su propio `.ai/rules.md`; si hay conflicto, gana la regla local.

## 1. Contexto del proyecto
- El repo raíz es una **plantilla paraguas**: aquí no hay código de aplicación.
- Cada servicio vive en `src/<nombre>/` y es un **repositorio independiente** con su propia arquitectura, infraestructura y CI/CD.
- `services.yaml` es la fuente de verdad sobre qué servicios existen.

## 2. Límites de aislamiento
- No crees dependencias de un servicio hacia la raíz ni hacia otro servicio vía rutas del sistema de archivos. Los servicios se comunican solo mediante contratos publicados (APIs, eventos, paquetes versionados).
- Antes de modificar algo, identifica en qué repo estás (raíz o `src/<nombre>`) y limita el cambio a ese repo.
- No edites archivos marcados como `generado por base-ai`; edita su fuente en `.ai/`.

## 3. Forma de trabajo
- **Entiende antes de cambiar:** lee el código y la documentación relevantes antes de proponer cambios.
- **Cambios pequeños y verificables:** cada cambio va acompañado de tests o de una forma explícita de validarlo.
- **Decisiones documentadas:** las decisiones de arquitectura van en un ADR (skill `adr`) y los cambios de alto impacto pasan primero por un RFC (skill `rfc`).
- **Operabilidad:** todo componente desplegable debe tener un runbook (skill `runbook`).
- **Revisión:** usa el skill `review` antes de proponer un merge.
- Si un requisito es ambiguo, pregunta en lugar de suponer.

## 4. Calidad y seguridad
- No incluyas secretos, tokens ni datos personales en el código, los logs, los prompts ni la documentación.
- Valida todas las entradas externas y aplica el principio de mínimo privilegio.
- Las operaciones que se reintentan deben ser idempotentes. Los errores deben manejarse explícitamente, nunca silenciarse.
- Respeta el estilo, el linter y las convenciones ya existentes en el servicio.
- Conserva los comentarios y docstrings que no estén relacionados con tu cambio.

## 5. Documentación
- ADRs: `docs/architecture/adrs/ADR-XXXX-titulo.md` (inmutables; se reemplazan, no se editan).
- RFCs: `docs/architecture/rfcs/RFC-XXXX-titulo.md`.
- Runbooks: `docs/operations/runbooks/`. Postmortems: `docs/operations/postmortems/`.
- Las decisiones transversales se documentan en la raíz; las propias de un servicio, en su repo.

## Skills disponibles

- **adr**: Crea un Architecture Decision Record (ADR) inmutable que documenta el qué, el por qué y el cómo de una decisión técnica. Úsalo cuando se pida documentar una decisión de arquitectura o crear un ADR.
- **review**: Revisa código o un pull request con criterios de corrección, seguridad, calidad y aislamiento entre servicios. Úsalo antes de un merge o cuando se pida una revisión.
- **rfc**: Redacta un Request for Comments (RFC) para cambios de alto impacto antes de implementarlos. Úsalo para nuevas funcionalidades relevantes, cambios de contrato entre servicios, migraciones o cambios de infraestructura.
- **runbook**: Genera un runbook operativo para on-call de un servicio o componente. Úsalo cuando se despliegue algo nuevo, se cree una alerta o se pida documentar cómo operar o mitigar un incidente.
