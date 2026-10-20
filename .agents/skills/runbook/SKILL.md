---
name: "runbook"
description: "Genera un runbook operativo para on-call de un servicio o componente. Úsalo cuando se despliegue algo nuevo, se cree una alerta o se pida documentar cómo operar o mitigar un incidente."
---
<!-- generado por base-ai: no editar. Fuente: .ai/ -->

# Runbook operativo

Crea `docs/operations/runbooks/<componente>.md` dentro del repo del servicio con:

- **Descripción:** qué hace el componente, quién es el responsable y sus dependencias upstream y downstream.
- **Accesos:** dashboards, logs, trazas y consolas (enlaces, nunca credenciales).
- **Alertas:** por cada alerta, qué significa, su severidad y su impacto en el usuario.
- **Diagnóstico:** pasos ordenados y comandos concretos para confirmar la causa.
- **Mitigación:** acciones seguras e idempotentes (rollback, escalar, desactivar un feature flag, drenar tráfico), con cómo verificar cada una.
- **Escalamiento:** a quién avisar y cuándo.
- **Postmortem:** enlace a la plantilla en `docs/operations/postmortems/`.

Los comandos deben poder copiarse y pegarse tal cual, y deben indicar si son de solo lectura o modifican el estado.
