# ADR-0001: Arquitectura del Ledger de Partida Doble Inmutable y Control de Concurrencia

- **Fecha:** 2026-10-20
- **Estado:** Aceptado
- **Autores:** Equipo de Arquitectura JavaCash

---

## 1. Contexto y Problema
JavaCash procesa operaciones financieras multi-tenant de alta concurrencia (pagos, transferencias internas, dispersiones y conciliaciones). Los sistemas basados en actualizaciones directas de columnas de saldo (`UPDATE accounts SET balance = balance - X`) sufren de:
1. **Pérdida de trazabilidad histórica:** Imposibilidad de reconstruir el saldo exacto en un instante `T` para auditorías financieras y regulatorias.
2. **Errores de precisión numérica:** El uso de tipos de punto flotante (`float` / `double`) introduce errores de redondeo IEEE 754 acumulativos.
3. **Condiciones de carrera (Double Spending):** Lecturas concurrentes del saldo disponible fuera de un bloqueo transaccional permiten sobregiros no autorizados.

## 2. Decisión
Adoptamos un **Ledger Contable de Partida Doble estrictamente inmutable (Append-Only)** bajo las siguientes reglas técnicas y de esquema de datos:

1. **Representación Monetaria Exacta:**
   - Todo monto se almacena y procesa en código como entero de 64 bits (`BIGINT` / `long` en la unidad menor de la divisa, ej. centavos) o `DECIMAL(19, 4)` exacto. Queda prohibido el uso de `float` o `double`.
2. **Partida Doble Estricta:**
   - Toda transacción financiera (`journal_entries`) está compuesta por al menos dos líneas de asiento (`ledger_postings`) donde:
     $$\sum \text{Débitos} = \sum \text{Créditos}$$
   - Esta invariante se valida tanto en la capa de dominio como mediante restricciones en la base de datos.
3. **Inmutabilidad y Reversiones (`reverses_id`):**
   - Las tablas `journal_entries` y `ledger_postings` son **append-only**. Se revocan permisos de `UPDATE` y `DELETE` para el rol de la aplicación sobre asientos confirmados.
   - Cualquier anulación, reembolso o ajuste contable debe insertar un nuevo asiento compensatorio referenciando al asiento original mediante la clave foránea `reverses_id`.
4. **Concurrencia Atómica y Aislamiento:**
   - La validación de saldo disponible y la inserción de los asientos de descuento se ejecutan dentro de una **única transacción atómica de base de datos**, adquiriendo bloqueo pesimista (`SELECT ... FOR UPDATE`) sobre las cuentas afectadas ordenadas por `account_id` (para prevenir *deadlocks*) y filtrando siempre por `tenant_id`.

## 3. Impacto en Ledger, Resiliencia y Seguridad
- **Integridad Contable:** Garantía matemática de cero descuadres contables entre cuentas operativas, cuentas puente (`clearing`) y cuentas de clientes.
- **Idempotencia:** Cada `journal_entry` exige un `idempotency_key` único por `tenant_id` (`UNIQUE (tenant_id, idempotency_key)`), impidiendo duplicidad de cargos ante reintentos de red.
- **Multi-tenancy y Seguridad (BOLA):** Todas las tablas del Ledger incluyen `tenant_id NOT NULL` en sus claves e índices compuestos, garantizando aislamiento estricto entre clientes.

## 4. Consecuencias
### Positivas
- Auditoría completa e inalterable lista para cumplimiento regulatorio y conciliación automática.
- Eliminación total de condiciones de carrera por doble gasto (*double spending*) y errores de punto flotante.
- Reversión trazable de principio a fin mediante `reverses_id`.

### Negativas / Trade-offs
- **Crecimiento de almacenamiento:** Al ser *append-only*, el volumen de `ledger_postings` crece linealmente con las transacciones; requiere particionamiento por rango de fechas y snapshots periódicos de saldos.
- **Contención en cuentas calientes (*hot accounts*):** El bloqueo `SELECT ... FOR UPDATE` en cuentas concentradoras de un mismo tenant puede serializar peticiones bajo picos extremos (mitigado mediante subcuentas fragmentadas o *sharded ledger accounts*).

## 5. Alternativas Consideradas
1. **Actualización directa del campo `balance` con tabla de auditoría secundaria:**
   - *Descartada:* Riesgo de desincronización entre el saldo actual y el historial de auditoría ante fallos parciales o manipulaciones manuales.
2. **Bloqueo optimista puro (Versionamiento de fila sin `FOR UPDATE`):**
   - *Descartada como mecanismo único:* Bajo alta contención genera tormentas de reintentos y fallos innecesarios en transacciones legítimas.
3. **Almacenamiento en punto flotante con redondeo en aplicación:**
   - *Descartada:* Inaceptable en sistemas financieros por discrepancias de centavos en conciliaciones masivas.
