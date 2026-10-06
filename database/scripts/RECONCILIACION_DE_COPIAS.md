# Comparar dos copias locales durante el corte

`export_reconciliation_manifest.py` lee todas las tablas con llave primaria de `auth` y `public`, además de `public.product_inventory_overview`, y calcula SHA-256 por ID de la fila completa. También calcula SHA-256 de cada archivo bajo `--media-root`. No guarda valores de columnas ni contenidos de archivos, pero el manifiesto **sí contiene IDs y nombres de archivos**: guardarlo en una carpeta privada fuera de ambos repositorios y no adjuntarlo al acta pública.

Cada tabla se consulta por separado. **Detener todas las escrituras en ambas copias antes de exportar**, o los manifiestos pueden mezclar instantes diferentes. El comparador detecta tablas faltantes, IDs ausentes o sobrantes, cambios de cualquier columna y archivos ausentes o distintos. No decide qué copia prevalece ni modifica datos.

Ejemplo desde `algym-local-backend`, con el respaldo del origen ya restaurado en un proyecto Compose aislado llamado `algymorigen` y los archivos restaurados en una carpeta privada:

```sh
python3 database/scripts/export_reconciliation_manifest.py \
  --compose-project algymorigen \
  --media-root /ruta/privada/media-origen \
  --output /ruta/privada/origen.json

python3 database/scripts/export_reconciliation_manifest.py \
  --db-name algym --db-user algym_migrator \
  --media-root data/media \
  --output /ruta/privada/destino.json

python3 database/scripts/compare_reconciliation_manifests.py \
  /ruta/privada/origen.json /ruta/privada/destino.json \
  --report /ruta/privada/diferencias.json
```

El segundo comando usa solo PostgreSQL del host en loopback (`algym` o `algym_test`); el primero usa únicamente `postgres` del proyecto Compose indicado. Las rutas de salida deben ser absolutas, nuevas y estar fuera de los repositorios. Se crean con permisos `0600` y no se sobrescriben. El comparador sale con `0` si todo coincide, `2` si hay diferencias y `1` ante un error. El reporte privado incluye el conteo de origen y destino, los IDs faltantes, sobrantes o cambiados por entidad y las rutas de media divergentes. Los hashes no muestran **qué columna** cambió: examinar cada discrepancia en las dos copias y registrar la decisión antes de importar.

Complementar con los totales monetarios y controles internos de `reconcile_local.sql` en **ambas** copias. Para el PostgreSQL del host: `DB_USER=algym_migrator sh database/scripts/reconcile_local_database.sh`. Para la copia aislada: enviar ese SQL a `docker compose -p algymorigen -f ../al-gym-sys/docker-compose.yml --profile container-db exec -T postgres psql -X -v ON_ERROR_STOP=1 -U postgres -d algym -f -`. Los totales de pagos por estado, movimientos de caja, reversos e inventario se revisan junto con los manifiestos. No interpretar una diferencia por sí sola como error: antes del corte puede haber escrituras legítimas en ambos lados. La reconciliación definitiva necesita el respaldo actualizado del VPS y el acta de resolución de cada delta.
