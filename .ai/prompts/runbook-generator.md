# Generación de Runbook (Operaciones On-call)
Analiza el código provisto y genera un Runbook en formato Markdown para el directorio `docs/operations/runbooks/` que incluya:
- Nombre de la alerta y gravedad inicial (SEV1 a SEV4).
- Impacto esperado en la plataforma.
- Pasos de diagnóstico (queries, métricas a revisar).
- Acciones seguras de mitigación temporal.
- Acciones prohibidas (ej. "No reenviar el pago sin consultar").
- Escalamiento y plantilla de comunicación a clientes.
