# Exportar desde el frontend local conectado a Hostinger

El cliente usa un frontend local con Supabase en Hostinger. El botón pertenece a
esa versión del frontend, en Administración → Exportar para Windows. Este
servicio convierte la copia en la VPS y el frontend transmite la descarga; no
necesita PostgreSQL ni una contraseña de base de datos en el equipo del cliente.
Desde AlGym Windows 0.3.2 también se puede usar mediante una conexión temporal
a la cuenta propietaria de Hostinger. No sustituye el backend local.

## Acceso y datos

GoTrue valida el token. Una consulta de lectura verifica después la sesión
vigente y el perfil activo `owner` para cada creación, consulta y descarga. Nunca
se usa `user_metadata` para autorizar. El `.algym` no incluye sesiones; el `.dump`
es un respaldo completo privado, que sí contiene datos internos de Supabase.

Cada exportación usa `pg_dump` con un snapshot consistente y transacciones de
solo lectura. La cuenta **algym_export_reader** tiene contraseña aleatoria propia,
`pg_read_all_data` y `BYPASSRLS` para respaldar todas las filas. No es administradora
ni tiene permisos directos para modificar tablas, crear bases o administrar roles.
La contraseña de `supabase_admin` nunca se guarda en el servicio. No reutilizar la
contraseña de `supabase_read_only_user`: en esta VPS comparte el secreto del administrador.

Las migraciones/conversión se ejecutan en un PostgreSQL temporal separado. No se
ejecuta SQL del dump. Las órdenes del reloj se cuentan leyendo el archivo sin
acumularlas en memoria: quedan archivadas en el `.dump` y la cola del `.algym`
queda vacía. La preparación se detiene si hay archivos en Storage o columnas
incompatibles. No cambia clientes, pagos, tablas, políticas ni registros de origen.

Solo un trabajo a la vez, cinco minutos entre copias por propietario, hasta doce
copias temporales y caducidad a las 24 horas. Los archivos se guardan privados y
no se sirven como estáticos. Las respuestas de error no incluyen datos SQL.

## Activación separada y explícita

La preparación del código no activa el servicio. `provision-reader.py` crea
**solamente una cuenta técnica y sus permisos/configuración**; es un cambio a los
roles de PostgreSQL y requiere autorización de despliegue. No ejecutarlo durante
una tarea limitada a lectura. No reemplaza una cuenta o configuración existente.
El script se ejecuta desde una sesión administrativa en la VPS y escribe la
contraseña generada en `/opt/algym-export/config/export.json`, con modo 0400.

`Dockerfile` se construye desde la raíz del backend. El contenedor trabaja como
postgres, sin capacidades adicionales, con filesystem de solo lectura, 1 CPU y
1 GiB de memoria. Usa la red existente de Supabase. No reinicia sus contenedores.
Los directorios config y jobs deben pertenecer al UID/GID postgres de la imagen
(consúltalos con `docker run --rm --entrypoint id algym-hostinger-export:1.0.0`).
El directorio config debe ser 0700; la clave TLS y export.json, 0400; jobs, 0700.

**Por defecto Compose publica solo en 127.0.0.1:54433.** Así no abre acceso público.
Para una prueba se puede usar un túnel SSH autorizado. Para que el botón funcione
sin túnel en el equipo del cliente se necesita autorización adicional para
publicar HTTPS en un puerto accesible y configurar las restricciones de red.
Solo tras esa autorización, establecer `ALGYM_EXPORT_BIND` con la interfaz
aprobada al ejecutar Compose. No abrir interfaces como efecto implícito del build.

Crear un certificado TLS con SAN de la dirección usada y 127.0.0.1 para el
healthcheck; guardar server.crt/server.key en config. Variables **de servidor** en
el frontend Supabase:

```dotenv
ALGYM_EXPORT_URL=https://DIRECCION_AUTORIZADA:54433/
ALGYM_EXPORT_CA_BASE64=CERTIFICADO_PUBLICO_CODIFICADO_EN_BASE64
```

Node comprueba la CA configurada, el nombre y la caducidad. No se desactiva TLS
ni se instala una CA global en el navegador. Renovar el certificado y actualizar
esa variable antes de su vencimiento. El frontend conserva su URL y clave pública
de Supabase actuales. Nunca copiar export.json ni server.key al frontend.

Para retirar el exportador, detener su contenedor y retirar las variables del
frontend. Conservar primero las copias necesarias. La eliminación de la cuenta
técnica es una operación administrativa separada; no afecta datos del negocio.

## Validación y entrega

`node --test hostinger/service.test.mjs` cubre permisos, separación entre
propietarios, confirmación, concurrencia, reintentos, descarga y caducidad.
`prepareDump` en pipeline.mjs permite convertir un dump ya descargado en un
PostgreSQL desechable. Nunca ejecutar el bootstrap general contra la base operativa.

En el frontend ejecutar lint, TypeScript y build. Después, con una cuenta propietaria,
probar la generación y las dos descargas. Comprobar el `.algym` con el inspector
del instalador 0.3.0 y una restauración desechable. No sobrescribir la VM ya migrada.
La actualización del frontend en la computadora real del cliente es una entrega
separada: el build en esta rama no actualiza automáticamente esa computadora.

## Activación comprobada: 19 de octubre de 2026

Tras autorización explícita se creó `algym_export_reader` con un secreto exclusivo.
La comprobación en la cuenta real confirmó transacciones de lectura, cero tablas
modificables en public/auth/storage y ausencia de privilegios de administrador,
creación de bases o administración de roles. No se ejecutaron migraciones en el
origen ni escrituras en registros del negocio.

Se activó el contenedor separado en la IP de la VPS, puerto HTTPS 54433. La interfaz
publicada se fija en `/opt/algym-export/deploy.env`, fuera del repositorio. Para
operarlo conservar `--env-file /opt/algym-export/deploy.env` al usar Compose.
Reinicia automáticamente con Docker; límite de 1 GiB y 1 CPU; healthcheck saludable.
El certificado actual vence el 19 de octubre de 2027. Renovarlo y distribuir la
nueva CA pública al frontend antes de esa fecha.

Prueba completa con sesión propietaria: creación desde el botón, preparación,
descargas `.algym` y `.dump`, huellas iguales al servidor, restauración desechable
con el importador 0.3.0 y segunda importación sin duplicados. Supabase continuó
saludable. Los contenedores operativos no se reiniciaron para activar el exportador.


## Conexión desde AlGym Windows 0.3.2

La ampliación agrega `POST /session` al listener HTTPS existente. Recibe un
correo y contraseña, con JSON limitado a 4 KiB y cinco intentos por minuto por
IP y por cuenta. GoTrue valida las credenciales por la red privada de Docker;
el exportador vuelve a comprobar la cuenta propietaria activa y su sesión
contra la base con la cuenta técnica de lectura. La respuesta contiene solo
un access token y su caducidad, nunca refresh tokens, contraseñas ni perfiles.
`GET /health` anuncia `nativeLogin: true` cuando está habilitado. Las rutas
`/jobs` anteriores conservan su autorización, límites e integridad.

No requiere cambios de esquema, permisos, credenciales, puertos ni contenedores
de Supabase. Se debe actualizar únicamente la imagen del exportador, conservando
config y jobs. La publicación requiere autorización del operador; el código
preparado localmente no implica que la ampliación ya esté activada en la VPS.

Pruebas: `node --test hostinger/service.test.mjs hostinger/login.test.mjs`.

### Activación de la conexión nativa: 19 de octubre de 2026

Con autorización explícita se actualizó únicamente el exportador a
`algym-hostinger-export:1.1.0`, derivado de la imagen 1.0.0 existente sin renovar
sus dependencias. Se reemplazaron server.mjs, service.mjs y se agregó login.mjs;
las cinco pruebas pasaron dentro de esa imagen sin acceso a la red operativa.
El HTTPS confirma `nativeLogin: true`; `/jobs` sin sesión devuelve 401.
La configuración y las tres copias existentes conservaron sus hashes y los once
contenedores de Supabase conservaron sus IDs y fechas de arranque.

La primera comprobación utilizó una dirección loopback que no estaba publicada
en el host y activó la reversión automática. La activación definitiva comprobó
la IP HTTPS publicada. La imagen previa queda como
`algym-hostinger-export:rollback-032`, y la configuración Compose anterior en
`/opt/algym-export/releases/native-login-032/compose.before.yml`.
