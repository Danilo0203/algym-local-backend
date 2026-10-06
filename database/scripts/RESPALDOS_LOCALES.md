# Respaldo local de PostgreSQL y archivos

Ejecutar `database/scripts/backup_local_database.sh` desde una cuenta con acceso de lectura a la base `algym` y al directorio de archivos. El script acepta `DB_HOST` (solo loopback en uso manual), `DB_PORT`, `DB_NAME`, `DB_USER`, `PGPASSWORD`, `LOCAL_MEDIA_ROOT` y `BACKUP_ROOT`. Solo el servicio `backup` de Compose habilita además `DB_HOST=postgres` mediante `ALGYM_CONTAINER_BACKUP=1`; toma `POSTGRES_PASSWORD` de su archivo privado de entorno. No carga `.env` automáticamente en uso manual; no guardar contraseñas en este archivo ni en argumentos de línea de comandos.

```sh
DB_HOST=127.0.0.1 DB_NAME=algym DB_USER=algym_migrator \
LOCAL_MEDIA_ROOT=/ruta/persistente/media \
BACKUP_ROOT=/ruta/segura/backups \
sh database/scripts/backup_local_database.sh
```

Cada ejecución crea un directorio privado con `database.dump`, `media.tar`, `manifest.txt` y `SHA256SUMS`. El script solo publica ese directorio al terminar el volcado y verificar sus tres hashes. Si falla, borra su directorio temporal. `LOCAL_MEDIA_ROOT` debe existir; un directorio vacío es válido si todavía no se han importado imágenes y `media_files=0` en el manifiesto lo indica.

Para comprobar un respaldo, verificar `SHA256SUMS` y restaurar el dump en **otra base vacía** y el tar en **otro directorio vacío**. No restaurar sobre `algym` ni sobre el directorio de media en uso. El ensayo de desarrollo del 30 de septiembre de 2026 restauró un dump de `algym` en `algym_restore_probe_20260930`, verificó conteos de ejercicios, productos y perfiles y eliminó esa base de prueba. También recuperó y comparó un archivo de prueba desde `media.tar`. Ese ensayo no valida imágenes reales: la instalación todavía no contenía ninguna.

El servicio `backup` del perfil `container-db` ejecuta un respaldo al arrancar y después cada `BACKUP_INTERVAL_SECONDS` (24 horas por defecto). Guarda el último éxito en `.last-success-epoch`; el healthcheck falla si supera el intervalo más una hora. Si `pg_dump`, la lectura de media o la verificación de hashes fallan, el proceso sale y Docker lo reinicia. Esta automatización debe activarse **solo después** de restaurar y validar `algym` en el servicio `postgres`; no afecta al PostgreSQL del host. `ALGYM_BACKUP_DIR` puede apuntar a un disco separado, pero el valor por defecto dentro del repositorio hermano no satisface por sí solo una política de respaldo fuera del equipo.

Después de cada respaldo correcto, `prune_automatic_backups.sh` conserva las 30 copias automáticas más recientes por defecto (`ALGYM_BACKUP_KEEP_COUNT`, entre 7 y 365). Solo elimina directorios completos con nombre de respaldo, dump, hashes y la marca `backup_type=automatic` en el manifiesto. Las copias manuales carecen de esa marca y no se eliminan. La prueba usó únicamente directorios sintéticos en `/private/tmp`: conservó 7 automáticos y 1 manual, eliminó 4 automáticos antiguos. Otro ensayo creó un dump real de `algym_test` con un archivo de media sintético y comprobó los hashes y la marca. El servicio se ejecutó además en un proyecto Compose desechable: respaldó una base `algym` y un archivo sintéticos, quedó saludable y su dump se restauró en otra base vacía del mismo PostgreSQL de ensayo. El volumen, la red y los archivos de ese proyecto se eliminaron. Todavía no se ha activado en el contenedor definitivo.

Todavía faltan una ubicación externa definitiva, una alerta que avise cuando falle el healthcheck y una restauración periódica con archivos reales. Para un respaldo consistente con archivos y filas durante un corte, detener escrituras mientras se ejecuta el script. La prueba de restauración final debe usar otra instancia de PostgreSQL.

## Actualizar el esquema sin reemplazar los datos

Las migraciones posteriores a `0002` son archivos SQL ordenados en `database/migrations`. Algunas, como `0030_custom_panel_roles.sql`, contienen una sentencia que debe confirmarse antes de su bloque transaccional: no envolver indiscriminadamente todos los archivos en `psql --single-transaction` ni ejecutar el restaurador inicial `restore_local_database.sh` sobre una base existente. Antes de aplicar una migración nueva:

1. Anotar Git SHA, nombre y SHA-256 del archivo SQL, base de destino y última migración comprobada. Revisar el SQL completo y sus límites `BEGIN`/`COMMIT`; una migración que cambia o elimina datos necesita un plan de reversión específico.
2. Detener web, backend, sync y cualquier escritor del host. Crear con `backup_local_database.sh` un respaldo nuevo de `algym` **y** media. Verificar `SHA256SUMS`, `pg_restore --list` y que `manifest.txt` dice `database=algym`. Conservar ese paquete sin modificarlo.
3. Restaurar el paquete en un proyecto Compose **nuevo**, con volumen PostgreSQL y directorio de media vacíos, mediante `restore_snapshot_to_container.py --project-name <nombre> --media-target <directorio-nuevo>`. Confirmar conteos y permisos antes de aplicar el SQL. Ensayar allí el archivo exacto, con `psql -X -v ON_ERROR_STOP=1`, usando el rol propietario `algym_migrator` en la misma sesión. Ejecutar `verify_migration.sql`, las pruebas enfocadas y lecturas/escrituras de las rutas afectadas como `algym_app` y `algym_sync` cuando corresponda. Si falla, conservar el primer error y desechar solo la copia de ensayo.
4. Con los escritores todavía detenidos, confirmar un segundo respaldo final y aplicar **solo** las migraciones faltantes, una por una y en orden, a la base definitiva. En PostgreSQL de Compose, el patrón es:

   ```sh
   migration=../algym-local-backend/database/migrations/0032_ejemplo.sql
   { printf 'SET ROLE algym_migrator;\n'; cat "$migration"; } |
     docker compose -f docker-compose.yml -f docker-compose.container-db.yml \
       --profile container-db exec -T postgres \
       psql -X -v ON_ERROR_STOP=1 -U postgres -d algym
   ```

   Sustituir `0032_ejemplo.sql` por el **archivo real revisado**; el ejemplo no existe ni debe crearse solo para ejecutar este comando. En PostgreSQL del host, usar la conexión local del administrador con `psql -X -v ON_ERROR_STOP=1` y el mismo `SET ROLE` en esa sesión. No poner contraseñas en la línea de comandos ni en el acta.
5. Ejecutar `database/scripts/verify_migration.sql`, comparar conteos/IDs/sumas críticos antes y después, comprobar privilegios y probar las rutas afectadas con los roles de aplicación. Levantar los escritores solo tras esos controles. Registrar salida y nuevo respaldo.

Si la aplicación o la verificación fallan después de una migración, dejar detenidos los escritores. Una migración que ya confirmó DDL no se revierte repitiéndola. Restaurar el respaldo final en **otra instancia vacía**, inspeccionar la causa y cambiar a la instancia recuperada únicamente después de comprobar sus datos y rutas; no ejecutar `pg_restore --clean`, `dropdb` ni `restore_local_database.sh` sobre `algym` operativa.

La migración `0033_local_function_execute_acl.sql` retira el permiso de ejecución heredado de los roles `PUBLIC`, `anon`, `authenticated` y `service_role` en las funciones `SECURITY DEFINER` de `public`; concede explícitamente a `algym_app` las siete funciones que la API llama directamente desde Caja. Aplicarla después de `0032` al restaurar una copia anterior del VPS. `verify_migration.sql` falla si alguna tabla de `public` no tiene RLS o si una función privilegiada vuelve a ser ejecutable por esos roles. Toda migración futura que agregue funciones privilegiadas debe conceder solo los permisos necesarios y pasar esta verificación.

Después de `0033`, aplicar `0034_local_relation_acl.sql`: conserva para `algym_app` las operaciones de tablas, vistas, secuencias y funciones que la API ya podía ejecutar, retira las concesiones heredadas de `anon`, `authenticated`, `service_role` y `PUBLIC`, y cambia los privilegios predeterminados de `algym_migrator` para que no reaparezcan. `algym_sync` conserva acceso al esquema `public` y recibe solamente `auth.uid()` en `auth` para las políticas RLS del reloj. La prueba en `algym_test` ejecutó 152 casos del backend y 5 del sync, además de `verify_migration.sql`. El importador de un respaldo anterior debe aplicar `0033` y `0034` en ese orden antes de arrancar los servicios.

Después de `0034`, aplicar `0035_blueprint_manage_permission.sql`: separa `routines.view` de `routines.manage_blueprints` en API y RLS, y copia el permiso nuevo a los roles que ya tenían lectura. La web y el backend deben actualizarse junto con esta migración. Se ensayó el archivo exacto sobre una restauración aislada del respaldo operativo y `verify_migration.sql` pasó; el respaldo final antes de actualizar `algym` fue `/private/tmp/algym-backups/algym-20261006T073421Z`. Al importar una copia anterior del VPS, aplicar también `0035` después de `0034` antes de iniciar escritores.
