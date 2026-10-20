# {{name}}

Servicio independiente creado con `base-ai service new {{name}}`.

> Este repositorio es autónomo: su arquitectura, infraestructura y CI/CD no dependen del repo raíz.

## Estructura

| Ruta | Uso |
|------|-----|
| `.ai/` | Reglas y skills propios (extienden los de la raíz; los locales tienen prioridad) |
| `docs/architecture/{adrs,rfcs}` | Decisiones del servicio |
| `docs/operations/{runbooks,postmortems}` | Operación |
| `infrastructure/{modules,staging,production}` | IaC del servicio |
| `tests/` | Tests |
| `.github/workflows/` | Pipelines del servicio |

## Primeros pasos

1. Elige el stack y documéntalo en `docs/architecture/adrs/ADR-0001-stack.md`.
2. Añade las reglas propias en `.ai/rules.md` y ejecuta `base-ai ai sync` desde la raíz.
3. Configura el pipeline en `.github/workflows/`.
