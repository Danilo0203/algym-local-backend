# Respaldo local de PostgreSQL y archivos

Ejecutar `database/scripts/backup_local_database.sh` desde una cuenta con acceso de lectura a la base `algym` y al directorio de archivos. El script acepta `DB_HOST` (solo loopback), `DB_PORT`, `DB_NAME`, `DB_USER`, `PGPASSWORD`, `LOCAL_MEDIA_ROOT` y `BACKUP_ROOT`. No carga `.env` automáticamente; no guardar contraseñas en este archivo ni en argumentos de línea de comandos.

```sh
DB_HOST=127.0.0.1 DB_NAME=algym DB_USER=algym_migrator \
LOCAL_MEDIA_ROOT=/ruta/persistente/media \
BACKUP_ROOT=/ruta/segura/backups \
bash database/scripts/backup_local_database.sh
```

Cada ejecución crea un directorio privado con `database.dump`, `media.tar`, `manifest.txt` y `SHA256SUMS`. El script solo publica ese directorio al terminar el volcado y verificar sus tres hashes. Si falla, borra su directorio temporal. `LOCAL_MEDIA_ROOT` debe existir; un directorio vacío es válido si todavía no se han importado imágenes y `media_files=0` en el manifiesto lo indica.

Para comprobar un respaldo, verificar `SHA256SUMS` y restaurar el dump en **otra base vacía** y el tar en **otro directorio vacío**. No restaurar sobre `algym` ni sobre el directorio de media en uso. El ensayo de desarrollo del 30 de septiembre de 2026 restauró un dump de `algym` en `algym_restore_probe_20260930`, verificó conteos de ejercicios, productos y perfiles y eliminó esa base de prueba. También recuperó y comparó un archivo de prueba desde `media.tar`. Ese ensayo no valida imágenes reales: la instalación todavía no contenía ninguna.

Antes de programar respaldos automáticos, fijar el directorio de media definitivo, una ubicación externa al disco de la aplicación, retención y monitoreo de fallos. Para un respaldo consistente con archivos y filas durante un corte, detener escrituras mientras se ejecuta el script. La prueba de restauración final debe usar otra instancia de PostgreSQL y archivos reales; este ensayo en la misma instancia es solo una comprobación inicial.
