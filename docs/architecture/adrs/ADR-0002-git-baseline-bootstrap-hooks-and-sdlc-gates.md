# ADR-0002: Bootstrap de ramas base (`main` y `development`), hooks en raíz y endurecimiento de Gates SDLC

- **Fecha:** 2026-10-20
- **Estado:** Aceptado
- **Autores:** Equipo base-ai

---

## 1. Contexto y problema

Durante la validación práctica de `base-ai` construyendo un proyecto multi-servicio real (`test-base-ai-project` / Fintech sobre GCP + MongoDB Atlas), se detectaron cuatro brechas operativas entre lo que definían las reglas de IA y lo que ejecutaba el CLI:

1. **Deadlock de nacimiento en `base-ai service new` e `init`:**
   - `service new` ejecutaba `git init -q` e inmediatamente activaba `.githooks/` (`core.hooksPath = .githooks`) sobre un repositorio **sin ningún commit inicial**.
   - Como `.githooks/pre-commit` prohíbe hacer commits en `main` o `development`, era imposible commitear el scaffold inicial sin desactivar temporalmente los hooks (`-c core.hooksPath=/dev/null`), o bien, si se creaba directamente una rama `feat/PROJ-101-...`, no existían las ramas base `main` ni `development` contra las cuales abrir un Pull Request.
2. **Ausencia de `.githooks/` en el repositorio raíz (`base-ai init`):**
   - `init` inicializaba Git en el repositorio raíz pero no instalaba `.githooks/`, permitiendo que un agente o desarrollador hiciera commits directos en `main` en el repositorio paraguas sin rama de trabajo ni Ticket ID.
3. **Ambigüedad en la rama destino de los Pull Requests (`development` vs. `main`):**
   - La habilidad `sdlc` indicaba *"open a Pull Request targeting `development`, `main` or `master`"*, lo que llevaba a los agentes a abrir PRs de funcionalidades (`feat/*`) directamente contra `main` en lugar de integrarlos primero en `development` (`staging`) y promover `development` → `main` (`production`).
4. **Omisión de auditoría explícita `review` + `security` publicada en cada PR:**
   - Sin una regla explícita en Gate 1 y Gate 5, el agente podía avanzar a escribir código antes de la aprobación del plan/ticket o hacer merge de un PR sin publicar el dictamen estructurado de `review` + `security` en el propio Pull Request.

## 2. Decisión

### 2.1 Bootstrap Git determinista (`bootstrapGitBaseline` en `cli/src/services.ts` e `init.ts`)
Tanto `base-ai init` (raíz) como `base-ai service new` (`src/<name>`) ejecutan ahora la secuencia:
1. Generar todos los archivos de la plantilla, escribir los scripts en `.githooks/` (`writeServiceHooks`) y ejecutar `aiSync()`.
2. Inicializar Git en la rama `main` y crear automáticamente el **commit base del scaffold limpio** (`chore: initial base-ai [service] scaffold`).
3. Crear y cambiar a la rama base de integración **`development`** (`git checkout -q -b development`). Si el remoto existe localmente (ej. repositorios bare en pruebas), publicar `main` y `development` antes de activar los hooks.
4. Activar `git config core.hooksPath .githooks` (`activateServiceHooks`).
5. En `.githooks/pre-push`, permitir únicamente el push de bootstrap inicial hacia una rama remota vacía (`remote_sha == 0000...` y `commit_count == 1`), bloqueando cualquier push posterior a `main`, `master` o `development`. Así, si el repositorio remoto en GitHub/GitLab se crea después de ejecutar `base-ai init` o `base-ai service new`, el primer `git push -u origin main development` funciona sin desactivar los hooks.

### 2.2 Endurecimiento de Reglas (`.ai/rules.md`) y Gates (`sdlc`, `review`, `PULL_REQUEST_TEMPLATE.md`)
1. **Gate 1 (Plan y Ticket obligatorios antes de escribir código):** Ningún archivo del repositorio raíz o de `src/<name>` se modifica hasta que el plan (`discovery` / `sdlc`) esté aprobado por el usuario y exista el ID del ticket/issue.
2. **Gate 2 (Rama de trabajo desde `development`):** Toda rama (`feat/*`, `fix/*`, `docs/*`, `chore/*`) se crea a partir de `development` (`git checkout -b feat/PROJ-123-slug development`).
3. **Gate 5 (PR hacia `development` + Informe `review` & `security` publicado):**
   - Los PRs de historias apuntan siempre a **`development`** (`staging`). Solo los PRs de promoción de release (`development` → `main`) apuntan a `main` (`production`).
   - Antes de hacer merge de cualquier PR, el agente debe inspeccionar el diff (`gh pr diff` / `git diff`), publicar el informe de 8 puntos de `review` + STRIDE de `security` en el PR y resolver cualquier hallazgo `Blocker` / `Major` / `Critical` / `High`.

## 3. Impacto y consecuencias

- **Positivas:**
  - Cero necesidad de usar `-c core.hooksPath=/dev/null` tras crear el proyecto o un servicio.
  - `main` y `development` existen desde el segundo cero tanto en la raíz como en cada servicio, con `HEAD` posicionado en `development` y el árbol de trabajo 100% limpio.
  - Trazabilidad completa y auditoría de código/seguridad auditable en cada Pull Request.
- **Negativas / Trade-offs:**
  - `init` y `service new` ejecutan dos comandos `git` adicionales (`commit` inicial y `checkout -b development`), añadiendo ~50 ms al tiempo de scaffolding.
