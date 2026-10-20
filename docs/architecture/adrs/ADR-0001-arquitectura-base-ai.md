# ADR-0001: Arquitectura de base-ai: raíz plantilla, servicios aislados, manifiesto y fuente única de IA

- **Fecha:** 2026-10-20
- **Estado:** Aceptado
- **Autores:** Equipo base-ai

---

## 1. Contexto y problema

Queremos una plantilla para inicializar cualquier proyecto de software escalable que se desarrolle con agentes de IA. Hay cuatro fuerzas en juego:

1. **Independencia de servicios.** Cada servicio o módulo debe poder tener su propio stack, arquitectura, infraestructura, repositorio y pipeline. Un monorepo acopla versiones, CI y permisos.
2. **Visión de conjunto.** Hace falta un lugar único para las convenciones, las decisiones transversales y saber qué servicios forman el sistema.
3. **Muchos agentes de IA.** Antigravity/Gemini, Claude Code, Cursor, Copilot, Codex y Windsurf leen formatos distintos. Mantener esas reglas a mano por duplicado produce desalineación.
4. **Arranque reproducible.** Crear un proyecto o un servicio nuevo debe ser un solo comando con un resultado determinista.

## 2. Decisión

### 2.1 Modelo polyrepo con repo raíz "paraguas"

- El **repo raíz** (`base-ai`) contiene solo la capa de IA, `docs/` transversales, `services.yaml` y `templates/`. **No contiene código de aplicación.**
- Cada **servicio** vive en `src/<nombre>/` como un repositorio git independiente. `src/*` está en `.gitignore`.
- **Regla de aislamiento:** un servicio no puede importar, referenciar ni necesitar archivos de la raíz para compilar, testear o desplegarse. Todo lo que necesita se copia dentro de él al crearlo (scaffold) o al exportar (`ai sync`).

### 2.2 Manifiesto `services.yaml`

Es la fuente de verdad sobre qué servicios forman el proyecto:

```yaml
version: 1
services:
  - name: api              # carpeta en src/
    repo: git@github.com:org/api.git
    branch: main
    template: service      # plantilla de templates/ usada al crearlo (opcional)
    ai: inherit            # inherit | none: si recibe la capa IA de la raíz
```

- `name` es único y debe cumplir `^[a-z0-9-]+$`.
- El CLI es **idempotente**: `sync` clona lo que falta y hace `fetch`/`pull --ff-only` de lo que ya existe. Nunca sobrescribe cambios locales.

### 2.3 Fuente única de IA (`.ai/`) y exportadores

```
.ai/
├── rules.md               # reglas globales (→ AGENTS.md, CLAUDE.md, …)
├── skills/<id>/skill.md   # frontmatter: id, description, targets
└── config.yaml            # agentes habilitados, idioma
```

- Los archivos de cada agente (`AGENTS.md`, `CLAUDE.md`, `.cursor/rules/*.mdc`, `.github/copilot-instructions.md`, `.windsurfrules`, `.agents/skills/`) son **artefactos generados**. Llevan una cabecera `<!-- generado por base-ai: no editar -->`.
- Cada agente tiene un **exportador** que es una función pura `(fuente) → archivos`, lo que permite añadir agentes nuevos sin tocar el núcleo.
- Para servicios con `ai: inherit`, `ai sync` copia la salida a `src/<nombre>/`. Cada servicio puede tener un `.ai/` local que **extiende** las reglas de la raíz: se concatenan y las reglas locales tienen prioridad.

### 2.4 CLI

- **Lenguaje:** Node.js + TypeScript, distribuido en npm como `create-base-ai` (scaffold inicial) y `base-ai` (operación). Funciona con `npx` sin instalar nada.
- **Comandos:** `init`, `service new|add|remove`, `sync`, `ai sync`, `doctor` (detecta derivas entre la fuente y lo generado).
- **Plantillas:** se procesan como archivos con variables simples (`{{name}}`). Sin lógica embebida.

## 3. Impacto en resiliencia y seguridad

- **Aislamiento de fallos:** un pipeline roto en un servicio no bloquea a los demás.
- **Credenciales:** el CLI usa el git y el SSH del usuario. Nunca guarda tokens. `services.yaml` no admite secretos.
- **Supply chain:** el CLI tiene dependencias mínimas y la salida de los exportadores es determinista, así que es fácil auditar los diffs.
- **Operaciones idempotentes:** repetir `sync` o `ai sync` produce el mismo resultado sin efectos colaterales.

## 4. Consecuencias

**Positivas**
- Independencia real de stack, despliegue y permisos por servicio.
- Reglas de IA consistentes entre agentes y servicios.
- Se pueden añadir agentes o plantillas nuevas como extensiones.

**Negativas y riesgos**
- Los cambios que cruzan servicios requieren varios PRs y coordinación (mitigación: los RFC en `docs/`).
- Puede haber derivas si alguien edita los archivos generados (mitigación: `base-ai doctor` en CI).
- El soporte de cada agente depende de formatos externos que cambian (mitigación: exportadores versionados).

## 5. Alternativas consideradas

| Alternativa | Motivo de descarte |
|-------------|--------------------|
| Monorepo (Nx, Turborepo, Bazel) | Acopla tooling, CI y versiones; contradice el aislamiento total |
| Git submodules | Experiencia de uso frágil (detached HEAD, punteros de commit en la raíz) y acopla versiones |
| Reglas escritas a mano por agente | Duplicación y desalineación |
| Cookiecutter/Copier (Python) | Requiere Python; no cubre el manifiesto ni la sincronización de IA |
